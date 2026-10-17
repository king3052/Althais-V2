"""
remittance.py: payment files (X12 835, also called an ERA) in, denial analytics and appeal drafts out.

A clinic downloads its 835 from the payer or clearinghouse (or its EMR keeps them) and uploads it here. Althais:
  1. reads every claim payment in the file (paid amount, patient share, adjustment reason codes),
  2. matches each one to a claim already in Althais by claim number (falling back to patient + date + charge),
  3. marks the claim Paid or Denied (the new EMR picks that up on its next sync, see static/v4/sync.js),
  4. keeps the payment in org_remits so denials can be broken down by reason and payer,
  5. drafts an appeal letter for denials that are worth appealing, with blanks the clinic must fill in.

What this does not do: it doesn't post to the EMR's ledger, and it doesn't decide whether to appeal. The letter has a blank
for the clinical argument on purpose; nothing about the patient's care is invented. Reason-code descriptions are short
plain-English summaries of the standard X12 claim adjustment reason codes (CARC), not the official wording; the official
list is maintained by X12 / the Washington Publishing Company.
"""

import datetime as dt
import json
import re
from collections import defaultdict
from datetime import timezone

from fastapi import APIRouter, Depends, File, Request, UploadFile
from fastapi.responses import JSONResponse, RedirectResponse
from sqlalchemy import Float, Integer, String, Text, UniqueConstraint, DateTime, select as sa_select
from sqlalchemy.orm import Mapped, Session, mapped_column

from auth import Base, OrgClaim, _org_namespace, current_user, engine, get_db, require_biller, require_user
from emr_connect import MAX_BYTES, _gate

router = APIRouter()
MAX_CLAIMS = 20000
APPEAL_DAYS = 60     # a conservative default. Real appeal deadlines are set by each payer and contract: check the payer's own notice.


class OrgRemit(Base):
    """One claim payment line from an 835, kept so denials can be analyzed. Counts and codes, no clinical detail."""
    __tablename__ = "org_remits"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    org_key: Mapped[str] = mapped_column(String(255), index=True)
    claim_id: Mapped[str] = mapped_column(String(64), default="", index=True)
    payer_claim_no: Mapped[str] = mapped_column(String(64), default="")
    check_no: Mapped[str] = mapped_column(String(64), default="")
    payer: Mapped[str] = mapped_column(String(255), default="")
    patient_name: Mapped[str] = mapped_column(String(255), default="")
    dos: Mapped[str] = mapped_column(String(20), default="")
    paid_on: Mapped[str] = mapped_column(String(20), default="")
    charge: Mapped[float] = mapped_column(Float, default=0)
    paid: Mapped[float] = mapped_column(Float, default=0)
    patient_resp: Mapped[float] = mapped_column(Float, default=0)
    stage: Mapped[str] = mapped_column(String(16), default="")           # paid | denied | other
    carc: Mapped[str] = mapped_column(String(16), default="")            # e.g. CO-50
    adjustments: Mapped[str] = mapped_column(Text, default="[]")         # JSON [{group, code, amount}]
    matched: Mapped[int] = mapped_column(Integer, default=0)
    imported_at: Mapped[dt.datetime] = mapped_column(DateTime, default=lambda: dt.datetime.now(timezone.utc))
    __table_args__ = (UniqueConstraint("org_key", "claim_id", "check_no", "payer_claim_no", name="uq_org_remit"),)


Base.metadata.create_all(engine)

# ──────────────────────────────────────────────────────────────────────────
#  Reason codes: short plain-English meaning, what kind of problem it is, and what to do about it
#  kind: appeal | correct | other_payer | eligibility | duplicate | timely | review | patient | contractual
# ──────────────────────────────────────────────────────────────────────────
CARC = {
    "1": ("Deductible", "patient"), "2": ("Coinsurance", "patient"), "3": ("Copay", "patient"),
    "4": ("Procedure doesn't match the modifier, or a required modifier is missing", "correct"),
    "5": ("Procedure doesn't match the place of service", "correct"),
    "11": ("Diagnosis doesn't match the procedure", "correct"),
    "16": ("Claim is missing information or has a billing error", "correct"),
    "18": ("Duplicate claim", "duplicate"),
    "22": ("Another payer may be responsible (coordination of benefits)", "other_payer"),
    "27": ("Service was after coverage ended", "eligibility"),
    "29": ("Filing deadline passed", "timely"),
    "31": ("Patient couldn't be identified as the payer's member", "eligibility"),
    "45": ("Charge is over the contracted or allowed amount (normal write-off)", "contractual"),
    "50": ("Payer says the service wasn't medically necessary", "appeal"),
    "55": ("Payer considers the service experimental or investigational", "appeal"),
    "96": ("Service not covered", "review"),
    "97": ("Payment is bundled into another service already paid", "review"),
    "109": ("Wrong payer for this claim", "other_payer"),
    "119": ("Benefit limit reached for the period", "patient"),
    "151": ("Payer says the documentation doesn't support this many services", "appeal"),
    "167": ("Diagnosis isn't covered", "appeal"),
    "170": ("Not payable when billed by this type of provider", "appeal"),
    "181": ("Procedure code was invalid on the date of service", "correct"),
    "197": ("Prior authorization or notification missing", "appeal"),
    "204": ("Service isn't covered under the patient's plan", "review"),
    "252": ("Payer needs an attachment or more documentation", "appeal"),
}

NEXT_STEP = {
    "appeal": "Worth appealing if the chart supports it. Use the draft letter and attach the records.",
    "correct": "Fix the claim and send a corrected claim. This is usually not an appeal.",
    "other_payer": "Send the claim to the correct or other payer. Check the patient's coverage first.",
    "eligibility": "Check eligibility and the member ID on the date of service before doing anything else.",
    "duplicate": "Find out whether the original claim was paid before sending anything.",
    "timely": "Appeal only if you can prove it was filed on time (for example the clearinghouse acceptance report).",
    "review": "Look at the claim: check modifiers, bundling and coverage. Appeal only if the services were separate and covered.",
    "patient": "Patient responsibility, not a denial. Bill the patient per your policy.",
    "contractual": "Normal contractual write-off.",
}

ENCLOSE = {
    "50": "the visit note and records that support medical necessity",
    "55": "the visit note and any literature or records supporting the service",
    "151": "documentation of why each service was needed",
    "167": "the visit note supporting the diagnosis",
    "170": "the visit note and provider credentials",
    "197": "the authorization or notification number, or proof it wasn't required",
    "252": "the documentation the payer asked for",
}


def carc_info(code: str):
    desc, kind = CARC.get(str(code).lstrip("0") or "0", ("See the payer's reason code list", "review"))
    return desc, kind


# ──────────────────────────────────────────────────────────────────────────
#  Reading an 835
# ──────────────────────────────────────────────────────────────────────────
def _num(v) -> float:
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        return 0.0


def _d8(v: str) -> str:
    v = (v or "").strip()
    return f"{v[0:4]}-{v[4:6]}-{v[6:8]}" if re.fullmatch(r"\d{8}", v) else ""


def _segments(text: str):
    text = text.lstrip("﻿").strip()
    if not text.startswith("ISA") or len(text) < 106:
        raise ValueError("That doesn't look like an 835 payment file (it should start with an ISA segment).")
    elem, term = text[3], text[105]
    segs = [s.strip("\r\n ") for s in text.split(term)]
    return elem, [s for s in segs if s]


def parse_835(text: str):
    """Return {payer, check_no, paid_on, total, payments:[...]} from an X12 835."""
    elem, segs = _segments(text)
    out = {"payer": "", "check_no": "", "paid_on": "", "total": 0.0, "payments": []}
    cur = None
    line = None
    for raw in segs:
        f = raw.split(elem)
        tag = f[0]
        g = lambda i: f[i] if len(f) > i else ""
        if tag == "BPR":
            out["total"] = _num(g(2))
            out["paid_on"] = _d8(g(16)) or out["paid_on"]
        elif tag == "TRN":
            out["check_no"] = g(2)
        elif tag == "N1" and g(1) == "PR":
            out["payer"] = g(2)
        elif tag == "CLP":
            cur = {"claim_id": g(1), "status_code": g(2), "charge": _num(g(3)), "paid": _num(g(4)), "patient_resp": _num(g(5)),
                   "payer_claim_no": g(7), "patient_name": "", "dos": "", "adjustments": [], "lines": [], "remarks": []}
            out["payments"].append(cur)
            line = None
            if len(out["payments"]) > MAX_CLAIMS:
                raise ValueError("That file has too many claims. Split it up.")
        elif cur is None:
            continue
        elif tag == "NM1" and g(1) == "QC":
            cur["patient_name"] = " ".join(x for x in (g(4), g(3)) if x).strip()
        elif tag == "DTM" and g(1) in ("232", "472") and not cur["dos"]:
            cur["dos"] = _d8(g(2))
        elif tag == "SVC":
            line = {"cpt": g(1).split(":")[1] if ":" in g(1) else g(1), "charge": _num(g(2)), "paid": _num(g(3)), "adjustments": []}
            cur["lines"].append(line)
        elif tag == "CAS":
            group = g(1)
            i = 2
            while i < len(f) and f[i]:
                adj = {"group": group, "code": f[i], "amount": _num(g(i + 1))}
                (line["adjustments"] if line is not None else cur["adjustments"]).append(adj)
                i += 3
        elif tag == "LQ" and g(1) == "HE":
            cur["remarks"].append(g(2))
    return out


def classify(p: dict) -> dict:
    """Decide what this payment means: paid, denied or other, the main reason code, and what to do next."""
    adjs = list(p["adjustments"]) + [a for l in p["lines"] for a in l["adjustments"]]
    nonpt = [a for a in adjs if a["group"] != "PR" and a["amount"] > 0]
    by_code = defaultdict(float)
    for a in nonpt:
        by_code[(a["group"], a["code"])] += a["amount"]
    real = {k: v for k, v in by_code.items() if k[1] != "45"}      # CO-45 is the normal contract write-off
    status = p["status_code"]
    stage = "other"
    if status == "22":
        stage = "other"                                                    # a reversal of an earlier payment
    elif status in ("4", "21") or (p["paid"] <= 0 and p["charge"] > 0 and (real or by_code)):
        stage = "denied"
    elif p["paid"] > 0:
        stage = "paid"
    pool = real or by_code
    main = max(pool, key=pool.get) if pool else None
    carc = f"{main[0]}-{main[1]}" if main else ""
    desc, kind = carc_info(main[1]) if main else ("", "review")
    short_paid = [f"{g}-{c}" for (g, c), amt in real.items()] if stage == "paid" else []
    if stage == "paid" and not short_paid:
        carc, desc, kind = "", "", "contractual"          # paid in full less the normal write-off: nothing to chase
    return {"stage": stage, "carc": carc, "reason": desc, "kind": kind, "next": NEXT_STEP.get(kind, ""),
            "denied_amount": round(sum(real.values()) if stage == "denied" else 0, 2),
            "short_paid": short_paid, "reversal": status == "22"}


# ──────────────────────────────────────────────────────────────────────────
#  Matching, applying, analytics, appeal letters
# ──────────────────────────────────────────────────────────────────────────
def _last(name: str) -> str:
    return re.sub(r"[^a-z]", "", (name or "").lower().replace(",", " ").split()[-1] if (name or "").split() else "")


def match_claim(rows, p: dict):
    """The saved claim this payment belongs to: claim number first, then last name + service date + charge."""
    for r in rows:
        if p["claim_id"] and r.claim_id == p["claim_id"]:
            return r
    for r in rows:
        if r.dos and r.dos == p["dos"] and abs(float(r.amount or 0) - p["charge"]) < 0.01 and _last(r.patient_name) == _last(p["patient_name"]) and _last(r.patient_name):
            return r
    return None


def appeal_letter(row, p: dict, info: dict, payer: str, clinic: str) -> str:
    code = info["carc"].split("-")[-1] if info["carc"] else ""
    enclose = ENCLOSE.get(code, "the visit note and any supporting records")
    return (f"To {payer or '[payer]'} Appeals,\n\n"
            f"Re: Request for reconsideration\n"
            f"Claim number: {p['claim_id'] or (row.claim_id if row else '')}    Payer claim number: {p['payer_claim_no'] or '[from the payer]'}\n"
            f"Patient: {p['patient_name'] or (row.patient_name if row else '')}    Date of service: {p['dos'] or (row.dos if row else '') or '[date]'}\n"
            f"Billed: ${p['charge']:,.2f}    Paid: ${p['paid']:,.2f}\n"
            f"Denial reason: {info['carc']} ({info['reason']})\n\n"
            f"We are asking you to reconsider this denial.\n\n"
            f"[Write why this service should be paid, using the facts in the patient's chart. This part has to come from the clinician or biller; "
            f"do not send the letter with this line still in it.]\n\n"
            f"Enclosed: {enclose}.\n\n"
            f"Sincerely,\n{(row.provider if row and row.provider else '[provider name]')}\n{clinic or '[clinic]'}\n")


def _apply(db, org: str, clinic: str, parsed: dict, commit: bool):
    rows = db.scalars(sa_select(OrgClaim).where(OrgClaim.org_key == org)).all()
    seen = {(r.claim_id, r.check_no, r.payer_claim_no) for r in db.scalars(sa_select(OrgRemit).where(OrgRemit.org_key == org)).all()}
    out, now = [], dt.datetime.now(timezone.utc).isoformat()
    for p in parsed["payments"]:
        info = classify(p)
        row = match_claim(rows, p)
        dup = (p["claim_id"], parsed["check_no"], p["payer_claim_no"]) in seen
        item = {"claim_id": p["claim_id"], "patient": p["patient_name"], "dos": p["dos"], "charge": p["charge"], "paid": p["paid"],
                "patient_resp": p["patient_resp"], "payer_claim_no": p["payer_claim_no"], "matched": bool(row), "duplicate": dup,
                **{k: info[k] for k in ("stage", "carc", "reason", "kind", "next", "denied_amount", "short_paid", "reversal")},
                "adjustments": p["adjustments"] + [a for l in p["lines"] for a in l["adjustments"]]}
        out.append(item)
        if not commit or dup:
            continue
        letter = ""
        if row and info["stage"] == "denied" and info["kind"] == "appeal":
            letter = appeal_letter(row, p, info, parsed["payer"], clinic)
        if row and info["stage"] in ("paid", "denied") and not (info["stage"] == "denied" and row.status == "Paid"):
            row.status = "Paid" if info["stage"] == "paid" else "Denied"
            row.remit = json.dumps({"at": now, "stage": info["stage"], "paid": p["paid"], "paidOn": parsed["paid_on"], "carc": info["carc"],
                                    "reason": info["reason"], "kind": info["kind"], "appealDays": APPEAL_DAYS, "check": parsed["check_no"],
                                    "payer": parsed["payer"], "charge": p["charge"], "patientResp": p["patient_resp"]})
            if letter and not row.appeal_letter:
                row.appeal_letter = letter
        db.add(OrgRemit(org_key=org, claim_id=p["claim_id"], payer_claim_no=p["payer_claim_no"], check_no=parsed["check_no"], payer=parsed["payer"],
                        patient_name=p["patient_name"], dos=p["dos"], paid_on=parsed["paid_on"], charge=p["charge"], paid=p["paid"],
                        patient_resp=p["patient_resp"], stage=info["stage"], carc=info["carc"], adjustments=json.dumps(item["adjustments"]),
                        matched=1 if row else 0))
        item["letter"] = bool(letter)
    return out


def summarize(items):
    new = [i for i in items if not i["duplicate"]]
    return {"payments": len(items), "duplicates": len(items) - len(new), "matched": sum(1 for i in new if i["matched"]),
            "unmatched": sum(1 for i in new if not i["matched"]), "paid": sum(1 for i in new if i["stage"] == "paid"),
            "denied": sum(1 for i in new if i["stage"] == "denied"), "paid_total": round(sum(i["paid"] for i in new), 2),
            "denied_total": round(sum(i["denied_amount"] or i["charge"] for i in new if i["stage"] == "denied"), 2),
            "short_paid": sum(1 for i in new if i["short_paid"])}


async def _read(file: UploadFile):
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("That file is over 5 MB.")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = data.decode("latin-1")
    parsed = parse_835(text)
    if not parsed["payments"]:
        raise ValueError("No claim payments found in that file.")
    return parsed


@router.post("/api/remit/preview")
async def api_preview(file: UploadFile = File(...), user=Depends(require_biller), db: Session = Depends(get_db)):
    _gate(user, db)
    try:
        parsed = await _read(file)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    items = _apply(db, _org_namespace(user), user.organization or "", parsed, commit=False)
    return {"payer": parsed["payer"], "check_no": parsed["check_no"], "paid_on": parsed["paid_on"], "total": parsed["total"],
            "summary": summarize(items), "payments": items}


@router.post("/api/remit/commit")
async def api_commit(file: UploadFile = File(...), user=Depends(require_biller), db: Session = Depends(get_db)):
    """Read the file again here (nothing the browser sends is trusted), match, update the claims and keep the payments."""
    _gate(user, db)
    try:
        parsed = await _read(file)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    items = _apply(db, _org_namespace(user), user.organization or "", parsed, commit=True)
    db.commit()
    return {"ok": True, "summary": summarize(items), "payments": items}


@router.get("/api/remit/analytics")
def api_analytics(user=Depends(require_user), db: Session = Depends(get_db)):
    _gate(user, db)
    org = _org_namespace(user)
    rows = db.scalars(sa_select(OrgRemit).where(OrgRemit.org_key == org)).all()
    by_carc, by_payer = defaultdict(lambda: {"count": 0, "amount": 0.0}), defaultdict(lambda: {"claims": 0, "denied": 0, "denied_amount": 0.0, "paid": 0.0})
    total_paid = denied_n = 0
    denied_amt = 0.0
    short = 0
    for r in rows:
        adjs = json.loads(r.adjustments or "[]")
        p = by_payer[r.payer or "Unknown payer"]
        p["claims"] += 1
        p["paid"] += r.paid
        total_paid += r.paid
        if r.stage == "denied":
            denied_n += 1
            amt = sum(a["amount"] for a in adjs if a["group"] != "PR" and a["code"] != "45") or r.charge
            denied_amt += amt
            p["denied"] += 1
            p["denied_amount"] += amt
            c = by_carc[r.carc or "Unknown"]
            c["count"] += 1
            c["amount"] += amt
        elif any(a["group"] != "PR" and a["code"] != "45" and a["amount"] > 0 for a in adjs):
            short += 1
    reasons = []
    for k, v in sorted(by_carc.items(), key=lambda kv: -kv[1]["amount"]):
        desc, kind = carc_info(k.split("-")[-1])
        reasons.append({"carc": k, "reason": desc, "kind": kind, "next": NEXT_STEP.get(kind, ""), "count": v["count"], "amount": round(v["amount"], 2)})
    payers = [{"payer": k, **{kk: (round(vv, 2) if isinstance(vv, float) else vv) for kk, vv in v.items()},
               "denial_rate": round(100 * v["denied"] / v["claims"], 1) if v["claims"] else 0} for k, v in sorted(by_payer.items(), key=lambda kv: -kv[1]["denied_amount"])]
    open_denials = db.scalars(sa_select(OrgClaim).where(OrgClaim.org_key == org, OrgClaim.status == "Denied")).all()
    return {"payments": len(rows), "paid_total": round(total_paid, 2), "denied": denied_n, "denied_amount": round(denied_amt, 2),
            "denial_rate": round(100 * denied_n / len(rows), 1) if rows else 0, "short_paid": short,
            "reasons": reasons[:10], "payers": payers[:10],
            "open_denials": [{"id": c.claim_id, "patient": c.patient_name, "payer": c.payer, "amount": float(c.amount or 0),
                              "carc": (json.loads(c.remit or "{}") or {}).get("carc", ""), "letter": c.appeal_letter or ""} for c in open_denials[:100]]}


@router.get("/revenue/payment-files")
async def page(request: Request, user=Depends(current_user)):
    if not user:
        return RedirectResponse(url="/login", status_code=302)
    if not getattr(user, "onboarding_complete", 1):
        return RedirectResponse(url="/onboarding", status_code=302)
    import main as _main
    return _main.templates.TemplateResponse(request, "remittances.html", {"user": user, "verified": None, "user_json": _main._app_user_json(user)})

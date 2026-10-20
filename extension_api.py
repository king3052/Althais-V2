"""
extension_api.py: the server side of the Althais browser extension (extension/ folder).

The extension reads a claim off the EMR page the person is looking at (only when they press Read) and asks Althais to check it.
This module is deliberately small and strict:
  - A person with billing access creates a pairing token on the Connect EMR page. Only a hash of it is stored. It can be
    revoked, and an org keeps at most 5.
  - The extension sends that token as a Bearer header. It never uses the person's login cookie.
  - /api/extension/check takes ONLY the fields the checks need (codes, payer, date, charge). It stores nothing and logs nothing
    about the claim. The patient's name is never sent; a placeholder stands in for it so the "no patient" check doesn't fire.
  - Checks run through emr_connect.claim_check, the same code as uploads, so results match everywhere.
"""

import datetime as dt
import hashlib
import hmac
import json
import re
import secrets
import time
from collections import defaultdict, deque
from datetime import timezone

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import JSONResponse
from sqlalchemy import select as sa_select
from sqlalchemy.orm import Session

import emr_connect as ec
import icd10
from auth import OrgSettings, _org_namespace, get_db, require_biller

router = APIRouter()
CATEGORY = "extension"
MAX_TOKENS = 5
RATE = (60, 60)               # 60 checks per minute per token
_hits = defaultdict(deque)
NO_STORE = {"Cache-Control": "no-store"}


def _hash(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def _row(db, org):
    return db.scalar(sa_select(OrgSettings).where(OrgSettings.org_key == org, OrgSettings.category == CATEGORY))


def _doc(row):
    try:
        return json.loads(row.data or "{}") if row else {}
    except Exception:
        return {}


def _auth(db, authorization):
    """The org a Bearer token belongs to, or None. Token format: <row id>.<secret>."""
    m = re.fullmatch(r"Bearer\s+(\d{1,9})\.([A-Za-z0-9_\-]{20,80})", authorization or "")
    if not m:
        return None
    row = db.get(OrgSettings, int(m.group(1)))
    if not row or row.category != CATEGORY:
        return None
    h = _hash(m.group(2))
    for t in _doc(row).get("tokens", []):
        if hmac.compare_digest(t.get("h", ""), h):
            return row.org_key, f"{row.id}"
    return None


def _limited(key) -> bool:
    now, q = time.time(), _hits[key]
    while q and now - q[0] > RATE[1]:
        q.popleft()
    if len(q) >= RATE[0]:
        return True
    q.append(now)
    return False


@router.post("/api/extension/token")
def create_token(user=Depends(require_biller), db: Session = Depends(get_db)):
    ec._gate(user, db)
    org = _org_namespace(user)
    row = _row(db, org)
    if not row:
        row = OrgSettings(org_key=org, category=CATEGORY, data="{}")
        db.add(row)
        db.commit()
        db.refresh(row)
    doc = _doc(row)
    secret = secrets.token_urlsafe(32)
    toks = (doc.get("tokens", []) + [{"h": _hash(secret), "created": dt.datetime.now(timezone.utc).isoformat()}])[-MAX_TOKENS:]
    row.data = json.dumps({"tokens": toks})
    db.commit()
    return JSONResponse({"token": f"{row.id}.{secret}", "count": len(toks)}, headers=NO_STORE)


@router.post("/api/extension/revoke")
def revoke_tokens(user=Depends(require_biller), db: Session = Depends(get_db)):
    ec._gate(user, db)
    row = _row(db, _org_namespace(user))
    if row:
        row.data = "{}"
        db.commit()
    return {"ok": True}


@router.get("/api/extension/ping")
def ping(authorization: str = Header(default=""), db: Session = Depends(get_db)):
    if not _auth(db, authorization):
        return JSONResponse({"error": "That token isn't valid. Create a new one in Althais under Revenue > Connect EMR."}, status_code=401, headers=NO_STORE)
    return JSONResponse({"ok": True, "version": 1}, headers=NO_STORE)


def _clean_claim(b: dict):
    """Only the fields the checks need, trimmed and bounded. Returns (claim, error)."""
    def codes(v, pat, cap=20):
        out = []
        for x in (v if isinstance(v, list) else [])[:cap]:
            x = re.sub(r"\s+", "", str(x)).upper()[:12]
            if x and re.fullmatch(pat, x) and x not in out:
                out.append(x)
        return out
    try:
        amount = round(float(str(b.get("amount") or 0).replace("$", "").replace(",", "")), 2)
    except ValueError:
        amount = 0.0
    if not (0 <= amount < 10_000_000):
        amount = 0.0
    claim = {"claim_id": str(b.get("claim_id") or "")[:40], "patient_name": "On screen (not sent)", "mrn": "", "dob": None,
             "dos": ec._date(str(b.get("dos") or "")[:20]), "dos_raw": str(b.get("dos") or "")[:20], "payer": str(b.get("payer") or "")[:120].strip(),
             "cpt": codes(b.get("cpt"), r"[A-Za-z0-9]{4,6}"), "icd": codes(b.get("icd"), r"[A-Za-z0-9.]{3,9}"), "modifiers": codes(b.get("modifiers"), r"[A-Za-z0-9]{2}", 8),
             "amount": amount, "provider": "", "pos": "", "rows": []}
    if not claim["cpt"] and not claim["icd"] and not claim["payer"]:
        return None, "Nothing to check yet. Read the page or type the codes in first."
    return claim, None


@router.post("/api/extension/check")
async def check(request: Request, authorization: str = Header(default=""), db: Session = Depends(get_db)):
    who = _auth(db, authorization)
    if not who:
        return JSONResponse({"error": "That token isn't valid. Create a new one in Althais under Revenue > Connect EMR."}, status_code=401, headers=NO_STORE)
    if _limited(who[1]):
        return JSONResponse({"error": "Too many checks in a minute. Wait a moment and try again."}, status_code=429, headers=NO_STORE)
    try:
        body = await request.json()
    except Exception:
        body = {}
    claim, err = _clean_claim(body.get("claim") if isinstance(body, dict) and isinstance(body.get("claim"), dict) else {})
    if err:
        return JSONResponse({"error": err}, status_code=400, headers=NO_STORE)
    c = ec.run_checks([claim])[0]
    return JSONResponse({**_result(c), "echo": {k: c[k] for k in ("cpt", "icd", "modifiers", "payer", "dos", "amount")}}, headers=NO_STORE)


EM_OFFICE = re.compile(r"^992(0[2-5]|1[1-5])$")   # office / outpatient E/M visits


def _extra_flags(c):
    """Checks the panel adds on top of the shared upload checks: diagnosis codes that don't exist or aren't billable
    (the 2026 ICD-10-CM table), and more than one office visit on the same claim."""
    out = []
    if icd10.LOADED:
        for code in c["icd"]:
            exists, billable, _ = icd10.lookup(code)
            if not exists:
                out.append({"severity": "error", "code": "icd_unknown", "message": f"{code} isn't in the 2026 ICD-10-CM code set. Check for a typo."})
            elif not billable:
                kids = ", ".join(k for k, _ in icd10.billable_children(code, 4))
                out.append({"severity": "error", "code": "icd_header", "message": f"{code} is a category, not a billable code. Use a more specific code" + (f", such as {kids}." if kids else ".")})
    em = [x for x in c["cpt"] if EM_OFFICE.match(x)]
    if len(em) > 1:
        out.append({"severity": "warn", "code": "multi_em", "message": f"{' and '.join(em)} are both office visits. Payers usually pay one E/M visit per day, so keep the one the note supports."})
    return out


def _codes(c, flags):
    """One row per CPT and ICD-10 code: description (ICD-10 only; CPT text is AMA-licensed) and the worst flag that names it."""
    rank = {"error": 3, "warn": 2, "info": 1}
    rows = []
    for typ, codes in (("CPT", c["cpt"]), ("ICD-10", c["icd"])):
        for code in codes:
            desc = icd10.lookup(code)[2] if typ == "ICD-10" else ""
            hits = [f for f in flags if code in f["codes"]]
            worst = max((f["severity"] for f in hits), key=lambda s: rank.get(s, 0), default="ok")
            rows.append({"code": code, "type": typ, "description": desc, "status": worst, "issues": len(hits)})
    return rows


def _result(c):
    flags = [{"severity": f["severity"], "code": f["code"], "message": f["message"]} for f in c["flags"] if f["code"] != "no_patient"]
    flags += _extra_flags(c)
    every = c["cpt"] + c["icd"]
    for f in flags:
        f["codes"] = [x for x in every if re.search(r"(?<![A-Z0-9.])" + re.escape(x) + r"(?![A-Z0-9])", f["message"].upper())]
    return {"verdict": ec.verdict_for(flags), "score": ec.score_for(flags), "flags": flags, "codes": _codes(c, flags)}


@router.post("/api/extension/lookup")
async def lookup(request: Request, authorization: str = Header(default=""), db: Session = Depends(get_db)):
    """The page only needs to supply a claim number. If the clinic's athenahealth is connected, Althais reads the claim itself and checks it.
    The patient is never returned: only codes, payer, date and charge come back."""
    who = _auth(db, authorization)
    if not who:
        return JSONResponse({"error": "That token isn't valid. Create a new one in Althais under Revenue > Connect EMR."}, status_code=401, headers=NO_STORE)
    if _limited(who[1]):
        return JSONResponse({"error": "Too many checks in a minute. Wait a moment and try again."}, status_code=429, headers=NO_STORE)
    try:
        body = await request.json()
    except Exception:
        body = {}
    cid = re.sub(r"^(AH-)", "", str((body or {}).get("claim_id") or "").strip(), flags=re.I)
    if not re.fullmatch(r"\d{1,12}", cid):
        return JSONResponse({"error": "That doesn't look like an athenahealth claim number (digits only)."}, status_code=400, headers=NO_STORE)
    import athenahealth as ah
    _, doc = ah._load(db, who[0])
    if not doc.get("practice_id") or not ah.configured():
        return JSONResponse({"error": "athenahealth isn't connected in Althais yet. Connect it under Revenue > Connect EMR, or type the codes in."}, status_code=409, headers=NO_STORE)
    try:
        cl = ah.Client(doc["practice_id"])
        raw = cl.get(f"/claims/{cid}")
        raw = raw[0] if isinstance(raw, list) and raw else raw
        if not isinstance(raw, dict) or not raw:
            return JSONResponse({"error": "athenahealth has no claim with that number for this practice."}, status_code=404, headers=NO_STORE)
        claim = ah.to_canonical(raw, None, ah.patient_insurers(cl, raw.get("patientid")) if raw.get("patientid") else {})
    except ah.AthenaError as e:
        return JSONResponse({"error": str(e)}, status_code=400, headers=NO_STORE)
    except Exception:
        return JSONResponse({"error": "Couldn't reach athenahealth. Try again in a minute."}, status_code=502, headers=NO_STORE)
    claim["patient_name"] = "On screen (not sent)"
    c = ec.run_checks([claim])[0]
    fields = {k: c[k] for k in ("cpt", "icd", "modifiers", "payer", "dos", "amount")}
    fields["claim_id"] = cid
    return JSONResponse({**_result(c), "fields": fields}, headers=NO_STORE)

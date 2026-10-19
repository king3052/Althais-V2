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
    return JSONResponse({"verdict": c["verdict"], "score": c["score"], "flags": [{"severity": f["severity"], "code": f["code"], "message": f["message"]} for f in c["flags"] if f["code"] != "no_patient"],
                         "echo": {k: c[k] for k in ("cpt", "icd", "modifiers", "payer", "dos", "amount")}}, headers=NO_STORE)

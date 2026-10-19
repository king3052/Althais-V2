"""
athenahealth.py: the athenahealth (athenaOne) connection for "Connect EMR" (emr_connect.py).

What is verified and what is not (read before relying on this):
  Verified against athenahealth's published developer docs (docs.athenahealth.com/api):
    - 2-legged OAuth with a client secret: POST <base>/oauth2/v1/token with HTTP Basic auth (client id : secret) and the form
      fields grant_type=client_credentials and scope=athena/service/Athenanet.MDP.* . The reply has access_token and expires_in.
    - Preview base URL https://api.preview.platform.athenahealth.com ; production https://api.platform.athenahealth.com .
    - Claim endpoints GET /v1/{practiceid}/claims (filters servicestartdate, serviceenddate as mm/dd/yyyy, limit up to 5000,
      offset; reply has claims, totalcount, next) and GET /v1/{practiceid}/claims/{claimid} (detail fields claimid,
      billedservicedate, chargeamount, patientid, diagnoses, procedures, primaryinsurancepayer, billedproviderid,
      supervisingprovidername, ...).
  Learned from the sandbox: the claim list rejects a call with only dates ("Additional fields are required"), so the connector reads
  each department in turn (GET /departments, whose field names are NOT verified either).
  NOT verified: the fields INSIDE `diagnoses`, `procedures` and `primaryinsurancepayer` (the docs page collapses them), the
  exact fields the list call returns per claim, and the patient lookup (GET /v1/{practiceid}/patients/{patientid}, used for the
  name and date of birth). The reader tolerates several likely names, but it has never run against athenahealth's sandbox.
  So a sync only ever produces a *preview* for a person to review: nothing is saved until they press Save, and anything it
  couldn't read shows up as a missing diagnosis, payer or date in the claim check.
  First real test: connect the Preview app with its test practice, pull a range, and compare the preview with athenaOne.

Setup: in the athenahealth Developer Console create a 2-legged OAuth app (client secret), then set ATHENA_CLIENT_ID and
ATHENA_CLIENT_SECRET on the server. ATHENA_ENV is "preview" (default, test data only) or "production" (needs athenahealth's
production approval). A clinic then enters its practice ID on the Connect EMR page.

The client secret lives only in server environment variables. The access token is kept in memory and is never sent to the browser.
"""

import base64
import datetime as dt
import json
import os
import time
from datetime import timezone

import requests
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import select as sa_select
from sqlalchemy.orm import Session

import emr_connect as ec
from auth import OrgSettings, _org_namespace, get_db, require_biller

router = APIRouter()

CATEGORY = "athenahealth"
SCOPE = "athena/service/Athenanet.MDP.*"
BASES = {"preview": "https://api.preview.platform.athenahealth.com", "production": "https://api.platform.athenahealth.com"}
MAX_CALLS = 300
MAX_CLAIMS = 150
PAGE = 200

_token = {"value": "", "expires_at": 0.0, "env": ""}


class AthenaError(Exception):
    pass


def configured() -> bool:
    return bool(os.environ.get("ATHENA_CLIENT_ID") and os.environ.get("ATHENA_CLIENT_SECRET"))


def env_name() -> str:
    return "production" if os.environ.get("ATHENA_ENV", "preview").strip().lower() == "production" else "preview"


def base_url() -> str:
    return BASES[env_name()]


def _basic() -> str:
    raw = f"{os.environ.get('ATHENA_CLIENT_ID', '')}:{os.environ.get('ATHENA_CLIENT_SECRET', '')}".encode()
    return "Basic " + base64.b64encode(raw).decode()


def get_token(force=False) -> str:
    """A 2-legged access token, cached until shortly before it expires."""
    if not force and _token["value"] and _token["env"] == env_name() and _token["expires_at"] - time.time() > 60:
        return _token["value"]
    r = requests.post(base_url() + "/oauth2/v1/token", headers={"Authorization": _basic()},
                      data={"grant_type": "client_credentials", "scope": SCOPE}, timeout=30)
    if r.status_code != 200 or "access_token" not in r.json():
        raise AthenaError("athenahealth didn't accept the app credentials. Check ATHENA_CLIENT_ID, ATHENA_CLIENT_SECRET and ATHENA_ENV.")
    j = r.json()
    _token.update(value=j["access_token"], expires_at=time.time() + float(j.get("expires_in") or 300), env=env_name())
    return _token["value"]


# ---- the clinic's stored connection (just its practice ID; no secrets) ----
def _load(db, org):
    row = db.scalar(sa_select(OrgSettings).where(OrgSettings.org_key == org, OrgSettings.category == CATEGORY))
    try:
        return row, (json.loads(row.data or "{}") if row else {})
    except Exception:
        return row, {}


def _save(db, org, doc):
    row, _ = _load(db, org)
    if not row:
        row = OrgSettings(org_key=org, category=CATEGORY, data="{}")
        db.add(row)
    row.data = json.dumps(doc)
    db.commit()


def _why(r) -> str:
    """athenahealth's own explanation for an error, shortened. (Error text describes the request, not patient data.)"""
    try:
        j = r.json()
        msg = j.get("detailedmessage") or j.get("error") or j.get("message") or j.get("detail") if isinstance(j, dict) else ""
    except Exception:
        msg = ""
    if not msg:
        msg = getattr(r, "text", "") if isinstance(getattr(r, "text", ""), str) else ""
    msg = " ".join(str(msg).split())[:240]
    return f" Reason given: {msg}" if msg else ""


class Client:
    """A small, rate-aware athenahealth API client for one practice."""

    def __init__(self, practice_id):
        self.pid, self.calls = str(practice_id), 0

    def get(self, path, params=None):
        if self.calls >= MAX_CALLS:
            raise AthenaError(f"Stopped after {MAX_CALLS} calls to stay inside athenahealth's rate limits. Try a shorter date range or try again later.")
        url = path if path.startswith("http") else f"{base_url()}/v1/{self.pid}{path}"
        for attempt in (0, 1):
            self.calls += 1
            r = requests.get(url, params=params if not path.startswith("http") else None, headers={"Authorization": "Bearer " + get_token(force=attempt == 1), "Accept": "application/json"}, timeout=30)
            if r.status_code == 401 and attempt == 0:
                continue
            if r.status_code == 429:
                raise AthenaError("athenahealth's rate limit was reached. Try again in a few minutes.")
            if r.status_code in (403, 404) and "/patients/" not in path:
                raise AthenaError(f"athenahealth said no ({r.status_code}) for {path}. Check the practice ID and that the app is allowed to read claims for it.")
            if r.status_code >= 400:
                raise AthenaError(f"athenahealth returned an error ({r.status_code}) for {path}." + _why(r))
            return r.json()


# ──────────────────────────────────────────────────────────────────────────
#  athenahealth claim -> Althais's canonical claim (tolerant of field-name differences; see the note at the top)
# ──────────────────────────────────────────────────────────────────────────
def _items(v):
    """A list of dicts from a list, a dict of dicts, or a single dict."""
    if isinstance(v, dict):
        vals = list(v.values())
        return vals if vals and all(isinstance(x, dict) for x in vals) else [v]
    return [x for x in (v or []) if isinstance(x, dict)]


def _first(d: dict, keys):
    for k in keys:
        if d.get(k) not in (None, ""):
            return d[k]
    return ""


def _dx(v):
    out = []
    for d in _items(v):
        c = _first(d, ("diagnosiscode", "icd10code", "icd10", "icdcode", "code"))
        if isinstance(c, dict):
            c = _first(c, ("code", "diagnosiscode"))
        for x in ec._split_codes(c):
            if x not in out:
                out.append(x)
    return out


def _payer(claim: dict) -> str:
    p = claim.get("primaryinsurancepayer")
    if isinstance(p, dict):
        v = _first(p, ("payername", "payer", "name", "insurancepackagename", "insurancename", "insurance"))
        if isinstance(v, dict):
            v = _first(v, ("name", "payername"))
        return str(v) if v else ""
    return str(p) if p else ""


def to_canonical(claim: dict, patient: dict = None) -> dict:
    patient = patient or {}
    cpt, mods, icd, amount = [], [], _dx(claim.get("diagnoses")), 0.0
    for pr in _items(claim.get("procedures")):
        code = str(_first(pr, ("procedurecode", "cptcode", "cpt", "code"))).strip().upper()
        if code and code not in cpt:
            cpt.append(code)
        for k, v in pr.items():
            if str(k).lower().startswith("modifier") and v and not isinstance(v, (dict, list)):
                mods += ec._split_codes(v)
        for x in _dx(pr.get("diagnoses") or pr.get("diagnosiscodes") or []):
            if x not in icd:
                icd.append(x)
        for k in ("diagnosiscode1", "diagnosiscode2", "diagnosiscode3", "diagnosiscode4", "icd10code1", "icd10code2", "icd10code3", "icd10code4"):
            for x in ec._split_codes(pr.get(k) or ""):
                if x not in icd:
                    icd.append(x)
    try:
        amount = float(str(claim.get("chargeamount") or 0).replace(",", "").replace("$", ""))
    except ValueError:
        amount = 0.0
    when = str(claim.get("billedservicedate") or claim.get("servicedate") or "")
    first, last = str(patient.get("firstname") or patient.get("first_name") or ""), str(patient.get("lastname") or patient.get("last_name") or "")
    name = f"{first} {last}".strip() or (f"Patient {claim.get('patientid')}" if claim.get("patientid") else "")
    prov = str(claim.get("supervisingprovidername") or (f"Provider {claim.get('billedproviderid')}" if claim.get("billedproviderid") else ""))
    return {"claim_id": f"AH-{claim.get('claimid')}", "patient_name": name, "mrn": str(claim.get("localpatientid") or claim.get("patientid") or ""),
            "dob": ec._date(patient.get("dob") or patient.get("dateofbirth")), "dos": ec._date(when), "dos_raw": when, "payer": _payer(claim),
            "cpt": cpt, "icd": icd, "modifiers": list(dict.fromkeys(mods)), "amount": round(amount, 2), "provider": prov, "pos": "", "rows": []}


def departments(client: Client, cap=10):
    """The practice's department IDs (GET /departments; the field names are not verified, so a few spellings are accepted)."""
    data = client.get("/departments")
    rows = data.get("departments", []) if isinstance(data, dict) else (data if isinstance(data, list) else [])
    ids = []
    for d in rows:
        v = str(_first(d, ("departmentid", "id")) if isinstance(d, dict) else d).strip()
        if v and v not in ids:
            ids.append(v)
    if not ids:
        raise AthenaError("athenahealth returned no departments for this practice, and its claim list needs one.")
    return ids[:cap]


def fetch_claims(client: Client, days: int):
    """Claims with a service date in the last `days` days, as canonical claims. Returns (claims, notes)."""
    today = dt.datetime.now(timezone.utc).date()
    start = today - dt.timedelta(days=max(1, min(int(days or 30), 90)))
    fmt = lambda d: d.strftime("%m/%d/%Y")
    # athenahealth's claim list asks for a department (its "Additional fields are required" reply), so read each department in turn.
    depts = departments(client)
    listed, total = [], 0
    for dept in depts:
        offset = 0
        while len(listed) <= MAX_CLAIMS:
            page = client.get("/claims", {"departmentid": dept, "servicestartdate": fmt(start), "serviceenddate": fmt(today), "limit": PAGE, "offset": offset})
            rows = page.get("claims", []) if isinstance(page, dict) else []
            total += (page.get("totalcount", len(rows)) if isinstance(page, dict) else len(rows))
            listed.extend(rows)
            if not rows or not (isinstance(page, dict) and page.get("next")):
                break
            offset += len(rows)
        if len(listed) > MAX_CLAIMS:
            break
    notes = []
    if len(listed) > MAX_CLAIMS or total > MAX_CLAIMS:
        listed = listed[:MAX_CLAIMS]
        notes.append(f"Only the first {MAX_CLAIMS} claims were read, to stay inside athenahealth's rate limits. Pull a shorter range for the rest.")
    patients, claims = {}, []
    for row in listed:
        cid = row.get("claimid")
        complete = all(row.get(k) for k in ("procedures", "diagnoses", "chargeamount", "primaryinsurancepayer"))
        detail = row if complete else (client.get(f"/claims/{cid}") if cid else row)
        detail = {**row, **(detail if isinstance(detail, dict) else {})}
        pid = detail.get("patientid")
        if pid and pid not in patients:
            try:
                patients[pid] = client.get(f"/patients/{pid}")
            except AthenaError:
                patients[pid] = {}
            if isinstance(patients[pid], list):
                patients[pid] = patients[pid][0] if patients[pid] else {}
        claims.append(to_canonical(detail, patients.get(pid, {})))
    notes.append(f"Read {len(listed)} claims with {client.calls} athenahealth calls ({env_name()} environment).")
    return claims, notes


# ──────────────────────────────────────────────────────────────────────────
#  The connector, and the routes
# ──────────────────────────────────────────────────────────────────────────
class Athenahealth(ec.EmrConnector):
    key = "athenahealth"
    label = "athenahealth"
    env_needed = ("ATHENA_CLIENT_ID", "ATHENA_CLIENT_SECRET")

    def status(self, db, org):
        if not configured():
            return {"state": "unavailable", "text": "Built, not switched on: ATHENA_CLIENT_ID and ATHENA_CLIENT_SECRET aren't set on the server yet.", "actions": []}
        _, doc = _load(db, org)
        if doc.get("practice_id"):
            return {"state": "connected", "text": f"Connected to practice {doc['practice_id']} ({env_name()} data)" + (f". Last pull: {doc['last_sync'][:10]}, {doc.get('last_count', 0)} claims." if doc.get("last_sync") else "."),
                    "actions": [{"label": "Pull last 30 days", "kind": "sync", "days": 30}, {"label": "Disconnect", "kind": "disconnect"}]}
        return {"state": "ready", "text": "Ready to connect. Field mapping hasn't been tested on a real account, so check each preview.",
                "actions": [{"label": "Connect with practice ID", "kind": "practice"}]}


@router.post("/api/integrations/athenahealth/connect")
async def connect(request: Request, user=Depends(require_biller), db: Session = Depends(get_db)):
    ec._gate(user, db)
    if not configured():
        return JSONResponse({"error": "athenahealth isn't switched on for this server yet."}, status_code=400)
    try:
        pid = str((await request.json()).get("practice_id", "")).strip()
    except Exception:
        pid = ""
    if not pid.isdigit() or len(pid) > 12:
        return JSONResponse({"error": "Enter the practice ID as digits only."}, status_code=400)
    try:
        get_token(force=True)
        Client(pid).get("/ping")
    except AthenaError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    except requests.RequestException:
        return JSONResponse({"error": "Couldn't reach athenahealth. Try again in a minute."}, status_code=502)
    _save(db, _org_namespace(user), {"practice_id": pid, "connected_at": dt.datetime.now(timezone.utc).isoformat()})
    return {"ok": True}


@router.get("/api/integrations/athenahealth/sample")
def sample(user=Depends(require_biller), db: Session = Depends(get_db)):
    """Preview environment only: the raw athenahealth records behind the first claim, so the field mapping can be checked against
    what athenahealth really sends. Refuses in production, where these would be real patients' records."""
    ec._gate(user, db)
    if env_name() != "preview":
        return JSONResponse({"error": "The raw sample is only available in the preview (test data) environment."}, status_code=403)
    _, doc = _load(db, _org_namespace(user))
    if not doc.get("practice_id") or not configured():
        return JSONResponse({"error": "athenahealth isn't connected yet."}, status_code=400)
    try:
        client = Client(doc["practice_id"])
        today = dt.datetime.now(timezone.utc).date()
        for dept in departments(client):
            page = client.get("/claims", {"departmentid": dept, "servicestartdate": (today - dt.timedelta(days=90)).strftime("%m/%d/%Y"),
                                          "serviceenddate": today.strftime("%m/%d/%Y"), "limit": 1, "offset": 0})
            rows = page.get("claims", []) if isinstance(page, dict) else []
            if rows:
                cid, pid = rows[0].get("claimid"), rows[0].get("patientid")
                return {"list_row": rows[0], "detail": client.get(f"/claims/{cid}") if cid else None,
                        "patient": client.get(f"/patients/{pid}") if pid else None}
        return JSONResponse({"error": "No claims found in the last 90 days."}, status_code=404)
    except AthenaError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    except requests.RequestException:
        return JSONResponse({"error": "Couldn't reach athenahealth. Try again in a minute."}, status_code=502)


@router.post("/api/integrations/athenahealth/disconnect")
def disconnect(user=Depends(require_biller), db: Session = Depends(get_db)):
    ec._gate(user, db)
    row, _ = _load(db, _org_namespace(user))
    if row:
        row.data = "{}"
        db.commit()
    return {"ok": True}


@router.post("/api/integrations/athenahealth/sync")
async def sync(request: Request, user=Depends(require_biller), db: Session = Depends(get_db)):
    """Pull recent claims and return them as a preview (same shape as an upload preview). Saves nothing."""
    ec._gate(user, db)
    org = _org_namespace(user)
    _, doc = _load(db, org)
    if not doc.get("practice_id") or not configured():
        return JSONResponse({"error": "athenahealth isn't connected yet."}, status_code=400)
    try:
        days = int((await request.json()).get("days", 30))
    except Exception:
        days = 30
    try:
        claims, notes = fetch_claims(Client(doc["practice_id"]), days)
    except AthenaError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    except requests.RequestException:
        return JSONResponse({"error": "Couldn't reach athenahealth. Try again in a minute."}, status_code=502)
    if not claims:
        return JSONResponse({"error": "No claims found in that range." + " " + " ".join(notes)}, status_code=404)
    checked = ec.run_checks(claims, existing_ids=ec._existing_ids(db, org))
    doc["last_sync"], doc["last_count"] = dt.datetime.now(timezone.utc).isoformat(), len(checked)
    _save(db, org, doc)
    return {"emr": "athenahealth", "file": f"athenahealth, last {days} days", "unmapped_columns": [], "notes": notes, "summary": ec.summarize(checked), "claims": [ec._public(c) for c in checked]}

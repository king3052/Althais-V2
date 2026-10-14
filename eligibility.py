"""
eligibility.py, checking a patient's insurance coverage after registration.

check_eligibility(request) is the one entry point. It returns an EligibilityResult and never raises:
  - "not_connected" until a provider is set up (the stub; the default)
  - Claim.MD's eligibility API (/services/eligdata/) once Althais's Claim.MD account is connected in the admin
    console (clearinghouse.PLATFORM). It needs the payer's Claim.MD payer ID and the clinic's billing NPI and Tax ID.

Nothing here logs PHI. Responses are summarized into the result; the raw 271 isn't kept.
"""

import datetime as dt
from dataclasses import dataclass, field, asdict
from typing import List, Optional

import clearinghouse as chx


@dataclass
class EligibilityRequest:
    payer: str                       # payer name as registered
    member_id: str
    patient_dob: str                 # YYYY-MM-DD
    subscriber_first: str = ""
    subscriber_last: str = ""
    subscriber_dob: str = ""         # YYYY-MM-DD; same as the patient when they're the subscriber
    relationship: str = "self"       # self | spouse | child | other
    payer_id: str = ""               # the clearinghouse's payer ID, when known
    provider_npi: str = ""           # the clinic's billing NPI
    provider_tin: str = ""           # the clinic's Tax ID
    service_date: str = ""           # YYYY-MM-DD; today when empty


@dataclass
class EligibilityResult:
    status: str                      # active | inactive | not_connected | error
    copay: Optional[float] = None
    deductible: Optional[float] = None
    deductible_remaining: Optional[float] = None
    plan: str = ""
    errors: List[str] = field(default_factory=list)
    source: str = ""                 # which provider answered
    checked_at: str = field(default_factory=lambda: dt.datetime.now(dt.timezone.utc).isoformat())

    def as_dict(self):
        return asdict(self)


class EligibilityProvider:
    name = "none"

    def check(self, req: EligibilityRequest) -> EligibilityResult:
        return EligibilityResult(status="not_connected", source=self.name,
                                 errors=["Eligibility checks aren't connected yet. Verify coverage with the payer."])


class ClaimMDEligibility(EligibilityProvider):
    """Claim.MD /services/eligdata/ (271 as XML). Fields per Claim.MD's API reference."""
    name = "claimmd"

    def __init__(self, key: str):
        self.cmd = chx.ClaimMD(key)

    def check(self, req: EligibilityRequest) -> EligibilityResult:
        missing = [n for n, v in (("the clinic's billing NPI", req.provider_npi), ("the clinic's Tax ID", req.provider_tin),
                                  ("the member ID", req.member_id), ("the subscriber's name", req.subscriber_last)) if not v]
        if missing:
            return EligibilityResult(status="error", source=self.name, errors=["Can't check eligibility without " + ", ".join(missing) + "."])
        pid = req.payer_id
        if not pid:
            pid, _ = self.cmd.find_payer(req.payer)
        if not pid:
            return EligibilityResult(status="error", source=self.name, errors=[f"Claim.MD payer ID not found for {req.payer}. Add it to the payer in Billing Activation."])
        ymd = lambda d: (d or "").replace("-", "")
        fields = {"ins_name_l": req.subscriber_last, "ins_name_f": req.subscriber_first, "payerid": pid,
                  "pat_rel": "18" if req.relationship in ("", "self") else "G8", "fdos": ymd(req.service_date) or dt.date.today().strftime("%Y%m%d"),
                  "prov_npi": req.provider_npi, "prov_taxid": req.provider_tin, "ins_number": req.member_id,
                  "ins_dob": ymd(req.subscriber_dob or req.patient_dob)}
        if req.relationship not in ("", "self"):
            fields["pat_dob"] = ymd(req.patient_dob)
        try:
            code, text = self.cmd._post("eligdata/", fields, timeout=45)
        except Exception as e:
            return EligibilityResult(status="error", source=self.name, errors=[f"Couldn't reach Claim.MD: {type(e).__name__}"])
        return parse_claimmd_271(code, text)


def parse_claimmd_271(code: int, text: str) -> EligibilityResult:
    """Summarize Claim.MD's eligdata XML: X12 271 benefit codes 1 = active coverage, 6 = inactive, B = co-payment,
    C = deductible (time period 29 = remaining)."""
    root = chx.ClaimMD._xml(text)
    if code != 200 or root is None:
        return EligibilityResult(status="error", source="claimmd", errors=["No answer from Claim.MD."])
    err = root.find(".//error")
    if err is not None:
        return EligibilityResult(status="error", source="claimmd", errors=[(err.get("error_mesg") or err.text or "Claim.MD returned an error.").strip()])
    el = root.find(".//elig")
    if el is None:
        return EligibilityResult(status="error", source="claimmd", errors=["Claim.MD returned no eligibility result."])
    res = EligibilityResult(status="", source="claimmd", plan=el.get("plan_number") or el.get("group_name") or "")
    for b in el.findall(".//benefit"):
        code_ = (b.get("benefit_code") or "").upper()
        amt = b.get("benefit_amount")
        try:
            amt = float(amt) if amt not in (None, "") else None
        except ValueError:
            amt = None
        if code_ == "1":
            res.status = "active"
        elif code_ == "6" and res.status != "active":
            res.status = "inactive"
        elif code_ == "B" and amt is not None and res.copay is None and (b.get("inplan_network") or "Y").upper() != "N":
            res.copay = amt
        elif code_ == "C" and amt is not None:
            if (b.get("benefit_period_code") or "") == "29":
                res.deductible_remaining = amt if res.deductible_remaining is None else res.deductible_remaining
            elif res.deductible is None:
                res.deductible = amt
    if not res.status:
        res.status, res.errors = "error", ["Claim.MD's answer didn't say whether coverage is active."]
    return res


def provider() -> EligibilityProvider:
    conn = chx.load_connection(chx.PLATFORM)
    if conn.get("partner") == "claimmd" and conn.get("key"):
        try:
            return ClaimMDEligibility(chx.unseal(conn["key"]))
        except Exception:
            pass
    return EligibilityProvider()


def check_eligibility(req: EligibilityRequest) -> EligibilityResult:
    try:
        return provider().check(req)
    except Exception as e:   # never fail registration because of eligibility
        return EligibilityResult(status="error", source="", errors=[f"Eligibility check failed ({type(e).__name__})."])

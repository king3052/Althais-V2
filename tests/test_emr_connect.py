"""Tests for emr_connect.py: the file reader, the pre-submission checks, and the import routes."""
import datetime as dt
import io

import emr_connect as ec

TODAY = dt.date(2026, 10, 17)


def table(csv_text, name="x.csv"):
    headers, rows = ec._read_table(name, csv_text.encode())
    return ec.to_canonical_rows(headers, rows)


def test_groups_line_items_into_one_claim():
    claims, unmapped, problems = table(
        "Claim #,Patient,DOS,Payer,CPT,Dx,Charge\n"
        "C1,Jane Doe,10/01/2026,Aetna,99284,R07.9,450\n"
        "C1,Jane Doe,10/01/2026,Aetna,93005,R07.9,85\n")
    assert not problems and len(claims) == 1
    c = claims[0]
    assert c["cpt"] == ["99284", "93005"] and c["icd"] == ["R07.9"] and c["amount"] == 535 and c["dos"] == "2026-10-01"


def test_splits_first_and_last_name_and_multiple_codes():
    claims, _, problems = table("First Name,Last Name,Date of Service,Insurance,CPT Codes,ICD-10,Charges\nJo,Lee,2026-10-02,BCBS,\"99283, 12001\",\"S61.409A;W26.0XXA\",$300.50\n")
    assert not problems
    c = claims[0]
    assert c["patient_name"] == "Jo Lee" and c["cpt"] == ["99283", "12001"] and c["icd"] == ["S61.409A", "W26.0XXA"] and c["amount"] == 300.5


def test_missing_required_columns_is_a_plain_error():
    claims, _, problems = table("Patient,Payer\nJane,Aetna\n")
    assert claims == [] and any("CPT" in p for p in problems)


def test_clean_claim_scores_100():
    c = {"claim_id": "A", "patient_name": "J", "dob": "1980-01-01", "dos": "2026-10-10", "payer": "Aetna", "cpt": ["99284"], "icd": ["R07.9"], "amount": 400.0}
    f = ec.claim_check(c, today=TODAY)
    assert ec.verdict_for(f) == "clean" and ec.score_for(f) == 100


def test_missing_dx_payer_and_bad_code_are_errors():
    c = {"claim_id": "B", "patient_name": "J", "dos": "2026-10-10", "payer": "", "cpt": ["9928"], "icd": [], "amount": 400.0}
    codes = {f["code"] for f in ec.claim_check(c, today=TODAY)}
    assert {"bad_cpt", "no_dx", "no_payer"} <= codes
    assert ec.verdict_for(ec.claim_check(c, today=TODAY)) == "fix"


def test_timely_filing_age():
    base = {"patient_name": "J", "payer": "Aetna", "cpt": ["99284"], "icd": ["R07.9"], "amount": 10.0}
    assert "aging" in {f["code"] for f in ec.claim_check({**base, "dos": "2026-07-01"}, today=TODAY)}
    assert "stale" in {f["code"] for f in ec.claim_check({**base, "dos": "2025-06-01"}, today=TODAY)}
    assert "future_dos" in {f["code"] for f in ec.claim_check({**base, "dos": "2026-12-01"}, today=TODAY)}


def test_ncci_bundling_flag():
    c = {"claim_id": "N", "patient_name": "J", "dos": "2026-10-10", "payer": "Aetna", "cpt": ["99291", "94760"], "icd": ["R07.9"], "amount": 10.0}
    assert "ncci" in {f["code"] for f in ec.claim_check(c, today=TODAY)}


def test_duplicate_in_file():
    seen = set()
    c = {"claim_id": "D", "patient_name": "J", "dos": "2026-10-10", "payer": "A", "cpt": ["99284"], "icd": ["R07.9"], "amount": 1.0}
    ec.claim_check(c, today=TODAY, seen_ids=seen)
    assert "dup_in_file" in {f["code"] for f in ec.claim_check(c, today=TODAY, seen_ids=seen)}


def test_no_emr_claims_to_be_live():
    # nothing is shown as a live connection until a connector class exists and is configured
    assert all(not e["live"] for e in ec.emr_cards())
    assert {e["key"] for e in ec.emr_cards()} >= {"experity", "drchrono", "athenahealth", "advancedmd"}


def test_template_round_trips():
    from fastapi.testclient import TestClient  # noqa: F401  (routes need a logged-in user; the file path is tested here)
    body = ("claim_id,patient_name,mrn,dob,date_of_service,payer,cpt,icd10,modifier,charge,provider\n"
            "SAMPLE-001,Sample Patient,MRN-0001,1980-01-31,2026-10-01,Sample Payer,99284,R07.9,25,450.00,Dr Example\n"
            "SAMPLE-001,Sample Patient,MRN-0001,1980-01-31,2026-10-01,Sample Payer,93005,R07.9,,85.00,Dr Example\n")
    claims, unmapped, problems = table(body)
    assert not problems and len(claims) == 1 and claims[0]["amount"] == 535 and claims[0]["modifiers"] == ["25"]
    assert unmapped == []


def test_xlsx_upload():
    import openpyxl
    wb = openpyxl.Workbook(); ws = wb.active
    ws.append(["Patient", "Date of Service", "Payer", "CPT", "ICD-10", "Charge"])
    ws.append(["Jane Doe", dt.date(2026, 10, 1), "Aetna", "99284", "R07.9", 450])
    buf = io.BytesIO(); wb.save(buf)
    headers, rows = ec._read_table("a.xlsx", buf.getvalue())
    claims, _, problems = ec.to_canonical_rows(headers, rows)
    assert not problems and claims[0]["dos"] == "2026-10-01" and claims[0]["amount"] == 450


# ---- routes, with the login and plan checks stubbed so only this module's behavior is under test ----
import pytest


@pytest.fixture()
def client(monkeypatch):
    from fastapi.testclient import TestClient
    import auth
    import main
    user = auth.User(id=1, email="t@example.test", full_name="Test User", organization="Test Clinic EMR Import", role="admin",
                     claims_submitted=0, onboarding_complete=1, active=1)
    monkeypatch.setattr(ec, "_gate", lambda u, d: None)
    main.app.dependency_overrides[auth.require_user] = lambda: user
    main.app.dependency_overrides[auth.require_biller] = lambda: user
    main.app.dependency_overrides[auth.current_user] = lambda: user
    yield TestClient(main.app)
    main.app.dependency_overrides.clear()


CSV = ("Claim #,Patient,DOS,Payer,CPT,Dx,Charge\n"
       "T1,Jane Doe,2026-10-10,Aetna,99284,R07.9,450\n"
       "T2,John Roe,2026-10-10,,99284,,300\n")


def test_preview_commit_worklist_summary(client):
    r = client.post("/api/integrations/import/preview", files={"file": ("claims.csv", CSV, "text/csv")}, data={"emr": "drchrono"})
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["summary"]["total"] == 2 and p["summary"]["clean"] == 1 and p["summary"]["fix"] == 1
    r = client.post("/api/integrations/import/commit", json={"emr": "drchrono", "claims": p["claims"]})
    assert r.status_code == 200 and r.json()["created"] == 2
    again = client.post("/api/integrations/import/commit", json={"emr": "drchrono", "claims": p["claims"]}).json()
    assert again["created"] == 0 and again["updated"] == 2          # importing twice updates, never duplicates
    w = client.get("/api/integrations/worklist").json()["claims"]
    assert {c["id"] for c in w} == {"T1", "T2"} and w[0]["id"] == "T2"    # worst first
    s = client.get("/api/integrations/summary").json()
    assert s["flagged"] == 1 and s["at_risk"] == 300


def test_commit_recomputes_scores(client):
    forged = [{"claim_id": "F1", "patient_name": "X", "payer": "", "cpt": ["99284"], "icd": [], "amount": 10, "score": 100, "verdict": "clean"}]
    client.post("/api/integrations/import/commit", json={"claims": forged})
    w = {c["id"]: c for c in client.get("/api/integrations/worklist").json()["claims"]}
    assert w["F1"]["status"] == "Draft" and w["F1"]["score"] < 100


def test_bad_upload_messages(client):
    assert client.post("/api/integrations/import/preview", files={"file": ("a.pdf", b"x", "application/pdf")}).status_code == 400
    r = client.post("/api/integrations/import/preview", files={"file": ("a.csv", "Patient,Payer\nJ,A\n", "text/csv")})
    assert r.status_code == 400 and "CPT" in r.json()["error"]


def test_page_and_emr_list(client):
    assert client.get("/api/integrations/emrs").json()["emrs"][0]["live"] is False
    r = client.get("/revenue/connect")
    assert r.status_code == 200 and "Connect your EMR" in r.text

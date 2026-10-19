"""Browser extension API: pairing token, check, revoke, and that nothing patient-identifying is needed."""
import pytest

import emr_connect as ec
import extension_api as xa


@pytest.fixture()
def client(monkeypatch):
    from fastapi.testclient import TestClient
    import auth
    import main
    user = auth.User(id=1, email="t@example.test", full_name="Test User", organization="Test Clinic Ext", role="admin",
                     claims_submitted=0, onboarding_complete=1, active=1)
    monkeypatch.setattr(ec, "_gate", lambda u, d: None)
    main.app.dependency_overrides[auth.require_user] = lambda: user
    main.app.dependency_overrides[auth.require_biller] = lambda: user
    main.app.dependency_overrides[auth.current_user] = lambda: user
    xa._hits.clear()
    yield TestClient(main.app)
    main.app.dependency_overrides.clear()


def _hdr(tok): return {"Authorization": f"Bearer {tok}"}


def test_token_check_revoke(client):
    assert client.post("/api/extension/check", json={"claim": {"cpt": ["99284"]}}).status_code == 401
    assert client.get("/api/extension/ping", headers=_hdr("1.nope")).status_code == 401
    tok = client.post("/api/extension/token").json()["token"]
    assert client.get("/api/extension/ping", headers=_hdr(tok)).json()["ok"]
    good = {"claim": {"claim_id": "X1", "dos": "10/10/2026", "payer": "Aetna", "cpt": ["99284"], "icd": ["R07.9"], "modifiers": [], "amount": "$450.00"}}
    r = client.post("/api/extension/check", json=good, headers=_hdr(tok))
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["verdict"] in ("clean", "review", "fix") and "no_patient" not in {f["code"] for f in j["flags"]} and j["echo"]["amount"] == 450
    bad = {"claim": {"dos": "10/10/2026", "payer": "Aetna", "cpt": ["99284"], "icd": [], "amount": 0}}
    codes = {f["code"] for f in client.post("/api/extension/check", json=bad, headers=_hdr(tok)).json()["flags"]}
    assert codes                                                                    # missing dx / zero charge shows up
    assert client.post("/api/extension/check", json={"claim": {}}, headers=_hdr(tok)).status_code == 400
    assert client.post("/api/extension/check", json={"claim": {"cpt": ["<script>"]}}, headers=_hdr(tok)).status_code == 400   # junk codes dropped
    client.post("/api/extension/revoke")
    assert client.get("/api/extension/ping", headers=_hdr(tok)).status_code == 401


def test_token_cap_and_rate_limit(client):
    toks = [client.post("/api/extension/token").json()["token"] for _ in range(7)]
    assert client.get("/api/extension/ping", headers=_hdr(toks[0])).status_code == 401     # oldest dropped
    assert client.get("/api/extension/ping", headers=_hdr(toks[-1])).status_code == 200
    body = {"claim": {"cpt": ["99213"], "icd": ["J02.9"], "payer": "Aetna", "dos": "10/10/2026", "amount": 100}}
    codes = [client.post("/api/extension/check", json=body, headers=_hdr(toks[-1])).status_code for _ in range(62)]
    assert codes[0] == 200 and codes[-1] == 429


def test_lookup_by_claim_id(client, monkeypatch):
    import athenahealth as ah
    tok = client.post("/api/extension/token").json()["token"]
    body = {"claim_id": "28368"}
    assert client.post("/api/extension/lookup", json=body).status_code == 401
    assert client.post("/api/extension/lookup", json={"claim_id": "x; drop"}, headers=_hdr(tok)).status_code == 400
    monkeypatch.delenv("ATHENA_CLIENT_ID", raising=False)
    assert client.post("/api/extension/lookup", json=body, headers=_hdr(tok)).status_code == 409          # athenahealth not connected
    monkeypatch.setenv("ATHENA_CLIENT_ID", "cid"); monkeypatch.setenv("ATHENA_CLIENT_SECRET", "sec")
    monkeypatch.setattr(ah, "_load", lambda db, org: (None, {"practice_id": "195900"}))

    class R:
        status_code = 200
        def __init__(s, b): s._b = b
        def json(s): return s._b
    def fake_get(url, params=None, headers=None, **kw):
        if url.endswith("/claims/28368"):
            return R({"claimid": "28368", "patientid": 134, "billedservicedate": "10/12/2026", "procedures": [{"procedurecode": "99214", "chargeamount": "60"}],
                      "diagnoses": [{"diagnosisrawcode": "Z00.00"}], "primaryinsurancepayer": {"primarypatientinsuranceid": "9"}})
        if "/insurances" in url:
            return R([{"insuranceid": "9", "insuranceplanname": "Aetna PPO"}])
        return type("X", (), {"status_code": 404, "json": lambda s: {}})()
    monkeypatch.setattr(ah.requests, "get", fake_get)
    monkeypatch.setattr(ah, "get_token", lambda force=False: "AT")
    j = client.post("/api/extension/lookup", json={"claim_id": "AH-28368"}, headers=_hdr(tok)).json()
    assert j["fields"]["cpt"] == ["99214"] and j["fields"]["payer"] == "Aetna PPO" and j["verdict"] == "clean"
    assert "patient" not in str(j).lower() and "134" not in str(j["fields"])
    assert client.post("/api/extension/lookup", json={"claim_id": "999"}, headers=_hdr(tok)).status_code == 400   # fake 404 -> AthenaError

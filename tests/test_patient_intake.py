"""Scan To Autofill (patient_intake.py): the extraction parser, merging across documents, validation, storage, and
the manual-fallback path when extraction is unavailable, fails or times out."""
import datetime as dt
import io
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image

import auth
import main
import patient_intake as pi


# ── parser ──────────────────────────────────────────────────────────────────
def test_parser_reads_fenced_json_and_drops_unknown_and_null_fields():
    raw = '```json\n{"fields": {"first_name": {"value": "Maria", "confidence": "high", "box": [0.1, 0.2, 0.3, 0.25]},' \
          ' "last_name": {"value": "Rivera", "confidence": 0.95}, "middle_name": null, "favorite_color": {"value": "blue"},' \
          ' "member_id": {"value": "  W2840  ", "confidence": "medium"}}, "document_kind": "insurance_card_front", "quality": ["glare"]}\n```'
    out = pi.parse_extraction(raw)
    assert out["fields"]["first_name"] == {"value": "Maria", "confidence": "high", "box": [0.1, 0.2, 0.3, 0.25]}
    assert out["fields"]["last_name"]["confidence"] == "high"          # numeric confidence mapped
    assert out["fields"]["member_id"]["value"] == "W2840"
    assert "middle_name" not in out["fields"] and "favorite_color" not in out["fields"]
    assert out["kind"] == "insurance_card_front" and out["quality"] == ["glare"]


def test_parser_never_invents_and_marks_bad_formats_low():
    out = pi.parse_extraction({"fields": {
        "date_of_birth": {"value": "04/18/1962", "confidence": "high"},
        "subscriber_date_of_birth": {"value": "13/40/1962", "confidence": "high"},
        "phone": {"value": "+1 (512) 555-0142", "confidence": "high"},
        "emergency_contact_phone": {"value": "555-01", "confidence": "high"},
        "address_state": {"value": "tx", "confidence": "high"},
        "address_zip": {"value": "787041234", "confidence": "high"},
        "sex": {"value": "unknown", "confidence": "high"},
        "email": {"value": "N/A", "confidence": "high"},
        "allergies": {"value": "Penicillin; Sulfa", "confidence": "medium"}}})
    f = out["fields"]
    assert f["date_of_birth"] == {"value": "1962-04-18", "confidence": "high", "box": None}
    assert f["subscriber_date_of_birth"]["value"] == "13/40/1962" and f["subscriber_date_of_birth"]["confidence"] == "low"
    assert f["phone"]["value"] == "5125550142"
    assert f["emergency_contact_phone"]["confidence"] == "low"
    assert f["address_state"]["value"] == "TX" and f["address_zip"]["value"] == "78704-1234"
    assert "sex" not in f and "email" not in f                         # placeholders aren't values
    assert f["allergies"]["value"] == ["Penicillin", "Sulfa"]


def test_parser_rejects_a_reply_without_json():
    with pytest.raises(ValueError):
        pi.parse_extraction("I could not read this document.")


# ── merging documents ───────────────────────────────────────────────────────
def _doc(i, tag, fields, conflicts=None):
    return {"id": i, "tag": tag, "parsed": {"fields": fields, "conflicts": conflicts or []}}


def test_conflicting_documents_are_flagged_not_picked():
    m = pi.merge_documents([
        _doc(1, "photo_id", {"last_name": {"value": "Rivera", "confidence": "high", "box": None}}),
        _doc(2, "insurance_front", {"last_name": {"value": "Rivera-Lopez", "confidence": "high", "box": None}})])
    assert "last_name" not in m["fields"]
    assert sorted(c["value"] for c in m["conflicts"]["last_name"]) == ["Rivera", "Rivera-Lopez"]


def test_agreeing_documents_merge_and_keep_the_best_confidence():
    m = pi.merge_documents([
        _doc(1, "photo_id", {"first_name": {"value": "MARIA", "confidence": "medium", "box": None}}),
        _doc(2, "insurance_front", {"first_name": {"value": "Maria", "confidence": "high", "box": None}})])
    assert m["fields"]["first_name"]["value"] == "Maria" and m["fields"]["first_name"]["docId"] == 2
    assert not m["conflicts"]


def test_lists_are_combined_and_a_documents_own_disagreement_is_kept():
    m = pi.merge_documents([
        _doc(1, "intake_form", {"medications": {"value": ["Metformin 1000 mg"], "confidence": "high", "box": None}},
             conflicts=[{"key": "phone", "values": ["5125550142", "5125550143"]}]),
        _doc(2, "intake_form", {"medications": {"value": ["metformin 1000 mg", "Lisinopril 10 mg"], "confidence": "low", "box": None}})])
    assert m["fields"]["medications"]["value"] == ["Metformin 1000 mg", "Lisinopril 10 mg"]
    assert m["fields"]["medications"]["confidence"] == "low"
    assert len(m["conflicts"]["phone"]) == 2


# ── validation ──────────────────────────────────────────────────────────────
TODAY = dt.date(2026, 10, 13)


def test_validation_accepts_a_clean_patient():
    assert pi.validate_patient({"first_name": "Maria", "last_name": "Rivera", "date_of_birth": "1962-04-18", "address_zip": "78704",
                                "phone": "(512) 555-0142", "address_state": "TX", "email": "m@x.com", "sex": "F"}, TODAY) == {}


def test_validation_catches_every_rule():
    err = pi.validate_patient({"first_name": "", "last_name": "Rivera", "date_of_birth": "2027-01-01", "subscriber_date_of_birth": "1962-02-30",
                               "address_zip": "7870", "phone": "555-0142", "address_state": "ZZ", "email": "nope", "sex": "Q"}, TODAY)
    assert set(err) == {"first_name", "date_of_birth", "subscriber_date_of_birth", "address_zip", "phone", "address_state", "email", "sex"}
    assert "future" in err["date_of_birth"]


# ── storage and endpoints (fallbacks) ───────────────────────────────────────
class _U:
    id, email, role, organization, full_name = 1, "frontdesk@clinic.test", "front_desk", "Test Clinic", "Fran Desk"


@pytest.fixture
def client(monkeypatch):
    main.app.dependency_overrides[pi._user] = lambda: _U()
    yield TestClient(main.app)
    main.app.dependency_overrides.clear()


def _png():
    b = io.BytesIO()
    Image.new("RGB", (40, 30), "white").save(b, "PNG")
    return b.getvalue()


def _upload(client, tag="insurance_front", intake=""):
    r = client.post("/api/intake/documents", files={"file": ("card.png", _png(), "image/png")}, data={"tag": tag, "intake_id": intake})
    assert r.status_code == 200, r.text
    return r.json()


def test_documents_are_stored_encrypted(client):
    up = _upload(client)
    with auth.SessionLocal() as db:
        d = db.get(pi.PatientDocument, up["id"])
        assert b"JFIF" not in d.data and pi.unseal(d.data)[:3] == b"\xff\xd8\xff"   # stored sealed; images are normalized to JPEG
        assert "card.png" not in d.filename                            # file names can hold names too


def test_unavailable_extraction_falls_back_to_manual_entry(client, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    up = _upload(client)
    r = client.post(f"/api/intake/{up['intakeId']}/extract").json()
    assert r["status"] == "unavailable" and r["fields"] == {} and r["documents"][0]["id"] == up["id"]


def test_a_failed_document_still_returns_what_the_others_said(client, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    a = _upload(client, "photo_id")
    b = _upload(client, "insurance_front", a["intakeId"])

    def fake(data, ct, tag):
        if tag == "photo_id":
            return json.dumps({"fields": {"first_name": {"value": "Maria", "confidence": "high"}, "last_name": {"value": "Rivera", "confidence": "high"}}})
        raise TimeoutError("reading took too long")
    monkeypatch.setattr(pi, "EXTRACTOR", fake)
    r = client.post(f"/api/intake/{a['intakeId']}/extract").json()
    assert r["status"] == "partial" and r["fields"]["first_name"]["value"] == "Maria"
    assert {d["id"]: d["status"] for d in r["documents"]} == {a["id"]: "extracted", b["id"]: "failed"}


def test_every_document_failing_sends_the_person_to_the_manual_form(client, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    up = _upload(client)
    monkeypatch.setattr(pi, "EXTRACTOR", lambda *a: (_ for _ in ()).throw(RuntimeError("model unavailable")))
    r = client.post(f"/api/intake/{up['intakeId']}/extract").json()
    assert r["status"] == "failed" and r["fields"] == {} and r["message"]


def test_confirm_attaches_documents_records_provenance_and_audits_without_phi(client, monkeypatch):
    up = _upload(client, "photo_id")
    r = client.post(f"/api/intake/{up['intakeId']}/confirm", json={"mrn": "MR9001", "provenance": {"first_name": "ai", "last_name": "ai_edited", "phone": "manual", "bogus": "ai"}})
    assert r.status_code == 200 and r.json()["attached"] == 1 and r.json()["eligibility"] is None
    with auth.SessionLocal() as db:
        d = db.get(pi.PatientDocument, up["id"])
        assert d.mrn == "MR9001" and d.status == "attached"
        res = db.scalars(pi.select(pi.IntakeResult).where(pi.IntakeResult.mrn == "MR9001")).one()
        assert json.loads(res.provenance) == {"first_name": "ai", "last_name": "ai_edited", "phone": "manual"}
        actions = [a.action for a in db.scalars(pi.select(pi.IntakeAudit).where(pi.IntakeAudit.intake_id == up["intakeId"]))]
        assert {"uploaded", "reviewed", "edited", "confirmed"} <= set(actions)
        assert not any("Maria" in a.detail or "Rivera" in a.detail for a in db.scalars(pi.select(pi.IntakeAudit)))
    assert client.get("/api/patients/MR9001/scans").json()["documents"][0]["tagLabel"] == "Photo ID"


def test_eligibility_runs_when_insurance_is_filled_and_reports_not_connected(client):
    up = _upload(client)
    r = client.post(f"/api/intake/{up['intakeId']}/confirm", json={"mrn": "MR9002", "provenance": {}, "insurance": {"payer": "Aetna PPO", "member_id": "W2840", "patient_dob": "1962-04-18"}}).json()
    assert r["eligibility"]["status"] == "not_connected" and r["eligibility"]["errors"]


def test_attached_documents_cant_be_deleted_and_other_clinics_cant_see_them(client):
    up = _upload(client)
    client.post(f"/api/intake/{up['intakeId']}/confirm", json={"mrn": "MR9003", "provenance": {}})
    assert client.delete(f"/api/intake/documents/{up['id']}").status_code == 400

    class Other(_U):
        organization = "Another Clinic"
    main.app.dependency_overrides[pi._user] = lambda: Other()
    assert client.get(f"/api/intake/documents/{up['id']}/file").status_code == 404


def test_front_desk_can_save_patients_but_not_code(client):
    assert auth._role_level(_U()) == 0                                # no provider-level (coding) access
    assert auth.ROLE_LABELS["front_desk"] == "Front Desk"

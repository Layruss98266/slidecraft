"""Smoke tests for the new feature endpoints.

These tests don't depend on Ollama, Google Cloud, or rembg being installed —
they assert the endpoints exist and respond sensibly (200 / 4xx / 5xx / 503).
"""
import io
import json
import zipfile

import pytest


@pytest.fixture(scope="module")
def client():
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).parent.parent))
    from app import app as flask_app
    flask_app.config["TESTING"] = True
    with flask_app.test_client() as c:
        yield c


# ── Master slide ────────────────────────────────────────────────────────
def test_master_get_default(client):
    r = client.get("/api/master")
    assert r.status_code == 200
    data = r.get_json()
    assert "primaryColor" in data
    assert "accentColor" in data


def test_master_post_roundtrip(client):
    body = {
        "header": "Test Co", "footer": "v1.0", "showPageNumbers": True,
        "primaryColor": "#112233", "accentColor": "#445566",
    }
    r = client.post("/api/master", json=body)
    assert r.status_code == 200
    r2 = client.get("/api/master")
    assert r2.get_json()["header"] == "Test Co"
    assert r2.get_json()["primaryColor"] == "#112233"


# ── Speaker notes ───────────────────────────────────────────────────────
def test_notes_post_get(client):
    r = client.post("/api/notes/1", json={"notes": "hello world"})
    assert r.status_code in (200, 400)  # 400 if no slide exists
    if r.status_code == 200:
        r2 = client.get("/api/notes/1")
        assert r2.get_json()["notes"] == "hello world"


def test_notes_reject_non_string(client):
    r = client.post("/api/notes/1", json={"notes": 123})
    assert r.status_code == 400


def test_notes_all_returns_dict(client):
    r = client.get("/api/notes/all")
    assert r.status_code == 200
    assert isinstance(r.get_json(), dict)


# ── Palette ─────────────────────────────────────────────────────────────
def test_palette_invalid_slide(client):
    r = client.get("/api/palette/9999")
    assert r.status_code == 400


def test_palette_deck_returns_colors(client):
    r = client.get("/api/palette/deck")
    assert r.status_code == 200
    assert "colors" in r.get_json()


# ── .slidecraft portable ────────────────────────────────────────────────
def test_export_portable_returns_zip(client):
    r = client.post("/api/deck/export-portable")
    assert r.status_code == 200
    assert r.data[:2] == b"PK"  # ZIP magic
    zf = zipfile.ZipFile(io.BytesIO(r.data))
    assert "manifest.json" in zf.namelist()


def test_import_portable_rejects_other_file(client):
    r = client.post("/api/deck/import-portable",
                    data={"file": (io.BytesIO(b"junk"), "foo.txt")},
                    content_type="multipart/form-data")
    assert r.status_code == 400


# ── Embed validator ─────────────────────────────────────────────────────
@pytest.mark.parametrize("url,kind", [
    ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube"),
    ("https://youtu.be/dQw4w9WgXcQ",                "youtube"),
    ("https://vimeo.com/76979871",                  "vimeo"),
    ("https://www.loom.com/share/abc123def456",     "loom"),
])
def test_embed_validate_known_hosts(client, url, kind):
    r = client.post("/api/embed/validate", json={"url": url})
    assert r.status_code == 200
    assert r.get_json()["kind"] == kind


def test_embed_validate_rejects_random(client):
    r = client.post("/api/embed/validate", json={"url": "https://example.com/foo"})
    assert r.status_code == 400


# ── Auto-save ───────────────────────────────────────────────────────────
def test_autosave_post_get(client):
    r = client.post("/api/autosave", json={"slide": 1, "overlays": [], "ts": 12345})
    assert r.status_code == 200
    r2 = client.get("/api/autosave")
    assert r2.status_code == 200
    assert r2.get_json().get("ts") == 12345


# ── AI status (allowed to fail if Ollama not running) ───────────────────
def test_ai_status_returns_json(client):
    r = client.get("/api/ai/status")
    assert r.status_code in (200, 503)
    assert r.is_json


# ── Background remover (501 if rembg missing — that's fine) ─────────────
def test_remove_bg_rejects_bad_payload(client):
    r = client.post("/api/image/remove-bg", json={"dataUrl": "not-a-data-url"})
    assert r.status_code in (400, 501)


# ── Audio list endpoint ─────────────────────────────────────────────────
def test_audio_list(client):
    r = client.get("/api/audio/list")
    assert r.status_code == 200
    assert isinstance(r.get_json(), dict)


# ── Google Slides export (503 if not configured — expected) ─────────────
def test_gslides_returns_503_when_unconfigured(client):
    r = client.post("/api/export/gslides", json={})
    # 503 when no creds, 501 when libs missing — either is fine
    assert r.status_code in (200, 501, 503)

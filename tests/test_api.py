"""End-to-end API tests covering the security and correctness fixes."""
import io
import json
import base64
from PIL import Image


def _data_url(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


# ── Home & basic GETs ───────────────────────────────────────────────────────

def test_home_renders(app_with_slides):
    client, _ = app_with_slides
    r = client.get("/")
    assert r.status_code == 200
    assert b"<html" in r.data.lower()


def test_get_slide_returns_default(app_with_slides):
    client, _ = app_with_slides
    r = client.get("/api/slide/1")
    assert r.status_code == 200
    assert r.get_json() == {"overlays": [], "notes": ""}


# ── save_slide validation ────────────────────────────────────────────────────

def test_save_slide_rejects_non_dict(app_with_slides):
    client, _ = app_with_slides
    r = client.post("/api/slide/1", json="not-a-dict")
    assert r.status_code == 400


def test_save_slide_rejects_bad_overlay_type(app_with_slides):
    client, _ = app_with_slides
    r = client.post("/api/slide/1", json={"overlays": "should-be-list"})
    assert r.status_code == 400


def test_save_slide_rejects_bad_slide_number(app_with_slides):
    client, _ = app_with_slides
    r = client.post("/api/slide/999", json={"overlays": []})
    assert r.status_code == 400


def test_save_slide_whitelists_extra_keys(app_with_slides):
    """Arbitrary keys in payload must NOT be persisted (disk-fill protection)."""
    client, app_module = app_with_slides
    payload = {"overlays": [], "notes": "ok", "garbage": "x" * 1000, "hax": [1, 2, 3]}
    r = client.post("/api/slide/1", json=payload)
    assert r.status_code == 200
    saved = json.loads(app_module.DATA_FILE.read_text())
    assert saved["1"] == {"overlays": [], "notes": "ok"}
    assert "garbage" not in saved["1"]


# ── apply_filter input validation ───────────────────────────────────────────

def test_apply_filter_rejects_non_numeric_value(app_with_slides):
    client, _ = app_with_slides
    r = client.post("/api/slide/1/filter", json={"filter": "brightness", "value": "abc"})
    assert r.status_code == 400


def test_apply_filter_unknown_filter(app_with_slides):
    client, _ = app_with_slides
    r = client.post("/api/slide/1/filter", json={"filter": "nonexistent"})
    assert r.status_code == 400


def test_apply_filter_brightness_ok(app_with_slides):
    client, _ = app_with_slides
    r = client.post("/api/slide/1/filter", json={"filter": "brightness", "value": 1.2})
    assert r.status_code == 200


# ── Multi-filter chain (new /filters endpoint) ──────────────────────────────

def test_filters_chain_returns_snapshot_and_log(app_with_slides):
    client, _ = app_with_slides
    r = client.post("/api/slide/1/filters", json={
        "brightness": 1.2, "contrast": 1.1, "saturation": 0.9,
        "hue": 10, "sepia": 0.2,
    })
    assert r.status_code == 200
    d = r.get_json()
    assert d["ok"] is True
    assert d["count"] == 1
    assert d["snapshot"]
    assert d["log_id"]


def test_filters_chain_scope_current_only_touches_one_slide(app_with_slides):
    client, app_module = app_with_slides
    s1_before = (app_module.SLIDES_DIR / "slide-01.jpg").read_bytes()
    s2_before = (app_module.SLIDES_DIR / "slide-02.jpg").read_bytes()
    r = client.post("/api/slide/2/filters", json={
        "brightness": 1.5, "scope": "current",
    })
    assert r.status_code == 200
    assert r.get_json()["count"] == 1
    assert (app_module.SLIDES_DIR / "slide-01.jpg").read_bytes() == s1_before
    assert (app_module.SLIDES_DIR / "slide-02.jpg").read_bytes() != s2_before


def test_filters_chain_scope_all_touches_every_slide(app_with_slides):
    client, app_module = app_with_slides
    befores = [(app_module.SLIDES_DIR / f"slide-{i:02d}.jpg").read_bytes() for i in (1, 2, 3)]
    r = client.post("/api/slide/1/filters", json={
        "brightness": 0.5, "scope": "all",
    })
    assert r.status_code == 200
    assert r.get_json()["count"] == 3
    for i, before in zip((1, 2, 3), befores):
        after = (app_module.SLIDES_DIR / f"slide-{i:02d}.jpg").read_bytes()
        assert after != before


def test_filters_chain_idempotent_from_original(app_with_slides):
    """Applying the same filters twice with from_original=True should produce
    the same bytes — no cumulative degradation."""
    client, app_module = app_with_slides
    body = {"brightness": 0.7, "sepia": 0.4, "from_original": True}
    client.post("/api/slide/1/filters", json=body)
    once = (app_module.SLIDES_DIR / "slide-01.jpg").read_bytes()
    client.post("/api/slide/1/filters", json=body)
    twice = (app_module.SLIDES_DIR / "slide-01.jpg").read_bytes()
    assert once == twice


def test_filters_chain_logged_entry_is_revertable(app_with_slides):
    client, app_module = app_with_slides
    before = (app_module.SLIDES_DIR / "slide-01.jpg").read_bytes()
    r = client.post("/api/slide/1/filters", json={
        "brightness": 1.4, "scope": "current",
    })
    log_id = r.get_json()["log_id"]
    after_filter = (app_module.SLIDES_DIR / "slide-01.jpg").read_bytes()
    assert after_filter != before

    # Reverting via the watermark log endpoint should restore the original
    r2 = client.post(f"/api/watermarks/revert/{log_id}")
    assert r2.status_code == 200
    assert (app_module.SLIDES_DIR / "slide-01.jpg").read_bytes() == before


def test_filters_chain_invalid_slide(app_with_slides):
    client, _ = app_with_slides
    r = client.post("/api/slide/999/filters", json={"brightness": 1.1})
    assert r.status_code == 400


# ── Template name strict validation ─────────────────────────────────────────

def test_template_rejects_path_traversal(app_with_slides):
    client, _ = app_with_slides
    for bad in ["../etc", "..\\..\\", "name/with/slash", "name\x00null", ".", ".."]:
        r = client.post("/api/templates/save", json={"name": bad})
        assert r.status_code == 400, f"Should reject {bad!r}"


def test_template_save_load_delete(app_with_slides):
    client, _ = app_with_slides
    r = client.post("/api/templates/save", json={"name": "my_test_template"})
    assert r.status_code == 200
    r = client.get("/api/templates")
    assert "my_test_template" in [t["name"] for t in r.get_json()["templates"]]
    r = client.post("/api/templates/delete", json={"name": "my_test_template"})
    assert r.status_code == 200


# ── History/version name strict validation ──────────────────────────────────

def test_history_rejects_bad_names(app_with_slides):
    client, _ = app_with_slides
    for bad in ["../etc", "name/with/slash", ""]:
        r = client.post("/api/history/restore", json={"version": bad})
        assert r.status_code == 400


# ── Upload PPTX safety ──────────────────────────────────────────────────────

def test_upload_rejects_non_pptx(app_with_slides):
    client, _ = app_with_slides
    r = client.post("/api/upload", data={"file": (io.BytesIO(b"hi"), "evil.exe")},
                    content_type="multipart/form-data")
    assert r.status_code == 400


def test_upload_no_file(app_with_slides):
    client, _ = app_with_slides
    r = client.post("/api/upload", data={})
    assert r.status_code == 400


def test_upload_pptx_atomic_preserves_state_on_failure(app_with_slides):
    """A malformed PPTX must NOT wipe existing slides."""
    client, app_module = app_with_slides
    before = sorted(p.name for p in app_module.SLIDES_DIR.glob("slide-*.jpg"))
    assert len(before) == 3
    r = client.post(
        "/api/upload",
        data={"file": (io.BytesIO(b"not-a-real-pptx"), "fake.pptx")},
        content_type="multipart/form-data",
    )
    # Upload should fail
    assert r.status_code in (400, 500)
    # But existing slides must still be there
    after = sorted(p.name for p in app_module.SLIDES_DIR.glob("slide-*.jpg"))
    assert after == before


# ── Image upload sanity ─────────────────────────────────────────────────────

def test_upload_image_returns_data_url(app_with_slides):
    client, _ = app_with_slides
    img = Image.new("RGB", (10, 10), "red")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    r = client.post("/api/upload-image", data={"file": (buf, "x.png")},
                    content_type="multipart/form-data")
    assert r.status_code == 200
    assert r.get_json()["src"].startswith("data:image/png;base64,")


# ── Bake: base64 size cap on image overlays ─────────────────────────────────

def test_bake_rejects_oversized_b64_overlay(app_with_slides):
    """An image overlay larger than MAX_OVERLAY_IMG_BYTES is silently skipped, not OOM'd."""
    client, app_module = app_with_slides
    # 1 byte over the cap, repeated
    cap = app_module.MAX_OVERLAY_IMG_BYTES
    huge_b64 = base64.b64encode(b"\x00" * (cap + 100)).decode()
    payload = {
        "overlays": [{
            "type": "image", "x": 0.1, "y": 0.1, "w": 0.5, "h": 0.5,
            "src": "data:image/png;base64," + huge_b64,
        }],
        "notes": "",
    }
    client.post("/api/slide/1", json=payload)
    # Bake must not crash
    r = client.post("/api/slide/1/bake")
    assert r.status_code == 200


# ── Reset slide to original ─────────────────────────────────────────────────

def test_reset_slide_restores_original(app_with_slides):
    client, app_module = app_with_slides
    # Mutate a slide via a filter
    client.post("/api/slide/1/filter", json={"filter": "blur", "value": 5})
    mutated = (app_module.SLIDES_DIR / "slide-01.jpg").read_bytes()
    original = (app_module.ORIGINALS_DIR / "slide-01.jpg").read_bytes()
    assert mutated != original  # filter actually changed it
    r = client.post("/api/slide/1/reset")
    assert r.status_code == 200
    restored = (app_module.SLIDES_DIR / "slide-01.jpg").read_bytes()
    assert restored == original


def test_reset_slide_404_when_no_original(app_with_slides):
    client, app_module = app_with_slides
    (app_module.ORIGINALS_DIR / "slide-01.jpg").unlink()
    r = client.post("/api/slide/1/reset")
    assert r.status_code == 404


# ── Comments: atomic add/resolve/delete ─────────────────────────────────────

def test_add_resolve_delete_comment(app_with_slides):
    client, _ = app_with_slides
    r = client.post("/api/comments/1", json={"text": "hi", "x": 0.5, "y": 0.5})
    assert r.status_code == 200
    r = client.get("/api/comments/1")
    assert len(r.get_json()["comments"]) == 1
    assert r.get_json()["comments"][0]["text"] == "hi"
    assert r.get_json()["comments"][0]["resolved"] is False

    client.post("/api/comments/1/resolve", json={"index": 0})
    r = client.get("/api/comments/1")
    assert r.get_json()["comments"][0]["resolved"] is True

    client.post("/api/comments/1/delete", json={"index": 0})
    assert client.get("/api/comments/1").get_json()["comments"] == []


def test_comment_caps_text_length(app_with_slides):
    client, _ = app_with_slides
    r = client.post("/api/comments/1", json={"text": "A" * 10000})
    assert r.status_code == 200
    text = client.get("/api/comments/1").get_json()["comments"][0]["text"]
    assert len(text) <= 5000


# ── Export cleanup (TTL) ────────────────────────────────────────────────────

def test_old_exports_cleaned_on_new_export(app_with_slides):
    client, app_module = app_with_slides
    # Plant a fake "old" export
    old = app_module.EXPORT_DIR / "ancient_export.pptx"
    old.write_bytes(b"x")
    import os, time
    os.utime(old, (time.time() - app_module.EXPORT_TTL_SECONDS - 60,) * 2)
    # Trigger an export
    r = client.post("/api/export")
    assert r.status_code == 200
    assert not old.exists()


# ── _wrap_text_lines newline preservation ───────────────────────────────────

def test_wrap_text_preserves_newlines():
    import app as app_module
    font = app_module._get_bake_font(20)
    lines = app_module._wrap_text_lines("line one\nline two", font, 10_000)
    assert lines == ["line one", "line two"]


# ── Safe name helper ────────────────────────────────────────────────────────

def test_safe_name_helper():
    import app as app_module
    assert app_module._safe_name("hello_world") == "hello_world"
    assert app_module._safe_name("with space-and-dash") == "with space-and-dash"
    assert app_module._safe_name("") == ""
    assert app_module._safe_name(".") == ""
    assert app_module._safe_name("..") == ""
    assert app_module._safe_name("../etc") == ""
    assert app_module._safe_name("a/b") == ""
    assert app_module._safe_name("a\x00b") == ""
    assert app_module._safe_name(123) == ""
    assert app_module._safe_name("a" * 100) == ""  # over 64 chars


# ── QR generation handles missing url ───────────────────────────────────────

def test_qr_missing_url(app_with_slides):
    client, _ = app_with_slides
    r = client.post("/api/qr-generate", json={})
    assert r.status_code == 400


# ── Find/replace ────────────────────────────────────────────────────────────

# ── Watermark (redesigned) ──────────────────────────────────────────────────

def test_watermark_preview_returns_data_url(app_with_slides):
    client, _ = app_with_slides
    r = client.post("/api/watermark/preview/1", json={
        "text": "DRAFT", "opacity": 0.2, "position": "center",
        "color": "#ff0000", "font_scale": 0.08, "rotation": 45, "tile_spacing": 1.0,
    })
    assert r.status_code == 200
    assert r.get_json()["preview"].startswith("data:image/jpeg;base64,")


def test_watermark_rejects_empty_text(app_with_slides):
    client, _ = app_with_slides
    r = client.post("/api/watermark", json={"text": "   "})
    assert r.status_code == 400


def test_watermark_scope_current_only_touches_one_slide(app_with_slides):
    client, app_module = app_with_slides
    before = [(app_module.SLIDES_DIR / f"slide-{i:02d}.jpg").read_bytes() for i in range(1, 4)]
    r = client.post("/api/watermark", json={
        "text": "CONFIDENTIAL", "scope": "current", "slide_num": 2,
        "opacity": 0.3, "position": "center",
    })
    assert r.status_code == 200
    after = [(app_module.SLIDES_DIR / f"slide-{i:02d}.jpg").read_bytes() for i in range(1, 4)]
    assert before[0] == after[0]
    assert before[1] != after[1]  # only slide 2 changed
    assert before[2] == after[2]


def test_watermark_creates_undo_snapshot(app_with_slides):
    client, app_module = app_with_slides
    r = client.post("/api/watermark", json={"text": "X", "scope": "current", "slide_num": 1})
    assert r.status_code == 200
    snapshot = r.get_json()["snapshot"]
    assert snapshot
    assert (app_module.HISTORY_DIR / snapshot).exists()


# ── Applied watermark log ───────────────────────────────────────────────────

def test_applied_log_records_text_watermark(app_with_slides):
    client, app_module = app_with_slides
    r = client.post("/api/watermark", json={"text": "DRAFT", "scope": "all"})
    assert r.status_code == 200
    log_id = r.get_json()["log_id"]
    r2 = client.get("/api/watermarks/applied")
    entries = r2.get_json()["entries"]
    assert len(entries) == 1
    assert entries[0]["id"] == log_id
    assert entries[0]["kind"] == "text"
    assert entries[0]["text"] == "DRAFT"
    assert entries[0]["revertable"] is True


def test_applied_log_revert_restores_slides(app_with_slides):
    client, app_module = app_with_slides
    before = (app_module.SLIDES_DIR / "slide-01.jpg").read_bytes()
    r = client.post("/api/watermark", json={"text": "REMOVE-ME", "scope": "all"})
    log_id = r.get_json()["log_id"]
    after_apply = (app_module.SLIDES_DIR / "slide-01.jpg").read_bytes()
    assert before != after_apply  # watermark applied
    # Revert
    r2 = client.post(f"/api/watermarks/revert/{log_id}")
    assert r2.status_code == 200
    restored = (app_module.SLIDES_DIR / "slide-01.jpg").read_bytes()
    assert restored == before  # back to original
    # The original log entry is gone (no non-orphan entry with that id remains)
    entries = client.get("/api/watermarks/applied").get_json()["entries"]
    assert not any(e["id"] == log_id and not e.get("orphan") for e in entries)


def test_applied_log_revert_drops_later_entries(app_with_slides):
    """Reverting watermark #1 must also drop the log entry for #2
    since the on-disk state no longer matches it."""
    client, _ = app_with_slides
    r1 = client.post("/api/watermark", json={"text": "FIRST"})
    r2 = client.post("/api/watermark", json={"text": "SECOND"})
    id1 = r1.get_json()["log_id"]
    id2 = r2.get_json()["log_id"]
    # Revert the FIRST one
    r = client.post(f"/api/watermarks/revert/{id1}")
    assert r.status_code == 200
    assert r.get_json()["dropped"] == 2  # both entries gone from log
    # Neither logged entry should still be in the list as a non-orphan
    entries = client.get("/api/watermarks/applied").get_json()["entries"]
    non_orphan_ids = {e["id"] for e in entries if not e.get("orphan")}
    assert id1 not in non_orphan_ids
    assert id2 not in non_orphan_ids


def test_applied_log_revert_rejects_invalid_id(app_with_slides):
    client, _ = app_with_slides
    for bad in ["../etc", "x/y", ""]:
        r = client.post(f"/api/watermarks/revert/{bad}")
        assert r.status_code in (400, 404)


def test_revert_scope_current_only_restores_one_slide(app_with_slides):
    """Reverting a watermark applied with scope=current must only touch THAT
    slide. Unrelated edits to other slides made after the apply must survive."""
    client, app_module = app_with_slides
    s1_before = (app_module.SLIDES_DIR / "slide-01.jpg").read_bytes()

    # Apply watermark to slide 2 only
    r = client.post("/api/watermark", json={
        "text": "CURRENT-ONLY", "scope": "current", "slide_num": 2,
    })
    assert r.status_code == 200
    log_id = r.get_json()["log_id"]
    s2_after_wm = (app_module.SLIDES_DIR / "slide-02.jpg").read_bytes()

    # Now mutate slides 1 and 3 separately AFTER the watermark
    client.post("/api/slide/1/filter", json={"filter": "brightness", "value": 0.5})
    client.post("/api/slide/3/filter", json={"filter": "contrast", "value": 1.8})
    s1_mutated = (app_module.SLIDES_DIR / "slide-01.jpg").read_bytes()
    s3_mutated = (app_module.SLIDES_DIR / "slide-03.jpg").read_bytes()
    assert s1_mutated != s1_before  # sanity: filter actually changed it

    # Revert the watermark
    r = client.post(f"/api/watermarks/revert/{log_id}")
    assert r.status_code == 200

    # Slide 2 should be restored (no longer has watermark)
    s2_after_revert = (app_module.SLIDES_DIR / "slide-02.jpg").read_bytes()
    assert s2_after_revert != s2_after_wm
    # Slides 1 and 3 must keep their post-watermark edits — NOT be reset
    assert (app_module.SLIDES_DIR / "slide-01.jpg").read_bytes() == s1_mutated
    assert (app_module.SLIDES_DIR / "slide-03.jpg").read_bytes() == s3_mutated


def test_revert_scope_current_preserves_unrelated_later_entries(app_with_slides):
    """Reverting watermark A on slide 2 must NOT drop the log entry for
    watermark B on slide 3 — they don't conflict."""
    client, _ = app_with_slides
    a = client.post("/api/watermark", json={
        "text": "A", "scope": "current", "slide_num": 2,
    }).get_json()
    b = client.post("/api/watermark", json={
        "text": "B", "scope": "current", "slide_num": 3,
    }).get_json()

    # Revert A; B should survive because it touched a different slide
    r = client.post(f"/api/watermarks/revert/{a['log_id']}")
    assert r.status_code == 200
    assert r.get_json()["dropped"] == 1

    entries = client.get("/api/watermarks/applied").get_json()["entries"]
    non_orphan = [e for e in entries if not e.get("orphan")]
    surviving_ids = {e["id"] for e in non_orphan}
    assert b["log_id"] in surviving_ids
    assert a["log_id"] not in surviving_ids


def test_revert_scope_current_drops_later_same_slide_and_all_entries(app_with_slides):
    """Reverting watermark A on slide 2 SHOULD drop:
      - Later entries on slide 2 (same-slide conflict)
      - Later entries with scope=all (they painted over slide 2 too)
    Later entries on other slides survive."""
    client, _ = app_with_slides
    a = client.post("/api/watermark", json={
        "text": "A", "scope": "current", "slide_num": 2,
    }).get_json()
    same_slide = client.post("/api/watermark", json={
        "text": "SAME-SLIDE", "scope": "current", "slide_num": 2,
    }).get_json()
    other_slide = client.post("/api/watermark", json={
        "text": "OTHER", "scope": "current", "slide_num": 3,
    }).get_json()
    all_scope = client.post("/api/watermark", json={
        "text": "ALL", "scope": "all",
    }).get_json()

    r = client.post(f"/api/watermarks/revert/{a['log_id']}")
    assert r.status_code == 200

    entries = client.get("/api/watermarks/applied").get_json()["entries"]
    surviving = {e["id"] for e in entries if not e.get("orphan")}
    assert other_slide["log_id"] in surviving  # different slide — keep
    assert a["log_id"] not in surviving        # reverted target — drop
    assert same_slide["log_id"] not in surviving  # same slide — drop
    assert all_scope["log_id"] not in surviving   # scope=all touched slide 2 — drop


def test_applied_lists_orphan_snapshots_after_log_clear(app_with_slides):
    """If the user clears the log (or upgrades from an older session), any
    history snapshots tagged with a watermark-* reason should still surface
    as 'orphan' entries that can be reverted."""
    client, app_module = app_with_slides
    # Apply a watermark — creates log entry + history snapshot
    r = client.post("/api/watermark", json={"text": "ORPHAN-ME", "scope": "all"})
    assert r.status_code == 200
    # Wipe just the log (not the history)
    client.post("/api/watermarks/clear-log")
    entries = client.get("/api/watermarks/applied").get_json()["entries"]
    assert len(entries) == 1
    e = entries[0]
    assert e["orphan"] is True
    assert e["id"].startswith("orphan_")
    assert e["revertable"] is True


# ── Full reset ──────────────────────────────────────────────────────────────

def test_reset_all_restores_originals_and_clears_state(app_with_slides):
    client, app_module = app_with_slides
    # Make a mess: apply a watermark, add a comment, save overlay data, mutate slide
    client.post("/api/slide/1", json={
        "overlays": [{"type": "text", "text": "junk", "x": 0, "y": 0, "w": 0.2, "h": 0.05}],
        "notes": "junk notes",
    })
    client.post("/api/comments/1", json={"text": "junky comment"})
    client.post("/api/watermark", json={"text": "WIPE-ME", "scope": "all"})

    # Confirm the slide is no longer the original
    mutated = (app_module.SLIDES_DIR / "slide-01.jpg").read_bytes()
    original = (app_module.ORIGINALS_DIR / "slide-01.jpg").read_bytes()
    assert mutated != original

    r = client.post("/api/reset-all")
    assert r.status_code == 200
    body = r.get_json()
    assert body["ok"] is True
    assert body["slides_restored"] == 3
    assert body["snapshot"]

    # Slides match originals
    for i in range(1, 4):
        live = (app_module.SLIDES_DIR / f"slide-{i:02d}.jpg").read_bytes()
        orig = (app_module.ORIGINALS_DIR / f"slide-{i:02d}.jpg").read_bytes()
        assert live == orig

    # All state files removed
    assert not app_module.DATA_FILE.exists()
    assert not app_module.COMMENTS_FILE.exists()
    assert not app_module.WATERMARK_LOG.exists()

    # GET endpoints return clean defaults
    assert client.get("/api/slide/1").get_json() == {"overlays": [], "notes": ""}
    assert client.get("/api/comments/1").get_json() == {"comments": []}


def test_reset_all_fails_without_originals_or_history(app_client):
    """No originals AND no history → clean error, slides untouched."""
    client, app_module = app_client
    from PIL import Image as _Img
    for i in range(1, 3):
        _Img.new("RGB", (400, 225), (i * 50, i * 50, i * 50)).save(
            str(app_module.SLIDES_DIR / f"slide-{i:02d}.jpg"), "JPEG"
        )
    before = (app_module.SLIDES_DIR / "slide-01.jpg").read_bytes()
    r = client.post("/api/reset-all")
    assert r.status_code == 400
    after = (app_module.SLIDES_DIR / "slide-01.jpg").read_bytes()
    assert before == after


def test_reset_all_falls_back_to_oldest_snapshot(app_client):
    """If `_originals/` is missing but a history snapshot exists,
    reset uses the oldest snapshot as the source."""
    client, app_module = app_client
    from PIL import Image as _Img
    # Create live slides (mutated)
    _Img.new("RGB", (400, 225), (0, 200, 0)).save(
        str(app_module.SLIDES_DIR / "slide-01.jpg"), "JPEG"
    )
    # Create a pretend history snapshot (the "original" baseline)
    snap_dir = app_module.HISTORY_DIR / "20250101_000000_aaaa"
    snap_dir.mkdir(parents=True)
    _Img.new("RGB", (400, 225), (200, 0, 0)).save(str(snap_dir / "slide-01.jpg"), "JPEG")
    snap_bytes = (snap_dir / "slide-01.jpg").read_bytes()

    r = client.post("/api/reset-all")
    assert r.status_code == 200
    body = r.get_json()
    assert "snapshot" in body["source"] or "oldest snapshot" in body["source"]
    assert (app_module.SLIDES_DIR / "slide-01.jpg").read_bytes() == snap_bytes


def test_reset_all_creates_undo_snapshot(app_with_slides):
    client, app_module = app_with_slides
    client.post("/api/slide/1", json={"overlays": [{"type": "text", "text": "x", "x": 0, "y": 0, "w": 0.1, "h": 0.1}]})
    r = client.post("/api/reset-all")
    snapshot = r.get_json()["snapshot"]
    assert snapshot
    assert (app_module.HISTORY_DIR / snapshot).exists()


def test_orphan_revert_restores_slides(app_with_slides):
    client, app_module = app_with_slides
    before = (app_module.SLIDES_DIR / "slide-01.jpg").read_bytes()
    client.post("/api/watermark", json={"text": "ORPHAN-REVERT", "scope": "all"})
    client.post("/api/watermarks/clear-log")
    entries = client.get("/api/watermarks/applied").get_json()["entries"]
    orphan_id = entries[0]["id"]
    r = client.post(f"/api/watermarks/revert/{orphan_id}")
    assert r.status_code == 200
    restored = (app_module.SLIDES_DIR / "slide-01.jpg").read_bytes()
    assert restored == before


def test_applied_log_clear(app_with_slides):
    """Clearing the log removes the rich log entry. The history snapshot
    remains on disk and surfaces as an orphan entry (still revertable)."""
    client, app_module = app_with_slides
    r = client.post("/api/watermark", json={"text": "X"})
    log_id = r.get_json()["log_id"]
    assert len(client.get("/api/watermarks/applied").get_json()["entries"]) == 1
    r = client.post("/api/watermarks/clear-log")
    assert r.status_code == 200
    # Log file itself is empty
    import json
    assert json.loads(app_module.WATERMARK_LOG.read_text()) == []
    # But the snapshot persists, so we see an orphan instead of nothing
    entries = client.get("/api/watermarks/applied").get_json()["entries"]
    assert len(entries) == 1
    assert entries[0]["orphan"] is True
    assert entries[0]["id"] != log_id  # different — orphan id format


def test_find_replace_counts_replacements(app_with_slides):
    client, _ = app_with_slides
    client.post("/api/slide/1", json={
        "overlays": [{"type": "text", "text": "old word here", "x": 0, "y": 0, "w": 0.2, "h": 0.05}],
        "notes": "",
    })
    r = client.post("/api/find-replace", json={"find": "old", "replace": "new"})
    assert r.status_code == 200
    assert r.get_json()["replacements"] == 1
    saved = client.get("/api/slide/1").get_json()
    assert saved["overlays"][0]["text"] == "new word here"

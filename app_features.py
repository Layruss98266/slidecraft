"""
SlideCraft — additional feature routes.

Registered by app.py via register_feature_routes(app, ctx). Keeps the main
file lean while adding: master slide / theme, palette extraction, .slidecraft
portable zip, background remover, YouTube embed, audio narration upload,
video-to-slides scene split, auto-save heartbeat.
"""

import base64
import io
import json
import shutil
import uuid
import zipfile
from pathlib import Path
from flask import jsonify, request, send_file
from werkzeug.utils import secure_filename
from PIL import Image
from collections import Counter


def register_feature_routes(app, ctx):
    """ctx = dict of shared paths/helpers from app.py:
         BASE_DIR, SLIDES_DIR, ORIGINALS_DIR, DATA_FILE, UPLOAD_DIR,
         EXPORT_DIR, VIDEO_DIR, load_data, save_data, _get_slide_files,
         _safe_name, _data_lock, _set_deck_name, _get_deck_name,
         MAX_OVERLAY_IMG_BYTES
    """
    BASE_DIR     = ctx["BASE_DIR"]
    SLIDES_DIR   = ctx["SLIDES_DIR"]
    DATA_FILE    = ctx["DATA_FILE"]
    EXPORT_DIR   = ctx["EXPORT_DIR"]
    VIDEO_DIR    = ctx["VIDEO_DIR"]
    UPLOAD_DIR   = ctx["UPLOAD_DIR"]
    load_data    = ctx["load_data"]
    save_data    = ctx["save_data"]
    get_slides   = ctx["_get_slide_files"]
    safe_name    = ctx["_safe_name"]
    data_lock    = ctx["_data_lock"]

    THEMES_DIR  = BASE_DIR / "themes_saved"
    AUDIO_DIR   = BASE_DIR / "audio"
    THEMES_DIR.mkdir(exist_ok=True)
    AUDIO_DIR.mkdir(exist_ok=True)
    MASTER_FILE = BASE_DIR / "master_slide.json"

    # ─── Speaker notes (dedicated GET/POST so the notes pane is self-contained)
    @app.route("/api/notes/<int:num>", methods=["GET"])
    def get_notes(num):
        data = load_data()
        return jsonify({"notes": data.get(str(num), {}).get("notes", "")})

    @app.route("/api/notes/<int:num>", methods=["POST"])
    def set_notes(num):
        payload = request.get_json(silent=True) or {}
        text = payload.get("notes", "")
        if not isinstance(text, str):
            return jsonify({"error": "notes must be a string"}), 400
        with data_lock:
            data = json.loads(DATA_FILE.read_text()) if DATA_FILE.exists() else {}
            entry = data.get(str(num), {"overlays": [], "notes": ""})
            entry["notes"] = text[:20000]
            data[str(num)] = entry
            DATA_FILE.write_text(json.dumps(data, indent=2))
        return jsonify({"ok": True})

    @app.route("/api/notes/all", methods=["GET"])
    def get_all_notes():
        data = load_data()
        return jsonify({str(k): v.get("notes", "") for k, v in data.items()})

    # ─── Master slide / theme: header/footer text + brand colors applied to all
    @app.route("/api/master", methods=["GET"])
    def get_master():
        if MASTER_FILE.exists():
            try:
                return jsonify(json.loads(MASTER_FILE.read_text()))
            except json.JSONDecodeError:
                pass
        return jsonify({
            "header": "", "footer": "", "showPageNumbers": False,
            "primaryColor": "#2563EB", "accentColor": "#A78BFA",
            "fontFamily": "Inter", "logoDataUrl": "",
        })

    @app.route("/api/master", methods=["POST"])
    def set_master():
        payload = request.get_json(silent=True) or {}
        clean = {
            "header":          str(payload.get("header", ""))[:200],
            "footer":          str(payload.get("footer", ""))[:200],
            "showPageNumbers": bool(payload.get("showPageNumbers", False)),
            "primaryColor":    str(payload.get("primaryColor", "#2563EB"))[:9],
            "accentColor":     str(payload.get("accentColor", "#A78BFA"))[:9],
            "fontFamily":      str(payload.get("fontFamily", "Inter"))[:64],
            "logoDataUrl":     str(payload.get("logoDataUrl", ""))[:2_000_000],
        }
        MASTER_FILE.write_text(json.dumps(clean, indent=2))
        return jsonify({"ok": True})

    # ─── Palette extraction: pull dominant colors from a slide
    @app.route("/api/palette/<int:num>", methods=["GET"])
    def palette(num):
        slides = get_slides()
        if num < 1 or num > len(slides):
            return jsonify({"error": "Invalid slide"}), 400
        try:
            img = Image.open(slides[num - 1]).convert("RGB")
            # Downsample for speed
            img.thumbnail((200, 200))
            # Quantize to 8 colors then read palette
            quant = img.quantize(colors=8, method=Image.Quantize.MAXCOVERAGE)
            pal = quant.getpalette()[: 8 * 3]
            counts = Counter(quant.getdata()).most_common(8)
            colors = []
            for idx, _count in counts:
                r, g, b = pal[idx * 3:idx * 3 + 3]
                colors.append("#{:02X}{:02X}{:02X}".format(r, g, b))
            return jsonify({"colors": colors})
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @app.route("/api/palette/deck", methods=["GET"])
    def palette_deck():
        """Aggregate palette across all slides — first 5 most-common colors."""
        slides = get_slides()
        if not slides:
            return jsonify({"colors": []})
        bucket = Counter()
        for sf in slides[:20]:  # cap for speed
            try:
                img = Image.open(sf).convert("RGB")
                img.thumbnail((120, 120))
                q = img.quantize(colors=6)
                pal = q.getpalette()[:6 * 3]
                for idx, count in Counter(q.getdata()).most_common(6):
                    r, g, b = pal[idx * 3:idx * 3 + 3]
                    bucket[(r // 16 * 16, g // 16 * 16, b // 16 * 16)] += count
            except OSError:
                continue
        top = [c for c, _ in bucket.most_common(8)]
        return jsonify({
            "colors": ["#{:02X}{:02X}{:02X}".format(*c) for c in top],
        })

    # ─── .slidecraft portable archive (slides + data + master + comments)
    @app.route("/api/deck/export-portable", methods=["POST"])
    def export_portable():
        out_name = f"deck_{uuid.uuid4().hex[:8]}.slidecraft"
        out_path = EXPORT_DIR / out_name
        manifest = {
            "version": 1,
            "deck_name": ctx["_get_deck_name"](),
            "created": uuid.uuid4().hex,
        }
        with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("manifest.json", json.dumps(manifest, indent=2))
            for sf in get_slides():
                zf.write(sf, f"slides/{sf.name}")
            if DATA_FILE.exists():
                zf.write(DATA_FILE, "slide_data.json")
            comments = BASE_DIR / "comments.json"
            if comments.exists():
                zf.write(comments, "comments.json")
            if MASTER_FILE.exists():
                zf.write(MASTER_FILE, "master_slide.json")
        return send_file(str(out_path), as_attachment=True,
                         download_name="deck.slidecraft")

    @app.route("/api/deck/import-portable", methods=["POST"])
    def import_portable():
        if "file" not in request.files:
            return jsonify({"error": "No file uploaded"}), 400
        f = request.files["file"]
        if not f.filename.lower().endswith(".slidecraft"):
            return jsonify({"error": "Only .slidecraft archives"}), 400

        UPLOAD_DIR.mkdir(exist_ok=True)
        archive = UPLOAD_DIR / secure_filename(f.filename)
        f.save(str(archive))

        try:
            with zipfile.ZipFile(archive) as zf:
                names = zf.namelist()
                if "manifest.json" not in names:
                    return jsonify({"error": "Missing manifest.json"}), 400
                # Wipe + restore
                for old in SLIDES_DIR.glob("slide-*.jpg"):
                    old.unlink()
                for member in names:
                    if member.startswith("slides/") and member.endswith(".jpg"):
                        target = SLIDES_DIR / Path(member).name
                        target.write_bytes(zf.read(member))
                if "slide_data.json" in names:
                    DATA_FILE.write_bytes(zf.read("slide_data.json"))
                if "comments.json" in names:
                    (BASE_DIR / "comments.json").write_bytes(zf.read("comments.json"))
                if "master_slide.json" in names:
                    MASTER_FILE.write_bytes(zf.read("master_slide.json"))
                meta = json.loads(zf.read("manifest.json").decode())
                if meta.get("deck_name"):
                    ctx["_set_deck_name"](meta["deck_name"])
            return jsonify({"ok": True, "num_slides": len(get_slides())})
        except zipfile.BadZipFile:
            return jsonify({"error": "Corrupt .slidecraft archive"}), 400

    # ─── Background remover for image overlays (rembg) ──────────────────
    @app.route("/api/image/remove-bg", methods=["POST"])
    def remove_bg():
        payload = request.get_json(silent=True) or {}
        data_url = payload.get("dataUrl", "")
        if not data_url.startswith("data:image"):
            return jsonify({"error": "dataUrl required"}), 400
        try:
            b64 = data_url.split(",", 1)[1]
            raw = base64.b64decode(b64)
            if len(raw) > ctx.get("MAX_OVERLAY_IMG_BYTES", 8 * 1024 * 1024):
                return jsonify({"error": "Image too large"}), 413
        except (ValueError, IndexError):
            return jsonify({"error": "Bad dataUrl"}), 400
        try:
            from rembg import remove
        except ImportError:
            return jsonify({"error": "rembg not installed. Run: pip install rembg"}), 501
        try:
            out = remove(raw)
            return jsonify({
                "dataUrl": "data:image/png;base64," + base64.b64encode(out).decode(),
            })
        except Exception as e:
            return jsonify({"error": f"BG removal failed: {e}"}), 500

    # ─── Audio narration: upload per-slide MP3/WAV; played in presentation
    @app.route("/api/audio/<int:num>", methods=["POST"])
    def upload_audio(num):
        slides = get_slides()
        if num < 1 or num > len(slides):
            return jsonify({"error": "Invalid slide"}), 400
        if "file" not in request.files:
            return jsonify({"error": "No file"}), 400
        f = request.files["file"]
        ext = Path(f.filename or "").suffix.lower()
        if ext not in {".mp3", ".wav", ".ogg", ".m4a", ".webm"}:
            return jsonify({"error": "Unsupported audio format"}), 400
        target = AUDIO_DIR / f"slide-{num:03d}{ext}"
        # Remove any other extension for this slide
        for old in AUDIO_DIR.glob(f"slide-{num:03d}.*"):
            old.unlink()
        f.save(str(target))
        return jsonify({"ok": True, "url": f"/api/audio/{num}"})

    @app.route("/api/audio/<int:num>", methods=["GET"])
    def get_audio(num):
        for ext in (".mp3", ".wav", ".ogg", ".m4a", ".webm"):
            target = AUDIO_DIR / f"slide-{num:03d}{ext}"
            if target.exists():
                return send_file(str(target))
        return jsonify({"error": "No audio for slide"}), 404

    @app.route("/api/audio/<int:num>", methods=["DELETE"])
    def del_audio(num):
        removed = False
        for ext in (".mp3", ".wav", ".ogg", ".m4a", ".webm"):
            t = AUDIO_DIR / f"slide-{num:03d}{ext}"
            if t.exists():
                t.unlink()
                removed = True
        return jsonify({"ok": True, "removed": removed})

    @app.route("/api/audio/list", methods=["GET"])
    def list_audio():
        result = {}
        for sf in get_slides():
            num = int(sf.stem.split("-")[1])
            for ext in (".mp3", ".wav", ".ogg", ".m4a", ".webm"):
                if (AUDIO_DIR / f"slide-{num:03d}{ext}").exists():
                    result[str(num)] = f"/api/audio/{num}"
                    break
        return jsonify(result)

    # ─── Video → slides: split a video by scene change into JPG slides
    @app.route("/api/video-to-slides", methods=["POST"])
    def video_to_slides():
        if "file" not in request.files:
            return jsonify({"error": "No file uploaded"}), 400
        f = request.files["file"]
        ext = Path(f.filename or "").suffix.lower()
        if ext not in {".mp4", ".mov", ".avi", ".mkv", ".webm"}:
            return jsonify({"error": "Unsupported video format"}), 400
        threshold = float(request.form.get("threshold", 30))
        max_slides = int(request.form.get("maxSlides", 50))

        VIDEO_DIR.mkdir(exist_ok=True)
        video_path = VIDEO_DIR / secure_filename(f.filename)
        f.save(str(video_path))

        try:
            import cv2
            import numpy as np
        except ImportError:
            return jsonify({"error": "OpenCV not installed"}), 501

        cap = cv2.VideoCapture(str(video_path))
        if not cap.isOpened():
            return jsonify({"error": "Could not open video"}), 500
        frames_kept = []
        prev_hist = None
        try:
            while len(frames_kept) < max_slides:
                ok, frame = cap.read()
                if not ok:
                    break
                small = cv2.resize(frame, (160, 90))
                hist = cv2.calcHist([small], [0, 1, 2], None,
                                    [8, 8, 8], [0, 256, 0, 256, 0, 256])
                cv2.normalize(hist, hist)
                if prev_hist is None:
                    frames_kept.append(frame)
                else:
                    diff = cv2.compareHist(prev_hist, hist, cv2.HISTCMP_CHISQR)
                    if diff > threshold:
                        frames_kept.append(frame)
                prev_hist = hist
        finally:
            cap.release()

        if not frames_kept:
            return jsonify({"error": "No scenes detected"}), 500

        # Wipe and write
        for old in SLIDES_DIR.glob("slide-*.jpg"):
            old.unlink()
        for i, frame in enumerate(frames_kept):
            cv2.imwrite(str(SLIDES_DIR / f"slide-{i + 1:03d}.jpg"),
                        frame, [cv2.IMWRITE_JPEG_QUALITY, 92])
        if DATA_FILE.exists():
            DATA_FILE.unlink()
        ctx["_set_deck_name"](video_path.stem)
        return jsonify({"ok": True, "num_slides": len(frames_kept)})

    # ─── YouTube/Loom embed: stored as overlay metadata, rendered in present
    @app.route("/api/embed/validate", methods=["POST"])
    def validate_embed():
        payload = request.get_json(silent=True) or {}
        url = payload.get("url", "").strip()
        kind, embed_url = _parse_embed_url(url)
        if not kind:
            return jsonify({"error": "Unsupported URL (YouTube, Vimeo, Loom only)"}), 400
        return jsonify({"kind": kind, "embedUrl": embed_url})

    # ─── Auto-save heartbeat (server-side mirror so restart restores in-flight)
    AUTOSAVE_FILE = BASE_DIR / "autosave.json"

    @app.route("/api/autosave", methods=["POST"])
    def autosave():
        payload = request.get_json(silent=True) or {}
        if not isinstance(payload, dict):
            return jsonify({"error": "Bad payload"}), 400
        # Cap at 5MB serialized
        s = json.dumps(payload)[:5_000_000]
        AUTOSAVE_FILE.write_text(s)
        return jsonify({"ok": True})

    @app.route("/api/autosave", methods=["GET"])
    def get_autosave():
        if not AUTOSAVE_FILE.exists():
            return jsonify({})
        try:
            return jsonify(json.loads(AUTOSAVE_FILE.read_text()))
        except json.JSONDecodeError:
            return jsonify({})

    return {
        "themes_dir": THEMES_DIR,
        "audio_dir": AUDIO_DIR,
        "master_file": MASTER_FILE,
    }


def _parse_embed_url(url):
    """Parse YouTube / Vimeo / Loom URL → (kind, embed_url) or (None, None)."""
    import re
    if not isinstance(url, str) or not url:
        return None, None
    # YouTube
    m = re.search(r"(?:youtube\.com/watch\?v=|youtu\.be/|youtube\.com/embed/)([\w-]{11})", url)
    if m:
        return "youtube", f"https://www.youtube.com/embed/{m.group(1)}"
    # Vimeo
    m = re.search(r"vimeo\.com/(?:video/)?(\d+)", url)
    if m:
        return "vimeo", f"https://player.vimeo.com/video/{m.group(1)}"
    # Loom
    m = re.search(r"loom\.com/share/([\w-]+)", url)
    if m:
        return "loom", f"https://www.loom.com/embed/{m.group(1)}"
    return None, None

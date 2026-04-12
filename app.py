"""
PPTX Slide Editor — Flask Backend
Edits NotebookLM image-based slides with text/shape overlays,
then exports a new editable PPTX.
"""

import os, sys, json, base64, subprocess, shutil
from pathlib import Path
from flask import Flask, render_template, jsonify, request, send_file
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN
from PIL import Image, ImageDraw, ImageFont
from werkzeug.utils import secure_filename
import io
import threading

# OCR — use EasyOCR (no external binary needed, works out of the box)
HAS_OCR = False
_ocr_reader = None
try:
    import easyocr
    HAS_OCR = True
except ImportError:
    pass

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024  # 500 MB upload limit

BASE_DIR   = Path(__file__).parent
SLIDES_DIR = BASE_DIR / "static" / "slides"
UPLOAD_DIR = BASE_DIR / "uploads"
EXPORT_DIR = BASE_DIR / "exports"
DATA_FILE  = BASE_DIR / "slide_data.json"
VIDEO_DIR  = BASE_DIR / "videos"
EXPORT_DIR.mkdir(exist_ok=True)
VIDEO_DIR.mkdir(exist_ok=True)

SLIDE_W_PX, SLIDE_H_PX = 2134, 1200   # actual JPG pixel dimensions

# Lock for file-based persistence (slide_data.json, comments.json)
_data_lock = threading.Lock()

ALLOWED_VIDEO_EXTS = {'.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv'}
ALLOWED_IMAGE_FORMATS = {'PNG', 'JPEG', 'GIF', 'WEBP', 'BMP'}

IS_WINDOWS = sys.platform == "win32"
IS_MACOS = sys.platform == "darwin"
IS_LINUX = sys.platform.startswith("linux")

def _get_slide_files():
    return sorted(SLIDES_DIR.glob("slide-*.jpg"))


def _parse_hex_color(s, default=(0, 0, 0)):
    """Parse a hex color string like '#FF00AA' or 'FF00AA'. Returns (r, g, b) tuple."""
    try:
        s = s.lstrip("#")
        if len(s) < 6:
            return default
        return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))
    except (ValueError, TypeError, AttributeError):
        return default


# ── Persistence ──────────────────────────────────────────────────────────────

def load_data():
    with _data_lock:
        if DATA_FILE.exists():
            return json.loads(DATA_FILE.read_text())
        num_slides = len(_get_slide_files())
        return {str(i+1): {"overlays": [], "notes": ""} for i in range(num_slides)}

def save_data(data):
    with _data_lock:
        DATA_FILE.write_text(json.dumps(data, indent=2))

# ── NotebookLM Logo Removal ─────────────────────────────────────────────────

# Logo region at 1376×768 source resolution: bottom-right 140×25 px.
# We scale proportionally to whatever the actual image size is.
LOGO_REF_W, LOGO_REF_H = 1376, 768   # reference image dimensions
LOGO_W, LOGO_H          = 145, 28    # tight box around icon + "NotebookLM" text (with small pad)

def _erase_logo(img):
    """Erase only the NotebookLM logo by tiling the pixel row just above it
    downward. Preserves the exact horizontal background pattern — pixel-perfect."""
    w, h = img.size
    logo_w = int(LOGO_W * w / LOGO_REF_W)
    logo_h = int(LOGO_H * h / LOGO_REF_H)

    # Single-row strip just above the logo (1 px tall)
    src_y = max(0, h - logo_h - 1)
    strip = img.crop((w - logo_w, src_y, w, src_y + 1))

    # Tile that row to full logo height (NEAREST = exact pixel copy)
    patch = strip.resize((logo_w, logo_h), Image.NEAREST)
    img.paste(patch, (w - logo_w, h - logo_h))
    return img


def remove_logos_batch(slide_files):
    """Remove the logo from many slides with minimal per-file overhead."""
    for p in slide_files:
        img = Image.open(p).convert("RGB")
        img = _erase_logo(img)
        img.save(str(p), quality=95)


def process_uploaded_pptx(pptx_path):
    """Convert PPTX slides to JPG images and remove NotebookLM logo."""
    for f in SLIDES_DIR.glob("slide-*.jpg"):
        f.unlink()
    if DATA_FILE.exists():
        DATA_FILE.unlink()
    SLIDES_DIR.mkdir(parents=True, exist_ok=True)

    try:
        _convert_pptx_to_images_libreoffice(pptx_path)
    except (RuntimeError, FileNotFoundError, subprocess.SubprocessError, OSError):
        _convert_pptx_to_images_pillow(pptx_path)

    remove_logos_batch(sorted(SLIDES_DIR.glob("slide-*.jpg")))


def _find_libreoffice():
    """Return the LibreOffice binary path or None (cross-platform)."""
    candidates = ["libreoffice", "soffice"]
    if IS_WINDOWS:
        candidates.extend([
            r"C:\Program Files\LibreOffice\program\soffice.exe",
            r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
            str(Path.home() / "AppData" / "Local" / "Programs" / "LibreOffice" / "program" / "soffice.exe"),
        ])
    elif IS_MACOS:
        candidates.append("/Applications/LibreOffice.app/Contents/MacOS/soffice")
    else:  # Linux
        candidates.extend([
            "/usr/bin/soffice",
            "/snap/bin/libreoffice",
            "/usr/bin/libreoffice",
        ])
    for candidate in candidates:
        if shutil.which(candidate) or Path(candidate).exists():
            return candidate
    return None


def _convert_pptx_to_images_libreoffice(pptx_path):
    """PPTX → PDF (LibreOffice) → JPG per page (pdf2image or PyMuPDF)."""
    import tempfile
    lo_cmd = _find_libreoffice()
    if not lo_cmd:
        raise RuntimeError("LibreOffice not found")

    tmp_dir = Path(tempfile.mkdtemp())
    try:
        subprocess.run(
            [lo_cmd, "--headless", "--convert-to", "pdf",
             "--outdir", str(tmp_dir), str(pptx_path)],
            check=True, timeout=120,
        )
        pdf_files = list(tmp_dir.glob("*.pdf"))
        if not pdf_files:
            raise RuntimeError("PDF conversion produced no output")

        try:
            from pdf2image import convert_from_path
            for i, img in enumerate(convert_from_path(str(pdf_files[0]), dpi=200)):
                img.convert("RGB").save(
                    str(SLIDES_DIR / f"slide-{i+1:02d}.jpg"), "JPEG", quality=95)
        except ImportError:
            import fitz
            doc = fitz.open(str(pdf_files[0]))
            mat = fitz.Matrix(2.0, 2.0)
            for i, page in enumerate(doc):
                pix = page.get_pixmap(matrix=mat)
                (SLIDES_DIR / f"slide-{i+1:02d}.jpg").write_bytes(pix.tobytes("jpeg"))
            doc.close()
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def _convert_pptx_to_images_pillow(pptx_path):
    """Fallback: extract embedded pictures from PPTX shapes (limited fidelity)."""
    prs = Presentation(str(pptx_path))
    sw_emu, sh_emu = prs.slide_width, prs.slide_height

    for i, slide in enumerate(prs.slides):
        img = Image.new("RGB", (SLIDE_W_PX, SLIDE_H_PX), (255, 255, 255))
        for shape in slide.shapes:
            if shape.shape_type == 13:  # Picture
                shape_img = Image.open(io.BytesIO(shape.image.blob))
                left = int(shape.left / sw_emu * SLIDE_W_PX) if sw_emu else 0
                top  = int(shape.top  / sh_emu * SLIDE_H_PX) if sh_emu else 0
                sw   = int(shape.width  / sw_emu * SLIDE_W_PX) if sw_emu else SLIDE_W_PX
                sh   = int(shape.height / sh_emu * SLIDE_H_PX) if sh_emu else SLIDE_H_PX
                img.paste(shape_img.resize((sw, sh), Image.BILINEAR), (left, top))
        img.save(str(SLIDES_DIR / f"slide-{i+1:02d}.jpg"), "JPEG", quality=95)


# ── Routes ───────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    slide_files = _get_slide_files()
    slides = [{"index": i+1, "file": f"slides/{f.name}"} for i, f in enumerate(slide_files)]
    return render_template("index.html", slides=slides, num_slides=len(slide_files))

@app.route("/api/slide/<int:num>")
def get_slide(num):
    data = load_data()
    return jsonify(data.get(str(num), {"overlays": [], "notes": ""}))

@app.route("/api/upload", methods=["POST"])
def upload_pptx():
    """Upload a PPTX file, convert to slide images, and remove NotebookLM logo."""
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400
    f = request.files["file"]
    if not f.filename.lower().endswith(".pptx"):
        return jsonify({"error": "Only .pptx files are supported"}), 400

    UPLOAD_DIR.mkdir(exist_ok=True)
    save_path = UPLOAD_DIR / secure_filename(f.filename)
    f.save(str(save_path))

    try:
        process_uploaded_pptx(save_path)
    except (OSError, ValueError, RuntimeError) as e:
        return jsonify({"error": f"Processing failed: {e}"}), 500

    return jsonify({"ok": True, "num_slides": len(_get_slide_files())})


@app.route("/api/remove-logo", methods=["POST"])
def remove_logo_from_existing():
    """Remove NotebookLM logo from all currently loaded slide images."""
    remove_logos_batch(sorted(SLIDES_DIR.glob("slide-*.jpg")))
    return jsonify({"ok": True})


@app.route("/api/slide/<int:num>", methods=["POST"])
def save_slide(num):
    num_slides = len(_get_slide_files())
    if num < 1 or num > max(num_slides, 1):
        return jsonify({"error": "Invalid slide number"}), 400
    payload = request.json
    if not isinstance(payload, dict):
        return jsonify({"error": "Invalid payload"}), 400
    # Validate expected keys
    if "overlays" in payload and not isinstance(payload["overlays"], list):
        return jsonify({"error": "overlays must be a list"}), 400
    if "notes" in payload and not isinstance(payload["notes"], str):
        return jsonify({"error": "notes must be a string"}), 400
    data = load_data()
    data[str(num)] = payload
    save_data(data)
    return jsonify({"ok": True})

@app.route("/api/export", methods=["POST"])
def export_pptx():
    """Rebuild PPTX: slide image as background + text overlays as real text boxes."""
    data = load_data()
    prs  = Presentation()
    prs.slide_width  = Inches(13.33)
    prs.slide_height = Inches(7.5)

    blank_layout = prs.slide_layouts[6]  # completely blank

    current_slides = _get_slide_files()
    for i, slide_file in enumerate(current_slides):
        slide_num = str(i + 1)
        slide     = prs.slides.add_slide(blank_layout)

        # Background image (full slide)
        pic = slide.shapes.add_picture(
            str(slide_file),
            left=0, top=0,
            width=prs.slide_width, height=prs.slide_height
        )
        # Send image to back
        slide.shapes._spTree.remove(pic._element)
        slide.shapes._spTree.insert(2, pic._element)

        # Add overlays
        slide_data = data.get(slide_num, {})
        for ov in slide_data.get("overlays", []):
            _add_overlay(slide, ov, prs.slide_width, prs.slide_height)

        # Speaker notes
        notes = slide_data.get("notes", "").strip()
        if notes:
            tf = slide.notes_slide.notes_text_frame
            tf.text = notes

    import uuid
    export_name = f"SlideCraft_Export_{uuid.uuid4().hex[:8]}.pptx"
    out_path = EXPORT_DIR / export_name
    prs.save(str(out_path))
    return send_file(str(out_path), as_attachment=True,
                     download_name="SlideCraft_Export.pptx")

@app.route("/api/slide/<int:num>/preview", methods=["POST"])
def preview_slide(num):
    """Render composite preview: slide image + overlays baked in."""
    slide_files = _get_slide_files()
    if num < 1 or num > len(slide_files):
        return jsonify({"error": "Invalid slide"}), 400

    data   = load_data()
    payload = request.json
    data[str(num)] = payload
    save_data(data)

    slide_file = slide_files[num - 1]
    img = Image.open(slide_file).convert("RGBA")
    draw = ImageDraw.Draw(img)

    for ov in payload.get("overlays", []):
        x = int(ov["x"] * SLIDE_W_PX)
        y = int(ov["y"] * SLIDE_H_PX)
        w = int(ov["w"] * SLIDE_W_PX)
        h = int(ov["h"] * SLIDE_H_PX)

        if ov["type"] == "text":
            # Semi-transparent bg box
            bg = ov.get("bgColor", "transparent")
            if bg and bg != "transparent":
                overlay_img = Image.new("RGBA", img.size, (0,0,0,0))
                ov_draw = ImageDraw.Draw(overlay_img)
                cr, cg, cb = _parse_hex_color(bg)
                ov_draw.rectangle([x, y, x+w, y+h], fill=(cr,cg,cb,180))
                img = Image.alpha_composite(img, overlay_img)
                draw = ImageDraw.Draw(img)

            r, g, b = _parse_hex_color(ov.get("color", "#FFFFFF"), (255, 255, 255))
            font_size = int(ov.get("fontSize", 18) * 2.5)
            font = _get_bake_font(font_size, bold=True, family=ov.get("fontFamily", "Arial"))
            draw.text((x+8, y+8), ov.get("text",""), fill=(r,g,b,255), font=font)

        elif ov["type"] == "rect":
            r, g, b = _parse_hex_color(ov.get("fillColor", "#2563EB"), (37, 99, 235))
            overlay_img = Image.new("RGBA", img.size, (0,0,0,0))
            ov_draw = ImageDraw.Draw(overlay_img)
            ov_draw.rectangle([x,y,x+w,y+h], fill=(r,g,b,160))
            img = Image.alpha_composite(img, overlay_img)
            draw = ImageDraw.Draw(img)

    img_rgb = img.convert("RGB")
    buf = io.BytesIO()
    img_rgb.save(buf, format="JPEG", quality=88)
    buf.seek(0)
    b64 = base64.b64encode(buf.read()).decode()
    return jsonify({"preview": f"data:image/jpeg;base64,{b64}"})


# ── Cross-platform font helpers ────────────────────────────────────────────

def _get_font_dirs():
    """Return a list of directories where system fonts are installed."""
    dirs = []
    if IS_WINDOWS:
        win_fonts = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
        dirs.append(win_fonts)
        # User-installed fonts on Windows 10+
        local_fonts = Path.home() / "AppData" / "Local" / "Microsoft" / "Windows" / "Fonts"
        if local_fonts.exists():
            dirs.append(local_fonts)
    elif IS_MACOS:
        dirs.extend([
            Path("/Library/Fonts"),
            Path("/System/Library/Fonts"),
            Path("/System/Library/Fonts/Supplemental"),
            Path.home() / "Library" / "Fonts",
        ])
    else:  # Linux and others
        dirs.extend([
            Path("/usr/share/fonts"),
            Path("/usr/local/share/fonts"),
            Path.home() / ".fonts",
            Path.home() / ".local" / "share" / "fonts",
        ])
    return [d for d in dirs if d.exists()]


# Font family → {(bold, italic): [possible filenames]} mapping
# Filenames only — resolved against font dirs at runtime
_FONT_FILENAMES = {
    "Arial": {
        (False, False): ["arial.ttf", "Arial.ttf"],
        (True, False):  ["arialbd.ttf", "Arial Bold.ttf", "Arial-BoldMT.ttf"],
        (False, True):  ["ariali.ttf", "Arial Italic.ttf"],
        (True, True):   ["arialbi.ttf", "Arial Bold Italic.ttf"],
    },
    "Segoe UI": {
        (False, False): ["segoeui.ttf", "SegoeUI.ttf"],
        (True, False):  ["segoeuib.ttf", "SegoeUI-Bold.ttf"],
        (False, True):  ["segoeuii.ttf", "SegoeUI-Italic.ttf"],
        (True, True):   ["segoeuiz.ttf", "SegoeUI-BoldItalic.ttf"],
    },
    "Calibri": {
        (False, False): ["calibri.ttf", "Calibri.ttf"],
        (True, False):  ["calibrib.ttf", "Calibri-Bold.ttf"],
        (False, True):  ["calibrii.ttf", "Calibri-Italic.ttf"],
        (True, True):   ["calibriz.ttf", "Calibri-BoldItalic.ttf"],
    },
    "Verdana": {
        (False, False): ["verdana.ttf", "Verdana.ttf"],
        (True, False):  ["verdanab.ttf", "Verdana Bold.ttf", "Verdana-Bold.ttf"],
        (False, True):  ["verdanai.ttf", "Verdana Italic.ttf"],
        (True, True):   ["verdanaz.ttf", "Verdana Bold Italic.ttf"],
    },
    "Georgia": {
        (False, False): ["georgia.ttf", "Georgia.ttf"],
        (True, False):  ["georgiab.ttf", "Georgia Bold.ttf", "Georgia-Bold.ttf"],
        (False, True):  ["georgiai.ttf", "Georgia Italic.ttf"],
        (True, True):   ["georgiaz.ttf", "Georgia Bold Italic.ttf"],
    },
    "Tahoma": {
        (False, False): ["tahoma.ttf", "Tahoma.ttf"],
        (True, False):  ["tahomabd.ttf", "Tahoma Bold.ttf", "Tahoma-Bold.ttf"],
        (False, True):  ["tahoma.ttf", "Tahoma.ttf"],
        (True, True):   ["tahomabd.ttf", "Tahoma Bold.ttf"],
    },
    "Trebuchet MS": {
        (False, False): ["trebuc.ttf", "Trebuchet MS.ttf", "TrebuchetMS.ttf"],
        (True, False):  ["trebucbd.ttf", "Trebuchet MS Bold.ttf"],
        (False, True):  ["trebucit.ttf", "Trebuchet MS Italic.ttf"],
        (True, True):   ["trebucbi.ttf", "Trebuchet MS Bold Italic.ttf"],
    },
    "Cambria": {
        (False, False): ["cambria.ttc", "Cambria.ttf"],
        (True, False):  ["cambriab.ttf", "Cambria-Bold.ttf"],
        (False, True):  ["cambriai.ttf", "Cambria-Italic.ttf"],
        (True, True):   ["cambriaz.ttf", "Cambria-BoldItalic.ttf"],
    },
    "Candara": {
        (False, False): ["Candara.ttf", "candara.ttf"],
        (True, False):  ["Candarab.ttf", "Candara-Bold.ttf"],
        (False, True):  ["Candarai.ttf", "Candara-Italic.ttf"],
        (True, True):   ["Candaraz.ttf", "Candara-BoldItalic.ttf"],
    },
    "Corbel": {
        (False, False): ["corbel.ttf", "Corbel.ttf"],
        (True, False):  ["corbelb.ttf", "Corbel-Bold.ttf"],
        (False, True):  ["corbeli.ttf", "Corbel-Italic.ttf"],
        (True, True):   ["corbelz.ttf", "Corbel-BoldItalic.ttf"],
    },
    "Impact": {
        (False, False): ["impact.ttf", "Impact.ttf"],
        (True, False):  ["impact.ttf", "Impact.ttf"],
        (False, True):  ["impact.ttf", "Impact.ttf"],
        (True, True):   ["impact.ttf", "Impact.ttf"],
    },
    "Consolas": {
        (False, False): ["consola.ttf", "Consolas.ttf"],
        (True, False):  ["consolab.ttf", "Consolas-Bold.ttf"],
        (False, True):  ["consolai.ttf", "Consolas-Italic.ttf"],
        (True, True):   ["consolaz.ttf", "Consolas-BoldItalic.ttf"],
    },
    # Cross-platform fallback fonts (Linux/macOS)
    "DejaVu Sans": {
        (False, False): ["DejaVuSans.ttf"],
        (True, False):  ["DejaVuSans-Bold.ttf"],
        (False, True):  ["DejaVuSans-Oblique.ttf"],
        (True, True):   ["DejaVuSans-BoldOblique.ttf"],
    },
    "Liberation Sans": {
        (False, False): ["LiberationSans-Regular.ttf"],
        (True, False):  ["LiberationSans-Bold.ttf"],
        (False, True):  ["LiberationSans-Italic.ttf"],
        (True, True):   ["LiberationSans-BoldItalic.ttf"],
    },
    "Noto Sans": {
        (False, False): ["NotoSans-Regular.ttf", "NotoSans[wdth,wght].ttf"],
        (True, False):  ["NotoSans-Bold.ttf"],
        (False, True):  ["NotoSans-Italic.ttf"],
        (True, True):   ["NotoSans-BoldItalic.ttf"],
    },
}

# Cache: resolved font paths so we don't scan dirs repeatedly
_font_path_cache = {}


def _find_font_file(family, bold=False, italic=False):
    """Find a font file on disk for the given family + style. Returns path or None."""
    key = (family, bold, italic)
    if key in _font_path_cache:
        return _font_path_cache[key]

    style_key = (bool(bold), bool(italic))
    filenames = _FONT_FILENAMES.get(family, {}).get(style_key, [])
    # Also try regular variant as fallback
    if not filenames:
        filenames = _FONT_FILENAMES.get(family, {}).get((False, False), [])

    font_dirs = _get_font_dirs()
    for font_dir in font_dirs:
        for fname in filenames:
            # Check direct path
            fp = font_dir / fname
            if fp.exists():
                _font_path_cache[key] = str(fp)
                return str(fp)
            # Search subdirectories (Linux organizes fonts in subdirs)
            for sub in font_dir.rglob(fname):
                _font_path_cache[key] = str(sub)
                return str(sub)

    _font_path_cache[key] = None
    return None


# Fallback chain: try these families in order if requested family not found
_FALLBACK_FAMILIES = ["Arial", "Liberation Sans", "DejaVu Sans", "Noto Sans"]


def _get_bake_font(size, bold=False, italic=False, family="Arial"):
    """Get a TrueType font matching family + style, with cross-platform fallback."""
    # Try requested family first
    fp = _find_font_file(family, bold, italic)
    if fp:
        try:
            return ImageFont.truetype(fp, size)
        except (OSError, IOError):
            pass

    # Try fallback families
    for fb_family in _FALLBACK_FAMILIES:
        if fb_family == family:
            continue
        fp = _find_font_file(fb_family, bold, italic)
        if fp:
            try:
                return ImageFont.truetype(fp, size)
            except (OSError, IOError):
                continue

    # Try any regular font from fallbacks (ignore bold/italic)
    for fb_family in _FALLBACK_FAMILIES:
        fp = _find_font_file(fb_family, False, False)
        if fp:
            try:
                return ImageFont.truetype(fp, size)
            except (OSError, IOError):
                continue

    return ImageFont.load_default()


def _wrap_text_lines(text, font, max_w):
    """Word-wrap text to fit within max_w pixels."""
    words = text.split(" ")
    lines = []
    line = ""
    for word in words:
        test = (line + " " + word).strip()
        bbox = font.getbbox(test)
        tw = (bbox[2] - bbox[0]) if bbox else 0
        if tw > max_w and line:
            lines.append(line)
            line = word
        else:
            line = test
    if line:
        lines.append(line)
    return lines


def _draw_chars_pillow(draw, text, x, y, font, fill, letter_spacing, scale):
    """Draw text character by character with letter spacing in Pillow."""
    cx = x
    ls_px = letter_spacing * scale
    for ch in text:
        draw.text((cx, y), ch, fill=fill, font=font)
        bbox = font.getbbox(ch)
        cw = (bbox[2] - bbox[0]) if bbox else 0
        cx += cw + ls_px


# ── Bake overlays into slide image ──────────────────────────────────────────

@app.route("/api/slide/<int:num>/bake", methods=["POST"])
def bake_overlays(num):
    """Burn overlays into the slide JPG image and clear them from data.
    This makes text edits permanent — the slide looks like the original
    but with changes baked in."""
    slide_files = _get_slide_files()
    if num < 1 or num > len(slide_files):
        return jsonify({"error": "Invalid slide"}), 400

    data = load_data()
    slide_data = data.get(str(num), {})
    ovs = slide_data.get("overlays", [])
    if not ovs:
        return jsonify({"ok": True, "msg": "No overlays to bake"})

    slide_path = slide_files[num - 1]
    img = Image.open(slide_path).convert("RGBA")
    w, h = img.size

    for ov in ovs:
        x = int(ov["x"] * w)
        y = int(ov["y"] * h)
        ow = int(ov["w"] * w)
        oh = int(ov["h"] * h)
        opacity = ov.get("opacity", 1)

        if ov["type"] == "rect":
            r, g, b = _parse_hex_color(ov.get("fillColor", "#2563EB"), (37, 99, 235))
            a = int(opacity * 255)
            layer = Image.new("RGBA", img.size, (0,0,0,0))
            ImageDraw.Draw(layer).rectangle([x, y, x+ow, y+oh], fill=(r,g,b,a))
            img = Image.alpha_composite(img, layer)

        elif ov["type"] == "text":
            draw = ImageDraw.Draw(img)
            bg = ov.get("bgColor", "transparent")
            if bg and bg != "transparent":
                cr, cg, cb = _parse_hex_color(bg)
                layer = Image.new("RGBA", img.size, (0,0,0,0))
                ImageDraw.Draw(layer).rectangle([x, y, x+ow, y+oh], fill=(cr,cg,cb,int(opacity*255)))
                img = Image.alpha_composite(img, layer)
                draw = ImageDraw.Draw(img)

            r, g, b = _parse_hex_color(ov.get("color", "#FFFFFF"), (255, 255, 255))
            raw_fs = ov.get("fontSize", 18)
            font_size = max(8, int(raw_fs * w / 933))
            is_bold = ov.get("bold", False)
            is_italic = ov.get("italic", False)
            font_family = ov.get("fontFamily", "Arial")
            font = _get_bake_font(font_size, is_bold, is_italic, font_family)

            text = ov.get("text", "")
            line_height_mul = ov.get("lineHeight", 1.3)
            letter_spacing = ov.get("letterSpacing", 0)
            text_transform = ov.get("textTransform", "none")
            list_style = ov.get("listStyle", "none")
            has_shadow = ov.get("shadow", False)
            shadow_color = _parse_hex_color(ov.get("shadowColor", "#000000"))
            has_outline = ov.get("outline", False)
            outline_color = _parse_hex_color(ov.get("outlineColor", "#000000"))
            outline_width = ov.get("outlineWidth", 1)
            has_underline = ov.get("underline", False)
            auto_fit = ov.get("autoFit", False)

            # Apply textTransform
            if text_transform == "uppercase":
                text = text.upper()
            elif text_transform == "lowercase":
                text = text.lower()
            elif text_transform == "capitalize":
                text = text.title()

            # Apply listStyle
            if list_style != "none":
                raw_lines = text.split("\n")
                new_lines = []
                for idx_l, ln in enumerate(raw_lines):
                    if list_style == "bullet":
                        new_lines.append("\u2022 " + ln)
                    elif list_style == "number":
                        new_lines.append(f"{idx_l+1}. " + ln)
                text = "\n".join(new_lines)

            lines = _wrap_text_lines(text, font, ow - 16)
            line_h = int(font_size * line_height_mul)

            # AutoFit: reduce font size until text fits
            if auto_fit:
                test_fs = font_size
                while test_fs > 8:
                    test_font = _get_bake_font(test_fs, is_bold, is_italic, font_family)
                    test_lines = _wrap_text_lines(text, test_font, ow - 16)
                    total_h = len(test_lines) * int(test_fs * line_height_mul) + 16
                    if total_h <= oh:
                        break
                    test_fs -= 1
                font_size = test_fs
                font = _get_bake_font(font_size, is_bold, is_italic, font_family)
                lines = _wrap_text_lines(text, font, ow - 16)
                line_h = int(font_size * line_height_mul)

            fill_color = (r, g, b, int(opacity*255))
            ty = y + 8
            align = ov.get("align", "left")

            sr, sg, sb = shadow_color if has_shadow else (0, 0, 0)
            olr, olg, olb = outline_color if has_outline else (0, 0, 0)

            for ln in lines:
                bbox = font.getbbox(ln)
                tw = (bbox[2] - bbox[0]) if bbox else 0
                if align == "center":
                    tx = x + (ow - tw) // 2
                elif align == "right":
                    tx = x + ow - tw - 8
                else:
                    tx = x + 8

                # Draw shadow (offset copy)
                if has_shadow:
                    if letter_spacing > 0:
                        _draw_chars_pillow(draw, ln, tx + 2, ty + 2, font, (sr, sg, sb, int(opacity*180)), letter_spacing, w / 933)
                    else:
                        draw.text((tx + 2, ty + 2), ln, fill=(sr, sg, sb, int(opacity*180)), font=font)

                # Draw outline (8-direction offset)
                if has_outline:
                    oc = (olr, olg, olb, int(opacity*255))
                    for odx in [-outline_width, 0, outline_width]:
                        for ody in [-outline_width, 0, outline_width]:
                            if odx == 0 and ody == 0:
                                continue
                            if letter_spacing > 0:
                                _draw_chars_pillow(draw, ln, tx + odx, ty + ody, font, oc, letter_spacing, w / 933)
                            else:
                                draw.text((tx + odx, ty + ody), ln, fill=oc, font=font)

                # Draw main text
                if letter_spacing > 0:
                    _draw_chars_pillow(draw, ln, tx, ty, font, fill_color, letter_spacing, w / 933)
                else:
                    draw.text((tx, ty), ln, fill=fill_color, font=font)

                # Draw underline
                if has_underline:
                    ul_y = ty + font_size + 2
                    draw.line([(tx, ul_y), (tx + tw, ul_y)], fill=fill_color, width=max(1, font_size // 14))

                ty += line_h

        elif ov["type"] == "image":
            src = ov.get("src", "")
            if src.startswith("data:"):
                img_data = base64.b64decode(src.split(",", 1)[1])
                overlay_img = Image.open(io.BytesIO(img_data)).convert("RGBA")
                overlay_img = overlay_img.resize((ow, oh), Image.BILINEAR)
                img.paste(overlay_img, (x, y), overlay_img)

    # Save back as RGB JPG
    img.convert("RGB").save(str(slide_path), "JPEG", quality=95)

    # Clear overlays from data (keep notes)
    data[str(num)] = {"overlays": [], "notes": slide_data.get("notes", "")}
    save_data(data)

    return jsonify({"ok": True})


# ── OCR Route ───────────────────────────────────────────────────────────────

@app.route("/api/ocr/<int:num>", methods=["POST"])
def ocr_slide(num):
    """Run EasyOCR on slide image, return detected text regions with bounding boxes."""
    if not HAS_OCR:
        return jsonify({"error": "EasyOCR is not installed. Run: pip install easyocr"}), 400

    slide_files = _get_slide_files()
    if num < 1 or num > len(slide_files):
        return jsonify({"error": "Invalid slide number"}), 400

    global _ocr_reader
    if _ocr_reader is None:
        _ocr_reader = easyocr.Reader(['en'], gpu=False, verbose=False)

    img_path = str(slide_files[num - 1])
    img = Image.open(img_path)
    w, h = img.size

    try:
        results = _ocr_reader.readtext(img_path)
    except Exception as e:
        return jsonify({"error": f"OCR failed: {e}"}), 500

    regions = []
    for (bbox, text, conf) in results:
        text = text.strip()
        if not text or conf < 0.3:
            continue
        # bbox is [[x1,y1],[x2,y2],[x3,y3],[x4,y4]] — take bounding rect
        xs = [p[0] for p in bbox]
        ys = [p[1] for p in bbox]
        x1, y1 = min(xs), min(ys)
        x2, y2 = max(xs), max(ys)
        regions.append({
            "text": text,
            "x": x1 / w,
            "y": y1 / h,
            "w": (x2 - x1) / w,
            "h": (y2 - y1) / h,
            "conf": round(conf * 100),
        })

    merged = _merge_ocr_regions(regions)
    return jsonify({"regions": merged, "raw_count": len(regions)})


def _merge_ocr_regions(regions):
    """Merge OCR word boxes on the same line into line-level regions."""
    if not regions:
        return []
    # Sort by Y then X
    regions.sort(key=lambda r: (round(r["y"], 2), r["x"]))
    merged = []
    current = None
    for r in regions:
        if current and abs(r["y"] - current["y"]) < 0.02 and r["x"] < current["x"] + current["w"] + 0.03:
            # Same line — extend
            new_right = max(current["x"] + current["w"], r["x"] + r["w"])
            current["w"] = new_right - current["x"]
            current["h"] = max(current["h"], r["h"])
            current["text"] += " " + r["text"]
        else:
            if current:
                merged.append(current)
            current = dict(r)
    if current:
        merged.append(current)
    return merged


# ── Sample background color route ───────────────────────────────────────────

@app.route("/api/sample-color/<int:num>", methods=["POST"])
def sample_color(num):
    """Sample BOTH background color and text color from a region.
    Background: sampled from a strip above the region.
    Text: darkest/lightest pixels inside the region (the ink)."""
    slide_files = _get_slide_files()
    if num < 1 or num > len(slide_files):
        return jsonify({"error": "Invalid slide number"}), 400

    payload = request.json
    img = Image.open(slide_files[num - 1]).convert("RGB")
    w, h = img.size

    x1 = int(payload["x"] * w)
    y1 = int(payload["y"] * h)
    x2 = int((payload["x"] + payload["w"]) * w)
    y2 = int((payload["y"] + payload["h"]) * h)
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(w, x2), min(h, y2)

    # --- Background color: strip ABOVE the region ---
    pad = 5
    sy1 = max(0, y1 - pad - 3)
    sy2 = max(0, y1 - pad)
    if sy2 <= sy1:
        sy1, sy2 = max(0, y1 - 2), y1
    strip = img.crop((x1, sy1, x2, max(sy2, sy1 + 1)))
    bg_px = strip.resize((1, 1), Image.BILINEAR).getpixel((0, 0))
    bg_hex = f"#{bg_px[0]:02x}{bg_px[1]:02x}{bg_px[2]:02x}"

    # --- Text color: find the most different pixels from bg inside the region ---
    region = img.crop((x1, y1, x2, y2))
    rw, rh = region.size
    bg_lum = 0.299 * bg_px[0] + 0.587 * bg_px[1] + 0.114 * bg_px[2]

    # Sample pixels on a grid and find the one furthest from bg luminance
    best_dist = 0
    text_color = (0, 0, 0) if bg_lum > 128 else (255, 255, 255)
    step = max(1, min(rw, rh) // 20)
    for sx in range(0, rw, step):
        for sy in range(0, rh, step):
            px = region.getpixel((sx, sy))
            lum = 0.299 * px[0] + 0.587 * px[1] + 0.114 * px[2]
            dist = abs(lum - bg_lum)
            if dist > best_dist:
                best_dist = dist
                text_color = px

    txt_hex = f"#{text_color[0]:02x}{text_color[1]:02x}{text_color[2]:02x}"

    # --- Detect font weight via ink density ---
    total_px = 0
    ink_px = 0
    for col in range(0, rw, max(1, rw // 60)):
        for row in range(rh):
            px = region.getpixel((col, row))
            lum = 0.299 * px[0] + 0.587 * px[1] + 0.114 * px[2]
            total_px += 1
            if abs(lum - bg_lum) > 80:
                ink_px += 1

    density = ink_px / max(1, total_px)
    # Bold text: >18% ink density. Normal: <14%
    if density > 0.22:
        font_weight = "extrabold"
    elif density > 0.17:
        font_weight = "bold"
    elif density > 0.13:
        font_weight = "semibold"
    else:
        font_weight = "normal"

    return jsonify({"color": bg_hex, "textColor": txt_hex, "fontWeight": font_weight})


# ── Image upload route ──────────────────────────────────────────────────────

@app.route("/api/upload-image", methods=["POST"])
def upload_image():
    """Accept an image file, return as base64 data URL."""
    if "file" not in request.files:
        return jsonify({"error": "No file"}), 400
    f = request.files["file"]
    try:
        img = Image.open(f.stream)
    except Exception:
        return jsonify({"error": "Invalid image file"}), 400
    if img.format and img.format not in ALLOWED_IMAGE_FORMATS:
        return jsonify({"error": f"Unsupported image format: {img.format}"}), 400
    img = img.convert("RGBA")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    b64 = base64.b64encode(buf.read()).decode()
    return jsonify({"src": f"data:image/png;base64,{b64}", "w": img.width, "h": img.height})


# ── Slide reorder route ─────────────────────────────────────────────────────

@app.route("/api/reorder", methods=["POST"])
def reorder_slides():
    """Reorder slide files on disk. Expects {"order": [3,1,2,...]}."""
    payload = request.json
    new_order = payload.get("order", [])
    slide_files = _get_slide_files()

    if sorted(new_order) != list(range(1, len(slide_files) + 1)):
        return jsonify({"error": "Invalid order"}), 400

    tmp_dir = SLIDES_DIR / "_reorder_tmp"
    tmp_dir.mkdir(exist_ok=True)

    # Copy to temp with new names
    for new_idx, old_idx in enumerate(new_order, 1):
        src = SLIDES_DIR / f"slide-{old_idx:02d}.jpg"
        dst = tmp_dir / f"slide-{new_idx:02d}.jpg"
        shutil.copy2(str(src), str(dst))

    # Move back
    for f in SLIDES_DIR.glob("slide-*.jpg"):
        f.unlink()
    for f in tmp_dir.glob("slide-*.jpg"):
        shutil.move(str(f), str(SLIDES_DIR / f.name))
    tmp_dir.rmdir()

    # Reorder saved data too
    data = load_data()
    new_data = {}
    for new_idx, old_idx in enumerate(new_order, 1):
        new_data[str(new_idx)] = data.get(str(old_idx), {"overlays": [], "notes": ""})
    save_data(new_data)

    return jsonify({"ok": True})


# ── PDF export route ────────────────────────────────────────────────────────

@app.route("/api/export-pdf", methods=["POST"])
def export_pdf():
    """Export slides as a multi-page PDF."""
    slide_files = _get_slide_files()
    if not slide_files:
        return jsonify({"error": "No slides to export"}), 400

    first_img = Image.open(slide_files[0]).convert("RGB")
    rest = (Image.open(sf).convert("RGB") for sf in slide_files[1:])

    import uuid
    out_path = EXPORT_DIR / f"Slides_Export_{uuid.uuid4().hex[:8]}.pdf"
    first_img.save(str(out_path), save_all=True, append_images=rest, resolution=150)

    return send_file(str(out_path), as_attachment=True, download_name="Slides_Export.pdf")


# ── Image overlay in PPTX export ───────────────────────────────────────────

def _add_overlay(slide, ov, slide_w, slide_h):
    """Add a text, rect, arrow, or image overlay to a slide."""
    kind = ov.get("type", "text")

    left   = int(ov["x"] * slide_w)
    top    = int(ov["y"] * slide_h)
    width  = int(ov["w"] * slide_w)
    height = int(ov["h"] * slide_h)

    if kind == "text":
        txBox = slide.shapes.add_textbox(left, top, width, height)
        tf = txBox.text_frame
        tf.word_wrap = True
        p = tf.paragraphs[0]
        run = p.add_run()
        run.text = ov.get("text", "")

        font = run.font
        font.size = Pt(ov.get("fontSize", 18))
        r, g, b = _parse_hex_color(ov.get("color", "#FFFFFF"), (255, 255, 255))
        font.color.rgb = RGBColor(r, g, b)
        font.bold   = ov.get("bold", False)
        font.italic = ov.get("italic", False)

        align_map = {"left": PP_ALIGN.LEFT, "center": PP_ALIGN.CENTER, "right": PP_ALIGN.RIGHT}
        p.alignment = align_map.get(ov.get("align","left"), PP_ALIGN.LEFT)

        bg_hex = ov.get("bgColor", "")
        if bg_hex and bg_hex != "transparent":
            br, bg_, bb = _parse_hex_color(bg_hex)
            fill = txBox.fill
            fill.solid()
            fill.fore_color.rgb = RGBColor(br, bg_, bb)

    elif kind == "rect":
        shape = slide.shapes.add_shape(1, left, top, width, height)
        r, g, b = _parse_hex_color(ov.get("fillColor", "#2563EB"), (37, 99, 235))
        shape.fill.solid()
        shape.fill.fore_color.rgb = RGBColor(r, g, b)
        shape.line.fill.background()

    elif kind == "image":
        src = ov.get("src", "")
        if src.startswith("data:"):
            img_data = base64.b64decode(src.split(",", 1)[1])
            img_stream = io.BytesIO(img_data)
            slide.shapes.add_picture(img_stream, left, top, width, height)

    elif kind == "arrow":
        line_shape = slide.shapes.add_connector(1, left, top, left+width, top+height)
        r, g, b = _parse_hex_color(ov.get("color", "#FF0000"), (255, 0, 0))
        line_shape.line.color.rgb = RGBColor(r, g, b)
        line_shape.line.width = Pt(2)


# ── Export as PNG ZIP ───────────────────────────────────────────────────────

@app.route("/api/export-png-zip", methods=["POST"])
def export_png_zip():
    """Export all slides as a ZIP of PNG images."""
    import zipfile
    slide_files = _get_slide_files()
    if not slide_files:
        return jsonify({"error": "No slides"}), 400

    import uuid
    zip_path = EXPORT_DIR / f"slides_export_{uuid.uuid4().hex[:8]}.zip"
    with zipfile.ZipFile(str(zip_path), 'w', zipfile.ZIP_DEFLATED) as zf:
        for sf in slide_files:
            img = Image.open(sf).convert("RGB")
            png_buf = io.BytesIO()
            img.save(png_buf, format="PNG")
            png_buf.seek(0)
            zf.writestr(sf.stem + ".png", png_buf.read())

    return send_file(str(zip_path), as_attachment=True, download_name="slides_export.zip")


# ── Export as GIF ───────────────────────────────────────────────────────────

@app.route("/api/export-gif", methods=["POST"])
def export_gif():
    """Export slides as an animated GIF slideshow."""
    payload = request.json or {}
    duration_ms = int(payload.get("duration", 2000))  # ms per slide

    slide_files = _get_slide_files()
    if not slide_files:
        return jsonify({"error": "No slides"}), 400

    frames = []
    for sf in slide_files:
        img = Image.open(sf).convert("RGB")
        img = img.resize((800, 450), Image.BILINEAR)
        frames.append(img)

    import uuid as _uuid
    gif_path = EXPORT_DIR / f"slides_export_{_uuid.uuid4().hex[:8]}.gif"
    frames[0].save(str(gif_path), save_all=True, append_images=frames[1:],
                   duration=duration_ms, loop=0, optimize=True)

    return send_file(str(gif_path), as_attachment=True, download_name="slides_export.gif")


# ── Image Filters ───────────────────────────────────────────────────────────

@app.route("/api/slide/<int:num>/filter", methods=["POST"])
def apply_filter(num):
    """Apply image filter to a slide. Filters: brightness, contrast, blur, grayscale, sepia."""
    from PIL import ImageEnhance, ImageFilter as PilFilter

    slide_files = _get_slide_files()
    if num < 1 or num > len(slide_files):
        return jsonify({"error": "Invalid slide"}), 400

    payload = request.json
    filter_type = payload.get("filter", "")
    value = float(payload.get("value", 1.0))

    img = Image.open(slide_files[num - 1]).convert("RGB")

    if filter_type == "brightness":
        img = ImageEnhance.Brightness(img).enhance(value)
    elif filter_type == "contrast":
        img = ImageEnhance.Contrast(img).enhance(value)
    elif filter_type == "saturation":
        img = ImageEnhance.Color(img).enhance(value)
    elif filter_type == "blur":
        img = img.filter(PilFilter.GaussianBlur(radius=value))
    elif filter_type == "sharpen":
        img = ImageEnhance.Sharpness(img).enhance(value)
    elif filter_type == "grayscale":
        import cv2, numpy as np
        arr = np.array(img)
        gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
        img = Image.fromarray(cv2.cvtColor(gray, cv2.COLOR_GRAY2RGB))
    elif filter_type == "sepia":
        import numpy as np
        arr = np.array(img, dtype=np.float64)
        sepia_filter = np.array([[0.393, 0.769, 0.189],
                                  [0.349, 0.686, 0.168],
                                  [0.272, 0.534, 0.131]])
        sepia = arr @ sepia_filter.T
        sepia = np.clip(sepia, 0, 255).astype(np.uint8)
        img = Image.fromarray(sepia)
    else:
        return jsonify({"error": f"Unknown filter: {filter_type}"}), 400

    img.save(str(slide_files[num - 1]), quality=95)
    return jsonify({"ok": True})


# ── Crop / Rotate Slide ─────────────────────────────────────────────────────

@app.route("/api/slide/<int:num>/crop", methods=["POST"])
def crop_slide(num):
    """Crop a slide image. Expects normalized coords {x, y, w, h}."""
    slide_files = _get_slide_files()
    if num < 1 or num > len(slide_files):
        return jsonify({"error": "Invalid slide"}), 400

    payload = request.json
    img = Image.open(slide_files[num - 1]).convert("RGB")
    w, h = img.size
    x1 = int(payload["x"] * w)
    y1 = int(payload["y"] * h)
    x2 = int((payload["x"] + payload["w"]) * w)
    y2 = int((payload["y"] + payload["h"]) * h)
    img = img.crop((x1, y1, x2, y2))
    # Resize back to standard dimensions
    img = img.resize((SLIDE_W_PX, SLIDE_H_PX), Image.LANCZOS)
    img.save(str(slide_files[num - 1]), quality=95)
    return jsonify({"ok": True})


@app.route("/api/slide/<int:num>/rotate", methods=["POST"])
def rotate_slide(num):
    """Rotate a slide image. Expects {angle: 90/180/270}."""
    slide_files = _get_slide_files()
    if num < 1 or num > len(slide_files):
        return jsonify({"error": "Invalid slide"}), 400

    angle = int(request.json.get("angle", 90))
    img = Image.open(slide_files[num - 1]).convert("RGB")
    img = img.rotate(-angle, expand=True)
    img = img.resize((SLIDE_W_PX, SLIDE_H_PX), Image.LANCZOS)
    img.save(str(slide_files[num - 1]), quality=95)
    return jsonify({"ok": True})


# ── QR Code Generation ──────────────────────────────────────────────────────

@app.route("/api/qr-generate", methods=["POST"])
def generate_qr():
    """Generate a QR code as base64 PNG. Requires 'url' in payload."""
    payload = request.json
    url = payload.get("url", "")
    if not url:
        return jsonify({"error": "No URL provided"}), 400

    try:
        import qrcode
        qr = qrcode.make(url)
        buf = io.BytesIO()
        qr.save(buf, format="PNG")
    except ImportError:
        # Fallback: generate simple QR-like placeholder
        img = Image.new("RGB", (200, 200), "white")
        draw = ImageDraw.Draw(img)
        draw.rectangle([10, 10, 190, 190], outline="black", width=3)
        draw.text((40, 90), "QR", fill="black")
        buf = io.BytesIO()
        img.save(buf, format="PNG")

    buf.seek(0)
    b64 = base64.b64encode(buf.read()).decode()
    return jsonify({"src": f"data:image/png;base64,{b64}"})


# ── Custom Watermark ────────────────────────────────────────────────────────

@app.route("/api/watermark", methods=["POST"])
def add_watermark():
    """Add a text or image watermark to all slides."""
    payload = request.json
    wm_type = payload.get("type", "text")  # "text" or "image"
    wm_text = payload.get("text", "CONFIDENTIAL")
    wm_opacity = float(payload.get("opacity", 0.15))
    wm_position = payload.get("position", "center")  # center, bottom-right, tiled

    slide_files = _get_slide_files()

    for sf in slide_files:
        img = Image.open(sf).convert("RGBA")
        w, h = img.size

        if wm_type == "text":
            overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
            draw = ImageDraw.Draw(overlay)
            font_size = w // 15
            font = _get_bake_font(font_size, bold=True, family="Arial")

            alpha = int(wm_opacity * 255)

            if wm_position == "tiled":
                bbox = font.getbbox(wm_text)
                tw = bbox[2] - bbox[0]
                th = bbox[3] - bbox[1]
                for tx in range(0, w, tw + 100):
                    for ty in range(0, h, th + 80):
                        draw.text((tx, ty), wm_text, fill=(128, 128, 128, alpha), font=font)
            elif wm_position == "center":
                bbox = font.getbbox(wm_text)
                tw = bbox[2] - bbox[0]
                th = bbox[3] - bbox[1]
                draw.text(((w - tw) // 2, (h - th) // 2), wm_text, fill=(128, 128, 128, alpha), font=font)
            elif wm_position == "bottom-right":
                bbox = font.getbbox(wm_text)
                tw = bbox[2] - bbox[0]
                th = bbox[3] - bbox[1]
                draw.text((w - tw - 20, h - th - 20), wm_text, fill=(128, 128, 128, alpha), font=font)

            img = Image.alpha_composite(img, overlay)

        img.convert("RGB").save(str(sf), quality=95)

    return jsonify({"ok": True})


# ── Watermark Detection ─────────────────────────────────────────────────────

@app.route("/api/detect-watermark/<int:num>", methods=["POST"])
def detect_watermark(num):
    """Auto-detect watermark/logo regions in a slide using edge + contour analysis.
    Returns candidate regions with positions and confidence scores."""
    import cv2
    import numpy as np

    slide_files = _get_slide_files()
    if num < 1 or num > len(slide_files):
        return jsonify({"error": "Invalid slide"}), 400

    img = cv2.imread(str(slide_files[num - 1]))
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    candidates = []

    # Strategy 1: Check all 4 corners for small text/logo regions
    corners = {
        "bottom-right": (int(w*0.7), int(h*0.85), w, h),
        "bottom-left":  (0, int(h*0.85), int(w*0.3), h),
        "top-right":    (int(w*0.7), 0, w, int(h*0.15)),
        "top-left":     (0, 0, int(w*0.3), int(h*0.15)),
    }

    for corner_name, (x1, y1, x2, y2) in corners.items():
        roi = gray[y1:y2, x1:x2]
        edges = cv2.Canny(roi, 50, 150)
        rh, rw = roi.shape
        edge_density = np.sum(edges > 0) / max(1, rh * rw)

        # Watermarks typically have moderate edge density (text/logos)
        if 0.02 < edge_density < 0.4:
            # Find contours to get tighter bounding box
            contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if contours:
                # Get bounding rect of all contours combined
                all_pts = np.vstack(contours)
                bx, by, bw, bh = cv2.boundingRect(all_pts)
                # Convert to absolute coords, then normalize
                abs_x = (x1 + bx) / w
                abs_y = (y1 + by) / h
                abs_w = bw / w
                abs_h = bh / h
                # Add padding
                pad = 0.01
                abs_x = max(0, abs_x - pad)
                abs_y = max(0, abs_y - pad)
                abs_w = min(1 - abs_x, abs_w + pad * 2)
                abs_h = min(1 - abs_y, abs_h + pad * 2)

                candidates.append({
                    "location": corner_name,
                    "x": round(abs_x, 4),
                    "y": round(abs_y, 4),
                    "w": round(abs_w, 4),
                    "h": round(abs_h, 4),
                    "confidence": round(edge_density * 100, 1),
                })

    # Strategy 2: Look for semi-transparent overlays (watermarks) across the whole image
    # Check for low-contrast repeated patterns
    laplacian = cv2.Laplacian(gray, cv2.CV_64F)
    lap_std = laplacian.std()
    if lap_std < 15:  # Very uniform image — possible full-screen watermark
        candidates.append({
            "location": "full-image",
            "x": 0, "y": 0, "w": 1, "h": 1,
            "confidence": round((20 - lap_std) * 5, 1),
            "note": "Possible full-image watermark detected"
        })

    # Sort by confidence descending
    candidates.sort(key=lambda c: c["confidence"], reverse=True)

    return jsonify({"candidates": candidates})


@app.route("/api/remove-watermark/<int:num>", methods=["POST"])
def remove_watermark(num):
    """Remove a specific watermark region from a slide using inpainting."""
    import cv2
    import numpy as np

    slide_files = _get_slide_files()
    if num < 1 or num > len(slide_files):
        return jsonify({"error": "Invalid slide"}), 400

    payload = request.json
    regions = payload.get("regions", [])
    if not regions:
        return jsonify({"error": "No regions specified"}), 400

    img = cv2.imread(str(slide_files[num - 1]))
    h, w = img.shape[:2]

    mask = np.zeros((h, w), dtype=np.uint8)
    for r in regions:
        x1 = int(r["x"] * w)
        y1 = int(r["y"] * h)
        x2 = int((r["x"] + r["w"]) * w)
        y2 = int((r["y"] + r["h"]) * h)
        mask[y1:y2, x1:x2] = 255

    result = cv2.inpaint(img, mask, inpaintRadius=5, flags=cv2.INPAINT_TELEA)
    cv2.imwrite(str(slide_files[num - 1]), result, [cv2.IMWRITE_JPEG_QUALITY, 95])

    return jsonify({"ok": True})


@app.route("/api/remove-watermark-all", methods=["POST"])
def remove_watermark_all():
    """Remove watermark from ALL slides at the same region."""
    import cv2
    import numpy as np

    payload = request.json
    regions = payload.get("regions", [])
    if not regions:
        return jsonify({"error": "No regions specified"}), 400

    slide_files = _get_slide_files()
    count = 0
    for sf in slide_files:
        img = cv2.imread(str(sf))
        h, w = img.shape[:2]
        mask = np.zeros((h, w), dtype=np.uint8)
        for r in regions:
            x1 = int(r["x"] * w)
            y1 = int(r["y"] * h)
            x2 = int((r["x"] + r["w"]) * w)
            y2 = int((r["y"] + r["h"]) * h)
            mask[y1:y2, x1:x2] = 255
        result = cv2.inpaint(img, mask, inpaintRadius=5, flags=cv2.INPAINT_TELEA)
        cv2.imwrite(str(sf), result, [cv2.IMWRITE_JPEG_QUALITY, 95])
        count += 1

    return jsonify({"ok": True, "slides": count})


# ── Custom Watermark (Image) ───────────────────────────────────────────────

@app.route("/api/watermark-image", methods=["POST"])
def add_image_watermark():
    """Add an image watermark (logo) to all slides."""
    if "image" not in request.files:
        return jsonify({"error": "No image uploaded"}), 400

    wm_img = Image.open(request.files["image"].stream).convert("RGBA")
    wm_opacity = float(request.form.get("opacity", 0.3))
    wm_position = request.form.get("position", "bottom-right")
    wm_scale = float(request.form.get("scale", 0.15))  # % of slide width

    slide_files = _get_slide_files()
    for sf in slide_files:
        img = Image.open(sf).convert("RGBA")
        w, h = img.size

        # Scale watermark
        wm_w = int(w * wm_scale)
        wm_h = int(wm_w * wm_img.height / wm_img.width)
        wm_resized = wm_img.resize((wm_w, wm_h), Image.LANCZOS)

        # Apply opacity
        r, g, b, a = wm_resized.split()
        import numpy as np
        a_arr = np.array(a).astype(float) * wm_opacity
        a = Image.fromarray(a_arr.astype(np.uint8))
        wm_resized = Image.merge("RGBA", (r, g, b, a))

        # Position
        if wm_position == "center":
            pos = ((w - wm_w) // 2, (h - wm_h) // 2)
        elif wm_position == "top-left":
            pos = (20, 20)
        elif wm_position == "top-right":
            pos = (w - wm_w - 20, 20)
        elif wm_position == "bottom-left":
            pos = (20, h - wm_h - 20)
        elif wm_position == "tiled":
            # Tile across entire image
            overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
            for tx in range(0, w, wm_w + 60):
                for ty in range(0, h, wm_h + 40):
                    overlay.paste(wm_resized, (tx, ty), wm_resized)
            img = Image.alpha_composite(img, overlay)
            img.convert("RGB").save(str(sf), quality=95)
            continue
        else:  # bottom-right
            pos = (w - wm_w - 20, h - wm_h - 20)

        img.paste(wm_resized, pos, wm_resized)
        img.convert("RGB").save(str(sf), quality=95)

    return jsonify({"ok": True})


# ── Batch Processing ────────────────────────────────────────────────────────

@app.route("/api/batch/upload", methods=["POST"])
def batch_upload():
    """Upload multiple PPTX files for batch processing."""
    files = request.files.getlist("files")
    if not files:
        return jsonify({"error": "No files"}), 400

    UPLOAD_DIR.mkdir(exist_ok=True)
    filenames = []
    for f in files:
        if f.filename.lower().endswith(".pptx"):
            fname = secure_filename(f.filename)
            f.save(str(UPLOAD_DIR / fname))
            filenames.append(fname)

    return jsonify({"ok": True, "files": filenames, "count": len(filenames)})


@app.route("/api/batch/process", methods=["POST"])
def batch_process():
    """Process a batch of uploaded PPTX files — remove logos from all.
    WARNING: Each file replaces current slides. Only the last file's slides remain."""
    payload = request.json
    filenames = payload.get("files", [])
    results = []

    for fname in filenames:
        fpath = UPLOAD_DIR / secure_filename(fname)
        if not fpath.exists():
            results.append({"file": fname, "status": "not_found"})
            continue
        try:
            process_uploaded_pptx(fpath)
            results.append({"file": fname, "status": "ok", "slides": len(_get_slide_files())})
        except Exception as e:
            results.append({"file": fname, "status": "error", "error": str(e)})

    return jsonify({"ok": True, "results": results})


# ── Templates ───────────────────────────────────────────────────────────────

TEMPLATES_DIR = BASE_DIR / "templates_saved"
TEMPLATES_DIR.mkdir(exist_ok=True)


@app.route("/api/templates", methods=["GET"])
def list_templates():
    """List saved slide templates."""
    templates = []
    for tf in sorted(TEMPLATES_DIR.glob("*.json")):
        data = json.loads(tf.read_text())
        templates.append({"name": tf.stem, "slides": data.get("slide_count", 0),
                          "created": data.get("created", "")})
    return jsonify({"templates": templates})


@app.route("/api/templates/save", methods=["POST"])
def save_template():
    """Save current slides + overlays as a named template."""
    payload = request.json
    name = secure_filename(payload.get("name", "untitled"))
    if not name:
        return jsonify({"error": "No template name specified"}), 400

    slide_files = _get_slide_files()
    data = load_data()

    # Copy slide images to template dir
    tpl_dir = TEMPLATES_DIR / name
    tpl_dir.mkdir(exist_ok=True)
    for sf in slide_files:
        shutil.copy2(str(sf), str(tpl_dir / sf.name))

    # Save overlay data
    import datetime
    meta = {"slide_count": len(slide_files), "data": data,
            "created": datetime.datetime.now().isoformat()}
    (TEMPLATES_DIR / f"{name}.json").write_text(json.dumps(meta, indent=2))

    return jsonify({"ok": True, "name": name})


@app.route("/api/templates/load", methods=["POST"])
def load_template():
    """Load a template — restore slide images + overlays."""
    payload = request.json
    name = secure_filename(payload.get("name", ""))
    if not name:
        return jsonify({"error": "No template name specified"}), 400

    tpl_dir = TEMPLATES_DIR / name
    meta_file = TEMPLATES_DIR / f"{name}.json"

    if not meta_file.exists():
        return jsonify({"error": "Template not found"}), 404

    # Clear current slides
    for f in SLIDES_DIR.glob("slide-*.jpg"):
        f.unlink()

    # Copy template slides
    for sf in sorted(tpl_dir.glob("slide-*.jpg")):
        shutil.copy2(str(sf), str(SLIDES_DIR / sf.name))

    # Restore overlay data
    meta = json.loads(meta_file.read_text())
    save_data(meta.get("data", {}))

    return jsonify({"ok": True, "slides": len(_get_slide_files())})


@app.route("/api/templates/delete", methods=["POST"])
def delete_template():
    """Delete a saved template."""
    name = secure_filename(request.json.get("name", ""))
    if not name:
        return jsonify({"error": "No template name specified"}), 400
    tpl_dir = TEMPLATES_DIR / name
    meta_file = TEMPLATES_DIR / f"{name}.json"
    if tpl_dir.exists() and tpl_dir != TEMPLATES_DIR:
        shutil.rmtree(str(tpl_dir))
    meta_file.unlink(missing_ok=True)
    return jsonify({"ok": True})


# ── Version History ─────────────────────────────────────────────────────────

HISTORY_DIR = BASE_DIR / "history"
HISTORY_DIR.mkdir(exist_ok=True)


@app.route("/api/history/save", methods=["POST"])
def save_version():
    """Save a snapshot of current slide state."""
    import datetime
    import uuid
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S") + f"_{uuid.uuid4().hex[:4]}"
    version_dir = HISTORY_DIR / ts

    version_dir.mkdir(exist_ok=True)
    for sf in _get_slide_files():
        shutil.copy2(str(sf), str(version_dir / sf.name))

    data = load_data()
    (version_dir / "data.json").write_text(json.dumps(data, indent=2))

    return jsonify({"ok": True, "version": ts})


@app.route("/api/history", methods=["GET"])
def list_versions():
    """List all saved versions."""
    versions = []
    for vd in sorted(HISTORY_DIR.iterdir(), reverse=True):
        if vd.is_dir():
            slides = len(list(vd.glob("slide-*.jpg")))
            versions.append({"version": vd.name, "slides": slides})
    return jsonify({"versions": versions})


@app.route("/api/history/restore", methods=["POST"])
def restore_version():
    """Restore a previous version."""
    version = secure_filename(request.json.get("version", "") or request.json.get("name", ""))
    if not version:
        return jsonify({"error": "No version specified"}), 400
    version_dir = HISTORY_DIR / version
    if not version_dir.exists() or version_dir == HISTORY_DIR:
        return jsonify({"error": "Version not found"}), 404

    for f in SLIDES_DIR.glob("slide-*.jpg"):
        f.unlink()
    for sf in sorted(version_dir.glob("slide-*.jpg")):
        shutil.copy2(str(sf), str(SLIDES_DIR / sf.name))

    data_file = version_dir / "data.json"
    if data_file.exists():
        save_data(json.loads(data_file.read_text()))

    return jsonify({"ok": True, "slides": len(_get_slide_files())})


# ── Comments / Annotations ──────────────────────────────────────────────────

COMMENTS_FILE = BASE_DIR / "comments.json"


def _load_comments():
    with _data_lock:
        if COMMENTS_FILE.exists():
            return json.loads(COMMENTS_FILE.read_text())
        return {}


def _save_comments(data):
    with _data_lock:
        COMMENTS_FILE.write_text(json.dumps(data, indent=2))


@app.route("/api/comments/<int:num>", methods=["GET"])
def get_comments(num):
    data = _load_comments()
    return jsonify({"comments": data.get(str(num), [])})


@app.route("/api/comments/<int:num>", methods=["POST"])
def add_comment(num):
    payload = request.json
    data = _load_comments()
    import datetime
    comment = {
        "text": payload.get("text", ""),
        "x": payload.get("x", 0.5),
        "y": payload.get("y", 0.5),
        "author": payload.get("author", "User"),
        "timestamp": datetime.datetime.now().isoformat(),
        "resolved": False,
    }
    data.setdefault(str(num), []).append(comment)
    _save_comments(data)
    return jsonify({"ok": True, "comment": comment})


@app.route("/api/comments/<int:num>/resolve", methods=["POST"])
def resolve_comment(num):
    idx = int(request.json.get("index", 0))
    data = _load_comments()
    comments = data.get(str(num), [])
    if 0 <= idx < len(comments):
        comments[idx]["resolved"] = True
        _save_comments(data)
    return jsonify({"ok": True})


@app.route("/api/comments/<int:num>/delete", methods=["POST"])
def delete_comment(num):
    idx = int(request.json.get("index", 0))
    data = _load_comments()
    comments = data.get(str(num), [])
    if 0 <= idx < len(comments):
        comments.pop(idx)
        _save_comments(data)
    return jsonify({"ok": True})


# ── Find & Replace ──────────────────────────────────────────────────────────

@app.route("/api/find-replace", methods=["POST"])
def find_replace():
    """Find and replace text in overlays across all slides."""
    payload = request.json
    find_text = payload.get("find", "")
    replace_text = payload.get("replace", "")
    if not find_text:
        return jsonify({"error": "No search text"}), 400

    data = load_data()
    count = 0
    for slide_num, slide_data in data.items():
        for ov in slide_data.get("overlays", []):
            if ov.get("type") == "text" and find_text in ov.get("text", ""):
                ov["text"] = ov["text"].replace(find_text, replace_text)
                count += 1
    save_data(data)
    return jsonify({"ok": True, "replacements": count})


# ── Video Trim ──────────────────────────────────────────────────────────────

@app.route("/api/video/trim", methods=["POST"])
def trim_video():
    """Trim a video to start/end times (in seconds)."""
    payload = request.json
    fname = payload.get("filename", "")
    start = float(payload.get("start", 0))
    end = float(payload.get("end", 0))

    video_path = VIDEO_DIR / secure_filename(fname)
    if not video_path.exists():
        return jsonify({"error": "Video not found"}), 400

    try:
        from moviepy import VideoFileClip
        clip = VideoFileClip(str(video_path))
        if end <= 0 or end > clip.duration:
            end = clip.duration
        trimmed = clip.subclipped(start, end)
        out_name = f"trimmed_{secure_filename(fname)}"
        if not out_name.lower().endswith('.mp4'):
            out_name = out_name.rsplit('.', 1)[0] + '.mp4'
        out_path = VIDEO_DIR / out_name
        trimmed.write_videofile(str(out_path), codec='libx264', audio_codec='aac', logger=None)
        trimmed.close()
        clip.close()
        return jsonify({"ok": True, "output": out_name, "duration": round(end - start, 1)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Auto Logo Detection in Video ────────────────────────────────────────────

@app.route("/api/video/detect-logo", methods=["POST"])
def detect_video_logo():
    """Try to auto-detect logo position in a video frame using edge/contour analysis."""
    import cv2
    import numpy as np

    payload = request.json
    fname = payload.get("filename", "")
    video_path = VIDEO_DIR / secure_filename(fname)
    if not video_path.exists():
        return jsonify({"error": "Video not found"}), 400

    cap = cv2.VideoCapture(str(video_path))
    cap.set(cv2.CAP_PROP_POS_FRAMES, min(30, int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) - 1))
    ret, frame = cap.read()
    cap.release()

    if not ret or frame is None:
        return jsonify({"error": "Cannot read frame from video"}), 500
    h, w = frame.shape[:2]

    # Look for small, consistent elements in corners (typical logo locations)
    # Check bottom-right quadrant for text-like regions
    corners = [
        ("bottom-right", frame[int(h*0.85):, int(w*0.7):]),
        ("bottom-left",  frame[int(h*0.85):, :int(w*0.3)]),
        ("top-right",    frame[:int(h*0.15), int(w*0.7):]),
        ("top-left",     frame[:int(h*0.15), :int(w*0.3)]),
    ]

    best = None
    best_score = 0

    for corner_name, roi in corners:
        gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
        edges = cv2.Canny(gray, 50, 150)
        score = np.sum(edges > 0)
        rh, rw = roi.shape[:2]
        density = score / max(1, rh * rw)

        if density > 0.02 and density < 0.5 and score > best_score:
            best_score = score
            if corner_name == "bottom-right":
                best = {"x": 0.7, "y": 0.85, "w": 0.3, "h": 0.15}
            elif corner_name == "bottom-left":
                best = {"x": 0.0, "y": 0.85, "w": 0.3, "h": 0.15}
            elif corner_name == "top-right":
                best = {"x": 0.7, "y": 0.0, "w": 0.3, "h": 0.15}
            elif corner_name == "top-left":
                best = {"x": 0.0, "y": 0.0, "w": 0.3, "h": 0.15}

    if not best:
        best = {"x": 0.85, "y": 0.92, "w": 0.14, "h": 0.07}  # default bottom-right

    return jsonify({"ok": True, "region": best})


# ── Replace Logo (swap with custom image) ──────────────────────────────────

@app.route("/api/video/replace-logo", methods=["POST"])
def replace_video_logo():
    """Replace logo in video with a custom image overlay. Returns jobId for polling."""
    if "logo" not in request.files:
        return jsonify({"error": "No logo image"}), 400

    logo_file = request.files["logo"]
    fname = request.form.get("filename", "")
    lx = float(request.form.get("x", 0.85))
    ly = float(request.form.get("y", 0.93))
    lw_pct = float(request.form.get("w", 0.14))
    lh_pct = float(request.form.get("h", 0.06))

    video_path = VIDEO_DIR / secure_filename(fname)
    if not video_path.exists():
        return jsonify({"error": "Video not found"}), 400

    # Read logo image into memory before thread starts (stream won't be available later)
    logo_img = Image.open(logo_file.stream).convert("RGBA")

    _cleanup_video_jobs()
    job_id = f"replace_{int(_time.time()*1000)}"
    _video_jobs[job_id] = {"status": "starting", "progress": 0, "total": 0, "eta": 0, "output": "", "error": "", "created_at": _time.time()}

    t = threading.Thread(target=_run_logo_replace, args=(job_id, video_path, fname, lx, ly, lw_pct, lh_pct, logo_img), daemon=True)
    t.start()

    return jsonify({"ok": True, "jobId": job_id})


def _run_logo_replace(job_id, video_path, fname, lx, ly, lw_pct, lh_pct, logo_img):
    """Background worker for video logo replacement."""
    import cv2
    import numpy as np

    job = _video_jobs[job_id]
    job["status"] = "processing"

    try:
        cap = cv2.VideoCapture(str(video_path))
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = cap.get(cv2.CAP_PROP_FPS)
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        job["total"] = total

        x1, y1 = int(lx * w), int(ly * h)
        x2, y2 = min(w, int((lx + lw_pct) * w)), min(h, int((ly + lh_pct) * h))
        logo_w, logo_h = x2 - x1, y2 - y1

        logo_resized = logo_img.resize((logo_w, logo_h), Image.LANCZOS)
        logo_arr = np.array(logo_resized)

        if logo_arr.shape[2] == 4:
            logo_rgb = logo_arr[:, :, :3]
            logo_alpha = logo_arr[:, :, 3:] / 255.0
        else:
            logo_rgb = logo_arr
            logo_alpha = np.ones((logo_h, logo_w, 1))

        logo_bgr = logo_rgb[:, :, ::-1]

        out_name = f"branded_{secure_filename(fname)}"
        if not out_name.lower().endswith('.mp4'):
            out_name = out_name.rsplit('.', 1)[0] + '.mp4'
        temp_path = VIDEO_DIR / f"_temp_{out_name}"
        out_path = VIDEO_DIR / out_name

        fourcc = cv2.VideoWriter_fourcc(*'mp4v')
        writer = cv2.VideoWriter(str(temp_path), fourcc, fps, (w, h))

        frame_num = 0
        start_time = _time.time()

        while True:
            ret, frame = cap.read()
            if not ret:
                break
            if job.get("cancel"):
                job["status"] = "cancelled"
                break

            roi = frame[y1:y2, x1:x2].astype(np.float64)
            blended = roi * (1 - logo_alpha) + logo_bgr.astype(np.float64) * logo_alpha
            frame[y1:y2, x1:x2] = blended.astype(np.uint8)
            writer.write(frame)
            frame_num += 1

            if frame_num % 10 == 0:
                elapsed = _time.time() - start_time
                fps_actual = frame_num / max(0.1, elapsed)
                job["progress"] = frame_num
                job["eta"] = round((total - frame_num) / max(1, fps_actual), 1)

        cap.release()
        writer.release()

        if job.get("cancel"):
            temp_path.unlink(missing_ok=True)
            job["eta"] = 0
            return

        # Mux audio
        job["status"] = "muxing_audio"
        try:
            from moviepy import VideoFileClip
            original = VideoFileClip(str(video_path))
            clean = VideoFileClip(str(temp_path))
            if original.audio is not None:
                final = clean.with_audio(original.audio)
                final.write_videofile(str(out_path), codec='libx264', audio_codec='aac', logger=None)
                final.close()
            else:
                clean.write_videofile(str(out_path), codec='libx264', logger=None)
            original.close()
            clean.close()
            temp_path.unlink(missing_ok=True)
        except Exception:
            if temp_path.exists():
                shutil.move(str(temp_path), str(out_path))

        job["status"] = "done"
        job["progress"] = total
        job["output"] = out_name
        job["eta"] = 0

    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e)


# ── Batch Video Processing ──────────────────────────────────────────────────

@app.route("/api/video/batch-upload", methods=["POST"])
def batch_video_upload():
    """Upload multiple video files."""
    files = request.files.getlist("files")
    filenames = []
    for f in files:
        fname = secure_filename(f.filename)
        if fname and Path(fname).suffix.lower() in ALLOWED_VIDEO_EXTS:
            f.save(str(VIDEO_DIR / fname))
            filenames.append(fname)
    return jsonify({"ok": True, "files": filenames})


# ── Video Logo Removal ──────────────────────────────────────────────────────

@app.route("/video")
def video_page():
    return render_template("video.html")


@app.route("/api/video/upload", methods=["POST"])
def upload_video():
    """Upload a video file for logo removal."""
    if "file" not in request.files:
        return jsonify({"error": "No file"}), 400
    f = request.files["file"]
    fname = secure_filename(f.filename)
    if not fname:
        return jsonify({"error": "Invalid filename"}), 400
    ext = Path(fname).suffix.lower()
    if ext not in ALLOWED_VIDEO_EXTS:
        return jsonify({"error": f"Unsupported video format: {ext}. Allowed: {', '.join(ALLOWED_VIDEO_EXTS)}"}), 400

    save_path = VIDEO_DIR / fname
    f.save(str(save_path))
    return jsonify({"ok": True, "filename": fname})


@app.route("/api/video/preview-frame", methods=["POST"])
def video_preview_frame():
    """Get a frame from the video + detect logo region."""
    payload = request.json
    fname = payload.get("filename", "")
    video_path = VIDEO_DIR / secure_filename(fname)
    if not video_path.exists():
        return jsonify({"error": "Video not found"}), 400

    import cv2
    cap = cv2.VideoCapture(str(video_path))
    cap.set(cv2.CAP_PROP_POS_FRAMES, 30)  # grab frame 30
    ret, frame = cap.read()
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = total / fps if fps > 0 else 0
    cap.release()

    if not ret:
        return jsonify({"error": "Could not read video frame"}), 500

    # Convert frame to base64 JPEG
    _, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
    b64 = base64.b64encode(buf.tobytes()).decode()

    return jsonify({
        "frame": f"data:image/jpeg;base64,{b64}",
        "width": w, "height": h,
        "fps": fps, "duration": round(duration, 1),
        "totalFrames": total
    })


import time as _time

_video_jobs = {}  # job_id → {status, progress, total, eta, output, error, created_at}
_VIDEO_JOB_MAX_AGE = 3600  # expire jobs after 1 hour


def _cleanup_video_jobs():
    """Remove completed/cancelled jobs older than max age."""
    now = _time.time()
    expired = [jid for jid, job in _video_jobs.items()
               if job.get("status") in ("done", "cancelled", "error")
               and now - job.get("created_at", 0) > _VIDEO_JOB_MAX_AGE]
    for jid in expired:
        del _video_jobs[jid]


@app.route("/api/video/remove-logo", methods=["POST"])
def remove_video_logo():
    """Start logo removal job in a background thread, return job_id for polling."""
    payload = request.json
    fname = payload.get("filename", "")
    lx = float(payload.get("x", 0.85))
    ly = float(payload.get("y", 0.93))
    lw = float(payload.get("w", 0.14))
    lh = float(payload.get("h", 0.06))

    video_path = VIDEO_DIR / secure_filename(fname)
    if not video_path.exists():
        return jsonify({"error": "Video not found"}), 400

    _cleanup_video_jobs()
    job_id = f"job_{int(_time.time()*1000)}"
    _video_jobs[job_id] = {"status": "starting", "progress": 0, "total": 0, "eta": 0, "output": "", "error": "", "created_at": _time.time()}

    t = threading.Thread(target=_run_logo_removal, args=(job_id, video_path, fname, lx, ly, lw, lh), daemon=True)
    t.start()

    return jsonify({"ok": True, "jobId": job_id})


@app.route("/api/video/progress/<job_id>")
def video_progress(job_id):
    """Poll for job progress."""
    job = _video_jobs.get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    return jsonify(job)


@app.route("/api/video/stop/<job_id>", methods=["POST"])
def stop_video_job(job_id):
    """Request cancellation of a running video job."""
    job = _video_jobs.get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    job["cancel"] = True
    return jsonify({"ok": True})


def _run_logo_removal(job_id, video_path, fname, lx, ly, lw, lh):
    """Background worker for video logo removal."""
    import cv2
    import numpy as np

    job = _video_jobs[job_id]
    job["status"] = "processing"

    try:
        cap = cv2.VideoCapture(str(video_path))
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = cap.get(cv2.CAP_PROP_FPS)
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        job["total"] = total

        x1 = int(lx * w)
        y1 = int(ly * h)
        x2 = min(w, int((lx + lw) * w))
        y2 = min(h, int((ly + lh) * h))

        out_name = f"clean_{secure_filename(fname)}"
        if not out_name.lower().endswith('.mp4'):
            out_name = out_name.rsplit('.', 1)[0] + '.mp4'
        out_path = VIDEO_DIR / out_name
        temp_path = VIDEO_DIR / f"_temp_{out_name}"

        fourcc = cv2.VideoWriter_fourcc(*'mp4v')
        writer = cv2.VideoWriter(str(temp_path), fourcc, fps, (w, h))

        mask = np.zeros((h, w), dtype=np.uint8)
        mask[y1:y2, x1:x2] = 255

        frame_num = 0
        start_time = _time.time()

        while True:
            ret, frame = cap.read()
            if not ret:
                break

            # Check for cancellation
            if job.get("cancel"):
                job["status"] = "cancelled"
                break

            frame = cv2.inpaint(frame, mask, inpaintRadius=5, flags=cv2.INPAINT_TELEA)
            writer.write(frame)
            frame_num += 1

            # Update progress every 10 frames
            if frame_num % 10 == 0 or frame_num == total:
                elapsed = _time.time() - start_time
                fps_actual = frame_num / max(0.1, elapsed)
                remaining = (total - frame_num) / max(1, fps_actual)
                job["progress"] = frame_num
                job["eta"] = round(remaining, 1)

        cap.release()
        writer.release()

        # If cancelled, clean up and exit
        if job.get("cancel"):
            temp_path.unlink(missing_ok=True)
            job["eta"] = 0
            return

        # Mux audio
        job["status"] = "muxing_audio"
        job["eta"] = 0
        try:
            from moviepy import VideoFileClip
            original = VideoFileClip(str(video_path))
            clean = VideoFileClip(str(temp_path))
            if original.audio is not None:
                final = clean.with_audio(original.audio)
                temp_audio = VIDEO_DIR / f'_temp_audio_{job_id}.m4a'
                final.write_videofile(str(out_path), codec='libx264', audio_codec='aac',
                                      logger=None, temp_audiofile=str(temp_audio))
                final.close()
            else:
                clean.write_videofile(str(out_path), codec='libx264', logger=None)
            original.close()
            clean.close()
            temp_path.unlink(missing_ok=True)
        except Exception:
            if temp_path.exists():
                shutil.move(str(temp_path), str(out_path))

        (VIDEO_DIR / f'_temp_audio_{job_id}.m4a').unlink(missing_ok=True)

        job["status"] = "done"
        job["progress"] = total
        job["output"] = out_name
        job["eta"] = 0

    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e)


@app.route("/api/video/download/<filename>")
def download_video(filename):
    safe_name = secure_filename(filename)
    fpath = VIDEO_DIR / safe_name
    if not fpath.exists():
        return jsonify({"error": "File not found"}), 404
    return send_file(str(fpath), as_attachment=True, download_name=safe_name)


if __name__ == "__main__":
    app.run(debug=os.environ.get('FLASK_DEBUG', 'false').lower() == 'true',
            port=int(os.environ.get('PORT', 5050)), host="0.0.0.0")

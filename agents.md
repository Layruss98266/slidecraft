# SlideCraft — Agent Context

## Overview
Flask + vanilla JS web app for editing PPTX/PDF slide decks in the browser. Upload a `.pptx` or `.pdf`, edit slides (overlays, filters, text, shapes, watermarks, audio, video), export back to PPTX/PDF/GIF.

PDF upload skips LibreOffice and renders pages straight to per-slide JPGs via PyMuPDF (`_render_pdf_to_images`). Editing is image-based, so the rest of the pipeline is format-agnostic after ingest.

PDF uploads also extract a per-page text layer (real text + bbox + font size + color) into `pdf_text.json` via `_extract_pdf_text_layer`. The frontend's "Detect text" button checks `/api/pdf-text/<num>` first and only falls back to EasyOCR if the cache is empty — instant + accurate for native PDFs. PPTX uploads clear the cache so stale data never leaks.

OCR has two scopes in the UI: the **OCR** button hits `/api/ocr/<num>` for the current slide; the **All** button hits `/api/ocr-all` and stores results per slide in `ocrRegionsBySlide` so the regions follow the user as they navigate. `/api/ocr-all` transparently uses the PDF text cache for any slide where it exists (returning `source: "pdf"|"ocr"|"mixed"`), so PDF decks skip EasyOCR entirely.

The **Detect & Remove** watermark flow now flags text-based watermarks in addition to corner-similarity matches: brand keywords (default `edstellar`, override via `WATERMARK_BRAND_KEYWORDS=foo,bar` env var), URLs, email addresses, and bare domains. Text hits use cached PDF text where available, OCR otherwise. `_dedup_candidates` prefers tight text-match bboxes over wide corner-strip bboxes so inpainting only erases the actual text — not the entire corner.

## Stack
- **Backend**: Python 3.10+, Flask 3.x, python-pptx, Pillow, OpenCV, EasyOCR, MoviePy, PyMuPDF
- **Frontend**: Vanilla JS (`static/js/app.js` ~4000 lines), HTML/CSS (`templates/index.html`)
- **PDF→JPG**: PyMuPDF (primary, no external binary), pdf2image+poppler (fallback)
- **PPTX→PDF**: LibreOffice (REQUIRED — auto-installed by all launchers)
- **Tests**: pytest, 88 tests in `tests/`

## Key Dirs / Files
```
app.py              Flask app, 61 API routes
app_features.py     Feature logic (filters, video, audio, export, logo removal)
templates/index.html  Single-page editor UI
static/js/app.js    All frontend logic
static/slides/      slide-001.jpg … slide-NNN.jpg  (3-digit zero-padded)
static/audio/       audio-001.mp3 … (same 3-digit numbering)
tests/              conftest.py + test_api.py (88 tests)
run.bat / run.sh / run.ps1   Full setup launchers (create venv, install deps, LibreOffice)
start.bat           Fast launcher — uses venv Python directly, delegates to run.bat if venv missing
```

## How to Run
```powershell
# First run (Windows)
run.bat

# Subsequent runs (Windows)
start.bat           # or double-click

# Tests
.venv\Scripts\python.exe -m pytest tests/ -ra
```

**Always use `.venv\Scripts\python.exe`** (Windows) / `.venv/bin/python` (Unix) — system Python lacks fitz/pdf2image.

## API
61 routes. Key ones:
- `POST /api/upload` — upload PPTX
- `GET/POST /api/slide/<num>` — get/save overlays + notes
- `POST /api/slide/<num>/filters` — apply filter chain (`{"blur": 5, "brightness": 20}`)
- `POST /api/export` — export deck to PPTX/PDF/GIF
- `GET /api/history` — list undo history

## Slide Numbering
**Always 3-digit zero-padded** everywhere: `slide-001.jpg`, `audio-001.mp3`, Python format `f"slide-{n:03d}.jpg"`, JS `.padStart(3, '0')`.

## Flask 3.x Gotcha
Use `request.get_json(force=True, silent=True)` — NOT `request.json`. Flask 3.x raises `UnsupportedMediaType` (415) when Content-Type is absent.

## Known Sensitivities
- `static/slides/` and `static/audio/` are runtime state — not committed, not in git
- `history/` dir — not committed (in .gitignore)
- `master_slide.json` — runtime state, not committed
- `pdf_text.json` — runtime cache of extracted PDF text layer, not committed
- `logo.png` — committed (used in UI)

## Env Vars
| Var | Default | Notes |
|---|---|---|
| `HOST` | `127.0.0.1` | Set `0.0.0.0` for LAN access |
| `PORT` | `5050` | Server port |
| `MAX_EXPORT_MB` | `10` | Hard cap on every export (PPTX/PDF/PNG-ZIP/GIF). Exports are iteratively re-rendered at smaller scale/quality until they fit. |
| `MAX_PDF_PAGES` | `300` | Refuse PDF uploads with more pages. Each page renders to a ~7-10 MB pixmap at 2.5× scale — uncapped uploads will OOM low-memory systems. |

No `.env` file needed — all defaults are safe for local dev.

## Memory Behavior
EasyOCR (torch ~1.5–2 GB) and rembg (onnxruntime ~500 MB) are **lazy-loaded** on first use via `_load_easyocr()` / `_load_rembg()`. Module import is cheap (~25 MB). `HAS_OCR` / `HAS_REMBG` use `importlib.util.find_spec` so capability checks don't pay the import cost. Never re-add eager `import easyocr` or `from rembg import ...` at module scope.

## What to Avoid
- Never use 2-digit slide padding (`:02d`, `padStart(2,'0')`) — backend generates 3-digit filenames
- Never use `request.json` in Flask routes — use `request.get_json(force=True, silent=True)`
- Never run `python app.py` with system Python — fitz and pdf2image won't be available
- Route `/api/slide/<num>/filter` (singular) does NOT exist — was deleted. Use `/api/slide/<num>/filters` (plural) with a dict payload

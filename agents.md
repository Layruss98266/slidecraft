# SlideCraft — Agent Context

## Overview
Flask + vanilla JS web app for editing PPTX slide decks in the browser. Upload a `.pptx`, edit slides (overlays, filters, text, shapes, watermarks, audio, video), export back to PPTX/PDF/GIF.

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
- `logo.png` — committed (used in UI)

## Env Vars
| Var | Default | Notes |
|---|---|---|
| `HOST` | `127.0.0.1` | Set `0.0.0.0` for LAN access |
| `PORT` | `5050` | Server port |

No `.env` file needed — all defaults are safe for local dev.

## What to Avoid
- Never use 2-digit slide padding (`:02d`, `padStart(2,'0')`) — backend generates 3-digit filenames
- Never use `request.json` in Flask routes — use `request.get_json(force=True, silent=True)`
- Never run `python app.py` with system Python — fitz and pdf2image won't be available
- Route `/api/slide/<num>/filter` (singular) does NOT exist — was deleted. Use `/api/slide/<num>/filters` (plural) with a dict payload

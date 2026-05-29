# Installing SlideCraft

This document gets a fresh machine — macOS, Windows, or Linux — running the editor end-to-end.

## TL;DR

```bash
# 1. Install Python 3.10+ and LibreOffice (instructions per-OS below)
# 2. Clone the repo
git clone https://github.com/Layruss98266/slidecraft.git
cd slidecraft

# 3. Create a virtualenv and install Python deps
python -m venv .venv
# macOS/Linux:
source .venv/bin/activate
# Windows (PowerShell):
.venv\Scripts\Activate.ps1

pip install -r requirements.txt

# 4. Run
python app.py
# Open http://127.0.0.1:5050
```

First slide upload triggers a one-time ~64 MB EasyOCR model download to `~/.EasyOCR/`. Subsequent uploads are fast.

---

## Prerequisites

| Component | Required for | Notes |
|---|---|---|
| **Python 3.10+** | Everything | 3.11 / 3.12 recommended. 3.13+ works too. |
| **pip** | Installing Python packages | Bundled with Python on Windows/macOS; on Linux `sudo apt install python3-pip`. |
| **LibreOffice 7.x+** | PPTX → slide-image conversion | Without it, the app falls back to a low-fidelity Pillow path that loses most slide content. **Strongly recommended.** |
| **Disk space** | ~3 GB | EasyOCR pulls torch (~2 GB) + a model (~64 MB) on first run. |
| **RAM** | ~1 GB free | Per-slide rendering is small; bulk PPTX processing peaks at ~150 MB per deck. |
| **Modern browser** | UI | Chrome, Edge, Firefox, Safari — anything from the last 3 years. Canvas + ES2020 required. |

### Optional

| Component | Required for | Notes |
|---|---|---|
| **ffmpeg** | Video logo removal | moviepy bundles a portable `imageio-ffmpeg` binary, so you usually don't need a system install. |
| **poppler** | Faster PPTX→image conversion | If `pdf2image` is installed and finds poppler, conversion is faster than the PyMuPDF fallback. Optional. |
| **fonts** | Text rendering | The app looks in OS font dirs (Windows `C:\Windows\Fonts`, macOS `/Library/Fonts`, Linux `/usr/share/fonts`). If a font isn't found, it falls back to Pillow's default. |

---

## Platform-specific install

### Windows 10/11

1. **Python** — Install from [python.org/downloads](https://python.org/downloads) (3.11 or 3.12). Tick "Add Python to PATH" during install.
2. **LibreOffice** — Download from [libreoffice.org/download](https://libreoffice.org/download/download-libreoffice/) and run the MSI. The app auto-detects `C:\Program Files\LibreOffice\program\soffice.exe`.
3. Open PowerShell and run:
   ```powershell
   git clone https://github.com/Layruss98266/slidecraft.git
   cd slidecraft
   python -m venv .venv
   .venv\Scripts\Activate.ps1
   pip install -r requirements.txt
   python app.py
   ```
4. Open `http://127.0.0.1:5050` in any browser.

### macOS (Intel + Apple Silicon)

1. **Python** — Install via [Homebrew](https://brew.sh/): `brew install python@3.12`
2. **LibreOffice** — `brew install --cask libreoffice` (or download the .dmg from libreoffice.org).
3. Open Terminal:
   ```bash
   git clone https://github.com/Layruss98266/slidecraft.git
   cd slidecraft
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   python app.py
   ```

### Linux (Debian / Ubuntu)

```bash
sudo apt update
sudo apt install python3 python3-pip python3-venv libreoffice git
git clone https://github.com/Layruss98266/slidecraft.git
cd slidecraft
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

### Linux (Arch / Fedora)

```bash
# Arch
sudo pacman -S python python-pip libreoffice-fresh git

# Fedora
sudo dnf install python3 python3-pip libreoffice git

# Then same as above
```

---

## Configuration via environment variables

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address. Set to `0.0.0.0` to expose on LAN (warning printed — there's no built-in auth). |
| `PORT` | `5050` | HTTP port. |
| `MAX_UPLOAD_MB` | `60` | Max request body size in MB. Raise for very large PPTX batches. |
| `EXPORT_TTL_SECONDS` | `86400` | How long exported files in `exports/` live before being cleaned up. |
| `FLASK_DEBUG` | `false` | Set to `true` for live reload and verbose tracebacks (dev only). |

Example:
```bash
HOST=0.0.0.0 PORT=8080 MAX_UPLOAD_MB=200 python app.py
```

---

## Running tests

```bash
pip install -r requirements-dev.txt
python -m pytest tests/
# Expect 70+ passing tests, ~15 seconds end-to-end.
```

CI runs the same suite on Ubuntu + Windows × Python 3.11 + 3.12 via `.github/workflows/test.yml` on every push.

---

## Troubleshooting

### "LibreOffice not found" / slides look mostly blank after upload
Install LibreOffice (see per-OS section above). The fallback Pillow conversion only renders the first picture shape on each slide — that's why it looks empty.

### First upload takes 30+ seconds
EasyOCR is downloading its detection + recognition models to `~/.EasyOCR/`. One-time cost. Subsequent uploads use the cached models.

### "Maximum 20 files allowed" in bulk mode
Hard cap to keep request handling synchronous. For bigger batches, run bulk twice or raise the cap in `app.py` (look for `len(pptx_files) > 20`) — but expect long waits and possible browser timeouts.

### Port 5050 already in use
Either set `PORT=5051 python app.py`, or kill the existing process:
```bash
# macOS/Linux:
lsof -ti tcp:5050 | xargs kill -9
# Windows:
for /f "tokens=5" %a in ('netstat -ano ^| findstr :5050') do taskkill /F /PID %a
```

### Browser can't reach the server from another machine
By default the server binds to localhost only. Re-run with `HOST=0.0.0.0`. Don't expose it to the public internet without putting a reverse proxy + auth in front.

### `pip install` fails on `torch` (EasyOCR dep)
On older / 32-bit Pythons, PyTorch wheels aren't available. Use 64-bit Python 3.10–3.12. On Apple Silicon, `pip install torch` should work out of the box on Python 3.11.

---

## What gets created at runtime

```
slidecraft/
├── static/slides/             # current working slide JPGs
│   └── _originals/            # uploaded originals (used by Reset)
├── uploads/                   # the original PPTX you uploaded
├── exports/                   # downloaded PPTX/PDF/PNG zip files (cleaned every 24h)
├── history/                   # automatic snapshots before each destructive op
├── templates_saved/           # explicit saves from the Templates modal
├── videos/                    # video logo-remover input + output
├── slide_data.json            # per-slide overlay + notes state
├── comments.json              # per-slide pinned comments
└── watermarks_applied.json    # log of applied watermarks/filters/etc.
```

All of these are listed in `.gitignore` — they never get committed.

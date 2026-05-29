#!/usr/bin/env bash
# SlideCraft launcher — creates venv, installs deps, runs server.
# Usage:  ./run.sh        (localhost-only)
#         HOST=0.0.0.0 ./run.sh   (LAN-accessible, no auth)
set -e
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
    echo ">> First run: creating .venv"
    python3 -m venv .venv
fi

# shellcheck disable=SC1091
source .venv/bin/activate

if ! python -c "import flask" 2>/dev/null; then
    echo ">> Installing dependencies (one-time, ~3 min)"
    pip install --upgrade pip
    pip install -r requirements.txt
fi

# Warn if LibreOffice isn't on PATH — the Pillow fallback is lossy.
if ! command -v libreoffice >/dev/null 2>&1 && ! command -v soffice >/dev/null 2>&1; then
    if [ ! -e "/Applications/LibreOffice.app/Contents/MacOS/soffice" ]; then
        echo "!! WARNING: LibreOffice not found. PPTX→slide conversion will use a"
        echo "!! lossy Pillow fallback. Install: brew install --cask libreoffice"
        echo "!! or sudo apt install libreoffice"
    fi
fi

exec python app.py

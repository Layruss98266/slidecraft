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

# LibreOffice: required. Auto-install if missing.
_lo_found() {
    command -v libreoffice >/dev/null 2>&1 || \
    command -v soffice >/dev/null 2>&1 || \
    [ -e "/Applications/LibreOffice.app/Contents/MacOS/soffice" ]
}
if ! _lo_found; then
    echo ">> LibreOffice not found — installing..."
    if [[ "$OSTYPE" == "darwin"* ]]; then
        brew install --cask libreoffice
    elif command -v apt-get >/dev/null 2>&1; then
        sudo apt-get install -y libreoffice
    elif command -v pacman >/dev/null 2>&1; then
        sudo pacman -S --noconfirm libreoffice-fresh
    elif command -v dnf >/dev/null 2>&1; then
        sudo dnf install -y libreoffice
    else
        echo "ERROR: Cannot auto-install LibreOffice on this system."
        echo "Install manually from: https://www.libreoffice.org/download/download/"
        exit 1
    fi
    if ! _lo_found; then
        echo "ERROR: LibreOffice install failed. Install manually from: https://www.libreoffice.org/download/download/"
        exit 1
    fi
    echo ">> LibreOffice installed successfully."
fi

exec python app.py

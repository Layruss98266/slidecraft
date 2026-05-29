@echo off
REM SlideCraft launcher (Windows). Creates venv, installs deps, runs server.
REM Usage:   run.bat
REM          set HOST=0.0.0.0 && run.bat   (LAN-accessible, no auth)
setlocal
cd /d "%~dp0"

if not exist .venv (
    echo ^>^> First run: creating .venv
    python -m venv .venv
    if errorlevel 1 (
        echo Failed to create venv. Make sure Python 3.10+ is installed and on PATH.
        exit /b 1
    )
)

call .venv\Scripts\activate.bat

python -c "import flask" >NUL 2>&1
if errorlevel 1 (
    echo ^>^> Installing dependencies (one-time, ~3 min)
    pip install --upgrade pip
    pip install -r requirements.txt
)

REM Warn if LibreOffice isn't installed
where soffice >NUL 2>&1
if errorlevel 1 (
    if not exist "C:\Program Files\LibreOffice\program\soffice.exe" (
        echo !! WARNING: LibreOffice not found. PPTX-^>slide conversion will use a
        echo !! lossy Pillow fallback. Install from https://libreoffice.org/download
    )
)

python app.py
endlocal

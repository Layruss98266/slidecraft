@echo off
REM SlideCraft launcher (Windows).
REM Usage:   run.bat
REM          set HOST=0.0.0.0 && run.bat   (LAN-accessible)
setlocal
cd /d "%~dp0"

REM --- One-time setup: only runs when venv is missing ---
if not exist .venv\Scripts\activate.bat (
    echo ^>^> First run: creating .venv
    python -m venv .venv
    if errorlevel 1 (
        echo Failed to create venv. Make sure Python 3.10+ is installed and on PATH.
        pause
        exit /b 1
    )
    call .venv\Scripts\activate.bat
    echo ^>^> Installing dependencies...
    pip install --quiet --upgrade pip
    pip install --quiet -r requirements.txt
    echo requirements.txt > .venv\.installed
    goto run
)

call .venv\Scripts\activate.bat

REM --- Re-install only if requirements.txt changed since last install ---
fc /b requirements.txt .venv\.installed >NUL 2>&1
if errorlevel 1 (
    echo ^>^> requirements.txt changed — updating deps...
    pip install --quiet -r requirements.txt
    copy /y requirements.txt .venv\.installed >NUL
)

:run
REM --- LibreOffice: required. Auto-install via winget if missing. ---
if not exist "C:\Program Files\LibreOffice\program\soffice.exe" (
    where soffice >NUL 2>&1
    if errorlevel 1 (
        echo ^>^> LibreOffice not found — installing via winget (this may take a few minutes)...
        winget install --id TheDocumentFoundation.LibreOffice --silent --accept-package-agreements --accept-source-agreements
        if errorlevel 1 (
            echo ERROR: Automatic install failed.
            echo Please install manually from: https://www.libreoffice.org/download/download/
            pause
            exit /b 1
        )
        echo ^>^> LibreOffice installed successfully.
    )
)

python app.py
endlocal

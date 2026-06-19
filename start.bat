@echo off
cd /d "%~dp0"

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

.venv\Scripts\python.exe app.py

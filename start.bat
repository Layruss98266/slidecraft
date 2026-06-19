@echo off
cd /d "%~dp0"
title SlideCraft

if not exist ".venv\Scripts\python.exe" (
    echo [setup] First run - launching run.bat for setup...
    call "%~dp0run.bat"
    exit /b %errorlevel%
)

if not exist "C:\Program Files\LibreOffice\program\soffice.exe" (
    where soffice >NUL 2>&1
    if errorlevel 1 (
        echo [setup] Installing LibreOffice via winget...
        winget install --id TheDocumentFoundation.LibreOffice --silent --accept-package-agreements --accept-source-agreements
        if errorlevel 1 (
            echo ERROR: LibreOffice install failed.
            pause
            exit /b 1
        )
    )
)

echo [start] http://127.0.0.1:5050
.venv\Scripts\python.exe app.py
if errorlevel 1 (
    echo ERROR: Server exited unexpectedly. See above.
    pause
)

# SlideCraft launcher (PowerShell). Creates venv, installs deps, runs server.
# Usage:  .\run.ps1
#         $env:HOST = "0.0.0.0"; .\run.ps1     (LAN-accessible, no auth)
$ErrorActionPreference = "Stop"
Set-Location -LiteralPath (Split-Path -Parent $MyInvocation.MyCommand.Path)

if (-not (Test-Path ".venv")) {
    Write-Host ">> First run: creating .venv"
    python -m venv .venv
}

. .\.venv\Scripts\Activate.ps1

$flaskInstalled = $false
try { python -c "import flask" 2>$null; if ($LASTEXITCODE -eq 0) { $flaskInstalled = $true } } catch {}

if (-not $flaskInstalled) {
    Write-Host ">> Installing dependencies (one-time, ~3 min)"
    pip install --upgrade pip
    pip install -r requirements.txt
}

# Warn if LibreOffice isn't installed
$soffice = Get-Command soffice -ErrorAction SilentlyContinue
if (-not $soffice -and -not (Test-Path "C:\Program Files\LibreOffice\program\soffice.exe")) {
    Write-Warning "LibreOffice not found. PPTX->slide conversion will use a lossy Pillow fallback."
    Write-Warning "Install from https://libreoffice.org/download"
}

python app.py

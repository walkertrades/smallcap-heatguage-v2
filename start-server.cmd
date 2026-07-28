@echo off
REM Start the Heat Gauge dev server (static files + the Anthropic trend proxy).
REM
REM Double-click this, or run it from a terminal. Optional port argument:
REM     start-server.cmd 8001
REM
REM Why this exists rather than just "python serve.py": the `python` on PATH is
REM the Microsoft Store stub, which exits without running anything. This finds a
REM real interpreter first.

setlocal
cd /d "%~dp0"

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8000"

set "PY="
REM 1. the interpreter this project is known to work with
if exist "%LOCALAPPDATA%\Python\pythoncore-3.14-64\python.exe" set "PY=%LOCALAPPDATA%\Python\pythoncore-3.14-64\python.exe"
REM 2. the py launcher, which never resolves to the Store stub
if not defined PY (py -3 -c "import sys" >nul 2>&1 && set "PY=py -3")
REM 3. plain python, but only if it actually executes
if not defined PY (python -c "import sys" >nul 2>&1 && set "PY=python")

if not defined PY (
  echo.
  echo   Could not find a working Python interpreter.
  echo   The `python` command on PATH is the Microsoft Store stub, which does nothing.
  echo   Install Python from python.org, or disable the stub in:
  echo     Settings ^> Apps ^> Advanced app settings ^> App execution aliases
  echo.
  pause
  exit /b 1
)

if not defined ANTHROPIC_API_KEY (
  echo.
  echo   NOTE: ANTHROPIC_API_KEY is not set in this terminal.
  echo   The dashboard still runs, but the AI Trend Summary cannot blend the last
  echo   5 days and will fall back to the most recent single-day summary.
  echo   Set it first with:  set ANTHROPIC_API_KEY=sk-ant-...
  echo.
)

echo Serving %CD% on http://localhost:%PORT%/
echo Press Ctrl+C to stop.
echo.
%PY% serve.py %PORT%

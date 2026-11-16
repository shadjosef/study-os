@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    py -3 "%~dp0app\server.py" --open %*
    goto :eof
)

where python >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    python "%~dp0app\server.py" --open %*
    goto :eof
)

echo Error: Python 3.9+ was not found on PATH. Install Python 3 from python.org or winget.
pause
exit /b 1

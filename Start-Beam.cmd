@echo off
REM Double-click this file to start Beam.
REM It exists because Windows will not run a .ps1 by double-click, and because
REM it avoids the "scripts cannot be run on this system" execution policy error.

setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Beam.ps1" %*
set EXITCODE=%ERRORLEVEL%

if not "%EXITCODE%"=="0" (
    echo.
    echo Beam exited with code %EXITCODE%.
)
echo.
pause
endlocal
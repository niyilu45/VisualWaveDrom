@echo off
setlocal

rem ===== PROJECT SETTINGS - CHANGE THESE VALUES ONLY =====
set "HTML_FILE_NAME=VisualWaveDrom.html"
set "WAVE_LIBRARY_RELATIVE_PATH=Wave\VisualWaveDrom-library\library.sqlite"
rem ========================================================

cd /d "%~dp0"
for %%I in ("%~dp0%WAVE_LIBRARY_RELATIVE_PATH%") do set "WAVE_LIBRARY_PATH=%%~fI"

if "%~1"=="" (
  node "%~dp0VisualWaveDrom.js" --html "%HTML_FILE_NAME%" --library "%WAVE_LIBRARY_PATH%" --protocol-handler "%~f0"
) else (
  node "%~dp0VisualWaveDrom.js" --html "%HTML_FILE_NAME%" --library "%WAVE_LIBRARY_PATH%" --protocol-handler "%~f0" --open-url "%~1"
)
if errorlevel 1 pause

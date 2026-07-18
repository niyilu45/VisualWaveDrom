@echo off
setlocal

rem ===== HTML FILE NAME - CHANGE ONLY THIS VALUE =====
set "HTML_FILE_NAME=VisualWaveDrom.html"
rem ===================================================

cd /d "%~dp0"
node "%~dp0VisualWaveDrom.js" --html "%HTML_FILE_NAME%"
if errorlevel 1 pause

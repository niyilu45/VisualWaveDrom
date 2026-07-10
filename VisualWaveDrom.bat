@echo off
setlocal
cd /d "%~dp0"
node "%~dp0VisualWaveDrom.js"
if errorlevel 1 pause

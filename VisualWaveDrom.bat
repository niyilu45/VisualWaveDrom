@echo off
setlocal

rem ===== PROJECT SETTINGS - CHANGE THESE VALUES ONLY =====
set "HTML_FILE_NAME=VisualWaveDrom.html"
set "WAVE_LIBRARY_RELATIVE_PATH=Wave\VisualWaveDrom-library\library.sqlite"
rem ========================================================

cd /d "%~dp0"
for %%I in ("%~dp0%WAVE_LIBRARY_RELATIVE_PATH%") do set "WAVE_LIBRARY_PATH=%%~fI"
set "PORTABLE_NODE_EXE=%~dp0inc\node-runtime\node.exe"
set "NODE_INSTALL_SCRIPT=%~dp0tools\InstallNodeRuntime.ps1"

call :find_node
if not defined NODE_EXE call :install_portable_node
if not defined NODE_EXE goto :node_missing

if /i "%~1"=="--check-runtime" (
  echo Node.js runtime: "%NODE_EXE%"
  "%NODE_EXE%" --version
  exit /b %ERRORLEVEL%
)

if "%~1"=="" (
  "%NODE_EXE%" "%~dp0VisualWaveDrom.js" --html "%HTML_FILE_NAME%" --library "%WAVE_LIBRARY_PATH%" --protocol-handler "%~f0"
) else (
  "%NODE_EXE%" "%~dp0VisualWaveDrom.js" --html "%HTML_FILE_NAME%" --library "%WAVE_LIBRARY_PATH%" --protocol-handler "%~f0" --open-url "%~1"
)
set "VWD_EXIT_CODE=%ERRORLEVEL%"
if not "%VWD_EXIT_CODE%"=="0" pause
exit /b %VWD_EXIT_CODE%

:find_node
set "NODE_EXE="
if defined VWD_NODE_EXE call :try_node "%VWD_NODE_EXE%"
call :try_node "%PORTABLE_NODE_EXE%"
call :try_node "%ProgramFiles%\nodejs\node.exe"
call :try_node "%ProgramFiles(x86)%\nodejs\node.exe"
call :try_node "%LOCALAPPDATA%\Programs\nodejs\node.exe"
call :try_node "%LOCALAPPDATA%\Volta\bin\node.exe"
call :try_node "%USERPROFILE%\.volta\bin\node.exe"
if not defined NODE_EXE for %%I in (node.exe) do call :try_node "%%~$PATH:I"
exit /b 0

:try_node
if defined NODE_EXE exit /b 0
if not exist "%~1" exit /b 0
"%~1" --version >nul 2>&1
if not errorlevel 1 set "NODE_EXE=%~1"
exit /b 0

:install_portable_node
echo.
echo Node.js was not found on this computer.
echo VisualWaveDrom can download a portable Node.js LTS runtime from nodejs.org.
echo It will be stored inside this project and does not require administrator rights.
echo.
if not exist "%NODE_INSTALL_SCRIPT%" exit /b 1
choice /C YN /N /M "Download the portable Node.js runtime now? [Y/N]: "
if errorlevel 2 exit /b 1
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%NODE_INSTALL_SCRIPT%" -Destination "%~dp0inc\node-runtime"
if errorlevel 1 exit /b 1
call :try_node "%PORTABLE_NODE_EXE%"
exit /b 0

:node_missing
echo.
echo [ERROR] VisualWaveDrom service mode requires Node.js.
echo Install Node.js, run this BAT again with Internet access, or copy a prepared
echo inc\node-runtime folder from another VisualWaveDrom installation.
echo Browser-only mode is still available by opening %HTML_FILE_NAME% directly.
echo.
pause
exit /b 1

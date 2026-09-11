@echo off
setlocal

rem ===== PROJECT SETTINGS - CHANGE THESE VALUES ONLY =====
set "HTML_FILE_NAME=VisualWaveDrom.html"
set "WAVE_LIBRARY_RELATIVE_PATH=Wave\VisualWaveDrom-library\library.sqlite"
rem ========================================================

cd /d "%~dp0"
for %%I in ("%~dp0.") do set "PROJECT_ROOT=%%~fI"
for %%I in ("%~dp0%WAVE_LIBRARY_RELATIVE_PATH%") do set "WAVE_LIBRARY_PATH=%%~fI"
set "SERVER_EXE=%~dp0bin\VisualWaveDrom-server.exe"

if not exist "%SERVER_EXE%" goto :server_missing

if /i "%~1"=="--check-runtime" (
  "%SERVER_EXE%" --root "%PROJECT_ROOT%" --html "%HTML_FILE_NAME%" --library "%WAVE_LIBRARY_PATH%" --check-runtime
  exit /b %ERRORLEVEL%
)

rem Run the updater outside bin so Windows can replace the server executable.
if not exist "%PROJECT_ROOT%\.tmp" mkdir "%PROJECT_ROOT%\.tmp"
set "UPDATER_EXE=%PROJECT_ROOT%\.tmp\version-check-%RANDOM%-%RANDOM%.exe"
copy /b "%SERVER_EXE%" "%UPDATER_EXE%" >nul
if errorlevel 1 goto :update_failed
"%UPDATER_EXE%" --root "%PROJECT_ROOT%" --html "%HTML_FILE_NAME%" --check-tool-updates
set "UPDATE_EXIT_CODE=%ERRORLEVEL%"
del /q "%UPDATER_EXE%" >nul 2>&1
if not "%UPDATE_EXIT_CODE%"=="0" goto :update_failed

if "%~1"=="" (
  "%SERVER_EXE%" --root "%PROJECT_ROOT%" --html "%HTML_FILE_NAME%" --library "%WAVE_LIBRARY_PATH%" --protocol-handler "%~f0"
) else (
  "%SERVER_EXE%" --root "%PROJECT_ROOT%" --html "%HTML_FILE_NAME%" --library "%WAVE_LIBRARY_PATH%" --protocol-handler "%~f0" --open-url "%~1"
)
set "VWD_EXIT_CODE=%ERRORLEVEL%"
if not "%VWD_EXIT_CODE%"=="0" pause
exit /b %VWD_EXIT_CODE%

:update_failed
echo [ERROR] Tool version check or update failed. No wave libraries were changed.
pause
exit /b 1

:server_missing
echo.
echo [ERROR] VisualWaveDrom static server was not found:
echo %SERVER_EXE%
echo.
echo Restore the bin folder from the VisualWaveDrom package.
echo Browser-only mode is still available by opening %HTML_FILE_NAME% directly.
echo.
pause
exit /b 1

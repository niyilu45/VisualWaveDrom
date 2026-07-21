@echo off
setlocal

set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
set "ROOT=%~dp0..\.."

if not exist "%CSC%" (
  echo C# compiler not found: %CSC%
  exit /b 1
)

"%CSC%" /nologo /optimize+ /target:exe /platform:anycpu /out:"%ROOT%\WaveLibraryConverter.exe" /reference:System.Web.Extensions.dll "%~dp0WaveLibraryConverter.cs"
exit /b %errorlevel%

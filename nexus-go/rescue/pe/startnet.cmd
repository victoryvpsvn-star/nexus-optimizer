@echo off
REM NEXUS WinPE - v4.6 gaming rescue: dashboard + menu tune/debloat/apps + NEXUS web
REM PowerShell 7 portable (self-contained, kem .NET runtime) nhung vao image luc build —
REM WinSE 26H2 khong co powershell san (bi loai khoi boot.wim tu Win11).
title NEXUS Rescue PE - gaming ultra-light
wpeinit
set PWSH=X:\NEXUS\pwsh\pwsh.exe
if exist X:\NEXUS\nexus-dashboard.ps1 (
  if exist %PWSH% (
    %PWSH% -NoProfile -ExecutionPolicy Bypass -File X:\NEXUS\nexus-dashboard.ps1
  ) else (
    echo [!] Khong co PowerShell portable trong image — bo qua dashboard
  )
)
set NEXUS_BIND=0.0.0.0
if not exist X:\nexus-data mkdir X:\nexus-data
set NEXUS_DATA_DIR=X:\nexus-data
start "NEXUS" X:\NEXUS\nexus.exe --web --port 8080
echo.
echo   [NEXUS web dang chay nen] mo tu may khac cung mang LAN: http://^<ip^>:8080
echo.
if not exist %PWSH% goto webonly
echo   ===== MENU GIAN DI (nhap so roi Enter) =====
echo   [1] OFFLINE GAMING TUNE - apply tweak vao Windows that (HAGS, GameDVR, SysMain...)
echo   [2] APP INSTALLER + DEBLOAT - tai Discord/Steam/Chrome/Opera GX... + tu cai khi boot lai
echo   [0] Bo qua - chi dung NEXUS web
set /p NXCHOICE="  Chon: "
if "%NXCHOICE%"=="1" %PWSH% -NoProfile -ExecutionPolicy Bypass -File X:\NEXUS\nexus-offline-tune.ps1
if "%NXCHOICE%"=="2" %PWSH% -NoProfile -ExecutionPolicy Bypass -File X:\NEXUS\nexus-apps.ps1
echo.
echo   NEXUS web van dang chay nen. Go lenh khac hoac reboot khi muon.
goto eof
:webonly
echo   (che do web-only - khong co PowerShell trong image)

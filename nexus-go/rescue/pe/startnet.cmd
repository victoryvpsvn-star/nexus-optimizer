@echo off
REM NEXUS Windows PE - v4.5.0: autorun sau khi WinPE boot xong.
REM X: la RAM disk - moi ghi trong phien PE KHONG _ung du lieu that tren o.
title NEXUS Rescue PE - gaming ultra-light
wpeinit
if exist X:\NEXUS\nexus-dashboard.ps1 (
  powershell -NoProfile -ExecutionPolicy Bypass -File X:\NEXUS\nexus-dashboard.ps1
) else (
  echo [!] nexus-dashboard.ps1 khong tim thay - bo qua dashboard
)
set NEXUS_BIND=0.0.0.0
if not exist X:\nexus-data mkdir X:\nexus-data
set NEXUS_DATA_DIR=X:\nexus-data
echo.
echo [NEXUS] Khoi dong web server (dung doi neu chua thay dong "HTTP server")...
X:\NEXUS\nexus.exe --web --port 8080
echo.
echo NEXUS dang chay nen - bam lenh khac de dung console. Lan so sanh dong dia chi ^"HTTP^" tren: http://<ip>:8080

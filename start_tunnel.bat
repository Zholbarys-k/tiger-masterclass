@echo off
chcp 65001 >nul
title TIGER MasterClass - Cloudflare Tunnel
cd /d "%~dp0"

echo Starting server in a separate window...
start "TIGER server" cmd /k python run.py
timeout /t 6 >nul

echo.
echo Cloudflare quick tunnel. Find the public link in the output below:
echo   https://xxxx.trycloudflare.com
echo Do NOT close this window or the server window while the event is running.
echo.
"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:5000
pause

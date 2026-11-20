@echo off
cd /d "%~dp0backend"
where node >nul 2>nul || (echo Node.js 20.3+ is required & pause & exit /b 1)
where ffmpeg >nul 2>nul || (echo FFmpeg is required - add ffmpeg and ffprobe to PATH & pause & exit /b 1)
if not exist .env copy .env.example .env
echo Starting BEYOND AI on http://localhost:8787
node server.js
pause

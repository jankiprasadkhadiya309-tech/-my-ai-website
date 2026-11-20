#!/usr/bin/env bash
# Starts BEYOND AI (backend + website) on http://localhost:8787
cd "$(dirname "$0")/backend" || exit 1
command -v node >/dev/null || { echo "Node.js 20.3+ is required"; exit 1; }
command -v ffmpeg >/dev/null || { echo "FFmpeg is required (ffmpeg + ffprobe in PATH)"; exit 1; }
[ -f .env ] || cp .env.example .env
exec node server.js

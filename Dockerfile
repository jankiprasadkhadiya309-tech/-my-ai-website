FROM node:20-bookworm-slim
# FFmpeg (with libx264, libvpx, libass) + fonts so Hindi/English captions render
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fontconfig fonts-noto-core \
    && rm -rf /var/lib/apt/lists/* && fc-cache -f
WORKDIR /app
COPY backend/ ./backend/
COPY public/ ./public/
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "backend/server.js"]

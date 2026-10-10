FROM node:20-slim

# Install official Debian FFmpeg, fonts, fontconfig, and espeak-ng.
# Debian 12 (Bookworm) provides native FFmpeg compiled with full support for
# libass (ass/subtitles filters), libfreetype (drawtext filter), fontconfig,
# and liberation fonts.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    fontconfig \
    fonts-liberation \
    espeak-ng \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm ci --only=production

# Copy application code
COPY backend/ ./backend/
COPY frontend/ ./frontend/
COPY storage/ ./storage/

# Ensure required persistent storage dirs exist and belong to the node user.
# The dir list must match storage.util.js DIRS, which is what actually creates
# them at boot — 'outputs' (plural) is the name the render pipeline writes to.
RUN mkdir -p storage/gameplay storage/outputs storage/temp storage/audio storage/subtitles && \
    chown -R node:node /app

ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV FFPROBE_PATH=/usr/bin/ffprobe
ENV TRUST_PROXY_HOPS=1

EXPOSE 3000

# Healthcheck so Railway knows when the app is ready
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["node", "backend/server.js"]

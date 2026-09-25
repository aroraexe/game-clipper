FROM node:20-slim

# Download full static FFmpeg build (guarantees lavfi and all features)
RUN apt-get update && apt-get install -y wget xz-utils \
 && wget https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz \
 && tar -xJf ffmpeg-release-amd64-static.tar.xz \
 && mv ffmpeg-*-static/ffmpeg /usr/local/bin/ \
 && mv ffmpeg-*-static/ffprobe /usr/local/bin/ \
 && rm -rf ffmpeg-* \
 && apt-get remove -y wget xz-utils && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm ci --only=production

# Copy application code
COPY backend/ ./backend/
COPY frontend/ ./frontend/

# Create persistent storage dirs
RUN mkdir -p storage/gameplay storage/output storage/temp

EXPOSE 3000

# Healthcheck so Railway knows when the app is ready
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["node", "backend/server.js"]

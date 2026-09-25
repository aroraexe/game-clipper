FROM node:20-alpine

# Install FFmpeg with libx264 support
RUN apk add --no-cache ffmpeg

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
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "backend/server.js"]

FROM node:20-slim

# Download full static FFmpeg build (guarantees lavfi and all features)
#
# SUPPLY CHAIN: this used to pull the rolling "ffmpeg-release-amd64-static" URL
# with no verification. If that host were compromised, or the artifact swapped,
# every subsequent build would silently install a tampered binary — and that
# binary then parses user-supplied video and subtitle files. The version is now
# pinned and the SHA-256 is enforced, so a changed or substituted artifact fails
# the build instead of shipping.
#
# To upgrade: download the new tarball, compute `sha256sum`, and update both
# FFMPEG_VERSION and FFMPEG_SHA256 together.
ARG FFMPEG_VERSION=7.0.2
ARG FFMPEG_SHA256=abda8d77ce8309141f83ab8edf0596834087c52467f6badf376a6a2a4c87cf67

RUN apt-get update && apt-get install -y wget xz-utils coreutils fontconfig fonts-liberation \
 && wget -q "https://johnvansickle.com/ffmpeg/releases/ffmpeg-${FFMPEG_VERSION}-amd64-static.tar.xz" -O /tmp/ffmpeg.tar.xz \
 && echo "${FFMPEG_SHA256}  /tmp/ffmpeg.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/ffmpeg.tar.xz -C /tmp \
 && mv "/tmp/ffmpeg-${FFMPEG_VERSION}-amd64-static/ffmpeg" /usr/local/bin/ \
 && mv "/tmp/ffmpeg-${FFMPEG_VERSION}-amd64-static/ffprobe" /usr/local/bin/ \
 && chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe \
 && rm -rf /tmp/ffmpeg* \
 && apt-get remove -y wget xz-utils && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm ci --only=production

# Copy application code
COPY backend/ ./backend/
COPY frontend/ ./frontend/
COPY storage/ ./storage/

# Ensure required persistent storage dirs exist and belong to the node user
RUN mkdir -p storage/gameplay storage/output storage/temp && \
    chown -R node:node /app

EXPOSE 3000

# Healthcheck so Railway knows when the app is ready
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1))"

USER node

CMD ["node", "backend/server.js"]

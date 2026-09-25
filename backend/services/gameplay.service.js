'use strict';
/**
 * gameplay.service.js
 * ───────────────────
 * Manages gameplay source files and efficient segment selection.
 *
 * CRITICAL DESIGN:
 *  - Never reads or re-encodes the full source file.
 *  - Uses FFprobe to read duration once per file (cached).
 *  - Selects a random start timestamp, avoiding recently used ranges.
 *  - Returns only the metadata needed for ffmpeg.service to do a direct seek.
 *
 * Later: swap usedRanges for a pre-indexed segment library without rewriting
 *        this interface.
 */

const fs      = require('fs');
const path    = require('path');

const STORAGE_ROOT = process.env.STORAGE_ROOT || './storage';
const GAMEPLAY_DIR = path.resolve(STORAGE_ROOT, 'gameplay');

/* ── In-memory catalogue ──────────────────────────────────────────────────── */
const CATALOGUE = [
  { id: 'minecraft',      name: 'Minecraft',       file: 'minecraft.mp4',       tags: ['sandbox', 'survival'] },
  { id: 'roblox',         name: 'Roblox',          file: 'roblox.webm',         tags: ['casual', 'colorful'] },
  { id: 'gtav',           name: 'GTA V',           file: 'gtav.mp4',            tags: ['action', 'open-world'] },
  { id: 'subway-surfers', name: 'Subway Surfers',  file: 'subway-surfers.mp4',  tags: ['endless-runner', 'mobile'] },
  { id: 'fortnite',       name: 'Fortnite',        file: 'fortnite.mp4',        tags: ['battle-royale', 'colorful'] },
  { id: 'geometry-dash',  name: 'Geometry Dash',   file: 'geometry-dash.mp4',   tags: ['rhythm', 'intense'] },
];

// Per-file duration cache: fileId → seconds
const durationCache = new Map();

// Per-file recently-used segments: fileId → [{start, end, usedAt}]
const usedRanges = new Map();

const AVOID_REUSE_S  = 3600;          // avoid repeating a segment within 1 hour
const COOLDOWN_RANGE = 30;            // avoid start timestamps within ±30s of recent

/* ── Public API ───────────────────────────────────────────────────────────── */

function listAll() {
  return CATALOGUE.map((c) => ({
    id:        c.id,
    name:      c.name,
    tags:      c.tags,
    available: fs.existsSync(path.join(GAMEPLAY_DIR, c.file)),
  }));
}

function getById(id) {
  return CATALOGUE.find((c) => c.id === id) || null;
}

/**
 * selectSegment(gameId, durationS)
 * → { filePath, startTime, endTime }
 *
 * Uses ffprobe to get total duration (cached), then picks a fresh timestamp.
 * Falls back to a placeholder/mock path if the file doesn't exist yet.
 */
async function selectSegment(gameId, durationS) {
  const entry = getById(gameId);
  if (!entry) throw new Error(`Unknown gameplay id: ${gameId}`);

  const filePath = path.join(GAMEPLAY_DIR, entry.file);

  // If source file doesn't exist, use mock mode
  if (!fs.existsSync(filePath)) {
    console.warn(`[Gameplay] Source file missing: ${entry.file}. Using mock segment.`);
    return { filePath: null, startTime: 0, endTime: durationS, mock: true };
  }

  // Get (or probe) the file duration
  const totalDuration = await getFileDuration(gameId, filePath);

  if (totalDuration < durationS + 10)
    throw new Error(`Gameplay file ${entry.file} is too short for the requested duration`);

  // Pick a start time avoiding recent segments
  const startTime = pickStartTime(gameId, totalDuration, durationS);
  const endTime   = startTime + durationS;

  // Record this usage
  recordUsage(gameId, startTime, endTime);

  console.log(`[Gameplay] Selected ${entry.name} @ ${formatTime(startTime)} → ${formatTime(endTime)}`);
  return { filePath, startTime, endTime, mock: false };
}

module.exports = { listAll, getById, selectSegment };

/* ── Internal helpers ─────────────────────────────────────────────────────── */

async function getFileDuration(gameId, filePath) {
  if (durationCache.has(gameId)) return durationCache.get(gameId);

  const ffmpegService = require('./ffmpeg.service');
  const duration = await ffmpegService.probeDuration(filePath);
  durationCache.set(gameId, duration);
  return duration;
}

function pickStartTime(gameId, totalDuration, segmentDuration) {
  const recent = (usedRanges.get(gameId) || []).filter(
    (r) => Date.now() - r.usedAt < AVOID_REUSE_S * 1000
  );

  const maxStart = totalDuration - segmentDuration - 5; // 5s buffer at end

  // Try up to 20 random picks to find a fresh timestamp
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = Math.random() * maxStart;

    const tooClose = recent.some(
      (r) => Math.abs(candidate - r.start) < COOLDOWN_RANGE
    );

    if (!tooClose) return candidate;
  }

  // Fallback: just pick random (all segments recently used — rare)
  return Math.random() * maxStart;
}

function recordUsage(gameId, start, end) {
  if (!usedRanges.has(gameId)) usedRanges.set(gameId, []);
  const ranges = usedRanges.get(gameId);
  ranges.push({ start, end, usedAt: Date.now() });

  // Purge old entries
  const cutoff = Date.now() - AVOID_REUSE_S * 1000;
  const fresh  = ranges.filter((r) => r.usedAt > cutoff);
  usedRanges.set(gameId, fresh);
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

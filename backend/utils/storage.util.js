'use strict';
/**
 * storage.util.js
 * ───────────────
 * Ensures all required storage directories exist on startup.
 * Provides helper functions for computing job-specific paths.
 */

const fs   = require('fs');
const path = require('path');

const STORAGE_ROOT = path.resolve(resolveStorageRoot());

/**
 * Where job output, temp files, the job store and the user store live.
 *
 * On Railway this MUST be a mounted volume or a redeploy deletes every video
 * and every subscription record. Railway automatically exposes
 * RAILWAY_VOLUME_MOUNT_PATH when a volume is attached, so prefer that over a
 * hardcoded path. Locally it falls back to ./storage.
 *
 * Order: explicit STORAGE_ROOT -> Railway volume mount -> ./storage
 */
function resolveStorageRoot() {
  if (process.env.STORAGE_ROOT) return process.env.STORAGE_ROOT;
  const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (process.env.RAILWAY && volumePath) {
    console.log(`[Storage] Using Railway volume at ${volumePath}`);
    return volumePath;
  }
  return './storage';
}

const DIRS = [
  'gameplay',
  'temp',
  'audio',
  'subtitles',
  'outputs',
];

async function initStorage() {
  for (const dir of DIRS) {
    const fullPath = path.join(STORAGE_ROOT, dir);
    fs.mkdirSync(fullPath, { recursive: true });
  }
  console.log(`[Storage] Directories ready at ${STORAGE_ROOT}`);
}

function jobTempDir(jobId) {
  return path.join(STORAGE_ROOT, 'temp', jobId);
}

function outputDir() {
  return path.join(STORAGE_ROOT, 'outputs');
}

function gameplayDir() {
  return path.join(STORAGE_ROOT, 'gameplay');
}

module.exports = { initStorage, jobTempDir, outputDir, gameplayDir, STORAGE_ROOT };

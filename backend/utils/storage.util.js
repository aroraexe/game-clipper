'use strict';
/**
 * storage.util.js
 * ───────────────
 * Ensures all required storage directories exist on startup.
 * Provides helper functions for computing job-specific paths.
 */

const fs   = require('fs');
const path = require('path');

const STORAGE_ROOT = path.resolve(process.env.STORAGE_ROOT || './storage');

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

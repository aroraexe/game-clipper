'use strict';
/**
 * In-memory job store.
 * All job state lives here; no DB required.
 * Keys: jobId → Job object
 */

const fs = require('fs');
const path = require('path');
const STORE_PATH = path.join(__dirname, '../../storage/jobStore.json');

let jobs = new Map();

function loadStore() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
      jobs = new Map(Object.entries(data));
      console.log(`[JobStore] Loaded ${jobs.size} job(s) from disk`);
    }
  } catch (err) {
    // Never silently continue with an empty store — that reads as total data loss.
    console.error('[JobStore] CRITICAL: could not parse store:', err.message);
    const backup = `${STORE_PATH}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(STORE_PATH, backup);
      console.error('[JobStore] Corrupt file preserved at:', backup);
    } catch (_) { /* nothing further we can do here */ }
    throw err;
  }
}

/**
 * Serialise to a temp file, then rename over the real path.
 * rename() is atomic on POSIX and Windows, so an interrupted write can never
 * leave a half-written jobStore.json behind. Saves are also coalesced per tick
 * because a single render fires many updates in quick succession.
 */
let saveScheduled = false;
function writeStoreNow() {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    const tmp = `${STORE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(jobs)), 'utf8');
    fs.renameSync(tmp, STORE_PATH);
  } catch (err) {
    console.error('[JobStore] Failed to save store:', err.message);
  }
}

function saveStore() {
  if (saveScheduled) return;
  saveScheduled = true;
  setImmediate(() => {
    saveScheduled = false;
    writeStoreNow();
  });
}

/** Force an immediate synchronous flush (tests, process shutdown). */
function flush() {
  writeStoreNow();
}

loadStore();

const VALID_STATUSES = ['queued', 'processing', 'completed', 'failed'];
const VALID_STAGES   = [
  'preparing_story', 'generating_voice', 'transcribing',
  'creating_subtitles', 'generating_assets', 'selecting_gameplay', 'trimming_gameplay',
  'compositing', 'finalizing', 'retrying',
];

function create(jobId, params) {
  const job = {
    jobId,
    status:        'queued',
    stage:         null,
    progress:      0,          // 0-100
    error:         null,
    outputPath:    null,
    tempDir:       null,
    userId:        params.userId || null,
    params,
    queuePosition: 0,          // position in queue (0 = running)
    etaMs:         0,          // estimated ms until job starts
    createdAt:     new Date().toISOString(),
    updatedAt:     new Date().toISOString(),
  };
  jobs.set(jobId, job);
  saveStore();
  return job;
}

function get(jobId) {
  return jobs.get(jobId) || null;
}

function update(jobId, patch) {
  const job = jobs.get(jobId);
  if (!job) throw new Error(`Job ${jobId} not found in store`);
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  saveStore();
  return job;
}

function setStage(jobId, stage, progress) {
  if (stage && !VALID_STAGES.includes(stage)) {
    console.warn(`[JobStore] Warning: Invalid stage '${stage}' for job ${jobId}`);
  }
  return update(jobId, { stage, progress: progress ?? jobs.get(jobId)?.progress });
}

function setStatus(jobId, status, extra = {}) {
  if (status && !VALID_STATUSES.includes(status)) {
    console.warn(`[JobStore] Warning: Invalid status '${status}' for job ${jobId}`);
  }
  return update(jobId, { status, ...extra });
}

function markFailed(jobId, err) {
  const job = jobs.get(jobId);
  if (job && (job.status === 'completed' || job.status === 'failed')) return job;
  const message = err instanceof Error ? err.message : String(err);
  return update(jobId, {
    status:  'failed',
    error:   message,
    stage:   null,
    progress: 100,
  });
}

function markCompleted(jobId, outputPath) {
  const job = jobs.get(jobId);
  if (job && (job.status === 'completed' || job.status === 'failed')) return job;
  return update(jobId, {
    status:     'completed',
    stage:      'finalizing',
    progress:   100,
    outputPath,
  });
}

function list() {
  return Array.from(jobs.values());
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Find a recent job created with this Idempotency-Key by this user.
 * Keys older than the TTL are ignored so the table cannot grow without bound.
 */
function findByIdempotencyKey(key, userId) {
  if (!key) return null;
  const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
  for (const job of jobs.values()) {
    if (job.params?.idempotencyKey !== key) continue;
    if (job.params?.userId !== userId) continue;
    if (new Date(job.createdAt).getTime() < cutoff) continue;
    return job;
  }
  return null;
}

function removeJob(jobId) {
  jobs.delete(jobId);
  saveStore();
}

module.exports = {
  create, get, update, setStage, setStatus,
  markFailed, markCompleted, list, removeJob,
  findByIdempotencyKey, flush,
};

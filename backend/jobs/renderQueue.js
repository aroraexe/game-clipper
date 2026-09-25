'use strict';
/**
 * renderQueue.js
 * ──────────────
 * Priority task scheduler using Node.js worker_threads.
 *
 * Features:
 *  - Priority queue  : 'high' priority jobs skip ahead of 'normal' jobs
 *  - Auto-retry      : failed jobs are retried up to MAX_RETRIES times
 *  - Queue position  : jobs know their position + estimated wait time
 *  - CPU-optimised   : concurrency tuned for CPU-only libx264 encoding
 */

const { Worker }  = require('worker_threads');
const path        = require('path');
const os          = require('os');
const jobStore    = require('./jobStore');

/* ── Concurrency ─────────────────────────────────────────────────────────── */
// CPU-only: libx264 with -threads 0 uses ALL cores per job.
// Running N concurrent jobs splits cores N-ways — 1 job at a time is fastest
// per-job, but we allow 2 so the server stays responsive under load.
const cpus  = os.cpus().length;
const ramGb = os.totalmem() / 1024 / 1024 / 1024;
console.log(`[Hardware] CPU Cores: ${cpus} | RAM: ${ramGb.toFixed(1)}GB | NVIDIA GPU: No`);

const envMax = parseInt(process.env.MAX_CONCURRENT_RENDERS, 10);
const MAX_CONCURRENT = !isNaN(envMax) && envMax > 0
  ? envMax
  : Math.min(2, Math.max(1, Math.floor(cpus / 4)));   // e.g. 16 cores → 2 workers

const MAX_RETRIES = parseInt(process.env.JOB_MAX_RETRIES, 10) || 2;

console.log(`[Queue] Worker concurrency: ${MAX_CONCURRENT} | Max retries: ${MAX_RETRIES}`);

/* ── State ───────────────────────────────────────────────────────────────── */
// Each item: { jobId, priority: 'high'|'normal', retries: 0, enqueuedAt }
const highQueue   = [];   // high-priority FIFO
const normalQueue = [];   // normal-priority FIFO
let   active      = 0;   // currently running workers
const retryMap    = new Map();  // jobId → retry count

const WORKER_PATH = path.join(__dirname, 'renderWorker.js');

/* ── Avg encode time tracker (for ETA estimation) ────────────────────────── */
const recentTimes = [];   // last N completed job durations (ms)
const RECENT_N    = 5;
let   avgEncodeMs = 90_000;   // initial assumption: 90 s per job

function recordCompletionTime(ms) {
  recentTimes.push(ms);
  if (recentTimes.length > RECENT_N) recentTimes.shift();
  avgEncodeMs = recentTimes.reduce((a, b) => a + b, 0) / recentTimes.length;
}

/* ── Public API ──────────────────────────────────────────────────────────── */

/**
 * enqueue(jobId, priority?)
 * @param {string} jobId
 * @param {'high'|'normal'} priority  defaults to 'normal'
 */
function enqueue(jobId, priority = 'normal') {
  const item = { jobId, priority, enqueuedAt: Date.now() };
  if (priority === 'high') {
    highQueue.push(item);
  } else {
    normalQueue.push(item);
  }
  retryMap.set(jobId, 0);
  _updateQueuePositions();
  console.log(`[Queue] Enqueued job ${jobId.slice(0,8)} (priority: ${priority}, queue depth: ${_totalDepth()})`);
  drain();
}

module.exports = { enqueue };

/* ── Internal ────────────────────────────────────────────────────────────── */

function drain() {
  while (active < MAX_CONCURRENT && _totalDepth() > 0) {
    const item = highQueue.length > 0 ? highQueue.shift() : normalQueue.shift();
    active++;
    _updateQueuePositions();
    _runInWorker(item);
  }
}

function _totalDepth() {
  return highQueue.length + normalQueue.length;
}

/** Write queue positions + ETA into each waiting job in the store */
function _updateQueuePositions() {
  const all = [...highQueue, ...normalQueue];
  all.forEach((item, idx) => {
    const queuePos = idx + 1;
    const etaMs    = queuePos * avgEncodeMs;
    try {
      jobStore.update(item.jobId, { queuePosition: queuePos, etaMs });
    } catch (_) {}
  });
}

function _runInWorker(item) {
  const { jobId } = item;
  const startTime = Date.now();

  console.log(`[Queue] ▶ Starting job ${jobId.slice(0,8)}  (active: ${active}, queued: ${_totalDepth()})`);

  const job = jobStore.get(jobId);
  if (!job) {
    console.error(`[Queue] Job ${jobId} not found in store — skipping`);
    active--;
    drain();
    return;
  }

  // Clear queue position now that it's running
  try { jobStore.update(jobId, { queuePosition: 0, etaMs: 0 }); } catch (_) {}

  const worker = new Worker(WORKER_PATH, { workerData: { job } });

  worker.on('message', (msg) => {
    if (msg.type === 'STAGE')     jobStore.setStage(msg.jobId, msg.stageName, msg.progress);
    if (msg.type === 'UPDATE')    jobStore.update(msg.jobId, msg.patch);
    if (msg.type === 'STATUS')    jobStore.setStatus(msg.jobId, msg.status);
    if (msg.type === 'COMPLETED') {
      jobStore.markCompleted(msg.jobId, msg.outputPath);
      recordCompletionTime(Date.now() - startTime);
    }
    if (msg.type === 'ERROR')     jobStore.markFailed(msg.jobId, new Error(msg.error));
  });

  worker.on('error', (err) => {
    console.error(`[Queue] Worker error for job ${jobId.slice(0,8)}:`, err.message);
    _handleFailure(jobId, item, err);
  });

  worker.on('exit', (code) => {
    active--;
    if (code !== 0) {
      console.error(`[Queue] Worker for job ${jobId.slice(0,8)} exited with code ${code}`);
      _handleFailure(jobId, item, new Error(`Worker exited with code ${code}`));
    } else {
      console.log(`[Queue] ✓ Job ${jobId.slice(0,8)} done  (active: ${active})`);
      retryMap.delete(jobId);
    }
    _updateQueuePositions();
    drain();
  });
}

/** Retry on transient failure, or permanently fail after MAX_RETRIES */
function _handleFailure(jobId, item, err) {
  const attempts = (retryMap.get(jobId) || 0) + 1;
  retryMap.set(jobId, attempts);

  if (attempts <= MAX_RETRIES) {
    const delay = attempts * 2000;   // back-off: 2 s, 4 s …
    console.warn(`[Queue] ↻ Retrying job ${jobId.slice(0,8)} (attempt ${attempts}/${MAX_RETRIES}) in ${delay}ms`);
    jobStore.setStage(jobId, 'retrying', 0);
    setTimeout(() => {
      // Re-enqueue at same priority
      if (item.priority === 'high') highQueue.unshift(item);
      else normalQueue.unshift(item);
      _updateQueuePositions();
      drain();
    }, delay);
  } else {
    console.error(`[Queue] ✗ Job ${jobId.slice(0,8)} permanently failed after ${MAX_RETRIES} retries`);
    try { jobStore.markFailed(jobId, err); } catch (_) {}
    retryMap.delete(jobId);
  }
}

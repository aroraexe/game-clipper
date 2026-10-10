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
// CPU-only: libx264 renders are capped at 2 threads each (see ffmpeg.service.js)
// so the server stays responsive on a small Railway container.
//
// NOTE: this used to be `Math.max(2, cpus)`, which was backwards. An earlier
// version of the pipeline also passed `-threads 0` (all cores), so concurrency of
// `cpus` meant cpus² threads competing for cpus cores — 256 threads on a 16-core
// host, which is slower than serial rather than faster. Concurrency must stay a
// small constant, not a multiple of the core count.
const cpus  = os.cpus().length;
const ramGb = os.totalmem() / 1024 / 1024 / 1024;
console.log(`[Hardware] CPU Cores: ${cpus} | RAM: ${ramGb.toFixed(1)}GB | NVIDIA GPU: No (Railway Hobby)`);

const envMax = parseInt(process.env.MAX_CONCURRENT_RENDERS, 10);
// 0 is a meaningful value: it disables rendering entirely, which is what the test
// suites want when importing server.js (which loads this module) so a queued job
// cannot start a real FFmpeg/TTS/LLM pipeline. It used to be unreachable — the
// old `envMax > 0` test sent 0 to the default of 1 worker, so tests really
// rendered, and opencode logged live NVIDIA calls made by the suite.
const MAX_CONCURRENT = !isNaN(envMax) && envMax >= 0
  ? envMax
  : 1;   // Strictly 1 for Railway Hobby Plan to prevent OOM/CPU starvation

const MAX_RETRIES = parseInt(process.env.JOB_MAX_RETRIES, 10) || 2;

if (MAX_CONCURRENT === 0) {
  console.warn('[Queue] MAX_CONCURRENT_RENDERS=0 — rendering is DISABLED.');
}
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

function initQueue() {
  const allJobs = jobStore.list();
  let pending = allJobs.filter(j => j.status === 'queued' || j.status === 'processing');

  // A queued job with no gameplayId can never render — the pipeline rejects it
  // on its first line. Enqueueing it anyway meant every boot spent a worker
  // spawn and MAX_RETRIES retries to arrive at a failure that was knowable at
  // load time, which is how a leftover fixture kept breaking server start.
  // Fail these fast so the operator sees the cause instead of a retry storm.
  const unrecoverable = pending.filter(j => !j.params || !j.params.gameplayId);
  if (unrecoverable.length > 0) {
    unrecoverable.forEach(job => {
      const reason = 'Job has no gameplayId and cannot be rendered. It was queued without valid parameters.';
      console.error(`[Queue] Dropping unrecoverable job ${job.jobId}: ${reason}`);
      jobStore.markFailed(job.jobId, reason);
    });
    pending = pending.filter(j => !unrecoverable.includes(j));
  }

  if (pending.length > 0) {
    console.log(`[Queue] Recovering ${pending.length} pending jobs from store...`);
    // Ensure any 'processing' jobs are reset to 'queued' since they died mid-flight
    pending.forEach(job => {
      if (job.status === 'processing') jobStore.setStatus(job.jobId, 'queued');
      enqueue(job.jobId);
    });
  }
}

// Run init immediately on load
initQueue();

/** Snapshot for /api/health — safe to expose (no job ids / user data). */
function getStats() {
  return {
    maxConcurrent: MAX_CONCURRENT,
    active,
    queued: _totalDepth(),
    highPriorityQueued: highQueue.length,
    avgEncodeMs: Math.round(avgEncodeMs),
  };
}

module.exports = { enqueue, initQueue, getStats };

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
  let completed = false;
  let terminalError = null;

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

  let worker;
  try {
    worker = new Worker(WORKER_PATH, { workerData: { job } });
  } catch (err) {
    console.error(`[Queue] Failed to spawn worker for job ${jobId}:`, err);
    jobStore.markFailed(jobId, `System error: could not start rendering worker.`);
    active--;
    drain();
    return;
  }

  worker.on('message', (msg) => {
    try {
      if (msg.type === 'STAGE')     jobStore.setStage(msg.jobId, msg.stageName, msg.progress);
      if (msg.type === 'UPDATE')    jobStore.update(msg.jobId, msg.patch);
      if (msg.type === 'STATUS')    jobStore.setStatus(msg.jobId, msg.status);
      if (msg.type === 'COMPLETED') {
        jobStore.markCompleted(msg.jobId, msg.outputPath);
        recordCompletionTime(Date.now() - startTime);
        completed = true;
      }
      if (msg.type === 'FATAL') {
        terminalError = new Error(msg.error || 'Worker failed');
      }
      if (msg.type === 'ERROR')     terminalError = new Error(msg.error || 'Worker failed');
    } catch (err) {
      console.warn(`[Queue] Failed to update job ${msg.jobId}: ${err.message}`);
    }
  });

  worker.on('error', (err) => {
    console.error(`[Queue] Worker error for job ${jobId.slice(0,8)}:`, err.message);
    terminalError = err;
  });

  worker.on('exit', (code) => {
    active--;
    if (completed && code === 0) {
      console.log(`[Queue] ✓ Job ${jobId.slice(0,8)} done  (active: ${active})`);
      retryMap.delete(jobId);
    } else {
      const err = terminalError || new Error(`Worker exited before completion${code !== 0 ? ` with code ${code}` : ''}`);
      if (code !== 0) console.error(`[Queue] Worker for job ${jobId.slice(0,8)} exited with code ${code}`);
      _handleFailure(jobId, item, err);
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

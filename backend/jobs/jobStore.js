'use strict';
/**
 * In-memory job store.
 * All job state lives here; no DB required.
 * Keys: jobId → Job object
 */

const jobs = new Map();

const VALID_STATUSES = ['queued', 'processing', 'completed', 'failed'];
const VALID_STAGES   = [
  'preparing_story', 'generating_voice', 'transcribing',
  'creating_subtitles', 'selecting_gameplay', 'trimming_gameplay',
  'compositing', 'encoding', 'finalizing',
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
    params,
    queuePosition: 0,          // position in queue (0 = running)
    etaMs:         0,          // estimated ms until job starts
    createdAt:     new Date().toISOString(),
    updatedAt:     new Date().toISOString(),
  };
  jobs.set(jobId, job);
  return job;
}

function get(jobId) {
  return jobs.get(jobId) || null;
}

function update(jobId, patch) {
  const job = jobs.get(jobId);
  if (!job) throw new Error(`Job ${jobId} not found in store`);
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  return job;
}

function setStage(jobId, stage, progress) {
  return update(jobId, { stage, progress: progress ?? jobs.get(jobId)?.progress });
}

function setStatus(jobId, status, extra = {}) {
  return update(jobId, { status, ...extra });
}

function markFailed(jobId, err) {
  const message = err instanceof Error ? err.message : String(err);
  return update(jobId, {
    status:  'failed',
    error:   message,
    stage:   null,
    progress: 100,
  });
}

function markCompleted(jobId, outputPath) {
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

function removeJob(jobId) {
  jobs.delete(jobId);
}

module.exports = { create, get, update, setStage, setStatus, markFailed, markCompleted, list, removeJob };

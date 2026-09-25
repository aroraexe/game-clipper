'use strict';
/**
 * renderWorker.js
 * ────────────────
 * Entry point for the worker thread.
 * Receives the job object via workerData, and executes the pipeline.
 */

const { workerData, parentPort } = require('worker_threads');
const renderPipeline = require('../services/render.service');

// workerData contains { job }
renderPipeline(workerData.job)
  .then(() => {
    parentPort.postMessage({ type: 'DONE' });
  })
  .catch((err) => {
    // Error is already reported to jobStore via render.service.js, but we notify main thread anyway
    parentPort.postMessage({ type: 'FATAL', error: err.message });
  });

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Isolate storage root for tests
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-test-'));
process.env.STORAGE_ROOT = tmpDir;
process.env.MAX_CONCURRENT_RENDERS = '0'; // Keep workers idle so we can inspect queued state deterministically

const storageUtil = require('../backend/utils/storage.util');
const jobStore = require('../backend/jobs/jobStore');
const renderQueue = require('../backend/jobs/renderQueue');
const videosController = require('../backend/controllers/videos.controller');

beforeEach(async () => {
  await storageUtil.initStorage();
  jobStore.list().forEach((j) => jobStore.removeJob(j.jobId));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('real-time render queue tracking', () => {
  it('accurately reports queue position and ETA for queued jobs', () => {
    const j1 = jobStore.create('job-queue-1', { userId: 'u1', story: 'First clip' });
    const j2 = jobStore.create('job-queue-2', { userId: 'u2', story: 'Second clip' });

    renderQueue.enqueue('job-queue-1', 'normal');
    renderQueue.enqueue('job-queue-2', 'normal');

    const pos1 = renderQueue.getJobQueuePosition('job-queue-1');
    const pos2 = renderQueue.getJobQueuePosition('job-queue-2');

    expect(pos1.inQueue).toBe(true);
    expect(pos1.queuePosition).toBe(1);
    expect(pos1.ahead).toBe(0);
    expect(pos1.totalQueued).toBe(2);
    expect(pos1.etaSeconds).toBeGreaterThan(0);

    expect(pos2.inQueue).toBe(true);
    expect(pos2.queuePosition).toBe(2);
    expect(pos2.ahead).toBe(1);
    expect(pos2.totalQueued).toBe(2);
    expect(pos2.etaSeconds).toBeGreaterThan(pos1.etaSeconds);
  });

  it('exposes global queue status endpoint data', () => {
    let capturedJson = null;
    const req = {};
    const res = {
      json: (data) => { capturedJson = data; return res; },
      status: () => res,
    };

    videosController.getQueueStatus(req, res);

    expect(capturedJson).not.toBeNull();
    expect(typeof capturedJson.active).toBe('number');
    expect(typeof capturedJson.queued).toBe('number');
    expect(typeof capturedJson.estimatedWaitSeconds).toBe('number');
  });

  it('includes real-time queue details in public job representation', () => {
    const j1 = jobStore.create('job-track-1', { userId: 'u-owner-1', story: 'Clip test' });
    renderQueue.enqueue('job-track-1', 'normal');

    let responseData = null;
    const req = {
      params: { jobId: 'job-track-1' },
      user: { uid: 'u-owner-1' },
    };
    const res = {
      json: (data) => { responseData = data; return res; },
      status: () => res,
    };

    videosController.getJob(req, res, () => {});

    expect(responseData).not.toBeNull();
    expect(responseData.jobId).toBe('job-track-1');
    expect(responseData.status).toBe('queued');
    expect(responseData.queue).toBeDefined();
    expect(responseData.queue.inQueue).toBe(true);
    expect(responseData.queue.queuePosition).toBeGreaterThanOrEqual(1);
    expect(typeof responseData.queue.ahead).toBe('number');
    expect(typeof responseData.queue.etaSeconds).toBe('number');
  });
});

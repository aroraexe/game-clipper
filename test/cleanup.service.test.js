import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Isolate storage root for cleanup tests
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-test-'));
process.env.STORAGE_ROOT = tmpDir;

const storageUtil = require('../backend/utils/storage.util');
const jobStore = require('../backend/jobs/jobStore');
const userStore = require('../backend/jobs/userStore');
const cleanupService = require('../backend/services/cleanup.service');

const HOUR = 60 * 60 * 1000;
const DAY  = 24 * HOUR;

beforeEach(async () => {
  await storageUtil.initStorage();
  jobStore.list().forEach((j) => jobStore.removeJob(j.jobId));

  for (const d of ['temp', 'outputs', 'gameplay', 'audio', 'subtitles']) {
    const full = path.join(tmpDir, d);
    if (fs.existsSync(full)) {
      fs.rmSync(full, { recursive: true, force: true });
      fs.mkdirSync(full, { recursive: true });
    }
  }
});

afterEach(() => {
  cleanupService.stopScheduler();
});

afterAll(() => {
  cleanupService.stopScheduler();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('cleanup.service — expired jobs', () => {
  it('purges free-tier jobs older than 1 hour and deletes their MP4', () => {
    jobStore.create('expired-free', { userId: 'u-free-1', story: 'test' });
    const outPath = path.join(storageUtil.outputDir(), 'expired-free.mp4');
    fs.writeFileSync(outPath, 'fake-video-content-12345');
    jobStore.markCompleted('expired-free', outPath);

    // Artificially age the job to 2 hours ago directly on the store record
    const twoHoursAgo = new Date(Date.now() - 2 * HOUR).toISOString();
    const stored = jobStore.get('expired-free');
    stored.updatedAt = twoHoursAgo;
    stored.createdAt = twoHoursAgo;

    expect(fs.existsSync(outPath)).toBe(true);

    const res = cleanupService.cleanupExpiredJobs(Date.now());
    expect(res.cleared).toBe(1);
    expect(res.bytesReclaimed).toBeGreaterThan(0);
    expect(fs.existsSync(outPath)).toBe(false);
    expect(jobStore.get('expired-free')).toBeNull();
  });

  it('keeps fresh free-tier jobs under 1 hour old', () => {
    jobStore.create('fresh-free', { userId: 'u-free-2', story: 'test' });
    const outPath = path.join(storageUtil.outputDir(), 'fresh-free.mp4');
    fs.writeFileSync(outPath, 'fresh-video-data');
    jobStore.markCompleted('fresh-free', outPath);

    const res = cleanupService.cleanupExpiredJobs(Date.now());
    expect(res.cleared).toBe(0);
    expect(fs.existsSync(outPath)).toBe(true);
    expect(jobStore.get('fresh-free')).not.toBeNull();
  });

  it('preserves Pro-tier jobs up to 7 days, purging only after 7 days', () => {
    userStore.setPlan('u-pro-1', 'pro');

    jobStore.create('pro-job', { userId: 'u-pro-1', story: 'test' });
    const outPath = path.join(storageUtil.outputDir(), 'pro-job.mp4');
    fs.writeFileSync(outPath, 'pro-video-content');
    jobStore.markCompleted('pro-job', outPath);

    // Age to 3 days ago: should be kept for Pro
    const threeDaysAgo = new Date(Date.now() - 3 * DAY).toISOString();
    const stored = jobStore.get('pro-job');
    stored.updatedAt = threeDaysAgo;
    stored.createdAt = threeDaysAgo;

    let res = cleanupService.cleanupExpiredJobs(Date.now());
    expect(res.cleared).toBe(0);
    expect(fs.existsSync(outPath)).toBe(true);

    // Age to 8 days ago: should now be purged
    const eightDaysAgo = new Date(Date.now() - 8 * DAY).toISOString();
    stored.updatedAt = eightDaysAgo;
    stored.createdAt = eightDaysAgo;

    res = cleanupService.cleanupExpiredJobs(Date.now());
    expect(res.cleared).toBe(1);
    expect(fs.existsSync(outPath)).toBe(false);
    expect(jobStore.get('pro-job')).toBeNull();
  });
});

describe('cleanup.service — orphan output files', () => {
  it('deletes untracked MP4 files in outputs/ older than 15 minutes', () => {
    const orphanPath = path.join(storageUtil.outputDir(), 'stray-orphan.mp4');
    fs.writeFileSync(orphanPath, 'orphan-mp4-payload');

    // Set mtime to 30 mins ago
    const thirtyMinsAgo = (Date.now() - 30 * 60 * 1000) / 1000;
    fs.utimesSync(orphanPath, thirtyMinsAgo, thirtyMinsAgo);

    const res = cleanupService.cleanupOrphanOutputs(Date.now());
    expect(res.removed).toBe(1);
    expect(fs.existsSync(orphanPath)).toBe(false);
  });

  it('spares recently written untracked files within 15-minute grace window', () => {
    const recentOrphan = path.join(storageUtil.outputDir(), 'recent-orphan.mp4');
    fs.writeFileSync(recentOrphan, 'recent-payload');

    const res = cleanupService.cleanupOrphanOutputs(Date.now());
    expect(res.removed).toBe(0);
    expect(fs.existsSync(recentOrphan)).toBe(true);
  });
});

describe('cleanup.service — temp sweep', () => {
  it('deletes abandoned temp directories older than 5 minutes', () => {
    const deadTempDir = storageUtil.jobTempDir('dead-job');
    fs.mkdirSync(deadTempDir, { recursive: true });
    fs.writeFileSync(path.join(deadTempDir, 'audio.wav'), 'wav-bits');

    const tenMinsAgo = (Date.now() - 10 * 60 * 1000) / 1000;
    fs.utimesSync(deadTempDir, tenMinsAgo, tenMinsAgo);

    const res = cleanupService.cleanupTemp(Date.now());
    expect(res.removed).toBe(1);
    expect(fs.existsSync(deadTempDir)).toBe(false);
  });

  it('never deletes temp folder of an in-flight (processing/queued) job', () => {
    jobStore.create('live-job-1', { userId: 'u1', story: 'test' });
    jobStore.setStatus('live-job-1', 'processing');

    const liveTempDir = storageUtil.jobTempDir('live-job-1');
    fs.mkdirSync(liveTempDir, { recursive: true });
    fs.writeFileSync(path.join(liveTempDir, 'audio.wav'), 'active-render-audio');

    const tenMinsAgo = (Date.now() - 10 * 60 * 1000) / 1000;
    fs.utimesSync(liveTempDir, tenMinsAgo, tenMinsAgo);

    const res = cleanupService.cleanupTemp(Date.now());
    expect(res.removed).toBe(0);
    expect(fs.existsSync(liveTempDir)).toBe(true);
  });

  it('deletes loose temp files in storage/temp/ older than 5 minutes', () => {
    const looseFile = path.join(tmpDir, 'temp', 'stray.tmp');
    fs.writeFileSync(looseFile, 'stray-data');

    const tenMinsAgo = (Date.now() - 10 * 60 * 1000) / 1000;
    fs.utimesSync(looseFile, tenMinsAgo, tenMinsAgo);

    const res = cleanupService.cleanupTemp(Date.now());
    expect(res.removed).toBe(1);
    expect(fs.existsSync(looseFile)).toBe(false);
  });
});

describe('cleanup.service — stale gameplay assets', () => {
  it('deletes unreferenced assets like roblox.webm while preserving catalogue files', () => {
    const gDir = storageUtil.gameplayDir();
    const staleWebm = path.join(gDir, 'roblox.webm');
    const validMp4  = path.join(gDir, 'roblox_small.mp4');
    const dotFile   = path.join(gDir, '.gitkeep');

    fs.writeFileSync(staleWebm, 'old-corrupted-webm-data');
    fs.writeFileSync(validMp4, 'valid-small-mp4');
    fs.writeFileSync(dotFile, '');

    const res = cleanupService.cleanupStaleGameplay();
    expect(res.removed).toBe(1);
    expect(fs.existsSync(staleWebm)).toBe(false);
    expect(fs.existsSync(validMp4)).toBe(true);
    expect(fs.existsSync(dotFile)).toBe(true);
  });
});

describe('cleanup.service — storage budget enforcement', () => {
  it('auto-prunes oldest completed outputs when total volume exceeds target ceiling', () => {
    const outDir = storageUtil.outputDir();
    const file1 = path.join(outDir, 'oldest.mp4');
    const file2 = path.join(outDir, 'newer.mp4');

    fs.writeFileSync(file1, '1234567890'.repeat(100)); // 1000 bytes
    fs.writeFileSync(file2, '1234567890'.repeat(100)); // 1000 bytes

    const t1 = (Date.now() - 60000) / 1000;
    const t2 = (Date.now() - 10000) / 1000;
    fs.utimesSync(file1, t1, t1);
    fs.utimesSync(file2, t2, t2);

    // Impose an artificial budget of 1500 bytes (file1 + file2 = 2000 bytes + store overhead)
    const budgetRes = cleanupService.enforceStorageBudget(1500);
    expect(budgetRes.pruned).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(file1)).toBe(false); // Oldest pruned first
    expect(fs.existsSync(file2)).toBe(true);  // Newer retained
  });
});

describe('cleanup.service — stats and scheduler', () => {
  it('reports accurate volume breakdown in getStorageStats', () => {
    const stats = cleanupService.getStorageStats();
    expect(stats.totalBytes).toBeGreaterThanOrEqual(0);
    expect(typeof stats.totalMb).toBe('number');
    expect(typeof stats.budgetMaxMb).toBe('number');
    expect(typeof stats.breakdown.gameplayMb).toBe('number');
    expect(typeof stats.breakdown.outputsMb).toBe('number');
  });

  it('cleanupAll runs complete sweep and records last run info', () => {
    const info = cleanupService.cleanupAll();
    expect(info).not.toBeNull();
    expect(info.timestamp).toBeTruthy();
    expect(typeof info.totalReclaimedBytes).toBe('number');
  });
});

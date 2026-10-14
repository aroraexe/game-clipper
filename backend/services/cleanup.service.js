'use strict';
/**
 * cleanup.service.js
 * ───────────────────
 * Automated, proactive self-cleaning for StoryPlay storage volume:
 *
 * 1. Expired job outputs: Removes completed/failed videos past retention (1hr Free, 7d Pro).
 * 2. Orphaned outputs: Scans outputs/ for video files untracked by jobStore (>15m old).
 * 3. Temp files & directories: Purges stalled/crashed render temp folders (>5m old)
 *    and loose temp files while protecting in-flight jobs.
 * 4. Stale gameplay assets: Deletes unreferenced assets (e.g. stale roblox.webm from old deploys)
 *    to reclaim ~45MB+ immediately.
 * 5. Stray folders: Sweeps empty/stray files in audio/ and subtitles/.
 * 6. Storage budget enforcement: Keeps total storage under budget (default 380MB on 500MB volume)
 *    by auto-pruning oldest completed outputs before disk space exhaustion (ENOSPC).
 * 7. Self-cleaning scheduler: Runs at startup and every 5 minutes.
 */

const fs   = require('fs');
const path = require('path');
const { STORAGE_ROOT, outputDir, gameplayDir, jobTempDir } = require('../utils/storage.util');

const DEFAULT_TEMP_MIN_AGE_MS = 5 * 60 * 1000;      // 5 minutes
const DEFAULT_ORPHAN_MIN_AGE_MS = 15 * 60 * 1000;   // 15 minutes
const DEFAULT_STRAY_MIN_AGE_MS = 5 * 60 * 1000;     // 5 minutes
const DEFAULT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;  // 5 minutes

// 380 MB default limit leaves ample room on a 500MB Railway volume for in-flight encodes and temp files
const DEFAULT_STORAGE_MAX_BYTES = process.env.STORAGE_MAX_MB
  ? parseInt(process.env.STORAGE_MAX_MB, 10) * 1024 * 1024
  : 380 * 1024 * 1024;

let lastRunInfo = {
  timestamp: null,
  totalReclaimedBytes: 0,
  details: null,
};

let schedulerTimer = null;

/**
 * Recursively calculate total size in bytes of a directory or file.
 */
function getDirSize(targetPath) {
  let size = 0;
  try {
    if (!fs.existsSync(targetPath)) return 0;
    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) return stat.size;

    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(targetPath, entry.name);
      try {
        if (entry.isDirectory()) {
          size += getDirSize(full);
        } else if (entry.isFile()) {
          size += fs.statSync(full).size;
        }
      } catch (_) {}
    }
  } catch (_) {}
  return size;
}

/**
 * 1. Expired Jobs: Remove completed/failed jobs from jobStore & disk when retention expires.
 */
function cleanupExpiredJobs(now = Date.now()) {
  const { list, removeJob } = require('../jobs/jobStore');
  const userStore = require('../jobs/userStore');
  const { planFor } = require('../config/plans');

  let cleared = 0;
  let bytesReclaimed = 0;

  for (const job of list()) {
    const terminal = job.status === 'completed' || job.status === 'failed';
    if (!terminal) continue;

    const plan = planFor((uid) => userStore.planNameFor(uid), job.userId);
    const finishedAt = new Date(job.updatedAt || job.createdAt).getTime();
    if (now - finishedAt < plan.retentionMs) continue;

    if (job.outputPath) {
      try {
        if (fs.existsSync(job.outputPath)) {
          const sz = fs.statSync(job.outputPath).size;
          fs.rmSync(job.outputPath, { force: true });
          bytesReclaimed += sz;
        }
      } catch (_) {}
    }

    // Also remove any remaining job temp dir if present
    try {
      const tempPath = jobTempDir(job.jobId);
      if (fs.existsSync(tempPath)) {
        const sz = getDirSize(tempPath);
        fs.rmSync(tempPath, { recursive: true, force: true });
        bytesReclaimed += sz;
      }
    } catch (_) {}

    removeJob(job.jobId);
    cleared++;
  }

  return { cleared, bytesReclaimed };
}

/**
 * 2. Orphan Outputs: Remove video files in outputs/ that are not referenced by any job in jobStore.
 */
function cleanupOrphanOutputs(now = Date.now(), minAgeMs = DEFAULT_ORPHAN_MIN_AGE_MS) {
  const { list } = require('../jobs/jobStore');
  const outDir = outputDir();
  let removed = 0;
  let bytesReclaimed = 0;

  if (!fs.existsSync(outDir)) return { removed, bytesReclaimed };

  const knownOutputPaths = new Set(
    list()
      .map((j) => (j.outputPath ? path.resolve(j.outputPath) : null))
      .filter(Boolean)
  );

  let entries;
  try {
    entries = fs.readdirSync(outDir, { withFileTypes: true });
  } catch (_) {
    return { removed, bytesReclaimed };
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(outDir, entry.name);
    const resolved = path.resolve(full);

    // If part of an active/unexpired tracked job, leave it to cleanupExpiredJobs
    if (knownOutputPaths.has(resolved)) continue;

    try {
      const stat = fs.statSync(full);
      const age = now - stat.mtimeMs;
      if (age < minAgeMs) continue; // Allow grace period for in-flight writes

      const sz = stat.size;
      fs.rmSync(full, { force: true });
      removed++;
      bytesReclaimed += sz;
      console.log(`[Cleanup] Removed orphan output: ${entry.name} (${(sz / 1024 / 1024).toFixed(1)}MB)`);
    } catch (e) {
      console.warn(`[Cleanup] Could not remove orphan output ${entry.name}: ${e.message}`);
    }
  }

  return { removed, bytesReclaimed };
}

/**
 * 3. Temp items: Purge stale render directories and loose files in storage/temp/.
 */
function cleanupTemp(now = Date.now(), minAgeMs = DEFAULT_TEMP_MIN_AGE_MS) {
  const { list } = require('../jobs/jobStore');
  const tempRoot = path.join(STORAGE_ROOT, 'temp');
  let removed = 0;
  let bytesReclaimed = 0;

  if (!fs.existsSync(tempRoot)) return { removed, bytesReclaimed };

  const live = new Set(
    list()
      .filter((j) => j.status === 'queued' || j.status === 'processing')
      .map((j) => j.jobId)
  );

  let entries;
  try {
    entries = fs.readdirSync(tempRoot, { withFileTypes: true });
  } catch (_) {
    return { removed, bytesReclaimed };
  }

  for (const entry of entries) {
    const full = path.join(tempRoot, entry.name);

    // Never touch a live job directory
    if (live.has(entry.name)) continue;

    try {
      const stat = fs.statSync(full);
      const age = now - stat.mtimeMs;
      if (age < minAgeMs) continue;

      if (entry.isDirectory()) {
        const sz = getDirSize(full);
        fs.rmSync(full, { recursive: true, force: true });
        removed++;
        bytesReclaimed += sz;
      } else if (entry.isFile()) {
        const sz = stat.size;
        fs.rmSync(full, { force: true });
        removed++;
        bytesReclaimed += sz;
      }
    } catch (e) {
      console.warn(`[Cleanup] Could not remove temp entry ${entry.name}: ${e.message}`);
    }
  }

  if (removed > 0) {
    console.log(`[Cleanup] Removed ${removed} abandoned render temp item(s) (${(bytesReclaimed / 1024 / 1024).toFixed(1)}MB).`);
  }

  return { removed, bytesReclaimed };
}

/**
 * 4. Stale Gameplay: Remove unreferenced assets in gameplay/ (e.g. stale roblox.webm).
 */
function cleanupStaleGameplay() {
  const gDir = gameplayDir();
  let removed = 0;
  let bytesReclaimed = 0;

  if (!fs.existsSync(gDir)) return { removed, bytesReclaimed };

  let validFiles;
  try {
    validFiles = require('./gameplay.service').VALID_GAMEPLAY_FILES;
  } catch (_) {
    return { removed, bytesReclaimed };
  }

  if (!validFiles) return { removed, bytesReclaimed };

  let entries;
  try {
    entries = fs.readdirSync(gDir, { withFileTypes: true });
  } catch (_) {
    return { removed, bytesReclaimed };
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    // Keep dotfiles like .gitkeep
    if (entry.name.startsWith('.')) continue;

    if (!validFiles.has(entry.name)) {
      const full = path.join(gDir, entry.name);
      try {
        const sz = fs.statSync(full).size;
        fs.rmSync(full, { force: true });
        removed++;
        bytesReclaimed += sz;
        console.log(`[Cleanup] Removed stale gameplay asset: ${entry.name} (${(sz / 1024 / 1024).toFixed(1)}MB)`);
      } catch (e) {
        console.warn(`[Cleanup] Could not remove stale gameplay asset ${entry.name}: ${e.message}`);
      }
    }
  }

  return { removed, bytesReclaimed };
}

/**
 * 5. Stray folders: Clean audio/ and subtitles/ of abandoned files.
 */
function cleanupStrayDirs(now = Date.now(), minAgeMs = DEFAULT_STRAY_MIN_AGE_MS) {
  let removed = 0;
  let bytesReclaimed = 0;
  const strayDirs = ['audio', 'subtitles'].map((d) => path.join(STORAGE_ROOT, d));

  for (const dir of strayDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        try {
          const stat = fs.statSync(full);
          if (now - stat.mtimeMs < minAgeMs) continue;
          const sz = entry.isDirectory() ? getDirSize(full) : stat.size;
          fs.rmSync(full, { recursive: true, force: true });
          removed++;
          bytesReclaimed += sz;
        } catch (_) {}
      }
    } catch (_) {}
  }

  return { removed, bytesReclaimed };
}

/**
 * 6. Storage Budget Enforcement (Emergency Headroom Protection):
 * If total volume size exceeds the target ceiling, auto-evict oldest completed
 * video files until disk usage drops safely below the budget.
 */
function enforceStorageBudget(targetMaxBytes = null) {
  const maxBytes = targetMaxBytes || DEFAULT_STORAGE_MAX_BYTES;
  let currentBytes = getDirSize(STORAGE_ROOT);

  if (currentBytes <= maxBytes) return { pruned: 0, bytesReclaimed: 0 };

  console.warn(
    `[Cleanup] Storage volume (${(currentBytes / 1024 / 1024).toFixed(1)}MB) exceeds budget (${(maxBytes / 1024 / 1024).toFixed(1)}MB). Auto-pruning oldest renders to prevent disk overflow...`
  );

  const { list, removeJob } = require('../jobs/jobStore');
  const outDir = outputDir();
  let pruned = 0;
  let bytesReclaimed = 0;

  if (fs.existsSync(outDir)) {
    let files = [];
    try {
      const entries = fs.readdirSync(outDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const full = path.join(outDir, entry.name);
        try {
          const stat = fs.statSync(full);
          files.push({ name: entry.name, full, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch (_) {}
      }
    } catch (_) {}

    // Oldest files first (LRU eviction)
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);

    const jobsByOutput = new Map();
    for (const j of list()) {
      if (j.outputPath) {
        jobsByOutput.set(path.resolve(j.outputPath), j.jobId);
      }
    }

    for (const f of files) {
      if (currentBytes <= maxBytes) break;
      try {
        fs.rmSync(f.full, { force: true });
        currentBytes -= f.size;
        bytesReclaimed += f.size;
        pruned++;

        const jobId = jobsByOutput.get(path.resolve(f.full));
        if (jobId) {
          removeJob(jobId);
        }
        console.log(`[Cleanup] Budget eviction: deleted oldest output ${f.name} (${(f.size / 1024 / 1024).toFixed(1)}MB)`);
      } catch (e) {
        console.warn(`[Cleanup] Failed to evict ${f.name}: ${e.message}`);
      }
    }
  }

  return { pruned, bytesReclaimed };
}

/**
 * Fast check after render completion: sweeps temp and checks budget.
 */
function checkTempAndBudget() {
  try {
    cleanupTemp();
    enforceStorageBudget();
  } catch (err) {
    console.warn('[Cleanup] checkTempAndBudget error:', err.message);
  }
}

/**
 * Execute the full comprehensive self-cleaning suite.
 */
function cleanupAll(now = Date.now()) {
  try {
    const expired  = cleanupExpiredJobs(now);
    const orphans  = cleanupOrphanOutputs(now);
    const temp     = cleanupTemp(now);
    const gameplay = cleanupStaleGameplay();
    const stray    = cleanupStrayDirs(now);
    const budget   = enforceStorageBudget();

    const totalReclaimed =
      expired.bytesReclaimed +
      orphans.bytesReclaimed +
      temp.bytesReclaimed +
      gameplay.bytesReclaimed +
      stray.bytesReclaimed +
      budget.bytesReclaimed;

    lastRunInfo = {
      timestamp: new Date().toISOString(),
      totalReclaimedBytes: totalReclaimed,
      details: {
        expiredJobs:   expired.cleared,
        orphanOutputs: orphans.removed,
        tempItems:     temp.removed,
        staleGameplay: gameplay.removed,
        strayItems:    stray.removed,
        budgetEvicted: budget.pruned,
      },
    };

    if (totalReclaimed > 0) {
      console.log(
        `[Cleanup] Self-cleaning sweep complete: reclaimed ${(totalReclaimed / 1024 / 1024).toFixed(2)}MB. Current volume usage: ${(getDirSize(STORAGE_ROOT) / 1024 / 1024).toFixed(1)}MB.`
      );
    }

    return lastRunInfo;
  } catch (err) {
    console.error('[Cleanup] Error during storage cleanup sweep:', err.message);
    return null;
  }
}

/**
 * Storage metrics report for /api/health and monitoring.
 */
function getStorageStats() {
  const gDir = gameplayDir();
  const oDir = outputDir();
  const tDir = path.join(STORAGE_ROOT, 'temp');

  const gameplayBytes = getDirSize(gDir);
  const outputsBytes  = getDirSize(oDir);
  const tempBytes     = getDirSize(tDir);
  const totalBytes    = getDirSize(STORAGE_ROOT);
  const otherBytes    = Math.max(0, totalBytes - (gameplayBytes + outputsBytes + tempBytes));

  const maxBudgetMb = process.env.STORAGE_MAX_MB
    ? parseInt(process.env.STORAGE_MAX_MB, 10)
    : Math.round(DEFAULT_STORAGE_MAX_BYTES / 1024 / 1024);

  return {
    totalBytes,
    totalMb:       Number((totalBytes / 1024 / 1024).toFixed(2)),
    budgetMaxMb:   maxBudgetMb,
    usagePercent:  Number(((totalBytes / (maxBudgetMb * 1024 * 1024)) * 100).toFixed(1)),
    breakdown: {
      gameplayMb: Number((gameplayBytes / 1024 / 1024).toFixed(2)),
      outputsMb:  Number((outputsBytes / 1024 / 1024).toFixed(2)),
      tempMb:     Number((tempBytes / 1024 / 1024).toFixed(2)),
      otherMb:    Number((otherBytes / 1024 / 1024).toFixed(2)),
    },
    lastRun: lastRunInfo,
  };
}

/**
 * Start periodic self-cleaning scheduler.
 */
function startScheduler(intervalMs = DEFAULT_CLEANUP_INTERVAL_MS) {
  // Run once immediately on start
  cleanupAll();

  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = setInterval(() => {
    cleanupAll();
  }, intervalMs);

  if (schedulerTimer.unref) schedulerTimer.unref();
}

/**
 * Stop periodic scheduler (for test suites and clean process shutdown).
 */
function stopScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

module.exports = {
  cleanupAll,
  cleanupExpiredJobs,
  cleanupOrphanOutputs,
  cleanupTemp,
  cleanupStaleGameplay,
  cleanupStrayDirs,
  enforceStorageBudget,
  checkTempAndBudget,
  getStorageStats,
  startScheduler,
  stopScheduler,
  getDirSize,
  DEFAULT_STORAGE_MAX_BYTES,
};

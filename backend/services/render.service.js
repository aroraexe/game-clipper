'use strict';
/**
 * render.service.js
 * Orchestrates the full video pipeline.
 * Designed to run in a Worker Thread (or main thread).
 */

const fs = require('fs');
const path = require('path');
const { isMainThread, parentPort } = require('worker_threads');

const storyService = require('./story.service');
const ttsService = require('./tts.service');
const whisperService = require('./whisper.service');
const subtitleService = require('./subtitle.service');
const gameplayService = require('./gameplay.service');
const ffmpegService = require('./ffmpeg.service');
const { jobTempDir, outputDir } = require('../utils/storage.util');

const TIMEOUT_MS = parseInt(process.env.JOB_TIMEOUT_MS || '600000', 10);

/* ── Main pipeline ────────────────────────────────────────────────────────── */

async function renderPipeline(job) {
  const jobId = job.jobId;

  // Watchdog timeout with AbortController
  let timedOut = false;
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    abortController.abort('Render timeout exceeded');
    reportError(jobId, new Error('Render timeout exceeded'));
  }, TIMEOUT_MS);

  // Perf Tracking
  const perf = {};
  const tStart = Date.now();
  const timeBlock = async (name, fn) => {
    const s = Date.now();
    const res = await fn();
    perf[name] = Date.now() - s;
    return res;
  };

  try {
    reportStatus(jobId, 'processing');
    const { story, gameplayId, captionStyle, captionColor, voice, duration } = job.params;

    /*
     * Watermark is re-resolved HERE, not read from job.params.
     *
     * job.params.watermark was frozen at createJob time. A render can sit in the
     * queue for a long time (Railway runs MAX_CONCURRENT_RENDERS=1), so a user
     * who was Pro when they submitted — and whose subscription has since lapsed,
     * leaving them on the free tier — would still get an unwatermarked video.
     * The plan is the authority at the moment the bytes are produced, not at the
     * moment the job was accepted.
     *
     * Falls back to the enqueue-time value only if the store cannot be read, so
     * a transient failure here can never silently drop a paid watermark.
     */
    let watermark = job.params.watermark;
    try {
      const userStore = require('../jobs/userStore');
      const { planFor } = require('../config/plans');
      if (job.userId) {
        watermark = planFor((uid) => userStore.planNameFor(uid), job.userId).watermark;
      }
    } catch (e) {
      console.warn('[Render] Could not re-resolve plan for watermark; using enqueue-time value:', e.message);
    }

    if (!gameplayId) {
      throw new Error(`Unknown gameplay id: undefined`);
    }

    /* 1 ─ Prepare temp directory */
    stage(jobId, 'preparing_story', 5);
    const tempDir = jobTempDir(jobId);
    fs.mkdirSync(tempDir, { recursive: true });
    reportUpdate(jobId, { tempDir });

    let cleanStory;
    await timeBlock('Story Processing', async () => {
      cleanStory = await storyService.clean(story);
      fs.writeFileSync(path.join(tempDir, 'story.txt'), cleanStory, 'utf8');
    });
    checkTimeout(timedOut);

    // 2 ─ Text-to-Speech (MUST RUN FIRST TO GET TRUE DURATION)
    stage(jobId, 'generating_voice', 15);
    const audioOutPath = path.join(tempDir, 'audio.wav');
    const gameplaySegPath = path.join(tempDir, 'gameplay.mp4');
    let assPath;
    let audioPath;
    let trueDurationS = duration;

    await timeBlock('TTS Generation', async () => {
      audioPath = await ttsService.synthesize(cleanStory, audioOutPath, voice);
      
      // Get the true duration of the generated audio so the video doesn't cut off or drag on
      try {
        const dur = await ffmpegService.probeDuration(audioPath);
        if (dur) trueDurationS = dur + 0.5; // Add 0.5s padding at the end
      } catch (e) {
        console.warn('Could not read true audio duration, falling back to UI duration');
      }
    });
    checkTimeout(timedOut);

    // Run subtitles and video extraction in parallel now that we know the true duration
    stage(jobId, 'generating_assets', 30);
    
    const subsPromise = (async () => {
      let words;
      await timeBlock('Whisper Sync', async () => {
        words = await whisperService.transcribe(audioPath, tempDir, cleanStory);
        fs.writeFileSync(path.join(tempDir, 'timestamps.json'), JSON.stringify(words, null, 2), 'utf8');
      });
      checkTimeout(timedOut);

      assPath = path.join(tempDir, 'captions.ass');
      await timeBlock('Subtitle Gen', async () => {
        subtitleService.generate(words, assPath, captionStyle, captionColor);
      });
      checkTimeout(timedOut);
    })();

    const videoPromise = (async () => {
      const segment = await gameplayService.selectSegment(gameplayId, trueDurationS);
      checkTimeout(timedOut);

      await timeBlock('Gameplay Trim', async () => {
        if (segment.mock) {
          await ffmpegService.generateMockVideo({ durationS: trueDurationS, outputPath: gameplaySegPath });
        } else {
          await ffmpegService.extractSegment({
            inputPath: segment.filePath,
            startTime: segment.startTime,
            durationS: trueDurationS,
            outputPath: gameplaySegPath,
          });
        }
      });
      checkTimeout(timedOut);
    })();

    // Helper to catch and swallow errors from background promises after Promise.all has already thrown
    // This prevents unhandled promise rejections from orphaned promises.
    const safePromise = (p) => p.catch(err => {
      if (timedOut || abortController.signal.aborted) return;
      throw err;
    });

    // Wait for both independent pipelines to finish
    await Promise.all([safePromise(subsPromise), safePromise(videoPromise)]);

    /* 7 ─ Composite */
    stage(jobId, 'compositing', 70);
    const finalPath = path.join(outputDir(), `${jobId}.mp4`);

    await timeBlock('FFmpeg Composite', async () => {
      await ffmpegService.compositeVideo({
        gameplayPath: gameplaySegPath,
        audioPath,
        subtitlePath: assPath,
        outputPath: finalPath,
        durationS: trueDurationS,
        watermark: watermark,
        onProgress: (pct) => stage(jobId, 'compositing', 70 + Math.floor(pct * 0.25)),
        signal: abortController.signal
      });
    });
    checkTimeout(timedOut);

    /* 8 ─ Finalise */
    stage(jobId, 'finalizing', 95);

    reportCompleted(jobId, finalPath);
    const tTotal = Date.now() - tStart;
    console.log('\n=== 🚀 PERFORMANCE REPORT [' + jobId.slice(0, 8) + '] ===');
    let maxName = ''; let maxTime = 0;
    for (const [name, ms] of Object.entries(perf)) {
      console.log((name + '                    ').slice(0, 20) + ': ' + ms + 'ms');
      if (ms > maxTime) { maxTime = ms; maxName = name; }
    }
    console.log('TOTAL RENDER TIME   : ' + tTotal + 'ms');
    console.log('🔥 BOTTLENECK       : ' + maxName + ' (' + maxTime + 'ms)');
    console.log('============================================\n');
    console.log('[Render Worker] ✨ Job ' + jobId + ' completed');
  } catch (err) {
    // Abort any still-running promises to prevent orphaned processes and unhandled rejections
    if (!abortController.signal.aborted) abortController.abort();
    
    if (!timedOut) {
      const errMsg = err && err.message ? err.message : String(err);
      console.error(`[Render Worker] ✗ Job ${jobId} failed:`, errMsg, err);
      reportError(jobId, err);
    }
    throw err; // Re-throw so worker catches it
  } finally {
    clearTimeout(timeoutHandle);
    // Always clean up temp files (especially important on failure so we don't leak Render disk space)
    cleanup(jobTempDir(jobId));
  }
}

module.exports = renderPipeline;

/* ── Communication with Main Thread ─────────────────────────────────────── */

function sendMsg(msg) {
  if (!isMainThread && parentPort) {
    parentPort.postMessage(msg);
  } else {
    // Fallback if run in main thread (e.g. testing)
    const jobStore = require('../jobs/jobStore');
    if (msg.type === 'STAGE') jobStore.setStage(msg.jobId, msg.stage, msg.progress);
    if (msg.type === 'UPDATE') jobStore.update(msg.jobId, msg.patch);
    if (msg.type === 'STATUS') jobStore.setStatus(msg.jobId, msg.status);
    if (msg.type === 'COMPLETED') jobStore.markCompleted(msg.jobId, msg.outputPath);
    if (msg.type === 'ERROR') jobStore.markFailed(msg.jobId, new Error(msg.error));
  }
}

function stage(jobId, stageName, progress) {
  console.log(`[Render Worker] [${jobId.slice(0, 8)}] ${stageName} (${progress}%)`);
  sendMsg({ type: 'STAGE', jobId, stageName, progress });
}

function reportUpdate(jobId, patch) {
  sendMsg({ type: 'UPDATE', jobId, patch });
}

function reportStatus(jobId, status) {
  sendMsg({ type: 'STATUS', jobId, status });
}

function reportCompleted(jobId, outputPath) {
  sendMsg({ type: 'COMPLETED', jobId, outputPath });
}

function reportError(jobId, err) {
  const errMsg = err && err.message ? err.message : String(err);
  sendMsg({ type: 'ERROR', jobId, error: errMsg });
}

function checkTimeout(timedOut) {
  if (timedOut) throw new Error('Render timeout exceeded');
}

function cleanup(tempDir) {
  try {
    if (!fs.existsSync(tempDir)) return;
    const files = fs.readdirSync(tempDir);
    for (const f of files) {
      const fullPath = path.join(tempDir, f);
      try { fs.rmSync(fullPath, { recursive: true }); } catch (_) { }
    }
    fs.rmdirSync(tempDir);
  } catch (err) {
    console.warn(`[Render Worker] Cleanup warning: ${err.message}`);
  }
}

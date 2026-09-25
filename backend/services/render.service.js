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

const TIMEOUT_MS = parseInt(process.env.JOB_TIMEOUT_MS || '300000', 10);

/* ── Main pipeline ────────────────────────────────────────────────────────── */

async function renderPipeline(job) {
  const jobId = job.jobId;

  // Watchdog timeout
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
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
      const { execSync } = require('child_process');
      try {
        const durStr = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`, { encoding: 'utf8' }).trim();
        if (durStr) trueDurationS = parseFloat(durStr) + 0.5; // Add 0.5s padding at the end
      } catch (e) {
        console.warn('Could not read true audio duration, falling back to UI duration');
      }
    });
    checkTimeout(timedOut);

    // Run subtitles and video extraction in parallel now that we know the true duration
    const subsPromise = (async () => {
      stage(jobId, 'transcribing', 30);
      let words;
      await timeBlock('Whisper Sync', async () => {
        words = await whisperService.transcribe(audioPath, tempDir, cleanStory);
        fs.writeFileSync(path.join(tempDir, 'timestamps.json'), JSON.stringify(words, null, 2), 'utf8');
      });
      checkTimeout(timedOut);

      stage(jobId, 'creating_subtitles', 42);
      assPath = path.join(tempDir, 'captions.ass');
      await timeBlock('Subtitle Gen', async () => {
        subtitleService.generate(words, assPath, captionStyle, captionColor);
      });
      checkTimeout(timedOut);
    })();

    const videoPromise = (async () => {
      stage(jobId, 'selecting_gameplay', 10);
      const segment = await gameplayService.selectSegment(gameplayId, trueDurationS);
      checkTimeout(timedOut);

      stage(jobId, 'trimming_gameplay', 20);
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

    // Wait for both independent pipelines to finish
    await Promise.all([subsPromise, videoPromise]);

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
      });
    });
    checkTimeout(timedOut);

    /* 8 ─ Finalise */
    stage(jobId, 'finalizing', 95);
    cleanup(tempDir, finalPath);

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

function cleanup(tempDir, keepPath) {
  try {
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

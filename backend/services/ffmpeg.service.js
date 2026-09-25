'use strict';
/**
 * ffmpeg.service.js
 * ─────────────────
 * Central FFmpeg execution layer.  ALL ffmpeg/ffprobe calls go through here.
 *
 * Responsibilities:
 *  - probeDuration   – ffprobe a file for duration
 *  - extractSegment  – efficient direct-seek trim of a source video
 *  - compositeVideo  – stack narration audio + gameplay video + ASS subtitles → 1080×1920 MP4
 *  - generateMockVideo – create a test pattern video when gameplay file is missing
 *
 * Security: all paths are resolved and validated before execution.
 *           No user-provided shell arguments are ever passed directly.
 */

const ffmpeg     = require('fluent-ffmpeg');
const path       = require('path');
const fs         = require('fs');


/* ── CPU-Only Mode ─────────────────────────────────────────────────── */
// Hardware acceleration is disabled. All encoding uses libx264 on CPU.
console.log('[FFmpeg] Running in CPU-only mode (libx264)');

/* ── Output resolution (env-configurable) ───────────────────────────── */
// Default: 720×1280 (fast, looks great on all phones)
// Override: VIDEO_WIDTH=1080 VIDEO_HEIGHT=1920 for local HD renders
const VIDEO_W = parseInt(process.env.VIDEO_WIDTH,  10) || 720;
const VIDEO_H = parseInt(process.env.VIDEO_HEIGHT, 10) || 1280;
console.log(`[FFmpeg] Output resolution: ${VIDEO_W}×${VIDEO_H}`);

/* ── Configure binary paths from env ─────────────────────────────────────── */
if (process.env.FFMPEG_PATH)  ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
if (process.env.FFPROBE_PATH) ffmpeg.setFfprobePath(process.env.FFPROBE_PATH);

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function validatePath(filePath, label) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved))
    throw new Error(`${label} not found: ${path.basename(resolved)}`);
  return resolved;
}

/* ── probeDuration ───────────────────────────────────────────────────────── */
/**
 * probeDuration(filePath) → Promise<number>  (seconds)
 */
function probeDuration(filePath) {
  const resolved = validatePath(filePath, 'Media file');
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(resolved, (err, meta) => {
      if (err) return reject(new Error(`ffprobe failed: ${err.message}`));
      const duration = meta?.format?.duration;
      if (!duration) return reject(new Error('Could not determine media duration'));
      resolve(parseFloat(duration));
    });
  });
}

/* ── extractSegment ──────────────────────────────────────────────────────── */
/**
 * Efficiently seeks to startTime and extracts durationS seconds.
 * Uses input-side seek (-ss before -i) to avoid decoding the whole file.
 *
 * extractSegment({ inputPath, startTime, durationS, outputPath })
 * → Promise<string>  outputPath
 */
function extractSegment({ inputPath, startTime, durationS, outputPath }) {
  const src = validatePath(inputPath, 'Gameplay source');

  return new Promise((resolve, reject) => {
    ffmpeg(src)
      .inputOptions([`-ss ${startTime}`])    // fast input seek
      .duration(durationS)
      .outputOptions([
        '-c:v', 'copy',    // copy stream — no re-encode during extraction
        '-c:a', 'copy',
        '-avoid_negative_ts', 'make_zero',
      ])
      .output(outputPath)
      .on('start', (cmd) => console.log('[FFmpeg:extract] start:', cmd.slice(0, 120)))
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(new Error(`FFmpeg extract failed: ${err.message}`)))
      .run();
  });
}

/* ── generateMockVideo ───────────────────────────────────────────────────── */
/**
 * Generates a 9:16 test-pattern video for when no gameplay file exists.
 * Includes a silent audio track so that audio mixing downstream doesn't fail.
 */
function generateMockVideo({ durationS, outputPath }) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(`color=c=0x1a1a2e:s=${VIDEO_W}x${VIDEO_H}:r=30`)
      .inputOptions(['-f', 'lavfi'])
      .input('anullsrc=r=44100:cl=stereo')
      .inputOptions(['-f', 'lavfi'])
      .duration(durationS)
      .outputOptions([
        '-map', '0:v',
        '-map', '1:a',
        // CPU-only encoding — maximum speed
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',   // disables lookahead → faster encode start
        '-crf', '35',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-threads', '0', // 0 = FFmpeg auto-selects optimal thread count
      ])
      .output(outputPath)
      .on('start', (cmd) => console.log('[FFmpeg:mockVideo] start'))
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(new Error(`FFmpeg mock video failed: ${err.message}`)))
      .run();
  });
}

/* ── compositeVideo ─────────────────────────────────────────────────────────
 *
 * Final composition pipeline:
 *   gameplay (video only, muted) + narration audio → 9:16 1080×1920 MP4
 *   with ASS subtitles burned in.
 *
 * Layout:
 *   • Top 50%: gameplay (cropped to 9:16, scaled to 1080×960)
 *   • Bottom 50%: solid dark background for subtitles
 *   (This gives the "gaming short" look where gameplay is top half
 *    and story subtitles dominate the bottom)
 *
 *   OR for full-bleed: gameplay fills entire 9:16 frame, subtitles on top.
 *   We default to full-bleed — ASS positions subtitles safely.
 *
 * compositeVideo({ gameplayPath, audioPath, subtitlePath, outputPath, durationS })
 * → Promise<string>  outputPath
 * ──────────────────────────────────────────────────────────────────────────── */
function compositeVideo({ gameplayPath, audioPath, subtitlePath, outputPath, durationS }) {
  const gp  = validatePath(gameplayPath, 'Gameplay segment');
  const aud = validatePath(audioPath,    'Narration audio');
  // subtitles validated separately — path may contain special chars

  const assPath = path.resolve(subtitlePath);
  if (!fs.existsSync(assPath))
    throw new Error(`Subtitle file not found: ${path.basename(assPath)}`);

  // Escape ASS path for ffmpeg vf filter (Windows: backslash → forward slash)
  const assEscaped = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');

  return new Promise((resolve, reject) => {
    ffmpeg()
      // Input 0: gameplay video (seek already applied in extractSegment)
      .input(gp)

      // Input 1: narration audio
      .input(aud)

      .complexFilter([
        // 1) Scale & crop gameplay to exactly 1080×1920 (9:16)
        `[0:v]scale=${VIDEO_W}:${VIDEO_H}:force_original_aspect_ratio=increase,` +
        `crop=${VIDEO_W}:${VIDEO_H},setsar=1[vscaled]`,

        // 2) Burn ASS subtitles into video
        `[vscaled]ass='${assEscaped}'[vout]`,
        
        // 3) Mix audio: Gameplay lowered to 10%, Narration at 100%, padded
        `[0:a]volume=0.10[a0]`,
        `[1:a]volume=1.0[a1]`,
        `[a0][a1]amix=inputs=2:duration=longest:normalize=0[aout]`
      ])

      // Map final video + mixed audio
      .outputOptions([
        '-map', '[vout]',
        '-map', '[aout]',

        // CPU-only video codec — maximum speed settings
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',   // disables lookahead → faster encode start
        '-crf', '33',
        '-profile:v', 'baseline',
        '-level', '3.0',
        '-pix_fmt', 'yuv420p',

        // Audio codec
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar',  '44100',

        // Threading: 0 = FFmpeg auto-selects optimal thread count for available CPUs
        '-threads', '0',

        // Duration cap
        `-t`, String(durationS),

        // Container
        '-movflags', '+faststart',
        '-y',
      ])
      .output(outputPath)
      .on('start', (cmd) => console.log('[FFmpeg:composite] start:', cmd.slice(0, 140)))
      .on('progress', (p) => {
        if (p.percent) process.stdout.write(`\r[FFmpeg:composite] ${Math.round(p.percent)}%`);
      })
      .on('end', () => {
        process.stdout.write('\n');
        resolve(outputPath);
      })
      .on('error', (err) => {
        process.stdout.write('\n');
        reject(new Error(`FFmpeg composite failed: ${err.message}`));
      })
      .run();
  });
}

module.exports = { probeDuration, extractSegment, generateMockVideo, compositeVideo };

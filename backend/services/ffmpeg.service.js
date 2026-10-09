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


/* ── Railway Hobby CPU Mode ────────────────────────────────────────── */
// Hardware acceleration disabled for Railway Hobby plan.
console.log('[FFmpeg] Running in Railway Hobby CPU mode (libx264)');

/* ── Output resolution (env-configurable) ───────────────────────────── */
// Default: 720x1280 (HD vertical short)
// Override: VIDEO_WIDTH=1080 VIDEO_HEIGHT=1920 for local 4K renders
const VIDEO_W = parseInt(process.env.VIDEO_WIDTH,  10) || 720;
const VIDEO_H = parseInt(process.env.VIDEO_HEIGHT, 10) || 1280;
console.log(`[FFmpeg] Output resolution: ${VIDEO_W}×${VIDEO_H}`);

/* ── Configure binary paths from env or static binaries ──────────────────── */
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');

if (process.env.FFMPEG_PATH) {
  ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
} else if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}

if (process.env.FFPROBE_PATH) {
  ffmpeg.setFfprobePath(process.env.FFPROBE_PATH);
} else if (ffprobeStatic && ffprobeStatic.path) {
  ffmpeg.setFfprobePath(ffprobeStatic.path);
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function validatePath(filePath, label) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved))
    throw new Error(`${label} not found: ${path.basename(resolved)}`);
  return resolved;
}

/**
 * Escape a filesystem path for safe interpolation into an ffmpeg filtergraph
 * argument. Backslashes become forward slashes first so the escapes we add are
 * the only ones present.
 */
function escapeFilterPath(filePath) {
  return String(filePath)
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
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
      .inputOptions([`-ss ${startTime}`])    // fast input-side seek (no decode)
      .duration(durationS)
      .outputOptions([
        '-c', 'copy',                  // stream copy — no re-encode, near-instant
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
      .inputFormat('lavfi')
      .input('anullsrc=r=44100:cl=stereo')
      .inputFormat('lavfi')
      .outputOptions([
        '-map', '0:v',
        '-map', '1:a',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '35',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-threads', '1',
        '-t', String(durationS),
        '-y'
      ])
      .output(outputPath)
      .on('start', () => console.log('[FFmpeg:mockVideo] start'))
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
function compositeVideo({ gameplayPath, audioPath, subtitlePath, outputPath, durationS, onProgress, signal, watermark }) {
  const gp  = validatePath(gameplayPath, 'Gameplay segment');
  const aud = validatePath(audioPath,    'Narration audio');
  // subtitles validated separately — path may contain special chars

  const assPath = path.resolve(subtitlePath);
  if (!fs.existsSync(assPath))
    throw new Error(`Subtitle file not found: ${path.basename(assPath)}`);

  // Escape ASS path for the ffmpeg filtergraph. The value is interpolated into
  // `ass='...'` inside a filter chain, where several characters are structural:
  //   \  Windows separator      :  drive letter / protocol separator
  //   '  quote delimiter        ,  separates filters in a chain
  //   [  ]  label delimiters
  // Previously only \ and : were escaped, so a checkout path containing a comma
  // or bracket (or an apostrophe) would produce a malformed filter chain.
  const assEscaped = escapeFilterPath(assPath);

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      // Input 0: gameplay video (seek already applied in extractSegment)
      .input(gp)

      // Input 1: narration audio
      .input(aud);

      const filterChain = [
        // 1) Scale & crop gameplay to exactly 1080×1920 (9:16)
        `[0:v]scale=${VIDEO_W}:${VIDEO_H}:force_original_aspect_ratio=increase,crop=${VIDEO_W}:${VIDEO_H},setsar=1[vscaled]`,
        
        // 2) Burn ASS subtitles into video
        watermark
          ? `[vscaled]ass='${assEscaped}'[vsub]`
          : `[vscaled]ass='${assEscaped}'[vout]`
      ];

      if (watermark) {
        // 3) Add watermark
        // x=w-tw-30 aligns right, y=40 near the top.
        //
        // An explicit fontfile is preferred where one is known to exist. On Linux
        // the previous version passed nothing and relied on fontconfig resolving
        // a default face — if no font is installed, drawtext fails the whole
        // composite and the customer's video is lost over a watermark. The
        // container installs fonts-liberation, so Liberation Sans is named here.
        const fontCandidates = process.platform === 'win32'
          ? ['C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/segoeui.ttf']
          : ['/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
             '/usr/share/fonts/liberation/LiberationSans-Regular.ttf',
             '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'];
        const fontFile = fontCandidates.find(f => { try { return fs.existsSync(f); } catch (_) { return false; } });
        const fontStr = fontFile
          ? `fontfile=${escapeFilterPath(fontFile)}:`
          : 'font=Arial:';
        filterChain.push(`[vsub]drawtext=${fontStr}text='StoryPlay.app':fontcolor=white@0.5:fontsize=32:x=w-tw-30:y=40[vout]`);
      }

      cmd.complexFilter(filterChain)

      // Map final video + mixed audio
      .outputOptions([
        '-map', '[vout]',
        '-map', '1:a',

        // CPU video codec — tuned for Railway Hobby Plan
        '-c:v', 'libx264',
        '-preset', 'ultrafast',  // fastest encode
        '-crf', '28',            // lower quality threshold
        '-bf', '2',              // B-frames: better compression
        '-profile:v', 'main',
        '-level', '4.0',
        '-pix_fmt', 'yuv420p',

        // Audio codec
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar',  '44100',

        // Threading: cap at 2 threads to avoid starving other processes on Railway
        '-threads', '2',

        // Duration cap
        `-t`, String(durationS),

        // Container
        '-movflags', '+faststart',
        '-y',
      ])
      .output(outputPath)
      .on('start', (cmd) => console.log('[FFmpeg:composite] start:', cmd.slice(0, 140)))
      .on('progress', (p) => {
        if (p.percent) {
          process.stdout.write(`\r[FFmpeg:composite] ${Math.round(p.percent)}%`);
          if (onProgress) onProgress(p.percent);
        }
      })
      .on('end', () => {
        if (signal) signal.removeEventListener('abort', onAbort);
        process.stdout.write('\n');
        resolve(outputPath);
      })
      .on('error', (err) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        process.stdout.write('\n');
        reject(new Error(`FFmpeg composite failed: ${err.message}`));
      });

    const onAbort = () => {
      cmd.kill('SIGKILL');
      reject(new Error(signal.reason || 'Aborted'));
    };

    if (signal) {
      if (signal.aborted) {
        return reject(new Error(signal.reason || 'Aborted'));
      }
      signal.addEventListener('abort', onAbort);
    }

    cmd.run();
  });
}

module.exports = { probeDuration, extractSegment, generateMockVideo, compositeVideo, escapeFilterPath };

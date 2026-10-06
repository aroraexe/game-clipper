'use strict';
/**
 * tts.service.js
 * ────────────────────────────────────────���──────────────────
 * Narration audio for a Short.
 *
 * PROVIDER POLICY (changed for the paid launch)
 * --------------------------------------------
 * This previously defaulted to Microsoft Edge TTS via `node-edge-tts`, which
 * calls the Edge "read aloud" websocket. That endpoint has no licensed
 * commercial contract behind it: it can be rate-limited, changed or blocked
 * without notice, and there is no SLA or support path if you are paying for a
 * product built on it. Fine for a hobby project, a real risk for something
 * people have paid for.
 *
 * So the default provider is now `openai`. The Edge path still exists because it
 * is free and useful for local development, but it now requires BOTH:
 *   - TTS_PROVIDER=edge  (explicit opt-in)
 *   - ALLOW_UNLICENSED_TTS=true
 * and the second is refused outright when NODE_ENV=production.
 *
 * There is also no longer a silent fallback from OpenAI to Edge: if OpenAI fails
 * we surface the error instead of quietly degrading to the unlicensed provider
 * and billing the customer for a video narrated by the wrong thing.
 */

const fs      = require('fs');
const path    = require('path');
const { EdgeTTS } = require('node-edge-tts');
const { OpenAI } = require('openai');

/**
 * Voice names exposed in the UI -> provider-specific voice ids.
 *
 * The Edge path previously ignored the requested voice and always used a single
 * hardcoded one, so "Calm", "Energetic" and "Narrator" all produced byte-for-byte
 * the same audio. Both maps are now complete.
 */
const VOICES = {
  default:   { openai: 'onyx',    edge: 'en-US-ChristopherNeural' },
  energetic: { openai: 'nova',    edge: 'en-US-GuyNeural' },
  calm:      { openai: 'shimmer', edge: 'en-US-JennyNeural' },
  narrator:  { openai: 'fable',   edge: 'en-US-GregoryNeural' },
};
const DEFAULT_VOICE = 'default';

function resolveProvider() {
  const requested = String(process.env.TTS_PROVIDER || 'openai').trim().toLowerCase();

  if (requested === 'edge') {
    const allowed = process.env.ALLOW_UNLICENSED_TTS === 'true';
    if (process.env.NODE_ENV === 'production' && !allowed) {
      throw new Error(
        'TTS_PROVIDER=edge is refused in production: Microsoft Edge read-aloud has no licensed ' +
        'commercial contract. Set TTS_PROVIDER=openai with OPENAI_API_KEY, or explicitly set ' +
        'ALLOW_UNLICENSED_TTS=true to accept the risk.'
      );
    }
    if (!allowed) {
      console.warn('[TTS] ⚠️  Using Microsoft Edge TTS (unlicensed for commercial use). ' +
                   'Set ALLOW_UNLICENSED_TTS=true to silence this warning.');
    }
    return 'edge';
  }

  return 'openai';
}

function voiceIdFor(voice, provider) {
  const entry = VOICES[voice] || VOICES[DEFAULT_VOICE];
  return entry[provider];
}

async function synthesizeOpenAI(text, mp3Path, voice) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      'OPENAI_API_KEY is not set. Set it, or set TTS_PROVIDER=edge (and ' +
      'ALLOW_UNLICENSED_TTS=true) for non-commercial use.'
    );
  }
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const mp3 = await openai.audio.speech.create({
    model: process.env.OPENAI_TTS_MODEL || 'tts-1',
    voice:  voiceIdFor(voice, 'openai'),
    input:  text,
  });
  fs.writeFileSync(mp3Path, Buffer.from(await mp3.arrayBuffer()));
}

async function synthesizeEdge(text, mp3Path, voice) {
  const tts = new EdgeTTS({ voice: voiceIdFor(voice, 'edge') });
  await tts.ttsPromise(text, mp3Path);
}

/**
 * synthesize(text, outputPath, voice)
 * -> Promise<string>  absolute path to the wav file
 */
async function synthesize(text, outputPath, voice = DEFAULT_VOICE) {
  const provider = resolveProvider();
  const mp3Path  = path.join(path.dirname(outputPath), 'tts_raw.mp3');

  console.log(`[TTS] ${provider} · voice "${voice}" (${voiceIdFor(voice, provider)}) · ${text.length} chars`);

  if (provider === 'edge') {
    await synthesizeEdge(text, mp3Path, voice);
  } else {
    // No fallback to Edge here on purpose - see the header note.
    await synthesizeOpenAI(text, mp3Path, voice);
  }

  // Convert to clean WAV without blocking the worker event loop
  await new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    const ffmpegBin = process.env.FFMPEG_PATH || 'ffmpeg';
    execFile(ffmpegBin, ['-i', mp3Path, '-c:a', 'pcm_s16le', '-ar', '44100', outputPath, '-y'], (err) => {
      if (err) reject(new Error(`TTS WAV conversion failed: ${err.message}`));
      else resolve();
    });
  });

  return outputPath;
}

/** Exposed for tests and for the startup preflight. */
function describeConfig() {
  let provider = null;
  let error = null;
  try { provider = resolveProvider(); } catch (e) { error = e.message; }
  return { provider, error, voices: Object.keys(VOICES) };
}

module.exports = { synthesize, VOICES, describeConfig, resolveProvider };

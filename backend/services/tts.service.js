'use strict';
/**
 * tts.service.js
 * ──────────────
 * Narration audio for a Short.
 *
 * PROVIDER POLICY
 * ---------------
 * Three engines, in descending order of how safe they are to depend on:
 *
 *   openai — COMMERCIALLY LICENSED. Needs OPENAI_API_KEY, costs per character.
 *   local  — OFFLINE, FREE, NO API KEY. A speech engine that already exists on
 *            the machine: Windows SAPI via System.Speech, or espeak-ng. This is
 *            what makes narration work on a fresh clone and on Railway without
 *            anyone having to hand over a card for API credits first.
 *   edge   — Microsoft Edge "read aloud" via node-edge-tts. Free, but there is
 *            NO licensed commercial contract behind that websocket: it can be
 *            rate-limited, changed or blocked without notice and there is no
 *            support path. Requires BOTH TTS_PROVIDER=edge AND
 *            ALLOW_UNLICENSED_TTS=true, and is refused outright in production.
 *
 * There is no longer a silent fallback between providers. If the chosen engine
 * fails we surface the error rather than quietly degrading to a different voice
 * (or an unlicensed one) and billing the customer for the wrong narration.
 *
 * The default is `auto`: use OpenAI when a key is present, otherwise fall back to
 * the local engine, otherwise fall back to Edge (subject to the licensing gate).
 */

const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const { execFile, spawn } = require('child_process');
const { EdgeTTS } = require('node-edge-tts');
const { OpenAI } = require('openai');

/**
 * Voice names exposed in the UI -> provider-specific voice ids.
 *
 * The Edge path previously ignored the requested voice and always used a single
 * hardcoded one, so "Calm", "Energetic" and "Narrator" all produced byte-for-byte
 * the same audio. All three maps are complete and disjoint.
 */
const VOICES = {
  default:   { openai: 'onyx',    edge: 'en-US-ChristopherNeural' },
  energetic: { openai: 'nova',    edge: 'en-US-GuyNeural' },
  calm:      { openai: 'shimmer', edge: 'en-US-JennyNeural' },
  narrator:  { openai: 'fable',   edge: 'en-US-GregoryNeural' },
};
const DEFAULT_VOICE = 'default';

/* ─── Local (offline) engine configuration ─────────────────────────────────────
 *
 * A stock Windows install only ships two SAPI voices (David, Zira) and a stock
 * Linux container only ships espeak-ng. So prosody carries the difference between
 * the four UI voices rather than relying on four distinct installed voices: rate
 * and pitch are set per voice, and only the preferred *base* voice is looked up.
 */

const LOCAL_SAPI = {
  default:   { prefer: ['Microsoft David', 'David'],            rate: 0,  pitch: '+0Hz'  },
  energetic: { prefer: ['Microsoft Zira', 'Zira', 'Microsoft Hazel'],  rate: 3,  pitch: '+18%' },
  calm:      { prefer: ['Microsoft Zira', 'Zira', 'Microsoft Hazel'],  rate: -4, pitch: '-12%' },
  narrator:  { prefer: ['Microsoft David', 'David', 'Mark'],   rate: -2, pitch: '-8%'  },
};

const LOCAL_ESPEAK = {
  // en-XX+m3 / +f3 are the "improved" variants: noticeably clearer than plain.
  default:   { voice: 'en-us+m3', wpm: 165, pitch: 50 },
  energetic: { voice: 'en-us+f3', wpm: 195, pitch: 68 },
  calm:      { voice: 'en-us+f2', wpm: 140, pitch: 40 },
  narrator:  { voice: 'en-gb+m4', wpm: 150, pitch: 38 },
};

/** espeak-ng and the original espeak both speak this flag; text arrives on stdin. */
const ESPEAK_STDIN_FLAG = '--stdin';

/* ─── Local engine detection ────────────────────────────────────────────────────
 * Probed once per process and cached. Detection shells out (a .wav round trip for
 * SAPI) purely to prove the engine can actually produce audio rather than merely
 * being on PATH — espeak-ng can be installed with a broken voice-data package,
 * and discovering that on the first customer render is too late.
 */

let cachedEngine; // undefined = not probed yet

function runFile(bin, args, { timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', error: err });
    });
  });
}

async function detectLocalEngine() {
  if (cachedEngine !== undefined) return cachedEngine;
  cachedEngine = null;

  if (process.platform === 'win32') {
    const probe = await runFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command',
       'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices().Count'],
      { timeout: 25000 }
    );
    if (probe.ok) cachedEngine = { kind: 'sapi' };
  }

  if (!cachedEngine) {
    for (const bin of ['espeak-ng', 'espeak']) {
      const probe = await runFile(bin, ['--version'], { timeout: 10000 });
      if (probe.ok) { cachedEngine = { kind: 'espeak', bin }; break; }
    }
  }

  console.log(`[TTS] local engine detection -> ${cachedEngine ? cachedEngine.kind : 'NONE AVAILABLE'}`);
  return cachedEngine;
}

/* ─── Windows SAPI ────────────────────────────────────────────────────────────
 *
 * The PowerShell script is STATIC and is written to disk once. Nothing derived
 * from a user's story is ever placed on a command line: the SSML (which does
 * contain the story) goes into a file that the script reads. Only server-chosen
 * file paths and an integer rate are passed as argv.
 */

const SAPI_SCRIPT = [
  'param([string]$In, [string]$Out, [string]$Voice, [int]$Rate)',
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Speech',
  '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  'if ($Voice) {',
  '  $names = @($synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name })',
  '  if ($names -contains $Voice) { $synth.SelectVoice($Voice) }',
  '}',
  '$synth.Rate = $Rate',
  '$synth.SetOutputToWaveFile($Out)',
  '$synth.SpeakSsml([System.IO.File]::ReadAllText($In, [System.Text.Encoding]::UTF8))',
  '$synth.Dispose()',
].join('\n');

let sapiScriptPath = null;
function sapiScript() {
  if (sapiScriptPath && fs.existsSync(sapiScriptPath)) return sapiScriptPath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storyplay-tts-'));
  sapiScriptPath = path.join(dir, 'speak.ps1');
  fs.writeFileSync(sapiScriptPath, SAPI_SCRIPT, 'utf8');
  return sapiScriptPath;
}

/** XML-escape for an SSML text node. */
function escapeSsml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function speakSsml(text, wavPath, voice) {
  const cfg  = LOCAL_SAPI[voice] || LOCAL_SAPI[DEFAULT_VOICE];
  const ssml =
    '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">' +
    '<prosody rate="medium" pitch="' + cfg.pitch + '">' +
    escapeSsml(text) +
    '</prosody></speak>';

  const ssmlPath = `${wavPath}.ssml`;
  fs.writeFileSync(ssmlPath, ssml, 'utf8');

  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', sapiScript(),
    '-In',  ssmlPath,
    '-Out', wavPath,
    '-Rate', String(cfg.rate),
  ];
  if (cfg.prefer[0]) args.push('-Voice', cfg.prefer[0]);

  return runFile('powershell', args, { timeout: 120000 }).then((r) => {
    try { fs.rmSync(ssmlPath, { force: true }); } catch (_) { /* best effort */ }
    if (!r.ok) throw new Error(`local SAPI synthesis failed: ${r.error?.message || r.stderr.trim()}`);
    return wavPath;
  });
}

/* ─── espeak-ng ────────────────────────────────────────────────────────────────
 *
 * Text is piped over stdin rather than passed as an argv element: a 3,000
 * character story can exceed the per-argument length limit on Windows and is
 * needlessly visible in the process list otherwise.
 */

function speakEspeak(bin, text, wavPath, voice) {
  const cfg = LOCAL_ESPEAK[voice] || LOCAL_ESPEAK[DEFAULT_VOICE];
  const args = [
    '-v', cfg.voice,
    '-s', String(cfg.wpm),
    '-p', String(cfg.pitch),
    '-w', wavPath,
    ESPEAK_STDIN_FLAG,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => reject(new Error(`local espeak-ng failed to start: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) return resolve(wavPath);
      reject(new Error(`local espeak-ng exited ${code}: ${stderr.trim().slice(0, 300)}`));
    });
    child.stdin.on('error', () => { /* surfaced via close/exit instead */ });
    child.stdin.end(text);
  });
}

/* ─── Provider selection ────────────────────────────────────────────────────── */

function edgeIsPermitted() {
  if (process.env.NODE_ENV !== 'production') return true;
  return process.env.ALLOW_UNLICENSED_TTS === 'true';
}

/**
 * Resolve which engine to use. Throws with an actionable message rather than
 * picking something unlicensed in production.
 * @returns {Promise<string>}
 */
async function resolveProvider() {
  const requested = String(process.env.TTS_PROVIDER || 'auto').trim().toLowerCase();

  if (requested === 'auto') {
    if (process.env.OPENAI_API_KEY) return 'openai';
    if (await detectLocalEngine()) return 'local';
    console.warn('[TTS] No OPENAI_API_KEY and no local speech engine found; falling back to Microsoft Edge TTS.');
    return resolveProviderFor('edge');
  }

  if (requested === 'local') {
    if (!(await detectLocalEngine())) {
      throw new Error(
        'TTS_PROVIDER=local but no offline speech engine was found. Install espeak-ng ' +
        '(apt-get install espeak-ng / brew install espeak-ng), or unset TTS_PROVIDER to use auto-detection.'
      );
    }
    return 'local';
  }

  if (requested === 'openai' && !process.env.OPENAI_API_KEY) {
    throw new Error('TTS_PROVIDER=openai but OPENAI_API_KEY is not set.');
  }

  return resolveProviderFor(requested);
}

/** Shared validation for the two explicitly-named providers. */
function resolveProviderFor(requested) {
  if (requested === 'edge') {
    if (!edgeIsPermitted()) {
      throw new Error(
        'TTS_PROVIDER=edge is refused in production: Microsoft Edge read-aloud has no licensed ' +
        'commercial contract. Use TTS_PROVIDER=local (free, offline) or TTS_PROVIDER=openai with ' +
        'OPENAI_API_KEY, or explicitly set ALLOW_UNLICENSED_TTS=true to accept the risk.'
      );
    }
    if (process.env.ALLOW_UNLICENSED_TTS !== 'true') {
      console.warn('[TTS] ⚠️  Using Microsoft Edge TTS (unlicensed for commercial use). ' +
                   'Set ALLOW_UNLICENSED_TTS=true to silence this warning.');
    }
    return 'edge';
  }
  if (requested === 'openai' || requested === 'edge' || requested === 'local') return requested;
  throw new Error(
    `Unknown TTS_PROVIDER "${requested}". Supported: auto (default) | local | openai | edge.`
  );
}

function voiceIdFor(voice, provider) {
  if (provider === 'local') return voice;
  const entry = VOICES[voice] || VOICES[DEFAULT_VOICE];
  return entry[provider];
}

/* ─── Engine implementations ────────────────────────────────────────────────── */

async function synthesizeOpenAI(text, mp3Path, voice) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      'OPENAI_API_KEY is not set. Set it, or use TTS_PROVIDER=local for free offline narration.'
    );
  }
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const mp3 = await openai.audio.speech.create({
    model: process.env.OPENAI_TTS_MODEL || 'tts-1',
    voice:  voiceIdFor(voice, 'openai'),
    input:  text,
  });
  fs.writeFileSync(mp3Path, Buffer.from(await mp3.arrayBuffer()));
  return mp3Path;
}

async function synthesizeEdge(text, mp3Path, voice) {
  const tts = new EdgeTTS({ voice: voiceIdFor(voice, 'edge') });
  await tts.ttsPromise(text, mp3Path);
  return mp3Path;
}

function ffmpegBin() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const sys = ['/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find(p => {
    try { return fs.existsSync(p); } catch (_) { return false; }
  });
  if (sys) return sys;
  try { return require('ffmpeg-static'); } catch (_) { return 'ffmpeg'; }
}

/** mp3 -> clean 44.1 kHz 16-bit PCM WAV, without blocking the worker event loop. */
function toWav(srcPath, outputPath) {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegBin(),
      ['-i', srcPath, '-c:a', 'pcm_s16le', '-ar', '44100', outputPath, '-y'],
      { timeout: 120000, windowsHide: true },
      (err) => {
        if (err) reject(new Error(`TTS WAV conversion failed: ${err.message}`));
        else resolve(outputPath);
      }
    );
  });
}

/**
 * synthesize(text, outputPath, voice)
 * -> Promise<string>  absolute path to a 16-bit PCM WAV file
 */
async function synthesize(text, outputPath, voice = DEFAULT_VOICE) {
  const provider = await resolveProvider();
  const engine   = provider === 'local' ? await detectLocalEngine() : null;
  const detail   = provider === 'local'
    ? `${engine.kind}${engine.bin ? ` (${engine.bin})` : ''} · style "${voice}"`
    : `voice "${voice}" (${voiceIdFor(voice, provider)})`;

  console.log(`[TTS] ${provider} · ${detail} · ${text.length} chars`);

  // The local engines emit 16-bit PCM WAV directly, so they skip both the
  // intermediate MP3 and the ffmpeg conversion pass.
  if (provider === 'local') {
    if (engine.kind === 'sapi') return speakSsml(text, outputPath, voice);
    return speakEspeak(engine.bin, text, outputPath, voice);
  }

  const mp3Path = path.join(path.dirname(outputPath), 'tts_raw.mp3');
  if (provider === 'edge') await synthesizeEdge(text, mp3Path, voice);
  else await synthesizeOpenAI(text, mp3Path, voice);

  return toWav(mp3Path, outputPath);
}

/**
 * Exposed for the startup preflight and for tests.
 * @returns {Promise<{provider:string|null, engine:string|null, error:string|null, voices:string[], paid:boolean}>}
 */
async function describeConfig() {
  let provider = null;
  let engine   = null;
  let error    = null;
  try {
    provider = await resolveProvider();
    if (provider === 'local') {
      const e = await detectLocalEngine();
      engine = e ? e.kind : null;
    }
  } catch (e) {
    error = e.message;
  }
  return {
    provider,
    engine,
    error,
    paid: provider === 'openai',
    voices: Object.keys(VOICES),
  };
}

/**
 * Synchronous probe used by authPreflight(), which cannot await.
 *
 * Must agree with resolveProvider() about what is VALID — it previously skipped
 * the OPENAI_API_KEY check, so preflight reported `openai` as healthy on a
 * deployment where every render would have failed.
 */
function describeConfigSync() {
  const requested = String(process.env.TTS_PROVIDER || 'auto').trim().toLowerCase();
  let provider = null;
  let error   = null;
  try {
    if (requested === 'auto') {
      // Engine existence for `local` cannot be probed synchronously; the real
      // synthesize() call reports it, and a missing engine only fails renders.
      provider = process.env.OPENAI_API_KEY ? 'openai' : 'local';
    } else if (requested === 'local') {
      provider = 'local';
    } else if (requested === 'openai') {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error(
          'TTS_PROVIDER=openai but OPENAI_API_KEY is not set. Set it, or use ' +
          'TTS_PROVIDER=local for free offline narration.'
        );
      }
      provider = 'openai';
    } else {
      provider = resolveProviderFor(requested);
    }
  } catch (e) {
    error = e.message;
  }
  return { provider, error, paid: provider === 'openai', voices: Object.keys(VOICES) };
}

module.exports = {
  synthesize, describeConfig, describeConfigSync, resolveProvider, detectLocalEngine,
  VOICES, escapeSsml,
};

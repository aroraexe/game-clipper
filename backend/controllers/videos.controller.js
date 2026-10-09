'use strict';
const { v4: uuidv4 }  = require('uuid');
const path             = require('path');
const crypto           = require('crypto');
const jobStore         = require('../jobs/jobStore');
const { enqueue }      = require('../jobs/renderQueue');
const storyService     = require('../services/story.service');
const gameplayService  = require('../services/gameplay.service');
const { getRequestToken, verifyFirebaseToken } = require('../middleware/auth.middleware');
const { planFor } = require('../config/plans');
const userStore = require('../jobs/userStore');

const OUTPUT_URL_TTL_MS = 15 * 60 * 1000;

// Generated once per process, dev only. Previously the non-production fallback
// was the literal string 'dev-output-url-secret', which is public — fine for
// local work, but it meant a dev box produced URLs signed with a guessable key.
// A random per-boot secret removes that. It does NOT survive a restart, which
// is acceptable locally: signatures are only valid for OUTPUT_URL_TTL_MS.
let DEV_SIGNING_SECRET = null;

function outputSigningSecret() {
  const secret = process.env.OUTPUT_URL_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('CRITICAL: OUTPUT_URL_SECRET must be set in production to secure video downloads.');
    }
    if (!DEV_SIGNING_SECRET) {
      DEV_SIGNING_SECRET = crypto.randomBytes(32).toString('hex');
      console.warn('[OutputURL] OUTPUT_URL_SECRET is not set — using a random per-process dev secret. Do not rely on this outside local development.');
    }
    return DEV_SIGNING_SECRET;
  }
  return secret;
}

function signOutputUrl(jobId, userId, expiresAt) {
  return crypto
    .createHmac('sha256', outputSigningSecret())
    .update(`${jobId}.${userId}.${expiresAt}`)
    .digest('hex');
}

function createOutputPath(jobId, userId, download = false) {
  const expiresAt = Date.now() + OUTPUT_URL_TTL_MS;
  const sig = signOutputUrl(jobId, userId, expiresAt);
  const params = new URLSearchParams({ expires: String(expiresAt), sig });
  if (download) params.set('download', 'true');
  return `/api/videos/${jobId}/output?${params.toString()}`;
}

function hasValidOutputSignature(req, job) {
  const expiresAt = Number(req.query.expires);
  const sig = String(req.query.sig || '');
  if (!expiresAt || !sig || Date.now() > expiresAt) return false;

  const expected = signOutputUrl(job.jobId, job.userId || '', expiresAt);
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

async function authorizeOutputRequest(req, job) {
  if (hasValidOutputSignature(req, job)) return true;

  // Jobs with no owner recorded are legacy/unowned — never hand them out.
  if (!job.userId) return false;

  const token = getRequestToken(req);
  if (!token) return false;

  let user;
  try {
    user = await verifyFirebaseToken(token);
  } catch (_) {
    return false;
  }
  return job.userId === user.uid;
}

function parseStoryResponse(raw) {
  let text = raw.trim();
  // Remove markdown code fences if any
  text = text
    .replace(/^```\w*\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  
  if (!text) throw new Error("Empty story response");
  return text;
}

/* ── POST /api/videos/generate-story ─────────────────────────────────────── */
exports.generateStory = async (req, res, next) => {
  try {
    const { duration, type } = req.body;

    // Whitelist both values before they reach the LLM prompt. Previously
    // `parseInt(duration) || 45` accepted anything, so duration: -1 produced
    // "Target approximately -3 words", and an unknown `type` silently fell
    // through the switch to a generic prompt.
    const ALLOWED_GEN_DURATIONS = [30, 45, 60];
    const ALLOWED_GEN_TYPES = ['reddit', 'true', 'gaming', 'fiction'];

    const dur = parseInt(duration, 10);
    if (duration !== undefined && !ALLOWED_GEN_DURATIONS.includes(dur)) {
      return res.status(400).json({ error: `duration must be one of: ${ALLOWED_GEN_DURATIONS.join(', ')}` });
    }
    const effectiveDur = ALLOWED_GEN_DURATIONS.includes(dur) ? dur : 45;
    const wordCount = Math.floor(effectiveDur * 2.5);

    const storyType = ALLOWED_GEN_TYPES.includes(type) ? type : 'reddit';

    let stylePrompt = '';
    switch (storyType) {
      case 'reddit':
        stylePrompt = "Make it sound like a funny, slightly unhinged Reddit 'Am I The Asshole' or 'TIFU' post.";
        break;
      case 'true':
        stylePrompt = "Make it sound like a bizarre but supposedly true story told by a friend.";
        break;
      case 'gaming':
        stylePrompt = "Make it a hilarious story about a gaming moment, raging in voice chat, or a ridiculous glitch.";
        break;
      case 'fiction':
        stylePrompt = "Make it a funny, creative short fictional story with an unexpected plot twist.";
        break;
      default:
        stylePrompt = "Make it a funny, engaging short story.";
    }

    const generateWithRetry = async (retries = 3) => {
      const nvidiaApiKey = process.env.NVIDIA_API_KEY;
      if (!nvidiaApiKey) throw new Error('NVIDIA_API_KEY environment variable is not set');

      for (let i = 0; i < retries; i++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 45000);
        const startTime = Date.now();
        
        try {
          const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${nvidiaApiKey}`
            },
            signal: controller.signal,
            body: JSON.stringify({
              model: 'nvidia/nemotron-3-ultra-550b-a55b',
              messages: [
                {
                  role: 'system',
                  content: `You are a creative writer. You must respond with ONLY the story text and absolutely nothing else. No thinking, no intro, no outro, no JSON.

STORY REQUIREMENTS:
- Write in first person.
- ${stylePrompt}
- DO NOT use Gen-Z "brainrot" slang (no skibidi, gyatt, rizz, sigma, mewing). Keep the humor smart and witty.
- Target approximately ${wordCount} words.
- The story must be natural when read aloud but fast-paced.
- End the story with a compelling, funny, or thought-provoking QUESTION directed at the viewer.
- Do not stop mid-sentence.`
                },
                {
                  role: 'user',
                  content: `Generate the story.`
                }
              ],
              max_tokens: 1024,
              temperature: 0.7
            })
          });
          
          clearTimeout(timeoutId);

          if (!response.ok) {
            const errText = await response.text();
            console.error(`[NVIDIA API Error Attempt ${i+1}]: ${response.status}`, errText);
            
            if ([400, 401, 403].includes(response.status)) {
              throw new Error(`NVIDIA API Fatal Error ${response.status}: ` + errText);
            }
            if (i === retries - 1) throw new Error('NVIDIA API Error: ' + errText);
            
            const retryAfter = response.headers.get('Retry-After');
            const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : (Math.pow(2, i) * 1000) + Math.random() * 500;
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }

          const data = await response.json();
          const latency = Date.now() - startTime;
          const tokens = data.usage?.total_tokens || 'unknown';
          console.log(`[NVIDIA API Success] Latency: ${latency}ms | Tokens: ${tokens}`);
          
          let rawContent = data.choices[0].message.content || "";
          
          try {
            return parseStoryResponse(rawContent);
          } catch (e) {
            console.error(`[Parse Error Attempt ${i+1}]:`, e.message, "RAW:", rawContent);
            if (i === retries - 1) throw new Error("Failed to parse story after multiple attempts.");
            continue;
          }
        } catch (err) {
          clearTimeout(timeoutId);
          console.error(`[NVIDIA Network/Timeout Error Attempt ${i+1}]:`, err.message);
          if (err.message.includes('Fatal Error') || i === retries - 1) throw err;
          const delay = (Math.pow(2, i) * 1000) + Math.random() * 500;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    };

    let story = "";
    let usedFallback = false;
    try {
      story = await generateWithRetry(3);
    } catch (e) {
      console.error("[Story Gen Fallback Triggered]:", e.message);
      // Fallback story so the user is never completely blocked.
      // `usedFallback` is returned to the client so the UI can say so. Without
      // this, an unset/invalid NVIDIA_API_KEY looks identical to success: every
      // user silently gets this one fixed story rendered at full TTS+encode cost.
      usedFallback = true;
      story = "I stared at the flickering screen, the last boss's health bar a thin red line. My fingers trembled over the controller, each heartbeat syncing with the pulsing music. One final combo, a perfect parry, and the arena erupted in light. The victory screen flashed—then the console whispered my real name, and the lights in my room went out.";
    }

    // Server-side validation just to log it (client handles UX)
    const words = story.trim().split(/\s+/).length;
    console.log(`[AI] Generated story: ${words} words (target: ${wordCount})${usedFallback ? ' [FALLBACK]' : ''}`);

    res.json({ story, fallback: usedFallback });
  } catch (err) {
    next(err);
  }
};

/* ── POST /api/videos ────────────────────────────────────────────────────── */
exports.createJob = async (req, res, next) => {
  try {
    const { story, gameplayId, captionStyle, captionColor, voice, duration } = req.body;

    /* Validate inputs */
    const storyErr = storyService.validate(story);
    if (storyErr) return res.status(400).json({ error: storyErr });

    if (!gameplayService.getById(gameplayId))
      return res.status(400).json({ error: 'Invalid gameplayId' });

    const allowedStyles   = ['bold-yellow', 'white-highlight', 'word-pop', 'clean'];
    const allowedVoices   = ['default', 'energetic', 'calm', 'narrator'];
    const allowedDuration = [30, 45, 60];

    if (captionStyle && !allowedStyles.includes(captionStyle))
      return res.status(400).json({ error: `captionStyle must be one of: ${allowedStyles.join(', ')}` });

    const dur = Number(duration);
    if (duration !== undefined && !allowedDuration.includes(dur))
      return res.status(400).json({ error: `duration must be one of: ${allowedDuration.join(', ')}` });

    if (voice && !allowedVoices.includes(voice))
      return res.status(400).json({ error: `voice must be one of: ${allowedVoices.join(', ')}` });

    if (captionColor && !/^#[0-9A-Fa-f]{6}$/.test(captionColor))
      return res.status(400).json({ error: `captionColor must be a valid hex color code` });

    const idempotencyKey = req.headers['idempotency-key'];
    if (idempotencyKey) {
      const existing = jobStore.findByIdempotencyKey(idempotencyKey, req.user.uid);
      if (existing) {
        console.log(`[Queue] Replaying existing job ${existing.jobId} for idempotency key`);
        return res.status(200).json({ jobId: existing.jobId, status: existing.status, replayed: true });
      }
    }

    // Queue limits to prevent unbounded resource consumption (DOS).
    // The per-user cap comes from the user's plan (free 2, pro 6) so that
    // paying customers are not throttled at the same level as free ones.
    const plan = planFor((uid) => userStore.planNameFor(uid), req.user.uid);

    const allJobs = jobStore.list();
    const activeJobs = allJobs.filter(j => ['queued', 'processing'].includes(j.status));

    // Global queue cap
    if (activeJobs.length >= 100) {
      return res.status(503).json({ error: 'System is currently at maximum capacity. Please try again later.' });
    }
    
    // Per-user concurrency cap
    const userActiveJobs = activeJobs.filter(j => j.userId === req.user.uid);
    if (userActiveJobs.length >= plan.maxActiveJobs) {
      return res.status(429).json({ error: `You already have ${plan.maxActiveJobs} active jobs on the ${plan.label} plan. Please wait for them to finish before creating more.` });
    }

    // Per-plan story length cap (free tier is shorter, pro gets the full 3000).
    if (story.trim().length > plan.maxStoryChars) {
      return res.status(400).json({ error: `Story exceeds the ${plan.maxStoryChars}-character limit on the ${plan.label} plan.` });
    }


    /* Create job */
    const jobId = uuidv4();
    const job = jobStore.create(jobId, {
      story,
      gameplayId,
      captionStyle: captionStyle || 'bold-yellow',
      captionColor: captionColor || '#ffffff',
      voice:        voice        || 'default',
      duration:     dur          || 45,
      watermark:    plan.watermark,
      userId:       req.user.uid,
      idempotencyKey: idempotencyKey || null,
    });

    /* Enqueue for async processing */
    enqueue(jobId);

    res.status(202).json({
      jobId,
      status:  'queued',
      message: 'Job accepted — poll GET /api/videos/:jobId for status',
    });
  } catch (err) {
    next(err);
  }
};

/* ── GET /api/videos/:jobId ──────────────────────────────────────────────── */
exports.getJob = (req, res, next) => {
  try {
    const job = jobStore.get(req.params.jobId);
    if (!job || job.userId !== req.user.uid) {
      return res.status(404).json({ error: 'Job not found' });
    }

    /* Never expose internal paths */
    const safe = {
      jobId:     job.jobId,
      status:    job.status,
      stage:     job.stage,
      progress:  job.progress,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      error:     job.error || null,
      outputUrl: job.status === 'completed'
        ? createOutputPath(job.jobId, req.user.uid)
        : null,
      downloadUrl: job.status === 'completed'
        ? createOutputPath(job.jobId, req.user.uid, true)
        : null,
    };
    res.json(safe);
  } catch (err) {
    next(err);
  }
};

/* ── GET /api/videos/:jobId/output ──────────────────────────────────────── */
exports.getOutput = async (req, res, next) => {
  try {
    const job = jobStore.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    
    const allowed = await authorizeOutputRequest(req, job);
    if (!allowed) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'completed')
      return res.status(409).json({ error: 'Job not completed yet', status: job.status });

    if (!job.outputPath || !require('fs').existsSync(job.outputPath)) {
      return res.status(500).json({ error: 'Output file missing or deleted from server' });
    }

    // Signed URLs are short-lived and per-user. Without no-store an intermediary
    // can cache the body and keep serving it after the signature expires.
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');

    if (req.query.download === 'true') {
      return res.download(job.outputPath, `storyplay_${req.params.jobId}.mp4`, (err) => {
        if (err && !res.headersSent) next(err);
      });
    }

    res.sendFile(job.outputPath, (err) => {
      if (err && !res.headersSent) next(err);
    });
  } catch (err) {
    next(err);
  }
};

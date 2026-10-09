'use strict';
require('dotenv').config();

const express       = require('express');
const cors          = require('cors');
const helmet        = require('helmet');
const rateLimit     = require('express-rate-limit');
const compression   = require('compression');
const path          = require('path');
const crypto        = require('crypto');
const cookieParser  = require('cookie-parser');

const healthRouter    = require('./routes/health.routes');
const gameplayRouter  = require('./routes/gameplay.routes');
const meRouter        = require('./routes/me.routes');
const billingRouter   = require('./routes/billing.routes');
const videosRouter    = require('./routes/videos.routes');
const { initStorage } = require('./utils/storage.util');
const { requireAuth, getRequestToken, verifyFirebaseToken, authPreflight, DEV_AUTH_ENABLED } = require('./middleware/auth.middleware');

const app  = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

/**
 * Does this process look like it is serving the public internet?
 *
 * Used only to decide whether the dev-auth mock is fatal. Any of these is set by
 * a hosting platform, and none of them is set by a local checkout — so this
 * distinguishes "developer running npm start" from "public deployment" without
 * having to trust NODE_ENV, which defaults to something other than 'production'
 * on the platforms we actually deploy to.
 */
const LOOKS_PUBLIC = Boolean(
  process.env.RAILWAY ||
  process.env.RENDER ||
  process.env.FLY_APP_NAME ||
  process.env.AWS_EXECUTION_ENV ||
  process.env.KOYEB_APP_NAME ||
  process.env.VERCEL ||
  (process.env.PUBLIC_BASE_URL && /^https?:\/\//i.test(process.env.PUBLIC_BASE_URL))
);

/* ─── Security / middleware ─────────────────────────────────────────────────── */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      // Inline <script> blocks are used in all three HTML pages; 'unsafe-inline'
      // stays until they are externalised. Removing it is the next hardening step.
      scriptSrc:      ["'self'", "'unsafe-inline'", 'https://apis.google.com', 'https://www.gstatic.com',
                        'https://checkout.razorpay.com'],
      styleSrc:       ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:        ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc:         ["'self'", 'data:', 'blob:'],
      mediaSrc:       ["'self'", 'blob:'],
      connectSrc:     ["'self'", 'https://*.googleapis.com', 'https://*.firebaseio.com',
                       'wss://*.firebaseio.com', 'https://*.firebaseapp.com',
                       'https://api.razorpay.com', 'https://checkout.razorpay.com'],
      frameSrc:       ["'self'", 'https://*.firebaseapp.com', 'https://accounts.google.com'],
      objectSrc:      ["'none'"],
      baseUri:        ["'self'"],
      frameAncestors: ["'none'"],
      formAction:     ["'self'"],
    },
  },
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
}));
/* ─── CORS ─────────────────────────────────────────────────────────────────────
 * Was `cors()` with no options, which reflects ANY origin. Combined with the
 * session cookie that let any site on the internet read authenticated API
 * responses out of a logged-in victim's browser.
 *
 * Now an explicit allow-list. Same-origin requests need no CORS headers at all,
 * and cross-origin is only for the split deployment (static frontend on Vercel,
 * API on Railway), where the frontend origin must be named in CORS_ORIGINS.
 * Credentials are enabled because the session lives in a cookie — which is
 * exactly why the origin list has to be explicit rather than '*'.
 */
const CORS_ORIGINS = (() => {
  const fromEnv = String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  // The canonical public origin is always allowed — it is the same site, and a
  // split deployment that forgot to list it would otherwise break checkout.
  const publicBase = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (publicBase && !fromEnv.includes(publicBase)) fromEnv.push(publicBase);
  return fromEnv;
})();

const corsOptions = {
  origin(origin, callback) {
    // No Origin header: same-origin navigation, curl, or a server-side call.
    // Nothing to allow or deny, so let it through.
    if (!origin) return callback(null, true);
    if (CORS_ORIGINS.includes(origin.replace(/\/+$/, ''))) return callback(null, true);
    // Not allowed. Returning false (rather than an error) means the response
    // simply goes out without CORS headers and the browser blocks it — which is
    // the correct outcome and keeps the server logs readable.
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  maxAge: 600,
};
app.use(cors(corsOptions));
app.use(compression());                       // gzip/br for text assets

/* ─── Payment webhooks ────────────────────────────────────────────────────────
 * MUST stay above express.json(). Both providers sign the exact bytes they sent,
 * so a parsed-then-re-serialised body cannot verify — every event would be
 * rejected. They are also above the rate limiter below, because providers retry
 * in bursts and a burst here is normal traffic, not abuse. Authenticity is the
 * signature; these routes are intentionally unauthenticated.
 */
const { stripeWebhook, razorpayWebhook } = require('./routes/billing.webhook');
const webhookRaw = { type: 'application/json', limit: '1mb' };
app.post('/api/billing/webhook/stripe',    express.raw(webhookRaw), stripeWebhook);
app.post('/api/billing/webhook/razorpay',  express.raw(webhookRaw), razorpayWebhook);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

/* ── Request ID — lets a user report map to a server log line ─────────────── */
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || crypto.randomBytes(8).toString('hex');
  res.setHeader('X-Request-Id', req.id);
  next();
});

/* ── Trust proxy (Railway / Render / Heroku sit behind a load-balancer) ──────── */
// Without this every request appears to share one IP, collapsing all users
// into a single rate-limit bucket.
//
// The hop count matters and cannot be guessed. It must equal the number of
// proxies between the client and this process, and the deployment target owns
// that fact — so it is configurable rather than hardcoded.
//
// A WRONG value here is not cosmetic. Express derives req.ip from
// X-Forwarded-For right-to-left, trusting exactly `hops` entries. If the real
// chain has more proxies than we trust, the entries we skip are attacker-
// controlled, so anyone can pick their own rate-limit identity by sending
// `X-Forwarded-For: <anything>` and every limiter in this file becomes a no-op.
// TRUST_PROXY_HOPS=0 (the local default) means no proxy is trusted and
// X-Forwarded-For is ignored entirely.
const TRUST_PROXY_HOPS = (() => {
  const raw = String(process.env.TRUST_PROXY_HOPS ?? '').trim();
  if (raw === '') return 0;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[Startup] Ignoring invalid TRUST_PROXY_HOPS="${raw}" — expected a non-negative integer.`);
    return 0;
  }
  return n;
})();
app.set('trust proxy', TRUST_PROXY_HOPS);

/**
 * Rate-limit bucket key.
 *
 * Deliberately `req.ip` and nothing else. This limiter is registered ahead of
 * every router, so `req.user` does not exist yet and a uid-based key would have
 * to verify a Firebase token on each request just to pick a bucket.
 *
 * The real per-account bound is NOT this limiter: createJob re-reads the plan
 * from userStore and enforces maxActiveJobs / maxStoryChars against the verified
 * uid, and the global cap counts the live job store rather than anything the
 * caller supplied. Those cannot be moved by changing a header. This limiter is
 * the outer, per-address bound.
 *
 * Safe only because TRUST_PROXY_HOPS above is set to the real hop count.
 */
function rateLimitKey(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}


/* ─── Rate limiting ─────────────────────────────────────────────────────────── */
// POST limiter — controls expensive operations (job creation, story gen)
const postLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
  message: { error: 'Too many requests, please slow down.' },
});
// GET limiter — allows polling every 1.5 s comfortably for 2+ concurrent users
const getLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
  message: { error: 'Too many requests, please slow down.' },
});
app.use('/api', (req, res, next) => req.method === 'POST' ? postLimiter(req, res, next) : getLimiter(req, res, next));

/* ─── Session cookie attributes ─────────────────────────────────────────────── */
// Defined once and reused. clearCookie must be given the SAME attributes the
// cookie was set with (path, secure, sameSite) or the browser treats it as a
// different cookie and leaves the original in place — which is why logout
// silently failed to log anyone out.
const SESSION_COOKIE_DEFAULTS = {
  httpOnly: true,
  sameSite: 'lax',
  path:     '/',
};

/* ─── Protected app shell ────────────────────────────────────────────────────── */
// This MUST be registered before express.static, which resolves /app -> app.html
// via `extensions: ['html']` and would otherwise serve the authenticated shell to
// anyone. Both this gate AND the normalised block below it are needed: this one
// decides who may SEE the shell, the other stops the static handler serving
// app.html by any other spelling of the path.
app.get('/app', async (req, res, next) => {
  try {
    const token = getRequestToken(req);
    if (!token) {
      console.log("[Auth] /app redirecting to /signin because no token found in cookies.");
      return res.redirect('/signin');
    }

    await verifyFirebaseToken(token);   // throws on invalid/expired
    return res.sendFile(path.join(__dirname, '../frontend/app.html'));
  } catch (err) {
    console.error("[Auth] /app redirecting to /signin because verifyFirebaseToken threw:", err.message);
    if (err.status === 503) return next(err);   // server misconfigured — don't hide it
    res.clearCookie('sessionToken', {
      ...SESSION_COOKIE_DEFAULTS,
      secure: process.env.NODE_ENV === 'production' && req.secure
    });
    return res.redirect('/signin');
  }
});

/* ── Block direct access to the protected shell ────────────────────────────────
 * The check MUST NOT be a literal string compare on req.path.
 *
 * `extensions: ['html']` on the static handler below makes /app, /APP.HTML,
 * /app%2ehtml, //app.html and /./app.html all resolve to app.html, and serve-static
 * matches the filesystem case-insensitively on Windows. A previous version
 * compared `req.path === '/app.html'` exactly, so every one of those variants
 * walked straight past the gate and returned the authenticated app shell to an
 * anonymous caller — while /app itself correctly redirected to /signin.
 *
 * Normalising first is what closes it: percent-decode, collapse repeated
 * slashes, resolve . and .. via posix normalize, then compare lowercased.
 */
function normalizedRequestPath(req) {
  let p = req.path;
  try {
    p = decodeURIComponent(p);
  } catch (_) {
    // Malformed percent-encoding: fall through with the raw path. normalize()
    // cannot make an unresolvable path match the protected shell.
  }
  p = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  p = path.posix.normalize(p);
  return p.toLowerCase();
}

const PROTECTED_SHELL_PATHS = new Set(['/app.html', '/app/index.html']);

app.use((req, res, next) => {
  const p = normalizedRequestPath(req);
  const isProtected =
    PROTECTED_SHELL_PATHS.has(p) ||
    p.startsWith('/app/') ||
    p === '/app/index.htm';
  if (isProtected) return res.redirect('/signin');
  next();
});

/* ─── Static frontend ───────────────────────────────────────────────────────── */
app.use(express.static(path.join(__dirname, '../frontend'), {
  // Required so /signin resolves to signin.html. Safe now that the /app gate and
  // the app.html blocker above are registered first.
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    // Fingerprinted / long-lived caching for heavy media, short cache for code.
    if (!IS_PROD) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      return;
    }
    if (/\.(mp4|webm|mp3|png|jpg|jpeg|webp|svg)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=2592000'); // 30 days
    } else if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');                  // revalidate shell
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600');      // css/js/other
    }
  },
}));

// Session Login Route
app.post('/api/auth/session', async (req, res, next) => {
  const { idToken } = req.body;
  console.log("Received login request to /api/auth/session");
  if (!idToken) {
    console.log("Missing idToken!");
    return res.status(400).send('Missing idToken');
  }

  try {
    // CRITICAL FIX: Verify the token BEFORE setting it as a session cookie
    // This catches project mismatches or expired tokens instantly, instead of
    // granting a 200 OK and then bouncing the user in a redirect loop on /app.
    await verifyFirebaseToken(idToken);

    const cookieOptions = {
      ...SESSION_COOKIE_DEFAULTS,
      secure: process.env.NODE_ENV === 'production' && req.secure,
      maxAge: 60 * 60 * 1000,
    };
    res.cookie('sessionToken', idToken, cookieOptions);
    console.log("Cookie set successfully, returning 200 OK");
    res.sendStatus(200);
  } catch (err) {
    console.error("[Auth] Session login failed verification:", err.message);
    if (err.status === 503) return next(err);
    res.status(401).send('Unauthorized: Invalid token');
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('sessionToken', {
    ...SESSION_COOKIE_DEFAULTS,
    secure: process.env.NODE_ENV === 'production' && req.secure
  });
  res.sendStatus(200);
});

/* ─── API routes ────────────────────────────────────────────────────────────── */
app.use('/api/health',    healthRouter);
app.use('/api/me',        requireAuth, meRouter);
app.use('/api/billing',   billingRouter);
app.use('/api/gameplay',  requireAuth, gameplayRouter);

app.use('/api/videos',    videosRouter);


/* ─── 404 handler ───────────────────────────────────────────────────────────── */
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

/* ─── Global error handler ─────────────────────────────────────────────────── */
// 4xx messages and 503 (configuration/capacity errors) are safe to echo.
// Other 5xx messages are not — FFmpeg errors carry absolute file paths and raw
// stderr — so those are logged and replaced.
app.use((err, req, res, _next) => {
  const status  = err.status || err.statusCode || 500;
  // 503 is used for intentional, safe service-unavailable messages (e.g. auth misconfigured, queue full).
  const isServer = status >= 500 && status !== 503;

  if (isServer) {
    console.error(`[GlobalError] id=${req.id} ${req.method} ${req.originalUrl} -> ${status}`, err);
  } else {
    console.warn(`[GlobalError] id=${req.id} ${req.method} ${req.originalUrl} -> ${status}: ${err.message}`);
  }

  if (res.headersSent) return;

  res.status(status).json({
    error: isServer ? 'Internal server error' : err.message,
    requestId: req.id,
  });
});

/* ─── Startup ───────────────────────────────────────────────────────────────── */

/**
 * Remove render temp directories left behind by a crash, OOM kill or restart.
 *
 * render.service.js cleans its own directory in a `finally`, so anything still
 * here belongs to a process that died before it got there — and those
 * directories hold story.txt, the narration WAV and the subtitle file. They were
 * previously never reclaimed, so user scripts sat on disk indefinitely, which is
 * both a retention problem (privacy.html promises temp files are deleted) and a
 * slow disk leak.
 *
 * The live job list is the allow-list: a directory whose name is a queued or
 * rendering job is left alone. The age floor is a second guard against deleting a
 * directory a worker created microseconds ago and has not registered yet.
 */
const TEMP_SWEEP_MIN_AGE_MS = 60 * 60 * 1000; // 1 hour

function sweepOrphanTempDirs(now = Date.now()) {
  const fs = require('fs');
  const { list } = require('./jobs/jobStore');
  const { jobTempDir } = require('./utils/storage.util');

  const root = jobTempDir('__sweep__').replace(/[\\/]__sweep__$/, '');
  const live = new Set(list().filter((j) => j.status === 'queued' || j.status === 'processing').map((j) => j.jobId));

  let removed = 0;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return 0; // storage not initialised yet
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (live.has(entry.name)) continue;
    const full = path.join(root, entry.name);
    try {
      const age = now - fs.statSync(full).mtimeMs;
      if (age < TEMP_SWEEP_MIN_AGE_MS) continue;
      fs.rmSync(full, { recursive: true, force: true });
      removed++;
    } catch (e) {
      console.warn(`[Cleanup] Could not remove orphan temp dir ${entry.name}: ${e.message}`);
    }
  }
  if (removed > 0) console.log(`[Cleanup] Removed ${removed} orphaned render temp dir(s).`);
  return removed;
}

async function start() {
  // Fail loudly and EARLY on a config that would serve unauthenticated traffic.
  // This used to be discovered on the first request instead.
  const problems = authPreflight();
  if (problems.length > 0) {
    for (const p of problems) console.error(`[Startup] CONFIG ERROR: ${p}`);
    if (IS_PROD) {
      console.error('[Startup] Running in production with missing secrets! API routes will return 503/500 errors until configured in your environment variables.');
    } else {
      console.warn('[Startup] Continuing in non-production despite the problems above.');
    }
  }
  if (DEV_AUTH_ENABLED && LOOKS_PUBLIC) {
    // Refuse to start rather than warn. With the mock engaged, every anonymous
    // request is accepted as "dev-user" — so ALL accounts collapse onto one
    // shared identity and can see and download each other's videos. That is not
    // a degraded mode, it is an open door, and a warning scrolls off a log
    // within minutes.
    //
    // Scoped to LOOKS_PUBLIC on purpose: ALLOW_DEV_AUTH=true is the documented
    // way to work on this locally, and exiting unconditionally would break that.
    // On a real host (see LOOKS_PUBLIC) it is fatal.
    console.error('[Startup] FATAL: DEV AUTH MOCK IS ENABLED on what looks like a public deployment — ' +
                  'every request resolves to "dev-user" with no token. Unset ALLOW_DEV_AUTH and set NODE_ENV=production.');
    process.exit(1);
  } else if (DEV_AUTH_ENABLED) {
    console.warn('[Startup] ⚠️  DEV AUTH MOCK IS ENABLED (local only) — all requests resolve to "dev-user".');
  }

  // authPreflight only runs its full battery when NODE_ENV is exactly
  // 'production'. If it is unset or misspelled, a production deploy skips every
  // one of those checks and boots as if it were local.
  if (!IS_PROD && process.env.NODE_ENV === undefined) {
    console.warn('[Startup] NODE_ENV is not set — treated as non-production. ' +
                 'Set NODE_ENV=production on any public deployment.');
  }

  try {
    const ttsCfg = await require('./services/tts.service').describeConfig();
    const where = ttsCfg.engine ? ` (${ttsCfg.engine})` : '';
    console.log(`[Startup] TTS provider: ${ttsCfg.provider || 'UNUSABLE'}${where} (voices: ${ttsCfg.voices.join(', ')})`);
  } catch (_) { /* preflight already reports unusable TTS in production */ }

  try {
    const billing = require('./config/billing.config');
    for (const p of billing.billingProblems()) console.warn(`[Startup] BILLING CONFIG: ${p}`);
    const live = billing.usableProviders();
    if (live.length > 0) {
      console.log(`[Startup] Billing providers live: ${live.join(', ')} (showing ${billing.displayCurrency()})`);
    } else if (IS_PROD) {
      console.warn('[Startup] No payment provider is fully configured — Pro cannot be purchased yet. ' +
                   'The pricing page will hide its buy buttons rather than fail.');
    }
  } catch (err) {
    console.warn('[Startup] Could not read billing config:', err.message);
  }

  await initStorage();
  sweepOrphanTempDirs();   // once at boot: reclaim whatever the last process left

  // Start the render queue worker (import here so queue starts after storage init)
  require('./jobs/renderQueue');

  // Storage cleanup (runs every 30 mins).
  // Retention is per-user: free tier keeps a finished video for 1 hour, paid
  // subscribers for 7 days (see backend/config/plans.js). It used to be a
  // hardcoded 1 hour for everybody, which made the product unsellable.
  //
  // Only terminal jobs are removed — never a job that is still queued or
  // rendering, otherwise the render finishes to a file nobody can fetch.
  setInterval(() => {
    try {
      const { list, removeJob } = require('./jobs/jobStore');
      const userStore = require('./jobs/userStore');
      const { planFor } = require('./config/plans');
      const fs = require('fs');
      const now = Date.now();
      let cleared = 0;
      let skipped = 0;
      for (const job of list()) {
        const terminal = job.status === 'completed' || job.status === 'failed';
        if (!terminal) { skipped++; continue; }

        const plan = planFor((uid) => userStore.planNameFor(uid), job.userId);
        const finishedAt = new Date(job.updatedAt || job.createdAt).getTime();
        if (now - finishedAt < plan.retentionMs) continue;

        removeJob(job.jobId);
        if (job.outputPath) {
          try { fs.rmSync(job.outputPath); } catch (e) { /* already gone */ }
        }
        cleared++;
      }
      if (cleared > 0) console.log(`[Cleanup] Cleared ${cleared} finished job(s) & MP4s (${skipped} in-flight left alone).`);

      sweepOrphanTempDirs();
    } catch (e) {
      console.error('[Cleanup] Error:', e.message);
    }
  }, 30 * 60 * 1000);

  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════╗
║          StoryPlay  🎬  running           ║
║  http://localhost:${PORT}                   ║
╚══════════════════════════════════════════╝
    `);
  });
}

if (require.main === module) {
  start().catch((err) => {
    console.error('[Fatal] Could not start server:', err.message);
    process.exit(1);
  });
}

module.exports = app;
module.exports.start = start;
module.exports.sweepOrphanTempDirs = sweepOrphanTempDirs;

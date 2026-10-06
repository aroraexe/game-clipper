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
const videosRouter    = require('./routes/videos.routes');
const { initStorage } = require('./utils/storage.util');
const { requireAuth, getRequestToken, verifyFirebaseToken, authPreflight, DEV_AUTH_ENABLED } = require('./middleware/auth.middleware');

const app  = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

/* ─── Security / middleware ─────────────────────────────────────────────────── */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      // Inline <script> blocks are used in all three HTML pages; 'unsafe-inline'
      // stays until they are externalised. Removing it is the next hardening step.
      scriptSrc:      ["'self'", "'unsafe-inline'", 'https://apis.google.com', 'https://www.gstatic.com'],
      styleSrc:       ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:        ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc:         ["'self'", 'data:', 'blob:'],
      mediaSrc:       ["'self'", 'blob:'],
      connectSrc:     ["'self'", 'https://*.googleapis.com', 'https://*.firebaseio.com',
                       'wss://*.firebaseio.com', 'https://*.firebaseapp.com'],
      frameSrc:       ["'self'", 'https://*.firebaseapp.com', 'https://accounts.google.com'],
      objectSrc:      ["'none'"],
      baseUri:        ["'self'"],
      frameAncestors: ["'none'"],
      formAction:     ["'self'"],
    },
  },
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
}));
app.use(cors());
app.use(compression());                       // gzip/br for text assets
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
app.set('trust proxy', 1);


/* ─── Rate limiting ─────────────────────────────────────────────────────────── */
// POST limiter — controls expensive operations (job creation, story gen)
const postLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});
// GET limiter — allows polling every 1.5 s comfortably for 2+ concurrent users
const getLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
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
  secure:   process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path:     '/',
};

/* ─── Protected app shell ────────────────────────────────────────────────────── */
// This MUST be registered before express.static. With `extensions: ['html']` the
// static handler resolves /app -> app.html and serves it to anyone, which made
// the auth gate below unreachable. `extensions` is now removed and app.html is
// additionally blocked from static serving so it is only reachable via /app.
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
    res.clearCookie('sessionToken', SESSION_COOKIE_DEFAULTS);
    return res.redirect('/signin');
  }
});

// Block direct access to the protected shell.
app.use((req, res, next) => {
  if (req.path === '/app.html' || req.path === '/app/') {
    return res.redirect('/signin');
  }
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

    res.cookie('sessionToken', idToken, {
      ...SESSION_COOKIE_DEFAULTS,
      // A Firebase ID token expires after 1 hour. A 24h cookie outlives the
      // credential it carries, so users were silently bounced to /signin at the
      // 1h mark with no explanation. Match the cookie to the token; a real fix
      // is refreshing the token client-side (see AGENT_LOG notes).
      maxAge: 60 * 60 * 1000,
    });
    console.log("Cookie set successfully, returning 200 OK");
    res.sendStatus(200);
  } catch (err) {
    console.error("[Auth] Session login failed verification:", err.message);
    if (err.status === 503) return next(err);
    res.status(401).send('Unauthorized: Invalid token');
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('sessionToken', SESSION_COOKIE_DEFAULTS);
  res.sendStatus(200);
});

/* ─── API routes ────────────────────────────────────────────────────────────── */
app.use('/api/health',    healthRouter);
app.use('/api/gameplay',  requireAuth, gameplayRouter);

app.use('/api/videos',    videosRouter);


/* ─── 404 handler ───────────────────────────────────────────────────────────── */
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

/* ─── Global error handler ─────────────────────────────────────────────────── */
// 4xx messages are safe to echo. 5xx messages are not — FFmpeg errors carry
// absolute file paths and raw stderr — so those are logged and replaced.
app.use((err, req, res, _next) => {
  const status  = err.status || err.statusCode || 500;
  const isServer = status >= 500;

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
async function start() {
  // Fail loudly and EARLY on a config that would serve unauthenticated traffic.
  // This used to be discovered on the first request instead.
  const problems = authPreflight();
  if (problems.length > 0) {
    for (const p of problems) console.error(`[Startup] CONFIG ERROR: ${p}`);
    if (IS_PROD) {
      console.error('[Startup] Refusing to start in production with the above problems.');
      process.exit(1);
    }
    console.warn('[Startup] Continuing in non-production despite the problems above.');
  }
  if (DEV_AUTH_ENABLED) {
    console.warn('[Startup] ⚠️  DEV AUTH MOCK IS ENABLED — all requests resolve to "dev-user". Never do this in production.');
  }

  await initStorage();

  // Start the render queue worker (import here so queue starts after storage init)
  require('./jobs/renderQueue');

  // Storage auto-cleanup for Render/Railway free tiers (runs every 30 mins).
  // Only terminal jobs are removed — never a job that is still queued or
  // rendering, otherwise the render finishes to a file nobody can fetch.
  setInterval(() => {
    try {
      const { list, removeJob } = require('./jobs/jobStore');
      const fs = require('fs');
      const oneHourAgo = Date.now() - (60 * 60 * 1000);
      let cleared = 0;
      let skipped = 0;
      for (const job of list()) {
        const terminal = job.status === 'completed' || job.status === 'failed';
        if (!terminal) { skipped++; continue; }
        if (new Date(job.updatedAt || job.createdAt).getTime() >= oneHourAgo) continue;

        removeJob(job.jobId);
        if (job.outputPath) {
          try { fs.rmSync(job.outputPath); } catch (e) { /* already gone */ }
        }
        cleared++;
      }
      if (cleared > 0) console.log(`[Cleanup] Cleared ${cleared} finished job(s) & MP4s (${skipped} in-flight left alone).`);
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

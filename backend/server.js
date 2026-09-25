'use strict';
require('dotenv').config();

const express       = require('express');
const cors          = require('cors');
const helmet        = require('helmet');
const rateLimit     = require('express-rate-limit');
const path          = require('path');

const healthRouter    = require('./routes/health.routes');
const gameplayRouter  = require('./routes/gameplay.routes');
const videosRouter    = require('./routes/videos.routes');
const { initStorage } = require('./utils/storage.util');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ─── Security / middleware ─────────────────────────────────────────────────── */
app.use(helmet({ contentSecurityPolicy: false }));   // CSP off → serving local HTML
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

/* ─── Rate limiting ─────────────────────────────────────────────────────────── */
const limiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});
app.use('/api', limiter);

/* ─── Static frontend ───────────────────────────────────────────────────────── */
app.use(express.static(path.join(__dirname, '../frontend')));

/* ─── API routes ────────────────────────────────────────────────────────────── */
app.use('/api/health',    healthRouter);
app.use('/api/gameplay',  gameplayRouter);
app.use('/api/videos',    videosRouter);

/* ─── 404 handler ───────────────────────────────────────────────────────────── */
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

/* ─── Global error handler ──────────────────────────────────────────────────── */
app.use((err, req, res, _next) => {
  const status = err.status || 500;
  console.error('[GlobalError]', err.message);
  res.status(status).json({ error: err.message || 'Internal server error' });
});

/* ─── Startup ───────────────────────────────────────────────────────────────── */
async function start() {
  await initStorage();

  // Start the render queue worker (import here so queue starts after storage init)
  require('./jobs/renderQueue');

  // Cache/Storage Auto-Cleanup for Render Free Tier (runs every 30 mins)
  setInterval(() => {
    try {
      const { list, removeJob } = require('./jobs/jobStore');
      const fs = require('fs');
      const oneHourAgo = Date.now() - (60 * 60 * 1000);
      const jobs = list();
      let cleared = 0;
      for (const job of jobs) {
        if (new Date(job.createdAt).getTime() < oneHourAgo) {
          removeJob(job.jobId);
          if (job.outputPath) {
            try { fs.rmSync(job.outputPath); } catch(e) {}
          }
          cleared++;
        }
      }
      if (cleared > 0) console.log(`[Cleanup] Cleared ${cleared} old jobs & MP4 files to save memory/disk space.`);
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

start().catch((err) => {
  console.error('[Fatal] Could not start server:', err.message);
  process.exit(1);
});

module.exports = app;

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

/*
 * Regression tests for a security sweep. Each block here corresponds to a hole
 * that was found by attacking the running app, not by reading it:
 *
 *   1. the /app auth gate was bypassable by ~10 spellings of the path
 *   2. every rate limiter was bypassable with one X-Forwarded-For header
 *   3. a signed STREAM url could be upgraded to a signed DOWNLOAD url
 *   4. a dev-auth deployment booted at all, with every request as one shared uid
 *
 * The dev-auth mock must be ON for 1 and 3 (they need to reach a job) and OFF for
 * 4, so the module graph is loaded twice through distinct registries.
 */

const require = createRequire(import.meta.url);

// jobStore/userStore resolve STORAGE_ROOT at import time.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hardening-'));
process.env.STORAGE_ROOT = tmpDir;

process.env.NODE_ENV = 'development';
process.env.ALLOW_DEV_AUTH = 'true';
process.env.TRUST_PROXY_HOPS = '0';
process.env.MAX_CONCURRENT_RENDERS = '0';
// Empty string, not delete: backend/server.js runs dotenv.config(), which only
// fills in keys that are absent, so deleting here let the local .env put a real
// service account back and the dev-auth mock below never engaged.
process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 = '';

let app;
let jobStore;

beforeAll(async () => {
  const mod = await import('../backend/server.js');
  app = mod.default || mod;
  jobStore = require('../backend/jobs/jobStore.js');
});

afterAll(() => {
  jobStore.flush();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ─── 1. Protected shell ─────────────────────────────────────────────────────── */

describe('protected app shell cannot be reached by any spelling of the path', () => {
  // Every one of these resolved to app.html and returned 200 with the full
  // authenticated UI to an anonymous caller.
  const VARIANTS = [
    '/app.html',
    '/APP.HTML',
    '/App.html',
    '/app.HTML',
    '/app%2ehtml',
    '//app.html',
    '/./app.html',
    '/app/index.html',
    '/app/../app.html',
    '/app/./../../app.html',
  ];

  for (const p of VARIANTS) {
    it(`refuses ${p}`, async () => {
      const res = await request(app).get(p).redirects(0);
      const body = res.text || '';
      expect(res.status).not.toBe(200);
      expect(body).not.toContain('step-story');
      expect(res.headers.location).toBe('/signin');
    });
  }

  it('still serves /app to an authenticated caller', async () => {
    // Any token string passes under the dev-auth mock; the point is that the
    // gate still requires one before handing over the shell.
    const res = await request(app).get('/app').set('Cookie', 'sessionToken=dev');
    expect(res.status).toBe(200);
    expect(res.text).toContain('step-story');
  });

  it('still serves the public pages', async () => {
    expect((await request(app).get('/signin')).status).toBe(200);
    expect((await request(app).get('/index.html')).status).toBe(200);
    expect((await request(app).get('/app-style.css')).status).toBe(200);
  });
});

/* ─── 2. Rate limiting ───────────────────────────────────────────────────────── */

describe('rate limiting cannot be sidestepped with X-Forwarded-For', () => {
  it('counts a rotating X-Forwarded-For against one bucket', async () => {
    const codes = [];
    for (let i = 0; i < 40; i++) {
      const res = await request(app).post('/api/auth/logout').set('X-Forwarded-For', `7.7.7.${i}`);
      codes.push(res.status);
    }
    // 30/min is the POST allowance, so a single bucket MUST start refusing.
    // Before the fix every request got a fresh bucket and none were refused.
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
  });

  it('ignores X-Forwarded-For entirely when TRUST_PROXY_HOPS is 0', async () => {
    // Two different claimed addresses, both refused -> same bucket.
    const a = await request(app).get('/api/gameplay').set('X-Forwarded-For', '1.1.1.1');
    const b = await request(app).get('/api/gameplay').set('X-Forwarded-For', '2.2.2.2');
    expect(a.status).toBe(b.status);
  });
});

/* ─── 3. Signed output URLs ──────────────────────────────────────────────────── */

describe('signed output URLs bind the response mode', () => {
  const JOB_ID = 'hardening-mode-binding';
  let streamUrl;
  let downloadUrl;

  beforeAll(async () => {
    // Tiny valid-enough MP4 header bytes — sendFile only needs the path to exist.
    const outDir = path.join(tmpDir, 'outputs');
    fs.mkdirSync(outDir, { recursive: true });
    const fixture = path.join(outDir, 'hardening-mode-binding.mp4');
    fs.writeFileSync(fixture, Buffer.from([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
      0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00, 0x01,
      0x69, 0x73, 0x6f, 0x6d, 0x61, 0x76, 0x63, 0x31,
    ]));
    jobStore.create(JOB_ID, { story: 'x', userId: 'dev-user', idempotencyKey: null });
    jobStore.markCompleted(JOB_ID, fixture);
    const res = await request(app).get(`/api/videos/${JOB_ID}`);
    streamUrl = res.body.outputUrl;
    downloadUrl = res.body.downloadUrl;
  });

  afterAll(() => {
    jobStore.removeJob(JOB_ID);
  });

  it('serves the video with the stream url it issued', async () => {
    const res = await request(app).get(streamUrl);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBeUndefined();
  });

  it('serves the attachment with the download url it issued', async () => {
    const res = await request(app).get(downloadUrl);
    expect(res.status).toBe(200);
    expect(String(res.headers['content-disposition'])).toMatch(/attachment/);
  });

  it('refuses a stream signature reused with download=true', async () => {
    // The bug: `download` was not in the signed payload, so appending it
    // upgraded a view-only URL into a forced download.
    const u = new URL(`http://localhost${streamUrl}`);
    u.searchParams.set('download', 'true');
    const res = await request(app).get(u.pathname + u.search);
    expect(res.status).toBe(404);
  });

  it('refuses a download signature replayed without the flag', async () => {
    const u = new URL(`http://localhost${downloadUrl}`);
    u.searchParams.delete('download');
    const res = await request(app).get(u.pathname + u.search);
    expect(res.status).toBe(404);
  });

  it('issues a distinct signature per mode', () => {
    const s = new URL(`http://localhost${streamUrl}`).searchParams.get('sig');
    const d = new URL(`http://localhost${downloadUrl}`).searchParams.get('sig');
    expect(s).not.toBe(d);
  });

  it('does not accept an unsigned request', async () => {
    const res = await request(app).get(`/api/videos/${JOB_ID}/output`);
    expect(res.status).toBe(404);
  });
});

/* ─── 4. Orphaned temp dirs ─────────────────────────────────────────────────── */

describe('orphaned render temp dirs are reclaimed', () => {
  it('removes a stale dir but spares a queued job and a fresh one', () => {
    const server = require('../backend/server.js');
    const { list, removeJob } = require('../backend/jobs/jobStore.js');
    const { jobTempDir } = require('../backend/utils/storage.util');

    const stale = jobTempDir('hardening-stale');
    const queued = jobTempDir('hardening-queued');
    const fresh = jobTempDir('hardening-fresh');
    for (const d of [stale, queued, fresh]) {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'story.txt'), 'a user script', 'utf8');
    }
    // Backdate only the stale one past the age floor.
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);

    jobStore.create('hardening-queued', { story: 'x', userId: 'dev-user' });

    try {
      const removed = server.sweepOrphanTempDirs();
      expect(removed).toBe(1);
      expect(fs.existsSync(stale)).toBe(false);       // user script reclaimed
      expect(fs.existsSync(queued)).toBe(true);       // job still in the queue
      expect(fs.existsSync(fresh)).toBe(true);        // too new to judge
    } finally {
      for (const d of [stale, queued, fresh]) fs.rmSync(d, { recursive: true, force: true });
      removeJob('hardening-queued');
    }
  });
});

/* ─── 5. Dev auth must not boot ──────────────────────────────────────────────── */

describe('dev auth is refused on a public deployment', () => {
  // start() is exercised in a child process because the guard calls
  // process.exit(1) — asserting that in-process would kill the test runner.
  const { spawn } = require('child_process');
  const ROOT = path.resolve(__dirname, '..');

  /** Boots the server in a child process; resolves with { code, output }. */
  function boot(env, { waitForListen = false } = {}) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', `
        Object.assign(process.env, ${JSON.stringify(env)});
        process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 = '';
        process.env.STORAGE_ROOT = ${JSON.stringify(tmpDir)};
        const { start } = require(${JSON.stringify(path.join(ROOT, 'backend/server.js'))});
        start().catch((e) => { console.error('BOOT_FAILED', e.message); process.exit(9); });
      `], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });

      let out = '';
      let done = false;
      const finish = (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { child.kill(); } catch (_) { /* already gone */ }
        resolve({ code, output: out });
      };
      const onData = (b) => {
        out += b.toString();
        // A successful boot prints the banner and then listens forever, which
        // would hang the test — stop waiting as soon as we see it.
        if (waitForListen && /running/.test(out)) setTimeout(() => finish(0), 50);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('exit', (code) => finish(code));
      const timer = setTimeout(() => finish(-1), 20000);
    });
  }

  it('exits on Railway instead of serving every request as one shared uid', async () => {
    const res = await boot({ NODE_ENV: 'development', ALLOW_DEV_AUTH: 'true', RAILWAY: '1' });
    expect(res.code).toBe(1);
    expect(res.output).toMatch(/DEV AUTH MOCK IS ENABLED/);
  });

  it('exits when PUBLIC_BASE_URL points at a public https origin', async () => {
    const res = await boot({
      NODE_ENV: 'development', ALLOW_DEV_AUTH: 'true', PUBLIC_BASE_URL: 'https://storyplay.app',
    });
    expect(res.code).toBe(1);
  });

  it('still boots locally, which is the documented way to work on it', async () => {
    // Guards against over-correcting: ALLOW_DEV_AUTH=true is how a developer
    // runs this with no Firebase project, so it must keep working off-host.
    const res = await boot({ NODE_ENV: 'development', ALLOW_DEV_AUTH: 'true', PORT: '0' }, { waitForListen: true });
    expect(res.output).not.toMatch(/on what looks like a public deployment/);
    expect(res.output).toMatch(/running/);
  });
});
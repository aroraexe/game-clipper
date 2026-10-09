import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

// Firebase is intentionally left unconfigured so requireAuth must fail closed.
delete process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;

let app;
beforeAll(async () => {
  const mod = await import('../backend/server.js');
  app = mod.default || mod;
});

describe('health', () => {
  it('is reachable without auth', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('auth fail-closed', () => {
  it('does not allow anonymous job creation', async () => {
    const res = await request(app)
      .post('/api/videos')
      .send({ story: 'a'.repeat(100), gameplayId: 'minecraft' });
    expect([401, 503]).toContain(res.status);
    expect(res.status).not.toBe(202);
  });

  it('does not allow anonymous story generation', async () => {
    const res = await request(app)
      .post('/api/videos/generate-story')
      .send({ duration: 45, type: 'reddit' });
    expect([401, 503]).toContain(res.status);
  });

  it('does not allow anonymous gameplay listing', async () => {
    const res = await request(app).get('/api/gameplay');
    expect([401, 503]).toContain(res.status);
  });

  it('does not allow anonymous job status reads', async () => {
    const res = await request(app).get('/api/videos/does-not-exist');
    expect([401, 503]).toContain(res.status);
  });
});

describe('/app gate', () => {
  it('redirects to /signin when no session cookie is present', async () => {
    const res = await request(app).get('/app');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/signin');
  });

  it('rejects a forged cookie instead of trusting its presence', async () => {
    const res = await request(app).get('/app').set('Cookie', 'sessionToken=forged-value');
    // Must NOT serve the protected page.
    expect(res.status).not.toBe(200);
  });
});

describe('output endpoint', () => {
  it('does not serve an unsigned output URL', async () => {
    const res = await request(app).get('/api/videos/does-not-exist/output');
    expect([401, 403, 404, 503]).toContain(res.status);
  });

  it('rejects an unsigned request for a missing job with a 404, not a file', async () => {
    const res = await request(app).get('/api/videos/nope/output');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

describe('hardening headers', () => {
  it('sets a Content-Security-Policy', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("object-src 'none'");
  });

  it('sets a correlation id on every response', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f]{16}$/);
  });

  it('echoes a caller-supplied request id', async () => {
    const res = await request(app).get('/api/health').set('X-Request-Id', 'abc123');
    expect(res.headers['x-request-id']).toBe('abc123');
  });

  it('sets the standard helmet headers', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
  });
});

describe('unknown routes', () => {
  it('returns a JSON 404', async () => {
    const res = await request(app).get('/definitely/not/here');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });
});

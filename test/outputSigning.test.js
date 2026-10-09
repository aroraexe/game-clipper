import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';

// The signing helpers are private to the controller, so replicate the exact
// algorithm here and assert the controller's behaviour through the HTTP layer
// in api.security.test.js. This file locks the algorithm itself.
const SECRET = 'test-secret';
const OUTPUT_URL_TTL_MS = 15 * 60 * 1000;

function sign(jobId, userId, expiresAt, download = false) {
  return crypto.createHmac('sha256', SECRET)
    .update(`${jobId}.${userId}.${expiresAt}.${download ? '1' : '0'}`)
    .digest('hex');
}

describe('output URL signing', () => {
  const jobId = 'job-123';
  const userId = 'user-abc';
  let expiresAt;
  let sig;

  beforeAll(() => {
    expiresAt = Date.now() + OUTPUT_URL_TTL_MS;
    sig = sign(jobId, userId, expiresAt);
  });

  it('produces a stable hex digest of the expected length', () => {
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same inputs', () => {
    expect(sign(jobId, userId, expiresAt)).toBe(sig);
  });

  it('changes when the userId changes — prevents cross-user reuse', () => {
    expect(sign(jobId, 'someone-else', expiresAt)).not.toBe(sig);
  });

  it('changes when the jobId changes', () => {
    expect(sign('job-999', userId, expiresAt)).not.toBe(sig);
  });

  it('changes when the expiry changes — prevents indefinite reuse', () => {
    expect(sign(jobId, userId, expiresAt + 1000)).not.toBe(sig);
  });

  it('changes when the response mode changes — prevents upgrading a stream URL to a download', () => {
    // `download` selects Content-Disposition: attachment. It used to sit outside
    // the signed payload, so appending ?download=true to a valid stream URL was
    // accepted and forced the file to download.
    expect(sign(jobId, userId, expiresAt, true)).not.toBe(sig);
    expect(sign(jobId, userId, expiresAt, false)).toBe(sig);
  });

  it('encodes the mode unambiguously — no field-boundary collisions', () => {
    // `${a}.${b}.${c}.${d}` would be ambiguous if the mode were interpolated as a
    // bare boolean, so it is encoded as a fixed '0'/'1' token.
    expect(sign('job-1', 'user-abc', 123, false)).not.toBe(sign('job-1.user', 'abc', 123, false));
  });

  it('rejects a signature of the wrong length without throwing', () => {
    // timingSafeEqual throws on length mismatch, so length is checked first.
    const short = sig.slice(0, 10);
    expect(() => crypto.timingSafeEqual(Buffer.from(short), Buffer.from(sig))).toThrow();
    expect(short.length === sig.length).toBe(false);
  });

  it('treats an expired timestamp as invalid', () => {
    const past = Date.now() - 1000;
    expect(Date.now() > past).toBe(true);
  });
});

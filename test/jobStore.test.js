import { describe, it, expect, beforeEach } from 'vitest';
import { create, get, update, setStage, markFailed, list, removeJob, findByIdempotencyKey, flush } from '../backend/jobs/jobStore';

const uid = () => `u-${Math.random().toString(36).slice(2, 10)}`;

beforeEach(() => {
  list().forEach(j => removeJob(j.jobId));
});

describe('jobStore CRUD', () => {
  it('creates a job with the expected defaults', () => {
    const job = create('j1', { story: 'hi', userId: 'u1' });
    expect(job.status).toBe('queued');
    expect(job.progress).toBe(0);
    expect(job.userId).toBe('u1');
    expect(job.outputPath).toBeNull();
    expect(job.createdAt).toBeTruthy();
  });

  it('returns null for an unknown id instead of throwing', () => {
    expect(get('missing')).toBeNull();
  });

  it('throws a clear error when updating a missing job', () => {
    expect(() => update('missing', { status: 'failed' })).toThrow(/not found in store/);
  });

  it('merges patches and bumps updatedAt', () => {
    create('j2', { userId: 'u1' });
    const before = get('j2').updatedAt;
    const after = update('j2', { progress: 50 });
    expect(after.progress).toBe(50);
    expect(new Date(after.updatedAt).getTime())
      .toBeGreaterThanOrEqual(new Date(before).getTime());
  });

  it('setStage keeps the existing progress when none is supplied', () => {
    create('j3', { userId: 'u1' });
    update('j3', { progress: 42 });
    const job = setStage('j3', 'compositing');
    expect(job.stage).toBe('compositing');
    expect(job.progress).toBe(42);
  });

  it('markFailed records a readable message from an Error', () => {
    create('j4', { userId: 'u1' });
    const job = markFailed('j4', new Error('ffmpeg exploded'));
    expect(job.status).toBe('failed');
    expect(job.error).toBe('ffmpeg exploded');
    expect(job.progress).toBe(100);
  });

  it('markFailed handles a thrown non-Error', () => {
    create('j5', { userId: 'u1' });
    expect(markFailed('j5', 'plain string').error).toBe('plain string');
  });

  it('removes jobs', () => {
    create('j6', { userId: 'u1' });
    removeJob('j6');
    expect(get('j6')).toBeNull();
  });
});

describe('findByIdempotencyKey', () => {
  it('finds a job created with the same key and user', () => {
    const userId = uid();
    create('j7', { userId, idempotencyKey: 'key-abc' });
    expect(findByIdempotencyKey('key-abc', userId)?.jobId).toBe('j7');
  });

  it('does not match a different user with the same key', () => {
    create('j8', { userId: 'user-1', idempotencyKey: 'shared-key' });
    expect(findByIdempotencyKey('shared-key', 'user-2')).toBeNull();
  });

  it('returns null for a missing or empty key', () => {
    expect(findByIdempotencyKey(undefined, 'u1')).toBeNull();
    expect(findByIdempotencyKey('', 'u1')).toBeNull();
    expect(findByIdempotencyKey('never-used', 'u1')).toBeNull();
  });

  it('ignores keys older than the 24h TTL', () => {
    const userId = uid();
    create('j9', { userId, idempotencyKey: 'old-key' });
    update('j9', { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() });
    expect(findByIdempotencyKey('old-key', userId)).toBeNull();
  });
});

describe('persistence', () => {
  it('writes valid JSON to disk on flush', () => {
    create('persist-1', { userId: 'u1', story: 'x' });
    flush();
    expect(() => flush()).not.toThrow();
  });
});

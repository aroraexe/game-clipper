import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The stores read STORAGE_ROOT at import time, so redirect it before importing.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plans-'));
process.env.STORAGE_ROOT = tmpDir;

const { PLANS, DEFAULT_PLAN, planFor } = await import('../backend/config/plans.js');
const userStore = await import('../backend/jobs/userStore.js');

afterAll(() => {
  userStore.flush();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const HOUR = 60 * 60 * 1000;
const DAY  = 24 * HOUR;

describe('plan definitions', () => {
  it('keeps paid videos far longer than free ones', () => {
    expect(PLANS.pro.retentionMs).toBeGreaterThan(PLANS.free.retentionMs);
    expect(PLANS.pro.retentionMs).toBe(7 * DAY);
    expect(PLANS.free.retentionMs).toBe(1 * HOUR);
  });

  it('gives subscribers higher limits than free users', () => {
    expect(PLANS.pro.maxActiveJobs).toBeGreaterThan(PLANS.free.maxActiveJobs);
    expect(PLANS.pro.maxStoryChars).toBeGreaterThan(PLANS.free.maxStoryChars);
    expect(PLANS.free.watermark).toBe(true);
    expect(PLANS.pro.watermark).toBe(false);
  });
});

describe('planFor', () => {
  const resolve = (uid) => userStore.planNameFor(uid);

  it('gives an unknown user the free plan', () => {
    expect(planFor(() => null, 'nobody').label).toBe(PLANS.free.label);
    expect(planFor(() => null, null).label).toBe(PLANS.free.label);
  });

  it('falls back to free when the plan name is not recognised', () => {
    // A stale or hand-edited store must never grant more than free.
    expect(planFor(() => 'enterprise-unlimited', 'u1').label).toBe(PLANS.free.label);
  });
});

describe('userStore entitlements', () => {
  beforeEach(() => {
    userStore.flush();
  });

  it('defaults a brand new user to free and not entitled', () => {
    expect(userStore.planNameFor('brand-new')).toBe(DEFAULT_PLAN);
    expect(userStore.isEntitled('brand-new')).toBe(false);
  });

  it('grants pro to an active subscription', () => {
    userStore.upsert('sub-1', { email: 'a@b.c', plan: 'pro', subscriptionStatus: 'active' });
    expect(userStore.planNameFor('sub-1')).toBe('pro');
    expect(userStore.isEntitled('sub-1')).toBe(true);
  });

  it('grants pro while trialing', () => {
    userStore.upsert('trial-1', { plan: 'pro', subscriptionStatus: 'trialing' });
    expect(userStore.isEntitled('trial-1')).toBe(true);
  });

  it('revokes pro the moment payment fails — no grace period on storage', () => {
    userStore.upsert('failed-1', { plan: 'pro', subscriptionStatus: 'active' });
    expect(userStore.isEntitled('failed-1')).toBe(true);

    userStore.upsert('failed-1', { subscriptionStatus: 'past_due' });
    expect(userStore.isEntitled('failed-1')).toBe(false);
    expect(planFor((u) => userStore.planNameFor(u), 'failed-1').retentionMs).toBe(1 * HOUR);
  });

  it('revokes pro on cancel and on unpaid', () => {
    for (const status of ['canceled', 'unpaid', 'incomplete_expired', 'none', '']) {
      userStore.upsert(`s-${status}`, { plan: 'pro', subscriptionStatus: 'active' });
      userStore.upsert(`s-${status}`, { subscriptionStatus: status });
      expect(userStore.isEntitled(`s-${status}`)).toBe(false);
    }
  });

  it('preserves fields it was not asked to change', () => {
    userStore.upsert('keep-1', { email: 'keep@x.com', plan: 'pro', subscriptionStatus: 'active', stripeCustomerId: 'cus_123' });
    userStore.upsert('keep-1', { subscriptionStatus: 'past_due' });
    const u = userStore.get('keep-1');
    expect(u.email).toBe('keep@x.com');
    expect(u.stripeCustomerId).toBe('cus_123');
    expect(u.createdAt).toBeTruthy();
  });

  it('rejects an upsert with no uid', () => {
    expect(() => userStore.upsert(null, { plan: 'pro' })).toThrow(/uid/);
  });

  it('normalises loose plan strings from a payment provider', () => {
    expect(userStore.normalisePlan('Pro')).toBe('pro');
    expect(userStore.normalisePlan('ACTIVE')).toBe('pro');
    expect(userStore.normalisePlan('active')).toBe('pro');
    expect(userStore.normalisePlan('nonsense')).toBe('free');
    expect(userStore.normalisePlan(undefined)).toBe('free');
  });

  it('survives a reload from disk without losing the subscription', () => {
    userStore.upsert('persist-me', { email: 'p@x.com', plan: 'pro', subscriptionStatus: 'active' });
    userStore.flush();
    const onDisk = JSON.parse(fs.readFileSync(userStore.STORE_PATH, 'utf8'));
    expect(onDisk['persist-me'].plan).toBe('pro');
    expect(onDisk['persist-me'].subscriptionStatus).toBe('active');
  });
});

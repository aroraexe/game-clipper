import { describe, it, expect, afterEach, afterAll } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

// userStore reads STORAGE_ROOT at import time, so redirect it before importing.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-'));
process.env.STORAGE_ROOT = tmpDir;

/*
 * Load through createRequire, NOT `await import()`.
 *
 * The billing modules use CommonJS `require`, so an ESM import here would go
 * through vite's interop and hand back a SECOND instance of userStore with its
 * own empty Map — every assertion about recorded plans would fail against a store
 * the production code never touches. Same registry, same state.
 */
const require = createRequire(import.meta.url);

const ENV_KEYS = [
  'NODE_ENV', 'PUBLIC_BASE_URL', 'RAILWAY_PUBLIC_DOMAIN', 'DISPLAY_CURRENCY',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_PRO',
  'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'RAZORPAY_PLAN_PRO',
];
const saved = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
function clearBillingEnv() {
  for (const k of ENV_KEYS) {
    if (k === 'NODE_ENV') continue;
    delete process.env[k];
  }
}

const config    = require('../backend/config/billing.config.js');
const stripe    = require('../backend/billing/stripe.billing.js');
const razorpay  = require('../backend/billing/razorpay.billing.js');
const userStore = require('../backend/jobs/userStore.js');

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

afterAll(() => {
  userStore.flush();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ─── Configuration ─────────────────────────────────────────────────────────── */

describe('billing configuration', () => {
  it('reports every provider unusable when nothing is configured', () => {
    clearBillingEnv();
    const status = config.providerStatus();
    expect(status).toHaveLength(2);
    expect(status.every((p) => p.usable === false)).toBe(true);
    expect(config.usableProviders()).toEqual([]);
  });

  it('treats a provider with a key but no price as NOT usable', () => {
    // Better to hide the buy button than to render one that 500s at checkout.
    clearBillingEnv();
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    const s = config.providerStatus().find((p) => p.provider === 'stripe');
    expect(s.configured).toBe(true);
    expect(s.usable).toBe(false);
    expect(s.missing).toContain('STRIPE_PRICE_PRO');
  });

  it('names every missing var for Razorpay', () => {
    clearBillingEnv();
    process.env.RAZORPAY_KEY_ID = 'rzp_test_x';
    const r = config.providerStatus().find((p) => p.provider === 'razorpay');
    expect(r.usable).toBe(false);
    expect(r.missing).toContain('RAZORPAY_KEY_SECRET');
    expect(r.missing).toContain('RAZORPAY_PLAN_PRO');
  });

  it('enables each provider once it is fully configured', () => {
    clearBillingEnv();
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.STRIPE_PRICE_PRO = 'price_x';
    process.env.RAZORPAY_KEY_ID = 'rzp_test_x';
    process.env.RAZORPAY_KEY_SECRET = 'secret';
    process.env.RAZORPAY_PLAN_PRO = 'plan_x';
    expect(config.usableProviders().sort()).toEqual(['razorpay', 'stripe']);
    expect(config.billingProblems()).toEqual([]);
  });

  it('falls back to the Railway domain for the return URL', () => {
    clearBillingEnv();
    process.env.RAILWAY_PUBLIC_DOMAIN = 'storyplay.up.railway.app';
    expect(config.publicBaseUrl()).toBe('https://storyplay.up.railway.app');
  });

  it('never returns a base URL with a trailing slash', () => {
    clearBillingEnv();
    process.env.PUBLIC_BASE_URL = 'https://example.com/';
    expect(config.publicBaseUrl()).toBe('https://example.com');
  });

  it('refuses to create a checkout when there is no return URL', async () => {
    clearBillingEnv();
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.STRIPE_PRICE_PRO = 'price_x';
    await expect(stripe.createCheckout({ uid: 'u1', plan: 'pro', origin: '' }))
      .rejects.toThrow(/PUBLIC_BASE_URL/);
  });

  it('refuses to charge for a plan that has no configured price', async () => {
    clearBillingEnv();
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.STRIPE_PRICE_PRO = 'price_x';
    process.env.PUBLIC_BASE_URL = 'https://example.com';
    await expect(stripe.createCheckout({ uid: 'u1', plan: 'enterprise', origin: '' }))
      .rejects.toThrow(/no price configured/i);
  });
});

/* ─── Entitlement ordering ──────────────────────────────────────────────────── */

describe('applyBillingEvent', () => {
  it('grants pro on an active subscription', () => {
    const r = userStore.applyBillingEvent('b-user-1', {
      plan: 'pro', subscriptionStatus: 'active', occurredAt: 1000,
      subscriptionId: 'sub_1', billingProvider: 'stripe', stripeCustomerId: 'cus_1',
    });
    expect(r.applied).toBe(true);
    expect(userStore.planNameFor('b-user-1')).toBe('pro');
    expect(userStore.get('b-user-1').subscriptionId).toBe('sub_1');
  });

  it('ignores an older event so a retried cancellation cannot beat a renewal', () => {
    // Webhook delivery is not ordered across event types. Without the guard, a
    // delayed `deleted` replay would revoke a subscription that is still paid.
    userStore.applyBillingEvent('b-user-2', { plan: 'pro', subscriptionStatus: 'active', occurredAt: 2000 });
    const stale = userStore.applyBillingEvent('b-user-2', {
      plan: 'free', subscriptionStatus: 'canceled', occurredAt: 1000,
    });
    expect(stale.applied).toBe(false);
    expect(stale.reason).toBe('stale');
    expect(userStore.planNameFor('b-user-2')).toBe('pro');
  });

  it('still applies a newer downgrade', () => {
    userStore.applyBillingEvent('b-user-3', { plan: 'pro', subscriptionStatus: 'active', occurredAt: 1000 });
    const newer = userStore.applyBillingEvent('b-user-3', {
      plan: 'free', subscriptionStatus: 'past_due', occurredAt: 2000,
    });
    expect(newer.applied).toBe(true);
    expect(userStore.planNameFor('b-user-3')).toBe('free');
  });

  it('refuses to apply an event with no user', () => {
    expect(userStore.applyBillingEvent(null, { plan: 'pro' }).reason).toBe('missing-uid');
  });

  it('finds the owning user from a provider customer id', () => {
    userStore.applyBillingEvent('b-user-4', {
      billingProvider: 'razorpay', billingCustomerId: 'cust_rzp_1', occurredAt: 1000,
    });
    expect(userStore.findUidByBillingCustomer('razorpay', 'cust_rzp_1')).toBe('b-user-4');
    expect(userStore.findUidByBillingCustomer('razorpay', 'cust_missing')).toBeNull();
    expect(userStore.findUidByBillingCustomer(null, 'cust_rzp_1')).toBeNull();
  });

  it('does not confuse a Razorpay customer id with a Stripe one', () => {
    userStore.applyBillingEvent('b-user-5', {
      stripeCustomerId: 'cus_shared', billingProvider: 'stripe', occurredAt: 1000,
    });
    expect(userStore.findUidByBillingCustomer('stripe', 'cus_shared')).toBe('b-user-5');
    expect(userStore.findUidByBillingCustomer('razorpay', 'cus_shared')).toBeNull();
  });
});

/* ─── Stripe ────────────────────────────────────────────────────────────────── */

describe('stripe', () => {
  it('grants pro only for statuses that represent money in hand', () => {
    expect(stripe.planForStatus('active')).toBe('pro');
    expect(stripe.planForStatus('trialing')).toBe('pro');
    // A failed renewal or a pause must NOT keep 7-day retention alive.
    for (const status of ['past_due', 'unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'paused', undefined]) {
      expect(stripe.planForStatus(status)).toBe('free');
    }
  });

  it('prefers the session uid, then the customer id lookup', () => {
    expect(stripe._internal.resolveUid({ uid: 'direct', customerId: null })).toEqual({ uid: 'direct' });
    userStore.applyBillingEvent('b-stripe-owner', {
      stripeCustomerId: 'cus_lookup', billingProvider: 'stripe', occurredAt: 1,
    });
    expect(stripe._internal.resolveUid({ uid: null, customerId: 'cus_lookup' })).toEqual({ uid: 'b-stripe-owner' });
    expect(stripe._internal.resolveUid({ uid: null, customerId: 'cus_nope' })).toEqual({ uid: null });
  });

  it('downgrades to free when a subscription is deleted', async () => {
    userStore.applyBillingEvent('b-stripe-del', {
      plan: 'pro', subscriptionStatus: 'active', stripeCustomerId: 'cus_del', occurredAt: 1000,
    });
    const r = await stripe.handleEvent({
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_del', status: 'canceled', customer: 'cus_del', metadata: {}, created: 2000 } },
    });
    expect(r.handled).toBe(true);
    expect(userStore.planNameFor('b-stripe-del')).toBe('free');
  });

  it('acknowledges event types it deliberately ignores instead of erroring', async () => {
    // Stripe retries anything that is not 2xx; an unhandled-but-authentic event
    // must not cause infinite redelivery.
    const r = await stripe.handleEvent({ type: 'invoice.created', data: { object: {} } });
    expect(r.handled).toBe(false);
    expect(r.reason).toBe('invoice.created');
  });

  it('refuses to verify a webhook with no secret configured', () => {
    clearBillingEnv();
    expect(() => stripe.constructEvent(Buffer.from('{}'), 'sig'))
      .toThrow(/STRIPE_WEBHOOK_SECRET/);
  });

  it('refuses to open a portal for an account with no customer', async () => {
    await expect(stripe.createPortal({ uid: 'never-purchased', origin: 'https://x.com' }))
      .rejects.toThrow(/No Stripe customer/);
  });
});

/* ─── Razorpay ──────────────────────────────────────────────────────────────── */

describe('razorpay', () => {
  it('maps its own status vocabulary onto the shared entitlement set', () => {
    expect(razorpay.mapStatus('active')).toEqual({ plan: 'pro', status: 'active' });
    expect(razorpay.mapStatus('authenticated')).toEqual({ plan: 'pro', status: 'active' });
    // Money has not actually moved yet.
    expect(razorpay.mapStatus('created').plan).toBe('free');
    expect(razorpay.mapStatus('pending').plan).toBe('free');
    // Razorpay gave up collecting.
    expect(razorpay.mapStatus('halted').plan).toBe('free');
    expect(razorpay.mapStatus('cancelled').plan).toBe('free');
    expect(razorpay.mapStatus('completed').plan).toBe('free');
  });

  it('accepts a numeric OR string created_at', () => {
    expect(razorpay._internal.toUnix('1700000000')).toBe(1700000000);
    expect(razorpay._internal.toUnix(1700000000)).toBe(1700000000);
    expect(razorpay._internal.toUnix(null)).toBeNull();
    expect(razorpay._internal.toUnix('')).toBeNull();
  });

  it('reads the subscription out of either payload shape', () => {
    // Razorpay nests it as payload.entity.entity on some accounts and
    // payload.entity directly on others. `unwrap` takes the payload, not the
    // whole event envelope.
    const nested = razorpay._internal.unwrap(
      { entity: { entity: { id: 'sub_a', status: 'active' }, notes: { uid: 'u-nested' }, customer_id: 'c1' } },
      1700000000
    );
    expect(nested.subscription.id).toBe('sub_a');
    expect(nested.notes.uid).toBe('u-nested');
    expect(nested.customerId).toBe('c1');
    expect(nested.eventAt).toBe(1700000000);

    const flat = razorpay._internal.unwrap({ entity: { id: 'sub_b', status: 'active', customer_id: 'c2' } });
    expect(flat.subscription.id).toBe('sub_b');
    expect(flat.customerId).toBe('c2');
    // No envelope timestamp -> apply unconditionally rather than guess an order.
    expect(flat.eventAt).toBeNull();
  });

  it('orders events by the ENVELOPE timestamp, not the subscription creation time', () => {
    // A subscription object's created_at never changes. Using it would make every
    // renewal/cancellation look older than the first event and be dropped as
    // stale, so a cancellation would never take effect.
    const parsed = razorpay._internal.unwrap(
      { entity: { entity: { id: 'sub_x', status: 'cancelled', created_at: 1000 } } },
      5000
    );
    expect(parsed.eventAt).toBe(5000);
    expect(parsed.subscription.created_at).toBe(1000);
  });

  it('grants pro on activation using the uid from subscription notes', async () => {
    const r = await razorpay.handleEvent({
      event: 'subscription.activated',
      payload: {
        entity: {
          entity: { id: 'sub_r1', status: 'active', customer_id: 'cust_r1', current_end: 1800000000 },
          notes: { uid: 'b-rzp-user', plan: 'pro' },
        },
      },
      created_at: 1700000000,
    });
    expect(r.handled).toBe(true);
    expect(r.uid).toBe('b-rzp-user');
    expect(userStore.planNameFor('b-rzp-user')).toBe('pro');
    expect(userStore.get('b-rzp-user').currentPeriodEnd).toBe(1800000000);
  });

  it('downgrades to free when the subscription is halted', async () => {
    userStore.applyBillingEvent('b-rzp-halt', {
      plan: 'pro', subscriptionStatus: 'active', billingProvider: 'razorpay',
      billingCustomerId: 'cust_h', occurredAt: 1000,
    });
    await razorpay.handleEvent({
      event: 'subscription.halted',
      payload: { entity: { entity: { id: 'sub_h', status: 'halted', customer_id: 'cust_h' } } },
      created_at: 2000,
    });
    expect(userStore.planNameFor('b-rzp-halt')).toBe('free');
    expect(userStore.get('b-rzp-halt').subscriptionStatus).toBe('past_due');
  });

  it('does NOT revoke Pro on a single failed payment', async () => {
    // Razorpay retries charges; revoking on the first failure would delete the
    // videos of anyone whose card merely expired for a day.
    userStore.applyBillingEvent('b-rzp-retry', {
      plan: 'pro', subscriptionStatus: 'active', billingProvider: 'razorpay', occurredAt: 1000,
    });
    const r = await razorpay.handleEvent({ event: 'payment.failed', payload: { entity: {} } });
    expect(r.handled).toBe(false);
    expect(userStore.planNameFor('b-rzp-retry')).toBe('pro');
  });

  it('verifies a genuine checkout signature', () => {
    clearBillingEnv();
    process.env.RAZORPAY_KEY_ID = 'rzp_test_x';
    process.env.RAZORPAY_KEY_SECRET = 'secret';
    process.env.RAZORPAY_PLAN_PRO = 'plan_x';
    const sig = crypto.createHmac('sha256', 'secret').update('pay_1|sub_1').digest('hex');
    expect(razorpay.verifyCheckoutSignature({
      paymentId: 'pay_1', subscriptionId: 'sub_1', signature: sig,
    })).toBe(true);
  });

  it('rejects a forged or mismatched checkout signature', () => {
    clearBillingEnv();
    process.env.RAZORPAY_KEY_SECRET = 'secret';
    expect(() => razorpay.verifyCheckoutSignature({
      paymentId: 'pay_1', subscriptionId: 'sub_1', signature: 'deadbeef',
    })).toThrow(/verification failed/);
    // Any missing field must fail rather than short-circuit to a pass.
    expect(() => razorpay.verifyCheckoutSignature({ subscriptionId: 'sub_1', signature: 'x' }))
      .toThrow(/Missing Razorpay/);
  });

  it('verifies a webhook only with the correct signature over the raw body', () => {
    clearBillingEnv();
    process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec';
    const raw = JSON.stringify({ event: 'subscription.activated', payload: { entity: {} } });
    const good = crypto.createHmac('sha256', 'whsec').update(`evt_1|${raw}`).digest('hex');
    expect(razorpay.constructEvent(Buffer.from(raw), good, 'evt_1').event).toBe('subscription.activated');
    expect(() => razorpay.constructEvent(Buffer.from(raw), 'bad', 'evt_1'))
      .toThrow(/verification failed/);
    // A valid signature over a DIFFERENT body must not pass.
    expect(() => razorpay.constructEvent(Buffer.from('{"event":"x"}'), good, 'evt_1'))
      .toThrow(/verification failed/);
  });

  it('refuses to verify webhooks with no secret configured', () => {
    clearBillingEnv();
    expect(() => razorpay.constructEvent(Buffer.from('{}'), 'sig', 'evt'))
      .toThrow(/RAZORPAY_WEBHOOK_SECRET/);
  });

  it('rejects a webhook body that is not JSON even when signed correctly', () => {
    clearBillingEnv();
    process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec';
    const raw = 'not json at all';
    const sig = crypto.createHmac('sha256', 'whsec').update(`evt_1|${raw}`).digest('hex');
    expect(() => razorpay.constructEvent(Buffer.from(raw), sig, 'evt_1')).toThrow(/not valid JSON/);
  });

  it('ignores a subscription event for a user it cannot identify', async () => {
    const r = await razorpay.handleEvent({
      event: 'subscription.activated',
      payload: { entity: { entity: { id: 'sub_orphan', status: 'active', customer_id: 'cust_unknown' } } },
      created_at: 1700000000,
    });
    expect(r.handled).toBe(false);
    expect(r.reason).toBe('unknown-user');
  });
});

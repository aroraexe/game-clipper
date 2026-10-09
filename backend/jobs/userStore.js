'use strict';
/**
 * userStore.js
 * ────────────
 * Persistent record of who a user is and which plan they are on.
 *
 * This file is the thing that decides whether someone keeps their videos for
 * 7 days or 1 hour, so losing it locks paying customers out. Writes are
 * therefore atomic (tmp file + rename) and a corrupt file is preserved rather
 * than silently discarded, matching jobStore.js.
 *
 * Lives on the same storage root as the job store, i.e. on a Railway volume.
 */

const fs   = require('fs');
const path = require('path');
const { STORAGE_ROOT } = require('../utils/storage.util');
const { DEFAULT_PLAN } = require('../config/plans');

const STORE_PATH = path.join(STORAGE_ROOT, 'userStore.json');

/** @type {Map<string, object>} */
let users = new Map();

function loadStore() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
      users = new Map(Object.entries(data || {}));
      console.log(`[UserStore] Loaded ${users.size} user(s) from disk`);
    }
  } catch (err) {
    // Never silently continue empty: that would mark every paying customer as
    // free and delete their videos early.
    console.error('[UserStore] CRITICAL: could not parse store:', err.message);
    const backup = `${STORE_PATH}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(STORE_PATH, backup);
      console.error('[UserStore] Corrupt file preserved at:', backup);
    } catch (_) { /* nothing further we can do */ }
    throw err;
  }
}

let saveScheduled = false;
function writeStoreNow() {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    const tmp = `${STORE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(users)), 'utf8');
    fs.renameSync(tmp, STORE_PATH);
  } catch (err) {
    console.error('[UserStore] Failed to save store:', err.message);
  }
}

function saveStore() {
  if (saveScheduled) return;
  saveScheduled = true;
  setImmediate(() => {
    saveScheduled = false;
    writeStoreNow();
  });
}

function flush() { writeStoreNow(); }

loadStore();

/** Normalise anything Stripe hands us into a plan name we recognise. */
function normalisePlan(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'pro' || v === 'active' || v === 'paid' || v === 'subscriber') return 'pro';
  return DEFAULT_PLAN;
}

/**
 * Is the subscription currently in good standing?
 * Only 'active' and 'trialing' grant the paid plan; past_due / canceled /
 * unpaid fall back to free immediately rather than continuing to serve 7-day
 * retention to someone whose payment failed.
 */
const ENTITLED_STATUSES = new Set(['active', 'trialing']);

function get(uid) {
  return users.get(uid) || null;
}

/** Plan name for a uid, defaulting to free. Used by plans.planFor(). */
function planNameFor(uid) {
  const u = users.get(uid);
  if (!u) return DEFAULT_PLAN;
  if (u.plan === 'pro' && ENTITLED_STATUSES.has(u.subscriptionStatus)) return 'pro';
  return DEFAULT_PLAN;
}

function isEntitled(uid) {
  return planNameFor(uid) === 'pro';
}

function upsert(uid, patch = {}) {
  if (!uid) throw new Error('userStore.upsert requires a uid');
  const now = new Date().toISOString();
  const existing = users.get(uid);
  const record = {
    uid,
    email:              patch.email ?? existing?.email ?? null,
    plan:               patch.plan !== undefined ? normalisePlan(patch.plan) : (existing?.plan || DEFAULT_PLAN),
    subscriptionStatus: patch.subscriptionStatus !== undefined
                          ? String(patch.subscriptionStatus || '').toLowerCase()
                          : (existing?.subscriptionStatus || 'none'),
    stripeCustomerId:   patch.stripeCustomerId ?? existing?.stripeCustomerId ?? null,
    // Generic billing identity. Stripe ids land in stripeCustomerId, Razorpay's
    // `cust_...` ids land here, and keeping them separate avoids a Razorpay
    // customer id being mistaken for a Stripe one by a webhook replay.
    billingProvider:    patch.billingProvider ?? existing?.billingProvider ?? null,
    billingCustomerId:  patch.billingCustomerId ?? existing?.billingCustomerId ?? null,
    subscriptionId:     patch.subscriptionId ?? existing?.subscriptionId ?? null,
    currentPeriodEnd:   patch.currentPeriodEnd ?? existing?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd:  patch.cancelAtPeriodEnd ?? existing?.cancelAtPeriodEnd ?? false,
    // Unix seconds of the newest billing event already applied to this record.
    // Webhook delivery is NOT ordered across event types: a retried
    // `subscription.deleted` can arrive after the `...created` it should follow,
    // which would silently re-grant or wrongly revoke Pro. See applyBillingEvent.
    billingEventAt:     patch.billingEventAt ?? existing?.billingEventAt ?? null,
    createdAt:          existing?.createdAt || now,
    updatedAt:          now,
  };
  users.set(uid, record);
  saveStore();
  return record;
}

/** Convenience for the webhook handler. */
function setPlan(uid, plan, subscriptionStatus = 'active', extra = {}) {
  return upsert(uid, { ...extra, plan, subscriptionStatus });
}

/**
 * Reverse lookup: which user does this billing customer id belong to?
 *
 * Checkout sessions and most webhooks hand us a customer id but not always the
 * Firebase uid, and the uid is the only key everything else is stored against.
 * Linear scan, but the store holds one row per account so it is fine at any size
 * this product will plausibly reach; it runs once per webhook, not per request.
 *
 * @returns {string|null}
 */
function findUidByBillingCustomer(provider, customerId) {
  if (!provider || !customerId) return null;
  for (const u of users.values()) {
    if (u.billingProvider === provider && u.billingCustomerId === customerId) return u.uid;
    if (provider === 'stripe' && u.stripeCustomerId === customerId) return u.uid;
  }
  return null;
}

/**
 * Apply a subscription state change originating from a payment provider.
 *
 * `occurredAt` is the provider's own event timestamp (unix seconds), NOT the time
 * we processed it. Providers retry events, and a retry of an old cancellation can
 * land after a newer renewal, so we drop anything older than the last event we
 * already applied to this user. Without that guard the last-delivered event wins
 * regardless of which is newer, which is how subscribers end up with Pro they
 * cancelled or without Pro they paid for.
 *
 * @returns {{applied: boolean, reason?: string, record?: object}}
 */
function applyBillingEvent(uid, event = {}) {
  if (!uid) return { applied: false, reason: 'missing-uid' };

  const existing = users.get(uid);
  const occurredAt = Number(event.occurredAt || 0) || null;
  const lastApplied = Number(existing?.billingEventAt || 0) || null;

  if (occurredAt && lastApplied && occurredAt < lastApplied) {
    console.warn(`[UserStore] Ignoring stale billing event for ${uid} (${occurredAt} < ${lastApplied})`);
    return { applied: false, reason: 'stale' };
  }

  const record = upsert(uid, {
    ...event,
    billingEventAt: occurredAt || lastApplied || undefined,
  });
  return { applied: true, record };
}

function list() {
  return Array.from(users.values());
}

module.exports = {
  get, upsert, setPlan, list, planNameFor, isEntitled, flush, normalisePlan,
  findUidByBillingCustomer, applyBillingEvent,
  STORE_PATH,
};

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
    subscriptionId:     patch.subscriptionId ?? existing?.subscriptionId ?? null,
    currentPeriodEnd:   patch.currentPeriodEnd ?? existing?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd:  patch.cancelAtPeriodEnd ?? existing?.cancelAtPeriodEnd ?? false,
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

function list() {
  return Array.from(users.values());
}

module.exports = {
  get, upsert, setPlan, list, planNameFor, isEntitled, flush, normalisePlan,
  STORE_PATH,
};

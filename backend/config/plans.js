'use strict';
/**
 * plans.js
 * ─────────
 * Single source of truth for what each plan gets.
 *
 * Retention used to be a hardcoded 1 hour for everybody, which is fine while
 * the product is free but unsellable: a customer who pays cannot keep what
 * they bought. Retention is now read from here, per user, at cleanup time.
 *
 * Adding a plan (or changing prices) should only require editing this file.
 */

const MINUTE = 60 * 1000;
const HOUR   = 60 * MINUTE;
const DAY    = 24 * HOUR;

/**
 * @typedef {Object} Plan
 * @property {number} retentionMs      how long a finished video is kept
 * @property {number} maxActiveJobs    concurrent queued/rendering jobs allowed
 * @property {number} maxStoryChars    server-side cap on submitted story length
 * @property {boolean} watermark       burn a watermark into free-tier output
 * @property {string} label            human-readable, for the UI and logs
 */

/** @type {Record<string, Plan>} */
const PLANS = {
  free: {
    label:         'Free',
    retentionMs:   1 * HOUR,
    maxActiveJobs: 2,
    maxStoryChars: 1500,
    watermark:     true,
  },
  pro: {
    label:         'Pro (monthly)',
    retentionMs:   7 * DAY,
    maxActiveJobs: 6,
    maxStoryChars: 3000,
    watermark:     false,
  },
};

const DEFAULT_PLAN = 'free';

/**
 * Resolve the plan name for a user id.
 * Kept as a function so the caller can inject the store (and so tests can stub
 * it) instead of this module reaching into storage on its own.
 *
 * @param {(uid: string) => string|null} resolvePlanName
 * @param {string|null} uid
 * @returns {Plan}
 */
function planFor(resolvePlanName, uid) {
  const name = (uid && resolvePlanName(uid)) || DEFAULT_PLAN;
  // Unknown or stale plan name must never grant more than the free tier.
  return PLANS[name] || PLANS[DEFAULT_PLAN];
}

module.exports = { PLANS, DEFAULT_PLAN, planFor };

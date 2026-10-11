'use strict';
/**
 * me.routes.js
 * ────────────
 * Lets the signed-in frontend find out which plan the user is on, so the UI
 * can show the right limits and upsell the right thing. Deliberately returns
 * no Stripe secret or customer id — the frontend has no use for them.
 */

const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth.middleware');
const { planFor, PLANS } = require('../config/plans');
const userStore = require('../jobs/userStore');
const jobStore  = require('../jobs/jobStore');

router.get('/', requireAuth, (req, res) => {
  const plan = planFor((uid) => userStore.planNameFor(uid), req.user.uid);
  const record = userStore.get(req.user.uid);
  const usedThisMonth = userStore.getRecentJobCount(req.user.uid, userStore.ROLLING_WINDOW_MS);
  const maxThisMonth = plan.maxJobsPerMonth || plan.maxJobsPerDay;
  const remainingThisMonth = Math.max(0, maxThisMonth - usedThisMonth);

  res.json({
    uid:   req.user.uid,
    email: req.user.email || record?.email || null,
    plan: {
      name:            userStore.planNameFor(req.user.uid),
      label:           plan.label,
      maxActiveJobs:   plan.maxActiveJobs,
      maxStoryChars:   plan.maxStoryChars,
      maxJobsPerMonth: plan.maxJobsPerMonth,
      maxJobsPerDay:   plan.maxJobsPerDay,
      watermark:       plan.watermark,
      retentionMs:     plan.retentionMs,
    },
    usage: {
      jobsThisMonth:      usedThisMonth,
      remainingThisMonth,
      maxJobsPerMonth:    maxThisMonth,
      // Backward-compatibility aliases for existing clients:
      jobsToday:          usedThisMonth,
      remainingToday:     remainingThisMonth,
      maxJobsPerDay:      maxThisMonth,
    },
    subscription: {
      status:            record?.subscriptionStatus || 'none',
      cancelAtPeriodEnd: !!record?.cancelAtPeriodEnd,
      currentPeriodEnd:  record?.currentPeriodEnd || null,
      provider:          record?.billingProvider || null,
    },
    availablePlans: Object.entries(PLANS).map(([name, p]) => ({
      name,
      label:           p.label,
      maxStoryChars:   p.maxStoryChars,
      maxActiveJobs:   p.maxActiveJobs,
      maxJobsPerMonth: p.maxJobsPerMonth,
      maxJobsPerDay:   p.maxJobsPerDay,
    })),
  });
});

module.exports = router;

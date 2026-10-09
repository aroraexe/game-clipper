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

const DAY_MS = 24 * 60 * 60 * 1000;

function jobsCreatedToday(uid) {
  const cutoff = Date.now() - DAY_MS;
  return jobStore.list().filter((j) =>
    j.userId === uid && new Date(j.createdAt).getTime() > cutoff
  ).length;
}

router.get('/', requireAuth, (req, res) => {
  const plan = planFor((uid) => userStore.planNameFor(uid), req.user.uid);
  const record = userStore.get(req.user.uid);
  const usedToday = jobsCreatedToday(req.user.uid);
  const remainingToday = Math.max(0, plan.maxJobsPerDay - usedToday);

  res.json({
    uid:   req.user.uid,
    email: req.user.email || record?.email || null,
    plan: {
      name:          userStore.planNameFor(req.user.uid),
      label:         plan.label,
      maxActiveJobs: plan.maxActiveJobs,
      maxStoryChars: plan.maxStoryChars,
      maxJobsPerDay: plan.maxJobsPerDay,
      watermark:     plan.watermark,
      retentionMs:   plan.retentionMs,
    },
    usage: {
      jobsToday:      usedToday,
      remainingToday,
      maxJobsPerDay:  plan.maxJobsPerDay,
    },
    subscription: {
      status:            record?.subscriptionStatus || 'none',
      cancelAtPeriodEnd: !!record?.cancelAtPeriodEnd,
      currentPeriodEnd:  record?.currentPeriodEnd || null,
      provider:          record?.billingProvider || null,
    },
    availablePlans: Object.entries(PLANS).map(([name, p]) => ({
      name,
      label: p.label,
      maxStoryChars: p.maxStoryChars,
      maxActiveJobs: p.maxActiveJobs,
      maxJobsPerDay: p.maxJobsPerDay,
    })),
  });
});

module.exports = router;

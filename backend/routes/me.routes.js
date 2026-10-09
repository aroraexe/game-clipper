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

router.get('/', requireAuth, (req, res) => {
  const plan = planFor((uid) => userStore.planNameFor(uid), req.user.uid);
  const record = userStore.get(req.user.uid);

  res.json({
    uid:   req.user.uid,
    email: req.user.email || record?.email || null,
    plan: {
      name:         userStore.planNameFor(req.user.uid),
      label:        plan.label,
      retentionMs:  plan.retentionMs,
      maxActiveJobs: plan.maxActiveJobs,
      maxStoryChars: plan.maxStoryChars,
      watermark:    plan.watermark,
    },
    subscription: {
      status:          record?.subscriptionStatus || 'none',
      currentPeriodEnd: record?.currentPeriodEnd || null,
      cancelAtPeriodEnd: !!record?.cancelAtPeriodEnd,
      // Which provider this was bought through, so the UI can send the user to
      // the right management screen. No customer or subscription ids are exposed.
      provider:        record?.billingProvider || null,
    },
    availablePlans: Object.entries(PLANS).map(([name, p]) => ({
      name: name, label: p.label, maxStoryChars: p.maxStoryChars, maxActiveJobs: p.maxActiveJobs,
    })),
  });
});

module.exports = router;

'use strict';
/**
 * billing.routes.js
 * ──────────────────
 * Authenticated, user-facing billing endpoints.
 *
 * Everything provider-specific lives in backend/billing/*.js; this file only
 * resolves the provider from the request and forwards. That is deliberate — when
 * a third provider is added, this file does not change.
 *
 *   GET  /api/billing/config          which buttons the pricing page should show
 *   POST /api/billing/checkout        start a subscription purchase
 *   POST /api/billing/portal          Stripe portal, or cancel (Razorpay)
 *   POST /api/billing/razorpay/verify confirm a Razorpay checkout return
 *
 * The uid is taken from the verified Firebase session (req.user.uid) and NEVER
 * from the request body. That is what stops a caller from upgrading somebody
 * else's account with their own card.
 */

const express = require('express');
const router  = express.Router();
const { requireAuth, optionalAuth } = require('../middleware/auth.middleware');
const config   = require('../config/billing.config');
const stripe   = require('../billing/stripe.billing');
const razorpay = require('../billing/razorpay.billing');
const userStore = require('../jobs/userStore');
const { PLANS } = require('../config/plans');

/** 5xx messages can leak provider internals; 4xx ones are safe and actionable. */
function fail(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error('[Billing]', err);
  res.status(status).json({ error: status >= 500 ? 'Billing is temporarily unavailable.' : err.message });
}

function providers() {
  return {
    stripe:    stripe,
    razorpay:  razorpay,
  };
}

/**
 * Which buttons the pricing page should draw.
 *
 * Public, because a signed-out visitor has to be able to see that Pro exists and
 * that a payment method is available before being asked to sign in. Only the
 * provider flags and the currency are public; the `plan` block is null unless the
 * request carried a valid session.
 */
router.get('/config', optionalAuth, (req, res) => {
  const status = config.providerStatus();
  const record = req.user ? userStore.get(req.user.uid) : null;

  res.json({
    currency: config.displayCurrency(),
    providers: status.map((p) => ({
      provider: p.provider,
      label:    p.label,
      // 'redirect' = server sends the browser to a hosted page.
      // 'razorpay-js' = frontend opens the Razorpay widget with the returned id.
      enabled:  p.usable,
      checkout: p.usable ? p.checkout : null,
    })),
    plan: req.user ? {
      name:        userStore.planNameFor(req.user.uid),
      entitled:    userStore.isEntitled(req.user.uid),
      status:      record?.subscriptionStatus || 'none',
      cancelAtPeriodEnd: !!record?.cancelAtPeriodEnd,
      currentPeriodEnd:  record?.currentPeriodEnd || null,
      provider:    record?.billingProvider || null,
    } : null,
    plans: Object.entries(PLANS).map(([name, p]) => ({ name, label: p.label })),
  });
});

router.use(requireAuth);

router.post('/checkout', async (req, res) => {
  const provider = String(req.body?.provider || '').toLowerCase();
  const plan     = String(req.body?.plan || 'pro').toLowerCase();

  if (!providers()[provider]) {
    return res.status(400).json({ error: `Unknown billing provider "${provider}".` });
  }
  if (!config.isUsable(provider)) {
    const status = config.providerStatus().find((p) => p.provider === provider);
    return res.status(503).json({
      error: `${provider} is not available yet.`,
      missing: status?.missing || [],
    });
  }

  try {
    const result = await providers()[provider].createCheckout({
      uid:   req.user.uid,
      email: req.user.email,
      plan,
      // Only used if PUBLIC_BASE_URL is unset; harmless otherwise and never
      // trusted for anything security-relevant.
      origin: `${req.protocol}://${req.get('host')}`,
    });

    // Record the account/email on first purchase attempt so a webhook that lands
    // before any subscription event can still resolve this uid from the customer
    // id, and so /api/me can show something useful.
    userStore.upsert(req.user.uid, { email: req.user.email || null });

    if (provider === 'stripe') return res.json({ provider, mode: 'redirect', url: result.url });
    return res.json({ provider, mode: 'razorpay-js', ...result });
  } catch (err) {
    fail(res, err);
  }
});

router.post('/portal', async (req, res) => {
  const provider = String(req.body?.provider || userStore.get(req.user.uid)?.billingProvider || 'stripe').toLowerCase();
  const impl = providers()[provider];
  if (!impl) return res.status(400).json({ error: `Unknown billing provider "${provider}".` });
  if (!config.isUsable(provider)) {
    return res.status(503).json({ error: `${provider} is not available yet.` });
  }

  try {
    const result = await impl.createPortal({
      uid: req.user.uid,
      origin: `${req.protocol}://${req.get('host')}`,
    });
    return res.json({ provider, ...result });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * Cancel a subscription.
 *
 * Razorpay has no customer-portal equivalent, so this IS its manage/cancel path —
 * without it a Razorpay subscriber has no way to stop being charged and has to
 * go to the provider's dashboard by hand or dispute the charge, which is both a
 * support burden and a chargeback. Stripe subscribers use /portal instead, but
 * accept a cancel here too so the frontend has one button.
 *
 * The uid comes from the verified session and the subscription id from the
 * session's OWN record — never from the body — so a caller can only ever cancel
 * their own subscription.
 */
router.post('/cancel', async (req, res) => {
  const provider = String(req.body?.provider || userStore.get(req.user.uid)?.billingProvider || '').toLowerCase();
  const record = userStore.get(req.user.uid);

  if (!record?.subscriptionId) {
    return res.status(400).json({ error: 'There is no subscription on this account to cancel.' });
  }

  try {
    let result;
    if (provider === 'stripe') {
      await stripe.cancelSubscription({ uid: req.user.uid, subscriptionId: record.subscriptionId });
      result = { cancelledAtPeriodEnd: true };
    } else if (provider === 'razorpay') {
      if (!config.isUsable('razorpay')) {
        return res.status(503).json({ error: 'Razorpay is not available right now.' });
      }
      result = await razorpay.cancelSubscription({ uid: req.user.uid });
    } else {
      return res.status(400).json({
        error: `Cannot cancel a "${provider || 'unknown'}" subscription here.`,
      });
    }

    // Record the intent locally. Cancellation takes effect at period end, so the
    // plan is deliberately left alone — downgrading now would delete videos the
    // customer already paid to keep. The provider's webhook is what flips the
    // plan; this only stops the UI claiming otherwise.
    userStore.applyBillingEvent(req.user.uid, {
      cancelAtPeriodEnd: true,
      occurredAt: Math.floor(Date.now() / 1000),
    });

    return res.json({ provider, ...result, plan: userStore.planNameFor(req.user.uid) });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * Razorpay returns the user to the app after the widget closes. Until this runs
 * the account is still Free, which would look like the payment bounced — so the
 * frontend calls this immediately on return.
 *
 * The signature proves the payment object is real; the subscription fetch is what
 * proves it was paid. We only grant what Razorpay itself reports.
 */
router.post('/razorpay/verify', async (req, res) => {
  if (!config.isUsable('razorpay')) {
    return res.status(503).json({ error: 'Razorpay is not available yet.' });
  }

  const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = req.body || {};
  try {
    razorpay.verifyCheckoutSignature({
      paymentId:      razorpay_payment_id,
      subscriptionId: razorpay_subscription_id,
      signature:      razorpay_signature,
    });

    // Ownership is settled BEFORE anything is written.
    //
    // This used to call confirmSubscription() first and only compare uids
    // afterwards. By then applySubscription had already written the subscription
    // onto whichever record notes.uid named, so the 403 protected the response
    // but not the store — the check was theatre. confirmSubscription now takes
    // the session uid as a bound and refuses to apply anyone else's
    // subscription, so the mismatch can never reach userStore.
    const result = await razorpay.confirmSubscription(razorpay_subscription_id, req.user.uid);

    if (result.reason === 'uid-mismatch') {
      console.error(`[Billing] razorpay/verify: subscription ${razorpay_subscription_id} is not owned by the caller.`);
      return res.status(403).json({ error: 'That subscription belongs to a different account.' });
    }

    return res.json({
      provider: 'razorpay',
      verified: true,
      // The webhook still owns renewals and cancellations; this is only for
      // instant UI feedback.
      pendingWebhook: !result.handled,
      plan: userStore.planNameFor(req.user.uid),
    });
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;

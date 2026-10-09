'use strict';
/**
 * stripe.billing.js
 * ──────────────────
 * Stripe subscriptions, isolated behind a small interface so the rest of the app
 * never learns which provider a customer paid with.
 *
 * Interface (implemented identically by razorpay.billing.js):
 *   isUsable()            -> boolean
 *   createCheckout()      -> { url }            hosted Checkout redirect
 *   createPortal()        -> { url }            customer portal (cancel / invoices)
 *   constructEvent()      -> verified event object, or throws
 *   handleEvent()         -> { handled: boolean, uid?: string }
 *
 * Entitlement mapping
 * -------------------
 * Stripe subscription status is stored verbatim in userStore.subscriptionStatus,
 * and only 'active' / 'trialing' grant Pro. So a failed renewal, a pause or an
 * unpaid invoice downgrades the account on the very next webhook rather than
 * serving 7-day retention to someone who stopped paying. That is deliberate:
 * the cost of being generous is deleted paid videos.
 */

const config = require('../config/billing.config');
const userStore = require('../jobs/userStore');

/** Lazily constructed so importing this module never requires credentials. */
let client = null;
function stripe() {
  if (!config.isUsable('stripe')) {
    throw new Error('Stripe is not configured. Set STRIPE_SECRET_KEY and STRIPE_PRICE_PRO.');
  }
  if (!client) {
    const Stripe = require('stripe');
    client = new Stripe(config.stripeSecretKey());
  }
  return client;
}

/** Stripe statuses that grant the paid plan. Mirrors userStore's entitled set. */
const ENTITLED = new Set(['active', 'trialing']);

function planForStatus(status) {
  return ENTITLED.has(String(status || '').toLowerCase()) ? 'pro' : 'free';
}

function toUnix(dateish) {
  if (!dateish) return null;
  const n = Math.floor(Number(dateish));
  return Number.isFinite(n) ? n : null;
}

/**
 * Start a subscription purchase.
 *
 * The Firebase uid is stamped onto the session in two places on purpose:
 * `client_reference_id` (Stripe's own field, shown in the dashboard, cannot be
 * spoofed by the client) and `metadata.uid` (what the webhook reads first).
 * client_reference_id is the important one — it is set server-side from the
 * verified session, so a customer cannot pass someone else's uid and have their
 * own card upgrade that account.
 */
async function createCheckout({ uid, email, plan = 'pro', origin = '' }) {
  const price = config.stripePriceId();
  if (plan !== 'pro') throw new Error(`Stripe has no price configured for the "${plan}" plan.`);

  const base = config.publicBaseUrl() || origin;
  if (!base) {
    throw new Error(
      'PUBLIC_BASE_URL is not set, so Stripe has nowhere to return the customer after payment. ' +
      'Set it to your public site origin.'
    );
  }

  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    client_reference_id: uid,
    customer_email: email || undefined,
    metadata: { uid, plan },
    subscription_data: { metadata: { uid, plan } },
    allow_promotion_codes: true,
    success_url: `${base}/app?upgraded=1&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/pricing?checkout=cancelled`,
  });

  if (!session.url) throw new Error('Stripe did not return a checkout URL.');
  return { url: session.url, sessionId: session.id };
}

/** Stripe-hosted cancel / update-card / invoice history page. */
async function createPortal({ uid, origin = '' }) {
  const record = userStore.get(uid);
  const customerId = record?.stripeCustomerId;
  if (!customerId) {
    throw new Error('No Stripe customer is on file for this account yet.');
  }

  const base = config.publicBaseUrl() || origin;
  if (!base) throw new Error('PUBLIC_BASE_URL is not set, so the Stripe portal has no return URL.');

  const session = await stripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: `${base}/app`,
  });
  return { url: session.url };
}

/**
 * Verify the webhook signature against the RAW body.
 *
 * The signature covers the exact bytes Stripe sent, so this must run on
 * `express.raw()` output. If it is ever handed a re-serialised object the digest
 * will not match and every event is rejected — which is the correct failure mode,
 * since an unverified webhook means anyone can grant themselves Pro.
 */
function constructEvent(rawBody, signature) {
  const secret = config.stripeWebhookSecret();
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not set; cannot verify webhooks.');
  return require('stripe').webhooks.constructEvent(rawBody, signature, secret);
}

/**
 * Work out which local user an event refers to.
 *
 * `metadata.uid` is authoritative when present — it is stamped server-side from
 * the verified Firebase session at checkout, so a browser cannot forge it.
 *
 * The customer id is only a FALLBACK, and only when it does not contradict the
 * metadata. It used to be `uid || findUidByBillingCustomer(...)`, which meant a
 * subscription carrying someone else's uid in metadata would happily overwrite
 * that account, including stealing the customer id onto its record. Once two
 * accounts point at the same `cus_...`, every later event for that customer
 * resolves to whichever row happened to be written first — so one account
 * cancelling could downgrade a completely different paying subscriber.
 *
 * A contradiction is therefore refused rather than resolved in favour of one
 * side: an event that names two different accounts is not something we can
 * attribute, and guessing is what caused the cross-account write.
 *
 * @returns {{uid: string|null, reason?: string}}
 */
function resolveUid({ uid, customerId }) {
  const owner = customerId ? userStore.findUidByBillingCustomer('stripe', customerId) : null;

  if (uid && owner && owner !== uid) {
    console.error(
      `[Stripe] Refusing to apply event: metadata.uid=${uid} but customer ${customerId} ` +
      `belongs to ${owner}. One customer id cannot serve two accounts.`
    );
    return { uid: null, reason: 'uid-customer-conflict' };
  }
  return { uid: uid || owner || null };
}

/**
 * @param {object} sub            the Stripe subscription object
 * @param {object} [opts]
 * @param {string|null} [opts.uid]           session uid, when known
 * @param {string|null} [opts.fallbackEmail]  ONLY an email address
 * @param {number|null} [opts.occurredAt]    the WEBHOOK ENVELOPE timestamp (event.created)
 */
async function applySubscription(sub, { uid = null, fallbackEmail = null, occurredAt = null } = {}) {
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
  const status = String(sub.status || '').toLowerCase();
  const { uid: resolved, reason } = resolveUid({ uid: sub.metadata?.uid || uid, customerId });

  if (!resolved) {
    if (reason === 'uid-customer-conflict') {
      return { handled: false, reason };
    }
    console.error(`[Stripe] No local user for customer ${customerId}; event ignored.`);
    return { handled: false, reason: 'unknown-user' };
  }

  const result = userStore.applyBillingEvent(resolved, {
    plan:               planForStatus(status),
    subscriptionStatus: status,
    stripeCustomerId:   customerId || null,
    billingProvider:    'stripe',
    billingCustomerId:  customerId || null,
    subscriptionId:     sub.id,
    currentPeriodEnd:   toUnix(sub.current_period_end),
    cancelAtPeriodEnd:  !!sub.cancel_at_period_end,
    email:              fallbackEmail || undefined,
    // The ENVELOPE timestamp, never `sub.created`.
    //
    // `sub.created` is fixed at purchase and never changes, so every event for a
    // given subscription carried the SAME ordering key and userStore's stale-event
    // guard could never reject anything: `occurredAt < lastApplied` was always
    // false. Stripe delivers at-least-once and does not order across event types,
    // so a redelivered pre-cancellation `subscription.updated` re-granted Pro to
    // someone who had already cancelled — and it was never cleaned up, because
    // every subsequent event looked equally "current".
    occurredAt,
  });

  console.log(`[Stripe] ${sub.id} ${status} -> ${result.applied ? `${planForStatus(status)} for ${resolved}` : `ignored (${result.reason})`}`);
  return { handled: true, uid: resolved, applied: result.applied };
}

/** The one path that can grant Pro from a purchase, and the one that must not fail silently. */
async function onCheckoutCompleted(session, occurredAt) {
  const subId = typeof session.subscription === 'string'
    ? session.subscription
    : session.subscription?.id;

  if (!subId) {
    // One-off payment mode, or a subscription not attached yet. Record the
    // customer so a later event can find this user, and leave the plan alone.
    const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
    const { uid } = resolveUid({
      uid: session.client_reference_id || session.metadata?.uid,
      customerId,
    });
    if (uid) {
      userStore.applyBillingEvent(uid, {
        stripeCustomerId: customerId || null,
        billingProvider: 'stripe',
        billingCustomerId: customerId || null,
        email: session.customer_details?.email || session.customer_email || undefined,
        occurredAt,
      });
    }
    return { handled: false, reason: 'no-subscription' };
  }

  // Read the subscription back rather than trusting the session: the session can
  // complete while payment is still `unpaid`, and granting Pro on that would give
  // away the paid tier for free.
  const sub = await stripe().subscriptions.retrieve(subId);
  return applySubscription(sub, {
    uid: session.client_reference_id || session.metadata?.uid,
    fallbackEmail: session.customer_details?.email,
    occurredAt,
  });
}

/**
 * Route a verified event. Returns { handled } so the caller can log-and-200 the
 * events we deliberately do nothing with, instead of Stripe retrying them forever.
 *
 * `event.created` is threaded into every apply call on purpose — see the note in
 * applySubscription about why the subscription's own `created` is not an ordering key.
 */
async function handleEvent(event) {
  const occurredAt = toUnix(event?.created);

  switch (event.type) {
    case 'checkout.session.completed':
      return onCheckoutCompleted(event.data.object, occurredAt);

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      return applySubscription(event.data.object, { occurredAt });

    case 'customer.subscription.deleted': {
      // status is 'canceled' here; retention reverts to the free tier at once.
      return applySubscription(event.data.object, { occurredAt });
    }

    case 'invoice.payment_failed': {
      // Stripe also sends subscription.updated for this, but doing it here means
      // the downgrade does not depend on subscription events being enabled in the
      // dashboard — which they are not, by default.
      const sub = event.data.object.subscription;
      const subId = typeof sub === 'string' ? sub : sub?.id;
      if (!subId) {
        return { handled: false, reason: 'no-subscription' };
      }
      const fetched = await stripe().subscriptions.retrieve(subId);
      // Preserve the authoritative status from the subscription object itself.
      if (String(fetched.status || '').toLowerCase() === 'active') {
        console.warn('[Stripe] invoice.payment_failed but subscription is still active; not downgrading.');
        return { handled: false, reason: 'still-active' };
      }
      // NOTE: no fallbackEmail. This used to pass `customerId` as the third
      // positional argument, which is `fallbackEmail` — so a failed invoice
      // overwrote the account's email with "cus_XXXX". resolveUid() already
      // looks the uid up by customer id, so nothing is lost by omitting it, and
      // upsert() preserves the stored email when the patch leaves it undefined.
      return applySubscription(fetched, { occurredAt });
    }

    case 'customer.deleted':
    case 'payment_intent.payment_failed':
      return { handled: false, reason: event.type };

    default:
      return { handled: false, reason: event.type };
  }
}

module.exports = {
  isUsable: () => config.isUsable('stripe'),
  createCheckout,
  createPortal,
  constructEvent,
  handleEvent,
  planForStatus,
  // exported for tests
  _internal: { resolveUid, toUnix, ENTITLED },
};

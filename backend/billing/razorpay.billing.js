'use strict';
/**
 * razorpay.billing.js
 * ────────────────────
 * Razorpay subscriptions — cards, UPI and netbanking — behind the same interface
 * as stripe.billing.js, so the routes and the entitlement logic are provider-blind.
 *
 * Why both providers: Stripe is the cheaper, better-documented path for
 * international cards, but UPI is how most Indian customers actually pay and
 * Stripe does not offer it. Serving only one of them quietly loses a large share
 * of buyers in the market this is aimed at.
 *
 * Razorpay differences worth knowing before editing this file:
 *  - Checkout is a client-side widget (Razorpay.js), not a server redirect. The
 *    routes return a `subscription_id` + public `key_id` and the frontend opens
 *    the modal. So `createCheckout()` does NOT return a URL here.
 *  - Webhook signatures cover `razorpay_webhook_id + "|" + rawBody`, so they
 *    need the raw body just like Stripe's.
 *  - `created_at` has been a string in some payloads and a number in others.
 *
 * Entitlement mapping
 * -------------------
 * Status is translated into userStore's entitled set rather than stored raw:
 * Razorpay's own vocabulary ('authenticated', 'halted', 'completed') has no
 * equivalent in Stripe's and would otherwise leave planNameFor() unable to judge
 * it. See STATUS_MAP.
 */

const crypto = require('crypto');
const config = require('../config/billing.config');
const userStore = require('../jobs/userStore');

let client = null;
function razorpay() {
  if (!config.isUsable('razorpay')) {
    throw new Error('Razorpay is not configured. Set RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_PLAN_PRO.');
  }
  if (!client) {
    const Razorpay = require('razorpay');
    client = new Razorpay({ key_id: config.razorpayKeyId(), key_secret: config.razorpayKeySecret() });
  }
  return client;
}

/**
 * Razorpay status -> (plan, status-to-store).
 *
 * Only the first two grant Pro. `authenticated` means the customer's bank/UPI
 * mandate is set up and the first charge is about to be taken, which is the
 * point at which every other provider considers them a subscriber; `created`
 * and `pending` mean they have not committed any money yet.
 */
const STATUS_MAP = {
  active:        { plan: 'pro',  status: 'active'   },
  authenticated: { plan: 'pro',  status: 'active'   },
  trialing:      { plan: 'pro',  status: 'trialing' },
  created:       { plan: 'free', status: 'none'     },
  pending:       { plan: 'free', status: 'pending'  },
  halted:        { plan: 'free', status: 'past_due' },
  cancelled:     { plan: 'free', status: 'canceled' },
  canceled:      { plan: 'free', status: 'canceled' },
  completed:     { plan: 'free', status: 'canceled' },
  expired:       { plan: 'free', status: 'canceled' },
  expired_cancelled: { plan: 'free', status: 'canceled' },
};

function mapStatus(raw) {
  const key = String(raw || '').toLowerCase();
  return STATUS_MAP[key] || { plan: 'free', status: key || 'none' };
}

/** Razorpay sends unix seconds as a number in some payloads and a string in others. */
function toUnix(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? n : null;
}

function publicBase(origin) {
  const base = config.publicBaseUrl() || origin;
  if (!base) {
    throw new Error(
      'PUBLIC_BASE_URL is not set, so there is no absolute URL to return the customer to after payment.'
    );
  }
  return base;
}

/**
 * Create a Razorpay subscription for the Pro plan.
 *
 * `notes.uid` is the load-bearing field: Razorpay has no client_reference_id
 * equivalent, and most subscription webhooks carry only a customer id. Notes are
 * echoed back on the subscription, so this is how we reconnect a payment to a
 * Firebase account. It is set server-side from the verified session.
 *
 * @returns {{subscriptionId: string, keyId: string, planId: string, base: string}}
 */
async function createCheckout({ uid, email, plan = 'pro', origin = '' }) {
  if (plan !== 'pro') throw new Error(`Razorpay has no plan configured for the "${plan}" plan.`);

  const sub = await razorpay().subscriptions.create({
    plan_id:              config.razorpayPlanId(),
    quantity:             1,
    total_count:          Number(process.env.RAZORPAY_TOTAL_COUNT) || 12,
    customer_notify_by:   'sms',
    description:          'StoryPlay Pro (monthly)',
    notes:                { uid, plan },
    ...(email ? { customer: { name: email.split('@')[0], email } } : {}),
  });

  return {
    subscriptionId: sub.id,
    keyId:          config.razorpayKeyId(),
    planId:         config.razorpayPlanId(),
    base:           publicBase(origin),
  };
}

/**
 * Cancel immediately, effective at the end of the paid period.
 *
 * Razorpay has no customer-portal equivalent, so this is the cancel path.
 * Cancellation takes effect at period end, so the local record keeps Pro and
 * sets cancelAtPeriodEnd — downgrading here instead would delete videos the
 * customer has already paid to keep.
 */
async function cancelSubscription({ uid }) {
  const record = userStore.get(uid);
  const subId = record?.subscriptionId;
  if (!subId) throw new Error('No active Razorpay subscription is on file for this account.');

  await razorpay().subscriptions.cancel(subId);
  return { cancelledAtPeriodEnd: true };
}

/** Razorpay shows billing history in its own dashboard; there is nothing to redirect to. */
function createPortal() {
  throw Object.assign(
    new Error('Razorpay has no hosted customer portal. Use POST /api/billing/cancel instead.'),
    { status: 400 }
  );
}

/**
 * Verify the signature Razorpay's checkout widget returns to the browser.
 *
 * This runs before we trust anything from the client, but it is NOT the
 * entitlement authority: a signature proves a payment object exists, not that the
 * subscription is paid up. We additionally fetch the subscription from Razorpay
 * and let it decide. The webhook remains authoritative for renewals.
 */
function verifyCheckoutSignature({ paymentId, subscriptionId, signature }) {
  const secret = config.razorpayKeySecret();
  if (!paymentId || !subscriptionId || !signature) {
    throw Object.assign(new Error('Missing Razorpay checkout verification fields.'), { status: 400 });
  }
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${paymentId}|${subscriptionId}`)
    .digest('hex');

  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(signature));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw Object.assign(new Error('Razorpay payment signature verification failed.'), { status: 400 });
  }
  return true;
}

/** Webhook authenticity: HMAC SHA256 over rawBody (standard Razorpay), with legacy webhookId fallback. */
function constructEvent(rawBody, signature, webhookId) {
  const secret = config.razorpayWebhookSecret();
  if (!secret) throw new Error('RAZORPAY_WEBHOOK_SECRET is not set; cannot verify webhooks.');

  const sig = String(signature || '');
  const b = Buffer.from(sig);

  // Standard Razorpay specification: HMAC-SHA256 of raw request body
  const expectedStandard = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  const aStandard = Buffer.from(expectedStandard);

  let valid = aStandard.length === b.length && crypto.timingSafeEqual(aStandard, b);

  // Fallback for custom or legacy webhookId prefix if present
  if (!valid && webhookId) {
    const expectedPrefixed = crypto
      .createHmac('sha256', secret)
      .update(`${webhookId}|${rawBody}`)
      .digest('hex');
    const aPrefixed = Buffer.from(expectedPrefixed);
    if (aPrefixed.length === b.length && crypto.timingSafeEqual(aPrefixed, b)) {
      valid = true;
    }
  }

  if (!valid) {
    throw new Error('Razorpay webhook signature verification failed.');
  }

  let body;
  try {
    body = JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'));
  } catch (e) {
    throw new Error('Razorpay webhook body was not valid JSON.');
  }
  return body;
}

/**
 * The subscription object hides in one of two places depending on the Razorpay
 * account/API version: `payload.entity.entity`, or `payload.entity` directly.
 * Notes are likewise on either. Read both rather than trusting one shape.
 *
 * @param {object} payload  the webhook's `payload` field, NOT the whole event
 * @param {number|string} [eventCreatedAt] the webhook envelope's own created_at
 */
function unwrap(payload, eventCreatedAt) {
  const outer = payload?.entity || {};
  const inner = outer.entity && typeof outer.entity === 'object' ? outer.entity : outer;
  return {
    subscription: inner,
    notes: { ...(inner.notes || {}), ...(outer.notes || {}) },
    customerId: inner.customer_id || outer.customer_id || null,
    // The envelope timestamp is the ONLY correct ordering key. The subscription
    // object's own created_at never changes, so using it would make every later
    // `subscription.updated` look older than the first event and get dropped as
    // stale — a cancellation would silently never apply.
    //
    // Falling back to null is deliberate: with no timestamp we cannot order, so
    // the event is applied unconditionally. A slightly stale write self-corrects
    // on the next event, whereas a permanently dropped event never does.
    eventAt: toUnix(eventCreatedAt),
  };
}

/**
 * Which local user does this event refer to?
 *
 * Same conflict rule as Stripe: `notes.uid` wins, but a customer id that already
 * belongs to a DIFFERENT account refuses the event instead of silently moving
 * the subscription — and the billing identity — onto the other account. Two
 * accounts sharing one `cust_...` means one account's cancellation resolves
 * through the customer id and downgrades the other.
 *
 * @returns {{uid: string|null, reason?: string}}
 */
function resolveUid(notes, customerId) {
  const fromNotes = notes && typeof notes.uid === 'string' && notes.uid ? notes.uid : null;
  const owner = customerId ? userStore.findUidByBillingCustomer('razorpay', customerId) : null;

  if (fromNotes && owner && owner !== fromNotes) {
    console.error(
      `[Razorpay] Refusing to apply event: notes.uid=${fromNotes} but customer ${customerId} ` +
      `belongs to ${owner}. One customer id cannot serve two accounts.`
    );
    return { uid: null, reason: 'uid-customer-conflict' };
  }
  return { uid: fromNotes || owner || null };
}

/**
 * Re-read a subscription from Razorpay and apply whatever state it is really in.
 *
 * Used by the post-checkout return so the user sees Pro immediately instead of
 * waiting for the webhook round trip. Deliberately re-reads from Razorpay rather
 * than trusting the values the browser sent back: a client can produce a valid
 * signature over a subscription it never paid for.
 *
 * `sessionUid` is only a fallback for when the subscription carries no notes
 * (older subscriptions created before notes were set). It is never allowed to
 * OVERRIDE notes.uid — otherwise a caller could pass someone else's
 * subscription id and have their session overwrite that stranger's plan.
 *
 * @returns {{handled: boolean, uid: string|null, applied?: boolean, reason?: string}}
 */
async function confirmSubscription(subscriptionId, sessionUid) {
  const sub = await razorpay().subscriptions.fetch(subscriptionId);
  const ownerUid = sub.notes && typeof sub.notes.uid === 'string' && sub.notes.uid ? sub.notes.uid : null;

  return applySubscription({
    subscription: sub,
    notes: ownerUid ? sub.notes : { ...(sub.notes || {}), uid: sessionUid },
    customerId: sub.customer_id || null,
    eventAt: toUnix(sub.created_at),
  });
}

function applySubscription({ subscription, notes, customerId, eventAt }) {
  const { uid, reason } = resolveUid(notes, customerId);
  if (!uid) {
    if (reason === 'uid-customer-conflict') {
      return { handled: false, reason };
    }
    console.error(`[Razorpay] No local user for subscription ${subscription.id} / customer ${customerId}; ignored.`);
    return { handled: false, reason: 'unknown-user' };
  }

  const { plan, status } = mapStatus(subscription.status);
  const result = userStore.applyBillingEvent(uid, {
    plan,
    subscriptionStatus: status,
    subscriptionId:    subscription.id,
    billingProvider:   'razorpay',
    billingCustomerId: customerId || null,
    currentPeriodEnd:  toUnix(subscription.current_end ?? subscription.current_period_end),
    cancelAtPeriodEnd: String(subscription.cancel_at_cycle_end ?? '') === '1',
    email:              (notes && notes.email) || undefined,
    occurredAt:         eventAt || toUnix(subscription.created_at),
  });

  console.log(`[Razorpay] ${subscription.id} ${subscription.status} -> ${result.applied ? `${plan} for ${uid}` : `ignored (${result.reason})`}`);
  return { handled: true, uid, applied: result.applied };
}

async function handleEvent(event) {
  const name = String(event?.event || '');
  const { subscription, notes, customerId, eventAt } = unwrap(event?.payload, event?.created_at);

  if (name.startsWith('subscription.')) {
    // subscription.pending and subscription.updated are informational.
    if (name === 'subscription.pending') return { handled: false, reason: name };
    return applySubscription({ subscription, notes, customerId, eventAt });
  }

  if (name === 'payment.captured') {
    // A captured payment on its own does not say whether a subscription exists.
    // If it belongs to one, that subscription's own events carry the status, and
    // the webhook for those is the authority — so this only records the customer
    // id, which is what lets the next event resolve a uid.
    const { uid } = resolveUid(notes, customerId);
    if (uid) {
      userStore.applyBillingEvent(uid, {
        billingProvider: 'razorpay',
        billingCustomerId: customerId || null,
        occurredAt: eventAt,
      });
    }
    return { handled: Boolean(uid), uid };
  }

  if (name === 'payment.failed') {
    // Deliberately NOT a downgrade. Razorpay retries a failed subscription charge
    // and sends subscription.halted only once it has actually given up; revoking
    // Pro on the first failure would delete the videos of everyone whose card
    // expired for a day.
    return { handled: false, reason: name };
  }

  return { handled: false, reason: name };
}

module.exports = {
  isUsable: () => config.isUsable('razorpay'),
  createCheckout,
  createPortal,
  cancelSubscription,
  verifyCheckoutSignature,
  constructEvent,
  handleEvent,
  confirmSubscription,
  mapStatus,
  // exported for tests
  _internal: { unwrap, resolveUid, toUnix, STATUS_MAP },
};

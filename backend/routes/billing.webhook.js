'use strict';
/**
 * billing.webhook.js
 * ───────────────────
 * Payment-provider webhooks. Mounted in server.js BEFORE express.json() and
 * before the rate limiter, for two reasons:
 *
 *  1. Both providers sign the exact bytes they sent. express.json() would parse
 *     the body into an object, and re-serialising it cannot reproduce those bytes,
 *     so the HMAC would never match and every event would be rejected.
 *  2. A retried webhook burst would otherwise be throttled by the 20/min POST
 *     limiter, and providers retry aggressively — a burst is normal traffic, not
 *     abuse.
 *
 * Authenticity comes from the signature, not from a token: these endpoints are
 * unauthenticated by design, which is exactly why the signature check is not
 * optional and why a missing webhook secret is a hard error.
 *
 * IDEMPOTENCY: Track processed event IDs to prevent replay attacks.
 * Stripe: event.id (e.g., "evt_..."). Razorpay: event.event + payload.entity.id
 */

const stripe    = require('../billing/stripe.billing');
const razorpay = require('../billing/razorpay.billing');
const config    = require('../config/billing.config');

/** In-memory idempotency store with TTL (1 hour). In production, use Redis. */
const processedEvents = new Map();
const IDEMPOTENCY_TTL_MS = 60 * 60 * 1000;

function markEventProcessed(eventId) {
  processedEvents.set(eventId, Date.now());
  // Cleanup old entries periodically
  if (processedEvents.size > 10000) {
    const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
    for (const [id, ts] of processedEvents.entries()) {
      if (ts < cutoff) processedEvents.delete(id);
    }
  }
}

function isEventProcessed(eventId) {
  const ts = processedEvents.get(eventId);
  if (!ts) return false;
  if (Date.now() - ts > IDEMPOTENCY_TTL_MS) {
    processedEvents.delete(eventId);
    return false;
  }
  return true;
}

/** Stripe sends the event id in a header; Razorpay puts it in the signed payload. */
function webhookIdFor(req) {
  return req.get('razorpay-webhook-id') || req.get('x-razorpay-event-id') || null;
}

function rawBody(req) {
  if (!Buffer.isBuffer(req.body)) {
    throw new Error('Webhook body arrived as parsed JSON instead of a Buffer. ' +
      'Check that the route is registered before express.json() in server.js.');
  }
  return req.body;
}

function getStripeEventId(event) {
  return event.id || null;
}

function getRazorpayEventId(event) {
  // Razorpay event format: { event: 'subscription.activated', payload: { entity: { entity: { id: 'sub_...' } } } }
  const entityId = event.payload?.entity?.entity?.id || event.payload?.entity?.id;
  return entityId ? `${event.event}:${entityId}` : null;
}

async function stripeWebhook(req, res) {
  if (!config.isConfigured('stripe')) return res.status(503).send('Stripe is not configured.');

  let event;
  try {
    event = stripe.constructEvent(rawBody(req), req.get('stripe-signature'));
  } catch (err) {
    // 400 not 500: the payload will never become valid, so a retry is pointless.
    console.warn('[Stripe Webhook] Rejected:', err.message);
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  // Idempotency check
  const eventId = getStripeEventId(event);
  if (eventId && isEventProcessed(eventId)) {
    console.log(`[Stripe Webhook] Duplicate event ${eventId} ignored`);
    return res.json({ received: true, duplicate: true });
  }

  try {
    const result = await stripe.handleEvent(event);
    console.log(`[Stripe Webhook] ${event.type} -> ${JSON.stringify(result)}`);
    if (eventId) markEventProcessed(eventId);
    // Always 200 once the event is authentic. Returning 500 here would make
    // Stripe redeliver forever an event we have already decided to ignore.
    return res.json({ received: true, ...result });
  } catch (err) {
    // Genuinely transient (network, Stripe 5xx) — let them retry.
    console.error(`[Stripe Webhook] ${event.type} failed:`, err);
    return res.status(500).send('Webhook handler failed');
  }
}

async function razorpayWebhook(req, res) {
  if (!config.isConfigured('razorpay')) return res.status(503).send('Razorpay is not configured.');

  let event;
  try {
    event = razorpay.constructEvent(rawBody(req), req.get('x-razorpay-signature'), webhookIdFor(req));
  } catch (err) {
    console.warn('[Razorpay Webhook] Rejected:', err.message);
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  // Idempotency check
  const eventId = getRazorpayEventId(event);
  if (eventId && isEventProcessed(eventId)) {
    console.log(`[Razorpay Webhook] Duplicate event ${eventId} ignored`);
    return res.json({ received: true, duplicate: true });
  }

  try {
    const result = await razorpay.handleEvent(event);
    console.log(`[Razorpay Webhook] ${event.event} -> ${JSON.stringify(result)}`);
    if (eventId) markEventProcessed(eventId);
    return res.json({ received: true, ...result });
  } catch (err) {
    console.error(`[Razorpay Webhook] ${event.event} failed:`, err);
    return res.status(500).send('Webhook handler failed');
  }
}

module.exports = { stripeWebhook, razorpayWebhook };

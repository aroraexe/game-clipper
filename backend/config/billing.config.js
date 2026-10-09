'use strict';
/**
 * billing.config.js
 * ─────────────────
 * Everything about taking money that is NOT the provider SDK calls themselves.
 *
 * Two providers are supported (Stripe and Razorpay) behind one interface, so
 * adding a third means writing one module in backend/billing/ rather than
 * touching the routes, the entitlement logic or the frontend.
 *
 * Design rules:
 *  - No price amount is hardcoded here. The canonical amount lives in the Stripe /
 *    Razorpay dashboard (that is where tax, proration and dunning are configured),
 *    and this file only maps a PLAN NAME to that dashboard's price id. If we
 *    duplicated the amount we would inevitably disagree with the dashboard and
 *    quietly mischarge someone.
 *  - A provider with a key but no price id is treated as DISABLED, not as a
 *    half-working option, so the frontend never offers a button that 500s.
 *  - Credentials are read lazily through functions, never captured at require
 *    time, so tests can point them at a temp store.
 */

const { PLANS, DEFAULT_PLAN } = require('./plans');

/** @typedef {'stripe'|'razorpay'} Provider */

const PROVIDERS = /** @type {const} */ (['stripe', 'razorpay']);

/**
 * Currency is display-only here. The real charge currency is whatever the price
 * in the dashboard is set to, and the provider enforces it.
 */
function displayCurrency() {
  return String(process.env.DISPLAY_CURRENCY || 'GBP').toUpperCase();
}

/**
 * Absolute URL to send the customer back to after paying. Required by both
 * hosted checkout flows; without it a successful payment leaves the user stranded
 * on the provider's site.
 */
function publicBaseUrl() {
  const explicit = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  if (process.env.RENDER_EXTERNAL_URL) return String(process.env.RENDER_EXTERNAL_URL).replace(/\/+$/, '');
  return '';
}

function billingProblems() {
  const problems = [];
  for (const provider of providerStatus().filter((p) => p.configured && !p.usable)) {
    problems.push(`${provider.label} is configured but incomplete: ${provider.missing.join(', ')}.`);
  }
  return problems;
}

function env(name) { return String(process.env[name] || '').trim(); }

/**
 * Which providers are safe to offer right now.
 * @returns {{provider: Provider, label: string, configured: boolean, usable: boolean, missing: string[], checkout: string}[]}
 */
function providerStatus() {
  const stripeKey    = env('STRIPE_SECRET_KEY');
  const stripePrice  = env('STRIPE_PRICE_PRO');
  const rzKeyId      = env('RAZORPAY_KEY_ID');
  const rzKeySecret  = env('RAZORPAY_KEY_SECRET');
  const rzPlan       = env('RAZORPAY_PLAN_PRO');

  return [
    {
      provider: 'stripe',
      label: 'Card',
      configured: Boolean(stripeKey),
      usable: Boolean(stripeKey && stripePrice),
      missing: [!stripeKey ? 'STRIPE_SECRET_KEY' : null, !stripePrice ? 'STRIPE_PRICE_PRO' : null].filter(Boolean),
      // Only Stripe gets hosted Checkout here; Razorpay's hosted page needs a
      // client-side script tag, which billing.js documents separately.
      checkout: stripeKey && stripePrice ? 'redirect' : null,
    },
    {
      provider: 'razorpay',
      label: 'UPI, cards and netbanking',
      configured: Boolean(rzKeyId && rzKeySecret),
      usable: Boolean(rzKeyId && rzKeySecret && rzPlan),
      missing: [
        !rzKeyId ? 'RAZORPAY_KEY_ID' : null,
        !rzKeySecret ? 'RAZORPAY_KEY_SECRET' : null,
        !rzPlan ? 'RAZORPAY_PLAN_PRO' : null,
      ].filter(Boolean),
      checkout: rzKeyId && rzKeySecret && rzPlan ? 'razorpay-js' : null,
    },
  ];
}

function isUsable(provider) {
  const status = providerStatus().find((p) => p.provider === provider);
  return Boolean(status && status.usable);
}

function isConfigured(provider) {
  const status = providerStatus().find((p) => p.provider === provider);
  return Boolean(status && status.configured);
}

/** Providers the UI should render a buy button for. */
function usableProviders() {
  return providerStatus().filter((p) => p.usable).map((p) => p.provider);
}

function stripeSecretKey()  { return env('STRIPE_SECRET_KEY'); }
function stripeWebhookSecret(){ return env('STRIPE_WEBHOOK_SECRET'); }
function stripePriceId()      { return env('STRIPE_PRICE_PRO'); }

function razorpayKeyId()       { return env('RAZORPAY_KEY_ID'); }
function razorpayKeySecret()   { return env('RAZORPAY_KEY_SECRET'); }
function razorpayWebhookSecret(){ return env('RAZORPAY_WEBHOOK_SECRET'); }
function razorpayPlanId()      { return env('RAZORPAY_PLAN_PRO'); }

module.exports = {
  PROVIDERS, PLANS, DEFAULT_PLAN,
  providerStatus, usableProviders, isUsable, isConfigured, billingProblems,
  displayCurrency, publicBaseUrl,
  stripeSecretKey, stripeWebhookSecret, stripePriceId,
  razorpayKeyId, razorpayKeySecret, razorpayWebhookSecret, razorpayPlanId,
};

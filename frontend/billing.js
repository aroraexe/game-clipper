/**
 * billing.js
 * ─────────
 * Shared payment client for the marketing site and the app.
 *
 * Plain script (no modules) because both pages that need it already use inline
 * <script> blocks and there is no bundler in this repo. Exposes
 * window.StoryPlayBilling.
 *
 * Responsibilities:
 *  - discover which providers the server has actually configured, so the UI never
 *    renders a buy button that cannot work
 *  - start a checkout and route to the right provider flow
 *  - reconcile the plan after returning from payment
 *
 * It never decides what a plan grants. Entitlements live server-side; this only
 * reports them.
 */
(function (global) {
  'use strict';

  var RAZORPAY_SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';

  function api(path, options) {
    options = options || {};
    var init = {
      method: options.method || 'GET',
      // The session lives in an httpOnly cookie, so it must be sent explicitly.
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    };
    if (options.body) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    return fetch(path, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || 'Request failed (' + res.status + ')');
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  var razorpayScriptPromise = null;

  /** Load Razorpay.js once, however many times checkout is opened. */
  function loadRazorpayScript() {
    if (global.Razorpay) return Promise.resolve(global.Razorpay);
    if (razorpayScriptPromise) return razorpayScriptPromise;

    razorpayScriptPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = RAZORPAY_SCRIPT;
      s.async = true;
      s.onload = function () { global.Razorpay ? resolve(global.Razorpay) : reject(new Error('Razorpay.js loaded but did not initialise.')); };
      s.onerror = function () {
        razorpayScriptPromise = null;   // let a later attempt retry
        reject(new Error('Could not load the Razorpay checkout script. Check your connection or any content blocker.'));
      };
      document.head.appendChild(s);
    });
    return razorpayScriptPromise;
  }

  function loadConfig() {
    return api('/api/billing/config');
  }

  /**
   * Open the checkout for `provider`.
   * Resolves once the user is back on the site; the caller then reloads /api/me.
   */
  function startCheckout(provider, plan, opts) {
    opts = opts || {};
    return api('/api/billing/checkout', {
      method: 'POST',
      body: { provider: provider, plan: plan || 'pro' }
    }).then(function (result) {
      if (result.mode === 'redirect') {
        // Stripe-hosted page. Full navigation, so nothing resolves after this.
        global.location.href = result.url;
        return new Promise(function () {});
      }

      if (result.mode === 'razorpay-js') {
        return loadRazorpayScript().then(function (Razorpay) {
          return new Promise(function (resolve, reject) {
            var checkout = new Razorpay({
              key: result.keyId,
              // Subscriptions pass subscription_id and NO order_id — Razorpay
              // creates the order itself when the mandate is authorised.
              subscription_id: result.subscriptionId,
              name: 'StoryPlay',
              description: 'StoryPlay Pro (monthly)',
              prefill: opts.email ? { email: opts.email } : {},
              theme: { color: '#111111' },
              modal: {
                ondismiss: function () {
                  // Not an error: the user simply changed their mind.
                  if (opts.onDismiss) opts.onDismiss();
                  resolve({ dismissed: true });
                }
              },
              handler: function (response) {
                // The signature only proves a payment object exists. Ask the
                // server to confirm with Razorpay directly and to apply it to
                // THIS account; never trust the plan locally.
                api('/api/billing/razorpay/verify', {
                  method: 'POST',
                  body: {
                    razorpay_payment_id: response.razorpay_payment_id,
                    razorpay_subscription_id: response.razorpay_subscription_id,
                    razorpay_signature: response.razorpay_signature
                  }
                }).then(function () {
                  if (opts.onSuccess) opts.onSuccess();
                  resolve({ ok: true });
                }).catch(function (err) {
                  if (opts.onError) opts.onError(err);
                  reject(err);
                });
              }
            });
            checkout.open();
          });
        });
      }

      return Promise.reject(new Error('The server returned an unknown checkout mode: ' + result.mode));
    });
  }

  /**
   * Stripe -> the hosted customer portal (cancel, invoices, card update).
   * Razorpay has no portal, so that path cancels the subscription at period end.
   */
  function openPortal(provider) {
    return api('/api/billing/portal', { method: 'POST', body: { provider: provider } })
      .then(function (result) {
        if (result.url) { global.location.href = result.url; return result; }
        if (result.cancelledAtPeriodEnd) return { cancelledAtPeriodEnd: true };
        return result;
      });
  }

  /**
   * Is the user entitled to Pro right now?
   * Used to decide whether to show an upgrade prompt. A failure means "no", never
   * "yes" — showing an upgrade button to a subscriber is a cosmetic bug, showing
   * Pro features to a non-subscriber loses money on every render.
   */
  function isPro() {
    return api('/api/me')
      .then(function (me) { return me.plan && me.plan.name === 'pro'; })
      .catch(function () { return false; });
  }

  global.StoryPlayBilling = {
    api: api,
    loadConfig: loadConfig,
    startCheckout: startCheckout,
    openPortal: openPortal,
    isPro: isPro,
    loadRazorpayScript: loadRazorpayScript
  };
})(window);

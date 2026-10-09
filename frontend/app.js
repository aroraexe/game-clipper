'use strict';
/* ════════════════════════════════════════════════════════════════════════════
   StoryPlay — Frontend App Logic
   Vanilla JS · No frameworks · Polls /api/videos/:jobId for status
   ════════════════════════════════════════════════════════════════════════════ */

const STORY_MIN_CHARS = 50;
const STORY_MAX_CHARS = 3000;   // hard ceiling; the plan may lower it at runtime

/* ── State ───────────────────────────────────────────────────────────────── */
const state = {
  step:       'story',
  story:      '',
  gameplayId: null,
  captionStyle: 'bold-yellow',
  captionColor: '#ffffff',
  voice:      'default',
  duration:   45,
  // Lowered to the plan's cap once /api/me answers, so a Free user is stopped
  // at 1500 characters in the browser instead of by a server 400 ten clicks later.
  maxChars:   STORY_MAX_CHARS,
  jobId:      null,
  outputUrl:  null,
  downloadUrl: null,
  pollTimer:  null,
  storyType:  'reddit',
};

// Backend URL: empty = same origin (local dev)
// Set window.__API_BASE__ in app.html for Vercel → Railway cross-origin deployment
const API_BASE = (window.__API_BASE__ || '').replace(/\/$/, '');
const apiUrl = (path) => `${API_BASE}${path}`;

// Only the ids the server's CATALOGUE actually serves. An id missing here falls
// back to the shared background rather than 404-ing on every card.
const GAMEPLAY_EMOJIS = {
  minecraft: '🧊',
  roblox:    '⬜',
  gtav:      '🎮',
  fortnite:  '🔺',
};

// 640x360 JPEGs (~90 KB each). The .jpg fallback matters: the old '.png' default
// pulled a 2.6 MB image into a grid of small cards.
const GAMEPLAY_IMAGES = {
  minecraft: 'card-media/pick-minecraft.jpg',
  roblox:    'card-media/pick-roblox.jpg',
  gtav:      'card-media/pick-gtav.jpg',
  fortnite:  'card-media/pick-fortnite.jpg',
};
const GAMEPLAY_IMAGE_FALLBACK = 'bg-minecraft.jpg';

/* ── DOM refs ────────────────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);

/* ── Init ────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  state.storyStep = initStoryStep();
  initGameplayStep();
  initCaptionsStep();
  initVoiceStep();
  initResultStep();
  checkApiReachable();
  initPlanUi();
});

/**
 * Probe the API before the user starts a render.
 *
 * __API_BASE__ is '' by default, which is correct when the Express server also
 * serves these pages (Railway). It is WRONG for a static host such as Vercel:
 * the page then calls /api/* on its own origin, where no API exists, and every
 * request fails with an opaque network/404 error. Fail loudly instead.
 */
async function checkApiReachable() {
  try {
    const res = await fetch(apiUrl('/api/health'), { method: 'GET' });
    if (!res.ok) throw new Error(`status ${res.status}`);
    return true;
  } catch (err) {
    console.error('[API] Backend unreachable at', API_BASE || window.location.origin, err);
    toast(
      `Cannot reach the API at ${API_BASE || window.location.origin}. ` +
      (API_BASE ? '' : 'Set window.__API_BASE__ in app.html to your backend URL. '),
      'error'
    );
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   PLAN & BILLING
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Pull the signed-in user's numeric limits and apply them to the editor.
 *
 * Never throws and never blocks: if the call fails the editor keeps its default
 * 3000-character ceiling and the server rejects an over-long story on submit,
 * exactly as it did before. This is a convenience, not a security control.
 */
async function applyPlanLimits() {
  try {
    const me = await window.StoryPlayBilling.api('/api/me');
    const max = me && me.plan && me.plan.maxStoryChars;
    if (!Number.isFinite(max) || max <= 0) return;

    state.maxChars = Math.min(STORY_MAX_CHARS, max);
    const ta = $('storyInput');
    if (ta) ta.maxLength = state.maxChars;
    if (state.storyStep) state.storyStep.updateCharCount();
  } catch (err) {
    console.warn('[Plan] Could not read limits:', err.message);
  }
}

/**
 * Show the user's plan in the account menu and wire the upgrade / manage button.
 *
 * This is display only. Every limit that matters (retention, story length,
 * concurrency, watermark) is enforced server-side from the plan recorded by the
 * payment webhook — so a tampered localStorage value or a hidden button changes
 * nothing about what the user is actually served.
 */
async function initPlanUi() {
  const nameEl = $('user-plan-name');
  const btn    = $('btn-manage-plan');
  const label  = $('manage-plan-label');
  if (!nameEl || !btn) return;

  let cfg;
  try {
    cfg = await window.StoryPlayBilling.loadConfig();
  } catch (err) {
    console.warn('[Plan] Could not load plan:', err.message);
    return;
  }
  if (!cfg || !cfg.plan) return;                 // signed out, or API down

  const plan  = cfg.plan;
  const isPro = plan.name === 'pro';
  const hasLiveProvider = (cfg.providers || []).some((p) => p.enabled);

  nameEl.textContent = isPro ? 'Pro' : 'Free';

  // Mirror the plan's story cap into the editor so the limit is visible while
  // typing. /api/billing/config deliberately exposes no numeric limits (it is a
  // public endpoint), so the caps come from /api/me. The server stays the
  // authority; this only removes the round trip where a Free user writes 2000
  // characters and is rejected on submit.
  applyPlanLimits();

  // One label for two different actions: a non-subscriber buys, a subscriber
  // manages (and for Razorpay, whose portal endpoint is a cancel).
  label.textContent = isPro ? 'Manage plan' : 'Upgrade to Pro';

  // A free user with no payment provider configured gets no button, rather than
  // one that opens a checkout which cannot complete.
  if (!isPro && !hasLiveProvider) {
    if (plan.status && plan.status !== 'none') {
      toast('Your last payment did not go through, so Pro is off until it does.', 'error');
    }
    return;
  }
  btn.classList.add('user-menu-item--visible');

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const original = label.textContent;
    label.textContent = isPro ? 'Opening…' : 'Opening checkout…';
    try {
      await window.StoryPlayBilling.openPortal(plan.provider || 'stripe');
      // Stripe navigates away to its portal, so nothing below runs.
      // Razorpay has no portal: the request cancels server-side, so refresh here.
      if (isPro && (plan.provider || 'stripe') === 'razorpay') {
        label.textContent = 'Cancelled at period end';
        toast('Your plan is cancelled. You keep Pro until the period ends.', 'success');
        setTimeout(() => { window.location.reload(); }, 1200);
        return;
      }
    } catch (err) {
      toast(err.message || 'Could not open billing.', 'error');
    }
    label.textContent = original;
    btn.disabled = false;
  });

  // Return from Stripe's success_url (/app?upgraded=1). The webhook may not have
  // landed yet, so re-check once and say so plainly if it has not.
  if (new URLSearchParams(window.location.search).get('upgraded')) {
    window.history.replaceState({}, '', '/app');
    setTimeout(async () => {
      const me = await window.StoryPlayBilling.api('/api/me').catch(() => null);
      toast(
        me && me.plan && me.plan.name === 'pro'
          ? 'Welcome to Pro — videos are now kept for 7 days.'
          : 'Payment received. Your Pro plan will appear in a moment — refresh if it does not.',
        'success'
      );
    }, 1200);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   STEP 1 — Story
   ═══════════════════════════════════════════════════════════════════════════ */
function initStoryStep() {
  const textarea   = $('storyInput');
  const charCount  = $('charCount');
  const charMin    = $('charMin');
  const limitLabel = $('charLimit');
  const btn        = $('btnStoryNext');
  const btnAi     = $('btnAiGenerate');
  const aiDuration = $('aiDuration');

  // Custom Dropdown Logic
  const wrapper = $('aiDurationWrapper');
  const trigger = $('aiDurationTrigger');
  const options = document.querySelectorAll('.custom-select__option');
  const label = $('aiDurationLabel');

  if (wrapper && trigger) {
    const setOpen = (open) => {
      wrapper.classList.toggle('open', open);
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    };

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      setOpen(!wrapper.classList.contains('open'));
    });

    const choose = (opt) => {
      options.forEach(o => {
        const on = o === opt;
        o.classList.toggle('selected', on);
        o.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      if (label) label.textContent = opt.textContent;
      if (aiDuration) aiDuration.value = opt.dataset.value;
      setOpen(false);
      trigger.focus();
    };

    options.forEach(opt => {
      opt.addEventListener('click', () => choose(opt));
    });

    // The trigger and options were divs with no keyboard path at all, so the
    // duration could only be changed with a mouse.
    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setOpen(true);
        const selected = wrapper.querySelector('.custom-select__option.selected') || options[0];
        if (selected) selected.focus();
      }
    });

    wrapper.addEventListener('keydown', (e) => {
      const items = Array.from(options);
      const idx = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        (items[idx + 1] || items[0]).focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        (items[idx - 1] || items[items.length - 1]).focus();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (items[idx]) choose(items[idx]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        trigger.focus();
      } else if (e.key === 'Tab') {
        setOpen(false);
      }
    });

    document.addEventListener('click', () => setOpen(false));
  }

  /**
   * Repaint the counter, its warning colour and the hint line.
   *
   * `charMin` used to be looked up here unconditionally and dereferenced on every
   * keystroke. It does not exist in app.html, so $('charMin') returned null and the
   * first character typed into the story box threw a TypeError, killing the rest
   * of the handler (the warn/error colour classes were never applied either).
   */
  const updateCharCount = () => {
    const len = textarea.value.length;
    const max = state.maxChars;
    if (charCount) charCount.textContent = len;
    if (limitLabel) limitLabel.textContent = max;

    const counter = charCount && charCount.parentElement;
    if (counter) {
      counter.classList.toggle('warn',  len > max * 0.9 && len <= max);
      counter.classList.toggle('error', len > max);
    }
    if (charMin) {
      charMin.textContent = len >= STORY_MIN_CHARS ? '' : `Minimum ${STORY_MIN_CHARS} characters`;
      charMin.classList.toggle('char-hint--ok', len >= STORY_MIN_CHARS);
    }
  };

  const examplePills = document.querySelectorAll('.example-pill');
  examplePills.forEach(pill => {
    pill.addEventListener('click', () => {
      const type = pill.dataset.type;
      state.storyType = type;
      if (btnAi) {
        btnAi.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/></svg> Generate ${pill.textContent.trim()}`;
      }
    });
  });

  if (btnAi && aiDuration) {
    btnAi.addEventListener('click', async () => {
      // innerHTML, not textContent: the label carries an inline <svg> and
      // textContent assignment silently dropped the icon on the first click.
      const originalHtml = btnAi.innerHTML;
      btnAi.innerHTML = '✨ Generating…';
      btnAi.disabled = true;

      try {
        const dur = parseInt(aiDuration.value, 10) || 45;

        const res = await fetch(apiUrl('/api/videos/generate-story'), {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ duration: dur, type: state.storyType })
        });

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'API request failed');
        }

        const data = await res.json();
        let generatedStory = String(data.story || '').replace(/^"|"$/g, '').trim();

        if (!generatedStory) throw new Error('The generator returned an empty story.');
        if (generatedStory.length > state.maxChars) {
          generatedStory = generatedStory.slice(0, state.maxChars);
          toast(`Story trimmed to your ${state.maxChars}-character plan limit.`, 'error');
        }

        textarea.value = generatedStory;
        updateCharCount();

        // The server substitutes a fixed story when the AI provider is
        // unreachable or the key is missing. Say so, otherwise a broken
        // deployment looks like normal output.
        if (data.fallback) {
          toast('AI story service is unavailable — using a sample story instead.', 'error');
        }
      } catch (err) {
        console.error('[AI Story]', err.message || err);
        toast(err.message || 'Failed to generate AI story.', 'error');
      } finally {
        btnAi.innerHTML = originalHtml;
        btnAi.disabled = false;
      }
    });
  }

  textarea.addEventListener('input', updateCharCount);
  updateCharCount();

  btn.addEventListener('click', () => {
    const text = textarea.value.trim();
    if (text.length < STORY_MIN_CHARS) return toast(`Story must be at least ${STORY_MIN_CHARS} characters.`, 'error');
    if (text.length > state.maxChars) return toast(`Story exceeds the ${state.maxChars}-character limit.`, 'error');
    state.story = text;
    goTo('gameplay');
  });

  return { updateCharCount, textarea };
}

/* ═══════════════════════════════════════════════════════════════════════════
   STEP 2 — Gameplay
   ═══════════════════════════════════════════════════════════════════════════ */
function initGameplayStep() {
  $('btnGameplayBack').addEventListener('click', () => goTo('story'));
  $('btnGameplayNext').addEventListener('click', () => {
    if (!state.gameplayId) return toast('Please select a gameplay.', 'error');
    goTo('captions');
  });
}

// Rendered once and cached. goTo('gameplay') fires on every Back/Continue pass,
// and re-fetching + re-rendering meant the grid was wiped and rebuilt every time —
// so a card the user had selected came back with no selection ring and Continue
// enabled, i.e. state the UI did not agree with.
let gameplayLoaded = false;

function renderGameplay(items) {
  const grid = $('gameplayGrid');
  grid.textContent = '';

  for (const item of items) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'gameplay-card' + (item.available ? '' : ' gameplay-card--unavailable');
    card.dataset.id = item.id;
    card.disabled = !item.available;
    if (!item.available) {
      card.setAttribute('aria-disabled', 'true');
      card.title = 'Gameplay file is missing on this server';
    }
    if (state.gameplayId === item.id) card.classList.add('gameplay-card--selected');

    // Built with DOM APIs rather than innerHTML: item.name came from the server
    // and was being interpolated straight into markup.
    const img = document.createElement('img');
    img.className = 'gameplay-card__bg';
    img.src = GAMEPLAY_IMAGES[item.id] || GAMEPLAY_IMAGE_FALLBACK;
    img.alt = item.name;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.width = 640;
    img.height = 360;

    const overlay = document.createElement('div');
    overlay.className = 'gameplay-card__overlay';

    const status = document.createElement('div');
    status.className = 'gameplay-card__status ' +
      (item.available ? 'gameplay-card__status--ok' : 'gameplay-card__status--missing');
    status.innerHTML = item.available
      ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg> Ready'
      : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> File missing';

    const info = document.createElement('div');
    info.className = 'gameplay-card__info';
    const icon = document.createElement('div');
    icon.className = 'gameplay-card__icon';
    icon.textContent = GAMEPLAY_EMOJIS[item.id] || '🎮';
    const name = document.createElement('div');
    name.className = 'gameplay-card__name';
    name.textContent = item.name;
    info.append(icon, name);

    card.append(img, overlay, status, info);

    card.addEventListener('click', () => {
      if (!item.available) {
        toast(`${item.name} is not available on this server. Choose another game.`, 'error');
        return;
      }
      selectGameplay(item.id);
    });

    grid.appendChild(card);
  }

  $('btnGameplayNext').disabled = !state.gameplayId;
}

function selectGameplay(id) {
  state.gameplayId = id;
  document.querySelectorAll('.gameplay-card').forEach((c) => {
    const on = c.dataset.id === id;
    c.classList.toggle('gameplay-card--selected', on);
    c.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  $('btnGameplayNext').disabled = false;
}

function clearGameplaySelection() {
  state.gameplayId = null;
  document.querySelectorAll('.gameplay-card--selected').forEach((c) =>
    c.classList.remove('gameplay-card--selected')
  );
  $('btnGameplayNext').disabled = true;
}

async function loadGameplay() {
  if (gameplayLoaded) {
    // Re-entering the step: just re-apply the selection, no refetch.
    $('btnGameplayNext').disabled = !state.gameplayId;
    return;
  }

  const grid = $('gameplayGrid');
  grid.innerHTML = '<div class="gameplay-loading">Loading…</div>';

  let items;
  try {
    const res  = await fetch(apiUrl('/api/gameplay'), {
      credentials: 'include',
      headers: { 'Authorization': `Bearer ${localStorage.getItem('firebaseToken')}` }
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Failed to load gameplay options.');
    items = json.gameplay;
    if (!Array.isArray(items) || items.length === 0) throw new Error('No gameplay options returned.');
  } catch (err) {
    console.error('[Gameplay]', err.message || err);
    grid.innerHTML = '';
    const msg = document.createElement('div');
    msg.className = 'gameplay-loading gameplay-loading--error';
    msg.textContent = 'Could not load gameplay options.';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn-back';
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => loadGameplay());
    msg.appendChild(retry);
    grid.appendChild(msg);
    return;
  }

  renderGameplay(items);
  gameplayLoaded = true;
}

/* ═══════════════════════════════════════════════════════════════════════════
   STEP 3 — Captions
   ═══════════════════════════════════════════════════════════════════════════ */
function initCaptionsStep() {
  document.querySelectorAll('input[name="captionColor"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      state.captionColor = e.target.value;
    });
  });

  $('btnCaptionsBack').addEventListener('click', () => goTo('gameplay'));
  $('btnCaptionsNext').addEventListener('click', () => {
    const checked = document.querySelector('input[name="captionStyle"]:checked');
    state.captionStyle = checked ? checked.value : 'bold-yellow';
    goTo('voice');
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   STEP 4 — Voice + Duration
   ═══════════════════════════════════════════════════════════════════════════ */
function initVoiceStep() {
  $('btnVoiceBack').addEventListener('click', () => goTo('captions'));

  let currentAudio = null;
  const resetIcons = () => {
    document.querySelectorAll('.voice-play-btn svg').forEach(svg => {
      svg.innerHTML = '<path d="M8 5v14l11-7z"/>';
    });
    const mainBtn = $('btnPreviewVoice');
    if (mainBtn) {
      mainBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg> Preview Voice';
      mainBtn.setAttribute('aria-pressed', 'false');
    }
  };

  const playVoice = (voiceName, btnElement) => {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.currentTime = 0;
    }
    resetIcons();

    // apiUrl, not a bare root-absolute path: with __API_BASE__ pointed at Railway
    // the previews live on the backend origin, so '/preview_x.mp3' 404'd.
    currentAudio = new Audio(apiUrl(`/preview_${voiceName}.mp3`));

    if (btnElement) {
      if (btnElement.classList.contains('btn-preview-voice')) {
        btnElement.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Stop Preview';
        btnElement.setAttribute('aria-pressed', 'true');
      } else {
        const svg = btnElement.querySelector('svg');
        if (svg) svg.innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
      }
    }

    // Autoplay policy rejects play() with an unhandled promise when the page has
    // not been interacted with; without this it surfaces as a console error and
    // the icon stays stuck on "stop" forever.
    const played = currentAudio.play();
    if (played) played.catch((err) => { console.warn('[Voice] preview blocked:', err.message); resetIcons(); });
    currentAudio.onended = resetIcons;
    currentAudio.onerror = resetIcons;
  };

  const previewVoiceBtn = $('btnPreviewVoice');
  if (previewVoiceBtn) {
    previewVoiceBtn.addEventListener('click', () => {
      if (currentAudio && !currentAudio.paused) {
        currentAudio.pause();
        currentAudio.currentTime = 0;
        resetIcons();
        return;
      }
      const checkedVoice = document.querySelector('input[name="voice"]:checked');
      if (checkedVoice) playVoice(checkedVoice.value, previewVoiceBtn);
    });
  }

  // The play button sits inside a <label>, so without preventDefault a click both
  // previewed the voice and changed the selected radio. It is a real <button> now,
  // so it is also reachable by keyboard.
  document.querySelectorAll('.voice-card').forEach(card => {
    const playBtn = card.querySelector('.voice-play-btn');
    if (!playBtn) return;

    const voiceName = card.dataset.voice;
    playBtn.setAttribute('aria-label', `Preview the ${card.querySelector('.voice-name').textContent.trim()} voice`);

    playBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Clicking the button of the voice already playing just stops it.
      if (currentAudio && !currentAudio.paused && currentAudio.src.includes(`preview_${voiceName}.mp3`)) {
        currentAudio.pause();
        currentAudio.currentTime = 0;
        resetIcons();
        return;
      }
      playVoice(voiceName, playBtn);
    });
  });

  // Stop any preview when leaving the step, so audio cannot keep playing behind
  // the captions or progress screens.
  window.addEventListener('pagehide', () => {
    if (currentAudio) { currentAudio.pause(); currentAudio.currentTime = 0; }
  });

  $('btnGenerate').addEventListener('click', async () => {
    // Without this guard a double-click fired two POST /api/videos. The server
    // dedupes only when an Idempotency-Key is sent, which this client does not
    // send — so the user paid for two renders and saw two progress bars race.
    const btn = $('btnGenerate');
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('is-busy');

    try {
      const voiceChecked    = document.querySelector('input[name="voice"]:checked');
      const durationChecked = document.querySelector('input[name="duration"]:checked');

      state.voice    = voiceChecked    ? voiceChecked.value    : 'default';
      state.duration = durationChecked ? parseInt(durationChecked.value, 10) : 45;

      await submitJob();
    } finally {
      btn.disabled = false;
      btn.classList.remove('is-busy');
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   STEP 5 — Progress polling
   ═══════════════════════════════════════════════════════════════════════════ */
async function submitJob() {
  if (!state.gameplayId) return toast('Please select a gameplay.', 'error');

  try {
    const res = await fetch(apiUrl('/api/videos'), {
      method: 'POST',
      // Idempotency-Key lets jobStore collapse a duplicate submission instead of
      // queueing a second full render for the same story. Sent on every attempt;
      // the server reuses it for 24h.
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': submitJob.key || (submitJob.key = cryptoId()),
        'Authorization': `Bearer ${localStorage.getItem('firebaseToken')}`
      },
      credentials: 'include',
      body: JSON.stringify({
        story:        state.story,
        gameplayId:   state.gameplayId,
        captionStyle: state.captionStyle,
        captionColor: state.captionColor,
        voice:        state.voice,
        duration:     state.duration,
      }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        toast('Your session expired. Please sign in again.', 'error');
        setTimeout(() => { window.location.href = '/signin'; }, 1500);
        return;
      }
      // 429 and 5xx are worth retrying with the same key: the server will collapse
      // the retry onto the original job rather than starting a second render.
      if (res.status === 429 || res.status >= 500) {
        submitJob.retries = (submitJob.retries || 0) + 1;
        if (submitJob.retries <= 3) {
          toast('The server is busy. Retrying…', 'error');
          setTimeout(() => submitJob(), 2000 * submitJob.retries);
          return;
        }
      }
      // The payload was rejected on its merits; retrying it unchanged cannot help.
      submitJob.reset();
      return toast(data.error || 'Failed to create job', 'error');
    }

    submitJob.reset();
    state.jobId = data.jobId;
    goTo('progress');
    startPolling(data.jobId);
  } catch (err) {
    submitJob.retries = (submitJob.retries || 0) + 1;
    if (submitJob.retries <= 3) {
      toast('Network problem. Retrying…', 'error');
      setTimeout(() => submitJob(), 2000 * submitJob.retries);
      return;
    }
    submitJob.reset();
    toast('Could not reach the server: ' + err.message, 'error');
  }
}

// New key per logical submission; cleared once the job exists so the next
// Generate gets its own.
submitJob.reset = function () { this.key = null; this.retries = 0; };

function cryptoId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return `sp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const STAGE_LABELS = {
  preparing_story:   'Preparing story…',
  generating_voice:  'Generating voice narration…',
  generating_assets: 'Extracting gameplay & styling captions…',
  compositing:       'Compositing video…',
  finalizing:        'Finalizing…',
  retrying:          'Retrying render…',
};

const STAGE_ORDER = [
  'preparing_story',
  'generating_voice',
  'generating_assets',
  'compositing',
  'finalizing',
];

// Must match the server's JOB_TIMEOUT_MS (default 600000) with headroom. Without
// a ceiling the progress screen polls forever if the worker dies silently, which
// is exactly what it did — the interval was never cleared on a network error and
// every error was swallowed by an empty catch.
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS  = 11 * 60 * 1000;
const POLL_MAX_ERRORS  = 5;

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

function startPolling(jobId) {
  stopPolling();
  updateProgress(0, null);

  let errors = 0;
  const startedAt = Date.now();

  state.pollTimer = setInterval(async () => {
    if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
      stopPolling();
      toast('This render is taking longer than expected. It may still finish — check back in a few minutes.', 'error');
      goTo('voice');
      return;
    }

    try {
      const res = await fetch(apiUrl(`/api/videos/${jobId}`), {
        credentials: 'include',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('firebaseToken')}` }
      });

      // A 401 here means the session cookie and the cached ID token both expired.
      // Polling on would spin forever against a 401, so hand the user back to signin.
      if (res.status === 401 || res.status === 403) {
        stopPolling();
        toast('Your session expired. Please sign in again.', 'error');
        setTimeout(() => { window.location.href = '/signin'; }, 1500);
        return;
      }

      const data = await res.json();

      if (!res.ok) {
        stopPolling();
        return toast(data.error || 'Job error', 'error');
      }

      errors = 0;
      updateProgress(data.progress || 0, data.stage);

      if (data.status === 'completed') {
        stopPolling();
        state.outputUrl = data.outputUrl ? apiUrl(data.outputUrl) : null;
        state.downloadUrl = data.downloadUrl ? apiUrl(data.downloadUrl) : null;
        showResult(jobId);
      } else if (data.status === 'failed') {
        stopPolling();
        toast(`Render failed: ${data.error || 'Unknown error'}`, 'error');
        goTo('voice');
      }
    } catch (err) {
      errors += 1;
      if (errors >= POLL_MAX_ERRORS) {
        stopPolling();
        toast('Lost contact with the server. Reload the page to check on your video.', 'error');
      }
    }
  }, POLL_INTERVAL_MS);
}

let lastStage = null;

function updateProgress(pct, stage) {
  // Ring. 2*PI*54 = 339.29 for the r="54" circle in app.html.
  const circumference = 339.29;
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  const ring = $('progressRing');
  if (ring) ring.style.strokeDashoffset = String(circumference - (clamped / 100) * circumference);

  const pctEl = $('progressPct');
  if (pctEl) pctEl.textContent = `${Math.round(clamped)}%`;

  const stageText = $('progressStage');
  if (stageText) stageText.textContent = STAGE_LABELS[stage] || 'Turning your story into a cinematic video…';

  const activeIndex = STAGE_ORDER.indexOf(stage);

  STAGE_ORDER.forEach((s, i) => {
    const el = $(`ps-${s}`);
    if (!el) return;
    const done = activeIndex > i;
    el.classList.toggle('active', s === stage);
    el.classList.toggle('done', done);
  });

  // Only chase the active row when the stage actually changes. This ran on every
  // 1.5 s tick, so smooth-scrolling fought the user for the scroll position
  // continuously for the whole render.
  if (stage && stage !== lastStage) {
    lastStage = stage;
    const el = $(`ps-${stage}`) || $('ps-preparing_story');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   STEP 6 — Result
   ═══════════════════════════════════════════════════════════════════════════ */
function initResultStep() {
  $('btnCreateAnother').addEventListener('click', () => {
    stopPolling();
    lastStage = null;
    state.jobId = null;
    state.outputUrl = null;
    state.downloadUrl = null;
    state.story = '';

    const ta = $('storyInput');
    if (ta) ta.value = '';
    if (state.storyStep) state.storyStep.updateCharCount();

    clearGameplaySelection();

    // Release the decoder and the network connection to the rendered file rather
    // than leaving a paused <video> pinned to the signed URL in the DOM.
    const video = $('resultVideo');
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    $('btnDownload').onclick = null;

    goTo('story');
  });
}

function showResult(jobId) {
  const videoUrl = state.outputUrl || apiUrl(`/api/videos/${jobId}/output`);
  const downloadUrl = state.downloadUrl || `${videoUrl}${videoUrl.includes('?') ? '&' : '?'}download=true`;

  const video = $('resultVideo');
  video.src = videoUrl;
  video.load();

  $('btnDownload').onclick = () => {
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = `storyplay_${jobId}.mp4`;
    // Firefox needs the anchor in the document to fire the download.
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  $('resultMeta').textContent = `Job ID: ${jobId} · 720×1280 · H.264/AAC`;

  goTo('result');
  toast('Your Short is ready!', 'success');
}

/* ═══════════════════════════════════════════════════════════════════════════
   Navigation
   ═══════════════════════════════════════════════════════════════════════════ */
// progress and result are outcomes of step 4 rather than choices, so both map to
// the last dot. Without this they fell off the end of the list, every dot ended up
// un-highlighted, and the header looked broken on the two screens users see most.
const DOT_FOR_STEP = { story: 0, gameplay: 1, captions: 2, voice: 3, progress: 3, result: 3 };

function goTo(stepName) {
  document.querySelectorAll('.step').forEach((s) => {
    s.classList.remove('step--active');
    s.hidden = true;
  });

  const target = $(`step-${stepName}`);
  if (target) {
    target.hidden = false;
    requestAnimationFrame(() => target.classList.add('step--active'));
  }

  state.step = stepName;

  const currentIdx = DOT_FOR_STEP[stepName] ?? 0;
  document.querySelectorAll('.step-dot').forEach((dot, i) => {
    const on = i === currentIdx;
    dot.classList.toggle('active', on);
    dot.classList.toggle('done', !on && i < currentIdx);
    if (on) dot.setAttribute('aria-current', 'step');
    else dot.removeAttribute('aria-current');
  });

  if (stepName === 'gameplay') loadGameplay();

  // Move focus to the new step so keyboard and screen-reader users are not left
  // on a control that just became invisible.
  const heading = target && target.querySelector('.step-title');
  if (heading) {
    heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ═══════════════════════════════════════════════════════════════════════════
   Toast notifications
   ═══════════════════════════════════════════════════════════════════════════ */
let toastTimer;
function toast(msg, type = '') {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast visible' + (type ? ` toast--${type}` : '');
  // Errors stay up twice as long — they carry an instruction the user has to read.
  const ttl = type === 'error' ? 7000 : 4000;

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('visible');
  }, ttl);
}

/* Never leave a poll running behind a page the user has navigated away from. */
window.addEventListener('pagehide', stopPolling);

'use strict';
/* ════════════════════════════════════════════════════════════════════════════
   StoryPlay — Frontend App Logic
   Vanilla JS · No frameworks · Polls /api/videos/:jobId for status
   ════════════════════════════════════════════════════════════════════════════ */

/* ── State ───────────────────────────────────────────────────────────────── */
const state = {
  step:       'story',
  story:      '',
  gameplayId: null,
  captionStyle: 'bold-yellow',
  captionColor: '#ffffff',
  voice:      'default',
  duration:   45,
  jobId:      null,
  pollTimer:  null,
};

// Backend URL: empty = same origin (local dev)
// Set window.__API_BASE__ in app.html for Vercel → Railway cross-origin deployment
const API_BASE = (window.__API_BASE__ || '').replace(/\/$/, '');

const GAMEPLAY_EMOJIS = {
  minecraft:        '🧊',
  roblox:           '⬜',
  gtav:             '🎮',
  'subway-surfers': '🏃',
  fortnite:         '🇫',
  'geometry-dash':  '🔺',
};

const GAMEPLAY_IMAGES = {
  'minecraft': 'c4a88e00-77b4-44cb-897f-7be0e2ebcedd.png',
  'roblox': 'd714ab01-aa65-4ff2-9011-85014b3535b7.png',
  'gtav': '5bb6cefa-1149-459f-8fa3-029475806cd3.png',
  'subway-surfers': 'c4a88e00-77b4-44cb-897f-7be0e2ebcedd.png',
  'fortnite': '4c892349-45ea-495d-ac04-f977280ebc4e.png',
  'geometry-dash': 'd714ab01-aa65-4ff2-9011-85014b3535b7.png'
};

/* ── DOM refs ────────────────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);

/* ── Init ────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  initStoryStep();
  initGameplayStep();
  initCaptionsStep();
  initVoiceStep();
  initResultStep();
});

/* ═══════════════════════════════════════════════════════════════════════════
   STEP 1 — Story
   ═══════════════════════════════════════════════════════════════════════════ */
function initStoryStep() {
  const textarea  = $('storyInput');
  const charCount = $('charCount');
  const charMin   = $('charMin');
  const btn       = $('btnStoryNext');
  const btnAi     = $('btnAiGenerate');
  const aiDuration = $('aiDuration');

  // Custom Dropdown Logic
  const wrapper = $('aiDurationWrapper');
  const trigger = $('aiDurationTrigger');
  const options = document.querySelectorAll('.custom-select__option');
  const label = $('aiDurationLabel');

  if (wrapper && trigger) {
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      wrapper.classList.toggle('open');
    });

    options.forEach(opt => {
      opt.addEventListener('click', () => {
        options.forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        label.textContent = opt.textContent;
        if(aiDuration) aiDuration.value = opt.dataset.value;
        wrapper.classList.remove('open');
      });
    });

    document.addEventListener('click', () => {
      wrapper.classList.remove('open');
    });
  }

  if (btnAi && aiDuration) {
    btnAi.addEventListener('click', async () => {
      const originalText = btnAi.textContent;
      btnAi.textContent = '✨ Generating...';
      btnAi.disabled = true;

      try {
        const dur = parseInt(aiDuration.value);
        // Average speaking rate: 150 words per minute -> 2.5 words per sec.
        // For 30s -> ~75 words, 45s -> ~112 words, 60s -> ~150 words.
        const wordCount = Math.floor(dur * 2.5);

        const res = await fetch('/api/videos/generate-story', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ duration: dur })
        });

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'API request failed');
        }

        const data = await res.json();
        let generatedStory = data.story;
        generatedStory = generatedStory.replace(/^"|"$/g, ''); // strip quotes
        
        textarea.value = generatedStory;
        textarea.dispatchEvent(new Event('input')); // trigger char count update
      } catch (err) {
        console.error(err);
        toast('Failed to generate AI story.', 'error');
      } finally {
        btnAi.textContent = originalText;
        btnAi.disabled = false;
      }
    });
  }

  textarea.addEventListener('input', () => {
    const len = textarea.value.length;
    charCount.textContent = len;

    charCount.classList.toggle('warn',  len > 2700);
    charCount.classList.toggle('error', len > 3000);
    charMin.style.opacity = len >= 50 ? '0' : '1';
  });

  btn.addEventListener('click', () => {
    const text = textarea.value.trim();
    if (text.length < 50)   return toast('Story must be at least 50 characters.', 'error');
    if (text.length > 3000) return toast('Story exceeds 3000 characters.', 'error');
    state.story = text;
    goTo('gameplay');
  });
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

async function loadGameplay() {
  const grid = $('gameplayGrid');
  grid.innerHTML = '<div class="gameplay-loading">Loading…</div>';

  let items;
  try {
    const res  = await fetch('/api/gameplay');
    const json = await res.json();
    items = json.gameplay;
  } catch (err) {
    grid.innerHTML = '<div class="gameplay-loading" style="color:#ef476f">Failed to load gameplay options.</div>';
    return;
  }

  grid.innerHTML = '';
  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'gameplay-card' + (item.available ? '' : ' gameplay-card--unavailable');
    card.dataset.id = item.id;
    card.innerHTML = `
      <img src="${GAMEPLAY_IMAGES[item.id] || 'bg-minecraft.png'}" alt="${item.name}" class="gameplay-card__bg">
      <div class="gameplay-card__overlay"></div>
      <div class="gameplay-card__status ${item.available ? 'gameplay-card__status--ok' : 'gameplay-card__status--missing'}">
        ${item.available 
          ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg> Ready' 
          : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> File missing'}
      </div>
      <div class="gameplay-card__info">
        <div class="gameplay-card__icon">${GAMEPLAY_EMOJIS[item.id] || '🎮'}</div>
        <div class="gameplay-card__name">${item.name}</div>
      </div>
    `;

    card.addEventListener('click', () => {
      document.querySelectorAll('.gameplay-card--selected').forEach((c) =>
        c.classList.remove('gameplay-card--selected')
      );
      card.classList.add('gameplay-card--selected');
      state.gameplayId = item.id;
      $('btnGameplayNext').disabled = false;
    });

    grid.appendChild(card);
  }
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

  $('btnGenerate').addEventListener('click', async () => {
    const voiceChecked    = document.querySelector('input[name="voice"]:checked');
    const durationChecked = document.querySelector('input[name="duration"]:checked');

    state.voice    = voiceChecked    ? voiceChecked.value    : 'default';
    state.duration = durationChecked ? parseInt(durationChecked.value) : 45;

    await submitJob();
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   STEP 5 — Progress polling
   ═══════════════════════════════════════════════════════════════════════════ */
async function submitJob() {
  try {
    const res = await fetch(`${API_BASE}/api/videos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        story:        state.story,
        gameplayId:   state.gameplayId,
        captionStyle: state.captionStyle,
        captionColor: state.captionColor,
        voice:        state.voice,
        duration:     state.duration,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      return toast(err.error || 'Failed to create job', 'error');
    }

    const { jobId } = await res.json();
    state.jobId = jobId;
    goTo('progress');
    startPolling(jobId);
  } catch (err) {
    toast('Network error: ' + err.message, 'error');
  }
}

const STAGE_LABELS = {
  preparing_story:   'Preparing story…',
  generating_voice:  'Generating voice narration…',
  transcribing:      'Transcribing audio with Whisper…',
  creating_subtitles:'Creating ASS subtitles…',
  selecting_gameplay:'Selecting gameplay segment…',
  trimming_gameplay: 'Trimming gameplay (efficient seek)…',
  compositing:       'Compositing video…',
  encoding:          'Encoding H.264/AAC…',
  finalizing:        'Finalizing…',
};

const STAGE_ORDER = Object.keys(STAGE_LABELS);

function startPolling(jobId) {
  clearInterval(state.pollTimer);
  updateProgress(0, null);

  state.pollTimer = setInterval(async () => {
    try {
      const res  = await fetch(`${API_BASE}/api/videos/${jobId}`);
      const data = await res.json();

      if (!res.ok) {
        clearInterval(state.pollTimer);
        return toast(data.error || 'Job error', 'error');
      }

      updateProgress(data.progress || 0, data.stage);

      if (data.status === 'completed') {
        clearInterval(state.pollTimer);
        showResult(jobId);
      } else if (data.status === 'failed') {
        clearInterval(state.pollTimer);
        toast(`Render failed: ${data.error || 'Unknown error'}`, 'error');
        goTo('voice');
      }
    } catch (_) {}
  }, 1500);
}

function updateProgress(pct, stage) {
  // Ring
  const circumference = 339;
  const offset = circumference - (pct / 100) * circumference;
  const ring = $('progressRing');
  if (ring) ring.style.strokeDashoffset = offset;

  $('progressPct').textContent = `${Math.round(pct)}%`;

  // Pipeline steps
  STAGE_ORDER.forEach((s, i) => {
    const el = $(`ps-${s}`);
    if (!el) return;
    if (s === stage) {
      el.classList.add('active');
      el.classList.remove('done');
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else if (STAGE_ORDER.indexOf(stage) > i) {
      el.classList.remove('active');
      el.classList.add('done');
    } else {
      el.classList.remove('active', 'done');
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   STEP 6 — Result
   ═══════════════════════════════════════════════════════════════════════════ */
function initResultStep() {
  $('btnCreateAnother').addEventListener('click', () => {
    state.jobId = null;
    $('storyInput').value = '';
    $('charCount').textContent = '0';
    document.querySelectorAll('.gameplay-card--selected').forEach((c) =>
      c.classList.remove('gameplay-card--selected')
    );
    state.gameplayId = null;
    $('btnGameplayNext').disabled = true;
    goTo('story');
  });
}

function showResult(jobId) {
  const videoUrl = `${API_BASE}/api/videos/${jobId}/output`;

  const video = $('resultVideo');
  video.src = videoUrl;
  video.load();

  $('btnDownload').onclick = () => {
    const a = document.createElement('a');
    a.href = videoUrl + '?download=true';
    a.download = `storyplay_${jobId}.mp4`;
    a.click();
  };

  $('resultMeta').textContent = `Job ID: ${jobId} · 720×1280 · H.264/AAC`;

  goTo('result');
  toast('Your Short is ready! 🎉', 'success');
}

/* ═══════════════════════════════════════════════════════════════════════════
   Navigation
   ═══════════════════════════════════════════════════════════════════════════ */
function goTo(stepName) {
  // Hide all
  document.querySelectorAll('.step').forEach((s) => {
    s.classList.remove('step--active');
    s.style.display = 'none';
  });

  // Show target
  const target = $(`step-${stepName}`);
  if (target) {
    target.style.display = '';
    // Trigger animation next frame
    requestAnimationFrame(() => target.classList.add('step--active'));
  }

  state.step = stepName;

  // Update step indicator dots
  const stepOrder = ['story', 'gameplay', 'captions', 'voice', 'progress', 'result'];
  const currentIdx = stepOrder.indexOf(stepName);
  document.querySelectorAll('.step-dot').forEach((dot, i) => {
    dot.classList.remove('active', 'done');
    if (i < currentIdx) dot.classList.add('done');
    else if (i === currentIdx) dot.classList.add('active');
  });

  // Load gameplay list when entering that step
  if (stepName === 'gameplay') loadGameplay();

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ═══════════════════════════════════════════════════════════════════════════
   Toast notifications
   ═══════════════════════════════════════════════════════════════════════════ */
let toastTimer;
function toast(msg, type = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast visible' + (type ? ` toast--${type}` : '');

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('toast--show');
  }, 4000);
}

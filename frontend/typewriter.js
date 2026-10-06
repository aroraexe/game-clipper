'use strict';
/* ════════════════════════════════════════════════════════════════════════════
   Typewriter — types a word, holds, then deletes it and moves to the next
   Usage:  <span class="typewriter" data-words='["one","two"]'></span>
           <span class="typewriter-caret"></span>
   ════════════════════════════════════════════════════════════════════════════ */

class Typewriter {
  constructor(el, opts = {}) {
    this.el = el;
    this.words = this.readWords(el);
    this.typeSpeed = opts.typeSpeed ?? 85;   // ms per character typed
    this.deleteSpeed = opts.deleteSpeed ?? 45;
    this.holdMs = opts.holdMs ?? 1900;       // pause on the completed word
    this.gapMs = opts.gapMs ?? 400;          // pause on the empty string
    this.startDelay = opts.startDelay ?? 250;

    this.wordIndex = 0;
    this.charCount = 0;
    this.deleting = false;
    this.timer = null;
    this.running = false;
    this.paused = false;
  }

  readWords(el) {
    const raw = el.dataset.words;
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(w => typeof w === 'string') : [];
    } catch {
      return [];
    }
  }

  start() {
    if (this.running || this.words.length === 0) return;

    // Respect reduced-motion: show the first word, skip the animation.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.el.textContent = this.words[0];
      return;
    }

    this.running = true;
    this.watchVisibility();
    this.timer = setTimeout(() => this.tick(), this.startDelay);
  }

  /* Type one character, or delete one — then schedule the next move. */
  tick() {
    if (this.paused) return;

    const word = this.words[this.wordIndex];

    if (!this.deleting) {
      this.charCount++;
      this.el.textContent = word.slice(0, this.charCount);
      if (this.charCount === word.length) {
        this.deleting = true;
        return void (this.timer = setTimeout(() => this.tick(), this.holdMs));
      }
      return void (this.timer = setTimeout(() => this.tick(), this.typeSpeed));
    }

    this.charCount--;
    this.el.textContent = word.slice(0, this.charCount);
    if (this.charCount === 0) {
      this.deleting = false;
      this.wordIndex = (this.wordIndex + 1) % this.words.length;
      return void (this.timer = setTimeout(() => this.tick(), this.gapMs));
    }
    this.timer = setTimeout(() => this.tick(), this.deleteSpeed);
  }

  /* Freeze the timer while the tab is hidden or the element is off-screen. */
  watchVisibility() {
    document.addEventListener('visibilitychange', () => {
      this.paused = document.hidden;
      if (!this.paused && this.running) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.tick(), 300);
      }
    });

    if (!('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver(([entry]) => {
      this.paused = !entry.isIntersecting || document.hidden;
      if (!this.paused && this.running) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.tick(), 300);
      }
    }, { threshold: 0.1 });
    io.observe(this.el);
  }

  destroy() {
    this.running = false;
    clearTimeout(this.timer);
  }
}

document.querySelectorAll('.typewriter').forEach(el => new Typewriter(el).start());
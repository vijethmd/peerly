// Emoji reactions: a tray above the controls and floating animations, with a
// celebration burst when several people react together.

import { $, h } from './ui.js';

const MAX_FLOATS = 45;
const STORM_WINDOW_MS = 3000;
const STORM_COOLDOWN_MS = 8000;
const SEND_COOLDOWN_MS = 250;

export class Reactions {
  constructor({ call, stage }) {
    this.call = call;
    this.stage = stage;
    this.layer = $('#reactionLayer');
    this.tray = $('#reactionTray');
    this.button = $('#reactBtn');
    this.recent = [];
    this.lastStormAt = 0;
    this.lastSentAt = 0;
    this.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  init() {
    const emojis = this.call.features.reactions || ['💖', '👍', '🎉', '👏', '😂', '😮', '😢', '🤔', '👎', '🔥'];
    for (const emoji of emojis) {
      this.tray.append(
        h('button', {
          class: 'reaction-btn',
          type: 'button',
          text: emoji,
          'aria-label': `Send ${emoji}`,
          onClick: () => this.send(emoji)
        })
      );
    }

    this.button.addEventListener('click', () => this.toggleTray());
    document.addEventListener('pointerdown', (event) => {
      if (this.tray.hidden) return;
      if (!this.tray.contains(event.target) && !this.button.contains(event.target)) this.toggleTray(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.tray.hidden) this.toggleTray(false);
    });

    this.call.on('reaction', (payload) => this.receive(payload));
  }

  toggleTray(force) {
    const show = force === undefined ? this.tray.hidden : force;
    this.tray.hidden = !show;
    this.button.setAttribute('aria-expanded', String(show));
    this.button.classList.toggle('active', show);
    if (show) this.tray.querySelector('button')?.focus();
  }

  send(emoji) {
    const now = Date.now();
    if (now - this.lastSentAt < SEND_COOLDOWN_MS) return;
    this.lastSentAt = now;
    this.call.sendReaction(emoji);
    this.receive({ pid: this.call.self.pid, name: this.call.name, emoji, ts: now, isSelf: true });
  }

  receive({ pid, name, emoji, isSelf = false }) {
    this.spawn(emoji, isSelf ? 'You' : name);
    this.stage.flashReaction(pid, emoji);
    this.trackStorm(pid, emoji);
  }

  spawn(emoji, label, { delay = 0, scale = 1 } = {}) {
    while (this.layer.childElementCount > MAX_FLOATS) this.layer.firstElementChild.remove();
    const float = h(
      'div',
      { class: `reaction-float${this.reduceMotion ? ' reduced' : ''}` },
      h('span', { class: 'reaction-emoji', text: emoji }),
      label ? h('span', { class: 'reaction-name', text: label }) : null
    );
    float.style.setProperty('--x', `${4 + Math.random() * 28}%`);
    float.style.setProperty('--drift', `${(Math.random() * 70 - 35).toFixed(1)}px`);
    float.style.setProperty('--dur', `${(3.2 + Math.random() * 1.3).toFixed(2)}s`);
    float.style.setProperty('--rot', `${(Math.random() * 26 - 13).toFixed(1)}deg`);
    float.style.setProperty('--delay', `${delay}ms`);
    float.style.setProperty('--scale', String(scale));
    this.layer.append(float);
    float.addEventListener('animationend', () => float.remove());
    setTimeout(() => float.remove(), 7000 + delay);
  }

  /** When at least three people send the same reaction at once, celebrate. */
  trackStorm(pid, emoji) {
    const now = Date.now();
    this.recent = this.recent.filter((entry) => now - entry.ts < STORM_WINDOW_MS);
    this.recent.push({ pid, emoji, ts: now });
    if (now - this.lastStormAt < STORM_COOLDOWN_MS) return;
    const senders = new Set(this.recent.filter((entry) => entry.emoji === emoji).map((entry) => entry.pid));
    if (senders.size < 3) return;
    this.lastStormAt = now;
    if (this.reduceMotion) return;
    for (let i = 0; i < 16; i++) {
      this.spawn(emoji, null, { delay: i * 70, scale: 0.7 + Math.random() * 0.8 });
    }
  }
}

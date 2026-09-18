// Audio level analysis: active-speaker highlighting, speaking time for the
// meeting report, and the "you're muted" nudge.

import { Emitter } from './ui.js';

const SPEAKING_ON = 0.035;
const SPEAKING_OFF = 0.02;
const RELEASE_MS = 700;

export class AudioMonitor extends Emitter {
  constructor() {
    super();
    this.ctx = null;
    this.entries = new Map(); // id -> { source, analyser, data, ownedTrack, level, speaking, lastLoudAt }
    this.timer = setInterval(() => this.tick(), 100);
  }

  ensureContext() {
    if (!this.ctx) {
      try {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      } catch {
        return null;
      }
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  watch(id, track, { clone = false } = {}) {
    this.unwatch(id);
    const ctx = this.ensureContext();
    if (!ctx || !track || track.readyState !== 'live') return;
    try {
      // The local mic is analysed through a clone so levels keep working
      // while muted (the sent track is disabled, the clone is not).
      const analysed = clone ? track.clone() : track;
      if (clone) analysed.enabled = true;
      const source = ctx.createMediaStreamSource(new MediaStream([analysed]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.2;
      source.connect(analyser);
      this.entries.set(id, {
        source,
        analyser,
        data: new Float32Array(analyser.fftSize),
        ownedTrack: clone ? analysed : null,
        level: 0,
        speaking: false,
        lastLoudAt: 0
      });
    } catch (err) {
      console.warn('Peerly: audio analysis unavailable', err);
    }
  }

  unwatch(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    try {
      entry.source.disconnect();
    } catch {
      /* ignore */
    }
    entry.ownedTrack?.stop();
    this.entries.delete(id);
    if (entry.speaking) this.emit('speaking', { id, speaking: false, level: 0 });
  }

  levelOf(id) {
    return this.entries.get(id)?.level || 0;
  }

  tick() {
    if (!this.entries.size) return;
    const now = performance.now();
    const levels = [];
    for (const [id, entry] of this.entries) {
      entry.analyser.getFloatTimeDomainData(entry.data);
      let sum = 0;
      for (let i = 0; i < entry.data.length; i++) sum += entry.data[i] * entry.data[i];
      const rms = Math.sqrt(sum / entry.data.length);
      entry.level = entry.level * 0.5 + rms * 0.5;
      levels.push([id, entry.level]);

      if (entry.level > SPEAKING_ON) {
        entry.lastLoudAt = now;
        if (!entry.speaking) {
          entry.speaking = true;
          this.emit('speaking', { id, speaking: true, level: entry.level });
        }
      } else if (entry.speaking && entry.level < SPEAKING_OFF && now - entry.lastLoudAt > RELEASE_MS) {
        entry.speaking = false;
        this.emit('speaking', { id, speaking: false, level: entry.level });
      }
    }
    this.emit('levels', levels);
  }

  destroy() {
    clearInterval(this.timer);
    for (const id of [...this.entries.keys()]) this.unwatch(id);
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}

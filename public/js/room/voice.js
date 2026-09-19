// Cuts one person's microphone into speech clips for server-side
// transcription (Whisper). Voice activity detection runs on 20 ms frames, a
// short pre-roll keeps first syllables, and utterances are batched into clips
// of a few seconds, since Groq's free tier allows 20 requests a minute.
// Clips are 16 kHz mono 16-bit PCM, which is what Whisper wants.

const RATE = 16000;
const FRAME = 320; // 20 ms
const PRE_ROLL_FRAMES = 15; // 300 ms kept from before speech starts
const START_FRAMES = 3; // 60 ms of voice starts an utterance
const END_SILENCE_FRAMES = 35; // 700 ms of quiet ends it
const KEEP_TAIL_FRAMES = 10; // 200 ms of that quiet stays in the clip
const MIN_VOICED_FRAMES = 15; // shorter than 300 ms of voice: a cough, a click
const MAX_UTTERANCE_FRAMES = 750; // 15 s
const GAP_SAMPLES = 4000; // 250 ms of silence between utterances in a clip
const FLUSH_SPEECH_MS = 4000; // send once a clip holds this much speech,
const FLUSH_WAIT_MS = 3500; // or this long after its first utterance ended,
const MAX_CLIP_MS = 20000; // and never longer than this

export const clipperSupported =
  typeof window !== 'undefined' && typeof window.AudioWorkletNode === 'function' && typeof window.AudioContext === 'function';

export class VoiceClipper {
  constructor({ onClip }) {
    this.onClip = onClip;
    this.track = null;
    this.ctx = null;
    this.generation = 0;
    this.flushTimer = null;
    this.reset();
  }

  get running() {
    return Boolean(this.ctx);
  }

  reset() {
    this.carry = new Float32Array(0);
    this.pos = 0;
    this.frame = new Float32Array(FRAME);
    this.frameFill = 0;
    this.preRoll = [];
    this.voicedRun = 0;
    this.utterance = null;
    this.batch = [];
    this.batchSamples = 0;
    this.batchVoicedMs = 0;
    this.batchStartedAt = 0;
    this.batchFirstEndAt = 0;
    this.noiseFloor = 0.004;
  }

  async update({ shouldRun, track }) {
    if (!shouldRun || !track) {
      this.stop();
      return;
    }
    if (this.ctx && this.track === track) return;
    this.stop();
    const generation = ++this.generation;
    this.track = track;
    let ctx = null;
    try {
      ctx = new AudioContext();
      await ctx.audioWorklet.addModule('/js/room/pcm-tap.js');
      if (generation !== this.generation) {
        ctx.close().catch(() => {});
        return;
      }
      const source = ctx.createMediaStreamSource(new MediaStream([track]));
      const tap = new AudioWorkletNode(ctx, 'pcm-tap');
      // Connected to a silent output so the browser keeps the graph running.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      source.connect(tap).connect(mute).connect(ctx.destination);
      this.inputRate = ctx.sampleRate;
      tap.port.onmessage = (event) => this.feed(event.data);
      this.ctx = ctx;
      this.resumeWhenAllowed(ctx);
      this.flushTimer = setInterval(() => this.maybeFlush(), 1000);
    } catch (err) {
      ctx?.close().catch(() => {});
      this.ctx = null;
      console.warn('[peerly] speech clips unavailable', err);
    }
  }

  // Audio can't start before the page has been clicked; joining counts, but a
  // reload that rejoins on its own doesn't, so resume on the next click.
  resumeWhenAllowed(ctx) {
    if (ctx.state === 'running') return;
    ctx.resume().catch(() => {});
    const resume = () => {
      ctx.resume().catch(() => {});
      if (ctx.state === 'running' || ctx.state === 'closed') {
        document.removeEventListener('pointerdown', resume, true);
        document.removeEventListener('keydown', resume, true);
      }
    };
    document.addEventListener('pointerdown', resume, true);
    document.addEventListener('keydown', resume, true);
  }

  stop() {
    this.generation += 1;
    clearInterval(this.flushTimer);
    this.flushTimer = null;
    if (this.utterance) this.endUtterance();
    this.maybeFlush(true);
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.track = null;
    this.reset();
  }

  // ----------------------------------------------------------- resampling
  // Box-filtered decimation to 16 kHz: averaging the input samples each
  // output sample covers keeps higher frequencies from folding into speech.
  feed(input) {
    const ratio = this.inputRate / RATE;
    const src = new Float32Array(this.carry.length + input.length);
    src.set(this.carry);
    src.set(input, this.carry.length);
    const half = ratio / 2;
    let pos = this.pos;
    while (pos + half < src.length) {
      const from = Math.max(0, Math.floor(pos - half));
      const to = Math.min(src.length, Math.ceil(pos + half));
      let sum = 0;
      for (let i = from; i < to; i++) sum += src[i];
      this.pushSample(sum / Math.max(1, to - from));
      pos += ratio;
    }
    const keepFrom = Math.max(0, Math.floor(pos - half) - 1);
    this.carry = src.slice(keepFrom);
    this.pos = pos - keepFrom;
  }

  pushSample(value) {
    this.frame[this.frameFill++] = value;
    if (this.frameFill === FRAME) {
      this.onFrame(this.frame);
      this.frame = new Float32Array(FRAME);
      this.frameFill = 0;
    }
  }

  // ---------------------------------------------------- voice detection
  onFrame(frame) {
    let sum = 0;
    for (let i = 0; i < FRAME; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / FRAME);
    const voiced = rms > Math.max(0.012, this.noiseFloor * 3);
    if (!voiced) this.noiseFloor = Math.min(0.05, Math.max(0.002, this.noiseFloor * 0.97 + rms * 0.03));

    if (!this.utterance) {
      this.preRoll.push(frame);
      if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift();
      this.voicedRun = voiced ? this.voicedRun + 1 : 0;
      if (this.voicedRun >= START_FRAMES) {
        this.utterance = {
          frames: this.preRoll,
          voiced: this.voicedRun,
          silence: 0,
          startedAt: Date.now() - this.preRoll.length * 20
        };
        this.preRoll = [];
      }
      return;
    }

    const utterance = this.utterance;
    utterance.frames.push(frame);
    if (voiced) {
      utterance.voiced += 1;
      utterance.silence = 0;
    } else {
      utterance.silence += 1;
    }
    if (utterance.silence >= END_SILENCE_FRAMES || utterance.frames.length >= MAX_UTTERANCE_FRAMES) this.endUtterance();
  }

  endUtterance() {
    const utterance = this.utterance;
    this.utterance = null;
    this.voicedRun = 0;
    if (!utterance || utterance.voiced < MIN_VOICED_FRAMES) return;
    const frames = utterance.frames.slice(0, utterance.frames.length - Math.max(0, utterance.silence - KEEP_TAIL_FRAMES));
    const pcm = new Int16Array(frames.length * FRAME);
    frames.forEach((f, i) => {
      for (let j = 0; j < FRAME; j++) pcm[i * FRAME + j] = Math.max(-32768, Math.min(32767, Math.round(f[j] * 32767)));
    });
    if (this.batch.length) {
      this.batch.push(new Int16Array(GAP_SAMPLES));
      this.batchSamples += GAP_SAMPLES;
    } else {
      this.batchStartedAt = utterance.startedAt;
      this.batchFirstEndAt = Date.now();
    }
    this.batch.push(pcm);
    this.batchSamples += pcm.length;
    this.batchVoicedMs += utterance.voiced * 20;
    this.maybeFlush();
  }

  // --------------------------------------------------------------- clips
  maybeFlush(force = false) {
    if (!this.batch.length) return;
    const ms = this.batchSamples / (RATE / 1000);
    const waited = Date.now() - this.batchFirstEndAt;
    // Hold the clip while someone is mid-sentence, unless it's getting long.
    if (!force && this.utterance && ms < MAX_CLIP_MS) return;
    if (force || this.batchVoicedMs >= FLUSH_SPEECH_MS || ms >= MAX_CLIP_MS || waited >= FLUSH_WAIT_MS) this.flush();
  }

  flush() {
    const pcm = new Int16Array(this.batchSamples);
    let offset = 0;
    for (const part of this.batch) {
      pcm.set(part, offset);
      offset += part.length;
    }
    const ageMs = Date.now() - this.batchStartedAt;
    this.batch = [];
    this.batchSamples = 0;
    this.batchVoicedMs = 0;
    this.batchStartedAt = 0;
    this.batchFirstEndAt = 0;
    this.onClip({ pcm, ageMs, durationMs: pcm.length / (RATE / 1000) });
  }
}

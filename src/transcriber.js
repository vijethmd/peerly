'use strict';

// Server-side speech-to-text with Groq's Whisper API. Each browser sends
// short clips of its own speech (16 kHz mono 16-bit PCM, cut at pauses), so
// every participant is transcribed whatever browser or phone they use.
// Clips are queued under the free tier's 20 requests a minute; clips from the
// same person are merged when the queue backs up, and Whisper's habit of
// inventing "Thank you." on silence is filtered out.

const SAMPLE_RATE = 16000;
const MAX_MERGED_MS = 30000;
const MERGE_GAP_MS = 250;
const MAX_QUEUE = 80;

// Whisper's well-known inventions on near-silent audio.
const HALLUCINATIONS = new Set([
  'thank you',
  'thank you so much',
  'thanks for watching',
  'thank you for watching',
  'thanks for listening',
  'please subscribe',
  'subscribe',
  'you',
  'bye',
  'music',
  'applause',
  'silence',
  'subtitles by the amaraorg community'
]);

/** A 44-byte WAV header in front of 16-bit little-endian PCM. */
function wavFromPcm(pcm, sampleRate = SAMPLE_RATE) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const pcmDurationMs = (pcm) => Math.round((pcm.length / 2 / SAMPLE_RATE) * 1000);

/** Keeps what Whisper actually heard: drops no-speech segments and stock inventions. */
function cleanTranscription(data, durationMs) {
  let text;
  if (Array.isArray(data?.segments)) {
    text = data.segments
      .filter((s) => !(s.no_speech_prob > 0.9) && !(s.no_speech_prob > 0.6 && s.avg_logprob < -1))
      .map((s) => s.text || '')
      .join(' ');
  } else {
    text = typeof data?.text === 'string' ? data.text : '';
  }
  text = text.replace(/\s+/g, ' ').trim();
  const bare = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!bare) return '';
  if (durationMs < 4000 && HALLUCINATIONS.has(bare)) return '';
  return text;
}

class Transcriber {
  constructor({ config, logger, metrics, fetchImpl = globalThis.fetch }) {
    this.enabled = Boolean(config.enabled);
    this.baseUrl = String(config.baseUrl || '').replace(/\/+$/, '');
    this.apiKey = config.apiKey || null;
    this.model = config.model;
    this.perMinute = config.maxPerMinute || 18;
    this.timeoutMs = config.timeoutMs || 30000;
    this.concurrency = 2;
    this.fetch = fetchImpl;
    this.log = logger.child({ component: 'transcriber' });
    this.metrics = metrics;
    this.queue = [];
    this.active = 0;
    this.sentAt = [];
    this.timer = null;
    this.pausedUntil = 0;
  }

  /**
   * Queues a clip; resolves with { ok, text } once transcribed. `key`
   * identifies the speaker so their queued clips can be merged.
   */
  submit({ key, pcm, language = null, prompt = null }) {
    if (!this.enabled) return Promise.resolve({ ok: false, code: 'off', error: 'Server transcription isn’t set up.' });
    if (this.queue.length >= MAX_QUEUE) {
      this.metrics.inc('peerly_transcribe_total', { outcome: 'queue-full' });
      return Promise.resolve({ ok: false, code: 'busy', retryable: true, error: 'Transcription is busy right now.' });
    }
    return new Promise((resolve) => {
      this.queue.push({ key, pcm, language, prompt, resolve, attempts: 0, queuedAt: Date.now() });
      this.pump();
    });
  }

  slotFree(now) {
    this.sentAt = this.sentAt.filter((t) => now - t < 60000);
    return this.sentAt.length < this.perMinute && now >= this.pausedUntil;
  }

  pump() {
    clearTimeout(this.timer);
    this.timer = null;
    const now = Date.now();
    while (this.active < this.concurrency && this.queue.length && this.slotFree(now)) {
      this.sentAt.push(now);
      this.run(this.take());
    }
    if (this.queue.length && !this.timer) {
      const waitForSlot = this.sentAt.length >= this.perMinute ? 60000 - (now - this.sentAt[0]) : 0;
      const wait = Math.max(waitForSlot, this.pausedUntil - now, 250);
      this.timer = setTimeout(() => this.pump(), wait);
      this.timer.unref?.();
    }
  }

  // Next clip, plus any later queued clips from the same speaker (while
  // they fit), so a backlog costs fewer requests.
  take() {
    const job = this.queue.shift();
    const merged = [job];
    let ms = pcmDurationMs(job.pcm);
    for (let i = 0; i < this.queue.length && ms < MAX_MERGED_MS; ) {
      const next = this.queue[i];
      const nextMs = pcmDurationMs(next.pcm);
      if (next.key === job.key && ms + MERGE_GAP_MS + nextMs <= MAX_MERGED_MS) {
        merged.push(next);
        this.queue.splice(i, 1);
        ms += MERGE_GAP_MS + nextMs;
      } else {
        i += 1;
      }
    }
    if (merged.length === 1) return job;
    const gap = Buffer.alloc(Math.round((MERGE_GAP_MS / 1000) * SAMPLE_RATE) * 2);
    const pcm = Buffer.concat(merged.flatMap((j, i) => (i ? [gap, j.pcm] : [j.pcm])));
    return {
      ...job,
      pcm,
      resolve: (result) => {
        job.resolve(result);
        for (const other of merged.slice(1)) other.resolve({ ok: true, text: '', merged: true });
      }
    };
  }

  async run(job) {
    this.active += 1;
    const started = Date.now();
    const durationMs = pcmDurationMs(job.pcm);
    let result;
    try {
      const form = new FormData();
      form.append('file', new Blob([wavFromPcm(job.pcm)], { type: 'audio/wav' }), 'speech.wav');
      form.append('model', this.model);
      form.append('response_format', 'verbose_json');
      form.append('temperature', '0');
      if (job.language) form.append('language', job.language);
      if (job.prompt) form.append('prompt', job.prompt);
      const response = await this.fetch(`${this.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {},
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      const body = await response.text();
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 2000;
        if (job.attempts < 2 && waitMs <= 60000) {
          // Put it back at the front and pause the queue for the wait.
          job.attempts += 1;
          this.pausedUntil = Math.max(this.pausedUntil, Date.now() + waitMs);
          this.queue.unshift(job);
          this.metrics.inc('peerly_transcribe_total', { outcome: 'retry' });
          this.log.warn('transcription retry', { status: response.status, waitMs });
          return;
        }
        result = { ok: false, code: response.status === 429 ? 'rate-limited' : 'unavailable', retryable: true, error: 'Transcription is busy right now.' };
      } else if (!response.ok) {
        const code = response.status === 401 || response.status === 403 ? 'auth' : 'bad-request';
        result = { ok: false, code, retryable: false, error: 'The transcription service rejected the request.' };
      } else {
        result = { ok: true, text: cleanTranscription(JSON.parse(body), durationMs) };
      }
    } catch (err) {
      const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      result = { ok: false, code: timeout ? 'timeout' : 'network', retryable: true, error: 'Could not reach the transcription service.' };
    } finally {
      this.active -= 1;
      setImmediate(() => this.pump());
    }
    const ms = Date.now() - started;
    this.metrics.inc('peerly_transcribe_total', { outcome: result.ok ? 'ok' : result.code });
    if (result.ok) this.log.debug('clip transcribed', { ms, audioMs: durationMs, chars: result.text.length, waitedMs: started - job.queuedAt });
    else this.log.warn('clip transcription failed', { ms, audioMs: durationMs, code: result.code });
    job.resolve(result);
  }
}

module.exports = { Transcriber, wavFromPcm, cleanTranscription, pcmDurationMs, SAMPLE_RATE };

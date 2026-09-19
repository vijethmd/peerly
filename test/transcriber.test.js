'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { Transcriber, wavFromPcm, cleanTranscription } = require('../src/transcriber');
const { createLogger } = require('../src/logger');
const { Metrics } = require('../src/metrics');
const { startServer, join, emitAck, waitFor, sleep } = require('./helpers');

const logger = createLogger({ level: 'silent' });
const pcmOf = (ms) => Buffer.alloc(Math.round((ms / 1000) * 16000) * 2, 1);

function transcriber(fetchImpl, overrides = {}) {
  return new Transcriber({
    config: { enabled: true, baseUrl: 'https://api.groq.test/openai/v1/', apiKey: 'gsk_test', model: 'whisper-large-v3-turbo', maxPerMinute: 18, ...overrides },
    logger,
    metrics: new Metrics(),
    fetchImpl
  });
}

const whisper = (text, extra = {}) =>
  new Response(JSON.stringify({ text, segments: [{ text, no_speech_prob: 0.01, avg_logprob: -0.2 }], ...extra }), { status: 200 });

describe('Whisper transcription', () => {
  test('clips go out as 16 kHz mono WAV with the model, language and prompt', async () => {
    const calls = [];
    const t = transcriber(async (url, init) => {
      calls.push({ url, init, form: init.body });
      return whisper(' Let’s ship the beta on Friday. ');
    });
    const result = await t.submit({ key: 'room:alice', pcm: pcmOf(2000), language: 'en', prompt: 'Meeting with Alice, Bob.' });
    assert.deepEqual(result, { ok: true, text: 'Let’s ship the beta on Friday.' });
    const [{ url, init, form }] = calls;
    assert.equal(url, 'https://api.groq.test/openai/v1/audio/transcriptions');
    assert.equal(init.headers.authorization, 'Bearer gsk_test');
    assert.equal(form.get('model'), 'whisper-large-v3-turbo');
    assert.equal(form.get('language'), 'en');
    assert.equal(form.get('response_format'), 'verbose_json');
    assert.equal(form.get('temperature'), '0');
    assert.equal(form.get('prompt'), 'Meeting with Alice, Bob.');
    const wav = Buffer.from(await form.get('file').arrayBuffer());
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt32LE(24), 16000, 'sample rate');
    assert.equal(wav.readUInt16LE(22), 1, 'mono');
    assert.equal(wav.length, 44 + 64000);
  });

  test('silence and Whisper’s stock inventions are dropped', () => {
    assert.equal(cleanTranscription({ segments: [{ text: 'Thank you.', no_speech_prob: 0.2, avg_logprob: -0.3 }] }, 1500), '');
    assert.equal(cleanTranscription({ segments: [{ text: 'Thank you.', no_speech_prob: 0.2, avg_logprob: -0.3 }] }, 6000), 'Thank you.', 'real thanks in a longer clip stay');
    assert.equal(cleanTranscription({ segments: [{ text: 'blah', no_speech_prob: 0.95, avg_logprob: -0.2 }] }, 3000), '');
    assert.equal(cleanTranscription({ segments: [{ text: 'mumble', no_speech_prob: 0.7, avg_logprob: -1.4 }, { text: 'Bob owns it.', no_speech_prob: 0.05, avg_logprob: -0.3 }] }, 5000), 'Bob owns it.');
    assert.equal(cleanTranscription({ text: ' ♪ ♪ ' }, 3000), '');
    assert.equal(cleanTranscription({ text: 'नमस्ते सबको' }, 3000), 'नमस्ते सबको');
    const wav = wavFromPcm(Buffer.alloc(320));
    assert.equal(wav.readUInt32LE(40), 320);
  });

  test('stays under the per-minute limit and merges a backlog from the same speaker', async () => {
    const forms = [];
    let release;
    const gate = new Promise((r) => (release = r));
    const t = transcriber(async (url, init) => {
      forms.push(init.body);
      await gate;
      return whisper('text');
    }, { maxPerMinute: 1 });
    const first = t.submit({ key: 'r:alice', pcm: pcmOf(1000) });
    const second = t.submit({ key: 'r:alice', pcm: pcmOf(1000) });
    const third = t.submit({ key: 'r:alice', pcm: pcmOf(1000) });
    await sleep(50);
    assert.equal(forms.length, 1, 'one request in this minute');
    assert.equal(t.queue.length, 2);
    release();
    assert.equal((await first).text, 'text');
    // The next slot (a minute later) takes both queued clips as one request.
    const merged = t.take();
    assert.equal(t.queue.length, 0);
    assert.equal(merged.pcm.length, pcmOf(1000).length * 2 + 8000, 'two clips and a 250 ms gap');
    merged.resolve({ ok: true, text: 'both' });
    assert.equal((await second).text, 'both');
    assert.deepEqual(await third, { ok: true, text: '', merged: true });
    clearTimeout(t.timer);
  });

  test('waits out "busy" answers, then reports failures without throwing', async () => {
    let calls = 0;
    const t = transcriber(async () => {
      calls += 1;
      return calls === 1 ? new Response('{}', { status: 429, headers: { 'retry-after': '0' } }) : whisper('after the wait');
    });
    assert.deepEqual(await t.submit({ key: 'k', pcm: pcmOf(1000) }), { ok: true, text: 'after the wait' });
    assert.equal(calls, 2);

    const denied = transcriber(async () => new Response('{"error":{"message":"Invalid API Key"}}', { status: 401 }));
    const result = await denied.submit({ key: 'k', pcm: pcmOf(1000) });
    assert.deepEqual([result.ok, result.code, result.retryable], [false, 'auth', false]);

    const offline = transcriber(async () => {
      throw new TypeError('fetch failed');
    });
    assert.equal((await offline.submit({ key: 'k', pcm: pcmOf(1000) })).code, 'network');

    const off = new Transcriber({ config: { enabled: false }, logger, metrics: new Metrics() });
    assert.equal((await off.submit({ key: 'k', pcm: pcmOf(1000) })).code, 'off');
  });
});

describe('POST /api/transcribe', () => {
  const cleanups = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()();
  });

  async function setup() {
    const clips = [];
    const fake = {
      enabled: true,
      async submit(job) {
        clips.push(job);
        return { ok: true, text: 'hello from whisper' };
      }
    };
    const s = await startServer({}, { transcriber: fake });
    cleanups.push(s.close);
    return { url: s.url, clips };
  }

  const upload = (url, { roomId, pid, token, body = pcmOf(1000), type = 'audio/L16; rate=16000; channels=1', age = '1200' }) =>
    fetch(`${url}/api/transcribe`, {
      method: 'POST',
      headers: { 'content-type': type, 'x-peerly-room': roomId, 'x-peerly-pid': pid, 'x-peerly-token': token, 'x-peerly-age': age },
      body
    });

  test('a participant’s clip becomes their transcript line for everyone', async () => {
    const { url, clips } = await setup();
    const alice = await join(url, { name: 'Alice' });
    const bob = await join(url, { name: 'Bob' });
    cleanups.push(async () => [alice, bob].forEach((p) => p.socket.close()));
    const creds = { roomId: 'abc-defg-hij', pid: alice.ack.self.pid, token: alice.ack.self.token };

    const off = await upload(url, creds);
    assert.equal(off.status, 409, 'transcription is off');

    await emitAck(alice.socket, 'transcription', { on: true, lang: 'hi-IN' });
    const caption = waitFor(bob.socket, 'caption');
    const response = await upload(url, creds);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).text, 'hello from whisper');
    const seen = await caption;
    assert.deepEqual([seen.pid, seen.name, seen.text, seen.final, seen.source], [alice.ack.self.pid, 'Alice', 'hello from whisper', true, 'server']);
    assert.ok(Date.now() - seen.ts >= 1100 && Date.now() - seen.ts < 5000, 'dated to when the speech began');
    assert.equal(clips[0].language, 'hi', 'the meeting’s language');
    assert.match(clips[0].prompt, /Alice/);
    assert.equal(clips[0].key, `abc-defg-hij:${alice.ack.self.pid}`);
  });

  test('refuses forged identities, bad audio, and floods', async () => {
    const { url } = await setup();
    const alice = await join(url, { name: 'Alice' });
    cleanups.push(async () => alice.socket.close());
    await emitAck(alice.socket, 'transcription', { on: true, lang: 'en-US' });
    const creds = { roomId: 'abc-defg-hij', pid: alice.ack.self.pid, token: alice.ack.self.token };

    assert.equal((await upload(url, { ...creds, token: 'forged' })).status, 403);
    assert.equal((await upload(url, { ...creds, type: 'application/json', body: '{}' })).status, 400);
    assert.equal((await upload(url, { ...creds, body: Buffer.alloc(3) })).status, 400, 'odd byte count / too short');
    assert.equal((await upload(url, { ...creds, body: Buffer.alloc(1200 * 1024) })).status, 413, 'too long');

    const statuses = [];
    for (let i = 0; i < 8; i++) statuses.push((await upload(url, creds)).status);
    assert.ok(statuses.includes(429), `per-person rate limit (${statuses})`);
  });
});

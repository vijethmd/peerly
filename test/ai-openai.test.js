'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { AiService, REPORT_SCHEMA } = require('../src/ai');
const { toOpenAiSchema, estimateTokens, parseRetryAfter } = require('../src/ai-openai');
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/logger');
const { Metrics } = require('../src/metrics');

const START = Date.UTC(2026, 8, 17, 10, 0, 0);
const NOTES = { title: 'Beta launch', summary: 'S', keyPoints: ['k'], topics: [], decisions: ['Ship Friday'], actionItems: [], openQuestions: [] };

function input(transcript) {
  return {
    meeting: { roomId: 'abc-defg-hij', startedAt: START, endedAt: START + 30 * 60000 },
    participants: [{ name: 'Alice', isHost: true, words: 10 }, { name: 'Bob', isHost: false, words: 10 }],
    transcript: transcript || [
      { id: 1, pid: 'a', name: 'Alice', text: 'we decided to ship the beta on Friday', ts: START + 5000 },
      { id: 2, pid: 'b', name: 'Bob', text: "I'll write the release notes by Thursday", ts: START + 65000 }
    ],
    chat: []
  };
}

function reply(status, body, headers = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
}
const completion = (data, extra = {}) =>
  reply(200, {
    model: 'openai/gpt-oss-120b',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(data) } }],
    usage: { prompt_tokens: 900, completion_tokens: 300 },
    ...extra
  });

// A fetch that answers from a script and records every request.
function scriptedFetch(...responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next.clone();
  };
  return { fetchImpl, calls };
}

function groq(fetchImpl, env = {}) {
  const config = loadConfig({ GROQ_API_KEY: 'gsk_test', ...env });
  return new AiService({ config: config.ai, logger: createLogger({ level: 'silent' }), metrics: new Metrics(), fetchImpl });
}

describe('Groq (OpenAI-compatible) notes', () => {
  test('sends a strict JSON-schema request to gpt-oss-120b with low reasoning effort', async () => {
    const { fetchImpl, calls } = scriptedFetch(completion(NOTES));
    const result = await groq(fetchImpl).generateReport(input());
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'ai');
    assert.equal(result.model, 'openai/gpt-oss-120b');
    assert.equal(result.data.title, 'Beta launch');

    const [{ url, init, body }] = calls;
    assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(init.headers.authorization, 'Bearer gsk_test');
    assert.equal(body.model, 'openai/gpt-oss-120b');
    assert.equal(body.reasoning_effort, 'low');
    assert.equal(body.include_reasoning, false);
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.response_format.json_schema.strict, true);
    assert.deepEqual(body.response_format.json_schema.schema.properties.actionItems.items.properties.owner.type, ['string', 'null']);
    assert.ok(body.messages[0].content.includes('untrusted data'));
    assert.ok(body.messages[1].content.includes('ship the beta on Friday'));
    assert.ok(estimateTokens(JSON.stringify(body)) + body.max_completion_tokens < 8000, 'fits the free tier’s 8K tokens per minute');
  });

  test('long meetings are condensed to their most informative lines to fit the token budget', async () => {
    const filler = Array.from({ length: 600 }, (_, i) => ({
      id: i,
      pid: i % 2 ? 'a' : 'b',
      name: i % 2 ? 'Alice' : 'Bob',
      text: `we talked about item number ${i} and some general things that went on for a while`,
      ts: START + i * 3000
    }));
    filler.splice(300, 0, { id: 9999, pid: 'b', name: 'Bob', text: "I'll write the release notes by Thursday", ts: START + 900000 });
    const { fetchImpl, calls } = scriptedFetch(completion(NOTES));
    const result = await groq(fetchImpl).generateReport(input(filler));
    assert.equal(result.ok, true);
    const prompt = calls[0].body.messages[1].content;
    assert.ok(prompt.includes('[…]'), 'gaps are marked');
    assert.ok(prompt.includes('shortened to its most informative lines'));
    assert.ok(prompt.includes("I'll write the release notes by Thursday"), 'the commitment survives the cut');
    assert.ok(estimateTokens(JSON.stringify(calls[0].body)) + calls[0].body.max_completion_tokens <= 7500 + 200);
  });

  test('"request too large" shrinks the prompt and tries again', async () => {
    const tooLarge = reply(413, { error: { message: 'Request too large for model on tokens per minute (TPM)', type: 'tokens' } });
    const { fetchImpl, calls } = scriptedFetch(tooLarge, completion(NOTES));
    const filler = Array.from({ length: 300 }, (_, i) => ({ id: i, pid: 'a', name: 'Alice', text: `point ${i} about the launch plan and the budget`, ts: START + i * 3000 }));
    const result = await groq(fetchImpl).generateReport(input(filler));
    assert.equal(result.ok, true);
    assert.equal(calls.length, 2);
    assert.ok(calls[1].body.messages[1].content.length < calls[0].body.messages[1].content.length);
  });

  test('waits out short rate limits; long ones fall back to Peerly’s own notes', async () => {
    const limited = (seconds) => reply(429, { error: { message: 'Rate limit reached' } }, { 'retry-after': String(seconds) });
    const short = scriptedFetch(limited(0), completion(NOTES));
    const ok = await groq(short.fetchImpl).generateReport(input());
    assert.equal(ok.ok, true);
    assert.equal(ok.kind, 'ai');
    assert.equal(short.calls.length, 2);

    const long = scriptedFetch(limited(120));
    const fallback = await groq(long.fetchImpl).generateReport(input());
    assert.equal(long.calls.length, 1, 'no two-minute wait');
    assert.equal(fallback.ok, true);
    assert.equal(fallback.kind, 'auto');
    assert.deepEqual(fallback.fallback, { code: 'rate-limited', error: 'The AI service is busy. Please try again shortly.', retryable: true });
    assert.equal(fallback.data.actionItems[0].owner, 'Bob', 'the stand-in notes are real notes');

    const strict = await groq(long.fetchImpl, { AI_LOCAL_FALLBACK: 'false' }).generateReport(input());
    assert.deepEqual([strict.ok, strict.code, strict.retryable], [false, 'rate-limited', true]);
  });

  test('maps auth, network, truncation and bad JSON; retries strict mode as plain JSON when unsupported', async () => {
    const off = { AI_LOCAL_FALLBACK: 'false' };
    const auth = await groq(scriptedFetch(reply(401, { error: { message: 'Invalid API Key' } })).fetchImpl, off).generateReport(input());
    assert.deepEqual([auth.code, auth.retryable], ['auth', false]);

    const network = await groq(scriptedFetch(new TypeError('fetch failed')).fetchImpl, off).catchUp(input());
    assert.deepEqual([network.code, network.retryable], ['network', true]);

    const cut = completion(NOTES, { choices: [{ finish_reason: 'length', message: { content: '{"title":' } }] });
    assert.equal((await groq(scriptedFetch(cut).fetchImpl, off).generateReport(input())).code, 'truncated');

    const garbage = completion(NOTES, { choices: [{ finish_reason: 'stop', message: { content: 'not json' } }] });
    assert.equal((await groq(scriptedFetch(garbage).fetchImpl, off).generateReport(input())).code, 'invalid-output');

    const unsupported = reply(400, { error: { message: 'response_format json_schema is not supported by this model' } });
    const retried = scriptedFetch(unsupported, completion(NOTES));
    const result = await groq(retried.fetchImpl, off).generateReport(input());
    assert.equal(result.ok, true);
    assert.equal(retried.calls[1].body.response_format.type, 'json_object');
    assert.ok(retried.calls[1].body.messages[0].content.includes('JSON Schema'), 'schema moves into the prompt');
  });

  test('recaps are short, bounded requests', async () => {
    const recap = { recap: 'They planned the launch.', keyPoints: ['Ship Friday'], currentTopic: null };
    const { fetchImpl, calls } = scriptedFetch(completion(recap));
    const result = await groq(fetchImpl).catchUp({ ...input(), meeting: { ...input().meeting, now: START + 120000 } });
    assert.equal(result.ok, true);
    assert.equal(result.data.recap, 'They planned the launch.');
    assert.equal(result.partial, false);
    assert.ok(calls[0].body.max_completion_tokens <= 1500);
  });

  test('works with any OpenAI-compatible endpoint', async () => {
    const { fetchImpl, calls } = scriptedFetch(completion(NOTES));
    const config = loadConfig({ AI_PROVIDER: 'openai', AI_BASE_URL: 'http://localhost:11434/v1/', AI_MODEL: 'llama3.2' });
    const ai = new AiService({ config: config.ai, logger: createLogger({ level: 'silent' }), metrics: new Metrics(), fetchImpl });
    assert.equal((await ai.generateReport(input())).ok, true);
    assert.equal(calls[0].url, 'http://localhost:11434/v1/chat/completions');
    assert.equal(calls[0].init.headers.authorization, undefined, 'no key, no header');
    assert.equal(calls[0].body.response_format.type, 'json_object', 'unknown models get JSON mode');
    assert.equal(calls[0].body.reasoning_effort, undefined);
  });

  test('helpers', () => {
    const schema = toOpenAiSchema(REPORT_SCHEMA);
    assert.deepEqual(schema.properties.actionItems.items.properties.due.type, ['string', 'null']);
    assert.equal(schema.properties.actionItems.items.properties.due.anyOf, undefined);
    assert.equal(parseRetryAfter('2'), 2000);
    assert.equal(parseRetryAfter(null), null);
    assert.ok(estimateTokens('नमस्ते दुनिया') > estimateTokens('hello world'), 'non-Latin text is budgeted generously');
  });
});

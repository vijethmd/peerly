'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const { TokenBucket, KeyedRateLimiter, SlidingWindowCounter } = require('../src/rateLimit');
const { createTokenService } = require('../src/tokens');
const { sanitizeName, sanitizeText, sanitizeLine, isRoomId, isLang } = require('../src/validate');
const { buildIceServers } = require('../src/ice');
const { reactionMoments } = require('../src/reports');
const { redactPath, generateRoomId } = require('../src/app');
const { clientIp } = require('../src/signaling');

describe('config', () => {
  test('uses safe defaults', () => {
    const config = loadConfig({});
    assert.equal(config.port, 4800);
    assert.equal(config.rooms.maxSize, 8);
    assert.equal(config.ai.enabled, false);
    assert.equal(config.ai.model, 'claude-opus-5');
    assert.equal(config.sessionSecretIsEphemeral, true);
    assert.ok(Object.isFrozen(config.rooms));
  });

  test('detects Render: production mode and its X-Forwarded-For convention', () => {
    const config = loadConfig({ RENDER: 'true' });
    assert.equal(config.isProduction, true);
    assert.equal(config.trustProxy, true);
    assert.equal(loadConfig({ RENDER: 'true', NODE_ENV: 'development' }).isProduction, false);
    assert.equal(loadConfig({ TRUST_PROXY: '2' }).trustProxy, 2);
    assert.throws(() => loadConfig({ TRUST_PROXY: 'maybe' }), /TRUST_PROXY/);
  });

  test('turns AI on when an API key is present', () => {
    assert.equal(loadConfig({ ANTHROPIC_API_KEY: 'sk-test' }).ai.enabled, true);
    assert.equal(loadConfig({ ANTHROPIC_API_KEY: 'sk-test', AI_ENABLED: 'false' }).ai.enabled, false);
  });

  test('fails fast on invalid values', () => {
    assert.throws(() => loadConfig({ PORT: 'eighty' }), /PORT must be an integer/);
    assert.throws(() => loadConfig({ MAX_ROOM_SIZE: '100' }), /MAX_ROOM_SIZE must be between/);
    assert.throws(() => loadConfig({ SESSION_SECRET: 'short' }), /at least 32/);
    assert.throws(() => loadConfig({ AI_EFFORT: 'extreme' }), /AI_EFFORT must be one of/);
    assert.throws(() => loadConfig({ TURN_URL: 'turn:x' }), /TURN_SECRET/);
    assert.throws(() => loadConfig({ FORCE_RELAY: 'true' }), /requires a TURN server/);
  });
});

describe('rate limiting', () => {
  test('token bucket allows bursts then refills over time', () => {
    const bucket = new TokenBucket(2, 1, 0);
    assert.equal(bucket.take(1, 0), true);
    assert.equal(bucket.take(1, 0), true);
    assert.equal(bucket.take(1, 0), false);
    assert.equal(bucket.msUntil(1, 0), 1000);
    assert.equal(bucket.take(1, 1000), true);
  });

  test('keyed limiter isolates keys and prunes idle buckets', () => {
    const limiter = new KeyedRateLimiter({ capacity: 1, refillPerSecond: 1, maxKeys: 10 });
    assert.equal(limiter.take('a', 1, 0), true);
    assert.equal(limiter.take('a', 1, 0), false);
    assert.equal(limiter.take('b', 1, 0), true);
    limiter.prune(5000);
    assert.equal(limiter.buckets.size, 0);
  });

  test('sliding window caps hits per window', () => {
    const counter = new SlidingWindowCounter(2, 1000);
    assert.equal(counter.tryHit(0), true);
    assert.equal(counter.tryHit(10), true);
    assert.equal(counter.tryHit(20), false);
    assert.equal(counter.tryHit(1001), true);
  });
});

describe('tokens', () => {
  const tokens = createTokenService('s'.repeat(40));

  test('resume tokens are bound to room and participant', () => {
    const token = tokens.resumeToken('abc-defg-hij', 'pid-12345');
    assert.equal(tokens.verifyResumeToken('abc-defg-hij', 'pid-12345', token), true);
    assert.equal(tokens.verifyResumeToken('abc-defg-xyz', 'pid-12345', token), false);
    assert.equal(tokens.verifyResumeToken('abc-defg-hij', 'pid-99999', token), false);
    assert.equal(createTokenService('t'.repeat(40)).verifyResumeToken('abc-defg-hij', 'pid-12345', token), false);
  });

  test('host proofs carry a verifiable timestamp', () => {
    const proof = tokens.hostProof('abc-defg-hij', 'pid-12345', 1700000000000);
    assert.equal(tokens.verifyHostProof('abc-defg-hij', 'pid-12345', proof), 1700000000000);
    assert.equal(tokens.verifyHostProof('abc-defg-hij', 'pid-12345', proof.replace('1700', '1800')), 0);
    assert.equal(tokens.verifyHostProof('abc-defg-hij', 'pid-12345', 'garbage'), 0);
  });
});

describe('validation', () => {
  test('sanitizes names and text', () => {
    assert.equal(sanitizeName('  Jane\u202e   Doe \u0007 '), 'Jane Doe');
    assert.equal(sanitizeName('x'.repeat(50)).length, 30);
    assert.equal(sanitizeName('   '), null);
    assert.equal(sanitizeName(42), null);
    assert.equal(sanitizeText('line1\r\n\n\n\nline2', 100), 'line1\n\nline2');
    // Names and messages in any script must survive untouched.
    assert.equal(sanitizeName('विजेत कुमार'), 'विजेत कुमार');
    assert.equal(sanitizeName('ವಿಜೇತ್'), 'ವಿಜೇತ್');
    assert.equal(sanitizeName('张伟'), '张伟');
    assert.equal(sanitizeName('José Ñuñez'), 'José Ñuñez');
    assert.equal(sanitizeText('naïve café — こんにちは', 100), 'naïve café — こんにちは');
    assert.equal(sanitizeLine('a\n  b', 100), 'a b');
    // Never leaves half a surrogate pair behind.
    assert.equal(sanitizeText(`${'a'.repeat(9)}😀`, 10), 'a'.repeat(9));
  });

  test('validates identifiers', () => {
    assert.equal(isRoomId('abc-defg-hij'), true);
    assert.equal(isRoomId('ABC-defg-hij'), false);
    assert.equal(isLang('en-US'), true);
    assert.equal(isLang('zh-Hant-TW'), true);
    assert.equal(isLang('en_US; drop'), false);
    assert.match(generateRoomId(), /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
  });
});

describe('ICE servers', () => {
  const base = { stunUrls: ['stun:stun.example:3478'], turnUrls: [], turnTtlSeconds: 3600 };

  test('STUN only by default', () => {
    assert.deepEqual(buildIceServers(base), [{ urls: ['stun:stun.example:3478'] }]);
  });

  test('ephemeral TURN credentials from a shared secret', () => {
    const servers = buildIceServers({ ...base, turnUrls: ['turn:turn.example:3478'], turnSecret: 'shh' }, { pid: 'p1', now: 1000000 });
    assert.equal(servers[1].username, `${1000 + 3600}:p1`);
    assert.equal(typeof servers[1].credential, 'string');
  });
});

describe('reports', () => {
  test('finds reaction moments', () => {
    const log = [
      { ts: 0, emoji: '🎉' },
      { ts: 1000, emoji: '🎉' },
      { ts: 2000, emoji: '👏' },
      { ts: 90000, emoji: '👍' }
    ];
    assert.deepEqual(reactionMoments(log), [{ ts: 0, count: 3, emoji: '🎉' }]);
  });

  test('redacts report ids from logged paths', () => {
    assert.equal(redactPath('/api/report/SECRET123456789/retry'), '/api/report/:id/retry');
    assert.equal(redactPath('/report/SECRET123456789'), '/report/:id');
    assert.equal(redactPath('/api/room/abc-defg-hij'), '/api/room/abc-defg-hij');
  });

  test('honors X-Forwarded-For only for trusted hops', () => {
    const req = { socket: { remoteAddress: '10.0.0.1' }, headers: { 'x-forwarded-for': 'spoofed, 203.0.113.9' } };
    assert.equal(clientIp(req, 0), '10.0.0.1');
    assert.equal(clientIp(req, 1), '203.0.113.9');
    // Render puts the real client first.
    assert.equal(clientIp({ ...req, headers: { 'x-forwarded-for': '198.51.100.7, 172.70.1.1' } }, true), '198.51.100.7');
  });
});

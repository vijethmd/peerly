'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, join, emitAck, waitFor } = require('./helpers');

describe('HTTP API', () => {
  let s;
  before(async () => {
    s = await startServer({ METRICS_TOKEN: 'metrics-secret' });
  });
  after(() => s.close());

  test('sets security headers', async () => {
    const res = await fetch(`${s.url}/`);
    assert.equal(res.status, 200);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.match(res.headers.get('permissions-policy'), /camera=\(self\)/);
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.ok(res.headers.get('x-request-id'));
  });

  test('health and readiness', async () => {
    assert.equal((await fetch(`${s.url}/healthz`)).status, 200);
    assert.equal((await fetch(`${s.url}/readyz`)).status, 200);
  });

  test('room info reflects occupancy and lock state', async () => {
    const empty = await (await fetch(`${s.url}/api/room/qqq-qqqq-qqq`)).json();
    assert.deepEqual(empty, { valid: true, count: 0, max: 8, full: false, locked: false, here: false });
    assert.equal((await fetch(`${s.url}/api/room/not-valid`)).status, 400);

    const host = await join(s.url, { roomId: 'qqq-qqqq-qqq', name: 'Host' });
    await emitAck(host.socket, 'host-action', { action: 'lock' });
    const info = await (await fetch(`${s.url}/api/room/qqq-qqqq-qqq`)).json();
    assert.equal(info.count, 1);
    assert.equal(info.locked, true);
    host.socket.close();
  });

  test('new rooms get valid, unused codes', async () => {
    const { roomId } = await (await fetch(`${s.url}/api/new-room`)).json();
    assert.match(roomId, /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
  });

  test('unknown API routes return JSON 404s and pages return HTML 404s', async () => {
    const api = await fetch(`${s.url}/api/nope`);
    assert.equal(api.status, 404);
    assert.deepEqual(await api.json(), { error: 'Not found' });
    const page = await fetch(`${s.url}/definitely-missing`, { headers: { Accept: 'text/html' } });
    assert.equal(page.status, 404);
    assert.match(page.headers.get('content-type'), /html/);
  });

  test('invalid room links redirect home and report pages are not indexed', async () => {
    const res = await fetch(`${s.url}/room/INVALID`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/?error=invalid-room');
    const report = await fetch(`${s.url}/report/abcdefghijklmnopqrstuv`);
    assert.equal(report.status, 200);
    assert.match(report.headers.get('x-robots-tag'), /noindex/);
  });

  test('metrics require the bearer token', async () => {
    assert.equal((await fetch(`${s.url}/metrics`)).status, 401);
    const res = await fetch(`${s.url}/metrics`, { headers: { Authorization: 'Bearer metrics-secret' } });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /peerly_rooms \d+/);
    assert.match(body, /# TYPE peerly_joins_total counter/);
  });

  test('client error reports are accepted and bounded', async () => {
    const ok = await fetch(`${s.url}/api/client-errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'boom', stack: 'at x' })
    });
    assert.equal(ok.status, 204);
    const tooBig = await fetch(`${s.url}/api/client-errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'x'.repeat(40000) })
    });
    assert.equal(tooBig.status, 413);
  });

  test('graceful shutdown tells clients to reconnect and fails readiness', async () => {
    const local = await startServer();
    const alice = await join(local.url, { roomId: 'zzz-zzzz-zzz', name: 'Alice' });
    const notice = waitFor(alice.socket, 'server-shutdown');
    const closing = local.peerly.close({ timeoutMs: 1000 });
    assert.equal((await notice).reconnectInMs > 0, true);
    await closing;
    alice.socket.close();
  });
});

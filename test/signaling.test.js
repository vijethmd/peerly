'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  startServer,
  connect,
  emitAck,
  waitFor,
  expectSilence,
  join,
  clientId,
  fakeAi,
  sleep,
  PROTOCOL_VERSION
} = require('./helpers');

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function server(env, options) {
  const s = await startServer(env, options);
  cleanups.push(s.close);
  return s;
}

function track(...sockets) {
  cleanups.push(async () => sockets.forEach((s) => s.close()));
  return sockets;
}

describe('joining', () => {
  test('first participant becomes host and gets credentials, ICE servers and features', async () => {
    const { url } = await server();
    const alice = await join(url, { name: 'Alice' });
    track(alice.socket);

    assert.equal(alice.ack.ok, true);
    assert.equal(alice.ack.resumed, false);
    assert.match(alice.ack.self.pid, /^[\w-]{8,}$/);
    assert.ok(alice.ack.self.token);
    assert.ok(alice.ack.self.hostProof, 'host receives a host proof');
    assert.equal(alice.ack.room.hostPid, alice.ack.self.pid);
    assert.equal(alice.ack.room.participants.length, 1);
    assert.ok(alice.ack.iceServers.length >= 1);
    assert.equal(alice.ack.features.protocolVersion, PROTOCOL_VERSION);
  });

  test('second participant sees the first; the first is told about the second', async () => {
    const { url } = await server();
    const alice = await join(url, { name: 'Alice' });
    track(alice.socket);
    const joined = waitFor(alice.socket, 'peer-joined');
    const bob = await join(url, { name: 'Bob' });
    track(bob.socket);

    assert.equal(bob.ack.room.participants.length, 2);
    assert.equal(bob.ack.self.hostProof, null);
    const event = await joined;
    assert.equal(event.participant.name, 'Bob');
    assert.equal(event.participant.pid, bob.ack.self.pid);
    assert.equal(event.resumed, false);
  });

  test('rejects outdated clients, invalid input and full rooms', async () => {
    const { url } = await server({ MAX_ROOM_SIZE: '2' });
    const socket = await connect(url);
    track(socket);

    const outdated = await emitAck(socket, 'join', { v: 1, roomId: 'abc-defg-hij', name: 'Old' });
    assert.equal(outdated.code, 'upgrade-required');
    const badRoom = await emitAck(socket, 'join', { v: PROTOCOL_VERSION, roomId: 'nope', name: 'X' });
    assert.equal(badRoom.code, 'invalid');
    const badName = await emitAck(socket, 'join', { v: PROTOCOL_VERSION, roomId: 'abc-defg-hij', name: ' \u202e ' });
    assert.equal(badName.code, 'invalid-name');

    const a = await join(url, { name: 'A' });
    const b = await join(url, { name: 'B' });
    track(a.socket, b.socket);
    const c = await join(url, { name: 'C' });
    track(c.socket);
    assert.equal(c.ack.code, 'full');
  });

  test('names are sanitized', async () => {
    const { url } = await server();
    const alice = await join(url, { name: '  Al\u202eice \n Smith  ' });
    track(alice.socket);
    assert.equal(alice.ack.room.participants[0].name, 'Alice Smith');
  });
});

describe('signaling relay', () => {
  test('relays WebRTC signals only to the addressed peer', async () => {
    const { url } = await server();
    const a = await join(url, { name: 'A' });
    const b = await join(url, { name: 'B' });
    const c = await join(url, { name: 'C' });
    track(a.socket, b.socket, c.socket);

    const received = waitFor(b.socket, 'signal');
    const silentC = expectSilence(c.socket, 'signal');
    a.socket.emit('signal', { to: b.ack.self.pid, sid: 'session-1', data: { description: { type: 'offer', sdp: 'v=0' } } });

    const signal = await received;
    assert.deepEqual(signal, { from: a.ack.self.pid, sid: 'session-1', data: { description: { type: 'offer', sdp: 'v=0' } } });
    assert.equal(await silentC, true);
  });
});

describe('chat', () => {
  test('public messages reach everyone; private messages only reach sender and recipient', async () => {
    const { url } = await server();
    const a = await join(url, { name: 'A' });
    const b = await join(url, { name: 'B' });
    const c = await join(url, { name: 'C' });
    track(a.socket, b.socket, c.socket);

    const publicAtC = waitFor(c.socket, 'chat');
    const ack = await emitAck(a.socket, 'chat', { text: 'hello all' });
    assert.equal(ack.ok, true);
    assert.equal((await publicAtC).text, 'hello all');

    const dmAtB = waitFor(b.socket, 'chat');
    const dmAtA = waitFor(a.socket, 'chat');
    const cSilent = expectSilence(c.socket, 'chat');
    const dmAck = await emitAck(a.socket, 'chat', { text: 'psst', to: b.ack.self.pid });
    assert.equal(dmAck.ok, true);
    const dm = await dmAtB;
    assert.equal(dm.to, b.ack.self.pid);
    assert.equal(dm.toName, 'B');
    assert.equal((await dmAtA).id, dm.id);
    assert.equal(await cSilent, true, 'third participant must not receive a DM');
  });

  test('host can turn off private messages for everyone else', async () => {
    const { url } = await server();
    const host = await join(url, { name: 'Host' });
    const guest = await join(url, { name: 'Guest' });
    track(host.socket, guest.socket);

    const settings = waitFor(guest.socket, 'room-settings');
    assert.equal((await emitAck(host.socket, 'host-action', { action: 'settings', privateChat: false })).ok, true);
    assert.equal((await settings).privateChat, false);

    const blocked = await emitAck(guest.socket, 'chat', { text: 'hi', to: host.ack.self.pid });
    assert.equal(blocked.code, 'private-chat-off');
    const allowed = await emitAck(host.socket, 'chat', { text: 'hi', to: guest.ack.self.pid });
    assert.equal(allowed.ok, true);
  });

  test('rejects empty messages and DMs to people who are not here', async () => {
    const { url } = await server();
    const a = await join(url, { name: 'A' });
    track(a.socket);
    assert.equal((await emitAck(a.socket, 'chat', { text: '   ' })).ok, false);
    assert.equal((await emitAck(a.socket, 'chat', { text: 'x', to: 'nobody-here-123' })).ok, false);
  });
});

describe('reactions', () => {
  test('broadcasts allowed reactions to others and rate limits floods', async () => {
    const { url } = await server();
    const a = await join(url, { name: 'A' });
    const b = await join(url, { name: 'B' });
    track(a.socket, b.socket);

    const atB = waitFor(b.socket, 'reaction');
    const atA = expectSilence(a.socket, 'reaction');
    assert.equal((await emitAck(a.socket, 'reaction', { emoji: '🎉' })).ok, true);
    assert.equal((await atB).emoji, '🎉');
    assert.equal(await atA, true, 'sender does not get their own reaction back');

    assert.equal((await emitAck(a.socket, 'reaction', { emoji: '<script>' })).ok, false);

    const results = await Promise.all(Array.from({ length: 30 }, () => emitAck(a.socket, 'reaction', { emoji: '👍' })));
    assert.ok(results.some((r) => r.code === 'rate-limited'), 'flooding gets rate limited');
  });
});

describe('reconnection', () => {
  test('a brief disconnect keeps the seat: peers see reconnecting, then resumed (never left)', async () => {
    const { url } = await server({ RECONNECT_GRACE_MS: '5000' });
    const alice = await join(url, { name: 'Alice' });
    const bob = await join(url, { name: 'Bob' });
    track(alice.socket);
    await emitAck(alice.socket, 'chat', { text: 'before the blip' });

    const reconnecting = waitFor(alice.socket, 'peer-reconnecting');
    const noLeave = expectSilence(alice.socket, 'peer-left', 800);
    bob.socket.close();
    assert.equal((await reconnecting).pid, bob.ack.self.pid);

    const resumed = waitFor(alice.socket, 'peer-resumed');
    const again = await join(url, { name: 'Bob', resume: { pid: bob.ack.self.pid, token: bob.ack.self.token } });
    track(again.socket);
    assert.equal(again.ack.ok, true);
    assert.equal(again.ack.resumed, true);
    assert.equal(again.ack.self.pid, bob.ack.self.pid);
    assert.ok(again.ack.chat.some((m) => m.text === 'before the blip'), 'chat history is restored on resume');
    const event = await resumed;
    assert.equal(event.participant.pid, bob.ack.self.pid);
    assert.equal(event.fresh, false);
    assert.equal(await noLeave, true);
  });

  test('the seat is released after the grace period', async () => {
    const { url } = await server({ RECONNECT_GRACE_MS: '1000' });
    const alice = await join(url, { name: 'Alice' });
    const bob = await join(url, { name: 'Bob' });
    track(alice.socket);

    const left = waitFor(alice.socket, 'peer-left', { timeout: 4000 });
    bob.socket.close();
    const event = await left;
    assert.equal(event.pid, bob.ack.self.pid);
    assert.equal(event.reason, 'timeout');
  });

  test('closing the tab (unload intent) removes the participant quickly without a reconnecting state', async () => {
    const { url } = await server({ RECONNECT_GRACE_MS: '30000', UNLOAD_GRACE_MS: '200' });
    const alice = await join(url, { name: 'Alice' });
    const bob = await join(url, { name: 'Bob' });
    track(alice.socket);

    const noReconnecting = expectSilence(alice.socket, 'peer-reconnecting', 600);
    const left = waitFor(alice.socket, 'peer-left', { timeout: 2000 });
    await emitAck(bob.socket, 'leave', { intent: 'unload' });
    bob.socket.close();
    assert.equal((await left).reason, 'left');
    assert.equal(await noReconnecting, true);
  });

  test('a forged resume token is not accepted', async () => {
    const { url } = await server();
    const alice = await join(url, { name: 'Alice' });
    track(alice.socket);
    const mallory = await join(url, { name: 'Mallory', resume: { pid: alice.ack.self.pid, token: 'forged' } });
    track(mallory.socket);
    assert.equal(mallory.ack.ok, true);
    assert.notEqual(mallory.ack.self.pid, alice.ack.self.pid, 'falls back to a fresh seat');
  });

  test('opening the same seat from another tab replaces the older connection', async () => {
    const { url } = await server();
    const alice = await join(url, { name: 'Alice' });
    const replaced = waitFor(alice.socket, 'session-replaced');
    const second = await join(url, { name: 'Alice', resume: { pid: alice.ack.self.pid, token: alice.ack.self.token } });
    track(alice.socket, second.socket);
    await replaced;
    assert.equal(second.ack.resumed, true);
  });

  test('a second tab of the same browser takes over the seat instead of joining as someone new', async () => {
    const { url } = await server();
    const device = clientId();
    const alice = await join(url, { name: 'Alice', clientId: device });
    const bob = await join(url, { name: 'Bob' });
    track(alice.socket, bob.socket);

    const replaced = waitFor(alice.socket, 'session-replaced');
    const resumedForBob = waitFor(bob.socket, 'peer-resumed');
    const secondTab = await join(url, { name: 'Alice', clientId: device, micOn: false });
    track(secondTab.socket);

    assert.equal(secondTab.ack.ok, true);
    assert.equal(secondTab.ack.moved, true);
    assert.equal(secondTab.ack.self.pid, alice.ack.self.pid, 'same person');
    assert.equal(secondTab.ack.room.hostPid, alice.ack.self.pid, 'still the host');
    assert.deepEqual(await replaced, { moved: true });
    const seen = await resumedForBob;
    assert.equal(seen.participant.pid, alice.ack.self.pid);
    assert.equal(seen.fresh, true, 'peers rebuild the connection to the new tab');
    assert.equal(seen.participant.micOn, false, 'the new tab’s media state wins');

    const snapshot = await emitAck(bob.socket, 'sync', {});
    assert.equal(snapshot.room.participants.length, 2, 'no duplicate Alice');
  });

  test('the same browser gets its seat back even when the meeting is locked or full, and a new name sticks', async () => {
    const { url } = await server({ MAX_ROOM_SIZE: '2' });
    const device = clientId();
    const host = await join(url, { name: 'Host', clientId: device });
    const guest = await join(url, { name: 'Guest' });
    track(host.socket, guest.socket);
    await emitAck(host.socket, 'host-action', { action: 'lock' });

    const renamed = waitFor(guest.socket, 'peer-resumed');
    const again = await join(url, { name: 'Host (laptop)', clientId: device });
    track(again.socket);
    assert.equal(again.ack.ok, true, 'not sent to the waiting room, not refused as full');
    assert.equal((await renamed).participant.name, 'Host (laptop)');

    const stranger = await join(url, { name: 'Stranger' });
    track(stranger.socket);
    assert.notEqual(stranger.ack.self?.pid, host.ack.self.pid, 'a different browser is a different person');
  });

  test('the lobby learns this browser is already in the meeting, via a header only', async () => {
    const { url } = await server();
    const device = clientId();
    const alice = await join(url, { name: 'Alice', roomId: 'abc-defg-hij', clientId: device });
    track(alice.socket);
    const ask = async (headers) => (await fetch(`${url}/api/room/abc-defg-hij`, { headers })).json();
    assert.equal((await ask({ 'x-peerly-client': device })).here, true);
    assert.equal((await ask({ 'x-peerly-client': clientId() })).here, false);
    assert.equal((await ask({})).here, false);
  });

  test('after a server restart everyone resumes into a rebuilt room and the real host gets the role back', async () => {
    const env = { MAX_ROOM_SIZE: '4' };
    const first = await startServer(env);
    const host = await join(first.url, { name: 'Host' });
    const guest = await join(first.url, { name: 'Guest' });
    const hostCreds = host.ack.self;
    const guestCreds = guest.ack.self;
    host.socket.close();
    guest.socket.close();
    await first.close();

    const { url } = await server(env);
    // The guest comes back first and becomes a provisional host...
    const guestBack = await join(url, { name: 'Guest', resume: { pid: guestCreds.pid, token: guestCreds.token } });
    track(guestBack.socket);
    assert.equal(guestBack.ack.resumed, true);
    assert.equal(guestBack.ack.rebuilt, true);
    assert.equal(guestBack.ack.room.hostPid, guestCreds.pid);

    // ...until the real host shows their proof.
    const hostChanged = waitFor(guestBack.socket, 'host-changed');
    const hostBack = await join(url, {
      name: 'Host',
      resume: { pid: hostCreds.pid, token: hostCreds.token },
      hostProof: hostCreds.hostProof
    });
    track(hostBack.socket);
    assert.equal(hostBack.ack.resumed, true);
    assert.equal(hostBack.ack.room.hostPid, hostCreds.pid);
    assert.equal((await hostChanged).hostPid, hostCreds.pid);
  });
});

describe('host controls', () => {
  test('host role fails over to the longest-present participant', async () => {
    const { url } = await server();
    const host = await join(url, { name: 'Host' });
    const second = await join(url, { name: 'Second' });
    const third = await join(url, { name: 'Third' });
    track(second.socket, third.socket);

    const changed = waitFor(third.socket, 'host-changed');
    const proof = waitFor(second.socket, 'host-proof');
    await emitAck(host.socket, 'leave', {});
    host.socket.close();
    assert.equal((await changed).hostPid, second.ack.self.pid);
    assert.ok((await proof).proof);
  });

  test('non-hosts cannot use host actions', async () => {
    const { url } = await server();
    const host = await join(url, { name: 'Host' });
    const guest = await join(url, { name: 'Guest' });
    track(host.socket, guest.socket);
    const res = await emitAck(guest.socket, 'host-action', { action: 'mute-all' });
    assert.equal(res.code, 'forbidden');
    const t = await emitAck(guest.socket, 'transcription', { on: true });
    assert.equal(t.code, 'forbidden');
  });

  test('removed participants cannot rejoin, even with a resume token', async () => {
    const { url } = await server();
    const host = await join(url, { name: 'Host' });
    const id = clientId();
    const guest = await join(url, { name: 'Guest', clientId: id });
    track(host.socket);

    const removed = waitFor(guest.socket, 'removed');
    const left = waitFor(host.socket, 'peer-left');
    await emitAck(host.socket, 'host-action', { action: 'remove', pid: guest.ack.self.pid });
    await removed;
    assert.equal((await left).reason, 'removed');
    guest.socket.close();

    const again = await join(url, { name: 'Guest', clientId: id });
    track(again.socket);
    assert.equal(again.ack.code, 'removed');
    const resumed = await join(url, { name: 'Guest', resume: { pid: guest.ack.self.pid, token: guest.ack.self.token } });
    track(resumed.socket);
    assert.equal(resumed.ack.code, 'removed');
  });

  test('locked meetings use a waiting room: host admits or denies', async () => {
    const { url } = await server();
    const host = await join(url, { name: 'Host' });
    track(host.socket);
    await emitAck(host.socket, 'host-action', { action: 'lock' });

    const knock = waitFor(host.socket, 'knock');
    const visitor = await join(url, { name: 'Visitor' });
    track(visitor.socket);
    assert.equal(visitor.ack.ok, false);
    assert.equal(visitor.ack.waiting, true);
    const { requestId, name } = await knock;
    assert.equal(name, 'Visitor');

    const result = waitFor(visitor.socket, 'knock-result');
    await emitAck(host.socket, 'knock-response', { requestId, admit: true });
    const { admitted, ticket } = await result;
    assert.equal(admitted, true);

    const entered = await emitAck(visitor.socket, 'join', {
      v: PROTOCOL_VERSION,
      roomId: 'abc-defg-hij',
      name: 'Visitor',
      ticket
    });
    assert.equal(entered.ok, true);

    const waitingList = waitFor(host.socket, 'waiting-list', { filter: (w) => w.waiting.length === 1 });
    const denied = await join(url, { name: 'Denied' });
    track(denied.socket);
    const deniedKnock = (await waitingList).waiting[0];
    const deniedResult = waitFor(denied.socket, 'knock-result');
    await emitAck(host.socket, 'knock-response', { requestId: deniedKnock.requestId, admit: false });
    assert.deepEqual(await deniedResult, { admitted: false, reason: 'denied' });
  });

  test('unlocking admits everyone waiting', async () => {
    const { url } = await server();
    const host = await join(url, { name: 'Host' });
    track(host.socket);
    await emitAck(host.socket, 'host-action', { action: 'lock' });
    const visitor = await join(url, { name: 'Visitor' });
    track(visitor.socket);
    assert.equal(visitor.ack.waiting, true);
    const result = waitFor(visitor.socket, 'knock-result');
    await emitAck(host.socket, 'host-action', { action: 'unlock' });
    assert.equal((await result).admitted, true);
  });

  test('presenting requires permission unless the host allows it', async () => {
    const { url } = await server();
    const host = await join(url, { name: 'Host' });
    const guest = await join(url, { name: 'Guest' });
    track(host.socket, guest.socket);

    const denied = await emitAck(guest.socket, 'state', { sharing: true });
    assert.equal(denied.code, 'forbidden');

    const request = waitFor(host.socket, 'share-request');
    assert.equal((await emitAck(guest.socket, 'share-request', {})).pending, true);
    assert.equal((await request).pid, guest.ack.self.pid);

    const permission = waitFor(guest.socket, 'share-permission');
    await emitAck(host.socket, 'set-share-permission', { pid: guest.ack.self.pid, allowed: true });
    assert.equal((await permission).allowed, true);

    const state = waitFor(host.socket, 'peer-state');
    assert.equal((await emitAck(guest.socket, 'state', { sharing: true })).ok, true);
    assert.equal((await state).sharing, true);
  });

  test('host can lower hands and end the meeting for everyone', async () => {
    const { url } = await server();
    const host = await join(url, { name: 'Host' });
    const guest = await join(url, { name: 'Guest' });
    track(host.socket, guest.socket);

    await emitAck(guest.socket, 'state', { handRaised: true });
    const lowered = waitFor(guest.socket, 'hand-lowered');
    await emitAck(host.socket, 'host-action', { action: 'lower-all-hands' });
    await lowered;

    const ended = waitFor(guest.socket, 'meeting-ended');
    await emitAck(host.socket, 'host-action', { action: 'end-meeting' });
    assert.equal((await ended).by, 'Host');
    const after = await emitAck(guest.socket, 'chat', { text: 'still here?' });
    assert.equal(after.code, 'not-joined');
  });
});

describe('transcription and AI notes', () => {
  test('captions are stored, the report is generated when the meeting ends, and served over HTTP', async () => {
    const ai = fakeAi();
    const { url } = await server({}, { ai });
    const host = await join(url, { name: 'Host' });
    const guest = await join(url, { name: 'Guest' });
    track(host.socket, guest.socket);

    const stateAtGuest = waitFor(guest.socket, 'transcription-state');
    const started = await emitAck(host.socket, 'transcription', { on: true, lang: 'en-GB' });
    assert.equal(started.ok, true);
    const state = await stateAtGuest;
    assert.equal(state.on, true);
    assert.equal(state.lang, 'en-GB');
    assert.ok(state.reportId);

    const interim = waitFor(host.socket, 'caption', { filter: (c) => !c.final });
    guest.socket.emit('caption', { text: 'we should ship', final: false });
    assert.equal((await interim).text, 'we should ship');

    const final = waitFor(host.socket, 'caption', { filter: (c) => c.final });
    const captionAck = await emitAck(guest.socket, 'caption', { text: 'We should ship on Friday.', final: true });
    assert.equal(captionAck.ok, true);
    assert.equal((await final).name, 'Guest');
    await emitAck(host.socket, 'chat', { text: 'Agreed, Friday it is' });
    await emitAck(host.socket, 'chat', { text: 'secret dm', to: guest.ack.self.pid });

    const recording = await (await fetch(`${url}/api/report/${state.reportId}`)).json();
    assert.equal(recording.status, 'recording');
    assert.equal(recording.transcript, undefined, 'no content while the meeting is live');

    await emitAck(host.socket, 'host-action', { action: 'end-meeting' });
    await sleep(50);

    const report = await (await fetch(`${url}/api/report/${state.reportId}`)).json();
    assert.equal(report.status, 'ready');
    assert.equal(report.ai.status, 'ready');
    assert.equal(report.ai.data.title, 'Launch planning');
    assert.equal(report.transcript.length, 1);
    assert.equal(report.transcript[0].text, 'We should ship on Friday.');
    assert.deepEqual(report.chat.map((m) => m.text), ['Agreed, Friday it is'], 'private messages never reach the report');
    assert.equal(report.meeting.endedBy, 'host');
    assert.equal(report.participants.length, 2);

    const aiInput = ai.calls.find((c) => c.kind === 'report').input;
    assert.ok(!JSON.stringify(aiInput).includes('secret dm'), 'private messages are never sent to the AI');
  });

  test('captions are ignored while transcription is off', async () => {
    const { url } = await server({}, { ai: fakeAi() });
    const a = await join(url, { name: 'A' });
    track(a.socket);
    const res = await emitAck(a.socket, 'caption', { text: 'hello', final: true });
    assert.equal(res.code, 'transcription-off');
  });

  test('catch me up summarizes, reuses the recap when nothing new was said, and explains when unavailable', async () => {
    const ai = fakeAi();
    const { url } = await server({}, { ai });
    const host = await join(url, { name: 'Host' });
    const late = await join(url, { name: 'Late' });
    track(host.socket, late.socket);

    const empty = await emitAck(late.socket, 'catch-up', {});
    assert.equal(empty.code, 'empty');

    await emitAck(host.socket, 'transcription', { on: true });
    await emitAck(host.socket, 'caption', { text: 'Budget is approved.', final: true });

    const first = await emitAck(late.socket, 'catch-up', {}, 5000);
    assert.equal(first.ok, true);
    assert.equal(first.recap.recap, 'They discussed the launch.');
    const second = await emitAck(host.socket, 'catch-up', {}, 5000);
    assert.equal(second.cached, true);
    assert.equal(ai.calls.filter((c) => c.kind === 'recap').length, 1);

    const { url: url2 } = await server({ AI_ENABLED: 'false' });
    const solo = await join(url2, { name: 'Solo' });
    track(solo.socket);
    assert.equal((await emitAck(solo.socket, 'catch-up', {})).code, 'ai-disabled');
  });
});

describe('connection security', () => {
  test('refuses WebSocket connections from other origins', async () => {
    const { url } = await server();
    await assert.rejects(
      connect(url, { transports: ['polling'], extraHeaders: { Origin: 'https://evil.example' } }),
      /xhr poll error|websocket error|forbidden/i
    );
  });

  test('limits concurrent connections per IP', async () => {
    const { url } = await server({ MAX_CONNECTIONS_PER_IP: '2' });
    const a = await connect(url);
    const b = await connect(url);
    track(a, b);
    await assert.rejects(connect(url), /Too many connections/);
  });

  test('beacon leave shortens the grace period for a closed tab', async () => {
    const { url } = await server({ RECONNECT_GRACE_MS: '30000', UNLOAD_GRACE_MS: '100' });
    const alice = await join(url, { name: 'Alice' });
    const bob = await join(url, { name: 'Bob' });
    track(alice.socket);
    const left = waitFor(alice.socket, 'peer-left', { timeout: 2000 });
    bob.socket.close();
    await waitFor(alice.socket, 'peer-reconnecting');
    const res = await fetch(`${url}/api/leave`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ roomId: 'abc-defg-hij', pid: bob.ack.self.pid, token: bob.ack.self.token })
    });
    assert.equal(res.status, 204);
    assert.equal((await left).reason, 'left');
  });
});

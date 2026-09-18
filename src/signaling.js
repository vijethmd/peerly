'use strict';

const { PROTOCOL_VERSION, REACTIONS, VIEWS, VIDEO_SOURCES } = require('./protocol');
const { Room } = require('./rooms');
const { isRoomId, isId, isLang, sanitizeName, sanitizeText, sanitizeLine } = require('./validate');
const { TokenBucket, KeyedRateLimiter } = require('./rateLimit');
const { randomId } = require('./tokens');
const { buildIceServers } = require('./ice');
const { clientFeatures } = require('./features');

// Per-socket budgets: [burst capacity, refill per second].
const EVENT_LIMITS = {
  join: [6, 0.2],
  leave: [5, 1],
  sync: [5, 0.2],
  signal: [400, 60],
  state: [30, 5],
  'view-state': [80, 10],
  chat: [8, 0.5],
  reaction: [15, 3],
  caption: [40, 8],
  stats: [4, 0.2],
  'share-request': [3, 0.1],
  'set-share-permission': [20, 2],
  'transfer-host': [5, 0.5],
  'host-action': [30, 3],
  'knock-response': [30, 3],
  'cancel-knock': [5, 1],
  transcription: [6, 0.2],
  'transcription-request': [3, 0.05],
  'catch-up': [4, 0.1]
};

const TICKET_TTL_MS = 60000;
const MAX_SID_LENGTH = 64;

const ERR = {
  internal: { ok: false, code: 'internal', error: 'Something went wrong. Please try again.' },
  rateLimited: { ok: false, code: 'rate-limited', error: 'You’re doing that too often. Please wait a moment.' },
  notJoined: { ok: false, code: 'not-joined', error: 'You’re not in this meeting.' },
  hostOnly: { ok: false, code: 'forbidden', error: 'Only the host can do that.' },
  removed: { ok: false, code: 'removed', error: 'You were removed from this meeting by the host.' },
  busy: { ok: false, code: 'server-busy', error: 'Peerly is at capacity right now. Please try again in a few minutes.' },
  noHost: { ok: false, code: 'no-host', error: 'The host isn’t connected right now. Try again in a moment.' },
  gone: { ok: false, code: 'invalid', error: 'That person is no longer in the meeting.' },
  invalid: (error) => ({ ok: false, code: 'invalid', error })
};

/**
 * Client IP, honoring X-Forwarded-For the same way Express's `trust proxy`
 * does: `true` trusts every hop (leftmost address), a number trusts that many
 * proxies from the right.
 */
function clientIp(req, trustProxy) {
  const remote = (req.socket && req.socket.remoteAddress) || 'unknown';
  if (!trustProxy) return remote;
  const header = req.headers['x-forwarded-for'];
  if (typeof header !== 'string' || !header) return remote;
  const hops = header.split(',').map((s) => s.trim()).filter(Boolean);
  if (trustProxy === true) return hops[0] || remote;
  return hops[Math.max(0, hops.length - trustProxy)] || remote;
}

/** Blocks cross-site WebSocket connections from other origins. */
function isOriginAllowed(req, allowedOrigins) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients don't send Origin
  if (allowedOrigins.length) return allowedOrigins.includes(origin);
  try {
    const host = new URL(origin).host;
    return host === req.headers.host || host === req.headers['x-forwarded-host'];
  } catch {
    return false;
  }
}

function createSignaling({ io, config, logger, registry, reports, ai, metrics, tokens, lifecycle }) {
  const log = logger.child({ component: 'signaling' });
  const ipConnections = new Map();
  const recapByParticipant = new KeyedRateLimiter({ capacity: 1, refillPerSecond: 1 / 30 });
  const recapByRoom = new KeyedRateLimiter({ capacity: 10, refillPerSecond: 10 / 3600 });

  const socketOf = (p) => (p && p.socketId ? io.sockets.sockets.get(p.socketId) : undefined);
  const emitTo = (p, event, payload) => {
    if (p && p.socketId) io.to(p.socketId).emit(event, payload);
  };

  function current(socket) {
    const { roomId, pid } = socket.data;
    if (!roomId || !pid) return null;
    const room = registry.get(roomId);
    const p = room && room.participants.get(pid);
    if (!p || p.socketId !== socket.id) return null;
    return { room, p };
  }

  function bind(socket, room, p) {
    socket.data.roomId = room.id;
    socket.data.pid = p.pid;
    socket.join(room.id);
  }

  function detachSocket(socket) {
    if (!socket) return;
    if (socket.data.roomId) socket.leave(socket.data.roomId);
    socket.data.roomId = null;
    socket.data.pid = null;
  }

  function hostProofFor(room, pid) {
    return room.hostPid === pid && room.hostSince ? tokens.hostProof(room.id, pid, room.hostSince) : null;
  }

  function joinAck(room, p, { resumed }) {
    return {
      ok: true,
      resumed,
      rebuilt: room.rebuilt,
      self: { pid: p.pid, token: tokens.resumeToken(room.id, p.pid), hostProof: hostProofFor(room, p.pid) },
      room: room.snapshotFor(p.pid),
      chat: resumed ? room.chatFor(p.pid) : [],
      transcript: room.transcription ? room.transcript.slice(-300) : [],
      iceServers: buildIceServers(config.ice, { pid: p.pid }),
      iceTransportPolicy: config.ice.forceRelay ? 'relay' : 'all',
      features: clientFeatures(config, ai),
      serverTime: Date.now()
    };
  }

  function setHost(room, pid, since, { announce }) {
    const previous = room.hostPid;
    room.hostPid = pid;
    room.hostSince = since;
    const host = room.participants.get(pid);
    const record = room.attendance.get(pid);
    if (record) record.wasHost = true;
    if (previous !== pid) room.addTimeline('host', { pid, name: host ? host.name : null });
    if (!announce) return;
    io.to(room.id).emit('host-changed', { hostPid: pid });
    if (host) {
      const proof = hostProofFor(room, pid);
      if (proof) emitTo(host, 'host-proof', { proof });
      if (room.waiting.size) emitTo(host, 'waiting-list', { waiting: room.waitingList() });
    }
  }

  // After a restart the first participant back becomes a provisional host.
  // Anyone presenting a newer host proof within the window takes over; after
  // it closes the provisional host keeps the role.
  function scheduleRebuildWindow(room) {
    room.rebuildTimer = setTimeout(() => {
      room.rebuildTimer = null;
      if (registry.get(room.id) !== room || room.hostSince || !room.participants.has(room.hostPid)) return;
      room.hostSince = Date.now();
      emitTo(room.participants.get(room.hostPid), 'host-proof', { proof: hostProofFor(room, room.hostPid) });
    }, config.rooms.rebuildWindowMs);
    room.rebuildTimer.unref?.();
  }

  function createRoom(roomId, now, { rebuilt = false } = {}) {
    const room = registry.create(roomId, now);
    if (rebuilt) {
      room.rebuilt = true;
      scheduleRebuildWindow(room);
      metrics.inc('peerly_rooms_rebuilt_total');
      log.info('rebuilding room after restart', { roomId });
    }
    metrics.inc('peerly_rooms_created_total');
    return room;
  }

  function admit(socket, room, { pid, name, clientId, media, reply, now, resumed, hostProof }) {
    const p = {
      pid,
      name,
      clientId,
      socketId: socket.id,
      lastSocketId: socket.id,
      connected: true,
      graceTimer: null,
      unloading: false,
      joinedAt: now,
      micOn: media.micOn,
      camOn: media.camOn,
      handRaised: false,
      handRaisedAt: 0,
      sharing: false,
      canShare: false,
      recording: false
    };
    room.participants.set(pid, p);
    room.markJoined(p, now);
    bind(socket, room, p);

    let announceHost = false;
    const hostPresent = Boolean(room.hostPid && room.hostPid !== pid && room.participants.has(room.hostPid));
    if (room.rebuilt) {
      const since = hostProof ? tokens.verifyHostProof(room.id, pid, hostProof) : 0;
      if (since && since > room.hostSince) {
        announceHost = hostPresent;
        setHost(room, pid, since, { announce: false });
      } else if (!hostPresent) {
        setHost(room, pid, 0, { announce: false });
      }
    } else if (!hostPresent) {
      setHost(room, pid, now, { announce: false });
    }

    reply(joinAck(room, p, { resumed }));
    socket.to(room.id).emit('peer-joined', { participant: Room.publicParticipant(p), resumed });
    if (announceHost) io.to(room.id).emit('host-changed', { hostPid: room.hostPid });
    metrics.inc('peerly_joins_total', { kind: resumed ? 'resume' : 'fresh' });
    log.info('participant joined', { roomId: room.id, pid, resumed, participants: room.participants.size });
  }

  function resumeSeat(socket, room, p, { fresh, media, reply }) {
    const previous = p.socketId && p.socketId !== socket.id ? io.sockets.sockets.get(p.socketId) : undefined;
    if (previous) {
      // Same seat opened from another tab or a zombie connection: newest wins.
      previous.emit('session-replaced');
      detachSocket(previous);
      previous.disconnect(true);
    }
    clearTimeout(p.graceTimer);
    p.graceTimer = null;
    p.unloading = false;
    p.connected = true;
    p.socketId = socket.id;
    p.lastSocketId = socket.id;
    if (fresh) {
      // A reloaded page starts with new media and isn't presenting any more.
      p.micOn = media.micOn;
      p.camOn = media.camOn;
      p.sharing = false;
      p.recording = false;
    }
    bind(socket, room, p);
    reply(joinAck(room, p, { resumed: true }));
    socket.to(room.id).emit('peer-resumed', { participant: Room.publicParticipant(p), fresh });
    metrics.inc('peerly_joins_total', { kind: 'resume' });
    log.info('participant resumed', { roomId: room.id, pid: p.pid, fresh });
  }

  function knock(socket, room, { name, reply, now }) {
    if (room.waiting.size >= config.rooms.maxWaiting) {
      return reply({ ok: false, code: 'waiting-full', error: 'Too many people are waiting to join. Try again shortly.' });
    }
    if (socket.data.waiting) {
      const previousRoom = registry.get(socket.data.waiting.roomId);
      if (previousRoom) removeWaiting(previousRoom, socket.data.waiting.requestId, null);
    }
    const requestId = randomId(9);
    const entry = { requestId, socketId: socket.id, name, at: now, timer: null };
    entry.timer = setTimeout(() => {
      if (room.waiting.get(requestId) === entry) removeWaiting(room, requestId, { admitted: false, reason: 'timeout' });
    }, config.rooms.knockTimeoutMs);
    entry.timer.unref?.();
    room.waiting.set(requestId, entry);
    socket.data.waiting = { roomId: room.id, requestId };

    const host = room.participants.get(room.hostPid);
    emitTo(host, 'knock', { requestId, name, at: now });
    emitTo(host, 'waiting-list', { waiting: room.waitingList() });
    metrics.inc('peerly_knocks_total');
    reply({ ok: false, waiting: true, requestId, hostConnected: Boolean(host && host.connected) });
  }

  function removeWaiting(room, requestId, result) {
    const entry = room.waiting.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    room.waiting.delete(requestId);
    const socket = io.sockets.sockets.get(entry.socketId);
    if (socket) {
      if (socket.data.waiting && socket.data.waiting.requestId === requestId) socket.data.waiting = null;
      if (result) socket.emit('knock-result', result);
    }
    emitTo(room.participants.get(room.hostPid), 'waiting-list', { waiting: room.waitingList() });
  }

  function issueTicket(room, now) {
    for (const [ticket, expiresAt] of room.tickets) if (expiresAt <= now) room.tickets.delete(ticket);
    const ticket = randomId(18);
    room.tickets.set(ticket, now + TICKET_TTL_MS);
    return ticket;
  }

  function admitWaiting(room, requestId) {
    if (!room.waiting.has(requestId)) return;
    removeWaiting(room, requestId, { admitted: true, ticket: issueTicket(room, Date.now()) });
  }

  function removeParticipant(room, pid, reason) {
    const p = room.participants.get(pid);
    if (!p) return;
    const now = Date.now();
    clearTimeout(p.graceTimer);
    room.participants.delete(pid);
    room.markLeft(pid, now, reason);
    detachSocket(socketOf(p));
    io.to(room.id).emit('peer-left', { pid, reason });
    metrics.inc('peerly_leaves_total', { reason });
    log.info('participant left', { roomId: room.id, pid, reason, participants: room.participants.size });

    if (room.participants.size === 0) {
      closeRoom(room, 'empty');
      return;
    }
    if (room.hostPid === pid) {
      const next = room.pickNextHost();
      setHost(room, next.pid, room.rebuilt && !room.hostSince ? 0 : now, { announce: true });
    }
  }

  function closeRoom(room, reason) {
    if (registry.get(room.id) !== room) return;
    registry.delete(room.id);
    clearTimeout(room.rebuildTimer);
    for (const p of room.participants.values()) clearTimeout(p.graceTimer);
    for (const requestId of [...room.waiting.keys()]) {
      removeWaiting(room, requestId, { admitted: false, reason: 'ended' });
    }
    if (room.reportId) reports.finalize(room, { endedBy: reason === 'ended' ? 'host' : 'everyone-left' });
    metrics.inc('peerly_rooms_closed_total', { reason });
    log.info('room closed', { roomId: room.id, reason, durationMs: Date.now() - room.createdAt });
  }

  function endMeeting(room, by) {
    const now = Date.now();
    room.addTimeline('ended', { pid: by.pid, name: by.name }, now);
    io.to(room.id).emit('meeting-ended', { by: by.name, reportId: room.reportId });
    for (const p of room.participants.values()) {
      clearTimeout(p.graceTimer);
      room.markLeft(p.pid, now, 'ended');
      detachSocket(socketOf(p));
    }
    room.participants.clear();
    closeRoom(room, 'ended');
  }

  function lowerHand(room, target) {
    if (!target.handRaised) return;
    target.handRaised = false;
    target.handRaisedAt = 0;
    emitTo(target, 'hand-lowered', {});
    io.to(room.id).emit('peer-state', Room.stateOf(target));
  }

  function broadcastSettings(room) {
    io.to(room.id).emit('room-settings', room.settings());
  }

  // ---------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------

  function handle(socket, event, { joined = true, host = false } = {}, fn) {
    const [capacity, refill] = EVENT_LIMITS[event];
    const bucket = new TokenBucket(capacity, refill);
    socket.on(event, (...args) => {
      const ack = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      const payload = args[0] && typeof args[0] === 'object' ? args[0] : {};
      const reply = (response) => {
        if (!ack) return;
        try {
          ack(response);
        } catch {
          /* client already gone */
        }
      };

      if (!bucket.take()) {
        metrics.inc('peerly_rate_limited_total', { event });
        return reply(ERR.rateLimited);
      }
      let ctx = null;
      if (joined) {
        ctx = current(socket);
        if (!ctx) return reply(ERR.notJoined);
        if (host && ctx.room.hostPid !== ctx.p.pid) return reply(ERR.hostOnly);
      }
      try {
        const result = fn(payload, reply, ctx);
        if (result && typeof result.then === 'function') {
          result.catch((err) => {
            log.error('socket handler failed', { event, err });
            reply(ERR.internal);
          });
        }
      } catch (err) {
        log.error('socket handler failed', { event, err });
        reply(ERR.internal);
      }
      return undefined;
    });
  }

  function registerHandlers(socket) {
    handle(socket, 'join', { joined: false }, (payload, reply) => {
      if (lifecycle.shuttingDown) {
        return reply({ ok: false, code: 'server-restarting', retry: true, error: 'Peerly is restarting. Reconnecting…' });
      }
      if (payload.v !== PROTOCOL_VERSION) {
        return reply({ ok: false, code: 'upgrade-required', error: 'Peerly was updated. Refresh the page to continue.' });
      }
      if (socket.data.pid) return reply({ ok: false, code: 'already-joined', error: 'You’re already in a meeting.' });

      const { roomId } = payload;
      if (!isRoomId(roomId)) return reply(ERR.invalid('That meeting link isn’t valid.'));
      const name = sanitizeName(payload.name);
      if (!name) return reply({ ok: false, code: 'invalid-name', error: 'Please enter your name.' });
      const clientId = isId(payload.clientId) ? payload.clientId : null;
      const media = { micOn: payload.micOn === true, camOn: payload.camOn === true };
      const now = Date.now();
      const fullError = { ok: false, code: 'full', error: `This meeting is full (max ${config.rooms.maxSize} people).` };

      let room = registry.get(roomId);
      if (room && clientId && room.removedClientIds.has(clientId)) return reply(ERR.removed);

      // A ticket means the host admitted this person from the waiting room.
      let admitted = false;
      if (room && typeof payload.ticket === 'string') {
        const expiresAt = room.tickets.get(payload.ticket);
        if (expiresAt && expiresAt > now) {
          room.tickets.delete(payload.ticket);
          admitted = true;
        }
      }

      // Resume: the same participant on a new connection (network blip,
      // page reload, or a server restart).
      const resume = payload.resume;
      if (resume && isId(resume.pid) && tokens.verifyResumeToken(roomId, resume.pid, resume.token)) {
        const pid = resume.pid;
        if (room && room.removedPids.has(pid)) return reply(ERR.removed);
        const seat = room && room.participants.get(pid);
        if (seat) return resumeSeat(socket, room, seat, { fresh: payload.fresh === true, media, reply });

        let rebuilt = false;
        if (!room) {
          if (registry.size >= config.rooms.maxRooms) return reply(ERR.busy);
          room = createRoom(roomId, now, { rebuilt: true });
          rebuilt = true;
        }
        if (room.participants.size >= config.rooms.maxSize) return reply(fullError);
        if (room.locked && !admitted) return knock(socket, room, { name, reply, now });
        // In a rebuilt room everyone's peer connections survived the restart;
        // otherwise their seat was released and peers already dropped them.
        return admit(socket, room, {
          pid,
          name,
          clientId,
          media,
          reply,
          now,
          resumed: rebuilt || room.rebuilt,
          hostProof: payload.hostProof
        });
      }

      if (room && room.participants.size >= config.rooms.maxSize) return reply(fullError);
      if (room && room.locked && !admitted) return knock(socket, room, { name, reply, now });
      if (!room) {
        if (registry.size >= config.rooms.maxRooms) return reply(ERR.busy);
        room = createRoom(roomId, now);
      }
      return admit(socket, room, { pid: randomId(12), name, clientId, media, reply, now, resumed: false });
    });

    handle(socket, 'cancel-knock', { joined: false }, (payload, reply) => {
      const waiting = socket.data.waiting;
      const room = waiting && registry.get(waiting.roomId);
      if (room) removeWaiting(room, waiting.requestId, null);
      reply({ ok: true });
    });

    handle(socket, 'leave', { joined: false }, (payload, reply) => {
      const ctx = current(socket);
      if (!ctx) return reply({ ok: true });
      if (payload.intent === 'unload') {
        // The page is going away; keep the seat briefly in case it's a reload.
        ctx.p.unloading = true;
        return reply({ ok: true });
      }
      removeParticipant(ctx.room, ctx.p.pid, 'left');
      return reply({ ok: true });
    });

    handle(socket, 'sync', {}, (payload, reply, { room, p }) => {
      reply({ ok: true, room: room.snapshotFor(p.pid) });
    });

    handle(socket, 'signal', {}, (payload, reply, { room, p }) => {
      const { to, sid, data } = payload;
      if (!isId(to) || typeof sid !== 'string' || !sid || sid.length > MAX_SID_LENGTH) return;
      if (!data || typeof data !== 'object') return;
      const target = room.participants.get(to);
      if (!target || target === p) return;
      emitTo(target, 'signal', { from: p.pid, sid, data });
    });

    handle(socket, 'state', {}, (payload, reply, { room, p }) => {
      const now = Date.now();
      let changed = false;
      if (typeof payload.micOn === 'boolean' && payload.micOn !== p.micOn) {
        p.micOn = payload.micOn;
        changed = true;
      }
      if (typeof payload.camOn === 'boolean' && payload.camOn !== p.camOn) {
        p.camOn = payload.camOn;
        changed = true;
      }
      if (typeof payload.handRaised === 'boolean' && payload.handRaised !== p.handRaised) {
        p.handRaised = payload.handRaised;
        p.handRaisedAt = p.handRaised ? now : 0;
        changed = true;
        if (p.handRaised) {
          const record = room.attendance.get(p.pid);
          if (record) record.handRaises += 1;
        }
      }
      if (typeof payload.recording === 'boolean' && payload.recording !== p.recording) {
        p.recording = payload.recording;
        changed = true;
        room.addTimeline(p.recording ? 'recording-start' : 'recording-stop', { pid: p.pid, name: p.name }, now);
      }
      let error = null;
      if (typeof payload.sharing === 'boolean' && payload.sharing !== p.sharing) {
        if (payload.sharing && !room.canPresent(p)) {
          error = { ok: false, code: 'forbidden', error: 'The host needs to allow you to present.' };
        } else {
          p.sharing = payload.sharing;
          changed = true;
          room.addTimeline(p.sharing ? 'share-start' : 'share-stop', { pid: p.pid, name: p.name }, now);
        }
      }
      if (changed) socket.to(room.id).emit('peer-state', Room.stateOf(p));
      reply(error || { ok: true });
    });

    handle(socket, 'view-state', {}, (payload, reply, { room, p }) => {
      const { to, view, source = 'camera' } = payload;
      if (!isId(to) || !VIEWS.includes(view) || !VIDEO_SOURCES.includes(source)) return;
      const target = room.participants.get(to);
      if (target && target !== p) emitTo(target, 'view-state', { from: p.pid, view, source });
    });

    handle(socket, 'chat', {}, (payload, reply, { room, p }) => {
      const text = sanitizeText(payload.text, 2000);
      if (!text) return reply(ERR.invalid('Your message is empty.'));
      const now = Date.now();

      if (payload.to !== undefined && payload.to !== null) {
        if (!room.privateChat && room.hostPid !== p.pid) {
          return reply({ ok: false, code: 'private-chat-off', error: 'The host turned off private messages.' });
        }
        const target = isId(payload.to) ? room.participants.get(payload.to) : null;
        if (!target || target === p) return reply(ERR.gone);
        const message = { id: room.nextId(), from: p.pid, name: p.name, to: target.pid, toName: target.name, text, ts: now };
        room.pushChat(message);
        socket.emit('chat', message);
        emitTo(target, 'chat', message);
        return reply({ ok: true, id: message.id });
      }

      const message = { id: room.nextId(), from: p.pid, name: p.name, text, ts: now };
      room.pushChat(message);
      const record = room.attendance.get(p.pid);
      if (record) record.messages += 1;
      io.to(room.id).emit('chat', message);
      return reply({ ok: true, id: message.id });
    });

    handle(socket, 'reaction', {}, (payload, reply, { room, p }) => {
      if (!REACTIONS.includes(payload.emoji)) return reply(ERR.invalid('Unsupported reaction.'));
      const now = Date.now();
      room.recordReaction(p.pid, payload.emoji, now);
      socket.to(room.id).emit('reaction', { pid: p.pid, name: p.name, emoji: payload.emoji, ts: now });
      return reply({ ok: true });
    });

    handle(socket, 'caption', {}, (payload, reply, { room, p }) => {
      if (!room.transcription) return reply({ ok: false, code: 'transcription-off', error: 'Transcription is off.' });
      const text = sanitizeLine(payload.text, 1000);
      if (!text) return reply({ ok: true });
      const now = Date.now();
      if (payload.final !== true) {
        // Live partial results are best-effort; drop them under backpressure.
        socket.to(room.id).volatile.emit('caption', { pid: p.pid, name: p.name, text, final: false, ts: now });
        return reply({ ok: true });
      }
      const segment = room.appendTranscript({ pid: p.pid, name: p.name, text, ts: now });
      if (!segment) {
        return reply({ ok: false, code: 'transcript-full', error: 'The transcript reached its size limit.' });
      }
      io.to(room.id).emit('caption', { ...segment, final: true });
      return reply({ ok: true, id: segment.id });
    });

    handle(socket, 'stats', {}, (payload, reply, { room, p }) => {
      const talkMs = Number(payload.talkMs);
      if (!Number.isFinite(talkMs)) return;
      const record = room.attendance.get(p.pid);
      if (record) record.talkMs += Math.min(Math.max(Math.round(talkMs), 0), 20000);
    });

    handle(socket, 'share-request', {}, (payload, reply, { room, p }) => {
      if (room.canPresent(p)) {
        emitTo(p, 'share-permission', { allowed: true });
        return reply({ ok: true, allowed: true });
      }
      const host = room.participants.get(room.hostPid);
      if (!host || !host.connected) return reply(ERR.noHost);
      emitTo(host, 'share-request', { pid: p.pid, name: p.name });
      return reply({ ok: true, pending: true });
    });

    handle(socket, 'set-share-permission', { host: true }, (payload, reply, { room }) => {
      const target = isId(payload.pid) ? room.participants.get(payload.pid) : null;
      if (!target || typeof payload.allowed !== 'boolean') return reply(ERR.gone);
      target.canShare = payload.allowed;
      if (!payload.allowed && target.sharing && !room.canPresent(target)) {
        target.sharing = false;
        room.addTimeline('share-stop', { pid: target.pid, name: target.name });
      }
      emitTo(target, 'share-permission', { allowed: payload.allowed });
      io.to(room.id).emit('peer-state', Room.stateOf(target));
      return reply({ ok: true });
    });

    handle(socket, 'transfer-host', { host: true }, (payload, reply, { room, p }) => {
      const target = isId(payload.pid) ? room.participants.get(payload.pid) : null;
      if (!target || target === p) return reply(ERR.gone);
      setHost(room, target.pid, Date.now(), { announce: true });
      return reply({ ok: true });
    });

    handle(socket, 'host-action', { host: true }, (payload, reply, { room, p }) => {
      const target = isId(payload.pid) ? room.participants.get(payload.pid) : null;
      switch (payload.action) {
        case 'mute':
          if (!target || target === p) return reply(ERR.gone);
          emitTo(target, 'force-mute', { by: p.name });
          break;
        case 'mute-all':
          for (const other of room.participants.values()) if (other !== p) emitTo(other, 'force-mute', { by: p.name });
          break;
        case 'stop-video':
          if (!target || target === p) return reply(ERR.gone);
          emitTo(target, 'force-camera-off', { by: p.name });
          break;
        case 'lower-hand':
          if (!target) return reply(ERR.gone);
          lowerHand(room, target);
          break;
        case 'lower-all-hands':
          for (const other of room.participants.values()) lowerHand(room, other);
          break;
        case 'remove':
          if (!target || target === p) return reply(ERR.gone);
          if (target.clientId) room.removedClientIds.add(target.clientId);
          room.removedPids.add(target.pid);
          emitTo(target, 'removed', { by: p.name });
          removeParticipant(room, target.pid, 'removed');
          break;
        case 'lock':
        case 'unlock':
          room.locked = payload.action === 'lock';
          broadcastSettings(room);
          // Opening the meeting lets everyone who was waiting straight in.
          if (!room.locked) for (const requestId of [...room.waiting.keys()]) admitWaiting(room, requestId);
          break;
        case 'settings':
          if (typeof payload.privateChat === 'boolean') room.privateChat = payload.privateChat;
          if (typeof payload.shareRequiresApproval === 'boolean') room.shareRequiresApproval = payload.shareRequiresApproval;
          broadcastSettings(room);
          break;
        case 'end-meeting':
          endMeeting(room, p);
          break;
        default:
          return reply(ERR.invalid('Unknown action.'));
      }
      return reply({ ok: true });
    });

    handle(socket, 'knock-response', { host: true }, (payload, reply, { room }) => {
      const requestIds = payload.all === true ? [...room.waiting.keys()] : [payload.requestId];
      for (const requestId of requestIds) {
        if (typeof requestId !== 'string' || !room.waiting.has(requestId)) continue;
        if (payload.admit === true) admitWaiting(room, requestId);
        else removeWaiting(room, requestId, { admitted: false, reason: 'denied' });
      }
      reply({ ok: true });
    });

    handle(socket, 'transcription', { host: true }, (payload, reply, { room, p }) => {
      const now = Date.now();
      if (payload.on === true) {
        const lang = isLang(payload.lang) ? payload.lang : room.transcriptLang || 'en-US';
        if (!room.transcription) {
          room.transcription = { lang, startedAt: now, startedBy: p.name };
          if (!room.reportId) room.reportId = reports.create(room.id, now);
          room.addTimeline('transcription-on', { pid: p.pid, name: p.name }, now);
        } else {
          room.transcription.lang = lang;
        }
        room.transcriptLang = lang;
      } else if (payload.on === false) {
        if (room.transcription) {
          room.transcription = null;
          room.addTimeline('transcription-off', { pid: p.pid, name: p.name }, now);
        }
      } else {
        return reply(ERR.invalid('Say whether transcription should be on or off.'));
      }
      const state = room.transcriptionState();
      io.to(room.id).emit('transcription-state', state);
      return reply({ ok: true, state });
    });

    handle(socket, 'transcription-request', {}, (payload, reply, { room, p }) => {
      if (room.transcription) return reply({ ok: true, alreadyOn: true });
      if (room.hostPid === p.pid) return reply(ERR.invalid('You’re the host. Start transcription from the notes panel.'));
      const host = room.participants.get(room.hostPid);
      if (!host || !host.connected) return reply(ERR.noHost);
      emitTo(host, 'transcription-request', { pid: p.pid, name: p.name });
      return reply({ ok: true });
    });

    handle(socket, 'catch-up', {}, async (payload, reply, { room, p }) => {
      if (!ai.enabled) return reply({ ok: false, code: 'ai-disabled', error: 'AI features aren’t set up on this server.' });
      if (!room.transcript.length) {
        return reply({
          ok: false,
          code: 'empty',
          error: room.transcription
            ? 'Nothing has been transcribed yet. Try again once people have talked for a bit.'
            : 'Catch me up needs transcription. Ask the host to turn it on.'
        });
      }
      const lastSegmentId = room.transcript[room.transcript.length - 1].id;
      const toReply = (result, cached) =>
        result.ok
          ? { ok: true, recap: result.data, partial: Boolean(result.partial), generatedAt: result.generatedAt, cached }
          : { ok: false, code: result.code, error: result.error };

      // Nothing new was said since the last recap: reuse it.
      if (room.recap && room.recap.lastSegmentId === lastSegmentId) return reply(toReply(room.recap.result, true));
      // Someone else already asked: share the in-flight request.
      if (room.recapPromise) return reply(toReply(await room.recapPromise, false));

      if (!recapByParticipant.take(`${room.id}:${p.pid}`)) {
        return reply({ ok: false, code: 'rate-limited', error: 'You just asked for a recap. Try again in a few seconds.' });
      }
      if (!recapByRoom.take(room.id)) {
        return reply({ ok: false, code: 'rate-limited', error: 'This meeting has used its recaps for now. Try again later.' });
      }

      room.recapPromise = ai
        .catchUp(room.aiInput(Date.now()))
        .then((result) => (result.ok ? { ...result, generatedAt: Date.now() } : result))
        .finally(() => {
          room.recapPromise = null;
        });
      const result = await room.recapPromise;
      if (result.ok) room.recap = { lastSegmentId, result };
      return reply(toReply(result, false));
    });

    socket.on('disconnect', (reason) => {
      if (socket.data.waiting) {
        const room = registry.get(socket.data.waiting.roomId);
        if (room) removeWaiting(room, socket.data.waiting.requestId, null);
      }
      const ctx = current(socket);
      if (!ctx) return;
      const { room, p } = ctx;
      p.connected = false;
      p.socketId = null;
      // During a deploy everyone reconnects to the next instance.
      if (lifecycle.shuttingDown) return;

      const graceMs = p.unloading ? config.rooms.unloadGraceMs : config.rooms.reconnectGraceMs;
      if (!p.unloading) io.to(room.id).emit('peer-reconnecting', { pid: p.pid });
      p.graceTimer = setTimeout(() => {
        p.graceTimer = null;
        if (room.participants.get(p.pid) === p && !p.connected) {
          removeParticipant(room, p.pid, p.unloading ? 'left' : 'timeout');
        }
      }, graceMs);
      p.graceTimer.unref?.();
      log.debug('participant disconnected', { roomId: room.id, pid: p.pid, reason, graceMs });
    });
  }

  io.use((socket, next) => {
    const ip = clientIp(socket.request, config.trustProxy);
    const count = ipConnections.get(ip) || 0;
    if (count >= config.maxConnectionsPerIp) {
      metrics.inc('peerly_connections_rejected_total', { reason: 'ip-limit' });
      return next(new Error('Too many connections from your network.'));
    }
    ipConnections.set(ip, count + 1);
    socket.data.ip = ip;
    socket.once('disconnect', () => {
      const remaining = (ipConnections.get(ip) || 1) - 1;
      if (remaining <= 0) ipConnections.delete(ip);
      else ipConnections.set(ip, remaining);
    });
    return next();
  });

  io.on('connection', (socket) => {
    metrics.inc('peerly_connections_total');
    registerHandlers(socket);
  });

  const maintenance = setInterval(() => {
    const now = Date.now();
    recapByParticipant.prune(now);
    recapByRoom.prune(now);
    reports.sweep(now);
    for (const room of registry.values()) {
      for (const [ticket, expiresAt] of room.tickets) if (expiresAt <= now) room.tickets.delete(ticket);
    }
  }, 60000);
  maintenance.unref?.();

  /**
   * navigator.sendBeacon() fallback for "the tab is closing": shortens the
   * grace period so others don't see a stale "reconnecting" tile for long.
   */
  function beaconLeave({ roomId, pid, token, socketId }) {
    if (!isRoomId(roomId) || !isId(pid) || !tokens.verifyResumeToken(roomId, pid, token)) return false;
    const room = registry.get(roomId);
    const p = room && room.participants.get(pid);
    // Ignore beacons from an older page if the seat was already resumed.
    if (!p || (typeof socketId === 'string' && socketId !== p.lastSocketId)) return true;
    p.unloading = true;
    if (!p.connected && p.graceTimer) {
      clearTimeout(p.graceTimer);
      p.graceTimer = setTimeout(() => {
        p.graceTimer = null;
        if (room.participants.get(pid) === p && !p.connected) removeParticipant(room, pid, 'left');
      }, config.rooms.unloadGraceMs);
      p.graceTimer.unref?.();
    }
    return true;
  }

  function stop() {
    clearInterval(maintenance);
    for (const room of registry.values()) {
      clearTimeout(room.rebuildTimer);
      for (const p of room.participants.values()) clearTimeout(p.graceTimer);
      for (const entry of room.waiting.values()) clearTimeout(entry.timer);
    }
  }

  return { beaconLeave, stop, connectionsByIp: ipConnections };
}

module.exports = { createSignaling, clientIp, isOriginAllowed, EVENT_LIMITS };

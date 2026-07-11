const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 64 * 1024,
  // Detect dropped connections quickly so host failover is fast.
  pingInterval: 10000,
  pingTimeout: 5000
});

const PORT = process.env.PORT || 4800;
const MAX_ROOM_SIZE = parseInt(process.env.MAX_ROOM_SIZE || '8', 10);

// rooms: Map<roomId, { participants: Map<socketId, participant>, hostId }>
// participant: { name, micOn, camOn, handRaised, sharing, canShare, joinedAt }
const rooms = new Map();

app.use(express.static(path.join(__dirname, 'public')));

function generateRoomId() {
  const letters = 'abcdefghijkmnpqrstuvwxyz';
  const part = (len) =>
    Array.from(crypto.randomBytes(len), (b) => letters[b % letters.length]).join('');
  return `${part(3)}-${part(4)}-${part(3)}`;
}

const ROOM_ID_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

function sanitizeName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().slice(0, 30);
  return name.length > 0 ? name : null;
}

// ---------- REST API ----------

app.get('/api/new-room', (req, res) => {
  let roomId = generateRoomId();
  while (rooms.has(roomId)) roomId = generateRoomId();
  res.json({ roomId });
});

app.get('/api/room/:id', (req, res) => {
  const roomId = req.params.id;
  if (!ROOM_ID_RE.test(roomId)) {
    return res.status(400).json({ valid: false });
  }
  const room = rooms.get(roomId);
  const count = room ? room.participants.size : 0;
  res.json({ valid: true, count, full: count >= MAX_ROOM_SIZE, max: MAX_ROOM_SIZE });
});

// ICE servers: Google STUN by default, TURN from env when configured.
app.get('/api/ice-config', (req, res) => {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(',').map((u) => u.trim()),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    });
  }
  res.json({ iceServers });
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/room/:id', (req, res) => {
  if (!ROOM_ID_RE.test(req.params.id)) {
    return res.redirect('/?error=invalid-room');
  }
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

// ---------- Socket.IO signaling ----------

function participantsOf(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.participants.entries()).map(([id, p]) => ({
    id,
    name: p.name,
    micOn: p.micOn,
    camOn: p.camOn,
    handRaised: p.handRaised,
    sharing: p.sharing,
    canShare: p.canShare
  }));
}

function broadcastPeerState(roomId, id) {
  const room = rooms.get(roomId);
  const p = room && room.participants.get(id);
  if (!p) return;
  io.to(roomId).emit('peer-state', {
    id,
    micOn: p.micOn,
    camOn: p.camOn,
    handRaised: p.handRaised,
    sharing: p.sharing,
    canShare: p.canShare
  });
}

io.on('connection', (socket) => {
  let joinedRoomId = null;

  socket.on('join', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const roomId = payload && payload.roomId;
    const name = sanitizeName(payload && payload.name);
    if (!ROOM_ID_RE.test(roomId || '') || !name) {
      return ack({ error: 'Invalid room or name.' });
    }
    if (joinedRoomId) {
      return ack({ error: 'Already in a room.' });
    }
    let room = rooms.get(roomId);
    if (room && room.participants.size >= MAX_ROOM_SIZE) {
      return ack({ error: `This room is full (max ${MAX_ROOM_SIZE} participants).` });
    }
    if (!room) {
      // First person in becomes the host.
      room = { participants: new Map(), hostId: socket.id };
      rooms.set(roomId, room);
    }
    const participant = {
      name,
      micOn: !!(payload && payload.micOn),
      camOn: !!(payload && payload.camOn),
      handRaised: false,
      sharing: false,
      canShare: false,
      joinedAt: Date.now()
    };
    room.participants.set(socket.id, participant);
    joinedRoomId = roomId;
    socket.join(roomId);

    const peers = participantsOf(roomId).filter((p) => p.id !== socket.id);
    ack({ selfId: socket.id, peers, hostId: room.hostId });
    socket.to(roomId).emit('peer-joined', {
      id: socket.id,
      name: participant.name,
      micOn: participant.micOn,
      camOn: participant.camOn,
      handRaised: false,
      sharing: false,
      canShare: false
    });
  });

  // Relay WebRTC offers/answers/ICE candidates between two peers.
  socket.on('signal', ({ to, data } = {}) => {
    if (!joinedRoomId || typeof to !== 'string' || !data) return;
    const room = rooms.get(joinedRoomId);
    if (!room || !room.participants.has(to)) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('chat', (text) => {
    if (!joinedRoomId || typeof text !== 'string') return;
    const trimmed = text.trim().slice(0, 2000);
    if (!trimmed) return;
    const room = rooms.get(joinedRoomId);
    const p = room && room.participants.get(socket.id);
    if (!p) return;
    io.to(joinedRoomId).emit('chat', {
      from: socket.id,
      name: p.name,
      text: trimmed,
      ts: Date.now()
    });
  });

  socket.on('state', (state = {}) => {
    if (!joinedRoomId) return;
    const room = rooms.get(joinedRoomId);
    const p = room && room.participants.get(socket.id);
    if (!p) return;
    if (typeof state.micOn === 'boolean') p.micOn = state.micOn;
    if (typeof state.camOn === 'boolean') p.camOn = state.camOn;
    if (typeof state.handRaised === 'boolean') p.handRaised = state.handRaised;
    if (typeof state.sharing === 'boolean') p.sharing = state.sharing;
    socket.to(joinedRoomId).emit('peer-state', {
      id: socket.id,
      micOn: p.micOn,
      camOn: p.camOn,
      handRaised: p.handRaised,
      sharing: p.sharing,
      canShare: p.canShare
    });
  });

  // A participant asks the host for permission to share their screen.
  socket.on('share-request', () => {
    if (!joinedRoomId) return;
    const room = rooms.get(joinedRoomId);
    const p = room && room.participants.get(socket.id);
    if (!p) return;
    if (p.canShare || room.hostId === socket.id) {
      // Already allowed - just confirm.
      p.canShare = true;
      socket.emit('share-permission', { allowed: true });
      return;
    }
    if (!room.participants.has(room.hostId)) return;
    io.to(room.hostId).emit('share-request', { id: socket.id, name: p.name });
  });

  // Host grants or revokes screen-share permission for a participant.
  socket.on('set-share-permission', ({ id, allowed } = {}) => {
    if (!joinedRoomId) return;
    const room = rooms.get(joinedRoomId);
    if (!room || room.hostId !== socket.id) return;
    const target = room.participants.get(id);
    if (!target || typeof allowed !== 'boolean') return;
    target.canShare = allowed;
    io.to(id).emit('share-permission', { allowed });
    broadcastPeerState(joinedRoomId, id);
  });

  // A viewer tells a sender how prominently they are displayed (focused
  // tile, normal grid cell, or filmstrip thumbnail) so the sender can
  // scale its outgoing video for that specific connection.
  socket.on('view-state', ({ to, view } = {}) => {
    if (!joinedRoomId || typeof to !== 'string') return;
    if (!['focused', 'normal', 'thumb'].includes(view)) return;
    const room = rooms.get(joinedRoomId);
    if (!room || !room.participants.has(to)) return;
    io.to(to).emit('view-state', { from: socket.id, view });
  });

  // Host hands the host role to another participant.
  socket.on('transfer-host', ({ id } = {}) => {
    if (!joinedRoomId) return;
    const room = rooms.get(joinedRoomId);
    if (!room || room.hostId !== socket.id) return;
    if (!room.participants.has(id)) return;
    room.hostId = id;
    io.to(joinedRoomId).emit('host-changed', { hostId: id });
  });

  function leaveRoom() {
    if (!joinedRoomId) return;
    const roomId = joinedRoomId;
    joinedRoomId = null;
    const room = rooms.get(roomId);
    if (room) {
      const wasHost = room.hostId === socket.id;
      room.participants.delete(socket.id);
      if (room.participants.size === 0) {
        rooms.delete(roomId);
      } else {
        socket.to(roomId).emit('peer-left', { id: socket.id });
        if (wasHost) {
          // Promote the longest-present participant (covers host leaving
          // on purpose and host dropping from a dead connection alike).
          let nextId = null;
          let earliest = Infinity;
          room.participants.forEach((p, id) => {
            if (p.joinedAt < earliest) {
              earliest = p.joinedAt;
              nextId = id;
            }
          });
          room.hostId = nextId;
          io.to(roomId).emit('host-changed', { hostId: nextId });
        }
      }
    }
    socket.leave(roomId);
  }

  socket.on('leave', leaveRoom);
  socket.on('disconnect', leaveRoom);
});

server.listen(PORT, () => {
  console.log(`Peerly running on http://localhost:${PORT}`);
});

'use strict';

const { countWords } = require('./validate');

const TIMELINE_LIMIT = 2000;
const REACTION_LOG_LIMIT = 5000;

/**
 * In-memory state for one meeting. Pure data + bookkeeping; all socket I/O
 * lives in signaling.js so this stays easy to reason about and test.
 */
class Room {
  constructor(id, { now = Date.now(), limits }) {
    this.id = id;
    this.createdAt = now;
    this.limits = limits;

    /** @type {Map<string, object>} pid -> participant */
    this.participants = new Map();
    this.hostPid = null;
    // When the current host became host. 0 means a provisional host picked
    // while a room is being rebuilt after a server restart.
    this.hostSince = 0;
    this.rebuilt = false;
    this.rebuildTimer = null;

    this.locked = false;
    this.privateChat = true;
    this.shareRequiresApproval = true;

    this.removedClientIds = new Set();
    this.removedPids = new Set();
    this.waiting = new Map(); // requestId -> { requestId, socketId, name, at, timer }
    this.tickets = new Map(); // ticket -> expiresAt

    this.seq = 0;
    this.chat = [];

    this.transcription = null; // { lang, startedAt, startedBy }
    this.transcriptLang = null; // last language used, kept after transcription stops
    this.reportId = null;
    this.transcript = [];
    this.transcriptChars = 0;
    this.transcriptTruncated = false;
    this.recap = null;
    this.recapPromise = null;

    this.timeline = [];
    this.attendance = new Map(); // pid -> attendance record (kept after they leave)
    this.reactionTotals = {};
    this.reactionLog = [];
  }

  nextId() {
    this.seq += 1;
    return this.seq;
  }

  settings() {
    return {
      locked: this.locked,
      privateChat: this.privateChat,
      shareRequiresApproval: this.shareRequiresApproval
    };
  }

  static publicParticipant(p) {
    return {
      pid: p.pid,
      name: p.name,
      micOn: p.micOn,
      camOn: p.camOn,
      handRaised: p.handRaised,
      handRaisedAt: p.handRaisedAt,
      sharing: p.sharing,
      canShare: p.canShare,
      recording: p.recording,
      connected: p.connected,
      joinedAt: p.joinedAt
    };
  }

  static stateOf(p) {
    return {
      pid: p.pid,
      micOn: p.micOn,
      camOn: p.camOn,
      handRaised: p.handRaised,
      handRaisedAt: p.handRaisedAt,
      sharing: p.sharing,
      canShare: p.canShare,
      recording: p.recording
    };
  }

  canPresent(p) {
    return !this.shareRequiresApproval || this.hostPid === p.pid || p.canShare;
  }

  transcriptionState() {
    return this.transcription
      ? { on: true, reportId: this.reportId, ...this.transcription }
      : { on: false, reportId: this.reportId };
  }

  waitingList() {
    return [...this.waiting.values()].map(({ requestId, name, at }) => ({ requestId, name, at }));
  }

  snapshotFor(pid) {
    return {
      id: this.id,
      startedAt: this.createdAt,
      hostPid: this.hostPid,
      settings: this.settings(),
      participants: [...this.participants.values()].map(Room.publicParticipant),
      transcription: this.transcriptionState(),
      waiting: pid === this.hostPid ? this.waitingList() : []
    };
  }

  // Longest-present connected participant; falls back to anyone left.
  pickNextHost() {
    let best = null;
    for (const p of this.participants.values()) {
      if (!best) best = p;
      else if (p.connected !== best.connected) best = p.connected ? p : best;
      else if (p.joinedAt < best.joinedAt) best = p;
    }
    return best;
  }

  // ---- chat ----
  pushChat(message) {
    if (this.limits.chatHistory === 0) return;
    this.chat.push(message);
    if (this.chat.length > this.limits.chatHistory) this.chat.splice(0, this.chat.length - this.limits.chatHistory);
  }

  // What a participant is allowed to see: public messages plus their own DMs.
  chatFor(pid) {
    return this.chat.filter((m) => !m.to || m.from === pid || m.to === pid);
  }

  // ---- transcript ----
  appendTranscript({ pid, name, text, ts }) {
    if (this.transcriptChars + text.length > this.limits.transcriptMaxChars) {
      this.transcriptTruncated = true;
      return null;
    }
    const segment = { id: this.nextId(), pid, name, text, ts };
    // Server transcription can finish after later lines: keep spoken order.
    let at = this.transcript.length;
    while (at > 0 && this.transcript[at - 1].ts > ts) at -= 1;
    this.transcript.splice(at, 0, segment);
    this.lastTranscriptId = segment.id;
    this.transcriptChars += text.length;
    const record = this.attendance.get(pid);
    if (record) {
      record.words += countWords(text);
      record.segments += 1;
    }
    return segment;
  }

  /** The seat held by this browser (clientId is shared by its tabs and windows). */
  seatForClient(clientId) {
    if (!clientId) return null;
    for (const p of this.participants.values()) if (p.clientId === clientId) return p;
    return null;
  }

  rename(p, name) {
    p.name = name;
    const record = this.attendance.get(p.pid);
    if (record) record.name = name;
  }

  // ---- attendance / timeline ----
  markJoined(p, now) {
    let record = this.attendance.get(p.pid);
    if (!record) {
      record = {
        pid: p.pid,
        name: p.name,
        firstJoinedAt: now,
        sessions: [],
        talkMs: 0,
        words: 0,
        segments: 0,
        messages: 0,
        reactions: 0,
        handRaises: 0,
        wasHost: false
      };
      this.attendance.set(p.pid, record);
    }
    record.name = p.name;
    const open = record.sessions[record.sessions.length - 1];
    if (!open || open[1] !== null) record.sessions.push([now, null]);
    this.addTimeline('join', { pid: p.pid, name: p.name }, now);
  }

  markLeft(pid, now, reason = 'left') {
    const record = this.attendance.get(pid);
    if (!record) return;
    const open = record.sessions[record.sessions.length - 1];
    if (open && open[1] === null) open[1] = now;
    this.addTimeline('leave', { pid, name: record.name, reason }, now);
  }

  addTimeline(type, fields = {}, now = Date.now()) {
    this.timeline.push({ ts: now, type, ...fields });
    if (this.timeline.length > TIMELINE_LIMIT) this.timeline.splice(0, this.timeline.length - TIMELINE_LIMIT);
  }

  recordReaction(pid, emoji, now) {
    this.reactionTotals[emoji] = (this.reactionTotals[emoji] || 0) + 1;
    this.reactionLog.push({ ts: now, pid, emoji });
    if (this.reactionLog.length > REACTION_LOG_LIMIT) this.reactionLog.splice(0, this.reactionLog.length - REACTION_LOG_LIMIT);
    const record = this.attendance.get(pid);
    if (record) record.reactions += 1;
  }

  // Structured input for AI summaries (public information only: no DMs).
  aiInput(now = Date.now()) {
    return {
      meeting: {
        roomId: this.id,
        startedAt: this.createdAt,
        now,
        language: this.transcriptLang,
        transcriptTruncated: this.transcriptTruncated
      },
      participants: [...this.attendance.values()].map((r) => ({
        name: r.name,
        isHost: r.pid === this.hostPid || r.wasHost,
        words: r.words
      })),
      transcript: this.transcript,
      chat: this.chat.filter((m) => !m.to)
    };
  }
}

class RoomRegistry {
  constructor(limits) {
    this.limits = limits;
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
  }

  get size() {
    return this.rooms.size;
  }

  get(id) {
    return this.rooms.get(id);
  }

  create(id, now = Date.now()) {
    const room = new Room(id, { now, limits: this.limits });
    this.rooms.set(id, room);
    return room;
  }

  delete(id) {
    this.rooms.delete(id);
  }

  values() {
    return this.rooms.values();
  }

  participantCount() {
    let total = 0;
    for (const room of this.rooms.values()) total += room.participants.size;
    return total;
  }
}

module.exports = { Room, RoomRegistry };

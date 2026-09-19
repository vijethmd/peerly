// Call controller: owns the signaling session (join, resume, reconcile) and
// turns server events into state the UI modules render.

import { Emitter } from './ui.js';
import { Connection } from './connection.js';
import { PeerManager } from './peers.js';
import { saveSession, clearSession, loadSession, getClientId } from './session.js';

const PROTOCOL_VERSION = 2;
const REBUILD_REMOVAL_MS = 40000;
const SYNC_INTERVAL_MS = 60000;

export class CallController extends Emitter {
  constructor({ roomId, media, features }) {
    super();
    this.roomId = roomId;
    this.media = media;
    this.features = features || {};
    this.clientId = getClientId();

    this.phase = 'idle'; // idle | joining | waiting | call | ended
    this.connectionState = 'idle'; // connecting | online | reconnecting | offline
    this.name = '';
    this.self = { pid: null, token: null, hostProof: null };
    this.hostPid = null;
    this.settings = { locked: false, privateChat: true, shareRequiresApproval: true };
    this.participants = new Map(); // remote participants
    this.transcription = { on: false, reportId: null, lang: null, startedBy: null };
    this.waiting = [];
    this.handRaised = false;
    this.handRaisedAt = 0;
    this.canShare = false;
    this.recording = false;
    this.iceServers = [];
    this.iceTransportPolicy = 'all';
    this.startedAt = 0;
    this.joinedAt = 0;
    this.hasJoinedOnce = false;
    this.pendingTicket = null;
    this.joinAttempts = 0;
    this.pendingRemovals = new Map();

    this.peers = new PeerManager({
      signal: (message) => this.conn?.send('signal', message),
      getTracks: () => this.media.tracks(),
      getRtcConfig: () => ({
        iceServers: this.iceServers,
        iceTransportPolicy: this.iceTransportPolicy,
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require'
      }),
      isConnected: (pid) => Boolean(this.participants.get(pid)?.connected),
      expectsVideo: (pid, source) => {
        const participant = this.participants.get(pid);
        if (!participant) return false;
        return source === 'screen' ? Boolean(participant.sharing) : Boolean(participant.camOn);
      },
      canSignal: () => Boolean(this.conn?.connected)
    });

    this.media.addEventListener('tracks', (event) => {
      const tracks = this.media.tracks();
      for (const kind of event.detail.kinds) this.peers.replaceTrack(kind, tracks[kind] || null);
    });
    this.media.addEventListener('screen-ended', () => {
      if (this.phase === 'call') this.conn?.send('state', { sharing: false });
      this.emit('self-updated');
    });
    // Keep the saved mic/camera state current, so a reload or "Use here"
    // comes back the way you were.
    this.media.addEventListener('state', () => {
      if (this.phase === 'call') this.persistSession();
    });

    window.addEventListener('online', () => this.conn?.reconnect());
    window.addEventListener('offline', () => this.setConnectionState('offline'));
    window.addEventListener('pagehide', () => this.onPageHide());
  }

  // ------------------------------------------------------------- accessors
  isHost() {
    return Boolean(this.self.pid) && this.self.pid === this.hostPid;
  }

  canPresent() {
    return !this.settings.shareRequiresApproval || this.isHost() || this.canShare;
  }

  selfParticipant() {
    return {
      pid: this.self.pid,
      name: this.name,
      micOn: this.media.micOn,
      camOn: this.media.camOn,
      handRaised: this.handRaised,
      handRaisedAt: this.handRaisedAt,
      sharing: this.media.sharing,
      canShare: this.canShare,
      recording: this.recording,
      connected: true,
      joinedAt: this.joinedAt,
      isSelf: true
    };
  }

  participant(pid) {
    return pid === this.self.pid ? this.selfParticipant() : this.participants.get(pid);
  }

  allParticipants() {
    return [this.selfParticipant(), ...this.participants.values()];
  }

  handQueue() {
    return this.allParticipants()
      .filter((p) => p.handRaised)
      .sort((a, b) => (a.handRaisedAt || 0) - (b.handRaisedAt || 0))
      .map((p) => p.pid);
  }

  setPhase(phase) {
    if (this.phase === phase) return;
    this.phase = phase;
    this.emit('phase', phase);
  }

  setConnectionState(state) {
    if (this.connectionState === state) return;
    this.connectionState = state;
    this.emit('connection', state);
  }

  persistSession() {
    if (!this.self.pid) return;
    saveSession(this.roomId, {
      pid: this.self.pid,
      token: this.self.token,
      hostProof: this.self.hostProof,
      name: this.name,
      inCall: this.phase === 'call' || this.phase === 'joining',
      reportId: this.transcription.reportId || null,
      micOn: this.media.micOn,
      camOn: this.media.camOn
    });
  }

  // ------------------------------------------------------------------ join
  start({ name, ticket = null }) {
    this.name = name;
    this.pendingTicket = ticket;
    const stored = loadSession(this.roomId);
    if (stored && stored.pid && stored.token) {
      this.self = { pid: stored.pid, token: stored.token, hostProof: stored.hostProof || null };
    }
    this.setPhase('joining');
    this.setConnectionState('connecting');
    this.conn = new Connection({
      onConnect: () => this.sendJoin(),
      onDisconnect: (reason) => this.onDisconnect(reason),
      onConnectError: () => this.onConnectError(),
      onEvent: (event, payload) => this.onEvent(event, payload)
    });
    this.conn.open();
  }

  async sendJoin() {
    if (this.phase === 'ended') return;
    const payload = {
      v: PROTOCOL_VERSION,
      roomId: this.roomId,
      name: this.name,
      clientId: this.clientId,
      micOn: this.media.micOn,
      camOn: this.media.camOn,
      // "fresh" means this page has no peer connections yet, so peers must
      // rebuild theirs (a reload); a socket blip keeps media flowing.
      fresh: !this.hasJoinedOnce
    };
    if (this.self.pid && this.self.token) {
      payload.resume = { pid: this.self.pid, token: this.self.token };
      if (this.self.hostProof) payload.hostProof = this.self.hostProof;
    }
    if (this.pendingTicket) {
      payload.ticket = this.pendingTicket;
      this.pendingTicket = null;
    }
    const result = await this.conn.request('join', payload, 12000);
    this.handleJoinResult(result);
  }

  handleJoinResult(result) {
    if (this.phase === 'ended') return;
    if (result.ok) {
      this.joinAttempts = 0;
      this.applyJoin(result);
      return;
    }
    if (result.waiting) {
      this.knockRequestId = result.requestId;
      this.setPhase('waiting');
      this.emit('waiting-state', result);
      return;
    }
    switch (result.code) {
      case 'upgrade-required':
        this.emit('upgrade-required');
        this.conn?.close();
        return;
      case 'removed':
        this.end('removed');
        return;
      case 'server-restarting':
      case 'timeout':
      case 'offline':
      case 'rate-limited':
      case 'internal':
        this.retryJoin();
        return;
      default:
        if (this.hasJoinedOnce) this.end('error', { message: result.error });
        else {
          this.emit('join-error', result);
          this.conn?.close();
          this.conn = null;
          this.setPhase('idle');
        }
    }
  }

  retryJoin() {
    this.joinAttempts += 1;
    const delay = Math.min(8000, 800 * 2 ** (this.joinAttempts - 1));
    clearTimeout(this.joinRetryTimer);
    this.joinRetryTimer = setTimeout(() => {
      if (this.phase !== 'ended' && this.conn?.connected) this.sendJoin();
    }, delay);
  }

  applyJoin(result) {
    const firstTime = !this.hasJoinedOnce;
    this.self = {
      pid: result.self.pid,
      token: result.self.token,
      hostProof: result.self.hostProof || this.self.hostProof
    };
    this.peers.selfPid = this.self.pid;
    this.features = { ...this.features, ...result.features };
    if (result.iceServers) this.iceServers = result.iceServers;
    this.iceTransportPolicy = result.iceTransportPolicy || 'all';
    this.peers.refreshConfiguration();
    this.hostPid = result.room.hostPid;
    this.settings = result.room.settings;
    this.transcription = result.room.transcription || this.transcription;
    this.waiting = result.room.waiting || [];
    this.startedAt = this.startedAt || result.room.startedAt || Date.now();
    if (firstTime) this.joinedAt = Date.now();

    this.reconcile(result);

    if (firstTime) {
      this.hasJoinedOnce = true;
      this.setPhase('call');
      this.emit('joined', result);
      if (result.moved) this.emit('notice', { type: 'moved' });
      clearInterval(this.syncTimer);
      this.syncTimer = setInterval(() => this.sync(), SYNC_INTERVAL_MS);
      clearInterval(this.sessionTimer);
      this.sessionTimer = setInterval(() => this.persistSession(), 20000);
    } else {
      this.emit('resumed', result);
      this.conn.send('state', {
        micOn: this.media.micOn,
        camOn: this.media.camOn,
        handRaised: this.handRaised,
        sharing: this.media.sharing,
        recording: this.recording
      });
    }
    this.persistSession();
    this.setConnectionState('online');
    this.emit('host-changed', this.hostPid);
    this.emit('settings', this.settings);
    this.emit('transcription', this.transcription);
    this.emit('waiting', this.waiting);
    this.emit('participants');
    if (result.chat?.length) this.emit('chat-history', result.chat);
    if (result.transcript?.length) this.emit('transcript-history', result.transcript);
  }

  /** Brings local state in line with a server snapshot. */
  reconcile({ room, resumed, rebuilt }) {
    const selfPid = this.self.pid;
    const incoming = new Map(room.participants.filter((p) => p.pid !== selfPid).map((p) => [p.pid, p]));

    for (const pid of [...this.participants.keys()]) {
      if (incoming.has(pid)) continue;
      if (rebuilt) this.schedulePendingRemoval(pid); // they may still be reconnecting
      else this.removeParticipant(pid, 'left', { silent: true });
    }

    for (const [pid, info] of incoming) {
      this.clearPendingRemoval(pid);
      const existed = this.participants.has(pid);
      const merged = { ...(this.participants.get(pid) || {}), ...info };
      this.participants.set(pid, merged);
      this.emit(existed ? 'participant-updated' : 'participant-added', merged);

      if (!resumed) {
        this.peers.remove(pid);
        if (info.connected) this.peers.initiate(pid);
        else this.peers.expect(pid);
      } else if (!this.peers.isUsable(pid)) {
        if (info.connected) this.peers.initiate(pid);
        else this.peers.expect(pid);
      }
    }
  }

  async sync() {
    if (this.phase !== 'call' || !this.conn?.connected) return;
    const result = await this.conn.request('sync', {}, 5000);
    if (result.ok) {
      this.hostPid = result.room.hostPid;
      this.settings = result.room.settings;
      this.reconcile({ room: result.room, resumed: true, rebuilt: false });
      this.emit('participants');
    }
  }

  schedulePendingRemoval(pid) {
    const participant = this.participants.get(pid);
    if (participant) {
      participant.connected = false;
      this.emit('participant-updated', participant);
    }
    if (this.pendingRemovals.has(pid)) return;
    this.pendingRemovals.set(
      pid,
      setTimeout(() => {
        this.pendingRemovals.delete(pid);
        if (!this.participants.get(pid)?.connected) this.removeParticipant(pid, 'timeout');
      }, REBUILD_REMOVAL_MS)
    );
  }

  clearPendingRemoval(pid) {
    const timer = this.pendingRemovals.get(pid);
    if (timer) {
      clearTimeout(timer);
      this.pendingRemovals.delete(pid);
    }
  }

  removeParticipant(pid, reason, { silent = false } = {}) {
    const participant = this.participants.get(pid);
    if (!participant) return;
    this.participants.delete(pid);
    this.clearPendingRemoval(pid);
    this.peers.remove(pid);
    this.emit('participant-removed', { pid, reason, name: participant.name });
    this.emit('participants');
    if (!silent && reason !== 'removed') this.emit('notice', { type: 'left', name: participant.name });
  }

  // ---------------------------------------------------------------- events
  onEvent(event, payload = {}) {
    if (this.phase === 'ended') return;
    switch (event) {
      case 'peer-joined': {
        const info = payload.participant;
        this.clearPendingRemoval(info.pid);
        const existed = this.participants.has(info.pid);
        this.participants.set(info.pid, { ...(this.participants.get(info.pid) || {}), ...info });
        if (!payload.resumed || !this.peers.isUsable(info.pid)) {
          this.peers.remove(info.pid);
          this.peers.expect(info.pid); // the newcomer calls us
        }
        this.emit(existed ? 'participant-updated' : 'participant-added', this.participants.get(info.pid));
        this.emit('participants');
        if (!existed && !payload.resumed) this.emit('notice', { type: 'joined', name: info.name });
        break;
      }
      case 'peer-resumed': {
        const info = payload.participant;
        this.clearPendingRemoval(info.pid);
        this.participants.set(info.pid, { ...(this.participants.get(info.pid) || {}), ...info, connected: true });
        if (payload.fresh) {
          // Their page reloaded: the old peer connection is gone.
          this.peers.remove(info.pid);
          this.peers.expect(info.pid);
        }
        this.emit('participant-updated', this.participants.get(info.pid));
        this.emit('participants');
        break;
      }
      case 'peer-reconnecting': {
        const participant = this.participants.get(payload.pid);
        if (participant) {
          participant.connected = false;
          this.emit('participant-updated', participant);
        }
        break;
      }
      case 'peer-left':
        this.removeParticipant(payload.pid, payload.reason);
        break;
      case 'peer-state': {
        const participant = this.participants.get(payload.pid);
        if (!participant) break;
        const wasRaised = participant.handRaised;
        const wasSharing = participant.sharing;
        const wasRecording = participant.recording;
        Object.assign(participant, payload, { connected: true });
        this.emit('participant-updated', participant);
        this.emit('participants');
        if (participant.handRaised && !wasRaised) this.emit('notice', { type: 'hand', name: participant.name });
        if (participant.sharing && !wasSharing) this.emit('notice', { type: 'presenting', name: participant.name });
        if (participant.recording && !wasRecording) this.emit('notice', { type: 'recording', name: participant.name });
        break;
      }
      case 'signal':
        this.peers.handleSignal(payload);
        break;
      case 'view-state':
        this.peers.setRemoteView(payload.from, payload.source || 'camera', payload.view);
        break;
      case 'host-changed':
        this.hostPid = payload.hostPid;
        if (this.hostPid !== this.self.pid) this.self.hostProof = null;
        this.persistSession();
        this.emit('host-changed', this.hostPid);
        this.emit('participants');
        break;
      case 'host-proof':
        this.self.hostProof = payload.proof;
        this.persistSession();
        break;
      case 'room-settings':
        this.settings = payload;
        this.emit('settings', payload);
        break;
      case 'waiting-list':
        this.waiting = payload.waiting || [];
        this.emit('waiting', this.waiting);
        break;
      case 'knock':
        this.emit('knock', payload);
        break;
      case 'knock-result':
        this.onKnockResult(payload);
        break;
      case 'chat':
        this.emit('chat', payload);
        break;
      case 'reaction':
        this.emit('reaction', payload);
        break;
      case 'caption':
        this.emit('caption', payload);
        break;
      case 'transcription-state':
        this.transcription = payload;
        this.persistSession();
        this.emit('transcription', payload);
        break;
      case 'transcription-request':
        this.emit('transcription-request', payload);
        break;
      case 'share-request':
        this.emit('share-request', payload);
        break;
      case 'share-permission':
        this.canShare = payload.allowed;
        this.emit('share-permission', payload);
        break;
      case 'force-mute':
        this.emit('forced', { kind: 'mic', by: payload.by });
        break;
      case 'force-camera-off':
        this.emit('forced', { kind: 'camera', by: payload.by });
        break;
      case 'hand-lowered':
        this.handRaised = false;
        this.handRaisedAt = 0;
        this.emit('self-updated');
        this.emit('notice', { type: 'hand-lowered' });
        break;
      case 'removed':
        this.end('removed', { by: payload.by });
        break;
      case 'meeting-ended':
        this.end('ended', { by: payload.by, reportId: payload.reportId });
        break;
      case 'session-replaced':
        // This seat was opened in another tab or window of this browser.
        this.end('replaced', { moved: Boolean(payload?.moved) });
        break;
      case 'server-shutdown':
        this.emit('server-restarting', payload);
        break;
      default:
        break;
    }
  }

  onKnockResult({ admitted, ticket, reason }) {
    if (admitted) {
      this.pendingTicket = ticket;
      this.setPhase('joining');
      this.sendJoin();
    } else {
      this.emit('knock-denied', { reason });
      this.conn?.close();
      this.conn = null;
      this.setPhase('idle');
    }
  }

  onDisconnect(reason) {
    if (this.phase === 'ended') return;
    this.setConnectionState(navigator.onLine === false ? 'offline' : 'reconnecting');
    // Peer connections stay open: audio and video keep flowing while the
    // signaling channel is down.
    if (reason === 'io server disconnect') setTimeout(() => this.conn?.reconnect(), 1000);
  }

  onConnectError() {
    if (this.phase === 'ended') return;
    if (!this.hasJoinedOnce) this.emit('connect-error');
    this.setConnectionState(navigator.onLine === false ? 'offline' : 'reconnecting');
  }

  // --------------------------------------------------------------- actions
  async toggleMic(force) {
    const next = force === undefined ? !this.media.micOn : force;
    const ok = await this.media.setMic(next);
    if (ok) this.conn?.send('state', { micOn: this.media.micOn });
    this.emit('self-updated');
    return ok;
  }

  async toggleCamera(force) {
    const next = force === undefined ? !this.media.camOn : force;
    const ok = await this.media.setCamera(next);
    if (ok) this.conn?.send('state', { camOn: this.media.camOn });
    this.emit('self-updated');
    return ok;
  }

  setHand(raised) {
    this.handRaised = raised;
    this.handRaisedAt = raised ? Date.now() : 0;
    this.conn?.send('state', { handRaised: raised });
    this.emit('self-updated');
  }

  setRecording(on) {
    this.recording = on;
    this.conn?.send('state', { recording: on });
    this.emit('self-updated');
  }

  async requestShare() {
    return this.conn.request('share-request', {});
  }

  async startShare() {
    try {
      await this.media.startScreenShare();
    } catch (err) {
      if (err && err.name !== 'NotAllowedError') this.emit('notice', { type: 'share-error', message: err.message });
      return false;
    }
    const result = await this.conn.request('state', { sharing: true });
    if (!result.ok) {
      this.media.stopScreenShare();
      this.emit('notice', { type: 'share-error', message: result.error });
      return false;
    }
    this.emit('self-updated');
    return true;
  }

  stopShare() {
    if (this.media.stopScreenShare()) this.conn?.send('state', { sharing: false });
    this.emit('self-updated');
  }

  sendChat(text, to) {
    return this.conn.request('chat', to ? { text, to } : { text });
  }

  sendReaction(emoji) {
    this.conn?.send('reaction', { emoji });
  }

  /** Uploads a clip of my speech for server-side transcription. */
  async uploadClip(pcm, ageMs) {
    if (!this.self.pid || !this.self.token || this.phase !== 'call') return { ok: false, code: 'not-in-call' };
    try {
      const response = await fetch('/api/transcribe', {
        method: 'POST',
        headers: {
          'content-type': 'audio/L16; rate=16000; channels=1',
          'x-peerly-room': this.roomId,
          'x-peerly-pid': this.self.pid,
          'x-peerly-token': this.self.token,
          'x-peerly-age': String(Math.round(ageMs))
        },
        body: pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)
      });
      const body = await response.json().catch(() => ({}));
      return { ...body, status: response.status, ok: response.ok && body.ok !== false };
    } catch {
      return { ok: false, code: 'network' };
    }
  }

  sendCaption(text, final) {
    this.conn?.send('caption', { text, final });
  }

  reportTalkTime(talkMs) {
    this.conn?.send('stats', { talkMs });
  }

  catchUp() {
    return this.conn.request('catch-up', {}, 120000);
  }

  setTranscription(on, lang) {
    return this.conn.request('transcription', { on, lang });
  }

  requestTranscription() {
    return this.conn.request('transcription-request', {});
  }

  hostAction(action, extra = {}) {
    return this.conn.request('host-action', { action, ...extra });
  }

  setSharePermission(pid, allowed) {
    return this.conn.request('set-share-permission', { pid, allowed });
  }

  transferHost(pid) {
    return this.conn.request('transfer-host', { pid });
  }

  respondToKnock(requestId, admit) {
    return this.conn.request('knock-response', { requestId, admit });
  }

  admitAllWaiting() {
    return this.conn.request('knock-response', { all: true, admit: true });
  }

  cancelKnock() {
    this.conn?.send('cancel-knock', {});
    this.conn?.close();
    this.conn = null;
    this.setPhase('idle');
  }

  sendView({ to, view, source }) {
    this.peers.reportView(to, source, view, (message) => this.conn?.send('view-state', message));
  }

  // ----------------------------------------------------------------- leave
  async leave() {
    this.intentionalLeave = true;
    if (this.conn?.connected) await this.conn.request('leave', {}, 1500);
    this.end('left');
  }

  onPageHide() {
    if (this.phase !== 'call' || !this.self.pid) return;
    this.conn?.send('leave', { intent: 'unload' });
    try {
      const body = JSON.stringify({
        roomId: this.roomId,
        pid: this.self.pid,
        token: this.self.token,
        socketId: this.conn?.id
      });
      navigator.sendBeacon?.('/api/leave', new Blob([body], { type: 'application/json' }));
    } catch {
      /* best effort */
    }
  }

  end(reason, extra = {}) {
    if (this.phase === 'ended') return;
    // Taken over by another tab: save how this tab was set up before its
    // media stops, for "Use here".
    if (reason === 'replaced') this.persistSession();
    const reportId = extra.reportId || this.transcription.reportId || null;
    this.setPhase('ended');
    clearTimeout(this.joinRetryTimer);
    clearInterval(this.syncTimer);
    clearInterval(this.sessionTimer);
    for (const timer of this.pendingRemovals.values()) clearTimeout(timer);
    this.pendingRemovals.clear();
    this.peers.closeAll();
    this.conn?.close();
    this.conn = null;
    this.media.stopAll();
    // A tab that another tab took over keeps its session, so "Use here" can
    // move the seat back with one click.
    if (reason !== 'replaced') clearSession(this.roomId);
    this.emit('ended', { reason, reportId, ...extra });
  }
}

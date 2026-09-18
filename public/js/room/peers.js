// The WebRTC mesh.
//
// Each pair of participants has one PeerLink. A link owns a session (`sid`):
// a single RTCPeerConnection with a fixed transceiver plan
// [mic, camera, screen video, screen audio], so switching camera, starting a
// screen share or turning video off is just replaceTrack() with no
// renegotiation. Within a session the W3C "perfect negotiation" pattern
// handles glare; a new session id replaces the connection outright (used when
// someone reloads or a connection can't be recovered).

import { Emitter } from './ui.js';

const KINDS = ['audio', 'camera', 'screen', 'screenAudio'];

// Per-viewer encoding tiers: a face in a filmstrip thumbnail doesn't need
// the bitrate of a spotlighted presentation.
const TIERS = {
  camera: {
    focused: { maxBitrate: 2500000, scaleResolutionDownBy: 1, maxFramerate: 30 },
    normal: { maxBitrate: 900000, scaleResolutionDownBy: 1, maxFramerate: 30 },
    thumb: { maxBitrate: 150000, scaleResolutionDownBy: 4, maxFramerate: 15 }
  },
  screen: {
    focused: { maxBitrate: 3000000, scaleResolutionDownBy: 1, maxFramerate: 30 },
    normal: { maxBitrate: 1500000, scaleResolutionDownBy: 1, maxFramerate: 15 },
    thumb: { maxBitrate: 400000, scaleResolutionDownBy: 2, maxFramerate: 10 }
  }
};
const DATA_SAVER_TIERS = {
  camera: { maxBitrate: 200000, scaleResolutionDownBy: 3, maxFramerate: 15 },
  screen: { maxBitrate: 600000, scaleResolutionDownBy: 2, maxFramerate: 10 }
};

const newSid = () =>
  crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

class PeerLink {
  constructor(manager, pid) {
    this.manager = manager;
    this.pid = pid;
    this.pc = null;
    this.sid = null;
    this.role = null;
    // On a collision the peer with the larger id yields ("polite").
    this.polite = String(manager.selfPid || '') > String(pid);
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.pendingCandidates = [];
    this.queue = Promise.resolve();
    this.remoteViews = { camera: 'normal', screen: 'normal' };
    this.streams = { camera: null, screen: null };
    this.trackIds = { camera: null, screen: null };
    this.frames = { camera: 0, screen: 0 };
    this.frozenSince = { camera: 0, screen: 0 };
    this.frozen = { camera: false, screen: false };
    this.prevLost = 0;
    this.prevReceived = 0;
    this.restarts = 0;
    this.quality = 'unknown';
    this.closed = false;
  }

  send(data) {
    this.manager.signal(this.pid, this.sid, data);
  }

  // ------------------------------------------------------------- sessions
  startSession() {
    if (this.closed) return;
    this.closePc();
    this.sid = newSid();
    this.role = 'initiator';
    this.createPc();
    const tracks = this.manager.getTracks();
    const add = (kind, fallback) => {
      const track = tracks[kind];
      this.pc.addTransceiver(track || fallback, { direction: 'sendrecv' });
    };
    add('audio', 'audio');
    add('camera', 'video');
    add('screen', 'video');
    add('screenAudio', 'audio');
    // addTransceiver fires negotiationneeded, which sends the offer.
  }

  expectOffer(timeoutMs = 9000) {
    clearTimeout(this.awaitTimer);
    this.awaitTimer = setTimeout(() => {
      if (this.closed || this.pc) return;
      // They never called: call them instead (id tie-break resolves races).
      if (this.manager.isConnected(this.pid)) this.startSession();
      else this.expectOffer(timeoutMs);
    }, timeoutMs);
  }

  createPc() {
    const pc = new RTCPeerConnection(this.manager.getRtcConfig());
    this.pc = pc;
    this.createdAt = Date.now();
    this.pendingCandidates = [];
    this.streams = { camera: new MediaStream(), screen: new MediaStream() };
    this.trackIds = { camera: null, screen: null };
    this.frames = { camera: 0, screen: 0 };

    pc.onicecandidate = ({ candidate }) => {
      if (this.pc === pc && candidate) this.send({ candidate: candidate.toJSON() });
    };
    pc.onnegotiationneeded = async () => {
      if (this.pc !== pc) return;
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        if (this.pc === pc && pc.localDescription) this.send({ description: pc.localDescription.toJSON() });
      } catch (err) {
        console.warn('Peerly: could not create an offer', err);
      } finally {
        this.makingOffer = false;
      }
    };
    pc.ontrack = (event) => this.onTrack(event);
    pc.onconnectionstatechange = () => this.onConnectionState();
    pc.onicecandidateerror = (event) => {
      // 701 means one STUN/TURN server failed; others may still work.
      if (event.errorCode && event.errorCode !== 701) {
        console.warn('Peerly: ICE candidate error', event.errorCode, event.errorText);
      }
    };
    clearTimeout(this.awaitTimer);
  }

  closePc() {
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    const pc = this.pc;
    this.pc = null;
    this.makingOffer = false;
    this.ignoreOffer = false;
    if (!pc) return;
    pc.onicecandidate = null;
    pc.onnegotiationneeded = null;
    pc.ontrack = null;
    pc.onconnectionstatechange = null;
    try {
      pc.close();
    } catch {
      /* already closed */
    }
  }

  destroy() {
    this.closed = true;
    clearTimeout(this.awaitTimer);
    this.closePc();
  }

  // Both sides can start a session at the same moment; keep the one whose id
  // sorts first so the two peers converge without a ping-pong.
  acceptsSession(incomingSid) {
    if (!this.pc || this.role !== 'initiator') return true;
    const settling = this.pc.connectionState !== 'connected' && Date.now() - this.createdAt < 15000;
    if (!settling) return true;
    return incomingSid < this.sid;
  }

  // --------------------------------------------------------------- signals
  enqueue(sid, data) {
    this.queue = this.queue.then(() => this.handleSignal(sid, data)).catch((err) => {
      console.warn('Peerly: signal handling failed', err);
    });
  }

  async handleSignal(sid, data) {
    if (this.closed) return;
    if (data.description) await this.handleDescription(sid, data.description);
    else if (data.candidate) await this.handleCandidate(sid, data.candidate);
  }

  async handleDescription(sid, description) {
    if (sid !== this.sid) {
      if (description.type !== 'offer') return; // stale answer from a dead session
      if (!this.acceptsSession(sid)) return;
      this.closePc();
      this.sid = sid;
      this.role = 'acceptor';
      this.createPc();
    }
    const pc = this.pc;
    if (!pc) return;

    const collision = description.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
    this.ignoreOffer = !this.polite && collision;
    if (this.ignoreOffer) return;

    try {
      await pc.setRemoteDescription(description);
      if (this.pc !== pc) return;
      await this.flushCandidates(pc);
      if (description.type === 'offer') {
        this.attachLocalTracks();
        await pc.setLocalDescription();
        if (this.pc === pc && pc.localDescription) this.send({ description: pc.localDescription.toJSON() });
      }
      this.applyQuality();
    } catch (err) {
      console.warn('Peerly: negotiation failed', err);
      if (this.pc === pc && pc.connectionState !== 'connected') this.scheduleRecovery(2000);
    }
  }

  async handleCandidate(sid, candidate) {
    if (sid !== this.sid || !this.pc) return;
    const pc = this.pc;
    if (!pc.remoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }
    try {
      await pc.addIceCandidate(candidate);
    } catch (err) {
      if (!this.ignoreOffer) console.warn('Peerly: could not add ICE candidate', err);
    }
  }

  async flushCandidates(pc) {
    const queued = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        /* candidate from a superseded negotiation */
      }
    }
  }

  // ---------------------------------------------------------------- tracks
  transceiverFor(kind) {
    if (!this.pc) return null;
    const index = KINDS.indexOf(kind);
    return this.pc.getTransceivers()[index] || null;
  }

  kindOf(transceiver) {
    const index = this.pc.getTransceivers().indexOf(transceiver);
    if (index >= 0 && index < KINDS.length) return KINDS[index];
    const mid = Number(transceiver.mid);
    return Number.isInteger(mid) && mid >= 0 && mid < KINDS.length ? KINDS[mid] : null;
  }

  /** Answerer side: fill the transceivers the offer created with our tracks. */
  attachLocalTracks() {
    if (!this.pc) return;
    const tracks = this.manager.getTracks();
    this.pc.getTransceivers().forEach((transceiver, index) => {
      const kind = KINDS[index];
      if (!kind || transceiver.currentDirection === 'stopped') return;
      if (transceiver.direction !== 'sendrecv') transceiver.direction = 'sendrecv';
      const track = tracks[kind] || null;
      if (transceiver.sender.track !== track) transceiver.sender.replaceTrack(track).catch(() => {});
    });
  }

  async replaceTrack(kind, track) {
    const transceiver = this.transceiverFor(kind);
    if (!transceiver) return;
    if (transceiver.sender.track === track) return;
    try {
      await transceiver.sender.replaceTrack(track || null);
    } catch (err) {
      console.warn(`Peerly: could not replace the ${kind} track`, err);
      return;
    }
    if (kind === 'camera' || kind === 'screen') this.applyQuality(kind);
  }

  onTrack(event) {
    const kind = this.kindOf(event.transceiver);
    if (!kind) return;
    const source = kind === 'screen' || kind === 'screenAudio' ? 'screen' : 'camera';
    const stream = this.streams[source];
    // Tracks attached via replaceTrack carry no stream id, so we keep our own
    // per-peer streams instead of relying on event.streams.
    for (const existing of stream.getTracks()) {
      if (existing.kind === event.track.kind && existing !== event.track) stream.removeTrack(existing);
    }
    if (!stream.getTracks().includes(event.track)) stream.addTrack(event.track);
    if (event.track.kind === 'video') this.trackIds[source] = event.track.id;
    this.manager.emit('track', { pid: this.pid, source, stream, track: event.track });
  }

  // ----------------------------------------------------------- connection
  onConnectionState() {
    if (!this.pc) return;
    const state = this.pc.connectionState;
    this.manager.emit('link-state', { pid: this.pid, state });
    if (state === 'connected') {
      this.restarts = 0;
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
      this.applyQuality();
      this.manager.emit('connected', { pid: this.pid });
    } else if (state === 'disconnected') {
      this.scheduleRecovery(4000); // often recovers on its own
    } else if (state === 'failed') {
      this.scheduleRecovery(0);
    }
  }

  scheduleRecovery(delay) {
    if (this.recoveryTimer || this.closed) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      this.recover();
    }, delay);
  }

  recover() {
    const pc = this.pc;
    if (this.closed || !pc || pc.connectionState === 'connected') return;
    if (!this.manager.canSignal()) {
      this.scheduleRecovery(3000); // no signaling channel right now
      return;
    }
    if (!this.manager.isConnected(this.pid)) {
      this.scheduleRecovery(5000); // they're away; wait for them to come back
      return;
    }
    if (this.restarts < 2 && pc.signalingState === 'stable') {
      this.restarts += 1;
      try {
        // Pick up fresh TURN credentials on the way.
        pc.setConfiguration(this.manager.getRtcConfig());
      } catch {
        /* older browsers */
      }
      try {
        pc.restartIce();
      } catch (err) {
        console.warn('Peerly: ICE restart failed', err);
      }
      this.scheduleRecovery(8000 * this.restarts);
    } else if (String(this.manager.selfPid) < String(this.pid)) {
      // Restarts didn't help: rebuild the connection (one side only).
      this.startSession();
      this.scheduleRecovery(15000);
    } else {
      this.scheduleRecovery(10000);
    }
  }

  // ---------------------------------------------------------- send quality
  applyQuality(only) {
    for (const kind of ['camera', 'screen']) {
      if (only && only !== kind) continue;
      const transceiver = this.transceiverFor(kind);
      const sender = transceiver && transceiver.sender;
      if (!sender || !sender.track) continue;
      const view = this.remoteViews[kind] || 'normal';
      let params;
      try {
        params = sender.getParameters();
      } catch {
        continue;
      }
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      const encoding = params.encodings[0];
      if (view === 'hidden') {
        encoding.active = false;
      } else {
        encoding.active = true;
        const tier = this.manager.dataSaver && view !== 'focused' ? DATA_SAVER_TIERS[kind] : TIERS[kind][view] || TIERS[kind].normal;
        Object.assign(encoding, tier);
      }
      sender.setParameters(params).catch(() => {
        /* browsers reject changes mid-negotiation; retried on the next trigger */
      });
      try {
        const preference = kind === 'screen' ? 'maintain-resolution' : 'maintain-framerate';
        if (params.degradationPreference !== preference) {
          sender.setParameters({ ...params, degradationPreference: preference }).catch(() => {});
        }
      } catch {
        /* unsupported */
      }
    }
  }

  // --------------------------------------------------------------- stats
  async collectStats(now) {
    const pc = this.pc;
    if (!pc || pc.connectionState !== 'connected') return;
    let report;
    try {
      report = await pc.getStats();
    } catch {
      return;
    }
    let rtt = 0;
    let relay = false;
    let lost = 0;
    let received = 0;
    let remoteLoss = 0;
    let remoteSamples = 0;
    let limitation = null;
    const frames = {};

    report.forEach((stat) => {
      if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && (stat.nominated || stat.selected)) {
        if (stat.currentRoundTripTime) rtt = stat.currentRoundTripTime;
        const local = report.get(stat.localCandidateId);
        const remote = report.get(stat.remoteCandidateId);
        if ((local && local.candidateType === 'relay') || (remote && remote.candidateType === 'relay')) relay = true;
      } else if (stat.type === 'inbound-rtp') {
        lost += stat.packetsLost || 0;
        received += stat.packetsReceived || 0;
        if (stat.kind === 'video' && typeof stat.framesDecoded === 'number') {
          if (stat.trackIdentifier === this.trackIds.screen) frames.screen = stat.framesDecoded;
          else if (stat.trackIdentifier === this.trackIds.camera) frames.camera = stat.framesDecoded;
        }
      } else if (stat.type === 'remote-inbound-rtp') {
        if (typeof stat.fractionLost === 'number') {
          remoteLoss += stat.fractionLost;
          remoteSamples += 1;
        }
        if (!rtt && stat.roundTripTime) rtt = stat.roundTripTime;
      } else if (stat.type === 'outbound-rtp' && stat.kind === 'video') {
        if (stat.qualityLimitationReason && stat.qualityLimitationReason !== 'none') limitation = stat.qualityLimitationReason;
      }
    });

    const deltaLost = Math.max(0, lost - this.prevLost);
    const deltaReceived = Math.max(0, received - this.prevReceived);
    this.prevLost = lost;
    this.prevReceived = received;
    const inboundLoss = deltaLost + deltaReceived > 0 ? deltaLost / (deltaLost + deltaReceived) : 0;
    const outboundLoss = remoteSamples ? remoteLoss / remoteSamples : 0;
    const loss = Math.max(inboundLoss, outboundLoss);

    let quality = 'good';
    if (loss > 0.08 || rtt > 0.6) quality = 'poor';
    else if (loss > 0.03 || rtt > 0.3) quality = 'fair';
    this.quality = quality;

    this.manager.emit('quality', {
      pid: this.pid,
      quality,
      rttMs: Math.round(rtt * 1000),
      loss,
      relay,
      limitation
    });
    this.checkFrozen(frames, now);
  }

  setFrozen(source, frozen) {
    if (this.frozen[source] === frozen) return;
    this.frozen[source] = frozen;
    this.manager.emit('frozen', { pid: this.pid, source, frozen });
  }

  /**
   * A link can report "connected" while inbound video has quietly stalled.
   * Watch decoded frames and nudge ICE when they stop advancing.
   */
  checkFrozen(frames, now) {
    for (const source of ['camera', 'screen']) {
      const expected = this.manager.expectsVideo(this.pid, source) && this.manager.viewOf(this.pid, source) !== 'hidden';
      const current = frames[source];
      if (!expected || current === undefined) {
        this.frozenSince[source] = 0;
        this.setFrozen(source, false);
        continue;
      }
      if (current > this.frames[source]) {
        this.frames[source] = current;
        this.frozenSince[source] = 0;
        this.setFrozen(source, false);
        continue;
      }
      if (!this.frozenSince[source]) this.frozenSince[source] = now;
      const stalledMs = now - this.frozenSince[source];
      if (stalledMs > 4000) this.setFrozen(source, true);
      if (stalledMs > 9000 && now - (this.lastStallRecovery || 0) > 20000) {
        this.lastStallRecovery = now;
        this.scheduleRecovery(0);
      }
    }
  }
}

export class PeerManager extends Emitter {
  constructor({ signal, getTracks, getRtcConfig, isConnected, expectsVideo, canSignal }) {
    super();
    this.signalFn = signal;
    this.getTracks = getTracks;
    this.getRtcConfig = getRtcConfig;
    this.isConnected = isConnected;
    this.expectsVideo = expectsVideo;
    this.canSignal = canSignal;
    this.selfPid = null;
    this.dataSaver = false;
    this.links = new Map();
    this.sentViews = new Map(); // `${pid}:${source}` -> view we last reported
    this.statsTimer = setInterval(() => {
      const now = Date.now();
      for (const link of this.links.values()) link.collectStats(now);
    }, 2000);
  }

  signal(pid, sid, data) {
    this.signalFn({ to: pid, sid, data });
  }

  link(pid) {
    let link = this.links.get(pid);
    if (!link) {
      link = new PeerLink(this, pid);
      this.links.set(pid, link);
    }
    return link;
  }

  has(pid) {
    return this.links.has(pid);
  }

  /** True when we have a peer connection that is up or on its way up. */
  isUsable(pid) {
    const link = this.links.get(pid);
    if (!link || !link.pc) return false;
    return ['new', 'connecting', 'connected'].includes(link.pc.connectionState);
  }

  isConnectedTo(pid) {
    const link = this.links.get(pid);
    return Boolean(link && link.pc && link.pc.connectionState === 'connected');
  }

  initiate(pid) {
    this.link(pid).startSession();
  }

  expect(pid) {
    this.link(pid).expectOffer();
  }

  reset(pid) {
    const link = this.link(pid);
    link.closePc();
    link.expectOffer();
  }

  remove(pid) {
    const link = this.links.get(pid);
    if (!link) return;
    link.destroy();
    this.links.delete(pid);
    for (const source of ['camera', 'screen']) this.sentViews.delete(`${pid}:${source}`);
  }

  handleSignal({ from, sid, data }) {
    if (!from || !sid || !data) return;
    this.link(from).enqueue(sid, data);
  }

  /** How a peer says they display our video (drives our encoder). */
  setRemoteView(pid, source, view) {
    const link = this.links.get(pid);
    if (!link) return;
    link.remoteViews[source] = view;
    link.applyQuality(source);
  }

  /** How we display their video (sent to them, deduplicated). */
  reportView(pid, source, view, send) {
    const key = `${pid}:${source}`;
    if (this.sentViews.get(key) === view) return;
    this.sentViews.set(key, view);
    send({ to: pid, view, source });
  }

  viewOf(pid, source) {
    return this.sentViews.get(`${pid}:${source}`) || 'normal';
  }

  replaceTrack(kind, track) {
    for (const link of this.links.values()) link.replaceTrack(kind, track);
  }

  setDataSaver(on) {
    this.dataSaver = on;
    for (const link of this.links.values()) link.applyQuality();
  }

  refreshConfiguration() {
    for (const link of this.links.values()) {
      try {
        link.pc?.setConfiguration(this.getRtcConfig());
      } catch {
        /* ignore */
      }
    }
  }

  closeAll() {
    for (const link of this.links.values()) link.destroy();
    this.links.clear();
    this.sentViews.clear();
  }

  destroy() {
    clearInterval(this.statsTimer);
    this.closeAll();
  }
}

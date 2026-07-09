(() => {
  'use strict';

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);

  const lobby = $('lobby');
  const call = $('call');
  const previewVideo = $('previewVideo');
  const previewPlaceholder = $('previewPlaceholder');
  const previewStatus = $('previewStatus');
  const previewAvatar = $('previewAvatar');
  const lobbyMicBtn = $('lobbyMicBtn');
  const lobbyCamBtn = $('lobbyCamBtn');
  const micSelect = $('micSelect');
  const camSelect = $('camSelect');
  const mediaWarning = $('mediaWarning');
  const lobbyRoomId = $('lobbyRoomId');
  const lobbyOccupancy = $('lobbyOccupancy');
  const nameInput = $('nameInput');
  const joinRoomBtn = $('joinRoomBtn');
  const joinError = $('joinError');

  const callRoomId = $('callRoomId');
  const copyLinkBtn = $('copyLinkBtn');
  const callTimer = $('callTimer');
  const recIndicator = $('recIndicator');
  const videoGrid = $('videoGrid');
  const micBtn = $('micBtn');
  const camBtn = $('camBtn');
  const shareBtn = $('shareBtn');
  const handBtn = $('handBtn');
  const recordBtn = $('recordBtn');
  const leaveBtn = $('leaveBtn');
  const chatBtn = $('chatBtn');
  const peopleBtn = $('peopleBtn');
  const chatPanel = $('chatPanel');
  const peoplePanel = $('peoplePanel');
  const chatMessages = $('chatMessages');
  const chatForm = $('chatForm');
  const chatInput = $('chatInput');
  const chatBadge = $('chatBadge');
  const peopleBadge = $('peopleBadge');
  const peopleList = $('peopleList');
  const peopleCount = $('peopleCount');
  const toasts = $('toasts');
  const shortcutsOverlay = $('shortcutsOverlay');
  const shortcutsClose = $('shortcutsClose');

  // ---------- Icons ----------
  const ICONS = {
    micOn: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4"/></svg>',
    micOff: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5a3 3 0 0 1 6 0v6c0 .5-.12.97-.34 1.38M9 9v2a3 3 0 0 0 4.68 2.48"/><path d="M5 10v1a7 7 0 0 0 11.36 5.47M19 10v1c0 .93-.18 1.82-.51 2.63M12 18v4"/><path d="M3 3l18 18"/></svg>',
    camOn: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>',
    camOff: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5 0h4a2 2 0 0 1 2 2v4l7-5v12"/><path d="M1 1l22 22"/></svg>',
    micOffSmall: '<svg class="mic-off-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5a3 3 0 0 1 6 0v6c0 .5-.12.97-.34 1.38M9 9v2a3 3 0 0 0 4.68 2.48"/><path d="M5 10v1a7 7 0 0 0 11.36 5.47M19 10v1c0 .93-.18 1.82-.51 2.63M12 18v4"/><path d="M3 3l18 18"/></svg>',
    hand: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 11V6.5a1.5 1.5 0 0 0-3 0V11m0-1V4.5a1.5 1.5 0 0 0-3 0V10m0 .5v-6a1.5 1.5 0 0 0-3 0V12m9-1.5v2a7.5 7.5 0 0 1-7.5 7.5h-.36a6 6 0 0 1-5.06-2.78L3.5 13.5a1.63 1.63 0 0 1 2.6-1.95L7.5 13"/></svg>',
    share: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="14" rx="2"/><path d="M12 14V8m0 0l-3 3m3-3l3 3"/></svg>'
  };

  // ---------- State ----------
  const roomId = location.pathname.split('/').pop();
  let socket = null;
  let selfId = null;
  let selfName = '';
  let joined = false;
  let intentionalLeave = false;

  let localStream = null; // camera + mic
  let screenStream = null;
  let micOn = true;
  let camOn = true;
  let handRaised = false;
  let sharing = false;
  let hostId = null;
  let selfCanShare = false;
  let focusedId = null;
  let focusAuto = false;
  let filmstrip = null;

  let iceConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  // peers: Map<socketId, { pc, name, micOn, camOn, handRaised, sharing, stream, pendingCandidates }>
  const peers = new Map();

  let audioCtx = null;
  const analysers = new Map(); // id -> { analyser, data, source }

  let mediaRecorder = null;
  let recordedChunks = [];
  let recordStream = null;

  let timerInterval = null;
  let unreadChats = 0;

  // ---------- Helpers ----------
  function toast(msg, isError = false) {
    const el = document.createElement('div');
    el.className = 'toast' + (isError ? ' toast-error' : '');
    el.textContent = msg;
    toasts.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  // Toast with action buttons (host approval prompts). Sticks around
  // for 30s or until a button is clicked.
  function actionToast(msg, actions) {
    const el = document.createElement('div');
    el.className = 'toast toast-action';
    const span = document.createElement('span');
    span.textContent = msg;
    el.appendChild(span);
    actions.forEach((a) => {
      const b = document.createElement('button');
      b.className = 'toast-btn' + (a.primary ? ' toast-btn-primary' : '');
      b.textContent = a.label;
      b.addEventListener('click', () => {
        a.onClick();
        el.remove();
      });
      el.appendChild(b);
    });
    toasts.appendChild(el);
    setTimeout(() => el.remove(), 30000);
  }

  function initials(name) {
    return name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase() || '?';
  }

  function setToggleIcon(btn, kind, on) {
    btn.dataset.on = String(on);
    btn.innerHTML = kind === 'mic' ? (on ? ICONS.micOn : ICONS.micOff) : (on ? ICONS.camOn : ICONS.camOff);
  }

  function meetingLink() {
    return `${location.origin}/room/${roomId}`;
  }

  // ================================================================
  // LOBBY
  // ================================================================

  lobbyRoomId.textContent = roomId;
  callRoomId.textContent = roomId;
  nameInput.value = localStorage.getItem('peerly-name') || '';
  previewAvatar.textContent = initials(nameInput.value);

  function updateJoinEnabled() {
    joinRoomBtn.disabled = nameInput.value.trim().length === 0;
  }
  nameInput.addEventListener('input', () => {
    previewAvatar.textContent = initials(nameInput.value);
    updateJoinEnabled();
  });
  updateJoinEnabled();

  async function checkRoom() {
    try {
      const res = await fetch(`/api/room/${roomId}`);
      const info = await res.json();
      if (!info.valid) {
        lobbyOccupancy.textContent = 'This meeting link is not valid.';
        joinRoomBtn.disabled = true;
        return;
      }
      if (info.full) {
        lobbyOccupancy.textContent = `Room is full (${info.count}/${info.max}).`;
      } else if (info.count === 0) {
        lobbyOccupancy.textContent = 'No one else is here yet.';
      } else {
        lobbyOccupancy.textContent = `${info.count} ${info.count === 1 ? 'person is' : 'people are'} already here.`;
      }
    } catch {
      lobbyOccupancy.textContent = 'Could not reach the server.';
    }
  }
  checkRoom();
  const occupancyPoll = setInterval(checkRoom, 5000);

  async function fetchIceConfig() {
    try {
      const res = await fetch('/api/ice-config');
      iceConfig = await res.json();
    } catch { /* keep default STUN */ }
  }
  fetchIceConfig();

  // --- local media ---
  function stopStream(stream) {
    if (stream) stream.getTracks().forEach((t) => t.stop());
  }

  async function acquireMedia(audioDeviceId, videoDeviceId) {
    const audio = audioDeviceId ? { deviceId: { exact: audioDeviceId } } : true;
    const video = videoDeviceId
      ? { deviceId: { exact: videoDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
      : { width: { ideal: 1280 }, height: { ideal: 720 } };
    try {
      return await navigator.mediaDevices.getUserMedia({ audio, video });
    } catch (err) {
      // Retry audio-only, then video-only, then give up.
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio });
        mediaWarning.hidden = false;
        mediaWarning.textContent = 'Camera unavailable - joining with microphone only. You can still see and hear others.';
        return s;
      } catch {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ video });
          mediaWarning.hidden = false;
          mediaWarning.textContent = 'Microphone unavailable - others will not hear you.';
          return s;
        } catch {
          mediaWarning.hidden = false;
          mediaWarning.textContent = 'No camera or microphone access. You can still join to watch and use chat. Check browser permissions to enable devices.';
          return null;
        }
      }
    }
  }

  function applyLocalTrackStates() {
    if (!localStream) return;
    localStream.getAudioTracks().forEach((t) => { t.enabled = micOn; });
    localStream.getVideoTracks().forEach((t) => { t.enabled = camOn; });
  }

  function updatePreview() {
    const hasVideo = localStream && localStream.getVideoTracks().length > 0;
    if (hasVideo && camOn) {
      previewVideo.srcObject = localStream;
      previewPlaceholder.style.display = 'none';
    } else {
      previewPlaceholder.style.display = 'flex';
      previewStatus.textContent = hasVideo ? 'Camera is off' : 'No camera detected';
    }
    setToggleIcon(lobbyMicBtn, 'mic', micOn);
    setToggleIcon(lobbyCamBtn, 'cam', camOn);
  }

  async function populateDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter((d) => d.kind === 'audioinput');
      const cams = devices.filter((d) => d.kind === 'videoinput');
      const fill = (select, list, label) => {
        select.innerHTML = '';
        if (list.length === 0) {
          const opt = document.createElement('option');
          opt.textContent = `No ${label.toLowerCase()} found`;
          select.appendChild(opt);
          select.disabled = true;
          return;
        }
        select.disabled = false;
        list.forEach((d, i) => {
          const opt = document.createElement('option');
          opt.value = d.deviceId;
          opt.textContent = d.label || `${label} ${i + 1}`;
          select.appendChild(opt);
        });
      };
      fill(micSelect, mics, 'Microphone');
      fill(camSelect, cams, 'Camera');
      const audioTrack = localStream && localStream.getAudioTracks()[0];
      const videoTrack = localStream && localStream.getVideoTracks()[0];
      if (audioTrack) {
        const s = audioTrack.getSettings();
        if (s.deviceId) micSelect.value = s.deviceId;
      }
      if (videoTrack) {
        const s = videoTrack.getSettings();
        if (s.deviceId) camSelect.value = s.deviceId;
      }
    } catch { /* enumeration is best-effort */ }
  }

  async function initLobbyMedia() {
    localStream = await acquireMedia();
    if (localStream) {
      micOn = localStream.getAudioTracks().length > 0;
      camOn = localStream.getVideoTracks().length > 0;
    } else {
      micOn = false;
      camOn = false;
    }
    applyLocalTrackStates();
    updatePreview();
    populateDevices();
  }
  initLobbyMedia();

  async function switchDevices() {
    stopStream(localStream);
    localStream = await acquireMedia(micSelect.value || undefined, camSelect.value || undefined);
    applyLocalTrackStates();
    updatePreview();
  }
  micSelect.addEventListener('change', switchDevices);
  camSelect.addEventListener('change', switchDevices);

  lobbyMicBtn.addEventListener('click', () => {
    if (!localStream || localStream.getAudioTracks().length === 0) {
      toast('No microphone available', true);
      return;
    }
    micOn = !micOn;
    applyLocalTrackStates();
    updatePreview();
  });

  lobbyCamBtn.addEventListener('click', () => {
    if (!localStream || localStream.getVideoTracks().length === 0) {
      toast('No camera available', true);
      return;
    }
    camOn = !camOn;
    applyLocalTrackStates();
    updatePreview();
  });

  setToggleIcon(lobbyMicBtn, 'mic', true);
  setToggleIcon(lobbyCamBtn, 'cam', true);

  // ================================================================
  // JOIN / SIGNALING
  // ================================================================

  joinRoomBtn.addEventListener('click', () => {
    selfName = nameInput.value.trim().slice(0, 30);
    if (!selfName) return;
    localStorage.setItem('peerly-name', selfName);
    joinRoomBtn.disabled = true;
    joinRoomBtn.textContent = 'Joining...';
    connect();
  });

  function connect() {
    socket = io();

    socket.on('connect_error', () => {
      if (!joined) {
        joinError.textContent = 'Could not connect to the meeting server. Retrying...';
        joinError.hidden = false;
      }
    });

    socket.on('connect', () => {
      socket.emit('join', { roomId, name: selfName, micOn, camOn }, (res) => {
        if (res.error) {
          joinError.textContent = res.error;
          joinError.hidden = false;
          joinRoomBtn.disabled = false;
          joinRoomBtn.textContent = 'Join now';
          socket.disconnect();
          return;
        }
        selfId = res.selfId;
        hostId = res.hostId;
        if (!joined) {
          enterCall();
        } else {
          // Reconnected with a fresh socket id: move the self tile over.
          const oldTile = document.querySelector('.self-tile');
          if (oldTile) oldTile.id = `tile-${selfId}`;
          toast('Reconnected');
        }
        // Existing participants: we are the newcomer, so we initiate the offer to each.
        res.peers.forEach((p) => createPeer(p, true));
        renderPeople();
      });
    });

    socket.on('peer-joined', (p) => {
      createPeer(p, false);
      toast(`${p.name} joined`);
      renderPeople();
    });

    socket.on('signal', async ({ from, data }) => {
      const peer = peers.get(from);
      if (!peer) return;
      const pc = peer.pc;
      try {
        if (data.type === 'offer') {
          await pc.setRemoteDescription(data);
          attachLocalTracks(pc);
          await flushCandidates(peer);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('signal', { to: from, data: pc.localDescription.toJSON() });
        } else if (data.type === 'answer') {
          await pc.setRemoteDescription(data);
          await flushCandidates(peer);
        } else if ('candidate' in data) {
          if (pc.remoteDescription) {
            await pc.addIceCandidate(data.candidate || undefined).catch(() => {});
          } else {
            peer.pendingCandidates.push(data.candidate);
          }
        }
      } catch (err) {
        console.error('signal error', err);
      }
    });

    socket.on('peer-state', ({ id, micOn, camOn, handRaised, sharing, canShare }) => {
      const peer = peers.get(id);
      if (!peer) return;
      const wasRaised = peer.handRaised;
      const wasSharing = peer.sharing;
      Object.assign(peer, { micOn, camOn, handRaised, sharing, canShare });
      if (handRaised && !wasRaised) toast(`${peer.name} raised a hand`);
      // Auto-focus whoever starts presenting; drop back when they stop.
      if (sharing && !wasSharing && !focusedId) focusTile(id, true);
      if (!sharing && wasSharing && focusedId === id && focusAuto) unfocusTile();
      updateTileState(id);
      renderPeople();
    });

    socket.on('host-changed', ({ hostId: newHostId }) => {
      hostId = newHostId;
      if (newHostId === selfId) {
        toast('You are now the host');
      } else {
        const p = peers.get(newHostId);
        if (p) toast(`${p.name} is now the host`);
      }
      if (selfId) updateTileState(selfId);
      peers.forEach((_, id) => updateTileState(id));
      renderPeople();
    });

    socket.on('share-request', ({ id, name }) => {
      actionToast(`${name} wants to share their screen`, [
        { label: 'Allow', primary: true, onClick: () => socket.emit('set-share-permission', { id, allowed: true }) },
        { label: 'Deny', onClick: () => socket.emit('set-share-permission', { id, allowed: false }) }
      ]);
    });

    socket.on('share-permission', ({ allowed }) => {
      selfCanShare = allowed;
      if (allowed) {
        toast('The host allowed you to present. Click Share to start.');
      } else if (sharing) {
        stopShare();
        toast('The host stopped your screen share', true);
      } else {
        toast('The host declined your request to share', true);
      }
      renderPeople();
    });

    socket.on('chat', ({ from, name, text, ts }) => {
      addChatMessage(name, text, ts, from === selfId);
      if (chatPanel.hidden && from !== selfId) {
        unreadChats += 1;
        chatBadge.textContent = unreadChats > 9 ? '9+' : String(unreadChats);
        chatBadge.hidden = false;
      }
    });

    socket.on('peer-left', ({ id }) => {
      const peer = peers.get(id);
      if (peer) {
        toast(`${peer.name} left`);
        removePeer(id);
        renderPeople();
      }
    });

    socket.on('disconnect', () => {
      if (intentionalLeave) return;
      // Tear down the mesh; on reconnect we rejoin with a fresh socket id
      // and renegotiate with everyone from scratch.
      Array.from(peers.keys()).forEach((id) => removePeer(id));
      renderPeople();
      if (joined) toast('Connection lost - reconnecting...', true);
    });
  }

  function enterCall() {
    joined = true;
    clearInterval(occupancyPoll);
    lobby.hidden = true;
    call.hidden = false;

    setToggleIcon(micBtn, 'mic', micOn);
    setToggleIcon(camBtn, 'cam', camOn);

    addTile(selfId, selfName, true);
    updateTileState(selfId);
    startTimer();
    setupAudioContext();
    watchLocalAudio();
    saveRecentRoom();
    renderPeople();
    toast('You joined the meeting');
  }

  function saveRecentRoom() {
    try {
      const recent = JSON.parse(localStorage.getItem('peerly-recent') || '[]').filter(
        (r) => r && r.roomId !== roomId
      );
      recent.unshift({ roomId, at: Date.now() });
      localStorage.setItem('peerly-recent', JSON.stringify(recent.slice(0, 5)));
    } catch { /* ignore */ }
  }

  // ================================================================
  // WEBRTC MESH
  // ================================================================

  function createPeer(info, initiator) {
    if (peers.has(info.id)) removePeer(info.id);

    const pc = new RTCPeerConnection(iceConfig);
    const peer = {
      pc,
      name: info.name,
      micOn: info.micOn,
      camOn: info.camOn,
      handRaised: !!info.handRaised,
      sharing: !!info.sharing,
      canShare: !!info.canShare,
      stream: null,
      pendingCandidates: []
    };
    peers.set(info.id, peer);
    addTile(info.id, info.name, false);
    updateTileState(info.id);

    pc.onicecandidate = (e) => {
      socket.emit('signal', { to: info.id, data: { candidate: e.candidate } });
    };

    pc.ontrack = (e) => {
      // Don't rely on e.streams: tracks attached remotely via replaceTrack
      // carry no stream id, so collect them into our own per-peer stream.
      if (!peer.stream) peer.stream = new MediaStream();
      if (!peer.stream.getTracks().includes(e.track)) peer.stream.addTrack(e.track);
      const video = document.querySelector(`#tile-${CSS.escape(info.id)} video`);
      if (video && video.srcObject !== peer.stream) {
        video.srcObject = peer.stream;
      }
      if (e.track.kind === 'audio') watchStreamAudio(info.id, peer.stream);
    };

    pc.onconnectionstatechange = () => {
      const label = document.querySelector(`#tile-${CSS.escape(info.id)} .tile-conn`);
      if (!label) return;
      switch (pc.connectionState) {
        case 'connected':
          label.hidden = true;
          break;
        case 'connecting':
          label.hidden = false;
          label.textContent = 'Connecting...';
          break;
        case 'disconnected':
          label.hidden = false;
          label.textContent = 'Reconnecting...';
          break;
        case 'failed':
          label.hidden = false;
          label.textContent = 'Connection failed';
          pc.restartIce();
          break;
      }
    };

    if (initiator) {
      // Fixed m-line plan: audio first, then video, sendrecv both ways.
      const audioTrack = localStream && localStream.getAudioTracks()[0];
      const cameraTrack = localStream && localStream.getVideoTracks()[0];
      if (audioTrack) pc.addTransceiver(audioTrack, { streams: [localStream] });
      else pc.addTransceiver('audio', { direction: 'sendrecv' });
      if (cameraTrack) pc.addTransceiver(cameraTrack, { streams: [localStream] });
      else pc.addTransceiver('video', { direction: 'sendrecv' });
      // If we are mid-screen-share when this peer appears, send the screen instead.
      if (sharing && screenStream) {
        const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video') ||
          pc.getTransceivers().map((t) => t.sender).find((s) => !s.track);
        if (sender) sender.replaceTrack(screenStream.getVideoTracks()[0]).catch(() => {});
      }
      makeOffer(info.id, pc);
    }
    return peer;
  }

  // Answerer side: reuse the transceivers created by the remote offer.
  function attachLocalTracks(pc) {
    const audioTrack = localStream && localStream.getAudioTracks()[0];
    const cameraTrack = localStream && localStream.getVideoTracks()[0];
    const videoTrack = sharing && screenStream ? screenStream.getVideoTracks()[0] : cameraTrack;
    pc.getTransceivers().forEach((t) => {
      const kind = t.receiver.track && t.receiver.track.kind;
      t.direction = 'sendrecv';
      if (kind === 'audio' && audioTrack) t.sender.replaceTrack(audioTrack).catch(() => {});
      if (kind === 'video' && videoTrack) t.sender.replaceTrack(videoTrack).catch(() => {});
      // Associate a stream id so the offerer's ontrack gets e.streams too.
      if (localStream && typeof t.sender.setStreams === 'function') {
        try { t.sender.setStreams(localStream); } catch { /* optional */ }
      }
    });
  }

  async function makeOffer(id, pc) {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('signal', { to: id, data: pc.localDescription.toJSON() });
    } catch (err) {
      console.error('offer error', err);
    }
  }

  async function flushCandidates(peer) {
    for (const c of peer.pendingCandidates) {
      await peer.pc.addIceCandidate(c || undefined).catch(() => {});
    }
    peer.pendingCandidates = [];
  }

  function removePeer(id) {
    const peer = peers.get(id);
    if (!peer) return;
    try { peer.pc.close(); } catch { /* already closed */ }
    peers.delete(id);
    stopWatchingAudio(id);
    if (focusedId === id) unfocusTile();
    const tile = $(`tile-${id}`);
    if (tile) tile.remove();
    layoutGrid();
  }

  // ================================================================
  // TILES / GRID
  // ================================================================

  function addTile(id, name, isSelf) {
    if ($(`tile-${id}`)) return;
    const tile = document.createElement('div');
    tile.className = 'tile' + (isSelf ? ' mirrored self-tile' : '');
    tile.id = `tile-${id}`;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    if (isSelf) {
      video.muted = true;
      if (localStream) video.srcObject = localStream;
    }
    tile.appendChild(video);

    const avatarWrap = document.createElement('div');
    avatarWrap.className = 'tile-avatar';
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = initials(name);
    avatarWrap.appendChild(avatar);
    tile.appendChild(avatarWrap);

    const hand = document.createElement('div');
    hand.className = 'tile-hand';
    hand.hidden = true;
    hand.innerHTML = `${ICONS.hand}<span>Hand raised</span>`;
    tile.appendChild(hand);

    const conn = document.createElement('div');
    conn.className = 'tile-conn';
    conn.hidden = isSelf;
    conn.textContent = 'Connecting...';
    tile.appendChild(conn);

    const nameTag = document.createElement('div');
    nameTag.className = 'tile-name';
    nameTag.innerHTML = ICONS.micOffSmall;
    const nameSpan = document.createElement('span');
    nameSpan.textContent = isSelf ? `${name} (you)` : name;
    nameTag.appendChild(nameSpan);
    tile.appendChild(nameTag);

    tile.title = 'Click to focus this tile';
    tile.addEventListener('click', () => {
      const tid = tile.id.slice(5);
      if (focusedId === tid) unfocusTile();
      else focusTile(tid);
    });

    if (focusedId && filmstrip) filmstrip.appendChild(tile);
    else videoGrid.appendChild(tile);
    layoutGrid();
  }

  function updateTileState(id) {
    const tile = $(`tile-${id}`);
    if (!tile) return;
    const isSelf = id === selfId;
    const state = isSelf
      ? { micOn, camOn, handRaised, sharing, name: selfName }
      : peers.get(id);
    if (!state) return;

    const showVideo = state.camOn || state.sharing;
    tile.classList.toggle('cam-off', !showVideo);
    tile.classList.toggle('mirrored', isSelf && !sharing);

    // SVG elements have no `hidden` IDL property, so toggle display directly.
    const micIcon = tile.querySelector('.mic-off-icon');
    if (micIcon) micIcon.style.display = state.micOn ? 'none' : '';

    const hand = tile.querySelector('.tile-hand');
    if (hand) hand.hidden = !state.handRaised;

    const nameSpan = tile.querySelector('.tile-name span');
    if (nameSpan) {
      const suffix = isSelf ? ' (you)' : '';
      const hostMark = id === hostId ? ' - host' : '';
      const presenting = state.sharing ? ' - presenting' : '';
      nameSpan.textContent = `${state.name}${suffix}${hostMark}${presenting}`;
    }
  }

  // ---- focus / spotlight view ----
  function focusTile(id, auto = false) {
    const tile = $(`tile-${id}`);
    if (!tile) return;
    if (!filmstrip) {
      filmstrip = document.createElement('div');
      filmstrip.className = 'filmstrip';
    }
    const prevFocused = videoGrid.querySelector('.tile.focused');
    if (prevFocused) prevFocused.classList.remove('focused');
    focusedId = id;
    focusAuto = auto;
    videoGrid.classList.add('focus-mode');
    document.querySelectorAll('.tile').forEach((t) => {
      if (t === tile) videoGrid.prepend(t);
      else filmstrip.appendChild(t);
    });
    tile.classList.add('focused');
    videoGrid.appendChild(filmstrip);
  }

  function unfocusTile() {
    focusedId = null;
    focusAuto = false;
    videoGrid.classList.remove('focus-mode');
    const focused = videoGrid.querySelector('.tile.focused');
    if (focused) focused.classList.remove('focused');
    if (filmstrip) {
      Array.from(filmstrip.children).forEach((t) => videoGrid.appendChild(t));
      filmstrip.remove();
    }
    layoutGrid();
  }

  // Compute the largest 16:9 tile size that fits all tiles in the grid.
  function layoutGrid() {
    if (focusedId) return; // focus layout is handled purely by CSS
    const n = videoGrid.children.length;
    if (n === 0) return;
    const W = videoGrid.clientWidth;
    const H = videoGrid.clientHeight;
    const gap = 10;
    let best = 160;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      let w = (W - gap * (cols - 1)) / cols;
      let h = (w * 9) / 16;
      const maxH = (H - gap * (rows - 1)) / rows;
      if (h > maxH) {
        h = maxH;
        w = (h * 16) / 9;
      }
      if (w > best) best = w;
    }
    videoGrid.style.setProperty('--tile-w', `${Math.floor(best)}px`);
  }

  new ResizeObserver(layoutGrid).observe(videoGrid);
  window.addEventListener('resize', layoutGrid);

  // ================================================================
  // ACTIVE SPEAKER DETECTION
  // ================================================================

  function setupAudioContext() {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    } catch { /* no audio analysis */ }
  }

  function watchStreamAudio(id, stream) {
    if (!audioCtx || analysers.has(id) || stream.getAudioTracks().length === 0) return;
    try {
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      analysers.set(id, { analyser, data: new Uint8Array(analyser.frequencyBinCount), source });
    } catch { /* ignore */ }
  }

  function watchLocalAudio() {
    if (localStream) watchStreamAudio(selfId, localStream);
  }

  function stopWatchingAudio(id) {
    const entry = analysers.get(id);
    if (entry) {
      try { entry.source.disconnect(); } catch { /* ignore */ }
      analysers.delete(id);
    }
  }

  setInterval(() => {
    if (!joined) return;
    analysers.forEach(({ analyser, data }, id) => {
      const isSelf = id === selfId;
      const peer = peers.get(id);
      const muted = isSelf ? !micOn : (peer ? !peer.micOn : true);
      let level = 0;
      if (!muted) {
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        level = sum / data.length;
      }
      const tile = $(`tile-${id}`);
      if (tile) tile.classList.toggle('speaking', level > 22);
    });
  }, 250);

  // ================================================================
  // CONTROLS
  // ================================================================

  function broadcastState() {
    if (socket && joined) socket.emit('state', { micOn, camOn, handRaised, sharing });
  }

  function toggleMic() {
    if (!localStream || localStream.getAudioTracks().length === 0) {
      toast('No microphone available', true);
      return;
    }
    micOn = !micOn;
    applyLocalTrackStates();
    setToggleIcon(micBtn, 'mic', micOn);
    updateTileState(selfId);
    broadcastState();
  }

  function toggleCam() {
    if (!localStream || localStream.getVideoTracks().length === 0) {
      toast('No camera available', true);
      return;
    }
    camOn = !camOn;
    applyLocalTrackStates();
    setToggleIcon(camBtn, 'cam', camOn);
    updateTileState(selfId);
    broadcastState();
  }

  function toggleHand() {
    handRaised = !handRaised;
    handBtn.classList.toggle('active', handRaised);
    updateTileState(selfId);
    broadcastState();
  }

  micBtn.addEventListener('click', toggleMic);
  camBtn.addEventListener('click', toggleCam);
  handBtn.addEventListener('click', toggleHand);

  // --- screen share ---
  function eachVideoSender(fn) {
    peers.forEach(({ pc }) => {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video') ||
        pc.getTransceivers().map((t) => t.sender).find((s) => !s.track);
      if (sender) fn(sender);
    });
  }

  async function startShare() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15 } },
        audio: false
      });
    } catch {
      return; // user cancelled the picker
    }
    screenStream = stream;
    const screenTrack = screenStream.getVideoTracks()[0];
    sharing = true;
    shareBtn.classList.add('active');

    eachVideoSender((sender) => sender.replaceTrack(screenTrack).catch(() => {}));

    const selfVideo = document.querySelector(`#tile-${CSS.escape(selfId)} video`);
    if (selfVideo) selfVideo.srcObject = screenStream;

    screenTrack.onended = stopShare;
    updateTileState(selfId);
    broadcastState();
    toast('You are sharing your screen');
  }

  function stopShare() {
    if (!sharing) return;
    sharing = false;
    shareBtn.classList.remove('active');
    stopStream(screenStream);
    screenStream = null;

    const cameraTrack = localStream ? localStream.getVideoTracks()[0] || null : null;
    eachVideoSender((sender) => sender.replaceTrack(cameraTrack).catch(() => {}));

    const selfVideo = document.querySelector(`#tile-${CSS.escape(selfId)} video`);
    if (selfVideo) selfVideo.srcObject = localStream;

    updateTileState(selfId);
    broadcastState();
    toast('Screen sharing stopped');
  }

  shareBtn.addEventListener('click', () => {
    if (sharing) return stopShare();
    if (selfId === hostId || selfCanShare) return startShare();
    socket.emit('share-request');
    toast('Asked the host for permission to share');
  });

  // --- recording (records the screen/tab you pick, mixed with your microphone) ---
  async function startRecording() {
    let displayStream;
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true // tab/system audio where the browser supports it
      });
    } catch {
      return; // user cancelled
    }

    const tracks = [...displayStream.getVideoTracks()];
    let mixCtx = null;
    try {
      mixCtx = new AudioContext();
      const dest = mixCtx.createMediaStreamDestination();
      if (displayStream.getAudioTracks().length > 0) {
        mixCtx.createMediaStreamSource(new MediaStream(displayStream.getAudioTracks())).connect(dest);
      }
      if (localStream && localStream.getAudioTracks().length > 0) {
        mixCtx.createMediaStreamSource(new MediaStream(localStream.getAudioTracks())).connect(dest);
      }
      if (dest.stream.getAudioTracks().length > 0) tracks.push(...dest.stream.getAudioTracks());
    } catch { /* record without audio mixing */ }
    recordStream = { displayStream, mixCtx };

    recordedChunks = [];
    const combined = new MediaStream(tracks);
    try {
      mediaRecorder = new MediaRecorder(combined, { mimeType: 'video/webm' });
    } catch {
      mediaRecorder = new MediaRecorder(combined);
    }
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `peerly-${roomId}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.webm`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast('Recording saved to your downloads');
    };
    displayStream.getVideoTracks()[0].onended = stopRecording;
    mediaRecorder.start(1000);
    recordBtn.classList.add('recording');
    recIndicator.hidden = false;
    toast('Recording started (pick the tab or screen showing this call)');
  }

  function stopRecording() {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
    mediaRecorder.stop();
    if (recordStream) {
      stopStream(recordStream.displayStream);
      if (recordStream.mixCtx) recordStream.mixCtx.close().catch(() => {});
      recordStream = null;
    }
    recordBtn.classList.remove('recording');
    recIndicator.hidden = true;
  }

  recordBtn.addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') stopRecording();
    else startRecording();
  });

  // --- leave ---
  function leave() {
    intentionalLeave = true;
    stopRecording();
    stopShare();
    if (socket) {
      socket.emit('leave');
      socket.disconnect();
    }
    Array.from(peers.keys()).forEach((id) => removePeer(id));
    stopStream(localStream);
    location.href = '/?left=1';
  }
  leaveBtn.addEventListener('click', leave);
  window.addEventListener('beforeunload', () => {
    if (socket && joined) socket.emit('leave');
  });

  copyLinkBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(meetingLink());
      toast('Meeting link copied');
    } catch {
      toast(meetingLink());
    }
  });

  // ================================================================
  // PANELS: CHAT + PEOPLE
  // ================================================================

  function togglePanel(panel) {
    const other = panel === chatPanel ? peoplePanel : chatPanel;
    other.hidden = true;
    panel.hidden = !panel.hidden;
    chatBtn.classList.toggle('active', !chatPanel.hidden);
    peopleBtn.classList.toggle('active', !peoplePanel.hidden);
    if (!chatPanel.hidden) {
      unreadChats = 0;
      chatBadge.hidden = true;
      chatInput.focus();
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
    layoutGrid();
  }

  chatBtn.addEventListener('click', () => togglePanel(chatPanel));
  peopleBtn.addEventListener('click', () => togglePanel(peoplePanel));
  document.querySelectorAll('.panel-close').forEach((btn) => {
    btn.addEventListener('click', () => togglePanel($(btn.dataset.close)));
  });

  const URL_RE = /(https?:\/\/[^\s<>"']+)/;

  function addChatMessage(name, text, ts, isSelf) {
    const empty = chatMessages.querySelector('.chat-empty');
    if (empty) empty.remove();

    const msg = document.createElement('div');
    msg.className = 'chat-msg';

    const meta = document.createElement('div');
    meta.className = 'chat-msg-meta';
    const who = document.createElement('span');
    who.className = 'who' + (isSelf ? ' self' : '');
    who.textContent = isSelf ? 'You' : name;
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    meta.append(who, when);

    const body = document.createElement('div');
    body.className = 'chat-msg-text';
    // Linkify URLs safely using DOM nodes (never innerHTML with user text).
    text.split(new RegExp(URL_RE.source, 'g')).forEach((part) => {
      if (!part) return;
      if (URL_RE.test(part) && part.startsWith('http')) {
        const a = document.createElement('a');
        a.href = part;
        a.textContent = part;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        body.appendChild(a);
      } else {
        body.appendChild(document.createTextNode(part));
      }
    });

    msg.append(meta, body);
    chatMessages.appendChild(msg);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text || !socket) return;
    socket.emit('chat', text);
    chatInput.value = '';
  });

  function renderPeople() {
    const entries = [];
    if (joined) {
      entries.push({ id: selfId, name: selfName, micOn, camOn, handRaised, sharing, canShare: selfCanShare, isSelf: true });
    }
    peers.forEach((p, id) => {
      entries.push({ id, name: p.name, micOn: p.micOn, camOn: p.camOn, handRaised: p.handRaised, sharing: p.sharing, canShare: p.canShare, isSelf: false });
    });

    peopleCount.textContent = `(${entries.length})`;
    peopleBadge.textContent = String(entries.length);
    peopleList.innerHTML = '';

    entries.forEach((p) => {
      const li = document.createElement('li');

      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.textContent = initials(p.name);

      const mid = document.createElement('div');
      mid.className = 'people-mid';

      const name = document.createElement('div');
      name.className = 'people-name';
      name.textContent = p.name;
      const tags = [];
      if (p.isSelf) tags.push('you');
      if (p.id === hostId) tags.push('host');
      if (tags.length) {
        const tag = document.createElement('span');
        tag.className = 'you';
        tag.textContent = ` (${tags.join(', ')})`;
        name.appendChild(tag);
      }
      mid.appendChild(name);

      // Host-only controls: grant/revoke presenting, hand over the host role.
      if (selfId === hostId && !p.isSelf) {
        const actions = document.createElement('div');
        actions.className = 'people-actions';

        const shareToggle = document.createElement('button');
        shareToggle.className = 'mini-btn' + (p.canShare ? ' mini-btn-on' : '');
        shareToggle.textContent = p.canShare ? 'Revoke share' : 'Allow share';
        shareToggle.addEventListener('click', () => {
          socket.emit('set-share-permission', { id: p.id, allowed: !p.canShare });
        });

        const makeHost = document.createElement('button');
        makeHost.className = 'mini-btn';
        makeHost.textContent = 'Make host';
        makeHost.addEventListener('click', () => {
          socket.emit('transfer-host', { id: p.id });
        });

        actions.append(shareToggle, makeHost);
        mid.appendChild(actions);
      }

      const flags = document.createElement('div');
      flags.className = 'people-flags';
      flags.innerHTML = `
        <span class="flag-hand" ${p.handRaised ? '' : 'hidden'} title="Hand raised">${ICONS.hand}</span>
        <span class="flag-sharing" ${p.sharing ? '' : 'hidden'} title="Presenting">${ICONS.share}</span>
        <span class="flag-mic-off" ${p.micOn ? 'hidden' : ''} title="Muted">${ICONS.micOffSmall}</span>`;

      li.append(avatar, mid, flags);
      peopleList.appendChild(li);
    });
  }

  // ================================================================
  // TIMER, SHORTCUTS
  // ================================================================

  function startTimer() {
    const startedAt = Date.now();
    timerInterval = setInterval(() => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      const hh = Math.floor(s / 3600);
      const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      callTimer.textContent = hh > 0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
    }, 1000);
  }

  document.addEventListener('keydown', (e) => {
    if (!joined) return;
    const target = e.target;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key.toLowerCase()) {
      case 'm': toggleMic(); break;
      case 'v': toggleCam(); break;
      case 'h': toggleHand(); break;
      case 'c': togglePanel(chatPanel); break;
      case 'p': togglePanel(peoplePanel); break;
      case '?': shortcutsOverlay.hidden = false; break;
      case 'escape':
        if (!shortcutsOverlay.hidden) shortcutsOverlay.hidden = true;
        else if (focusedId) unfocusTile();
        break;
    }
  });
  shortcutsClose.addEventListener('click', () => { shortcutsOverlay.hidden = true; });
  shortcutsOverlay.addEventListener('click', (e) => {
    if (e.target === shortcutsOverlay) shortcutsOverlay.hidden = true;
  });

  // Seed the empty-chat hint.
  const hint = document.createElement('p');
  hint.className = 'chat-empty';
  hint.textContent = 'Messages are only visible to people in the call and disappear when the meeting ends.';
  chatMessages.appendChild(hint);
})();

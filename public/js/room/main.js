// Composition root for the meeting page: creates the modules and wires them
// to each other.

import { $, toast, announce, setIcon, openMenu, openDialog, copyToClipboard, formatDuration } from './ui.js';
import { installErrorReporting } from './telemetry.js';
import { loadSession, prefs, rememberRoom } from './session.js';
import { BackgroundProcessor } from './effects.js';
import { LocalMedia } from './media.js';
import { AudioMonitor } from './audio.js';
import { Stage } from './stage.js';
import { CallController } from './call.js';
import { ChatPanel } from './chat.js';
import { PeoplePanel } from './people.js';
import { Reactions } from './reactions.js';
import { Notes } from './notes.js';
import { Recorder } from './recording.js';
import { EffectsDialog } from './effects-ui.js';
import { SettingsDialog } from './settings-ui.js';
import { Lobby } from './lobby.js';

installErrorReporting();

const roomId = location.pathname.split('/').filter(Boolean).pop();
const meetingLink = `${location.origin}/room/${roomId}`;

const DEFAULT_FEATURES = {
  protocolVersion: 2,
  ai: false,
  maxRoomSize: 8,
  reactions: ['💖', '👍', '🎉', '👏', '😂', '😮', '😢', '🤔', '👎', '🔥'],
  effects: null
};

async function loadFeatures() {
  try {
    const response = await fetch('/api/config');
    if (response.ok) return { ...DEFAULT_FEATURES, ...(await response.json()) };
  } catch {
    /* fall back to defaults */
  }
  return DEFAULT_FEATURES;
}

const features = await loadFeatures();

const effects = features.effects && BackgroundProcessor.supported() ? new BackgroundProcessor(features.effects) : null;
const media = new LocalMedia({ effects });
const audioMonitor = new AudioMonitor();
const call = new CallController({ roomId, media, features });
const stage = new Stage({
  grid: $('#videoGrid'),
  getParticipant: (pid) => call.participant(pid),
  selfPid: () => call.self.pid
});

const chat = new ChatPanel({ call, onUnread: (count) => setBadge($('#chatBadge'), count) });
const people = new PeoplePanel({
  call,
  onMessagePrivately: (pid) => {
    openPanel('chat');
    chat.setRecipient(pid);
  },
  onPin: (pid) => stage.togglePin(`${pid}:camera`)
});
const reactions = new Reactions({ call, stage });
const notes = new Notes({ call, onUnread: (count) => setBadge($('#notesBadge'), count) });
const recorder = new Recorder({ call });
const effectsDialog = new EffectsDialog({ media });
const settingsDialog = new SettingsDialog({
  media,
  audioMonitor,
  onDataSaverChange: (on) => {
    call.peers.setDataSaver(on);
    stage.setDataSaver(on);
  }
});
const lobby = new Lobby({
  roomId,
  media,
  audioMonitor,
  onJoin: ({ name }) => call.start({ name }),
  onOpenEffects: () => effectsDialog.open()
});

// ----------------------------------------------------------------- banners

const banners = new Map();
const BANNER_PRIORITY = ['upgrade', 'connection', 'autoplay', 'info'];

function renderBanner() {
  const key = BANNER_PRIORITY.find((name) => banners.has(name));
  const banner = $('#appBanner');
  if (!key) {
    banner.hidden = true;
    return;
  }
  const { text, tone, action } = banners.get(key);
  banner.hidden = false;
  banner.className = `app-banner app-banner-${tone || 'info'}`;
  $('#appBannerText').textContent = text;
  const button = $('#appBannerAction');
  button.hidden = !action;
  if (action) {
    button.textContent = action.label;
    button.onclick = action.onSelect;
  }
}

function showBanner(key, text, tone = 'info', action = null) {
  banners.set(key, { text, tone, action });
  renderBanner();
}

function hideBanner(key) {
  banners.delete(key);
  renderBanner();
}

// ------------------------------------------------------------------ panels

const PANELS = {
  chat: { el: $('#chatPanel'), button: $('#chatBtn') },
  people: { el: $('#peoplePanel'), button: $('#peopleBtn') },
  notes: { el: $('#notesPanel'), button: $('#notesBtn') }
};
let activePanel = null;

function openPanel(name) {
  activePanel = name;
  for (const [key, panel] of Object.entries(PANELS)) {
    const active = key === name;
    panel.el.hidden = !active;
    panel.button.classList.toggle('active', active);
    panel.button.setAttribute('aria-expanded', String(active));
  }
  if (name === 'chat') chat.open();
  if (name === 'notes') notes.markRead();
  stage.layout();
}

function togglePanel(name) {
  openPanel(activePanel === name ? null : name);
}

function setBadge(badge, count) {
  if (!badge) return;
  badge.hidden = !count;
  badge.textContent = count > 9 ? '9+' : String(count || '');
}

// ---------------------------------------------------------------- controls

function updateControls() {
  const micBtn = $('#micBtn');
  const camBtn = $('#camBtn');
  micBtn.dataset.on = String(media.micOn);
  camBtn.dataset.on = String(media.camOn);
  setIcon(micBtn, media.micOn ? 'mic' : 'micOff', 22);
  setIcon(camBtn, media.camOn ? 'cam' : 'camOff', 22);
  micBtn.title = media.micOn ? 'Turn off microphone (M)' : 'Turn on microphone (M)';
  camBtn.title = media.camOn ? 'Turn off camera (V)' : 'Turn on camera (V)';
  micBtn.setAttribute('aria-label', micBtn.title);
  camBtn.setAttribute('aria-label', camBtn.title);

  const shareBtn = $('#shareBtn');
  shareBtn.classList.toggle('active', media.sharing);
  setIcon(shareBtn, media.sharing ? 'stopShare' : 'share', 22);
  shareBtn.title = media.sharing ? 'Stop presenting' : 'Present your screen';

  const handBtn = $('#handBtn');
  handBtn.classList.toggle('active', call.handRaised);
  handBtn.setAttribute('aria-pressed', String(call.handRaised));

  $('#recPill').hidden = !recorder.active;
  $('#transcribingPill').hidden = !call.transcription.on;
  $('#lockedPill').hidden = !call.settings.locked;
  $('#peopleBadge').textContent = String(call.allParticipants().length);
}

/** Attaches a remote participant's current streams to their tiles. */
function bindRemoteStreams(participant) {
  if (participant.isSelf) return;
  const link = call.peers.links.get(participant.pid);
  if (!link) return;
  if (link.streams.camera) stage.bindStream(participant.pid, 'camera', link.streams.camera);
  if (participant.sharing && link.streams.screen) stage.bindStream(participant.pid, 'screen', link.streams.screen);
}

function syncParticipantTiles(participant, handQueue = call.handQueue()) {
  stage.syncParticipant(participant, { hostPid: call.hostPid, handQueue });
  bindRemoteStreams(participant);
}

function syncStage() {
  if (call.phase !== 'call' || !call.self.pid) return; // nothing to show before joining
  const handQueue = call.handQueue();
  for (const participant of call.allParticipants()) syncParticipantTiles(participant, handQueue);
  const preview = media.previewStream;
  if (call.self.pid && preview) stage.bindStream(call.self.pid, 'camera', preview);
  if (call.self.pid && media.screenTrack) {
    stage.bindStream(call.self.pid, 'screen', new MediaStream([media.screenTrack]));
  }
  updateControls();
}

async function toggleShare() {
  if (media.sharing) {
    call.stopShare();
    return;
  }
  if (!call.canPresent()) {
    const result = await call.requestShare();
    if (result.allowed) {
      await call.startShare();
      return;
    }
    toast(result.ok ? 'Asked the host for permission to present' : result.error || 'Could not ask the host right now.', {
      tone: result.ok ? 'info' : 'error'
    });
    return;
  }
  await call.startShare();
}

// ------------------------------------------------------------- media events

media.addEventListener('tracks', (event) => {
  const kinds = event.detail.kinds;
  if (kinds.includes('audio')) audioMonitor.watch('self', media.micTrack, { clone: true });
  if (kinds.includes('camera') || kinds.includes('screen')) syncStage();
});
media.addEventListener('preview', () => {
  if (call.phase === 'call') syncStage();
});
media.addEventListener('state', () => {
  if (call.phase === 'call') syncStage();
  else lobby.render();
});
media.addEventListener('speaker', (event) => stage.setSinkId(event.detail));
media.addEventListener('device-lost', (event) => {
  const { kind, recovered } = event.detail;
  toast(
    recovered ? `Your ${kind} was disconnected — switched to the default one.` : `Your ${kind} was disconnected.`,
    { tone: recovered ? 'info' : 'error' }
  );
});
media.addEventListener('effect-error', () => {
  toast('Background effects couldn’t start on this device.', { tone: 'error' });
});

// -------------------------------------------------------------- call events

call.on('joined', () => enterCall());
call.on('resumed', () => {
  syncStage();
  hideBanner('connection');
});
call.on('participants', syncStage);
call.on('participant-added', () => syncStage());
call.on('participant-updated', (participant) => syncParticipantTiles(participant));
call.on('participant-removed', ({ pid }) => {
  stage.removeParticipant(pid);
  audioMonitor.unwatch(pid);
  updateControls();
});
call.on('self-updated', syncStage);
call.on('settings', updateControls);
call.on('transcription', updateControls);

let knownHostPid = null;
call.on('host-changed', (hostPid) => {
  // Only announce real hand-overs, not the initial assignment or a resync.
  const previous = knownHostPid;
  knownHostPid = hostPid;
  if (previous && previous !== hostPid) {
    if (hostPid === call.self.pid) toast('You are now the host');
    else {
      const host = call.participant(hostPid);
      if (host && !host.isSelf) toast(`${host.name} is now the host`);
    }
  }
  updateControls();
});

call.on('notice', ({ type, name, message }) => {
  switch (type) {
    case 'joined':
      toast(`${name} joined`);
      announce(`${name} joined the meeting`);
      break;
    case 'left':
      toast(`${name} left`);
      break;
    case 'hand':
      toast(`${name} raised a hand`, { id: `hand-${name}` });
      break;
    case 'presenting':
      toast(`${name} started presenting`);
      break;
    case 'recording':
      toast(`${name} is recording this meeting`, { tone: 'warn', timeout: 9000 });
      break;
    case 'hand-lowered':
      toast('The host lowered your hand');
      break;
    case 'share-error':
      toast(message || 'Could not start presenting.', { tone: 'error' });
      break;
    default:
      break;
  }
});

call.on('forced', async ({ kind, by }) => {
  if (kind === 'mic' && media.micOn) {
    await call.toggleMic(false);
    toast(`${by || 'The host'} muted you`);
  } else if (kind === 'camera' && media.camOn) {
    await call.toggleCamera(false);
    toast(`${by || 'The host'} turned off your camera`);
  }
});

call.on('knock', ({ requestId, name }) => {
  toast(`${name} wants to join`, {
    id: `knock-${requestId}`,
    timeout: 60000,
    actions: [
      { label: 'Admit', primary: true, onSelect: () => call.respondToKnock(requestId, true) },
      { label: 'Deny', onSelect: () => call.respondToKnock(requestId, false) }
    ]
  });
});

call.on('share-request', ({ pid, name }) => {
  toast(`${name} wants to present`, {
    timeout: 45000,
    actions: [
      { label: 'Allow', primary: true, onSelect: () => call.setSharePermission(pid, true) },
      { label: 'Deny', onSelect: () => call.setSharePermission(pid, false) }
    ]
  });
});

call.on('share-permission', ({ allowed }) => {
  if (allowed) {
    // Browsers need a fresh click to open the screen picker.
    toast('The host allowed you to present', {
      actions: [{ label: 'Share screen', primary: true, onSelect: () => call.startShare() }]
    });
  } else if (media.sharing) {
    call.stopShare();
    toast('The host stopped your presentation', { tone: 'warn' });
  }
});

call.on('connection', (state) => {
  if (state === 'online') hideBanner('connection');
  else if (state === 'offline') showBanner('connection', 'You’re offline. Peerly will reconnect automatically.', 'warn');
  else if (state === 'reconnecting') {
    showBanner('connection', 'Reconnecting to the meeting… people can still see and hear you.', 'warn');
  }
});
call.on('server-restarting', () =>
  showBanner('connection', 'Peerly is updating. Your call keeps running and will reconnect in a moment.', 'info')
);
call.on('upgrade-required', () =>
  showBanner('upgrade', 'Peerly was updated. Reload the page to rejoin.', 'warn', {
    label: 'Reload',
    onSelect: () => location.reload()
  })
);

call.on('waiting-state', ({ hostConnected }) => {
  lobby.hide();
  $('#waiting').hidden = false;
  $('#waitingText').textContent = hostConnected
    ? 'You’ll join the call as soon as someone lets you in.'
    : 'Waiting for the host to arrive and let you in.';
});

call.on('knock-denied', ({ reason }) => {
  $('#waiting').hidden = true;
  lobby.show();
  lobby.setError(
    reason === 'timeout'
      ? 'No one answered your request to join.'
      : reason === 'ended'
        ? 'The meeting ended before you were let in.'
        : 'Your request to join was declined.'
  );
});

call.on('join-error', (result) => {
  $('#waiting').hidden = true;
  lobby.show();
  lobby.setError(result.error || 'Could not join this meeting.');
});

call.on('connect-error', () => {
  if (call.phase === 'joining') lobby.setError('Can’t reach the meeting server. Retrying…');
});

call.on('phase', (phase) => {
  if (phase === 'call') {
    $('#waiting').hidden = true;
    lobby.hide();
  }
});

call.on('ended', ({ reason, reportId, by, message }) => {
  endCall({ reason, reportId, by, message });
});

call.on('reaction', (payload) => reactions.receive(payload));

// ------------------------------------------------------------- peer events

call.peers.on('track', ({ pid, source, track }) => {
  // Screen transceivers exist from the start; their tile only appears while
  // that person is actually presenting (see bindRemoteStreams).
  const participant = call.participant(pid);
  if (participant) bindRemoteStreams(participant);
  if (track.kind === 'audio' && source === 'camera') audioMonitor.watch(pid, track);
});
call.peers.on('link-state', ({ pid, state }) => stage.setLinkState(pid, state));
call.peers.on('connected', ({ pid }) => stage.resendViews(pid));
call.peers.on('quality', (info) => {
  stage.setQuality(info.pid, info);
  trackLocalQuality(info);
});
call.peers.on('frozen', ({ pid, source, frozen }) => stage.setFrozen(pid, source, frozen));

// ------------------------------------------------------------ stage events

stage.on('view', ({ pid, source, view, force }) => {
  if (force) call.peers.sentViews.delete(`${pid}:${source}`);
  call.sendView({ to: pid, view, source });
});
stage.on('menu', ({ pid, anchor }) => {
  const participant = call.participant(pid);
  if (participant) people.openMenu(anchor, participant);
});
stage.on('stop-presenting', () => call.stopShare());
stage.on('autoplay-blocked', () =>
  showBanner('autoplay', 'Click to turn on sound for this meeting.', 'info', {
    label: 'Turn on sound',
    onSelect: () => {
      stage.retryPlayback();
      audioMonitor.resume();
      hideBanner('autoplay');
    }
  })
);

// ------------------------------------------------------- local audio signals

let talkMs = 0;
let speakingSince = 0;
let lastMutedHint = 0;

audioMonitor.on('speaking', ({ id, speaking }) => {
  const pid = id === 'self' ? call.self.pid : id;
  if (pid) stage.setSpeaking(pid, speaking);
  if (id !== 'self') return;
  if (speaking && media.micOn) speakingSince = Date.now();
  else if (!speaking && speakingSince) {
    talkMs += Date.now() - speakingSince;
    speakingSince = 0;
  }
  if (speaking && !media.micOn && Date.now() - lastMutedHint > 30000 && call.phase === 'call') {
    lastMutedHint = Date.now();
    toast('You’re muted — press M or click the microphone to talk', {
      id: 'muted-hint',
      actions: [{ label: 'Unmute', primary: true, onSelect: () => call.toggleMic(true) }]
    });
  }
});

audioMonitor.on('levels', (levels) => {
  for (const [id, level] of levels) {
    const pid = id === 'self' ? call.self.pid : id;
    if (pid) stage.setLevel(pid, level);
  }
});

setInterval(() => {
  if (call.phase !== 'call') return;
  if (speakingSince && media.micOn) {
    talkMs += Date.now() - speakingSince;
    speakingSince = Date.now();
  }
  if (talkMs > 500) {
    call.reportTalkTime(talkMs);
    talkMs = 0;
  }
}, 15000);

// Local network health: warn when most links report trouble.
const linkQuality = new Map();
function trackLocalQuality({ pid, quality, limitation }) {
  linkQuality.set(pid, { quality, limitation, at: Date.now() });
  const recent = [...linkQuality.values()].filter((entry) => Date.now() - entry.at < 8000);
  const poor = recent.filter((entry) => entry.quality === 'poor').length;
  const pill = $('#netPill');
  const struggling = recent.length > 0 && poor >= Math.max(1, Math.ceil(recent.length / 2));
  pill.hidden = !struggling;
  if (struggling) {
    pill.title = 'Your connection is having trouble. Video quality is reduced.';
  }
}

// -------------------------------------------------------------- call screen

let timerInterval = null;
let wakeLock = null;

async function acquireWakeLock() {
  try {
    wakeLock = (await navigator.wakeLock?.request('screen')) || null;
  } catch {
    /* not critical */
  }
}

function enterCall() {
  $('#call').hidden = false;
  $('#callRoomId').textContent = roomId;
  $('#controlsRoom').textContent = roomId;
  rememberRoom(roomId);
  audioMonitor.resume();
  audioMonitor.watch('self', media.micTrack, { clone: true });
  stage.ensure(call.self.pid, 'camera');
  syncStage();
  stage.setSinkId(media.speakerDeviceId);
  updateControls();
  acquireWakeLock();

  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    $('#callTimer').textContent = formatDuration(Date.now() - (call.startedAt || Date.now()));
    $('#controlsClock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }, 1000);
  $('#callTimer').textContent = '00:00';
  $('#controlsClock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const dataSaver = prefs.get('dataSaver', false);
  if (dataSaver) {
    call.peers.setDataSaver(true);
    stage.setDataSaver(true);
  }
  announce('You joined the meeting');
}

function endCall({ reason, reportId, by, message }) {
  clearInterval(timerInterval);
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
  stage.clearAll();
  audioMonitor.destroy();
  recorder.stop();
  lobby.hide();
  $('#call').hidden = true;
  $('#waiting').hidden = true;
  banners.clear();
  renderBanner();

  const titles = {
    left: 'You left the meeting',
    removed: 'You were removed from the meeting',
    ended: 'The meeting has ended',
    replaced: 'You opened this meeting somewhere else',
    error: 'You were disconnected'
  };
  const texts = {
    left: 'Thanks for using Peerly.',
    removed: `${by || 'The host'} removed you from this meeting.`,
    ended: `${by || 'The host'} ended the meeting for everyone.`,
    replaced: 'This meeting is open in another tab or window.',
    error: message || 'The connection to the meeting was lost.'
  };
  $('#endedTitle').textContent = titles[reason] || titles.left;
  $('#endedText').textContent = texts[reason] || '';
  $('#rejoinBtn').hidden = reason === 'removed' || reason === 'replaced';

  const reportBox = $('#endedReport');
  reportBox.hidden = !reportId;
  if (reportId) {
    const link = $('#endedReportLink');
    link.href = `/report/${reportId}`;
    $('#endedReportText').textContent =
      reason === 'ended' || reason === 'left'
        ? 'AI notes and the transcript will appear here once everyone leaves.'
        : 'Your meeting notes will be here when the meeting ends.';
  }
  $('#ended').hidden = false;
}

// ------------------------------------------------------------------ buttons

$('#micBtn').addEventListener('click', async () => {
  const ok = await call.toggleMic();
  if (!ok) toast(media.errors.mic || 'No microphone available', { tone: 'error' });
});
$('#camBtn').addEventListener('click', async () => {
  const ok = await call.toggleCamera();
  if (!ok) toast(media.errors.cam || 'No camera available', { tone: 'error' });
});
$('#shareBtn').addEventListener('click', toggleShare);
$('#handBtn').addEventListener('click', () => {
  call.setHand(!call.handRaised);
  toast(call.handRaised ? 'Hand raised' : 'Hand lowered', { id: 'own-hand', timeout: 2000 });
});
$('#chatBtn').addEventListener('click', () => togglePanel('chat'));
$('#peopleBtn').addEventListener('click', () => togglePanel('people'));
$('#notesBtn').addEventListener('click', () => togglePanel('notes'));
for (const button of document.querySelectorAll('.panel-close')) {
  button.addEventListener('click', () => openPanel(null));
}

$('#moreBtn').addEventListener('click', (event) => {
  openMenu(event.currentTarget, [
    { label: 'Backgrounds and effects', icon: 'effects', hint: 'B', onSelect: () => effectsDialog.open() },
    canCaptureScreen && {
      label: recorder.active ? 'Stop recording' : 'Record the meeting',
      icon: 'record',
      onSelect: () => recorder.toggle().then(updateControls)
    },
    { label: 'Transcript and AI notes', icon: 'sparkles', hint: 'N', onSelect: () => togglePanel('notes') },
    {
      label: 'Data saver',
      icon: 'leaf',
      checked: prefs.get('dataSaver', false),
      onSelect: () => {
        const next = !prefs.get('dataSaver', false);
        prefs.set('dataSaver', next);
        $('#dataSaverToggle').checked = next;
        call.peers.setDataSaver(next);
        stage.setDataSaver(next);
        toast(next ? 'Data saver on — video quality is reduced' : 'Data saver off');
      }
    },
    'separator',
    { label: 'Settings', icon: 'settings', onSelect: () => settingsDialog.open() },
    {
      label: document.fullscreenElement ? 'Exit full screen' : 'Full screen',
      icon: 'expand',
      onSelect: () => {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else document.documentElement.requestFullscreen?.().catch(() => {});
      }
    },
    { label: 'Keyboard shortcuts', icon: 'keyboard', hint: '?', onSelect: () => openDialog($('#shortcutsDialog')) }
  ]);
});

$('#leaveBtn').addEventListener('click', (event) => {
  if (!call.isHost()) {
    call.leave();
    return;
  }
  openMenu(event.currentTarget, [
    { label: 'Leave the meeting', icon: 'leave', onSelect: () => call.leave() },
    {
      label: 'End the meeting for everyone',
      icon: 'userMinus',
      danger: true,
      onSelect: () => $('#endForAllBtn').click()
    }
  ]);
});

for (const button of [$('#copyLinkBtn'), $('#copyInviteBtn')]) {
  button.addEventListener('click', async () => {
    const copied = await copyToClipboard(meetingLink);
    toast(copied ? 'Meeting link copied' : meetingLink, { id: 'copy-link' });
  });
}
$('#copyReportBtn').addEventListener('click', async () => {
  const url = `${location.origin}/report/${call.transcription.reportId}`;
  const copied = await copyToClipboard(url);
  toast(copied ? 'Notes link copied' : url, { id: 'copy-report' });
});

$('#cancelKnockBtn').addEventListener('click', () => {
  call.cancelKnock();
  $('#waiting').hidden = true;
  lobby.show();
});
$('#rejoinBtn').addEventListener('click', () => location.reload());

// ---------------------------------------------------------------- shortcuts

document.addEventListener('keydown', (event) => {
  if (call.phase !== 'call') return;
  const target = event.target;
  if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  switch (event.key.toLowerCase()) {
    case 'm':
      event.preventDefault();
      $('#micBtn').click();
      break;
    case 'v':
      event.preventDefault();
      $('#camBtn').click();
      break;
    case 'h':
      $('#handBtn').click();
      break;
    case 'c':
      togglePanel('chat');
      break;
    case 'p':
      togglePanel('people');
      break;
    case 'n':
      togglePanel('notes');
      break;
    case 'l':
      notes.toggleCaptions();
      break;
    case 'e':
      reactions.toggleTray();
      break;
    case 'b':
      effectsDialog.open();
      break;
    case '?':
      openDialog($('#shortcutsDialog'));
      break;
    case 'escape':
      if (stage.focusedKey) stage.unfocus();
      else if (activePanel) openPanel(null);
      break;
    default:
      break;
  }
});

// A first click also unblocks audio playback where autoplay was denied.
document.addEventListener(
  'pointerdown',
  () => {
    audioMonitor.resume();
    if (banners.has('autoplay')) {
      stage.retryPlayback();
      hideBanner('autoplay');
    }
  },
  { capture: true }
);

// --------------------------------------------------------------- start-up

// Most phones can't capture the screen; don't offer what can't work.
const canCaptureScreen = Boolean(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
if (!canCaptureScreen) $('#shareBtn').hidden = true;

chat.init();
people.init();
reactions.init();
notes.init();
effectsDialog.init();
settingsDialog.init();
lobby.init();

// Everything below is wired up; let people join even while the camera
// and microphone are still starting.
document.body.dataset.ready = 'true';

const stored = loadSession(roomId);
const autoRejoin = Boolean(stored?.inCall && stored.name && Date.now() - (stored.savedAt || 0) < 90000);

await media.init({
  wantMic: autoRejoin ? stored.micOn !== false : prefs.get('micOn', true),
  wantCam: autoRejoin ? stored.camOn !== false : prefs.get('camOn', true)
});
lobby.render();

if (autoRejoin) {
  // The page reloaded mid-call: rejoin straight away.
  lobby.hide();
  $('#call').hidden = false;
  call.start({ name: stored.name });
}

window.addEventListener('beforeunload', () => {
  prefs.set('micOn', media.micOn);
  prefs.set('camOn', media.camOn);
});

// Exported so the browser console (and the end-to-end tests) can inspect a
// live call: `const p = await import('/js/room/main.js')`.
export { call, media, stage, chat, people, notes, reactions, recorder, effectsDialog, settingsDialog, lobby };

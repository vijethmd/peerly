// Pre-join screen: camera preview, device pickers, and the join button.

import { $, h, clear, setIcon, toast, pluralize } from './ui.js';
import { getName, setName } from './session.js';

function fillDevices(select, devices, { current, label }) {
  clear(select);
  if (!devices.length) {
    select.append(h('option', { value: '', text: `No ${label.toLowerCase()} found` }));
    select.disabled = true;
    return;
  }
  select.disabled = false;
  select.append(h('option', { value: '', text: `Default ${label.toLowerCase()}` }));
  devices.forEach((device, index) => {
    select.append(h('option', { value: device.deviceId, text: device.label || `${label} ${index + 1}` }));
  });
  select.value = devices.some((device) => device.deviceId === current) ? current : '';
}

export class Lobby {
  constructor({ roomId, media, audioMonitor, onJoin, onOpenEffects }) {
    this.roomId = roomId;
    this.media = media;
    this.audioMonitor = audioMonitor;
    this.onJoin = onJoin;
    this.onOpenEffects = onOpenEffects;
    this.el = $('#lobby');
    this.video = $('#previewVideo');
    this.placeholder = $('#previewPlaceholder');
    this.status = $('#previewStatus');
    this.avatar = $('#previewAvatar');
    this.nameInput = $('#nameInput');
    this.joinBtn = $('#joinRoomBtn');
    this.error = $('#joinError');
    this.occupancy = $('#lobbyOccupancy');
    this.warning = $('#mediaWarning');
    this.meter = $('#lobbyMicMeter');
    this.locked = false;
    this.roomInfo = null;
  }

  init() {
    $('#lobbyRoomId').textContent = this.roomId;
    this.nameInput.value = getName();
    this.updateAvatar();

    this.nameInput.addEventListener('input', () => {
      this.updateAvatar();
      this.updateJoinButton();
    });
    $('#joinForm').addEventListener('submit', (event) => {
      event.preventDefault();
      this.join();
    });
    $('#lobbyMicBtn').addEventListener('click', async () => {
      const ok = await this.media.setMic(!this.media.micOn);
      if (!ok) toast(this.media.errors.mic || 'Microphone unavailable', { tone: 'error' });
      this.render();
    });
    $('#lobbyCamBtn').addEventListener('click', async () => {
      const ok = await this.media.setCamera(!this.media.camOn);
      if (!ok) toast(this.media.errors.cam || 'Camera unavailable', { tone: 'error' });
      this.render();
    });
    $('#lobbyEffectsBtn').addEventListener('click', () => this.onOpenEffects());
    $('#micSelect').addEventListener('change', (event) => this.media.switchMic(event.target.value));
    $('#camSelect').addEventListener('change', (event) => this.media.switchCamera(event.target.value));
    $('#speakerSelect').addEventListener('change', (event) => this.media.setSpeaker(event.target.value));

    this.media.addEventListener('preview', () => this.renderPreview());
    this.media.addEventListener('state', () => this.render());
    this.media.addEventListener('devices', () => this.renderDevices());

    if (typeof HTMLMediaElement === 'undefined' || !('setSinkId' in HTMLMediaElement.prototype)) {
      $('#speakerSelectWrap').hidden = true;
    }

    this.pollRoom();
    this.pollTimer = setInterval(() => this.pollRoom(), 5000);
    this.meterTimer = setInterval(() => this.renderMeter(), 120);
    this.render();
  }

  updateAvatar() {
    const name = this.nameInput.value.trim();
    this.avatar.textContent = name ? name.slice(0, 2).toUpperCase() : '?';
  }

  updateJoinButton() {
    const hasName = this.nameInput.value.trim().length > 0;
    const full = Boolean(this.roomInfo && this.roomInfo.full);
    this.joinBtn.disabled = !hasName || full || this.busy;
    this.joinBtn.textContent = this.busy ? 'Joining…' : this.locked ? 'Ask to join' : 'Join now';
  }

  async pollRoom() {
    try {
      const response = await fetch(`/api/room/${this.roomId}`);
      const info = await response.json();
      this.roomInfo = info;
      if (!info.valid) {
        this.occupancy.textContent = 'This meeting link isn’t valid.';
        this.joinBtn.disabled = true;
        return;
      }
      this.locked = Boolean(info.locked);
      if (info.full) this.occupancy.textContent = `This meeting is full (${info.count} of ${info.max}).`;
      else if (info.locked) this.occupancy.textContent = info.count ? `${pluralize(info.count, 'person', 'people')} in the meeting. The host lets people in.` : 'The host lets people in.';
      else if (!info.count) this.occupancy.textContent = 'No one else is here yet.';
      else this.occupancy.textContent = `${pluralize(info.count, 'person is', 'people are')} already here.`;
    } catch {
      this.occupancy.textContent = 'Couldn’t reach the server. Retrying…';
    }
    this.updateJoinButton();
  }

  join() {
    const name = this.nameInput.value.trim().slice(0, 30);
    if (!name) return;
    setName(name);
    this.setBusy(true);
    this.setError('');
    this.onJoin({ name });
  }

  setBusy(busy) {
    this.busy = busy;
    this.updateJoinButton();
  }

  setError(message) {
    this.error.textContent = message || '';
    this.error.hidden = !message;
  }

  renderPreview() {
    const stream = this.media.previewStream;
    const hasVideo = Boolean(stream) && this.media.camOn;
    if (hasVideo) {
      if (this.video.srcObject !== stream) {
        this.video.srcObject = stream;
        this.video.play().catch(() => {});
      }
    } else {
      this.video.srcObject = null;
    }
    this.placeholder.hidden = hasVideo;
    this.status.textContent = this.media.cameraAvailable ? 'Camera is off' : 'No camera found';
  }

  renderDevices() {
    fillDevices($('#micSelect'), this.media.devices.mics, { current: this.media.micDeviceId, label: 'Microphone' });
    fillDevices($('#camSelect'), this.media.devices.cams, { current: this.media.camDeviceId, label: 'Camera' });
    fillDevices($('#speakerSelect'), this.media.devices.speakers, { current: this.media.speakerDeviceId, label: 'Speaker' });
  }

  renderMeter() {
    if (this.el.hidden) return;
    const level = this.media.micOn ? Math.min(1, this.audioMonitor.levelOf('self') * 12) : 0;
    const bars = this.meter.children.length;
    for (let i = 0; i < bars; i++) this.meter.children[i].classList.toggle('on', level > (i + 0.5) / bars);
  }

  render() {
    const micBtn = $('#lobbyMicBtn');
    const camBtn = $('#lobbyCamBtn');
    micBtn.dataset.on = String(this.media.micOn);
    camBtn.dataset.on = String(this.media.camOn);
    setIcon(micBtn, this.media.micOn ? 'mic' : 'micOff', 22);
    setIcon(camBtn, this.media.camOn ? 'cam' : 'camOff', 22);
    micBtn.setAttribute('aria-label', this.media.micOn ? 'Turn off microphone' : 'Turn on microphone');
    camBtn.setAttribute('aria-label', this.media.camOn ? 'Turn off camera' : 'Turn on camera');

    const problems = [this.media.errors.mic, this.media.errors.cam].filter(Boolean);
    this.warning.textContent = problems.join(' ');
    this.warning.hidden = problems.length === 0;

    this.renderPreview();
    this.renderDevices();
    this.updateJoinButton();
  }

  hide() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.el.hidden = true;
  }

  show() {
    this.el.hidden = false;
    this.setBusy(false);
    if (!this.pollTimer) this.pollTimer = setInterval(() => this.pollRoom(), 5000);
    this.render();
  }
}

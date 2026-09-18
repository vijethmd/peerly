// Devices and call preferences.

import { $, h, clear, openDialog, closeDialog, toast } from './ui.js';
import { prefs } from './session.js';

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

export class SettingsDialog {
  constructor({ media, onDataSaverChange, audioMonitor }) {
    this.media = media;
    this.audioMonitor = audioMonitor;
    this.onDataSaverChange = onDataSaverChange;
    this.dialog = $('#settingsDialog');
    this.meter = $('#settingsMicMeter');
    this.dataSaver = prefs.get('dataSaver', false);
  }

  init() {
    $('#settingsMic').addEventListener('change', (event) => this.media.switchMic(event.target.value));
    $('#settingsCam').addEventListener('change', (event) => this.media.switchCamera(event.target.value));
    $('#settingsSpeaker').addEventListener('change', (event) => this.media.setSpeaker(event.target.value));
    $('#testSpeakerBtn').addEventListener('click', () => this.testSpeaker());

    const toggle = $('#dataSaverToggle');
    toggle.checked = this.dataSaver;
    toggle.addEventListener('change', (event) => {
      this.dataSaver = event.target.checked;
      prefs.set('dataSaver', this.dataSaver);
      this.onDataSaverChange?.(this.dataSaver);
      toast(this.dataSaver ? 'Data saver on — video quality is reduced' : 'Data saver off');
    });

    this.media.addEventListener('devices', () => this.render());
    this.media.addEventListener('state', () => this.render());

    // Speaker selection is not supported everywhere.
    if (typeof HTMLMediaElement === 'undefined' || !('setSinkId' in HTMLMediaElement.prototype)) {
      $('#settingsSpeakerField').hidden = true;
    }
    this.render();
    setInterval(() => this.renderMeter(), 120);
  }

  open() {
    this.render();
    openDialog(this.dialog);
  }

  close() {
    closeDialog(this.dialog);
  }

  render() {
    const { mics, cams, speakers } = this.media.devices;
    fillDevices($('#settingsMic'), mics, { current: this.media.micDeviceId, label: 'Microphone' });
    fillDevices($('#settingsCam'), cams, { current: this.media.camDeviceId, label: 'Camera' });
    fillDevices($('#settingsSpeaker'), speakers, { current: this.media.speakerDeviceId, label: 'Speaker' });
  }

  renderMeter() {
    if (!this.dialog.open || !this.meter) return;
    const level = Math.min(1, this.audioMonitor.levelOf('self') * 12);
    const bars = this.meter.children.length;
    for (let i = 0; i < bars; i++) {
      this.meter.children[i].classList.toggle('on', level > (i + 0.5) / bars);
    }
  }

  async testSpeaker() {
    try {
      const context = new AudioContext();
      if (this.media.speakerDeviceId && typeof context.setSinkId === 'function') {
        await context.setSinkId(this.media.speakerDeviceId).catch(() => {});
      }
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = 520;
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, context.currentTime + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.6);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.65);
      setTimeout(() => context.close().catch(() => {}), 1200);
    } catch {
      toast('Could not play a test sound.', { tone: 'error' });
    }
  }
}

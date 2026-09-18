// Local camera, microphone and screen share.
//
// The camera track is fully stopped when the camera is off (so the hardware
// light goes out and nothing is encoded), while the microphone stays open but
// disabled so "you're muted" detection keeps working.

import { prefs } from './session.js';
import { effectById } from './effects.js';

const AUDIO_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const VIDEO_CONSTRAINTS = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };

export function describeMediaError(err, device) {
  const name = err && err.name;
  const Device = device === 'camera' ? 'Camera' : 'Microphone';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return `${Device} access is blocked. Allow it from the icon in your browser's address bar, then reload.`;
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return `No ${device} found on this device.`;
    case 'NotReadableError':
    case 'TrackStartError':
      return `Your ${device} is being used by another app, or it isn't responding.`;
    case 'OverconstrainedError':
      return `The selected ${device} isn't available any more.`;
    default:
      return `Couldn't start your ${device}.`;
  }
}

const isMobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

export class LocalMedia extends EventTarget {
  constructor({ effects }) {
    super();
    this.effects = effects;
    this.micTrack = null;
    this.cameraTrack = null; // raw camera
    this.outputVideoTrack = null; // what peers receive (processed when an effect is on)
    this.screenTrack = null;
    this.screenAudioTrack = null;
    this.micOn = false;
    this.camOn = false;
    this.cameraAvailable = false;
    this.micAvailable = false;
    this.errors = { mic: null, cam: null };
    this.devices = { mics: [], cams: [], speakers: [] };
    this.micDeviceId = prefs.get('micDeviceId', '');
    this.camDeviceId = prefs.get('camDeviceId', '');
    this.speakerDeviceId = prefs.get('speakerDeviceId', '');
    this.effect = effectById(prefs.get('effectId', 'none'));
    this.customBackground = prefs.get('customBackground', null);
    if (this.effect.id === 'custom' && this.customBackground) this.effect = { id: 'custom', type: 'image', src: this.customBackground, label: 'Your image' };
    else if (this.effect.id === 'custom') this.effect = effectById('none');

    navigator.mediaDevices?.addEventListener?.('devicechange', () => this.refreshDevices());
  }

  // ------------------------------------------------------------- accessors
  get hasMic() {
    return Boolean(this.micTrack && this.micTrack.readyState === 'live');
  }

  get hasCamera() {
    return Boolean(this.cameraTrack && this.cameraTrack.readyState === 'live');
  }

  get previewStream() {
    return this.outputVideoTrack ? new MediaStream([this.outputVideoTrack]) : null;
  }

  tracks() {
    return {
      audio: this.micTrack,
      camera: this.camOn ? this.outputVideoTrack : null,
      screen: this.screenTrack,
      screenAudio: this.screenAudioTrack
    };
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  audioConstraints() {
    const audio = { ...AUDIO_CONSTRAINTS };
    if (this.micDeviceId) audio.deviceId = { exact: this.micDeviceId };
    return audio;
  }

  videoConstraints() {
    const video = { ...VIDEO_CONSTRAINTS };
    if (this.camDeviceId) video.deviceId = { exact: this.camDeviceId };
    else if (isMobile()) video.facingMode = 'user';
    return video;
  }

  // Retries without the stored device id when that device has disappeared.
  async getUserMedia(constraints, { kind }) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      const usedDeviceId = kind === 'audio' ? this.micDeviceId : this.camDeviceId;
      if (usedDeviceId && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
        if (kind === 'audio') {
          this.micDeviceId = '';
          prefs.set('micDeviceId', '');
          return navigator.mediaDevices.getUserMedia({ audio: this.audioConstraints() });
        }
        this.camDeviceId = '';
        prefs.set('camDeviceId', '');
        return navigator.mediaDevices.getUserMedia({ video: this.videoConstraints() });
      }
      throw err;
    }
  }

  // ------------------------------------------------------------------ init
  async init({ wantMic = true, wantCam = true } = {}) {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.errors.mic = 'This browser can’t access a microphone. Try Chrome, Edge, Firefox or Safari.';
      this.errors.cam = 'This browser can’t access a camera.';
      this.emit('state');
      return;
    }

    let audioTrack = null;
    let videoTrack = null;
    try {
      // One prompt for both when possible.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: this.audioConstraints(), video: this.videoConstraints() });
      audioTrack = stream.getAudioTracks()[0] || null;
      videoTrack = stream.getVideoTracks()[0] || null;
    } catch {
      try {
        const audioStream = await this.getUserMedia({ audio: this.audioConstraints() }, { kind: 'audio' });
        audioTrack = audioStream.getAudioTracks()[0] || null;
      } catch (err) {
        this.errors.mic = describeMediaError(err, 'microphone');
      }
      try {
        const videoStream = await this.getUserMedia({ video: this.videoConstraints() }, { kind: 'video' });
        videoTrack = videoStream.getVideoTracks()[0] || null;
      } catch (err) {
        this.errors.cam = describeMediaError(err, 'camera');
      }
    }

    if (audioTrack) {
      this.micAvailable = true;
      this.micTrack = audioTrack;
      this.micOn = wantMic;
      audioTrack.enabled = this.micOn;
      this.watchTrack(audioTrack, 'mic');
    }
    if (videoTrack) {
      this.cameraAvailable = true;
      if (wantCam) {
        await this.useCameraTrack(videoTrack);
        this.camOn = true;
      } else {
        videoTrack.stop();
      }
    }
    await this.refreshDevices();
    this.emit('tracks', { kinds: ['audio', 'camera'] });
    this.emit('state');
  }

  watchTrack(track, kind) {
    if (!track) return;
    track.addEventListener(
      'ended',
      () => {
        this.onTrackEnded(track, kind);
      },
      { once: true }
    );
  }

  // A device was unplugged or taken over: fall back to the system default.
  async onTrackEnded(track, kind) {
    if (kind === 'mic' && track === this.micTrack) {
      this.micDeviceId = '';
      prefs.set('micDeviceId', '');
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: this.audioConstraints() });
        this.micTrack = stream.getAudioTracks()[0];
        this.micTrack.enabled = this.micOn;
        this.watchTrack(this.micTrack, 'mic');
        this.emit('device-lost', { kind: 'microphone', recovered: true });
      } catch {
        this.micTrack = null;
        this.micOn = false;
        this.emit('device-lost', { kind: 'microphone', recovered: false });
      }
      this.emit('tracks', { kinds: ['audio'] });
      this.emit('state');
    } else if (kind === 'camera' && track === this.cameraTrack && this.camOn) {
      this.camDeviceId = '';
      prefs.set('camDeviceId', '');
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: this.videoConstraints() });
        await this.useCameraTrack(stream.getVideoTracks()[0]);
        this.emit('device-lost', { kind: 'camera', recovered: true });
      } catch {
        this.stopCamera();
        this.camOn = false;
        this.emit('device-lost', { kind: 'camera', recovered: false });
      }
      this.emit('tracks', { kinds: ['camera'] });
      this.emit('state');
    }
  }

  async refreshDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.devices = {
        mics: devices.filter((d) => d.kind === 'audioinput'),
        cams: devices.filter((d) => d.kind === 'videoinput'),
        speakers: devices.filter((d) => d.kind === 'audiooutput')
      };
      if (!this.micDeviceId && this.micTrack) this.micDeviceId = this.micTrack.getSettings().deviceId || '';
      if (!this.camDeviceId && this.cameraTrack) this.camDeviceId = this.cameraTrack.getSettings().deviceId || '';
      this.emit('devices');
    } catch {
      /* enumeration is best-effort */
    }
  }

  // ---------------------------------------------------------------- camera
  async useCameraTrack(track) {
    try {
      track.contentHint = 'motion';
    } catch {
      /* optional */
    }
    const previous = this.cameraTrack;
    this.cameraTrack = track;
    this.watchTrack(track, 'camera');
    await this.applyEffectToCamera();
    if (previous && previous !== track) previous.stop();
    this.emit('preview');
  }

  async applyEffectToCamera() {
    const wantsEffect = this.effect.type !== 'none';
    if (!this.cameraTrack) {
      this.outputVideoTrack = null;
      return;
    }
    if (!wantsEffect || !this.effects || !this.effects.constructor.supported()) {
      this.effects?.stop();
      this.outputVideoTrack = this.cameraTrack;
      return;
    }
    try {
      this.outputVideoTrack = await this.effects.start(this.cameraTrack, this.effect);
    } catch (err) {
      console.warn('Peerly: background effects failed to start', err);
      this.outputVideoTrack = this.cameraTrack;
      this.emit('effect-error', err);
    }
  }

  stopCamera() {
    this.effects?.stop();
    this.cameraTrack?.stop();
    this.cameraTrack = null;
    this.outputVideoTrack = null;
    this.emit('preview');
  }

  async setCamera(on) {
    if (on === this.camOn) return true;
    if (!on) {
      this.camOn = false;
      this.stopCamera();
      this.emit('tracks', { kinds: ['camera'] });
      this.emit('state');
      return true;
    }
    try {
      const stream = await this.getUserMedia({ video: this.videoConstraints() }, { kind: 'video' });
      await this.useCameraTrack(stream.getVideoTracks()[0]);
      this.camOn = true;
      this.cameraAvailable = true;
      this.errors.cam = null;
      this.emit('tracks', { kinds: ['camera'] });
      this.emit('state');
      return true;
    } catch (err) {
      this.errors.cam = describeMediaError(err, 'camera');
      this.emit('state');
      return false;
    }
  }

  async switchCamera(deviceId) {
    this.camDeviceId = deviceId;
    prefs.set('camDeviceId', deviceId);
    if (!this.camOn) return true;
    try {
      const stream = await this.getUserMedia({ video: this.videoConstraints() }, { kind: 'video' });
      const hadEffect = Boolean(this.outputVideoTrack && this.outputVideoTrack !== this.cameraTrack);
      await this.useCameraTrack(stream.getVideoTracks()[0]);
      // With an effect running, peers keep the same canvas track.
      if (!hadEffect || this.outputVideoTrack === this.cameraTrack) this.emit('tracks', { kinds: ['camera'] });
      this.emit('state');
      return true;
    } catch (err) {
      this.errors.cam = describeMediaError(err, 'camera');
      this.emit('state');
      return false;
    }
  }

  // ------------------------------------------------------------------- mic
  async setMic(on) {
    if (on && !this.hasMic) {
      try {
        const stream = await this.getUserMedia({ audio: this.audioConstraints() }, { kind: 'audio' });
        this.micTrack = stream.getAudioTracks()[0];
        this.micAvailable = true;
        this.errors.mic = null;
        this.watchTrack(this.micTrack, 'mic');
        this.emit('tracks', { kinds: ['audio'] });
      } catch (err) {
        this.errors.mic = describeMediaError(err, 'microphone');
        this.emit('state');
        return false;
      }
    }
    this.micOn = on && this.hasMic;
    if (this.micTrack) this.micTrack.enabled = this.micOn;
    this.emit('state');
    return true;
  }

  async switchMic(deviceId) {
    this.micDeviceId = deviceId;
    prefs.set('micDeviceId', deviceId);
    try {
      const stream = await this.getUserMedia({ audio: this.audioConstraints() }, { kind: 'audio' });
      const next = stream.getAudioTracks()[0];
      next.enabled = this.micOn;
      const previous = this.micTrack;
      this.micTrack = next;
      this.watchTrack(next, 'mic');
      previous?.stop();
      this.emit('tracks', { kinds: ['audio'] });
      this.emit('state');
      return true;
    } catch (err) {
      this.errors.mic = describeMediaError(err, 'microphone');
      this.emit('state');
      return false;
    }
  }

  setSpeaker(deviceId) {
    this.speakerDeviceId = deviceId;
    prefs.set('speakerDeviceId', deviceId);
    this.emit('speaker', deviceId);
  }

  // --------------------------------------------------------------- effects
  async setEffect(effect) {
    this.effect = effect;
    prefs.set('effectId', effect.id);
    if (effect.id === 'custom') prefs.set('customBackground', effect.src);
    if (!this.camOn) {
      this.emit('state');
      return;
    }
    const before = this.outputVideoTrack;
    if (effect.type === 'none') {
      this.effects?.stop();
      this.outputVideoTrack = this.cameraTrack;
    } else if (this.effects?.running && this.effects.outputTrack) {
      await this.effects.setEffect(effect);
      this.outputVideoTrack = this.effects.outputTrack;
    } else {
      await this.applyEffectToCamera();
    }
    if (before !== this.outputVideoTrack) this.emit('tracks', { kinds: ['camera'] });
    this.emit('preview');
    this.emit('state');
  }

  // ---------------------------------------------------------- screen share
  async startScreenShare() {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 30 }, width: { max: 1920 }, height: { max: 1080 } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      // Chrome hints: don't offer this tab (avoids the hall-of-mirrors) and
      // allow switching the shared surface without renegotiating.
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      systemAudio: 'include'
    });
    this.screenTrack = stream.getVideoTracks()[0];
    this.screenAudioTrack = stream.getAudioTracks()[0] || null;
    try {
      this.screenTrack.contentHint = 'detail';
    } catch {
      /* optional */
    }
    this.screenTrack.addEventListener('ended', () => this.stopScreenShare(), { once: true });
    this.emit('tracks', { kinds: ['screen', 'screenAudio'] });
    this.emit('state');
    return stream;
  }

  stopScreenShare() {
    if (!this.screenTrack && !this.screenAudioTrack) return false;
    this.screenTrack?.stop();
    this.screenAudioTrack?.stop();
    this.screenTrack = null;
    this.screenAudioTrack = null;
    this.emit('tracks', { kinds: ['screen', 'screenAudio'] });
    this.emit('state');
    this.emit('screen-ended');
    return true;
  }

  get sharing() {
    return Boolean(this.screenTrack);
  }

  stopAll() {
    this.effects?.stop();
    this.micTrack?.stop();
    this.cameraTrack?.stop();
    this.screenTrack?.stop();
    this.screenAudioTrack?.stop();
    this.micTrack = null;
    this.cameraTrack = null;
    this.outputVideoTrack = null;
    this.screenTrack = null;
    this.screenAudioTrack = null;
    this.micOn = false;
    this.camOn = false;
  }
}

// Local recording: captures a screen or tab you pick, mixed with your
// microphone, and saves it to your downloads. Nothing is uploaded, and
// everyone in the meeting is told that you are recording.

import { toast, confirmDialog } from './ui.js';

export class Recorder {
  constructor({ call }) {
    this.call = call;
    this.recorder = null;
    this.chunks = [];
    this.displayStream = null;
    this.mixContext = null;
  }

  get active() {
    return Boolean(this.recorder && this.recorder.state === 'recording');
  }

  async toggle() {
    if (this.active) return this.stop();
    return this.start();
  }

  async start() {
    if (!window.MediaRecorder) {
      toast('This browser can’t record meetings.', { tone: 'error' });
      return false;
    }
    const ok = await confirmDialog({
      title: 'Record this meeting?',
      body: 'Pick the tab or window showing the call. The recording is saved to your downloads, and everyone will see that you are recording.',
      confirmLabel: 'Choose what to record'
    });
    if (!ok) return false;

    try {
      this.displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, preferCurrentTab: true });
    } catch {
      return false; // picker cancelled
    }

    const tracks = [...this.displayStream.getVideoTracks()];
    try {
      this.mixContext = new AudioContext();
      const destination = this.mixContext.createMediaStreamDestination();
      const displayAudio = this.displayStream.getAudioTracks();
      if (displayAudio.length) {
        this.mixContext.createMediaStreamSource(new MediaStream(displayAudio)).connect(destination);
      }
      if (this.call.media.micTrack) {
        this.mixContext.createMediaStreamSource(new MediaStream([this.call.media.micTrack])).connect(destination);
      }
      tracks.push(...destination.stream.getAudioTracks());
    } catch {
      /* record without mixed audio */
    }

    this.chunks = [];
    const combined = new MediaStream(tracks);
    const preferred = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
    const mimeType = preferred.find((type) => MediaRecorder.isTypeSupported?.(type));
    try {
      this.recorder = mimeType ? new MediaRecorder(combined, { mimeType }) : new MediaRecorder(combined);
    } catch (err) {
      toast('Recording could not start on this device.', { tone: 'error' });
      this.cleanup();
      return false;
    }

    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    this.recorder.onstop = () => this.save();
    this.displayStream.getVideoTracks()[0].addEventListener('ended', () => this.stop(), { once: true });
    this.recorder.start(1000);
    this.call.setRecording(true);
    toast('Recording started — it will download when you stop.');
    return true;
  }

  stop() {
    if (!this.recorder || this.recorder.state === 'inactive') return false;
    this.recorder.stop();
    this.call.setRecording(false);
    return true;
  }

  save() {
    const type = this.recorder?.mimeType || 'video/webm';
    const blob = new Blob(this.chunks, { type });
    this.chunks = [];
    this.cleanup();
    if (!blob.size) return;
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const link = document.createElement('a');
    link.href = url;
    link.download = `peerly-${this.call.roomId}-${stamp}.${type.includes('mp4') ? 'mp4' : 'webm'}`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    toast('Recording saved to your downloads');
  }

  cleanup() {
    this.displayStream?.getTracks().forEach((track) => track.stop());
    this.displayStream = null;
    this.mixContext?.close().catch(() => {});
    this.mixContext = null;
    this.recorder = null;
  }
}

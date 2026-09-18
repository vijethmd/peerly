// Background blur and virtual backgrounds.
//
// Frames run through a canvas pipeline on the device: MediaPipe's selfie
// segmenter produces a person mask, which is used to composite the person
// over a blurred copy of the camera frame or a background image. Nothing
// leaves the browser.

const MODEL_W = 256;
const MODEL_H = 144;
const MAX_OUTPUT_WIDTH = 1280;
const TICKER_URL = '/js/room/ticker-worker.js';

export const BACKGROUND_EFFECTS = [
  { id: 'none', type: 'none', label: 'No effect', icon: 'none' },
  { id: 'blur-light', type: 'blur', amount: 8, label: 'Slight blur', icon: 'blur' },
  { id: 'blur-strong', type: 'blur', amount: 18, label: 'Blur', icon: 'blur' },
  { id: 'aurora', type: 'image', src: '/backgrounds/aurora.svg', label: 'Aurora' },
  { id: 'studio', type: 'image', src: '/backgrounds/studio.svg', label: 'Studio' },
  { id: 'office', type: 'image', src: '/backgrounds/office.svg', label: 'Office' },
  { id: 'forest', type: 'image', src: '/backgrounds/forest.svg', label: 'Forest' },
  { id: 'mountains', type: 'image', src: '/backgrounds/mountains.svg', label: 'Mountains' },
  { id: 'sunset', type: 'image', src: '/backgrounds/sunset.svg', label: 'Sunset' }
];

export function effectById(id) {
  return BACKGROUND_EFFECTS.find((effect) => effect.id === id) || BACKGROUND_EFFECTS[0];
}

/** Canvas `filter` exists in every browser but only *works* in some. */
function canvasFilterWorks() {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 9;
    canvas.height = 9;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.filter = 'blur(2px)';
    ctx.fillStyle = '#fff';
    ctx.fillRect(4, 4, 1, 1);
    ctx.filter = 'none';
    return ctx.getImageData(2, 4, 1, 1).data[3] > 0;
  } catch {
    return false;
  }
}

function drawCover(ctx, image, width, height) {
  const iw = image.naturalWidth || image.width;
  const ih = image.naturalHeight || image.height;
  if (!iw || !ih) return;
  const scale = Math.max(width / iw, height / ih);
  const w = iw * scale;
  const h = ih * scale;
  ctx.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
}

export class BackgroundProcessor extends EventTarget {
  constructor(config) {
    super();
    this.config = config || {};
    this.segmenter = null;
    this.loading = null;
    this.failed = false;
    this.ready = false;
    this.running = false;
    this.effect = { id: 'none', type: 'none' };
    this.backgroundImage = null;
    this.backgroundCache = new Map();
    this.canFilter = canvasFilterWorks();
    this.segmentEvery = 1;
    this.frameIndex = 0;
    this.avgMs = 0;
    this.flipped = false;
    this.calibrated = false;
    this.calibrationVotes = 0;
    this.lastTimestamp = 0;
  }

  static supported() {
    try {
      const canvas = document.createElement('canvas');
      return typeof canvas.captureStream === 'function' && typeof window.Worker === 'function';
    } catch {
      return false;
    }
  }

  loadSegmenter() {
    if (this.segmenter) return Promise.resolve(this.segmenter);
    if (!this.loading) {
      this.loading = (async () => {
        const { FilesetResolver, ImageSegmenter } = await import(/* @vite-ignore */ this.config.bundleUrl);
        const fileset = await FilesetResolver.forVisionTasks(this.config.wasmBase);
        const create = (delegate) =>
          ImageSegmenter.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: this.config.modelUrl, delegate },
            canvas: document.createElement('canvas'),
            runningMode: 'VIDEO',
            outputCategoryMask: false,
            outputConfidenceMasks: true
          });
        let segmenter;
        try {
          segmenter = await create('GPU');
        } catch (err) {
          console.warn('Peerly: GPU segmentation unavailable, falling back to CPU', err);
          segmenter = await create('CPU');
        }
        this.segmenter = segmenter;
        this.ready = true;
        this.dispatchEvent(new Event('ready'));
        return segmenter;
      })().catch((err) => {
        this.loading = null;
        this.failed = true;
        this.dispatchEvent(new CustomEvent('failed', { detail: err }));
        throw err;
      });
    }
    return this.loading;
  }

  createElements() {
    if (this.video) return;
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;
    this.video.className = 'offscreen-media';
    document.body.append(this.video);

    this.output = document.createElement('canvas');
    this.outCtx = this.output.getContext('2d', { alpha: false });
    this.person = document.createElement('canvas');
    this.personCtx = this.person.getContext('2d');
    this.mask = document.createElement('canvas');
    this.mask.width = MODEL_W;
    this.mask.height = MODEL_H;
    this.maskCtx = this.mask.getContext('2d');
    this.maskImage = this.maskCtx.createImageData(MODEL_W, MODEL_H);
    for (let i = 0; i < MODEL_W * MODEL_H; i++) {
      this.maskImage.data[i * 4] = 255;
      this.maskImage.data[i * 4 + 1] = 255;
      this.maskImage.data[i * 4 + 2] = 255;
    }
    this.maskState = new Float32Array(MODEL_W * MODEL_H);
    this.small = document.createElement('canvas');
    this.small.width = MODEL_W;
    this.small.height = MODEL_H;
    this.smallCtx = this.small.getContext('2d', { willReadFrequently: false });
    this.tiny = document.createElement('canvas');
    this.tinyCtx = this.tiny.getContext('2d');
  }

  resize(width, height) {
    const scale = Math.min(1, MAX_OUTPUT_WIDTH / Math.max(1, width));
    const w = Math.max(2, Math.round(width * scale));
    const h = Math.max(2, Math.round(height * scale));
    if (this.output.width === w && this.output.height === h) return;
    this.output.width = w;
    this.output.height = h;
    this.person.width = w;
    this.person.height = h;
  }

  async prepareBackground(effect) {
    if (effect.type !== 'image') {
      this.backgroundImage = null;
      return;
    }
    const src = effect.src;
    if (this.backgroundCache.has(src)) {
      this.backgroundImage = this.backgroundCache.get(src);
      return;
    }
    const image = new Image();
    image.decoding = 'async';
    image.src = src;
    try {
      await image.decode();
    } catch {
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
      }).catch(() => {});
    }
    this.backgroundCache.set(src, image);
    this.backgroundImage = image;
  }

  /**
   * Starts (or retargets) processing and returns the track to send to peers.
   * Until the model is ready the whole frame is blurred, so a background is
   * never briefly exposed.
   */
  async start(inputTrack, effect) {
    this.createElements();
    this.effect = effect;
    await this.prepareBackground(effect);

    if (this.inputTrack !== inputTrack) {
      this.inputTrack = inputTrack;
      this.video.srcObject = new MediaStream([inputTrack]);
      try {
        await this.video.play();
      } catch {
        /* retried on the next frame */
      }
    }
    const settings = inputTrack.getSettings ? inputTrack.getSettings() : {};
    this.resize(settings.width || 1280, settings.height || 720);

    if (!this.outputTrack || this.outputTrack.readyState === 'ended') {
      const stream = this.output.captureStream(30);
      this.outputTrack = stream.getVideoTracks()[0];
      try {
        this.outputTrack.contentHint = 'motion';
      } catch {
        /* optional */
      }
    }
    this.startLoop();
    this.loadSegmenter().catch(() => {});
    return this.outputTrack;
  }

  async setEffect(effect) {
    this.effect = effect;
    await this.prepareBackground(effect);
  }

  startLoop() {
    if (this.running) return;
    this.running = true;
    if (!this.worker && typeof Worker === 'function') {
      try {
        this.worker = new Worker(TICKER_URL);
        this.worker.onmessage = () => this.tick();
      } catch {
        this.worker = null;
      }
    }
    if (this.worker) this.worker.postMessage({ cmd: 'start', fps: 30 });
    else this.fallbackTimer = setInterval(() => this.tick(), 33);
  }

  stop() {
    this.running = false;
    this.worker?.postMessage({ cmd: 'stop' });
    clearInterval(this.fallbackTimer);
    this.fallbackTimer = null;
    if (this.outputTrack) {
      this.outputTrack.stop();
      this.outputTrack = null;
    }
    if (this.video) this.video.srcObject = null;
    this.inputTrack = null;
    this.hasMask = false;
    this.maskState?.fill(0);
  }

  tick() {
    if (!this.running || this.busy) return;
    const video = this.video;
    if (!video || video.readyState < 2 || !video.videoWidth) return;
    this.busy = true;
    const started = performance.now();
    try {
      this.resize(video.videoWidth, video.videoHeight);
      if (this.segmenter && this.effect.type !== 'none' && this.frameIndex % this.segmentEvery === 0) {
        this.segment(started);
      }
      this.frameIndex += 1;
      this.composite();
      this.errorCount = 0;
    } catch (err) {
      this.errorCount = (this.errorCount || 0) + 1;
      if (this.errorCount === 10) {
        console.error('Peerly: background effects failing', err);
        this.dispatchEvent(new CustomEvent('failed', { detail: err }));
      }
    } finally {
      this.busy = false;
      this.trackPerformance(performance.now() - started);
    }
  }

  segment(now) {
    const timestamp = Math.max(now, this.lastTimestamp + 1);
    this.lastTimestamp = timestamp;
    this.smallCtx.drawImage(this.video, 0, 0, MODEL_W, MODEL_H);
    this.segmenter.segmentForVideo(this.small, timestamp, (result) => {
      const masks = result.confidenceMasks;
      if (!masks || !masks.length) return;
      // MediaPipe's selfie models put background at index 0; a single mask is
      // the person itself.
      const backgroundFirst = masks.length > 1;
      const values = masks[0].getAsFloat32Array();
      this.updateMask(values, backgroundFirst);
    });
  }

  updateMask(values, backgroundFirst) {
    const count = MODEL_W * MODEL_H;
    if (values.length !== count) return;
    const invert = backgroundFirst !== this.flipped;
    const state = this.maskState;
    const data = this.maskImage.data;
    for (let i = 0; i < count; i++) {
      const person = invert ? 1 - values[i] : values[i];
      const smoothed = state[i] * 0.4 + person * 0.6; // reduces edge flicker
      state[i] = smoothed;
      const alpha = smoothed <= 0.25 ? 0 : smoothed >= 0.7 ? 1 : (smoothed - 0.25) / 0.45;
      data[i * 4 + 3] = alpha * 255;
    }
    this.calibrate(state);
    this.maskCtx.putImageData(this.maskImage, 0, 0);
    this.hasMask = true;
  }

  /**
   * Safety net for model/runtime differences in mask polarity: in a webcam
   * frame the middle is usually the person and the top corners are usually
   * background. If that is consistently reversed, flip.
   */
  calibrate(state) {
    if (this.calibrated) return;
    const sample = (x0, y0, x1, y1) => {
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y += 3) {
        for (let x = x0; x < x1; x += 3) {
          sum += state[y * MODEL_W + x];
          n += 1;
        }
      }
      return n ? sum / n : 0;
    };
    const center = sample(Math.round(MODEL_W * 0.35), Math.round(MODEL_H * 0.4), Math.round(MODEL_W * 0.65), MODEL_H);
    const corners =
      (sample(0, 0, Math.round(MODEL_W * 0.15), Math.round(MODEL_H * 0.3)) +
        sample(Math.round(MODEL_W * 0.85), 0, MODEL_W, Math.round(MODEL_H * 0.3))) /
      2;
    const diff = center - corners;
    if (Math.abs(diff) < 0.35) return; // nobody clearly in frame yet
    this.calibrationVotes += diff > 0 ? 1 : -1;
    if (this.calibrationVotes <= -8) {
      this.flipped = !this.flipped;
      this.calibrated = true;
      this.maskState.fill(0);
    } else if (this.calibrationVotes >= 8) {
      this.calibrated = true;
    }
  }

  composite() {
    const ctx = this.outCtx;
    const { width: w, height: h } = this.output;
    const video = this.video;

    if (this.effect.type === 'none') {
      ctx.drawImage(video, 0, 0, w, h);
      return;
    }
    if (!this.hasMask) {
      // Model still loading (or unavailable): blur everything rather than
      // showing the background we were asked to hide.
      this.drawBlurred(ctx, video, w, h, 22);
      return;
    }

    if (this.effect.type === 'blur' || !this.backgroundImage) {
      this.drawBlurred(ctx, video, w, h, this.effect.amount || 12);
    } else {
      drawCover(ctx, this.backgroundImage, w, h);
    }

    const person = this.personCtx;
    person.globalCompositeOperation = 'copy';
    if (this.canFilter) person.filter = `blur(${Math.max(1, Math.round(w / 260))}px)`; // feather the edge
    person.drawImage(this.mask, 0, 0, w, h);
    if (this.canFilter) person.filter = 'none';
    person.globalCompositeOperation = 'source-in';
    person.drawImage(video, 0, 0, w, h);
    person.globalCompositeOperation = 'source-over';
    ctx.drawImage(this.person, 0, 0);
  }

  drawBlurred(ctx, source, w, h, amount) {
    if (this.canFilter) {
      const pad = amount * 2;
      ctx.filter = `blur(${amount}px)`;
      ctx.drawImage(source, -pad, -pad, w + pad * 2, h + pad * 2);
      ctx.filter = 'none';
      return;
    }
    // Fallback blur: downscale hard, then scale back up smoothly.
    const factor = Math.max(6, Math.round(amount * 1.5));
    const tw = Math.max(2, Math.round(w / factor));
    const th = Math.max(2, Math.round(h / factor));
    if (this.tiny.width !== tw || this.tiny.height !== th) {
      this.tiny.width = tw;
      this.tiny.height = th;
    }
    this.tinyCtx.drawImage(source, 0, 0, tw, th);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.tiny, 0, 0, tw, th, 0, 0, w, h);
  }

  trackPerformance(ms) {
    this.avgMs = this.avgMs ? this.avgMs * 0.9 + ms * 0.1 : ms;
    this.perfFrames = (this.perfFrames || 0) + 1;
    if (this.perfFrames % 60 !== 0) return;
    if (this.avgMs > 32 && this.segmentEvery < 3) this.segmentEvery += 1;
    else if (this.avgMs < 16 && this.segmentEvery > 1) this.segmentEvery -= 1;
    if (this.avgMs > 55 && !this.slowWarned) {
      this.slowWarned = true;
      this.dispatchEvent(new Event('slow'));
    }
  }
}

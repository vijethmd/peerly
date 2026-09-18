// The "Backgrounds and effects" picker.

import { $, h, clear, iconHtml, toast, openDialog, closeDialog } from './ui.js';
import { BACKGROUND_EFFECTS, BackgroundProcessor } from './effects.js';
import { prefs } from './session.js';

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

async function fileToBackground(file) {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file.');
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('That image is too large (max 12 MB).');
  const source = await loadImage(file);
  const scale = Math.min(1, 1280 / source.width, 720 / source.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close?.();
  return canvas.toDataURL('image/jpeg', 0.82);
}

async function loadImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      /* fall through */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

export class EffectsDialog {
  constructor({ media }) {
    this.media = media;
    this.dialog = $('#effectsDialog');
    this.preview = $('#effectsPreview');
    this.previewOff = $('#effectsPreviewOff');
    this.status = $('#effectsStatus');
    this.blurGrid = $('#effectsBlur');
    this.backgroundGrid = $('#effectsBackgrounds');
    this.upload = $('#effectsUpload');
  }

  init() {
    for (const button of document.querySelectorAll('[data-dialog-close]')) {
      button.addEventListener('click', (event) => closeDialog(event.target.closest('dialog')));
    }
    this.upload.addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      try {
        const src = await fileToBackground(file);
        await this.select({ id: 'custom', type: 'image', src, label: 'Your image' });
        this.render();
      } catch (err) {
        toast(err.message || 'Could not use that image.', { tone: 'error' });
      }
    });

    this.media.addEventListener('preview', () => this.updatePreview());
    this.media.addEventListener('state', () => this.updatePreview());
    this.media.effects?.addEventListener('failed', () => {
      this.showStatus('Background effects couldn’t load, so your video stays blurred. Choose “No effect” to turn it off.');
      toast('Background effects couldn’t load. Your video is blurred for privacy.', { tone: 'error', timeout: 8000 });
    });
    this.media.effects?.addEventListener('slow', () => {
      this.showStatus('Effects are using a lot of this device’s power. Turn them off if the call feels slow.');
    });
    this.render();
  }

  showStatus(message) {
    this.status.textContent = message;
    this.status.hidden = !message;
  }

  open() {
    this.render();
    this.updatePreview();
    openDialog(this.dialog);
  }

  updatePreview() {
    const stream = this.media.previewStream;
    const hasVideo = Boolean(stream) && this.media.camOn;
    this.previewOff.hidden = hasVideo;
    if (hasVideo && this.preview.srcObject !== stream) {
      this.preview.srcObject = stream;
      this.preview.play().catch(() => {});
    }
    if (!hasVideo) this.preview.srcObject = null;
  }

  async select(effect) {
    await this.media.setEffect(effect);
    this.updatePreview();
    this.render();
  }

  optionButton(effect, { thumbnail }) {
    const current = this.media.effect?.id === effect.id;
    return h(
      'button',
      {
        class: `effect-option${current ? ' is-selected' : ''}`,
        type: 'button',
        'aria-pressed': String(current),
        title: effect.label,
        onClick: () => this.select(effect)
      },
      thumbnail,
      h('span', { class: 'effect-label', text: effect.label })
    );
  }

  render() {
    const supported = BackgroundProcessor.supported();
    clear(this.blurGrid);
    clear(this.backgroundGrid);

    for (const effect of BACKGROUND_EFFECTS.filter((item) => item.type !== 'image')) {
      this.blurGrid.append(
        this.optionButton(effect, {
          thumbnail: h('span', { class: `effect-thumb effect-thumb-${effect.id}`, html: iconHtml(effect.icon || 'blur', 22) })
        })
      );
    }

    for (const effect of BACKGROUND_EFFECTS.filter((item) => item.type === 'image')) {
      this.backgroundGrid.append(
        this.optionButton(effect, { thumbnail: h('img', { class: 'effect-thumb', src: effect.src, alt: '', loading: 'lazy' }) })
      );
    }

    const custom = prefs.get('customBackground', null);
    if (custom) {
      this.backgroundGrid.append(
        this.optionButton(
          { id: 'custom', type: 'image', src: custom, label: 'Your image' },
          { thumbnail: h('img', { class: 'effect-thumb', src: custom, alt: '' }) }
        )
      );
    }
    this.backgroundGrid.append(
      h(
        'button',
        {
          class: 'effect-option effect-upload',
          type: 'button',
          onClick: () => this.upload.click()
        },
        h('span', { class: 'effect-thumb', html: iconHtml('upload', 22) }),
        h('span', { class: 'effect-label', text: custom ? 'Replace image' : 'Upload image' })
      )
    );

    if (!supported) {
      this.showStatus('This browser can’t run background effects.');
      for (const button of this.dialog.querySelectorAll('.effect-option')) {
        if (!button.classList.contains('is-selected')) button.disabled = true;
      }
    }
  }
}

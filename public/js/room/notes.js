// Live captions, the running transcript, and meeting notes ("catch me up" plus
// the link to the meeting report).

import { $, h, clear, toast, formatClock, formatRelative } from './ui.js';
import { prefs } from './session.js';
import { SpeechEngine, SPEECH_LANGUAGES, speechSupported, defaultLanguage } from './speech.js';

const CAPTION_LINES = 3;
const CAPTION_TTL_MS = 7000;
const INTERIM_THROTTLE_MS = 300;

export class Notes {
  constructor({ call, onUnread }) {
    this.call = call;
    this.onUnread = onUnread;
    this.panel = $('#notesPanel');
    this.statusCard = $('#transcriptStatus');
    this.catchUpCard = $('#catchUpCard');
    this.catchUpBtn = $('#catchUpBtn');
    this.catchUpResult = $('#catchUpResult');
    this.reportCard = $('#reportCard');
    this.transcriptList = $('#transcriptList');
    this.captionsEl = $('#captions');
    this.ccBtn = $('#ccBtn');
    this.downloadBtn = $('#downloadTranscriptBtn');

    this.segments = [];
    this.seen = new Set();
    this.captions = new Map();
    this.captionsOn = prefs.get('captionsOn', true);
    this.myLanguage = prefs.get('speechLang', '');
    this.lastInterim = '';
    this.lastInterimAt = 0;
    this.problem = null;
    this.unread = 0;
    // Is my own speech turning into text? (see captionStatus)
    this.speakingSince = 0;
    this.spokeMs = 0;
    this.status = null;
    this.lastMode = null;

    this.engine = new SpeechEngine({
      onInterim: (text) => this.onLocalInterim(text),
      onFinal: (text) => this.onLocalFinal(text),
      onProblem: (kind) => this.onSpeechProblem(kind),
      onMode: (mode) => this.onSpeechMode(mode)
    });
  }

  init() {
    this.ccBtn.addEventListener('click', () => this.toggleCaptions());
    this.catchUpBtn.addEventListener('click', () => this.catchUp());
    this.downloadBtn.addEventListener('click', () => this.download());

    this.call.on('transcription', () => {
      this.render();
      this.updateEngine();
    });
    this.call.on('caption', (payload) => this.onCaption(payload));
    this.call.on('transcript-history', (segments) => {
      for (const segment of segments) this.addSegment(segment, { silent: true });
    });
    this.call.on('self-updated', () => this.updateEngine());
    this.call.on('host-changed', () => this.render());
    this.call.on('transcription-request', ({ name }) => {
      if (!this.call.isHost()) return;
      toast(`${name} asked to turn on captions and notes`, {
        timeout: 20000,
        actions: [
          {
            label: 'Turn on',
            primary: true,
            onSelect: () => this.setTranscription(true)
          }
        ]
      });
    });
    this.call.media.addEventListener('state', () => this.updateEngine());

    setInterval(() => this.pruneCaptions(), 1000);
    this.render();
    this.renderCaptions();
  }

  get isOpen() {
    return !this.panel.hidden;
  }

  markRead() {
    this.unread = 0;
    this.onUnread?.(0);
  }

  // --------------------------------------------------------------- engine
  language() {
    return this.myLanguage || this.call.transcription.lang || defaultLanguage();
  }

  updateEngine() {
    const shouldRun = Boolean(this.call.transcription.on) && this.call.media.micOn && this.call.phase === 'call';
    this.engine.update({ shouldRun, lang: this.language(), track: this.call.media.micTrack });
  }

  onSpeechMode(mode) {
    if (mode === 'device' && this.lastMode === 'cloud' && this.call.transcription.on) {
      toast('Captions are ready: you’re now transcribed on this device.', { id: 'speech-mode', timeout: 3500 });
    }
    this.lastMode = mode;
    this.updateStatus();
    this.render();
  }

  /** From the audio monitor: whether my microphone hears me talking. */
  onSelfSpeaking(speaking) {
    if (speaking) {
      this.speakingSince ||= Date.now();
    } else if (this.speakingSince) {
      this.spokeMs += Date.now() - this.speakingSince;
      this.speakingSince = 0;
    }
  }

  prepareSpeech() {
    this.engine.prepare(this.language());
  }

  /**
   * A line above the captions when my speech isn't being captioned: while
   * on-device recognition is being set up, when the browser's recognizer
   * reports a problem, or when I've talked for a while and got no text back.
   */
  captionStatus() {
    const { transcription, media } = this.call;
    if (!transcription.on || !media.micOn || this.call.phase !== 'call') return null;
    if (!speechSupported) return { tone: 'warn', text: 'This browser can’t turn speech into text, so what you say isn’t captioned. Chrome on a computer works best.' };
    if (this.problem === 'blocked') return { tone: 'warn', text: 'Your browser blocked speech recognition, so what you say isn’t captioned.' };
    if (this.problem === 'language') return { tone: 'warn', text: 'Your browser can’t transcribe this language.' };
    if (this.problem) return { tone: 'warn', text: `Captions can’t hear you right now (${this.problem}). Chrome on a computer works best.` };
    if (this.engine.mode === 'cloud' && this.engine.installingOnDevice) {
      return { tone: 'info', text: 'Setting up captions on this device. The first time takes about a minute.' };
    }
    const spoke = this.spokeMs + (this.speakingSince ? Date.now() - this.speakingSince : 0);
    if (spoke > 12000) return { tone: 'warn', text: 'Your browser isn’t turning your speech into text. Chrome on a computer works best.' };
    return null;
  }

  updateStatus() {
    const next = this.captionStatus();
    if ((next?.text || '') === (this.status?.text || '')) return;
    this.status = next;
    this.renderCaptions();
    this.render();
  }

  onSpeechProblem(kind) {
    this.problem = kind;
    this.updateStatus();
    this.render();
    if (kind === 'blocked') {
      toast('Your browser blocked speech recognition, so your speech isn’t transcribed.', { tone: 'error' });
    }
  }

  heardMe() {
    // Text came back, so recognition works: restart the "no text" clock.
    this.spokeMs = 0;
    if (this.speakingSince) this.speakingSince = Date.now();
    if (this.status) this.updateStatus();
  }

  onLocalInterim(text) {
    const now = Date.now();
    if (text) this.heardMe();
    this.showCaption({ pid: this.call.self.pid, name: this.call.name, text, interim: true, isSelf: true });
    if (!text) return;
    if (text === this.lastInterim) return;
    if (now - this.lastInterimAt < INTERIM_THROTTLE_MS) return;
    this.lastInterim = text;
    this.lastInterimAt = now;
    this.call.sendCaption(text, false);
  }

  onLocalFinal(text) {
    this.heardMe();
    this.lastInterim = '';
    this.showCaption({ pid: this.call.self.pid, name: this.call.name, text, interim: false, isSelf: true });
    this.call.sendCaption(text, true);
  }

  // -------------------------------------------------------------- captions
  onCaption(payload) {
    const isSelf = payload.pid === this.call.self.pid;
    if (payload.final) {
      this.addSegment(payload);
      if (!isSelf) this.showCaption({ ...payload, interim: false });
    } else if (!isSelf) {
      this.showCaption({ ...payload, interim: true });
    }
  }

  showCaption({ pid, name, text, interim, isSelf }) {
    if (!this.captionsOn) return;
    const entry = this.captions.get(pid) || { name, final: '', interim: '', updatedAt: 0, isSelf };
    entry.name = name;
    entry.updatedAt = Date.now();
    if (interim) {
      entry.interim = text;
    } else {
      entry.final = `${entry.final} ${text}`.trim().slice(-220);
      entry.interim = '';
    }
    if (!text && interim) entry.interim = '';
    this.captions.set(pid, entry);
    this.renderCaptions();
  }

  pruneCaptions() {
    this.updateStatus();
    const now = Date.now();
    let changed = false;
    for (const [pid, entry] of this.captions) {
      if (now - entry.updatedAt > CAPTION_TTL_MS) {
        this.captions.delete(pid);
        changed = true;
      }
    }
    if (changed) this.renderCaptions();
  }

  renderCaptions() {
    const entries = [...this.captions.entries()]
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
      .slice(-CAPTION_LINES);
    if (!this.captionsOn || (!entries.length && !this.status)) {
      this.captionsEl.hidden = true;
      document.body.classList.remove('has-captions');
      clear(this.captionsEl);
      return;
    }
    clear(this.captionsEl);
    if (this.status) {
      this.captionsEl.append(
        h(
          'p',
          { class: `caption-line caption-status caption-status-${this.status.tone}`, role: 'status' },
          h('span', { class: 'caption-name', text: 'Captions' }),
          h('span', { class: 'caption-text', text: this.status.text })
        )
      );
    }
    for (const [, entry] of entries) {
      const text = `${entry.final} ${entry.interim}`.trim();
      if (!text) continue;
      this.captionsEl.append(
        h(
          'p',
          { class: 'caption-line' },
          h('span', { class: 'caption-name', text: entry.isSelf ? 'You' : entry.name }),
          h('span', { class: 'caption-text', text })
        )
      );
    }
    this.captionsEl.hidden = !this.captionsEl.childElementCount;
    document.body.classList.toggle('has-captions', !this.captionsEl.hidden);
  }

  async toggleCaptions() {
    if (!this.call.transcription.on) {
      if (this.call.isHost()) {
        await this.setTranscription(true);
      } else {
        const result = await this.call.requestTranscription();
        toast(
          result.ok
            ? 'Asked the host to turn on captions and notes'
            : result.error || 'Could not ask the host right now.',
          { tone: result.ok ? 'info' : 'error' }
        );
      }
      return;
    }
    this.captionsOn = !this.captionsOn;
    prefs.set('captionsOn', this.captionsOn);
    if (!this.captionsOn) this.captions.clear();
    this.renderCaptions();
    this.render();
  }

  async setTranscription(on) {
    const result = await this.call.setTranscription(on, this.language());
    if (!result.ok) toast(result.error || 'Could not change transcription.', { tone: 'error' });
    else if (on) this.captionsOn = true;
    return result.ok;
  }

  // ------------------------------------------------------------ transcript
  addSegment(segment, { silent = false } = {}) {
    if (segment.id !== undefined) {
      if (this.seen.has(segment.id)) return;
      this.seen.add(segment.id);
    }
    this.segments.push(segment);
    this.transcriptList.querySelector('.notes-empty')?.remove();

    const last = this.transcriptList.lastElementChild;
    const sameSpeaker = last && last.dataset.pid === segment.pid && segment.ts - Number(last.dataset.ts) < 30000;
    if (sameSpeaker) {
      last.querySelector('.transcript-text').textContent += ` ${segment.text}`;
      last.dataset.ts = String(segment.ts);
    } else {
      const atBottom = this.transcriptList.scrollHeight - this.transcriptList.scrollTop - this.transcriptList.clientHeight < 60;
      this.transcriptList.append(
        h(
          'div',
          { class: 'transcript-line', dataset: { pid: segment.pid, ts: String(segment.ts) } },
          h(
            'div',
            { class: 'transcript-meta' },
            h('span', { class: 'transcript-speaker', text: segment.name }),
            h('time', { class: 'transcript-time', text: formatClock(segment.ts) })
          ),
          h('p', { class: 'transcript-text', text: segment.text })
        )
      );
      if (atBottom) this.transcriptList.scrollTop = this.transcriptList.scrollHeight;
    }
    this.downloadBtn.disabled = false;
    if (!silent && !this.isOpen) {
      this.unread += 1;
      this.onUnread?.(this.unread);
    }
  }

  download() {
    if (!this.segments.length) return;
    const started = this.call.startedAt || this.segments[0].ts;
    const lines = [
      `Peerly meeting transcript — ${this.call.roomId}`,
      `Started ${new Date(started).toLocaleString()}`,
      ''
    ];
    for (const segment of this.segments) {
      lines.push(`[${formatClock(segment.ts)}] ${segment.name}: ${segment.text}`);
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: `peerly-transcript-${this.call.roomId}.txt` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ----------------------------------------------------------- catch me up
  async catchUp() {
    this.catchUpBtn.disabled = true;
    this.catchUpBtn.textContent = 'Catching you up…';
    this.catchUpResult.hidden = false;
    clear(this.catchUpResult);
    this.catchUpResult.append(h('p', { class: 'notes-loading', text: 'Reading the transcript…' }));

    const result = await this.call.catchUp();
    this.catchUpBtn.disabled = false;
    this.catchUpBtn.textContent = 'Catch me up';
    clear(this.catchUpResult);

    if (!result.ok) {
      this.catchUpResult.append(h('p', { class: 'notes-error', text: result.error || 'Could not generate a recap.' }));
      return;
    }
    const { recap, keyPoints, currentTopic } = result.recap;
    this.catchUpResult.append(h('p', { class: 'recap-text', text: recap }));
    if (keyPoints?.length) {
      const list = h('ul', { class: 'recap-list' });
      for (const point of keyPoints) list.append(h('li', { text: point }));
      this.catchUpResult.append(list);
    }
    if (currentTopic) {
      this.catchUpResult.append(h('p', { class: 'recap-now' }, h('strong', { text: 'Right now: ' }), currentTopic));
    }
    const meta = [result.cached ? `generated ${formatRelative(result.generatedAt || Date.now())}` : 'just generated'];
    if (result.partial) meta.push('covers the most recent part of the meeting');
    const label = result.kind === 'auto' ? 'Automatic summary' : 'AI summary';
    this.catchUpResult.append(h('p', { class: 'recap-meta', text: `${label} — ${meta.join(' · ')}` }));
  }

  /** Where this person's speech is being turned into text, in plain words. */
  speechModeText() {
    if (!speechSupported || !this.call.media.micOn) return '';
    const { mode, installingOnDevice } = this.engine;
    if (mode === 'device') return 'You’re transcribed on this device: your audio doesn’t leave it.';
    if (mode === 'cloud') {
      return installingOnDevice
        ? 'Setting up on-device transcription. Until it’s ready, your browser’s online speech service transcribes you.'
        : 'Your browser’s online speech service transcribes you.';
    }
    return '';
  }

  // ---------------------------------------------------------------- render
  render() {
    const call = this.call;
    const transcription = call.transcription;
    const isHost = call.isHost();
    this.ccBtn.classList.toggle('active', Boolean(transcription.on) && this.captionsOn);
    this.ccBtn.setAttribute('aria-pressed', String(Boolean(transcription.on) && this.captionsOn));
    this.ccBtn.title = transcription.on
      ? this.captionsOn
        ? 'Hide captions (L)'
        : 'Show captions (L)'
      : 'Turn on captions and notes (L)';

    clear(this.statusCard);
    if (transcription.on) {
      this.statusCard.append(
        h('div', { class: 'notes-live' }, h('span', { class: 'dot' }), h('strong', { text: 'Transcribing this meeting' })),
        h('p', {
          class: 'notes-hint',
          text: `Started by ${transcription.startedBy || 'the host'}. Each person’s browser turns their own speech into text and Peerly only receives the text.`
        })
      );
      const mode = this.speechModeText();
      if (mode) this.statusCard.append(h('p', { class: 'notes-hint notes-mode', text: mode }));
      const controls = h('div', { class: 'notes-actions' });
      controls.append(
        h('button', {
          class: 'mini-btn',
          type: 'button',
          text: this.captionsOn ? 'Hide captions' : 'Show captions',
          onClick: () => this.toggleCaptions()
        })
      );
      if (isHost) {
        controls.append(
          h('button', {
            class: 'mini-btn mini-btn-danger',
            type: 'button',
            text: 'Stop transcript',
            onClick: () => this.setTranscription(false)
          })
        );
      }
      this.statusCard.append(controls, this.languageField());
      if (!speechSupported) {
        this.statusCard.append(
          h('p', {
            class: 'notes-warning',
            text: 'This browser can’t transcribe speech, so what you say won’t appear in the notes. Chrome or Edge work best.'
          })
        );
      } else if (this.problem === 'blocked') {
        this.statusCard.append(h('p', { class: 'notes-warning', text: 'Your browser blocked speech recognition for this page.' }));
      } else if (this.problem === 'language') {
        this.statusCard.append(h('p', { class: 'notes-warning', text: 'That language isn’t supported by your browser’s speech recognition.' }));
      } else if (this.status?.tone === 'warn') {
        this.statusCard.append(h('p', { class: 'notes-warning', text: this.status.text }));
      }
    } else {
      this.statusCard.append(
        h('h3', { class: 'notes-title', text: 'Transcript and notes' }),
        h('p', {
          class: 'notes-hint',
          text: !call.features.ai
            ? 'Turn this on for live captions and a transcript of the meeting.'
            : call.features.notes === 'auto'
              ? 'Turn this on to show live captions, keep a transcript, and get meeting notes with key points, decisions and action items when the meeting ends.'
              : 'Turn this on to show live captions, keep a transcript, and get AI meeting notes with decisions and action items when the meeting ends.'
        })
      );
      if (isHost) {
        this.statusCard.append(
          this.languageField(),
          h('button', {
            class: 'btn btn-primary btn-sm',
            type: 'button',
            text: 'Start transcript',
            onClick: () => this.setTranscription(true)
          })
        );
      } else {
        this.statusCard.append(
          h('button', {
            class: 'btn btn-ghost btn-sm',
            type: 'button',
            text: 'Ask the host to start',
            onClick: async () => {
              const result = await this.call.requestTranscription();
              toast(result.ok ? 'Asked the host' : result.error || 'Could not ask the host.', {
                tone: result.ok ? 'info' : 'error'
              });
            }
          })
        );
      }
    }

    this.catchUpCard.hidden = !(call.features.ai && transcription.on);
    this.reportCard.hidden = !transcription.reportId;
    if (transcription.reportId) {
      const url = `${location.origin}/report/${transcription.reportId}`;
      const link = $('#reportLink');
      link.href = url;
      link.textContent = url.replace(`${location.origin}/`, '');
    }
    if (!this.transcriptList.childElementCount) {
      this.transcriptList.append(
        h('p', {
          class: 'notes-empty',
          text: transcription.on ? 'Waiting for someone to speak…' : 'Nothing transcribed yet.'
        })
      );
    }
  }

  languageField() {
    const select = h('select', {
      class: 'notes-select',
      'aria-label': 'Language you speak',
      onChange: (event) => {
        this.myLanguage = event.target.value;
        prefs.set('speechLang', this.myLanguage);
        this.updateEngine();
        if (this.call.isHost() && this.call.transcription.on) this.call.setTranscription(true, this.myLanguage);
      }
    });
    for (const [code, label] of SPEECH_LANGUAGES) {
      select.append(h('option', { value: code, text: label, selected: code === this.language() }));
    }
    select.value = this.language();
    return h('label', { class: 'notes-field' }, h('span', { text: 'I speak' }), select);
  }
}

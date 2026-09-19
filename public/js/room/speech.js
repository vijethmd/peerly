// Speech recognition wrapper.
//
// Each participant transcribes their own microphone in their own browser, so
// speaker attribution is exact and no audio is ever sent to the Peerly
// server. Where the browser can do it on the device (Chrome's on-device
// recognition) we use that: it's private, works offline and can listen to
// the exact mic track in use. Otherwise the browser's own online service does
// the work (Chrome and Edge send audio to their vendor for this).
//
// Recognition stops on its own regularly; this keeps it running with backoff
// and reports fatal problems once.

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export const speechSupported = Boolean(Recognition);
const canCheckOnDevice = speechSupported && typeof Recognition.available === 'function';

export const SPEECH_LANGUAGES = [
  ['en-US', 'English (US)'],
  ['en-GB', 'English (UK)'],
  ['en-IN', 'English (India)'],
  ['hi-IN', 'Hindi'],
  ['kn-IN', 'Kannada'],
  ['ta-IN', 'Tamil'],
  ['te-IN', 'Telugu'],
  ['mr-IN', 'Marathi'],
  ['bn-IN', 'Bengali'],
  ['es-ES', 'Spanish'],
  ['fr-FR', 'French'],
  ['de-DE', 'German'],
  ['pt-BR', 'Portuguese (Brazil)'],
  ['it-IT', 'Italian'],
  ['nl-NL', 'Dutch'],
  ['ar-SA', 'Arabic'],
  ['ru-RU', 'Russian'],
  ['ja-JP', 'Japanese'],
  ['ko-KR', 'Korean'],
  ['zh-CN', 'Chinese (Mandarin)']
];

export function defaultLanguage() {
  const preferred = (navigator.language || 'en-US').toLowerCase();
  const exact = SPEECH_LANGUAGES.find(([code]) => code.toLowerCase() === preferred);
  if (exact) return exact[0];
  const base = preferred.split('-')[0];
  const partial = SPEECH_LANGUAGES.find(([code]) => code.toLowerCase().startsWith(base));
  return partial ? partial[0] : 'en-US';
}

const withTimeout = (promise, ms, fallback) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), ms))]);

export class SpeechEngine {
  constructor({ onInterim, onFinal, onProblem, onMode }) {
    this.onInterim = onInterim;
    this.onFinal = onFinal;
    this.onProblem = onProblem;
    this.onMode = onMode || (() => {});
    this.recognition = null;
    this.shouldRun = false;
    this.lang = defaultLanguage();
    this.track = null;
    this.failures = 0;
    this.fatal = null;
    this.fatalMode = null;
    this.wanted = false;
    // 'device' (on-device recognition) or 'cloud' (the browser's online service).
    this.mode = null;
    this.onDevice = new Map(); // lang -> availability from the browser
    this.installing = new Set();
    this.noDevice = new Set(); // languages where on-device recognition failed
    this.generation = 0;
    this.hearing = false;
    this.pendingSwitch = false;
  }

  get installingOnDevice() {
    return this.installing.has(this.lang);
  }

  update({ shouldRun, lang, track }) {
    const langChanged = Boolean(lang) && lang !== this.lang;
    const trackChanged = (track || null) !== this.track;
    if (lang) this.lang = lang;
    this.track = track || null;
    this.wanted = Boolean(shouldRun);
    this.shouldRun = this.wanted && speechSupported && !this.fatal;

    if (!this.shouldRun) {
      this.stop();
      return;
    }
    // On-device recognition listens to the track itself, so follow mic switches.
    if (this.recognition && (langChanged || (trackChanged && this.mode === 'device'))) {
      this.restart();
      return;
    }
    if (!this.recognition) this.start();
  }

  restart() {
    this.stop();
    this.start();
  }

  async start() {
    if (!speechSupported || this.recognition || this.starting) return;
    this.starting = true;
    const generation = ++this.generation;
    const mode = await this.pickMode(this.lang).catch(() => 'cloud');
    this.starting = false;
    if (generation !== this.generation || !this.shouldRun || this.recognition) return;
    this.begin(mode);
  }

  async pickMode(lang) {
    if (!canCheckOnDevice || this.noDevice.has(lang)) return 'cloud';
    let status = this.onDevice.get(lang);
    if (status !== 'available') {
      status = await withTimeout(
        Promise.resolve(Recognition.available({ langs: [lang], processLocally: true })).catch(() => 'unavailable'),
        3000,
        'unavailable'
      );
      this.onDevice.set(lang, status);
    }
    if (status === 'available') return 'device';
    if (status === 'downloadable' || status === 'downloading') this.installOnDevice(lang);
    return 'cloud';
  }

  // Downloads the on-device language pack in the background (Chrome keeps it
  // for every site). Until it's ready the online service is used.
  installOnDevice(lang) {
    if (typeof Recognition.install !== 'function' || this.installing.has(lang)) return;
    this.installing.add(lang);
    this.onMode(this.mode);
    Promise.resolve()
      .then(() => Recognition.install({ langs: [lang], processLocally: true }))
      .then((ok) => {
        if (!ok) {
          this.noDevice.add(lang);
          return;
        }
        this.onDevice.set(lang, 'available');
        if (this.lang !== lang) return;
        // The online service may have refused us (Brave does); on the device it can still work.
        if (this.fatal && this.fatalMode === 'cloud') {
          this.fatal = null;
          this.fatalMode = null;
          this.shouldRun = this.wanted && speechSupported;
          this.onProblem(null);
        }
        if (!this.shouldRun || this.mode === 'device') return;
        if (this.recognition) this.switchWhenQuiet();
        else this.start();
      })
      .catch(() => this.noDevice.add(lang))
      .finally(() => {
        this.installing.delete(lang);
        this.onMode(this.mode);
      });
  }

  // Swap to on-device recognition between sentences, not in the middle of one.
  switchWhenQuiet() {
    if (!this.hearing) this.restart();
    else this.pendingSwitch = true;
  }

  begin(mode) {
    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = this.lang;
    if (mode === 'device') recognition.processLocally = true;

    recognition.onresult = (event) => {
      this.failures = 0;
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = (result[0]?.transcript || '').trim();
        if (!text) continue;
        if (result.isFinal) this.onFinal(text);
        else interim = interim ? `${interim} ${text}` : text;
      }
      this.hearing = Boolean(interim);
      this.onInterim(interim);
      if (!interim && this.pendingSwitch) {
        this.pendingSwitch = false;
        this.restart();
      }
    };

    recognition.onerror = (event) => {
      const error = event.error;
      if (mode === 'device' && error !== 'no-speech' && error !== 'aborted' && error !== 'not-allowed') {
        // On-device recognition isn't working here after all: use the online
        // service from the next restart on.
        this.noDevice.add(this.lang);
        this.failures += 1;
        return;
      }
      if (error === 'not-allowed' || error === 'service-not-allowed') {
        this.fail('blocked', mode);
      } else if (error === 'language-not-supported') {
        this.fail('language', mode);
      } else if (error !== 'no-speech' && error !== 'aborted') {
        this.failures += 1;
        if (this.failures === 4) this.onProblem(error);
      }
    };

    recognition.onend = () => {
      if (this.recognition !== recognition) return;
      this.recognition = null;
      this.hearing = false;
      this.onInterim('');
      if (!this.shouldRun) return;
      const delay = this.failures ? Math.min(10000, 500 * 2 ** this.failures) : 300;
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => {
        if (this.shouldRun && !this.recognition) this.start();
      }, delay);
    };

    this.recognition = recognition;
    this.setMode(mode);
    try {
      // On-device recognition can listen to the exact mic track in use. The
      // online service returns nothing for a track (Chrome 153), so it gets
      // the default microphone like it always has.
      if (mode === 'device' && this.track && this.track.readyState === 'live') recognition.start(this.track);
      else recognition.start();
    } catch {
      this.recognition = null;
      this.failures += 1;
      if (mode === 'device') this.noDevice.add(this.lang);
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => {
        if (this.shouldRun) this.start();
      }, Math.min(8000, 500 * 2 ** this.failures));
    }
  }

  fail(kind, mode) {
    this.fatal = kind;
    this.fatalMode = mode;
    this.shouldRun = false;
    this.onProblem(kind);
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.onMode(mode);
  }

  stop() {
    this.generation += 1;
    this.starting = false;
    this.pendingSwitch = false;
    this.hearing = false;
    clearTimeout(this.restartTimer);
    const recognition = this.recognition;
    this.recognition = null;
    if (!recognition) return;
    try {
      recognition.abort();
    } catch {
      /* already stopped */
    }
    this.onInterim('');
  }
}

// Speech recognition wrapper.
//
// Each participant transcribes their own microphone in their own browser, so
// speaker attribution is exact and no audio is ever sent to the Peerly
// server (the browser's recognizer may use its vendor's speech service, as
// Chrome and Edge do). It stops on its own regularly; this keeps it running
// with backoff and reports fatal problems once.

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export const speechSupported = Boolean(Recognition);

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

export class SpeechEngine {
  constructor({ onInterim, onFinal, onProblem }) {
    this.onInterim = onInterim;
    this.onFinal = onFinal;
    this.onProblem = onProblem;
    this.recognition = null;
    this.shouldRun = false;
    this.lang = defaultLanguage();
    this.track = null;
    this.failures = 0;
    this.fatal = null;
  }

  update({ shouldRun, lang, track }) {
    const langChanged = Boolean(lang) && lang !== this.lang;
    if (lang) this.lang = lang;
    this.track = track || null;
    this.shouldRun = Boolean(shouldRun) && speechSupported && !this.fatal;

    if (!this.shouldRun) {
      this.stop();
      return;
    }
    if (this.recognition && langChanged) {
      this.stop();
      this.start();
      return;
    }
    if (!this.recognition) this.start();
  }

  start() {
    if (!speechSupported || this.recognition) return;
    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = this.lang;

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
      this.onInterim(interim);
    };

    recognition.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        this.fatal = 'blocked';
        this.shouldRun = false;
        this.onProblem('blocked');
      } else if (event.error === 'language-not-supported') {
        this.fatal = 'language';
        this.shouldRun = false;
        this.onProblem('language');
      } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
        this.failures += 1;
        if (this.failures === 4) this.onProblem(event.error);
      }
    };

    recognition.onend = () => {
      if (this.recognition !== recognition) return;
      this.recognition = null;
      this.onInterim('');
      if (!this.shouldRun) return;
      const delay = this.failures ? Math.min(10000, 500 * 2 ** this.failures) : 300;
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => {
        if (this.shouldRun && !this.recognition) this.start();
      }, delay);
    };

    this.recognition = recognition;
    try {
      // Newer Chrome can transcribe a specific track (the mic the person
      // picked); older browsers ignore the argument and use the default.
      if (this.track && this.track.readyState === 'live') recognition.start(this.track);
      else recognition.start();
    } catch {
      this.recognition = null;
      this.failures += 1;
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => {
        if (this.shouldRun) this.start();
      }, Math.min(8000, 500 * 2 ** this.failures));
    }
  }

  stop() {
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

// Text-to-speech (speechSynthesis) and speech recognition (Web Speech API).
// Both run in the browser; on most phones TTS voices work offline. Recognition uses the
// phone's speech service (Chrome on Android sends audio to Google, iOS uses Siri dictation),
// so it usually needs an internet connection.

const LANGS = { it: 'it-IT', es: 'es-ES' };
const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
let voices = [];
const listeners = new Set();

function loadVoices() {
  if (!synth) return;
  voices = synth.getVoices() || [];
  listeners.forEach((fn) => fn(voices));
}
if (synth) {
  loadVoices();
  if (typeof synth.addEventListener === 'function') synth.addEventListener('voiceschanged', loadVoices);
  else synth.onvoiceschanged = loadVoices;
}

export function ttsSupported() {
  return !!synth && typeof window.SpeechSynthesisUtterance === 'function';
}

export function onVoices(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function voicesFor(lang) {
  const pre = lang.toLowerCase();
  return voices.filter((v) => (v.lang || '').replace('_', '-').toLowerCase().startsWith(pre));
}

const QUALITY = /(enhanced|premium|natural|neural|google|siri|alice|federica|luca|paola|elsa|monica|jorge|paulina|lucia|lucía)/i;

export function bestVoice(lang, preferredURI) {
  const list = voicesFor(lang);
  if (!list.length) return null;
  if (preferredURI) {
    const v = list.find((x) => x.voiceURI === preferredURI);
    if (v) return v;
  }
  const full = LANGS[lang].toLowerCase();
  const score = (v) => {
    let s = 0;
    if ((v.lang || '').replace('_', '-').toLowerCase() === full) s += 4;
    if (QUALITY.test(v.name)) s += 2;
    if (v.localService) s += 1;
    if (v.default) s += 0.5;
    return s;
  };
  return list.slice().sort((a, b) => score(b) - score(a))[0];
}

let current = null;

/**
 * Speak text. Must be called from a user gesture the first time on iOS.
 * @param {string} text
 * @param {'it'|'es'} lang
 * @param {{rate?:number, voiceURI?:string, onend?:Function}} opts
 */
export function speak(text, lang, opts = {}) {
  if (!ttsSupported() || !text) {
    opts.onend?.();
    return false;
  }
  try {
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = LANGS[lang] || lang;
    const v = bestVoice(lang, opts.voiceURI);
    if (v) u.voice = v;
    u.rate = opts.rate ?? 0.9;
    u.pitch = 1;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (current === u) current = null;
      opts.onend?.();
    };
    u.onend = finish;
    u.onerror = finish;
    current = u;
    synth.speak(u);
    // Some Android builds pause the queue; resume() is harmless elsewhere.
    if (synth.paused) synth.resume();
    return true;
  } catch (e) {
    console.warn('TTS failed', e);
    opts.onend?.();
    return false;
  }
}

export function stopSpeaking() {
  try { synth?.cancel(); } catch { /* ignore */ }
}

export function hasVoice(lang) {
  return voicesFor(lang).length > 0;
}

// ------------------------------------------------------------------ recognition
function Recognition() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function recognitionSupported() {
  return !!Recognition();
}

const ERRORS = {
  'not-allowed': 'Microphone access is blocked. Allow the microphone for this site in your browser settings, then try again.',
  'service-not-allowed': 'Speech recognition is turned off on this device. On iPhone enable Settings → General → Keyboard → Enable Dictation (and Siri). Then try again.',
  'no-speech': "I didn't hear anything. Tap the microphone and speak clearly.",
  'audio-capture': 'No microphone was found.',
  network: 'Speech recognition needs an internet connection.',
  aborted: '',
  'language-not-supported': 'Your device does not support recognition for this language.',
};

/**
 * Listen once. Resolves with {alternatives: string[]} or rejects with {message}.
 * Returns {promise, stop()}.
 */
export function listenOnce(lang, { onInterim } = {}) {
  const SR = Recognition();
  if (!SR) {
    return { promise: Promise.reject({ message: 'Speech recognition is not supported in this browser. Try Chrome on Android or Safari on iPhone.' }), stop() {} };
  }
  stopSpeaking();
  const rec = new SR();
  rec.lang = LANGS[lang] || lang;
  rec.interimResults = true;
  rec.maxAlternatives = 5;
  rec.continuous = false;
  let finals = [];
  let interim = '';
  let settled = false;
  let resolveFn, rejectFn;
  const promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
  const settle = (ok, val) => {
    if (settled) return;
    settled = true;
    clearTimeout(guard);
    ok ? resolveFn(val) : rejectFn(val);
  };
  rec.onresult = (ev) => {
    interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) {
        finals = [];
        for (let j = 0; j < r.length; j++) finals.push(r[j].transcript);
      } else {
        interim += r[0].transcript;
      }
    }
    onInterim?.(finals[0] || interim);
  };
  rec.onerror = (ev) => {
    const code = ev.error || 'unknown';
    if (code === 'aborted' && (finals.length || interim)) return;
    if (code === 'no-speech' || code === 'aborted') {
      settle(false, { code, message: ERRORS[code] ?? '' });
    } else {
      settle(false, { code, message: ERRORS[code] || `Speech recognition error: ${code}` });
    }
  };
  rec.onend = () => {
    const alts = finals.length ? finals : interim ? [interim] : [];
    if (alts.length) settle(true, { alternatives: alts.map((s) => s.trim()).filter(Boolean) });
    else settle(false, { code: 'no-speech', message: ERRORS['no-speech'] });
  };
  // Safety net: some browsers never fire onend if the mic stalls.
  const guard = setTimeout(() => { try { rec.stop(); } catch { /* ignore */ } }, 15000);
  try {
    rec.start();
  } catch (e) {
    settle(false, { code: 'start', message: 'Could not start the microphone. Close other apps that use it and try again.' });
  }
  return {
    promise,
    stop() { try { rec.stop(); } catch { /* ignore */ } },
  };
}

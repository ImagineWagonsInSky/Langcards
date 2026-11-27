// Persistent state in localStorage, with export/import for backups.
import { dayNumber, dateKey } from './util.js';

const KEY = 'langcards:v1';
const APP_ID = 'langcards-es-it';

export const DEFAULT_SETTINGS = {
  dir: 'ei',            // 'ei' Spanish -> Italian, 'ie' Italian -> Spanish, 'both'
  newPerDay: 10,
  newFrom: 'both',      // 'both' | 'words' | 'sentences'
  startLevel: 1,
  lessonSize: 12,
  dailyGoal: 30,        // exercises per day
  ex: { mc: true, tiles: true, type: true, listen: true, speak: true },
  autoplay: true,
  rate: 0.9,
  voiceIt: '',
  voiceEs: '',
  sounds: true,
};

function fresh() {
  return { v: 1, app: APP_ID, settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), cards: {}, days: {}, favs: [], speakOffUntil: 0, created: Date.now() };
}

function sanitize(raw) {
  const s = fresh();
  if (!raw || typeof raw !== 'object') return s;
  if (raw.settings && typeof raw.settings === 'object') {
    s.settings = { ...s.settings, ...raw.settings, ex: { ...s.settings.ex, ...(raw.settings.ex || {}) } };
  }
  if (raw.cards && typeof raw.cards === 'object') {
    for (const [k, v] of Object.entries(raw.cards)) {
      if (v && typeof v === 'object' && Number.isFinite(v.d) && Number.isFinite(v.i)) {
        s.cards[k] = { d: v.d, i: v.i, e: Number.isFinite(v.e) ? v.e : 250, r: v.r | 0, l: v.l | 0, t: v.t | 0, ...(v.s ? { s: 1 } : {}) };
      }
    }
  }
  if (raw.days && typeof raw.days === 'object') {
    for (const [k, v] of Object.entries(raw.days)) {
      if (/^\d{4}-\d\d-\d\d$/.test(k) && v && typeof v === 'object') {
        s.days[k] = { n: v.n | 0, r: v.r | 0, c: v.c | 0, x: v.x | 0 };
      }
    }
  }
  if (Array.isArray(raw.favs)) s.favs = raw.favs.filter((x) => typeof x === 'string');
  if (Number.isFinite(raw.speakOffUntil)) s.speakOffUntil = raw.speakOffUntil;
  if (Number.isFinite(raw.created)) s.created = raw.created;
  return s;
}

let state = load();
let timer = null;

function load() {
  try {
    return sanitize(JSON.parse(localStorage.getItem(KEY)));
  } catch {
    return fresh();
  }
}

export function getState() {
  return state;
}

export function save(now = false) {
  clearTimeout(timer);
  const write = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('Could not save progress', e);
    }
  };
  if (now) write();
  else timer = setTimeout(write, 250);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') save(true);
});
window.addEventListener('pagehide', () => save(true));

export function settings() {
  return state.settings;
}

export function updateSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  save();
}

export function today() {
  return dayNumber();
}

export function dayStats(day = today()) {
  const k = dateKey(day);
  if (!state.days[k]) state.days[k] = { n: 0, r: 0, c: 0, x: 0 };
  return state.days[k];
}

/** Record one answered exercise. */
export function recordExercise({ correct, isNew }) {
  const d = dayStats();
  d.r += 1;
  if (correct) d.c += 1;
  if (isNew) d.n += 1;
  d.x += 1;
  save();
}

export function streak() {
  const t = today();
  let n = 0;
  let day = t;
  if (!(state.days[dateKey(day)]?.x > 0)) day -= 1; // today not started yet: streak still alive
  while (state.days[dateKey(day)]?.x > 0) {
    n++;
    day--;
  }
  return n;
}

export function isFav(id) {
  return state.favs.includes(id);
}

export function toggleFav(id) {
  const i = state.favs.indexOf(id);
  if (i >= 0) state.favs.splice(i, 1);
  else state.favs.unshift(id);
  save();
  return i < 0;
}

export function exportJSON() {
  save(true);
  return JSON.stringify({ ...state, exported: new Date().toISOString() });
}

export function importJSON(text) {
  const raw = JSON.parse(text);
  if (!raw || raw.app !== APP_ID) throw new Error('This file is not a LangCards backup.');
  state = sanitize(raw);
  save(true);
}

export function resetAll() {
  state = fresh();
  save(true);
}

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch { /* ignore */ }
  return false;
}

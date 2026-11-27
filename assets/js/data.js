// Loads data/*.json and turns it into cards for both directions.
import { loose, normalize, tileTokens } from './text.js';
import { shuffle } from './util.js';

export const DB = {
  ready: false,
  meta: null,
  es: new Map(),       // tatoeba id -> Spanish sentence
  it: new Map(),       // tatoeba id -> { t: Italian sentence, lv }
  decks: { word: { ei: [], ie: [] }, sent: { ei: [], ie: [] } },
  byId: new Map(),
  words: [],           // raw word entries
  categories: new Map(),
};

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not load ${url} (${r.status})`);
  return r.json();
}

export async function loadData() {
  if (DB.ready) return DB;
  const [meta, words, sents] = await Promise.all([
    getJSON('data/meta.json'), getJSON('data/words.json'), getJSON('data/sentences.json'),
  ]);
  DB.meta = meta;
  for (const [id, t] of sents.es) DB.es.set(id, t);
  for (const [id, t, lv] of sents.it) DB.it.set(id, { t, lv });
  buildSentenceCards(sents.links);
  buildWordCards(words.words);
  for (const deck of Object.values(DB.decks)) {
    for (const list of Object.values(deck)) {
      list.forEach((c, i) => { c.order = i; DB.byId.set(c.id, c); });
    }
  }
  DB.ready = true;
  return DB;
}

// ------------------------------------------------------------------ sentences
function buildSentenceCards(links) {
  const fwd = new Map(), rev = new Map();
  for (const [a, b] of links) {
    if (!DB.es.has(a) || !DB.it.has(b)) continue;
    if (!fwd.has(a)) fwd.set(a, []);
    fwd.get(a).push(b);
    if (!rev.has(b)) rev.set(b, []);
    rev.get(b).push(a);
  }
  const ei = [];
  for (const [a, bs] of fwd) {
    bs.sort((x, y) => DB.it.get(x).lv - DB.it.get(y).lv || DB.it.get(x).t.length - DB.it.get(y).t.length);
    const answers = bs.map((b) => DB.it.get(b).t);
    ei.push({
      id: `s:${a}`, deck: 'sent', dir: 'ei', src: 'es', tgt: 'it',
      prompt: DB.es.get(a), answers, es: DB.es.get(a), it: answers[0],
      lv: DB.it.get(bs[0]).lv, esIds: [a], itIds: bs, n: tileTokens(answers[0]).length,
    });
  }
  const ie = [];
  for (const [b, as] of rev) {
    as.sort((x, y) => DB.es.get(x).length - DB.es.get(y).length);
    const answers = as.map((a) => DB.es.get(a));
    ie.push({
      id: `S:${b}`, deck: 'sent', dir: 'ie', src: 'it', tgt: 'es',
      prompt: DB.it.get(b).t, answers, es: answers[0], it: DB.it.get(b).t,
      lv: DB.it.get(b).lv, esIds: as, itIds: [b], n: tileTokens(answers[0]).length,
    });
  }
  const byLevel = (x, y) => x.lv - y.lv || x.n - y.n || x.prompt.length - y.prompt.length;
  ei.sort(byLevel);
  ie.sort(byLevel);
  DB.decks.sent.ei = ei;
  DB.decks.sent.ie = ie;
}

// ------------------------------------------------------------------ words
export function itDisplay(t) {
  if (!t.a) return t.w;
  return t.a === "l'" ? `l'${t.w}` : `${t.a} ${t.w}`;
}

export function esDisplay(w) {
  return w.ea ? `${w.ea} ${w.es}` : w.es;
}

function buildWordCards(words) {
  DB.words = words;
  const ei = [];
  const byIt = new Map();
  for (const w of words) {
    const answers = w.tr.map(itDisplay);
    const card = {
      id: `w:${w.es}`, deck: 'word', dir: 'ei', src: 'es', tgt: 'it',
      prompt: esDisplay(w), answers, es: esDisplay(w), it: answers[0],
      lv: w.lv, pos: w.pos, note: w.note || '', ex: w.ex || [], core: !!w.core, cat: w.cat || '',
      genders: w.tr.map((t) => t.g || null), entry: w,
    };
    ei.push(card);
    if (w.cat) {
      if (!DB.categories.has(w.cat)) DB.categories.set(w.cat, []);
      DB.categories.get(w.cat).push(card);
    }
    w.tr.forEach((t) => {
      const key = normalize(itDisplay(t));
      if (!byIt.has(key)) byIt.set(key, { t, list: [], lv: w.lv, id: w.id });
      const g = byIt.get(key);
      g.list.push(w);
      g.lv = Math.min(g.lv, w.lv);
    });
  }
  const ie = [];
  for (const [key, g] of byIt) {
    const answers = [...new Set(g.list.map(esDisplay))];
    const first = g.list[0];
    ie.push({
      id: `W:${key}`, deck: 'word', dir: 'ie', src: 'it', tgt: 'es',
      prompt: itDisplay(g.t), answers, es: answers[0], it: itDisplay(g.t),
      lv: g.lv, pos: first.pos, note: g.list.map((w) => w.note).filter(Boolean).join(' · '),
      ex: g.list.flatMap((w) => w.ex || []).slice(0, 2), core: g.list.some((w) => w.core),
      genders: [g.t.g || null], entry: first, sortId: g.id,
    });
  }
  ie.sort((x, y) => x.sortId - y.sortId);
  DB.decks.word.ei = ei;
  DB.decks.word.ie = ie;
}

// ------------------------------------------------------------------ queries
export function getCard(id) {
  return DB.byId.get(id);
}

export function deck(deckName, dir) {
  return DB.decks[deckName][dir];
}

export function examples(card) {
  return (card.ex || [])
    .filter(([a, b]) => DB.es.has(a) && DB.it.has(b))
    .map(([a, b]) => ({ es: DB.es.get(a), it: DB.it.get(b).t, esId: a, itId: b }));
}

// Function words have overlapping meanings ("en" can be "in" or "su"), so their wrong
// options come from content words; content words avoid synonyms of synonyms.
const FUNCTION_POS = new Set(['prep', 'conj', 'pron', 'adv', 'phrase']);
let answerIndex = null;
function synonymAnswers(card) {
  if (!answerIndex) {
    answerIndex = new Map();
    for (const dir of ['ei', 'ie']) {
      for (const c of DB.decks.word[dir]) {
        for (const a of c.answers) {
          const k = `${dir}|${loose(a, c.tgt)}`;
          if (!answerIndex.has(k)) answerIndex.set(k, []);
          answerIndex.get(k).push(c);
        }
      }
    }
  }
  const out = new Set();
  for (const a of card.answers) {
    for (const other of answerIndex.get(`${card.dir}|${loose(a, card.tgt)}`) || []) {
      for (const b of other.answers) out.add(loose(b, card.tgt));
    }
  }
  return out;
}

/** Plausible wrong options for multiple choice. */
export function distractors(card, n = 3, rnd = Math.random) {
  const pool = DB.decks[card.deck][card.dir];
  const bad = new Set(card.answers.map((a) => loose(a, card.tgt)));
  if (card.deck === 'word') for (const k of synonymAnswers(card)) bad.add(k);
  const functionWord = card.deck === 'word' && FUNCTION_POS.has(card.pos);
  const seenPrompt = loose(card.prompt, card.src);
  const out = [];
  const used = new Set();
  const tries = Math.min(4000, pool.length * 4);
  for (let t = 0; t < tries && out.length < n; t++) {
    const c = pool[Math.floor(rnd() * pool.length)];
    if (c === card || used.has(c.id)) continue;
    if (card.deck === 'word') {
      if (functionWord) {
        if (FUNCTION_POS.has(c.pos)) continue;
      } else if (t < tries / 2 && c.pos !== card.pos) continue;
    } else {
      const strict = t < tries / 2;
      if (strict && (Math.abs(c.n - card.n) > 2 || Math.abs(c.lv - card.lv) > 1)) continue;
    }
    if (loose(c.prompt, c.src) === seenPrompt) continue;
    const opt = c.answers[0];
    const key = loose(opt, card.tgt);
    if (bad.has(key)) continue;
    // never offer an option that is also a correct answer of this card under another wording
    if (c.answers.some((a) => bad.has(loose(a, card.tgt)))) continue;
    used.add(c.id);
    bad.add(key);
    out.push(opt);
  }
  return out;
}

/** Extra wrong word tiles for the tile exercise. */
export function tileDistractors(card, tokens, n = 3, rnd = Math.random) {
  const pool = DB.decks.sent[card.dir];
  const have = new Set(tokens.map((t) => loose(t, card.tgt)));
  const out = [];
  for (let t = 0; t < 300 && out.length < n; t++) {
    const c = pool[Math.floor(rnd() * pool.length)];
    if (Math.abs(c.lv - card.lv) > 1) continue;
    const cand = shuffle(tileTokens(c.answers[0]), rnd)[0];
    if (!cand) continue;
    const k = loose(cand, card.tgt);
    if (have.has(k)) continue;
    have.add(k);
    out.push(cand);
  }
  return out;
}

// ------------------------------------------------------------------ search
let index = null;
function buildIndex() {
  index = {
    words: DB.decks.word.ei.map((c) => ({ c, es: loose(c.entry.es, 'es'), it: c.entry.tr.map((t) => loose(t.w, 'it')) })),
    sents: DB.decks.sent.ei.map((c) => ({ c, key: ` ${loose(c.es, 'es')} | ${c.answers.map((a) => loose(a, 'it')).join(' | ')} ` })),
  };
}

export function search(q, limit = 40) {
  if (!index) buildIndex();
  const k = loose(q).trim();
  if (!k) return { words: [], sents: [] };
  const scored = [];
  for (const w of index.words) {
    let s = 0;
    if (w.es === k || w.it.includes(k)) s = 3;
    else if (w.es.startsWith(k) || w.it.some((x) => x.startsWith(k))) s = 2;
    else if (k.length >= 3 && (w.es.includes(k) || w.it.some((x) => x.includes(k)))) s = 1;
    if (s) scored.push([s, w.c]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].order - b[1].order);
  const words = scored.slice(0, limit).map((x) => x[1]);
  const sents = [];
  const kw = ` ${k} `;
  for (const s of index.sents) {
    if (s.key.includes(kw)) sents.push(s.c);
    if (sents.length >= limit) break;
  }
  if (sents.length < limit && k.length >= 3) {
    for (const s of index.sents) {
      if (!s.key.includes(kw) && s.key.includes(k)) sents.push(s.c);
      if (sents.length >= limit) break;
    }
  }
  return { words, sents };
}

export function tatoebaUrl(id) {
  return `https://tatoeba.org/en/sentences/show/${id}`;
}

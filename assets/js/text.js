// Text normalisation, answer checking and speech scoring. Pure functions (no DOM),
// covered by tests/unit/text.test.mjs.

const PUNCT = /[.,;:!?¡¿"«»“”„()[\]{}…–—\-_/\\*~|<>=+#@^]/g;

/** Lowercase, unify apostrophes, drop punctuation, collapse spaces. Keeps accents. */
export function normalize(s) {
  return String(s ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[’‘`´ʼ]/g, "'")
    .replace(PUNCT, ' ')
    .replace(/(^|[^\p{L}])'+/gu, '$1') // apostrophes that do not follow a letter (quotes)
    .replace(/\s+/g, ' ')
    .trim();
}

export function stripAccents(s) {
  return s.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC');
}

const IT_UNITS = ['zero', 'uno', 'due', 'tre', 'quattro', 'cinque', 'sei', 'sette', 'otto', 'nove',
  'dieci', 'undici', 'dodici', 'tredici', 'quattordici', 'quindici', 'sedici', 'diciassette',
  'diciotto', 'diciannove'];
const IT_TENS = ['', '', 'venti', 'trenta', 'quaranta', 'cinquanta', 'sessanta', 'settanta', 'ottanta', 'novanta'];
const ES_UNITS = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve',
  'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho',
  'diecinueve', 'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco',
  'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
const ES_TENS = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];

/** Number (0-100) written as a word, or null. */
export function numberWord(n, lang) {
  if (!Number.isInteger(n) || n < 0 || n > 100) return null;
  if (lang === 'it') {
    if (n === 100) return 'cento';
    if (n < 20) return IT_UNITS[n];
    const t = Math.floor(n / 10), u = n % 10;
    let tens = IT_TENS[t];
    if (u === 0) return tens;
    if (u === 1 || u === 8) tens = tens.slice(0, -1); // ventuno, ventotto
    return tens + (u === 3 ? 'tré' : IT_UNITS[u]);
  }
  if (lang === 'es') {
    if (n === 100) return 'cien';
    if (n < 30) return ES_UNITS[n];
    const t = Math.floor(n / 10), u = n % 10;
    return u === 0 ? ES_TENS[t] : `${ES_TENS[t]} y ${ES_UNITS[u]}`;
  }
  return null;
}

/** Loose form used for "close enough" comparisons: no accents, no apostrophes, numbers as words. */
export function loose(s, lang) {
  let t = normalize(s).replace(/€/g, ' euro ');
  if (lang) t = t.replace(/\b\d{1,3}\b/g, (d) => numberWord(Number(d), lang) ?? d);
  return stripAccents(t).replace(/'/g, '').replace(/\s+/g, ' ').trim();
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

const SUBJECTS = {
  it: ['io', 'tu', 'lui', 'lei', 'noi', 'voi', 'loro', 'egli', 'ella', 'essi', 'esse'],
  es: ['yo', 'tú', 'tu', 'él', 'el', 'ella', 'nosotros', 'nosotras', 'vosotros', 'vosotras',
    'ellos', 'ellas', 'usted', 'ustedes', 'vos'],
};
const ARTICLES = {
  it: ['il', 'lo', 'la', 'i', 'gli', 'le', "l'", 'un', 'uno', 'una', "un'"],
  es: ['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas'],
};

/** Split a leading article off a normalised word answer: "il cane" -> ["il", "cane"]. */
export function splitArticle(norm, lang) {
  const arts = ARTICLES[lang] || [];
  for (const a of arts) {
    if (a.endsWith("'")) {
      if (norm.startsWith(a) && norm.length > a.length) return [a, norm.slice(a.length).trim()];
    } else if (norm.startsWith(a + ' ') && norm.length > a.length + 1) {
      return [a, norm.slice(a.length + 1)];
    }
  }
  return [null, norm];
}

/** Variants of a normalised sentence: as is, and without a leading subject pronoun
 *  (Italian and Spanish both drop subject pronouns: "Io sono stanco" = "Sono stanco"). */
function sentenceVariants(norm, lang) {
  const out = [norm];
  const first = norm.split(' ')[0];
  if ((SUBJECTS[lang] || []).includes(first) && norm.includes(' ')) out.push(norm.slice(first.length + 1));
  return out;
}

function typoOk(ans, exp) {
  // Same number of words; every differing word is a single-letter slip in a word of
  // at least 5 letters; at most one slip per four words.
  const A = ans.split(' '), E = exp.split(' ');
  if (A.length !== E.length) return false;
  let diffs = 0;
  for (let i = 0; i < E.length; i++) {
    if (A[i] === E[i]) continue;
    if (E[i].length < 5 || levenshtein(A[i], E[i]) > 1) return false;
    diffs++;
  }
  return diffs > 0 && diffs <= Math.max(1, Math.floor(E.length / 4));
}

/**
 * Check a typed answer against the accepted answers.
 * @returns {{status:'correct'|'accent'|'typo'|'article'|'wrong'|'empty', expected:string, note?:string}}
 *   correct  exact (ignoring case/punctuation, optional subject pronoun)
 *   accent   right except for accents/apostrophes (e.g. "perche" for "perché")
 *   typo     one-letter slip in a long word
 *   article  word cards: right word, wrong article
 *   wrong
 */
export function checkAnswer(answer, accepted, lang, { word = false } = {}) {
  const a = normalize(answer);
  if (!a) return { status: 'empty', expected: accepted[0] };
  let best = null;
  const rank = { correct: 5, accent: 4, article: 3, typo: 2 };
  const consider = (status, expected, note) => {
    if (!best || rank[status] > rank[best.status]) best = { status, expected, note };
  };
  for (const acc of accepted) {
    const e = normalize(acc);
    if (word) {
      const [aa, aw] = splitArticle(a, lang);
      const [ea, ew] = splitArticle(e, lang);
      if (aw === ew || loose(aw, lang) === loose(ew, lang)) {
        const status = aw === ew ? 'correct' : 'accent';
        if (aa && ea && aa !== ea) consider('article', acc, `The article is "${ea}"`);
        else consider(status, acc);
      } else if (typoOk(loose(aw, lang), loose(ew, lang))) {
        consider('typo', acc);
      }
      continue;
    }
    for (const va of sentenceVariants(a, lang)) {
      for (const ve of sentenceVariants(e, lang)) {
        if (va === ve) return { status: 'correct', expected: acc };
        const la = loose(va, lang), le = loose(ve, lang);
        if (la === le) consider('accent', acc);
        else if (typoOk(la, le)) consider('typo', acc);
      }
    }
  }
  if (best) return best;
  // closest accepted answer to show as the correction
  let closest = accepted[0], dist = Infinity;
  for (const acc of accepted) {
    const d = levenshtein(loose(a, lang), loose(acc, lang));
    if (d < dist) { dist = d; closest = acc; }
  }
  return { status: 'wrong', expected: closest };
}

/** Tokens of a sentence for word tiles: punctuation removed, apostrophes kept ("l'acqua", "po'"). */
export function tileTokens(s) {
  return String(s)
    .normalize('NFC')
    .replace(/[’‘`´ʼ]/g, "'")
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}']+$/u, '').replace(/^'+/, ''))
    .filter((t) => /[\p{L}\p{N}]/u.test(t));
}

/** Longest common subsequence alignment of two token lists -> boolean flags for `b`. */
export function lcsFlags(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const flags = new Array(m).fill(false);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { flags[j] = true; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return flags;
}

/** Accepted answers plus their article-less (words) or pronoun-less (sentences) forms.
 *  Returns [{say, orig}] so a match can be shown with the original spelling. */
export function answerVariants(answers, lang, word) {
  const out = [];
  const seen = new Set();
  const add = (say, orig) => {
    const k = loose(say, lang);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push({ say, orig });
  };
  for (const a of answers) {
    add(a, a);
    const n = normalize(a);
    if (word) {
      const [art, rest] = splitArticle(n, lang);
      if (art) add(rest, a);
    } else {
      for (const v of sentenceVariants(n, lang)) add(v, a);
    }
  }
  return out;
}

/**
 * Score what the speech recogniser heard against the target sentence(s).
 * @param {string[]} heard   recogniser alternatives (best first)
 * @param {string[]} targets accepted sentences
 * @returns {{score:number, target:string, heard:string, words:{w:string, ok:boolean}[]}}
 */
export function speechScore(heard, targets, lang) {
  let best = { score: 0, target: targets[0], index: 0, heard: heard[0] || '', words: [] };
  for (let ti = 0; ti < targets.length; ti++) {
    const t = targets[ti];
    const lt = loose(t, lang);
    for (const hrd of heard) {
      const lh = loose(hrd, lang);
      if (!lt) continue;
      const charSim = 1 - levenshtein(lh, lt) / Math.max(lh.length, lt.length, 1);
      const tw = lt.split(' '), hw = lh.split(' ');
      const flags = lcsFlags(hw, tw);
      const wordSim = flags.filter(Boolean).length / tw.length;
      const score = Math.max(0, Math.min(1, 0.5 * charSim + 0.5 * wordSim));
      if (score > best.score || !best.words.length) {
        const display = tileTokens(t);
        // map flags back onto the displayed words (same tokenisation length in practice)
        const words = display.map((w, i) => ({ w, ok: display.length === tw.length ? flags[i] : lh.includes(loose(w, lang)) }));
        best = { score, target: t, index: ti, heard: hrd, words };
      }
    }
  }
  return best;
}

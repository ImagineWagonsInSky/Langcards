// Lesson engine: builds a queue of exercises, renders them, grades answers and
// updates the spaced-repetition schedule.
import { h, clear, shuffle, weightedPick, icon } from './util.js';
import { DB, deck, distractors, tileDistractors, examples, tatoebaUrl } from './data.js';
import { checkAnswer, normalize, tileTokens, speechScore, answerVariants } from './text.js';
import { schedule, AGAIN, HARD, GOOD, EASY, isDue, isLearned, previewInterval } from './srs.js';
import { getState, settings, save, today, dayStats, recordExercise } from './store.js';
import { speak, stopSpeaking, ttsSupported, hasVoice, recognitionSupported, listenOnce } from './speech.js';
import { play } from './sound.js';

const LANG_NAME = { it: 'Italian', es: 'Spanish' };
const ACCENTS = { it: ['à', 'è', 'é', 'ì', 'ò', 'ù', "'"], es: ['á', 'é', 'í', 'ó', 'ú', 'ñ', 'ü', '¿', '¡'] };

let session = null;
let onExit = () => {};
// read-only hook used by the automated browser tests
if (typeof window !== 'undefined') window.__lcSession = () => session;

export function hasSession() {
  return !!session;
}

// ------------------------------------------------------------------ queue building
function activeDirs() {
  const d = settings().dir;
  return d === 'both' ? ['ei', 'ie'] : [d];
}

export function dueCards() {
  const st = getState(), t = today(), dirs = activeDirs();
  const out = [];
  for (const [id, s] of Object.entries(st.cards)) {
    if (!isDue(s, t)) continue;
    const c = DB.byId.get(id);
    if (c && dirs.includes(c.dir)) out.push(c);
  }
  out.sort((a, b) => st.cards[a.id].d - st.cards[b.id].d);
  return out;
}

export function newCardsLeftToday() {
  return Math.max(0, settings().newPerDay - dayStats().n);
}

export function nextNewCards(n) {
  const s = settings(), st = getState();
  const decks = s.newFrom === 'words' ? ['word'] : s.newFrom === 'sentences' ? ['sent'] : ['word', 'sent'];
  const streams = [];
  for (const dk of decks) {
    for (const dir of activeDirs()) {
      streams.push({ list: deck(dk, dir), i: 0 });
    }
  }
  const out = [];
  let guard = 0;
  while (out.length < n && streams.length && guard++ < 100000) {
    for (let k = 0; k < streams.length && out.length < n; k++) {
      const sm = streams[k];
      while (sm.i < sm.list.length) {
        const c = sm.list[sm.i++];
        if (!st.cards[c.id] && c.lv >= s.startLevel) { out.push(c); break; }
      }
      if (sm.i >= sm.list.length) { streams.splice(k, 1); k--; }
    }
  }
  return out;
}

function pickExercise(card, isNewTest = false) {
  const s = settings();
  const st = getState().cards[card.id];
  const r = st ? st.r : 0;
  const ex = s.ex;
  if (isNewTest) {
    if (ex.mc) return 'mc';
    if (ex.tiles && card.deck === 'sent' && card.n >= 2 && card.n <= 12) return 'tiles';
    if (ex.type) return 'type';
    return 'flash';
  }
  const opts = [];
  if (ex.mc) opts.push(['mc', r < 2 ? 3 : 1]);
  if (ex.tiles && card.deck === 'sent' && card.n >= 2 && card.n <= 12) opts.push(['tiles', r < 2 ? 3 : 2]);
  if (ex.type) opts.push(['type', r < 1 ? 0.5 : 3]);
  if (ex.listen && r >= 1 && ttsSupported() && hasVoice('it')) opts.push(['listen', 1.5]);
  if (ex.speak && r >= 1 && recognitionSupported() && Date.now() > getState().speakOffUntil) opts.push(['speak', 1.5]);
  if (!opts.length) return 'flash';
  return weightedPick(opts);
}

function buildLearnItems() {
  const size = settings().lessonSize;
  const due = shuffleWithin(dueCards());
  const newPool = nextNewCards(newCardsLeftToday());
  const nNew = Math.min(newPool.length, due.length >= size ? 2 : size - due.length);
  const nRev = Math.min(due.length, size - nNew);
  const reviews = due.slice(0, nRev).map((card) => ({ card, ex: pickExercise(card) }));
  const fresh = newPool.slice(0, nNew);
  const items = [];
  const gap = fresh.length ? Math.max(1, Math.floor(reviews.length / fresh.length)) : 0;
  let ri = 0;
  for (const card of fresh) {
    for (let k = 0; k < gap && ri < reviews.length; k++) items.push(reviews[ri++]);
    items.push({ card, ex: 'intro', isNew: true });
    items.push({ card, ex: pickExercise(card, true), isNew: true });
  }
  while (ri < reviews.length) items.push(reviews[ri++]);
  return items;
}

function shuffleWithin(cards) {
  // keep the most overdue first, but vary order among the rest
  return cards.slice(0, 3).concat(shuffle(cards.slice(3)));
}

/** Cards for practice: learned ones first, topped up with the next new ones. */
export function practicePool(n = 10, filter = () => true) {
  const st = getState(), dirs = activeDirs();
  const learned = [];
  for (const [id, s] of Object.entries(st.cards)) {
    const c = DB.byId.get(id);
    if (c && !s.s && isLearned(s) && dirs.includes(c.dir) && filter(c)) learned.push(c);
  }
  let pool = shuffle(learned).slice(0, n);
  if (pool.length < n) {
    const extra = nextNewCards(200).filter(filter);
    pool = pool.concat(extra.slice(0, n - pool.length));
  }
  return shuffle(pool);
}

// ------------------------------------------------------------------ session lifecycle
/**
 * @param {object} o
 *   kind: 'learn' (SRS) | 'flash' (SRS, self-graded) | 'practice' (no schedule changes)
 *   ex:   force one exercise type (practice)
 *   cards: explicit cards (practice)
 */
export function startSession(o, exitCb) {
  onExit = exitCb || (() => {});
  let items;
  if (o.kind === 'learn') items = buildLearnItems();
  else if (o.kind === 'flash') items = shuffleWithin(dueCards()).slice(0, 30).map((card) => ({ card, ex: 'flash' }));
  else items = (o.cards || []).map((card) => ({ card, ex: o.ex || pickExercise(card), practice: true }));
  if (!items.length) return false;
  session = {
    kind: o.kind, title: o.title || '', items, pos: 0, answered: 0, correct: 0, newLearned: 0,
    started: Date.now(), retries: new Map(), ex: o.ex,
  };
  return true;
}

export function renderSession(root) {
  if (!session) return false;
  stopSpeaking();
  clear(root);
  const s = session;
  if (s.pos >= s.items.length) {
    renderSummary(root);
    return true;
  }
  const item = s.items[s.pos];
  const progress = s.items.length ? (s.pos / s.items.length) * 100 : 0;
  const top = h('div', { class: 'session-top' },
    h('button', { class: 'icon-btn', 'aria-label': 'Quit lesson', onclick: quit }, icon('close')),
    h('div', { class: 'progress' }, h('div', { class: 'progress-bar', style: { width: `${progress}%` } })),
    h('span', { class: 'session-count' }, `${s.pos + 1}/${s.items.length}`));
  const body = h('div', { class: 'ex-body' });
  const foot = h('div', { class: 'ex-foot' });
  root.append(h('div', { class: 'session' }, top, body, foot));
  const ctx = makeCtx(item, body, foot, root);
  RENDER[item.ex](item, ctx);
  return true;
}

function quit() {
  if (session && session.answered > 0 && session.pos < session.items.length) {
    if (!confirm('Quit this lesson? Answers you already gave are saved.')) return;
  }
  endSession();
}

function endSession() {
  stopSpeaking();
  session = null;
  save(true);
  onExit();
}

function next(root) {
  session.pos++;
  renderSession(root);
}

// ------------------------------------------------------------------ grading
function makeCtx(item, body, foot, root) {
  const card = item.card;
  const st = getState();
  const prevState = st.cards[card.id] ? { ...st.cards[card.id] } : null;
  let graded = false;

  const applyGrade = (grade) => {
    if (session.kind === 'practice' || item.practice) return;
    st.cards[card.id] = schedule(prevState, grade, today());
    save();
  };

  /** result: {status, expected, given?, note?, kind?} */
  const finish = (result, opts = {}) => {
    if (graded) return;
    graded = true;
    const ok = ['correct', 'accent', 'typo', 'article'].includes(result.status);
    const grade = opts.grade ?? (result.status === 'correct' || result.status === 'accent' ? GOOD : ok ? HARD : AGAIN);
    applyGrade(grade);
    const countNew = !!item.isNew && !item.practice && session.kind !== 'practice';
    recordExercise({ correct: ok, isNew: countNew });
    session.answered++;
    if (ok) session.correct++;
    if (countNew && ok) session.newLearned++;
    if (!ok && grade === AGAIN && session.kind !== 'practice') requeue(item);
    play(ok ? 'good' : 'bad', settings().sounds);
    showFeedback(item, result, ok, foot, root, {
      override: !ok && opts.allowOverride !== false ? () => {
        applyGrade(GOOD);
        session.correct++;
        const d = dayStats();
        d.c += 1;
        save();
        dropRequeue(item);
        if (countNew) session.newLearned++;
      } : null,
    });
  };

  return {
    card, item, body, foot, root,
    finish,
    grade: (g) => { // self-graded flashcards
      if (graded) return;
      graded = true;
      applyGrade(g);
      recordExercise({ correct: g !== AGAIN, isNew: false });
      session.answered++;
      if (g !== AGAIN) session.correct++;
      if (g === AGAIN && session.kind !== 'practice') requeue(item);
      next(root);
    },
    skip: () => next(root),
    replaceWith: (ex) => { item.ex = ex; renderSession(root); },
    prevState,
  };
}

function requeue(item) {
  const n = session.retries.get(item.card.id) || 0;
  if (n >= 2) return;
  session.retries.set(item.card.id, n + 1);
  // flashcard reviews stay flashcards; otherwise re-ask with an easier recognition exercise
  const ex = item.ex === 'flash' ? 'flash' : settings().ex.mc ? 'mc' : item.ex === 'speak' || item.ex === 'listen' ? 'type' : item.ex;
  const retry = { card: item.card, ex, retryOf: item };
  const at = Math.min(session.items.length, session.pos + 4);
  session.items.splice(at, 0, retry);
}

function dropRequeue(item) {
  const i = session.items.findIndex((x, k) => k > session.pos && x.retryOf === item);
  if (i > 0) session.items.splice(i, 1);
}

// ------------------------------------------------------------------ shared UI bits
function voiceFor(lang) {
  const s = settings();
  return lang === 'it' ? s.voiceIt : s.voiceEs;
}

export function say(text, lang, slow = false) {
  return speak(text, lang, { rate: slow ? 0.55 : settings().rate, voiceURI: voiceFor(lang) });
}

export function speakButtons(text, lang, { slow = true, big = false } = {}) {
  if (!ttsSupported()) return null;
  const wrap = h('span', { class: 'speak-btns' });
  wrap.append(h('button', {
    class: big ? 'speak-btn big' : 'speak-btn', type: 'button', 'aria-label': `Listen (${LANG_NAME[lang]})`,
    onclick: (e) => { e.stopPropagation(); say(text, lang); },
  }, icon('speaker')));
  if (slow) {
    wrap.append(h('button', {
      class: big ? 'speak-btn slow big' : 'speak-btn slow', type: 'button', 'aria-label': 'Listen slowly',
      onclick: (e) => { e.stopPropagation(); say(text, lang, true); },
    }, icon('turtle')));
  }
  return wrap;
}

function langTag(lang) {
  return h('span', { class: `lang-tag ${lang}` }, lang === 'it' ? 'IT' : 'ES');
}

function promptBlock(card, label) {
  return h('div', { class: 'prompt' },
    h('div', { class: 'ex-label' }, label),
    h('div', { class: 'prompt-text', lang: card.src },
      langTag(card.src), ' ', h('span', null, card.prompt), ' ',
      card.src === 'it' ? speakButtons(card.prompt, 'it') : null));
}

function checkButton(foot, onClick, label = 'Check') {
  const b = h('button', { class: 'btn primary block', disabled: true, onclick: onClick }, label);
  foot.append(b);
  return b;
}

function genderNote(card) {
  if (card.deck !== 'word') return null;
  const g = card.genders.find(Boolean);
  const tgtIsIt = card.tgt === 'it';
  const itText = tgtIsIt ? card.answers[0] : card.prompt;
  if (!g || !itText.startsWith("l'")) return null;
  return h('span', { class: 'gender' }, g === 'f' ? '(feminine)' : '(masculine)');
}

function extraInfo(card) {
  const parts = [];
  if (card.note) parts.push(h('p', { class: 'note' }, card.note));
  if (card.deck === 'word') {
    const ex = examples(card)[0];
    if (ex) {
      parts.push(h('div', { class: 'example' },
        h('div', { lang: 'es' }, langTag('es'), ' ', ex.es),
        h('div', { lang: 'it' }, langTag('it'), ' ', ex.it, ' ', speakButtons(ex.it, 'it', { slow: false }))));
    }
  }
  return parts;
}

function showFeedback(item, result, ok, foot, root, { override }) {
  const card = item.card;
  clear(foot);
  const titles = {
    correct: 'Correct!', accent: 'Correct — watch the accents', typo: 'Almost — check the spelling',
    article: 'Almost — check the article', wrong: 'Not quite', empty: 'Not quite',
  };
  const panel = h('div', { class: `feedback ${ok ? 'good' : 'bad'}`, role: 'status' });
  panel.append(h('div', { class: 'fb-title' }, icon(ok ? 'check' : 'close'), ' ', titles[result.status] || (ok ? 'Correct!' : 'Not quite')));
  const showExpected = result.status !== 'correct' || card.answers.length > 1 || result.kind === 'speak';
  if (showExpected && result.expected) {
    const lang = result.lang || card.tgt;
    panel.append(h('div', { class: 'fb-answer', lang },
      h('span', { class: 'fb-k' }, ok ? 'Answer:' : 'Correct answer:'), ' ',
      h('strong', null, result.expected), ' ', speakButtons(result.expected, lang, { slow: false })));
  }
  if (result.note) panel.append(h('div', { class: 'fb-note' }, result.note));
  if (result.given && !ok && result.kind !== 'speak') panel.append(h('div', { class: 'fb-given' }, 'You: ', result.given));
  if (result.kind !== 'listen') {
    const others = card.answers.filter((a) => normalize(a) !== normalize(result.expected || '')).slice(0, 2);
    if (others.length && card.deck === 'sent') panel.append(h('div', { class: 'fb-others' }, 'Also correct: ', others.join(' · ')));
  }
  if (card.deck === 'word' && card.tgt === 'it') {
    const g = genderNote(card);
    if (g) panel.append(g);
  }
  if (!ok) extraInfo(card).forEach((p) => panel.append(p));

  const row = h('div', { class: 'fb-actions' });
  if (override) {
    const b = h('button', { class: 'btn link', onclick: () => { override(); b.disabled = true; b.textContent = 'Counted as correct'; panel.classList.replace('bad', 'good'); } }, 'I was right');
    row.append(b);
  }
  if (card.deck === 'sent') {
    const id = card.src === 'es' ? card.esIds[0] : card.itIds[0];
    row.append(h('a', { class: 'btn link', href: tatoebaUrl(id), target: '_blank', rel: 'noopener' }, 'Source'));
  }
  if (session.kind !== 'practice') {
    row.append(h('button', {
      class: 'btn link', onclick: (e) => {
        const st = getState();
        st.cards[card.id] = { ...(st.cards[card.id] || { d: 0, i: 0, e: 250, r: 0, l: 0, t: 0 }), s: 1 };
        save();
        session.items = session.items.filter((x, k) => k <= session.pos || x.card.id !== card.id);
        e.target.disabled = true;
        e.target.textContent = 'Card hidden';
      },
    }, 'Hide card'));
  }
  panel.append(row);
  const cont = h('button', { class: `btn ${ok ? 'primary' : 'danger'} block`, onclick: () => next(root) }, 'Continue');
  foot.append(panel, cont);
  cont.focus({ preventScroll: true });
}

// ------------------------------------------------------------------ exercises
const RENDER = {
  intro(item, ctx) {
    const c = item.card;
    const tgtLang = c.tgt;
    ctx.body.append(
      h('div', { class: 'badge-new' }, c.deck === 'word' ? 'New word' : 'New sentence'),
      h('div', { class: 'intro-card' },
        h('div', { class: 'intro-src', lang: c.src }, langTag(c.src), ' ', c.prompt, ' ', c.src === 'it' ? speakButtons(c.prompt, 'it') : speakButtons(c.prompt, 'es', { slow: false })),
        h('div', { class: 'intro-tgt', lang: tgtLang }, langTag(tgtLang), ' ', h('strong', null, c.answers[0]), ' ', genderNote(c), ' ', speakButtons(c.answers[0], tgtLang)),
        c.answers.length > 1 ? h('div', { class: 'intro-alt' }, 'Also: ', c.answers.slice(1, 4).join(' · ')) : null,
        ...extraInfo(c)));
    if (recognitionSupported() && Date.now() > getState().speakOffUntil && settings().ex.speak) {
      ctx.body.append(readAloud(c.it, 'it', { compact: true }));
    }
    ctx.foot.append(h('button', { class: 'btn primary block', onclick: () => ctx.skip() }, 'Continue'));
    if (settings().autoplay) say(c.it, 'it');
  },

  mc(item, ctx) {
    const c = item.card;
    const opts = shuffle([c.answers[0], ...distractors(c, 3)]);
    ctx.body.append(promptBlock(c, `Choose the ${LANG_NAME[c.tgt]} translation`));
    let chosen = null;
    const list = h('div', { class: 'choices' });
    const check = checkButton(ctx.foot, () => {
      const correct = c.answers.some((a) => normalize(a) === normalize(chosen));
      list.querySelectorAll('button').forEach((b) => {
        b.disabled = true;
        if (normalize(b.dataset.v) === normalize(c.answers[0])) b.classList.add('right');
        else if (b.dataset.v === chosen && !correct) b.classList.add('wrong');
      });
      check.remove();
      ctx.finish({ status: correct ? 'correct' : 'wrong', expected: c.answers[0], given: chosen });
    });
    opts.forEach((o, i) => {
      const b = h('button', {
        class: 'choice', lang: c.tgt, dataset: { v: o }, onclick: () => {
          chosen = o;
          list.querySelectorAll('.choice').forEach((x) => x.classList.toggle('sel', x === b));
          check.disabled = false;
          if (c.tgt === 'it' && settings().autoplay && c.deck === 'word') say(o, 'it');
        },
      }, h('span', { class: 'choice-n' }, String(i + 1)), h('span', null, o));
      list.append(b);
    });
    ctx.body.append(list);
  },

  type(item, ctx) {
    const c = item.card;
    ctx.body.append(promptBlock(c, `Write this in ${LANG_NAME[c.tgt]}`));
    const input = h('textarea', {
      class: 'answer-input', rows: c.deck === 'word' ? 1 : 3, lang: c.tgt, autocomplete: 'off', autocorrect: 'off',
      autocapitalize: 'off', spellcheck: 'false', placeholder: `Type in ${LANG_NAME[c.tgt]}…`, enterkeyhint: 'done',
    });
    ctx.body.append(input, accentBar(input, c.tgt),
      h('p', { class: 'hint' }, 'Tip: you can also tap the microphone on your keyboard to dictate.'));
    const doCheck = () => {
      const r = checkAnswer(input.value, c.answers, c.tgt, { word: c.deck === 'word' });
      if (r.status === 'empty') return;
      input.disabled = true;
      check.remove();
      skipBtn.remove();
      ctx.finish({ ...r, given: input.value.trim() });
    };
    const check = checkButton(ctx.foot, doCheck);
    const skipBtn = h('button', { class: 'btn ghost block', onclick: () => { input.disabled = true; check.remove(); skipBtn.remove(); ctx.finish({ status: 'wrong', expected: c.answers[0] }, { allowOverride: false }); } }, "I don't know");
    ctx.foot.append(skipBtn);
    input.addEventListener('input', () => { check.disabled = !input.value.trim(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (input.value.trim()) doCheck(); }
    });
    setTimeout(() => input.focus({ preventScroll: true }), 50);
  },

  tiles(item, ctx) {
    const c = item.card;
    tilesExercise(ctx, c, c.answers[0], `Build the ${LANG_NAME[c.tgt]} translation`, c.answers, c.tgt, promptBlock(c, `Build the ${LANG_NAME[c.tgt]} translation`));
  },

  listen(item, ctx) {
    const c = item.card;
    const text = c.it;
    const head = h('div', { class: 'prompt' },
      h('div', { class: 'ex-label' }, 'Type what you hear (Italian)'),
      h('div', { class: 'listen-row' }, speakButtons(text, 'it', { big: true })));
    const n = tileTokens(text).length;
    if (c.deck === 'sent' && n >= 2 && n <= 10 && settings().ex.tiles && Math.random() < 0.5) {
      // distractor tiles must be Italian, whatever the card's direction
      tilesExercise(ctx, { ...c, dir: 'ei', tgt: 'it' }, text, 'Tap what you hear', [text], 'it', head, 'listen');
    } else {
      ctx.body.append(head);
      const input = h('textarea', { class: 'answer-input', rows: c.deck === 'word' ? 1 : 2, lang: 'it', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'Type in Italian…' });
      ctx.body.append(input, accentBar(input, 'it'));
      const doCheck = () => {
        const r = checkAnswer(input.value, [text], 'it', { word: c.deck === 'word' });
        if (r.status === 'empty') return;
        input.disabled = true;
        check.remove();
        ctx.finish({ ...r, given: input.value.trim(), lang: 'it', kind: 'listen' });
      };
      const check = checkButton(ctx.foot, doCheck);
      input.addEventListener('input', () => { check.disabled = !input.value.trim(); });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (input.value.trim()) doCheck(); } });
    }
    if (settings().autoplay) say(text, 'it');
  },

  speak(item, ctx) {
    const c = item.card;
    const isPractice = item.practice || session.kind === 'practice';
    // Practice: read the Italian text aloud. Lessons: translate aloud into the target language.
    const readMode = isPractice;
    const lang = readMode ? 'it' : c.tgt;
    const targets = readMode ? [c.it] : c.answers;
    // accept answers without the article ("cane" for "il cane") or the subject pronoun
    const variants = answerVariants(targets, lang, c.deck === 'word');
    if (readMode) {
      ctx.body.append(h('div', { class: 'prompt' },
        h('div', { class: 'ex-label' }, 'Read this aloud'),
        h('div', { class: 'prompt-text', lang: 'it' }, langTag('it'), ' ', c.it, ' ', speakButtons(c.it, 'it')),
        h('div', { class: 'prompt-sub', lang: 'es' }, c.es)));
    } else {
      ctx.body.append(promptBlock(c, `Say this in ${LANG_NAME[lang]}`));
    }
    const orig = (res) => (res ? variants[res.index]?.orig : null) || targets[0];
    const done = (status, res, opts) => { mic.disable(); ctx.finish({ status, expected: orig(res), lang, kind: 'speak' }, opts); };
    const mic = micWidget(lang, variants.map((v) => v.say), {
      onPass: (res) => done('correct', res),
      onGiveUp: (res) => done('wrong', res, { allowOverride: !readMode }),
      onOverride: (res) => done('correct', res),
    });
    ctx.body.append(mic.el);
    const cant = h('button', {
      class: 'btn ghost block', onclick: () => {
        mic.stop();
        if (isPractice) { ctx.skip(); return; }
        getState().speakOffUntil = Date.now() + 60 * 60 * 1000;
        save();
        ctx.replaceWith(settings().ex.type ? 'type' : 'mc');
      },
    }, isPractice ? 'Skip' : "Can't speak now");
    ctx.foot.append(cant);
  },

  flash(item, ctx) {
    const c = item.card;
    ctx.body.append(promptBlock(c, `Do you know it in ${LANG_NAME[c.tgt]}?`));
    const ans = h('div', { class: 'flash-answer hidden', lang: c.tgt },
      h('div', { class: 'flash-main' }, langTag(c.tgt), ' ', h('strong', null, c.answers[0]), ' ', genderNote(c), ' ', speakButtons(c.answers[0], c.tgt)),
      c.answers.length > 1 ? h('div', { class: 'intro-alt' }, 'Also: ', c.answers.slice(1, 4).join(' · ')) : null,
      ...extraInfo(c));
    ctx.body.append(ans);
    const show = h('button', {
      class: 'btn primary block', onclick: () => {
        ans.classList.remove('hidden');
        show.remove();
        if (settings().autoplay && c.tgt === 'it') say(c.answers[0], 'it');
        const t = today();
        const practice = session.kind === 'practice';
        const grades = [[AGAIN, 'Again', 'danger'], [HARD, 'Hard', 'warn'], [GOOD, 'Good', 'primary'], [EASY, 'Easy', 'easy']];
        const row = h('div', { class: 'grade-row' });
        for (const [g, label, cls] of grades) {
          row.append(h('button', { class: `btn ${cls}`, onclick: () => ctx.grade(g) },
            h('span', null, label), practice ? null : h('small', null, previewInterval(ctx.prevState, g, t))));
        }
        ctx.foot.append(row);
      },
    }, 'Show answer');
    ctx.foot.append(show);
  },
};

// ------------------------------------------------------------------ tiles
let namesCache = null;
/** Words that are always capitalised (names like Tom, Italia): capitalised somewhere in the
 *  middle of a sentence and never written in lowercase anywhere in the corpus. */
function names() {
  if (namesCache) return namesCache;
  const caps = new Set(), lower = new Set();
  const add = (s) => {
    const toks = tileTokens(s);
    for (let i = 0; i < toks.length; i++) {
      if (/^\p{Lu}/u.test(toks[i])) { if (i > 0) caps.add(toks[i]); }
      else lower.add(toks[i].toLowerCase());
    }
  };
  for (const t of DB.es.values()) add(t);
  for (const v of DB.it.values()) add(v.t);
  namesCache = new Set([...caps].filter((w) => !lower.has(w.toLowerCase())));
  return namesCache;
}

function tileCase(tok) {
  if (tok === 'Lei') return tok; // formal "you" keeps its capital
  return names().has(tok) ? tok : tok.toLowerCase();
}

function tilesExercise(ctx, card, target, label, accepted, lang, header, kind) {
  const tokens = tileTokens(target).map(tileCase);
  const extra = tileDistractors(card, tokens, Math.min(4, Math.max(2, Math.round(tokens.length / 2)))).map(tileCase);
  const bankTiles = shuffle([...tokens, ...extra]).map((w, i) => ({ w, i }));
  ctx.body.append(header);
  const line = h('div', { class: 'tile-line', 'aria-label': 'Your answer' });
  const bank = h('div', { class: 'tile-bank' });
  const chosen = [];
  const check = checkButton(ctx.foot, () => {
    const given = chosen.map((t) => t.w).join(' ');
    const ok = normalize(given) === normalize(tokens.join(' ')) || accepted.some((a) => normalize(a) === normalize(given));
    check.remove();
    bank.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    line.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    ctx.finish({ status: ok ? 'correct' : 'wrong', expected: target, given, lang, kind });
  });
  const redraw = () => {
    clear(line);
    for (const t of chosen) {
      line.append(h('button', {
        class: 'tile', lang, onclick: () => {
          chosen.splice(chosen.indexOf(t), 1);
          t.btn.classList.remove('used');
          t.btn.disabled = false;
          redraw();
        },
      }, t.w));
    }
    check.disabled = chosen.length === 0;
  };
  for (const t of bankTiles) {
    t.btn = h('button', {
      class: 'tile', lang, onclick: () => {
        chosen.push(t);
        t.btn.classList.add('used');
        t.btn.disabled = true;
        if (lang === 'it' && settings().autoplay && kind !== 'listen') say(t.w, 'it');
        redraw();
      },
    }, t.w);
    bank.append(t.btn);
  }
  ctx.body.append(line, bank);
}

// ------------------------------------------------------------------ accents keyboard
function accentBar(input, lang) {
  const bar = h('div', { class: 'accent-bar' });
  for (const ch of ACCENTS[lang] || []) {
    bar.append(h('button', {
      class: 'accent', type: 'button', onmousedown: (e) => e.preventDefault(), onpointerdown: (e) => e.preventDefault(),
      onclick: () => {
        const s = input.selectionStart ?? input.value.length, e = input.selectionEnd ?? input.value.length;
        input.value = input.value.slice(0, s) + ch + input.value.slice(e);
        input.selectionStart = input.selectionEnd = s + ch.length;
        input.dispatchEvent(new Event('input'));
        input.focus();
      },
    }, ch));
  }
  return bar;
}

// ------------------------------------------------------------------ microphone
/** Read-aloud widget used in intros (not graded). */
export function readAloud(text, lang, { compact = false } = {}) {
  const w = micWidget(lang, [text], { compact, ungraded: true });
  return w.el;
}

function micWidget(lang, targets, { onPass, onGiveUp, onOverride, compact = false, ungraded = false } = {}) {
  const el = h('div', { class: compact ? 'mic-box compact' : 'mic-box' });
  const status = h('div', { class: 'mic-status' }, compact ? 'Try saying it' : `Tap the microphone and speak ${LANG_NAME[lang]}`);
  const heard = h('div', { class: 'mic-heard', lang });
  const words = h('div', { class: 'mic-words', lang });
  const actions = h('div', { class: 'mic-actions' });
  let rec = null;
  let attempts = 0;
  let last = null;
  const btn = h('button', { class: 'mic-btn', type: 'button', 'aria-label': 'Speak' }, icon('mic'));
  const setIdle = () => { btn.classList.remove('live'); rec = null; };
  btn.addEventListener('click', () => {
    if (rec) { rec.stop(); return; }
    clear(actions);
    heard.textContent = '';
    clear(words);
    btn.classList.add('live');
    status.textContent = 'Listening… speak now';
    rec = listenOnce(lang, { onInterim: (t) => { heard.textContent = t; } });
    rec.promise.then(({ alternatives }) => {
      setIdle();
      attempts++;
      const res = speechScore(alternatives, targets, lang);
      last = res;
      heard.textContent = `“${res.heard}”`;
      clear(words);
      res.words.forEach((wd) => words.append(h('span', { class: wd.ok ? 'w-ok' : 'w-miss' }, wd.w), ' '));
      const pct = Math.round(res.score * 100);
      if (res.score >= 0.8) {
        status.textContent = `Great! ${pct}% match`;
        play('good', settings().sounds && ungraded);
        if (!ungraded && onPass) {
          btn.disabled = true;
          onPass(res);
        }
      } else {
        status.textContent = res.score >= 0.6 ? `Almost — ${pct}% match. Try again.` : `${pct}% match. Listen and try again.`;
        if (!ungraded) {
          actions.append(
            h('button', { class: 'btn link', onclick: () => onOverride?.(res) }, 'I said it right'),
            h('button', { class: 'btn link', onclick: () => onGiveUp?.(res) }, attempts >= 2 ? 'Show answer' : 'Give up'));
        }
      }
    }).catch((err) => {
      setIdle();
      status.textContent = err?.message || 'Could not hear you. Try again.';
      if (!ungraded && err?.code && err.code !== 'no-speech' && err.code !== 'aborted') {
        actions.append(h('button', { class: 'btn link', onclick: () => onGiveUp?.(last) }, 'Skip'));
      }
    });
  });
  el.append(btn, status, heard, words, actions);
  return {
    el,
    stop: () => rec?.stop(),
    disable: () => { rec?.stop(); btn.disabled = true; clear(actions); },
  };
}

// ------------------------------------------------------------------ summary
function renderSummary(root) {
  const s = session;
  const secs = Math.round((Date.now() - s.started) / 1000);
  const acc = s.answered ? Math.round((s.correct / s.answered) * 100) : 100;
  play('done', settings().sounds);
  const moreDue = s.kind === 'learn' && (dueCards().length > 0 || (newCardsLeftToday() > 0 && nextNewCards(1).length > 0));
  const kind = s.kind;
  const title = s.kind === 'practice' ? 'Practice complete!' : 'Lesson complete!';
  root.append(h('div', { class: 'summary' },
    h('div', { class: 'summary-emoji' }, acc >= 80 ? '🎉' : '💪'),
    h('h2', null, title),
    h('div', { class: 'summary-grid' },
      stat(String(s.answered), 'answers'), stat(`${acc}%`, 'accuracy'),
      stat(String(s.newLearned), 'new cards'), stat(`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`, 'time')),
    moreDue ? h('button', { class: 'btn primary block', onclick: () => { const cb = onExit; session = null; if (startSession({ kind }, cb)) renderSession(root); else cb(); } }, 'Keep going') : null,
    h('button', { class: `btn ${moreDue ? 'ghost' : 'primary'} block`, onclick: endSession }, 'Done')));
}

function stat(v, label) {
  return h('div', { class: 'stat' }, h('div', { class: 'stat-v' }, v), h('div', { class: 'stat-l' }, label));
}

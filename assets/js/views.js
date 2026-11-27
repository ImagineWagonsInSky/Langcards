// Screens (everything except the lesson itself).
import { h, clear, icon, shuffle, dayNumber, dateKey, debounce, plural } from './util.js';
import { DB, deck, search, examples, tatoebaUrl, getCard } from './data.js';
import { getState, settings, updateSettings, save, today, dayStats, streak, isFav, toggleFav, exportJSON, importJSON, resetAll, requestPersistence, DEFAULT_SETTINGS } from './store.js';
import { isLearned, isMature } from './srs.js';
import { dueCards, newCardsLeftToday, nextNewCards, practicePool, startSession, say, speakButtons, readAloud, PLACEMENT_PER_LEVEL } from './session.js';
import { ttsSupported, voicesFor, bestVoice, onVoices, recognitionSupported, listenOnce } from './speech.js';
import { FALSE_FRIENDS, TIPS } from './content.js';
import { play } from './sound.js';

let go = () => {};
export function setNavigator(fn) { go = fn; }

function page(title, ...children) {
  return h('div', { class: 'page' }, title ? h('h1', { class: 'page-title' }, title) : null, ...children);
}

function langTag(lang) {
  return h('span', { class: `lang-tag ${lang}` }, lang === 'it' ? 'IT' : 'ES');
}

// ------------------------------------------------------------------ home
function counts() {
  const st = getState();
  let words = 0, sents = 0, mature = 0;
  const perLevel = { word: [0, 0, 0, 0, 0], sent: [0, 0, 0, 0, 0] };
  for (const [id, s] of Object.entries(st.cards)) {
    if (!isLearned(s) || s.s) continue;
    const c = getCard(id);
    if (!c) continue;
    if (c.deck === 'word') words++; else sents++;
    if (isMature(s)) mature++;
    perLevel[c.deck][c.lv - 1]++;
  }
  return { words, sents, mature, perLevel };
}

function levelTotals(dk) {
  const dirs = settings().dir === 'both' ? ['ei', 'ie'] : [settings().dir];
  const t = [0, 0, 0, 0, 0];
  for (const dir of dirs) for (const c of deck(dk, dir)) t[c.lv - 1]++;
  return t;
}

export function renderHome(root) {
  const s = settings();
  const due = dueCards().length;
  const newLeft = Math.min(newCardsLeftToday(), nextNewCards(newCardsLeftToday()).length);
  const d = dayStats();
  const goalPct = Math.min(100, Math.round((d.x / Math.max(1, s.dailyGoal)) * 100));
  const c = counts();
  const st = streak();
  const dirLabel = { ei: 'Spanish → Italian', ie: 'Italian → Spanish', both: 'Both directions' }[s.dir];

  const startBtn = h('button', {
    class: 'btn primary block big', disabled: !due && !newLeft,
    onclick: () => { if (startSession({ kind: 'learn' }, () => go('#/'))) go('#/session'); },
  }, due || newLeft ? 'Start lesson' : 'All done for today 🎉');

  const ring = h('div', { class: 'ring', style: { '--p': goalPct } }, h('div', { class: 'ring-in' }, h('b', null, String(d.x)), h('small', null, `/ ${s.dailyGoal}`)));

  // last 7 days activity
  const t = today();
  const bars = h('div', { class: 'week' });
  const maxX = Math.max(1, ...Array.from({ length: 7 }, (_, i) => getState().days[dateKey(t - 6 + i)]?.x || 0));
  for (let i = 0; i < 7; i++) {
    const day = t - 6 + i;
    const x = getState().days[dateKey(day)]?.x || 0;
    const lbl = new Date(day * 86400000).toLocaleDateString(undefined, { weekday: 'narrow', timeZone: 'UTC' });
    bars.append(h('div', { class: 'week-day' }, h('div', { class: 'week-bar', style: { height: `${Math.round((x / maxX) * 100)}%` }, title: `${x}` }), h('small', null, lbl)));
  }

  const lv = (dk, name) => {
    const tot = levelTotals(dk);
    return h('div', { class: 'levels' }, h('h3', null, name),
      ...tot.map((n, i) => {
        const have = c.perLevel[dk][i];
        const pct = n ? Math.min(100, (have / n) * 100) : 0;
        const skipped = i + 1 < settings().startLevel;
        return h('div', { class: `level-row ${skipped ? 'skipped' : ''}` }, h('span', null, `Level ${i + 1}`, skipped ? h('small', null, ' skipped') : null),
          h('div', { class: 'progress small' }, h('div', { class: 'progress-bar', style: { width: `${pct}%` } })),
          h('small', null, `${have}/${n}`));
      }));
  };

  root.append(page(null,
    h('div', { class: 'home-head' },
      h('div', null, h('div', { class: 'app-name' }, 'LangCards'), h('div', { class: 'muted' }, dirLabel)),
      h('div', { class: 'streak', title: 'Day streak' }, icon('flame'), h('b', null, String(st)))),
    h('div', { class: 'card hero' },
      ring,
      h('div', { class: 'hero-info' },
        h('div', null, h('b', null, String(due)), ' due for review'),
        h('div', null, h('b', null, String(newLeft)), ' new today'),
        h('div', { class: 'muted' }, 'Daily goal: ', String(s.dailyGoal), ' answers'))),
    startBtn,
    levelCard(c.words + c.sents),
    due ? h('button', { class: 'btn ghost block', onclick: () => { if (startSession({ kind: 'flash' }, () => go('#/'))) go('#/session'); } }, 'Review with flashcards') : null,
    h('div', { class: 'card stats' },
      h('div', { class: 'stat' }, h('div', { class: 'stat-v' }, String(c.words)), h('div', { class: 'stat-l' }, 'words learned')),
      h('div', { class: 'stat' }, h('div', { class: 'stat-v' }, String(c.sents)), h('div', { class: 'stat-l' }, 'sentences learned')),
      h('div', { class: 'stat' }, h('div', { class: 'stat-v' }, String(c.mature)), h('div', { class: 'stat-l' }, 'mastered'))),
    h('div', { class: 'card' }, h('h3', null, 'This week'), bars),
    h('div', { class: 'card' }, lv('word', 'Words'), lv('sent', 'Sentences')),
  ));
}

// "Already know some Italian?": placement test + quick level jump.
export function startPlacement() {
  if (startSession({ kind: 'placement' }, () => go('#/'))) go('#/session');
}

function levelPicker(onPick) {
  const cur = settings().startLevel;
  return h('div', { class: 'level-pick', role: 'group', 'aria-label': 'Starting level' },
    ...[1, 2, 3, 4, 5].map((n) => h('button', {
      class: `level-chip ${n === cur ? 'on' : ''}`, 'aria-pressed': String(n === cur),
      onclick: () => { updateSettings({ startLevel: n }); onPick(); },
    }, String(n))));
}

function levelCard(learnedTotal) {
  const cur = settings().startLevel;
  // Shown to newcomers and to anyone who has moved the starting level.
  if (learnedTotal >= 150 && cur === 1) return null;
  return h('div', { class: 'card level-card' },
    h('h3', null, cur > 1 ? `Starting at Level ${cur}` : 'Already know some Italian?'),
    h('p', { class: 'muted small' }, `Take a quick placement test (${PLACEMENT_PER_LEVEL} questions per level) or pick where new cards start. Levels go from 1 (basics) to 5 (hardest).`),
    h('button', { class: 'btn primary block', onclick: startPlacement }, 'Take placement test'),
    h('div', { class: 'level-pick-row' }, h('span', { class: 'muted small' }, 'Start new cards at level:'), levelPicker(() => go('#/'))));
}

// ------------------------------------------------------------------ practice
export function renderPractice(root) {
  const run = (o) => { if (startSession({ kind: 'practice', ...o }, () => go('#/practice'))) go('#/session'); else alert('Nothing to practise yet.'); };
  const mode = (emoji, title, desc, fn, disabledReason) => h('button', { class: 'mode', disabled: !!disabledReason, onclick: fn },
    h('span', { class: 'mode-emoji' }, emoji), h('span', { class: 'mode-t' }, title), h('small', null, disabledReason || desc));
  const favCards = () => getState().favs.map(getCard).filter(Boolean);
  const hard = () => Object.entries(getState().cards).filter(([, s]) => s.l > 0 && !s.s).sort((a, b) => b[1].l - a[1].l).slice(0, 15).map(([id]) => getCard(id)).filter(Boolean);
  const noMic = recognitionSupported() ? null : 'Not supported in this browser';
  const noTts = ttsSupported() ? null : 'Text-to-speech not available';
  root.append(page('Practice',
    h('p', { class: 'muted' }, 'Practice uses cards you have learned (topped up with upcoming ones). It does not change your review schedule.'),
    h('div', { class: 'modes' },
      mode('🎤', 'Speaking', 'Read Italian sentences aloud and get a pronunciation score', () => run({ ex: 'speak', cards: practicePool(10, (c) => c.deck === 'sent') }), noMic),
      mode('🎧', 'Listening', 'Hear Italian and write what you hear', () => run({ ex: 'listen', cards: practicePool(10) }), noTts),
      mode('⌨️', 'Writing', 'Translate by typing', () => run({ ex: 'type', cards: practicePool(10) })),
      mode('🧩', 'Word tiles', 'Build sentences from tiles', () => run({ ex: 'tiles', cards: practicePool(10, (c) => c.deck === 'sent' && c.n >= 2 && c.n <= 12) })),
      mode('✅', 'Quick quiz', 'Multiple choice', () => run({ ex: 'mc', cards: practicePool(12) })),
      mode('🃏', 'Flashcards', 'Classic self-graded cards', () => run({ ex: 'flash', cards: practicePool(20) })),
      mode('⭐', 'Favourites', 'Your starred cards', () => run({ cards: shuffle(favCards()).slice(0, 15) }), favCards().length ? null : 'Star cards in the dictionary first'),
      mode('🔁', 'Tricky cards', 'The ones you missed most', () => run({ cards: shuffle(hard()) }), hard().length ? null : 'No mistakes yet'),
      mode('⚠️', 'False friends quiz', 'burro ≠ burro!', () => go('#/false-friends/quiz')),
    )));
}

// ------------------------------------------------------------------ dictionary
function favButton(card) {
  const b = h('button', { class: `icon-btn fav ${isFav(card.id) ? 'on' : ''}`, 'aria-label': 'Star', onclick: (e) => { e.stopPropagation(); b.classList.toggle('on', toggleFav(card.id)); } }, icon('star'));
  return b;
}

function wordRow(c) {
  const det = h('div', { class: 'row-detail hidden' });
  const row = h('div', { class: 'row', onclick: () => {
    if (!det.childNodes.length) {
      if (c.note) det.append(h('p', { class: 'note' }, c.note));
      const exs = examples(c);
      for (const ex of exs) {
        det.append(h('div', { class: 'example' }, h('div', { lang: 'es' }, langTag('es'), ' ', ex.es), h('div', { lang: 'it' }, langTag('it'), ' ', ex.it, ' ', speakButtons(ex.it, 'it', { slow: false }))));
      }
      if (recognitionSupported()) det.append(readAloud(c.answers[0], 'it', { compact: true }));
      if (!det.childNodes.length) det.append(h('p', { class: 'muted' }, 'No example sentence for this word.'));
    }
    det.classList.toggle('hidden');
  } },
  h('div', { class: 'row-main' },
    h('div', { lang: 'es' }, langTag('es'), ' ', c.es, ' ', h('small', { class: 'pos' }, c.pos)),
    h('div', { lang: 'it' }, langTag('it'), ' ', h('b', null, c.answers.join(', ')), ' ', speakButtons(c.answers[0], 'it'))),
  favButton(c));
  return h('div', { class: 'row-wrap' }, row, det);
}

function sentRow(c) {
  return h('div', { class: 'row-wrap' }, h('div', { class: 'row' },
    h('div', { class: 'row-main' },
      h('div', { lang: 'es' }, langTag('es'), ' ', c.es),
      ...c.answers.slice(0, 3).map((a) => h('div', { lang: 'it' }, langTag('it'), ' ', h('b', null, a), ' ', speakButtons(a, 'it'))),
      h('a', { class: 'src-link', href: tatoebaUrl(c.esIds[0]), target: '_blank', rel: 'noopener' }, `Tatoeba #${c.esIds[0]} · level ${c.lv}`)),
    favButton(c)));
}

export function renderDict(root, q = '') {
  const input = h('input', { class: 'search', type: 'search', placeholder: 'Search Spanish or Italian…', value: q, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const results = h('div', { class: 'results' });
  const show = () => {
    clear(results);
    const v = input.value.trim();
    history.replaceState(null, '', v ? `#/dict?q=${encodeURIComponent(v)}` : '#/dict');
    if (!v) { browse(results); return; }
    const r = search(v);
    if (!r.words.length && !r.sents.length) { results.append(h('p', { class: 'muted' }, 'No results.')); return; }
    if (r.words.length) results.append(h('h3', null, `Words (${r.words.length})`), ...r.words.map(wordRow));
    if (r.sents.length) results.append(h('h3', null, `Sentences (${r.sents.length}${r.sents.length >= 40 ? '+' : ''})`), ...r.sents.map(sentRow));
  };
  input.addEventListener('input', debounce(show, 200));
  root.append(page('Dictionary',
    h('div', { class: 'search-wrap' }, icon('search'), input),
    h('p', { class: 'muted small' }, `${DB.meta.counts.words.toLocaleString()} words · ${DB.meta.counts.sentence_pairs.toLocaleString()} sentence pairs`),
    results));
  show();
}

function browse(results) {
  const favs = getState().favs.map(getCard).filter(Boolean);
  if (favs.length) {
    results.append(h('h3', null, '⭐ Favourites'), ...favs.slice(0, 50).map((c) => (c.deck === 'word' ? wordRow(c) : sentRow(c))));
  }
  results.append(h('h3', null, 'Browse core vocabulary'));
  const grid = h('div', { class: 'chips' });
  for (const [cat, list] of DB.categories) {
    grid.append(h('button', { class: 'chip', onclick: () => {
      clear(results);
      results.append(h('button', { class: 'btn link', onclick: () => { clear(results); browse(results); } }, '← Back'), h('h3', null, cat), ...list.map(wordRow));
    } }, `${cat} (${list.length})`));
  }
  results.append(grid);
}

// ------------------------------------------------------------------ false friends
export function renderFalseFriends(root) {
  root.append(page('False friends',
    h('p', { class: 'muted' }, 'Words that look alike in Spanish and Italian but mean different things.'),
    h('button', { class: 'btn primary block', onclick: () => go('#/false-friends/quiz') }, 'Quiz me'),
    ...FALSE_FRIENDS.map((f) => h('div', { class: 'card ff' },
      h('div', { class: 'ff-row' },
        h('div', { class: 'ff-side', lang: 'es' }, h('div', { class: 'ff-word' }, langTag('es'), ' ', h('b', null, f.es)), h('div', null, '= ', f.esMeans), h('small', null, 'in Italian: ', h('i', { lang: 'it' }, f.esInIt))),
        h('div', { class: 'ff-side', lang: 'it' }, h('div', { class: 'ff-word' }, langTag('it'), ' ', h('b', null, f.it), ' ', speakButtons(f.it, 'it', { slow: false })), h('div', null, '= ', f.itMeans), h('small', null, 'in Spanish: ', h('i', { lang: 'es' }, f.itInEs)))),
      f.both ? h('p', { class: 'note' }, f.both) : null))));
}

export function renderFFQuiz(root) {
  const qs = shuffle(FALSE_FRIENDS).slice(0, 10);
  let i = 0, score = 0;
  const box = h('div');
  const ask = () => {
    clear(box);
    if (i >= qs.length) {
      play('done', settings().sounds);
      box.append(h('div', { class: 'summary' }, h('div', { class: 'summary-emoji' }, score >= 8 ? '🎉' : '💪'), h('h2', null, `${score} / ${qs.length}`),
        h('button', { class: 'btn primary block', onclick: () => { i = 0; score = 0; qs.splice(0, qs.length, ...shuffle(FALSE_FRIENDS).slice(0, 10)); ask(); } }, 'Again'),
        h('button', { class: 'btn ghost block', onclick: () => go('#/false-friends') }, 'See the list')));
      return;
    }
    const f = qs[i];
    const others = shuffle(FALSE_FRIENDS.filter((x) => x !== f && x.itMeans !== f.itMeans && x.itMeans !== f.esMeans)).slice(0, 2).map((x) => x.itMeans);
    const opts = shuffle([f.itMeans, f.esMeans, ...others]);
    box.append(h('div', { class: 'ex-label' }, `Question ${i + 1} of ${qs.length}`),
      h('div', { class: 'prompt-text' }, 'What does the ', h('b', null, 'Italian'), ' word ', h('b', { lang: 'it' }, `“${f.it}”`), ' mean? ', speakButtons(f.it, 'it', { slow: false })));
    const list = h('div', { class: 'choices' });
    for (const o of opts) {
      list.append(h('button', { class: 'choice', onclick: (e) => {
        const ok = o === f.itMeans;
        if (ok) score++;
        play(ok ? 'good' : 'bad', settings().sounds);
        list.querySelectorAll('button').forEach((b) => { b.disabled = true; if (b.textContent === f.itMeans) b.classList.add('right'); });
        if (!ok) e.currentTarget.classList.add('wrong');
        box.append(h('div', { class: `feedback ${ok ? 'good' : 'bad'}` },
          h('div', { class: 'fb-title' }, ok ? 'Correct!' : 'Careful!'),
          h('div', null, h('span', { lang: 'it' }, `IT ${f.it}`), ` = ${f.itMeans} (in Spanish: `, h('i', { lang: 'es' }, f.itInEs), ')'),
          h('div', null, h('span', { lang: 'es' }, `ES ${f.es}`), ` = ${f.esMeans} (in Italian: `, h('i', { lang: 'it' }, f.esInIt), ')')),
        h('button', { class: 'btn primary block', onclick: () => { i++; ask(); } }, 'Continue'));
      } }, o));
    }
    box.append(list);
  };
  root.append(page('False friends quiz', box));
  ask();
}

// ------------------------------------------------------------------ tips
export function renderTips(root) {
  root.append(page('Grammar tips',
    h('p', { class: 'muted' }, 'The main differences for Spanish speakers learning Italian.'),
    ...TIPS.map((t) => h('details', { class: 'card tip' },
      h('summary', null, t.title),
      h('p', null, t.body),
      h('div', { class: 'tip-ex' }, ...t.ex.map(([es, it]) => h('div', { class: 'tip-row' },
        h('span', { lang: 'es' }, es), h('span', { class: 'arrow' }, '→'), h('b', { lang: 'it' }, it), speakButtons(it, 'it', { slow: false }))))))));
}

// ------------------------------------------------------------------ more
export function renderMore(root, installPrompt) {
  const item = (emoji, title, href) => h('a', { class: 'menu-item', href }, h('span', null, emoji), h('span', null, title));
  root.append(page('More',
    h('div', { class: 'menu' },
      item('⚠️', 'False friends', '#/false-friends'),
      item('📘', 'Grammar tips', '#/tips'),
      item('⚙️', 'Settings', '#/settings'),
      item('ℹ️', 'About & data sources', '#/about')),
    installCard(installPrompt)));
}

function installCard(installPrompt) {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) return h('div', { class: 'card' }, h('p', null, '✅ Installed as an app. Works offline.'));
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return h('div', { class: 'card' },
    h('h3', null, '📲 Install on your phone'),
    installPrompt?.() ? h('button', { class: 'btn primary block', onclick: () => installPrompt()?.prompt() }, 'Install app') : null,
    ios
      ? h('p', null, 'In Safari tap the Share button, then “Add to Home Screen”.')
      : h('p', null, 'In Chrome open the ⋮ menu and choose “Install app” or “Add to Home screen”.'),
    h('p', { class: 'muted small' }, 'Once installed it opens full-screen and works offline.'));
}

// ------------------------------------------------------------------ settings
export function renderSettings(root) {
  const s = settings();
  const sel = (key, opts, val = s[key], cast = (x) => x) => {
    const e = h('select', { onchange: () => updateSettings({ [key]: cast(e.value) }) }, ...opts.map(([v, l]) => h('option', { value: v, selected: String(v) === String(val) }, l)));
    return e;
  };
  const row = (label, control, help) => h('label', { class: 'set-row' }, h('div', null, h('div', null, label), help ? h('small', { class: 'muted' }, help) : null), control);
  const toggle = (checked, fn) => { const e = h('input', { type: 'checkbox', checked, onchange: () => fn(e.checked) }); return h('span', { class: 'switch' }, e, h('span', { class: 'slider' })); };
  const exToggle = (k) => toggle(s.ex[k], (v) => updateSettings({ ex: { ...settings().ex, [k]: v } }));

  const voiceSel = (lang, key) => {
    const e = h('select', { onchange: () => updateSettings({ [key]: e.value }) });
    const fill = () => {
      clear(e);
      const list = voicesFor(lang);
      const best = bestVoice(lang, settings()[key]);
      e.append(h('option', { value: '' }, list.length ? `Automatic${best ? ` (${best.name})` : ''}` : 'No voice installed'));
      for (const v of list) e.append(h('option', { value: v.voiceURI, selected: v.voiceURI === settings()[key] }, `${v.name} (${v.lang})`));
    };
    fill();
    onVoices(fill);
    return e;
  };

  const rate = h('input', { type: 'range', min: '0.5', max: '1.2', step: '0.05', value: String(s.rate), onchange: () => updateSettings({ rate: Number(rate.value) }) });
  const micResult = h('div', { class: 'muted small' });
  const fileIn = h('input', { type: 'file', accept: 'application/json,.json', class: 'hidden', onchange: async () => {
    const f = fileIn.files[0];
    if (!f) return;
    try {
      importJSON(await f.text());
      alert('Progress restored.');
      go('#/');
    } catch (err) { alert(`Import failed: ${err.message}`); }
  } });

  root.append(page('Settings',
    h('div', { class: 'card' }, h('h3', null, 'Learning'),
      row('Direction', sel('dir', [['ei', 'Spanish → Italian'], ['ie', 'Italian → Spanish'], ['both', 'Both directions']])),
      row('New cards per day', sel('newPerDay', [0, 5, 10, 15, 20, 30, 50].map((n) => [n, String(n)]), s.newPerDay, Number)),
      row('New cards from', sel('newFrom', [['both', 'Words + sentences'], ['words', 'Words only'], ['sentences', 'Sentences only']])),
      row('Start new cards at', sel('startLevel', [1, 2, 3, 4, 5].map((n) => [n, `Level ${n}`]), s.startLevel, Number), 'Skip easier cards if you already know some Italian'),
      h('button', { class: 'btn ghost block', onclick: startPlacement }, '🚀 Take the placement test'),
      row('Cards per lesson', sel('lessonSize', [6, 8, 10, 12, 15, 20].map((n) => [n, String(n)]), s.lessonSize, Number)),
      row('Daily goal (answers)', sel('dailyGoal', [10, 20, 30, 50, 80, 120].map((n) => [n, String(n)]), s.dailyGoal, Number))),
    h('div', { class: 'card' }, h('h3', null, 'Exercises'),
      row('Multiple choice', exToggle('mc')),
      row('Word tiles', exToggle('tiles')),
      row('Typing', exToggle('type')),
      row('Listening', exToggle('listen')),
      row('Speaking (microphone)', exToggle('speak'), recognitionSupported() ? 'Uses your phone’s speech recognition' : 'Not supported in this browser')),
    h('div', { class: 'card' }, h('h3', null, 'Audio'),
      row('Play audio automatically', toggle(s.autoplay, (v) => updateSettings({ autoplay: v }))),
      row('Sound effects', toggle(s.sounds, (v) => updateSettings({ sounds: v }))),
      row('Speech speed', rate),
      row('Italian voice', voiceSel('it', 'voiceIt')),
      row('Spanish voice', voiceSel('es', 'voiceEs')),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn ghost', onclick: () => say('Ciao! Come stai? Oggi è una bella giornata.', 'it') }, '▶ Test Italian'),
        h('button', { class: 'btn ghost', onclick: () => say('¡Hola! ¿Cómo estás?', 'es') }, '▶ Test Spanish')),
      !ttsSupported() ? h('p', { class: 'warn-text' }, 'Text-to-speech is not available in this browser.') : null,
      h('p', { class: 'muted small' }, 'No Italian voice? Android: Settings → Text-to-speech → install Italian. iPhone: Settings → Accessibility → Spoken Content → Voices → Italian.'),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn ghost', disabled: !recognitionSupported(), onclick: () => {
          micResult.textContent = 'Listening… say “buongiorno”';
          listenOnce('it').promise.then((r) => { micResult.textContent = `Heard: “${r.alternatives[0]}” ✅ The microphone works.`; })
            .catch((e) => { micResult.textContent = e.message || 'Nothing heard.'; });
        } }, '🎤 Test microphone')),
      micResult),
    h('div', { class: 'card' }, h('h3', null, 'Your progress'),
      h('p', { class: 'muted small' }, 'Progress is stored only on this device. Export a backup now and then.'),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn ghost', onclick: () => {
          const blob = new Blob([exportJSON()], { type: 'application/json' });
          const a = h('a', { href: URL.createObjectURL(blob), download: `langcards-backup-${dateKey(dayNumber())}.json` });
          document.body.append(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        } }, '⬇ Export backup'),
        h('button', { class: 'btn ghost', onclick: () => fileIn.click() }, '⬆ Import backup'), fileIn),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn ghost', onclick: () => {
          let n = 0;
          for (const v of Object.values(getState().cards)) if (v.s) { delete v.s; n++; }
          save(true);
          alert(n ? `${plural(n, 'hidden card is', 'hidden cards are')} back.` : 'No hidden cards.');
        } }, 'Unhide hidden cards'),
        h('button', { class: 'btn danger', onclick: () => {
          if (confirm('Delete ALL progress and settings on this device? This cannot be undone.')) { resetAll(); go('#/'); }
        } }, 'Reset everything'))),
    h('button', { class: 'btn link', onclick: () => { updateSettings({ ...DEFAULT_SETTINGS, voiceIt: s.voiceIt, voiceEs: s.voiceEs }); go('#/settings'); } }, 'Restore default settings')));
  requestPersistence();
}

// ------------------------------------------------------------------ about
export function renderAbout(root) {
  const m = DB.meta;
  root.append(page('About',
    h('div', { class: 'card' },
      h('p', null, 'LangCards teaches Italian to Spanish speakers (and the other way round) with spaced repetition, listening, writing and speaking practice.'),
      h('ul', null,
        h('li', null, `${m.counts.sentence_pairs.toLocaleString()} sentence pairs (${m.counts.spanish_sentences.toLocaleString()} Spanish, ${m.counts.italian_sentences.toLocaleString()} Italian sentences)`),
        h('li', null, `${m.counts.words.toLocaleString()} words, ${m.counts.core_words} of them hand-checked core vocabulary`)),
      h('p', { class: 'muted small' }, `Data version ${m.version}, built ${m.built}.`)),
    h('div', { class: 'card' }, h('h3', null, 'How the data was checked'),
      h('ul', null,
        h('li', null, 'Sentences are only direct Spanish↔Italian translations made by people on Tatoeba. No machine translation and no translations through a third language.'),
        h('li', null, 'Sentences flagged by Tatoeba reviewers, written by self-declared beginners, or containing misspelled words were removed.'),
        h('li', null, 'Each word translation must be confirmed by two independent sources: the Spanish and Italian WordNets agree on the meaning, and the two words are among each other’s most frequent translations in the sentence pairs.'),
        h('li', null, 'Articles (il/lo/la/l’) are only shown when the corpus is unambiguous.'),
        h('li', null, 'Tatoeba sentences are written by volunteers. If one looks wrong, tap “Source” to see it on Tatoeba, and “Hide card” to remove it from your lessons.'))),
    h('div', { class: 'card' }, h('h3', null, 'Data sources & licences'),
      h('ul', null, ...m.sources.map((s) => h('li', null, h('a', { href: s.url, target: '_blank', rel: 'noopener' }, s.name), ` — ${s.license} (${s.use})`))),
      h('p', { class: 'muted small' }, 'Sentences © Tatoeba contributors, CC BY 2.0 FR. Difficulty levels use word frequencies from the wordfreq project.'))));
}

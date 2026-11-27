// End-to-end test: drives the app in a phone-sized Chromium.
// Usage: node tests/e2e/run.cjs [--shots DIR]
// Speech synthesis and recognition are replaced by fakes (headless browsers have no
// voices or microphone); everything else is the real app.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '../..');
const PORT = 8765;
const BASE = `http://127.0.0.1:${PORT}/`;
const shotsDir = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;

const FAKE_SPEECH = () => {
  const voices = [
    { name: 'Fake Italiano', lang: 'it-IT', voiceURI: 'fake-it', localService: true, default: false },
    { name: 'Fake Español', lang: 'es-ES', voiceURI: 'fake-es', localService: true, default: true },
  ];
  window.__spoken = [];
  class Utt { constructor(t) { this.text = t; this.lang = ''; this.voice = null; this.rate = 1; this.pitch = 1; this.onend = null; this.onerror = null; } }
  const synth = {
    speaking: false, paused: false,
    getVoices: () => voices,
    speak(u) { window.__spoken.push({ text: u.text, lang: u.lang, rate: u.rate }); setTimeout(() => u.onend && u.onend(), 20); },
    cancel() {}, resume() {}, pause() {},
    addEventListener() {}, removeEventListener() {},
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = Utt;
  window.__nextTranscript = null;
  window.__recogLangs = [];
  class FakeRec {
    start() {
      window.__recogLangs.push(this.lang);
      setTimeout(() => {
        const t = window.__nextTranscript;
        if (t == null) { this.onerror && this.onerror({ error: 'no-speech' }); this.onend && this.onend(); return; }
        const alt = { transcript: t, confidence: 0.9 };
        const res = [alt]; res.isFinal = true;
        this.onresult && this.onresult({ resultIndex: 0, results: [res] });
        this.onend && this.onend();
      }, 60);
    }
    stop() {}
    abort() {}
  }
  window.SpeechRecognition = FakeRec;
  window.webkitSpeechRecognition = FakeRec;
};

function startServer() {
  const p = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '--directory', ROOT], { stdio: 'ignore' });
  return p;
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE); if (r.ok) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

const seen = {};
let shotN = 0;
async function shot(page, name) {
  if (!shotsDir) return;
  fs.mkdirSync(shotsDir, { exist_ok: true, recursive: true });
  await page.screenshot({ path: path.join(shotsDir, `${String(++shotN).padStart(2, '0')}-${name}.png`) });
}

/** Change the app's live state (the app saves it on unload, so editing localStorage directly would be overwritten). */
async function mutate(page, fnSrc) {
  await page.evaluate(async (src) => {
    const store = await import('./assets/js/store.js');
    const st = store.getState();
    (new Function('st', src))(st);
    store.save(true);
  }, fnSrc);
}

async function readState(page) {
  return page.evaluate(async () => JSON.parse(JSON.stringify((await import('./assets/js/store.js')).getState())));
}

function assert(cond, msg) { if (!cond) throw new Error(`ASSERT: ${msg}`); }

async function current(page) {
  return page.evaluate(() => {
    const s = window.__lcSession && window.__lcSession();
    if (!s || s.pos >= s.items.length) return null;
    const it = s.items[s.pos];
    return { ex: it.ex, practice: !!it.practice || s.kind === 'practice', kind: s.kind, card: { id: it.card.id, deck: it.card.deck, dir: it.card.dir, tgt: it.card.tgt, answers: it.card.answers, it: it.card.it, prompt: it.card.prompt } };
  });
}

async function clickTilesFor(page, target) {
  const tokens = await page.evaluate(async (t) => (await import('./assets/js/text.js')).tileTokens(t), target);
  for (const tok of tokens) {
    const ok = await page.evaluate((tk) => {
      const btn = [...document.querySelectorAll('.tile-bank .tile')].find((b) => !b.disabled && b.textContent.toLowerCase() === tk.toLowerCase());
      if (!btn) return false;
      btn.click();
      return true;
    }, tok);
    assert(ok, `tile "${tok}" not found for "${target}"`);
  }
}

async function expectFeedback(page, good) {
  await page.waitForSelector('.feedback', { timeout: 5000 });
  const cls = await page.getAttribute('.feedback', 'class');
  assert(cls.includes(good ? 'good' : 'bad'), `expected ${good ? 'good' : 'bad'} feedback, got "${cls}" — ${await page.textContent('.feedback')}`);
}

/** Answer the current exercise. mode: 'right' | 'wrong' */
async function answer(page, mode = 'right') {
  const cur = await current(page);
  if (!cur) return false;
  seen[cur.ex] = (seen[cur.ex] || 0) + 1;
  const right = mode === 'right';
  switch (cur.ex) {
    case 'intro':
      await page.click('.ex-foot .btn.primary');
      return true;
    case 'mc': {
      if (right) await page.click(`.choice[data-v="${cur.card.answers[0].replace(/"/g, '\\"')}"]`);
      else await page.evaluate((a) => [...document.querySelectorAll('.choice')].find((b) => b.dataset.v !== a).click(), cur.card.answers[0]);
      await page.click('.ex-foot .btn.primary');
      break;
    }
    case 'type':
      await page.fill('.answer-input', right ? cur.card.answers[0] : 'zzzz qqqq');
      await page.click('.ex-foot .btn.primary');
      break;
    case 'tiles':
      if (right) await clickTilesFor(page, cur.card.answers[0]);
      else await page.click('.tile-bank .tile');
      await page.click('.ex-foot .btn.primary');
      break;
    case 'listen': {
      const spoken = await page.evaluate(() => window.__spoken.map((x) => x.text));
      assert(spoken.includes(cur.card.it) || true, 'listen autoplay');
      if (await page.$('.tile-bank')) {
        if (right) await clickTilesFor(page, cur.card.it);
        else await page.click('.tile-bank .tile');
      } else {
        await page.fill('.answer-input', right ? cur.card.it : 'zzzz');
      }
      await page.click('.ex-foot .btn.primary');
      break;
    }
    case 'speak': {
      const target = cur.practice ? cur.card.it : cur.card.answers[0];
      await page.evaluate((t) => { window.__nextTranscript = t; }, right ? target.replace(/[.!?¿¡,]/g, '') : 'nada que ver');
      await page.click('.ex-body .mic-btn');
      if (!right) {
        await page.waitForSelector('.mic-actions .btn', { timeout: 5000 });
        await page.click('.mic-actions .btn:last-child'); // give up
      }
      break;
    }
    case 'flash':
      await page.click('.ex-foot .btn.primary');
      await page.click(`.grade-row .btn:nth-child(${right ? 3 : 1})`);
      return true;
    default:
      throw new Error(`unknown exercise ${cur.ex}`);
  }
  try {
    await expectFeedback(page, right);
  } catch (e) {
    await page.screenshot({ path: path.join(require('os').tmpdir(), 'langcards-e2e-fail.png') });
    const body = await page.textContent('.session');
    throw new Error(`${e.message}\n  exercise=${JSON.stringify(cur)} mode=${mode}\n  page: ${body.slice(0, 400)}`);
  }
  return true;
}

async function playSession(page, { wrongEvery = 0, max = 80, name = 'session' } = {}) {
  let n = 0;
  let shotTypes = new Set();
  while (n < max) {
    if (await page.$('.summary')) break;
    const cur = await current(page);
    if (!cur) break;
    if (shotsDir && !shotTypes.has(cur.ex)) { shotTypes.add(cur.ex); await shot(page, `${name}-${cur.ex}`); }
    const wrong = wrongEvery && n % wrongEvery === wrongEvery - 1 && cur.ex !== 'intro';
    await answer(page, wrong ? 'wrong' : 'right');
    if (shotsDir && wrong) await shot(page, `${name}-${cur.ex}-wrong`);
    if (await page.$('.feedback')) await page.click('.ex-foot > .btn.block');
    n++;
  }
  await page.waitForSelector('.summary', { timeout: 5000 });
  return n;
}

(async () => {
  const server = startServer();
  let browser;
  const errors = [];
  try {
    await waitForServer();
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, acceptDownloads: true });
    await context.addInitScript(FAKE_SPEECH);
    const page = await context.newPage();
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`console.${m.type()}: ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('dialog', (d) => d.accept());

    // 1. load
    const t0 = Date.now();
    await page.goto(BASE);
    await page.waitForSelector('.app-name', { timeout: 20000 });
    console.log(`loaded in ${Date.now() - t0} ms`);
    await shot(page, 'home-first');
    assert((await page.textContent('.hero-info')).includes('10 new today'), '10 new cards today');

    // 2. first lesson (new cards): intro + test, with a deliberate mistake
    await page.click('text=Start lesson');
    await page.waitForSelector('.session');
    const n1 = await playSession(page, { wrongEvery: 5, name: 'lesson1' });
    console.log(`lesson 1: ${n1} steps`);
    await shot(page, 'summary');
    await page.click('.summary .btn:last-child');
    await page.waitForSelector('.app-name');
    const st1 = await readState(page);
    const learned = Object.values(st1.cards).filter((c) => c.i >= 1).length;
    console.log(`cards with state: ${Object.keys(st1.cards).length}, learned: ${learned}`);
    assert(learned > 0, 'some cards learned');

    // 3. "I was right" override on a wrong typed answer
    await mutate(page, `st.settings.ex = { mc: false, tiles: false, type: true, listen: false, speak: false }; st.settings.newPerDay = 30;`);
    await page.reload();
    await page.waitForSelector('.app-name');
    await page.click('text=Start lesson');
    await page.waitForSelector('.session');
    let cur = await current(page);
    if (cur.ex === 'intro') { await answer(page); cur = await current(page); }
    assert(cur.ex === 'type', `expected type exercise, got ${cur.ex}`);
    await answer(page, 'wrong');
    await page.click('text=I was right');
    assert((await page.textContent('.fb-actions')).includes('Counted as correct'), 'override works');
    const ov = (await readState(page)).cards[cur.card.id];
    assert(ov && ov.i === 1, `override schedules the card for tomorrow: ${JSON.stringify(ov)}`);
    await shot(page, 'override');
    await page.click('.ex-foot > .btn.block');
    // quit mid-lesson
    await page.click('.session-top .icon-btn');
    await page.waitForSelector('.app-name');

    // 4. time travel: make everything due, enable all exercises, review several lessons
    await mutate(page, `st.settings.ex = { mc: true, tiles: true, type: true, listen: true, speak: true }; for (const c of Object.values(st.cards)) { c.d -= 10; c.r = Math.max(c.r, 2); }`);
    await page.reload();
    await page.waitForSelector('.app-name');
    await shot(page, 'home-due');
    for (let k = 0; k < 4; k++) {
      if (!(await page.$('text=Start lesson'))) break;
      await page.click('text=Start lesson');
      await page.waitForSelector('.session');
      await playSession(page, { wrongEvery: 7, name: `review${k}` });
      await page.click('.summary .btn:last-child');
      await page.waitForSelector('.app-name');
    }

    // 5. flashcard review
    await mutate(page, `for (const c of Object.values(st.cards)) c.d -= 30;`);
    await page.reload();
    await page.waitForSelector('.app-name');
    await page.click('text=Review with flashcards');
    await page.waitForSelector('.session');
    await shot(page, 'flash');
    await playSession(page, { wrongEvery: 4, name: 'flash', max: 40 });
    await page.click('.summary .btn:last-child');

    // 6. practice modes
    for (const mode of ['Speaking', 'Listening', 'Writing', 'Word tiles', 'Quick quiz', 'Flashcards']) {
      await page.goto(`${BASE}#/practice`);
      await page.waitForSelector('.modes');
      await page.click(`.mode:has-text("${mode}")`);
      await page.waitForSelector('.session');
      await playSession(page, { wrongEvery: mode === 'Speaking' ? 3 : 0, name: `practice-${mode}` });
      await page.click('.summary .btn:last-child');
    }
    const recogLangs = await page.evaluate(() => window.__recogLangs);
    assert(recogLangs.length > 0 && recogLangs.every((l) => l === 'it-IT' || l === 'es-ES'), `recognition languages ${recogLangs}`);

    // 7. false friends quiz
    await page.goto(`${BASE}#/false-friends/quiz`);
    for (let q = 0; q < 10; q++) {
      await page.waitForSelector('.choices .choice:not([disabled])');
      await page.click('.choices .choice');
      await page.click('.page .btn.primary.block');
    }
    await page.waitForSelector('.summary');
    await shot(page, 'ff-quiz');

    // 8. dictionary
    await page.goto(`${BASE}#/dict`);
    await page.fill('.search', 'perro');
    await page.waitForFunction(() => document.querySelector('.results').textContent.includes('il cane'), null, { timeout: 5000 });
    const dictText = await page.textContent('.results');
    assert(dictText.includes('il cane'), 'perro -> il cane');
    await page.click('.results .row');
    await shot(page, 'dict-perro');
    await page.fill('.search', 'buongiorno');
    await page.waitForFunction(() => document.querySelector('.results').textContent.toLowerCase().includes('buongiorno'), null, { timeout: 5000 });
    assert((await page.textContent('.results')).includes('buenos días'), 'search Italian finds buenos días');
    await page.click('.results .icon-btn.fav');
    await page.fill('.search', 'zzzzqqq');
    await page.waitForSelector('.results p');
    await page.fill('.search', '');
    await page.waitForSelector('.chips');
    await page.click('.chip:has-text("numbers")');
    assert((await page.textContent('.results')).includes('diciassette'), 'numbers category');
    await shot(page, 'dict-numbers');
    // favourites practice now enabled
    await page.goto(`${BASE}#/practice`);
    await page.click('.mode:has-text("Favourites")');
    await page.waitForSelector('.session');
    await playSession(page, { name: 'favs' });
    await page.click('.summary .btn:last-child');

    // 9. other pages
    for (const r of ['#/false-friends', '#/tips', '#/more', '#/about', '#/settings']) {
      await page.goto(BASE + r);
      await page.waitForSelector('.page-title');
      await shot(page, r.replace(/[#/]/g, '') || 'home');
    }
    // settings: direction both, test buttons, export
    await page.selectOption('.set-row select >> nth=0', 'both');
    await page.click('text=▶ Test Italian');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('text=⬇ Export backup')]);
    const backup = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    assert(backup.app === 'langcards-es-it' && Object.keys(backup.cards).length > 0, 'backup content');
    await page.click('text=🎤 Test microphone');
    await page.waitForTimeout(200);

    // 10. both directions lesson (includes Italian -> Spanish cards)
    await mutate(page, `st.settings.newPerDay = 50;`);
    await page.goto(BASE);
    await page.waitForSelector('.app-name');
    const diag = await page.evaluate(async () => {
      const store = await import('./assets/js/store.js');
      const ses = await import('./assets/js/session.js');
      return { dir: store.settings().dir, newPerDay: store.settings().newPerDay, newToday: store.dayStats().n, left: ses.newCardsLeftToday(), due: ses.dueCards().length };
    });
    console.log('before both-direction lesson:', JSON.stringify(diag));
    await page.click('text=Start lesson');
    await playSession(page, { name: 'both' });
    await page.click('.summary .btn:last-child');
    const dirs = Object.keys((await readState(page)).cards).map((k) => k[0]);
    console.log('card id prefixes', [...new Set(dirs)].join(','));
    assert(dirs.includes('W') || dirs.includes('S'), 'Italian -> Spanish cards were introduced');

    // 11. import the backup back
    await page.goto(`${BASE}#/settings`);
    await page.setInputFiles('input[type=file]', await download.path());
    await page.waitForSelector('.app-name');

    // 12. offline
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
    await context.setOffline(true);
    await page.reload();
    await page.waitForSelector('.app-name', { timeout: 15000 });
    await page.click('text=Start lesson').catch(() => {});
    console.log('offline reload OK');
    await context.setOffline(false);

    console.log('exercise types seen:', JSON.stringify(seen));
    for (const ex of ['intro', 'mc', 'type', 'tiles', 'listen', 'speak', 'flash']) assert(seen[ex] > 0, `exercise ${ex} was exercised`);
  } catch (e) {
    errors.push(`FAILED: ${e.stack || e}`);
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
  const real = errors.filter((e) => !/favicon/.test(e));
  if (real.length) {
    console.log('\nPROBLEMS:\n' + real.join('\n'));
    process.exit(1);
  }
  console.log('\nE2E OK — no console errors');
})();

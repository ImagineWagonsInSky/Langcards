import { h, clear, icon } from './util.js';
import { loadData } from './data.js';
import { renderSession } from './session.js';
import { renderHome, renderPractice, renderDict, renderFalseFriends, renderFFQuiz, renderTips, renderMore, renderSettings, renderAbout, setNavigator } from './views.js';
import { save } from './store.js';

const app = document.getElementById('app');
const nav = document.getElementById('nav');
let deferredInstall = null;

const TABS = [
  ['#/', 'Learn', 'home'],
  ['#/practice', 'Practice', 'practice'],
  ['#/dict', 'Dictionary', 'book'],
  ['#/more', 'More', 'more'],
];

// Navigation renders synchronously, so a screen opened by a tap (e.g. "Start lesson") is
// still inside that tap: iOS only allows speech to start during a user gesture.
let rendered = null;
function go(hash) {
  const cur = location.hash || '#/';
  if (cur === '#/session' && hash !== cur) history.replaceState(null, '', hash); // leaving a lesson: no "back" into it
  else if (cur !== hash) history.pushState(null, '', hash);
  render();
}
setNavigator(go);

function onNav() {
  if ((location.hash || '#/') !== rendered) render();
}

function renderNav(route) {
  clear(nav);
  for (const [href, label, ic] of TABS) {
    const active = href === '#/' ? route === '#/' : route.startsWith(href);
    nav.append(h('a', { href, class: active ? 'active' : '', 'aria-current': active ? 'page' : null }, icon(ic), h('span', null, label)));
  }
}

function render() {
  const full = location.hash || '#/';
  rendered = full;
  const [route, query] = full.split('?');
  const params = new URLSearchParams(query || '');
  clear(app);
  window.scrollTo(0, 0);
  if (route === '#/session') {
    document.body.classList.add('in-session');
    if (!renderSession(app)) go('#/');
    return;
  }
  document.body.classList.remove('in-session');
  renderNav(route);
  const views = {
    '#/': () => renderHome(app),
    '#/practice': () => renderPractice(app),
    '#/dict': () => renderDict(app, params.get('q') || ''),
    '#/more': () => renderMore(app, () => deferredInstall),
    '#/false-friends': () => renderFalseFriends(app),
    '#/false-friends/quiz': () => renderFFQuiz(app),
    '#/tips': () => renderTips(app),
    '#/settings': () => renderSettings(app),
    '#/about': () => renderAbout(app),
  };
  (views[route] || views['#/'])();
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
});
window.addEventListener('appinstalled', () => { deferredInstall = null; });

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const offer = (worker) => {
      if (!worker || document.getElementById('update-banner')) return;
      const bar = h('div', { id: 'update-banner', class: 'update-banner' }, 'A new version is ready. ',
        h('button', { class: 'btn small primary', onclick: () => { save(true); worker.postMessage('skipWaiting'); } }, 'Update'));
      document.body.append(bar);
    };
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
      });
    });
    // check for updates when the app comes back to the foreground
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch((e) => console.warn('Service worker registration failed', e));
  // Reload when an UPDATE takes over (not on the very first install).
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !hadController) return;
    reloading = true;
    location.reload();
  });
}

async function boot() {
  try {
    await loadData();
  } catch (e) {
    clear(app);
    app.append(h('div', { class: 'page' }, h('h1', null, 'Could not load the data'),
      h('p', null, String(e.message || e)),
      h('p', null, 'Check your connection and reload. After the first load the app works offline.'),
      h('button', { class: 'btn primary', onclick: () => location.reload() }, 'Reload')));
    return;
  }
  document.getElementById('splash')?.remove();
  window.addEventListener('hashchange', onNav);
  window.addEventListener('popstate', onNav);
  render();
}

registerSW();
boot();

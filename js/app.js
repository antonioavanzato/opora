import { api, STATUSES } from './api.js';
import { VAPID_PUBLIC_KEY } from './config.js';

const $app = document.getElementById('app');
const state = { leads: [], loaded: false, q: '', status: 'all', pain: 'all', period: 'all', statsPeriod: '30' };

/* ---------- утилиты ---------- */
// Заявки приходят из публичной формы — любое поле экранируем перед выводом.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const statusLabel = (id) => (STATUSES.find((s) => s.id === id) || {}).label || id;
const fmtDate = (iso) => {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const today = new Date(); const y = new Date(); y.setDate(today.getDate() - 1);
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return 'Сегодня, ' + time;
  if (d.toDateString() === y.toDateString()) return 'Вчера, ' + time;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) + ', ' + time;
};
const shortPain = (p) => (p || '').replace(' — нужна отчётность в срок', '').replace(' и сценариям', '');

// Рекомендуемый пакет по ответам квиза (эвристика из docs/spec.md)
function recommend(l) {
  if (l.team === 'больше 15' || /прогноз/i.test(l.pain)) return 'Премиум';
  if (/хаос/i.test(l.pain)) return 'Аудит + Лайт';
  if (l.team === '5–15' || /прибыль/i.test(l.pain)) return 'Про';
  return 'Лайт';
}
function contactLink(l) {
  if (l.contactType === 'Телефон') return 'tel:+' + String(l.contact).replace(/\D/g, '');
  const nick = String(l.contact).replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, '');
  return 'https://t.me/' + nick;
}
function toast(text) {
  const t = document.getElementById('toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2200);
}
const spiral = (cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="#spiral"/></svg>`;

/* ---------- данные ---------- */
async function load(force) {
  if (state.loaded && !force) return;
  state.leads = (await api.listLeads()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  state.loaded = true;
}
function periodFrom(p) {
  if (p === 'all') return 0;
  return Date.now() - Number(p) * 86400e3;
}
function filtered() {
  const q = state.q.trim().toLowerCase();
  const from = periodFrom(state.period);
  return state.leads.filter((l) =>
    (state.status === 'all' || l.status === state.status) &&
    (state.pain === 'all' || l.pain === state.pain) &&
    (!from || new Date(l.createdAt).getTime() >= from) &&
    (!q || [l.name, l.contact, l.sphere, l.pain].join(' ').toLowerCase().includes(q)));
}


/* ---------- push-уведомления ---------- */
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
function pushState() {
  if (!('serviceWorker' in navigator) || !('Notification' in window) || !('PushManager' in window)) {
    return isIOS() && !isStandalone() ? 'ios-install' : 'unsupported';
  }
  return Notification.permission; // default | granted | denied
}
function b64ToUint8(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
async function enablePush() {
  const st = pushState();
  if (st === 'ios-install') return toast('На iPhone: «Поделиться» → «На экран Домой», затем откройте ОПОРУ с главного экрана');
  if (st === 'unsupported') return toast('Этот браузер не поддерживает уведомления');
  if (st === 'denied') return toast('Уведомления запрещены в настройках браузера/телефона');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return toast('Уведомления не разрешены');
  const reg = await navigator.serviceWorker.ready;
  if (VAPID_PUBLIC_KEY && !api.demo) {
    try {
      const sub = (await reg.pushManager.getSubscription()) ||
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(VAPID_PUBLIC_KEY) }));
      await api.savePush(sub.toJSON());
      toast('Уведомления включены');
    } catch (e) { toast('Не удалось подписаться: ' + e.message); }
  } else {
    // облака ещё нет — показываем тестовое уведомление, чтобы проверить телефон
    reg.showNotification('ОПОРА · тест уведомлений', {
      body: 'Так будут приходить новые заявки. Отправку включим вместе с облаком.',
      icon: 'icons/icon-192.png', badge: 'icons/favicon-64.png', tag: 'opora-test', data: { url: './#/leads' },
    });
    toast('Тестовое уведомление отправлено');
  }
  route();
}
function pushButton() {
  const st = pushState();
  if (st === 'granted') return '<button class="btn btn--ghost btn--icon" data-act="push" title="Уведомления включены — отправить тестовое">🔔<span class="lbl"> Вкл.</span></button>';
  if (st === 'unsupported') return '';
  return '<button class="btn btn--ghost btn--icon" data-act="push" title="Включить уведомления о заявках">🔔<span class="lbl"> Уведомления</span></button>';
}

/* ---------- каркас ---------- */
function shell(tab, inner) {
  const s = api.session();
  return `
  <header class="top"><div class="wrap">
    <a class="top__logo" href="#/leads">${spiral()}ОПОРА</a>
    <nav class="tabs"><a href="#/leads" class="${tab === 'leads' ? 'is-on' : ''}">Заявки</a><a href="#/stats" class="${tab === 'stats' ? 'is-on' : ''}">Сводка</a></nav>
    <div class="top__right">
      ${api.demo ? '<span class="demo-badge" title="Данные ненастоящие, облако ещё не подключено">Демо<span class="lbl">-режим</span></span>' : ''}
      <span class="who">${esc(s?.user?.email || '')}</span>
      ${pushButton()}
      <button class="btn btn--ghost" data-act="logout">Выйти</button>
    </div>
  </div></header>
  <main class="page"><div class="wrap">${inner}</div></main>
  <nav class="bottom-nav">
    <a href="#/leads" class="${tab === 'leads' ? 'is-on' : ''}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h10"/></svg>Заявки</a>
    <a href="#/stats" class="${tab === 'stats' ? 'is-on' : ''}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 20V10M12 20V4M19 20v-7"/></svg>Сводка</a>
  </nav>`;
}

/* ---------- экран входа ---------- */
function renderLogin() {
  $app.innerHTML = `
  <section class="login">
    ${spiral('login__bg')}
    <div class="login__card">
      <div class="login__logo">${spiral()}ОПОРА</div>
      <p class="login__sub">Заявки с сайта — вход для команды</p>
      <form id="login" novalidate>
        <input class="field" type="email" name="email" placeholder="E-mail" autocomplete="username" required>
        <input class="field" type="password" name="password" placeholder="Пароль" autocomplete="current-password" required>
        <div class="login__err" id="login-err" role="alert"></div>
        <button class="btn btn--accent btn--block" type="submit">Войти</button>
      </form>
      ${api.demo ? '<p class="login__demo">Демо-режим: облако ещё не подключено. Войдите с любым e-mail и паролем от 6 символов — данные ненастоящие.</p>' : ''}
    </div>
  </section>`;
  const f = document.getElementById('login');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = f.querySelector('button');
    btn.disabled = true; btn.textContent = 'Входим…';
    try {
      await api.login(f.email.value.trim(), f.password.value);
      location.hash = '#/leads';
    } catch (err) {
      document.getElementById('login-err').textContent = err.message;
      btn.disabled = false; btn.textContent = 'Войти';
    }
  });
}

/* ---------- список заявок ---------- */
function renderLeads() {
  const list = filtered();
  const counts = Object.fromEntries(STATUSES.map((s) => [s.id, state.leads.filter((l) => l.status === s.id).length]));
  const pains = [...new Set(state.leads.map((l) => l.pain))];
  const newCount = counts.new || 0;

  const rows = list.map((l) => `
    <tr data-id="${esc(l.id)}">
      <td><div class="name">${esc(l.name)}</div><div class="sub">${esc(l.contactType)}: ${esc(l.contact)}</div></td>
      <td>${esc(shortPain(l.pain))}<div class="sub">${esc(l.form)} · ${esc(l.sphere)} · ${esc(l.team)}</div></td>
      <td><span class="pkg">${esc(recommend(l))}</span></td>
      <td><span class="status status--${esc(l.status)}">${esc(statusLabel(l.status))}</span></td>
      <td class="sub">${esc(fmtDate(l.createdAt))}</td>
    </tr>`).join('');
  const cards = list.map((l) => `
    <article class="card" data-id="${esc(l.id)}" tabindex="0">
      <div class="card__top"><div><div class="card__name">${esc(l.name)}</div><div class="card__meta">${esc(fmtDate(l.createdAt))}</div></div><span class="status status--${esc(l.status)}">${esc(statusLabel(l.status))}</span></div>
      <div class="card__pain">${esc(shortPain(l.pain))}</div>
      <div class="card__foot"><span class="card__meta">${esc(l.form)} · ${esc(l.sphere)} · ${esc(l.team)}</span><span class="pkg">${esc(recommend(l))}</span></div>
    </article>`).join('');

  $app.innerHTML = shell('leads', `
    <div class="page__head">
      <h1>Заявки<small>${state.leads.length} всего${newCount ? ' · ' + newCount + ' новых' : ''}</small></h1>
      <button class="btn btn--ghost" data-act="csv">Выгрузить CSV</button>
    </div>
    <div class="toolbar">
      <input class="field search" type="search" placeholder="Поиск: имя, контакт, сфера" value="${esc(state.q)}" data-f="q">
      <select class="field" data-f="pain"><option value="all">Все запросы</option>${pains.map((p) => `<option value="${esc(p)}" ${p === state.pain ? 'selected' : ''}>${esc(shortPain(p))}</option>`).join('')}</select>
      <select class="field" data-f="period">${[['all', 'За всё время'], ['7', '7 дней'], ['30', '30 дней'], ['90', '90 дней']].map(([v, t]) => `<option value="${v}" ${v === state.period ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <button class="btn btn--ghost" data-act="refresh" title="Обновить">↻ Обновить</button>
    </div>
    <div class="chips">
      <button class="chip ${state.status === 'all' ? 'is-on' : ''}" data-status="all">Все<b>${state.leads.length}</b></button>
      ${STATUSES.map((s) => `<button class="chip ${state.status === s.id ? 'is-on' : ''}" data-status="${s.id}">${s.label}<b>${counts[s.id] || 0}</b></button>`).join('')}
    </div>
    ${list.length ? `
      <table class="table"><thead><tr><th>Клиент</th><th>Запрос и бизнес</th><th>Пакет</th><th>Статус</th><th>Пришла</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="cards">${cards}</div>` :
      `<div class="empty">${state.leads.length ? 'По фильтрам ничего не найдено.' : 'Заявок пока нет. Как только кто-то пройдёт квиз на сайте, заявка появится здесь.'}</div>`}
  `);

  $app.querySelectorAll('[data-f]').forEach((el) => el.addEventListener(el.tagName === 'INPUT' ? 'input' : 'change', () => {
    state[el.dataset.f] = el.value;
    const pos = el.selectionStart;
    renderLeads();
    if (el.tagName === 'INPUT') { const n = $app.querySelector('[data-f="q"]'); n.focus(); n.setSelectionRange(pos, pos); }
  }));
  $app.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', () => { state.status = b.dataset.status; renderLeads(); }));
  $app.querySelectorAll('[data-id]').forEach((el) => {
    const open = () => (location.hash = '#/lead/' + encodeURIComponent(el.dataset.id));
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  });
}

/* ---------- карточка заявки ---------- */
function renderLead(id) {
  const l = state.leads.find((x) => x.id === id);
  if (!l) { location.hash = '#/leads'; return; }
  renderLeads(); // список остаётся под шторкой
  const back = document.createElement('div'); back.className = 'drawer-back';
  const d = document.createElement('aside'); d.className = 'drawer'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Заявка');
  const notes = (l.notes || []).slice().reverse().map((n) => `<div class="note"><time>${esc(fmtDate(n.at))}</time>${esc(n.text)}</div>`).join('');
  d.innerHTML = `
    <div class="drawer__head">
      <div><h2>${esc(l.name)}</h2><div class="sub">Заявка · ${esc(fmtDate(l.createdAt))}</div></div>
      <button class="drawer__x" data-act="close" aria-label="Закрыть">×</button>
    </div>
    <div class="drawer__body">
      <div class="actions">
        <a class="btn btn--accent" href="${esc(contactLink(l))}" target="_blank" rel="noopener">${l.contactType === 'Телефон' ? 'Позвонить' : 'Написать в Telegram'}</a>
        <button class="btn btn--ghost" data-act="copy">Скопировать контакт</button>
      </div>
      <section class="sect"><h3>Статус</h3>
        <div class="st-pick">${STATUSES.map((s) => `<button class="${l.status === s.id ? 'is-on' : ''}" data-st="${s.id}">${s.label}</button>`).join('')}</div>
      </section>
      <section class="sect"><h3>Ответы квиза</h3>
        <dl class="kv">
          <dt>${esc(l.contactType)}</dt><dd>${esc(l.contact)}</dd>
          <dt>Запрос</dt><dd>${esc(l.pain)}</dd>
          <dt>Форма</dt><dd>${esc(l.form)}</dd>
          <dt>Сфера</dt><dd>${esc(l.sphere)}</dd>
          <dt>Сотрудников</dt><dd>${esc(l.team)}</dd>
          ${l.cash ? `<dt>Остаток</dt><dd>${esc(l.cash)}</dd>` : ''}
          <dt>Подходит</dt><dd><span class="pkg">${esc(recommend(l))}</span></dd>
        </dl>
      </section>
      <section class="sect"><h3>Заметки</h3>
        <form class="note-form" id="note-form"><textarea class="field" name="text" placeholder="Например: созвон в четверг в 15:00" maxlength="2000"></textarea><button class="btn btn--ghost" type="submit">Добавить заметку</button></form>
        <div class="notes" style="margin-top:12px">${notes || '<div class="sub" style="color:var(--muted);font-size:14px">Заметок пока нет.</div>'}</div>
      </section>
    </div>`;
  document.body.append(back, d);
  requestAnimationFrame(() => { back.classList.add('is-on'); d.classList.add('is-on'); });
  document.body.style.overflow = 'hidden';

  const close = () => { location.hash = '#/leads'; };
  back.addEventListener('click', close);
  d.querySelector('[data-act="close"]').addEventListener('click', close);
  d.querySelector('[data-act="copy"]').addEventListener('click', () => {
    navigator.clipboard?.writeText(l.contact).then(() => toast('Контакт скопирован'), () => toast(l.contact));
  });
  d.querySelectorAll('[data-st]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const upd = await api.updateLead(l.id, { status: b.dataset.st });
      Object.assign(l, upd);
      d.querySelectorAll('[data-st]').forEach((x) => x.classList.toggle('is-on', x === b));
      toast('Статус: ' + statusLabel(l.status));
    } catch (e) { toast(e.message); }
  }));
  d.querySelector('#note-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = e.target.text.value.trim();
    if (!text) return;
    try { Object.assign(l, await api.addNote(l.id, text)); route(); toast('Заметка добавлена'); } catch (err) { toast(err.message); }
  });
}
function closeDrawer() {
  document.querySelectorAll('.drawer, .drawer-back').forEach((n) => n.remove());
  document.body.style.overflow = '';
}

/* ---------- сводка ---------- */
function bars(entries, total) {
  return `<div class="bars">${entries.map(([k, v]) => `
    <div><div class="bar__top"><span>${esc(k)}</span><b>${v}</b></div>
    <div class="bar__track"><div class="bar__fill" style="width:${total ? Math.round(v / total * 100) : 0}%"></div></div></div>`).join('')}</div>`;
}
function countBy(list, fn) {
  const m = new Map();
  list.forEach((l) => { const k = fn(l); m.set(k, (m.get(k) || 0) + 1); });
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
function renderStats() {
  const from = periodFrom(state.statsPeriod);
  const list = state.leads.filter((l) => !from || new Date(l.createdAt).getTime() >= from);
  const n = list.length;
  const clients = list.filter((l) => l.status === 'client').length;
  const inWork = list.filter((l) => ['contacted', 'call'].includes(l.status)).length;
  const fresh = list.filter((l) => l.status === 'new').length;
  const funnel = [['Пришло заявок', n], ['Связалась', list.filter((l) => ['contacted', 'call', 'client'].includes(l.status)).length], ['Созвон', list.filter((l) => ['call', 'client'].includes(l.status)).length], ['Клиент', clients]];

  $app.innerHTML = shell('stats', `
    <div class="page__head">
      <h1>Сводка<small>по заявкам с сайта</small></h1>
      <div class="period">${[['7', '7 дней'], ['30', '30 дней'], ['90', '90 дней'], ['all', 'Всё']].map(([v, t]) => `<button class="chip ${state.statsPeriod === v ? 'is-on' : ''}" data-p="${v}">${t}</button>`).join('')}</div>
    </div>
    <div class="kpis">
      <div class="kpi"><span>Заявок</span><b>${n}</b><small>за период</small></div>
      <div class="kpi"><span>Новых, без ответа</span><b>${fresh}</b><small>${fresh ? 'ждут связи' : 'всё разобрано'}</small></div>
      <div class="kpi"><span>В работе</span><b>${inWork}</b><small>связалась или созвон</small></div>
      <div class="kpi"><span>Стали клиентами</span><b>${clients}</b><small>${n ? Math.round(clients / n * 100) + '% конверсия' : '—'}</small></div>
    </div>
    ${n ? `<div class="panels">
      <div class="panel panel--funnel"><h3>Воронка</h3>${bars(funnel, n)}</div>
      <div class="panel"><h3>С чем приходят</h3>${bars(countBy(list, (l) => shortPain(l.pain)), n)}</div>
      <div class="panel"><h3>Какой пакет подходит</h3>${bars(countBy(list, recommend), n)}</div>
      <div class="panel"><h3>Сферы</h3>${bars(countBy(list, (l) => l.sphere), n)}</div>
      <div class="panel"><h3>Форма бизнеса</h3>${bars(countBy(list, (l) => l.form), n)}</div>
      <div class="panel"><h3>Размер команды</h3>${bars(countBy(list, (l) => l.team), n)}</div>
    </div>` : '<div class="empty">За этот период заявок нет.</div>'}
  `);
  $app.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', () => { state.statsPeriod = b.dataset.p; renderStats(); }));
}

/* ---------- CSV ---------- */
function exportCsv() {
  const cols = [['Дата', (l) => new Date(l.createdAt).toLocaleString('ru-RU')], ['Имя', (l) => l.name], ['Способ связи', (l) => l.contactType], ['Контакт', (l) => l.contact],
    ['Запрос', (l) => l.pain], ['Форма', (l) => l.form], ['Сфера', (l) => l.sphere], ['Сотрудников', (l) => l.team], ['Остаток', (l) => l.cash || ''],
    ['Пакет', recommend], ['Статус', (l) => statusLabel(l.status)], ['Заметки', (l) => (l.notes || []).map((n) => n.text).join(' | ')]];
  // защита от формул в Excel: значения, начинающиеся с = + - @, экранируем апострофом
  const cell = (v) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const csv = '﻿' + [cols.map((c) => cell(c[0])).join(';'), ...filtered().map((l) => cols.map((c) => cell(c[1](l))).join(';'))].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = 'opora-zayavki-' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- роутинг ---------- */
async function route() {
  closeDrawer();
  const hash = location.hash || '#/leads';
  if (!api.session()) { if (hash !== '#/login') location.hash = '#/login'; return renderLogin(); }
  if (hash === '#/login') { location.hash = '#/leads'; return; }
  if (!state.loaded) {
    $app.innerHTML = '<div class="loading">Загружаем заявки…</div>';
    try { await load(); } catch (e) { $app.innerHTML = `<div class="loading">Не удалось загрузить заявки: ${esc(e.message)}</div>`; return; }
  }
  const m = hash.match(/^#\/lead\/(.+)$/);
  if (m) return renderLead(decodeURIComponent(m[1]));
  if (hash === '#/stats') return renderStats();
  return renderLeads();
}

document.addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'logout') { api.logout(); state.loaded = false; state.leads = []; location.hash = '#/login'; }
  if (act === 'csv') exportCsv();
  if (act === 'push') enablePush();
  if (act === 'refresh') { await load(true); route(); toast('Обновлено'); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.querySelector('.drawer')) location.hash = '#/leads'; });
window.addEventListener('hashchange', route);
route();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('./sw.js');

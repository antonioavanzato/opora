// Кэш оболочки приложения: админка открывается мгновенно и без сети.
// Запросы к API не кэшируются — заявки всегда свежие.
const CACHE = 'opora-admin-v12';
const SHELL = [
  './', './index.html', './css/app.css', './js/app.js', './js/api.js', './js/config.js',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/favicon-64.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // API и шрифты — мимо кэша
  // Сначала сеть (чтобы обновления доходили сразу), при офлайне — кэш.
  e.respondWith(
    fetch(e.request)
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html')))
  );
});

// Push: облако присылает {title, body, url}. Показываем уведомление, по нажатию открываем заявку.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'ОПОРА · новая заявка', {
    body: d.body || 'Откройте приложение, чтобы посмотреть.',
    icon: 'icons/icon-192.png',
    badge: 'icons/favicon-64.png',
    tag: d.tag || 'opora-lead',
    data: { url: d.url || './#/leads' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './#/leads', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const win = list.find((c) => c.url.startsWith(self.registration.scope));
    if (win) { win.navigate(url); return win.focus(); }
    return self.clients.openWindow(url);
  }));
});

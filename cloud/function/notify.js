// Уведомления о новой заявке: Telegram-бот (если заданы TG_BOT_TOKEN и TG_CHAT_ID) и Web Push.
'use strict';
const webpush = require('web-push');
const db = require('./db');

function leadText(l) {
  return [
    '🆕 Заявка на диагностику',
    `${l.name} · ${l.contactType}: ${l.contact}`,
    `Запрос: ${l.pain}`,
    `${l.form || '—'} · ${l.sphere || '—'} · сотрудников ${l.team || '—'}`,
    l.cash ? `Остаток: ${l.cash}` : '',
  ].filter(Boolean).join('\n');
}

async function telegram(l) {
  const { TG_BOT_TOKEN: token, TG_CHAT_ID: chat } = process.env;
  if (!token || !chat) return;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: leadText(l), disable_web_page_preview: true }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error('telegram ' + res.status);
}

async function push(l) {
  const { VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: priv, VAPID_SUBJECT: subj } = process.env;
  if (!pub || !priv) return;
  webpush.setVapidDetails(subj || 'mailto:oporasamitovva@yandex.ru', pub, priv);
  const payload = JSON.stringify({
    title: 'ОПОРА · новая заявка',
    body: `${l.name}: ${l.pain}`,
    url: './#/lead/' + encodeURIComponent(l.id),
    tag: 'lead-' + l.id,
  });
  const subs = await db.listPush();
  await Promise.all(subs.map((s) => webpush.sendNotification(s, payload, { TTL: 86400 }).catch(async (e) => {
    if (e.statusCode === 404 || e.statusCode === 410) await db.deletePush(s.endpoint); // подписка устарела
    else console.error('push failed', e.statusCode || e.message);
  })));
}

// Клиент на сайте ждёт ответа, поэтому уведомления ограничены по времени: заявка уже сохранена в базе.
const NOTIFY_BUDGET_MS = 3000;
async function newLead(l) {
  const all = Promise.allSettled([telegram(l), push(l)]).then((results) =>
    results.filter((r) => r.status === 'rejected').forEach((r) => console.error('notify:', r.reason && r.reason.message)));
  const timer = new Promise((resolve) => setTimeout(() => { console.error('notify: превышен бюджет', NOTIFY_BUDGET_MS, 'мс'); resolve(); }, NOTIFY_BUDGET_MS).unref());
  await Promise.race([all, timer]);
}

module.exports = { newLead, leadText };

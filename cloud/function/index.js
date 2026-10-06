// API ОПОРЫ — одна Cloud Function за API Gateway.
// Маршрут приходит из спецификации шлюза (operationContext.route), см. ../gateway.yaml.
// Секреты — только в переменных окружения функции (Lockbox платный, мы в free tier).
'use strict';
const crypto = require('crypto');
const db = require('./db');
const notify = require('./notify');

const TOKEN_TTL_SEC = 30 * 24 * 3600;
const LEAD_RATE = { limit: 5, windowSec: 600 }; // не больше 5 заявок за 10 минут с одного IP
const STATUSES = ['new', 'contacted', 'call', 'client', 'lost'];

/* ---------- ответы ---------- */
const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});
const fail = (statusCode, error) => json(statusCode, { error });

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  if (raw.length > 20000) throw Object.assign(new Error('Слишком большой запрос.'), { status: 413 });
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('Некорректный JSON.'), { status: 400 }); }
}
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/* ---------- токен (HMAC-SHA256, без внешних библиотек) ---------- */
const b64u = (buf) => Buffer.from(buf).toString('base64url');
function signToken(payload) {
  const body = b64u(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC }));
  const sig = b64u(crypto.createHmac('sha256', process.env.JWT_SECRET).update(body).digest());
  return body + '.' + sig;
}
function verifyToken(event) {
  const h = event.headers || {};
  const auth = h.Authorization || h.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const [body, sig] = token.split('.');
  if (!body || !sig || !process.env.JWT_SECRET) return null;
  const expect = b64u(crypto.createHmac('sha256', process.env.JWT_SECRET).update(body).digest());
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p.exp > Date.now() / 1000 ? p : null;
  } catch { return null; }
}

/* ---------- пароль: scrypt, хэш в env ADMIN_PASS_HASH = "salt:hash" (hex) ---------- */
function checkPassword(password) {
  const [salt, hash] = String(process.env.ADMIN_PASS_HASH || '').split(':');
  if (!salt || !hash) return false;
  const got = crypto.scryptSync(String(password), Buffer.from(salt, 'hex'), 64);
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/* ---------- заявка с сайта ---------- */
function cleanLead(b) {
  const lead = {
    name: str(b.name, 80),
    contactType: b.contactType === 'Телефон' ? 'Телефон' : 'Telegram',
    contact: str(b.contact, 40),
    pain: str(b.pain, 120),
    form: str(b.form, 40),
    sphere: str(b.sphere, 60),
    team: str(b.team, 20),
    cash: str(b.cash, 120),
    page: str(b.page, 300),
  };
  if (!lead.name || !lead.contact || !lead.pain) return null;
  if (lead.contactType === 'Телефон' ? lead.contact.replace(/\D/g, '').length !== 11 : !/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(lead.contact)) return null;
  return lead;
}

/* ---------- маршруты ---------- */
const routes = {
  async createLead(event) {
    const b = parseBody(event);
    if (b.website) return json(200, { ok: true }); // ловушка для ботов: делаем вид, что приняли
    const lead = cleanLead(b);
    if (!lead) return fail(400, 'Проверьте имя, контакт и ответы.');
    const ip = (event.requestContext && event.requestContext.identity && event.requestContext.identity.sourceIp) || 'unknown';
    if (!(await db.hitRate('lead:' + ip, LEAD_RATE))) return fail(429, 'Слишком много заявок. Попробуйте позже или напишите в Telegram.');
    const saved = await db.createLead(lead);
    await notify.newLead(saved).catch((e) => console.error('notify failed', e.message));
    return json(201, { ok: true, id: saved.id });
  },

  async login(event) {
    const { email, password } = parseBody(event);
    const ip = (event.requestContext && event.requestContext.identity && event.requestContext.identity.sourceIp) || 'unknown';
    if (!(await db.hitRate('login:' + ip, { limit: 10, windowSec: 900 }))) return fail(429, 'Слишком много попыток. Подождите 15 минут.');
    const okEmail = str(email, 200).toLowerCase() === String(process.env.ADMIN_EMAIL || '').toLowerCase();
    if (!okEmail || !checkPassword(password)) return fail(401, 'Неверный e-mail или пароль.');
    return json(200, { token: signToken({ sub: process.env.ADMIN_EMAIL }), user: { email: process.env.ADMIN_EMAIL } });
  },

  async listLeads() { return json(200, await db.listLeads()); },

  async updateLead(event, id) {
    const { status } = parseBody(event);
    if (!STATUSES.includes(status)) return fail(400, 'Неизвестный статус.');
    const lead = await db.updateLead(id, (l) => { l.status = status; });
    return lead ? json(200, lead) : fail(404, 'Заявка не найдена.');
  },

  async addNote(event, id) {
    const text = str(parseBody(event).text, 2000);
    if (!text) return fail(400, 'Пустая заметка.');
    const lead = await db.updateLead(id, (l) => { (l.notes = l.notes || []).push({ at: new Date().toISOString(), text }); });
    return lead ? json(200, lead) : fail(404, 'Заявка не найдена.');
  },

  async deleteLead(event, id) {
    return (await db.deleteLead(id)) ? json(200, { ok: true }) : fail(404, 'Заявка не найдена.');
  },

  async pushSubscribe(event) {
    const sub = parseBody(event);
    if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys) return fail(400, 'Некорректная подписка.');
    await db.savePush(sub);
    return json(200, { ok: true });
  },
};
const PUBLIC = new Set(['createLead', 'login']);

module.exports.handler = async (event, context) => {
  db.setIamToken(context && context.token && context.token.access_token);
  const ctx = (event.requestContext && event.requestContext.apiGateway && event.requestContext.apiGateway.operationContext) || {};
  const route = ctx.route;
  const fn = routes[route];
  if (!fn) return fail(404, 'Not found');
  if (!PUBLIC.has(route) && !verifyToken(event)) return fail(401, 'Нужно войти.');
  const id = str((event.params && event.params.id) || (event.pathParams && event.pathParams.id), 80);
  try {
    return await fn(event, id);
  } catch (e) {
    if (e.status) return fail(e.status, e.message);
    console.error(route, e);
    return fail(500, 'Ошибка сервера.' + (process.env.DEBUG_ERRORS ? ' ' + (e && e.message) : ''));
  }
};
// для локальных тестов
module.exports._test = { cleanLead, signToken, verifyToken, checkPassword };

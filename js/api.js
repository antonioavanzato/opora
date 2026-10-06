// Единственная точка доступа к данным. Интерфейс одинаков для демо и облака:
// login, logout, session, listLeads, updateLead, addNote.
import { API_BASE } from './config.js';

const SESSION_KEY = 'opora.session';
const DEMO_KEY = 'opora.demo.leads.v1';

export const STATUSES = [
  { id: 'new', label: 'Новая' },
  { id: 'contacted', label: 'Связалась' },
  { id: 'call', label: 'Созвон назначен' },
  { id: 'client', label: 'Клиент' },
  { id: 'lost', label: 'Отказ' },
];

function readSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}
function writeSession(s) {
  try { s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY); } catch {}
}

/* ---------- Демо: синтетические заявки в localStorage ---------- */
function seed() {
  const names = ['Алина Г.', 'Руслан Х.', 'Марина С.', 'Тимур В.', 'Екатерина Л.', 'Ильдар Н.', 'Ольга Р.', 'Дмитрий К.', 'Гульнара З.', 'Сергей П.', 'Анна М.', 'Айдар Ш.'];
  const pains = ['Боюсь налоговой — нужна отчётность в срок', 'Не вижу реальную прибыль', 'Хаос в документах', 'Хочу расти по прогнозам и сценариям'];
  const forms = ['ИП', 'ООО', 'Пока не открыт'];
  const spheres = ['Производство', 'Продажа товаров', 'Услуги', 'Другое'];
  const teams = ['до 5', '5–15', 'больше 15'];
  const statuses = ['new', 'new', 'new', 'contacted', 'contacted', 'call', 'client', 'lost'];
  const now = Date.now();
  return names.map((name, i) => {
    const tg = i % 3 !== 0;
    const status = statuses[i % statuses.length];
    const created = new Date(now - (i * 31 + 5) * 3600e3).toISOString();
    return {
      id: 'demo_' + (i + 1),
      createdAt: created,
      name,
      contactType: tg ? 'Telegram' : 'Телефон',
      contact: tg ? '@demo_client_' + (i + 1) : '+7 (900) 000-0' + String(i).padStart(1, '0') + '-0' + (i % 10),
      pain: pains[i % pains.length],
      form: forms[i % forms.length],
      sphere: spheres[(i * 3) % spheres.length],
      team: teams[(i * 2) % teams.length],
      cash: ['Знает точно', 'Знает примерно', 'Не знает', ''][i % 4],
      page: 'https://oporasamitovva.wfolio.pro/',
      status,
      notes: status === 'new' ? [] : [{ at: created, text: 'Демо-заметка: написала в Telegram.' }],
    };
  });
}
function demoLoad() {
  try {
    const raw = localStorage.getItem(DEMO_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  const data = seed();
  demoSave(data);
  return data;
}
function demoSave(data) { try { localStorage.setItem(DEMO_KEY, JSON.stringify(data)); } catch {} }
const delay = (v) => new Promise((r) => setTimeout(() => r(v), 150));

const DemoApi = {
  demo: true,
  async login(email, password) {
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Проверьте e-mail.');
    if ((password || '').length < 6) throw new Error('Пароль — не короче 6 символов.');
    const s = { token: 'demo', user: { email } };
    writeSession(s);
    return delay(s);
  },
  async listLeads() { return delay(demoLoad()); },
  async updateLead(id, patch) {
    const data = demoLoad();
    const lead = data.find((l) => l.id === id);
    if (!lead) throw new Error('Заявка не найдена.');
    Object.assign(lead, patch);
    demoSave(data);
    return delay(lead);
  },
  async addNote(id, text) {
    const data = demoLoad();
    const lead = data.find((l) => l.id === id);
    if (!lead) throw new Error('Заявка не найдена.');
    lead.notes = lead.notes || [];
    lead.notes.push({ at: new Date().toISOString(), text });
    demoSave(data);
    return delay(lead);
  },
  async savePush() { return delay({ ok: true }); }, // в демо подписку некуда сохранять
  resetDemo() { localStorage.removeItem(DEMO_KEY); },
};

/* ---------- Облако: Yandex Cloud (подключим, когда будет API) ---------- */
async function call(path, { method = 'GET', body } = {}) {
  const s = readSession();
  const res = await fetch(API_BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(s?.token ? { Authorization: 'Bearer ' + s.token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { writeSession(null); location.hash = '#/login'; throw new Error('Сессия истекла, войдите снова.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Ошибка сервера (' + res.status + ').');
  return data;
}

const CloudApi = {
  demo: false,
  async login(email, password) {
    const s = await call('/auth/login', { method: 'POST', body: { email, password } });
    writeSession(s);
    return s;
  },
  listLeads: () => call('/leads'),
  updateLead: (id, patch) => call('/leads/' + encodeURIComponent(id), { method: 'PATCH', body: patch }),
  addNote: (id, text) => call('/leads/' + encodeURIComponent(id) + '/notes', { method: 'POST', body: { text } }),
  savePush: (subscription) => call('/push/subscribe', { method: 'POST', body: subscription }),
};

const impl = API_BASE ? CloudApi : DemoApi;

export const api = {
  ...impl,
  session: readSession,
  logout() { writeSession(null); },
};

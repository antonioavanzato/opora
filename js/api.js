// Единственная точка доступа к данным (Yandex Cloud, API Gateway «opora-api»):
// login, logout, session, listLeads, updateLead, addNote, savePush.
import { API_BASE } from './config.js';

const SESSION_KEY = 'opora.session';

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

/* ---------- Облако: Yandex Cloud ---------- */
async function call(path, { method = 'GET', body } = {}) {
  const s = readSession();
  const res = await fetch(API_BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(s?.token ? { Authorization: 'Bearer ' + s.token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  // 401 на защищённых маршрутах — токен истёк; на самом входе это просто неверный пароль
  if (res.status === 401 && path !== '/auth/login') { writeSession(null); location.hash = '#/login'; throw new Error('Сессия истекла, войдите снова.'); }
  if (!res.ok) throw new Error(data.error || 'Ошибка сервера (' + res.status + ').');
  return data;
}

const CloudApi = {
  async login(email, password) {
    const s = await call('/auth/login', { method: 'POST', body: { email, password } });
    writeSession(s);
    return s;
  },
  listLeads: () => call('/leads'),
  updateLead: (id, patch) => call('/leads/' + encodeURIComponent(id), { method: 'PATCH', body: patch }),
  addNote: (id, text) => call('/leads/' + encodeURIComponent(id) + '/notes', { method: 'POST', body: { text } }),
  deleteLead: (id) => call('/leads/' + encodeURIComponent(id), { method: 'DELETE' }),
  bulkLeads: (ids, action, status) => call('/leads/bulk', { method: 'POST', body: { ids, action, status } }),
  savePush: (subscription) => call('/push/subscribe', { method: 'POST', body: subscription }),
};

if (!API_BASE) throw new Error('Не задан API_BASE в js/config.js');

// Остатки демо-версии в браузере (вымышленные заявки и демо-сессия) — удаляем.
try {
  localStorage.removeItem('opora.demo.leads.v1');
  if ((readSession() || {}).token === 'demo') writeSession(null);
} catch {}

export const api = {
  ...CloudApi,
  session: readSession,
  logout() { writeSession(null); },
};

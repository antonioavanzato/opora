// YDB Serverless. В облаке — авторизация от сервисного аккаунта функции (метаданные),
// локально (миграции) — через переменные YDB_* (см. ../migrate.js).
'use strict';
const crypto = require('crypto');
const { Driver, getCredentialsFromEnv, TypedValues, TypedData } = require('ydb-sdk');
const grpc = require('@grpc/grpc-js');

// IAM-токен сервисного аккаунта функции: Cloud Functions передаёт его в context каждого вызова.
// (MetadataAuthService из ydb-sdk тянет тяжёлый @yandex-cloud/nodejs-sdk — обходимся без него.)
let iamToken = '';
function setIamToken(t) { if (t) iamToken = t; }
const contextAuth = {
  async getAuthMetadata() {
    if (!iamToken) throw new Error('Нет IAM-токена функции (сервисный аккаунт не назначен?)');
    const m = new grpc.Metadata();
    m.add('x-ydb-auth-ticket', iamToken);
    return m;
  },
};

let driverPromise;
function driver() {
  if (!driverPromise) {
    driverPromise = (async () => {
      // Локально задан ключ сервисного аккаунта — берём его; в облаке — токен из метаданных функции.
      const local = !!process.env.YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS;
      const d = new Driver({
        endpoint: process.env.YDB_ENDPOINT,
        database: process.env.YDB_DATABASE,
        authService: local ? getCredentialsFromEnv() : contextAuth,
      });
      if (!(await d.ready(10000))) { driverPromise = null; throw new Error('YDB недоступна'); }
      return d;
    })();
  }
  return driverPromise;
}

async function query(text, params = {}) {
  const d = await driver();
  return d.tableClient.withSession(async (s) => {
    const res = await s.executeQuery(text, params);
    return res.resultSets.map((rs) => TypedData.createNativeObjects(rs).map((r) => ({ ...r })));
  });
}

const rowToLead = (r) => {
  const doc = typeof r.doc === 'string' ? JSON.parse(r.doc) : r.doc;
  return { ...doc, id: r.id, status: r.status, createdAt: new Date(r.createdAt || r.created_at).toISOString() };
};

async function createLead(lead) {
  const id = 'l_' + crypto.randomBytes(9).toString('base64url');
  const now = new Date();
  const doc = { ...lead, notes: [] };
  await query(`
    DECLARE $id AS Utf8; DECLARE $at AS Timestamp; DECLARE $doc AS Json;
    UPSERT INTO leads (id, created_at, status, doc) VALUES ($id, $at, "new", $doc);`,
  { $id: TypedValues.utf8(id), $at: TypedValues.timestamp(now), $doc: TypedValues.json(JSON.stringify(doc)) });
  return { ...doc, id, status: 'new', createdAt: now.toISOString() };
}

async function listLeads() {
  const [rows] = await query('SELECT id, created_at, status, doc FROM leads ORDER BY created_at DESC LIMIT 1000;');
  return rows.map(rowToLead);
}

async function getLead(id) {
  const [rows] = await query('DECLARE $id AS Utf8; SELECT id, created_at, status, doc FROM leads WHERE id = $id;', { $id: TypedValues.utf8(id) });
  return rows[0] ? rowToLead(rows[0]) : null;
}

// mutate(lead) меняет объект; сохраняем статус и документ
async function updateLead(id, mutate) {
  const lead = await getLead(id);
  if (!lead) return null;
  mutate(lead);
  const { id: _i, status, createdAt: _c, ...doc } = lead;
  await query(`
    DECLARE $id AS Utf8; DECLARE $st AS Utf8; DECLARE $doc AS Json;
    UPDATE leads SET status = $st, doc = $doc WHERE id = $id;`,
  { $id: TypedValues.utf8(id), $st: TypedValues.utf8(status), $doc: TypedValues.json(JSON.stringify(doc)) });
  return lead;
}

// Счётчик запросов в окне windowSec. Возвращает false, если лимит исчерпан.
async function hitRate(key, { limit, windowSec }) {
  const bucket = Math.floor(Date.now() / 1000 / windowSec);
  const k = key + ':' + bucket;
  const expire = new Date((bucket + 2) * windowSec * 1000); // строки удаляет TTL таблицы
  const [rows] = await query(`
    DECLARE $k AS Utf8; DECLARE $exp AS Timestamp;
    $cur = SELECT cnt FROM rate WHERE k = $k;
    UPSERT INTO rate (k, cnt, expire_at) VALUES ($k, COALESCE(($cur), 0u) + 1u, $exp);
    SELECT COALESCE(($cur), 0u) + 1u AS cnt;`,
  { $k: TypedValues.utf8(k), $exp: TypedValues.timestamp(expire) });
  return Number(rows[0].cnt) <= limit;
}

async function savePush(sub) {
  await query(`
    DECLARE $e AS Utf8; DECLARE $s AS Json; DECLARE $at AS Timestamp;
    UPSERT INTO push_subs (endpoint, sub, created_at) VALUES ($e, $s, $at);`,
  { $e: TypedValues.utf8(sub.endpoint), $s: TypedValues.json(JSON.stringify(sub)), $at: TypedValues.timestamp(new Date()) });
}
async function listPush() {
  const [rows] = await query('SELECT endpoint, sub FROM push_subs;');
  return rows.map((r) => (typeof r.sub === 'string' ? JSON.parse(r.sub) : r.sub));
}
async function deletePush(endpoint) {
  await query('DECLARE $e AS Utf8; DELETE FROM push_subs WHERE endpoint = $e;', { $e: TypedValues.utf8(endpoint) });
}

module.exports = { setIamToken, query, driver, createLead, listLeads, getLead, updateLead, hitRate, savePush, listPush, deletePush };

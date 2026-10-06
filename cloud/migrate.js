// Создание таблиц YDB (идемпотентно). Запуск локально ключом деплойного сервисного аккаунта:
//   YDB_ENDPOINT=grpcs://ydb.serverless.yandexcloud.net:2135 YDB_DATABASE=/ru-central1/... \
//   YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS=~/.config/yandex-cloud/keys/opora-deployer.json node migrate.js
'use strict';
const { driver } = require('./function/db');

const DDL = [
  `CREATE TABLE IF NOT EXISTS leads (
     id Utf8 NOT NULL, created_at Timestamp, status Utf8, doc Json,
     PRIMARY KEY (id))`,
  `CREATE TABLE IF NOT EXISTS push_subs (
     endpoint Utf8 NOT NULL, sub Json, created_at Timestamp,
     PRIMARY KEY (endpoint))`,
  `CREATE TABLE IF NOT EXISTS rate (
     k Utf8 NOT NULL, cnt Uint32, expire_at Timestamp,
     PRIMARY KEY (k))
   WITH (TTL = Interval("PT0S") ON expire_at)`,
];

(async () => {
  const d = await driver();
  for (const text of DDL) {
    await d.queryClient.do({ fn: async (session) => { const r = await session.execute({ text }); await r.opFinished; } });
    console.log('ok:', text.split('(')[0].trim());
  }
  await d.destroy();
})().catch((e) => { console.error(e.message || e); process.exit(1); });

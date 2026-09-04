#!/usr/bin/env node
/**
 * 端到端測試：在 Firebase emulator（demo 專案，離線）跑完整 API 流程與逾時掃描。
 *
 *   npm run e2e
 *
 * 會以 `firebase emulators:exec` 啟動 functions + firestore，執行 e2e-body.mjs 後自動關閉。
 * LINE 推播因未綁定群組會被略過（pushed=false），不需要真實 channel。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fnDir = resolve(here, '..');
const rootDir = resolve(fnDir, '..');

// emulator 用的假 secrets / 參數；只補缺少的鍵，不覆蓋既有值。
function ensureKeys(file, defaults) {
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const have = new Set(existing.split('\n').filter((l) => l.includes('=')).map((l) => l.split('=')[0]));
  const missing = Object.entries(defaults).filter(([k]) => !have.has(k));
  if (missing.length) {
    writeFileSync(file, `${existing.replace(/\n*$/, '\n')}${missing.map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
    console.log(`[e2e] added ${missing.map(([k]) => k).join(', ')} to ${file.split('/').pop()}`);
  }
}
ensureKeys(resolve(fnDir, '.secret.local'), {
  WRITE_TOKEN: 'e2e-write-token',
  LINE_CHANNEL_SECRET: 'e2e-channel-secret',
  LINE_CHANNEL_ACCESS_TOKEN: 'e2e-access-token',
  TRAVELER_LINE_UID: 'Ue2e0000000000000000000000000000',
  LINE_LOGIN_CHANNEL_SECRET: 'e2e-login-secret',
  SESSION_SECRET: 'e2e-session-secret-0123456789abcdef',
});
ensureKeys(resolve(fnDir, '.env.local'), {
  PUBLIC_BASE_URL: 'http://localhost:5000',
  PHOTO_BUCKET: 'demo-iamalive-photos',
  LINE_LOGIN_CHANNEL_ID: '1234567890',
});

const firebaseBin = process.env.FIREBASE_BIN ?? 'firebase';
const body = resolve(here, 'e2e-body.mjs');
const r = spawnSync(
  firebaseBin,
  ['emulators:exec', '--only', 'functions,firestore,storage', '--project', 'demo-iamalive', `node ${JSON.stringify(body)}`],
  { cwd: rootDir, stdio: 'inherit', env: { ...process.env, FIREBASE_E2E: '1' } },
);
process.exit(r.status ?? 1);

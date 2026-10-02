#!/usr/bin/env node
/**
 * One-time conversion (Promo v1.3.0): DEFAULT_DB (db.js) + default-db.json
 * sang schema promoRules thống nhất (mkt_gift_rules/foc_rules/mkt_gift_rules SP/
 * promoTextRules → campaign.promoRules[]).
 *
 * Chạy: node scripts/migrate-promo-schema.mjs
 * An toàn chạy lại: data đã có promoRulesVersion >= 2 → migratePromoRules là no-op.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { migratePromoRules } from '../db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB_JS = join(ROOT, 'db.js');
const DEFAULT_JSON = join(ROOT, 'default-db.json');
const START = 'const DEFAULT_DB =';
const END = 'const DEFAULT_ALIASES = {';

// ---------- db.js: DEFAULT_DB block ----------
const src = readFileSync(DB_JS, 'utf8');
const startIdx = src.indexOf(START);
const endIdx = src.indexOf(END, startIdx);
if (startIdx === -1 || endIdx === -1) {
  console.error('[ABORT] Không tìm thấy markers DEFAULT_DB/DEFAULT_ALIASES trong db.js');
  process.exit(1);
}
const block = src.slice(startIdx + START.length, endIdx);
const firstBrace = block.indexOf('{');
const lastBrace = block.lastIndexOf('}');
const objText = block
  .slice(firstBrace, lastBrace + 1)
  .split('\n')
  .filter((l) => !/^\s*\/\//.test(l))
  .join('\n');
const data = JSON.parse(objText);
if (migratePromoRules(data)) {
  const replacement = `${START}\n${JSON.stringify(data, null, 2)};\n\n`;
  writeFileSync(DB_JS, src.slice(0, startIdx) + replacement + src.slice(endIdx), 'utf8');
  console.log('db.js: DEFAULT_DB đã chuyển sang promoRules (promoRulesVersion=' + data.promoRulesVersion + ')');
} else {
  console.log('db.js: DEFAULT_DB đã ở schema mới — không đổi.');
}

// ---------- default-db.json ----------
const jdata = JSON.parse(readFileSync(DEFAULT_JSON, 'utf8'));
if (migratePromoRules(jdata)) {
  writeFileSync(DEFAULT_JSON, JSON.stringify(jdata, null, 2) + '\n', 'utf8');
  console.log('default-db.json: đã chuyển sang promoRules (promoRulesVersion=' + jdata.promoRulesVersion + ')');
} else {
  console.log('default-db.json: đã ở schema mới — không đổi.');
}
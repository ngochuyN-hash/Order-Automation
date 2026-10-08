#!/usr/bin/env node
/**
 * Sync script: overwrites default-db.json with data from a user export file
 * ("Xuất database" in Settings).
 *
 * Usage: node scripts/sync-default-db.js <path-to-export.json>
 *
 * Export format (db.exportJSON): { database: {...}, aliases: {...}, memory: "..." }
 * Only the `database` part is synced. Runtime-only flags (keys starting with
 * '_' such as _packingFixedV1) are stripped; all other top-level keys
 * (campaigns, priceVersion, promoRulesVersion, ...) are preserved.
 *
 * NOTE (10/2026): db.js no longer contains the DEFAULT_DB data block — it
 * imports default-db.json directly (Vite inlines the JSON into the dist
 * bundle at build time). So this script only writes default-db.json; run
 * `npm run build:renderer` afterwards to bake the new data into the app.
 *
 * NOTE: the export's `aliases` field is the USER's customAliases (live edits),
 * NOT the default alias set. DEFAULT_ALIASES in db.js is the factory-default
 * set used for fresh installs/resets and must NOT be synced from exports —
 * it is intentionally left untouched here.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_JSON = path.join(ROOT, 'default-db.json');

const MIN_RATIO = 0.9; // refuse if new total < 90% of current total

function fail(msg) {
  console.error(`\n[ABORT] ${msg}`);
  process.exit(1);
}

function countProducts(campaigns) {
  const perCampaign = {};
  let total = 0;
  for (const [key, camp] of Object.entries(campaigns)) {
    const n = Array.isArray(camp && camp.products) ? camp.products.length : 0;
    perCampaign[key] = n;
    total += n;
  }
  return { perCampaign, total };
}

// ---------------------------------------------------------------- argv
const exportPath = process.argv[2];
if (!exportPath) fail('Missing argument: path to export JSON file.');
if (!fs.existsSync(exportPath)) fail(`Export file not found: ${exportPath}`);

// ---------------------------------------------------------------- read export
let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
} catch (e) {
  fail(`Cannot parse export file: ${e.message}`);
}

// exportJSON() wraps as { database, aliases, memory }; accept raw shape too.
// (export `aliases` = user customAliases — intentionally ignored, see header)
let dbObj = parsed && parsed.database ? parsed.database : parsed;
if (!dbObj || typeof dbObj !== 'object' || !dbObj.campaigns || typeof dbObj.campaigns !== 'object') {
  fail('Export file has no `campaigns` object (neither at top level nor under `database`).');
}

// Strip runtime-only flags (underscore-prefixed keys), keep everything else
// (campaigns + priceVersion + promoRulesVersion + future top-level keys).
const runtimeKeys = Object.keys(dbObj).filter((k) => k.startsWith('_'));
const newDb = {};
for (const k of Object.keys(dbObj)) {
  if (!k.startsWith('_')) newDb[k] = dbObj[k];
}
const newStats = countProducts(newDb.campaigns);
if (newStats.total === 0) fail('Export contains zero products — refusing to sync.');

// ---------------------------------------------------------------- read current default-db.json
let oldStats = { perCampaign: {}, total: 0 };
if (fs.existsSync(DEFAULT_JSON)) {
  try {
    const oldJson = JSON.parse(fs.readFileSync(DEFAULT_JSON, 'utf8'));
    if (oldJson && oldJson.campaigns) oldStats = countProducts(oldJson.campaigns);
  } catch (e) {
    console.warn(`[WARN] current default-db.json unreadable (${e.message}); skipping ratio check.`);
  }
}

if (oldStats.total > 0 && newStats.total < oldStats.total * MIN_RATIO) {
  fail(
    `New data (${newStats.total} products) is under ${MIN_RATIO * 100}% of current ` +
      `default-db.json (${oldStats.total} products). Possible truncated export — aborting.`
  );
}

// ---------------------------------------------------------------- write default-db.json
fs.writeFileSync(DEFAULT_JSON, JSON.stringify(newDb, null, 2) + '\n', 'utf8');

// ---------------------------------------------------------------- sanity: JSON still parses
try {
  JSON.parse(fs.readFileSync(DEFAULT_JSON, 'utf8'));
} catch (e) {
  fail(`Written default-db.json failed to re-parse: ${e.message}`);
}

// ---------------------------------------------------------------- report
console.log('\n========== SYNC REPORT ==========');
console.log(`Export file : ${exportPath}`);
if (runtimeKeys.length) console.log(`Stripped    : runtime keys [${runtimeKeys.join(', ')}]`);
console.log(`Campaigns   : ${Object.keys(oldStats.perCampaign).length} → ${Object.keys(newStats.perCampaign).length}`);
console.log(`Products    : ${oldStats.total} → ${newStats.total}`);
const allKeys = new Set([...Object.keys(oldStats.perCampaign), ...Object.keys(newStats.perCampaign)]);
for (const k of allKeys) {
  const a = oldStats.perCampaign[k] ?? 0;
  const b = newStats.perCampaign[k] ?? 0;
  const mark = a === b ? ' ' : '*';
  console.log(`  ${mark} ${k.padEnd(20)} ${a} → ${b}`);
}
console.log(`Files       : default-db.json rewritten (db.js không còn chứa dữ liệu, không bị đụng tới)`);
console.log(`Next step   : npm run build:renderer để nạp dữ liệu mới vào bundle dist`);
console.log('Aliases     : DEFAULT_ALIASES trong db.js untouched (export aliases = user custom set)');
console.log('=================================');

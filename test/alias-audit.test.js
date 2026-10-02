/**
 * Automated Audit Test for DEFAULT_ALIASES (default-aliases.json)
 * Ensures zero broken product IDs and accurate packaging.
 * Run: node --test test/
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('Database Alias Integrity Audit', () => {
  const dbJsonPath = path.join(__dirname, '..', 'default-db.json');

  const dbJson = JSON.parse(fs.readFileSync(dbJsonPath, 'utf8'));

  // Build product lookup
  const productMap = {};
  for (const campaign of Object.values(dbJson.campaigns || {})) {
    for (const product of (campaign.products || [])) {
      productMap[product.id] = product;
    }
  }

  // DEFAULT_ALIASES đã tách sang default-aliases.json (local-only, db.js import trực tiếp)
  const aliasesPath = path.join(__dirname, '..', 'default-aliases.json');
  const aliases = JSON.parse(fs.readFileSync(aliasesPath, 'utf8'));
  assert.ok(aliases && Object.keys(aliases).length > 0, 'default-aliases.json must contain aliases');

  it('mọi alias phải trỏ tới product id tồn tại trong danh mục', () => {
    const broken = [];
    for (const [alias, productId] of Object.entries(aliases)) {
      if (!productMap[productId]) broken.push({ alias, productId });
    }
    assert.equal(broken.length, 0, `Found ${broken.length} aliases pointing to unknown products: ${JSON.stringify(broken.slice(0, 5))}`);
  });

  it('ensures no alias without phuy in text points to a 60L drum product ID', () => {
    const broken60lAliases = [];
    for (const [alias, productId] of Object.entries(aliases)) {
      if (!alias.includes('phuy') && !alias.includes('60l') && productId.endsWith('_60l')) {
        broken60lAliases.push({ alias, productId });
      }
    }
    assert.equal(broken60lAliases.length, 0, `Found ${broken60lAliases.length} aliases pointing to _60l: ${JSON.stringify(broken60lAliases)}`);
  });
});

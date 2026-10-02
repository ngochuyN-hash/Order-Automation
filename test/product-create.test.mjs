/**
 * Tests cho luồng tạo SP mới 1 lần đủ (validateNewProduct + createProductFull).
 * Run: node --test test/product-create.test.mjs
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { db, DB_STORAGE_KEY } from '../db.js';
import { dbStore } from '../db-store.js';
import { validateNewProduct, createProductFull, packagingPreviewText, productHealthFlags } from '../src/product-edit.js';

let persistedWrites = [];
const _originalDbStoreSet = dbStore.set.bind(dbStore);
function installPersistStub() {
  dbStore.set = (key, value) => {
    persistedWrites.push({ key, value });
    return Promise.resolve();
  };
}
function restorePersistStub() { dbStore.set = _originalDbStoreSet; }

function seedDb() {
  db.data = {
    campaigns: {
      test_camp: {
        name: 'Test Campaign',
        products: [
          { id: 'p1', name: 'Zentor Eco Flow 5W30', spec: '1L', unit: 'chai', box_size: 12, kvCode: '100001', tiers: [{ min_qty: 1, max_qty: 9999, price: 130017, label: 'Tất cả' }], foc_rules: [], mkt_gift_rules: [] },
        ],
        promoRules: [],
      },
    },
  };
  db.kvCodeMap = { p1: '100001' };
  db.kvCodeThungMap = {};
  db.customAliases = {};
  db.removedDefaultAliases = {};
  db._bumpDataVersion();
}

const tick = () => new Promise(r => setTimeout(r, 10));
const ctxOf = () => ({
  siblingNames: db.data.campaigns.test_camp.products.map(p => p.name),
  kvCodeTaken: (code) => Object.entries(db.kvCodeMap).some(([pid, c]) => c === code) ||
    db.data.campaigns.test_camp.products.some(p => p.kvCode === code),
  aliasOwner: (lower) => db.getAliases()[lower] || null,
});
const goodInput = () => ({
  name: 'Torvex Mới 10W40', spec: '1L', unit: 'chai', box_size: '12',
  price: 180017, kvCode: '200002', kvCodeThung: '', aliases: '', isGift: false,
});

before(() => { installPersistStub(); });
after(() => { restorePersistStub(); });
beforeEach(() => { seedDb(); persistedWrites = []; });

describe('packagingPreviewText', () => {
  it('box_size=12 + unit chai → "12 chai/thùng"', () => {
    assert.equal(packagingPreviewText(12, 'chai'), '12 chai/thùng');
  });
  it('box_size=1 → chỉ unit', () => {
    assert.equal(packagingPreviewText(1, 'phuy'), 'phuy');
  });
});

describe('validateNewProduct', () => {
  it('input hợp lệ → ok, không errors/warnings', () => {
    const r = validateNewProduct(goodInput(), ctxOf());
    assert.equal(r.ok, true);
    assert.deepEqual(r.errors, {});
    assert.deepEqual(r.warnings, []);
  });

  it('tên trống → errors.name', () => {
    const r = validateNewProduct({ ...goodInput(), name: '   ' }, ctxOf());
    assert.equal(r.ok, false);
    assert.match(r.errors.name, /trống/);
  });

  it('trùng tên → warning DUPLICATE_NAME (không chặn)', () => {
    const r = validateNewProduct({ ...goodInput(), name: 'zentor eco flow 5w30' }, ctxOf());
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some(w => w.code === 'DUPLICATE_NAME'));
  });

  it('trùng tên XUYÊN thương hiệu → warning DUPLICATE_NAME_CROSS_CAMPAIGN (không chặn)', () => {
    db.data.campaigns.other_camp = {
      name: 'Other Brand',
      products: [
        { id: 'q1', name: 'Veltron ECS 0W-20', spec: '5L', unit: 'bình', box_size: 4, tiers: [{ min_qty: 1, max_qty: 99, price: 1000, label: 'Tất cả' }] },
      ],
      promoRules: [],
    };
    const ctx = {
      ...ctxOf(),
      crossCampaignNames: db.data.campaigns.other_camp.products.map(p => p.name),
    };
    const r = validateNewProduct({ ...goodInput(), name: 'veltron ecs 0w-20' }, ctx);
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some(w => w.code === 'DUPLICATE_NAME_CROSS_CAMPAIGN'));
  });

  it('trùng tên trong campaign → KHÔNG lặp thêm cảnh báo cross cho cùng tên', () => {
    const name = 'Zentor Eco Flow 5W30';
    const r = validateNewProduct({ ...goodInput(), name }, {
      siblingNames: [name],
      crossCampaignNames: [name],
    });
    assert.equal(r.ok, true);
    const dupWarnings = r.warnings.filter(w => w.code === 'DUPLICATE_NAME' || w.code === 'DUPLICATE_NAME_CROSS_CAMPAIGN');
    assert.equal(dupWarnings.length, 1);
    assert.equal(dupWarnings[0].code, 'DUPLICATE_NAME');
  });

  it('không truyền crossCampaignNames → bỏ qua check cross (backward compat)', () => {
    const r = validateNewProduct({ ...goodInput(), name: 'Zentor Eco Flow 5W30' }, { siblingNames: [] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.warnings.filter(w => w.code === 'DUPLICATE_NAME_CROSS_CAMPAIGN'), []);
  });

  it('box_size rác → errors.box_size (KHÔNG tự ép 12 im lặng)', () => {
    for (const bad of ['abc', '', '0', '-3']) {
      const r = validateNewProduct({ ...goodInput(), box_size: bad }, ctxOf());
      assert.equal(r.ok, false, `box_size=${bad} phải lỗi`);
      assert.ok(r.errors.box_size, `box_size=${bad} cần message`);
    }
  });

  it('giá 0 là hợp lệ, giá âm vẫn bị chặn', () => {
    assert.equal(validateNewProduct({ ...goodInput(), price: 0 }, ctxOf()).ok, true);
    assert.equal(validateNewProduct({ ...goodInput(), price: -5 }, ctxOf()).ok, false);
  });

  it('mã KV trùng SP khác → errors.kvCode', () => {
    const r = validateNewProduct({ ...goodInput(), kvCode: '100001' }, ctxOf());
    assert.equal(r.ok, false);
    assert.match(r.errors.kvCode, /100001/);
  });

  it('thiếu mã KV → warning (vẫn cho lưu)', () => {
    const r = validateNewProduct({ ...goodInput(), kvCode: '' }, ctxOf());
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some(w => w.code === 'MISSING_KVCODE'));
  });

  it('alias cướp của SP khác → errors.aliases', () => {
    db.customAliases = { 'eco cu': 'p1' };
    const r = validateNewProduct({ ...goodInput(), aliases: 'ten moi, eco cu' }, ctxOf());
    assert.equal(r.ok, false);
    assert.match(r.errors.aliases, /eco cu/);
  });

  it('alias chưa ai giữ → ok', () => {
    const r = validateNewProduct({ ...goodInput(), aliases: 'ax moi, test alias' }, ctxOf());
    assert.equal(r.ok, true);
  });
});

describe('productHealthFlags', () => {
  it('SP đủ điều kiện → không cờ', () => {
    const p = db.findProductById('p1');
    assert.deepEqual(productHealthFlags(p, db.getAliases()), []);
  });

  it('thiếu mã KV → cờ MISSING_KVCODE', () => {
    const flags = productHealthFlags({ id: 'x', kvCode: '', tiers: [{ price: 10 }] }, {});
    assert.ok(flags.some(f => f.code === 'MISSING_KVCODE'));
  });

  it('không mốc giá → cờ NO_TIERS; giá 0đ không phải lỗi', () => {
    assert.ok(productHealthFlags({ id: 'x', kvCode: '1', tiers: [] }, {}).some(f => f.code === 'NO_TIERS'));
    assert.equal(productHealthFlags({ id: 'x', kvCode: '1', tiers: [{ price: 0 }] }, {}).length, 0);
  });
});

describe('createProductFull', () => {
  it('tạo đủ 1 lần: tiers + alias + KV gốc + KV thùng', () => {
    const res = createProductFull('test_camp', {
      ...goodInput(), aliases: 'ax moi', kvCodeThung: '200002-9',
      tiers: [
        { min_qty: 1, max_qty: 5, price: 180017, label: '1-5' },
        { min_qty: 6, max_qty: 9999, price: 170017, label: '6+' },
      ],
    });
    assert.equal(res.ok, true);
    const p = db.findProductById(res.product.id);
    assert.equal(p.name, 'Torvex Mới 10W40');
    assert.equal(p.tiers.length, 2);
    assert.equal(db.kvCodeMap[res.product.id], '200002');
    assert.equal(db.kvCodeThungMap[res.product.id], '200002-9');
    assert.equal(db.getKvCode(p, 'thùng'), '200002-9');
    assert.equal(db.getAliases()['ax moi'], res.product.id);
  });

  it('KM nhanh tạo rule qty/foc tặng cùng loại (__same__)', () => {
    const res = createProductFull('test_camp', {
      ...goodInput(),
      quickPromo: { buyQty: 2, buyUnit: 'thùng', giftQty: 1 },
    });
    assert.equal(res.ok, true);
    const rules = db.data.campaigns.test_camp.promoRules.filter(r => r.productId === res.product.id);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].type, 'qty');
    assert.equal(rules[0].buy.qty, 2);
    assert.equal(rules[0].gifts[0].productId, '__same__');
  });

  it('campaign không tồn tại → lỗi, không tạo gì', () => {
    const before = db.getAllProducts().length;
    const res = createProductFull('ghost_camp', goodInput());
    assert.equal(res.ok, false);
    assert.equal(db.getAllProducts().length, before);
  });

  it('tên trống / box_size sai → lỗi', () => {
    assert.equal(createProductFull('test_camp', { ...goodInput(), name: '' }).ok, false);
    assert.equal(createProductFull('test_camp', { ...goodInput(), box_size: 'abc' }).ok, false);
  });

  it('persist: flushSave chứa SP mới', async () => {
    const res = createProductFull('test_camp', goodInput());
    assert.equal(res.ok, true);
    db.flushSave();
    await tick();
    const write = persistedWrites.find(w => w.key === DB_STORAGE_KEY);
    assert.ok(write);
    assert.ok(write.value.campaigns.test_camp.products.some(p => p.id === res.product.id));
  });
});

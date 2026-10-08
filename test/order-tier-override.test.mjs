/**
 * Tests cho dòng mốc giá đứng riêng ("Giá N thùng" áp TOÀN ĐƠN).
 * Bug thật 22/9/2026: đơn "Anywhere Man" có dòng "Giá 2 thùng" — parser nhặt
 * thành dòng hàng → match nhầm "Poster Pricelist" 0đ, và KHÔNG item nào được
 * áp mốc ≥2 (Chain Cleaner 1 thùng đứng giá 168k thay vì 158k).
 * Run: node --test test/order-tier-override.test.mjs
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Setup minimal DOM (builder chain import ui-renderer) — đồng bộ rescan.test.mjs
const elements = {};
global.document = {
  getElementById: (id) => {
    if (!elements[id]) {
      elements[id] = {
        value: '',
        textContent: '',
        innerHTML: '',
        style: {},
        options: [],
        appendChild: () => {},
        classList: { contains: () => false, add: () => {}, remove: () => {} }
      };
    }
    return elements[id];
  },
  createElement: (tag) => ({
    value: '',
    textContent: '',
    innerHTML: '',
    style: {},
    appendChild: () => {},
    classList: { contains: () => false, add: () => {}, remove: () => {} }
  }),
  createDocumentFragment: () => ({
    appendChild: () => {}
  })
};
if (typeof global.window === 'undefined') {
  global.window = {};
}

import { db } from '../db.js';
import { buildOrderFromText } from '../src/order/builder.js';
import { runParsePipeline } from '../src/order/parse-pipeline.js';

global.db = db;
global.window.db = db;

// Bảng giá thật trên máy user (tra qua MCP get_products 22/9/2026)
const PRODUCTS = [
  {
    id: 'znt_mxo_topgear_gp_chain_lube_max',
    name: 'Zentor Topgear GP Chain Lube Max (0,4L/chai)',
    spec: 'Chăm sóc xe', packaging: '400ml x 12 chai', unit: 'chai', box_size: 12, campaignKey: 'zentor',
    tiers: [
      { min_qty: 1, max_qty: 1, price: 205017, label: '1-1 thùng' },
      { min_qty: 2, max_qty: 9999, price: 185017, label: '≥2 thùng' },
    ], foc_rules: [],
  },
  {
    id: 'znt_mxo_topgear_gp_chain_lube_off_road',
    name: 'Zentor Topgear CP Chain Lube Off Road (0,4L/bình)',
    spec: 'Chăm sóc xe', packaging: '400ml x 12 chai', unit: 'chai', box_size: 12, campaignKey: 'zentor',
    tiers: [
      { min_qty: 1, max_qty: 1, price: 205017, label: '1-1 thùng' },
      { min_qty: 2, max_qty: 9999, price: 185017, label: '≥2 thùng' },
    ], foc_rules: [],
  },
  {
    id: 'znt_mxo_topgear_gp_chain_cleaner',
    name: 'Zentor Topgear GP Chain Cleaner (0,4L/bình)',
    spec: 'Chăm sóc xe', packaging: '400ml x 12 chai', unit: 'chai', box_size: 12, campaignKey: 'zentor',
    tiers: [
      { min_qty: 1, max_qty: 1, price: 168017, label: '1-1 thùng' },
      { min_qty: 2, max_qty: 9999, price: 158017, label: '≥2 thùng' },
    ], foc_rules: [],
  },
];

// Alias đúng như DB thật (bao gồm alias tự học "chain cleaner" → bản Zentor)
const CUSTOM_ALIASES = {
  'chain lube max': 'znt_mxo_topgear_gp_chain_lube_max',
  'chain lube off road': 'znt_mxo_topgear_gp_chain_lube_off_road',
  'chain cleaner': 'znt_mxo_topgear_gp_chain_cleaner',
};

// Đơn thật của sales (dòng "1' thùng" dính dấu nháy đã được fix riêng 22/9)
const ORDER_TEXT = [
  'Anywhere Man',
  "2 Thùng Chain Lube Max",
  "1' thùng Chain Lube Offroad",
  '1 Thùng Chain Cleaner',
  '3 Chai Chain Cleaner hàng tặng',
  'Giá 2 thùng',
  'TT CK',
  'HĐ',
].join('\n');

describe('buildOrderFromText — dòng "Giá N thùng" đứng riêng áp mốc toàn đơn', () => {
  beforeEach(() => {
    db.data = {
      campaigns: {
        zentor: { name: 'Zentor', color: '#1565c0', products: PRODUCTS },
      },
    };
    db.customAliases = { ...CUSTOM_ALIASES };
    db.removedDefaultAliases = {};
  });

  it('hết item ma "Giá"; Cleaner/Off Road 1 thùng được áp mốc ≥2 (158k/185k)', () => {
    const order = buildOrderFromText(ORDER_TEXT);
    assert.equal(order.items.length, 4, 'Đúng 4 dòng hàng — không có item "Giá" ma');
    assert.ok(!order.items.some(i => /^giá$/i.test((i.rawProduct || '').trim())),
      'Không được có item tên "Giá" (trước đây match nhầm Poster Pricelist)');

    const max = order.items.find(i => i.product.id.endsWith('_max'));
    assert.equal(max.unitPrice, 185017, 'Max 2 thùng → ≥2 thùng tự nhiên');
    assert.equal(max.tierLabel, '≥2 thùng');

    const offRoad = order.items.find(i => i.product.id.endsWith('off_road'));
    assert.equal(offRoad.unitPrice, 185017, 'Off Road 1 thùng → áp mốc toàn đơn → 185k (thay vì 205k)');
    assert.equal(offRoad.tierLabel, '≥2 thùng');

    const cleaner = order.items.find(i => i.product.id.endsWith('chain_cleaner') && !i.isGift);
    assert.equal(cleaner.unitPrice, 158017, 'Chain Cleaner 1 thùng → 168k → 158k theo mốc toàn đơn');
    assert.equal(cleaner.tierLabel, '≥2 thùng');

    const gift = order.items.find(i => i.isGift);
    assert.ok(gift, 'Dòng quà vẫn được nhận diện');
    assert.equal(gift.unitPrice, 0, 'Hàng tặng giữ giá 0, không áp mốc');
  });

  it('dòng có GIÁ TƯỜNG MINH không bị mốc toàn đơn đè', () => {
    const text = ['1 Thùng Chain Cleaner giá 168k', 'Giá 2 thùng'].join('\n');
    const order = buildOrderFromText(text);
    const cleaner = order.items.find(i => i.product.id.endsWith('chain_cleaner'));
    assert.equal(cleaner.unitPrice, 168000, 'Sales báo giá riêng → giữ giá riêng');
    assert.equal(cleaner.manualPrice, 168000);
  });

  it('dòng có MỐC RIÊNG trên dòng ưu tiên hơn mốc toàn đơn', () => {
    const text = ['1 thùng chain cleaner giá 1 thùng', 'Giá 2 thùng'].join('\n');
    const order = buildOrderFromText(text);
    const cleaner = order.items.find(i => i.product.id.endsWith('chain_cleaner'));
    assert.equal(cleaner.unitPrice, 168017, 'Mốc riêng "giá 1 thùng" thắng mốc toàn đơn "giá 2 thùng"');
  });

  it('không có dòng mốc → hành vi cũ (Off Road 1 thùng = 205k)', () => {
    const order = buildOrderFromText("1' thùng Chain Lube Offroad");
    assert.equal(order.items.length, 1);
    assert.equal(order.items[0].unitPrice, 205017, 'Không mốc → giá mốc 1 như cũ');
  });
});

// ═══ Đường AI: mốc giá toàn đơn do HỆ THỐNG áp, không phụ thuộc model ═══════
// User báo 22/9/2026: đơn chạy CHẾ ĐỘ AI thì "Giá 2 thùng" không được áp. Luật
// prompt (ai-service + ORDER_SEMANTICS) chỉ là lớp 1 — model có thể lơ. Nên
// parse-pipeline phải TỰ phát hiện dòng mốc giá trong text thô và áp bằng code.
// Test dưới mô phỏng model TỆ NHẤT: không đặt priceTierQty cho item nào + còn
// nhặt dòng "Giá 2 thùng" thành item ma.

function makeFakeAi(echoText) {
  return {
    async callAI(prompt) {
      if (prompt !== echoText) {
        // Lượt call tự vá dòng sót (không xảy ra trong các test này) → trả rỗng
        return { customer: null, payment: 'ck', notes: [], items: [], tln: [] };
      }
      return {
        customer: 'Anywhere Man',
        payment: 'ck',
        notes: [],
        items: [
          { qty: 2, unit: 'thùng', rawProduct: 'Chain Lube Max', kvCode: null, explicitPrice: null, priceTierQty: null, isGift: false, explicitGift: null },
          { qty: 1, unit: 'thùng', rawProduct: 'Chain Lube Offroad', kvCode: null, explicitPrice: null, priceTierQty: null, isGift: false, explicitGift: null },
          { qty: 1, unit: 'thùng', rawProduct: 'Chain Cleaner', kvCode: null, explicitPrice: null, priceTierQty: null, isGift: false, explicitGift: null },
          { qty: 3, unit: 'chai', rawProduct: 'Chain Cleaner hàng tặng', kvCode: null, explicitPrice: null, priceTierQty: null, isGift: true, explicitGift: null },
          { qty: 2, unit: 'thùng', rawProduct: 'Giá 2 thùng', kvCode: null, explicitPrice: null, priceTierQty: null, isGift: false, explicitGift: null },
        ],
        tln: ['Anywhere Man', '2 Thùng Chain Lube Max', '1 thùng Chain Lube Offroad', '1 Thùng Chain Cleaner', 'Giá 2 thùng'],
      };
    },
  };
}

describe('runParsePipeline (AI mode) — mốc giá toàn đơn do HỆ THỐNG áp', () => {
  beforeEach(() => {
    db.data = {
      campaigns: {
        zentor: { name: 'Zentor', color: '#1565c0', products: PRODUCTS },
      },
    };
    db.customAliases = { ...CUSTOM_ALIASES };
    db.removedDefaultAliases = {};
  });

  it('AI lơ rule (không đặt priceTierQty) + nhặt item "Giá" → hệ thống bỏ item ma và vẫn áp đúng giá mốc', async () => {
    const { order } = await runParsePipeline(ORDER_TEXT, { db, aiService: makeFakeAi(ORDER_TEXT) });
    assert.equal(order.items.length, 4, 'Item ma "Giá" do AI nhặt phải bị bỏ');
    assert.ok(!order.items.some(i => /^giá/i.test((i.rawProduct || '').trim())),
      'Không được còn item tên "Giá"');

    const max = order.items.find(i => i.product.id.endsWith('_max'));
    assert.equal(max.unitPrice, 185017, 'Max 2 thùng → ≥2 thùng');
    const offRoad = order.items.find(i => i.product.id.endsWith('off_road'));
    assert.equal(offRoad.unitPrice, 185017, 'Off Road 1 thùng: AI không đặt tier → hệ thống tự áp mốc toàn đơn → 185k');
    assert.equal(offRoad.tierLabel, '≥2 thùng');
    const cleaner = order.items.find(i => i.product.id.endsWith('chain_cleaner') && !i.isGift);
    assert.equal(cleaner.unitPrice, 158017, 'Chain Cleaner 1 thùng → 158k theo mốc toàn đơn');
    const gift = order.items.find(i => i.isGift);
    assert.ok(gift, 'Dòng quà giữ nguyên');
    assert.equal(gift.unitPrice, 0, 'Hàng tặng không áp mốc');
  });

  it('tin nhắn KHÔNG có dòng mốc → không tự áp giá (Off Road 1 thùng = 205k như cũ)', async () => {
    const text = ORDER_TEXT.split('\n').filter(l => !/giá 2 thùng/i.test(l)).join('\n');
    const { order } = await runParsePipeline(text, { db, aiService: makeFakeAi(text) });
    const offRoad = order.items.find(i => i.product.id.endsWith('off_road'));
    assert.equal(offRoad.unitPrice, 205017, 'Không mốc → giá mốc 1 như hành vi cũ');
  });

  it('item có GIÁ RIÊNG do AI trích (explicitPrice) không bị mốc toàn đơn đè', async () => {
    const text = ['1 Thùng Chain Cleaner giá 168k', 'Giá 2 thùng'].join('\n');
    const ai = {
      async callAI(prompt) {
        if (prompt !== text) return { customer: null, payment: 'ck', notes: [], items: [], tln: [] };
        return {
          customer: null, payment: 'ck', notes: [],
          items: [
            { qty: 1, unit: 'thùng', rawProduct: 'Chain Cleaner', kvCode: null, explicitPrice: 168000, priceTierQty: null, isGift: false, explicitGift: null },
          ],
          tln: ['1 Thùng Chain Cleaner giá 168k', 'Giá 2 thùng'],
        };
      },
    };
    const { order } = await runParsePipeline(text, { db, aiService: ai });
    assert.equal(order.items.length, 1, 'Không sinh item ma "Giá"');
    assert.equal(order.items[0].unitPrice, 168000, 'Giá sales khai thắng mốc toàn đơn');
  });
});

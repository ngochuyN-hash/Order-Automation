/**
 * Regression tests — Quà MKT thương hiệu (mkt_gift_rules)
 * Run: node --test test/mkt-gifts.test.mjs
 *
 * Bối cảnh: đơn 1 thùng R8000 + 1 thảm quà từng lên KiotViet
 * thừa 1 bình xịt vì dòng quà (box_size=1) bị cộng vào tổng thùng xét mốc MKT
 * → đơn 1 thùng bị tính 2 thùng → đạt mốc "2 thùng: 1 bình xịt".
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// db.js chạy được cả trong Node (không cần localStorage/Electron)
import { db, DEFAULT_DB, ProductDatabase } from '../db.js';

// ui-renderer.js không import gì — đọc global `db` (như window.db trong renderer)
db.data = JSON.parse(JSON.stringify(DEFAULT_DB));
globalThis.db = db;

const { uiRenderer } = await import('../ui-renderer.js');

const r8000 = () => db.findProductById('xvil_xvil_r8000_rs_10w30_1l');
const mat = () => db.findProductById('xvil_mkt_mat');

/** Đơn tối giản: hàng mua + hàng tặng (isGift) */
function buildOrder(items) {
  return {
    customer: 'Đại Lý A',
    payment: 'ck',
    items,
    customPromos: [],
    giftOverrides: {},
    giftDeleted: {},
    giftQtyOverrides: {},
    rowOrder: null,
    rawChatText: '',
    salesComment: '',
    tlnLines: null
  };
}

function boughtBoxes(qtyBoxes) {
  const p = r8000();
  return {
    rawProduct: p.name,
    qty: qtyBoxes,
    unit: 'thùng',
    product: p,
    unitPrice: 124000,
    subtotal: 124000 * qtyBoxes * (p.box_size || 12),
    foc: null,
    tierLabel: '',
    manualPrice: null,
    isGift: false
  };
}

function giftMat() {
  return {
    rawProduct: mat().name,
    qty: 1,
    unit: 'cái',
    product: mat(),
    unitPrice: 0,
    subtotal: 0,
    foc: null,
    tierLabel: 'Khuyến mãi',
    manualPrice: 0,
    isGift: true
  };
}

describe('getOrderTableRows — tổng xét mốc MKT', () => {
  it('đơn 1 thùng + 1 thảm quà chỉ tính 1 thùng (quà không được cộng)', () => {
    const order = buildOrder([boughtBoxes(1), giftMat()]);
    const { campaignTotals } = uiRenderer.getOrderTableRows(order);
    assert.ok(campaignTotals.xvil, 'phải có totals cho campaign xvil');
    assert.equal(campaignTotals.xvil.boxes, 1, 'thảm quà (box_size=1) không được cộng thành 1 thùng');
  });

  it('đơn 1 thùng + 1 thảm quà KHÔNG sinh bình xịt (mốc 2 thùng)', () => {
    const order = buildOrder([boughtBoxes(1), giftMat()]);
    const { rows } = uiRenderer.getOrderTableRows(order);
    const dumped = JSON.stringify(rows);
    assert.ok(!dumped.includes('Bình xịt'), 'đơn 1 thùng thật không được đạt mốc 2 thùng');
    const mktRows = rows.filter(r => r.type === 'gift' && r.giftSource === 'MKT');
    assert.equal(mktRows.length, 1, 'chỉ còn quà mốc 1 thùng');
    assert.equal(mktRows[0].productId, 'xvil_mkt_tote_bag');
  });

  it('đơn 3 thùng thật đạt đúng mốc 3 thùng', () => {
    const order = buildOrder([boughtBoxes(3)]);
    const { rows } = uiRenderer.getOrderTableRows(order);
    const mktRows = rows.filter(r => r.type === 'gift' && r.giftSource === 'MKT');
    assert.equal(mktRows.length, 1);
    assert.equal(mktRows[0].productId, 'xvil_mkt_mat');
  });
});

describe('db.getMKTGifts — mốc thùng làm tròn xuống', () => {
  it('2.4 thùng (2 thùng + chai lẻ) đạt mốc 2 thùng, không rơi vào khoảng trống', () => {
    const rule = db.getMKTGifts('xvil', 0, 2.4);
    assert.ok(rule, '2.4 thùng phải trúng 1 mốc');
    assert.equal(rule.label, '2 thùng');
  });

  it('1.9 thùng vẫn chỉ đạt mốc 1 thùng', () => {
    assert.equal(db.getMKTGifts('xvil', 0, 1.9).label, '1 thùng');
  });

  it('dưới 1 thùng đầy (0.9) không đạt mốc nào', () => {
    assert.equal(db.getMKTGifts('xvil', 0, 0.9), null);
  });
});

describe('Dữ liệu promoRules XVIL (Promo v1.3.0) — cấu trúc đồng nhất', () => {
  const rules = (DEFAULT_DB.campaigns.xvil.promoRules || []).filter(r => r.type === 'total' && r.scope === 'campaign');

  it('mọi mốc đều có gifts liên kết sản phẩm thật trong danh mục', () => {
    assert.ok(rules.length > 0, 'phải có mốc tổng XVIL');
    for (const rule of rules) {
      assert.ok(Array.isArray(rule.gifts) && rule.gifts.length > 0,
        `mốc id "${rule.id}" thiếu gifts`);
      for (const g of rule.gifts) {
        assert.ok(g.productId && db.findProductById(g.productId),
          `mốc id "${rule.id}": quà "${g.productId}" chưa link sản phẩm danh mục`);
      }
    }
  });

  it('mốc "1 thùng" là quà chọn 1 trong N (túi canvas hoặc nón)', () => {
    const r1 = rules.find(r => r.threshold && r.threshold.min === 1 && r.threshold.max === 1);
    assert.ok(r1, 'phải có mốc 1 thùng');
    assert.deepEqual(r1.gifts[0].options,
      ['xvil_mkt_tote_bag', 'xvil_mkt_cap']);
  });

  it('các mốc phủ liên tục 1→5+ thùng (không hở khoảng)', () => {
    for (let boxes = 1; boxes <= 8; boxes++) {
      const rule = db.getMKTGifts('xvil', 0, boxes);
      assert.ok(rule, `${boxes} thùng phải trúng 1 mốc`);
    }
  });
});

describe('[Migration] migratePromoRules — dữ liệu đang lưu trong máy user', () => {
  it('nâng cấp rule legacy (mkt_gift_rules, foc_rules, promoTextRules) sang promoRules', () => {
    const legacyData = {
      campaigns: {
        xvil: {
          name: 'XVIL',
          products: [
            { id: 'xvil_xvil_r8000_rs_10w30_1l', name: 'R8000', unit: 'chai', box_size: 12, foc_rules: [{ buy_qty: 1, give_qty: 2, give_unit: 'chai', give_product: '', note: 'Mua 1 thùng tặng 2 chai' }] },
            { id: 'xvil_mkt_tote_bag', name: 'Túi canvas XVIL', unit: 'cái', box_size: 1 },
            { id: 'xvil_mkt_cap', name: 'Nón XVIL', unit: 'cái', box_size: 1 },
            { id: 'xvil_mkt_spray', name: 'Bình xịt XVIL', unit: 'cái', box_size: 1 }
          ],
          mkt_gift_rules: [
            { min_total: 1, max_total: 1, unit: 'boxes', label: '1 thùng', gift_items: [{ qty: 1, name: 'Túi canvas XVIL', product_id: 'xvil_mkt_tote_bag', give_product_options: ['xvil_mkt_tote_bag', 'xvil_mkt_cap'] }] },
            { min_total: 2, max_total: 2, unit: 'boxes', label: '2 thùng', gift_items: [{ qty: 1, name: 'Bình xịt XVIL', product_id: 'xvil_mkt_spray' }] }
          ],
          promoTextRules: []
        }
      }
    };
    const db2 = new ProductDatabase();
    db2.data = legacyData;
    assert.equal(db2._applyPromoMigration(), true, 'phải phát hiện và migrate rule legacy');
    assert.equal(db2.data.promoRulesVersion, 3);
    const totals = (db2.data.campaigns.xvil.promoRules || []).filter(r => r.type === 'total');
    const r1 = totals.find(r => r.threshold && r.threshold.min === 1 && r.threshold.max === 1);
    assert.equal(r1.gifts[0].productId, 'xvil_mkt_tote_bag');
    assert.deepEqual(r1.gifts[0].options, ['xvil_mkt_tote_bag', 'xvil_mkt_cap']);
    const r2 = totals.find(r => r.threshold && r.threshold.min === 2 && r.threshold.max === 2);
    assert.equal(r2.gifts[0].productId, 'xvil_mkt_spray');
  });

  it('dữ liệu đã promoRulesVersion >= 3 thì giữ nguyên (idempotent)', () => {
    const db3 = new ProductDatabase();
    db3.data = JSON.parse(JSON.stringify(DEFAULT_DB));
    assert.equal(db3._applyPromoMigration(), false, 'DB mới đã chuẩn → không đổi gì');
  });
});

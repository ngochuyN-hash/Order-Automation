/**
 * Regression tests — Đăng ký "chương trình KM dạng text" (campaign.promoTextRules)
 * Run: node --test test/promo-text-rules.test.mjs
 *
 * Bối cảnh: KM khách nhắn dạng text ("tặng nón XVIL", "FOC: 1 bình xịt"...) từng bị
 * fuzzy-match đoán mò hoặc rơi vào __unmatched_gift__ (không có kvCode → fail khi lên
 * KiotViet). Registry promoTextRules cho admin ánh xạ text → sản phẩm quà chuẩn hóa.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { db, DEFAULT_DB } from '../db.js';
db.data = JSON.parse(JSON.stringify(DEFAULT_DB));
globalThis.db = db; // parser.js/calculator.js đọc global `db`

const { processExplicitGift } = await import('../src/order/calculator.js');

const xvil = () => db.data.campaigns.xvil;
const zentor = () => db.data.campaigns.zentor;
const r8000 = () => db.findProductById('xvil_xvil_r8000_rs_10w30_1l');
const cap = () => db.findProductById('xvil_mkt_cap');
const tote = () => db.findProductById('xvil_mkt_tote_bag');

function makeRule(overrides = {}) {
  const pId = overrides.productId || tote().id;
  const defQty = overrides.defaultQty !== undefined ? overrides.defaultQty : 1;
  const r = {
    id: 'rule_test', type: 'text', kind: 'text', label: 'Nón XVIL',
    keywords: ['nón xvil', 'nón', 'mũ'],
    unitHint: '', defaultQty: defQty, global: false, enabled: true,
    gifts: overrides.gifts || [{ qty: defQty, productId: pId }],
    note: '', ...overrides
  };
  // Khớp getter tiện lợi: rule.productId
  if (!('productId' in r)) {
    Object.defineProperty(r, 'productId', {
      get() { return (this.gifts && this.gifts[0] && this.gifts[0].productId) || ''; },
      set(v) { if (this.gifts && this.gifts[0]) this.gifts[0].productId = v; }
    });
  }
  return r;
}

function seedRules(xvilRules, zentorRules = []) {
  db.data.campaigns.xvil.promoRules = xvilRules;
  db.data.campaigns.zentor.promoRules = zentorRules;
}

describe('db.getPromoTextMatch — match từ khóa', () => {
  it('khớp rule campaign khi tên quà chứa keyword (bỏ dấu cũng khớp)', () => {
    seedRules([makeRule({ label: 'Nón XVIL', productId: cap().id })]);
    const m = db.getPromoTextMatch('nón xvil màu trắng', 'cái', 'xvil');
    assert.ok(m, 'phải khớp rule');
    assert.equal(m.rule.productId, cap().id);
    assert.equal(m.product.id, cap().id);
  });

  it('khớp chiều ngược: keyword dài chứa tên quà ngắn ("nón")', () => {
    seedRules([makeRule({ label: 'Nón XVIL', productId: cap().id })]);
    const m = db.getPromoTextMatch('nón', 'cái', 'xvil');
    assert.ok(m, 'chiều keyword chứa name phải khớp');
    assert.equal(m.rule.productId, cap().id);
  });

  it('không khớp khi tên quà không liên quan keyword', () => {
    seedRules([makeRule({ label: 'Nón XVIL', productId: cap().id })]);
    assert.equal(db.getPromoTextMatch('bình xịt', 'bình', 'xvil'), null);
  });

  it('rule disabled hoặc thiếu keywords/productId bị bỏ qua', () => {
    seedRules([
      makeRule({ enabled: false }),
      makeRule({ keywords: [] }),
      makeRule({ productId: 'khong_ton_tai' })
    ]);
    assert.equal(db.getPromoTextMatch('nón', 'cái', 'xvil'), null);
  });
});

describe('db.getPromoTextMatch — unitHint & scope', () => {
  it('unitHint khác đơn vị quà → không khớp; trùng → khớp', () => {
    seedRules([makeRule({ unitHint: 'bình', keywords: ['bình xịt'], productId: tote().id })]);
    assert.equal(db.getPromoTextMatch('bình xịt', 'chai', 'xvil'), null);
    const m = db.getPromoTextMatch('bình xịt', 'bình', 'xvil');
    assert.ok(m);
    assert.equal(m.rule.productId, tote().id);
  });

  it('unitHint rỗng → chấp nhận mọi đơn vị', () => {
    seedRules([makeRule({ unitHint: '', keywords: ['bình xịt'], productId: tote().id })]);
    const m = db.getPromoTextMatch('bình xịt', 'chai', 'xvil');
    assert.ok(m);
  });

  it('rule global:true ở campaign khác áp dụng cho campaign đang hỏi', () => {
    seedRules([], [makeRule({ label: 'Nón global', global: true })]);
    const m = db.getPromoTextMatch('nón', 'cái', 'xvil');
    assert.ok(m, 'rule global phải áp dụng mọi campaign');
    assert.equal(m.rule.id, 'rule_test');
  });

  it('rule global:false ở campaign khác KHÔNG áp dụng cho campaign đang hỏi', () => {
    seedRules([], [makeRule({ label: 'Nón Zentor', global: false })]);
    assert.equal(db.getPromoTextMatch('nón', 'cái', 'xvil'), null,
      'rule không global chỉ có hiệu lực trong campaign của nó');
  });

  it('ưu tiên rule campaign cụ thể hơn rule global cùng keyword', () => {
    seedRules(
      [makeRule({ label: 'Nón XVIL riêng', productId: cap().id })],
      [makeRule({ label: 'Nón GLOBAL', global: true })]
    );
    const m = db.getPromoTextMatch('nón', 'cái', 'xvil');
    assert.ok(m);
    assert.equal(m.rule.label, 'Nón XVIL riêng');
  });
});

describe('processExplicitGift — áp dụng rule trước fuzzy', () => {
  it('khớp rule → productId chuẩn + note "Khớp chương trình KM" + _promoRuleId', () => {
    seedRules([makeRule({ label: 'Nón XVIL', productId: cap().id })]);
    const result = processExplicitGift({ qty: 1, name: 'nón xvil đen', unit: 'cái' }, r8000(), []);
    assert.equal(result.give_product, cap().id);
    assert.match(result.note, /Khớp chương trình KM/);
    assert.equal(result._promoRuleId, 'rule_test');
  });

  it('không khớp rule → hành vi cũ (fallback fuzzy / __unmatched_gift__)', () => {
    seedRules([makeRule({ label: 'Nón XVIL', productId: cap().id })]);
    const result = processExplicitGift({ qty: 2, name: 'quà bí ẩn không tồn tại zzz', unit: 'cái' }, r8000(), []);
    assert.equal(result.give_product, '__unmatched_gift__');
    assert.match(result.note, /Sản phẩm tặng không có trong DB/);
    assert.ok(!result._promoRuleId);
  });

  it('rule global từ campaign khác resolve quà qua processExplicitGift', () => {
    seedRules([], [makeRule({ label: 'Nón chung', global: true, productId: cap().id })]);
    const result = processExplicitGift({ qty: 1, name: 'nón xvil', unit: 'cái' }, r8000(), []);
    assert.equal(result.give_product, cap().id);
    assert.match(result.note, /Khớp chương trình KM/);
  });

  it('rule bị lệch productId (SP đã xóa) → fallback về __unmatched_gift__', () => {
    seedRules([makeRule({ productId: 'sp_da_xoa' })]);
    const result = processExplicitGift({ qty: 1, name: 'quà bí ẩn không tồn tại zzz', unit: 'cái' }, r8000(), []);
    assert.equal(result.give_product, '__unmatched_gift__');
  });
});
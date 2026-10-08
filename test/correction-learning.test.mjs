/**
 * Regression tests — Sửa tay SP bị nhận diện sai → tự học alias → lần sau khớp đúng
 * Run: node --test test/correction-learning.test.mjs
 *
 * Bối cảnh: đơn "2 chai Fork 10 giá 228k" bị nhận diện nhầm; user sửa tay trên
 * bảng đơn (combobox) chọn lại đúng SP → cú sửa tay PHẢI được học thành alias
 * ("tên sales gõ" → SP user chọn) và alias đó ưu tiên cao nhất lần parse sau.
 * Đặc biệt: dòng CHƯA KHỚP (vàng) lưu tên ở rawName — sửa tay cũng phải học được.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Stub DOM tối thiểu cho ui-renderer (showToast v.v.) trong Node
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => ({
      style: {}, setAttribute: () => {}, getAttribute: () => null,
      addEventListener: () => {}, appendChild: () => {}, remove: () => {},
      classList: { add: () => {}, remove: () => {}, contains: () => false }
    }),
    body: { appendChild: () => {} }
  };
}
if (typeof globalThis.localStorage === 'undefined') {
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => {} };
}
if (typeof globalThis.requestAnimationFrame === 'undefined') {
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
}

import { db, DEFAULT_DB } from '../db.js';
db.data = JSON.parse(JSON.stringify(DEFAULT_DB));
db.customAliases = {};
db.removedDefaultAliases = {};
db._bumpDataVersion();
globalThis.db = db;

const { store } = await import('../store.js');
const { changeRowProduct } = await import('../src/order/actions.js');
const { parseOrderText, findBestProductMatch } = await import('../parser.js');

const zntForkId = 'znt_mxo_topgear_gp_fork_oil_10w';
const xvilForkId = 'xvil_xvil_fork_10_1l_binh';

function seedOrder(items) {
  store.setState({
    currentOrder: {
      customer: '7C motor', payment: 'ck', items,
      customPromos: [], giftOverrides: {}, giftDeleted: {}, giftQtyOverrides: {},
      rowOrder: null, rawChatText: '', salesComment: '', tlnLines: null
    }
  });
}

after(() => {
  // dọn alias đã học để không ảnh hưởng test khác (mỗi file chạy 1 process riêng)
  db.customAliases = {};
  db._bumpDataVersion();
});

describe('Sửa tay trên bảng đơn → học alias', () => {
  it('dòng match NHẦM (Fork 10brand A): user chọn lại brand B → học "Fork 10" → brand B', () => {
    seedOrder([{
      rawProduct: 'Fork 10', qty: 2, unit: 'chai',
      product: db.findProductById(xvilForkId),
      unitPrice: 170000, subtotal: 340000, foc: null, tierLabel: '',
      manualPrice: null, isGift: false, matchScore: 100, matchVia: 'fuzzy'
    }]);
    changeRowProduct(0, zntForkId);
    assert.equal(db.getAliases()['fork 10'], zntForkId, 'cú sửa tay phải được học thành alias');
  });

  it('dòng CHƯA KHỚP (tên ở rawName): user chọn SP → cũng phải học được', () => {
    seedOrder([{
      rawName: 'Fork 10', rawProduct: undefined, qty: 2, unit: 'chai',
      product: null, unitPrice: 0, subtotal: 0, foc: null, tierLabel: '',
      manualPrice: null, isGift: false, matchScore: 0
    }]);
    changeRowProduct(0, zntForkId);
    assert.equal(db.getAliases()['fork 10'], zntForkId, 'sửa dòng vàng (rawName) phải học alias');
  });

  it('lần parse SAU: alias học được thắng mọi tín hiệu (ưu tiên cao nhất sau mã KV)', () => {
    const products = db.getAllProducts();
    const aliases = db.getAliases();
    // Match trực tiếp: "Fork 10" giờ phải ra Zentor qua alias, kể cả không có giá
    const m = findBestProductMatch('Fork 10', products, aliases, 'chai');
    assert.equal(m.via, 'alias');
    assert.equal(m.product.id, zntForkId);
    // Và qua parseOrderText đầy đủ (như tin nhắn sales thật)
    const r = parseOrderText('7C motor\n2 chai Fork 10 giá 228k\nTT CK', products, aliases);
    const line = r.lines.find(l => l.type === 'matched');
    assert.equal(line.data.matchedProduct.id, zntForkId);
    // Người dùng không ghi giá cũng ra đúng SP (alias không cần giá để phân xử)
    const r2 = parseOrderText('7C motor\n2 chai Fork 10\nTT CK', products, aliases);
    const line2 = r2.lines.find(l => l.type === 'matched');
    assert.equal(line2.data.matchedProduct.id, zntForkId);
  });

  it('chọn lại ĐÚNG SP đang chọn không sinh alias rác', () => {
    db.customAliases = {};
    db._bumpDataVersion();
    seedOrder([{
      rawProduct: 'Zentor GP Fork Oil 10W', qty: 1, unit: 'chai',
      product: db.findProductById(zntForkId),
      unitPrice: 225000, subtotal: 225000, foc: null, tierLabel: '',
      manualPrice: null, isGift: false, matchScore: 100, matchVia: 'fuzzy'
    }]);
    changeRowProduct(0, zntForkId); // cùng SP → không phải correction, cũng không weak
    assert.equal(db.getAliases()['zentor gp fork oil 10w'], undefined, 'không học khi không có correction');
  });
});

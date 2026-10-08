/**
 * Regression tests — Migration seed bảng giá theo priceVersion
 * Run: node --test test/price-seed-migration.test.mjs
 *
 * Bối cảnh: init() ưu tiên db đã lưu trong IndexedDB của từng máy — máy cũ cài đè
 * bộ cài mới sẽ KHÔNG thấy giá/khuyến mãi mới nếu không có bước seed theo
 * DEFAULT_DB.priceVersion. Test phủ: seed giá + mkt_gift_rules, giữ nguyên kvCode
 * sửa tay + sản phẩm user tự thêm, bổ sung SP mới từ seed, bỏ qua khi version khớp.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { db, DEFAULT_DB } from '../db.js';

const TARGET = DEFAULT_DB.priceVersion;
assert.ok(TARGET, 'DEFAULT_DB.priceVersion phải được khai báo');

/** Clone db mẫu từ seed rồi "già hóa" thành db máy cũ */
function buildOldDb() {
  const old = JSON.parse(JSON.stringify(DEFAULT_DB));
  delete old.priceVersion;
  const furvex18 = old.campaigns.torvex.products.find(p => p.id === 'tvx_furvex_15w40_ci4_18');
  furvex18.tiers[0].price = 1400000; // giá cũ trước 9/2026
  // kvCode user đã sửa tay trên máy (bất biến #2 — seed KHÔNG được đụng)
  furvex18.kvCode = 'USER_EDIT_01';
  // SP user tự thêm ngoài catalog — seed KHÔNG được xóa
  old.campaigns.torvex.products.push({
    id: 'custom_user_product_test', kvCode: 'X01', name: 'SP user tự thêm',
    spec: '', packaging: '', unit: 'cái', box_size: 1, tiers: [{ min_qty: 1, max_qty: 9999, price: 12345, label: 'Tất cả' }]
  });
  // db cũ còn chính sách MKT cũ: thêm rule quà DD súc rửa giả lập cho 10W30 vào promoRules (đã gỡ khỏi seed 9/2026)
  old.campaigns.torvex.promoRules = old.campaigns.torvex.promoRules || [];
  old.campaigns.torvex.promoRules.push({
    id: 'old_cleaner_rule', type: 'qty', scope: 'product', enabled: true, kind: 'mkt_pp',
    productId: 'torvex_furox_4t_10w30',
    buy: { qty: 1, unit: 'chai' },
    gifts: [{ qty: 1, productId: 'veltron_veltron_engine_cleaner_shot', unit: 'chai' }],
    note: 'Mua 1 chai tặng 1 chai DD súc rửa'
  });
  // db cũ thiếu 1 SP có trong seed → seed phải bổ sung
  old.campaigns.torvex.products = old.campaigns.torvex.products.filter(p => p.id !== 'torvex_gear_oil');
  return old;
}

describe('price seed migration (_applyPriceSeedMigration)', () => {
  it('db cũ không có priceVersion → seed giá mới + chính sách MKT mới, trả true', () => {
    db.data = buildOldDb();
    const changed = db._applyPriceSeedMigration();
    assert.equal(changed, true);
    assert.equal(db.data.priceVersion, TARGET);
    // Giá FURVEX 15W40 CI-4 xô được seed theo bảng 9/2026
    const furvex18 = db.data.campaigns.torvex.products.find(p => p.id === 'tvx_furvex_15w40_ci4_18');
    assert.equal(furvex18.tiers[0].price, DEFAULT_DB.campaigns.torvex.products.find(p => p.id === 'tvx_furvex_15w40_ci4_18').tiers[0].price);
    assert.notEqual(furvex18.tiers[0].price, 1400000, 'giá cũ phải bị thay');
  });

  it('kvCode sửa tay trên máy KHÔNG bị seed ghi đè (bất biến #2)', () => {
    db.data = buildOldDb();
    db._applyPriceSeedMigration();
    const furvex18 = db.data.campaigns.torvex.products.find(p => p.id === 'tvx_furvex_15w40_ci4_18');
    assert.equal(furvex18.kvCode, 'USER_EDIT_01');
  });

  it('sản phẩm user tự thêm ngoài catalog KHÔNG bị xóa', () => {
    db.data = buildOldDb();
    db._applyPriceSeedMigration();
    const custom = db.data.campaigns.torvex.products.find(p => p.id === 'custom_user_product_test');
    assert.ok(custom, 'SP user phải còn nguyên');
    assert.equal(custom.tiers[0].price, 12345);
  });

  it('chính sách MKT cũ trên máy được đè bằng seed (10W30 không có rule quà DD súc rửa)', () => {
    db.data = buildOldDb();
    db._applyPriceSeedMigration();
    const torvexRules = db.data.campaigns.torvex.promoRules || [];
    const w30Cleaner = torvexRules.find(r => r.productId === 'torvex_furox_4t_10w30' && (r.note || '').includes('DD súc rửa'));
    assert.ok(!w30Cleaner || !w30Cleaner.gifts.some(g => (g.productId || '').includes('cleaner')), '10W30 không có rule cleaner trong seed');
    // 10W50 vẫn giữ rule quà DD súc rửa (có trong promoRules của torvex)
    const w50Cleaner = torvexRules.find(r => r.productId === 'torvex_furox_4t_10w50' && (r.note || '').includes('DD súc rửa'));
    assert.ok(w50Cleaner, '10W50 phải còn rule quà DD súc rửa/dưỡng sên');
    assert.equal(w50Cleaner.buy.unit, 'chai');
  });

  it('SP có trong seed mà máy thiếu → được bổ sung', () => {
    db.data = buildOldDb();
    db._applyPriceSeedMigration();
    const gearOil = db.data.campaigns.torvex.products.find(p => p.id === 'torvex_gear_oil');
    assert.ok(gearOil, 'torvex_gear_oil phải được bổ sung từ seed');
  });

  it('db đã có priceVersion hiện hành → KHÔNG seed, không đổi gì', () => {
    const fresh = JSON.parse(JSON.stringify(DEFAULT_DB));
    const before = JSON.stringify(fresh);
    db.data = fresh;
    const changed = db._applyPriceSeedMigration();
    assert.equal(changed, false);
    assert.equal(JSON.stringify(db.data), before, 'db không được bị sửa khi version khớp');
  });
});

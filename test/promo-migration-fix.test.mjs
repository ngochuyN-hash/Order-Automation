/**
 * Regression tests — v1.3.3: migration/seed KHÔNG được ghi đè chỉnh sửa user.
 *
 * Bug gốc: _ensureZentorMktRulesSynced() chạy MỖI boot không gated — user
 * bớt/thêm sản phẩm-quà trong CTKM Zentor là boot sau bị reset nguyên bộ total
 * rules về seed DEFAULT_DB. Đã chuyển thành _applyZentorMktFix() gated 1 lần
 * (zntMktFixedVersion). Kèm: price-seed chạy SAU promo-migration và chỉ thay
 * rule qty theo SP catalog seed (giữ total/text user).
 * Run: node --test test/promo-migration-fix.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Stub môi trường browser TRƯỚC khi import (db-store fallback localStorage)
const memStorage = new Map();
globalThis.localStorage = {
  getItem: (k) => (memStorage.has(k) ? memStorage.get(k) : null),
  setItem: (k, v) => memStorage.set(k, String(v)),
  removeItem: (k) => memStorage.delete(k),
};
globalThis.window = { indexedDB: undefined };

const { ProductDatabase, DEFAULT_DB, DB_BACKUP_KEY, parsePackagingQty } = await import('../db.js');
const { dbStore } = await import('../db-store.js');

/** DB mới nhái: schema mới nhưng priceVersion cũ → price-seed có thể kích hoạt. */
function freshDb() {
  const data = JSON.parse(JSON.stringify(DEFAULT_DB));
  data.priceVersion = '1990.01'; // khác DEFAULT_DB.priceVersion
  data.promoRulesVersion = 3;
  return data;
}

describe('Zentor MKT fix — gated 1 lần (v1.3.3)', () => {
  it('thiếu gift chuẩn → thay bằng seed ĐÚNG 1 lần + set flag', () => {
    const inst = new ProductDatabase();
    inst.data = freshDb();
    // Bóp: bỏ znt_mkt_cap (quà Nón) khỏi mọi rule total của Zentor — kiểu user "bớt quà trong CTKM"
    for (const r of inst.data.campaigns.zentor.promoRules) {
      if (r.type === 'total' && r.scope === 'campaign') {
        r.gifts = r.gifts.filter(g => g.productId !== 'znt_mkt_cap');
      }
    }
    const changed = inst._applyZentorMktFix();
    assert.equal(changed, true, 'pass rà soát lần đầu phải chạy');
    assert.equal(inst.data.zntMktFixedVersion, 1);
    const totalRules = inst.data.campaigns.zentor.promoRules.filter(r => r.type === 'total' && r.scope === 'campaign');
    assert.ok(totalRules.length > 0);
    assert.ok(JSON.stringify(totalRules).includes('znt_mkt_cap'), 'seed phải khôi phục quà Nón');
  });

  it('sau khi flag set — mọi chỉnh sửa user ĐƯỢC GIỮ, không reset về seed', () => {
    const inst = new ProductDatabase();
    inst.data = freshDb();
    inst.data.zntMktFixedVersion = 1; // đã qua lần rà đầu của 1.3.3
    const znt = inst.data.campaigns.zentor;
    // user chủ động GỠ HẾT mốc total Zentor
    znt.promoRules = znt.promoRules.filter(r => !(r.type === 'total' && r.scope === 'campaign'));
    const changed = inst._applyZentorMktFix();
    assert.equal(changed, false, 'no-op khi flag đã set');
    const totalRules = znt.promoRules.filter(r => r.type === 'total' && r.scope === 'campaign');
    assert.equal(totalRules.length, 0, 'rule user đã bỏ KHÔNG được hồi sinh từ seed');
  });
});

describe('Price-seed chạy sau promo-migration (v1.3.3)', () => {
  it('không trùng rule + giữ rule total/text của user', () => {
    const inst = new ProductDatabase();
    const data = JSON.parse(JSON.stringify(DEFAULT_DB));
    data.priceVersion = '1990.01';
    data.promoRulesVersion = 0; // chưa từng migrate
    const znt = data.campaigns.zentor;
    const target = znt.products.find(p => p.id === 'znt_mxo_topgear_gp_ester_5w40');

    // Data v1.2.x: zentor chưa có promoRules (field cũ) + 1 rule text do user đăng ký
    znt.promoRules = [];
    target.foc_rules = [{ buy_qty: 4, buy_unit: 'thùng', give_qty: 1, give_product: 'znt_mkt_keyring', note: '' }];
    znt.mkt_gift_rules = [{
      min_total: 1000000, max_total: 0, unit: 'money',
      gift_items: [{ name: 'Móc khóa Zentor', give_product: 'znt_mkt_keyring', give_qty: 1 }]
    }];
    znt.promoTextRules = [{
      keywords: ['tặng túi rút'], unitHint: '', productId: 'znt_mkt_stringbag', defaultQty: 1
    }];

    // Thứ tự đúng (v1.3.3): migrate TRƯỚC, seed SAU
    inst.data = data;
    assert.equal(inst._applyPromoMigration(), true);
    assert.equal(inst._applyPriceSeedMigration(), true);

    const rules = znt.promoRules;
    assert.ok(rules.some(r => r.type === 'text'), 'rule text của user phải còn sau price-seed');
    assert.ok(rules.some(r => r.type === 'total' && r.scope === 'campaign'), 'rule total campaign phải còn');
    assert.ok(
      rules.some(r => r.type === 'qty' && r.productId === 'znt_mxo_topgear_gp_ester_5w40'),
      'rule qty của SP phải còn (seed hoặc migrate)'
    );
    const qtyRules = rules.filter(r => r.type === 'qty' && r.scope === 'product');
    const qtyPids = qtyRules.map(r => r.productId);
    assert.equal(new Set(qtyPids).size, qtyPids.length, 'mỗi SP chỉ có 1 rule qty — không trùng do migrate+seed');
    assert.equal(znt.mkt_gift_rules, undefined, 'field cũ phải bị gỡ');
    assert.equal(znt.promoTextRules, undefined, 'field cũ phải bị gỡ');
    assert.equal(target.foc_rules, undefined, 'field cũ phải bị gỡ');
    assert.equal(data.promoRulesVersion, 3);
    assert.equal(data.priceVersion, DEFAULT_DB.priceVersion, 'price-seed phải cập nhật priceVersion');
  });
});

describe('Packing box_size sync gated 1 lần (v1.3.4 + pass V2 v1.4.2)', () => {
  it('lần đầu: lệch packaging → ép box_size + đánh cờ', () => {
    const inst = new ProductDatabase();
    const data = JSON.parse(JSON.stringify(DEFAULT_DB));
    const p = data.campaigns.zentor.products.find(x => x.id === 'znt_mxo_topgear_gp_ester_5w40');
    p.packaging = '4 Kit/Thùng';
    p.box_size = 12; // lệch — như bug Chain Care Kit cũ
    inst.data = data;
    const changed = inst.ensurePackingConsistency();
    assert.equal(changed, true, 'lần đầu phải chạy pass + đánh cờ');
    assert.equal(data._packingFixedV1, true);
    const after = data.campaigns.zentor.products.find(x => x.id === 'znt_mxo_topgear_gp_ester_5w40');
    assert.equal(after.box_size, 4, 'phải ép box_size theo packaging');
  });

  it('sau đủ cả 2 cờ (V1+V2): user sửa tay box_size KHÔNG bị ép lại', () => {
    const inst = new ProductDatabase();
    const data = JSON.parse(JSON.stringify(DEFAULT_DB));
    data._packingFixedV1 = true; // đã qua pass v1.3.4
    data._packingFixedV2 = true; // đã qua pass v1.4.2
    const p = data.campaigns.zentor.products.find(x => x.id === 'znt_mxo_topgear_gp_ester_5w40');
    p.packaging = '4 Kit/Thùng';
    p.box_size = 12; // user sửa tay (đóng gói thực tế lệch chuỗi text)
    inst.data = data;
    const changed = inst.ensurePackingConsistency();
    assert.equal(changed, false);
    assert.equal(p.box_size, 12, 'giá trị user sửa phải giữ nguyên, không ép về 4');
  });

  it('pass V2 (v1.4.2): chỉ có cờ V1 → ép lại ĐÚNG 1 LẦN theo packaging cho SP lệch', () => {
    const inst = new ProductDatabase();
    const data = JSON.parse(JSON.stringify(DEFAULT_DB));
    data._packingFixedV1 = true; // máy thật: pass v1.3.4 đã chạy rồi
    const p = data.campaigns.zentor.products.find(x => x.id === 'znt_mxo_topgear_gp_ester_5w40');
    p.packaging = '4 Kit/Thùng';
    p.box_size = 12; // lệch — SP thêm/sửa text sau khi V1 chạy, chưa từng được đồng bộ
    inst.data = data;
    const changed = inst.ensurePackingConsistency();
    assert.equal(changed, true, 'pass V2 phải chạy và đánh cờ');
    assert.equal(data._packingFixedV2, true);
    assert.equal(p.box_size, 4, 'V2 ép box_size theo text packaging');
  });

  it('pass V2 chỉ chạy ĐÚNG 1 LẦN: lần gọi kế user sửa tay thì giữ nguyên', () => {
    const inst = new ProductDatabase();
    const data = JSON.parse(JSON.stringify(DEFAULT_DB));
    data._packingFixedV1 = true;
    const p = data.campaigns.zentor.products.find(x => x.id === 'znt_mxo_topgear_gp_ester_5w40');
    p.packaging = '4 Kit/Thùng';
    p.box_size = 12;
    inst.data = data;
    inst.ensurePackingConsistency(); // V2 chạy lần đầu → ép về 4
    assert.equal(p.box_size, 4);
    p.box_size = 6; // user sửa tay sau pass V2
    const changed2 = inst.ensurePackingConsistency();
    assert.equal(changed2, false, 'V2 đã có cờ → không chạy nữa');
    assert.equal(p.box_size, 6, 'sửa tay sau V2 phải được tôn trọng');
  });

  it('packaging không parse được số → box_size giữ nguyên qua pass V2', () => {
    const inst = new ProductDatabase();
    const data = JSON.parse(JSON.stringify(DEFAULT_DB));
    data._packingFixedV1 = true;
    const p = data.campaigns.zentor.products.find(x => x.id === 'znt_mxo_topgear_gp_ester_5w40');
    p.packaging = 'Cái'; // không có số lượng/thùng trong text
    p.box_size = 3;
    inst.data = data;
    inst.ensurePackingConsistency();
    assert.equal(p.box_size, 3, 'không có số trong text thì không đụng box_size');
  });

  it('REGRESSION: số thập phân trong text KHÔNG bị đọc là số lượng ("10 bình x 1,5 lít" → 10)', () => {
    // Trước fix: "x 1" trong "1,5 lít" bị bắt → ép box_size 10 → 1 (sai nghịch 10 lần)
    assert.equal(parsePackagingQty('10 bình x 1,5 lít'), 10);
    assert.equal(parsePackagingQty('12 bình x 0,5 lít'), 12);
    assert.equal(parsePackagingQty('400ml x 12 chai'), 12);
    assert.equal(parsePackagingQty('1 hộp x 12 cái'), 12);
    assert.equal(parsePackagingQty('4 Kit/ Thùng'), 4);
    assert.equal(parsePackagingQty('Cái'), null);
  });
});

describe('Snapshot trước migration (v1.3.3)', () => {
  it('rolling giữ 3 bản, deep-clone, giữ nguyên trạng dữ liệu', async () => {
    await dbStore.remove(DB_BACKUP_KEY); // sạch trạng thái test
    const inst = new ProductDatabase();
    const data = freshDb();
    data.campaigns.xvil.promoRules.push({ id: 'user_added_rule_x', type: 'text', keywords: ['test'] });
    for (let i = 0; i < 5; i++) await inst._snapshotPreMigrationBackups(data);
    const list = await dbStore.get(DB_BACKUP_KEY);
    assert.ok(Array.isArray(list));
    assert.equal(list.length, 3, 'chỉ giữ 3 bản gần nhất');
    assert.ok(
      list[list.length - 1].data.campaigns.xvil.promoRules.some(r => r.id === 'user_added_rule_x'),
      'snapshot giữ nguyên trạng dữ liệu (kể cả rule mới thêm)'
    );
    assert.notStrictEqual(list[0].data, list[1].data, 'mỗi snapshot là bản deep-clone riêng');
    await dbStore.remove(DB_BACKUP_KEY);
  });
});
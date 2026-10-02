/**
 * Regression tests — Phân biệt brand trùng tên gọi bằng GIÁ + tên khách bắt đầu bằng số
 * Run: node --test test/price-disambiguation.test.mjs
 *
 * Bối cảnh: đơn "7C motor — 2 chai Fork 10 giá 228k" từng ra nhầm hàng XVIL
 * (Xvil Fork 10, giá list 173k) vì tên khớp chính xác 100%; đúng ra phải là
 * Fork Oil 10W (giá list khớp giá sales báo — đọc động từ catalog).
 * Đồng thời "7C motor" (tên khách bắt đầu bằng số) từng bị bỏ qua thay vì
 * nhận thành tên khách.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { db, DEFAULT_DB } from '../db.js';
db.data = JSON.parse(JSON.stringify(DEFAULT_DB));
globalThis.db = db; // parser.js đọc global `db` (getPriceForQty/getKvCode)

const { parseOrderText, findBestProductMatch, priceHintMatches } = await import('../parser.js');
const { processExplicitGift } = await import('../src/order/calculator.js');

const products = db.getAllProducts();
const aliases = db.getAliases();
const xvilFork = () => db.findProductById('xvil_xvil_fork_10_1l_binh');
const zntFork = () => db.findProductById('znt_mxo_topgear_gp_fork_oil_10w');
const zntForkPrice = () => zntFork().tiers[0].price; // giá list thật, đọc động khỏi hardcode

describe('priceHintMatches — so giá sales khai với giá list', () => {
  it('GP Fork Oil 10W khớp giá list, Fork 10 (bản brand khác, giá khác) lệch rõ', () => {
    assert.equal(priceHintMatches(zntFork(), zntForkPrice()), true);
    assert.equal(priceHintMatches(xvilFork(), zntForkPrice()), false);
  });

  it('trung tính khi không có giá tham chiếu hoặc giá không khớp ứng viên nào', () => {
    assert.equal(priceHintMatches(zntFork(), 0), null);
    assert.equal(priceHintMatches(null, 999000), null);
    // Giá sales tự khai (KM/giá riêng) không khớp ai → trung tính, không phạt
    assert.equal(priceHintMatches(zntFork(), 200000), null);
  });

  it('chấp nhận giá báo theo THÙNG (ref × box_size)', () => {
    // Zentor fork: unit chai, box 12 → giá thùng = 228k × 12 = 2.7tr
    assert.equal(priceHintMatches(zntFork(), 2700000), true);
  });
});

describe('findBestProductMatch — giá phân biệt 2 brand trùng tên gọi', () => {
  it('không có giá: tên khớp chính xác thắng (bản Fork 10 cùng tên gọi)', () => {
    const m = findBestProductMatch('Fork 10', products, aliases);
    assert.equal(m.product.id, 'xvil_xvil_fork_10_1l_binh');
  });

  it('có giá 228k: Zentor thắng dù tên dài hơn (đơn vị chai cũng khớp)', () => {
    const m = findBestProductMatch('Fork 10', products, aliases, 'chai', zntForkPrice());
    assert.equal(m.product.id, 'znt_mxo_topgear_gp_fork_oil_10w');
  });

  it('gần giá hơn thắng: giá 240k (gần 228k hơn 173k) → Zentor thắng cả khi không có unit hint', () => {
    const m = findBestProductMatch('Fork 10', products, aliases, null, 240000);
    assert.equal(m.product.id, 'znt_mxo_topgear_gp_fork_oil_10w');
  });

  it('giá khớp chính xác luôn thắng ứng viên lệch giá (không cần unit hint)', () => {
    const m = findBestProductMatch('Fork 10', products, aliases, null, zntForkPrice());
    assert.equal(m.product.id, 'znt_mxo_topgear_gp_fork_oil_10w');
  });

  it('giá không gần ứng viên nào (giá riêng 199k lệch cả 2) → thứ hạng tên giữ nguyên', () => {
    const m = findBestProductMatch('Fork 10', products, aliases, null, 199000);
    assert.equal(m.product.id, 'xvil_xvil_fork_10_1l_binh');
  });
});

describe('parseOrderText — đơn "7C motor" end-to-end', () => {
  const text = `7C motor
2 chai Fork 10 giá 228k
TT CK
HĐ cập nhật`;
  const r = parseOrderText(text, products, aliases);

  it('dòng đầu bắt đầu bằng số vẫn là TÊN KHÁCH', () => {
    assert.equal(r.customerDetected, '7C motor');
    assert.equal(r.lines[0].type, 'customer');
  });

  it('Fork 10 về Zentor (giá 228k khớp list), đúng giá sales khai', () => {
    const fork = r.lines.find(l => l.type === 'matched');
    assert.ok(fork, 'phải có dòng matched');
    assert.equal(fork.data.matchedProduct.id, 'znt_mxo_topgear_gp_fork_oil_10w');
    assert.equal(fork.data.qty, 2);
    assert.equal(fork.data.unit, 'chai');
    assert.equal(fork.data.explicitPrice, zntForkPrice());
  });
});

describe('Veltron Engine cleaner — hint "chai" phải ra bản bán theo chai (đơn Nam Thành 04/9)', () => {
  const shotId = 'veltron_veltron_engine_cleaner_shot';       // unit bình (0,1L)
  const proId = 'veltron_veltron_professional_engine_cleaner'; // unit chai (0,4L)

  it('hint chai: alias "engine cleaner" trúng bản bình vẫn bị fuzzy đúng đơn vị lật', () => {
    const m = findBestProductMatch('Veltron Engine cleaner', products, aliases, 'chai');
    assert.equal(m.product.id, proId);
    assert.ok(m.score >= 95, `Fuzzy phải ≥ điểm alias (95) mới được lật, got ${m.score}`);
  });

  it('không hint: alias "engine cleaner" giữ nguyên bản shot (bất biến alias)', () => {
    const m = findBestProductMatch('Veltron Engine cleaner', products, aliases);
    assert.equal(m.product.id, shotId);
  });

  it('gọi đích danh "Engine cleaner shot" vẫn ra bản shot dù hint chai', () => {
    const m = findBestProductMatch('Engine cleaner shot', products, aliases, 'chai');
    assert.equal(m.product.id, shotId);
  });

  it('processExplicitGift truyền unit hint → quà "Veltron Engine cleaner"/chai ra đúng bản Professional', () => {
    const parent = db.findProductById('znt_mxo_prostream_tt_ester_10w50_20l');
    const g = processExplicitGift({ qty: 6, name: 'Veltron Engine cleaner', unit: 'chai' }, parent, []);
    assert.equal(g.give_product, proId);
    assert.equal(g.give_unit, 'chai');
  });

  it('quà generic cùng campaign ("móc khóa" Torvex) vẫn ưu tiên campaign khi điểm không thua', () => {
    const parentTorvex = db.getAllProducts().find(p => p.campaignKey === 'torvex');
    const g = processExplicitGift({ qty: 1, name: 'móc khóa', unit: 'cái' }, parentTorvex, []);
    assert.ok(g && g.give_product.includes('torvex'), `Quà generic phải ưu tiên cùng campaign, got ${g && g.give_product}`);
  });
});

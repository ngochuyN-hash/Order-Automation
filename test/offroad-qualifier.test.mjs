/**
 * Off-road qualifier — không nhầm Chain Lube bản trắng (bug thật 24/9/2026).
 * Run: node --test test/offroad-qualifier.test.mjs
 *
 * 3 dạng tin sales ghi rõ "off road" nhưng bị đẩy sang bản trắng:
 *   1. Thứ tự đảo: "off road chain lube zentor"
 *   2. Dấu phẩy:   "chain lube, loại off road, zentor"
 *   3. Xuống dòng:  "2 thùng chain lube" / "off road zentor" (offline)
 * Nguyên nhân: alias so chuỗi liên tục theo thứ tự từ — cụm đảo/dính phẩy
 * không khớp alias "chain lube off road" nhưng vẫn match trọn alias trần
 * "chain lube" (95-100đ) của bản trắng.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findBestProductMatch,
  parseOrderText,
  buildShortlist,
  hasAttributeConflict,
} from '../parser.js';

function makeCatalog() {
  const products = [
    { id: 'znt_mxo_topgear_gp_chain_lube_trang', name: 'Zentor Topgear GP Chain Lube (0,4L/chai)', spec: 'Chăm sóc xe', packaging: '400ml x 12 chai', unit: 'chai', box_size: 12, tiers: [{ min_qty: 1, max_qty: 9999, price: 201017 }], foc_rules: [] },
    { id: 'znt_mxo_topgear_gp_chain_lube_off_road', name: 'Zentor Topgear CP Chain Lube Off Road (0,4L/bình)', spec: 'Chăm sóc xe', packaging: '400ml x 12 chai', unit: 'chai', box_size: 12, tiers: [{ min_qty: 1, max_qty: 9999, price: 205017 }], foc_rules: [] },
    { id: 'znt_mxo_topgear_gp_chain_lube_max', name: 'Zentor Topgear GP Chain Lube Max (0,4L/chai)', spec: 'Chăm sóc xe', packaging: '400ml x 12 chai', unit: 'chai', box_size: 12, tiers: [{ min_qty: 1, max_qty: 9999, price: 205017 }], foc_rules: [] },
    { id: 'xvil_xvil_xtorq_chain_road_0_75l_binh', name: 'Xvil Xtorq Chain Road (0,75L/bình)', spec: '0,75L', packaging: '12 bình x 0,75 lít', unit: 'thùng', box_size: 12, tiers: [{ min_qty: 1, max_qty: 9999, price: 300017 }], foc_rules: [] },
    { id: 'xvil_xvil_xtorq_chain_offroad_750ml', name: 'Xvil Xtorq Chain Off Road (0,75L/bình)', spec: '750mL', packaging: '0.75 x 12 can/thùng', unit: 'can', box_size: 12, tiers: [{ min_qty: 1, max_qty: 9999, price: 132017 }], foc_rules: [] },
  ];
  // Alias đúng như máy thật: alias trần "chain lube" do correction-learning
  // học về bản trắng + alias mặc định phân biệt biến thể.
  const aliases = {
    'chain lube': 'znt_mxo_topgear_gp_chain_lube_trang',
    'chain lube trang': 'znt_mxo_topgear_gp_chain_lube_trang',
    'chain lube off road': 'znt_mxo_topgear_gp_chain_lube_off_road',
    'chain off road': 'znt_mxo_topgear_gp_chain_lube_off_road',
    'chain lube max': 'znt_mxo_topgear_gp_chain_lube_max',
    'xvil xtorq chain road': 'xvil_xvil_xtorq_chain_road_0_75l_binh',
    'xtorq chain offroad': 'xvil_xvil_xtorq_chain_offroad_750ml',
  };
  return { products, aliases };
}

describe('hasAttributeConflict — qualifier "off road"', () => {
  const { products } = makeCatalog();
  const trang = products[0];
  const offRoad = products[1];

  it('input có "off road" mà SP không có → conflict', () => {
    assert.equal(hasAttributeConflict('chain lube off road', trang), true);
    assert.equal(hasAttributeConflict('off road chain lube', trang), true);
    assert.equal(hasAttributeConflict('chain lube offroad', trang), true);
  });

  it('input và SP đều có "off road" → không conflict', () => {
    assert.equal(hasAttributeConflict('chain lube off road', offRoad), false);
    assert.equal(hasAttributeConflict('off road chain lube', offRoad), false);
  });

  it('input thuần "chain lube" (không qualifier) → không conflict', () => {
    assert.equal(hasAttributeConflict('chain lube', trang), false);
  });
});

describe('findBestProductMatch — không nhầm bản trắng khi ghi "off road"', () => {
  const { products, aliases } = makeCatalog();

  it('thứ tự đảo "off road chain lube zentor" → bản Off Road', () => {
    const m = findBestProductMatch('off road chain lube zentor', products, aliases);
    assert.ok(m, 'Phải match được');
    assert.equal(m.product.id, 'znt_mxo_topgear_gp_chain_lube_off_road');
  });

  it('dấu phẩy "chain lube, loại off road, zentor" → bản Off Road', () => {
    const m = findBestProductMatch('chain lube, loại off road, zentor', products, aliases);
    assert.ok(m, 'Phải match được');
    assert.equal(m.product.id, 'znt_mxo_topgear_gp_chain_lube_off_road');
  });

  it('đúng thứ tự "chain lube off road" vẫn giữ nguyên (không hồi quy)', () => {
    const m = findBestProductMatch('chain lube off road', products, aliases);
    assert.ok(m, 'Phải match được');
    assert.equal(m.product.id, 'znt_mxo_topgear_gp_chain_lube_off_road');
  });

  it('input thuần "chain lube" → vẫn là bản trắng (không hồi quy)', () => {
    const m = findBestProductMatch('chain lube', products, aliases);
    assert.ok(m, 'Phải match được');
    assert.equal(m.product.id, 'znt_mxo_topgear_gp_chain_lube_trang');
    assert.equal(m.score, 100);
  });

  it('Xvil Chain Road không bị qualifier chặn khi input KHÔNG có "off road"', () => {
    const m = findBestProductMatch('xvil xtorq chain road 750ml', products, aliases);
    assert.ok(m, 'Phải match được');
    assert.equal(m.product.id, 'xvil_xvil_xtorq_chain_road_0_75l_binh');
  });
});

describe('parseOrderText — thứ tự đảo & multiline (offline)', () => {
  const { products, aliases } = makeCatalog();

  it('1 dòng đảo thứ tự: "2 thùng off road chain lube zentor" → Off Road', () => {
    const res = parseOrderText('2 thùng off road chain lube zentor', products, aliases);
    const prod = res.lines.find(l => l.type === 'matched' || l.type === 'unmatched');
    assert.ok(prod, 'Phải có dòng hàng');
    assert.equal(prod.type, 'matched');
    assert.equal(prod.data.matchedProduct.id, 'znt_mxo_topgear_gp_chain_lube_off_road');
    assert.equal(prod.data.qty, 2);
  });

  it('multiline: "2 thùng chain lube" + "off road zentor" → merge về Off Road', () => {
    const res = parseOrderText('2 thùng chain lube\noff road zentor', products, aliases);
    const prods = res.lines.filter(l => l.type === 'matched' || l.type === 'unmatched');
    assert.equal(prods.length, 1, 'Đúng 1 dòng hàng sau khi merge');
    assert.equal(prods[0].data.matchedProduct.id, 'znt_mxo_topgear_gp_chain_lube_off_road');
    assert.equal(prods[0].data.qty, 2);
    const ignored = res.lines.filter(l => l.type === 'ignored').map(l => l.raw);
    assert.ok(!ignored.some(r => /off\s*road/i.test(r)), '"off road" không được rơi vào ghi chú');
  });

  it('multiline: dòng ghi chú thật KHÔNG bị merge vào tên SP', () => {
    const res = parseOrderText('2 thùng chain lube max\nGhi chú thêm gì đó', products, aliases);
    const prods = res.lines.filter(l => l.type === 'matched' || l.type === 'unmatched');
    assert.equal(prods.length, 1, 'Dòng SP giữ nguyên, không bị nuốt ghi chú');
    assert.equal(prods[0].data.matchedProduct.id, 'znt_mxo_topgear_gp_chain_lube_max');
    const ignored = res.lines.filter(l => l.type === 'ignored').map(l => l.raw);
    assert.ok(ignored.some(r => /Ghi chú/i.test(r)), 'Ghi chú thật phải giữ nguyên thành ignored');
  });
});

describe('buildShortlist — loại bản trắng khỏi ứng viên AI khi có "off road"', () => {
  const { products, aliases } = makeCatalog();

  it('shortlist "off road chain lube" chứa Off Road, KHÔNG chứa bản trắng', () => {
    const shortlist = buildShortlist('off road chain lube zentor', products, aliases, 15);
    const ids = shortlist.map(s => s.product.id);
    assert.ok(ids.includes('znt_mxo_topgear_gp_chain_lube_off_road'),
      `Shortlist phải chứa bản Off Road: ${ids.join(', ')}`);
    assert.ok(!ids.includes('znt_mxo_topgear_gp_chain_lube_trang'),
      `Shortlist KHÔNG được chứa bản trắng: ${ids.join(', ')}`);
  });
});

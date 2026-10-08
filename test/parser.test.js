/**
 * Behavioral tests for parser.js — Order Automation
 * Run: node --test test/
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeText,
  normalizeUnit,
  levenshtein,
  calculateMatchScore,
  findBestProductMatch,
  parseOrderText,
  fuzzySearchScore,
  normalizeVietnameseQty,
  stripQtyJunk,
  isStandaloneTierLine,
} = require('../parser.js');

// ─── normalizeText ──────────────────────────────────────────────────────────

describe('normalizeText', () => {
  it('removes Vietnamese accents and lowercases', () => {
    assert.equal(normalizeText('Dầu Nhớt'), 'dau nhot');
  });

  it('replaces đ with d', () => {
    assert.equal(normalizeText('ĐƠN HÀNG'), 'don hang');
  });

  it('strips special characters', () => {
    assert.equal(normalizeText('giá 106K/thùng!'), 'gia 106kthung');
  });

  it('collapses multiple spaces', () => {
    assert.equal(normalizeText('  prostream   10w40  '), 'prostream 10w40');
  });

  it('returns empty string for null/undefined', () => {
    assert.equal(normalizeText(null), '');
    assert.equal(normalizeText(undefined), '');
    assert.equal(normalizeText(''), '');
  });
});

// ─── normalizeUnit ──────────────────────────────────────────────────────────

describe('normalizeUnit', () => {
  it('maps common abbreviations to canonical units', () => {
    assert.equal(normalizeUnit('thung'), 'thùng');
    assert.equal(normalizeUnit('thg'), 'thùng');
    assert.equal(normalizeUnit('carton'), 'thùng');
    assert.equal(normalizeUnit('ctn'), 'thùng');
    assert.equal(normalizeUnit('box'), 'thùng');
  });

  it('maps chai/lon/bottle to chai', () => {
    assert.equal(normalizeUnit('chai'), 'chai');
    assert.equal(normalizeUnit('lon'), 'chai');
    assert.equal(normalizeUnit('bottle'), 'chai');
    assert.equal(normalizeUnit('btl'), 'chai');
  });

  it('returns original for unknown units', () => {
    assert.equal(normalizeUnit('pallet'), 'pallet');
  });

  it('returns empty string for null/undefined', () => {
    assert.equal(normalizeUnit(null), '');
    assert.equal(normalizeUnit(undefined), '');
  });
});

// ─── levenshtein ────────────────────────────────────────────────────────────

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    assert.equal(levenshtein('prostream', 'prostream'), 0);
  });

  it('returns 1 for single substitution', () => {
    assert.equal(levenshtein('prostream', 'prostreama'), 1);
  });

  it('returns correct distance for insertion/deletion', () => {
    assert.equal(levenshtein('kaiten', 'kaiton'), 1);
    assert.equal(levenshtein('kaiton', 'kaiten'), 1);
  });

  it('early-exits with 99 when length difference > 3', () => {
    assert.equal(levenshtein('ab', 'abcdef'), 99);
  });
});

// ─── fuzzySearchScore ───────────────────────────────────────────────────────

describe('fuzzySearchScore', () => {
  it('returns 120 for contiguous substring at word start', () => {
    assert.equal(fuzzySearchScore('prostream', 'prostream tt ester 10w40'), 120);
  });

  it('returns 100 for contiguous substring mid-word', () => {
    assert.equal(fuzzySearchScore('ster', 'prostream tt ester 10w40'), 100);
  });

  it('returns token-based score (50+) when all tokens match', () => {
    const score = fuzzySearchScore('prostream 10w40', 'prostream tt ester 10w40');
    assert.ok(score >= 50, `Expected >= 50, got ${score}`);
  });

  it('returns 0 when a token is missing', () => {
    assert.equal(fuzzySearchScore('prostream xyz', 'prostream tt ester 10w40'), 0);
  });

  it('returns 1 for empty query (show all)', () => {
    assert.equal(fuzzySearchScore('', 'anything'), 1);
  });

  it('returns 0 for empty haystack', () => {
    assert.equal(fuzzySearchScore('query', ''), 0);
  });
});

// ─── calculateMatchScore ────────────────────────────────────────────────────

describe('calculateMatchScore', () => {
  const product = { id: 'p1', name: 'PROSTREAM TT ESTER 10W40', spec: '1L' };

  it('scores exact word matches highly', () => {
    const score = calculateMatchScore('prostream 10w40', product);
    assert.ok(score >= 80, `Expected >= 80, got ${score}`);
  });

  it('scores partial matches lower than exact', () => {
    // "prostream" matches but "xyz" does not → score < 100
    const score = calculateMatchScore('prostream xyz', product);
    assert.ok(score > 0 && score < 100, `Expected 0 < score < 100, got ${score}`);
  });

  it('returns 0 for invalid product names', () => {
    assert.equal(calculateMatchScore('anything', { id: 'x', name: '1' }), 0);
    assert.equal(calculateMatchScore('anything', { id: 'x', name: 'X' }), 0);
    assert.equal(calculateMatchScore('anything', null), 0);
  });

  it('filters stop words from input', () => {
    // "nhot" and "chai" are stop words; "prostream" is the real signal
    const scoreWithStops = calculateMatchScore('nhot chai prostream', product);
    const scoreWithout = calculateMatchScore('prostream', product);
    assert.ok(scoreWithStops > 0, 'Stop words should not zero out the score');
    assert.ok(scoreWithout >= scoreWithStops, 'Fewer words should score at least as high');
  });
});

// ─── findBestProductMatch ───────────────────────────────────────────────────

describe('findBestProductMatch', () => {
  const products = [
    { id: 'znt_mxo_prostream_tt_ester_10w40', name: 'PROSTREAM TT ESTER 10W40', spec: '1L' },
    { id: 'torvex_furox_4t_10w50', name: 'FUROX 4T 10W50', spec: '1L' },
    { id: 'xvil_kaiten_10w30', name: 'XVIL Max FORCE KAITEN 10W30', spec: '1L' },
  ];
  const aliases = {
    'prostream 10w40': 'znt_mxo_prostream_tt_ester_10w40',
    'furox 10w50': 'torvex_furox_4t_10w50',
    'kaiten': 'xvil_kaiten_10w30',
  };

  it('matches via exact alias', () => {
    const result = findBestProductMatch('prostream 10w40', products, aliases);
    assert.ok(result, 'Should find a match');
    assert.equal(result.product.id, 'znt_mxo_prostream_tt_ester_10w40');
    assert.equal(result.score, 100);
  });

  it('matches via single-word alias', () => {
    const result = findBestProductMatch('kaiten', products, aliases);
    assert.ok(result, 'Should find a match');
    assert.equal(result.product.id, 'xvil_kaiten_10w30');
  });

  it('matches via fuzzy scoring when no alias hits', () => {
    const result = findBestProductMatch('furox 10w50', products, {});
    assert.ok(result, 'Should find a match via fuzzy');
    assert.equal(result.product.id, 'torvex_furox_4t_10w50');
  });

  it('matches via KV code (kvCode)', () => {
    const productsWithKv = [
      { id: 'znt_mxo_topgear_gp_ester_10w40', kvCode: '8230012', name: 'Zentor Topgear GP 4T 10W40 Ester+' },
      { id: 'znt_mxo_prostream_tt_ester_10w40', kvCode: '8230013', name: 'Zentor Prostream TT 10W40 Ester' }
    ];
    const res1 = findBestProductMatch('2 thùng Zentor mã 8230012', productsWithKv, {});
    assert.ok(res1, 'Should match product by kvCode 8230012');
    assert.equal(res1.product.id, 'znt_mxo_topgear_gp_ester_10w40');
    assert.equal(res1.score, 100);

    const res2 = findBestProductMatch('3 thùng Zentor mã 8230013', productsWithKv, {});
    assert.ok(res2, 'Should match product by kvCode 8230013');
    assert.equal(res2.product.id, 'znt_mxo_prostream_tt_ester_10w40');
    assert.equal(res2.score, 100);
  });

  it('returns null for empty input', () => {
    assert.equal(findBestProductMatch('', products, aliases), null);
    assert.equal(findBestProductMatch('   ', products, aliases), null);
  });

  it('returns null when nothing matches above threshold', () => {
    assert.equal(findBestProductMatch('xyzzy qqqq', products, aliases), null);
  });
});

// ─── parseOrderText ─────────────────────────────────────────────────────────

describe('parseOrderText', () => {
  const products = [
    { id: 'znt_mxo_prostream_tt_ester_10w40', name: 'PROSTREAM TT ESTER 10W40', spec: '1L', tiers: [{ min_qty: 1, price: 180017 }], foc_rules: [] },
    { id: 'torvex_furox_4t_10w50', name: 'FUROX 4T 10W50', spec: '1L', tiers: [{ min_qty: 1, price: 150017 }], foc_rules: [] },
  ];
  const aliases = {
    'prostream 10w40': 'znt_mxo_prostream_tt_ester_10w40',
    'furox 10w50': 'torvex_furox_4t_10w50',
  };

  it('parses a multi-line order with quantities', () => {
    const text = 'prostream 10w40 5 thùng\nfurox 10w50 3 thùng';
    const result = parseOrderText(text, products, aliases);
    assert.ok(result && Array.isArray(result.lines), 'Should return { lines: [...] }');
    const matched = result.lines.filter(l => l.type === 'matched' || l.type === 'unmatched');
    assert.ok(matched.length >= 2, `Expected >= 2 product lines, got ${matched.length}`);
    // Verify first item parsed correctly
    const first = matched[0];
    assert.equal(first.data.qty, 5);
    assert.equal(first.data.unit, 'thùng');
  });

  it('correctly parses Prostream Scooter 0W30 order without mismatching to 60L drum', () => {
    const fullProducts = [
      { id: 'znt_mxo_prostream_tt_scooter_ester_0w30', name: 'Zentor Prostream TT 4T 0W30 Scooter MB Ester (1L/bình)' },
      { id: 'znt_mxo_prostream_tt_ester_10w30_60l', name: 'Zentor Prostream TT 4T 10W30 Ester (60L/phuy)' }
    ];
    const fullAliases = {
      'prostream scooter 0w30': 'znt_mxo_prostream_tt_scooter_ester_0w30',
      'prostream 0w30': 'znt_mxo_prostream_tt_scooter_ester_0w30'
    };
    const input = 'Oil Brother\n5 thùng Prostream Scooter 0W30\nTT CK\nHĐ cập nhật';
    const res = parseOrderText(input, fullProducts, fullAliases);
    assert.equal(res.customerDetected, 'Oil Brother');
    const productLine = res.lines.find(l => l.type === 'matched');
    assert.ok(productLine, 'Product line must match');
    assert.equal(productLine.data.qty, 5);
    assert.equal(productLine.data.unit, 'thùng');
    assert.equal(productLine.data.matchedProduct.id, 'znt_mxo_prostream_tt_scooter_ester_0w30');
  });

  it('returns empty lines for empty input', () => {
    const result = parseOrderText('', products, aliases);
    assert.ok(result && Array.isArray(result.lines), 'Should return { lines: [...] }');
    assert.equal(result.lines.length, 0);
  });
});

// ─── parseOrderText: mid-line qty (Customer + N unit + Product) ─────────────

describe('parseOrderText — mid-line qty (customer prefix)', () => {
  const products = [
    { id: 'tvx_furvex_20w50_ci4_209', name: 'Torvex Furvex 20W50 CI-4 (209L/phuy)', spec: 'Phuy', unit: 'phuy', box_size: 1, tiers: [{ min_qty: 1, max_qty: 9999, price: 0 }], foc_rules: [] },
    { id: 'tvx_furvex_20w50_cf4_209', name: 'Torvex Furvex 20W50 CF-4 (209L/phuy)', spec: 'Phuy', unit: 'phuy', box_size: 1, tiers: [{ min_qty: 1, max_qty: 9999, price: 0 }], foc_rules: [] },
    { id: 'znt_mxo_prostream_tt_ester_10w40', name: 'PROSTREAM TT ESTER 10W40', spec: '1L', unit: 'chai', box_size: 12, tiers: [{ min_qty: 1, max_qty: 9999, price: 180017 }], foc_rules: [] },
    { id: 'torvex_furox_4t_10w50', name: 'FUROX 4T 10W50', spec: '1L', unit: 'chai', box_size: 12, tiers: [{ min_qty: 1, max_qty: 9999, price: 150017 }], foc_rules: [] },
    { id: 'tvx_torvex_cx_5050_200', name: 'TORVEX CX 5050(200L/phuy)', spec: 'Phuy', unit: 'phuy', box_size: 1, tiers: [{ min_qty: 1, max_qty: 9999, price: 0 }], foc_rules: [] },
  ];
  const aliases = {
    'prostream 10w40': 'znt_mxo_prostream_tt_ester_10w40',
    'furox 10w50': 'torvex_furox_4t_10w50',
    'ci 20w50': 'tvx_furvex_20w50_ci4_209',
    'cf 20w50': 'tvx_furvex_20w50_cf4_209',
    'cx 5050': 'tvx_torvex_cx_5050_200',
  };

  it('parses "Vĩnh Khang 2 phuy CI 20W50" → customer + product', () => {
    const res = parseOrderText('Vĩnh Khang 2 phuy CI 20W50', products, aliases);
    const cust = res.lines.find(l => l.type === 'customer');
    const prod = res.lines.find(l => l.type === 'matched' || l.type === 'unmatched');
    assert.ok(cust, 'Must detect customer');
    assert.equal(cust.data.name, 'Vĩnh Khang');
    assert.ok(prod, 'Must detect product');
    assert.equal(prod.data.qty, 2);
    assert.equal(prod.data.unit, 'phuy');
    assert.equal(prod.data.rawProduct, 'CI 20W50');
    assert.equal(res.customerDetected, 'Vĩnh Khang');
  });

  it('parses mid-line qty with various units (thùng, chai, can)', () => {
    const cases = [
      { input: 'Anh Tuấn 5 thùng Prostream 10W40', qty: 5, unit: 'thùng', product: 'PROSTREAM TT ESTER 10W40' },
      { input: 'Chị Hoa 10 chai Furox 10W50', qty: 10, unit: 'chai', product: 'FUROX 4T 10W50' },
      { input: 'Bảy Tám 3 phuy CX 5050', qty: 3, unit: 'phuy', product: 'TORVEX CX 5050' },
    ];
    for (const c of cases) {
      const res = parseOrderText(c.input, products, aliases);
      const prod = res.lines.find(l => l.type === 'matched' || l.type === 'unmatched');
      assert.ok(prod, `"${c.input}" must produce a product line`);
      assert.equal(prod.data.qty, c.qty, `qty mismatch for "${c.input}"`);
      assert.equal(prod.data.unit, c.unit, `unit mismatch for "${c.input}"`);
      if (prod.type === 'matched') {
        assert.ok(prod.data.matchedProduct.name.includes(c.product.split(' ')[0]),
          `product mismatch for "${c.input}": got ${prod.data.matchedProduct.name}`);
      }
    }
  });

  it('does NOT treat price keywords in prefix as customer', () => {
    // "giá 106k 2 thùng Prostream" — prefix "giá 106k" is NOT a customer name
    const res = parseOrderText('giá 106k 2 thùng Prostream 10W40', products, aliases);
    const cust = res.lines.find(l => l.type === 'customer');
    assert.ok(!cust || !cust.data.name.toLowerCase().includes('giá'),
      'Price keyword must not be detected as customer');
    const prod = res.lines.find(l => l.type === 'matched' || l.type === 'unmatched');
    assert.ok(prod, 'Must still detect product');
    assert.equal(prod.data.qty, 2);
  });

  it('does NOT treat FOC/gift keywords in prefix as customer', () => {
    const res = parseOrderText('tặng 2 chai Prostream 10W40', products, aliases);
    const cust = res.lines.find(l => l.type === 'customer');
    assert.ok(!cust, 'FOC prefix must not create a customer line');
  });

  it('still handles qty-at-start format correctly', () => {
    const res = parseOrderText('2 phuy CI 20W50', products, aliases);
    const prod = res.lines.find(l => l.type === 'matched' || l.type === 'unmatched');
    assert.ok(prod, 'qty-at-start must work');
    assert.equal(prod.data.qty, 2);
    assert.equal(prod.data.unit, 'phuy');
    const cust = res.lines.find(l => l.type === 'customer');
    assert.ok(!cust, 'No customer should be detected');
  });

  it('still handles qty-at-end format correctly', () => {
    const res = parseOrderText('CI 20W50 2 phuy', products, aliases);
    const prod = res.lines.find(l => l.type === 'matched' || l.type === 'unmatched');
    assert.ok(prod, 'qty-at-end must work');
    assert.equal(prod.data.qty, 2);
    assert.equal(prod.data.unit, 'phuy');
  });

  it('multi-line: customer on line 1, products on subsequent lines', () => {
    const text = 'Vĩnh Khang\n2 phuy CI 20W50\n3 thùng Prostream 10W40\nTT CK';
    const res = parseOrderText(text, products, aliases);
    assert.equal(res.customerDetected, 'Vĩnh Khang');
    const prods = res.lines.filter(l => l.type === 'matched' || l.type === 'unmatched');
    assert.equal(prods.length, 2, 'Must detect 2 products');
    const pay = res.lines.find(l => l.type === 'payment');
    assert.ok(pay, 'Must detect payment');
    assert.equal(pay.data.value, 'ck');
  });

  it('multi-line: customer+product on same line, then more products', () => {
    const text = 'Vĩnh Khang 2 phuy CI 20W50\n3 thùng Prostream 10W40';
    const res = parseOrderText(text, products, aliases);
    assert.equal(res.customerDetected, 'Vĩnh Khang');
    const prods = res.lines.filter(l => l.type === 'matched' || l.type === 'unmatched');
    assert.equal(prods.length, 2, 'Must detect 2 products');
    assert.equal(prods[0].data.qty, 2);
    assert.equal(prods[0].data.unit, 'phuy');
    assert.equal(prods[1].data.qty, 3);
    assert.equal(prods[1].data.unit, 'thùng');
  });

  it('product name with numbers (20W50, 5050) does not confuse mid-line split', () => {
    // "20W50" contains "20" + "W50" — must NOT be split at "20"
    const res = parseOrderText('Anh Ba 1 phuy CX 5050', products, aliases);
    const prod = res.lines.find(l => l.type === 'matched' || l.type === 'unmatched');
    assert.ok(prod, 'Must detect product');
    assert.equal(prod.data.qty, 1);
    assert.equal(prod.data.unit, 'phuy');
    // rawProduct should contain "5050", not be split at "50"
    assert.ok(prod.data.rawProduct.includes('5050'), `rawProduct must contain 5050, got: ${prod.data.rawProduct}`);
  });

  it('line with only customer name (no qty) still detected as customer', () => {
    const res = parseOrderText('Nguyễn Văn A', products, aliases);
    const cust = res.lines.find(l => l.type === 'customer');
    assert.ok(cust, 'Plain name on line 0 must be customer');
    assert.equal(cust.data.name, 'Nguyễn Văn A');
  });

  it('line without qty and not first line is ignored', () => {
    const text = '2 phuy CI 20W50\nGhi chú thêm gì đó';
    const res = parseOrderText(text, products, aliases);
    const ignored = res.lines.find(l => l.type === 'ignored');
    assert.ok(ignored, 'Non-first line without qty must be ignored');
  });

  it('handles Vietnamese accented customer + mid-line qty', () => {
    const res = parseOrderText('Nguyễn Thị Đẹp 4 phuy CF 20W50', products, aliases);
    const cust = res.lines.find(l => l.type === 'customer');
    assert.ok(cust, 'Must detect accented customer');
    assert.equal(cust.data.name, 'Nguyễn Thị Đẹp');
    const prod = res.lines.find(l => l.type === 'matched' || l.type === 'unmatched');
    assert.ok(prod, 'Must detect product');
    assert.equal(prod.data.qty, 4);
    assert.equal(prod.data.unit, 'phuy');
  });

  it('comma-separated products after customer prefix', () => {
    const text = 'Vĩnh Khang 2 phuy CI 20W50, 3 thùng Prostream 10W40';
    const res = parseOrderText(text, products, aliases);
    // Should detect customer and at least 1 product
    const prods = res.lines.filter(l => l.type === 'matched' || l.type === 'unmatched');
    assert.ok(prods.length >= 1, 'Must detect at least 1 product from comma-separated line');
  });

  it('parses "Anywhere Man" order with "giá thùng" on single bottle (priceTierQty=1)', () => {
    const text = 'Anywhere Man\n1 thùng prostream 10W50\n1 chai Prostream 15W50 giá thùng\nTT CK\nHđ';
    const res = parseOrderText(text, products, aliases);
    assert.equal(res.customerDetected, 'Anywhere Man');
    const prods = res.lines.filter(l => l.type === 'matched' || l.type === 'unmatched');
    assert.equal(prods.length, 2);
    assert.equal(prods[0].data.qty, 1);
    assert.equal(prods[0].data.unit, 'thùng');
    assert.equal(prods[1].data.qty, 1);
    assert.equal(prods[1].data.unit, 'chai');
    assert.equal(prods[1].data.priceTierQty, 1, 'Cụm từ "giá thùng" trên chai lẻ phải kích hoạt priceTierQty=1');
  });

  it('đơn "ANYWHERE MAN / chain lube max giá 2 thùng / TT CK / HĐ": đúng biến thể Max, 1 dòng hàng, tier=2, payment ck', () => {
    const chainProducts = [
      { id: 'znt_mxo_topgear_gp_chain_lube_max', name: 'Zentor Topgear GP Chain Lube Max (0,4L/chai)', spec: 'Chăm sóc xe', unit: 'chai', box_size: 24, tiers: [{ min_qty: 1, price: 190017 }, { min_qty: 2, price: 185017 }], foc_rules: [] },
      { id: 'znt_mxo_topgear_gp_chain_lube_trang', name: 'Zentor Topgear GP Chain Lube (0,4L/chai)', spec: 'Chăm sóc xe', unit: 'chai', box_size: 24, tiers: [{ min_qty: 1, price: 156000 }, { min_qty: 2, price: 181017 }], foc_rules: [] },
      { id: 'znt_mxo_topgear_gp_chain_lube_transparent', name: 'Zentor Topgear GP Chain Lube Transparent (0,4L/chai)', spec: 'Chăm sóc xe', unit: 'chai', box_size: 24, tiers: [{ min_qty: 1, price: 156000 }, { min_qty: 2, price: 181017 }], foc_rules: [] },
      { id: 'znt_mxo_topgear_gp_chain_lube_off_road', name: 'Zentor Topgear CP Chain Lube Off Road (0,4L/bình)', spec: 'Chăm sóc xe', unit: 'bình', box_size: 24, tiers: [{ min_qty: 1, price: 190017 }, { min_qty: 2, price: 185017 }], foc_rules: [] },
    ];
    // Mô phỏng máy thật: alias học "chain lube" → bản trắng + alias mặc định phân biệt biến thể
    const aliases = {
      'chain lube': 'znt_mxo_topgear_gp_chain_lube_trang',
      'chain lube max': 'znt_mxo_topgear_gp_chain_lube_max',
      'chain lube transparent': 'znt_mxo_topgear_gp_chain_lube_transparent',
      'chain lube off road': 'znt_mxo_topgear_gp_chain_lube_off_road',
    };
    const text = 'ANYWHERE MAN\n2 thùng chain lube max giá 2 thùng\nTT CK\nHĐ';
    const res = parseOrderText(text, chainProducts, aliases);
    assert.equal(res.customerDetected, 'ANYWHERE MAN', 'Dòng đầu ALL-CAPS phải là tên khách');
    const prods = res.lines.filter(l => l.type === 'matched' || l.type === 'unmatched');
    assert.equal(prods.length, 1, 'Đúng 1 dòng hàng — "giá 2 thùng" KHÔNG được tách thành dòng thứ 2');
    assert.equal(prods[0].data.matchedProduct.id, 'znt_mxo_topgear_gp_chain_lube_max',
      'Phải trúng đúng bản Max (alias exact 100 thắng alias word-boundary 95 của bản trắng)');
    assert.equal(prods[0].data.qty, 2, 'qty=2 — số "2" trong "giá 2 thùng" không được cộng thêm');
    assert.equal(prods[0].data.priceTierQty, 2, '"giá 2 thùng" phải thành priceTierQty=2');
    const pay = res.lines.find(l => l.type === 'payment');
    assert.ok(pay, 'Phải nhận diện dòng thanh toán');
    assert.equal(pay.data.value, 'ck', '"TT CK" phải là chuyển khoản (ck)');
    const ignored = res.lines.find(l => l.type === 'ignored');
    assert.ok(ignored, '"HĐ" phải bị ignore (thành ghi chú), không thành sản phẩm');
  });
});

// ─── Unit-aware disambiguation (phuy vs xô) ────────────────────────────────

describe('findBestProductMatch — unit hint disambiguation', () => {
  const products = [
    { id: 'tvx_furvex_20w50_ci4_18', name: 'Torvex Furvex 20W50 CI-4 (18L/xô)', spec: 'Xô', packaging: '18L xô', unit: 'xô', box_size: 1, tiers: [{ min_qty: 1, max_qty: 9999, price: 0 }], foc_rules: [] },
    { id: 'tvx_furvex_20w50_ci4_209', name: 'Torvex Furvex 20W50 CI-4 (209L/phuy)', spec: 'Phuy', packaging: '209L phuy', unit: 'phuy', box_size: 1, tiers: [{ min_qty: 1, max_qty: 9999, price: 0 }], foc_rules: [] },
  ];

  it('user writes "phuy" → must match 209L/phuy product, NOT 18L/xô', () => {
    const res = parseOrderText('2 phuy CI 20W50', products, {});
    const prod = res.lines.find(l => l.type === 'matched' || l.type === 'unmatched');
    assert.ok(prod, 'Must detect product');
    assert.ok(prod.data.matchedProduct, 'Must match a product');
    assert.equal(prod.data.matchedProduct.id, 'tvx_furvex_20w50_ci4_209',
      `Expected phuy product, got: ${prod.data.matchedProduct.id}`);
  });

  it('user writes "xô" → must match 18L/xô product, NOT 209L/phuy', () => {
    const res = parseOrderText('2 xô CI 20W50', products, {});
    const prod = res.lines.find(l => l.type === 'matched' || l.type === 'unmatched');
    assert.ok(prod, 'Must detect product');
    assert.ok(prod.data.matchedProduct, 'Must match a product');
    assert.equal(prod.data.matchedProduct.id, 'tvx_furvex_20w50_ci4_18',
      `Expected xô product, got: ${prod.data.matchedProduct.id}`);
  });

  it('user writes "drum" (English for phuy) → must match phuy product', () => {
    const res = parseOrderText('2 drum CI 20W50', products, {});
    const prod = res.lines.find(l => l.type === 'matched' || l.type === 'unmatched');
    assert.ok(prod, 'Must detect product');
    assert.ok(prod.data.matchedProduct, 'Must match a product');
    assert.equal(prod.data.matchedProduct.id, 'tvx_furvex_20w50_ci4_209',
      `Expected phuy product for "drum", got: ${prod.data.matchedProduct.id}`);
  });

  it('no unit hint → falls back to first-in-list (backward compat)', () => {
    // Without unit context, both score equally; first in list wins
    const match = findBestProductMatch('CI 20W50', products, {});
    assert.ok(match, 'Must match something');
    // Just verify it doesn't crash and returns a valid product
    assert.ok(match.product.id.startsWith('tvx_furvex_20w50_ci4'));
  });
});

// ─── Vietnamese number words + "tr" (triệu) price ──────────────────────────

describe('parseOrderText — Vietnamese number words & triệu price', () => {
  const products = [
    { id: 'tvx_furvex_20w50_ci4_18', name: 'Torvex Furvex 20W50 CI-4 (18L/xô)', spec: 'Xô', packaging: '18L xô', unit: 'xô', box_size: 1, tiers: [{ min_qty: 1, max_qty: 9999, price: 0 }], foc_rules: [] },
    { id: 'tvx_furvex_20w50_ci4_209', name: 'Torvex Furvex 20W50 CI-4 (209L/phuy)', spec: 'Phuy', packaging: '209L phuy', unit: 'phuy', box_size: 1, tiers: [{ min_qty: 1, max_qty: 9999, price: 0 }], foc_rules: [] },
    { id: 'znt_mxo_prostream_tt_ester_10w40', name: 'PROSTREAM TT ESTER 10W40', spec: '1L', unit: 'chai', box_size: 12, tiers: [{ min_qty: 1, max_qty: 9999, price: 180017 }], foc_rules: [] },
  ];
  const aliases = { 'ci 20w50': 'tvx_furvex_20w50_ci4_209' };

  it('parses "Đức Khang một phuy ci 20w50 12tr1" → customer + product + price', () => {
    const res = parseOrderText('Đức Khang một phuy ci 20w50 12tr1', products, aliases);
    const cust = res.lines.find(l => l.type === 'customer');
    assert.ok(cust, 'Must detect customer');
    assert.equal(cust.data.name, 'Đức Khang');
    const prod = res.lines.find(l => l.type === 'matched' || l.type === 'unmatched');
    assert.ok(prod, 'Must detect product');
    assert.equal(prod.data.qty, 1, '"một" must become qty 1');
    assert.equal(prod.data.unit, 'phuy');
    assert.equal(prod.data.matchedProduct.id, 'tvx_furvex_20w50_ci4_209', 'Must match phuy product');
    assert.equal(prod.data.explicitPrice, 12100000, '"12tr1" must become 12,100,000đ');
  });

  it('converts Vietnamese number words to digits (một/hai/ba/bốn/năm)', () => {
    const cases = [
      { input: 'một phuy ci 20w50', qty: 1 },
      { input: 'hai phuy ci 20w50', qty: 2 },
      { input: 'ba thùng Prostream 10W40', qty: 3 },
      { input: 'bốn chai Prostream 10W40', qty: 4 },
      { input: 'năm thùng Prostream 10W40', qty: 5 },
      { input: 'mười phuy ci 20w50', qty: 10 },
    ];
    for (const c of cases) {
      const res = parseOrderText(c.input, products, aliases);
      const prod = res.lines.find(l => l.type === 'matched' || l.type === 'unmatched');
      assert.ok(prod, `"${c.input}" must produce a product line`);
      assert.equal(prod.data.qty, c.qty, `qty mismatch for "${c.input}"`);
    }
  });

  it('does NOT convert number words that are NOT followed by a unit (names)', () => {
    // "Ba" and "Năm" here are part of a person's name, not quantities
    const res = parseOrderText('Ông Bảy Tám', products, aliases);
    const prod = res.lines.find(l => l.type === 'matched' || l.type === 'unmatched');
    assert.ok(!prod, 'Name with number words must NOT become a product');
    const cust = res.lines.find(l => l.type === 'customer');
    assert.ok(cust, 'Should be treated as customer name');
  });

  it('parses "tr" price variants: 12tr, 1tr5, 12tr1', () => {
    const cases = [
      { input: '1 phuy ci 20w50 12tr', price: 12000000 },
      { input: '1 phuy ci 20w50 1tr5', price: 1500000 },
      { input: '1 phuy ci 20w50 12tr1', price: 12100000 },
    ];
    for (const c of cases) {
      const res = parseOrderText(c.input, products, aliases);
      const prod = res.lines.find(l => l.type === 'matched' || l.type === 'unmatched');
      assert.ok(prod, `"${c.input}" must produce a product line`);
      assert.equal(prod.data.explicitPrice, c.price, `price mismatch for "${c.input}"`);
      // Product name must be clean (no "12tr1" leftover)
      assert.ok(!prod.data.rawProduct.includes('tr'), `rawProduct must not contain price: ${prod.data.rawProduct}`);
    }
  });

  it('does NOT treat "tr" inside product names as price', () => {
    // Viscosity grades like 20W50 must not be misread
    const res = parseOrderText('2 phuy ci 20w50', products, aliases);
    const prod = res.lines.find(l => l.type === 'matched' || l.type === 'unmatched');
    assert.ok(prod, 'Must detect product');
    assert.equal(prod.data.explicitPrice, undefined, 'No price should be extracted');
    assert.equal(prod.data.qty, 2);
  });
});

// ─── parseOrderText: nhiều SP trên CÙNG 1 dòng, KHÔNG dấu ngăn cách ─────────

describe('parseOrderText — single line, multiple products (no separator)', () => {
  const products = [
    { id: 'veltron_racing_uflow', name: 'VELTRON RACING 4T MOTOBIKE 10W-40 with UFLOW', spec: '1L', unit: 'chai', box_size: 12, tiers: [{ min_qty: 1, max_qty: 9999, price: 115017 }], foc_rules: [] },
    { id: 'veltron_motobike_ester', name: 'VELTRON Motobike 4T Ester 10W-40 (1L)', spec: '1L', unit: 'chai', box_size: 12, tiers: [{ min_qty: 1, max_qty: 9999, price: 81017 }], foc_rules: [] },
    { id: 'fast', name: 'FAST 4T 10W40', spec: '1L', unit: 'chai', box_size: 12, tiers: [{ min_qty: 1, max_qty: 9999, price: 130017 }], foc_rules: [] },
    { id: 'vantol_5l', name: 'VANTOL 5 LÍT', spec: '5L', unit: 'chai', box_size: 4, tiers: [{ min_qty: 1, max_qty: 9999, price: 50000 }], foc_rules: [] },
  ];
  const aliases = {};

  it('đơn Hoàng Long viết 1 dòng → customer + ĐỦ 2 sản phẩm với đúng qty/giá', () => {
    const text = 'Hoàng Long 10 thùng veltron racing uflow 10w40 giá 115k/chai 20 thùng VELTRON Motobike 4T Ester 10W40 - 1L giá 81k/chai TT CN';
    const res = parseOrderText(text, products, aliases);
    assert.equal(res.customerDetected, 'Hoàng Long');
    const prods = res.lines.filter(l => l.type === 'matched' || l.type === 'unmatched');
    assert.equal(prods.length, 2, `expected 2 products on one line, got ${prods.length}`);
    assert.equal(prods[0].data.qty, 10);
    assert.equal(prods[0].type, 'matched');
    assert.equal(prods[0].data.matchedProduct.id, 'veltron_racing_uflow');
    assert.equal(prods[0].data.explicitPrice, 115000);
    assert.equal(prods[1].data.qty, 20);
    assert.equal(prods[1].type, 'matched');
    assert.equal(prods[1].data.matchedProduct.id, 'veltron_motobike_ester');
    assert.equal(prods[1].data.explicitPrice, 81000);
    // Mã thanh toán đuôi dòng không bị nhét vào tên SP / dòng riêng
    assert.ok(!res.lines.some(l => l.type === 'payment'), 'TT CN must not become a payment line');
    assert.ok(!/tt|cn/i.test(prods[1].data.rawProduct), 'payment codes must be stripped from product name');
  });

  it('quà kèm "tặng N chai X" gắn vào SP chính, KHÔNG tách thành item riêng', () => {
    const res = parseOrderText('3 thùng fast tặng 2 chai nước rửa', products, aliases);
    const prods = res.lines.filter(l => l.type === 'matched' || l.type === 'unmatched');
    assert.equal(prods.length, 1, 'gift must stay attached to main product');
    assert.ok(prods[0].data.explicitGift, 'explicitGift must be parsed');
    assert.equal(prods[0].data.explicitGift.qty, 2);
  });

  it('dung tích trong tên SP ("vantol 5 lít") không sinh item giả thứ 2', () => {
    const res = parseOrderText('Hà Phúc 5 chai dầu vantol 5 lít giá 50k', products, aliases);
    assert.equal(res.customerDetected, 'Hà Phúc');
    const prods = res.lines.filter(l => l.type === 'matched' || l.type === 'unmatched');
    assert.equal(prods.length, 1, `volume-in-name must not split, got ${prods.length}`);
    assert.equal(prods[0].data.qty, 5);
    assert.equal(prods[0].data.unit, 'chai');
    assert.equal(prods[0].data.explicitPrice, 50000);
  });
});

// ─── parseOrderText: số lượng ghi bằng CHỮ (số đơn & số ghép) ───────────────

describe('parseOrderText — số lượng viết bằng chữ (word quantities)', () => {
  const products = [
    { id: 'veltron_racing_uflow', name: 'VELTRON RACING 4T MOTOBIKE 10W-40 with UFLOW', spec: '1L', unit: 'chai', box_size: 12, tiers: [{ min_qty: 1, max_qty: 9999, price: 115017 }], foc_rules: [] },
    { id: 'veltron_motobike_ester', name: 'VELTRON Motobike 4T Ester 10W-40 (1L)', spec: '1L', unit: 'chai', box_size: 12, tiers: [{ min_qty: 1, max_qty: 9999, price: 81017 }], foc_rules: [] },
    { id: 'fast', name: 'FAST 4T 10W40', spec: '1L', unit: 'chai', box_size: 12, tiers: [{ min_qty: 1, max_qty: 9999, price: 130017 }], foc_rules: [] },
    { id: 'vantol_5l', name: 'VANTOL 5 LÍT', spec: '5L', unit: 'chai', box_size: 4, tiers: [{ min_qty: 1, max_qty: 9999, price: 50000 }], foc_rules: [] },
  ];
  const aliases = {};

  it('normalizeVietnameseQty chuyển đúng số đơn lẫn số ghép (chỉ khi kèm đơn vị)', () => {
    assert.equal(normalizeVietnameseQty('mười thùng dầu'), '10 thùng dầu');
    assert.equal(normalizeVietnameseQty('hai mươi thùng'), '20 thùng');
    assert.equal(normalizeVietnameseQty('hai muoi chai'), '20 chai');
    assert.equal(normalizeVietnameseQty('ba mươi lăm chai'), '35 chai');
    assert.equal(normalizeVietnameseQty('hai mươi một chai'), '21 chai');
    assert.equal(normalizeVietnameseQty('mười lăm lon'), '15 lon');
    assert.equal(normalizeVietnameseQty('năm chục chai'), '50 chai');
    assert.equal(normalizeVietnameseQty('3 chục chai'), '30 chai');
    assert.equal(normalizeVietnameseQty('một trăm hai mươi lăm phuy'), '125 phuy');
    // Tên riêng / cụm không có đơn vị đứng sau → KHÔNG bị đụng tới
    assert.equal(normalizeVietnameseQty('Bảy Tám gọi'), 'Bảy Tám gọi');
    assert.equal(normalizeVietnameseQty('hai ba bốn'), 'hai ba bốn');
    assert.equal(normalizeVietnameseQty('Anh Hai 5 thùng'), 'Anh Hai 5 thùng');
  });

  it('"hai mươi thùng" → qty 20, mã TT ở dòng riêng không nuốt sản phẩm', () => {
    const res = parseOrderText('Hoàng Long\nhai mươi thùng veltron racing uflow 10w40 giá 115k/chai\nTT CN', products, aliases);
    assert.equal(res.customerDetected, 'Hoàng Long');
    const prods = res.lines.filter(l => l.type === 'matched' || l.type === 'unmatched');
    assert.equal(prods.length, 1);
    assert.equal(prods[0].data.qty, 20);
    assert.equal(prods[0].data.matchedProduct.id, 'veltron_racing_uflow');
    assert.ok(res.lines.some(l => l.type === 'payment'), 'TT CN line stays a payment line');
  });

  it('"ba mươi lăm chai vantol" → qty 35, dung tích trong tên KHÔNG sinh item rác "giá 50k"', () => {
    const res = parseOrderText('Hà Phúc\nba mươi lăm chai vantol 5 lít giá 50k', products, aliases);
    const prods = res.lines.filter(l => l.type === 'matched' || l.type === 'unmatched');
    assert.equal(prods.length, 1, `expected exactly 1 product, got ${prods.length}`);
    assert.equal(prods[0].data.qty, 35);
    assert.equal(prods[0].data.unit, 'chai');
  });

  it('"năm chục lon" → qty 50 và match đúng SP', () => {
    const res = parseOrderText('Hà Phúc\nnăm chục lon veltron motobike ester', products, aliases);
    const prods = res.lines.filter(l => l.type === 'matched' || l.type === 'unmatched');
    assert.equal(prods.length, 1);
    assert.equal(prods[0].data.qty, 50);
    assert.equal(prods[0].data.matchedProduct.id, 'veltron_motobike_ester');
  });

  it('tên người chứa số đếm ("Bảy Tám") vẫn nhận diện là khách, không thành qty', () => {
    const res = parseOrderText('Bảy Tám 3 thùng fast', products, aliases);
    assert.equal(res.customerDetected, 'Bảy Tám');
    const prods = res.lines.filter(l => l.type === 'matched');
    assert.equal(prods.length, 1);
    assert.equal(prods[0].data.qty, 3);
  });

  it('đơn 1 dòng số-chữ + mã TT đuôi dòng ("mười thùng ... TT CN") vẫn đủ SP', () => {
    const res = parseOrderText('Hoàng Long mười thùng veltron racing uflow 10w40 giá 115k/chai TT CN', products, aliases);
    const prods = res.lines.filter(l => l.type === 'matched' || l.type === 'unmatched');
    assert.equal(prods.length, 1);
    assert.equal(prods[0].data.qty, 10);
    assert.equal(prods[0].data.explicitPrice, 115000);
    assert.ok(!res.lines.some(l => l.type === 'payment'));
  });
});

// ─── parseOrderText: "tặng thêm N <SP>" (đơn "Nam Thành" 04/9) ───────────────
// Bug thật 04/9/2026: đơn "Nam Thành: 1 can Prostream TT 10W50 20L tặng thêm 6 chai
// Veltron Engine cleaner" — chữ "thêm" trong "tặng thêm" làm gãy cả qtyPatternStart
// lẫn guard ranh giới tách multi-SP → đuôi "tặng thêm" dính vào segment Prostream,
// isGift (test TOÀN bộ segment) đánh dấu nhầm SP CHÍNH thành hàng tặng giá 0, còn
// quà 6 chai mất marker thành dòng trả tiền.

describe('parseOrderText — "tặng thêm N <SP>" (đơn Nam Thành)', () => {
  const products = [
    { id: 'znt_prostream_tt_10w50_20l', name: 'Zentor Prostream TT Ester 10W50 (20L)', spec: '20L', unit: 'can', box_size: 1, tiers: [{ min_qty: 1, max_qty: 9999, price: 2500000 }], foc_rules: [] },
    { id: 'veltron_engine_cleaner_shot', name: 'VELTRON Motobike Engine Cleaner (0,1L/bình)', spec: '0,1L', unit: 'bình', packaging: '12 chai/thùng', box_size: 12, tiers: [{ min_qty: 1, max_qty: 9999, price: 75017 }], foc_rules: [] },
    { id: 'veltron_professional_engine_cleaner', name: 'VELTRON Professional Engine Cleaner (0,4l)', spec: '0,4L', unit: 'chai', packaging: '12 chai/thùng', box_size: 12, tiers: [{ min_qty: 1, max_qty: 9999, price: 150017 }], foc_rules: [] },
  ];
  const aliases = {
    'prostream tt 10w50': 'znt_prostream_tt_10w50_20l',
    'engine cleaner': 'veltron_engine_cleaner_shot',
  };

  it('đơn 1 dòng: SP chính KHÔNG thành quà, quà nằm trong explicitGift', () => {
    const res = parseOrderText('Nam Thành: 1 can Prostream TT 10W50 20L tặng thêm 6 chai Veltron Engine cleaner', products, aliases);
    assert.equal(res.customerDetected, 'Nam Thành:');
    const items = res.lines.filter(l => l.type === 'matched' || l.type === 'unmatched');
    assert.equal(items.length, 1, 'Chỉ 1 dòng SP chính — quà phải nằm trong explicitGift');
    const main = items[0].data;
    assert.equal(main.isGift, false, 'SP chính không được đánh dấu là hàng tặng');
    assert.equal(main.qty, 1);
    assert.equal(main.unit, 'can');
    assert.equal(main.explicitPrice, undefined, 'SP chính giữ giá tier, không bị ép về 0');
    assert.ok(main.explicitGift, 'Quà phải được bắt vào explicitGift');
    assert.equal(main.explicitGift.qty, 6);
    assert.equal(main.explicitGift.unit, 'chai');
    assert.equal(main.explicitGift.name, 'Veltron Engine cleaner');
  });

  it('đơn 3 dòng: dòng "tặng thêm 6 chai..." giữ được marker → isGift true, giá 0', () => {
    const res = parseOrderText('Nam Thành:\n1 can Prostream TT 10W50 20L\ntặng thêm 6 chai Veltron Engine cleaner', products, aliases);
    const items = res.lines.filter(l => l.type === 'matched' || l.type === 'unmatched');
    assert.equal(items.length, 2);
    assert.equal(items[0].data.isGift, false);
    const giftLine = items[1].data;
    assert.equal(giftLine.isGift, true, 'Dòng quà phải là hàng tặng (marker không bị vứt)');
    assert.equal(giftLine.qty, 6);
    assert.equal(giftLine.unit, 'chai');
    assert.equal(giftLine.explicitPrice, 0);
  });

  it('tên khách đứng trước marker quà vẫn tách đúng: "Nam Thành tặng thêm 6 chai X"', () => {
    const res = parseOrderText('Nam Thành tặng thêm 6 chai Veltron Engine cleaner', products, aliases);
    assert.equal(res.customerDetected, 'Nam Thành');
    const giftLine = res.lines.find(l => l.type === 'matched' || l.type === 'unmatched');
    assert.ok(giftLine, 'Phải có dòng sản phẩm quà');
    assert.equal(giftLine.data.isGift, true);
    assert.equal(giftLine.data.qty, 6);
  });

  it('dòng quà riêng lẻ kiểu cũ "tặng 2 lon X" (không "thêm") vẫn đúng như trước', () => {
    const res = parseOrderText('tặng 2 lon dầu hộp', products, aliases);
    const giftLine = res.lines.find(l => l.type === 'matched' || l.type === 'unmatched');
    assert.ok(giftLine, 'Phải có dòng quà');
    assert.equal(giftLine.data.isGift, true);
    assert.equal(giftLine.data.qty, 2);
    assert.equal(giftLine.data.unit, 'chai', 'lon chuẩn hóa về chai (quy ước normalizeUnit)');
  });
});

// ─── Ký tự rác giữa số lượng và đơn vị + lưới an toàn unmatched ────────────
// Bug thật 09/25: "1' thùng Chain Lube Offroad" (dấu nháy dính khi copy tin
// nhắn điện thoại) làm gãy mọi regex qty+unit → dòng bị vứt vào ghi chú, mất
// hàng khỏi đơn. Fix: stripQtyJunk gỡ họ dấu nháy trước mọi pattern; dòng vẫn
// gãy (ký tự lạ khác) phải thành unmatched để sales thấy, không được biến mất.

describe('parseOrderText — ký tự rác giữa số lượng và đơn vị', () => {
  const products = [
    { id: 'znt_mxo_topgear_gp_chain_lube_off_road', name: 'Zentor Topgear CP Chain Lube Off Road (0,4L/bình)', spec: 'Chăm sóc xe', packaging: '400ml x 12 chai', unit: 'chai', box_size: 12, tiers: [{ min_qty: 1, max_qty: 1, price: 205017 }, { min_qty: 2, max_qty: 9999, price: 185017 }], foc_rules: [] },
    { id: 'znt_mxo_topgear_gp_chain_lube_max', name: 'Zentor Topgear GP Chain Lube Max (0,4L/chai)', spec: 'Chăm sóc xe', packaging: '400ml x 12 chai', unit: 'chai', box_size: 12, tiers: [{ min_qty: 1, max_qty: 1, price: 205017 }, { min_qty: 2, max_qty: 9999, price: 185017 }], foc_rules: [] },
    { id: 'znt_mxo_topgear_gp_chain_cleaner', name: 'Zentor Topgear GP Chain Cleaner (0,4L/bình)', spec: 'Chăm sóc xe', packaging: '400ml x 12 chai', unit: 'chai', box_size: 12, tiers: [{ min_qty: 1, max_qty: 9999, price: 158017 }], foc_rules: [] },
    { id: 'xvil_xvil_chain_cleaner_750ml', name: 'Xvil Chain Cleaner (0,75L/bình)', spec: 'Chăm sóc xe', packaging: '0,75L', unit: 'chai', box_size: 12, tiers: [{ min_qty: 1, max_qty: 9999, price: 121017 }], foc_rules: [] },
  ];
  // Alias đúng như DB thật (gồm alias tự học "chain cleaner" → bản Zentor)
  const aliases = {
    'chain lube off road': 'znt_mxo_topgear_gp_chain_lube_off_road',
    'chain cleaner': 'znt_mxo_topgear_gp_chain_cleaner',
  };

  it('stripQtyJunk: gỡ dấu nháy giữa số và đơn vị, KHÔNG đụng dấu thập phân', () => {
    assert.equal(stripQtyJunk("1' thùng Chain Lube Offroad"), '1 thùng Chain Lube Offroad');
    assert.equal(stripQtyJunk('12 ` chai X'), '12 chai X');
    assert.equal(stripQtyJunk('3\u2019 can Y'), '3 can Y');
    assert.equal(stripQtyJunk('1.5 lít xăng'), '1.5 lít xăng', 'dấu thập phân phải giữ nguyên');
    assert.equal(stripQtyJunk('giá 158k'), 'giá 158k', 'không có đơn vị sau dấu → không đụng tới');
  });

  it('"1\' thùng Chain Lube Offroad" (dấu nháy đơn) phải nhận đúng Off Road, qty 1', () => {
    const res = parseOrderText("1' thùng Chain Lube Offroad", products, aliases);
    const prod = res.lines.find(l => l.type === 'matched' || l.type === 'unmatched');
    assert.ok(prod, 'Phải có dòng hàng');
    assert.equal(prod.type, 'matched', 'Phải match được sản phẩm');
    assert.equal(prod.data.matchedProduct.id, 'znt_mxo_topgear_gp_chain_lube_off_road');
    assert.equal(prod.data.qty, 1);
    assert.equal(prod.data.unit, 'thùng');
  });

  it('các biến thể dấu nháy (backtick, quote kép, nháy cong) cũng phải nhận được', () => {
    const cases = [
      '1` thùng Chain Lube Offroad',
      '2" thùng Chain Lube Offroad',
      '2\u2019 thùng Chain Lube Offroad',
      '1\u00B4 thùng Chain Lube Offroad',
    ];
    for (const line of cases) {
      const res = parseOrderText(line, products, aliases);
      const prod = res.lines.find(l => l.type === 'matched' || l.type === 'unmatched');
      assert.ok(prod, `"${line}" phải ra dòng hàng`);
      assert.equal(prod.type, 'matched', `"${line}" phải matched`);
      assert.equal(prod.data.matchedProduct.id, 'znt_mxo_topgear_gp_chain_lube_off_road',
        `"${line}" phải trúng Off Road`);
    }
  });

  it('đơn thật "Anywhere Man" nguyên văn: đủ dòng hàng, không còn dòng trôi vào ghi chú', () => {
    const text = "Anywhere Man\n2 Thùng Chain Lube Max\n1' thùng Chain Lube Offroad\n1 Thùng Chain Cleaner\n3 Chai Chain Cleaner hàng tặng\nTT CK";
    const res = parseOrderText(text, products, aliases);
    const offRoad = res.lines.find(l => (l.type === 'matched') && l.data.matchedProduct.id === 'znt_mxo_topgear_gp_chain_lube_off_road');
    assert.ok(offRoad, 'Dòng Off Road (dính dấu nháy) phải được nhận diện');
    assert.equal(offRoad.data.qty, 1);
    const ignoredLines = res.lines.filter(l => l.type === 'ignored').map(l => l.raw);
    assert.ok(!ignoredLines.some(r => /Offroad/i.test(r)), 'Dòng Off Road không được trôi vào ignored/ghi chú');
  });

  it('lưới an toàn: dòng có số + đơn vị nhưng mọi pattern gãy → unmatched (không bị nuốt vào ghi chú)', () => {
    // "~" không thuộc họ dấu nháy được gỡ → dòng không parse được nhưng vẫn có
    // cụm số+đơn vị → phải thành dòng unmatched (vàng) để sales thấy và sửa tay.
    const res = parseOrderText('1~ thùng Chain Lube Max', products, aliases);
    const prod = res.lines.find(l => l.type === 'matched' || l.type === 'unmatched');
    assert.ok(prod, 'Phải có dòng hàng (dù không match được)');
    assert.equal(prod.type, 'unmatched', 'Phải là dòng unmatched (vàng) chứ không biến mất');
    assert.equal(prod.data.qty, 1);
    assert.equal(prod.data.unit, 'thùng');
    const ignoredLines = res.lines.filter(l => l.type === 'ignored').map(l => l.raw);
    assert.ok(!ignoredLines.some(r => /thùng/i.test(r)), 'Không được trôi vào ignored/ghi chú');
  });
});

// ─── Unit "thùng" không được lật alias sang brand khác (bug Chain Cleaner) ──
// Bug thật 09/25: "1 Thùng Chain Cleaner" — alias "chain cleaner" trúng bản
// Zentor nhưng wantsOtherUnit (thùng ≠ chai) nhả alias cho fuzzy; input 2 từ
// khớp tròn tên Xvil Chain Cleaner (brand bị miễn trừ phạt, đuôi "075lbinh"
// bắt đầu bằng số nên cũng được bỏ qua) → hòa 100-100, tie-break ưu tiên tên
// ít từ → chọn NHẦM Xvil 121k. "Thùng" là quy đóng thùng của CHÍNH SP đó
// (kvCodeThùng = mã gốc + "-1") nên không đủ tư cách "đòi đơn vị khác".

describe('findBestProductMatch — unit "thùng" giữ tuyệt đối alias (không lật brand)', () => {
  const products = [
    { id: 'znt_mxo_topgear_gp_chain_cleaner', name: 'Zentor Topgear GP Chain Cleaner (0,4L/bình)', spec: 'Chăm sóc xe', packaging: '400ml x 12 chai', unit: 'chai', box_size: 12, tiers: [{ min_qty: 1, max_qty: 9999, price: 158017 }], foc_rules: [] },
    { id: 'xvil_xvil_chain_cleaner_750ml', name: 'Xvil Chain Cleaner (0,75L/bình)', spec: 'Chăm sóc xe', packaging: '0,75L', unit: 'chai', box_size: 12, tiers: [{ min_qty: 1, max_qty: 9999, price: 121017 }], foc_rules: [] },
  ];
  const aliases = { 'chain cleaner': 'znt_mxo_topgear_gp_chain_cleaner' };

  it('hint "thùng" → alias "chain cleaner" phải giữ nguyên bản Zentor', () => {
    const m = findBestProductMatch('chain cleaner', products, aliases, 'thùng');
    assert.ok(m, 'Phải match được');
    assert.equal(m.product.id, 'znt_mxo_topgear_gp_chain_cleaner',
      `"thùng" là quy đổi của cùng SP — alias phải thắng, không nhả cho fuzzy (got: ${m.product.id})`);
  });

  it('hint "chai" → bản Zentor như cũ (không hồi quy)', () => {
    const m = findBestProductMatch('chain cleaner', products, aliases, 'chai');
    assert.ok(m);
    assert.equal(m.product.id, 'znt_mxo_topgear_gp_chain_cleaner');
  });

  it('đơn Zentor trộn cả 2 unit (thùng + chai) phải ra cùng một sản phẩm Zentor', () => {
    const text = '1 Thùng Chain Cleaner\n3 Chai Chain Cleaner hàng tặng';
    const res = parseOrderText(text, products, aliases);
    const prods = res.lines.filter(l => l.type === 'matched');
    assert.equal(prods.length, 2, 'Cả 2 dòng phải matched');
    for (const p of prods) {
      assert.equal(p.data.matchedProduct.id, 'znt_mxo_topgear_gp_chain_cleaner',
        'Không được lẫn Xvil vào đơn Zentor');
    }
    const gift = prods.find(p => p.data.isGift);
    assert.ok(gift, 'Dòng "hàng tặng" phải được đánh dấu quà');
  });
});

// ─── Dòng mốc giá đứng riêng ("Giá 2 thùng" áp toàn đơn) ────────────────────
// Bug thật 22/9/2026: đơn "Anywhere Man" có dòng "Giá 2 thùng" — parser nhặt
// thành dòng hàng (qty=2, tên "Giá") → match nhầm "Poster Pricelist" 0đ và
// không item nào được áp mốc ≥2. Giờ phải thành type 'tier-override'.

describe('parseOrderText — dòng mốc giá đứng riêng', () => {
  const products = [
    { id: 'znt_mxo_topgear_gp_chain_lube_max', name: 'Zentor Topgear GP Chain Lube Max (0,4L/chai)', spec: 'Chăm sóc xe', packaging: '400ml x 12 chai', unit: 'chai', box_size: 12, tiers: [{ min_qty: 1, max_qty: 1, price: 205017 }, { min_qty: 2, max_qty: 9999, price: 185017 }], foc_rules: [] },
    { id: 'znt_mxo_topgear_gp_chain_lube_off_road', name: 'Zentor Topgear CP Chain Lube Off Road (0,4L/bình)', spec: 'Chăm sóc xe', packaging: '400ml x 12 chai', unit: 'chai', box_size: 12, tiers: [{ min_qty: 1, max_qty: 1, price: 205017 }, { min_qty: 2, max_qty: 9999, price: 185017 }], foc_rules: [] },
    { id: 'znt_mxo_topgear_gp_chain_cleaner', name: 'Zentor Topgear GP Chain Cleaner (0,4L/bình)', spec: 'Chăm sóc xe', packaging: '400ml x 12 chai', unit: 'chai', box_size: 12, tiers: [{ min_qty: 1, max_qty: 1, price: 168017 }, { min_qty: 2, max_qty: 9999, price: 158017 }], foc_rules: [] },
  ];
  const aliases = {
    'chain lube max': 'znt_mxo_topgear_gp_chain_lube_max',
    'chain lube off road': 'znt_mxo_topgear_gp_chain_lube_off_road',
    'chain cleaner': 'znt_mxo_topgear_gp_chain_cleaner',
  };

  it('isStandaloneTierLine: đúng các dạng "Giá 2 thùng"/"giá thùng"/"áp giá 3 thùng"', () => {
    assert.equal(isStandaloneTierLine('Giá 2 thùng'), true);
    assert.equal(isStandaloneTierLine('giá thùng'), true);
    assert.equal(isStandaloneTierLine('Áp giá 3 thùng'), true);
    assert.equal(isStandaloneTierLine('GIÁ 2 THÙNG.'), true);
    assert.equal(isStandaloneTierLine('2 thùng chain lube max giá 2 thùng'), false, 'dòng ghép không khớp');
    assert.equal(isStandaloneTierLine('giá 158k'), false);
    assert.equal(isStandaloneTierLine('Giao hàng thứ 6'), false);
    assert.equal(isStandaloneTierLine(''), false);
  });

  it('"Giá 2 thùng" → 1 dòng tier-override, KHÔNG sinh item', () => {
    const res = parseOrderText('Giá 2 thùng', products, aliases);
    const tierLines = res.lines.filter(l => l.type === 'tier-override');
    assert.equal(tierLines.length, 1);
    assert.equal(tierLines[0].data.priceTierQty, 2);
    assert.ok(!res.lines.some(l => l.type === 'matched' || l.type === 'unmatched'),
      'Không được match nhầm thành item (Poster Pricelist...)');
  });

  it('"giá thùng" (không số) → mốc 1; "Áp giá 3 thùng" → mốc 3', () => {
    const r1 = parseOrderText('giá thùng', products, aliases);
    assert.equal(r1.lines.filter(l => l.type === 'tier-override')[0].data.priceTierQty, 1);
    const r3 = parseOrderText('Áp giá 3 thùng', products, aliases);
    assert.equal(r3.lines.filter(l => l.type === 'tier-override')[0].data.priceTierQty, 3);
  });

  it('đơn Anywhere Man: hết item ma "Giá", vẫn còn dòng tier-override', () => {
    const text = "Anywhere Man\n2 Thùng Chain Lube Max\n1' thùng Chain Lube Offroad\n1 Thùng Chain Cleaner\n3 Chai Chain Cleaner hàng tặng\nGiá 2 thùng\nTT CK\nHĐ";
    const res = parseOrderText(text, products, aliases);
    const prodLines = res.lines.filter(l => l.type === 'matched' || l.type === 'unmatched');
    assert.equal(prodLines.length, 4, 'Đúng 4 dòng hàng, không có item ma');
    assert.ok(!prodLines.some(l => /^giá$/i.test((l.data.rawProduct || '').trim())), 'Không có item tên "Giá"');
    assert.ok(res.lines.some(l => l.type === 'tier-override' && l.data.priceTierQty === 2));
  });
});

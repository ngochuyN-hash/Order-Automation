/**
 * Golden regression tests for the matching engine reform.
 * These are REAL-WORLD failure cases reported by the user.
 * Run: node --test test/matching-golden.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findBestProductMatch,
  calculateMatchScore,
  hasAttributeConflict,
  hasUnitConflict,
  applySynonyms,
  normalizeFull,
} from '../parser.js';
import { mergeDuplicateItems } from '../src/order/calculator.js';

// ─── Test product catalog (subset of real data) ─────────────────────────────
const PRODUCTS = [
  { id: 'torvex_fast_scoot_0_8l', name: 'Torvex Fast Scoot 10W40 (0,8L/lon)', spec: '0.8L', unit: 'chai', campaignKey: 'torvex_mxo' },
  { id: 'torvex_good_scoot_10w40', name: 'Auto X Good Scoot 10W40 (0,8L/lon)', spec: '0.8L', unit: 'chai', campaignKey: 'torvex_mxo' },
  { id: 'torvex_fast_4t_1l', name: 'Torvex Fast 10W40 (1L/lon)', spec: '1L', unit: 'chai', campaignKey: 'torvex_mxo' },
  { id: 'torvex_fast_4t_4l', name: 'Torvex Fast 10W40 (4L/can)', spec: '4L', unit: 'can', campaignKey: 'torvex_mxo' },
  { id: 'znt_prostream_10w40', name: 'Zentor Prostream TT 4T 10W40 Ester (1L/bình)', spec: '1L', unit: 'chai', campaignKey: 'znt_mxo' },
  { id: 'znt_prostream_10w30', name: 'Zentor Prostream TT 4T 10W30 Ester (1L/bình)', spec: '1L', unit: 'chai', campaignKey: 'znt_mxo' },
  { id: 'znt_softshell_m', name: 'Zentor Softshell Jacket (M)', spec: 'Size M', campaignKey: 'znt_merch' },
  { id: 'znt_softshell_l', name: 'Zentor Softshell Jacket (L)', spec: 'Size L', campaignKey: 'znt_merch' },
  { id: 'znt_softshell_xl', name: 'Zentor Softshell Jacket (XL)', spec: 'Size XL', campaignKey: 'znt_merch' },
  { id: 'torvex_furvex_20w50_209', name: 'Torvex Furvex 20W50 CI-4 (209L/phuy)', spec: 'Phuy', unit: 'phuy', campaignKey: 'tvx_ind' },
  { id: 'torvex_furvex_20w50_18', name: 'Torvex Furvex 20W50 CI-4 (18L/xô)', spec: 'Xô', unit: 'xô', campaignKey: 'tvx_ind' },
  { id: 'znt_mxo_moto_xp_4t_10w40', name: 'Zentor Moto XP 4T 10W40 (1L/bình)', spec: 'Moto XP 4T', unit: 'chai', campaignKey: 'znt_mxo' },
  { id: 'znt_mxo_moto_xp_scooter_10w40', name: 'Zentor Moto XP 10W40 Scooter (1L/bình)', spec: 'Moto XP 4T Scooter', unit: 'chai', campaignKey: 'znt_mxo' },
];

// ─── Case 1: "fast tay ga" → Fast Scoot (NOT Good Scoot) ────────────────────
describe('Golden: "fast tay ga" phải khớp Fast Scoot, KHÔNG phải Good Scoot', () => {
  it('synonym "tay ga" → "scoot" works', () => {
    assert.equal(applySynonyms('fast tay ga'), 'fast scoot');
  });

  it('findBestProductMatch("fast tay ga") → Fast Scoot', () => {
    const result = findBestProductMatch('fast tay ga', PRODUCTS, {});
    assert.ok(result, 'Must find a match');
    assert.equal(result.product.id, 'torvex_fast_scoot_0_8l',
      `"fast tay ga" must match Fast Scoot, got: ${result.product.name}`);
  });

  it('Fast Scoot scores higher than Good Scoot for "fast scoot"', () => {
    const fastScore = calculateMatchScore('fast scoot', PRODUCTS[0]);
    const goodScore = calculateMatchScore('fast scoot', PRODUCTS[1]);
    assert.ok(fastScore > goodScore,
      `Fast Scoot (${fastScore}) must beat Good Scoot (${goodScore})`);
  });
});

// ─── Case 2: Viscosity hard filter (10W30 ≠ 10W40) ─────────────────────────
describe('Golden: Hard filter viscosity — 10W30 ≠ 10W40', () => {
  it('"prostream 10w30" does NOT match 10W40 product', () => {
    const score = calculateMatchScore('prostream 10w30', PRODUCTS[4]); // 10W40
    assert.equal(score, 0, 'Must be 0 (hard filtered)');
  });

  it('"prostream 10w30" matches 10W30 product', () => {
    const score = calculateMatchScore('prostream 10w30', PRODUCTS[5]); // 10W30
    assert.ok(score > 0, 'Must score > 0 for correct viscosity');
  });

  it('findBestProductMatch("prostream 10w30") → 10W30 product', () => {
    const result = findBestProductMatch('prostream 10w30', PRODUCTS, {});
    assert.ok(result, 'Must find a match');
    assert.equal(result.product.id, 'znt_prostream_10w30');
  });
});

// ─── Case 3: Volume hard filter (1L ≠ 4L) ──────────────────────────────────
describe('Golden: Hard filter volume — 1L ≠ 4L', () => {
  it('"fast 4l" does NOT match 1L product', () => {
    const score = calculateMatchScore('fast 4l', PRODUCTS[2]); // 1L
    assert.equal(score, 0, 'Must be 0 (volume conflict)');
  });

  it('"fast 4l" matches 4L product', () => {
    const score = calculateMatchScore('fast 4l', PRODUCTS[3]); // 4L
    assert.ok(score > 0, 'Must score > 0 for correct volume');
  });

  it('findBestProductMatch("fast 4l") → 4L product', () => {
    const result = findBestProductMatch('fast 4l', PRODUCTS, {});
    assert.ok(result, 'Must find a match');
    assert.equal(result.product.id, 'torvex_fast_4t_4l');
  });
});

// ─── Case 4: Size hard filter (L ≠ XL) ─────────────────────────────────────
describe('Golden: Hard filter size — L ≠ XL ≠ M', () => {
  it('"softshell L" does NOT match XL or M', () => {
    assert.equal(calculateMatchScore('softshell l', PRODUCTS[6]), 0); // M
    assert.equal(calculateMatchScore('softshell l', PRODUCTS[8]), 0); // XL
  });

  it('"softshell L" matches L product', () => {
    const score = calculateMatchScore('softshell l', PRODUCTS[7]); // L
    assert.ok(score > 0, 'Must score > 0 for correct size');
  });

  it('findBestProductMatch("softshell L") → size L', () => {
    const result = findBestProductMatch('softshell L', PRODUCTS, {});
    assert.ok(result, 'Must find a match');
    assert.equal(result.product.id, 'znt_softshell_l');
  });
});

// ─── Case 5: Alias guard — alias xung đột thuộc tính bị chặn ───────────────
describe('Golden: Alias guard — alias chỉ đúng khi KHÔNG xung đột thuộc tính', () => {
  const aliases = {
    'prostream': 'znt_prostream_10w40', // alias points to 10W40
  };

  it('alias "prostream" works when no viscosity in input', () => {
    const result = findBestProductMatch('prostream', PRODUCTS, aliases);
    assert.ok(result, 'Must match via alias');
    assert.equal(result.product.id, 'znt_prostream_10w40');
    assert.equal(result.via, 'alias');
  });

  it('alias "prostream" is BLOCKED when input says 10w30 (conflict)', () => {
    const result = findBestProductMatch('prostream 10w30', PRODUCTS, aliases);
    assert.ok(result, 'Must still find a match (via fuzzy)');
    assert.equal(result.product.id, 'znt_prostream_10w30',
      'Must match 10W30 product, not the alias target 10W40');
    assert.notEqual(result.via, 'alias', 'Must NOT use alias (conflict)');
  });
});

// ─── Case 6: hasAttributeConflict utility ───────────────────────────────────
describe('Golden: hasAttributeConflict utility', () => {
  it('detects viscosity conflict', () => {
    assert.equal(hasAttributeConflict('fast 10w30', PRODUCTS[0]), true); // product is 10W40
    assert.equal(hasAttributeConflict('fast 10w40', PRODUCTS[0]), false);
  });

  it('detects volume conflict', () => {
    assert.equal(hasAttributeConflict('fast 4l', PRODUCTS[2]), true); // product is 1L
    assert.equal(hasAttributeConflict('fast 1l', PRODUCTS[2]), false);
  });

  it('detects size conflict', () => {
    assert.equal(hasAttributeConflict('softshell xl', PRODUCTS[7]), true); // product is L
    assert.equal(hasAttributeConflict('softshell l', PRODUCTS[7]), false);
  });

  it('no conflict when input has no explicit attribute', () => {
    assert.equal(hasAttributeConflict('fast scoot', PRODUCTS[0]), false);
    assert.equal(hasAttributeConflict('prostream', PRODUCTS[4]), false);
  });
});

// ─── Case 7: normalizeFull pipeline ─────────────────────────────────────────
describe('Golden: normalizeFull pipeline (normalize + brand + synonyms)', () => {
  it('handles "Fast Tay Ga" → "fast scoot"', () => {
    assert.equal(normalizeFull('Fast Tay Ga'), 'fast scoot');
  });

  it('handles "auto x fast" → "torvex fast" (map synonym live)', () => {
    assert.equal(normalizeFull('auto x fast'), 'torvex fast');
  });

  it('handles "nhớt lap" → "gear oil"', () => {
    assert.equal(normalizeFull('nhớt lap'), 'gear oil');
  });
});

// ─── Case 8: Unit guard — gõ "phuy" KHÔNG ra "xô" ─────────────────────────
describe('Golden: Unit guard — "7 phuy CF 20W50" phải ra phuy, KHÔNG ra xô', () => {
  const aliases = {
    'cf 20w50': 'torvex_furvex_20w50_18', // alias độc: trỏ vào SP xô (học sai trước đây)
  };

  it('alias "cf 20w50" bị BLOCK khi unitHint="phuy" (xung đột packaging)', () => {
    const result = findBestProductMatch('CF 20W50', PRODUCTS, aliases, 'phuy');
    assert.ok(result, 'Must find a match');
    assert.equal(result.product.id, 'torvex_furvex_20w50_209',
      `Must match phuy product, got: ${result.product.name}`);
    assert.notEqual(result.via, 'alias', 'Must NOT use poisoned alias');
  });

  it('alias "cf 20w50" hoạt động bình thường khi unitHint="xô"', () => {
    const result = findBestProductMatch('CF 20W50', PRODUCTS, aliases, 'xô');
    assert.ok(result, 'Must find a match');
    assert.equal(result.product.id, 'torvex_furvex_20w50_18');
    assert.equal(result.via, 'alias');
  });

  it('alias "cf 20w50" hoạt động khi KHÔNG có unitHint', () => {
    const result = findBestProductMatch('CF 20W50', PRODUCTS, aliases);
    assert.ok(result, 'Must find a match');
    assert.equal(result.product.id, 'torvex_furvex_20w50_18');
    assert.equal(result.via, 'alias');
  });

  it('hasUnitConflict detects phuy vs xô', () => {
    assert.equal(hasUnitConflict('phuy', PRODUCTS[10]), true); // xô product
    assert.equal(hasUnitConflict('phuy', PRODUCTS[9]), false); // phuy product
    assert.equal(hasUnitConflict('xô', PRODUCTS[9]), true); // phuy product
    assert.equal(hasUnitConflict('xô', PRODUCTS[10]), false); // xô product
  });

  it('hasUnitConflict ignores chai/lon (interchangeable)', () => {
    assert.equal(hasUnitConflict('chai', PRODUCTS[0]), false); // lon product
    assert.equal(hasUnitConflict('thùng', PRODUCTS[9]), false); // not a distinct conflict
  });
});

// ─── Case: "Chain Transperant 400ml" phải ra Chain Lube Transparent ─────────
// Bug thật: typo "Transperant" + mốc volume cũ >=0.5L bỏ qua dung tích chai nhỏ
// → Chain Care Kit (0,8L) sống sót ở vòng chấm điểm, lệch 4 điểm → đẩy sang
// AI-Final chọn hộ → LLM chọn nhầm Kit.
describe('Golden: "zentor chain transperant 400ml" không được khớp sang Chain Kit', () => {
  const CHAIN_PRODUCTS = [
    { id: 'znt_mxo_topgear_gp_chain_lube_transparent', name: 'Zentor Topgear GP Chain Lube Transparent (0,4L/chai)', spec: 'Chăm sóc xe', packaging: '400ml x 12 chai', unit: 'chai', campaignKey: 'znt_mxo' },
    { id: 'znt_mxo_zentor_chain_care_kit', name: 'Zentor Chain Care Kit (0,8L/kit)', spec: 'Chăm sóc xe', packaging: '4', unit: 'chai', campaignKey: 'znt_mxo' },
    { id: 'znt_mxo_topgear_gp_chain_lube_trang', name: 'Zentor Topgear GP Chain Lube (0,4L/chai)', spec: 'Chăm sóc xe', packaging: '400ml x 12 chai', unit: 'chai', campaignKey: 'znt_mxo' },
    { id: 'znt_mxo_topgear_gp_chain_cleaner', name: 'Zentor Topgear GP Chain Cleaner (0,4L/bình)', spec: 'Chăm sóc xe', packaging: '400ml x 12 chai', unit: 'chai', campaignKey: 'znt_mxo' },
  ];
  const ALIASES = {
    'top race gp chain lube transparent': 'znt_mxo_topgear_gp_chain_lube_transparent',
    'chain transperant': 'znt_mxo_topgear_gp_chain_lube_transparent',
  };
  const kit = CHAIN_PRODUCTS[1];

  it('volume conflict: input 400ml vs Kit 0,8L (ratio 2.0) là xung đột', () => {
    assert.equal(hasAttributeConflict(normalizeFull('chain transperant 400ml'), kit), true);
  });

  it('không xung đột khi khớp đúng quy cách 400ml', () => {
    const transparent = CHAIN_PRODUCTS[0];
    assert.equal(hasAttributeConflict(normalizeFull('chain transperant 400ml'), transparent), false);
  });

  it('findBestProductMatch với unit hint "chai" → Chain Lube Transparent', () => {
    const r = findBestProductMatch('Zentor Chain Transperant 400ml', CHAIN_PRODUCTS, ALIASES, 'chai');
    assert.ok(r, 'phải tìm thấy match');
    assert.equal(r.product.id, 'znt_mxo_topgear_gp_chain_lube_transparent');
    // Gap đủ xa ngưỡng mơ hồ → không cần AI-Final
    if (r.runnerUp) assert.ok(r.score - r.runnerUp.score >= 15 || r.via === 'alias',
      `gap quá nhỏ (${r.score} vs ${r.runnerUp.score})`);
  });

  it('ngay cả khi không có alias mới, engine vẫn loại Kit nhờ volume conflict', () => {
    const r = findBestProductMatch('Zentor Chain Transperant 400ml', CHAIN_PRODUCTS, {}, 'chai');
    assert.ok(r);
    assert.notEqual(r.product.id, 'znt_mxo_zentor_chain_care_kit');
    assert.equal(r.product.id, 'znt_mxo_topgear_gp_chain_lube_transparent');
  });
});

// ─── Case: đơn "ANYWHERE MAN" (10/09/2026) — alias ngắn nuốt biến thể ───────
// Bug thật: máy đã học alias "chain lube" → bản trắng. Input "chain lube max"
// chứa cụm "chain lube" theo ranh giới từ → alias ăn 95đ, thắng fuzzy bản Max
// (84đ) → match NHẦM bản trắng 154k thay vì Max 158k (thiếu 99k/2 thùng).
// Fix: thêm alias mặc định "chain lube max/transparent/off road" — alias exact
// 100đ phải thắng alias word-boundary 95đ.
describe('Golden: "chain lube max" phải trúng bản Max dù có alias "chain lube" → trắng', () => {
  const CHAIN_VARIANTS = [
    { id: 'znt_mxo_topgear_gp_chain_lube_max', name: 'Zentor Topgear GP Chain Lube Max (0,4L/chai)', spec: 'Chăm sóc xe', packaging: '400ml x 12 chai', unit: 'chai', campaignKey: 'znt_mxo' },
    { id: 'znt_mxo_topgear_gp_chain_lube_trang', name: 'Zentor Topgear GP Chain Lube (0,4L/chai)', spec: 'Chăm sóc xe', packaging: '400ml x 12 chai', unit: 'chai', campaignKey: 'znt_mxo' },
    { id: 'znt_mxo_topgear_gp_chain_lube_transparent', name: 'Zentor Topgear GP Chain Lube Transparent (0,4L/chai)', spec: 'Chăm sóc xe', packaging: '400ml x 12 chai', unit: 'chai', campaignKey: 'znt_mxo' },
    { id: 'znt_mxo_topgear_gp_chain_lube_off_road', name: 'Zentor Topgear CP Chain Lube Off Road (0,4L/bình)', spec: 'Chăm sóc xe', packaging: '400ml x 12 chai', unit: 'chai', campaignKey: 'znt_mxo' },
  ];
  // Alias đúng như máy user đã học + alias mặc định mới thêm
  const LEARNED_ALIASES = {
    'chain lube': 'znt_mxo_topgear_gp_chain_lube_trang',
    'chain lube max': 'znt_mxo_topgear_gp_chain_lube_max',
    'chain lube transparent': 'znt_mxo_topgear_gp_chain_lube_transparent',
    'chain lube off road': 'znt_mxo_topgear_gp_chain_lube_off_road',
  };

  it('"chain lube max" → bản Max (alias exact 100 thắng word-boundary 95)', () => {
    const r = findBestProductMatch('chain lube max', CHAIN_VARIANTS, LEARNED_ALIASES, 'chai');
    assert.ok(r);
    assert.equal(r.product.id, 'znt_mxo_topgear_gp_chain_lube_max',
      `Expected Max, got ${r.product.id} (score ${r.score})`);
  });

  it('"chain lube transparent" → bản Transparent (không bị alias "chain lube" nuốt)', () => {
    const r = findBestProductMatch('chain lube transparent', CHAIN_VARIANTS, LEARNED_ALIASES, 'chai');
    assert.ok(r);
    assert.equal(r.product.id, 'znt_mxo_topgear_gp_chain_lube_transparent');
  });

  it('"chain lube off road" → bản Off Road', () => {
    const r = findBestProductMatch('chain lube off road', CHAIN_VARIANTS, LEARNED_ALIASES, 'bình');
    assert.ok(r);
    assert.equal(r.product.id, 'znt_mxo_topgear_gp_chain_lube_off_road');
  });

  it('"chain lube" (không phụ từ) vẫn → bản trắng như alias đã học', () => {
    const r = findBestProductMatch('chain lube', CHAIN_VARIANTS, LEARNED_ALIASES, 'chai');
    assert.ok(r);
    assert.equal(r.product.id, 'znt_mxo_topgear_gp_chain_lube_trang');
  });
});

// ─── Case: đơn "989 Workhop" (04/09/2026) — "Fork 10" bị lật nhầm brand ─────
// Đơn thật: "2 Chai Propuls 10W40 giá thùng / 1 chai Fork 10 giá thùng".
// "Fork 10" khớp TUYỆT ĐỐI tên "Xvil Fork 10 (1L/bình)" (100đ) nhưng bị unit
// hint "chai" phạt nặng -20 (packaging "6 bình x 1 lít" nằm trong soft-conflict
// 'bình') rơi còn 80, trong khi "Zentor Topgear GP Fork Oil 10W" (76đ) được
// cộng +15 unit chai → 91 lật kèo thắng sai → sai brand, sai kvCode, chênh giá
// 228k vs 173k. Hai nguyên nhân đã sửa: (1) unit bonus/penalty không áp lên
// match tên ≥100, (2) 'bình' không còn là xung đột nặng với "chai".
describe('Golden: "1 chai Fork 10" phải trúng Xvil Fork 10, KHÔNG phải Zentor Fork Oil', () => {
  const FORK_PRODUCTS = [
    { id: 'xvil_xvil_fork_10_1l_binh', name: 'Xvil Fork 10 (1L/bình)', spec: '1L', packaging: '6 bình x 1 lít', unit: 'thùng', campaignKey: 'xvil' },
    { id: 'znt_mxo_topgear_gp_fork_oil_10w', name: 'Zentor Topgear GP Fork Oil 10W (1L/chai)', spec: 'Sản phẩm bảo dưỡng', packaging: '1L x 12 chai', unit: 'chai', campaignKey: 'znt_mxo' },
    { id: 'znt_mxo_prostream_tt_ester_10w40', name: 'Zentor Prostream TT 10W40 Ester (1L/bình)', spec: 'Prostream TT 4T', packaging: '12 chai x 1 lít', unit: 'chai', campaignKey: 'znt_mxo' },
  ];

  it('"Fork 10" trúng fork Xvil với điểm cao hơn hẳn fork oil Zentor (brand giả ngoài IGNORE_TOKENS bị trừ -8)', () => {
    const sForkXvil = calculateMatchScore(normalizeFull('fork 10'), FORK_PRODUCTS[0]);
    const sForkOilZentor = calculateMatchScore(normalizeFull('fork 10'), FORK_PRODUCTS[1]);
    assert.ok(sForkXvil >= 90, `Expected >= 90, got ${sForkXvil}`);
    assert.ok(sForkXvil > sForkOilZentor, `fork Xvil (${sForkXvil}) phải hơn fork oil Zentor (${sForkOilZentor})`);
  });

  it('unit hint "chai" KHÔNG được lật match đủ từ khóa sang brand khác', () => {
    const r = findBestProductMatch('Fork 10', FORK_PRODUCTS, {}, 'chai');
    assert.ok(r, 'phải tìm thấy match');
    assert.equal(r.product.id, 'xvil_xvil_fork_10_1l_binh',
      `"Fork 10" + unit chai must match Xvil Fork 10, got: ${r.product.name}`);
  });

  it('"bình" trong packaging không còn là xung đột nặng với hint "chai"', () => {
    const r = findBestProductMatch('Propuls 10W40', FORK_PRODUCTS, {}, 'chai');
    assert.ok(r);
    assert.equal(r.product.id, 'znt_mxo_prostream_tt_ester_10w40',
      'misspelled "Propuls" vẫn phải khớp Zentor Prostream 10W40');
  });
});

// ─── Case: đơn "Bảo Long Detailing" (16/09/2026) — typo "scooer" làm mất dòng ────
// Đơn thật 4 dòng, 24 chai:
//   "6 chai TT scooter 5w40" / "6 chai moto SR scooer 10w40" (typo)
//   / "6 chai moto SR 10w40" / "6 chai moto SR 10w30"
// Root cause: "scooer" (typo của scooter, dist Levenshtein 1) không nằm trong tên
// SP nào → AI-FINAL (quy tắc "phụ từ phải có trong tên SP") tự chọn nhầm bản
// Moto XP 4T 10W40 → 2 dòng 10W40 cùng map 1 productId → merge gộp 6+6=12,
// đơn thành 3 dòng. Fix: synonym 'scooer' → 'scooter' (tầng parser).
describe('Golden: "moto SR scooer 10w40" (typo) phải khớp bản SCOOTER, không gộp với bản 4T', () => {
  const Moto_XP = [
    { id: 'znt_mxo_moto_xp_4t_10w40', name: 'Zentor Moto XP 4T 10W40 (1L/bình)', spec: 'Moto XP 4T', unit: 'chai', campaignKey: 'znt_mxo' },
    { id: 'znt_mxo_moto_xp_scooter_10w40', name: 'Zentor Moto XP 10W40 Scooter (1L/bình)', spec: 'Moto XP 4T Scooter', unit: 'chai', campaignKey: 'znt_mxo' },
  ];

  it('synonym "scooer" → "scooter" hoạt động', () => {
    assert.equal(applySynonyms('moto xp scooer 10w40'), 'moto xp scooter 10w40');
  });

  it('"moto xp scooer 10w40" (typo) → bản SCOOTER, không phải bản 4T', () => {
    const r = findBestProductMatch('moto xp scooer 10w40', Moto_XP, {});
    assert.ok(r, 'phải tìm thấy match');
    assert.equal(r.product.id, 'znt_mxo_moto_xp_scooter_10w40',
      `"scooer" phải khớp Moto XP 10W40 Scooter, got: ${r.product.name}`);
  });

  it('"moto xp 10w40" (không có scooter) → bản 4T, không phải bản Scooter', () => {
    const r = findBestProductMatch('moto xp 10w40', Moto_XP, {});
    assert.ok(r, 'phải tìm thấy match');
    assert.equal(r.product.id, 'znt_mxo_moto_xp_4t_10w40',
      `"moto xp 10w40" phải khớp Moto XP 4T 10W40, got: ${r.product.name}`);
  });

  it('2 dòng 10W40 khác variant KHÔNG bị merge — đơn giữ 2 dòng qty 6+6', () => {
    const items = [
      { qty: 6, unit: 'chai', rawProduct: 'moto SR scooer 10w40', product: Moto_XP[1] },
      { qty: 6, unit: 'chai', rawProduct: 'moto SR 10w40', product: Moto_XP[0] },
    ];
    const merged = mergeDuplicateItems(items);
    assert.equal(merged.length, 2, 'khác productId → không được gộp');
    assert.deepEqual(merged.map(i => i.qty), [6, 6]);
  });

  it('cùng productId viết 2 kiểu ("moto xp 10w40" + "moto xp 4t 10w40") VẪN gộp 6+6=12 (merge hợp lệ)', () => {
    const items = [
      { qty: 6, unit: 'chai', rawProduct: 'moto xp 10w40', product: Moto_XP[0] },
      { qty: 6, unit: 'chai', rawProduct: 'moto xp 4t 10w40', product: Moto_XP[0] },
    ];
    const merged = mergeDuplicateItems(items);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].qty, 12);
  });
});

// ═══ Golden 09/25: unit "thùng" KHÔNG được lật alias sang brand khác ════════
// Đơn thật "Anywhere Man": "1 Thùng Chain Cleaner" — alias tự học trên máy
// "chain cleaner" → bản Zentor. Trước fix: hint "thùng" ≠ unit SP "chai" kích
// hoạt wantsOtherUnit → nhả alias cho fuzzy; input 2 từ khớp tròn tên Xvil
// Chain Cleaner (brand "xvil" miễn trừ phạt, đuôi "075lbinh" bắt đầu bằng số
// nên bị bỏ qua khi phạt từ thừa) → hòa 100-100, tie-break "ít từ hơn thắng"
// chọn Xvil 91k — NHẦM BRAND, match 100 "tự tin" không báo nghi vấn.
// Fix: "thùng" là quy đổi số lượng của CHÍNH SP đó (kvCodeThùng = mã gốc "-1")
// → không đủ tư cách "đòi đơn vị khác", alias giữ tuyệt đối.
describe('Golden 09/25: "thùng" không được lật alias "chain cleaner" sang Xvil', () => {
  const CHAIN_PRODUCTS = [
    { id: 'znt_mxo_topgear_gp_chain_cleaner', name: 'Zentor Topgear GP Chain Cleaner (0,4L/bình)', spec: 'Chăm sóc xe', packaging: '400ml x 12 chai', unit: 'chai', campaignKey: 'znt_mxo' },
    { id: 'xvil_xvil_chain_cleaner_750ml', name: 'Xvil Chain Cleaner (0,75L/bình)', spec: 'Chăm sóc xe', packaging: '0,75L', unit: 'chai', campaignKey: 'xvil' },
  ];
  const LEARNED = { 'chain cleaner': 'znt_mxo_topgear_gp_chain_cleaner' };

  it('hint "thùng" → alias thắng tuyệt đối → bản Zentor (không nhả cho fuzzy)', () => {
    const r = findBestProductMatch('chain cleaner', CHAIN_PRODUCTS, LEARNED, 'thùng');
    assert.ok(r);
    assert.equal(r.product.id, 'znt_mxo_topgear_gp_chain_cleaner',
      `got: ${r.product.id} via ${r.via} score ${r.score}`);
    assert.equal(r.via, 'alias', 'Phải là alias trực tiếp, không phải fuzzy-unit-over-alias');
  });

  it('hint "chai" → bản Zentor như cũ', () => {
    const r = findBestProductMatch('chain cleaner', CHAIN_PRODUCTS, LEARNED, 'chai');
    assert.ok(r);
    assert.equal(r.product.id, 'znt_mxo_topgear_gp_chain_cleaner');
  });

  it('alias Off Road + hint "thùng" cũng giữ tuyệt đối (không lật sang Xvil Xtorq)', () => {
    const PRODUCTS = [
      { id: 'znt_mxo_topgear_gp_chain_lube_off_road', name: 'Zentor Topgear CP Chain Lube Off Road (0,4L/bình)', spec: 'Chăm sóc xe', packaging: '400ml x 12 chai', unit: 'chai', campaignKey: 'znt_mxo' },
      { id: 'xvil_xvil_xtorq_chain_offroad_750ml', name: 'Xvil X-Torq Chain Offroad (0,75L/bình)', spec: 'Chăm sóc xe', packaging: '0,75L', unit: 'chai', campaignKey: 'xvil' },
    ];
    const ALIASES = { 'chain lube off road': 'znt_mxo_topgear_gp_chain_lube_off_road' };
    const r = findBestProductMatch('chain lube offroad', PRODUCTS, ALIASES, 'thùng');
    assert.ok(r);
    assert.equal(r.product.id, 'znt_mxo_topgear_gp_chain_lube_off_road',
      `got: ${r.product.id} via ${r.via} score ${r.score}`);
  });
});

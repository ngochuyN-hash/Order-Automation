/**
 * Regression test cho TLN coverage (src/order/tln-coverage.mjs)
 * + unit bonus/penalty trong findBestProductMatch (parser.js).
 *
 * Bug gốc: tin nhắn MỘT dòng chứa @mention kiểu
 *   "@Nguyễn Ngọc Huy Lên đơn Sửa xe Hiệp Phát: ... @Hoa Nguyễn"
 * khiến tlnCoversRawText luôn fail (AI được lệnh bỏ @mentions/cụm lệnh nên
 * token tên người không có trong output) → TLN rớt về dòng thô, không chia ý.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractMentionSpans,
  stripCommandPrefix,
  tlnCoversRawText,
  splitRawIntoTlnLines,
  refineAiTlnLines,
} from '../src/order/tln-coverage.mjs';
import { findBestProductMatch } from '../parser.js';

// ── Đơn hàng mẫu của user (Hiệp Phát, 2026-08) ────────────────────────────
const HIEP_PHAT_MSG =
  '@Nguyễn Ngọc Huy Lên đơn Sửa xe Hiệp Phát: 1 thùng Prostream scooter 5W40, ' +
  '5 chai nhớt láp 80W90, 5 chai nước mát Prostream Coolant. Mai giao đơn Hiệp Phát cho chị nha @Hoa Nguyễn';

// AI chia cắt theo đúng prompt: bỏ @mentions, chỉ giữ phần sau ":" của lệnh,
// tách từng ý — mỗi dòng 1 món/dặn dò.
const AI_LINES_HIEP_PHAT = [
  'Sửa xe Hiệp Phát:',
  '1 thùng Prostream scooter 5W40',
  '5 chai nhớt láp 80W90',
  '5 chai nước mát Prostream Coolant.',
  'Mai giao đơn Hiệp Phát cho chị nha',
];

test('TLN coverage: đơn 1 dòng có @mention + cụm "Lên đơn" phải PASS', () => {
  assert.equal(tlnCoversRawText(AI_LINES_HIEP_PHAT, [HIEP_PHAT_MSG], 'Sửa xe Hiệp Phát'), true);
});

test('TLN coverage: AI giữ nguyên cụm lệnh "lên đơn" vẫn PASS', () => {
  const aiLines = [
    'Lên đơn Sửa xe Hiệp Phát:',
    '1 thùng Prostream scooter 5W40',
    '5 chai nhớt láp 80W90',
    '5 chai nước mát Prostream Coolant.',
    'Mai giao đơn Hiệp Phát cho chị nha @Hoa Nguyễn',
  ];
  assert.equal(tlnCoversRawText(aiLines, [HIEP_PHAT_MSG], 'Sửa xe Hiệp Phát'), true);
});

test('TLN coverage: AI dồn nhiều ý vào 1 dòng (khác vị trí tách) vẫn PASS qua token fallback', () => {
  const aiLines = [
    '1 thùng Prostream scooter 5W40, 5 chai nhớt láp 80W90, 5 chai nước mát Prostream Coolant. Mai giao đơn Hiệp Phát cho chị nha',
  ];
  // Tên khách nằm trong trường customer (sanitizer đã tách) → tính vào "hay"
  assert.equal(tlnCoversRawText(aiLines, [HIEP_PHAT_MSG], 'Sửa xe Hiệp Phát'), true);
});

test('TLN coverage: đơn nhiều dòng KHÔNG mention vẫn PASS (giữ hành vi cũ)', () => {
  const rawLines = ['Hiệp Phát', '2 thùng Fast Scoot', 'FOC 1 chai Coolant'];
  const aiLines = ['Hiệp Phát', '2 thùng Fast Scoot', 'FOC 1 chai Coolant'];
  assert.equal(tlnCoversRawText(aiLines, rawLines, 'Hiệp Phát'), true);
});

test('TLN coverage: AI sót một món → vẫn FAIL để fallback dòng thô (an toàn)', () => {
  const aiLines = [
    'Sửa xe Hiệp Phát:',
    '1 thùng Prostream scooter 5W40',
    // thiếu "5 chai nhớt láp 80W90"
    'Mai giao đơn Hiệp Phát cho chị nha',
  ];
  assert.equal(tlnCoversRawText(aiLines, [HIEP_PHAT_MSG], 'Sửa xe Hiệp Phát'), false);
});

test('TLN coverage: rỗng — raw rỗng → true; AI rỗng mà raw có → false', () => {
  assert.equal(tlnCoversRawText(['a'], [], 'x'), true);
  assert.equal(tlnCoversRawText([], ['có nội dung'], 'x'), false);
});

test('extractMentionSpans: tách trọn tên nhiều từ, dừng ở động từ lệnh', () => {
  const { cleanedLine, mentionNames } = extractMentionSpans(
    '@Nguyễn Ngọc Huy Lên đơn Sửa xe Hiệp Phát: giao cho @Hoa Nguyễn'
  );
  assert.deepEqual(mentionNames.sort(), ['Hoa Nguyễn', 'Nguyễn Ngọc Huy']);
  assert.match(cleanedLine, /Lên đơn Sửa xe Hiệp Phát/);
  assert.doesNotMatch(cleanedLine, /@/);
  assert.doesNotMatch(cleanedLine, /Ngọc Huy/);
});

test('stripCommandPrefix: bỏ "(giúp em) lên đơn/lập đơn/order" ở đầu', () => {
  assert.equal(stripCommandPrefix('Lên đơn Sửa xe Hiệp Phát: 1 thùng').trim(), 'Sửa xe Hiệp Phát: 1 thùng');
  assert.equal(stripCommandPrefix('giúp em lap don ABC').trim(), 'ABC');
  assert.equal(stripCommandPrefix('order HDX: 2 chai').trim(), 'HDX: 2 chai');
  assert.equal(stripCommandPrefix('5 chai nước mát').trim(), '5 chai nước mát'); // không đụng dòng thường
});

// ── Lớp đảm bảo cuối: tách dòng quy tắc khi AI KHÔNG chia cắt được ─────────
test('splitRawIntoTlnLines: đơn Hiệp Phát không có bản AI → vẫn ngắt dòng đúng từng ý', () => {
  const lines = splitRawIntoTlnLines([HIEP_PHAT_MSG]);
  assert.deepEqual(lines, [
    'Sửa xe Hiệp Phát:',
    '1 thùng Prostream scooter 5W40',
    '5 chai nhớt láp 80W90',
    '5 chai nước mát Prostream Coolant',
    'Mai giao đơn Hiệp Phát cho chị nha',
  ]);
});

test('splitRawIntoTlnLines: phẩy thập phân và dòng SP kiểu "Model X : 1 thùng" không bị phá', () => {
  assert.deepEqual(
    splitRawIntoTlnLines(['mua 5 chai dầu 0,12 lít']),
    ['mua 5 chai dầu 0,12 lít']
  );
  assert.deepEqual(
    splitRawIntoTlnLines(['Zentor số TT 10w50 : 1 thùng']),
    ['Zentor số TT 10w50 : 1 thùng']
  );
});

test('splitRawIntoTlnLines: tách tại dấu "+" và giữ nguyên đơn nhiều dòng bình thường', () => {
  assert.deepEqual(
    splitRawIntoTlnLines(['2 thùng Fast Scoot + FOC 1 chai Coolant']),
    ['2 thùng Fast Scoot', 'FOC 1 chai Coolant']
  );
  // Đơn nhiều dòng không dấu câu — không đổi gì
  assert.deepEqual(
    splitRawIntoTlnLines(['Hiệp Phát', '2 thùng Fast Scoot', 'FOC 1 chai Coolant']),
    ['Hiệp Phát', '2 thùng Fast Scoot', 'FOC 1 chai Coolant']
  );
});

// ── Bug #2: unit mismatch penalty ──────────────────────────────────────────
const PRODUCTS = [
  { id: 'znt_topgear_trans_80w90', name: 'Zentor Topgear GP 4T Transmission Oil 80W90 (1L/chai)', unit: 'chai' },
  { id: 'znt_life_ext_80w90_gl5', name: 'Zentor Life Extension 80w90 GL5 (4L/bình)', unit: 'can' },
  { id: 'veltron_scooter_gear_80w90', name: 'VELTRON Scooter Gear Oil SAE 80W-90 (0,12l/tuýp)', unit: 'tuýp' },
];

test('Matching: "nhớt láp 80W90" + unit chai phải ưu tiên SP bán theo chai', () => {
  const m = findBestProductMatch('nhớt láp 80W90', PRODUCTS, {}, 'chai');
  assert.ok(m, 'phải có match');
  assert.equal(m.product.id, 'znt_topgear_trans_80w90');
});

// ── refineAiTlnLines: AI lười chia (cả đoạn trong 1 phần tử tln) ───────────
test('refineAiTlnLines: bẻ đoạn dài nhiều dữ kiện hàng thành từng dòng ý', () => {
  const lazy = ['2 thùng fast 4t 800ml giá 110k/chai, tặng 60 tuýp torvex gear oil, thanh toán cn, hđ lẻ'];
  const out = refineAiTlnLines(lazy);
  assert.deepEqual(out, [
    '2 thùng fast 4t 800ml giá 110k/chai',
    'tặng 60 tuýp torvex gear oil',
    'thanh toán cn',
    'hđ lẻ',
  ]);
});

test('refineAiTlnLines: dòng 1 dữ kiện hàng / địa chỉ dài KHÔNG bị bẻ', () => {
  const one = ['5 chai Zentor Coolant Evo'];
  const addr = ['Giao kho 25 Lê Lợi Q5, liên hệ anh Phú 0903123456, cổng sau'];
  assert.deepEqual(refineAiTlnLines(one), one);
  // Địa chỉ có dấu phẩy nhưng chỉ 0 cụm số+đơn vị dạng hàng → giữ nguyên
  assert.deepEqual(refineAiTlnLines(addr), addr);
});

test('refineAiTlnLines: không mất token so với bản AI gốc (đủ lời sales)', () => {
  const lazy = [
    'Sửa xe Minh Khôi: 2 thùng fast 4t 800ml giá 110k/chai; tặng 60 tuýp torvex gear oil. Thanh toán CN qua lễ, Quản Lý duyệt',
  ];
  const out = refineAiTlnLines(lazy);
  const joined = out.join(' ').replace(/[.,;]/g, ' ').replace(/\s+/g, ' ').toLowerCase();
  for (const tok of ['2 thùng fast 4t 800ml', '110k/chai', '60 tuýp torvex gear oil', 'quản lý duyệt']) {
    assert.ok(joined.includes(tok), `mất token: ${tok}`);
  }
});

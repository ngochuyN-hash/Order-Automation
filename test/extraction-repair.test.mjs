import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findMissingQtyLines,
  analyzeExtraction,
  buildRepairPrompt,
  mergeRepairedItems,
  repairMissingExtraction,
  splitQtySegments,
} from '../src/order/extraction-repair.js';

// Đơn mẫu của Sales (case thực tế Trần Văn Hải)
const ORDER_TEXT = [
  'Trần Văn Hải',
  '1 phuy moto xp 10w40 60L',
  '1th torvex furious racing',
  '1 thùng fast 4T 1L',
  '1thùng fast 4T 800ml',
  'Thanh toán ck',
  'HĐ báo sau',
].join('\n');

const FULL_ITEMS = [
  { qty: 1, unit: 'phuy', rawProduct: 'moto xp 10w40 60L' },
  { qty: 1, unit: 'thùng', rawProduct: 'torvex furious racing' },
  { qty: 1, unit: 'thùng', rawProduct: 'fast 4T 1L' },
  { qty: 1, unit: 'thùng', rawProduct: 'fast 4T 800ml' },
];

describe('findMissingQtyLines', () => {
  it('đơn đầy đủ → không báo thiếu', () => {
    assert.deepEqual(findMissingQtyLines(ORDER_TEXT, FULL_ITEMS), []);
  });

  it('AI sót dòng "fast 4T 800ml" → phát hiện đúng dòng', () => {
    // Kịch bản lỗi thật: AI gộp/đánh rơi dòng khác dung tích
    const items = FULL_ITEMS.slice(0, 3);
    const missing = findMissingQtyLines(ORDER_TEXT, items);
    assert.equal(missing.length, 1);
    assert.match(missing[0], /800ml/);
  });

  it('AI mất luôn số dung tích trong tên → 2 dòng fast vẫn được phân biệt', () => {
    const items = [
      { qty: 2, unit: 'thùng', rawProduct: 'fast 4T' },
      { qty: 1, unit: 'phuy', rawProduct: 'moto xp 10w40 60L' },
    ];
    const missing = findMissingQtyLines(ORDER_TEXT, items);
    // Cả dòng 1L lẫn 800ml đều không cover
    assert.equal(missing.length, 2);
  });

  it('dòng quà tặng được cover qua explicitGift.name', () => {
    const text = '3 thùng Fast\nFOC 2 lon Prostream\nThanh toán ck';
    const items = [{ qty: 3, unit: 'thùng', rawProduct: 'Fast', explicitGift: { qty: 2, name: 'Prostream lon', unit: 'lon' } }];
    assert.deepEqual(findMissingQtyLines(text, items), []);
  });

  it('dòng chỉ toàn giá/số không bị báo thiếu giả', () => {
    const text = 'đơn ABC\n158k\nHĐ sau\n1 thùng fast';
    const items = [{ qty: 1, unit: 'thùng', rawProduct: 'fast' }];
    assert.deepEqual(findMissingQtyLines(text, items), []);
  });
});

describe('buildRepairPrompt', () => {
  it('prompt chứa đúng các dòng thiếu', () => {
    const p = buildRepairPrompt(['1 thùng fast 4T 800ml']);
    assert.match(p, /CHƯA được trích xuất/);
    assert.match(p, /800ml/);
  });
});

// ─── BUG THẬT (đơn Hoàng Long): AI gộp 2 dòng Veltron thành 1 → output chỉ 1 dòng ───
const VELTRON_TEXT = [
  'Hoàng Long',
  '10 thùng veltron racing uflow 10w40 giá 85k/chai',
  '20 thùng VELTRON Motobike 4T Ester 10W40 - 1L giá 51k/chai',
  'TT CN',
].join('\n');

const VELTRON_OK_ITEMS = [
  { qty: 10, unit: 'thùng', rawProduct: 'veltron racing uflow 10w40' },
  { qty: 20, unit: 'thùng', rawProduct: 'VELTRON Motobike 4T Ester 10W40 - 1L' },
];

describe('analyzeExtraction — chống gộp dòng (bug Hoàng Long)', () => {
  it('trích xuất ĐÚNG 2 dòng có "giá .../chai" → KHÔNG báo lỗi giả', () => {
    const { missing, suspects } = analyzeExtraction(VELTRON_TEXT, VELTRON_OK_ITEMS);
    assert.deepEqual(missing, []);
    assert.deepEqual(suspects, []);
  });

  it('AI GỘP 2 dòng thành 1 item (qty 30) → phát hiện nghi gộp', () => {
    const merged = [{ qty: 30, unit: 'thùng', rawProduct: 'veltron racing uflow 10w40 motobike 4t ester 10w40 1l' }];
    const { suspects } = analyzeExtraction(VELTRON_TEXT, merged);
    assert.equal(suspects.length, 1);
    assert.equal(suspects[0].itemIndex, 0);
    // Cả 2 dòng phải được đưa đi trích xuất lại
    assert.equal(suspects[0].coveredLines.length, 2);
  });

  it('AI gộp nhưng chỉ giữ tên dòng 1 → dòng 2 missing, dòng 1 nghi gộp (lệch qty)', () => {
    const merged = [{ qty: 30, unit: 'thùng', rawProduct: 'veltron racing uflow 10w40' }];
    const { missing, suspects } = analyzeExtraction(VELTRON_TEXT, merged);
    assert.equal(missing.length, 1);
    assert.match(missing[0], /Motobike/);
    assert.equal(suspects.length, 1);
    assert.match(suspects[0].lines[0], /uflow/);
  });

  it('item quà (isGift) không bị nghi gộp dù lệch qty', () => {
    const text = '5 thùng fast\nFOC 2 lon fast';
    const items = [
      { qty: 5, unit: 'thùng', rawProduct: 'fast' },
      { qty: 99, unit: 'lon', rawProduct: 'fast', isGift: true },
    ];
    const { missing, suspects } = analyzeExtraction(text, items);
    assert.deepEqual(missing, []);
    assert.deepEqual(suspects, []);
  });
});

describe('repairMissingExtraction — vá ca gộp dòng', () => {
  it('AI gộp 1 item qty 30 → gỡ item gộp, trích lại → ra đúng 2 items', async () => {
    const parsedJson = {
      customer: 'Hoàng Long', payment: 'tt',
      items: [{ qty: 30, unit: 'thùng', rawProduct: 'veltron racing uflow 10w40 motobike 4t ester 10w40 1l' }],
    };
    let calls = 0;
    const aiCallFn = async () => {
      calls++;
      return { items: [
        { qty: 10, unit: 'thùng', rawProduct: 'veltron racing uflow 10w40' },
        { qty: 20, unit: 'thùng', rawProduct: 'VELTRON Motobike 4T Ester 10W40 - 1L' },
      ] };
    };
    const res = await repairMissingExtraction(aiCallFn, parsedJson, VELTRON_TEXT);
    assert.equal(calls, 1, 'chỉ gọi AI bổ sung đúng 1 lần');
    assert.equal(parsedJson.items.length, 2, 'item gộp bị gỡ, thay bằng 2 item riêng');
    assert.deepEqual(parsedJson.items.map(i => i.qty).sort((a, b) => a - b), [10, 20]);
    assert.equal(res.added.length, 2);
    assert.ok(res.mergedLines.length >= 1);
  });

  it('trích xuất đúng ngay từ đầu → KHÔNG gọi AI bổ sung', async () => {
    let calls = 0;
    const aiCallFn = async () => { calls++; return { items: [] }; };
    const res = await repairMissingExtraction(aiCallFn, { items: VELTRON_OK_ITEMS }, VELTRON_TEXT);
    assert.equal(calls, 0);
    assert.deepEqual(res.missing, []);
    assert.deepEqual(res.mergedLines, []);
  });

  it('AI bổ sung thất bại → GIỮ NGUYÊN item cũ (không xóa suspect khi chưa có đồ thay)', async () => {
    const parsedJson = {
      items: [{ qty: 30, unit: 'thùng', rawProduct: 'veltron racing uflow 10w40 motobike 4t ester 10w40 1l' }],
    };
    const aiCallFn = async () => { throw new Error('network down'); };
    const res = await repairMissingExtraction(aiCallFn, parsedJson, VELTRON_TEXT);
    assert.equal(parsedJson.items.length, 1, 'không được xóa item khi repair thất bại');
    assert.deepEqual(res.added, []);
  });
});

describe('mergeRepairedItems', () => {
  it('thêm item mới, giữ item cũ', () => {
    const merged = mergeRepairedItems(FULL_ITEMS.slice(0, 3), [
      { qty: 1, unit: 'thùng', rawProduct: 'fast 4T 800ml' },
    ]);
    assert.equal(merged.length, 4);
    assert.equal(merged[3].rawProduct, 'fast 4T 800ml');
  });

  it('skip item trùng (tên chuẩn-hoá + qty + unit)', () => {
    const merged = mergeRepairedItems(FULL_ITEMS.slice(0, 3), [
      { qty: 1, unit: 'thùng', rawProduct: 'FAST 4T 1L' }, // trùng dòng 3 sau norm
    ]);
    assert.equal(merged.length, 3);
  });

  it('skip item vô nghĩa (qty<=0 hoặc không tên)', () => {
    const merged = mergeRepairedItems([], [
      { qty: 0, unit: 'thùng', rawProduct: 'X' },
      { qty: -1, unit: 'chai', rawProduct: 'Y' },
      { qty: 2, unit: 'thùng', rawProduct: '' },
    ]);
    assert.equal(merged.length, 0);
  });
});

describe('repairMissingExtraction', () => {
  it('không thiếu → KHÔNG gọi AI', async () => {
    let calls = 0;
    const aiCallFn = async () => { calls++; return { items: [] }; };
    const res = await repairMissingExtraction(aiCallFn, { items: FULL_ITEMS }, ORDER_TEXT);
    assert.equal(calls, 0);
    assert.deepEqual(res.missing, []);
    assert.deepEqual(res.added, []);
  });

  it('thiếu 1 dòng → gọi AI đúng 1 lần với prompt chứa dòng thiếu rồi merge', async () => {
    const prompts = [];
    const aiCallFn = async (prompt) => {
      prompts.push(prompt);
      return { items: [{ qty: 1, unit: 'thùng', rawProduct: 'fast 4T 800ml' }] };
    };
    const parsedJson = { customer: 'Trần Văn Hải', items: FULL_ITEMS.slice(0, 3) };
    const res = await repairMissingExtraction(aiCallFn, parsedJson, ORDER_TEXT);

    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /800ml/);
    assert.equal(parsedJson.items.length, 4); // mutate tại chỗ
    assert.equal(res.added.length, 1);
    assert.equal(res.missing.length, 1);
  });

  it('AI bổ sung lỗi/ném exception → trả nguyên parsedJson, không crash', async () => {
    const aiCallFn = async () => { throw new Error('network down'); };
    const parsedJson = { items: FULL_ITEMS.slice(0, 3) };
    const res = await repairMissingExtraction(aiCallFn, parsedJson, ORDER_TEXT);
    assert.equal(res.parsedJson.items.length, 3);
    assert.deepEqual(res.added, []);
    assert.equal(res.missing.length, 1);
  });

  it('AI bổ sung không trả items hợp lệ → không merge gì', async () => {
    const aiCallFn = async () => ({ foo: 'bar' });
    const parsedJson = { items: FULL_ITEMS.slice(0, 3) };
    const res = await repairMissingExtraction(aiCallFn, parsedJson, ORDER_TEXT);
    assert.equal(res.parsedJson.items.length, 3);
    assert.deepEqual(res.added, []);
  });
});

// ─── Đơn viết trên CÙNG 1 dòng (không xuống hàng, không dấu ngăn cách) ───
const VELTRON_ONE_LINE = 'Hoàng Long 10 thùng veltron racing uflow 10w40 giá 85k/chai 20 thùng VELTRON Motobike 4T Ester 10W40 - 1L giá 51k/chai TT CN';

describe('splitQtySegments — tách đoạn trong 1 dòng', () => {
  it('tách đúng 2 đoạn tại cụm số+đơn vị, prefix là tên khách', () => {
    const segs = splitQtySegments(VELTRON_ONE_LINE);
    assert.equal(segs.length, 2);
    assert.equal(segs[0].prefix, 'Hoàng Long');
    assert.match(segs[0].text, /^10 thùng/);
    assert.match(segs[0].text, /85k\/chai$/);
    assert.equal(segs[1].prefix, '');
    assert.match(segs[1].text, /^20 thùng/);
  });

  it('cụm số+đơn vị sau tặng/foc/giá KHÔNG là ranh giới (quà kèm/mốc giá)', () => {
    assert.equal(splitQtySegments('3 thùng fast tặng 2 chai nước rửa').length, 1);
    assert.equal(splitQtySegments('1 lít giá 2 thùng bao nhiêu').length, 1);
  });

  it('dòng 1 SP có mảnh dung tích cuối tên → vẫn tách nhưng tầng analyze bỏ đoạn rỗng chữ ký', () => {
    const segs = splitQtySegments('5 chai dầu vantol 5 lít giá 50k');
    assert.equal(segs.length, 2);
    // analyzeExtraction phải bỏ đoạn "5 lít giá 50k" (không chữ ký)
    const items = [{ qty: 5, unit: 'chai', rawProduct: 'dầu vantol 5 lít' }];
    const { missing, suspects } = analyzeExtraction('5 chai dầu vantol 5 lít giá 50k', items);
    assert.deepEqual(missing, []);
    assert.deepEqual(suspects, []);
  });
});

describe('analyzeExtraction — đơn 1 dòng nhiều SP', () => {
  it('AI trích ĐÚNG 2 SP trên cùng dòng → KHÔNG báo lỗi giả', () => {
    const { missing, suspects } = analyzeExtraction(VELTRON_ONE_LINE, VELTRON_OK_ITEMS);
    assert.deepEqual(missing, []);
    assert.deepEqual(suspects, []);
  });

  it('AI GỘP 2 SP trên cùng dòng thành qty 30 → nghi gộp, đủ 2 đoạn đi trích lại', () => {
    const merged = [{ qty: 30, unit: 'thùng', rawProduct: 'veltron racing uflow 10w40 motobike 4t ester 10w40 1l' }];
    const { missing, suspects } = analyzeExtraction(VELTRON_ONE_LINE, merged);
    assert.deepEqual(missing, []);
    assert.equal(suspects.length, 1);
    assert.equal(suspects[0].itemIndex, 0);
    assert.equal(suspects[0].coveredLines.length, 2);
    assert.match(suspects[0].coveredLines[0], /^10 thùng/);
    assert.match(suspects[0].coveredLines[1], /^20 thùng/);
  });

  it('mã thanh toán đuôi dòng (TT CN / CK) không làm sai chữ ký', () => {
    const text = '2 thùng shell helix ultra 5w30 TT CN';
    const items = [{ qty: 2, unit: 'thùng', rawProduct: 'shell helix ultra 5w30' }];
    const { missing, suspects } = analyzeExtraction(text, items);
    assert.deepEqual(missing, []);
    assert.deepEqual(suspects, []);
  });
});

describe('repairMissingExtraction — vá ca gộp trên 1 dòng', () => {
  it('AI gộp 2 SP cùng dòng → gỡ item gộp, trích lại từ 2 đoạn → ra đúng 2 items', async () => {
    const parsedJson = {
      customer: 'Hoàng Long',
      items: [{ qty: 30, unit: 'thùng', rawProduct: 'veltron racing uflow 10w40 motobike 4t ester 10w40 1l' }],
    };
    let calls = 0;
    let seenPrompt = '';
    const aiCallFn = async (prompt) => {
      calls++;
      seenPrompt = prompt;
      return { items: VELTRON_OK_ITEMS.map(i => ({ ...i })) };
    };
    const res = await repairMissingExtraction(aiCallFn, parsedJson, VELTRON_ONE_LINE);
    assert.equal(calls, 1);
    // Prompt phải chứa TỪNG ĐOẠN riêng để AI trích riêng
    assert.match(seenPrompt, /10 thùng veltron racing/);
    assert.match(seenPrompt, /20 thùng VELTRON Motobike/);
    assert.equal(parsedJson.items.length, 2);
    assert.deepEqual(parsedJson.items.map(i => i.qty).sort((a, b) => a - b), [10, 20]);
    assert.equal(res.added.length, 2);
  });
});

describe('analyzeExtraction — số lượng viết bằng CHỮ (chuẩn hóa trước khi quét)', () => {
  const TEXT_WORDS = [
    'Hoàng Long',
    'hai mươi thùng veltron racing uflow 10w40 giá 85k/chai',
    'mười thùng VELTRON Motobike 4T Ester giá 51k/chai',
    'TT CN',
  ].join('\n');
  const ITEMS_WORDS = [
    { qty: 20, unit: 'thùng', rawProduct: 'veltron racing uflow 10w40' },
    { qty: 10, unit: 'thùng', rawProduct: 'VELTRON Motobike 4T Ester' },
  ];

  it('AI trích đủ 2 SP ghi bằng số-chữ → KHÔNG báo thiếu giả', () => {
    const { missing, suspects } = analyzeExtraction(TEXT_WORDS, ITEMS_WORDS);
    assert.deepEqual(missing, [], `missing phải rỗng, thực tế: ${JSON.stringify(missing)}`);
    assert.deepEqual(suspects, []);
  });

  it('AI bỏ sót dòng số-chữ → tầng repair VẪN phát hiện được (đã quy về số)', () => {
    const missing = findMissingQtyLines(TEXT_WORDS, [ITEMS_WORDS[0]]);
    assert.equal(missing.length, 1);
    // Dòng báo thiếu đã được chuẩn hóa "mười" → "10" để prompt repair dễ đọc
    assert.match(missing[0], /^10 thùng/);
  });

  it('AI gộp 2 dòng số-chữ thành qty 30 → nghi gộp đúng item', () => {
    const merged = [{ qty: 30, unit: 'thùng', rawProduct: 'veltron racing uflow 10w40 motobike 4t ester' }];
    const { missing, suspects } = analyzeExtraction(TEXT_WORDS, merged);
    assert.deepEqual(missing, []);
    assert.equal(suspects.length, 1);
    assert.equal(suspects[0].coveredLines.length, 2);
  });
});

describe('dòng mốc giá đứng riêng ("Giá 2 thùng") không phải dòng sản phẩm thiếu', () => {
  it('"Giá 2 thùng" standalone → không bị báo là dòng SP bị sót', () => {
    assert.deepEqual(findMissingQtyLines('Giá 2 thùng', []), []);
  });

  it('đơn có "Giá 2 thùng" + item đủ cover → missing rỗng, không sinh dòng "Giá" ma', () => {
    const text = ['1 thùng chain cleaner', 'Giá 2 thùng'].join('\n');
    const items = [{ qty: 1, unit: 'thùng', rawProduct: 'chain cleaner' }];
    assert.deepEqual(findMissingQtyLines(text, items), []);
  });

  it('"giá thùng" (mốc 1) cũng được bỏ qua như dòng mốc giá', () => {
    const text = ['2 thùng fast 4T 1L', 'giá thùng'].join('\n');
    const items = [{ qty: 2, unit: 'thùng', rawProduct: 'fast 4T 1L' }];
    assert.deepEqual(findMissingQtyLines(text, items), []);
  });
});

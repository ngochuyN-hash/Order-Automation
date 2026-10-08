/**
 * Tests cho note-sanitizer — lọc dòng sản phẩm lặp khỏi notes/TLN.
 * Run: node --test test/note-sanitizer.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeAiExtraction, customerFirstComment } from '../src/order/note-sanitizer.js';

describe('sanitizeAiExtraction — cắt dòng sản phẩm lặp khỏi notes', () => {
  it('ca thực tế: ghi chú KV chỉ còn thông tin khách, dòng SP bị cắt hết', () => {
    const j = {
      customer: 'Hàng gửi nhà xe Bình An',
      items: [
        { rawProduct: 'Zentor hp 2T 10w30', qty: 1, unit: 'chai', explicitPrice: 170017 },
        { rawProduct: 'Zentor ga 0w30', qty: 3 },
        { rawProduct: 'Zentor số TT 10w30', qty: 1 },
        { rawProduct: 'Zentor số TT 10w40', qty: 1 },
        { rawProduct: 'Zentor số TT 10w50', qty: 1 },
        { rawProduct: 'Dầu phước 2.5', qty: 1 },
        { rawProduct: 'Dầu phước 5', qty: 1 },
        { rawProduct: 'Dầu phước 7.5', qty: 1 },
      ],
      notes: [
        'Anh Nam - 0999888777',
        'Zentor hp 2T 10w30 - 1 chai 143k',
        'Zentor ga 0w30 - 3 thùng',
        'Zentor số TT 10w30 : 1 thùng',
        'Zentor số TT 10w40 : 1 thùng',
        'Zentor số TT 10w50 : 1 thùng',
        'Dầu phước 2.5 - 1 thùng',
        'Dầu phước 5 - 1 thùng',
        'Dầu phước 7.5 - 1 thùng',
      ],
    };
    sanitizeAiExtraction(j);
    assert.deepEqual(j.notes, ['Anh Nam - 0999888777']);
  });

  it('giữ dặn dò giá khi item CHƯA mang giá', () => {
    const j = {
      customer: 'HDX',
      items: [{ rawProduct: 'Torvex đô', qty: 62 }],
      notes: ['Torvex đô giá 134,330 x 62 lon'],
    };
    sanitizeAiExtraction(j);
    assert.deepEqual(j.notes, ['Torvex đô giá 134,330 x 62 lon']);
  });

  it('cắt dòng trùng khi item ĐÃ mang explicitPrice, giữ dặn dò khác', () => {
    const j = {
      customer: 'HDX',
      items: [{ rawProduct: 'Torvex đô', qty: 62, explicitPrice: 134330 }],
      notes: ['Torvex đô giá 134,330 x 62 lon', 'giao gấp trong ngày'],
    };
    sanitizeAiExtraction(j);
    assert.deepEqual(j.notes, ['giao gấp trong ngày']);
  });

  it('giữ dòng nhắc SP nhưng số lượng KHÁC item (thông tin mới)', () => {
    const j = {
      customer: 'X',
      items: [{ rawProduct: 'Zentor số TT 10w50', qty: 1 }],
      notes: ['Zentor số TT 10w50 : đổi sang 2 thùng'],
    };
    sanitizeAiExtraction(j);
    assert.deepEqual(j.notes, ['Zentor số TT 10w50 : đổi sang 2 thùng']);
  });

  it('không cắt nhầm tên SP là tiền tố số của SP khác (dầu phước 5 vs 50)', () => {
    const j = {
      customer: 'X',
      items: [{ rawProduct: 'Dầu phước 5', qty: 1 }],
      notes: ['Dầu phước 50 - 1 thùng'],
    };
    sanitizeAiExtraction(j);
    assert.deepEqual(j.notes, ['Dầu phước 50 - 1 thùng']);
  });

  it('FOC/quà tặng vẫn xử lý như cũ, không bị cắt nhầm', () => {
    const j = {
      customer: '',
      items: [],
      notes: ['FOC 2 cái áo mưa cho Rửa xe AP'],
    };
    sanitizeAiExtraction(j);
    assert.deepEqual(j.notes, []);
    assert.equal(j.customer, 'Rửa xe AP');
    assert.equal(j.items.filter(i => i.isGift).length, 1);
  });

  it('TLN giữ nguyên văn dòng sản phẩm (khối tóm tắt đơn)', () => {
    const j = {
      customer: 'X',
      items: [{ rawProduct: 'Zentor ga 0w30', qty: 3 }],
      notes: [],
      tln: ['0901234567 - Chị Lan', 'Zentor ga 0w30 - 3 thùng'],
    };
    sanitizeAiExtraction(j);
    assert.deepEqual(j.tln, ['0901234567 - Chị Lan', 'Zentor ga 0w30 - 3 thùng']);
  });
});

describe('customerFirstComment — hàng đầu ghi chú luôn là tên khách', () => {
  it('đặt tên khách lên hàng đầu, dặn dò bên dưới', () => {
    const out = customerFirstComment('Hàng gửi nhà xe Bình An', 'Anh Nam - 0999888777');
    assert.equal(out, 'Hàng gửi nhà xe Bình An\nAnh Nam - 0999888777');
  });

  it('không lặp tên khách nếu đã có sẵn trong ghi chú', () => {
    const out = customerFirstComment('HDX', 'HDX\ngiao gấp trong ngày');
    assert.equal(out, 'HDX\ngiao gấp trong ngày');
    // Dòng CHỈ chứa tên khách (không dấu) vẫn bị khử trùng
    assert.equal(customerFirstComment('HDX', 'hdx'), 'HDX');
    // Dòng chứa tên khách KÈM thông tin khác → giữ nguyên
    assert.equal(customerFirstComment('HDX', 'hdx - giao gấp'), 'HDX\nhdx - giao gấp');
  });

  it('không có khách → giữ nguyên ghi chú; không có ghi chú → chỉ tên khách', () => {
    assert.equal(customerFirstComment('', 'giao trước 10h'), 'giao trước 10h');
    assert.equal(customerFirstComment('HDX', ''), 'HDX');
    assert.equal(customerFirstComment('', ''), '');
  });
});


describe('quà tuýp — đơn vị tuýp được nhận diện, không lặp item lẻ', () => {
  it('dòng quà tuýp trong notes thành 1 item isGift duy nhất', () => {
    const j = {
      customer: '',
      items: [],
      notes: ['tặng 60 tuýp torvex gear oil'],
    };
    sanitizeAiExtraction(j);
    const gifts = j.items.filter(i => i.isGift);
    assert.equal(gifts.length, 1);
    assert.equal(gifts[0].qty, 60);
    assert.equal(String(gifts[0].unit).toLowerCase(), 'tuýp');
    assert.deepEqual(j.notes, []);
  });

  it('item thường trùng tên + qty do LLM thiếu cờ isGift → chuyển thành quà, không push thêm', () => {
    const j = {
      customer: 'Minh Khôi',
      items: [
        { rawProduct: 'Fast 4T 800ml', qty: 2, unit: 'thùng' },
        { rawProduct: 'Torvex Gear Oil', qty: 60, unit: 'tuýp' },
      ],
      notes: ['tặng 60 tuýp torvex gear oil'],
    };
    sanitizeAiExtraction(j);
    const gear = j.items.filter(i => /gear oil/i.test(i.rawProduct || ''));
    assert.equal(gear.length, 1);
    assert.equal(gear[0].isGift, true);
    assert.equal(Number(gear[0].qty), 60);
  });
});

describe('sanitizeAiExtraction — lọc item "ma" chỉ gồm token meta (thanh toán / hóa đơn)', () => {
  it('bỏ item HĐ / TT CK / VAT do AI bịa, giữ item thật và giữ "HĐ" trong notes', () => {
    const j = {
      customer: 'ANYWHERE MAN',
      items: [
        { rawProduct: 'chain lube max', qty: 2, unit: 'thùng', isGift: false },
        { rawProduct: 'HĐ', qty: 2, unit: 'thùng', isGift: false },
        { rawProduct: 'TT CK', qty: 1, unit: 'thùng', isGift: false },
        { rawProduct: 'VAT', qty: 1, unit: 'chai', isGift: false },
        { rawProduct: 'hóa đơn', qty: 1, unit: 'thùng', isGift: false },
      ],
      notes: ['HĐ'],
      tln: [],
    };
    sanitizeAiExtraction(j);
    assert.equal(j.items.length, 1, 'Chỉ còn đúng item thật');
    assert.equal(j.items[0].rawProduct, 'chain lube max');
    assert.ok(j.notes.includes('HĐ'), 'Yêu cầu hóa đơn phải ở lại notes');
  });

  it('phần tử notes chứa "TÊN KHÁCH\\nHĐ" (một chuỗi có \\n) → tách, bỏ tên khách, giữ HĐ', () => {
    const j = {
      customer: 'ANYWHERE MAN',
      items: [{ rawProduct: 'chain lube max', qty: 2, unit: 'thùng', isGift: false }],
      notes: ['ANYWHERE MAN\nHĐ'],
      tln: [],
    };
    sanitizeAiExtraction(j);
    assert.deepEqual(j.notes, ['HĐ'], `notes phải còn đúng ["HĐ"], thực tế: ${JSON.stringify(j.notes)}`);
  });

  it('tên thật chứa từ khóa meta (không exact) không bị lọc oan', () => {
    const j = {
      customer: null,
      items: [
        { rawProduct: 'ck4 diesel', qty: 1, unit: 'phuy', isGift: false },
        { rawProduct: 'TT Racing', qty: 1, unit: 'chai', isGift: false },
      ],
      notes: [],
      tln: [],
    };
    sanitizeAiExtraction(j);
    assert.equal(j.items.length, 2, 'Item thật phải được giữ nguyên');
  });
});

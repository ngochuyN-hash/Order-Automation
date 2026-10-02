import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractJSON } from '../src/order/json-extractor.js';

describe('json-extractor', () => {
  it('parse JSON thuần', () => {
    const obj = extractJSON('{"customer":"Trần Văn Hải","items":[]}');
    assert.equal(obj.customer, 'Trần Văn Hải');
  });

  it('parse markdown fence đóng chuẩn', () => {
    const text = '```json\n{"customer":"ABC","items":[{"qty":1}]}\n```';
    const obj = extractJSON(text);
    assert.equal(obj.customer, 'ABC');
    assert.equal(obj.items.length, 1);
  });

  it('BUG THẬT TỪNG GẶP: fence chưa đóng + prose phía sau vẫn parse được', () => {
    // Gemini trả JSON hoàn chỉnh nhưng kèm fence mở đầu không đóng và giải thích đuôi
    const text = '```json\n{ "customer": "ANYWHERE MAN", "payment": "ck", "items": [ { "qty": 1, "rawProduct": "Chain Lube Max" } ] }\nĐây là kết quả trích xuất từ tin nhắn.';
    const obj = extractJSON(text);
    assert.equal(obj.customer, 'ANYWHERE MAN');
    assert.equal(obj.items[0].rawProduct, 'Chain Lube Max');
  });

  it('prose trước + JSON hoàn chỉnh + prose sau → lấy đúng JSON', () => {
    const text = 'Kết quả như sau:\n{"customer":null,"items":[1,2]}\nNếu cần chỉnh sửa hãy báo lại.';
    const obj = extractJSON(text);
    assert.deepEqual(obj.items, [1, 2]);
  });

  it('JSON kèm object nối đuôi (multi-part) → lấy object đầu tiên đủ ngoặc', () => {
    const text = '{"customer":"A","items":[]}\n{"customer":"B","items":[]}';
    const obj = extractJSON(text);
    assert.equal(obj.customer, 'A');
  });

  it('trailing comma tự động được làm sạch', () => {
    const obj = extractJSON('{"items":[{"qty":1},],"customer":"X"}');
    assert.equal(obj.customer, 'X');
    assert.equal(obj.items.length, 1);
  });

  it('xuống dòng THÔ bên trong string value được escape hộ', () => {
    const text = '{\n  "notes": [\n    "giao trước 10h\nkhông giao trưa"\n  ]\n}';
    const obj = extractJSON(text);
    assert.equal(obj.notes[0], 'giao trước 10h\nkhông giao trưa');
  });

  it('JSON bị cắt cụt (hết max_tokens) → repair giữ được phần đã có', () => {
    const text = '{"customer":"K","items":[{"qty":1,"unit":"thùng","rawProduct":"fast 4T 1L"},{"qty":2,"unit":"phuy","rawPro';
    const obj = extractJSON(text);
    assert.equal(obj.customer, 'K');
    assert.ok(Array.isArray(obj.items));
    assert.equal(obj.items.length, 1); // item thứ 2 mất do cắt — tầng extraction-repair sẽ vá
    assert.equal(obj.items[0].rawProduct, 'fast 4T 1L');
  });

  it('phản hồi rỗng → ném lỗi rõ ràng', () => {
    assert.throws(() => extractJSON('   '), /phản hồi rỗng/);
    assert.throws(() => extractJSON('....'), /phản hồi rỗng/);
    assert.throws(() => extractJSON(null), /phản hồi rỗng/);
  });

  it('không có JSON nào → ném lỗi kèm snippet', () => {
    assert.throws(() => extractJSON('Xin lỗi tôi không hiểu yêu cầu.'), /không phải JSON hợp lệ/);
  });
});

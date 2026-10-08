/**
 * Test hồi quy: dòng SỐ LƯỢNG 0 KHÔNG được biến thành 1 khi lên đơn KiotViet.
 *
 * Bối cảnh lỗi thật: `buildOrderData` (src/kiotviet/automation.js) từng dùng
 * `qty: r.qty || 1` — dòng SL 0 (kể cả "0" dạng chuỗi từ bảng đơn) bị NUỐT
 * thành SL 1 trong giỏ KiotViet, hàng tặng/dòng tạm thời 0 bị lên đơn oan.
 *
 * Hành vi chốt:
 *  - qty 0 / "0" (chuỗi) → BỎ khỏi payload KV.
 *  - qty hợp lệ (số hoặc chuỗi số dương) → GIỮ NGUYÊN, ép kiểu Number.
 *  - Hàng tặng (isGift) có SL hợp lệ vẫn giữ nguyên isGift/giftKind.
 *  - KHÔNG đụng hàng tặng giá 0đ có SL hợp lệ (giá 0 ≠ SL 0).
 *  - Input `rows` không bị mutate (so sánh snapshot trước/sau).
 *
 * Chạy: node --test test/kv-zero-qty.test.mjs
 * (nạp src/kiotviet/automation.js bằng vm + mock tối thiểu — không cần jsdom)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTOMATION_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'kiotviet', 'automation.js'), 'utf8');

/** Dựng context giả lập renderer tối thiểu rồi nạp automation.js thật vào VM. */
function loadAutomation(rows) {
  const context = vm.createContext({
    store: { getState: () => ({ currentOrder: { customer: 'Khách test', items: rows } }) },
    uiRenderer: { getOrderTableRows: () => ({ rows }) },
    db: {
      getAllProducts: () => [],
      getAliases: () => ({}),
      findProductById: () => null,
      getKvCode: (p) => (p && p.id) || ''
    },
    document: { getElementById: () => null },
    // Double của resolveSellerReceiver (src/seller/manager.js) — không có form,
    // không có DOM seller → sellerKey rỗng → "Người nhận đặt" rỗng.
    resolveSellerReceiver: () => '',
    console
  });
  const stripped = AUTOMATION_SRC
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];.*$/gm, '') // bỏ toàn bộ import
    .replace('export const KiotVietAutomation =', 'globalThis.KiotVietAutomation =');
  vm.runInContext(stripped, context, { filename: 'automation.js' });
  return context.KiotVietAutomation;
}

/** Dựng row đơn giống cấu trúc getOrderTableRows trả về. */
function mkRow(extra = {}) {
  return {
    type: 'matched',
    product: { id: 'P1', name: 'SP test' },
    productId: 'P1',
    productName: 'SP test',
    qty: 1,
    unit: 'chai',
    subtotal: 130017,
    bottlePrice: 130017,
    ...extra
  };
}

describe('KiotViet buildOrderData — lọc dòng SL 0 (không nuốt thành 1)', () => {
  it('qty 0 (số) và "0" (chuỗi) bị loại, dòng SL dương giữ nguyên', () => {
    const rows = [
      mkRow({ productId: 'P0', product: { id: 'P0', name: 'SP 0' }, qty: 0, subtotal: 0, bottlePrice: 0 }),
      mkRow({ productId: 'P1', product: { id: 'P1', name: 'SP 1' }, qty: '0', subtotal: 0, bottlePrice: 0 }),
      mkRow({ productId: 'P2', product: { id: 'P2', name: 'SP 2' }, qty: 2, subtotal: 200000, bottlePrice: 130017 })
    ];
    const data = loadAutomation(rows).buildOrderData();

    assert.deepEqual(
      data.items.map(i => i.qty), [2],
      'Chỉ còn dòng SL dương; 0 và "0" bị loại, KHÔNG biến thành 1');
    assert.equal(data.items[0].qty, 2, 'SL dương giữ nguyên giá trị số');
  });

  it('qty chuỗi số dương được ép kiểu Number', () => {
    const rows = [mkRow({ qty: '3', subtotal: 300000 })];
    const data = loadAutomation(rows).buildOrderData();
    assert.equal(data.items.length, 1);
    assert.equal(data.items[0].qty, 3);
    assert.ok(Number.isInteger(data.items[0].qty), 'Phải là số, không phải chuỗi');
  });

  it('Hàng tặng giá 0đ có SL hợp lệ vẫn được giữ nguyên (isGift + giftKind)', () => {
    const rows = [
      mkRow({ productId: 'G1', product: { id: 'G1', name: 'Quà FOC' }, productName: 'Quà FOC', qty: 1, subtotal: 0, bottlePrice: 0, isGift: true, giftKind: 'foc' }),
      mkRow({ productId: 'M1', product: { id: 'M1', name: 'SP mua' }, productName: 'SP mua', qty: 2, subtotal: 200000, bottlePrice: 130017 })
    ];
    const data = loadAutomation(rows).buildOrderData();
    assert.equal(data.items.length, 2, 'Quà SL 1 hợp lệ không bị lọc');
    const gift = data.items.find(i => i.name === 'Quà FOC');
    assert.ok(gift, 'Dòng quà phải còn trong payload KV');
    assert.equal(gift.isGift, true);
    assert.equal(gift.giftKind, 'foc');
  });

  it('Không mutate input rows', () => {
    const rows = [
      mkRow({ qty: 0, subtotal: 0, bottlePrice: 0 }),
      mkRow({ qty: '5', subtotal: 500000 })
    ];
    const before = JSON.stringify(rows);
    loadAutomation(rows).buildOrderData();
    assert.equal(JSON.stringify(rows), before, 'buildOrderData chỉ đọc, không sửa rows');
  });
});

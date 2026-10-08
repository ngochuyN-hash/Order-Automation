/**
 * Test kiểm tra tính năng toggle FOC ↔ Extra trên mọi loại hàng khi giá 0đ
 * (Hàng khớp danh mục, hàng chưa khớp, hàng tự nhập isCustom, quà tặng mốc FOC/MKT).
 * Chạy: node --test test/foc-extra-toggle.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { db, DEFAULT_DB } from '../db.js';

db.data = JSON.parse(JSON.stringify(DEFAULT_DB));
globalThis.db = db;

const { uiRenderer } = await import('../ui-renderer.js');

describe('FOC/Extra toggle và orderTableSignature khi giá 0đ', () => {
  const sampleProduct = db.findProductById('znt_mxo_topgear_gp_ester_5w40');

  it('orderTableSignature thay đổi khi currentOrder.giftKindOverrides thay đổi (không bị nuốt cache)', () => {
    const order = {
      items: [
        {
          product: sampleProduct,
          qty: 2,
          unit: 'thùng',
          manualPrice: 0,
          subtotal: 0
        }
      ],
      giftKindOverrides: {}
    };

    const sig1 = uiRenderer.getOrderTableSignature(order);
    order.giftKindOverrides = { item_0: 'extra' };
    const sig2 = uiRenderer.getOrderTableSignature(order);

    assert.notEqual(sig1, sig2, 'Signature phải khác nhau khi đổi giftKindOverrides để vô hiệu cache');
    assert.ok(sig2.includes('"item_0":"extra"'), 'Signature phải chứa override');
  });

  it('Hàng khớp danh mục có giá 0đ: mặc định foc và đổi sang extra qua override', () => {
    const order = {
      items: [
        {
          product: sampleProduct,
          qty: 1,
          unit: 'thùng',
          manualPrice: 0,
          subtotal: 0
        }
      ],
      giftKindOverrides: {}
    };

    const res1 = uiRenderer.getOrderTableRows(order);
    const row1 = res1.rows[0];
    assert.equal(row1.type, 'matched');
    assert.equal(row1.subtotal, 0);
    assert.equal(row1.giftKind, 'foc', 'Mặc định có product là foc');

    const htmlFoc = uiRenderer.buildGiftKindToggleHtml(row1);
    assert.ok(htmlFoc.includes('data-kind-toggle="item_0"'));
    assert.ok(htmlFoc.includes('kind-foc'));
    assert.ok(htmlFoc.includes('>FOC<'));

    // Khi người dùng toggle sang extra
    order.giftKindOverrides['item_0'] = 'extra';
    const res2 = uiRenderer.getOrderTableRows(order);
    const row2 = res2.rows[0];
    assert.equal(row2.giftKind, 'extra');

    const htmlExtra = uiRenderer.buildGiftKindToggleHtml(row2);
    assert.ok(htmlExtra.includes('kind-extra'));
    assert.ok(htmlExtra.includes('>EXTRA<'));
  });

  it('Hàng chưa khớp có giá 0đ: có nút toggle và nhận override', () => {
    const order = {
      items: [
        {
          product: null,
          rawName: 'Nhớt lạ test',
          qty: 5,
          unit: 'chai',
          manualPrice: 0,
          subtotal: 0
        }
      ],
      giftKindOverrides: {}
    };

    const res1 = uiRenderer.getOrderTableRows(order);
    const row1 = res1.rows[0];
    assert.equal(row1.type, 'unmatched');
    assert.equal(row1.giftKind, 'extra', 'Chưa khớp mặc định extra');

    // Người dùng toggle sang FOC
    order.giftKindOverrides['item_0'] = 'foc';
    const res2 = uiRenderer.getOrderTableRows(order);
    assert.equal(res2.rows[0].giftKind, 'foc');
    assert.ok(uiRenderer.buildGiftKindToggleHtml(res2.rows[0]).includes('>FOC<'));
  });

  it('Hàng tự nhập isCustom có giá 0đ: có nút toggle và chuyển đổi linh hoạt', () => {
    const order = {
      items: [
        {
          product: null,
          rawName: 'Khăn lau xe tặng kèm',
          qty: 2,
          unit: 'cái',
          isCustom: true,
          manualPrice: 0,
          subtotal: 0
        }
      ],
      giftKindOverrides: {}
    };

    const res1 = uiRenderer.getOrderTableRows(order);
    const row1 = res1.rows[0];
    assert.equal(row1.isCustom, true);
    assert.equal(row1.giftKind, 'extra');

    order.giftKindOverrides['item_0'] = 'foc';
    const res2 = uiRenderer.getOrderTableRows(order);
    assert.equal(res2.rows[0].giftKind, 'foc');
    assert.ok(uiRenderer.buildGiftKindToggleHtml(res2.rows[0]).includes('>FOC<'));
  });
});

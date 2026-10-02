/**
 * Tests for rescanOrderTextIfChanged()
 * Verifies that re-scanning order text before export:
 * 1. Updates rawChatText, parsedLines, aiResult, salesComment
 * 2. Preserves user-edited order items, manual prices, custom items, custom promos, gift overrides, row order
 * 3. Does not overwrite customerName and paymentMethod inputs if already present
 *
 * Run: node --test test/rescan.test.mjs
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Setup minimal DOM
const elements = {};
global.document = {
  getElementById: (id) => {
    if (!elements[id]) {
      elements[id] = {
        value: '',
        textContent: '',
        innerHTML: '',
        style: {},
        options: [],
        appendChild: () => {},
        classList: { contains: () => false, add: () => {}, remove: () => {} }
      };
    }
    return elements[id];
  },
  createElement: (tag) => ({
    value: '',
    textContent: '',
    innerHTML: '',
    style: {},
    appendChild: () => {},
    classList: { contains: () => false, add: () => {}, remove: () => {} }
  }),
  createDocumentFragment: () => ({
    appendChild: () => {}
  })
};
if (typeof global.window === 'undefined') {
  global.window = {};
}

import { store } from '../store.js';
import { db } from '../db.js';
import { rescanOrderTextIfChanged, buildOrderFromText } from '../src/order/builder.js';

global.db = db;
global.window.db = db;

describe('rescanOrderTextIfChanged', () => {
  beforeEach(() => {
    db.data = {
      campaigns: {
        torvex: {
          name: 'Torvex',
          color: '#4fc3f7',
          products: [
            { id: 'p1', name: 'Torvex 10W40', box_size: 12, unit: 'chai', campaignKey: 'torvex' }
          ]
        }
      }
    };
    db.aliases = {};

    elements.orderText = { value: 'Torvex 10W40 2 chai' };
    elements.customerName = { value: 'Khách A - Sửa Tay' };
    elements.paymentMethod = { value: 'tm' };

    // Setup initial store state with custom user edits
    store.setState({
      currentOrder: {
        customer: 'Khách A - Sửa Tay',
        payment: 'tm',
        rawChatText: 'Torvex 10W40 2 chai',
        items: [
          {
            rawProduct: 'Torvex 10W40',
            qty: 2,
            unit: 'chai',
            product: { id: 'p1', name: 'Torvex 10W40', box_size: 12 },
            unitPrice: 180017,
            manualPrice: 190017, // Giá sửa tay
            subtotal: 320000,
            foc: null,
            tierLabel: 'Giá lẻ',
            isGift: false,
            isCustom: false
          },
          {
            rawName: 'Sản phẩm thêm tay đặc biệt',
            qty: 1,
            unit: 'lon',
            product: null,
            unitPrice: 50000,
            manualPrice: 50000,
            subtotal: 50000,
            foc: null,
            tierLabel: '',
            isGift: false,
            isCustom: true // Sản phẩm thêm tay
          }
        ],
        customPromos: [{ id: 'promo1', name: 'Tặng áo thun', qty: 1 }],
        giftOverrides: { 'p1': 'Áo mưa' },
        giftDeleted: { 'gift_0': true },
        giftQtyOverrides: { 'gift_1': 5 },
        rowOrder: ['1', '0'],
        salesComment: 'Ghi chú cũ',
        parsedLines: [],
        aiResult: { primaryCampaign: 'torvex' }
      }
    });
  });

  it('returns false when orderText has not changed', () => {
    elements.orderText.value = 'Torvex 10W40 2 chai';
    const changed = rescanOrderTextIfChanged();
    assert.equal(changed, false);
  });

  it('returns false when orderText is empty', () => {
    elements.orderText.value = '   ';
    const changed = rescanOrderTextIfChanged();
    assert.equal(changed, false);
  });

  it('preserves all user edits, manual prices, custom items, gifts, promos, and row order when text changes', () => {
    // User added new note in text
    elements.orderText.value = 'Torvex 10W40 2 chai\nGiao sau 5h chiều';

    const changed = rescanOrderTextIfChanged();
    assert.equal(changed, true);

    const currentOrder = store.getState().currentOrder;

    // rawChatText must be updated
    assert.equal(currentOrder.rawChatText, 'Torvex 10W40 2 chai\nGiao sau 5h chiều');

    // Customer and payment in DOM must NOT be overwritten
    assert.equal(elements.customerName.value, 'Khách A - Sửa Tay');
    assert.equal(elements.paymentMethod.value, 'tm');

    // Items array must be 100% PRESERVED
    assert.equal(currentOrder.items.length, 2);
    assert.equal(currentOrder.items[0].manualPrice, 190017, 'Manual price must be preserved');
    assert.equal(currentOrder.items[1].isCustom, true, 'Custom product must be preserved');
    assert.equal(currentOrder.items[1].rawName, 'Sản phẩm thêm tay đặc biệt');

    // Custom promos, gift overrides, deleted gifts, row order must be PRESERVED
    assert.deepEqual(currentOrder.customPromos, [{ id: 'promo1', name: 'Tặng áo thun', qty: 1 }]);
    assert.deepEqual(currentOrder.giftOverrides, { 'p1': 'Áo mưa' });
    assert.deepEqual(currentOrder.giftDeleted, { 'gift_0': true });
    assert.deepEqual(currentOrder.giftQtyOverrides, { 'gift_1': 5 });
    assert.deepEqual(currentOrder.rowOrder, ['1', '0']);

    // parsedLines and salesComment are updated from the fresh text
    assert.ok(currentOrder.parsedLines.length > 0);
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['window', 'document', 'localStorage', 'MutationObserver', 'HTMLElement', 'CustomEvent', 'Event']) {
  globalThis[key] = dom.window[key];
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
const { db } = await import('../db.js');
globalThis.db = db;
const { openProductEditorModal, closeProductEditorModal } = await import('../src/settings/ui.js');
const { initEditTracker } = await import('../src/edit-tracker.js');
initEditTracker();

function mount() {
  db.data = { campaigns: { sample: { name: 'Sample', products: [{
    id: 'sample_product', name: 'Sample product', unit: 'chai', box_size: 12,
    tiers: [{ label: 'Tất cả', min_qty: 1, max_qty: 9999, price: 130017 }],
  }], promoRules: [] } } };
  db.kvCodeMap = {};
  db.customAliases = {};
  db._bumpDataVersion();
  openProductEditorModal('sample', 'sample_product');
  return document.querySelector('.product-editor-modal-overlay');
}

function type(input, value) {
  input.focus();
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function escape(input) {
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
}

test('deep editor Escape commits focused tier price without blur', () => {
  const overlay = mount();
  const input = overlay.querySelector('.tier-price-input');
  type(input, '250000');
  assert.equal(db.findProductById('sample_product').tiers[0].price, 130017);
  escape(input);
  assert.equal(db.findProductById('sample_product').tiers[0].price, 250000);
  assert.equal(overlay.isConnected, false);
});

test('tracked product field Escape still undoes draft without closing', () => {
  const overlay = mount();
  const input = overlay.querySelector('.product-field-input[data-field="name"]');
  type(input, 'Unsaved rename');
  escape(input);
  assert.equal(input.value, 'Sample product');
  assert.equal(db.findProductById('sample_product').name, 'Sample product');
  assert.equal(overlay.isConnected, true);
  closeProductEditorModal();
});

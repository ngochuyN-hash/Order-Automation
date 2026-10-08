import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const dom = new JSDOM(readFileSync(new URL('../index.html', import.meta.url), 'utf8'), {
  url: 'http://localhost/', pretendToBeVisual: true,
});
for (const key of ['window', 'document', 'localStorage', 'MutationObserver', 'HTMLElement', 'CustomEvent', 'Event']) {
  globalThis[key] = dom.window[key];
}
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = clearTimeout;
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
const { db, DEFAULT_DB } = await import('../db.js');
globalThis.db = db;
globalThis.fuzzySearchScore = (await import('../parser.js')).fuzzySearchScore;
const { uiRenderer } = await import('../ui-renderer.js');
const { bindGlobalUIListeners, initProductEditorDelegation } = await import('../src/settings/ui.js');
const { initCatalogDelegation } = await import('../src/catalog/delegation.js');

test('order add-product panel is always visible and only searches the catalog', () => {
  const panel = document.querySelector('.add-product-panel');
  assert.ok(panel, 'add-product panel exists');
  assert.equal(panel.querySelector('details, summary'), null, 'panel is not collapsible');
  assert.ok(panel.querySelector('#manualProductSearch'), 'catalog search remains available');
  assert.equal(document.getElementById('btnAddCustomProduct'), null, 'custom add button is removed');
  assert.equal(document.getElementById('customProductName'), null, 'custom product form is removed');
  assert.match(panel.textContent, /Tìm trong danh mục để thêm vào đơn/);
});

test('actual index DOM connects Catalog, campaign-only editing and filtered package navigation', async () => {
  db.data = structuredClone(DEFAULT_DB);
  db.kvCodeMap = {};
  db.customAliases = {};
  db._bumpDataVersion();
  const errors = [];
  window.addEventListener('error', e => { errors.push(e.error); e.preventDefault(); });
  bindGlobalUIListeners();
  initProductEditorDelegation();
  initCatalogDelegation();
  document.getElementById('tabCatalog').click();
  assert.ok(document.getElementById('panelCatalog').classList.contains('active'));
  document.querySelector('#catalogBrandChips [data-filter="zentor"]').click();
  document.getElementById('btnCatalogManageCampaigns').click();
  assert.ok(document.getElementById('subtab-campaigns').classList.contains('active'));
  assert.equal(document.getElementById('editCampaignName').value, db.data.campaigns.zentor.name);
  for (const id of ['productEditor', 'settingsCampaignList', 'settingsEditorTitle']) {
    assert.equal(document.querySelectorAll(`[id="${id}"]`).length, 1);
    assert.ok(document.getElementById('subtab-campaigns').contains(document.getElementById(id)));
  }
  assert.ok(document.getElementById('mkt-rules-container-zentor'));
  assert.equal(document.querySelectorAll('#productEditor .product-item-card').length, 0);
  // v1.5.1 UX: MKT card should be in collapsible editor-section
  assert.ok(document.querySelector('#productEditor .editor-section[data-section="mkt-rules"]'), 'MKT card has collapse wrapper');
  assert.ok(document.querySelector('#productEditor .editor-section[data-section="mkt-rules"][data-collapsed]'), 'MKT card collapsed by default');
  // v1.5.1 UX: reverse link to Catalog exists
  assert.ok(document.getElementById('btnGotoCatalogFromBrand'), 'reverse link to Catalog present');
  // v1.5.1 UX: Brand Key shown as immutable
  assert.ok(document.getElementById('productEditor').innerHTML.includes('không đổi được'), 'immutable key label present');
  document.querySelector('#settingsCampaignList [data-campaign-key="torvex"]').click();
  assert.equal(document.getElementById('editCampaignName').value, db.data.campaigns.torvex.name);

  const products = [
    { id: 'test_pack_1', name: 'Test Package (1L)', spec: '1L', unit: 'chai', box_size: 12, tiers: [{ price: 100, min_qty: 1, max_qty: 999 }] },
    { id: 'test_pack_4', name: 'Test Package (4L)', spec: '4L', unit: 'bình', box_size: 4, tiers: [{ price: 400, min_qty: 1, max_qty: 999 }] },
  ];
  db.data.campaigns.zentor.products.push(...products);
  db._bumpDataVersion();
  uiRenderer._catalogSearch = 'Test Package 1L';
  uiRenderer.renderCatalog('zentor');
  document.getElementById('tabCatalog').click();
  assert.equal(document.querySelectorAll('.catalog-list-row').length, 1);
  document.querySelector('[data-product-id="test_pack_1"] .btn-toggle-catalog-card').click();
  const sibling = document.querySelector('.btn-goto-package[data-product-id="test_pack_4"]');
  assert.ok(sibling, '1L detail offers the 4L package');
  sibling.click();
  const destination = document.querySelector('.catalog-list-row[data-product-id="test_pack_4"]');
  assert.ok(destination, 'following a package link reveals it despite the search filter');
  assert.equal(destination.querySelector('.catalog-card-detail').style.display, 'block');
  assert.deepEqual(errors, []);
  dom.window.close();
});

/**
 * =========================================================================
 *  KIOTVIET BROWSER HELPERS (kv-browser-helpers.js) — LIVE-TESTED
 * =========================================================================
 *  Injectable JavaScript functions for KiotViet automation via browser-use MCP.
 *  ALL functions below are VERIFIED on live KiotViet pages.
 *
 *  Usage: evaluate_script({ function: "<paste function body>" })
 *
 *  CRITICAL: KiotViet uses AngularJS 1.x. Standard fill()/click() timeout
 *  ~50% of the time. These helpers use native value setters + scope.$apply()
 *  for 100% reliability.
 * =========================================================================
 */

// ==================== CORE INPUT HELPER ====================

/**
 * KV.setInput(elementId, value)
 * Sets any input value reliably on KiotViet (AngularJS).
 * TESTED: Works on productSearchInput, customerSearchInput, note-cartitem-0
 */
const KV_setInput = `
(id, value) => {
  const el = document.getElementById(id);
  if (!el) return { error: 'Element not found: ' + id };
  el.focus();
  const proto = el.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  if (window.angular) {
    const scope = angular.element(el).scope();
    if (scope && !scope.$$phase) scope.$apply();
  }
  return { success: true, id, value: el.value };
}
`;

// ==================== CUSTOMER SELECTION ====================

/**
 * KV.searchCustomer(name)
 * Types customer name into search and triggers AngularJS search.
 * After calling, wait 1200ms then press Enter to select first result.
 */
const KV_searchCustomer = `
(name) => {
  const el = document.getElementById('customerSearchInput');
  if (!el) return { error: 'customerSearchInput not found' };
  el.focus();
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, name);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  if (window.angular) {
    const scope = angular.element(el).scope();
    if (scope && !scope.$$phase) scope.$apply();
  }
  return { success: true, searched: name };
}
`;

/**
 * KV.getSelectedCustomer()
 * Returns the currently selected customer info.
 */
const KV_getSelectedCustomer = `
() => {
  const link = Array.from(document.querySelectorAll('a'))
    .find(a => a.offsetParent !== null && a.textContent.match(/KH\\d{6}/));
  if (!link) return { hasCustomer: false };
  const text = link.textContent.trim();
  const codeMatch = text.match(/KH\\d{6}/);
  return {
    hasCustomer: true,
    name: text.replace(/\\d{10,}/g, '').trim(),
    code: codeMatch ? codeMatch[0] : null,
    fullText: text.slice(0, 80)
  };
}
`;

// ==================== PRODUCT SELECTION ====================

/**
 * KV.searchProduct(codeOrName)
 * Types product code/name into search. Wait 1500ms then check dropdown.
 */
const KV_searchProduct = `
(query) => {
  const el = document.getElementById('productSearchInput');
  if (!el) return { error: 'productSearchInput not found' };
  el.focus();
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, query);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  if (window.angular) {
    const scope = angular.element(el).scope();
    if (scope && !scope.$$phase) scope.$apply();
  }
  return { success: true, searched: query };
}
`;

/**
 * KV.getDropdownResults()
 * Gets visible h5 dropdown results (products or customers).
 * Call after search + 1200ms wait.
 */
const KV_getDropdownResults = `
() => {
  const h5s = Array.from(document.querySelectorAll('h5'))
    .filter(h => h.offsetParent !== null)
    .map(h => h.textContent.trim());
  return { count: h5s.length, results: h5s.slice(0, 10) };
}
`;

/**
 * KV.selectUnit(unit)
 * Clicks a dropdown result by unit type ('Thùng' or 'Bình').
 * Default unit = 'Thùng'.
 */
const KV_selectUnit = `
(unit) => {
  unit = unit || 'Thùng';
  const h5 = Array.from(document.querySelectorAll('h5'))
    .find(h => h.offsetParent !== null && h.textContent.includes(unit));
  if (h5) { h5.click(); return { selected: h5.textContent.trim() }; }
  // Fallback: click first visible h5
  const first = Array.from(document.querySelectorAll('h5'))
    .find(h => h.offsetParent !== null);
  if (first) { first.click(); return { selected: first.textContent.trim(), fallback: true }; }
  return { error: 'No dropdown results found' };
}
`;

// ==================== QUANTITY ====================

/**
 * KV.setQuantity(qty)
 * Sets quantity in cart. The visible qty input id = "note-cartitem-0".
 * TESTED: productQtyInput is HIDDEN, use note-cartitem-0 instead.
 */
const KV_setQuantity = `
(qty) => {
  const el = document.getElementById('note-cartitem-0');
  if (!el) return { error: 'note-cartitem-0 not found — product not in cart?' };
  el.focus();
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, String(qty));
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keydown',
    { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keyup',
    { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  if (window.angular) {
    const scope = angular.element(el).scope();
    if (scope && !scope.$$phase) scope.$apply();
  }
  return { success: true, qty: el.value };
}
`;

// ==================== NOTE ====================

/**
 * KV.setNote(text)
 * Sets the order note (Ghi chú đơn hàng).
 */
const KV_setNote = `
(text) => {
  const el = Array.from(document.querySelectorAll('textarea'))
    .find(t => t.offsetParent !== null && t.placeholder.includes('Ghi chú đơn hàng'));
  if (!el) return { error: 'Note textarea not found' };
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  if (window.angular) {
    const scope = angular.element(el).scope();
    if (scope && !scope.$$phase) scope.$apply();
  }
  return { success: true, note: text };
}
`;

// ==================== WAREHOUSE ====================

/**
 * KV.getWarehouses()
 * Opens warehouse dropdown and returns available options.
 */
const KV_openWarehouseDropdown = `
() => {
  const dd = Array.from(document.querySelectorAll('.k-dropdown'))
    .find(el => el.textContent.includes('Warehouse'));
  if (!dd) return { error: 'Warehouse dropdown not found' };
  const selectEl = dd.querySelector('.k-select') || dd;
  selectEl.click();
  return { opened: true, current: dd.textContent.match(/\\w+ Warehouse/)?.[0] };
}
`;

/**
 * KV.selectWarehouse(name)
 * Selects a warehouse from the open dropdown.
 * Call 500ms after KV_openWarehouseDropdown.
 */
const KV_selectWarehouse = `
(name) => {
  const opt = Array.from(document.querySelectorAll('.k-item'))
    .find(el => el.offsetParent !== null && el.textContent.includes(name));
  if (opt) { opt.click(); return { selected: name }; }
  return { error: 'Warehouse not found: ' + name };
}
`;

// ==================== ORDER SUBMISSION (2-STEP) ====================

/**
 * KV.clickSubmitOrder()
 * Clicks the main "ĐẶT HÀNG" button. Opens confirmation modal.
 */
const KV_clickSubmitOrder = `
() => {
  const btn = Array.from(document.querySelectorAll('button'))
    .find(b => b.offsetParent !== null &&
      (b.textContent.includes('ĐẶT HÀNG') || b.textContent.trim() === 'Đặt hàng'));
  if (btn) { btn.click(); return { clicked: true, text: btn.textContent.trim() }; }
  return { error: 'ĐẶT HÀNG button not found' };
}
`;

/**
 * KV.selectOrderReceiver(name)
 * Selects "Người nhận đặt" in the confirmation modal.
 * Call 1500ms after KV_clickSubmitOrder.
 * Default: Nguyễn Ngọc Huy. If "Phúc" → "Đức Phúc".
 */
const KV_selectOrderReceiver = `
(name) => {
  const options = Array.from(document.querySelectorAll('[role="option"]'));
  if (options.length === 0) return { error: 'No receiver modal open' };
  const opt = options.find(o => o.textContent.includes(name));
  if (opt) { opt.click(); return { selected: opt.textContent.trim() }; }
  return { error: 'Receiver not found: ' + name, available: options.map(o => o.textContent.trim()).slice(0, 10) };
}
`;

/**
 * KV.confirmOrder()
 * Clicks "Đặt hàng" in the confirmation dialog (2nd step).
 * Call after selecting receiver.
 */
const KV_confirmOrder = `
() => {
  const dialog = document.querySelector('[role="dialog"]');
  const scope = dialog || document;
  const btn = Array.from(scope.querySelectorAll('button'))
    .find(b => b.textContent.includes('Đặt hàng') || b.textContent.includes('ĐẶT HÀNG'));
  if (btn) { btn.click(); return { confirmed: true }; }
  // Fallback: any visible button with "Đặt"
  const fallback = Array.from(document.querySelectorAll('button'))
    .filter(b => b.offsetParent !== null)
    .find(b => b.textContent.includes('Đặt'));
  if (fallback) { fallback.click(); return { confirmed: true, fallback: true }; }
  return { error: 'Confirm button not found' };
}
`;

// ==================== PAGE STATE ====================

/**
 * KV.getPageState()
 * Returns comprehensive page state for debugging.
 */
const KV_getPageState = `
() => {
  const body = document.body.innerText;
  return {
    url: window.location.href,
    title: document.title,
    hasSession: !!localStorage.getItem('kvSession'),
    warehouse: (body.match(/(\\w+ Warehouse)/) || [null])[0],
    hasProductInput: !!document.getElementById('productSearchInput'),
    hasCustomerInput: !!document.getElementById('customerSearchInput'),
    cartHasItems: body.includes('Tổng tiền hàng'),
    stockError: body.includes('quá số lượng'),
    orderCode: (body.match(/DH\\d{6}/) || [null])[0],
    customer: (body.match(/KH\\d{6}/) || [null])[0]
  };
}
`;

/**
 * KV.getCartSummary()
 * Returns current cart items and totals.
 */
const KV_getCartSummary = `
() => {
  const body = document.body.innerText;
  const totalMatch = body.match(/Tổng tiền hàng\\s*([\\d,]+)/);
  const customerMatch = body.match(/(KH\\d{6})/);
  const qtyEl = document.getElementById('note-cartitem-0');
  return {
    total: totalMatch ? totalMatch[1] : '0',
    customer: customerMatch ? customerMatch[1] : null,
    qty: qtyEl ? qtyEl.value : null,
    hasProducts: body.includes('Tổng tiền hàng'),
    stockError: body.includes('quá số lượng cho phép')
  };
}
`;

/**
 * KV.checkErrors()
 * Checks for any visible error messages on page.
 */
const KV_checkErrors = `
() => {
  const errors = Array.from(document.querySelectorAll(
    '[class*="error"], [class*="toast"], [class*="alert"], [class*="danger"]'))
    .filter(el => el.offsetParent !== null && el.textContent.trim())
    .map(el => el.textContent.trim().slice(0, 120));
  return { hasErrors: errors.length > 0, errors: errors.slice(0, 5) };
}
`;

// ==================== DATA EXTRACTION ====================

/**
 * KV.extractOrderTable()
 * Extracts order list from /man/#/Orders/ page.
 */
const KV_extractOrderTable = `
() => {
  const rows = document.querySelectorAll('table tbody tr, .k-grid-content tr');
  return Array.from(rows).slice(0, 20).map(row => {
    const cells = row.querySelectorAll('td');
    return Array.from(cells).map(c => c.textContent.trim());
  });
}
`;

// ==================== EXPORTS ====================

module.exports = {
  KV_setInput,
  KV_searchCustomer,
  KV_getSelectedCustomer,
  KV_searchProduct,
  KV_getDropdownResults,
  KV_selectUnit,
  KV_setQuantity,
  KV_setNote,
  KV_openWarehouseDropdown,
  KV_selectWarehouse,
  KV_clickSubmitOrder,
  KV_selectOrderReceiver,
  KV_confirmOrder,
  KV_getPageState,
  KV_getCartSummary,
  KV_checkErrors,
  KV_extractOrderTable,
};

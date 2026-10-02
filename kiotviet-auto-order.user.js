// ==UserScript==
// @name         KiotViet Auto Order Pro
// @namespace    http://tampermonkey.net/
// @version      2.0.0
// @description  Tự động lên đơn KiotViet từ JSON - hỗ trợ batch, giá tùy chỉnh, WebSocket API cho AI điều khiển
// @author       Order Automation
// @match        https://YOUR_TENANT.kiotviet.vn/sale/*   ← THAY YOUR_TENANT bằng tenant KiotViet của bạn
// @match        https://YOUR_TENANT.kiotviet.vn/product/*
// @match        https://YOUR_TENANT.kiotviet.vn/customer/*
// @match        https://YOUR_TENANT.kiotviet.vn/report/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ==================== CONFIG ====================
  const DELAY = {
    AFTER_TYPING: 800,    // ms chờ dropdown hiện sau khi gõ
    AFTER_SELECT: 600,    // ms chờ sau khi chọn item
    BETWEEN_ITEMS: 500,   // ms giữa các sản phẩm
  };

  // ==================== UTILITIES ====================
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Poll chờ element xuất hiện (thay thế sleep cố định).
   * @param {string|Function} selectorOrFn - CSS selector hoặc function trả về element
   * @param {number} timeout - ms tối đa chờ (default 4000)
   * @param {number} interval - ms giữa mỗi lần check (default 100)
   * @returns {Element|null}
   */
  async function waitForEl(selectorOrFn, timeout = 4000, interval = 100) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = typeof selectorOrFn === 'function' ? selectorOrFn() : document.querySelector(selectorOrFn);
      if (el && el.offsetParent !== null) return el;
      if (el && typeof selectorOrFn === 'function') return el; // fn mode: accept even if hidden
      await sleep(interval);
    }
    return null;
  }

  /**
   * Poll chờ element BIẾN MẤT (vd: popover đóng, dropdown ẩn).
   */
  async function waitForGone(selectorOrFn, timeout = 3000, interval = 100) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = typeof selectorOrFn === 'function' ? selectorOrFn() : document.querySelector(selectorOrFn);
      if (!el || el.offsetParent === null) return true;
      await sleep(interval);
    }
    return false;
  }

  function log(msg, type = 'info') {
    const prefix = { info: 'ℹ️', ok: '✅', err: '❌', warn: '⚠️' }[type] || '';
    console.log(`[KV-AutoOrder] ${prefix} ${msg}`);
    updateStatus(`${prefix} ${msg}`, type);
  }

  // Simulate real typing (triggers React/Angular change detection)
  function setNativeValue(el, value) {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set || Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;

    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Find input by placeholder text
  function findInput(placeholderText) {
    const inputs = document.querySelectorAll('input, textarea');
    for (const inp of inputs) {
      if (inp.placeholder && inp.placeholder.includes(placeholderText)) {
        return inp;
      }
    }
    return null;
  }

  // Wait for element to appear
  async function waitForElement(selector, timeout = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = document.querySelector(selector);
      if (el) return el;
      await sleep(100);
    }
    return null;
  }

  // Wait for text to appear in DOM
  async function waitForText(text, timeout = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (walker.currentNode.textContent.includes(text)) {
          return walker.currentNode.parentElement;
        }
      }
      await sleep(100);
    }
    return null;
  }

  // ==================== CORE AUTOMATION ====================

  async function selectCustomer(name) {
    log(`Tìm khách: "${name}"`);
    const input = findInput('Tìm khách hàng');
    if (!input) throw new Error('Không tìm thấy ô tìm khách hàng (F4)');

    input.focus();
    setNativeValue(input, name);
    await sleep(DELAY.AFTER_TYPING);

    // Wait for dropdown result (h5 heading with customer name)
    const start = Date.now();
    let found = null;
    while (Date.now() - start < 5000) {
      const headings = document.querySelectorAll('h5');
      for (const h of headings) {
        if (h.textContent.toLowerCase().includes(name.toLowerCase().substring(0, 10))) {
          found = h;
          break;
        }
      }
      if (found) break;
      await sleep(200);
    }

    if (!found) {
      // Try clicking parent container of search results
      const results = document.querySelectorAll('[class*="search-result"], [class*="dropdown"] h5, [class*="customer"] h5');
      if (results.length > 0) found = results[0];
    }

    if (!found) throw new Error(`Không tìm thấy khách "${name}" trong kết quả`);

    found.click();
    await sleep(DELAY.AFTER_SELECT);
    log(`Đã chọn khách: ${found.textContent.trim()}`, 'ok');
  }

  async function addProduct(code, name, qty, unit) {
    log(`Thêm SP: ${name || code} (x${qty} ${unit || 'thùng'})`);
    const input = findInput('Tìm hàng hóa');
    if (!input) throw new Error('Không tìm thấy ô tìm hàng hóa (F3)');

    input.focus();
    setNativeValue(input, code || name);
    await sleep(DELAY.AFTER_TYPING);

    // Wait for product dropdown — KiotViet shows h5 options: "...Thùng", "...Bình", "Pack - N"
    const start = Date.now();
    let target = null;
    const searchStr = (code || name).toLowerCase();
    const unitLower = (unit || 'thùng').toLowerCase();

    while (Date.now() - start < 5000) {
      const headings = Array.from(document.querySelectorAll('h5')).filter(h => h.offsetParent !== null);
      if (headings.length > 0) {
        // Select based on unit (quy cách)
        if (unitLower === 'thùng' || unitLower === 'thung' || unitLower === 'thg') {
          target = headings.find(h => h.textContent.includes('Thùng') || h.textContent.includes('Thung'));
        } else {
          // Đơn vị lẻ (tuýp, chai, bình, lon, can, cái...) → loại trừ option Thùng rồi match theo đơn vị
          const nonBox = headings.filter(h => !/Thùng|Thung/i.test(h.textContent));
          const unitRe = { 'tuýp': /Tuýp|Tuyp/i, 'tuyp': /Tuýp|Tuyp/i, 'tip': /Tuýp|Tuyp/i, 'chai': /Chai|B[iì]nh/i, 'bình': /B[iì]nh|Chai/i, 'binh': /B[iì]nh|Chai/i, 'lon': /Lon|B[iì]nh|Chai/i, 'can': /Can|B[iì]nh|Chai/i }[unitLower];
          if (unitRe) target = nonBox.find(h => unitRe.test(h.textContent));
          if (!target && nonBox.length > 0) target = nonBox[0];
        }
        // Fallback: first visible h5
        if (!target) target = headings[0];
        break;
      }
      await sleep(200);
    }

    if (!target) throw new Error(`Không tìm thấy sản phẩm "${code || name}"`);

    target.click();
    // Poll chờ cart render (SP mới xuất hiện ở index 0)
    await waitForEl(() => document.getElementById('note-cartitem-0'), 4000);

    // Set quantity if > 1
    if (qty > 1) {
      // KiotViet thêm SP mới vào ĐẦU cart → SP vừa thêm LUÔN ở index 0
      const qtyEl = await waitForEl(() => document.getElementById('note-cartitem-0'), 3000);

      if (qtyEl) {
        qtyEl.focus();
        qtyEl.select && qtyEl.select();
        setNativeValue(qtyEl, String(qty));
        qtyEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        qtyEl.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        // AngularJS: bắt buộc gọi $apply để model cập nhật
        const scope = window.angular && angular.element(qtyEl).scope();
        if (scope) { try { scope.$apply(); } catch(e){} }
        await sleep(400);
        // Verify
        const actualQty = parseInt(qtyEl.value) || 0;
        if (actualQty === qty) {
          log(`  Số lượng: ${qty} ✓`, 'ok');
        } else {
          log(`  ⚠️ SL cần ${qty}, thực tế ${actualQty} — thử lại...`, 'warn');
          setNativeValue(qtyEl, String(qty));
          qtyEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          if (scope) { try { scope.$apply(); } catch(e){} }
          await sleep(300);
        }
      } else {
        log(`  ⚠️ Không tìm thấy ô số lượng (note-cartitem-0), mặc định = 1`, 'warn');
      }
    }

    log(`  Đã thêm: ${target.textContent.trim()}`, 'ok');
  }

  async function setNote(note) {
    if (!note) return;
    log(`Ghi chú: "${note}"`);
    const textarea = findInput('Ghi chú đơn hàng');
    if (textarea) {
      textarea.focus();
      setNativeValue(textarea, note);
      await sleep(300);
      log('Đã nhập ghi chú', 'ok');
    } else {
      log('Không tìm thấy ô ghi chú', 'warn');
    }
  }

  // ==================== SALE MODE ====================

  /**
   * Switch KiotViet to "Bán giao hàng" mode (saleScreenMode = 3).
   * Must be called BEFORE adding products — affects the entire order flow.
   */
  async function switchToDeliveryMode() {
    // Check current mode via Angular
    let currentMode = null;
    try {
      const el = document.querySelector('.nav-tabs') || document.getElementById('productSearchInput');
      if (el && window.angular) {
        const inj = angular.element(el).injector();
        if (inj) {
          const $root = inj.get('$rootScope');
          currentMode = $root.saleScreenMode;
        }
      }
    } catch (e) { /* ignore */ }

    if (currentMode === 3) {
      log('Đã ở chế độ Bán giao hàng ✓', 'ok');
      return;
    }

    log('Chuyển sang chế độ Bán giao hàng...');

    // Method 1: Click the "Bán giao hàng" tab
    const deliveryTab = Array.from(document.querySelectorAll('a.nav-link')).find(
      a => a.textContent.includes('Bán giao hàng')
    );
    if (deliveryTab) {
      deliveryTab.click();
      // Poll chờ mode chuyển sang 3
      await waitForEl(() => {
        try {
          const el = document.querySelector('.nav-tabs') || document.querySelector('input');
          if (el && window.angular) {
            const inj = angular.element(el).injector();
            if (inj && inj.get('$rootScope').saleScreenMode === 3) return el;
          }
        } catch(e){}
        return null;
      }, 3000);
      log('Đã chuyển sang Bán giao hàng ✓', 'ok');
      return;
    }

    // Method 2: Fallback — set via Angular scope
    try {
      const el = document.querySelector('.nav-tabs') || document.getElementById('productSearchInput');
      const inj = angular.element(el).injector();
      const $root = inj.get('$rootScope');
      $root.saleScreenMode = 3;
      $root.$apply();
      await sleep(500);
      log('Đã chuyển sang Bán giao hàng (Angular) ✓', 'ok');
    } catch (e) {
      log('⚠️ Không thể chuyển chế độ Bán giao hàng: ' + e.message, 'warn');
    }
  }

  // ==================== MAIN FLOW ====================

  async function runOrder(orderData) {
    const { customer, note, items } = orderData;

    if (!customer) throw new Error('Thiếu tên khách hàng (customer)');
    if (!items || items.length === 0) throw new Error('Không có sản phẩm nào (items)');

    log(`Bắt đầu lên đơn: ${customer} (${items.length} sản phẩm)`);

    // Step 0: Switch to "Bán giao hàng" mode (BẮT BUỘC)
    await switchToDeliveryMode();

    // Step 1: Select customer
    await selectCustomer(customer);

    // Step 2: Add products + set price
    const priceErrors = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      await addProduct(item.code, item.name, item.qty || 1, item.unit);

      // BẮT BUỘC nhập đơn giá cho mọi SP (FOC = 0, SP thường = giá xuất hàng)
      // LƯU Ý: KiotViet thêm SP mới vào ĐẦU cart (index 0), SP cũ bị đẩy lên index cao hơn
      // → SP vừa thêm LUÔN ở index 0
      const itemPrice = (item.price !== undefined && item.price !== null) ? item.price : null;
      if (itemPrice !== null) {
        const ok = await setItemPrice(0, itemPrice);
        if (!ok) priceErrors.push({ item: item.code || item.name, expected: itemPrice });
      } else {
        log(`  ⚠️ SP ${i + 1}: Không có giá trong JSON (item.price) — dùng giá mặc định KV`, 'warn');
      }

      if (i < items.length - 1) await sleep(DELAY.BETWEEN_ITEMS);
    }

    // Check price errors — warn but still submit (user can verify on screen)
    if (priceErrors.length > 0) {
      log(`⚠️ ${priceErrors.length} SP nhập giá thất bại: ${priceErrors.map(e => e.item).join(', ')}`, 'warn');
    }

    // Step 3: Set note
    await setNote(note);

    // Step 4: DONE — KHÔNG tự bấm Đặt hàng, người dùng tự kiểm tra và bấm
    log('✅ Giỏ hàng đã điền xong. KHÔNG tự bấm ĐẶT HÀNG — vui lòng kiểm tra và tự bấm đặt hàng.', 'warn');
  }

  // ==================== UI PANEL ====================

  let statusEl = null;

  function updateStatus(msg, type = 'info') {
    if (!statusEl) return;
    const colors = { info: '#2196F3', ok: '#4CAF50', err: '#f44336', warn: '#ff9800' };
    statusEl.style.color = colors[type] || colors.info;
    statusEl.textContent = msg;
  }

  function createPanel() {
    const panel = document.createElement('div');
    panel.id = 'kv-auto-order-panel';
    panel.innerHTML = `
      <style>
        #kv-auto-order-panel {
          position: fixed;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          width: 480px;
          max-height: 80vh;
          background: #fff;
          border-radius: 12px;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
          z-index: 99999;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          display: none;
          flex-direction: column;
          overflow: hidden;
        }
        #kv-auto-order-panel.visible { display: flex; }
        #kv-auto-order-panel .header {
          background: linear-gradient(135deg, #1a73e8, #0d47a1);
          color: #fff;
          padding: 16px 20px;
          font-size: 16px;
          font-weight: 600;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        #kv-auto-order-panel .header .close-btn {
          cursor: pointer;
          font-size: 20px;
          opacity: 0.8;
          background: none;
          border: none;
          color: #fff;
        }
        #kv-auto-order-panel .header .close-btn:hover { opacity: 1; }
        #kv-auto-order-panel .body {
          padding: 20px;
          overflow-y: auto;
          flex: 1;
        }
        #kv-auto-order-panel textarea {
          width: 100%;
          height: 200px;
          border: 2px solid #e0e0e0;
          border-radius: 8px;
          padding: 12px;
          font-family: 'Consolas', monospace;
          font-size: 13px;
          resize: vertical;
          box-sizing: border-box;
        }
        #kv-auto-order-panel textarea:focus {
          border-color: #1a73e8;
          outline: none;
        }
        #kv-auto-order-panel .hint {
          font-size: 12px;
          color: #666;
          margin: 8px 0 16px;
          line-height: 1.5;
        }
        #kv-auto-order-panel .hint code {
          background: #f5f5f5;
          padding: 2px 5px;
          border-radius: 3px;
          font-size: 11px;
        }
        #kv-auto-order-panel .btn-run {
          width: 100%;
          padding: 12px;
          background: #1a73e8;
          color: #fff;
          border: none;
          border-radius: 8px;
          font-size: 15px;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.2s;
        }
        #kv-auto-order-panel .btn-run:hover { background: #1557b0; }
        #kv-auto-order-panel .btn-run:disabled {
          background: #ccc;
          cursor: not-allowed;
        }
        #kv-auto-order-panel .status {
          margin-top: 12px;
          font-size: 13px;
          min-height: 20px;
          font-weight: 500;
        }
        #kv-auto-order-panel .example-btn {
          background: none;
          border: 1px solid #1a73e8;
          color: #1a73e8;
          padding: 4px 10px;
          border-radius: 4px;
          font-size: 12px;
          cursor: pointer;
          margin-top: 8px;
        }
        #kv-auto-order-panel .example-btn:hover {
          background: #e8f0fe;
        }
      </style>
      <div class="header">
        <span>🚀 KiotViet Auto Order</span>
        <button class="close-btn" id="kv-panel-close">✕</button>
      </div>
      <div class="body">
        <textarea id="kv-order-json" placeholder='Dán JSON đơn hàng vào đây...'></textarea>
        <div class="hint">
          <b>Format JSON:</b><br>
          <code>{"customer": "Tên khách", "note": "Ghi chú", "items": [{"code": "Mã KV", "name": "Tên SP", "qty": 2, "unit": "thùng", "price": 2550017}]}</code><br>
          <b>code</b> = mã SKU KiotViet (ưu tiên) hoặc <b>name</b> = tên sản phẩm để tìm kiếm<br>
          <b>unit</b> = "thùng" hoặc "chai"/"bình" (mặc định: thùng)<br>
          <b>price</b> = đơn giá theo quy cách (0 = hàng tặng/FOC, bắt buộc nhập cho mọi SP)
        </div>
        <button class="example-btn" id="kv-example-btn">📋 Ví dụ mẫu</button>
        <br><br>
        <button class="btn-run" id="kv-run-btn">▶ Chạy lên đơn tự động</button>
        <div class="status" id="kv-status"></div>
      </div>
    `;
    document.body.appendChild(panel);

    statusEl = document.getElementById('kv-status');

    // Events
    document.getElementById('kv-panel-close').onclick = () => panel.classList.remove('visible');
    document.getElementById('kv-example-btn').onclick = () => {
      document.getElementById('kv-order-json').value = JSON.stringify({
        customer: "Anywhere Man Shop",
        note: "Đơn test tự động",
        items: [
          { code: "FB001AA-1", name: "TORVEX FAST 4T 10W40; 1L Thùng", qty: 2, unit: "thùng", price: 2550017 },
          { code: "FB002AA-1", name: "TORVEX FAST 4T 10W40; 800ml Thùng", qty: 1, unit: "thùng", price: 1710017 },
          { code: "FB001AA-1", name: "TORVEX FAST 4T 10W40; 1L (tặng)", qty: 1, unit: "chai", price: 0 }
        ]
      }, null, 2);
    };

    document.getElementById('kv-run-btn').onclick = async () => {
      const btn = document.getElementById('kv-run-btn');
      const jsonStr = document.getElementById('kv-order-json').value.trim();

      if (!jsonStr) {
        updateStatus('Vui lòng dán JSON đơn hàng!', 'err');
        return;
      }

      let orderData;
      try {
        orderData = JSON.parse(jsonStr);
      } catch (e) {
        updateStatus('JSON không hợp lệ: ' + e.message, 'err');
        return;
      }

      btn.disabled = true;
      btn.textContent = '⏳ Đang chạy...';

      try {
        await runOrder(orderData);
        updateStatus('🎉 Hoàn tất! Kiểm tra đơn hàng trên màn hình.', 'ok');
      } catch (err) {
        updateStatus('❌ Lỗi: ' + err.message, 'err');
        console.error('[KV-AutoOrder]', err);
      } finally {
        btn.disabled = false;
        btn.textContent = '▶ Chạy lên đơn tự động';
      }
    };

    return panel;
  }

  function createFloatingButton() {
    const btn = document.createElement('button');
    btn.id = 'kv-auto-order-fab';
    btn.innerHTML = '🚀';
    btn.title = 'KiotViet Auto Order';
    btn.style.cssText = `
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: linear-gradient(135deg, #1a73e8, #0d47a1);
      color: #fff;
      font-size: 24px;
      border: none;
      cursor: pointer;
      box-shadow: 0 4px 16px rgba(26,115,232,0.4);
      z-index: 99998;
      transition: transform 0.2s, box-shadow 0.2s;
    `;
    btn.onmouseenter = () => { btn.style.transform = 'scale(1.1)'; btn.style.boxShadow = '0 6px 24px rgba(26,115,232,0.5)'; };
    btn.onmouseleave = () => { btn.style.transform = 'scale(1)'; btn.style.boxShadow = '0 4px 16px rgba(26,115,232,0.4)'; };

    const panel = createPanel();
    btn.onclick = () => panel.classList.toggle('visible');

    document.body.appendChild(btn);
  }

  // ==================== INIT ====================
  // Wait for page to fully load
  if (document.readyState === 'complete') {
    setTimeout(createFloatingButton, 1000);
  } else {
    window.addEventListener('load', () => setTimeout(createFloatingButton, 1000));
  }

  // ==================== BATCH ORDER SUPPORT ====================

  /**
   * Run multiple orders sequentially.
   * @param {Array} orders - Array of order objects [{customer, note, items}]
   */
  async function runBatchOrders(orders) {
    log(`Bắt đầu batch: ${orders.length} đơn hàng`);
    const results = [];

    for (let i = 0; i < orders.length; i++) {
      log(`--- Đơn ${i + 1}/${orders.length}: ${orders[i].customer} ---`);
      try {
        await runOrder(orders[i]);
        results.push({ index: i, customer: orders[i].customer, success: true });
        // Wait before next order
        if (i < orders.length - 1) {
          await sleep(2000);
          // Navigate to fresh sale page for next order
          window.location.href = 'https://YOUR_TENANT.kiotviet.vn/sale';
          await sleep(3000);
        }
      } catch (err) {
        results.push({ index: i, customer: orders[i].customer, success: false, error: err.message });
        log(`Lỗi đơn ${i + 1}: ${err.message}`, 'err');
      }
    }

    const successCount = results.filter(r => r.success).length;
    log(`Batch hoàn tất: ${successCount}/${orders.length} đơn thành công`, successCount === orders.length ? 'ok' : 'warn');
    return results;
  }

  // ==================== PRICE OVERRIDE ====================
  
  /**
   * Set unit price for a cart item (by index).
   * KiotViet: price is behind a BUTTON (button.cart-item-{i}) that opens a popover
   * with "Giá bán" input (#adjustPriceIpt). Flow: click button → fill → Enter.
   * @param {number} itemIndex - 0-based cart item index
   * @param {number} price - Target price (0 = FOC/hàng tặng)
   */
  async function setItemPrice(itemIndex, price) {
    // Poll chờ price button xuất hiện
    const priceBtn = await waitForEl(() => document.querySelector('button.cart-item-' + itemIndex), 4000);
  
    if (!priceBtn) {
      // Fallback: find button in same row as qty input (note-cartitem-N)
      const qtyEl = document.getElementById('note-cartitem-' + itemIndex);
      if (qtyEl) {
        let rowEl = qtyEl.closest('.cell-change-price, [class*="cart-item"], tr, li');
        if (!rowEl) {
          let p = qtyEl.parentElement;
          for (let d = 0; d < 6 && p; d++) {
            p = p.parentElement;
            if (p && p.querySelector('button')) { rowEl = p; break; }
          }
        }
        if (rowEl) priceBtn = rowEl.querySelector('button');
      }
    }
  
    if (!priceBtn) {
      log(`  ⚠️ SP ${itemIndex + 1}: Không tìm thấy nút giá (PRICE_BUTTON_NOT_FOUND)`, 'warn');
      return false;
    }
  
    priceBtn.click();
    // Poll chờ popover mở (ô #adjustPriceIpt xuất hiện)
    let priceEl = await waitForEl('#adjustPriceIpt', 3000);
    if (!priceEl) priceEl = document.querySelector('input[ng-model="vm.adjustedPrice"]');
    if (!priceEl) {
      // Fallback: find non-disabled input near "Giá bán" label
      const labels = Array.from(document.querySelectorAll('label, span, div'))
        .filter(el => el.textContent.trim() === 'Giá bán' && el.offsetParent !== null);
      if (labels.length > 0) {
        let container = labels[0].parentElement;
        for (let d = 0; d < 4 && container; d++) {
          const inp = container.querySelector('input:not([disabled])');
          if (inp && inp.offsetParent !== null) { priceEl = inp; break; }
          container = container.parentElement;
        }
      }
    }
  
    if (!priceEl) {
      document.body.click(); // close popover
      await sleep(300);
      log(`  ⚠️ SP ${itemIndex + 1}: Không tìm thấy ô "Giá bán" (ADJUST_PRICE_NOT_FOUND)`, 'warn');
      return false;
    }
  
    // Step 3: Fill price → Enter → blur
    priceEl.focus();
    priceEl.select && priceEl.select();
    setNativeValue(priceEl, String(price));
    priceEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    priceEl.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    const scope = window.angular && angular.element(priceEl).scope();
    if (scope) { try { scope.$apply(); } catch(e){} }
    priceEl.blur();
    await sleep(500);
  
    // Step 4: Verify — read button text after popover closes
    const btnText = (priceBtn.textContent || '').replace(/[^0-9]/g, '');
    const actual = parseInt(btnText) || 0;
    if (actual === price) {
      log(`  💰 Giá SP ${itemIndex + 1}: ${price === 0 ? '0đ (FOC)' : price.toLocaleString() + 'đ'} ✓`, 'ok');
      return true;
    } else {
      // Retry once
      priceBtn.click();
      await sleep(500);
      const retryEl = document.getElementById('adjustPriceIpt') || document.querySelector('input[ng-model="vm.adjustedPrice"]');
      if (retryEl) {
        retryEl.focus();
        setNativeValue(retryEl, '');
        await sleep(100);
        setNativeValue(retryEl, String(price));
        retryEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        retryEl.blur();
        await sleep(500);
      }
      const retryVal = parseInt((priceBtn.textContent || '').replace(/[^0-9]/g, '')) || 0;
      if (retryVal === price) {
        log(`  💰 Giá SP ${itemIndex + 1}: ${price === 0 ? '0đ (FOC)' : price.toLocaleString() + 'đ'} ✓ (retry)`, 'ok');
        return true;
      }
      log(`  ❌ Giá SP ${itemIndex + 1}: cần ${price}, thực tế ${retryVal}`, 'err');
      return false;
    }
  }
  
  /**
   * Override price for the last added item in cart (legacy compat).
   * @param {number} price - New price value
   */
  async function overrideLastItemPrice(price) {
    // Find the last cart item index
    let lastIdx = 0;
    for (let i = 0; i < 50; i++) {
      if (document.getElementById('note-cartitem-' + i)) lastIdx = i;
    }
    await setItemPrice(lastIdx, price);
  }

  // ==================== WEBSOCKET API FOR AI CONTROL ====================

  /**
   * WebSocket server that allows external AI/tools to send commands.
   * Listen on ws://localhost:8047
   * Commands: { action: "runOrder"|"runBatch"|"getStatus"|"getPageInfo", data: {...} }
   */
  let wsServer = null;

  function startWebSocketAPI() {
    if (wsServer) return;

    try {
      // Note: Browser WebSocket can only be client, not server.
      // Instead, we expose a global API on window for external scripts.
      window.__KV_AUTO_ORDER_API__ = {
        version: '2.0.0',

        /** Run a single order */
        runOrder: async (orderData) => {
          try {
            await runOrder(orderData);
            return { success: true };
          } catch (e) {
            return { success: false, error: e.message };
          }
        },

        /** Run batch orders */
        runBatch: async (orders) => {
          return await runBatchOrders(orders);
        },

        /** Override price for last item */
        setPrice: async (price) => {
          await overrideLastItemPrice(price);
          return { success: true };
        },

        /** Get current page info */
        getPageInfo: () => {
          return {
            url: window.location.href,
            module: detectModule(),
            cartItems: getCartItemsSummary(),
            customer: getSelectedCustomer(),
          };
        },

        /** Get cart items */
        getCart: () => getCartItemsSummary(),

        /** Clear cart / start new order */
        newOrder: async () => {
          const btns = document.querySelectorAll('button, a');
          for (const b of btns) {
            if (b.textContent.includes('Đơn mới') || b.textContent.includes('F1')) {
              b.click();
              await sleep(1000);
              return { success: true };
            }
          }
          // Fallback: navigate
          window.location.href = 'https://YOUR_TENANT.kiotviet.vn/sale';
          return { success: true, method: 'navigate' };
        },

        /** Extract table data from current page */
        extractTable: () => {
          const tables = document.querySelectorAll('table');
          if (tables.length === 0) return { error: 'No table found' };
          let mainTable = tables[0];
          let maxRows = 0;
          for (const t of tables) {
            const rows = t.querySelectorAll('tbody tr').length;
            if (rows > maxRows) { maxRows = rows; mainTable = t; }
          }
          const headers = Array.from(mainTable.querySelectorAll('thead th')).map(th => th.textContent.trim());
          const rows = Array.from(mainTable.querySelectorAll('tbody tr')).slice(0, 50).map(tr =>
            Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim())
          );
          return { headers, rows };
        },

        /** Search product on current page */
        searchProduct: async (query) => {
          const input = findInput('Tìm hàng hóa') || findInput('Tìm kiếm');
          if (!input) return { error: 'Search input not found' };
          input.focus();
          setNativeValue(input, query);
          await sleep(DELAY.AFTER_TYPING);
          const results = [];
          const h5s = document.querySelectorAll('h5');
          for (const h of h5s) {
            if (h.offsetParent !== null) results.push(h.textContent.trim());
          }
          return { query, results: results.slice(0, 10) };
        },
      };

      log('WebSocket API exposed: window.__KV_AUTO_ORDER_API__', 'ok');
    } catch (e) {
      log(`WebSocket API error: ${e.message}`, 'err');
    }
  }

  // ==================== HELPER FUNCTIONS FOR API ====================

  function detectModule() {
    const url = window.location.href;
    if (url.includes('/sale/#/?cart=Order') || url.includes('/sale/orders') || url.includes('cart=Order')) return 'sale_order';
    if (url.includes('/sale')) return 'sale_pos';
    if (url.includes('/product')) return 'products';
    if (url.includes('/customer')) return 'customers';
    if (url.includes('/report')) return 'reports';
    return 'unknown';
  }

  function getCartItemsSummary() {
    const items = [];
    const rows = document.querySelectorAll('[class*="cart"] table tbody tr, [class*="order-detail"] tr');
    for (const row of rows) {
      const nameEl = row.querySelector('h5, [class*="name"], td:nth-child(2)');
      const qtyEl = row.querySelector('input');
      if (nameEl) {
        items.push({
          name: nameEl.textContent.trim().slice(0, 80),
          qty: qtyEl ? qtyEl.value : '1'
        });
      }
    }
    return items;
  }

  function getSelectedCustomer() {
    // Look for selected customer name in the order panel
    const customerEls = document.querySelectorAll('[class*="customer"] h5, [class*="customer"] .name, [class*="partner-name"]');
    for (const el of customerEls) {
      const text = el.textContent.trim();
      if (text && text.length > 2 && !text.includes('Tìm khách')) return text;
    }
    return null;
  }

  // ==================== ENHANCED INIT ====================
  // Start WebSocket API
  startWebSocketAPI();

})();

/**
 * =========================================================================
 *  ORDER AUTOMATION - SCRIPT REGISTRY (script-registry.js)
 * =========================================================================
 *  Manages a library of reusable JavaScript scripts for browser automation.
 *  Scripts that work are saved for reuse (0 AI calls next time).
 *  Disposable scripts are auto-deleted after execution.
 *
 *  Flow:
 *    1. Registry.find(taskId) → found? → run with params (0 token)
 *    2. Not found → AI generates script → run → success? → save to registry
 *    3. Fail → fallback to MCP step-by-step
 *
 *  Storage: ~/.kv-browser-profile/script-registry/scripts.json
 * =========================================================================
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const REGISTRY_DIR = path.join(os.homedir(), '.kv-browser-profile', 'script-registry');
const REGISTRY_FILE = path.join(REGISTRY_DIR, 'scripts.json');

class ScriptRegistry {
  constructor() {
    this._scripts = new Map();
    this._load();
  }

  // ==================== PUBLIC API ====================

  /**
   * Find a script by ID or by keyword matching against tags/description.
   * @param {string} query - Script ID (exact) or keyword search
   * @returns {object|null} Script entry or null
   */
  find(query) {
    // Exact ID match first
    if (this._scripts.has(query)) {
      return this._scripts.get(query);
    }
    // Keyword search across tags + description
    const q = query.toLowerCase();
    for (const [, entry] of this._scripts) {
      if (entry.category === 'disposable') continue; // Skip disposables in search
      const tags = (entry.tags || []).map(t => t.toLowerCase());
      const desc = (entry.description || '').toLowerCase();
      if (tags.some(t => q.includes(t) || t.includes(q))) return entry;
      if (desc.includes(q) || q.includes(entry.id.toLowerCase())) return entry;
    }
    return null;
  }

  /**
   * Get a script by exact ID.
   * @param {string} id
   * @returns {object|null}
   */
  get(id) {
    return this._scripts.get(id) || null;
  }

  /**
   * Save a script entry to the registry.
   * @param {object} entry - { id, category, description, params, script, tags }
   */
  save(entry) {
    if (!entry.id || !entry.script) {
      throw new Error('[ScriptRegistry] Script entry must have id and script');
    }
    const existing = this._scripts.get(entry.id);
    const now = new Date().toISOString();
    const record = {
      id: entry.id,
      category: entry.category || 'reusable',
      description: entry.description || '',
      params: entry.params || [],
      script: entry.script,
      tags: entry.tags || [],
      successCount: existing ? existing.successCount : 0,
      failCount: existing ? existing.failCount : 0,
      lastUsed: now,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
      version: existing ? (existing.version || 1) + 1 : 1,
    };
    this._scripts.set(entry.id, record);
    this._persist();
    return record;
  }

  /**
   * Remove a script from the registry.
   * @param {string} id
   */
  remove(id) {
    if (this._scripts.delete(id)) {
      this._persist();
      return true;
    }
    return false;
  }

  /**
   * List scripts, optionally filtered by category.
   * @param {string} [category] - 'reusable' | 'disposable' | undefined (all)
   * @returns {object[]}
   */
  list(category) {
    const all = Array.from(this._scripts.values());
    if (!category) return all;
    return all.filter(s => s.category === category);
  }

  /**
   * Record execution result for a script (updates success/fail counts).
   * @param {string} id
   * @param {boolean} success
   */
  recordResult(id, success) {
    const entry = this._scripts.get(id);
    if (!entry) return;
    if (success) {
      entry.successCount = (entry.successCount || 0) + 1;
    } else {
      entry.failCount = (entry.failCount || 0) + 1;
    }
    entry.lastUsed = new Date().toISOString();
    this._persist();
  }

  /**
   * Remove all disposable scripts (cleanup after a run).
   */
  cleanupDisposables() {
    let removed = 0;
    for (const [id, entry] of this._scripts) {
      if (entry.category === 'disposable') {
        this._scripts.delete(id);
        removed++;
      }
    }
    if (removed > 0) this._persist();
    return removed;
  }

  /**
   * Get registry stats.
   */
  getStats() {
    const all = Array.from(this._scripts.values());
    return {
      total: all.length,
      reusable: all.filter(s => s.category === 'reusable').length,
      disposable: all.filter(s => s.category === 'disposable').length,
      totalSuccess: all.reduce((sum, s) => sum + (s.successCount || 0), 0),
      totalFail: all.reduce((sum, s) => sum + (s.failCount || 0), 0),
    };
  }

  // ==================== PERSISTENCE ====================

  _load() {
    try {
      if (fs.existsSync(REGISTRY_FILE)) {
        const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
        if (data && data.scripts && Array.isArray(data.scripts)) {
          for (const entry of data.scripts) {
            if (entry.id && entry.script) {
              this._scripts.set(entry.id, entry);
            }
          }
        }
      }
    } catch (e) {
      console.warn('[ScriptRegistry] Failed to load registry:', e.message);
    }

    // Always ensure core scripts exist (restore if removed due to past failures)
    // + upgrade seed khi có bản fix mới (seedVersion cao hơn bản đã lưu)
    const CORE_SCRIPT_IDS = ['select_customer', 'add_product', 'set_quantity', 'set_price', 'set_note', 'set_receiver', 'submit_order'];
    const seeds = getSeedScripts();
    let restored = 0;
    for (const seed of seeds) {
      if (!CORE_SCRIPT_IDS.includes(seed.id)) continue;
      const existing = this._scripts.get(seed.id);
      if (!existing) {
        this._scripts.set(seed.id, {
          ...seed,
          successCount: 0,
          failCount: 0,
          lastUsed: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          version: 1,
        });
        restored++;
      } else if ((seed.seedVersion || 0) > (existing.seedVersion || 0)) {
        // Seed mới hơn → ghi đè script đã lưu (giữ lại thống kê thành công/thất bại)
        this._scripts.set(seed.id, {
          ...seed,
          successCount: existing.successCount || 0,
          failCount: existing.failCount || 0,
          lastUsed: existing.lastUsed || new Date().toISOString(),
          createdAt: existing.createdAt || new Date().toISOString(),
          version: (existing.version || 1) + 1,
        });
        restored++;
        console.log(`[ScriptRegistry] Upgraded core script '${seed.id}' to seedVersion ${seed.seedVersion}`);
      }
    }
    if (restored > 0) {
      this._persist();
      console.log(`[ScriptRegistry] Restored ${restored} missing core script(s)`);
    }

    // Seed default scripts if registry is completely empty
    if (this._scripts.size === 0) {
      this._seedDefaults();
    }
  }

  _persist() {
    try {
      if (!fs.existsSync(REGISTRY_DIR)) {
        fs.mkdirSync(REGISTRY_DIR, { recursive: true });
      }
      const data = {
        version: 1,
        updatedAt: new Date().toISOString(),
        scripts: Array.from(this._scripts.values()),
      };
      fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
      console.warn('[ScriptRegistry] Failed to persist registry:', e.message);
    }
  }

  // ==================== SEED SCRIPTS ====================
  // Extracted from the battle-tested _buildDirectOrderScript() logic.

  _seedDefaults() {
    const seeds = getSeedScripts();
    for (const seed of seeds) {
      this._scripts.set(seed.id, {
        ...seed,
        successCount: 0,
        failCount: 0,
        lastUsed: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        version: 1,
      });
    }
    this._persist();
    console.log(`[ScriptRegistry] Seeded ${seeds.length} default scripts`);
  }
}

// ==================== SEED SCRIPT DEFINITIONS ====================

function getSeedScripts() {
  return [
    {
      id: 'select_customer',
      category: 'reusable',
      description: 'Tìm và chọn khách hàng trong ô F4 (customerSearchInput)',
      params: ['customerName'],
      tags: ['customer', 'F4', 'sale-page', 'khách hàng'],
      script: `
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        async function waitForEl(fn, timeout = 4000) { const s = Date.now(); while (Date.now() - s < timeout) { const el = typeof fn === 'function' ? fn() : document.querySelector(fn); if (el) return el; await sleep(100); } return null; }
        function setVal(el, value) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          const scope = window.angular && angular.element(el).scope();
          if (scope) { try { scope.$apply(); } catch(e){} }
        }
        const custInput = document.getElementById('customerSearchInput');
        if (!custInput) return { success: false, error: 'CUSTOMER_INPUT_NOT_FOUND' };
        custInput.focus();
        setVal(custInput, params.customerName);
        await sleep(1200);
        let custFound = false;
        const h5s = Array.from(document.querySelectorAll('h5')).filter(h => h.offsetParent !== null);
        if (h5s.length > 0) {
          h5s[0].click();
          custFound = true;
        } else {
          custInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          custFound = true;
        }
        await sleep(800);
        return { success: custFound, step: 'customer' };
      `,
    },
    {
      id: 'add_product',
      category: 'reusable',
      seedVersion: 2, // v2: fix chọn quy cách — hỗ trợ tuýp/cái/... và KHÔNG fallback sang Thùng cho đơn vị lẻ
      description: 'Tìm sản phẩm bằng code/tên + chọn đơn vị + thêm vào giỏ hàng',
      params: ['code', 'name', 'qty', 'unit'],
      tags: ['product', 'F3', 'sale-page', 'sản phẩm', 'hàng hóa'],
      script: `
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        async function waitForEl(fn, timeout = 4000) { const s = Date.now(); while (Date.now() - s < timeout) { const el = typeof fn === 'function' ? fn() : document.querySelector(fn); if (el) return el; await sleep(100); } return null; }
        function setVal(el, value) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          const scope = window.angular && angular.element(el).scope();
          if (scope) { try { scope.$apply(); } catch(e){} }
        }
        const prodInput = document.getElementById('productSearchInput');
        if (!prodInput) return { success: false, error: 'PRODUCT_INPUT_NOT_FOUND' };
        prodInput.focus();
        setVal(prodInput, params.code || params.name);
        await waitForEl(() => { const h5s = Array.from(document.querySelectorAll('h5')).filter(h => h.offsetParent !== null); return h5s.length > 0 ? h5s[0] : null; }, 4000);
        let prodH5s = Array.from(document.querySelectorAll('h5')).filter(h => h.offsetParent !== null);
        let target = null;
        const unitLower = (params.unit || 'thùng').toLowerCase();
        if (unitLower === 'thùng' || unitLower === 'thung' || unitLower === 'thg') {
          target = prodH5s.find(h => h.textContent.includes('Thùng') || h.textContent.includes('Thung'));
        } else {
          // Đơn vị lẻ (tuýp, chai, bình, lon, can, cái...) → loại trừ option Thùng rồi match theo đơn vị
          const nonBox = prodH5s.filter(h => !/Thùng|Thung/i.test(h.textContent));
          const unitRe = { 'tuýp': /Tuýp|Tuyp/i, 'tuyp': /Tuýp|Tuyp/i, 'tip': /Tuýp|Tuyp/i, 'chai': /Chai|B[iì]nh/i, 'bình': /B[iì]nh|Chai/i, 'binh': /B[iì]nh|Chai/i, 'lon': /Lon|B[iì]nh|Chai/i, 'can': /Can|B[iì]nh|Chai/i }[unitLower];
          if (unitRe) target = nonBox.find(h => unitRe.test(h.textContent));
          if (!target && nonBox.length > 0) target = nonBox[0];
        }
        if (!target && prodH5s.length > 0) {
          target = prodH5s[0];
        }
        if (target) {
          target.click();
          await waitForEl(() => document.getElementById('note-cartitem-0'), 4000);
        } else {
          prodInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          await waitForEl(() => document.getElementById('note-cartitem-0'), 4000);
        }
        // Check stock error
        const bodyText = document.body.innerText;
        if (bodyText.includes('quá số lượng') || bodyText.includes('vượt quá') || bodyText.includes('không đủ')) {
          const closeBtn = Array.from(document.querySelectorAll('button, .close, [aria-label="Close"]'))
            .find(b => b.offsetParent !== null && (b.textContent.includes('Đóng') || b.textContent.includes('Hủy') || b.textContent.trim() === '×' || b.classList.contains('close')));
          if (closeBtn) { closeBtn.click(); await sleep(500); }
          const whMatch = document.body.innerText.match(/(\\w+ Warehouse)/);
          return { success: false, error: 'OUT_OF_STOCK', warehouse: whMatch ? whMatch[1] : 'unknown' };
        }
        return { success: true, step: 'add_product', selected: target ? target.textContent.trim().substring(0, 30) : 'Enter' };
      `,
    },
    {
      id: 'set_quantity',
      seedVersion: 2,
      category: 'reusable',
      description: 'Sửa số lượng cho dòng cart item (theo index)',
      params: ['itemIndex', 'qty'],
      tags: ['quantity', 'số lượng', 'cart', 'sale-page'],
      script: `
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        async function waitForEl(fn, timeout = 4000) { const s = Date.now(); while (Date.now() - s < timeout) { const el = typeof fn === 'function' ? fn() : document.querySelector(fn); if (el) return el; await sleep(100); } return null; }
        function setVal(el, value) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          const scope = window.angular && angular.element(el).scope();
          if (scope) { try { scope.$apply(); } catch(e){} }
        }
        const targetQty = Number(params.qty) || 1;
        const qtyEl = await waitForEl(() => document.getElementById('note-cartitem-' + params.itemIndex)
          || Array.from(document.querySelectorAll('input')).filter(inp => inp.value === '1' && inp.offsetParent !== null).pop(), 3000);
        if (!qtyEl) return { success: false, error: 'QTY_INPUT_NOT_FOUND' };
        const currentQty = parseFloat(qtyEl.value) || 0;
        if (currentQty === targetQty) return { success: true, step: 'quantity', skipped: true };
        qtyEl.focus();
        setVal(qtyEl, String(targetQty));
        qtyEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        const scope2 = window.angular && angular.element(qtyEl).scope();
        if (scope2) { try { scope2.$apply(); } catch(e){} }
        await sleep(400);
        return { success: true, step: 'quantity', qty: targetQty };
      `,
    },
    {
      id: 'set_price',
      category: 'reusable',
      description: 'Nhập đơn giá cho dòng cart item (theo index). Giá 0 = hàng tặng/FOC.',
      params: ['itemIndex', 'price'],
      tags: ['price', 'giá', 'đơn giá', 'cart', 'sale-page'],
      script: `
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        async function waitForEl(fn, timeout = 4000) { const s = Date.now(); while (Date.now() - s < timeout) { const el = typeof fn === 'function' ? fn() : document.querySelector(fn); if (el) return el; await sleep(100); } return null; }
        function setVal(el, value) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          const scope = window.angular && angular.element(el).scope();
          if (scope) { try { scope.$apply(); } catch(e){} }
        }
        const targetPrice = params.price || 0;
        // Poll chờ price button xuất hiện
        let priceBtn = await waitForEl(() => document.querySelector('button.cart-item-' + params.itemIndex), 4000);
        if (!priceBtn) {
          const qtyRow = document.getElementById('note-cartitem-' + params.itemIndex);
          if (qtyRow) {
            let rowEl = qtyRow.closest('.cell-change-price, [class*="cart-item"], tr, li');
            if (!rowEl) { let p = qtyRow.parentElement; for (let d = 0; d < 6 && p; d++) { p = p.parentElement; if (p && p.querySelector('button')) { rowEl = p; break; } } }
            if (rowEl) priceBtn = rowEl.querySelector('button');
          }
        }
        if (!priceBtn) return { success: false, error: 'PRICE_BUTTON_NOT_FOUND', itemIndex: params.itemIndex };
        priceBtn.click();
        // Poll chờ popover mở
        let priceEl = await waitForEl('#adjustPriceIpt', 3000);
        if (!priceEl) priceEl = document.querySelector('input[ng-model="vm.adjustedPrice"]');
        if (!priceEl) {
          const labels = Array.from(document.querySelectorAll('label, span, div')).filter(el => el.textContent.trim() === 'Giá bán' && el.offsetParent !== null);
          if (labels.length > 0) {
            let container = labels[0].parentElement;
            for (let d = 0; d < 4 && container; d++) {
              const inp = container.querySelector('input:not([disabled])');
              if (inp && inp.offsetParent !== null) { priceEl = inp; break; }
              container = container.parentElement;
            }
          }
        }
        if (!priceEl) { document.body.click(); return { success: false, error: 'ADJUST_PRICE_INPUT_NOT_FOUND', itemIndex: params.itemIndex }; }
        priceEl.focus();
        priceEl.select && priceEl.select();
        await sleep(100);
        setVal(priceEl, String(targetPrice));
        await sleep(100);
        priceEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        priceEl.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        priceEl.blur();
        await sleep(600);
        // Verify: read button text after popover closes
        let btnVal = parseInt((priceBtn.textContent || '').replace(/[^0-9]/g, '')) || 0;
        if (btnVal !== targetPrice) {
          // Retry
          priceBtn.click();
          await sleep(500);
          const retryEl = document.getElementById('adjustPriceIpt') || document.querySelector('input[ng-model="vm.adjustedPrice"]');
          if (retryEl) {
            retryEl.focus();
            setVal(retryEl, '');
            await sleep(100);
            setVal(retryEl, String(targetPrice));
            retryEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
            retryEl.blur();
            await sleep(500);
          }
          btnVal = parseInt((priceBtn.textContent || '').replace(/[^0-9]/g, '')) || 0;
        }
        if (btnVal !== targetPrice) {
          return { success: false, error: 'PRICE_MISMATCH', expected: targetPrice, actual: btnVal };
        }
        return { success: true, step: 'price', price: targetPrice };
      `,
    },
    {
      id: 'set_note',
      category: 'reusable',
      description: 'Điền ghi chú đơn hàng vào textarea',
      params: ['notes'],
      tags: ['note', 'ghi chú', 'sale-page'],
      script: `
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        if (!params.notes) return { success: true, step: 'note', skipped: true };
        const textareas = document.querySelectorAll('textarea');
        for (const ta of textareas) {
          if (ta.offsetParent !== null) {
            ta.focus();
            const taSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            taSetter.call(ta, params.notes);
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.dispatchEvent(new Event('change', { bubbles: true }));
            await sleep(300);
            return { success: true, step: 'note' };
          }
        }
        return { success: false, error: 'TEXTAREA_NOT_FOUND' };
      `,
    },
    {
      id: 'set_receiver',
      category: 'reusable',
      description: 'Chọn người nhận đặt (salesman) từ Kendo DropDownList',
      params: ['receiverName'],
      tags: ['receiver', 'salesman', 'người nhận', 'sale-page'],
      script: `
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const receiverName = params.receiverName;
        if (!receiverName) return { success: true, step: 'receiver', skipped: true };
        let receiverSet = false;
        const dropdown = document.querySelector('.saleman-dropdown') || document.querySelector('#salesman .k-dropdown');
        if (dropdown) {
          const currentLabel = dropdown.querySelector('.k-input');
          const currentName = currentLabel ? currentLabel.textContent.trim() : '';
          if (currentName.includes(receiverName)) {
            receiverSet = true;
          } else {
            dropdown.click();
            await sleep(700);
            const popup = document.querySelector('.k-animation-container.salesman-dropdown .k-list-container')
              || document.querySelector('.salesman-dropdown .k-list-container')
              || document.querySelector('.k-animation-container .k-list-container');
            if (popup) {
              const kItems = Array.from(popup.querySelectorAll('.k-item'));
              const exactMatch = kItems.find(i => i.textContent.trim() === receiverName);
              const startsMatch = kItems.find(i => i.textContent.trim().startsWith(receiverName));
              const includesMatch = kItems.find(i => i.textContent.trim().includes(receiverName));
              const match = exactMatch || startsMatch || includesMatch;
              if (match) { match.click(); await sleep(500); receiverSet = true; }
              else { document.body.click(); await sleep(300); }
            } else { document.body.click(); await sleep(300); }
          }
        }
        return { success: receiverSet, step: 'receiver', name: receiverName };
      `,
    },
    {
      id: 'submit_order',
      category: 'reusable',
      description: 'Bấm nút ĐẶT HÀNG và xác nhận modal',
      params: [],
      tags: ['submit', 'đặt hàng', 'confirm', 'sale-page'],
      script: `
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        await sleep(500);
        const buttons = Array.from(document.querySelectorAll('button'));
        const submitBtn = buttons.find(b => {
          const t = b.textContent.trim().toUpperCase();
          return (t === 'ĐẶT HÀNG' || t === 'ĐẶT HÀNG') && b.offsetParent !== null;
        });
        if (!submitBtn) return { success: false, error: 'SUBMIT_BTN_NOT_FOUND' };
        
        // Run clicks asynchronously so evaluate returns immediately. This prevents 
        // the MCP server from hanging if KiotViet navigates away.
        setTimeout(() => {
          submitBtn.click();
          setTimeout(() => {
            const modalBtns = Array.from(document.querySelectorAll('.modal button, [class*="modal"] button, [class*="dialog"] button, .k-window button'));
            const confirmBtn = modalBtns.find(b => {
              const t = b.textContent.trim().toLowerCase();
              return (t.includes('đặt hàng') || t.includes('đồng ý') || t.includes('tiếp tục') || t.includes('ok') || t.includes('confirm'))
                && b.offsetParent !== null;
            });
            if (confirmBtn) confirmBtn.click();
          }, 2000);
        }, 100);
        
        return { success: true, step: 'submit' };
      `,
    },
    {
      id: 'switch_warehouse',
      category: 'reusable',
      description: 'Đổi kho hiện tại sang kho khác (dropdown góc trên bên phải)',
      params: ['warehouseName'],
      tags: ['warehouse', 'kho', 'switch', 'sale-page'],
      script: `
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        // Find warehouse dropdown (usually top-right area)
        const whDropdown = document.querySelector('[class*="warehouse"] .k-dropdown, .warehouse-selector, [ng-model*="warehouse"]')
          || Array.from(document.querySelectorAll('.k-dropdown')).find(d => {
            const label = d.querySelector('.k-input');
            return label && /warehouse|kho/i.test(label.textContent);
          });
        if (!whDropdown) return { success: false, error: 'WAREHOUSE_DROPDOWN_NOT_FOUND' };
        whDropdown.click();
        await sleep(700);
        const popup = document.querySelector('.k-animation-container .k-list-container');
        if (!popup) return { success: false, error: 'WAREHOUSE_POPUP_NOT_FOUND' };
        const items = Array.from(popup.querySelectorAll('.k-item'));
        const target = items.find(i => i.textContent.trim().toLowerCase().includes(params.warehouseName.toLowerCase()));
        if (!target) return { success: false, error: 'WAREHOUSE_NOT_FOUND', available: items.map(i => i.textContent.trim()) };
        target.click();
        await sleep(1500);
        return { success: true, step: 'warehouse', selected: params.warehouseName };
      `,
    },
  ];
}

module.exports = { ScriptRegistry, REGISTRY_DIR, REGISTRY_FILE };

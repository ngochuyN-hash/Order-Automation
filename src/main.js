// =========================================================================
//  APPLICATION ENTRY POINT
//  Imports all feature modules and initializes the app.
// =========================================================================

import { db } from '../db.js';
import { store } from '../store.js';
import { uiRenderer, showToast } from '../ui-renderer.js';
import { aiService } from '../ai-service.js';
import { hasAttributeConflict, hasUnitConflict, normalizeFull } from '../parser.js';

import { workerManager } from './worker-manager.js';
import { CustomerNotes } from './customer-notes.js';
import {
  removeOrderItem, reorderOrderItem, reorderRows,
  removeGiftItem, updateGiftQty, updateGiftOverride,
  toggleGiftKind,
  updateItemQty, updateItemUnit, updateDualPriceLive, commitDualPrice,
  selectComboboxItem, showComboboxDropdown, filterComboboxOptions,
  addCustomPromo, removeCustomPromo, changeRowProduct,
  renderCustomPromos, applyComboboxText,
  quickAddGiftOption, saveCustomAsProduct,
  initComboboxAriaSync
} from './order/actions.js';
import { initCatalogDelegation } from './catalog/delegation.js';
import { initEditTracker } from './edit-tracker.js';
import { populateSellerDropdown } from './seller/manager.js';
import { bindGlobalUIListeners, updateSidebarStatus, initProductEditorDelegation } from './settings/ui.js';
import { KiotVietAutomation } from './kiotviet/automation.js';
import { initAiProfileManager } from './ai/profile-manager.js';
import { HeadlessOrderAPI } from './api/headless.js';
import { initPersistWatch } from './ui/persist-watch.js';
import { initAgentActivity } from './ui/agent-activity.js';
import { initAutoRescan } from './order/builder.js';
import { exportToExcel } from './order/export.js';
import { initModalOverlayFocus } from './ui/confirm-dialog.js';
import { initPendingOrders } from './order/pending.js';

// =========================================================================
//  GLOBAL ERROR HANDLER (renderer)
//  Bắt lỗi JS chưa xử lý để: (1) log đầy đủ ra console phục vụ báo lỗi,
//  (2) thông báo cho user qua toast (có throttle tránh spam).
//  Không tự động nạp lại app — chỉ hiển thị, thao tác đang dở không bị mất.
// =========================================================================

const _errToastTimestamps = [];
function _notifyGlobalError(kind, message) {
  const now = Date.now();
  while (_errToastTimestamps.length && now - _errToastTimestamps[0] > 10000) {
    _errToastTimestamps.shift();
  }
  _errToastTimestamps.push(now);
  // Quá 3 lỗi/10s → chỉ log, ngừng toast để không làm phiền
  if (_errToastTimestamps.length <= 3) {
    try { showToast(`⚠️ Lỗi ${kind}: ${message}`, 'error', null); } catch (_) { /* UI chưa sẵn sàng */ }
  }
}

window.addEventListener('error', (event) => {
  // Lỗi tài nguyên (img/script load fail) không có error object — bỏ qua
  if (!event.error) return;
  const detail = event.error.stack || event.error.message || String(event.error);
  console.error('[Renderer] Uncaught error:', detail);
  _notifyGlobalError('chưa xử lý', event.error.message || 'không xác định');
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  const detail = reason && reason.stack ? reason.stack : String(reason);
  console.error('[Renderer] Unhandled promise rejection:', detail);
  _notifyGlobalError('promise', (reason && reason.message) || String(reason));
});

// =========================================================================
//  APP INITIALIZATION
// =========================================================================

function initApp() {
  try {
    // 1. Instant 0ms Sync Boot of RAM Cache
    db.initSync();

    // 1b. Bật giám sát lỗi persist → banner cảnh báo trên UI (src/ui/persist-watch.js)
    initPersistWatch(db);

    // 2. Initialize Web Worker for fuzzy matching
    workerManager.init(db.getAllProducts(), db.getAliases());

    // 3. Register state update rendering callbacks
    uiRenderer.registerCallbacks({
      removeOrderItem,
      reorderOrderItem,
      reorderRows,
      removeGiftItem,
      updateGiftQty,
      updateItemQty,
      updateItemUnit,
      updateDualPriceLive,
      commitDualPrice,
      selectComboboxItem,
      showComboboxDropdown,
      filterComboboxOptions,
      applyComboboxText,
      addCustomPromo,
      removeCustomPromo,
      changeRowProduct,
      updateGiftOverride,
      toggleGiftKind,
      quickAddGiftOption,
      saveCustomAsProduct,
    });

    // 4. Listen to state changes to update the UI
    // Chỉ render lại bảng đơn khi "hình dạng bảng" đổi (items + quà): state vô can
    // (isLoading, pendingId, AI...) không kéo rebuild toàn bộ bảng → hết khựng
    // khi cuộn danh sách dài. customPromos tự render ở actions khi đổi.
    let _lastOrderTableSig = '';
    store.subscribe((state) => {
      const orderPanel = document.getElementById('panelOrder');
      if (orderPanel && orderPanel.classList.contains('active')) {
        const sig = uiRenderer.getOrderTableSignature(state.currentOrder);
        if (sig !== _lastOrderTableSig) {
          _lastOrderTableSig = sig;
          uiRenderer.renderOrderResults(state.currentOrder);
          renderCustomPromos();
        }
      } else {
        window._orderNeedsRender = true;
      }
    });

    // 5. Bind global UI event listeners
    bindGlobalUIListeners();

    // 5-1. Auto-rescan ô tin nhắn (debounce 1000ms + dialog diff khi nội dung đổi):
    // module đã có sẵn trong src/order/builder.js — wire vào vòng đời app tại đây.
    initAutoRescan();

    // 5-2. Focus trap + Esc-to-close cho modal chung #modalOverlay. Modal này do
    // settings/ui.js và seller/manager.js mở/đóng trực tiếp (file cấm sửa) nên
    // được theo dõi gián tiếp qua MutationObserver trong src/ui/confirm-dialog.js.
    initModalOverlayFocus();

    // 5-3. Đồng bộ aria-expanded cho combobox sản phẩm (đăng ký SAU listener
    // click-outside của settings/ui.js để chạy sau và chỉnh trạng thái đúng).
    initComboboxAriaSync();

    // 5a. Customer Special-Price Notes: bind events & load data
    CustomerNotes.bindEvents();
    CustomerNotes.load();

    // 5a-1. Đơn chờ duyệt: inject direct actions sau khi render sẵn module.
    // pending.js không import trực tiếp export/automation để tránh vòng dependency.
    initPendingOrders({
      exportPending: exportToExcel,
      openKiotViet: (snapshot, options) => KiotVietAutomation.openPanelForOrder(snapshot, options)
    });

    // 5b. Set up delegated event listeners for product editor (Phase 3)
    initProductEditorDelegation();

    // 5c. Set up delegated event listeners for catalog (replaces per-render binding)
    initCatalogDelegation();

    // 5d. Theo dõi chỉnh sửa thuộc tính: đảm bảo KHÔNG edit nào bị mất thầm lặng
    // (Esc đóng modal, tắt app/reload khi đang gõ, Enter, re-render khi input dirty)
    // và LUÔN hiển thị trạng thái lưu (chip + toast + log).
    initEditTracker();

    // 6. Instant UI Render (0ms delay)
    uiRenderer.renderOrderResults(store.getState().currentOrder);

    // 6b. Pre-populate AI Memory textarea with saved memory
    const aiMemoryInput = document.getElementById('aiMemoryInput');
    if (aiMemoryInput) aiMemoryInput.value = db.getMemory() || '';

    // 7. Background Non-Blocking Sync with IndexedDB
    db.init(() => {
      // ── Migration: gỡ alias độc (xung đột thuộc tính với product đích) ──
      {
        const allAliases = db.getAliases();
        const products = db.getAllProducts();
        // First-wins (KHÔNG phải last-wins của Map.from pairs) — khớp semantics
        // _rebuildProductByIdMap trong db.js: id trùng thì giữ product ĐẦU tiên.
        const productMap = new Map();
        for (const p of products) if (!productMap.has(p.id)) productMap.set(p.id, p);
        let removedCount = 0;
        for (const [alias, productId] of Object.entries(allAliases)) {
          // Chỉ xoá alias custom (không xoá DEFAULT_ALIASES)
          if (db.customAliases[alias] === undefined) continue;
          const product = productMap.get(productId);
          if (!product) continue;
          const aliasNorm = normalizeFull(alias);
          if (hasAttributeConflict(aliasNorm, product)) {
            db.removeAlias(alias);
            removedCount++;
          }
        }
        if (removedCount > 0) {
          console.log(`[Migration] Đã gỡ ${removedCount} alias độc (xung đột thuộc tính)`);
        }
      }

      // ── Migration: liên kết quà MKT chưa có productId với sản phẩm danh mục (idempotent) ──
      // [Promo v1.3.0] Rule KM nằm trong campaign.promoRules (type 'total'/'qty' — gifts[].productId).
      {
        let linkedCount = 0;
        const allProducts = db.getAllProducts();
        for (const cKey of Object.keys(db.data.campaigns || {})) {
          const campaign = db.data.campaigns[cKey];
          for (const rule of (campaign.promoRules || [])) {
            if (!Array.isArray(rule.gifts)) continue;
            for (const g of rule.gifts) {
              if (g.productId) continue; // đã liên kết → bỏ qua (idempotent)
              const pid = uiRenderer.resolveMktGiftProductId(g.name, allProducts);
              if (!pid) continue;
              // Chỉ chấp nhận SP có spec chứa "Quà tặng" — tránh persist nhầm SP thương mại
              // (resolve có nhánh forward fallback gắn SP không phải quà khi tên là substring duy nhất)
              const cand = db.findProductById(pid);
              const specNorm = String(cand && cand.spec || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
              if (!specNorm.includes('qua tang')) continue;
              g.productId = pid;
              linkedCount++;
            }
          }
        }
        if (linkedCount > 0) {
          db.save();
          console.log(`[Migration] Đã liên kết ${linkedCount} quà MKT với sản phẩm danh mục`);
        }
      }

      uiRenderer.clearRenderCache();
      workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
      uiRenderer.renderOrderResults(store.getState().currentOrder);
      const memInput = document.getElementById('aiMemoryInput');
      if (memInput && document.activeElement !== memInput) memInput.value = db.getMemory() || '';
      populateSellerDropdown(); // Refresh sellers (may have been restored from IndexedDB)
      updateSidebarStatus();
    }).then(() => {
      // Safety net: always refresh seller dropdown after async init,
      // even if the onUpdate callback was not triggered (updated=false).
      populateSellerDropdown();
    });

    // 8. Restore AI status (profiles are loaded by initAiProfileManager)
    updateSidebarStatus();

    // 8a. Phiên bản app (chỉ có trong Electron; trình duyệt thường ẩn đi)
    if (window.electronAPI && window.electronAPI.getAppVersion) {
      window.electronAPI.getAppVersion().then((v) => {
        const verEl = document.getElementById('sidebarAppVersion');
        if (verEl && v) verEl.textContent = 'v' + v;
      }).catch(() => {});
    }

    // 9. Initialize KiotViet Automation Controller
    KiotVietAutomation.init();

    // 9a. AI Activity Feed — panel hiển thị thao tác của agent ngoài (HTTP API)
    initAgentActivity();

    // 10. Expose Headless Order API for the local HTTP API server
    // (Electron main process calls window.__ORDER_API__ via executeJavaScript)
    window.__ORDER_API__ = HeadlessOrderAPI;

    console.log('Order Automation initialized instantly (0ms access).');
  } catch (err) {
    console.error('Application initialization failed:', err);
    showToast('Lỗi khởi tạo ứng dụng: ' + err.message, 'error');
  }
}

// Start app when DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

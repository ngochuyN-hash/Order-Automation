import { db } from '../../db.js';
import { store } from '../../store.js';
import { uiRenderer, showToast, parseFormattedNumber, formatInputWithDotsAndPreserveCursor } from '../../ui-renderer.js';
import { workerManager } from '../worker-manager.js';
import { applyProductFieldEdit } from '../product-edit.js';
import { saveCatalogSearchState, restoreCatalogSearchState, saveExpandedCatalogCards, restoreExpandedCatalogCards } from '../order/actions.js';
import { showAddProductModal } from '../settings/ui.js';
import { debounce } from '../utils.js';
import { fuzzySearchScore } from '../../parser.js';
import { confirmDialog } from '../ui/confirm-dialog.js';

export function catalogSavedToast(msg) {
  // Hiện toast NGAY khi lưu — bỏ delay 800ms cũ (chỉ gây cảm giác trễ)
  showToast(msg || 'Đã lưu thay đổi danh mục!', 'success');
}

// [Perf phase 2] Helper gộp cặp thao tác lặp lại nhiều chỗ: persist DB (db.save()
// đã debounce) + đồng bộ worker matching. KHÔNG gộp vào db.js để tránh import vòng.
function _persistAndSync() {
  db.save();
  workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
}

// No-op stub — catalog events are now handled via event delegation
// (see initCatalogDelegation below). This is kept for backward compatibility.
window.attachCatalogInteractiveListeners = function() {};

// --- Picker gõ-để-tìm chọn quà MKT cấp sản phẩm (trong Catalog) ---
// Tái dụng pattern .mkt-gift-picker của Settings nhưng dùng wrapper riêng
// .catalog-mkt-gift-picker + class input .catalog-mkt-gift-name để KHÔNG đụng
// delegation của Settings (chỉ match .mkt-gift-name bên trong .mkt-gift-picker).
// Nguyên tắc: tên quà = ĐÚNG p.name của danh mục; KHÔNG tự gán product_id ngầm.

function _normForGiftMatch(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').trim();
}

function _escGiftHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Tìm rule MKT (kind 'mkt_pp') từ input picker */
function _getCatalogMktRule(input) {
  const pId = input.getAttribute('data-product-id');
  const idx = parseInt(input.getAttribute('data-mkt-idx'));
  const cKey = input.closest('[data-campaign-key]')?.getAttribute('data-campaign-key');
  const prod = db.findProductRefById(pId, cKey);
  const rules = (db.getPromoRulesForProduct(pId) || []).filter(r => r.type === 'qty' && r.kind === 'mkt_pp');
  const rule = rules[idx] || null;
  return { prod, rule };
}

/** Render gợi ý bên dưới ô gõ quà MKT — NGUỒN = DANH MỤC (db.getAllProducts()).
 * Ưu tiên SP có spec chứa "Quà tặng" (cùng thương hiệu trước), hiển thị ĐÚNG p.name + mã KV. */
function _renderCatalogMktGiftSuggestions(picker) {
  const input = picker.querySelector('.catalog-mkt-gift-name');
  const box = picker.querySelector('.mkt-gift-suggestions');
  if (!input || !box) return;
  const norm = _normForGiftMatch(input.value);
  const cKey = picker.closest('[data-campaign-key]')?.getAttribute('data-campaign-key') || '';

  const all = db.getAllProducts();
  const isGiftProduct = p => _normForGiftMatch(p.spec || '').includes('qua tang');
  const candidates = [];
  const seen = new Set();
  const push = (p, icon, boostBase) => {
    if (seen.has(p.id)) return;
    const label = p.name || '';
    const hint = p.kvCode || '';
    // Tìm kiếm tự do: ghép tất cả trường (name + spec + kvCode + packaging + campaignName)
    const searchText = _normForGiftMatch(label) + ' ' + _normForGiftMatch(p.spec || '') + ' '
      + _normForGiftMatch(hint) + ' ' + _normForGiftMatch(p.packaging || '')
      + ' ' + _normForGiftMatch(p.campaignName || '');
    let score;
    if (!norm) {
      score = boostBase;
    } else {
      score = fuzzySearchScore(norm, searchText);
      if (score <= 0) return;
      score += boostBase;
    }
    seen.add(p.id);
    const extraHint = [hint, p.spec, p.packaging].filter(Boolean).join(' · ');
    candidates.push({ label, productId: p.id, hint: extraHint, icon, score,
      otherCampaign: !!(p.campaignKey && p.campaignKey !== cKey) });
  };

  // 1) Quà tặng cùng thương hiệu — ưu tiên cao nhất
  all.filter(p => isGiftProduct(p) && p.campaignKey === cKey).forEach(p => push(p, '🎁', 200));
  // 2) Quà tặng thương hiệu khác
  all.filter(p => isGiftProduct(p) && p.campaignKey !== cKey).forEach(p => push(p, '🎁', 100));
  // 3) Có gõ từ khóa: tìm thêm trong TOÀN BỘ sản phẩm còn lại
  if (norm) all.forEach(p => { if (!isGiftProduct(p)) push(p, '📦', 0); });

  // Sắp xếp theo score giảm dần
  candidates.sort((a, b) => b.score - a.score);

  const opts = candidates.slice(0, 40);
  if (!opts.length) {
    box.innerHTML = '<div class="mkt-gift-suggestion-empty">Không thấy sản phẩm nào trong danh mục khớp từ khóa — kiểm tra lại hoặc cứ gõ tên tự do</div>';
  } else {
    box.innerHTML = opts.map(o => `<div class="mkt-gift-suggestion-item${o.otherCampaign ? ' mkt-gift-suggestion-other' : ''}" data-value="${_escGiftHtml(o.label)}" data-product-id="${_escGiftHtml(o.productId)}" title="${o.otherCampaign ? 'Sản phẩm thuộc thương hiệu khác' : 'Sản phẩm trong danh mục'}">${o.icon} ${_escGiftHtml(o.label)}${o.hint ? `<span class="mkt-gift-suggestion-hint">${_escGiftHtml(o.hint)}</span>` : ''}</div>`).join('');
  }
  box.style.display = 'block';
}

function _hideCatalogMktGiftSuggestions(picker) {
  const box = picker.querySelector('.mkt-gift-suggestions');
  if (box) box.style.display = 'none';
}

// Debounce render gợi ý khi GÕ (focusin render ngay)
const _renderCatalogMktGiftSuggestionsDebounced = debounce((picker) => {
  if (!picker || !picker.isConnected) return;
  const input = picker.querySelector('.catalog-mkt-gift-name');
  if (!input || document.activeElement !== input) return;
  _renderCatalogMktGiftSuggestions(picker);
}, 120);

/** Đồng bộ DOM tại chỗ cho MỌI picker của cùng rule MKT (mktHtml xuất hiện 2 chỗ:
 * .catalog-mkt-inline và .catalog-card-detail trong cùng .catalog-list-row).
 * Cập nhật giá trị ô gõ + badge ✓/⚠ — KHÔNG re-render toàn catalog.
 * Ô gõ luôn EDITABLE: gõ tên khác = cách hủy liên kết (Catalog không có nút unlink). */
function _syncCatalogMktGiftDom(row, pId, mktIdx, rule) {
  if (!row || !rule) return;
  const giftPid = (rule.gifts && rule.gifts[0] && rule.gifts[0].productId) || rule.give_product || '';
  const giftName = (rule.gifts && rule.gifts[0] && rule.gifts[0].name) || rule.give_product_name || '';
  const linked = giftPid ? db.getAllProducts().find(p => p.id === giftPid) : null;
  row.querySelectorAll(`.catalog-mkt-gift-picker[data-product-id="${pId}"][data-mkt-idx="${mktIdx}"]`).forEach(pk => {
    const input = pk.querySelector('.catalog-mkt-gift-name');
    if (input) {
      input.value = linked ? linked.name : (giftName || giftPid || '');
    }
    const badge = pk.nextElementSibling;
    if (!badge || !badge.classList || !badge.classList.contains('mkt-gift-link-badge')) return;
    if (linked) {
      badge.className = 'mkt-gift-link-badge mkt-gift-linked';
      badge.textContent = '✓' + (linked.kvCode ? ' ' + linked.kvCode : '');
      badge.title = 'Đã liên kết sản phẩm trong danh mục: ' + linked.name;
    } else {
      badge.className = 'mkt-gift-link-badge mkt-gift-unlinked';
      badge.textContent = '⚠ Chưa liên kết';
      badge.title = 'Chưa gắn với sản phẩm nào trong danh mục — bấm vào ô tên và chọn 1 sản phẩm cụ thể từ danh sách, hoặc cứ gõ tên tự do';
    }
  });
}

/** Hoàn hiển thị ô gõ về giá trị đã lưu (liên kết → p.name; không → name tự do) */
function _revertCatalogMktGiftDisplay(input) {
  const { rule } = _getCatalogMktRule(input);
  if (!rule) return;
  const giftPid = (rule.gifts && rule.gifts[0] && rule.gifts[0].productId) || rule.give_product || '';
  const giftName = (rule.gifts && rule.gifts[0] && rule.gifts[0].name) || rule.give_product_name || '';
  const linked = giftPid ? db.findProductById(giftPid) : null;
  input.value = linked ? linked.name : (giftName || giftPid || '');
}

// --- Picker gõ-để-tìm SẢN PHẨM TẶNG FOC (trong Catalog) ---
// Cùng pattern .foc-gift-picker của Settings Editor: ô gõ hiển thị + select ẩn
// .catalog-foc-input[data-field="give_product"] giữ giá trị thật. Khi chọn gợi ý,
// phát change trên select ẩn → delegation .catalog-foc-input sẵn có tự lưu,
// KHÔNG thêm luồng lưu mới. Gợi ý = chính các <option> của select ẩn
// (danh sách sản phẩm cùng thương hiệu + "Cùng loại"), lọc fuzzy khi gõ.

/** Render gợi ý dưới ô gõ — lọc fuzzy các option của select ẩn theo từ khóa */
function _renderCatalogFocGiftSuggestions(picker) {
  const input = picker.querySelector('.foc-gift-search-input');
  const sel = picker.querySelector('.foc-give-product-input');
  const box = picker.querySelector('.foc-gift-suggestions');
  if (!input || !sel || !box) return;
  const norm = _normForGiftMatch(input.value);
  const opts = Array.from(sel.options)
    .filter(o => !norm || fuzzySearchScore(norm, _normForGiftMatch(o.textContent)) > 0)
    .slice(0, 40);
  if (!opts.length) {
    box.innerHTML = '<div class="foc-gift-suggestion-empty">Không tìm thấy sản phẩm khớp</div>';
  } else {
    box.innerHTML = opts.map(o => `<div class="foc-gift-suggestion-item" data-value="${_escGiftHtml(o.value)}">${_escGiftHtml(o.textContent)}</div>`).join('');
  }
  box.style.display = 'block';
}

/** Đặt tên hiển thị của ô gõ về đúng lựa chọn hiện tại của select ẩn */
function _syncCatalogFocGiftDisplay(picker) {
  const input = picker.querySelector('.foc-gift-search-input');
  const sel = picker.querySelector('.foc-give-product-input');
  if (!input || !sel) return;
  const cur = sel.options[sel.selectedIndex];
  input.value = cur ? cur.textContent : '';
}

// --- Event Delegation for Catalog (replaces per-render listener binding) ---
// Binds ONCE on the catalog container; handles all click/change events
// through bubbling, eliminating thousands of per-element handler attachments.
export function initCatalogDelegation() {
  const container = document.getElementById('catalogContent');
  if (!container) return;

  // ── Toolbar tĩnh phía trên danh sách (index.html, không bị re-render hủy) ──

  // Toggle kiểu xem: "Danh sách" (phẳng, mặc định) / "Theo thương hiệu" (gom section)
  const viewToggle = document.getElementById('catalogViewToggle');
  if (viewToggle) {
    viewToggle.addEventListener('click', (e) => {
      const btn = e.target.closest('.catalog-view-btn');
      if (!btn) return;
      const mode = btn.getAttribute('data-view');
      if (mode === uiRenderer.getCatalogViewMode()) return;
      const _searchState = saveCatalogSearchState();
      const _expanded = saveExpandedCatalogCards();
      uiRenderer.setCatalogViewMode(mode);
      restoreExpandedCatalogCards(_expanded);
      restoreCatalogSearchState(_searchState);
    });
  }

  // Nút "Thêm sản phẩm" toàn cục: mở form với thương hiệu đang lọc (nếu có),
  // ngược lại pre-select thương hiệu đầu — form vẫn cho đổi thương hiệu khi lưu.
  const addProductBtn = document.getElementById('btnCatalogAddProduct');
  if (addProductBtn) {
    addProductBtn.addEventListener('click', () => {
      const cur = uiRenderer.getCatalogCampaignFilter();
      const firstCamp = Object.keys(db.data.campaigns || {})[0];
      showAddProductModal(cur !== 'all' ? cur : firstCamp, () => {
        uiRenderer.renderCatalog(uiRenderer.getCatalogCampaignFilter());
      });
    });
  }

  // Helper: re-render catalog while preserving search state & expanded cards
  function refreshCatalog() {
    const _searchState = saveCatalogSearchState();
    const _expanded = saveExpandedCatalogCards();
    const curFilter = uiRenderer.getCatalogCampaignFilter();
    uiRenderer.renderCatalog(curFilter);
    restoreExpandedCatalogCards(_expanded);
    restoreCatalogSearchState(_searchState);
  }

  // Hook cho modal chỉnh sửa sâu: sau khi đóng modal thì đồng bộ lại danh mục
  // (giữ nguyên bộ lọc tìm kiếm / campaign / trạng thái mở rộng card).
  window.refreshCatalogAfterEditor = refreshCatalog;

  // Đảo thứ tự dòng quà FOC/MKT (nút ▲/▼ trong card): swap 2 phần tử liền kề trong
  // mảng rule + lưu + re-render.
  function moveCatalogRule(btn, kind) {
    const pId = btn.getAttribute('data-product-id');
    const idx = parseInt(btn.getAttribute(kind === 'foc' ? 'data-foc-idx' : 'data-mkt-idx'));
    const dir = btn.getAttribute('data-dir');
    const prod = db.findProductById(pId);
    if (!prod || !prod.campaignKey || !db.data.campaigns[prod.campaignKey]) return;
    const camp = db.data.campaigns[prod.campaignKey];
    const rules = (camp.promoRules || []).filter(r => r && r.type === 'qty' && r.kind === (kind === 'foc' ? 'foc' : 'mkt_pp') && r.productId === pId);
    if (rules.length <= 1) return;
    const j = dir === 'up' ? idx - 1 : idx + 1;
    if (j < 0 || j >= rules.length) return;
    const r1 = rules[idx];
    const r2 = rules[j];
    const pos1 = camp.promoRules.indexOf(r1);
    const pos2 = camp.promoRules.indexOf(r2);
    if (pos1 >= 0 && pos2 >= 0) {
      [camp.promoRules[pos1], camp.promoRules[pos2]] = [camp.promoRules[pos2], camp.promoRules[pos1]];
      _persistAndSync();
      const scroller = btn.closest('.catalog-panel-wrap');
      const scrollTop = scroller ? scroller.scrollTop : 0;
      refreshCatalog();
      if (scroller) scroller.scrollTop = scrollTop;
      catalogSavedToast('Đã đổi thứ tự quà!');
    }
  }

  // ── Click delegation ──
  container.addEventListener('click', async (e) => {
    // Bấm vào TÊN SP trên hàng danh mục = mở/đóng chi tiết (vùng bấm lớn thay cho
    // nút ▸ 18px). Bỏ qua nếu đang bấm vào control bên trong (input/button/select).
    const nameHit = e.target.closest('.catalog-row-name');
    if (nameHit && !e.target.closest('button, input, select, textarea')) {
      const row = nameHit.closest('.catalog-list-row');
      const toggle = row && row.querySelector('.btn-toggle-catalog-card');
      if (toggle) toggle.click();
      return;
    }

    // Resolve clicked element: try button first, then .btn-toggle-mkt-inline (which is a span)
    const btn = e.target.closest('button') || e.target.closest('.btn-toggle-mkt-inline');
    if (!btn) return;

    // Remove tier
    if (btn.matches('.btn-remove-catalog-tier')) {
      const pId = btn.getAttribute('data-product-id');
      const cKey = btn.closest('[data-campaign-key]')?.getAttribute('data-campaign-key');
      const idx = parseInt(btn.getAttribute('data-tier-idx'));
      const prod = db.findProductRefById(pId, cKey);
      if (prod && prod.tiers && prod.tiers.length > idx) {
        prod.tiers.splice(idx, 1);
        _persistAndSync();
        refreshCatalog();
        showToast('Đã xóa mốc giá!', 'info');
      }
      return;
    }

    // Add tier
    if (btn.matches('.btn-add-catalog-tier')) {
      const pId = btn.getAttribute('data-product-id');
      const cKey = btn.closest('[data-campaign-key]')?.getAttribute('data-campaign-key');
      const prod = db.findProductRefById(pId, cKey);
      if (prod) {
        if (!prod.tiers) prod.tiers = [];
        prod.tiers.push({ min_qty: 1, max_qty: 999, price: 0, label: 'Mốc mới' });
        _persistAndSync();
        refreshCatalog();
        showToast('Đã thêm mốc giá!', 'success');
      }
      return;
    }

    // Remove FOC
    if (btn.matches('.btn-remove-catalog-foc')) {
      const pId = btn.getAttribute('data-product-id');
      const idx = parseInt(btn.getAttribute('data-foc-idx'));
      const prod = db.findProductById(pId);
      if (prod && prod.campaignKey && db.data.campaigns[prod.campaignKey]) {
        const camp = db.data.campaigns[prod.campaignKey];
        const focRules = (camp.promoRules || []).filter(r => r && r.type === 'qty' && r.kind === 'foc' && r.productId === pId);
        const target = focRules[idx];
        if (target) {
          camp.promoRules = camp.promoRules.filter(r => r !== target);
          _persistAndSync();
          refreshCatalog();
          showToast('Đã xóa khuyến mãi FOC!', 'info');
        }
      }
      return;
    }

    // Add FOC
    if (btn.matches('.btn-add-catalog-foc')) {
      const pId = btn.getAttribute('data-product-id');
      const prod = db.findProductById(pId);
      if (prod && prod.campaignKey && db.data.campaigns[prod.campaignKey]) {
        const camp = db.data.campaigns[prod.campaignKey];
        camp.promoRules = camp.promoRules || [];
        camp.promoRules.push({
          id: 'promo_' + pId + '_foc_' + Date.now().toString(36),
          type: 'qty', scope: 'product', enabled: true, kind: 'foc',
          productId: pId,
          buy: { qty: 10, unit: 'thùng' },
          gifts: [{ qty: 1, productId: '__same__', unit: prod.unit || 'chai' }],
          label: '', note: ''
        });
        _persistAndSync();
        refreshCatalog();
        showToast('Đã thêm khuyến mãi FOC!', 'success');
      }
      return;
    }

    // Đảo thứ tự dòng quà FOC / MKT (nút ▲/▼)
    if (btn.matches('.btn-move-catalog-foc')) {
      moveCatalogRule(btn, 'foc');
      return;
    }
    if (btn.matches('.btn-move-catalog-mkt')) {
      moveCatalogRule(btn, 'mkt');
      return;
    }

    // Toggle inline MKT editor from badge click
    if (btn.matches('.btn-toggle-mkt-inline')) {
      e.stopPropagation();
      const pId = btn.getAttribute('data-product-id');
      const row = btn.closest('.catalog-list-row');
      const inline = row ? row.querySelector('.catalog-mkt-inline[data-mkt-product-id="' + pId + '"]') : null;
      if (inline) {
        const isVisible = inline.style.display !== 'none';
        document.querySelectorAll('.catalog-mkt-inline').forEach(el => el.style.display = 'none');
        inline.style.display = isVisible ? 'none' : 'block';
      }
      return;
    }

    // Remove MKT
    if (btn.matches('.btn-remove-catalog-mkt')) {
      const pId = btn.getAttribute('data-product-id');
      const idx = parseInt(btn.getAttribute('data-mkt-idx'));
      const prod = db.findProductById(pId);
      if (prod && prod.campaignKey && db.data.campaigns[prod.campaignKey]) {
        const camp = db.data.campaigns[prod.campaignKey];
        const mktRules = (camp.promoRules || []).filter(r => r && r.type === 'qty' && r.kind === 'mkt_pp' && r.productId === pId);
        const target = mktRules[idx];
        if (target) {
          camp.promoRules = camp.promoRules.filter(r => r !== target);
          _persistAndSync();
          refreshCatalog();
          showToast('Đã xóa quà MKT!', 'info');
        }
      }
      return;
    }

    // Cấu hình "tặng 1 trong N quà" cho rule MKT theo sản phẩm
    if (btn.matches('.btn-catalog-mkt-options')) {
      const pId = btn.getAttribute('data-product-id');
      const idx = parseInt(btn.getAttribute('data-mkt-idx'));
      const prod = db.findProductById(pId);
      const mktRules = prod && prod.campaignKey ? (db.getPromoRulesForProduct(pId) || []).filter(r => r.type === 'qty' && r.kind === 'mkt_pp') : [];
      const rule = mktRules[idx];
      if (!prod || !rule) return;
      rule.gifts = Array.isArray(rule.gifts) && rule.gifts.length ? rule.gifts : [{ qty: 1, productId: '', unit: 'cái' }];
      const g0 = rule.gifts[0];
      uiRenderer.openGiftOptionsEditor({
        subtitle: `Quà MKT — ${prod.name}`,
        currentOptions: g0.options || null,
        currentSubOptions: g0.subOptions || null,
        onSaved: (res) => {
          if (res === null) {
            delete g0.options;
            delete g0.subOptions;
          } else {
            g0.options = res.options;
            if (Object.keys(res.subOptions).length > 0) g0.subOptions = res.subOptions;
            else delete g0.subOptions;
            const first = db.findProductById(res.options[0]);
            g0.productId = res.options[0];
            if (first) g0.name = first.name;
          }
          _persistAndSync();
          refreshCatalog();
          showToast(res === null ? 'Đã bỏ cấu hình chọn nhiều quà!' : `Đã lưu: tặng 1 trong ${res.options.length} quà!`, 'success');
        }
      });
      return;
    }

    // Cấu hình "tặng 1 trong N quà" cho rule FOC theo sản phẩm
    if (btn.matches('.btn-catalog-foc-options')) {
      const pId = btn.getAttribute('data-product-id');
      const idx = parseInt(btn.getAttribute('data-foc-idx'));
      const prod = db.findProductById(pId);
      const focRules = prod && prod.campaignKey ? (db.getPromoRulesForProduct(pId) || []).filter(r => r.type === 'qty' && r.kind === 'foc') : [];
      const rule = focRules[idx];
      if (!prod || !rule) return;
      rule.gifts = Array.isArray(rule.gifts) && rule.gifts.length ? rule.gifts : [{ qty: 1, productId: '' }];
      const g0 = rule.gifts[0];
      uiRenderer.openGiftOptionsEditor({
        subtitle: `Khuyến mãi FOC — ${prod.name}`,
        currentOptions: g0.options || null,
        currentSubOptions: g0.subOptions || null,
        onSaved: (res) => {
          if (res === null) {
            delete g0.options;
            delete g0.subOptions;
          } else {
            g0.options = res.options;
            if (Object.keys(res.subOptions).length > 0) g0.subOptions = res.subOptions;
            else delete g0.subOptions;
            g0.productId = res.options[0];
          }
          _persistAndSync();
          refreshCatalog();
          showToast(res === null ? 'Đã bỏ cấu hình chọn nhiều quà!' : `Đã lưu: tặng 1 trong ${res.options.length} quà!`, 'success');
        }
      });
      return;
    }

    // [+] Thêm nhanh 1 quà thay thế vào nhóm "1 trong N" của rule MKT theo sản phẩm
    if (btn.matches('.btn-catalog-mkt-quickadd')) {
      const pId = btn.getAttribute('data-product-id');
      const idx = parseInt(btn.getAttribute('data-mkt-idx'));
      const prod = db.findProductById(pId);
      const mktRules = prod && prod.campaignKey ? (db.getPromoRulesForProduct(pId) || []).filter(r => r.type === 'qty' && r.kind === 'mkt_pp') : [];
      const rule = mktRules[idx];
      if (!prod || !rule) return;
      rule.gifts = Array.isArray(rule.gifts) && rule.gifts.length ? rule.gifts : [{ qty: 1, productId: '', unit: 'cái' }];
      const g0 = rule.gifts[0];
      const giftTarget = {
        give_product_options: g0.options || [],
        give_product_sub_options: g0.subOptions || null
      };
      uiRenderer.openQuickGiftAdd(btn, giftTarget, {
        seedId: g0.productId || null,
        onAdded: () => {
          g0.options = giftTarget.give_product_options;
          if (giftTarget.give_product_sub_options) g0.subOptions = giftTarget.give_product_sub_options;
          if (!g0.productId && g0.options.length) {
            const first = db.findProductById(g0.options[0]);
            g0.productId = g0.options[0];
            if (first) g0.name = first.name;
          }
          _persistAndSync();
          refreshCatalog();
        }
      });
      return;
    }

    // [+] Thêm nhanh 1 quà thay thế vào nhóm "1 trong N" của rule FOC theo sản phẩm
    if (btn.matches('.btn-catalog-foc-quickadd')) {
      const pId = btn.getAttribute('data-product-id');
      const idx = parseInt(btn.getAttribute('data-foc-idx'));
      const prod = db.findProductById(pId);
      const focRules = prod && prod.campaignKey ? (db.getPromoRulesForProduct(pId) || []).filter(r => r.type === 'qty' && r.kind === 'foc') : [];
      const rule = focRules[idx];
      if (!prod || !rule) return;
      rule.gifts = Array.isArray(rule.gifts) && rule.gifts.length ? rule.gifts : [{ qty: 1, productId: '' }];
      const g0 = rule.gifts[0];
      const seedId = g0.productId === '__same__' ? prod.id : (g0.productId || null);
      const giftTarget = {
        give_product_options: g0.options || [],
        give_product_sub_options: g0.subOptions || null
      };
      uiRenderer.openQuickGiftAdd(btn, giftTarget, {
        seedId,
        onAdded: () => {
          g0.options = giftTarget.give_product_options;
          if (giftTarget.give_product_sub_options) g0.subOptions = giftTarget.give_product_sub_options;
          if (!g0.productId && g0.options.length) g0.productId = g0.options[0];
          _persistAndSync();
          refreshCatalog();
        }
      });
      return;
    }

    // Add MKT
    if (btn.matches('.btn-add-catalog-mkt')) {
      const pId = btn.getAttribute('data-product-id');
      const prod = db.findProductById(pId);
      if (prod && prod.campaignKey && db.data.campaigns[prod.campaignKey]) {
        const camp = db.data.campaigns[prod.campaignKey];
        camp.promoRules = camp.promoRules || [];
        camp.promoRules.push({
          id: 'promo_' + pId + '_mkt_pp_' + Date.now().toString(36),
          type: 'qty', scope: 'product', enabled: true, kind: 'mkt_pp',
          productId: pId,
          buy: { qty: 1, unit: 'thùng' },
          gifts: [{ qty: 1, productId: '', unit: 'cái', name: '' }],
          label: '', note: ''
        });
        _persistAndSync();
        refreshCatalog();
        showToast('Đã thêm quà MKT!', 'success');
      }
      return;
    }

    // LUỒNG MỚI: Mở chỉnh sửa sâu NGAY trong Danh mục — không chuyển tab Settings,
    // không cuộn tìm card. Modal chứa toàn bộ trình chỉnh sửa (Giá / FOC / Aliases)
    // của đúng sản phẩm này, mở tức thì khi bấm.
    if (btn.matches('.btn-go-to-editor')) {
      const campKey = btn.getAttribute('data-campaign-key');
      const pId = btn.getAttribute('data-product-id');
      if (typeof window.openProductEditorModal === 'function') {
        window.openProductEditorModal(campKey, pId);
      } else {
        showToast('Không mở được trình chỉnh sửa sâu!', 'error');
      }
      return;
    }

    // Toggle catalog card detail
    if (btn.matches('.btn-toggle-catalog-card')) {
      const pId = btn.getAttribute('data-product-id');
      const detail = document.querySelector(`.catalog-card-detail[data-detail-id="${pId}"]`);
      if (!detail) return;
      const isOpen = detail.style.display !== 'none';
      detail.style.display = isOpen ? 'none' : 'block';
      btn.textContent = isOpen ? '▸' : '▾';
      return;
    }

    // Nhảy tới package anh em (chip "Quy cách khác" — hiển thị mã KV package)
    if (btn.matches('.btn-goto-package')) {
      const pId = btn.getAttribute('data-product-id');
      let row = document.querySelector(`.catalog-list-row[data-product-id="${pId}"]`);
      if (!row) {
        const product = db.findProductById(pId);
        if (!product) { showToast('Sản phẩm này không còn trong danh mục!', 'warning'); return; }
        clearTimeout(window._catalogSearchTimer);
        uiRenderer._catalogSearch = '';
        const search = document.getElementById('catalogSearchInput');
        if (search) search.value = '';
        const category = document.getElementById('catalogCategoryFilter');
        if (category) category.value = 'all';
        uiRenderer.renderCatalog(product.campaignKey);
        row = document.querySelector(`.catalog-list-row[data-product-id="${pId}"]`);
        if (!row) return;
      }
      const detail = row.querySelector(`.catalog-card-detail[data-detail-id="${pId}"]`);
      if (detail && detail.style.display === 'none') {
        detail.style.display = 'block';
        const toggle = row.querySelector('.btn-toggle-catalog-card');
        if (toggle) toggle.textContent = '▾';
      }
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row.style.outline = '2px solid var(--accent-blue)';
      setTimeout(() => { row.style.outline = ''; }, 2500);
      return;
    }

    // Delete product
    if (btn.matches('.btn-delete-catalog-product')) {
      const pId = btn.getAttribute('data-product-id');
      const cKey = btn.getAttribute('data-campaign-key') || btn.closest('[data-campaign-key]')?.getAttribute('data-campaign-key');
      const prod = db.findProductById(pId, cKey);
      const nm = prod ? prod.name : pId;
      if (await confirmDialog({ title: '⚠️ Xóa sản phẩm', message: `Xóa sản phẩm "${nm}"?`, danger: true })) {
        db.deleteProduct(pId);
        workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
        refreshCatalog();
        showToast('Đã xóa sản phẩm!', 'info');
      }
      return;
    }

    // Add new product to campaign (opens shared modal)
    if (btn.matches('.btn-add-catalog-product')) {
      const campKey = btn.getAttribute('data-campaign-key');
      showAddProductModal(campKey, () => {
        uiRenderer.renderCatalog(uiRenderer.getCatalogCampaignFilter());
      });
      return;
    }
  });

  // ── Change delegation ──
  container.addEventListener('change', (e) => {
    const target = e.target;

    // Product field input — MỌI chỉnh sửa thuộc tính sản phẩm (name/spec/unit/
    // packaging/category/box_size/kvCode/kvCodeThung...) đều đi qua
    // applyProductFieldEdit để đảm bảo validation + lưu ĐÚNG API + ghi log.
    // (FIX: trước đây kvCode chỉ gọi updateProduct → bị kv-name-map.json đè,
    // chỉnh sửa không có hiệu lực dù UI vẫn báo "Đã cập nhật".)
    if (target.matches('.catalog-product-input[data-product-id]')) {
      const pId = target.getAttribute('data-product-id');
      const field = target.getAttribute('data-field');
      const result = applyProductFieldEdit(pId, field, target.value);

      if (!result.ok) {
        // Hoàn giá trị đã lưu trước đó để UI không hiển thị giá trị không được lưu
        if (result.revertValue !== undefined) target.value = result.revertValue;
        showToast(result.message || 'Không lưu được thay đổi!', 'error');
        return;
      }

      // KV thùng: xóa override (rỗng) → hiển thị lại mã tự phân
      if (field === 'kvCodeThung') {
        target.value = result.value || result.autoValue || '';
        catalogSavedToast(result.value
          ? `Đã ghi đè mã KV thùng: ${result.value}`
          : 'Đã xóa ghi đè — mã thùng quay về tự động (mã gốc + \'-1\')');
        return;
      }

      if (field === 'kvCode') {
        catalogSavedToast(result.value ? `Đã cập nhật mã KV: ${result.value}` : 'Đã xóa mã KV');
        return;
      }

      if (field === 'box_size') {
        // Cập nhật badge ×N trong danh sách catalog (bên ngoài) + badge trong detail (nếu có)
        const row = target.closest('.catalog-list-row') || document.querySelector(`.catalog-list-row[data-product-id="${pId}"]`);
        const badges = row ? row.querySelectorAll('.packing-multiplier-badge') : [];
        badges.forEach(b => { b.textContent = `×${result.value}`; });
        target.value = result.value; // hiển thị giá trị ĐÃ CHUẨN HÓA (VD: gõ "abc" → 12)
      }

      catalogSavedToast(`Đã cập nhật sản phẩm!${field === 'box_size' ? ` Nhân thùng: ×${result.value}.` : ''}`);
      return;
    }

    // Tier input
    if (target.matches('.catalog-tier-input[data-product-id]')) {
      const pId = target.getAttribute('data-product-id');
      const cKey = target.closest('[data-campaign-key]')?.getAttribute('data-campaign-key');
      const idx = parseInt(target.getAttribute('data-tier-idx'));
      const field = target.getAttribute('data-field');
      let val = target.value;
      if (field === 'price') val = parseFormattedNumber(val);
      const prod = db.findProductRefById(pId, cKey);
      if (prod && prod.tiers && prod.tiers[idx]) {
        prod.tiers[idx][field] = val;
        _persistAndSync();
        catalogSavedToast('Đã cập nhật bảng giá!');
      }
      return;
    }

    // FOC input (Promo v1.3.0)
    if (target.matches('.catalog-foc-input[data-product-id]')) {
      const pId = target.getAttribute('data-product-id');
      const idx = parseInt(target.getAttribute('data-foc-idx'));
      const field = target.getAttribute('data-field');
      let val = target.value;
      if (field === 'buy_qty' || field === 'give_qty') val = parseInt(val) || 1;
      const prod = db.findProductById(pId);
      if (prod && prod.campaignKey && db.data.campaigns[prod.campaignKey]) {
        const camp = db.data.campaigns[prod.campaignKey];
        const focRules = (camp.promoRules || []).filter(r => r && r.type === 'qty' && r.kind === 'foc' && r.productId === pId);
        const rule = focRules[idx];
        if (rule) {
          rule.gifts = Array.isArray(rule.gifts) && rule.gifts.length ? rule.gifts : [{ qty: 1, productId: '' }];
          rule.buy = rule.buy || { qty: 1, unit: 'thùng' };
          if (field === 'buy_qty') rule.buy.qty = val;
          else if (field === 'buy_unit') rule.buy.unit = val;
          else if (field === 'give_qty') rule.gifts[0].qty = val;
          else if (field === 'give_unit') rule.gifts[0].unit = val;
          else if (field === 'give_product') rule.gifts[0].productId = val;
          _persistAndSync();
          catalogSavedToast('Đã cập nhật quà tặng FOC!');
        }
      }
      return;
    }

    // MKT input (Promo v1.3.0)
    if (target.matches('.catalog-mkt-input[data-product-id]')) {
      const pId = target.getAttribute('data-product-id');
      const idx = parseInt(target.getAttribute('data-mkt-idx'));
      const field = target.getAttribute('data-field');
      let val = target.value;
      if (field === 'buy_qty' || field === 'give_qty') val = parseInt(val) || 1;
      const prod = db.findProductById(pId);
      if (prod && prod.campaignKey && db.data.campaigns[prod.campaignKey]) {
        const camp = db.data.campaigns[prod.campaignKey];
        const mktRules = (camp.promoRules || []).filter(r => r && r.type === 'qty' && r.kind === 'mkt_pp' && r.productId === pId);
        const rule = mktRules[idx];
        if (rule) {
          rule.gifts = Array.isArray(rule.gifts) && rule.gifts.length ? rule.gifts : [{ qty: 1, productId: '', unit: 'cái' }];
          rule.buy = rule.buy || { qty: 1, unit: 'thùng' };
          if (field === 'buy_qty') rule.buy.qty = val;
          else if (field === 'buy_unit') rule.buy.unit = val;
          else if (field === 'give_qty') rule.gifts[0].qty = val;
          else if (field === 'give_unit') rule.gifts[0].unit = val;
          _persistAndSync();
          catalogSavedToast('Đã cập nhật quà MKT!');
        }
      }
      return;
    }

    // Chế độ "Tự gõ tên" của picker quà MKT: gõ tay không chọn gợi ý →
    // lưu name theo text gõ và XÓA productId (KHÔNG tự gán id ngầm)
    if (target.matches('.catalog-mkt-gift-name')) {
      const { rule } = _getCatalogMktRule(target);
      if (!rule) return;
      rule.gifts = Array.isArray(rule.gifts) && rule.gifts.length ? rule.gifts : [{ qty: 1, productId: '', unit: 'cái' }];
      const typed = (target.value || '').trim();
      const linked = rule.gifts[0].productId ? db.findProductById(rule.gifts[0].productId) : null;
      if (linked && _normForGiftMatch(typed) === _normForGiftMatch(linked.name)) return;
      rule.gifts[0].name = typed;
      rule.gifts[0].productId = '';
      _persistAndSync();
      const row = target.closest('.catalog-list-row');
      _syncCatalogMktGiftDom(row, target.getAttribute('data-product-id'), target.getAttribute('data-mkt-idx'), rule);
      catalogSavedToast('Đã lưu tên quà MKT (chưa liên kết danh mục)');
      return;
    }
  });

  // ── Input delegation: live comma formatting for tier price ──
  container.addEventListener('input', (e) => {
    if (e.target.matches('.catalog-tier-input[data-field="price"]')) {
      formatInputWithDotsAndPreserveCursor(e.target);
    }
    // Gõ tìm quà MKT trong Catalog — gợi ý render qua debounce cho đỡ giật khi gõ liên tục
    if (e.target.matches('.catalog-mkt-gift-name')) {
      const picker = e.target.closest('.catalog-mkt-gift-picker');
      if (picker) _renderCatalogMktGiftSuggestionsDebounced(picker);
    }
  });

  // ── Focus delegation cho picker quà MKT ──
  container.addEventListener('focusin', (e) => {
    if (e.target.matches('.catalog-mkt-gift-name')) {
      const picker = e.target.closest('.catalog-mkt-gift-picker');
      if (picker) _renderCatalogMktGiftSuggestions(picker);
    }
  });
  container.addEventListener('focusout', (e) => {
    if (!e.target.matches('.catalog-mkt-gift-name')) return;
    const picker = e.target.closest('.catalog-mkt-gift-picker');
    const related = e.relatedTarget;
    if (picker && related && picker.contains(related)) return;
    setTimeout(() => {
      if (!picker) return;
      if (document.activeElement && picker.contains(document.activeElement)) return;
      _hideCatalogMktGiftSuggestions(picker);
      // Blur không chọn gợi ý → hoàn hiển thị về giá trị đã lưu
      // (change đã lưu text gõ trước đó nếu có; đọc lại từ dữ liệu)
      _revertCatalogMktGiftDisplay(e.target);
    }, 120);
  });

  // ── Chọn gợi ý quà MKT (mousedown + preventDefault để giữ focus, không gây blur/change) ──
  container.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.mkt-gift-suggestion-item');
    if (!item) return;
    const picker = item.closest('.catalog-mkt-gift-picker');
    if (!picker) return; // gợi ý của Settings — để delegation Settings tự xử
    // Hủy render gợi ý đang chờ của debounce — tránh timer nổ SAU khi đã chọn,
    // bật mở lại dropdown với danh sách item stale
    _renderCatalogMktGiftSuggestionsDebounced.cancel();
    e.preventDefault();
    const input = picker.querySelector('.catalog-mkt-gift-name');
    if (!input) return;
    const productId = item.getAttribute('data-product-id');
    const label = item.getAttribute('data-value') || '';
    if (!productId) return;
    const { rule } = _getCatalogMktRule(input);
    if (!rule) return;
    rule.gifts = Array.isArray(rule.gifts) && rule.gifts.length ? rule.gifts : [{ qty: 1, productId: '', unit: 'cái' }];
    rule.gifts[0].productId = productId;
    rule.gifts[0].name = label;
    _persistAndSync();
    const row = picker.closest('.catalog-list-row');
    const pId = input.getAttribute('data-product-id');
    const mktIdx = input.getAttribute('data-mkt-idx');
    _syncCatalogMktGiftDom(row, pId, mktIdx, rule);
    _hideCatalogMktGiftSuggestions(picker);
    catalogSavedToast(`Đã liên kết quà MKT: ${label}`);
  });

  // ── Picker gõ-để-tìm sản phẩm tặng FOC (bấm vào ô là mở list, gõ để lọc) ──
  container.addEventListener('focusin', (e) => {
    if (!e.target.matches('.foc-gift-search-input')) return;
    const picker = e.target.closest('.foc-gift-picker');
    if (picker) _renderCatalogFocGiftSuggestions(picker);
  });
  container.addEventListener('input', (e) => {
    if (!e.target.matches('.foc-gift-search-input')) return;
    const picker = e.target.closest('.foc-gift-picker');
    if (picker) _renderCatalogFocGiftSuggestions(picker);
  });
  // Chọn gợi ý: mousedown + preventDefault để ô gõ không mất focus; phát change
  // trên select ẩn → delegation .catalog-foc-input sẵn có lưu + báo toast
  container.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.foc-gift-suggestion-item');
    if (!item) return;
    const picker = item.closest('.foc-gift-picker');
    if (!picker) return;
    e.preventDefault();
    const sel = picker.querySelector('.foc-give-product-input');
    const input = picker.querySelector('.foc-gift-search-input');
    if (!sel) return;
    sel.value = item.getAttribute('data-value');
    if (input) input.value = item.textContent;
    const box = picker.querySelector('.foc-gift-suggestions');
    if (box) box.style.display = 'none';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  container.addEventListener('focusout', (e) => {
    if (!e.target.matches('.foc-gift-search-input')) return;
    const picker = e.target.closest('.foc-gift-picker');
    const related = e.relatedTarget;
    if (picker && related && picker.contains(related)) return;
    setTimeout(() => {
      if (!picker) return;
      if (document.activeElement && picker.contains(document.activeElement)) return;
      const box = picker.querySelector('.foc-gift-suggestions');
      if (box) box.style.display = 'none';
      // Gõ mà không chọn gợi ý → hoàn tên hiển thị về giá trị đã chọn
      _syncCatalogFocGiftDisplay(picker);
    }, 120);
  });
}

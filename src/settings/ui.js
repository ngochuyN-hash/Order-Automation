import { db } from '../../db.js';
import { store } from '../../store.js';
import { debounce } from '../utils.js';
import { applyProductFieldEdit, validateNewProduct, createProductFull, packagingPreviewText } from '../product-edit.js';
import { uiRenderer, showToast, formatNumberWithDots, parseFormattedNumber, formatInputWithDotsAndPreserveCursor } from '../../ui-renderer.js';
import { fuzzySearchScore } from '../../parser.js';
import { aiService } from '../../ai-service.js';
import { workerManager } from '../worker-manager.js';
import { parseOrder, addCustomPromo, onManualSearch, copySummary, clearOrder, loadSampleOrder, autoGrowOrderText, renderCustomPromos, saveCatalogSearchState, restoreCatalogSearchState, saveExpandedCatalogCards, restoreExpandedCatalogCards } from '../order/actions.js';
import { getParseConcurrency, setParseConcurrency } from '../order/parse-queue.js';
import { exportToExcel } from '../order/export.js';
import { openSellerManager, populateSellerDropdown } from '../seller/manager.js';
import { addBrandPrefix, resetPrefixesToDefault, renderPrefixConfigList, renderSequenceResetList } from '../prefix/manager.js';
import { initAiProfileManager } from '../ai/profile-manager.js';
import { confirmDialog } from '../ui/confirm-dialog.js';

// =========================================================================
//  DANH SÁCH SHEET NHÃN HÀNG (Brand Excel)
//  Nguồn dữ liệu duy nhất cho dropdown "Nhãn hàng liên kết" trong form tạo
//  thương hiệu — thay cho các <option> hardcode trong HTML/template string.
//  value = key sheet lowercase dùng khi lưu campaign; label giữ nguyên hiển thị cũ.
// =========================================================================
export const BRAND_SHEETS = [
  { value: 'zentor', label: 'Zentor (6. ZENTOR)' },
  { value: 'torvex',    label: 'Torvex (5. TORVEX)' },
  { value: 'xvil',    label: 'Xvil (2. XVIL)' },
  { value: 'veltra',   label: 'Veltra (1. VELTRA)' },
  { value: 'petrix', label: 'Petrix (3. PETRIX)' },
  { value: 'veltron',  label: 'Veltron (4. VELTRON)' }
];

/**
 * Populate dropdown chọn sheet nhãn hàng từ hằng số BRAND_SHEETS.
 * @param {HTMLSelectElement|null} selectEl - phần tử <select> cần điền (vd #newCampaignBrand)
 * @param {string} [selectedValue=''] - giá trị cần chọn sẵn; rỗng thì chọn hãng đầu tiên
 *   (giữ hành vi cũ: option "zentor" được selected mặc định trong HTML trước đây)
 * @returns {void}
 */
export function populateBrandSheetSelect(selectEl, selectedValue = '') {
  if (!selectEl) return;
  // Placeholder đứng đầu, sau đó là danh sách hãng theo đúng thứ tự hiển thị cũ
  selectEl.innerHTML =
    '<option value="">-- Chọn --</option>' +
    BRAND_SHEETS.map((b) => `<option value="${b.value}">${b.label}</option>`).join('');
  // Chọn sẵn theo tham số, mặc định về hãng đầu tiên để hành vi lưu không đổi
  const defaultValue = selectedValue || BRAND_SHEETS[0].value;
  if (BRAND_SHEETS.some((b) => b.value === defaultValue)) {
    selectEl.value = defaultValue;
  }
}

// --- Helpers cho bộ chọn quà tặng FOC dạng gõ-để-tìm ---

function _escHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _normGiftSearch(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').trim();
}

/** Dựng danh sách gợi ý bên dưới ô gõ tìm sản phẩm tặng (lọc fuzzy theo tên/mã KV) */
function _renderGiftSuggestions(picker) {
  const input = picker.querySelector('.foc-gift-search-input');
  const sel = picker.querySelector('.foc-give-product-input');
  const box = picker.querySelector('.foc-gift-suggestions');
  if (!input || !sel || !box) return;
  const norm = _normGiftSearch(input.value);
  const opts = Array.from(sel.options)
    .filter(o => !norm || (typeof fuzzySearchScore === 'function' ? fuzzySearchScore(norm, _normGiftSearch(o.textContent)) > 0 : _normGiftSearch(o.textContent).includes(norm)))
    .slice(0, 40);
  if (!opts.length) {
    box.innerHTML = '<div class="foc-gift-suggestion-empty">Không tìm thấy sản phẩm khớp</div>';
  } else {
    box.innerHTML = opts.map(o => `<div class="foc-gift-suggestion-item" data-value="${_escHtml(o.value)}">${_escHtml(o.textContent)}</div>`).join('');
  }
  box.style.display = 'block';
}

function _hideAllGiftSuggestions() {
  document.querySelectorAll('.foc-gift-suggestions').forEach(b => { b.style.display = 'none'; });
}

// --- Gợi ý quà tặng MKT (gõ-để-tìm-chọn, cùng pattern bộ chọn quà FOC) ---

/** Phần lõi dùng chung: điền gợi ý quà từ DANH MỤC vào box theo nội dung đang gõ.
 * Dùng chung cho ô quà MKT thương hiệu (.mkt-gift-name) và ô quà MKT theo sản
 * phẩm trong chỉnh sửa sâu (.product-mkt-gift-name). */
function _fillMktGiftSuggestions(input, box, cKey) {
  const norm = _normGiftSearch(input.value);

  const all = db.getAllProducts();
  const isGiftProduct = p => _normGiftSearch(p.spec || '').includes('qua tang');
  const candidates = [];
  const seen = new Set();
  const push = (p, icon, boostBase) => {
    if (seen.has(p.id)) return;
    const label = p.name || '';
    const hint = db.getKvCode(p) || p.kvCode || '';
    // Tìm kiếm tự do: ghép tất cả trường (name + spec + kvCode + packaging + campaignName)
    const searchText = _normGiftSearch(label) + ' ' + _normGiftSearch(p.spec || '') + ' '
      + _normGiftSearch(hint) + ' ' + _normGiftSearch(p.packaging || '')
      + ' ' + _normGiftSearch(p.campaignName || '');
    let score;
    if (!norm) {
      score = boostBase; // không có query → giữ thứ tự ưu tiên (quà cùng CD > quà CD khác > SP thường)
    } else {
      score = fuzzySearchScore(norm, searchText);
      if (score <= 0) return; // không khớp → bỏ qua
      score += boostBase; // cộng thêm boost ưu tiên
    }
    seen.add(p.id);
    // Hiển thị spec/packaging gợi ý nếu có — giúp phân biệt SP trùng tên
    const extraHint = [hint, p.spec, p.packaging].filter(Boolean).join(' · ');
    candidates.push({ label, productId: p.id, hint: extraHint, icon, score,
      otherCampaign: !!(p.campaignKey && p.campaignKey !== cKey) });
  };

  // 1) Sản phẩm quà tặng cùng thương hiệu — ưu tiên cao nhất
  all.filter(p => isGiftProduct(p) && p.campaignKey === cKey).forEach(p => push(p, '🎁', 200));
  // 2) Sản phẩm quà tặng của thương hiệu khác
  all.filter(p => isGiftProduct(p) && p.campaignKey !== cKey).forEach(p => push(p, '🎁', 100));
  // 3) Khi có gõ từ khóa: tìm thêm trong TOÀN BỘ sản phẩm còn lại của danh mục
  if (norm) all.forEach(p => { if (!isGiftProduct(p)) push(p, '📦', 0); });

  // Sắp xếp theo score giảm dần
  candidates.sort((a, b) => b.score - a.score);

  const opts = candidates.slice(0, 40);
  if (!opts.length) {
    box.innerHTML = '<div class="mkt-gift-suggestion-empty">Không thấy sản phẩm nào trong danh mục khớp từ khóa — kiểm tra lại hoặc gõ tên/mã khác</div>';
  } else {
    box.innerHTML = opts.map(o => `<div class="mkt-gift-suggestion-item${o.otherCampaign ? ' mkt-gift-suggestion-other' : ''}" data-value="${_escHtml(o.label)}" data-product-id="${_escHtml(o.productId)}" title="${o.otherCampaign ? 'Sản phẩm thuộc thương hiệu khác' : 'Sản phẩm trong danh mục'}">${o.icon} ${_escHtml(o.label)}${o.hint ? `<span class="mkt-gift-suggestion-hint">${_escHtml(o.hint)}</span>` : ''}</div>`).join('');
  }
  box.style.display = 'block';
}

/** Dựng danh sách gợi ý bên dưới ô gõ quà MKT — NGUỒN = DANH MỤC SẢN PHẨM.
 * Mỗi gợi ý là 1 sản phẩm CỤ THỂ, hiển thị ĐÚNG tên sản phẩm trong danh mục (p.name)
 * để tên quà và tên danh mục luôn đồng nhất — nhìn là biết món nào. */
function _renderMktGiftSuggestions(picker) {
  const input = picker.querySelector('.mkt-gift-name');
  const box = picker.querySelector('.mkt-gift-suggestions');
  if (!input || !box) return;
  const cKey = picker.closest('.mkt-rule-row')?.getAttribute('data-campaign-key') || '';
  _fillMktGiftSuggestions(input, box, cKey);
}

/** Gợi ý quà cho ô gõ quà MKT THEO SẢN PHẨM trong chỉnh sửa sâu (.product-mkt-gift-picker) */
function _renderProductMktGiftSuggestions(picker) {
  const input = picker.querySelector('.product-mkt-gift-name');
  const box = picker.querySelector('.mkt-gift-suggestions');
  if (!input || !box) return;
  const pId = picker.closest('.product-mkt-row')?.getAttribute('data-product-id') || '';
  const host = pId ? db.findProductById(pId) : null;
  _fillMktGiftSuggestions(input, box, (host && host.campaignKey) || '');
}

function _hideMktGiftSuggestions(picker) {
  const box = picker.querySelector('.mkt-gift-suggestions');
  if (box) box.style.display = 'none';
}

// Debounce render gợi ý quà MKT khi GÕ (sự kiện input) — focusin vẫn render ngay.
// Picker truyền qua tham số nên kết quả luôn render đúng picker đang gõ cuối cùng
// (gõ dở ô này rồi nhảy sang ô khác thì chỉ ô gõ sau cùng mới mở danh sách).
const _renderMktGiftSuggestionsDebounced = debounce((picker) => {
  if (!picker || !picker.isConnected) return;
  const input = picker.querySelector('.mkt-gift-name');
  // Đã rời khỏi ô gõ → không mở lại picker nhầm chỗ
  if (!input || document.activeElement !== input) return;
  // Ô đã khóa (vừa chọn gợi ý xong) → KHÔNG mở lại dropdown phía dưới ô readonly
  if (input.readOnly) return;
  _renderMktGiftSuggestions(picker);
}, 120);

// Debounce gợi ý ô quà MKT theo sản phẩm (chỉnh sửa sâu) — cùng nguyên tắc với trên
const _renderProductMktGiftSuggestionsDebounced = debounce((picker) => {
  if (!picker || !picker.isConnected) return;
  const input = picker.querySelector('.product-mkt-gift-name');
  if (!input || document.activeElement !== input) return;
  _renderProductMktGiftSuggestions(picker);
}, 120);

/** Tìm element theo id trong một scope (tránh trùng id giữa tab Settings và modal) */
function _findElInRoot(root, id) {
  const scope = root || document;
  if (scope === document) return document.getElementById(id);
  return scope.querySelector('[id="' + CSS.escape(id) + '"]');
}

/** Đặt tên hiển thị của ô gõ về đúng sản phẩm đang chọn trong select ẩn */
function _syncGiftInputDisplay(picker) {
  const input = picker.querySelector('.foc-gift-search-input');
  const sel = picker.querySelector('.foc-give-product-input');
  if (!input || !sel) return;
  const cur = sel.options[sel.selectedIndex];
  input.value = cur ? cur.textContent : '';
}

/**
 * Xóa bộ lọc tìm kiếm của danh sách sản phẩm (Settings Editor) — dùng trước khi
 * cuộn tới một card cụ thể để chắc chắn card không bị ẩn bởi bộ lọc.
 */
function _clearSettingsProductSearch() {
  const searchInput = document.getElementById('settingsProductSearch');
  if (searchInput && searchInput.value) {
    searchInput.value = '';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

// --- Settings Section & Actions ---

// Settings sub-tab switching
export function switchSettingsSubTab(tabId) {
  // Hide all sub-tab contents
  document.querySelectorAll('.settings-subtab-content').forEach(panel => {
    panel.classList.remove('active');
  });
  // Deactivate all buttons
  document.querySelectorAll('.settings-subtab-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  // Show selected tab
  const activePanel = document.getElementById(`subtab-${tabId}`);
  if (activePanel) activePanel.classList.add('active');
  // Activate button
  const activeBtn = document.querySelector(`.settings-subtab-btn[data-subtab="${tabId}"]`);
  if (activeBtn) activeBtn.classList.add('active');
  
  // Initialize order subtab content when shown
  if (tabId === 'order') {
    renderPrefixConfigList();
    renderSequenceResetList();
  }
}
// Expose for inline onclick handlers
window.switchSettingsSubTab = switchSettingsSubTab;

export function selectSettingsCampaign(campaignKey) {
  store.setState({ selectedSettingsCampaign: campaignKey });
  uiRenderer.renderSettingsSidebar(campaignKey);
  uiRenderer.renderSettingsEditor(campaignKey);
  // ẩn form thêm brand khi đã chọn / tạo brand
  const addCard = document.getElementById('addCampaignCard');
  if (addCard) addCard.style.display = 'none';
}
window.selectSettingsCampaign = selectSettingsCampaign;

window.attachSettingsSidebarListeners = function() {
  const container = document.getElementById('settingsCampaignList');
  if (!container) return;

  // Add campaign button click
  const showAddBtn = document.getElementById('btnShowAddCampaign');
  if (showAddBtn) {
    showAddBtn.onclick = () => {
      document.getElementById('addCampaignCard').style.display = '';
      document.getElementById('addCampaignCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      document.getElementById('newCampaignKey')?.focus();
    };
  }

  // Campaign items click
  container.querySelectorAll('.campaign-list-item[data-campaign-key]').forEach(item => {
    item.onclick = function(e) {
      // If clicking delete button, skip
      if (e.target.classList.contains('delete-campaign-btn')) return;
      const key = this.getAttribute('data-campaign-key');
      selectSettingsCampaign(key);
    };
  });

  // Delete campaign click
  container.querySelectorAll('.delete-campaign-btn').forEach(btn => {
    btn.onclick = async function(e) {
      e.stopPropagation();
      const key = this.getAttribute('data-delete-campaign');
      const campaign = db.data.campaigns[key];
      const name = campaign ? campaign.name : key;
      const pCount = campaign ? (campaign.products || []).length : 0;
      if (await confirmDialog({
        title: '⚠️ Xóa thương hiệu',
        message: `Xóa thương hiệu "${name}" và ${pCount} sản phẩm? Hành động này không thể hoàn tác.`,
        danger: true
      })) {
        db.deleteCampaign(key);
        workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
        selectSettingsCampaign(null);
        showToast(`Đã xóa thương hiệu: ${name}`, 'info');
      }
    };
  });
};

// --- Event Delegation for Product Editor (Phase 3) ---

export function initProductEditorDelegation() {
  const container = document.getElementById('productEditor');
  if (!container) return;
  attachProductEditorDelegation(container);
}

/**
 * Gắn bộ xử lý sự kiện (delegation) cho trình chỉnh sửa sâu sản phẩm lên MỘT root
 * bất kỳ — dùng chung cho tab Settings (#productEditor) và modal mở trực tiếp từ
 * Catalog. Có guard chống gắn trùng khi gọi nhiều lần trên cùng một root.
 */
export function attachProductEditorDelegation(root) {
  const container = root;
  if (!container || container._peDelegationBound) return;
  container._peDelegationBound = true;

  // Click delegation
  container.addEventListener('click', (e) => {
    const target = e.target.closest('button') || e.target;
    const campaignKey = store.getState().selectedSettingsCampaign;

    // Delete product (inline confirmation)
    if (target.matches('.btn-delete-product')) {
      handleDeleteProduct(target, campaignKey, container);
      return;
    }

    // Add tier
    if (target.matches('.btn-add-tier')) {
      const pId = target.getAttribute('data-product-id');
      const p = db.findProductById(pId);
      if (p) {
        p.tiers = p.tiers || [];
        p.tiers.push({ min_qty: 1, max_qty: 9999, price: 0, label: 'Tất cả' });
        db.updateProductTiers(pId, p.tiers);
        uiRenderer.renderTiersForProduct(pId, p.tiers, container);
        showToast('Đã thêm mức giá mới!', 'success');
      }
      return;
    }

    // Remove tier
    if (target.matches('.btn-remove-tier')) {
      const pId = target.getAttribute('data-product-id');
      const idx = parseInt(target.getAttribute('data-tier-idx'));
      const p = db.findProductById(pId);
      if (p && p.tiers) {
        p.tiers.splice(idx, 1);
        db.updateProductTiers(pId, p.tiers);
        uiRenderer.renderTiersForProduct(pId, p.tiers, container);
        showToast('Đã xóa mức giá!', 'info');
      }
      return;
    }

    // Add FOC (Promo v1.3.0: type 'qty' kind 'foc' trong campaign.promoRules)
    if (target.matches('.btn-add-foc')) {
      const pId = target.getAttribute('data-product-id');
      const p = db.findProductById(pId);
      if (p && p.campaignKey && db.data.campaigns[p.campaignKey]) {
        const camp = db.data.campaigns[p.campaignKey];
        camp.promoRules = camp.promoRules || [];
        camp.promoRules.push({
          id: 'promo_' + pId + '_foc_' + Date.now().toString(36),
          type: 'qty', scope: 'product', enabled: true, kind: 'foc',
          productId: pId,
          buy: { qty: 1, unit: 'thùng' },
          gifts: [{ qty: 1, productId: '', unit: '' }],
          label: '', note: ''
        });
        db.save();
        uiRenderer.renderFOCForProduct(pId, null, container);
        showToast('Đã thêm chương trình FOC mới!', 'success');
      }
      return;
    }

    // Remove FOC (Promo v1.3.0)
    if (target.matches('.btn-remove-foc')) {
      const pId = target.getAttribute('data-product-id');
      const idx = parseInt(target.getAttribute('data-foc-idx'));
      const p = db.findProductById(pId);
      if (p && p.campaignKey && db.data.campaigns[p.campaignKey]) {
        const camp = db.data.campaigns[p.campaignKey];
        const focRules = (camp.promoRules || []).filter(r => r && r.type === 'qty' && r.kind === 'foc' && r.productId === pId);
        const targetRule = focRules[idx];
        if (targetRule) {
          camp.promoRules = camp.promoRules.filter(r => r !== targetRule);
          db.save();
          uiRenderer.renderFOCForProduct(pId, null, container);
          showToast('Đã xóa FOC!', 'info');
        }
      }
      return;
    }

    // Cấu hình "tặng 1 trong N quà" cho rule FOC theo sản phẩm
    if (target.matches('.btn-foc-gift-options')) {
      const pId = target.getAttribute('data-product-id');
      const idx = parseInt(target.getAttribute('data-foc-idx'));
      const p = db.findProductById(pId);
      const focRules = p && p.campaignKey ? (db.getPromoRulesForProduct(pId) || []).filter(r => r.type === 'qty' && r.kind === 'foc') : [];
      const rule = focRules[idx];
      if (!p || !rule) return;
      const g0 = (Array.isArray(rule.gifts) && rule.gifts[0]) || {};
      uiRenderer.openGiftOptionsEditor({
        subtitle: `Khuyến mãi FOC — ${p.name}`,
        currentOptions: g0.options || null,
        currentSubOptions: g0.subOptions || null,
        onSaved: (res) => {
          rule.gifts = Array.isArray(rule.gifts) && rule.gifts.length ? rule.gifts : [{ qty: 1, productId: '' }];
          if (res === null) {
            delete rule.gifts[0].options;
            delete rule.gifts[0].subOptions;
          } else {
            rule.gifts[0].options = res.options;
            if (Object.keys(res.subOptions).length > 0) rule.gifts[0].subOptions = res.subOptions;
            else delete rule.gifts[0].subOptions;
            rule.gifts[0].productId = res.options[0];
          }
          db.save();
          workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
          uiRenderer.renderFOCForProduct(pId, null, container);
          showToast(res === null ? 'Đã bỏ cấu hình chọn nhiều quà!' : `Đã lưu: tặng 1 trong ${res.options.length} quà!`, 'success');
        }
      });
      return;
    }

    // Cấu hình "tặng 1 trong N quà" cho từng quà trong mốc MKT thương hiệu
    if (target.matches('.btn-mkt-gift-item-options')) {
      const row = target.closest('.mkt-rule-row[data-campaign-key]');
      const rule = row && _getMktRuleFromRow(row);
      const giftRow = target.closest('.mkt-gift-item-row');
      if (!rule || !giftRow) return;
      const gIdx = parseInt(giftRow.getAttribute('data-gift-idx'));
      rule.gift_items = uiRenderer.normalizeMktGiftItems(rule);
      const giftItem = rule.gift_items[gIdx];
      if (!giftItem) return;
      uiRenderer.openGiftOptionsEditor({
        subtitle: `Quà MKT thương hiệu — ${giftItem.name || 'chưa đặt tên'}`,
        currentOptions: giftItem.give_product_options || null,
        currentSubOptions: giftItem.give_product_sub_options || null,
        onSaved: (res) => {
          if (res === null) {
            delete giftItem.give_product_options;
            delete giftItem.give_product_sub_options;
          } else {
            giftItem.give_product_options = res.options;
            if (Object.keys(res.subOptions).length > 0) giftItem.give_product_sub_options = res.subOptions;
            else delete giftItem.give_product_sub_options;
            // Liên kết quà mặc định = lựa chọn đầu tiên (để lên đơn có sẵn mã KV)
            const first = db.findProductById(res.options[0]);
            if (first) {
              giftItem.product_id = first.id;
              giftItem.name = first.name;
            }
          }
          // [Promo v1.3.0] Ghi NGƯỢC dạng CẤU TRÚC (giữ productId user đã chọn) —
          // KHÔNG hạ cấp thành chuỗi legacy qua buildMktGiftsString
          rule.gifts = uiRenderer.structuredGiftsFromItems(rule.gift_items, rule.gifts);
          db.save();
          uiRenderer.renderMktRulesForCampaign(row.getAttribute('data-campaign-key'), container);
          showToast(res === null ? 'Đã bỏ cấu hình chọn nhiều quà!' : `Đã lưu: tặng 1 trong ${res.options.length} quà!`, 'success');
        }
      });
      return;
    }

    // [+] Thêm nhanh 1 quà thay thế vào nhóm "1 trong N" của rule FOC theo sản phẩm
    if (target.matches('.btn-foc-gift-quickadd')) {
      const pId = target.getAttribute('data-product-id');
      const idx = parseInt(target.getAttribute('data-foc-idx'));
      const p = db.findProductById(pId);
      const focRules = p && p.campaignKey ? (db.getPromoRulesForProduct(pId) || []).filter(r => r.type === 'qty' && r.kind === 'foc') : [];
      const rule = focRules[idx];
      if (!p || !rule) return;
      rule.gifts = Array.isArray(rule.gifts) && rule.gifts.length ? rule.gifts : [{ qty: 1, productId: '' }];
      const g0 = rule.gifts[0];
      const seedId = g0.productId === '__same__' ? p.id : (g0.productId || null);
      // Adapter object để openQuickGiftAdd thao tác options trên g0
      const giftTarget = {
        give_product_options: g0.options || [],
        give_product_sub_options: g0.subOptions || null
      };
      uiRenderer.openQuickGiftAdd(target, giftTarget, {
        seedId,
        onAdded: () => {
          g0.options = giftTarget.give_product_options;
          if (giftTarget.give_product_sub_options) g0.subOptions = giftTarget.give_product_sub_options;
          if (!g0.productId && g0.options.length) g0.productId = g0.options[0];
          db.save();
          workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
          uiRenderer.renderFOCForProduct(pId, null, container);
        }
      });
      return;
    }

    // [+] Thêm nhanh 1 quà thay thế vào nhóm "1 trong N" của từng quà trong mốc MKT thương hiệu
    if (target.matches('.btn-mkt-gift-item-quickadd')) {
      const row = target.closest('.mkt-rule-row[data-campaign-key]');
      const rule = row && _getMktRuleFromRow(row);
      const giftRow = target.closest('.mkt-gift-item-row');
      if (!rule || !giftRow) return;
      const gIdx = parseInt(giftRow.getAttribute('data-gift-idx'));
      rule.gifts = Array.isArray(rule.gifts) ? rule.gifts : [];
      const giftItem = rule.gifts[gIdx];
      if (!giftItem) return;
      const giftTarget = {
        give_product_options: giftItem.options || [],
        give_product_sub_options: giftItem.subOptions || null
      };
      uiRenderer.openQuickGiftAdd(target, giftTarget, {
        seedId: giftItem.productId || null,
        onAdded: () => {
          giftItem.options = giftTarget.give_product_options;
          if (giftTarget.give_product_sub_options) giftItem.subOptions = giftTarget.give_product_sub_options;
          if (!giftItem.productId && giftItem.options.length) {
            const first = db.findProductById(giftItem.options[0]);
            giftItem.productId = giftItem.options[0];
            if (first) giftItem.name = first.name;
          }
          db.save();
          workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
          uiRenderer.renderMktRulesForCampaign(row.getAttribute('data-campaign-key'), container);
        }
      });
      return;
    }

    // Thêm quà MKT THEO SẢN PHẨM trong chỉnh sửa sâu (Promo v1.3.0: kind 'mkt_pp')
    if (target.matches('.btn-add-product-mkt')) {
      const pId = target.getAttribute('data-product-id');
      const p = db.findProductById(pId);
      if (p && p.campaignKey && db.data.campaigns[p.campaignKey]) {
        const camp = db.data.campaigns[p.campaignKey];
        camp.promoRules = camp.promoRules || [];
        camp.promoRules.push({
          id: 'promo_' + pId + '_mkt_pp_' + Date.now().toString(36),
          type: 'qty', scope: 'product', enabled: true, kind: 'mkt_pp',
          productId: pId,
          buy: { qty: 1, unit: 'thùng' },
          gifts: [{ qty: 1, productId: '', unit: 'cái', name: '' }],
          label: '', note: ''
        });
        db.save();
        workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
        uiRenderer.renderMktRulesForProduct(pId, null, container);
        showToast('Đã thêm quà MKT theo sản phẩm!', 'success');
      }
      return;
    }

    // Xóa quà MKT theo sản phẩm trong chỉnh sửa sâu (Promo v1.3.0)
    if (target.matches('.btn-remove-product-mkt')) {
      const pId = target.getAttribute('data-product-id');
      const idx = parseInt(target.getAttribute('data-mkt-idx'));
      const p = db.findProductById(pId);
      if (p && p.campaignKey && db.data.campaigns[p.campaignKey]) {
        const camp = db.data.campaigns[p.campaignKey];
        const mktRules = (camp.promoRules || []).filter(r => r && r.type === 'qty' && r.kind === 'mkt_pp' && r.productId === pId);
        const targetRule = mktRules[idx];
        if (targetRule) {
          camp.promoRules = camp.promoRules.filter(r => r !== targetRule);
          db.save();
          workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
          uiRenderer.renderMktRulesForProduct(pId, null, container);
          showToast('Đã xóa quà MKT!', 'info');
        }
      }
      return;
    }

    // Cấu hình "tặng 1 trong N quà" cho quà MKT theo sản phẩm (chỉnh sửa sâu)
    if (target.matches('.btn-product-mkt-options')) {
      const pId = target.getAttribute('data-product-id');
      const idx = parseInt(target.getAttribute('data-mkt-idx'));
      const p = db.findProductById(pId);
      const mktRules = p && p.campaignKey ? (db.getPromoRulesForProduct(pId) || []).filter(r => r.type === 'qty' && r.kind === 'mkt_pp') : [];
      const rule = mktRules[idx];
      if (!p || !rule) return;
      rule.gifts = Array.isArray(rule.gifts) && rule.gifts.length ? rule.gifts : [{ qty: 1, productId: '', unit: 'cái' }];
      const g0 = rule.gifts[0];
      uiRenderer.openGiftOptionsEditor({
        subtitle: `Quà MKT — ${p.name}`,
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
          db.save();
          workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
          uiRenderer.renderMktRulesForProduct(pId, null, container);
          showToast(res === null ? 'Đã bỏ cấu hình chọn nhiều quà!' : `Đã lưu: tặng 1 trong ${res.options.length} quà!`, 'success');
        }
      });
      return;
    }

    // [+] Thêm nhanh 1 quà thay thế vào nhóm "1 trong N" của quà MKT theo sản phẩm
    if (target.matches('.btn-product-mkt-quickadd')) {
      const pId = target.getAttribute('data-product-id');
      const idx = parseInt(target.getAttribute('data-mkt-idx'));
      const p = db.findProductById(pId);
      const mktRules = p && p.campaignKey ? (db.getPromoRulesForProduct(pId) || []).filter(r => r.type === 'qty' && r.kind === 'mkt_pp') : [];
      const rule = mktRules[idx];
      if (!p || !rule) return;
      rule.gifts = Array.isArray(rule.gifts) && rule.gifts.length ? rule.gifts : [{ qty: 1, productId: '', unit: 'cái' }];
      const g0 = rule.gifts[0];
      const giftTarget = {
        give_product_options: g0.options || [],
        give_product_sub_options: g0.subOptions || null
      };
      uiRenderer.openQuickGiftAdd(target, giftTarget, {
        seedId: g0.productId || null,
        onAdded: () => {
          g0.options = giftTarget.give_product_options;
          if (giftTarget.give_product_sub_options) g0.subOptions = giftTarget.give_product_sub_options;
          if (!g0.productId && g0.options.length) {
            const first = db.findProductById(g0.options[0]);
            g0.productId = g0.options[0];
            if (first) g0.name = first.name;
          }
          db.save();
          workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
          uiRenderer.renderMktRulesForProduct(pId, null, container);
        }
      });
      return;
    }

    // Remove alias
    if (target.matches('.btn-remove-alias')) {
      const alias = target.getAttribute('data-alias');
      const pId = target.getAttribute('data-product-id');
      db.removeAlias(alias);
      workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
      uiRenderer.renderAliasesForProduct(pId, container);
      showToast(`Đã xóa alias: "${alias}"`, 'info');
      return;
    }

    // Show inline alias input
    if (target.matches('.btn-add-alias')) {
      const pId = target.getAttribute('data-product-id');
      const wrapper = container.querySelector(`.alias-input-wrapper[data-product-id="${pId}"]`);
      if (wrapper) {
        wrapper.style.display = 'inline-flex';
        wrapper.querySelector('.alias-inline-input').focus();
      }
      return;
    }

    // Confirm alias
    if (target.matches('.btn-confirm-alias')) {
      const pId = target.getAttribute('data-product-id');
      saveInlineAlias(pId, container);
      return;
    }

    // Cancel alias
    if (target.matches('.btn-cancel-alias')) {
      const pId = target.getAttribute('data-product-id');
      hideAliasInput(pId, container);
      return;
    }

    // Add MKT rule (Promo v1.3.0: type 'total' scope 'campaign' trong promoRules)
    if (target.matches('.btn-add-mkt')) {
      const cKey = target.getAttribute('data-campaign-key');
      const campaign = db.data.campaigns[cKey];
      if (campaign) {
        campaign.promoRules = campaign.promoRules || [];
        campaign.promoRules.push({
          id: 'promo_' + cKey + '_total_' + Date.now().toString(36),
          type: 'total', scope: 'campaign', enabled: true, kind: 'mkt',
          threshold: { min: 0, max: 999999999, basis: 'money' },
          gifts: [],
          label: '', note: ''
        });
        db.save();
        uiRenderer.renderSettingsEditor(cKey);
        showToast('Đã thêm mốc quà MKT mới!', 'success');
      }
      return;
    }

    // Add gift item vào mốc MKT (partial render — chỉ dựng lại vùng mốc quà)
    if (target.matches('.btn-add-mkt-gift')) {
      const row = target.closest('.mkt-rule-row[data-campaign-key]');
      const rule = row && _getMktRuleFromRow(row);
      if (rule) {
        rule.gifts = Array.isArray(rule.gifts) ? rule.gifts : [];
        rule.gifts.push({ qty: 1, productId: '', name: '' });
        db.save();
        uiRenderer.renderMktRulesForCampaign(row.getAttribute('data-campaign-key'), container);
      }
      return;
    }

    // Remove gift item khỏi mốc MKT (partial render — chỉ dựng lại vùng mốc quà)
    if (target.matches('.btn-remove-mkt-gift')) {
      const row = target.closest('.mkt-rule-row[data-campaign-key]');
      const rule = row && _getMktRuleFromRow(row);
      const giftRow = target.closest('.mkt-gift-item-row');
      if (rule && giftRow) {
        const gIdx = parseInt(giftRow.getAttribute('data-gift-idx'));
        if (Array.isArray(rule.gifts)) {
          rule.gifts.splice(gIdx, 1);
          db.save();
          uiRenderer.renderMktRulesForCampaign(row.getAttribute('data-campaign-key'), container);
        }
      }
      return;
    }

    // Hủy liên kết quà MKT ↔ sản phẩm danh mục: xóa productId, mở lại ô tên để chọn món khác
    if (target.matches('.btn-unlink-mkt-gift')) {
      const row = target.closest('.mkt-rule-row[data-campaign-key]');
      const rule = row && _getMktRuleFromRow(row);
      const giftRow = target.closest('.mkt-gift-item-row');
      if (rule && giftRow) {
        const gIdx = parseInt(giftRow.getAttribute('data-gift-idx'));
        if (Array.isArray(rule.gifts) && rule.gifts[gIdx]) {
          rule.gifts[gIdx].productId = '';
          db.save();
        }
        // Cập nhật DOM tại chỗ: bỏ readonly, focus lại ô gõ, badge ⚠, ẩn nút hủy
        const input = giftRow.querySelector('.mkt-gift-name');
        if (input) { input.readOnly = false; input.focus(); }
        target.style.display = 'none';
        _updateMktGiftBadge(giftRow, rule.gifts && rule.gifts[gIdx]);
        showToast('Đã hủy liên kết sản phẩm — chọn món khác từ danh sách', 'info');
      }
      return;
    }

    // Remove MKT rule (Promo v1.3.0: type 'total' scope 'campaign')
    if (target.matches('.btn-remove-mkt')) {
      const cKey = target.getAttribute('data-campaign-key');
      const idx = parseInt(target.getAttribute('data-rule-idx'));
      const campaign = db.data.campaigns[cKey];
      if (campaign && Array.isArray(campaign.promoRules)) {
        const totalRules = campaign.promoRules.filter(r => r && r.type === 'total' && r.scope === 'campaign');
        const targetRule = totalRules[idx];
        if (targetRule) {
          campaign.promoRules = campaign.promoRules.filter(r => r !== targetRule);
          db.save();
          uiRenderer.renderSettingsEditor(cKey);
          showToast('Đã xóa mốc quà MKT!', 'info');
        }
      }
      return;
    }

    // Show Add Product Form Button
    if (target.matches('#btnShowAddProductForm') || target.id === 'btnShowAddProductForm') {
      showAddProductModal();
      return;
    }

    // Nhảy tới package anh em (chip "Quy cách khác" — hiển thị mã KV package)
    if (target.matches && target.matches('.btn-goto-package')) {
      const pId = target.getAttribute('data-product-id');
      const prodCard = _findElInRoot(container, `product-card-${pId}`);
      if (!prodCard) { showToast('Package này không thuộc thương hiệu đang mở!', 'warning'); return; }
      _clearSettingsProductSearch(); // card có thể đang bị ẩn bởi bộ lọc tìm kiếm
      prodCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      prodCard.style.outline = '2px solid var(--accent-blue)';
      setTimeout(() => { prodCard.style.outline = ''; }, 2500);
      return;
    }
  });

  // --- Kéo thả đổi vị trí rule khuyến mãi (mkt/total, text, foc, mkt_pp) ---
  // Row .promo-rule-draggable khai draggable="true"; drop chỉ hợp lệ trong CÙNG
  // danh sách (.promo-rule-list); di chuyển rule trong campaign.promoRules bằng
  // splice trên vị trí thật (indexOf) — đúng cả khi các type xen kẽ trong mảng.
  const PROMO_ROW_KINDS = [
    { cls: 'mkt-rule-row', idxAttr: 'data-rule-idx', kind: 'mkt' },
    { cls: 'product-mkt-row', idxAttr: 'data-mkt-idx', kind: 'mkt-pp' },
    { cls: 'foc-row', idxAttr: 'data-foc-idx', kind: 'foc' }
  ];
  const _promoKind = (row) => (row && PROMO_ROW_KINDS.find(k => row.classList.contains(k.cls))) || null;
  const _promoCampaignKey = (row) => {
    const ck = row.getAttribute('data-campaign-key');
    if (ck) return ck;
    const pId = row.getAttribute('data-product-id');
    const p = pId && db.findProductById(pId);
    return p ? p.campaignKey : null;
  };
  const _promoRulesOf = (camp, row) => {
    const kind = _promoKind(row);
    if (!kind || !camp || !Array.isArray(camp.promoRules)) return null;
    const all = camp.promoRules;
    if (kind.kind === 'mkt') return all.filter(r => r && r.type === 'total' && r.scope === 'campaign');
    const pId = row.getAttribute('data-product-id');
    return all.filter(r => r && r.type === 'qty' && r.kind === (kind.kind === 'foc' ? 'foc' : 'mkt_pp') && r.productId === pId);
  };

  let promoDragSource = null; // { row } — idx, kind đọc lại từ row TẠI drop (row chưa bị detach)
  const clearPromoDragState = () => {
    promoDragSource = null;
    container.querySelectorAll('.promo-rule-draggable').forEach(r => r.classList.remove('dragging', 'drag-over'));
    document.body.classList.remove('is-dragging');
  };

  container.addEventListener('dragstart', (e) => {
    const row = e.target.closest ? e.target.closest('.promo-rule-draggable') : null;
    if (!row || !container.contains(row)) return;
    // Row dày ô nhập/select/nút — chỉ kéo từ drag-handle hoặc vùng không tương tác
    if (e.target.closest('input, button, select, textarea')) { e.preventDefault(); return; }
    if (!row.closest('.promo-rule-list')) { e.preventDefault(); return; }
    promoDragSource = { row };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', 'promo-rule-reorder');
    // Delay add class để browser chụp được hình row trước khi mờ
    requestAnimationFrame(() => row.classList.add('dragging'));
    document.body.classList.add('is-dragging');
  });

  container.addEventListener('dragover', (e) => {
    const row = e.target.closest ? e.target.closest('.promo-rule-draggable') : null;
    if (!promoDragSource || !row || !container.contains(row)) return;
    if (row.closest('.promo-rule-list') !== promoDragSource.row.closest('.promo-rule-list')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!row.classList.contains('drag-over')) row.classList.add('drag-over');
  });

  container.addEventListener('dragenter', (e) => {
    const row = e.target.closest ? e.target.closest('.promo-rule-draggable') : null;
    if (!promoDragSource || !row || !container.contains(row)) return;
    if (row.closest('.promo-rule-list') !== promoDragSource.row.closest('.promo-rule-list')) return;
    e.preventDefault();
    row.classList.add('drag-over');
  });

  container.addEventListener('dragleave', (e) => {
    const row = e.target.closest ? e.target.closest('.promo-rule-draggable') : null;
    if (!row || !container.contains(row)) return;
    // Chỉ gỡ highlight khi thực sự rời row (không phải đi vào phần tử con)
    if (!row.contains(e.relatedTarget)) row.classList.remove('drag-over');
  });

  container.addEventListener('drop', (e) => {
    if (!promoDragSource) return; // chỉ nhận drag nội bộ của settings editor
    const row = e.target.closest ? e.target.closest('.promo-rule-draggable') : null;
    if (!row || !container.contains(row)) return;
    if (row.closest('.promo-rule-list') !== promoDragSource.row.closest('.promo-rule-list')) return;
    e.preventDefault();
    e.stopPropagation();
    row.classList.remove('drag-over');

    const fromRow = promoDragSource.row;
    const fromKind = _promoKind(fromRow);
    const toKind = _promoKind(row);
    if (fromKind && toKind && fromKind.kind === toKind.kind) {
      const fromIdx = parseInt(fromRow.getAttribute(fromKind.idxAttr));
      const toIdx = parseInt(row.getAttribute(toKind.idxAttr));
      if (fromIdx !== toIdx && !isNaN(fromIdx) && !isNaN(toIdx)) {
        const cKey = _promoCampaignKey(row);
        const camp = cKey && db.data.campaigns[cKey];
        const rules = camp && _promoRulesOf(camp, row);
        if (rules && rules[fromIdx] && rules[toIdx]) {
          const a = camp.promoRules.indexOf(rules[fromIdx]);
          const b = camp.promoRules.indexOf(rules[toIdx]);
          if (a >= 0 && b >= 0 && a !== b) {
            camp.promoRules.splice(b, 0, ...camp.promoRules.splice(a, 1));
            db.save();
            if (toKind.kind === 'mkt') uiRenderer.renderSettingsEditor(cKey);
            else if (toKind.kind === 'foc') uiRenderer.renderFOCForProduct(row.getAttribute('data-product-id'), null, container);
            else uiRenderer.renderMktRulesForProduct(row.getAttribute('data-product-id'), null, container);
            showToast('Đã đổi vị trí!', 'success');
          }
        }
      }
    }
    // Dọn state NGAY tại drop: re-render detach row nguồn → dragend không bubble
    // tới container (bài học bug is-dragging kẹt — xem ui-renderer.js bảng đơn)
    clearPromoDragState();
  });

  container.addEventListener('dragend', () => clearPromoDragState());

  // Chọn gợi ý sản phẩm tặng (mousedown + preventDefault để ô gõ không mất focus trước khi áp lựa chọn)
  container.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.foc-gift-suggestion-item');
    if (!item) return;
    e.preventDefault();
    const picker = item.closest('.foc-gift-picker');
    const sel = picker && picker.querySelector('.foc-give-product-input');
    const input = picker && picker.querySelector('.foc-gift-search-input');
    if (!sel) return;
    sel.value = item.getAttribute('data-value');
    if (input) input.value = item.textContent;
    const box = picker.querySelector('.foc-gift-suggestions');
    if (box) box.style.display = 'none';
    // Phát change trên select ẩn để luồng lưu FOC sẵn có chạy nguyên vẹn
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });

  // Chọn gợi ý quà MKT: ghi liên kết (product_id) TRỰC TIẾP vào dữ liệu + lưu ngay,
  // rồi cập nhật UI tại chỗ (ô tên readonly, badge ✓, nút Hủy liên kết) — không qua trung gian DOM
  container.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.mkt-gift-suggestion-item');
    if (!item) return;
    // Hủy render gợi ý đang chờ của debounce — tránh timer nổ SAU khi đã chọn,
    // bật mở lại dropdown (dưới ô đã readonly) với danh sách item stale
    _renderMktGiftSuggestionsDebounced.cancel();
    e.preventDefault();
    const picker = item.closest('.mkt-gift-picker');
    const input = picker && picker.querySelector('.mkt-gift-name');
    if (!input) return;
    const giftRow = picker.closest('.mkt-gift-item-row');
    const ruleRow = picker.closest('.mkt-rule-row[data-campaign-key]');
    const rule = ruleRow && _getMktRuleFromRow(ruleRow);
    if (!rule || !giftRow) return;
    const gIdx = parseInt(giftRow.getAttribute('data-gift-idx'));
    const pid = item.getAttribute('data-product-id') || '';
    const label = item.getAttribute('data-value') || '';
    rule.gifts = Array.isArray(rule.gifts) ? rule.gifts : [];
    if (!rule.gifts[gIdx]) rule.gifts[gIdx] = { qty: 1, productId: '', name: '' };
    rule.gifts[gIdx].name = label;
    rule.gifts[gIdx].productId = pid;
    db.save();
    // Cập nhật DOM tại chỗ — không re-render toàn vùng để giữ giá trị đang gõ ở các ô khác
    input.value = label;
    input.readOnly = true;
    _updateMktGiftBadge(giftRow, rule.gifts[gIdx]);
    let unlinkBtn = giftRow.querySelector('.btn-unlink-mkt-gift');
    if (!unlinkBtn) {
      unlinkBtn = document.createElement('button');
      unlinkBtn.className = 'btn btn-ghost btn-xs btn-unlink-mkt-gift';
      unlinkBtn.title = 'Hủy liên kết sản phẩm này — ô tên sẽ mở lại để chọn món khác';
      unlinkBtn.textContent = '⛓ Hủy liên kết';
      const removeBtn = giftRow.querySelector('.btn-remove-mkt-gift');
      if (removeBtn) removeBtn.before(unlinkBtn); else giftRow.appendChild(unlinkBtn);
    }
    unlinkBtn.style.display = '';
    _hideMktGiftSuggestions(picker);
    showToast('Đã liên kết quà với sản phẩm trong danh mục!', 'success');
  });

  // Chọn gợi ý quà MKT THEO SẢN PHẨM (chỉnh sửa sâu): ghi give_product/give_product_name
  // vào rule + lưu ngay + partial re-render vùng quà MKT của card
  container.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.mkt-gift-suggestion-item');
    if (!item) return;
    const picker = item.closest('.product-mkt-gift-picker');
    if (!picker) return; // gợi ý quà MKT thương hiệu — handler trên đã xử lý
    _renderProductMktGiftSuggestionsDebounced.cancel();
    e.preventDefault();
    const input = picker.querySelector('.product-mkt-gift-name');
    const row = picker.closest('.product-mkt-row[data-product-id]');
    if (!input || !row) return;
    const pId = row.getAttribute('data-product-id');
    const idx = parseInt(row.getAttribute('data-mkt-idx'));
    const p = db.findProductById(pId);
    const rule = (p && p.mkt_gift_rules) ? p.mkt_gift_rules[idx] : null;
    if (!rule) return;
    const pid = item.getAttribute('data-product-id') || '';
    const label = item.getAttribute('data-value') || '';
    if (!pid) return;
    rule.give_product = pid;
    rule.give_product_name = label;
    db.save();
    workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
    _hideMktGiftSuggestions(picker);
    uiRenderer.renderMktRulesForProduct(pId, p.mkt_gift_rules, container);
    showToast(`Đã liên kết quà MKT: ${label}`, 'success');
  });

  // Focus/blur ô gõ tìm sản phẩm tặng
  container.addEventListener('focusin', (e) => {
    if (e.target.matches('.foc-gift-search-input')) {
      const picker = e.target.closest('.foc-gift-picker');
      if (picker) _renderGiftSuggestions(picker);
      return;
    }
    if (e.target.matches('.mkt-gift-name')) {
      if (e.target.readOnly) return; // quà đã liên kết (ô khóa) — không cần mở danh sách tìm
      const picker = e.target.closest('.mkt-gift-picker');
      if (picker) _renderMktGiftSuggestions(picker);
    }
    if (e.target.matches('.product-mkt-gift-name')) {
      const picker = e.target.closest('.product-mkt-gift-picker');
      if (picker) _renderProductMktGiftSuggestions(picker);
    }
  });
  container.addEventListener('focusout', (e) => {
    if (e.target.matches('.foc-gift-search-input')) {
      const picker = e.target.closest('.foc-gift-picker');
      const related = e.relatedTarget;
      if (picker && related && picker.contains(related)) return;
      setTimeout(() => {
        if (!picker) return;
        if (document.activeElement && picker.contains(document.activeElement)) return;
        const box = picker.querySelector('.foc-gift-suggestions');
        if (box) box.style.display = 'none';
        // Gõ mà không chọn gợi ý → hoàn tên hiển thị về giá trị đã chọn
        _syncGiftInputDisplay(picker);
      }, 120);
      return;
    }
    if (e.target.matches('.mkt-gift-name')) {
      const picker = e.target.closest('.mkt-gift-picker');
      const related = e.relatedTarget;
      if (picker && related && picker.contains(related)) return;
      setTimeout(() => {
        if (!picker) return;
        if (document.activeElement && picker.contains(document.activeElement)) return;
        _hideMktGiftSuggestions(picker);
        // Gõ mà KHÔNG chọn gợi ý → hoàn tên hiển thị về tên ĐÃ LƯU trong dữ liệu
        // (cùng nguyên tắc bộ chọn quà FOC) và KHÔNG tự gắn product_id
        const input = picker.querySelector('.mkt-gift-name');
        const giftRow = picker.closest('.mkt-gift-item-row');
        const ruleRow = picker.closest('.mkt-rule-row[data-campaign-key]');
        const rule = ruleRow && _getMktRuleFromRow(ruleRow);
        if (input && rule && giftRow) {
          const gIdx = parseInt(giftRow.getAttribute('data-gift-idx'));
          const items = uiRenderer.normalizeMktGiftItems(rule);
          input.value = (items[gIdx] && items[gIdx].name) || '';
        }
      }, 120);
    }
    if (e.target.matches('.product-mkt-gift-name')) {
      const picker = e.target.closest('.product-mkt-gift-picker');
      const related = e.relatedTarget;
      if (picker && related && picker.contains(related)) return;
      setTimeout(() => {
        if (!picker) return;
        if (document.activeElement && picker.contains(document.activeElement)) return;
        _hideMktGiftSuggestions(picker);
        // Gõ mà KHÔNG chọn gợi ý → hoàn hiển thị về giá trị ĐÃ LƯU
        const input = picker.querySelector('.product-mkt-gift-name');
        const row = picker.closest('.product-mkt-row[data-product-id]');
        if (!input || !row) return;
        const p = db.findProductById(row.getAttribute('data-product-id'));
        const rule = (p && p.mkt_gift_rules) ? p.mkt_gift_rules[parseInt(row.getAttribute('data-mkt-idx'))] : null;
        if (!rule) return;
        const linked = rule.give_product ? db.findProductById(rule.give_product) : null;
        input.value = linked ? linked.name : (rule.give_product_name || rule.give_product || '');
      }, 120);
    }
  });

  // Input delegation: live comma formatting for tier price inputs
  container.addEventListener('input', (e) => {
    if (e.target.matches('.tier-price-input')) {
      formatInputWithDotsAndPreserveCursor(e.target);
    }
    // Gõ tìm sản phẩm tặng trong luật FOC
    if (e.target.matches('.foc-gift-search-input')) {
      const picker = e.target.closest('.foc-gift-picker');
      if (picker) _renderGiftSuggestions(picker);
    }
    // Gõ tìm quà tặng trong mốc MKT — gợi ý render qua debounce cho đỡ giật khi gõ liên tục
    if (e.target.matches('.mkt-gift-name')) {
      const picker = e.target.closest('.mkt-gift-picker');
      if (picker && !e.target.readOnly) _renderMktGiftSuggestionsDebounced(picker);
    }
    // Gõ tìm quà MKT THEO SẢN PHẨM trong chỉnh sửa sâu
    if (e.target.matches('.product-mkt-gift-name')) {
      const picker = e.target.closest('.product-mkt-gift-picker');
      if (picker) _renderProductMktGiftSuggestionsDebounced(picker);
    }
  });

  // Change delegation for inputs
  container.addEventListener('change', (e) => {
    const target = e.target;
    const campaignKey = store.getState().selectedSettingsCampaign;

    // Product field inputs — dùng chung applyProductFieldEdit với Catalog để
    // validation + lưu trữ + ghi log KHÔNG BAO GIỜ phân kỳ giữa 2 tab.
    if (target.matches('.product-field-input[data-product-id]')) {
      const pId = target.getAttribute('data-product-id');
      const field = target.getAttribute('data-field');
      const result = applyProductFieldEdit(pId, field, target.value);

      if (!result.ok) {
        target.classList.add('input-error');
        if (result.revertValue !== undefined) target.value = result.revertValue;
        showToast(result.message || 'Không lưu được thay đổi!', 'error');
        return;
      }
      target.classList.remove('input-error');

      // KV thùng: xóa override (rỗng) → hiển thị lại mã tự phân
      if (field === 'kvCodeThung') {
        target.value = result.value || result.autoValue || '';
        flashSuccess(target);
        showToast(result.value
          ? `Đã ghi đè mã KV thùng: ${result.value}`
          : 'Đã xóa ghi đè — mã thùng quay về tự động (mã gốc + \'-1\')', 'success');
        return;
      }

      if (field === 'kvCode') {
        flashSuccess(target);
        showToast(result.value ? `Đã cập nhật mã KV: ${result.value}` : 'Đã xóa mã KV', 'success');
        return;
      }

      if (field === 'box_size') {
        // Cập nhật badge ×N trong label Đóng gói (cùng card)
        const badge = target.closest('.product-item-card')?.querySelector('.packing-multiplier-badge');
        if (badge) badge.textContent = `×${result.value}`;
        target.value = result.value; // hiển thị giá trị ĐÃ CHUẨN HÓA
      }

      flashSuccess(target);
      showToast(`Đã cập nhật sản phẩm!${field === 'box_size' ? ` Nhân thùng: ×${result.value}.` : ''}`, 'success');
      return;
    }

    // Tier inputs
    const tierRow = target.closest('.tier-row[data-product-id]');
    if (tierRow) {
      const pId = tierRow.getAttribute('data-product-id');
      const idx = parseInt(tierRow.getAttribute('data-tier-idx'));
      const p = db.findProductById(pId);
      if (!p || !p.tiers || !p.tiers[idx]) return;

      const t = p.tiers[idx];
      t.label = tierRow.querySelector('.tier-label-input').value;
      t.min_qty = parseInt(tierRow.querySelector('.tier-min-input').value) || 0;
      t.max_qty = parseInt(tierRow.querySelector('.tier-max-input').value) || 9999;
      t.price = parseFormattedNumber(tierRow.querySelector('.tier-price-input').value);

      // Validation
      if (t.min_qty > t.max_qty) {
        tierRow.querySelector('.tier-min-input').classList.add('input-error');
        showToast('Số lượng tối thiểu không được lớn hơn tối đa!', 'error');
        return;
      }
      if (t.price < 0) {
        tierRow.querySelector('.tier-price-input').classList.add('input-error');
        showToast('Giá không được âm!', 'error');
        return;
      }
      tierRow.querySelectorAll('input').forEach(i => i.classList.remove('input-error'));

      db.updateProductTiers(pId, p.tiers);
      flashSuccess(target);
      showToast('Đã cập nhật mức giá!', 'success');
      return;
    }

    // Inputs quà MKT THEO SẢN PHẨM trong chỉnh sửa sâu (.product-mkt-row)
    const productMktRow = target.matches('.product-mkt-input') ? target.closest('.product-mkt-row[data-product-id]') : null;
    if (productMktRow) {
      const pId = productMktRow.getAttribute('data-product-id');
      const idx = parseInt(productMktRow.getAttribute('data-mkt-idx'));
      const p = db.findProductById(pId);
      const mktRules = p && p.campaignKey ? (db.getPromoRulesForProduct(pId) || []).filter(r => r.type === 'qty' && r.kind === 'mkt_pp') : [];
      const rule = mktRules[idx];
      if (!rule) return;
      rule.gifts = Array.isArray(rule.gifts) && rule.gifts.length ? rule.gifts : [{ qty: 1, productId: '', unit: 'cái' }];
      rule.buy = rule.buy || { qty: 1, unit: 'thùng' };
      const field = target.getAttribute('data-field');
      if (field === 'buy_qty') rule.buy.qty = parseInt(target.value) || 1;
      else if (field === 'buy_unit') rule.buy.unit = target.value;
      else if (field === 'give_qty') rule.gifts[0].qty = parseInt(target.value) || 1;
      else if (field === 'give_unit') rule.gifts[0].unit = target.value;
      else if (field === 'note') rule.note = target.value;
      db.save();
      workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
      flashSuccess(target);
      showToast('Đã cập nhật quà MKT!', 'success');
      return;
    }

    // Ô gõ quà MKT theo sản phẩm: gõ tay không chọn gợi ý → lưu tên tự do
    // và XÓA productId — cùng nguyên tắc picker Catalog
    if (target.matches('.product-mkt-gift-name')) {
      const row = target.closest('.product-mkt-row[data-product-id]');
      if (!row) return;
      const pId = row.getAttribute('data-product-id');
      const idx = parseInt(row.getAttribute('data-mkt-idx'));
      const p = db.findProductById(pId);
      const mktRules = p && p.campaignKey ? (db.getPromoRulesForProduct(pId) || []).filter(r => r.type === 'qty' && r.kind === 'mkt_pp') : [];
      const rule = mktRules[idx];
      if (!rule) return;
      rule.gifts = Array.isArray(rule.gifts) && rule.gifts.length ? rule.gifts : [{ qty: 1, productId: '', unit: 'cái' }];
      const typed = (target.value || '').trim();
      const linked = rule.gifts[0].productId ? db.findProductById(rule.gifts[0].productId) : null;
      if (linked && _normGiftSearch(typed) === _normGiftSearch(linked.name)) return;
      rule.gifts[0].name = typed;
      rule.gifts[0].productId = '';
      db.save();
      workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
      uiRenderer.renderMktRulesForProduct(pId, null, container);
      showToast('Đã lưu tên quà MKT (chưa liên kết danh mục)', 'success');
      return;
    }

    // FOC inputs
    const focRow = target.closest('.foc-row[data-product-id]');
    if (focRow) {
      const pId = focRow.getAttribute('data-product-id');
      const idx = parseInt(focRow.getAttribute('data-foc-idx'));
      const p = db.findProductById(pId);
      const focRules = p && p.campaignKey ? (db.getPromoRulesForProduct(pId) || []).filter(r => r.type === 'qty' && r.kind === 'foc') : [];
      const f = focRules[idx];
      if (!p || !f) return;
      f.gifts = Array.isArray(f.gifts) && f.gifts.length ? f.gifts : [{ qty: 1, productId: '' }];
      f.buy = f.buy || { qty: 1, unit: 'thùng' };
      f.buy.qty = parseInt(focRow.querySelector('.foc-buy-input').value) || 1;
      f.buy.unit = focRow.querySelector('.foc-buyunit-input') ? focRow.querySelector('.foc-buyunit-input').value : 'thùng';
      f.gifts[0].qty = parseInt(focRow.querySelector('.foc-give-input').value) || 1;
      f.gifts[0].unit = focRow.querySelector('.foc-unit-input').value;
      const newGiveProduct = focRow.querySelector('.foc-give-product-input')?.value;
      if (newGiveProduct !== undefined && newGiveProduct !== null) {
        f.gifts[0].productId = newGiveProduct;
      }
      f.note = focRow.querySelector('.foc-note-input')?.value || f.note || '';

      // Validation
      if (f.buy.qty <= 0) {
        focRow.querySelector('.foc-buy-input').classList.add('input-error');
        showToast('Số lượng mua phải lớn hơn 0!', 'error');
        return;
      }
      if (f.gifts[0].qty <= 0) {
        focRow.querySelector('.foc-give-input').classList.add('input-error');
        showToast('Số lượng tặng phải lớn hơn 0!', 'error');
        return;
      }
      focRow.querySelectorAll('input').forEach(i => i.classList.remove('input-error'));

      db.save();
      flashSuccess(target);
      showToast('Đã cập nhật FOC!', 'success');
      return;
    }

    // Campaign settings inputs
    if (target.id === 'editCampaignName') {
      const val = target.value.trim();
      if (!val) {
        target.classList.add('input-error');
        showToast('Tên thương hiệu không được để trống!', 'error');
        return;
      }
      target.classList.remove('input-error');
      db.updateCampaign(campaignKey, { name: val });
      uiRenderer.renderSettingsSidebar(campaignKey);
      flashSuccess(target);
      showToast('Đã lưu tên thương hiệu!', 'success');
      return;
    }
    if (target.id === 'editCampaignIcon') {
      db.updateCampaign(campaignKey, { icon: target.value.trim() });
      uiRenderer.renderSettingsSidebar(campaignKey);
      flashSuccess(target);
      showToast('Đã lưu icon thương hiệu!', 'success');
      return;
    }
    if (target.id === 'editCampaignColor') {
      db.updateCampaign(campaignKey, { color: target.value.trim() });
      uiRenderer.renderSettingsSidebar(campaignKey);
      flashSuccess(target);
      showToast('Đã lưu màu thương hiệu!', 'success');
      return;
    }
    if (target.id === 'editCampaignBrand') {
      db.updateCampaign(campaignKey, { brand: target.value });
      workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
      flashSuccess(target);
      showToast('Đã lưu nhãn hàng liên kết!', 'success');
      return;
    }

    // MKT rule inputs (Promo v1.3.0: type 'total' scope 'campaign')
    const mktRow = target.closest('.mkt-rule-row[data-campaign-key]');
    if (mktRow) {
      const cKey = mktRow.getAttribute('data-campaign-key');
      const idx = parseInt(mktRow.getAttribute('data-rule-idx'));
      const campaign = db.data.campaigns[cKey];
      if (!campaign || !Array.isArray(campaign.promoRules)) return;
      const totalRules = campaign.promoRules.filter(r => r && r.type === 'total' && r.scope === 'campaign');
      const r = totalRules[idx];
      if (!r) return;

      // [Promo v1.3.0] Gifts có thể bị hạ cấp thành chuỗi legacy (từ luồng cũ) —
      // dựng lại CẤU TRÚC trước khi sửa để thay đổi user (SL/tên) đi đúng đường
      // và không làm mất liên kết productId
      r.gifts = Array.isArray(r.gifts)
        ? r.gifts
        : uiRenderer.structuredGiftsFromItems(uiRenderer.normalizeMktGiftItems(r), null);

      // Ô số lượng / tên quà trong danh sách quà cấu trúc
      const giftRow = target.closest('.mkt-gift-item-row');
      if (giftRow) {
        const gIdx = parseInt(giftRow.getAttribute('data-gift-idx'));
        if (r.gifts[gIdx]) {
          if (target.matches('.mkt-gift-qty')) {
            r.gifts[gIdx].qty = parseInt(target.value) || 1;
            target.value = r.gifts[gIdx].qty;
          } else if (target.matches('.mkt-gift-name')) {
            const typed = (target.value || '').trim();
            const giftItem = r.gifts[gIdx];
            if (!giftItem.productId && typed) {
              giftItem.name = typed;
              target.value = typed;
            } else {
              target.value = giftItem.name || '';
            }
          }
        }
      }

      r.threshold = r.threshold || { min: 0, max: 0, basis: 'money' };
      r.threshold.min = parseInt(mktRow.querySelector('.mkt-min-input').value) || 0;
      r.threshold.max = parseInt(mktRow.querySelector('.mkt-max-input').value) || 999999999;
      r.threshold.basis = mktRow.querySelector('.mkt-unit-select').value === 'boxes' ? 'boxes' : 'money';
      r.label = mktRow.querySelector('.mkt-label-input').value;

      // Cập nhật ngay huy hiệu liên kết của dòng quà vừa sửa
      if (giftRow) {
        const gIdx = parseInt(giftRow.getAttribute('data-gift-idx'));
        _updateMktGiftBadge(giftRow, r.gifts[gIdx]);
      }

      db.save();
      flashSuccess(target);
      showToast('Đã cập nhật mốc quà MKT!', 'success');
      return;
    }
  });

  // Keydown delegation for inline alias input
  container.addEventListener('keydown', (e) => {
    if (e.target.matches('.alias-inline-input')) {
      const pId = e.target.getAttribute('data-product-id');
      if (e.key === 'Enter') {
        e.preventDefault();
        saveInlineAlias(pId, container);
      } else if (e.key === 'Escape') {
        hideAliasInput(pId, container);
      }
    }
  });
}

// Helper: lấy rule MKT (total scope campaign) từ DOM row (.mkt-rule-row có data-campaign-key + data-rule-idx)
function _getMktRuleFromRow(row) {
  if (!row) return null;
  const cKey = row.getAttribute('data-campaign-key');
  const idx = parseInt(row.getAttribute('data-rule-idx'));
  const campaign = db.data.campaigns[cKey];
  if (!campaign || !Array.isArray(campaign.promoRules)) return null;
  const totalRules = campaign.promoRules.filter(r => r && r.type === 'total' && r.scope === 'campaign');
  return totalRules[idx] || null;
}

// Helper: cập nhật huy hiệu liên kết ✓/⚠ TRỰC TIẾP trên dòng quà — theo product_id trong dữ liệu
function _updateMktGiftBadge(giftRow, item) {
  const badge = giftRow && giftRow.querySelector('.mkt-gift-link-badge');
  if (!badge || !item) return;
  // [Promo v1.3.0] Rule cấu trúc lưu `productId` (không phải `product_id`) — đọc CẢ HAI
  // để badge không báo ⚠ oan ngay sau khi user chọn quà / đổi số lượng
  const pid = item.productId || item.product_id || '';
  const linked = pid ? db.getAllProducts().find(p => p.id === pid) : null;
  if (linked) {
    const code = db.getKvCode(linked) || linked.kvCode || '';
    badge.className = 'mkt-gift-link-badge mkt-gift-linked';
    badge.textContent = '✓' + (code ? ' ' + code : '');
    badge.title = 'Đã liên kết sản phẩm trong danh mục: ' + linked.name;
  } else {
    badge.className = 'mkt-gift-link-badge mkt-gift-unlinked';
    badge.textContent = '⚠ Chưa liên kết';
    badge.title = 'Chưa gắn với sản phẩm nào trong danh mục — bấm vào ô tên và chọn 1 sản phẩm cụ thể từ danh sách';
  }
}

// Helper: save alias from inline input
function saveInlineAlias(productId, container) {
  const wrapper = container.querySelector(`.alias-input-wrapper[data-product-id="${productId}"]`);
  if (!wrapper) return;
  const input = wrapper.querySelector('.alias-inline-input');
  const alias = input.value.trim();
  if (alias) {
    db.addAlias(alias, productId);
    workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
    uiRenderer.renderAliasesForProduct(productId, container);
    showToast(`Đã thêm alias: "${alias}"`, 'success');
  }
  hideAliasInput(productId, container);
}

// Helper: hide inline alias input
function hideAliasInput(productId, container) {
  const wrapper = container.querySelector(`.alias-input-wrapper[data-product-id="${productId}"]`);
  if (wrapper) {
    wrapper.style.display = 'none';
    wrapper.querySelector('.alias-inline-input').value = '';
  }
}

// Helper: flash success on input
function flashSuccess(input) {
  input.classList.add('input-success');
  setTimeout(() => input.classList.remove('input-success'), 1500);
}

// --- LUỒNG MỚI: Mở chỉnh sửa sâu NGAY trong Danh mục (modal) ---
// Bấm ⚙️ trên card Catalog → mở modal chứa toàn bộ trình chỉnh sửa sâu của đúng
// sản phẩm đó (Giá / FOC / Aliases / Quy cách...). KHÔNG chuyển sang tab Settings,
// không cuộn tìm card — giao diện xuất hiện tức thì, dữ liệu lưu trực tiếp như cũ.

export function openProductEditorModal(campaignKey, productId) {
  const p = db.findProductById(productId);
  if (!p) { showToast('Không tìm thấy sản phẩm!', 'error'); return; }
  const campaign = (campaignKey && db.data.campaigns[campaignKey]) || null;
  const campName = campaign ? campaign.name : (campaignKey || '');

  closeProductEditorModal(); // chỉ cho phép 1 modal mở tại một thời điểm

  // Dựng card chỉnh sửa sâu — tái sử dụng cùng builder với tab Settings
  clearRenderCacheSafe();
  const cardHtml = uiRenderer.buildProductCardHtml(campaignKey || (p.campaignKey || ''), p);

  const overlay = document.createElement('div');
  overlay.className = 'product-editor-modal-overlay';
  overlay.innerHTML = `<div class="product-editor-modal" role="dialog" aria-modal="true" aria-label="Chỉnh sửa sâu sản phẩm">
    <div class="product-editor-modal-header">
      <div class="product-editor-modal-title">
        <span class="product-editor-modal-icon">${campaign ? escapeHtmlLocal(campaign.icon || '📦') : '⚙️'}</span>
        <div>
          <div style="font-weight:700; font-size:0.95rem;">⚙️ Chỉnh sửa sâu</div>
          <div style="font-size:0.78rem; color:var(--text-secondary);">${escapeHtmlLocal(p.name)}${campName ? ` · <span style="color:var(--accent-blue)">${escapeHtmlLocal(campName)}</span>` : ''}</div>
        </div>
      </div>
      <button class="btn btn-ghost btn-sm btn-close-product-editor-modal" title="Đóng (Esc)">✕</button>
    </div>
    <div class="product-editor-modal-body product-editor-root">
      ${cardHtml}
      ${buildCategoryDatalistSafe()}
    </div>
  </div>`;
  document.body.appendChild(overlay);

  // Gắn bộ xử lý chỉnh sửa sâu lên body của modal (dùng chung logic với tab Settings)
  const body = overlay.querySelector('.product-editor-modal-body');
  attachProductEditorDelegation(body);

  // Đóng: nút ✕ / click nền / phím Esc
  overlay.querySelector('.btn-close-product-editor-modal').addEventListener('click', closeProductEditorModal);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeProductEditorModal(); });
  document.addEventListener('keydown', _onProductEditorModalKeydown);
}
window.openProductEditorModal = openProductEditorModal;

function _onProductEditorModalKeydown(e) {
  if (e.key !== 'Escape') return;
  // Esc đang gõ alias inline → chỉ thoát ô alias, KHÔNG đóng cả modal
  const el = e.target;
  if (el && el.matches && el.matches('.alias-inline-input')) return;
  closeProductEditorModal();
}

export function closeProductEditorModal() {
  const overlay = document.querySelector('.product-editor-modal-overlay');
  document.removeEventListener('keydown', _onProductEditorModalKeydown);
  if (!overlay) return; // không có modal đang mở → không làm gì cả
  // Esc không gây blur: commit ô đang gõ qua delegation TRƯỚC khi gỡ DOM.
  // Esc hoàn tác của edit-tracker đã chặn sự kiện trước khi tới đường đóng này.
  const active = document.activeElement;
  if (overlay.contains(active) && active.matches('input, textarea') &&
      !active.readOnly && !active.matches('.alias-inline-input, .foc-gift-search-input') &&
      active.value !== (active.__oaCommitted ?? active.defaultValue)) {
    active.dispatchEvent(new Event('change', { bubbles: true }));
  }
  overlay.remove();
  // Đồng bộ lại giao diện nền: card trong tab Settings (nếu đang mở) + danh mục
  const campKey = store.getState().selectedSettingsCampaign;
  if (campKey) uiRenderer.renderSettingsEditor(campKey);
  if (typeof window.refreshCatalogAfterEditor === 'function') window.refreshCatalogAfterEditor();
}
window.closeProductEditorModal = closeProductEditorModal;

/** Xóa cache render an toàn (nếu helper nội bộ của ui-renderer chưa expose) */
function clearRenderCacheSafe() {
  if (typeof uiRenderer.clearRenderCache === 'function') uiRenderer.clearRenderCache();
}

/** Dựng datalist gợi ý nhóm hàng cho ô "Nhóm hàng" trong modal */
function buildCategoryDatalistSafe() {
  return (typeof uiRenderer.buildCategoryDatalistHtml === 'function') ? uiRenderer.buildCategoryDatalistHtml() : '';
}

/** Escape HTML cơ bản cho text hiển thị trong header modal */
function escapeHtmlLocal(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Helper: inline delete confirmation
function handleDeleteProduct(btn, campaignKey, container) {
  if (btn.hasAttribute('data-confirm-pending')) {
    // Already confirmed - delete
    const pId = btn.getAttribute('data-product-id');
    db.deleteProduct(pId);
    workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
    // Nếu đang xóa trong modal chỉnh sửa sâu → đóng modal và refresh catalog
    const modalOverlay = container && container.closest('.product-editor-modal-overlay');
    if (modalOverlay) {
      if (typeof window.closeProductEditorModal === 'function') window.closeProductEditorModal();
      if (typeof window.refreshCatalogAfterEditor === 'function') window.refreshCatalogAfterEditor();
    }
    uiRenderer.renderSettingsEditor(campaignKey);
    uiRenderer.renderSettingsSidebar(campaignKey);
    showToast('Đã xóa sản phẩm!', 'info');
    return;
  }

  // Show confirmation state
  btn.setAttribute('data-confirm-pending', 'true');
  const originalHtml = btn.innerHTML;
  btn.innerHTML = '⚠️ Xác nhận xóa?';
  btn.classList.add('btn-confirm-delete');

  // Auto-revert after 5 seconds
  const timer = setTimeout(() => {
    btn.removeAttribute('data-confirm-pending');
    btn.innerHTML = originalHtml;
    btn.classList.remove('btn-confirm-delete');
  }, 5000);

  btn.setAttribute('data-revert-timer', timer);
}

// --- Popup Modals Form Triggers ---

export function saveNewCampaign() {
  const key = document.getElementById('newCampaignKey').value.trim().toLowerCase();
  const name = document.getElementById('newCampaignName').value.trim();
  const icon = document.getElementById('newCampaignIcon').value.trim();
  const color = document.getElementById('newCampaignColor').value.trim();
  // Fallback 'zentor' nếu select chưa render hoặc người dùng chưa chọn (placeholder rỗng)
  const brandSelect = document.getElementById('newCampaignBrand');
  const brand = (brandSelect && brandSelect.value) || 'zentor';

  if (!key || !name) { showToast('Vui lòng điền mã và tên thương hiệu!', 'error'); return; }

  const ok = db.addCampaign(key, { name, icon: icon || '📦', color: color || '#4fc3f7', brand: brand });
  if (ok) {
    workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
    selectSettingsCampaign(key);
    closeModal();
    showToast(`Đã tạo thương hiệu: ${name}!`, 'success');
  } else {
    showToast('Mã thương hiệu đã tồn tại hoặc có lỗi xảy ra!', 'error');
  }
}

window.saveCampaignSettings = function(campaignKey) {
  const nameInput = document.getElementById('editCampaignName');
  const iconInput = document.getElementById('editCampaignIcon');
  const colorInput = document.getElementById('editCampaignColor');
  const brandSelect = document.getElementById('editCampaignBrand');
  
  if (!nameInput || !brandSelect) return;
  
  const name = nameInput.value.trim();
  const icon = iconInput ? iconInput.value.trim() : '📦';
  const color = colorInput ? colorInput.value.trim() : '#4fc3f7';
  const brand = brandSelect.value;
  
  if (!name) {
    showToast('Tên thương hiệu không được để trống!', 'error');
    return;
  }
  
  const ok = db.updateCampaign(campaignKey, { name, icon, color, brand });
  if (ok) {
    workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
    uiRenderer.renderSettingsSidebar(campaignKey);
    uiRenderer.renderSettingsEditor(campaignKey);
    showToast('Đã lưu cấu hình thương hiệu!', 'success');
  } else {
    showToast('Có lỗi xảy ra khi lưu cấu hình!', 'error');
  }
};

// Module-level callback for post-save refresh (used by Catalog view)
let _pendingAddProductOnSaved = null;

// Base unit list + all units found in DB (dynamic — new packing types auto-appear)
const BASE_UNITS = ['chai', 'can', 'lon', 'bình', 'phuy', 'tuýp', 'xô', 'cái', 'bộ'];

function getAllUnits() {
  const units = new Set(BASE_UNITS);
  if (db.data && db.data.campaigns) {
    Object.values(db.data.campaigns).forEach(camp => {
      (camp.products || []).forEach(p => {
        if (p.unit && p.unit.trim()) units.add(p.unit.trim());
      });
    });
  }
  return [...units];
}

export function showAddProductModal(campaignKey = null, onSaved = null) {
  const overlay = document.getElementById('modalOverlay');
  const title = document.getElementById('modalTitle');
  const body = document.getElementById('modalBody');

  const resolvedCampaign = campaignKey || store.getState().selectedSettingsCampaign;
  if (!overlay || !body || !resolvedCampaign) return;

  _pendingAddProductOnSaved = onSaved;

  const campaign = db.data.campaigns[resolvedCampaign];

  // Build campaign selector options
  const campaignOptions = Object.entries(db.data.campaigns || {}).map(([key, c]) => {
    const label = `${c.icon || ''} ${c.name}`.trim();
    return `<option value="${key}" ${key === resolvedCampaign ? 'selected' : ''}>${label}</option>`;
  }).join('');

  title.textContent = '📦 Thêm Sản Phẩm Mới';
  body.innerHTML = `<div class="card new-product-form-card" style="padding:var(--space-lg); max-height: 70vh; overflow-y: auto;">
    <div class="input-group" style="margin-bottom:var(--space-md);">
      <label>Thương hiệu</label>
      <select id="newProductCampaign" class="input-field" style="font-weight:600;">
        ${campaignOptions}
      </select>
    </div>

    <!-- Section 1: Thông tin cơ bản -->
    <div class="form-section">
      <div class="form-section-title">Thông tin cơ bản</div>
      <div class="input-group">
        <label>Tên sản phẩm <span style="color:var(--accent-red)">*</span></label>
        <input type="text" id="newProductName" class="input-field" placeholder="VD: Xvil Box 2" />
        <div class="field-error" id="errNewProductName" style="display:none; color:var(--accent-red); font-size:0.78rem; margin-top:2px;"></div>
      </div>
      <div class="input-group">
        <label>Nhóm hàng</label>
        <input type="text" id="newProductCategory" class="input-field" list="categorySuggestions" placeholder="VD: Dầu xe máy, Phụ gia..." />
      </div>
    </div>

    <!-- Section 2: Quy cách đóng gói -->
    <div class="form-section">
      <div class="form-section-title">Quy cách đóng gói</div>
      <div class="form-grid-2">
        <div class="input-group">
          <label>Spec (VD: 1L, 4L, 0.8L)</label>
          <input type="text" id="newProductSpec" class="input-field" placeholder="1L" />
        </div>
        <div class="input-group">
          <label>Đóng gói — mô tả thêm</label>
          <input type="text" id="newProductPackaging" class="input-field" placeholder="VD: 4 Kit/Thùng" />
          <div class="field-hint">Không tham gia tính số lượng/thùng.</div>
        </div>
      </div>
      <div class="form-grid-2">
        <div class="input-group">
          <label>Đơn vị</label>
          <select id="newProductUnit" class="input-field">
            ${getAllUnits().map(u => `<option value="${u}" ${u === 'chai' ? 'selected' : ''}>${u}</option>`).join('')}
          </select>
        </div>
        <div class="input-group">
          <label>Số lượng/thùng (box size) <span style="color:var(--accent-red)">*</span></label>
          <input type="number" id="newProductBoxSize" class="input-field" value="12" min="1" />
          <div class="field-error" id="errNewProductBoxSize" style="display:none; color:var(--accent-red); font-size:0.78rem; margin-top:2px;"></div>
        </div>
      </div>
      <div id="newProductPackingPreview" style="font-size:0.8rem; color:var(--text-secondary); margin-top:4px;"></div>
    </div>

    <!-- Section 3: Giá bán -->
    <div class="form-section">
      <div class="form-section-title">Giá bán theo mốc số lượng thùng</div>
      <div id="newProductTiers"></div>
      <button type="button" class="btn btn-ghost btn-sm" id="btnNewProductAddTier" style="margin-top:4px;">➕ Thêm mốc giá</button>
      <div class="field-error" id="errNewProductPrice" style="display:none; color:var(--accent-red); font-size:0.78rem; margin-top:2px;"></div>
    </div>

    <!-- Section 4: Mã KiotViet -->
    <div class="form-section">
      <div class="form-section-title">Mã KiotViet</div>
      <div class="form-grid-2">
        <div class="input-group">
          <label>Mã đơn vị lẻ (chai/bình/lon...)</label>
          <input type="text" id="newProductKvCode" class="input-field" style="font-family:var(--font-mono, monospace);" placeholder="VD: 3700142344662" />
          <div class="field-error" id="errNewProductKvCode" style="display:none; color:var(--accent-red); font-size:0.78rem; margin-top:2px;"></div>
        </div>
        <div class="input-group">
          <label>Mã thùng <span style="font-weight:400; color:var(--text-secondary);">(trống = tự phân: mã lẻ + '-1')</span></label>
          <input type="text" id="newProductKvCodeThung" class="input-field" style="font-family:var(--font-mono, monospace); background:rgba(0,122,255,0.07);" placeholder="VD: 3700142344662-1" />
        </div>
      </div>
    </div>

    <!-- Section 5: Alias + KM nhanh (gập) -->
    <details class="form-section" style="border:1px solid var(--border-color); border-radius:6px; padding:8px 10px;">
      <summary style="cursor:pointer; font-weight:600; font-size:0.85rem;">Tên gọi tắt + KM nhanh (mở rộng)</summary>
      <div class="input-group" style="margin-top:8px;">
        <label>Tên gọi tắt (aliases, cách nhau bởi dấu phẩy)</label>
        <input type="text" id="newProductAliases" class="input-field" placeholder="VD: box 2, xvil box" />
        <div class="field-error" id="errNewProductAliases" style="display:none; color:var(--accent-red); font-size:0.78rem; margin-top:2px;"></div>
      </div>
      <div style="display:flex; align-items:center; flex-wrap:wrap; gap:6px; font-size:0.85rem; margin-top:8px; background:rgba(76,175,80,0.07); border:1px solid rgba(76,175,80,0.25); border-radius:6px; padding:8px 10px;">
        <span>🎁 KM nhanh:</span>
        <span>Mua</span>
        <input type="number" id="newProductPromoBuy" class="input-field" value="" placeholder="SL" min="1" style="width:64px;" />
        <select id="newProductPromoBuyUnit" class="input-field" style="width:90px;">
          <option value="thùng" selected>thùng</option>
          <option value="chai">chai</option>
          <option value="lon">lon</option>
          <option value="can">can</option>
          <option value="tuýp">tuýp</option>
        </select>
        <span>tặng</span>
        <input type="number" id="newProductPromoGift" class="input-field" value="" placeholder="SL" min="1" style="width:64px;" />
        <span>cùng loại</span>
        <span style="color:var(--text-tertiary); font-size:0.78rem;">(trống = không tạo KM — cấu hình sau trong Catalog/Settings)</span>
      </div>
    </details>

    <button class="btn btn-success btn-block" id="btnSubmitAddProduct" style="margin-top:var(--space-md)">💾 Lưu Sản Phẩm</button>
  </div>`;

  overlay.style.display = 'flex';

  // --- Editor mốc giá ngay trong form tạo (mặc định 1 dòng "Tất cả") ---
  const tiersBox = document.getElementById('newProductTiers');
  const paintTierRow = (tier) => {
    const row = document.createElement('div');
    row.className = 'tier-row';
    row.style.cssText = 'display:flex; gap:6px; align-items:center; margin-bottom:6px;';
    row.innerHTML = `
      <input type="text" class="input-field np-tier-label" value="${_escHtml(tier.label || 'Tất cả')}" placeholder="Nhãn (VD: 1-5 thùng)" style="flex:1;" />
      <input type="number" class="input-field np-tier-min" value="${tier.min_qty ?? 1}" min="1" style="width:70px;" title="Min" />
      <input type="number" class="input-field np-tier-max" value="${tier.max_qty ?? 9999}" min="1" style="width:80px;" title="Max" />
      <input type="text" class="input-field np-tier-price" inputmode="numeric" value="" placeholder="Giá (₫)" style="width:130px; text-align:right; font-weight:700;" />
      <button type="button" class="btn btn-ghost btn-sm np-tier-remove" title="Xóa mốc">✕</button>`;
    const priceEl = row.querySelector('.np-tier-price');
    if (tier.price) priceEl.value = formatNumberWithDots(tier.price);
    priceEl.addEventListener('input', () => formatInputWithDotsAndPreserveCursor(priceEl));
    row.querySelector('.np-tier-remove').onclick = () => {
      if (tiersBox.querySelectorAll('.tier-row').length <= 1) {
        showToast('Phải giữ ít nhất 1 mốc giá!', 'error');
        return;
      }
      row.remove();
    };
    tiersBox.appendChild(row);
  };
  paintTierRow({ min_qty: 1, max_qty: 9999, price: 0, label: 'Tất cả' });
  document.getElementById('btnNewProductAddTier').onclick = () =>
    paintTierRow({ min_qty: 1, max_qty: 9999, price: 0, label: '' });

  // --- Preview quy cách tự sinh: "12 chai/thùng" (cùng quy tắc packagingAutoText) ---
  const previewEl = document.getElementById('newProductPackingPreview');
  const boxEl = document.getElementById('newProductBoxSize');
  const unitEl = document.getElementById('newProductUnit');
  const updatePreview = () => {
    previewEl.textContent = 'Hiển thị trên đơn: ' + (packagingPreviewText(boxEl.value, unitEl.value) || '(chưa có đơn vị)');
  };
  boxEl.addEventListener('input', updatePreview);
  unitEl.addEventListener('change', updatePreview);
  updatePreview();

  // Bind submit click — read campaign from dropdown at save time
  document.getElementById('btnSubmitAddProduct').onclick = () => {
    const selectedCampaign = document.getElementById('newProductCampaign').value;
    saveNewProduct(selectedCampaign);
  };

  // Auto-focus product name
  document.getElementById('newProductName').focus();
}

export async function saveNewProduct(campaignKey = null) {
  const $ = (id) => document.getElementById(id);
  const nameEl = $('newProductName');
  const boxSizeEl = $('newProductBoxSize');
  const kvEl = $('newProductKvCode');
  const aliasEl = $('newProductAliases');

  const tiers = [...document.querySelectorAll('#newProductTiers .tier-row')].map(row => ({
    label: (row.querySelector('.np-tier-label').value || '').trim() || 'Tất cả',
    min_qty: Math.max(1, parseInt(row.querySelector('.np-tier-min').value, 10) || 1),
    max_qty: Math.max(1, parseInt(row.querySelector('.np-tier-max').value, 10) || 9999),
    price: parseFormattedNumber(row.querySelector('.np-tier-price').value) || 0,
  }));

  const payload = {
    name: nameEl.value.trim(),
    kvCode: kvEl.value.trim(),
    kvCodeThung: $('newProductKvCodeThung').value.trim(),
    spec: $('newProductSpec').value.trim(),
    packaging: $('newProductPackaging').value.trim(),
    unit: $('newProductUnit').value,
    box_size: boxSizeEl.value.trim(),
    category: $('newProductCategory').value.trim(),
    price: tiers.length ? tiers[0].price : 0,
    tiers,
    aliases: aliasEl.value.trim(),
    quickPromo: {
      buyQty: parseInt($('newProductPromoBuy').value, 10) || 0,
      buyUnit: $('newProductPromoBuyUnit').value,
      giftQty: parseInt($('newProductPromoGift').value, 10) || 0,
    },
  };

  const resolvedCampaign = campaignKey || store.getState().selectedSettingsCampaign;
  const campaign = db.data.campaigns[resolvedCampaign];
  if (!campaign) {
    showToast('Vui lòng chọn thương hiệu trước khi lưu!', 'error');
    return;
  }

  // Validate chung (cùng logic test khóa trong test/product-create.test.mjs).
  const validation = validateNewProduct(payload, {
    siblingNames: (campaign.products || []).map(p => p.name),
    crossCampaignNames: Object.entries(db.data.campaigns || {})
      .filter(([k]) => k !== resolvedCampaign)
      .flatMap(([, c]) => (c.products || []).map(p => p.name)),
    kvCodeTaken: (code) => Object.entries(db.kvCodeMap || {}).some(([, c]) => c === code)
      || Object.values(db.data.campaigns || {}).some(c => (c.products || []).some(p => (p.kvCode || '') === code)),
    aliasOwner: (lower) => db.getAliases()[lower] || null,
  });

  // Hiện lỗi inline đỏ tại từng ô thay vì chỉ toast.
  const showErr = (id, msg) => {
    const el = $(id);
    if (!el) return;
    el.style.display = msg ? 'block' : 'none';
    el.textContent = msg || '';
  };
  showErr('errNewProductName', validation.errors.name || '');
  showErr('errNewProductBoxSize', validation.errors.box_size || '');
  showErr('errNewProductPrice', validation.errors.price || '');
  showErr('errNewProductKvCode', validation.errors.kvCode || '');
  showErr('errNewProductAliases', validation.errors.aliases || '');
  nameEl.classList.toggle('input-error', !!validation.errors.name);
  boxSizeEl.classList.toggle('input-error', !!validation.errors.box_size);

  if (!validation.ok) {
    const first = validation.errors.name || validation.errors.box_size
      || validation.errors.price || validation.errors.kvCode || validation.errors.aliases;
    showToast(first, 'error');
    (validation.errors.name ? nameEl : validation.errors.box_size ? boxSizeEl : null)?.focus();
    return;
  }

  // Warning trùng tên (trong thương hiệu hoặc xuyên thương hiệu): gợi ý mở SP cũ thay vì tạo mới.
  const dupWarnings = validation.warnings.filter(w => w.code === 'DUPLICATE_NAME' || w.code === 'DUPLICATE_NAME_CROSS_CAMPAIGN');
  if (dupWarnings.length && !(await confirmDialog({
    title: 'Sản phẩm trùng tên',
    message: `${dupWarnings.map(w => w.message).join('\n')}\n\nBạn vẫn muốn thêm sản phẩm trùng tên?`,
  }))) {
    return;
  }

  const res = createProductFull(resolvedCampaign, payload);
  if (!res.ok) {
    showToast(res.message || 'Lỗi khi thêm sản phẩm!', 'error');
    return;
  }

  if (_pendingAddProductOnSaved) {
    _pendingAddProductOnSaved(res.product);
    _pendingAddProductOnSaved = null;
  } else {
    uiRenderer.renderSettingsEditor(resolvedCampaign);
  }
  closeModal();
  showToast(`Đã thêm sản phẩm: ${payload.name}!`, 'success');

  const missingKv = validation.warnings.find(w => w.code === 'MISSING_KVCODE');
  if (missingKv) {
    setTimeout(() => showToast('Chưa nhập mã KiotViet — SP đã gắn cờ "Thiếu mã KV" trong Danh mục', 'warning'), 600);
  }
}

export function closeModal() {
  const overlay = document.getElementById('modalOverlay');
  if (overlay) overlay.style.display = 'none';
}

// --- Import / Export Settings Database ---

export function exportDatabase() {
  const jsonStr = db.exportJSON();
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = `order_automation_db_v4_${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  
  showToast('Đã xuất file database (JSON) thành công!', 'success');
}

export function importDatabase(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    const ok = db.importJSON(e.target.result);
    if (ok) {
      workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
      
      // Reload active UI
      const campaignKey = store.getState().selectedSettingsCampaign;
      selectSettingsCampaign(campaignKey);
      
      showToast('Đã nhập database thành công!', 'success');
    } else {
      showToast('File JSON không hợp lệ hoặc cấu trúc không khớp!', 'error');
    }
  };
  reader.readAsText(file);
}

export async function resetDatabase() {
  if (await confirmDialog({
    title: '⚠️ Reset database',
    message: '⚠️ Bạn có chắc chắn muốn RESET database về cấu hình chuẩn gốc? Toàn bộ các sản phẩm tạo thêm, alias tự thêm sẽ bị xoá vĩnh viễn!',
    danger: true
  })) {
    await db.reset();
    workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
    
    const campaignKey = store.getState().selectedSettingsCampaign;
    selectSettingsCampaign(campaignKey);
    
    showToast('Đã reset database về mặc định chuẩn.', 'info');
  }
}

// --- Global UI Listeners Binding ---

/**
 * Updates the sidebar footer status indicators (AI mode + product count).
 */
export function updateSidebarStatus() {
  const countEl = document.getElementById('sidebarProductCount');
  if (countEl) {
    const total = (db.getAllProducts() || []).length;
    countEl.textContent = total > 0 ? total : '—';
  }
  // AI status is now managed by initAiProfileManager's render()
  // Only update here as fallback if profile manager hasn't rendered yet
  const aiStatusEl = document.getElementById('sidebarAiStatus');
  const aiDotEl = document.getElementById('sidebarAiDot');
  if (aiStatusEl && !aiStatusEl.dataset.managed) {
    aiService.getProfiles().then(({ profiles }) => {
      const enabled = profiles.filter(p => p.enabled);
      if (enabled.length === 0) {
        aiStatusEl.textContent = 'Offline';
        if (aiDotEl) aiDotEl.className = 'status-dot';
      } else {
        aiStatusEl.textContent = enabled.length === 1 ? (enabled[0].provider === 'gemini' ? 'Gemini' : enabled[0].provider === 'openai' ? 'OpenAI' : enabled[0].provider === 'lmstudio' ? 'LM Studio' : 'Custom') : `${enabled.length} AI`;
        if (aiDotEl) aiDotEl.className = 'status-dot ai';
      }
    });
  }
}

export function bindGlobalUIListeners() {
  // --- Sidebar collapse toggle (persisted in localStorage) ---
  const sidebarToggle = document.getElementById('sidebarToggle');
  const appShell = document.querySelector('.app-shell');
  if (sidebarToggle && appShell) {
    appShell.classList.toggle('sidebar-collapsed', localStorage.getItem('sidebarCollapsed') === '1');
    sidebarToggle.addEventListener('click', () => {
      const collapsed = appShell.classList.toggle('sidebar-collapsed');
      localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0');
    });
  }

  // --- Catalog search: static input, bound ONCE (never destroyed by re-renders) ---
  const catalogSearchInput = document.getElementById('catalogSearchInput');
  if (catalogSearchInput) {
    catalogSearchInput.addEventListener('input', function() {
      uiRenderer._catalogSearch = this.value;
      const clearBtn = document.getElementById('catalogSearchClear');
      if (clearBtn) clearBtn.classList.toggle('hidden', !this.value);
      clearTimeout(window._catalogSearchTimer);
      window._catalogSearchTimer = setTimeout(() => {
        uiRenderer.renderCatalog(uiRenderer.getCatalogCampaignFilter());
      }, 300);
    });
  }
  const catalogSearchClear = document.getElementById('catalogSearchClear');
  if (catalogSearchClear) {
    catalogSearchClear.addEventListener('click', function() {
      const el = document.getElementById('catalogSearchInput');
      if (el) { el.value = ''; el.focus(); }
      uiRenderer._catalogSearch = '';
      this.classList.add('hidden');
      clearTimeout(window._catalogSearchTimer);
      uiRenderer.renderCatalog(uiRenderer.getCatalogCampaignFilter());
    });
  }

  // --- Settings Sub-tabs click handlers ---
  document.querySelectorAll('.settings-subtab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      switchSettingsSubTab(btn.getAttribute('data-subtab'));
    });
  });

  // --- Tab Switch Navigation ---
  const navTabs = document.querySelectorAll('.nav-tab');
  navTabs.forEach(tab => {
    tab.onclick = () => {
      navTabs.forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));

      tab.classList.add('active');
      const tabName = tab.getAttribute('data-tab');
      let targetPanelId = 'panelOrder';
      if (tabName === 'catalog' || tab.id === 'tabCatalog') targetPanelId = 'panelCatalog';
      else if (tabName === 'settings' || tab.id === 'tabSettings') targetPanelId = 'panelSettings';

      const targetPanel = document.getElementById(targetPanelId);
      if (targetPanel) targetPanel.classList.add('active');

      if (targetPanelId === 'panelCatalog') {
        // Only re-render catalog if data has changed since last render
        if (window._catalogNeedsRender !== false) {
          // Giữ trạng thái UI Catalog khi re-render (thẻ đang mở + ô tìm kiếm) —
          // đúng pattern refreshCatalog trong src/catalog/delegation.js
          const _searchState = saveCatalogSearchState();
          const _expanded = saveExpandedCatalogCards();
          const curFilter = uiRenderer.getCatalogCampaignFilter();
          uiRenderer.renderCatalog(curFilter);
          restoreExpandedCatalogCards(_expanded);
          restoreCatalogSearchState(_searchState);
          window._catalogNeedsRender = false;
        }
      } else if (targetPanelId === 'panelSettings') {
        // Only re-render settings if data has changed since last render
        if (window._settingsNeedsRender !== false) {
          const campaignKey = store.getState().selectedSettingsCampaign || Object.keys(db.data.campaigns || {})[0];
          selectSettingsCampaign(campaignKey);
          window._settingsNeedsRender = false;
        }
      } else if (targetPanelId === 'panelOrder') {
        // Re-render order panel if state changed while on another tab
        if (window._orderNeedsRender === true) {
          uiRenderer.renderOrderResults(store.getState().currentOrder);
          renderCustomPromos();
          window._orderNeedsRender = false;
        }
      }
    };
  });

  // Catalog → campaign-only settings (general configuration, MKT and text rules).
  const manageCampaignsBtn = document.getElementById('btnCatalogManageCampaigns');
  if (manageCampaignsBtn) manageCampaignsBtn.onclick = () => {
    document.getElementById('tabSettings')?.click();
    switchSettingsSubTab('campaigns');
    const filtered = uiRenderer.getCatalogCampaignFilter();
    const selected = store.getState().selectedSettingsCampaign;
    const campaignKey = db.data.campaigns[filtered] ? filtered
      : (db.data.campaigns[selected] ? selected : Object.keys(db.data.campaigns || {})[0]);
    selectSettingsCampaign(campaignKey || null);
  };

  // --- Keyboard shortcut: Ctrl+Enter to parse ---
  const orderTextarea = document.getElementById('orderText');
  if (orderTextarea) {
    orderTextarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        parseOrder();
      }
    });

    // Auto-expand the textarea as the user types/pastes so long order
    // lines (product names, PO numbers) stay readable; beyond the cap
    // the box keeps a visible internal scrollbar.
    orderTextarea.addEventListener('input', autoGrowOrderText);
    autoGrowOrderText();
  }

  // Order main panel buttons
  const btnParse = document.getElementById('btnParse');
  if (btnParse) btnParse.onclick = () => parseOrder();

  const btnCopy = document.getElementById('btnCopy');
  if (btnCopy) btnCopy.onclick = () => copySummary();

  const btnExportExcel = document.getElementById('btnExportExcel');
  if (btnExportExcel) btnExportExcel.onclick = () => exportToExcel();

  const btnClearOrder = document.getElementById('btnClear') || document.getElementById('btnClearOrder');
  if (btnClearOrder) btnClearOrder.onclick = () => clearOrder();

  const btnSampleOrder = document.getElementById('btnSample') || document.getElementById('btnSampleOrder');
  if (btnSampleOrder) btnSampleOrder.onclick = () => loadSampleOrder();

  // Seller management button
  const btnManageSellers = document.getElementById('btnManageSellers');
  if (btnManageSellers) btnManageSellers.onclick = () => openSellerManager();

  // Prefix management buttons
  const btnAddPrefix = document.getElementById('btnAddPrefix');
  if (btnAddPrefix) btnAddPrefix.onclick = () => addBrandPrefix();

  const btnResetPrefixes = document.getElementById('btnResetPrefixes');
  if (btnResetPrefixes) btnResetPrefixes.onclick = () => resetPrefixesToDefault();

  // Title format config
  const titleFormatInput = document.getElementById('titleFormatInput');
  const btnSaveTitleFormat = document.getElementById('btnSaveTitleFormat');
  if (titleFormatInput) {
    titleFormatInput.value = localStorage.getItem('titleFormat') || '{PREFIX}{YY}{MM}-{sequence}-{Người nhận đặt}-{Chiết khấu}';
  }
  if (btnSaveTitleFormat && titleFormatInput) {
    btnSaveTitleFormat.onclick = () => {
      localStorage.setItem('titleFormat', titleFormatInput.value.trim());
      showToast('Đã lưu format tiêu đề!', 'success');
    };
  }

  // Parse concurrency (hàng đợi phân tích song song) — Cài đặt → AI
  const parseConcurrencySelect = document.getElementById('parseConcurrencySelect');
  if (parseConcurrencySelect) {
    parseConcurrencySelect.value = String(getParseConcurrency());
    parseConcurrencySelect.onchange = () => {
      const v = setParseConcurrency(parseConcurrencySelect.value);
      parseConcurrencySelect.value = String(v);
      showToast(`Số đơn phân tích song song: ${v}`, 'success');
    };
  }

  // Initialize seller dropdown
  populateSellerDropdown();

  // Dialog modal close hook
  const btnCloseModal = document.getElementById('btnCloseModal');
  const modalOverlay = document.getElementById('modalOverlay');
  if (btnCloseModal) btnCloseModal.onclick = () => closeModal();
  if (modalOverlay) {
    modalOverlay.onclick = (e) => { if (e.target === modalOverlay) closeModal(); };
  }

  // ==================== AI Profile Management ====================
  initAiProfileManager();

  // Custom Promos Action Hook
  const btnAddCustomPromo = document.getElementById('btnAddPromo');
  if (btnAddCustomPromo) btnAddCustomPromo.onclick = () => addCustomPromo();

  // Manual Product Search input Hook
  const manualSearchInput = document.getElementById('manualProductSearch');
  if (manualSearchInput) {
    // Search with debounce to prevent UI freezing
    let searchTimeout = null;
    manualSearchInput.addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        onManualSearch(e.target.value);
      }, 250); // 250ms debounce
    });
  }

  // Settings Database management buttons
  const btnExport = document.getElementById('btnExport') || document.getElementById('btnExportDb');
  if (btnExport) btnExport.onclick = () => exportDatabase();

  const btnImportTrigger = document.getElementById('btnImportTrigger');
  const importFileInput = document.getElementById('importFileInput') || document.getElementById('btnImportDbFile');
  if (btnImportTrigger && importFileInput) {
    btnImportTrigger.onclick = () => importFileInput.click();
  }
  if (importFileInput) {
    importFileInput.onchange = (e) => importDatabase(e);
  }

  const btnReset = document.getElementById('btnReset') || document.getElementById('btnResetDb');
  if (btnReset) btnReset.onclick = () => resetDatabase();

  // AI & Memory settings buttons
  const btnSaveMemory = document.getElementById('btnSaveMemory');
  if (btnSaveMemory) {
    btnSaveMemory.onclick = () => {
      const memEditor = document.getElementById('aiMemoryInput');
      if (memEditor) {
        db.saveMemory(memEditor.value);
        showToast('Đã lưu bộ nhớ AI thành công!', 'success');
      }
    };
  }

  const btnToggleAddProduct = document.getElementById('btnToggleAddProduct');
  if (btnToggleAddProduct) btnToggleAddProduct.onclick = () => showAddProductModal();

  const btnToggleAddCampaign = document.getElementById('btnToggleAddCampaign');
  if (btnToggleAddCampaign) btnToggleAddCampaign.onclick = () => switchSettingsSubTab('campaigns');

  // --- Sidebar Collapse Toggle ---
  const btnCollapseSidebar = document.getElementById('btnCollapseSidebar');
  if (btnCollapseSidebar) {
    btnCollapseSidebar.onclick = () => {
      const grid = btnCollapseSidebar.closest('.settings-grid');
      if (!grid) return;
      grid.classList.add('sidebar-collapsed');
      // Show floating expand button on the editor card
      const editorCard = grid.querySelector('#productEditor')?.closest('.card');
      if (editorCard) {
        editorCard.style.position = 'relative';
        let expandBtn = editorCard.querySelector('.btn-expand-sidebar');
        if (!expandBtn) {
          expandBtn = document.createElement('button');
          expandBtn.className = 'btn-expand-sidebar';
          expandBtn.title = 'Mở rộng danh sách thương hiệu';
          expandBtn.textContent = '▶';
          expandBtn.onclick = () => {
            grid.classList.remove('sidebar-collapsed');
            expandBtn.remove();
          };
          editorCard.appendChild(expandBtn);
        }
      }
    };
  }

  // --- Settings Nav Collapse Toggle ---
  const btnCollapseSettingsNav = document.getElementById('btnCollapseSettingsNav');
  if (btnCollapseSettingsNav) {
    btnCollapseSettingsNav.onclick = () => {
      const layout = btnCollapseSettingsNav.closest('.settings-layout');
      if (!layout) return;
      layout.classList.toggle('nav-collapsed');
    };
  }

  // --- Order Directory Config (Electron only) ---
  const btnPickOrderDir = document.getElementById('btnPickOrderDir');
  const btnSaveOrderDir = document.getElementById('btnSaveOrderDir');
  const orderDirInput = document.getElementById('orderDirInput');
  const orderDirStatus = document.getElementById('orderDirStatus');

  if (btnPickOrderDir && window.electronAPI && window.electronAPI.pickFolder) {
    btnPickOrderDir.onclick = async () => {
      const folder = await window.electronAPI.pickFolder();
      if (folder && orderDirInput) orderDirInput.value = folder;
    };
  }
  if (btnSaveOrderDir && window.electronAPI && window.electronAPI.setOrderDir) {
    btnSaveOrderDir.onclick = async () => {
      const dir = orderDirInput ? orderDirInput.value.trim() : '';
      if (!dir) {
        if (orderDirStatus) orderDirStatus.innerHTML = '<span style="color:var(--status-error);">Vui lòng nhập hoặc chọn đường dẫn.</span>';
        return;
      }
      const result = await window.electronAPI.setOrderDir(dir);
      if (result && result.success) {
        if (orderDirStatus) orderDirStatus.innerHTML = '<span style="color:var(--status-success);">✅ Đã lưu đường dẫn thành công!</span>';
        showToast('Đã lưu thư mục đơn hàng!', 'success');
      }
    };
  }
  // Load current order dir on settings tab open
  if (window.electronAPI && window.electronAPI.getOrderDir && orderDirInput) {
    window.electronAPI.getOrderDir().then((dir) => {
      if (dir) orderDirInput.value = dir;
    });
  }

  const btnCloseCampaignForm = document.getElementById('btnCloseCampaignForm');
  if (btnCloseCampaignForm) btnCloseCampaignForm.onclick = () => {
    document.getElementById('addCampaignCard').style.display = 'none';
  };

  // Điền sẵn options cho form tạo thương hiệu tĩnh (ngoài modal) lúc khởi tạo UI
  populateBrandSheetSelect(document.getElementById('newCampaignBrand'));

  const btnSaveCampaign = document.getElementById('btnSaveCampaign');
  if (btnSaveCampaign) btnSaveCampaign.onclick = () => saveNewCampaign();

  // Campaign override change
  const overrideDropdown = document.getElementById('aiOverrideCampaign');
  if (overrideDropdown) {
    overrideDropdown.onchange = () => {
      const val = overrideDropdown.value;
      const currentOrder = store.getState().currentOrder;
      if (val && currentOrder.aiResult) {
        currentOrder.aiResult.primaryCampaign = val;
        const campaign = db.data.campaigns[val];
        if (campaign) {
          currentOrder.aiResult.campaignLabel = `${campaign.icon} ${campaign.name}`;
          currentOrder.aiResult.campaignColor = campaign.color;
          currentOrder.aiResult.confidencePercent = 100;
          currentOrder.aiResult.confidence = 1;
        }
        uiRenderer.renderAIDetection(currentOrder.aiResult);
        showToast('Đã ghi đè thương hiệu!', 'info');
      }
    };
  }

  // Click outside to close comboboxes
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.combobox-container')) {
      document.querySelectorAll('.combobox-dropdown').forEach(d => d.style.display = 'none');
    }
    const manualSearchDropdown = document.getElementById('manualSearchDropdown');
    if (manualSearchDropdown && !e.target.closest('#manualProductSearch')) {
      manualSearchDropdown.style.display = 'none';
    }
  });
}

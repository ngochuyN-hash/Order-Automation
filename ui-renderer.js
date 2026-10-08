/**
 * =========================================================================
 *  ORDER AUTOMATION - UI RENDERER (ui-renderer.js)
 * =========================================================================
 *  Pure UI Rendering Module. Reads state from store and updates the DOM.
 *  Uses escapeHtml and textContent strictly to prevent XSS.
 * =========================================================================
 */

// Import tường minh — file legacy này từng dựa vào global window.db (db.js
// tự gán) nên chỉ chạy được trong trình duyệt; trong ngữ cảnh khác (Node test,
// render nền) mọi `db.` đều văng "db is not defined".
import { db } from './db.js';

function formatCurrency(amount) {
  return new Intl.NumberFormat('en-US').format(amount) + ' đ';
}

/**
 * Gắn/cập nhật ARIA cho thanh tiến trình một cách AN TOÀN qua JS:
 * - Tự thêm role="progressbar" nếu phần tử chưa có (markup tĩnh do người khác
 *   quản lý — không sửa index.html được).
 * - Set aria-valuenow = % (clamp 0–100, làm tròn) + aria-valuemin/max.
 *
 * Lưu ý: nên gọi trên WRAPPER của thanh fill (phần tử gốc không đổi width),
 * vì ARIA khuyến nghị progressbar không phải element bị co giãn liên tục.
 *
 * @param {HTMLElement|null} el - Phần tử giữ vai trò progressbar (wrapper).
 * @param {number} pct - Phần trăm hoàn thành (0–100).
 */
export function setProgressbarAria(el, pct) {
  if (!el || typeof el.setAttribute !== 'function') return;
  if (!el.getAttribute('role')) el.setAttribute('role', 'progressbar');
  const clamped = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  el.setAttribute('aria-valuenow', String(clamped));
  el.setAttribute('aria-valuemin', '0');
  el.setAttribute('aria-valuemax', '100');
}

function formatNumberWithDots(val) {
  if (val === undefined || val === null || isNaN(val)) return '';
  const parts = val.toString().split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.join('.');
}

function parseFormattedNumber(str) {
  if (!str) return 0;
  const clean = str.toString().replace(/,/g, '');
  const val = parseFloat(clean);
  return isNaN(val) ? 0 : val;
}

function formatInputWithDotsAndPreserveCursor(inputEl) {
  const selectionStart = inputEl.selectionStart;
  const selectionEnd = inputEl.selectionEnd;
  const originalLength = inputEl.value.length;
  
  const cleanVal = parseFormattedNumber(inputEl.value);
  if (cleanVal === 0 && inputEl.value === '') return;
  
  const formatted = formatNumberWithDots(cleanVal);
  inputEl.value = formatted;
  
  // Restore cursor position
  const newLength = formatted.length;
  const lengthDiff = newLength - originalLength;
  inputEl.setSelectionRange(selectionStart + lengthDiff, selectionEnd + lengthDiff);
}

const _escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const _escapeRe = /[&<>"']/g;
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(_escapeRe, ch => _escapeMap[ch]);
}

/**
 * Per-render-cycle cache for expensive computations.
 * Cleared at the start of each major render pass (renderCatalog, renderSettingsEditor).
 */
let _renderCache = {};
function clearRenderCache() { _renderCache = {}; }

/**
 * Signature nhanh của "hình dạng bảng đơn" — mọi field ảnh hưởng dòng bảng
 * (items + các map quà) DÙNG ĐỂ (1) skip rebuild khi state set vô can
 * (isLoading, pendingId...) và (2) memoize HTML bảng khỏi chạy lại pipeline quà.
 * Cố tình KHÔNG gồm db rules KM: rule chỉ đổi qua Settings/boot — đơn đang mở
 * giữ snapshot parse (đúng ngữ nghĩa toast "đơn hiện tại giữ nguyên").
 * PHẢI gồm rowOrder: kéo thả dòng chỉ đổi rowOrder (không đổi items) — nếu thiếu,
 * subscriber main.js thấy sig không đổi → skip render → thả không cập nhật bảng
 * (hồi quy 16/9/2026 từ commit gate-render-theo-sig bdecb5f).
 */
function orderTableSignature(currentOrder) {
  if (!currentOrder || !Array.isArray(currentOrder.items)) return '';
  const parts = currentOrder.items.map((it, i) => {
    const p = it.product;
    const price = (it.manualPrice !== null && it.manualPrice !== undefined)
      ? ('m' + it.manualPrice)
      : ('u' + (it.unitPrice || 0));
    return [
      i,
      p ? p.id : (it.isCustom ? 'c' : 'x'),
      it.rawName || it.name || '',
      it.qty, it.unit, price,
      it.isGift ? 1 : 0, it.isCustom ? 1 : 0,
      it.tierLabel || '',
      (it.matchScore === undefined || it.matchScore === null) ? 100 : it.matchScore,
      it.matchVia || '',
      it.foc ? JSON.stringify(it.foc) : ''
    ].join('|');
  });
  return parts.join(';')
    + '|gd:' + (currentOrder.giftDeleted ? JSON.stringify(currentOrder.giftDeleted) : '')
    + '|go:' + (currentOrder.giftOverrides ? JSON.stringify(currentOrder.giftOverrides) : '')
    + '|gq:' + (currentOrder.giftQtyOverrides ? JSON.stringify(currentOrder.giftQtyOverrides) : '')
    + '|gk:' + (currentOrder.giftKindOverrides ? JSON.stringify(currentOrder.giftKindOverrides) : '')
    + '|ro:' + (Array.isArray(currentOrder.rowOrder) && currentOrder.rowOrder.length ? currentOrder.rowOrder.join('|') : '');
}

/**
 * Từ khóa tìm kiếm của mục "Chỉnh sửa sâu" (Settings Editor) — giữ lại giữa các lần
 * re-render để không mất trạng thái khi lưu chỉnh sửa.
 */
let _settingsProductQuery = '';

function _normSearchText(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').trim();
}

/**
 * Thu thập danh sách đơn vị tặng (give_unit) khả dụng để dựng dropdown.
 * Cached per render cycle — only scans DB once, then reuses for all FOC/MKT rows.
 */
function getAvailableGiveUnits(currentValue) {
  if (!_renderCache.giveUnits) {
    const units = new Set();
    if (typeof db !== 'undefined' && db) {
      (db.getAllProducts() || []).forEach(p => {
        if (p && p.unit) units.add(String(p.unit).trim());
      });
      const campaigns = (db.data && db.data.campaigns) ? db.data.campaigns : {};
      for (const campaign of Object.values(campaigns)) {
        // [Promo v1.3.0] Đơn vị tặng lấy từ gifts[].unit của campaign.promoRules
        (campaign.promoRules || []).forEach(r => {
          if (!Array.isArray(r.gifts)) return;
          r.gifts.forEach(g => { if (g && g.unit) units.add(String(g.unit).trim()); });
        });
      }
    }
    _renderCache.giveUnits = [...units].filter(Boolean).sort((a, b) => a.localeCompare(b, 'vi'));
  }
  const result = _renderCache.giveUnits;
  if (currentValue && !result.includes(String(currentValue).trim())) {
    return [...result, String(currentValue).trim()].sort((a, b) => a.localeCompare(b, 'vi'));
  }
  return result;
}

/**
 * Dựng chuỗi HTML <option> cho dropdown đơn vị tặng, đánh dấu selected ở giá trị hiện tại.
 */
function buildUnitOptionsHtml(currentValue) {
  const cur = (currentValue || '').trim();
  return getAvailableGiveUnits(currentValue).map(u =>
    `<option value="${escapeHtml(u)}" ${u === cur ? 'selected' : ''}>${escapeHtml(u)}</option>`
  ).join('');
}

/**
 * Dựng dropdown "đơn vị mốc mua" (buy_unit) cho luật FOC/MKT.
 * Hỗ trợ đa package: thùng (mặc định) + các đơn vị lẻ chai/lon/can/tuýp
 * để khai báo chương trình kiểu "mua 1 chai tặng 1..." bên cạnh "mua 1 thùng".
 */
function buildBuyUnitOptionsHtml(currentValue, productUnit) {
  const cur = (currentValue || '').trim();
  const units = ['thùng'];
  for (const u of ['chai', 'lon', 'can', 'tuýp']) {
    if (!units.includes(u)) units.push(u);
  }
  const pUnit = (productUnit || '').trim();
  if (pUnit && !units.includes(pUnit)) units.push(pUnit);
  if (cur && !units.includes(cur)) units.push(cur);
  return units.map(u =>
    `<option value="${escapeHtml(u)}" ${u === cur || (!cur && u === 'thùng') ? 'selected' : ''}>${escapeHtml(u)}</option>`
  ).join('');
}

/**
 * Chuẩn hóa tên sản phẩm thành "base key" để gom nhóm package:
 * bỏ phần quy cách trong ngoặc đơn cuối tên (VD: "(1L/lon)", "(60L/phuy)").
 * VD: "Zentor Prostream TT 4T 10W50 Ester (20L/xô)" và "... (60L/phuy)" cùng 1 nhóm.
 */
function productBaseKey(name) {
  if (!name) return '';
  let base = String(name).trim();
  // Bỏ lặp các nhóm ngoặc cuối (VD: "1L (12 chai)")
  base = base.replace(/(\s*\([^)]*\))+\s*$/, '');
  return base.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/\s+/g, ' ').trim();
}

/**
 * [v1.3.5] Text tham khảo quy cách đóng thùng — TỰ SINH từ box_size (giá trị
 * user đặt ở ô Hộp/Thùng trong DB), không dùng chuỗi packaging tự nhập (dễ lệch
 * số với phép nhân). VD box_size=12, unit='chai' → "12 chai/thùng". SP bán đơn
 * chiếc (box_size=1) → chỉ hiện unit. Chuỗi packaging gốc vẫn giữ trong DB/input,
 * chỉ không dùng để hiển thị số quy cách nữa.
 */
function packagingAutoText(product) {
  if (!product) return '';
  const bs = Number(product.box_size) || 12;
  const unit = String(product.unit || '').trim();
  if (bs <= 1) return unit;
  return unit ? `${bs} ${unit}/thùng` : `${bs}/thùng`;
}

/**
 * Nhãn package hiển thị trên chip: lấy phần trong ngoặc cuối tên (VD: "1L/lon"),
 * fallback sang text quy cách TỰ SINH từ box_size, rồi đơn vị.
 */
function packageLabel(product) {
  const m = String(product.name || '').match(/\(([^)]*)\)\s*$/);
  if (m && m[1].trim()) return m[1].trim();
  const auto = packagingAutoText(product);
  if (auto) return auto;
  return String(product.unit || '').trim();
}

/**
 * Tìm các package anh em của sản phẩm (cùng tên gốc, khác quy cách đóng gói).
 * Cache per render cycle — gom nhóm toàn bộ DB một lần rồi dùng lại.
 */
function getPackageSiblings(product) {
  if (!product || !product.id) return [];
  if (!_renderCache.packageGroups) {
    const groups = new Map();
    (db.getAllProducts() || []).forEach(p => {
      if (!p || !p.name) return;
      const key = productBaseKey(p.name);
      if (!key) return;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    });
    _renderCache.packageGroups = groups;
  }
  const key = productBaseKey(product.name);
  const group = _renderCache.packageGroups.get(key) || [];
  return group.filter(p => p.id !== product.id);
}

/**
 * Hiển thị mã KV của một package, TỰ ĐỘNG phân theo quy tắc getKvCode:
 *  - SP có đóng thùng (box_size > 1, bán vừa chai lẻ vừa thùng) → 2 mã:
 *    mã gốc (chai lẻ) và mã gốc + '-1' (thùng).
 *  - SP bán lẻ đơn chiếc (xô, phuy, cái... box_size = 1) → chỉ 1 mã gốc.
 * @returns {string} text hiển thị (chưa escape), '' nếu không có mã
 */
function packageKvDisplay(product) {
  const le = db.getKvCode(product, product.unit || 'chai');
  if (!le) return '';
  const thung = db.getKvCode(product, 'thùng');
  if (thung && thung !== le) return `${le} (${product.unit || 'chai'}) / ${thung} (thùng)`;
  return le;
}

/**
 * Dựng HTML chip hiển thị mã KV của các package khác cùng sản phẩm.
 * Click chip → nhảy tới sản phẩm package đó trong giao diện hiện tại.
 */
function buildPackageSiblingsHtml(product, chipClass) {
  const siblings = getPackageSiblings(product);
  if (siblings.length === 0) return '';
  const chips = siblings.map(s => {
    const label = packageLabel(s);
    const kvDisplay = packageKvDisplay(s);
    const kv = kvDisplay ? ` · KV: ${escapeHtml(kvDisplay)}` : '';
    const boxHint = (Number(s.box_size) || 1) > 1 ? ' — mã gốc = chai lẻ, mã "-1" = thùng' : '';
    return `<button type="button" class="btn-goto-package ${chipClass || ''}" data-product-id="${escapeHtml(s.id)}"
      title="${escapeHtml(s.name)}${boxHint} — nhấn để mở package này"
      style="background:rgba(0,122,255,0.10); border:1px solid rgba(0,122,255,0.3); color:var(--accent-blue); border-radius:10px; padding:1px 8px; font-size:0.72rem; cursor:pointer; font-family:monospace;">📦 ${escapeHtml(label)}${kv}</button>`;
  }).join(' ');
  return `<div class="package-siblings-row" style="display:flex; align-items:center; flex-wrap:wrap; gap:4px; margin-top:6px; font-size:0.75rem;">
    <span style="color:var(--text-tertiary);" title="Sản phẩm này còn các quy cách đóng gói khác — mỗi package có mã KV riêng">Quy cách khác:</span>
    ${chips}
  </div>`;
}

/**
 * Dựng bộ chọn "sản phẩm tặng" cho luật FOC dạng GÕ-ĐỂ-TÌM:
 * input gõ tìm kiếm nổi bên trên + select ẩn giữ giá trị thật (logic lưu KHÔNG đổi).
 * Gợi ý lọc fuzzy theo tên/mã KV, chọn bằng click — giống tìm kiếm bên Danh mục.
 * @param {Object} [opts] tuỳ biến khi nhúng ở view khác (Catalog):
 *   - sameLabel: nhãn lựa chọn "__same__" (mặc định "Cùng loại (chính nó)")
 *   - hiddenClass/hiddenAttrs: gắn thêm lên select ẩn để delegation nơi nhúng
 *     (vd .catalog-foc-input bên Catalog) vẫn bắt được change → luồng lưu nguyên vẹn
 *   - width/inputStyle: kích thước wrapper + style ô gõ cho hợp hàng đang nhúng
 */
function buildFocGiftPickerHtml(currentValue, campaignKey, excludeProductId, opts = {}) {
  const cur = (currentValue || '').trim();
  const sameLabel = opts.sameLabel || 'Cùng loại (chính nó)';
  let displayName = sameLabel;
  if (cur && cur !== '__same__') {
    const gp = db.findProductById(cur);
    displayName = gp ? gp.name : cur;
  }
  const hiddenClass = opts.hiddenClass ? ` ${opts.hiddenClass}` : '';
  const hiddenAttrs = opts.hiddenAttrs ? ` ${opts.hiddenAttrs}` : '';
  return `<div class="foc-gift-picker" style="position:relative; width:${opts.width || '210px'};">
    <input type="text" class="input-field foc-gift-search-input" value="${escapeHtml(displayName)}" placeholder="Gõ tìm sản phẩm tặng..." autocomplete="off" style="${opts.inputStyle || 'width:100%; font-size:0.78rem;'}" title="Gõ để tìm sản phẩm tặng (theo tên hoặc mã KV) — chọn từ danh sách gợi ý" />
    <select class="foc-give-product-input${hiddenClass}"${hiddenAttrs} style="display:none;">${buildGiftProductOptionsHtml(currentValue, campaignKey, excludeProductId, sameLabel)}</select>
    <div class="foc-gift-suggestions"></div>
  </div>`;
}

/**
 * Lọc danh sách sản phẩm trong Settings Editor bằng DOM toggle (KHÔNG re-render
 * nên ô nhập liệu không mất focus). Ẩn/hiện .product-item-card theo fuzzy query.
 * @returns {{shown: number, firstCard: (Element|null)}} số card hiển thị + card khớp đầu tiên
 */
function applySettingsProductFilter(query) {
  const list = document.querySelector('.product-items-list');
  if (!list) return { shown: 0, firstCard: null };
  const normQuery = _normSearchText(query);
  let shown = 0;
  let firstCard = null;
  list.querySelectorAll('.product-item-card').forEach(card => {
    if (!normQuery) { card.style.display = ''; shown++; if (!firstCard) firstCard = card; return; }
    const nameInput = card.querySelector('.product-field-input[data-field="name"]');
    const pId = nameInput ? nameInput.getAttribute('data-product-id') : '';
    const p = db.findProductById(pId) || {};
    const hay = _normSearchText([p.name, p.spec, p.kvCode, p.category, p.packaging, p.id].join(' '));
    const ok = (typeof fuzzySearchScore === 'function') ? fuzzySearchScore(normQuery, hay) > 0 : hay.includes(normQuery);
    card.style.display = ok ? '' : 'none';
    if (ok) { shown++; if (!firstCard) firstCard = card; }
  });
  return { shown, firstCard };
}

/**
 * Cuộn card khớp đầu tiên tới ngay dưới thanh tìm kiếm sticky để TÊN sản phẩm
 * luôn hiển thị khi tìm kiếm (tránh trường hợp card bị thanh sticky che mất
 * hoặc nằm ngoài vùng nhìn). Chỉ cuộn khi cần — không giật màn hình lúc gõ.
 */
function scrollFirstMatchIntoView(container, firstCard) {
  if (!firstCard) return;
  // Scroller thực sự là .product-editor (overflow-y:auto) — toolbar sticky bám theo nó
  const scroller = container.closest('.product-editor') || container.closest('.settings-content');
  const toolbar = container.querySelector('.settings-product-toolbar');
  if (!scroller) return;
  const toolbarBottom = toolbar ? toolbar.getBoundingClientRect().bottom : scroller.getBoundingClientRect().top;
  const scrollerRect = scroller.getBoundingClientRect();
  const cardRect = firstCard.getBoundingClientRect();
  const gap = 12;
  const hiddenUnderToolbar = cardRect.top < toolbarBottom + gap;
  const belowViewport = cardRect.top > scrollerRect.bottom;
  if (hiddenUnderToolbar || belowViewport) {
    // Đặt mép trên card ngay dưới toolbar → dòng tên sản phẩm luôn lộ ra
    scroller.scrollTop += cardRect.top - toolbarBottom - gap;
  }
}

/** Tìm element theo id trong một scope (tránh trùng id khi card hiển thị ở cả Settings lẫn modal) */
function _findElInRoot(root, id) {
  const scope = root || document;
  if (scope === document) return document.getElementById(id);
  return scope.querySelector('[id="' + CSS.escape(id) + '"]');
}

/**
 * Builds <option> HTML for gift product dropdown in FOC rules.
 * Product list per campaign is cached per render cycle to avoid repeated iteration.
 */
function buildGiftProductOptionsHtml(currentValue, campaignKey, excludeProductId, sameLabel) {
  const cur = (currentValue || '').trim();
  // Cache product list per campaign (computed once per render)
  const cacheKey = '_giftItems_' + campaignKey;
  if (!_renderCache[cacheKey]) {
    const campaign = db.data.campaigns[campaignKey];
    const items = [];
    if (campaign && campaign.products) {
      for (let i = 0; i < campaign.products.length; i++) {
        const gp = campaign.products[i];
        items.push({ id: gp.id, name: gp.name, escId: escapeHtml(gp.id), escName: escapeHtml(gp.name) });
      }
    }
    _renderCache[cacheKey] = items;
  }
  const items = _renderCache[cacheKey];
  let html = `<option value="__same__" ${cur === '__same__' || cur === '' ? 'selected' : ''}>${escapeHtml(sameLabel || 'Cùng loại (chính nó)')}</option>`;
  let matchedInList = (cur === '__same__' || cur === '');
  for (let i = 0; i < items.length; i++) {
    const gp = items[i];
    if (gp.id === excludeProductId) continue;
    const sel = cur === gp.id;
    if (sel) matchedInList = true;
    html += `<option value="${gp.escId}" ${sel ? 'selected' : ''}>${gp.escName}</option>`;
  }
  if (!matchedInList && cur) {
    const gp = db.findProductById(cur);
    html += `<option value="${escapeHtml(cur)}" selected>${escapeHtml(gp ? gp.name : cur)}</option>`;
  }
  return html;
}

/**
 * Dựng cặp nút ▲/▼ đảo thứ tự dòng quà FOC/MKT trong card Danh Mục.
 * Chỉ hiện khi có ≥2 dòng; mờ + disabled ở mép (dòng đầu không lên được, dòng cuối không xuống được).
 * Thứ tự dòng chỉ để dễ đối chiếu khi nhập — calculator xét mốc theo điều kiện, không phụ thuộc vị trí.
 */
function buildRuleMoveButtonsHtml(btnClass, idxAttr, productId, idx, count) {
  if (!count || count <= 1) return '';
  const mk = (dir, disabled) => `<button type="button" class="${btnClass}" data-product-id="${escapeHtml(productId)}" ${idxAttr}="${idx}" data-dir="${dir}" title="${dir === 'up' ? 'Đưa dòng này lên trên' : 'Đưa dòng này xuống dưới'}"${disabled ? ' disabled' : ''}>${dir === 'up' ? '▲' : '▼'}</button>`;
  return mk('up', idx <= 0) + mk('down', idx >= count - 1);
}

/**
 * Drag handle cho row rule khuyến mãi trong Settings editor — kéo để đổi vị trí.
 * Row tự khai draggable="true"; listener drag delegated tại src/settings/ui.js,
 * drop di chuyển rule trong campaign.promoRules theo vị trí row đích.
 */
function buildPromoDragHandleHtml() {
  return `<span class="drag-handle" title="Kéo để đổi vị trí"><svg width="10" height="16" viewBox="0 0 10 16"><circle cx="3" cy="2" r="1.2" fill="currentColor"/><circle cx="7" cy="2" r="1.2" fill="currentColor"/><circle cx="3" cy="6" r="1.2" fill="currentColor"/><circle cx="7" cy="6" r="1.2" fill="currentColor"/><circle cx="3" cy="10" r="1.2" fill="currentColor"/><circle cx="7" cy="10" r="1.2" fill="currentColor"/><circle cx="3" cy="14" r="1.2" fill="currentColor"/><circle cx="7" cy="14" r="1.2" fill="currentColor"/></svg></span>`;
}

/**
 * Returns sorted array of all unique category values across all products.
 * Cached per render cycle.
 */
function getAllCategories() {
  if (_renderCache.categories) return _renderCache.categories;
  const cats = new Set();
  (db.getAllProducts() || []).forEach(p => {
    if (p.category && p.category.trim()) cats.add(p.category.trim());
  });
  _renderCache.categories = [...cats].sort((a, b) => a.localeCompare(b, 'vi'));
  return _renderCache.categories;
}

/**
 * Builds <datalist> HTML for category autocomplete.
 */
function buildCategoryDatalistHtml() {
  const cats = getAllCategories();
  let html = '<datalist id="categorySuggestions">';
  cats.forEach(c => { html += `<option value="${escapeHtml(c)}">`; });
  html += '</datalist>';
  return html;
}

function showToast(message, type = 'info', action = null) {
  // Get or create toast container
  let toastContainer = document.querySelector('.toast-container');
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container';
    document.body.appendChild(toastContainer);
  }
  // Also try the static one from HTML
  const staticContainer = document.getElementById('toastContainer');
  const container = staticContainer || toastContainer;
  
  const icons = { success: '✔️', error: '❌', info: 'ℹ️', warning: '⚠️' };
  const icon = icons[type] || icons.info;
  // Toast dài (có xuống dòng hoặc > 80 ký tự) cần thời gian đọc lâu hơn mặc định
  const isLongMessage = typeof message === 'string' && (message.includes('\n') || message.length > 80);
  const duration = isLongMessage ? 8000 : (type === 'error' ? 5000 : 3000);
  
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  // Icon element
  const iconEl = document.createElement('span');
  iconEl.className = 'toast-icon';
  iconEl.textContent = icon;
  toast.appendChild(iconEl);
  
  // Message element
  const textEl = document.createElement('span');
  textEl.className = 'toast-text';
  textEl.style.whiteSpace = 'pre-line';
  textEl.textContent = message;
  toast.appendChild(textEl);
  
  // Close button element
  const closeBtn = document.createElement('button');
  closeBtn.className = 'toast-close';
  closeBtn.innerHTML = '&times;';
  closeBtn.setAttribute('aria-label', 'Đóng thông báo');
  
  let autoCloseTimeout;
  
  const dismiss = () => {
    if (toast.classList.contains('hide')) return;
    if (autoCloseTimeout) clearTimeout(autoCloseTimeout);
    toast.classList.add('hide');
    toast.addEventListener('animationend', () => toast.remove());
    // Fallback if animationend is not supported or fails
    setTimeout(() => {
      if (toast.parentNode) toast.remove();
    }, 500);
  };
  
  closeBtn.addEventListener('click', dismiss);

  // Optional action button (e.g. Hoàn tác)
  if (action && action.label && typeof action.handler === 'function') {
    const actionBtn = document.createElement('button');
    actionBtn.className = 'toast-action';
    actionBtn.textContent = action.label;
    actionBtn.style.cssText = 'margin-left:8px;background:transparent;border:1px solid currentColor;border-radius:4px;padding:2px 8px;cursor:pointer;color:inherit;font-size:0.85em;';
    actionBtn.addEventListener('click', () => {
      try { action.handler(); } finally { dismiss(); }
    });
    toast.appendChild(actionBtn);
  }

  toast.appendChild(closeBtn);
  
  container.appendChild(toast);
  
  // Trigger entry animation
  requestAnimationFrame(() => toast.classList.add('show'));
  
  // Auto-dismiss based on type duration
  autoCloseTimeout = setTimeout(dismiss, duration);
}

// --- Parse Helpers ---

/** Suy luận đơn vị quà MKT từ tên quà tặng */
function inferMKTGiftUnit(name) {
  let unit = 'cái';
  const cleanName = (name || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');

  if (cleanName.includes('ao mua') || cleanName.includes('raincoat')) unit = 'áo mưa';
  else if (cleanName.includes('tui') || cleanName.includes('balo') || cleanName.includes('string bag') || cleanName.includes('stringbag') || cleanName.includes('bag')) unit = 'túi';
  else if (cleanName.includes('non') || cleanName.includes('mu') || cleanName.includes('cap') || cleanName.includes('helmet')) unit = 'nón';
  else if (cleanName.includes('sticker')) unit = 'sticker';
  else if (cleanName.includes('moc khoa') || cleanName.includes('keyring') || cleanName.includes('keychain')) unit = 'cái';
  else if (cleanName.includes('xit') || cleanName.includes('spray')) unit = 'bình';
  else if (/\bao\b/.test(cleanName) || cleanName.includes('polo')) unit = 'áo';
  return unit;
}

function parseMKTGiftString(giftStr) {
  if (!giftStr) return [];
  const parts = giftStr.split('+').map(p => p.trim());
  const gifts = [];
  parts.forEach(part => {
    const match = part.match(/^(\d+)\s+(.+)$/);
    if (match) {
      const qty = parseInt(match[1]);
      const name = match[2].trim();
      gifts.push({ qty, name, unit: inferMKTGiftUnit(name) });
    } else {
      gifts.push({ qty: 1, name: part, unit: 'cái' });
    }
  });
  return gifts;
}

/** Bỏ dấu + lowercase để so khớp tên quà ↔ sản phẩm danh mục */
function _normForGiftMatch(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').trim();
}

/**
 * Tự liên kết tên quà (chưa có product_id) với sản phẩm THẬT trong danh mục.
 * Ưu tiên sản phẩm spec "Quà tặng"; chỉ gắn khi tìm ra ĐÚNG 1 ứng viên duy nhất
 * (tên mơ hồ như "túi canvas hoặc 1 nón" → KHÔNG gắn, tránh gán nhầm món).
 * @param {string} name - tên quà cần dò
 * @param {Array} [products] - danh sách sản phẩm (truyền vào để tránh gọi getAllProducts nhiều lần)
 */
function resolveMktGiftProductId(name, products) {
  const n = _normForGiftMatch(name);
  if (!n) return '';
  const all = products || ((typeof db !== 'undefined' && db.getAllProducts) ? db.getAllProducts() : []);
  // Tên ghép nhiều món ("...hoặc...", có "+") thì không bao giờ gắn vào 1 sản phẩm duy nhất
  if (/\b(hoac|hoặc)\b/.test(n) || n.includes('+')) return '';
  // Ưu tiên khớp XUÔI (tên SP chứa tên quà) — chặt chẽ hơn khớp ngược
  const forward = all.filter(p => _normForGiftMatch(p.name).includes(n));
  const giftFwd = forward.filter(p => _normForGiftMatch((p.category||'') + ' ' + (p.spec||'')).includes('qua tang'));
  if (giftFwd.length === 1) return giftFwd[0].id;
  if (giftFwd.length === 0 && forward.length === 1) return forward[0].id;
  // Fallback khớp ngược: chỉ khi đúng 1 sản phẩm quà tặng có tên nằm trong tên quà
  const reverse = all.filter(p => {
    const pn = _normForGiftMatch(p.name);
    return pn && n.includes(pn) && _normForGiftMatch((p.category||'') + ' ' + (p.spec||'')).includes('qua tang');
  });
  if (reverse.length === 1) return reverse[0].id;
  return '';
}

/**
 * Chuẩn hóa danh sách quà của mốc MKT về dạng cấu trúc [{ qty, name, product_id }].
 * Ưu tiên mảng gift_items mới; nếu chưa có thì parse ngược chuỗi gifts cũ
 * (tương thích dữ liệu legacy "20 Sticker + 8 Móc khóa + ...").
 * NGUYÊN TẮC ĐỒNG NHẤT: quà đã liên kết sản phẩm thì tên quà = ĐÚNG tên hiển thị
 * của sản phẩm đó trong Danh Mục Sản Phẩm (p.name) — danh mục là nguồn chuẩn duy nhất,
 * muốn đổi tên thì sửa tên sản phẩm trong danh mục, không dùng lớp tên trung gian.
 */
function normalizeMktGiftItems(rule) {
  if (!rule) return [];
  const all = (typeof db !== 'undefined' && db.getAllProducts) ? db.getAllProducts() : [];
  const byId = new Map(all.map(p => [p.id, p]));
  // Item ĐÃ lưu trong gift_items: GIỮ nguyên product_id đã lưu (kể cả rỗng) —
  // KHÔNG tự dò liên kết ngầm; chỉ chuẩn hóa tên theo danh mục nếu ĐÃ có product_id.
  const toItemStored = (qty, rawName, productId, extra) => {
    const cleanName = String(rawName || '').trim();
    const pid = productId || '';
    const linked = pid ? byId.get(pid) : null;
    // Đã gắn sản phẩm CÒN trong danh mục → tên THEO DANH MỤC;
    // product_id mồ côi (SP đã xóa) → trả '' để TỰ LÀM SẠCH ở lần chuẩn hóa kế tiếp
    // (nhất quán UI: badge ⚠, ô editable); giữ nguyên tên đã lưu
    const item = {
      qty: parseInt(qty) || 1,
      name: linked ? linked.name : cleanName,
      product_id: linked ? pid : ''
    };
    // Giữ nguyên cấu hình "1 trong N quà" đã lưu (nếu có) — để luồng lên đơn
    // và UI Settings đọc được options sau mỗi lần chuẩn hóa gift_items
    if (extra && Array.isArray(extra.give_product_options) && extra.give_product_options.length > 0) {
      item.give_product_options = extra.give_product_options.slice();
      if (extra.give_product_sub_options) item.give_product_sub_options = extra.give_product_sub_options;
    }
    return item;
  };
  // Nhánh parse legacy (chuỗi gifts cũ): dò liên kết 1 lần duy nhất tại đây
  const toItemLegacy = (qty, rawName) => {
    const cleanName = String(rawName || '').trim();
    const pid = resolveMktGiftProductId(cleanName, all);
    const linked = pid ? byId.get(pid) : null;
    return {
      qty: parseInt(qty) || 1,
      name: linked ? linked.name : cleanName,
      product_id: pid
    };
  };
  if (Array.isArray(rule.gifts)) {
    return rule.gifts.map(g => {
      const pid = g.productId || g.product_id || '';
      const linked = pid ? byId.get(pid) : null;
      return toItemStored(g.qty, linked ? linked.name : (g.name || ''), pid, {
        give_product_options: g.options || g.give_product_options,
        give_product_sub_options: g.subOptions || g.give_product_sub_options
      });
    });
  }
  if (Array.isArray(rule.gift_items)) {
    return rule.gift_items.map(g => toItemStored(g.qty, g.name, g.product_id, g));
  }
  return parseMKTGiftString(rule.gifts).map(g => toItemLegacy(g.qty, g.name));
}

/** Dựng lại chuỗi tóm tắt gifts (tương thích ngược) từ danh sách quà cấu trúc */
function buildMktGiftsString(items) {
  return (items || []).filter(g => g.name).map(g => `${g.qty} ${g.name}`).join(' + ');
}

/**
 * [Promo v1.3.0] Chuyển danh sách quà ĐÃ CHUẨN HÓA (normalizeMktGiftItems:
 * {qty, name, product_id, give_product_options...}) NGƯỢC lại schema cấu trúc
 * rule.gifts (productId) — thay thế buildMktGiftsString ở luồng GHI vì chuỗi legacy
 * làm MẤT liên kết productId người dùng đã chọn (badge ⚠ Chưa liên kết + mất mã KV
 * khi lên đơn). GIỮ NGUYÊN thông tin user nhập: unit / options / subOptions
 * (orig = rule.gifts gốc, merge theo index).
 */
function structuredGiftsFromItems(items, orig) {
  const src = Array.isArray(orig) ? orig : [];
  return (items || []).map((g, i) => {
    const o = (src[i] && typeof src[i] === 'object') ? src[i] : {};
    const out = { qty: g.qty, productId: g.product_id || '', name: g.name || '' };
    if (o.unit) out.unit = o.unit;
    if (Array.isArray(g.give_product_options) && g.give_product_options.length) {
      out.options = g.give_product_options;
      if (g.give_product_sub_options) out.subOptions = g.give_product_sub_options;
    }
    return out;
  });
}

/**
 * ============================================================================
 *  QUÀ TẶNG "1 TRONG N" — cấu hình give_product_options / give_product_sub_options
 * ============================================================================
 *  Một rule FOC/MKT có thể khai báo NHIỀU quà tặng để sales CHỌN 1 khi lên đơn.
 *  Tầng chọn quà lúc lên đơn (nút nhóm/size trong bảng đơn) ĐÃ CÓ SẴN — phần này
 *  bổ sung UI CẤU HÌNH dùng chung + helper tự gộp size anh em (áo S/M/L/XL...).
 */

const _SIZE_SUFFIX_RE = /^(.+)_size_(s|m|l|xl|xxl)$/;
const _SIZE_ORDER = { s: 0, m: 1, l: 2, xl: 3, xxl: 4 };

/**
 * Tìm các sản phẩm "size anh em" của một sản phẩm (id dạng ..._size_s/m/l/xl/xxl).
 * Trả về mảng sản phẩm sắp theo S→M→L→XL→XXL, hoặc null nếu không có/không đủ anh em.
 */
function findSizeSiblings(productId) {
  const m = String(productId || '').match(_SIZE_SUFFIX_RE);
  if (!m) return null;
  const prefix = m[1];
  const all = (typeof db !== 'undefined' && db.getAllProducts) ? db.getAllProducts() : [];
  const siblings = [];
  all.forEach(p => {
    const sm = String(p.id || '').match(_SIZE_SUFFIX_RE);
    if (sm && sm[1] === prefix) siblings.push({ p, order: _SIZE_ORDER[sm[2]] });
  });
  if (siblings.length <= 1) return null;
  siblings.sort((a, b) => a.order - b.order);
  return siblings.map(s => s.p);
}

/**
 * Modal dùng chung cấu hình "tặng 1 trong N quà" cho rule FOC/MKT (3 mặt:
 * quà MKT theo SP, FOC theo SP, quà MKT thương hiệu).
 *  - Tìm + chọn sản phẩm TỪ DANH MỤC (không gõ tên tự do — quà cần mã KV).
 *  - Sản phẩm có size anh em (..._size_s/m/l...) → TỰ GỘP thành nhóm chọn 2 tầng,
 *    đúng cấu trúc give_product_sub_options của dữ liệu đang có.
 *  - onSaved(null) khi người dùng bỏ chọn nhiều quà;
 *    onSaved({ options, subOptions }) khi lưu.
 */
function openGiftOptionsEditor({ title, subtitle, currentOptions, currentSubOptions, onSaved }) {
  // Chỉ 1 modal options mở tại một thời điểm
  const existing = document.querySelector('.gift-options-overlay');
  if (existing) existing.remove();

  // Quy đổi dữ liệu hiện có về dạng entry [{ id, subs }]
  const entries = [];
  (currentOptions || []).forEach(optId => {
    const subs = (currentSubOptions && Array.isArray(currentSubOptions[optId]) && currentSubOptions[optId].length > 1)
      ? currentSubOptions[optId].slice() : null;
    entries.push({ id: optId, subs });
  });
  const hadInitial = entries.length > 0;

  const overlay = document.createElement('div');
  overlay.className = 'gift-options-overlay';
  overlay.innerHTML = `<div class="gift-options-modal" role="dialog" aria-modal="true" aria-label="Cấu hình quà tặng 1 trong N">
    <div class="gift-options-header">
      <div>
        <div class="gift-options-title">🎯 Tặng 1 trong nhiều quà</div>
        <div class="gift-options-subtitle">${escapeHtml(subtitle || title || 'Chọn các quà tặng thay thế — khi lên đơn sales sẽ bấm chọn 1')}</div>
      </div>
      <button type="button" class="btn btn-ghost btn-sm gift-options-close" title="Đóng (Esc)">✕</button>
    </div>
    <div class="gift-options-body">
      <div class="gift-options-selected-wrap">
        <div class="gift-options-section-title">🎁 Quà đã chọn (<span class="gift-options-selected-count">0</span>) — món ① là quà mặc định khi lên đơn</div>
        <div class="gift-options-chips"></div>
      </div>
      <div class="gift-options-search-wrap">
        <div class="gift-options-section-title">➕ Thêm quà thay thế — gõ tên sản phẩm trong danh mục</div>
        <input type="text" class="input-field gift-options-search" placeholder="Gõ tên sản phẩm (vd: nón, polo) rồi chọn từ gợi ý..." autocomplete="off" spellcheck="false" />
        <div class="gift-options-suggestions"></div>
      </div>
      <div class="gift-options-chips-hint">Sản phẩm có size sẽ tự gộp thành bộ chọn size · cần ít nhất 2 quà để tạo nhóm "1 trong N"</div>
    </div>
    <div class="gift-options-footer">
      <button type="button" class="btn btn-ghost btn-sm gift-options-clear" style="display:none;">🗑 Bỏ chọn nhiều quà</button>
      <span style="flex:1"></span>
      <button type="button" class="btn btn-ghost btn-sm gift-options-cancel">Hủy</button>
      <button type="button" class="btn btn-success btn-sm gift-options-save">✓ Lưu</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  const searchInput = overlay.querySelector('.gift-options-search');
  const suggBox = overlay.querySelector('.gift-options-suggestions');
  const chipsBox = overlay.querySelector('.gift-options-chips');
  const clearBtn = overlay.querySelector('.gift-options-clear');
  const saveBtn = overlay.querySelector('.gift-options-save');

  function chipLabel(entry) {
    const p = db.findProductById(entry.id);
    const name = p ? p.name : entry.id;
    const sizeNote = (entry.subs && entry.subs.length > 1) ? ` · nhóm ${entry.subs.length} size` : '';
    return escapeHtml(name) + escapeHtml(sizeNote);
  }

  function renderChips() {
    if (!entries.length) {
      chipsBox.innerHTML = '<span class="gift-options-empty">Chưa chọn quà nào — gõ tìm ở ô trên để thêm</span>';
    } else {
      chipsBox.innerHTML = entries.map((e, i) => `<div class="gift-option-chip${i === 0 ? ' gift-option-default' : ''}" data-chip-idx="${i}">
        <span class="gift-option-chip-label" title="${i === 0 ? 'Quà mặc định khi lên đơn' : 'Lựa chọn thay thế'}">${i === 0 ? '① ' : ''}${chipLabel(e)}</span>
        <button type="button" class="gift-option-chip-btn chip-move-left" data-chip-idx="${i}" title="Chuyển sang trái" ${i === 0 ? 'disabled' : ''}>◀</button>
        <button type="button" class="gift-option-chip-btn chip-move-right" data-chip-idx="${i}" title="Chuyển sang phải" ${i === entries.length - 1 ? 'disabled' : ''}>▶</button>
        <button type="button" class="gift-option-chip-btn chip-remove" data-chip-idx="${i}" title="Xóa khỏi danh sách">✕</button>
      </div>`).join('');
    }
    clearBtn.style.display = (hadInitial || entries.length) ? '' : 'none';
  }

  function renderSuggestions() {
    const norm = _normSearchText(searchInput.value);
    const all = db.getAllProducts();
    const fuzzy = (typeof window !== 'undefined' && typeof window.fuzzySearchScore === 'function') ? window.fuzzySearchScore : null;
    const scored = [];
    all.forEach(p => {
      const searchText = _normSearchText(p.name + ' ' + (p.kvCode || '') + ' ' + (p.spec || '') + ' ' + (p.category || '') + ' ' + (p.campaignName || ''));
      let score;
      if (!norm) score = 1;
      else if (fuzzy) { score = fuzzy(norm, searchText); if (score <= 0) return; }
      else if (searchText.includes(norm)) score = 1;
      else return;
      // Quà tặng (spec chứa "Quà tặng") nổi lên trước
      if (_normSearchText(p.spec || '').includes('qua tang')) score += 100;
      scored.push({ p, score });
    });
    scored.sort((a, b) => b.score - a.score);
    const opts = scored.slice(0, 40);
    if (!opts.length) {
      suggBox.innerHTML = '<div class="gift-options-suggestion-empty">Không tìm thấy sản phẩm nào khớp từ khóa</div>';
    } else {
      suggBox.innerHTML = opts.map(({ p }) => {
        const siblings = findSizeSiblings(p.id);
        const sizeHint = siblings ? ` · tự gộp ${siblings.length} size` : '';
        const hint = [p.kvCode, p.campaignName].filter(Boolean).join(' · ') + sizeHint;
        return `<div class="gift-options-suggestion-item" data-product-id="${escapeHtml(p.id)}">🎁 ${escapeHtml(p.name)}${hint ? `<span class="gift-options-suggestion-hint">${escapeHtml(hint)}</span>` : ''}</div>`;
      }).join('');
    }
    suggBox.style.display = 'block';
  }

  function addProduct(productId) {
    if (!productId) return;
    if (entries.some(e => e.id === productId || (e.subs && e.subs.includes(productId)))) {
      showToast('Sản phẩm này đã có trong danh sách quà!', 'info');
      return;
    }
    const siblings = findSizeSiblings(productId);
    if (siblings) {
      entries.push({ id: productId, subs: siblings.map(s => s.id) });
      const rep = db.findProductById(productId);
      showToast(`Đã thêm nhóm "${rep ? rep.name : productId}" — tự gộp ${siblings.length} size`, 'success');
    } else {
      entries.push({ id: productId });
      const rep = db.findProductById(productId);
      showToast(`Đã thêm "${rep ? rep.name : productId}"`, 'success');
    }
    renderChips();
  }

  function onKeydown(e) { if (e.key === 'Escape') close(); }
  function close() {
    document.removeEventListener('keydown', onKeydown);
    overlay.remove();
  }
  document.addEventListener('keydown', onKeydown);

  overlay.querySelector('.gift-options-close').addEventListener('click', close);
  overlay.querySelector('.gift-options-cancel').addEventListener('click', close);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });

  searchInput.addEventListener('input', renderSuggestions);
  searchInput.addEventListener('focus', renderSuggestions);

  // mousedown + preventDefault: chọn gợi ý không làm mất focus ô gõ
  suggBox.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.gift-options-suggestion-item');
    if (!item) return;
    e.preventDefault();
    addProduct(item.getAttribute('data-product-id'));
    searchInput.value = '';
    renderSuggestions();
    searchInput.focus();
  });

  chipsBox.addEventListener('click', (e) => {
    const btn = e.target.closest('.gift-option-chip-btn');
    if (!btn) return;
    const i = parseInt(btn.getAttribute('data-chip-idx'));
    if (btn.classList.contains('chip-remove')) {
      entries.splice(i, 1);
    } else if (btn.classList.contains('chip-move-left') && i > 0) {
      [entries[i - 1], entries[i]] = [entries[i], entries[i - 1]];
    } else if (btn.classList.contains('chip-move-right') && i < entries.length - 1) {
      [entries[i + 1], entries[i]] = [entries[i], entries[i + 1]];
    } else {
      return;
    }
    renderChips();
  });

  clearBtn.addEventListener('click', () => {
    close();
    if (typeof onSaved === 'function') onSaved(null);
  });

  saveBtn.addEventListener('click', () => {
    if (entries.length < 2) {
      showToast('Cần ít nhất 2 quà để tạo lựa chọn "1 trong N"!', 'warning');
      return;
    }
    const options = entries.map(e => e.id);
    const subOptions = {};
    entries.forEach(e => { if (e.subs && e.subs.length > 1) subOptions[e.id] = e.subs; });
    close();
    if (typeof onSaved === 'function') onSaved({ options, subOptions });
  });

  renderChips();
  renderSuggestions();
  searchInput.focus();
}


/**
 * Popup "thêm nhanh 1 quà thay thế" vào nhóm '1 trong N' của rule — neo tại nút bấm.
 * rule được MUTATE trực tiếp (give_product_options / give_product_sub_options);
 * caller tự persist + re-render trong onAdded(addedProduct).
 * seedId: quà mặc định hiện tại — giữ làm lựa chọn đầu khi rule chưa có options.
 * Chỉ chọn được SP CÓ TRONG DANH MỤC; gõ tên lạ → toast "Sản phẩm chưa có trong danh mục".
 */
function openQuickGiftAdd(anchorBtn, rule, { seedId = null, onAdded } = {}) {
  if (!rule) return;
  document.querySelectorAll('.quick-gift-add-popup').forEach(el => el.remove());

  const popup = document.createElement('div');
  popup.className = 'quick-gift-add-popup';
  popup.innerHTML = `
    <div class="quick-gift-add-title">➕ Thêm quà thay thế vào nhóm "1 trong N"</div>
    <input type="text" class="input-field quick-gift-add-search" placeholder="Gõ tìm sản phẩm trong danh mục..." autocomplete="off" spellcheck="false" />
    <div class="quick-gift-add-suggestions"></div>`;
  document.body.appendChild(popup);
  const rect = anchorBtn.getBoundingClientRect();
  popup.style.top = Math.min(rect.bottom + 4, Math.max(8, window.innerHeight - 320)) + 'px';
  popup.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 340)) + 'px';

  const input = popup.querySelector('.quick-gift-add-search');
  const suggBox = popup.querySelector('.quick-gift-add-suggestions');
  let lastOpts = [];

  function collectMatches() {
    const norm = _normSearchText(input.value);
    const all = (typeof db !== 'undefined' && db.getAllProducts) ? db.getAllProducts() : [];
    const fuzzy = (typeof window !== 'undefined' && typeof window.fuzzySearchScore === 'function') ? window.fuzzySearchScore : null;
    const scored = [];
    all.forEach(p => {
      const searchText = _normSearchText(p.name + ' ' + (p.kvCode || '') + ' ' + (p.spec || '') + ' ' + (p.category || '') + ' ' + (p.campaignName || ''));
      let score;
      if (!norm) score = 1;
      else if (fuzzy) { score = fuzzy(norm, searchText); if (score <= 0) return; }
      else if (searchText.includes(norm)) score = 1;
      else return;
      if (_normSearchText(p.spec || '').includes('qua tang')) score += 100;
      scored.push({ p, score });
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 30).map(s => s.p);
  }

  function render() {
    lastOpts = collectMatches();
    if (!input.value.trim()) {
      suggBox.innerHTML = '<div class="quick-gift-add-empty">Gõ tên sản phẩm để tìm trong danh mục</div>';
    } else if (!lastOpts.length) {
      suggBox.innerHTML = '<div class="quick-gift-add-empty">Sản phẩm chưa có trong danh mục</div>';
    } else {
      suggBox.innerHTML = lastOpts.map(p => {
        const siblings = findSizeSiblings(p.id);
        const hint = [p.kvCode, p.campaignName].filter(Boolean).join(' · ') + (siblings ? ` · gộp ${siblings.length} size` : '');
        return `<div class="quick-gift-add-item" data-product-id="${escapeHtml(p.id)}">${escapeHtml(p.name)}${hint ? `<span class="quick-gift-add-hint">${escapeHtml(hint)}</span>` : ''}</div>`;
      }).join('');
    }
  }

  function addProduct(productId) {
    const prod = db.findProductById(productId);
    if (!prod) return;
    const subs = rule.give_product_sub_options || {};
    const already = (Array.isArray(rule.give_product_options) && rule.give_product_options.includes(productId))
      || Object.values(subs).some(arr => Array.isArray(arr) && arr.includes(productId));
    if (already) {
      showToast('Sản phẩm này đã có trong nhóm quà!', 'info');
      return;
    }
    let opts = Array.isArray(rule.give_product_options) ? rule.give_product_options.slice() : [];
    if (!opts.length && seedId && seedId !== '__same__') opts.push(seedId);
    const siblings = findSizeSiblings(productId);
    if (siblings) {
      rule.give_product_sub_options = { ...subs, [productId]: siblings.map(s => s.id) };
      showToast(`Đã thêm nhóm "${prod.name}" — tự gộp ${siblings.length} size`, 'success');
    } else {
      showToast(`Đã thêm "${prod.name}" vào nhóm quà`, 'success');
    }
    opts.push(productId);
    rule.give_product_options = opts;
    close();
    if (typeof onAdded === 'function') onAdded(prod);
  }

  function close() {
    document.removeEventListener('mousedown', onDocMouseDown, true);
    document.removeEventListener('keydown', onKeyDown);
    popup.remove();
  }
  function onKeyDown(e) {
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (lastOpts.length >= 1) addProduct(lastOpts[0].id);
      else if (input.value.trim()) showToast('Sản phẩm chưa có trong danh mục', 'warning');
    }
  }
  function onDocMouseDown(e) { if (!popup.contains(e.target) && e.target !== anchorBtn) close(); }

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('mousedown', onDocMouseDown, true);
  input.addEventListener('input', render);
  suggBox.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.quick-gift-add-item');
    if (!item) return;
    e.preventDefault();
    addProduct(item.getAttribute('data-product-id'));
  });

  render();
  input.focus();
}

// [Promo v1.3.0] Adapter ĐỌC: rule promoRules → shape cũ để các builder HTML
// của editor catalog/editor sâu không cần viết lại (chỉ ĐỌC; ghi thật vẫn vào promoRules).
function _legacyQtyRule(r) {
  const gift = (Array.isArray(r.gifts) && r.gifts[0]) || {};
  return {
    ...r,
    buy_qty: (r.buy && r.buy.qty) || 1,
    buy_unit: (r.buy && r.buy.unit) || '',
    give_qty: gift.qty || 1,
    give_unit: gift.unit || '',
    give_product: gift.productId || '',
    give_product_name: gift.name || '',
    give_product_options: gift.options || null,
    give_product_sub_options: gift.subOptions || null,
  };
}

/** Rule mua-X-tặng-Y của 1 sản phẩm (campaign.promoRules type 'qty', theo kind). */
function _productPromoRules(productId, kind) {
  return (db.getPromoRulesForProduct(productId) || []).filter(r => r.type === 'qty' && (!kind || r.kind === kind));
}

/**
 * Truy ngược rule FOC GỐC trong campaign.promoRules (type 'qty', kind 'foc') từ
 * entry của getFOCForQty (entry là bản copy {...rule}) — ưu tiên theo ruleId, fallback
 * đối chiếu các trường mô tả mốc để lấy đúng REF phục vụ ghi options.
 */
function _matchFocSourceRule(product, entry) {
  const rules = (product && product.id) ? _productPromoRules(product.id, 'foc') : [];
  if (entry && entry.ruleId) {
    const byId = rules.find(r => r.id === entry.ruleId);
    if (byId) return byId;
  }
  return rules.find(r =>
    (r.buy && r.buy.qty) === entry.buy_qty &&
    ((r.buy && r.buy.unit) || '') === (entry.buy_unit || '') &&
    r.gifts && r.gifts[0] && r.gifts[0].qty === entry.give_qty &&
    (r.gifts[0].unit || '') === (entry.give_unit || '') &&
    (r.note || '') === (entry.note || '')
  ) || null;
}

/** Tooltip cho nút "🎯 N quà để chọn" — liệt kê TÊN các quà đang có trong nhóm
 * để người setup không phải bấm vào mới biết nhóm gồm những món nào. */
function _giftOptionsBtnTitle(rule) {
  const opts = (rule && (Array.isArray(rule.give_product_options) ? rule.give_product_options : (Array.isArray(rule.gifts) && rule.gifts[0] && rule.gifts[0].options))) || [];
  if (opts.length < 2) return 'Cấu hình tặng 1 trong nhiều quà — khi lên đơn sales sẽ bấm chọn 1';
  const names = opts.map(id => {
    const p = db.findProductById(id);
    return p ? p.name : id;
  });
  return `Nhóm đang có ${opts.length} quà: ${names.join(' · ')} — khi lên đơn sales bấm chọn 1, món đầu là mặc định`;
}

/**
 * Dựng HTML 1 dòng quà MKT theo sản phẩm trong trình chỉnh sửa sâu
 * (dùng chung cho buildProductCardHtml và renderMktRulesForProduct).
 */
function _buildProductMktRowHtml(p, m, mktIdx) {
  const linkedGift = m.give_product ? db.findProductById(m.give_product) : null;
  const giftDisplay = linkedGift ? linkedGift.name : (m.give_product_name || m.give_product || '');
  const linkedGiftCode = linkedGift ? (db.getKvCode(linkedGift) || linkedGift.kvCode || '') : '';
  const linkBadge = linkedGift
    ? `<span class="mkt-gift-link-badge mkt-gift-linked" title="Đã liên kết sản phẩm trong danh mục: ${escapeHtml(linkedGift.name)}">✓${linkedGiftCode ? ' ' + escapeHtml(linkedGiftCode) : ''}</span>`
    : `<span class="mkt-gift-link-badge mkt-gift-unlinked" title="Chưa gắn với sản phẩm nào trong danh mục — gõ tìm và chọn 1 sản phẩm từ gợi ý">⚠ Chưa liên kết</span>`;
  const optCount = (m.give_product_options || []).length;
  return `<div class="product-mkt-row promo-rule-draggable" data-product-id="${p.id}" data-mkt-idx="${mktIdx}" draggable="true" style="display:flex; align-items:center; flex-wrap:wrap; gap:6px; margin-top:6px; padding:6px; background:rgba(255,152,0,0.06); border:1px solid rgba(255,152,0,0.22); border-radius:6px;">
    ${buildPromoDragHandleHtml()}
    <span style="font-size:0.82rem;color:var(--text-secondary)">Mua</span>
    <input type="number" value="${m.buy_qty}" class="product-mkt-input" data-field="buy_qty" style="width:60px;" title="Số lượng mua để đạt mốc" />
    <select class="product-mkt-input" data-field="buy_unit" style="width:70px;" title="Đơn vị tính mốc mua — thùng hoặc đơn vị lẻ">${buildBuyUnitOptionsHtml(m.buy_unit, p.unit)}</select>
    <span style="font-size:0.82rem;color:var(--text-secondary)">Tặng</span>
    <input type="number" value="${m.give_qty}" class="product-mkt-input" data-field="give_qty" style="width:60px;" title="Số lượng tặng" />
    <select class="product-mkt-input" data-field="give_unit" style="width:90px;" title="Đơn vị tặng">${buildUnitOptionsHtml(m.give_unit || 'cái')}</select>
    <div class="product-mkt-gift-picker" style="position:relative; flex:1; min-width:160px; max-width:280px;">
      <input type="text" value="${escapeHtml(giftDisplay)}" class="product-mkt-gift-name" placeholder="Gõ tìm quà trong danh mục..." autocomplete="off" spellcheck="false" title="Gõ để tìm sản phẩm trong danh mục — chọn 1 món để liên kết mã KV" style="width:100%;" />
      <div class="mkt-gift-suggestions"></div>
    </div>
    ${linkBadge}
    <button class="btn btn-ghost btn-xs btn-product-mkt-options" data-product-id="${p.id}" data-mkt-idx="${mktIdx}" title="Cấu hình tặng 1 trong nhiều quà — khi lên đơn sales sẽ bấm chọn 1" style="${optCount > 1 ? 'font-weight:700; color:#ff9800;' : ''}">${optCount > 1 ? `🎯 ${optCount} quà để chọn` : '🎯 1 trong N'}</button>
    <button class="btn btn-ghost btn-xs btn-product-mkt-quickadd" data-product-id="${p.id}" data-mkt-idx="${mktIdx}" title="Thêm nhanh 1 quà thay thế vào nhóm chọn 1 trong N">➕</button>
    <input type="text" value="${escapeHtml(m.note || '')}" placeholder="Ghi chú" class="product-mkt-input" data-field="note" style="flex:1; min-width:90px;" />
    <button class="btn btn-ghost btn-sm btn-remove-product-mkt" data-product-id="${p.id}" data-mkt-idx="${mktIdx}" title="Xóa quà MKT này">✕</button>
  </div>`;
}

/**
 * Dựng HTML toàn bộ vùng mốc quà MKT của một thương hiệu — dùng chung cho
 * renderSettingsEditor (render lần đầu) và renderMktRulesForCampaign (partial re-render).
 * Dòng quà sinh ra TỪ DỮ LIỆU: có product_id → ô tên readonly + nút "Hủy liên kết";
 * chưa có → ô tên gõ tìm + huy hiệu ⚠.
 */
function _buildMktRulesHtml(campaignKey) {
  const campaign = db.data.campaigns[campaignKey];
  if (!campaign) return '';
  // [Promo v1.3.0] Đọc rule type 'total' scope 'campaign' từ promoRules
  const promoTotalRules = (campaign.promoRules || []).filter(r => r && r.type === 'total' && r.scope === 'campaign');
  const allProductsForLink = db.getAllProducts();

  let mktRulesHtml = '';
  promoTotalRules.forEach((r, idx) => {
    const items = normalizeMktGiftItems(r);
    let giftItemsHtml = '';
    items.forEach((g, gIdx) => {
      // Huy hiệu liên kết: ✓ mã KV khi quà đã gắn đúng sản phẩm danh mục, ⚠ khi chưa
      const linkedProduct = g.product_id ? allProductsForLink.find(p => p.id === g.product_id) : null;
      const linkedProductCode = linkedProduct ? (db.getKvCode(linkedProduct) || linkedProduct.kvCode || '') : '';
      const linkBadge = linkedProduct
        ? `<span class="mkt-gift-link-badge mkt-gift-linked" title="Đã liên kết sản phẩm trong danh mục: ${escapeHtml(linkedProduct.name)}">✓${linkedProductCode ? ' ' + escapeHtml(linkedProductCode) : ''}</span>`
        : `<span class="mkt-gift-link-badge mkt-gift-unlinked" title="Chưa gắn với sản phẩm nào trong danh mục — bấm vào ô tên và chọn 1 sản phẩm cụ thể từ danh sách">⚠ Chưa liên kết</span>`;
      // Đã liên kết → khóa ô tên (tên theo danh mục) + nút hủy liên kết
      const unlinkBtn = linkedProduct
        ? `<button class="btn btn-ghost btn-xs btn-unlink-mkt-gift" title="Hủy liên kết sản phẩm này — ô tên sẽ mở lại để chọn món khác">⛓ Hủy liên kết</button>`
        : '';
      // Nút cấu hình "tặng 1 trong N quà" cho riêng quà này
      const _gOptCount = (g.give_product_options || []).length;
      const giftOptBtn = `<button class="btn btn-ghost btn-xs btn-mkt-gift-item-options" data-gift-idx="${gIdx}" title="Cấu hình tặng 1 trong nhiều quà — khi lên đơn sales sẽ bấm chọn 1" style="${_gOptCount > 1 ? 'font-weight:700; color:var(--accent-green);' : ''}">${_gOptCount > 1 ? `🎯 ${_gOptCount} quà để chọn` : '🎯 1 trong N'}</button>`;
      const giftQuickAddBtn = `<button class="btn btn-ghost btn-xs btn-mkt-gift-item-quickadd" data-gift-idx="${gIdx}" title="Thêm nhanh 1 quà thay thế vào nhóm chọn 1 trong N">➕</button>`;
      giftItemsHtml += `<div class="mkt-gift-item-row" data-gift-idx="${gIdx}">
        <input type="number" value="${g.qty}" class="mkt-gift-qty" min="1" title="Số lượng quà" />
        <span class="mkt-gift-x">×</span>
        <div class="mkt-gift-picker">
          <input type="text" value="${escapeHtml(g.name)}" class="mkt-gift-name" placeholder="Gõ tìm sản phẩm quà tặng trong danh mục..." autocomplete="off" spellcheck="false" title="Gõ để tìm sản phẩm trong danh mục — chọn 1 món cụ thể để liên kết" ${linkedProduct ? 'readonly' : ''} />
          <div class="mkt-gift-suggestions"></div>
        </div>
        ${linkBadge}
        ${giftOptBtn}
        ${giftQuickAddBtn}
        ${unlinkBtn}
        <button class="btn btn-ghost btn-sm btn-remove-mkt-gift" title="Xóa quà này">✕</button>
      </div>`;
    });
    const t = r.threshold || { min: 0, max: 0, basis: 'money' };
    const minVal = t.min !== undefined ? t.min : (r.min_total || 0);
    const maxVal = t.max !== undefined ? t.max : (r.max_total || 0);
    const unitVal = (t.basis === 'boxes' || r.unit === 'boxes') ? 'boxes' : 'amount';
    const labelVal = r.label || db._buildPromoLabel(r) || '';
    mktRulesHtml += `<div class="mkt-rule-row promo-rule-draggable" data-campaign-key="${escapeHtml(campaignKey)}" data-rule-idx="${idx}" draggable="true">
      <div class="mkt-rule-main">
        ${buildPromoDragHandleHtml()}
        <span style="font-size:0.82rem;color:var(--text-secondary)">Từ</span>
        <input type="number" value="${minVal}" class="mkt-min-input" style="width:110px;" />
        <span style="font-size:0.82rem;color:var(--text-secondary)">Đến</span>
        <input type="number" value="${maxVal}" class="mkt-max-input" style="width:110px;" />
        <span style="font-size:0.82rem;color:var(--text-secondary)">Loại mốc:</span>
        <select class="mkt-unit-select" style="width:90px;">
          <option value="amount" ${unitVal === 'amount' ? 'selected' : ''}>Số tiền (đ)</option>
          <option value="boxes" ${unitVal === 'boxes' ? 'selected' : ''}>Thùng</option>
        </select>
        <span style="font-size:0.82rem;color:var(--text-secondary)">Nhãn:</span>
        <input type="text" value="${escapeHtml(labelVal)}" class="mkt-label-input" placeholder="Nhãn mốc" style="width:100px;" />
        <button class="btn btn-ghost btn-sm btn-remove-mkt" data-campaign-key="${escapeHtml(campaignKey)}" data-rule-idx="${idx}" title="Xóa mốc quà này" style="margin-left:auto;">✕</button>
      </div>
      <div class="mkt-rule-gifts">
        <span class="mkt-gifts-label">🎁 Quà tặng:</span>
        <div class="mkt-gift-items">
          ${giftItemsHtml || '<span class="mkt-gifts-empty">Chưa có quà — bấm "➕ Thêm quà" để chọn số lượng & loại quà</span>'}
        </div>
        <button class="btn btn-ghost btn-xs btn-add-mkt-gift" title="Thêm quà tặng cho mốc này">➕ Thêm quà</button>
      </div>
    </div>`;
  });
  return mktRulesHtml;
}


// --- Focus restore sau full re-render (commit giá chai/thùng) ---

/**
 * Selector nhận diện 1 ô nhập trong #orderTableBody để khôi phục focus sau full
 * re-render (render thay toàn bộ nội dung tbody → mọi node cũ bị vứt). Trả về null
 * nếu el không phải ô nhập của bảng (focus đã rời bảng → không restore).
 */
function getTableFocusRestoreSelector(el) {
  if (!el || el.nodeType !== 1) return null;
  const tbody = document.getElementById('orderTableBody');
  if (!tbody || !tbody.contains(el)) return null;
  const pairs = [
    ['.editable-price-bottle', 'data-price-bottle-index'],
    ['.editable-price-box', 'data-price-box-index'],
    ['.editable-qty', 'data-qty-index'],
    ['.editable-gift-qty', 'data-gift-id'],
    ['.unit-selector', 'data-unit-index'],
  ];
  for (const [cls, attr] of pairs) {
    if (el.matches(cls) && el.getAttribute(attr) != null) {
      return `${cls}[${attr}="${el.getAttribute(attr)}"]`;
    }
  }
  return null;
}

/**
 * Hẹn khôi phục focus SAU khi render chạy xong. store.notify() render qua
 * requestAnimationFrame được đăng ký trước (bên trong setState) → rAF đăng ký
 * sau tại đây chắc chắn chạy sau render, query được node mới thay node cũ.
 */
function scheduleTableFocusRestore(selector) {
  if (!selector || typeof requestAnimationFrame !== 'function') return;
  requestAnimationFrame(() => {
    const fresh = document.querySelector(`#orderTableBody ${selector}`);
    if (!fresh) return;
    fresh.focus();
    try {
      const len = String(fresh.value || '').length;
      fresh.setSelectionRange(len, len);
    } catch (e) { /* select không có caret */ }
  });
}

// --- Main UI Rendering Object ---

const uiRenderer = {
  // Event handlers callback references, bound by app.js during init
  callbacks: {
    removeOrderItem: null,
    reorderOrderItem: null,
    reorderRows: null,
    updateItemQty: null,
    updateDualPriceLive: null,
    selectComboboxItem: null,
    showComboboxDropdown: null,
    filterComboboxOptions: null,
    applyComboboxText: null,
    addCustomPromo: null,
    removeCustomPromo: null,
    overrideCampaign: null,
    quickAddGiftOption: null,
  },

  // Expose helper nội bộ cho luồng modal chỉnh sửa sâu (src/settings/ui.js)
  clearRenderCache,
  buildCategoryDatalistHtml,
  normalizeMktGiftItems,
  buildMktGiftsString,
  structuredGiftsFromItems,
  resolveMktGiftProductId,
  // Quà tặng "1 trong N" — modal cấu hình dùng chung cho Catalog + Settings
  openGiftOptionsEditor,
  findSizeSiblings,
  // Popup thêm nhanh 1 quà thay thế vào nhóm "1 trong N" (dòng rule + bảng đơn)
  openQuickGiftAdd,

  /**
   * Registers callback functions from Main Controller (app.js).
   */
  registerCallbacks(cbs) {
    this.callbacks = { ...this.callbacks, ...cbs };
  },

  /**
   * Builds <option> HTML for the unit/package selector on product rows.
   * Shows "Thùng" + native unit (chai/lon/tuýp...) so sales can pick package.
   */
  _buildUnitSelectorOptions(row) {
    const nativeUnit = row.product.unit || 'chai';
    const currentUnit = row.unit || 'thùng';
    const unitLabels = { 'chai': 'Chai', 'lon': 'Lon', 'tuýp': 'Tuýp', 'tuyp': 'Tuýp', 'can': 'Can', 'bình': 'Bình', 'phuy': 'Phuy' };
    const nativeLabel = unitLabels[nativeUnit] || nativeUnit.charAt(0).toUpperCase() + nativeUnit.slice(1);
    let html = `<option value="thùng" ${currentUnit === 'thùng' ? 'selected' : ''}>Thùng</option>`;
    html += `<option value="${escapeHtml(nativeUnit)}" ${currentUnit === nativeUnit ? 'selected' : ''}>${escapeHtml(nativeLabel)}</option>`;
    return html;
  },

  /**
   * Renders the AI Campaign Detection card.
   */
  renderAIDetection(result) {
    const card = document.getElementById('aiDetectionCard');
    if (!card) return;
    if (!result) {
      card.classList.add('hidden');
      return;
    }
    card.classList.remove('hidden');

    // Campaign badge
    const badge = document.getElementById('aiCampaignBadge');
    if (result.primaryCampaign) {
      const campaign = db.data.campaigns[result.primaryCampaign];
      const name = campaign ? campaign.name : result.campaignLabel;
      const icon = campaign ? campaign.icon : '📦';
      const color = result.campaignColor || '#4fc3f7';
      badge.innerHTML = `${icon} ${escapeHtml(name)}`;
      badge.style.background = color + '22';
      badge.style.color = color;
    } else {
      badge.innerHTML = '❓ Không xác định';
      badge.style.background = 'rgba(255,255,255,0.05)';
      badge.style.color = 'var(--text-secondary)';
    }

    // Confidence bar
    const fill = document.getElementById('aiConfidenceFill');
    const confText = document.getElementById('aiConfidenceText');
    const pct = result.confidencePercent || 0;
    fill.style.width = pct + '%';
    // A11y: đồng bộ aria-valuenow theo % confidence trên WRAPPER (.confidence-bar).
    // Helper tự thêm role="progressbar" nếu wrapper chưa có (markup do người khác lo).
    setProgressbarAria(fill.parentElement, pct);
    fill.className = 'confidence-fill ' + (pct >= 70 ? 'high' : pct >= 40 ? 'medium' : 'low');
    confText.textContent = pct + '%';
    confText.style.color = pct >= 70 ? 'var(--accent-green)' : pct >= 40 ? 'var(--accent-yellow)' : 'var(--accent-red)';

    // Score details
    const details = document.getElementById('aiDetails');
    let detailsHtml = '';
    const maxScore = Math.max(...Object.values(result.allScores || {}), 1);
    for (const [key, score] of Object.entries(result.allScores || {})) {
      const campaign = db.data.campaigns[key];
      if (!campaign) continue;
      const pctBar = Math.round((score / maxScore) * 100);
      const color = campaign.color || '#666';
      detailsHtml += `<div class="score-bar-container">
        <span class="score-bar-label">${escapeHtml(campaign.icon)} ${escapeHtml(campaign.name)}</span>
        <div class="score-bar"><div class="score-bar-fill" style="width:${pctBar}%; background:${color}"></div></div>
        <span class="score-bar-value">${score}</span>
      </div>`;
    }
    details.innerHTML = detailsHtml;

    // Override dropdown
    const override = document.getElementById('aiOverrideCampaign');
    if (override && override.options.length <= 1) {
      override.innerHTML = '<option value="">-- Chọn thương hiệu để ghi đè --</option>';
      for (const [key, campaign] of Object.entries(db.data.campaigns)) {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = `${campaign.icon} ${campaign.name}`;
        override.appendChild(opt);
      }
    }
    if (override) {
      override.value = result.primaryCampaign || '';
    }
  },

  /**
   * Renders the parsed preview lines list.
   */
  renderParsedPreview(lines) {
    const container = document.getElementById('parsedPreview');
    if (!container) return;
    container.innerHTML = '';
    
    const fragment = document.createDocumentFragment();
    for (const line of lines || []) {
      const div = document.createElement('div');
      let icon = '❓', text = escapeHtml(line.raw), extra = '';
      switch (line.type) {
        case 'customer': 
          icon = '👤'; 
          text = `Khách hàng: <strong>${escapeHtml(line.data.name)}</strong>`; 
          div.className = 'parsed-line info'; 
          break;
        case 'matched': 
          icon = '✅'; 
          text = `${escapeHtml(line.data.rawProduct)}`; 
          extra = `<span class="parsed-match-name">→ ${escapeHtml(line.data.matchedProduct.name)}</span><span class="parsed-qty">${line.data.qty} ${line.data.unit}</span>`; 
          div.className = 'parsed-line matched'; 
          break;
        case 'unmatched': 
          icon = '⚠️'; 
          text = `"${escapeHtml(line.data.rawProduct)}" — <em>Chưa khớp</em>`; 
          extra = `<span class="parsed-qty">${line.data.qty} ${line.data.unit}</span>`; 
          div.className = 'parsed-line unmatched'; 
          break;
        case 'payment':
          icon = '💳';
          text = `Thanh toán: <strong>${escapeHtml(line.data.label)}</strong>`;
          div.className = 'parsed-line info';
          break;
        case 'tier-override':
          icon = '💵';
          text = `Áp mốc giá <strong>${escapeHtml(String(line.data.priceTierQty))} thùng</strong> cho toàn đơn`;
          div.className = 'parsed-line info';
          break;
        default: 
          icon = '⏭️'; 
          text = `<span style="text-decoration:line-through">${escapeHtml(line.raw)}</span>`; 
          div.className = 'parsed-line ignored';
      }
      div.innerHTML = `<span class="parsed-status">${icon}</span> ${text} ${extra}`;
      fragment.appendChild(div);
    }
    container.appendChild(fragment);
  },

  /**
   * Nút toggle FOC ↔ Extra cho dòng quà/hàng 0đ. FOC = chữ đen trong Excel,
   * Extra = chữ đỏ + ghi 'extra' ở cột SL Thùng. Bấm để đổi qua lại.
   */
  buildGiftKindToggleHtml(row) {
    const id = row.rowId || row.giftId;
    if (!id) return '';
    const isExtra = row.giftKind === 'extra';
    const cls = isExtra ? 'kind-extra' : 'kind-foc';
    const label = isExtra ? 'EXTRA' : 'FOC';
    return `<button type="button" class="gift-kind-toggle ${cls}" data-kind-toggle="${id}" title="Bấm để đổi FOC ↔ Extra (Excel: FOC = chữ đen, Extra = chữ đỏ)">${label}</button>`;
  },

  /**
   * Computes rows, totals and gifts for the order table.
   */
  getOrderTableRows(currentOrder) {
    let rows = [];
    let grandTotal = 0;
    let totalBoxes = 0;
    const campaignTotals = {};

    currentOrder.items.forEach((item, index) => {
      if (!item.product) {
        let bottlePrice = item.manualPrice !== null && item.manualPrice !== undefined ? item.manualPrice : (item.unitPrice || 0);
        if (item.isGift) bottlePrice = 0;
        const boxSize = 12;
        const boxPrice = bottlePrice * boxSize;
        const sub = item.isGift ? 0 : bottlePrice * item.qty;
        item.subtotal = sub;
        grandTotal += sub;

        rows.push({
          type: 'unmatched',
          rowId: 'item_' + index,
          index,
          qty: item.qty,
          unit: item.unit,
          rawName: item.rawName,
          bottlePrice,
          boxPrice,
          boxSize,
          subtotal: sub,
          isGift: item.isGift || false,
          isCustom: item.isCustom || false
        });
      } else {
        const isBox = (item.unit === 'thùng');
        const boxSize = item.product.box_size || 12;
        let bottlePrice = item.manualPrice !== null && item.manualPrice !== undefined ? item.manualPrice : item.unitPrice;
        if (item.isGift) bottlePrice = 0;
        const boxPrice = bottlePrice * boxSize;
        const showPrice = isBox ? boxPrice : bottlePrice;
        const totalUnits = isBox ? item.qty * boxSize : item.qty;
        const sub = item.isGift ? 0 : bottlePrice * totalUnits;
        
        item.subtotal = sub;
        grandTotal += sub;
        
        const boxesCount = isBox ? item.qty : item.qty / boxSize;
        totalBoxes += boxesCount;

        // Hàng tặng (quà FOC/MKT, hàng tặng sales khai) KHÔNG tính vào tổng thùng/tiền
        // xét mốc quà MKT — chỉ hàng MUA mới đạt mốc (quà có box_size=1 nếu bị cộng sẽ
        // tự đẩy đơn lên mốc kế tiếp và sinh quà ảo).
        if (!item.isGift) {
          if (!campaignTotals[item.product.campaignKey]) {
            campaignTotals[item.product.campaignKey] = { amount: 0, boxes: 0 };
          }
          campaignTotals[item.product.campaignKey].amount += sub;
          campaignTotals[item.product.campaignKey].boxes += boxesCount;
        }

        rows.push({
          type: 'matched',
          rowId: 'item_' + index,
          index,
          product: item.product,
          qty: item.qty,
          unit: item.unit,
          bottlePrice,
          boxPrice,
          boxSize,
          showPrice,
          subtotal: sub,
          tierLabel: item.tierLabel,
          isGift: item.isGift || false,
          matchScore: (item.matchScore === undefined || item.matchScore === null) ? 100 : item.matchScore,
          matchVia: item.matchVia || null,
          rawProduct: item.rawProduct || item.rawName || ''
        });

        const focList = Array.isArray(item.foc) ? item.foc : (item.foc ? [item.foc] : []);
        focList.forEach((focRule, fIdx) => {
          const giftId = 'foc_' + index + '_' + fIdx;
          if (!currentOrder.giftDeleted || !currentOrder.giftDeleted[giftId]) {
            let giftProductId = focRule.give_product || null;
            if (currentOrder.giftOverrides && currentOrder.giftOverrides[giftId] !== undefined) {
              giftProductId = currentOrder.giftOverrides[giftId];
            }
            
            // Tặng cùng loại → luôn hiển thị đúng tên sản phẩm mua (X)
            let giftName = item.product.name;
            if (giftProductId) {
              const giftProd = db.findProductById(giftProductId);
              if (giftProd) giftName = giftProd.name;
            }

            let finalQty = focRule.total_give;
            if (currentOrder.giftQtyOverrides && currentOrder.giftQtyOverrides[giftId] !== undefined) {
              finalQty = currentOrder.giftQtyOverrides[giftId];
            }

            // Câu giải thích vì sao được tặng
            const sameLabel = focRule.isSameProduct ? ' (cùng loại)' : '';
            const buyUnitLabel = focRule.buy_unit || 'thùng';
            const focReason = `Mua ${focRule.buy_qty} ${buyUnitLabel} → tặng ${focRule.give_qty} ${focRule.give_unit || ''}${sameLabel}`.trim();

            rows.push({
              type: 'gift',
              rowId: giftId,
              giftId: giftId,
              giftSource: 'FOC',
              name: giftName || '— Khác —',
              productId: giftProductId,
              qty: finalQty,
              unit: focRule.give_unit,
              spec: 'Miễn phí',
              note: focRule.note || focReason,
              campaignIcon: item.product.campaignIcon,
              campaignName: item.product.campaignName,
              campaignColor: item.product.campaignColor,
              campaignKey: item.product.campaignKey,
              giftOptions: focRule.give_product_options || null,
              giftSubOptions: focRule.give_product_sub_options || null,
              // Truy nguồn rule gốc cho nút [+] thêm nhanh quà thay thế ngay trên bảng đơn
              giftRuleKind: 'foc',
              giftRuleRef: _matchFocSourceRule(item.product, focRule),
              giftSeedId: focRule.give_product || null
            });
          }
        });

        // Per-product MKT gift rules (e.g. Torvex: áo polo, nón, túi rút, DD súc rửa)
        // [Promo v1.3.0] Đọc từ campaign.promoRules (type 'qty', kind 'mkt_pp')
        const ppRules = item.product.campaignKey
          ? (db.getPromoRulesForProduct(item.product.id) || []).filter(r => r.type === 'qty' && r.kind === 'mkt_pp' && r.enabled !== false)
          : [];
        if (ppRules.length > 0) {
          const boxesCount = isBox ? item.qty : item.qty / boxSize;
          ppRules.forEach((mktRule, mktIdx) => {
            const buy = mktRule.buy || {};
            const gift = (Array.isArray(mktRule.gifts) && mktRule.gifts[0]) || {};
            // buy.unit: ''/'thùng' (mặc định) hoặc 'chai'/'lon'/'tuýp' (tính theo số chai lẻ).
            // VD: "Mua 1 chai tặng 1 DD súc rửa" → buy.unit='chai', so sánh theo totalUnits.
            const buyUnit = (buy.unit || 'thùng').toLowerCase().trim();
            const isUnitBased = (buyUnit === 'chai' || buyUnit === 'lon' || buyUnit === 'can' || buyUnit === 'tuýp' || buyUnit === 'tuyp');
            const compareQty = isUnitBased ? totalUnits : boxesCount;
            if (compareQty >= (buy.qty || 1)) {
              const times = Math.floor(compareQty / (buy.qty || 1));
              const giftId = 'mkt_pp_' + index + '_' + mktIdx;
              if (!currentOrder.giftDeleted || !currentOrder.giftDeleted[giftId]) {
                let giftProductId = gift.productId || null;
                if (currentOrder.giftOverrides && currentOrder.giftOverrides[giftId] !== undefined) {
                  giftProductId = currentOrder.giftOverrides[giftId];
                }
                let giftName = gift.name || mktRule.note || 'Quà MKT';
                if (giftProductId) {
                  const giftProd = db.findProductById(giftProductId);
                  if (giftProd) giftName = giftProd.name;
                }
                let finalQty = times * (gift.qty || 1);
                if (currentOrder.giftQtyOverrides && currentOrder.giftQtyOverrides[giftId] !== undefined) {
                  finalQty = currentOrder.giftQtyOverrides[giftId];
                }
                rows.push({
                  type: 'gift',
                  rowId: giftId,
                  giftId: giftId,
                  giftSource: 'MKT',
                  name: giftName,
                  productId: giftProductId,
                  qty: finalQty,
                  unit: gift.unit || 'cái',
                  spec: 'Quà tặng Marketing (theo SP)',
                  note: mktRule.note || `Mua ${buy.qty} ${buyUnit === 'chai' ? 'chai' : 'thùng'} tặng quà MKT`,
                  campaignIcon: item.product.campaignIcon,
                  campaignName: item.product.campaignName,
                  campaignColor: item.product.campaignColor,
                  giftOptions: gift.options || null,
                  giftSubOptions: gift.subOptions || null,
                  giftRuleKind: 'mkt_pp',
                  giftRuleRef: mktRule,
                  giftSeedId: gift.productId || null
                });
              }
            }
          });
        }
      }
    });

    for (const [key, totals] of Object.entries(campaignTotals)) {
      const giftRule = db.getMKTGifts(key, totals.amount, totals.boxes);
      if (giftRule) {
        const campaign = db.data.campaigns[key];
        if (!campaign) continue;
        // [Promo v1.3.0] Rule total scope campaign: gifts[] link productId (schema số)
        const parsedGifts = (Array.isArray(giftRule.gifts) ? giftRule.gifts : [])
          .map(g => ({ ...g, unit: (g.unit || inferMKTGiftUnit(g.name || '')).trim() }));
        // Hoist expensive lookups outside the per-gift loop
        const allProducts = db.getAllProducts();
        const sortedAliases = Object.entries(db.getAliases()).sort((a,b)=>b[0].length-a[0].length);
        parsedGifts.forEach((g, gIdx) => {
          const giftId = 'mkt_' + key + '_' + gIdx;
          if (!currentOrder.giftDeleted || !currentOrder.giftDeleted[giftId]) {
            let giftProductId = null;
            let giftName = g.name;

            // Simple local fuzzy match helper to avoid import loops
            let matched = null;
            // Ưu tiên 1: quà đã được LIÊN KẾT sản phẩm từ cài đặt (productId) → nhận diện chính xác tuyệt đối
            if (g.productId) {
              matched = allProducts.find(p => p.id === g.productId) || null;
            }
            if (!matched && g.name) {
            const normGift = g.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').trim();
            for (const [alias, pid] of sortedAliases) {
              if (normGift === alias.toLowerCase().trim()) {
                matched = allProducts.find(p => p.id === pid);
                break;
              }
            }
            if (!matched) {
              // Ưu tiên SP CÙNG campaign với mốc quà trước
              // (VD: đơn Zentor đạt mốc tặng "áo" → chọn áo Zentor, không lấy áo Torvex)
              matched = allProducts.find(p => p.campaignKey === key && (p.name.toLowerCase().includes(normGift) || normGift.includes(p.name.toLowerCase())));
            }
            if (!matched) {
              matched = allProducts.find(p => p.name.toLowerCase().includes(normGift) || normGift.includes(p.name.toLowerCase()));
            }
            } // end if (!matched) — bỏ qua fuzzy match khi đã có productId

            if (matched) {
              giftProductId = matched.id;
              giftName = matched.name;
            }

            if (currentOrder.giftOverrides && currentOrder.giftOverrides[giftId] !== undefined) {
              giftProductId = currentOrder.giftOverrides[giftId];
              const overrideProd = db.findProductById(giftProductId);
              if (overrideProd) {
                 giftName = overrideProd.name;
              } else if (!giftProductId) {
                 giftName = '— Khác —';
              }
            }

            let finalQty = g.qty;
            if (currentOrder.giftQtyOverrides && currentOrder.giftQtyOverrides[giftId] !== undefined) {
              finalQty = currentOrder.giftQtyOverrides[giftId];
            }

            rows.push({
              type: 'gift',
              rowId: giftId,
              giftId: giftId,
              giftSource: 'MKT',
              name: giftName,
              productId: giftProductId,
              qty: finalQty,
              unit: g.unit,
              spec: `Quà tặng Marketing (${giftRule.label})`,
              note: `Đạt mốc thương hiệu ${campaign.name}`,
              campaignIcon: campaign.icon,
              campaignName: campaign.name,
              campaignColor: campaign.color,
              giftOptions: g.options || null,
              giftSubOptions: g.subOptions || null,
              giftRuleKind: 'mkt_campaign',
              giftRuleRef: giftRule,
              giftItemIdx: gIdx,
              giftSeedId: g.productId || null
            });
          }
        });
      }
    }

    // ===== Gộp các dòng quà tặng cùng loại (cùng sản phẩm + đơn vị → 1 dòng, cộng tổng SL) =====
    // Bố cục mặc định: hàng mua ở trên, khối quà tặng (0đ) ở dưới cùng;
    // trong khối quà: quà FOC (nhớt tặng) ở trên cùng, kế đến là quà MKT.
    // ===== Phân loại FOC / Extra cho từng dòng free (quà, hàng tặng, hàng 0đ) =====
    // Mặc định theo nguồn gốc: có sản phẩm khớp (quà theo chương trình) → 'foc';
    // ngoài chương trình / tự nhập không khớp SP → 'extra'. User đảo qua lại
    // trên bảng đơn (toggleGiftKind) → lựa chọn lưu trong giftKindOverrides.
    const kindOverrides = currentOrder.giftKindOverrides || {};
    rows.forEach(row => {
      const isFreeRow = row.type === 'gift' || row.isGift || Number(row.subtotal) === 0 || Number(row.bottlePrice) === 0;
      if (!isFreeRow) return;
      const id = row.rowId || row.giftId;
      if (kindOverrides[id]) { row.giftKind = kindOverrides[id]; return; }
      let hasProduct = false;
      if (row.type === 'gift') hasProduct = !!db.findProductById(row.productId);
      else hasProduct = !!row.product;
      row.giftKind = hasProduct ? 'foc' : 'extra';
    });

    const normKey = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').trim();
    const productRows = rows.filter(r => r.type !== 'gift');
    const allGiftRows = rows.filter(r => r.type === 'gift');

    const mergeGiftRows = (list) => {
      const mergedList = [];
      const map = new Map();
      list.forEach(g => {
        const identity = g.productId || normKey(g.name);
        // Kind (FOC/Extra) nằm trong key: cùng SP nhưng khác kind → KHÔNG gộp chung
        const key = `${g.giftSource}|${identity}|${normKey(g.unit)}|${g.giftKind || ''}`;
        if (map.has(key)) {
          const target = map.get(key);
          target.qty = (Number(target.qty) || 0) + (Number(g.qty) || 0);
          target.mergedGiftIds.push(g.giftId);
          if (g.note && !target._notes.includes(g.note)) target._notes.push(g.note);
        } else {
          const clone = Object.assign({}, g, { mergedGiftIds: [g.giftId], _notes: g.note ? [g.note] : [] });
          map.set(key, clone);
          mergedList.push(clone);
        }
      });
      mergedList.forEach(m => {
        if (m._notes.length > 1) m.note = m._notes.join('  +  ');
        delete m._notes;
      });
      return mergedList;
    };

    const mergedGifts = mergeGiftRows(allGiftRows);
    const focGiftRows = mergedGifts.filter(g => g.giftSource === 'FOC');
    const mktGiftRows = mergedGifts.filter(g => g.giftSource !== 'FOC');
    rows = [...productRows, ...focGiftRows, ...mktGiftRows];

    // Initialize rowOrder if it doesn't exist
    if (!currentOrder.rowOrder) {
      currentOrder.rowOrder = rows.map(d => d.rowId || d.giftId);
    }

    // Apply custom row ordering if present
    if (currentOrder.rowOrder && currentOrder.rowOrder.length > 0) {
      const orderMap = {};
      currentOrder.rowOrder.forEach((id, idx) => { orderMap[id] = idx; });

      // Split into known (in rowOrder) and new (not in rowOrder) descriptors
      const knownRows = rows.filter(d => {
        const id = d.rowId || d.giftId;
        return id in orderMap;
      });
      const newRows = rows.filter(d => {
        const id = d.rowId || d.giftId;
        return !(id in orderMap);
      });

      // Sort known rows by rowOrder
      knownRows.sort((a, b) => {
        const aId = a.rowId || a.giftId;
        const bId = b.rowId || b.giftId;
        return (orderMap[aId] ?? 9999) - (orderMap[bId] ?? 9999);
      });

      // Rebuild: known first, then new ones appended
      const sortedRows = [...knownRows, ...newRows];

      // Update rowOrder to reflect actual state (clean up deleted, add new)
      const newRowOrder = sortedRows.map(d => d.rowId || d.giftId);
      if (JSON.stringify(newRowOrder) !== JSON.stringify(currentOrder.rowOrder)) {
        currentOrder.rowOrder = newRowOrder;
      }

      return { rows: sortedRows, grandTotal, totalBoxes, campaignTotals };
    }

    return { rows, grandTotal, totalBoxes, campaignTotals };
  },

  /**
   * Builds the searchable combobox HTML.
   */
  buildSearchableComboboxHTML(index, selectedProduct, fallbackName = '') {
    let displayName = fallbackName;
    if (selectedProduct) {
      displayName = selectedProduct.name;
    }
    const inputBorderColor = selectedProduct ? '' : 'border-color: var(--accent-orange);';

    // Lazy dropdown: render empty, populate on first focus via populateComboboxDropdown()
    // ARIA combobox pattern: input giữ role="combobox" + aria-expanded (được
    // đồng bộ theo trạng thái dropdown trong src/order/actions.js).
    return `<div class="combobox-container" id="combobox-container-${index}">
      <input type="text" class="input-field combobox-input" id="combobox-input-${index}"
        value="${escapeHtml(displayName)}"
        placeholder="Tìm sản phẩm..."
        style="font-size: 0.86rem; width: 100%; ${inputBorderColor}"
        data-combobox-index="${index}"
        role="combobox" aria-expanded="false" aria-haspopup="listbox" aria-autocomplete="list"
        autocomplete="off" />
      <div class="combobox-dropdown" id="combobox-dropdown-${index}" data-populated="0" role="listbox"></div>
    </div>`;
  },

  /**
   * Lazily populates a combobox dropdown with all product items.
   * Called on first focus; subsequent focuses reuse existing DOM.
   */
  populateComboboxDropdown(index) {
    const dropdown = document.getElementById(`combobox-dropdown-${index}`);
    if (!dropdown || dropdown.getAttribute('data-populated') === '1') return;

    // Build cached items if needed
    if (!_renderCache.comboboxItems) {
      const allProducts = db.getAllProducts();
      _renderCache.comboboxItems = allProducts.map(p => {
        const normName = p.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
        const normSpec = (p.spec || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
        const normCamp = (p.campaignName || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
        const normKvCode = (p.kvCode || '').toLowerCase();
        const normPackaging = (p.packaging || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
        const searchText = `${normName} ${normSpec} ${normCamp} ${normKvCode} ${normPackaging}`;
        return {
          id: p.id,
          escSearch: escapeHtml(searchText),
          escName: escapeHtml(normName),
          escLabel: escapeHtml((p.campaignIcon || '📦') + ' ' + p.name),
          escCamp: escapeHtml(p.campaignName),
          color: p.campaignColor
        };
      });
    }
    const items = _renderCache.comboboxItems;

    // A11y: option render bằng JS tại đây (không phải actions.js) → gắn
    // role="option" cho từng item để hoàn chỉnh pattern combobox/listbox.
    let html = `<div class="combobox-item" role="option" data-index="${index}" data-product-id="" data-search-text="" data-is-clear="1">
      <span class="combobox-item-name" style="color:var(--text-secondary);">— Chưa khớp / Khác —</span>
    </div>`;
    for (let i = 0; i < items.length; i++) {
      const p = items[i];
      html += `<div class="combobox-item" role="option" data-index="${index}" data-product-id="${p.id}" data-search-text="${p.escSearch}" data-name-text="${p.escName}">
        <span class="combobox-item-name">${p.escLabel}</span>
        <span class="combobox-item-campaign" style="color:${p.color}">${p.escCamp}</span>
      </div>`;
    }
    dropdown.innerHTML = html;
    dropdown.setAttribute('data-populated', '1');

    // Bind mousedown handlers for the newly created items
    dropdown.querySelectorAll('.combobox-item[data-index]').forEach(item => {
      item.onmousedown = (e) => {
        const target = e.currentTarget;
        const idx = target.getAttribute('data-index');
        const productId = target.getAttribute('data-product-id') || '';
        if (this.callbacks.selectComboboxItem) this.callbacks.selectComboboxItem(idx, productId);
      };
    });
  },

  /**
   * Renders the order results table.
   */
  /** Signature "hình dạng bảng đơn" — main.js dùng để skip render khi state vô can. */
  getOrderTableSignature(currentOrder) {
    return orderTableSignature(currentOrder);
  },

  renderOrderResults(currentOrder) {
    const tbody = document.getElementById('orderTableBody');
    const emptyState = document.getElementById('emptyState');
    const orderResults = document.getElementById('orderResults');
    const btnCopy = document.getElementById('btnCopy');
    const btnKiotVietOrder = document.getElementById('btnKiotVietOrder');
    const btnExportExcel = document.getElementById('btnExportExcel');
    const btnSavePending = document.getElementById('btnSavePending');

    if (!tbody || !emptyState || !orderResults) return;

    // Tự chữa class is-dragging sót từ phiên kéo trước (drop re-render detach
    // dòng nguồn → dragend không bubble tới tbody → cleanup không chạy): class
    // kẹt biến .order-results thành overflow:hidden — phá sticky thanh tổng kết
    // (#orderSummary) và tiêu đề bảng (thead th). Gỡ ở MỌI lượt render.
    orderResults.classList.remove('is-dragging');
    tbody.classList.remove('is-dragging');
    document.body.classList.remove('is-dragging');

    if (!currentOrder || currentOrder.items.length === 0) {
      emptyState.style.display = ''; 
      orderResults.classList.add('hidden');
      if (btnCopy) btnCopy.classList.add('hidden');
      if (btnKiotVietOrder) btnKiotVietOrder.classList.add('hidden');
      if (btnExportExcel) btnExportExcel.classList.add('hidden');
      if (btnSavePending) btnSavePending.classList.add('hidden');
      return;
    }
    
    emptyState.style.display = 'none'; 
    orderResults.classList.remove('hidden');
    if (btnCopy) btnCopy.classList.remove('hidden');
    if (btnKiotVietOrder) btnKiotVietOrder.classList.remove('hidden');
    if (btnExportExcel) btnExportExcel.classList.remove('hidden');
    if (btnSavePending) btnSavePending.classList.remove('hidden');
    // Memoize HTML bảng theo "hình dạng" (items + quà): state vô can không kéo
    // lại pipeline quà (getOrderTableRows) + dựng N dòng. Cache tự vô hiệu khi
    // sig đổi (đổi SP, qty, giá, đơn vị, toggle FOC/MKT, thêm/xóa dòng, drag...).
    const tableSig = orderTableSignature(currentOrder);
    const cachedTable = _renderCache.orderTable;
    if (cachedTable && cachedTable.sig === tableSig) {
      tbody.innerHTML = cachedTable.html;
      this.initDelegatedTableListeners();
      this._paintOrderSummary(currentOrder, cachedTable.grandTotal, cachedTable.totalBoxes);
      return;
    }

    tbody.innerHTML = '';

    const { rows, grandTotal, totalBoxes } = this.getOrderTableRows(currentOrder);
    const fragment = document.createDocumentFragment();

    let prevRowWasGift = false;
    rows.forEach((row, rowIndex) => {
      // Vạch phân cách đánh dấu bắt đầu khu vực quà tặng (0đ)
      if (row.type === 'gift' && !prevRowWasGift) {
        const sep = document.createElement('tr');
        sep.className = 'gift-section-separator';
        sep.innerHTML = `<td colspan="6"><span class="gift-section-label">🎁 KHU VỰC QUÀ TẶNG KHUYẾN MÃI (0đ)</span><span class="gift-section-hint">Nhớt tặng (FOC) ở trên · Quà Marketing (MKT) ở dưới</span></td>`;
        fragment.appendChild(sep);
      }
      prevRowWasGift = (row.type === 'gift');
      const tr = document.createElement('tr');
      // Visual row index for drag-and-drop reordering (independent of item index)
      tr.setAttribute('data-row-index', rowIndex);

      // Make product rows draggable (gift rows get draggable below)
      if (row.type === 'matched' || row.type === 'unmatched') {
        tr.classList.add('product-row-draggable');
        tr.setAttribute('draggable', 'true');
        tr.setAttribute('data-item-index', row.index);
        this._lastProductItemIndex = row.index;
      }
      
      if (row.type === 'unmatched') {
        tr.classList.add('unmatched-row');
        if (row.isGift || row.subtotal === 0 || Number(row.bottlePrice) === 0) tr.classList.add('highlight-foc-row');
        if (row.isCustom) tr.classList.add('custom-product-row');
        const priceSection = row.isGift 
          ? `<span style="color:var(--text-tertiary); font-weight: 500;">Hàng tặng (FOC)</span>`
          : `<div class="dual-price-cell">
              <div class="price-row-item">
                <span class="price-label-badge">Chai</span>
                <input type="text" class="editable-price editable-price-bottle" value="${formatNumberWithDots(Math.round(row.bottlePrice))}" data-price-bottle-index="${row.index}" placeholder="Giá chai" />
              </div>
              <div class="price-row-item">
                <span class="price-label-badge">Thùng</span>
                <input type="text" class="editable-price editable-price-box" value="${formatNumberWithDots(Math.round(row.boxPrice))}" data-price-box-index="${row.index}" placeholder="Giá thùng" />
              </div>
            </div>`;
        const subtotalText = row.isGift ? 'Miễn phí' : formatCurrency(row.subtotal || 0);
        // Dòng free (hàng tặng hoặc giá 0đ) → nút toggle FOC/Extra
        const giftBadge = (row.isGift || Number(row.subtotal) === 0 || Number(row.bottlePrice) === 0) ? this.buildGiftKindToggleHtml(row) : '';
        const customBadge = row.isCustom ? `<span style="font-size:0.72rem; background:rgba(100,181,246,0.15); color:#64b5f6; padding:2px 8px; border-radius:10px; margin-left:8px;">✏️ Tự nhập</span>` : '';
        const saveCustomBtn = row.isCustom ? `<button class="btn-save-custom-as-product" data-save-custom-index="${row.index}" title="Lưu dòng này thành sản phẩm trong danh mục — lần sau gõ tên là khớp ngay" style="font-size:0.72rem; background:rgba(76,175,80,0.12); color:#4caf50; border:1px solid rgba(76,175,80,0.35); border-radius:10px; padding:2px 8px; margin-left:8px; cursor:pointer;">💾 Lưu thành SP</button>` : '';

        tr.innerHTML = `<td><span class="drag-handle" title="Kéo để sắp xếp lại"><svg width="10" height="16" viewBox="0 0 10 16"><circle cx="3" cy="2" r="1.2" fill="currentColor"/><circle cx="7" cy="2" r="1.2" fill="currentColor"/><circle cx="3" cy="6" r="1.2" fill="currentColor"/><circle cx="7" cy="6" r="1.2" fill="currentColor"/><circle cx="3" cy="10" r="1.2" fill="currentColor"/><circle cx="7" cy="10" r="1.2" fill="currentColor"/><circle cx="3" cy="14" r="1.2" fill="currentColor"/><circle cx="7" cy="14" r="1.2" fill="currentColor"/></svg></span><button class="btn-delete-row" data-remove-index="${row.index}">✕</button></td>
          <td>
            <div class="product-cell" style="gap: var(--space-xs);">
              <div style="font-weight: 600; color: ${row.isCustom ? 'var(--accent-blue)' : 'var(--accent-orange)'}; margin-bottom: 2px;">${row.isCustom ? '✏️' : '⚠️'} ${row.isCustom ? 'Hàng tự nhập' : 'Dòng gốc'}: "${escapeHtml(row.rawName || 'Không xác định')}"</div>
              <div style="display:flex; align-items:center; gap:8px;">
                ${row.isCustom ? '' : this.buildSearchableComboboxHTML(row.index, null)}
                ${giftBadge}
                ${customBadge}
                ${saveCustomBtn}
              </div>
            </div>
          </td>
          <td class="text-center"><input type="number" class="editable-qty" value="${row.qty}" min="1" data-qty-index="${row.index}" /></td>
          <td class="text-center"></td>
          <td class="text-right">${priceSection}</td>
          <td class="text-right subtotal-amount">${subtotalText}</td>`;
      } else if (row.type === 'matched') {
        if (row.isGift || row.subtotal === 0 || Number(row.bottlePrice) === 0) tr.classList.add('highlight-foc-row');
        // Cờ tin cậy: tô cảnh báo dòng khớp yếu (< 60) để kiểm tra
        const score = (row.matchScore === undefined || row.matchScore === null) ? 100 : row.matchScore;
        const isWeak = !row.isGift && score < 60;
        if (isWeak) tr.classList.add('low-confidence-row');
        let confBadge = '';
        if (!row.isGift && score < 100) {
          const cColor = score < 60 ? '#e5a11d' : (score < 85 ? '#c8a415' : '#8a9a5b');
          confBadge = `<span title="Độ tin cậy khớp sản phẩm" style="font-size:0.7rem; font-weight:700; padding:1px 6px; border-radius:8px; background:${cColor}22; color:${cColor}; white-space:nowrap;">${score}%${isWeak ? ' ⚠️' : ''}</span>`;
        }
        // Badge phương pháp khớp (alias/fuzzy/ai/kvcode)
        let viaBadge = '';
        if (!row.isGift && row.matchVia) {
          const viaMap = {
            'kvcode': { label: 'Mã KV', color: '#4caf50', icon: '🔑' },
            'alias': { label: 'Alias', color: '#2196f3', icon: '📌' },
            'fuzzy': { label: 'Fuzzy', color: '#ff9800', icon: '🔍' },
            'ai': { label: 'AI chọn', color: '#9c27b0', icon: '🤖' },
            'ai-confirmed': { label: 'AI ✓', color: '#8a9a5b', icon: '✓' },
            'brand-ctx': { label: 'Brand', color: '#00bcd4', icon: '🏷️' },
            'review': { label: 'CẦN KIỂM TRA', color: '#f44336', icon: '⚠️' }
          };
          const v = viaMap[row.matchVia] || { label: row.matchVia, color: '#666', icon: '?' };
          viaBadge = `<span title="Phương pháp khớp: ${v.label}" style="font-size:0.65rem; padding:1px 5px; border-radius:6px; background:${v.color}18; color:${v.color}; white-space:nowrap;">${v.icon} ${v.label}</span>`;
        }
        const campColor = row.product.campaignColor || '#666';
        const campBadge = `<span class="product-campaign" style="background:${campColor}22;color:${campColor}">${row.product.campaignIcon||'📦'} ${escapeHtml(row.product.campaignName)}</span>`;
        const priceSection = row.isGift 
          ? `<span style="color:var(--text-tertiary); font-weight: 500;">Hàng tặng (FOC)</span>`
          : `<div class="dual-price-cell">
              <div class="price-row-item">
                <span class="price-label-badge">Chai</span>
                <input type="text" class="editable-price editable-price-bottle" value="${formatNumberWithDots(Math.round(row.bottlePrice))}" data-price-bottle-index="${row.index}" title="Đơn giá chai (1 chai)" />
              </div>
              <div class="price-row-item">
                <span class="price-label-badge">Thùng</span>
                <input type="text" class="editable-price editable-price-box" value="${formatNumberWithDots(Math.round(row.boxPrice))}" data-price-box-index="${row.index}" title="Đơn giá thùng (${row.boxSize} chai/thùng)" />
              </div>
              ${row.tierLabel ? `<span class="price-tier">${escapeHtml(row.tierLabel)}</span>` : ''}
            </div>`;
        const subtotalText = row.isGift ? 'Miễn phí' : formatCurrency(row.subtotal || 0);
        // Dòng free (hàng tặng hoặc giá 0đ) → nút toggle FOC/Extra
        const giftBadge = (row.isGift || Number(row.subtotal) === 0 || Number(row.bottlePrice) === 0) ? this.buildGiftKindToggleHtml(row) : '';

        // Click-to-copy KV code chip (đủ thùng → mã thùng, lẻ → mã chai)
        const kvCode = db.getKvCode(row.product, row.unit);
        const kvCellHtml = kvCode
          ? `<button type="button" class="kv-code-copy" data-kv-code="${escapeHtml(kvCode)}" title="Bấm để copy mã KV: ${escapeHtml(kvCode)}"><span class="kv-code-text">${escapeHtml(kvCode)}</span><span class="kv-code-icon">⧉</span></button>`
          : `<span class="kv-code-empty">—</span>`;

        tr.innerHTML = `<td><span class="drag-handle" title="Kéo để sắp xếp lại"><svg width="10" height="16" viewBox="0 0 10 16"><circle cx="3" cy="2" r="1.2" fill="currentColor"/><circle cx="7" cy="2" r="1.2" fill="currentColor"/><circle cx="3" cy="6" r="1.2" fill="currentColor"/><circle cx="7" cy="6" r="1.2" fill="currentColor"/><circle cx="3" cy="10" r="1.2" fill="currentColor"/><circle cx="7" cy="10" r="1.2" fill="currentColor"/><circle cx="3" cy="14" r="1.2" fill="currentColor"/><circle cx="7" cy="14" r="1.2" fill="currentColor"/></svg></span><button class="btn-delete-row" data-remove-index="${row.index}">✕</button></td>
          <td>
            <div class="product-cell" style="gap: var(--space-xs);">
              <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                ${this.buildSearchableComboboxHTML(row.index, row.product)}
                ${confBadge}
                ${viaBadge}
                ${giftBadge}
              </div>
              ${row.rawProduct && !row.isGift ? `<span class="raw-input-hint" title="Text gốc sales ghi" style="font-size:0.7rem; color:var(--text-tertiary); font-style:italic;">📝 "${escapeHtml(row.rawProduct)}"</span>` : ''}
              ${isWeak ? '<span style="font-size:0.72rem; color:#e5a11d; margin-top:2px;">⚠️ Cần kiểm tra — máy đoán chưa chắc, hãy chọn lại nếu sai</span>' : ''}
              <span class="product-spec" style="margin-top: 4px;">${escapeHtml(row.product.spec||'')}${packagingAutoText(row.product) ? ` · ${escapeHtml(packagingAutoText(row.product))}` : ''}</span>
              ${campBadge}
            </div>
          </td>
          <td class="text-center">
            <input type="number" class="editable-qty" value="${row.qty}" min="1" data-qty-index="${row.index}" />
            ${row.boxSize > 1 ? `<select class="unit-selector" data-unit-index="${row.index}" title="Quy cách đóng gói">${this._buildUnitSelectorOptions(row)}</select>` : ''}
          </td>
          <td class="text-center kv-code-cell">${kvCellHtml}</td>
          <td class="text-right">${priceSection}</td>
          <td class="text-right subtotal-amount">${subtotalText}</td>`;
      } else if (row.type === 'gift') {
        tr.className = 'gift-row product-row-draggable';
        tr.setAttribute('draggable', 'true');
        // Map gift to parent product index: parse from giftId
        let parentItemIndex = this._lastProductItemIndex;
        if (row.giftId) {
          const focMatch = row.giftId.match(/^foc_(\d+)/);
          const mktPpMatch = row.giftId.match(/^mkt_pp_(\d+)_\d+$/);
          if (focMatch) parentItemIndex = parseInt(focMatch[1]);
          else if (mktPpMatch) parentItemIndex = parseInt(mktPpMatch[1]);
        }
        tr.setAttribute('data-item-index', parentItemIndex !== undefined ? parentItemIndex : 0);
        const campColor = row.campaignColor || '#666';
        const campBadge = `<span class="product-campaign" style="background:${campColor}22;color:${campColor}">${escapeHtml(row.campaignIcon||'📦')} ${escapeHtml(row.campaignName)}</span>`;
        // Nút [+] thêm nhanh quà thay thế vào nhóm "1 trong N" ngay tại bảng đơn
        const giftQuickAddBtnHtml = row.giftRuleRef
          ? `<button type="button" class="btn-gift-quickadd" data-gift-id="${row.giftId}" title="Thêm nhanh 1 quà thay thế vào nhóm chọn 1 trong N">➕</button>`
          : '';
        const focNoteText = row.note ? `${escapeHtml(row.note)}` : '';
        const searchHtml = this.buildSearchableComboboxHTML(row.giftId, db.findProductById(row.productId), row.name);

        // Build hierarchical gift selector (group + sub-options)
        let sizeSelectorHtml = '';
        if (row.giftOptions && row.giftOptions.length > 1) {
          const currentProductId = row.productId;
          const sizeLabels = { s: 'S', m: 'M', l: 'L', xl: 'XL', xxl: 'XXL' };

          if (row.giftSubOptions && Object.keys(row.giftSubOptions).length > 0) {
            // --- 2-level hierarchical selector ---
            // Determine active group: current product IS a group option, or is a sub-option of a group
            let activeGroup = null;
            for (const groupId of row.giftOptions) {
              if (groupId === currentProductId) { activeGroup = groupId; break; }
              const subs = row.giftSubOptions[groupId];
              if (subs && subs.includes(currentProductId)) { activeGroup = groupId; break; }
            }
            if (!activeGroup) activeGroup = row.giftOptions[0];

            // Level 1: group buttons
            const groupBtns = row.giftOptions.map(gId => {
              const gProd = db.findProductById(gId);
              if (!gProd) return '';
              const isActive = gId === activeGroup;
              // Short label: strip brand prefix, use meaningful part
              let label = gProd.name.replace(/^(Torvex|TORVEX|Xvil|XVIL|Veltron|VELTRON|Zentor)\s*/i, '').replace(/\s*\(.*$/, '').trim();
              if (label.length > 20) label = label.substring(0, 18) + '…';
              const hasSubs = row.giftSubOptions[gId] && row.giftSubOptions[gId].length > 1;
              const defaultSub = hasSubs ? row.giftSubOptions[gId][0] : '';
              return `<button class="gift-group-btn${isActive ? ' active' : ''}" data-gift-id="${row.giftId}" data-product-id="${gId}" data-has-subs="${hasSubs ? '1' : '0'}" data-default-sub="${defaultSub}">${escapeHtml(label)}</button>`;
            }).join('');

            // Level 2: sub-buttons for active group
            let subBtns = '';
            const activeSubs = row.giftSubOptions[activeGroup];
            if (activeSubs && activeSubs.length > 1) {
              subBtns = activeSubs.map(subId => {
                const subProd = db.findProductById(subId);
                if (!subProd) return '';
                const isActive = subId === currentProductId;
                const sizeMatch = subId.match(/size_(s|m|l|xl|xxl)$/);
                const subLabel = sizeMatch ? sizeLabels[sizeMatch[1]] || sizeMatch[1].toUpperCase() : subProd.name.replace(/\s*\(.*$/, '').trim();
                return `<button class="gift-sub-btn${isActive ? ' active' : ''}" data-gift-id="${row.giftId}" data-product-id="${subId}">${escapeHtml(subLabel)}</button>`;
              }).join('');
              subBtns = `<div class="gift-sub-row">${subBtns}</div>`;
            }

            sizeSelectorHtml = `<div class="gift-group-row">${groupBtns}</div>${subBtns}`;
          } else {
            // --- Flat selector (backward compat) ---
            let sizeButtonsHtml = row.giftOptions.map(optId => {
              const optProd = db.findProductById(optId);
              if (!optProd) return '';
              const isActive = optId === currentProductId;
              const sizeMatch = optId.match(/size_(s|m|l|xl|xxl)$/);
              const sizeLabel = sizeMatch ? sizeLabels[sizeMatch[1]] || sizeMatch[1].toUpperCase() : optProd.name.replace(/^(Torvex|TORVEX|Xvil|XVIL|Veltron|VELTRON|Zentor)\s*/i, '').replace(/\s*\(.*$/, '').trim();
              return `<button class="size-selector-btn${isActive ? ' active' : ''}" data-gift-id="${row.giftId}" data-product-id="${optId}">${escapeHtml(sizeLabel)}</button>`;
            }).join('');
            sizeSelectorHtml = `<div class="size-selector-row">${sizeButtonsHtml}</div>`;
          }
        }

        // Click-to-copy KV code chip for gift/promotional product (hiển thị nếu có)
        const giftKvCode = db.getKvCode(db.findProductById(row.productId), row.unit);
        const giftKvCellHtml = giftKvCode
          ? `<button type="button" class="kv-code-copy" data-kv-code="${escapeHtml(giftKvCode)}" title="Bấm để copy mã KV: ${escapeHtml(giftKvCode)}"><span class="kv-code-text">${escapeHtml(giftKvCode)}</span><span class="kv-code-icon">⧉</span></button>`
          : `<span class="kv-code-empty">—</span>`;
        
        tr.innerHTML = `<td><span class="drag-handle" title="Kéo để sắp xếp lại"><svg width="10" height="16" viewBox="0 0 10 16"><circle cx="3" cy="2" r="1.2" fill="currentColor"/><circle cx="7" cy="2" r="1.2" fill="currentColor"/><circle cx="3" cy="6" r="1.2" fill="currentColor"/><circle cx="7" cy="6" r="1.2" fill="currentColor"/><circle cx="3" cy="10" r="1.2" fill="currentColor"/><circle cx="7" cy="10" r="1.2" fill="currentColor"/><circle cx="3" cy="14" r="1.2" fill="currentColor"/><circle cx="7" cy="14" r="1.2" fill="currentColor"/></svg></span><button class="btn-delete-row btn-delete-gift" data-gift-id="${row.giftId}" title="Xóa quà tặng này">✕</button></td>
          <td><div class="product-cell"><div style="margin-bottom:4px;display:flex;align-items:center;gap:8px">${searchHtml}${this.buildGiftKindToggleHtml(row)}${giftQuickAddBtnHtml}</div>${sizeSelectorHtml}<span class="product-spec">${focNoteText}</span>${campBadge}</div></td>
          <td class="text-center gift-qty-cell">
            <div class="gift-qty-wrap">
              <input type="number" class="editable-qty editable-gift-qty" value="${row.qty}" min="0" data-gift-id="${row.giftId}" />
              <span class="gift-qty-unit">${escapeHtml(row.unit)}</span>
            </div>
          </td>
          <td class="text-center kv-code-cell">${giftKvCellHtml}</td>
          <td class="text-right" style="color:var(--text-tertiary);">Miễn phí</td>
          <td class="text-right subtotal-amount" style="color:var(--text-tertiary);">Miễn phí</td>`;
      }
      fragment.appendChild(tr);
    });

    tbody.appendChild(fragment);

    // Attach delegated listeners once (persists across re-renders) —
    // includes click/change/input/focus/keydown AND drag-and-drop reordering.
    this.initDelegatedTableListeners();

    // Cache cho lần render kế tiếp: HTML đã dựng + tổng (sig tính ở đầu hàm).
    _renderCache.orderTable = { sig: tableSig, html: tbody.innerHTML, grandTotal, totalBoxes };

    this._paintOrderSummary(currentOrder, grandTotal, totalBoxes);
  },

  /**
   * Cập nhật thanh tổng kết + ẩn section MKT cũ + ghi chú thanh toán.
   * Tách riêng để nhánh cache hit dùng chung với build mới.
   */
  _paintOrderSummary(currentOrder, grandTotal, totalBoxes) {
    const summaryProducts = document.getElementById('summaryProducts');
    const summaryBoxes = document.getElementById('summaryBoxes');
    const summaryTotal = document.getElementById('summaryTotal');
    if (summaryProducts) summaryProducts.textContent = currentOrder.items.filter(i => i.product).length;
    if (summaryBoxes) summaryBoxes.textContent = totalBoxes.toFixed(1).replace('.0', '');
    if (summaryTotal) summaryTotal.textContent = formatCurrency(grandTotal);

    // Hide old MKT Section
    const mktSection = document.getElementById('mktGiftsSection');
    if (mktSection) mktSection.classList.add('hidden');

    // Payment method note
    const paymentNote = document.getElementById('paymentNote');
    const paymentLabels = { ck:'Chuyển khoản (CK)', cod:'COD', tt:'Thanh toán trực tiếp', congno:'Công nợ', other:'Khác' };
    if (paymentNote) {
      paymentNote.classList.remove('hidden');
      const paymentNoteText = document.getElementById('paymentNoteText');
      const paymentSelect = document.getElementById('paymentMethod');
      if (paymentNoteText && paymentSelect) {
        paymentNoteText.textContent = `Phương thức: ${paymentLabels[paymentSelect.value] || ''}`;
      }
    }
  },

  /**
   * Initializes delegated event listeners on the order table tbody.
   * Called once; listeners persist across re-renders since tbody element is reused.
   */
  _delegatedListenersAttached: false,
  initDelegatedTableListeners() {
    if (this._delegatedListenersAttached) return;
    const tbody = document.getElementById('orderTableBody');
    if (!tbody) return;
    this._delegatedListenersAttached = true;

    const self = this;

    // --- Delegated CLICK handler for all buttons ---
    tbody.addEventListener('click', (e) => {
      const target = e.target;

      // Delete buttons (normal items)
      const deleteBtn = target.closest('.btn-delete-row[data-remove-index]');
      if (deleteBtn) {
        const index = parseInt(deleteBtn.getAttribute('data-remove-index'));
        if (self.callbacks.removeOrderItem) self.callbacks.removeOrderItem(index);
        return;
      }

      // Delete buttons (gifts)
      const deleteGiftBtn = target.closest('.btn-delete-gift[data-gift-id]');
      if (deleteGiftBtn) {
        const giftId = deleteGiftBtn.getAttribute('data-gift-id');
        if (self.callbacks.removeGiftItem) self.callbacks.removeGiftItem(giftId);
        return;
      }

      // Toggle FOC ↔ Extra trên dòng quà/hàng 0đ
      const kindToggleBtn = target.closest('.gift-kind-toggle[data-kind-toggle]');
      if (kindToggleBtn) {
        const id = kindToggleBtn.getAttribute('data-kind-toggle');
        if (self.callbacks.toggleGiftKind) self.callbacks.toggleGiftKind(id);
        return;
      }

      // Size selector buttons (flat MKT options)
      const sizeBtn = target.closest('.size-selector-btn[data-gift-id]');
      if (sizeBtn) {
        const giftId = sizeBtn.getAttribute('data-gift-id');
        const newProductId = sizeBtn.getAttribute('data-product-id');
        if (self.callbacks.updateGiftOverride) self.callbacks.updateGiftOverride(giftId, newProductId);
        return;
      }

      // Hierarchical gift group buttons (Level 1)
      const groupBtn = target.closest('.gift-group-btn[data-gift-id]');
      if (groupBtn) {
        const giftId = groupBtn.getAttribute('data-gift-id');
        const productId = groupBtn.getAttribute('data-product-id');
        const hasSubs = groupBtn.getAttribute('data-has-subs') === '1';
        const defaultSub = groupBtn.getAttribute('data-default-sub');
        const targetProduct = (hasSubs && defaultSub) ? defaultSub : productId;
        if (self.callbacks.updateGiftOverride) self.callbacks.updateGiftOverride(giftId, targetProduct);
        return;
      }

      // Hierarchical gift sub-option buttons (Level 2)
      const subBtn = target.closest('.gift-sub-btn[data-gift-id]');
      if (subBtn) {
        const giftId = subBtn.getAttribute('data-gift-id');
        const productId = subBtn.getAttribute('data-product-id');
        if (self.callbacks.updateGiftOverride) self.callbacks.updateGiftOverride(giftId, productId);
        return;
      }

      // Nút [+] thêm nhanh quà thay thế vào nhóm "1 trong N" của rule nguồn
      const quickAddBtn = target.closest('.btn-gift-quickadd[data-gift-id]');
      if (quickAddBtn) {
        const giftId = quickAddBtn.getAttribute('data-gift-id');
        if (self.callbacks.quickAddGiftOption) self.callbacks.quickAddGiftOption(giftId, quickAddBtn);
        return;
      }

      // Nút "💾 Lưu thành SP" — lưu dòng tự nhập thành sản phẩm danh mục
      const saveCustomBtn = target.closest('.btn-save-custom-as-product[data-save-custom-index]');
      if (saveCustomBtn) {
        const index = parseInt(saveCustomBtn.getAttribute('data-save-custom-index'));
        if (self.callbacks.saveCustomAsProduct) self.callbacks.saveCustomAsProduct(index);
        return;
      }

      // Click-to-copy KV code chips
      const kvBtn = target.closest('.kv-code-copy[data-kv-code]');
      if (kvBtn) {
        const code = kvBtn.getAttribute('data-kv-code');
        if (!code) return;
        const flashCopied = () => {
          kvBtn.classList.add('copied');
          const iconEl = kvBtn.querySelector('.kv-code-icon');
          if (iconEl) {
            const prevIcon = iconEl.textContent;
            iconEl.textContent = '✓';
            setTimeout(() => { iconEl.textContent = prevIcon; kvBtn.classList.remove('copied'); }, 1200);
          }
        };
        const fallbackCopy = () => {
          const ta = document.createElement('textarea');
          ta.value = code; ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select();
          try { document.execCommand('copy'); flashCopied(); showToast(`Đã copy mã KV: ${code}`, 'success'); }
          catch (err) { showToast('Sao chép thất bại, vui lòng copy thủ công', 'error'); }
          document.body.removeChild(ta);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(code).then(() => { flashCopied(); showToast(`Đã copy mã KV: ${code}`, 'success'); }).catch(fallbackCopy);
        } else { fallbackCopy(); }
        return;
      }
    });

    // --- Delegated CHANGE handler for qty and price inputs ---
    tbody.addEventListener('change', (e) => {
      const target = e.target;

      // Quantity change (normal items)
      if (target.matches('.editable-qty[data-qty-index]')) {
        const index = parseInt(target.getAttribute('data-qty-index'));
        const stillFocused = document.activeElement === target;
        if (self.callbacks.updateItemQty) self.callbacks.updateItemQty(index, target.value);
        if (stillFocused) {
          const fresh = document.querySelector(`.editable-qty[data-qty-index="${index}"]`);
          if (fresh) fresh.focus();
        }
        return;
      }

      // Quantity change (gifts)
      if (target.matches('.editable-gift-qty[data-gift-id]')) {
        const giftId = target.getAttribute('data-gift-id');
        const stillFocused = document.activeElement === target;
        if (self.callbacks.updateGiftQty) self.callbacks.updateGiftQty(giftId, target.value);
        if (stillFocused) {
          const fresh = document.querySelector(`.editable-gift-qty[data-gift-id="${giftId}"]`);
          if (fresh) fresh.focus();
        }
        return;
      }

      // Bottle price inputs — event `change` = COMMIT giá (blur ra ngoài / Enter):
      // gọi commitDualPrice để đúng MỘT full rebuild (quà MKT + badge FOC/EXTRA
      // với hàng giá 0 chốt lại). Đang gõ (event `input`) ở dưới vẫn chạy bản light.
      if (target.matches('.editable-price-bottle[data-price-bottle-index]')) {
        const index = parseInt(target.getAttribute('data-price-bottle-index'));
        const restoreSel = getTableFocusRestoreSelector(document.activeElement);
        if (self.callbacks.commitDualPrice) self.callbacks.commitDualPrice(index, 'bottle', target);
        scheduleTableFocusRestore(restoreSel);
        return;
      }

      // Box price inputs — commit giá, xem nhánh bottle ở trên.
      if (target.matches('.editable-price-box[data-price-box-index]')) {
        const index = parseInt(target.getAttribute('data-price-box-index'));
        const restoreSel = getTableFocusRestoreSelector(document.activeElement);
        if (self.callbacks.commitDualPrice) self.callbacks.commitDualPrice(index, 'box', target);
        scheduleTableFocusRestore(restoreSel);
        return;
      }

      // Unit/package selector (product rows)
      if (target.matches('.unit-selector[data-unit-index]')) {
        const index = parseInt(target.getAttribute('data-unit-index'));
        if (self.callbacks.updateItemUnit) self.callbacks.updateItemUnit(index, target.value);
        return;
      }
    });

    // --- Delegated INPUT handler for live price updates and combobox search ---
    tbody.addEventListener('input', (e) => {
      const target = e.target;

      // Bottle price live update
      if (target.matches('.editable-price-bottle[data-price-bottle-index]')) {
        const index = parseInt(target.getAttribute('data-price-bottle-index'));
        if (self.callbacks.updateDualPriceLive) self.callbacks.updateDualPriceLive(index, 'bottle', target);
        return;
      }

      // Box price live update
      if (target.matches('.editable-price-box[data-price-box-index]')) {
        const index = parseInt(target.getAttribute('data-price-box-index'));
        if (self.callbacks.updateDualPriceLive) self.callbacks.updateDualPriceLive(index, 'box', target);
        return;
      }

      // Combobox search
      if (target.matches('.combobox-input[data-combobox-index]')) {
        const index = target.getAttribute('data-combobox-index');
        if (self.callbacks.filterComboboxOptions) self.callbacks.filterComboboxOptions(index, target.value);
        return;
      }
    });

    // --- Delegated FOCUS handler for combobox dropdown ---
    tbody.addEventListener('focusin', (e) => {
      const target = e.target;
      if (target.matches('.combobox-input[data-combobox-index]')) {
        const index = target.getAttribute('data-combobox-index');
        if (self.callbacks.showComboboxDropdown) self.callbacks.showComboboxDropdown(index);
      }
    });

    // --- Delegated KEYDOWN handler: Enter trong combobox → áp dụng tên đã gõ ---
    tbody.addEventListener('keydown', (e) => {
      const target = e.target;
      if (target.matches('.combobox-input[data-combobox-index]') && e.key === 'Enter') {
        e.preventDefault();
        const index = target.getAttribute('data-combobox-index');
        if (self.callbacks.applyComboboxText) self.callbacks.applyComboboxText(index, 'enter');
      }
    });

    // --- Delegated FOCUSOUT: gõ tên rồi tab/click ra ngoài → tự áp dụng hoặc hoàn tác ---
    tbody.addEventListener('focusout', (e) => {
      const target = e.target;
      if (target.matches('.combobox-input[data-combobox-index]')) {
        const index = target.getAttribute('data-combobox-index');
        // Chờ 1 nhịp: click chọn gợi ý (mousedown) chạy TRƯỚC focusout và sẽ re-render;
        // khi đó input mới đã mang tên SP vừa chọn → applyComboboxText tự no-op.
        setTimeout(() => {
          if (self.callbacks.applyComboboxText) self.callbacks.applyComboboxText(index, 'blur');
        }, 150);
      }
    });

    // --- Delegated DRAG & DROP handlers for row reordering ---
    // One listener set on tbody (replaces per-row attachDragHandlers: 6 listeners × N rows).
    // All rows (products and gifts) can be independently reordered using data-row-index.
    let dragSourceRowIndex = null;
    const scrollContainer = tbody.closest('.order-results');

    tbody.addEventListener('dragstart', (e) => {
      const row = e.target.closest ? e.target.closest('.product-row-draggable') : null;
      if (!row || !tbody.contains(row)) return;
      // Don't start drag from interactive elements
      if (e.target.closest('input, button, select, .combobox-dropdown, .combobox-container')) {
        e.preventDefault();
        return;
      }
      const idx = row.getAttribute('data-row-index');
      if (idx === null || idx === '') { e.preventDefault(); return; }
      dragSourceRowIndex = parseInt(idx);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(dragSourceRowIndex));
      // Delay class add so browser captures the row image first
      requestAnimationFrame(() => row.classList.add('dragging'));
      // Prevent auto-scroll during drag
      if (scrollContainer) scrollContainer.classList.add('is-dragging');
      tbody.classList.add('is-dragging');
      document.body.classList.add('is-dragging');
    });

    tbody.addEventListener('dragover', (e) => {
      const row = e.target.closest ? e.target.closest('.product-row-draggable') : null;
      if (!row || !tbody.contains(row)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!row.classList.contains('drag-over')) row.classList.add('drag-over');
    });

    tbody.addEventListener('dragenter', (e) => {
      const row = e.target.closest ? e.target.closest('.product-row-draggable') : null;
      if (!row || !tbody.contains(row)) return;
      e.preventDefault();
      row.classList.add('drag-over');
    });

    tbody.addEventListener('dragleave', (e) => {
      const row = e.target.closest ? e.target.closest('.product-row-draggable') : null;
      if (!row || !tbody.contains(row)) return;
      // Only remove if actually leaving the row (not entering a child)
      if (!row.contains(e.relatedTarget)) {
        row.classList.remove('drag-over');
      }
    });

    tbody.addEventListener('drop', (e) => {
      // Only accept INTERNAL drags started from this table (blocks external
      // text/file drops from being interpreted as row reorders).
      if (dragSourceRowIndex === null) return;
      const row = e.target.closest ? e.target.closest('.product-row-draggable') : null;
      if (!row || !tbody.contains(row)) return;
      e.preventDefault();
      e.stopPropagation();
      row.classList.remove('drag-over');
      // Trust the index captured at dragstart, not arbitrary dataTransfer text
      const fromRowIndex = dragSourceRowIndex;
      const toRowIndex = parseInt(row.getAttribute('data-row-index'));
      if (!isNaN(fromRowIndex) && !isNaN(toRowIndex) && fromRowIndex !== toRowIndex
          && fromRowIndex >= 0 && toRowIndex >= 0) {
        if (self.callbacks.reorderRows) {
          self.callbacks.reorderRows(fromRowIndex, toRowIndex);
        }
      }
      // Dọn state NGAY tại drop: reorderRows re-render bảng → dòng nguồn bị detach
      // khỏi DOM → dragend phát trên node đã gỡ, không bubble tới tbody nữa nên
      // listener dragend bên dưới không chạy được. Không dọn ở đây thì is-dragging
      // kẹt vĩnh viễn → .order-results thành overflow:hidden → phá sticky
      // (#orderSummary + thead th bám nhầm scroll container này).
      clearDragState();
    });

    // Dọn toàn bộ state kéo (idempotent — dragend gọi lại sau drop cũng vô hại)
    const clearDragState = () => {
      dragSourceRowIndex = null;
      tbody.querySelectorAll('.product-row-draggable').forEach(r => {
        r.classList.remove('dragging', 'drag-over');
      });
      if (scrollContainer) scrollContainer.classList.remove('is-dragging');
      tbody.classList.remove('is-dragging');
      document.body.classList.remove('is-dragging');
    };

    tbody.addEventListener('dragend', () => clearDragState());
  },

  /**
   * Binds UI events specifically for order table elements.
   * @deprecated Use initDelegatedTableListeners() instead.
   */
  attachOrderTableListeners() {
    // Delete buttons (normal items)
    document.querySelectorAll('.btn-delete-row[data-remove-index]').forEach(btn => {
      btn.onclick = (e) => {
        const index = parseInt(e.target.getAttribute('data-remove-index'));
        if (this.callbacks.removeOrderItem) this.callbacks.removeOrderItem(index);
      };
    });

    // Delete buttons (gifts)
    document.querySelectorAll('.btn-delete-gift[data-gift-id]').forEach(btn => {
      btn.onclick = (e) => {
        const giftId = e.target.getAttribute('data-gift-id');
        if (this.callbacks.removeGiftItem) this.callbacks.removeGiftItem(giftId);
      };
    });

    // Size selector buttons for MKT gifts with flat options (backward compat)
    document.querySelectorAll('.size-selector-btn[data-gift-id]').forEach(btn => {
      btn.onclick = (e) => {
        const giftId = e.target.getAttribute('data-gift-id');
        const newProductId = e.target.getAttribute('data-product-id');
        if (this.callbacks.updateGiftOverride) {
          this.callbacks.updateGiftOverride(giftId, newProductId);
        }
      };
    });

    // Hierarchical gift group buttons (Level 1)
    document.querySelectorAll('.gift-group-btn[data-gift-id]').forEach(btn => {
      btn.onclick = (e) => {
        const el = e.currentTarget;
        const giftId = el.getAttribute('data-gift-id');
        const productId = el.getAttribute('data-product-id');
        const hasSubs = el.getAttribute('data-has-subs') === '1';
        const defaultSub = el.getAttribute('data-default-sub');
        // If group has sub-options, select the default (first) sub-option; otherwise select group product directly
        const targetProduct = (hasSubs && defaultSub) ? defaultSub : productId;
        if (this.callbacks.updateGiftOverride) {
          this.callbacks.updateGiftOverride(giftId, targetProduct);
        }
      };
    });

    // Hierarchical gift sub-option buttons (Level 2)
    document.querySelectorAll('.gift-sub-btn[data-gift-id]').forEach(btn => {
      btn.onclick = (e) => {
        const el = e.currentTarget;
        const giftId = el.getAttribute('data-gift-id');
        const productId = el.getAttribute('data-product-id');
        if (this.callbacks.updateGiftOverride) {
          this.callbacks.updateGiftOverride(giftId, productId);
        }
      };
    });

    // Click-to-copy KV code chips
    document.querySelectorAll('.kv-code-copy[data-kv-code]').forEach(btn => {
      btn.onclick = (e) => {
        const code = e.currentTarget.getAttribute('data-kv-code');
        if (!code) return;
        const flashCopied = () => {
          btn.classList.add('copied');
          const iconEl = btn.querySelector('.kv-code-icon');
          if (iconEl) {
            const prevIcon = iconEl.textContent;
            iconEl.textContent = '✓';
            setTimeout(() => {
              iconEl.textContent = prevIcon;
              btn.classList.remove('copied');
            }, 1200);
          }
        };
        const fallbackCopy = () => {
          const ta = document.createElement('textarea');
          ta.value = code;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); flashCopied(); showToast(`Đã copy mã KV: ${code}`, 'success'); }
          catch (err) { showToast('Sao chép thất bại, vui lòng copy thủ công', 'error'); }
          document.body.removeChild(ta);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(code)
            .then(() => { flashCopied(); showToast(`Đã copy mã KV: ${code}`, 'success'); })
            .catch(fallbackCopy);
        } else {
          fallbackCopy();
        }
      };
    });

    // Quantity change (normal items)
    document.querySelectorAll('.editable-qty[data-qty-index]').forEach(input => {
      input.onchange = (e) => {
        const index = parseInt(e.target.getAttribute('data-qty-index'));
        // Clicking the number-spinner keeps focus on the input, while Tab or
        // clicking elsewhere moves focus away first. Capture that BEFORE the
        // re-render (which destroys this input) so we only restore focus when
        // the user is still interacting with the field — not when leaving it.
        const stillFocused = document.activeElement === e.target;
        if (this.callbacks.updateItemQty) this.callbacks.updateItemQty(index, e.target.value);
        if (stillFocused) {
          const fresh = document.querySelector(`.editable-qty[data-qty-index="${index}"]`);
          if (fresh) fresh.focus();
        }
      };
    });

    // Quantity change (gifts)
    document.querySelectorAll('.editable-gift-qty[data-gift-id]').forEach(input => {
      input.onchange = (e) => {
        const giftId = e.target.getAttribute('data-gift-id');
        const stillFocused = document.activeElement === e.target;
        if (this.callbacks.updateGiftQty) this.callbacks.updateGiftQty(giftId, e.target.value);
        if (stillFocused) {
          const fresh = document.querySelector(`.editable-gift-qty[data-gift-id="${giftId}"]`);
          if (fresh) fresh.focus();
        }
      };
    });

    // Bottle price inputs
    document.querySelectorAll('.editable-price-bottle[data-price-bottle-index]').forEach(input => {
      input.oninput = (e) => {
        const index = parseInt(e.target.getAttribute('data-price-bottle-index'));
        if (this.callbacks.updateDualPriceLive) this.callbacks.updateDualPriceLive(index, 'bottle', e.target);
      };
      input.onchange = (e) => {
        const index = parseInt(e.target.getAttribute('data-price-bottle-index'));
        if (this.callbacks.updateDualPriceLive) this.callbacks.updateDualPriceLive(index, 'bottle', e.target);
      };
    });

    // Box price inputs
    document.querySelectorAll('.editable-price-box[data-price-box-index]').forEach(input => {
      input.oninput = (e) => {
        const index = parseInt(e.target.getAttribute('data-price-box-index'));
        if (this.callbacks.updateDualPriceLive) this.callbacks.updateDualPriceLive(index, 'box', e.target);
      };
      input.onchange = (e) => {
        const index = parseInt(e.target.getAttribute('data-price-box-index'));
        if (this.callbacks.updateDualPriceLive) this.callbacks.updateDualPriceLive(index, 'box', e.target);
      };
    });

    // Combobox focus/search
    document.querySelectorAll('.combobox-input[data-combobox-index]').forEach(input => {
      input.onfocus = (e) => {
        if (this.callbacks.showComboboxDropdown) this.callbacks.showComboboxDropdown(e.target.getAttribute('data-combobox-index'));
      };
      input.oninput = (e) => {
        if (this.callbacks.filterComboboxOptions) this.callbacks.filterComboboxOptions(e.target.getAttribute('data-combobox-index'), e.target.value);
      };
    });
    // Note: Combobox item mousedown handlers are bound in populateComboboxDropdown()
    // since dropdown items are created lazily on first focus.
  },

  /** Bộ lọc thương hiệu hiện tại của tab Danh Mục (thay dropdown cũ — giờ là chip bar). */
  getCatalogCampaignFilter() {
    return this._catalogCampaignFilter || 'all';
  },

  /** Kiểu xem Danh Mục: 'flat' (một danh sách liền mạch) | 'grouped' (gom theo thương hiệu). */
  getCatalogViewMode() {
    if (!this._catalogViewMode) {
      let mode = null;
      try { mode = localStorage.getItem('catalogViewMode'); } catch (e) { /* môi trường không có storage */ }
      this._catalogViewMode = (mode === 'grouped') ? 'grouped' : 'flat';
    }
    return this._catalogViewMode;
  },

  setCatalogViewMode(mode) {
    this._catalogViewMode = (mode === 'grouped') ? 'grouped' : 'flat';
    try { localStorage.setItem('catalogViewMode', this._catalogViewMode); } catch (e) { /* ignore */ }
    this.renderCatalog(this.getCatalogCampaignFilter());
  },

  /** Tên ngắn của thương hiệu cho chip bấm: từ đầu tiên của tên (bỏ icon emoji), VD "🔥 XVIL - ..." → "XVIL". */
  _catalogBrandLabel(campaign) {
    const name = String((campaign && campaign.name) || '').trim();
    if (!name) return 'SP';
    const stripped = name.replace(/^[\u{1F000}-\u{1FAFF}\u{2190}-\u{27BF}\u{FE0F}]\s*/u, '').trim() || name;
    const beforeDash = stripped.split(/\s+[-–—]\s+/)[0].trim();
    const firstWord = beforeDash.split(/\s+/)[0];
    return (firstWord && firstWord.length >= 2) ? firstWord : beforeDash;
  },

  /**
   * 1 hàng sản phẩm trong Danh Mục — dùng chung cho cả 2 kiểu xem (flat / grouped).
   * opts.brandChip: chèn chip màu thương hiệu đầu dải badge (chỉ khi xem trộn tất cả).
   */
  _catalogRowHtml(key, campaign, p, opts = {}) {
    // Chip màu thương hiệu đầu dải badge — chỉ khi xem trộn tất cả (flat + filter 'all')
    const _brandChipHtml = opts.brandChip
      ? `<span class="catalog-badge catalog-row-brand" data-campaign-key="${key}" title="${escapeHtml(campaign.name)}"><span class="catalog-row-brand-dot" style="background:${campaign.color || '#888'}"></span>${escapeHtml(this._catalogBrandLabel(campaign))}</span>`
      : '';

        let priceHtml = '';
        (p.tiers || []).forEach((t, tIdx) => {
          priceHtml += `<div style="display:flex; justify-content:space-between; align-items:center; gap:4px; margin:4px 0;">
            <input type="text" class="catalog-tier-input" data-product-id="${p.id}" data-tier-idx="${tIdx}" data-field="label" value="${escapeHtml(t.label)}" placeholder="Mốc" style="background:var(--bg-input); border:1px dashed var(--border-color); border-radius:4px; padding:2px 6px; font-size:0.78rem; color:var(--text-secondary); width:95px;" />
            <div style="display:flex; align-items:center; gap:4px;">
              <input type="text" inputmode="numeric" class="catalog-tier-input" data-product-id="${p.id}" data-tier-idx="${tIdx}" data-field="price" value="${formatNumberWithDots(t.price)}" style="background:var(--bg-input); border:1px dashed var(--border-color); border-radius:4px; padding:2px 6px; font-size:0.82rem; font-weight:700; color:var(--accent-blue); width:95px; text-align:right;" />
              <span style="font-size:0.75rem; color:var(--text-tertiary);">/${escapeHtml(p.unit || 'chai')}</span>
              <button class="btn-remove-catalog-tier" data-product-id="${p.id}" data-tier-idx="${tIdx}" style="background:none; border:none; color:var(--text-tertiary); cursor:pointer; font-size:0.85rem;" title="Xóa mốc giá">✕</button>
            </div>
          </div>`;
        });
        priceHtml += `<button class="btn-add-catalog-tier" data-product-id="${p.id}" style="background:none; border:none; color:var(--accent-blue); font-size:0.75rem; cursor:pointer; padding:2px 0;">➕ Thêm mốc giá</button>`;

        let focHtml = '';
        const focRulesLegacy = _productPromoRules(p.id, 'foc').map(_legacyQtyRule);
        focRulesLegacy.forEach((f, fIdx) => {
          const focOptCount = (f.give_product_options || []).length;
          focHtml += `<div style="display:flex; align-items:center; flex-wrap:wrap; gap:4px; font-size:0.75rem; background:rgba(76,175,80,0.08); border: 1px solid rgba(76,175,80,0.2); padding: 4px 6px; border-radius: 4px; margin-top:6px;">
            <span>🎁 Mua</span>
            <input type="number" class="catalog-foc-input" data-product-id="${p.id}" data-foc-idx="${fIdx}" data-field="buy_qty" value="${f.buy_qty}" style="width:45px; background:var(--bg-input); border:1px dashed var(--border-color); border-radius:4px; padding:1px 4px; font-size:0.75rem; color:var(--accent-green); text-align:center;" />
            <select class="catalog-foc-input" data-product-id="${p.id}" data-foc-idx="${fIdx}" data-field="buy_unit" title="Đơn vị tính mốc mua — chọn thùng hoặc đơn vị lẻ (chai/lon/can/tuýp)" style="background:var(--bg-input); border:1px dashed var(--border-color); border-radius:4px; padding:1px 2px; font-size:0.72rem; color:var(--accent-green);">${buildBuyUnitOptionsHtml(f.buy_unit, p.unit)}</select>
            <span>tặng</span>
            <input type="number" class="catalog-foc-input" data-product-id="${p.id}" data-foc-idx="${fIdx}" data-field="give_qty" value="${f.give_qty}" style="width:45px; background:var(--bg-input); border:1px dashed var(--border-color); border-radius:4px; padding:1px 4px; font-size:0.75rem; color:var(--accent-green); text-align:center;" />
            <select class="catalog-foc-input" data-product-id="${p.id}" data-foc-idx="${fIdx}" data-field="give_unit" title="Đơn vị tặng (chọn từ danh sách đơn vị sản phẩm)" style="background:var(--bg-input); border:1px dashed var(--border-color); border-radius:4px; padding:1px 2px; font-size:0.72rem; color:var(--accent-green);">${buildUnitOptionsHtml(f.give_unit || p.unit)}</select>
            ${buildFocGiftPickerHtml(f.give_product || '', key, p.id, {
              sameLabel: `Cùng loại (${p.name})`,
              hiddenClass: 'catalog-foc-input',
              hiddenAttrs: `data-product-id="${p.id}" data-foc-idx="${fIdx}" data-field="give_product"`,
              width: '200px',
              inputStyle: 'width:100%; font-size:0.72rem; background:var(--bg-input); border:1px dashed rgba(76,175,80,0.4); border-radius:4px; padding:1px 6px; color:var(--accent-green);',
            })}
            <button class="btn-catalog-foc-options" data-product-id="${p.id}" data-foc-idx="${fIdx}" title="Cấu hình tặng 1 trong nhiều quà — khi lên đơn sales sẽ bấm chọn 1" style="background:${focOptCount > 1 ? 'rgba(76,175,80,0.25)' : 'none'}; border:1px dashed rgba(76,175,80,0.4); border-radius:4px; padding:1px 6px; font-size:0.72rem; color:var(--accent-green); cursor:pointer; white-space:nowrap;${focOptCount > 1 ? ' font-weight:700;' : ''}">${focOptCount > 1 ? `🎯 ${focOptCount} quà` : '🎯 1 trong N'}</button>
            <button class="btn-catalog-foc-quickadd" data-product-id="${p.id}" data-foc-idx="${fIdx}" title="Thêm nhanh 1 quà thay thế vào nhóm chọn 1 trong N" style="background:none; border:1px dashed rgba(76,175,80,0.4); border-radius:4px; padding:1px 6px; font-size:0.72rem; color:var(--accent-green); cursor:pointer;">➕</button>
            ${buildRuleMoveButtonsHtml('btn-move-catalog-foc', 'data-foc-idx', p.id, fIdx, focRulesLegacy.length)}
            <button class="btn-remove-catalog-foc" data-product-id="${p.id}" data-foc-idx="${fIdx}" style="background:none; border:none; color:var(--accent-green); cursor:pointer; margin-left:auto;" title="Xóa FOC">✕</button>
          </div>`;
        });
        focHtml += `<div style="margin-top:4px;"><button class="btn-add-catalog-foc" data-product-id="${p.id}" style="background:none; border:none; color:var(--accent-green); font-size:0.75rem; cursor:pointer; padding:2px 0;">➕ Thêm khuyến mãi FOC</button></div>`;

        // Per-product MKT gift rules display
        let mktHtml = '';
        const mktRulesLegacy = _productPromoRules(p.id, 'mkt_pp').map(_legacyQtyRule);
        if (mktRulesLegacy.length > 0) {
          mktHtml += `<div style="margin-top:8px; border-top:1px dashed rgba(255,152,0,0.3); padding-top:6px;">`;
          mktHtml += `<div style="font-size:0.75rem; font-weight:700; color:#ff9800; margin-bottom:4px;">🎀 Quà MKT theo sản phẩm <span style="font-weight:400; color:var(--text-tertiary); font-style:italic;">— Chọn quà từ danh mục để đơn hàng tự nhận đúng mã KV</span></div>`;
          mktRulesLegacy.forEach((mktRule, mktIdx) => {
            // Trạng thái liên kết quà ↔ sản phẩm danh mục (3 case legacy):
            // 1) give_product hợp lệ → hiển thị ĐÚNG p.name + badge ✓
            // 2) give_product trỏ SP đã xóa → tên legacy (give_product_name hoặc chính id) + badge ⚠
            // 3) chỉ có give_product_name (tự gõ) → text đó + badge ⚠
            const _linkedGift = mktRule.give_product ? db.findProductById(mktRule.give_product) : null;
            const _giftDisplay = _linkedGift ? _linkedGift.name : (mktRule.give_product_name || mktRule.give_product || '');
            const _giftCode = _linkedGift ? (db.getKvCode(_linkedGift) || _linkedGift.kvCode || '') : '';
            const _giftBadge = _linkedGift
              ? `<span class="mkt-gift-link-badge mkt-gift-linked" title="Đã liên kết sản phẩm trong danh mục: ${escapeHtml(_linkedGift.name)}">✓${_giftCode ? ' ' + escapeHtml(_giftCode) : ''}</span>`
              : `<span class="mkt-gift-link-badge mkt-gift-unlinked" title="Chưa gắn với sản phẩm nào trong danh mục — bấm vào ô tên và chọn 1 sản phẩm cụ thể từ danh sách, hoặc cứ gõ tên tự do">⚠ Chưa liên kết</span>`;
            const _mktOptCount = (mktRule.give_product_options || []).length;
            const _mktOptBtn = `<button class="btn-catalog-mkt-options" data-product-id="${p.id}" data-mkt-idx="${mktIdx}" title="Cấu hình tặng 1 trong nhiều quà — khi lên đơn sales sẽ bấm chọn 1" style="background:${_mktOptCount > 1 ? 'rgba(255,152,0,0.25)' : 'none'}; border:1px dashed rgba(255,152,0,0.4); border-radius:4px; padding:1px 6px; font-size:0.72rem; color:#ff9800; cursor:pointer; white-space:nowrap;${_mktOptCount > 1 ? ' font-weight:700;' : ''}">${_mktOptCount > 1 ? `🎯 ${_mktOptCount} quà để chọn` : '🎯 1 trong N'}</button>`;
            mktHtml += `<div style="display:flex; align-items:center; flex-wrap:wrap; gap:4px; font-size:0.75rem; background:rgba(255,152,0,0.08); border:1px solid rgba(255,152,0,0.2); padding:4px 6px; border-radius:4px; margin-top:4px;">
              <span>🎀 Mua</span>
              <input type="number" class="catalog-mkt-input" data-product-id="${p.id}" data-mkt-idx="${mktIdx}" data-field="buy_qty" value="${mktRule.buy_qty}" style="width:45px; background:var(--bg-input); border:1px dashed rgba(255,152,0,0.4); border-radius:4px; padding:1px 4px; font-size:0.75rem; color:#ff9800; text-align:center;" />
              <select class="catalog-mkt-input" data-product-id="${p.id}" data-mkt-idx="${mktIdx}" data-field="buy_unit" title="Đơn vị tính mốc mua — thùng hay lẻ theo chai/lon/can/tuýp" style="background:var(--bg-input); border:1px dashed rgba(255,152,0,0.4); border-radius:4px; padding:1px 2px; font-size:0.72rem; color:#ff9800;">${buildBuyUnitOptionsHtml(mktRule.buy_unit, p.unit)}</select>
              <span>tặng</span>
              <input type="number" class="catalog-mkt-input" data-product-id="${p.id}" data-mkt-idx="${mktIdx}" data-field="give_qty" value="${mktRule.give_qty}" style="width:45px; background:var(--bg-input); border:1px dashed rgba(255,152,0,0.4); border-radius:4px; padding:1px 4px; font-size:0.75rem; color:#ff9800; text-align:center;" />
              <select class="catalog-mkt-input" data-product-id="${p.id}" data-mkt-idx="${mktIdx}" data-field="give_unit" title="Đơn vị tặng (chọn từ danh sách đơn vị sản phẩm)" style="background:var(--bg-input); border:1px dashed rgba(255,152,0,0.4); border-radius:4px; padding:1px 2px; font-size:0.72rem; color:#ff9800;">${buildUnitOptionsHtml(mktRule.give_unit || 'cái')}</select>
              <div class="catalog-mkt-gift-picker" data-product-id="${p.id}" data-mkt-idx="${mktIdx}" style="flex:1; min-width:150px; max-width:260px;">
                <input type="text" class="mkt-gift-name catalog-mkt-gift-name" data-product-id="${p.id}" data-mkt-idx="${mktIdx}" value="${escapeHtml(_giftDisplay)}" placeholder="Gõ tìm quà trong danh mục..." autocomplete="off" spellcheck="false" title="Gõ để tìm sản phẩm trong danh mục — chọn 1 món để liên kết mã KV; hoặc cứ gõ tên tự do (sẽ mất liên kết)" style="width:100%; background:var(--bg-input); border:1px dashed rgba(255,152,0,0.4); border-radius:4px; padding:1px 6px; font-size:0.75rem; color:#ff9800;" />
                <div class="mkt-gift-suggestions"></div>
              </div>
              ${_giftBadge}
              ${_mktOptBtn}
              <button class="btn-catalog-mkt-quickadd" data-product-id="${p.id}" data-mkt-idx="${mktIdx}" title="Thêm nhanh 1 quà thay thế vào nhóm chọn 1 trong N" style="background:none; border:1px dashed rgba(255,152,0,0.4); border-radius:4px; padding:1px 6px; font-size:0.72rem; color:#ff9800; cursor:pointer;">➕</button>
              <span style="color:var(--text-tertiary); font-style:italic; flex:1; min-width:100px;">${escapeHtml(mktRule.note || '')}</span>
              ${buildRuleMoveButtonsHtml('btn-move-catalog-mkt', 'data-mkt-idx', p.id, mktIdx, mktRulesLegacy.length)}
              <button class="btn-remove-catalog-mkt" data-product-id="${p.id}" data-mkt-idx="${mktIdx}" style="background:none; border:none; color:#ff9800; cursor:pointer;" title="Xóa MKT">✕</button>
            </div>`;
          });
          mktHtml += `</div>`;
        }
        mktHtml += `<div style="margin-top:4px;"><button class="btn-add-catalog-mkt" data-product-id="${p.id}" style="background:none; border:none; color:#ff9800; font-size:0.75rem; cursor:pointer; padding:2px 0;">➕ Thêm quà MKT</button></div>`;

        const tierCount = (p.tiers || []).length;
        const focCount = focRulesLegacy.length;
        const mktCount = mktRulesLegacy.length;
        const focBadgeClass = focCount > 0 ? 'badge-foc-active' : 'badge-foc-zero';
        const focBadgeText = focCount > 0 ? `🎁 ${focCount} FOC` : `${focCount} FOC`;
        const mktBadgeClass = mktCount > 0 ? 'badge-mkt-active' : '';
        const mktBadgeText = mktCount > 0 ? `🎀 ${mktCount} MKT` : '';
        // Badge "sức khỏe" SP: thiếu mã KV / chưa có mốc giá / giá 0đ — phát hiện
        // ngay trong Danh mục thay vì đợi chạy KiotViet mới biết SEARCH_NOT_FOUND.
        const _healthIssues = [];
        if (!db.getKvCode(p)) _healthIssues.push('Thiếu mã KV');
        if (!(p.tiers || []).length) _healthIssues.push('Chưa có mốc giá');
        const _healthBadge = _healthIssues.length
          ? `<span class="catalog-badge" style="background:rgba(244,67,54,0.12); color:#d32f2f; font-weight:700;" title="Cần hoàn thiện: ${_healthIssues.map(escapeHtml).join('; ')}">⚠ ${escapeHtml(_healthIssues.join(' · '))}</span>`
          : '';

        const rowHtml = `<div class="catalog-list-row" data-product-id="${p.id}" data-campaign-key="${key}"${_healthIssues.length ? ' data-needs-attention="1"' : ''} style="border-left: 4px solid ${campaign.color || '#007aff'};">
          <div class="catalog-row-main">
            <button class="btn-toggle-catalog-card" data-product-id="${p.id}" title="Mở/đóng chi tiết">▸</button>
            <div class="catalog-row-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>
            <div class="catalog-row-badges">
              ${opts.brandChip ? _brandChipHtml : ''}
              ${_healthBadge}
              ${p.category ? `<span class="catalog-badge" style="background:rgba(156,39,176,0.12); color:#9c27b0;">${escapeHtml(p.category)}</span>` : ''}
              <span class="catalog-badge packing-multiplier-badge" data-product-id="${p.id}" style="background:rgba(0,122,255,0.14); color:var(--accent-blue); font-weight:700;" title="Hệ số nhân thùng — chỉnh số ở ô Hộp/Thùng trong chi tiết">×${p.box_size || 12}</span>
              ${packagingAutoText(p) ? `<span class="catalog-badge" style="background:rgba(156,39,176,0.08); color:var(--text-secondary);" title="Quy cách đóng thùng — tự sinh theo Hộp/Thùng (×${p.box_size || 12})${p.packaging ? '; chuỗi đóng gói gốc: ' + escapeHtml(p.packaging) : ''}">📦 ${escapeHtml(packagingAutoText(p))}</span>` : ''}
              <span class="catalog-badge badge-tier">${tierCount} mốc giá</span>
              <span class="catalog-badge ${focBadgeClass}">${focBadgeText}</span>
              ${mktCount > 0 ? `<span class="catalog-badge ${mktBadgeClass} btn-toggle-mkt-inline" data-product-id="${p.id}" style="background:rgba(255,152,0,0.15); color:#ff9800; cursor:pointer;" title="Click để sửa quà MKT">${mktBadgeText}</span>` : `<span class="catalog-badge btn-toggle-mkt-inline" data-product-id="${p.id}" style="background:rgba(255,152,0,0.05); color:rgba(255,152,0,0.4); cursor:pointer;" title="Click để thêm quà MKT">🎀 0 MKT</span>`}
            </div>
            <div class="catalog-row-actions">
              <button class="btn-go-to-editor" data-campaign-key="${key}" data-product-id="${p.id}" title="Mở chỉnh sửa sâu (Giá / FOC / Aliases) cho sản phẩm này" style="background:none; border:none; cursor:pointer; font-size:0.85rem;">⚙️</button>
              <button class="btn-delete-catalog-product" data-product-id="${p.id}" data-campaign-key="${key}" title="Xóa sản phẩm">🗑</button>
            </div>
          </div>
          <div class="catalog-mkt-inline" data-mkt-product-id="${p.id}" style="display:none; margin: 4px 0 4px 28px; padding: 8px 10px; background:rgba(255,152,0,0.05); border:1px solid rgba(255,152,0,0.15); border-radius:6px;">
            <div style="font-size:0.75rem; font-weight:700; color:#ff9800; margin-bottom:6px;">🎀 Quà MKT — ${escapeHtml(p.name)}</div>
            ${mktHtml}
          </div>
          <div class="catalog-card-detail" data-detail-id="${p.id}" style="display:none;">
            <div style="font-size:0.8rem; color:var(--text-tertiary); margin: 0 0 8px 0; display:flex; align-items:center; flex-wrap:wrap; gap:4px;">
              <span>Tên:</span>
              <input type="text" class="catalog-product-input" data-product-id="${p.id}" data-field="name" value="${escapeHtml(p.name)}" placeholder="Tên sản phẩm" style="font-weight:700; font-size:0.9rem; color:var(--text-primary); background:var(--bg-input); border:1px dashed var(--border-color); border-radius:4px; padding:3px 6px; flex:1; min-width:200px;" title="Chỉnh sửa tên sản phẩm" />
              <span>· Đơn vị:</span>
              <input type="text" class="catalog-product-input" data-product-id="${p.id}" data-field="unit" value="${escapeHtml(p.unit || 'chai')}" style="font-size:0.75rem; background:var(--bg-secondary); border:1px dashed var(--border-color); padding:2px 6px; border-radius:12px; color:var(--text-secondary); width:60px; text-align:center;" title="Chỉnh sửa đơn vị" />
              <span>· Spec:</span>
              <input type="text" class="catalog-product-input" data-product-id="${p.id}" data-field="spec" value="${escapeHtml(p.spec || '')}" placeholder="N/A" style="background:var(--bg-input); border:1px dashed var(--border-color); border-radius:4px; padding:1px 5px; width:95px; font-size:0.78rem; color:var(--text-primary);" />
              <span>· Đóng gói:</span>
              <input type="text" class="catalog-product-input" data-product-id="${p.id}" data-field="packaging" value="${escapeHtml(p.packaging || '')}" placeholder="VD: 4 Kit/ Thùng" style="background:var(--bg-input); border:1px dashed var(--border-color); border-radius:4px; padding:1px 5px; width:110px; font-size:0.78rem; color:var(--text-primary);" title="Đóng gói (mô tả — chỉ để hiển thị, KHÔNG tham gia nhân)" />
              <span>· Mã KV:</span>
              <input type="text" class="catalog-product-input" data-product-id="${p.id}" data-field="kvCode" value="${escapeHtml(p.kvCode || '')}" placeholder="" style="background:var(--bg-input); border:1px dashed var(--border-color); border-radius:4px; padding:1px 5px; width:100px; font-size:0.78rem; color:var(--accent-blue); font-family:monospace;" title="Mã KiotViet của đơn vị lẻ (chai/bình/lon...). Mã THÙNG được tự phân: mã gốc + '-1'" />
              ${(() => { const tk = db.getKvCode(p, 'thùng'); const le = db.getKvCode(p, p.unit || 'chai'); return (tk && tk !== le) ? `<span style="color:var(--text-tertiary); font-size:0.75rem;">· KV thùng:</span><input type="text" class="catalog-product-input" data-product-id="${p.id}" data-field="kvCodeThung" value="${escapeHtml(tk)}" placeholder="${escapeHtml(le + '-1')}" style="width:115px; background:rgba(0,122,255,0.07); border:1px solid rgba(0,122,255,0.28); border-radius:4px; padding:1px 5px; font-size:0.78rem; color:var(--accent-blue); font-family:monospace;" title="Mã KV của THÙNG — mặc định TỰ ĐỘNG: mã gốc + '-1' (1 thùng = ${p.box_size || 12} ${p.unit || 'chai'}). Sửa để GHI ĐÈ mã riêng; xóa trống để quay về tự động" />` : ''; })()}
              <span>· Hộp/Thùng:</span>
              <input type="number" class="catalog-product-input" data-product-id="${p.id}" data-field="box_size" value="${p.box_size || 12}" style="background:var(--bg-input); border:1px dashed var(--border-color); border-radius:4px; padding:1px 5px; width:50px; font-size:0.78rem; color:var(--text-primary); font-weight:700;" title="Hệ số nhân khi đặt theo thùng (1 thùng = N đơn vị lẻ) — CHỈNH SỐ NÀY để thay đổi phép nhân" min="1" />
              <span>· Nhóm:</span>
              <input type="text" class="catalog-product-input" data-product-id="${p.id}" data-field="category" value="${escapeHtml(p.category || '')}" placeholder="Nhóm hàng" list="categorySuggestions" style="background:var(--bg-input); border:1px dashed var(--border-color); border-radius:4px; padding:1px 5px; width:110px; font-size:0.78rem; color:var(--text-primary);" title="Nhóm hàng / Phân loại" />
            </div>
            ${buildPackageSiblingsHtml(p)}
            <div style="border-top:1px solid var(--border-color); padding-top:8px;">
              ${priceHtml}
            </div>
            ${focHtml}
            ${mktHtml}
            <div style="margin-top: 10px; display:flex; justify-content:flex-end;">
              <button class="btn btn-ghost btn-xs btn-go-to-editor" data-campaign-key="${key}" data-product-id="${p.id}" style="font-size:0.75rem; color: var(--accent-blue);">⚙️ Chỉnh sửa sâu Giá / FOC / Aliases →</button>
            </div>
          </div>
        </div>`;
        return rowHtml;
  },

  /**
   * Khối "Quà MKT thương hiệu" (promoRule total / scope campaign) — dùng chung cho
   * kiểu xem gom theo thương hiệu lẫn kiểu xem phẳng (gom vào details đầu danh sách).
   */
  _campaignMktStripHtml(campaign) {
    // Campaign-level MKT gifts summary
    let strip = '';
    const campMktRules = (campaign.promoRules || []).filter(r => r && r.type === 'total' && r.scope === 'campaign');
    if (campMktRules.length > 0) {
      strip = `<div class="catalog-mkt-strip" style="margin: 0 0 10px 0; padding: 8px 12px; background: linear-gradient(135deg, rgba(255,152,0,0.08), rgba(255,152,0,0.03)); border: 1px solid rgba(255,152,0,0.2); border-radius: 8px; font-size: 0.78rem;">`;
      strip += `<div style="font-weight:700; color:#ff9800; margin-bottom:6px;">🎀 Quà MKT thương hiệu (theo tổng đơn hàng)</div>`;
      campMktRules.forEach(rule => {
        const t = rule.threshold || {};
        const icon = (t.basis === 'boxes' || rule.unit === 'boxes') ? '📦' : '💰';
        const items = normalizeMktGiftItems(rule).filter(g => g.name);
        // Phân ra từng vật phẩm rõ ràng: mỗi quà là 1 chip "SL × tên quà" + badge liên kết danh mục
        // (badge dùng ĐÚNG convention của Settings/_buildMktRulesHtml: ✓ + p.kvCode; class tái dụng)
        const chipsHtml = items.length > 0
          ? items.map(g => {
              const _chipProd = g.product_id ? db.findProductById(g.product_id) : null;
              const _chipCode = _chipProd ? (db.getKvCode(_chipProd) || _chipProd.kvCode || '') : '';
              const _chipBadge = _chipProd
                ? `<span class="mkt-gift-link-badge mkt-gift-linked" title="Đã liên kết sản phẩm trong danh mục: ${escapeHtml(_chipProd.name)}">✓${_chipCode ? ' ' + escapeHtml(_chipCode) : ''}</span>`
                : `<span class="mkt-gift-link-badge mkt-gift-unlinked" title="Chưa liên kết sản phẩm danh mục">⚠</span>`;
              const _chipOptCount = (g.give_product_options || []).length;
              const _chipOptBadge = _chipOptCount > 1
                ? `<span class="mkt-gift-link-badge mkt-gift-linked" title="Quà có ${_chipOptCount} lựa chọn khi lên đơn (chọn 1 trong ${_chipOptCount})">🎯 ${_chipOptCount}</span>`
                : '';
              return `<span class="mkt-gift-chip" style="display:inline-flex; align-items:center; gap:3px; background:rgba(255,152,0,0.14); border:1px solid rgba(255,152,0,0.32); border-radius:10px; padding:1px 8px; font-weight:600; white-space:nowrap;"><strong>${g.qty}</strong>&nbsp;×&nbsp;${escapeHtml(g.name)}${_chipBadge}${_chipOptBadge}</span>`;
            }).join('')
          : `<span style="color:var(--text-tertiary); font-style:italic;">Chưa có quà</span>`;
        const displayLabel = rule.label || db._buildPromoLabel(rule) || '';
        strip += `<div style="display:flex; gap:6px; align-items:flex-start; margin:4px 0; color:var(--text-secondary); flex-wrap:wrap;">
          <span>${icon}</span>
          <span style="font-weight:600; min-width:60px; color:var(--text-primary);">${escapeHtml(displayLabel)}</span>
          <span style="display:inline-flex; flex-wrap:wrap; gap:4px; align-items:center;">→ ${chipsHtml}</span>
        </div>`;
      });
      strip += `</div>`;
    }
    return strip;
  },

  /**
   * Renders the product catalog tab.
   */
  renderCatalog(filterKey = 'all') {
    // [EditTracker] Commit mọi chỉnh sửa chưa lưu TRƯỚC khi vẽ lại để re-render
    // không bao giờ nuốt mất dữ liệu user đang nhập (hook từ src/edit-tracker.js).
    if (typeof window !== 'undefined' && typeof window.__oaCommitPendingEdits === 'function') {
      window.__oaCommitPendingEdits();
    }
    clearRenderCache();
    const container = document.getElementById('catalogContent');
    const categoryFilter = document.getElementById('catalogCategoryFilter');
    if (!container) return;

    const campaigns = db.data.campaigns || {};

    // Bộ lọc trỏ vào thương hiệu đã bị xóa (ví dụ vừa xóa trong Cài Đặt) → quay về "Tất cả",
    // tránh skip toàn bộ sản phẩm trong khi chip bar vẫn sáng chip đã mất
    if (filterKey !== 'all' && !campaigns[filterKey]) filterKey = 'all';
    this._catalogCampaignFilter = filterKey;

    // Thống kê per-thương hiệu (cho chip bar): số SP + số SP "cần hoàn thiện"
    // (thiếu mã KV / chưa có mốc giá — cùng tiêu chí filter __needs_attention)
    const campStats = {};
    let totalAll = 0;
    let totalNeeds = 0;
    for (const [cKey, cData] of Object.entries(campaigns)) {
      let needs = 0;
      for (const p of (cData.products || [])) {
        const _tiers = Array.isArray(p.tiers) ? p.tiers : [];
        if (!db.getKvCode(p) || !_tiers.length) needs++;
      }
      campStats[cKey] = { count: (cData.products || []).length, needs };
      totalAll += campStats[cKey].count;
      totalNeeds += needs;
    }

    // Chip bar lọc thương hiệu (thay dropdown cũ): "Tất cả" + 1 chip/thương hiệu
    // (dot màu + số SP + số ⚠ cần hoàn thiện) — bấm chip = lọc ngay, một cái nhìn
    // tổng quan mọi thương hiệu thay vì phải mở dropdown lần lượt.
    const chipsEl = document.getElementById('catalogBrandChips');
    if (chipsEl) {
      const chipParts = [];
      chipParts.push(`<button type="button" class="catalog-brand-chip${filterKey === 'all' ? ' active' : ''}" data-filter="all" title="Xem sản phẩm của mọi thương hiệu trong một danh sách liền mạch">Tất cả <span class="chip-count">${totalAll}</span>${totalNeeds ? ` <span class="chip-warn" title="${totalNeeds} SP cần hoàn thiện (thiếu mã KV / chưa có mốc giá)">⚠ ${totalNeeds}</span>` : ''}</button>`);
      for (const [key, campaign] of Object.entries(campaigns)) {
        const st = campStats[key] || { count: 0, needs: 0 };
        chipParts.push(`<button type="button" class="catalog-brand-chip${filterKey === key ? ' active' : ''}" data-filter="${key}" style="--chip-color:${campaign.color || '#007aff'}" title="${escapeHtml(campaign.name)} — ${st.count} sản phẩm"><span class="chip-dot" style="background:${campaign.color || '#007aff'}"></span>${escapeHtml(this._catalogBrandLabel(campaign))} <span class="chip-count">${st.count}</span>${st.needs ? ` <span class="chip-warn" title="${st.needs} SP cần hoàn thiện (thiếu mã KV / chưa có mốc giá)">⚠ ${st.needs}</span>` : ''}</button>`);
      }
      chipsEl.innerHTML = chipParts.join('');
      chipsEl.onclick = (e) => {
        const chip = e.target.closest('.catalog-brand-chip');
        if (!chip) return;
        const next = chip.getAttribute('data-filter');
        if (next !== filterKey) this.renderCatalog(next);
      };
    }

    // Sync nút toggle kiểu xem (phẳng / gom) với mode hiện tại + quyết định chip brand trên row
    const viewMode = this.getCatalogViewMode();
    const flatBtn = document.getElementById('catalogViewFlat');
    const groupedBtn = document.getElementById('catalogViewGrouped');
    if (flatBtn) flatBtn.classList.toggle('active', viewMode === 'flat');
    if (groupedBtn) groupedBtn.classList.toggle('active', viewMode === 'grouped');
    // Chip màu thương hiệu trên từng hàng chỉ cần khi đang xem trộn tất cả
    const showBrandChipOnRows = filterKey === 'all';

    // Populate category filter dropdown (+ mục "Cần hoàn thiện" lọc SP thiếu mã KV/chưa có mốc giá)
    const allCats = getAllCategories();
    if (categoryFilter) {
      let needsAttentionCount = 0;
      for (const [cKey] of Object.entries(campaigns)) {
        if (filterKey !== 'all' && cKey !== filterKey) continue;
        needsAttentionCount += (campStats[cKey] || { needs: 0 }).needs;
      }
      const prevCat = categoryFilter.value || 'all';
      categoryFilter.innerHTML = `<option value="all">Tất cả nhóm hàng</option><option value="__needs_attention">⚠ Cần hoàn thiện (${needsAttentionCount})</option>`;
      allCats.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = c;
        categoryFilter.appendChild(opt);
      });
      categoryFilter.value = (prevCat === '__needs_attention' || allCats.includes(prevCat)) ? prevCat : 'all';
      categoryFilter.onchange = () => {
        this.renderCatalog(this.getCatalogCampaignFilter());
      };
    }
    const activeCategory = categoryFilter ? categoryFilter.value : 'all';

    // Update datalist for category autocomplete
    const datalistEl = document.getElementById('categorySuggestions');
    if (datalistEl) {
      datalistEl.innerHTML = allCats.map(c => `<option value="${escapeHtml(c)}">`).join('');
    }

    // Giữ nguyên từ khóa tìm kiếm giữa các lần render
    const rawQuery = (this._catalogSearch || '').trim();
    const normQuery = rawQuery.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');

    // Sync static search bar (never destroyed → typing stays native)
    const staticSearchEl = document.getElementById('catalogSearchInput');
    if (staticSearchEl && document.activeElement !== staticSearchEl && staticSearchEl.value !== (this._catalogSearch || '')) {
      staticSearchEl.value = this._catalogSearch || '';
    }
    const staticClearBtn = document.getElementById('catalogSearchClear');
    if (staticClearBtn) staticClearBtn.classList.toggle('hidden', !(this._catalogSearch || ''));

    container.innerHTML = '';
    const fragment = document.createDocumentFragment();
    let totalProductsCount = 0;

    // Predicate lọc 1 SP theo filter hiện hành (nhóm hàng / "Cần hoàn thiện" / fuzzy search)
    const matchesProduct = (p) => {
      // Lọc "Cần hoàn thiện": SP thiếu mã KV hoặc chưa có mốc giá
      if (activeCategory === '__needs_attention') {
        const _tiers = Array.isArray(p.tiers) ? p.tiers : [];
        const _needs = !db.getKvCode(p) || !_tiers.length;
        if (!_needs) return false;
      } else if (activeCategory !== 'all' && (p.category || '') !== activeCategory) return false;
      // Lọc theo từ khóa tìm kiếm (fuzzy: mỗi token chỉ cần là chuỗi con của bất kỳ từ nào)
      if (normQuery) {
        // Bao gồm cả mã KV đã resolve (kv-name-map.json thắng inline) + mã thùng để tìm theo mã luôn đúng
        const hay = ((p.name || '') + ' ' + (p.spec || '') + ' ' + (p.kvCode || '') + ' ' + db.getKvCode(p) + ' ' + db.getKvCode(p, 'thùng') + ' ' + (p.category || '') + ' ' + (p.packaging || '')).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
        if (fuzzySearchScore(normQuery, hay) <= 0) return false;
      }
      return true;
    };

    const scopedCampaigns = Object.entries(campaigns).filter(([key]) => filterKey === 'all' || key === filterKey);

    if (viewMode === 'grouped') {
      // ── Kiểu xem "gom theo thương hiệu": mỗi thương hiệu 1 section (như bản cũ) ──
      for (const [key, campaign] of scopedCampaigns) {
        const section = document.createElement('div');
        section.style.marginBottom = 'var(--space-lg)';

        let productsHtml = '';
        let shownCount = 0;
        (campaign.products || []).forEach(p => {
          if (!matchesProduct(p)) return;
          totalProductsCount++;
          shownCount++;
          productsHtml += this._catalogRowHtml(key, campaign, p, { brandChip: showBrandChipOnRows });
        });

        // Ẩn cả section khi đang lọc (tìm kiếm HOẶC nhóm hàng/cần hoàn thiện) mà
        // không có sản phẩm nào khớp — đừng hiện header + danh sách rỗng gây hiểu nhầm
        if ((normQuery || activeCategory !== 'all') && shownCount === 0) continue;

        const campMktCount = (campaign.promoRules || []).filter(r => r && r.type === 'total' && r.scope === 'campaign').length;
        const mktStrip = campMktCount > 0
          ? `<details class="catalog-mkt-summary catalog-mkt-summary-inline">
              <summary><span class="catalog-mkt-summary-title">Quà MKT thương hiệu</span><span class="catalog-mkt-summary-count">${campMktCount} mốc</span></summary>
              ${this._campaignMktStripHtml(campaign)}
            </details>`
          : '';

        section.innerHTML = `
        <div style="display:flex; align-items:center; gap:8px; margin-bottom: 12px; border-bottom: 2px solid ${campaign.color || '#ccc'}; padding-bottom: 6px;">
          <span style="font-size:1.4rem;">${escapeHtml(campaign.icon || '📦')}</span>
          <h3 style="margin:0; font-size:1.1rem; color:var(--text-primary);">${escapeHtml(campaign.name)}</h3>
          ${(normQuery || activeCategory !== 'all')
            ? `<span style="font-size:0.8rem; background:rgba(0,122,255,0.12); color:var(--accent-blue); padding:2px 8px; border-radius:10px; font-weight:700;" title="Số sản phẩm khớp bộ lọc / tổng số">${shownCount}/${(campaign.products || []).length} khớp</span>`
            : `<span style="font-size:0.8rem; background:rgba(0,0,0,0.05); padding:2px 8px; border-radius:10px;">${(campaign.products || []).length} sản phẩm</span>`}
          ${campMktCount > 0 ? `<span style="font-size:0.78rem; background:rgba(255,152,0,0.12); color:#ff9800; padding:2px 8px; border-radius:10px;">🎀 ${campMktCount} MKT</span>` : ''}
          <button class="btn btn-ghost btn-xs btn-add-catalog-product" data-campaign-key="${key}" style="margin-left:auto; font-size:0.78rem; color:var(--accent-green);">➕ Thêm sản phẩm</button>
        </div>
        ${mktStrip}
        <div class="catalog-list">
          ${productsHtml}
        </div>
      `;
        fragment.appendChild(section);
      }
    } else {
      // ── Kiểu xem phẳng (mặc định): MỘT danh sách liền mạch mọi thương hiệu.
      // Chip màu thương hiệu trên từng hàng phân biệt brand; quà MKT thương hiệu
      // (theo tổng đơn) gom vào 1 khối gập trên đầu, nhường chỗ cho kết quả tìm kiếm.
      let mktStrips = '';
      let mktRuleCount = 0;
      if (!normQuery && activeCategory === 'all') {
        for (const [, campaign] of scopedCampaigns) {
          mktRuleCount += (campaign.promoRules || []).filter(r => r && r.type === 'total' && r.scope === 'campaign').length;
          mktStrips += this._campaignMktStripHtml(campaign);
        }
      }
      if (mktStrips) {
        const mktBox = document.createElement('details');
        mktBox.className = 'catalog-mkt-summary';
        mktBox.innerHTML = `<summary><span class="catalog-mkt-summary-title">Quà MKT thương hiệu</span><span class="catalog-mkt-summary-count">${mktRuleCount} mốc</span></summary>${mktStrips}`;
        fragment.appendChild(mktBox);
      }
      const flatList = document.createElement('div');
      flatList.className = 'catalog-list';
      let flatHtml = '';
      for (const [key, campaign] of scopedCampaigns) {
        for (const p of (campaign.products || [])) {
          if (!matchesProduct(p)) continue;
          totalProductsCount++;
          flatHtml += this._catalogRowHtml(key, campaign, p, { brandChip: showBrandChipOnRows });
        }
      }
      flatList.innerHTML = flatHtml;
      fragment.appendChild(flatList);
    }

    if (totalProductsCount === 0) {
      container.appendChild(fragment);
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = '<h3>Không tìm thấy sản phẩm nào</h3>';
      container.appendChild(empty);
    } else {
      container.appendChild(fragment);
    }

    // Catalog interactive events are now handled via event delegation
    // (initCatalogDelegation in app.js), so no per-render listener binding needed.

    // Mark catalog as rendered so tab-switch can skip re-render
    if (typeof window !== 'undefined') window._catalogNeedsRender = false;
  },

  /**
   * Renders the Settings campaign list in sidebar.
   */
  renderSettingsSidebar(selectedKey = null) {
    const container = document.getElementById('settingsCampaignList');
    if (!container) return;
    container.innerHTML = '';

    const fragment = document.createDocumentFragment();
    
    // Add campaign button
    const addBtn = document.createElement('button');
    addBtn.className = 'campaign-list-item add-campaign-btn';
    addBtn.id = 'btnShowAddCampaign';
    addBtn.innerHTML = '<span>➕ Thêm thương hiệu</span>';
    fragment.appendChild(addBtn);

    for (const [key, campaign] of Object.entries(db.data.campaigns || {})) {
      const item = document.createElement('div');
      item.className = `campaign-list-item ${selectedKey === key ? 'active' : ''}`;
      item.setAttribute('data-campaign-key', key);

      // Visual indicator color
      const color = campaign.color || '#666';

      const productCount = (campaign.products || []).length;
      // MKT rules count (type='total', scope='campaign')
      const mktCount = (campaign.promoRules || []).filter(r => r.type === 'total' && r.scope === 'campaign').length;
      // Promo text rules count
      const ptCount = (campaign.promoTextRules || []).length;
      // Products needing attention
      let needsCount = 0;
      for (const p of (campaign.products || [])) {
        const _tiers = Array.isArray(p.tiers) ? p.tiers : [];
        if (!db.getKvCode(p) || !_tiers.length || _tiers.every(t => !(Number(t.price) > 0))) needsCount++;
      }

      // Sub-line with MKT/KM counts + health warning
      const subParts = [];
      if (mktCount > 0) subParts.push(`${mktCount} MKT`);
      if (ptCount > 0) subParts.push(`${ptCount} KM`);
      if (needsCount > 0) subParts.push(`<span style="color:var(--danger, #ef5350)">⚠ ${needsCount}</span>`);
      const subLine = subParts.length ? `<span class="campaign-sub-count">${subParts.join(' · ')}</span>` : '';

      item.innerHTML = `<span class="campaign-color-dot" style="background:${color}"></span>
        <span class="campaign-name">${escapeHtml(campaign.icon || '📦')} ${escapeHtml(campaign.name)}</span>
        <span class="campaign-count">${productCount} SP</span>
        ${subLine}
        <button class="delete-campaign-btn" data-delete-campaign="${key}" title="Xóa thương hiệu này">✕</button>`;

      fragment.appendChild(item);
    }
    
    container.appendChild(fragment);

    if (typeof window.attachSettingsSidebarListeners === 'function') {
      window.attachSettingsSidebarListeners();
    }
  },

  /**
   * Dựng HTML card "chỉnh sửa sâu" cho MỘT sản phẩm — dùng chung cho danh sách
   * trong Settings Editor và modal mở trực tiếp từ Catalog (nút ⚙️).
   */
  buildProductCardHtml(campaignKey, p) {
    // Render Tiers
    let tiersHtml = '';
    (p.tiers || []).forEach((t, tIdx) => {
      tiersHtml += `<div class="tier-row" data-product-id="${p.id}" data-tier-idx="${tIdx}">
        <input type="text" value="${escapeHtml(t.label)}" placeholder="Nhãn (VD: 1-5 thùng)" class="tier-label-input" />
        <input type="number" value="${t.min_qty}" placeholder="Min Qty" class="tier-min-input" style="width:70px;" />
        <input type="number" value="${t.max_qty}" placeholder="Max Qty" class="tier-max-input" style="width:70px;" />
        <input type="text" inputmode="numeric" value="${formatNumberWithDots(t.price)}" placeholder="Giá (VND)" class="tier-price-input" style="width:110px; text-align:right;" />
        <button class="btn btn-ghost btn-sm btn-remove-tier" data-product-id="${p.id}" data-tier-idx="${tIdx}">✕</button>
      </div>`;
    });

    // Render FOC Rules
    let focHtml = '';
    const focRulesLegacy = _productPromoRules(p.id, 'foc').map(_legacyQtyRule);
    focRulesLegacy.forEach((f, fIdx) => {
      const _focOptCount = (f.give_product_options || []).length;
      focHtml += `<div class="foc-row promo-rule-draggable" data-product-id="${p.id}" data-foc-idx="${fIdx}" draggable="true">
        ${buildPromoDragHandleHtml()}
        <span style="font-size:0.82rem;color:var(--text-secondary)">Mua</span>
        <input type="number" value="${f.buy_qty}" placeholder="Mua Qty" class="foc-buy-input" style="width:60px;" />
        <select class="foc-buyunit-input" style="width:70px;" title="Đơn vị tính mốc mua — thùng hoặc đơn vị lẻ (chai/lon/can/tuýp)">${buildBuyUnitOptionsHtml(f.buy_unit, p.unit)}</select>
        <span style="font-size:0.82rem;color:var(--text-secondary)">Tặng</span>
        <input type="number" value="${f.give_qty}" placeholder="Tặng Qty" class="foc-give-input" style="width:60px;" />
        <select class="foc-unit-input" style="width:90px;" title="Đơn vị tặng (chọn từ danh sách đơn vị sản phẩm)">${buildUnitOptionsHtml(f.give_unit || '')}</select>
        ${buildFocGiftPickerHtml(f.give_product || '', campaignKey, p.id)}
        <button class="btn btn-ghost btn-xs btn-foc-gift-options" data-product-id="${p.id}" data-foc-idx="${fIdx}" title="Cấu hình tặng 1 trong nhiều quà — khi lên đơn sales sẽ bấm chọn 1" style="${_focOptCount > 1 ? 'font-weight:700; color:var(--accent-green);' : ''}">${_focOptCount > 1 ? `🎯 ${_focOptCount} quà` : '🎯 1 trong N'}</button>
        <button class="btn btn-ghost btn-xs btn-foc-gift-quickadd" data-product-id="${p.id}" data-foc-idx="${fIdx}" title="Thêm nhanh 1 quà thay thế vào nhóm chọn 1 trong N">➕</button>
        <input type="text" value="${escapeHtml(f.note || '')}" placeholder="Ghi chú" class="foc-note-input" />
        <button class="btn btn-ghost btn-sm btn-remove-foc" data-product-id="${p.id}" data-foc-idx="${fIdx}">✕</button>
      </div>`;
    });

    // Render aliases tags — mọi alias đều xóa được (kể cả alias mặc định)
    const aliasesList = db.getAliasesForProduct(p.id);
    let aliasTagsHtml = '';
    aliasesList.forEach(a => {
      aliasTagsHtml += `<span class="alias-tag">
        ${escapeHtml(a.alias)}
        <button class="btn-remove-alias" data-alias="${escapeHtml(a.alias)}" data-product-id="${p.id}" title="Xóa alias này">✕</button>
      </span>`;
    });

    return `<div class="product-item-card" id="product-card-${p.id}">
      <div class="product-item-header">
        <div class="product-info-col">
          <div class="product-item-name">
            <input type="text" value="${escapeHtml(p.name)}" class="input-field product-field-input product-name-edit-input" data-field="name" data-product-id="${p.id}" />
            <span class="product-item-id">(${escapeHtml(p.id)})</span>
          </div>
          <div class="product-meta-group">
            <div class="meta-field">
              <label>Quy cách</label>
              <input type="text" value="${escapeHtml(p.spec || '')}" class="input-field product-field-input" data-field="spec" data-product-id="${p.id}" />
            </div>
            <div class="meta-field">
              <label style="display:flex; align-items:center; gap:4px;">
                Đóng gói
                <span class="packing-multiplier-badge" data-product-id="${p.id}" title="Hệ số nhân khi đặt theo thùng — chỉnh số ở ô Hộp/Thùng bên phải" style="background:rgba(0,122,255,0.14); color:var(--accent-blue); font-size:0.72rem; font-weight:700; padding:1px 6px; border-radius:10px;">×${p.box_size || 12}</span>
              </label>
              <input type="text" value="${escapeHtml(p.packaging || '')}" class="input-field product-field-input" data-field="packaging" data-product-id="${p.id}" placeholder="VD: 4 Kit/ Thùng" title="Mô tả đóng gói (text — chỉ để hiển thị, KHÔNG tham gia nhân)" />
            </div>
            <div class="meta-field">
              <label>Hộp/Thùng</label>
              <input type="number" value="${p.box_size || 12}" class="input-field product-field-input" data-field="box_size" data-product-id="${p.id}" title="Hệ số nhân khi đặt theo thùng (1 thùng = N đơn vị lẻ) — CHỈNH SỐ NÀY để thay đổi phép nhân" min="1" />
            </div>
            <div class="meta-field">
              <label>Đơn vị</label>
              <input type="text" value="${escapeHtml(p.unit || 'chai')}" class="input-field product-field-input" data-field="unit" data-product-id="${p.id}" />
            </div>
            <div class="meta-field">
              <label>Mã KV</label>
              <input type="text" value="${escapeHtml(p.kvCode || '')}" class="input-field product-field-input" data-field="kvCode" data-product-id="${p.id}" style="font-family:monospace; color:var(--accent-blue);" title="Mã KiotViet của đơn vị lẻ (chai/bình/lon...). Mã THÙNG được tự phân: mã gốc + '-1'" />
              ${(() => { const tk = db.getKvCode(p, 'thùng'); const le = db.getKvCode(p, p.unit || 'chai'); return (tk && tk !== le) ? `<input type="text" value="${escapeHtml(tk)}" class="input-field product-field-input" data-field="kvCodeThung" data-product-id="${p.id}" placeholder="${escapeHtml(le + '-1')}" style="margin-top:4px; width:100%; background:rgba(0,122,255,0.07); border:1px solid rgba(0,122,255,0.28); border-radius:4px; padding:2px 6px; font-size:0.75rem; color:var(--accent-blue); font-family:monospace;" title="Mã KV của THÙNG — mặc định TỰ ĐỘNG: mã gốc + '-1' (1 thùng = ${p.box_size || 12} ${p.unit || 'chai'}). Sửa để GHI ĐÈ mã riêng; xóa trống để quay về tự động" />` : ''; })()}
            </div>
            <div class="meta-field">
              <label>Nhóm hàng</label>
              <input type="text" value="${escapeHtml(p.category || '')}" class="input-field product-field-input" data-field="category" data-product-id="${p.id}" list="categorySuggestions" placeholder="VD: Dầu xe máy, Phụ gia..." />
            </div>
          </div>
          ${buildPackageSiblingsHtml(p)}
        </div>
        <button class="btn btn-outline-danger btn-sm btn-delete-product" data-product-id="${p.id}">🗑️ Xóa</button>
      </div>

      <div class="editor-section" data-section="aliases">
        <div class="section-header" onclick="this.closest('.editor-section').toggleAttribute('data-collapsed')">
          <span class="section-toggle">▼</span>
          <span class="section-sub-title">🏷️ Tên gọi tắt (Aliases)</span>
        </div>
        <div class="section-content">
          <div class="alias-tags-container">
            ${aliasTagsHtml}
            <button class="btn btn-ghost btn-xs btn-add-alias" data-product-id="${p.id}">➕ Thêm Alias</button>
            <div class="alias-input-wrapper" data-product-id="${p.id}" style="display:none;">
              <input type="text" class="input-field alias-inline-input" placeholder="Nhập alias mới..." data-product-id="${p.id}" />
              <button class="btn btn-success btn-xs btn-confirm-alias" data-product-id="${p.id}">✓</button>
              <button class="btn btn-ghost btn-xs btn-cancel-alias" data-product-id="${p.id}">✕</button>
            </div>
          </div>
        </div>
      </div>

      <div class="editor-section" data-section="tiers">
        <div class="section-header" onclick="this.closest('.editor-section').toggleAttribute('data-collapsed')">
          <span class="section-toggle">▼</span>
          <span class="section-sub-title">💰 Mức giá theo số lượng thùng</span>
        </div>
        <div class="section-content">
          <div class="tiers-container" id="tiers-container-${p.id}">
            ${tiersHtml}
          </div>
          <button class="btn btn-ghost btn-sm btn-add-tier" data-product-id="${p.id}" style="margin-top:var(--space-xs)">➕ Thêm mức giá</button>
        </div>
      </div>

      <div class="editor-section" data-section="foc">
        <div class="section-header" onclick="this.closest('.editor-section').toggleAttribute('data-collapsed')">
          <span class="section-toggle">▼</span>
          <span class="section-sub-title">🎁 Khuyến mãi FOC (Mua ... Tặng ...)</span>
        </div>
        <div class="section-content">
          <div class="foc-container promo-rule-list" id="foc-container-${p.id}">
            ${focHtml}
          </div>
          <button class="btn btn-ghost btn-sm btn-add-foc" data-product-id="${p.id}" style="margin-top:var(--space-xs)">➕ Thêm chương trình FOC</button>
        </div>
      </div>

      <div class="editor-section" data-section="product-mkt">
        <div class="section-header" onclick="this.closest('.editor-section').toggleAttribute('data-collapsed')">
          <span class="section-toggle">▼</span>
          <span class="section-sub-title">🎀 Quà MKT theo sản phẩm (Mua ... Tặng quà Marketing)</span>
        </div>
        <div class="section-content">
          <div class="product-mkt-container promo-rule-list" id="product-mkt-container-${p.id}">
            ${_productPromoRules(p.id, 'mkt_pp').map(_legacyQtyRule).map((m, mktIdx) => _buildProductMktRowHtml(p, m, mktIdx)).join('')}
          </div>
          <button class="btn btn-ghost btn-sm btn-add-product-mkt" data-product-id="${p.id}" style="margin-top:var(--space-xs)">➕ Thêm quà MKT</button>
        </div>
      </div>
    </div>`;
  },

  /**
   * Renders the Settings Editor content for a specific campaign.
   */
  renderSettingsEditor(campaignKey) {
    clearRenderCache();
    const container = document.getElementById('productEditor') || document.getElementById('settingsEditor');
    if (!container) return;

    if (!campaignKey) {
      const titleEl = document.getElementById('settingsEditorTitle');
      if (titleEl) titleEl.textContent = 'Chọn thương hiệu';
      container.innerHTML = `<div class="empty-state">
        <div class="empty-icon">👈</div>
        <h3>Chọn thương hiệu bên trái</h3>
        <p>Cấu hình thương hiệu, quà tặng Marketing và chương trình KM dạng text.<br>Quản lý sản phẩm ở tab Danh Mục.</p>
      </div>`;
      return;
    }

    const campaign = db.data.campaigns[campaignKey];
    if (!campaign) {
      const titleEl = document.getElementById('settingsEditorTitle');
      if (titleEl) titleEl.textContent = 'Thương hiệu không tồn tại';
      container.innerHTML = '<div class="empty-state"><h3>Thương hiệu không tồn tại</h3></div>';
      return;
    }

    const titleEl = document.getElementById('settingsEditorTitle');
    if (titleEl) {
      titleEl.textContent = campaign.name;
    }

    // MKT gift rules editing — mỗi mốc gồm thông tin ngưỡng + danh sách quà cấu trúc (SL × tên quà)
    // (HTML tách riêng vào _buildMktRulesHtml để partial re-render qua renderMktRulesForCampaign)
    const mktRulesHtml = _buildMktRulesHtml(campaignKey);

    // Counts for sidebar badges and collapse headers
    const mktRuleCount = (campaign.promoRules || []).filter(r => r.type === 'total' && r.scope === 'campaign').length;

    container.innerHTML = `<div class="campaign-editor-header" style="border-bottom: 2px solid var(--border-color); padding-bottom:var(--space-sm); margin-bottom:var(--space-md)">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:var(--space-md)">
        <div style="display:flex; align-items:center; gap:var(--space-md)">
          <span style="font-size:2rem">${campaign.icon || '📦'}</span>
          <div>
            <h2 style="margin:0; font-size:1.4rem;">${escapeHtml(campaign.name)}</h2>
            <span style="font-size:0.8rem; color:var(--text-tertiary)">Brand Key: <strong>${escapeHtml(campaignKey)}</strong> <span style="font-size:0.7rem; color:var(--text-3)">(không đổi được)</span></span>
          </div>
        </div>
        <button class="btn btn-ghost btn-sm" id="btnGotoCatalogFromBrand" data-campaign-key="${escapeHtml(campaignKey)}" style="font-size:0.8rem; white-space:nowrap;">Xem SP trong Danh Mục →</button>
      </div>
    </div>

    <!-- Campaign General Settings -->
    <div class="card" style="margin-bottom: var(--space-md); padding: var(--space-md);">
      <div class="card-title">Cấu hình chung Thương hiệu</div>
      <div class="config-grid-2" style="gap:var(--space-md); margin-top:var(--space-sm);">
        <div class="input-group">
          <label>Tên thương hiệu</label>
          <input type="text" value="${escapeHtml(campaign.name)}" class="input-field" id="editCampaignName" data-campaign-key="${campaignKey}" />
        </div>
        <div class="input-group">
          <label>Icon hiển thị</label>
          <input type="text" value="${escapeHtml(campaign.icon || '')}" class="input-field" id="editCampaignIcon" data-campaign-key="${campaignKey}" placeholder="Nhập icon" />
        </div>
        <div class="input-group">
          <label>Màu chủ đạo (HEX)</label>
          <input type="color" value="${campaign.color || '#4fc3f7'}" class="input-field" id="editCampaignColor" data-campaign-key="${campaignKey}" style="height:38px; padding:2px;" />
        </div>
        <div class="input-group">
          <label>Nhãn hàng liên kết (Brand Excel)</label>
          <select class="input-field" id="editCampaignBrand" data-campaign-key="${campaignKey}" style="width: 100%;">
            <option value="zentor" ${campaign.brand === 'zentor' ? 'selected' : ''}>Zentor (6. ZENTOR)</option>
            <option value="torvex" ${campaign.brand === 'torvex' ? 'selected' : ''}>Torvex (5. TORVEX)</option>
            <option value="xvil" ${campaign.brand === 'xvil' ? 'selected' : ''}>Xvil (2. XVIL)</option>
            <option value="veltra" ${campaign.brand === 'veltra' ? 'selected' : ''}>Veltra (1. VELTRA)</option>
            <option value="petrix" ${campaign.brand === 'petrix' ? 'selected' : ''}>Petrix (3. PETRIX)</option>
            <option value="veltron" ${campaign.brand === 'veltron' ? 'selected' : ''}>Veltron (4. VELTRON)</option>
          </select>
        </div>
      </div>
    </div>

    <!-- MKT Gift Rules Card — collapsed by default -->
    <div class="editor-section editor-section-card" data-collapsed data-section="mkt-rules">
      <div class="section-header" onclick="this.closest('.editor-section').toggleAttribute('data-collapsed')">
        <span class="section-toggle">▼</span>
        <span class="section-sub-title">Quà tặng Marketing theo mốc doanh số / số lượng</span>
        ${mktRuleCount > 0 ? `<span class="campaign-count">${mktRuleCount} mốc</span>` : ''}
      </div>
      <div class="section-content">
        <div class="mkt-card-hint" style="padding:0 var(--space-md) var(--space-sm)">Chọn quà từ danh mục để đơn hàng tự nhận đúng mã KV</div>
        <div class="mkt-rules-container promo-rule-list" id="mkt-rules-container-${escapeHtml(campaignKey)}" style="padding:var(--space-md); display:flex; flex-direction:column; gap:var(--space-sm)">
          ${mktRulesHtml}
        </div>
        <div style="padding: 0 var(--space-md) var(--space-md) var(--space-md)">
          <button class="btn btn-ghost btn-sm btn-add-mkt" data-campaign-key="${campaignKey}">➕ Thêm mốc quà MKT</button>
        </div>
      </div>
    </div>`;

    // Reverse link: navigate to Catalog filtered by this brand
    const gotoCatalogBtn = document.getElementById('btnGotoCatalogFromBrand');
    if (gotoCatalogBtn) {
      gotoCatalogBtn.addEventListener('click', () => {
        const cKey = gotoCatalogBtn.getAttribute('data-campaign-key');
        document.getElementById('tabCatalog')?.click();
        // Set filter to this brand after catalog renders
        setTimeout(() => {
          const chip = document.querySelector(`.catalog-brand-chip[data-campaign-key="${cKey}"]`);
          if (chip) chip.click();
        }, 100);
      });
    }

    // Mark settings as rendered so tab-switch can skip re-render
    if (typeof window !== 'undefined') window._settingsNeedsRender = false;
  },

  // --- Targeted Re-render Helpers (Phase 3.2) ---

  /**
   * Render chỉ vùng mốc quà MKT của một thương hiệu (.mkt-rules-container) —
   * dùng sau khi thêm/xóa QUÀ để không re-render toàn bộ trang Settings.
   * Thêm/xóa MỐC vẫn dùng renderSettingsEditor (liên quan data-rule-idx toàn vùng).
   */
  renderMktRulesForCampaign(campaignKey, root = document) {
    const container = _findElInRoot(root, `mkt-rules-container-${campaignKey}`);
    if (!container) return;
    container.innerHTML = _buildMktRulesHtml(campaignKey);
  },

  /**
   * Render chỉ vùng quà MKT theo sản phẩm (.product-mkt-container) trong
   * chỉnh sửa sâu — dùng sau khi thêm/xóa/sửa quà để không re-render cả card.
   */
  renderMktRulesForProduct(productId, mktRules, root = document) {
    const container = _findElInRoot(root, `product-mkt-container-${productId}`);
    if (!container) return;
    const prod = db.findProductById(productId);
    if (!prod) return;
    const list = Array.isArray(mktRules) && mktRules.length
      ? mktRules
      : _productPromoRules(productId, 'mkt_pp').map(_legacyQtyRule);
    container.innerHTML = list.map((m, mktIdx) => _buildProductMktRowHtml(prod, m, mktIdx)).join('');
  },

  /**
   * Render only the tiers container for a specific product.
   */
  renderTiersForProduct(productId, tiers, root = document) {
    const container = _findElInRoot(root, `tiers-container-${productId}`);
    if (!container) return;
    let html = '';
    (tiers || []).forEach((t, tIdx) => {
      html += `<div class="tier-row" data-product-id="${productId}" data-tier-idx="${tIdx}">
        <input type="text" value="${escapeHtml(t.label)}" placeholder="Nhãn (VD: 1-5 thùng)" class="tier-label-input" />
        <input type="number" value="${t.min_qty}" placeholder="Min Qty" class="tier-min-input" style="width:70px;" />
        <input type="number" value="${t.max_qty}" placeholder="Max Qty" class="tier-max-input" style="width:70px;" />
        <input type="text" inputmode="numeric" value="${formatNumberWithDots(t.price)}" placeholder="Giá (VND)" class="tier-price-input" style="width:110px; text-align:right;" />
        <button class="btn btn-ghost btn-sm btn-remove-tier" data-product-id="${productId}" data-tier-idx="${tIdx}">✕</button>
      </div>`;
    });
    container.innerHTML = html;
  },

  /**
   * Render only the FOC container for a specific product.
   */
  renderFOCForProduct(productId, focRules, root = document) {
    const container = _findElInRoot(root, `foc-container-${productId}`);
    if (!container) return;
    // Resolve campaignKey for gift dropdown
    const prod = db.findProductById(productId);
    const campKey = prod ? prod.campaignKey : '';
    const list = Array.isArray(focRules) && focRules.length
      ? focRules
      : _productPromoRules(productId, 'foc').map(_legacyQtyRule);
    let html = '';
    list.forEach((f, fIdx) => {
      const _focOptCount = (f.give_product_options || []).length;
      html += `<div class="foc-row promo-rule-draggable" data-product-id="${productId}" data-foc-idx="${fIdx}" draggable="true">
        ${buildPromoDragHandleHtml()}
        <span style="font-size:0.82rem;color:var(--text-secondary)">Mua</span>
        <input type="number" value="${f.buy_qty}" placeholder="Mua Qty" class="foc-buy-input" style="width:60px;" />
        <select class="foc-buyunit-input" style="width:70px;" title="Đơn vị tính mốc mua — thùng hoặc đơn vị lẻ (chai/lon/can/tuýp)">${buildBuyUnitOptionsHtml(f.buy_unit, prod ? prod.unit : '')}</select>
        <span style="font-size:0.82rem;color:var(--text-secondary)">Tặng</span>
        <input type="number" value="${f.give_qty}" placeholder="Tặng Qty" class="foc-give-input" style="width:60px;" />
        <select class="foc-unit-input" style="width:90px;" title="Đơn vị tặng (chọn từ danh sách đơn vị sản phẩm)">${buildUnitOptionsHtml(f.give_unit || '')}</select>
        ${buildFocGiftPickerHtml(f.give_product || '', campKey, productId)}
        <button class="btn btn-ghost btn-xs btn-foc-gift-options" data-product-id="${productId}" data-foc-idx="${fIdx}" title="Cấu hình tặng 1 trong nhiều quà — khi lên đơn sales sẽ bấm chọn 1" style="${_focOptCount > 1 ? 'font-weight:700; color:var(--accent-green);' : ''}">${_focOptCount > 1 ? `🎯 ${_focOptCount} quà` : '🎯 1 trong N'}</button>
        <button class="btn btn-ghost btn-xs btn-foc-gift-quickadd" data-product-id="${productId}" data-foc-idx="${fIdx}" title="Thêm nhanh 1 quà thay thế vào nhóm chọn 1 trong N">➕</button>
        <input type="text" value="${escapeHtml(f.note || '')}" placeholder="Ghi chú" class="foc-note-input" />
        <button class="btn btn-ghost btn-sm btn-remove-foc" data-product-id="${productId}" data-foc-idx="${fIdx}">✕</button>
      </div>`;
    });
    container.innerHTML = html;
  },

  /**
   * Render only the aliases for a specific product.
   */
  renderAliasesForProduct(productId, root = document) {
    const card = _findElInRoot(root, `product-card-${productId}`);
    if (!card) return;
    const container = card.querySelector('.alias-tags-container');
    if (!container) return;

    const aliasesList = db.getAliasesForProduct(productId);
    let html = '';
    aliasesList.forEach(a => {
      html += `<span class="alias-tag">
        ${escapeHtml(a.alias)}
        <button class="btn-remove-alias" data-alias="${escapeHtml(a.alias)}" data-product-id="${productId}" title="Xóa alias này">✕</button>
      </span>`;
    });
    html += `<button class="btn btn-ghost btn-xs btn-add-alias" data-product-id="${productId}">➕ Thêm Alias</button>`;
    html += `<div class="alias-input-wrapper" data-product-id="${productId}" style="display:none;">
      <input type="text" class="input-field alias-inline-input" placeholder="Nhập alias mới..." data-product-id="${productId}" />
      <button class="btn btn-success btn-xs btn-confirm-alias" data-product-id="${productId}">✓</button>
      <button class="btn btn-ghost btn-xs btn-cancel-alias" data-product-id="${productId}">✕</button>
    </div>`;
    container.innerHTML = html;
  }
};

if (typeof window !== 'undefined') {
  window.uiRenderer = uiRenderer;
  window.escapeHtml = escapeHtml;
  window.showToast = showToast;
  window.formatCurrency = formatCurrency;
  window.formatNumberWithDots = formatNumberWithDots;
  window.parseFormattedNumber = parseFormattedNumber;
  window.formatInputWithDotsAndPreserveCursor = formatInputWithDotsAndPreserveCursor;
}

export { uiRenderer, escapeHtml, showToast, formatCurrency, formatNumberWithDots, parseFormattedNumber, formatInputWithDotsAndPreserveCursor, packagingAutoText };

import { db } from '../../db.js';
import { findBestProductMatch, normalizeText, normalizeFull, fuzzySearchScore, hasAttributeConflict } from '../../parser.js';
import { store } from '../../store.js';
import { uiRenderer, escapeHtml, showToast, formatCurrency, formatNumberWithDots, parseFormattedNumber, formatInputWithDotsAndPreserveCursor, packagingAutoText } from '../../ui-renderer.js';
import { workerManager } from '../worker-manager.js';
import { calculateOrderItem } from './calculator.js';
import { confirmDialog } from '../ui/confirm-dialog.js';
import { enqueueParse } from './parse-queue.js';

import { createProductFull } from '../product-edit.js';

// --- Parse Order Handler (AI or Offline) ---
/**
 * Bấm "Phân tích" (hoặc Ctrl+Enter) → XẾP HÀNG một task phân tích nền
 * (src/order/parse-queue.js) thay vì chờ ngay tại chỗ. Nhờ vậy khi một đơn
 * đang được AI phân tích, ô tin nhắn tự do để dán đơn kế tiếp và parse
 * SONG SONG (giới hạn số đơn chạy cùng lúc đặt trong Cài đặt → AI).
 *
 * Khi task hoàn tất:
 *  - Màn hình còn "chờ đúng đơn đó" (ô tin nhắn giữ nguyên nội dung, không
 *    có đơn mới hơn, không đang mở bản ghi chờ duyệt khác) → kết quả hiện
 *    trên màn hình như parse tuần tự cũ.
 *  - Ngược lại → đơn đổ thẳng vào "Đơn chờ duyệt" + toast + badge.
 * Không có AI profile nào bật → task tự chạy parser offline (regex).
 */
export function parseOrder() {
  const textEl = document.getElementById('orderText');
  const text = (textEl && textEl.value ? textEl.value : '').trim();
  if (!text) { showToast('Vui lòng nhập tin nhắn đơn hàng!', 'error'); return; }

  const res = enqueueParse(text);
  if (res === 'duplicate') {
    showToast('Đơn này đang được phân tích rồi — đợi xong hoặc dán đơn khác nhé.', 'info');
  }
}


// --- Cart Actions & Mutations ---

export function removeOrderItem(index) {
  const currentOrder = store.getState().currentOrder;
  currentOrder.items.splice(index, 1);
  store.setState({ currentOrder });
}

export function reorderOrderItem(fromIndex, toIndex) {
  if (fromIndex === toIndex) return;
  const currentOrder = store.getState().currentOrder;
  const len = currentOrder.items.length;
  // Validate indices
  if (isNaN(fromIndex) || isNaN(toIndex) ||
      fromIndex < 0 || fromIndex >= len ||
      toIndex < 0 || toIndex >= len) {
    console.warn('reorderOrderItem: invalid indices', fromIndex, toIndex, 'length:', len);
    return;
  }
  // Build a fresh array with the item moved — guarantees a new reference
  const items = currentOrder.items.slice();
  const [moved] = items.splice(fromIndex, 1);
  items.splice(toIndex, 0, moved);
  store.setState({ currentOrder: { ...currentOrder, items } });
}

/**
 * Reorders any row (product or gift) independently by visual position.
 * Updates currentOrder.rowOrder so Excel export follows the visual order.
 */
export function reorderRows(fromVisualIndex, toVisualIndex) {
  if (fromVisualIndex === toVisualIndex) return;
  const currentOrder = store.getState().currentOrder;
  const rowDescriptors = uiRenderer.getOrderTableRows(currentOrder);
  const rows = rowDescriptors.rows;

  if (isNaN(fromVisualIndex) || isNaN(toVisualIndex) ||
      fromVisualIndex < 0 || fromVisualIndex >= rows.length ||
      toVisualIndex < 0 || toVisualIndex >= rows.length) {
    console.warn('reorderRows: invalid indices', fromVisualIndex, toVisualIndex, 'length:', rows.length);
    return;
  }

  // Get current rowOrder or build from descriptors
  let rowOrder;
  if (currentOrder.rowOrder && currentOrder.rowOrder.length > 0) {
    rowOrder = currentOrder.rowOrder.slice();
  } else {
    rowOrder = rows.map(d => d.rowId || d.giftId);
  }

  // Move the entry
  const [moved] = rowOrder.splice(fromVisualIndex, 1);
  rowOrder.splice(toVisualIndex, 0, moved);

  store.setState({ currentOrder: { ...currentOrder, rowOrder } });
}

export function removeGiftItem(giftId) {
  const currentOrder = store.getState().currentOrder;
  if (!currentOrder.giftDeleted) currentOrder.giftDeleted = {};
  // Nếu là dòng quà đã gộp → xóa tất cả giftId thành phần
  const mergedRow = uiRenderer.getOrderTableRows(currentOrder).rows
    .find(r => r.type === 'gift' && r.giftId === giftId && Array.isArray(r.mergedGiftIds) && r.mergedGiftIds.length > 1);
  if (mergedRow) {
    mergedRow.mergedGiftIds.forEach(id => { currentOrder.giftDeleted[id] = true; });
  } else {
    currentOrder.giftDeleted[giftId] = true;
  }
  store.setState({ currentOrder });
}

export function updateGiftOverride(giftId, productId) {
  const currentOrder = store.getState().currentOrder;
  currentOrder.giftOverrides = currentOrder.giftOverrides || {};
  // Nếu là dòng quà đã gộp → áp override cho tất cả giftId thành phần (chọn 1 trong 2 cho cả dòng)
  const mergedRow = uiRenderer.getOrderTableRows(currentOrder).rows
    .find(r => r.type === 'gift' && r.giftId === giftId && Array.isArray(r.mergedGiftIds) && r.mergedGiftIds.length > 1);
  if (mergedRow) {
    mergedRow.mergedGiftIds.forEach(id => { currentOrder.giftOverrides[id] = productId; });
  } else {
    currentOrder.giftOverrides[giftId] = productId;
  }
  store.setState({ currentOrder });
}

/**
 * Nút [+] trên dòng quà bảng đơn: thêm nhanh 1 quà thay thế vào nhóm "1 trong N"
 * của rule nguồn (FOC / MKT theo SP / MKT thương hiệu). Rule được resolve từ row
 * vừa render (giftRuleRef do getOrderTableRows gắn), mutate + persist + tái render
 * bảng đơn qua store.
 */
export function quickAddGiftOption(giftId, anchorBtn) {
  const currentOrder = store.getState().currentOrder;
  const row = uiRenderer.getOrderTableRows(currentOrder).rows
    .find(r => r.type === 'gift' && r.giftId === giftId && r.giftRuleRef);
  if (!row) { showToast('Không xác định được luật quà tặng của dòng này!', 'warning'); return; }

  const persistAndRefresh = () => {
    db.save();
    workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
    store.setState({ currentOrder });
  };

  if (row.giftRuleKind === 'mkt_campaign') {
    // Quà MKT thương hiệu: options gắn theo gift_item — chuẩn hóa rồi ghi đúng item đó.
    // LƯU Ý giftItemIdx đánh theo danh sách ĐÃ LỌC g.name (khớp luồng render bảng đơn),
    // nên map qua cùng bộ lọc; các item lọc ra vẫn là REF trong rule.gift_items.
    const rule = row.giftRuleRef;
    rule.gift_items = uiRenderer.normalizeMktGiftItems(rule);
    const visibleItems = rule.gift_items.filter(g => g.name);
    const giftItem = visibleItems[row.giftItemIdx];
    if (!giftItem) { showToast('Không tìm thấy quà tương ứng trong mốc MKT!', 'warning'); return; }
    uiRenderer.openQuickGiftAdd(anchorBtn, giftItem, {
      seedId: giftItem.product_id || null,
      onAdded: () => {
        // [Promo v1.3.0] Ghi NGƯỢC dạng CẤU TRÚC (giữ productId user đã chọn + unit/options)
        rule.gifts = uiRenderer.structuredGiftsFromItems(rule.gift_items, rule.gifts);
        persistAndRefresh();
      }
    });
    return;
  }

  uiRenderer.openQuickGiftAdd(anchorBtn, row.giftRuleRef, {
    seedId: row.giftSeedId || null,
    onAdded: () => {
      const rule = row.giftRuleRef;
      if (row.giftRuleKind === 'mkt_pp' && !rule.give_product && Array.isArray(rule.give_product_options) && rule.give_product_options.length) {
        // Rule MKT chưa có quà mặc định → lấy lựa chọn đầu để lên đơn/xuất có mã KV
        const first = db.findProductById(rule.give_product_options[0]);
        rule.give_product = rule.give_product_options[0];
        if (first) rule.give_product_name = first.name;
      }
      persistAndRefresh();
    }
  });
}

export function updateGiftQty(giftId, qtyStr) {
  const currentOrder = store.getState().currentOrder;
  const qty = parseFloat(qtyStr);
  if (isNaN(qty) || qty < 0) return;
  if (!currentOrder.giftQtyOverrides) currentOrder.giftQtyOverrides = {};
  // Nếu là dòng quà đã gộp: SL mới là tổng → gán cho giftId đầu, các giftId còn lại = 0
  const mergedRow = uiRenderer.getOrderTableRows(currentOrder).rows
    .find(r => r.type === 'gift' && r.giftId === giftId && Array.isArray(r.mergedGiftIds) && r.mergedGiftIds.length > 1);
  if (mergedRow) {
    mergedRow.mergedGiftIds.forEach((id, i) => {
      currentOrder.giftQtyOverrides[id] = (i === 0) ? qty : 0;
    });
  } else {
    currentOrder.giftQtyOverrides[giftId] = qty;
  }
  // TODO(perf phase sau): chủ đích GIỮ full re-render ở đây — dòng quà đã gộp (merged)
  // phân bổ lại SL vào nhiều giftId thành phần, và export phụ thuộc giftQtyOverrides;
  // targeted update chỉ lợi ít mà rủi ro lệch cấu trúc → để phase sau xử lý riêng.
  store.setState({ currentOrder });
}

/**
 * Đảo loại hiển thị của một dòng quà/hàng 0đ giữa FOC (chữ đen trong Excel)
 * và Extra (chữ đỏ + ghi 'extra' ở cột SL Thùng). Lựa chọn lưu vào
 * giftKindOverrides theo rowId/giftId; dòng quà đã gộp → áp cho tất cả
 * giftId thành phần (giống updateGiftOverride).
 */
export function toggleGiftKind(rowId) {
  const currentOrder = store.getState().currentOrder;
  if (!currentOrder.giftKindOverrides) currentOrder.giftKindOverrides = {};
  const { rows } = uiRenderer.getOrderTableRows(currentOrder);
  const target = rows.find(r => (r.rowId || r.giftId) === rowId && (r.type === 'gift' || r.isGift || Number(r.subtotal) === 0 || Number(r.bottlePrice) === 0));
  if (!target) { showToast('Không tìm thấy dòng để đổi FOC/Extra!', 'warning'); return; }
  const nextKind = target.giftKind === 'extra' ? 'foc' : 'extra';
  const ids = (Array.isArray(target.mergedGiftIds) && target.mergedGiftIds.length > 1)
    ? target.mergedGiftIds
    : [rowId];
  ids.forEach(id => { currentOrder.giftKindOverrides[id] = nextKind; });
  store.setState({ currentOrder });
}

/**
 * [Perf phase 2] Chụp chữ ký cấu trúc quà (FOC/MKT) của TOÀN đơn.
 * Dùng ĐÚNG pipeline mà renderOrderResults dùng (uiRenderer.getOrderTableRows)
 * nên mọi thay đổi hiển thị quà đều bị phát hiện: FOC phát sinh/mất khi vượt mốc,
 * số lượng quà đổi (times × give_qty), quà MKT theo sản phẩm, và cả quà MKT cấp
 * campaign (phụ thuộc tổng tiền/số thùng của cả đơn). Quà bị user xóa (giftDeleted)
 * hoặc bị override SL (giftQtyOverrides) cũng phản ánh đúng như khi render.
 */
function snapshotGiftStructure(currentOrder) {
  const { rows } = uiRenderer.getOrderTableRows(currentOrder);
  return rows
    .filter(r => r.type === 'gift')
    .map(r => `${r.giftId}|${r.qty}|${r.unit}|${r.name}|${r.productId || ''}`)
    .join('\n');
}

/**
 * [Perf phase 2] Cập nhật DOM trực tiếp 1 dòng sản phẩm (KHÔNG re-render toàn bảng)
 * — cùng pattern với updateDualPriceLive: giữ focus input khi user đang gõ.
 * Trả về false nếu dòng không có trong DOM (VD panel chưa render) → caller fallback full render.
 * KHÔNG bao giờ ghi đè phần tử đang là document.activeElement.
 */
function applyTargetedItemRowUpdate(currentOrder, index, item) {
  // Product row: gift rows cũng mang data-item-index (= index SP mẹ) nên phải loại .gift-row
  const tr = document.querySelector(`#orderTableBody tr[data-item-index="${index}"]:not(.gift-row)`);
  if (!tr) return false;

  const setIfIdle = (el, apply) => { if (el && el !== document.activeElement) apply(el); };

  // Ô thành tiền
  const subtotalCell = tr.querySelector('.subtotal-amount');
  if (subtotalCell) subtotalCell.textContent = formatCurrency(item.subtotal || 0);

  // Echo qty / unit (skip input đang focus — user đang gõ chính là nguồn truth)
  setIfIdle(tr.querySelector(`.editable-qty[data-qty-index="${index}"]`), el => { el.value = item.qty; });
  setIfIdle(tr.querySelector(`.unit-selector[data-unit-index="${index}"]`), el => { el.value = item.unit; });

  if (item.product) {
    // Cặp giá chai/thùng (đổi tier hoặc đổi unit làm unitPrice đổi)
    const bottlePrice = item.manualPrice !== null && item.manualPrice !== undefined ? item.manualPrice : item.unitPrice;
    const boxSize = item.product.box_size || 12;
    setIfIdle(tr.querySelector(`.editable-price-bottle[data-price-bottle-index="${index}"]`), el => { el.value = formatNumberWithDots(Math.round(bottlePrice)); });
    setIfIdle(tr.querySelector(`.editable-price-box[data-price-box-index="${index}"]`), el => { el.value = formatNumberWithDots(Math.round(bottlePrice * boxSize)); });

    // Nhãn tier giá (giữ markup khớp ui-renderer.renderOrderResults: span.price-tier trong .dual-price-cell)
    const dualCell = tr.querySelector('.dual-price-cell');
    if (dualCell) {
      let tierEl = dualCell.querySelector('.price-tier');
      if (item.tierLabel) {
        if (!tierEl) { tierEl = document.createElement('span'); tierEl.className = 'price-tier'; dualCell.appendChild(tierEl); }
        tierEl.textContent = item.tierLabel;
      } else if (tierEl) {
        tierEl.remove();
      }
    }

    // Mã KV phụ thuộc unit (thùng ↔ chai) — giữ markup khớp ui-renderer.renderOrderResults
    const kvCell = tr.querySelector('.kv-code-cell');
    if (kvCell) {
      const kvCode = db.getKvCode(item.product, item.unit);
      kvCell.innerHTML = kvCode
        ? `<button type="button" class="kv-code-copy" data-kv-code="${escapeHtml(kvCode)}" title="Bấm để copy mã KV: ${escapeHtml(kvCode)}"><span class="kv-code-text">${escapeHtml(kvCode)}</span><span class="kv-code-icon">⧉</span></button>`
        : `<span class="kv-code-empty">—</span>`;
    }
  }
  return true;
}

/**
 * [Perf phase 2] Tính lại tổng footer bằng vòng O(n) nhẹ (bắt chước updateDualPriceLive),
 * thay vì re-render toàn bảng chỉ để cập nhật 3 ô summary.
 */
function refreshOrderSummary(currentOrder) {
  let grandTotal = 0, totalBoxes = 0;
  currentOrder.items.forEach(it => {
    grandTotal += it.subtotal || 0;
    if (it.product) {
      const bs = it.product.box_size || 12;
      totalBoxes += it.unit === 'thùng' ? it.qty : it.qty / bs;
    }
  });
  const summaryProducts = document.getElementById('summaryProducts');
  const summaryBoxes = document.getElementById('summaryBoxes');
  const summaryTotal = document.getElementById('summaryTotal');
  if (summaryProducts) summaryProducts.textContent = currentOrder.items.filter(i => i.product).length;
  if (summaryBoxes) summaryBoxes.textContent = totalBoxes.toFixed(1).replace('.0', '');
  if (summaryTotal) summaryTotal.textContent = formatCurrency(grandTotal);
}

export function updateItemQty(index, val) {
  const currentOrder = store.getState().currentOrder;
  const item = currentOrder.items[index];
  if (!item) return;

  const qty = parseInt(val) || 1;

  // TRƯỚC khi đổi: chụp cấu trúc quà để phát hiện quà phát sinh/mất/đổi SL do vượt mốc
  const giftsBefore = snapshotGiftStructure(currentOrder);

  item.qty = qty;

  if (item.product) {
    const calc = calculateOrderItem(item.product, qty, item.unit);
    item.unitPrice = item.manualPrice !== null && item.manualPrice !== undefined ? item.manualPrice : calc.unitPrice;
    item.subtotal = item.unitPrice * (item.unit === 'thùng' ? qty * (item.product.box_size || 12) : qty);
    item.foc = calc.foc;
    item.tierLabel = calc.tierLabel;
  } else {
    item.subtotal = item.unitPrice * qty;
  }

  // Cấu trúc quà THAY ĐỔI (FOC/MKT phát sinh, mất, hoặc đổi số lượng do vượt mốc)
  // → BẮT BUỘC full re-render để khu quà vẽ lại đúng — không tự render partial ở đây.
  if (giftsBefore !== snapshotGiftStructure(currentOrder)) {
    store.setState({ currentOrder });
    return;
  }

  // Targeted DOM update (NO full re-render) so the qty input keeps focus while typing
  // /clicking the spinner. A full renderOrderResults() would rebuild the table and
  // destroy the focused input. (Same pattern as updateDualPriceLive.)
  if (!applyTargetedItemRowUpdate(currentOrder, index, item)) {
    store.setState({ currentOrder }); // dòng chưa có trong DOM → fallback full render
    return;
  }
  // Recompute summary totals via lightweight O(n) loop (no gift/MKT processing)
  refreshOrderSummary(currentOrder);
}

/**
 * Change unit/package for a product row (e.g. thùng ↔ tuýp/chai/lon).
 * Recalculates price, subtotal, FOC based on new unit.
 */
export function updateItemUnit(index, newUnit) {
  const currentOrder = store.getState().currentOrder;
  const item = currentOrder.items[index];
  if (!item || !item.product) return;

  // TRƯỚC khi đổi: chụp cấu trúc quà (đổi unit có thể đổi mốc FOC/MKT do totalUnits đổi)
  const giftsBefore = snapshotGiftStructure(currentOrder);

  item.unit = newUnit;
  // Reset manual price when switching unit (old price is for different unit)
  item.manualPrice = null;

  const calc = calculateOrderItem(item.product, item.qty, newUnit);
  item.unitPrice = calc.unitPrice;
  item.subtotal = calc.subtotal;
  item.foc = calc.foc;
  item.tierLabel = calc.tierLabel;

  // Cấu trúc quà THAY ĐỔI → BẮT BUỘC full re-render (không tự render partial).
  if (giftsBefore !== snapshotGiftStructure(currentOrder)) {
    store.setState({ currentOrder });
    return;
  }

  // Targeted DOM update (NO full re-render): cập nhật dòng hiện tại + tổng footer.
  // Cùng pattern với updateDualPriceLive — select unit giữ focus, không rebuild bảng.
  if (!applyTargetedItemRowUpdate(currentOrder, index, item)) {
    store.setState({ currentOrder }); // dòng chưa có trong DOM → fallback full render
    return;
  }
  // Recompute summary totals via lightweight O(n) loop (no gift/MKT processing)
  refreshOrderSummary(currentOrder);
}

/**
 * Bản light cho TỪNG PHÍM gõ vào ô giá (event `input`): chỉ mutate giá/thành tiền
 * + cập nhật DOM targeted (ô thành tiền, ô mirror chai↔thùng, footer). KHÔNG chạy
 * snapshotGiftStructure (mỗi lượt = full pipeline getOrderTableRows) và KHÔNG
 * setState — gõ liên tục không giật, không mất focus. Quà MKT và badge FOC/EXTRA
 * (hàng giá 0) được chốt ở commitDualPrice khi user bấm ra ngoài / Enter (event `change`).
 */
export function updateDualPriceLive(index, source, inputEl) {
  const currentOrder = store.getState().currentOrder;
  const item = currentOrder.items[index];
  if (!item) return;

  formatInputWithDotsAndPreserveCursor(inputEl);
  const cleanVal = parseFormattedNumber(inputEl.value);
  applyDualPrice(currentOrder, index, source, cleanVal);

  // Targeted DOM update (NO full re-render) so the price input keeps focus while typing.
  const tr = inputEl.closest('tr');
  if (tr) {
    const subtotalCell = tr.querySelector('.subtotal-amount');
    if (subtotalCell) subtotalCell.textContent = formatCurrency(item.subtotal);
  }
  refreshOrderSummary(currentOrder);
}

/**
 * Chốt giá khi commit (event `change` — blur ra ngoài hoặc Enter): áp giá trị cuối
 * rồi setState ĐÚNG MỘT LẦN → một full rebuild duy nhất để khu quà MKT tính lại
 * (vượt/rớt mốc campaign do subtotal đổi) và badge FOC/EXTRA hiện ngay với hàng giá 0.
 * `change` chỉ fire khi giá trị thật sự đổi kể từ lúc focus nên không bị gọi thừa.
 */
export function commitDualPrice(index, source, inputEl) {
  const currentOrder = store.getState().currentOrder;
  const item = currentOrder.items[index];
  if (!item) return;

  const cleanVal = parseFormattedNumber(inputEl.value);
  applyDualPrice(currentOrder, index, source, cleanVal);

  store.setState({ currentOrder });
}

/**
 * [Perf phase 2] Mutate giá + thành tiền dùng chung cho đang-gõ và commit.
 * getOrderTableRows tự recompute từ manualPrice khi render nên chỉ cần ghi đây.
 */
function applyDualPrice(currentOrder, index, source, cleanVal) {
  const item = currentOrder.items[index];
  const boxSize = item.product ? (item.product.box_size || 12) : 12;

  if (source === 'bottle') {
    item.manualPrice = cleanVal;
    item.unitPrice = cleanVal;
    const boxInput = document.querySelector(`.editable-price-box[data-price-box-index="${index}"]`);
    if (boxInput) boxInput.value = formatNumberWithDots(Math.round(cleanVal * boxSize));
  } else {
    const calculatedUnitPrice = cleanVal / boxSize;
    item.manualPrice = calculatedUnitPrice;
    item.unitPrice = calculatedUnitPrice;
    const bottleInput = document.querySelector(`.editable-price-bottle[data-price-bottle-index="${index}"]`);
    if (bottleInput) bottleInput.value = formatNumberWithDots(Math.round(calculatedUnitPrice));
  }

  const totalUnits = item.unit === 'thùng' ? item.qty * boxSize : item.qty;
  item.subtotal = item.unitPrice * totalUnits;
}

export function changeRowProduct(index, productId) {
  const currentOrder = store.getState().currentOrder;
  const isGift = String(index).startsWith('foc_') || String(index).startsWith('mkt_');
  
  if (isGift) {
    currentOrder.giftOverrides = currentOrder.giftOverrides || {};
    currentOrder.giftOverrides[index] = productId;
    store.setState({ currentOrder });
    return;
  }
  
  const itemIndex = parseInt(index);
  const item = currentOrder.items[itemIndex];
  if (!item) return;

  // Trạng thái trước khi đổi: quyết định có nên tự học alias hay không
  const prevProduct = item.product;
  const prevScore = (item.matchScore === undefined || item.matchScore === null)
    ? (prevProduct ? 100 : 0)
    : item.matchScore;
  const wasWeakOrUnmatched = !prevProduct || prevScore < 60;
  // User sửa sản phẩm KHÁC với product hiện tại → đây là correction, PHẢI học
  const isCorrection = prevProduct && productId && prevProduct.id !== productId;

  // Đổi sang SP KHÁC → xóa cờ quà tặng cũ của dòng này (giftDeleted/overrides).
  // Nếu giữ lại, quà của SP mới sẽ bị ẩn/đè bởi quyết định cũ trên SP trước đó
  // (VD: đã xóa quà dòng này → đổi SP có quà khác thì quà mới vẫn bị ẩn).
  if (productId && (!prevProduct || prevProduct.id !== productId)) {
    for (const flagMap of ['giftDeleted', 'giftOverrides', 'giftQtyOverrides']) {
      const map = currentOrder[flagMap];
      if (!map) continue;
      for (const key of Object.keys(map)) {
        if (key.startsWith(`foc_${itemIndex}_`) || key.startsWith(`mkt_pp_${itemIndex}_`)) {
          delete map[key];
        }
      }
    }
  }
  
  if (!productId) {
    item.product = null;
    item.unitPrice = 0;
    item.subtotal = 0;
    item.foc = [];
    item.tierLabel = '';
    item.manualPrice = null;
    item.matchScore = 0;
  } else {
    const product = db.findProductById(productId);
    if (product) {
      item.product = product;
      const calc = calculateOrderItem(product, item.qty, item.unit);
      item.unitPrice = calc.unitPrice;
      item.subtotal = calc.subtotal;
      item.foc = calc.foc;
      item.tierLabel = calc.tierLabel;
      item.manualPrice = null;
      // Người dùng chọn tay → coi như chắc chắn 100%
      item.matchScore = 100;
      
      // Tự học alias: học khi sửa từ dòng yếu/không khớp HOẶC khi user sửa khác product cũ (correction)
      // Correction: user chủ động đổi SP khác → alias cũ SAI → phải ghi đè
      // Attribute guard: không học nếu alias chứa thuộc tính xung đột với product
      // rawKey gồm cả rawName (dòng CHƯA KHỚP lưu tên ở rawName, không có rawProduct) —
      // sửa tay dòng vàng cũng phải học được.
      const rawKey = item.rawProduct || item.rawName || '';
      if (rawKey && (wasWeakOrUnmatched || isCorrection)) {
        const rawNorm = normalizeFull(rawKey);
        if (!hasAttributeConflict(rawNorm, product)) {
          const prevAlias = db.getAliases()[rawKey.toLowerCase().trim()] || null;
          db.addAlias(rawKey, productId);
          workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
          showToast(`Đã ghi nhớ: "${rawKey}" → ${product.name}`, 'success', {
            label: '↩ Hoàn tác',
            handler: () => {
              if (prevAlias) {
                db.addAlias(rawKey, prevAlias);
              } else {
                db.removeAlias(rawKey);
              }
              workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
              showToast(`Đã hoàn tác ghi nhớ "${rawKey}"`, 'info');
            }
          });
        }
      }
    }
  }
  store.setState({ currentOrder });
}

// =========================================================================
//  A11Y: đồng bộ aria-expanded của input combobox với trạng thái dropdown
//  (markup ARIA tĩnh do người khác lo — phía JS chỉ cập nhật state ở đây)
// =========================================================================

/**
 * Set aria-expanded trên input của combobox theo trạng thái dropdown.
 * @param {string|number} index - Index dòng item (id input: combobox-input-{index}).
 * @param {boolean} expanded - true = dropdown đang mở.
 */
function setComboboxExpanded(index, expanded) {
  const input = document.getElementById(`combobox-input-${index}`);
  if (input) input.setAttribute('aria-expanded', expanded ? 'true' : 'false');
}

/** Đóng TẤT CẢ dropdown combobox đang mở + cập nhật aria-expanded=false tương ứng. */
function closeAllComboboxDropdowns() {
  document.querySelectorAll('.combobox-dropdown').forEach(d => {
    d.style.display = 'none';
    const idx = (d.id || '').replace('combobox-dropdown-', '');
    if (idx) setComboboxExpanded(idx, false);
  });
}

/**
 * Khởi tạo đồng bộ aria-expanded DỰ PHÒNG cho đường đóng dropdown nằm ngoài
 * file này (click-outside trong settings/ui.js — file cấm sửa nên không chèn
 * sync trực tiếp được). Listener đăng ký SAU listener gốc trên document nên
 * chạy sau nó → luôn đọc lại display thật của dropdown và set attribute đúng.
 *
 * @example
 * import { initComboboxAriaSync } from './order/actions.js';
 * initComboboxAriaSync(); // gọi 1 lần lúc khởi động app
 */
export function initComboboxAriaSync() {
  document.addEventListener('click', () => {
    document.querySelectorAll('.combobox-dropdown[id]').forEach(d => {
      const idx = (d.id || '').replace('combobox-dropdown-', '');
      if (!idx) return;
      setComboboxExpanded(idx, d.style.display !== 'none');
    });
  });
}

export function selectComboboxItem(index, productId) {
  changeRowProduct(index, productId);
  const dropdown = document.getElementById(`combobox-dropdown-${index}`);
  if (dropdown) {
    dropdown.style.display = 'none';
    setComboboxExpanded(index, false); // đóng dropdown → aria-expanded="false"
  }
}

/**
 * Áp dụng nội dung user GÕ trong combobox (Enter hoặc blur).
 * Trước đây chỉ CLICK chuột vào gợi ý mới đổi SP → gõ tên mới rồi Enter/tab đi
 * không có tác dụng: sản phẩm + quà không cập nhật.
 * @param {string|number} index - Index dòng item
 * @param {string} source - 'enter' | 'blur'
 */
export function applyComboboxText(index, source = 'blur') {
  const input = document.getElementById(`combobox-input-${index}`);
  if (!input) return;
  if (String(index).startsWith('foc_') || String(index).startsWith('mkt_')) return;
  const itemIndex = parseInt(index);
  const currentOrder = store.getState().currentOrder;
  const item = currentOrder.items[itemIndex];
  if (!item) return;

  const text = (input.value || '').trim();

  // Không đổi gì so với SP đang chọn → bỏ qua
  if (item.product && normalizeFull(text) === normalizeFull(item.product.name)) return;

  // Xóa trắng → chuyển về dòng chưa khớp
  if (!text) {
    changeRowProduct(index, '');
    return;
  }

  // Tìm SP khớp với tên đã gõ → áp dụng (kèm tính lại quà FOC/MKT)
  const match = findBestProductMatch(text, db.getAllProducts(), db.getAliases(), item.unit);
  if (match && match.score >= 80) {
    changeRowProduct(index, match.product.id);
    return;
  }

  // Không khớp: Enter → giữ cho user gõ tiếp + báo; blur → hoàn tác hiển thị
  if (source === 'enter') {
    showToast(`Không tìm thấy sản phẩm khớp "${text}" — chọn từ danh sách gợi ý.`, 'error');
  } else {
    input.value = item.product ? item.product.name : (item.rawName || '');
  }
  const dropdown = document.getElementById(`combobox-dropdown-${index}`);
  if (dropdown) {
    dropdown.style.display = 'none';
    setComboboxExpanded(index, false); // đóng dropdown → aria-expanded="false"
  }
}

export function showComboboxDropdown(index) {
  // Close all other dropdowns (kèm đồng bộ aria-expanded=false cho các input đó)
  closeAllComboboxDropdowns();
  // Lazily populate dropdown on first open
  uiRenderer.populateComboboxDropdown(index);
  const dropdown = document.getElementById(`combobox-dropdown-${index}`);
  if (dropdown) {
    dropdown.style.display = 'block';
    setComboboxExpanded(index, true); // mở dropdown → aria-expanded="true"
  }
}

export function filterComboboxOptions(index, query) {
  const dropdown = document.getElementById(`combobox-dropdown-${index}`);
  if (!dropdown) return;

  // Ensure dropdown is populated before filtering
  uiRenderer.populateComboboxDropdown(index);
  dropdown.style.display = 'block';
  setComboboxExpanded(index, true); // đang gõ → dropdown mở → aria-expanded="true"
  const normQuery = normalizeText(query);

  const items = Array.from(dropdown.querySelectorAll('.combobox-item'));
  const scored = items.map(item => {
    // "Chưa khớp / Khác": chỉ hiện khi KHÔNG có query
    if (item.getAttribute('data-is-clear')) {
      return { item, score: normQuery ? -1 : Infinity };
    }
    const text = item.getAttribute('data-search-text');
    if (!text) return { item, score: 0 };
    let score = fuzzySearchScore(normQuery, text);
    // Boost: khớp trong TÊN sản phẩm → ưu tiên lên đầu
    if (score > 0 && normQuery) {
      const nameText = item.getAttribute('data-name-text') || '';
      if (nameText && fuzzySearchScore(normQuery, nameText) > 0) {
        score += 40;
      }
    }
    return { item, score };
  });

  scored.sort((a, b) => b.score - a.score);
  scored.forEach(({ item, score }) => {
    item.style.display = score > 0 ? '' : 'none';
    dropdown.appendChild(item); // reorder theo độ liên quan
  });
}

// --- Custom Promos (Ad-hoc manual additions) ---

export function addCustomPromo() {
  const nameEl = document.getElementById('customPromoInput');
  const valEl = document.getElementById('customPromoValue');
  const name = nameEl ? nameEl.value.trim() : '';
  const val = valEl ? parseFormattedNumber(valEl.value) : 0;
  if (!name) { showToast('Vui lòng nhập tên khuyến mãi!', 'error'); if (nameEl) nameEl.focus(); return; }

  const currentOrder = store.getState().currentOrder;
  currentOrder.customPromos.push({ name, value: val });
  store.setState({ currentOrder });

  if (nameEl) nameEl.value = '';
  if (valEl) valEl.value = '';
  renderCustomPromos();
}

export function removeCustomPromo(i) {
  const currentOrder = store.getState().currentOrder;
  currentOrder.customPromos.splice(i, 1);
  store.setState({ currentOrder });
  renderCustomPromos();
}

export function renderCustomPromos() {
  const list = document.getElementById('customPromoList');
  if (!list) return;

  const currentOrder = store.getState().currentOrder;
  if (!currentOrder.customPromos || currentOrder.customPromos.length === 0) {
    list.innerHTML = '';
    return;
  }

  const fragment = document.createDocumentFragment();
  currentOrder.customPromos.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'promo-item';
    const valueHtml = p.value > 0
      ? ` <span style="font-weight:700;color:var(--accent-red)">-${formatCurrency(p.value)}</span>`
      : '';
    div.innerHTML = `
      <span>🎁 ${escapeHtml(p.name)}${valueHtml}</span>
      <button class="btn btn-ghost btn-xs btn-remove-promo" data-promo-index="${i}">✕</button>
    `;
    const btn = div.querySelector('.btn-remove-promo');
    btn.onclick = () => removeCustomPromo(i);
    fragment.appendChild(div);
  });

  list.innerHTML = '';
  list.appendChild(fragment);
}

// --- Manual Product Search Addition ---

export function onManualSearch(query) {
  const dropdown = document.getElementById('manualSearchDropdown');
  if (!dropdown) return;
  if (!query.trim()) { dropdown.style.display = 'none'; return; }

  const normQuery = normalizeText(query);
  const allProducts = db.getAllProducts();

  const matches = [];
  allProducts.forEach(p => {
    const nameNorm = normalizeText(`${p.name} ${p.spec || ''} ${p.campaignName || ''} ${p.kvCode || ''} ${p.packaging || ''}`);
    const score = fuzzySearchScore(normQuery, nameNorm);
    if (score > 0) matches.push({ p, score });
  });
  matches.sort((a, b) => b.score - a.score);

  let html = '';
  matches.forEach(({ p }) => {
    html += `<div class="combobox-item manual-add-item" data-product-id="${p.id}">
      <span class="combobox-item-name">${p.campaignIcon || '📦'} ${escapeHtml(p.name)} [${escapeHtml(p.spec||'')}]${packagingAutoText(p) ? ` <span style="color:var(--text-tertiary); font-size:0.72rem;"${p.packaging ? ` title="Đóng gói gốc: ${escapeHtml(p.packaging)}"` : ''}>(${escapeHtml(packagingAutoText(p))})</span>` : ''}</span>
      <span class="combobox-item-campaign" style="color:${p.campaignColor};">${escapeHtml(p.campaignName)}</span>
    </div>`;
  });

  if (html) {
    dropdown.innerHTML = html;
    dropdown.style.display = 'block';
    
    // Bind click events
    dropdown.querySelectorAll('.manual-add-item').forEach(item => {
      item.onclick = (e) => {
        const pId = e.currentTarget.getAttribute('data-product-id');
        const product = db.findProductById(pId);
        if (product) addManualProduct(product);
        dropdown.style.display = 'none';
        document.getElementById('manualProductSearch').value = '';
      };
    });
  } else {
    dropdown.style.display = 'none';
  }
}

export function addManualProduct(product) {
  const currentOrder = store.getState().currentOrder;
  // Default unit: sản phẩm có unit gốc KHÔNG phải chai/lon (vd: tuýp, phuy, cái) → dùng unit gốc.
  // Sản phẩm chai/lon đóng thùng → mặc định thùng (cách sales thường nhập).
  const nativeUnit = product.unit || 'chai';
  const defaultUnit = (nativeUnit !== 'chai' && nativeUnit !== 'lon' && nativeUnit !== 'bình') ? nativeUnit : 'thùng';
  const calc = calculateOrderItem(product, 1, defaultUnit);
  currentOrder.items.push({
    rawProduct: product.name,
    qty: 1,
    unit: defaultUnit,
    product: product,
    unitPrice: calc.unitPrice,
    subtotal: calc.subtotal,
    foc: calc.foc,
    tierLabel: calc.tierLabel,
    manualPrice: null,
    isGift: false
  });
  store.setState({ currentOrder });
  showToast(`Đã thêm thủ công: ${product.name}`, 'success');
}

// --- Export Delivery Note Summary ---

/**
 * Lưu dòng tự nhập (isCustom) thành SP danh mục — mở form thêm hàng đã điền
 * sẵn tên/đơn vị/giá từ dòng đơn, lưu xong học alias + gắn SP vào dòng.
 */
export function saveCustomAsProduct(index) {
  const currentOrder = store.getState().currentOrder;
  const item = currentOrder && currentOrder.items && currentOrder.items[index];
  if (!item || !item.isCustom) {
    showToast('Không tìm thấy dòng tự nhập!', 'error');
    return;
  }
  const campaigns = db.data.campaigns || {};
  const keys = Object.keys(campaigns);
  if (!keys.length) {
    showToast('Chưa có thương hiệu nào để lưu sản phẩm!', 'error');
    return;
  }
  // Mở form thêm hàng với dữ liệu điền sẵn từ dòng đơn.
  import('../settings/ui.js').then(({ showAddProductModal }) => {
    showAddProductModal(keys[0], (added) => {
      if (!added) return;
      // Học tên custom thành alias để lần sau gõ tên này khớp ngay.
      const rawName = String(item.rawName || item.rawProduct || '').trim();
      if (rawName.length >= 2 && rawName.toLowerCase() !== String(added.name || '').toLowerCase()) {
        const owner = db.getAliases()[rawName.toLowerCase()];
        if (!owner) db.addAlias(rawName, added.id);
      }
      // Gắn SP mới vào dòng đơn (giữ SL/đơn vị user đã nhập).
      currentOrder.items[index] = {
        ...item,
        product: { ...added, campaignKey: item.campaignKey || keys[0] },
        isCustom: false,
        manualPrice: null,
      };
      store.setState({ currentOrder });
      showToast(`Đã lưu thành SP: ${added.name}`, 'success');
    });
    // Điền sẵn sau khi modal dựng xong.
    setTimeout(() => {
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
      set('newProductName', item.rawName || '');
      set('newProductUnit', item.unit || 'chai');
      const price = Number(item.unitPrice ?? item.manualPrice) || 0;
      const tierPrice = document.querySelector('#newProductTiers .np-tier-price');
      if (tierPrice && price > 0) {
        tierPrice.value = String(price).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      }
    }, 0);
  });
}

// Kiểm tra dữ liệu trước khi xuất/copy: trả về danh sách vấn đề (rỗng = OK)
export function validateOrderBeforeExport(rows, customerName) {
  const issues = [];
  if (!customerName || !customerName.trim()) {
    issues.push('• Thiếu Tên khách hàng');
  }
  let idx = 0;
  (rows || []).forEach(row => {
    if (row.type === 'matched' || row.type === 'unmatched') idx++;
    if (row.type === 'unmatched') {
      issues.push(`• Dòng ${idx}: chưa khớp sản phẩm — "${row.rawName || ''}"`);
    } else if (row.type === 'matched') {
      const name = row.product ? row.product.name : '(không tên)';
      const score = (row.matchScore === undefined || row.matchScore === null) ? 100 : row.matchScore;
      if (!row.isGift && score < 60) {
        issues.push(`• Dòng ${idx}: độ tin cậy khớp thấp (${score}%) — "${name}"`);
      }
      if (!row.isGift && (!row.subtotal || row.subtotal === 0)) {
        issues.push(`• Dòng ${idx}: giá 0đ (không phải hàng tặng) — "${name}"`);
      }
    }
  });
  return issues;
}

// Nếu có vấn đề, hỏi người dùng tiếp tục hay quay lại sửa. Trả về true nếu được phép tiếp tục.
// Non-blocking: dùng custom dialog thay vì hộp thoại xác nhận native (gây đóng băng renderer Electron).
export async function confirmExportIfIssues(issues, actionLabel) {
  if (!issues || issues.length === 0) return true;
  return confirmDialog({
    title: `⚠️ Dữ liệu chưa chuẩn (${issues.length} vấn đề)`,
    message: issues.join('\n') + `\n\nBấm OK để ${actionLabel || 'tiếp tục'}, hoặc hủy để quay lại sửa.`,
    confirmText: 'OK — Tiếp tục',
    cancelText: '↩ Quay lại sửa'
  });
}

export async function copySummary() {
  const text = document.getElementById('orderText').value.trim();
  const paymentSelect = document.getElementById('paymentMethod');
  const customerName = document.getElementById('customerName').value.trim();

  const { rows, grandTotal, totalBoxes } = uiRenderer.getOrderTableRows(store.getState().currentOrder);

  // Validate trước khi copy
  const issues = validateOrderBeforeExport(rows, customerName);
  if (!(await confirmExportIfIssues(issues, 'copy phiếu'))) return;

  let summary = `📋 PHIẾU GIAO HÀNG / ĐƠN HÀNG\n`;
  summary += `👤 Khách hàng: ${customerName || 'Chưa ghi tên'}\n`;
  summary += `💳 Thanh toán: ${paymentSelect.options[paymentSelect.selectedIndex].text}\n`;
  summary += `📅 Ngày lập: ${new Date().toLocaleDateString('vi-VN')}\n`;
  summary += `-------------------------------------------\n`;

  // Nhãn FOC/EXTRA theo hiện trạng trên bảng (giftKind sau toggle), không theo nguồn gốc cứng
  const kindLabelOf = (row) => (row.giftKind === 'extra' ? 'EXTRA' : 'FOC');
  const isFreeRow = (row) => row.isGift || row.subtotal === 0 || Number(row.bottlePrice) === 0;

  let itemCounter = 1;
  rows.forEach(row => {
    if (row.type === 'matched') {
      const totalUnits = row.unit === 'thùng' ? row.qty * row.boxSize : row.qty;
      const unitLabel = row.unit === 'thùng' ? 'Thùng' : 'Chai';
      if (isFreeRow(row)) {
        summary += `${itemCounter++}. 🎁 TẶNG [${kindLabelOf(row)}]: ${row.product.name} [${row.product.spec || ''}]\n`;
        summary += `   SL: ${row.qty} ${unitLabel} (${totalUnits} chai) — 0 đ\n`;
      } else {
        summary += `${itemCounter++}. ${row.product.name} [${row.product.spec || ''}]\n`;
        summary += `   SL: ${row.qty} ${unitLabel} (${totalUnits} chai) x Đơn giá: ${formatCurrency(row.showPrice)} = ${formatCurrency(row.subtotal)}\n`;
      }
    } else if (row.type === 'unmatched') {
      if (isFreeRow(row)) {
        summary += `${itemCounter++}. 🎁 TẶNG [${kindLabelOf(row)}]: ${row.rawName}\n`;
        summary += `   SL: ${row.qty} ${row.unit} — 0 đ\n`;
      } else {
        summary += `${itemCounter++}. ⚠️ [CHƯA KHỚP] ${row.rawName}\n`;
        summary += `   SL: ${row.qty} ${row.unit} x Đơn giá: ${formatCurrency(row.bottlePrice)} = ${formatCurrency(row.subtotal)}\n`;
      }
    } else if (row.type === 'gift') {
      const kindLabel = kindLabelOf(row);
      const sourceLabel = row.giftSource === 'FOC' ? 'KM FOC' : 'KM MKT';
      const note = [sourceLabel, row.note || ''].filter(Boolean).join(' - ');
      summary += `🎁 TẶNG [${kindLabel}]: ${row.name} (SL: ${row.qty} ${row.unit})`;
      if (note) summary += ` [${note}]`;
      summary += `\n`;
    }
  });

  const currentOrder = store.getState().currentOrder;
  if (currentOrder.customPromos.length > 0) {
    summary += `-------------------------------------------\n`;
    summary += `🎁 CHƯƠNG TRÌNH KHUYẾN MÃI:\n`;
    currentOrder.customPromos.forEach(p => {
      summary += p.value > 0
        ? `   - ${p.name}: -${formatCurrency(p.value)}\n`
        : `   - ${p.name}\n`;
    });
  }

  const promoDeductions = currentOrder.customPromos.reduce((acc, p) => acc + p.value, 0);
  const finalPay = Math.max(0, grandTotal - promoDeductions);

  summary += `-------------------------------------------\n`;
  summary += `📦 Tổng số thùng: ${totalBoxes.toFixed(1).replace('.0', '')} thùng\n`;
  summary += `💰 Tổng tiền hàng: ${formatCurrency(grandTotal)}\n`;
  if (promoDeductions > 0) {
    summary += `🎁 Trừ khuyến mãi: -${formatCurrency(promoDeductions)}\n`;
  }
  summary += `💵 Thực thanh toán: ${formatCurrency(finalPay)}\n`;

  navigator.clipboard.writeText(summary).then(() => {
    showToast('Đã copy phiếu giao hàng vào Clipboard!', 'success');
  }).catch(err => {
    console.error('Copy failed:', err);
    showToast('Sao chép thất bại, vui lòng copy thủ công', 'error');
  });
}

export function clearOrder() {
  store.setState({
    currentOrder: {
      customer: '',
      payment: 'ck',
      items: [],
      customPromos: [],
      parsedLines: [],
      aiResult: null,
      giftOverrides: {},
      giftDeleted: {},
      giftQtyOverrides: {},
      rowOrder: null,
      // Ngắt liên kết bản ghi chờ duyệt — soạn đơn mới sẽ tạo bản ghi riêng,
      // không đè lên bản ghi của đơn vừa xóa khỏi màn hình.
      _pendingId: null
    }
  });
  
  const orderText = document.getElementById('orderText');
  const custName = document.getElementById('customerName');
  const noteEl = document.getElementById('orderNote');
  const payEl = document.getElementById('paymentMethod');
  if (orderText) orderText.value = '';
  if (custName) custName.value = '';
  if (noteEl) noteEl.value = '';
  if (payEl) payEl.value = 'ck';
  autoGrowOrderText();
  
  showToast('Đã xóa đơn hàng hiện tại.', 'info');
}

export function loadSampleOrder() {
  const sample = `Anywhere Man
Cửa hàng Thành Đạt
3 thùng hand cleaner giá 106k
2 thùng prostream 10w40 tặng 2 lon
CK`;
  const orderText = document.getElementById('orderText');
  if (orderText) {
    orderText.value = sample;
    autoGrowOrderText();
    showToast('Đã tải đơn hàng mẫu. Hãy bấm "Phân Tích Đơn Hàng"!', 'info');
  }
}

/**
 * Auto-size the order textarea to fit its content, capped so the input
 * band never swallows the results table. Past the cap, CSS gives the
 * textarea its own visible vertical scrollbar.
 */
export function autoGrowOrderText() {
  const ta = document.getElementById('orderText');
  if (!ta) return;
  ta.style.height = 'auto';
  const cap = Math.min(340, Math.round(window.innerHeight * 0.4));
  ta.style.height = Math.min(ta.scrollHeight, cap) + 'px';
}

// --- Campaign Catalog Tab interactions ---

// Preserve expanded catalog card state across re-renders
export function saveCatalogSearchState() {
  const searchEl = document.getElementById('catalogSearchInput');
  const catalogContent = document.getElementById('catalogContent');
  return {
    searchValue: searchEl ? searchEl.value : '',
    scrollTop: catalogContent ? catalogContent.scrollTop : 0
  };
}

export function restoreCatalogSearchState(state) {
  if (!state) return;
  // Static input is never destroyed — just keep state in sync, no focus stealing
  uiRenderer._catalogSearch = state.searchValue || '';
  const el = document.getElementById('catalogSearchInput');
  if (el && el.value !== state.searchValue) el.value = state.searchValue || '';
  const clearBtn = document.getElementById('catalogSearchClear');
  if (clearBtn) clearBtn.classList.toggle('hidden', !state.searchValue);
  const catalogContent = document.getElementById('catalogContent');
  if (catalogContent && state.scrollTop) catalogContent.scrollTop = state.scrollTop;
}

export function saveExpandedCatalogCards() {
  const expanded = [];
  document.querySelectorAll('.catalog-card-detail').forEach(el => {
    if (el.style.display !== 'none') {
      expanded.push(el.getAttribute('data-detail-id'));
    }
  });
  return expanded;
}

export function restoreExpandedCatalogCards(expandedIds) {
  if (!expandedIds || expandedIds.length === 0) return;
  expandedIds.forEach(pId => {
    const detail = document.querySelector(`.catalog-card-detail[data-detail-id="${pId}"]`);
    if (detail) detail.style.display = 'block';
    const toggleBtn = document.querySelector(`.btn-toggle-catalog-card[data-product-id="${pId}"]`);
    if (toggleBtn) toggleBtn.textContent = '▾';
  });
}


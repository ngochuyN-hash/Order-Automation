import { db } from '../../db.js';
import { parseOrderText } from '../../parser.js';
import { store } from '../../store.js';
import { uiRenderer, showToast } from '../../ui-renderer.js';
import { CustomerNotes } from '../customer-notes.js';
import { calculateOrderItem, getFinalUnitPrice, processExplicitGift, combineGifts, mergeDuplicateItems } from './calculator.js';
import { customerFirstComment } from './note-sanitizer.js';

// --- Core: build a fresh order object from raw chat text (no side effects) ---
// Dùng chung cho nút Phân tích (chế độ offline) và bước "quét lại nội dung" trước khi xuất Excel.
export function buildOrderFromText(text) {
  const result = parseOrderText(text, db.getAllProducts(), db.getAliases());
  const campaignScores = {};
  
  for (const campaignKey of Object.keys(db.data.campaigns)) {
    campaignScores[campaignKey] = 0;
  }

  result.lines.forEach(line => {
    if (line.type === 'matched' && line.data.matchedProduct) {
      const cKey = line.data.matchedProduct.campaignKey;
      if (campaignScores[cKey] !== undefined) {
        campaignScores[cKey] += 10;
      }
    }
  });

  let primaryCampaign = null;
  let maxScore = 0;
  for (const [key, score] of Object.entries(campaignScores)) {
    if (score > maxScore) {
      maxScore = score;
      primaryCampaign = key;
    }
  }

  const campaign = db.data.campaigns[primaryCampaign];
  const aiResult = {
    primaryCampaign,
    campaignLabel: campaign ? campaign.name : 'Không xác định',
    campaignColor: campaign ? campaign.color : '#4fc3f7',
    confidencePercent: maxScore > 0 ? 100 : 0,
    allScores: campaignScores,
    detectedPayment: result.customerDetected ? null : 'ck'
  };

  // Offline Mode: Collect all ignored lines as sales comments
  const ignoredLines = result.lines.filter(l => l.type === 'ignored').map(l => l.raw.trim()).filter(Boolean);
  // Ghi chú chuẩn: hàng đầu luôn là tên khách, dặn dò nằm bên dưới
  const salesComment = customerFirstComment(result.customerDetected, ignoredLines.join('\n'));

  const currentOrder = {
    customer: result.customerDetected || '',
    payment: 'ck',
    items: [],
    customPromos: [],
    parsedLines: result.lines,
    aiResult: aiResult,
    giftOverrides: {},
    giftDeleted: {},
    giftQtyOverrides: {},
    rowOrder: null,
    rawChatText: text,
    salesComment: salesComment,
    tlnLines: null
  };

  // Dòng "Giá N thùng" đứng riêng (type 'tier-override'): mốc giá áp TOÀN ĐƠN.
  // Item nào không có mốc riêng trên dòng, không có giá tường minh và không phải
  // hàng tặng sẽ được tính đơn giá theo mốc này (bug 22/9/2026: dòng "Giá 2 thùng"
  // bị match nhầm thành item "Poster Pricelist" 0đ và không item nào được áp mốc).
  let orderTierQty = null;
  for (const line of result.lines) {
    if (line.type === 'tier-override' && line.data && line.data.priceTierQty != null) {
      orderTierQty = line.data.priceTierQty;
      break;
    }
  }

  result.lines.forEach(line => {
    if (line.type === 'matched') {
      const data = line.data;
      const calc = calculateOrderItem(data.matchedProduct, data.qty, data.unit);

      let finalPrice = calc.unitPrice;
      let finalTierLabel = calc.tierLabel;
      // Mốc giá hiệu lực: mốc ghi trên dòng ưu tiên; không có thì dùng mốc toàn
      // đơn. Dòng có giá tường minh (explicitPrice) hoặc hàng tặng KHÔNG áp mốc
      // toàn đơn — sales báo giá riêng thì giữ giá riêng.
      let effectiveTierQty = data.priceTierQty;
      if (effectiveTierQty == null && !data.isGift && data.explicitPrice === undefined && orderTierQty != null) {
        effectiveTierQty = orderTierQty;
      }
      if (effectiveTierQty !== undefined && effectiveTierQty !== null) {
        // Tier override: "giá 2 thùng" → tính đơn giá theo mốc 2 thùng
        finalPrice = db.getPriceForQty(data.matchedProduct, effectiveTierQty);
        if (data.matchedProduct.tiers) {
          for (const tier of data.matchedProduct.tiers) {
            if (effectiveTierQty >= tier.min_qty && effectiveTierQty <= tier.max_qty) {
              finalTierLabel = tier.label;
              break;
            }
          }
        }
      } else if (data.explicitPrice !== undefined) {
        finalPrice = getFinalUnitPrice(data.matchedProduct, data.explicitPrice, data.unit === 'thùng');
      }

      // ── Kiến trúc 2 tầng: khuôn mẫu (system) LUÔN giữ + quà sales bổ sung ──
      const explicitGiftObj = data.explicitGift ? processExplicitGift(data.explicitGift, data.matchedProduct, calc.foc) : null;
      const finalGift = combineGifts(calc.foc, explicitGiftObj);

      currentOrder.items.push({
        rawProduct: data.rawProduct,
        qty: data.qty,
        unit: data.unit,
        product: data.matchedProduct,
        unitPrice: data.isGift ? 0 : finalPrice,
        subtotal: data.isGift ? 0 : finalPrice * (data.unit === 'thùng' ? data.qty * (data.matchedProduct.box_size || 12) : data.qty),
        foc: finalGift,
        tierLabel: data.isGift ? 'Khuyến mãi' : finalTierLabel,
        manualPrice: data.isGift ? 0 : (data.explicitPrice !== undefined ? finalPrice : null),
        isGift: data.isGift || false,
        matchScore: data.matchScore || 0
      });
    } else if (line.type === 'unmatched') {
      currentOrder.items.push({
        rawName: line.data.rawProduct,
        qty: line.data.qty,
        unit: line.data.unit,
        product: null,
        unitPrice: 0,
        subtotal: 0,
        foc: null,
        tierLabel: '',
        manualPrice: line.data.isGift ? 0 : null,
        isGift: line.data.isGift || false
      });
    } else if (line.type === 'payment') {
      currentOrder.payment = line.data.value;
    }
  });

  // SYSTEM FEATURE: Merge duplicate items (same product + unit → sum qty)
  currentOrder.items = mergeDuplicateItems(currentOrder.items);

  return currentOrder;
}

// --- Offline RegEx Fallback Parser ---
export function runOfflineParser(text) {
  const currentOrder = buildOrderFromText(text);

  // Parse đơn MỚI → ngắt liên kết bản ghi chờ duyệt cũ. store.setState merge
  // dạng {...cũ, ...mới} nên key vắng mặt sẽ GIỮ id cũ → lần lưu sau đè mất
  // bản ghi của đơn trước đó (bug mất đơn chờ duyệt).
  store.setState({ currentOrder: { ...currentOrder, _pendingId: null } });

  const custEl = document.getElementById('customerName');
  const payEl = document.getElementById('paymentMethod');
  if (custEl) custEl.value = currentOrder.customer;
  if (payEl) payEl.value = currentOrder.payment;

  // Cảnh báo khách có đơn giá riêng
  CustomerNotes.checkAndWarn(currentOrder.customer);

  // Ghi chú mặc định trống — chỉ tính những gì user tự điền tay
  const noteEl = document.getElementById('orderNote');
  if (noteEl) noteEl.value = '';

  uiRenderer.renderAIDetection(currentOrder.aiResult);
  uiRenderer.renderParsedPreview(currentOrder.parsedLines);
  showToast(`Đã phân tích đơn hàng (Chế độ Offline)!`, 'success');
}

// --- Quét lại nội dung tin nhắn trước khi xuất Excel ---
// Người dùng có thể bổ sung nội dung vào ô tin nhắn sau lần phân tích cuối.
// Hàm này phát hiện nội dung thay đổi (so với rawChatText đã lưu) và parse lại
// để cập nhật phần thông tin nội dung tin nhắn và preview.
// QUAN TRỌNG: Giữ nguyên 100% kết quả đơn hàng bên dưới (items, quà tặng, khuyến mãi,
// giá sửa tay, sản phẩm thêm tay...) mà người dùng đã chỉnh sửa/xác nhận.
export function rescanOrderTextIfChanged() {
  const textEl = document.getElementById('orderText');
  if (!textEl) return false;
  const text = textEl.value.trim();
  if (!text) return false; // không có nội dung → giữ nguyên đơn hiện tại

  const order = store.getState().currentOrder;
  if (order && order.rawChatText === text) return false; // không đổi từ lần parse trước

  const freshParse = buildOrderFromText(text);

  if (!order) {
    store.setState({ currentOrder: freshParse });
    const custEl = document.getElementById('customerName');
    const payEl = document.getElementById('paymentMethod');
    if (custEl && freshParse.customer) custEl.value = freshParse.customer;
    if (payEl && freshParse.payment) payEl.value = freshParse.payment;
    uiRenderer.renderAIDetection(freshParse.aiResult);
    uiRenderer.renderParsedPreview(freshParse.parsedLines);
    return true;
  }

  // Nội dung tin nhắn đã thay đổi nhưng đơn hàng đã có sẵn:
  // CHỈ cập nhật phần thông tin nội dung tin nhắn (preview, AI detection, salesComment, rawChatText).
  // Giữ nguyên 100% kết quả đơn hàng bên dưới (items, quà tặng, khuyến mãi, giá sửa tay, sản phẩm thêm tay...).
  const updatedOrder = {
    ...order,
    rawChatText: text,
    parsedLines: freshParse.parsedLines,
    aiResult: freshParse.aiResult,
    salesComment: freshParse.salesComment,
  };
  store.setState({ currentOrder: updatedOrder });

  uiRenderer.renderAIDetection(updatedOrder.aiResult);
  uiRenderer.renderParsedPreview(updatedOrder.parsedLines);
  return true;
}

// ═══════════════════════ TỰ ĐỘNG QUÉT LẠI AN TOÀN (Auto-rescan) ═══════════════════════
// Thiết kế "hướng 1": auto-rescan TUYỆT ĐỐI KHÔNG tự sửa bảng đơn hàng.
// - rescanOrderTextIfChanged() chỉ refresh preview/AI detection (giữ nguyên items).
// - Nếu tin nhắn có thay đổi VỀ SẢN PHẨM → chỉ hiện toast + dialog để NGƯỜI DÙNG quyết định.
// - Nếu chỉ đổi chữ/khách/thanh toán → im lặng hoàn toàn.

const AUTO_RESCAN_DEBOUNCE_MS = 1000;   // Đợi user ngừng gõ 1 giây mới quét
const AUTO_RESCAN_DEFER_RETRY_MS = 400; // Hoãn xử lý khi user đang bận với dialog/preview khác

/**
 * Tạo khoá nhận diện một dòng sản phẩm để so sánh.
 * Dùng CÙNG HỆT format khoá với mergeDuplicateItems() trong calculator.js
 * (`p:<productId>|<unit>` cho SP khớp danh mục, `r:<tên raw>|<unit>` cho SP ngoài danh mục)
 * → đảm bảo nhất quán với cách app tự gộp dòng trùng.
 * @param {{product?: {id?: string}|null, rawProduct?: string, rawName?: string, unit?: string}} item
 * @returns {string} Khoá duy nhất theo (sản phẩm + đơn vị)
 */
function buildDiffKey(item) {
  if (item.product && item.product.id) return `p:${item.product.id}|${item.unit}`;
  const rawName = String(item.rawProduct || item.rawName || '').toLowerCase().trim();
  return `r:${rawName}|${item.unit}`;
}

/** Tên hiển thị của một dòng sản phẩm (ưu tiên tên chuẩn trong danh mục) */
function diffDisplayName(item) {
  if (item.product && item.product.name) return item.product.name;
  return String(item.rawProduct || item.rawName || '(không rõ tên)');
}

/**
 * Gom nhóm items theo khoá (sản phẩm + đơn vị), cộng dồn số lượng.
 * Bỏ qua dòng quà (isGift) vì quà do hệ thống quản lý riêng qua foc/giftOverrides,
 * không thuộc phạm vi so sánh sản phẩm.
 * @param {Array<object>} items
 * @returns {Map<string, {key: string, name: string, unit: string, qty: number, source: object}>}
 */
function aggregateItemsByKey(items) {
  const map = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || it.isGift) continue; // quà tặng: bỏ qua
    const key = buildDiffKey(it);
    const qty = Number(it.qty) || 0;
    const entry = map.get(key);
    if (entry) {
      entry.qty += qty;
    } else {
      map.set(key, { key, name: diffDisplayName(it), unit: it.unit || '', qty, source: it });
    }
  }
  return map;
}

/**
 * So sánh items của bản parse tươi (đã merge trùng) với đơn hàng hiện tại
 * để phát hiện KHÁC BIỆT SẢN PHẨM: thêm mới / đổi SL / thiếu so với tin nhắn.
 *
 * Quy ước:
 * - "Thiếu" KHÔNG tính sản phẩm user thêm tay (isCustom) vì chúng vốn dĩ không nằm trong tin nhắn.
 * - Kết quả hasChanges bao gồm cả "thiếu" (tin nhắn bỏ bớt món cũng là khác biệt cần cảnh báo).
 *
 * @param {Array<object>} freshItems Items từ buildOrderFromText(text) — đã merge duplicate.
 * @param {Array<object>} currentItems Items hiện tại của đơn (store.getState().currentOrder.items).
 * @returns {{added: Array, qtyChanged: Array, missing: Array, hasChanges: boolean}}
 */
export function computeProductDiff(freshItems, currentItems) {
  const freshMap = aggregateItemsByKey(freshItems);
  const currentMap = aggregateItemsByKey(currentItems);

  const added = [];
  const qtyChanged = [];

  for (const f of freshMap.values()) {
    const c = currentMap.get(f.key);
    if (!c) {
      // Thêm mới: có trong tin nhắn nhưng chưa có trong đơn
      added.push({ key: f.key, name: f.name, qty: f.qty, unit: f.unit, source: f.source });
    } else if (c.qty !== f.qty) {
      // Đổi số lượng cùng sản phẩm + đơn vị
      qtyChanged.push({ key: f.key, name: f.name, unit: f.unit, oldQty: c.qty, newQty: f.qty });
    }
  }

  // Danh sách khoá SP user thêm tay → loại khỏi cảnh báo "thiếu"
  const customKeys = new Set(
    (Array.isArray(currentItems) ? currentItems : [])
      .filter(it => it && !it.isGift && it.isCustom)
      .map(buildDiffKey)
  );

  const missing = [];
  for (const c of currentMap.values()) {
    if (freshMap.has(c.key)) continue;
    if (customKeys.has(c.key)) continue;
    // Thiếu: còn trong đơn nhưng tin nhắn không còn nữa → CHỈ cảnh báo, không tự xoá
    missing.push({ key: c.key, name: c.name, unit: c.unit, qty: c.qty });
  }

  return {
    added,
    qtyChanged,
    missing,
    hasChanges: added.length > 0 || qtyChanged.length > 0 || missing.length > 0
  };
}

/**
 * Kiểm tra user đang bận với UI khác: đang focus vào #parsedPreview
 * hoặc đang mở dialog xác nhận (#confirmDialogOverlay).
 * @returns {boolean} true nếu nên HOÃN việc auto-rescan sang tick sau.
 */
function isUserBusyWithOtherUI() {
  if (typeof document === 'undefined') return false;
  if (document.getElementById('confirmDialogOverlay')) return true;
  const active = document.activeElement;
  if (!active) return false;
  const preview = document.getElementById('parsedPreview');
  return !!(preview && preview.contains(active));
}

/**
 * Thân lệnh auto-rescan (chạy sau debounce):
 * 1. Gọi rescanOrderTextIfChanged() — nếu text đổi sẽ refresh preview/AI detection (giữ nguyên bảng đơn).
 * 2. So sánh sản phẩm giữa bản parse tươi và đơn hiện tại.
 * 3. Có khác biệt SP → toast kèm nút "Xem & cập nhật" mở dialog so sánh; không → im lặng.
 * @private
 */
function runAutoRescan() {
  if (isUserBusyWithOtherUI()) {
    // User đang tương tác chỗ khác → hoãn đến tick sau, không chen ngang
    setTimeout(runAutoRescan, AUTO_RESCAN_DEFER_RETRY_MS);
    return;
  }

  let changed = false;
  try {
    changed = rescanOrderTextIfChanged();
  } catch (err) {
    console.error('[auto-rescan] Lỗi khi quét lại nội dung tin nhắn:', err);
    return;
  }
  if (!changed) return; // text không đổi so với lần parse trước → không làm gì

  const textEl = document.getElementById('orderText');
  const text = textEl ? String(textEl.value || '').trim() : '';
  if (!text) return;

  // Parse lại lần nữa CHỈ để lấy freshItems so sánh (rescanOrderTextIfChanged giữ nguyên logic,
  // không trả freshParse ra ngoài nên phải chạy lại — parser regex nhẹ, chi phí chấp nhận được).
  let fresh;
  try {
    fresh = buildOrderFromText(text);
  } catch (err) {
    console.error('[auto-rescan] Lỗi khi parse lại để so sánh sản phẩm:', err);
    return;
  }

  const currentItems = store.getState().currentOrder?.items;
  let diff;
  try {
    diff = computeProductDiff(fresh.items, currentItems);
  } catch (err) {
    console.error('[auto-rescan] Lỗi khi so sánh sản phẩm:', err);
    return;
  }
  if (!diff || !diff.hasChanges) return; // chỉ đổi chữ/khách/thanh toán → im lặng

  showToast('📝 Tin nhắn có thay đổi về sản phẩm', 'info', {
    label: 'Xem & cập nhật',
    handler: () => showProductDiffDialog()
  });
}

/**
 * Áp dụng khác biệt vào đơn hiện tại (CHỈ chạy khi user bấm "Áp dụng vào đơn").
 * - Đổi SL: cập nhật qty các dòng trùng khoá (nếu bị tách nhiều dòng thì cộng dồn về dòng đầu).
 * - Thêm mới: append nguyên trạng thái từ bản parse, ép isGift=false theo spec.
 * - Thiếu: KHÔNG tự xoá (chỉ hiển thị cảnh báo trong dialog).
 * Sau khi merge gọi renderOrderResults() để vẽ lại bảng đơn.
 * @param {{added: Array, qtyChanged: Array}} diff Kết quả từ computeProductDiff().
 * @private
 */
function applyProductDiff(diff) {
  const order = store.getState().currentOrder;
  if (!order) return;

  const items = Array.isArray(order.items) ? [...order.items] : [];

  // 1) Cập nhật số lượng các dòng trùng khoá
  for (const ch of diff.qtyChanged) {
    const idxs = [];
    items.forEach((it, i) => { if (buildDiffKey(it) === ch.key) idxs.push(i); });
    if (idxs.length === 0) continue;

    // Nếu cùng khoá bị tách nhiều dòng: phần dư giữ ở các dòng sau, dòng đầu nhận phần chênh lệch
    const othersSum = idxs.slice(1).reduce((sum, i) => sum + (Number(items[i].qty) || 0), 0);
    const target = items[idxs[0]];
    const newQty = Math.max(0, ch.newQty - othersSum);
    target.qty = newQty;

    // Tính lại subtotal theo giá hiện tại của dòng (giữ giá user đã sửa tay)
    if (!target.isGift && typeof target.unitPrice === 'number') {
      const boxSize = (target.product && target.product.box_size) || 12;
      target.subtotal = target.unitPrice * (target.unit === 'thùng' ? newQty * boxSize : newQty);
    }
  }

  // 2) Thêm mới: copy nguyên field từ bản parse (giá/tier/foc theo luật thương hiệu), ép isGift=false
  for (const ad of diff.added) {
    if (!ad.source) continue;
    items.push({ ...ad.source, isGift: false });
  }

  store.setState({ currentOrder: { ...order, items } });
  uiRenderer.renderOrderResults(store.getState().currentOrder);
}

/**
 * Dialog so sánh 3 nhóm khác biệt [Thêm mới / Đổi số lượng / Thiếu so với tin nhắn].
 * Tự tạo DOM dynamic theo pattern modal-overlay của showConfirmDialog (src/order/actions.js).
 * - "Áp dụng vào đơn"  → applyProductDiff() rồi đóng dialog.
 * - "Giữ đơn hiện tại" / Esc / click nền → đóng, không đổi gì.
 * @private
 */
function showProductDiffDialog() {
  if (typeof document === 'undefined') return;

  const textEl = document.getElementById('orderText');
  const text = textEl ? String(textEl.value || '').trim() : '';
  if (!text) return;

  // Tính LẠI diff tại thời điểm mở dialog để tránh dữ liệu cũ (text có thể vừa đổi tiếp)
  let diff;
  try {
    diff = computeProductDiff(buildOrderFromText(text).items, store.getState().currentOrder?.items);
  } catch (err) {
    console.error('[auto-rescan] Lỗi khi tính lại khác biệt:', err);
    return;
  }
  if (!diff.hasChanges) {
    showToast('Không còn khác biệt về sản phẩm.', 'info');
    return;
  }

  // Dọn dialog cũ còn sót (nếu có)
  const existingOverlay = document.getElementById('productDiffOverlay');
  if (existingOverlay) existingOverlay.remove();

  const overlay = document.createElement('div');
  overlay.id = 'productDiffOverlay';
  overlay.className = 'modal-overlay';
  overlay.style.display = '';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  const content = document.createElement('div');
  content.className = 'modal-content';
  content.style.maxWidth = '640px';
  content.onclick = e => e.stopPropagation(); // click vào nội dung không đóng

  // ── Tiêu đề ──
  const header = document.createElement('div');
  header.className = 'card-header';
  header.style.marginBottom = 'var(--space-md)';
  const titleEl = document.createElement('div');
  titleEl.className = 'card-title';
  titleEl.textContent = '🔄 Tin nhắn có thay đổi về sản phẩm';
  header.appendChild(titleEl);

  /**
   * Vẽ 1 nhóm kết quả: tiêu đề nhóm + danh sách dòng (hoặc "Không có").
   * @param {string} groupTitle
   * @param {Array<{name: string}>} rows Mảng dòng dữ liệu.
   * @param {(row: object) => string} rowText Hàm tạo nội dung chữ mỗi dòng.
   * @param {string} color Màu nhãn nhóm.
   */
  const renderGroup = (groupTitle, rows, rowText, color) => {
    const wrap = document.createElement('div');
    wrap.style.marginBottom = 'var(--space-md)';
    const label = document.createElement('div');
    label.style.cssText = `font-weight:600;color:${color};margin-bottom:4px;font-size:0.9rem;`;
    label.textContent = `${groupTitle} (${rows.length})`;
    wrap.appendChild(label);

    const list = document.createElement('div');
    list.style.cssText = 'font-size:0.85rem;line-height:1.7;color:var(--text-2);white-space:pre-wrap;';
    list.textContent = rows.length === 0
      ? '— Không có'
      : rows.map(rowText).join('\n');
    wrap.appendChild(list);
    return wrap;
  };

  content.appendChild(header);
  content.appendChild(renderGroup(
    '➕ Thêm mới (có trong tin nhắn, chưa có trong đơn)',
    diff.added,
    r => `• ${r.name}: ${r.qty} ${r.unit}`,
    '#2e7d32'
  ));
  content.appendChild(renderGroup(
    '🔁 Đổi số lượng',
    diff.qtyChanged,
    r => `• ${r.name}: ${r.oldQty} → ${r.newQty} ${r.unit}`,
    '#1565c0'
  ));
  content.appendChild(renderGroup(
    '⚠️ Thiếu so với tin nhắn (sẽ KHÔNG tự xoá)',
    diff.missing,
    r => `• ${r.name}: ${r.qty} ${r.unit}`,
    '#b00020'
  ));

  // ── Hàng nút bấm ──
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex; gap:8px; justify-content:flex-end; margin-top:var(--space-md);';

  const btnKeep = document.createElement('button');
  btnKeep.className = 'btn btn-ghost btn-sm';
  btnKeep.textContent = 'Giữ đơn hiện tại';

  const btnApply = document.createElement('button');
  btnApply.className = 'btn btn-primary btn-sm';
  btnApply.textContent = 'Áp dụng vào đơn';
  // Không có gì để áp dụng (chỉ cảnh báo thiếu) → vô hiệu nút áp dụng
  const applicableCount = diff.added.length + diff.qtyChanged.length;
  if (applicableCount === 0) btnApply.disabled = true;
  btnApply.title = applicableCount > 0
    ? `Thêm ${diff.added.length} dòng mới, cập nhật ${diff.qtyChanged.length} dòng đổi SL`
    : 'Chỉ có cảnh báo thiếu — không có gì để áp dụng';

  btnRow.appendChild(btnKeep);
  btnRow.appendChild(btnApply);
  content.appendChild(btnRow);

  overlay.appendChild(content);
  document.body.appendChild(overlay);

  // Đóng dialog: gỡ overlay + gỡ listener Esc
  const closeDialog = () => {
    overlay.remove();
    document.removeEventListener('keydown', onEscKey);
  };

  /** Esc = đóng, không đổi gì */
  const onEscKey = (e) => {
    if (e.key === 'Escape') closeDialog();
  };

  btnApply.addEventListener('click', () => {
    try {
      applyProductDiff(diff);
    } finally {
      closeDialog();
    }
  });
  btnKeep.addEventListener('click', closeDialog);
  overlay.onclick = (e) => { if (e.target === overlay) closeDialog(); }; // click nền = đóng
  document.addEventListener('keydown', onEscKey);
}

/**
 * Khởi tạo auto-rescan: gắn listener DEBOUNCE lên ô #orderText.
 * - Mỗi keystroke / paste reset bộ đếm 1000ms; hết giờ mới chạy runAutoRescan().
 * - Chỉ cần gọi MỘT lần lúc app khởi động (việc wiring ở main.js do người khác phụ trách).
 * @example
 * import { initAutoRescan } from './order/builder.js';
 * initAutoRescan();
 */
export function initAutoRescan() {
  if (typeof document === 'undefined') return;
  const textEl = document.getElementById('orderText');
  if (!textEl) return;

  let debounceTimer = null;

  /** Reset bộ đếm debounce — mọi keystroke/paste đều đi qua đây */
  const scheduleRescan = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runAutoRescan, AUTO_RESCAN_DEBOUNCE_MS);
  };

  // paste thường kích hoạt sẵn input event, nhưng lắng nghe thêm để chắc chắn không bỏ sót
  textEl.addEventListener('input', scheduleRescan);
  textEl.addEventListener('paste', scheduleRescan);
}


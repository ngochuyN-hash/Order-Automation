import { db } from '../../db.js';
import { store } from '../../store.js';
import { uiRenderer, showToast, escapeHtml } from '../../ui-renderer.js';
import { normalizeFull } from '../../parser.js';
import { tlnCoversRawText, splitRawIntoTlnLines, refineAiTlnLines } from './tln-coverage.mjs';
import { rescanOrderTextIfChanged } from './builder.js';
import { validateOrderBeforeExport, confirmExportIfIssues } from './actions.js';
import { getSellers, generateOrderTitle, peekOrderSequence, commitOrderSequence, findSellerByKey, parseSellerKey } from '../seller/manager.js';
import { aiService } from '../../ai-service.js';
import { trapFocus } from '../ui/confirm-dialog.js';
import { markDone } from './pending.js';

/**
 * Kiểm tra bản chia cắt của AI có phủ ĐỦ mọi dòng user dán vào hay không
 * đã tách sang module thuần ./tln-coverage.mjs (unit-test được ngoài Electron):
 * chịu được @mention + cụm lệnh "lên đơn" trong tin nhắn 1 dòng, có fallback
 * so phủ theo token khi AI tách/dồn dòng khác vị trí.
 */

/** Ráp khối TLN: tên khách hàng đầu + nội dung + ghi chú điền tay (bỏ trùng). */
function assembleTlnLines(bodyLines, customerName, orderNote) {
  const custNorm = customerName ? normalizeFull(customerName) : '';
  // Tên khách luôn ở hàng đầu TLN — bỏ dòng trùng tên khách trong nội dung
  const body = custNorm
    ? bodyLines.filter(l => normalizeFull(l) !== custNorm)
    : [...bodyLines];
  const lines = customerName ? [customerName, ...body] : body;

  // Ghi chú thêm của Sales (điền tay) — tách mỗi dòng dặn dò thành 1 dòng,
  // bỏ dòng trùng nội dung đã có trong phần trên để khỏi lặp.
  if (orderNote) {
    const seen = new Set(lines.map(l => normalizeFull(l)));
    orderNote.split('\n').map(l => l.trim()).filter(Boolean).forEach(l => {
      const key = normalizeFull(l);
      if (seen.has(key)) return;
      seen.add(key);
      lines.push(l);
    });
  }
  return lines.join('\n');
}

/**
 * Generate TLN (order summary) text.
 * Priority 1: dòng do AI CHIA CẮT THÀNH Ý (tlnLines) — AI tách toàn bộ nội
 *   dung dán thành từng dòng theo ý, giữ nguyên văn. CHỈ nhận khi kiểm tra
 *   đầy đủ pass (mọi dòng dán đều hiện diện trong output AI); thiếu dòng →
 *   fallback xuống Priority 2 để KHÔNG BAO GIỜ mất thông tin.
 * Priority 2: TÁCH DÒNG QUY TẮC CỤC BỘ từ dòng thô (splitRawIntoTlnLines) —
 *   đảm bảo kết quả cuối LUÔN được ngắt dòng hợp lý kể cả khi AI trả lời tệ:
 *   bỏ @mention/cụm lệnh, chia ý tại [;,]/"+"/hết câu, tách "Tên khách: ...".
 * Priority 3: Offline fallback — reconstruct from parsed data when no raw text.
 */
export function generateTLNText(order, formData = null) {
  const hasFormContext = !!formData;
  const customerName = (hasFormContext
    ? (formData.customerName || '')
    : (document.getElementById('customerName')?.value || '')).trim();
  const orderNote = (hasFormContext
    ? (formData.note || '')
    : (document.getElementById('orderNote')?.value || '')).trim();

  // Nội dung dán: luồng màn hình dùng ô live; đơn chờ duyệt dùng snapshot form
  // đã lưu, tuyệt đối không đọc nhầm đơn đang mở.
  const liveText = (hasFormContext
    ? String(formData.orderText || '')
    : (document.getElementById('orderText')?.value || '')).trim();
  const rawText = liveText || String(order.rawChatText || '');
  const rawLines = rawText.split('\n').map(l => l.trim()).filter(Boolean);

  // Priority 1: bản chia cắt thành ý của AI
  const aiLines = Array.isArray(order.tlnLines)
    ? order.tlnLines.map(l => String(l).trim()).filter(Boolean)
    : (order.tlnLines ? [String(order.tlnLines).trim()].filter(Boolean) : []);
  if (aiLines.length > 0) {
    // Kiểm tra đầy đủ chạy trên bản tln VERBATIM trước sanitize (tlnVerbatim)
    // vì sanitizer có thể viết lại dòng quà ("FOC ...") — bản verbatim mới
    // phản ánh đúng những gì AI trích từ tin nhắn.
    const verbatimLines = Array.isArray(order.tlnVerbatim)
      ? order.tlnVerbatim.map(l => String(l).trim()).filter(Boolean)
      : aiLines;
    if (tlnCoversRawText(verbatimLines, rawLines, customerName)) {
      // Phòng thủ: AI lười chia (cả đoạn trong 1 phần tử mảng tln) vẫn pass
      // coverage — bẻ lại từng ý trước khi ghi Excel, không mất nội dung.
      return assembleTlnLines(refineAiTlnLines(aiLines), customerName, orderNote);
    }
    console.warn('[TLN] AI chia cắt thiếu dòng so với nội dung dán — dùng tách dòng quy tắc cục bộ.');
  }

  // Priority 2: tách dòng theo quy tắc từ nội dung dán — kết quả cuối luôn
  // được ngắt dòng hợp lý (không đổ cả đoạn dài nguyên bản vào Excel).
  if (rawLines.length > 0) {
    return assembleTlnLines(splitRawIntoTlnLines(rawLines), customerName, orderNote);
  }

  // Priority 3: Offline fallback — reconstruct from parsed data using rawProduct
  const lines = [];
  if (customerName) lines.push(customerName);

  // Đưa thông tin bổ sung (địa chỉ, SĐT, ghi chú...) từ salesComment vào TLN.
  // salesComment có thể đã mang tên khách ở hàng đầu → bỏ dòng trùng để khỏi lặp.
  if (order.salesComment) {
    const pushedCustNorm = customerName ? normalizeFull(customerName) : '';
    order.salesComment.split('\n').map(l => l.trim()).filter(Boolean).forEach(l => {
      if (pushedCustNorm && normalizeFull(l) === pushedCustNorm) return;
      lines.push(l);
    });
  }

  if (order.items && order.items.length > 0) {
    order.items.forEach(item => {
      const name = item.rawName || item.rawProduct || (item.product ? item.product.name : '');
      const qty = item.qty;
      const unit = item.unit || 'thùng';
      if (item.isGift) {
        lines.push(`FOC ${qty} ${unit} ${name}`);
      } else {
        lines.push(`${qty} ${unit} ${name}`);
      }
    });
  }

  const paymentSelect = hasFormContext ? null : document.getElementById('paymentMethod');
  const paymentValue = hasFormContext
    ? String(formData.payment || order.payment || '')
    : (paymentSelect ? paymentSelect.value : String(order.payment || ''));
  const paymentLabels = {
    ck: 'Chuyển khoản (CK)',
    cod: 'COD',
    tt: 'Tiền mặt',
    congno: 'Công nợ',
    other: 'Khác'
  };
  const paymentLabel = paymentSelect
    ? (paymentSelect.options[paymentSelect.selectedIndex]?.text || '')
    : (paymentLabels[paymentValue] || paymentValue);
  if (paymentLabel) lines.push(`TT ${paymentLabel}`);

  // Ghi chú thêm của Sales (tách mỗi dòng dặn dò thành 1 dòng trong Excel)
  if (orderNote) {
    const pushedCustNorm2 = customerName ? normalizeFull(customerName) : '';
    orderNote.split('\n').map(l => l.trim()).filter(Boolean).forEach(l => {
      if (pushedCustNorm2 && normalizeFull(l) === pushedCustNorm2) return; // trùng tên khách
      lines.push(l);
    });
  }

  return lines.join('\n');
}

let _excelExportInProgress = false;

function cloneExportData(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function normalizeExportForm(order, formData = {}) {
  return {
    customerName: String(formData.customerName || order?.customer || '').trim(),
    payment: formData.payment || order?.payment || 'ck',
    note: String(formData.note || ''),
    sellerKey: String(formData.sellerKey || ''),
    orderText: String(formData.orderText || order?.rawChatText || '')
  };
}

function readLiveExportForm(order) {
  return normalizeExportForm(order, {
    customerName: document.getElementById('customerName')?.value || '',
    payment: document.getElementById('paymentMethod')?.value || order?.payment || 'ck',
    note: document.getElementById('orderNote')?.value || '',
    sellerKey: document.getElementById('sellerName')?.value || document.getElementById('sellerSearch')?.value || '',
    orderText: document.getElementById('orderText')?.value || order?.rawChatText || ''
  });
}

/** Dựng toàn bộ payload Excel từ rows + form đã chốt, dùng chung live/pending. */
export function buildExcelExportPlan(order, form, orderDate, rows) {
  const groups = {};
  rows.forEach(row => {
    let productObj = null;
    let campaignKey = null;

    if (row.type === 'matched' || row.type === 'unmatched') {
      productObj = row.product;
    } else if (row.type === 'gift') {
      if (row.productId) productObj = db.findProductById(row.productId);
      if (!productObj && row.name) {
        productObj = db.getAllProducts().find(p => p.name === row.name);
      }
    }

    if (productObj?.campaignKey) campaignKey = productObj.campaignKey;
    else if (order.aiResult?.primaryCampaign) campaignKey = order.aiResult.primaryCampaign;

    let brand = 'zentor';
    if (campaignKey) {
      const camp = db.data.campaigns[campaignKey];
      brand = camp?.brand || campaignKey;
    }
    if (!groups[brand]) groups[brand] = [];
    groups[brand].push({ row, productObj });
  });

  const brands = Object.keys(groups);
  const payloadByBrand = {};
  const seqByBrand = {};
  const tlnText = generateTLNText(order, form);
  const sellers = getSellers();
  const selectedSeller = findSellerByKey(sellers, form.sellerKey);
  const sellerName = selectedSeller?.name || parseSellerKey(form.sellerKey).name || '';
  const discount = selectedSeller?.discount || '';

  for (const brand of brands) {
    const merged = [];
    const focMap = new Map();
    for (const entry of groups[brand]) {
      if (entry.row.type === 'gift') {
        const key = `${entry.row.name || ''}|${entry.row.unit || ''}|${entry.row.giftKind || ''}`;
        if (focMap.has(key)) merged[focMap.get(key)].row.qty += entry.row.qty;
        else {
          focMap.set(key, merged.length);
          merged.push(entry);
        }
      } else {
        merged.push(entry);
      }
    }

    const seq = peekOrderSequence(brand);
    seqByBrand[brand] = seq;
    payloadByBrand[brand] = {
      brand,
      customerName: form.customerName,
      orderDate,
      orderTitle: generateOrderTitle(brand, sellerName, discount, seq),
      tlnText,
      items: merged.map(({ row, productObj }) => {
        const isGift = row.type === 'gift' || !!row.isGift || Number(row.subtotal) === 0 || Number(row.bottlePrice) === 0;
        let unitPrice = 0;
        if (!isGift) {
          unitPrice = row.bottlePrice || 0;
        } else if (row.type === 'gift' && productObj?.tiers?.length) {
          const validPrices = productObj.tiers.map(t => t.price).filter(p => typeof p === 'number' && p > 0);
          if (validPrices.length) unitPrice = Math.min(...validPrices);
        } else {
          unitPrice = row.bottlePrice || 0;
        }
        const rawProduct = row.type === 'gift'
          ? row.name
          : (row.product?.name || row.rawName || row.rawProduct || '');
        return {
          rawProduct,
          qty: row.qty,
          unit: row.unit,
          product: productObj ? {
            name: productObj.name,
            spec: productObj.spec,
            category: productObj.category,
            box_size: productObj.box_size,
            tiers: productObj.tiers
          } : null,
          unitPrice,
          isGift,
          focSource: isGift ? (productObj ? 'campaign' : 'manual') : null,
          giftKind: isGift ? (row.giftKind || (productObj ? 'foc' : 'extra')) : undefined
        };
      })
    };
  }

  return { brands, payloadByBrand, seqByBrand };
}

/**
 * Xuất Excel từ đơn đang mở hoặc từ snapshot của một record chờ duyệt.
 * Context pending gồm { pendingId, order, form, expectedSignature, progressElement }.
 * Renderer chỉ cho một luồng export chạy tại một thời điểm để tránh đụng file
 * xen kẽ giữa các brand và tránh double-click tạo bản ghi trùng.
 */
export async function exportToExcel(context = null) {
  if (_excelExportInProgress) {
    showToast('Một lần xuất Excel khác đang chạy. Vui lòng đợi hoàn tất trước khi thử lại.', 'warning');
    return { status: 'busy' };
  }
  _excelExportInProgress = true;
  try {
    return await runExcelExport(context);
  } catch (error) {
    console.error('[Export] Unexpected export failure:', error);
    showToast(`Lỗi xuất Excel: ${error?.message || String(error)}`, 'error');
    return { status: 'error', error };
  } finally {
    _excelExportInProgress = false;
  }
}

async function runExcelExport(context = null) {
  const isPendingExport = !!(context && context.order);
  const isLiveExport = !isPendingExport;

  // Chỉ luồng màn hình chính được rescan nội dung live. Đơn chờ duyệt đã có
  // snapshot hoàn chỉnh nên không được đọc/ghi đơn đang mở.
  if (isLiveExport && rescanOrderTextIfChanged()) {
    showToast('Đã quét lại nội dung tin nhắn trước khi xuất!', 'info');
  }

  const order = isPendingExport
    ? cloneExportData(context.order)
    : store.getState().currentOrder;
  if (!order) {
    showToast('Không có đơn hàng để xuất!', 'error');
    return { status: 'error' };
  }
  const form = isPendingExport
    ? normalizeExportForm(order, context.form)
    : readLiveExportForm(order);
  const pendingIdAtStart = isPendingExport
    ? (context.pendingId || null)
    : ((order && order._pendingId) || null);
  const expectedSignature = isPendingExport ? (context.expectedSignature || null) : null;
  const customerName = form.customerName;
  if (!customerName) {
    showToast('Vui lòng nhập tên khách hàng trước khi xuất Excel!', 'error');
    return { status: 'error' };
  }

  if (!order.items || order.items.length === 0) {
    showToast('Đơn hàng không có sản phẩm nào để xuất!', 'error');
    return { status: 'error' };
  }

  // Validate trước khi xuất (liệt kê dòng chưa khớp / giá 0đ / khớp yếu).
  // getOrderTableRows có mutate input nên luôn dùng một clone riêng.
  const { rows } = uiRenderer.getOrderTableRows(cloneExportData(order));
  const issues = validateOrderBeforeExport(rows, customerName);
  if (!(await confirmExportIfIssues(issues, 'xuất Excel'))) {
    return { status: 'cancelled' };
  }

  if (!window.electronAPI || !window.electronAPI.exportOrder) {
    showToast('Chức năng xuất Excel chỉ hoạt động trong ứng dụng Desktop (Electron)!', 'error');
    return { status: 'error' };
  }

  const progressElement = isPendingExport
    ? (context.progressElement || null)
    : document.getElementById('btnExportExcel');
  if (isLiveExport && !progressElement) {
    showToast('Không tìm thấy nút xuất Excel!', 'error');
    return { status: 'error' };
  }
  const originalHtml = progressElement ? progressElement.innerHTML : '';
  if (progressElement) {
    progressElement.disabled = true;
    progressElement.innerHTML = `⏳ Đang xuất...`;
  } else {
    showToast('Đang xuất Excel cho đơn đã chọn...', 'info');
  }

  try {
    const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  const orderDate = `${dd}/${mm}/${yyyy}`;

  const { brands, payloadByBrand, seqByBrand } = buildExcelExportPlan(order, form, orderDate, rows);
  let successCount = 0;
  let errors = [];
  let exportedPaths = [];
  let brandIndex = 0;

  for (const brand of brands) {
    brandIndex += 1;
    if (progressElement) {
      progressElement.innerHTML = `⏳ Đang xuất ${brand.toUpperCase()} (${brandIndex}/${brands.length})…`;
    }
    const payload = payloadByBrand[brand];

    try {
      // Electron mode: use IPC (no HTTP server needed)
      const result = await window.electronAPI.exportOrder(payload);
      if (result.success) {
        successCount++;
        // Ghi file thành công mới tăng bộ đếm PO lên đúng STT đã dùng
        commitOrderSequence(brand, seqByBrand[brand]);
        exportedPaths.push({ brand, filePath: result.filePath, created: result.created, opened: result.opened, wasOpenInExcel: result.wasOpenInExcel });
      } else {
        errors.push(`${brand.toUpperCase()}: ${result.error || 'Lỗi không xác định'}`);
      }
    } catch (err) {
      // Không nuốt lỗi: hiển thị nguyên văn để biết nguyên nhân thật
      // (clone payload, handler throw, channel bị chặn, ...).
      const detail = err && err.message ? err.message : String(err);
      console.error('[Export] IPC exportOrder rejected:', err);
      errors.push(`${brand.toUpperCase()}: Lỗi IPC Excel export — ${detail}`);
    }
  }

  // --- AI-assisted error recovery (button stays disabled during this) ---
  if (errors.length > 0) {
    const resolutionErrors = errors.filter(e =>
      e.includes('Không nhận diện') || e.includes('Không tìm thấy') ||
      e.includes('vui lòng tạo') || e.includes('Vui lòng tạo') ||
      e.includes('Chưa có file')
    );

    if (resolutionErrors.length > 0 && window.electronAPI.diagnoseExcel) {
      // Extract brand from error string (format: "BRAND: message")
      const errBrand = resolutionErrors[0].split(':')[0].trim().toLowerCase();
      const retryPayload = payloadByBrand[errBrand];
      if (progressElement) progressElement.innerHTML = `🤖 AI đang xử lý lỗi...`;
      const aiFix = await aiDiagnoseExportError(errBrand, orderDate, resolutionErrors[0]);
      if (aiFix && aiFix.resolved && retryPayload) {
        // AI resolved the issue — retry export with the fixed file
        showToast(`✅ AI: ${aiFix.explanation}`, 'success');
        if (progressElement) progressElement.innerHTML = `⏳ Đang xuất lại...`;
        const retryResult = await retryExportWithFile(errBrand, aiFix.filePath, retryPayload);
        if (retryResult && retryResult.success) {
          successCount++;
          // Retry dùng lại STT cũ của brand lỗi — thành công mới commit bộ đếm
          const seqBrand = Object.keys(seqByBrand).find(b => b.toLowerCase() === errBrand);
          if (seqBrand !== undefined) commitOrderSequence(seqBrand, seqByBrand[seqBrand]);
          exportedPaths.push({ brand: errBrand, filePath: retryResult.filePath, created: false, opened: retryResult.opened });
          errors = errors.filter(e => !e.startsWith(errBrand.toUpperCase()));
        }
      }
    }
  }

    // Đơn đến từ danh sách chờ duyệt & xuất THÀNH CÔNG toàn bộ hãng → đánh dấu
    // bước Excel xong. Signature guard chặn việc bật cờ cho một bản đã bị sửa
    // trong lúc file đang được ghi.
    let pendingMarked = false;
    if (errors.length === 0 && exportedPaths.length > 0 && pendingIdAtStart) {
      try {
        const marked = await markDone(pendingIdAtStart, 'excel', expectedSignature);
        pendingMarked = marked?.marked !== false;
      } catch (e) {
        console.warn('[Export] markDone pending failed:', e);
      }
    }

    if (errors.length > 0) {
      // Dialog kết quả non-blocking. Luồng card chờ đóng dialog rồi mới mở lại
      // danh sách để không đè focus trap của danh sách lên dialog kết quả.
      const dialogClosed = showExportResultDialog(buildExportResults(brands, exportedPaths, errors));
      showToast(`Xuất Excel: ${successCount}/${brands.length} hãng thành công, ${errors.length} hãng lỗi.`, 'error');
      if (isPendingExport) await dialogClosed;
    } else if (exportedPaths.length === 1) {
      const p = exportedPaths[0];
      const openNote = p.opened === false ? '\n⚠️ Không tự mở được file — vui lòng mở thủ công.' : '';
      const reopenNote = p.wasOpenInExcel ? '\n📂 File đang mở đã được tự đóng & mở lại sau khi xuất.' : '';
      showToast(`Đã xuất Excel tại: ${p.filePath}${p.created ? ' (đã tạo file tháng mới)' : ''}${reopenNote}${openNote}`, 'success');
    } else {
      const lines = exportedPaths.map(p => `${p.brand.toUpperCase()}: ${p.filePath}${p.created ? ' (đã tạo file tháng mới)' : ''}${p.wasOpenInExcel ? ' — 📂 đã tự đóng/mở lại' : ''}${p.opened === false ? ' — ⚠️ không tự mở được' : ''}`);
      showToast(`Đã xuất Excel tại:\n` + lines.join('\n'), 'success');
    }

    return {
      status: errors.length > 0 ? 'partial' : 'success',
      successCount,
      errors,
      exportedPaths,
      pendingMarked
    };
  } finally {
    if (progressElement) {
      progressElement.disabled = false;
      progressElement.innerHTML = originalHtml;
    }
  }
}

/**
 * Ghép danh sách kết quả có cấu trúc từ exportedPaths (thành công) và errors
 * (chuỗi lỗi dạng "BRAND: message" — tách brand khỏi phần thông điệp),
 * sắp xếp theo thứ tự brand trong lần xuất để dialog hiển thị ổn định.
 *
 * @param {string[]} brands - Danh sách brand theo thứ tự đã xuất.
 * @param {Array<{brand: string, filePath: string, created?: boolean, opened?: boolean}>} exportedPaths
 * @param {string[]} errors - Danh sách chuỗi lỗi "BRAND: message".
 * @returns {Array<{brand: string, ok: boolean, filePath?: string, error?: string, opened?: boolean, created?: boolean}>}
 */
function buildExportResults(brands, exportedPaths, errors) {
  const okEntries = exportedPaths.map(p => ({
    brand: p.brand,
    ok: true,
    filePath: p.filePath,
    opened: p.opened,
    created: p.created
  }));
  const errEntries = errors.map(e => {
    const sep = e.indexOf(':');
    return {
      brand: sep > 0 ? e.slice(0, sep) : e,
      ok: false,
      error: sep > 0 ? e.slice(sep + 1).trim() : e
    };
  });
  // Thứ tự hiển thị khớp thứ tự brand xuất (so sánh không phân biệt hoa thường
  // vì brand trong bản ghi lỗi AI-retry đã bị lowercase)
  const brandOrder = (b) =>
    brands.findIndex(x => x.toLowerCase() === String(b).toLowerCase());
  return [...okEntries, ...errEntries]
    .sort((a, b) => brandOrder(a.brand) - brandOrder(b.brand));
}

// ==================== Dialog kết quả xuất Excel ====================
// LƯU Ý VỀ NÚT "MỞ THƯ MỤC": preload.js KHÔNG expose IPC channel mở file/
// thư mục nào (ALLOWED_INVOKE_CHANNELS không có shell.openPath / config:open-path),
// và quy ước dự án cấm tự thêm IPC channel mới vào main process → nút này bị
// BỎ, chỉ ghi chú qua console.info bên dưới.

/**
 * Hiện dialog tổng kết xuất Excel THEO TỪNG HÃNG (non-blocking), pattern động
 * giống confirm-dialog: overlay .modal-overlay + role="dialog" aria-modal="true",
 * focus trap tái sử dụng từ trapFocus(), đóng bằng nút/Esc/click nền.
 * Thay cho alert() cũ vốn làm đóng băng toàn bộ renderer Electron.
 *
 * @param {Array<{brand: string, ok: boolean, filePath?: string, error?: string, opened?: boolean, created?: boolean}>} results
 */
function showExportResultDialog(results) {
  let resolveClosed = null;
  const closedPromise = new Promise(resolve => { resolveClosed = resolve; });

  // Chỉ 1 dialog kết quả tại 1 thời điểm: remove leftover trước khi mở
  const existing = document.getElementById('exportResultDialogOverlay');
  if (existing) existing.remove();

  // Ghi chú việc bỏ nút "Mở thư mục" (không có IPC phù hợp — xem comment phía trên)
  console.info('[Export] preload.js chưa có IPC channel mở thư mục/file — nút "Mở thư mục" bị bỏ trong dialog kết quả.');

  const el = document.createElement('div');
  el.id = 'exportResultDialogOverlay';
  el.className = 'modal-overlay';

  const content = document.createElement('div');
  content.className = 'modal-content';
  content.style.maxWidth = '520px';
  content.onclick = (e) => e.stopPropagation(); // click trong khối nội dung không đóng

  // Header tiêu đề
  const header = document.createElement('div');
  header.className = 'card-header';
  header.style.marginBottom = 'var(--space-md)';
  const titleEl = document.createElement('div');
  titleEl.className = 'card-title';
  titleEl.id = 'exportResultDialogTitle';
  titleEl.textContent = 'Kết quả xuất Excel';
  header.appendChild(titleEl);

  // Danh sách từng hãng: ✓ xanh + tên file/path | ✗ đỏ + lý do lỗi
  const listEl = document.createElement('div');
  listEl.style.cssText = 'font-size:0.85rem; line-height:1.6; max-height:50vh; overflow-y:auto;';
  for (const r of (results || [])) {
    const item = document.createElement('div');
    item.style.marginBottom = '8px';
    if (r.ok) {
      // Chỉ lấy tên file để dòng chính gọn, path đầy đủ ở dòng phụ
      const fileName = String(r.filePath || '').split(/[\\/]/).pop();
      const notes = [
        r.created ? '(đã tạo file tháng mới)' : '',
        r.opened === false ? '⚠️ Không tự mở được file — mở thủ công.' : ''
      ].filter(Boolean).join(' ');
      item.innerHTML =
        `<span style="color:var(--green,#16a34a); font-weight:700;">✓ ${escapeHtml(String(r.brand).toUpperCase())}</span>` +
        `<div style="word-break:break-all; font-weight:600;">${escapeHtml(fileName)}</div>` +
        `<div style="color:var(--text-3); word-break:break-all; font-size:0.78rem;">${escapeHtml(r.filePath || '')}${notes ? ' ' + escapeHtml(notes) : ''}</div>`;
    } else {
      item.innerHTML =
        `<span style="color:var(--red,#dc2626); font-weight:700;">✗ ${escapeHtml(String(r.brand).toUpperCase())}</span>` +
        `<div style="color:var(--red,#dc2626);">${escapeHtml(r.error || 'Lỗi không xác định')}</div>`;
    }
    listEl.appendChild(item);
  }

  // Footer: duy nhất nút "Đóng" (nút "Mở thư mục" đã bỏ — thiếu IPC)
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex; gap:8px; justify-content:flex-end; margin-top:var(--space-md);';
  const btnClose = document.createElement('button');
  btnClose.type = 'button';
  btnClose.className = 'btn btn-primary btn-sm';
  btnClose.textContent = 'Đóng';
  btnRow.appendChild(btnClose);

  content.append(header, listEl, btnRow);
  el.appendChild(content);

  // ARIA: vai trò dialog + modal + nhãn trỏ tới tiêu đề
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'exportResultDialogTitle');

  let closed = false;

  /** Đóng dialog: gỡ focus trap + remove DOM (an toàn khi gọi nhiều lần). */
  const closeDialog = () => {
    if (closed) return;
    closed = true;
    trap.release();
    el.remove();
    if (resolveClosed) resolveClosed();
  };

  btnClose.onclick = closeDialog;
  // Bấm ra nền overlay = đóng (giống confirm-dialog)
  el.onclick = (e) => { if (e.target === el) closeDialog(); };

  // Phải append TRƯỚC khi trapFocus (focusable check cần element nằm trong DOM)
  document.body.appendChild(el);
  // Focus trap + Esc-to-close tái sử dụng helper dùng chung
  const trap = trapFocus(el, { onEscape: closeDialog });
  return closedPromise;
}

// ==================== AI-Assisted File Resolution ====================

/**
 * When rule-based file resolution fails, ask AI to analyze the directory
 * structure and suggest which file to use (or what to rename).
 * Returns { resolved, filePath, explanation } or null.
 */
async function aiDiagnoseExportError(brand, orderDate, errorMsg) {
  try {
    showToast('🤖 Đang dùng AI phân tích cấu trúc thư mục...', 'info');

    // 1. Gather directory context from main process
    const context = await window.electronAPI.diagnoseExcel({ brand, orderDate });
    if (context.error) {
      console.warn('[AI Diagnose] Context error:', context.error);
      return null;
    }

    // 2. Build a compact directory tree description for the AI prompt
    const treeDesc = buildTreeDescription(context.tree);

    // 3. Call AI with specialized file-resolution prompt (20s timeout to avoid hanging)
    const systemPrompt = 'Bạn là trợ lý AI chuyên phân tích cấu trúc thư mục và file Excel. Trả về DUY NHẤT một JSON object hợp lệ, không kèm giải thích hay markdown.';
    const prompt = buildFileResolutionPrompt(context, treeDesc, errorMsg);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let aiResult;
    try {
      aiResult = await aiService.callAICustom(prompt, systemPrompt, ctrl.signal);
    } finally {
      clearTimeout(timer);
    }

    // 4. Parse AI response
    if (!aiResult || !aiResult.action) {
      console.warn('[AI Diagnose] AI returned no actionable result:', aiResult);
      return null;
    }

    // 5. Apply the fix via IPC (include brand/year/month for caching)
    const parsed = orderDate.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
    const fixPayload = { ...aiResult, brand, year: parsed ? parseInt(parsed[3]) : null, month: parsed ? parseInt(parsed[2]) : null };
    const fixResult = await window.electronAPI.applyExcelFix(fixPayload);
    if (fixResult.error) {
      console.warn('[AI Diagnose] Apply fix failed:', fixResult.error);
      showToast(`⚠️ AI đề xuất nhưng không áp dụng được: ${fixResult.error}`, 'error');
      return null;
    }

    return {
      resolved: true,
      filePath: fixResult.filePath,
      explanation: aiResult.explanation || `Đã dùng file: ${fixResult.filePath}`
    };
  } catch (err) {
    console.warn('[AI Diagnose] Failed:', err.message);
    // Non-blocking: if AI is not configured or fails, just skip
    return null;
  }
}

/**
 * Build a human-readable tree description from the directory context.
 */
function buildTreeDescription(tree) {
  const lines = [];
  for (const node of tree) {
    if (node.type === 'file') {
      lines.push(`  [FILE] ${node.name}`);
      continue;
    }
    lines.push(`[DIR] ${node.name}/`);
    if (node.children) {
      for (const child of node.children) {
        if (child.type === 'file') {
          lines.push(`  [FILE] ${child.name}`);
        } else if (child.type === 'dir') {
          const fileList = (child.files || [])
            .filter(f => f.ext === '.xlsx' || f.ext === '.xls')
            .map(f => f.name)
            .join(', ');
          lines.push(`  [DIR] ${child.name}/ → ${fileList || '(trống)'}`);
        }
      }
    }
  }
  return lines.join('\n');
}

/**
 * Build the AI prompt for file resolution diagnosis.
 */
function buildFileResolutionPrompt(context, treeDesc, errorMsg) {
  return `Bạn là trợ lý AI giúp xác định file Excel đơn hàng đúng cho hãng "${context.brand}".

Ngày đơn hàng: ${context.orderDate} (tháng ${context.targetMonth}, năm ${context.targetYear})

Lỗi hệ thống gặp phải: "${errorMsg}"

Cấu trúc thư mục hiện tại của hãng ${context.brand}:
${treeDesc}

Nhiệm vụ: Dựa vào cấu trúc thư mục trên, hãy xác định file Excel nào phù hợp nhất để ghi đơn hàng tháng ${context.targetMonth}/${context.targetYear}.

Quy tắc:
- File phải có đuôi .xlsx hoặc .xls
- Bỏ qua file có chứa "backup", "copy", "template" trong tên
- Ưu tiên file có tên chứa tháng/năm khớp với tháng ${context.targetMonth} hoặc tháng gần nhất
- Nếu có folder tháng ${context.targetMonth} và có file hợp lệ bên trong → dùng file đó
- Nếu KHÔNG có folder/file tháng ${context.targetMonth} → tìm file tháng gần nhất trước đó để đề xuất đổi tên

Trả về DUY NHẤT một JSON object:
{
  "action": "use_file" hoặc "rename_file",
  "filePath": "đường dẫn đầy đủ đến file (bắt buộc)",
  "newName": "tên mới (chỉ khi action=rename_file)",
  "explanation": "giải thích ngắn gọn bằng tiếng Việt tại sao chọn file này"
}

Nếu action là "use_file": hệ thống sẽ ghi đơn vào file đó.
Nếu action là "rename_file": hệ thống sẽ đổi tên file trước rồi ghi đơn.
Chỉ dùng "rename_file" khi chắc chắn file đó là file tháng trước cần đổi tên sang tháng hiện tại.`;
}

/**
 * Retry the Excel export with a specific resolved file path.
 * Uses the same IPC channel but overrides the file resolution.
 */
async function retryExportWithFile(brand, filePath, originalPayload) {
  try {
    // Re-run export — the main process will use resolveTargetExcel again,
    // but since we already applied the fix (rename), it should now resolve correctly.
    const result = await window.electronAPI.exportOrder(originalPayload);
    return result;
  } catch (err) {
    console.warn('[AI Retry] Export retry failed:', err.message);
    return null;
  }
}

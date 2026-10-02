// =========================================================================
//  PARSE APPLY — ĐẨY KẾT QUẢ PARSE LÊN MÀN HÌNH
//  Nửa GUI của parseOrder (store + form input + preview + toast), tách riêng
//  để hàng đợi phân tích song song (parse-queue.js) tái dùng đúng một hành
//  vi khi đơn hoàn tất mà màn hình còn đang "chờ đúng đơn đó".
//  Ngược lại (màn hình đang bận việc khác) parse-queue tạo thẳng bản ghi
//  chờ duyệt qua pending.createPendingFromOrder — KHÔNG qua module này.
// =========================================================================

import { store } from '../../store.js';
import { uiRenderer, showToast } from '../../ui-renderer.js';
import { CustomerNotes } from '../customer-notes.js';

/**
 * Áp dụng đơn đã parse xong lên màn hình chính (giống hành vi parse thường):
 * setState (ngắt _pendingId cũ), điền form, cảnh báo khách giá riêng,
 * render AI detection + preview, và các toast tổng kết.
 * @param {object} order - Đơn trả về từ runParsePipeline / buildOrderFromText.
 * @param {object} meta - Phụ trợ từ pipeline: { repair: {issueCount, addedCount, why}|null,
 *                         learned: {count}|null }.
 */
export function applyParsedOrderToScreen(order, meta = {}) {
  // Parse đơn MỚI → ngắt liên kết bản ghi chờ duyệt cũ (merge spread của
  // store giữ id cũ nếu key vắng → lần lưu sau đè mất bản ghi đơn trước).
  store.setState({ currentOrder: { ...order, _pendingId: null } });

  const custEl = document.getElementById('customerName');
  const payEl = document.getElementById('paymentMethod');
  if (custEl) custEl.value = order.customer;
  if (payEl) payEl.value = order.payment;

  // Cảnh báo khách có đơn giá riêng
  CustomerNotes.checkAndWarn(order.customer);

  // Ghi chú mặc định trống — chỉ tính những gì user tự điền tay
  const noteEl = document.getElementById('orderNote');
  if (noteEl) noteEl.value = '';

  uiRenderer.renderAIDetection(order.aiResult);
  uiRenderer.renderParsedPreview(order.parsedLines);

  // ── Toast tự vá dòng sót (từ giai đoạn ExtractionRepair trong pipeline) ──
  const repair = meta.repair;
  if (repair && repair.issueCount > 0) {
    if (repair.addedCount > 0) {
      showToast(`🔧 Phát hiện ${repair.issueCount} dòng ${repair.why} — đã tự sửa, bổ sung ${repair.addedCount} dòng.`, 'info', { duration: 6000 });
    } else {
      showToast(`⚠️ Tin nhắn có ~${repair.issueCount} dòng sản phẩm AI trích xuất chưa đúng. Kiểm tra lại!`, 'warning', { duration: 8000 });
    }
  }

  // ── Toast học alias ──
  if (meta.learned && meta.learned.count > 0) {
    showToast(`🧠 Đã ghi nhớ ${meta.learned.count} cách gọi SP mới`, 'info');
  }

  // ── Match quality summary toast ──
  const totalItems = order.items.filter(i => !i.isGift).length;
  const highConf = order.items.filter(i => !i.isGift && (i.matchScore || 0) >= 85).length;
  const medConf = order.items.filter(i => !i.isGift && (i.matchScore || 0) >= 60 && (i.matchScore || 0) < 85).length;
  const lowConf = order.items.filter(i => !i.isGift && (i.matchScore || 0) < 60 && i.product).length;
  const unmatched = order.items.filter(i => !i.isGift && !i.product).length;

  let summaryMsg = `✅ ${totalItems} SP: ${highConf} khớp cao`;
  if (medConf > 0) summaryMsg += `, ${medConf} TB`;
  if (lowConf > 0) summaryMsg += `, ⚠️ ${lowConf} yếu`;
  if (unmatched > 0) summaryMsg += `, ❌ ${unmatched} chưa khớp`;

  const toastType = (lowConf > 0 || unmatched > 0) ? 'warning' : 'success';
  showToast(summaryMsg, toastType, { duration: 5000 });
}

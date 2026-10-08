// =========================================================================
//  PERSIST WATCH — Giám sát lỗi lưu dữ liệu và hiển thị banner cảnh báo
// =========================================================================
//  db.js (tầng domain) tự ghi nhận lỗi persist vào _lastPersistError khi
//  flushSave() thất bại. Module này CHỈ ĐỌC trạng thái qua
//  db.getLastPersistError() rồi phản chiếu lên banner #persistErrorBanner:
//    - Có lỗi   → hiện banner + nút "Thử lưu lại" (gọi lại db.flushSave())
//    - Hết lỗi  → tự ẩn banner (kể cả giữa 2 lần tick)
//  Không can thiệp beforeunload/pagehide — db.js đã có flush listener riêng.

import { showToast } from '../../ui-renderer.js';

/** Chu kỳ kiểm tra trạng thái persist (ms) — đủ nhẹ để chạy nền. */
const CHECK_INTERVAL_MS = 3000;

/**
 * Cắt gọn message lỗi cho vừa banner (tránh chiếm hết chiều rộng).
 * @param {string} message - Message lỗi gốc từ getLastPersistError().
 * @returns {string} Message đã cắt tối đa MAX_MSG_LEN ký tự.
 */
function shortenMessage(message) {
  const MAX_MSG_LEN = 160;
  const text = String(message || '').trim();
  return text.length > MAX_MSG_LEN ? `${text.slice(0, MAX_MSG_LEN)}…` : text;
}

/**
 * Bật cơ chế giám sát lỗi lưu dữ liệu cho toàn app.
 *
 * Flow: setInterval đọc db.getLastPersistError() → đồng bộ banner.
 * Nút "Thử lưu lại" gọi db.flushSave() trong try/catch; do việc ghi
 * IndexedDB là bất đồng bộ (_lastPersistError được cập nhật trong .then/.catch
 * của dbStore.set), hàm sẽ re-check sau một khoảng trễ ngắn thay vì kiểm tra
 * ngay lập tức. Interval cũng tự đồng bộ nếu lần check đầu chưa thấy kết quả.
 *
 * @param {object} db - Instance DB tầng domain, cần có getLastPersistError()
 *                      và flushSave() (đã import trong src/main.js).
 * @returns {{stop: Function}} Handle dừng giám sát (clearInterval), hữu ích
 *                              cho test hoặc teardown.
 * @example
 *   import { db } from '../db.js';
 *   const watch = initPersistWatch(db); // gọi 1 lần trong initApp
 */
export function initPersistWatch(db) {
  const banner = document.getElementById('persistErrorBanner');
  const msgEl = document.getElementById('persistErrorMessage');
  const retryBtn = document.getElementById('persistRetryBtn');
  const dismissBtn = document.getElementById('persistDismissBtn');

  // DOM thiếu (sai markup index.html) → chỉ log, không crash app
  if (!banner || !msgEl || !retryBtn || !dismissBtn) {
    console.warn('[persist-watch] Thiếu phần tử banner #persistErrorBanner — bỏ qua giám sát.');
    return { stop() {} };
  }

  /**
   * Đọc an toàn trạng thái lỗi persist (phòng khi db chưa sẵn sàng).
   * @returns {string|null} Chuỗi lỗi hoặc null nếu lành/không đọc được.
   */
  function safeGetLastError() {
    try {
      const err = db.getLastPersistError();
      return err ? String(err) : null;
    } catch (_) {
      return null;
    }
  }

  /** Hiện banner kèm message lỗi tiếng Việt ngắn gọn. */
  function showBanner(error) {
    msgEl.textContent = `⚠️ Lưu dữ liệu thất bại: ${shortenMessage(error)}. Dữ liệu mới nhất có thể chưa được ghi!`;
    banner.style.display = '';
  }

  /** Ẩn banner (chỉ ảnh hưởng hiển thị, không đổi trạng thái dữ liệu). */
  function hideBanner() {
    banner.style.display = 'none';
  }

  /**
   * Wrapper kiểm tra trung tâm — dùng bởi interval, lúc khởi tạo và sau retry.
   * Lỗi còn → hiện; lỗi sạch mà banner còn → tự ẩn.
   */
  function checkAndSync() {
    const error = safeGetLastError();
    if (error) {
      showBanner(error);
    } else if (banner.style.display !== 'none') {
      hideBanner();
    }
  }

  // "Thử lưu lại": flush ngay, chờ promise ghi IndexedDB settle rồi re-check.
  retryBtn.addEventListener('click', () => {
    try {
      retryBtn.disabled = true; // chặn bấm lặp trong lúc chờ kết quả ghi
      db.flushSave();
      // Ghi là async — _lastPersistError chỉ cập nhật sau khi promise settle,
      // nên re-check trễ ngắn thay vì kiểm tra ngay.
      setTimeout(() => {
        retryBtn.disabled = false;
        if (!safeGetLastError()) {
          hideBanner();
          try { showToast('✅ Đã lưu dữ liệu thành công!', 'success'); } catch (_) { /* UI chưa sẵn sàng */ }
        }
      }, 400);
    } catch (err) {
      // flushSave ném exception đồng bộ → báo user ngay, banner giữ nguyên
      retryBtn.disabled = false;
      console.error('[persist-watch] flushSave thủ công thất bại:', err);
      try { showToast(`⚠️ Vẫn chưa lưu được dữ liệu: ${shortenMessage(err && err.message || err)}`, 'error'); } catch (_) { /* UI chưa sẵn sàng */ }
    }
  });

  // "✕": chỉ ẩn tạm thời — nếu lỗi vẫn còn, lần check kế sẽ hiện lại banner.
  dismissBtn.addEventListener('click', hideBanner);

  // Check ngay 1 lần khi khởi tạo + định kỳ về sau.
  checkAndSync();
  const timerId = setInterval(checkAndSync, CHECK_INTERVAL_MS);

  return {
    /** Dừng giám sát (không tự động gọi — app sống suốt phiên). */
    stop() { clearInterval(timerId); },
  };
}

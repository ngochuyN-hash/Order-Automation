// =========================================================================
//  CONFIRM DIALOG DÙNG CHUNG (non-blocking)
//  Thay thế hộp thoại xác nhận native của trình duyệt — vốn làm đóng băng
//  toàn bộ renderer Electron (gây lag/đơ ứng dụng).
//  Generalize từ showConfirmDialog cũ trong src/order/actions.js.
// =========================================================================

// Element đang focus trước khi mở dialog — dùng để trả focus về khi đóng.
let _previousFocus = null;

/**
 * Hiện hộp thoại xác nhận non-blocking, trả về Promise<boolean>.
 * Chỉ 1 dialog tồn tại tại 1 thời điểm (mở mới thì remove cái cũ).
 *
 * @param {Object} opts - Tùy chọn dialog.
 * @param {string} opts.title - Tiêu đề dialog (dùng cho aria-labelledby).
 * @param {string} opts.message - Nội dung thông điệp (giữ nguyên xuống dòng).
 * @param {string} [opts.confirmText='OK'] - Nhãn nút xác nhận.
 * @param {string} [opts.cancelText='↩ Hủy'] - Nhãn nút hủy.
 * @param {boolean} [opts.danger=false] - Variant đỏ cho hành động xoá/reset.
 * @returns {Promise<boolean>} true nếu người dùng xác nhận, false nếu hủy
 *   (nút Hủy / Esc / bấm ra nền overlay).
 *
 * @example
 * if (await confirmDialog({ title: '⚠️ Xóa sản phẩm', message: 'Xóa sản phẩm "ABC"?', danger: true })) {
 *   // người dùng đã xác nhận
 * }
 */
export function confirmDialog({ title = '', message = '', confirmText = 'OK', cancelText = '↩ Hủy', danger = false } = {}) {
  return new Promise(resolve => {
    // Chỉ 1 dialog tại 1 thời điểm: remove leftover trước khi mở
    const existing = document.getElementById('confirmDialogOverlay');
    if (existing) existing.remove();

    // Nhớ element đang focus để trả lại sau khi đóng (focus management)
    _previousFocus = (document.activeElement instanceof HTMLElement) ? document.activeElement : null;

    const el = document.createElement('div');
    el.id = 'confirmDialogOverlay';
    el.className = 'modal-overlay';
    el.style.display = '';

    const content = document.createElement('div');
    content.className = 'modal-content';
    content.style.maxWidth = '480px';
    content.onclick = e => e.stopPropagation();

    const header = document.createElement('div');
    header.className = 'card-header';
    header.style.marginBottom = 'var(--space-md)';
    const titleEl = document.createElement('div');
    titleEl.className = 'card-title';
    titleEl.id = 'confirmDialogTitle';
    titleEl.textContent = title;
    header.appendChild(titleEl);

    const msgEl = document.createElement('pre');
    msgEl.style.cssText = 'white-space:pre-wrap; font-size:0.85rem; line-height:1.6; font-family:inherit; margin:0; color:var(--text-2);';
    msgEl.textContent = message;

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex; gap:8px; justify-content:flex-end; margin-top:var(--space-md);';

    const btnCancel = document.createElement('button');
    btnCancel.className = 'btn btn-ghost btn-sm';
    btnCancel.type = 'button';
    btnCancel.textContent = cancelText;

    const btnOk = document.createElement('button');
    // Variant danger → nút xác nhận màu đỏ (.btn-danger có sẵn trong style.css)
    btnOk.className = danger ? 'btn btn-danger btn-sm' : 'btn btn-primary btn-sm';
    btnOk.type = 'button';
    btnOk.textContent = confirmText;

    btnRow.appendChild(btnCancel);
    btnRow.appendChild(btnOk);

    content.append(header, msgEl, btnRow);
    el.appendChild(content);

    // ARIA: gắn vai trò dialog + modal + nhãn trỏ tới tiêu đề
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'confirmDialogTitle');

    let closed = false;

    // Danh sách phần tử focusable trong dialog (phục vụ focus trap)
    const getFocusable = () => [btnCancel, btnOk];

    /**
     * Đóng dialog: dọn listener, remove DOM, trả focus và resolve kết quả.
     * @param {boolean} result - true = xác nhận, false = hủy.
     */
    const cleanup = (result) => {
      if (closed) return; // chống resolve/đóng 2 lần
      closed = true;
      document.removeEventListener('keydown', onKeydown, true);
      el.remove();
      // Trả focus về element đã mở dialog (nếu vẫn còn trong DOM)
      if (_previousFocus && document.contains(_previousFocus)) {
        _previousFocus.focus();
      }
      resolve(result);
    };

    // Bàn phím: Esc = hủy; Tab/Shift+Tab luân chuyển trong dialog (focus trap)
    function onKeydown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cleanup(false);
        return;
      }
      if (e.key === 'Tab') {
        const items = getFocusable();
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    btnOk.onclick = () => cleanup(true);
    btnCancel.onclick = () => cleanup(false);
    // Bấm ra nền overlay = hủy (giữ nguyên hành vi cũ)
    el.onclick = (e) => { if (e.target === el) cleanup(false); };

    document.body.appendChild(el);
    // Bắt phím ở giai đoạn capture để chặn Esc/Tab kể cả khi focus rơi ngoài nút
    document.addEventListener('keydown', onKeydown, true);

    // Focus ban đầu: danger → ưu tiên nút an toàn (Hủy), ngược lại → nút xác nhận
    (danger ? btnCancel : btnOk).focus();
  });
}

// =========================================================================
//  FOCUS TRAP DÙNG CHUNG CHO MODAL (tái sử dụng)
//  Cung cấp trapFocus(container) trả về { release() } — gắn/gỡ vòng lặp
//  Tab trong modal + tùy chọn xử lý Esc, trả focus về nơi đã mở khi release.
// =========================================================================

/** Selector phần tử có thể focus bên trong modal (chuẩn WAI-ARIA). */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

/** Element được coi là hiển thị khi có kích thước render thực tế. */
function _isRendered(el) {
  return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

/**
 * Khóa focus (focus trap) bên trong một container modal — helper standalone
 * tối giản để tái sử dụng cho mọi modal (modalKiotViet, modalOverlay, ...).
 *
 * - Tab / Shift+Tab luân chuyển giữa các phần tử focusable trong container.
 * - Esc: nếu truyền opts.onEscape thì chặn Esc (không lan xuống nền) và gọi
 *   callback — caller tự quyết định có đóng modal hay không (vd: agent đang
 *   chạy thì KHÔNG đóng). Không truyền onEscape → Esc đi qua bình thường.
 * - release(): gỡ listener + trả focus về element focus trước khi trap.
 *
 * @param {HTMLElement} container - Phần tử modal cần khóa focus.
 * @param {{ onEscape?: () => void }} [opts] - Callback xử lý phím Esc.
 * @returns {{ release: () => void }} Object để gỡ trap khi đóng modal.
 *
 * @example
 * const trap = trapFocus(modalEl, { onEscape: () => closePanel() });
 * // khi đóng modal:
 * trap.release();
 */
export function trapFocus(container, opts = {}) {
  if (!(container instanceof HTMLElement)) return { release() {} };
  // Chống trap chồng trên cùng 1 container: trả lại trap đang chạy
  if (container.__oaFocusTrap) return container.__oaFocusTrap;

  const { onEscape = null } = opts;
  const previousFocus = (document.activeElement instanceof HTMLElement)
    ? document.activeElement
    : null;

  /** Danh sách phần tử focusable đang hiển thị trong container. */
  const getFocusables = () =>
    Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(_isRendered);

  /** Bắt phím ở giai đoạn capture để chặn Esc/Tab kể cả khi focus rơi ngoài nút. */
  function onKeydown(e) {
    if (e.key === 'Escape' && typeof onEscape === 'function') {
      // Chặn Esc lan xuống overlay bên dưới (tránh đóng dây chuyền)
      e.preventDefault();
      e.stopPropagation();
      onEscape();
      return;
    }
    if (e.key === 'Tab') {
      const items = getFocusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (!container.contains(document.activeElement)) {
        // Focus rơi ra ngoài modal (vd click nền) → kéo về phần tử đầu tiên
        e.preventDefault();
        first.focus();
      }
    }
  }

  const trap = {
    /**
     * Gỡ trap + trả focus về element đã focus trước khi mở (nếu còn trong DOM).
     * An toàn khi gọi nhiều lần (idempotent).
     */
    release() {
      document.removeEventListener('keydown', onKeydown, true);
      if (container.__oaFocusTrap === trap) delete container.__oaFocusTrap;
      if (previousFocus && document.contains(previousFocus)) previousFocus.focus();
    }
  };
  container.__oaFocusTrap = trap;

  document.addEventListener('keydown', onKeydown, true);

  // Focus ban đầu: đưa vào phần tử đầu tiên nếu focus chưa nằm trong modal
  if (!container.contains(document.activeElement)) {
    const first = getFocusables()[0];
    if (first) first.focus();
  }
  return trap;
}

/**
 * Gắn focus trap + Esc-to-close cho modal chung #modalOverlay theo kiểu
 * QUAN SÁT (observer): modal này được settings/ui.js và seller/manager.js
 * mở/đóng trực tiếp qua style.display — các file đó không được sửa nên ta
 * lắng nghe thay đổi thuộc tính style của overlay để gắn/gỡ trap đúng lúc.
 *
 * Esc-to-close chạy ở giai đoạn bubble để nhường các handler chặn (capture)
 * sẵn có: confirm-dialog (dialog con đè lên) và edit-tracker (Esc hoàn tác
 * khi input đang dirty — stopImmediatePropagation sẽ chặn handler này).
 *
 * @returns {() => void} Hàm dọn dẹp — ngừng quan sát (dùng khi teardown).
 */
export function initModalOverlayFocus() {
  const overlay = document.getElementById('modalOverlay');
  if (!overlay || overlay.__oaFocusWatched) return () => {};
  overlay.__oaFocusWatched = true;

  /** Trap đang chạy (null = modal đang đóng). */
  let releaseTrap = null;

  // display khác 'none' = mở → trapFocus; về 'none' = đóng → release + trả focus
  const observer = new MutationObserver(() => {
    const visible = overlay.style.display !== 'none';
    if (visible && !releaseTrap) {
      releaseTrap = trapFocus(overlay);
    } else if (!visible && releaseTrap) {
      releaseTrap.release();
      releaseTrap = null;
    }
  });
  observer.observe(overlay, { attributes: true, attributeFilter: ['style'] });

  // Esc = đóng modal chung. Hành vi trùng closeModal() của settings/ui.js
  // (chỉ ẩn overlay) — không import trực tiếp để tránh phụ thuộc vòng.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (overlay.style.display === 'none') return;
    // Có dialog xác nhận đè lên trên → nhường Esc cho dialog con tự xử lý
    if (document.getElementById('confirmDialogOverlay')) return;
    overlay.style.display = 'none'; // observer phía trên sẽ gỡ trap + trả focus
  });

  return () => {
    observer.disconnect();
    overlay.__oaFocusWatched = false;
  };
}

/**
 * ORDER AUTOMATION - EDIT TRACKER (edit-tracker.js)
 * ------------------------------------------------------------------
 * GIẢI PHÁP DỨT ĐIỂM cho hiện tượng "chỉnh sửa không thấy thông báo lưu /
 * không biết có lưu hay không".
 *
 * Các path LƯU THẦM LẶNG đã biết:
 *  1. Esc đóng modal chỉnh sửa sâu → input bị gỡ khỏi DOM trước khi `change`
 *     kịp fire → mất dữ liệu, không thông báo.
 *  2. Tắt app / reload khi đang gõ → `change` chưa fire → giá trị chưa bao
 *     giờ tới DB.
 *  3. Gõ xong bấm Enter → không có handler commit → user tưởng đã lưu.
 *  4. renderCatalog() vẽ lại DOM trong lúc input đang dirty.
 *
 * Cách xử lý:
 *  - Bắt sự kiện `input` (capture) để ghi nhận giá trị MỚI NHẤT của mọi ô
 *    nhập liệu thuộc tính sản phẩm/tier/FOC/MKT vào map "dirty".
 *  - Enter  → commit ngay (dispatch change) + toast.
 *  - Esc    → hoàn tác giá trị chưa lưu + thông báo (chặn đóng modal).
 *  - beforeunload / pagehide / visibilitychange(hidden) → commitAll + flushSave.
 *  - Trước mỗi renderCatalog() → commitAll (hook window.__oaCommitPendingEdits).
 *  - Chip trạng thái lưu (#oaSaveStatusChip) + toast để user LUÔN biết kết quả.
 */

import { db } from '../db.js';
import { workerManager } from './worker-manager.js';
import { applyProductFieldEdit } from './product-edit.js';
import { showToast, parseFormattedNumber } from '../ui-renderer.js';
import { createLogger } from './logger.js';

const log = createLogger('EditTracker');

const TRACKED_SELECTOR = [
  '.catalog-product-input[data-product-id]',
  '.product-field-input[data-product-id]',
  '.catalog-tier-input[data-tier-price-id]',
  '.catalog-foc-input[data-rule-id]',
  '.catalog-mkt-input[data-rule-id]',
].join(', ');

const FIELD_LABELS = {
  name: 'Tên sản phẩm', spec: 'Quy cách', unit: 'Đơn vị', packaging: 'Đóng gói',
  category: 'Nhóm hàng', box_size: 'Hộp/Thùng', kvCode: 'Mã KV', kvCodeThung: 'KV thùng',
};

/** Map<Element, {value, meta}> — các ô đang có thay đổi CHƯA commit. */
const _dirty = new Map();
let _initialized = false;
let _chipHideTimer = null;

function _isTracked(el) {
  return !!(el && el.matches && el.matches(TRACKED_SELECTOR) && el.tagName === 'INPUT');
}

function _isDirty(el) {
  return _dirty.has(el);
}

/** Chụp metadata cần thiết ngay khi input CÒN trong DOM (để commit cả khi bị gỡ). */
function _captureMeta(el) {
  const campEl = el.closest ? el.closest('[data-campaign-key]') : null;
  const campaignKey = campEl ? campEl.getAttribute('data-campaign-key') : null;
  if (el.classList.contains('catalog-tier-input')) {
    return { kind: 'tier', productId: el.getAttribute('data-product-id'), idx: parseInt(el.getAttribute('data-tier-idx'), 10), campaignKey };
  }
  if (el.classList.contains('catalog-foc-input')) {
    return { kind: 'foc', productId: el.getAttribute('data-product-id'), idx: parseInt(el.getAttribute('data-foc-idx'), 10), campaignKey };
  }
  if (el.classList.contains('catalog-mkt-input')) {
    return { kind: 'mkt', productId: el.getAttribute('data-product-id'), idx: parseInt(el.getAttribute('data-mkt-idx'), 10), campaignKey };
  }
  return { kind: 'product', productId: el.getAttribute('data-product-id'), field: el.getAttribute('data-field') };
}

// ─── Chip trạng thái lưu — để user LUÔN biết đã lưu hay chưa ───────────────

function _ensureChipStyle() {
  if (document.getElementById('oaSaveStatusChipStyle')) return;
  const style = document.createElement('style');
  style.id = 'oaSaveStatusChipStyle';
  style.textContent = `
    #oaSaveStatusChip {
      position: fixed; left: 16px; bottom: 16px; z-index: 10001;
      display: none; align-items: center; gap: 8px;
      padding: 8px 14px; border-radius: 8px;
      font-size: 0.82rem; font-weight: 600;
      background: var(--bg-overlay, #1e293b); color: #e2e8f0;
      border: 1px solid var(--border-strong, #334155);
      box-shadow: var(--shadow-lg, 0 8px 24px rgba(0,0,0,.35));
      opacity: 0; transform: translateY(8px);
      transition: opacity .2s ease, transform .2s ease;
      pointer-events: none; max-width: 420px;
    }
    #oaSaveStatusChip.show { display: flex; opacity: 1; transform: translateY(0); }
    #oaSaveStatusChip.ok { border-color: #22c55e; }
    #oaSaveStatusChip.err { border-color: #ef4444; }
  `;
  document.head.appendChild(style);
}

/**
 * Hiển thị chip trạng thái lưu. Đây là câu trả lời trực quan cho câu hỏi
 * "có lưu hay không?" — LUÔN hiện kể cả khi toast bị che/bị trễ.
 * @param {boolean} ok
 * @param {string} label
 * @param {string} [prefix] - ghi đè tiền tố (VD: '↩ Đã hoàn tác')
 */
export function showSaveStatus(ok, label, prefix) {
  try {
    _ensureChipStyle();
    let chip = document.getElementById('oaSaveStatusChip');
    if (!chip) {
      chip = document.createElement('div');
      chip.id = 'oaSaveStatusChip';
      chip.setAttribute('role', 'status');
      document.body.appendChild(chip);
    }
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    chip.className = `show ${ok ? 'ok' : 'err'}`;
    chip.textContent = `${prefix || (ok ? '✓ Đã lưu' : '✗ KHÔNG lưu được')}: ${label} · ${time}`;
    if (_chipHideTimer) clearTimeout(_chipHideTimer);
    _chipHideTimer = setTimeout(() => { chip.classList.remove('show'); }, ok ? 4000 : 8000);
  } catch (e) {
    log.warn('không hiển thị được chip trạng thái lưu', { error: String(e) });
  }
}

// ─── Commit trực tiếp (dùng khi input đã BỊ GỠ khỏi DOM) ───────────────────

function _persistAndSync() {
  db.save();
  workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
}

function _directCommit(entry) {
  const { meta, value } = entry;
  log.info('direct-commit (input đã bị gỡ khỏi DOM)', { meta, value });
  try {
    if (meta.kind === 'product') {
      const res = applyProductFieldEdit(meta.productId, meta.field, value);
      // applyProductFieldEdit đã phát event oa-product-edit-result → chip tự cập nhật.
      if (!res.ok) showToast(res.message || 'Không lưu được thay đổi!', 'error');
      return;
    }
    const prod = db.findProductRefById(meta.productId, meta.campaignKey);
    if (!prod) {
      log.error('direct-commit: không tìm thấy sản phẩm', { meta });
      showToast('Không lưu được thay đổi (không tìm thấy sản phẩm)!', 'error');
      showSaveStatus(false, meta.kind.toUpperCase());
      return;
    }
    if (meta.kind === 'tier') {
      if (prod.tiers && prod.tiers[meta.idx]) {
        prod.tiers[meta.idx].price = parseFormattedNumber(value) || 0;
        _persistAndSync();
        showToast('Đã cập nhật giá!', 'success');
        showSaveStatus(true, `Giá mốc ${meta.idx + 1}`);
      }
    } else if (meta.kind === 'foc') {
      // [Promo v1.3.0] Rule KM của SP nằm trong campaign.promoRules (type 'qty', kind 'foc')
      const rules = db.getPromoRulesForProduct(meta.productId).filter(r => r.type === 'qty' && r.kind === 'foc');
      const rule = rules[meta.idx];
      if (rule) {
        const val = parseInt(value, 10);
        if (!Number.isNaN(val) && val >= 0) {
          if (entry.focField === 'give_qty') {
            if (rule.gifts && rule.gifts[0]) rule.gifts[0].qty = val;
          } else {
            rule.buy = { qty: val, unit: (rule.buy && rule.buy.unit) || '' };
          }
          _persistAndSync();
          showToast('Đã cập nhật khuyến mãi FOC!', 'success');
          showSaveStatus(true, `FOC mốc ${meta.idx + 1}`);
        }
      }
    } else if (meta.kind === 'mkt') {
      // [Promo v1.3.0] Rule quà MKT theo SP nằm trong campaign.promoRules (kind 'mkt_pp', gifts[0].qty)
      const rules = db.getPromoRulesForProduct(meta.productId).filter(r => r.kind === 'mkt_pp');
      const rule = rules[meta.idx];
      if (rule && rule.gifts && rule.gifts[0]) {
        const val = parseInt(value, 10);
        if (!Number.isNaN(val) && val >= 0) {
          rule.gifts[0].qty = val;
          _persistAndSync();
          showToast('Đã cập nhật quà MKT!', 'success');
          showSaveStatus(true, `Quà MKT mốc ${meta.idx + 1}`);
        }
      }
    }
  } catch (e) {
    log.error('direct-commit THẤT BẠI', { meta, error: String(e && e.stack || e) });
    showToast('Không lưu được thay đổi!', 'error');
    showSaveStatus(false, 'thay đổi chưa lưu');
  }
}

/**
 * Commit MỌI chỉnh sửa đang pending.
 * - Input còn trong DOM → dispatch `change` để delegation handler chuẩn lưu.
 * - Input đã bị gỡ → commit trực tiếp bằng giá trị đã chụp lúc gõ.
 * @param {{flush?: boolean}} opts flush=true → db.flushSave() ghi ngay (dùng khi tắt app/ẩn tab).
 */
export function commitAll(opts = {}) {
  if (_dirty.size === 0) { if (opts.flush) db.flushSave(); return; }
  const entries = Array.from(_dirty.entries());
  log.info('commitAll — flush các chỉnh sửa pending', { count: entries.length, flush: !!opts.flush });
  for (const [el, entry] of entries) {
    if (el.isConnected) {
      // Đổi baseline để listener `change` (document) dọn dirty sau khi handler chạy.
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      _directCommit(entry);
      _dirty.delete(el);
    }
  }
  if (opts.flush) db.flushSave();
}

export function hasPendingEdits() {
  return _dirty.size > 0;
}

// ─── Listeners ──────────────────────────────────────────────────────────────

function _onInputCapture(e) {
  const el = e.target;
  if (!_isTracked(el)) return;
  // Baseline: giá trị đã commit gần nhất; nếu chưa có thì dùng defaultValue
  // (giá trị lúc render) để tránh đánh dấu dirty sai.
  const baseline = el.__oaCommitted !== undefined ? el.__oaCommitted : el.defaultValue;
  if (el.value !== baseline) {
    const meta = _captureMeta(el);
    const entry = { value: el.value, meta };
    // Với FOC cần biết field nào (buy_qty/give_qty/max_qty) — chụp từ attribute
    if (meta.kind === 'foc') entry.focField = el.getAttribute('data-foc-field') || 'buy_qty';
    _dirty.set(el, entry);
  } else {
    _dirty.delete(el);
  }
}

function _onChangeBubble(e) {
  const el = e.target;
  if (!_isTracked(el)) return;
  // Delegation handler đã chạy xong (bubble từ container lên document):
  // cập nhật baseline + đưa ô ra khỏi danh sách dirty.
  el.__oaCommitted = el.value;
  _dirty.delete(el);
}

function _onFocusInCapture(e) {
  const el = e.target;
  if (!_isTracked(el)) return;
  // Baseline = giá trị lúc bắt đầu chỉnh sửa (dùng cho Esc hoàn tác).
  if (el.__oaCommitted === undefined) el.__oaCommitted = el.value;
}

function _onKeydownCapture(e) {
  const el = e.target;
  if (!_isTracked(el)) return;

  if (e.key === 'Enter') {
    // Enter = lưu ngay: trước đây không có handler → user gõ xong tưởng đã lưu.
    e.preventDefault();
    if (_isDirty(el)) {
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      showToast('Không có thay đổi để lưu', 'info');
    }
    el.blur();
    return;
  }

  if (e.key === 'Escape') {
    if (_isDirty(el)) {
      // Esc khi đang có thay đổi chưa lưu → HOÀN TÁC + chặn đóng modal,
      // tránh mất dữ liệu thầm lặng khi modal bị gỡ.
      e.preventDefault();
      e.stopImmediatePropagation();
      el.value = el.__oaCommitted !== undefined ? el.__oaCommitted : '';
      el.__oaCommitted = el.value;
      _dirty.delete(el);
      showToast('Đã hoàn tác thay đổi chưa lưu', 'info');
      showSaveStatus(true, FIELD_LABELS[_captureMeta(el).field] || 'thay đổi chưa lưu', '↩ Đã hoàn tác');
      log.info('Esc hoàn tác chỉnh sửa chưa lưu', { meta: _captureMeta(el) });
    }
    // Esc khi không dirty → cho phép lan truyền (đóng modal như cũ).
  }
}

function _flushOnExit() {
  commitAll({ flush: true });
}

function _onVisibilityChange() {
  if (document.visibilityState === 'hidden') commitAll({ flush: true });
}

/**
 * Khởi tạo tracker. Gọi 1 lần sau khi DOM ready (src/main.js).
 */
export function initEditTracker() {
  if (_initialized || typeof document === 'undefined') return;
  _initialized = true;

  document.addEventListener('input', _onInputCapture, true);
  document.addEventListener('focusin', _onFocusInCapture, true);
  document.addEventListener('keydown', _onKeydownCapture, true);
  document.addEventListener('change', _onChangeBubble, false);

  window.addEventListener('beforeunload', _flushOnExit);
  window.addEventListener('pagehide', _flushOnExit);
  document.addEventListener('visibilitychange', _onVisibilityChange);

  // Hook cho ui-renderer.renderCatalog(): commit pending edits TRƯỚC khi vẽ lại
  // để không bao giờ re-render nuốt mất chỉnh sửa chưa commit.
  window.__oaCommitPendingEdits = () => commitAll({ flush: false });

  // Chip trạng thái cho MỌI chỉnh sửa thuộc tính sản phẩm (kể cả qua
  // delegation handler chuẩn) — lắng nghe kết quả từ applyProductFieldEdit.
  window.addEventListener('oa-product-edit-result', (e) => {
    const r = e.detail || {};
    const label = FIELD_LABELS[r.field] || r.field || 'sản phẩm';
    showSaveStatus(!!r.ok, label);
  });

  log.info('initEditTracker: đã gắn theo dõi chỉnh sửa', { trackedSelector: TRACKED_SELECTOR });
}

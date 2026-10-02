// =========================================================================
//  PARSE QUEUE — HÀNG ĐỢI PHÂN TÍCH SONG SONG
//  Bấm "Phân tích" xếp một task nền thay vì chờ tại chỗ: ô tin nhắn tự do
//  ngay để dán đơn kế tiếp, N đơn (mặc định 2, cấu hình 1–5 trong Cài đặt
//  → AI) được AI phân tích CÙNG LÚC qua runParsePipeline (cùng code path
//  với parse thường → chất lượng đồng nhất).
//
//  Hoàn tất một task:
//    - Đang MỞ một bản ghi chờ duyệt KHÁC (không phải nháp của chính đơn này)
//      → không giật màn hình, đơn đổ thẳng vào danh sách chờ duyệt qua
//      pending.createPendingFromOrder (dedup theo raw text nên bản nháp
//      "📝 Nháp" được NẠP ĐÈ thành đơn thật) + toast + badge.
//    - Đơn DUY NHẤT trong hàng đợi → LUÔN đẩy kết quả lên màn hình như parse
//      tuần tự cũ (kể cả ô tin nhắn đã bị sửa/trống trong lúc chờ — đơn lẻ
//      không bao giờ "rót" âm thầm vào danh sách).
//    - Có đơn khác đang chờ/chạy → chỉ lên màn hình khi ô tin nhắn còn nguyên
//      text của task này và không có task mới hơn xếp sau.
//    - LỖI HIỂN THỊ sau khi parse thành công (renderer/DOM nổ) → tuyệt đối
//      không vứt kết quả: tự đổ về chờ duyệt + toast cảnh báo.
//  Lỗi (AI/network) → task đứng lại ở trạng thái ❌ với nút Thử lại (giữ text
//  gốc), không tạo bản ghi rác. Hủy task → AbortError, bỏ khỏi danh sách.
//  Task là đối tượng TẠM (không persist): mất khi restart app thì text của
//  các đơn đã dán vẫn còn nguyên trong ô tin nhắn / bản nháp auto-save.
// =========================================================================

import { store } from '../../store.js';
import { db } from '../../db.js';
import { aiService } from '../../ai-service.js';
import { showToast, escapeHtml } from '../../ui-renderer.js';
import { runParsePipeline } from './parse-pipeline.js';
import { buildOrderFromText } from './builder.js';
import { autoSaveNow, createPendingFromOrder, refreshPendingListIfOpen } from './pending.js';
import { applyParsedOrderToScreen } from './parse-apply.js';

const CONCURRENCY_KEY = 'parse_queue_concurrency';
const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 5;
/** Task ✅ xong giữ trên dải trạng thái bao lâu rồi tự ẩn (ms). */
const DONE_LINGER_MS = 6000;

/**
 * Tasks đang hoạt động: queued / running / error (done/cancelled tự rời danh sách).
 * Duyệt theo thứ tự xếp hàng — không sort.
 */
const _tasks = [];

/** Hook test: thay runner pipeline bằng hàm giả (mặc định runParsePipeline). */
let _runPipelineFn = runParsePipeline;
export function _setPipelineRunner(fn) { _runPipelineFn = fn; }

// --- Cấu hình số đơn song song ---------------------------------------------

/** Số đơn phân tích AI chạy cùng lúc (1–5, mặc định 2) — localStorage. */
export function getParseConcurrency() {
  let n = NaN;
  try {
    n = parseInt(localStorage.getItem(CONCURRENCY_KEY), 10);
  } catch (e) { /* không có localStorage (node test) */ }
  if (!Number.isFinite(n)) n = DEFAULT_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY, Math.max(1, n));
}

/** Đặt số đơn song song (1–5). Tăng khi đang chạy → pump nốt hàng đợi. */
export function setParseConcurrency(n) {
  const v = Math.min(MAX_CONCURRENCY, Math.max(1, parseInt(n, 10) || DEFAULT_CONCURRENCY));
  try {
    localStorage.setItem(CONCURRENCY_KEY, String(v));
  } catch (e) { /* bỏ qua */ }
  _pump();
  return v;
}

// --- Nhiệm vụ ---------------------------------------------------------------

function taskId() {
  return `pq_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Nhãn hiển thị của task: dòng đầu tiên có nội dung của tin nhắn (≤48 ký tự). */
function taskLabel(text) {
  const line = (text || '').split('\n').map(s => s.trim()).find(Boolean) || '(trống)';
  return line.length > 48 ? line.slice(0, 48) + '…' : line;
}

/** Mô tả trạng thái hiện tại của task (dùng cho strip + modal chờ duyệt). */
function statusLabelOf(t) {
  if (t.status === 'done') return '✅ Đã xong — lưu vào Đơn chờ duyệt';
  if (t.status === 'queued') return '⏳ Đang chờ trong hàng đợi...';
  if (t.status === 'error') return `❌ Phân tích thất bại: ${t.error || 'lỗi không rõ'}`;
  // running — theo giai đoạn pipeline
  if (t.stage === 'repair') return '🔧 AI đang tự vá dòng sót...';
  if (t.stage === 'verify') return `🔍 AI đang xác nhận ${t.verifyCount || '?'} SP mơ hồ...`;
  return '🧠 AI đang phân tích...';
}

/** Snapshot phẳng cho UI (modal chờ duyệt) — không lộ AbortController.
 *  Task ✅ done KHÔNG liệt kê (đơn đã là bản ghi trong danh sách chờ duyệt). */
export function getActiveParseTasks() {
  return _tasks.filter(t => t.status !== 'done').map(t => ({
    id: t.id,
    status: t.status,
    stage: t.stage,
    verifyCount: t.verifyCount,
    label: t.label,
    error: t.error,
    statusLabel: statusLabelOf(t)
  }));
}

/** Đang có task chờ/chạy (thay cho isParsing của luồng cũ). */
export function isParseQueueBusy() {
  return _tasks.some(t => t.status === 'queued' || t.status === 'running');
}

/**
 * Xếp một tin nhắn vào hàng đợi phân tích.
 * @returns {string} id task khi nhận.
 * @returns {'duplicate'} tin nhắn này đang chờ/chạy rồi.
 * @returns {null} text rỗng.
 */
export function enqueueParse(text) {
  const t = (text || '').trim();
  if (!t) return null;
  const duplicate = _tasks.some(k => k.text === t && (k.status === 'queued' || k.status === 'running'));
  if (duplicate) return 'duplicate';

  const task = {
    id: taskId(),
    text: t,
    label: taskLabel(t),
    status: 'queued',   // queued → running → done | error | cancelled
    stage: null,        // extract | repair | verify (khi running)
    verifyCount: 0,
    customer: null,
    itemCount: 0,
    error: null,
    enqueuedAt: Date.now(),
    _abort: (typeof AbortController === 'function') ? new AbortController() : null
  };
  _tasks.push(task);
  _notify();
  _pump();

  // Phản hồi ngay khi xếp hàng — nút Phân tích không đổi trạng thái nên user
  // phải biết đơn đã vào hàng đợi, đang chạy/chờ bao nhiêu.
  const running = _tasks.filter(k => k.status === 'running').length;
  const queued = _tasks.filter(k => k.status === 'queued').length;
  showToast(`📋 Đã xếp hàng phân tích (${running} đang chạy${queued > 1 ? ` · ${queued - 1} chờ` : ''}) — đơn xong sẽ vào "Đơn chờ duyệt".`, 'info', { duration: 3000 });
  return task.id;
}

/** Thử lại một task lỗi: xếp lại cùng text, bỏ task cũ. */
export function retryParse(id) {
  const t = _tasks.find(k => k.id === id);
  if (!t || t.status !== 'error') return;
  const text = t.text;
  dismissParseTask(id);
  enqueueParse(text);
}

/** Bỏ một task lỗi khỏi danh sách (không tạo bản ghi — text đã có nháp auto-save). */
export function dismissParseTask(id) {
  _removeTask(id);
  _notify();
}

/** Hủy task đang chờ/chạy (AbortSignal vào pipeline); task lỗi/✅ xong thì bỏ khỏi dải. */
export function cancelParseTask(id) {
  const t = _tasks.find(k => k.id === id);
  if (!t) return;
  if (t.status === 'error' || t.status === 'done') { dismissParseTask(id); return; }
  if (t.status === 'queued' || t.status === 'running') {
    if (t._abort) t._abort.abort();
    else { t.status = 'cancelled'; _removeTask(t.id); _notify(); }
  }
}

/** Hủy toàn bộ: các task chờ/chạy bị abort, các task lỗi bị bỏ. */
export function cancelAllParseTasks() {
  for (const t of [..._tasks]) {
    if (t.status === 'queued' || t.status === 'running') {
      if (t._abort) t._abort.abort();
      else { t.status = 'cancelled'; }
    }
  }
  [..._tasks].forEach(t => { if (t.status === 'error') _removeTask(t.id); });
  _notify();
}

function _removeTask(id) {
  const idx = _tasks.findIndex(k => k.id === id);
  if (idx !== -1) _tasks.splice(idx, 1);
}

/** Hẹn gỡ task đã xong khỏi danh sách sau delayMs (user có thể ✕ bỏ sớm hơn). */
function _removeTaskSoon(task, delayMs) {
  const t = setTimeout(() => {
    const idx = _tasks.findIndex(k => k.id === task.id);
    if (idx !== -1 && _tasks[idx] === task && task.status === 'done') {
      _tasks.splice(idx, 1);
      _notify();
    }
  }, delayMs);
  if (typeof t.unref === 'function') t.unref();
}

// --- Pool thực thi -----------------------------------------------------------

function _runningCount() {
  return _tasks.filter(t => t.status === 'running').length;
}

/** Lấp đầy pool: starts queued tasks tới hạn mức song song. */
function _pump() {
  const limit = getParseConcurrency();
  for (const t of _tasks) {
    if (_runningCount() >= limit) break;
    if (t.status === 'queued') _run(t);
  }
}

/**
 * Màn hình có đang "chờ đúng đơn này" không → hoàn tất lên màn hình như
 * parse tuần tự cũ, ngược lại đổ vào danh sách chờ duyệt.
 *
 * LƯU Ý: trong app thật, paste text ~2s là có bản nháp auto-save GẮN
 * _pendingId vào currentOrder — nên không được chặn vì _pendingId khi bản
 * ghi liên kết chính là nháp CỦA ĐÚNG text này (user vẫn đang chờ đơn đó).
 */
function shouldRenderOnScreen(task) {
  // Đang mở/xem một bản ghi chờ duyệt KHÁC (không phải nháp của chính đơn
  // này) → không giật màn hình, đơn đổ vào danh sách chờ duyệt.
  const cur = store.getState().currentOrder;
  if (cur && cur._pendingId && (cur.rawChatText || '').trim() !== task.text) return false;

  const textEl = document.getElementById('orderText');
  const textMatch = !!textEl && (textEl.value || '').trim() === task.text;
  const otherActive = _tasks.some(t => t.id !== task.id && t.status !== 'done');

  if (!otherActive) {
    // Đơn DUY NHẤT trong hàng đợi → LUÔN tự hiện kết quả lên màn hình khi
    // xong, kể cả user đã sửa/trống ô tin nhắn trong lúc chờ — đơn lẻ không
    // bao giờ "rót" âm thầm vào danh sách chờ duyệt (yêu cầu UX 22/9).
    return true;
  }
  // Có đơn khác đang chờ/chạy → chỉ hiện khi màn hình còn chờ đúng đơn này
  // (ô tin nhắn còn nguyên text, không có task mới hơn xếp sau).
  if (!textMatch) return false;
  return !_tasks.some(t => t.status !== 'done' && t.enqueuedAt > task.enqueuedAt);
}

async function _run(task) {
  task.status = 'running';
  task.startedAt = Date.now();
  _notify();

  try {
    let order = null;
    let meta = {};

    // Chọn chế độ TẠI THỜI ĐIỂM CHẠY (profile có thể bật/tắt giữa chừng):
    // không profile AI nào → parser offline regex, như luồng cũ.
    let hasAI = false;
    try {
      const { profiles } = await aiService.getProfiles();
      hasAI = Array.isArray(profiles) && profiles.some(p => p.enabled);
    } catch (e) {
      console.warn('[ParseQueue] getProfiles failed, fallback offline:', e);
    }

    if (!hasAI) {
      order = buildOrderFromText(task.text);
    } else {
      const result = await _runPipelineFn(task.text, { db, aiService }, {
        signal: task._abort ? task._abort.signal : undefined,
        learnAliases: true,
        onProgress: (p) => {
          if (!p) return;
          task.stage = p.stage;
          if (p.stage === 'verify') task.verifyCount = p.count || 0;
          _notify();
        }
      });
      order = result.order;
      meta = result.meta || {};
    }

    task.customer = order.customer || '';
    task.itemCount = Array.isArray(order.items) ? order.items.length : 0;

    if (shouldRenderOnScreen(task)) {
      // Đơn đang soạn trên màn hình (nếu khác) flush debounce 2s trước khi
      // thay thế — giống loadPending, không mất chỉnh sửa trong cửa sổ chờ.
      try {
        await autoSaveNow();
        applyParsedOrderToScreen(order, meta);
        // Đơn vừa parse phải nằm trong Đơn chờ duyệt NGAY — không chờ debounce
        // 2s của auto-save (dedup rawChatText tự nạp đè bản nháp nếu có).
        await autoSaveNow();
      } catch (renderErr) {
        // Parse THÀNH CÔNG nhưng vướng lỗi hiển thị (DOM/renderer) → tuyệt đối
        // KHÔNG vứt kết quả: đổ về danh sách chờ duyệt, task vẫn tính là xong.
        console.error('[ParseQueue] render lên màn hình lỗi — đổ về chờ duyệt:', renderErr);
        await createPendingFromOrder(order, {
          customerName: order.customer || '',
          payment: order.payment || 'ck',
          note: '',
          sellerKey: '',
          orderText: task.text
        });
        showToast(`✅ Đơn "${order.customer || '(không tên)'}" đã phân tích xong — xem ở Đơn chờ duyệt. (Màn hình hiển thị lỗi: ${renderErr.message})`, 'warning');
      }
    } else {
      await createPendingFromOrder(order, {
        customerName: order.customer || '',
        payment: order.payment || 'ck',
        note: '',
        sellerKey: '',
        orderText: task.text
      });
      showToast(`✅ Đơn "${order.customer || '(không tên)'}" đã phân tích xong — xem ở Đơn chờ duyệt.`, 'success');
    }
    task.status = 'done';
  } catch (err) {
    if (err && err.name === 'AbortError') {
      task.status = 'cancelled';
      console.log(`[ParseQueue] Task ${task.label} bị hủy.`);
    } else {
      task.status = 'error';
      task.error = (err && err.message) || String(err);
      showToast(`❌ Phân tích thất bại: ${task.error}`, 'error');
      console.error('[ParseQueue] parse task failed:', err);
    }
  } finally {
    if (task.status === 'done') {
      // Giữ task ✅ trên dải trạng thái 6s để user thấy kết quả, rồi tự ẩn
      _removeTaskSoon(task, DONE_LINGER_MS);
    } else if (task.status === 'cancelled') {
      _removeTask(task.id);
    }
    _notify();
    _pump(); // chạy nốt các task còn chờ trong hàng đợi
  }
}

// --- Dải trạng thái dưới hàng nút Phân tích ---------------------------------

/** Vẽ lại dải trạng thái hàng đợi (ẩn khi trống). Gọi lại nhiều lần an toàn. */
function renderStrip() {
  const el = (typeof document !== 'undefined') ? document.getElementById('parseQueueStrip') : null;
  if (!el) return;

  if (!_tasks.length) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  el.classList.remove('hidden');

  const running = _tasks.filter(t => t.status === 'running').length;
  const queued = _tasks.filter(t => t.status === 'queued').length;
  const errors = _tasks.filter(t => t.status === 'error').length;

  const rows = _tasks.map(t => {
    const icon = t.status === 'error'
      ? '❌'
      : (t.status === 'done' ? '✅' : (t.status === 'queued' ? '⏳' : '<span class="pq-spin">⚙️</span>'));
    let btns = '';
    if (t.status === 'error') {
      btns = `<button type="button" class="pq-btn" data-pq-action="retry" data-pq-id="${t.id}" title="Phân tích lại tin nhắn này">Thử lại</button>` +
             `<button type="button" class="pq-btn pq-btn-x" data-pq-action="dismiss" data-pq-id="${t.id}" title="Bỏ qua">✕</button>`;
    } else if (t.status === 'done') {
      btns = `<button type="button" class="pq-btn pq-btn-x" data-pq-action="dismiss" data-pq-id="${t.id}" title="Ẩn dòng này">✕</button>`;
    } else {
      btns = `<button type="button" class="pq-btn pq-btn-x" data-pq-action="cancel" data-pq-id="${t.id}" title="Hủy phân tích đơn này">✕</button>`;
    }
    const cls = t.status === 'done' ? 'pq-done' : t.status;
    return `<div class="pq-row pq-${cls}">` +
      `<span class="pq-icon">${icon}</span>` +
      `<span class="pq-label" title="${escapeHtml(t.text)}">${escapeHtml(t.label)}</span>` +
      `<span class="pq-status">${escapeHtml(statusLabelOf(t))}</span>` +
      btns +
      `</div>`;
  }).join('');

  el.innerHTML =
    `<div class="pq-header">` +
    `<span class="pq-title">Hàng đợi phân tích · ${running} đang chạy${queued ? ` · ${queued} chờ` : ''}${errors ? ` · ${errors} lỗi` : ''}</span>` +
    `<button type="button" class="pq-btn pq-btn-x" data-pq-action="cancel-all" title="Hủy tất cả đơn đang chờ/phân tích">Hủy tất cả</button>` +
    `</div>` + rows;

  // Delegation gắn 1 lần
  if (el._pqBound !== true) {
    el._pqBound = true;
    el.addEventListener('click', (e) => {
      const target = e && e.target;
      if (!target || typeof target.closest !== 'function') return;
      const btn = target.closest('[data-pq-action]');
      if (!btn) return;
      const id = btn.getAttribute('data-pq-id');
      const action = btn.getAttribute('data-pq-action');
      if (action === 'cancel') cancelParseTask(id);
      else if (action === 'retry') retryParse(id);
      else if (action === 'dismiss') dismissParseTask(id);
      else if (action === 'cancel-all') cancelAllParseTasks();
    });
  }
}

/** Cập nhật UI hàng đợi: strip + mục Đang phân tích trong modal chờ duyệt. */
function _notify() {
  renderStrip();
  refreshPendingListIfOpen();
}

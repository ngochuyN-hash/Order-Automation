// =========================================================================
//  PENDING ORDERS — ĐƠN CHỜ DUYỆT (TỰ ĐỘNG LƯU)
//  Mọi đơn đang soạn (≥1 sản phẩm, hoặc text chưa parse) được TỰ ĐỘNG lưu
//  vào danh sách "chờ sale duyệt" — debounce sau mỗi thay đổi state/input,
//  không cần bấm nút. Đơn chỉ có text chưa parse (paste mới, chưa bấm "Phân
//  tích") hiện thành bản nháp "📝 Nháp" — mở lại bấm Phân tích là thành đơn
//  thật. Nút "Lưu chờ duyệt" thủ công vẫn giữ (lưu ngay + toast để chắc ăn).
//
//  Đơn KHÔNG tự rời danh sách khi xuất Excel hoặc lên KiotViet thành công:
//    - Xuất Excel thành công toàn bộ hãng  → markDone(id, 'excel')
//    - Lên đơn KiotViet hoàn tất           → markDone(id, 'kv')
//    - Hai cờ chỉ là tiến độ; đơn vẫn CÒN ở Chờ duyệt.
//  Chỉ nút "Hoàn tất" hoặc "Xóa" mới được rút đơn khỏi danh sách. Khi bấm
//  "Hoàn tất", record được chuyển sang LỊCH SỬ "Đã xử lý" (giữ 3 ngày, tối
//  đa 30 bản ghi) — tra cứu được, không mất tiêu; nút "Mở lại" đưa đơn quay
//  về chờ duyệt (reset Excel/KV) để sửa và xử lý lại khi cần.
//
//  Lưu trữ: envelope order_automation_pending_state_v2 trong dbStore (IndexedDB,
//  tự fallback localStorage) — pending + processed g atomic, KHÔNG thêm IPC.
//  Bản ghi: { id, savedAt, order, form, summary, excelDone, kvDone, _sig }
//    - order: bản sao currentOrder (items, quà, promo, TLN, raw text...)
//    - form : giá trị input tại thời điểm lưu (tên KH, thanh toán, ghi chú,
//             seller, orderText) vì export đọc trực tiếp từ input, không phải
//             state. Khi MỞ ĐỂ SỬA một bản ghi, đơn đang soạn được flush
//             (autoSaveNow) trước khi thay thế — không mất chỉnh sửa trong
//             cửa sổ debounce 2s.
//    - summary: số liệu hiển thị nhanh trong danh sách (SP/thùng/tổng tiền).
//    - excelDone/kvDone: trạng thái từng bước xử lý.
//    - _sig: signature nội dung — dirty-check (không đổi thì bỏ qua ghi) +
//             dedup khi re-parse cùng đơn bị mất _pendingId.
//  Liên kết đơn đang mở ↔ bản ghi qua currentOrder._pendingId:
//    - Parse đơn MỚI phải reset _pendingId = null (builder/actions) — merge
//      spread của store sẽ giữ id cũ nếu key vắng → lần lưu sau ĐÈ MẤT bản
//      ghi của đơn trước (bug mất đơn thật đã xảy ra).
//    - markDone dùng id CAPTURE TỪ ĐẦU flow (không đọc lại currentOrder lúc
//      hoàn tất — automation KV chạy nền vài phút, user có thể mở đơn khác).
//  Chống "hồi sinh": sau khi bấm Hoàn tất/Xóa, auto-save chỉ bị chặn khi
//  nội dung màn hình vẫn giữ nguyên signature; nội dung đổi thì lưu bản mới.
//  Race khởi động: mọi thao tác đọc/ghi phải await ensureLoaded() — chờ
//  dbStore.ready() xong mới load, tránh persist đè mất danh sách đã lưu.
// =========================================================================

import { dbStore } from '../../db-store.js';
import { store } from '../../store.js';
import { uiRenderer, showToast, escapeHtml, formatCurrency } from '../../ui-renderer.js';
import { confirmDialog, trapFocus } from '../ui/confirm-dialog.js';
import { autoGrowOrderText } from './actions.js';
import { getSellers, findSellerByKey } from '../seller/manager.js';
import { CustomerNotes } from '../customer-notes.js';
import { getActiveParseTasks, cancelParseTask, retryParse, dismissParseTask } from './parse-queue.js';

const STATE_KEY = 'order_automation_pending_state_v2';
const LEGACY_PENDING_KEY = 'order_automation_pending_orders_v1';
const LEGACY_PROCESSED_KEY = 'order_automation_processed_orders_v1';
const MAX_PROCESSED = 30;
const PROCESSED_RETAIN_DAYS = 3;

/** Debounce auto-save sau mỗi thay đổi (state / input form). */
const AUTO_SAVE_DEBOUNCE_MS = 2000;
/** Danh sách bản ghi đơn chờ duyệt (newest-first khi render). */
let _orders = [];

/** Lịch sử các đơn đã bấm Hoàn tất (không phải mọi đơn đủ cả hai bước). */
let _processed = [];

/** Tab đang mở trong modal danh sách: 'pending' | 'processed'. */
let _activeTab = 'pending';

/** Trap focus của modal danh sách đang mở (null = đóng). */
let _listTrap = null;

/** Các signature vừa bị Hoàn tất/Xóa — chặn lưu lại khi nội dung không đổi. */
const _removedRecords = new Map();

/** Lỗi đọc danh sách pending — chặn ghi để không đè mất dữ liệu khi storage lỗi. */
let _pendingLoadError = null;

/** Callback direct action được src/main.js inject để tránh circular import. */
let _exportPending = null;
let _openPendingKiotViet = null;

/** Khóa tạm theo record + nguồn; không persist trạng thái running. */
const _runningDirectActions = new Set();

/** Timer debounce auto-save (single-timer). */
let _autoSaveTimer = null;

/** Serialize mọi envelope write để transition không bị ghi chồn. */
let _persistQueue = Promise.resolve();

/**
 * Promise nạp dữ liệu lần đầu — CHẶN RACE KHỞI ĐỘNG:
 * dbStore.init() chạy NỀN (db.init không block page load). Nếu mutation
 * (Lưu/Xóa/markDone) xảy ra trước khi IndexedDB mở xong, load() rơi vào
 * fallback localStorage RỖNG → persist() đầu tiên sẽ ĐÈ MẤT toàn bộ danh
 * sách đã lưu trong IndexedDB. Mọi entry point đọc/ghi PHẢI await hàm này.
 */
let _loadPromise = null;
function ensureLoaded() {
  if (!_loadPromise) {
    _loadPromise = dbStore.ready()
      .catch(e => console.warn('PendingOrders: dbStore.ready failed:', e))
      .then(() => load());
  }
  return _loadPromise;
}

// --- Persistence ---------------------------------------------------------

async function load() {
  let state = null;
  try {
    state = await dbStore.get(STATE_KEY);
  } catch (e) {
    _pendingLoadError = e;
    console.error('PendingOrders: state load failed; writes are blocked.', e);
    _orders = [];
    _processed = [];
    showToast('Không thể đọc danh sách đơn chờ duyệt — tạm chặn ghi để không làm mất dữ liệu.', 'error');
    return;
  }

  const hasState = state && state.version === 2 && Array.isArray(state.orders);
  if (state !== null && state !== undefined && !hasState) {
    const error = new Error('Invalid or unsupported pending state envelope');
    _pendingLoadError = error;
    _orders = [];
    _processed = [];
    console.error('PendingOrders: invalid state envelope; writes are blocked.', error);
    showToast('Dữ liệu đơn chờ duyệt có định dạng lạ — tạm chặn ghi để không ghi đè.', 'error');
    return;
  }
  if (hasState) {
    _orders = state.orders.filter(r => r && r.id && r.order);
    _processed = Array.isArray(state.processed) ? state.processed.filter(r => r && r.id) : [];
  } else {
    // Migrate dữ liệu trước mô hình hai key. Nếu bất kỳ key legacy nào lỗi thì
    // chặn ghi để không thay bằng envelope thiếu dữ liệu.
    try {
      const [pendingData, processedData] = await Promise.all([
        dbStore.get(LEGACY_PENDING_KEY),
        dbStore.get(LEGACY_PROCESSED_KEY)
      ]);
      _orders = Array.isArray(pendingData) ? pendingData.filter(r => r && r.id && r.order) : [];
      _processed = Array.isArray(processedData) ? processedData.filter(r => r && r.id) : [];
      await persistState('Không thể chuyển dữ liệu đơn chờ duyệt sang lưu an toàn!');
      // Retire legacy keys sau khi envelope đã ghi thành công. Nếu envelope v2
      // sau này biến mất, load tuyệt đối không hồi sinh dữ liệu legacy đã cũ.
      try {
        await Promise.all([
          dbStore.remove(LEGACY_PENDING_KEY),
          dbStore.remove(LEGACY_PROCESSED_KEY)
        ]);
      } catch (cleanupError) {
        console.warn('PendingOrders: legacy key cleanup failed after migration.', cleanupError);
      }
    } catch (e) {
      _pendingLoadError = e;
      console.error('PendingOrders: legacy migration failed; writes are blocked.', e);
      _orders = [];
      _processed = [];
      showToast('Không thể đọc dữ liệu đơn chờ duyệt cũ — tạm chặn ghi để bảo toàn.', 'error');
      return;
    }
  }

  // Signature cũ chỉ chứa một phần state. Tính lại toàn bộ order + form sau khi
  // load để nút Xóa/Hoàn tất không bỏ sót bản ghi đã tồn tại từ bản cũ.
  _orders = _orders.map(r => ({ ...r, _sig: orderSignature(r.order, r.form || {}) }));
  _processed = _processed.map(r => r.order
    ? { ...r, _sig: orderSignature(r.order, r.form || {}) }
    : r);
}

/** Ghi pending + processed trong MỘT value để transition không bể nửa vời. */
function persistState(failureMessage = 'Không thể lưu dữ liệu đơn chờ duyệt!') {
  const task = _persistQueue.then(
    () => persistStateNow(failureMessage),
    () => persistStateNow(failureMessage)
  );
  _persistQueue = task.catch(() => {});
  return task;
}

/** Ghi một snapshot cục bể duy nhất; caller rollback memory nếu task thất bại. */
async function persistStateNow(failureMessage) {
  const previousOrders = _orders.slice();
  const previousProcessed = _processed.slice();
  const cutoff = Date.now() - PROCESSED_RETAIN_DAYS * 86400000;
  _processed = _processed.filter(r => {
    const t = new Date(r.processedAt || r.savedAt || 0).getTime();
    return isNaN(t) || t >= cutoff;
  }).slice(0, MAX_PROCESSED);
  try {
    await dbStore.set(STATE_KEY, {
      version: 2,
      savedAt: new Date().toISOString(),
      orders: _orders.slice(),
      processed: _processed.slice()
    });
  } catch (e) {
    _orders = previousOrders;
    _processed = previousProcessed;
    console.error('PendingOrders: save state failed.', e);
    showToast(failureMessage, 'error');
    throw e;
  }
}

async function persist() {
  if (_pendingLoadError) {
    showToast('Danh sách đơn chờ duyệt chưa nạp được — thao tác lưu đã bị chặn an toàn.', 'error');
    throw _pendingLoadError;
  }
  await persistState('Không thể lưu danh sách đơn chờ duyệt!');
}

/** Persist chung để xóa lịch sử cũng dùng cùng atomic value. */
async function persistProcessed() {
  await persistState('Không thể lưu lịch sử đơn đã xử lý!');
}

// --- Helpers -------------------------------------------------------------

/** Clone an toàn dữ liệu đơn (loại proxy/function) trước khi lưu/đặt lại state. */
function cloneOrder(order) {
  return JSON.parse(JSON.stringify(order));
}

/**
 * Canonicalize object để signature không phụ thuộc thứ tự key. Bỏ _pendingId
 * vì đây là liên kết runtime, không phải nội dung người dùng.
 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (key !== '_pendingId') out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * Signature đầy đủ của order + form — dùng dirty-check, chống hồi sinh và
 * dedup. Bao gồm mọi state được persist (raw text, customPromos, rowOrder,
 * gift overrides/qty, AI/parsed data...) để chỉ sửa một trường cũng được lưu.
 */
function orderSignature(order, form) {
  const effectiveOrder = {
    ...order,
    ...(form.customerName ? { customer: form.customerName } : {}),
    payment: form.payment || order.payment
  };
  return JSON.stringify(canonicalize({ order: effectiveOrder, form }));
}

/** Tên hiển thị của bản ghi (dùng cho toast + danh sách). */
function recName(rec) {
  return (rec.form && rec.form.customerName) || (rec.order && rec.order.customer) || rec.customer || '(không tên)';
}

/** Gỡ liên kết _pendingId nếu đơn đang mở trên màn hình đúng là record này. */
function unlinkIfCurrent(id) {
  const cur = store.getState().currentOrder;
  if (cur && cur._pendingId === id) {
    store.setState({ currentOrder: { ...cur, _pendingId: null } });
  }
}

/** Modal danh sách đang mở → vẽ lại (sau markDone/xóa từ automation). */
function rerenderIfOpen() {
  if (document.getElementById('pendingListOverlay')) renderListModal();
}

/** Parse-queue đổi trạng thái task → vẽ lại modal nếu đang mở (mục Đang phân tích). */
export function refreshPendingListIfOpen() {
  rerenderIfOpen();
}

/** Đánh dấu record vừa rời danh sách — chặn lưu lại khi nội dung không đổi. */
function markRemoved(rec, reason) {
  if (!rec || !rec.order) return;
  // Luôn tính lại bằng thuật toán hiện tại, không tin _sig có thể thuộc bản cũ.
  const sig = orderSignature(rec.order, rec.form || {});
  rec._sig = sig;
  _removedRecords.delete(sig);
  _removedRecords.set(sig, reason);

  // Chống hồi sinh cả cho chính snapshot đang mở. Signature record và
  // snapshot trình duyệt có thể lệch nhẹ vì dữ liệu runtime/legacy; giữ cả hai
  // giúp Hoàn tất/Xóa chặn đúng đơn đó, nhưng chỉ khi nội dung vẫn không đổi.
  const current = store.getState().currentOrder;
  if (current && current._pendingId === rec.id) {
    const currentSig = orderSignature(current, snapshotForm());
    _removedRecords.set(currentSig, reason);
  }
}

/** Trả lý do đã rút đơn nếu signature vẫn trùng nội dung đang mở. */
function removedReason(sig) {
  return _removedRecords.get(sig) || null;
}

/** Thông báo khi người dùng bấm Lưu lại đơn vừa Hoàn tất/Xóa. */
function notifyRemovedSave(sig) {
  const reason = removedReason(sig);
  if (!reason) return false;
  showToast(reason === 'complete'
    ? 'Đơn này đã Hoàn tất. Hãy chỉnh nội dung nếu muốn lưu thành đơn mới.'
    : 'Đơn này đã bị Xóa. Hãy chỉnh nội dung nếu muốn lưu thành đơn mới.', 'warning');
  return true;
}

/** Chuyển record sang lịch sử Đã xử lý — giữ nguyên dữ liệu đơn (order +
 *  _sig) để nút "Mở lại" trong lịch sử nạp lại được đầy đủ. */
function moveToProcessed(rec, sources) {
  const processedRec = {
    id: rec.id,
    customer: recName(rec),
    savedAt: rec.savedAt,
    processedAt: new Date().toISOString(),
    sources,
    form: rec.form,
    summary: rec.summary,
    order: rec.order || null,
    _sig: rec._sig || null
  };
  _processed.unshift(processedRec);
  return processedRec;
}

function buildSummary(order) {
  let total = 0;
  let boxes = 0;
  try {
    const s = uiRenderer.getOrderTableRows(order);
    total = s.grandTotal || 0;
    boxes = s.totalBoxes || 0;
  } catch (e) {
    // Fallback tối giản nếu renderer chưa sẵn sàng
    (order.items || []).forEach(it => {
      if (!it.isGift) total += (Number(it.qty) || 0) * (Number(it.unitPrice) || 0);
      if ((it.unit || '') === 'thùng') boxes += Number(it.qty) || 0;
    });
  }
  const itemCount = (order.items || []).filter(i => !i.isGift).length;
  return { itemCount, boxes: Math.round(boxes * 10) / 10, total };
}

function snapshotForm() {
  const custEl = document.getElementById('customerName');
  const payEl = document.getElementById('paymentMethod');
  const noteEl = document.getElementById('orderNote');
  const sellerEl = document.getElementById('sellerName');
  const textEl = document.getElementById('orderText');
  return {
    customerName: custEl ? custEl.value.trim() : '',
    payment: payEl ? payEl.value : 'ck',
    note: noteEl ? noteEl.value : '',
    sellerKey: sellerEl ? sellerEl.value : '',
    orderText: textEl ? textEl.value : ''
  };
}

function formatSavedAt(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm} ${hh}:${mi}`;
}

/** Cập nhật badge số lượng trên nút danh sách. */
function refreshBadge() {
  const el = document.getElementById('pendingCount');
  if (!el) return;
  el.textContent = String(_orders.length);
  el.classList.toggle('hidden', _orders.length === 0);
}

// --- Auto-save engine ----------------------------------------------------

/** Hẹn auto-save (single-timer debounce — nhiều event trong 1 cửa sổ chỉ ghi 1 lần). */
function scheduleAutoSave() {
  if (_autoSaveTimer) return;
  _autoSaveTimer = setTimeout(() => {
    _autoSaveTimer = null;
    autoSaveNow();
  }, AUTO_SAVE_DEBOUNCE_MS);
  // Node test: timer không giữ process sống
  if (typeof _autoSaveTimer.unref === 'function') _autoSaveTimer.unref();
}

/** Lưu ngay lập tức (âm thầm) — flush debounce + ghi. Trả về id record hoặc null. */
export function autoSaveNow() {
  if (_autoSaveTimer) { clearTimeout(_autoSaveTimer); _autoSaveTimer = null; }
  return saveOrderSnapshot({ silent: true }).catch(e => {
    console.error('PendingOrders: autoSave failed.', e);
    return null;
  });
}

/**
 * Đăng ký các trigger auto-save (1 lần, từ initPendingOrders):
 *  (a) store.subscribe — parse, sửa item/quà/giá, rescan... ( subscriber duy
 *      nhất còn lại là render ở main.js — không tạo vòng lặp; saveOrderSnapshot
 *      chỉ setState khi cần gắn id MỚI và dirty-check chặn ghi lặp ).
 *  (b) input/change trên các ô form — snapshotForm đọc trực tiếp từ DOM nên
 *      thay đổi tên KH/thanh toán/ghi chú/seller cũng phải lưu lại.
 *  (c) beforeunload / pagehide / tab ẩn → flush ngay (best-effort).
 */
function registerAutoSaveTriggers() {
  if (registerAutoSaveTriggers._done) return;
  registerAutoSaveTriggers._done = true;

  store.subscribe(() => {
    const cur = store.getState().currentOrder;
    if (cur && Array.isArray(cur.items) && cur.items.length > 0) scheduleAutoSave();
  });

  ['customerName', 'paymentMethod', 'orderNote', 'sellerName', 'sellerSearch', 'orderText'].forEach(id => {
    const el = document.getElementById(id);
    if (!el || typeof el.addEventListener !== 'function') return;
    el.addEventListener('input', scheduleAutoSave);
    el.addEventListener('change', scheduleAutoSave);
  });

  try {
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('beforeunload', autoSaveNow);
      window.addEventListener('pagehide', autoSaveNow);
    }
    if (typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') autoSaveNow();
      });
    }
  } catch (e) { /* môi trường không có DOM event — bỏ qua */ }
}

// --- CRUD ----------------------------------------------------------------

/**
 * Lưu đơn hiện tại (currentOrder + input form) vào danh sách chờ duyệt.
 * - silent=false (nút bấm tay): bắt buộc có tên KH, toast xác nhận + verify.
 * - silent=true  (auto-save):   không toast, cho phép thiếu tên KH — bản nháp
 *   hiển thị "(không tên)" trong danh sách, an toàn tuyệt đối không mất đơn.
 * Nếu đơn hiện tại đã liên kết bản ghi (_pendingId) → cập nhật bản ghi đó.
 */
export async function saveOrderSnapshot({ silent = false } = {}) {
  // Chờ nạp xong danh sách đã lưu — bấm Lưu quá nhanh sau mở app mà không
  // chờ sẽ persist trên nền mảng rỗng, ĐÈ MẤT các đơn đã lưu trước đó.
  await ensureLoaded();
  const order = store.getState().currentOrder;
  if (!order) return null;
  const hasProducts = Array.isArray(order.items) && order.items.length > 0;
  const form = snapshotForm();
  if (!hasProducts) {
    if (!silent) {
      showToast('Chưa có sản phẩm nào trong đơn để lưu!', 'warning');
      return null;
    }
    // Nháp text chưa parse (0 SP — paste đơn mới chưa bấm "Phân tích") vẫn được
    // auto-save: mở lại bấm Phân tích là thành đơn thật. Nháp trống thì bỏ qua.
    if (!(order.rawChatText || form.orderText)) return null;
  }
  if (!silent && !form.customerName && !order.customer) {
    showToast('Vui lòng nhập tên khách hàng trước khi lưu!', 'warning');
    return null;
  }

  const sig = orderSignature(order, form);

  // Ưu tiên tên/thanh toán user điền tay (export cũng đọc từ input)
  const snap = cloneOrder({ ...order });
  if (form.customerName) snap.customer = form.customerName;
  snap.payment = form.payment;

  let id = order._pendingId || null;
  let idx = id ? _orders.findIndex(r => r.id === id) : -1;
  if (idx === -1 && snap.rawChatText) {
    // Dedup: re-parse CÙNG một đơn (raw text khớp) nhưng mất _pendingId
    // → cập nhật bản ghi cũ thay vì nhân bản mới.
    const dupIdx = _orders.findIndex(r => r.order && r.order.rawChatText === snap.rawChatText);
    if (dupIdx !== -1) { id = _orders[dupIdx].id; idx = dupIdx; }
  }

  const now = new Date().toISOString();
  const existing = idx !== -1 ? _orders[idx] : null;

  // Đơn vừa Hoàn tất/Xóa chỉ được tạo lại khi nội dung thật sự đổi. Áp dụng
  // cho cả auto-save lẫn nút Lưu chờ duyệt thủ công; record đã Mở lại từ
  // lịch sử vẫn update bình thường vì đã có existing.
  if (!existing && removedReason(sig)) {
    if (!silent) notifyRemovedSave(sig);
    return null;
  }

  // Snapshot memory để ghi lỗi có thể rollback; nếu không, lần save sau sẽ
  // thấy _sig trùng và bỏ qua persist, khiến đơn chỉ tồn tại trong RAM.
  const previousOrders = _orders.slice();
  const previousRecord = existing ? cloneOrder(existing) : null;
  const previousPendingId = order._pendingId || null;

  // Gắn id vào đơn đang mở → lần lưu sau cập nhật thay vì tạo mới.
  // Chỉ setState khi id khác id hiện tại — tránh vòng subscriber↔auto-save.
  const attachPendingId = (idToAttach) => {
    const cur = store.getState().currentOrder;
    if (cur && cur._pendingId !== idToAttach) {
      store.setState({ currentOrder: { ...cur, _pendingId: idToAttach } });
    }
  };

  if (existing && existing._sig === sig) {
    // Nội dung không đổi → bỏ qua ghi, nhưng gắn lại id nếu state bị mất
    // (re-parse cùng đơn qua dedup) để lần lưu sau vẫn update đúng bản ghi.
    attachPendingId(existing.id);
    return existing.id;
  }

  if (existing) {
    existing.savedAt = now;
    existing.order = snap;
    existing.form = form;
    existing.summary = buildSummary(snap);
    existing._sig = sig;
    // Nội dung đã đổi sau khi xuất/lên KV thì kết quả cũ không còn áp dụng.
    existing.excelDone = false;
    existing.kvDone = false;
    existing.savedBy = silent ? 'auto' : 'manual';
  } else {
    id = `po_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    _orders.push({
      id,
      savedAt: now,
      order: snap,
      form,
      summary: buildSummary(snap),
      excelDone: false,
      kvDone: false,
      _sig: sig,
      savedBy: silent ? 'auto' : 'manual'
    });
  }
  attachPendingId(id);

  try {
    await persist();
  } catch (e) {
    _orders = previousOrders;
    if (existing && previousRecord) {
      const rollbackIdx = _orders.findIndex(r => r.id === existing.id);
      if (rollbackIdx !== -1) _orders[rollbackIdx] = previousRecord;
    }
    if (!existing) {
      const cur = store.getState().currentOrder;
      if (cur && cur._pendingId === id) {
        store.setState({ currentOrder: { ...cur, _pendingId: previousPendingId } });
      }
    }
    return null; // persist() đã hiện toast lỗi — dừng, không báo "đã lưu" sai
  }

  let verified = true;
  if (!silent) {
    // Đọc lại từ storage để xác nhận đã ghi thật — phát hiện sớm khi
    // IndexedDB bị block/quota đầy (ghi "thành công" giả mà reload lại mất).
    try {
      const verify = await dbStore.get(STATE_KEY);
      const ok = verify && verify.version === 2 && Array.isArray(verify.orders)
        && verify.orders.some(r => r && r.id === id);
      if (!ok) throw new Error('verify-after-save: record not found');
    } catch (e) {
      verified = false;
      console.error('PendingOrders: verify after save failed.', e);
      showToast('Cảnh báo: lưu chưa chắc chắn (bộ nhớ trình duyệt bị chặn?). Hãy mở lại danh sách kiểm tra.', 'warning');
    }
  }
  if (!silent && verified) {
    showToast(existing
      ? 'Đã cập nhật đơn chờ duyệt.'
      : 'Đã lưu đơn vào danh sách CHỜ DUYỆT. Đơn tự lưu khi bạn chỉnh sửa và chỉ rời danh sách khi bạn bấm Hoàn tất hoặc Xóa.',
      'success');
  }
  refreshBadge();
  return id;
}

/** Nút "Lưu chờ duyệt" bấm tay — lưu NGAY + toast xác nhận. */
export function saveCurrentOrder() {
  return saveOrderSnapshot({ silent: false });
}

/**
 * Tạo/cập nhật bản ghi chờ duyệt TỪ ĐƠN CÓ SẴN (không đọc DOM, không đụng
 * store) — dùng bởi hàng đợi phân tích song song: đơn parse nền xong khi
 * màn hình đang bận việc khác → đổ thẳng vào danh sách chờ duyệt.
 *
 * Giữ nguyên ngữ nghĩa dữ liệu với saveOrderSnapshot: cùng shape bản ghi,
 * cùng orderSignature, dedup theo rawChatText (nạp đè bản nháp "📝 Nháp"
 * đã auto-save khi user dán text là trường hợp phổ biến nhất). Khác biệt
 * duy nhất: KHÔNG gắn _pendingId vào currentOrder (đơn không nằm trên màn
 * hình nên không có liên kết cần giữ, cũng không kích hoạt auto-save).
 * Cho phép bản nháp 0 SP (chỉ có raw text) — như auto-save.
 *
 * @param {object} order - Đơn hoàn chỉnh (từ parse pipeline / offline parser).
 * @param {object} formData - { customerName, payment, note, sellerKey, orderText }.
 * @returns {Promise<string|null>} id bản ghi, hoặc null khi không lưu được.
 */
export async function createPendingFromOrder(order, formData = {}) {
  await ensureLoaded();
  if (!order) return null;
  const form = {
    customerName: (formData.customerName || '').trim(),
    payment: formData.payment || 'ck',
    note: formData.note || '',
    sellerKey: formData.sellerKey || '',
    orderText: formData.orderText || ''
  };
  const hasProducts = Array.isArray(order.items) && order.items.length > 0;
  // Nháp 0 SP vẫn nhận (text chưa parse thành đơn) — nháp trống thì bỏ qua.
  if (!hasProducts && !(order.rawChatText || form.orderText)) return null;

  const sig = orderSignature(order, form);
  const snap = cloneOrder({ ...order });
  if (form.customerName) snap.customer = form.customerName;
  snap.payment = form.payment;

  // Dedup theo raw text — đơn parse nền cho CÙNG tin nhắn cập nhật bản ghi cũ.
  let id = null;
  let idx = -1;
  if (snap.rawChatText) {
    const dupIdx = _orders.findIndex(r => r.order && r.order.rawChatText === snap.rawChatText);
    if (dupIdx !== -1) { id = _orders[dupIdx].id; idx = dupIdx; }
  }

  const now = new Date().toISOString();
  const existing = idx !== -1 ? _orders[idx] : null;
  // Parse nền lại đúng nội dung vừa bị Hoàn tất/Xóa không được tạo bản ghi mới.
  if (!existing && removedReason(sig)) return null;
  if (existing && existing._sig === sig) {
    return existing.id; // Nội dung không đổi → bỏ qua ghi
  }

  const previousOrders = _orders.slice();
  const previousRecord = existing ? cloneOrder(existing) : null;
  if (existing) {
    existing.savedAt = now;
    existing.order = snap;
    existing.form = form;
    existing.summary = buildSummary(snap);
    existing._sig = sig;
    existing.excelDone = false;
    existing.kvDone = false;
    existing.savedBy = 'queue';
  } else {
    id = `po_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    _orders.push({
      id,
      savedAt: now,
      order: snap,
      form,
      summary: buildSummary(snap),
      excelDone: false,
      kvDone: false,
      _sig: sig,
      savedBy: 'queue'
    });
  }

  try {
    await persist();
  } catch (e) {
    _orders = previousOrders;
    if (existing && previousRecord) {
      const rollbackIdx = _orders.findIndex(r => r.id === existing.id);
      if (rollbackIdx !== -1) _orders[rollbackIdx] = previousRecord;
    }
    return null; // persist() đã hiện toast lỗi
  }
  refreshBadge();
  rerenderIfOpen();
  return id;
}

/**
 * Guard chung khi sắp nạp một bản ghi lên màn hình: đơn đang soạn CÓ dữ liệu
 * và KHÁC bản ghi này → hỏi xác nhận trước khi thay thế.
 * Trả về true/false = màn hình có đơn đang soạn cần flush (autoSaveNow) trước
 * khi thay thế; null = user đã hủy.
 */
async function guardReplaceScreen(id, { title, message, confirmText }) {
  const cur = store.getState().currentOrder;
  const form = snapshotForm();
  const hasWork = !!(cur && (
    (Array.isArray(cur.items) && cur.items.length > 0) ||
    cur.rawChatText || form.orderText
  ));
  if (hasWork && cur._pendingId !== id) {
    const ok = await confirmDialog({ title, message, confirmText, danger: true });
    if (!ok) return null;
  }
  return hasWork;
}

/** Nạp một bản ghi (order + form) lên màn hình chính để chỉnh sửa — dùng
 *  chung cho loadPending (chờ duyệt) và reopenProcessed (lịch sử Đã xử lý). */
function restoreRecordOnScreen(rec) {
  const restored = cloneOrder(rec.order);
  restored._pendingId = rec.id;
  const form = rec.form || {};

  store.setState({ currentOrder: restored });

  // Điền lại form input — export đọc trực tiếp từ các ô này
  const setVal = (elId, v) => { const el = document.getElementById(elId); if (el) el.value = v; };
  setVal('customerName', form.customerName || restored.customer || '');
  setVal('paymentMethod', form.payment || restored.payment || 'ck');
  setVal('orderNote', form.note || '');
  setVal('sellerName', form.sellerKey || '');
  const sellers = getSellers();
  const sel = findSellerByKey(sellers, form.sellerKey || '');
  setVal('sellerSearch', sel ? sel.name : '');
  setVal('orderText', form.orderText || restored.rawChatText || '');
  autoGrowOrderText();

  // Khôi phục hiển thị phụ trợ như sau khi parse
  if (restored.aiResult) uiRenderer.renderAIDetection(restored.aiResult);
  if (Array.isArray(restored.parsedLines) && restored.parsedLines.length) {
    uiRenderer.renderParsedPreview(restored.parsedLines);
  }
  CustomerNotes.checkAndWarn(restored.customer);
}

/**
 * Mở một bản ghi chờ duyệt: nạp vào form + bảng đơn để chỉnh sửa.
 * Bản ghi vẫn giữ trong danh sách cho tới khi xử lý xong hoặc xóa tay
 * (tránh mất đơn nếu user lỡ Xóa form).
 * @param {string} id
 */
export async function loadPending(id) {
  await ensureLoaded();
  const rec = _orders.find(r => r.id === id);
  if (!rec) return;

  // Đơn đang soạn có dữ liệu khác bản ghi này → hỏi trước khi thay thế
  const hasWork = await guardReplaceScreen(id, {
    title: '↩ Mở đơn chờ duyệt',
    message: 'Đơn đang soạn trên màn hình sẽ bị THAY THẾ bởi đơn chờ duyệt này.\nTiếp tục?',
    confirmText: 'Mở đơn chờ'
  });
  if (hasWork === null) return;

  // Lưu đơn đang soạn trước khi thay thế — chỉnh sửa trong cửa sổ debounce 2s
  // chưa kịp auto-save sẽ bị mất nếu không flush tại đây (silent + dirty-check:
  // đơn khác → bản ghi riêng, đơn trùng rawChatText → dedup cập nhật).
  if (hasWork) {
    const flushedId = await autoSaveNow();
    if (!flushedId) return null; // flush lỗi → không thay editor
  }

  restoreRecordOnScreen(rec);
  closeListModal();
  refreshBadge();
  showToast(`Đã mở đơn chờ duyệt: ${recName(rec)}. Chỉnh sửa rồi Xuất Excel / Lên đơn KiotViet.`, 'info');
}

/** Xóa một bản ghi khỏi danh sách chờ duyệt (có xác nhận). */
export async function deletePending(id) {
  await ensureLoaded();
  const rec = _orders.find(r => r.id === id);
  if (!rec) return;
  const name = recName(rec);
  const ok = await confirmDialog({
    title: '⚠️ Xóa đơn chờ duyệt',
    message: `Xóa đơn "${name}" khỏi danh sách chờ duyệt?\nThao tác này không thể hoàn tác.`,
    confirmText: 'Xóa',
    danger: true
  });
  if (!ok) return;
  const previousOrders = _orders.slice();
  const wasCurrent = !!(store.getState().currentOrder && store.getState().currentOrder._pendingId === id);
  _orders = _orders.filter(r => r.id !== id);
  // Chặn tombstone + gỡ link TRƯỚC khi await: auto-save chạy song song không
  // kịp tạo lại record giữa lúc xóa và lúc ghi xong.
  markRemoved(rec, 'delete');
  if (wasCurrent) unlinkIfCurrent(id);
  try {
    await persist();
  } catch (e) {
    _orders = previousOrders;
    if (wasCurrent) {
      const cur = store.getState().currentOrder;
      if (cur) store.setState({ currentOrder: { ...cur, _pendingId: id } });
    }
    return;
  }
  renderListModal(); // re-render list nếu modal đang mở
  refreshBadge();
  showToast(`Đã xóa đơn chờ duyệt: ${name}`, 'success');
}

/** Xóa một bản ghi trong lịch sử Đã xử lý — KHÔNG cần xác nhận: đây chỉ là
 *  lịch sử (đơn thật nằm nguyên trong Excel/KiotViet), khác với xóa đơn chờ
 *  duyệt (mất đơn thật, phải confirm). Bản ghi cần mở lại thì dùng reopen. */
export async function deleteProcessed(id) {
  await ensureLoaded();
  const idx = _processed.findIndex(r => r.id === id);
  if (idx === -1) return;
  const previousProcessed = _processed.slice();
  _processed.splice(idx, 1);
  try {
    await persistProcessed();
  } catch (e) {
    _processed = previousProcessed;
    return;
  }
  renderListModal();
  showToast('Đã xóa bản ghi khỏi lịch sử Đã xử lý.', 'success');
}

/**
 * "Mở lại" một đơn trong lịch sử Đã xử lý: đưa bản ghi về danh sách chờ duyệt
 * (reset cả 2 bước Excel/KiotViet) và nạp lên màn hình để sửa rồi xử lý lại —
 * dùng khi đơn đã hoàn tất mà phát hiện sai sót. Bản ghi giữ nguyên id nên
 * khi hoàn tất lại sẽ trở về lịch sử thay vì nhân bản bản ghi mới.
 * @param {string} id
 */
export async function reopenProcessed(id) {
  await ensureLoaded();
  const idx = _processed.findIndex(r => r.id === id);
  if (idx === -1) return;
  const rec = _processed[idx];
  if (!rec.order) {
    // Bản ghi tạo trước khi lịch sử giữ dữ liệu đơn — chỉ còn tóm tắt
    showToast('Bản ghi này không còn dữ liệu đơn đầy đủ — không thể mở lại.', 'warning');
    return;
  }
  const name = rec.customer || recName(rec);

  // Đơn đang soạn có dữ liệu khác → hỏi trước khi thay thế (như loadPending)
  const hasWork = await guardReplaceScreen(id, {
    title: '↩ Mở lại đơn đã xử lý',
    message: `Đơn "${name}" sẽ quay về danh sách CHỜ DUYỆT (reset trạng thái Excel/KiotViet) và thay thế đơn đang soạn trên màn hình.\nTiếp tục?`,
    confirmText: 'Mở lại để sửa'
  });
  if (hasWork === null) return;

  // Đưa bản ghi về chờ duyệt TRƯỚC khi flush màn hình: auto-save của đơn đang
  // soạn (nếu trùng rawChatText) sẽ dedup vào bản ghi vừa mở lại thay vì tạo
  // bản ghi mới nhân bản.
  const previousOrders = _orders.slice();
  const previousProcessed = _processed.slice();
  _processed.splice(idx, 1);
  const restored = {
    id: rec.id,
    savedAt: rec.savedAt,
    order: rec.order,
    form: rec.form || { customerName: '', payment: 'ck', note: '', sellerKey: '', orderText: '' },
    summary: rec.summary,
    excelDone: false,
    kvDone: false,
    _sig: orderSignature(rec.order, rec.form || {}),
    savedBy: 'reopened'
  };
  _orders.push(restored);
  try {
    await persistState('Không thể mở lại đơn đã xử lý!');
  } catch (e) {
    _orders = previousOrders;
    _processed = previousProcessed;
    return;
  }
  refreshBadge();

  if (hasWork) {
    const flushedId = await autoSaveNow();
    if (!flushedId) {
      _orders = previousOrders;
      _processed = previousProcessed;
      return;
    }
  }

  restoreRecordOnScreen(restored);
  closeListModal();
  showToast(`Đã mở lại đơn "${name}" — quay về chờ duyệt. Sửa xong hãy Xuất Excel / Lên đơn KiotViet lại.`, 'info');
}

/**
 * Đánh dấu một bước xử lý hoàn tất cho bản ghi chờ duyệt:
 *   'excel' = Xuất Excel thành công toàn bộ hãng
 *   'kv'    = Lên đơn KiotViet hoàn tất
 *
 * Hàm này CHỈ cập nhật chip tiến độ. Dù cả Excel + KV đều xong, record vẫn
 * ở danh sách chờ duyệt; chỉ completePending() hoặc deletePending() mới được
 * rút record. Nhờ vậy đóng/mở app, đổi tab hoặc chạy xong automation đều không
 * làm mất đơn ngoài ý muốn.
 *
 * QUAN TRỌNG: caller phải truyền id được CAPTURE TẠI THỜI ĐIỂM BẮT ĐẦU
 * (lúc bấm Xuất/Lên đơn), KHÔNG đọc currentOrder tại thời điểm hoàn tất.
 * Lý do: automation KV chạy nền vài phút — nếu user mở đơn khác trong lúc
 * chờ thì currentOrder đã đổi; đọc lúc hoàn tất sẽ đánh dấu nhầm đơn khác.
 * @param {string|null} id - id bản ghi chờ duyệt (null → no-op).
 * @param {'excel'|'kv'} source - bước vừa hoàn tất.
 * @param {string|null} expectedSignature - signature lúc bắt đầu thao tác;
 *   nếu record đã bị sửa trong lúc chạy thì không đánh dấu kết quả cũ.
 * @returns {Promise<{marked:boolean, reason?:string}>}
 */
export async function markDone(id, source, expectedSignature = null) {
  if (!id) return { marked: false, reason: 'missing-id' };
  await ensureLoaded();

  const idx = _orders.findIndex(r => r.id === id);
  if (idx === -1) {
    console.info(`[PendingOrders] markDone(${id}, ${source}): record không còn trong chờ duyệt (đã hoàn tất hoặc đã xóa).`);
    return { marked: false, reason: 'missing-record' };
  }
  const rec = _orders[idx];
  if (expectedSignature && rec._sig !== expectedSignature) {
    showToast(`Đơn "${recName(rec)}" đã thay đổi trong lúc xử lý — chưa đánh dấu hoàn thành.`, 'warning');
    return { marked: false, reason: 'changed' };
  }
  const previousExcelDone = rec.excelDone;
  const previousKvDone = rec.kvDone;
  if (source === 'excel') rec.excelDone = true;
  if (source === 'kv') rec.kvDone = true;
  const name = recName(rec);

  try {
    await persist();
  } catch (e) {
    rec.excelDone = previousExcelDone;
    rec.kvDone = previousKvDone;
    throw e;
  }
  refreshBadge();
  rerenderIfOpen();
  const doneLabel = source === 'excel' ? 'Xuất Excel' : 'Lên đơn KiotViet';
  showToast(`Đã xong ${doneLabel} cho đơn "${name}". Đơn vẫn ở chờ duyệt.`, 'info');
  console.info(`[PendingOrders] markDone(${id}, ${source}) → excel=${!!rec.excelDone} kv=${!!rec.kvDone}; vẫn pending`);
  return { marked: true };
}

/**
 * "Hoàn tất" tay từ danh sách — thao tác DUY NHẤT bên cạnh "Xóa" được
 * phép rút đơn sau khi đã xuất Excel / lên KiotViet; chuyển sang Đã xử lý.
 * @param {string} id
 */
export async function completePending(id) {
  await ensureLoaded();
  const idx = _orders.findIndex(r => r.id === id);
  if (idx === -1) return;
  const rec = _orders[idx];
  const name = recName(rec);
  const ok = await confirmDialog({
    title: '✔ Hoàn tất đơn',
    message: `Xác nhận đơn "${name}" đã xử lý xong?\nĐơn sẽ chuyển sang tab "Đã xử lý" và rời danh sách chờ duyệt.`,
    confirmText: 'Hoàn tất'
  });
  if (!ok) return;
  const sources = [rec.excelDone && 'excel', rec.kvDone && 'kv', 'manual'].filter(Boolean);
  // Pending + processed nằm trong cùng envelope: chuyển trạng thái atomic,
  // không thể crash giữa hai lần ghi và tạo bản trùng/mất.
  const previousOrders = _orders.slice();
  const previousProcessed = _processed.slice();
  const wasCurrent = !!(store.getState().currentOrder && store.getState().currentOrder._pendingId === id);
  moveToProcessed(rec, sources);
  _orders.splice(idx, 1);
  markRemoved(rec, 'complete');
  if (wasCurrent) unlinkIfCurrent(id);
  try {
    await persistState('Không thể hoàn tất đơn — dữ liệu được giữ nguyên!');
  } catch (e) {
    _orders = previousOrders;
    _processed = previousProcessed;
    if (wasCurrent) {
      const cur = store.getState().currentOrder;
      if (cur) store.setState({ currentOrder: { ...cur, _pendingId: id } });
    }
    return;
  }
  renderListModal();
  refreshBadge();
  showToast(`Đã hoàn tất đơn "${name}" — chuyển vào Đã xử lý.`, 'success');
}

// --- Modal danh sách -----------------------------------------------------

/** Đóng modal danh sách (an toàn khi gọi nhiều lần). */
export function closeListModal() {
  const overlay = document.getElementById('pendingListOverlay');
  if (_listTrap) { _listTrap.release(); _listTrap = null; }
  if (overlay) overlay.remove();
}

/** Nhãn nguồn xử lý cho bản ghi Đã xử lý. */
function processedSourceLabel(sources) {
  const parts = [];
  if (Array.isArray(sources)) {
    if (sources.includes('excel')) parts.push('Excel');
    if (sources.includes('kv')) parts.push('KV');
    if (sources.includes('manual')) parts.push('Tay');
  }
  return parts.length ? parts.join(' + ') : '—';
}

function directActionKey(id, source) {
  return `${source}:${id}`;
}

/** Clone đúng record theo id tại thời điểm bấm, không giữ object có thể bị mutate. */
function pendingActionSnapshot(id) {
  const rec = _orders.find(r => r.id === id);
  if (!rec || !rec.order) return null;
  return {
    pendingId: rec.id,
    expectedSignature: rec._sig || null,
    order: cloneOrder(rec.order),
    form: cloneOrder(rec.form || {})
  };
}

async function runPendingExcelAction(id) {
  if (typeof _exportPending !== 'function') {
    showToast('Chưa kết nối được luồng xuất Excel cho đơn chờ duyệt.', 'error');
    return;
  }
  const key = directActionKey(id, 'excel');
  if (_runningDirectActions.has(key)) return;
  await ensureLoaded();
  if (_runningDirectActions.has(key)) return;
  const snapshot = pendingActionSnapshot(id);
  if (!snapshot) {
    showToast('Không tìm thấy đơn để xuất Excel.', 'error');
    return;
  }

  _runningDirectActions.add(key);
  closeListModal();
  try {
    await _exportPending(snapshot);
  } catch (error) {
    console.error('[PendingOrders] Direct Excel failed:', error);
    showToast(`Không xuất được Excel: ${error?.message || String(error)}`, 'error');
  } finally {
    _runningDirectActions.delete(key);
    renderListModal();
  }
}

async function runPendingKiotVietAction(id) {
  if (typeof _openPendingKiotViet !== 'function') {
    showToast('Chưa kết nối được luồng lên đơn KiotViet.', 'error');
    return;
  }
  const key = directActionKey(id, 'kv');
  if (_runningDirectActions.has(key)) return;
  await ensureLoaded();
  if (_runningDirectActions.has(key)) return;
  const snapshot = pendingActionSnapshot(id);
  if (!snapshot) {
    showToast('Không tìm thấy đơn để lên KiotViet.', 'error');
    return;
  }

  _runningDirectActions.add(key);
  closeListModal();
  let released = false;
  const releaseAndReopen = () => {
    if (released) return;
    released = true;
    _runningDirectActions.delete(key);
    renderListModal();
  };

  try {
    const opened = await _openPendingKiotViet(snapshot, { onClose: releaseAndReopen });
    if (opened === false) releaseAndReopen();
  } catch (error) {
    console.error('[PendingOrders] Direct KiotViet failed:', error);
    showToast(`Không mở được luồng KiotViet: ${error?.message || String(error)}`, 'error');
    releaseAndReopen();
  }
}

/**
 * Vẽ/dán lại modal danh sách đơn chờ duyệt (2 tab: Chờ duyệt / Đã xử lý).
 * Gọi lại nhiều lần an toàn (modal cũ bị remove trước khi vẽ mới).
 */
export function renderListModal() {
  closeListModal();

  const overlay = document.createElement('div');
  overlay.id = 'pendingListOverlay';
  overlay.className = 'modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'pendingListTitle');

  const content = document.createElement('div');
  content.className = 'modal-content pending-modal';
  content.onclick = e => e.stopPropagation();

  // Header
  const header = document.createElement('div');
  header.className = 'card-header pending-header';
  const title = document.createElement('div');
  title.className = 'card-title';
  title.id = 'pendingListTitle';
  title.innerHTML = `<span>🧾 Đơn Chờ Duyệt</span><span class="pending-total-badge">${_orders.length}</span>`;
  header.appendChild(title);

  // Tabs
  const tabs = document.createElement('div');
  tabs.className = 'pending-tabs';
  tabs.setAttribute('role', 'tablist');
  const mkTab = (key, label, count) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pending-tab' + (_activeTab === key ? ' active' : '');
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', _activeTab === key ? 'true' : 'false');
    b.textContent = `${label} (${count})`;
    b.onclick = () => { _activeTab = key; renderListModal(); };
    return b;
  };
  tabs.append(
    mkTab('pending', '⏳ Chờ duyệt', _orders.length),
    mkTab('processed', '✓ Đã xử lý', _processed.length)
  );

  // Body — danh sách bản ghi
  const list = document.createElement('div');
  list.className = 'pending-list';

  if (_activeTab === 'pending') {
    // ── Đơn đang phân tích nền (hàng đợi parse song song — task TẠM, không
    // lưu store: mất khi restart app thì text vẫn còn trong ô tin nhắn) ──
    const analyzing = getActiveParseTasks();
    analyzing.forEach(t => {
      const row = document.createElement('div');
      row.className = 'pending-item pending-item-analyzing';

      const info = document.createElement('div');
      info.className = 'pending-item-info';
      info.innerHTML =
        `<div class="pending-item-name" title="${escapeHtml(t.label)}">${escapeHtml(t.label)}</div>` +
        `<div class="pending-item-meta">${escapeHtml(t.statusLabel)}</div>`;

      const actions = document.createElement('div');
      actions.className = 'pending-item-actions';
      if (t.status === 'error') {
        const btnRetry = document.createElement('button');
        btnRetry.className = 'btn btn-ghost btn-sm';
        btnRetry.type = 'button';
        btnRetry.textContent = 'Thử lại';
        btnRetry.title = 'Phân tích lại tin nhắn này';
        btnRetry.onclick = () => retryParse(t.id);
        actions.append(btnRetry);
      }
      const btnStop = document.createElement('button');
      btnStop.className = 'btn btn-ghost btn-sm pending-delete-btn';
      btnStop.type = 'button';
      btnStop.textContent = t.status === 'error' ? '✕' : 'Hủy';
      btnStop.setAttribute('aria-label', `${t.status === 'error' ? 'Bỏ qua' : 'Hủy phân tích'} đơn ${t.label}`);
      btnStop.onclick = () => { t.status === 'error' ? dismissParseTask(t.id) : cancelParseTask(t.id); };
      actions.append(btnStop);

      row.append(info, actions);
      list.appendChild(row);
    });

    if (_orders.length === 0 && analyzing.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pending-empty';
      empty.textContent = 'Chưa có đơn nào trong danh sách chờ duyệt.';
      list.appendChild(empty);
    } else if (_orders.length > 0) {
      [..._orders].sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt)).forEach(rec => {
        // Bản nháp: đơn chưa parse (0 SP) — chỉ có raw text, mở ra bấm "Phân tích"
        const isDraft = !Array.isArray(rec.order.items) || rec.order.items.length === 0;
        const rawText = (rec.order && rec.order.rawChatText) || '';
        const name = isDraft
          ? (rawText.split('\n')[0].trim().slice(0, 60) || '(nháp trống)')
          : recName(rec);
        const s = rec.summary || {};
        const sellerLabel = (() => {
          const sel = findSellerByKey(getSellers(), (rec.form && rec.form.sellerKey) || '');
          return sel ? sel.name : '';
        })();

        const row = document.createElement('div');
        row.className = 'pending-item';

        const info = document.createElement('div');
        info.className = 'pending-item-info';
        const metaParts = isDraft
          ? ['📝 Nháp — chưa phân tích']
          : [
              `${s.itemCount ?? '?'} SP`,
              s.boxes !== undefined ? `${s.boxes} thùng` : '',
              s.total !== undefined ? formatCurrency(s.total) : '',
              sellerLabel ? `👤 ${escapeHtml(sellerLabel)}` : ''
            ].filter(Boolean);

        // Chip trạng thái/tác vụ: bước chưa xong bấm được trực tiếp; bước đã
        // xong bị disable để tránh tạo file hoặc đơn KiotViet trùng.
        const chips = document.createElement('div');
        chips.className = 'pending-step-chips';
        chips.setAttribute('role', 'group');
        chips.setAttribute('aria-label', `Các bước xử lý đơn ${name}`);
        const mkChip = ({ source, done, label, title, actionLabel }) => {
          const c = document.createElement('button');
          c.type = 'button';
          c.className = 'pending-step-chip' + (done ? ' done' : '');
          c.textContent = label;
          c.title = title;
          c.disabled = !!done;
          c.dataset.pendingId = rec.id;
          c.dataset.pendingSource = source;
          c.setAttribute('aria-label', `${actionLabel} cho đơn ${name}`);
          if (!done) c.onclick = () => source === 'excel' ? runPendingExcelAction(rec.id) : runPendingKiotVietAction(rec.id);
          return c;
        };
        if (!isDraft) {
          chips.append(
            mkChip({
              source: 'excel',
              done: !!rec.excelDone,
              label: rec.excelDone ? 'Đã xuất Excel' : 'Xuất Excel',
              actionLabel: 'Xuất Excel',
              title: rec.excelDone ? 'Đơn này đã xuất Excel' : 'Xuất Excel ngay cho đơn này'
            }),
            mkChip({
              source: 'kv',
              done: !!rec.kvDone,
              label: rec.kvDone ? 'Đã lên KiotViet' : 'Lên KiotViet',
              actionLabel: 'Lên KiotViet',
              title: rec.kvDone ? 'Đơn này đã lên KiotViet' : 'Mở bước lên đơn KiotViet cho đơn này'
            })
          );
        }

        info.innerHTML =
          `<div class="pending-item-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>` +
          `<div class="pending-item-meta">${metaParts.join(' · ')}</div>` +
          `<div class="pending-item-time">🕒 Lưu ${formatSavedAt(rec.savedAt)}</div>`;
        info.appendChild(chips);

        const actions = document.createElement('div');
        actions.className = 'pending-item-actions';

        const btnOpen = document.createElement('button');
        btnOpen.className = 'btn btn-primary btn-sm';
        btnOpen.type = 'button';
        btnOpen.textContent = 'Mở để sửa';
        btnOpen.onclick = () => loadPending(rec.id);

        const btnDone = document.createElement('button');
        btnDone.className = 'btn btn-ghost btn-sm';
        btnDone.type = 'button';
        btnDone.textContent = 'Hoàn tất';
        btnDone.title = 'Đánh dấu đơn đã xử lý xong và chuyển sang Đã xử lý';
        btnDone.onclick = () => completePending(rec.id);

        const btnDel = document.createElement('button');
        btnDel.className = 'btn btn-ghost btn-sm pending-delete-btn';
        btnDel.type = 'button';
        btnDel.textContent = 'Xóa';
        btnDel.setAttribute('aria-label', `Xóa đơn chờ duyệt ${name}`);
        btnDel.onclick = () => deletePending(rec.id);

        actions.append(btnOpen, btnDel);
        if (!isDraft) actions.append(btnDone);
        row.append(info, actions);
        list.appendChild(row);
      });
    }
  } else {
    // --- Tab Đã xử lý (lịch sử — vẫn "Mở lại" được nếu cần sửa rồi làm lại) ---
    if (_processed.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pending-empty';
      empty.textContent = 'Chưa có đơn nào đã xử lý. Đơn sẽ vào đây khi bạn bấm Hoàn tất ở tab Chờ duyệt.';
      list.appendChild(empty);
    } else {
      [..._processed].sort((a, b) => new Date(b.processedAt || b.savedAt || 0) - new Date(a.processedAt || a.savedAt || 0)).forEach(rec => {
        const name = rec.customer || '(không tên)';
        const s = rec.summary || {};

        const row = document.createElement('div');
        row.className = 'pending-item';

        const info = document.createElement('div');
        info.className = 'pending-item-info';
        const metaParts = [
          `${s.itemCount ?? '?'} SP`,
          s.boxes !== undefined ? `${s.boxes} thùng` : '',
          s.total !== undefined ? formatCurrency(s.total) : ''
        ].filter(Boolean);
        info.innerHTML =
          `<div class="pending-item-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>` +
          `<div class="pending-item-meta">${metaParts.join(' · ')}</div>` +
          `<div class="pending-item-time">✔ Xong ${formatSavedAt(rec.processedAt)} · ${processedSourceLabel(rec.sources)}</div>`;

        const actions = document.createElement('div');
        actions.className = 'pending-item-actions';
        if (rec.order) {
          const btnReopen = document.createElement('button');
          btnReopen.className = 'btn btn-ghost btn-sm';
          btnReopen.type = 'button';
          btnReopen.textContent = 'Mở lại';
          btnReopen.title = 'Mở lại đơn này để sửa — đơn quay về Chờ duyệt (reset Excel/KiotViet), xử lý xong sẽ trở lại đây';
          btnReopen.setAttribute('aria-label', `Mở lại đơn đã xử lý ${name}`);
          btnReopen.onclick = () => reopenProcessed(rec.id);
          actions.append(btnReopen);
        }
        const btnDel = document.createElement('button');
        btnDel.className = 'btn btn-ghost btn-sm pending-delete-btn';
        btnDel.type = 'button';
        btnDel.textContent = 'Xóa';
        btnDel.setAttribute('aria-label', `Xóa bản ghi đã xử lý ${name}`);
        btnDel.onclick = () => deleteProcessed(rec.id);
        actions.append(btnDel);

        row.append(info, actions);
        list.appendChild(row);
      });
    }
  }

  // Footer
  const footer = document.createElement('div');
  footer.className = 'pending-footer';
  const hint = document.createElement('div');
  hint.className = 'pending-footer-hint';
  hint.textContent = 'Bấm Xuất Excel hoặc Lên KiotViet để xử lý ngay đơn đó. Đơn chỉ rời danh sách khi bấm Hoàn tất hoặc Xóa.';
  const btnClose = document.createElement('button');
  btnClose.className = 'btn btn-ghost btn-sm';
  btnClose.type = 'button';
  btnClose.textContent = 'Đóng';
  btnClose.onclick = closeListModal;
  footer.append(hint, btnClose);

  content.append(header, tabs, list, footer);
  overlay.appendChild(content);
  document.body.appendChild(overlay);

  // Bấm nền = đóng; Esc đóng qua trapFocus
  overlay.onclick = (e) => { if (e.target === overlay) closeListModal(); };
  _listTrap = trapFocus(overlay, { onEscape: closeListModal });
}

// --- Init ----------------------------------------------------------------

/** Gắn event + nạp dữ liệu + kích hoạt auto-save. Gọi 1 lần từ src/main.js. */
export function initPendingOrders({ exportPending, openKiotViet } = {}) {
  if (typeof exportPending === 'function') _exportPending = exportPending;
  if (typeof openKiotViet === 'function') _openPendingKiotViet = openKiotViet;

  const btnSave = document.getElementById('btnSavePending');
  const btnList = document.getElementById('btnPendingList');
  if (btnSave) btnSave.onclick = () => saveCurrentOrder();
  // Chờ nạp xong mới mở modal — tránh hiện danh sách rỗng ảo do race khởi động
  if (btnList) {
    btnList.onclick = () => ensureLoaded().then(() => {
      if (_pendingLoadError) {
        showToast('Chưa đọc được danh sách đơn chờ duyệt — không mở danh sách rỗng để tránh hiểu nhầm.', 'error');
        return;
      }
      renderListModal();
    });
  }
  ensureLoaded().then(() => { if (!_pendingLoadError) refreshBadge(); });
  registerAutoSaveTriggers();
}

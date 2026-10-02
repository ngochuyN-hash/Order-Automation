/**
 * Tests cho src/order/parse-queue.js — HÀNG ĐỢI PHÂN TÍCH SONG SONG.
 *
 * Cover:
 * 1. Giới hạn số đơn chạy cùng lúc (pool, mặc định 2, setting 1–5).
 * 2. Chặn trùng: cùng text đang chờ/chạy → 'duplicate', không nhân bản task.
 * 3. Hoàn tất khi ĐANG MỞ một bản ghi chờ duyệt khác → tạo bản ghi chờ duyệt
 *    trực tiếp (savedBy 'queue', dedup theo rawChatText), không giật màn hình.
 * 4. Hoàn tất khi màn hình còn "chờ đúng đơn đó" → áp lên màn hình như parse
 *    tuần tự cũ (store.currentOrder được thay).
 * 5. Lỗi pipeline → task đứng lại trạng thái error, KHÔNG tạo bản ghi rác;
 *    Thử lại tạo task mới và hoàn tất bình thường.
 * 6. Hủy task (AbortSignal) → task bị bỏ, không tạo bản ghi.
 * 7. Không có AI profile nào bật → tự chạy parser offline (regex).
 * 8. Đơn DUY NHẤT trong hàng đợi → LUÔN tự hiện lên màn hình khi xong, kể cả
 *    ô tin nhắn đã bị xóa/sửa trong lúc chờ (không rót âm thầm vào danh sách).
 * 9. Render nổ lỗi SAU khi parse thành công → đơn được cứu vào chờ duyệt,
 *    không vứt kết quả.
 *
 * Run: node --test test/parse-queue.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// --- Stub môi trường trình duyệt TRƯỚC khi import module -------------------
const memStorage = new Map();
globalThis.localStorage = {
  getItem: (k) => (memStorage.has(k) ? memStorage.get(k) : null),
  setItem: (k, v) => memStorage.set(k, String(v)),
  removeItem: (k) => memStorage.delete(k),
};

const _origSetTimeout = globalThis.setTimeout;
const sleep = (ms) => new Promise(r => _origSetTimeout(r, ms).unref?.());
globalThis.setTimeout = (fn, ms, ...args) => {
  const t = _origSetTimeout(fn, ms, ...args);
  if (typeof t.unref === 'function') t.unref();
  return t;
};
globalThis.requestAnimationFrame = (fn) => _origSetTimeout(() => fn(Date.now()), 0);
globalThis.HTMLElement = class HTMLElement {};

const elements = {};
function mkEl() {
  return {
    value: '', textContent: '', innerHTML: '', title: '', className: '',
    style: {}, dataset: {}, children: [],
    appendChild(c) { this.children.push(c); return c; },
    append(...cs) { this.children.push(...cs); },
    removeChild() {}, remove() {},
    setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    classList: { contains: () => false, add() {}, remove() {}, toggle() {} },
    onclick: null
  };
}
global.document = {
  visibilityState: 'visible',
  body: mkEl(),
  getElementById: (id) => (elements[id] || (elements[id] = mkEl())),
  createElement: () => mkEl(),
  createDocumentFragment: () => mkEl(),
  querySelector: () => null,
  addEventListener() {}
};
global.window = { indexedDB: undefined, addEventListener() {} };

const { store } = await import('../store.js');
const { db } = await import('../db.js');
const { uiRenderer } = await import('../ui-renderer.js');
const { aiService } = await import('../ai-service.js');
const { CustomerNotes } = await import('../src/customer-notes.js');
const { autoSaveNow, createPendingFromOrder } = await import('../src/order/pending.js');
const {
  enqueueParse, getActiveParseTasks, cancelParseTask, retryParse,
  getParseConcurrency, setParseConcurrency, _setPipelineRunner
} = await import('../src/order/parse-queue.js');

const STATE_KEY = 'order_automation_pending_state_v2';
const readPending = () => {
  const state = JSON.parse(localStorage.getItem(STATE_KEY) || '{"orders":[]}');
  return state.orders || [];
};
const el = (id) => document.getElementById(id);

/** Chờ tới khi điều kiện thỏa (poll 10ms, quá hạn thì fail). */
async function waitFor(fn, timeoutMs = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(10);
  }
}

/** Chờ task cụ thể đạt trạng thái mong muốn (theo id — tránh nhầm task cũ). */
const taskStatus = (id) => (getActiveParseTasks().find(k => k.id === id) || {}).status;
const waitForTask = (id, status, timeoutMs = 3000) => waitFor(() => taskStatus(id) === status, timeoutMs);
const waitForTaskGone = (id, timeoutMs = 3000) => waitFor(() => taskStatus(id) === undefined, timeoutMs);

/** Đơn giả đủ shape để qua buildSummary + applyParsedOrderToScreen. */
const mkOrder = (text) => ({
  customer: 'Khách Test',
  payment: 'ck',
  items: [{
    product: { kvCode: 'AX01', name: 'SP 1' },
    qty: 2, unit: 'chai', unitPrice: 50000, subtotal: 130017,
    isGift: false, foc: null, tierLabel: '', matchScore: 95, matchVia: 'kvcode'
  }],
  customPromos: [],
  parsedLines: [],
  aiResult: { primaryCampaign: 'zentor', campaignLabel: 'Zentor', campaignColor: '#4fc3f7', confidencePercent: 100, allScores: {} },
  giftOverrides: {}, giftDeleted: {}, giftQtyOverrides: {}, giftKindOverrides: {},
  rowOrder: null,
  rawChatText: text,
  salesComment: ''
});

// Render phụ trợ của parse-apply không chạy thật dưới DOM stub — thay bằng no-op
uiRenderer.renderAIDetection = () => {};
uiRenderer.renderParsedPreview = () => {};
CustomerNotes.checkAndWarn = () => {};

// AI profile giả: bật 1 profile → queue chọn đường AI pipeline (đã stub)
aiService.getProfiles = async () => ({ profiles: [{ id: 'p1', enabled: true }], strategy: 'roundrobin', activeId: 'p1' });

describe('ParseQueue — hàng đợi phân tích song song', () => {

  it('mặc định & giới hạn số đơn song song: 4 đơn với limit 2 → tối đa 2 chạy cùng lúc', async () => {
    assert.equal(getParseConcurrency(), 2, 'mặc định 2 đơn song song');
    setParseConcurrency(2);

    let active = 0;
    let maxActive = 0;
    _setPipelineRunner(async (text) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(25);
      active--;
      return { order: mkOrder(text), meta: {} };
    });

    // ô tin nhắn trống → không task nào khớp màn hình → tất cả vào chờ duyệt
    el('orderText').value = '';
    const texts = ['đơn pool 1', 'đơn pool 2', 'đơn pool 3', 'đơn pool 4'];
    texts.forEach(t => enqueueParse(t));

    await waitFor(() => texts.every(t => readPending().some(r => r.order.rawChatText === t)));

    assert.ok(maxActive <= 2, `tối đa 2 task chạy cùng lúc (thấy ${maxActive})`);
    assert.equal(maxActive, 2, 'hai task đầu phải chạy SONG SONG đúng hạn mức');
    const recs = readPending().filter(r => texts.includes(r.order.rawChatText));
    assert.equal(recs.length, 4, 'cả 4 đơn đều có bản ghi chờ duyệt');
    // Đơn hoàn tất CUỐI CÙNG là đơn duy nhất còn active → tự hiện màn hình
    // (auto-save tạo bản ghi savedBy 'auto'); 3 đơn còn lại rót vào list.
    assert.ok(texts.includes(store.getState().currentOrder?.rawChatText),
      'đơn hoàn tất cuối cùng phải tự hiện lên màn hình');
    const fromQueue = recs.filter(r => r.savedBy === 'queue');
    assert.ok(fromQueue.length >= 3, `ít nhất 3 đơn rót vào chờ duyệt (thấy ${fromQueue.length})`);
    fromQueue.forEach(r => {
      assert.equal(r.excelDone, false);
      assert.equal(r.kvDone, false);
      assert.equal(r.form.orderText, r.order.rawChatText);
    });
  });

  it('chặn trùng: cùng text đang chạy → enqueue trả "duplicate", không nhân bản task', async () => {
    let release = null;
    _setPipelineRunner(() => new Promise(r => { release = r; }));

    el('orderText').value = '';
    const id = enqueueParse('đơn trùng text A');
    assert.ok(id && id !== 'duplicate');
    // pipeline được gọi sau 1 await getProfiles — chờ runner được invoke thật
    await waitFor(() => typeof release === 'function');
    assert.equal(enqueueParse('đơn trùng text A'), 'duplicate', 'text đang chạy bị chặn');
    assert.equal(getActiveParseTasks().length, 1, 'chỉ 1 task');

    release({ order: mkOrder('đơn trùng text A'), meta: {} });
    await waitForTaskGone(id);
    // Sau khi xong, parse lại cùng text được phép (dedup theo rawChatText ở pending)
    let release2 = null;
    _setPipelineRunner(() => new Promise(r => { release2 = r; }));
    const id2 = enqueueParse('đơn trùng text A');
    assert.ok(id2 && id2 !== 'duplicate', 'task xong rồi thì parse lại cùng text được phép');
    await waitFor(() => typeof release2 === 'function');
    release2({ order: mkOrder('đơn trùng text A'), meta: {} });
    await waitForTaskGone(id2);
  });

  it('ĐANG MỞ một bản ghi chờ duyệt khác → đơn đổ thẳng vào chờ duyệt, không giật màn hình', async () => {
    // Mô phỏng user đang mở/xem một bản ghi khác trên màn hình
    store.setState({ currentOrder: {
      customer: 'Khách đang mở', payment: 'ck', items: [], customPromos: [],
      parsedLines: [], aiResult: null, rawChatText: 'đơn đang mở khác',
      _pendingId: 'po_other_record'
    } });
    el('orderText').value = 'một tin nhắn khác hoàn toàn';
    const before = readPending().filter(r => r.order.rawChatText === 'đơn nền B').length;

    _setPipelineRunner(async (text) => ({ order: mkOrder(text), meta: {} }));
    const id = enqueueParse('đơn nền B');
    await waitFor(() => readPending().filter(r => r.order.rawChatText === 'đơn nền B').length === before + 1);
    await waitForTaskGone(id);

    assert.equal(store.getState().currentOrder.rawChatText, 'đơn đang mở khác', 'màn hình không bị giật');
  });

  it('màn hình còn chờ đúng đơn đó → áp lên màn hình như parse tuần tự', async () => {
    // Màn hình trống (không mở bản ghi nào) — user chờ đúng đơn này
    store.setState({ currentOrder: { customer: '', items: [], rawChatText: '', _pendingId: null } });
    _setPipelineRunner(async (text) => ({ order: mkOrder(text), meta: { learned: { count: 1 } } }));
    el('orderText').value = 'đơn lên màn hình C';
    enqueueParse('đơn lên màn hình C');
    await waitFor(() => store.getState().currentOrder.rawChatText === 'đơn lên màn hình C');

    const cur = store.getState().currentOrder;
    assert.equal(cur.customer, 'Khách Test');
    assert.equal(cur.items.length, 1);

    // Lưu NGAY sau khi áp màn hình — đơn phải nằm trong Đơn chờ duyệt NGAY
    const recs = readPending().filter(r => r.order.rawChatText === 'đơn lên màn hình C');
    assert.equal(recs.length, 1, 'đơn xong phải nằm trong Đơn chờ duyệt ngay lập tức');
    assert.equal(recs[0].order.items.length, 1);
    assert.equal(cur._pendingId, recs[0].id, '_pendingId gắn đúng bản ghi đơn thật (như auto-save cũ)');

    // Trong lúc chờ, auto-save flush đã tạo nháp raw text (đúng cơ chế app thật:
    // dán text là có nháp — text nằm trong form.orderText) — đơn thật sau 2s
    // debounce sẽ đè nháp qua dedup. Ở đây chỉ cần KHÔNG nhân bản real record.
    const realFromQueue = readPending().filter(r =>
      r.order.rawChatText === 'đơn lên màn hình C' && r.savedBy === 'queue');
    assert.equal(realFromQueue.length, 0, 'chọn đường màn hình → queue KHÔNG tự tạo record trùng');
  });

  it('CHUỖI APP THẬT: paste → nháp auto-save gắn _pendingId → parse xong vẫn hiện màn hình + nạp đè ĐÚNG nháp', async () => {
    // Bước 1 — user dán text: rescan set rawChatText, auto-save nền tạo nháp
    // và GẮN _pendingId vào currentOrder (saveOrderSnapshot.attachPendingId)
    const text = 'đơn chuỗi thật H';
    el('orderText').value = text;
    store.setState({ currentOrder: { ...store.getState().currentOrder, rawChatText: text } });
    const draftId = await autoSaveNow();
    assert.ok(draftId, 'nháp được auto-save');
    assert.equal(store.getState().currentOrder._pendingId, draftId, 'nháp gắn _pendingId như app thật');

    // Bước 2 — bấm Phân tích, chờ task xong
    _setPipelineRunner(async (t) => ({ order: mkOrder(t), meta: {} }));
    const id = enqueueParse(text);
    await waitFor(() => store.getState().currentOrder.items.length === 1);
    await waitForTaskGone(id, 4000);

    // Kết quả: hiện MÀN HÌNH (không bị nháp _pendingId chặn)...
    assert.equal(store.getState().currentOrder.customer, 'Khách Test');
    // ...và NẠP ĐÈ đúng bản nháp — tuyệt đối không nhân bản 2 bản ghi cùng text
    const recs = readPending().filter(r => r.order.rawChatText === text);
    assert.equal(recs.length, 1, 'chỉ 1 bản ghi cho text này (nháp được nạp đè)');
    assert.equal(recs[0].id, draftId);
    assert.equal(recs[0].order.items.length, 1, 'bản ghi có sản phẩm thật');
  });

  it('lỗi pipeline → task error, KHÔNG tạo bản ghi; Thử lại hoàn tất bình thường', async () => {
    el('orderText').value = '';
    _setPipelineRunner(async () => { throw new Error('AI nổ'); });

    const id = enqueueParse('đơn lỗi D');
    await waitForTask(id, 'error');

    const t = getActiveParseTasks().find(k => k.id === id);
    assert.ok(t.statusLabel.includes('AI nổ'), 'statusLabel nêu rõ lỗi');
    assert.equal(
      readPending().filter(r => r.order.rawChatText === 'đơn lỗi D').length, 0,
      'lỗi không được tạo bản ghi rác'
    );

    // Thử lại → task cũ (error) bị bỏ, task mới chạy runner thành công → vào chờ duyệt
    _setPipelineRunner(async (text) => ({ order: mkOrder(text), meta: {} }));
    retryParse(id);
    assert.equal(taskStatus(id), undefined, 'task cũ bị bỏ');
    await waitFor(() => readPending().some(r => r.order.rawChatText === 'đơn lỗi D'));
  });

  it('hủy task đang chạy (AbortSignal) → task bị bỏ, không tạo bản ghi', async () => {
    _setPipelineRunner((text, deps, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    }));

    el('orderText').value = '';
    const id = enqueueParse('đơn hủy E');
    await waitForTask(id, 'running');
    cancelParseTask(id);
    await waitForTaskGone(id);

    assert.equal(
      readPending().filter(r => r.order.rawChatText === 'đơn hủy E').length, 0,
      'hủy không tạo bản ghi'
    );
  });

  it('không có AI profile nào bật → task tự chạy parser offline (regex), vẫn vào chờ duyệt', async () => {
    db.initSync(); // offline parser đọc danh mục thật — cần RAM cache khởi động
    aiService.getProfiles = async () => ({ profiles: [], strategy: 'failover', activeId: '' });
    _setPipelineRunner(async () => { throw new Error('pipeline không được gọi ở chế độ offline'); });

    el('orderText').value = '';
    // Text đúng format offline parser đọc được: tên khách + N unit SP + thanh toán
    const id = enqueueParse('Khách Offline\n2 chai MAX 20W50\nCK');
    await waitFor(() => readPending().some(r => (r.order.rawChatText || '').includes('Khách Offline')), 5000);
    await waitForTaskGone(id, 5000);

    const recs = readPending().filter(r => (r.order.rawChatText || '').includes('Khách Offline'));
    assert.equal(recs.length, 1, 'offline parser vẫn tạo được bản ghi');
    assert.ok(recs[0].order.items.length >= 1, 'offline parser tách được dòng sản phẩm');
    // khôi phục profile giả (an toàn cho các suite chạy sau trong cùng file)
    aiService.getProfiles = async () => ({ profiles: [{ id: 'p1', enabled: true }], strategy: 'roundrobin', activeId: 'p1' });
  });

  it('đơn DUY NHẤT xong dù ô tin nhắn đã bị xóa → vẫn tự hiện lên màn hình', async () => {
    // Màn hình trống, không liên kết bản ghi nào; user xóa ô tin nhắn khi chờ
    store.setState({ currentOrder: { customer: '', items: [], rawChatText: '', _pendingId: null } });
    el('orderText').value = '';

    _setPipelineRunner(async (text) => ({ order: mkOrder(text), meta: {} }));
    const id = enqueueParse('đơn lẻ tự hiện J');
    await waitFor(() => store.getState().currentOrder.rawChatText === 'đơn lẻ tự hiện J');
    await waitForTaskGone(id, 4000);

    assert.equal(store.getState().currentOrder.customer, 'Khách Test', 'kết quả hiện đầy đủ trên màn hình');
    const recs = readPending().filter(r => r.order.rawChatText === 'đơn lẻ tự hiện J');
    assert.equal(recs.length, 1, 'tự hiện màn hình vẫn auto-save vào chờ duyệt');
  });

  it('render nổ lỗi SAU khi parse thành công → đơn được cứu vào chờ duyệt, không vứt kết quả', async () => {
    store.setState({ currentOrder: { customer: '', items: [], rawChatText: '', _pendingId: null } });
    el('orderText').value = '';

    const origPreview = uiRenderer.renderParsedPreview;
    uiRenderer.renderParsedPreview = () => { throw new Error('render nổ'); };
    try {
      _setPipelineRunner(async (text) => ({ order: mkOrder(text), meta: {} }));
      const id = enqueueParse('đơn render nổ I');
      await waitForTaskGone(id, 4000);

      // setState của applyParsedOrderToScreen đã chạy trước khi render nổ
      assert.equal(store.getState().currentOrder.customer, 'Khách Test', 'store đã nhận đơn');
      const recs = readPending().filter(r => r.order.rawChatText === 'đơn render nổ I');
      assert.equal(recs.length, 1, 'parse thành công thì kết quả KHÔNG được vứt — đổ về chờ duyệt');
      assert.equal(recs[0].savedBy, 'queue');
    } finally {
      uiRenderer.renderParsedPreview = origPreview;
    }
  });
});

describe('createPendingFromOrder — API tạo bản ghi từ code (parse nền)', () => {
  it('tạo bản ghi với form từ tham số; gọi lại cùng rawChatText → cập nhật, không nhân bản', async () => {
    // Tách state từ test trước: createPendingFromOrder KHÔNG được gắn _pendingId
    store.setState({ currentOrder: { ...store.getState().currentOrder, _pendingId: null } });

    const order = mkOrder('API record F');
    order.customer = 'Khách F';
    const id1 = await createPendingFromOrder(order, {
      customerName: 'Khách F', payment: 'ck', note: '', sellerKey: '', orderText: 'API record F'
    });
    assert.ok(id1, 'trả về id');

    const rec1 = readPending().find(r => r.id === id1);
    assert.equal(rec1.savedBy, 'queue');
    assert.equal(rec1.form.customerName, 'Khách F');
    assert.equal(rec1.summary.itemCount, 1);
    assert.equal(store.getState().currentOrder._pendingId ?? null, null, 'KHÔNG gắn _pendingId vào store');

    // Đơn sửa số lượng, cùng rawChatText → cập nhật đúng bản ghi cũ
    order.items[0].qty = 5;
    const id2 = await createPendingFromOrder(order, {
      customerName: 'Khách F', payment: 'ck', note: '', sellerKey: '', orderText: 'API record F'
    });
    assert.equal(id2, id1, 'dedup theo rawChatText → cùng id');
    assert.equal(readPending().filter(r => r.order.rawChatText === 'API record F').length, 1);
    assert.equal(readPending().find(r => r.id === id1).order.items[0].qty, 5);
  });

  it('nháp 0 SP có raw text → vẫn tạo bản nháp; trống hoàn toàn → từ chối', async () => {
    const draftOrder = { ...mkOrder('nháp API G'), items: [] };
    const id = await createPendingFromOrder(draftOrder, { orderText: 'nháp API G' });
    assert.ok(id, 'nháp 0 SP có text vẫn được lưu');
    const rec = readPending().find(r => r.id === id);
    assert.equal(rec.order.items.length, 0);

    const blank = { ...mkOrder(''), items: [], rawChatText: '' };
    assert.equal(await createPendingFromOrder(blank, {}), null, 'trống hoàn toàn → null');
  });
});

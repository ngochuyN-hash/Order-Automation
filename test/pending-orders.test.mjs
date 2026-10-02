/**
 * Tests cho src/order/pending.js — ĐƠN CHỜ DUYỆT TỰ ĐỘNG LƯU.
 *
 * Cover các regression từng gây MẤT ĐƠN:
 * 1. Lưu tay / auto-save tạo & cập nhật bản ghi đúng (không nhân bản).
 * 2. Auto-save KHÔNG bắt buộc tên KH (nháp an toàn); lưu tay có bắt buộc.
 * 3. Re-parse CÙNG đơn (mất _pendingId) → dedup cập nhật bản ghi cũ.
 * 4. Parse đơn KHÁC → tạo bản ghi MỚI, không đè mất đơn cũ (bug thật:
 *    merge spread của store giữ _pendingId cũ → record cũ bị ghi đè).
 * 5. markDone chỉ cập nhật tiến độ: dù Excel + KiotViet đã xong, đơn vẫn
 *    ở danh sách chờ duyệt cho tới khi người dùng bấm Hoàn tất hoặc Xóa.
 * 6. Đơn đã lưu vẫn mở lại được sau khi renderer/module khởi động lại.
 * 7. Mở lại đơn ĐÃ XỬ LÝ: lịch sử giữ đủ dữ liệu đơn → reopenProcessed đưa
 *    về chờ duyệt (reset Excel/KV) + nạp màn hình; hoàn tất lại không nhân bản.
 *
 * Run: node --test test/pending-orders.test.mjs
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

// Timer không giữ process sống (toast auto-dismiss 3-8s của ui-renderer)
const _origSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const t = _origSetTimeout(fn, ms, ...args);
  if (typeof t.unref === 'function') t.unref();
  return t;
};
// showToast (ui-renderer) dùng rAF để dismissing mượt — Node không có
globalThis.requestAnimationFrame = (fn) => globalThis.setTimeout(() => fn(Date.now()), 0);
// trapFocus (confirm-dialog) instanceof-check global HTMLElement
globalThis.HTMLElement = class HTMLElement {};

const elements = {};
function mkEl() {
  return {
    value: '', textContent: '', innerHTML: '', title: '', className: '',
    style: {}, dataset: {}, children: [],
    appendChild(c) { c.parent = this; this.children.push(c); return c; },
    append(...cs) { for (const child of cs) { child.parent = this; this.children.push(child); } },
    removeChild(c) { this.children = this.children.filter(child => child !== c); },
    remove() { if (this.parent) this.parent.removeChild(this); },
    setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    classList: { contains: () => false, add() {}, remove() {}, toggle() {} },
    focus() {},
    contains: (target) => this.children.includes(target) || this.children.some(child => child.contains && child.contains(target)),
    onclick: null
  };
}
function findFakeNode(node, predicate) {
  if (predicate(node)) return node;
  for (const child of [...(node.children || [])]) {
    const found = findFakeNode(child, predicate);
    if (found) return found;
  }
  return null;
}

global.document = {
  visibilityState: 'visible',
  body: mkEl(),
  getElementById: (id) => {
    const mounted = findFakeNode(document.body, node => node.id === id);
    if (mounted) return mounted;
    return elements[id] || (elements[id] = mkEl());
  },
  createElement: () => mkEl(),
  createDocumentFragment: () => mkEl(),
  querySelector: () => null,
  addEventListener() {},
  removeEventListener() {},
  contains: (target) => elements.__body && elements.__body.contains(target)
};
elements.__body = document.body;
global.window = { indexedDB: undefined, addEventListener() {} };

const { store } = await import('../store.js');
const { dbStore } = await import('../db-store.js');
const {
  saveCurrentOrder, autoSaveNow, markDone, completePending, deletePending,
  deleteProcessed, reopenProcessed, initPendingOrders, renderListModal
} = await import('../src/order/pending.js');

const STATE_KEY = 'order_automation_pending_state_v2';
const LEGACY_PENDING_KEY = 'order_automation_pending_orders_v1';

const readState = () => JSON.parse(localStorage.getItem(STATE_KEY) || '{"version":2,"orders":[],"processed":[]}');
const readPending = () => readState().orders || [];
const readProcessed = () => readState().processed || [];

/** Lấy (và tự tạo) element giả theo id — qua getElementById để factory chạy. */
const el = (id) => document.getElementById(id);

/** Chờ confirm-dialog xuất hiện rồi bấm nút xác nhận trong DOM giả. */
async function confirmDialogButton(className, actionPromise) {
  const findNode = (node, predicate) => {
    if (predicate(node)) return node;
    for (const child of [...(node.children || [])].reverse()) {
      const found = findNode(child, predicate);
      if (found) return found;
    }
    return null;
  };

  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
    const dialog = findNode(document.body, n => n.id === 'confirmDialogOverlay');
    const button = dialog && findNode(dialog, n => n.className === className && typeof n.onclick === 'function');
    if (button) {
      button.onclick();
      return;
    }
  }
  await actionPromise;
  throw new Error(`Không tìm thấy nút xác nhận .${className}`);
}

/** Thay đơn đang soạn trên "màn hình" — mô phỏng parse mới (reset _pendingId). */
function setOrder({ customer = '', items, rawChatText = '' }) {
  store.setState({
    currentOrder: {
      customer,
      payment: 'ck',
      items,
      customPromos: [],
      parsedLines: [],
      aiResult: null,
      rawChatText,
      _pendingId: null
    }
  });
}

const mkItem = (kvCode, qty, price) => ({
  product: { kvCode, name: `SP ${kvCode}` },
  qty, unit: 'chai', unitPrice: price, isGift: false
});

describe('PendingOrders — auto-save + markDone (kịch bản tuần tự)', () => {
  let idA;

  it('lưu tay tạo bản ghi với flags excelDone/kvDone = false', async () => {
    el('customerName').value = 'Khách A';
    setOrder({ customer: 'Khách A', items: [mkItem('AX01', 2, 50000)], rawChatText: 'text đơn A' });

    idA = await saveCurrentOrder();
    assert.ok(idA, 'phải trả về id bản ghi');

    const recs = readPending();
    assert.equal(recs.length, 1);
    assert.equal(recs[0].id, idA);
    assert.equal(recs[0].form.customerName, 'Khách A');
    assert.equal(recs[0].excelDone, false);
    assert.equal(recs[0].kvDone, false);
    assert.equal(recs[0].savedBy, 'manual');
    assert.equal(store.getState().currentOrder._pendingId, idA, 'gắn _pendingId vào đơn đang mở');
  });

  it('lưu lần 2 trên cùng đơn → cập nhật, không nhân bản', async () => {
    const id = await saveCurrentOrder();
    assert.equal(id, idA);
    assert.equal(readPending().length, 1);
  });

  it('auto-save cho phép THIẾU tên khách hàng (nháp an toàn)', async () => {
    el('customerName').value = '';
    setOrder({ items: [mkItem('FUR01', 1, 150017)], rawChatText: 'text đơn B' });

    const idB = await autoSaveNow();
    assert.ok(idB, 'auto-save phải lưu được đơn chưa có tên KH');

    const recs = readPending();
    assert.equal(recs.length, 2);
    const recB = recs.find(r => r.id === idB);
    assert.ok(recB, 'bản ghi B phải tồn tại');
    assert.equal(recB.form.customerName, '');
    assert.equal(recB.savedBy, 'auto');
  });

  it('re-parse CÙNG đơn (mất _pendingId) → dedup cập nhật bản ghi cũ', async () => {
    // Mô phỏng user bấm Phân tích lại cùng tin nhắn → đơn mới không có id
    setOrder({ items: [mkItem('FUR01', 1, 150017)], rawChatText: 'text đơn B' });
    await autoSaveNow();

    const recs = readPending();
    assert.equal(recs.length, 2, 'không được nhân bản khi re-parse cùng đơn');
    assert.equal(store.getState().currentOrder._pendingId, recs.find(r => r.order.rawChatText === 'text đơn B').id);
  });

  it('parse đơn KHÁC → tạo bản ghi mới, KHÔNG đè mất đơn cũ', async () => {
    // Regression bug mất đơn: merge spread giữ _pendingId cũ → record cũ bị đè
    setOrder({ customer: 'Khách C', items: [mkItem('IP01', 3, 90000)], rawChatText: 'text đơn C' });
    await autoSaveNow();

    const recs = readPending();
    assert.equal(recs.length, 3, 'đơn C phải là bản ghi RIÊNG');
    const rawTexts = recs.map(r => r.order.rawChatText).sort();
    assert.deepEqual(rawTexts, ['text đơn A', 'text đơn B', 'text đơn C'], 'cả 3 đơn đều còn nguyên');
  });

  it('lưu tay thiếu tên KH + đơn không có customer → từ chối', async () => {
    el('customerName').value = '';
    setOrder({ items: [mkItem('XX01', 1, 1)], rawChatText: 'text đơn D' });
    const before = readPending().length;

    const id = await saveCurrentOrder();
    assert.equal(id, null, 'không trả id khi thiếu tên KH');
    assert.equal(readPending().length, before, 'không tạo bản ghi mới');
  });

  it('markDone excel → vẫn ở chờ duyệt với excelDone=true', async () => {
    const recs = readPending();
    const idB = recs.find(r => r.order.rawChatText === 'text đơn B').id;

    await markDone(idB, 'excel');

    const after = readPending();
    const recB = after.find(r => r.id === idB);
    assert.ok(recB, 'B phải CÒN ở chờ duyệt sau khi chỉ xong Excel');
    assert.equal(recB.excelDone, true);
    assert.equal(recB.kvDone, false);
    assert.equal(readProcessed().length, 0, 'chưa chuyển sang Đã xử lý');
  });

  it('markDone kv (bước thứ 2) → vẫn ở chờ duyệt, chưa tự chuyển Đã xử lý', async () => {
    const idB = readPending().find(r => r.order.rawChatText === 'text đơn B').id;

    await markDone(idB, 'kv');

    const recs = readPending();
    assert.equal(recs.length, 3, 'đủ cả A, B và C vẫn ở chờ duyệt');
    const recB = recs.find(r => r.id === idB);
    assert.ok(recB, 'B vẫn tồn tại sau khi đánh dấu đủ hai bước');
    assert.equal(recB.excelDone, true);
    assert.equal(recB.kvDone, true);
    assert.equal(readProcessed().length, 0, 'chỉ nút Hoàn tất mới chuyển sang Đã xử lý');
  });

  it('auto-save sau khi đủ Excel + KV vẫn giữ nguyên đơn trong danh sách', async () => {
    el('customerName').value = 'Khách X';
    setOrder({ customer: 'Khách X', items: [mkItem('MC01', 5, 200000)], rawChatText: 'text đơn X' });
    const idX = await saveCurrentOrder();

    await markDone(idX, 'excel');
    await markDone(idX, 'kv');
    assert.equal(store.getState().currentOrder._pendingId, idX, 'đơn đang mở vẫn liên kết bản ghi');

    const pendingBefore = readPending().length;
    await autoSaveNow();
    assert.equal(readPending().length, pendingBefore, 'auto-save không nhân bản hoặc rút đơn');
    assert.ok(readPending().some(r => r.id === idX), 'đơn vẫn còn sau khi đủ hai bước');
    assert.equal(readProcessed().length, 0, 'không tự chuyển sang Đã xử lý');
  });

  it('sửa nội dung đơn đã xuất/lên KV sẽ reset cả hai cờ tiến độ', async () => {
    el('customerName').value = 'Khách Reset Cờ';
    setOrder({ customer: 'Khách Reset Cờ', items: [mkItem('RS01', 1, 10000)], rawChatText: 'trước khi sửa' });
    const id = await saveCurrentOrder();
    await markDone(id, 'excel');
    await markDone(id, 'kv');
    assert.deepEqual(
      [readPending().find(r => r.id === id).excelDone, readPending().find(r => r.id === id).kvDone],
      [true, true]
    );

    store.setState({
      currentOrder: {
        ...store.getState().currentOrder,
        items: [mkItem('RS01', 2, 10000)]
      }
    });
    await autoSaveNow();

    const updated = readPending().find(r => r.id === id);
    assert.equal(updated.excelDone, false, 'Excel cũ không còn áp dụng');
    assert.equal(updated.kvDone, false, 'KiotViet cũ không còn áp dụng');
  });

  it('markDone từ chối signature cũ sau khi record đã bị sửa lúc chạy', async () => {
    el('customerName').value = 'Khách Signature Race';
    setOrder({ customer: 'Khách Signature Race', items: [mkItem('SG01', 1, 10000)], rawChatText: 'signature cũ' });
    const id = await saveCurrentOrder();
    const staleSignature = readPending().find(r => r.id === id)._sig;

    store.setState({
      currentOrder: {
        ...store.getState().currentOrder,
        items: [mkItem('SG01', 3, 10000)]
      }
    });
    await autoSaveNow();

    const result = await markDone(id, 'excel', staleSignature);
    assert.deepEqual(result, { marked: false, reason: 'changed' });
    assert.equal(readPending().find(r => r.id === id).excelDone, false);
  });

  it('auto-save giữ chỉnh sửa FOC/Extra khi chỉ đổi loại quà', async () => {
    el('customerName').value = 'Khách sửa quà';
    setOrder({ customer: 'Khách sửa quà', items: [mkItem('GIFT01', 1, 0)], rawChatText: 'đơn sửa loại quà' });
    store.setState({ currentOrder: { ...store.getState().currentOrder, giftKindOverrides: { item_0: 'foc' } } });
    const id = await autoSaveNow();

    store.setState({ currentOrder: { ...store.getState().currentOrder, giftKindOverrides: { item_0: 'extra' } } });
    assert.equal(await autoSaveNow(), id);
    assert.deepEqual(readPending().find(r => r.id === id).order.giftKindOverrides, { item_0: 'extra' });
  });

  it('nút Hoàn tất rút đơn khỏi chờ duyệt và chuyển sang Đã xử lý', async () => {
    el('customerName').value = 'Khách Hoàn Tất';
    setOrder({ customer: 'Khách Hoàn Tất', items: [mkItem('OK01', 1, 10000)], rawChatText: 'đơn hoàn tất tay' });
    const id = await saveCurrentOrder();

    const completing = completePending(id);
    await confirmDialogButton('btn btn-primary btn-sm', completing);
    await completing;

    assert.ok(!readPending().some(r => r.id === id), 'đã rời danh sách chờ duyệt');
    assert.ok(readProcessed().some(r => r.id === id), 'đã vào lịch sử Đã xử lý');
  });

  it('bấm Lưu thủ công sau Hoàn tất vẫn không tạo lại đơn không đổi', async () => {
    el('customerName').value = 'Khách Hoàn Tất';
    el('orderText').value = 'nội dung đã hoàn tất';
    setOrder({ customer: 'Khách Hoàn Tất', items: [mkItem('OK01', 1, 10000)], rawChatText: 'nội dung đã hoàn tất' });
    const id = await saveCurrentOrder();
    const completing = completePending(id);
    await confirmDialogButton('btn btn-primary btn-sm', completing);
    await completing;

    const pendingBefore = readPending().length;
    assert.equal(await saveCurrentOrder(), null, 'Lưu thủ công phải bị chặn');
    assert.equal(readPending().length, pendingBefore, 'đơn đã hoàn tất không hồi sinh');
  });

  it('ghi lỗi tạm thời rollback memory để lần auto-save sau vẫn thử ghi lại', async () => {
    el('customerName').value = 'Khách Ghi Lại';
    setOrder({ customer: 'Khách Ghi Lại', items: [mkItem('RT01', 1, 10000)], rawChatText: 'đơn ghi lại' });
    const before = readPending();
    const originalSet = dbStore.set.bind(dbStore);
    let shouldFail = true;
    dbStore.set = async (key, value) => {
      if (key === STATE_KEY && shouldFail) {
        shouldFail = false;
        throw new Error('transient state write failure');
      }
      return originalSet(key, value);
    };

    try {
      assert.equal(await autoSaveNow(), null);
      assert.deepEqual(readPending(), before, 'lần lỗi không để record chỉ trong RAM');
      assert.equal(store.getState().currentOrder._pendingId, null, 'không để stale pending id');
      const id = await autoSaveNow();
      assert.ok(id, 'lần auto-save sau phải ghi lại thành công');
      assert.ok(readPending().some(r => r.id === id));
    } finally {
      dbStore.set = originalSet;
    }
  });

  it('ghi lỗi rollback sâu record đã tồn tại để auto-save sau ghi lại được', async () => {
    el('customerName').value = 'Khách Update Lỗi';
    el('orderText').value = 'bản đã lưu';
    setOrder({ customer: 'Khách Update Lỗi', items: [mkItem('UP01', 1, 10000)], rawChatText: 'bản đã lưu' });
    const id = await saveCurrentOrder();
    el('orderText').value = 'bản chưa lưu';

    const originalSet = dbStore.set.bind(dbStore);
    let shouldFail = true;
    dbStore.set = async (key, value) => {
      if (key === STATE_KEY && shouldFail) {
        shouldFail = false;
        throw new Error('update state write failure');
      }
      return originalSet(key, value);
    };
    try {
      assert.equal(await autoSaveNow(), null);
    } finally {
      dbStore.set = originalSet;
    }
    assert.equal(readPending().find(r => r.id === id).form.orderText, 'bản đã lưu', 'record cũ được rollback');

    assert.equal(await autoSaveNow(), id);
    assert.equal(readPending().find(r => r.id === id).form.orderText, 'bản chưa lưu');
  });

  it('auto-save chạy trong lúc Xóa không thể hồi sinh record', async () => {
    el('customerName').value = 'Khách Race Xóa';
    setOrder({ customer: 'Khách Race Xóa', items: [mkItem('RC01', 1, 10000)], rawChatText: 'đơn race xóa' });
    const id = await saveCurrentOrder();
    const originalSet = dbStore.set.bind(dbStore);
    let releaseWrite;
    let startedWrite;
    const writeStarted = new Promise(resolve => { startedWrite = resolve; });
    const writeGate = new Promise(resolve => { releaseWrite = resolve; });
    dbStore.set = async (key, value) => {
      if (key === STATE_KEY) {
        startedWrite();
        await writeGate;
      }
      return originalSet(key, value);
    };

    try {
      const deleting = deletePending(id);
      await confirmDialogButton('btn btn-danger btn-sm', deleting);
      await writeStarted;
      assert.equal(await autoSaveNow(), null, 'save chạy song song bị tombstone chặn');
      releaseWrite();
      await deleting;
    } finally {
      releaseWrite();
      dbStore.set = originalSet;
    }
    assert.ok(!readPending().some(r => r.id === id));
  });

  it('Xóa lỗi giữ nguyên record và liên kết đơn đang mở', async () => {
    el('customerName').value = 'Khách Xóa Lỗi';
    setOrder({ customer: 'Khách Xóa Lỗi', items: [mkItem('DE01', 1, 10000)], rawChatText: 'đơn xóa lỗi' });
    const id = await saveCurrentOrder();
    const originalSet = dbStore.set.bind(dbStore);
    dbStore.set = async (key, value) => {
      if (key === STATE_KEY) throw new Error('delete state write failure');
      return originalSet(key, value);
    };

    try {
      const deleting = deletePending(id);
      await confirmDialogButton('btn btn-danger btn-sm', deleting);
      await deleting;
    } finally {
      dbStore.set = originalSet;
    }
    assert.ok(readPending().some(r => r.id === id), 'đơn vẫn còn sau khi ghi xóa lỗi');
    assert.equal(store.getState().currentOrder._pendingId, id, 'editor vẫn liên kết record');
  });

  it('Hoàn tất rollback lịch sử và giữ pending nếu ghi danh sách lỗi', async () => {
    el('customerName').value = 'Khách Lỗi Lưu';
    setOrder({ customer: 'Khách Lỗi Lưu', items: [mkItem('ER01', 1, 30000)], rawChatText: 'đơn lỗi storage' });
    const id = await saveCurrentOrder();
    const originalSet = dbStore.set.bind(dbStore);
    dbStore.set = async (key, value) => {
      if (key === STATE_KEY) throw new Error('simulated pending storage failure');
      return originalSet(key, value);
    };

    try {
      const completing = completePending(id);
      await confirmDialogButton('btn btn-primary btn-sm', completing);
      await completing;
    } finally {
      dbStore.set = originalSet;
    }

    assert.ok(readPending().some(r => r.id === id), 'đơn phải còn trong Chờ duyệt');
    assert.ok(!readProcessed().some(r => r.id === id), 'không để lịch sử dang dở');
  });

  it('nút Xóa rút đúng record và không tự tạo lại từ nội dung đang mở', async () => {
    el('customerName').value = 'Khách Xóa';
    el('orderText').value = 'đơn xóa tay';
    setOrder({ customer: 'Khách Xóa', items: [mkItem('DL01', 1, 20000)], rawChatText: 'đơn xóa tay' });
    const id = await saveCurrentOrder();

    const realNow = Date.now;
    let fakeNow = realNow();
    Date.now = () => fakeNow;
    try {
      const deleting = deletePending(id);
      await confirmDialogButton('btn btn-danger btn-sm', deleting);
      await deleting;
      assert.ok(!readPending().some(r => r.id === id), 'record đã bị xóa');

      fakeNow += 20000;
      const pendingBefore = readPending().length;
      await autoSaveNow();
      assert.equal(readPending().length, pendingBefore, 'đơn vừa xóa không bị hồi sinh sau thời gian');

      el('orderText').value = 'đơn xóa tay - đã chỉnh sửa';
      const newId = await autoSaveNow();
      assert.ok(newId && newId !== id, 'nội dung thật sự đổi thì được lưu thành đơn mới');
      assert.equal(readPending().find(r => r.id === newId).form.orderText, 'đơn xóa tay - đã chỉnh sửa');
    } finally {
      Date.now = realNow;
    }
  });

  it('signature nhận mọi thay đổi form và order state được lưu', async () => {
    el('customerName').value = 'Khách Signature';
    el('orderText').value = 'text ban đầu';
    setOrder({ customer: 'Khách Signature', items: [mkItem('SG01', 1, 10000)], rawChatText: 'text ban đầu' });
    const id = await saveCurrentOrder();

    el('orderText').value = 'text đã sửa';
    assert.equal(await autoSaveNow(), id);
    assert.equal(readPending().find(r => r.id === id).form.orderText, 'text đã sửa');

    store.setState({
      currentOrder: {
        ...store.getState().currentOrder,
        customPromos: [{ type: 'gift', productId: 'promo-1', qty: 1 }],
        rowOrder: ['item_0']
      }
    });
    assert.equal(await autoSaveNow(), id);
    const saved = readPending().find(r => r.id === id).order;
    assert.deepEqual(saved.customPromos, [{ type: 'gift', productId: 'promo-1', qty: 1 }]);
    assert.deepEqual(saved.rowOrder, ['item_0']);
  });

  it('xóa bản ghi Đã xử lý → xóa NGAY không cần xác nhận', async () => {
    const hist = readProcessed();
    const idToDelete = hist[0].id;
    const before = hist.length;

    await deleteProcessed(idToDelete);

    const after = readProcessed();
    assert.equal(after.length, before - 1, 'record đã bị xóa khỏi lịch sử');
    assert.ok(!after.some(r => r.id === idToDelete), 'đúng record bị xóa');
  });

  it('auto-save lưu đơn CHƯA PARSE (paste mới, 0 SP) thành bản nháp + không nhân bản khi gõ tiếp', async () => {
    el('customerName').value = '';
    setOrder({ items: [], rawChatText: 'text nháp X\nSP A x 2' });

    const id = await autoSaveNow();
    assert.ok(id, 'nháp text chưa parse phải được lưu');

    const draftRecs = () => readPending().filter(r => !r.order.items.length);
    assert.equal(draftRecs().length, 1, 'chỉ 1 bản nháp');
    assert.equal(draftRecs()[0].id, id);
    assert.equal(draftRecs()[0].order.rawChatText, 'text nháp X\nSP A x 2', 'giữ nguyên raw text');

    // Gõ tiếp lên CÙNG nháp (rescan giữ _pendingId) → cập nhật record cũ
    const cur = store.getState().currentOrder;
    store.setState({ currentOrder: { ...cur, rawChatText: 'text nháp X\nSP A x 3' } });
    assert.equal(await autoSaveNow(), id);
    assert.equal(draftRecs().length, 1, 'không nhân bản nháp khi gõ tiếp');
    assert.equal(draftRecs()[0].order.rawChatText, 'text nháp X\nSP A x 3');
  });

  it('đơn đã lưu vẫn mở lại được sau khi renderer/module khởi động lại', async () => {
    el('customerName').value = 'Khách Khởi Động Lại';
    el('orderText').value = 'tin nhắn còn nguyên';
    setOrder({
      customer: 'Khách Khởi Động Lại',
      items: [mkItem('RS01', 2, 75017)],
      rawChatText: 'tin nhắn còn nguyên'
    });
    const id = await saveCurrentOrder();

    el('customerName').value = '';
    el('orderText').value = '';
    setOrder({ items: [], rawChatText: '' });

    const restarted = await import(`../src/order/pending.js?restart=${Date.now()}`);
    await restarted.loadPending(id);

    assert.equal(store.getState().currentOrder._pendingId, id, 'nạp đúng bản ghi đã lưu');
    assert.equal(store.getState().currentOrder.items[0].product.kvCode, 'RS01');
    assert.equal(el('customerName').value, 'Khách Khởi Động Lại');
    assert.equal(el('orderText').value, 'tin nhắn còn nguyên');
  });

  it('lỗi đọc storage chặn ghi để không đè mất danh sách đã lưu', async () => {
    el('customerName').value = 'Khách Storage Lỗi';
    setOrder({ customer: 'Khách Storage Lỗi', items: [mkItem('ST01', 1, 10000)], rawChatText: 'đơn storage lỗi' });
    await autoSaveNow();
    const before = readPending();

    const originalGet = dbStore.get.bind(dbStore);
    dbStore.get = async (key) => {
      if (key === STATE_KEY) throw new Error('simulated pending read failure');
      return originalGet(key);
    };
    try {
      const restarted = await import(`../src/order/pending.js?loadfail=${Date.now()}`);
      el('customerName').value = 'Khách Mới Khi Storage Lỗi';
      setOrder({ customer: 'Khách Mới Khi Storage Lỗi', items: [mkItem('ST02', 1, 20000)], rawChatText: 'đơn mới bị chặn' });
      assert.equal(await restarted.autoSaveNow(), null);
      assert.deepEqual(readPending(), before, 'dữ liệu cũ phải giữ nguyên');
    } finally {
      dbStore.get = originalGet;
    }
  });

  it('lưu TAY không tạo bản nháp đơn 0 SP dù có text', async () => {
    setOrder({ items: [], rawChatText: 'text nháp Y' });
    const before = readPending().length;

    const id = await saveCurrentOrder();
    assert.equal(id, null, 'bấm tay vẫn yêu cầu có sản phẩm');
    assert.equal(readPending().length, before, 'không tạo record');
  });
});

describe('PendingOrders — mở lại đơn ĐÃ XỬ LÝ (reopenProcessed)', () => {
  it('hoàn tất xong → bản ghi lịch sử giữ đủ dữ liệu đơn để mở lại được', async () => {
    el('customerName').value = 'Khách Mở Lại';
    setOrder({ customer: 'Khách Mở Lại', items: [mkItem('RL01', 2, 30000)], rawChatText: 'text đơn mở lại' });
    const id = await saveCurrentOrder();
    await markDone(id, 'excel');
    await markDone(id, 'kv');
    const completing = completePending(id);
    await confirmDialogButton('btn btn-primary btn-sm', completing);
    await completing;

    const histRec = readProcessed().find(r => r.id === id);
    assert.ok(histRec, 'đơn đã vào lịch sử Đã xử lý');
    assert.ok(histRec.order && Array.isArray(histRec.order.items) && histRec.order.items.length === 1,
      'bản ghi lịch sử phải giữ nguyên dữ liệu đơn (order.items)');
  });

  it('reopenProcessed → đơn quay về chờ duyệt (reset Excel/KV) + nạp lên màn hình', async () => {
    const id = readProcessed()[0].id;

    // Dọn màn hình trống để không kích hoạt confirm thay thế đơn đang soạn
    el('customerName').value = '';
    el('orderText').value = '';
    setOrder({ items: [], rawChatText: '' });

    const pendingBefore = readPending().length;
    const processedBefore = readProcessed().length;
    await reopenProcessed(id);

    const recs = readPending();
    const rec = recs.find(r => r.id === id);
    assert.ok(rec, 'bản ghi quay lại danh sách chờ duyệt');
    assert.equal(rec.excelDone, false, 'reset excelDone');
    assert.equal(rec.kvDone, false, 'reset kvDone');
    assert.equal(rec.savedBy, 'reopened');
    assert.equal(recs.length, pendingBefore + 1, 'chờ duyệt tăng 1');
    assert.equal(readProcessed().length, processedBefore - 1, 'lịch sử giảm 1');

    assert.equal(store.getState().currentOrder._pendingId, id, 'màn hình liên kết đúng bản ghi');
    assert.equal(el('customerName').value, 'Khách Mở Lại', 'form được điền lại từ bản ghi');
  });

  it('hoàn tất lại đơn mở lại → trở về lịch sử, KHÔNG nhân bản bản ghi', async () => {
    const id = readPending().find(r => r.savedBy === 'reopened').id;

    await markDone(id, 'excel');
    assert.ok(readPending().some(r => r.id === id), 'còn ở chờ duyệt khi mới xong Excel');

    await markDone(id, 'kv');
    assert.ok(readPending().some(r => r.id === id), 'đủ hai bước vẫn còn ở chờ duyệt');

    const completing = completePending(id);
    await confirmDialogButton('btn btn-primary btn-sm', completing);
    await completing;
    assert.ok(!readPending().some(r => r.id === id), 'bấm Hoàn tất mới rời chờ duyệt');
    const hist = readProcessed();
    assert.equal(hist.filter(r => r.id === id).length, 1, 'đúng 1 bản ghi trong lịch sử (không dup)');
    assert.deepEqual(hist.find(r => r.id === id).sources.sort(), ['excel', 'kv', 'manual']);
  });
});

describe('PendingOrders — envelope lỗi', () => {
  it('envelope v2 hỏng bị chặn ghi, không bị legacy data ghi đè', async () => {
    const invalidState = { version: 2, orders: 'not-an-array', processed: [] };
    localStorage.setItem(STATE_KEY, JSON.stringify(invalidState));
    const guarded = await import(`../src/order/pending.js?invalid=${Date.now()}`);
    el('customerName').value = 'Khách Envelope Lỗi';
    setOrder({ customer: 'Khách Envelope Lỗi', items: [mkItem('IV01', 1, 10000)], rawChatText: 'đơn envelope lỗi' });
    assert.equal(await guarded.autoSaveNow(), null);
    assert.deepEqual(JSON.parse(localStorage.getItem(STATE_KEY)), invalidState, 'envelope hỏng được giữ nguyên');
  });
});

describe('PendingOrders — thao tác trực tiếp từ card', () => {
  function findActionButton(id, source) {
    return findFakeNode(
      document.body,
      node => node.dataset?.pendingId === id && node.dataset?.pendingSource === source
    );
  }

  it('bấm Xuất Excel truyền đúng snapshot và không sửa đơn đang mở', async () => {
    el('customerName').value = 'Khách Card Excel';
    setOrder({ customer: 'Khách Card Excel', items: [mkItem('CD01', 2, 20000)], rawChatText: 'đơn card excel' });
    const id = await saveCurrentOrder();
    const currentBefore = JSON.stringify(store.getState().currentOrder);
    let received = null;

    initPendingOrders({
      exportPending: async (snapshot) => { received = snapshot; },
      openKiotViet: async () => true
    });
    renderListModal();
    const button = findActionButton(id, 'excel');
    assert.ok(button, 'card phải có nút Xuất Excel');
    assert.equal(button.disabled, false);
    assert.match(button.textContent, /Xuất Excel/);

    await button.onclick();

    assert.ok(received, 'callback Excel phải được gọi');
    assert.equal(received.pendingId, id);
    assert.equal(received.expectedSignature, readPending().find(r => r.id === id)._sig);
    assert.equal(received.form.customerName, 'Khách Card Excel');
    assert.equal(received.order.rawChatText, 'đơn card excel');
    assert.equal(JSON.stringify(store.getState().currentOrder), currentBefore, 'đơn đang mở không bị thay');
    assert.ok(findFakeNode(document.body, node => node.id === 'pendingListOverlay'), 'list mở lại sau flow');
  });

  it('chip đã xanh bị disable và không chạy lại', async () => {
    el('customerName').value = 'Khách Đã Excel';
    setOrder({ customer: 'Khách Đã Excel', items: [mkItem('DN01', 1, 10000)], rawChatText: 'đơn đã excel' });
    const id = await saveCurrentOrder();
    await markDone(id, 'excel');
    let calls = 0;
    initPendingOrders({ exportPending: async () => { calls++; } });
    renderListModal();

    const button = findActionButton(id, 'excel');
    assert.equal(button.disabled, true);
    assert.equal(button.textContent, 'Đã xuất Excel');
    assert.equal(button.onclick, null, 'nút hoàn tất không có handler chạy lại');
    assert.equal(calls, 0);
  });

  it('bấm KiotViet giữ modal mở đến khi đóng, không nạp đơn lên editor', async () => {
    el('customerName').value = 'Khách Card KV';
    setOrder({ customer: 'Khách Card KV', items: [mkItem('CK01', 1, 30000)], rawChatText: 'đơn card kv' });
    const id = await saveCurrentOrder();
    const currentBefore = JSON.stringify(store.getState().currentOrder);
    let received = null;
    let modalOptions = null;
    initPendingOrders({
      openKiotViet: async (snapshot, options) => {
        received = snapshot;
        modalOptions = options;
        return true;
      }
    });
    renderListModal();

    const button = findActionButton(id, 'kv');
    assert.ok(button);
    await button.onclick();

    assert.equal(received.pendingId, id);
    assert.equal(received.form.customerName, 'Khách Card KV');
    assert.equal(JSON.stringify(store.getState().currentOrder), currentBefore);
    assert.equal(findFakeNode(document.body, node => node.id === 'pendingListOverlay'), null, 'đóng list trước khi mở KV modal');

    modalOptions.onClose();
    assert.ok(findFakeNode(document.body, node => node.id === 'pendingListOverlay'), 'đóng KV modal thì mở lại list');
  });
  it('double-click nút KiotViet chỉ mở một modal', async () => {
    el('customerName').value = 'Khách Double KV';
    setOrder({ customer: 'Khách Double KV', items: [mkItem('DK01', 1, 30000)], rawChatText: 'đơn double kv' });
    const id = await saveCurrentOrder();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let calls = 0;
    let modalOptions = null;
    initPendingOrders({
      openKiotViet: async (snapshot, options) => {
        calls++;
        modalOptions = options;
        await gate;
        return true;
      }
    });
    renderListModal();

    const button = findActionButton(id, 'kv');
    const firstClick = button.onclick();
    await Promise.resolve();
    const secondClick = button.onclick();
    assert.equal(calls, 1, 'click lần hai không mở modal thứ hai');

    release();
    await Promise.all([firstClick, secondClick]);
    modalOptions.onClose();
    assert.equal(calls, 1);
  });
});

describe('PendingOrders — migration dữ liệu cũ', () => {
  it('migrate legacy key + tính lại signature để Xóa không hồi sinh', async () => {
    localStorage.removeItem(STATE_KEY);
    localStorage.setItem(LEGACY_PENDING_KEY, JSON.stringify([{
      id: 'po_legacy_signature',
      savedAt: new Date().toISOString(),
      order: {
        customer: 'Khách Legacy',
        payment: 'ck',
        rawChatText: 'tin nhắn legacy',
        items: [mkItem('LG01', 1, 10000)],
        customPromos: []
      },
      form: {
        customerName: 'Khách Legacy',
        payment: 'ck',
        note: '',
        sellerKey: '',
        orderText: 'tin nhắn legacy'
      },
      summary: { itemCount: 1, boxes: 0, total: 10000 },
      excelDone: false,
      kvDone: false,
      _sig: 'legacy-partial-signature'
    }]));

    const migrated = await import(`../src/order/pending.js?legacy=${Date.now()}`);
    el('customerName').value = '';
    el('orderText').value = '';
    setOrder({ items: [], rawChatText: '' });
    await migrated.loadPending('po_legacy_signature');
    assert.ok(readPending().some(r => r.id === 'po_legacy_signature'), 'legacy record đã migrate');
    assert.equal(localStorage.getItem(LEGACY_PENDING_KEY), null, 'legacy key đã được retire');

    const deleting = migrated.deletePending('po_legacy_signature');
    await confirmDialogButton('btn btn-danger btn-sm', deleting);
    await deleting;
    assert.ok(!readPending().some(r => r.id === 'po_legacy_signature'));

    await migrated.autoSaveNow();
    assert.ok(!readPending().some(r => r.id === 'po_legacy_signature'), 'signature mới không bị legacy _sig làm hồi sinh');
  });
});

/**
 * Tests cho db-store — tầng lưu trữ IndexedDB/localStorage dùng chung bởi
 * DB danh mục và ĐƠN CHỜ DUYỆT (pending orders).
 *
 * Regression cốt lõi (BUG mất đơn chờ duyệt): db.init() chạy NỀN không block
 * → nếu get/set/remove KHÔNG chờ backend sẵn sàng, thao tác ghi khi IndexedDB
 * đang mở sẽ rơi vào localStorage RỖNG → persist sau đó ĐÈ MẤT dữ liệu thật.
 * Run: node --test test/db-store.test.mjs
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// --- Stub môi trường trình duyệt TRƯỚC khi import module -------------------
// localStorage trong bộ nhớ + window.indexedDB thay đổi theo từng test.
const memStorage = new Map();
globalThis.localStorage = {
  getItem: (k) => (memStorage.has(k) ? memStorage.get(k) : null),
  setItem: (k, v) => memStorage.set(k, String(v)),
  removeItem: (k) => memStorage.delete(k),
};
globalThis.window = { indexedDB: undefined };

const { IndexedDBStore } = await import('../db-store.js');

/** Request IDB giả: callback onsuccess/onerror gán sau, fire bằng setTimeout. */
function mkReq() {
  return { onupgradeneeded: null, onsuccess: null, onerror: null, result: undefined };
}

/**
 * IndexedDB giả với open() TRẢ SAU `delayMs` (mô phỏng máy chậm / antivirus
 * scan khi khởi động app). Dữ liệu nằm trong Map nội bộ để kiểm chứng bản ghi
 * đã thực sự xuống "IndexedDB" hay bị ghi nhầm vào localStorage.
 */
function makeSlowIDB(delayMs) {
  const data = new Map();
  let openedOnce = false;
  return {
    __data: data,
    open(name, version) {
      const req = mkReq();
      setTimeout(() => {
        const db = {
          objectStoreNames: { contains: () => true },
          transaction(_stores, _mode) {
            const txnStore = {
              get(k) {
                const r = mkReq();
                setTimeout(() => {
                  r.result = data.has(k) ? data.get(k) : undefined;
                  r.onsuccess && r.onsuccess({ target: r });
                }, 0);
                return r;
              },
              put(v, k) {
                const r = mkReq();
                setTimeout(() => {
                  data.set(k, v);
                  r.onsuccess && r.onsuccess({ target: r });
                }, 0);
                return r;
              },
              delete(k) {
                const r = mkReq();
                setTimeout(() => {
                  data.delete(k);
                  r.onsuccess && r.onsuccess({ target: r });
                }, 0);
                return r;
              },
            };
            return { objectStore: () => txnStore };
          },
        };
        if (!openedOnce) {
          openedOnce = true;
          req.onupgradeneeded && req.onupgradeneeded({ target: { result: db } });
        }
        req.result = db;
        req.onsuccess && req.onsuccess({ target: req });
      }, delayMs);
      return req;
    },
  };
}

beforeEach(() => {
  memStorage.clear();
});

describe('IndexedDBStore — idempotent init/ready', () => {
  it('ready() gọi nhiều lần trả CÙNG promise (không mở DB lại)', async () => {
    globalThis.window.indexedDB = makeSlowIDB(5);
    const s = new IndexedDBStore();
    const p1 = s.ready();
    const p2 = s.ready();
    const p3 = s.init(); // init cũng phải idempotent như ready
    assert.equal(p1, p2);
    assert.equal(p1, p3);
    await p1;
  });

  it('ready() resolve dù indexedDB không tồn tại (chuyển fallback)', async () => {
    globalThis.window.indexedDB = undefined;
    const s = new IndexedDBStore();
    await s.ready();
    assert.equal(s.useFallback, true);
  });
});

describe('IndexedDBStore — REGRESSION race khởi động (mất đơn chờ duyệt)', () => {
  it('set() NGAY khi mở app (IDB còn đang mở chậm) phải ghi xuông INDEXEDDB, KHÔNG rơi vào localStorage', async () => {
    const idb = makeSlowIDB(40); // mở "chậm" 40ms — giống db.init chạy nền
    globalThis.window.indexedDB = idb;
    const s = new IndexedDBStore();

    // KHÔNG await init — đúng bối cảnh thật: user lưu đơn trước khi IDB mở xong
    await s.set('order_automation_pending_orders_v1', [{ id: 'po_1' }]);

    // Bản ghi phải nằm trong IndexedDB...
    assert.equal(idb.__data.has('order_automation_pending_orders_v1'), true);
    // ...và KHÔNG được ghi nhầm vào localStorage fallback
    assert.equal(memStorage.has('order_automation_pending_orders_v1'), false);
  });

  it('get() NGAY khi mở app vẫn đọc được dữ liệu đã lưu trên IndexedDB', async () => {
    const idb = makeSlowIDB(30);
    idb.__data.set('k1', { hello: 'world' });
    globalThis.window.indexedDB = idb;
    const s = new IndexedDBStore();

    const val = await s.get('k1'); // không await init trước — phải tự chờ ready
    assert.deepEqual(val, { hello: 'world' });
  });

  it('chu kỳ set → get → remove qua IndexedDB giữ nguyên dữ liệu', async () => {
    globalThis.window.indexedDB = makeSlowIDB(10);
    const s = new IndexedDBStore();
    const payload = [{ id: 'po_a', order: { items: [1] } }, { id: 'po_b' }];

    await s.set('pk', payload);
    assert.deepEqual(await s.get('pk'), payload);

    await s.remove('pk');
    assert.equal(await s.get('pk'), null);
  });
});

describe('IndexedDBStore — fallback localStorage', () => {
  it('roundtrip set/get/remove khi không có indexedDB', async () => {
    globalThis.window.indexedDB = undefined;
    const s = new IndexedDBStore();
    await s.set('fk', { a: 1, b: [2, 3] });
    assert.deepEqual(await s.get('fk'), { a: 1, b: [2, 3] });

    await s.remove('fk');
    assert.equal(await s.get('fk'), null);
  });
});

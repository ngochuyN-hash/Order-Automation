/**
 * Tests cho bộ đếm số PO (STT đơn theo brand/tháng) — src/seller/manager.js.
 *
 * BẤT BIẾN cần bảo vệ: bộ đếm CHỈ được tăng sau khi đơn xuất Excel THÀNH CÔNG.
 * 1. Sinh tiêu đề (preview/dryRun) KHÔNG được tăng bộ đếm — gọi bao nhiêu lần
 *    cũng cùng 1 số kế tiếp.
 * 2. commitOrderSequence() mới là bước tăng — gọi đúng 1 lần sau khi ghi file
 *    thành công, STT kế tiếp nhảy đúng +1.
 * 3. Xuất LỖI (không commit) rồi xuất lại → dùng lại ĐÚNG số cũ, không phát
 *    sinh khoảng trống STT.
 * 4. commit không bao giờ LÙI bộ đếm (guard seq > current) — không ghi đè STT
 *    mới hơn khi user đã đặt lại STT trong Settings.
 *
 * Run: node --test test/order-title-sequence.test.mjs
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// --- Stub môi trường trình duyệt TRƯỚC khi import module -------------------
const memStorage = new Map();
globalThis.localStorage = {
  getItem: (k) => (memStorage.has(k) ? memStorage.get(k) : null),
  setItem: (k, v) => memStorage.set(k, String(v)),
  removeItem: (k) => memStorage.delete(k),
};

// Timer không giữ process sống (toast auto-dismiss của ui-renderer)
const _origSetTimeout = globalThis.setTimeout;
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
    value: '', textContent: '', innerHTML: '', className: '',
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
  getElementById: (id) => (elements[id] || (elements[id] = mkEl())),
  createElement: () => mkEl(),
  addEventListener() {}
};
global.window = { addEventListener() {} };

const { generateOrderTitle, peekOrderSequence, commitOrderSequence, resolveSellerReceiver } = await import('../src/seller/manager.js');

const now = new Date();
const yy = String(now.getFullYear()).slice(-2);
const mm = String(now.getMonth() + 1).padStart(2, '0');
// Prefix mặc định của zentor theo DEFAULT_BRAND_PREFIXES
const SEQ_KEY = `orderSeq_ZNTSG_${yy}${mm}`;
const readCounter = () => localStorage.getItem(SEQ_KEY) ?? null;

describe('OrderTitleSequence — bộ đếm PO chỉ tăng khi xuất Excel thành công', () => {
  beforeEach(() => memStorage.clear());

  it('sinh tiêu đề KHÔNG tăng bộ đếm — gọi nhiều lần vẫn cùng 1 số kế tiếp', () => {
    const t1 = generateOrderTitle('zentor', 'Nguyễn Văn B', 'CH-3%');
    const t2 = generateOrderTitle('zentor', 'Nguyễn Văn B', 'CH-3%');
    const t3 = generateOrderTitle('zentor', '', '');

    assert.equal(t1, t2, 'hai lần gọi liên tiếp phải ra cùng tiêu đề');
    assert.ok(t1.includes(`ZNTSG${yy}${mm}-01`), `lượt đầu phải mang STT 01: ${t1}`);
    assert.equal(t3.split('-')[1], '01', 'số trong tiêu đề vẫn là 01 (chưa ai commit)');
    assert.equal(readCounter(), null, 'localStorage KHÔNG được ghi khi chỉ sinh tiêu đề');
  });

  it('commit sau khi xuất thành công mới tăng bộ đếm — lượt kế tiếp dùng số mới', () => {
    // Mô phỏng GUI: peek → dựng tiêu đề → IPC thành công → commit
    const seq = peekOrderSequence('zentor');
    const title = generateOrderTitle('zentor', 'Nguyễn Văn B', 'CH-3%', seq);
    assert.equal(seq, 1);
    assert.ok(title.includes('-01-'), `tiêu đề phải chứa STT 01: ${title}`);
    assert.equal(readCounter(), null, 'trước commit bộ đếm vẫn chưa được ghi');

    commitOrderSequence('zentor', seq);
    assert.equal(readCounter(), '1', 'commit phải ghi bộ đếm = 1');
    assert.equal(peekOrderSequence('zentor'), 2, 'lượt kế tiếp phải là 02');
  });

  it('xuất LỖI không commit → xuất lại dùng lại đúng số cũ (không vỡ số)', () => {
    // Đơn đầu tiên xuất thành công → bộ đếm = 1
    commitOrderSequence('zentor', peekOrderSequence('zentor'));
    assert.equal(readCounter(), '1');

    // Đơn thứ 2: peek số 02, IPC export trả lỗi → KHÔNG commit
    const seq = peekOrderSequence('zentor');
    assert.equal(seq, 2);
    const title = generateOrderTitle('zentor', 'Nguyễn Văn B', 'CH-3%', seq);
    assert.ok(title.includes('-02-'), `tiêu đề bị lỗi phải mang STT 02: ${title}`);
    assert.equal(readCounter(), '1', 'bộ đếm không được nhảy khi export lỗi');

    // Sale sửa xong xuất lại → vẫn đúng số 02
    const seqRetry = peekOrderSequence('zentor');
    assert.equal(seqRetry, 2, 'xuất lại phải dùng lại đúng số cũ');
    const titleRetry = generateOrderTitle('zentor', 'Nguyễn Văn B', 'CH-3%', seqRetry);
    assert.ok(titleRetry.includes('-02-'), `tiêu đề xuất lại phải mang STT 02: ${titleRetry}`);

    commitOrderSequence('zentor', seqRetry);
    assert.equal(readCounter(), '2');
    assert.equal(peekOrderSequence('zentor'), 3, 'đơn sau lỗi phải là 03 — không có khoảng trống STT');
  });

  it('commit không bao giờ lùi bộ đếm (guard seq > current)', () => {
    // User đã đặt lại STT = 10 trong Settings (setBrandSequence ghi thẳng localStorage)
    localStorage.setItem(SEQ_KEY, '10');

    commitOrderSequence('zentor', 3); // STT cũ đang treo — KHÔNG được ghi đè
    assert.equal(readCounter(), '10', 'commit số nhỏ hơn hiện tại phải bị bỏ qua');

    commitOrderSequence('zentor', 10); // bằng hiện tại → không đổi
    assert.equal(readCounter(), '10');

    commitOrderSequence('zentor', 11); // lớn hơn → ghi
    assert.equal(readCounter(), '11');
    assert.equal(peekOrderSequence('zentor'), 12);
  });
});
describe('resolveSellerReceiver — sellerKey → "Người nhận đặt" (1 nơi cho GUI lẫn headless)', () => {
  it('sellerKey rỗng → rỗng, không sinh người nhận oan', () => {
    assert.equal(resolveSellerReceiver(''), '');
    assert.equal(resolveSellerReceiver(null), '');
  });

  it('bỏ hậu tố ||| / chiết khấu / (…) — không lộ key của combobox ra payload KV', () => {
    const r = resolveSellerReceiver('Nguyễn Văn B|||CH-3%');
    assert.equal(typeof r, 'string');
    assert.ok(!r.includes('|||'), `không được lộ separator ||| :: ${r}`);
    assert.ok(!r.includes('CH-3%'), `không được lộ hậu tố chiết khấu :: ${r}`);
    assert.ok(!r.includes('('), `không được lộ "(...)" :: ${r}`);
  });

  it('không khớp seller nào → giữ nguyên tên đã trim (đơn vị gọi tự quyết định)', () => {
    assert.equal(resolveSellerReceiver('  Tên lạ không có trong danh sách  '), 'Tên lạ không có trong danh sách');
  });
});

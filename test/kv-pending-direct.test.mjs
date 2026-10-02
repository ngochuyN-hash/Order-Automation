/**
 * Regression cho luồng KiotViet mở trực tiếp từ Đơn Chờ Duyệt:
 * snapshot A phải được preview + submit, không đọc đơn B đang mở; context
 * pending đi qua terminal event đúng run và chỉ quay lại list sau khi modal đóng.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTOMATION_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'kiotviet', 'automation.js'),
  'utf8'
);

function mkElement(extra = {}) {
  return {
    value: '',
    textContent: '',
    innerHTML: '',
    checked: false,
    disabled: false,
    style: {},
    options: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    ...extra
  };
}

function loadAutomation() {
  const elements = new Map([
    ['modalKiotViet', mkElement()],
    ['kvPreviewCustomer', mkElement()],
    ['kvPreviewPayment', mkElement()],
    ['kvPreviewItems', mkElement()],
    ['kvAiProviderSelect', mkElement({ value: 'lmstudio', options: [{ value: 'lmstudio' }] })]
  ]);
  const handlers = {};
  const calls = { runs: [], marked: [], logs: [] };
  let liveOrder = {
    customer: 'KHÁCH B',
    payment: 'cod',
    items: [{ rawName: 'SP B', qty: 9 }]
  };
  const forbiddenFormIds = new Set(['customerName', 'paymentMethod', 'orderNote', 'sellerName', 'sellerSearch']);
  const context = {
    store: { getState: () => ({ currentOrder: liveOrder }) },
    uiRenderer: {
      getOrderTableRows(order) {
        order.rowOrder = ['item_0'];
        if (order.items?.[0]) order.items[0].subtotal = 777777;
        return {
          rows: [{
            type: 'matched',
            product: {
              id: 'P1',
              name: 'Dầu A',
              campaignKey: 'xvil',
              kvCode: 'KV-A'
            },
            productId: 'P1',
            productName: 'Dầu A',
            qty: 2,
            unit: 'thùng',
            subtotal: 200000,
            bottlePrice: 130017,
            isGift: false
          }]
        };
      }
    },
    db: {
      getAllProducts: () => [],
      getAliases: () => ({}),
      findProductById: () => null,
      getKvCode: product => product?.kvCode || ''
    },
    document: {
      getElementById(id) {
        if (forbiddenFormIds.has(id)) throw new Error(`Direct KV snapshot must not read DOM #${id}`);
        return elements.get(id) || null;
      }
    },
    escapeHtml: value => String(value ?? ''),
    showToast: (message, type) => calls.logs.push({ message, type }),
    formatCurrency: value => String(value),
    setProgressbarAria: () => {},
    aiService: { getProfiles: async () => ({ profiles: [], activeId: '' }) },
    AI_PROVIDERS: {},
    resolveEndpoint: value => value,
    findBestProductMatch: () => null,
    // Double của resolveSellerReceiver (src/seller/manager.js) — automation.js
    // giờ chỉ import đúng một hàm này (trước đây là getSellers/findSellerByKey).
    // Seller key rỗng → "Người nhận đặt" rỗng; "Sales s1" → kvName "Hà KV".
    resolveSellerReceiver(rawKey) {
      const raw = String(rawKey || '').trim();
      if (!raw) return '';
      const matched = [{ id: 's1', name: 'Hà', kvName: 'Hà KV' }]
        .find(s => `Sales ${s.id}` === raw);
      return matched ? (matched.kvName || matched.name) : raw;
    },
    trapFocus: () => ({ release() {} }),
    async markDone(id, source, expectedSignature) {
      calls.marked.push({ id, source, expectedSignature });
      return { marked: true };
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    window: {
      electronAPI: {
        browserAgent: {
          status: async () => ({ connected: true, running: false }),
          snapshot: async () => ({ success: true }),
          runOrder: async (orderData, options) => {
            calls.runs.push({ orderData, options });
            return { success: true };
          },
          on(event, handler) { handlers[event] = handler; }
        }
      }
    },
    setTimeout,
    clearTimeout,
    Date,
    console
  };

  const stripped = AUTOMATION_SRC
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];.*$/gm, '')
    .replace('export const KiotVietAutomation =', 'globalThis.KiotVietAutomation =')
    .replace(/^export\s+/gm, '');
  const vmContext = vm.createContext(context);
  vm.runInContext(stripped, vmContext, { filename: 'automation.js' });
  const kv = vmContext.KiotVietAutomation;
  kv.syncAiProvider = async () => {};
  kv._resolveKvAiConfig = async () => null;
  kv.updateStepProgress = () => {};
  kv.updateRunningState = () => {};
  kv.updateConnectionState = () => {};
  kv.appendLog = entry => calls.logs.push(entry);
  kv.init();

  return {
    kv,
    elements,
    handlers,
    calls,
    setLiveOrder(order) { liveOrder = order; }
  };
}

function snapshot(id = 'po_A') {
  return {
    pendingId: id,
    expectedSignature: `sig_${id}`,
    order: {
      customer: 'Khách A',
      payment: 'ck',
      rawChatText: 'Khách A\nDầu A x 2 thùng',
      items: [{ rawName: 'Dầu A', qty: 2, unit: 'thùng' }]
    },
    form: {
      customerName: 'Khách A',
      payment: 'ck',
      note: 'giao trước 10h',
      sellerKey: 'Sales s1',
      orderText: 'Khách A\nDầu A x 2 thùng'
    }
  };
}

describe('KiotViet direct pending flow', () => {
  it('buildOrderData dùng snapshot A, không mutate và không đọc form live', () => {
    const harness = loadAutomation();
    const source = snapshot().order;
    const before = JSON.stringify(source);
    const data = harness.kv.buildOrderData(snapshot());

    assert.equal(data.customer, 'Khách A');
    assert.equal(data.payment, 'ck');
    assert.equal(data.note, 'giao trước 10h');
    assert.equal(data.receiver, 'Hà KV');
    assert.equal(data.items[0].code, 'KV-A');
    assert.equal(JSON.stringify(source), before);
  });

  it('từ chối snapshot không clone được thay vì fallback sang object có thể mutate', () => {
    const harness = loadAutomation();
    const circular = { customer: 'Khách A', items: [] };
    circular.self = circular;
    assert.equal(harness.kv.buildOrderData({
      order: circular,
      form: { customerName: 'Khách A', payment: 'ck', note: '', sellerKey: '', orderText: '' }
    }), null);
    assert.equal(circular.self, circular, 'object nguồn không bị thay đổi');
  });

  it('preview + start dùng cùng snapshot, chặn double-start và chỉ mark đúng run', async () => {
    const harness = loadAutomation();
    const closeReasons = [];
    const opened = await harness.kv.openPanelForOrder(snapshot(), {
      onClose: detail => closeReasons.push(detail.reason)
    });
    assert.equal(opened, true);
    assert.equal(harness.elements.get('kvPreviewCustomer').textContent, 'Khách A');

    harness.setLiveOrder({ customer: 'Khách B', items: [{ rawName: 'SP B', qty: 9 }] });
    const first = harness.kv.startOrder();
    const second = harness.kv.startOrder();
    await Promise.all([first, second]);

    assert.equal(harness.calls.runs.length, 1, 'double-click chỉ start một run');
    assert.equal(harness.calls.runs[0].orderData.customer, 'Khách A');
    const runId = harness.calls.runs[0].options.runId;
    assert.ok(runId);

    harness.handlers['browser-agent:completed']({
      runId,
      steps: 4,
      summary: 'ok',
      orderCode: 'DH123456',
      verifyBlocked: false
    });
    await Promise.resolve();
    assert.deepEqual(harness.calls.marked, [
      { id: 'po_A', source: 'kv', expectedSignature: 'sig_po_A' }
    ]);
    assert.deepEqual(closeReasons, [], 'chưa mở list khi modal KV còn mở');

    harness.kv.closePanel();
    assert.deepEqual(closeReasons, ['completed']);
    assert.equal(harness.elements.get('modalKiotViet').style.display, 'none');
  });

  it('verifyBlocked không bật cờ KV nhưng vẫn quay list sau khi đóng modal', async () => {
    const harness = loadAutomation();
    const closeReasons = [];
    await harness.kv.openPanelForOrder(snapshot('po_blocked'), {
      onClose: detail => closeReasons.push(detail.reason)
    });
    await harness.kv.startOrder();
    const runId = harness.calls.runs[0].options.runId;

    harness.handlers['browser-agent:completed']({
      runId,
      steps: 4,
      summary: 'verify lệch',
      verifyBlocked: true
    });
    await Promise.resolve();
    assert.equal(harness.calls.marked.length, 0);

    harness.kv.closePanel();
    assert.deepEqual(closeReasons, ['verify-blocked']);
  });

  it('abort và error nhả đúng run, không bật cờ KV và chỉ quay list sau khi đóng modal', async () => {
    for (const event of ['aborted', 'error']) {
      const harness = loadAutomation();
      const closeReasons = [];
      await harness.kv.openPanelForOrder(snapshot(`po_${event}`), {
        onClose: detail => closeReasons.push(detail.reason)
      });
      await harness.kv.startOrder();
      const runId = harness.calls.runs[0].options.runId;
      harness.handlers[`browser-agent:${event}`]({ runId, error: 'lỗi test' });

      assert.equal(harness.kv._activeRunId, null);
      assert.equal(harness.calls.marked.length, 0);
      assert.deepEqual(closeReasons, [], 'chưa mở list khi modal còn mở');
      harness.kv.closePanel();
      assert.deepEqual(closeReasons, [event]);
    }
  });

  it('terminal event của run cũ không được chạm run mới', async () => {
    const harness = loadAutomation();
    await harness.kv.openPanelForOrder(snapshot('po_new'));
    await harness.kv.startOrder();
    const activeRunId = harness.calls.runs[0].options.runId;

    harness.handlers['browser-agent:completed']({
      runId: 'kv-old',
      steps: 1,
      summary: 'old',
      verifyBlocked: false
    });
    assert.equal(harness.kv._activeRunId, activeRunId, 'run cũ không bị xóa context của run mới');
    assert.equal(harness.calls.marked.length, 0);
  });
});

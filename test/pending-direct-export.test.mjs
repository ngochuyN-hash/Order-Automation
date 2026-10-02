/**
 * Regression: xuất Excel trực tiếp từ card Đơn Chờ Duyệt phải dùng snapshot
 * của record được bấm, không đọc đơn đang mở và không mutate record nguồn.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'order', 'export.js'),
  'utf8'
);

function loadExportHarness({ exportOrder, currentOrder }) {
  const calls = { payloads: [], marked: [], toasts: [], commits: [] };
  const liveOrder = currentOrder;
  const context = {
    db: {
      data: { campaigns: { xvil: { brand: 'XVIL' } } },
      findProductById: () => null,
      getAllProducts: () => []
    },
    store: { getState: () => ({ currentOrder: liveOrder }) },
    uiRenderer: {
      getOrderTableRows(order) {
        order.rowOrder = ['item_0'];
        if (order.items?.[0]) order.items[0].subtotal = 999999;
        return {
          rows: [{
            type: 'matched',
            product: {
              id: 'P1',
              name: 'Dầu API A',
              campaignKey: 'xvil',
              spec: '1L',
              category: 'Dầu nhớt',
              box_size: 12,
              tiers: [{ price: 50000 }]
            },
            productId: 'P1',
            productName: 'Dầu API A',
            rawName: 'Dầu API A',
            qty: 2,
            unit: 'thùng',
            subtotal: 150017,
            bottlePrice: 10000,
            isGift: false
          }]
        };
      }
    },
    showToast: (message, type) => calls.toasts.push({ message, type }),
    escapeHtml: value => String(value),
    normalizeFull: value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(),
    tlnCoversRawText: () => false,
    splitRawIntoTlnLines: lines => lines,
    refineAiTlnLines: lines => lines,
    rescanOrderTextIfChanged: () => false,
    validateOrderBeforeExport: () => [],
    confirmExportIfIssues: async () => true,
    getSellers: () => [{ id: 'seller-1', name: 'Hà', kvName: 'Hà KV', discount: '5' }],
    generateOrderTitle: (brand, seller, discount, seq) => `${brand}-${seller}-${discount}-${seq}`,
    peekOrderSequence: brand => `${brand}-01`,
    commitOrderSequence: (brand, seq) => calls.commits.push({ brand, seq }),
    findSellerByKey: (sellers, key) => sellers.find(s => `Sales ${s.id}` === key) || null,
    parseSellerKey: key => ({ name: String(key || '').split('|||')[0] }),
    aiService: {},
    trapFocus: () => ({ release() {} }),
    async markDone(id, source, expectedSignature) {
      calls.marked.push({ id, source, expectedSignature });
      return { marked: true };
    },
    document: {
      getElementById: () => null,
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, append() {}, setAttribute() {}, remove() {} }),
      body: { appendChild() {} }
    },
    window: {
      electronAPI: {
        exportOrder: async payload => {
          calls.payloads.push(payload);
          return exportOrder(payload);
        }
      }
    },
    AbortController,
    console
  };

  const stripped = EXPORT_SRC
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];.*$/gm, '')
    .replace(/^export\s+/gm, '');
  const vmContext = vm.createContext(context);
  vm.runInContext(stripped, vmContext, { filename: 'export.js' });
  return { api: vmContext, calls, liveOrder };
}

function snapshotOrder() {
  return {
    customer: 'Khách A',
    payment: 'ck',
    rawChatText: 'Khách A\nDầu API A x 2 thùng',
    tlnLines: [],
    items: [{
      rawName: 'Dầu API A',
      qty: 2,
      unit: 'thùng',
      unitPrice: 10000,
      isGift: false
    }]
  };
}

describe('Excel direct pending export', () => {
  it('dùng snapshot/form của record, không đụng đơn đang mở và chỉ mark đúng id', async () => {
    const liveOrder = { customer: 'KHÁCH ĐANG MỞ', items: [{ rawName: 'SP B', qty: 99 }] };
    const source = snapshotOrder();
    const sourceBefore = JSON.stringify(source);
    const harness = loadExportHarness({
      currentOrder: liveOrder,
      exportOrder: async payload => ({
        success: true,
        filePath: `C:/orders/${payload.brand}.xlsx`,
        created: false,
        opened: true
      })
    });

    const result = await harness.api.exportToExcel({
      pendingId: 'po_A',
      expectedSignature: 'sig_A',
      order: source,
      form: {
        customerName: 'Khách A',
        payment: 'ck',
        note: 'giao trước 10h',
        sellerKey: 'Sales seller-1',
        orderText: 'Khách A\nDầu API A x 2 thùng'
      }
    });

    assert.equal(result.status, 'success');
    assert.equal(result.pendingMarked, true);
    assert.equal(harness.calls.payloads.length, 1);
    assert.equal(harness.calls.payloads[0].customerName, 'Khách A');
    assert.match(harness.calls.payloads[0].tlnText, /Khách A/);
    assert.match(harness.calls.payloads[0].tlnText, /giao trước 10h/);
    assert.equal(harness.liveOrder.customer, 'KHÁCH ĐANG MỞ', 'đơn đang mở không bị mutate');
    assert.equal(JSON.stringify(source), sourceBefore, 'record nguồn không bị mutate');
    assert.deepEqual(harness.calls.marked, [
      { id: 'po_A', source: 'excel', expectedSignature: 'sig_A' }
    ]);
  });

  it('khóa toàn cục chặn hai lần export chạy chồng', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const harness = loadExportHarness({
      currentOrder: null,
      exportOrder: async () => {
        await gate;
        return { success: true, filePath: 'C:/orders/one.xlsx', opened: true };
      }
    });
    const context = {
      pendingId: 'po_lock',
      expectedSignature: 'sig_lock',
      order: snapshotOrder(),
      form: {
        customerName: 'Khách A',
        payment: 'ck',
        note: '',
        sellerKey: '',
        orderText: 'Khách A\nDầu API A x 2 thùng'
      }
    };

    const first = harness.api.exportToExcel(context);
    await Promise.resolve();
    const second = await harness.api.exportToExcel(context);
    assert.equal(second.status, 'busy');

    release();
    assert.equal((await first).status, 'success');
    assert.equal(harness.calls.payloads.length, 1);
  });
});

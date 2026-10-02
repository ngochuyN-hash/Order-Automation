/**
 * =========================================================================
 *  BROWSER AGENT TESTS (test/browser-agent.test.js)
 * =========================================================================
 *  Kiểm tra 2 chế độ lên đơn KiotViet của BrowserAgent:
 *    - mode 'new' (mặc định): giỏ active có hàng → bấm "+" mở giỏ MỚI (giỏ cũ
 *      giữ nguyên) rồi điền; giỏ trống → điền thẳng.
 *    - mode 'supplement': quét từng dòng giỏ đang mở → đủ SL bỏ qua · lệch SL
 *      sửa đúng dòng · thiếu thêm mới. KHÔNG reload.
 *
 *  Test hành vi chạy trong Electron trên trang mock KV POS (fixture) qua
 *  test/kv-fill-harness.js — KHÔNG cần KiotViet thật/đăng nhập.
 *  Thiếu Electron binary → các test hành vi SKIP, giữ test biên dịch/unit.
 * =========================================================================
 */

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

const HARNESS = path.join(__dirname, 'kv-fill-harness.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'kv-pos-mock.html');

// ==================== ELECTRON BINARY (nếu có) ====================
let electronPath = null;
try {
  const p = require('electron');
  if (typeof p === 'string' && fs.existsSync(p)) electronPath = p;
} catch { /* chạy ngoài môi trường có electron package */ }

// ==================== ĐƠN DÙNG CHUNG ====================
const ORDER_S2 = {
  customer: 'Công ty TNHH Hà Phúc',
  receiver: '',
  note: 'đơn bổ sung test',
  items: [
    // Đủ SL trong giỏ → SKIP
    { code: 'FB001AA-1', name: 'TORVEX FAST 4T 10W40; 1L', qty: 2, unit: 'thùng', price: 2550017 },
    // Giỏ đang có x9 → CẬP NHẬT về x5
    { code: 'FB002AA-1', name: 'TORVEX FAST 4T 10W40; 800ml', qty: 5, unit: 'thùng', price: 2370017 },
    // Chưa có trong giỏ → THÊM MỚI (không khai báo giá → giữ giá mặc định KV)
    { code: 'VT5W30', name: 'VELTRA PRIME EVO 5W30', qty: 3, unit: 'thùng' },
  ],
};

function buildFillScript(orderData, mode) {
  const { BrowserAgent } = require('../browser-agent');
  const agent = new BrowserAgent();
  return agent._buildDirectFillScript(orderData, mode);
}

/**
 * Spawn harness Electron: nạp trang mock với seed, chạy fill script từ file tạm,
 * trả về { result, dump } lấy từ 2 dòng KV_FILL_RESULT / KV_DUMP trên stdout.
 */
function runHarness(seed, fillScript) {
  return new Promise((resolve, reject) => {
    // Script truyền qua FILE TẠM — Electron trên Windows không đáng tin với stdin
    const scriptFile = path.join(os.tmpdir(), 'kv-fill-' + Date.now() + '-' + process.pid + '.js');
    fs.writeFileSync(scriptFile, fillScript, 'utf8');

    const child = spawn(electronPath, [HARNESS, JSON.stringify(seed), FIXTURE, scriptFile], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Harness timeout 90s\n' + stderr.slice(-500)));
    }, 90000);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (e) => { clearTimeout(timer); fs.unlink(scriptFile, () => {}); reject(e); });
    child.on('close', () => {
      clearTimeout(timer);
      fs.unlink(scriptFile, () => {});
      const resultLine = stdout.split('\n').find(l => l.startsWith('KV_FILL_RESULT:'));
      const dumpLine = stdout.split('\n').find(l => l.startsWith('KV_DUMP:'));
      const errLine = stdout.split('\n').find(l => l.startsWith('KV_FILL_ERROR:'));
      if (errLine || !resultLine || !dumpLine) {
        return reject(new Error(errLine ? errLine.slice(14) : ('Harness thiếu kết quả:\n' + stderr.slice(-600))));
      }
      try {
        resolve({
          result: JSON.parse(resultLine.slice('KV_FILL_RESULT:'.length)),
          dump: JSON.parse(dumpLine.slice('KV_DUMP:'.length)),
        });
      } catch (e) { reject(new Error('Parse kết quả harness lỗi: ' + e.message)); }
    });
  });
}

// ==================== 1. BIÊN DỊCH & MARKER (không cần Electron) ====================
test('script fill sinh ra là JS hợp lệ ở cả 2 mode', () => {
  for (const mode of ['new', 'supplement']) {
    const src = buildFillScript(ORDER_S2, mode);
    assert.ok(src.startsWith('async () =>'), mode + ': phải là async arrow function');
    assert.doesNotThrow(() => new vm.Script('(' + src + ')'), mode + ': lỗi cú pháp template');
  }
});

test('script fill chứa logic cốt lõi: quét dòng giỏ, mở giỏ mới, verify', () => {
  const src = buildFillScript(ORDER_S2, 'new');
  for (const marker of [
    'readCartRows()',       // quét từng dòng giỏ theo note-cartitem-N
    'dismissIntro(',        // gỡ overlay hướng dẫn chặn click
    'getCartCustomer(',     // đọc khách hiện tại của giỏ
    'scoreRow(',            // chấm điểm khớp mã/tên/quy cách
    'setQtyAt(row.index',   // sửa SL NGAY TẠI dòng trùng
    'button.cart-item-',    // nút giá theo index dòng
    '#adjustPriceIpt',      // ô sửa giá trong popover
    'ensureEmptyCart()',    // mode new: đảm bảo giỏ sạch
    'findNewCartButton()',  // tìm nút "+" mở giỏ mới
    'verifyDom()',          // đọc lại giỏ đối chiếu sau khi điền
    "getElementById('note-cartitem-'",
  ]) {
    assert.ok(src.includes(marker), 'thiếu marker: ' + marker);
  }
});

test('runDirectOrder có pre-flight probe + truyền mode + bắt mã đơn (source check)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'browser-agent.js'), 'utf8');
  assert.ok(src.includes('posReady'), 'probe phải kiểm tra productSearchInput');
  assert.ok(src.includes("getElementById('productSearchInput')"), 'selector POS đúng id thật đã verify trên KiotViet');
  assert.ok(src.includes("_buildDirectFillScript(orderData, mode)"), 'phải truyền mode vào fill script');
  assert.ok(src.includes('DH\\\\d{6,}') || /DH\\\\d\{6,\}/.test(src), 'regex bắt mã đơn DH phải có trong runDirectOrder');
  assert.ok(src.includes('_extractOrderCode'), 'helper rút mã đơn phải tồn tại');
  assert.ok(src.includes("emit('completed', { steps: 4, summary: summaryMsg, orderCode, verifyBlocked })"), 'event completed phải mang orderCode + verifyBlocked');
});

test('terminal events tự gắn runId khi modal chạy có runId, không đổi payload legacy', () => {
  const { BrowserAgent } = require('../browser-agent');
  const agent = new BrowserAgent();
  agent._currentRunId = 'kv-run-123';
  const seen = {};
  for (const event of ['completed', 'aborted', 'error']) {
    agent.on(event, payload => { seen[event] = payload; });
  }
  agent.emit('completed', { steps: 4, verifyBlocked: false });
  agent.emit('aborted', { steps: 2 });
  agent.emit('error', { error: 'boom' });
  assert.equal(seen.completed.runId, 'kv-run-123');
  assert.equal(seen.aborted.runId, 'kv-run-123');
  assert.equal(seen.error.runId, 'kv-run-123');

  const legacy = new BrowserAgent();
  let legacyPayload = null;
  legacy.on('completed', payload => { legacyPayload = payload; });
  legacy.emit('completed', { steps: 1, summary: 'legacy' });
  assert.deepStrictEqual(Object.keys(legacyPayload).sort(), ['steps', 'summary']);
});

test('runDirectOrder nhánh abort sớm vẫn emit terminal event mang runId', async () => {
  const { BrowserAgent } = require('../browser-agent');
  const agent = new BrowserAgent();
  agent._mcp = {
    callTool: async () => {
      agent._aborted = true;
      throw new Error('ABORTED_BY_USER');
    },
    navigate: async () => {},
    wait: async () => {}
  };
  let aborted = null;
  agent.on('aborted', payload => { aborted = payload; });

  const result = await agent.runDirectOrder(ORDER_S2, { runId: 'kv-abort-test' });
  assert.equal(result.aborted, true);
  assert.equal(aborted.runId, 'kv-abort-test');
});

test('fillVerifyBlocked: gate auto-submit theo VERIFY DOM (không cần AI)', () => {
  const { BrowserAgent } = require('../browser-agent');
  // Giỏ khớp + không SP thất bại → cho submit
  assert.equal(BrowserAgent.fillVerifyBlocked({ failed: [], mismatches: [] }), false);
  // SP không vào giỏ → chặn
  assert.equal(BrowserAgent.fillVerifyBlocked({ failed: [{ term: 'X', reason: 'CLICK_NO_CART' }], mismatches: [] }), true);
  // Đọc lại giỏ lệch SL/giá → chặn
  assert.equal(BrowserAgent.fillVerifyBlocked({ failed: [], mismatches: [{ term: 'X', reason: 'QTY_MISMATCH' }] }), true);
  // Không đọc được kết quả fill → chặn (không submit trên trạng thái mù)
  assert.equal(BrowserAgent.fillVerifyBlocked(null), true);
  assert.equal(BrowserAgent.fillVerifyBlocked('lỗi không phải JSON'), true);

  // Source check: bước bấm Đặt hàng thật sự đi qua gate
  const src = fs.readFileSync(path.join(__dirname, '..', 'browser-agent.js'), 'utf8');
  assert.ok(src.includes('autoSubmit && !verifyBlocked'), 'submit phải bị chặn khi verifyBlocked');
  assert.ok(src.includes('if (autoSubmit && verifyBlocked)'), 'phải có nhánh log khi VERIFY DOM lệch');
});

test('runDirectOrder chặn chạy song song (guard Already running)', async () => {
  const { BrowserAgent } = require('../browser-agent');
  const agent = new BrowserAgent();
  agent._running = true; // giả lập đang chạy
  await assert.rejects(
    () => agent.runDirectOrder(ORDER_S2),
    /Already running/,
  );
});

test('_extractOrderCode: rút đúng mã DH từ text (kể cả bị quote JSON)', () => {
  const { BrowserAgent } = require('../browser-agent');
  assert.equal(BrowserAgent._extractOrderCode('"DH001234"'), 'DH001234');
  assert.equal(BrowserAgent._extractOrderCode('Đặt hàng thành công DH275891 - chi tiết'), 'DH275891');
  assert.equal(BrowserAgent._extractOrderCode('DH12'), null);       // quá ngắn
  assert.equal(BrowserAgent._extractOrderCode(null), null);         // null-safe
  assert.equal(BrowserAgent._extractOrderCode('không có mã'), null);
});

// ==================== 2. HÀNH VI TRÊN TRANG MOCK (cần Electron) ====================
test('mode=new: giỏ CÓ HÀNG → mở GIỎ MỚI, giỏ cũ giữ nguyên, điền đủ', { skip: !electronPath && 'Không tìm thấy Electron binary' }, async () => {
  const order = {
    customer: 'Trần Văn Hải',
    note: 'test gio moi',
    items: [
      { code: 'FB001AA-1', name: 'TORVEX FAST 4T 10W40; 1L', qty: 2, unit: 'thùng', price: 2550017 },
      { code: 'VT5W30', name: 'VELTRA PRIME EVO 5W30', qty: 3, unit: 'thùng' },
    ],
  };
  const seed = { preloadItems: [{ code: 'FB002AA-1', qty: 9 }] }; // giỏ dở của SP khác
  const { result, dump } = await runHarness(seed, buildFillScript(order, 'new'));

  assert.equal(result.success, true);
  assert.equal(result.mode, 'new');
  assert.equal(result.summary.added, 2);
  assert.equal(result.existingCount, 0, 'giỏ mới phải bắt đầu trống');
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.mismatches, [], 'VERIFY đọc lại phải khớp đơn');

  // Giỏ MỚI được mở và active (không phải "Hóa đơn 1" đang chứa hàng dở)
  assert.notEqual(dump.activeCart, 'Hóa đơn 1');
  const oldCart = dump.carts.find(c => c.name === 'Hóa đơn 1');
  assert.equal(oldCart.rows.length, 1, 'giỏ cũ KHÔNG bị đụng');
  assert.equal(oldCart.rows[0].code, 'FB002AA-1');
  assert.equal(oldCart.rows[0].qty, 9);

  // Giỏ active chứa đúng đơn vừa lên
  const byCode = Object.fromEntries(dump.rows.map(r => [r.code, r]));
  assert.equal(byCode['FB001AA-1'].qty, 2);
  assert.equal(byCode['FB001AA-1'].price, 2550017);
  assert.equal(byCode['VT5W30'].qty, 3);
  assert.equal(byCode['VT5W30'].price, 510017, 'SP không khai báo giá → giữ giá mặc định');
  assert.equal(dump.customer, 'Trần Văn Hải');
  assert.equal(dump.note, 'test gio moi');
});

test('mode=new: giỏ TRỐNG → điền thẳng không mở giỏ mới', { skip: !electronPath && 'Không tìm thấy Electron binary' }, async () => {
  const order = {
    customer: 'Trần Văn Hải',
    note: '',
    items: [
      { code: 'FB001AA-1', name: 'TORVEX FAST 4T 10W40; 1L', qty: 4, unit: 'thùng', price: 2550017 },
    ],
  };
  const { result, dump } = await runHarness({}, buildFillScript(order, 'new'));

  assert.equal(result.summary.added, 1);
  assert.equal(dump.activeCart, 'Hóa đơn 1', 'giỏ trống → dùng luôn, không tạo giỏ thừa');
  assert.equal(dump.carts.length, 2);
  assert.equal(dump.rows[0].qty, 4);
  assert.equal(dump.rows[0].price, 2550017);
});

test('mode=supplement: giỏ CÓ SẠN → skip đủ SL / update SL lệch / thêm SP thiếu', { skip: !electronPath && 'Không tìm thấy Electron binary' }, async () => {
  const seed = {
    customer: 'Công ty TNHH Hà Phúc',
    preloadItems: [
      { code: 'FB001AA-1', qty: 2 },  // đủ SL → skip
      { code: 'FB002AA-1', qty: 9 },  // lệch SL → cập nhật về x5
    ],
  };
  const { result, dump } = await runHarness(seed, buildFillScript(ORDER_S2, 'supplement'));

  assert.equal(result.success, true);
  assert.equal(result.mode, 'supplement');
  assert.equal(result.summary.added, 1, 'VT5W30 phải được thêm mới');
  assert.equal(result.summary.updated, 1, 'FB002AA-1 phải được cập nhật SL');
  assert.equal(result.summary.skipped, 1, 'FB001AA-1 đủ SL phải bỏ qua');
  assert.deepEqual(result.failed, []);
  assert.equal(result.existingCount, 2, 'giỏ khởi đầu phải là 2 dòng');
  assert.deepEqual(result.mismatches, [], 'VERIFY sau bổ sung phải khớp đơn');

  assert.equal(dump.activeCart, 'Hóa đơn 1', 'KHÔNG mở giỏ mới ở chế độ bổ sung');
  assert.equal(dump.rows.length, 3);
  const byCode = Object.fromEntries(dump.rows.map(r => [r.code, r]));
  assert.equal(byCode['FB001AA-1'].qty, 2, 'dòng đủ SL giữ nguyên');
  assert.equal(byCode['FB001AA-1'].price, 2550017);
  assert.equal(byCode['FB002AA-1'].qty, 5, 'SL được cập nhật THEO ĐƠN (9 → 5)');
  assert.equal(byCode['FB002AA-1'].price, 2370017);
  assert.equal(byCode['VT5W30'].qty, 3);
  assert.equal(dump.customer, 'Công ty TNHH Hà Phúc');
});

test('overlay hướng dẫn intro.js bị TỰ GỠ rồi điền tiếp', { skip: !electronPath && 'Không tìm thấy Electron binary' }, async () => {
  const order = {
    customer: 'Trần Văn Hải',
    note: '',
    items: [
      { code: 'FB001AA-1', name: 'TORVEX FAST 4T 10W40; 1L', qty: 4, unit: 'thùng', price: 2550017 },
    ],
  };
  const { result, dump } = await runHarness({ intro: true }, buildFillScript(order, 'new'));

  assert.equal(result.success, true);
  assert.equal(result.summary.added, 1);
  assert.equal(dump.overlayGone, true, 'overlay intro phải bị gỡ trước khi điền');
  assert.equal(dump.rows.length, 1);
  assert.equal(dump.rows[0].qty, 4);
});

// ==================== UNIT: abort() ngắt cứng ====================
// abort() không chỉ gắn cờ _aborted (cooperative) mà còn phải HỦY NGAY:
//  - lệnh MCP đang bay qua _mcp.abortPending() (không chờ timeout 90s)
//  - fetch AI đang chờ qua _aiAbort.abort() (pha AI verify không có timeout)
test('abort(): gắn cờ _aborted + hủy lệnh MCP đang bay + fetch AI đang chờ', () => {
  const { BrowserAgent } = require('../browser-agent');
  const agent = new BrowserAgent();
  const calls = [];
  agent._mcp = { abortPending: (err) => calls.push(['mcp', err]) };
  agent._aiAbort = { abort: () => calls.push(['ai']) };

  agent.abort();

  assert.equal(agent._aborted, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'mcp');
  assert.equal(calls[0][1] && calls[0][1].message, 'ABORTED_BY_USER');
  assert.equal(calls[1][0], 'ai');
});

test('abort(): chưa kết nối MCP / không có call AI → vẫn gắn cờ, không ném lỗi', () => {
  const { BrowserAgent } = require('../browser-agent');
  const agent = new BrowserAgent();
  agent._mcp = undefined;
  agent._aiAbort = undefined;

  assert.doesNotThrow(() => agent.abort());
  assert.equal(agent._aborted, true);
});

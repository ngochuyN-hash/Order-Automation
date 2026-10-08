// =========================================================================
//  Test MCP server (mcp-server.js) — KHÔNG cần Electron: getMainWindow trả
//  null nên các tool gọi renderer trả lỗi APP_NOT_READY (chứng tỏ tool tồn
//  tại + đã qua gate). Tool local (get_server_info, get_status,
//  get_run_status) chạy thật. Endpoint MCP chuẩn: POST /mcp.
// =========================================================================
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import {
  start, stop, MCP_PATH,
  readBody, repairMojibake, normalizeOrderData, repairOrderTextEncoding,
  applyRunOutcome, sanitizeDeep,
} from '../mcp-server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
let base = '';
let anon = null;
let authed = null;

async function connectClient(headers = {}) {
  const client = new Client({ name: 'mcp-server-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(base + MCP_PATH), {
    requestInit: { headers },
  });
  await client.connect(transport);
  return { client, transport };
}

function structured(result) {
  return (result && result.structuredContent) || {};
}

// POST raw JSON-RPC qua HTTP thuần (không qua SDK client) — dùng cho test
// Host/Origin/404 ở tầng HTTP.
function postJson(pathName, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const r = http.request(base + pathName, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    r.on('error', reject);
    r.write(body);
    r.end();
  });
}

describe('MCP server (mcp-server.js)', () => {
  before(async () => {
    process.env.ORDER_AUTOMATION_MCP_TOKEN = TOKEN;
    const server = start(0, () => null); // port 0 = ephemeral, tránh đụng instance thật
    if (!server || !server.listening) {
      await new Promise((resolve, reject) => {
        if (!server) { reject(new Error('MCP server không khởi động được')); return; }
        server.once('listening', resolve);
        server.once('error', reject);
      });
    }
    base = `http://127.0.0.1:${server.address().port}`;
    anon = await connectClient();
    authed = await connectClient({ Authorization: `Bearer ${TOKEN}` });
  });

  after(async () => {
    await Promise.allSettled([
      anon ? anon.client.close() : null,
      authed ? authed.client.close() : null,
    ]);
    await stop();
  });

  test('tools/list trả đủ tool catalog (parse, catalog, AI, Excel, browser, KiotViet)', async () => {
    const { tools } = await anon.client.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of [
      'get_server_info', 'get_status', 'get_run_status', 'abort_run',
      'get_db_info', 'get_products', 'upsert_product', 'delete_product',
      'get_campaigns', 'add_campaign', 'update_campaign', 'delete_campaign',
      'get_aliases', 'set_aliases', 'get_kv_map', 'set_kv_code',
      'get_memory', 'set_memory', 'get_sellers', 'save_sellers',
      'get_current_order', 'export_database', 'import_database', 'reset_database',
      'parse_order', 'parse_order_offline', 'get_ai_status', 'test_ai_profiles',
      'manage_ai_profiles', 'export_excel', 'connect_browser', 'get_browser_tools',
      'get_browser_snapshot', 'execute_browser_tool', 'auto_run_order', 'run_kiotviet_order',
    ]) {
      assert.ok(names.includes(expected), `thiếu tool ${expected}`);
    }
  });

  test('get_server_info → app order-automation + endpoint /mcp + quy tắc token', async () => {
    const res = await anon.client.callTool({ name: 'get_server_info', arguments: {} });
    assert.equal(res.isError, undefined);
    const data = structured(res);
    assert.equal(data.app, 'order-automation');
    assert.ok(String(data.endpoint).endsWith(MCP_PATH));
    assert.ok(data.capabilities);
    assert.equal(data.auth.envOverride, 'ORDER_AUTOMATION_MCP_TOKEN');
  });

  test('get_status → windowOpen false trong test headless, có browserAgent', async () => {
    const res = await anon.client.callTool({ name: 'get_status', arguments: {} });
    assert.equal(res.isError, undefined);
    const data = structured(res);
    assert.equal(data.windowOpen, false);
    assert.ok(data.browserAgent);
  });

  test('get_run_status → có browserAgent, lastRun, logs (không cần renderer)', async () => {
    const res = await anon.client.callTool({ name: 'get_run_status', arguments: {} });
    assert.equal(res.isError, undefined);
    const data = structured(res);
    assert.ok('browserAgent' in data);
    assert.ok('lastRun' in data);
    assert.ok(Array.isArray(data.logs));
  });

  test('tool đọc cần renderer (get_products) → APP_NOT_READY, không crash', async () => {
    const res = await anon.client.callTool({ name: 'get_products', arguments: { limit: 5 } });
    assert.equal(res.isError, true);
    assert.equal(structured(res).code, 'APP_NOT_READY');
  });

  test('tool ghi thiếu token → UNAUTHORIZED (upsert_product, auto_run_order)', async () => {
    const r1 = await anon.client.callTool({ name: 'upsert_product', arguments: { product: { name: 'X' } } });
    assert.equal(r1.isError, true);
    assert.equal(structured(r1).code, 'UNAUTHORIZED');

    const r2 = await anon.client.callTool({ name: 'auto_run_order', arguments: { text: 'test' } });
    assert.equal(r2.isError, true);
    assert.equal(structured(r2).code, 'UNAUTHORIZED');
  });

  test('tool ghi đúng token → qua gate, renderer chưa sẵn sàng → APP_NOT_READY', async () => {
    const res = await authed.client.callTool({
      name: 'upsert_product',
      arguments: { campaign: 'xvil', product: { name: 'Test SP' } },
    });
    assert.equal(res.isError, true);
    assert.equal(structured(res).code, 'APP_NOT_READY');
  });

  test('abort_run cần token; đúng token gửi tín hiệu abort headless', async () => {
    const noToken = await anon.client.callTool({ name: 'abort_run', arguments: {} });
    assert.equal(noToken.isError, true);
    assert.equal(structured(noToken).code, 'UNAUTHORIZED');

    const ok = await authed.client.callTool({ name: 'abort_run', arguments: {} });
    assert.equal(ok.isError, undefined);
    assert.equal(structured(ok).aborted, true);
  });

  test('parse_order text rỗng bị schema chặn (isError, không chạm renderer)', async () => {
    const res = await anon.client.callTool({ name: 'parse_order', arguments: { text: '   ' } });
    assert.equal(res.isError, true);
  });

  test('parse_order có text → qua validate, 503 APP_NOT_READY khi renderer chưa sẵn sàng', async () => {
    const res = await anon.client.callTool({
      name: 'parse_order',
      arguments: { text: '1 chai Fork 10', mode: 'ai' },
    });
    assert.equal(res.isError, true);
    assert.equal(structured(res).code, 'APP_NOT_READY');
  });

  test('execute_browser_tool tên sai schema → isError (chặn trước khi đụng browser)', async () => {
    const res = await authed.client.callTool({ name: 'execute_browser_tool', arguments: { tool: 'evil_tool', args: {} } });
    assert.equal(res.isError, true);
  });

  test('get_browser_tools + snapshot khi chưa kết nối browser → BROWSER_NOT_CONNECTED', async () => {
    const r1 = await anon.client.callTool({ name: 'get_browser_tools', arguments: {} });
    assert.equal(r1.isError, true);
    assert.equal(structured(r1).code, 'BROWSER_NOT_CONNECTED');

    const r2 = await anon.client.callTool({ name: 'get_browser_snapshot', arguments: {} });
    assert.equal(r2.isError, true);
    assert.equal(structured(r2).code, 'BROWSER_NOT_CONNECTED');
  });

  test('run_kiotviet_order khi browser chưa kết nối → BROWSER_NOT_CONNECTED', async () => {
    const res = await authed.client.callTool({
      name: 'run_kiotviet_order',
      arguments: {
        orderData: {
          customer: 'Test KH',
          items: [{ code: '123401-1', name: 'Test', qty: 1, unit: 'Thùng', price: 130017 }],
        },
      },
    });
    assert.equal(res.isError, true);
    assert.equal(structured(res).code, 'BROWSER_NOT_CONNECTED');
  });

  test('auto_run_order qua gate và trả APP_NOT_READY khi renderer chưa sẵn sàng', async () => {
    const res = await authed.client.callTool({
      name: 'auto_run_order',
      arguments: {
        text: 'Anywhere Man\n1 thùng prostream 10W50\nTT CK\nHđ',
        action: 'kiotviet',
      },
    });
    assert.equal(res.isError, true);
    assert.equal(structured(res).code, 'APP_NOT_READY');
  });

  test('export_excel qua gate (APP_NOT_READY trong test headless)', async () => {
    const res = await authed.client.callTool({
      name: 'export_excel',
      arguments: { order: { customer: 'Test KH', items: [{ name: 'XVIL', qty: 1 }] } },
    });
    assert.equal(res.isError, true);
    assert.equal(structured(res).code, 'APP_NOT_READY');
  });

  test('POST sai path → 404 JSON-RPC; Host lạ → 403 (chặn DNS rebinding)', async () => {
    const notFound = await postJson('/sai-path');
    assert.equal(notFound.status, 404);

    const forbidden = await postJson(MCP_PATH, { Host: 'evil.example.com:1234' });
    assert.equal(forbidden.status, 403);
  });

  // ── Regression: các fix 20/09/2026 ─────────────────────────────────────

  test('get_server_info: endpoint phản ánh port THẬT, không hardcode 8048', async () => {
    const res = await anon.client.callTool({ name: 'get_server_info', arguments: {} });
    const data = structured(res);
    assert.equal(data.endpoint, base + MCP_PATH);
  });

  test('POST với Origin: null → 403 (file://, sandboxed iframe bị chặn)', async () => {
    const res = await postJson(MCP_PATH, { Origin: 'null' });
    assert.equal(res.status, 403);
  });

  test('run_kiotviet_order: qty rác → INVALID_ORDER, chặn TRƯỚC cả check browser', async () => {
    const res = await authed.client.callTool({
      name: 'run_kiotviet_order',
      arguments: { orderData: { customer: 'KH Test', items: [{ name: 'A', qty: 'abc' }] } },
    });
    assert.equal(res.isError, true);
    assert.equal(structured(res).code, 'INVALID_ORDER');
  });

  test('upsert_product: cập nhật theo id không cần name → qua gate (APP_NOT_READY)', async () => {
    const res = await authed.client.callTool({
      name: 'upsert_product',
      arguments: { product: { id: 'p-test', box_size: '12 chai/thùng' } },
    });
    assert.equal(res.isError, true);
    assert.equal(structured(res).code, 'APP_NOT_READY');
  });

  test('upsert_product: không id không name → INVALID_PARAMS, không đụng renderer', async () => {
    const res = await authed.client.callTool({
      name: 'upsert_product',
      arguments: { product: { box_size: '12' } },
    });
    assert.equal(res.isError, true);
    assert.equal(structured(res).code, 'INVALID_PARAMS');
  });

  test('update_campaign: key __proto__ bị strip trước khi merge (prototype pollution)', async () => {
    const updates = JSON.parse('{"brand":"zentor","__proto__":{"polluted":"pwned"}}');
    const res = await authed.client.callTool({
      name: 'update_campaign',
      arguments: { key: 'xvil', updates },
    });
    assert.equal(structured(res).code, 'APP_NOT_READY'); // qua gate, không văng lỗi schema
    assert.equal(({}).polluted, undefined); // Object.prototype toàn cục không bị bẩn
    assert.ok(!Object.keys(sanitizeDeep(updates)).includes('__proto__'));
  });

  test('sanitizeDeep: strip __proto__/constructor/prototype lồng nhau, giữ key thường', () => {
    const dirty = JSON.parse('{"name":"a","__proto__":{"x":1},"nested":{"constructor":{},"ok":2},"list":[{"prototype":1,"keep":3}]}');
    const clean = sanitizeDeep(dirty);
    assert.deepEqual(Object.keys(clean).sort(), ['list', 'name', 'nested']);
    assert.deepEqual(Object.keys(clean.nested), ['ok']);
    assert.deepEqual(Object.keys(clean.list[0]), ['keep']);
  });

  test('import_database: thiếu confirm → schema chặn trước handler', async () => {
    const res = await authed.client.callTool({
      name: 'import_database',
      arguments: { data: { database: { campaigns: {} } } },
    });
    assert.equal(res.isError, true);
  });

  test('import_database: shape lạ → INVALID_IMPORT thay vì nuốt lỗi câm lặng', async () => {
    const res = await authed.client.callTool({
      name: 'import_database',
      arguments: { data: { hello: 'world' }, confirm: true },
    });
    assert.equal(res.isError, true);
    assert.equal(structured(res).code, 'INVALID_IMPORT');
  });

  test('import_database: chuỗi JSON hỏng → INVALID_IMPORT', async () => {
    const res = await authed.client.callTool({
      name: 'import_database',
      arguments: { data: '{không phải json', confirm: true },
    });
    assert.equal(res.isError, true);
    assert.equal(structured(res).code, 'INVALID_IMPORT');
  });

  test('import_database: export đúng shape (object và chuỗi JSON) → qua gate (APP_NOT_READY)', async () => {
    const asObject = await authed.client.callTool({
      name: 'import_database',
      arguments: { data: { database: { campaigns: { xvil: {} } }, aliases: {}, memory: {} }, confirm: true },
    });
    assert.equal(structured(asObject).code, 'APP_NOT_READY');

    const asString = await authed.client.callTool({
      name: 'import_database',
      arguments: { data: JSON.stringify({ database: { campaigns: {} } }), confirm: true },
    });
    assert.equal(structured(asString).code, 'APP_NOT_READY');
  });

  test('normalizeOrderData: qty hợp lệ — số, chuỗi số, thiếu/rỗng → mặc định 1', () => {
    assert.equal(normalizeOrderData({ items: [{ name: 'A', qty: 3 }] }).items[0].qty, 3);
    assert.equal(normalizeOrderData({ items: [{ name: 'A', qty: '4' }] }).items[0].qty, 4);
    assert.equal(normalizeOrderData({ items: [{ name: 'A' }] }).items[0].qty, 1);
    assert.equal(normalizeOrderData({ items: [{ name: 'A', qty: '' }] }).items[0].qty, 1);
  });

  test('normalizeOrderData: qty rác — "abc", 0, -3, 2.7, "0" → ném INVALID_ORDER (hết bug câm lặng thành 1)', () => {
    for (const bad of ['abc', 0, -3, 2.7, '0']) {
      assert.throws(
        () => normalizeOrderData({ items: [{ name: 'A', qty: bad }] }),
        (err) => err.code === 'INVALID_ORDER' && /qty/.test(err.message),
        `qty ${JSON.stringify(bad)} phải bị chặn`,
      );
    }
  });

  test('applyRunOutcome: chạy xong thành công → success true + orderCode', () => {
    const out = applyRunOutcome({ success: true, orderCode: 'DH123456' }, { _aborted: false });
    assert.equal(out.success, true);
    assert.equal(out.orderCode, 'DH123456');
    assert.equal(out.error, null);
  });

  test('applyRunOutcome: ABORT — kể cả resolve undefined vẫn success:false (bug cũ: success:true oan)', () => {
    const out = applyRunOutcome(undefined, { _aborted: true });
    assert.equal(out.success, false);
    assert.ok(out.error);
  });

  test('applyRunOutcome: runDirectOrder bắt lỗi nội bộ trả success:false → status đúng', () => {
    const out = applyRunOutcome({ success: false, error: 'KV timeout' }, { _aborted: false });
    assert.equal(out.success, false);
    assert.equal(out.error, 'KV timeout');
  });

  test('applyRunOutcome: resolve undefined không abort → coi là thất bại, không success oan', () => {
    const out = applyRunOutcome(undefined, { _aborted: false });
    assert.equal(out.success, false);
    assert.ok(out.error);
  });
});

// ── Encoding: readBody + repairMojibake (bug thật 04/9/2026 — lỗi font TV) ──

function fakeReq(chunks) {
  const req = new EventEmitter();
  req.destroy = () => {};
  // Bơm từng chunk bất đồng bộ như TCP thật
  setImmediate(() => {
    for (const c of chunks) req.emit('data', Buffer.from(c));
    req.emit('end');
  });
  return req;
}

describe('Encoding: body tiếng Việt cắt giữa ký tự đa byte + mojibake agent gửi', () => {
  test('readBody: chunk 1 byte cắt giữa ký tự TV vẫn nguyên vẹn (Buffer.concat)', async () => {
    const text = '989 Workhop\n1 chai Fork 10 giá thùng\nHĐ cập nhật';
    const bytes = Buffer.from(text, 'utf8');
    // Cắt tại mỗi byte → chắc chắn có ký tự đa byte bị xẻ làm hai
    const chunks = [];
    for (const b of bytes) chunks.push([b]);
    const got = await readBody(fakeReq(chunks));
    assert.equal(got, text);
  });

  test('readBody: body lớn nhiều chunk ngẫu nhiên vẫn nguyên vẹn', async () => {
    const text = ('Anywhere Man\n2 chai Prostream 10W40 giá thùng — HĐ\n').repeat(50);
    const bytes = Buffer.from(text, 'utf8');
    const chunks = [];
    for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.subarray(i, i + 7)); // 7 byte/chunk, lẻ so với 2-3 byte/ký tự
    const got = await readBody(fakeReq(chunks));
    assert.equal(got, text);
  });

  test('repairMojibake: UTF-8 decode nhầm Latin-1 được vá lại đúng tiếng Việt', () => {
    // Sinh mojibake THẬT (UTF-8 bytes đọc nhầm thành Latin-1 — đúng những gì
    // agent ngoài encode sai trước khi POST); gõ tay sẽ thiếu control char.
    const moji = (s) => Buffer.from(s, 'utf8').toString('latin1');
    assert.equal(repairMojibake(moji('HĐ cập nhật')), 'HĐ cập nhật');
    assert.equal(repairMojibake(moji('1 thùng prostream 10W40 giá thùng')), '1 thùng prostream 10W40 giá thùng');
    const workhop = '989 Workhop\n2 Chai Propuls 10W40 giá thùng\n1 chai Fork 10 giá thùng\nTT CK\nHĐ cập nhật';
    assert.equal(repairMojibake(moji(workhop)), workhop);
  });

  test('repairMojibake: text tiếng Việt bình thường và ASCII KHÔNG bị đụng vào', () => {
    const clean = '989 Workhop\n1 chai Fork 10 giá thùng\nTT CK\nHĐ cập nhật';
    assert.equal(repairMojibake(clean), clean);
    assert.equal(repairMojibake('Plain ASCII order'), 'Plain ASCII order');
    assert.equal(repairMojibake(''), '');
  });

  test('normalizeOrderData + repairOrderTextEncoding: đơn agent gửi mojibake được vá', () => {
    const moji = (s) => Buffer.from(s, 'utf8').toString('latin1');
    const order = {
      customerName: moji('HĐ cập nhật'),
      notes: moji('Giao mặt cửa hàng'),
      items: [{ kvCode: '8230013', productName: 'Prostream 10W40', qty: 2, unitPrice: 265000 }],
    };
    const fixed = normalizeOrderData(repairOrderTextEncoding(order));
    assert.equal(fixed.customer, 'HĐ cập nhật');
    assert.equal(fixed.note, 'Giao mặt cửa hàng');
    assert.equal(fixed.items[0].name, 'Prostream 10W40');
    assert.equal(fixed.items[0].price, 265000);
  });
});

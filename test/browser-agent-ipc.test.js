/**
 * =========================================================================
 *  BROWSER AGENT IPC TESTS (test/browser-agent-ipc.test.js)
 * =========================================================================
 *  Kiểm tra cơ chế kết nối BrowserMCP "zero-install" (máy người dùng KHÔNG
 *  cần cài Node.js):
 *    - resolveMcpServerScript: đường dẫn cli.js dev / packaged (asar.unpacked)
 *    - pickBrowserLaunchArgs: fallback Chrome → Edge → Brave → null
 *    - buildMcpLaunchArgs: đủ script + browser + profile + --caps pdf
 *    - getAgent: spawn bằng process.execPath + ELECTRON_RUN_AS_NODE=1,
 *      shell:false (không qua npx/cmd)
 *    - handler connect: pre-flight báo lỗi tiếng Việt khi không có browser,
 *      KHÔNG spawn; làm tươi args theo hiện trạng máy; spawn lỗi → trả lỗi
 *      thay vì crash
 *    - McpClient: option shell, env merge, không crash khi không ai nghe
 *      sự kiện 'error'
 *
 *  Kỹ thuật: mock Module._load cho đúng các module đích (electron/fs/
 *  child_process của browser-agent-ipc.js & mcp-client.js) + FAKE MCP server
 *  trả lời JSON-RPC qua stdio như @playwright/mcp thật → 0 tiến trình thật,
 *  0 mạng, 0 Chrome bật lên trong lúc test.
 *
 *  Cuối file có 2 test TÍCH HỢP HƠN (bật Chrome không, chỉ handshake MCP qua
 *  stdio) chạy khi có binary Electron / bản build win-unpacked — thiếu thì SKIP.
 * =========================================================================
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const Module = require('module');
const { EventEmitter } = require('events');
const { spawn: realSpawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const IPC_PATH = path.join(REPO, 'browser-agent-ipc.js');
const MCP_CLIENT_PATH = path.join(REPO, 'mcp-client.js');
const MCP_CLI_REL = path.join('node_modules', '@playwright', 'mcp', 'cli.js');

// ==================== MOCK INFRASTRUCTURE ====================

// ---- electron mock: app.isPackaged đọc tại thời điểm gọi → test chỉnh được ----
const electronMock = {
  app: { isPackaged: false },
  ipcMain: { handle() { throw new Error('ipcMain.handle thật không được dùng trong test'); } },
};

// ---- fs mock: chỉ tồn tại các browser test khai báo ----
let browserPaths = new Set();
const fsMock = {
  existsSync: (p) => browserPaths.has(p),
};

// ---- child_process mock: ghi log mọi lệnh spawn + trả fake MCP process ----
const spawnLog = []; // { command, args, options }
let failNextSpawn = false;

function createFakeMcpProcess() {
  const proc = new EventEmitter();
  proc.pid = 4321;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = () => { proc.killed = true; };
  const reply = (obj) => setImmediate(() => proc.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n')));
  proc.stdin = {
    writable: true,
    write(chunk) {
      for (const line of String(chunk).split('\n')) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.method === 'initialize') {
          reply({
            jsonrpc: '2.0', id: msg.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'PlaywrightMCP-Fake', version: '0.0.0-test' },
            },
          });
        } else if (msg.method === 'tools/list') {
          reply({
            jsonrpc: '2.0', id: msg.id,
            result: { tools: [
              { name: 'browser_navigate', description: 'nav' },
              { name: 'browser_snapshot', description: 'snap' },
              { name: 'browser_evaluate', description: 'eval' },
            ] },
          });
        } else if (msg.method === 'tools/call') {
          reply({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'fake-ok' }] } });
        }
        // notification (notifications/initialized) → không trả lời
      }
      return true;
    },
  };
  return proc;
}

function fakeSpawn(command, args, options) {
  spawnLog.push({ command, args, options });
  // Nhánh disconnect trên Windows dùng taskkill — trả dummy, không phải MCP
  if (command === 'taskkill') return { unref() {}, on() {} };
  const proc = createFakeMcpProcess();
  if (failNextSpawn) {
    failNextSpawn = false;
    setImmediate(() => proc.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
  }
  return proc;
}

// ---- Module._load: chặn đúng theo module cha (không đụng phần còn lại) ----
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const from = parent && parent.filename;
  if (from === IPC_PATH) {
    if (request === 'electron') return electronMock;
    if (request === 'fs') return fsMock;
  }
  if ((from === IPC_PATH || from === MCP_CLIENT_PATH) && request === 'child_process') {
    return { spawn: fakeSpawn };
  }
  return origLoad.apply(this, arguments);
};

// require SAU KHI cắm mock — cache module dùng chung cho mọi test
// eslint-disable-next-line import/order
const ipc = require('../browser-agent-ipc');
// eslint-disable-next-line import/order
const { McpClient } = require('../mcp-client');

// ==================== HẰNG SỐ GIẢ LẬP MÁY ====================

const ENV_PF = 'C:\\Program Files';
const ENV_PF86 = 'C:\\Program Files (x86)';
const ENV_LAD = 'C:\\Users\\nv\\AppData\\Local';
const CHROME = path.join(ENV_PF, 'Google', 'Chrome', 'Application', 'chrome.exe');
const EDGE = path.join(ENV_PF86, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
const BRAVE = path.join(ENV_LAD, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe');

function resetAll({ browsers = [] } = {}) {
  ipc.destroy(); // gỡ singleton agent giữa các test
  browserPaths = new Set(browsers);
  spawnLog.length = 0;
  failNextSpawn = false;
  electronMock.app.isPackaged = false;
  delete process.resourcesPath;
  process.env.PROGRAMFILES = ENV_PF;
  process.env['PROGRAMFILES(X86)'] = ENV_PF86;
  process.env.LOCALAPPDATA = ENV_LAD;
}

function captureHandlers() {
  const handlers = {};
  ipc.register({ handle: (ch, fn) => { handlers[ch] = fn; } }, () => null);
  return handlers;
}

const PROFILE_DIR = path.join(os.homedir(), '.kv-browser-profile');

// ==================== UNIT: CHỌN BROWSER ====================

test('pickBrowserLaunchArgs: máy không có browser nào → null', () => {
  resetAll({ browsers: [] });
  assert.strictEqual(ipc.pickBrowserLaunchArgs(), null);
});

test('pickBrowserLaunchArgs: chỉ Chrome → --browser chrome', () => {
  resetAll({ browsers: [CHROME] });
  assert.deepStrictEqual(ipc.pickBrowserLaunchArgs(), ['--browser', 'chrome']);
});

test('pickBrowserLaunchArgs: chỉ Edge (máy Windows sạch) → --browser msedge', () => {
  resetAll({ browsers: [EDGE] });
  assert.deepStrictEqual(ipc.pickBrowserLaunchArgs(), ['--browser', 'msedge']);
});

test('pickBrowserLaunchArgs: chỉ Brave → chromium + --executable-path trỏ brave.exe', () => {
  resetAll({ browsers: [BRAVE] });
  assert.deepStrictEqual(ipc.pickBrowserLaunchArgs(), ['--browser', 'chromium', '--executable-path', BRAVE]);
});

test('pickBrowserLaunchArgs: có cả 3 → Chrome thắng', () => {
  resetAll({ browsers: [BRAVE, EDGE, CHROME] });
  assert.deepStrictEqual(ipc.pickBrowserLaunchArgs(), ['--browser', 'chrome']);
});

test('pickBrowserLaunchArgs: Edge + Brave (không Chrome) → Edge thắng', () => {
  resetAll({ browsers: [BRAVE, EDGE] });
  assert.deepStrictEqual(ipc.pickBrowserLaunchArgs(), ['--browser', 'msedge']);
});

// ==================== UNIT: ĐƯỜNG DẪN SCRIPT ====================

test('resolveMcpServerScript dev → node_modules/@playwright/mcp/cli.js trong repo', () => {
  resetAll();
  const p = ipc.resolveMcpServerScript();
  assert.strictEqual(p, path.join(REPO, MCP_CLI_REL));
});

test('resolveMcpServerScript packaged → app.asar.unpacked trong resourcesPath', () => {
  resetAll();
  electronMock.app.isPackaged = true;
  process.resourcesPath = 'X:\\Cai Dat\\resources';
  const p = ipc.resolveMcpServerScript();
  assert.strictEqual(p, path.join('X:\\Cai Dat\\resources', 'app.asar.unpacked', MCP_CLI_REL));
});

// ==================== UNIT: DỰNG ARGS MCP ====================

test('buildMcpLaunchArgs: đủ script + browser + profile riêng + caps pdf', () => {
  resetAll({ browsers: [EDGE] });
  const args = ipc.buildMcpLaunchArgs();
  assert.strictEqual(args[0], path.join(REPO, MCP_CLI_REL));
  const i = args.indexOf('--user-data-dir');
  assert.notStrictEqual(i, -1, 'thiếu --user-data-dir');
  assert.strictEqual(args[i + 1], PROFILE_DIR, 'profile phải là ~/.kv-browser-profile');
  assert.ok(args.includes('--caps') && args.includes('pdf'), 'thiếu --caps pdf (cần cho browser_pdf_save)');
  assert.deepStrictEqual(args.slice(1, 3), ['--browser', 'msedge']);
  // Log MCP phải dồn về thư mục cố định + giới hạn dung lượng (chống file rác vô hạn)
  assert.strictEqual(args[args.indexOf('--output-dir') + 1], ipc.MCP_OUTPUT_DIR);
  assert.strictEqual(args[args.indexOf('--output-max-size') + 1], String(ipc.MCP_OUTPUT_MAX_BYTES));
  assert.strictEqual(ipc.MCP_OUTPUT_DIR, path.join(os.tmpdir(), 'oa-kiotviet-mcp'));
  // Profile KHÔNG còn bị nhúng ngoặc kép (hack shell cũ) — spawn shell:false
  for (const a of args) assert.ok(!a.startsWith('"'), `args không được chứa quote: ${a}`);
});

// ==================== UNIT: CẤU HÌNH AGENT (ZERO-INSTALL) ====================

test('getAgent: spawn bằng chính Electron (execPath) + ELECTRON_RUN_AS_NODE + shell:false', () => {
  resetAll({ browsers: [CHROME] });
  const a = ipc.getAgent();
  const mcp = a._mcp;
  assert.strictEqual(mcp._command, process.execPath, 'phải chạy bằng electron.exe, không phải npx');
  assert.strictEqual(mcp._shell, false, 'phải shell:false — đường dẫn có dấu/khoảng trắng mới không vỡ');
  assert.strictEqual(mcp._env.ELECTRON_RUN_AS_NODE, '1', 'thiếu ELECTRON_RUN_AS_NODE=1');
  assert.strictEqual(mcp._timeout, 90000);
  assert.strictEqual(mcp._args[0], path.join(REPO, MCP_CLI_REL));
  assert.ok(mcp._args.includes('chrome'));
});

// ==================== HANDLER CONNECT ====================

test('connect khi máy không có browser → lỗi tiếng Việt, KHÔNG spawn gì', async () => {
  resetAll({ browsers: [] });
  const handlers = captureHandlers();
  const res = await handlers['browser-agent:connect']();
  assert.strictEqual(res.success, false);
  assert.match(res.error, /Chrome/);
  assert.match(res.error, /Edge/);
  assert.strictEqual(spawnLog.length, 0, 'không được spawn tiến trình nào khi pre-flight fail');
});

test('connect thành công qua fake MCP → spawn đúng cấu hình zero-install', async () => {
  resetAll({ browsers: [CHROME] });
  const handlers = captureHandlers();
  const res = await handlers['browser-agent:connect']();
  assert.strictEqual(res.success, true, `connect phải thành công: ${res.error || ''}`);
  assert.strictEqual(res.browserConnected, true);
  assert.strictEqual(res.tools.length, 3);
  assert.ok(res.tools.every(t => t.name.startsWith('browser_')));

  assert.strictEqual(spawnLog.length, 1, `chỉ đúng 1 lần spawn MCP server, thực tế: ${spawnLog.length}`);
  const { command, args, options } = spawnLog[0];
  assert.strictEqual(command, process.execPath);
  assert.strictEqual(args[0], path.join(REPO, MCP_CLI_REL));
  assert.ok(args.includes('--user-data-dir') && args[args.indexOf('--user-data-dir') + 1] === PROFILE_DIR);
  assert.ok(args.includes('--caps') && args.includes('pdf'));
  assert.strictEqual(args[args.indexOf('--output-dir') + 1], ipc.MCP_OUTPUT_DIR);
  assert.strictEqual(args[args.indexOf('--output-max-size') + 1], String(ipc.MCP_OUTPUT_MAX_BYTES));
  assert.strictEqual(options.shell, false);
  assert.strictEqual(options.env.ELECTRON_RUN_AS_NODE, '1');
});

test('connect chỉ có Edge → spawn với --browser msedge (fallback)', async () => {
  resetAll({ browsers: [EDGE] });
  const handlers = captureHandlers();
  const res = await handlers['browser-agent:connect']();
  assert.strictEqual(res.success, true, `connect phải thành công: ${res.error || ''}`);
  assert.ok(spawnLog[0].args.includes('msedge'));
});

test('connect làm tươi args: singleton dựng lúc chỉ có Edge, sau đó cài Chrome → dùng Chrome', async () => {
  resetAll({ browsers: [EDGE] });
  ipc.getAgent(); // singleton được tạo sớm (status polling lúc mở modal) với msedge
  browserPaths = new Set([CHROME]); // user cài Chrome khi app đang mở

  const handlers = captureHandlers();
  const res = await handlers['browser-agent:connect']();
  assert.strictEqual(res.success, true, `connect phải thành công: ${res.error || ''}`);
  assert.ok(spawnLog[0].args.includes('chrome'), 'args phải được dựng lại theo hiện trạng máy mới');
  assert.ok(!spawnLog[0].args.includes('msedge'));
});

test('connect khi spawn lỗi (ENOENT) → trả success:false, KHÔNG crash', async () => {
  resetAll({ browsers: [CHROME] });
  failNextSpawn = true;
  const handlers = captureHandlers();
  const res = await handlers['browser-agent:connect']();
  assert.strictEqual(res.success, false);
  assert.match(res.error, /ENOENT/);
});

// ==================== MCP CLIENT (shell/env/error) ====================

test('mcp-client: shell mặc định true trên Windows (nhánh npx cũ), truyền shell:false thì giữ nguyên', async () => {
  resetAll({ browsers: [] });
  const byDefault = new McpClient({ command: 'npx', args: ['-v'] });
  assert.strictEqual(byDefault._shell, process.platform === 'win32');

  const noShell = new McpClient({ command: process.execPath, args: ['-p', '1'], shell: false, timeout: 5000 });
  assert.strictEqual(noShell._shell, false);
  await noShell.connect(); // fake server bắt tay giúp
  assert.strictEqual(spawnLog.at(-1).options.shell, false, 'spawn phải nhận đúng options.shell');
  noShell.disconnect();
});

test('mcp-client: env caller được merge vào process.env khi spawn', async () => {
  resetAll({ browsers: [] });
  const c = new McpClient({ command: 'x', args: [], env: { FOO_TEST: 'bar' }, timeout: 5000 });
  await c.connect();
  assert.strictEqual(spawnLog.at(-1).options.env.FOO_TEST, 'bar');
  assert.ok('PATH' in spawnLog.at(-1).options.env || 'Path' in spawnLog.at(-1).options.env, 'process.env phải được giữ nguyên khi merge');
  c.disconnect();
});

test('mcp-client: spawn error không có listener → KHÔNG ném uncaught (trước đây crash main)', async () => {
  resetAll({ browsers: [] });
  failNextSpawn = true;
  const c = new McpClient({ command: 'x', args: [], timeout: 5000 });
  await assert.rejects(
    () => c.connect(),
    /ENOENT/,
    'connect phải reject với lỗi spawn thay vì ném uncaught exception',
  );
});

// ==================== TÍCH HỢP: HANDSHAKE THẬT (không bật Chrome) ====================
// Spawn binary Electron thật ở chế độ Node + cli.js của @playwright/mcp, bắt tay
// initialize qua stdio. KHÔNG gọi tool nào → KHÔNG có cửa sổ Chrome nào bật.

function handshakeViaRealBinary(exePath, scriptPath) {
  return new Promise((resolve, reject) => {
    const child = realSpawn(exePath, [scriptPath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    const fail = (msg) => { try { child.kill(); } catch { /* đã chết */ } reject(new Error(msg)); };
    const timer = setTimeout(() => fail(`handshake quá 20s (exe=${exePath})`), 20000);
    child.on('error', (e) => { clearTimeout(timer); fail(`spawn lỗi: ${e.message}`); });
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          clearTimeout(timer);
          child.kill();
          resolve(msg.result);
        }
      }
    });
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    }) + '\n');
  });
}

// resolve electron binary như test/browser-agent.test.js đã làm
let electronBinary = null;
try {
  const p = require('electron');
  if (typeof p === 'string' && fs.existsSync(p)) electronBinary = p;
} catch { /* không có package electron */ }

test('tích hợp: MCP cli.js bắt tay initialize thật qua Electron-as-Node (dev)', { skip: !electronBinary }, async () => {
  const cli = path.join(REPO, MCP_CLI_REL);
  assert.ok(fs.existsSync(cli), `thiếu ${cli} — chạy npm install`);
  const result = await handshakeViaRealBinary(electronBinary, cli);
  assert.strictEqual(result.serverInfo.name, 'Playwright');
});

test('tích hợp: handshake thật qua exe packaged + cli.js trong app.asar.unpacked', {
  skip: !electronBinary || !fs.existsSync(path.join(REPO, 'Ứng dụng Lên Đơn Hàng', 'win-unpacked', 'Lên đơn hàng.exe')),
}, async () => {
  const exe = path.join(REPO, 'Ứng dụng Lên Đơn Hàng', 'win-unpacked', 'Lên đơn hàng.exe');
  const cli = path.join(REPO, 'Ứng dụng Lên Đơn Hàng', 'win-unpacked', 'resources', 'app.asar.unpacked', MCP_CLI_REL);
  assert.ok(fs.existsSync(cli), `thiếu ${cli} — chạy npm run build:dir`);
  const result = await handshakeViaRealBinary(exe, cli);
  assert.strictEqual(result.serverInfo.name, 'Playwright');
});

// ── Encoding: McpClient._onData decode trên ranh giới message (bug 04/9) ────
// stdout của MCP server cắt theo byte: ký tự tiếng Việt đa byte bị xẻ giữa
// 2 chunk phải còn nguyên sau khi ghép (trước đây từng chunk toString riêng).
test('McpClient._onData: ndjson cắt giữa ký tự TV vẫn parse đúng', () => {
  const { McpClient } = require('../mcp-client');
  const c = new McpClient({ command: 'x', args: [], timeout: 1000 });
  const received = [];
  c._handleMessage = (m) => received.push(m);

  const payload = JSON.stringify({
    jsonrpc: '2.0', id: 1,
    result: { content: [{ type: 'text', text: 'Khách hàng: HĐ cập nhật — 1 thùng nhớt giá 265k — ậ ơ ư ĐĐ' }] },
  });
  const bytes = Buffer.from(payload + '\n', 'utf8');
  // Nghiền thành chunk 3 byte — cắt sai lech ranh giới ký tự đa byte
  for (let i = 0; i < bytes.length; i += 3) {
    c._onData(bytes.subarray(i, Math.min(i + 3, bytes.length)));
  }
  assert.equal(received.length, 1);
  assert.ok(received[0].result.content[0].text.includes('HĐ cập nhật'),
    'text tiếng Việt phải nguyên vẹn, got: ' + received[0].result.content[0].text);
});

test('McpClient._onData: framing Content-Length cắt giữa ký tự TV vẫn parse đúng', () => {
  const { McpClient } = require('../mcp-client');
  const c = new McpClient({ command: 'x', args: [], timeout: 1000 });
  const received = [];
  c._handleMessage = (m) => received.push(m);

  const body = JSON.stringify({
    jsonrpc: '2.0', id: 2,
    result: { orderCode: 'DH012345', customer: 'Cửa hàng Minh Khôi' },
  });
  const frame = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` + body, 'utf8');
  for (let i = 0; i < frame.length; i += 5) {
    c._onData(frame.subarray(i, Math.min(i + 5, frame.length)));
  }
  assert.equal(received.length, 1);
  assert.equal(received[0].result.orderCode, 'DH012345');
  assert.ok(received[0].result.customer.includes('Minh Khôi'),
    'tên khách tiếng Việt phải nguyên vẹn, got: ' + received[0].result.customer);
});

test('McpClient._onData: 2 message liên tiếp + byte dư cuối chunk được giữ lại', () => {
  const { McpClient } = require('../mcp-client');
  const c = new McpClient({ command: 'x', args: [], timeout: 1000 });
  const received = [];
  c._handleMessage = (m) => received.push(m);

  const mk = (id) => Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result: { note: 'Đơn Đỗ Đức Dũng — ậỡư' } }) + '\n', 'utf8');
  const all = Buffer.concat([mk(1), mk(2)]);
  // Gửi 2 message liền nhưng chunk cuối chỉ chứa MỘT PHẦN byte của message 2
  const cut = mk(2).length - 4; // dừng trước hết 4 byte cuối của message 2
  c._onData(all.subarray(0, cut));
  c._onData(all.subarray(cut));
  assert.equal(received.length, 2);
  assert.ok(received[1].result.note.includes('Đỗ Đức Dũng'));
});

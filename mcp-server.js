/**
 * =========================================================================
 *  ORDER AUTOMATION - MCP SERVER (mcp-server.js)
 * =========================================================================
 *  MCP Streamable HTTP server chạy trong Electron main process.
 *  Data vẫn nằm ở renderer (IndexedDB), nên mọi thao tác catalog/parse/export
 *  đi qua window.__ORDER_API__ bằng webContents.executeJavaScript().
 *
 *  Endpoint chuẩn: http://127.0.0.1:8048/mcp
 *  Stdio client dùng mcp-stdio-proxy.js để nối vào đúng instance app đang mở.
 * =========================================================================
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');
const { z } = require('zod');

const MCP_PORT = 8048;
const MCP_HOST = '127.0.0.1';
const MCP_PATH = '/mcp';
const MCP_VERSION = '1.0.0';

let _httpServer = null;
let _token = null;
let _getMainWindow = null;
let _lastRunResult = null;
const _sessions = new Map();

class McpToolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function plainObject() {
  return z.object({}).passthrough();
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return JSON.stringify({ success: false, error: `Không thể tuần tự hóa kết quả: ${error.message}` }, null, 2);
  }
}

function asRecord(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return { value };
}

/**
 * Strip đệ quy các key nguy hiểm (__proto__/constructor/prototype) khỏi object
 * do agent ngoài gửi trước khi dữ liệu bị merge vào DB (Object.assign sẽ set
 * qua [[Set]] → prototype pollution nếu không strip).
 */
const UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype'];

function sanitizeDeep(value, depth = 0) {
  if (depth > 12 || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => sanitizeDeep(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (!UNSAFE_KEYS.includes(k)) out[k] = sanitizeDeep(v, depth + 1);
  }
  return out;
}

function toolResult(value) {
  const data = asRecord(value);
  return {
    content: [{ type: 'text', text: safeJson(data) }],
    structuredContent: data,
  };
}

function toolFailure(error) {
  const code = error && error.code ? error.code : 'TOOL_ERROR';
  const message = error && error.message ? error.message : String(error || 'Lỗi không xác định');
  const data = { success: false, error: message, code };
  return {
    content: [{ type: 'text', text: safeJson(data) }],
    structuredContent: data,
    isError: true,
  };
}

/**
 * Tự vá text tiếng Việt bị UTF-8 decode nhầm Latin-1/Windows-1252.
 */
function repairMojibake(text) {
  if (typeof text !== 'string' || text.length < 3) return text;
  const suspect = /[\u00c3-\u00c5][\u0080-\u00bf\u00a0-\u00ff]/.test(text)
    || /[\u00e1-\u00e3][\u00bb-\u00bf]/.test(text);
  if (!suspect) return text;

  let repaired;
  try {
    repaired = Buffer.from(text, 'latin1').toString('utf8');
  } catch (_) {
    return text;
  }
  if (repaired === text || repaired.includes('\ufffd')) return text;

  const mojibakeCount = (value) => (value.match(/[\u00c3-\u00c5][\u0080-\u00bf\u00a0-\u00ff]|[\u00e1-\u00e3][\u00bb-\u00bf]/g) || []).length
    + (value.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g) || []).length;
  const vietnameseScore = (value) => (value.match(/[ăâêôơưđàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/gi) || []).length;

  return mojibakeCount(repaired) < mojibakeCount(text)
    && vietnameseScore(repaired) >= vietnameseScore(text)
    ? repaired
    : text;
}

function repairOrderTextEncoding(orderData) {
  if (!orderData || typeof orderData !== 'object') return orderData;
  const out = { ...orderData };
  for (const key of ['customer', 'customerName', 'note', 'notes', 'receiver', 'salesman']) {
    if (typeof out[key] === 'string') out[key] = repairMojibake(out[key]);
  }
  if (Array.isArray(out.items)) {
    out.items = out.items.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const fixed = { ...item };
      for (const key of ['name', 'productName', 'rawProduct', 'note']) {
        if (typeof fixed[key] === 'string') fixed[key] = repairMojibake(fixed[key]);
      }
      return fixed;
    });
  }
  return out;
}

function normalizeOrderData(orderData) {
  if (!orderData || typeof orderData !== 'object') return orderData;
  const rawItems = Array.isArray(orderData.items) ? orderData.items : [];
  const items = rawItems.map((item) => {
    const code = item.code || item.kvCode || '';
    const name = item.name || item.productName || item.rawProduct || '';
    const unit = item.unit || 'thùng';
    // qty bắt buộc là số nguyên > 0 khi có gửi — không được câm lặng ép thành 1
    // (bug cũ: "abc"/0/-3/2.7 đều chui qua rồi browser fill parseInt || 1).
    let qty = 1;
    if (item.qty != null && item.qty !== '') {
      qty = Number(item.qty);
      if (!Number.isFinite(qty) || !Number.isInteger(qty) || qty <= 0) {
        throw new McpToolError('INVALID_ORDER',
          `Item qty không hợp lệ: ${JSON.stringify(item)} — qty phải là số nguyên > 0.`);
      }
    }
    let price = 0;
    if (item.price !== undefined && item.price !== null) price = Number(item.price);
    else if (item.unitPrice !== undefined && item.unitPrice !== null) price = Number(item.unitPrice);
    return { ...item, code, name, unit, qty, price, isGift: !!item.isGift };
  });

  return {
    ...orderData,
    customer: String(orderData.customer || orderData.customerName || '').trim(),
    receiver: String(orderData.receiver || orderData.salesman || '').trim(),
    payment: orderData.payment || 'ck',
    note: String(orderData.note || orderData.notes || '').trim(),
    items,
  };
}

function getTokenFilePath() {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'mcp-token.txt');
  } catch (_) {
    return null;
  }
}

function ensureToken() {
  if (_token) return _token;
  if (process.env.ORDER_AUTOMATION_MCP_TOKEN) {
    _token = process.env.ORDER_AUTOMATION_MCP_TOKEN;
    return _token;
  }

  const tokenPath = getTokenFilePath();
  if (tokenPath) {
    try {
      if (fs.existsSync(tokenPath)) {
        const token = fs.readFileSync(tokenPath, 'utf8').trim();
        if (token.length >= 32) {
          _token = token;
          return _token;
        }
      }
      _token = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(tokenPath, _token, { encoding: 'utf8', mode: 0o600 });
      console.log(`[MCP Server] MCP token written to: ${tokenPath}`);
      return _token;
    } catch (error) {
      console.warn('[MCP Server] Could not persist MCP token:', error.message);
    }
  }

  _token = crypto.randomBytes(32).toString('hex');
  return _token;
}

function getToken() {
  return ensureToken();
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function tokenFromRequest(extra) {
  const headers = (extra && extra.requestInfo && extra.requestInfo.headers) || {};
  const authorization = headers.authorization || headers.Authorization || '';
  const bearer = String(authorization).replace(/^Bearer\s+/i, '');
  return headers['x-auth-token'] || headers['X-Auth-Token'] || bearer;
}

function requireMutationToken(extra) {
  if (safeEqual(tokenFromRequest(extra), ensureToken())) return;
  const tokenPath = getTokenFilePath() || 'unavailable (set ORDER_AUTOMATION_MCP_TOKEN)';
  throw new McpToolError(
    'UNAUTHORIZED',
    `Unauthorized: gửi Authorization: Bearer <token> hoặc X-Auth-Token. Token local: ${tokenPath}`,
  );
}

function isAllowedOrigin(originHeader) {
  if (!originHeader) return true;
  const origin = String(originHeader).toLowerCase().trim();
  // Không chấp nhận "null" (file://, sandboxed iframe) — chỉ origin localhost thật.
  return origin.startsWith('http://127.0.0.1:')
    || origin.startsWith('http://localhost:')
    || origin.startsWith('https://127.0.0.1:')
    || origin.startsWith('https://localhost:');
}

// Port thật đang listen (khác MCP_PORT khi chạy isolated qua OA_MCP_PORT/port 0).
function actualPort() {
  const address = _httpServer && _httpServer.address();
  return address && typeof address === 'object' ? address.port : MCP_PORT;
}

function isLocalHost(hostHeader) {
  if (!hostHeader || !_httpServer) return false;
  const port = actualPort();
  const host = String(hostHeader).toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (!origin || !isAllowedOrigin(origin)) return;
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Auth-Token, Mcp-Protocol-Version, Mcp-Session-Id');
}

function sendJsonRpcError(res, status, code, message) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  }));
}

function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const body = await readBody(req);
  if (!body.trim()) throw new McpToolError('PARSE_ERROR', 'JSON-RPC body trống');
  try {
    return JSON.parse(body);
  } catch (_) {
    throw new McpToolError('PARSE_ERROR', 'JSON-RPC body không hợp lệ');
  }
}

function emitActivity(entry) {
  try {
    const win = _getMainWindow && _getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('agent-activity', entry);
  } catch (_) {
    // Activity feed không được phép làm hỏng MCP response.
  }
}

function browserAgentStatus() {
  try {
    const { getAgent } = require('./browser-agent-ipc');
    const agent = getAgent();
    return {
      connected: agent.isConnected(),
      running: !!agent._running,
      stepCount: agent._stepCount || 0,
    };
  } catch (error) {
    return { connected: false, running: false, error: error.message };
  }
}

function appVersion() {
  try {
    return require('./package.json').version;
  } catch (_) {
    return 'unknown';
  }
}

function isWindowReady() {
  try {
    const win = _getMainWindow && _getMainWindow();
    return !!(win && !win.isDestroyed());
  } catch (_) {
    return false;
  }
}

function serverInfo() {
  return {
    success: true,
    app: 'order-automation',
    appVersion: appVersion(),
    mcpVersion: MCP_VERSION,
    endpoint: `http://${MCP_HOST}:${actualPort()}${MCP_PATH}`,
    windowOpen: isWindowReady(),
    capabilities: {
      salesMessageParsing: true,
      dataCrud: true,
      excelExport: true,
      kiotvietAutomation: true,
      aiConfig: true,
      browserControl: true,
    },
    auth: {
      writeTools: 'Authorization: Bearer <token> hoặc X-Auth-Token',
      tokenPath: getTokenFilePath(),
      envOverride: 'ORDER_AUTOMATION_MCP_TOKEN',
      stdioProxyEnv: 'ORDER_AUTOMATION_MCP_TOKEN',
    },
    browserAgent: browserAgentStatus(),
  };
}

/**
 * Chạy phương thức HeadlessOrderAPI ở renderer mà không inject dữ liệu vào JS.
 */
async function callRendererApi(method, args = []) {
  let win;
  try {
    win = _getMainWindow && _getMainWindow();
  } catch (_) {
    win = null;
  }
  if (!win || win.isDestroyed()) {
    return {
      success: false,
      errCode: 'APP_NOT_READY',
      error: 'App window not available. Is the app fully loaded? (Retry when window is ready)',
    };
  }

  const methodJson = JSON.stringify(String(method));
  const argsJson = JSON.stringify(Array.isArray(args) ? args : []);
  // Gọi dạng member api[<method>](...) — destructure ra biến rồi gọi sẽ mất
  // `this` của HeadlessOrderAPI (vd parse() gọi this.parseOffline → crash).
  const script = `(async () => {
    try {
      const api = window.__ORDER_API__;
      if (!api) return { success: false, errCode: 'APP_NOT_READY', error: 'ORDER_API not initialized yet' };
      if (typeof api[${methodJson}] !== 'function') return { success: false, error: 'ORDER_API method not found: ' + ${methodJson} };
      return await api[${methodJson}](...${argsJson});
    } catch (error) {
      return { success: false, error: error && error.message ? error.message : String(error) };
    }
  })()`;

  try {
    return await win.webContents.executeJavaScript(script, true);
  } catch (error) {
    return { success: false, error: `Renderer execution failed: ${error.message}` };
  }
}

async function renderer(method, args) {
  const result = await callRendererApi(method, args);
  if (!result || result.success === false) {
    throw new McpToolError((result && result.errCode) || 'RENDERER_ERROR', (result && result.error) || 'Renderer không trả kết quả');
  }
  return result;
}

function getBrowserAgent() {
  const { getAgent } = require('./browser-agent-ipc');
  return getAgent();
}

function requireBrowserAgent() {
  const agent = getBrowserAgent();
  if (!agent.isConnected()) {
    throw new McpToolError('BROWSER_NOT_CONNECTED', 'Browser chưa kết nối. Gọi tool connect_browser trước hoặc kết nối trong giao diện app.');
  }
  return agent;
}

/**
 * Cập nhật _lastRunResult sau khi runDirectOrder resolve. runDirectOrder giờ
 * luôn trả { success, aborted?, orderCode?, error? } — kể cả abort/lỗi nội bộ
 * (trước đây resolve undefined ở mọi nhánh nên .then() gán success:true oan).
 */
function applyRunOutcome(result, agent) {
  const aborted = !!(result && result.aborted) || !!(agent && agent._aborted);
  const failed = aborted || !result || result.success === false;
  _lastRunResult = {
    ..._lastRunResult,
    finishedAt: new Date().toISOString(),
    success: !failed,
    orderCode: (result && result.orderCode) || null,
    error: aborted
      ? ((result && result.error) || 'aborted by user/MCP client')
      : (failed ? ((result && result.error) || 'run failed without error message') : null),
  };
  return _lastRunResult;
}

function startKiotVietOrder(orderData, options = {}) {
  // Validate order TRƯỚC khi đòi browser connected — lỗi dữ liệu phải rõ ràng,
  // không bị nuốt vào BROWSER_NOT_CONNECTED.
  const normalizedOrder = normalizeOrderData(repairOrderTextEncoding(orderData));
  if (!normalizedOrder || !normalizedOrder.customer || !Array.isArray(normalizedOrder.items) || !normalizedOrder.items.length) {
    throw new McpToolError('INVALID_ORDER', 'Thiếu orderData { customer, items: [{ code, name, qty, unit, price }] }');
  }
  const agent = requireBrowserAgent();

  _lastRunResult = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    success: null,
    orderCode: null,
    error: null,
    customer: normalizedOrder.customer,
    itemCount: normalizedOrder.items.length,
  };

  agent.runDirectOrder(normalizedOrder, {
    mode: options.mode === 'supplement' ? 'supplement' : 'new',
    fallbackToAI: true,
    skipVerify: !!options.skipVerify,
    autoSubmit: !!options.autoSubmit,
    savePdf: !!options.savePdf,
    aiConfig: options.aiConfig || {},
  }).then((result) => {
    applyRunOutcome(result, agent);
  }).catch((error) => {
    console.error('[MCP Server] KiotViet order error:', error.message);
    _lastRunResult = {
      ..._lastRunResult,
      finishedAt: new Date().toISOString(),
      success: false,
      error: error.message,
    };
  });

  return { success: true, started: true, poll: 'get_run_status' };
}

function registerTool(server, name, config, handler, { requiresToken = false } = {}) {
  // SDK gọi handler theo 2 kiểu: có inputSchema → handler(args, extra);
  // không inputSchema → handler(extra). Chuẩn hóa để auth luôn thấy extra.
  server.registerTool(name, config, async (...handlerArgs) => {
    const input = handlerArgs.length >= 2 ? handlerArgs[0] : undefined;
    const extra = handlerArgs.length >= 2 ? handlerArgs[1] : handlerArgs[0];
    try {
      if (requiresToken) requireMutationToken(extra);
      const data = await handler(input, extra);
      const result = toolResult(data);
      emitActivity({
        ts: Date.now(),
        method: 'MCP',
        path: `${MCP_PATH}/${name}`,
        status: 200,
        code: 0,
        label: config.title || name,
      });
      return result;
    } catch (error) {
      const status = error && error.code === 'UNAUTHORIZED' ? 401
        : error && (error.code === 'APP_NOT_READY' || error.code === 'RENDERER_ERROR') ? 503
          : error && (error.code === 'BROWSER_NOT_CONNECTED' || error.code === 'TASK_RUNNING') ? 409
            : 400;
      emitActivity({
        ts: Date.now(),
        method: 'MCP',
        path: `${MCP_PATH}/${name}`,
        status,
        code: 1,
        message: error && error.message ? error.message.slice(0, 200) : String(error).slice(0, 200),
        label: config.title || name,
      });
      return toolFailure(error);
    }
  });
}

function createMcpServer() {
  const server = new McpServer({
    name: 'order-automation',
    version: MCP_VERSION,
  }, {
    instructions: 'Dùng tool để đọc dữ liệu trước. Các tool ghi/xóa/xuất file/lên đơn cần token local và các tool phá hủy yêu cầu confirm: true.',
  });

  registerTool(server, 'get_server_info', {
    title: 'Thông tin MCP server',
    description: 'Lấy trạng thái app, endpoint MCP, đường dẫn token local và các khả năng được hỗ trợ.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => serverInfo());

  registerTool(server, 'get_status', {
    title: 'Trạng thái ứng dụng',
    description: 'Kiểm tra cửa sổ app và trạng thái kết nối/chạy của Browser Agent KiotViet.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => ({
    success: true,
    app: 'order-automation',
    mcpVersion: MCP_VERSION,
    windowOpen: isWindowReady(),
    browserAgent: browserAgentStatus(),
  }));

  registerTool(server, 'get_run_status', {
    title: 'Trạng thái tiến trình KiotViet',
    description: 'Lấy trạng thái Browser Agent, 50 log gần nhất và kết quả chạy đơn KiotViet mới nhất.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const agent = getBrowserAgent();
    return {
      success: true,
      browserAgent: browserAgentStatus(),
      lastRun: _lastRunResult,
      logs: typeof agent.getLogs === 'function' ? agent.getLogs(50) : [],
    };
  });

  registerTool(server, 'abort_run', {
    title: 'Hủy tiến trình KiotViet',
    description: 'Gửi tín hiệu dừng ngay tiến trình Browser Agent đang lên đơn KiotViet.',
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const agent = getBrowserAgent();
    agent.abort();
    if (_lastRunResult && !_lastRunResult.finishedAt) {
      _lastRunResult = {
        ..._lastRunResult,
        finishedAt: new Date().toISOString(),
        success: false,
        error: 'aborted by MCP client',
      };
    }
    return { success: true, aborted: true };
  }, { requiresToken: true });

  registerTool(server, 'get_db_info', {
    title: 'Tóm tắt danh mục',
    description: 'Lấy số lượng sản phẩm, alias và campaign trong database hiện tại.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => renderer('getDbInfo'));

  registerTool(server, 'get_products', {
    title: 'Tìm sản phẩm',
    description: 'Liệt kê sản phẩm theo campaign hoặc từ khóa; trả giá bậc, alias và mã KiotViet đã resolve.',
    inputSchema: {
      campaign: z.string().optional().describe('Campaign key để lọc, ví dụ xvil.'),
      q: z.string().optional().describe('Từ khóa tên/spec/alias/mã KiotViet.'),
      limit: z.number().int().positive().max(500).optional().describe('Số kết quả tối đa.'),
      offset: z.number().int().nonnegative().optional().describe('Vị trí phân trang.'),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async (input) => renderer('getProducts', [input]));

  registerTool(server, 'upsert_product', {
    title: 'Thêm hoặc sửa sản phẩm',
    description: 'Tạo sản phẩm khi chưa có product.id (cần campaign + product.name), hoặc cập nhật sản phẩm có product.id (không cần name — chỉ gửi trường muốn sửa). Hỗ trợ tiers, aliases, kvCode và kvCodeThung.',
    inputSchema: {
      campaign: z.string().optional().describe('Campaign key, bắt buộc khi tạo mới.'),
      product: z.object({
        id: z.string().optional(),
        name: z.string().trim().min(1).optional().describe('Tên sản phẩm; bắt buộc khi tạo mới, tùy chọn khi cập nhật theo id.'),
      }).passthrough().describe('Dữ liệu sản phẩm cần thêm hoặc cập nhật.'),
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ campaign, product }) => {
    if (!(product && product.id) && !(product && String(product.name || '').trim())) {
      throw new McpToolError('INVALID_PARAMS', 'Cần product.id (cập nhật theo id) hoặc product.name (tạo mới).');
    }
    return renderer('upsertProduct', [{ campaign, product }]);
  }, { requiresToken: true });

  registerTool(server, 'delete_product', {
    title: 'Xóa sản phẩm',
    description: 'Xóa vĩnh viễn sản phẩm, alias và mã KiotViet liên quan. Phải xác nhận rõ bằng confirm: true.',
    inputSchema: {
      id: z.string().trim().min(1).describe('Product ID cần xóa.'),
      confirm: z.literal(true).describe('Bắt buộc true vì thao tác không thể hoàn tác.'),
    },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ id }) => renderer('deleteProduct', [{ id }]), { requiresToken: true });

  registerTool(server, 'get_campaigns', {
    title: 'Danh sách campaign',
    description: 'Lấy metadata campaign; includeProducts=true để kèm sản phẩm và chương trình khuyến mãi.',
    inputSchema: {
      includeProducts: z.boolean().optional().default(false).describe('Có trả toàn bộ sản phẩm trong mỗi campaign hay không.'),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ includeProducts }) => renderer('getCampaigns', [{ includeProducts }]));

  registerTool(server, 'add_campaign', {
    title: 'Thêm campaign',
    description: 'Tạo campaign mới. key chỉ gồm chữ, số và dấu gạch dưới.',
    inputSchema: {
      key: z.string().regex(/^[a-z0-9_]+$/i).describe('Campaign key bất biến.'),
      campaign: plainObject().optional().default({}).describe('Metadata campaign: name, brand, color, icon, promoRules...'),
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ key, campaign }) => renderer('addCampaign', [{ key, ...sanitizeDeep(campaign) }]), { requiresToken: true });

  registerTool(server, 'update_campaign', {
    title: 'Sửa campaign',
    description: 'Cập nhật metadata hoặc promoRules của campaign hiện có.',
    inputSchema: {
      key: z.string().trim().min(1).describe('Campaign key.'),
      updates: plainObject().describe('Các trường cần cập nhật.'),
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ key, updates }) => renderer('updateCampaign', [{ key, updates: sanitizeDeep(updates) }]), { requiresToken: true });

  registerTool(server, 'delete_campaign', {
    title: 'Xóa campaign',
    description: 'Xóa vĩnh viễn campaign. force=true mới xóa campaign còn sản phẩm; luôn cần confirm: true.',
    inputSchema: {
      key: z.string().trim().min(1).describe('Campaign key cần xóa.'),
      force: z.boolean().optional().default(false).describe('Cho phép xóa cả sản phẩm còn lại.'),
      confirm: z.literal(true).describe('Bắt buộc true vì thao tác không thể hoàn tác.'),
    },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ key, force }) => renderer('deleteCampaign', [{ key, force }]), { requiresToken: true });

  registerTool(server, 'get_aliases', {
    title: 'Danh sách alias',
    description: 'Lấy mapping alias sản phẩm sau khi gộp alias mặc định và alias người dùng.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => renderer('getAliases'));

  registerTool(server, 'set_aliases', {
    title: 'Lưu alias sản phẩm',
    description: 'Thay toàn bộ alias của một sản phẩm; alias cũ không còn trong danh sách sẽ bị gỡ.',
    inputSchema: {
      productId: z.string().trim().min(1).describe('Product ID.'),
      aliases: z.array(z.string()).describe('Danh sách alias thay thế hoàn toàn alias cũ.'),
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => renderer('setAliases', [input]), { requiresToken: true });

  registerTool(server, 'get_kv_map', {
    title: 'Mã KiotViet',
    description: 'Lấy mapping mã KiotViet base và mã thùng theo product ID.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => renderer('getKvMap'));

  registerTool(server, 'set_kv_code', {
    title: 'Lưu mã KiotViet',
    description: 'Đặt mã KiotViet base và/hoặc mã thùng override cho một sản phẩm. Mã kvCode vẫn tuân thủ bất biến của app.',
    inputSchema: {
      productId: z.string().trim().min(1).describe('Product ID.'),
      base: z.string().optional().describe('Mã đơn vị lẻ; chuỗi rỗng để xóa override.'),
      thung: z.string().optional().describe('Mã thùng override; chuỗi rỗng để tự suy base + -1.'),
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => renderer('setKvCode', [input]), { requiresToken: true });

  registerTool(server, 'get_memory', {
    title: 'Bộ nhớ quy tắc AI',
    description: 'Lấy text quy tắc được đưa vào prompt phân tích đơn hàng.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => renderer('getMemory'));

  registerTool(server, 'set_memory', {
    title: 'Lưu bộ nhớ quy tắc AI',
    description: 'Thay nội dung bộ nhớ quy tắc AI dùng khi phân tích đơn hàng.',
    inputSchema: {
      text: z.string().describe('Toàn bộ nội dung quy tắc AI mới.'),
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => renderer('setMemory', [input]), { requiresToken: true });

  registerTool(server, 'get_sellers', {
    title: 'Danh sách nhân viên sales',
    description: 'Lấy danh sách sales và tiền tố mã đơn theo brand.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => renderer('getSellers'));

  registerTool(server, 'save_sellers', {
    title: 'Lưu nhân viên sales',
    description: 'Cập nhật danh sách sales và/hoặc tiền tố mã đơn theo brand.',
    inputSchema: {
      sellers: z.array(plainObject()).optional().describe('Danh sách nhân viên sales mới.'),
      brandPrefixes: plainObject().optional().describe('Mapping brand sang tiền tố mã đơn.'),
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => renderer('saveSellers', [input]), { requiresToken: true });

  registerTool(server, 'get_current_order', {
    title: 'Đơn hàng hiện tại',
    description: 'Lấy đơn đang mở trên giao diện, gồm giá, FOC và mã KiotViet đã tính.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => renderer('getCurrentOrder'));

  registerTool(server, 'export_database', {
    title: 'Xuất database',
    description: 'Lấy toàn bộ database hiện tại để sao lưu trước khi import hoặc reset.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => renderer('exportDatabase'));

  registerTool(server, 'import_database', {
    title: 'Nhập database',
    description: 'Ghi đè database từ dữ liệu export trước đó (object có database.campaigns, hoặc chuỗi JSON export). Phải xác nhận rõ bằng confirm: true.',
    inputSchema: {
      data: z.unknown().describe('Object database export hoặc chuỗi JSON export.'),
      confirm: z.literal(true).describe('Bắt buộc true vì thao tác ghi đè dữ liệu hiện tại.'),
    },
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ data }) => {
    // Validate shape NGAY TRƯỚC khi ghi đè — đừng để db.importJSON nuốt lỗi
    // "Invalid format" thành false câm lặng trên dữ liệu rác.
    let parsed = data;
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); } catch (_) {
        throw new McpToolError('INVALID_IMPORT', 'data là chuỗi nhưng không parse được JSON.');
      }
    }
    const looksLikeExport = !!(parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && ((parsed.database && typeof parsed.database === 'object' && parsed.database.campaigns) || parsed.campaigns));
    if (!looksLikeExport) {
      throw new McpToolError('INVALID_IMPORT',
        'data phải là object export từ export_database (có database.campaigns hoặc campaigns).');
    }
    return renderer('importDatabase', [{ data: sanitizeDeep(parsed) }]);
  }, { requiresToken: true });

  registerTool(server, 'reset_database', {
    title: 'Reset database',
    description: 'Xóa dữ liệu tùy chỉnh và reset database về mặc định gốc. Phải xác nhận rõ bằng confirm: true.',
    inputSchema: {
      confirm: z.literal(true).describe('Bắt buộc true vì thao tác không thể hoàn tác.'),
    },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => renderer('resetDatabase'), { requiresToken: true });

  registerTool(server, 'parse_order', {
    title: 'Phân tích đơn hàng',
    description: 'Phân tích tin nhắn sales bằng AI hoặc offline parser, trả sản phẩm, giá bậc và quà khuyến mãi. Không thay đổi dữ liệu catalog.',
    inputSchema: {
      text: z.string().trim().min(1).describe('Tin nhắn đơn hàng thô của sales.'),
      mode: z.enum(['auto', 'ai', 'offline']).optional().default('auto').describe('auto mặc định; ai ép AI; offline chỉ dùng regex/fuzzy.'),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ text, mode }) => renderer('parse', [repairMojibake(text), { mode }]));

  registerTool(server, 'parse_order_offline', {
    title: 'Phân tích đơn hàng offline',
    description: 'Phân tích deterministic bằng regex và fuzzy matching, không gọi AI.',
    inputSchema: {
      text: z.string().trim().min(1).describe('Tin nhắn đơn hàng thô của sales.'),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ text }) => renderer('parseOffline', [repairMojibake(text)]));

  registerTool(server, 'get_ai_status', {
    title: 'Trạng thái AI profile',
    description: 'Lấy strategy, profile đang bật và trạng thái key đã mask. Không bao giờ trả API key.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => renderer('getAiStatus'));

  registerTool(server, 'test_ai_profiles', {
    title: 'Test AI profile',
    description: 'Test kết nối một AI profile theo id hoặc mọi profile đang bật. Có thể tốn quota API.',
    inputSchema: {
      id: z.string().optional().describe('AI profile ID; bỏ trống để test mọi profile đang bật.'),
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input) => renderer('testAiProfiles', [input]), { requiresToken: true });

  registerTool(server, 'manage_ai_profiles', {
    title: 'Quản lý AI profile',
    description: 'Tạo, cập nhật hoặc xóa AI profile; apiKey chỉ gửi khi cần đổi key và sẽ không được trả về.',
    inputSchema: {
      profiles: z.array(plainObject()).optional().describe('Profile mới/cập nhật; apiKey không gửi sẽ giữ key cũ.'),
      strategy: z.enum(['failover', 'roundrobin']).optional().describe('Chiến lược dùng nhiều profile.'),
      activeId: z.string().optional().describe('Profile ID đang được ưu tiên.'),
      deleteIds: z.array(z.string()).optional().describe('Các profile ID cần xóa.'),
    },
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (input) => renderer('setAiProfiles', [input]), { requiresToken: true });

  registerTool(server, 'export_excel', {
    title: 'Xuất Excel',
    description: 'Xuất file Excel đơn hàng thật qua template app. Dùng order.dryRun=true để kiểm tra payload trước khi ghi file.',
    inputSchema: {
      order: z.object({
        customer: z.string().trim().min(1).optional(),
        customerName: z.string().trim().min(1).optional(),
        items: z.array(plainObject()).min(1).describe('Các dòng sản phẩm cần xuất.'),
      }).passthrough().describe('Dữ liệu đơn hàng: customer, items, payment, seller, note, dryRun...'),
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ order }) => renderer('exportOrderToExcel', [repairOrderTextEncoding(order)]), { requiresToken: true });

  registerTool(server, 'connect_browser', {
    title: 'Kết nối trình duyệt KiotViet',
    description: 'Kết nối hoặc khởi động BrowserMCP bằng Chrome, Edge hoặc Brave với profile KiotViet đã lưu.',
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => {
    const agent = getBrowserAgent();
    if (!agent.isConnected()) await agent.connect();
    await agent.getPageSnapshot();
    return { success: true, connected: true };
  }, { requiresToken: true });

  registerTool(server, 'get_browser_tools', {
    title: 'Danh sách tool trình duyệt',
    description: 'Liệt kê các tool Playwright MCP browser_* đang khả dụng sau khi kết nối trình duyệt.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  }, async () => {
    const agent = requireBrowserAgent();
    return { success: true, tools: (agent.getStatus().tools || []) };
  });

  registerTool(server, 'get_browser_snapshot', {
    title: 'Đọc trang trình duyệt',
    description: 'Lấy accessibility tree của trang KiotViet hiện tại, gồm ref cần dùng cho execute_browser_tool.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  }, async () => {
    const agent = requireBrowserAgent();
    return { success: true, snapshot: await agent.getPageSnapshot() };
  });

  registerTool(server, 'execute_browser_tool', {
    title: 'Thao tác trình duyệt',
    description: 'Gọi một Playwright tool browser_* trên trình duyệt KiotViet đã kết nối. Không chạy khi app đang tự lên đơn.',
    inputSchema: {
      tool: z.string().regex(/^browser_/).describe('Tên Playwright MCP tool bắt đầu bằng browser_, ví dụ browser_click.'),
      args: plainObject().optional().default({}).describe('Đối số của browser tool, thường dùng ref từ get_browser_snapshot.'),
    },
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ tool, args }) => {
    const agent = getBrowserAgent();
    if (agent._running) {
      throw new McpToolError('TASK_RUNNING', 'Agent đang chạy đơn KiotViet. Chờ get_run_status hoàn tất trước khi thao tác trình duyệt.');
    }
    if (!agent.isConnected()) {
      throw new McpToolError('BROWSER_NOT_CONNECTED', 'Browser chưa kết nối. Gọi tool connect_browser trước.');
    }
    return { success: true, ...(await agent.executeActionRaw(tool, args)) };
  }, { requiresToken: true });

  registerTool(server, 'auto_run_order', {
    title: 'Tự động chạy đơn',
    description: 'Phân tích tin nhắn sales, đồng bộ đơn lên giao diện, rồi tùy chọn xuất Excel và/hoặc khởi chạy KiotViet.',
    inputSchema: {
      text: z.string().trim().min(1).describe('Tin nhắn đơn hàng thô của sales.'),
      mode: z.enum(['auto', 'ai', 'offline']).optional().default('auto').describe('Chế độ parse.'),
      action: z.enum(['kiotviet', 'excel', 'both', 'parse-only']).optional().default('kiotviet').describe('Đích thực thi sau khi parse.'),
      options: plainObject().optional().default({}).describe('Tùy chọn KiotViet: mode, skipVerify, autoSubmit, savePdf, aiConfig.'),
      seller: z.string().trim().optional().default('').describe('Tên người nhận đặt trên KiotViet. Thiếu thì để trống.'),
    },
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ text, mode, action, options, seller }) => {
    const parsed = await renderer('parseOrderToRunFormat', [repairMojibake(text), { mode, seller }]);
    if (!parsed.orderData) throw new McpToolError('PARSE_FAILED', parsed.error || 'Không phân tích được đơn hàng');

    const normalizedOrder = normalizeOrderData(parsed.orderData);
    let excel = null;
    let kiotvietStarted = false;
    if (action === 'excel' || action === 'both') {
      excel = await renderer('exportOrderToExcel', [normalizedOrder]);
    }
    if (action === 'kiotviet' || action === 'both') {
      startKiotVietOrder(normalizedOrder, options);
      kiotvietStarted = true;
    }
    return {
      success: true,
      customer: normalizedOrder.customer,
      itemCount: normalizedOrder.items.length,
      orderData: normalizedOrder,
      kiotvietStarted,
      excel,
      poll: 'get_run_status',
    };
  }, { requiresToken: true });

  registerTool(server, 'run_kiotviet_order', {
    title: 'Lên đơn KiotViet',
    description: 'Khởi chạy Browser Agent để điền và tùy chọn submit một đơn đã chuẩn hóa lên KiotViet.',
    inputSchema: {
      orderData: z.object({
        customer: z.string().trim().min(1).optional(),
        customerName: z.string().trim().min(1).optional(),
        items: z.array(plainObject()).min(1).describe('Các dòng cần lên đơn.'),
      }).passthrough().describe('Đơn hàng có customer và items.'),
      options: plainObject().optional().default({}).describe('mode=new|supplement, autoSubmit, skipVerify, savePdf, aiConfig.'),
    },
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ orderData, options }) => startKiotVietOrder(orderData, options), { requiresToken: true });

  return server;
}

async function handleMcpRequest(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${MCP_HOST}:${MCP_PORT}`}`);
  if (!isLocalHost(req.headers.host)) {
    sendJsonRpcError(res, 403, -32000, 'Forbidden: invalid Host header');
    return;
  }
  if (!isAllowedOrigin(req.headers.origin)) {
    sendJsonRpcError(res, 403, -32000, 'Forbidden: cross-origin requests are not allowed');
    return;
  }

  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (url.pathname !== MCP_PATH) {
    sendJsonRpcError(res, 404, -32601, `Not found. MCP endpoint: ${MCP_PATH}`);
    return;
  }

  const sessionId = req.headers['mcp-session-id'];
  const existing = typeof sessionId === 'string' ? _sessions.get(sessionId) : null;
  if (existing) {
    const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
    await existing.transport.handleRequest(req, res, body);
    return;
  }

  if (req.method !== 'POST') {
    sendJsonRpcError(res, 400, -32000, 'Bad Request: khởi tạo MCP session bằng POST initialize trước.');
    return;
  }

  const body = await readJsonBody(req);
  if (!isInitializeRequest(body)) {
    sendJsonRpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id không hợp lệ hoặc thiếu initialize.');
    return;
  }

  let entry;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (id) => {
      _sessions.set(id, entry);
    },
    onsessionclosed: (id) => {
      _sessions.delete(id);
    },
  });
  transport.onerror = (error) => {
    console.warn('[MCP Server] Transport error:', error.message);
  };

  const server = createMcpServer();
  entry = { server, transport };
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

function start(port, getMainWindow) {
  if (_httpServer) {
    console.log('[MCP Server] Already running.');
    return _httpServer;
  }

  _getMainWindow = getMainWindow;
  const mcpPort = port !== undefined && port !== null && port !== '' ? Number(port) : MCP_PORT;
  _httpServer = http.createServer((req, res) => {
    handleMcpRequest(req, res).catch((error) => {
      const status = error && error.code === 'PARSE_ERROR' ? 400 : 500;
      sendJsonRpcError(res, status, status === 400 ? -32700 : -32603, error.message || 'Internal MCP server error');
    });
  });

  _httpServer.listen(mcpPort, MCP_HOST, () => {
    const address = _httpServer.address();
    const actualPort = address && typeof address === 'object' ? address.port : mcpPort;
    console.log(`[MCP Server] Listening on http://${MCP_HOST}:${actualPort}${MCP_PATH} (local only)`);
  });
  _httpServer.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.warn(`[MCP Server] Port ${mcpPort} already in use — MCP disabled.`);
    } else {
      console.error('[MCP Server] Error:', error.message);
    }
    _httpServer = null;
  });
  return _httpServer;
}

async function stop() {
  const entries = [..._sessions.values()];
  _sessions.clear();
  await Promise.allSettled(entries.map(({ server }) => server.close()));
  if (_httpServer) {
    const server = _httpServer;
    _httpServer = null;
    await new Promise((resolve) => server.close(resolve));
    console.log('[MCP Server] Stopped.');
  }
}

module.exports = {
  start,
  stop,
  getToken,
  MCP_PORT,
  MCP_PATH,
  readBody,
  repairMojibake,
  normalizeOrderData,
  repairOrderTextEncoding,
  callRendererApi,
  createMcpServer,
  applyRunOutcome,
  sanitizeDeep,
};

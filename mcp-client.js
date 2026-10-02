/**
 * =========================================================================
 *  ORDER AUTOMATION - MCP CLIENT (mcp-client.js)
 * =========================================================================
 *  Spawns Playwright MCP server as a child process and communicates via
 *  stdio JSON-RPC 2.0. The server launches Chrome with a persistent
 *  user profile (login saved to disk). Exposes browser tools (click, type,
 *  navigate, snapshot, evaluate, etc.) to the Electron main process.
 *
 *  Máy người dùng KHÔNG cần cài Node.js: browser-agent-ipc.js truyền
 *  command = process.execPath (electron.exe) + env ELECTRON_RUN_AS_NODE=1,
 *  trỏ thẳng vào cli.js của @playwright/mcp đóng gói sẵn trong app
 *  (asar.unpacked). Shell luôn tắt (shell: false) — không qua npx/cmd
 *  nên không lo quote đường dẫn có dấu/khoảng trắng.
 * =========================================================================
 */

const { spawn } = require('child_process');
const { EventEmitter } = require('events');

class McpClient extends EventEmitter {
  constructor(options = {}) {
    super();
    // 'error' là sự kiện đặc biệt của EventEmitter: KHÔNG có listener → ném
    // uncaught exception làm crash main process (vd spawn ENOENT khi máy thiếu
    // npx/browser). Listener mặc định nuôi sự kiện; ai cần vẫn .on('error') bình thường.
    this.on('error', () => {});
    this._process = null;
    this._requestId = 0;
    this._pending = new Map(); // id -> { resolve, reject, timer }
    this._buffer = '';
    this._pendingBodyLength = null; // body Content-Length đang dở dang (chờ đủ byte)
    this._tools = [];
    this._initialized = false;
    this._timeout = options.timeout || 30000;
    // Command/args nên truyền đầy đủ từ caller (browser-agent-ipc.js).
    // Mặc định dưới đây chỉ là phương án npx cũ cho dev — KHÔNG dùng trong app
    // thật vì bắt buộc máy có Node.js.
    this._command = options.command || 'npx';
    this._args = options.args || ['-y', '@playwright/mcp@latest', '--browser', 'chrome'];
    this._env = options.env || {};
    // npx.cmd trên Windows cần shell; spawn trực tiếp electron.exe thì KHÔNG
    // (tránh quote sai đường dẫn có dấu/khoảng trắng).
    this._shell = options.shell !== undefined ? options.shell : process.platform === 'win32';
  }

  /**
   * Spawn the MCP server process and perform initialization handshake.
   */
  async connect() {
    if (this._process) {
      throw new Error('[MCP] Already connected. Call disconnect() first.');
    }

    this._log('info', `Spawning: ${this._command} ${this._args.join(' ')}`);

    this._process = spawn(this._command, this._args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: this._shell,
      env: { ...process.env, ...this._env },
    });

    this._process.stdout.on('data', (chunk) => this._onData(chunk));
    this._process.stderr.on('data', (chunk) => {
      const msg = chunk.toString().trim();
      if (msg) this._log('stderr', msg);
    });

    this._process.on('error', (err) => {
      this._log('error', `Process error: ${err.message}`);
      this._rejectAll(err);
      this.emit('error', err);
    });

    this._process.on('exit', (code, signal) => {
      this._log('info', `Process exited (code=${code}, signal=${signal})`);
      this._initialized = false;
      this._process = null;
      this._rejectAll(new Error(`MCP server exited (code=${code})`));
      this.emit('disconnected', { code, signal });
    });

    // MCP Initialize handshake
    const initResult = await this._request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {
        roots: { listChanged: false },
      },
      clientInfo: {
        name: 'order-automation',
        version: '1.0.0',
      },
    });

    this._log('info', `Server: ${initResult.serverInfo?.name || 'unknown'} v${initResult.serverInfo?.version || '?'}`);

    // Send initialized notification
    this._notify('notifications/initialized', {});

    // Discover available tools
    const toolsResult = await this._request('tools/list', {});
    this._tools = toolsResult.tools || [];
    this._initialized = true;

    this._log('info', `Connected. ${this._tools.length} tools available: ${this._tools.map(t => t.name).join(', ')}`);
    this.emit('connected', { tools: this._tools });

    return this._tools;
  }

  /**
   * Disconnect and kill the MCP server process.
   */
  disconnect() {
    if (this._process) {
      this._log('info', 'Disconnecting...');
      const proc = this._process;
      const pid = proc.pid;

      if (process.platform === 'win32' && pid) {
        try {
          spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
        } catch (_) {
          try { proc.kill('SIGTERM'); } catch (e) { /* ignore */ }
        }
      } else {
        proc.kill('SIGTERM');
        setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch (e) { /* already dead */ }
        }, 3000);
      }

      this._process = null;
      this._initialized = false;
      this._rejectAll(new Error('Client disconnected'));
    }
  }

  /**
   * Get list of available tools.
   */
  getTools() {
    return this._tools;
  }

  /**
   * Get tool names as a simple array.
   */
  getToolNames() {
    return this._tools.map(t => t.name);
  }

  /**
   * Check if connected and initialized.
   */
  isConnected() {
    return this._initialized && this._process !== null;
  }

  /**
   * Reject all in-flight tool requests immediately (hard abort).
   * The MCP server process stays alive; only pending promises are rejected
   * so the caller's pipeline unwinds right away instead of waiting up to
   * the full request timeout.
   * @param {Error} [err] - Error to reject pending requests with
   */
  abortPending(err = new Error('ABORTED_BY_USER')) {
    if (err.code === undefined) err.code = 'ABORTED_BY_USER';
    this._rejectAll(err);
  }

  /**
   * Call an MCP tool by name with arguments.
   * Auto-retries once with reconnect on WebSocket failures.
   * @param {string} toolName - Tool name (e.g., 'browser_click', 'browser_navigate')
   * @param {object} args - Tool arguments
   * @param {boolean} _isRetry - Internal flag to prevent infinite retry loops
   * @returns {Promise<object>} Tool result
   */
  async callTool(toolName, args = {}, _isRetry = false) {
    if (!this.isConnected()) {
      throw new Error('[MCP] Not connected. Call connect() first.');
    }

    this._log('info', `callTool: ${toolName}(${JSON.stringify(args).slice(0, 200)})`);

    let result;
    try {
      result = await this._request('tools/call', {
        name: toolName,
        arguments: args,
      });
    } catch (err) {
      // WebSocket dropped — attempt auto-reconnect once
      const isWsError = /websocket is not open|ws is closed|socket hang up|EPIPE|process exited/i.test(err.message);
      if (isWsError && !this._reconnectDisabled) {
        if (_isRetry) {
          throw new Error(`[MCP] ${toolName} thất bại sau khi reconnect: ${err.message}. Hãy bấm "Ngắt kết nối" rồi "Kết nối" lại, và bấm Connect trong extension BrowserMCP trên trình duyệt.`);
        }
        this._log('info', `⚠️ WebSocket bị rớt khi gọi ${toolName}. Đang tự động reconnect...`);
        this.emit('reconnecting', { tool: toolName, error: err.message });
        try {
          await this.reconnect();
          return await this.callTool(toolName, args, true);
        } catch (reconnectErr) {
          throw new Error(`[MCP] Reconnect thất bại: ${reconnectErr.message}. Hãy bấm "Ngắt kết nối" rồi "Kết nối BrowserMCP" lại, và bấm Connect trong extension trên trình duyệt.`);
        }
      }
      throw err;
    }

    // MCP tool results come as { content: [{ type: 'text', text: '...' }], isError?: bool }
    if (result.isError) {
      const errText = (result.content || []).map(c => c.text || '').join('\n');
      // WebSocket dropped (reported as tool error) — attempt auto-reconnect once
      const isWsError = /websocket is not open|ws is closed|socket hang up/i.test(errText);
      if (isWsError && !_isRetry && !this._reconnectDisabled) {
        this._log('info', `⚠️ WebSocket bị rớt khi gọi ${toolName}. Đang tự động reconnect...`);
        this.emit('reconnecting', { tool: toolName, error: errText });
        try {
          await this.reconnect();
          return await this.callTool(toolName, args, true);
        } catch (reconnectErr) {
          throw new Error(`[MCP] Reconnect thất bại: ${reconnectErr.message}. Hãy bấm "Ngắt kết nối" rồi "Kết nối BrowserMCP" lại, và bấm Connect trong extension trên trình duyệt.`);
        }
      }
      if (isWsError && _isRetry) {
        throw new Error(`[MCP] ${toolName} vẫn lỗi WebSocket sau khi reconnect. Hãy bấm Connect lại trong extension BrowserMCP trên trình duyệt rồi thử lại.`);
      }
      throw new Error(`[MCP Tool Error] ${toolName}: ${errText}`);
    }

    return result;
  }

  /**
   * Reconnect: kill old server process and spawn a fresh one.
   * Useful when the WebSocket between MCP server and browser extension drops.
   */
  async reconnect() {
    this._log('info', '🔄 Reconnecting to BrowserMCP server...');
    // Kill existing process silently
    if (this._process) {
      try { this._process.kill('SIGKILL'); } catch (e) { /* already dead */ }
      this._process = null;
    }
    this._initialized = false;
    this._rejectAll(new Error('Reconnecting'));
    // Brief pause to let OS clean up the port/pipe
    await new Promise(r => setTimeout(r, 1500));
    return this.connect();
  }

  /**
   * Extract text content from MCP tool result.
   */
  static extractText(result) {
    if (!result || !result.content) return '';
    let text = result.content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
      
    // Strip Playwright MCP markdown wrappers if present
    const match = text.match(/### Result\s*([\s\S]*?)(?:###|$)/);
    if (match) {
      text = match[1].trim();
      text = text.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').trim();
    }
    return text;
  }

  // ==================== Convenience Browser Methods ====================
  // Tool names follow Playwright MCP (@playwright/mcp) schema:
  // element refs use "target", screenshot = browser_take_screenshot, etc.

  /**
   * Navigate to a URL.
   */
  async navigate(url) {
    return this.callTool('browser_navigate', { url });
  }

  /**
   * Take a DOM snapshot of the current page.
   */
  async snapshot() {
    return this.callTool('browser_snapshot', {});
  }

  /**
   * Click an element by its ref (from snapshot).
   */
  async click(ref) {
    return this.callTool('browser_click', { target: ref });
  }

  /**
   * Type/fill text into an element.
   */
  async fill(ref, text) {
    return this.callTool('browser_type', { target: ref, text });
  }

  /**
   * Press a keyboard key.
   */
  async pressKey(key) {
    return this.callTool('browser_press_key', { key });
  }

  /**
   * Select an option from a dropdown.
   */
  async select(ref, value) {
    return this.callTool('browser_select_option', { target: ref, values: [value] });
  }

  /**
   * Take a screenshot (returns base64 image).
   */
  async screenshot() {
    return this.callTool('browser_take_screenshot', {});
  }

  /**
   * Evaluate JavaScript in the browser page (BrowserMCP: browser_evaluate).
   */
  async evaluate(fn, args) {
    const params = { function: fn };
    if (args !== undefined) params.args = args;
    return this.callTool('browser_evaluate', params);
  }

  /**
   * Wait for a specified duration.
   */
  async wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ==================== JSON-RPC Internals ====================

  /**
   * Handle incoming data from stdout (JSON-RPC messages).
   * Supports standard MCP newline-delimited JSON (ndjson) as well as Content-Length header framing.
   * Gom nguyên Buffer, chỉ decode UTF-8 khi message HOÀN CHỈNH — decode từng
   * chunk làm vỡ ký tự đa byte (tiếng Việt) bị stdout cắt giữa ranh giới
   * (bug thật 04/9/2026: đọc lại giỏ/mã đơn KV sai font khi snapshot lớn).
   */
  _onData(chunk) {
    this._buffer = this._buffer && this._buffer.length
      ? Buffer.concat([this._buffer, chunk])
      : Buffer.from(chunk);

    while (true) {
      // Body dở dang của frame Content-Length: đợi đủ byte rồi decode MỘT lần
      // (fix: trước đây header bị strip ngay khi thiếu body → các chunk sau rơi
      // vào nhánh ndjson, message hoàn thành muộn không bao giờ được dispatch).
      if (this._pendingBodyLength != null) {
        if (this._buffer.length < this._pendingBodyLength) break;
        const body = this._buffer.subarray(0, this._pendingBodyLength).toString('utf8');
        this._buffer = this._buffer.subarray(this._pendingBodyLength);
        this._pendingBodyLength = null;
        try {
          this._handleMessage(JSON.parse(body));
        } catch (e) {
          this._log('error', `Failed to parse JSON-RPC: ${e.message}`);
        }
        continue;
      }

      // First try Content-Length header framing (if server uses LSP style)
      const headerEnd = this._buffer.indexOf('\r\n\r\n');
      if (headerEnd !== -1) {
        const header = this._buffer.subarray(0, headerEnd).toString('utf8');
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (match) {
          const contentLength = parseInt(match[1], 10);
          const bodyStart = headerEnd + 4;
          const bodyEnd = bodyStart + contentLength;
          if (this._buffer.length >= bodyEnd) {
            const body = this._buffer.subarray(bodyStart, bodyEnd).toString('utf8');
            this._buffer = this._buffer.subarray(bodyEnd);
            try {
              this._handleMessage(JSON.parse(body));
            } catch (e) {
              this._log('error', `Failed to parse JSON-RPC: ${e.message}`);
            }
            continue;
          } else {
            // Body chưa đủ: strip header, lưu độ dài body, đợi các chunk sau
            this._buffer = this._buffer.subarray(bodyStart);
            this._pendingBodyLength = contentLength;
            break;
          }
        }
      }

      // Standard MCP framing: newline-delimited JSON (ndjson)
      const newlineIndex = this._buffer.indexOf('\n');
      if (newlineIndex !== -1) {
        // Header Content-Length chưa hoàn tất (\r\n\r\n chưa đủ) → KHÔNG được
        // strip dòng header như ndjson, nếu không framing hỏng vĩnh viễn.
        const lineProbe = this._buffer.subarray(0, newlineIndex).toString('utf8');
        if (/^Content-Length:/i.test(lineProbe.trim())) break;
        const line = this._buffer.subarray(0, newlineIndex).toString('utf8').trim();
        this._buffer = this._buffer.subarray(newlineIndex + 1);

        if (line && !line.startsWith('Content-Length:')) {
          try {
            const message = JSON.parse(line);
            this._handleMessage(message);
          } catch (e) {
            // Ignore non-JSON log lines or stderr leaks
          }
        }
        continue;
      }

      break;
    }
  }

  /**
   * Route a parsed JSON-RPC message.
   */
  _handleMessage(message) {
    // Response to a request
    if (message.id !== undefined && this._pending.has(message.id)) {
      const { resolve, reject, timer } = this._pending.get(message.id);
      this._pending.delete(message.id);
      clearTimeout(timer);

      if (message.error) {
        reject(new Error(`[MCP RPC Error ${message.error.code}] ${message.error.message}`));
      } else {
        resolve(message.result);
      }
      return;
    }

    // Server notification
    if (message.method && message.id === undefined) {
      this._log('info', `Notification: ${message.method}`);
      this.emit('notification', message);
      return;
    }

    // Server request (e.g., sampling) — respond with empty for now
    if (message.method && message.id !== undefined) {
      this._log('info', `Server request: ${message.method} (id=${message.id})`);
      this._sendRaw({ jsonrpc: '2.0', id: message.id, result: {} });
      return;
    }
  }

  /**
   * Send a JSON-RPC request and wait for response.
   */
  _request(method, params) {
    return new Promise((resolve, reject) => {
      if (!this._process || !this._process.stdin.writable) {
        reject(new Error('[MCP] Process not available'));
        return;
      }

      const id = ++this._requestId;
      const message = { jsonrpc: '2.0', id, method, params };

      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`[MCP] Request timeout (${this._timeout}ms): ${method}`));
      }, this._timeout);

      this._pending.set(id, { resolve, reject, timer });
      this._sendRaw(message);
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   */
  _notify(method, params) {
    const message = { jsonrpc: '2.0', method, params };
    this._sendRaw(message);
  }

  /**
   * Serialize and write a JSON-RPC message (ndjson format).
   */
  _sendRaw(message) {
    if (!this._process || !this._process.stdin.writable) return;
    const body = JSON.stringify(message);
    this._process.stdin.write(body + '\n');
  }

  /**
   * Reject all pending requests (on disconnect/error).
   */
  _rejectAll(err) {
    for (const [id, { reject, timer }] of this._pending) {
      clearTimeout(timer);
      reject(err);
    }
    this._pending.clear();
  }

  /**
   * Internal logger.
   */
  _log(level, msg) {
    const prefix = { info: 'ℹ️', error: '❌', stderr: '⚠️' }[level] || '';
    console.log(`[MCP] ${prefix} ${msg}`);
    this.emit('log', { level, msg });
  }
}

module.exports = { McpClient };

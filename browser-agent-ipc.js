/**
 * =========================================================================
 *  ORDER AUTOMATION - BROWSER AGENT IPC (browser-agent-ipc.js)
 * =========================================================================
 *  Registers IPC handlers for the Browser Agent in Electron main process.
 *  Require this module from main.js to enable browser automation controls
 *  from the renderer.
 *
 *  Usage in main.js:
 *    require('./browser-agent-ipc').register(ipcMain, getMainWindow);
 * =========================================================================
 */

const { BrowserAgent } = require('./browser-agent');
const { spawn } = require('child_process');
const { app } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
// Domain tenant KiotViet đọc từ local-config.json (local-only, KHÔNG nằm trong git/GitHub).
let KV_TENANT_URL = 'https://YOUR_TENANT.kiotviet.vn';
try { KV_TENANT_URL = JSON.parse(fs.readFileSync(path.join(__dirname, 'local-config.json'), 'utf8')).kvTenantUrl || KV_TENANT_URL; } catch (e) { /* dùng placeholder */ }

let agent = null;

// Chrome debug port (only used by the optional "launch-chrome" fallback handler)
const CHROME_DEBUG_PORT = 9222;

// Log console của browser do @playwright/mcp ghi ra thư mục output. Không truyền
// --output-dir thì nó rơi vào .playwright-mcp ngay cwd (tích vô hạn mỗi phiên KV),
// nên dồn về thư mục cố định + giới hạn dung lượng để MCP tự evict file cũ nhất.
const MCP_OUTPUT_DIR = path.join(os.tmpdir(), 'oa-kiotviet-mcp');
const MCP_OUTPUT_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Đường dẫn cli.js của @playwright/mcp đóng gói sẵn trong app.
 * Packaged: file bị asarUnpack ra app.asar.unpacked (child process không đọc
 * được file bên trong asar). Dev: nằm ngay node_modules của repo.
 * Máy người dùng KHÔNG cần cài Node.js — chạy bằng chính Electron
 * (process.execPath + ELECTRON_RUN_AS_NODE=1, xem getAgent()).
 */
function resolveMcpServerScript() {
  const rel = path.join('node_modules', '@playwright', 'mcp', 'cli.js');
  return (app && app.isPackaged)
    ? path.join(process.resourcesPath, 'app.asar.unpacked', rel)
    : path.join(__dirname, rel);
}

/**
 * Chọn browser Chromium để Playwright MCP khởi động (ưu tiên Chrome → Edge →
 * Brave). Windows 10/11 luôn có Edge nên thực tế máy mới không cần cài gì.
 * @returns {string[]} args bổ sung cho MCP server, hoặc null nếu không có browser
 */
function pickBrowserLaunchArgs() {
  const browsers = findBrowsers();
  if (browsers.some(b => b.name === 'Chrome')) return ['--browser', 'chrome'];
  if (browsers.some(b => b.name === 'Edge')) return ['--browser', 'msedge'];
  const brave = browsers.find(b => b.name === 'Brave');
  // Brave không có channel riêng trong Playwright → trỏ thẳng executable
  if (brave) return ['--browser', 'chromium', '--executable-path', brave.exe];
  return null;
}

/**
 * Dựng full args cho MCP server (script + browser + profile) theo hiện trạng
 * máy tại thời điểm gọi — dùng khi tạo agent lẫn khi connect để args luôn
 * khớp browser đang có (user có thể cài Chrome sau khi đã mở app).
 */
function buildMcpLaunchArgs() {
  const profileDir = path.join(os.homedir(), '.kv-browser-profile');
  const browserArgs = pickBrowserLaunchArgs() || ['--browser', 'chrome'];
  return [
    resolveMcpServerScript(), ...browserArgs,
    '--user-data-dir', profileDir,
    '--caps', 'pdf',
    '--output-dir', MCP_OUTPUT_DIR,
    '--output-max-size', String(MCP_OUTPUT_MAX_BYTES),
  ];
}

/**
 * Get or create the singleton BrowserAgent instance.
 */
function getAgent() {
  if (!agent) {
    // Persistent browser profile — stores KiotViet login cookies on disk.
    // User logs in ONCE; all future sessions are auto-logged-in.
    // Placed in home dir to avoid spaces/diacritics in the packaged app's
    // userData path ("Lên đơn hàng") which would break shell spawning.
    agent = new BrowserAgent({
      mcp: {
        // Chạy MCP server bằng chính runtime Node của Electron — máy người
        // dùng không cần cài Node.js/npx. @playwright/mcp đã vendor vào app.
        command: process.execPath,
        args: buildMcpLaunchArgs(),
        shell: false,
        env: { ELECTRON_RUN_AS_NODE: '1' },
        timeout: 90000, // 90s for tool calls (page loads can be slow)
      },
      lmStudioEndpoint: 'http://localhost:1234/v1/chat/completions',
      maxSteps: 30,
      stepDelayMs: 1200,
    });
  }
  return agent;
}

/**
 * Find installed Chromium-based browsers (Chrome, Brave, Edge) on Windows.
 */
function findBrowsers() {
  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env['PROGRAMFILES'] || 'C:\\Program Files';
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const candidates = [
    { name: 'Chrome', exe: path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { name: 'Chrome', exe: path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { name: 'Chrome', exe: path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { name: 'Brave', exe: path.join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') },
    { name: 'Brave', exe: path.join(programFilesX86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') },
    { name: 'Brave', exe: path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') },
    { name: 'Edge', exe: path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    { name: 'Edge', exe: path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
  ];
  return candidates.filter(b => {
    try { return fs.existsSync(b.exe); } catch (e) { return false; }
  });
}

/**
 * Register all browser-agent IPC handlers.
 * @param {Electron.IpcMain} ipcMain
 * @param {Function} getMainWindow - Returns the current BrowserWindow (or null)
 */
function register(ipcMain, getMainWindow) {

  /**
   * Connect to BrowserMCP server.
   */
  ipcMain.handle('browser-agent:connect', async () => {
    try {
      // Pre-flight: máy phải có ít nhất 1 browser Chromium (Win10/11 luôn có
      // Edge). Không có thì báo rõ thay vì để spawn lỗi khó hiểu phía sau.
      if (!pickBrowserLaunchArgs()) {
        return {
          success: false,
          error: 'Không tìm thấy trình duyệt Chrome/Edge/Brave trên máy. Hãy cài Google Chrome (google.com/chrome) hoặc dùng Microsoft Edge có sẵn trong Windows rồi bấm "Kết nối Browser" lại.',
        };
      }
      const a = getAgent();
      // Args có thể đã được dựng lúc mở modal (status polling) khi máy chưa
      // có browser/user vừa cài thêm — dựng lại theo hiện trạng trước khi spawn.
      if (!a.isConnected()) {
        a._mcp._args = buildMcpLaunchArgs();
      }
      let tools = [];
      if (!a.isConnected()) {
        tools = await a.connect();
      } else {
        tools = a._mcp ? a._mcp._tools : [];
      }

      // Try snapshot up to 3 times — this also triggers Playwright to launch Chrome
      let browserConnected = false;
      for (let i = 0; i < 3; i++) {
        try {
          await a.getPageSnapshot();
          browserConnected = true;
          break;
        } catch (snapErr) {
          if (i < 2) await new Promise(r => setTimeout(r, 800));
        }
      }

      // Open KiotViet order page so the user can log in if needed (first time only)
      if (browserConnected) {
        try {
          await a.executeAction('browser_navigate', { url: a._config.kiotVietUrl });
        } catch (navErr) { /* non-critical — direct mode will navigate again */ }
      }

      return {
        success: true,
        browserConnected,
        tools: (tools || []).map(t => ({ name: t.name, description: t.description }))
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /**
   * Disconnect from BrowserMCP server.
   */
  ipcMain.handle('browser-agent:disconnect', async () => {
    try {
      const a = getAgent();
      a.disconnect();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /**
   * Launch a Chromium-based browser with remote debugging enabled (port 9222)
   * so Playwright MCP can connect via CDP.
   */
  ipcMain.handle('browser-agent:launch-chrome', async (_event, preferredBrowser) => {
    try {
      const browsers = findBrowsers();
      if (browsers.length === 0) {
        return { success: false, error: 'Không tìm thấy Chrome/Brave/Edge trên máy!' };
      }
      // Pick preferred browser or first found
      const chosen = browsers.find(b => b.name === preferredBrowser) || browsers[0];
      const args = [
        `--remote-debugging-port=${CHROME_DEBUG_PORT}`,
        KV_TENANT_URL + '/sale/#/?cart=Order',
      ];
      const child = spawn(chosen.exe, args, { detached: true, stdio: 'ignore' });
      child.unref();
      return {
        success: true,
        browser: chosen.name,
        port: CHROME_DEBUG_PORT,
        message: `Đã mở ${chosen.name} với debug port ${CHROME_DEBUG_PORT}. Hãy đăng nhập KiotViet (nếu chưa) rồi bấm "Kết nối".`
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /**
   * Get agent status.
   */
  ipcMain.handle('browser-agent:status', () => {
    const a = getAgent();
    return a.getStatus();
  });

  /**
   * Get agent logs.
   */
  ipcMain.handle('browser-agent:logs', (_event, limit) => {
    const a = getAgent();
    return a.getLogs(limit || 100);
  });

  /**
   * Run KiotViet order automation.
   * orderData: { customer, payment, items: [...], notes: [...] }
   */
  ipcMain.handle('browser-agent:run-order', async (_event, orderData, options) => {
    try {
      const a = getAgent();

      if (!a.isConnected()) {
        return { success: false, error: 'Chưa kết nối BrowserMCP. Bấm "Kết nối" trước.' };
      }

      // Setup event forwarding to renderer
      const win = getMainWindow();
      const forwardEvent = (channel) => (data) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send(channel, data);
        }
      };

      // Remove old listeners to prevent duplicates
      a.removeAllListeners('started');
      a.removeAllListeners('step');
      a.removeAllListeners('action');
      a.removeAllListeners('log');
      a.removeAllListeners('completed');
      a.removeAllListeners('aborted');
      a.removeAllListeners('maxStepsReached');
      a.removeAllListeners('error');

      a.on('started', forwardEvent('browser-agent:started'));
      a.on('step', forwardEvent('browser-agent:step'));
      a.on('action', forwardEvent('browser-agent:action'));
      a.on('log', forwardEvent('browser-agent:log'));
      a.on('completed', forwardEvent('browser-agent:completed'));
      a.on('aborted', forwardEvent('browser-agent:aborted'));
      a.on('maxStepsReached', forwardEvent('browser-agent:max-steps'));
      a.on('error', forwardEvent('browser-agent:error'));

      // Unified pipeline: Script fill → AI Verify → Fix → Submit
      // All modes route to runDirectOrder (or fallback to runKiotVietOrder)
      const runFn = () => (typeof a.runDirectOrder === 'function' ? a.runDirectOrder(orderData, options || {}) : a.runKiotVietOrder(orderData, options || {}));

      runFn().catch(err => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('browser-agent:error', { error: err.message });
        }
      });

      return { success: true, message: '⚡ Pipeline started (Script → AI Verify → Submit)' };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /**
   * Run a generic KiotViet task (any operation).
   * taskDescription: Natural language description of what to do
   * options: { aiConfig, maxSteps, startUrl }
   */
  ipcMain.handle('browser-agent:run-task', async (_event, taskDescription, options) => {
    try {
      const a = getAgent();

      if (!a.isConnected()) {
        return { success: false, error: 'Chưa kết nối BrowserMCP. Bấm "Kết nối" trước.' };
      }

      // Setup event forwarding to renderer
      const win = getMainWindow();
      const forwardEvent = (channel) => (data) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send(channel, data);
        }
      };

      a.removeAllListeners('started');
      a.removeAllListeners('step');
      a.removeAllListeners('action');
      a.removeAllListeners('log');
      a.removeAllListeners('completed');
      a.removeAllListeners('aborted');
      a.removeAllListeners('maxStepsReached');
      a.removeAllListeners('error');

      a.on('started', forwardEvent('browser-agent:started'));
      a.on('step', forwardEvent('browser-agent:step'));
      a.on('action', forwardEvent('browser-agent:action'));
      a.on('log', forwardEvent('browser-agent:log'));
      a.on('completed', forwardEvent('browser-agent:completed'));
      a.on('aborted', forwardEvent('browser-agent:aborted'));
      a.on('maxStepsReached', forwardEvent('browser-agent:max-steps'));
      a.on('error', forwardEvent('browser-agent:error'));

      // Run async
      a.runGenericTask(taskDescription, options || {}).catch(err => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('browser-agent:error', { error: err.message });
        }
      });

      return { success: true, message: 'Generic task started' };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /**
   * Abort the running agent.
   */
  ipcMain.handle('browser-agent:abort', () => {
    const a = getAgent();
    a.abort();
    return { success: true };
  });

  /**
   * Force-reset the agent (restart mechanism for stuck runs).
   */
  ipcMain.handle('browser-agent:reset', () => {
    const a = getAgent();
    a.reset();
    return { success: true };
  });

  /**
   * Get current page DOM snapshot (manual inspection).
   */
  ipcMain.handle('browser-agent:snapshot', async () => {
    try {
      const a = getAgent();
      const snapshot = await a.getPageSnapshot();
      return { success: true, snapshot };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /**
   * Execute a single browser action manually.
   */
  ipcMain.handle('browser-agent:execute', async (_event, tool, args) => {
    try {
      const a = getAgent();
      const result = await a.executeAction(tool, args || {});
      return { success: true, result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /**
   * Navigate to a URL.
   */
  ipcMain.handle('browser-agent:navigate', async (_event, url) => {
    try {
      const a = getAgent();
      const result = await a.executeAction('browser_navigate', { url });
      return { success: true, result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /**
   * Update agent config (LM Studio endpoint, model, etc.)
   */
  ipcMain.handle('browser-agent:set-config', (_event, config) => {
    const a = getAgent();
    if (config.lmStudioEndpoint) a._config.lmStudioEndpoint = config.lmStudioEndpoint;
    if (config.model !== undefined) a._config.model = config.model;
    if (config.maxSteps) a._config.maxSteps = config.maxSteps;
    if (config.kiotVietUrl) a._config.kiotVietUrl = config.kiotVietUrl;
    return { success: true, config: a._config };
  });

  console.log('[Browser Agent IPC] Registered all handlers');
}

/**
 * Cleanup on app quit.
 */
function destroy() {
  if (agent) {
    agent.disconnect();
    agent = null;
  }
}

module.exports = {
  register,
  destroy,
  getAgent,
  // Export cho test (test/browser-agent-ipc.test.js) — không dùng vào luồng chạy
  resolveMcpServerScript,
  pickBrowserLaunchArgs,
  buildMcpLaunchArgs,
  MCP_OUTPUT_DIR,
  MCP_OUTPUT_MAX_BYTES,
};

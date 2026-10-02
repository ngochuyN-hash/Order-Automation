/**
 * =========================================================================
 *  ORDER AUTOMATION - PRELOAD SCRIPT (preload.js)
 * =========================================================================
 *  Secure bridge between Electron main process and renderer.
 *  Exposes only the specific IPC channels needed by the app.
 * =========================================================================
 */

const { contextBridge, ipcRenderer } = require('electron');

// Whitelist of allowed IPC channels
const ALLOWED_INVOKE_CHANNELS = [
  'app:get-version',
  'excel:export-order',
  'excel:diagnose',
  'excel:apply-fix',
  'config:get-order-dir',
  'config:set-order-dir',
  'config:pick-folder',
  'config:get-ai',
  'config:set-ai',
  'config:get-ai-profiles',
  'config:set-ai-profiles',
  'config:get-sellers',
  'config:set-sellers',
  'config:get-customer-notes',
  'config:set-customer-notes',
  // KV thùng code overrides (kv-name-map.json)
  'kvmap:get-thung-overrides',
  'kvmap:set-thung-override',
  // KV mã gốc (kvCode) overrides
  'kvmap:get-base-overrides',
  'kvmap:set-base-code',
  // Browser Agent channels
  'browser-agent:connect',
  'browser-agent:disconnect',
  'browser-agent:launch-chrome',
  'browser-agent:status',
  'browser-agent:logs',
  'browser-agent:run-order',
  'browser-agent:run-task',
  'browser-agent:abort',
  'browser-agent:reset',
  'browser-agent:snapshot',
  'browser-agent:execute',
  'browser-agent:navigate',
  'browser-agent:set-config',
];

// Browser Agent event channels (main → renderer)
const AGENT_EVENT_CHANNELS = [
  'browser-agent:step',
  'browser-agent:action',
  'browser-agent:log',
  'browser-agent:completed',
  'browser-agent:aborted',
  'browser-agent:error',
  'browser-agent:started',
  'browser-agent:max-steps',
  'agent-activity',
];

/**
 * Invoke có kiểm duyệt: CHỈ cho phép channel nằm trong whitelist.
 * Trước đây whitelist chỉ tồn tại trên giấy (không được kiểm tra) — giờ
 * mọi lời gọi invoke đều phải đi qua cổng này.
 */
function _invoke(channel, ...args) {
  if (!ALLOWED_INVOKE_CHANNELS.includes(channel)) {
    console.warn(`[preload] Blocked invoke channel: ${channel}`);
    return Promise.reject(new Error(`IPC channel not allowed: ${channel}`));
  }
  return ipcRenderer.invoke(channel, ...args);
}


contextBridge.exposeInMainWorld('electronAPI', {
  // Flag so renderer can detect Electron environment
  isElectron: true,

  // Phiên bản app (package.json version của bản đã cài)
  getAppVersion: () => _invoke('app:get-version'),

  // Excel export via IPC (replaces HTTP fetch to port 8046)
  exportOrder: (data) => {
    return _invoke('excel:export-order', data);
  },

  // AI-assisted file resolution diagnosis
  diagnoseExcel: (data) => _invoke('excel:diagnose', data),
  applyExcelFix: (fix) => _invoke('excel:apply-fix', fix),

  // Order directory config
  getOrderDir: () => _invoke('config:get-order-dir'),
  setOrderDir: (dir) => _invoke('config:set-order-dir', dir),
  pickFolder: () => _invoke('config:pick-folder'),

  // AI Config safeStorage
  getAiConfig: () => _invoke('config:get-ai'),
  setAiConfig: (config) => _invoke('config:set-ai', config),

  // AI Profiles (multi-key management)
  getAiProfiles: () => _invoke('config:get-ai-profiles'),
  setAiProfiles: (data) => _invoke('config:set-ai-profiles', data),

  // Sellers (Người nhận đặt) — file-level persistence
  getSellers: () => _invoke('config:get-sellers'),
  setSellers: (sellers) => _invoke('config:set-sellers', sellers),

  // Customer Special-Price Notes (Khách có đơn giá riêng) — file-level persistence
  getCustomerNotes: () => _invoke('config:get-customer-notes'),
  setCustomerNotes: (notes) => _invoke('config:set-customer-notes', notes),

  // KV thùng code overrides (ghi đè mã thùng trong kv-name-map.json)
  getKvThungOverrides: () => _invoke('kvmap:get-thung-overrides'),
  setKvThungOverride: (data) => _invoke('kvmap:set-thung-override', data),

  // KV mã gốc overrides (sửa "Mã KV" trên UI ghi vào kv-name-map.json)
  getKvBaseOverrides: () => _invoke('kvmap:get-base-overrides'),
  setKvBaseCode: (data) => _invoke('kvmap:set-base-code', data),

  // ==================== Browser Agent API ====================

  browserAgent: {
    /** Connect: spawn Playwright MCP server (@playwright/mcp chạy qua Electron-as-Node) */
    connect: () => _invoke('browser-agent:connect'),

    /** Disconnect from MCP server */
    disconnect: () => _invoke('browser-agent:disconnect'),

    /** Launch Chrome/Brave/Edge with remote debugging port 9222 */
    launchChrome: (preferredBrowser) => _invoke('browser-agent:launch-chrome', preferredBrowser),

    /** Get agent status (connected, running, tools, stepCount) */
    status: () => _invoke('browser-agent:status'),

    /** Get agent logs */
    logs: (limit) => _invoke('browser-agent:logs', limit),

    /** Run KiotViet order automation with parsed order data */
    runOrder: (orderData, options) => _invoke('browser-agent:run-order', orderData, options),

    /** Run a generic KiotViet task (any operation: check stock, reports, customers...) */
    runTask: (taskDescription, options) => _invoke('browser-agent:run-task', taskDescription, options),

    /** Abort the running agent */
    abort: () => _invoke('browser-agent:abort'),

    /** Force-reset the agent (restart mechanism for stuck runs) */
    reset: () => _invoke('browser-agent:reset'),

    /** Get current page DOM snapshot */
    snapshot: () => _invoke('browser-agent:snapshot'),

    /** Execute a single browser action manually */
    execute: (tool, args) => _invoke('browser-agent:execute', tool, args),

    /** Navigate browser to URL */
    navigate: (url) => _invoke('browser-agent:navigate', url),

    /** Update agent config */
    setConfig: (config) => _invoke('browser-agent:set-config', config),

    /** Subscribe to agent events (returns unsubscribe function) */
    on: (channel, callback) => {
      if (!AGENT_EVENT_CHANNELS.includes(channel)) {
        console.warn(`[preload] Blocked event channel: ${channel}`);
        return () => {};
      }
      const handler = (_event, data) => callback(data);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },

    /** Remove all listeners for a channel */
    removeAllListeners: (channel) => {
      if (AGENT_EVENT_CHANNELS.includes(channel)) {
        ipcRenderer.removeAllListeners(channel);
      }
    },
  },
});

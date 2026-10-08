/**
 * =========================================================================
 *  ORDER AUTOMATION - ELECTRON MAIN PROCESS (main.js)
 * =========================================================================
 *  Creates the application window, handles IPC for Excel export,
 *  and manages app lifecycle. No external HTTP server needed.
 * =========================================================================
 */

const { app, BrowserWindow, ipcMain, shell, dialog, Notification, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

// --- EPIPE guard ─────────────────────────────────────────────────────────────
// The app is often launched from a terminal/.bat whose stdout is a pipe; when
// that launcher goes away the pipe breaks, but the GUI keeps running. Every
// later console.log would then throw "EPIPE: broken pipe" as an uncaught
// exception and kill the app mid-export. Swallow broken-pipe writes; keep the
// crash dialog for anything else.
const _isEpipe = (e) => !!e && (e.code === 'EPIPE' || e.errno === 'EPIPE');
for (const _m of ['log', 'info', 'warn', 'error', 'debug']) {
  if (typeof console[_m] === 'function') {
    const _orig = console[_m].bind(console);
    console[_m] = (...args) => {
      try { _orig(...args); } catch (e) { if (!_isEpipe(e)) throw e; }
    };
  }
}
for (const _s of [process.stdout, process.stderr]) {
  _s.on('error', (e) => { if (!_isEpipe(e)) throw e; });
}
process.on('uncaughtException', (err) => {
  if (_isEpipe(err)) return; // launcher console went away — harmless
  try {
    const logDir = app.isPackaged ? app.getPath('userData') : __dirname;
    fs.appendFileSync(path.join(logDir, 'crash.log'),
      `[${new Date().toISOString()}] uncaughtException: ${err && err.stack ? err.stack : err}\n`);
  } catch { /* ignore */ }
  try { dialog.showErrorBox('Lỗi ứng dụng', String((err && err.stack) || err)); } catch { /* ignore */ }
  process.exit(1);
});
// Promise reject không ai catch: trước đây chỉ là warning im lặng trên console
// → lỗi tiềm ẩn không bao giờ được phát hiện. Ghi crash.log để truy vết,
// KHÔNG exit (app vẫn dùng được, tránh gián đoạn thao tác đang dở).
process.on('unhandledRejection', (reason) => {
  if (_isEpipe(reason)) return;
  const detail = reason && reason.stack ? reason.stack : String(reason);
  console.error('[Main] Unhandled promise rejection:', detail);
  try {
    const logDir = app.isPackaged ? app.getPath('userData') : __dirname;
    fs.appendFileSync(path.join(logDir, 'crash.log'),
      `[${new Date().toISOString()}] unhandledRejection: ${detail}\n`);
  } catch { /* ignore */ }
});

// --- Browser Agent (MCP + LM Studio) ---
const browserAgentIpc = require('./browser-agent-ipc');
const mcpServer = require('./mcp-server');


let mainWindow = null;

// --- Export Mutex: prevent concurrent Excel writes (data corruption risk) ---
let _exportInProgress = false;

// --- Export timeout (ms): kill Python if Excel hangs ---
const EXPORT_TIMEOUT_MS = 120000; // 2 minutes

/**
 * Path to the Excel owner/lock file (~$filename.xlsx) that Excel creates
 * alongside a workbook while it is open.
 */
function getExcelLockFilePath(filePath) {
  return path.join(path.dirname(filePath), '~$' + path.basename(filePath));
}

/**
 * Check whether a file is exclusively locked by another process (e.g. Excel)
 * by attempting a read-write open.
 */
function isFileExclusiveLocked(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r+');
    fs.closeSync(fd);
    return false;
  } catch (e) {
    return (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES');
  }
}

/**
 * Check whether a file is currently open/locked (e.g. by Excel).
 * Two signals:
 *  1. Excel owner/lock file (~$name.xlsx) — definitive signal that Excel
 *     has the workbook open (fs.openSync alone can miss it because modern
 *     Excel may share the file with write permission).
 *  2. Exclusive open attempt fails.
 */
function isFileLocked(filePath) {
  if (fs.existsSync(getExcelLockFilePath(filePath))) return true;
  return isFileExclusiveLocked(filePath);
}

/**
 * Gracefully close a workbook that is open in Excel via COM automation.
 * Saves changes before closing so the user doesn't lose data.
 * @param {string} filePath  Absolute path to the workbook.
 * @returns {Promise<boolean>} true if the file is no longer locked afterwards.
 */
function closeExcelWorkbookGracefully(filePath) {
  return new Promise((resolve) => {
    // PowerShell script: connect to running Excel, save + close the workbook.
    // NOTE: With -Command, PowerShell concatenates trailing args into the command
    // string (does NOT pass them as $args), so the path must be embedded directly.
    // Single-quoted PS string: only escape needed is ' → ''
    const escapedPath = filePath.replace(/'/g, "''");
    const psScript = [
      '$ErrorActionPreference = "Stop"',
      'try {',
      '  $xl = [System.Runtime.InteropServices.Marshal]::GetActiveObject("Excel.Application")',
      '} catch { exit 1 }',
      '$xl.DisplayAlerts = $false',
      `$target = '${escapedPath}'`,
      '$closed = $false',
      'foreach ($wb in $xl.Workbooks) {',
      '  try {',
      '    if ($wb.FullName -ieq $target) {',
      '      try { $wb.Save() } catch { }',
      '      $wb.Close($false)',
      '      $closed = $true',
      '      break',
      '    }',
      '  } catch { continue }',
      '}',
      '$xl.DisplayAlerts = $true',
      'if ($closed) { exit 0 } else { exit 1 }'
    ].join('\r\n');

    const lockFile = getExcelLockFilePath(filePath);

    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
      { timeout: 15000 }, async (error) => {
        if (error) {
          console.warn('[Excel Export] COM close failed or workbook not found in Excel:', error.message);
          resolve(false);
          return;
        }
        // Wait for the OS to release the file handle (up to 10s) — Excel can
        // take a while to fully flush + release after Close(); giving up too
        // early falsely reports a working graceful close as a failure.
        const start = Date.now();
        while (Date.now() - start < 10000) {
          if (!isFileExclusiveLocked(filePath)) {
            // Clean up any lingering ~$ lock file so Python's Excel opens cleanly
            try { if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile); } catch (e) { /* ignore */ }
            console.log('[Excel Export] Workbook closed gracefully via COM:', filePath);
            resolve(true);
            return;
          }
          await new Promise(r => setTimeout(r, 300));
        }
        resolve(!isFileExclusiveLocked(filePath));
      });
  });
}

/**
 * Safely clean up orphaned background Excel COM instances (MainWindowHandle == 0).
 * Does NOT touch active, visible Excel windows that the user is working with.
 */
function cleanupBackgroundExcelProcesses() {
  if (process.platform !== 'win32') return;
  try {
    const cmd = `powershell -NoProfile -Command "Get-Process excel -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -eq 0 } | Stop-Process -Force"`;
    require('child_process').execSync(cmd, { timeout: 5000, stdio: 'ignore' });
    console.log('[Excel Export] Cleaned up background Excel COM processes.');
  } catch (e) {
    console.warn('[Excel Export] Background Excel cleanup warning:', e.message);
  }
}

// --- Python Executable Detection (cached, runs once) ---
let _pythonPath = null;

function getPythonPath() {
  if (_pythonPath) return _pythonPath;

  // Priority: PYTHON_PATH env var > PATH-based discovery
  const candidates = [];
  if (process.env.PYTHON_PATH) {
    candidates.push(process.env.PYTHON_PATH);
  }
  candidates.push('python', 'python3', 'py');

  for (const candidate of candidates) {
    try {
      const { execFileSync } = require('child_process');
      execFileSync(candidate, ['--version'], { stdio: 'ignore', timeout: 5000 });
      _pythonPath = candidate;
      console.log(`[Python] Using: ${candidate}`);
      return _pythonPath;
    } catch (e) { /* try next */ }
  }
  console.error('[Python] No Python executable found! Tried:', candidates.join(', '));
  console.error('[Python] Set PYTHON_PATH env var to the full path of python.exe');
  return null;
}

// --- App Config (persisted to userData/app-config.json) ---

function getConfigPath() {
  return path.join(app.getPath('userData'), 'app-config.json');
}

// --- Async fs.promises + RAM cache: read once from disk, serve from memory,
// refresh cache on write. All callers are ipcMain.handle (async invoke) or
// awaited helpers — no sync call sites remain.
let _configCache = null;          // parsed config object (null = not loaded yet)
let _configReadPromise = null;    // dedupes concurrent cold reads

async function readConfig() {
  if (_configCache) return JSON.parse(JSON.stringify(_configCache));
  if (!_configReadPromise) {
    _configReadPromise = fs.promises.readFile(getConfigPath(), 'utf-8')
      .then((raw) => {
        try { _configCache = JSON.parse(raw); }
        catch (e) { console.warn('[Config] parse error:', e.message); _configCache = {}; }
      })
      .catch((e) => {
        if (e && e.code !== 'ENOENT') console.warn('[Config] read error:', e.message);
        if (!_configCache) _configCache = {};
      })
      .finally(() => { _configReadPromise = null; });
  }
  await _configReadPromise;
  return JSON.parse(JSON.stringify(_configCache));
}

async function writeConfig(cfg) {
  // Update cache first so concurrent readers always see the latest value
  _configCache = cfg;
  try {
    const p = getConfigPath();
    // Atomic write: write to temp file first, then rename (prevents corruption on crash).
    // Unique tmp name avoids collisions between concurrent writers.
    const tmpPath = `${p}.tmp-${process.pid}-${Date.now()}`;
    await fs.promises.writeFile(tmpPath, JSON.stringify(cfg, null, 2), 'utf-8');
    await fs.promises.rename(tmpPath, p);
  } catch (e) { console.warn('[Config] write error:', e.message); }
}

// --- Serialized read-modify-write queue for app-config.json ---
// Async handlers could interleave between readConfig() and writeConfig(),
// losing each other's changes. withConfig() serializes every mutation.
let _configQueue = Promise.resolve();
function withConfig(mutator) {
  const op = _configQueue.then(async () => {
    const cfg = await readConfig();
    await mutator(cfg);
    await writeConfig(cfg);
    return cfg;
  });
  // Keep the chain alive even if this op fails (catch here, re-throw to caller)
  _configQueue = op.catch(() => {});
  return op;
}

/**
 * Ghi JSON atomic (temp + rename): crash/lost power giữa lúc ghi sẽ không
 * làm hỏng file đích như writeFileSync trực tiếp.
 */
async function atomicWriteJson(filePath, data) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tmpPath, data, 'utf-8');
  await fs.promises.rename(tmpPath, filePath);
}

// safeStorage API key encryption helper
function encryptKey(key) {
  if (!key) return '';
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
    console.warn('[safeStorage] Not available — API key will NOT be persisted. User must re-enter each session.');
    return '';
  }
  try {
    return 'safe:' + safeStorage.encryptString(key).toString('base64');
  } catch (e) {
    console.error('[safeStorage] Encryption failed — API key will NOT be persisted:', e);
    return '';
  }
}

// safeStorage API key decryption helper
function decryptKey(encrypted) {
  if (!encrypted) return '';
  if (encrypted.startsWith('safe:')) {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      console.warn('[safeStorage] Not available for decryption');
      return '';
    }
    try {
      const rawB64 = encrypted.substring(5);
      return safeStorage.decryptString(Buffer.from(rawB64, 'base64'));
    } catch (e) {
      console.error('[safeStorage] Decryption failed:', e);
      return '';
    }
  } else if (encrypted.startsWith('xor:')) {
    // Legacy migration: read old XOR-obfuscated keys one last time
    try {
      const rawB64 = encrypted.substring(4);
      const key = atob(rawB64).split('').map(c => String.fromCharCode(c.charCodeAt(0) ^ 42)).join('');
      console.warn('[safeStorage] Legacy XOR key detected — will be re-encrypted on next save.');
      return key;
    } catch (e) {
      return '';
    }
  }
  // Unknown format — do not return raw value as it may be a plaintext secret
  console.warn('[safeStorage] Unknown key format — discarding.');
  return '';
}

// IPC: phiên bản app — hiển thị trên UI để biết máy đang chạy bản nào khi cập nhật qua file cài
ipcMain.handle('app:get-version', () => app.getVersion());

// IPC: get/set order directory
ipcMain.handle('config:get-order-dir', async () => {
  const cfg = await readConfig();
  return cfg.orderDir || '';
});

ipcMain.handle('config:set-order-dir', async (_event, dir) => {
  await withConfig(cfg => { cfg.orderDir = dir; });
  return { success: true, orderDir: dir };
});

ipcMain.handle('config:get-ai', async () => {
  const cfg = await readConfig();
  const ai = cfg.ai || { provider: 'none', apiKey: '', model: '', endpoint: '' };
  const aiConfig = { ...ai };
  if (aiConfig.apiKey) {
    aiConfig.apiKey = decryptKey(aiConfig.apiKey);
  }
  return aiConfig;
});

ipcMain.handle('config:set-ai', async (_event, aiConfig) => {
  const toSave = { ...aiConfig };
  let keyPersisted = true;
  if (toSave.apiKey) {
    const encrypted = encryptKey(toSave.apiKey);
    if (!encrypted) {
      keyPersisted = false;
      toSave.apiKey = ''; // Don't store plaintext
    } else {
      toSave.apiKey = encrypted;
    }
  }
  await withConfig(cfg => { cfg.ai = toSave; });
  return { success: true, keyPersisted };
});

// --- AI Profiles (multi-key management with rotation/failover) ---
ipcMain.handle('config:get-ai-profiles', async () => {
  let cfg = await readConfig();

  // Idempotent migration: Qwen profiles with legacy model 'qwen-plus' -> 'qwen3.7-plus'
  // (Token Plan endpoint only supports qwen3.7-plus/qwen3.7-max/qwen3.6-plus/qwen3.6-flash).
  const needsMigration = Array.isArray(cfg.aiProfiles) &&
    cfg.aiProfiles.some(p => p && p.provider === 'qwen' && /^qwen-(plus|max|turbo)$/.test(p.model));
  if (needsMigration) {
    // Serialized mutation so concurrent config writes can't clobber each other
    cfg = await withConfig(c => {
      for (const p of (c.aiProfiles || [])) {
        if (p && p.provider === 'qwen' && /^qwen-(plus|max|turbo)$/.test(p.model)) {
          p.model = 'qwen3.7-plus';
        }
      }
      // Keep legacy cfg.ai in sync if it still references the stale qwen model
      if (c.ai && c.ai.provider === 'qwen' && /^qwen-(plus|max|turbo)$/.test(c.ai.model)) {
        c.ai.model = 'qwen3.7-plus';
      }
    });
  }

  const profiles = (cfg.aiProfiles || []).map(p => {
    const decrypted = p.apiKey ? decryptKey(p.apiKey) : '';
    const entry = { ...p, apiKey: decrypted };
    // Stored key exists but decryption failed (DPAPI master key lost — e.g. Windows
    // password reset, different user account, or config copied from another machine).
    // Flag it so the renderer can show a clear "re-enter key" warning.
    if (p.apiKey && !decrypted) entry.keyError = 'decrypt_failed';
    return entry;
  });
  return {
    profiles,
    strategy: cfg.aiStrategy || 'failover',
    activeId: cfg.aiActiveId || ''
  };
});

ipcMain.handle('config:set-ai-profiles', async (_event, { profiles, strategy, activeId }) => {
  const list = Array.isArray(profiles) ? profiles : [];
  const prepared = list.map(p => {
    const toSave = { ...p };
    delete toSave.keyError; // runtime-only flag, never persist
    if (toSave.apiKey) {
      const encrypted = encryptKey(toSave.apiKey);
      toSave.apiKey = encrypted || ''; // Never store plaintext
    }
    return toSave;
  });
  // Keep legacy cfg.ai in sync with active profile for backward compat
  const active = list.find(p => p.id === activeId) || list.find(p => p.enabled);
  await withConfig(cfg => {
    cfg.aiProfiles = prepared;
    cfg.aiStrategy = strategy || 'failover';
    cfg.aiActiveId = activeId || '';
    if (active) {
      cfg.ai = { provider: active.provider, apiKey: active.apiKey ? encryptKey(active.apiKey) : '', model: active.model || '', endpoint: active.endpoint || '' };
    }
  });
  return { success: true };
});

// --- Sellers (Người nhận đặt) persisted to app-config.json ---
ipcMain.handle('config:get-sellers', async () => {
  const cfg = await readConfig();
  return cfg.sellers || [];
});

ipcMain.handle('config:set-sellers', async (_event, sellers) => {
  await withConfig(cfg => { cfg.sellers = Array.isArray(sellers) ? sellers : []; });
  return { success: true };
});

// --- KV thùng code overrides (kvCodeThung) ---
// Dev mode: merge trực tiếp vào kv-name-map.json (entry.kvCodeThung).
// Packaged mode (asar read-only): mirror vào app-config.json (kvThungOverrides).
// Renderer gộp cả hai nguồn khi load (config thắng).
function getKvNameMapPath() {
  return path.join(__dirname, 'kv-name-map.json');
}

function writeKvThungToJsonFile(productId, code) {
  try {
    const p = getKvNameMapPath();
    let map = {};
    try { map = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e) { /* file chưa có → tạo mới */ }
    if (!map[productId]) map[productId] = {};
    if (code) map[productId].kvCodeThung = code;
    else delete map[productId].kvCodeThung;
    // Ghi atomic để crash giữa lúc ghi không làm hỏng kv-name-map.json
    atomicWriteJson(p, JSON.stringify(map, null, 2) + '\n')
      .catch(e => console.warn('[KV map] atomic write failed:', e.message));
    return true;
  } catch (e) {
    console.warn('[KV map] kv-name-map.json write failed (fallback to app-config.json):', e.message);
    return false;
  }
}

ipcMain.handle('kvmap:get-thung-overrides', async () => {
  const cfg = await readConfig();
  return cfg.kvThungOverrides || {};
});

ipcMain.handle('kvmap:set-thung-override', async (_event, { productId, code }) => {
  if (!productId || typeof productId !== 'string') {
    return { success: false, error: 'invalid productId' };
  }
  const val = (code || '').toString().trim();
  // 1) Mirror vào app-config.json — luôn hoạt động (kể cả packaged/asar)
  await withConfig(cfg => {
    if (!cfg.kvThungOverrides) cfg.kvThungOverrides = {};
    if (val) cfg.kvThungOverrides[productId] = val;
    else delete cfg.kvThungOverrides[productId];
  });
  // 2) Merge vào kv-name-map.json nếu ghi được (dev mode)
  const jsonWritten = writeKvThungToJsonFile(productId, val);
  return { success: true, jsonWritten };
});

// --- KV mã GỐC (kvCode) overrides — cùng pattern với kvCodeThung ---
// Sửa "Mã KV" trên UI phải ghi được vào kv-name-map.json / app-config.json,
// nếu không giá trị cũ trong kv-name-map.json luôn thắng product.kvCode.
function writeKvBaseToJsonFile(productId, code) {
  try {
    const p = getKvNameMapPath();
    let map = {};
    try { map = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e) { /* file chưa có → tạo mới */ }
    if (!map[productId]) map[productId] = {};
    if (code) map[productId].kvCode = code;
    else delete map[productId].kvCode;
    // Ghi atomic để crash giữa lúc ghi không làm hỏng kv-name-map.json
    atomicWriteJson(p, JSON.stringify(map, null, 2) + '\n')
      .catch(e => console.warn('[KV map] atomic write failed:', e.message));
    return true;
  } catch (e) {
    console.warn('[KV map] kv-name-map.json write failed (fallback to app-config.json):', e.message);
    return false;
  }
}

ipcMain.handle('kvmap:get-base-overrides', async () => {
  const cfg = await readConfig();
  return cfg.kvBaseOverrides || {};
});

ipcMain.handle('kvmap:set-base-code', async (_event, { productId, code }) => {
  if (!productId || typeof productId !== 'string') {
    return { success: false, error: 'invalid productId' };
  }
  const val = (code || '').toString().trim();
  // 1) Mirror vào app-config.json — luôn hoạt động (kể cả packaged/asar)
  await withConfig(cfg => {
    if (!cfg.kvBaseOverrides) cfg.kvBaseOverrides = {};
    if (val) cfg.kvBaseOverrides[productId] = val;
    else delete cfg.kvBaseOverrides[productId];
  });
  // 2) Merge vào kv-name-map.json nếu ghi được (dev mode)
  const jsonWritten = writeKvBaseToJsonFile(productId, val);
  return { success: true, jsonWritten };
});

// --- Customer Special-Price Notes (Khách có đơn giá riêng) persisted to app-config.json ---
ipcMain.handle('config:get-customer-notes', async () => {
  const cfg = await readConfig();
  return cfg.customerNotes || [];
});

ipcMain.handle('config:set-customer-notes', async (_event, notes) => {
  await withConfig(cfg => { cfg.customerNotes = Array.isArray(notes) ? notes : []; });
  return { success: true };
});

ipcMain.handle('config:pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Chọn thư mục I.ĐƠN HÀNG',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});


// Helper to get the correct path for unpacked resources
function getUnpackedPath(filename) {
  return path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), filename);
}

// --- Excel Export Logic (replicated from excel-server.js for IPC mode) ---

/**
 * Resolves the base directory for order files.
 * Priority:
 *   1. ORDER_DIR env var
 *   2. Config file (saved via Settings UI)
 *   3. resourcesPath/I.ĐƠN HÀNG (if bundled)
 *   4. Smart scan: walk up from app location looking for I.ĐƠN HÀNG
 *   5. __dirname/I.ĐƠN HÀNG (dev mode)
 */
async function getBaseDir() {
  // 1. Explicit env var
  if (process.env.ORDER_DIR && fs.existsSync(process.env.ORDER_DIR)) return process.env.ORDER_DIR;

  // 2. Config file (saved from Settings UI)
  const cfg = await readConfig();
  if (cfg.orderDir && fs.existsSync(cfg.orderDir)) return cfg.orderDir;

  // 3. resourcesPath/I.ĐƠN HÀNG (if bundled into installer)
  if (app.isPackaged) {
    const resDir = path.join(process.resourcesPath, 'I.ĐƠN HÀNG');
    if (fs.existsSync(resDir)) return resDir;
  }

  // 4. Smart scan: walk up from app location (max 4 levels)
  const startDir = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
  let dir = startDir;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'I.ĐƠN HÀNG');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached root
    dir = parent;
  }

  // 5. Dev fallback
  return path.join(__dirname, 'I.ĐƠN HÀNG');
}

function getFolderForBrand(brand) {
  const b = brand.toLowerCase();
  if (b.includes('znt')) return '6. ZENTOR';
  if (b.includes('torvex') || b.includes('tvx')) return '5. TORVEX';
  if (b.includes('xvil')) return '2. XVIL';
  if (b.includes('veltra')) return '1. VELTRA';
  if (b.includes('petrix')) return '3. PETRIX';
  if (b.includes('veltron')) return '4. VELTRON';
  return null;
}

// --- Month/Year routing helpers (shared logic with excel-server.js) ---

const EN_MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
};
const EN_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const EN_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseOrderDate(orderDate) {
  const m = String(orderDate).match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (!m) return null;
  const month = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  if (month < 1 || month > 12) return null;
  return { month, year };
}

function isValidOrderFile(file) {
  const ext = path.extname(file).toLowerCase();
  // Chấp nhận cả .xlsx (Torvex, Zentor, Xvil, Petrix) và .xls (Veltron, Veltra)
  if (ext !== '.xlsx' && ext !== '.xls') return false;
  if (file.startsWith('~$')) return false;
  const lower = file.toLowerCase();
  return !lower.includes('backup') && !lower.includes('copy') && !lower.includes('template') &&
    !lower.includes('merchandise') && !lower.includes('báo cáo') && !lower.includes('import') &&
    !lower.includes('event') && !lower.includes('pnk') && !lower.includes('list');
}

function pickNewestValidExcel(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  let entries;
  try { entries = fs.readdirSync(dir); } catch (e) { return null; }
  const files = [];
  entries.forEach(file => {
    const fp = path.join(dir, file);
    let stat;
    try { stat = fs.statSync(fp); } catch (e) { return; }
    if (stat.isFile() && isValidOrderFile(file)) {
      files.push({ path: fp, mtime: stat.mtime });
    }
  });
  if (files.length === 0) return null;
  files.sort((a, b) => b.mtime - a.mtime);
  return files[0].path;
}

function extractYear(name) {
  const m = String(name).match(/(20\d{2})/);
  return m ? parseInt(m[1], 10) : null;
}

function extractMonth(name) {
  const s = String(name);
  // 1. Vietnamese "Tháng N" (handles "1. Tháng 5" -> 5)
  const vi = s.match(/th[aá]ng\s*0*(\d{1,2})/i);
  if (vi) { const n = parseInt(vi[1], 10); if (n >= 1 && n <= 12) return n; }
  // 2. English month name / abbrev (handles "July", "Jun26" -> jun)
  const words = s.toLowerCase().match(/[a-z]+/g) || [];
  for (const w of words) {
    if (EN_MONTHS[w] !== undefined) return EN_MONTHS[w];
  }
  // 3. Fallback: leading sequence number "7. ..." (skip year folders like "7. NĂM 2026")
  const lead = s.match(/^\s*0*(\d{1,2})[.)]/);
  if (lead && !/20\d{2}/.test(s)) { const n = parseInt(lead[1], 10); if (n >= 1 && n <= 12) return n; }
  return null;
}

function findYearFolder(brandDir, year) {
  let entries;
  try { entries = fs.readdirSync(brandDir); } catch (e) { return null; }
  const matches = [];
  entries.forEach(name => {
    const fp = path.join(brandDir, name);
    let stat;
    try { stat = fs.statSync(fp); } catch (e) { return; }
    if (stat.isDirectory() && extractYear(name) === year) matches.push(fp);
  });
  if (matches.length === 0) return null;
  return matches[0];
}

function findMonthFolder(yearRoot, month) {
  let entries;
  try { entries = fs.readdirSync(yearRoot); } catch (e) { return null; }
  const matches = [];
  entries.forEach(name => {
    const fp = path.join(yearRoot, name);
    let stat;
    try { stat = fs.statSync(fp); } catch (e) { return; }
    if (stat.isDirectory() && extractMonth(name) === month) matches.push(fp);
  });
  if (matches.length === 0) return null;
  return matches[0];
}

function matchCase(src, target) {
  if (src === src.toUpperCase()) return target.toUpperCase();
  if (src[0] === src[0].toUpperCase()) return target.charAt(0).toUpperCase() + target.slice(1).toLowerCase();
  return target.toLowerCase();
}

// Replace the month token inside a file/folder name, keeping style + year suffix.
// Returns null when no recognizable month token is found (caller must not guess).
function replaceMonthToken(name, fromMonth, toMonth) {
  // 1. Vietnamese "Tháng N"
  const viRe = /(th[aá]ng\s*)0*(\d{1,2})/i;
  const mVi = name.match(viRe);
  if (mVi && parseInt(mVi[2], 10) === fromMonth) {
    return name.replace(viRe, `$1${toMonth}`);
  }
  // 2. English full name (e.g. July -> August)
  const fullFrom = EN_FULL[fromMonth - 1];
  const fullRe = new RegExp(fullFrom, 'i');
  if (fullRe.test(name)) {
    return name.replace(fullRe, (match) => matchCase(match, EN_FULL[toMonth - 1]));
  }
  // 3. English abbrev, optionally glued to a year (e.g. Jun26 -> Jul26)
  const abbrFrom = EN_ABBR[fromMonth - 1];
  const abbrRe = new RegExp('\\b' + abbrFrom + '(?=\\d|\\b)', 'i');
  if (abbrRe.test(name)) {
    return name.replace(abbrRe, (match) => matchCase(match, EN_ABBR[toMonth - 1]));
  }
  return null;
}

// Derive a new month folder name from the previous month's folder name.
function deriveMonthFolderName(prevName, fromMonth, toMonth) {
  let newName = replaceMonthToken(prevName, fromMonth, toMonth);
  if (newName === null) return null;
  // bump the leading sequence number if present (e.g. "6." -> "7.", "1." -> "2.")
  newName = newName.replace(/^(\s*)0*(\d{1,2})([.)])/, (m, sp, num, sep) => sp + (parseInt(num, 10) + 1) + sep);
  return newName;
}

// Runs excel_create_month.py to strip a copied file down to a single blank
// "0-MAU" order template while keeping all non-order (reference) sheets.
function runCreateMonthScript(filePath) {
  return new Promise((resolve) => {
    const pythonPath = getPythonPath();
    if (!pythonPath) {
      resolve({ error: 'Không tìm thấy Python. Vui lòng cài đặt Python 3.12+.' });
      return;
    }
    const scriptPath = getUnpackedPath('excel_create_month.py');
    execFile(pythonPath, [scriptPath, '--file', filePath], { env: { ...process.env, PYTHONUTF8: '1' } }, (error, stdout, stderr) => {
      if (error || !String(stdout).includes('CREATE_MONTH_OK')) {
        resolve({ error: `Lỗi tạo file tháng mới: ${stderr || (error && error.message) || 'không rõ'}` });
        return;
      }
      resolve({});
    });
  });
}

// --- AI File Resolution Cache (persists AI decisions per brand+month) ---
const _aiFileCache = new Map(); // key: "brand|year|month" → filePath

function getAiCacheKey(brand, year, month) {
  return `${brand}|${year}|${month}`;
}

function cacheAiResolution(brand, year, month, filePath) {
  _aiFileCache.set(getAiCacheKey(brand, year, month), filePath);
  // Also persist to disk so it survives app restarts
  try {
    const cachePath = path.join(app.getPath('userData'), 'ai-file-cache.json');
    let data = {};
    if (fs.existsSync(cachePath)) {
      try { data = JSON.parse(fs.readFileSync(cachePath, 'utf-8')); } catch (e) { data = {}; }
    }
    data[getAiCacheKey(brand, year, month)] = filePath;
    // Prune on write: keep only entries of the CURRENT year (key format: "brand|year|month") —
    // but ALWAYS keep the entry just written (may be an older year being processed now).
    const newKey = getAiCacheKey(brand, year, month);
    const currentYear = String(new Date().getFullYear());
    for (const key of Object.keys(data)) {
      if (key !== newKey && String(key).split('|')[1] !== currentYear) delete data[key];
    }
    fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) { /* best-effort */ }
}

function loadAiCache() {
  try {
    const cachePath = path.join(app.getPath('userData'), 'ai-file-cache.json');
    if (fs.existsSync(cachePath)) {
      const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      // Prune on read: only entries of the CURRENT year are relevant (key: "brand|year|month")
      const currentYear = String(new Date().getFullYear());
      for (const [key, val] of Object.entries(data)) {
        if (String(key).split('|')[1] === currentYear) {
          _aiFileCache.set(key, val);
        }
      }
    }
  } catch (e) { /* best-effort */ }
}
// Load cache on startup
loadAiCache();

// Resolve the destination Excel file for an order, routed by year + month.
// Auto-creates the current month's file from the previous month when missing.
// Returns { filePath, created } on success or { error } on failure.
async function resolveTargetExcel(brand, orderDate) {
  const baseDir = await getBaseDir();
  const folderName = getFolderForBrand(brand);
  if (!folderName) return { error: `Không xác định thư mục cho nhãn hàng ${brand}` };
  const brandDir = path.join(baseDir, folderName);
  if (!fs.existsSync(brandDir)) {
    const baseExists = fs.existsSync(baseDir);
    const hint = baseExists
      ? `Thư mục gốc "${baseDir}" tồn tại nhưng không có folder "${folderName}" bên trong.`
      : `Thư mục gốc "${baseDir}" không tồn tại. Vui lòng vào Cài Đặt → Hệ thống để chọn đúng thư mục I.ĐƠN HÀNG.`;
    return { error: `Không tìm thấy thư mục hãng: ${brandDir}\n${hint}` };
  }

  const parsed = parseOrderDate(orderDate);
  if (!parsed) return { error: `Ngày đơn không hợp lệ: ${orderDate}` };
  const { month, year } = parsed;

  // 0. Check AI cache — if AI previously resolved this brand+month, reuse it.
  const cached = _aiFileCache.get(getAiCacheKey(brand, year, month));
  if (cached && fs.existsSync(cached)) {
    return { filePath: cached, created: false };
  }

  const yearRoot = findYearFolder(brandDir, year) || brandDir;

  // 1. Current month folder already has a valid file -> use it.
  const monthDir = findMonthFolder(yearRoot, month);
  if (monthDir) {
    const file = pickNewestValidExcel(monthDir);
    if (file) return { filePath: file, created: false };
  }

  // 2. Missing current month file -> auto-create from previous month.
  if (month === 1) {
    return { error: `Chưa có file Excel tháng 1/${year} cho hãng ${brand.toUpperCase()}, vui lòng tạo thủ công.` };
  }

  const prevMonth = month - 1;
  const prevMonthDir = findMonthFolder(yearRoot, prevMonth);
  if (!prevMonthDir) {
    return { error: `Không tìm thấy folder tháng ${prevMonth}/${year} để làm mẫu cho hãng ${brand.toUpperCase()}. Vui lòng tạo file tháng ${month} thủ công.` };
  }
  const sourceFile = pickNewestValidExcel(prevMonthDir);
  if (!sourceFile) {
    return { error: `Không tìm thấy file Excel trong folder tháng ${prevMonth}/${year} để làm mẫu. Vui lòng tạo file tháng ${month} thủ công.` };
  }

  // Target month folder (create if missing).
  let targetMonthDir = monthDir;
  if (!targetMonthDir) {
    const prevFolderName = path.basename(prevMonthDir);
    const newFolderName = deriveMonthFolderName(prevFolderName, prevMonth, month);
    if (!newFolderName) {
      return { error: `Không nhận diện được tên tháng trong folder "${prevFolderName}" để tạo folder tháng ${month}. Vui lòng tạo thủ công.` };
    }
    targetMonthDir = path.join(yearRoot, newFolderName);
    try {
      if (!fs.existsSync(targetMonthDir)) fs.mkdirSync(targetMonthDir, { recursive: true });
    } catch (e) {
      return { error: `Không tạo được folder tháng mới: ${e.message}` };
    }
  }

  // Target file name (replace month token in source name).
  const srcName = path.basename(sourceFile);
  const newName = replaceMonthToken(srcName, prevMonth, month);
  if (!newName) {
    return { error: `Không nhận diện được token tháng trong tên file "${srcName}" để đặt tên file tháng ${month}. Vui lòng tạo thủ công.` };
  }
  const targetFile = path.join(targetMonthDir, newName);

  // Already created earlier (e.g. a prior order this month) -> reuse.
  if (fs.existsSync(targetFile)) {
    return { filePath: targetFile, created: false };
  }

  try {
    fs.copyFileSync(sourceFile, targetFile);
  } catch (e) {
    return { error: `Không sao chép được file mẫu: ${e.message}` };
  }

  const cleanResult = await runCreateMonthScript(targetFile);
  if (cleanResult && cleanResult.error) {
    return { error: cleanResult.error };
  }

  return { filePath: targetFile, created: true };
}

/**
 * Wait until the exported workbook is no longer locked, then open it with
 * the default application (Excel).
 *
 * Two pitfalls handled here:
 *  1. The Python automation force-kills its own EXCEL.EXE in a finally
 *     block; the file can stay locked for a moment after python.exe exits.
 *     We poll until an exclusive open succeeds (or time out and try anyway).
 *  2. shell.openPath() RESOLVES with an error string on failure — it does
 *     NOT reject — so the result must be checked explicitly and a plain
 *     .catch() would swallow every real failure silently.
 *
 * @param {string} filePath  Absolute path to the exported workbook.
 * @param {number} [timeoutMs]  Max time to wait for the lock to release.
 * @returns {Promise<boolean>} true when the file was handed off to the OS.
 */
async function openExportedFile(filePath, timeoutMs = 3000) {
  // 1. Poll for the file lock to be released (every 200ms).
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const fd = fs.openSync(filePath, 'r+');
      fs.closeSync(fd);
      break; // lock released
    } catch (e) {
      if (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES') {
        await new Promise(r => setTimeout(r, 200));
      } else {
        break; // unrelated error — attempt the open anyway
      }
    }
  }

  // 2. Open with the default app; check the resolved error string; retry once.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const errMsg = await shell.openPath(filePath);
      if (!errMsg) {
        console.log('[Excel Export] Auto-opened file:', filePath);
        return true;
      }
      console.warn(`[Excel Export] shell.openPath attempt ${attempt} failed: ${errMsg}`);
    } catch (err) {
      console.warn(`[Excel Export] shell.openPath attempt ${attempt} threw:`, err.message);
    }
    if (attempt < 2) await new Promise(r => setTimeout(r, 600));
  }
  return false;
}

/**
 * IPC Handler: excel:export-order
 * Runs the Python automation script directly from the main process.
 */
ipcMain.handle('excel:export-order', async (_event, data) => {
  const { brand, customerName, orderDate, items, tlnText, orderTitle } = data;
  if (!brand || !customerName || !orderDate || !items) {
    return { error: 'Thiếu thông số đầu vào' };
  }

  // Mutex: reject concurrent exports to prevent file corruption
  if (_exportInProgress) {
    return { error: 'Đang xử lý đơn hàng khác, vui lòng đợi hoàn tất trước khi xuất đơn mới.' };
  }
  _exportInProgress = true;

  try {
    const resolved = await resolveTargetExcel(brand, orderDate);
    if (resolved.error) {
      appendExportLog({ brand, customerName, status: 'error', error: resolved.error });
      return { error: resolved.error };
    }
    const filePath = resolved.filePath;
    const createdNewFile = resolved.created;

    console.log(`[Excel Export] ${brand} order for ${customerName} into ${filePath}...`);

    // --- Auto-close: if the target workbook is currently open in Excel,
    // gracefully save & close it first, then reopen after export. ---
    // COM close is best-effort: Excel can release the file slowly, or
    // GetActiveObject can miss the running instance right after open.
    // Retry a few times before falling back to asking the user.
    let wasOpenInExcel = false;
    let locked = true;
    if (isFileLocked(filePath)) {
      for (let attempt = 1; attempt <= 3 && locked; attempt++) {
        console.log(`[Excel Export] File is locked (likely open in Excel), attempting graceful close (${attempt}/3):`, filePath);
        if (await closeExcelWorkbookGracefully(filePath)) {
          wasOpenInExcel = true;
          console.log('[Excel Export] File was open in Excel — closed it for export, will reopen after.');
          locked = false;
          break;
        }
        if (!isFileExclusiveLocked(filePath)) {
          // COM close failed but the file is NOT actually held by any process
          // → stale ~$ lock file left behind by a crashed Excel → safe to remove
          const staleLock = getExcelLockFilePath(filePath);
          try { if (fs.existsSync(staleLock)) fs.unlinkSync(staleLock); } catch (e) { /* ignore */ }
          console.log('[Excel Export] Removed stale Excel lock file:', staleLock);
          locked = false;
          break;
        }
        console.log(`[Excel Export] Graceful close attempt ${attempt}/3 failed — file still locked, retrying...`);
        if (attempt < 3) await new Promise(r => setTimeout(r, 2500));
      }
      if (locked) {
        // Truly locked by another process and COM close failed after retries
        appendExportLog({ brand, customerName, filePath, status: 'error', error: 'File đang mở trong Excel' });
        return { error: `File "${path.basename(filePath)}" đang được mở trong Excel và không thể tự đóng sau 3 lần thử.\nExcel có thể đang bận — hãy lưu và đóng file rồi bấm Xuất lần nữa.` };
      }
    }

    const pythonPath = getPythonPath();
    if (!pythonPath) {
      appendExportLog({ brand, customerName, status: 'error', error: 'Python not found' });
      return { error: 'Không tìm thấy Python. Vui lòng cài đặt Python 3.12+.' };
    }

    return await new Promise((resolve) => {
      // Ghi file tạm có bảo vệ: đĩa đầy / lỗi quyền sẽ trả lỗi thân thiện
      // thay vì sinh rejection không kiểm soát bên trong executor.
      let tempJsonPath;
      let tempTlnPath;
      let tempMetaPath;
      let scriptPath; // khai báo ngoài try: args bên dưới vẫn cần tham chiếu
      try {
        scriptPath = getUnpackedPath('excel_automation.py');
        const itemsJson = JSON.stringify(items);
        tempJsonPath = path.join(app.getPath('temp'), `order_${Date.now()}.json`);
        fs.writeFileSync(tempJsonPath, itemsJson, 'utf-8');

        // Write TLN text to a temp file (avoid command-line encoding issues)
        if (tlnText) {
          tempTlnPath = path.join(app.getPath('temp'), `tln_${Date.now()}.txt`);
          fs.writeFileSync(tempTlnPath, tlnText, 'utf-8');
        }

        // Tên khách/tiêu đề tiếng Việt cũng đi qua file tạm (argv Windows dễ
        // lệch encoding khi đổi cách gọi process — nhất quán với tlnText)
        tempMetaPath = path.join(app.getPath('temp'), `order_meta_${Date.now()}.json`);
        fs.writeFileSync(tempMetaPath, JSON.stringify({
          customer: customerName || '',
          title: orderTitle || '',
          date: orderDate || '',
        }), 'utf-8');
      } catch (writeErr) {
        console.error('[Excel Export] Failed to write temp files:', writeErr);
        appendExportLog({ brand, customerName, filePath, status: 'error', error: String(writeErr) });
        resolve({ error: `Không thể ghi file tạm phục vụ xuất Excel: ${writeErr.message}` });
        return;
      }

      const args = [
        scriptPath,
        '--file', filePath,
        '--customer', customerName,
        '--date', orderDate,
        '--items', tempJsonPath,
        '--meta', tempMetaPath
      ];
      if (tlnText) {
        args.push('--tln', tempTlnPath);
      }
      if (orderTitle) {
        args.push('--title', orderTitle);
      }

      // Timeout: kill Python if Excel hangs beyond EXPORT_TIMEOUT_MS
      const child = execFile(pythonPath, args, { timeout: EXPORT_TIMEOUT_MS, env: { ...process.env, PYTHONUTF8: '1' } }, (error, _stdout, stderr) => {
        try { if (fs.existsSync(tempJsonPath)) fs.unlinkSync(tempJsonPath); } catch (e) { /* ignore */ }
        try { if (tlnText && fs.existsSync(tempTlnPath)) fs.unlinkSync(tempTlnPath); } catch (e) { /* ignore */ }
        try { if (tempMetaPath && fs.existsSync(tempMetaPath)) fs.unlinkSync(tempMetaPath); } catch (e) { /* ignore */ }

        if (error) {
          const isTimeout = error.killed || (error.signal && error.signal === 'SIGTERM');
          if (isTimeout) {
            cleanupBackgroundExcelProcesses();
          }
          const errMsg = isTimeout
            ? `Excel bị treo quá ${EXPORT_TIMEOUT_MS / 1000}s — đã hủy tiến trình. Vui lòng kiểm tra file Excel có đang mở hay không.`
            : `Lỗi Excel Automation: ${stderr || error.message}`;
          console.error('[Excel Export] Python Error:', stderr || error.message);
          appendExportLog({ brand, customerName, filePath, status: 'error', error: errMsg });
          resolve({ error: errMsg });
          return;
        }
        console.log('[Excel Export] Success:', filePath);
        appendExportLog({ brand, customerName, filePath, status: 'success', items: items.length });
        // Auto-open the exported Excel file with the default application.
        // (Also reopens the file if it was auto-closed before export.)
        // .catch đảm bảo promise luôn settle — nếu không, renderer đờ man
        // vĩnh viễn và mutex _exportInProgress bị kẹt true mãi mãi.
        openExportedFile(filePath)
          .catch((openErr) => {
            console.warn('[Excel Export] openExportedFile threw:', openErr && openErr.message);
            return false;
          })
          .then(opened => {
            if (!opened) {
              console.warn('[Excel Export] Could not auto-open file:', filePath);
            }
            resolve({ success: true, filePath, created: createdNewFile, opened, wasOpenInExcel });
          });
      });
    });
  } catch (unexpectedErr) {
    // Bất kỳ exception lọt ra ngoài (không lường trước) sẽ trở thành phản hồi
    // {error} thân thiện thay vì rejection IPC mờ nhạt "Lỗi IPC Excel export".
    console.error('[Excel Export] Unexpected handler error:', unexpectedErr);
    appendExportLog({ brand, customerName, status: 'error', error: `Unexpected: ${String((unexpectedErr && unexpectedErr.stack) || unexpectedErr)}` });
    return { error: `Lỗi không mong muốn khi xuất Excel: ${unexpectedErr && unexpectedErr.message ? unexpectedErr.message : unexpectedErr}` };
  } finally {
    _exportInProgress = false;
  }
});

/**
 * IPC Handler: excel:diagnose
 * Gathers directory context when file resolution fails, so the renderer
 * can send it to AI for intelligent suggestion.
 */
ipcMain.handle('excel:diagnose', async (_event, { brand, orderDate }) => {
  const baseDir = await getBaseDir();
  const folderName = getFolderForBrand(brand);
  if (!folderName) return { error: `Không xác định thư mục cho nhãn hàng ${brand}` };

  const brandDir = path.join(baseDir, folderName);
  if (!fs.existsSync(brandDir)) {
    return { error: `Thư mục hãng không tồn tại: ${brandDir}` };
  }

  const parsed = parseOrderDate(orderDate);
  const month = parsed ? parsed.month : null;
  const year = parsed ? parsed.year : null;

  // Build a tree snapshot of the brand directory (2 levels deep)
  const tree = [];
  try {
    const yearEntries = fs.readdirSync(brandDir);
    for (const ye of yearEntries) {
      const yePath = path.join(brandDir, ye);
      let yeStat;
      try { yeStat = fs.statSync(yePath); } catch (e) { continue; }
      if (!yeStat.isDirectory()) {
        // List root-level files too (might be misplaced order files)
        if (isValidOrderFile(ye)) tree.push({ type: 'file', name: ye, path: yePath });
        continue;
      }
      const yearNode = { type: 'dir', name: ye, path: yePath, children: [] };
      try {
        const monthEntries = fs.readdirSync(yePath);
        for (const me of monthEntries) {
          const mePath = path.join(yePath, me);
          let meStat;
          try { meStat = fs.statSync(mePath); } catch (e) { continue; }
          if (meStat.isDirectory()) {
            const monthNode = { type: 'dir', name: me, path: mePath, files: [] };
            try {
              const files = fs.readdirSync(mePath);
              for (const f of files) {
                if (f.startsWith('~$')) continue;
                const fp = path.join(mePath, f);
                let fStat;
                try { fStat = fs.statSync(fp); } catch (e) { continue; }
                if (fStat.isFile()) {
                  monthNode.files.push({ name: f, ext: path.extname(f), size: fStat.size, mtime: fStat.mtime.toISOString() });
                }
              }
            } catch (e) { /* skip */ }
            yearNode.children.push(monthNode);
          } else if (meStat.isFile() && isValidOrderFile(me)) {
            yearNode.children.push({ type: 'file', name: me, path: mePath });
          }
        }
      } catch (e) { /* skip */ }
      tree.push(yearNode);
    }
  } catch (e) {
    return { error: `Không đọc được thư mục: ${e.message}` };
  }

  return {
    brand,
    brandDir,
    orderDate,
    targetMonth: month,
    targetYear: year,
    tree,
    // Include what the rule-based system tried
    rules: {
      yearFolder: findYearFolder(brandDir, year) ? path.basename(findYearFolder(brandDir, year)) : null,
      monthFolder: (() => { const yr = findYearFolder(brandDir, year); return yr && findMonthFolder(yr, month) ? path.basename(findMonthFolder(yr, month)) : null; })(),
    }
  };
});

/**
 * IPC Handler: excel:apply-fix
 * Applies an AI-suggested fix action. Supported actions:
 *  - { action: 'use_file', filePath } → re-run export with this file
 *  - { action: 'rename_file', filePath, newName } → rename a file
 *  - { action: 'rename_folder', folderPath, newName } → rename a folder
 *
 * Bảo mật: mọi đường dẫn nhận từ renderer đều bị giới hạn bên trong thư mục
 * đơn hàng gốc (baseDir) — trước đây handler cho phép rename file/thư mục
 * BẤT KỲ trên đĩa.
 */
function _isPathInsideBase(targetPath, baseDir) {
  if (!targetPath || !baseDir) return false;
  const rel = path.relative(path.resolve(baseDir), path.resolve(targetPath));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Tên mới khi rename: cấm ký tự đường dẫn / dấu chấm kép (chống escape thư mục). */
function _isValidRenameName(name) {
  return typeof name === 'string' && name.trim().length > 0 && name.length < 255
    && !/[\\/:*?"<>|]/.test(name)
    && !name.includes('..')
    && name.trim() !== '.' ;
}

ipcMain.handle('excel:apply-fix', async (_event, fix) => {
  try {
    if (!fix || !fix.action) return { error: 'Thiếu action' };

    const baseDir = await getBaseDir();

    let resolvedPath = null;

    if (fix.action === 'use_file') {
      if (!fix.filePath || !fs.existsSync(fix.filePath)) {
        return { error: `File không tồn tại: ${fix.filePath}` };
      }
      if (!_isPathInsideBase(fix.filePath, baseDir)) {
        return { error: 'Đường dẫn nằm ngoài thư mục đơn hàng — bị chặn.' };
      }
      resolvedPath = fix.filePath;
    } else if (fix.action === 'rename_file') {
      if (!fix.filePath || !fs.existsSync(fix.filePath)) {
        return { error: `File không tồn tại: ${fix.filePath}` };
      }
      if (!_isPathInsideBase(fix.filePath, baseDir)) {
        return { error: 'Đường dẫn nằm ngoài thư mục đơn hàng — bị chặn.' };
      }
      if (!_isValidRenameName(fix.newName)) {
        return { error: `Tên mới không hợp lệ: ${fix.newName}` };
      }
      const dir = path.dirname(fix.filePath);
      const newPath = path.join(dir, fix.newName);
      if (fs.existsSync(newPath)) return { error: `Tên mới đã tồn tại: ${fix.newName}` };
      fs.renameSync(fix.filePath, newPath);
      resolvedPath = newPath;
    } else if (fix.action === 'rename_folder') {
      if (!fix.folderPath || !fs.existsSync(fix.folderPath)) {
        return { error: `Folder không tồn tại: ${fix.folderPath}` };
      }
      if (!_isPathInsideBase(fix.folderPath, baseDir)) {
        return { error: 'Đường dẫn nằm ngoài thư mục đơn hàng — bị chặn.' };
      }
      if (!_isValidRenameName(fix.newName)) {
        return { error: `Tên mới không hợp lệ: ${fix.newName}` };
      }
      const parent = path.dirname(fix.folderPath);
      const newPath = path.join(parent, fix.newName);
      if (fs.existsSync(newPath)) return { error: `Tên mới đã tồn tại: ${fix.newName}` };
      fs.renameSync(fix.folderPath, newPath);
      return { success: true, folderPath: newPath, renamed: true };
    } else {
      return { error: `Action không hỗ trợ: ${fix.action}` };
    }

    // Cache the AI resolution so subsequent exports skip AI entirely
    if (resolvedPath && fix.brand && fix.year && fix.month) {
      cacheAiResolution(fix.brand, fix.year, fix.month, resolvedPath);
    }

    return { success: true, filePath: resolvedPath, renamed: fix.action === 'rename_file' };
  } catch (e) {
    return { error: `Lỗi áp dụng fix: ${e.message}` };
  }
});

// --- Export Audit Log (persistent traceability) ---

function getLogPath() {
  return path.join(app.getPath('userData'), 'export-log.jsonl');
}

function appendExportLog(entry) {
  try {
    const p = getLogPath();
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(p, line, 'utf-8');
    // Prune right after append (exports are user-paced/rare, so this is cheap):
    // once the file exceeds ~1MB or 1000 lines, keep only the last 1000 lines.
    try {
      const st = fs.statSync(p);
      if (st.size > 262144) { // > 256KB → worth a line-count check
        const lines = fs.readFileSync(p, 'utf-8').split('\n').filter(l => l.trim() !== '');
        if (st.size > 1048576 || lines.length > 1000) {
          fs.writeFileSync(p, lines.slice(-1000).join('\n') + '\n', 'utf-8');
          console.log(`[Export Log] Pruned to last 1000 lines (was ${lines.length} lines, ${(st.size / 1024).toFixed(0)} KB)`);
        }
      }
    } catch (pe) { /* best-effort prune — never break audit logging */ }
  } catch (e) { /* best-effort logging */ }
}

// --- Stale Temp File Cleanup ---

async function cleanStaleTempFiles() {
  try {
    const tmpDir = app.getPath('temp');
    const files = await fs.promises.readdir(tmpDir);
    const now = Date.now();
    const MAX_AGE_MS = 3600000; // 1 hour
    for (const f of files) {
      if ((f.startsWith('order_') && f.endsWith('.json')) || (f.startsWith('tln_') && f.endsWith('.txt'))) {
        const fp = path.join(tmpDir, f);
        try {
          const stat = await fs.promises.stat(fp);
          if (now - stat.mtimeMs > MAX_AGE_MS) {
            await fs.promises.unlink(fp);
            console.log(`[Cleanup] Removed stale temp: ${f}`);
          }
        } catch (e) { /* skip */ }
      }
    }
  } catch (e) { /* best-effort */ }
}

function createMainWindow() {
  const iconPath = path.join(__dirname, 'resources', 'icon.ico');
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'Lên đơn hàng',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  // Content Security Policy - allow Gemini/OpenAI API + inline styles/handlers
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          "script-src 'self' 'unsafe-inline'; " +
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
          "img-src 'self' data: blob:; " +
          "font-src 'self' data: https://fonts.gstatic.com; " +
          "connect-src 'self' https: http://localhost:* http://127.0.0.1:*; " +
          "worker-src 'self' blob:"
        ],
      },
    });
  });

  // Load the app
  if (process.env.NODE_ENV === 'development' || process.env.VITE_DEV_SERVER_URL) {
    // Dev mode: load from Vite dev server for HMR
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173');
  } else {
    // Production / normal launch: load bundled output from dist/
    // (index.html uses <script type="module"> which requires HTTP or bundling)
    mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }

  // Open DevTools in development
  if (process.env.NODE_ENV === 'development' || process.env.VITE_DEV_SERVER_URL) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Prevent navigation to external URLs
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const parsedUrl = new URL(url);
    if (parsedUrl.origin !== 'file://' && parsedUrl.origin !== 'http://localhost:5173') {
      event.preventDefault();
    }
  });

  // Open external links in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// --- App Lifecycle ---

// Môi trường test cách ly: đặt OA_USER_DATA (userData riêng) + OA_MCP_PORT
// (port MCP riêng) khi khởi động để chạy song song với bản chính mà không
// đụng dữ liệu IndexedDB, token hay port của nhau. Phải setPath TRƯỚC
// requestSingleInstanceLock vì lock được scope theo userData.
if (process.env.OA_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.OA_USER_DATA));
}
const isolatedMcpPort = parseInt(process.env.OA_MCP_PORT, 10);

// Single-instance lock: chặn chạy 2 bản app cùng lúc (tránh xung đột ghi
// dữ liệu, port MCP server 8048 và các file lock). Lần mở thứ 2 sẽ focus
// cửa sổ của bản đang chạy rồi thoát.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
  createMainWindow();

  // Defer stale-temp cleanup until AFTER the window is created — never block startup
  setImmediate(() => { cleanStaleTempFiles(); });

  // Register Browser Agent IPC handlers
  browserAgentIpc.register(ipcMain, () => mainWindow);

  // Start local MCP server for IDE and external AI agents.
  mcpServer.start(
    Number.isFinite(isolatedMcpPort) && isolatedMcpPort > 0 ? isolatedMcpPort : mcpServer.MCP_PORT,
    () => mainWindow
  );

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Cleanup Browser Agent MCP process + Order Automation MCP server on quit.
// Quit 2 nhịp: preventDefault → đợi mcpServer.stop() đóng session/server
// (tối đa 3s, không treo app nếu còn kết nối) → app.quit() lần nữa thoát thật.
let _quitCleanupDone = false;
app.on('before-quit', (event) => {
  if (_quitCleanupDone) return;
  _quitCleanupDone = true;
  event.preventDefault();
  const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
  Promise.race([Promise.allSettled([browserAgentIpc.destroy(), mcpServer.stop()]), timeout])
    .finally(() => app.quit());
});

// Security: prevent webview tags
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
});

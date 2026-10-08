/**
 * ORDER AUTOMATION - STRUCTURED LOGGER (logger.js)
 * Logger có cấu trúc dùng chung cho các luồng quan trọng (chỉnh sửa thuộc tính
 * sản phẩm/fuzzy, lưu DB...). Mỗi bản ghi gồm: timestamp, level, scope, message,
 * data (JSON). Ngoài việc in ra console, log được giữ trong ring buffer
 * (mặc định 500 bản ghi gần nhất) để tra cứu lại khi có sự cố
 * (gọi getLogBuffer() hoặc dumpLogBuffer() từ console).
 */

const DEFAULT_RING_SIZE = 500;
const LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 };

let _ring = [];
let _ringSize = DEFAULT_RING_SIZE;
let _minLevel = 'debug';

function _nowIso() {
  return new Date().toISOString();
}

function _shouldLog(level) {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[_minLevel];
}

function _pushRing(entry) {
  _ring.push(entry);
  if (_ring.length > _ringSize) _ring.splice(0, _ring.length - _ringSize);
}

function _emit(level, scope, message, data) {
  const entry = { ts: _nowIso(), level, scope, message, data };
  _pushRing(entry);
  if (!_shouldLog(level)) return;
  const prefix = `[${entry.ts}] [${level.toUpperCase()}] [${scope}]`;
  const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (data !== undefined) {
    try {
      consoleFn(prefix, message, typeof data === 'string' ? data : JSON.stringify(data));
    } catch (e) {
      consoleFn(prefix, message, String(data));
    }
  } else {
    consoleFn(prefix, message);
  }
}

/**
 * Tạo logger gắn với một scope (VD: 'ProductEdit', 'DB').
 * @param {string} scope
 */
export function createLogger(scope) {
  return {
    debug: (message, data) => _emit('debug', scope, message, data),
    info: (message, data) => _emit('info', scope, message, data),
    warn: (message, data) => _emit('warn', scope, message, data),
    error: (message, data) => _emit('error', scope, message, data),
  };
}

/** Trả về bản sao của ring buffer (bản ghi cũ → mới). */
export function getLogBuffer() {
  return _ring.slice();
}

/** Xóa ring buffer (chủ yếu dùng trong test). */
export function clearLogBuffer() {
  _ring = [];
}

/** Đặt mức log tối thiểu in ra console ('debug' | 'info' | 'warn' | 'error'). */
export function setLogLevel(level) {
  if (LEVEL_ORDER[level] !== undefined) _minLevel = level;
}

/** Đặt kích thước ring buffer. */
export function setLogRingSize(size) {
  const n = parseInt(size, 10);
  if (n > 0) {
    _ringSize = n;
    if (_ring.length > _ringSize) _ring.splice(0, _ring.length - _ringSize);
  }
}

/** In toàn bộ ring buffer ra console dạng bảng — dùng khi cần tra cứu sự cố. */
export function dumpLogBuffer() {
  for (const e of _ring) {
    console.log(`[${e.ts}] [${e.level.toUpperCase()}] [${e.scope}] ${e.message}`, e.data !== undefined ? JSON.stringify(e.data) : '');
  }
  return _ring.length;
}

if (typeof window !== 'undefined') {
  window.oaLogger = { getLogBuffer, clearLogBuffer, dumpLogBuffer, setLogLevel, setLogRingSize };
}

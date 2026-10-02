import { parseOrderText } from '../parser.js';
import { db } from '../db.js';

// --- Worker Manager for Background Parsing ---

export class WorkerManager {
  constructor() {
    this.worker = null;
    this.isFallback = false;
    this.pendingResolves = new Map();
    this.requestIdCounter = 0;
    // Debounce/coalesce state for updateDatabase (avoid posting the full
    // product DB to the worker on every rapid consecutive edit)
    this._updateDbTimer = null;
    this._pendingUpdate = null;
    this._hasPostedUpdate = false;
  }

  init(products, aliases) {
    try {
      // Create the worker using Vite-compatible URL resolution
      this.worker = new Worker(
        new URL('./matching.worker.js', import.meta.url),
        { type: 'module' }
      );
      
      this.worker.onmessage = (e) => {
        const { type, payload, error, requestId } = e.data;
        const resolve = this.pendingResolves.get(requestId);
        
        if (resolve) {
          this.pendingResolves.delete(requestId);
          if (type === 'PARSE_RESULT') {
            resolve(payload);
          } else if (type === 'PARSE_ERROR') {
            console.error('Worker parse error:', error);
            resolve(null); // Resolve to null so we can fallback
          }
        }
      };

      this.worker.onerror = (err) => {
        console.warn('Web Worker error, switching to main thread matching:', err);
        // Resolve (không reject) toàn bộ promise đang chờ về null để caller
        // fallback sang main-thread — nếu không chúng sẽ treo vĩnh viễn vì
        // worker đã chết và không bao giờ trả lời nữa.
        const pending = [...this.pendingResolves.values()];
        this.pendingResolves.clear();
        for (const resolve of pending) {
          try { resolve(null); } catch (_) { /* noop */ }
        }
        this.isFallback = true;
      };

      // Initialize worker database
      this.worker.postMessage({
        type: 'INIT_DB',
        payload: { products, aliases },
        requestId: this.requestIdCounter++
      });

      console.log('Web Worker matching initialized successfully.');
    } catch (e) {
      console.warn('Failed to create Web Worker (possibly CORS/local file protocol). Falling back to main thread matching:', e);
      this.isFallback = true;
    }
  }

  /**
   * Sync the worker's product/alias database.
   * Debounced (~300ms) + coalesced: rapid consecutive calls result in a
   * single postMessage carrying the LATEST data. The very first update after
   * boot is posted immediately (no debounce) so startup stays snappy.
   */
  updateDatabase(products, aliases) {
    if (this.isFallback || !this.worker) return;
    this._pendingUpdate = { products, aliases };
    // First update after init(): post immediately
    if (!this._hasPostedUpdate) {
      this.flushUpdateDatabase();
      return;
    }
    // Subsequent calls: coalesce — the pending timer will send the latest data
    if (this._updateDbTimer) return;
    this._updateDbTimer = setTimeout(() => this.flushUpdateDatabase(), 300);
  }

  /** Immediately post the latest pending update (cancels any debounce timer). */
  flushUpdateDatabase() {
    if (this._updateDbTimer) { clearTimeout(this._updateDbTimer); this._updateDbTimer = null; }
    if (this.isFallback || !this.worker || !this._pendingUpdate) return;
    const { products, aliases } = this._pendingUpdate;
    this._pendingUpdate = null;
    this._hasPostedUpdate = true;
    this.worker.postMessage({
      type: 'UPDATE_DB',
      payload: { products, aliases },
      requestId: this.requestIdCounter++
    });
  }

  parse(text) {
    // Ensure the worker has the LATEST database before parsing — a pending
    // debounced UPDATE_DB would otherwise make this parse run on stale data.
    this.flushUpdateDatabase();

    if (this.isFallback || !this.worker) {
      // Fallback: Run parsing synchronously on Main Thread
      return new Promise((resolve) => {
        try {
          const result = parseOrderText(text, db.getAllProducts(), db.getAliases());
          resolve(result);
        } catch (err) {
          console.error('Main thread parser fallback failed:', err);
          resolve(null);
        }
      });
    }

    return new Promise((resolve) => {
      const requestId = this.requestIdCounter++;
      this.pendingResolves.set(requestId, resolve);
      this.worker.postMessage({
        type: 'PARSE',
        payload: { text },
        requestId
      });
    });
  }
}

export const workerManager = new WorkerManager();

// Flush any pending debounced update before the window unloads so the next
// session's persisted state is never behind an in-flight debounce timer.
// (Registered once, guarded for non-browser environments like tests.)
if (typeof window !== 'undefined' && !window.__workerManagerBeforeUnloadBound) {
  window.__workerManagerBeforeUnloadBound = true;
  window.addEventListener('beforeunload', () => workerManager.flushUpdateDatabase());
}

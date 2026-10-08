/**
 * =========================================================================
 *  ORDER AUTOMATION - INDEXEDDB WRAPPER (db-store.js)
 * =========================================================================
 *  Provides a robust, promise-based Key-Value store on top of IndexedDB.
 *  Automatically falls back to localStorage if IndexedDB is not supported.
 * =========================================================================
 */

class IndexedDBStore {
  constructor(dbName = 'OrderAutomationDB', storeName = 'KeyValueStore') {
    this.dbName = dbName;
    this.storeName = storeName;
    this.db = null;
    this.useFallback = false;
  }

  /**
   * Initializes the database connection.
   * If IndexedDB is blocked or unsupported, switches to localStorage fallback.
   * Idempotent: các lời gọi sau trả về CÙNG promise — tránh mở DB 2 lần khi
   * nhiều module (db.js nền + pending orders...) cùng chờ backend sẵn sàng.
   */
  init() {
    if (this._readyPromise) return this._readyPromise;
    this._readyPromise = new Promise((resolve) => {
      if (!window.indexedDB) {
        console.warn('IndexedDB not supported. Falling back to localStorage.');
        this.useFallback = true;
        resolve(this);
        return;
      }

      try {
        const request = window.indexedDB.open(this.dbName, 1);

        request.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(this.storeName)) {
            db.createObjectStore(this.storeName);
          }
        };

        request.onsuccess = (e) => {
          this.db = e.target.result;
          resolve(this);
        };

        request.onerror = (e) => {
          console.warn('IndexedDB initialization failed, falling back to localStorage:', e.target.error);
          this.useFallback = true;
          resolve(this);
        };
      } catch (err) {
        console.warn('Error opening IndexedDB, falling back to localStorage:', err);
        this.useFallback = true;
        resolve(this);
      }
    });
    // BẮT BUỘC return — nếu thiếu, lời gọi init()/ready() ĐẦU TIÊN trả
    // undefined → caller await không chờ DB mở xong → ghi nhầm vào fallback
    // localStorage và làm "mất" dữ liệu đang nằm trên IndexedDB (bug thật
    // từng gây mất đơn chờ duyệt).
    return this._readyPromise;
  }

  /**
   * Promise resolve khi backend storage đã sẵn sàng (IndexedDB mở xong hoặc
   * đã chuyển fallback). Caller (pending orders...) PHẢI chờ hàm này trước
   * khi đọc/ghi để không đụng phải backend nhầm (localStorage rỗng).
   */
  ready() {
    return this._readyPromise || this.init();
  }

  /**
   * Retrieves a value by key.
   * Luôn CHỜ backend sẵn sàng trước khi đọc — tránh đọc nhầm localStorage
   * (rỗng) trong khi dữ liệu thật đang nằm trên IndexedDB chưa mở xong.
   */
  async get(key) {
    await this.ready();
    if (this.useFallback || !this.db) {
      return new Promise((resolve) => {
        try {
          const val = localStorage.getItem(key);
          resolve(val ? JSON.parse(val) : null);
        } catch (e) {
          console.error('LocalStorage fallback read failed:', e);
          resolve(null);
        }
      });
    }

    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db.transaction([this.storeName], 'readonly');
        const store = transaction.objectStore(this.storeName);
        const request = store.get(key);

        request.onsuccess = () => {
          resolve(request.result !== undefined ? request.result : null);
        };

        request.onerror = (e) => {
          reject(e.target.error);
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Stores a value associated with the key.
   * Chờ backend sẵn sàng — nếu không, ghi khi IndexedDB đang mở sẽ rơi vào
   * localStorage và bị "mất" khỏi tầm nhìn của lần đọc sau (regression mất
   * đơn chờ duyệt đã từng xảy ra).
   */
  async set(key, value) {
    await this.ready();
    if (this.useFallback || !this.db) {
      return new Promise((resolve, reject) => {
        try {
          localStorage.setItem(key, JSON.stringify(value));
          resolve();
        } catch (e) {
          // REJECT thay vì nuốt lỗi: caller (flushSave...) cần biết ghi THẤT BẠI
          // để log/cảnh báo — dữ liệu chưa được persist.
          console.error('LocalStorage fallback write failed:', e);
          reject(e);
        }
      });
    }

    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db.transaction([this.storeName], 'readwrite');
        const store = transaction.objectStore(this.storeName);
        const request = store.put(value, key);

        request.onsuccess = () => {
          resolve();
        };

        request.onerror = (e) => {
          reject(e.target.error);
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Removes a value by key.
   */
  async remove(key) {
    await this.ready();
    if (this.useFallback || !this.db) {
      return new Promise((resolve) => {
        try {
          localStorage.removeItem(key);
          resolve();
        } catch (e) {
          console.error('LocalStorage fallback remove failed:', e);
          resolve();
        }
      });
    }

    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db.transaction([this.storeName], 'readwrite');
        const store = transaction.objectStore(this.storeName);
        const request = store.delete(key);

        request.onsuccess = () => {
          resolve();
        };

        request.onerror = (e) => {
          reject(e.target.error);
        };
      } catch (err) {
        reject(err);
      }
    });
  }
}

const dbStore = new IndexedDBStore();
if (typeof window !== 'undefined') window.dbStore = dbStore;

export { IndexedDBStore, dbStore };

/**
 * =========================================================================
 *  ORDER AUTOMATION - STATE MANAGER (store.js)
 * =========================================================================
 *  Implements a simple Pub/Sub State Store to avoid global variable mess.
 *  Any module can subscribe to state changes to trigger UI re-renders.
 * =========================================================================
 */

class Store {
  constructor() {
    this.state = {
      currentOrder: {
        customer: '',
        payment: 'ck',
        items: [],
        customPromos: [],
        parsedLines: [],
        aiResult: null,
        rowOrder: null,
      },
      selectedSettingsCampaign: null,
      isLoading: false
    };
    this.listeners = new Set();
    this._notifyScheduled = false;
  }

  /**
   * Returns current state object.
   */
  getState() {
    return this.state;
  }

  /**
   * Updates state fields and notifies all subscribers.
   */
  setState(newState) {
    // Perform deep merging for currentOrder updates if necessary
    if (newState.currentOrder) {
      this.state.currentOrder = { ...this.state.currentOrder, ...newState.currentOrder };
    }
    
    // Set other properties directly
    for (const key in newState) {
      if (key !== 'currentOrder') {
        this.state[key] = newState[key];
      }
    }

    this.notify();
  }

  /**
   * Subscribes a listener function to state changes.
   * Returns an unsubscribe function.
   */
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Notifies all registered listeners of the new state.
   * Batched via requestAnimationFrame: multiple setState() calls within
   * the same frame only trigger ONE render pass.
   */
  notify() {
    if (this._notifyScheduled) return;
    this._notifyScheduled = true;
    const runListeners = () => {
      this._notifyScheduled = false;
      this.listeners.forEach(fn => {
        try {
          fn(this.state);
        } catch (err) {
          console.error('Error in state listener:', err);
        }
      });
    };
    // Guard: env không có requestAnimationFrame (Node test / headless)
    // → chạy listener ĐỒNG BỘ thay vì treo vĩnh viễn ở batch flag.
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(runListeners);
    } else {
      runListeners();
    }
  }

  /**
   * Synchronous notify — bypasses rAF batching.
   * Use sparingly when immediate UI feedback is critical.
   */
  notifySync() {
    this._notifyScheduled = false;
    this.listeners.forEach(fn => {
      try {
        fn(this.state);
      } catch (err) {
        console.error('Error in state listener:', err);
      }
    });
  }
}

const store = new Store();
if (typeof window !== 'undefined') window.store = store;

export { Store, store };

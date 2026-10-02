/**
 * Smoke tests for app-legacy.js (bản legacy app.js đã dọn khỏi root)
 * Run: node --test test/app.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// app-legacy.js is a browser script; set up minimal globals before requiring.
if (typeof window === 'undefined') {
  global.window = {};
}
if (typeof document === 'undefined') {
  global.document = { readyState: 'loading', getElementById: () => null, addEventListener: () => {} };
}
const { debounce, WorkerManager, getFinalUnitPrice } = require('./fixtures/app-legacy.js');

// ─── debounce ───────────────────────────────────────────────────────────────

describe('debounce', () => {
  it('delays invocation until after the specified wait', async () => {
    let callCount = 0;
    const fn = debounce(() => { callCount++; }, 30);

    fn();
    fn();
    fn();
    assert.equal(callCount, 0, 'Should not fire synchronously');

    await new Promise(r => setTimeout(r, 60));
    assert.equal(callCount, 1, 'Should fire exactly once after delay');
  });

  it('returns a function', () => {
    const fn = debounce(() => {}, 10);
    assert.equal(typeof fn, 'function');
  });
});

// ─── WorkerManager (constructor smoke test) ─────────────────────────────────

describe('WorkerManager', () => {
  it('initializes with fallback=false and no worker', () => {
    const wm = new WorkerManager();
    assert.equal(wm.isFallback, false);
    assert.equal(wm.worker, null);
    assert.equal(wm.requestIdCounter, 0);
  });
});

// ─── Module initialization smoke test ──────────────────────────────────────

describe('app-legacy.js initialization', () => {
  it('exports all expected public functions', () => {
    const appModule = require('./fixtures/app-legacy.js');
    assert.equal(typeof appModule.debounce, 'function', 'debounce should be exported');
    assert.equal(typeof appModule.WorkerManager, 'function', 'WorkerManager should be exported');
    assert.equal(typeof appModule.getFinalUnitPrice, 'function', 'getFinalUnitPrice should be exported');
  });

  it('WorkerManager.parse returns a Promise in fallback mode', async () => {
    const wm = new WorkerManager();
    // Without init(), isFallback is false but worker is null → parse uses fallback path
    const result = wm.parse('test');
    assert.ok(result instanceof Promise, 'parse should return a Promise');
    // In Node (no parser globals), the fallback resolves to null
    const resolved = await result;
    assert.equal(resolved, null, 'parse should resolve to null when globals are missing');
  });
});

// ─── getFinalUnitPrice ──────────────────────────────────────────────────────

describe('getFinalUnitPrice', () => {
  it('returns salesPrice when product is null', () => {
    assert.equal(getFinalUnitPrice(null, 180017, false), 180017);
  });

  it('returns salesPrice unchanged when isBox is false', () => {
    const product = { box_size: 12, unit: 'chai' };
    assert.equal(getFinalUnitPrice(product, 180017, false), 180017);
  });

  it('returns salesPrice when baseUnit is thùng', () => {
    const product = { box_size: 12, unit: 'thùng' };
    assert.equal(getFinalUnitPrice(product, 1800000, true), 1800000);
  });

  it('returns salesPrice when salesPrice is 0 or negative', () => {
    const product = { box_size: 12, unit: 'chai' };
    assert.equal(getFinalUnitPrice(product, 0, true), 0);
    assert.equal(getFinalUnitPrice(product, -100, true), -100);
  });
});

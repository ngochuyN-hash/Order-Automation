import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<body><div id="toastContainer"></div><textarea id="orderText"></textarea><input id="customerName"><input id="orderNote"><select id="paymentMethod"><option value="ck">CK</option></select><button id="btnParse">Parse</button></body>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { store } = await import('../store.js');
const { uiRenderer } = await import('../ui-renderer.js');
const actions = await import('../src/order/actions.js');
function seed(items = [{ rawName: 'A', qty: 1 }, { rawName: 'B', qty: 1 }, { rawName: 'C', qty: 1 }]) {
  store.setState({ currentOrder: { items, customPromos: [], giftOverrides: {}, giftDeleted: {}, giftQtyOverrides: {}, giftKindOverrides: {}, rowOrder: null, rawChatText: '', _pendingId: null } });
  return store.getState().currentOrder;
}
test('remove row 0 remaps rowOrder and every row-index override without moving campaign keys', { todo: 'Đã tái hiện; chưa sửa trong phạm vi chốt lưu FOC/Extra, SL 0 và modal Esc.' }, () => {
  const order = seed();
  for (const field of ['giftOverrides', 'giftDeleted', 'giftQtyOverrides', 'giftKindOverrides']) {
    order[field] = { item_0: 'deleted', item_1: 'B', foc_1_0: 'B gift', mkt_pp_2_0: 'C gift', mkt_torvex_0: 'campaign' };
  }
  order.rowOrder = ['item_2', 'foc_1_0', 'item_0', 'item_1', 'mkt_pp_2_0', 'mkt_torvex_0'];
  actions.removeOrderItem(0);
  const updated = store.getState().currentOrder;
  assert.deepEqual(updated.items.map(i => i.rawName), ['B', 'C']);
  assert.deepEqual(updated.rowOrder, ['item_1', 'foc_0_0', 'item_0', 'mkt_pp_1_0', 'mkt_torvex_0']);
  for (const field of ['giftOverrides', 'giftDeleted', 'giftQtyOverrides', 'giftKindOverrides']) {
    assert.deepEqual(updated[field], { item_0: 'B', foc_0_0: 'B gift', mkt_pp_1_0: 'C gift', mkt_torvex_0: 'campaign' });
  }
});

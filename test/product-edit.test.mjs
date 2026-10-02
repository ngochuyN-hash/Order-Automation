/**
 * Unit tests + Functional tests cho luồng chỉnh sửa thuộc tính sản phẩm (fuzzy)
 * ---------------------------------------------------------------------------
 * Bối cảnh bug: chỉnh sửa thuộc tính fuzzy (kvCode, name, spec...) ở tab
 * Catalog KHÔNG được lưu do handler bỏ qua db.setKvCodeBase (kv-name-map.json
 * đè giá trị mới) và lỗi lưu bị nuốt thầm lặng.
 *
 * Các test này khóa hành vi đúng của applyProductFieldEdit — hàm lõi duy nhất
 * mà cả Catalog lẫn Settings phải đi qua.
 *
 * Run: node --test test/product-edit.test.mjs
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { db, DB_STORAGE_KEY } from '../db.js';
import { dbStore } from '../db-store.js';
import { applyProductFieldEdit, EDIT_ERRORS } from '../src/product-edit.js';
import { getLogBuffer, clearLogBuffer } from '../src/logger.js';
import { calculateMatchScore, normalizeText, hasAttributeConflict, findBestProductMatch } from '../parser.js';

// ─── Stub persistence (Node không có IndexedDB/localStorage) ────────────────
// Ghi lại mọi lần dbStore.set để assert "dữ liệu thực sự được ghi xuống kho".
let persistedWrites = [];
let _originalDbStoreSet = dbStore.set.bind(dbStore);
let _failNextPersist = false;

function installPersistStub() {
  dbStore.set = (key, value) => {
    if (_failNextPersist) {
      return Promise.reject(new Error('simulated IndexedDB write failure'));
    }
    persistedWrites.push({ key, value });
    return Promise.resolve();
  };
}
function restorePersistStub() {
  dbStore.set = _originalDbStoreSet;
}

// ─── Seed dữ liệu test ──────────────────────────────────────────────────────
function seedDb() {
  db.data = {
    campaigns: {
      test_camp: {
        name: 'Test Campaign',
        products: [
          {
            id: 'p1', name: 'Zentor Eco Flow 5W30', spec: '1L', unit: 'chai',
            box_size: 12, kvCode: '100001', tiers: [], foc_rules: [], mkt_gift_rules: [],
          },
          {
            id: 'p2', name: 'Torvex Furox 4T 10W40', spec: '', unit: 'chai',
            box_size: 12, kvCode: '', tiers: [], foc_rules: [], mkt_gift_rules: [],
          },
        ],
      },
    },
  };
  db.kvCodeMap = {};
  db.kvCodeThungMap = {};
  db._bumpDataVersion(); // invalidate memo cache để findProductById thấy data mới
}

function getProduct(id) {
  for (const c of Object.values(db.data.campaigns)) {
    const p = c.products.find(p => p.id === id);
    if (p) return p;
  }
  return null;
}

const tick = () => new Promise(r => setTimeout(r, 10));

before(() => { installPersistStub(); });
after(() => { restorePersistStub(); });
beforeEach(() => {
  seedDb();
  persistedWrites = [];
  _failNextPersist = false;
  clearLogBuffer();
});

// ─── 1. UNIT: validation đầu vào ────────────────────────────────────────────

describe('applyProductFieldEdit — validation', () => {
  it('tên rỗng/toàn khoảng trắng bị TỪ CHỐI, hoàn giá trị cũ, DB không đổi', () => {
    const before = getProduct('p1').name;
    const res = applyProductFieldEdit('p1', 'name', '   ');
    assert.equal(res.ok, false);
    assert.equal(res.error, EDIT_ERRORS.EMPTY_NAME);
    assert.equal(res.revertValue, before);
    assert.equal(getProduct('p1').name, before, 'DB phải giữ nguyên tên cũ');
  });

  it('tên hợp lệ được TRIM trước khi lưu', () => {
    const res = applyProductFieldEdit('p1', 'name', '  Zentor Eco Flow 5W30 MỚI  ');
    assert.equal(res.ok, true);
    assert.equal(res.value, 'Zentor Eco Flow 5W30 MỚI');
    assert.equal(getProduct('p1').name, 'Zentor Eco Flow 5W30 MỚI');
  });

  it('box_size: số hợp lệ được parse', () => {
    const res = applyProductFieldEdit('p1', 'box_size', '24');
    assert.equal(res.ok, true);
    assert.equal(res.value, 24);
    assert.equal(getProduct('p1').box_size, 24);
  });

  it('box_size: rác → mặc định 12 (không fail thầm lặng)', () => {
    const res = applyProductFieldEdit('p1', 'box_size', 'abc');
    assert.equal(res.ok, true);
    assert.equal(res.value, 12);
    assert.equal(getProduct('p1').box_size, 12);
  });

  it('box_size: < 1 bị ép về 1', () => {
    const res = applyProductFieldEdit('p1', 'box_size', '0');
    assert.equal(res.ok, true);
    assert.equal(res.value, 1);
    assert.equal(getProduct('p1').box_size, 1);
  });

  it('sản phẩm không tồn tại → PRODUCT_NOT_FOUND, không crash', () => {
    const res = applyProductFieldEdit('p_khong_ton_tai', 'name', 'X');
    assert.equal(res.ok, false);
    assert.equal(res.error, EDIT_ERRORS.PRODUCT_NOT_FOUND);
  });
});

// ─── 2. UNIT: dispatch lưu ĐÚNG API (regression cho bug gốc) ───────────────

describe('applyProductFieldEdit — dispatch lưu trữ', () => {
  it('REGRESSION bug chính: sửa kvCode khi đã có entry cũ trong kv-name-map', () => {
    // Mô phỏng sản phẩm đã có mã trong kv-name-map.json (map thắng product.kvCode)
    db.kvCodeMap['p1'] = 'OLD123';
    db._bumpDataVersion();

    const res = applyProductFieldEdit('p1', 'kvCode', 'NEW456');
    assert.equal(res.ok, true);
    assert.equal(res.persistedVia, 'setKvCodeBase');

    // Giá trị mới PHẢI thắng cả map lẫn inline — đây là chỗ code cũ fail:
    // map vẫn là OLD123 nên getKvCode() trả mã cũ dù UI báo "đã lưu".
    assert.equal(db.kvCodeMap['p1'], 'NEW456', 'kvCodeMap phải được cập nhật');
    assert.equal(getProduct('p1').kvCode, 'NEW456', 'product.kvCode phải được cập nhật');
    assert.equal(db.getKvCode(getProduct('p1')), 'NEW456', 'getKvCode phải trả mã MỚI');
  });

  it('sửa kvCode khi CHƯA có entry trong map vẫn lưu đúng', () => {
    const res = applyProductFieldEdit('p2', 'kvCode', '200002');
    assert.equal(res.ok, true);
    assert.equal(db.kvCodeMap['p2'], '200002');
    assert.equal(db.getKvCode(getProduct('p2')), '200002');
  });

  it('xóa kvCode (rỗng) → gỡ khỏi map, getKvCode trả rỗng', () => {
    db.kvCodeMap['p1'] = 'OLD123';
    const res = applyProductFieldEdit('p1', 'kvCode', '   ');
    assert.equal(res.ok, true);
    assert.equal(res.value, '');
    assert.equal(db.kvCodeMap['p1'], undefined);
    assert.equal(getProduct('p1').kvCode, '');
    assert.equal(db.getKvCode(getProduct('p1')), '');
  });

  it('kvCodeThung: ghi đè mã thùng + getKvCode(unit=thùng) nhận override', () => {
    db.kvCodeMap['p1'] = '100001';
    const res = applyProductFieldEdit('p1', 'kvCodeThung', '777777-9');
    assert.equal(res.ok, true);
    assert.equal(res.persistedVia, 'setKvThungOverride');
    assert.equal(db.getKvCode(getProduct('p1'), 'thùng'), '777777-9');
  });

  it('kvCodeThung: xóa override → trả autoValue = mã gốc + "-1"', () => {
    db.kvCodeMap['p1'] = '100001';
    db.kvCodeThungMap['p1'] = '777777-9';
    const res = applyProductFieldEdit('p1', 'kvCodeThung', '');
    assert.equal(res.ok, true);
    assert.equal(res.value, '');
    assert.equal(res.autoValue, '100001-1');
    assert.equal(db.getKvCode(getProduct('p1'), 'thùng'), '100001-1');
  });

  it('trường thường (spec/unit/category) lưu qua updateProduct', () => {
    const res = applyProductFieldEdit('p1', 'spec', '4L');
    assert.equal(res.ok, true);
    assert.equal(res.persistedVia, 'updateProduct');
    assert.equal(getProduct('p1').spec, '4L');

    const res2 = applyProductFieldEdit('p1', 'unit', 'can');
    assert.equal(res2.ok, true);
    assert.equal(getProduct('p1').unit, 'can');

    const res3 = applyProductFieldEdit('p1', 'category', 'Dầu xe máy');
    assert.equal(res3.ok, true);
    assert.equal(getProduct('p1').category, 'Dầu xe máy');
  });

  it('updateProduct trả false → DB_UPDATE_FAILED + revertValue (không báo thành công)', () => {
    const original = db.updateProduct.bind(db);
    db.updateProduct = () => false; // mô phỏng không tìm thấy product trong campaigns
    try {
      const res = applyProductFieldEdit('p1', 'spec', '999L');
      assert.equal(res.ok, false);
      assert.equal(res.error, EDIT_ERRORS.DB_UPDATE_FAILED);
      assert.equal(res.revertValue, '1L');
      assert.equal(getProduct('p1').spec, '1L', 'DB không được thay đổi');
    } finally {
      db.updateProduct = original;
    }
  });

  it('ngoại lệ khi lưu bị BẮT và trả DB_UPDATE_FAILED (không crash UI)', () => {
    const original = db.setKvCodeBase.bind(db);
    db.setKvCodeBase = () => { throw new Error('IPC gãy'); };
    try {
      const res = applyProductFieldEdit('p1', 'kvCode', 'NEW456');
      assert.equal(res.ok, false);
      assert.equal(res.error, EDIT_ERRORS.DB_UPDATE_FAILED);
      assert.match(res.message, /Không lưu được/);
    } finally {
      db.setKvCodeBase = original;
    }
  });
});

// ─── 3. FUNCTIONAL: luồng đầy đủ edit → validate → lưu kho → đọc lại ───────

describe('Functional — chỉnh sửa được persist xuống kho lưu trữ', () => {
  it('edit name → flushSave → payload ghi xuống chứa giá trị mới', async () => {
    const res = applyProductFieldEdit('p1', 'name', 'Zentor Eco Flow 5W30 Spec mới');
    assert.equal(res.ok, true);

    db.flushSave(); // ghi ngay (bỏ qua debounce) để assert
    await tick();

    const write = persistedWrites.find(w => w.key === DB_STORAGE_KEY);
    assert.ok(write, 'phải có lần ghi vào dbStore với key của DB');
    const savedProduct = write.value.campaigns.test_camp.products.find(p => p.id === 'p1');
    assert.equal(savedProduct.name, 'Zentor Eco Flow 5W30 Spec mới');
    assert.equal(db.getLastPersistError(), null, 'không được có lỗi persist');
  });

  it('edit kvCode → persist cả product.kvCode trong payload', async () => {
    db.kvCodeMap['p1'] = 'OLD123';
    const res = applyProductFieldEdit('p1', 'kvCode', 'NEW456');
    assert.equal(res.ok, true);

    db.flushSave();
    await tick();

    const write = persistedWrites.find(w => w.key === DB_STORAGE_KEY);
    assert.ok(write);
    const savedProduct = write.value.campaigns.test_camp.products.find(p => p.id === 'p1');
    assert.equal(savedProduct.kvCode, 'NEW456');
  });

  it('persist THẤT BẠI → getLastPersistError khác null + có log lỗi', async () => {
    applyProductFieldEdit('p1', 'spec', '2L');
    _failNextPersist = true;

    db.flushSave();
    await tick();

    assert.match(String(db.getLastPersistError()), /simulated IndexedDB write failure/);
    const dbErrors = getLogBuffer().filter(e => e.scope === 'DB' && e.level === 'error');
    assert.ok(dbErrors.length > 0, 'phải ghi log lỗi khi persist thất bại');
    _failNextPersist = false;
  });

  it('nhiều chỉnh sửa liên tiếp — giá trị CUỐI cùng được lưu (debounce không mất dữ liệu)', async () => {
    applyProductFieldEdit('p1', 'spec', '1L');
    applyProductFieldEdit('p1', 'spec', '2L');
    applyProductFieldEdit('p1', 'spec', '4L');

    db.flushSave();
    await tick();

    const write = persistedWrites[persistedWrites.length - 1];
    const savedProduct = write.value.campaigns.test_camp.products.find(p => p.id === 'p1');
    assert.equal(savedProduct.spec, '4L', 'lần ghi cuối phải chứa giá trị mới nhất');
  });
});

// ─── 4. FUNCTIONAL: giá trị đã lưu thực sự ảnh hưởng fuzzy matching ────────

describe('Functional — thuộc tính đã lưu thay đổi kết quả fuzzy matching', () => {
  it('sửa độ nhớt trong tên → hard filter fuzzy nhận giá trị MỚI', () => {
    // Trước khi sửa: p2 tên chứa 10W40 → xung đột với input 10w50
    assert.equal(hasAttributeConflict(normalizeText('furox 10w50'), getProduct('p2')), true);

    const res = applyProductFieldEdit('p2', 'name', 'Torvex Furox 4T 10W50');
    assert.equal(res.ok, true);

    // Sau khi sửa: hết xung đột với 10w50, và XUNG ĐỘT với grade cũ 10w40
    assert.equal(hasAttributeConflict(normalizeText('furox 10w50'), getProduct('p2')), false);
    assert.equal(hasAttributeConflict(normalizeText('furox 10w40'), getProduct('p2')), true);
  });

  it('sau chỉnh sửa, findBestProductMatch khớp sản phẩm theo giá trị MỚI', () => {
    applyProductFieldEdit('p2', 'name', 'Torvex Furox 4T 10W50');
    db._bumpDataVersion();

    const match = findBestProductMatch('furox 10w50', db.getAllProducts(), {});
    assert.ok(match, 'phải tìm ra sản phẩm');
    assert.equal(match.product.id, 'p2');
  });

  it('chặn tên rỗng giữ sản phẩm KHẢ DỤNG cho fuzzy (score > 0)', () => {
    applyProductFieldEdit('p1', 'name', ''); // bị chặn
    const score = calculateMatchScore(normalizeText('eco flow 5w30'), getProduct('p1'));
    assert.ok(score > 0, 'sản phẩm vẫn phải khớp fuzzy vì tên rỗng không được lưu');
  });

  it('nếu tên rỗng LỌT được vào DB thì fuzzy chết — chứng minh vì sao phải chặn', () => {
    // Giả lập hậu quả của bug cũ (nếu không có validation): name rỗng → score 0
    const broken = { ...getProduct('p1'), name: '' };
    assert.equal(calculateMatchScore(normalizeText('eco flow 5w30'), broken), 0);
  });
});

// ─── 5. Logging — cơ chế ghi log chi tiết ───────────────────────────────────

describe('Logging — truy vết chỉnh sửa', () => {
  it('edit thành công ghi edit-request + edit-saved kèm productId/field', () => {
    applyProductFieldEdit('p1', 'spec', '2L');
    const logs = getLogBuffer().filter(e => e.scope === 'ProductEdit');
    assert.ok(logs.some(e => e.message === 'edit-request' && e.data.productId === 'p1' && e.data.field === 'spec'));
    assert.ok(logs.some(e => e.message === 'edit-saved' && e.data.value === '2L' && e.data.persistedVia === 'updateProduct'));
  });

  it('edit thất bại ghi log error/warn tương ứng', () => {
    applyProductFieldEdit('p_ghost', 'name', 'X');
    applyProductFieldEdit('p1', 'name', '');
    const logs = getLogBuffer().filter(e => e.scope === 'ProductEdit');
    assert.ok(logs.some(e => e.message === 'product-not-found — chỉnh sửa BỊ TỪ CHỐI'));
    assert.ok(logs.some(e => e.message === 'validation-rejected: tên sản phẩm trống'));
  });

  it('kvCode fix được ghi rõ persistedVia=setKvCodeBase để truy vết sau này', () => {
    db.kvCodeMap['p1'] = 'OLD123';
    applyProductFieldEdit('p1', 'kvCode', 'NEW456');
    const logs = getLogBuffer().filter(e => e.scope === 'ProductEdit');
    assert.ok(logs.some(e => e.message === 'edit-saved' && e.data.persistedVia === 'setKvCodeBase'));
  });
});

// ─── 6. ĐỔI TÊN → TÊN CŨ TỰ THÀNH ALIAS (ưu tiên khớp sau này) ─────────────

describe('applyProductFieldEdit — đổi tên tự cập nhật alias', () => {
  let _savedAliases, _savedRemoved;
  before(() => {
    _savedAliases = db.customAliases;
    _savedRemoved = db.removedDefaultAliases;
  });
  after(() => {
    db.customAliases = _savedAliases;
    db.removedDefaultAliases = _savedRemoved;
  });

  it('đổi tên SP → tên cũ thành alias trỏ về SP, khớp theo tên cũ vẫn ra đúng SP', () => {
    db.customAliases = {};
    db.removedDefaultAliases = {};
    const res = applyProductFieldEdit('p1', 'name', 'Zentor Eco Xanh 5W30');
    assert.equal(res.ok, true);
    assert.equal(res.aliasAdded, 'Zentor Eco Flow 5W30');
    assert.equal(db.getAliases()['zentor eco flow 5w30'], 'p1');
    // Alias là tín hiệu ưu tiên cao nhất sau mã KV → tên cũ vẫn ra đúng SP
    const m = findBestProductMatch('Zentor Eco Flow 5W30', db.getAllProducts(), db.getAliases());
    assert.equal(m.via, 'alias');
    assert.equal(m.product.id, 'p1');
  });

  it('alias đã thuộc SP KHÁC thì không bị cướp khi đổi tên', () => {
    db.customAliases = { 'zentor eco flow 5w30': 'p2' };
    db.removedDefaultAliases = {};
    const res = applyProductFieldEdit('p1', 'name', 'Zentor Eco Tím 5W30');
    assert.equal(res.ok, true);
    assert.equal(res.aliasAdded, undefined);
    assert.equal(db.getAliases()['zentor eco flow 5w30'], 'p2', 'alias phải giữ về p2');
  });

  it('đổi trường khác (spec/unit) không sinh alias', () => {
    db.customAliases = {};
    db.removedDefaultAliases = {};
    const res = applyProductFieldEdit('p1', 'spec', '1.5L');
    assert.equal(res.ok, true);
    assert.equal(res.aliasAdded, undefined);
  });
});

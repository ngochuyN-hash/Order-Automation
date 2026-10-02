/**
 * ORDER AUTOMATION - PRODUCT FIELD EDIT CORE (product-edit.js)
 * ------------------------------------------------------------------
 * HÀM LÕI DUY NHẤT xử lý việc người dùng chỉnh sửa thuộc tính sản phẩm
 * (các thuộc tính điều khiển fuzzy matching: name, spec, unit, packaging,
 * kvCode, kvCodeThung, box_size, category...).
 *
 * LÝ DO TỒN TẠI: trước đây tab Catalog (src/catalog/delegation.js) và tab
 * Settings (src/settings/ui.js) mỗi bên tự xử lý lưu theo một cách, dẫn tới
 * phân kỳ logic: Catalog KHÔNG gọi db.setKvCodeBase khi sửa kvCode khiến giá
 * trị mới bị kv-name-map.json đè lên → chỉnh sửa "không được lưu" dù UI vẫn
 * báo thành công. Mọi chỉnh sửa từ UI giờ PHẢI đi qua applyProductFieldEdit.
 *
 * Trách nhiệm: validation đầu vào → dispatch đúng API lưu (updateProduct /
 * setKvCodeBase / setKvThungOverride) → kiểm tra kết quả → đồng bộ worker
 * fuzzy → ghi log chi tiết từng bước.
 */

import { db } from '../db.js';
import { workerManager } from './worker-manager.js';
import { createLogger } from './logger.js';

const log = createLogger('ProductEdit');

/** Mã lỗi chuẩn để UI/test có thể phản ứng chính xác. */
export const EDIT_ERRORS = {
  PRODUCT_NOT_FOUND: 'PRODUCT_NOT_FOUND',
  EMPTY_NAME: 'EMPTY_NAME',
  DB_UPDATE_FAILED: 'DB_UPDATE_FAILED',
  DUPLICATE_NAME: 'DUPLICATE_NAME',
  DUPLICATE_NAME_CROSS_CAMPAIGN: 'DUPLICATE_NAME_CROSS_CAMPAIGN',
  INVALID_BOX_SIZE: 'INVALID_BOX_SIZE',
  INVALID_PRICE: 'INVALID_PRICE',
  DUPLICATE_KVCODE: 'DUPLICATE_KVCODE',
  ALIAS_CONFLICT: 'ALIAS_CONFLICT',
};

/**
 * Text hiển thị quy cách đóng thùng: "12 chai/thùng" — cùng quy tắc packagingAutoText. */
export function packagingPreviewText(boxSize, unit) {
  const bs = Number(boxSize) || 0;
  const u = String(unit || '').trim();
  if (bs <= 1) return u;
  return u ? `${bs} ${u}/thùng` : `${bs}/thùng`;
}

/**
 * "Sức khỏe" SP cho badge Danh mục + filter "Cần hoàn thiện": thuần, không side-effect.
 * Trả về mảng cờ { code, message }. SP không cờ nào = đủ điều kiện bán ngay.
 */
export function productHealthFlags(product, aliases) {
  const flags = [];
  if (!product) return flags;
  const kvBase = (product && product.kvCode) || '';
  if (!kvBase) {
    flags.push({ code: 'MISSING_KVCODE', message: 'Thiếu mã KV — sẽ lỗi khi lên đơn KiotViet' });
  }
  const tiers = Array.isArray(product.tiers) ? product.tiers : [];
  if (!tiers.length) {
    flags.push({ code: 'NO_TIERS', message: 'Chưa có mốc giá nào' });
  }
  if (aliases) {
    const dupAliases = Object.entries(aliases)
      .filter(([, pid]) => pid === product.id)
      .map(([a]) => a)
      .filter((a) => {
        const ownerCount = Object.entries(aliases).filter(([k]) => k === a).length;
        return ownerCount > 1;
      });
    if (dupAliases.length) {
      flags.push({ code: 'ALIAS_DUP', message: `Alias trùng: ${dupAliases.slice(0, 3).join(', ')}` });
    }
  }
  return flags;
}

/**
 * Validate thuần dữ liệu tạo SP MỚI (không đụng DB, không side-effect) —
 * form thêm hàng và test dùng chung. Trả về { ok, errors, warnings }:
 * - errors: chặn lưu (key → message tiếng Việt).
 * - warnings: cho lưu tiếp sau confirm (trùng tên, thiếu mã KV).
 */
export function validateNewProduct(input, ctx = {}) {
  const errors = {};
  const warnings = [];
  const norm = (s) => String(s || '').trim();

  const name = norm(input.name);
  if (!name) {
    errors.name = 'Tên sản phẩm không được để trống!';
  } else {
    let dupInCampaign = null;
    if (ctx.siblingNames) {
      dupInCampaign = ctx.siblingNames.find(
        (n) => String(n || '').trim().toLowerCase() === name.toLowerCase()
      );
      if (dupInCampaign) {
        warnings.push({
          code: EDIT_ERRORS.DUPLICATE_NAME,
          message: `Sản phẩm "${dupInCampaign}" đã tồn tại trong thương hiệu này — mở SP đó để sửa thay vì tạo mới?`,
        });
      }
    }
    // Trùng tên XUYÊN thương hiệu: toàn bộ matching (findProductById, package
    // siblings, kvCode global) đang coi tên SP unique toàn cục — cảnh báo để
    // không vô tình tạo bản sao nhưng vẫn cho phép chủ động thêm.
    if (!dupInCampaign && ctx.crossCampaignNames) {
      const cross = ctx.crossCampaignNames.find(
        (n) => String(n || '').trim().toLowerCase() === name.toLowerCase()
      );
      if (cross) {
        warnings.push({
          code: EDIT_ERRORS.DUPLICATE_NAME_CROSS_CAMPAIGN,
          message: `Sản phẩm "${cross}" đã tồn tại ở THƯƠNG HIỆU KHÁC — trùng tên giữa các thương hiệu dễ gây nhầm khi tra cứu. Vẫn thêm?`,
        });
      }
    }
  }

  const boxRaw = norm(input.box_size);
  const boxParsed = parseInt(boxRaw, 10);
  if (boxRaw === '' || Number.isNaN(boxParsed)) {
    // Không tự ép 12 im lặng — giữ giá trị user gõ, báo lỗi đỏ.
    errors.box_size = 'Số lượng/thùng phải là số nguyên ≥ 1 (đang để trống hoặc không phải số)!';
  } else if (boxParsed < 1) {
    errors.box_size = 'Số lượng/thùng phải ≥ 1!';
  }

  const price = Number(input.price);
  if (Number.isNaN(price) || price < 0) {
    errors.price = 'Giá không được âm hoặc không hợp lệ!';
  }

  const kvCode = norm(input.kvCode);
  if (kvCode && ctx.kvCodeTaken && ctx.kvCodeTaken(kvCode)) {
    errors.kvCode = `Mã KV "${kvCode}" đã thuộc về sản phẩm khác!`;
  }
  if (!kvCode) {
    warnings.push({
      code: 'MISSING_KVCODE',
      message: 'Chưa nhập mã KiotViet — SP sẽ gắn cờ "Thiếu mã KV" và có thể lỗi khi lên đơn.',
    });
  }

  const aliases = String(input.aliases || '').split(',').map((s) => s.trim()).filter(Boolean);
  const conflicting = [];
  for (const a of aliases) {
    const owner = ctx.aliasOwner ? ctx.aliasOwner(a.toLowerCase()) : null;
    // Alias trỏ về SP khác = cướp alias → chặn. Chưa có chủ thì OK.
    if (owner && owner !== ctx.excludeProductId) conflicting.push(a);
  }
  if (conflicting.length) {
    errors.aliases = `Tên gọi tắt đã thuộc SP khác: ${conflicting.map((a) => `"${a}"`).join(', ')}`;
  }

  return { ok: Object.keys(errors).length === 0, errors, warnings };
}

/**
 * Tạo SP đầy đủ 1 lần: db.addProduct + tiers + alias + KV (gốc + thùng) +
 * rule KM nhanh optional. Đường lưu DUY NHẤT cho tạo mới từ UI.
 *
 * @param {string} campaignKey
 * @param {{name,spec,packaging,unit,box_size,category,kvCode,kvCodeThung,tiers,aliases,quickPromo}} input
 * @returns {{ok, product?, error?, message?}}
 */
export function createProductFull(campaignKey, input = {}) {
  const campaign = db.data && db.data.campaigns && db.data.campaigns[campaignKey];
  if (!campaign) {
    return _emitResult({ ok: false, error: EDIT_ERRORS.DB_UPDATE_FAILED, message: 'Thương hiệu không tồn tại!' });
  }
  const name = String(input.name || '').trim();
  if (!name) {
    return _emitResult({ ok: false, error: EDIT_ERRORS.EMPTY_NAME, message: 'Tên sản phẩm không được để trống!' });
  }
  const boxSize = parseInt(input.box_size, 10);
  if (Number.isNaN(boxSize) || boxSize < 1) {
    return _emitResult({ ok: false, error: EDIT_ERRORS.INVALID_BOX_SIZE, message: 'Số lượng/thùng phải là số nguyên ≥ 1!' });
  }
  const tiers = Array.isArray(input.tiers) && input.tiers.length
    ? input.tiers
    : [{ min_qty: 1, max_qty: 9999, price: Number(input.price) || 0, label: 'Tất cả' }];

  const added = db.addProduct(campaignKey, {
    name,
    kvCode: String(input.kvCode || '').trim(),
    spec: String(input.spec || ''),
    packaging: String(input.packaging || ''),
    unit: String(input.unit || 'chai'),
    box_size: boxSize,
    category: String(input.category || ''),
    tiers,
    foc_rules: [],
    mkt_gift_rules: [],
  });
  if (!added) {
    return _emitResult({ ok: false, error: EDIT_ERRORS.DB_UPDATE_FAILED, message: 'Lỗi khi thêm sản phẩm!' });
  }

  // Alias — bỏ qua alias đã thuộc SP khác (không cướp).
  const aliases = String(input.aliases || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const a of aliases) {
    const owner = db.getAliases()[a.toLowerCase()];
    if (!owner) db.addAlias(a, added.id);
  }

  // Mã KV qua đúng API (map thắng inline — ghi thẳng product.kvCode là không đủ).
  const kvBase = String(input.kvCode || '').trim();
  if (kvBase) db.setKvCodeBase(added.id, kvBase);
  const kvThung = String(input.kvCodeThung || '').trim();
  if (kvThung) db.setKvThungOverride(added.id, kvThung);

  // KM nhanh optional: "Mua X tặng Y cùng loại".
  if (input.quickPromo && Number(input.quickPromo.buyQty) > 0 && Number(input.quickPromo.giftQty) > 0) {
    campaign.promoRules = campaign.promoRules || [];
    campaign.promoRules.push({
      id: 'promo_' + added.id + '_foc_' + Date.now().toString(36),
      type: 'qty', scope: 'product', enabled: true, kind: 'foc',
      productId: added.id,
      buy: { qty: Number(input.quickPromo.buyQty), unit: input.quickPromo.buyUnit || 'thùng' },
      gifts: [{ qty: Number(input.quickPromo.giftQty), productId: '__same__', unit: String(input.unit || 'chai') }],
      label: '', note: '',
    });
    db.save();
  }

  try {
    workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
  } catch (e) {
    log.warn('đồng bộ worker fuzzy thất bại sau tạo SP (dữ liệu đã lưu DB)', { error: String(e) });
  }
  return _emitResult({ ok: true, product: added });
}

const STRING_FIELDS = ['name', 'spec', 'unit', 'packaging', 'category'];

/**
 * Phát sự kiện kết quả chỉnh sửa để UI (chip trạng thái lưu của
 * edit-tracker) phản hồi MỌI đường dẫn — thành công lẫn thất bại.
 */
function _emitResult(result) {
  if (typeof window !== 'undefined' && typeof window.CustomEvent === 'function') {
    try {
      window.dispatchEvent(new window.CustomEvent('oa-product-edit-result', { detail: result }));
    } catch (e) { /* môi trường không có DOM — bỏ qua */ }
  }
  return result;
}

/**
 * Áp dụng chỉnh sửa một trường của sản phẩm và lưu vào DB.
 *
 * @param {string} productId - id sản phẩm
 * @param {string} field - tên trường (name|spec|unit|packaging|category|box_size|kvCode|kvCodeThung|...)
 * @param {*} rawValue - giá trị thô từ input của người dùng
 * @returns {{
 *   ok: boolean,
 *   field: string,
 *   value?: *,               // giá trị ĐÃ CHUẨN HÓA được lưu
 *   error?: string,          // mã lỗi (EDIT_ERRORS)
 *   message?: string,        // thông báo thân thiện cho người dùng
 *   revertValue?: string,    // giá trị nên hoàn lại trên input khi lỗi
 *   autoValue?: string,      // (kvCodeThung) mã thùng tự phân khi xóa override
 *   persistedVia?: string    // 'updateProduct' | 'setKvCodeBase' | 'setKvThungOverride'
 * }}
 */
export function applyProductFieldEdit(productId, field, rawValue) {
  const requestId = `edit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  log.info('edit-request', { requestId, productId, field, rawValue });

  // ── 1. Xác định sản phẩm ────────────────────────────────────────────────
  const product = db.findProductById(productId);
  if (!product) {
    log.error('product-not-found — chỉnh sửa BỊ TỪ CHỐI', { requestId, productId, field });
    return _emitResult({
      ok: false,
      field,
      error: EDIT_ERRORS.PRODUCT_NOT_FOUND,
      message: 'Không tìm thấy sản phẩm để lưu thay đổi!',
    });
  }

  // ── 2. Validation đầu vào ───────────────────────────────────────────────
  if (field === 'name') {
    const trimmed = String(rawValue || '').trim();
    if (!trimmed) {
      // Tên rỗng khiến calculateMatchScore trả 0 → sản phẩm VĨNH VIỄN không
      // khớp fuzzy. Chặn lưu và hoàn giá trị cũ.
      log.warn('validation-rejected: tên sản phẩm trống', { requestId, productId });
      return _emitResult({
        ok: false,
        field,
        error: EDIT_ERRORS.EMPTY_NAME,
        message: 'Tên sản phẩm không được để trống!',
        revertValue: product.name || '',
      });
    }
    rawValue = trimmed;
  }

  // ── 3. Chuẩn hóa giá trị theo từng loại trường ─────────────────────────
  let value = rawValue;
  if (field === 'box_size') {
    const parsed = parseInt(rawValue, 10);
    if (Number.isNaN(parsed)) {
      log.warn('box_size không phải số — dùng mặc định 12', { requestId, productId, rawValue });
      value = 12;
    } else if (parsed < 1) {
      log.warn('box_size < 1 — ép về 1', { requestId, productId, rawValue: parsed });
      value = 1;
    } else {
      value = parsed;
    }
  } else if (STRING_FIELDS.includes(field)) {
    value = String(rawValue || '');
  } else if (field === 'kvCode' || field === 'kvCodeThung') {
    value = String(rawValue || '').trim();
  }

  // ── 4. Dispatch lưu ĐÚNG API theo từng trường ──────────────────────────
  let persistedVia = 'updateProduct';
  let autoValue;
  let aliasAdded = null;
  try {
    if (field === 'kvCode') {
      // FIX LÕI: phải cập nhật kvCodeMap (kv-name-map.json/app-config.json)
      // vì getKvCode() ưu tiên map hơn product.kvCode. Chỉ updateProduct()
      // thì giá trị mới KHÔNG có hiệu lực với sản phẩm đã có entry trong map.
      db.setKvCodeBase(productId, value);
      persistedVia = 'setKvCodeBase';
    } else if (field === 'kvCodeThung') {
      // Mã thùng tự phân (mã gốc + '-1') — tính TRƯỚC khi đổi override để giữ
      // đúng hành vi hiển thị cũ của handler.
      autoValue = db.getKvCode(product, product.unit || 'chai') + '-1';
      db.setKvThungOverride(productId, value);
      persistedVia = 'setKvThungOverride';
    } else {
      const ok = db.updateProduct(productId, { [field]: value });
      if (!ok) {
        log.error('db.updateProduct trả false — không tìm thấy product trong campaigns', {
          requestId, productId, field,
        });
        return _emitResult({
          ok: false,
          field,
          error: EDIT_ERRORS.DB_UPDATE_FAILED,
          message: 'Không lưu được thay đổi vào cơ sở dữ liệu!',
          revertValue: product[field] !== undefined ? String(product[field]) : '',
        });
      }
      // ĐỔI TÊN → tên cũ tự thành alias của SP này: sales đã quen gọi tên cũ,
      // tin nhắn về sau parse bằng tên cũ vẫn ra đúng SP. Alias là tín hiệu
      // ƯU TIÊN CAO NHẤT sau mã KV nên tên cũ sẽ thắng cả khi brand khác trùng
      // tên gọi. Bỏ qua nếu alias đó đã trỏ tới SP KHÁC (không cướp alias).
      if (field === 'name') {
        const oldName = String(product.name || '').trim();
        const newName = String(value || '').trim();
        if (oldName.length >= 2 && oldName.toLowerCase() !== newName.toLowerCase()) {
          const existingTarget = db.getAliases()[oldName.toLowerCase()];
          if (!existingTarget || existingTarget === productId) {
            db.addAlias(oldName, productId);
            aliasAdded = oldName;
            log.info('rename-auto-alias', { requestId, productId, alias: oldName });
          } else {
            log.warn('rename-auto-alias-skipped: alias đã thuộc SP khác', {
              requestId, productId, alias: oldName, owner: existingTarget,
            });
          }
        }
      }
    }
  } catch (e) {
    log.error('ngoại lệ khi lưu — chỉnh sửa KHÔNG được ghi', {
      requestId, productId, field, error: String(e && e.stack || e),
    });
    return _emitResult({
      ok: false,
      field,
      error: EDIT_ERRORS.DB_UPDATE_FAILED,
      message: 'Không lưu được thay đổi vào cơ sở dữ liệu!',
      revertValue: product[field] !== undefined ? String(product[field]) : '',
    });
  }

  // ── 5. Đồng bộ worker fuzzy để matching dùng dữ liệu MỚI NGAY ──────────
  try {
    workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
  } catch (e) {
    // Không chặn kết quả lưu — chỉ log để điều tra
    log.warn('đồng bộ worker fuzzy thất bại (dữ liệu đã lưu DB)', {
      requestId, productId, error: String(e),
    });
  }

  log.info('edit-saved', { requestId, productId, field, value, persistedVia });

  const result = { ok: true, field, value, persistedVia };
  if (field === 'kvCodeThung') {
    // UI dùng mã này để hiển thị lại khi user xóa override (rỗng).
    result.autoValue = autoValue;
  }
  if (aliasAdded) result.aliasAdded = aliasAdded;
  return _emitResult(result);
}

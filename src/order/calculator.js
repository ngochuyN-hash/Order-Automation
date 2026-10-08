import { db } from '../../db.js';
import { findBestProductMatch, extractVolume } from '../../parser.js';

// --- Explicit Price Conversion Heuristic ---
export function getFinalUnitPrice(product, salesPrice, isBox) {
  if (!product) return salesPrice;
  if (!salesPrice || salesPrice <= 0) return salesPrice;
  const boxSize = product.box_size || 12;
  const baseUnit = product.unit || 'chai';
  
  if (!isBox || baseUnit === 'thùng') {
    return salesPrice;
  }
  
  const stdUnitPrice = db.getPriceForQty(product, 1);
  if (stdUnitPrice <= 0) return salesPrice;
  
  const stdBoxPrice = stdUnitPrice * boxSize;
  
  const diffToUnit = Math.abs(Math.log(salesPrice / stdUnitPrice));
  const diffToBox = Math.abs(Math.log(salesPrice / stdBoxPrice));
  
  if (diffToUnit < diffToBox) {
    return salesPrice;
  } else {
    // Sales wrote the box price, divide it by boxSize to store unit price
    return salesPrice / boxSize;
  }
}

// --- Dynamic Item Calculation ---
export function calculateOrderItem(product, qty, unit) {
  const isBox = (unit === 'thùng');
  const boxSize = product.box_size || 12;
  const totalUnits = isBox ? qty * boxSize : qty;
  const boxEquivalent = isBox ? qty : qty / boxSize;

  const unitPrice = db.getPriceForQty(product, boxEquivalent);
  const subtotal = totalUnits * unitPrice;
  const foc = db.getFOCForQty(product, boxEquivalent, totalUnits);

  // [Promo v1.3.0] Mốc TIỀN/SỐ LƯỢNG theo từng dòng sản phẩm (promoRules type 'total'
  // scope 'product'): rule SỐ so với subtotal dòng (basis money) hoặc số thùng đủ
  // (basis boxes) → đẩy thẳng vào foci để mọi consumer (bảng đơn + headless) hưởng chung.
  if (subtotal > 0) {
    const mRule = db.getProductMoneyPromoRule(product, subtotal, boxEquivalent);
    if (mRule) {
      for (const g of (Array.isArray(mRule.gifts) ? mRule.gifts : [])) {
        if (!g || !g.productId) continue;
        foc.push({
          ...mRule,
          give_product: g.productId === '__same__' ? product.id : g.productId,
          give_unit: g.unit || '',
          isSameProduct: g.productId === product.id,
          total_give: Number(g.qty) || 1,
          times: 1,
          ruleId: mRule.id,
          ruleType: 'total',
          milestone: {
            min: mRule.threshold && mRule.threshold.min,
            max: mRule.threshold && mRule.threshold.max,
            basis: (mRule.threshold && mRule.threshold.basis) || 'money'
          },
          label: db._buildPromoLabel(mRule)
        });
      }
    }
  }

  let tierLabel = '';
  if (product.tiers) {
    for (const tier of product.tiers) {
      if (boxEquivalent >= tier.min_qty && boxEquivalent <= tier.max_qty) {
        tierLabel = tier.label;
        break;
      }
    }
  }
  return { unitPrice, subtotal, foc, tierLabel };
}

/**
 * Merge duplicate items in an order (same product + unit → sum qty).
 * This is a SYSTEM-LEVEL feature: regardless of how items were parsed (AI or offline),
 * duplicates are always merged before display/export.
 * 
 * Merge key:
 *  - Matched items: productId + unit
 *  - Unmatched items: rawName(normalized) + unit
 *  - Gift items are NOT merged here (handled separately in export)
 * 
 * When merging, the FIRST occurrence keeps its position; qty is summed.
 * explicitPrice / priceTierQty: if conflicting, keep the first non-null value.
 */
export function mergeDuplicateItems(items) {
  if (!Array.isArray(items) || items.length <= 1) return items;

  const merged = [];
  const indexMap = new Map(); // key → index in merged[]

  for (const item of items) {
    // Skip gift items — they have their own merge logic in export
    if (item.isGift) {
      merged.push(item);
      continue;
    }

    // Build merge key — thêm volume (dung tích) vào key để KHÔNG BAO GIỜ gộp
    // 2 dòng trùng tên nhưng khác quy cách (VD: 'fast 4T 1L' vs 'fast 4T 800ml').
    // Không có dung tích trong tên → hành vi gộp cũ giữ nguyên.
    let key;
    const vol = extractVolume(item.rawProduct || item.rawName || '');
    const volPart = vol != null ? `|v${vol}` : '';
    if (item.product && item.product.id) {
      key = `p:${item.product.id}|${item.unit}${volPart}`;
    } else {
      const rawName = (item.rawProduct || item.rawName || '').toLowerCase().trim();
      key = `r:${rawName}|${item.unit}${volPart}`;
    }

    if (indexMap.has(key)) {
      // Merge into existing
      const existing = merged[indexMap.get(key)];
      existing.qty += item.qty;

      // Keep first non-null explicit price / tier
      if (existing.manualPrice == null && item.manualPrice != null) {
        existing.manualPrice = item.manualPrice;
        existing.unitPrice = item.unitPrice;
      }

      // Recalculate subtotal
      const boxSize = existing.product ? (existing.product.box_size || 12) : 12;
      const isBox = existing.unit === 'thùng';
      const totalUnits = isBox ? existing.qty * boxSize : existing.qty;
      existing.subtotal = existing.unitPrice * totalUnits;
    } else {
      indexMap.set(key, merged.length);
      merged.push({ ...item }); // shallow clone to avoid mutating original
    }
  }

  return merged;
}

// --- Standalone Gift Processing Helper ---
export function processExplicitGift(explicitGift, parentProduct, dbFocList) {
  if (!explicitGift) return null;
  let give_product_id = '';
  let note = 'Khuyến mãi theo tin nhắn sales';

  const name = (explicitGift.name || '').toLowerCase().trim();
  const unit = (explicitGift.unit || 'chai').toLowerCase().trim();

  // "tuýp"/"hộp số"/"gear oil" = dầu hộp số (tuýp) — KHÔNG phải sản phẩm dầu máy mẹ.
  // Phải resolve đúng để so khớp được với quà khuôn mẫu (cũng là gear oil) ở bước merge.
  const isGearOil = (unit === 'tuýp' || unit === 'tuyp' || name === 'tuýp' || name === 'tuyp' ||
                     name.includes('hộp số') || name.includes('hop so') || name.includes('gear oil'));
  const isGeneric = name === '' || name === 'chai' || name === 'lon' || name === 'thùng' || name === 'can' || name === 'phuy' || name === 'hộp' || name === 'túi';

  // Registry "chương trình KM dạng text" (campaign.promoTextRules) — resolve
  // chính xác TRƯỚC mọi heuristic/fuzzy: keyword admin đăng ký thắng đoán mò,
  // tránh rơi vào __unmatched_gift__ (quà không có kvCode, fail khi lên KV).
  const promoMatch = db.getPromoTextMatch(explicitGift.name, unit, parentProduct ? parentProduct.campaignKey : undefined);
  let promoRuleId = null;
  if (promoMatch) {
    const gift = (Array.isArray(promoMatch.rule.gifts) && promoMatch.rule.gifts[0]) || {};
    give_product_id = gift.productId || '';
    promoRuleId = promoMatch.rule.id || null;
    note = 'Khớp chương trình KM: ' + (promoMatch.rule.label || explicitGift.name);
  } else if (isGearOil) {
     // Gear oil theo brand của sản phẩm mẹ
     if (parentProduct && (parentProduct.campaignKey === 'torvex' || parentProduct.id.startsWith('torvex'))) {
        give_product_id = 'torvex_gear_oil';
     } else if (parentProduct && parentProduct.campaignKey && parentProduct.campaignKey.includes('veltron')) {
        give_product_id = 'veltron_veltron_scooter_gear_oil_sae_80w_90';
     } else {
        give_product_id = 'torvex_gear_oil';
     }
  } else if (isGeneric || (parentProduct && name === parentProduct.name.toLowerCase())) {
     give_product_id = parentProduct ? parentProduct.id : '';
  } else {
     // Brand-aware matching: ưu tiên sản phẩm cùng campaign với sản phẩm mẹ.
     // VD: Đơn Torvex + "tặng móc khóa" → Torvex Keyring (không phải Zentor Keyring).
     // Nhưng cùng-campaign chỉ thắng khi điểm KHÔNG THUA match toàn cục (tie →
     // cùng campaign thắng) — trước đây cùng campaign thắng tuyệt đối nên quà
     // brand khác (VD "6 chai Veltron Engine cleaner" kèm đơn Zentor) bị nuốt
     // bởi fuzzy trong campaign → nhầm sang SP cùng brand mẹ (bug thật 04/9).
     const allProducts = db.getAllProducts();
     const aliases = db.getAliases();
     let campaignMatch = null;
     if (parentProduct && parentProduct.campaignKey) {
        const sameCampaignProducts = allProducts.filter(p => p.campaignKey === parentProduct.campaignKey);
        if (sameCampaignProducts.length > 0) {
           campaignMatch = findBestProductMatch(explicitGift.name, sameCampaignProducts, aliases, unit);
        }
     }
     const globalMatch = findBestProductMatch(explicitGift.name, allProducts, aliases, unit);
     let match = null;
     if (campaignMatch && globalMatch) {
        match = (globalMatch.score > campaignMatch.score) ? globalMatch : campaignMatch;
     } else {
        match = campaignMatch || globalMatch;
     }
     if (match) {
        give_product_id = match.product.id;
     } else {
        give_product_id = '__unmatched_gift__';
        note = 'Sản phẩm tặng không có trong DB: ' + explicitGift.name;
     }
  }

  // dbFocList: mảng các rule FOC từ DB (có thể rỗng). So khớp quà sales khai với từng rule.
  const focArr = Array.isArray(dbFocList) ? dbFocList : (dbFocList ? [dbFocList] : []);
  if (focArr.length > 0) {
     const matchedRule = focArr.find(f => {
        const dbGiftId = f.give_product || (parentProduct ? parentProduct.id : '');
        return give_product_id === dbGiftId && explicitGift.qty === f.total_give;
     });
     if (matchedRule) {
        note = 'Khớp với chương trình KM';
     } else {
        const f0 = focArr[0];
        const dbGiftId = f0.give_product || (parentProduct ? parentProduct.id : '');
        const dbGiftQty = f0.total_give;
        const dbGiftProd = db.findProductById(dbGiftId);
        note = `⚠️ Khác với gốc: Tặng ${dbGiftQty} ${f0.give_unit} ${dbGiftProd ? dbGiftProd.name : ''}`;
     }
  }

  return {
    total_give: explicitGift.qty,
    give_unit: unit,
    give_product: give_product_id,
    note: note,
    ...(promoRuleId ? { _promoRuleId: promoRuleId } : {})
  };
}

/**
 * ============================================================================
 *  COMBINE GIFTS — Kiến trúc xác định hàng khuyến mãi 2 tầng
 * ============================================================================
 *  TẦNG HỆ THỐNG (khuôn mẫu): FOC từ foc_rules LUÔN được áp dụng, đủ và đúng
 *    số lượng theo quy tắc (mua X tặng Y). Không bao giờ bị mất.
 *  TẦNG AI (bổ sung ngoài): quà sales khai trong tin nhắn (explicitGift) chỉ
 *    được THÊM VÀO khi nằm ngoài khuôn mẫu, cụ thể:
 *      (a) Trùng khớp một quà khuôn mẫu (cùng SP + cùng số lượng)
 *          → sales chỉ đang nhắc lại KM chuẩn → KHÔNG cộng dồn (tránh trùng).
 *      (b) Cùng sản phẩm nhưng KHÁC số lượng với khuôn mẫu
 *          → sales đang điều chỉnh KM → dùng số sales khai (có cảnh báo).
 *      (c) Khác sản phẩm với mọi quà khuôn mẫu
 *          → quà BỔ SUNG ngoài khuôn mẫu → THÊM VÀO cùng khuôn mẫu.
 *
 * @param {Array} templateFoc  - Mảng quà khuôn mẫu từ db.getFOCForQty (luôn giữ).
 * @param {Object|null} explicitGiftObj - Quà AI trích xuất (đã qua processExplicitGift).
 * @returns {Array} Mảng quà cuối cùng (khuôn mẫu + bổ sung, không trùng).
 */
export function combineGifts(templateFoc, explicitGiftObj) {
  const template = Array.isArray(templateFoc)
    ? templateFoc.map(f => ({ ...f }))
    : (templateFoc ? [{ ...templateFoc }] : []);

  // Không có quà sales khai → chỉ dùng khuôn mẫu
  if (!explicitGiftObj) return template;

  const sameProductIdx = template.findIndex(f => f.give_product === explicitGiftObj.give_product);

  // (c) Khác sản phẩm → quà bổ sung ngoài khuôn mẫu → THÊM VÀO
  if (sameProductIdx < 0) {
    return [...template, { ...explicitGiftObj, isExplicitAddition: true }];
  }

  const existing = template[sameProductIdx];

  // (a) Cùng SP + cùng số lượng → sales nhắc lại KM chuẩn → không cộng dồn
  if (existing.total_give === explicitGiftObj.total_give) {
    template[sameProductIdx] = { ...existing, note: (existing.note || '') + ' — sales xác nhận' };
    return template;
  }

  // (b) Cùng SP, khác số lượng → sales điều chỉnh KM gốc → dùng số sales khai
  const result = [...template];
  result[sameProductIdx] = {
    ...explicitGiftObj,
    note: `⚠️ Sales điều chỉnh KM gốc (${existing.total_give} → ${explicitGiftObj.total_give})`,
    isExplicitOverride: true
  };
  return result;
}

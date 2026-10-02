/**
 * =========================================================================
 *  ORDER AUTOMATION - TEXT PARSER & FUZZY MATCHING (parser.js)
 * =========================================================================
 *  Pure logic library for text parsing and fuzzy matching of product items.
 *  Can be run on both Main Thread (as fallback) and Web Worker.
 * =========================================================================
 */

/**
 * Normalizes text to lowercase, removes accents, and cleans special characters.
 */
function normalizeText(text) {
  if (!text) return '';
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd')
    // Tách số quanh dấu "+" ("Promo 4+1L") TRƯỚC khi xoá dấu câu, nếu không
    // dính thành "41l" = 41 lít → volume-conflict tự chống chính mình.
    .replace(/(\d)\+(?=\d)/g, '$1 ')
    .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Normalizes brand name variants so alias matching works regardless of spacing.
 * "auto x" → "torvex" (brand Torvex commonly written with space by sales).
 * Applied AFTER normalizeText, BEFORE alias/fuzzy matching.
 */
function normalizeBrand(text) {
  if (!text) return '';
  return text.replace(/\bauto\s+x\b/g, 'torvex');
}

// ── Từ điển synonym nghiệp vụ ─────────────────────────────────────────────
//    Áp dụng SAU normalizeText + normalizeBrand, TRƯỚC matching.
//    Giúp fuzzy matcher nhận diện các cách gọi tương đương.
//    NOTE: "xe số" KHÔNG map → "gear" vì catalog "Gear Oil" = dầu hộp số/CVT, không phải dầu máy xe số.
const DOMAIN_SYNONYMS = {
  'tay ga': 'scoot',
  'xe tay ga': 'scoot',
  'nhot lap': 'gear oil',
  'dau lap': 'gear oil',
  // Sales gọi "nhớt láp" (= gear oil); nhiều SP dùng "Transmission Oil".
  // Map về một phía để input và tên SP gặp nhau trong fuzzy matching.
  'transmission': 'gear',
  // Cách gõ sai phổ biến ("Chain Transperant") — dist 2 so với "transparent"
  // vượt ngưỡng Levenshtein ≤1 của matcher → phải chuẩn hóa trước.
  'transperant': 'transparent',
  // "scooer" thiếu 't' (dist 1 so với "scooter") — gặp ở đơn real 16/9:
  // "moto xp scooer 10w40" + "moto xp 10w40" là 2 SP khác nhau (Scooter vs 4T);
  // nếu không chuẩn hóa, AI-FINAL chọn nhầm bản 4T → merge gộp 2 dòng thành 1.
  'scooer': 'scooter',
};

// ── Đơn vị đóng gói cho unit bonus/penalty trong findBestProductMatch ──────
// UNIT_HINT_TERMS: các đơn vị user có thể nêu đích danh ("5 chai", "1 thùng"...)
// SOFT_CONFLICT_HEAVY: đóng gói công nghiệp lớn (can/phuy/xô) — user nói
//   "chai" mà SP bán theo loại này → gần như chắc chắn khác hàng, trừ nặng.
//   "Bình" KHÔNG nằm đây: thương mại VN "bình" ≡ "chai" (chính catalog ghi
//   "(1L/bình)" cho SP unit=chai — bug thật 04/9: Xvil Fork 10 packaging
//   "6 bình x 1 lít" bị trừ nặng -20 → khớp nhầm sang SP Zentor khác brand).
// SOFT_CONFLICT_LIGHT: tuýp nhỏ — cùng họ chai/lọ nhưng khác quy cách, trừ nhẹ.
const UNIT_HINT_TERMS = new Set(['chai', 'lon', 'thung', 'phuy', 'xo', 'can', 'binh', 'tuyp']);
const SOFT_CONFLICT_HEAVY = ['phuy', 'xo', 'can'];
const SOFT_CONFLICT_LIGHT = ['tuyp'];
// Đơn vị "đóng thùng" — quy đổi số lượng của CÙNG sản phẩm (1 thùng = N chai,
// kvCodeThùng = mã gốc + "-1"), KHÔNG phải một quy cách hàng riêng nên không đủ
// tư cách "đòi đơn vị khác" trong wantsOtherUnit. (hasUnitConflict cũng không
// coi 'thùng' là đơn vị phân biệt — nhất quán theo cùng một chính sách.)
const BULK_HINT_UNITS = new Set(['thung', 'box']);

/**
 * Applies domain synonym expansion to normalized text.
 * E.g. "fast tay ga" → "fast scoot" so fuzzy can match "Fast Scoot" product.
 */
function applySynonyms(normalizedStr) {
  if (!normalizedStr) return '';
  let result = normalizedStr;
  for (const [key, val] of Object.entries(DOMAIN_SYNONYMS)) {
    if (result.includes(key)) {
      result = result.replace(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), val);
    }
  }
  return result.replace(/\s+/g, ' ').trim();
}

/**
 * Full normalization pipeline: normalizeText → normalizeBrand → applySynonyms.
 * Use this for input text before matching.
 */
function normalizeFull(rawText) {
  return applySynonyms(normalizeBrand(normalizeText(rawText)));
}

/**
 * Checks if input text has attribute conflicts (viscosity/volume/size) with a product.
 * Returns true if CONFLICT exists (product should be excluded from final match).
 * @param {string} normalizedInput - Normalized (+ synonym expanded) input text
 * @param {Object} product - Product object
 * @param {Object} [opts] - { relaxVol: skip volume conflict }
 */
function hasAttributeConflict(normalizedInput, product, opts = {}) {
  const fullProductText = normalizeText((product.name || '') + ' ' + (product.spec || '') + ' ' + (product.packaging || ''));
  // Volume/viscosity trích trên text THÔ (giữ "/"), vì normalizeText xoá dấu
  // câu khiến "(0,8L/kit)" dính thành token "08lkit" → extractVolume không
  // đọc được dung tích phía sản phẩm (bug thật: Chain Kit vs Chain Lube 400ml).
  const fullProductRaw = String(product.name || '') + ' ' + String(product.spec || '') + ' ' + String(product.packaging || '');
  const inputWords = normalizedInput.split(/\s+/).filter(Boolean);

  // Viscosity conflict
  const inputVisc = extractViscosity(normalizedInput);
  if (inputVisc) {
    const prodVisc = extractViscosity(fullProductRaw);
    if (prodVisc && prodVisc !== inputVisc) return true;
  }

  // Volume conflict (skipped when opts.relaxVol)
  // Mốc tối thiểu 0.05L (50ml): chai nhỏ dạng chăm sóc xe (400ml chain lube...)
  // cũng phải là thuộc tính phân biệt — bug cũ dùng mốc 0.5L làm "mù" dung tích
  // chai nhỏ → 400ml khớp nhầm sang SP 0,8L khác (Chain Kit).
  if (!opts.relaxVol) {
    const inputVol = extractVolume(normalizedInput);
    if (inputVol && inputVol >= 0.05) {
      const prodVol = extractVolume(fullProductRaw);
      if (prodVol && prodVol >= 0.05) {
        const ratio = Math.max(inputVol, prodVol) / Math.min(inputVol, prodVol);
        if (ratio >= 1.25) return true;
      }
    }
  }

  // Size conflict
  const inputSize = detectSizeToken(inputWords);
  if (inputSize) {
    const prodWords = fullProductText.split(/\s+/).filter(Boolean);
    const productSize = detectSizeToken(prodWords);
    if (productSize && productSize !== inputSize) return true;
  }

  // Qualifier conflict: input có "off road"/"offroad" mà SP KHÔNG có → xung đột.
  // Chiều ngược lại KHÔNG cấm: input "chain lube" thuần vẫn để ứng viên Off Road
  // qua được fuzzy — alias exact "chain lube" của bản trắng đã thắng sẵn.
  if (OFF_ROAD_RE.test(normalizedInput) && !OFF_ROAD_RE.test(fullProductText)) return true;

  return false;
}

/**
 * Checks if user's explicit unit hint conflicts with product's packaging type.
 * Only checks DISTINCT industrial packaging (phuy vs xô vs can vs bình).
 * Does NOT flag chai/lon (interchangeable in practice).
 * @param {string} unitHint - User's stated unit (raw, e.g. "phuy", "xô", "drum")
 * @param {Object} product - Product object
 * @returns {boolean} true if CONFLICT
 */
function hasUnitConflict(unitHint, product) {
  if (!unitHint || !product) return false;
  const hintNorm = normalizeText(unitHint); // "xô"→"xo", "drum"→"drum"
  // Map English/variant → canonical
  const hintCanonical = (hintNorm === 'drum' || hintNorm === 'phuy') ? 'phuy'
    : (hintNorm === 'pail' || hintNorm === 'bucket' || hintNorm === 'xo') ? 'xo'
    : hintNorm;
  const DISTINCT_UNITS = ['phuy', 'xo', 'can', 'binh'];
  if (!DISTINCT_UNITS.includes(hintCanonical)) return false;

  const prodText = normalizeText((product.unit || '') + ' ' + (product.spec || '') + ' ' + (product.packaging || ''));
  // Product có chứa unit hint → KHÔNG xung đột
  if (prodText.includes(hintCanonical)) return false;
  // Product chứa unit phân biệt KHÁC → XUNG ĐỘT
  return DISTINCT_UNITS.some(u => u !== hintCanonical && prodText.includes(u));
}

/**
 * Normalizes item units.
 */
function normalizeUnit(raw) {
  if (!raw) return '';
  const lower = raw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
  const map = { 
    'thung': 'thùng', 'thg': 'thùng', 'carton': 'thùng', 'ctn': 'thùng', 'box': 'thùng', 
    'chai': 'chai', 'lon': 'chai', 'bottle': 'chai', 'btl': 'chai', 'can': 'can', 
    'phuy': 'phuy', 'drum': 'phuy', 'bo': 'bộ', 'lit': 'lít', 'hop': 'hộp', 
    'xo': 'xô', 'xô': 'xô', 'pail': 'xô', 'bucket': 'xô',
    'pcs': 'pcs', 'cai': 'pcs', 'kg': 'kg', 'tui': 'túi', 'túi': 'túi',
    'binh': 'bình', 'bình': 'bình',
    'ao': 'áo', 'áo': 'áo',
    'cay': 'cái', 'cây': 'cái', 'cuon': 'cuốn', 'cuốn': 'cuốn'
  };
  return map[lower] || raw;
}

/**
 * Highly optimized Levenshtein distance algorithm.
 * Uses 2 1D arrays instead of a 2D matrix to prevent GC pressure.
 * Includes early exit if length difference is too large.
 */
function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 99; // Early exit for performance

  let prevRow = Array.from({ length: b.length + 1 }, (_, j) => j);
  let currRow = [];

  for (let i = 1; i <= a.length; i++) {
    currRow = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow.push(Math.min(
        currRow[j - 1] + 1,      // Insertion
        prevRow[j] + 1,          // Deletion
        prevRow[j - 1] + cost    // Substitution
      ));
    }
    prevRow = currRow;
  }
  return prevRow[b.length];
}

// ── Size tokens dùng cho merchandise (áo, polo, nón...)
//    Khi input chứa size → CHỈ khớp sản phẩm có ĐÚNG size đó.
const SIZE_TOKENS = new Set(['s', 'm', 'l', 'xl', 'xxl', 'xxxl', '2xl', '3xl', '4xl', '5xl']);

// ── Qualifier "off road" — thuộc tính phân biệt (Chain Lube vs Chain Lube Off Road)
//    Bug thật 24/9/2026: matcher so alias theo chuỗi liên tục — "off road chain
//    lube" (đảo thứ tự) hay "chain lube, loại off road" (dấu phẩy) KHÔNG khớp
//    alias "chain lube off road" nhưng vẫn match trọn alias trần "chain lube"
//    của bản trắng (95đ) → đẩy sai hàng dù sales ghi rõ "off road".
//    Khi input CÓ qualifier, SP không mang qualifier phải bị LOẠI (hard filter).
const OFF_ROAD_RE = /\boff\s*road\b|\boffroad\b/i;

/**
 * Detects size tokens present in a word list.
 * Returns the FIRST size token found (normalized), or null.
 */
function detectSizeToken(words) {
  for (const w of words) {
    if (SIZE_TOKENS.has(w)) return w;
  }
  return null;
}

// ── Viscosity grade extraction ─────────────────────────────────────────────
//    VD: "10w30", "10w40", "20w50", "5w40" → mỗi sản phẩm chỉ có 1 grade.
//    Nếu input có grade mà product có grade KHÁC → cap score tối đa 25.
const VISC_REGEX = /(\d{1,2})w[\s-]?(\d{2,3})/i;

/**
 * Extracts viscosity grade string from a text (normalized, no space).
 * Returns e.g. "10w30", "20w50" or null.
 */
function extractViscosity(text) {
  const m = text.match(VISC_REGEX);
  if (!m) return null;
  return (m[1] + 'w' + m[2]).toLowerCase();
}

// ── Volume extraction ──────────────────────────────────────────────────────
//    VD: "1l", "5l", "20l", "209l", "18l", "0.8l", "800ml"
//    Nếu input có volume mà product có volume KHÁC → cap score tối đa 35.
const VOL_REGEX = /(\d+(?:[.,]\d+)?)\s*(l|lit|liter|ml)(?:\b|[^a-z])/i;

/**
 * Extracts volume in liters from text. Returns number (liters) or null.
 */
function extractVolume(text) {
  const m = text.match(VOL_REGEX);
  if (!m) return null;
  let val = parseFloat(m[1].replace(',', '.'));
  const unit = m[2].toLowerCase();
  if (unit === 'ml') val = val / 1000;
  return val;
}

/**
 * Calculates similarity score (0 - 100) between input text and a product.
 * HARD FILTER: returns 0 when input has explicit attribute (viscosity/volume/size)
 * that CONFLICTS with product → product is excluded from candidate pool entirely.
 * No more boosts (+15/+10 removed) — score is pure name similarity + penalty.
 * @param {string} normalizedInput - Normalized input text
 * @param {Object} product - Product object
 * @param {Object} [opts] - { relaxVol: skip volume conflict (for fallback pass) }
 */
function calculateMatchScore(normalizedInput, product, opts = {}) {
  if (!product || !product.name || product.name === '1' || product.name === 'X' || product.name === 'ĐH 2.000.000') return 0;
  
  // Match mã KV đã RESOLVE (kv-name-map.json/app-config thắng inline — cùng nguồn với getKvCode)
  const resolvedKv = (typeof db !== 'undefined' && db.getKvCode) ? db.getKvCode(product) : '';
  if ((resolvedKv && normalizedInput.includes(resolvedKv)) ||
      (product.kvCode && normalizedInput.includes(product.kvCode))) {
    return 100;
  }

  // ── HARD FILTER: thuộc tính xung đột → LOẠI (score 0) ──
  if (hasAttributeConflict(normalizedInput, product, opts)) return 0;

  // Product side đi qua CÙNG pipeline normalize (gồm DOMAIN_SYNONYMS) với
  // input để các cách gọi tương đương ("Transmission Oil" ≡ "nhớt láp"≡
  // "gear oil") gặp được nhau trong fuzzy matching.
  const productName = normalizeFull(product.name);
  const productSpec = normalizeFull(product.spec || '');
  const stopWords = new Set(['nhot', 'dau', 'chai', 'thung', 'can', 'hop', 'gia', 'mua', 'tang', 'sp', 'hang']);
  const rawWords = normalizedInput.split(/\s+/).filter(Boolean);
  const filteredWords = rawWords.filter(w => !stopWords.has(w));
  const inputWords = filteredWords.length > 0 ? filteredWords : rawWords;

  const allProductWords = [...productName.split(/\s+/), ...productSpec.split(/\s+/)].filter(Boolean);

  return _calcRawScore(inputWords, allProductWords, productName);
}

/**
 * Internal: raw word-by-word scoring with bidirectional penalty.
 * Forward: input words matched in product → positive score.
 * Reverse: meaningful product NAME words NOT in input → penalty (-8/word, cap -25).
 * This ensures "Fast Scoot" beats "Fast Good Scoot" when input is "fast scoot".
 */
function _calcRawScore(inputWords, allProductWords, productNameNorm) {
  let matchedWords = 0, totalWeight = 0;
  for (const iw of inputWords) {
    if (!iw) continue;
    let bestWordMatch = 0;
    for (const pw of allProductWords) {
      if (!pw) continue;
      if (pw === iw) { 
        bestWordMatch = Math.max(bestWordMatch, 2); 
        break; 
      }
      // Match numeric viscosity codes like 5 -> 5w, 10 -> 10w
      if (/^\d+(?:[.,]\d+)?$/.test(iw) && pw.startsWith(iw) && pw.length <= iw.length + 2) {
        bestWordMatch = Math.max(bestWordMatch, 2);
        break;
      }
      // Compound viscosity: "10w30" → product must contain BOTH "10w" AND "30"
      // This distinguishes 10W-30 from 10W-40 when name tokens are split ("10w", "30")
      const viscMatch = iw.match(/^(\d+w)(\d+)$/);
      if (viscMatch) {
        const [, vPrefix, vSuffix] = viscMatch; // e.g. "10w", "30"
        const hasPrefix = allProductWords.some(w => w === vPrefix || w === vPrefix + '-' || w.startsWith(vPrefix));
        const hasSuffix = allProductWords.some(w => w === vSuffix);
        if (hasPrefix && hasSuffix) {
          bestWordMatch = Math.max(bestWordMatch, 2); // Exact grade match
          break;
        } else if (hasPrefix && !hasSuffix) {
          // Same family (10w) but WRONG grade → penalize: low partial score
          bestWordMatch = Math.max(bestWordMatch, 0.3);
        }
        continue; // Skip other rules for this token
      }
      // Short API grade prefix: "ci" → "ci4", "cf" → "cf4", "ck" → "ck4"
      if (iw.length === 2 && pw.startsWith(iw) && pw.length <= iw.length + 2) {
        bestWordMatch = Math.max(bestWordMatch, 1.5);
        break;
      }
      // Size tokens: KHÔNG cho substring match ("xl" KHÔNG được includes vào "xxl")
      if (SIZE_TOKENS.has(iw) || SIZE_TOKENS.has(pw)) {
        // Chỉ exact match mới có điểm (đã check pw === iw ở trên)
        continue;
      }
      if (pw.length >= 3 && iw.length >= 3 && (pw.includes(iw) || iw.includes(pw))) { 
        bestWordMatch = Math.max(bestWordMatch, 1.5); 
      } else {
        const dist = levenshtein(iw, pw);
        if (dist <= 1 && iw.length >= 4) { 
          bestWordMatch = Math.max(bestWordMatch, 1); 
        }
      }
    }
    matchedWords += bestWordMatch;
    totalWeight += 2;
  }
  const forwardScore = totalWeight === 0 ? 0 : Math.round((matchedWords / totalWeight) * 100);

  // ── BIDIRECTIONAL PENALTY: từ thừa có nghĩa trong product NAME ──
  // Bỏ qua: brand tokens, packaging, stopwords, số, từ ngắn (<2 ký tự)
  if (!productNameNorm) return forwardScore;
  const IGNORE_TOKENS = new Set([
    'zentor', 'torvex', 'auto', 'x', 'xvil', 'veltron', 'tvx',
    'chai', 'lon', 'binh', 'tuyp', 'xo', 'phuy', 'thung', 'can', 'hop', 'tui', 'cai',
    'nhot', 'dau', 'gia', 'mua', 'tang', 'sp', 'hang'
  ]);
  const nameWords = productNameNorm.split(/\s+/).filter(Boolean);
  const inputSet = new Set(inputWords);
  let extraCount = 0;
  for (const nw of nameWords) {
    if (nw.length < 2) continue;
    if (/^\d/.test(nw)) continue;
    if (IGNORE_TOKENS.has(nw)) continue;
    // Kiểm tra từ này có xuất hiện trong input không (exact, substring, hoặc fuzzy gần đúng)
    const foundInInput = inputSet.has(nw) ||
      inputWords.some(iw => iw.length >= 3 && nw.length >= 3 && (iw.includes(nw) || nw.includes(iw))) ||
      inputWords.some(iw => iw.length >= 4 && nw.length >= 4 && levenshtein(iw, nw) <= 1);
    if (!foundInInput) extraCount++;
  }
  const penalty = Math.min(extraCount * 8, 25);
  return Math.max(0, forwardScore - penalty);
}

/**
 * So giá sales khai (explicitPrice) với giá tham chiếu của sản phẩm.
 * Dùng để phân biệt 2 SP trùng tên gọi ở khác brand (VD "Fork 10": Xvil 173k vs
 * Zentor 228k) — giá sales đưa thường khớp ĐÚNG giá list của hàng khách mua.
 * @param {Object} product - Sản phẩm danh mục.
 * @param {number} hint - Giá sales khai (đã quy đổi ra VND).
 * @returns {boolean|null} true = khớp giá; false = lệch rõ (≥25%); null = trung tính
 *   (không có giá tham chiếu hoặc giá gần nhưng không khớp chính xác).
 */
function priceHintMatches(product, hint) {
  if (!product || !hint || hint <= 0) return null;
  const ref = (typeof db !== 'undefined' && db.getPriceForQty) ? db.getPriceForQty(product, 1) : 0;
  if (!ref || ref <= 0) return null;
  const boxSize = product.box_size || 12;
  // Sales có thể báo giá theo CHAI hoặc theo THÙNG — chấp nhận cả 2 mốc (sai số 2%)
  for (const cand of [ref, ref * boxSize]) {
    if (Math.abs(hint - cand) / cand <= 0.02) return true;
  }
  const ratio = hint / ref;
  if (ratio >= 1.25 || ratio <= 0.8) return false;
  return null;
}

/**
 * Finds the best matching product based on aliases and fuzzy scoring.
 * Architecture: kvCode → alias (with attribute guard) → fuzzy (hard filter + relaxVol fallback).
 * @param {string} rawText - The raw product text to match.
 * @param {Array} allProducts - All available products.
 * @param {Object} aliases - Alias → productId map.
 * @param {string} [unitHint] - Optional unit the user specified (e.g. "phuy", "xô", "thùng").
 * @param {number} [priceHint] - Optional explicit price from the sales message (VND) —
 *   phân biệt 2 SP trùng tên gọi khác brand bằng giá (khớp +25, lệch rõ −15).
 * @returns {{product, score, via, runnerUp, relaxed?}|null}
 */
function findBestProductMatch(rawText, allProducts, aliases, unitHint, priceHint) {
  if (!rawText || rawText.trim().length === 0) return null;
  const normalized = normalizeFull(rawText);
  if (!normalized) return null;

  // 0. Match by KV Code (KiotViet Product Code: 5-8 digits)
  const kvCodeMatches = rawText.match(/(?:mã|ma|code|sku)?\s*(\d{5,8})\b/gi);
  if (kvCodeMatches) {
    for (const matchStr of kvCodeMatches) {
      const code = matchStr.replace(/\D/g, '');
      if (code) {
        const foundByKv = (allProducts || []).find(p => {
          if (!p) return false;
          if (p.kvCode && String(p.kvCode).trim() === code) return true;
          if (typeof db !== 'undefined' && db.getKvCode && db.getKvCode(p) === code) return true;
          return false;
        });
        if (foundByKv) {
          return { product: foundByKv, score: 100, via: 'kvcode', runnerUp: null };
        }
      }
    }
  }

  const sortedAliases = Object.entries(aliases || {}).sort((a, b) => b[0].length - a[0].length);
  const unitNorm = unitHint ? normalizeText(unitHint) : '';

  // Alias hit giữ lại thay vì return ngay: sales đích danh đòi MỘT ĐƠN VỊ KHÁC
  // SP alias đang bán ("6 chai Veltron Engine cleaner" — alias "engine cleaner"
  // trúng bản bán theo bình) thì fuzzy (có unit bonus) được cơ hội lật — chỉ khi
  // khớp tên đủ tốt (≥ điểm alias). Mọi trường hợp khác alias vẫn tuyệt đối
  // (bất biến correction-learning: alias thắng mọi tín hiệu khác trừ mã KV).
  let aliasHit = null; // { product, score, via: 'alias' }

  // 1. Exact alias match or full word match for aliases length >= 4
  //    Alias PHẢI qua attribute guard + unit guard — xung đột → skip, xuống fuzzy.
  for (const [alias, productId] of sortedAliases) {
    const aliasNorm = normalizeFull(alias);
    if (!aliasNorm) continue;
    if (normalized === aliasNorm) {
      const product = allProducts.find(p => p.id === productId);
      if (product && !hasAttributeConflict(normalized, product) && !hasUnitConflict(unitHint, product)) {
        aliasHit = { product, score: 100, via: 'alias' };
        break;
      }
    }
    if (aliasNorm.length >= 4) {
      const regex = new RegExp('\\b' + aliasNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
      if (regex.test(normalized)) {
        const product = allProducts.find(p => p.id === productId);
        if (product && !hasAttributeConflict(normalized, product) && !hasUnitConflict(unitHint, product)) {
          aliasHit = { product, score: 95, via: 'alias' };
          break;
        }
      }
    }
  }

  // 2. Word-based alias match (cũng qua attribute + unit guard)
  if (!aliasHit) {
    for (const [alias, productId] of sortedAliases) {
      const aliasNorm = normalizeFull(alias);
      const aliasWords = aliasNorm.split(/\s+/).filter(Boolean);
      const textWords = normalized.split(/\s+/).filter(Boolean);
      if (aliasWords.length >= 2 && aliasWords.every(aw => textWords.some(tw => tw === aw || (aw.length >= 3 && tw.includes(aw))))) {
        const product = allProducts.find(p => p.id === productId);
        if (product && !hasAttributeConflict(normalized, product) && !hasUnitConflict(unitHint, product)) {
          aliasHit = { product, score: 90, via: 'alias' };
          break;
        }
      }
    }
  }

  if (aliasHit) {
    const aliasUnit = normalizeText(aliasHit.product.unit || '');
    // "thùng" là đơn vị đóng thùng CỦA CHÍNH SP đó (kvCodeThùng = mã gốc + "-1"),
    // không phải đòi quy cách khác: "2 thùng chain lube max" vẫn là đúng SP alias
    // bán theo chai. Nếu để wantsOtherUnit kích hoạt, fuzzy được cơ hội lật và
    // khi hòa điểm 100 (input 2 từ khớp tròn tên SP khác brand — tie-break ưu tiên
    // tên ít từ) sẽ chọn NHẦM brand (bug thật 09/25: "1 Thùng Chain Cleaner" →
    // Xvil Chain Cleaner thay vì Zentor GP Chain Cleaner của alias).
    const wantsOtherUnit = !BULK_HINT_UNITS.has(unitNorm)
      && UNIT_HINT_TERMS.has(unitNorm) && UNIT_HINT_TERMS.has(aliasUnit) && aliasUnit !== unitNorm;
    if (!wantsOtherUnit) {
      return { product: aliasHit.product, score: aliasHit.score, via: 'alias', runnerUp: null };
    }
    // wantsOtherUnit → rơi xuống fuzzy bên dưới, so điểm cuối cùng ở đuôi hàm.
  }

  // 3. Fuzzy match với HARD FILTER (calculateMatchScore trả 0 khi xung đột thuộc tính)
  //    Theo dõi best + runner-up để phát hiện khớp mơ hồ → cần AI phân xử.
  //    Tie-break tất định: điểm bằng nhau → ưu tiên SP có ít từ hơn (khớp gọn hơn).

  function fuzzyLoop(relaxVol) {
    let best = null, bScore = 0, bestWordCount = Infinity;
    let runner = null, rScore = 0;
    for (const product of allProducts) {
      if (!product || !product.name || product.name === '1' || product.name === 'X' || product.name === 'ĐH 2.000.000') continue;
      let score = calculateMatchScore(normalized, product, relaxVol ? { relaxVol: true } : {});
      if (score < 25) continue;
      // Unit bonus: phân xử khi 2 SP cùng tên khác quy cách đóng gói.
      // KHÔNG áp lên match tên ĐỦ TỪ KHÓA (score ≥ 100 — mọi từ khóa sales đều
      // khớp tên SP, ví dụ "Fork 10" trúng "Xvil Fork 10"): unit hint chỉ là
      // tie-breaker khi các ứng viên chênh nhau ít, không đủ sức lật ứng viên
      // khớp đủ tên. Bug thật 04/9: "1 chai Fork 10 giá thùng" bị phạt 'bình'
      // trúng nhầm Zentor Topgear GP Fork Oil 10W (khác hàng, chênh 58k).
      // Lưu ý: khi sales GHI GIÁ thì priceHint bên dưới vẫn thắng tất cả.
      if (unitNorm && score > 0 && score < 100) {
        const pUnit = normalizeText(product.unit || '');
        const pPack = normalizeText(product.packaging || '');
        const pSpec = normalizeText(product.spec || '');
        // Tầng tín hiệu: ĐƠN VỊ BÁN trùng hint là bằng chứng mạnh (+15); spec text
        // là trung gian (+10); packaging chỉ là "12 chai/thùng" — gần như SP đóng
        // chai nào cũng chứa chữ "chai" nên chỉ +5 (bug thật 04/9: "6 chai Veltron
        // Engine cleaner" hòa 107-107 giữa SP unit bình và SP unit chai vì cả hai
        // cùng pack → tie-break theo catalog chọn nhầm bản bình). Vẫn KHÔNG trừ
        // điểm 'bình' (bình ≡ chai) và không đụng match đủ tên ≥100.
        if (pUnit === unitNorm) {
          score += 15;
        } else if (pSpec === unitNorm) {
          score += 10;
        } else if (pPack.includes(unitNorm)) {
          score += 5;
        } else if (UNIT_HINT_TERMS.has(unitNorm)) {
          // Unit mismatch penalty (mềm): user nêu đích danh đơn vị (vd "chai")
          // mà SP bán theo loại đóng gói khác → trừ điểm nhường SP đúng đơn vị.
          // Chỉ trừ, KHÔNG loại — phòng DB ghi unit lệch.
          const prodUnitText = pUnit + ' ' + pPack;
          if (prodUnitText) {
            if (SOFT_CONFLICT_HEAVY.some(u => prodUnitText.includes(u))) score -= 20;
            else if (SOFT_CONFLICT_LIGHT.some(u => prodUnitText.includes(u))) score -= 10;
          }
        }
      }
      // Price bonus — cơ chế "GẦN GIÁ NÀO CHỌN GIÁ ĐẤY": điểm cộng/trừ theo MỨC ĐỘ
      // GẦN giá sales khai (so cả mốc giá chai lẫn giá thùng). Giá khớp gần chính xác
      // (sai số ≤2% — sales chép giá list) là tín hiệu gần-quyết định (+45) vì 2 brand
      // trùng tên gọi ("Fork 10" có ở cả Xvil lẫn Zentor) được phân biệt bằng giá.
      // Lệch xa dần thì trừ dần (tối đa −15). Giá sales tự khai cho KM/giá riêng không
      // gần ứng viên nào → các ứng viên chênh nhau ít, thứ hạng theo tên giữ nguyên.
      if (priceHint && score > 0) {
        const ref = (typeof db !== 'undefined' && db.getPriceForQty) ? db.getPriceForQty(product, 1) : 0;
        if (ref > 0) {
          const boxSize = product.box_size || 12;
          const boxRef = ref * boxSize;
          const relDiff = Math.min(
            Math.abs(priceHint - ref) / ref,
            Math.abs(priceHint - boxRef) / boxRef
          );
          score += relDiff <= 0.02 ? 45 : Math.max(-15, Math.round(30 - relDiff * 75));
        }
      }
      const wordCount = (product.name || '').split(/\s+/).length;
      if (score > bScore || (score === bScore && wordCount < bestWordCount)) {
        runner = best; rScore = bScore;
        bScore = score; best = product; bestWordCount = wordCount;
      } else if (score > rScore) {
        rScore = score; runner = product;
      }
    }
    return { best, bScore, runner, rScore };
  }

  let { best, bScore, runner, rScore } = fuzzyLoop(false);
  let relaxed = false;

  // Relax volume fallback: nếu hard filter loại hết → nới volume, giữ visc/size
  if (!best) {
    const retry = fuzzyLoop(true);
    best = retry.best; bScore = retry.bScore; runner = retry.runner; rScore = retry.rScore;
    if (best) relaxed = true;
  }

  const runnerUp = runner ? { product: runner, score: rScore } : null;
  if (!best) {
    if (aliasHit) return { product: aliasHit.product, score: aliasHit.score, via: 'alias', runnerUp: null };
    return null;
  }
  if (aliasHit) {
    if (bScore < aliasHit.score) {
      // Fuzzy không đủ sức lật alias → alias thắng (giữ bất biến alias)
      return { product: aliasHit.product, score: aliasHit.score, via: 'alias', runnerUp };
    }
    const finalRunner = (!runnerUp || runnerUp.score < aliasHit.score)
      ? { product: aliasHit.product, score: aliasHit.score } : runnerUp;
    return { product: best, score: bScore, via: 'fuzzy-unit-over-alias', runnerUp: finalRunner, ...(relaxed ? { relaxed: true } : {}) };
  }
  return { product: best, score: bScore, via: 'fuzzy', runnerUp, ...(relaxed ? { relaxed: true } : {}) };
}

/**
 * Returns the top-N fuzzy-match candidates for a raw text, sorted by score desc.
 * Uses the SAME scorer (calculateMatchScore) as findBestProductMatch so the
 * candidate list is consistent with the ambiguity (runner-up) detection.
 * Used to feed the AI disambiguation step with a relevant shortlist.
 * @returns {Array<{product, score}>} (may be empty)
 */
function findTopProductMatches(rawText, allProducts, limit = 15) {
  const normalized = normalizeFull(rawText);
  if (!normalized) return [];
  const scored = [];
  for (const product of (allProducts || [])) {
    if (!product || !product.name || product.name === '1' || product.name === 'X' || product.name === 'ĐH 2.000.000') continue;
    const score = calculateMatchScore(normalized, product);
    if (score >= 25) scored.push({ product, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Builds a comprehensive shortlist for AI final selection.
 * Multi-source strategy ensures the correct product is IN the list:
 *   Source 1: Fuzzy top-N (name similarity)
 *   Source 2: Alias targets (any alias whose words appear in input)
 *   Source 3: Brand family (if a brand is detected, include its products)
 * Deduplicates by product.id. Sorted by score desc.
 * @param {string} rawText - Raw product text from sales message
 * @param {Array} allProducts - Full product catalog
 * @param {Object} aliases - Alias → productId map
 * @param {number} [limit=15] - Max candidates to return
 * @returns {Array<{product, score, source}>}
 */
function buildShortlist(rawText, allProducts, aliases, limit = 15) {
  const normalized = normalizeFull(rawText);
  if (!normalized) return [];
  const inputWords = normalized.split(/\s+/).filter(Boolean);
  const seen = new Set(); // product.id dedup
  const results = []; // {product, score, source}

  function addProduct(product, score, source) {
    if (!product || seen.has(product.id)) return;
    if (!product.name || product.name === '1' || product.name === 'X' || product.name === 'ĐH 2.000.000') return;
    seen.add(product.id);
    results.push({ product, score, source });
  }

  // Source 1: Fuzzy top-N
  const fuzzyTop = findTopProductMatches(rawText, allProducts, limit);
  for (const { product, score } of fuzzyTop) {
    addProduct(product, score, 'fuzzy');
  }

  // Source 2: Alias targets — any alias whose words overlap with input
  for (const [alias, productId] of Object.entries(aliases || {})) {
    const aliasNorm = normalizeText(alias);
    if (!aliasNorm) continue;
    const aliasWords = aliasNorm.split(/\s+/).filter(Boolean);
    // At least half of alias words must appear in input (flexible match)
    const overlapCount = aliasWords.filter(aw =>
      inputWords.some(iw => iw === aw || (aw.length >= 3 && iw.includes(aw)) || (iw.length >= 3 && aw.includes(iw)))
    ).length;
    if (overlapCount >= Math.max(1, Math.ceil(aliasWords.length * 0.5))) {
      const product = allProducts.find(p => p.id === productId);
      // Attribute guard: không đưa SP xung đột (vd bản trắng khi input có "off
      // road") vào shortlist — AI-FINAL chọn trong shortlist, lọt vào là chọn sai.
      if (product && !hasAttributeConflict(normalized, product)) addProduct(product, 70 + overlapCount * 5, 'alias');
    }
  }

  // Source 3: Brand family — detect brand from top fuzzy hits, add siblings
  const brandKeywords = {
    'furox': 'torvex', 'furvex': 'tvx', 'fast': 'torvex', 'torvex': 'torvex',
    'prostream': 'zentor', 'topgear': 'zentor', 'zentor': 'zentor',
    'moto': 'zentor', 'xvil': 'xvil', 'kaiten': 'xvil', 'veltron': 'veltron'
  };
  let detectedBrand = null;
  for (const iw of inputWords) {
    if (brandKeywords[iw]) { detectedBrand = brandKeywords[iw]; break; }
  }
  if (!detectedBrand && fuzzyTop.length > 0) {
    // Infer brand from top fuzzy hit's id prefix
    const topId = fuzzyTop[0].product.id || '';
    if (topId.startsWith('torvex') || topId.startsWith('tvx')) detectedBrand = 'torvex';
    else if (topId.startsWith('znt')) detectedBrand = 'zentor';
    else if (topId.startsWith('xvil')) detectedBrand = 'xvil';
    else if (topId.startsWith('veltron')) detectedBrand = 'veltron';
  }
  // ATTRIBUTE GUARDS cho brand family: nếu input có thuộc tính phân biệt tường minh
  // (size, viscosity, volume) thì CHỈ thêm sản phẩm KHỚP thuộc tính đó vào shortlist.
  const inputSizeForBrand = detectSizeToken(inputWords);
  const inputViscForBrand = extractViscosity(normalized);
  const inputVolForBrand = extractVolume(normalized);
  if (detectedBrand) {
    const brandPrefixes = detectedBrand === 'torvex' ? ['torvex', 'tvx'] : [detectedBrand === 'zentor' ? 'znt' : detectedBrand];
    let brandCount = 0;
    for (const product of allProducts) {
      if (brandCount >= 8) break; // Cap brand family additions
      if (!product || !product.id) continue;
      if (brandPrefixes.some(bp => product.id.startsWith(bp))) {
        // Only add if product name has SOME relevance (shares at least 1 word with input)
        const pWords = normalizeText(product.name).split(/\s+/).filter(Boolean);
        const sharesWord = inputWords.some(iw => iw.length >= 3 && pWords.some(pw => pw === iw || pw.includes(iw) || iw.includes(pw)));
        if (sharesWord) {
          const fullPText = normalizeText(product.name + ' ' + (product.spec || '') + ' ' + (product.packaging || ''));
          // Size guard
          if (inputSizeForBrand) {
            const pSize = detectSizeToken(pWords);
            if (pSize && pSize !== inputSizeForBrand) continue;
          }
          // Viscosity guard
          if (inputViscForBrand) {
            const pVisc = extractViscosity(fullPText);
            if (pVisc && pVisc !== inputViscForBrand) continue;
          }
          // Volume guard
          if (inputVolForBrand && inputVolForBrand >= 0.5) {
            const pVol = extractVolume(fullPText);
            if (pVol && pVol >= 0.5) {
              const ratio = Math.max(inputVolForBrand, pVol) / Math.min(inputVolForBrand, pVol);
              if (ratio >= 1.25) continue;
            }
          }
          // Qualifier guard: input có "off road" → chỉ thêm SP có "off road"
          if (OFF_ROAD_RE.test(normalized) && !OFF_ROAD_RE.test(fullPText)) continue;
          addProduct(product, 40, 'brand');
          brandCount++;
        }
      }
    }
  }

  // Sort by score desc, cap at limit
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

// ── Số đếm tiếng Việt → chữ số (module scope — dùng chung parser + repair) ─
// Sales hay ghi "một phuy", "hai mươi thùng", "năm chục chai" thay vì số.
// CHỈ chuyển khi NGAY SAU là ĐƠN VỊ để tránh nhầm với tên riêng
// ("Bảy Tám 3 phuy" → chỉ "3 phuy" bị đụng tới).
const unitAlt = 'thùng|thg|thung|carton|ctn|box|chai|lon|can|bottle|btl|phuy|phụy|drum|bộ|bo|lít|lit|hộp|hop|xô|xo|pail|bucket|bình|binh|pcs|cái|cai|cây|cay|kg|túi|tui|áo|ao|cuốn|cuon';
// Boundary thay thế \b — \b không hoạt động sau ký tự có dấu (ô, ù, ộ...)
// vì JS regex chỉ coi [a-zA-Z0-9_] là word char. Dùng negative lookahead.
const ubnd = '(?![a-z0-9à-ỹ])';

// ── Ký tự rác giữa số lượng và đơn vị ──────────────────────────────────────
// Copy tin nhắn từ điện thoại hay dính dấu nháy sau số lượng ("1' thùng Chain
// Lube Offroad" — bug thật 09/25: mọi regex qty+unit chỉ chấp nhận khoảng trắng
// giữa số và đơn vị nên dòng bị vứt vào ghi chú, mất hàng). Gỡ trước họ dấu
// nháy/quote. KHÔNG đụng dấu thập phân ("1.5 thùng", "1,5 lít" giữ nguyên).
const QTY_JUNK_RE = new RegExp(
  '(\\d+)\\s*[\'\u2019\u2018\u00B4`\u201C\u201D"]\\s*(' + unitAlt + ')' + ubnd,
  'gi'
);

/** Gỡ dấu nháy/quote rác nằm giữa số lượng và đơn vị ("1' thùng" → "1 thùng"). */
function stripQtyJunk(text) {
  if (!text) return text || '';
  return text.replace(QTY_JUNK_RE, '$1 $2');
}

// ── Dòng mốc giá đứng riêng ─────────────────────────────────────────────────
// Sales hay khai mốc giá CHO TOÀN ĐƠN bằng một dòng riêng: "Giá 2 thùng",
// "giá thùng", "áp giá 3 thùng". Đây KHÔNG phải dòng hàng — nếu để lọt qua
// parse bình thường, "Giá" bị match nhầm thành item "Poster Pricelist" 0đ
// (bug thật 22/9/2026) và không item nào được áp mốc.
const STANDALONE_TIER_RE = /^\s*(?:áp\s*)?(?:giá|gia|price)\s*:?\s*(\d+)?\s*(?:thùng|thg|thung|carton|ctn|box)\b\.?\s*$/i;

/**
 * Một dòng có phải DÒNG MỐC GIÁ đứng riêng không ("Giá 2 thùng", "giá thùng").
 * Dòng ghép trên dòng sản phẩm ("2 thùng X giá 2 thùng") KHÔNG khớp — nó do
 * parseSegment xử lý qua tierOverrideRegex như cũ.
 * @returns {boolean}
 */
function isStandaloneTierLine(text) {
  if (!text) return false;
  return STANDALONE_TIER_RE.test(String(text));
}

/**
 * Đọc số mốc của dòng mốc giá đứng riêng: "Giá 2 thùng" → 2, "giá thùng" → 1.
 * Trả null nếu không phải dòng mốc giá. Dùng chung bởi parseOrderText (type
 * 'tier-override') và parse-pipeline (áp mốc toàn đơn bằng CODE, không phụ
 * thuộc AI có đặt priceTierQty hay không).
 * @returns {number|null}
 */
function standaloneTierQty(text) {
  if (!text) return null;
  const m = String(text).match(STANDALONE_TIER_RE);
  if (!m) return null;
  return m[1] ? parseInt(m[1], 10) : 1;
}

const VN_DIGIT_WORDS = {
  'mười': 10,
  'một': 1, 'mot': 1, 'hai': 2, 'ba': 3,
  'bốn': 4, 'bon': 4, 'năm': 5, 'nam': 5, 'lăm': 5, 'lam': 5,
  'sáu': 6, 'sau': 6, 'bảy': 7, 'bay': 7,
  'tám': 8, 'tam': 8, 'chín': 9, 'chin': 9,
};
const isVnMuoi = t => t === 'mươi' || t === 'muoi'; // hàng chục: "hai mươi"=20; đứng một mình=10
const isVnTram = t => t === 'trăm' || t === 'tram'; // "ba trăm"=300
const isVnChuc = t => t === 'chục' || t === 'chuc'; // "năm chục"=50

/** Chuỗi từ số đếm ("hai","mươi","lăm") → số. Trả null nếu vô nghĩa. */
function vnWordSeqToNumber(words) {
  let total = 0;
  let cur = null;
  let afterMuoi = false;
  for (const w of words) {
    if (isVnMuoi(w)) {
      if (cur == null) { cur = 10; }                            // "muoi thùng" = 10
      else if (afterMuoi) return null;                          // "hai mươi mươi"
      else { cur *= 10; afterMuoi = true; }
    } else if (isVnTram(w)) {
      if (cur == null) return null;
      total += cur * 100; cur = null; afterMuoi = false;
    } else if (isVnChuc(w)) {
      if (cur == null || afterMuoi) return null;
      cur *= 10; afterMuoi = false;
    } else if (VN_DIGIT_WORDS[w] != null) {
      const d = VN_DIGIT_WORDS[w];
      if (cur == null) cur = d;
      else if (afterMuoi || cur === 10) { cur += d; afterMuoi = false; } // "hai mươi lăm", "mười lăm"
      else return null;                                         // "hai ba" vô nghĩa
    } else return null;
  }
  if (cur != null) total += cur;
  return total > 0 && total <= 9999 ? total : null;
}

const VN_SEQ_WORD_ALT = Object.keys(VN_DIGIT_WORDS)
  .concat(['muoi', 'mươi', 'trăm', 'tram', 'chục', 'chuc'])
  .join('|');
// Chuỗi từ số đếm (1 từ hoặc nhiều từ nối nhau bằng khoảng trắng) đứng ngay
// trước đơn vị: "hai mươi lăm chai" → bắt nguyên chuỗi để quy về 35.
const vnSeqRe = new RegExp(
  '(^|[\\s,;+])((?:' + VN_SEQ_WORD_ALT + ')(?:\\s+(?:' + VN_SEQ_WORD_ALT + '))*)(\\s+(?:' + unitAlt + ')' + ubnd + ')',
  'gi'
);
// Số viết sẵn kèm "chục": "3 chục chai" → "30 chai"
const vnDigitChucRe = new RegExp(
  '(^|[\\s,;+])(\\d{1,3})\\s*(?:chục|chuc)(\\s+(?:' + unitAlt + ')' + ubnd + ')',
  'gi'
);

/**
 * Chuẩn hóa số lượng viết bằng chữ tiếng Việt thành chữ số.
 * Hiểu số ĐƠN (một…mười) và số GHÉP (hai mươi, ba mươi lăm, năm chục,
 * một trăm hai mươi lăm…) — chỉ khi ngay sau là đơn vị hàng hóa.
 */
function normalizeVietnameseQty(str) {
  let s = String(str || '');
  s = s.replace(vnDigitChucRe, (m, pre, n, unit) => pre + (parseInt(n, 10) * 10) + unit);
  s = s.replace(vnSeqRe, (m, pre, seq, unit) => {
    const n = vnWordSeqToNumber(seq.toLowerCase().split(/\s+/));
    return n != null ? pre + n + unit : m;
  });
  return s;
}

/**
 * Parses the raw order text line-by-line.
 */
function parseOrderText(text, allProducts, aliases) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const results = [];

  // Kiểu "số trước – tên sau" (ưu tiên). Lưu ý: chỉ bóc dấu đầu dòng (bullet
  // như -, *, •, + hoặc số thứ tự "1." / "2)"), KHÔNG ăn số lượng thật.
  // (Sửa lỗi cũ: [0-9] trong lớp đầu làm "10 thùng" bị bắt thành qty=0)
  // "tặng thêm/kèm (theo)" — chữ "thêm" chen giữa keyword và số lượng không được
  // làm gãy pattern (bug thật 04/9: "tặng thêm 6 chai Veltron..." không khớp).
  const giftFiller = '(?:\\s*(?:thêm|them|kèm|kem)(?:\\s*theo)?)?';
  const qtyPatternStart = new RegExp('^[-*•+\\s]*(?:\\d+[.)]\\s+)?(?:tặng|tang|foc|free)?' + giftFiller + '\\s*(\\d+)\\s*(' + unitAlt + ')' + ubnd, 'i');
  // Kiểu "tên trước – số sau" (mới): bắt cụm số+đơn vị ở CUỐI chuỗi
  const qtyPatternEnd = new RegExp('[\\sxX×]?(\\d+)\\s*(' + unitAlt + ')' + ubnd + '[\\s.,;!]*$', 'i');

  const paymentPatterns = [
    { pattern: /\btt\s*ck\b/i, value: 'ck', label: 'Chuyển khoản' },
    { pattern: /\bchuyển\s*khoản\b/i, value: 'ck', label: 'Chuyển khoản' },
    { pattern: /\bck\b/i, value: 'ck', label: 'Chuyển khoản' },
    { pattern: /\bcod\b/i, value: 'cod', label: 'COD' },
    { pattern: /\bcông\s*nợ\b/i, value: 'congno', label: 'Công nợ' },
    { pattern: /\btiền\s*mặt\b/i, value: 'tt', label: 'Tiền mặt' },
    { pattern: /\btt\b/i, value: 'tt', label: 'Thanh toán trực tiếp' },
  ];

  // Có cụm số+đơn vị (đầu hoặc cuối dòng) → coi là dòng sản phẩm
  function hasQtyToken(str) {
    return qtyPatternStart.test(str) || qtyPatternEnd.test(str);
  }

  // Cụm số+đơn vị ở BẤT KỲ vị trí nào trong dòng — dùng để chặn nhánh payment
  // nuốt cả dòng sản phẩm viết kèm mã thanh toán cuối dòng
  // (vd: "An Nam 10 thùng X giá 85k 20 thùng Y giá 51k TT CN").
  const qtyPatternAny = new RegExp('\\d+\\s*(?:' + unitAlt + ')' + ubnd, 'i');

  // Tách tên khách từ tiền tố tường minh (KH:, Khách:, Customer:)
  function extractCustomerPrefix(str) {
    const m = str.match(/^\s*(?:kh|khách|khach|customer|khách\s*hàng|khach\s*hang)\s*[:\-]\s*(.+)$/i);
    return m ? m[1].trim() : null;
  }

  // Parse một đoạn thành 1 item sản phẩm; trả null nếu không bắt được số+đơn vị
  function parseSegment(segment) {
    if (!segment) return null;
    let qty, unit, rawProduct;
    const mStart = segment.match(qtyPatternStart);
    if (mStart) {
      qty = parseInt(mStart[1]);
      unit = normalizeUnit(mStart[2]);
      rawProduct = segment.substring(mStart[0].length).trim();
    } else {
      const mEnd = segment.match(qtyPatternEnd);
      if (!mEnd) return null;
      qty = parseInt(mEnd[1]);
      unit = normalizeUnit(mEnd[2]);
      rawProduct = segment.substring(0, mEnd.index).trim();
      // Bỏ 'x' còn sót từ kiểu "x2"
      rawProduct = rawProduct.replace(/[x×]\s*$/i, '').trim();
    }

    let cleanedProduct = rawProduct;
    let explicitPrice = undefined;
    let explicitGift = undefined;
    let priceTierQty = undefined;

    // 0. Tier override: "giá 2 thùng" (áp mốc 2 thùng) HOẶC "giá thùng" (mua lẻ tính giá thùng → áp mốc 1 thùng)
    //    Phải bắt TRƯỚC priceRegex để tránh bị hiểu nhầm thành giá tường minh 2000đ.
    const tierOverrideRegex = /(?:giá|gia|price|áp\s*giá|ap\s*gia)\s*:?\s*(\d+)?\s*(?:thùng|thg|thung|carton|ctn|box)\b/i;
    const tierMatch = cleanedProduct.match(tierOverrideRegex);
    if (tierMatch) {
      priceTierQty = tierMatch[1] ? parseInt(tierMatch[1], 10) : 1;
      cleanedProduct = cleanedProduct.replace(tierMatch[0], '');
    }

    // 0.5. Giá theo "triệu": "12tr1" = 12.100.000đ, "12tr" = 12.000.000đ, "1tr5" = 1.500.000đ
    //      Chữ số sau "tr" là phần trăm nghìn (1 = 100.000). Chỉ áp khi chưa có giá (không đè giá quà tặng).
    if (explicitPrice === undefined) {
      const trPriceRegex = /(\d+(?:[.,]\d+)?)\s*(?:triệu|trieu|tr)(\d)?(?![a-zà-ỹ])/i;
      const trMatch = cleanedProduct.match(trPriceRegex);
      if (trMatch) {
        const mainVal = parseFloat(trMatch[1].replace(',', '.'));
        const subVal = trMatch[2] ? parseInt(trMatch[2]) : 0;
        explicitPrice = mainVal * 1000000 + subVal * 100000;
        cleanedProduct = cleanedProduct.replace(trMatch[0], '');
      }
    }

    // 1. Giá tường minh
    const priceRegex = /(?:(?:giá|gia|price)\s*:?\s*(\d+(?:\.\d+)?)\s*(k|K|đ|d|đ\b|d\b)?(?:\/(chai|lon|can|thùng|thg|thung|carton|ctn|box|bottle|btl))?)|(?:\b(\d+(?:\.\d+)?)\s*(k|K)\b(?:\/(chai|lon|can|thùng|thg|thung|carton|ctn|box|bottle|btl))?)/i;
    const priceMatch = cleanedProduct.match(priceRegex);
    if (priceMatch) {
      const valStr = priceMatch[1] || priceMatch[4];
      const unitIndicator = priceMatch[2] || priceMatch[5] || '';
      let val = parseFloat(valStr);
      if (unitIndicator.toLowerCase() === 'k') {
        val = val * 1000;
      } else if (val < 1000) {
        val = val * 1000;
      }
      explicitPrice = val;
      cleanedProduct = cleanedProduct.replace(priceMatch[0], '');
    }

    // 2. Quà tường minh (harden ReDoS). "tặng thêm/kèm (theo)" phải khớp được (giftFiller).
    const giftRegex = new RegExp('(?:tặng|tang)' + giftFiller + '\\s*(\\d+)\\s*([^;:\\n.,]+)', 'i');
    const giftMatch = cleanedProduct.match(giftRegex);
    if (giftMatch) {
      const giftQty = parseInt(giftMatch[1]);
      const rawGiftProduct = giftMatch[2].trim();
      let giftName = rawGiftProduct.replace(/[.,;:!\-\s]+$/, '').trim();
      let giftUnit = 'cái';
      // Đơn vị đứng ĐẦU tên quà ("6 chai Veltron X") là đơn vị đếm — bóc ra khỏi tên
      // để match SP quà không mang từ "chai" thừa (check includes bên dưới vẫn chạy sau).
      const leadUnit = giftName.match(/^(chai|lon|can|tuýp|tuyp|bình|binh|thùng|thung|phuy|hộp|hop|cái|cai|áo|ao|nón|non|túi|tui)\s+/i);
      if (leadUnit) {
        giftUnit = normalizeUnit(leadUnit[1]) || leadUnit[1].toLowerCase();
        giftName = giftName.slice(leadUnit[0].length).trim();
      }
      const giftNameLower = giftName.toLowerCase();
      if (giftNameLower.includes('lon')) giftUnit = 'lon';
      else if (giftNameLower.includes('chai')) giftUnit = 'chai';
      else if (giftNameLower.includes('can')) giftUnit = 'can';
      else if (giftNameLower.includes('tuyp') || giftNameLower.includes('tuýp')) giftUnit = 'tuýp';
      else if (giftNameLower.includes('ao') || giftNameLower.includes('áo')) giftUnit = 'áo';
      else if (giftNameLower.includes('non') || giftNameLower.includes('nón')) giftUnit = 'nón';
      explicitGift = { qty: giftQty, name: giftName, unit: giftUnit };
      cleanedProduct = cleanedProduct.replace(giftMatch[0], '');
    }

    // Dọn dấu phân cách thừa
    cleanedProduct = cleanedProduct.replace(/^[:\s,.\-]+|[:\s,.\-]+$/g, '').trim();

    // Standalone FOC/free/gift — chỉ áp khi KHÔNG có quà tường minh (explicitGift):
    // "tặng" trong segment khi đó là marker quà của SP kia, SP chính vẫn trả tiền tier.
    if (!explicitGift && /\b(?:foc|tặng|tang|quà|qua|free)\b/i.test(segment)) {
      explicitPrice = 0;
    }

    const isGift = !explicitGift && /\b(?:foc|tặng|tang|quà|qua|free)\b/i.test(segment);
    const match = findBestProductMatch(cleanedProduct, allProducts, aliases, unit, isGift ? 0 : explicitPrice);
    return {
      qty,
      unit,
      rawProduct: cleanedProduct || rawProduct,
      matchedProduct: match ? match.product : null,
      matchScore: match ? match.score : 0,
      explicitPrice: isGift ? 0 : explicitPrice,
      priceTierQty,
      explicitGift,
      isGift
    };
  }

  let customerDetected = null;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Security check: Mitigate ReDoS by truncating extremely long lines
    if (line.length > 300) {
      line = line.substring(0, 300);
    }

    // Chuẩn hóa số đếm tiếng Việt → chữ số (một phuy → 1 phuy)
    line = normalizeVietnameseQty(line);

    // Gỡ ký tự rác giữa số lượng và đơn vị ("1' thùng" → "1 thùng") TRƯỚC mọi
    // pattern qty — không thì dòng bị coi là dòng lạ và trôi vào ghi chú.
    line = stripQtyJunk(line);

    // Khách hàng theo tiền tố tường minh (bất kỳ dòng nào)
    const custPrefix = extractCustomerPrefix(line);
    if (custPrefix && !hasQtyToken(line)) {
      results.push({ raw: line, type: 'customer', data: { name: custPrefix } });
      if (!customerDetected) customerDetected = custPrefix;
      continue;
    }

    // Payment: khớp từ khóa an toàn VÀ dòng KHÔNG chứa số+đơn vị ở bất kỳ đâu
    // (dòng có qty là dòng sản phẩm, dù qty nằm giữa dòng hay đuôi có TT/CK)
    let isPayment = false;
    if (!qtyPatternAny.test(line)) {
      for (const pp of paymentPatterns) {
        if (pp.pattern.test(line)) {
          results.push({ raw: line, type: 'payment', data: { value: pp.value, label: pp.label } });
          isPayment = true;
          break;
        }
      }
    }
    if (isPayment) continue;

    // Dòng mốc giá đứng riêng ("Giá 2 thùng", "giá thùng") → tier-override áp
    // TOÀN ĐƠN, KHÔNG phải dòng hàng (tránh match nhầm thành item 0đ như
    // "Poster Pricelist"). Dòng ghép trên dòng SP xử lý ở parseSegment như cũ.
    if (isStandaloneTierLine(line)) {
      results.push({
        raw: line,
        type: 'tier-override',
        data: { priceTierQty: standaloneTierQty(line) }
      });
      continue;
    }

    // Thử tách nhiều SP trên một dòng (ngăn cách bằng , ; hoặc " + ")
    const segments = line.split(/\s*[;,]\s*|\s+\+\s+/).map(s => s.trim()).filter(Boolean);
    if (segments.length > 1) {
      const parsedSegs = [];
      for (const seg of segments) {
        const d = parseSegment(seg);
        if (d) parsedSegs.push({ seg, data: d });
      }
      if (parsedSegs.length >= 2) {
        for (const ps of parsedSegs) {
          results.push({ raw: ps.seg, type: ps.data.matchedProduct ? 'matched' : 'unmatched', data: ps.data });
        }
        continue;
      }
    }

    // Nhiều SP trên cùng dòng KHÔNG dấu ngăn cách (vd: "Hoàng Long 10 thùng A
    // giá 85k/chai 20 thùng B giá 51k/chai TT CN"): tách tại mỗi cụm số+đơn vị.
    // Cụm số+đơn vị đứng ngay sau tặng/foc/free/giá là quà kèm hoặc mốc giá gắn
    // theo SP trước nó → không được coi là ranh giới.
    const qtyBounds = (() => {
      const re = new RegExp('(\\d+)\\s*(' + unitAlt + ')' + ubnd, 'gi');
      const arr = [];
      let mm;
      while ((mm = re.exec(line)) !== null) {
        // Cửa sổ 20 ký tự đủ chứa "tặng kèm theo " (giftFiller ở trên)
        const before = line.substring(Math.max(0, mm.index - 20), mm.index);
        if (new RegExp('(?:tặng|tang|foc|free|giá|gia|price)' + giftFiller + '\\s*:?\\s*$', 'i').test(before)) continue;
        arr.push(mm.index);
      }
      return arr;
    })();
    if (qtyBounds.length >= 2) {
      const parts = [];
      let splitOk = true;
      for (let b = 0; b < qtyBounds.length; b++) {
        const start = qtyBounds[b];
        const end = b + 1 < qtyBounds.length ? qtyBounds[b + 1] : line.length;
        // Bỏ mã thanh toán đuôi dòng (TT CN / CK / COD...) khỏi tên SP
        let partText = line.substring(start, end).trim()
          .replace(/(?:\s+(?:tt|ck|cod|cn)(?![a-z0-9à-ỹ]))+\s*$/i, '')
          .trim();
        const d = partText ? parseSegment(partText) : null;
        // Đoạn phải còn TÊN SP thật sau khi bóc qty/giá — chặn mảnh rác như
        // "giá 50k" (parseSegment fallback trả lại raw text khi tên sạch rỗng,
        // tức mảnh này chỉ là đuôi giá/dung tích của SP trước nó)
        const nameWords = String((d && d.rawProduct) || '')
          .replace(/(?:giá|gia|price)\s*:?\s*[\d.,]+\s*(?:k|tr\d*)?\s*(?:\/\s*[a-zà-ỹ]+)?/gi, ' ')
          .split(/[^a-zà-ỹ0-9]+/i)
          .filter(w => /[a-zà-ỹ]/i.test(w) && !/^(gia|price|tang|tặng|foc|free)$/i.test(w));
        if (!d || nameWords.length === 0) { splitOk = false; break; }
        parts.push({ prefix: b === 0 ? line.substring(0, start).trim() : '', data: d });
      }
      if (splitOk && parts.length >= 2) {
        const prefix = parts[0].prefix;
        // Tiền tố trông giống tên khách → đẩy thành customer (ngữ pháp như
        // nhánh mid-line bên dưới)
        const isNameLike = prefix && /[a-zà-ỹ]/i.test(prefix) && !/^\d/.test(prefix)
          && !/(?:giá|gia|price|foc|tặng|tang|free)(?=\s|$)/i.test(prefix);
        if (isNameLike) {
          results.push({ raw: prefix, type: 'customer', data: { name: prefix } });
          if (!customerDetected) customerDetected = prefix;
        }
        for (const p of parts) {
          results.push({ raw: p.data.rawProduct, type: p.data.matchedProduct ? 'matched' : 'unmatched', data: p.data });
        }
        continue;
      }
    }

    // Dòng đơn: parse toàn bộ (giữ nguyên hành vi cũ, bao gồm quà gắn theo SP)
    const single = parseSegment(line);
    if (single) {
      results.push({ raw: line, type: single.matchedProduct ? 'matched' : 'unmatched', data: single });
    } else {
      // Fallback: qty+unit nằm GIỮA dòng (vd: "Vĩnh Khang 2 phuy CI 20W50")
      // Tách tiền tố (tên khách) và phần sản phẩm bắt đầu từ số+đơn vị.
      const midQtyRegex = new RegExp('(\\d+)\\s*(' + unitAlt + ')' + ubnd, 'i');
      const midMatch = line.match(midQtyRegex);
      if (midMatch && midMatch.index > 0) {
        let prefix = line.substring(0, midMatch.index).trim();
        const productPart = line.substring(midMatch.index).trim();
        // Tiền tố tàn bằng MARKER QUÀ ("tặng thêm 6 chai X") → bóc marker, đánh dấu
        // dòng là hàng tặng. Trước đây marker bị vứt im lặng → quà thành dòng trả tiền.
        // Phần tiền tố còn lại (nếu có) vẫn là tên khách ("Nam Thành tặng thêm 6 chai X").
        const giftPrefixMatch = prefix.match(/(?:foc|tặng|tang|free|quà|qua|km)(?:\s*(?:thêm|them|kèm|kem)(?:\s*theo)?)?\s*:?\s*$/i);
        const prefixIsGift = !!giftPrefixMatch;
        if (prefixIsGift) {
          prefix = prefix.substring(0, giftPrefixMatch.index).replace(/[\s:,\-]+$/, '').trim();
        }
        const parsed = parseSegment(productPart);
        if (parsed) {
          if (prefixIsGift) {
            parsed.isGift = true;
            parsed.explicitPrice = 0;
          }
          // Tiền tố trông giống tên khách (có chữ, không phải giá/keyword)
          // NOTE: không dùng \b vì JS regex \b không nhận ký tự có dấu (á, ặ, ơ...)
          // là word char → \b fail sau "giá", "tặng". Dùng (?=\s|$) thay thế.
          const isNameLike = prefix && /[a-zà-ỹ]/i.test(prefix) && !/^\d/.test(prefix)
            && !/(?:giá|gia|price|foc|tặng|tang|free)(?=\s|$)/i.test(prefix);
          if (isNameLike) {
            results.push({ raw: prefix, type: 'customer', data: { name: prefix } });
            if (!customerDetected) customerDetected = prefix;
          }
          results.push({ raw: productPart, type: parsed.matchedProduct ? 'matched' : 'unmatched', data: parsed });
          continue;
        }
      }
      // Vẫn không parse được → fallback cũ
      // Tên khách CÓ THỂ bắt đầu bằng số ("7C motor", "3S shop") — chấp nhận khi
      // dòng có cụm ≥2 chữ cái và KHÔNG giống mảnh số lượng/giá ("2 chai", "228k").
      // ── Lưới an toàn cuối: dòng vẫn chứa cụm số + từ đơn vị (ký tự lạ nào đó
      // làm gãy pattern) → đẩy thành dòng UNMATCHED thay vì nuốt lặng lẽ vào
      // ghi chú — bug thật 09/25: "1' thùng Chain Lube Offroad" biến mất khỏi đơn.
      const residualQtyRe = new RegExp('\\d+\\s*[^a-z0-9à-ỹ\\s]{0,2}\\s*(' + unitAlt + ')' + ubnd, 'i');
      const resMatch = line.match(residualQtyRe);
      if (resMatch) {
        const qm = line.match(/\d+/);
        results.push({
          raw: line,
          type: 'unmatched',
          data: {
            qty: qm ? parseInt(qm[0], 10) : 0,
            unit: normalizeUnit(resMatch[1]),
            rawProduct: line.trim(),
            matchedProduct: null,
            matchScore: 0,
            explicitPrice: undefined,
            priceTierQty: undefined,
            explicitGift: undefined,
            isGift: false
          }
        });
        continue;
      }
      const startsWithQtyUnit = new RegExp('^\\d+\\s*(' + unitAlt + ')' + ubnd, 'i').test(line);
      const startsWithPrice = /^\d+(?:[.,]\d+)?\s*(?:k|K|tr|Tr)\b/.test(line);
      if (i === 0 && /(?:[a-zà-ỹ]{2})/i.test(line) && !startsWithQtyUnit && !startsWithPrice) {
        // Dòng đầu không phải SP/thanh toán và có chữ → coi là tên khách
        results.push({ raw: line, type: 'customer', data: { name: line } });
        if (!customerDetected) customerDetected = line;
      } else {
        // ── Dòng tiếp theo của TÊN SP bị xuống dòng (bug thật 24/9/2026):
        //    "2 thùng chain lube" + "off road zentor" — vế sau không có qty
        //    → rơi vào ghi chú, SP khớp nhầm bản trắng. Merge khi MỌI từ có
        //    nghĩa của dòng nằm trong TÊN SP mà merged text match được (từ vựng
        //    sản phẩm); câu ghi chú thật ("Ghi chú thêm gì đó") không có từ
        //    nào thuộc tên SP → giữ nguyên thành ignored/ghi chú.
        const prevRes = results[results.length - 1];
        if (prevRes && (prevRes.type === 'matched' || prevRes.type === 'unmatched') && prevRes.data) {
          const mergedRaw = String(prevRes.raw) + ' ' + line;
          const merged = parseSegment(mergedRaw);
          if (merged && merged.matchedProduct) {
            const lineWords = normalizeText(line).split(/\s+/).filter(w => w.length >= 3);
            const prodNameNorm = normalizeText(merged.matchedProduct.name);
            if (lineWords.length > 0 && lineWords.every(w => prodNameNorm.includes(w))) {
              results[results.length - 1] = { raw: mergedRaw, type: 'matched', data: merged };
              continue;
            }
          }
        }
        results.push({ raw: line, type: 'ignored', data: null });
      }
    }
  }
  return { lines: results, customerDetected };
}

/**
 * Flexible search scoring:
 * - Tier 1 (100+): full query is a contiguous substring of haystack
 * - Tier 2 (50+): every space-separated token of query is a contiguous
 *   substring of haystack (order-independent, cross-word)
 * Returns 0 if no match.
 */
function fuzzySearchScore(normQuery, normHaystack) {
  if (!normQuery) return 1; // empty query = show all
  if (!normHaystack) return 0;

  // Tier 1: full contiguous substring (current behavior, highest priority)
  if (normHaystack.includes(normQuery)) {
    const idx = normHaystack.indexOf(normQuery);
    const atWordStart = idx === 0 || normHaystack[idx - 1] === ' ';
    return 100 + (atWordStart ? 20 : 0);
  }

  // Tier 2: all tokens found as contiguous substrings (any word, any order)
  const tokens = normQuery.split(/\s+/).filter(Boolean);
  if (tokens.length > 1) {
    for (const t of tokens) {
      if (!normHaystack.includes(t)) return 0;
    }
    // All tokens matched - score by word-start quality
    const hayTokens = normHaystack.split(/\s+/);
    let score = 50;
    for (const t of tokens) {
      if (hayTokens.some(ht => ht.startsWith(t))) score += 5;
    }
    return score;
  }

  return 0;
}

if (typeof window !== 'undefined') {
  window.normalizeText = normalizeText;
  window.normalizeUnit = normalizeUnit;
  window.levenshtein = levenshtein;
  window.calculateMatchScore = calculateMatchScore;
  window.findBestProductMatch = findBestProductMatch;
  window.findTopProductMatches = findTopProductMatches;
  window.buildShortlist = buildShortlist;
  window.parseOrderText = parseOrderText;
  window.fuzzySearchScore = fuzzySearchScore;
  window.hasAttributeConflict = hasAttributeConflict;
  window.hasUnitConflict = hasUnitConflict;
  window.applySynonyms = applySynonyms;
  window.normalizeFull = normalizeFull;
}
if (typeof self !== 'undefined') {
  self.normalizeText = normalizeText;
  self.normalizeBrand = normalizeBrand;
  self.normalizeUnit = normalizeUnit;
  self.levenshtein = levenshtein;
  self.calculateMatchScore = calculateMatchScore;
  self.findBestProductMatch = findBestProductMatch;
  self.findTopProductMatches = findTopProductMatches;
  self.buildShortlist = buildShortlist;
  self.parseOrderText = parseOrderText;
  self.fuzzySearchScore = fuzzySearchScore;
  self.hasAttributeConflict = hasAttributeConflict;
  self.hasUnitConflict = hasUnitConflict;
  self.applySynonyms = applySynonyms;
  self.normalizeFull = normalizeFull;
}
// ES module exports (used by Vite/bundler imports in src/ and Node require(esm) in tests)
export { normalizeText, normalizeBrand, normalizeUnit, levenshtein, calculateMatchScore, findBestProductMatch, priceHintMatches, findTopProductMatches, buildShortlist, parseOrderText, fuzzySearchScore, extractViscosity, extractVolume, detectSizeToken, hasAttributeConflict, hasUnitConflict, applySynonyms, normalizeFull, normalizeVietnameseQty, stripQtyJunk, isStandaloneTierLine, standaloneTierQty };


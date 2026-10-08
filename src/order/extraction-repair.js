// =========================================================================
//  EXTRACTION REPAIR (src/order/extraction-repair.js)
//  Tự phát hiện lỗi trích xuất của AI và tự vá bằng 1 call AI bổ sung:
//    (1) Dòng sản phẩm bị AI BỎ SÓT (không item nào cover)
//    (2) Dòng bị AI GỘP chung vào 1 item (item cover chữ nhưng LỆCH qty
//        so với dòng) → gỡ item gộp, trích xuất lại từng dòng riêng.
//
//  Module thuần: KHÔNG DOM, KHÔNG phụ thuộc ai-service.js (tránh chuỗi
//  import kéo ui-renderer vào môi trường test Node).
// =========================================================================

import { normalizeVietnameseQty, stripQtyJunk, isStandaloneTierLine } from '../../parser.js';

// Danh sách đơn vị — đồng bộ với countQtyLines trong ai-service.js
const UNIT_ALT = 'thùng|thg|thung|carton|ctn|box|chai|lon|can|bottle|btl|phuy|phụy|drum|bộ|bo|lít|lit|hộp|hop|xô|xo|pail|bucket|bình|binh|pcs|cái|cai|cây|cay|kg|túi|tui|áo|ao|cuốn|cuon|tuýp|tuyp';
const QTY_LINE_RE = new RegExp('\\d+\\s*(?:' + UNIT_ALT + ')', 'i');
// Bắt số lượng đầu dòng (VD: "10 thùng ..." → 10)
const QTY_CAPTURE_RE = new RegExp('(\\d+)\\s*(?:' + UNIT_ALT + ')', 'i');
// Từ đơn vị đứng MỘT MÌNH (không kèm số) — VD "giá 85k/chai": 'chai' đi sau
// giá chỉ mô tả quy cách báo giá, KHÔNG phải từ khóa sản phẩm.
const LONE_UNIT_RE = new RegExp('\\b(?:' + UNIT_ALT + ')\\b', 'gi');

// Từ vô nghĩa khi so khớp dòng (quà tặng, khuyến mãi, giá cả, mã thanh toán
// cuối đơn như "TT CN" = thanh toán công nợ...)
const STOP_WORDS = new Set([
  'tang', 'tâng', 'foc', 'qua', 'qta', 'km', 'khuyenmai', 'khuyen', 'mai', 'gia', 'price',
  'tt', 'ck', 'cn', 'cod',
]);

// Cụm số+đơn vị đứng ngay SAU tặng/foc/giá là quà kèm theo hoặc mốc giá
// ("3 thùng X tặng 2 chai Y", "1 lít giá 2 thùng") — KHÔNG phải ranh giới
// giữa 2 sản phẩm trên cùng dòng. Chấp nhận "tặng thêm/kèm (theo)" — chữ
// "thêm" chen giữa không được làm mất tính marker.
const GIFT_PRICE_BEFORE_RE = /(?:tặng|tang|foc|free|giá|gia|price)(?:\s*(?:thêm|them|kèm|kem)(?:\s*theo)?)?\s*:?\s*$/i;

/** Chuẩn hoá text: lowercase, bỏ dấu tiếng Việt, đ→d. */
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd');
}

/** Một dòng được coi là "dòng sản phẩm" nếu có pattern số-lượng + đơn vị. */
export function isQtyLine(line) {
  if (!line) return false;
  // Gỡ ký tự rác giữa số lượng và đơn vị ("1' thùng" → "1 thùng") — đồng bộ
  // với parseOrderText (bug thật 09/25: dòng dính dấu nháy không được cứu).
  return QTY_LINE_RE.test(stripQtyJunk(line));
}

/**
 * Lấy "chữ ký" của một dòng: các từ đặc trưng sản phẩm (bỏ số lượng, đơn vị,
 * giá, stopwords). VD: '1 thùng fast 4T 1L giá 158k' → ['fast', '4t', '1l'].
 */
function extractSignatureWords(line) {
  const unitRe = new RegExp('\\d+\\s*(?:' + UNIT_ALT + ')', 'gi');
  let cleaned = norm(line).replace(unitRe, ' ');
  // Bỏ giá dạng 158k / 1.2tr / 12tr3
  cleaned = cleaned.replace(/\b\d+(?:[.,]\d+)?(?:k|tr\d?)?\b/g, ' ');
  // Bỏ từ đơn vị đứng MỘT MÌNH (thường đi sau giá: "85k/chai") — không phải
  // từ khóa sản phẩm; đơn vị CÓ số đã bị unitRe ở trên xử lý.
  cleaned = cleaned.replace(LONE_UNIT_RE, ' ');
  return cleaned
    .split(/[^a-z0-9]+/)
    .filter(w => w.length >= 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
}

/** Số lượng khai trong dòng (cặp số + đơn vị đầu tiên). VD "10 thùng..." → 10 */
function parseLineQty(line) {
  const m = stripQtyJunk(String(line || '')).match(QTY_CAPTURE_RE);
  return m ? parseInt(m[1], 10) : null;
}

/** Index TỪNG item riêng — để biết item nào cover dòng nào (phục vụ chống gộp). */
function buildPerItemIndex(items) {
  const perItem = [];
  (items || []).forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const parts = [];
    if (item.rawProduct) parts.push(norm(item.rawProduct));
    if (item.rawName) parts.push(norm(item.rawName));
    if (item.explicitGift && item.explicitGift.name) parts.push(norm(item.explicitGift.name));
    const bigNorm = parts.join(' | ');
    const wordSet = new Set(bigNorm.split(/[^a-z0-9]+/).filter(Boolean));
    perItem.push({ index, item, bigNorm, wordSet });
  });
  return perItem;
}

/** Dòng được "cover" nếu mọi từ chữ ký xuất hiện trong index items. */
function isCovered(sigWords, index) {
  if (!sigWords.length) return true; // dòng chỉ toàn số/giá → coi như đã xử lý
  return sigWords.every(w => index.wordSet.has(w) || index.bigNorm.includes(w));
}

/** Danh sách dòng có số lượng trong tin nhắn. Chuẩn hóa số-chữ ("hai mươi
 *  thùng" → "20 thùng") TRƯỚC khi lọc để tầng repair đọc được đơn sales
 *  ghi số lượng bằng chữ. */
function qtyLinesOf(rawText) {
  return String(rawText || '').split('\n')
    .map(l => stripQtyJunk(normalizeVietnameseQty(l.trim())))
    .filter(Boolean)
    // Dòng mốc giá đứng riêng ("Giá 2 thùng") là chỉ định giá TOÀN ĐƠN, không
    // phải dòng sản phẩm thiếu — nếu để lọt, repair sẽ tự vá thành item "Giá" ma.
    .filter(l => !isStandaloneTierLine(l))
    .filter(l => isQtyLine(l));
}

/**
 * Tách MỘT dòng thành các ĐOẠN sản phẩm tại mỗi cụm số+đơn vị — phục vụ đơn
 * viết nhiều SP trên CÙNG 1 dòng không dấu ngăn cách:
 *   "Hoàng Long 10 thùng A giá 85k/chai 20 thùng B giá 51k/chai TT CN"
 *   → [{prefix:'Hoàng Long', text:'10 thùng A giá 85k/chai'},
 *      {prefix:'',          text:'20 thùng B giá 51k/chai TT CN'}]
 * Cụm số+đơn vị đứng sau tặng/foc/giá (quà kèm, mốc giá) không được coi là
 * ranh giới. Nếu dòng chỉ có 1 cụm → trả nguyên dòng (giữ hành vi cũ).
 *
 * @returns {Array<{prefix: string, text: string}>}
 */
export function splitQtySegments(line) {
  const s = stripQtyJunk(String(line || ''));
  const tokenRe = new RegExp('\\d+\\s*(?:' + UNIT_ALT + ')', 'gi');
  const bounds = [];
  let m;
  while ((m = tokenRe.exec(s)) !== null) {
    const before = s.substring(Math.max(0, m.index - 14), m.index);
    if (GIFT_PRICE_BEFORE_RE.test(before)) continue;
    bounds.push(m.index);
  }
  if (bounds.length === 0) {
    return (!isStandaloneTierLine(s) && isQtyLine(s)) ? [{ prefix: '', text: s }] : [];
  }
  return bounds.map((start, i) => ({
    prefix: i === 0 ? s.substring(0, start).trim() : '',
    text: s.substring(start, i + 1 < bounds.length ? bounds[i + 1] : s.length).trim(),
  }));
}

/**
 * Phân tích toàn diện kết quả trích xuất so với tin nhắn gốc:
 *  - missing:  dòng qty KHÔNG item nào cover → AI bỏ sót.
 *  - suspects: dòng được item cover CHỮ nhưng LỆCH qty → nghi AI gộp nhiều
 *    dòng vào 1 item (kèm danh sách mọi dòng item đó cover để trích xuất lại).
 * Gift items không bị nghi gộp (quà có ngữ cảnh xử lý riêng).
 *
 * @param {string} rawText - tin nhắn gốc của Sales
 * @param {Array} items - parsedJson.items sau sanitize
 * @returns {{missing: string[], suspects: Array<{itemIndex: number, lines: string[], coveredLines: string[]}>}}
 */
export function analyzeExtraction(rawText, items) {
  const result = { missing: [], suspects: [] };
  if (!rawText || !Array.isArray(items)) return result;

  const perItem = buildPerItemIndex(items);
  if (perItem.length === 0) {
    result.missing = qtyLinesOf(rawText);
    return result;
  }

  const tracked = new Map(); // itemIndex → {lines:Set, coveredLines:Set}

  // Duyệt theo ĐOẠN (không chỉ dòng) để xử lý được đơn viết nhiều SP trên
  // cùng 1 dòng — mỗi đoạn có qty + chữ ký riêng.
  const segments = qtyLinesOf(rawText).flatMap(line => {
    const segs = splitQtySegments(line);
    if (segs.length <= 1) return segs;
    // Dòng tách nhiều đoạn: bỏ đoạn KHÔNG có chữ ký (mảnh dung tích cuối tên
    // như "…vantol 5 lít giá 50k" → đoạn "5 lít giá 50k") — từ khóa của mảnh
    // này thuộc về SP đứng trước nó.
    return segs.filter(sg => extractSignatureWords(sg.text).length > 0);
  });

  for (const seg of segments) {
    const line = seg.text;
    const sigWords = extractSignatureWords(line);
    const lineQty = parseLineQty(line);
    const covering = perItem.filter(pi => isCovered(sigWords, pi));

    // KHÔNG item nào cover chữ → AI bỏ sót dòng này
    if (covering.length === 0) {
      result.missing.push(line);
      continue;
    }

    // Ghi nhận mọi dòng mỗi item cover — để nếu item bị nghi gộp, ta trích
    // xuất lại ĐỦ các dòng nó phụ trách (không làm mất dòng hợp lệ).
    for (const pi of covering) {
      if (!tracked.has(pi.index)) tracked.set(pi.index, { lines: new Set(), coveredLines: new Set() });
      tracked.get(pi.index).coveredLines.add(line);
    }

    // OK nếu có item KHỚP cả chữ lẫn qty (item quà không đối chiếu qty)
    if (covering.some(pi => pi.item.isGift || Number(pi.item.qty) === lineQty)) continue;

    // NGHI GỘP: mọi item cover chữ đều LỆCH qty → chọn item overlap nhiều từ
    // khóa nhất để quy trách nhiệm, yêu cầu trích xuất lại dòng này riêng.
    let best = covering[0];
    let bestOverlap = -1;
    for (const pi of covering) {
      const overlap = sigWords.filter(w => pi.wordSet.has(w)).length;
      if (overlap > bestOverlap) { bestOverlap = overlap; best = pi; }
    }
    tracked.get(best.index).lines.add(line);
  }

  for (const [itemIndex, t] of tracked.entries()) {
    if (t.lines.size > 0) {
      result.suspects.push({ itemIndex, lines: [...t.lines], coveredLines: [...t.coveredLines] });
    }
  }
  return result;
}

/**
 * Tìm các dòng qty trong rawText KHÔNG được cover bởi bất kỳ item nào
 * đã trích xuất → nghi ngờ bị AI bỏ sót.
 *
 * @param {string} rawText - tin nhắn gốc của Sales
 * @param {Array} items - parsedJson.items sau sanitize
 * @returns {string[]} danh sách dòng còn thiếu
 */
export function findMissingQtyLines(rawText, items) {
  return analyzeExtraction(rawText, items).missing;
}

/**
 * Prompt bổ sung: nhờ AI trích xuất riêng các dòng còn thiếu/bị gộp.
 * (System prompt gốc của callAI vẫn áp dụng — anti-gộp SKU, FOC, giá...)
 */
export function buildRepairPrompt(missingLines) {
  const lines = (missingLines || []).join('\n');
  return `Các dòng sau đây của đơn hàng CHƯA được trích xuất ĐÚNG ở lần trước (bị bỏ sót, hoặc bị gộp chung nhiều dòng thành 1 item). Trích xuất lại TẤT CẢ các dòng này thành items RIÊNG BIỆT — mỗi dòng 1 item, giữ đúng số lượng của từng dòng:\n${lines}`;
}

/**
 * Gộp kết quả repair vào items hiện có, chống trùng lặp
 * (cùng tên chuẩn-hoá + qty + unit → bỏ qua).
 */
export function mergeRepairedItems(items, repairedItems) {
  const keyOf = (it) => {
    const name = norm(it.rawProduct || it.rawName || '').split(/[^a-z0-9]+/).filter(Boolean).join(' ');
    return `${name}|${it.qty}|${it.unit || ''}`;
  };
  const seen = new Set((items || []).map(keyOf));
  const merged = [...(items || [])];
  for (const it of (repairedItems || [])) {
    if (!it || typeof it !== 'object') continue;
    const qty = Number(it.qty);
    if (!qty || qty <= 0 || !(it.rawProduct || it.rawName)) continue;
    const k = keyOf(it);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push({ ...it, qty });
  }
  return merged;
}

/**
 * Orchestrator: phát hiện dòng sót / dòng bị gộp → gọi AI trích xuất bổ sung
 * → merge. Item bị nghi gộp dòng sẽ bị GỠ và các dòng nó phụ trách được
 * trích xuất lại từng dòng riêng.
 *
 * @param {Function} aiCallFn - async (prompt) => parsedJsonObject (thường là aiService.callAI)
 * @param {object} parsedJson - kết quả parse lần đầu (bị mutate nếu vá được)
 * @param {string} rawText - tin nhắn gốc
 * @returns {{parsedJson: object, missing: string[], mergedLines: string[], added: Array}}
 */
export async function repairMissingExtraction(aiCallFn, parsedJson, rawText) {
  const empty = { parsedJson, missing: [], mergedLines: [], added: [] };
  if (!parsedJson || !Array.isArray(parsedJson.items) || typeof aiCallFn !== 'function') return empty;

  const { missing, suspects } = analyzeExtraction(rawText, parsedJson.items);
  if (!missing.length && !suspects.length) return empty;

  // Dòng cần trích xuất (lại): dòng thiếu + mọi dòng item-bị-nghi-gộp phụ trách
  const suspectIndexes = new Set(suspects.map(s => s.itemIndex));
  const linesToExtract = [...new Set([
    ...missing,
    ...suspects.flatMap(s => s.coveredLines),
  ])];
  const mergedLines = suspects.flatMap(s => s.lines);

  let repairedObj = null;
  try {
    repairedObj = await aiCallFn(buildRepairPrompt(linesToExtract));
  } catch (err) {
    console.warn(`[ExtractionRepair] Call AI bổ sung thất bại: ${err.message}`);
    return { parsedJson, missing, mergedLines, added: [] };
  }

  const repairedItems = repairedObj && Array.isArray(repairedObj.items) ? repairedObj.items : null;
  if (!repairedItems || !repairedItems.length) {
    console.warn(`[ExtractionRepair] Phát hiện ${linesToExtract.length} dòng cần trích xuất lại nhưng AI bổ sung không trả về items.`);
    return { parsedJson, missing, mergedLines, added: [] };
  }

  // Gỡ item bị nghi gộp dòng TRƯỚC khi merge (các dòng của nó đã được trích riêng)
  if (suspectIndexes.size > 0) {
    parsedJson.items = parsedJson.items.filter((_, i) => !suspectIndexes.has(i));
  }

  const before = parsedJson.items.length;
  parsedJson.items = mergeRepairedItems(parsedJson.items, repairedItems);
  const added = parsedJson.items.slice(before);

  // Re-check sau vá (chỉ log, không gọi AI tiếp để tránh vòng lặp chi phí)
  const stillMissing = findMissingQtyLines(rawText, parsedJson.items);
  if (stillMissing.length) {
    console.warn(`[ExtractionRepair] Vẫn còn ${stillMissing.length} dòng chưa cover sau khi vá: ${JSON.stringify(stillMissing)}`);
  }
  return { parsedJson, missing, mergedLines, added };
}

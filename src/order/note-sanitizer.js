// =========================================================================
//  NOTE SANITIZER — tách dòng FOC/quà tặng khỏi notes/TLN của AI
// =========================================================================
//  Vấn đề: AI đôi khi nhét NGUYÊN CÂU kiểu "FOC 2 cái áo mưa Zentor cho
//  Rửa xe AP" vào notes/TLN thay vì tách ra từng phần:
//    - Tên khách ("Rửa xe AP")      → trường customer
//    - Quà FOC ("2 cái áo mưa")     → item isGift để HỆ THỐNG tự xử lý
//  Sanitizer này chạy deterministic NGAY SAU khi AI trả JSON, không phụ
//  thuộc AI làm đúng — đảm bảo ghi chú lên Excel luôn được lọc sạch.
// =========================================================================

// Marker báo dòng quà tặng (chỉ xét khi marker nằm ĐẦU dòng, xem guard bên dưới)
const GIFT_MARKER_RE = /\b(f\.o\.c|foc|hàng tặng|hang tang|quà tặng|qua tang|tặng thêm|tang them|tặng|tang|khuyến mãi|khuyến mại|khuyen mai|km)\b/i;

// Số lượng + đơn vị (đơn vị dài đứng trước để tránh khớp nhầm)
const UNIT_ALT = 'thùng|thg|thung|carton|ctn|chai|lon|can|bottle|btl|phuy|phụy|drum|lít|lit|hộp|hop|xô|xo|pail|bucket|bình|binh|pcs|cái|cai|cây|cay|kg|túi|tui|cuốn|cuon|bộ|bo|áo|ao|tuýp|tuyp';
const QTY_UNIT_RE = new RegExp('(\\d+)\\s*(' + UNIT_ALT + ')\\b', 'i');

// Người nhận đứng cuối dòng sau chữ "cho": "FOC 2 áo mưa cho Rửa xe AP"
const RECEIVER_RE = /\s+cho\s+(.+)$/i;

// Tên khách là danh từ chung chung → không được dùng làm customer
const GENERIC_RECEIVER_RE = /\b(khách|khach|đơn hàng|don hang|hệ thống|he thong|nhà phân phối|nha phan phoi)\b/i;

/** Chuẩn hóa so sánh: lowercase + bỏ dấu + gộp khoảng trắng. */
function norm(s) {
  return (s || '').toString().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ').trim();
}

// Token "meta" không bao giờ là sản phẩm: hình thức thanh toán / yêu cầu hóa đơn.
// AI thỉnh thoảng vẫn ném các cụm này vào items (schema ép qty là NUMBER nên
// nó bịa luôn số lượng) → lọc deterministic, không phụ thuộc AI làm đúng.
// Form đã qua norm() (bỏ dấu, đ→d). Chỉ exact-match — không đụng item thật.
const META_TOKEN_ITEMS = new Set([
  'hd', 'hoa don', 'hoa don do', 'xuat hoa don', 'vat',
  'tt ck', 'ttck', 'ck', 'tt', 'chuyen khoan',
]);

function isMetaTokenItem(item) {
  const name = norm(item && (item.rawProduct || item.name || ''));
  return !!name && META_TOKEN_ITEMS.has(name);
}

/**
 * Phân tích 1 dòng ghi chú dạng quà tặng.
 * Chỉ nhận khi marker nằm ĐẦU dòng (hoặc sau tiền tố "TênKhách:" / "TênKhách -"),
 * để KHÔNG ăn nhầm dòng sản phẩm chính kèm quà ("3 thùng Fast tặng 2 lon").
 *
 * @returns { gift:{qty,unit,rawProduct}, receiver:string|null, cleanLine:string } | null
 */
function parseGiftLine(line) {
  const text = String(line || '').trim();
  if (!text) return null;

  const marker = text.match(GIFT_MARKER_RE);
  if (!marker) return null;

  const prefix = text.slice(0, marker.index).trim();
  let receiver = null;

  if (marker.index !== 0) {
    // Cho phép tiền tố dạng "Rửa xe AP:" / "Rửa xe AP -" (tên khách + dấu tách)
    const sep = prefix.match(/[:\-–—]\s*$/);
    if (!sep) return null;
    receiver = prefix.replace(/[:\-–—]\s*$/, '').trim() || null;
  }

  // Số lượng + đơn vị phải nằm SAU marker
  const after = text.slice(marker.index);
  const qtyMatch = after.match(QTY_UNIT_RE);
  if (!qtyMatch) return null;

  const qty = parseInt(qtyMatch[1], 10);
  let unit = qtyMatch[2].toLowerCase();
  let rest = after.slice(qtyMatch.index + qtyMatch[0].length);

  // Tách người nhận cuối dòng: "...cho Rửa xe AP"
  const recv = rest.match(RECEIVER_RE);
  if (recv) {
    receiver = receiver || recv[1].trim();
    rest = rest.slice(0, recv.index);
  }

  // Vệ sinh tên sản phẩm tặng
  let rawProduct = rest
    .replace(/^[\s:=–—-]+/, '')
    .replace(/[.,;:!\-–—\s]+$/, '')
    .replace(/\s+(nhé|nha|nhe|ạ|ah|ak|ok)\s*$/i, '')
    .trim();

  // "2 áo mưa" → unit "áo" + product "mưa" (sai) → gộp lại thành "áo mưa", đơn vị "cái"
  if (/^á?o$/.test(unit) || /^ao$/.test(unit)) {
    rawProduct = `áo ${rawProduct}`.replace(/\s+/g, ' ').trim();
    unit = 'cái';
  }

  if (!rawProduct || rawProduct.length < 2) return null;

  return {
    gift: { qty, unit, rawProduct },
    receiver: receiver || null,
    cleanLine: `FOC ${qty} ${unit} ${rawProduct}`
  };
}

/** Cộng dồn số lượng nếu quà đã có trong items, ngược lại thêm item isGift mới. */
function registerGift(parsedJson, gift) {
  const p = norm(gift.rawProduct);
  const overlaps = (q) => q.length >= 3 && p.length >= 3 && (q.includes(p) || p.includes(q));
  const items = parsedJson.items || [];
  const existing = items.find(it => {
    if (!it || !it.isGift) return false;
    return overlaps(norm(it.rawProduct || ''));
  });
  if (existing) {
    if (Number(existing.qty) !== gift.qty) existing.qty = Number(existing.qty || 0) + gift.qty;
    return;
  }
  // Item THƯỜNG trùng tên + số lượng: LLM đưa dòng quà vào items nhưng quên cờ
  // isGift (thường gặp với đơn vị ít phổ biến như tuýp) → chuyển tại chỗ thành
  // quà thay vì đẩy thêm bản copy bị lặp ra bảng sản phẩm.
  const plain = items.find(it => {
    if (!it || it.isGift) return false;
    if (Number(it.qty) !== gift.qty) return false;
    if (String(it.unit || '').toLowerCase() !== gift.unit.toLowerCase()) return false;
    return overlaps(norm(it.rawProduct || ''));
  });
  if (plain) {
    plain.isGift = true;
    plain.explicitPrice = 0;
    plain.rawProduct = plain.rawProduct || gift.rawProduct;
    return;
  }
  parsedJson.items.push({
    qty: gift.qty,
    unit: gift.unit,
    rawProduct: gift.rawProduct,
    isGift: true,
    explicitPrice: 0
  });
}

/** Điền customer từ tên người nhận trích được (chỉ khi customer đang trống). */
function applyReceiver(parsedJson, receiver) {
  if (!receiver) return;
  const r = receiver.trim().replace(/[.,;:!\s]+$/, '');
  if (!r || GENERIC_RECEIVER_RE.test(r)) return;
  if (!String(parsedJson.customer || '').trim()) parsedJson.customer = r;
}

/**
 * Ghi chú chuẩn của đơn: HÀNG ĐẦU LUÔN LÀ TÊN KHÁCH (nếu đã nhận diện),
 * các dòng dặn dò/ghi chú còn lại nằm bên dưới.
 *  - customerFirstComment('Nhà xe Bình An', 'Anh Nam - 0999...')
 *      → "Nhà xe Bình An\nAnh Nam - 0999..."
 *  - Dòng nào trùng tên khách (norm) bị bỏ để không lặp lại.
 * Dùng chung cho cả 3 đường: UI (actions.js), headless API, offline builder.
 */
export function customerFirstComment(customer, comment) {
  const cust = String(customer || '').trim();
  const body = String(comment || '').split('\n').map(l => l.trim()).filter(Boolean);
  if (!cust) return body.join('\n');
  const custNorm = norm(cust);
  const filtered = body.filter(l => norm(l) !== custNorm);
  return [cust, ...filtered].join('\n');
}

// ── Tách dòng mở đầu khai tên khách: "em lên đơn HDX : Torvex độ giá 134k x 62 lon" ──
const INTRO_KEYWORD_RE = '(lên\\s+đơn|lam\\s+don|đơn\\s+cho|don\\s+cho|đơn\\s+của|don\\s+cua)';
const CUSTOMER_INTRO_RE = new RegExp('\\b' + INTRO_KEYWORD_RE + '\\s+([^:：\\n]+?)\\s*[:：]\\s*(.*)$', 'i');
const CUSTOMER_INTRO_TAIL_RE = new RegExp('\\b' + INTRO_KEYWORD_RE + '\\s+([^:：\\n]{2,40}?)\\s*$', 'i');
// Từ đệm hay dính cuối tên khách ("lên đơn HDX nha") → cắt bỏ
const TRAILING_PARTICLE_RE = /\s+(nhé|nha|nhe|ạ|ah|ak|ok|giúp|giup|dùm|giùm|em|anh|chị|chi|ơi|oi)$/i;

/** Tên khách hợp lệ: không quá ngắn/dài, không phải cụm số lượng hay từ chung chung. */
function isReasonableCustomerName(name) {
  if (!name || name.length < 2 || name.length > 50) return false;
  if (GENERIC_RECEIVER_RE.test(name)) return false;
  if (new RegExp('\\d+\\s*(' + UNIT_ALT + ')', 'i').test(name)) return false;
  return true;
}

/**
 * Tách dòng mở đầu có khai tên khách.
 *  - "em lên đơn HDX : Torvex độ giá 134,330 x 62 lon" → customer "HDX",
 *    phần còn lại "Torvex độ giá 134,330 x 62 lon" giữ làm dòng sản phẩm.
 *  - "lên đơn HDX" (chỉ khai khách, không có SP) → customer "HDX", bỏ dòng.
 * @returns { rest: string, drop: boolean } | null (không phải dòng mở đầu)
 */
function splitCustomerIntro(line, parsedJson) {
  const text = String(line || '').trim();
  if (!text) return null;

  let m = text.match(CUSTOMER_INTRO_RE);
  let rest = null;
  let name = null;

  if (m) {
    name = m[2].trim().replace(/[.,;:!\-–—\s]+$/, '');
    rest = (m[3] || '').trim();
  } else {
    const t = text.match(CUSTOMER_INTRO_TAIL_RE);
    if (!t) return null;
    name = t[2].trim().replace(/[.,;:!\-–—\s]+$/, '');
    while (TRAILING_PARTICLE_RE.test(name)) name = name.replace(TRAILING_PARTICLE_RE, '').trim();
    rest = '';
  }

  while (name && TRAILING_PARTICLE_RE.test(name)) name = name.replace(TRAILING_PARTICLE_RE, '').trim();
  if (!isReasonableCustomerName(name)) return null;

  applyReceiver(parsedJson, name);
  return { rest, drop: !rest };
}

// ── Lặp dòng sản phẩm: notes/TLN nhắc lại dòng SP đã vào items → cắt bỏ ──
// VD ghi chú KV: "...Anh Nam - 0999888777 Zentor số TT 10w50 : 1 thùng..."
// → dòng "Zentor số TT 10w50 : 1 thùng" trùng item đã trích xuất → bỏ,
// chỉ giữ phần thông tin khách/giao hàng trong ghi chú.
const QTY_ANYWHERE_RE = new RegExp('(\\d+)\\s*(?:x\\s*)?(' + UNIT_ALT + ')', 'gi');

// Dòng có thông tin GIÁ ("1 chai 143k", "giá 134,330") — chỉ cắt khi item
// đã mang giá đó (explicitPrice/priceTierQty), tránh mất dặn dò giá riêng.
const PRICE_HINT_RE = /\b\d+(?:[.,]\d+)?\s*(k|tr|trieu|triệu|ngàn|ngan|đồng|dong)\b|\b(giá|gia)\s*\d/i;

/** Gỡ lượng/đơn vị + ký tự rác để so sánh tên sản phẩm. */
function normProductFragment(s) {
  return norm(s)
    .replace(QTY_ANYWHERE_RE, ' ')
    .replace(/[:=.,;!*\-–—()\[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lấy danh sách chữ ký sản phẩm (tên đã gỡ lượng + số lượng) từ items AI đã trích xuất. */
function buildItemSignatures(parsedJson) {
  const sigs = [];
  for (const it of (parsedJson.items || [])) {
    if (!it || it.isGift) continue;
    const name = normProductFragment(it.rawProduct || '');
    if (name.length >= 3) sigs.push({
      name,
      qty: String(parseInt(it.qty, 10) || ''),
      hasPrice: (it.explicitPrice !== undefined && it.explicitPrice !== null)
        || (it.priceTierQty !== undefined && it.priceTierQty !== null)
    });
  }
  return sigs;
}

/**
 * Dòng này có phải bản lặp của 1 item đã trích xuất không?
 * Điều kiện: tên SP (đã gỡ lượng) xuất hiện trong dòng + (nếu dòng có khai
 * số lượng) số lượng trùng với item. Tránh cắt nhầm ghi chú nhắc SP nhưng
 * mang thông tin khác (VD "hết hàng", "đổi sang...").
 */
function isDuplicateItemLine(line, sigs) {
  if (!sigs.length) return false;
  // Cùng phép vệ sinh với chữ ký: bỏ dấu chấm/phẩy ngăn cách ("2.5" → "2 5")
  // để tên SP so khớp được cả 2 phía.
  const lineClean = norm(line)
    .replace(/[:=.,;!*\-–—()\[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  for (const sig of sigs) {
    // Khớp nguyên từ: không cho ký tự chữ/số dính thêm ở 2 đầu
    // (tránh "dầu phước 5" khớp nhầm "dầu phước 50").
    const nameRe = new RegExp('(?<![0-9a-z])' + sig.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![0-9a-z])');
    if (!nameRe.test(lineClean)) continue;

    // Dòng kèm giá riêng: chỉ cắt khi item đã mang giá đó (không mất dặn dò)
    if (PRICE_HINT_RE.test(line) && !sig.hasPrice) continue;

    // Dòng không khai số lượng → trùng tên SP là đủ để coi là lặp
    const qtyMatches = [...String(line).matchAll(new RegExp('(\\d+)\\s*(?:x\\s*)?(' + UNIT_ALT + ')', 'gi'))];
    if (!qtyMatches.length) return true;

    if (sig.qty && qtyMatches.some(m => m[1] === sig.qty)) return true;
  }
  return false;
}

/**
 * Lọc deterministic kết quả trích xuất của AI (mutate trực tiếp parsedJson):
 *  1. Dòng mở đầu khai tên khách ("lên đơn HDX : ...") → tách tên khách vào
 *     customer, chỉ giữ lại phần sản phẩm trong dòng.
 *  2. Dòng FOC/quà trong notes/tln → tách thành item isGift (hệ thống tự xử lý).
 *  3. Tên khách dính trong dòng quà ("cho Rửa xe AP") → đưa vào customer, xóa khỏi dòng.
 *  4. Notes chỉ lặp lại tên khách → bỏ (đã có ở trường customer).
 *  5. TLN dòng quà → giữ dòng sạch "FOC {qty} {unit} {sản phẩm}" (không dính tên khách).
 *  6. Dòng notes chỉ lặp lại dòng sản phẩm ĐÃ trích xuất vào items
 *     (VD "Zentor số TT 10w50 : 1 thùng") → bỏ khỏi NOTES. TLN KHÔNG áp
 *     dụng quy tắc này: TLN là khối tóm tắt đơn gồm tên khách + dòng hàng
 *     hóa + thông tin khách, nên giữ nguyên văn dòng sản phẩm.
 */
export function sanitizeAiExtraction(parsedJson) {
  if (!parsedJson || typeof parsedJson !== 'object') return parsedJson;
  if (!Array.isArray(parsedJson.items)) parsedJson.items = [];

  // ── 0. Item "ma" chỉ gồm token meta (HĐ / TT CK / VAT...) → loại ──
  parsedJson.items = parsedJson.items.filter(it => !isMetaTokenItem(it));

  // ── notes: mảng hoặc chuỗi nhiều dòng (tách cả phần tử mảng chứa \n —
  //    model hay nhét "TÊN KHÁCH\nHĐ" vào MỘT phần tử) ──
  const rawNotes = (Array.isArray(parsedJson.notes) ? parsedJson.notes
    : (typeof parsedJson.notes === 'string' && parsedJson.notes.trim()
      ? [parsedJson.notes]
      : [])).flatMap(raw => String(raw).split('\n'));

  const cleanNotes = [];
  // Chữ ký item tính TRƯỚC khi registerGift thêm dòng FOC vào items
  const itemSigs = buildItemSignatures(parsedJson);
  for (const raw of rawNotes) {
    let line = String(raw).trim();
    if (!line) continue;

    // Tách dòng mở đầu khai tên khách ("lên đơn HDX : ...")
    const intro = splitCustomerIntro(line, parsedJson);
    if (intro) {
      if (intro.drop) continue;
      line = intro.rest;
    }

    // Dòng chỉ lặp lại tên khách → bỏ (customer đã nhận diện riêng)
    const customer = String(parsedJson.customer || '').trim();
    if (customer && norm(line) === norm(customer)) continue;

    const parsed = parseGiftLine(line);
    if (parsed) {
      // Quà FOC đã thành dòng item cho hệ thống xử lý → không giữ trong notes
      registerGift(parsedJson, parsed.gift);
      applyReceiver(parsedJson, parsed.receiver);
      continue;
    }

    // Dòng lặp lại sản phẩm đã trích xuất → bỏ khỏi ghi chú
    if (isDuplicateItemLine(line, itemSigs)) continue;

    cleanNotes.push(line);
  }
  parsedJson.notes = cleanNotes;

  // ── tln: giữ nguyên văn, chỉ tách tên khách khỏi dòng mở đầu / dòng quà ──
  if (Array.isArray(parsedJson.tln)) {
    const cleanTln = [];
    for (const raw of parsedJson.tln) {
      let line = String(raw).trim();
      if (!line) continue;

      // Tách dòng mở đầu khai tên khách → giữ phần sản phẩm
      const intro = splitCustomerIntro(line, parsedJson);
      if (intro) {
        if (intro.drop) continue;
        line = intro.rest;
      }

      const parsed = parseGiftLine(line);
      if (parsed) {
        registerGift(parsedJson, parsed.gift);
        applyReceiver(parsedJson, parsed.receiver);
        cleanTln.push(parsed.cleanLine); // dòng sạch, không còn tên khách
        continue;
      }

      // TLN giữ nguyên văn dòng sản phẩm (khối tóm tắt đơn) — KHÔNG lọc
      // như notes; chỉ tách tên khách / chuẩn hóa dòng quà ở trên.
      cleanTln.push(line);
    }
    parsedJson.tln = cleanTln;
  }

  return parsedJson;
}

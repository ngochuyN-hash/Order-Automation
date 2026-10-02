/**
 * =========================================================================
 *  ORDER AUTOMATION - TLN COVERAGE CHECK (tln-coverage.mjs)
 * =========================================================================
 *  Kiểm tra bản chia cắt TLN của AI có phủ đủ nội dung user dán vào hay không.
 *  Module THUẦN (không phụ thuộc Electron/DOM) để unit-test trực tiếp.
 *
 *  Bối cảnh lỗi đã sửa: tin nhắn MỘT dòng chứa @mention kiểu
 *    "@Nguyễn Ngọc Huy Lên đơn Sửa xe Hiệp Phát: ... Mai giao đơn ... @Hoa Nguyễn"
 *  AI được lệnh BỎ @mentions (và chỉ giữ phần sau ":" của cụm lệnh "lên đơn")
 *  khi chia cắt TLN → các token tên người / "len don" không bao giờ xuất hiện
 *  trong output AI → so khớp substring nguyên dòng luôn FAIL → hệ thống rớt
 *  về Priority 2 (dòng thô) và TLN không bao giờ được chia ý với đơn dạng này.
 *
 *  Giải pháp:
 *   1. Tách @mention spans khỏi dòng thô trước khi so khớp, tên người được
 *      harvest và bơm vào "hay" (vì AI bỏ chúng nên phải miễn trừ).
 *   2. Bỏ cụm lệnh mở đầu ("(giúp em) lên đơn/lập đơn/order") khỏi needle.
 *   3. Nếu substring vẫn fail (AI tách/dồn dòng khác vị trí), fallback sang
 *      so phủ THEO TOKEN (bag-of-words có đếm số lượng): mọi token của needle
 *      phải xuất hiện đủ số lần trong hay. Đánh đổi: không kiểm tra được THỨ
 *      tự — chấp nhận vì mục tiêu là "không mất thông tin", không phải giữ
 *      đúng thứ tự; dữ liệu item vẫn được kiểm tra riêng ở tầng parse/repair.
 * =========================================================================
 */

import { normalizeFull } from '../../parser.js';

// Từ dừng: từ viết Hoa ngay sau tên mention nhưng là ĐỘNG TÙ/mệnh đề lệnh,
// không phải phần của tên người (vd "@Nguyễn Ngọc Huy Lên đơn..." → dừng ở "Lên").
const MENTION_STOP_WORDS = new Set(['len', 'lap', 'gui', 'order', 'cho', 'va', 'hoac', 'thi']);

// Chữ cái viết Hoa (gồm tiếng Việt có dấu) — nhận diện từ trong tên người.
const CAPITALIZED_RE = /^[A-ZÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ]/;

// Cụm lệnh mở đầu: "(giúp em) lên đơn X:" / "(anh) lập đơn Y:" / "order Z:"
// AI chỉ giữ phần sau dấu ":" nên các token này không có trong TLN.
// Chứa đầy đủ biến thể dấu tiếng Việt (đơn/lập/lên/chị/bác/mình/tôi...).
const CMD_PREFIX_RE =
  /^\s*(?:(?:gi[uùúụủũ]p|help)\s+)?(?:em|anh|ch[iìíịỉĩ]|b[aàáạảã]c|m[iìíịỉĩ]nh|t[oòóọỏõ]i)?\s*(?:(?:l[eêềếệểễéèẻẹẽ]n|l[aàáạảãăằắặẳẵâầấậẩẫ]p)\s+[dđ][oôồốộổỗơờớợởỡ][nñ]g?\b|order\b)\s*[:：]?\s*/i;

/**
 * Tách các span @mention khỏi một dòng văn bản.
 * Mention = token bắt đầu bằng "@" + chuỗi các từ viết Hoa liền sau
 * (vd "@Nguyễn Ngọc Huy", "@Hoa Nguyễn"). Dừng tại từ thường hoặc từ dừng.
 * Mention không theo mẫu tên (vd "@hoa" thường) vẫn bị tách dấu "@".
 * @param {string} line - dòng thô user dán
 * @returns {{ cleanedLine: string, mentionNames: string[] }}
 */
export function extractMentionSpans(line) {
  const tokens = String(line || '').split(/\s+/).filter(Boolean);
  const kept = [];
  const mentionNames = [];
  let cur = null;

  for (const tk of tokens) {
    if (tk.startsWith('@')) {
      if (cur) { mentionNames.push(cur); cur = null; }
      const bare = tk.slice(1);
      if (bare) cur = bare; // vào chế độ gom tên mention; "@" trơn thì bỏ
      continue;
    }
    if (cur) {
      const bareWord = tk.replace(/[^A-Za-zÀ-ỹĐđ\s]/g, '');
      if (CAPITALIZED_RE.test(tk) && !MENTION_STOP_WORDS.has(normalizeFull(bareWord))) {
        cur += ' ' + tk;
        continue;
      }
      mentionNames.push(cur);
      cur = null;
    }
    kept.push(tk);
  }
  if (cur) mentionNames.push(cur);

  return { cleanedLine: kept.join(' '), mentionNames };
}

/** Bỏ cụm lệnh mở đầu ("... lên đơn X:") sau khi mention đã được tách. */
export function stripCommandPrefix(line) {
  return String(line || '').replace(CMD_PREFIX_RE, '');
}

// Ngắt đoạn theo ý: dấu phẩy (CHỈ giữ nguyên khi kẹp giữa hai chữ số kiểu
// thập phân "0,12"), chấm phẩy, dấu "+", và cuối câu (dấu chấm liền khoảng trắng).
// Ghi chú: dùng 2 nhánh "hoặc" vì cần phủ định của (digit , digit):
//   ",(?!\\d)" bắt phẩy không theo sau bởi số; "(?<!\\d)," bắt phẩy không
//   đứng sau số — phẩy thật (vd "5W40, 5 chai") vẫn được tách bình thường.
const SEGMENT_SPLIT_RE = /\s*\+\s*|,(?!\d)|(?<!\d),|;\s*|\.\s+/;

// Cụm "số + đơn vị" — dùng để đếm dữ kiện hàng trong 1 dòng TLN của AI.
// Danh sách đồng bộ với UNIT_ALT (note-sanitizer.js / extraction-repair.js).
const QTY_UNIT_CLUSTER_RE =
  /\d+(?:[.,]\d+)?\s*(?:thùng|thg|thung|carton|ctn|box|chai|lon|can|bottle|btl|phuy|phụy|bộ|bo|lít|lit|hộp|hop|xô|xo|pail|bucket|bình|binh|pcs|cái|cai|cây|cay|kg|túi|tui|cuốn|cuon|tuýp|tuyp)\b/gi;

/**
 * Tách dòng thô thành các dòng TLN hợp lý bằng QUY TẮC CỤC BỘ (không cần AI).
 * Đây là lớp đảm bảo cuối cùng: dù AI không chia cắt được (trả lời tệ, mất
 * kết nối...) thì Excel vẫn nhận được bản đã ngắt dòng từng ý thay vì một
 * đoạn dài nguyên bản.
 *
 * Quy tắc:
 *  1. Bỏ @mention + cụm lệnh "(giúp em) lên đơn/order".
 *  2. Chia ý tại [;,] / "+" / hết câu (. ).
 *  3. "Tên khách: nội dung dài..." → tách dòng tên khách riêng (chỉ khi phần
 *     sau dấu ":" đủ dài, để không phá dòng SP kiểu "Zentor số TT 10w50 : 1 thùng").
 */
/**
 * Bẻ lại các dòng TLN của AI mà model LƯỜI CHIA: trả cả đoạn dài trong MỘT
 * phần tử mảng "tln". Coverage check chỉ kiểm tra ĐỦ (phủ hết nội dung dán)
 * nên bản "đơn tốp" như vậy vẫn pass và trôi nguyên khối xuống Excel thành
 * một hàng khổng lồ.
 *
 * Nguyên tắc bảo thủ để không phá dòng hợp lệ:
 *  - Chỉ đụng dòng chứa >= 2 cụm "số + đơn vị" (chắc chắn nhiều dữ kiện hàng).
 *    Địa chỉ/SĐT/dặn dò dài nhưng không phải danh sách hàng → GIỮ NGUYÊN.
 *  - Bẻ bằng đúng quy tắc chia ý cục bộ (SEGMENT_SPLIT_RE): nội dung giữ
 *    NGUYÊN VĂN theo từng ý, chỉ thêm vị trí xuống dòng + bỏ dấu chấm cuối.
 */
export function refineAiTlnLines(aiLines) {
  const out = [];
  for (const raw of aiLines || []) {
    const line = String(raw || '').trim();
    if (!line) continue;
    const clusters = line.match(QTY_UNIT_CLUSTER_RE);
    if (!clusters || clusters.length < 2) {
      out.push(line);
      continue;
    }
    for (let seg of line.split(SEGMENT_SPLIT_RE)) {
      seg = seg.trim();
      if (!seg) continue;
      out.push(seg.replace(/\.$/, ''));
    }
  }
  return out;
}

export function splitRawIntoTlnLines(rawLines) {
  const out = [];
  for (const raw of rawLines || []) {
    const { cleanedLine } = extractMentionSpans(raw);
    const line = stripCommandPrefix(cleanedLine).trim();
    if (!line) continue;
    for (let seg of line.split(SEGMENT_SPLIT_RE)) {
      seg = seg.trim();
      if (!seg) continue;
      const cm = /^([^:：\d][^:：]{0,48})[:：]\s*(.+)$/.exec(seg);
      if (cm && cm[2].trim().length >= 12) {
        // Dòng mở đầu "Tên khách: ..." — tách tên khách thành dòng riêng
        out.push(cm[1].trim() + ':');
        out.push(cm[2].trim());
      } else {
        out.push(seg.replace(/\.$/, ''));
      }
    }
  }
  return out;
}

function countTokens(normText) {
  const counts = new Map();
  for (const t of normText.split(' ')) {
    if (!t) continue;
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  return counts;
}

/**
 * Kiểm tra bản chia cắt của AI có phủ ĐỦ mọi dòng user dán vào hay không.
 * Trả về false nếu bất kỳ dòng dán nào vắng mặt trong output AI →
 * caller phải fallback về dòng thô để không bao giờ mất thông tin.
 * (Tên khách được tính vào "hay" vì sanitizer đã chuyển tên khách
 * từ dòng quà/dòng mở đầu sang trường customer.)
 */
export function tlnCoversRawText(aiLines, rawLines, customerName) {
  if (rawLines.length === 0) return true;
  if (aiLines.length === 0) return false;

  // Tách mention + cụm lệnh khỏi từng dòng thô; tên mention bơm vào "hay"
  // vì AI được lệnh bỏ chúng khi chia cắt.
  const hayParts = [customerName || '', ...aiLines];
  const needles = [];
  for (const line of rawLines) {
    const { cleanedLine, mentionNames } = extractMentionSpans(line);
    if (mentionNames.length > 0) hayParts.push(...mentionNames);
    const stripped = stripCommandPrefix(cleanedLine);
    needles.push(normalizeFull(stripped).trim());
  }
  const hayJoined = normalizeFull(hayParts.join(' ')).trim();
  const hayCounts = countTokens(hayJoined);

  return needles.every(needle => {
    if (!needle) return true;
    if (hayJoined.includes(needle)) return true; // fast path như cũ
    // Fallback: so phủ theo token (có đếm số lượng) — chịu được việc AI
    // tách/dồn dòng ở vị trí khác so với dòng thô.
    for (const [tok, need] of countTokens(needle)) {
      if ((hayCounts.get(tok) || 0) < need) return false;
    }
    return true;
  });
}

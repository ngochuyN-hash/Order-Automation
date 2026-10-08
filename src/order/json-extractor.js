// =========================================================================
//  JSON EXTRACTOR — tách JSON khỏi phản hồi LLM một cách "chống đạn"
// =========================================================================
//  Module thuần (không phụ thuộc DOM/db) để test được bằng node --test.
//
//  Vấn đề thực tế: model đôi khi trả JSON kèm rác xung quanh — prose trước/
//  sau, markdown fence chưa đóng, phần suy nghĩ (thinking) đi kèm, xuống dòng
//  thô bên trong chuỗi, hoặc bị cắt giữa chừng do hết max_tokens. Hàm
//  JSON.parse("nguyên văn") lúc đúng lúc sai → hệ thống báo "AI trả về không
//  phải JSON hợp lệ" hoặc tệ hơn: repair im lặng làm MẤT dòng sản phẩm.
//
//  Chuỗi xử lý (thử lần lượt, cái nào parse được dùng cái đó):
//    1. Tách đoạn cân bằng ngoặc từ {/[ đầu tiên (bỏ prose/fence 2 phía)
//    2. Nguyên văn
//    mỗi ứng viên thử: parse thô → bỏ trailing-comma → escape \n thô trong
//    string → repair-truncated (đóng ngoặc cho JSON bị cắt).
// =========================================================================

/**
 * Quét từ ký tự {/[ đầu và trả về đoạn JSON CÂN BẰNG NGOẶC hoàn chỉnh.
 * Bất chấp mọi rác phía sau (prose, fence, object nối đuôi...).
 * Trả về null nếu không đóng đủ ngoặc (JSON bị cắt → caller dùng repair).
 */
function sliceBalancedJSON(s) {
  if (!s || (s[0] !== '{' && s[0] !== '[')) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return s.slice(0, i + 1);
      if (depth < 0) return null;
    }
  }
  return null; // không bao giờ đóng đủ → JSON cắt cụt
}

/**
 * Escape xuống dòng/tab THÔ bên trong chuỗi JSON (JSON.parse bắt buộc phải
 * là \n/\r/\t — model hay quên escape khi ghi địa chỉ nhiều dòng).
 */
function escapeRawNewlinesInStrings(s) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch;
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  return out;
}

/**
 * Repair JSON bị cắt cụt (hết max_tokens): đóng dấu ngoặc còn hở.
 * Lùi dần điểm cắt (ưu tiên ranh giới entry hoàn chỉnh `}`/`]`) và CHỮ NGHIỆM
 * JSON.parse từng prefix — bảo đảm phần dữ liệu đã ghi trước điểm cắt được
 * giữ nguyên, còn entry/key/value dang dở thì bỏ đi. Phần sót sẽ do tầng
 * extraction-repair phát hiện và vá.
 */
const REPAIR_BACKTRACK = 300;

function repairTruncatedJSON(text) {
  const base = text.trim();
  // Không có opener nào → không phải JSON cắt cụt, trả null để caller bỏ attempt
  if (!base || !/[{[]/.test(base)) return null;
  for (let pass = 0; pass < 2; pass++) {
    const limit = Math.min(base.length, REPAIR_BACKTRACK);
    for (let back = 0; back <= limit; back++) {
      const idx = base.length - back;
      // Pass 1: chỉ thử điểm cắt ngay SAU entry hoàn chỉnh (}/])
      // Pass 2: thử mọi vị trí (value string đóng đủ, v.v...)
      if (pass === 0 && !/[}\]]/.test(base[idx - 1] || '')) continue;
      const closed = closeBraces(base.slice(0, idx));
      if (closed !== null) return closed;
    }
  }
  return '{}';
}

/** Đóng ngoặc cho prefix và trả về CHỈ KHI parse được, ngược lại null. */
function closeBraces(s) {
  const stack = [];
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let out = s;
  if (inString) out += '"';
  out = out.replace(/[,:]\s*$/, '');
  if (/:\s*$/.test(out)) out = out.replace(/,?\s*"[^"]*"\s*:\s*$/, '');
  while (stack.length) out += stack.pop();
  try {
    JSON.parse(out);
    return out;
  } catch (_) {
    return null;
  }
}

/** Sinh các biến thể parse cho 1 ứng viên (thử theo thứ tự, dừng ở cái ăn). */
function parseAttempts(s) {
  const esc = escapeRawNewlinesInStrings(s);
  const noTrailing = s.replace(/,\s*([}\]])/g, '$1');
  const noTrailingEsc = esc.replace(/,\s*([}\]])/g, '$1');
  return [
    s,
    noTrailing,
    esc,
    noTrailingEsc,
    repairTruncatedJSON(esc),
    repairTruncatedJSON(noTrailingEsc),
  ].filter(v => v !== null && v !== undefined);
}

/**
 * Extract JSON từ phản hồi LLM. Ném Error (kèm snippet) nếu thật sự không có
 * JSON nào parse được.
 * @param {string} text - Phản hồi thô của model
 * @returns {Object|Array}
 */
export function extractJSON(text) {
  // Guard: phản hồi rỗng / vô nghĩa từ model local
  if (!text || !text.trim() || /^\s*\.{2,}\s*$/.test(text)) {
    throw new Error('AI trả về phản hồi rỗng (empty). Model local có thể bị quá tải context hoặc chưa bật server.');
  }

  let raw = String(text);

  // Markdown fence ĐÓNG chứa ngoặc → lấy nội dung fence
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch && /[{[]/.test(fenceMatch[1])) raw = fenceMatch[1];

  // Ứng viên theo độ ưu tiên (không trùng lặp)
  const candidates = [];
  const push = (s) => { if (s && !candidates.includes(s)) candidates.push(s); };

  const start = raw.search(/[{[]/);
  if (start >= 0) {
    const tail = raw.slice(start);           // bỏ prose/fence phía TRƯỚC
    const balanced = sliceBalancedJSON(tail); // bỏ rác phía SAU (nếu JSON hoàn chỉnh)
    push(balanced || tail);
  }
  push(raw);

  for (const cand of candidates) {
    for (const attempt of parseAttempts(cand)) {
      try {
        return JSON.parse(attempt);
      } catch (_) { /* thử biến thể kế */ }
    }
  }

  const snippet = raw.slice(0, 200).replace(/\n/g, ' ');
  throw new Error(`AI trả về không phải JSON hợp lệ. Phản hồi: "${snippet}..."`);
}

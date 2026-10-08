// =========================================================================
//  ORDER SCHEMA (src/order/order-schema.mjs)
//  Nguồn chân lý DUY NHẤT cho cấu trúc output trích xuất đơn hàng.
//
//  Thay vì dựa vào model đọc JSON mẫu trong prompt, cấu trúc bị ÉP ngay ở
//  tầng API:
//    - Gemini:        generationConfig.responseSchema (subset OpenAPI)
//    - OpenAI/Groq:   response_format json_schema strict mode
//    - Anthropic:     prefill assistant '{' (prompt vẫn kèm ví dụ compact)
//  Prompt chỉ còn mô tả NGỮ NGHĨA (ORDER_SEMANTICS) — cái schema không ép được.
//
//  Module thuần: không DOM, không phụ thuộc ai-service — test bằng node --test.
// =========================================================================

/** Mô tả ngữ nghĩa từng field — chèn vào prompt thay cho JSON mẫu dài. */
export const ORDER_SEMANTICS = [
  'customer: tên khách hàng/cửa hàng; giữ NGUYÊN VĂN chính tả (kể cả ALL-CAPS tiếng Anh VD "ANYWHERE MAN"); không rõ → null',
  'payment: "ck" | "cod" | "tt" | "congno" | "other"; "TT CK"/"chuyển khoản" → "ck", chỉ "TT" một mình → "tt"; dòng thanh toán không tạo item',
  'notes: mảng lời dặn THỰC TẾ của Sales (giao trước 10h...); không có → []; KHÔNG đưa dòng sản phẩm/quà vào notes; KHÔNG đưa tên khách vào notes; "HĐ"/"hóa đơn"/"VAT" (yêu cầu hóa đơn) → ghi ở đây, KHÔNG tạo item',
  'items[].qty: số lượng dạng số (3, không phải "3 thùng")',
  'items[].unit: đúng đơn vị sales ghi (thùng, phuy, chai, lon, cái, áo...); sales không ghi → tự suy luận theo sản phẩm',
  'items[].rawProduct: tên sản phẩm NGUYÊN VĂN như sales viết (viết tắt, không dấu, biệt danh giữ nguyên); GIỮ nguyên dung tích/quy cách VÀ phụ từ phân biệt biến thể trong tên (1L, 800ml, 60L, 4T, max, transparent...)',
  'items[].kvCode: mã KV nếu sales ghi ("mã 8230012"), chỉ chữ số; không có → null',
  'items[].explicitPrice: đơn giá sales ghi ANYWHERE trong dòng; quy đổi ra số: k×1000 (158k→155000), tr×1000000 (1.2tr→1200000, 11tr3→11300000); không có giá → null',
  'items[].priceTierQty: mốc giá khi sales ghi "giá 2 thùng"/"lấy mốc giá 2 thùng"; KHÔNG phải đơn giá; "giá N thùng" nằm trên cùng dòng sản phẩm → 1 item duy nhất, KHÔNG tách thành item thứ 2, KHÔNG nhân đôi qty; dòng "giá N thùng" ĐỨNG RIÊNG là mốc giá TOÀN ĐƠN → KHÔNG tạo item, đặt priceTierQty=N cho mọi item chưa có explicitPrice và chưa có mốc riêng; không có → null',
  'items[].isGift: true nếu dòng là quà tặng/FOC/tặng/khuyến mãi',
  'items[].explicitGift: quà kèm theo dòng chính (VD "3 thùng Fast tặng 2 lon" → {qty:2,name:"lon",unit:"lon"}); không có → null',
  'tln: CHIA CẮT toàn bộ tin nhắn thành từng dòng NGUYÊN VĂN theo ý (tên khách, địa chỉ, SĐT, mỗi dòng SP, mỗi dòng quà, dặn dò); KHÔNG viết lại, KHÔNG bỏ sót; bỏ @mentions và thảo luận nội bộ',
];

/**
 * Schema chuẩn Gemini (generationConfig.responseSchema).
 * Gemini dùng subset OpenAPI: type UPPERCASE, nullable riêng (không dùng type array).
 */
export function buildGeminiResponseSchema() {
  return {
    type: 'OBJECT',
    properties: {
      customer: { type: 'STRING', nullable: true },
      payment: { type: 'STRING', enum: ['ck', 'cod', 'tt', 'congno', 'other'], nullable: true },
      notes: { type: 'ARRAY', items: { type: 'STRING' } },
      items: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            qty: { type: 'NUMBER' },
            unit: { type: 'STRING' },
            rawProduct: { type: 'STRING' },
            kvCode: { type: 'STRING', nullable: true },
            explicitPrice: { type: 'NUMBER', nullable: true },
            priceTierQty: { type: 'NUMBER', nullable: true },
            isGift: { type: 'BOOLEAN' },
            explicitGift: {
              type: 'OBJECT',
              nullable: true,
              properties: {
                qty: { type: 'NUMBER' },
                name: { type: 'STRING' },
                unit: { type: 'STRING' },
              },
              required: ['qty', 'name', 'unit'],
            },
          },
          required: ['qty', 'unit', 'rawProduct', 'kvCode', 'explicitPrice', 'priceTierQty', 'isGift', 'explicitGift'],
        },
      },
      tln: { type: 'ARRAY', items: { type: 'STRING' } },
    },
    required: ['customer', 'payment', 'notes', 'items', 'tln'],
  };
}

/**
 * Schema chuẩn OpenAI strict-mode (response_format json_schema).
 * Điều kiện bắt buộc của strict mode: MỌI property phải nằm trong required
 * (field optional biểu diễn qua anyOf với {type:'null'}), additionalProperties:false.
 */
export function buildOpenAIJsonSchema() {
  const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
  return {
    type: 'object',
    additionalProperties: false,
    required: ['customer', 'payment', 'notes', 'items', 'tln'],
    properties: {
      customer: nullable({ type: 'string' }),
      payment: { type: 'string', enum: ['ck', 'cod', 'tt', 'congno', 'other'] },
      notes: { type: 'array', items: { type: 'string' } },
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['qty', 'unit', 'rawProduct', 'kvCode', 'explicitPrice', 'priceTierQty', 'isGift', 'explicitGift'],
          properties: {
            qty: { type: 'number' },
            unit: { type: 'string' },
            rawProduct: { type: 'string' },
            kvCode: nullable({ type: 'string' }),
            explicitPrice: nullable({ type: 'number' }),
            priceTierQty: nullable({ type: 'number' }),
            isGift: { type: 'boolean' },
            explicitGift: nullable({
              type: 'object',
              additionalProperties: false,
              required: ['qty', 'name', 'unit'],
              properties: {
                qty: { type: 'number' },
                name: { type: 'string' },
                unit: { type: 'string' },
              },
            }),
          },
        },
      },
      tln: { type: 'array', items: { type: 'string' } },
    },
  };
}

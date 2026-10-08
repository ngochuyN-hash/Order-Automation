// =========================================================================
//  HEADLESS API (src/api/headless.js)
//  Headless order parsing pipeline — không GỌI DOM/toast trực tiếp (phần
//  parse thuần JSON). Import seller/manager.js chỉ để lấy data helpers
//  (tiền tố mã đơn/tiêu đề) — module đó được nạp sẵn bởi src/main.js nên
//  không tăng module graph của renderer.
//  Exposed on window.__ORDER_API__ so the Electron main process can call it
//  via webContents.executeJavaScript() to serve the local HTTP API.
//
//  Flow: raw sales text → AI extraction (or offline regex) → local product
//  matching → campaign classification → tiered pricing → FOC gifts → JSON.
//
//  Ngoài parse, module còn expose DATA API đọc/ghi toàn bộ dữ liệu app
//  (sản phẩm, campaign, alias, mã KV, bộ nhớ AI, sellers), xem/xuất đơn
//  hiện tại, xuất Excel headless và import/reset database — dùng chung
//  tầng lưu trữ với GUI (db.* tự persist qua db.save() → IndexedDB).
// =========================================================================

import { db } from '../../db.js';
import { findBestProductMatch, normalizeFull } from '../../parser.js';
import { aiService } from '../../ai-service.js';
import { getProviderIds } from '../../ai-providers.mjs';
import { buildOrderFromText } from '../order/builder.js';
import { calculateOrderItem, getFinalUnitPrice } from '../order/calculator.js';
import { runParsePipeline } from '../order/parse-pipeline.js';
import { store } from '../../store.js';
import { generateOrderTitle, peekOrderSequence, commitOrderSequence, getBrandPrefixes, saveBrandPrefixes, resolveSellerReceiver } from '../seller/manager.js';

/**
 * Serialize an internal order object into a clean API response.
 * Strips functions/circular refs; keeps only what an external agent needs.
 */
function serializeOrder(order) {
  const items = (order.items || []).map(item => {
    const p = item.product;
    return {
      rawProduct: item.rawProduct || item.rawName || '',
      matched: !!p,
      productName: p ? p.name : null,
      kvCode: p ? (db.getKvCode ? db.getKvCode(p, item.unit) : (p.kvCode || '')) : null,
      campaignKey: p ? p.campaignKey : null,
      qty: item.qty,
      unit: item.unit,
      unitPrice: item.unitPrice || 0,
      subtotal: item.subtotal || 0,
      tierLabel: item.tierLabel || '',
      isGift: !!item.isGift,
      matchScore: item.matchScore || 0,
      foc: item.foc || null,
    };
  });

  const grandTotal = items.reduce((sum, i) => sum + (i.subtotal || 0), 0);

  return {
    customer: order.customer || '',
    payment: order.payment || 'ck',
    campaign: order.aiResult ? {
      key: order.aiResult.primaryCampaign,
      label: order.aiResult.campaignLabel,
      confidence: order.aiResult.confidencePercent,
    } : null,
    items,
    grandTotal,
    notes: order.salesComment || '',
    tln: order.tlnLines || null,
  };
}

/**
 * Normalize AI-extracted unit string to canonical Vietnamese unit.
 */
function normalizeUnit(raw) {
  let unit = (raw || 'thùng').toLowerCase().trim();
  if (unit.includes('thg') || unit.includes('thung') || unit.includes('carton') || unit.includes('box') || unit.includes('ctn')) return 'thùng';
  if (unit.includes('chai') || unit.includes('lon') || unit.includes('btl')) return 'chai';
  if (unit.includes('can')) return 'can';
  if (unit.includes('phuy') || unit.includes('drum')) return 'phuy';
  if (unit.includes('xô') || unit.includes('xo') || unit.includes('pail') || unit.includes('bucket')) return 'xô';
  if (unit.includes('cây') || unit.includes('cay') || unit.includes('cái') || unit.includes('cai')) return 'cái';
  return unit;
}


// =========================================================================
//  DATA API helpers — đọc/ghi dữ liệu cho agent ngoài
// =========================================================================

/** Nhãn thanh toán hiển thị trong Excel/TLN (khớp select paymentMethod). */
const PAYMENT_LABELS = {
  ck: 'Chuyển khoản (CK)',
  cod: 'COD',
  tt: 'Thanh toán trực tiếp (TT)',
  congno: 'Công nợ',
  other: 'Khác',
};

/** Đơn giá thấp nhất trong bảng giá (dùng cho dòng quà FOC/MKT). */
function minTierPrice(product) {
  if (!product || !Array.isArray(product.tiers)) return 0;
  const prices = product.tiers.map(t => t.price).filter(p => typeof p === 'number' && p > 0);
  return prices.length ? Math.min(...prices) : 0;
}

/**
 * Serialize sản phẩm thành JSON an toàn cho API: kèm campaignKey,
 * mã KV đã resolve theo cùng quy tắc getKvCode() (base + mã thùng) và aliases.
 */
function serializeProduct(p) {
  const base = (db.kvCodeMap && db.kvCodeMap[p.id]) || p.kvCode || '';
  const boxSize = Number(p.box_size) || 1;
  const thung = boxSize > 1
    ? ((db.kvCodeThungMap && db.kvCodeThungMap[p.id]) || p.kvCodeThung || (base ? base + '-1' : ''))
    : '';
  return {
    id: p.id,
    name: p.name,
    spec: p.spec || '',
    packaging: p.packaging || '',
    unit: p.unit || '',
    category: p.category || '',
    box_size: boxSize,
    campaignKey: p.campaignKey || null,
    tiers: Array.isArray(p.tiers) ? p.tiers : [],
    // [Promo v1.3.0] Rule KM của SP (campaign.promoRules scope 'product') — schema số
    promoRules: db.getPromoRulesForProduct(p.id),
    kvCode: base,
    kvCodeThung: thung,
    aliases: (db.getAliasesForProduct(p.id) || []).map(a => a.alias),
  };
}

/** Clone JSON an toàn: loại function/không thể serialize (campaign có thể chứa). */
function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Tìm sản phẩm theo id trong toàn bộ campaigns. */
function findProduct(id) {
  return db.findProductById(id) || null;
}

/**
 * Dựng TLN (bản tóm tắt ghi vào Excel) theo cấu trúc Priority-3 giống GUI:
 * tên khách → các dòng hàng → dòng quà "FOC ..." → TT thanh toán → ghi chú.
 */
function buildTlnText(customer, rows, payment, note) {
  const lines = customer ? [customer] : [];
  for (const r of rows) {
    const name = r.rawProduct || (r.product ? r.product.name : '');
    lines.push(`${r.isGift ? 'FOC ' : ''}${r.qty} ${r.unit} ${name}`.trim());
  }
  if (payment && PAYMENT_LABELS[payment]) lines.push(`TT ${PAYMENT_LABELS[payment]}`);
  if (note) String(note).split('\n').map(l => l.trim()).filter(Boolean).forEach(l => lines.push(l));
  return lines.join('\n');
}

// =========================================================================
//  PUBLIC API — exposed on window.__ORDER_API__
// =========================================================================

/**
 * Mask 1 AI profile cho output API: API key KHÔNG BAO GIỜ rời renderer —
 * chỉ trả hasKey (có key hay không) + keyError (key lưu nhưng giải mã lỗi).
 */
function maskAiProfile(p) {
  return {
    id: p.id || '',
    name: p.name || '',
    provider: p.provider || '',
    model: p.model || '',
    endpoint: p.endpoint || '',
    enabled: !!p.enabled,
    hasKey: !!(p.apiKey && String(p.apiKey).trim()),
    keyError: p.keyError || null,
  };
}

export const HeadlessOrderAPI = {
  /** API version */
  version: '2.2.0',

  /**
   * Parse raw sales text using the OFFLINE regex parser (no AI call).
   * Fast, deterministic, works without AI provider.
   */
  parseOffline(text) {
    try {
      const order = buildOrderFromText(text);
      return { success: true, mode: 'offline', order: serializeOrder(order) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  /**
   * Parse raw sales text using the FULL AI pipeline
   * (AI extraction → local matching → campaign → pricing → FOC).
   * Requires an enabled AI profile.
   *
   * CHUNG code path với nút Phân tích của GUI (runParsePipeline) — không tách
   * bản riêng nữa. learnAliases:false: parse headless là API đọc-điều-kiện,
   * không ghi vào registry alias chung.
   */
  async parseWithAI(text) {
    try {
      const { order } = await runParsePipeline(text, { db, aiService }, { learnAliases: false });
      return { success: true, mode: 'ai', order: serializeOrder(order) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  /**
   * Smart parse: try AI first, fall back to offline on failure.
   * options.mode: 'auto' (mặc định — fallback offline âm thầm như cũ),
   *   'ai' (ép pipeline AI, lỗi AI trả success:false KHÔNG fallback),
   *   'offline' (chỉ regex). Auto/AI kèm fallbackReason khi rơi về offline
   *   để agent ngoài chẩn đoán được ("no_enabled_profile" hoặc lỗi AI).
   */
  async parse(text, options) {
    const opts = typeof options === 'string' ? { mode: options } : (options || {});
    const mode = opts.mode === 'ai' || opts.mode === 'offline' ? opts.mode : 'auto';
    if (mode === 'offline') return this.parseOffline(text);
    let aiResult = null;
    try {
      const { profiles } = await aiService.getProfiles();
      const hasAI = profiles.some(p => p.enabled);
      if (!hasAI) {
        if (mode === 'ai') {
          return {
            success: false,
            mode: 'ai',
            error: 'Không có AI profile nào đang bật. Cấu hình qua tool manage_ai_profiles (MCP) hoặc Cài Đặt → AI.',
            fallbackReason: 'no_enabled_profile',
          };
        }
        return { ...this.parseOffline(text), fallbackReason: 'no_enabled_profile' };
      }
      aiResult = await this.parseWithAI(text);
    } catch (e) {
      // getProfiles/IPC lỗi → coi như AI unavailable
      if (mode === 'ai') {
        return { success: false, mode: 'ai', error: `AI parse thất bại: ${e.message}`, fallbackReason: 'ai_error' };
      }
      return { ...this.parseOffline(text), fallbackReason: `ai_error: ${e.message}` };
    }
    if (aiResult && aiResult.success) return aiResult;
    // parseWithAI nuốt lỗi nội bộ (success:false, không throw) — xử lý như AI lỗi:
    // mode 'ai' báo lỗi gốc rõ ràng; 'auto' fallback offline kèm lý do để agent chẩn đoán
    const aiError = (aiResult && aiResult.error) || 'unknown AI error';
    if (mode === 'ai') {
      return { success: false, mode: 'ai', error: aiError, fallbackReason: 'ai_error' };
    }
    return { ...this.parseOffline(text), fallbackReason: `ai_error: ${aiError}` };
  },

  // ── AI CONFIG API: cho agent ngoài đọc trạng thái / test / ghi profile ──

  /** Trạng thái AI profiles (strategy, activeId, profiles đã mask key). */
  async getAiStatus() {
    try {
      const { profiles, strategy, activeId } = await aiService.getProfiles();
      return { success: true, strategy, activeId, profiles: profiles.map(maskAiProfile) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  /**
   * Test kết nối AI: 1 profile theo id, hoặc tất cả profile đang bật.
   * payload: { id?: string } — không có id → test mọi profile enabled.
   */
  async testAiProfiles(payload) {
    const opts = typeof payload === 'string' ? { id: payload } : (payload || {});
    try {
      const { profiles } = await aiService.getProfiles();
      let targets;
      if (opts.id) {
        targets = profiles.filter(p => p.id === String(opts.id));
        if (!targets.length) return { success: false, error: `Không tìm thấy AI profile id="${opts.id}"` };
      } else {
        targets = profiles.filter(p => p.enabled);
        if (!targets.length) return { success: false, error: 'Không có AI profile nào đang bật để test.' };
      }
      const results = [];
      for (const p of targets) {
        const base = { id: p.id, name: p.name, provider: p.provider, model: p.model };
        if (p.keyError === 'decrypt_failed') {
          results.push({ ...base, ok: false, message: 'API key không thể giải mã (DPAPI mất khóa) — cần nhập lại key.' });
          continue;
        }
        const started = Date.now();
        const r = await aiService.testProfile(p);
        results.push({ ...base, ok: !!r.ok, message: r.message || '', latencyMs: Date.now() - started, models: r.models });
      }
      return { success: true, results };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  /**
   * Upsert/xóa AI profiles cho agent ngoài.
   * payload: {
   *   profiles: [{ id?, name, provider, model, endpoint?, apiKey?, enabled?, clearKey? }],
   *   strategy?: 'failover'|'roundrobin', activeId?: string, deleteIds?: string[]
   * }
   * Quy ước key: apiKey thiếu/rỗng → GIỮ key cũ (agent chỉ đổi model không mất
   * key); clearKey:true → xóa key. Response là trạng thái sau ghi (key mask).
   */
  async setAiProfiles(payload) {
    const data = typeof payload === 'string' ? {} : (payload || {});
    try {
      const current = await aiService.getProfiles();
      const byId = new Map(current.profiles.map(p => [p.id, p]));
      const validProviders = getProviderIds();

      for (const id of (Array.isArray(data.deleteIds) ? data.deleteIds : [])) {
        byId.delete(String(id));
      }

      for (const incoming of (Array.isArray(data.profiles) ? data.profiles : [])) {
        if (!incoming || typeof incoming !== 'object') continue;
        const existing = incoming.id ? byId.get(String(incoming.id)) : null;
        // Upsert theo id: trường không gửi (vd provider khi chỉ đổi model) giữ giá trị cũ
        const provider = incoming.provider !== undefined ? String(incoming.provider) : (existing ? existing.provider : '');
        if (!provider || !validProviders.includes(provider)) {
          return { success: false, error: `Provider không hợp lệ: ${JSON.stringify(incoming.provider || null)} — hỗ trợ: ${validProviders.join(', ')}` };
        }
        const hasNewKey = typeof incoming.apiKey === 'string' && incoming.apiKey.trim();
        const profile = {
          id: existing ? existing.id : ('ai_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)),
          name: incoming.name !== undefined ? String(incoming.name) : (existing ? existing.name : ''),
          provider,
          model: incoming.model !== undefined ? String(incoming.model) : (existing ? existing.model : ''),
          endpoint: incoming.endpoint !== undefined ? String(incoming.endpoint) : (existing ? existing.endpoint : ''),
          apiKey: hasNewKey ? incoming.apiKey.trim() : (incoming.clearKey ? '' : (existing ? existing.apiKey : '')),
          enabled: incoming.enabled !== undefined ? !!incoming.enabled : (existing ? existing.enabled : true),
        };
        byId.set(profile.id, profile);
      }

      const strategy = data.strategy === 'failover' || data.strategy === 'roundrobin' ? data.strategy : current.strategy;
      const activeId = typeof data.activeId === 'string' ? data.activeId : current.activeId;
      await aiService.saveProfiles([...byId.values()], strategy, activeId);
      const after = await aiService.getProfiles();
      return { success: true, strategy: after.strategy, activeId: after.activeId, profiles: after.profiles.map(maskAiProfile) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  /** Get database summary (product count, campaigns, aliases). */
  getDbInfo() {
    const products = db.getAllProducts();
    const campaigns = Object.entries(db.data.campaigns).map(([key, c]) => ({
      key, name: c.name, brand: c.brand, productCount: (c.products || []).length,
    }));
    return {
      productCount: products.length,
      aliasCount: Object.keys(db.getAliases() || {}).length,
      campaigns,
    };
  },

  // ── DATA API: đọc dữ liệu ────────────────────────────────────────────

  /**
   * Liệt kê sản phẩm đầy đủ dữ liệu (giá bậc, FOC, alias, mã KV đã resolve).
   * options: { campaign?, q?, limit?, offset? } — q tìm theo tên/spec/alias/mã KV
   * (normalize bỏ dấu). Trả { total, count, products }.
   */
  getProducts(options = {}) {
    const opts = typeof options === 'string' ? { campaign: options } : (options || {});
    let products = db.getAllProducts();
    if (opts.campaign && opts.campaign !== 'all') {
      products = products.filter(p => p.campaignKey === opts.campaign);
    }
    if (opts.q) {
      const nq = normalizeFull(String(opts.q));
      products = products.filter(p => {
        const hay = [p.name, p.spec, p.kvCode, (db.kvCodeMap || {})[p.id],
          ...(db.getAliasesForProduct(p.id) || []).map(a => a.alias)].join(' ');
        return normalizeFull(hay).includes(nq);
      });
    }
    const total = products.length;
    const offset = Math.max(0, parseInt(opts.offset, 10) || 0);
    const limit = opts.limit ? Math.max(1, parseInt(opts.limit, 10) || 50) : 0;
    if (offset) products = products.slice(offset);
    if (limit) products = products.slice(0, limit);
    return { success: true, total, count: products.length, products: products.map(serializeProduct) };
  },

  /**
   * Liệt kê campaign. options: { includeProducts? } — true thì kèm toàn bộ
   * products + promoRules của từng campaign.
   */
  getCampaigns(options = {}) {
    const opts = typeof options === 'boolean' ? { includeProducts: options } : (options || {});
    const campaigns = Object.entries(db.data.campaigns || {}).map(([key, c]) => {
      const camp = {
        key,
        name: c.name,
        brand: c.brand || key,
        color: c.color,
        icon: c.icon,
        productCount: (c.products || []).length,
        // [Promo v1.3.0] Rule KM thống nhất (campaign.promoRules)
        promoRulesCount: (c.promoRules || []).length,
      };
      if (opts.includeProducts) {
        camp.promoRules = jsonSafe(c.promoRules || []);
        camp.products = (c.products || []).map(serializeProduct);
      }
      return camp;
    });
    return { success: true, campaigns };
  },

  /** Toàn bộ alias (alias → productId), đã gộp default + custom, bỏ alias đã xóa. */
  getAliases() {
    return { success: true, aliases: db.getAliases() || {} };
  },

  /** Map mã KiotViet runtime: { kvCodeMap: {productId: mã gốc}, kvCodeThungMap: {productId: mã thùng} }. */
  getKvMap() {
    return {
      success: true,
      kvCodeMap: { ...(db.kvCodeMap || {}) },
      kvCodeThungMap: { ...(db.kvCodeThungMap || {}) },
    };
  },

  /** Bộ nhớ quy tắc AI (text). */
  getMemory() {
    return { success: true, memory: db.getMemory() || '' };
  },

  /** Danh sách nhân viên sales + tiền tố mã đơn theo brand. */
  getSellers() {
    return {
      success: true,
      sellers: db.getSellers() || [],
      brandPrefixes: getBrandPrefixes() || {},
    };
  },

  /** Đơn hàng hiện tại đang mở trong UI (bảng giá/FOC đã tính). */
  getCurrentOrder() {
    const cur = (store.getState() || {}).currentOrder || {};
    const items = (cur.items || []).map(item => {
      const p = item.product;
      return {
        matched: !!p,
        productId: p ? p.id : null,
        productName: p ? p.name : (item.rawName || item.rawProduct || ''),
        kvCode: p ? db.getKvCode(p, item.unit) : null,
        campaignKey: p ? p.campaignKey : null,
        qty: item.qty,
        unit: item.unit,
        unitPrice: item.unitPrice || 0,
        subtotal: item.subtotal || 0,
        isGift: !!item.isGift,
        foc: jsonSafe(item.foc || null),
      };
    });
    return {
      success: true,
      customer: cur.customer || '',
      payment: cur.payment || 'ck',
      campaign: cur.aiResult ? cur.aiResult.primaryCampaign : null,
      items,
      pendingId: cur._pendingId || null,
      rawChatText: cur.rawChatText || '',
    };
  },

  /** Dump toàn bộ database (như nút "Xuất JSON" trong GUI) — object thuần. */
  exportDatabase() {
    return { success: true, data: jsonSafe(db.data) };
  },

  // ── DATA API: ghi dữ liệu (endpoint HTTP tương ứng bắt token) ────────

  /**
   * Thêm mới hoặc cập nhật sản phẩm.
   * - Có id → update các trường cho phép. Không có id → tạo mới (bắt buộc campaign).
   * - product.aliases (mảng chuỗi) → thay toàn bộ alias của SP.
   * - product.kvCode / kvCodeThung → set mã KV gốc/thùng (persist cả kv-name-map.json).
   */
  upsertProduct(payload = {}) {
    const body = payload || {};
    const data = body.product || body;
    const name = String(data.name || '').trim();
    if (!name) return { success: false, error: 'Missing "name" (tên sản phẩm)' };
    const allowed = ['name', 'spec', 'packaging', 'unit', 'category', 'box_size', 'tiers'];
    for (const k of ['tiers']) {
      if (data[k] !== undefined && !Array.isArray(data[k])) {
        return { success: false, error: `"${k}" phải là mảng` };
      }
    }

    const productId = body.id || data.id;
    if (productId) {
      const updates = {};
      for (const k of allowed) if (data[k] !== undefined) updates[k] = data[k];
      if (!Object.keys(updates).length && data.aliases === undefined
        && data.kvCode === undefined && data.kvCodeThung === undefined) {
        return { success: false, error: 'Không có trường nào để cập nhật' };
      }
      const ok = db.updateProduct(productId, updates);
      if (!ok) return { success: false, error: `Không tìm thấy sản phẩm id=${productId}` };
    } else {
      const campaignKey = body.campaign || data.campaignKey || data.campaign;
      if (!campaignKey || !db.data.campaigns[campaignKey]) {
        return { success: false, error: 'Thiếu/sai "campaign" khi tạo sản phẩm mới' };
      }
      const newProduct = { name };
      for (const k of allowed) if (k !== 'name' && data[k] !== undefined) newProduct[k] = data[k];
      const added = db.addProduct(campaignKey, newProduct);
      if (!added) return { success: false, error: 'addProduct thất bại' };
    }

    const finalId = productId || (db.getAllProducts().find(p => p.name === name) || {}).id;
    if (!finalId) return { success: false, error: 'Không xác định được sản phẩm sau khi lưu' };
    if (Array.isArray(data.aliases)) {
      const r = this.setAliases({ productId: finalId, aliases: data.aliases });
      if (!r.success) return r;
    }
    if (data.kvCode !== undefined && data.kvCode !== null) db.setKvCodeBase(finalId, String(data.kvCode).trim());
    if (data.kvCodeThung !== undefined && data.kvCodeThung !== null) db.setKvThungOverride(finalId, String(data.kvCodeThung).trim());
    return { success: true, product: serializeProduct(findProduct(finalId)) };
  },

  /** Xóa sản phẩm (tự dọn mã KV + alias trỏ về SP — cùng hành vi GUI). */
  deleteProduct({ id } = {}) {
    if (!id) return { success: false, error: 'Missing "id"' };
    const ok = db.deleteProduct(id);
    return ok ? { success: true, id } : { success: false, error: `Không tìm thấy sản phẩm id=${id}` };
  },

  /** Thêm campaign mới. key: slug (a-z0-9_). Trả lỗi nếu key đã tồn tại. */
  addCampaign(payload = {}) {
    const { key, ...data } = payload || {};
    if (!key || !/^[a-z0-9_]+$/i.test(String(key))) {
      return { success: false, error: 'Missing/invalid "key" (chỉ a-z0-9_)' };
    }
    if (!db.addCampaign(String(key), data)) {
      return { success: false, error: `Campaign "${key}" đã tồn tại hoặc db chưa sẵn sàng` };
    }
    return { success: true, key: String(key) };
  },

  /** Sửa thông tin campaign (name/brand/color/icon...). */
  updateCampaign({ key, updates } = {}) {
    if (!key || !updates || typeof updates !== 'object') {
      return { success: false, error: 'Missing "key" hoặc "updates"' };
    }
    const ok = db.updateCampaign(key, jsonSafe(updates));
    return ok ? { success: true, key } : { success: false, error: `Không tìm thấy campaign "${key}"` };
  },

  /** Xóa campaign. Mặc định từ chối khi còn sản phẩm — force:true để xóa hết. */
  deleteCampaign({ key, force } = {}) {
    if (!key) return { success: false, error: 'Missing "key"' };
    const camp = (db.data.campaigns || {})[key];
    if (!camp) return { success: false, error: `Không tìm thấy campaign "${key}"` };
    if ((camp.products || []).length > 0 && !force) {
      return { success: false, error: `Campaign "${key}" còn ${(camp.products || []).length} sản phẩm — truyền force:true để xóa cả` };
    }
    const ok = db.deleteCampaign(key);
    return ok ? { success: true, key } : { success: false, error: `Xóa campaign "${key}" thất bại` };
  },

  /**
   * Thay toàn bộ alias của một sản phẩm: alias cũ không còn trong danh sách
   * bị gỡ (kể cả đánh dấu xóa alias mặc định), alias mới được thêm.
   */
  setAliases({ productId, aliases } = {}) {
    if (!productId || !findProduct(productId)) {
      return { success: false, error: 'Missing/unknown "productId"' };
    }
    if (!Array.isArray(aliases)) return { success: false, error: '"aliases" phải là mảng chuỗi' };
    const target = [...new Set(aliases.map(a => String(a).toLowerCase().trim()).filter(Boolean))];
    const current = (db.getAliasesForProduct(productId) || []).map(a => a.alias);
    for (const a of current) if (!target.includes(a)) db.removeAlias(a);
    for (const a of target) if (!current.includes(a)) db.addAlias(a, productId);
    return {
      success: true,
      productId,
      aliases: (db.getAliasesForProduct(productId) || []).map(x => ({ alias: x.alias, isDefault: x.isDefault })),
    };
  },

  /**
   * Set mã KiotViet cho sản phẩm: base (đơn vị lẻ) và/hoặc thùng (override).
   * Chuỗi rỗng = xóa (thùng về tự phân mã gốc+'-1'). Persist cả kv-name-map.json.
   */
  setKvCode({ productId, base, thung } = {}) {
    if (!productId || !findProduct(productId)) {
      return { success: false, error: 'Missing/unknown "productId"' };
    }
    if (base === undefined && thung === undefined) {
      return { success: false, error: 'Cần ít nhất "base" hoặc "thung"' };
    }
    if (base !== undefined && base !== null) db.setKvCodeBase(productId, String(base).trim());
    if (thung !== undefined && thung !== null) db.setKvThungOverride(productId, String(thung).trim());
    const p = findProduct(productId);
    return { success: true, productId, kvCode: serializeProduct(p).kvCode, kvCodeThung: serializeProduct(p).kvCodeThung };
  },

  /** Ghi bộ nhớ quy tắc AI (text). */
  setMemory({ text } = {}) {
    db.saveMemory(String(text == null ? '' : text));
    return { success: true, memory: db.getMemory() || '' };
  },

  /** Lưu danh sách sellers và/hoặc tiền tố mã đơn theo brand. */
  saveSellers({ sellers, brandPrefixes } = {}) {
    if (sellers !== undefined && !Array.isArray(sellers)) {
      return { success: false, error: '"sellers" phải là mảng' };
    }
    if (brandPrefixes !== undefined && (typeof brandPrefixes !== 'object' || brandPrefixes === null)) {
      return { success: false, error: '"brandPrefixes" phải là object' };
    }
    if (Array.isArray(sellers)) db.saveSellers(sellers);
    if (brandPrefixes) saveBrandPrefixes(brandPrefixes);
    return this.getSellers();
  },

  /** Nhập database từ JSON export (cùng cấu trúc tool export_database MCP). */
  importDatabase({ data } = {}) {
    if (!data) return { success: false, error: 'Missing "data"' };
    const json = typeof data === 'string' ? data : JSON.stringify(data);
    const ok = db.importJSON(json);
    return ok ? { success: true } : { success: false, error: 'JSON không hợp lệ hoặc cấu trúc không khớp' };
  },

  /** Reset database về mặc định gốc (xóa mọi SP/alias tự thêm) — DESTRUCTIVE. */
  async resetDatabase() {
    await db.reset();
    return { success: true };
  },

  // ── EXPORT EXCEL headless ────────────────────────────────────────────

  /**
   * Xuất Excel headless cho agent ngoài — KHÔNG đụng DOM/UI:
   * resolve từng dòng → nhóm theo brand → payload giống GUI → gọi IPC
   * exportOrder (main process spawn Python win32com ghi file thật).
   *
   * orderData: { customer, payment?, orderDate?, seller?, discount?, note?,
   *              dryRun?, giftsExpanded?, items: [{ id?|code?|name?, qty, unit?, price?, isGift? }] }
   * Dòng hàng resolve theo thứ tự: product id → mã KV (base/thùng) → tên chính xác → fuzzy.
   * Giá: item.price nếu có, ngược lại theo bậc số lượng. FOC/MKT quà tự sinh dòng isGift.
   * giftsExpanded:true → items đã chứa đủ dòng quà, KHÔNG sinh thêm lần nữa.
   * dryRun:true → chỉ trả payload dự kiến, không ghi file.
   */
  async exportOrderToExcel(orderData) {
    const od = orderData || {};
    const customer = String(od.customer || od.customerName || '').trim();
    if (!customer) return { success: false, error: 'Missing "customer"' };
    const items = Array.isArray(od.items) ? od.items : [];
    if (!items.length) return { success: false, error: 'Missing "items"' };

    // ── Resolve từng dòng → product ────────────────────────────────────
    const allProducts = db.getAllProducts();
    const resolved = [];
    for (const it of items) {
      const qty = Number(it.qty);
      if (!qty || qty <= 0 || !Number.isFinite(qty)) {
        return { success: false, error: 'Item qty không hợp lệ: ' + JSON.stringify(it) };
      }
      const unit = normalizeUnit(it.unit);
      const isBox = unit === 'thùng';
      let product = null;
      if (it.id) product = findProduct(String(it.id));
      if (!product && it.code) {
        const code = String(it.code).trim();
        product = allProducts.find(p => {
          const base = (db.kvCodeMap[p.id] || p.kvCode || '').toString().trim();
          const thung = db.getKvCode(p, 'thùng').toString().trim();
          return (base && base === code) || (thung && thung === code);
        }) || null;
      }
      if (!product && it.name) {
        const nName = normalizeFull(String(it.name));
        product = allProducts.find(p => normalizeFull(p.name) === nName) || null;
      }
      if (!product && (it.name || it.rawProduct)) {
        const m = findBestProductMatch(String(it.name || it.rawProduct), allProducts, db.getAliases(), unit);
        product = m ? m.product : null;
      }
      if (!product) {
        return { success: false, error: `Không nhận diện được sản phẩm cho dòng: ${JSON.stringify(it)}` };
      }
      resolved.push({ it, product, unit, isBox, qty });
    }

    // ── Nhóm theo brand + dựng rows (hàng chính + FOC) ─────────────────
    // giftsExpanded:true = caller ĐÃ bung dòng quà (parseOrderToRunFormat) →
    // KHÔNG bung lại lần hai, nếu không mỗi dòng FOC/MKT bị xuất 2 lần
    // (luồng auto_run_order action:'both' truyền thẳng output của nó vào đây).
    const expandGifts = !od.giftsExpanded;
    const groups = {};
    const campTotals = {};
    for (const r of resolved) {
      const calc = calculateOrderItem(r.product, r.qty, r.unit);
      let unitPrice = calc.unitPrice;
      if (!r.it.isGift && r.it.price !== undefined && r.it.price !== null) {
        unitPrice = getFinalUnitPrice(r.product, Number(r.it.price), r.isBox);
      }
      const campaignKey = r.product.campaignKey;
      const camp = (db.data.campaigns || {})[campaignKey] || {};
      const brand = camp.brand || campaignKey || 'zentor';
      if (!groups[brand]) groups[brand] = [];
      const bs = Number(r.product.box_size) || 1;
      groups[brand].push({
        rawProduct: r.product.name,
        qty: r.qty,
        unit: r.unit,
        product: {
          name: r.product.name, spec: r.product.spec, category: r.product.category,
          box_size: r.product.box_size, tiers: r.product.tiers,
        },
        unitPrice: r.it.isGift ? 0 : unitPrice,
        isGift: !!r.it.isGift,
        focSource: null,
        campaignKey,
      });
      if (expandGifts && !r.it.isGift) {
        // Tổng phục vụ mốc MKT (quà FOC không cộng tổng thùng — đúng quy ước app)
        if (!campTotals[campaignKey]) campTotals[campaignKey] = { amount: 0, boxes: 0, brand };
        campTotals[campaignKey].amount += unitPrice * (r.isBox ? r.qty * bs : r.qty);
        campTotals[campaignKey].boxes += r.isBox ? r.qty : r.qty / bs;
        // Quà FOC theo rule của SP (calc.foc là MẢNG rule thỏa điều kiện)
        for (const foc of (calc.foc || [])) {
          const giftProduct = findProduct(foc.give_product);
          groups[brand].push({
            rawProduct: giftProduct ? giftProduct.name : (foc.note || foc.give_product),
            qty: foc.total_give,
            unit: foc.give_unit || (giftProduct ? giftProduct.unit : 'chai'),
            product: giftProduct ? {
              name: giftProduct.name, spec: giftProduct.spec, category: giftProduct.category,
              box_size: giftProduct.box_size, tiers: giftProduct.tiers,
            } : null,
            unitPrice: minTierPrice(giftProduct),
            isGift: true,
            focSource: giftProduct ? 'campaign' : 'manual',
            giftKind: 'FOC',
            campaignKey,
          });
        }
      }
    }

    // ── Quà MKT theo mốc tổng tiền/tổng thùng từng campaign ────────────
    // (khối trên không bung → campTotals rỗng → vòng lặp này là no-op)
    for (const [campaignKey, tot] of Object.entries(campTotals)) {
      const mkt = db.getMKTGifts(campaignKey, tot.amount, tot.boxes);
      if (!mkt || !Array.isArray(mkt.gifts)) continue;
      // [Promo v1.3.0] Rule total scope campaign có label tự sinh + gifts[] link productId
      for (const g of mkt.gifts) {
        const giftProduct = g.productId ? findProduct(g.productId) : null;
        groups[tot.brand].push({
          rawProduct: giftProduct ? giftProduct.name : (g.name || g.productId || 'Quà MKT'),
          qty: g.qty || 1,
          unit: (giftProduct ? giftProduct.unit : '') || 'cái',
          product: giftProduct ? {
            name: giftProduct.name, spec: giftProduct.spec, category: giftProduct.category,
            box_size: giftProduct.box_size, tiers: giftProduct.tiers,
          } : null,
          unitPrice: minTierPrice(giftProduct),
          isGift: true,
          focSource: giftProduct ? 'campaign' : 'manual',
          giftKind: 'MKT',
          ruleId: mkt.id,
          ruleType: 'total',
          milestone: mkt.threshold || null,
          campaignKey,
        });
      }
    }

    // ── Dựng payload từng brand (khớp cấu trúc GUI export) ─────────────
    const now = new Date();
    const orderDate = od.orderDate
      || `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
    const sellerName = String(od.seller || '');
    const discount = String(od.discount || '');
    const payment = String(od.payment || 'ck');

    // STT PO: chỉ peek khi dựng payload — bộ đếm CHỈ tăng sau khi ghi file
    // thành công (dryRun/preview KHÔNG được đốt số).
    const seqByBrand = {};
    const payloads = Object.entries(groups).map(([brand, rows]) => {
      const seq = peekOrderSequence(brand);
      seqByBrand[brand] = seq;
      return {
        brand,
        customerName: customer,
        orderDate,
        orderTitle: generateOrderTitle(brand, sellerName, discount, seq),
        tlnText: buildTlnText(customer, rows, payment, od.note),
        items: rows.map(({ campaignKey, ...item }) => item),
      };
    });

    if (od.dryRun) return { success: true, dryRun: true, payloads };

    if (typeof window === 'undefined' || !window.electronAPI || !window.electronAPI.exportOrder) {
      return { success: false, error: 'Xuất Excel chỉ chạy trong app Desktop (thiếu electronAPI.exportOrder)' };
    }

    // ── Ghi file thật qua IPC (từng brand, giống GUI) ──────────────────
    const results = [];
    for (const payload of payloads) {
      try {
        const res = await window.electronAPI.exportOrder(payload);
        if (res && res.success) {
          // Ghi file thành công mới tăng bộ đếm PO lên đúng STT đã dùng
          commitOrderSequence(payload.brand, seqByBrand[payload.brand]);
        }
        results.push(res && res.success
          ? { brand: payload.brand, ok: true, filePath: res.filePath, created: res.created, opened: res.opened }
          : { brand: payload.brand, ok: false, error: (res && res.error) || 'Lỗi không xác định' });
      } catch (err) {
        results.push({ brand: payload.brand, ok: false, error: 'Lỗi IPC exportOrder — ' + (err && err.message || err) });
      }
    }
    const allOk = results.length > 0 && results.every(r => r.ok);
    return { success: allOk, results };
  },

  /**
   * Parse đơn hàng từ raw sales text và chuẩn hóa thành format sẵn sàng
   * chạy thẳng KiotViet (runDirectOrder) hoặc xuất Excel (exportOrderToExcel).
   * Tự tính toán đầy đủ mốc giá thùng/chai, FOC quà và quà MKT theo tổng đơn.
   * Đồng thời đồng bộ vào store/GUI để người dùng nhìn thấy trên màn hình.
   */
  async parseOrderToRunFormat(text, opts = {}) {
    try {
      const mode = opts.mode || 'auto';
      let parseRes;
      if (mode === 'offline') {
        parseRes = this.parseOffline(text);
      } else if (mode === 'ai') {
        parseRes = await this.parseWithAI(text);
      } else {
        parseRes = await this.parse(text);
      }

      if (!parseRes || !parseRes.success || !parseRes.order) {
        return { success: false, error: (parseRes && parseRes.error) || 'Không phân tích được đơn hàng' };
      }

      const order = parseRes.order;
      const allProducts = db.getAllProducts();

      // Chuẩn hóa danh sách items từ kết quả parse sang format thực thi
      const executionItems = [];
      const campTotals = {};

      for (const it of (order.items || [])) {
        let product = null;
        if (it.kvCode) {
          const code = String(it.kvCode).trim();
          product = allProducts.find(p => {
            const base = (db.kvCodeMap[p.id] || p.kvCode || '').toString().trim();
            const thung = db.getKvCode ? db.getKvCode(p, 'thùng').toString().trim() : '';
            return (base && base === code) || (thung && thung === code);
          });
        }
        if (!product && it.productName) {
          const nName = normalizeFull(String(it.productName));
          product = allProducts.find(p => normalizeFull(p.name) === nName);
        }
        if (!product && (it.rawProduct || it.productName)) {
          const m = findBestProductMatch(String(it.rawProduct || it.productName), allProducts, db.getAliases(), it.unit);
          product = m ? m.product : null;
        }

        const isBox = (it.unit === 'thùng');
        const bs = product ? (Number(product.box_size) || 1) : 1;
        const resolvedKvCode = product ? (db.getKvCode ? db.getKvCode(product, it.unit) : (product.kvCode || '')) : (it.kvCode || '');

        executionItems.push({
          code: resolvedKvCode,
          name: product ? product.name : (it.productName || it.rawProduct || ''),
          qty: it.qty,
          unit: it.unit,
          price: it.unitPrice || 0,
          subtotal: it.subtotal || ((it.unitPrice || 0) * (isBox ? it.qty * bs : it.qty)),
          isGift: !!it.isGift,
          tierLabel: it.tierLabel || '',
          productId: product ? product.id : null,
          campaignKey: product ? product.campaignKey : null,
        });

        // Tính tổng tiền/thùng cho quà MKT
        if (!it.isGift && product && product.campaignKey) {
          const ck = product.campaignKey;
          if (!campTotals[ck]) campTotals[ck] = { amount: 0, boxes: 0 };
          campTotals[ck].amount += (it.unitPrice || 0) * (isBox ? it.qty * bs : it.qty);
          campTotals[ck].boxes += isBox ? it.qty : it.qty / bs;

          // Thêm quà FOC từ rule sản phẩm nếu có
          if (it.foc && Array.isArray(it.foc)) {
            for (const f of it.foc) {
              const giftProd = findProduct(f.give_product);
              const giftCode = giftProd ? (db.getKvCode ? db.getKvCode(giftProd, f.give_unit || 'chai') : (giftProd.kvCode || '')) : '';
              executionItems.push({
                code: giftCode,
                name: giftProd ? giftProd.name : (f.note || f.give_product),
                qty: f.total_give || 1,
                unit: f.give_unit || (giftProd ? giftProd.unit : 'chai'),
                price: 0,
                subtotal: 0,
                isGift: true,
                tierLabel: f.ruleType === 'total' ? 'MKT' : 'FOC',
                productId: giftProd ? giftProd.id : null,
                ruleId: f.ruleId || null,
                ruleType: f.ruleType || 'qty',
                campaignKey: ck,
              });
            }
          }
        }
      }

      // Thêm quà MKT theo mốc chiến dịch
      for (const [campaignKey, tot] of Object.entries(campTotals)) {
        const mkt = db.getMKTGifts ? db.getMKTGifts(campaignKey, tot.amount, tot.boxes) : null;
        if (!mkt || !Array.isArray(mkt.gifts)) continue;
        for (const g of mkt.gifts) {
          const giftProd = g.productId ? findProduct(g.productId) : null;
          const giftCode = giftProd ? (db.getKvCode ? db.getKvCode(giftProd, giftProd.unit || 'cái') : (giftProd.kvCode || '')) : '';
          executionItems.push({
            code: giftCode,
            name: giftProd ? giftProd.name : (g.name || g.productId || 'Quà MKT'),
            qty: g.qty || 1,
            unit: (giftProd ? giftProd.unit : '') || 'cái',
            price: 0,
            subtotal: 0,
            isGift: true,
            tierLabel: 'MKT',
            productId: giftProd ? giftProd.id : null,
            ruleId: mkt.id,
            ruleType: 'total',
            campaignKey,
          });
        }
      }

      const grandTotal = executionItems.reduce((sum, i) => sum + (i.subtotal || 0), 0);
      const readyOrderData = {
        customer: order.customer || '',
        payment: order.payment || 'ck',
        // Người nhận đặt: đường GUI lấy từ form; đường headless lấy từ opts.seller
        // (trước đây field này KHÔNG tồn tại → up đơn qua MCP bỏ trống bước chọn
        // người nhận trên KiotViet).
        receiver: resolveSellerReceiver(opts.seller || opts.salesman || ''),
        notes: order.notes || '',
        grandTotal,
        items: executionItems,
      };

      // Đồng bộ vào store giao diện nếu có store (GUI hiển thị ngay lập tức)
      try {
        if (typeof store !== 'undefined' && store.setState) {
          store.setState({ currentOrder: readyOrderData });
        }
      } catch (_) {}

      return {
        success: true,
        mode: parseRes.mode,
        // CỜ `giftsExpanded` chỉ gắn ở đây, KHÔNG vào store: các dòng isGift đã
        // bung đủ phía trên nên exportOrderToExcel (luồng action:'both') không
        // sinh lại lần hai. Snapshot đơn chờ duyệt không được mang cờ này —
        // items của snapshot không chứa dòng quà sinh tự, export vẫn phải bung.
        orderData: { ...readyOrderData, giftsExpanded: true },
      };
    } catch (e) {
      return { success: false, error: 'parseOrderToRunFormat error: ' + e.message };
    }
  },
};

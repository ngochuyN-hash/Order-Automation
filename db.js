// DATABASE QUY CHUẨN - ORDER AUTOMATION v2
// Cập nhật theo chuẩn Exact Match 100% với Master Data Excel

// Import tường minh thay vì dựa vào global window.dbStore — để module chạy
// đúng cả trong renderer (Vite) lẫn Node (test) và tránh lỗi "dbStore is not defined".
import { dbStore } from './db-store.js';
import { createLogger } from './src/logger.js';
import defaultDbData from './default-db.json' with { type: 'json' };
import defaultAliases from './default-aliases.json' with { type: 'json' };
import internalCodes from './internal-codes.json' with { type: 'json' };
import defaultMemory from './default-memory.json' with { type: 'json' };
import aiClassifier from './ai-classifier.json' with { type: 'json' };

const _dbLog = createLogger('DB');

// Nội dung bộ nhớ mặc định (chứa ví dụ tên hàng hóa nội bộ) đã tách sang
// default-memory.json — file local-only KHÔNG nằm trong git/GitHub.
const DEFAULT_MEMORY = defaultMemory.memory;

// Rules phân loại AI (chứa từ khóa tên hàng hóa nội bộ) đã tách sang ai-classifier.json —
// file local-only KHÔNG nằm trong git/GitHub.
const AI_CLASSIFIER = aiClassifier.rules;

// Dữ liệu danh mục + giá đã tách sang default-db.json (file local-only, KHÔNG nằm trong git/GitHub).
// db.js chỉ giữ logic; Vite nhúng default-db.json vào bundle dist khi build:renderer nên installer vẫn đủ dữ liệu.
// Cập nhật dữ liệu: sửa default-db.json, hoặc "Xuất database" trong app + npm run sync:default-db.
const DEFAULT_DB = defaultDbData;

// Danh sách alias mặc định (tên hàng hóa nội bộ) đã tách sang default-aliases.json —
// file local-only KHÔNG nằm trong git/GitHub. db.js import trực tiếp.
const DEFAULT_ALIASES = defaultAliases;


/**
 * Classify an order text to determine which campaign it belongs to.
 * Returns: { primaryCampaign, campaignLabel, confidence, allScores, detectedPayment }
 */
function classifyOrder(text) {
  const normalized = text.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/Ä‘/g, 'd')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

  const scores = {};
  let maxScore = 0;
  let bestCampaign = null;
  let bestLabel = '';
  let bestColor = '';

  for (const rule of AI_CLASSIFIER.rules) {
    let score = 0;

    // Check keywords (high weight)
    for (const kw of rule.keywords) {
      const kwNorm = kw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/Ä‘/g, 'd');
      if (normalized.includes(kwNorm)) {
        score += rule.weight * 2;
      }
    }

    // Check spec keywords (medium weight)
    for (const kw of rule.specKeywords) {
      const kwNorm = kw.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (normalized.replace(/[^a-z0-9]/g, '').includes(kwNorm)) {
        score += rule.weight;
      }
    }

    // Check context keywords (lower weight)
    for (const kw of rule.contextKeywords) {
      const kwNorm = kw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/Ä‘/g, 'd');
      if (normalized.includes(kwNorm)) {
        score += rule.weight * 0.5;
      }
    }

    // Penalty for exclude keywords
    for (const kw of (rule.excludeKeywords || [])) {
      const kwNorm = kw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/Ä‘/g, 'd');
      if (normalized.includes(kwNorm)) {
        score -= rule.weight * 1.5;
      }
    }

    scores[rule.campaign] = Math.max(0, score);

    if (score > maxScore) {
      maxScore = score;
      bestCampaign = rule.campaign;
      bestLabel = rule.label;
      bestColor = rule.color;
    }
  }

  const totalScore = Object.values(scores).reduce((s, v) => s + v, 0);
  const confidence = totalScore > 0 ? Math.min(maxScore / totalScore, 1) : 0;

  // Detect payment
  let detectedPayment = null;
  for (const [method, keywords] of Object.entries(AI_CLASSIFIER.paymentKeywords)) {
    for (const kw of keywords) {
      const kwNorm = kw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/Ä‘/g, 'd');
      if (normalized.includes(kwNorm)) {
        detectedPayment = method;
        break;
      }
    }
    if (detectedPayment) break;
  }

  return {
    primaryCampaign: bestCampaign,
    campaignLabel: bestLabel,
    campaignColor: bestColor,
    confidencePercent: Math.round(confidence * 100),
    confidence: confidence,
    allScores: scores,
    detectedPayment: detectedPayment
  };
}

// QUAN TRỌNG: KHÔNG bump version này để ép reset DB — việc đồng bộ cấu trúc mới
// (4 brand sau rebrand 24/08) được xử lý TỰ ĐỘNG qua migration trong init()
// (_needsRebrandMigration), không cần đổi key hay xóa storage thủ công.
const DB_STORAGE_KEY = 'oa_db_v9';
// [Rebrand 24/08] Campaign cũ đã gộp theo 4 brand (xvil/zentor/torvex/veltron).
// Storage còn chứa 1 trong các key dưới đây = dữ liệu TRƯỚC rebrand → init() thay
// bằng DEFAULT_DB mới; đơn hàng/memory/sellers nằm ở key riêng nên không bị ảnh hưởng.
const REBRAND_LEGACY_CAMPAIGN_KEYS = ['znt_mxo', 'znt_pcmo', 'veltron_npp', 'veltron_workshop', 'tvx_reseller'];
// [Task #9] Mirror ĐỒNG BỘ (localStorage) của DB — ghi trong flushSave() mỗi lần flush,
// khôi phục trong init() CHỈ khi IndexedDB không có dữ liệu hợp lệ (fallback chống mất dữ liệu
// khi force-close/crash trước khi transaction IndexedDB kịp commit). Cùng pattern backup của saveAliases.
const DB_MIRROR_KEY = 'oa_db_v9_mirror';
const ALIAS_STORAGE_KEY = 'oa_alias_v4';
const ALIAS_REMOVED_KEY = 'oa_alias_removed_v1';
const MEMORY_STORAGE_KEY = 'oa_memory_v4';
const SELLERS_STORAGE_KEY = 'oa_sellers_v1';

// ─────────────────────────────────────────────────────────────────────────────
// [Promo v1.3.0] SCHEMA KHUYẾN MÃI THỐNG NHẤT (campaign.promoRules[])
// Mọi quy tắc KM — quà theo số lượng mua (type:'qty'), quà theo mốc tổng
// (type:'total'), resolver tên quà khai text (type:'text') — gộp về MỘT mảng
// trên mỗi campaign. Mốc LUÔN là số (buy.qty / threshold.min-max), quà LUÔN
// link mã sản phẩm (gifts[].productId), label TỰ SINH từ số (không nhập chữ):
//   { id, type, scope:'product'|'campaign', enabled, kind:'foc'|'mkt_pp'|'mkt'|'text',
//     productId?, buy?:{qty,unit}, threshold?:{min,max,basis:'money'|'boxes'},
//     gifts:[{qty, productId, unit?, options?, subOptions?, name?}],
//     keywords?, unitHint?, defaultQty?, global?, label, note, needs_review? }
// Dữ liệu cũ (campaign.mkt_gift_rules, product.foc_rules, product.mkt_gift_rules,
// campaign.promoTextRules) được migrate MỘT LẦN qua migratePromoRules() ở boot —
// heuristic đoán quà từ câu chữ chỉ chạy lúc migrate, KHÔNG chạy ở runtime.
// ─────────────────────────────────────────────────────────────────────────────
const PROMO_RULES_VERSION = 3;

// [v1.3.3] Rà mốc quà MKT Zentor — gate cho _applyZentorMktFix() (chạy ĐÚNG 1
// LẦN). Trước 1.3.3 hàm này chạy MỖI boot không gated: user bớt/thêm sản phẩm-quà
// trong CTKM Zentor là boot sau bị thay nguyên bộ total rules bằng seed. Muốn áp
// LẠI seed Zentor khi đổi bảng seed → bump số này lên (pattern priceVersion).
const ZNT_MKT_FIX_VERSION = 1;
// [v1.3.3] Backup DB NGUYÊN TRẠNG trước mọi migration ở mỗi boot (rolling N bản,
// KHÔNG có UI). Khôi phục khẩn cấp: dbStore.get(DB_BACKUP_KEY) → chọn bản cần →
// dbStore.set(DB_STORAGE_KEY, bản.data).
const DB_BACKUP_KEY = 'oa_db_preboot_backups';
const MAX_PRE_MIGRATION_BACKUPS = 3;

function _promoBaseId(cid, type, idx) {
  return `promo_${cid}_${type}_${idx + 1}`;
}

function _pickGearOil(product) {
  if (!product) return 'torvex_gear_oil';
  if (product.campaignKey === 'torvex' || String(product.id || '').startsWith('torvex')) return 'torvex_gear_oil';
  if (product.campaignKey && String(product.campaignKey).includes('veltron')) return 'veltron_veltron_scooter_gear_oil_sae_80w_90';
  return 'torvex_gear_oil';
}

/**
 * Giải mã quà khi rule cũ thiếu give_product (theo give_unit/note) —
 * CHỈ chạy trong migratePromoRules, không bao giờ chạy ở runtime.
 */
function resolveGiveProduct(rule, product) {
  const unit = String(rule.give_unit || '').toLowerCase().trim();
  const note = String(rule.note || '').toLowerCase().trim();
  if (unit === 'bom' || unit === 'bơm') return 'oil_pump';
  if (unit === 'tuýp' || unit === 'tuyp') return _pickGearOil(product);
  if (unit === 'lon' || unit === 'chai' || unit === 'can' || unit === 'lít' || unit === 'lit') return product ? product.id : '';
  if (unit === 'túi' || unit === 'tui') return 'stringbag';
  if (note.includes('hộp số') || note.includes('hop so')) return _pickGearOil(product);
  if (note.includes('túi') || note.includes('tui')) return 'stringbag';
  if (note.includes('summerscreen') || note.includes('display')) return 'veltron_veltron_display_summerscreen_konz_1_100_orange';
  return product ? product.id : '';
}

function _migrateGiftItems(items) {
  const out = [];
  for (const g of (Array.isArray(items) ? items : [])) {
    if (!g) continue;
    const gift = { qty: Number(g.qty) || 1, productId: g.product_id || (g.productId || '') };
    if (g.name) gift.name = g.name;
    if (Array.isArray(g.give_product_options)) gift.options = g.give_product_options;
    if (g.give_product_sub_options) gift.subOptions = g.give_product_sub_options;
    out.push(gift);
  }
  return out;
}

/**
 * Migrate dữ liệu KM cũ → schema promoRules thống nhất. THUẦN (không đụng
 * class/UI/store) — chạy được cả trong Node (test + chuyển DEFAULT_DB).
 * Idempotent: data đã có promoRulesVersion >= PROMO_RULES_VERSION → no-op.
 * @returns {boolean} true nếu có thay đổi
 */
function migratePromoRules(data) {
  if (!data || !data.campaigns) return false;
  if (Number(data.promoRulesVersion || 0) >= PROMO_RULES_VERSION) return false;
  let changed = false;
  for (const [cid, campaign] of Object.entries(data.campaigns)) {
    if (!campaign || typeof campaign !== 'object') continue;
    const rules = Array.isArray(campaign.promoRules) ? campaign.promoRules : [];
    // 1) campaign.mkt_gift_rules — mốc quà theo tổng đơn (tiền hoặc số thùng)
    if (campaign.mkt_gift_rules !== undefined) {
      if (Array.isArray(campaign.mkt_gift_rules) && campaign.mkt_gift_rules.length) {
        campaign.mkt_gift_rules.forEach((r, i) => {
          rules.push({
            id: _promoBaseId(cid, 'total', i),
            type: 'total', scope: 'campaign', enabled: true, kind: 'mkt',
            threshold: { min: Number(r.min_total) || 0, max: Number(r.max_total) || 0, basis: r.unit === 'boxes' ? 'boxes' : 'money' },
            gifts: _migrateGiftItems(r.gift_items),
            label: '', note: r.note || r.label || '',
            needs_review: !Array.isArray(r.gift_items) || r.gift_items.length === 0
          });
        });
      }
      delete campaign.mkt_gift_rules;
      changed = true;
    }
    // 2) product.foc_rules (kind 'foc') + product.mkt_gift_rules (kind 'mkt_pp') — mua X tặng Y
    for (const p of (Array.isArray(campaign.products) ? campaign.products : [])) {
      if (!p || typeof p !== 'object') continue;
      if (p.foc_rules !== undefined) {
        if (Array.isArray(p.foc_rules)) {
          p.foc_rules.forEach((r, i) => {
          const giftPid = r.give_product === '__same__' ? '__same__' : (r.give_product || resolveGiveProduct(r, p));
          const gift = { qty: Number(r.give_qty) || 1, productId: giftPid };
          if (r.give_unit) gift.unit = r.give_unit;
          if (Array.isArray(r.give_product_options)) gift.options = r.give_product_options;
          if (r.give_product_sub_options) gift.subOptions = r.give_product_sub_options;
          rules.push({
            id: _promoBaseId(cid, 'qty', i),
            type: 'qty', scope: 'product', enabled: true, kind: 'foc',
            productId: p.id,
            buy: { qty: Number(r.buy_qty) || 1, unit: r.buy_unit || '' },
            gifts: [gift],
            label: '', note: r.note || '',
            // Chỉ đánh dấu review khi KHÔNG có tín hiệu xác định (thiếu cả mã lẫn đơn vị)
            needs_review: !r.give_product && !r.give_unit
          });
        });
        }
        delete p.foc_rules;
        changed = true;
      }
      if (p.mkt_gift_rules !== undefined) {
        if (Array.isArray(p.mkt_gift_rules)) {
        p.mkt_gift_rules.forEach((r, i) => {
          const gift = { qty: Number(r.give_qty) || 1, productId: r.give_product || '' };
          if (r.give_unit) gift.unit = r.give_unit;
          if (r.give_product_name) gift.name = r.give_product_name;
          if (Array.isArray(r.give_product_options)) gift.options = r.give_product_options;
          if (r.give_product_sub_options) gift.subOptions = r.give_product_sub_options;
          rules.push({
            id: _promoBaseId(cid, 'mkt_pp', i),
            type: 'qty', scope: 'product', enabled: true, kind: 'mkt_pp',
            productId: p.id,
            buy: { qty: Number(r.buy_qty) || 1, unit: r.buy_unit || '' },
            gifts: [gift],
            label: '', note: r.note || '',
            needs_review: !r.give_product
          });
        });
        }
        delete p.mkt_gift_rules;
        changed = true;
      }
    }
    // 3) campaign.promoTextRules — resolver tên quà khai text → sản phẩm quà
    if (campaign.promoTextRules !== undefined) {
      if (Array.isArray(campaign.promoTextRules)) {
      campaign.promoTextRules.forEach((r, i) => {
        const pid = r.productId || '';
        rules.push({
          id: r.id || _promoBaseId(cid, 'text', i),
          type: 'text', enabled: r.enabled !== false, kind: 'text',
          keywords: Array.isArray(r.keywords) ? r.keywords : [],
          unitHint: r.unitHint || '',
          global: r.global === true,
          defaultQty: Number(r.defaultQty) || 1,
          gifts: [{ qty: Number(r.defaultQty) || 1, productId: pid }],
          label: r.label || '', note: r.note || '',
          needs_review: !pid
        });
      });
      }
      delete campaign.promoTextRules;
      changed = true;
    }
    if (rules.length > 0) { campaign.promoRules = rules; changed = true; }
  }
  if (changed) data.promoRulesVersion = PROMO_RULES_VERSION;
  return changed;
}

class ProductDatabase {
  constructor() {
    this.data = null;
    this.customAliases = {};
    this.removedDefaultAliases = {}; // Aliases mặc định đã bị người dùng xóa — không cho hồi sinh
    this.memory = '';
    this.kvCodeMap = {}; // productId → kvCode fallback lookup
    this.kvCodeThungMap = {}; // productId → kvCodeThung override (ghi đè mã thùng, mặc định: mã gốc + '-1')
    this._saveTimer = null; // [Perf phase 2] timer debounce của save()
    this._flushListenersRegistered = false; // guard đăng ký listener flush 1 lần
    this._lastPersistError = null; // lỗi persist gần nhất (null = lành) — xem getLastPersistError()
    this.sellers = []; // Người nhận đặt (persisted to IndexedDB)
    // ── Memoization cache cho accessor (invalidate qua _dataVersion) ──
    this._dataVersion = 0;
    this._allProductsCache = null;
    this._allProductsCacheVersion = -1;
    this._productByIdMap = null;
    this._productByIdMapVersion = -1;
  }

  /** Tăng version của data → invalidate memo cache của getAllProducts/findProductById. */
  _bumpDataVersion() { this._dataVersion++; }

  /**
   * [Rebrand 24/08] DB lưu trong storage còn chứa campaign legacy (znt_mxo, znt_pcmo,
   * veltron_npp, veltron_workshop, tvx_reseller) → là dữ liệu TRƯỚC khi gộp theo 4 brand.
   * @returns {boolean} true nếu cần thay data bằng DEFAULT_DB (4 brand)
   */
  _needsRebrandMigration(data) {
    if (!data || !data.campaigns) return false;
    return REBRAND_LEGACY_CAMPAIGN_KEYS.some(k => Object.prototype.hasOwnProperty.call(data.campaigns, k));
  }

  /**
   * [Price seed 06/09] Migration bảng giá theo phiên bản: khi DEFAULT_DB.priceVersion
   * khác priceVersion đã lưu trên máy (db cũ → seed mới) → seed thuộc tính bảng giá từ
   * DEFAULT_DB vào this.data. Cần thiết vì init() ưu tiên db đã lưu trong IndexedDB —
   * không có bước này thì máy cũ cài đè bộ cài mới sẽ KHÔNG bao giờ thấy giá mới.
   * Phạm vi seed: name/spec/packaging/unit/box_size/tiers/foc_rules/mkt_gift_rules
   * của SP trùng id (giá + chính sách khuyến mãi là chuẩn theo bảng giá mới);
   * SP có trong seed mà máy chưa có → bổ sung vào campaign; campaign chưa có → clone từ seed.
   * KHÔNG đụng: kvCode (bất biến #2 — cơ chế riêng _reconcileKvCatalogSeeds lo),
   * alias, sản phẩm user tự thêm ngoài catalog, đơn hàng, cấu hình AI.
   * @returns {boolean} true nếu đã áp seed (caller cần persist + refresh UI)
   */
  _applyPriceSeedMigration() {
    const target = String(DEFAULT_DB.priceVersion || '').trim();
    if (!target || !this.data || !this.data.campaigns) return false;
    if (String(this.data.priceVersion || '').trim() === target) return false;
    let seeded = 0, added = 0;
    for (const [cid, seedCampaign] of Object.entries(DEFAULT_DB.campaigns || {})) {
      const campaign = this.data.campaigns[cid];
      if (!campaign) {
        // Campaign chưa tồn tại trên máy (brand mới) → clone nguyên từ seed
        this.data.campaigns[cid] = JSON.parse(JSON.stringify(seedCampaign));
        seeded += (seedCampaign.products || []).length;
        added += (seedCampaign.products || []).length;
        continue;
      }
      campaign.name = seedCampaign.name;
      if (!Array.isArray(campaign.products)) campaign.products = [];
      const byId = new Map(campaign.products.map(p => [p.id, p]));
      for (const seedProduct of (seedCampaign.products || [])) {
        const product = byId.get(seedProduct.id);
        if (product) {
          // [Promo v1.3.0] foc_rules/mkt_gift_rules đã gộp vào campaign.promoRules (migratePromoRules)
          for (const field of ['name', 'spec', 'packaging', 'unit', 'box_size', 'tiers']) {
            if (seedProduct[field] !== undefined) {
              product[field] = JSON.parse(JSON.stringify(seedProduct[field]));
            }
          }
          seeded++;
        } else {
          campaign.products.push(JSON.parse(JSON.stringify(seedProduct)));
          added++;
        }
      }
      // [Promo v1.3.0][v1.3.3] Khi seed bảng giá mới từ DEFAULT_DB, refresh KM qty theo
      // từng SP trong catalog seed (bỏ rule đã bị gỡ khỏi bảng giá mới, VD: DD súc
      // rửa 10W30). GIỮ NGUYÊN: rule 'total' scope campaign và rule 'text' do user
      // đăng ký, rule của SP ngoài catalog, và rule qty của SP catalog mà seed KHÔNG
      // định nghĩa rule (trước 1.3.3 filter theo productId vứt mất các rule này).
      if (Array.isArray(seedCampaign.promoRules) && seedCampaign.promoRules.length) {
        const seedQtyByProduct = new Map();
        for (const r of seedCampaign.promoRules) {
          if (r && r.type === 'qty' && r.scope === 'product' && r.productId) {
            seedQtyByProduct.set(r.productId, JSON.parse(JSON.stringify(r)));
          }
        }
        const currentRules = Array.isArray(campaign.promoRules) ? campaign.promoRules : [];
        const keepRules = currentRules.filter(r =>
          !(r && r.type === 'qty' && r.scope === 'product' && r.productId && seedQtyByProduct.has(r.productId)));
        campaign.promoRules = [...seedQtyByProduct.values(), ...keepRules];
      }
    }
    this.data.priceVersion = target;
    this._bumpDataVersion();
    console.log(`[Migration] Price seed ${target}: ${seeded} SP nhận bảng giá mới, ${added} SP bổ sung mới.`);
    return true;
  }

  /**
   * [Promo v1.3.0] Migration KM cũ → schema promoRules thống nhất (1 lần, idempotent).
   * @returns {boolean} true nếu data đã thay đổi (caller cần persist + refresh UI)
   */
  _applyPromoMigration() {
    return migratePromoRules(this.data);
  }

  /** Khóa ổn định của 1 rule — dùng khi seed chính sách KM từ DEFAULT_DB. */
  _promoSeedKey(rule) {
    if (!rule) return '';
    const buy = rule.buy || {};
    const t = rule.threshold || {};
    if (rule.type === 'qty') return `qty|${rule.kind || 'foc'}|${rule.productId || ''}|${buy.qty}|${buy.unit || ''}`;
    if (rule.type === 'total') return `total|${rule.type}_${rule.scope || ''}|${rule.productId || ''}|${t.min}|${t.max}|${t.basis || ''}`;
    return `text|${rule.id || ''}`;
  }

  /** Seed/merge campaign.promoRules từ seed: rule trùng khóa → lấy bản seed, rule user thêm → giữ. */
  _mergeSeedPromoRules(campaign, seedRules) {
    const current = Array.isArray(campaign.promoRules) ? campaign.promoRules : [];
    const seedKeys = new Set(seedRules.map(r => this._promoSeedKey(r)));
    const keep = current.filter(r => !seedKeys.has(this._promoSeedKey(r)));
    campaign.promoRules = [...keep, ...JSON.parse(JSON.stringify(seedRules))];
  }

  /**
   * [Rebrand 24/08] Xóa customAlias trỏ tới product id KHÔNG còn tồn tại
   * (các SP trùng tên đã gỡ khi dedupe/rebrand). Trả về số alias đã xóa.
   * @param {boolean} persist - true thì ghi đè lại storage (localStorage + IndexedDB)
   */
  _purgeDeadAliasTargets(persist) {
    try {
      const validIds = new Set();
      const campaigns = (this.data && this.data.campaigns) || {};
      for (const c of Object.values(campaigns)) {
        if (c && Array.isArray(c.products)) for (const p of c.products) validIds.add(p.id);
      }
      let removed = 0;
      for (const [k, v] of Object.entries(this.customAliases || {})) {
        if (!validIds.has(v)) { delete this.customAliases[k]; removed++; }
      }
      if (removed > 0 && persist) {
        try { localStorage.setItem('oa_alias_v4', JSON.stringify(this.customAliases)); } catch (e) {}
        dbStore.set(ALIAS_STORAGE_KEY, this.customAliases).catch(e => console.error(e));
        console.log(`[Migration] Đã xóa ${removed} custom alias trỏ tới sản phẩm không còn tồn tại.`);
      }
      return removed;
    } catch (e) {
      console.warn('Purge dead alias targets failed:', e);
      return 0;
    }
  }

  /**
   * Initializes the database. Loads data from IndexedDB, performs migration if needed,
   * and sets up the RAM Cache.
   */
  /**
   * Synchronous 0ms Instant Boot: immediately sets up RAM cache from defaults/localStorage
   * so the application UI renders instantly without waiting for IndexedDB transactions.
   */
  initSync() {
    // Check if there is legacy localStorage data to load instantly
    try {
      // We ignore old order_automation_db_v2 to ensure fresh load from DEFAULT_DB for v5
      this.data = JSON.parse(JSON.stringify(DEFAULT_DB));
      // Load aliases: ưu tiên key mới (oa_alias_v4 fallback từ localStorage khi IndexedDB chưa sẵn)
      const aliasV4 = localStorage.getItem('oa_alias_v4');
      const oldSavedAliases = localStorage.getItem('order_automation_aliases_v1');
      if (aliasV4) {
        this.customAliases = JSON.parse(aliasV4);
      } else if (oldSavedAliases) {
        this.customAliases = JSON.parse(oldSavedAliases);
      } else {
        this.customAliases = {};
      }
      const removedV1 = localStorage.getItem(ALIAS_REMOVED_KEY);
      this.removedDefaultAliases = removedV1 ? JSON.parse(removedV1) : {};
      // [Rebrand 24/08] Dọn alias custom trỏ tới SP đã gỡ (persist: localStorage + IndexedDB fallback)
      this._purgeDeadAliasTargets(true);
      const oldSavedMemory = localStorage.getItem('order_automation_ai_memory_v1') || localStorage.getItem('oa_memory_v1');
      if (oldSavedMemory) {
        this.memory = oldSavedMemory;
      } else {
        this.memory = DEFAULT_MEMORY;
      }
    } catch (err) {
      this.data = JSON.parse(JSON.stringify(DEFAULT_DB));
      this.customAliases = {};
      this.memory = DEFAULT_MEMORY;
    }

    // [Promo v1.3.0] KM cũ → schema promoRules thống nhất (DEFAULT_DB đã chuẩn → no-op)
    this._applyPromoMigration();

    // [Rebrand 24/08] Dummy-check cũ (znt_pcmo) đã gỡ — việc phát hiện db legacy
    // và thay bằng DEFAULT_DB 4 brand được xử lý tập trung trong init() (_needsRebrandMigration).

    // Load sellers from localStorage for instant boot
    try {
      const savedSellers = localStorage.getItem('sellers');
      this.sellers = savedSellers ? JSON.parse(savedSellers) : [];
    } catch (e) {
      this.sellers = [];
    }

    // Load kv-name-map.json for kvCode fallback lookup
    this._loadKvCodeMap();
  
    this.ensureGiftProducts();
    this.ensurePackingConsistency();
    this._applyZentorMktFix();
    this.sanitizeProductNames();
    this.sanitizeCampaigns();
    this._bumpDataVersion(); // data đã được gán/sửa trong initSync → invalidate memo cache
    return this;
  }

  /**
   * Background Async Sync: loads persistent data from IndexedDB in parallel
   * without blocking page load.
   */
  async init(onUpdateCallback) {
    try {
      await dbStore.init();

      // Run parallel reading from IndexedDB
      const [saved, savedAliases, savedMemory, savedSellers, savedRemovedAliases] = await Promise.all([
        dbStore.get(DB_STORAGE_KEY),
        dbStore.get(ALIAS_STORAGE_KEY),
        dbStore.get(MEMORY_STORAGE_KEY),
        dbStore.get(SELLERS_STORAGE_KEY),
        dbStore.get(ALIAS_REMOVED_KEY)
      ]);

      // [v1.3.3] Snapshot DB NGUYÊN TRẠNG trước mọi migration — lưới an toàn nếu một
      // migration/seed làm mất dữ liệu (khôi phục khẩn cấp: đọc DB_BACKUP_KEY rồi ghi
      // đè lại DB_STORAGE_KEY qua dbStore — không có UI).
      if (saved && saved.campaigns) {
        await this._snapshotPreMigrationBackups(saved);
      }

      let updated = false;

      // Check migration from localStorage
      let migratedData = null;
      let migratedAliases = null;
      let migratedMemory = null;

      try {
        // Ignore oldSavedDB for v5 migration to ensure clean state
        // const oldSavedDB = localStorage.getItem('order_automation_db_v2');
        // if (oldSavedDB) migratedData = JSON.parse(oldSavedDB);
        const oldSavedAliases = localStorage.getItem('order_automation_aliases_v1');
        if (oldSavedAliases) migratedAliases = JSON.parse(oldSavedAliases);
        const oldSavedMemory = localStorage.getItem('order_automation_ai_memory_v1') || localStorage.getItem('oa_memory_v1');
        if (oldSavedMemory) migratedMemory = oldSavedMemory;
      } catch (err) {}

      if (migratedData) {
        this.data = migratedData;
        dbStore.set(DB_STORAGE_KEY, this.data).catch(e => console.error(e));
        try { localStorage.removeItem('order_automation_db_v2'); } catch(e) {}
        updated = true;
      } else if (saved && saved.campaigns) {
        if (this._needsRebrandMigration(saved)) {
          // [Rebrand 24/08] Storage còn db cũ (campaign legacy) → ép sang DEFAULT_DB 4 brand,
          // ghi đè NGAY cả IndexedDB lẫn mirror để crash cũng không hồi sinh db cũ.
          this.data = JSON.parse(JSON.stringify(DEFAULT_DB));
          dbStore.set(DB_STORAGE_KEY, this.data).catch(e => console.error(e));
          try { localStorage.setItem(DB_MIRROR_KEY, JSON.stringify(this.data)); } catch (e) {}
          console.log('[Migration] Rebrand: đã thay db cũ (campaign legacy) bằng DEFAULT_DB 4 brand.');
        } else {
          this.data = saved;
        }
        updated = true;
      } else {
        // [Task #9] IndexedDB KHÔNG có dữ liệu hợp lệ → thử khôi phục từ mirror localStorage
        // (chống mất dữ liệu khi force-close/crash trước khi transaction commit). Mirror hợp lệ
        // = parse được và có campaigns. Nếu không có mirror → giữ hành vi cũ: ghi DEFAULT_DB.
        let restoredFromMirror = false;
        try {
          if (typeof localStorage !== 'undefined') {
            const mirrorRaw = localStorage.getItem(DB_MIRROR_KEY);
            if (mirrorRaw) {
              const mirrorData = JSON.parse(mirrorRaw);
              // [Rebrand 24/08] Mirror chứa db cũ (campaign legacy) → bỏ qua, giữ DEFAULT_DB
              if (mirrorData && mirrorData.campaigns && !this._needsRebrandMigration(mirrorData)) {
                this.data = mirrorData;
                restoredFromMirror = true;
                console.warn('[DB] IndexedDB trống/hỏng — đã khôi phục DB từ localStorage mirror.');
              }
            }
          }
        } catch (mirrorErr) {
          console.warn('[DB] Mirror restore failed:', mirrorErr);
        }
        dbStore.set(DB_STORAGE_KEY, this.data).catch(e => console.error(e));
        // [Rebrand 24/08] Làm tươi mirror theo data hiện hành (ghi đè mirror cũ/stale)
        try { localStorage.setItem(DB_MIRROR_KEY, JSON.stringify(this.data)); } catch (e) {}
        if (restoredFromMirror) updated = true;
      }
      this._bumpDataVersion(); // this.data có thể đã được thay bằng IndexedDB/migration → invalidate memo cache

      // [Promo v1.3.0] Dữ liệu KM cũ (mkt_gift_rules/foc_rules/mkt_gift_rules SP/
      // promoTextRules) → schema promoRules thống nhất — chạy 1 lần, idempotent.
      // [v1.3.3] CHẠY TRƯỚC price-seed: seed phải merge lên data ĐÃ migrate, nếu
      // không (trước đây) seed ghi promoRules lên data còn foc_rules → migrate sau
      // append rule cũ → cùng mốc xuất hiện 2 lần (trùng rule với seed).
      if (this._applyPromoMigration()) {
        dbStore.set(DB_STORAGE_KEY, this.data).catch(e => console.error(e));
        try { if (typeof localStorage !== 'undefined') localStorage.setItem(DB_MIRROR_KEY, JSON.stringify(this.data)); } catch (e) {}
        updated = true;
      }

      // [Price seed 06/09] Bảng giá seed mới hơn db đã lưu trên máy → seed giá mới
      // (máy cũ cài đè bộ cài mới vẫn tự nhận bảng giá; persist + refresh UI bên dưới)
      if (this._applyPriceSeedMigration()) {
        dbStore.set(DB_STORAGE_KEY, this.data).catch(e => console.error(e));
        try { if (typeof localStorage !== 'undefined') localStorage.setItem(DB_MIRROR_KEY, JSON.stringify(this.data)); } catch (e) {}
        updated = true;
      }

      if (migratedAliases) {
        this.customAliases = migratedAliases;
        dbStore.set(ALIAS_STORAGE_KEY, this.customAliases).catch(e => console.error(e));
        try { localStorage.removeItem('order_automation_aliases_v1'); } catch(e) {}
        updated = true;
      } else if (savedAliases) {
        this.customAliases = savedAliases;
        updated = true;
      }

      // Danh sách alias mặc định đã bị người dùng xóa (ưu tiên IndexedDB)
      if (savedRemovedAliases) {
        this.removedDefaultAliases = savedRemovedAliases;
      } else if (Object.keys(this.removedDefaultAliases || {}).length > 0) {
        dbStore.set(ALIAS_REMOVED_KEY, this.removedDefaultAliases).catch(e => console.error(e));
      }

      // ── Migration: Xóa alias SAI đã học nhầm ("tay ga"/"xe ga" → Good Scoot) ──
      // Bug cũ: AI yếu khớp "Auto X tay ga" thành Good Scoot rồi auto-learn ghi đè.
      // Alias đúng phải là Fast Scoot (DEFAULT_ALIASES đã có).
      const _badAliasTargets = ['torvex_good_scoot_10w40', 'torvex_good_20w40'];
      const _tayGaKeys = Object.keys(this.customAliases).filter(k => {
        const kn = k.toLowerCase().trim();
        // Alias chứa "tay ga"/"xe ga" trỏ về Good Scoot, HOẶC alias chỉ là tên brand
        // thuần ("auto x"/"torvex") — brand keyword không được map cứng về 1 SP cụ thể.
        const isBrandOnly = kn === 'auto x' || kn === 'torvex';
        return _badAliasTargets.includes(this.customAliases[k]) &&
          (kn.includes('tay ga') || kn.includes('xe ga') || isBrandOnly);
      });
      if (_tayGaKeys.length > 0) {
        for (const k of _tayGaKeys) delete this.customAliases[k];
        dbStore.set(ALIAS_STORAGE_KEY, this.customAliases).catch(e => console.error(e));
        console.log(`[Migration] Purged ${_tayGaKeys.length} bad tay-ga aliases:`, _tayGaKeys);
        updated = true;
      }

      // [Rebrand 24/08] Dọn customAlias trỏ tới product id đã gỡ khi dedupe/rebrand
      if (this._purgeDeadAliasTargets(true) > 0) updated = true;

      if (migratedMemory) {
        this.memory = migratedMemory;
        dbStore.set(MEMORY_STORAGE_KEY, this.memory).catch(e => console.error(e));
        try { localStorage.removeItem('order_automation_ai_memory_v1'); } catch(e) {}
      } else if (savedMemory) {
        this.memory = savedMemory;
      }

      // Sellers: migrate from localStorage → IndexedDB, or restore from IndexedDB / IPC
      try {
        const lsSellers = localStorage.getItem('sellers');
        let lsParsed = null;
        if (lsSellers) {
          try { lsParsed = JSON.parse(lsSellers); } catch (e) { lsParsed = null; }
        }
        if (lsParsed && Array.isArray(lsParsed) && lsParsed.length > 0) {
          // localStorage has valid non-empty sellers → use as source of truth
          this.sellers = lsParsed;
          dbStore.set(SELLERS_STORAGE_KEY, this.sellers).catch(e => console.error(e));
        } else if (savedSellers && Array.isArray(savedSellers) && savedSellers.length > 0) {
          // localStorage empty/invalid → restore from IndexedDB
          this.sellers = savedSellers;
          localStorage.setItem('sellers', JSON.stringify(savedSellers));
          updated = true; // trigger callback to refresh UI
        } else if (window.electronAPI && window.electronAPI.getSellers) {
          // Both localStorage & IndexedDB empty → try file-level backup (app-config.json)
          const fileSellers = await window.electronAPI.getSellers();
          if (Array.isArray(fileSellers) && fileSellers.length > 0) {
            this.sellers = fileSellers;
            localStorage.setItem('sellers', JSON.stringify(fileSellers));
            dbStore.set(SELLERS_STORAGE_KEY, fileSellers).catch(e => console.error(e));
            updated = true; // trigger callback to refresh UI
          }
        }
      } catch (e) {
        console.warn('Sellers migration warning:', e);
      }

      // Load kv-name-map.json for kvCode fallback lookup
      this._loadKvCodeMap();
      // Data IndexedDB đã nạp xong → sync inline kvCode CŨ theo seed catalog cho các SP
      // vừa đổi/xóa mã ở boot này (initSync chỉ chạy trên DEFAULT_DB nên chưa phủ được đây).
      this._syncStaleInlineKvCodes();

      this.ensureGiftProducts();
      if (this.ensurePackingConsistency()) {
        dbStore.set(DB_STORAGE_KEY, this.data).catch(e => console.error(e));
        updated = true; // refresh UI với box_size đã đồng bộ theo packaging
      }
      if (this._applyZentorMktFix()) {
        dbStore.set(DB_STORAGE_KEY, this.data).catch(e => console.error(e));
        try { if (typeof localStorage !== 'undefined') localStorage.setItem(DB_MIRROR_KEY, JSON.stringify(this.data)); } catch (e) {}
        console.log('[Migration] Eagerly persisted fresh Zentor MKT rules to IndexedDB & localStorage mirror.');
        updated = true;
      }
      this.sanitizeProductNames();
      this.sanitizeCampaigns();
      this._bumpDataVersion(); // ensure*/sanitize có thể sửa product → invalidate memo cache

      if (updated && typeof onUpdateCallback === 'function') {
        onUpdateCallback();
      }
    } catch (e) {
      console.warn('Background IndexedDB sync warning:', e);
    }
    return this;
  }

  /** Loads kv-name-map.json into memory for kvCode fallback lookups. */
  _loadKvCodeMap() {
    // Guard: the sync XHR is expensive and this method runs twice at boot
    // (initSync + init). Once the map is loaded successfully, skip the XHR
    // on subsequent calls (runtime updates go through this.kvCodeThungMap).
    if (!this._kvCodeMapLoaded) {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', 'kv-name-map.json', false); // synchronous
        xhr.send();
        if (xhr.status === 200 || xhr.status === 0) {
          const raw = JSON.parse(xhr.responseText);
          this.kvCodeMap = {};
          for (const [productId, entry] of Object.entries(raw)) {
            if (entry && entry.kvCode) {
              this.kvCodeMap[productId] = entry.kvCode;
            }
            if (entry && entry.kvCodeThung) {
              this.kvCodeThungMap[productId] = entry.kvCodeThung;
            }
          }
          this._kvCodeMapLoaded = true;
          console.log(`Loaded kv-name-map.json: ${Object.keys(this.kvCodeMap).length} entries`);
        }
      } catch (e) {
        console.warn('Failed to load kv-name-map.json:', e);
      }
    }
    // Chế độ Electron đóng gói (asar): kv-name-map.json không ghi được → overrides
    // được mirror vào app-config.json; gộp thêm ở đây (ưu tiên hơn bản trong json).
    if (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.getKvThungOverrides) {
      window.electronAPI.getKvThungOverrides()
        .then(overrides => {
          if (overrides && typeof overrides === 'object') {
            Object.assign(this.kvCodeThungMap, overrides);
          }
        })
        .catch(() => {});
      // Mã GỐC user sửa trên UI (kvBaseOverrides) cũng ưu tiên hơn bản trong json
      if (window.electronAPI.getKvBaseOverrides) {
        window.electronAPI.getKvBaseOverrides()
          .then(overrides => {
            if (overrides && typeof overrides === 'object') {
              for (const [productId, code] of Object.entries(overrides)) {
                if (code) this.kvCodeMap[productId] = code;
                else delete this.kvCodeMap[productId];
              }
            }
            // Overrides merge xong → re-ép seed catalog cho SP vừa đổi/xóa mã ở boot này,
            // chống override cũ trong app-config.json "hồi sinh" mã đã xóa khỏi catalog.
            this._reapplyCatalogSeedAfterOverrides();
          })
          .catch(() => {});
      }
    }
    // Một lần duy nhất: dọn các mã KV user đã sửa tay từ bản cũ (chỉ lưu vào
    // product.kvCode trong IndexedDB, bị kv-name-map.json đè) → đưa lên kvCodeMap.
    this._migrateInlineKvCodeEdits();
    // Đồng bộ mã KV theo catalog nguồn (db.js/default-db.json) — phát hiện seed đổi/xóa
    // so với baseline boot trước → ghi đè mọi tầng (kvCodeMap/inline/kv-name-map.json).
    this._reconcileKvCatalogSeeds();
  }

  /**
   * Migration 1 lần: product.kvCode khác với seed trong DEFAULT_DB = user đã sửa
   * tay trên UI bản cũ (luồng cũ chỉ ghi product.kvCode nên bị json đè).
   * Promote lên kvCodeMap + persist để mã mới thực sự có hiệu lực.
   */
  _migrateInlineKvCodeEdits() {
    if (!this.data || !this.data.campaigns) return;
    if (!this._defaultKvSeed) {
      this._defaultKvSeed = {};
      try {
        for (const c of Object.values(DEFAULT_DB.campaigns || {})) {
          for (const p of (c.products || [])) this._defaultKvSeed[p.id] = (p.kvCode || '').trim();
        }
      } catch (e) { this._defaultKvSeed = {}; }
    }
    const migrated = [];
    for (const c of Object.values(this.data.campaigns)) {
      for (const p of (c.products || [])) {
        const inline = (p.kvCode || '').trim();
        if (!inline) continue;
        const seed = this._defaultKvSeed[p.id];
        if (seed === undefined || inline === seed) continue; // không phải sửa tay
        if (this.kvCodeMap[p.id] === inline) continue;        // đã khớp rồi
        // Catalog còn nguyên (kvCodeMap === seed) mà inline lệch seed → inline là dữ liệu CŨ
        // (IndexedDB chưa sync sau khi catalog đổi mã) → KHÔNG promote, để catalog thắng.
        // Chống hiện tượng mã KV cũ đã xóa trong catalog "hồi sinh" qua xác ướp IndexedDB.
        if (this.kvCodeMap[p.id] === seed) continue;
        this.kvCodeMap[p.id] = inline;
        migrated.push({ productId: p.id, code: inline });
      }
    }
    if (migrated.length) {
      console.log(`[KV migrate] Promote ${migrated.length} mã KV user đã sửa: ` +
        migrated.map(m => `${m.productId}=${m.code}`).join(', '));
      if (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.setKvBaseCode) {
        for (const m of migrated) {
          window.electronAPI.setKvBaseCode(m).catch(() => {});
        }
      }
    }
  }

  /**
   * Đồng bộ mã KV khi NGUỒN CATALOG (DEFAULT_DB trong db.js / default-db.json) thay đổi —
   * xử lý DỨT ĐIỂM hiện tượng mã KV đã xóa/sửa trong catalog nhưng vẫn "sống" trong
   * kv-name-map.json / app-config.json / IndexedDB, khiến tìm kiếm theo mã cũ vẫn ra kết quả.
   *
   * Cơ chế: chụp baseline {productId → kvCode} của DEFAULT_DB vào localStorage. Mỗi boot
   * so từng sản phẩm:
   *   - seed ĐỔI → catalog thắng: ghi đè kvCodeMap + product.kvCode (inline), persist qua IPC.
   *   - SP biến khỏi catalog → gỡ entry khỏi kvCodeMap/kvCodeThungMap + persist xóa.
   * Boot đầu tiên (chưa có baseline) chỉ lưu baseline, KHÔNG ghi đè override user đã sửa qua UI.
   */
  _reconcileKvCatalogSeeds() {
    if (typeof localStorage === 'undefined') return; // env test Node không có localStorage → bỏ qua
    try {
      // Seed kvCode GỐC hiện tại từ DEFAULT_DB (kvCodeThung tự phân theo base+'-1' nên không cần seed riêng)
      const seeds = {};
      for (const c of Object.values(DEFAULT_DB.campaigns || {})) {
        for (const p of (c.products || [])) seeds[p.id] = (p.kvCode || '').trim();
      }
      const KEY = 'oa_kv_seed_map_v1';
      let baseline = null;
      try { baseline = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { baseline = null; }
      if (!baseline || typeof baseline !== 'object') {
        // Boot đầu sau khi bật tính năng: chụp baseline, không override gì
        try { localStorage.setItem(KEY, JSON.stringify(seeds)); } catch (e) {}
        return;
      }
      const changed = [];  // {productId, code} — seed đổi → ép theo catalog
      const removed = [];  // productId — SP đã bị xóa khỏi catalog
      for (const [pid, code] of Object.entries(seeds)) {
        if (baseline[pid] !== undefined && baseline[pid] !== code) changed.push({ productId: pid, code });
      }
      for (const pid of Object.keys(baseline)) {
        if (seeds[pid] === undefined) removed.push(pid);
      }
      // Lưu baseline MỚI ngay để boot sau không lặp lại (kể cả khi persist IPC lỗi)
      try { localStorage.setItem(KEY, JSON.stringify(seeds)); } catch (e) {}
      if (!changed.length && !removed.length) return;

      console.log(`[KV reconcile] Catalog đổi mã: ${changed.length} sửa, ${removed.length} xóa — đồng bộ kvCodeMap/IndexedDB/kv-name-map.json`);
      // Giữ danh sách id để: (a) sync inline khi init() nạp IndexedDB, (b) re-ép seed sau khi
      // overrides app-config.json (async) merge xong — chống override cũ "hồi sinh" mã đã xóa.
      this._kvCatalogChangedIds = new Set([...changed.map(c => c.productId), ...removed]);

      for (const { productId, code } of changed) {
        if (code) this.kvCodeMap[productId] = code;
        else delete this.kvCodeMap[productId];
      }
      for (const pid of removed) {
        delete this.kvCodeMap[pid];
        delete this.kvCodeThungMap[pid];
        // KHÔNG xóa product trong this.data: user có thể giữ SP riêng ngoài catalog mặc định
      }
      this._syncStaleInlineKvCodes();

      // Persist xuống kv-name-map.json / app-config.json (Electron IPC; code='' → xóa entry)
      if (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.setKvBaseCode) {
        for (const { productId, code } of changed) {
          window.electronAPI.setKvBaseCode({ productId, code }).catch(() => {});
        }
        for (const pid of removed) {
          window.electronAPI.setKvBaseCode({ productId: pid, code: '' }).catch(() => {});
        }
      }
    } catch (e) {
      console.warn('[KV reconcile] Failed:', e);
    }
  }

  /**
   * Đồng bộ product.kvCode (inline trong this.data) theo seed catalog — chỉ áp cho các SP
   * trong _kvCatalogChangedIds (catalog vừa đổi/xóa mã). Chạy cả ở initSync (data=DEFAULT_DB,
   * thường no-op) và init() (data=IndexedDB — nơi inline cũ hay "xác ướp" nhất).
   */
  _syncStaleInlineKvCodes() {
    if (!this._kvCatalogChangedIds || !this._kvCatalogChangedIds.size) return;
    if (!this.data || !this.data.campaigns) return;
    const seeds = {};
    for (const c of Object.values(DEFAULT_DB.campaigns || {})) {
      for (const p of (c.products || [])) seeds[p.id] = (p.kvCode || '').trim();
    }
    let touched = false;
    for (const c of Object.values(this.data.campaigns)) {
      for (const p of (c.products || [])) {
        if (!this._kvCatalogChangedIds.has(p.id)) continue;
        const seed = seeds[p.id];
        if (seed === undefined) continue; // SP đã xóa khỏi catalog — giữ nguyên dữ liệu user
        if ((p.kvCode || '').trim() !== seed) { p.kvCode = seed; touched = true; }
      }
    }
    if (touched) this.save();
  }

  /**
   * Re-ép seed catalog lên kvCodeMap SAU khi overrides từ app-config.json (async) merge xong —
   * chống override cũ "hồi sinh" mã đã bị xóa khỏi catalog. Chỉ chạy khi boot này catalog có đổi.
   */
  _reapplyCatalogSeedAfterOverrides() {
    if (!this._kvCatalogChangedIds || !this._kvCatalogChangedIds.size) return;
    const seeds = {};
    for (const c of Object.values(DEFAULT_DB.campaigns || {})) {
      for (const p of (c.products || [])) seeds[p.id] = (p.kvCode || '').trim();
    }
    for (const pid of this._kvCatalogChangedIds) {
      const seed = seeds[pid];
      if (seed === undefined) { // SP đã xóa khỏi catalog
        delete this.kvCodeMap[pid];
        delete this.kvCodeThungMap[pid];
      } else if (seed) {
        this.kvCodeMap[pid] = seed;
      } else {
        delete this.kvCodeMap[pid];
      }
    }
  }

  /**
   * Ghi đè mã KV của THÙNG cho một sản phẩm.
   * - code khác rỗng → dùng thay cho mã tự phân (mã gốc + '-1').
   * - code rỗng → xóa override, quay về tự phân.
   * Lưu 3 nơi:
   *   1. product.kvCodeThung trong db (IndexedDB) — sống cùng dữ liệu sản phẩm
   *   2. kv-name-map.json (dev) / app-config.json (packaged) qua IPC
   *   3. this.kvCodeThungMap (runtime)
   */
  setKvThungOverride(productId, code) {
    const val = (code || '').toString().trim();
    if (val) this.kvCodeThungMap[productId] = val;
    else delete this.kvCodeThungMap[productId];
    // Lưu vào db sản phẩm (persist qua db.save() → IndexedDB/localStorage)
    this.updateProduct(productId, { kvCodeThung: val });
    if (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.setKvThungOverride) {
      window.electronAPI.setKvThungOverride({ productId, code: val })
        .catch(e => console.warn('Persist kvCodeThung override failed:', e));
    }
  }

  /**
   * Sửa mã KV GỐC (đơn vị lẻ) của một sản phẩm từ UI.
   * Chỉ updateProduct({ kvCode }) là KHÔNG đủ: getKvCode() ưu tiên
   * kvCodeMap (kv-name-map.json) hơn product.kvCode, nên phải cập nhật
   * cả kvCodeMap runtime + persist vào kv-name-map.json / app-config.json.
   */
  setKvCodeBase(productId, code) {
    const val = (code || '').toString().trim();
    if (val) this.kvCodeMap[productId] = val;
    else delete this.kvCodeMap[productId];
    // Lưu product.kvCode (legacy fallback + hiển thị trên UI)
    this.updateProduct(productId, { kvCode: val });
    if (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.setKvBaseCode) {
      window.electronAPI.setKvBaseCode({ productId, code: val })
        .catch(e => console.warn('Persist kvCode base override failed:', e));
    }
  }

  /**
   * KV Code resolution (single source of truth):
   *   1. kv-name-map.json (this.kvCodeMap) — PRIMARY, 433+ entries
   *   2. product.kvCode (inline) — LEGACY FALLBACK only
   *
   * Packaging rule:
   *   - Mã GỐC (vd: "123456")        = đơn vị lẻ (chai / bình / lon / can)
   *   - Mã GỐC + "-1" (vd: "123456-1") = đơn vị THÙNG
   *   - unit='thùng' AND box_size>1 → override (kvCodeThung) nếu có, ngược lại base+'-1'
   *   - Override ưu tiên: kvCodeThungMap (kv-name-map.json / app-config.json)
   *     → product.kvCodeThung (trong db) → base+'-1'
   *
   * @param {object} product - product object
   * @param {string} [unit] - đơn vị của dòng đơn hàng ('thùng' | 'chai' | 'can' | ...)
   */
  getKvCode(product, unit) {
    if (!product) return '';
    const base = this.kvCodeMap[product.id] || product.kvCode || '';
    if (!base) return '';
    // Đủ package thùng → dùng mã KV của THÙNG (mã gốc + '-1').
    // Chỉ áp dụng cho SP có đóng thùng (box_size > 1: chai/bình lẻ đóng thành thùng).
    // SP bán lẻ đơn chiếc (xô, phuy, cái, ...) có box_size = 1 → KHÔNG có mã '-1'.
    const u = (unit || '').toString().toLowerCase().trim();
    const isThung = (u === 'thùng' || u === 'thung' || u === 'thg');
    const boxSize = Number(product.box_size) || 1;
    if (isThung && boxSize > 1) {
      return this.kvCodeThungMap[product.id]
        || (product.kvCodeThung || '').toString().trim()
        || base + '-1';
    }
    // Không đủ thùng (chai / bình / lon / can / lẻ) hoặc SP không đóng thùng → mã gốc
    return base;
  }

  save() {
    this._bumpDataVersion(); // mọi mutation đều đi qua save() → invalidate memo cache NGAY (không debounce)
    // Bật cờ dirty để tab Danh Mục vẽ lại khi quay lại (mọi mutation dữ liệu đều qua save()).
    // KHÔNG set _settingsNeedsRender — tránh re-render Settings làm mất focus input đang gõ.
    if (typeof window !== 'undefined') window._catalogNeedsRender = true;
    // [Perf phase 2] Debounce phần ghi IndexedDB (~500ms): các mutation liên tiếp
    // (sửa catalog, gõ input…) chỉ tạo 1 lần ghi. Cache invalidate vẫn tức thì;
    // flushSave() được gọi tại beforeunload / tab ẩn nên không bao giờ mất dữ liệu.
    try {
      this._schedulePersist();
      return true;
    } catch (e) {
      _dbLog.error('save(): lên lịch persist THẤT BẠI', { error: String(e && e.stack || e) });
      console.error('Save failed:', e);
      return false;
    }
  }

  /** Lên lịch ghi IndexedDB có debounce (gộp các đợt save() liên tiếp thành 1 lần ghi). */
  _schedulePersist() {
    if (this._saveTimer) return; // đã có bản ghi chờ → không tạo thêm timer
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.flushSave();
    }, 500);
    // Env test Node: không giữ process sống chỉ để chờ timer debounce
    if (this._saveTimer && typeof this._saveTimer.unref === 'function') this._saveTimer.unref();
    this._registerFlushListeners();
  }

  /** Ghi NGAY lập tức vào IndexedDB (hủy bản ghi debounce đang chờ). Trả true như save(). */
  flushSave() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    try {
      dbStore.set(DB_STORAGE_KEY, this.data)
        .then(() => {
          this._lastPersistError = null;
          _dbLog.debug('flushSave: ghi IndexedDB thành công', { key: DB_STORAGE_KEY });
        })
        .catch(e => {
          // Lưu lỗi persist cuối cùng để chẩn đoán + log chi tiết thay vì nuốt lặng.
          this._lastPersistError = String(e && e.message || e);
          _dbLog.error('flushSave: ghi IndexedDB THẤT BẠI — dữ liệu có thể MẤT khi tắt app', {
            key: DB_STORAGE_KEY, error: this._lastPersistError,
          });
          console.error('IndexedDB save failed:', e);
        });
      // [Task #9] Mirror ĐỒNG BỘ sang localStorage trong CÙNG hàm ghi (kể cả khi debounce fire):
      // nếu Electron force-close/crash trước khi transaction IndexedDB commit, init() sẽ
      // khôi phục từ mirror này. Mirror chỉ là fallback — không đổi hành vi khi IndexedDB lành.
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(DB_MIRROR_KEY, JSON.stringify(this.data));
        }
      } catch (mirrorErr) {
        _dbLog.warn('flushSave: ghi mirror localStorage THẤT BẠI (quota?)', {
          key: DB_MIRROR_KEY, error: String(mirrorErr && mirrorErr.message || mirrorErr),
        });
        console.warn('DB mirror write failed (quota?):', mirrorErr);
      }
      return true;
    } catch (e) {
      this._lastPersistError = String(e && e.message || e);
      _dbLog.error('flushSave: ngoại lệ khi persist', { error: this._lastPersistError });
      console.error('Save failed:', e);
      return false;
    }
  }

  /** Trạng thái persist cuối cùng — null nếu lành, chuỗi lỗi nếu lần ghi gần nhất hỏng. */
  getLastPersistError() {
    return this._lastPersistError || null;
  }

  /** Đăng ký 1 lần duy nhất: flush bản ghi debounce khi đóng trang / ẩn tab để không mất dữ liệu. */
  _registerFlushListeners() {
    if (this._flushListenersRegistered) return;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    this._flushListenersRegistered = true;
    window.addEventListener('beforeunload', () => this.flushSave());
    // pagehide: phủ thêm trường hợp beforeunload không fire (bfcache / một số luồng đóng Electron)
    window.addEventListener('pagehide', () => this.flushSave());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flushSave();
    });
  }

  saveAliases() {
    try {
      // Ghi localStorage đồng bộ (backup, sống sót qua force-close)
      localStorage.setItem('oa_alias_v4', JSON.stringify(this.customAliases));
      localStorage.setItem(ALIAS_REMOVED_KEY, JSON.stringify(this.removedDefaultAliases));
      // Ghi IndexedDB bất đồng bộ (primary)
      dbStore.set(ALIAS_STORAGE_KEY, this.customAliases)
        .catch(e => console.error('IndexedDB saveAliases failed:', e));
      dbStore.set(ALIAS_REMOVED_KEY, this.removedDefaultAliases)
        .catch(e => console.error('IndexedDB saveRemovedAliases failed:', e));
    } catch (e) {
      console.error('Save aliases failed:', e);
    }
  }

  saveMemory(text) {
    try {
      this.memory = text;
      dbStore.set(MEMORY_STORAGE_KEY, text)
        .catch(e => console.error('IndexedDB saveMemory failed:', e));
      return true;
    } catch (e) {
      console.error('Save memory failed:', e);
      return false;
    }
  }

  getMemory() {
    return this.memory || DEFAULT_MEMORY;
  }

  /** Returns the sellers list (Người nhận đặt). */
  getSellers() {
    return this.sellers || [];
  }

  /** Persists sellers to RAM cache, localStorage, IndexedDB, and Electron IPC (app-config.json). */
  saveSellers(sellers) {
    this.sellers = sellers;
    try {
      localStorage.setItem('sellers', JSON.stringify(sellers));
    } catch (e) { /* ignore */ }
    dbStore.set(SELLERS_STORAGE_KEY, sellers)
      .catch(e => console.error('IndexedDB saveSellers failed:', e));
    // File-level persistence via Electron main process
    if (window.electronAPI && window.electronAPI.setSellers) {
      window.electronAPI.setSellers(sellers).catch(() => {});
    }
  }

  async reset() {
    this.data = JSON.parse(JSON.stringify(DEFAULT_DB));
    this.customAliases = {};
    this.removedDefaultAliases = {};
    this.memory = DEFAULT_MEMORY;

    // Reset ghi trực tiếp bên dưới → hủy bản ghi debounce đang chờ để tránh ghi chồng/ghi dữ liệu cũ
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    
    await dbStore.remove(DB_STORAGE_KEY);
    await dbStore.remove(ALIAS_STORAGE_KEY);
    await dbStore.remove(ALIAS_REMOVED_KEY);
    await dbStore.remove(MEMORY_STORAGE_KEY);
    await dbStore.set(DB_STORAGE_KEY, this.data);
    
    this.ensureGiftProducts();
    this._bumpDataVersion(); // reset gán this.data mới → invalidate memo cache
    return this.data;
  }

  exportJSON() {
    return JSON.stringify({ database: this.data, aliases: this.customAliases, memory: this.memory }, null, 2);
  }

  importJSON(jsonString) {
    try {
      const parsed = JSON.parse(jsonString);
      if (parsed.database && parsed.database.campaigns) {
        this.data = parsed.database;
        this.customAliases = parsed.aliases || {};
        this.memory = parsed.memory || DEFAULT_MEMORY;
      } else if (parsed.campaigns) {
        this.data = parsed;
        this.memory = DEFAULT_MEMORY;
      } else {
        throw new Error('Invalid format');
      }
      this._bumpDataVersion(); // import gán this.data mới → invalidate memo cache
      this.flushSave(); // import là hành động 1-lần quan trọng → persist NGAY, không chờ debounce
      this.saveAliases();
      this.saveMemory(this.memory);
      return true;
    } catch (e) { console.error('Import failed:', e); return false; }
  }

  getAllProducts() {
    // ⚠️ Cảnh báo: trả về MẢNG CACHE dùng chung (các phần tử là bản shallow copy của product).
    // Caller KHÔNG được mutate mảng này (push/splice/sort) — sẽ phá cache của mọi caller khác.
    // Muốn sửa product: dùng findProductRefById / updateProduct. Không freeze để giữ hiệu năng.
    if (this._allProductsCacheVersion === this._dataVersion && this._allProductsCache) {
      return this._allProductsCache;
    }
    const products = [];
    if (!this.data || !this.data.campaigns) return products;
    for (const [campaignKey, campaign] of Object.entries(this.data.campaigns)) {
      for (const product of campaign.products) {
        products.push({ ...product, campaignKey, campaignName: campaign.name, campaignColor: campaign.color, campaignIcon: campaign.icon });
      }
    }
    this._allProductsCache = products;
    this._allProductsCacheVersion = this._dataVersion;
    return products;
  }

  /** Rebuild Map index id→product (kèm campaign meta) cho findProductById. */
  _rebuildProductByIdMap() {
    const map = new Map();
    if (this.data && this.data.campaigns) {
      for (const [ck, campaign] of Object.entries(this.data.campaigns)) {
        const meta = { campaignKey: ck, campaignName: campaign.name, campaignColor: campaign.color, campaignIcon: campaign.icon };
        for (const product of (campaign.products || [])) {
          map.set(`${ck}::${product.id}`, { product, ...meta });
          // fallback key: campaign ĐẦU TIÊN chứa id này (khớp hành vi scan cũ)
          if (!map.has(product.id)) map.set(product.id, { product, ...meta });
        }
      }
    }
    this._productByIdMap = map;
    this._productByIdMapVersion = this._dataVersion;
  }

  findProductById(id, campaignKey) {
    if (!this.data || !this.data.campaigns) return null;
    if (this._productByIdMapVersion !== this._dataVersion) this._rebuildProductByIdMap();
    const entry = (campaignKey ? this._productByIdMap.get(`${campaignKey}::${id}`) : null)
      || this._productByIdMap.get(id);
    if (!entry) return null;
    return { ...entry.product, campaignKey: entry.campaignKey, campaignName: entry.campaignName, campaignColor: entry.campaignColor, campaignIcon: entry.campaignIcon };
  }

  /** Returns the ORIGINAL product reference (not a copy) so mutations persist. */
  findProductRefById(id, campaignKey) {
    if (!this.data || !this.data.campaigns) return null;
    if (campaignKey && this.data.campaigns[campaignKey]) {
      const p = this.data.campaigns[campaignKey].products.find(p => p.id === id);
      if (p) return p;
    }
    for (const campaign of Object.values(this.data.campaigns)) {
      const product = campaign.products.find(p => p.id === id);
      if (product) return product;
    }
    return null;
  }

  getPriceForQty(product, qty) {
    if (!product.tiers || product.tiers.length === 0) return 0;
    const sorted = [...product.tiers].sort((a, b) => a.min_qty - b.min_qty);
    let price = sorted[0].price;
    for (const tier of sorted) {
      if (qty >= tier.min_qty && qty <= tier.max_qty) { price = tier.price; break; }
    }
    return price;
  }

  /**
   * Migration MỘT LẦN: đồng bộ box_size theo số lượng ghi trong packaging.
   * VD: packaging "4 Kit/ Thùng" nhưng box_size=12 → sửa thành box_size=4
   * (bug cũ: Chain Care Kit hiển thị 4 Kit/Thùng nhưng nhân 12 khi đặt theo thùng).
   * [v1.3.4] Giờ gate THẬT bằng cờ _packingFixedV1 — trước 1.3.4 docstring hứa
   * "chỉ chạy 1 lần" nhưng loop chung (mọi campaign) vẫn chạy MỖI boot không cờ,
   * ép box_size theo số trong chuỗi packaging → user sửa tay box_size (đóng gói
   * thực tế lệch chuỗi text) bị đè lại ở lần mở app kế. Sau lần đầu, box_size do
   * user/seed quyết định, không tự ép nữa. Muốn ép lại đồng loạt theo packaging
   * mới → xoá cờ _packingFixedV1 trong data (migration cố ý chỉ 1 lần).
   * [v1.4.2] Pass V2 (cờ _packingFixedV2) — ép lại đồng loạt ĐÚNG 1 LẦN nữa theo
   * yêu cầu: các SP thêm mới / sửa chuỗi packaging SAU khi pass V1 đã chạy thì
   * chưa bao giờ được đồng bộ. Sau pass V2, box_size lại hoàn toàn do user quyết
   * định; muốn ép lần nữa → thêm cờ V3 mới.
   * @returns {boolean} true nếu có sửa (hoặc vừa đánh cờ → caller persist cờ)
   */
  ensurePackingConsistency() {
    if (!this.data || !this.data.campaigns) return false;
    let modified = false;
    // Đồng bộ packaging/box_size chuẩn từ DEFAULT_DB cho Veltron nếu storage lưu data cũ
    if (!this.data._veltronPackingFixedV2 && DEFAULT_DB.campaigns && DEFAULT_DB.campaigns.veltron) {
      const defRavMap = {};
      for (const dp of (DEFAULT_DB.campaigns.veltron.products || [])) {
        defRavMap[dp.id] = dp;
      }
      const ravCamp = this.data.campaigns.veltron;
      if (ravCamp && Array.isArray(ravCamp.products)) {
        for (const p of ravCamp.products) {
          const def = defRavMap[p.id];
          if (def && def.packaging && def.packaging !== p.packaging) {
            console.log(`[Veltron Sync] ${p.id}: "${p.packaging}" (${p.box_size}) → "${def.packaging}" (${def.box_size})`);
            p.packaging = def.packaging;
            p.box_size = def.box_size;
            p.unit = def.unit;
            modified = true;
          }
        }
      }
      this.data._veltronPackingFixedV2 = true;
    }

    let ranPass = false;
    // [v1.3.4] Loop chung mọi campaign — chạy ĐÚNG 1 LẦN (cờ _packingFixedV1)
    if (this.data._packingFixedV1 !== true) {
      this.data._packingFixedV1 = true;
      ranPass = true;
      for (const campaign of Object.values(this.data.campaigns)) {
        for (const p of (campaign.products || [])) {
          const packQty = parsePackagingQty(p.packaging);
          if (packQty && packQty > 0 && p.box_size !== packQty) {
            console.log(`[Packing Fix] ${p.id}: box_size ${p.box_size} → ${packQty} (packaging "${p.packaging}")`);
            p.box_size = packQty;
            modified = true;
          }
        }
      }
    }
    // [v1.4.2] Pass V2 — ép lại đồng loạt ĐÚNG 1 LẦN (cờ _packingFixedV2)
    if (this.data._packingFixedV2 !== true) {
      this.data._packingFixedV2 = true;
      ranPass = true;
      for (const campaign of Object.values(this.data.campaigns)) {
        for (const p of (campaign.products || [])) {
          const packQty = parsePackagingQty(p.packaging);
          if (packQty && packQty > 0 && p.box_size !== packQty) {
            console.log(`[Packing Fix V2] ${p.id}: box_size ${p.box_size} → ${packQty} (packaging "${p.packaging}")`);
            p.box_size = packQty;
            modified = true;
          }
        }
      }
    }
    return ranPass ? true : modified; // đã chạy pass → caller persist cờ (kể cả khi không có SP lệch)
  }

  ensureGiftProducts() {
    if (!this.data || !this.data.campaigns) return;
    let modified = false;
    const addIfMissing = (campaignKey, product) => {
      const campaign = this.data.campaigns[campaignKey];
      if (campaign) {
        const existing = campaign.products.find(p => p.id === product.id);
        if (!existing) {
          campaign.products.unshift(product);
          modified = true;
          console.log(`Injected missing gift product: ${product.name} (${product.id}) to ${campaignKey}`);
        } else if (product.kvCode && existing.kvCode !== product.kvCode) {
          existing.kvCode = product.kvCode;
          modified = true;
        }
      }
    };

    // Keep oil_pump
    addIfMissing('zentor', {
      id: 'oil_pump',
      name: 'Bơm Nhớt phuy',
      spec: 'Quà tặng FOC phuy',
      packaging: 'Cái',
      unit: 'bơm',
      box_size: 1,
      tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Miễn phí' }],
      foc_rules: []
    });

    // Injected missing Zentor MKT gift products (names match Excel "Goods Data" sheet exactly)
    addIfMissing('zentor', {
      id: 'znt_mkt_sticker',
      kvCode: 'SC01',
      name: 'Zentor Sticker (Cái)',
      category: 'Quà tặng',
      spec: 'Cái',
      packaging: 'Cái',
      unit: 'cái',
      box_size: 1,
      tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Miễn phí' }],
      foc_rules: []
    });
    addIfMissing('zentor', {
      id: 'znt_mkt_keyring',
      kvCode: internalCodes.zntKeyring,
      name: 'Zentor Keyring (Cái)',
      category: 'Quà tặng',
      spec: 'Cái',
      packaging: 'Cái',
      unit: 'cái',
      box_size: 1,
      tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Miễn phí' }],
      foc_rules: []
    });
    addIfMissing('zentor', {
      id: 'znt_mkt_stringbag',
      kvCode: 'SPM01',
      name: 'Zentor Stringbag ( Túi rút thể thao) (Cái)',
      category: 'Quà tặng',
      spec: 'Cái',
      packaging: 'Cái',
      unit: 'cái',
      box_size: 1,
      tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Miễn phí' }],
      foc_rules: []
    });
    addIfMissing('zentor', {
      id: 'znt_mkt_cap',
      kvCode: internalCodes.zntCap,
      name: 'Zentor Cap ( Nón) (Cái)',
      category: 'Quà tặng',
      spec: 'Cái',
      packaging: 'Cái',
      unit: 'cái',
      box_size: 1,
      tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Miễn phí' }],
      foc_rules: []
    });
    addIfMissing('zentor', {
      id: 'znt_mkt_raincoat',
      kvCode: internalCodes.retiredRaincoat,
      name: 'Zentor raincoat (áo mưa)',
      category: 'Quà tặng',
      spec: 'Cái',
      packaging: 'Cái',
      unit: 'cái',
      box_size: 1,
      tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Miễn phí' }],
      foc_rules: []
    });
    // --- Zentor Polo size variants (match Excel "Goods Data" rows 115-128) ---
    // Polo Men (standard)
    addIfMissing('zentor', {
      id: 'znt_mkt_polo_men_s',
      kvCode: 'PVM01S',
      name: 'Zentor Polo Men Size S (Cái)',
      category: 'Quà tặng',
      spec: 'Cái',
      packaging: 'Cái',
      unit: 'cái',
      box_size: 1,
      tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Miễn phí' }],
      foc_rules: []
    });
    addIfMissing('zentor', {
      id: 'znt_mkt_polo_men_m',
      kvCode: 'PVM01M',
      name: 'Zentor Polo Men Size M (Cái)',
      category: 'Quà tặng',
      spec: 'Cái',
      packaging: 'Cái',
      unit: 'cái',
      box_size: 1,
      tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Miễn phí' }],
      foc_rules: []
    });
    addIfMissing('zentor', {
      id: 'znt_mkt_polo_men_l',
      kvCode: 'PVM01L',
      name: 'Zentor Polo Men Size L (Cái)',
      category: 'Quà tặng',
      spec: 'Cái',
      packaging: 'Cái',
      unit: 'cái',
      box_size: 1,
      tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Miễn phí' }],
      foc_rules: []
    });
    addIfMissing('zentor', {
      id: 'znt_mkt_polo_men_xl',
      kvCode: 'PVM01XL',
      name: 'Zentor Polo Men Size XL (Cái)',
      category: 'Quà tặng',
      spec: 'Cái',
      packaging: 'Cái',
      unit: 'cái',
      box_size: 1,
      tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Miễn phí' }],
      foc_rules: []
    });
    addIfMissing('zentor', {
      id: 'znt_mkt_polo_men_xxl',
      kvCode: 'PVM01XXL',
      name: 'Zentor Polo Men Size XXL (Cái)',
      category: 'Quà tặng',
      spec: 'Cái',
      packaging: 'Cái',
      unit: 'cái',
      box_size: 1,
      tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Miễn phí' }],
      foc_rules: []
    });
    // Polo Women
    addIfMissing('zentor', {
      id: 'znt_mkt_polo_women_m',
      kvCode: 'PVW01M',
      name: 'Zentor Polo Women Size M (Cái)',
      category: 'Quà tặng',
      spec: 'Cái',
      packaging: 'Cái',
      unit: 'cái',
      box_size: 1,
      tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Miễn phí' }],
      foc_rules: []
    });
    // Polo mè (Black Fabric Polo)
    addIfMissing('zentor', {
      id: 'znt_mkt_polo_me_m',
      kvCode: 'PVM01',
      name: 'Zentor Black Fabric Polo Size M (vải mè) (Cái)',
      category: 'Quà tặng',
      spec: 'Cái',
      packaging: 'Cái',
      unit: 'cái',
      box_size: 1,
      tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Miễn phí' }],
      foc_rules: []
    });
    addIfMissing('zentor', {
      id: 'znt_mkt_polo_me_l',
      kvCode: 'PVM02',
      name: 'Zentor Black Fabric Polo Size L (vải mè) (Cái)',
      category: 'Quà tặng',
      spec: 'Cái',
      packaging: 'Cái',
      unit: 'cái',
      box_size: 1,
      tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Miễn phí' }],
      foc_rules: []
    });
    addIfMissing('zentor', {
      id: 'znt_mkt_polo_me_xl',
      kvCode: 'PVM03',
      name: 'Zentor Black Fabric Polo Size XL (vải mè) (Cái)',
      category: 'Quà tặng',
      spec: 'Cái',
      packaging: 'Cái',
      unit: 'cái',
      box_size: 1,
      tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Miễn phí' }],
      foc_rules: []
    });
    addIfMissing('zentor', {
      id: 'znt_mkt_polo_me_xxl',
      kvCode: 'PVM04',
      name: 'Zentor Black Fabric Polo Size XXL (vải mè) (Cái)',
      category: 'Quà tặng',
      spec: 'Cái',
      packaging: 'Cái',
      unit: 'cái',
      box_size: 1,
      tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Miễn phí' }],
      foc_rules: []
    });
    // Polo cotton (Polo Đen vải 65/35)
    addIfMissing('zentor', {
      id: 'znt_mkt_polo_cotton_m',
      kvCode: 'PVY01M',
      name: 'Zentor Polo Đen (vải 65/35) (size M) (Cái)',
      category: 'Quà tặng',
      spec: 'Cái',
      packaging: 'Cái',
      unit: 'cái',
      box_size: 1,
      tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Miễn phí' }],
      foc_rules: []
    });
    addIfMissing('zentor', {
      id: 'znt_mkt_polo_cotton_l',
      kvCode: 'PVY01L',
      name: 'Zentor Polo Đen (vải 65/35) (size L) (Cái)',
      category: 'Quà tặng',
      spec: 'Cái',
      packaging: 'Cái',
      unit: 'cái',
      box_size: 1,
      tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Miễn phí' }],
      foc_rules: []
    });
    addIfMissing('zentor', {
      id: 'znt_mkt_polo_cotton_xl',
      kvCode: 'PVY01XL',
      name: 'Zentor Polo Đen (vải 65/35) (size XL) (Cái)',
      category: 'Quà tặng',
      spec: 'Cái',
      packaging: 'Cái',
      unit: 'cái',
      box_size: 1,
      tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Miễn phí' }],
      foc_rules: []
    });
    addIfMissing('zentor', {
      id: 'znt_mkt_polo_cotton_xxl',
      kvCode: 'PVY01XXL',
      name: 'Zentor Polo Đen (vải 65/35) (size XXL) (Cái)',
      category: 'Quà tặng',
      spec: 'Cái',
      packaging: 'Cái',
      unit: 'cái',
      box_size: 1,
      tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Miễn phí' }],
      foc_rules: []
    });

    // Injected missing Torvex MKT gift products
    addIfMissing('torvex', {
      id: 'torvex_helmet',
      kvCode: internalCodes.torvexHelmet,
      name: 'Nón bảo hiểm Torvex',
      category: 'Quà tặng',
      spec: 'Cái',
      packaging: 'Cái',
      unit: 'cái',
      box_size: 1,
      tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Miễn phí' }],
      foc_rules: []
    });

    // Injected missing XVIL MKT gift products
    addIfMissing('xvil', {
      id: 'xvil_mkt_tote_bag',
      kvCode: '850480',
      name: 'Túi canvas XVIL',
      category: 'Quà tặng',
      spec: 'Cái',
      packaging: 'Cái',
      unit: 'túi',
      box_size: 1,
      tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Miễn phí' }],
      foc_rules: []
    });
    addIfMissing('xvil', {
      id: 'xvil_mkt_cap',
      kvCode: internalCodes.xvilCap,
      name: 'Nón XVIL',
      category: 'Quà tặng',
      spec: 'Cái',
      packaging: 'Cái',
      unit: 'nón',
      box_size: 1,
      tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Miễn phí' }],
      foc_rules: []
    });
    addIfMissing('xvil', {
      id: 'xvil_mkt_spray',
      kvCode: internalCodes.xvilChainRoadBinh,
      name: 'Bình xịt XVIL',
      category: 'Quà tặng',
      spec: 'Cái',
      packaging: 'Cái',
      unit: 'bình',
      box_size: 1,
      tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Miễn phí' }],
      foc_rules: []
    });
    addIfMissing('xvil', {
      id: 'xvil_mkt_mat',
      kvCode: '',
      name: 'Thảm XVIL',
      category: 'Quà tặng',
      spec: 'Cái',
      packaging: 'Cái',
      unit: 'cái',
      box_size: 1,
      tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Miễn phí' }],
      foc_rules: []
    });
    addIfMissing('xvil', {
      id: 'xvil_mkt_shelf',
      kvCode: '',
      name: 'Kệ nhựa XVIL',
      category: 'Quà tặng',
      spec: 'Cái',
      packaging: 'Cái',
      unit: 'cái',
      box_size: 1,
      tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Miễn phí' }],
      foc_rules: []
    });
    addIfMissing('xvil', {
      id: 'xvil_mkt_drum',
      kvCode: '',
      name: 'Phuy rỗng XVIL',
      category: 'Quà tặng',
      spec: 'Cái',
      packaging: 'Cái',
      unit: 'cái',
      box_size: 1,
      tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Miễn phí' }],
      foc_rules: []
    });

    // Cleanup: Remove stale fake MKT products that were wrongly injected (Torvex and Zentor targets removed)
    const staleProductIds = {
      xvil: ['mkt_keychain', 'mkt_raincoat']
    };
    for (const [campKey, ids] of Object.entries(staleProductIds)) {
      if (this.data.campaigns[campKey]) {
        const before = this.data.campaigns[campKey].products.length;
        this.data.campaigns[campKey].products = this.data.campaigns[campKey].products.filter(p => !ids.includes(p.id));
        if (this.data.campaigns[campKey].products.length < before) {
          modified = true;
          console.log(`Removed ${before - this.data.campaigns[campKey].products.length} stale MKT products from ${campKey}`);
        }
      }
    }

    // Cleanup: Remove stale aliases pointing to removed gift products (Zentor and Torvex targets removed)
    const staleAliasTargets = ['mkt_keychain', 'mkt_raincoat'];
    if (this.customAliases) {
      for (const [aliasKey, targetId] of Object.entries(this.customAliases)) {
        if (staleAliasTargets.includes(targetId)) {
          delete this.customAliases[aliasKey];
          modified = true;
        }
      }
    }

    // ══ MIGRATION KHÔNG PHÁ HỦY: vá các luật quà tặng bị thiếu/sai trên DB cũ (IndexedDB) ══
    // [Promo v1.3.0] Rule KM của SP nằm trong campaign.promoRules (type 'qty', scope 'product').
    // Chạy mỗi lần khởi động, an toàn (idempotent), tự persist qua this.save() bên dưới.
    for (const camp of Object.values(this.data.campaigns)) {
      if (!Array.isArray(camp.promoRules)) continue;
      for (const p of (camp.products || [])) {
        const prodRules = camp.promoRules.filter(r => r && r.type === 'qty' && r.scope === 'product' && r.productId === p.id);
        // (1) DD súc rửa / Xịt dưỡng sên: chương trình "mua mỗi CHAI tặng 1 lon Veltron/XVIL".
        //     DB cũ thiếu buy_unit → hiểu nhầm là tính theo THÙNG → mua 1 thùng chỉ tặng 1 quà.
        //     Vá bắt buộc buy.unit='chai' (nhận diện theo gift productId/options, không phụ thuộc note).
        const _cleanerGiftIds = ['veltron_veltron_engine_cleaner_shot', 'xvil_xvil_xtorq_chain_road_100ml'];
        for (const rule of prodRules) {
          const ruleGiftIds = [];
          for (const g of (rule.gifts || [])) {
            ruleGiftIds.push(g && g.productId);
            if (Array.isArray(g && g.options)) ruleGiftIds.push(...g.options);
          }
          const isCleanerRule = ruleGiftIds.filter(Boolean).some(id => _cleanerGiftIds.includes(id));
          if (isCleanerRule && String((rule.buy && rule.buy.unit) || '').toLowerCase().trim() !== 'chai') {
            rule.buy = { qty: 1, unit: 'chai' };
            modified = true;
            console.log(`[Migration 1] Fixed per-chai cleaner gift rule on: ${p.id}`);
          }
        }
        // (5) Gộp luật polo + nón tách rời thành 1 luật phân cấp.
        //     DB cũ tách thành 2 luật riêng → mua 1 thùng bị tặng CẢ polo LẪN nón (2 quà).
        //     Đúng: tặng 1 quà, chọn polo (kèm size) HOẶC nón — khớp với DB gốc.
        const poloRule = prodRules.find(r => r.kind === 'mkt_pp' &&
          r.gifts && r.gifts[0] && r.gifts[0].productId === 'torvex_polo_mxo_size_m' &&
          !r.gifts[0].subOptions && Array.isArray(r.gifts[0].options) && r.gifts[0].options.length === 5);
        const capRule = prodRules.find(r => r.kind === 'mkt_pp' &&
          r.gifts && r.gifts[0] && r.gifts[0].productId === 'torvex_cap_mxo');
        if (poloRule && capRule) {
          const merged = {
            id: poloRule.id,
            type: 'qty', scope: 'product', enabled: true, kind: 'mkt_pp',
            productId: p.id,
            buy: { qty: poloRule.buy.qty, unit: poloRule.buy.unit || '' },
            gifts: [{
              qty: poloRule.gifts[0].qty,
              productId: 'torvex_polo_mxo_size_m',
              unit: poloRule.gifts[0].unit || 'cái',
              options: ['torvex_polo_mxo_size_m', 'torvex_cap_mxo'],
              subOptions: { 'torvex_polo_mxo_size_m': poloRule.gifts[0].options.slice() },
              name: 'Áo polo Torvex / Nón Torvex'
            }],
            label: '', note: 'Mua 1 thùng tặng 1 áo polo (chọn size) hoặc nón Torvex', needs_review: false
          };
          camp.promoRules = camp.promoRules.filter(r => r !== poloRule && r !== capRule);
          camp.promoRules.push(merged);
          modified = true;
        }
      }
    }
    // (3) Xvil Jerry Can — sản phẩm có trong DB gốc nhưng có thể thiếu trên DB cũ.
    addIfMissing('xvil', {
      id: 'xvil_xvil_jerry_can',
      kvCode: internalCodes.xvilJerryCan,
      name: 'Xvil Jerry Can (Metal) 20L',
      spec: 'Can kim loại 20L',
      packaging: '1 thùng x 5 cái',
      unit: 'cái',
      box_size: 1,
      tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Tất cả' }],
      foc_rules: []
    });
    // (4) Móc khóa Torvex — để đơn Torvex + "tặng móc khóa" khớp đúng hàng Torvex (không phải Zentor).
    addIfMissing('torvex', {
      id: 'torvex_mkt_keyring',
      kvCode: internalCodes.torvexKeyring,
      name: 'Torvex Keyring (Móc khóa) (Cái)',
      category: 'Quà tặng',
      spec: 'Cái',
      packaging: 'Cái',
      unit: 'cái',
      box_size: 1,
      tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Miễn phí' }],
      foc_rules: []
    });
    // (6) Áo thun đen new (4 size) — DB lưu cũ có thể thiếu → inject để matcher nhận diện.
    //     Thiếu SP này là nguyên nhân input "áo thun đen new size L" bị AI khớp nhầm sang Good Scoot.
    addIfMissing('torvex', {
      id: 'torvex_ao_thun_den_new_s',
      kvCode: 'ATDN01S',
      name: 'Torvex áo thun đen new (size S)',
      category: 'Quà tặng',
      spec: 'Cái',
      packaging: 'Cái',
      unit: 'cái',
      box_size: 1,
      tiers: [],
      foc_rules: []
    });
    addIfMissing('torvex', {
      id: 'torvex_ao_thun_den_new_m',
      kvCode: 'ATDN01M',
      name: 'Torvex áo thun đen new (size M)',
      category: 'Quà tặng',
      spec: 'Cái',
      packaging: 'Cái',
      unit: 'cái',
      box_size: 1,
      tiers: [],
      foc_rules: []
    });
    addIfMissing('torvex', {
      id: 'torvex_ao_thun_den_new_l',
      kvCode: 'ATDN01L',
      name: 'Torvex áo thun đen new (size L)',
      category: 'Quà tặng',
      spec: 'Cái',
      packaging: 'Cái',
      unit: 'cái',
      box_size: 1,
      tiers: [],
      foc_rules: []
    });
    addIfMissing('torvex', {
      id: 'torvex_ao_thun_den_new_xl',
      kvCode: 'ATDN01XL',
      name: 'Torvex áo thun đen new (size XL)',
      category: 'Quà tặng',
      spec: 'Cái',
      packaging: 'Cái',
      unit: 'cái',
      box_size: 1,
      tiers: [],
      foc_rules: []
    });

    if (modified) {
      this.save();
    }
  }

  sanitizeProductNames() {
    if (!this.data || !this.data.campaigns) return;
    let modified = false;
    for (const campaign of Object.values(this.data.campaigns)) {
      if (!campaign.products) continue;
      for (const p of campaign.products) {
        if (p.name && (p.name.includes('bÃ¬nh') || p.name.includes('xÃ´') || p.name.includes('Â°'))) {
          p.name = p.name
            .replace(/bÃ¬nh/g, 'bình')
            .replace(/xÃ´/g, 'xô')
            .replace(/Â°/g, '°');
          modified = true;
        }
      }
    }
    if (modified) {
      this.save();
    }
  }

  sanitizeCampaigns() {
    if (!this.data || !this.data.campaigns) return;
    let modified = false;
    // [Promo v1.3.3] Bộ lọc rule FOC sai của 2 SP znt_mxo đã CHUYỂN vào
    // _applyZentorMktFix() (chạy đúng 1 lần, gated) — không còn xóa mỗi boot.
    for (const [key, campaign] of Object.entries(this.data.campaigns)) {
      if (!campaign.brand) {
        if (key.startsWith('znt')) campaign.brand = 'zentor';
        else if (key.startsWith('torvex') || key.startsWith('tvx')) campaign.brand = 'torvex';
        else if (key.startsWith('xvil')) campaign.brand = 'xvil';
        else if (key.startsWith('veltra')) campaign.brand = 'veltra';
        else if (key.startsWith('petrix')) campaign.brand = 'petrix';
        else if (key.startsWith('veltron')) campaign.brand = 'veltron';
        else campaign.brand = 'zentor'; // default fallback
        modified = true;
      }
      // [Promo v1.3.0] Campaign thiếu mảng promoRules → gán rỗng (engine/Settings chạy an toàn)
      if (!Array.isArray(campaign.promoRules)) {
        campaign.promoRules = [];
        modified = true;
      }
    }
    if (this._applyZentorMktFix()) {
      modified = true;
    }
    if (modified) {
      this.save();
    }
  }

  /**
   * [Promo v1.3.3] Rà & sửa mốc quà MKT Zentor (campaign.promoRules type 'total',
   * scope 'campaign') — migration CHẠY ĐÚNG 1 LẦN, gate data.zntMktFixedVersion.
   *
   * Trước 1.3.3 (hàm _ensureZentorMktRulesSynced) chạy MỖI boot không gated:
   * chỉ cần thiếu 1 trong các gift chuẩn (znt_mkt_keyring/cap/polo_me_l), hoặc
   * hết mốc, hoặc thấy áo mưa/keyring sai là THAY NGUYÊN bộ total rules bằng seed
   * → user bớt/thêm sản phẩm-quà trong CTKM Zentor bị reset về mặc định ở boot
   * kế tiếp. Sau 1.3.3: lần boot đầu (flag chưa set) rà 1 lần như cũ; mọi boot sau
   * no-op → chỉnh sửa của user được GIỮ. Muốn áp lại seed Zentor (đổi bảng seed)
   * → bump ZNT_MKT_FIX_VERSION.
   * Các quy tắc sửa (giữ nguyên intent cũ):
   * - Loại bỏ áo mưa (raincoat / Áo mưa): 1 áo mưa = 2 túi rút thể thao;
   *   2 áo mưa = 1 nón + 1 túi rút thể thao (quy đổi theo seed).
   * - Sửa mã móc khóa sang Zentor Keyring (mã KV: zntKeyring trong internal-codes.json),
   * - Một lần duy nhất: gỡ rule FOC sai của 2 SP znt_mxo (Prostream TT 2T Ester /
   *   Topgear GP 2T Ester+) — trước đây nằm trong sanitizeCampaigns chạy mỗi boot.
   * @returns {boolean} true nếu đã chạy pass rà soát lần này (caller persist flag).
   */
  _applyZentorMktFix() {
    if (!this.data || !this.data.campaigns) return false;
    if (Number(this.data.zntMktFixedVersion || 0) >= ZNT_MKT_FIX_VERSION) return false;
    this.data.zntMktFixedVersion = ZNT_MKT_FIX_VERSION;
    let modified = false;

    // [1] Gỡ 1 lần (không lặp lại mỗi boot) rule FOC sai của 2 SP znt_mxo
    const wrongFocIds = new Set(['znt_mxo_prostream_tt_2t_ester', 'znt_mxo_zentor_topgear_gp_2t_ester']);
    for (const campaign of Object.values(this.data.campaigns)) {
      if (!Array.isArray(campaign.promoRules)) continue;
      const before = campaign.promoRules.length;
      campaign.promoRules = campaign.promoRules.filter(r =>
        !(r && r.type === 'qty' && r.scope === 'product' && wrongFocIds.has(r.productId)));
      if (campaign.promoRules.length !== before) modified = true;
    }

    // [2] Rà mốc quà MKT Zentor
    const znt = this.data.campaigns.zentor;
    if (znt) {
      const seedTotal = ((DEFAULT_DB.campaigns || {}).zentor || {}).promoRules || [];
      const rules = Array.isArray(znt.promoRules) ? znt.promoRules : [];
      const totalRules = rules.filter(r => r && r.type === 'total' && r.scope === 'campaign');
      const rulesJson = JSON.stringify(totalRules || []);

      // Phát hiện nếu còn chứa áo mưa/raincoat/mã cũ áo mưa, hoặc còn chứa Torvex
      // Keyring (mã KV torvexKeyring), hoặc thiếu liên kết Nón/Polo/Móc khóa chuẩn.
      const hasRaincoat = new RegExp('raincoat|áo mưa|' + internalCodes.retiredRaincoat, 'i').test(rulesJson);
      const hasTorvexKeyring = new RegExp(internalCodes.torvexKeyring + '|torvex_mkt_keyring|Torvex Keyring', 'i').test(rulesJson);
      const hasUnlinkedOrWrong = !rulesJson.includes('znt_mkt_keyring') || !rulesJson.includes('znt_mkt_cap') || !rulesJson.includes('znt_mkt_polo_me_l');

      if (totalRules.length === 0 || hasRaincoat || hasTorvexKeyring || hasUnlinkedOrWrong) {
        const seedTotals = seedTotal.filter(r => r && r.type === 'total' && r.scope === 'campaign');
        znt.promoRules = [
          ...rules.filter(r => !(r && r.type === 'total' && r.scope === 'campaign')),
          ...JSON.parse(JSON.stringify(seedTotals))
        ];
        modified = true;
      }
    }

    if (modified) this._bumpDataVersion();
    return true; // đã chạy pass rà soát lần này → caller persist (flag là dữ liệu mới)
  }

  /**
   * [v1.3.3] Giữ snapshot N bản gần nhất của DB NGUYÊN TRẠNG trước khi chạy các
   * migration/seed ở boot — lưới an toàn khi một migration làm mất dữ liệu.
   * Lưu qua dbStore (cùng IndexedDB, key riêng — migration không đụng tới key này).
   * Khôi phục khẩn cấp (KHÔNG có UI): dbStore.get(DB_BACKUP_KEY) → chọn bản cần →
   * dbStore.set(DB_STORAGE_KEY, bản.data). Chỉ giữ MAX_PRE_MIGRATION_BACKUPS bản.
   */
  async _snapshotPreMigrationBackups(savedData) {
    try {
      const list = (await dbStore.get(DB_BACKUP_KEY)) || [];
      list.push({
        ts: new Date().toISOString(),
        priceVersion: savedData.priceVersion || '',
        promoRulesVersion: Number(savedData.promoRulesVersion || 0),
        data: JSON.parse(JSON.stringify(savedData))
      });
      while (list.length > MAX_PRE_MIGRATION_BACKUPS) list.shift();
      await dbStore.set(DB_BACKUP_KEY, list);
    } catch (e) {
      console.warn('[DB] Pre-migration backup failed (không chặn boot):', e && e.message);
    }
  }

  /** Lọc rule theo sản phẩm (type + kind) từ campaign.promoRules. */
  _getProductRules(product, type, kind) {
    if (!this.data || !this.data.campaigns || !product || !product.campaignKey) return [];
    const campaign = this.data.campaigns[product.campaignKey];
    if (!campaign || !Array.isArray(campaign.promoRules)) return [];
    return campaign.promoRules.filter(r =>
      r && r.enabled !== false && r.type === type &&
      (!kind || r.kind === kind) &&
      r.scope === 'product' && r.productId === product.id);
  }

  /**
   * [Promo v1.3.0] Tự sinh label từ SỐ của rule (mốc + quà) — không ai nhập chuỗi mô tả tay.
   * VD: Mua 1 thùng tặng 2 chai; 2 thùng; 2-5 triệu.
   */
  _buildPromoLabel(rule) {
    try {
      if (!rule) return '';
      const giftName = (g) => {
        const prod = (g && g.productId && g.productId !== '__same__') ? this.findProductById(g.productId) : null;
        return prod ? prod.name : ((g && g.name) || 'quà');
      };
      if (rule.type === 'qty') {
        const buyUnit = (rule.buy && rule.buy.unit) || 'thùng';
        const gifts = Array.isArray(rule.gifts) && rule.gifts.length ? rule.gifts : [{ qty: 1, name: 'quà' }];
        const parts = gifts.map(g => {
          const unit = (g.unit || (this.findProductById(g.productId) || {}).unit || '').trim();
          return `${(g.qty || 1)}${unit ? ' ' + unit : ''} ${giftName(g)}`.replace(/\s+/g, ' ').trim();
        });
        return `Mua ${(rule.buy && rule.buy.qty) || 1} ${buyUnit} tặng ${parts.join(' + ')}`;
      }
      if (rule.type === 'total') {
        const t = rule.threshold || { min: 0, max: 0, basis: 'money' };
        const a = t.basis === 'boxes' ? t.min : Math.round((t.min || 0) / 1e6);
        const b = t.basis === 'boxes' ? t.max : Math.round((t.max || 0) / 1e6);
        const suffix = t.basis === 'boxes' ? ' thùng' : ' triệu';
        const openEnd = t.basis === 'boxes' && t.max >= 9999;
        return `${a}${!openEnd && b !== a ? '-' + b : ''}${suffix}`;
      }
      if (rule.type === 'text') return rule.label || (Array.isArray(rule.keywords) && rule.keywords[0]) || 'KM dạng text';
      return rule.label || '';
    } catch (_) {
      return rule && rule.label ? rule.label : '';
    }
  }

  /**
   * [Promo v1.3.0] Quà theo số lượng mua — đọc rule type:'qty' scope:'product' (kind 'foc')
   * từ campaign.promoRules. Với mỗi quà: đối chiếu mốc, chọn rule cho TỔNG quà lớn nhất;
   * quà KHÁC LOẠI nhau cùng được áp dụng (không loại trừ). '__same__' → tặng cùng loại SP.
   * Output GIỮ shape legacy (give_product/give_unit/total_give/note) để mọi consumer
   * (calculator/headless/ui) không đổi, kèm provenance ruleId/ruleType/milestone/label.
   * System rule "lẻ lon → tuýp hộp số" vẫn là derivation engine (ruleId 'system:gear_oil').
   */
  getFOCForQty(product, qty, bottleQty) {
    if (!product || !product.campaignKey) return [];
    const rules = this._getProductRules(product, 'qty', 'foc');
    if (rules.length === 0) return [];
    const sorted = [...rules].sort((a, b) => (b.buy.qty || 0) - (a.buy.qty || 0));
    // Trả về MẢNG các rule thỏa điều kiện: với mỗi sản phẩm tặng (give_product),
    // ĐỐI CHIẾU các mốc và chọn rule cho TỔNG quà lớn nhất. Nhờ vậy:
    //  - SP CÓ mốc "mua 1 tặng 1" → scale tuyến tính (mua 5 tặng 5).
    //  - SP CHỈ có mốc "mua 4 tặng 4" → giữ mốc (mua 5 tặng 4), không tự bịa thêm.
    const results = [];
    const bestByGift = new Map();
    for (const rule of sorted) {
      // buy.unit: ''/'thùng' (mặc định, tính theo thùng) hoặc 'chai'/'lon'/'can'/'tuýp' (theo số lẻ)
      const buyUnit = (rule.buy && rule.buy.unit) || 'thùng';
      const buyUnitN = buyUnit.toLowerCase().trim();
      const isBottleBased = (buyUnitN === 'chai' || buyUnitN === 'lon' || buyUnitN === 'can' || buyUnitN === 'tuýp' || buyUnitN === 'tuyp');
      const compareQty = isBottleBased
        ? (bottleQty !== undefined && bottleQty !== null ? bottleQty : qty)
        : qty;
      if (compareQty < (rule.buy.qty || 1)) continue;
      const times = Math.floor(compareQty / (rule.buy.qty || 1));
      for (const gift of (Array.isArray(rule.gifts) ? rule.gifts : [])) {
        // Rule chưa link quà (needs_review) → KHÔNG đoán nữa: bỏ qua, Settings hiện cảnh báo
        if (!gift || !gift.productId) continue;
        const giveProduct = gift.productId === '__same__' ? product.id : gift.productId;
        const totalGive = times * (Number(gift.qty) || 1);
        const entry = {
          ...rule,
          give_product: giveProduct,
          give_unit: gift.unit || '',
          isSameProduct: giveProduct === product.id,
          total_give: totalGive,
          times,
          // ── Provenance: ruleId + mốc số để đơn biết "cấu thành" từ rule nào ──
          ruleId: rule.id,
          ruleType: 'qty',
          milestone: { buy_qty: rule.buy.qty, buy_unit: buyUnitN },
          label: this._buildPromoLabel(rule)
        };
        const existing = bestByGift.get(giveProduct);
        if (!existing || totalGive > existing.total_give ||
            (totalGive === existing.total_give && (rule.buy.qty || 0) > (existing.buy.qty || 0))) {
          bestByGift.set(giveProduct, entry);
        }
      }
    }
    for (const entry of bestByGift.values()) results.push(entry);

    // ─── SYSTEM RULE: Mua lẻ lon/chai SP có promotion gear oil theo thùng → tự tặng 1 tuýp/lon ───
    // Không phụ thuộc data rule per-lon — engine tự suy luận (ruleId 'system:gear_oil').
    if (bottleQty != null && bottleQty > 0) {
      const pUnit = (product.unit || '').toLowerCase().trim();
      if (pUnit !== 'tuýp' && pUnit !== 'tuyp') {
        const hasThungGearOil = sorted.some(r => {
          const u = ((r.gifts && r.gifts[0] && r.gifts[0].unit) || '').toLowerCase().trim();
          return (u === 'tuýp' || u === 'tuyp') && !((r.buy && r.buy.unit) || '').trim();
        });
        const alreadyHasGearOil = results.some(r => {
          const u = (r.give_unit || '').toLowerCase().trim();
          return u === 'tuýp' || u === 'tuyp';
        });
        if (hasThungGearOil && !alreadyHasGearOil) {
          let gearOilId = 'torvex_gear_oil';
          if (product.campaignKey && product.campaignKey.includes('veltron')) gearOilId = 'veltron_veltron_scooter_gear_oil_sae_80w_90';
          else if (product.campaignKey === 'torvex' || product.id.startsWith('torvex')) gearOilId = 'torvex_gear_oil';
          results.push({
            buy_qty: 1, buy_unit: 'lon', give_qty: 1, give_unit: 'tuýp',
            give_product: gearOilId, isSameProduct: false,
            total_give: bottleQty, times: bottleQty,
            ruleId: 'system:gear_oil', ruleType: 'qty',
            milestone: { buy_qty: 1, buy_unit: 'lon' },
            label: `Mua lẻ ${bottleQty} lon tặng ${bottleQty} tuýp hộp số (system)`,
            note: `Mua ${bottleQty} lon tặng ${bottleQty} tuýp hộp số (system)`
          });
        }
      }
    }

    return results;
  }

  /**
   * [Promo v1.3.0] Quà theo mốc tổng đơn campaign — type:'total' scope:'campaign'.
   * Mốc theo thùng: chỉ tính THÙNG ĐỦ (làm tròn xuống) — đơn mua kèm chai lẻ
   * (VD 2 thùng + 6 chai = 2.4) vẫn đạt mốc 2 thùng, không rơi vào khoảng
   * trống giữa 2 mốc nguyên rồi mất quà. Trả rule (kèm label tự sinh) hoặc null.
   */
  getMKTGifts(campaignKey, totalAmount, totalBoxes) {
    if (!this.data || !this.data.campaigns) return null;
    const campaign = this.data.campaigns[campaignKey];
    const rules = (campaign && Array.isArray(campaign.promoRules))
      ? campaign.promoRules.filter(r => r && r.enabled !== false && r.type === 'total' && r.scope === 'campaign')
      : [];
    for (const rule of rules) {
      const t = rule.threshold || { min: 0, max: 0, basis: 'money' };
      const compareVal = t.basis === 'boxes' ? Math.floor(totalBoxes) : totalAmount;
      if (compareVal >= t.min && compareVal <= t.max) {
        return { ...rule, label: this._buildPromoLabel(rule) };
      }
    }
    return null;
  }

  /**
   * [Promo v1.3.0] MỐC TIỀN/SỐ LƯỢNG THEO TỪNG DÒNG SẢN PHẨM — type:'total' scope:'product'.
   * "Mua 1.8tr tặng nón" giờ là rule SỐ: basis 'money' so lineSubtotal (qty × giá),
   * basis 'boxes' so lineQty (đơn vị thùng). Trả rule (kèm label) hoặc null.
   */
  getProductMoneyPromoRule(product, lineSubtotal, lineQty) {
    if (!product || !product.campaignKey) return null;
    const rules = this._getProductRules(product, 'total');
    for (const rule of rules) {
      const t = rule.threshold || { min: 0, max: 0, basis: 'money' };
      const v = t.basis === 'money' ? (Number(lineSubtotal) || 0) : (lineQty !== undefined ? lineQty : 0);
      if (v >= t.min && v <= t.max) {
        return { ...rule, label: this._buildPromoLabel(rule) };
      }
    }
    return null;
  }

  /** [Promo v1.3.0] Mọi rule KM của 1 sản phẩm (type 'qty'/'total' scope product). */
  getPromoRulesForProduct(productId) {
    if (!this.data || !this.data.campaigns) return [];
    const out = [];
    for (const campaign of Object.values(this.data.campaigns)) {
      if (!Array.isArray(campaign.promoRules)) continue;
      for (const r of campaign.promoRules) {
        if (r && r.scope === 'product' && r.productId === productId) out.push(r);
      }
    }
    return out;
  }

  /** [Promo v1.3.0] Ghi đè toàn bộ rule KM của 1 sản phẩm (qty + total product scope). */
  replaceProductPromoRules(productId, rules) {
    if (!this.data || !this.data.campaigns) return false;
    const list = Array.isArray(rules) ? rules : [];
    for (const campaign of Object.values(this.data.campaigns)) {
      if (!Array.isArray(campaign.promoRules)) continue;
      const kept = campaign.promoRules.filter(r => !(r && r.scope === 'product' && r.productId === productId));
      for (const r of list) {
        kept.push({ id: r.id || _promoBaseId(productId, 'u', kept.length), ...r, scope: 'product', productId });
      }
      campaign.promoRules = kept;
      this._bumpDataVersion();
      this.save();
      return true;
    }
    return false;
  }

  /**
   * [Promo v1.3.0] Registry "chương trình KM dạng text" (campaign.promoRules type 'text'):
   * ánh xạ tên quà khai trong tin nhắn → sản phẩm quà chuẩn hóa có kvCode, để pipeline
   * parse resolve đúng thay vì đoán fuzzy (tránh rơi vào __unmatched_gift__).
   * - Rule nằm trong campaign của sản phẩm mẹ + mọi rule global:true (áp dụng mọi campaign).
   * - Match tên 2 chiều sau khi bỏ dấu: name chứa keyword / keyword chứa name (name ≥ 3 ký tự).
   * - rule.unitHint khác rỗng → unit quà bỏ dấu phải khớp chính xác.
   * - Ưu tiên: rule campaign cụ thể > global; keyword dài > ngắn; chiều name chứa keyword.
   * - Sản phẩm quà đã bị xóa khỏi DB → bỏ qua rule (fallback fuzzy như cũ).
   * Trả { rule, product } hoặc null.
   */
  getPromoTextMatch(name, unit, campaignKey) {
    if (!this.data || !this.data.campaigns) return null;
    const norm = (s) => String(s || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd')
      .replace(/\s+/g, ' ').trim();
    const nameN = norm(name);
    const unitN = norm(unit);
    if (!nameN) return null;

    const candidates = [];
    const collect = (rulesArr, isGlobal) => {
      if (!Array.isArray(rulesArr)) return;
      for (const rule of rulesArr) {
        if (!rule || rule.type !== 'text' || rule.enabled === false) continue;
        // Rule của campaign KHÁC chỉ áp dụng khi được đánh dấu global (áp dụng mọi
        // thương hiệu); rule global:false chỉ có hiệu lực trong campaign của nó.
        if (isGlobal && rule.global !== true) continue;
        if (!Array.isArray(rule.keywords) || rule.keywords.length === 0) continue;
        const gift = Array.isArray(rule.gifts) ? rule.gifts[0] : null;
        if (!gift || !gift.productId || !this.findProductById(gift.productId)) continue;
        if (rule.unitHint && unitN && norm(rule.unitHint) !== unitN) continue;
        candidates.push({ rule, gift, isGlobal });
      }
    };
    const parentCampaign = this.data.campaigns[campaignKey];
    if (parentCampaign) collect(parentCampaign.promoRules, false);
    for (const [key, c] of Object.entries(this.data.campaigns)) {
      if (!c || key === campaignKey) continue;
      collect(c.promoRules, true);
    }
    if (candidates.length === 0) return null;

    let best = null;
    let bestScore = -1;
    for (const { rule, isGlobal } of candidates) {
      for (const kwRaw of rule.keywords) {
        const kwN = norm(kwRaw);
        if (kwN.length < 3) continue;
        const nameContainsKw = nameN.includes(kwN);
        const kwContainsName = !nameContainsKw && nameN.length >= 3 && kwN.includes(nameN);
        if (!nameContainsKw && !kwContainsName) continue;
        const score = (isGlobal ? 0 : 100) + kwN.length + (nameContainsKw ? 10 : 0);
        if (score > bestScore) {
          bestScore = score;
          best = rule;
        }
      }
    }
    if (!best) return null;
    return { rule: best, product: this.findProductById(best.gifts[0].productId) };
  }

  addCampaign(key, data) {
    if (!this.data || !this.data.campaigns) return false;
    if (this.data.campaigns[key]) return false;
    // [Promo v1.3.0] KM dùng mảng promoRules thống nhất (không còn mkt_gift_rules/promoTextRules)
    this.data.campaigns[key] = { name: data.name || key, color: data.color || '#4fc3f7', icon: data.icon || '📦', products: [], promoRules: [], ...data };
    this.save();
    return true;
  }

  updateCampaign(key, updates) {
    if (!this.data || !this.data.campaigns) return false;
    if (!this.data.campaigns[key]) return false;
    Object.assign(this.data.campaigns[key], updates);
    this.save();
    return true;
  }

  deleteCampaign(key) {
    if (!this.data || !this.data.campaigns) return false;
    if (!this.data.campaigns[key]) return false;
    delete this.data.campaigns[key];
    this.save();
    return true;
  }

  generateProductId(name) {
    return name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd')
      .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') + '_' + Date.now().toString(36).slice(-4);
  }

  addProduct(campaignKey, product) {
    if (!this.data || !this.data.campaigns) return null;
    if (!this.data.campaigns[campaignKey]) return null;
    if (!product.id) product.id = this.generateProductId(product.name || 'product');
    if (!product.tiers) product.tiers = [];
    // [Promo v1.3.0] Rule KM của SP nằm ở campaign.promoRules (scope 'product') — không có field trên product
    this.data.campaigns[campaignKey].products.push(product);
    this.save();
    return product;
  }

  updateProduct(productId, updates) {
    if (!this.data || !this.data.campaigns) {
      _dbLog.error('updateProduct: data/campaigns chưa khởi tạo', { productId, updates });
      return false;
    }
    for (const campaign of Object.values(this.data.campaigns)) {
      const idx = campaign.products.findIndex(p => p.id === productId);
      if (idx !== -1) { campaign.products[idx] = { ...campaign.products[idx], ...updates }; this.save(); return true; }
    }
    // KHÔNG tìm thấy sản phẩm → caller PHẢI biết để đừng báo "đã lưu".
    _dbLog.error('updateProduct: KHÔNG tìm thấy sản phẩm trong bất kỳ campaign nào', { productId, updates });
    return false;
  }

  deleteProduct(productId) {
    if (!this.data || !this.data.campaigns) return false;
    for (const campaign of Object.values(this.data.campaigns)) {
      const idx = campaign.products.findIndex(p => p.id === productId);
      if (idx !== -1) {
        campaign.products.splice(idx, 1);
        // Dọn TRIỆT ĐỂ để SP đã xóa không còn "sống" trong tìm kiếm/parse theo mã & alias:
        // 1) Gỡ mã KV khỏi map runtime + persist xóa khỏi kv-name-map.json / app-config.json
        delete this.kvCodeMap[productId];
        delete this.kvCodeThungMap[productId];
        if (typeof window !== 'undefined' && window.electronAPI) {
          if (window.electronAPI.setKvBaseCode) {
            window.electronAPI.setKvBaseCode({ productId, code: '' }).catch(() => {});
          }
          if (window.electronAPI.setKvThungOverride) {
            window.electronAPI.setKvThungOverride({ productId, code: '' }).catch(() => {});
          }
        }
        // 2) Gỡ alias trỏ về SP đã xóa (custom → xóa hẳn; default → đánh dấu đã xóa)
        let aliasTouched = false;
        for (const [alias, pid] of Object.entries(this.customAliases)) {
          if (pid === productId) { delete this.customAliases[alias]; aliasTouched = true; }
        }
        for (const alias of Object.keys(DEFAULT_ALIASES)) {
          if (DEFAULT_ALIASES[alias] === productId) { this.removedDefaultAliases[alias] = true; aliasTouched = true; }
        }
        if (aliasTouched) this.saveAliases();
        this.save();
        return true;
      }
    }
    return false;
  }

  updateProductTiers(productId, tiers) {
    if (!this.data || !this.data.campaigns) return false;
    for (const campaign of Object.values(this.data.campaigns)) {
      const product = campaign.products.find(p => p.id === productId);
      if (product) { product.tiers = tiers || product.tiers || []; this.save(); return true; }
    }
    return false;
  }

  getAliases() {
    // Gộp alias mặc định + alias người dùng thêm, loại bỏ các alias mặc định đã bị xóa
    const merged = { ...DEFAULT_ALIASES, ...this.customAliases };
    for (const alias of Object.keys(this.removedDefaultAliases || {})) {
      delete merged[alias];
    }
    return merged;
  }

  addAlias(alias, productId) {
    const key = alias.toLowerCase().trim();
    this.customAliases[key] = productId;
    // Thêm lại alias mặc định đã xóa trước đó → thu hồi trạng thái "đã xóa"
    if (this.removedDefaultAliases[key]) delete this.removedDefaultAliases[key];
    this.saveAliases();
  }

  removeAlias(alias) {
    const key = alias.toLowerCase().trim();
    delete this.customAliases[key];
    // Alias mặc định không xóa được khỏi DEFAULT_ALIASES → ghi nhận vào danh sách loại trừ
    if (DEFAULT_ALIASES[key] !== undefined) {
      this.removedDefaultAliases[key] = true;
    }
    this.saveAliases();
  }

  getAliasesForProduct(productId) {
    const all = this.getAliases();
    const result = [];
    for (const [alias, pid] of Object.entries(all)) {
      if (pid === productId) {
        result.push({ alias, isDefault: DEFAULT_ALIASES[alias] === productId, isCustom: this.customAliases[alias] === productId });
      }
    }
    return result;
  }

  bulkImportProducts(campaignKey, products) {
    if (!this.data || !this.data.campaigns) return 0;
    if (!this.data.campaigns[campaignKey]) return 0;
    let count = 0;
    for (const p of products) {
      if (!p.id) p.id = this.generateProductId(p.name || 'imported');
      if (!p.tiers) p.tiers = [];
      this.data.campaigns[campaignKey].products.push(p);
      count++;
    }
    this.save();
    return count;
  }
}

/**
 * Phân tích số lượng đơn vị lẻ trong 1 thùng từ chuỗi packaging.
 * VD: "400ml x 12 chai" → 12, "4 Kit/ Thùng" → 4, "1 hộp x 12 cái" → 12.
 * Trả về null nếu không nhận diện được mẫu (giữ nguyên box_size hiện tại).
 */
function parsePackagingQty(packaging) {
  if (!packaging) return null;
  const s = String(packaging).trim();
  // Dạng "... x N ..." (VD: 400ml x 12 chai, 1 hộp x 12 cái, 20 bình x 1 lít).
  // (?![.,]\d) — bỏ qua số THẬP PHÂN: "10 bình x 1,5 lít" là 10 chai × thể tích
  // 1,5 lít, KHÔNG phải "x 1" (trước đây bị ép box_size 10 → 1).
  let m = s.match(/x\s*(\d+)\b(?![.,]\d)/i);
  if (m) return parseInt(m[1], 10);
  // Dạng "N ... / Thùng" (VD: 4 Kit/ Thùng, 12 chai/ thùng, 20 bình/thùng)
  m = s.match(/^(\d+)\s*[^/]*\/\s*(?:thùng|thung)\b/i);
  if (m) return parseInt(m[1], 10);
  // Dạng "N bình/chai/can/xô/phuy/hộp/tuýp" (VD: 20 bình x 1 lít, 4 bình x 4 lít)
  m = s.match(/^(\d+)\s*(?:bình|binh|can|chai|hộp|hop|tuýp|tuyp|bộ|bo|gói|goi|xô|xo|phuy|cái|cai)\b/i);
  if (m) return parseInt(m[1], 10);
  // Fallback: chỉ có mỗi "N/thùng" (VD: "4/thùng")
  m = s.match(/^\s*(\d+)\s*\/\s*(?:thùng|thung)\s*$/i);
  if (m) return parseInt(m[1], 10);
  return null;
}

const db = new ProductDatabase();
if (typeof window !== 'undefined') {
  window.db = db;
  window.DEFAULT_DB = DEFAULT_DB;
  window.DEFAULT_MEMORY = DEFAULT_MEMORY;
  window.DEFAULT_ALIASES = DEFAULT_ALIASES;
  window.DB_STORAGE_KEY = DB_STORAGE_KEY;
  window.parsePackagingQty = parsePackagingQty;
}

export { db, ProductDatabase, DEFAULT_DB, DEFAULT_MEMORY, DEFAULT_ALIASES, DB_STORAGE_KEY, DB_BACKUP_KEY, parsePackagingQty, migratePromoRules, resolveGiveProduct, PROMO_RULES_VERSION };


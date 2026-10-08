// =========================================================================
//  PARSE PIPELINE — LUỒNG PHÂN TÍCH ĐƠN BẰNG AI (THUẦN, KHÔNG UI)
//  Tách từ parseOrder (src/order/actions.js) để parse SONG SONG nhiều đơn:
//  cùng một code path cho parse thường (màn hình) và parse nền (hàng đợi),
//  chất lượng kết quả đồng nhất 100% (brand-context 2-pass, AI-FINAL,
//  price guard, học alias...).
//
//  Module này KHÔNG đụng store/DOM/toast:
//    - db, aiService được INJECT qua deps (test được, không singleton cứng).
//    - Cập nhật tiến trình giữa chừng (giai đoạn AI-FINAL) qua opts.onProgress.
//    - Thông tin từng hiện toast (tự vá dòng sót, học alias) trả về qua meta —
//      caller quyết định hiện hay im lặng (parse nền thường im lặng hơn).
//  Abort: truyền opts.signal (AbortSignal) — hủy giữa chừng ném AbortError.
// =========================================================================

import {
  findBestProductMatch, buildShortlist, normalizeText, normalizeFull,
  detectSizeToken, extractViscosity, extractVolume, hasAttributeConflict, priceHintMatches,
  stripQtyJunk, standaloneTierQty, isStandaloneTierLine
} from '../../parser.js';
import { calculateOrderItem, getFinalUnitPrice, processExplicitGift, combineGifts, mergeDuplicateItems } from './calculator.js';
import { sanitizeAiExtraction, customerFirstComment } from './note-sanitizer.js';
import { repairMissingExtraction } from './extraction-repair.js';
import { workerManager } from '../worker-manager.js';

/**
 * Chạy toàn bộ pipeline phân tích một tin nhắn đơn hàng.
 * @param {string} text - Nội dung tin nhắn (đã trim).
 * @param {{ db: object, aiService: object }} deps - Danh mục + AI service inject vào.
 * @param {{ signal?: AbortSignal, learnAliases?: boolean, onProgress?: Function }} opts
 *    - signal: hủy giữa chừng (AbortError).
 *    - learnAliases: có tự học alias mới từ đơn này không (mặc định có).
 *    - onProgress: ({ stage, count? }) với stage 'verify' khi vào AI-FINAL.
 * @returns {Promise<{ order: object, meta: object }>} order = đơn hoàn chỉnh
 *    (customer/items/aiResult/parsedLines/rawChatText...), meta = thông tin
 *    phụ để caller hiển thị: { repair, learned }.
 * @throws {Error} lỗi AI/network — caller hiển thị; AbortError khi bị hủy.
 */
export async function runParsePipeline(text, deps, opts = {}) {
  const { db, aiService } = deps;
  const { signal, learnAliases = true, onProgress } = opts;

  const parsedJson = await aiService.callAI(text, db.getMemory(), db.getAllProducts(), signal);

  // Giữ bản tln VERBATIM trước sanitize — dùng cho kiểm tra đầy đủ TLN
  // (sanitizer có thể viết lại dòng quà nên không so sánh trực tiếp được).
  const tlnVerbatim = Array.isArray(parsedJson.tln)
    ? parsedJson.tln.map(l => String(l).trim()).filter(Boolean)
    : null;

  // ── Lọc deterministic: tách dòng FOC/quà + tên khách ra khỏi notes/TLN ──
  // (VD "FOC 2 áo mưa cho Rửa xe AP" → tên khách vào customer, quà thành item isGift)
  sanitizeAiExtraction(parsedJson);

  // ── Tự vá sót dòng: phát hiện dòng chưa trích xuất → AI bổ sung (1 call) ──
  let repairMeta = null;
  try {
    const repair = await repairMissingExtraction(
      (prompt) => aiService.callAI(prompt, db.getMemory(), db.getAllProducts(), signal),
      parsedJson,
      text
    );
    const issueCount = repair.missing.length + (repair.mergedLines || []).length;
    if (issueCount > 0) {
      let why = '';
      if (repair.added.length > 0) {
        why = repair.mergedLines.length > 0 && repair.missing.length > 0
          ? 'bị AI bỏ sót/gộp chung'
          : (repair.mergedLines.length > 0 ? 'bị AI gộp chung' : 'bị AI bỏ sót');
        console.warn(`[ExtractionRepair] Missing: ${JSON.stringify(repair.missing)} | Merged: ${JSON.stringify(repair.mergedLines || [])} — added ${repair.added.length}`);
      }
      repairMeta = { issueCount, addedCount: repair.added.length, why };
    }
  } catch (repairErr) {
    console.warn('[ExtractionRepair] lỗi:', repairErr.message);
  }

  // ── Dòng mốc giá đứng riêng ("Giá 2 thùng" / "giá thùng") ─────────────────
  // (1) AI thỉnh thoảng nhặt dòng này thành item → BỎ ngay, không thì match
  //     nhầm thành item ma "Poster Pricelist" 0đ (bug 22/9/2026).
  // (2) Mốc giá TOÀN ĐƠN được áp BẰNG CODE ở bước dựng item bên dưới — KHÔNG
  //     phụ thuộc model có "nghe" rule prompt mà đặt priceTierQty cho từng
  //     item hay không.
  if (Array.isArray(parsedJson.items)) {
    parsedJson.items = parsedJson.items.filter(it => !(it && isStandaloneTierLine(it && it.rawProduct)));
  }
  let orderTierQty = null;
  for (const l of String(text || '').split('\n')) {
    const tierQty = standaloneTierQty(stripQtyJunk(l.trim()));
    if (tierQty != null) { orderTierQty = tierQty; break; }
  }

  // Resolve AI results to campaigns
  let bestCampaign = null;
  let maxScore = 0;
  const scores = {};
  for (const key of Object.keys(db.data.campaigns)) {
    scores[key] = 0;
  }

  // Match AI items to get campaign scores (local matching)
  if (parsedJson.items && Array.isArray(parsedJson.items)) {
    parsedJson.items.forEach(item => {
      let product = null;
      // Try KV code first
      if (item.kvCode) {
        const code = String(item.kvCode).replace(/\D/g, '');
        if (code) {
          product = db.getAllProducts().find(p => {
            if (p.kvCode && String(p.kvCode).trim() === code) return true;
            if (db.getKvCode && db.getKvCode(p) === code) return true;
            return false;
          });
        }
      }
      if (!product) {
        const match = findBestProductMatch(item.rawProduct || '', db.getAllProducts(), db.getAliases());
        product = match ? match.product : null;
      }
      if (product) {
        const cKey = product.campaignKey;
        if (scores[cKey] !== undefined) scores[cKey] += 10;
      }
    });
  }

  for (const [key, val] of Object.entries(scores)) {
    if (val > maxScore) {
      maxScore = val;
      bestCampaign = key;
    }
  }

  const campaign = db.data.campaigns[bestCampaign];
  const aiResult = {
    primaryCampaign: bestCampaign,
    campaignLabel: campaign ? campaign.name : 'Không xác định',
    campaignColor: campaign ? campaign.color : '#4fc3f7',
    confidencePercent: maxScore > 0 ? 100 : 0,
    allScores: scores,
    detectedPayment: parsedJson.payment || 'ck'
  };

  const order = {
    customer: parsedJson.customer || '',
    payment: parsedJson.payment || 'ck',
    items: [],
    customPromos: [],
    parsedLines: [],
    aiResult: aiResult,
    giftOverrides: {},
    giftDeleted: {},
    giftQtyOverrides: {},
    giftKindOverrides: {},
    rowOrder: null,
    rawChatText: text,
    salesComment: '',
    tlnLines: parsedJson.tln || null,
    tlnVerbatim
  };

  // AI Mode: Extract notes from AI response (array of strings or string)
  if (parsedJson.notes && Array.isArray(parsedJson.notes)) {
    order.salesComment = parsedJson.notes.map(n => String(n).trim()).filter(Boolean).join('\n');
  } else if (typeof parsedJson.notes === 'string') {
    order.salesComment = parsedJson.notes.trim();
  }
  // Ghi chú chuẩn: hàng đầu luôn là tên khách, dặn dò nằm bên dưới
  order.salesComment = customerFirstComment(order.customer, order.salesComment);

  // Populate order list from AI items
  // Architecture: AI only extracts rawProduct text → system matches locally
  if (parsedJson.items && Array.isArray(parsedJson.items)) {
    parsedJson.items.forEach(item => {
      let product = null;
      let aiMatchScore = 0;

      // 1. Match by KV code (if AI extracted a code from the message)
      if (item.kvCode) {
        const code = String(item.kvCode).replace(/\D/g, '');
        if (code) {
          product = db.getAllProducts().find(p => {
            if (p.kvCode && String(p.kvCode).trim() === code) return true;
            if (db.getKvCode && db.getKvCode(p) === code) return true;
            return false;
          });
          if (product) aiMatchScore = 100;
        }
      }

      // 2. Normalize unit BEFORE matching (unitHint disambiguates phuy vs xô etc.)
      let unit = item.unit ? item.unit.toLowerCase().trim() : 'thùng';
      if (unit.includes('thg') || unit.includes('thung') || unit.includes('carton') || unit.includes('box') || unit.includes('ctn')) {
        unit = 'thùng';
      } else if (unit.includes('chai') || unit.includes('lon') || unit.includes('btl')) {
        unit = 'chai';
      } else if (unit.includes('can')) {
        unit = 'can';
      } else if (unit.includes('phuy') || unit.includes('drum')) {
        unit = 'phuy';
      } else if (unit.includes('xô') || unit.includes('xo') || unit.includes('pail') || unit.includes('bucket')) {
        unit = 'xô';
      } else if (unit.includes('cây') || unit.includes('cay')) {
        unit = 'cái';
      }

      // 3. Local fuzzy matching (primary path) — pass unit as hint
      let matchVia = null;
      let runnerUpScore = 0;
      let matchRelaxed = false;
      if (!product) {
        const match = findBestProductMatch(item.rawProduct || '', db.getAllProducts(), db.getAliases(), unit, item.explicitPrice || 0);
        product = match ? match.product : null;
        aiMatchScore = match ? match.score : 0;
        matchVia = match ? (match.via || 'fuzzy') : null;
        runnerUpScore = (match && match.runnerUp) ? match.runnerUp.score : 0;
        matchRelaxed = !!(match && match.relaxed);
      } else {
        matchVia = 'kvcode';
      }

      const isBox = (unit === 'thùng');

      if (product) {
        const calc = calculateOrderItem(product, item.qty, unit);

        let finalPrice = item.isGift ? 0 : calc.unitPrice;
        let finalTierLabel = calc.tierLabel;
        // Mốc giá hiệu lực: mốc AI đặt trên item ưu tiên; item không có mốc/giá
        // riêng thì dùng mốc TOÀN ĐƠN từ dòng "Giá N thùng" đứng riêng (áp bằng
        // code — AI có đặt hay không cũng được). Giá tường minh và hàng tặng
        // không bị mốc toàn đơn đè.
        let effectiveTierQty = item.priceTierQty;
        if (effectiveTierQty == null && !item.isGift
            && (item.explicitPrice === undefined || item.explicitPrice === null)
            && orderTierQty != null) {
          effectiveTierQty = orderTierQty;
        }
        if (effectiveTierQty !== undefined && effectiveTierQty !== null) {
          // Tier override: "giá 2 thùng" → tính đơn giá theo mốc 2 thùng
          finalPrice = item.isGift ? 0 : db.getPriceForQty(product, effectiveTierQty);
          if (product.tiers) {
            for (const tier of product.tiers) {
              if (effectiveTierQty >= tier.min_qty && effectiveTierQty <= tier.max_qty) {
                finalTierLabel = tier.label;
                break;
              }
            }
          }
        } else if (item.explicitPrice !== undefined && item.explicitPrice !== null) {
          finalPrice = item.isGift ? 0 : getFinalUnitPrice(product, item.explicitPrice, isBox);
        }

        // ── FALLBACK: AI không trích xuất giá nhưng rawProduct có price pattern ──
        // Hỗ trợ: "158k", "11tr3", "12tr", "1tr5", "giá 11tr3"
        if (!item.isGift
            && (item.explicitPrice === undefined || item.explicitPrice === null)
            && (item.priceTierQty === undefined || item.priceTierQty === null)
            && item.rawProduct) {
          // "tr" (triệu): "11tr3" = 11,300,000đ; "12tr" = 12,000,000đ; "1tr5" = 1,500,000đ
          const _trM = item.rawProduct.match(/(\d+(?:[.,]\d+)?)\s*(?:triệu|trieu|tr)(\d)?(?![a-zà-ỹ])/i);
          if (_trM) {
            const _mainVal = parseFloat(_trM[1].replace(',', '.'));
            const _subVal = _trM[2] ? parseInt(_trM[2]) : 0;
            const _pVal = _mainVal * 1000000 + _subVal * 100000;
            if (_pVal > 0) {
              finalPrice = getFinalUnitPrice(product, _pVal, isBox);
            }
          } else {
            // "k": "158k" = 155,000đ
            const _pM = item.rawProduct.match(/\b(\d+(?:[.,]\d+)?)\s*(k|K)\b/);
            if (_pM) {
              const _pVal = parseFloat(_pM[1].replace(',', '.')) * 1000;
              if (_pVal > 0) {
                finalPrice = getFinalUnitPrice(product, _pVal, isBox);
              }
            }
          }
        }

        // ── Kiến trúc 2 tầng: khuôn mẫu (system) LUÔN giữ + quà sales (AI) bổ sung ──
        const explicitGiftObj = item.explicitGift ? processExplicitGift(item.explicitGift, product, calc.foc) : null;
        const finalGift = combineGifts(calc.foc, explicitGiftObj);

        const boxSize = product.box_size || 12;
        const totalUnits = isBox ? item.qty * boxSize : item.qty;

        order.items.push({
          rawProduct: item.rawProduct,
          qty: item.qty,
          unit: unit,
          product: product,
          unitPrice: finalPrice,
          subtotal: finalPrice * totalUnits,
          foc: finalGift,
          tierLabel: item.isGift ? 'Khuyến mãi' : finalTierLabel,
          manualPrice: item.isGift ? 0 : (item.explicitPrice !== undefined && item.explicitPrice !== null ? finalPrice : null),
          explicitPrice: item.explicitPrice || null,
          isGift: item.isGift || false,
          matchScore: aiMatchScore,
          matchVia: matchVia,
          runnerUpScore: runnerUpScore,
          relaxed: matchRelaxed
        });
      } else {
        const bottlePrice = item.isGift ? 0 : (item.explicitPrice || 0);
        order.items.push({
          rawName: item.rawProduct,
          qty: item.qty,
          unit: unit,
          product: null,
          unitPrice: bottlePrice,
          subtotal: bottlePrice * item.qty,
          foc: null,
          tierLabel: '',
          manualPrice: item.isGift ? 0 : (item.explicitPrice ? bottlePrice : null),
          isGift: item.isGift || false,
          matchScore: 0,
          matchVia: null,
          runnerUpScore: runnerUpScore,
          relaxed: false
        });
      }
    });
  }

  // ─── BRAND CONTEXT 2-PASS ─────────────────────────────────────────────
  // Xác định dominant campaign từ các item đã match tự tin (pass 1).
  // Pass 2: re-match item yếu/gift chưa tự tin với brand prior bonus (+12).
  let dominantCampaign = null;
  {
    const campaignCounts = {};
    for (const item of order.items) {
      if (!item.product) continue;
      const isConfident = item.matchVia === 'kvcode' || item.matchVia === 'alias'
        || (item.matchScore || 0) >= 80;
      if (isConfident && item.product.campaignKey) {
        campaignCounts[item.product.campaignKey] = (campaignCounts[item.product.campaignKey] || 0) + 1;
      }
    }
    let maxCount = 0;
    for (const [ck, count] of Object.entries(campaignCounts)) {
      if (count > maxCount) { maxCount = count; dominantCampaign = ck; }
    }
    if (maxCount < 2) dominantCampaign = null; // Cần ít nhất 2 item tự tin cùng brand
  }

  if (dominantCampaign) {
    const BRAND_BONUS = 12;

    // Raw text có chứa từ khóa brand đích danh không ("zentor", "torvex", ...).
    // Nếu CÓ → sales đang gọi đích danh brand khác bối cảnh → KHÔNG đè brand context.
    function textHasBrandKeywords(rawText) {
      const norm = normalizeFull(rawText);
      for (const camp of Object.values(db.data.campaigns || {})) {
        for (const kw of (camp.keywords || [])) {
          const kwNorm = normalizeFull(kw);
          if (kwNorm.length < 3) continue;
          if (new RegExp('\\b' + kwNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(norm)) return true;
        }
      }
      return false;
    }

    for (const item of order.items) {
      if (item.isGift) continue;
      const rawText = item.rawProduct || item.rawName || '';
      if (!rawText || rawText.length < 2) continue;

      const curScore = item.matchScore || 0;
      const isWeak = !item.product || curScore < 65;
      const isOffBrand = !!(item.product && item.product.campaignKey && item.product.campaignKey !== dominantCampaign);
      if (!isWeak && !isOffBrand) continue;

      // KHÔNG đè brand context khi dòng đã khớp ĐÍCH DANH qua alias/kvcode
      // (VD: đơn Zentor nhưng sales ghi rõ "Fast Scoot" → alias Torvex phải thắng).
      const isExplicitMatch = item.matchVia === 'alias' || item.matchVia === 'kvcode';
      if (isOffBrand && isExplicitMatch) continue;

      // Ứng viên GIỚI HẠN trong brand của bối cảnh đơn (alias/fuzzy đều chỉ xét SP cùng campaign)
      const brandProducts = db.getAllProducts().filter(p => p.campaignKey === dominantCampaign);
      if (!brandProducts.length) continue;
      const brandMatch = findBestProductMatch(rawText, brandProducts, db.getAliases(), item.unit, item.explicitPrice || 0);

      let shouldSwitch = false;
      let newScore = 0;

      if (isWeak) {
        // Item yếu/chưa khớp → dùng brand bonus như cũ
        if (brandMatch && brandMatch.score + BRAND_BONUS > curScore) {
          shouldSwitch = true;
          newScore = brandMatch.score + BRAND_BONUS;
        }
      } else if (brandMatch && brandMatch.score >= 60 && !textHasBrandKeywords(rawText)) {
        // Item đang KHÁC brand: brand context là tie-breaker khi tên gọi mơ hồ.
        // Chỉ đè khi ứng viên cùng brand đủ tin (≥60) và input không nêu đích danh brand khác.
        shouldSwitch = true;
        newScore = brandMatch.score + BRAND_BONUS;
      }

      if (shouldSwitch && brandMatch) {
        const calc = calculateOrderItem(brandMatch.product, item.qty, item.unit);
        const boxSize = brandMatch.product.box_size || 12;
        const isBox = item.unit === 'thùng';
        const totalUnits = isBox ? item.qty * boxSize : item.qty;
        item.product = brandMatch.product;
        item.matchScore = newScore;
        item.matchVia = 'brand-ctx';
        item.runnerUpScore = brandMatch.runnerUp ? brandMatch.runnerUp.score : 0;
        item.relaxed = !!brandMatch.relaxed;
        if (!item.isGift) {
          item.unitPrice = calc.unitPrice;
          item.subtotal = calc.unitPrice * totalUnits;
          item.foc = calc.foc;
          item.tierLabel = calc.tierLabel;
        }
      }
    }
    console.log(`[Brand-Ctx] Dominant: ${dominantCampaign} — ưu tiên SP cùng brand cho dòng yếu/mơ hồ (bonus +${BRAND_BONUS})`);
  }

  // ─── AI-FINAL: Deterministic-first, AI-last ───────────────────────────
  // Bypass AI chỉ khi:
  //   (a) kvcode → tất định
  //   (b) alias sạch (đã qua attribute guard) score >= 95
  //   (c) fuzzy score >= 80 AND gap >= 15 AND !relaxed
  //   (d) fuzzy score >= 65 AND gap >= 25
  // Mọi ca khác → AI chọn từ shortlist (tối đa 6 ứng viên, đã lọc thuộc tính).
  const MAX_CANDIDATES = 6;

  const aiVerifyItems = []; // {index, rawProduct, candidates, localPick, localScore}

  order.items.forEach((orderItem, idx) => {
    if (orderItem.isGift) return;

    const score = orderItem.matchScore || 0;
    const via = orderItem.matchVia || null;
    const gap = score - (orderItem.runnerUpScore || 0);

    // (a) kvCode exact match (deterministic)
    if (via === 'kvcode') return;
    // (b) alias sạch đã qua attribute guard, score >= 95
    if (via === 'alias' && score >= 95) return;
    // (c) fuzzy high confidence + gap + không relaxed
    if (score >= 80 && gap >= 15 && !orderItem.relaxed) return;
    // (d) fuzzy moderate + very large gap
    if (score >= 65 && gap >= 25) return;

    const rawName = orderItem.rawProduct || orderItem.rawName || '';
    if (!rawName || rawName.length < 2) return;

    // Build multi-source shortlist (fuzzy + alias-boost + brand family)
    const shortlist = buildShortlist(rawName, db.getAllProducts(), db.getAliases(), MAX_CANDIDATES);
    const candidates = shortlist.map(c => ({
      id: c.product.id,
      name: c.product.name,
      spec: c.product.spec || '',
      price: db.getPriceForQty(c.product, 1) || 0,
      score: c.score,
      source: c.source
    }));

    if (candidates.length > 0) {
      aiVerifyItems.push({
        index: idx,
        rawProduct: rawName,
        unit: orderItem.unit || '',
        explicitPrice: orderItem.explicitPrice || 0,
        candidates,
        localPick: orderItem.product ? orderItem.product.id : null,
        localScore: score
      });
    }
  });

  if (aiVerifyItems.length > 0) {
    // GUI parse thường dùng callback này để đổi nhãn nút; parse nền dùng để
    // cập nhật trạng thái task trong hàng đợi.
    onProgress && onProgress({ stage: 'verify', count: aiVerifyItems.length });
    console.log(`[AI-Final] ${aiVerifyItems.length} items → AI chọn từ shortlist (local chỉ gợi ý)`);

    const aiMatches = await aiService.disambiguateItems(aiVerifyItems, signal, dominantCampaign);

    // Đánh dấu needsReview cho item mà AI trả null (không chọn được)
    for (const verifyItem of aiVerifyItems) {
      const aiResultAtIdx = aiMatches[String(verifyItem.index)];
      if (aiResultAtIdx === null || aiResultAtIdx === undefined) {
        const item = order.items[verifyItem.index];
        if (item) { item.matchVia = 'review'; item.needsReview = true; }
      }
    }

    for (const [idxStr, productId] of Object.entries(aiMatches)) {
      if (!productId) continue;
      const idx = parseInt(idxStr, 10);
      const orderItem = order.items[idx];
      if (!orderItem) continue;

      // Skip if AI agrees with local pick (no change needed)
      if (orderItem.product && orderItem.product.id === productId) {
        orderItem.matchVia = 'ai-confirmed';
        continue;
      }

      const product = db.findProductById(productId);
      if (!product) continue;

      // ── HARD ATTRIBUTE VALIDATION: AI KHÔNG được phép ghi đè thuộc tính phân biệt ──
      // Kiểm tra size, viscosity, volume — nếu AI chọn product SAI thuộc tính → REJECT.
      if (orderItem.rawProduct) {
        const rawNorm = normalizeText(orderItem.rawProduct);
        const rawWords = rawNorm.split(/\s+/).filter(Boolean);
        const aiProdText = normalizeText(product.name + ' ' + (product.spec || '') + ' ' + (product.packaging || ''));
        const aiProdWords = aiProdText.split(/\s+/).filter(Boolean);

        // Size check
        const inputSize = detectSizeToken(rawWords);
        if (inputSize) {
          const aiProdSize = detectSizeToken(aiProdWords);
          if (aiProdSize && aiProdSize !== inputSize) {
            console.warn(`[AI-Final] REJECTED "${product.name}" (size ${aiProdSize}) — input yêu cầu size ${inputSize}.`);
            orderItem.matchVia = 'review'; orderItem.needsReview = true;
            continue;
          }
        }
        // Viscosity check
        const inputVisc = extractViscosity(rawNorm);
        if (inputVisc) {
          const aiProdVisc = extractViscosity(aiProdText);
          if (aiProdVisc && aiProdVisc !== inputVisc) {
            console.warn(`[AI-Final] REJECTED "${product.name}" (grade ${aiProdVisc}) — input yêu cầu ${inputVisc}.`);
            orderItem.matchVia = 'review'; orderItem.needsReview = true;
            continue;
          }
        }
        // Volume check — đồng bộ mốc 0.05L với hasAttributeConflict (parser.js),
        // và trích trên text THÔ (giữ "/") vì normalizeText làm dính token
        // "(0,8L/kit)" → "08lkit" khiến extractVolume không đọc được dung tích.
        const aiProdRawText = product.name + ' ' + (product.spec || '') + ' ' + (product.packaging || '');
        const inputVol = extractVolume(rawNorm);
        if (inputVol && inputVol >= 0.05) {
          const aiProdVol = extractVolume(aiProdRawText);
          if (aiProdVol && aiProdVol >= 0.05) {
            const ratio = Math.max(inputVol, aiProdVol) / Math.min(inputVol, aiProdVol);
            if (ratio >= 1.25) {
              console.warn(`[AI-Final] REJECTED "${product.name}" (vol ${aiProdVol}L) — input yêu cầu ${inputVol}L.`);
              orderItem.matchVia = 'review'; orderItem.needsReview = true;
              continue;
            }
          }
        }
      }

      // Upgrade the item with the AI-selected product
      const unit = orderItem.unit;
      const isBox = (unit === 'thùng');
      const calc = calculateOrderItem(product, orderItem.qty, unit);
      const boxSize = product.box_size || 12;
      const totalUnits = isBox ? orderItem.qty * boxSize : orderItem.qty;

      orderItem.product = product;
      orderItem.matchScore = 92;
      orderItem.matchVia = 'ai';
      orderItem.runnerUpScore = 0;
      orderItem.unitPrice = orderItem.isGift ? 0 : calc.unitPrice;
      orderItem.subtotal = orderItem.isGift ? 0 : calc.unitPrice * totalUnits;
      orderItem.foc = calc.foc;
      orderItem.tierLabel = orderItem.isGift ? 'Khuyến mãi' : calc.tierLabel;
      if (orderItem.manualPrice != null) {
        orderItem.unitPrice = orderItem.manualPrice;
        orderItem.subtotal = orderItem.manualPrice * totalUnits;
      }
      if (orderItem.rawName && !orderItem.rawProduct) {
        orderItem.rawProduct = orderItem.rawName;
        delete orderItem.rawName;
      }
    }

    const changed = Object.entries(aiMatches).filter(([idxStr, pid]) => {
      const item = order.items[parseInt(idxStr, 10)];
      return pid && item && item.matchVia === 'ai';
    }).length;
    if (changed > 0) {
      console.log(`[AI-Final] AI đã sửa ${changed} SP (local gợi ý sai).`);
    }
  }

  // ─── PRICE GUARD: giá sales khai lệch rõ với SP đã khớp → dò lại toàn danh mục ───
  // Giá là tín hiệu phân biệt mạnh khi 2 brand trùng tên gọi (VD "Fork 10":
  // Fork 10 giá A ≠ GP Fork Oil 10W giá B — giá sales đưa thường
  // khớp ĐÚNG giá list của hàng khách mua). Chỉ đổi SP khi TỒN TẠI ứng viên khác
  // khớp ĐÚNG giá (sai số 2%) và tên đủ giống — giá KM/giá riêng không khớp
  // ứng viên nào thì giữ nguyên SP hiện tại.
  for (const orderItem of order.items) {
    if (orderItem.isGift || !orderItem.product) continue;
    const hint = orderItem.explicitPrice;
    if (!hint || hint <= 0) continue;
    // ƯU TIÊN ALIAS: sales đã gọi đích danh (alias/mã KV) → không bao giờ bị
    // Price-Guard đổi SP, kể cả giá lệch (sales có thể được giá riêng).
    if (orderItem.matchVia === 'alias' || orderItem.matchVia === 'kvcode') continue;
    if (priceHintMatches(orderItem.product, hint) !== false) continue; // khớp/trung tính → bỏ qua
    const rawText = orderItem.rawProduct || orderItem.rawName || '';
    if (!rawText) continue;
    const alt = findBestProductMatch(rawText, db.getAllProducts(), db.getAliases(), orderItem.unit, hint);
    if (!alt || !alt.product || alt.product.id === orderItem.product.id) continue;
    if (alt.score < 60) continue; // tên phải đủ giống mới đủ căn cứ đổi SP
    if (priceHintMatches(alt.product, hint) !== true) continue; // SP thay thế phải khớp ĐÚNG giá
    const calc = calculateOrderItem(alt.product, orderItem.qty, orderItem.unit);
    const boxSize = alt.product.box_size || 12;
    const isBox = orderItem.unit === 'thùng';
    const totalUnits = isBox ? orderItem.qty * boxSize : orderItem.qty;
    console.warn(`[Price-Guard] "${rawText}" giá ${hint} lệch "${orderItem.product.name}" → đổi thành "${alt.product.name}" (score ${alt.score})`);
    orderItem.product = alt.product;
    orderItem.matchScore = alt.score;
    orderItem.matchVia = 'price-fix';
    orderItem.runnerUpScore = alt.runnerUp ? alt.runnerUp.score : 0;
    orderItem.relaxed = !!alt.relaxed;
    orderItem.unitPrice = calc.unitPrice;
    orderItem.subtotal = calc.unitPrice * totalUnits;
    orderItem.foc = calc.foc;
    orderItem.tierLabel = calc.tierLabel;
  }

  // ─── SYSTEM FEATURE: Merge duplicate items (same product + unit → sum qty) ───
  order.items = mergeDuplicateItems(order.items);

  // ─── Auto-learn aliases (RESTRICTED — chặn nhiễm độc) ─────────────────
  // CHỈ học từ: kvcode, ai-confirmed, brand-ctx (đã qua guard).
  // KHÔNG học từ fuzzy score >= 80 nữa (nguyên nhân alias độc).
  // Trước khi lưu: kiểm tra alias không chứa thuộc tính xung đột với product.
  let learnedMeta = null;
  if (learnAliases && parsedJson.items && Array.isArray(parsedJson.items)) {
    const existingAliases = db.getAliases();
    let learnedCount = 0;
    const learnedSamples = [];
    const LEARNABLE_VIAS = new Set(['kvcode', 'ai-confirmed', 'brand-ctx']);

    for (const orderItem of order.items) {
      if (!orderItem.product || !orderItem.rawProduct) continue;
      // Chỉ học từ nguồn đáng tin cậy
      if (!LEARNABLE_VIAS.has(orderItem.matchVia)) continue;

      const rawKey = orderItem.rawProduct.trim();
      if (rawKey.length < 3 || rawKey.length > 80) continue;

      const rawNorm = normalizeFull(rawKey);
      const nameNorm = normalizeText(orderItem.product.name);

      // Skip if rawProduct is basically the product name itself
      if (rawNorm === nameNorm) continue;
      if (nameNorm.includes(rawNorm) && rawNorm.length > nameNorm.length * 0.7) continue;

      // Skip if already aliased to this product
      const aliasKey = rawKey.toLowerCase().trim();
      if (existingAliases[aliasKey] === orderItem.product.id) continue;

      // Attribute conflict check: alias không được chứa thuộc tính xung đột
      if (hasAttributeConflict(rawNorm, orderItem.product)) continue;

      // Save new alias
      db.addAlias(rawKey, orderItem.product.id);
      learnedCount++;
      if (learnedSamples.length < 3) learnedSamples.push(`"${rawKey}" → ${orderItem.product.name}`);
    }

    if (learnedCount > 0) {
      workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
      const sample = learnedSamples.join(', ');
      const extra = learnedCount > 3 ? ` +${learnedCount - 3} khác` : '';
      console.log(`[Alias] Đã học ${learnedCount} alias mới (từ nguồn tin cậy): ${sample}${extra}`);
      learnedMeta = { count: learnedCount, samples: learnedSamples };
    }
  }

  // Build synthetic parsedLines preview for AI
  order.parsedLines.push({
    raw: `AI Customer Detection`,
    type: 'customer',
    data: { name: order.customer || 'Chưa nhận diện' }
  });
  order.parsedLines.push({
    raw: `AI Payment Detection`,
    type: 'payment',
    data: { value: order.payment, label: order.payment === 'ck' ? 'Chuyển khoản' : order.payment === 'cod' ? 'COD' : order.payment === 'tt' ? 'Tiền mặt' : 'Khác' }
  });

  order.items.forEach(item => {
    if (item.product) {
      order.parsedLines.push({
        raw: item.rawProduct,
        type: 'matched',
        data: { qty: item.qty, unit: item.unit, rawProduct: item.rawProduct, matchedProduct: item.product }
      });
    } else {
      order.parsedLines.push({
        raw: item.rawName,
        type: 'unmatched',
        data: { qty: item.qty, unit: item.unit, rawProduct: item.rawName }
      });
    }
  });

  return { order, meta: { repair: repairMeta, learned: learnedMeta } };
}

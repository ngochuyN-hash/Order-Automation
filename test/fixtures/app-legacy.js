/**
 * =========================================================================
 *  ORDER AUTOMATION - MAIN APPLICATION CONTROLLER (app.js)
 *  LEGACY REFERENCE — khong duoc load nua (entry: src/main.js).
 *  Logic hien tai nam trong src/. Chi giu lam reference.
 * =========================================================================
 *  Entry point of the application. Integrates IndexedDB, Web Worker matching,
 *  State Management (store.js), AI API service, and UI rendering modules.
 * =========================================================================
 */

// Global modules (db, store, aiService, uiRenderer, parser) are loaded via script tags.

// --- Worker Manager for Background Parsing ---

class WorkerManager {
  constructor() {
    this.worker = null;
    this.isFallback = false;
    this.pendingResolves = new Map();
    this.requestIdCounter = 0;
  }

  init(products, aliases) {
    try {
      // Create the worker using a standard file path
      this.worker = new Worker('matching.worker.js');
      
      this.worker.onmessage = (e) => {
        const { type, payload, error, requestId } = e.data;
        const resolve = this.pendingResolves.get(requestId);
        
        if (resolve) {
          this.pendingResolves.delete(requestId);
          if (type === 'PARSE_RESULT') {
            resolve(payload);
          } else if (type === 'PARSE_ERROR') {
            console.error('Worker parse error:', error);
            resolve(null); // Resolve to null so we can fallback
          }
        }
      };

      this.worker.onerror = (err) => {
        console.warn('Web Worker error, switching to main thread matching:', err);
        this.isFallback = true;
      };

      // Initialize worker database
      this.worker.postMessage({
        type: 'INIT_DB',
        payload: { products, aliases },
        requestId: this.requestIdCounter++
      });

      console.log('Web Worker matching initialized successfully.');
    } catch (e) {
      console.warn('Failed to create Web Worker (possibly CORS/local file protocol). Falling back to main thread matching:', e);
      this.isFallback = true;
    }
  }

  updateDatabase(products, aliases) {
    if (this.isFallback || !this.worker) return;
    this.worker.postMessage({
      type: 'UPDATE_DB',
      payload: { products, aliases },
      requestId: this.requestIdCounter++
    });
  }

  parse(text) {
    if (this.isFallback || !this.worker) {
      // Fallback: Run parsing synchronously on Main Thread
      return new Promise((resolve) => {
        try {
          const result = parseOrderText(text, db.getAllProducts(), db.getAliases());
          resolve(result);
        } catch (err) {
          console.error('Main thread parser fallback failed:', err);
          resolve(null);
        }
      });
    }

    return new Promise((resolve) => {
      const requestId = this.requestIdCounter++;
      this.pendingResolves.set(requestId, resolve);
      this.worker.postMessage({
        type: 'PARSE',
        payload: { text },
        requestId
      });
    });
  }
}

const workerManager = new WorkerManager();

// --- Simple debounce utility ---
function debounce(fn, delay) {
  let timer = null;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// =========================================================================
//  CUSTOMER SPECIAL-PRICE NOTES MODULE
// =========================================================================
const CustomerNotes = (() => {
  const STORAGE_KEY = 'order_automation_customer_notes_v1';
  let _notes = [];          // [{ id, name, note }]
  let _editingId = null;    // id đang sửa trong form settings

  // --- Persistence (IndexedDB / localStorage via dbStore) ---
  async function load() {
    try {
      const data = await dbStore.get(STORAGE_KEY);
      _notes = Array.isArray(data) ? data : [];
    } catch (e) {
      console.warn('CustomerNotes: load failed, using empty list.', e);
      _notes = [];
    }
    renderSettingsList();
  }

  async function save() {
    try {
      await dbStore.set(STORAGE_KEY, _notes);
    } catch (e) {
      console.error('CustomerNotes: save failed.', e);
    }
  }

  // --- CRUD ---
  function addOrUpdate(name, note) {
    name = (name || '').trim();
    note = (note || '').trim();
    if (!name) return false;

    if (_editingId) {
      const idx = _notes.findIndex(n => n.id === _editingId);
      if (idx !== -1) {
        _notes[idx].name = name;
        _notes[idx].note = note;
      }
      _editingId = null;
    } else {
      // Kiểm tra trùng tên (normalized) → cập nhật thay vì tạo mới
      const norm = normalizeText(name);
      const existing = _notes.find(n => normalizeText(n.name) === norm);
      if (existing) {
        existing.name = name;
        existing.note = note;
      } else {
        _notes.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, note });
      }
    }
    save();
    renderSettingsList();
    return true;
  }

  function remove(id) {
    _notes = _notes.filter(n => n.id !== id);
    if (_editingId === id) { _editingId = null; clearForm(); }
    save();
    renderSettingsList();
  }

  function startEdit(id) {
    const entry = _notes.find(n => n.id === id);
    if (!entry) return;
    _editingId = id;
    const nameEl = document.getElementById('cnNameInput');
    const noteEl = document.getElementById('cnNoteInput');
    const cancelBtn = document.getElementById('btnClearCnForm');
    if (nameEl) nameEl.value = entry.name;
    if (noteEl) noteEl.value = entry.note;
    if (cancelBtn) cancelBtn.style.display = '';
  }

  function clearForm() {
    const nameEl = document.getElementById('cnNameInput');
    const noteEl = document.getElementById('cnNoteInput');
    const cancelBtn = document.getElementById('btnClearCnForm');
    if (nameEl) nameEl.value = '';
    if (noteEl) noteEl.value = '';
    if (cancelBtn) cancelBtn.style.display = 'none';
    _editingId = null;
  }

  // --- Detection: tìm ghi chú khớp với tên khách (fuzzy) ---
  const FUZZY_THRESHOLD = 55; // % tối thiểu để nhận diện

  /**
   * Tính % giống nhau giữa 2 chuỗi đã normalize.
   * Kết hợp: word-overlap (trọng số chính) + Levenshtein toàn chuỗi (bổ trợ).
   */
  function similarityScore(normA, normB) {
    if (normA === normB) return 100;
    if (!normA || !normB) return 0;

    // --- Word-level matching ---
    const wordsA = normA.split(/\s+/).filter(Boolean);
    const wordsB = normB.split(/\s+/).filter(Boolean);
    if (!wordsA.length || !wordsB.length) return 0;

    let matchedWeight = 0;
    const totalWeight = wordsA.length * 2; // mỗi từ tối đa 2 điểm

    for (const wa of wordsA) {
      let best = 0;
      for (const wb of wordsB) {
        if (wa === wb) { best = Math.max(best, 2); break; }
        // Chứa nhau (từ dài >= 3 ký tự)
        if (wa.length >= 3 && wb.length >= 3 && (wa.includes(wb) || wb.includes(wa))) {
          best = Math.max(best, 1.5);
          continue;
        }
        // Levenshtein gần đúng (sai 1-2 ký tự)
        const dist = levenshtein(wa, wb);
        if (dist <= 1 && wa.length >= 3) best = Math.max(best, 1.2);
        else if (dist <= 2 && wa.length >= 5) best = Math.max(best, 0.8);
      }
      matchedWeight += best;
    }

    const wordScore = totalWeight > 0 ? (matchedWeight / totalWeight) * 100 : 0;

    // --- Levenshtein toàn chuỗi (bổ trợ, trọng số thấp) ---
    const maxLen = Math.max(normA.length, normB.length);
    const fullDist = levenshtein(normA, normB);
    const levScore = maxLen > 0 ? Math.max(0, (1 - fullDist / maxLen)) * 100 : 0;

    // Kết hợp: 80% word + 20% levenshtein toàn chuỗi
    return Math.round(wordScore * 0.8 + levScore * 0.2);
  }

  /**
   * Tìm entry khớp nhất với tên khách.
   * Trả về { entry, score } hoặc null.
   */
  function findMatch(customerName) {
    if (!customerName || !_notes.length) return null;
    const normInput = normalizeText(customerName);
    if (!normInput) return null;

    let bestEntry = null;
    let bestScore = 0;

    for (const entry of _notes) {
      const normEntry = normalizeText(entry.name);
      if (!normEntry) continue;

      // Khớp chính xác → 100%
      if (normInput === normEntry) return { entry, score: 100 };

      // Khớp chứa → 95%
      if (normInput.includes(normEntry) || normEntry.includes(normInput)) {
        if (95 > bestScore) { bestScore = 95; bestEntry = entry; }
        continue;
      }

      // Fuzzy matching
      const score = similarityScore(normInput, normEntry);
      if (score > bestScore) {
        bestScore = score;
        bestEntry = entry;
      }
    }

    if (bestEntry && bestScore >= FUZZY_THRESHOLD) {
      return { entry: bestEntry, score: bestScore };
    }
    return null;
  }

  // --- Warning Banner ---
  function checkAndWarn(customerName) {
    const banner = document.getElementById('customerNoteWarning');
    if (!banner) return;
    const result = findMatch(customerName);
    if (result) {
      const { entry, score } = result;
      const titleEl = document.getElementById('cnwTitle');
      const noteEl = document.getElementById('cnwNote');
      const confLabel = score >= 95 ? '' : ` (≈${score}% khớp)`;
      if (titleEl) titleEl.textContent = `⚠️ "${entry.name}" — Khách có đơn giá riêng${confLabel}`;
      if (noteEl) noteEl.textContent = entry.note || '(Không có ghi chú)';
      banner.style.display = 'flex';
      // Toast cảnh báo thêm
      showToast(`Khách "${entry.name}" có đơn giá riêng${confLabel} — kiểm tra ghi chú!`, 'info');
    } else {
      banner.style.display = 'none';
    }
  }

  function dismissWarning() {
    const banner = document.getElementById('customerNoteWarning');
    if (banner) banner.style.display = 'none';
  }

  // --- Settings List Rendering ---
  function renderSettingsList() {
    const container = document.getElementById('customerNoteList');
    if (!container) return;
    if (!_notes.length) {
      container.innerHTML = '<div class="customer-note-empty">Chưa có khách nào trong danh sách.</div>';
      return;
    }
    container.innerHTML = _notes.map(n => `
      <div class="customer-note-item" data-id="${n.id}">
        <div class="cni-body">
          <div class="cni-name">${escapeHtml(n.name)}</div>
          <div class="cni-note">${escapeHtml(n.note || '—')}</div>
        </div>
        <div class="cni-actions">
          <button class="btn btn-ghost btn-sm" onclick="CustomerNotes.startEdit('${n.id}')" title="Sửa">✏️</button>
          <button class="btn btn-outline-danger btn-sm" onclick="CustomerNotes.remove('${n.id}')" title="Xóa">🗑️</button>
        </div>
      </div>
    `).join('');
  }

  function escapeHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // --- Bind UI Events (gọi 1 lần khi init) ---
  function bindEvents() {
    const addBtn = document.getElementById('btnAddCustomerNote');
    const clearBtn = document.getElementById('btnClearCnForm');
    const dismissBtn = document.getElementById('btnDismissCnw');

    if (addBtn) addBtn.addEventListener('click', () => {
      const name = document.getElementById('cnNameInput')?.value;
      const note = document.getElementById('cnNoteInput')?.value;
      if (addOrUpdate(name, note)) {
        clearForm();
        showToast('Đã lưu khách có đơn giá riêng.', 'success');
      } else {
        showToast('Vui lòng nhập tên khách!', 'error');
      }
    });

    if (clearBtn) clearBtn.addEventListener('click', clearForm);
    if (dismissBtn) dismissBtn.addEventListener('click', dismissWarning);
  }

  return { load, addOrUpdate, remove, startEdit, clearForm, findMatch, checkAndWarn, dismissWarning, renderSettingsList, bindEvents };
})();
if (typeof window !== 'undefined') window.CustomerNotes = CustomerNotes;

// --- Explicit Price Conversion Heuristic ---
function getFinalUnitPrice(product, salesPrice, isBox) {
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
function calculateOrderItem(product, qty, unit) {
  const isBox = (unit === 'thùng');
  const boxSize = product.box_size || 12;
  const totalUnits = isBox ? qty * boxSize : qty;
  const boxEquivalent = isBox ? qty : qty / boxSize;

  const unitPrice = db.getPriceForQty(product, boxEquivalent);
  const subtotal = totalUnits * unitPrice;
  const foc = db.getFOCForQty(product, boxEquivalent, totalUnits);

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

// --- Standalone Gift Processing Helper ---
function processExplicitGift(explicitGift, parentProduct, dbFocList) {
  if (!explicitGift) return null;
  let give_product_id = '';
  let note = 'Khuyến mãi theo tin nhắn sales';

  const name = (explicitGift.name || '').toLowerCase().trim();
  const unit = (explicitGift.unit || 'chai').toLowerCase().trim();

  const isGeneric = name === '' || name === 'chai' || name === 'lon' || name === 'thùng' || name === 'can' || name === 'phuy' || name === 'hộp' || name === 'túi';
  if (isGeneric || (parentProduct && name === parentProduct.name.toLowerCase())) {
     give_product_id = parentProduct ? parentProduct.id : '';
  } else {
     const match = findBestProductMatch(explicitGift.name, db.getAllProducts(), db.getAliases(), unit);
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
    note: note
  };
}

// --- Core: build a fresh order object from raw chat text (no side effects) ---
// Dùng chung cho nút Phân tích (chế độ offline) và bước "quét lại nội dung" trước khi xuất Excel.
function buildOrderFromText(text) {
  const result = parseOrderText(text, db.getAllProducts(), db.getAliases());
  const campaignScores = {};
  
  for (const campaignKey of Object.keys(db.data.campaigns)) {
    campaignScores[campaignKey] = 0;
  }

  result.lines.forEach(line => {
    if (line.type === 'matched' && line.data.matchedProduct) {
      const cKey = line.data.matchedProduct.campaignKey;
      if (campaignScores[cKey] !== undefined) {
        campaignScores[cKey] += 10;
      }
    }
  });

  let primaryCampaign = null;
  let maxScore = 0;
  for (const [key, score] of Object.entries(campaignScores)) {
    if (score > maxScore) {
      maxScore = score;
      primaryCampaign = key;
    }
  }

  const campaign = db.data.campaigns[primaryCampaign];
  const aiResult = {
    primaryCampaign,
    campaignLabel: campaign ? campaign.name : 'Không xác định',
    campaignColor: campaign ? campaign.color : '#4fc3f7',
    confidencePercent: maxScore > 0 ? 100 : 0,
    allScores: campaignScores,
    detectedPayment: result.customerDetected ? null : 'ck'
  };

  // Offline Mode: Collect all ignored lines as sales comments
  const ignoredLines = result.lines.filter(l => l.type === 'ignored').map(l => l.raw.trim()).filter(Boolean);
  const salesComment = ignoredLines.join('\n');

  const currentOrder = {
    customer: result.customerDetected || '',
    payment: 'ck',
    items: [],
    customPromos: [],
    parsedLines: result.lines,
    aiResult: aiResult,
    giftOverrides: {},
    giftDeleted: {},
    giftQtyOverrides: {},
    rowOrder: null,
    rawChatText: text,
    salesComment: salesComment,
    tlnLines: null
  };

  result.lines.forEach(line => {
    if (line.type === 'matched') {
      const data = line.data;
      const calc = calculateOrderItem(data.matchedProduct, data.qty, data.unit);
      
      let finalPrice = calc.unitPrice;
      let finalTierLabel = calc.tierLabel;
      if (data.priceTierQty !== undefined && data.priceTierQty !== null) {
        // Tier override: "giá 2 thùng" → tính đơn giá theo mốc 2 thùng
        finalPrice = db.getPriceForQty(data.matchedProduct, data.priceTierQty);
        if (data.matchedProduct.tiers) {
          for (const tier of data.matchedProduct.tiers) {
            if (data.priceTierQty >= tier.min_qty && data.priceTierQty <= tier.max_qty) {
              finalTierLabel = tier.label;
              break;
            }
          }
        }
      } else if (data.explicitPrice !== undefined) {
        finalPrice = getFinalUnitPrice(data.matchedProduct, data.explicitPrice, data.unit === 'thùng');
      }

      let finalGift = calc.foc;
      if (data.explicitGift) {
        finalGift = [processExplicitGift(data.explicitGift, data.matchedProduct, calc.foc)];
      }

      currentOrder.items.push({
        rawProduct: data.rawProduct,
        qty: data.qty,
        unit: data.unit,
        product: data.matchedProduct,
        unitPrice: data.isGift ? 0 : finalPrice,
        subtotal: data.isGift ? 0 : finalPrice * (data.unit === 'thùng' ? data.qty * (data.matchedProduct.box_size || 12) : data.qty),
        foc: finalGift,
        tierLabel: data.isGift ? 'Khuyến mãi' : finalTierLabel,
        manualPrice: data.isGift ? 0 : (data.explicitPrice !== undefined ? finalPrice : null),
        isGift: data.isGift || false,
        matchScore: data.matchScore || 0
      });
    } else if (line.type === 'unmatched') {
      currentOrder.items.push({
        rawName: line.data.rawProduct,
        qty: line.data.qty,
        unit: line.data.unit,
        product: null,
        unitPrice: 0,
        subtotal: 0,
        foc: null,
        tierLabel: '',
        manualPrice: line.data.isGift ? 0 : null,
        isGift: line.data.isGift || false
      });
    } else if (line.type === 'payment') {
      currentOrder.payment = line.data.value;
    }
  });

  return currentOrder;
}

// --- Offline RegEx Fallback Parser ---
function runOfflineParser(text) {
  const currentOrder = buildOrderFromText(text);

  store.setState({ currentOrder });

  const custEl = document.getElementById('customerName');
  const payEl = document.getElementById('paymentMethod');
  if (custEl) custEl.value = currentOrder.customer;
  if (payEl) payEl.value = currentOrder.payment;

  // Cảnh báo khách có đơn giá riêng
  CustomerNotes.checkAndWarn(currentOrder.customer);

  // Ghi chú mặc định trống — chỉ tính những gì user tự điền tay
  const noteEl = document.getElementById('orderNote');
  if (noteEl) noteEl.value = '';

  uiRenderer.renderAIDetection(currentOrder.aiResult);
  uiRenderer.renderParsedPreview(currentOrder.parsedLines);

  // Match quality summary
  const totalItems = currentOrder.items.filter(i => !i.isGift).length;
  const highConf = currentOrder.items.filter(i => !i.isGift && (i.matchScore || 0) >= 85).length;
  const lowConf = currentOrder.items.filter(i => !i.isGift && (i.matchScore || 0) < 60 && i.product).length;
  const unmatched = currentOrder.items.filter(i => !i.isGift && !i.product).length;
  let summaryMsg = `📦 Offline: ${totalItems} SP, ${highConf} khớp cao`;
  if (lowConf > 0) summaryMsg += `, ⚠️ ${lowConf} yếu`;
  if (unmatched > 0) summaryMsg += `, ❌ ${unmatched} chưa khớp`;
  showToast(summaryMsg, (lowConf > 0 || unmatched > 0) ? 'warning' : 'success', { duration: 5000 });
}

// --- Quét lại nội dung tin nhắn trước khi xuất Excel ---
// Người dùng có thể bổ sung nội dung vào ô tin nhắn sau lần phân tích cuối.
// Hàm này phát hiện nội dung thay đổi (so với rawChatText đã lưu) và parse lại
// để cập nhật phần thông tin nội dung tin nhắn và preview.
// QUAN TRỌNG: Giữ nguyên 100% kết quả đơn hàng bên dưới (items, quà tặng, khuyến mãi,
// giá sửa tay, sản phẩm thêm tay...) mà người dùng đã chỉnh sửa/xác nhận.
function rescanOrderTextIfChanged() {
  const textEl = document.getElementById('orderText');
  if (!textEl) return false;
  const text = textEl.value.trim();
  if (!text) return false; // không có nội dung → giữ nguyên đơn hiện tại

  const order = store.getState().currentOrder;
  if (order && order.rawChatText === text) return false; // không đổi từ lần parse trước

  const freshParse = buildOrderFromText(text);

  if (!order) {
    store.setState({ currentOrder: freshParse });
    const custEl = document.getElementById('customerName');
    const payEl = document.getElementById('paymentMethod');
    if (custEl && freshParse.customer) custEl.value = freshParse.customer;
    if (payEl && freshParse.payment) payEl.value = freshParse.payment;
    uiRenderer.renderAIDetection(freshParse.aiResult);
    uiRenderer.renderParsedPreview(freshParse.parsedLines);
    return true;
  }

  // Nội dung tin nhắn đã thay đổi nhưng đơn hàng đã có sẵn:
  // CHỈ cập nhật phần thông tin nội dung tin nhắn (preview, AI detection, salesComment, rawChatText).
  // Giữ nguyên 100% kết quả đơn hàng bên dưới (items, quà tặng, khuyến mãi, giá sửa tay, sản phẩm thêm tay...).
  const updatedOrder = {
    ...order,
    rawChatText: text,
    parsedLines: freshParse.parsedLines,
    aiResult: freshParse.aiResult,
    salesComment: freshParse.salesComment,
  };
  store.setState({ currentOrder: updatedOrder });

  uiRenderer.renderAIDetection(updatedOrder.aiResult);
  uiRenderer.renderParsedPreview(updatedOrder.parsedLines);
  return true;
}

// --- Parse Order Handler (AI or Offline) ---
async function parseOrder() {
  const text = document.getElementById('orderText').value.trim();
  if (!text) { showToast('Vui lòng nhập tin nhắn đơn hàng!', 'error'); return; }

  const btnParse = document.getElementById('btnParse');
  const originalBtnText = btnParse.innerHTML;

  // Check if any AI profile is enabled
  const { profiles } = await aiService.getProfiles();
  const hasAI = profiles.some(p => p.enabled);

  if (!hasAI) {
    try {
      runOfflineParser(text);
    } catch (err) {
      console.error('Offline parser error:', err);
      showToast('Lỗi phân tích: ' + err.message, 'error');
    }
    return;
  }

  btnParse.disabled = true;
  btnParse.classList.add('btn-parse-loading');
  btnParse.innerHTML = `⏳ AI đang phân tích đơn hàng...`;

  try {
    const parsedJson = await aiService.callAI(text, db.getMemory(), db.getAllProducts());

    // Resolve AI results to campaigns
    let bestCampaign = null;
    let maxScore = 0;
    const scores = {};
    for (const key of Object.keys(db.data.campaigns)) {
      scores[key] = 0;
    }

    // Match AI items to get campaign scores
    if (parsedJson.items && Array.isArray(parsedJson.items)) {
      parsedJson.items.forEach(item => {
        let product = null;
        if (item.matchedProductId) {
          product = db.findProductById(item.matchedProductId);
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

    const currentOrder = {
      customer: parsedJson.customer || '',
      payment: parsedJson.payment || 'ck',
      items: [],
      customPromos: [],
      parsedLines: [],
      aiResult: aiResult,
      giftOverrides: {},
      giftDeleted: {},
      giftQtyOverrides: {},
      rowOrder: null,
      rawChatText: text,
      salesComment: '',
      tlnLines: parsedJson.tln || null,
      // Bản verbatim dùng cho kiểm tra đầy đủ TLN (app.js không sanitize nên trùng tlnLines)
      tlnVerbatim: Array.isArray(parsedJson.tln)
        ? parsedJson.tln.map(l => String(l).trim()).filter(Boolean)
        : null
    };

    // AI Mode: Extract notes from AI response (array of strings or string)
    if (parsedJson.notes && Array.isArray(parsedJson.notes)) {
      currentOrder.salesComment = parsedJson.notes.map(n => String(n).trim()).filter(Boolean).join('\n');
    } else if (typeof parsedJson.notes === 'string') {
      currentOrder.salesComment = parsedJson.notes.trim();
    }

    // Populate order list from AI items
    if (parsedJson.items && Array.isArray(parsedJson.items)) {
      parsedJson.items.forEach(item => {
        let product = null;
        let aiMatchScore = 100;
        if (item.matchedProductId) {
          product = db.findProductById(item.matchedProductId);
        }
        if (!product) {
          const match = findBestProductMatch(item.rawProduct || '', db.getAllProducts(), db.getAliases());
          product = match ? match.product : null;
          aiMatchScore = match ? match.score : 0;
        }
        
        let unit = item.unit ? item.unit.toLowerCase().trim() : 'thùng';
        if (unit.includes('thg') || unit.includes('thung') || unit.includes('carton') || unit.includes('box') || unit.includes('ctn')) {
          unit = 'thùng';
        } else if (unit.includes('chai') || unit.includes('lon') || unit.includes('btl')) {
          unit = 'chai';
        } else if (unit.includes('can')) {
          unit = 'can';
        } else if (unit.includes('phuy') || unit.includes('drum')) {
          unit = 'phuy';
        }

        const isBox = (unit === 'thùng');

        if (product) {
          const calc = calculateOrderItem(product, item.qty, unit);
          
          let finalPrice = item.isGift ? 0 : calc.unitPrice;
          let finalTierLabel = calc.tierLabel;
          if (item.priceTierQty !== undefined && item.priceTierQty !== null) {
            // Tier override: "giá 2 thùng" → tính đơn giá theo mốc 2 thùng
            finalPrice = item.isGift ? 0 : db.getPriceForQty(product, item.priceTierQty);
            if (product.tiers) {
              for (const tier of product.tiers) {
                if (item.priceTierQty >= tier.min_qty && item.priceTierQty <= tier.max_qty) {
                  finalTierLabel = tier.label;
                  break;
                }
              }
            }
          } else if (item.explicitPrice !== undefined && item.explicitPrice !== null) {
            finalPrice = item.isGift ? 0 : getFinalUnitPrice(product, item.explicitPrice, isBox);
          }

          // ── FALLBACK: AI không trích xuất giá nhưng rawProduct có price pattern (vd "158k") ──
          if (!item.isGift
              && (item.explicitPrice === undefined || item.explicitPrice === null)
              && (item.priceTierQty === undefined || item.priceTierQty === null)
              && item.rawProduct) {
            const _pM = item.rawProduct.match(/\b(\d+(?:[.,]\d+)?)\s*(k|K)\b/);
            if (_pM) {
              const _pVal = parseFloat(_pM[1].replace(',', '.')) * 1000;
              if (_pVal > 0) {
                finalPrice = getFinalUnitPrice(product, _pVal, isBox);
              }
            }
          }

          let finalGift = calc.foc;
          if (item.explicitGift) {
            finalGift = [processExplicitGift(item.explicitGift, product, calc.foc)];
          }

          const boxSize = product.box_size || 12;
          const totalUnits = isBox ? item.qty * boxSize : item.qty;

          currentOrder.items.push({
            rawProduct: item.rawProduct,
            qty: item.qty,
            unit: unit,
            product: product,
            unitPrice: finalPrice,
            subtotal: finalPrice * totalUnits,
            foc: finalGift,
            tierLabel: item.isGift ? 'Khuyến mãi' : finalTierLabel,
            manualPrice: item.isGift ? 0 : (item.explicitPrice !== undefined && item.explicitPrice !== null ? finalPrice : null),
            isGift: item.isGift || false,
            matchScore: aiMatchScore
          });
        } else {
          const bottlePrice = item.isGift ? 0 : (item.explicitPrice || 0);
          currentOrder.items.push({
            rawName: item.rawProduct,
            qty: item.qty,
            unit: unit,
            product: null,
            unitPrice: bottlePrice,
            subtotal: bottlePrice * item.qty,
            foc: null,
            tierLabel: '',
            manualPrice: item.isGift ? 0 : (item.explicitPrice ? bottlePrice : null),
            isGift: item.isGift || false
          });
        }
      });
    }

    // Build synthetic parsedLines preview for AI
    currentOrder.parsedLines.push({
      raw: `AI Customer Detection`,
      type: 'customer',
      data: { name: currentOrder.customer || 'Chưa nhận diện' }
    });
    currentOrder.parsedLines.push({
      raw: `AI Payment Detection`,
      type: 'payment',
      data: { value: currentOrder.payment, label: currentOrder.payment === 'ck' ? 'Chuyển khoản' : currentOrder.payment === 'cod' ? 'COD' : currentOrder.payment === 'tt' ? 'Tiền mặt' : 'Khác' }
    });
    
    currentOrder.items.forEach(item => {
      if (item.product) {
        currentOrder.parsedLines.push({
          raw: item.rawProduct,
          type: 'matched',
          data: { qty: item.qty, unit: item.unit, rawProduct: item.rawProduct, matchedProduct: item.product }
        });
      } else {
        currentOrder.parsedLines.push({
          raw: item.rawName,
          type: 'unmatched',
          data: { qty: item.qty, unit: item.unit, rawProduct: item.rawName }
        });
      }
    });

    store.setState({ currentOrder });

    const custEl = document.getElementById('customerName');
    const payEl = document.getElementById('paymentMethod');
    if (custEl) custEl.value = currentOrder.customer;
    if (payEl) payEl.value = currentOrder.payment;

    // Cảnh báo khách có đơn giá riêng
    CustomerNotes.checkAndWarn(currentOrder.customer);

    // Ghi chú mặc định trống — chỉ tính những gì user tự điền tay
    const noteEl = document.getElementById('orderNote');
    if (noteEl) noteEl.value = '';

    uiRenderer.renderAIDetection(aiResult);
    uiRenderer.renderParsedPreview(currentOrder.parsedLines);

    // Match quality summary
    const totalItems = currentOrder.items.filter(i => !i.isGift).length;
    const highConf = currentOrder.items.filter(i => !i.isGift && (i.matchScore || 0) >= 85).length;
    const lowConf = currentOrder.items.filter(i => !i.isGift && (i.matchScore || 0) < 60 && i.product).length;
    const unmatched = currentOrder.items.filter(i => !i.isGift && !i.product).length;
    let summaryMsg = `✅ AI: ${totalItems} SP, ${highConf} khớp cao`;
    if (lowConf > 0) summaryMsg += `, ⚠️ ${lowConf} yếu`;
    if (unmatched > 0) summaryMsg += `, ❌ ${unmatched} chưa khớp`;
    showToast(summaryMsg, (lowConf > 0 || unmatched > 0) ? 'warning' : 'success', { duration: 5000 });

  } catch (err) {
    console.error('AI parser error:', err);
    showToast('AI phân tích thất bại: ' + err.message, 'error');
  } finally {
    btnParse.disabled = false;
    btnParse.classList.remove('btn-parse-loading');
    btnParse.innerHTML = originalBtnText;
  }
}

// --- Cart Actions & Mutations ---

function removeOrderItem(index) {
  const currentOrder = store.getState().currentOrder;
  currentOrder.items.splice(index, 1);
  store.setState({ currentOrder });
}

function reorderOrderItem(fromIndex, toIndex) {
  if (fromIndex === toIndex) return;
  const currentOrder = store.getState().currentOrder;
  const len = currentOrder.items.length;
  // Validate indices
  if (isNaN(fromIndex) || isNaN(toIndex) ||
      fromIndex < 0 || fromIndex >= len ||
      toIndex < 0 || toIndex >= len) {
    console.warn('reorderOrderItem: invalid indices', fromIndex, toIndex, 'length:', len);
    return;
  }
  // Build a fresh array with the item moved — guarantees a new reference
  const items = currentOrder.items.slice();
  const [moved] = items.splice(fromIndex, 1);
  items.splice(toIndex, 0, moved);
  store.setState({ currentOrder: { ...currentOrder, items } });
}

/**
 * Reorders any row (product or gift) independently by visual position.
 * Updates currentOrder.rowOrder so Excel export follows the visual order.
 */
function reorderRows(fromVisualIndex, toVisualIndex) {
  if (fromVisualIndex === toVisualIndex) return;
  const currentOrder = store.getState().currentOrder;
  const rowDescriptors = uiRenderer.getOrderTableRows(currentOrder);
  const rows = rowDescriptors.rows;

  if (isNaN(fromVisualIndex) || isNaN(toVisualIndex) ||
      fromVisualIndex < 0 || fromVisualIndex >= rows.length ||
      toVisualIndex < 0 || toVisualIndex >= rows.length) {
    console.warn('reorderRows: invalid indices', fromVisualIndex, toVisualIndex, 'length:', rows.length);
    return;
  }

  // Get current rowOrder or build from descriptors
  let rowOrder;
  if (currentOrder.rowOrder && currentOrder.rowOrder.length > 0) {
    rowOrder = currentOrder.rowOrder.slice();
  } else {
    rowOrder = rows.map(d => d.rowId || d.giftId);
  }

  // Move the entry
  const [moved] = rowOrder.splice(fromVisualIndex, 1);
  rowOrder.splice(toVisualIndex, 0, moved);

  store.setState({ currentOrder: { ...currentOrder, rowOrder } });
}

function removeGiftItem(giftId) {
  const currentOrder = store.getState().currentOrder;
  if (!currentOrder.giftDeleted) currentOrder.giftDeleted = {};
  // Nếu là dòng quà đã gộp → xóa tất cả giftId thành phần
  const mergedRow = uiRenderer.getOrderTableRows(currentOrder).rows
    .find(r => r.type === 'gift' && r.giftId === giftId && Array.isArray(r.mergedGiftIds) && r.mergedGiftIds.length > 1);
  if (mergedRow) {
    mergedRow.mergedGiftIds.forEach(id => { currentOrder.giftDeleted[id] = true; });
  } else {
    currentOrder.giftDeleted[giftId] = true;
  }
  store.setState({ currentOrder });
}

function updateGiftOverride(giftId, productId) {
  changeRowProduct(giftId, productId);
}

function updateGiftQty(giftId, qtyStr) {
  const currentOrder = store.getState().currentOrder;
  const qty = parseFloat(qtyStr);
  if (isNaN(qty) || qty < 0) return;
  if (!currentOrder.giftQtyOverrides) currentOrder.giftQtyOverrides = {};
  // Nếu là dòng quà đã gộp: SL mới là tổng → gán cho giftId đầu, các giftId còn lại = 0
  const mergedRow = uiRenderer.getOrderTableRows(currentOrder).rows
    .find(r => r.type === 'gift' && r.giftId === giftId && Array.isArray(r.mergedGiftIds) && r.mergedGiftIds.length > 1);
  if (mergedRow) {
    mergedRow.mergedGiftIds.forEach((id, i) => {
      currentOrder.giftQtyOverrides[id] = (i === 0) ? qty : 0;
    });
  } else {
    currentOrder.giftQtyOverrides[giftId] = qty;
  }
  store.setState({ currentOrder });
}

function updateItemQty(index, val) {
  const currentOrder = store.getState().currentOrder;
  const item = currentOrder.items[index];
  if (!item) return;

  const qty = parseInt(val) || 1;
  item.qty = qty;

  if (item.product) {
    const calc = calculateOrderItem(item.product, qty, item.unit);
    item.unitPrice = item.manualPrice !== null && item.manualPrice !== undefined ? item.manualPrice : calc.unitPrice;
    item.subtotal = item.unitPrice * (item.unit === 'thùng' ? qty * (item.product.box_size || 12) : qty);
    item.foc = calc.foc;
    item.tierLabel = calc.tierLabel;
  } else {
    item.subtotal = item.unitPrice * qty;
  }
  
  store.setState({ currentOrder });
}

function updateDualPriceLive(index, source, inputEl) {
  const currentOrder = store.getState().currentOrder;
  const item = currentOrder.items[index];
  if (!item) return;

  formatInputWithDotsAndPreserveCursor(inputEl);
  const cleanVal = parseFormattedNumber(inputEl.value);

  const boxSize = item.product ? (item.product.box_size || 12) : 12;

  if (source === 'bottle') {
    item.manualPrice = cleanVal;
    item.unitPrice = cleanVal;
    const boxInput = document.querySelector(`.editable-price-box[data-price-box-index="${index}"]`);
    if (boxInput) boxInput.value = formatNumberWithDots(Math.round(cleanVal * boxSize));
  } else {
    const calculatedUnitPrice = cleanVal / boxSize;
    item.manualPrice = calculatedUnitPrice;
    item.unitPrice = calculatedUnitPrice;
    const bottleInput = document.querySelector(`.editable-price-bottle[data-price-bottle-index="${index}"]`);
    if (bottleInput) bottleInput.value = formatNumberWithDots(Math.round(calculatedUnitPrice));
  }

  // Recalculate subtotal
  const totalUnits = item.unit === 'thùng' ? item.qty * boxSize : item.qty;
  item.subtotal = item.unitPrice * totalUnits;

  // Targeted DOM update (NO full re-render) so the price input keeps focus while typing.
  // A full renderOrderResults() would rebuild the table and destroy the focused input.
  const tr = inputEl.closest('tr');
  if (tr) {
    const subtotalCell = tr.querySelector('.subtotal-amount');
    if (subtotalCell) subtotalCell.textContent = formatCurrency(item.subtotal);
  }
  // Recompute summary totals via lightweight O(n) loop (no gift/MKT processing)
  let grandTotal = 0, totalBoxes = 0;
  currentOrder.items.forEach(it => {
    grandTotal += it.subtotal || 0;
    if (it.product) {
      const bs = it.product.box_size || 12;
      totalBoxes += it.unit === 'thùng' ? it.qty : it.qty / bs;
    }
  });
  const summaryProducts = document.getElementById('summaryProducts');
  const summaryBoxes = document.getElementById('summaryBoxes');
  const summaryTotal = document.getElementById('summaryTotal');
  if (summaryProducts) summaryProducts.textContent = currentOrder.items.filter(i => i.product).length;
  if (summaryBoxes) summaryBoxes.textContent = totalBoxes.toFixed(1).replace('.0', '');
  if (summaryTotal) summaryTotal.textContent = formatCurrency(grandTotal);
}

function changeRowProduct(index, productId) {
  const currentOrder = store.getState().currentOrder;
  const isGift = String(index).startsWith('foc_') || String(index).startsWith('mkt_');
  
  if (isGift) {
    currentOrder.giftOverrides = currentOrder.giftOverrides || {};
    currentOrder.giftOverrides[index] = productId;
    store.setState({ currentOrder });
    return;
  }
  
  const itemIndex = parseInt(index);
  const item = currentOrder.items[itemIndex];
  if (!item) return;

  // Trạng thái trước khi đổi: quyết định có nên tự học alias hay không
  const prevProduct = item.product;
  const prevScore = (item.matchScore === undefined || item.matchScore === null)
    ? (prevProduct ? 100 : 0)
    : item.matchScore;
  const wasWeakOrUnmatched = !prevProduct || prevScore < 60;
  // User sửa sản phẩm KHÁC với product hiện tại → đây là correction, PHẢI học
  const isCorrection = prevProduct && productId && prevProduct.id !== productId;
  
  if (!productId) {
    item.product = null;
    item.unitPrice = 0;
    item.subtotal = 0;
    item.foc = [];
    item.tierLabel = '';
    item.manualPrice = null;
    item.matchScore = 0;
  } else {
    const product = db.findProductById(productId);
    if (product) {
      item.product = product;
      const calc = calculateOrderItem(product, item.qty, item.unit);
      item.unitPrice = calc.unitPrice;
      item.subtotal = calc.subtotal;
      item.foc = calc.foc;
      item.tierLabel = calc.tierLabel;
      item.manualPrice = null;
      // Người dùng chọn tay → coi như chắc chắn 100%
      item.matchScore = 100;
      
      // Tự học alias: học khi sửa từ dòng yếu/không khớp HOẶC khi user sửa khác product cũ (correction)
      // Correction: user chủ động đổi SP khác → alias cũ SAI → phải ghi đè
      if (item.rawProduct && (wasWeakOrUnmatched || isCorrection)) {
        const rawKey = item.rawProduct;
        const prevAlias = db.getAliases()[rawKey.toLowerCase().trim()] || null;
        db.addAlias(rawKey, productId);
        workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
        showToast(`Đã ghi nhớ: "${rawKey}" → ${product.name}`, 'success', {
          label: '↩ Hoàn tác',
          handler: () => {
            if (prevAlias) {
              db.addAlias(rawKey, prevAlias);
            } else {
              db.removeAlias(rawKey);
            }
            workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
            showToast(`Đã hoàn tác ghi nhớ "${rawKey}"`, 'info');
          }
        });
      }
    }
  }
  store.setState({ currentOrder });
}

function selectComboboxItem(index, productId) {
  changeRowProduct(index, productId);
  const dropdown = document.getElementById(`combobox-dropdown-${index}`);
  if (dropdown) dropdown.style.display = 'none';
}

function showComboboxDropdown(index) {
  // Close all other dropdowns
  document.querySelectorAll('.combobox-dropdown').forEach(d => d.style.display = 'none');
  // Lazily populate dropdown on first open
  uiRenderer.populateComboboxDropdown(index);
  const dropdown = document.getElementById(`combobox-dropdown-${index}`);
  if (dropdown) dropdown.style.display = 'block';
}

function filterComboboxOptions(index, query) {
  const dropdown = document.getElementById(`combobox-dropdown-${index}`);
  if (!dropdown) return;

  // Ensure dropdown is populated before filtering
  uiRenderer.populateComboboxDropdown(index);
  dropdown.style.display = 'block';
  const normQuery = normalizeText(query);

  const items = Array.from(dropdown.querySelectorAll('.combobox-item'));
  const scored = items.map(item => {
    // "Chưa khớp / Khác": chỉ hiện khi KHÔNG có query
    if (item.getAttribute('data-is-clear')) {
      return { item, score: normQuery ? -1 : Infinity };
    }
    const text = item.getAttribute('data-search-text');
    if (!text) return { item, score: 0 };
    let score = fuzzySearchScore(normQuery, text);
    // Boost: khớp trong TÊN sản phẩm → ưu tiên lên đầu
    if (score > 0 && normQuery) {
      const nameText = item.getAttribute('data-name-text') || '';
      if (nameText && fuzzySearchScore(normQuery, nameText) > 0) {
        score += 40;
      }
    }
    return { item, score };
  });

  scored.sort((a, b) => b.score - a.score);
  scored.forEach(({ item, score }) => {
    item.style.display = score > 0 ? '' : 'none';
    dropdown.appendChild(item); // reorder theo độ liên quan
  });
}

// --- Custom Promos (Ad-hoc manual additions) ---

function addCustomPromo() {
  const nameEl = document.getElementById('customPromoInput');
  const valEl = document.getElementById('customPromoValue');
  const name = nameEl ? nameEl.value.trim() : '';
  const val = valEl ? parseFormattedNumber(valEl.value) : 0;
  if (!name) { showToast('Vui lòng nhập tên khuyến mãi!', 'error'); if (nameEl) nameEl.focus(); return; }

  const currentOrder = store.getState().currentOrder;
  currentOrder.customPromos.push({ name, value: val });
  store.setState({ currentOrder });

  if (nameEl) nameEl.value = '';
  if (valEl) valEl.value = '';
  renderCustomPromos();
}

function removeCustomPromo(i) {
  const currentOrder = store.getState().currentOrder;
  currentOrder.customPromos.splice(i, 1);
  store.setState({ currentOrder });
  renderCustomPromos();
}

function renderCustomPromos() {
  const list = document.getElementById('customPromoList');
  if (!list) return;

  const currentOrder = store.getState().currentOrder;
  if (!currentOrder.customPromos || currentOrder.customPromos.length === 0) {
    list.innerHTML = '';
    return;
  }

  const fragment = document.createDocumentFragment();
  currentOrder.customPromos.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'promo-item';
    const valueHtml = p.value > 0
      ? ` <span style="font-weight:700;color:var(--accent-red)">-${formatCurrency(p.value)}</span>`
      : '';
    div.innerHTML = `
      <span>🎁 ${escapeHtml(p.name)}${valueHtml}</span>
      <button class="btn btn-ghost btn-xs btn-remove-promo" data-promo-index="${i}">✕</button>
    `;
    const btn = div.querySelector('.btn-remove-promo');
    btn.onclick = () => removeCustomPromo(i);
    fragment.appendChild(div);
  });

  list.innerHTML = '';
  list.appendChild(fragment);
}

// --- Manual Product Search Addition ---

function onManualSearch(query) {
  const dropdown = document.getElementById('manualSearchDropdown');
  if (!dropdown) return;
  if (!query.trim()) { dropdown.style.display = 'none'; return; }

  const normQuery = normalizeText(query);
  const allProducts = db.getAllProducts();

  const matches = [];
  allProducts.forEach(p => {
    const nameNorm = normalizeText(`${p.name} ${p.spec || ''} ${p.campaignName || ''} ${p.kvCode || ''}`);
    const score = fuzzySearchScore(normQuery, nameNorm);
    if (score > 0) matches.push({ p, score });
  });
  matches.sort((a, b) => b.score - a.score);

  let html = '';
  matches.forEach(({ p }) => {
    html += `<div class="combobox-item manual-add-item" data-product-id="${p.id}">
      <span class="combobox-item-name">${p.campaignIcon || '📦'} ${escapeHtml(p.name)} [${escapeHtml(p.spec||'')}]</span>
      <span class="combobox-item-campaign" style="color:${p.campaignColor};">${escapeHtml(p.campaignName)}</span>
    </div>`;
  });

  if (html) {
    dropdown.innerHTML = html;
    dropdown.style.display = 'block';
    
    // Bind click events
    dropdown.querySelectorAll('.manual-add-item').forEach(item => {
      item.onclick = (e) => {
        const pId = e.currentTarget.getAttribute('data-product-id');
        const product = db.findProductById(pId);
        if (product) addManualProduct(product);
        dropdown.style.display = 'none';
        document.getElementById('manualProductSearch').value = '';
      };
    });
  } else {
    dropdown.style.display = 'none';
  }
}

function addManualProduct(product) {
  const currentOrder = store.getState().currentOrder;
  const nativeUnit = product.unit || 'chai';
  const defaultUnit = (nativeUnit !== 'chai' && nativeUnit !== 'lon' && nativeUnit !== 'bình') ? nativeUnit : 'thùng';
  const calc = calculateOrderItem(product, 1, defaultUnit);
  currentOrder.items.push({
    rawProduct: product.name,
    qty: 1,
    unit: defaultUnit,
    product: product,
    unitPrice: calc.unitPrice,
    subtotal: calc.subtotal,
    foc: calc.foc,
    tierLabel: calc.tierLabel,
    manualPrice: null,
    isGift: false
  });
  store.setState({ currentOrder });
  showToast(`Đã thêm thủ công: ${product.name}`, 'success');
}

// Add custom product (not in catalog) to order for testing
function addCustomProductToOrder() {
  const nameEl = document.getElementById('customProductName');
  const qtyEl = document.getElementById('customProductQty');
  const unitEl = document.getElementById('customProductUnit');
  const priceEl = document.getElementById('customProductPrice');
  if (!nameEl) return;

  const name = nameEl.value.trim();
  if (!name) { showToast('Vui lòng nhập tên sản phẩm!', 'error'); nameEl.focus(); return; }

  const qty = parseInt(qtyEl.value) || 1;
  const unit = unitEl.value.trim() || 'thùng';
  const price = parseFloat(priceEl.value) || 0;

  const currentOrder = store.getState().currentOrder;
  currentOrder.items.push({
    rawName: name,
    qty: qty,
    unit: unit,
    product: null,
    unitPrice: price,
    subtotal: price * qty,
    foc: [],
    tierLabel: 'Tự nhập',
    manualPrice: price,
    isGift: false,
    isCustom: true
  });
  store.setState({ currentOrder });
  showToast(`Đã thêm: ${name} x${qty} ${unit}`, 'success');
  nameEl.value = '';
  qtyEl.value = '1';
  priceEl.value = '0';
  nameEl.focus();
}

// --- Export Delivery Note Summary ---

// Kiểm tra dữ liệu trước khi xuất/copy: trả về danh sách vấn đề (rỗng = OK)
function validateOrderBeforeExport(rows, customerName) {
  const issues = [];
  if (!customerName || !customerName.trim()) {
    issues.push('• Thiếu Tên khách hàng');
  }
  let idx = 0;
  (rows || []).forEach(row => {
    if (row.type === 'matched' || row.type === 'unmatched') idx++;
    if (row.type === 'unmatched') {
      issues.push(`• Dòng ${idx}: chưa khớp sản phẩm — "${row.rawName || ''}"`);
    } else if (row.type === 'matched') {
      const name = row.product ? row.product.name : '(không tên)';
      const score = (row.matchScore === undefined || row.matchScore === null) ? 100 : row.matchScore;
      if (!row.isGift && score < 60) {
        issues.push(`• Dòng ${idx}: độ tin cậy khớp thấp (${score}%) — "${name}"`);
      }
      if (!row.isGift && (!row.subtotal || row.subtotal === 0)) {
        issues.push(`• Dòng ${idx}: giá 0đ (không phải hàng tặng) — "${name}"`);
      }
    }
  });
  return issues;
}

// Nếu có vấn đề, hỏi người dùng tiếp tục hay quay lại sửa. Trả về true nếu được phép tiếp tục.
function confirmExportIfIssues(issues, actionLabel) {
  if (!issues || issues.length === 0) return true;
  const msg = `⚠️ Dữ liệu chưa chuẩn (${issues.length} vấn đề):\n\n`
    + issues.join('\n')
    + `\n\nBấm OK để ${actionLabel || 'tiếp tục'}, hoặc Cancel để quay lại sửa.`;
  return window.confirm(msg);
}

function copySummary() {
  const text = document.getElementById('orderText').value.trim();
  const paymentSelect = document.getElementById('paymentMethod');
  const customerName = document.getElementById('customerName').value.trim();

  const { rows, grandTotal, totalBoxes } = uiRenderer.getOrderTableRows(store.getState().currentOrder);

  // Validate trước khi copy
  const issues = validateOrderBeforeExport(rows, customerName);
  if (!confirmExportIfIssues(issues, 'copy phiếu')) return;

  let summary = `📋 PHIẾU GIAO HÀNG / ĐƠN HÀNG\n`;
  summary += `👤 Khách hàng: ${customerName || 'Chưa ghi tên'}\n`;
  summary += `💳 Thanh toán: ${paymentSelect.options[paymentSelect.selectedIndex].text}\n`;
  summary += `📅 Ngày lập: ${new Date().toLocaleDateString('vi-VN')}\n`;
  summary += `-------------------------------------------\n`;

  let itemCounter = 1;
  rows.forEach(row => {
    if (row.type === 'matched') {
      const totalUnits = row.unit === 'thùng' ? row.qty * row.boxSize : row.qty;
      const unitLabel = row.unit === 'thùng' ? 'Thùng' : 'Chai';
      summary += `${itemCounter++}. ${row.product.name} [${row.product.spec || ''}]\n`;
      summary += `   SL: ${row.qty} ${unitLabel} (${totalUnits} chai) x Đơn giá: ${formatCurrency(row.showPrice)} = ${formatCurrency(row.subtotal)}\n`;
    } else if (row.type === 'unmatched') {
      summary += `${itemCounter++}. ⚠️ [CHƯA KHỚP] ${row.rawName}\n`;
      summary += `   SL: ${row.qty} ${row.unit} x Đơn giá: ${formatCurrency(row.bottlePrice)} = ${formatCurrency(row.subtotal)}\n`;
    } else if (row.type === 'gift') {
      const typeLabel = row.giftSource === 'FOC' ? 'KM FOC' : 'KM MKT';
      summary += `🎁 TẶNG: ${row.name} (SL: ${row.qty} ${row.unit}) [${typeLabel} - ${row.note || ''}]\n`;
    }
  });

  const currentOrder = store.getState().currentOrder;
  if (currentOrder.customPromos.length > 0) {
    summary += `-------------------------------------------\n`;
    summary += `🎁 CHƯƠNG TRÌNH KHUYẾN MÃI:\n`;
    currentOrder.customPromos.forEach(p => {
      summary += p.value > 0
        ? `   - ${p.name}: -${formatCurrency(p.value)}\n`
        : `   - ${p.name}\n`;
    });
  }

  const promoDeductions = currentOrder.customPromos.reduce((acc, p) => acc + p.value, 0);
  const finalPay = Math.max(0, grandTotal - promoDeductions);

  summary += `-------------------------------------------\n`;
  summary += `📦 Tổng số thùng: ${totalBoxes.toFixed(1).replace('.0', '')} thùng\n`;
  summary += `💰 Tổng tiền hàng: ${formatCurrency(grandTotal)}\n`;
  if (promoDeductions > 0) {
    summary += `🎁 Trừ khuyến mãi: -${formatCurrency(promoDeductions)}\n`;
  }
  summary += `💵 Thực thanh toán: ${formatCurrency(finalPay)}\n`;

  navigator.clipboard.writeText(summary).then(() => {
    showToast('Đã copy phiếu giao hàng vào Clipboard!', 'success');
  }).catch(err => {
    console.error('Copy failed:', err);
    showToast('Sao chép thất bại, vui lòng copy thủ công', 'error');
  });
}

function clearOrder() {
  store.setState({
    currentOrder: {
      customer: '',
      payment: 'ck',
      items: [],
      customPromos: [],
      parsedLines: [],
      aiResult: null,
      giftOverrides: {},
      giftDeleted: {},
      giftQtyOverrides: {},
      rowOrder: null
    }
  });
  
  const orderText = document.getElementById('orderText');
  const custName = document.getElementById('customerName');
  const noteEl = document.getElementById('orderNote');
  const payEl = document.getElementById('paymentMethod');
  if (orderText) orderText.value = '';
  if (custName) custName.value = '';
  if (noteEl) noteEl.value = '';
  if (payEl) payEl.value = 'ck';
  autoGrowOrderText();
  
  showToast('Đã xóa đơn hàng hiện tại.', 'info');
}

function loadSampleOrder() {
  const sample = `Anywhere Man
Cửa hàng Thành Đạt
3 thùng hand cleaner giá 106k
2 thùng prostream 10w40 tặng 2 lon
CK`;
  const orderText = document.getElementById('orderText');
  if (orderText) {
    orderText.value = sample;
    autoGrowOrderText();
    showToast('Đã tải đơn hàng mẫu. Hãy bấm "Phân Tích Đơn Hàng"!', 'info');
  }
}

/**
 * Auto-size the order textarea to fit its content, capped so the input
 * band never swallows the results table. Past the cap, CSS gives the
 * textarea its own visible vertical scrollbar.
 */
function autoGrowOrderText() {
  const ta = document.getElementById('orderText');
  if (!ta) return;
  ta.style.height = 'auto';
  const cap = Math.min(340, Math.round(window.innerHeight * 0.4));
  ta.style.height = Math.min(ta.scrollHeight, cap) + 'px';
}

// --- Campaign Catalog Tab interactions ---

// Preserve expanded catalog card state across re-renders
function saveCatalogSearchState() {
  const searchEl = document.getElementById('catalogSearchInput');
  const catalogContent = document.getElementById('catalogContent');
  return {
    searchValue: searchEl ? searchEl.value : '',
    scrollTop: catalogContent ? catalogContent.scrollTop : 0
  };
}

function restoreCatalogSearchState(state) {
  if (!state) return;
  // Static input is never destroyed — just keep state in sync, no focus stealing
  uiRenderer._catalogSearch = state.searchValue || '';
  const el = document.getElementById('catalogSearchInput');
  if (el && el.value !== state.searchValue) el.value = state.searchValue || '';
  const clearBtn = document.getElementById('catalogSearchClear');
  if (clearBtn) clearBtn.style.display = state.searchValue ? '' : 'none';
  const catalogContent = document.getElementById('catalogContent');
  if (catalogContent && state.scrollTop) catalogContent.scrollTop = state.scrollTop;
}

function saveExpandedCatalogCards() {
  const expanded = [];
  document.querySelectorAll('.catalog-card-detail').forEach(el => {
    if (el.style.display !== 'none') {
      expanded.push(el.getAttribute('data-detail-id'));
    }
  });
  return expanded;
}

function restoreExpandedCatalogCards(expandedIds) {
  if (!expandedIds || expandedIds.length === 0) return;
  expandedIds.forEach(pId => {
    const detail = document.querySelector(`.catalog-card-detail[data-detail-id="${pId}"]`);
    if (detail) detail.style.display = 'block';
    const toggleBtn = document.querySelector(`.btn-toggle-catalog-card[data-product-id="${pId}"]`);
    if (toggleBtn) toggleBtn.textContent = '▾';
  });
}

let _catalogToastTimer = null;
function catalogSavedToast(msg) {
  clearTimeout(_catalogToastTimer);
  _catalogToastTimer = setTimeout(() => showToast(msg || 'Đã lưu thay đổi danh mục!', 'success'), 800);
}

// No-op stub — catalog events are now handled via event delegation
// (see initCatalogDelegation below). This is kept for backward compatibility.
window.attachCatalogInteractiveListeners = function() {};

// --- Event Delegation for Catalog (replaces per-render listener binding) ---
// Binds ONCE on the catalog container; handles all click/change events
// through bubbling, eliminating thousands of per-element handler attachments.
function initCatalogDelegation() {
  const container = document.getElementById('catalogContent');
  if (!container) return;

  // Helper: re-render catalog while preserving search state & expanded cards
  function refreshCatalog() {
    const _searchState = saveCatalogSearchState();
    const _expanded = saveExpandedCatalogCards();
    const curFilter = (document.getElementById('catalogCampaignFilter') || {}).value || 'all';
    uiRenderer.renderCatalog(curFilter);
    restoreExpandedCatalogCards(_expanded);
    restoreCatalogSearchState(_searchState);
  }

  // ── Click delegation ──
  container.addEventListener('click', (e) => {
    // Resolve clicked element: try button first, then .btn-toggle-mkt-inline (which is a span)
    const btn = e.target.closest('button') || e.target.closest('.btn-toggle-mkt-inline');
    if (!btn) return;

    // Remove tier
    if (btn.matches('.btn-remove-catalog-tier')) {
      const pId = btn.getAttribute('data-product-id');
      const cKey = btn.closest('[data-campaign-key]')?.getAttribute('data-campaign-key');
      const idx = parseInt(btn.getAttribute('data-tier-idx'));
      const prod = db.findProductRefById(pId, cKey);
      if (prod && prod.tiers && prod.tiers.length > idx) {
        prod.tiers.splice(idx, 1);
        db.save();
        workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
        refreshCatalog();
        showToast('Đã xóa mốc giá!', 'info');
      }
      return;
    }

    // Add tier
    if (btn.matches('.btn-add-catalog-tier')) {
      const pId = btn.getAttribute('data-product-id');
      const cKey = btn.closest('[data-campaign-key]')?.getAttribute('data-campaign-key');
      const prod = db.findProductRefById(pId, cKey);
      if (prod) {
        if (!prod.tiers) prod.tiers = [];
        prod.tiers.push({ min_qty: 1, max_qty: 999, price: 0, label: 'Mốc mới' });
        db.save();
        workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
        refreshCatalog();
        showToast('Đã thêm mốc giá!', 'success');
      }
      return;
    }

    // Remove FOC
    if (btn.matches('.btn-remove-catalog-foc')) {
      const pId = btn.getAttribute('data-product-id');
      const cKey = btn.closest('[data-campaign-key]')?.getAttribute('data-campaign-key');
      const idx = parseInt(btn.getAttribute('data-foc-idx'));
      const prod = db.findProductRefById(pId, cKey);
      if (prod && prod.foc_rules && prod.foc_rules.length > idx) {
        prod.foc_rules.splice(idx, 1);
        db.save();
        workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
        refreshCatalog();
        showToast('Đã xóa khuyến mãi FOC!', 'info');
      }
      return;
    }

    // Add FOC
    if (btn.matches('.btn-add-catalog-foc')) {
      const pId = btn.getAttribute('data-product-id');
      const cKey = btn.closest('[data-campaign-key]')?.getAttribute('data-campaign-key');
      const prod = db.findProductRefById(pId, cKey);
      if (prod) {
        if (!prod.foc_rules) prod.foc_rules = [];
        prod.foc_rules.push({ buy_qty: 10, buy_unit: 'thùng', give_qty: 1, give_unit: prod.unit || 'chai', give_product: '__same__' });
        db.save();
        workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
        refreshCatalog();
        showToast('Đã thêm khuyến mãi FOC!', 'success');
      }
      return;
    }

    // Toggle inline MKT editor from badge click
    if (btn.matches('.btn-toggle-mkt-inline')) {
      e.stopPropagation();
      const pId = btn.getAttribute('data-product-id');
      const row = btn.closest('.catalog-list-row');
      const inline = row ? row.querySelector('.catalog-mkt-inline[data-mkt-product-id="' + pId + '"]') : null;
      if (inline) {
        const isVisible = inline.style.display !== 'none';
        document.querySelectorAll('.catalog-mkt-inline').forEach(el => el.style.display = 'none');
        inline.style.display = isVisible ? 'none' : 'block';
      }
      return;
    }

    // Remove MKT
    if (btn.matches('.btn-remove-catalog-mkt')) {
      const pId = btn.getAttribute('data-product-id');
      const cKey = btn.closest('[data-campaign-key]')?.getAttribute('data-campaign-key');
      const idx = parseInt(btn.getAttribute('data-mkt-idx'));
      const prod = db.findProductRefById(pId, cKey);
      if (prod && prod.mkt_gift_rules && prod.mkt_gift_rules.length > idx) {
        prod.mkt_gift_rules.splice(idx, 1);
        db.save();
        workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
        refreshCatalog();
        showToast('Đã xóa quà MKT!', 'info');
      }
      return;
    }

    // Add MKT
    if (btn.matches('.btn-add-catalog-mkt')) {
      const pId = btn.getAttribute('data-product-id');
      const cKey = btn.closest('[data-campaign-key]')?.getAttribute('data-campaign-key');
      const prod = db.findProductRefById(pId, cKey);
      if (prod) {
        if (!prod.mkt_gift_rules) prod.mkt_gift_rules = [];
        prod.mkt_gift_rules.push({ buy_qty: 1, give_qty: 1, give_unit: 'cái', give_product: '', give_product_name: '', note: '' });
        db.save();
        workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
        refreshCatalog();
        showToast('Đã thêm quà MKT!', 'success');
      }
      return;
    }

    // Go to settings editor for specific product
    if (btn.matches('.btn-go-to-editor')) {
      const campKey = btn.getAttribute('data-campaign-key');
      const pId = btn.getAttribute('data-product-id');
      const tabSettingsBtn = document.getElementById('tabSettings') || document.querySelector('.nav-tab[data-tab="settings"]');
      if (tabSettingsBtn) tabSettingsBtn.click();
      if (typeof switchSettingsSubTab === 'function') switchSettingsSubTab('products');
      if (typeof selectSettingsCampaign === 'function') selectSettingsCampaign(campKey);
      setTimeout(() => {
        const prodCard = document.getElementById(`product-card-${pId}`);
        if (prodCard) {
          prodCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
          prodCard.style.outline = '2px solid var(--accent-blue)';
          setTimeout(() => { prodCard.style.outline = ''; }, 2500);
        }
      }, 150);
      return;
    }

    // Toggle catalog card detail
    if (btn.matches('.btn-toggle-catalog-card')) {
      const pId = btn.getAttribute('data-product-id');
      const detail = document.querySelector(`.catalog-card-detail[data-detail-id="${pId}"]`);
      if (!detail) return;
      const isOpen = detail.style.display !== 'none';
      detail.style.display = isOpen ? 'none' : 'block';
      btn.textContent = isOpen ? '▸' : '▾';
      return;
    }

    // Delete product
    if (btn.matches('.btn-delete-catalog-product')) {
      const pId = btn.getAttribute('data-product-id');
      const cKey = btn.getAttribute('data-campaign-key') || btn.closest('[data-campaign-key]')?.getAttribute('data-campaign-key');
      const prod = db.findProductById(pId, cKey);
      const nm = prod ? prod.name : pId;
      if (confirm(`Xóa sản phẩm "${nm}"?`)) {
        db.deleteProduct(pId);
        workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
        refreshCatalog();
        showToast('Đã xóa sản phẩm!', 'info');
      }
      return;
    }

    // Add new product to campaign
    if (btn.matches('.btn-add-catalog-product')) {
      const campKey = btn.getAttribute('data-campaign-key');
      db.addProduct(campKey, {
        name: 'Sản phẩm mới',
        unit: 'chai',
        box_size: 12,
        tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Tất cả' }],
        foc_rules: [],
        mkt_gift_rules: []
      });
      workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
      const curFilter = (document.getElementById('catalogCampaignFilter') || {}).value || 'all';
      uiRenderer.renderCatalog(curFilter);
      showToast('Đã thêm sản phẩm mới. Hãy mở thẻ để sửa tên & giá.', 'success');
      return;
    }
  });

  // ── Change delegation ──
  container.addEventListener('change', (e) => {
    const target = e.target;

    // Product field input
    if (target.matches('.catalog-product-input[data-product-id]')) {
      const pId = target.getAttribute('data-product-id');
      const field = target.getAttribute('data-field');
      let val = target.value;
      if (field === 'box_size') val = parseInt(val) || 12;
      // KV mã GỐC — phải cập nhật cả kvCodeMap (kv-name-map.json) thì getKvCode() mới nhận
      if (field === 'kvCode') db.setKvCodeBase(pId, val);
      else db.updateProduct(pId, { [field]: val });
      workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
      catalogSavedToast('Đã cập nhật sản phẩm!');
      return;
    }

    // Tier input
    if (target.matches('.catalog-tier-input[data-product-id]')) {
      const pId = target.getAttribute('data-product-id');
      const cKey = target.closest('[data-campaign-key]')?.getAttribute('data-campaign-key');
      const idx = parseInt(target.getAttribute('data-tier-idx'));
      const field = target.getAttribute('data-field');
      let val = target.value;
      if (field === 'price') val = parseFloat(val) || 0;
      const prod = db.findProductRefById(pId, cKey);
      if (prod && prod.tiers && prod.tiers[idx]) {
        prod.tiers[idx][field] = val;
        db.save();
        workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
        catalogSavedToast('Đã cập nhật bảng giá!');
      }
      return;
    }

    // FOC input
    if (target.matches('.catalog-foc-input[data-product-id]')) {
      const pId = target.getAttribute('data-product-id');
      const cKey = target.closest('[data-campaign-key]')?.getAttribute('data-campaign-key');
      const idx = parseInt(target.getAttribute('data-foc-idx'));
      const field = target.getAttribute('data-field');
      let val = target.value;
      if (field === 'buy_qty' || field === 'give_qty') val = parseInt(val) || 1;
      const prod = db.findProductRefById(pId, cKey);
      if (prod && prod.foc_rules && prod.foc_rules[idx]) {
        prod.foc_rules[idx][field] = val;
        db.save();
        workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
        catalogSavedToast('Đã cập nhật quà tặng FOC!');
      }
      return;
    }

    // MKT input
    if (target.matches('.catalog-mkt-input[data-product-id]')) {
      const pId = target.getAttribute('data-product-id');
      const cKey = target.closest('[data-campaign-key]')?.getAttribute('data-campaign-key');
      const idx = parseInt(target.getAttribute('data-mkt-idx'));
      const field = target.getAttribute('data-field');
      let val = target.value;
      if (field === 'buy_qty' || field === 'give_qty') val = parseInt(val) || 1;
      const prod = db.findProductRefById(pId, cKey);
      if (prod && prod.mkt_gift_rules && prod.mkt_gift_rules[idx]) {
        prod.mkt_gift_rules[idx][field] = val;
        db.save();
        workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
        catalogSavedToast('Đã cập nhật quà MKT!');
      }
      return;
    }
  });
}

// --- Settings Section & Actions ---

// Settings sub-tab switching
function switchSettingsSubTab(tabId) {
  // Hide all sub-tab contents
  document.querySelectorAll('.settings-subtab-content').forEach(panel => {
    panel.classList.remove('active');
  });
  // Deactivate all buttons
  document.querySelectorAll('.settings-subtab-btn').forEach(btn => {
    btn.classList.remove('active');
    btn.setAttribute('aria-selected', 'false');
  });
  // Show selected tab
  const activePanel = document.getElementById(`subtab-${tabId}`);
  if (activePanel) activePanel.classList.add('active');
  // Activate button
  const activeBtn = document.querySelector(`.settings-subtab-btn[data-subtab="${tabId}"]`);
  if (activeBtn) {
    activeBtn.classList.add('active');
    activeBtn.setAttribute('aria-selected', 'true');
  }
  
  // Initialize order subtab content when shown
  if (tabId === 'order') {
    renderPrefixConfigList();
    renderSequenceResetList();
  }
}

function selectSettingsCampaign(campaignKey) {
  store.setState({ selectedSettingsCampaign: campaignKey });
  uiRenderer.renderSettingsSidebar(campaignKey);
  uiRenderer.renderSettingsEditor(campaignKey);
}

window.attachSettingsSidebarListeners = function() {
  const container = document.getElementById('settingsCampaignList');
  if (!container) return;

  // Add campaign button click
  const showAddBtn = document.getElementById('btnShowAddCampaign');
  if (showAddBtn) {
    showAddBtn.onclick = () => toggleAddCampaignForm();
  }

  // Campaign items click
  container.querySelectorAll('.campaign-list-item[data-campaign-key]').forEach(item => {
    item.onclick = function(e) {
      // If clicking delete button, skip
      if (e.target.classList.contains('delete-campaign-btn')) return;
      const key = this.getAttribute('data-campaign-key');
      selectSettingsCampaign(key);
    };
  });

  // Delete campaign click
  container.querySelectorAll('.delete-campaign-btn').forEach(btn => {
    btn.onclick = function(e) {
      e.stopPropagation();
      const key = this.getAttribute('data-delete-campaign');
      if (confirm(`Bạn có chắc chắn muốn xóa toàn bộ thương hiệu "${key}"? Hành động này sẽ xóa tất cả sản phẩm của thương hiệu này.`)) {
        db.deleteCampaign(key);
        workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
        selectSettingsCampaign(null);
        showToast(`Đã xóa thương hiệu: ${key}`, 'info');
      }
    };
  });
}

// --- Event Delegation for Product Editor (Phase 3) ---
// ⚠️ DEAD CODE — index.html chỉ nạp /src/main.js; bản runtime THẬT của bộ handler
// Settings/MKT nằm ở src/settings/ui.js. KHÔNG sửa/xóa handler tại đây (file này
// chỉ còn được tham chiếu bởi test/app.test.js).

function initProductEditorDelegation() {
  const container = document.getElementById('productEditor');
  if (!container) return;

  // Click delegation
  container.addEventListener('click', (e) => {
    const target = e.target.closest('button') || e.target;
    const campaignKey = store.getState().selectedSettingsCampaign;

    // Delete product (inline confirmation)
    if (target.matches('.btn-delete-product')) {
      handleDeleteProduct(target, campaignKey);
      return;
    }

    // Add tier
    if (target.matches('.btn-add-tier')) {
      const pId = target.getAttribute('data-product-id');
      const p = db.findProductById(pId);
      if (p) {
        p.tiers = p.tiers || [];
        p.tiers.push({ min_qty: 1, max_qty: 9999, price: 0, label: 'Tất cả' });
        db.updateProductTiers(pId, p.tiers);
        uiRenderer.renderTiersForProduct(pId, p.tiers);
        showToast('Đã thêm mức giá mới!', 'success');
      }
      return;
    }

    // Remove tier
    if (target.matches('.btn-remove-tier')) {
      const pId = target.getAttribute('data-product-id');
      const idx = parseInt(target.getAttribute('data-tier-idx'));
      const p = db.findProductById(pId);
      if (p && p.tiers) {
        p.tiers.splice(idx, 1);
        db.updateProductTiers(pId, p.tiers);
        uiRenderer.renderTiersForProduct(pId, p.tiers);
        showToast('Đã xóa mức giá!', 'info');
      }
      return;
    }

    // Add FOC
    if (target.matches('.btn-add-foc')) {
      const pId = target.getAttribute('data-product-id');
      const p = db.findProductById(pId);
      if (p) {
        p.foc_rules = p.foc_rules || [];
        p.foc_rules.push({ buy_qty: 1, buy_unit: 'thùng', give_qty: 1, give_unit: '', give_product: '', note: '' });
        db.updateProductFOC(pId, p.foc_rules);
        uiRenderer.renderFOCForProduct(pId, p.foc_rules);
        showToast('Đã thêm chương trình FOC mới!', 'success');
      }
      return;
    }

    // Remove FOC
    if (target.matches('.btn-remove-foc')) {
      const pId = target.getAttribute('data-product-id');
      const idx = parseInt(target.getAttribute('data-foc-idx'));
      const p = db.findProductById(pId);
      if (p && p.foc_rules) {
        p.foc_rules.splice(idx, 1);
        db.updateProductFOC(pId, p.foc_rules);
        uiRenderer.renderFOCForProduct(pId, p.foc_rules);
        showToast('Đã xóa FOC!', 'info');
      }
      return;
    }

    // Remove alias
    if (target.matches('.btn-remove-alias')) {
      const alias = target.getAttribute('data-alias');
      const pId = target.getAttribute('data-product-id');
      db.removeAlias(alias);
      workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
      uiRenderer.renderAliasesForProduct(pId);
      showToast(`Đã xóa alias: "${alias}"`, 'info');
      return;
    }

    // Show inline alias input
    if (target.matches('.btn-add-alias')) {
      const pId = target.getAttribute('data-product-id');
      const wrapper = container.querySelector(`.alias-input-wrapper[data-product-id="${pId}"]`);
      if (wrapper) {
        wrapper.style.display = 'inline-flex';
        wrapper.querySelector('.alias-inline-input').focus();
      }
      return;
    }

    // Confirm alias
    if (target.matches('.btn-confirm-alias')) {
      const pId = target.getAttribute('data-product-id');
      saveInlineAlias(pId, container);
      return;
    }

    // Cancel alias
    if (target.matches('.btn-cancel-alias')) {
      const pId = target.getAttribute('data-product-id');
      hideAliasInput(pId, container);
      return;
    }

    // Add MKT rule
    if (target.matches('.btn-add-mkt')) {
      const cKey = target.getAttribute('data-campaign-key');
      const campaign = db.data.campaigns[cKey];
      if (campaign) {
        campaign.mkt_gift_rules = campaign.mkt_gift_rules || [];
        campaign.mkt_gift_rules.push({ min_total: 0, max_total: 999999999, unit: 'amount', label: '', gift_items: [], gifts: '' });
        db.save();
        uiRenderer.renderSettingsEditor(cKey);
        showToast('Đã thêm mốc quà MKT mới!', 'success');
      }
      return;
    }

    // Add gift item vào mốc MKT
    if (target.matches('.btn-add-mkt-gift')) {
      const row = target.closest('.mkt-rule-row[data-campaign-key]');
      const rule = row && _getMktRuleFromRow(row);
      if (rule) {
        rule.gift_items = uiRenderer.normalizeMktGiftItems(rule);
        rule.gift_items.push({ qty: 1, name: '' });
        db.save();
        uiRenderer.renderSettingsEditor(row.getAttribute('data-campaign-key'));
      }
      return;
    }

    // Remove gift item khỏi mốc MKT
    if (target.matches('.btn-remove-mkt-gift')) {
      const row = target.closest('.mkt-rule-row[data-campaign-key]');
      const rule = row && _getMktRuleFromRow(row);
      const giftRow = target.closest('.mkt-gift-item-row');
      if (rule && giftRow) {
        const gIdx = parseInt(giftRow.getAttribute('data-gift-idx'));
        rule.gift_items = uiRenderer.normalizeMktGiftItems(rule);
        rule.gift_items.splice(gIdx, 1);
        rule.gifts = uiRenderer.buildMktGiftsString(rule.gift_items);
        db.save();
        uiRenderer.renderSettingsEditor(row.getAttribute('data-campaign-key'));
      }
      return;
    }

    // Remove MKT rule
    if (target.matches('.btn-remove-mkt')) {
      const cKey = target.getAttribute('data-campaign-key');
      const idx = parseInt(target.getAttribute('data-rule-idx'));
      const campaign = db.data.campaigns[cKey];
      if (campaign && campaign.mkt_gift_rules) {
        campaign.mkt_gift_rules.splice(idx, 1);
        db.save();
        uiRenderer.renderSettingsEditor(cKey);
        showToast('Đã xóa mốc quà MKT!', 'info');
      }
      return;
    }

    // Show Add Product Form Button
    if (target.matches('#btnShowAddProductForm') || target.id === 'btnShowAddProductForm') {
      toggleAddProductForm();
      return;
    }
  });

  // Change delegation for inputs
  container.addEventListener('change', (e) => {
    const target = e.target;
    const campaignKey = store.getState().selectedSettingsCampaign;

    // Product field inputs
    if (target.matches('.product-field-input[data-product-id]')) {
      const pId = target.getAttribute('data-product-id');
      const field = target.getAttribute('data-field');
      let val = target.value;

      // Validation
      if (field === 'name' && !val.trim()) {
        target.classList.add('input-error');
        showToast('Tên sản phẩm không được để trống!', 'error');
        return;
      }
      target.classList.remove('input-error');

      if (field === 'box_size') val = parseInt(val) || 12;
      // KV mã GỐC — phải cập nhật cả kvCodeMap (kv-name-map.json) thì getKvCode() mới nhận
      if (field === 'kvCode') db.setKvCodeBase(pId, val);
      else db.updateProduct(pId, { [field]: val });
      workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
      flashSuccess(target);
      showToast('Đã cập nhật sản phẩm!', 'success');
      return;
    }

    // Tier inputs
    const tierRow = target.closest('.tier-row[data-product-id]');
    if (tierRow) {
      const pId = tierRow.getAttribute('data-product-id');
      const idx = parseInt(tierRow.getAttribute('data-tier-idx'));
      const p = db.findProductById(pId);
      if (!p || !p.tiers || !p.tiers[idx]) return;

      const t = p.tiers[idx];
      t.label = tierRow.querySelector('.tier-label-input').value;
      t.min_qty = parseInt(tierRow.querySelector('.tier-min-input').value) || 0;
      t.max_qty = parseInt(tierRow.querySelector('.tier-max-input').value) || 9999;
      t.price = parseInt(tierRow.querySelector('.tier-price-input').value) || 0;

      // Validation
      if (t.min_qty > t.max_qty) {
        tierRow.querySelector('.tier-min-input').classList.add('input-error');
        showToast('Số lượng tối thiểu không được lớn hơn tối đa!', 'error');
        return;
      }
      if (t.price < 0) {
        tierRow.querySelector('.tier-price-input').classList.add('input-error');
        showToast('Giá không được âm!', 'error');
        return;
      }
      tierRow.querySelectorAll('input').forEach(i => i.classList.remove('input-error'));

      db.updateProductTiers(pId, p.tiers);
      flashSuccess(target);
      showToast('Đã cập nhật mức giá!', 'success');
      return;
    }

    // FOC inputs
    const focRow = target.closest('.foc-row[data-product-id]');
    if (focRow) {
      const pId = focRow.getAttribute('data-product-id');
      const idx = parseInt(focRow.getAttribute('data-foc-idx'));
      const p = db.findProductById(pId);
      if (!p || !p.foc_rules || !p.foc_rules[idx]) return;

      const f = p.foc_rules[idx];
      f.buy_qty = parseInt(focRow.querySelector('.foc-buy-input').value) || 1;
      f.buy_unit = focRow.querySelector('.foc-buyunit-input') ? focRow.querySelector('.foc-buyunit-input').value : 'thùng';
      f.give_qty = parseInt(focRow.querySelector('.foc-give-input').value) || 1;
      f.give_unit = focRow.querySelector('.foc-unit-input').value;
      const newGiveProduct = focRow.querySelector('.foc-give-product-input')?.value;
      if (newGiveProduct !== undefined && newGiveProduct !== null) {
        f.give_product = newGiveProduct;
      }
      f.note = focRow.querySelector('.foc-note-input')?.value || f.note || '';

      // Validation
      if (f.buy_qty <= 0) {
        focRow.querySelector('.foc-buy-input').classList.add('input-error');
        showToast('Số lượng mua phải lớn hơn 0!', 'error');
        return;
      }
      if (f.give_qty <= 0) {
        focRow.querySelector('.foc-give-input').classList.add('input-error');
        showToast('Số lượng tặng phải lớn hơn 0!', 'error');
        return;
      }
      focRow.querySelectorAll('input').forEach(i => i.classList.remove('input-error'));

      db.updateProductFOC(pId, p.foc_rules);
      flashSuccess(target);
      showToast('Đã cập nhật FOC!', 'success');
      return;
    }

    // Campaign settings inputs
    if (target.id === 'editCampaignName') {
      const val = target.value.trim();
      if (!val) {
        target.classList.add('input-error');
        showToast('Tên thương hiệu không được để trống!', 'error');
        return;
      }
      target.classList.remove('input-error');
      db.updateCampaign(campaignKey, { name: val });
      uiRenderer.renderSettingsSidebar(campaignKey);
      flashSuccess(target);
      showToast('Đã lưu tên thương hiệu!', 'success');
      return;
    }
    if (target.id === 'editCampaignIcon') {
      db.updateCampaign(campaignKey, { icon: target.value.trim() });
      uiRenderer.renderSettingsSidebar(campaignKey);
      flashSuccess(target);
      showToast('Đã lưu icon thương hiệu!', 'success');
      return;
    }
    if (target.id === 'editCampaignColor') {
      db.updateCampaign(campaignKey, { color: target.value.trim() });
      uiRenderer.renderSettingsSidebar(campaignKey);
      flashSuccess(target);
      showToast('Đã lưu màu thương hiệu!', 'success');
      return;
    }
    if (target.id === 'editCampaignBrand') {
      db.updateCampaign(campaignKey, { brand: target.value });
      workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
      flashSuccess(target);
      showToast('Đã lưu nhãn hàng liên kết!', 'success');
      return;
    }

    // MKT rule inputs
    const mktRow = target.closest('.mkt-rule-row[data-campaign-key]');
    if (mktRow) {
      const cKey = mktRow.getAttribute('data-campaign-key');
      const idx = parseInt(mktRow.getAttribute('data-rule-idx'));
      const campaign = db.data.campaigns[cKey];
      if (!campaign || !campaign.mkt_gift_rules || !campaign.mkt_gift_rules[idx]) return;

      const r = campaign.mkt_gift_rules[idx];

      // Ô số lượng / tên quà trong danh sách quà cấu trúc
      const giftRow = target.closest('.mkt-gift-item-row');
      if (giftRow) {
        const gIdx = parseInt(giftRow.getAttribute('data-gift-idx'));
        r.gift_items = uiRenderer.normalizeMktGiftItems(r);
        if (r.gift_items[gIdx]) {
          if (target.matches('.mkt-gift-qty')) {
            r.gift_items[gIdx].qty = parseInt(target.value) || 1;
            target.value = r.gift_items[gIdx].qty;
          } else if (target.matches('.mkt-gift-name')) {
            r.gift_items[gIdx].name = target.value.trim();
            // Liên kết sản phẩm thật (chọn từ gợi ý) — gõ tay thì rỗng
            r.gift_items[gIdx].product_id = giftRow.getAttribute('data-gift-product-id') || '';
          }
        }
      }

      r.min_total = parseInt(mktRow.querySelector('.mkt-min-input').value) || 0;
      r.max_total = parseInt(mktRow.querySelector('.mkt-max-input').value) || 999999999;
      r.unit = mktRow.querySelector('.mkt-unit-select').value;
      r.label = mktRow.querySelector('.mkt-label-input').value;
      // Đồng bộ chuỗi gifts legacy từ danh sách quà cấu trúc
      r.gift_items = uiRenderer.normalizeMktGiftItems(r);
      r.gifts = uiRenderer.buildMktGiftsString(r.gift_items);

      db.save();
      flashSuccess(target);
      showToast('Đã cập nhật mốc quà MKT!', 'success');
      return;
    }
  });

  // Keydown delegation for inline alias input
  container.addEventListener('keydown', (e) => {
    if (e.target.matches('.alias-inline-input')) {
      const pId = e.target.getAttribute('data-product-id');
      if (e.key === 'Enter') {
        e.preventDefault();
        saveInlineAlias(pId, container);
      } else if (e.key === 'Escape') {
        hideAliasInput(pId, container);
      }
    }
  });
}

// Helper: lấy rule MKT từ DOM row (.mkt-rule-row có data-campaign-key + data-rule-idx)
function _getMktRuleFromRow(row) {
  if (!row) return null;
  const cKey = row.getAttribute('data-campaign-key');
  const idx = parseInt(row.getAttribute('data-rule-idx'));
  const campaign = db.data.campaigns[cKey];
  return (campaign && campaign.mkt_gift_rules) ? campaign.mkt_gift_rules[idx] : null;
}

// Helper: save alias from inline input
function saveInlineAlias(productId, container) {
  const wrapper = container.querySelector(`.alias-input-wrapper[data-product-id="${productId}"]`);
  if (!wrapper) return;
  const input = wrapper.querySelector('.alias-inline-input');
  const alias = input.value.trim();
  if (alias) {
    db.addAlias(alias, productId);
    workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
    uiRenderer.renderAliasesForProduct(productId);
    showToast(`Đã thêm alias: "${alias}"`, 'success');
  }
  hideAliasInput(productId, container);
}

// Helper: hide inline alias input
function hideAliasInput(productId, container) {
  const wrapper = container.querySelector(`.alias-input-wrapper[data-product-id="${productId}"]`);
  if (wrapper) {
    wrapper.style.display = 'none';
    wrapper.querySelector('.alias-inline-input').value = '';
  }
}

// Helper: flash success on input
function flashSuccess(input) {
  input.classList.add('input-success');
  setTimeout(() => input.classList.remove('input-success'), 1500);
}

// Helper: inline delete confirmation
function handleDeleteProduct(btn, campaignKey) {
  if (btn.hasAttribute('data-confirm-pending')) {
    // Already confirmed - delete
    const pId = btn.getAttribute('data-product-id');
    db.deleteProduct(pId);
    workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
    uiRenderer.renderSettingsEditor(campaignKey);
    uiRenderer.renderSettingsSidebar(campaignKey);
    showToast('Đã xóa sản phẩm!', 'info');
    return;
  }

  // Show confirmation state
  btn.setAttribute('data-confirm-pending', 'true');
  const originalHtml = btn.innerHTML;
  btn.innerHTML = '⚠️ Xác nhận xóa?';
  btn.classList.add('btn-confirm-delete');

  // Auto-revert after 5 seconds
  const timer = setTimeout(() => {
    btn.removeAttribute('data-confirm-pending');
    btn.innerHTML = originalHtml;
    btn.classList.remove('btn-confirm-delete');
  }, 5000);

  btn.setAttribute('data-revert-timer', timer);
}

// --- Popup Modals Form Triggers ---

function toggleAddCampaignForm() {
  const overlay = document.getElementById('modalOverlay');
  const title = document.getElementById('modalTitle');
  const body = document.getElementById('modalBody');

  if (!overlay || !body) return;

  title.textContent = '➕ Thêm Thương Hiệu Mới';
  body.innerHTML = `<div class="card" style="padding:var(--space-md);">
    <div class="input-group">
      <label>Brand Key (Mã viết tắt, chữ thường không dấu, VD: torvex, veltron)</label>
      <input type="text" id="newCampaignKey" class="input-field" placeholder="VD: tvx" />
    </div>
    <div class="input-group" style="margin-top:var(--space-md)">
      <label>Tên thương hiệu</label>
      <input type="text" id="newCampaignName" class="input-field" placeholder="VD: TVX - Dầu Nhớt Xe Máy" />
    </div>
    <div class="input-group" style="margin-top:var(--space-md)">
      <label>Icon hiển thị</label>
      <input type="text" id="newCampaignIcon" class="input-field" placeholder="VD: ⚡" />
    </div>
    <div class="input-group" style="margin-top:var(--space-md)">
      <label>Màu sắc</label>
      <input type="color" id="newCampaignColor" class="input-field" value="#4fc3f7" style="height:38px; padding:2px;" />
    </div>
    <div class="input-group" style="margin-top:var(--space-md)">
      <label>Nhãn hàng liên kết (Brand Excel)</label>
      <select id="newCampaignBrand" class="input-field" style="width: 100%;">
        <option value="zentor" selected>Zentor (6. ZENTOR)</option>
        <option value="torvex">Torvex (5. TORVEX)</option>
        <option value="xvil">Xvil (2. XVIL)</option>
        <option value="veltra">Veltra (1. VELTRA)</option>
        <option value="petrix">Petrix (3. PETRIX)</option>
        <option value="veltron">Veltron (4. VELTRON)</option>
      </select>
    </div>
    <button class="btn btn-success btn-block" id="btnSubmitAddCampaign" style="margin-top:var(--space-xl)">💾 Tạo Thương Hiệu</button>
  </div>`;

  overlay.style.display = 'flex';

  // Bind submit click
  document.getElementById('btnSubmitAddCampaign').onclick = () => saveNewCampaign();
}

function saveNewCampaign() {
  const key = document.getElementById('newCampaignKey').value.trim().toLowerCase();
  const name = document.getElementById('newCampaignName').value.trim();
  const icon = document.getElementById('newCampaignIcon').value.trim();
  const color = document.getElementById('newCampaignColor').value.trim();
  const brandSelect = document.getElementById('newCampaignBrand');
  const brand = brandSelect ? brandSelect.value : 'zentor';

  if (!key || !name) { showToast('Vui lòng điền mã và tên thương hiệu!', 'error'); return; }

  const ok = db.addCampaign(key, { name, icon: icon || '📦', color: color || '#4fc3f7', brand: brand });
  if (ok) {
    workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
    selectSettingsCampaign(key);
    closeModal();
    showToast(`Đã tạo thương hiệu: ${name}!`, 'success');
  } else {
    showToast('Mã thương hiệu đã tồn tại hoặc có lỗi xảy ra!', 'error');
  }
}

window.saveCampaignSettings = function(campaignKey) {
  const nameInput = document.getElementById('editCampaignName');
  const iconInput = document.getElementById('editCampaignIcon');
  const colorInput = document.getElementById('editCampaignColor');
  const brandSelect = document.getElementById('editCampaignBrand');
  
  if (!nameInput || !brandSelect) return;
  
  const name = nameInput.value.trim();
  const icon = iconInput ? iconInput.value.trim() : '📦';
  const color = colorInput ? colorInput.value.trim() : '#4fc3f7';
  const brand = brandSelect.value;
  
  if (!name) {
    showToast('Tên thương hiệu không được để trống!', 'error');
    return;
  }
  
  const ok = db.updateCampaign(campaignKey, { name, icon, color, brand });
  if (ok) {
    workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
    uiRenderer.renderSettingsSidebar(campaignKey);
    uiRenderer.renderSettingsEditor(campaignKey);
    showToast('Đã lưu cấu hình thương hiệu!', 'success');
  } else {
    showToast('Có lỗi xảy ra khi lưu cấu hình!', 'error');
  }
};

function toggleAddProductForm() {
  const overlay = document.getElementById('modalOverlay');
  const title = document.getElementById('modalTitle');
  const body = document.getElementById('modalBody');

  const campaignKey = store.getState().selectedSettingsCampaign;
  if (!overlay || !body || !campaignKey) return;

  title.textContent = '📦 Thêm Sản Phẩm Mới';
  body.innerHTML = `<div class="card" style="padding:var(--space-md); max-height: 70vh; overflow-y: auto;">
    <div class="input-group">
      <label>Tên sản phẩm</label>
      <input type="text" id="newProductName" class="input-field" placeholder="VD: Xvil Box 2" />
    </div>
    <div class="settings-grid" style="display:grid; grid-template-columns: 1fr 1fr; gap:var(--space-md); margin-top:var(--space-md)">
      <div class="input-group">
        <label>Spec (VD: 1L, 4L, 0.8L)</label>
        <input type="text" id="newProductSpec" class="input-field" placeholder="1L" />
      </div>
      <div class="input-group">
        <label>Đóng gói (VD: 12 chai/thùng)</label>
        <input type="text" id="newProductPackaging" class="input-field" placeholder="1L x 12 chai/thùng" />
      </div>
    </div>
    <div class="settings-grid" style="display:grid; grid-template-columns: 1fr 1fr; gap:var(--space-md); margin-top:var(--space-md)">
      <div class="input-group">
        <label>Đơn vị (chai/can/lon/phuy)</label>
        <input type="text" id="newProductUnit" class="input-field" value="chai" />
      </div>
      <div class="input-group">
        <label>Số chai/thùng (box size)</label>
        <input type="number" id="newProductBoxSize" class="input-field" value="12" />
      </div>
    </div>
    <div class="input-group" style="margin-top:var(--space-md)">
      <label>Nhóm hàng (Category)</label>
      <input type="text" id="newProductCategory" class="input-field" list="categorySuggestions" placeholder="VD: Dầu xe máy, Dầu ô tô, Phụ gia, Quà tặng..." />
    </div>
    <div class="input-group" style="margin-top:var(--space-md)">
      <label>Tên gọi tắt (aliases, cách nhau bởi dấu phẩy)</label>
      <input type="text" id="newProductAliases" class="input-field" placeholder="VD: box 2, xvil box" />
    </div>
    <button class="btn btn-success btn-block" id="btnSubmitAddProduct" style="margin-top:var(--space-xl)">💾 Lưu Sản Phẩm</button>
  </div>`;

  overlay.style.display = 'flex';

  // Bind submit click
  document.getElementById('btnSubmitAddProduct').onclick = () => saveNewProduct();
}

function saveNewProduct() {
  const name = document.getElementById('newProductName').value.trim();
  const spec = document.getElementById('newProductSpec').value.trim();
  const packaging = document.getElementById('newProductPackaging').value.trim();
  const unit = document.getElementById('newProductUnit').value.trim();
  const boxSize = parseInt(document.getElementById('newProductBoxSize').value) || 12;
  const category = document.getElementById('newProductCategory').value.trim();
  const aliasesInput = document.getElementById('newProductAliases').value.trim();

  if (!name) { showToast('Vui lòng nhập tên sản phẩm!', 'error'); return; }

  const campaignKey = store.getState().selectedSettingsCampaign;
  const newProduct = {
    name,
    spec,
    packaging,
    unit,
    box_size: boxSize,
    category: category || '',
    tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Tất cả' }],
    foc_rules: [],
    mkt_gift_rules: []
  };

  const ok = db.addProduct(campaignKey, newProduct);
  if (ok) {
    // Save custom aliases if input
    if (aliasesInput) {
      const parts = aliasesInput.split(',').map(s => s.trim()).filter(Boolean);
      parts.forEach(alias => {
        // Retrieve ID of product just added (which is at end of list)
        const campaign = db.data.campaigns[campaignKey];
        if (campaign) {
          const added = campaign.products[campaign.products.length - 1];
          if (added) db.addAlias(alias, added.id);
        }
      });
    }

    workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
    uiRenderer.renderSettingsEditor(campaignKey);
    closeModal();
    showToast(`Đã thêm sản phẩm: ${name}!`, 'success');
  } else {
    showToast('Lỗi khi thêm sản phẩm!', 'error');
  }
}

function closeModal() {
  const overlay = document.getElementById('modalOverlay');
  if (overlay) overlay.style.display = 'none';
}

// --- Import / Export Settings Database ---

function exportDatabase() {
  const jsonStr = db.exportJSON();
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = `order_automation_db_v4_${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  
  showToast('Đã xuất file database (JSON) thành công!', 'success');
}

function importDatabase(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    const ok = db.importJSON(e.target.result);
    if (ok) {
      workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
      
      // Reload active UI
      const campaignKey = store.getState().selectedSettingsCampaign;
      selectSettingsCampaign(campaignKey);
      
      showToast('Đã nhập database thành công!', 'success');
    } else {
      showToast('File JSON không hợp lệ hoặc cấu trúc không khớp!', 'error');
    }
  };
  reader.readAsText(file);
}

async function resetDatabase() {
  if (confirm('⚠️ Bạn có chắc chắn muốn RESET database về cấu hình chuẩn gốc? Toàn bộ các sản phẩm tạo thêm, alias tự thêm sẽ bị xoá vĩnh viễn!')) {
    await db.reset();
    workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
    
    const campaignKey = store.getState().selectedSettingsCampaign;
    selectSettingsCampaign(campaignKey);
    
    showToast('Đã reset database về mặc định chuẩn.', 'info');
  }
}

/**
 * Generate TLN (order summary) text.
 * Priority 1: dòng do AI CHIA CẮT THÀNH Ý (tlnLines) — CHỈ nhận khi kiểm tra
 *   đầy đủ pass (mọi dòng dán đều hiện diện trong output AI); thiếu dòng →
 *   fallback về dòng thô để KHÔNG BAO GIỜ mất thông tin.
 * Priority 2: raw chat lines verbatim — mọi dòng dán giữ nguyên văn.
 * Priority 3: Offline fallback — reconstruct from parsed data using rawProduct names.
 */
function generateTLNText(order) {
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

  // Kiểm tra bản chia cắt của AI có phủ ĐỦ mọi dòng user dán vào hay không
  const tlnCoversRawText = (aiLines, rawLines, customerName) => {
    if (rawLines.length === 0) return true;
    if (aiLines.length === 0) return false;
    const hay = norm([customerName || '', ...aiLines].join(' '));
    return rawLines.every(line => {
      const needle = norm(line);
      if (!needle) return true;
      return hay.includes(needle);
    });
  };

  // Ráp khối TLN: tên khách hàng đầu + nội dung + ghi chú điền tay (bỏ trùng)
  const assembleTlnLines = (bodyLines, customerName, orderNote) => {
    const custNorm = customerName ? norm(customerName) : '';
    const body = custNorm ? bodyLines.filter(l => norm(l) !== custNorm) : [...bodyLines];
    const lines = customerName ? [customerName, ...body] : body;
    if (orderNote) {
      const seen = new Set(lines.map(l => norm(l)));
      orderNote.split('\n').map(l => l.trim()).filter(Boolean).forEach(l => {
        const key = norm(l);
        if (seen.has(key)) return;
        seen.add(key);
        lines.push(l);
      });
    }
    return lines.join('\n');
  };

  const customerName = (document.getElementById('customerName')?.value || '').trim();
  const orderNote = (document.getElementById('orderNote')?.value || '').trim();

  // Nội dung dán: ưu tiên nội dung live trong ô tin nhắn; fallback rawChatText
  const liveText = (document.getElementById('orderText')?.value || '').trim();
  const rawText = liveText || String(order.rawChatText || '');
  const rawLines = rawText.split('\n').map(l => l.trim()).filter(Boolean);

  // Priority 1: bản chia cắt thành ý của AI (kiểm tra đầy đủ trên bản verbatim
  // trước sanitize vì sanitizer có thể viết lại dòng quà "FOC ...")
  const aiLines = Array.isArray(order.tlnLines)
    ? order.tlnLines.map(l => String(l).trim()).filter(Boolean)
    : (order.tlnLines ? [String(order.tlnLines).trim()].filter(Boolean) : []);
  if (aiLines.length > 0) {
    const verbatimLines = Array.isArray(order.tlnVerbatim)
      ? order.tlnVerbatim.map(l => String(l).trim()).filter(Boolean)
      : aiLines;
    if (tlnCoversRawText(verbatimLines, rawLines, customerName)) {
      return assembleTlnLines(aiLines, customerName, orderNote);
    }
    console.warn('[TLN] AI chia cắt thiếu dòng so với nội dung dán — fallback về dòng thô.');
  }

  // Priority 2: mọi dòng dán vào ô tin nhắn — giữ nguyên văn, chia từng dòng
  if (rawLines.length > 0) {
    return assembleTlnLines(rawLines, customerName, orderNote);
  }

  // Priority 3: Offline fallback — reconstruct from parsed data using rawProduct
  const lines = [];
  if (customerName) lines.push(customerName);

  // Đưa thông tin bổ sung (địa chỉ, SĐT, ghi chú...) từ salesComment vào TLN
  if (order.salesComment) {
    order.salesComment.split('\n').map(l => l.trim()).filter(Boolean).forEach(l => lines.push(l));
  }

  if (order.items && order.items.length > 0) {
    order.items.forEach(item => {
      const name = item.rawName || item.rawProduct || (item.product ? item.product.name : '');
      const qty = item.qty;
      const unit = item.unit || 'thùng';
      if (item.isGift) {
        lines.push(`FOC ${qty} ${unit} ${name}`);
      } else {
        lines.push(`${qty} ${unit} ${name}`);
      }
    });
  }

  const paymentSelect = document.getElementById('paymentMethod');
  const paymentLabel = paymentSelect ? paymentSelect.options[paymentSelect.selectedIndex].text : '';
  if (paymentLabel) lines.push(`TT ${paymentLabel}`);

  // Ghi chú thêm của Sales (tách mỗi dòng dặn dò thành 1 dòng trong Excel)
  if (orderNote) {
    const pushedCustNorm2 = customerName ? norm(customerName) : '';
    orderNote.split('\n').map(l => l.trim()).filter(Boolean).forEach(l => {
      if (pushedCustNorm2 && norm(l) === pushedCustNorm2) return; // trùng tên khách
      lines.push(l);
    });
  }

  return lines.join('\n');
}

async function exportToExcel() {
  // Quét lại nội dung tin nhắn trước khi xuất: user có thể đã bổ sung nội dung
  // vào ô tin nhắn sau lần phân tích cuối, nên cần parse lại để dữ liệu xuất
  // phản ánh đúng nội dung mới nhất.
  if (rescanOrderTextIfChanged()) {
    showToast('Đã quét lại nội dung tin nhắn trước khi xuất!', 'info');
  }

  const order = store.getState().currentOrder;
  const customerName = document.getElementById('customerName').value.trim();
  if (!customerName) {
    showToast('Vui lòng nhập tên khách hàng trước khi xuất Excel!', 'error');
    return;
  }

  if (!order.items || order.items.length === 0) {
    showToast('Đơn hàng không có sản phẩm nào để xuất!', 'error');
    return;
  }

  // Validate trước khi xuất (liệt kê dòng chưa khớp / giá 0đ / khớp yếu)
  const preRows = uiRenderer.getOrderTableRows(order).rows;
  const issues = validateOrderBeforeExport(preRows, customerName);
  if (!confirmExportIfIssues(issues, 'xuất Excel')) return;

  if (!window.electronAPI || !window.electronAPI.exportOrder) {
    showToast('Chức năng xuất Excel chỉ hoạt động trong ứng dụng Desktop (Electron)!', 'error');
    return;
  }

  const btnExportExcel = document.getElementById('btnExportExcel');
  if (!btnExportExcel) {
    showToast('Không tìm thấy nút xuất Excel!', 'error');
    return;
  }
  const originalHtml = btnExportExcel.innerHTML;
  btnExportExcel.disabled = true;
  btnExportExcel.innerHTML = `⏳ Đang xuất...`;

  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  const orderDate = `${dd}/${mm}/${yyyy}`;

  const { rows } = uiRenderer.getOrderTableRows(order);

  // Group items by campaign brand
  const groups = {};
  rows.forEach(row => {
    let productObj = null;
    let campaignKey = null;
    
    if (row.type === 'matched' || row.type === 'unmatched') {
      productObj = row.product;
    } else if (row.type === 'gift') {
      if (row.productId) {
        productObj = db.findProductById(row.productId);
      }
      if (!productObj && row.name) {
        const allProds = db.getAllProducts();
        productObj = allProds.find(p => p.name === row.name);
      }
    }
    
    if (productObj && productObj.campaignKey) {
      campaignKey = productObj.campaignKey;
    } else if (order.aiResult && order.aiResult.primaryCampaign) {
      campaignKey = order.aiResult.primaryCampaign;
    }
    
    let brand = 'zentor'; // default
    if (campaignKey) {
      const camp = db.data.campaigns[campaignKey];
      if (camp && camp.brand) {
        brand = camp.brand;
      } else {
        brand = campaignKey; // Fallback to campaign key name
      }
    }
    
    if (!groups[brand]) groups[brand] = [];
    groups[brand].push({ row, productObj });
  });

  const brands = Object.keys(groups);
  let successCount = 0;
  let errors = [];
  let exportedPaths = [];
  const payloadByBrand = {}; // Store payloads for AI retry

  // Merge duplicate FOC rows within each brand (same product + unit → sum qty)
  for (const brand of brands) {
    const merged = [];
    const focMap = new Map(); // key: "productName|unit" → merged entry index

    for (const entry of groups[brand]) {
      if (entry.row.type === 'gift') {
        const prodName = entry.row.name || '';
        const unit = entry.row.unit || '';
        const key = `${prodName}|${unit}`;

        if (focMap.has(key)) {
          // Sum quantity into existing entry
          merged[focMap.get(key)].row.qty += entry.row.qty;
        } else {
          focMap.set(key, merged.length);
          merged.push(entry);
        }
      } else {
        merged.push(entry);
      }
    }
    groups[brand] = merged;
  }

  // Generate standardized TLN text from structured order data
  const tlnText = generateTLNText(order);

  // Get seller info for title generation
  const sellerName = document.getElementById('sellerName')?.value || '';
  const sellers = getSellers();
  const selectedSeller = sellers.find(s => s.name === sellerName);
  const discount = selectedSeller?.discount || '';

  for (const brand of brands) {
    // Generate order title for this brand
    const orderTitle = generateOrderTitle(brand, sellerName, discount);
    
    const payload = {
      brand,
      customerName,
      orderDate,
      orderTitle,
      tlnText,
      items: groups[brand].map(({ row, productObj }) => {
        const isGift = row.type === 'gift';
        let rawProduct = '';
        if (row.type === 'gift') {
          rawProduct = row.name;
        } else {
          rawProduct = row.product ? row.product.name : (row.rawName || row.rawProduct || '');
        }
        
        let unitPrice = 0;
        if (!isGift) {
          unitPrice = row.bottlePrice || 0;
        } else if (productObj && productObj.tiers && productObj.tiers.length > 0) {
          const validPrices = productObj.tiers
            .map(t => t.price)
            .filter(p => typeof p === 'number' && p > 0);
          if (validPrices.length > 0) {
            unitPrice = Math.min(...validPrices);
          }
        }
        
        return {
          rawProduct: rawProduct,
          qty: row.qty,
          unit: row.unit,
          product: productObj ? {
            name: productObj.name,
            spec: productObj.spec,
            category: productObj.category,
            box_size: productObj.box_size,
            tiers: productObj.tiers
          } : null,
          unitPrice: unitPrice,
          isGift: isGift,
          focSource: isGift ? (productObj ? 'campaign' : 'manual') : null
        };
      })
    };

    payloadByBrand[brand] = payload;

    try {
      // Electron mode: use IPC (no HTTP server needed)
      const result = await window.electronAPI.exportOrder(payload);
      if (result.success) {
        successCount++;
        exportedPaths.push({ brand, filePath: result.filePath, created: result.created, opened: result.opened, wasOpenInExcel: result.wasOpenInExcel });
      } else {
        errors.push(`${brand.toUpperCase()}: ${result.error || 'Lỗi không xác định'}`);
      }
    } catch (err) {
      errors.push(`${brand.toUpperCase()}: Lỗi IPC Excel export`);
    }
  }

  btnExportExcel.disabled = false;
  btnExportExcel.innerHTML = originalHtml;

  if (errors.length > 0) {
    // AI-assisted resolution: detect file-resolution errors and ask AI for help
    const resolutionErrors = errors.filter(e =>
      e.includes('Không nhận diện') || e.includes('Không tìm thấy') ||
      e.includes('vui lòng tạo') || e.includes('Vui lòng tạo') ||
      e.includes('Chưa có file')
    );

    if (resolutionErrors.length > 0 && window.electronAPI.diagnoseExcel) {
      const errBrand = resolutionErrors[0].split(':')[0].trim().toLowerCase();
      const retryPayload = payloadByBrand[errBrand];
      const aiFix = await aiDiagnoseExportError(errBrand, orderDate, resolutionErrors[0]);
      if (aiFix && aiFix.resolved && retryPayload) {
        showToast(`✅ AI: ${aiFix.explanation}`, 'success');
        try {
          const retryResult = await window.electronAPI.exportOrder(retryPayload);
          if (retryResult && retryResult.success) {
            successCount++;
            exportedPaths.push({ brand: errBrand, filePath: retryResult.filePath, created: false, opened: retryResult.opened });
            errors = errors.filter(e => !e.startsWith(errBrand.toUpperCase()));
          }
        } catch (e) { /* retry failed silently */ }
      }
    }
  }

  if (errors.length > 0) {
    const pathLines = exportedPaths.map(p => `${p.brand.toUpperCase()}: ${p.filePath}${p.created ? ' (đã tạo file tháng mới)' : ''}`);
    alert(`Đã xuất ${successCount}/${brands.length} hãng thành công.`
      + (pathLines.length ? `\n\nĐã xuất tại:\n` + pathLines.join('\n') : '')
      + `\n\nGặp các lỗi sau:\n` + errors.join('\n'));
    showToast('Xuất Excel có lỗi!', 'error');
  } else if (exportedPaths.length === 1) {
    const p = exportedPaths[0];
    const openNote = p.opened === false ? '\n⚠️ Không tự mở được file — vui lòng mở thủ công.' : '';
    const reopenNote = p.wasOpenInExcel ? '\n📂 File đang mở đã được tự đóng & mở lại sau khi xuất.' : '';
    showToast(`Đã xuất Excel tại: ${p.filePath}${p.created ? ' (đã tạo file tháng mới)' : ''}${reopenNote}${openNote}`, 'success');
  } else {
    const lines = exportedPaths.map(p => `${p.brand.toUpperCase()}: ${p.filePath}${p.created ? ' (đã tạo file tháng mới)' : ''}${p.wasOpenInExcel ? ' — 📂 đã tự đóng/mở lại' : ''}${p.opened === false ? ' — ⚠️ không tự mở được' : ''}`);
    showToast(`Đã xuất Excel tại:\n` + lines.join('\n'), 'success');
  }
}

// =========================================================================
//  AI-ASSISTED FILE RESOLUTION (fallback when rule-based resolution fails)
// =========================================================================

/**
 * When rule-based file resolution fails, ask AI to analyze the directory
 * structure and suggest which file to use (or what to rename).
 * Returns { resolved, filePath, explanation } or null.
 */
async function aiDiagnoseExportError(brand, orderDate, errorMsg) {
  try {
    showToast('🤖 Đang dùng AI phân tích cấu trúc thư mục...', 'info');

    // 1. Gather directory context from main process
    const context = await window.electronAPI.diagnoseExcel({ brand, orderDate });
    if (context.error) {
      console.warn('[AI Diagnose] Context error:', context.error);
      return null;
    }

    // 2. Build compact directory tree description
    const treeLines = [];
    for (const node of context.tree) {
      if (node.type === 'file') {
        treeLines.push(`  [FILE] ${node.name}`);
        continue;
      }
      treeLines.push(`[DIR] ${node.name}/`);
      if (node.children) {
        for (const child of node.children) {
          if (child.type === 'file') {
            treeLines.push(`  [FILE] ${child.name}`);
          } else if (child.type === 'dir') {
            const fileList = (child.files || [])
              .filter(f => f.ext === '.xlsx' || f.ext === '.xls')
              .map(f => f.name).join(', ');
            treeLines.push(`  [DIR] ${child.name}/ → ${fileList || '(trống)'}`);
          }
        }
      }
    }
    const treeDesc = treeLines.join('\n');

    // 3. Build AI prompt
    const systemPrompt = 'Bạn là trợ lý AI chuyên phân tích cấu trúc thư mục và file Excel. Trả về DUY NHẤT một JSON object hợp lệ, không kèm giải thích hay markdown.';
    const userPrompt = `Bạn là trợ lý AI giúp xác định file Excel đơn hàng đúng cho hãng "${context.brand}".

Ngày đơn hàng: ${context.orderDate} (tháng ${context.targetMonth}, năm ${context.targetYear})
Lỗi hệ thống: "${errorMsg}"

Cấu trúc thư mục:
${treeDesc}

Nhiệm vụ: Xác định file Excel phù hợp nhất để ghi đơn hàng tháng ${context.targetMonth}/${context.targetYear}.
Quy tắc:
- File .xlsx hoặc .xls, bỏ qua file chứa "backup", "copy", "template"
- Ưu tiên file có tháng/năm khớp tháng ${context.targetMonth}
- Nếu không có → tìm file tháng gần nhất trước đó để đổi tên

Trả về JSON:
{"action":"use_file"|"rename_file","filePath":"đường dẫn đầy đủ","newName":"tên mới nếu rename","explanation":"giải thích tiếng Việt"}`;

    // 4. Call AI
    const aiResult = await aiService.callAICustom(userPrompt, systemPrompt);
    if (!aiResult || !aiResult.action) {
      console.warn('[AI Diagnose] No actionable result:', aiResult);
      return null;
    }

    // 5. Apply fix via IPC (include brand/year/month for caching)
    const parsed = orderDate.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
    const fixPayload = { ...aiResult, brand, year: parsed ? parseInt(parsed[3]) : null, month: parsed ? parseInt(parsed[2]) : null };
    const fixResult = await window.electronAPI.applyExcelFix(fixPayload);
    if (fixResult.error) {
      showToast(`⚠️ AI đề xuất nhưng không áp dụng được: ${fixResult.error}`, 'error');
      return null;
    }

    return {
      resolved: true,
      filePath: fixResult.filePath,
      explanation: aiResult.explanation || `Đã dùng file: ${fixResult.filePath}`
    };
  } catch (err) {
    console.warn('[AI Diagnose] Failed:', err.message);
    return null;
  }
}

// =========================================================================
//  SELLER MANAGEMENT & ORDER TITLE GENERATION
// =========================================================================

// Default brand prefix mapping
const DEFAULT_BRAND_PREFIXES = {
  zentor: 'ZNTSG',
  xvil: 'XVIL',
  veltron: 'VELTRON',
  torvex: 'TORVEX'
};

// Get configurable brand prefixes (from localStorage, fallback to defaults)
function getBrandPrefixes() {
  try {
    const data = localStorage.getItem('brandPrefixes');
    if (data) {
      return JSON.parse(data);
    }
  } catch (e) {
    // ignore
  }
  return { ...DEFAULT_BRAND_PREFIXES };
}

// Save brand prefixes to localStorage
function saveBrandPrefixes(prefixes) {
  localStorage.setItem('brandPrefixes', JSON.stringify(prefixes));
}

// Seller storage (persisted via db layer → IndexedDB + localStorage)
function getSellers() {
  return db.getSellers();
}

function saveSellers(sellers) {
  db.saveSellers(sellers);
}

// Generate order title: {PREFIX}{YY}{MM}-{sequence}-{Seller name}-{discount}
function generateOrderTitle(brand, sellerName, discount) {
  const prefixes = getBrandPrefixes();
  const prefix = prefixes[brand.toLowerCase()] || brand.toUpperCase();
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  
  // Get sequence number from localStorage (per brand per month)
  const seqKey = `orderSeq_${prefix}_${yy}${mm}`;
  let seq = parseInt(localStorage.getItem(seqKey) || '0') + 1;
  localStorage.setItem(seqKey, String(seq));
  
  const seqStr = String(seq).padStart(2, '0');
  
  let formatStr = localStorage.getItem('titleFormat') || '{PREFIX}{YY}{MM}-{sequence}-{Người nhận đặt}-{Chiết khấu}';
  let title = formatStr
    .replace('{PREFIX}', prefix)
    .replace('{YY}', yy)
    .replace('{MM}', mm)
    .replace('{sequence}', seqStr);

  if (sellerName) {
     title = title.replace('{Người nhận đặt}', sellerName);
  } else {
     title = title.replace(/\s*-\s*{Người nhận đặt}/, '');
     title = title.replace(/{Người nhận đặt}\s*-\s*/, '');
     title = title.replace(/{Người nhận đặt}/, '');
  }

  if (discount) {
     title = title.replace('{Chiết khấu}', discount);
  } else {
     title = title.replace(/\s*-\s*{Chiết khấu}/, '');
     title = title.replace(/{Chiết khấu}\s*-\s*/, '');
     title = title.replace(/{Chiết khấu}/, '');
  }
  
  return title;
}

// Populate seller dropdown
function populateSellerDropdown() {
  const select = document.getElementById('sellerName');
  if (!select) return;
  
  const sellers = getSellers();
  const currentValue = select.value;
  
  // Clear existing options (keep first placeholder)
  select.innerHTML = '<option value="">-- Chọn người nhận đặt --</option>';
  
  sellers.forEach(seller => {
    const option = document.createElement('option');
    option.value = seller.name;
    option.textContent = seller.name;
    if (seller.discount) {
      option.textContent += ` (${seller.discount})`;
    }
    select.appendChild(option);
  });
  
  // Restore previous selection if exists
  if (currentValue) {
    select.value = currentValue;
  }
}

// Sort sellers by name (Vietnamese-aware, groups same-name entries together)
window.sortSellersByName = function() {
  const sellers = getSellers();
  sellers.sort((a, b) => {
    const nameA = (a.name || '').toLowerCase();
    const nameB = (b.name || '').toLowerCase();
    const cmp = nameA.localeCompare(nameB, 'vi', { sensitivity: 'base' });
    if (cmp !== 0) return cmp;
    // Same name → sort by discount to keep group stable
    return (a.discount || '').localeCompare(b.discount || '', 'vi', { sensitivity: 'base' });
  });
  saveSellers(sellers);
  populateSellerDropdown();
  openSellerManager(); // Refresh modal
  showToast('Đã sắp xếp theo tên!', 'success');
};

// Move seller up/down in the list
window.moveSeller = function(index, direction) {
  const sellers = getSellers();
  const target = index + direction;
  if (target < 0 || target >= sellers.length) return;
  [sellers[index], sellers[target]] = [sellers[target], sellers[index]];
  saveSellers(sellers);
  populateSellerDropdown();
  openSellerManager(); // Refresh modal
};

// Open seller management modal
function openSellerManager() {
  const sellers = getSellers();
  
  const modalTitle = document.getElementById('modalTitle');
  const modalBody = document.getElementById('modalBody');
  
  if (modalTitle) modalTitle.textContent = '️ Quản lý Người nhận đặt';
  
  if (modalBody) {
    modalBody.innerHTML = `
      <div style="margin-bottom: 16px;">
        <div style="display: flex; gap: 8px; margin-bottom: 12px;">
          <input type="text" id="newSellerName" placeholder="Tên hiển thị (VD: Nguyễn Văn B)" 
            style="flex: 1; padding: 8px 12px; background: var(--bg-tertiary); border: 1px solid var(--border-primary); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 0.9rem;">
          <input type="text" id="newSellerKvName" placeholder="Tên trên KiotViet (VD: Nguyễn Văn B)" 
            style="flex: 1; padding: 8px 12px; background: var(--bg-tertiary); border: 1px solid var(--border-primary); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 0.9rem;">
          <input type="text" id="newSellerDiscount" placeholder="Chiết khấu (VD: CH-3%)" 
            style="width: 130px; padding: 8px 12px; background: var(--bg-tertiary); border: 1px solid var(--border-primary); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 0.9rem;">
          <button id="btnAddSeller" style="padding: 8px 16px; background: var(--accent-green); border: none; border-radius: var(--radius-sm); color: white; cursor: pointer; font-size: 0.85rem;"> Thêm</button>
        </div>
        <p style="font-size: 0.75rem; color: var(--text-secondary); margin: -6px 0 10px 2px;">💡 "Tên trên KiotViet" = tên chính xác trong dropdown "Người nhận đặt" trên KiotViet. Để trống nếu trùng tên hiển thị.</p>
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
          <button id="btnSortSellers" style="padding: 6px 14px; background: var(--accent-blue, #3b82f6); border: none; border-radius: var(--radius-sm); color: white; cursor: pointer; font-size: 0.8rem;">🔤 Sắp xếp theo tên</button>
          <span style="font-size: 0.75rem; color: var(--text-secondary);">Dùng ↑↓ để tự sắp xếp vị trí</span>
        </div>
      </div>
      <div id="sellerList" style="max-height: 400px; overflow-y: auto;">
        ${sellers.length === 0 ? '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Chưa có người nhận đặt nào</p>' : ''}
        ${sellers.map((seller, index) => `
          <div style="display: flex; align-items: center; gap: 8px; padding: 10px; background: var(--bg-tertiary); border-radius: var(--radius-sm); margin-bottom: 8px;">
            <div style="display: flex; flex-direction: column; gap: 2px;">
              <button onclick="moveSeller(${index}, -1)" ${index === 0 ? 'disabled' : ''} style="padding: 2px 6px; background: ${index === 0 ? 'transparent' : 'var(--bg-secondary)'}; border: 1px solid var(--border-primary); border-radius: 4px; color: ${index === 0 ? 'var(--text-secondary)' : 'var(--text-primary)'}; cursor: ${index === 0 ? 'default' : 'pointer'}; font-size: 0.7rem; line-height: 1; opacity: ${index === 0 ? '0.4' : '1'};">▲</button>
              <button onclick="moveSeller(${index}, 1)" ${index === sellers.length - 1 ? 'disabled' : ''} style="padding: 2px 6px; background: ${index === sellers.length - 1 ? 'transparent' : 'var(--bg-secondary)'}; border: 1px solid var(--border-primary); border-radius: 4px; color: ${index === sellers.length - 1 ? 'var(--text-secondary)' : 'var(--text-primary)'}; cursor: ${index === sellers.length - 1 ? 'default' : 'pointer'}; font-size: 0.7rem; line-height: 1; opacity: ${index === sellers.length - 1 ? '0.4' : '1'};">▼</button>
            </div>
            <div style="flex: 1;">
              <div style="font-weight: 500; color: var(--text-primary);">${escapeHtml(seller.name)}</div>
              ${seller.kvName ? `<div style="font-size: 0.8rem; color: var(--accent-blue, #3b82f6);">KV: ${escapeHtml(seller.kvName)}</div>` : ''}
              ${seller.discount ? `<div style="font-size: 0.85rem; color: var(--text-secondary);">Chiết khấu: ${escapeHtml(seller.discount)}</div>` : ''}
            </div>
            <button onclick="editSeller(${index})" style="padding: 6px 12px; background: var(--accent-yellow); border: none; border-radius: var(--radius-sm); color: white; cursor: pointer; font-size: 0.8rem;">✏️ Sửa</button>
            <button onclick="deleteSeller(${index})" style="padding: 6px 12px; background: var(--accent-red); border: none; border-radius: var(--radius-sm); color: white; cursor: pointer; font-size: 0.8rem;">🗑️ Xóa</button>
          </div>
        `).join('')}
      </div>
    `;
    
    // Bind add button
    const btnAdd = document.getElementById('btnAddSeller');
    if (btnAdd) {
      btnAdd.onclick = () => {
        const nameInput = document.getElementById('newSellerName');
        const kvNameInput = document.getElementById('newSellerKvName');
        const discountInput = document.getElementById('newSellerDiscount');
        const name = nameInput?.value?.trim();
        const kvName = kvNameInput?.value?.trim();
        const discount = discountInput?.value?.trim();
        
        if (!name) {
          showToast('Vui lòng nhập tên người nhận đặt!', 'error');
          return;
        }
        
        const sellers = getSellers();
        sellers.push({ name, kvName: kvName || '', discount: discount || '' });
        saveSellers(sellers);
        
        populateSellerDropdown();
        openSellerManager(); // Refresh modal
        showToast(`Đã thêm "${name}" thành công!`, 'success');
      };
    }
    
    // Bind sort button
    const btnSort = document.getElementById('btnSortSellers');
    if (btnSort) {
      btnSort.onclick = () => window.sortSellersByName();
    }
  }
  
  const modalOverlay = document.getElementById('modalOverlay');
  if (modalOverlay) modalOverlay.style.display = 'flex';
}

// Edit seller (inline form — prompt() không hoạt động trong Electron)
window.editSeller = function(index) {
  const sellers = getSellers();
  const seller = sellers[index];
  if (!seller) return;

  // Replace the seller row with an inline edit form
  const sellerList = document.getElementById('sellerList');
  if (!sellerList) return;
  const rows = sellerList.children;
  const rowEl = rows[index] || rows[index + (sellers.length === 0 ? 1 : 0)];
  if (!rowEl) return;

  rowEl.outerHTML = `
    <div id="editSellerRow_${index}" style="padding: 12px; background: var(--bg-tertiary); border: 1px solid var(--accent-yellow); border-radius: var(--radius-sm); margin-bottom: 8px;">
      <div style="display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap;">
        <input type="text" id="editSellerName_${index}" value="${escapeHtml(seller.name)}" placeholder="Tên hiển thị"
          style="flex: 1; min-width: 140px; padding: 8px 12px; background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 0.9rem;">
        <input type="text" id="editSellerKvName_${index}" value="${escapeHtml(seller.kvName || '')}" placeholder="Tên trên KiotViet"
          style="flex: 1; min-width: 140px; padding: 8px 12px; background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 0.9rem;">
        <input type="text" id="editSellerDiscount_${index}" value="${escapeHtml(seller.discount || '')}" placeholder="Chiết khấu"
          style="width: 130px; padding: 8px 12px; background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 0.9rem;">
      </div>
      <div style="display: flex; gap: 8px;">
        <button id="btnSaveSeller_${index}" style="padding: 6px 16px; background: var(--accent-green); border: none; border-radius: var(--radius-sm); color: white; cursor: pointer; font-size: 0.85rem;">💾 Lưu</button>
        <button id="btnCancelSeller_${index}" style="padding: 6px 16px; background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: var(--radius-sm); color: var(--text-primary); cursor: pointer; font-size: 0.85rem;">✖ Hủy</button>
      </div>
    </div>
  `;

  // Focus the name input
  const nameInput = document.getElementById(`editSellerName_${index}`);
  if (nameInput) { nameInput.focus(); nameInput.select(); }

  // Save handler
  const btnSave = document.getElementById(`btnSaveSeller_${index}`);
  if (btnSave) {
    btnSave.onclick = () => {
      const newName = (document.getElementById(`editSellerName_${index}`)?.value || '').trim();
      const newKvName = (document.getElementById(`editSellerKvName_${index}`)?.value || '').trim();
      const newDiscount = (document.getElementById(`editSellerDiscount_${index}`)?.value || '').trim();
      if (!newName) {
        showToast('Tên không được để trống!', 'error');
        return;
      }
      const allSellers = getSellers();
      allSellers[index] = { name: newName, kvName: newKvName, discount: newDiscount };
      saveSellers(allSellers);
      populateSellerDropdown();
      openSellerManager();
      showToast('Đã cập nhật thành công!', 'success');
    };
  }

  // Cancel handler
  const btnCancel = document.getElementById(`btnCancelSeller_${index}`);
  if (btnCancel) {
    btnCancel.onclick = () => openSellerManager();
  }

  // Allow Enter to save, Escape to cancel
  const editRow = document.getElementById(`editSellerRow_${index}`);
  if (editRow) {
    editRow.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); btnSave?.click(); }
      if (e.key === 'Escape') { e.preventDefault(); openSellerManager(); }
    });
  }
};

// Delete seller
window.deleteSeller = function(index) {
  const sellers = getSellers();
  const seller = sellers[index];
  if (!seller) return;
  
  if (!confirm(`Bạn có chắc muốn xóa "${seller.name}"?`)) return;
  
  sellers.splice(index, 1);
  saveSellers(sellers);
  
  populateSellerDropdown();
  openSellerManager(); // Refresh modal
  showToast(`Đã xóa "${seller.name}"!`, 'success');
};

// =========================================================================
//  PREFIX MANAGEMENT UI
// =========================================================================

// Render prefix config list in settings panel
function renderPrefixConfigList() {
  const container = document.getElementById('prefixConfigList');
  if (!container) return;
  
  const prefixes = getBrandPrefixes();
  const brands = Object.keys(prefixes);
  
  if (brands.length === 0) {
    container.innerHTML = '<p style="color: var(--text-secondary); text-align: center; padding: 20px;">Chưa có prefix nào được cấu hình</p>';
    return;
  }
  
  container.innerHTML = brands.map(brand => `
    <div style="display: flex; align-items: center; gap: 12px; padding: 12px; background: var(--bg-tertiary); border-radius: var(--radius-sm);">
      <div style="flex: 1;">
        <div style="font-weight: 500; color: var(--text-primary); text-transform: capitalize;">${escapeHtml(brand)}</div>
      </div>
      <input type="text" 
        value="${escapeHtml(prefixes[brand])}" 
        data-brand="${escapeHtml(brand)}"
        class="prefix-input"
        placeholder="Prefix"
        style="width: 150px; padding: 8px 12px; background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 0.9rem; font-family: monospace;">
      <button onclick="updateBrandPrefix('${escapeHtml(brand)}')" 
        style="padding: 8px 16px; background: var(--accent-green); border: none; border-radius: var(--radius-sm); color: white; cursor: pointer; font-size: 0.85rem;">💾 Lưu</button>
      <button onclick="deleteBrandPrefix('${escapeHtml(brand)}')" 
        style="padding: 8px 12px; background: var(--accent-red); border: none; border-radius: var(--radius-sm); color: white; cursor: pointer; font-size: 0.85rem;">🗑️</button>
    </div>
  `).join('');
}

// Update brand prefix
window.updateBrandPrefix = function(brand) {
  const input = document.querySelector(`.prefix-input[data-brand="${brand}"]`);
  if (!input) return;
  
  const newPrefix = input.value.trim();
  if (!newPrefix) {
    showToast('Prefix không được để trống!', 'error');
    return;
  }
  
  const prefixes = getBrandPrefixes();
  prefixes[brand] = newPrefix;
  saveBrandPrefixes(prefixes);
  
  showToast(`Đã cập nhật prefix cho "${brand}": ${newPrefix}`, 'success');
};

// Delete brand prefix
window.deleteBrandPrefix = function(brand) {
  if (!confirm(`Bạn có chắc muốn xóa prefix của "${brand}"?`)) return;
  
  const prefixes = getBrandPrefixes();
  delete prefixes[brand];
  saveBrandPrefixes(prefixes);
  
  renderPrefixConfigList();
  renderSequenceResetList();
  showToast(`Đã xóa prefix của "${brand}"!`, 'success');
};

// Add new brand prefix
function addBrandPrefix() {
  const brand = prompt('Nhập tên loại hàng (chữ thường, không dấu, VD: zentor, xvil):');
  if (!brand) return;
  
  const cleanBrand = brand.toLowerCase().trim();
  if (!cleanBrand) {
    showToast('Tên loại hàng không hợp lệ!', 'error');
    return;
  }
  
  const prefixes = getBrandPrefixes();
  if (prefixes[cleanBrand]) {
    if (!confirm(`Loại hàng "${cleanBrand}" đã tồn tại. Bạn có muốn cập nhật prefix?`)) return;
  }
  
  const prefix = prompt(`Nhập prefix cho "${cleanBrand}":`, DEFAULT_BRAND_PREFIXES[cleanBrand] || '');
  if (prefix === null) return; // Cancelled
  
  const cleanPrefix = prefix.trim();
  if (!cleanPrefix) {
    showToast('Prefix không được để trống!', 'error');
    return;
  }
  
  prefixes[cleanBrand] = cleanPrefix;
  saveBrandPrefixes(prefixes);
  
  renderPrefixConfigList();
  renderSequenceResetList();
  showToast(`Đã thêm prefix cho "${cleanBrand}": ${cleanPrefix}`, 'success');
}

// Reset all prefixes to defaults
function resetPrefixesToDefault() {
  if (!confirm('Bạn có chắc muốn khôi phục tất cả prefix về mặc định?')) return;
  
  saveBrandPrefixes({ ...DEFAULT_BRAND_PREFIXES });
  renderPrefixConfigList();
  renderSequenceResetList();
  showToast('Đã khôi phục prefix mặc định!', 'success');
}

// Render sequence reset list
function renderSequenceResetList() {
  const container = document.getElementById('sequenceResetList');
  if (!container) return;
  
  const prefixes = getBrandPrefixes();
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  
  const brands = Object.keys(prefixes);
  
  if (brands.length === 0) {
    container.innerHTML = '<p style="color: var(--text-secondary); text-align: center; padding: 20px;">Chưa có loại hàng nào</p>';
    return;
  }
  
  container.innerHTML = brands.map(brand => {
    const prefix = prefixes[brand];
    const seqKey = `orderSeq_${prefix}_${yy}${mm}`;
    const currentSeq = localStorage.getItem(seqKey) || '0';
    
    return `
      <div style="display: flex; align-items: center; gap: 12px; padding: 10px; background: var(--bg-tertiary); border-radius: var(--radius-sm);">
        <div style="flex: 1;">
          <div style="font-weight: 500; color: var(--text-primary); text-transform: capitalize;">${escapeHtml(brand)}</div>
          <div style="font-size: 0.85rem; color: var(--text-secondary);">STT hiện tại: <strong>${currentSeq}</strong> — đơn tiếp theo: <strong>${String(Number(currentSeq) + 1).padStart(2, '0')}</strong></div>
        </div>
        <div style="display: flex; align-items: center; gap: 6px;">
          <input type="number" id="seqInput_${escapeHtml(brand)}" value="${currentSeq}" min="0" style="width: 60px; padding: 5px 8px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--bg-primary); color: var(--text-primary); font-size: 0.85rem; text-align: center;">
          <button onclick="setBrandSequence('${escapeHtml(brand)}')" 
            style="padding: 6px 12px; background: var(--accent-yellow); border: none; border-radius: var(--radius-sm); color: white; cursor: pointer; font-size: 0.8rem;">✏️ Đặt STT</button>
        </div>
      </div>
    `;
  }).join('');
}

// Set sequence for a specific brand to a custom value
window.setBrandSequence = function(brand) {
  const prefixes = getBrandPrefixes();
  const prefix = prefixes[brand];
  if (!prefix) return;
  
  const input = document.getElementById(`seqInput_${brand}`);
  const val = parseInt(input?.value);
  if (isNaN(val) || val < 0) {
    showToast('Số không hợp lệ!', 'error');
    return;
  }
  
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const seqKey = `orderSeq_${prefix}_${yy}${mm}`;
  
  localStorage.setItem(seqKey, String(val));
  renderSequenceResetList();
  showToast(`Đã đặt STT của "${brand}" = ${val}. Đơn tiếp theo sẽ là ${String(val + 1).padStart(2, '0')}.`, 'success');
};

// --- Global UI Listeners Binding ---

/**
 * Updates the sidebar footer status indicators (AI mode + product count).
 */
function updateSidebarStatus() {
  const countEl = document.getElementById('sidebarProductCount');
  if (countEl) {
    const total = (db.getAllProducts() || []).length;
    countEl.textContent = total > 0 ? total : '—';
  }
  // AI status is now managed by initAiProfileManager's render()
  // Only update here as fallback if profile manager hasn't rendered yet
  const aiStatusEl = document.getElementById('sidebarAiStatus');
  const aiDotEl = document.getElementById('sidebarAiDot');
  if (aiStatusEl && !aiStatusEl.dataset.managed) {
    aiService.getProfiles().then(({ profiles }) => {
      const enabled = profiles.filter(p => p.enabled);
      if (enabled.length === 0) {
        aiStatusEl.textContent = 'Offline';
        if (aiDotEl) aiDotEl.className = 'status-dot';
      } else {
        aiStatusEl.textContent = enabled.length === 1 ? (enabled[0].provider === 'gemini' ? 'Gemini' : enabled[0].provider === 'openai' ? 'OpenAI' : enabled[0].provider === 'lmstudio' ? 'LM Studio' : 'Custom') : `${enabled.length} AI`;
        if (aiDotEl) aiDotEl.className = 'status-dot ai';
      }
    });
  }
}

function bindGlobalUIListeners() {
  // --- Catalog search: static input, bound ONCE (never destroyed by re-renders) ---
  const catalogSearchInput = document.getElementById('catalogSearchInput');
  if (catalogSearchInput) {
    catalogSearchInput.addEventListener('input', function() {
      uiRenderer._catalogSearch = this.value;
      const clearBtn = document.getElementById('catalogSearchClear');
      if (clearBtn) clearBtn.style.display = this.value ? '' : 'none';
      clearTimeout(window._catalogSearchTimer);
      window._catalogSearchTimer = setTimeout(() => {
        const curFilter = (document.getElementById('catalogCampaignFilter') || {}).value || 'all';
        uiRenderer.renderCatalog(curFilter);
      }, 300);
    });
  }
  const catalogSearchClear = document.getElementById('catalogSearchClear');
  if (catalogSearchClear) {
    catalogSearchClear.addEventListener('click', function() {
      const el = document.getElementById('catalogSearchInput');
      if (el) { el.value = ''; el.focus(); }
      uiRenderer._catalogSearch = '';
      this.style.display = 'none';
      clearTimeout(window._catalogSearchTimer);
      const curFilter = (document.getElementById('catalogCampaignFilter') || {}).value || 'all';
      uiRenderer.renderCatalog(curFilter);
    });
  }

  // --- Settings Sub-tabs click handlers ---
  document.querySelectorAll('.settings-subtab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      switchSettingsSubTab(btn.getAttribute('data-subtab'));
    });
  });

  // --- Tab Switch Navigation ---
  const navTabs = document.querySelectorAll('.nav-tab');
  navTabs.forEach(tab => {
    tab.onclick = () => {
      navTabs.forEach(t => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));

      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      const tabName = tab.getAttribute('data-tab');
      let targetPanelId = 'panelOrder';
      if (tabName === 'catalog' || tab.id === 'tabCatalog') targetPanelId = 'panelCatalog';
      else if (tabName === 'settings' || tab.id === 'tabSettings') targetPanelId = 'panelSettings';

      const targetPanel = document.getElementById(targetPanelId);
      if (targetPanel) targetPanel.classList.add('active');

      if (targetPanelId === 'panelCatalog') {
        // Only re-render catalog if data has changed since last render
        if (window._catalogNeedsRender !== false) {
          const curFilter = (document.getElementById('catalogCampaignFilter') || {}).value || 'all';
          uiRenderer.renderCatalog(curFilter);
          window._catalogNeedsRender = false;
        }
      } else if (targetPanelId === 'panelSettings') {
        // Only re-render settings if data has changed since last render
        if (window._settingsNeedsRender !== false) {
          const campaignKey = store.getState().selectedSettingsCampaign || Object.keys(db.data.campaigns || {})[0];
          selectSettingsCampaign(campaignKey);
          window._settingsNeedsRender = false;
        }
      } else if (targetPanelId === 'panelOrder') {
        // Re-render order panel if state changed while on another tab
        if (window._orderNeedsRender === true) {
          uiRenderer.renderOrderResults(store.getState().currentOrder);
          renderCustomPromos();
          window._orderNeedsRender = false;
        }
      }
    };
  });

  // --- Keyboard shortcut: Ctrl+Enter to parse ---
  const orderTextarea = document.getElementById('orderText');
  if (orderTextarea) {
    orderTextarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        parseOrder();
      }
    });

    // Auto-expand the textarea as the user types/pastes so long order
    // lines (product names, PO numbers) stay readable; beyond the cap
    // the box keeps a visible internal scrollbar.
    orderTextarea.addEventListener('input', autoGrowOrderText);
    autoGrowOrderText();
  }

  // Order main panel buttons
  const btnParse = document.getElementById('btnParse');
  if (btnParse) btnParse.onclick = () => parseOrder();

  const btnCopy = document.getElementById('btnCopy');
  if (btnCopy) btnCopy.onclick = () => copySummary();

  const btnExportExcel = document.getElementById('btnExportExcel');
  if (btnExportExcel) btnExportExcel.onclick = () => exportToExcel();

  const btnClearOrder = document.getElementById('btnClear') || document.getElementById('btnClearOrder');
  if (btnClearOrder) btnClearOrder.onclick = () => clearOrder();

  const btnSampleOrder = document.getElementById('btnSample') || document.getElementById('btnSampleOrder');
  if (btnSampleOrder) btnSampleOrder.onclick = () => loadSampleOrder();

  // Seller management button
  const btnManageSellers = document.getElementById('btnManageSellers');
  if (btnManageSellers) btnManageSellers.onclick = () => openSellerManager();

  // Prefix management buttons
  const btnAddPrefix = document.getElementById('btnAddPrefix');
  if (btnAddPrefix) btnAddPrefix.onclick = () => addBrandPrefix();

  const btnResetPrefixes = document.getElementById('btnResetPrefixes');
  if (btnResetPrefixes) btnResetPrefixes.onclick = () => resetPrefixesToDefault();

  // Title format config
  const titleFormatInput = document.getElementById('titleFormatInput');
  const btnSaveTitleFormat = document.getElementById('btnSaveTitleFormat');
  if (titleFormatInput) {
    titleFormatInput.value = localStorage.getItem('titleFormat') || '{PREFIX}{YY}{MM}-{sequence}-{Người nhận đặt}-{Chiết khấu}';
  }
  if (btnSaveTitleFormat && titleFormatInput) {
    btnSaveTitleFormat.onclick = () => {
      localStorage.setItem('titleFormat', titleFormatInput.value.trim());
      showToast('Đã lưu format tiêu đề!', 'success');
    };
  }

  // Initialize seller dropdown
  populateSellerDropdown();

  // Dialog modal close hook
  const btnCloseModal = document.getElementById('btnCloseModal');
  const modalOverlay = document.getElementById('modalOverlay');
  if (btnCloseModal) btnCloseModal.onclick = () => closeModal();
  if (modalOverlay) {
    modalOverlay.onclick = (e) => { if (e.target === modalOverlay) closeModal(); };
  }

  // ==================== AI Profile Management ====================
  initAiProfileManager();

  // Custom Promos Action Hook
  const btnAddCustomPromo = document.getElementById('btnAddPromo');
  if (btnAddCustomPromo) btnAddCustomPromo.onclick = () => addCustomPromo();

  // Custom Product Entry Hook
  const btnAddCustomProduct = document.getElementById('btnAddCustomProduct');
  if (btnAddCustomProduct) btnAddCustomProduct.onclick = () => addCustomProductToOrder();

  // Manual Product Search input Hook
  const manualSearchInput = document.getElementById('manualProductSearch');
  if (manualSearchInput) {
    // Search with debounce to prevent UI freezing
    let searchTimeout = null;
    manualSearchInput.addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        onManualSearch(e.target.value);
      }, 250); // 250ms debounce
    });
  }

  // Settings Database management buttons
  const btnExport = document.getElementById('btnExport') || document.getElementById('btnExportDb');
  if (btnExport) btnExport.onclick = () => exportDatabase();

  const btnImportTrigger = document.getElementById('btnImportTrigger');
  const importFileInput = document.getElementById('importFileInput') || document.getElementById('btnImportDbFile');
  if (btnImportTrigger && importFileInput) {
    btnImportTrigger.onclick = () => importFileInput.click();
  }
  if (importFileInput) {
    importFileInput.onchange = (e) => importDatabase(e);
  }

  const btnReset = document.getElementById('btnReset') || document.getElementById('btnResetDb');
  if (btnReset) btnReset.onclick = () => resetDatabase();

  // AI & Memory settings buttons
  const btnSaveMemory = document.getElementById('btnSaveMemory');
  if (btnSaveMemory) {
    btnSaveMemory.onclick = () => {
      const memEditor = document.getElementById('aiMemoryInput');
      if (memEditor) {
        db.saveMemory(memEditor.value);
        showToast('Đã lưu bộ nhớ AI thành công!', 'success');
      }
    };
  }

  const btnToggleAddProduct = document.getElementById('btnToggleAddProduct');
  if (btnToggleAddProduct) btnToggleAddProduct.onclick = () => toggleAddProductForm();

  const btnToggleAddCampaign = document.getElementById('btnToggleAddCampaign');
  if (btnToggleAddCampaign) btnToggleAddCampaign.onclick = () => switchSettingsSubTab('campaigns');

  // --- Sidebar Collapse Toggle ---
  const btnCollapseSidebar = document.getElementById('btnCollapseSidebar');
  if (btnCollapseSidebar) {
    btnCollapseSidebar.onclick = () => {
      const grid = btnCollapseSidebar.closest('.settings-grid');
      if (!grid) return;
      grid.classList.add('sidebar-collapsed');
      // Show floating expand button on the editor card
      const editorCard = grid.querySelector('#productEditor')?.closest('.card');
      if (editorCard) {
        editorCard.style.position = 'relative';
        let expandBtn = editorCard.querySelector('.btn-expand-sidebar');
        if (!expandBtn) {
          expandBtn = document.createElement('button');
          expandBtn.className = 'btn-expand-sidebar';
          expandBtn.title = 'Mở rộng danh sách thương hiệu';
          expandBtn.textContent = '▶';
          expandBtn.onclick = () => {
            grid.classList.remove('sidebar-collapsed');
            expandBtn.remove();
          };
          editorCard.appendChild(expandBtn);
        }
      }
    };
  }

  // --- Settings Nav Collapse Toggle ---
  const btnCollapseSettingsNav = document.getElementById('btnCollapseSettingsNav');
  if (btnCollapseSettingsNav) {
    btnCollapseSettingsNav.onclick = () => {
      const layout = btnCollapseSettingsNav.closest('.settings-layout');
      if (!layout) return;
      layout.classList.toggle('nav-collapsed');
    };
  }

  // --- Order Directory Config (Electron only) ---
  const btnPickOrderDir = document.getElementById('btnPickOrderDir');
  const btnSaveOrderDir = document.getElementById('btnSaveOrderDir');
  const orderDirInput = document.getElementById('orderDirInput');
  const orderDirStatus = document.getElementById('orderDirStatus');

  if (btnPickOrderDir && window.electronAPI && window.electronAPI.pickFolder) {
    btnPickOrderDir.onclick = async () => {
      const folder = await window.electronAPI.pickFolder();
      if (folder && orderDirInput) orderDirInput.value = folder;
    };
  }
  if (btnSaveOrderDir && window.electronAPI && window.electronAPI.setOrderDir) {
    btnSaveOrderDir.onclick = async () => {
      const dir = orderDirInput ? orderDirInput.value.trim() : '';
      if (!dir) {
        if (orderDirStatus) orderDirStatus.innerHTML = '<span style="color:var(--status-error);">Vui lòng nhập hoặc chọn đường dẫn.</span>';
        return;
      }
      const result = await window.electronAPI.setOrderDir(dir);
      if (result && result.success) {
        if (orderDirStatus) orderDirStatus.innerHTML = '<span style="color:var(--status-success);">✅ Đã lưu đường dẫn thành công!</span>';
        showToast('Đã lưu thư mục đơn hàng!', 'success');
      }
    };
  }
  // Load current order dir on settings tab open
  if (window.electronAPI && window.electronAPI.getOrderDir && orderDirInput) {
    window.electronAPI.getOrderDir().then((dir) => {
      if (dir) orderDirInput.value = dir;
    });
  }

  const btnCloseCampaignForm = document.getElementById('btnCloseCampaignForm');
  if (btnCloseCampaignForm) btnCloseCampaignForm.onclick = () => {
    switchSettingsSubTab('products');
  };

  const btnSaveCampaign = document.getElementById('btnSaveCampaign');
  if (btnSaveCampaign) btnSaveCampaign.onclick = () => saveNewCampaign();

  // Campaign override change
  const overrideDropdown = document.getElementById('aiOverrideCampaign');
  if (overrideDropdown) {
    overrideDropdown.onchange = () => {
      const val = overrideDropdown.value;
      const currentOrder = store.getState().currentOrder;
      if (val && currentOrder.aiResult) {
        currentOrder.aiResult.primaryCampaign = val;
        const campaign = db.data.campaigns[val];
        if (campaign) {
          currentOrder.aiResult.campaignLabel = `${campaign.icon} ${campaign.name}`;
          currentOrder.aiResult.campaignColor = campaign.color;
          currentOrder.aiResult.confidencePercent = 100;
          currentOrder.aiResult.confidence = 1;
        }
        uiRenderer.renderAIDetection(currentOrder.aiResult);
        showToast('Đã ghi đè thương hiệu!', 'info');
      }
    };
  }

  // Click outside to close comboboxes
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.combobox-container')) {
      document.querySelectorAll('.combobox-dropdown').forEach(d => d.style.display = 'none');
    }
    const manualSearchDropdown = document.getElementById('manualSearchDropdown');
    if (manualSearchDropdown && !e.target.closest('#manualProductSearch')) {
      manualSearchDropdown.style.display = 'none';
    }
  });
}


// --- App Initialization Entry Point ---


function initApp() {
  try {
    // 1. Instant 0ms Sync Boot of RAM Cache
    db.initSync();

    // 2. Initialize Web Worker for fuzzy matching
    workerManager.init(db.getAllProducts(), db.getAliases());

    // 3. Register state update rendering callbacks
    uiRenderer.registerCallbacks({
      removeOrderItem,
      reorderOrderItem,
      reorderRows,
      removeGiftItem,
      updateGiftQty,
      updateItemQty,
      updateDualPriceLive,
      selectComboboxItem,
      showComboboxDropdown,
      filterComboboxOptions,
      addCustomPromo,
      removeCustomPromo,
      changeRowProduct,
      updateGiftOverride,
    });

    // 4. Listen to state changes to update the UI
    // Skip expensive re-renders when the order panel is not visible;
    // set a dirty flag so the tab-switch handler can catch up.
    store.subscribe((state) => {
      const orderPanel = document.getElementById('panelOrder');
      if (orderPanel && orderPanel.classList.contains('active')) {
        uiRenderer.renderOrderResults(state.currentOrder);
        renderCustomPromos();
      } else {
        window._orderNeedsRender = true;
      }
    });

    // 5. Bind global UI event listeners
    bindGlobalUIListeners();

    // 5a. Customer Special-Price Notes: bind events & load data
    CustomerNotes.bindEvents();
    CustomerNotes.load();

    // 5b. Set up delegated event listeners for product editor (Phase 3)
    initProductEditorDelegation();

    // 5c. Set up delegated event listeners for catalog (replaces per-render binding)
    initCatalogDelegation();

    // 6. Instant UI Render (0ms delay)
    uiRenderer.renderOrderResults(store.getState().currentOrder);

    // 6b. Pre-populate AI Memory textarea with saved memory
    const aiMemoryInput = document.getElementById('aiMemoryInput');
    if (aiMemoryInput) aiMemoryInput.value = db.getMemory() || '';

    // 7. Background Non-Blocking Sync with IndexedDB
    db.init(() => {
      workerManager.updateDatabase(db.getAllProducts(), db.getAliases());
      uiRenderer.renderOrderResults(store.getState().currentOrder);
      const memInput = document.getElementById('aiMemoryInput');
      if (memInput && document.activeElement !== memInput) memInput.value = db.getMemory() || '';
      populateSellerDropdown(); // Refresh sellers (may have been restored from IndexedDB)
      updateSidebarStatus();
    }).then(() => {
      // Safety net: always refresh seller dropdown after async init
      populateSellerDropdown();
    });

    // 8. Restore AI status (profiles are loaded by initAiProfileManager)
    updateSidebarStatus();

    // 8a. Phiên bản app (chỉ có trong Electron; trình duyệt thường ẩn đi)
    if (window.electronAPI && window.electronAPI.getAppVersion) {
      window.electronAPI.getAppVersion().then((v) => {
        const verEl = document.getElementById('sidebarAppVersion');
        if (verEl && v) verEl.textContent = 'v' + v;
      }).catch(() => {});
    }

    // 9. Initialize KiotViet Automation Controller
    KiotVietAutomation.init();

    console.log('Order Automation initialized instantly (0ms access).');
  } catch (err) {
    console.error('Application initialization failed:', err);
    showToast('Lỗi khởi tạo ứng dụng: ' + err.message, 'error');
  }
}

// =========================================================================
//  KIOTVIET AUTOMATION CONTROLLER
// =========================================================================

const KiotVietAutomation = {
  mcpConnected: false,
  agentRunning: false,

  init() {
    const btnKiotViet = document.getElementById('btnKiotVietOrder');
    const btnCloseModal = document.getElementById('btnCloseKvModal');
    const btnLaunchChrome = document.getElementById('btnKvLaunchChrome');
    const btnConnect = document.getElementById('btnKvConnect');
    const btnDisconnect = document.getElementById('btnKvDisconnect');
    const btnStart = document.getElementById('btnKvStart');
    const btnAbort = document.getElementById('btnKvAbort');

    if (btnKiotViet) btnKiotViet.addEventListener('click', () => this.openPanel());
    if (btnCloseModal) btnCloseModal.addEventListener('click', () => this.closePanel());
    if (btnLaunchChrome) btnLaunchChrome.addEventListener('click', () => this.launchChromeDebug());
    if (btnConnect) btnConnect.addEventListener('click', () => this.connectMCP());
    if (btnDisconnect) btnDisconnect.addEventListener('click', () => this.disconnectMCP());
    if (btnStart) btnStart.addEventListener('click', () => this.startOrder());
    if (btnAbort) btnAbort.addEventListener('click', () => this.abortOrder());

    // AI Verify toggle: update hint text
    const kvVerifyCheckbox = document.getElementById('kvAiVerify');
    if (kvVerifyCheckbox) {
      kvVerifyCheckbox.addEventListener('change', () => {
        const hint = document.getElementById('kvModeHint');
        if (hint) {
          hint.textContent = kvVerifyCheckbox.checked ? '(kiểm tra & sửa lỗi trước submit)' : '(bỏ qua kiểm tra — submit ngay)';
          hint.style.color = kvVerifyCheckbox.checked ? 'var(--text-3)' : 'var(--orange)';
          hint.style.fontWeight = kvVerifyCheckbox.checked ? '400' : '600';
        }
      });
    }

    // Remember manual override when the user picks an AI in the KV modal
    const kvProviderSelect = document.getElementById('kvAiProviderSelect');
    if (kvProviderSelect) {
      kvProviderSelect.addEventListener('change', async () => {
        // Capture the currently active analysis profile (source of the auto-sync)
        let analysisId = '';
        try {
          const res = await aiService.getProfiles();
          const enabled = (res.profiles || []).filter(p => p.enabled);
          const active = enabled.find(p => p.id === res.activeId) || enabled[0];
          analysisId = active ? active.id : '';
        } catch (e) { /* ignore */ }
        try {
          localStorage.setItem('kvAiProviderOverride', JSON.stringify({
            analysisId,
            kvProvider: kvProviderSelect.value
          }));
        } catch (e) { /* ignore */ }
      });
    }

    // Check status on load if electronAPI available
    if (window.electronAPI && window.electronAPI.browserAgent) {
      window.electronAPI.browserAgent.status().then(status => {
        if (status && status.connected) {
          this.updateConnectionState(true);
        }
      }).catch(() => {});

      // Subscribe to real-time events
      window.electronAPI.browserAgent.on('browser-agent:log', (entry) => this.appendLog(entry));
      window.electronAPI.browserAgent.on('browser-agent:step', ({ step, maxSteps }) => this.updateStepProgress(step, maxSteps));
      window.electronAPI.browserAgent.on('browser-agent:action', ({ step, tool, args }) => {
        this.appendLog({ source: 'agent', level: 'action', msg: `[Action ${step}] ${tool}(${JSON.stringify(args || {})})` });
      });
      window.electronAPI.browserAgent.on('browser-agent:completed', ({ steps, summary }) => {
        this.agentRunning = false;
        this.updateRunningState(false);
        this.appendLog({ source: 'agent', level: 'info', msg: `✅ ĐÃ HOÀN THÀNH LÊN ĐƠN! (${steps} bước) — ${summary || ''}` });
        showToast('Lên đơn KiotViet thành công!', 'success');
      });
      window.electronAPI.browserAgent.on('browser-agent:aborted', () => {
        this.agentRunning = false;
        this.updateRunningState(false);
        this.appendLog({ source: 'agent', level: 'warn', msg: `⛔ Đã dừng Agent.` });
        showToast('Đã dừng tiến trình lên đơn KiotViet.', 'warn');
      });
      window.electronAPI.browserAgent.on('browser-agent:error', ({ error }) => {
        this.agentRunning = false;
        this.updateRunningState(false);
        this.appendLog({ source: 'agent', level: 'error', msg: `❌ Lỗi: ${error}` });
        showToast(`Lỗi lên đơn KiotViet: ${error}`, 'error');
      });
    }
  },

  buildOrderData() {
    const currentOrder = store.getState().currentOrder;
    if (!currentOrder) return null;

    const custEl = document.getElementById('customerName');
    const payEl = document.getElementById('paymentMethod');
    const noteEl = document.getElementById('orderNote');

    const customer = custEl ? custEl.value.trim() : (currentOrder.customer || '');
    const payment = payEl ? payEl.value : (currentOrder.payment || 'ck');
    const note = noteEl ? noteEl.value.trim() : '';

    const { rows } = uiRenderer.getOrderTableRows(currentOrder);
    const allProducts = db.getAllProducts();
    const aliases = db.getAliases();

    const items = rows.map(r => {
      let prodObj = r.product || null;
      if (!prodObj && r.productId) prodObj = db.findProductById(r.productId);

      const displayName = r.productName || r.name || r.rawProduct || (prodObj ? prodObj.name : '');

      let kvCode = '';
      if (prodObj) {
        kvCode = db.getKvCode(prodObj, r.unit) || '';
      }
      if (!kvCode && displayName) {
        const match = findBestProductMatch(displayName, allProducts, aliases);
        if (match && match.product) {
          kvCode = db.getKvCode(match.product, r.unit);
        }
      }

      // KiotViet "Giá bán" = giá theo QUY CÁCH đã chọn (Thùng → giá/thùng, Bình → giá/chai).
      // KV tính: Thành tiền = Giá bán × SL (KHÔNG nhân hệ số quy đổi).
      // → Gửi giá theo đúng quy cách: subtotal/qty = giá mỗi đơn vị đã chọn.
      const isGiftRow = !!r.isGift || r.type === 'gift';
      const kvPrice = isGiftRow ? 0 : (r.subtotal ? Math.round(r.subtotal / (r.qty || 1)) : 0);

      return {
        code: kvCode,
        name: displayName,
        qty: r.qty || 1,
        unit: r.unit || 'thùng',
        price: kvPrice,
        isGift: isGiftRow,
        productId: prodObj ? prodObj.id : (r.productId || null)
      };
    });

    // Get receiver (Người nhận đặt) from seller dropdown/input
    // Use kvName (exact KiotViet name) if configured, otherwise use display name
    const sellerHidden = document.getElementById('sellerName');
    const sellerSearch = document.getElementById('sellerSearch');
    const rawSellerVal = (sellerHidden?.value || sellerSearch?.value || '').trim();
    
    let receiver = '';
    if (rawSellerVal) {
      const sellers = typeof getSellers === 'function' ? getSellers() : (db?.sellers || []);
      const parsedName = rawSellerVal.replace(/\|\|\|.*$/, '').replace(/:::.*$/, '').replace(/\s*\([^)]*\)$/, '').trim();
      const matchedSeller = sellers.find(s => 
        (s.id && s.id === rawSellerVal) ||
        (s.name && s.name === rawSellerVal) ||
        (s.name && s.name === parsedName) ||
        (s.kvName && s.kvName === rawSellerVal)
      );
      if (matchedSeller) {
        receiver = matchedSeller.kvName || matchedSeller.name || parsedName;
      } else {
        receiver = parsedName || rawSellerVal;
      }
    }

    return {
      customer,
      payment,
      note,
      receiver,
      items
    };
  },

  // Map analysis AI provider → KV modal provider value
  _mapAnalysisToKv(provider) {
    switch (provider) {
      case 'gemini': return 'gemini';
      case 'openai': return 'openai';
      case 'lmstudio': return 'lmstudio';
      case 'custom': return 'gemini'; // custom API users likely have Gemini key configured
      default: return 'gemini'; // prefer API-based over local LM Studio
    }
  },

  /**
   * Sync the KV modal's "AI Provider" with the AI the user actually uses for analysis.
   * The dropdown is populated from the user's enabled AI profiles and the active
   * analysis profile is selected by default, so the options and the selection always
   * match the configured AIs. A manual override is respected as long as the active
   * analysis profile hasn't changed.
   */
  async syncAiProvider() {
    const select = document.getElementById('kvAiProviderSelect');
    if (!select) return;

    const OVERRIDE_KEY = 'kvAiProviderOverride';
    const PROVIDER_LABELS = Object.fromEntries(Object.entries(AI_PROVIDERS).map(([k, v]) => [k, v.label]));

    // Load the user's actual AI profiles (the AIs used for analysis)
    let profiles = [], activeId = '';
    try {
      const res = await aiService.getProfiles();
      profiles = (res.profiles || []).filter(p => p.enabled);
      activeId = res.activeId || '';
    } catch (e) { profiles = []; }

    // No profile configured → restore the static option list, sync by provider type
    if (profiles.length === 0) {
      // Restore the default static options (in case a previous profile list replaced them)
      if (!Array.from(select.options).some(o => o.value === 'lmstudio')) {
        // Generate options from registry + proxy option
        let opts = '<option value="proxy">Gemini Flash (Proxy 8045)</option>';
        opts += Object.entries(AI_PROVIDERS).map(([id, p]) =>
          `<option value="${id}">${p.icon} ${p.label}${p.local ? ' (Local)' : ''}</option>`
        ).join('');
        select.innerHTML = opts;
      }
      let analysisProvider = 'none';
      try {
        const cfg = await aiService.getConfig();
        analysisProvider = (cfg && cfg.provider) || 'none';
      } catch (e) { /* keep default */ }
      select.value = this._mapAnalysisToKv(analysisProvider);
      return;
    }

    // Populate the options from the real enabled profiles
    select.innerHTML = profiles.map(p => {
      const label = PROVIDER_LABELS[p.provider] || p.provider;
      const model = p.model ? ` · ${p.model}` : '';
      return `<option value="${p.id}">${escapeHtml(p.name || label)} (${escapeHtml(label)}${escapeHtml(model)})</option>`;
    }).join('');

    // Default = active analysis profile; respect a valid manual override
    const activeProfile = profiles.find(p => p.id === activeId) || profiles[0];
    let override = null;
    try {
      const raw = localStorage.getItem(OVERRIDE_KEY);
      if (raw) override = JSON.parse(raw);
    } catch (e) { override = null; }

    let targetId = activeProfile.id;
    const overrideValid = override && override.kvProvider &&
      profiles.some(p => p.id === override.kvProvider);
    if (overrideValid && override.analysisId === activeProfile.id) {
      targetId = override.kvProvider;
    } else if (override) {
      try { localStorage.removeItem(OVERRIDE_KEY); } catch (e) { /* ignore */ }
    }
    select.value = targetId;
  },

  async openPanel() {
    const modal = document.getElementById('modalKiotViet');
    if (!modal) return;

    const orderData = this.buildOrderData();
    if (!orderData || orderData.items.length === 0) {
      showToast('Đơn hàng hiện chưa có sản phẩm nào.', 'warn');
      return;
    }

    // Populate preview
    const custSpan = document.getElementById('kvPreviewCustomer');
    const paySpan = document.getElementById('kvPreviewPayment');
    const tbody = document.getElementById('kvPreviewItems');

    const paymentMap = { ck: 'Chuyển khoản (CK)', cod: 'COD', tt: 'Tiền mặt', congno: 'Công nợ', other: 'Khác' };

    if (custSpan) custSpan.textContent = orderData.customer || '(Chưa điền tên KH)';
    if (paySpan) paySpan.textContent = paymentMap[orderData.payment] || orderData.payment;

    if (tbody) {
      tbody.innerHTML = orderData.items.map(item => {
        const codeChip = item.code 
          ? `<span style="font-family:var(--font-mono); font-weight:700; color:var(--blue);">${escapeHtml(item.code)}</span>`
          : `<span style="color:var(--orange); font-size:0.75rem; font-weight:600;">⚠️ Chưa có mã KV</span>`;
        
        const priceStr = item.isGift ? 'Miễn phí' : (item.price ? formatCurrency(item.price) : 'Mặc định');
        const giftTag = item.isGift ? ' <span class="gift-badge">FOC</span>' : '';

        return `<tr>
          <td>${codeChip}</td>
          <td>${escapeHtml(item.name)}${giftTag}</td>
          <td class="text-center font-weight-bold">${item.qty} ${escapeHtml(item.unit)}</td>
          <td class="text-right">${priceStr}</td>
        </tr>`;
      }).join('');
    }

    // Sync AI Provider with the analysis AI (respecting manual override)
    await this.syncAiProvider();

    this.updateStepProgress(0, 4);
    modal.style.display = 'flex';
  },

  closePanel() {
    const modal = document.getElementById('modalKiotViet');
    if (modal) modal.style.display = 'none';
  },

  async launchChromeDebug() {
    if (!window.electronAPI || !window.electronAPI.browserAgent) {
      showToast('Tính năng này chỉ hoạt động trên ứng dụng Electron desktop.', 'warn');
      return;
    }
    const btn = document.getElementById('btnKvLaunchChrome');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Đang mở...'; }
    try {
      this.appendLog({ source: 'system', level: 'info', msg: '🌐 Đang mở Chrome/Brave với debug port 9222...' });
      const res = await window.electronAPI.browserAgent.launchChrome('Brave');
      if (res.success) {
        this.appendLog({ source: 'system', level: 'info', msg: `✅ ${res.message}` });
        showToast(res.message, 'success');
      } else {
        this.appendLog({ source: 'system', level: 'error', msg: `❌ ${res.error}` });
        showToast(res.error, 'error');
      }
    } catch (err) {
      this.appendLog({ source: 'system', level: 'error', msg: `❌ Lỗi: ${err.message}` });
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🌐 Mở Chrome Debug'; }
    }
  },

  async connectMCP() {
    if (!window.electronAPI || !window.electronAPI.browserAgent) {
      showToast('Tính năng này chỉ hoạt động trên ứng dụng Electron desktop.', 'warn');
      return;
    }
    const btnConnect = document.getElementById('btnKvConnect');
    if (btnConnect) { btnConnect.disabled = true; btnConnect.textContent = '⏳ Đang kết nối...'; }

    try {
      this.appendLog({ source: 'system', level: 'info', msg: 'Đang khởi động Chrome (lần đầu có thể mất 10-30 giây)...' });
      this.appendLog({ source: 'system', level: 'info', msg: '💡 Chrome sẽ tự mở với trang KiotViet. Đăng nhập nếu chưa (chỉ cần 1 lần duy nhất).' });
      const res = await window.electronAPI.browserAgent.connect();
      if (res.success) {
        this.updateConnectionState(true);
        if (res.browserConnected) {
          this.appendLog({ source: 'system', level: 'info', msg: `✅ Đã kết nối Chrome thành công (${res.tools.length} tools).` });
          showToast('Kết nối Browser thành công!', 'success');
        } else {
          this.appendLog({ source: 'system', level: 'warn', msg: `🔌 MCP Server đã chạy nhưng Chrome chưa phản hồi. Thử bấm "Kết nối Browser" lại.` });
          showToast('Chrome chưa phản hồi. Thử kết nối lại!', 'info');
        }
        const hint = document.getElementById('kvSetupHint');
        if (hint) hint.style.display = 'none';
      } else {
        this.updateConnectionState(false);
        const errMsg = res.error || 'Không rõ lỗi';
        this.appendLog({ source: 'system', level: 'error', msg: `❌ Kết nối thất bại: ${errMsg}` });
      }
    } catch (err) {
      this.updateConnectionState(false);
      this.appendLog({ source: 'system', level: 'error', msg: `❌ Lỗi: ${err.message}` });
    } finally {
      if (btnConnect) { btnConnect.disabled = false; btnConnect.textContent = '🔌 Kết nối Browser'; }
    }
  },

  async disconnectMCP() {
    if (!window.electronAPI || !window.electronAPI.browserAgent) return;
    await window.electronAPI.browserAgent.disconnect();
    this.updateConnectionState(false);
    this.appendLog({ source: 'system', level: 'info', msg: 'Đã ngắt kết nối Browser.' });
  },

  async startOrder() {
    if (!window.electronAPI || !window.electronAPI.browserAgent) return;
    if (this.agentRunning) return;

    const orderData = this.buildOrderData();
    if (!orderData || orderData.items.length === 0) {
      showToast('Đơn hàng rỗng, không thể lên đơn.', 'warn');
      return;
    }

    // Verify browser extension connection right before starting
    const snapRes = await window.electronAPI.browserAgent.snapshot();
    if (!snapRes.success) {
      showToast('Chưa kết nối được với Chrome. Hãy bấm "Kết nối Browser" và thử lại!', 'error');
      this.appendLog({ source: 'system', level: 'error', msg: '❌ Chưa kết nối được với Chrome. Hãy bấm "Kết nối Browser" trước.' });
      return;
    }

    this.agentRunning = true;
    this.updateRunningState(true);
    this.updateStepProgress(0, 4);

    // DIRECT SCRIPT PIPELINE: Pure JS Script fill (Zero AI) → Optional Submit → PDF
    const aiVerifyCheckbox = document.getElementById('kvAiVerify');
    const skipVerify = aiVerifyCheckbox ? !aiVerifyCheckbox.checked : true;
    const savePdfCheckbox = document.getElementById('kvSavePdf');
    const savePdf = savePdfCheckbox ? savePdfCheckbox.checked : false;
    const autoSubmit = savePdf; // PDF requires auto-submit

    this.appendLog({ source: 'system', level: 'info', msg: `🚀 Chạy Script điền đơn siêu tốc: ${orderData.customer || 'Khách lẻ'} (${orderData.items.length} sản phẩm)...` });

    try {
      const res = await window.electronAPI.browserAgent.runOrder(orderData, { 
        mode: 'direct', 
        skipVerify, 
        autoSubmit, 
        savePdf 
      });
      if (!res.success) {
        this.agentRunning = false;
        this.updateRunningState(false);
        this.appendLog({ source: 'system', level: 'error', msg: `❌ Không thể bắt đầu: ${res.error}` });
        showToast(res.error, 'error');
      }
    } catch (err) {
      this.agentRunning = false;
      this.updateRunningState(false);
      this.appendLog({ source: 'system', level: 'error', msg: `❌ Lỗi khởi chạy: ${err.message}` });
    }
  },

  async abortOrder() {
    if (!window.electronAPI || !window.electronAPI.browserAgent) return;
    await window.electronAPI.browserAgent.abort();
    this.appendLog({ source: 'system', level: 'warn', msg: 'Đã yêu cầu dừng Agent...' });
  },

  updateConnectionState(connected) {
    this.mcpConnected = connected;
    const badge = document.getElementById('kvConnectionBadge');
    const btnConnect = document.getElementById('btnKvConnect');
    const btnDisconnect = document.getElementById('btnKvDisconnect');
    const btnStart = document.getElementById('btnKvStart');

    if (badge) {
      badge.textContent = connected ? 'Đã kết nối' : 'Chưa kết nối';
      badge.className = `kv-status-badge ${connected ? 'connected' : 'disconnected'}`;
    }
    if (btnConnect) btnConnect.style.display = connected ? 'none' : '';
    if (btnDisconnect) btnDisconnect.style.display = connected ? '' : 'none';
    if (btnStart) btnStart.disabled = !connected || this.agentRunning;
  },

  updateRunningState(running) {
    const btnStart = document.getElementById('btnKvStart');
    const btnAbort = document.getElementById('btnKvAbort');
    if (btnStart) {
      btnStart.disabled = running || !this.mcpConnected;
      btnStart.textContent = running ? '⏳ Đang lên đơn...' : '▶️ Bắt đầu lên đơn';
    }
    if (btnAbort) btnAbort.style.display = running ? '' : 'none';
  },

  updateStepProgress(step, maxSteps) {
    const indicator = document.getElementById('kvStepIndicator');
    const bar = document.getElementById('kvProgressBar');
    if (indicator) indicator.textContent = `Bước ${step}/${maxSteps}`;
    if (bar) {
      const pct = Math.min(100, Math.round((step / maxSteps) * 100));
      bar.style.width = `${pct}%`;
    }
  },

  appendLog(entry) {
    const consoleEl = document.getElementById('kvLogConsole');
    if (!consoleEl) return;

    const div = document.createElement('div');
    const lvlClass = entry.level || 'info';
    div.className = `kv-log-entry ${lvlClass}`;

    const timeStr = entry.ts ? new Date(entry.ts).toLocaleTimeString() : new Date().toLocaleTimeString();
    div.textContent = `[${timeStr}] ${entry.msg || ''}`;

    consoleEl.appendChild(div);
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }
};

// ==================== AI Profile Manager (Multi-Key UI) ====================
function initAiProfileManager() {
  const PROVIDER_META = Object.fromEntries(
    Object.entries(AI_PROVIDERS).map(([k, v]) => [k, { icon: v.icon, label: v.label }])
  );

  let _profiles = [];
  let _strategy = 'failover';
  let _activeId = '';
  let _editingId = null; // null = adding new
  let _selectedProvider = null;

  const listEl = document.getElementById('aiProfileList');
  const emptyEl = document.getElementById('aiEmptyState');
  const formEl = document.getElementById('aiProfileForm');
  const badgeEl = document.getElementById('aiStatusBadge');
  const strategyHint = document.getElementById('aiStrategyHint');

  if (!listEl) return;

  // --- Generate provider cards from registry ---
  const gridEl = document.getElementById('aiProviderGrid');
  if (gridEl) {
    gridEl.innerHTML = Object.entries(AI_PROVIDERS).map(([id, p]) =>
      `<button class="ai-provider-card" data-provider="${id}">
        <span class="ai-provider-icon">${p.icon}</span>
        <span class="ai-provider-name">${p.label}</span>
        <span class="ai-provider-desc">${p.desc}</span>
      </button>`
    ).join('');
  }

  // --- Load & Render ---
  async function loadProfiles() {
    const data = await aiService.getProfiles();
    _profiles = data.profiles || [];
    _strategy = data.strategy || 'failover';
    _activeId = data.activeId || '';
    render();
  }

  async function persist() {
    await aiService.saveProfiles(_profiles, _strategy, _activeId);
  }

  function render() {
    // Strategy buttons
    document.querySelectorAll('.ai-strategy-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.strategy === _strategy);
    });
    if (strategyHint) {
      strategyHint.textContent = _strategy === 'roundrobin'
        ? 'Xoay vòng tất cả profile đang bật — mỗi lần phân tích dùng 1 profile khác nhau (chia đều chi phí, tránh rate limit).'
        : 'Ưu tiên profile chính, tự động chuyển sang profile khác khi gặp lỗi (429, timeout...).';
    }

    // Profile list
    const items = listEl.querySelectorAll('.ai-profile-item');
    items.forEach(el => el.remove());

    if (emptyEl) emptyEl.style.display = _profiles.length === 0 ? '' : 'none';

    _profiles.forEach(p => {
      const meta = PROVIDER_META[p.provider] || { icon: '❓', label: p.provider };
      const isPrimary = p.id === _activeId;
      const div = document.createElement('div');
      div.className = `ai-profile-item${p.enabled ? '' : ' disabled'}${isPrimary ? ' is-primary' : ''}`;
      div.title = isPrimary ? 'Đang là API chính' : 'Click để chọn làm API chính';
      div.innerHTML = `
        <div class="ai-profile-icon">${meta.icon}</div>
        <div class="ai-profile-info">
          <div class="ai-profile-name">${escapeHtml(p.name)}${isPrimary ? '<span class="primary-badge">Chính</span>' : ''}</div>
          <div class="ai-profile-meta">${meta.label} · ${escapeHtml(p.model || 'auto model')}${p.endpoint ? ' · ' + escapeHtml(p.endpoint.replace(/^https?:\/\//, '').slice(0, 35)) : ''}</div>
        </div>
        <div class="ai-profile-actions">
          <button class="btn btn-ghost btn-sm ai-act-test" title="Test kết nối">🔌</button>
          ${!isPrimary && p.enabled ? '<button class="btn btn-ghost btn-sm ai-act-primary" title="Đặt làm chính">⭐</button>' : ''}
          <button class="btn btn-ghost btn-sm ai-act-edit" title="Sửa">✏️</button>
          <button class="btn btn-ghost btn-sm ai-act-del" title="Xóa">🗑️</button>
          <label class="ai-toggle" title="Bật/Tắt">
            <input type="checkbox" ${p.enabled ? 'checked' : ''} />
            <span class="slider"></span>
          </label>
        </div>
      `;

      // Events — click anywhere on the row to select as primary
      div.addEventListener('click', async (e) => {
        // Ignore clicks on action buttons / toggle
        if (e.target.closest('.ai-profile-actions')) return;
        if (!p.enabled) {
          showToast('Profile đang tắt — bật lên trước khi chọn.', 'warning');
          return;
        }
        if (_activeId !== p.id) {
          _activeId = p.id;
          await persist();
          render();
          showToast(`Đã chọn "${p.name}" làm API chính.`, 'success');
        }
      });

      div.querySelector('.ai-act-test').onclick = async (e) => {
        e.stopPropagation();
        const testEl = div.querySelector('.ai-profile-meta');
        const orig = testEl.textContent;
        testEl.textContent = '⏳ Đang test...';
        const res = await aiService.testProfile(p);
        testEl.textContent = res.ok ? `✅ ${res.message}` : `❌ ${res.message}`;
        testEl.style.color = res.ok ? 'var(--accent-green)' : 'var(--accent-red)';
        setTimeout(() => { testEl.textContent = orig; testEl.style.color = ''; }, 5000);
      };

      const primaryBtn = div.querySelector('.ai-act-primary');
      if (primaryBtn) {
        primaryBtn.onclick = async (e) => {
          e.stopPropagation();
          _activeId = p.id;
          await persist();
          render();
          showToast(`Đã đặt "${p.name}" làm profile chính.`, 'success');
        };
      }

      div.querySelector('.ai-act-edit').onclick = (e) => { e.stopPropagation(); openEditForm(p); };

      div.querySelector('.ai-act-del').onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`Xóa profile "${p.name}"?`)) return;
        _profiles = _profiles.filter(x => x.id !== p.id);
        if (_activeId === p.id) _activeId = (_profiles.find(x => x.enabled) || {}).id || '';
        await persist();
        render();
        showToast(`Đã xóa profile "${p.name}".`, 'success');
      };

      div.querySelector('.ai-toggle input').onchange = async (e) => {
        p.enabled = e.target.checked;
        if (!p.enabled && _activeId === p.id) {
          _activeId = (_profiles.find(x => x.enabled && x.id !== p.id) || {}).id || '';
        }
        if (p.enabled && !_activeId) _activeId = p.id;
        await persist();
        render();
      };

      listEl.appendChild(div);
    });

    updateBadge();
    updateSidebarAiStatus();
  }

  function updateBadge() {
    if (!badgeEl) return;
    const enabled = _profiles.filter(p => p.enabled);
    if (enabled.length === 0) {
      badgeEl.innerHTML = '🔒 Chưa có AI nào hoạt động — phân tích sẽ dùng Offline Regex';
      badgeEl.style.color = '';
    } else {
      const names = enabled.map(p => `${(PROVIDER_META[p.provider] || {}).icon || ''} ${escapeHtml(p.name)}`).join(' · ');
      badgeEl.innerHTML = `🟢 ${enabled.length} AI đang hoạt động: ${names}${_strategy === 'roundrobin' ? ' <em>(xoay vòng)</em>' : ''}`;
      badgeEl.style.color = 'var(--accent-green)';
    }
  }

  function updateSidebarAiStatus() {
    const aiStatusEl = document.getElementById('sidebarAiStatus');
    const aiDotEl = document.getElementById('sidebarAiDot');
    if (!aiStatusEl) return;
    const enabled = _profiles.filter(p => p.enabled);
    if (enabled.length === 0) {
      aiStatusEl.textContent = 'Offline';
      if (aiDotEl) aiDotEl.className = 'status-dot';
    } else {
      aiStatusEl.textContent = enabled.length === 1 ? (PROVIDER_META[enabled[0].provider] || {}).label || 'AI' : `${enabled.length} AI`;
      if (aiDotEl) aiDotEl.className = 'status-dot ai';
    }
  }

  // --- Form Logic ---
  function openAddForm() {
    _editingId = null;
    _selectedProvider = null;
    document.getElementById('aiFormTitle').textContent = '➕ Thêm AI Profile mới';
    document.getElementById('aiProfileName').value = '';
    document.getElementById('aiProfileKey').value = '';
    document.getElementById('aiProfileModel').value = '';
    document.getElementById('aiProfileEndpoint').value = '';
    document.getElementById('aiFormFields').style.display = 'none';
    document.getElementById('aiProfileTestResult').textContent = '';
    document.querySelectorAll('.ai-provider-card').forEach(c => c.classList.remove('selected'));
    formEl.style.display = '';
    formEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function openEditForm(profile) {
    _editingId = profile.id;
    _selectedProvider = profile.provider;
    document.getElementById('aiFormTitle').textContent = `✏️ Sửa: ${profile.name}`;
    document.getElementById('aiProfileName').value = profile.name;
    document.getElementById('aiProfileKey').value = profile.apiKey || '';
    document.getElementById('aiProfileModel').value = profile.model || '';
    document.getElementById('aiProfileEndpoint').value = profile.endpoint || '';
    document.getElementById('aiProfileTestResult').textContent = '';
    document.querySelectorAll('.ai-provider-card').forEach(c => {
      c.classList.toggle('selected', c.dataset.provider === profile.provider);
    });
    applyProviderFields(profile.provider);
    formEl.style.display = '';
    formEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function closeForm() {
    formEl.style.display = 'none';
    _editingId = null;
    _selectedProvider = null;
  }

  function applyProviderFields(provider) {
    const keyRow = document.getElementById('aiFormKeyRow');
    const endpointGroup = document.getElementById('aiFormEndpointGroup');
    const lmHint = document.getElementById('aiLmStudioHint');
    const modelInput = document.getElementById('aiProfileModel');
    const endpointInput = document.getElementById('aiProfileEndpoint');
    const nameInput = document.getElementById('aiProfileName');
    const cfg = getProviderConfig(provider);

    document.getElementById('aiFormFields').style.display = '';

    // Show/hide API key based on registry auth type
    keyRow.style.display = (cfg.auth === 'none') ? 'none' : '';
    // Show endpoint field based on registry
    endpointGroup.style.display = cfg.showEndpoint ? '' : 'none';
    // LM Studio hint
    lmHint.style.display = (provider === 'lmstudio') ? '' : 'none';

    // Defaults
    if (!_editingId) {
      modelInput.value = cfg.defaultModel || '';
      if (cfg.local && cfg.endpoint) {
        endpointInput.value = cfg.endpoint;
        if (!nameInput.value) nameInput.value = `${cfg.label} Local`;
      } else if (provider === 'custom') {
        endpointInput.value = '';
      } else {
        if (!nameInput.value) nameInput.value = `${cfg.label} Key ${_profiles.filter(p => p.provider === provider).length + 1}`;
      }
    }
  }

  // --- Event Bindings ---
  const btnAdd = document.getElementById('btnAddAiProfile');
  if (btnAdd) btnAdd.onclick = openAddForm;

  const btnClose = document.getElementById('btnCloseAiForm');
  if (btnClose) btnClose.onclick = closeForm;

  const btnCancel = document.getElementById('btnCancelAiForm');
  if (btnCancel) btnCancel.onclick = closeForm;

  // Provider quick-pick
  document.querySelectorAll('.ai-provider-card').forEach(card => {
    card.onclick = () => {
      document.querySelectorAll('.ai-provider-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      _selectedProvider = card.dataset.provider;
      applyProviderFields(_selectedProvider);
    };
  });

  // Strategy buttons
  document.querySelectorAll('.ai-strategy-btn').forEach(btn => {
    btn.onclick = async () => {
      _strategy = btn.dataset.strategy;
      await persist();
      render();
    };
  });

  // Toggle key visibility
  const btnToggleKey = document.getElementById('btnToggleProfileKey');
  const keyInput = document.getElementById('aiProfileKey');
  if (btnToggleKey && keyInput) {
    btnToggleKey.onclick = () => {
      keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
    };
  }

  // Test connection from form
  const btnTest = document.getElementById('btnTestAiProfile');
  if (btnTest) {
    btnTest.onclick = async () => {
      const resultEl = document.getElementById('aiProfileTestResult');
      if (!_selectedProvider) { showToast('Chọn provider trước!', 'warn'); return; }
      const profile = {
        provider: _selectedProvider,
        apiKey: document.getElementById('aiProfileKey').value.trim(),
        model: document.getElementById('aiProfileModel').value.trim(),
        endpoint: document.getElementById('aiProfileEndpoint').value.trim()
      };
      resultEl.textContent = '⏳ Đang kiểm tra kết nối...';
      resultEl.className = 'ai-test-result loading';
      const res = await aiService.testProfile(profile);
      resultEl.textContent = res.ok ? `✅ ${res.message}` : `❌ ${res.message}`;
      resultEl.className = 'ai-test-result ' + (res.ok ? 'ok' : 'fail');
      // Auto-fill model list hint for lmstudio
      if (res.ok && res.models && res.models.length && !profile.model) {
        document.getElementById('aiProfileModel').placeholder = res.models[0];
      }
    };
  }

  // Save profile
  const btnSave = document.getElementById('btnSaveAiProfile');
  if (btnSave) {
    btnSave.onclick = async () => {
      if (!_selectedProvider) { showToast('Hãy chọn provider (Gemini, LM Studio, OpenAI, Custom)!', 'error'); return; }

      const name = document.getElementById('aiProfileName').value.trim() || `${(PROVIDER_META[_selectedProvider] || {}).label} profile`;
      const apiKey = document.getElementById('aiProfileKey').value.trim();
      const model = document.getElementById('aiProfileModel').value.trim();
      const endpoint = document.getElementById('aiProfileEndpoint').value.trim();

      // Validation
      if (_selectedProvider !== 'lmstudio' && !apiKey) {
        showToast('Vui lòng nhập API Key!', 'error');
        return;
      }
      if (_selectedProvider === 'custom' && !endpoint) {
        showToast('Vui lòng nhập Endpoint URL!', 'error');
        return;
      }

      if (_editingId) {
        // Update existing
        const idx = _profiles.findIndex(p => p.id === _editingId);
        if (idx >= 0) {
          _profiles[idx] = { ..._profiles[idx], name, provider: _selectedProvider, apiKey, model, endpoint };
        }
      } else {
        // Add new
        const newProfile = {
          id: 'ai_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
          name,
          provider: _selectedProvider,
          apiKey,
          model,
          endpoint,
          enabled: true
        };
        _profiles.push(newProfile);
        if (!_activeId) _activeId = newProfile.id;
      }

      await persist();
      const wasEditing = _editingId;
      _editingId = null;
      closeForm();
      render();
      showToast(wasEditing ? `Đã cập nhật profile "${name}"!` : `Đã thêm profile "${name}"! Key được mã hóa an toàn.`, 'success');
    };
  }

  // Initial load
  loadProfiles();
}

// Start app when DOM ready (browser only)
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
}

// Export testable functions for Node.js test runner
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { debounce, WorkerManager, getFinalUnitPrice };
}

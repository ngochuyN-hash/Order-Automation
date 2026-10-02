import { db } from '../../db.js';
import { store } from '../../store.js';
import { uiRenderer, escapeHtml, showToast, formatCurrency, setProgressbarAria } from '../../ui-renderer.js';
import { aiService } from '../../ai-service.js';
import { AI_PROVIDERS, resolveEndpoint } from '../../ai-providers.mjs';
import { findBestProductMatch } from '../../parser.js';
import { resolveSellerReceiver } from '../seller/manager.js';
import { trapFocus } from '../ui/confirm-dialog.js';
import { markDone } from '../order/pending.js';

// =========================================================================
//  KIOTVIET AUTOMATION CONTROLLER
// =========================================================================

/**
 * Clone sâu dữ liệu đơn (loại proxy/function) trước khi dựng dòng KV.
 * Cùng cách clone với cloneOrder() trong src/order/pending.js.
 */
function cloneOrderForKv(order) {
  return JSON.parse(JSON.stringify(order));
}

export const KiotVietAutomation = {
  mcpConnected: false,
  agentRunning: false,
  _abortFailsafeTimer: null,
  _aborting: false,
  /** Focus trap của modal KV (từ trapFocus trong src/ui/confirm-dialog.js). */
  _kvFocusTrap: null,
  /**
   * Ngữ cảnh của modal KV đang mở, đã "stage" sẵn:
   *   { orderData, pendingId, expectedSignature, onClose }
   * - orderData: payload đã dựng lúc MỞ panel → startOrder dùng luôn, không
   *   dựng lại (tránh đọc nhầm đơn khác nếu user đổi đơn trong lúc chờ).
   * - pendingId: id bản ghi chờ duyệt, capture CÙNG LÚC snapshot orderData.
   * - onClose: gọi đúng một lần khi modal thực sự đóng, kể cả sau completed,
   *   abort hoặc start-failed; không gọi sớm để tránh mở modal danh sách chồng lên.
   */
  _kvPanelContext: null,
  /** Context của run đã được backend nhận — giữ tới terminal event. */
  _activeKvContext: null,
  /** Callback quay lại danh sách, chỉ gọi khi modal KV thực sự đóng. */
  _deferredKvClose: null,
  /** runId của run đang chạy; terminal event lệch runId này → bỏ qua. */
  _activeRunId: null,
  /** Khoá đồng bộ chống bấm "Bắt đầu" hai lần khi preflight còn đang await. */
  _startInFlight: false,
  /** Bộ đếm sinh runId duy nhất cho từng lần bấm Bắt đầu. */
  _runSeq: 0,

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
          hint.textContent = kvVerifyCheckbox.checked ? '(kiểm tra & sửa lỗi trước submit)' : '(đang tắt — script điền xong là xong)';
          hint.style.color = kvVerifyCheckbox.checked ? 'var(--text-3)' : 'var(--orange)';
          hint.style.fontWeight = kvVerifyCheckbox.checked ? '400' : '600';
        }
      });
    }

    // Supplement toggle: cập nhật hint + cảnh báo chọn tab trước khi chạy
    const kvSupplementCheckbox = document.getElementById('kvSupplement');
    if (kvSupplementCheckbox) {
      kvSupplementCheckbox.addEventListener('change', () => {
        const hint = document.getElementById('kvSupplementHint');
        if (hint) {
          hint.textContent = kvSupplementCheckbox.checked
            ? '(đang bật — quét giỏ đã chọn & bổ sung phần thiếu)'
            : '(đang tắt — lên đơn vào giỏ mới)';
          hint.style.color = kvSupplementCheckbox.checked ? 'var(--green, #16a34a)' : 'var(--text-3)';
          hint.style.fontWeight = kvSupplementCheckbox.checked ? '600' : '400';
        }
      });
    }

    // PDF Save toggle: update hint text
    const kvPdfCheckbox = document.getElementById('kvSavePdf');
    if (kvPdfCheckbox) {
      kvPdfCheckbox.addEventListener('change', () => {
        const hint = document.getElementById('kvPdfHint');
        if (hint) {
          hint.textContent = kvPdfCheckbox.checked ? '(tự đặt hàng + in PDF ✓)' : '(tự đặt hàng + in PDF)';
          hint.style.color = kvPdfCheckbox.checked ? 'var(--green, #16a34a)' : 'var(--text-3)';
          hint.style.fontWeight = kvPdfCheckbox.checked ? '600' : '400';
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
      window.electronAPI.browserAgent.on('browser-agent:completed', (payload) => {
        const { steps, summary, orderCode, verifyBlocked } = payload || {};
        if (!this._isActiveKvEvent(payload)) return; // event của run cũ → bỏ qua
        this._clearAbortFailsafe();
        this._aborting = false;
        this.agentRunning = false;
        this.updateRunningState(false);
        this.appendLog({ source: 'agent', level: verifyBlocked ? 'warn' : 'info', msg: `${verifyBlocked ? '⚠ ĐIỀN XONG NHƯNG VERIFY LỆCH — CHƯA ĐẶT HÀNG' : '✅ ĐÃ HOÀN THÀNH LÊN ĐƠN!'} (${steps} bước) — ${summary || ''}` });
        if (orderCode) {
          this.appendLog({ source: 'agent', level: 'info', msg: `🧾 Mã đơn KiotViet: ${orderCode}` });
        }
        showToast(verifyBlocked
          ? 'VERIFY DOM phát hiện lệch — giỏ cần kiểm tra thủ công'
          : (orderCode
            ? `Lên đơn KiotViet thành công! Mã đơn: ${orderCode}`
            : 'Lên đơn KiotViet thành công!'), verifyBlocked ? 'error' : 'success');
        // Đánh dấu bước KV xong cho đơn đã lên — dùng id CAPTURE lúc mở panel
        // (KHÔNG đọc currentOrder lúc này: user có thể đang mở đơn khác trong
        // lúc agent chạy nền, đọc sẽ ĐÁNH DẤU NHẦM bản ghi của đơn đó).
        // markDone chỉ bật chip tiến độ; đơn vẫn ở chờ duyệt tới khi bấm Hoàn tất/Xóa.
        // verifyBlocked = chưa đặt hàng → tuyệt đối không bật chip KV xong.
        const ctx = this._takeActiveContext();
        if (ctx && ctx.pendingId && !verifyBlocked) {
          markDone(ctx.pendingId, 'kv', ctx.expectedSignature).catch((e) => console.warn('[KV] markDone pending failed:', e));
        }
        this._notifyContextClosed(ctx, verifyBlocked ? 'verify-blocked' : 'completed');
      });
      window.electronAPI.browserAgent.on('browser-agent:aborted', (payload) => {
        if (!this._isActiveKvEvent(payload)) return; // event của run cũ → bỏ qua
        this._clearAbortFailsafe();
        this._aborting = false;
        this.agentRunning = false;
        this.updateRunningState(false);
        this._releaseActiveRun('aborted'); // đơn CHƯA lên xong → giữ nguyên trong danh sách chờ
        this.appendLog({ source: 'agent', level: 'warn', msg: `⛔ Đã dừng Agent.` });
        showToast('Đã dừng tiến trình lên đơn KiotViet.', 'warn');
      });
      window.electronAPI.browserAgent.on('browser-agent:error', (payload) => {
        if (!this._isActiveKvEvent(payload)) return; // event của run cũ → bỏ qua
        this._clearAbortFailsafe();
        this._aborting = false;
        this.agentRunning = false;
        this.updateRunningState(false);
        this._releaseActiveRun('error'); // đơn CHƯA lên xong → giữ nguyên trong danh sách chờ
        this.appendLog({ source: 'agent', level: 'error', msg: `❌ Lỗi: ${(payload || {}).error}` });
        showToast(`Lỗi lên đơn KiotViet: ${(payload || {}).error}`, 'error');
      });
    }

    // Load warehouse rules config
    this.loadWarehouseRules();
  },

  // ==================== Warehouse Rules ====================
  _warehouseRules: { default: 'Tan Binh Warehouse', switchable: ['Tan Binh Warehouse', 'Transimex Warehouse'], errorOnly: ['Ha Noi Warehouse', 'Consignment Warehouse'] },
  _allWarehouses: ['Tan Binh Warehouse', 'Transimex Warehouse', 'Ha Noi Warehouse', 'Consignment Warehouse'],

  async loadWarehouseRules() {
    if (!window.electronAPI || !window.electronAPI.getWarehouseRules) return;
    try {
      const rules = await window.electronAPI.getWarehouseRules();
      if (rules) this._warehouseRules = rules;
    } catch (e) { /* use defaults */ }
    this.renderWarehouseRules();
  },

  renderWarehouseRules() {
    const switchableEl = document.getElementById('kvWhSwitchable');
    const errorOnlyEl = document.getElementById('kvWhErrorOnly');
    if (!switchableEl || !errorOnlyEl) return;

    const rules = this._warehouseRules;
    switchableEl.innerHTML = '';
    errorOnlyEl.innerHTML = '';

    this._allWarehouses.forEach(wh => {
      const isSwitchable = (rules.switchable || []).includes(wh);
      const isErrorOnly = (rules.errorOnly || []).includes(wh);

      // Switchable column
      const lbl1 = document.createElement('label');
      lbl1.style.cssText = 'display:flex; align-items:center; gap:5px; cursor:pointer; font-size:0.75rem;';
      const cb1 = document.createElement('input');
      cb1.type = 'checkbox';
      cb1.checked = isSwitchable;
      cb1.style.accentColor = 'var(--green, #16a34a)';
      cb1.addEventListener('change', () => this.toggleWarehouseRule(wh, 'switchable', cb1.checked));
      lbl1.appendChild(cb1);
      lbl1.appendChild(document.createTextNode(wh.replace(' Warehouse', '')));
      switchableEl.appendChild(lbl1);

      // Error-only column
      const lbl2 = document.createElement('label');
      lbl2.style.cssText = 'display:flex; align-items:center; gap:5px; cursor:pointer; font-size:0.75rem;';
      const cb2 = document.createElement('input');
      cb2.type = 'checkbox';
      cb2.checked = isErrorOnly;
      cb2.style.accentColor = 'var(--red, #dc2626)';
      cb2.addEventListener('change', () => this.toggleWarehouseRule(wh, 'errorOnly', cb2.checked));
      lbl2.appendChild(cb2);
      lbl2.appendChild(document.createTextNode(wh.replace(' Warehouse', '')));
      errorOnlyEl.appendChild(lbl2);
    });
  },

  async toggleWarehouseRule(warehouse, group, checked) {
    const rules = this._warehouseRules;
    // Remove from both groups first
    rules.switchable = (rules.switchable || []).filter(w => w !== warehouse);
    rules.errorOnly = (rules.errorOnly || []).filter(w => w !== warehouse);
    // Add to the selected group if checked
    if (checked) {
      rules[group].push(warehouse);
    }
    this._warehouseRules = rules;
    // Persist
    if (window.electronAPI && window.electronAPI.setWarehouseRules) {
      try { await window.electronAPI.setWarehouseRules(rules); } catch (e) { /* ignore */ }
    }
    this.renderWarehouseRules();
  },

  /**
   * Dựng payload gửi sang KiotViet.
   *
   * @param {{order:object, form:object}|null} snapshot - Khi truyền snapshot,
   *   mọi thông tin lấy từ snapshot (order + form) và TUYỆT ĐỐI không đọc DOM:
   *   đơn đang mở trên màn hình có thể đã là đơn khác trong lúc modal KV chờ
   *   user bấm Bắt đầu. Gọi không tham số → hành vi cũ: đọc currentOrder của
   *   store + các ô input trên UI.
   */
  buildOrderData(snapshot = null) {
    const sourceOrder = (snapshot && snapshot.order) || store.getState().currentOrder;
    if (!sourceOrder) return null;

    const form = (snapshot && snapshot.form) || null;
    // uiRenderer.getOrderTableRows() ghi đè item.subtotal → clone sâu trước khi
    // dựng dòng để KHÔNG mutate đơn gốc trong store/snapshot của phía gọi.
    let currentOrder;
    try {
      currentOrder = cloneOrderForKv(sourceOrder);
    } catch (error) {
      console.warn('[KV] Không thể clone an toàn đơn trước khi dựng payload:', error);
      return null;
    }

    let customer, payment, note;
    if (form) {
      customer = (form.customerName || '').trim() || (sourceOrder.customer || '');
      payment = form.payment || sourceOrder.payment || 'ck';
      note = (form.note || '').trim();
    } else {
      const custEl = document.getElementById('customerName');
      const payEl = document.getElementById('paymentMethod');
      const noteEl = document.getElementById('orderNote');
      customer = custEl ? custEl.value.trim() : (currentOrder.customer || '');
      payment = payEl ? payEl.value : (currentOrder.payment || 'ck');
      note = noteEl ? noteEl.value.trim() : '';
    }

    const { rows } = uiRenderer.getOrderTableRows(currentOrder);
    const allProducts = db.getAllProducts();
    const aliases = db.getAliases();

    // Dòng SL 0 (kể cả "0") không được biến thành 1 khi gửi sang KV.
    // Chỉ gửi SL hữu hạn, dương; giữ nguyên hàng tặng giá 0đ có SL hợp lệ.
    const items = rows.filter(r => Number.isFinite(Number(r.qty)) && Number(r.qty) > 0).map(r => {
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
      const isGiftRow = !!r.isGift || r.type === 'gift' || Number(r.subtotal) === 0 || Number(r.bottlePrice) === 0;
      const kvPrice = isGiftRow ? 0 : (r.subtotal ? Math.round(r.subtotal / (r.qty || 1)) : 0);

      return {
        code: kvCode,
        name: displayName,
        qty: Number(r.qty),
        unit: r.unit || 'thùng',
        price: kvPrice,
        isGift: isGiftRow,
        giftKind: r.giftKind || (isGiftRow ? 'foc' : undefined),
        productId: prodObj ? prodObj.id : (r.productId || null)
      };
    });

    // Get receiver (Người nhận đặt) from seller dropdown/input
    // Use kvName (exact KiotViet name) if configured, otherwise use display name
    let rawSellerVal;
    if (form) {
      rawSellerVal = (form.sellerKey || '').trim();
    } else {
      const sellerHidden = document.getElementById('sellerName');
      const sellerSearch = document.getElementById('sellerSearch');
      rawSellerVal = (sellerHidden?.value || sellerSearch?.value || '').trim();
    }

    const receiver = resolveSellerReceiver(rawSellerVal);

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
        // Generate options from registry
        select.innerHTML = Object.entries(AI_PROVIDERS).map(([id, p]) =>
          `<option value="${id}">${p.icon} ${p.label}${p.local ? ' (Local)' : ''}</option>`
        ).join('');
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

  /**
   * Dựng aiConfig cho AI Verify từ lựa chọn trong dropdown modal KV.
   * - Profile được chọn (id trong danh sách enabled) → truyền đúng provider/key/model/endpoint.
   * - Chưa có profile (fallback tĩnh) → dùng config phân tích nếu khớp provider đang chọn.
   * - 'lmstudio' hoặc không resolve được → trả null (agent dùng LM Studio mặc định như cũ).
   */
  async _resolveKvAiConfig(selectedValue) {
    if (!selectedValue || selectedValue === 'lmstudio') return null;
    try {
      const { profiles = [] } = await aiService.getProfiles();
      const enabled = profiles.filter(p => p.enabled && p.keyError !== 'decrypt_failed');
      const picked = enabled.find(p => p.id === selectedValue);
      if (picked) {
        return {
          provider: picked.provider,
          apiKey: picked.apiKey || '',
          model: picked.model || '',
          endpoint: resolveEndpoint(picked.provider, picked.endpoint || '')
        };
      }
      if (enabled.length === 0) {
        const cfg = await aiService.getConfig();
        if (cfg && cfg.provider === selectedValue) {
          return {
            provider: cfg.provider,
            apiKey: cfg.apiKey || '',
            model: cfg.model || '',
            endpoint: resolveEndpoint(cfg.provider, cfg.endpoint || '')
          };
        }
      }
    } catch (e) { /* giữ hành vi mặc định (LM Studio) */ }
    return null;
  },

  /**
   * Mở modal KV cho đơn ĐANG MỞ trên màn hình (nút "Lên đơn KiotViet").
   * Dựng orderData + capture id chờ duyệt, rồi stage vào context của panel.
   */
  async openPanel() {
    // Capture id cùng lúc snapshot orderData, TRƯỚC mọi await. Event completed
    // có thể đến vài phút sau; currentOrder lúc đó có thể đã là đơn khác.
    const pendingId = (store.getState().currentOrder || {})._pendingId || null;
    return this._openKvPanel({ orderData: this.buildOrderData(), pendingId, expectedSignature: null, onClose: null });
  },

  /**
   * Mở modal KV cho một snapshot đơn BẤT KỲ (không phụ thuộc đơn đang mở).
   * Dùng cho luồng duyệt/lên đơn từ danh sách chờ: toàn bộ tên KH, hình thức
   * thanh toán, ghi chú, người nhận đặt đến từ snapshot.form — KHÔNG đọc DOM.
   *
   * CHỈ mở modal để user xem/xác nhận: KHÔNG tự bấm Bắt đầu.
   * @param {{order:object, form:object, pendingId?:string, expectedSignature?:string}} snapshot
   * @param {{pendingId?:string, expectedSignature?:string, onClose?:function}} options
   *        onClose({ reason }) được gọi ĐÚNG MỘT LẦN sau khi modal đóng:
   *        'closed' | 'completed' | 'start-failed' | 'aborted' | 'error'.
   * @returns {Promise<boolean>} true nếu modal đã mở.
   */
  async openPanelForOrder(snapshot, options = {}) {
    if (!snapshot || !snapshot.order) {
      showToast('Không có dữ liệu đơn để lên KiotViet.', 'warn');
      return false;
    }
    return this._openKvPanel({
      orderData: this.buildOrderData(snapshot),
      pendingId: options.pendingId || snapshot.pendingId || (snapshot.order || {})._pendingId || null,
      expectedSignature: options.expectedSignature || snapshot.expectedSignature || null,
      onClose: typeof options.onClose === 'function' ? options.onClose : null
    });
  },

  /**
   * Thân dùng chung của openPanel/openPanelForOrder: dựng preview, stage context
   * rồi mở modal. KHÔNG tự chạy agent.
   * @returns {Promise<boolean>} true nếu modal đã mở.
   */
  async _openKvPanel(context) {
    const modal = document.getElementById('modalKiotViet');
    if (!modal) return false;

    const orderData = context.orderData;
    if (!orderData || orderData.items.length === 0) {
      showToast('Đơn hàng hiện chưa có sản phẩm nào.', 'warn');
      return false;
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
        const giftTag = item.isGift ? ` <span class="gift-badge">${item.giftKind === 'extra' ? 'EXTRA' : 'FOC'}</span>` : '';

        return `<tr>
          <td>${codeChip}</td>
          <td>${escapeHtml(item.name)}${giftTag}</td>
          <td class="text-center font-weight-bold">${item.qty} ${escapeHtml(item.unit)}</td>
          <td class="text-right">${priceStr}</td>
        </tr>`;
      }).join('');
    }

    // Stage context TRƯỚC await: giữ đúng orderData/pendingId đã preview.
    this._kvPanelContext = context;

    // Sync AI Provider with the analysis AI (respecting manual override)
    await this.syncAiProvider();

    this.updateStepProgress(0, 4);
    modal.style.display = 'flex';

    // Khóa focus trong modal + Esc-to-close. LƯU Ý: agent đang chạy hoặc đang
    // abort thì Esc KHÔNG đóng modal (onEscape bỏ qua) — chặn cả việc Esc lan
    // xuống overlay bên dưới vì trapFocus đã stopPropagation.
    this._kvFocusTrap = trapFocus(modal, {
      onEscape: () => {
        if (this.agentRunning || this._aborting) return; // đang chạy → không đóng
        this.closePanel();
      }
    });
    return true;
  },

  /** Event terminal có thuộc run đang chạy không? */
  _isActiveKvEvent(payload) {
    if (!this._activeRunId) return false;
    const eventRunId = payload && payload.runId;
    // Event KHÔNG mang runId (vd. lỗi phát ra thẳng từ tầng IPC khi agent
    // ném trước khi chạy) vẫn thuộc run đang active. Event có runId thì chỉ
    // nhận đúng run; event cũ sau khi run đã kết thúc bị bỏ qua.
    if (!eventRunId) return true;
    return eventRunId === this._activeRunId;
  },

  /** Lấy + xoá context của run đang chạy (dùng ở terminal event). */
  _takeActiveContext() {
    const ctx = this._activeKvContext;
    this._activeKvContext = null;
    this._activeRunId = null;
    return ctx;
  },

  /** Nhả context staged của panel (chưa chạy) + báo onClose đúng một lần. */
  _releaseKvContext(reason) {
    const ctx = this._kvPanelContext;
    this._kvPanelContext = null;
    this._notifyContextClosed(ctx, reason);
  },

  /** Nhả context của run đã nhận (chưa có terminal event) + báo onClose. */
  _releaseActiveRun(reason) {
    const ctx = this._takeActiveContext();
    this._notifyContextClosed(ctx, reason);
  },

  _notifyContextClosed(ctx, reason) {
    if (!ctx || typeof ctx.onClose !== 'function') return;
    this._deferredKvClose = {
      callback: ctx.onClose,
      reason: reason || 'closed'
    };
  },

  /** Chỉ gọi callback về danh sách sau khi modal đã ẩn và focus trap đã gỡ. */
  _flushDeferredKvClose() {
    const deferred = this._deferredKvClose;
    this._deferredKvClose = null;
    if (!deferred) return;
    try {
      deferred.callback({ reason: deferred.reason });
    } catch (e) {
      console.warn('[KV] onClose của panel context lỗi:', e);
    }
  },

  closePanel() {
    // Đang chạy / đang dừng / đang khởi tạo → KHÔNG đóng (nút X và Esc đều
    // bị chặn) để context run không bị mất giữa chừng.
    if (this.agentRunning || this._aborting || this._startInFlight) return;
    const modal = document.getElementById('modalKiotViet');
    if (modal) modal.style.display = 'none';
    // Gỡ focus trap + trả focus về element đã mở modal
    if (this._kvFocusTrap) {
      this._kvFocusTrap.release();
      this._kvFocusTrap = null;
    }
    this._releaseKvContext('closed');
    this._flushDeferredKvClose();
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
    // Khoá đồng bộ TRƯỚC mọi await: bấm hai lần liên tiếp phải chỉ chạy 1 lần.
    if (this._startInFlight) {
      showToast('Đang khởi tạo lên đơn, vui lòng đợi...', 'warn');
      return;
    }
    this._startInFlight = true;
    const runId = this._newRunId();
    try {
      if (this.agentRunning) {
        // Self-heal: UI thinks it's running but the backend may already be idle
        // (e.g. terminal event was lost after an abort). Verify before blocking.
        try {
          const status = await window.electronAPI.browserAgent.status();
          if (status && !status.running) {
            this._clearAbortFailsafe();
            this.agentRunning = false;
            this.updateRunningState(false);
          } else {
            showToast('Agent đang chạy. Bấm "Dừng (Abort)" và chờ dừng xong trước khi chạy lại.', 'warn');
            return;
          }
        } catch (e) {
          return;
        }
      }

      // Dùng đúng orderData đã stage lúc mở panel (KHÔNG dựng lại từ UI/đơn
      // hiện tại). Chỉ khi không có context (mở modal bằng cách khác) mới
      // fallback dựng từ đơn đang mở.
      const orderData = (this._kvPanelContext && this._kvPanelContext.orderData) || this.buildOrderData();
      if (!orderData || orderData.items.length === 0) {
        showToast('Đơn hàng rỗng, không thể lên đơn.', 'warn');
        this._releaseKvContext('start-failed');
        return;
      }

      // Verify browser extension connection right before starting
      const snapRes = await window.electronAPI.browserAgent.snapshot();
      if (!snapRes.success) {
        showToast('Chưa kết nối được với Chrome. Hãy bấm "Kết nối Browser" và thử lại!', 'error');
        this.appendLog({ source: 'system', level: 'error', msg: '❌ Chưa kết nối được với Chrome. Hãy bấm "Kết nối Browser" trước.' });
        this._releaseKvContext('start-failed'); // chưa chạy được → panel không còn giữ đơn này
        return;
      }

      const providerSelect = document.getElementById('kvAiProviderSelect');
      const selectedValue = providerSelect ? providerSelect.value : 'lmstudio';
      // AI Verify phải dùng đúng AI user chọn trong dropdown (trước đây selectedValue
      // bị đọc nhưng không truyền đi — verify luôn chạy LM Studio mặc định)
      const aiVerifyConfig = await this._resolveKvAiConfig(selectedValue);

      this.agentRunning = true;
      this.updateRunningState(true);
      this.updateStepProgress(0, 4);

      // DIRECT SCRIPT PIPELINE: Pure JS Script fill (Zero AI) → Optional Submit → PDF
      const aiVerifyCheckbox = document.getElementById('kvAiVerify');
      const skipVerify = aiVerifyCheckbox ? !aiVerifyCheckbox.checked : true;
      const savePdfCheckbox = document.getElementById('kvSavePdf');
      const savePdf = savePdfCheckbox ? savePdfCheckbox.checked : false;
      const autoSubmit = savePdf; // PDF requires auto-submit
      // Chế độ lên đơn: 'supplement' = bổ sung đúng giỏ user đã chọn trên KiotViet
      // (scan từng dòng → đủ SL bỏ qua / lệch SL sửa / thiếu thêm), 'new' = giỏ sạch
      const supplementCheckbox = document.getElementById('kvSupplement');
      const mode = (supplementCheckbox && supplementCheckbox.checked) ? 'supplement' : 'new';

      this.appendLog({ source: 'system', level: 'info', msg: `🚀 Chạy Script điền đơn siêu tốc (${mode === 'supplement' ? 'BỔ SUNG giỏ đang mở' : 'giỏ mới'}): ${orderData.customer || 'Khách lẻ'} (${orderData.items.length} sản phẩm)...` });

      // Nâng context staged → active TRƯỚC khi gọi IPC: terminal event có
      // thể về trước khi promise của invoke resolve. Giữ tới event kết thúc.
      this._activeKvContext = this._kvPanelContext;
      this._kvPanelContext = null;
      this._activeRunId = runId;

      try {
        const runOpts = { mode, skipVerify, autoSubmit, savePdf, warehouseRules: this._warehouseRules, runId };
        if (aiVerifyConfig) runOpts.aiConfig = aiVerifyConfig;
        const res = await window.electronAPI.browserAgent.runOrder(orderData, runOpts);
        if (!res.success) {
          // Backend không nhận run → trả lại trạng thái, giữ nguyên danh sách chờ
          this.agentRunning = false;
          this.updateRunningState(false);
          this._releaseActiveRun('start-failed');
          this.appendLog({ source: 'system', level: 'error', msg: `❌ Không thể bắt đầu: ${res.error}` });
          showToast(res.error, 'error');
        }
      } catch (err) {
        this.agentRunning = false;
        this.updateRunningState(false);
        this._releaseActiveRun('start-failed');
        this.appendLog({ source: 'system', level: 'error', msg: `❌ Lỗi khởi chạy: ${err.message}` });
      }
    } finally {
      this._startInFlight = false;
    }
  },

  /** runId duy nhất cho từng lần bấm Bắt đầu (để lọc event của run cũ). */
  _newRunId() {
    this._runSeq = (this._runSeq || 0) + 1;
    return `kv-${Date.now().toString(36)}-${this._runSeq}`;
  },

  async abortOrder() {
    if (!window.electronAPI || !window.electronAPI.browserAgent) return;
    const btnAbort = document.getElementById('btnKvAbort');

    // SECOND PRESS while stopping → FORCE RESET (restart mechanism):
    // kill the run state entirely so a new order can start immediately.
    if (this._aborting) {
      try { await window.electronAPI.browserAgent.reset(); } catch (e) { /* ignore */ }
      this._clearAbortFailsafe();
      this._aborting = false;
      this.agentRunning = false;
      this.updateRunningState(false);
      this._releaseActiveRun('aborted'); // run đã bị reset → không còn terminal event
      this.appendLog({ source: 'system', level: 'warn', msg: '🔄 Đã RESET agent — bạn có thể bấm "Bắt đầu lên đơn" lại ngay.' });
      showToast('Đã reset tiến trình lên đơn KiotViet. Sẵn sàng chạy lại!', 'warn');
      return;
    }

    // FIRST PRESS → hard abort (in-flight MCP call is rejected immediately)
    this._aborting = true;
    if (btnAbort) { btnAbort.disabled = false; btnAbort.textContent = '⏳ Đang dừng... (bấm lần nữa để RESET)'; }
    try {
      await window.electronAPI.browserAgent.abort();
    } catch (e) { /* ignore */ }
    this.appendLog({ source: 'system', level: 'warn', msg: 'Đã yêu cầu dừng Agent...' });

    // Failsafe: if the backend never emits a terminal event (completed/aborted/error),
    // force-unlock the UI so the user can always restart with a new order.
    this._clearAbortFailsafe();
    this._abortFailsafeTimer = setTimeout(async () => {
      this._abortFailsafeTimer = null;
      if (!this.agentRunning) return;
      let backendRunning = false;
      try {
        const status = await window.electronAPI.browserAgent.status();
        backendRunning = !!(status && status.running);
      } catch (e) { backendRunning = false; }
      if (!backendRunning) {
        this._aborting = false;
        this.agentRunning = false;
        this.updateRunningState(false);
        this._releaseActiveRun('aborted'); // backend đã dừng, không còn terminal event
        this.appendLog({ source: 'system', level: 'warn', msg: '⛔ Đã dừng Agent (failsafe). Bạn có thể bấm "Bắt đầu lên đơn" lại.' });
        showToast('Đã dừng tiến trình lên đơn KiotViet.', 'warn');
      } else {
        this.appendLog({ source: 'system', level: 'warn', msg: '⏳ Agent chưa dừng hẳn — bấm "Dừng" LẦN NỮA để RESET cưỡng bức.' });
      }
    }, 6000);
  },

  _clearAbortFailsafe() {
    if (this._abortFailsafeTimer) {
      clearTimeout(this._abortFailsafeTimer);
      this._abortFailsafeTimer = null;
    }
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
    if (btnDisconnect) btnDisconnect.classList.toggle('hidden', !connected);
    if (btnStart) btnStart.disabled = !connected || this.agentRunning;
  },

  updateRunningState(running) {
    const btnStart = document.getElementById('btnKvStart');
    const btnAbort = document.getElementById('btnKvAbort');
    if (btnStart) {
      btnStart.disabled = running || !this.mcpConnected;
      btnStart.textContent = running ? '⏳ Đang lên đơn...' : '▶️ Bắt đầu lên đơn';
    }
    if (btnAbort) {
      btnAbort.classList.toggle('hidden', !running);
      if (!running) {
        this._aborting = false;
        btnAbort.disabled = false;
        btnAbort.textContent = '⛔ Dừng (Abort)';
      }
    }
  },

  updateStepProgress(step, maxSteps) {
    const indicator = document.getElementById('kvStepIndicator');
    const bar = document.getElementById('kvProgressBar');
    if (indicator) indicator.textContent = `Bước ${step}/${maxSteps}`;
    if (bar) {
      const pct = Math.min(100, Math.round((step / maxSteps) * 100));
      bar.style.width = `${pct}%`;
      // A11y: role="progressbar" đặt trên WRAPPER (phần tử gốc không đổi width),
      // đồng bộ aria-valuenow/min/max với % hiển thị. Helper an toàn: tự thêm
      // role nếu markup chưa có (markup index.html do người khác quản lý).
      setProgressbarAria(bar.parentElement, pct);
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

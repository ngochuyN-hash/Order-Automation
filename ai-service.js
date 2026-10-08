/**
 * =========================================================================
 *  ORDER AUTOMATION - AI SERVICE (ai-service.js)
 * =========================================================================
 *  Handles LLM API communication with MULTI-PROFILE support:
 *  - Multiple API keys / providers (add/remove freely)
 *  - Providers: Gemini, OpenAI, Anthropic Claude, DeepSeek, Groq,
 *    OpenRouter, Mistral AI, Qwen, Z.AI (GLM), Ollama, LM Studio, Custom
 *  - Strategies: Failover (try next on error) & Round-Robin (cost spread)
 *  - API key encryption via Electron safeStorage
 * =========================================================================
 */

import { getProviderConfig, buildAuthHeaders, resolveEndpoint, normalizeEndpointUrl, resolveTestUrl, detectApiProtocol, supportsStructuredOutput } from './ai-providers.mjs';
import { showToast } from './ui-renderer.js';
import { extractJSON } from './src/order/json-extractor.js';
import { ORDER_SEMANTICS, buildGeminiResponseSchema, buildOpenAIJsonSchema } from './src/order/order-schema.mjs';
import { normalizeFull, stripQtyJunk } from './parser.js';

// Warn the user when the API key could NOT be persisted by the main process
// (safeStorage unavailable) — otherwise the key silently disappears on restart.
function warnIfKeyNotPersisted(res, hasKey) {
  if (hasKey && res && res.keyPersisted === false) {
    showToast('⚠️ Không thể lưu API key (safeStorage không khả dụng) — bạn sẽ phải nhập lại key mỗi phiên.', 'error', null);
  }
}

const AI_CONFIG_KEY = 'order_automation_ai_config_v2';
const AI_PROFILES_KEY = 'order_automation_ai_profiles_v1';
const SALT = 42;

// Timeout mỗi request AI — chống treo vĩnh viễn khi mạng đứt / server không phản hồi.
// 3 phút: đủ cho model local chậm, nhưng không khiến user đờ man vô hạn.
const AI_REQUEST_TIMEOUT_MS = 180000;
// Số lần thử lại khi bị rate limit (HTTP 429), backoff tăng dần 2s → 4s.
const RATE_LIMIT_RETRIES = 2;

// Obfuscate helper
function obfuscate(str) {
  if (!str) return '';
  return btoa(str.split('').map(c => String.fromCharCode(c.charCodeAt(0) ^ SALT)).join(''));
}

// Deobfuscate helper
function deobfuscate(encoded) {
  if (!encoded) return '';
  try {
    return atob(encoded).split('').map(c => String.fromCharCode(c.charCodeAt(0) ^ SALT)).join('');
  } catch (e) {
    return encoded;
  }
}

const aiService = {
  // Round-robin index (in-memory, resets per session)
  _rrIndex: 0,

  // ==================== Profile Management ====================

  /**
   * Get all AI profiles + strategy + activeId.
   * Returns { profiles: [], strategy: 'failover'|'roundrobin', activeId: '' }
   */
  async getProfiles() {
    if (window.electronAPI && window.electronAPI.getAiProfiles) {
      try {
        return await window.electronAPI.getAiProfiles();
      } catch (e) {
        console.warn('[AI Profiles] IPC error:', e);
      }
    }
    // Fallback: localStorage
    try {
      const raw = localStorage.getItem(AI_PROFILES_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        const profiles = (data.profiles || []).map(p => ({ ...p, apiKey: p.apiKey ? deobfuscate(p.apiKey) : '' }));

        // Idempotent migration: Qwen profiles with legacy model 'qwen-plus' -> 'qwen3.7-plus'
        // (Token Plan endpoint only supports qwen3.7-plus/qwen3.7-max/qwen3.6-plus/qwen3.6-flash).
        let migrated = false;
        for (const p of profiles) {
          if (p && p.provider === 'qwen' && /^qwen-(plus|max|turbo)$/.test(p.model)) {
            p.model = 'qwen3.7-plus';
            migrated = true;
          }
        }
        if (migrated) {
          try {
            await this.saveProfiles(profiles, data.strategy || 'failover', data.activeId || '');
          } catch (e) { console.warn('[AI Profiles] persist migration failed:', e); }
        }

        return {
          profiles,
          strategy: data.strategy || 'failover',
          activeId: data.activeId || ''
        };
      }
    } catch (e) { console.warn('[AI Profiles] localStorage read error:', e); }
    return { profiles: [], strategy: 'failover', activeId: '' };
  },

  /**
   * Save all AI profiles + strategy + activeId.
   */
  async saveProfiles(profiles, strategy, activeId) {
    if (window.electronAPI && window.electronAPI.setAiProfiles) {
      await window.electronAPI.setAiProfiles({ profiles, strategy, activeId });
      return;
    }
    // Fallback: localStorage with obfuscation
    const data = {
      profiles: profiles.map(p => ({ ...p, apiKey: p.apiKey ? obfuscate(p.apiKey) : '' })),
      strategy,
      activeId
    };
    localStorage.setItem(AI_PROFILES_KEY, JSON.stringify(data));
  },

  /**
   * Retrieves the active AI configuration (backward-compatible single config).
   * Priority: active profile > first enabled profile > legacy config.
   */
  async getConfig() {
    // If profiles exist, return the active profile as legacy config
    try {
      const { profiles, activeId } = await this.getProfiles();
      const enabled = profiles.filter(p => p.enabled);
      if (enabled.length > 0) {
        const active = enabled.find(p => p.id === activeId) || enabled[0];
        return { provider: active.provider, apiKey: active.apiKey || '', model: active.model || '', endpoint: active.endpoint || '' };
      }
    } catch (e) { /* fall through to legacy */ }

    if (window.electronAPI && window.electronAPI.getAiConfig) {
      try {
        const electronConfig = await window.electronAPI.getAiConfig();
        if (electronConfig && electronConfig.provider && electronConfig.provider !== 'none') {
          if (electronConfig.model === 'gemini-3.5-flash') {
            electronConfig.model = 'gemini-2.5-flash';
          }
          if (/^qwen-(plus|max|turbo)$/.test(electronConfig.model)) {
            electronConfig.model = 'qwen3.7-plus';
          }
          return electronConfig;
        }
        // Try migrating from legacy IndexedDB config if present
        const legacyConfig = await dbStore.get(AI_CONFIG_KEY);
        if (legacyConfig && legacyConfig.provider && legacyConfig.provider !== 'none') {
          console.log('[AI Config Migration] Migrating legacy config from IndexedDB to safeStorage...');
          if (legacyConfig.apiKey) {
            legacyConfig.apiKey = deobfuscate(legacyConfig.apiKey);
          }
          if (legacyConfig.model === 'gemini-3.5-flash') {
            legacyConfig.model = 'gemini-2.5-flash';
          }
          if (/^qwen-(plus|max|turbo)$/.test(legacyConfig.model)) {
            legacyConfig.model = 'qwen3.7-plus';
          }
          const migrationRes = await window.electronAPI.setAiConfig(legacyConfig);
          warnIfKeyNotPersisted(migrationRes, !!legacyConfig.apiKey);
          await dbStore.remove(AI_CONFIG_KEY);
          return legacyConfig;
        }
      } catch (e) {
        console.warn('Error reading from safeStorage/migrating legacy config:', e);
      }
    }

    // Fallback logic for browser / non-Electron envs
    try {
      const config = await dbStore.get(AI_CONFIG_KEY);
      if (config) {
        if (config.apiKey) {
          config.apiKey = deobfuscate(config.apiKey);
        }
        if (config.model === 'gemini-3.5-flash') {
          config.model = 'gemini-2.5-flash';
        }
        if (/^qwen-(plus|max|turbo)$/.test(config.model)) {
          config.model = 'qwen3.7-plus';
        }
        return config;
      }
    } catch (e) {
      console.warn('Failed to load AI config from IndexedDB:', e);
    }
    return { provider: 'none', apiKey: '', model: '', endpoint: '' };
  },

  /**
   * Saves the AI configuration (legacy single-config API, kept for compat).
   */
  async saveConfig(config) {
    if (window.electronAPI && window.electronAPI.setAiConfig) {
      const res = await window.electronAPI.setAiConfig(config);
      warnIfKeyNotPersisted(res, !!(config && config.apiKey));
      return;
    }
    const toSave = { ...config };
    if (toSave.apiKey) {
      toSave.apiKey = obfuscate(toSave.apiKey);
    }
    await dbStore.set(AI_CONFIG_KEY, toSave);
  },

  getDefaultModel(provider) {
    return getProviderConfig(provider).defaultModel || '';
  },

  getEndpointForProvider(provider, customEndpoint) {
    return resolveEndpoint(provider, customEndpoint);
  },

  /**
   * Normalize a custom endpoint URL to full OpenAI-compatible chat completions path.
   */
  normalizeEndpoint(url) {
    return normalizeEndpointUrl(url);
  },

  /**
   * Test a single profile's connectivity. Returns { ok, message, models? }
   * Generic: works for ANY provider in the registry without per-provider code.
   */
  async testProfile(profile) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);

      const testUrl = resolveTestUrl(profile.provider, profile.apiKey, profile.endpoint);
      if (!testUrl) {
        clearTimeout(timer);
        return { ok: false, message: 'Provider chưa hỗ trợ test.' };
      }

      const headers = buildAuthHeaders(profile.provider, profile.apiKey);
      const res = await fetch(testUrl, { signal: ctrl.signal, headers });
      clearTimeout(timer);

      if (!res.ok) {
        // Fallback: Với custom/zai hoặc proxy không hỗ trợ GET /models (404/405), thử ping trực tiếp endpoint chat/completions
        if ((res.status === 404 || res.status === 405) && (profile.provider === 'custom' || profile.provider === 'zai')) {
          const pingRes = await this._testChatPing(profile);
          if (pingRes) return pingRes;
        }
        return { ok: false, message: `HTTP ${res.status}${res.status === 401 ? ' — API Key không hợp lệ' : ''}` };
      }

      const data = await res.json();

      // Gemini returns { models: [...] }, others return { data: [...] }
      if (profile.provider === 'gemini') {
        const models = (data.models || []).map(m => m.name.replace('models/', '')).filter(m => m.includes('flash') || m.includes('pro')).slice(0, 6);
        return { ok: true, message: models.length ? `OK — ${models.join(', ')}` : 'API Key hợp lệ!', models };
      }

      const models = (data.data || []).map(m => m.id);
      if (profile.provider === 'openrouter') {
        return { ok: true, message: `API Key hợp lệ! ${models.length} models khả dụng.` };
      }
      return { ok: true, message: models.length ? `OK — ${models.slice(0, 8).join(', ')}` : 'API Key hợp lệ!', models: models.slice(0, 20) };
    } catch (e) {
      if (e.name === 'AbortError') return { ok: false, message: 'Timeout — server không phản hồi (8s).' };
      return { ok: false, message: `Không kết nối được: ${e.message}` };
    }
  },

  /**
   * Ping chat/completions directly with 1 token to test endpoint + key if /models is unsupported.
   */
  async _testChatPing(profile) {
    try {
      const endpoint = resolveEndpoint(profile.provider, profile.endpoint);
      if (!endpoint) return null;
      const headers = { "Content-Type": "application/json", ...buildAuthHeaders(profile.provider, profile.apiKey) };
      const model = profile.model || this.getDefaultModel(profile.provider) || 'glm-4.7-flash';
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch(endpoint, {
        method: "POST",
        headers,
        signal: ctrl.signal,
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 2
        })
      });
      clearTimeout(timer);
      if (res.ok) {
        return { ok: true, message: `Kết nối thành công! (${model})` };
      }
      return { ok: false, message: `HTTP ${res.status}${res.status === 401 ? ' — API Key không hợp lệ' : ''}` };
    } catch (e) {
      return null;
    }
  },

  // ==================== AI Calling (Multi-Profile) ====================

  /**
   * Generic AI call with a custom system prompt (for non-order-parsing tasks
   * like file resolution diagnosis). Returns parsed JSON.
   * @param {AbortSignal} [signal] - Optional signal to cancel the request.
   */
  async callAICustom(userPrompt, systemPrompt, signal) {
    const { profiles, strategy, activeId } = await this.getProfiles();
    let enabled = profiles.filter(p => p.enabled);

    if (enabled.length === 0) {
      const config = await this.getConfig();
      const _cfg = getProviderConfig(config.provider);
      if (!config.apiKey && !_cfg.local && config.provider !== 'custom') {
        throw new Error('Chưa cấu hình AI!');
      }
      enabled = [{ id: '_legacy', name: 'Legacy', provider: config.provider, apiKey: config.apiKey, model: config.model, endpoint: config.endpoint, enabled: true }];
    }

    let ordered = [...enabled];
    if (strategy === 'roundrobin' && enabled.length > 1) {
      const startIdx = this._rrIndex % enabled.length;
      ordered = [...enabled.slice(startIdx), ...enabled.slice(0, startIdx)];
      this._rrIndex++;
    } else {
      const activeIdx = ordered.findIndex(p => p.id === activeId);
      if (activeIdx > 0) {
        ordered = [ordered[activeIdx], ...ordered.slice(0, activeIdx), ...ordered.slice(activeIdx + 1)];
      }
    }

    const errors = [];
    for (const profile of ordered) {
      if (signal && signal.aborted) throw new DOMException('Đã hủy yêu cầu AI.', 'AbortError');
      try {
        return await this._callSingle(profile, userPrompt, systemPrompt, signal);
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        errors.push(`[${profile.name}] ${err.message}`);
        if (ordered.length > 1) continue;
      }
    }
    throw new Error(`AI lỗi: ${errors.join('\n')}`);
  },

  /**
   * Calls the configured LLM to parse the order message.
   * Uses profiles with failover or round-robin strategy.
   * @param {string} text - The order message text.
   * @param {string} memory - Business rules memory.
   * @param {Array} [products] - (Unused, kept for API compat) Product matching is now local.
   * @param {AbortSignal} [signal] - Optional signal to cancel the request.
   */
  async callAI(text, memory, products, signal) {
    const { profiles, strategy, activeId } = await this.getProfiles();
    let enabled = profiles.filter(p => p.enabled);

    // Fallback to legacy single config if no profiles
    if (enabled.length === 0) {
      const config = await this.getConfig();
      const _cfg2 = getProviderConfig(config.provider);
      if (!config.apiKey && !_cfg2.local && config.provider !== 'custom') {
        throw new Error('Chưa cấu hình AI! Vào Cài Đặt → AI → Thêm profile AI để bắt đầu.');
      }
      enabled = [{ id: '_legacy', name: 'Legacy', provider: config.provider, apiKey: config.apiKey, model: config.model, endpoint: config.endpoint, enabled: true }];
    }

    // Order profiles based on strategy
    let ordered = [...enabled];
    if (strategy === 'roundrobin' && enabled.length > 1) {
      const startIdx = this._rrIndex % enabled.length;
      ordered = [...enabled.slice(startIdx), ...enabled.slice(0, startIdx)];
      this._rrIndex++;
    } else {
      // Failover: active profile first, then the rest
      const activeIdx = ordered.findIndex(p => p.id === activeId);
      if (activeIdx > 0) {
        ordered = [ordered[activeIdx], ...ordered.slice(0, activeIdx), ...ordered.slice(activeIdx + 1)];
      }
    }

    const errors = [];

    for (const profile of ordered) {
      if (signal && signal.aborted) throw new DOMException('Đã hủy yêu cầu AI.', 'AbortError');
      // Prompt theo từng profile: provider có schema enforcement thì bỏ JSON mẫu
      // (API đã ép cấu trúc), còn lại giữ mẫu để model biết format mong muốn.
      const cap = supportsStructuredOutput(profile.provider);
      const systemPrompt = this._buildSystemPrompt(memory, products, {
        jsonExample: cap !== 'native' && cap !== 'schema'
      });
      // Lỗi JSON/rỗng thường là nhiễu tạm thời (sampling, network) → retry ĐÚNG
      // profile 1 lần trước khi failover sang profile kế.
      let jsonRetryUsed = false;
      while (true) {
        try {
          const result = await this._callSingle(profile, text, systemPrompt, signal);
          // Log which profile succeeded (useful for multi-key debugging)
          if (ordered.length > 1) {
            console.log(`[AI] ✅ Profile "${profile.name}" (${profile.provider}) responded OK.`);
          }
          return result;
        } catch (err) {
          if (err.name === 'AbortError') throw err;
          const isJsonError = /không phải JSON hợp lệ|phản hồi rỗng|không trả về kết quả hợp lệ/i.test(err.message);
          if (isJsonError && !jsonRetryUsed) {
            jsonRetryUsed = true;
            console.warn(`[AI] ⚠️ Profile "${profile.name}" trả JSON lỗi (${err.message.slice(0, 80)}) — thử lại đúng profile...`);
            continue;
          }
          errors.push(`[${profile.name}] ${err.message}`);
          console.warn(`[AI] ⚠️ Profile "${profile.name}" failed: ${err.message} — trying next...`);
          break;
        }
      }
    }

    const brokenKeys = ordered.filter(p => p.keyError === 'decrypt_failed').length;
    const hint = brokenKeys > 0
      ? `\n\n💡 ${brokenKeys} profile không giải mã được API key — vào Cài Đặt → AI để nhập lại key.`
      : '';
    throw new Error(`Tất cả AI profiles đều lỗi:\n${errors.join('\n')}${hint}`);
  },

  /**
   * Build the system prompt for order parsing.
   * Architecture: AI only extracts structured data from the message.
   * Product matching is done locally by the system (parser.js) — NO product
   * catalog is sent to AI, keeping the prompt lightweight regardless of DB size.
   */
  _buildSystemPrompt(memory, products, { jsonExample = true } = {}) {
    // Provider có schema enforcement ('native'/'schema') → API tự ÉP cấu trúc,
    // không cần JSON mẫu dài trong prompt. 'object' / prefill / local → vẫn cần mẫu.
    const tailBlock = jsonExample
      ? `Hãy trả về DUY NHẤT một JSON object hợp lệ, không kèm giải thích hay markdown code block.`
      : `Cấu trúc JSON đã được API ép buộc qua schema — điền đúng ngữ nghĩa từng trường như mô tả, KHÔNG thêm/bớt trường.`;
    return `Bạn là một AI chuyên TRÍCH XUẤT dữ liệu đơn hàng từ tin nhắn chat của Sales.
Nhiệm vụ DUY NHẤT của bạn: đọc tin nhắn và trích xuất thành JSON cấu trúc.
Trích xuất TẤT CẢ sản phẩm được đặt — dầu nhớt, phụ kiện, quần áo, áo, nón, merchandise... KHÔNG bỏ sót bất kỳ dòng nào có số lượng + sản phẩm.
HỆ THỐNG sẽ tự khớp sản phẩm với database — bạn KHÔNG cần biết danh mục sản phẩm.

[QUY TẮC NGHIỆP VỤ (BẮT BUỘC TUÂN THỦ)]:
${memory}
- Gift/FOC parsing: 
  + Nếu tin nhắn có sản phẩm được báo là hàng tặng, quà tặng, FOC, khuyến mãi (ví dụ: 'tặng 1 phuy Prostream', 'FOC 3 lon Fast', 'tặng 9 túi rút'), đưa vào 'items' với 'isGift' = true, 'explicitPrice' = 0 hoặc null.
  + Nếu một dòng sản phẩm chính có quà tặng ghi kèm (ví dụ: '3 thùng Fast tặng 2 lon', '1 can Prostream 20L tặng thêm 6 chai Veltron Engine cleaner'), giữ dòng chính với 'isGift' = false, điền quà tặng vào 'explicitGift' (qty=6, name='Veltron Engine cleaner', unit='chai'). Chữ 'tặng thêm/kèm' nằm TRÊN dòng sản phẩm chính KHÔNG biến dòng chính thành quà — chỉ SP sau 'tặng' mới là quà.
  + Nếu dòng FOC/tặng có kèm tên khách (ví dụ: 'FOC 2 cái áo mưa cho Rửa xe AP'): PHẢI TÁCH RA — phần quà đưa vào 'items' (isGift = true), tên khách đưa vào 'customer' (nếu chưa có). KHÔNG BAO GIỜ ghi nguyên câu vào 'notes' hay 'tln'; trong 'tln' chỉ giữ phần quà (ví dụ: 'FOC 2 cái áo mưa Zentor').
- Mốc giá (tier override): Nếu tin nhắn ghi 'giá 2 thùng' / 'lấy mốc giá 2 thùng' / 'áp giá 3 thùng', điền số thùng đó vào 'priceTierQty' (ví dụ: '1 thùng Chain Cleaner giá 2 thùng' → qty=1, priceTierQty=2). Nếu ghi 'giá thùng' / 'áp giá thùng' (không kèm số, ngụ ý mua lẻ tính theo giá thùng) → priceTierQty = 1. KHÔNG được hiểu nhầm thành 'explicitPrice'. Không có yêu cầu → priceTierQty = null.
  + Cụm 'giá N thùng' NẰM TRÊN CÙNG DÒNG sản phẩm — TUYỆT ĐỐI KHÔNG tách thành item thứ 2, KHÔNG nhân đôi qty. Ví dụ: '2 thùng chain lube max giá 2 thùng' → ĐÚNG 1 item duy nhất: qty=2, rawProduct='chain lube max', priceTierQty=2 (số '2' thứ hai là MỐC GIÁ, không phải số lượng thêm).
  + Dòng 'giá N thùng' ĐỨNG RIÊNG (cả dòng chỉ có 'Giá 2 thùng' / 'áp giá 3 thùng') là mốc giá ÁP CHO TOÀN ĐƠN — TUYỆT ĐỐI KHÔNG tạo item cho dòng này (KHÔNG đưa vào items, KHÔNG đưa vào notes), và đặt priceTierQty = N cho TẤT CẢ các item CHƯA có explicitPrice và chưa có priceTierQty riêng. Ví dụ: '2 thùng chain lube max' + '1 thùng chain cleaner' + 'Giá 2 thùng' → cả 2 item đều priceTierQty = 2, không có item nào tên 'Giá'.
  + Từ bổ nghĩa đứng ngay trước 'giá' (max, transparent, off road, trắng...) là một phần TÊN SẢN PHẨM — GIỮ NGUYÊN trong rawProduct: 'chain lube max' ≠ 'chain lube' (2 sản phẩm khác nhau, giá khác nhau).
- Hình thức thanh toán: 'TT CK' / 'ck' / 'chuyển khoản' → payment = 'ck'. Chỉ ghi 'TT' một mình → payment = 'tt'. Các dòng này CHỈ dùng cho 'payment' — KHÔNG tạo item, KHÔNG đưa vào notes.
- Yêu cầu hóa đơn: dòng 'HĐ' / 'HĐ đỏ' / 'hóa đơn' / 'VAT' là YÊU CẦU XUẤT HÓA ĐƠN → ghi vào 'notes', TUYỆT ĐỐI KHÔNG tạo item (không bịa qty), không đưa vào items.
- Mã KV: Nếu tin nhắn có mã sản phẩm (ví dụ: 'mã 8230012', '8230012'), đưa vào trường 'kvCode' của item đó.
- Đơn giá (explicitPrice) — BẮT BUỘC: Nếu sales ghi giá ANYWHERE trong dòng sản phẩm (đầu, giữa, hoặc CUỐI), TRÍCH XUẤT vào 'explicitPrice'. Quy đổi: 'k' = ×1000; 'tr' = ×1000000 (chữ số sau 'tr' là phần trăm nghìn). Ví dụ: '158k' → 155000, '106K' → 103000, '1.2tr' → 1200000, '11tr3' → 11300000, '12tr' → 12000000, '1tr5' → 1500000. Giá có thể KHÔNG cần prefix 'giá' (ví dụ: '5 bình Fast scoot 158k' → explicitPrice = 155000). KHÔNG được bỏ qua giá sales đã báo!

QUAN TRỌNG — Trích xuất rawProduct:
- Giữ NGUYÊN VĂN tên sản phẩm như sales viết (viết tắt, không dấu, biệt danh... đều giữ nguyên).
- Giữ nguyên thông tin size/màu/variant trong rawProduct (ví dụ: "polo mè size L", "áo khoác XL").
- KHÔNG tự sửa, KHÔNG đoán tên đầy đủ. Hệ thống sẽ tự khớp.
- Nếu cùng 1 sản phẩm CÙNG quy cách xuất hiện nhiều lần rải rác trong tin nhắn (VD: '2 thùng fast 4T 1L' ở đầu và '3 thùng fast 4T 1L' ở cuối), CỨ TRÍCH XUẤT TẤT CẢ từng dòng — hệ thống sẽ tự gộp.
- TUYỆT ĐỐI KHÔNG gộp 2 dòng trùng tên nhưng KHÁC quy cách/dung tích (VD: 'fast 4T 1L' ≠ 'fast 4T 800ml', 'moto SR 10w40 60L' ≠ 'moto SR 10w40 1L'). Mỗi dòng trong tin nhắn = 1 item riêng biệt: KHÔNG gộp, KHÔNG bỏ sót dòng nào.
- GIỮ NGUYÊN số dung tích/quy cách trong rawProduct (1L, 800ml, 60L, 4T...) — KHÔNG được làm mất.

VÍ DỤ phân biệt (làm theo mẫu, không cần giải thích):
- "6 chai moto SR 10w40" + "6 chai moto SR Scooter 10w40" → 2 item RIÊNG, KHÔNG gộp: {"qty":6,"unit":"chai","rawProduct":"moto SR 10w40"} và {"qty":6,"unit":"chai","rawProduct":"moto SR Scooter 10w40"} — "Scooter"/"TT"/"Ester" là phần TÊN sản phẩm, 2 dòng khác phụ từ = 2 sản phẩm khác nhau.
- "6 chai TT scooter 5w40" → 1 item {"qty":6,"unit":"chai","rawProduct":"TT scooter 5w40"} — dòng bắt đầu bằng "TT" nhưng có SỐ LƯỢNG + tên sản phẩm phía sau là dòng SẢN PHẨM, KHÔNG phải dòng thanh toán.
- Đơn vị (unit): dùng đúng đơn vị sales ghi. Với hàng ngoài dầu nhớt: áo → "áo", cái → "cái", nón → "nón", túi → "túi"...
  Nếu sales KHÔNG ghi đơn vị rõ ràng (ví dụ: "2 polo mè size L"), TỰ SUY LUẬN đơn vị phù hợp (áo, cái, nón...) dựa trên ngữ cảnh sản phẩm.
- TÊN KHÁCH: dòng đầu tiên của tin nhắn thường là tên khách/cửa hàng — kể cả khi bắt đầu bằng số (VD: "7C motor", "3S shop") và kể cả tên ALL-CAPS tiếng Anh trông giống tên hàng (VD: "ANYWHERE MAN"). Copy tên khách NGUYÊN VĂN từng chữ — KHÔNG sửa chính tả, KHÔNG đặt lại tên, KHÔNG dịch. KHÔNG BAO GIỜ đưa tên khách vào items.

Đoạn chat có thể viết tắt, không dấu, lộn xộn.

[NGỮ NGHĨA & KIỂU DỮ LIỆU TỪNG TRƯỜNG]:
${ORDER_SEMANTICS.map(s => '- ' + s).join('\n')}${jsonExample ? `
JSON mẫu cấu trúc:
{"customer":"Tên khách|null","payment":"ck|cod|tt|congno|other","notes":["lời dặn"],"items":[{"qty":3,"unit":"thùng","rawProduct":"nguyên văn","kvCode":null,"explicitPrice":103000,"priceTierQty":null,"isGift":false,"explicitGift":{"qty":2,"name":"lon","unit":"lon"}|null}],"tln":["mỗi ý tin nhắn 1 dòng nguyên văn"]}` : ''}

Quy tắc "notes": Chỉ ghi lời dặn/dặn dò THỰC TẾ của Sales. Không có lời dặn → trả về mảng rỗng []. KHÔNG ghi mô tả kiểu "không có ghi chú", "thông tin: có/không có". KHÔNG đưa dòng sản phẩm / dòng FOC-quà vào notes (chúng đã là items). KHÔNG đưa tên khách vào notes dưới MỌI hình thức — kể cả một dòng riêng chỉ chứa tên khách, kể cả tên khách dính chung dòng khác (VD khách 'ANYWHERE MAN' + dặn 'HĐ' → notes = ["HĐ"], KHÔNG phải "ANYWHERE MAN\nHĐ").

Quy tắc "tln": CHIA CẮT TOÀN BỘ nội dung tin nhắn thành từng dòng theo ý (mỗi ý 1 dòng: tên khách, địa chỉ, SĐT, mỗi dòng sản phẩm, mỗi dòng quà, dặn dò...), trích NGUYÊN VĂN từ tin nhắn, KHÔNG viết lại, KHÔNG tóm tắt, KHÔNG bỏ sót BẤT KỲ thông tin nào sales đã ghi (kể cả dòng không khớp sản phẩm). Bỏ @mentions, bỏ thảo luận nội bộ. BẮT BUỘC đưa TẤT CẢ thông tin khách hàng: địa chỉ, SĐT, người liên hệ, ghi chú giao hàng. Thông tin nào KHÔNG CÓ trong tin nhắn → BỎ QUA, KHÔNG ghi "không có" / "chưa có" / "(nếu có)". Chỉ ghi dòng có dữ liệu thực. Ngoại lệ: (1) dòng FOC/tặng có dính tên khách → chỉ giữ phần quà, bỏ phần tên khách; (2) dòng mở đầu khai tên khách kiểu 'em lên đơn HDX : ...' → tách tên khách vào 'customer', trong 'tln' chỉ giữ phần sản phẩm sau dấu ':' (VD: 'Torvex độ giá 134,330 x 62 lon, ko khuyến mại').

${tailBlock}`;
  },

  /**
   * AI-FINAL: AI là người chọn cuối từ shortlist của system.
   * Local matching chỉ gợi ý ứng viên — AI xác nhận hoặc sửa.
   * Shortlist đa nguồn (fuzzy + alias + brand family) đảm bảo đáp án đúng LUÔN có mặt.
   * @param {Array} ambiguousItems - [{index, rawProduct, candidates: [{id,name,spec,score,source}], localPick}]
   * @param {AbortSignal} [signal]
   * @returns {Object} Map of itemIndex → productId (or null)
   */
  async disambiguateItems(ambiguousItems, signal, dominantCampaign) {
    if (!ambiguousItems || ambiguousItems.length === 0) return {};

    const { profiles, activeId } = await this.getProfiles();
    let enabled = profiles.filter(p => p.enabled);
    if (enabled.length === 0) return {};
    const profile = enabled.find(p => p.id === activeId) || enabled[0];

    const itemsBlock = ambiguousItems.map(it => {
      const candList = (it.candidates || [])
        .map((c, i) => `      ${i + 1}. ID="${c.id}" | Tên="${c.name}" | Spec="${c.spec || ''}"${c.price ? ` | Giá list=${c.price}đ` : ''}${c.score ? ` | Score=${c.score}` : ''}`)
        .join('\n');
      const unitInfo = it.unit ? ` | Đơn vị: "${it.unit}"` : '';
      const priceInfo = it.explicitPrice ? ` | Giá sales ghi: ${it.explicitPrice}đ` : '';
      const confidence = (it.localScore || 0) >= 60 ? 'CAO' : (it.localScore || 0) >= 40 ? 'TB' : 'THẤP';
      const localHint = it.localPick ? `\n    ★ System gợi ý (độ tin cậy ${confidence}, score=${it.localScore || 0}): "${it.localPick}"` : '';
      // Hiển thị rawProduct ĐÃ chuẩn hóa synonym (VD "scooer"→"scooter") để quy tắc
      // "phụ từ phải có trong tên SP" không tự bẻ match về bản nhầm khi sales gõ typo.
      const displayRaw = normalizeFull(it.rawProduct || it.rawName || '') || it.rawProduct;
      return `  [${it.index}] "${displayRaw}"${unitInfo}${priceInfo}${localHint}\n    Ứng viên:\n${candList}`;
    }).join('\n\n');

    // Brand context hint (~15 token)
    let brandLine = '';
    if (dominantCampaign) {
      const brandName = dominantCampaign.startsWith('torvex') || dominantCampaign.startsWith('tvx') ? 'Torvex'
        : dominantCampaign.startsWith('znt') ? 'Zentor'
        : dominantCampaign.startsWith('xvil') ? 'Xvil'
        : dominantCampaign.startsWith('veltron') ? 'Veltron' : dominantCampaign;
      brandLine = `\nNGỮ CẢNH: Đơn hàng này chủ yếu là hàng ${brandName} — ưu tiên cùng brand khi tên gọi mơ hồ.\n`;
    }

    const prompt = `Bạn là hệ thống khớp sản phẩm. Chọn ĐÚNG 1 ID tốt nhất cho mỗi dòng.

QUY TẮC BẮT BUỘC (theo thứ tự ưu tiên):
1. ĐỘ NHỚT (viscosity): "10W30" ≠ "10W40" ≠ "20W50". PHẢI khớp đúng grade.
2. DUNG TÍCH/QUY CÁCH: "phuy" = 209L, "xô" = 18L, "bình" = 1L. Chọn đúng quy cách sales ghi.
3. BIẾN THỂ (phụ từ phân biệt): mỗi từ phụ sales ghi trong rawProduct (max, transparent, off road, trắng, đỏ, racing...) PHẢI có mặt trong tên sản phẩm được chọn. Input "chain lube max" → CHỈ được chọn bản có chữ "Max"; chọn bản không có phụ từ đó là SAI hàng (tên gọi gần nhau nhưng khác sản phẩm, khác giá).
4. GIÁ: nếu dòng có "Giá sales ghi" mà đúng 1 ứng viên có Giá list trùng khớp (sai số nhỏ, tính cả mốc theo thùng) → CHỌN ứng viên đó. Giá sales đưa thường là giá thật của hàng khách mua — 2 brand trùng tên gọi (VD "Fork 10" của Xvil 173k và Zentor 228k) được phân biệt bằng giá.
5. SIZE (HARD FILTER — TUYỆT ĐỐI): "S" ≠ "M" ≠ "L" ≠ "XL" ≠ "XXL". Input ghi size nào → CHỌN ĐÚNG size đó. KHÔNG BAO GIỜ chọn size khác dù tên sản phẩm giống. Ví dụ: input "size L" → CHỈ được chọn product có "Size L" hoặc "(L)", KHÔNG được chọn "Size XL" hay "Size XXL".
6. NẾU system gợi ý có độ tin cậy CAO (score>=60) → ƯU TIÊN chọn gợi ý, TRỪ khi nó VI PHẠM quy tắc 1-5.
7. NẾU không có ứng viên nào khớp đúng → null.
${brandLine}
${itemsBlock}

Trả về DUY NHẤT 1 JSON: {"matches": {"<index>": "<productId hoặc null>"}}
Không giải thích. Không markdown. Chỉ JSON.`;

    try {
      const result = await this._callSingle(profile, prompt,
        'Bạn là chuyên gia khớp sản phẩm dầu nhớt. Chỉ trả về JSON.', signal);
      if (result && result.matches) return result.matches;
    } catch (err) {
      console.warn('[AI-Final] Failed:', err.message);
    }
    return {};
  },

  /**
   * Detect the currently loaded model from a local server (LM Studio / Ollama).
   * Queries the /v1/models endpoint and returns the first model id.
   */
  async _detectLocalModel(profile) {
    const cfg = getProviderConfig(profile.provider);
    const endpoint = resolveEndpoint(profile.provider, profile.endpoint);
    // Derive /v1/models from the chat completions endpoint
    const modelsUrl = endpoint.replace(/\/chat\/completions.*$/i, '/models');
    if (!modelsUrl || modelsUrl === endpoint) return null;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(modelsUrl, { signal: ctrl.signal, headers: buildAuthHeaders(profile.provider, profile.apiKey) });
      clearTimeout(timer);
      if (!res.ok) return null;
      const data = await res.json();
      const models = (data.data || []).map(m => m.id).filter(Boolean);
      return models.length > 0 ? models[0] : null;
    } catch (e) {
      console.warn('[AI] _detectLocalModel failed:', e.message);
      return null;
    }
  },

  /**
   * Sleep có hỗ trợ hủy qua AbortSignal (dùng khi backoff giữa các lần retry).
   */
  _sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(new DOMException('Đã hủy yêu cầu AI.', 'AbortError'));
        return;
      }
      const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
      const onAbort = () => { clearTimeout(timer); cleanup(); reject(new DOMException('Đã hủy yêu cầu AI.', 'AbortError')); };
      const cleanup = () => { if (signal) signal.removeEventListener('abort', onAbort); };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  },

  /**
   * fetch cho lời gọi AI với 2 lớp bảo vệ:
   * 1. Timeout toàn cục (AI_REQUEST_TIMEOUT_MS) — gộp với signal của caller
   *    qua AbortSignal.any, timeout không ghi đè quyền hủy của caller.
   * 2. Retry backoff khi bị rate limit (429): thử lại tối đa RATE_LIMIT_RETRIES
   *    lần, chờ 2s rồi 4s giữa các lần.
   * Lỗi timeout được ném với message tiếng Việt rõ ràng (name 'TimeoutError'
   * vẫn được giữ để tầng trên phân biệt với AbortError của caller).
   */
  async _fetchAI(url, options, signal) {
    for (let attempt = 0; ; attempt++) {
      const timeoutSignal = AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS);
      const merged = (signal && typeof AbortSignal.any === 'function')
        ? AbortSignal.any([signal, timeoutSignal])
        : (signal || timeoutSignal);
      let response;
      try {
        response = await fetch(url, { ...options, signal: merged });
      } catch (err) {
        if (err && err.name === 'TimeoutError') {
          const terr = new Error(`AI không phản hồi sau ${AI_REQUEST_TIMEOUT_MS / 1000}s — đã hủy request (timeout).`);
          terr.name = 'TimeoutError';
          throw terr;
        }
        throw err;
      }
      if (response.status !== 429 || attempt >= RATE_LIMIT_RETRIES) return response;
      // Đọc hết body để giải phóng connection trước khi thử lại
      try { await response.text(); } catch (_) { /* ignore */ }
      const waitMs = 2000 * (attempt + 1);
      console.warn(`[AI] Bị rate limit (429) — thử lại sau ${waitMs / 1000}s (lần ${attempt + 1}/${RATE_LIMIT_RETRIES})`);
      await this._sleep(waitMs, signal);
    }
  },

  /**
   * Call a single AI profile. Returns parsed JSON result.
   * Routes by provider's `api` field from registry: 'gemini' | 'anthropic' | 'openai'
   * @param {AbortSignal} [signal] - Optional signal to cancel the request.
   */
  async _callSingle(profile, text, systemPrompt, signal) {
    // Key was stored encrypted but could not be decrypted (Windows DPAPI broken)
    if (profile.keyError === 'decrypt_failed') {
      throw new Error('API key không thể giải mã (do đổi mật khẩu Windows / khác user). Vào Cài Đặt → AI → nhập lại key.');
    }
    const aiModel = profile.model || this.getDefaultModel(profile.provider);
    const cfg = getProviderConfig(profile.provider);
    // Auto-detect API protocol from endpoint (supports both OpenAI & Anthropic endpoints)
    const effectiveApi = detectApiProtocol(profile.provider, profile.endpoint);

    if (effectiveApi === 'gemini') {
      // Google Gemini native API
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${aiModel}:generateContent?key=${profile.apiKey}`;
      const response = await this._fetchAI(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: { text: systemPrompt } },
          contents: [{ role: "user", parts: [{ text }] }],
          generationConfig: {
            responseMimeType: "application/json",
            // Structured Output: API ÉP model trả đúng schema — không thể sai format
            responseSchema: buildGeminiResponseSchema(),
            temperature: 0
          }
        })
      }, signal);
      if (!response.ok) {
        const errText = await response.text();
        const err = new Error(`Gemini API Error (${response.status}): ${errText.slice(0, 150)}`);
        err.status = response.status;
        throw err;
      }
      const resData = await response.json();
      if (!resData.candidates || !resData.candidates[0] || !resData.candidates[0].content) {
        throw new Error('Gemini không trả về kết quả hợp lệ.');
      }
      const gemCand = resData.candidates[0];
      // Bị cắt do hết token → NÉM LỖI thay vì repair im lặng (mất dòng âm thầm)
      if (gemCand.finishReason === 'MAX_TOKENS') {
        throw new Error('Kết quả bị cắt do đạt giới hạn token đầu ra (MAX_TOKENS) — tin nhắn đơn quá dài. Tách nhỏ đơn hoặc thử lại.');
      }
      // Thinking models có thể trả nhiều part — nối hết rồi để extractor tự tách JSON
      const gemParts = (gemCand.content && gemCand.content.parts) ? gemCand.content.parts : [];
      const mergedText = gemParts.map(p => p.text || '').join('\n').trim();
      if (!mergedText) throw new Error('Gemini không trả về kết quả hợp lệ.');
      return this._extractJSON(mergedText);

    } else if (effectiveApi === 'anthropic') {
      // Anthropic Claude Messages API (also Qwen Anthropic-compatible endpoint)
      const endpoint = resolveEndpoint(profile.provider, profile.endpoint);
      const headers = { "Content-Type": "application/json", ...buildAuthHeaders(profile.provider, profile.apiKey) };
      // For Anthropic-compatible endpoints (non-native Anthropic), use Bearer auth
      if (profile.provider !== 'anthropic' && profile.apiKey) {
        headers['Authorization'] = `Bearer ${profile.apiKey}`;
        delete headers['x-api-key'];
      }
      const response = await this._fetchAI(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: aiModel,
          max_tokens: 4096,
          system: systemPrompt,
          messages: [
            { role: "user", content: text },
            // Prefill '{' ép model bắt đầu output bằng JSON (Anthropic không có schema enforcement)
            { role: "assistant", content: "{" }
          ],
          temperature: 0
        })
      }, signal);
      if (!response.ok) {
        const errText = await response.text();
        const err = new Error(`Anthropic API Error (${response.status}): ${errText.slice(0, 150)}`);
        err.status = response.status;
        throw err;
      }
      const resData = await response.json();
      // Bị cắt do hết token → NÉM LỖI thay vì repair im lặng
      if (resData.stop_reason === 'max_tokens') {
        throw new Error('Kết quả bị cắt do đạt giới hạn max_tokens — tin nhắn đơn quá dài. Tách nhỏ đơn hoặc thử lại.');
      }
      if (!resData.content || !resData.content[0] || !resData.content[0].text) {
        throw new Error('Anthropic không trả về kết quả hợp lệ.');
      }
      const rawText = resData.content[0].text.trim();
      // Ghép lại với prefill '{' (nếu model không tự lặp lại)
      const fullText = rawText.startsWith('{') ? rawText : '{' + rawText;
      return this._extractJSON(fullText);

    } else {
      // OpenAI-compatible (openai, deepseek, groq, openrouter, mistral, qwen, ollama, lmstudio, custom, ...)
      const aiEndpoint = resolveEndpoint(profile.provider, profile.endpoint);
      const headers = { "Content-Type": "application/json", ...buildAuthHeaders(profile.provider, profile.apiKey) };

      const body = {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text }
        ],
        temperature: 0,
        max_tokens: 8192
      };
      // Structured output theo khả năng từng provider (registry):
      //   'schema' → json_schema strict: API ÉP cấu trúc, model không thể sai format
      //   'object' → json_object: đảm bảo JSON hợp lệ nhưng không ép field
      //   null     → THỬ json_schema strict (LM Studio/Ollama mới đều hỗ trợ — model
      //              nhỏ local cũng không thể sai format); server/model cũ trả 400/422
      //              → tự bỏ response_format và gửi lại như cũ (mất 1 request nhanh).
      const structured = supportsStructuredOutput(profile.provider);
      if (structured === 'schema') {
        body.response_format = {
          type: "json_schema",
          json_schema: { name: "order_extraction", strict: true, schema: buildOpenAIJsonSchema() }
        };
      } else if (structured === 'object') {
        body.response_format = { type: "json_object" };
      } else {
        body.response_format = {
          type: "json_schema",
          json_schema: { name: "order_extraction", strict: true, schema: buildOpenAIJsonSchema() }
        };
      }
      if (aiModel) body.model = aiModel;

      const sendRequest = () => this._fetchAI(aiEndpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body)
      }, signal);

      let response = await sendRequest();
      // Provider null (local/custom): json_schema không được hỗ trợ → bỏ ép rồi thử lại
      if (!response.ok && structured === null
          && (response.status === 400 || response.status === 422)) {
        delete body.response_format;
        response = await sendRequest();
      }
      if (!response.ok) {
        const errText = await response.text();
        // Local providers (LM Studio/Ollama): auto-detect loaded model on ANY 400/404 error and retry
        const isLocalProvider = cfg.local || profile.provider === 'qwen';
        const isModelError = (response.status === 404 || response.status === 400) && isLocalProvider;
        if (isModelError) {
          // Qwen cloud: use known-good default instead of probing /v1/models
          // Local providers (LM Studio/Ollama): auto-detect loaded model from /v1/models
          const detected = profile.provider === 'qwen'
            ? getProviderConfig('qwen').defaultModel
            : await this._detectLocalModel(profile);
          if (detected && detected !== body.model) {
            console.log(`[AI] Model "${body.model || '(none)'}" lỗi (${response.status}) — tự chuyển sang model đang chạy: "${detected}"`);
            body.model = detected;
            const retryRes = await this._fetchAI(aiEndpoint, { method: "POST", headers, body: JSON.stringify(body) }, signal);
            if (retryRes.ok) {
              const retryData = await retryRes.json();
              return this._extractFromOpenAIResponse(retryData);
            }
            const retryErrText = await retryRes.text();
            const retryErr = new Error(`API Error (${retryRes.status}) sau khi đổi model "${detected}": ${retryErrText.slice(0, 150)}`);
            retryErr.status = retryRes.status;
            throw retryErr;
          }
          if (!detected && cfg.local) {
            const err = new Error(`Model "${body.model || '(trống)'}" lỗi (${response.status}) và không phát hiện được model đang chạy. Hãy kiểm tra LM Studio/Ollama đã bật server và load model chưa.`);
            err.status = response.status;
            throw err;
          }
        }
        const err = new Error(`API Error (${response.status}): ${errText.slice(0, 150)}`);
        err.status = response.status;
        throw err;
      }
      const resData = await response.json();
      return this._extractFromOpenAIResponse(resData);
    }
  },

  /**
   * Parse OpenAI-compatible response with token-cut guard.
   * finish_reason === 'length' nghĩa là JSON bị cắt giữa chừng — repair im lặng
   * sẽ âm thầm MẤT DÒNG HÀNG, nên phải ném lỗi để retry/failover.
   */
  _extractFromOpenAIResponse(resData) {
    const choice = resData && resData.choices && resData.choices[0];
    if (!choice || !choice.message || !choice.message.content) {
      throw new Error('AI không trả về nội dung hợp lệ.');
    }
    if (choice.finish_reason === 'length') {
      throw new Error('Kết quả bị cắt do đạt giới hạn max_tokens — tin nhắn đơn quá dài. Tách nhỏ đơn hoặc thử lại.');
    }
    return this._extractJSON(choice.message.content.trim());
  },

  /**
   * Extract JSON from AI response — handles markdown code fences, headers,
   * and surrounding prose that models often wrap around output.
   * Logic đầy đủ đặt ở src/order/json-extractor.js (module thuần, test được).
   */
  _extractJSON(text) {
    return extractJSON(text);
  }
};

if (typeof window !== 'undefined') {
  window.aiService = aiService;
}

/**
 * Đếm số dòng có pattern số-lượng trong tin nhắn gốc.
 * Dùng để phát hiện AI extraction sót/dư dòng (0 call AI thêm).
 * @param {string} text - Raw chat text
 * @returns {number} Số dòng có chứa qty + unit
 */
function countQtyLines(text) {
  if (!text) return 0;
  const unitAlt = 'thùng|thg|thung|carton|ctn|box|chai|lon|can|bottle|btl|phuy|phụy|drum|bộ|bo|lít|lit|hộp|hop|xô|xo|pail|bucket|bình|binh|pcs|cái|cai|cây|cay|kg|túi|tui|áo|ao|cuốn|cuon|tuýp|tuyp';
  const qtyRegex = new RegExp('\\d+\\s*(?:' + unitAlt + ')', 'i');
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  // stripQtyJunk: dòng dính dấu nháy sau số lượng ("1' thùng...") vẫn được đếm,
  // đồng bộ với parser.js (bug thật 09/25).
  return lines.filter(l => qtyRegex.test(stripQtyJunk(l))).length;
}

export { aiService, countQtyLines };

/**
 * =========================================================================
 *  AI PROVIDER REGISTRY (ai-providers.mjs)
 * =========================================================================
 *  Single source of truth for all AI providers.
 *  To add a new provider, just add ONE entry here — everything else
 *  (UI cards, endpoints, test logic, API calls) adapts automatically.
 *
 *  ES module — shared by the Vite renderer bundle and (via dynamic
 *  import) by the CJS main process (browser-agent.js).
 *
 *  Fields:
 *    icon        — Emoji icon shown in UI
 *    label       — Display name
 *    desc        — Short description for provider card
 *    defaultModel— Default model ID
 *    endpoint    — API endpoint URL (null = user must provide)
 *    auth        — 'bearer' | 'x-api-key' | 'query-key' | 'none'
 *    local       — true if runs locally (no API key required)
 *    showEndpoint— true to show endpoint field in form
 *    api         — 'openai' | 'gemini' | 'anthropic'  (call protocol)
 *    structuredOutput — 'schema' (json_schema strict) | 'object' (json_object)
 *                       | null (không ép format qua API được)
 *    testUrl     — URL to test connectivity / list models
 *    headers     — Extra static headers (optional)
 *    models      — Model ID gợi ý cho datalist ô Model (dùng khi chưa test kết nối)
 *    keyUrl      — Link trang lấy API key (hiện dưới ô API Key trong form)
 * =========================================================================
 */

const AI_PROVIDERS = {
  gemini: {
    icon: '✨',
    label: 'Google Gemini',
    desc: 'Miễn phí 15 RPM · Flash',
    defaultModel: 'gemini-2.5-flash',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    auth: 'query-key',
    local: false,
    showEndpoint: false,
    api: 'gemini',
    structuredOutput: 'native', // branch Gemini riêng — dùng responseSchema native
    testUrl: 'https://generativelanguage.googleapis.com/v1beta/models?key={key}&pageSize=10',
    // gemini-2.5-flash vẫn đang được Google hỗ trợ (đối chiếu docs 9/2026) — giữ default
    models: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'],
    keyUrl: 'https://aistudio.google.com/apikey',
  },

  openai: {
    icon: '🧠',
    label: 'OpenAI',
    desc: 'GPT-5.6 · Trả phí',
    // gpt-4o-mini đã biến mất khỏi catalog OpenAI (đối chiếu docs 9/2026) → mặc định bậc budget GPT-5.6
    defaultModel: 'gpt-5.6-luna',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    auth: 'bearer',
    local: false,
    showEndpoint: false,
    api: 'openai',
    structuredOutput: 'schema',
    testUrl: 'https://api.openai.com/v1/models',
    models: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'],
    keyUrl: 'https://platform.openai.com/api-keys',
  },

  anthropic: {
    icon: '🎭',
    label: 'Claude',
    desc: 'Claude Sonnet 5 · Trả phí',
    // Sonnet 4 (20250514) đã legacy — lineup hiện hành 9/2026 là Sonnet 5 / Opus 5 / Haiku 4.5
    defaultModel: 'claude-sonnet-5',
    endpoint: 'https://api.anthropic.com/v1/messages',
    auth: 'x-api-key',
    local: false,
    showEndpoint: false,
    api: 'anthropic',
    structuredOutput: null, // dùng prefill assistant '{'
    testUrl: 'https://api.anthropic.com/v1/models',
    headers: { 'anthropic-version': '2023-06-01' },
    models: ['claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-5'],
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },

  deepseek: {
    icon: '🐋',
    label: 'DeepSeek',
    desc: 'Giá rẻ · Mạnh mẽ',
    defaultModel: 'deepseek-chat',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    auth: 'bearer',
    local: false,
    showEndpoint: false,
    api: 'openai',
    structuredOutput: 'object',
    testUrl: 'https://api.deepseek.com/v1/models',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },

  groq: {
    icon: '⚡',
    label: 'Groq',
    desc: 'Siêu nhanh · Free tier',
    defaultModel: 'llama-3.3-70b-versatile',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    auth: 'bearer',
    local: false,
    showEndpoint: false,
    api: 'openai',
    structuredOutput: 'schema',
    testUrl: 'https://api.groq.com/openai/v1/models',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    keyUrl: 'https://console.groq.com/keys',
  },

  openrouter: {
    icon: '🌐',
    label: 'OpenRouter',
    desc: '300+ models · 1 key',
    defaultModel: 'google/gemini-2.5-flash',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    auth: 'bearer',
    local: false,
    showEndpoint: false,
    api: 'openai',
    structuredOutput: 'object',
    testUrl: 'https://openrouter.ai/api/v1/models',
    headers: { 'HTTP-Referer': 'http://localhost', 'X-Title': 'Order Automation' },
    models: ['google/gemini-2.5-flash', 'z-ai/glm-4.6'],
    keyUrl: 'https://openrouter.ai/settings/keys',
  },

  mistral: {
    icon: '🌬️',
    label: 'Mistral AI',
    desc: 'European · Free tier',
    defaultModel: 'mistral-small-latest',
    endpoint: 'https://api.mistral.ai/v1/chat/completions',
    auth: 'bearer',
    local: false,
    showEndpoint: false,
    api: 'openai',
    structuredOutput: 'object',
    testUrl: 'https://api.mistral.ai/v1/models',
    models: ['mistral-small-latest', 'mistral-large-latest'],
    keyUrl: 'https://console.mistral.ai/api-keys',
  },

  qwen: {
    icon: '🐉',
    label: 'Qwen',
    desc: 'Alibaba · Mạnh · Giá tốt',
    defaultModel: 'qwen3.7-plus',
    endpoint: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions',
    auth: 'bearer',
    local: false,
    showEndpoint: true,
    api: 'openai',
    structuredOutput: 'object',
    testUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/models',
    models: ['qwen3.7-plus'], // endpoint Token Plan MaaS riêng — chỉ gợi ý model đã xác nhận
    keyUrl: 'https://bailian.console.aliyun.com/',
  },

  zai: {
    icon: '🔮',
    label: 'Z.AI (GLM)',
    desc: 'GLM Flash Free · Zhipu',
    // glm-4-flash đã cũ — dòng Flash 4.5/4.7 free 100% (đối chiếu docs 9/2026), 4.6 flagship trả phí
    defaultModel: 'glm-4.7-flash',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    auth: 'bearer',
    local: false,
    showEndpoint: true,
    api: 'openai',
    structuredOutput: 'object',
    testUrl: 'https://open.bigmodel.cn/api/paas/v4/models',
    models: ['glm-4.7-flash', 'glm-4.5-flash', 'glm-4.6'],
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },

  ollama: {
    icon: '🦙',
    label: 'Ollama',
    desc: 'Local · Miễn phí 100%',
    defaultModel: 'llama3.2',
    endpoint: 'http://127.0.0.1:11434/v1/chat/completions',
    auth: 'bearer',
    local: true,
    showEndpoint: true,
    api: 'openai',
    structuredOutput: null, // local — nhiều model không hỗ trợ json mode, tránh 400
    testUrl: 'http://127.0.0.1:11434/v1/models',
  },

  lmstudio: {
    icon: '🖥️',
    label: 'LM Studio',
    desc: 'Local · Key tuỳ chọn',
    defaultModel: '',
    endpoint: 'http://127.0.0.1:1234/v1/chat/completions',
    auth: 'bearer',
    local: true,
    showEndpoint: true,
    api: 'openai',
    structuredOutput: null, // local — tránh 400 trên model không hỗ trợ
    testUrl: 'http://127.0.0.1:1234/v1/models',
  },

  custom: {
    icon: '⚙️',
    label: 'Custom',
    desc: 'OpenAI-Compatible',
    defaultModel: 'gpt-4o-mini',
    endpoint: null,
    auth: 'bearer',
    local: false,
    showEndpoint: true,
    api: 'openai',
    structuredOutput: null, // endpoint lạ — không đoán được model có hỗ trợ không
    testUrl: null, // derived from user endpoint
  },
};

// ==================== Helper Functions ====================

/**
 * Get provider config by id. Falls back to 'custom' behavior for unknown providers.
 */
function getProviderConfig(providerId) {
  return AI_PROVIDERS[providerId] || AI_PROVIDERS.custom;
}

/**
 * Get all provider IDs (for iteration).
 */
function getProviderIds() {
  return Object.keys(AI_PROVIDERS);
}

/**
 * Build auth headers for a provider.
 */
function buildAuthHeaders(providerId, apiKey) {
  const cfg = getProviderConfig(providerId);
  const headers = {};

  if (cfg.auth === 'bearer' && apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  } else if (cfg.auth === 'x-api-key' && apiKey) {
    headers['x-api-key'] = apiKey;
  }
  // 'query-key' and 'none' don't use headers for auth

  // Merge extra static headers
  if (cfg.headers) {
    Object.assign(headers, cfg.headers);
  }

  return headers;
}

/**
 * Resolve the full endpoint URL for a provider.
 * Handles custom endpoint normalization.
 */
function resolveEndpoint(providerId, customEndpoint) {
  const cfg = getProviderConfig(providerId);

  if (providerId === 'custom') {
    return normalizeEndpointUrl(customEndpoint);
  }
  // Local or showEndpoint providers: user-provided endpoint takes priority
  if ((cfg.local || cfg.showEndpoint) && customEndpoint) {
    return normalizeEndpointUrl(customEndpoint);
  }
  return cfg.endpoint || customEndpoint || '';
}

/**
 * Normalize a custom endpoint URL to full chat completions path.
 * Handles OpenAI-compatible, Anthropic-compatible, and multi-version (v1/v4/etc.) endpoints.
 */
function normalizeEndpointUrl(url) {
  if (!url) return '';
  let u = url.trim().replace(/\/+$/, '');
  if (!u) return '';
  // Anthropic-compatible endpoint: ensure it ends with /v1/messages
  if (/\/apps\/anthropic/i.test(u)) {
    if (/\/v1\/messages$/i.test(u)) return u;
    return u + '/v1/messages';
  }
  // If already ends with chat/completions or messages, keep it
  if (/\/chat\/completions$/i.test(u) || /\/messages$/i.test(u)) return u;
  // If ends with a version path (e.g. /v1, /v2, /v4, /v1beta, /api/paas/v4), append /chat/completions
  if (/\/v\d+(\.\d+)?(beta)?$/i.test(u) || /\/api\/paas\/v\d+/i.test(u)) return u + '/chat/completions';
  // Default OpenAI-compatible
  return u + '/v1/chat/completions';
}

/**
 * Resolve the test URL for a provider (substitutes {key} placeholder).
 * If user provided a custom endpoint and provider supports it, derive test URL from it.
 */
function resolveTestUrl(providerId, apiKey, customEndpoint) {
  const cfg = getProviderConfig(providerId);

  // Local/custom/zai providers: always derive from endpoint
  if (providerId === 'custom' || providerId === 'zai' || cfg.local) {
    const defaultBase = providerId === 'ollama' ? 'http://127.0.0.1:11434'
      : providerId === 'lmstudio' ? 'http://127.0.0.1:1234'
      : providerId === 'zai' ? 'https://open.bigmodel.cn/api/paas/v4' : '';
    const raw = customEndpoint || cfg.endpoint || defaultBase;
    if (!raw) return null;
    const base = raw
      .replace(/\/chat\/completions.*$/i, '')
      .replace(/\/messages.*$/i, '')
      .replace(/\/+$/, '');
    if (!base) return null;
    if (/\/v\d+(\.\d+)?(beta)?$/i.test(base)) {
      return `${base}/models`;
    }
    return `${base}/v1/models`;
  }

  // Cloud providers with showEndpoint: if user overrode endpoint, derive test URL from it
  if (cfg.showEndpoint && customEndpoint) {
    const base = customEndpoint
      .replace(/\/chat\/completions.*$/i, '')
      .replace(/\/messages.*$/i, '')
      .replace(/\/+$/, '');
    if (/\/v\d+(\.\d+)?(beta)?$/i.test(base)) {
      return `${base}/models`;
    }
    return `${base}/v1/models`;
  }

  // Use static testUrl from registry
  if (cfg.testUrl) {
    return cfg.testUrl.replace('{key}', encodeURIComponent(apiKey || ''));
  }
  return null;
}

/**
 * Detect effective API protocol from endpoint URL.
 * Qwen/DashScope supports both OpenAI-compatible and Anthropic-compatible:
 *   - /compatible-mode/v1 → OpenAI protocol
 *   - /apps/anthropic     → Anthropic protocol
 * Falls back to registry config if no pattern detected.
 */
function detectApiProtocol(providerId, endpoint) {
  if (endpoint) {
    if (/\/apps\/anthropic/i.test(endpoint)) return 'anthropic';
    if (/\/compatible-mode/i.test(endpoint)) return 'openai';
  }
  return getProviderConfig(providerId).api;
}

/**
 * Khả năng structured output của provider:
 *   'schema' — response_format json_schema strict (OpenAI, Groq)
 *   'object' — chỉ json_object (DeepSeek, OpenRouter, Mistral, Qwen)
 *   null     — không ép được qua API (Anthropic → prefill; local/custom)
 */
function supportsStructuredOutput(providerId) {
  const cfg = getProviderConfig(providerId);
  return cfg.structuredOutput || null;
}

// ES module exports (renderer bundle + main-process dynamic import)
export { AI_PROVIDERS, getProviderConfig, getProviderIds, buildAuthHeaders, resolveEndpoint, normalizeEndpointUrl, resolveTestUrl, detectApiProtocol, supportsStructuredOutput };


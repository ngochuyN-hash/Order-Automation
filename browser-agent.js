/**
 * =========================================================================
 *  ORDER AUTOMATION - BROWSER AGENT (browser-agent.js)
 * =========================================================================
 *  Agent loop that connects LM Studio (localhost:1234) with BrowserMCP
 *  to automate KiotViet order creation. Follows the same custom provider
 *  pattern as ai-service.js.
 *
 *  Flow:
 *    1. Get browser state (DOM snapshot) via MCP
 *    2. Send state + task context to LM Studio
 *    3. Model returns structured action(s)
 *    4. Execute action(s) via MCP tool calls
 *    5. Repeat until task complete or max steps reached
 * =========================================================================
 */

const { McpClient } = require('./mcp-client');
const fs = require('fs');
const path = require('path');

// Domain tenant KiotViet đọc từ local-config.json (local-only, KHÔNG nằm trong git/GitHub).
// Fallback placeholder nếu thiếu file — tạo local-config.json với khóa kvTenantUrl để chạy thật.
let KV_TENANT_URL = 'https://YOUR_TENANT.kiotviet.vn';
try { KV_TENANT_URL = JSON.parse(fs.readFileSync(path.join(__dirname, 'local-config.json'), 'utf8')).kvTenantUrl || KV_TENANT_URL; } catch (e) { /* dùng placeholder */ }
const { EventEmitter } = require('events');

// ==================== CONFIGURATION ====================

const AGENT_CONFIG = {
  lmStudioEndpoint: 'http://localhost:1234/v1/chat/completions',
  model: '', // Empty = use LM Studio's loaded model
  maxSteps: 30,
  stepDelayMs: 1000,
  temperature: 0.1,
  kiotVietUrl: KV_TENANT_URL + '/sale/#/?cart=Order',
};

// ==================== SYSTEM PROMPT ====================

const KIOTVIET_SYSTEM_PROMPT = `Bạn là một AI agent điều khiển trình duyệt để tự động thao tác trên KiotViet.

## NHIỆM VỤ
Bạn nhận được trạng thái DOM hiện tại của trang web KiotViet và cần thực hiện các bước theo yêu cầu.
Bạn có thể làm MỌI THỨ trên KiotViet: lên đơn, kiểm tra tồn kho, xem báo cáo, quản lý khách hàng, v.v.

## CÁC TOOL CÓ SẴN
- browser_navigate: { "url": "..." } — Điều hướng đến URL
- browser_snapshot: {} — Lấy DOM snapshot (a11y tree với uid)
- browser_click: { "uid": "..." } — Click vào element
- browser_type: { "uid": "...", "text": "..." } — Gõ text vào input
- browser_press_key: { "key": "..." } — Bấm phím (Enter, Tab, Escape, F3, F4...)
- browser_select_option: { "uid": "...", "value": "..." } — Chọn option
- browser_screenshot: {} — Chụp ảnh màn hình
- browser_wait: { "ms": 1000 } — Chờ
- browser_evaluate: { "function": "() => {...}" } — Chạy JavaScript

## CẤU TRÚC KIOTVIET
- /sale — Bán hàng (POS)
- /sale/#/?cart=Order — Đơn hàng (hoặc /sale/orders)
- /product/products — Hàng hóa, tồn kho
- /customer/customers — Khách hàng
- /report/sale — Báo cáo bán hàng
- /report/inventory — Báo cáo tồn kho

## PHÍM TẮT: F3=Tìm hàng, F4=Tìm khách, F7=Thanh toán, F9=Hoàn thành, Escape=Đóng

## QUY TẮC LÊN ĐƠN
1. Tìm ô "Tìm khách hàng" → gõ tên → chờ 800ms → chọn từ dropdown (h5)
2. Tìm ô "Tìm hàng hóa" → gõ MÃ CODE (ưu tiên) → chờ 800ms → chọn
3. Nhập số lượng nếu > 1
4. Nhập giá nếu có
5. Lặp lại cho từng SP
6. Bấm "Đặt hàng"

## FORMAT TRẢ VỀ
{ "thinking": "...", "action": { "tool": "...", "args": {} }, "done": false }
Khi xong: { "thinking": "...", "action": null, "done": true, "summary": "...", "data": {} }

## LƯU Ý
- Chỉ trả về JSON
- uid lấy từ snapshot mới nhất
- LUÔN snapshot trước khi action
- KHÔNG tự nhập password
- Chờ 800ms-2s sau mỗi action
- Ưu tiên MÃ CODE thay tên SP`;

// ==================== BROWSER AGENT CLASS ====================

/**
 * Event KẾT THÚC một lần chạy — runId của run hiện tại (nếu có) sẽ được gắn
 * vào payload, để renderer bỏ qua event đến trễ của run trước.
 */
const TERMINAL_EVENTS = new Set(['completed', 'aborted', 'error']);

class BrowserAgent extends EventEmitter {
  constructor(options = {}) {
    super();
    this._mcp = new McpClient(options.mcp || {});
    this._config = { ...AGENT_CONFIG, ...options };
    this._running = false;
    this._aborted = false;
    this._stepCount = 0;
    this._history = []; // Conversation history for context
    this._logs = [];
    this._currentRunId = null; // runId của run đang chạy (do renderer gửi kèm options)

    // Forward MCP logs
    this._mcp.on('log', ({ level, msg }) => {
      this._addLog('mcp', level, msg);
    });
  }

  /**
   * Connect to BrowserMCP server.
   */
  async connect() {
    this._addLog('agent', 'info', 'Connecting to BrowserMCP server...');
    const tools = await this._mcp.connect();
    this._addLog('agent', 'info', `BrowserMCP connected with ${tools.length} tools`);
    return tools;
  }

  /**
   * Disconnect from BrowserMCP server.
   */
  disconnect() {
    this._mcp.disconnect();
    this._addLog('agent', 'info', 'Disconnected from BrowserMCP');
  }

  /**
   * Check if MCP is connected.
   */
  isConnected() {
    return this._mcp.isConnected();
  }

  /**
   * Get current status.
   */
  getStatus() {
    return {
      connected: this._mcp.isConnected(),
      running: this._running,
      stepCount: this._stepCount,
      tools: this._mcp.getToolNames(),
    };
  }

  /**
   * Get agent logs.
   */
  getLogs(limit = 100) {
    return this._logs.slice(-limit);
  }

  /**
   * Abort the current agent run.
   * Ngắt cứng: ngoài cờ _aborted (cooperative), hủy ngay mọi lệnh MCP đang bay
   * (abortPending — không chờ tới timeout 90s) và fetch AI đang chờ (_aiAbort).
   */
  abort() {
    this._aborted = true;
    try { this._mcp.abortPending?.(new Error('ABORTED_BY_USER')); } catch (_) { /* chưa kết nối MCP */ }
    try { this._aiAbort?.abort(); } catch (_) { /* không có call AI đang chạy */ }
    this._addLog('agent', 'warn', 'Agent abort requested');
  }

  /**
   * Reset the agent state.
   */
  reset() {
    this._aborted = true;
    this._running = false;
    this._stepCount = 0;
    this._history = [];
    this._currentRunId = null;
    this._addLog('agent', 'info', 'Agent state reset');
  }

  /**
   * EventEmitter + gắn runId của run hiện tại vào payload event kết thúc
   * (completed/aborted/error). Run không có runId (gọi từ mcp-server/headless,
   * hoặc run không qua modal KV) → payload giữ nguyên 100%, không thêm field.
   * Chỉ mỗi lần chạy có runId mới thêm; các field cũ không bị đổi tên/xoá.
   */
  emit(event, payload) {
    if (payload && this._currentRunId && !payload.runId && TERMINAL_EVENTS.has(event)) {
      payload = { ...payload, runId: this._currentRunId };
    }
    return super.emit(event, payload);
  }

  /**
   * Run direct order via fast script injection (Script Fill → Optional AI Verify → Optional Submit).
   * @param {object} orderData - Parsed order data
   * @param {object} options - Execution options (skipVerify, autoSubmit, savePdf, runId, aiConfig, etc.)
   */
  async runDirectOrder(orderData, options = {}) {
    if (this._running) {
      throw new Error('[Agent] Already running. Wait for completion or abort.');
    }

    this._running = true;
    this._aborted = false;
    this._stepCount = 0;
    this._history = [];
    // runId do modal KV sinh → gắn vào event kết thúc để renderer bỏ qua
    // event của run cũ (run trước chưa kịp về terminal khi user chạy run mới).
    this._currentRunId = options.runId || null;

    const skipVerify = options.skipVerify !== undefined ? options.skipVerify : true;
    const autoSubmit = !!options.autoSubmit;
    const savePdf = !!options.savePdf;
    // 'new' (mặc định): đảm bảo giỏ SẠCH trước khi điền (giỏ có hàng → bấm "+" mở giỏ mới, giỏ cũ giữ nguyên)
    // 'supplement': tái dùng đúng tab/giỏ user đã chọn, scan từng dòng rồi bổ sung phần thiếu
    const mode = options.mode === 'supplement' ? 'supplement' : 'new';

    try {
      this._addLog('agent', 'info', `🚀 Bắt đầu lên đơn bằng Script (${mode === 'supplement' ? 'BỔ SUNG giỏ đang mở' : 'giỏ mới'}): ${orderData.customer || 'Khách lẻ'} (${(orderData.items || []).length} SP)`);
      this.emit('started', { orderData, mode: 'direct' });
      this.emit('step', { step: 1, maxSteps: 4 });

      // Step 1: Pre-flight probe — POS đang mở sẵn thì TÁI DỤNG (KHÔNG navigate).
      // Navigate làm SPA reload → KV vứt param ?cart=Order, tab giỏ active bị reset
      // → mất ngữ cảnh đơn user đang soạn dở. Chỉ navigate khi POS chưa sống.
      let posAlive = false;
      try {
        const probeFn = `() => ({ href: location.href, posReady: !!document.getElementById('productSearchInput') })`;
        const probeResult = await this._mcp.callTool('browser_evaluate', { function: probeFn });
        const probe = JSON.parse(McpClient.extractText(probeResult));
        posAlive = !!(probe && probe.posReady);
      } catch (e) { /* lấy không được trạng thái → coi như POS chưa sống */ }

      if (posAlive) {
        this._addLog('agent', 'info', mode === 'supplement'
          ? '🔎 POS đang mở — quét giỏ user đã chọn và BỔ SUNG (không reload trang).'
          : '🔎 POS đang mở — tái dụng trang, sẽ mở giỏ sạch nếu giỏ hiện tại có hàng.');
      } else {
        this._addLog('agent', 'info', `Mở trang đặt hàng: ${this._config.kiotVietUrl}`);
        await this._mcp.navigate(this._config.kiotVietUrl);
        // Poll chờ SPA render xong (productSearchInput xuất hiện) thay vì sleep cứng
        try {
          const waitReadyFn = `async () => {
            const t0 = Date.now();
            while (Date.now() - t0 < 8000) {
              if (document.getElementById('productSearchInput')) return { ready: true };
              await new Promise(r => setTimeout(r, 250));
            }
            return { ready: false };
          }`;
          const readyResult = await this._mcp.callTool('browser_evaluate', { function: waitReadyFn });
          const ready = JSON.parse(McpClient.extractText(readyResult));
          if (!ready || !ready.ready) {
            this._addLog('agent', 'warn', '⚠ Trang KiotViet chưa báo sẵn sàng sau 8s — vẫn thử chạy tiếp.');
          }
        } catch (e) {
          this._addLog('agent', 'warn', `Không kiểm tra được trạng thái trang: ${e.message}`);
        }
        await this._mcp.wait(500);
      }

      if (this._aborted || !this._running) {
        this.emit('aborted', { steps: this._stepCount });
        return { success: false, aborted: true, error: 'Đã hủy tiến trình (abort)', steps: this._stepCount };
      }

      // Step 2: Inject and run direct fill script
      this._addLog('agent', 'info', `⚡ Đang chạy script điền thông tin đơn hàng vào KiotViet...`);
      this.emit('step', { step: 2, maxSteps: 4 });

      const scriptFunction = this._buildDirectFillScript(orderData, mode);
      const evalResult = await this._mcp.callTool('browser_evaluate', { function: scriptFunction });
      const resultText = McpClient.extractText(evalResult);
      this._addLog('agent', 'info', `Kết quả script: ${resultText.slice(0, 300)}`);
      let fillResult = null;
      try {
        const r = JSON.parse(resultText);
        fillResult = r;
        // Tổng kết chế độ BỔ SUNG: thêm mới / cập nhật SL / đã đủ bỏ qua
        if (r && typeof r === 'object' && !Array.isArray(r)) {
          const sum = r.summary || {};
          const hasSummary = ['added', 'updated', 'skipped'].some(k => typeof sum[k] === 'number');
          if (hasSummary) {
            const cust = r.cartCustomer ? ` (giỏ đang mở: ${r.cartCustomer})` : '';
            this._addLog('agent', 'info',
              `📊 Bổ sung giỏ${cust}: ➕ thêm ${sum.added} SP · ✏️ cập nhật ${sum.updated} SP · ⏭ đã có sẵn ${sum.skipped} SP · giỏ khởi đầu ${r.existingCount ?? '?'} dòng`);
          }
          if (Array.isArray(r.failed) && r.failed.length) {
            const fmt = r.failed.map(f => (f && f.term ? f.term + ' [' + (f.reason || '?') + ']' : String(f))).join(', ');
            this._addLog('agent', 'warn', `⚠ ${r.failed.length} SP KHÔNG xử lý được: ${fmt}`);
          }
          if (Array.isArray(r.mismatches) && r.mismatches.length) {
            const fmtM = r.mismatches.map(m => m.term + ' [' + m.reason + ']').join(', ');
            this._addLog('agent', 'warn', `⚠ VERIFY (đọc lại giỏ) phát hiện ${r.mismatches.length} lệch: ${fmtM}`);
          }
        } else if (Array.isArray(r.failed) && r.failed.length) {
          this._addLog('agent', 'warn', `⚠ ${r.failed.length} SP KHÔNG thêm được vào giỏ: ${r.failed.join(', ')}`);
        }
      } catch (e) { /* kết quả không phải JSON — đã có log thô ở trên */ }

      if (this._aborted || !this._running) {
        this.emit('aborted', { steps: this._stepCount });
        return { success: false, aborted: true, error: 'Đã hủy tiến trình (abort)', steps: this._stepCount };
      }

      // Step 3: Optional AI Verify (Only when user explicitly turned on AI Verify)
      if (!skipVerify) {
        this._addLog('agent', 'info', `🔍 Chạy AI Verify kiểm tra giỏ hàng...`);
        this.emit('step', { step: 3, maxSteps: 4 });

        try {
          const snapshotResult = await this._mcp.snapshot();
          const snapshotText = McpClient.extractText(snapshotResult);

          const verifyPrompt = `Kiểm tra xem đơn hàng trên KiotViet đã điền đúng chưa theo dữ liệu:\n${JSON.stringify(orderData, null, 2)}\n\nDOM:\n${snapshotText.slice(0, 8000)}\n\nNếu đã đủ và đúng, trả về JSON: {"done": true, "summary": "Đơn hàng đã được kiểm tra chính xác."}`;
          this._history = [
            { role: 'system', content: 'Bạn là chuyên viên kiểm tra đơn hàng KiotViet. Chỉ trả về JSON hợp lệ.' },
            { role: 'user', content: verifyPrompt },
          ];

          const aiConfig = options.aiConfig || {};
          const aiResponse = await this._callAI(aiConfig, aiConfig.endpoint || this._config.lmStudioEndpoint, aiConfig.model || this._config.model);
          this._addLog('agent', 'info', `AI Verify: ${aiResponse.slice(0, 200)}`);
        } catch (verifyErr) {
          this._addLog('agent', 'warn', `AI Verify không thực hiện được: ${verifyErr.message} (tiếp tục quy trình)`);
        }
      } else {
        this._addLog('agent', 'info', `⏩ Chế độ Script Fill trực tiếp — hoàn tất điền đơn không cần chụp màn hình`);
      }

      if (this._aborted || !this._running) {
        this.emit('aborted', { steps: this._stepCount });
        return { success: false, aborted: true, error: 'Đã hủy tiến trình (abort)', steps: this._stepCount };
      }

      // Step 4: Auto Submit / PDF — gate bằng kết quả VERIFY DOM (xác định,
      // không cần AI verify): SP thất bại hoặc đọc lại giỏ lệch → KHÔNG tự bấm.
      this.emit('step', { step: 4, maxSteps: 4 });
      let orderCode = null;
      const verifyBlocked = BrowserAgent.fillVerifyBlocked(fillResult);
      if (autoSubmit && verifyBlocked) {
        const why = fillResult
          ? [
              (Array.isArray(fillResult.failed) && fillResult.failed.length) ? fillResult.failed.length + ' SP không vào giỏ' : '',
              (Array.isArray(fillResult.mismatches) && fillResult.mismatches.length) ? fillResult.mismatches.length + ' dòng lệch SL/giá' : '',
            ].filter(Boolean).join(', ')
          : 'không đọc được kết quả fill';
        this._addLog('agent', 'warn', `⛔ VERIFY DOM phát hiện lệch (${why}) — KHÔNG tự bấm Đặt hàng. Kiểm tra giỏ rồi bấm thủ công.`);
      }
      if (autoSubmit && !verifyBlocked) {
        this._addLog('agent', 'info', `📝 Tự động xác nhận Đặt hàng...`);
        try {
          const submitFn = `async () => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null);
            const submitBtn = btns.find(b => /đặt hàng/i.test(b.textContent.trim()));
            if (submitBtn) submitBtn.click();
            await sleep(1000);
            
            // Xử lý modal xác nhận nếu có
            const dialog = document.querySelector('.modal, [role="dialog"], .k-window');
            if (dialog) {
              const receiver = ${JSON.stringify(orderData.receiver || '')};
              if (receiver) {
                const modalOpts = Array.from(dialog.querySelectorAll('[role="option"], .k-item, option'));
                const opt = modalOpts.find(o => o.textContent.toLowerCase().includes(receiver.toLowerCase()));
                if (opt) { opt.click(); await sleep(400); }
              }
              const modalBtns = Array.from(dialog.querySelectorAll('button')).filter(b => b.offsetParent !== null);
              const confirmBtn = modalBtns.find(b => /đặt hàng|đồng ý|xác nhận|hoàn thành/i.test(b.textContent.trim())) || modalBtns[modalBtns.length - 1];
              if (confirmBtn) { confirmBtn.click(); await sleep(1000); }
            }
            return { success: true };
          }`;
          await this._mcp.callTool('browser_evaluate', { function: submitFn });
          await this._mcp.wait(1500);

          // Bắt mã đơn KV vừa tạo (DHxxxxxx) để báo về app — xác định bằng DOM, không cần AI
          try {
            const codeFn = `() => (document.body.innerText.match(/DH\\d{6,}/) || [null])[0]`;
            const codeRes = await this._mcp.callTool('browser_evaluate', { function: codeFn });
            orderCode = BrowserAgent._extractOrderCode(McpClient.extractText(codeRes));
          } catch (e) { /* trang có thể chưa kịp render mã đơn — bỏ qua */ }
          if (orderCode) this._addLog('agent', 'info', `🧾 Mã đơn vừa đặt: ${orderCode}`);
        } catch(e) {
          this._addLog('agent', 'warn', `Xác nhận đặt hàng: ${e.message}`);
        }
      }

      if (savePdf) {
        this._addLog('agent', 'info', `📄 Đang lưu PDF đơn hàng...`);
        try {
          await this._mcp.callTool('browser_pdf_save', { filename: `DonHang_${orderCode || Date.now()}.pdf` });
        } catch(e) {
          this._addLog('agent', 'warn', `Lưu PDF: ${e.message}`);
        }
      }

      const summaryMsg = verifyBlocked
        ? '⚠ Điền xong nhưng VERIFY DOM phát hiện lệch — CHƯA đặt hàng. Kiểm tra giỏ rồi bấm Đặt hàng thủ công.'
        : autoSubmit
          ? (orderCode
            ? `✅ Đã đặt hàng thành công — mã đơn ${orderCode}!`
            : '✅ Đã hoàn tất điền đơn và gửi đặt hàng thành công!')
          : '✅ Đã điền xong toàn bộ đơn hàng vào KiotViet! Bạn có thể kiểm tra và bấm Đặt hàng.';
      this._addLog('agent', 'info', summaryMsg);
      this.emit('completed', { steps: 4, summary: summaryMsg, orderCode, verifyBlocked });
      return { success: true, orderCode, steps: 4, verifyBlocked };

    } catch (err) {
      this._addLog('agent', 'error', `Lỗi lên đơn direct: ${err.message}`);
      // User ngắt (abort cứng làm callTool/fetch ném ABORTED_BY_USER) → emit
      // 'aborted' để modal KV mở khóa bằng toast "Đã dừng", không phải "Lỗi"
      if (this._aborted) {
        this.emit('aborted', { steps: this._stepCount });
      } else {
        this.emit('error', { error: err.message });
      }
      return { success: false, aborted: this._aborted, error: err.message, steps: this._stepCount };
    } finally {
      this._running = false;
      this._currentRunId = null;
    }
  }

  /**
   * Build self-contained JavaScript function to fill KiotViet order directly in DOM.
   * @param {object} orderData - Dữ liệu đơn { customer, receiver, note, items[] }
   * @param {string} mode - 'new' (mặc định: đảm bảo giỏ sạch trước khi điền)
   *                        | 'supplement' (bổ sung vào giỏ user đang mở)
   */
  _buildDirectFillScript(orderData, mode = 'new') {
    // Escape \ ` ${ — payload được nhúng vào template literal, tên khách/ghi chú
    // chứa các ký tự này sẽ vỡ cú pháp script (cùng chuẩn với callRendererApi)
    const payload = JSON.stringify(orderData)
      .replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
    const modeStr = mode === 'supplement' ? 'supplement' : 'new';
    return `async () => {
      const order = ${payload};
      const MODE = ${JSON.stringify(modeStr)};
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const logs = [];
      const log = (m) => { console.log('[KV]', m); logs.push(m); };

      function setVal(el, val) {
        // Chọn setter theo đúng loại element — set của Input áp lên Textarea ném "Illegal invocation"
        const proto = el.tagName === 'TEXTAREA'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) { setter.call(el, val); } else { el.value = val; }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        if (window.angular) {
          const s = angular.element(el).scope();
          if (s && !s.$$phase) { try { s.$apply(); } catch(e){} }
        }
      }

      function findInp(ph) {
        for (const i of document.querySelectorAll('input, textarea')) {
          if (i.placeholder && i.placeholder.toLowerCase().includes(ph.toLowerCase())) return i;
        }
        return null;
      }

      async function waitEl(fn, ms = 4000) {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
          const el = typeof fn === 'function' ? fn() : document.querySelector(fn);
          if (el && (el.offsetParent !== null || typeof fn === 'function')) return el;
          await sleep(100);
        }
        return null;
      }

      // ————— Helper quét giỏ & so khớp (chế độ BỔ SUNG) —————
      function norm(s) { return ((s || '') + '').toLowerCase().replace(/\\s+/g, ' ').trim(); }
      function compact(s) { return ((s || '') + '').toLowerCase().replace(/\\s+/g, ''); }

      // Tắt overlay hướng dẫn intro.js của KiotViet — nó che toàn trang và CHẶN MỌI CLICK
      async function dismissIntro() {
        try {
          const t0 = Date.now();
          while (Date.now() - t0 < 4000) {
            const ov = document.querySelector('.introjs-overlay, .introjs-tooltip');
            if (!ov) return true;
            const skip = document.querySelector('.introjs-skipbutton, .introjs-donebutton')
              || Array.from(document.querySelectorAll('.introjs-button, .introjs-tooltip a, .introjs-tooltip button'))
                .find(b => /bỏ qua|skip|đóng|tiếp|next/i.test(b.textContent || ''));
            if (skip) { skip.click(); } else { ov.click(); }
            await sleep(250);
          }
          return !document.querySelector('.introjs-overlay, .introjs-tooltip');
        } catch (e) { return true; }
      }

      function cartCount() {
        let n = 0;
        for (let ci = 0; ci < 200; ci++) { if (document.getElementById('note-cartitem-' + ci)) n++; }
        return n;
      }

      // Quét TỪNG DÒNG giỏ hiện tại: { index, text (tên + mã KV hiển thị trên dòng), qty }.
      // Đây là nguồn chân lý của chế độ bổ sung — đọc trực tiếp DOM, không dùng AI/vision.
      function readCartRows() {
        const rows = [];
        for (let i = 0; i < 200; i++) {
          const q = document.getElementById('note-cartitem-' + i);
          if (!q) continue;
          let el = q;
          for (let d = 0; d < 6 && el.parentElement; d++) {
            el = el.parentElement;
            if ((el.textContent || '').length > 30) break;
          }
          rows.push({ index: i, text: norm(el.textContent || ''), qty: parseInt(q.value) || 0 });
        }
        return rows;
      }

      // Khách đang chọn của giỏ (link chứa mã KHxxxxxx) — chỉ để log tổng kết
      function getCartCustomer() {
        const link = Array.from(document.querySelectorAll('a')).find(
          a => a.offsetParent !== null && /KH\\d{6}/.test(a.textContent || ''));
        if (link) return norm((link.textContent || '').replace(/\\d{10,}/g, '')).trim();
        return '';
      }

      // Chấm điểm dòng giỏ khớp với item đơn: mã KV nguyên token (100đ) > tên chứa nhau (40đ),
      // cộng/trừ nhẹ theo quy cách Thùng/lẻ để phân biệt các biến thể (-1, -3, -5...)
      function scoreRow(r, it) {
        let s = 0;
        const code = ((it.code || '') + '').toLowerCase();
        if (code && r.text.split(/[\\s|]+/).some(t => t === code)) s += 100;
        const cn = compact(it.name || it.rawProduct || '');
        if (cn.length >= 8 && compact(r.text).includes(cn)) s += 40;
        const u = ((it.unit || 'thùng') + '').toLowerCase();
        const rowHasBox = /thùng|thung/.test(r.text);
        if (u.indexOf('thùng') !== -1 || u.indexOf('thung') !== -1) { if (rowHasBox) s += 5; }
        else if (rowHasBox) s -= 2;
        return s;
      }
      function findRow(rows, it) {
        let best = null, bs = 0;
        for (const r of rows) { const sc = scoreRow(r, it); if (sc > bs) { bs = sc; best = r; } }
        return bs >= 40 ? best : null;
      }

      // Sửa số lượng NGAY TẠI dòng index chỉ định (không đụng dòng khác)
      async function setQtyAt(idx, qty) {
        const q = document.getElementById('note-cartitem-' + idx);
        if (!q) return false;
        q.focus();
        setVal(q, String(qty));
        q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        const s = window.angular && angular.element(q).scope();
        if (s) { try { s.$apply(); } catch (e) {} }
        await sleep(300);
        return (parseInt(q.value) || 0) === qty;
      }

      // Sửa giá tại dòng index: nút giá (button.cart-item-N) mở popover #adjustPriceIpt
      async function setPriceAt(idx, price) {
        try {
          let pbtn = document.querySelector('button.cart-item-' + idx);
          if (!pbtn) {
            const q = document.getElementById('note-cartitem-' + idx);
            if (!q) return false;
            let p = q;
            for (let d = 0; d < 6 && p.parentElement; d++) {
              p = p.parentElement;
              const b = p.querySelector('button');
              if (b) { pbtn = b; break; }
            }
          }
          if (!pbtn) return false;
          pbtn.click();
          let pel = null;
          const t0 = Date.now();
          while (Date.now() - t0 < 1500 && !pel) {
            pel = document.getElementById('adjustPriceIpt') || document.querySelector('input[ng-model="vm.adjustedPrice"]');
            if (!pel) await sleep(100);
          }
          if (!pel) { document.body.click(); await sleep(200); return false; }
          pel.focus();
          setVal(pel, String(price));
          pel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          pel.blur();
          await sleep(400);
          return true;
        } catch (e) { return false; }
      }

      // Tìm nút "+" mở giỏ mới của KV — nằm trong cụm dãy tab giỏ ("Hóa đơn N"/"Đặt hàng N")
      function findNewCartButton() {
        const links = Array.from(document.querySelectorAll('a')).filter(a => a.offsetParent !== null);
        const cartTab = links.find(a => /^(hóa đơn|đặt hàng)\\s*\\d+$/i.test((a.textContent || '').trim()));
        if (cartTab) {
          let cont = cartTab.parentElement;
          for (let d = 0; d < 4 && cont; d++) {
            const plus = Array.from(cont.querySelectorAll('a, button'))
              .find(el => (el.textContent || '').trim() === '+' && el.offsetParent !== null);
            if (plus) return plus;
            cont = cont.parentElement;
          }
        }
        // Fallback: link "+" hiển thị bất kỳ (trang KV thật render nút này dạng link trống href)
        return links.find(a => (a.textContent || '').trim() === '+') || null;
      }

      // mode='new': đảm bảo giỏ SẠCH — giỏ có hàng thì mở giỏ MỚI (giỏ cũ giữ nguyên), không xóa gì
      async function ensureEmptyCart() {
        if (cartCount() === 0) return { ok: true, alreadyEmpty: true };
        const btn = findNewCartButton();
        if (!btn) return { ok: false, reason: 'NEW_CART_BUTTON_NOT_FOUND' };
        btn.click();
        const t0 = Date.now();
        while (Date.now() - t0 < 5000) {
          if (cartCount() === 0) return { ok: true, opened: true };
          await sleep(200);
        }
        return { ok: false, reason: 'CART_NOT_CLEARED' };
      }

      // 0. Gỡ overlay hướng dẫn trước — để mọi click phía sau không bị chặn
      await dismissIntro();

      if (MODE === 'new') {
        const ec = await ensureEmptyCart();
        if (!ec.ok) log('⚠ Không mở được giỏ mới (' + ec.reason + ') — tiếp tục với giỏ hiện tại.');
        else if (ec.opened) log('➕ Đã mở giỏ mới — giỏ cũ giữ nguyên.');
      } else {
        log('🔁 Bổ sung: giỏ đang mở có ' + cartCount() + ' dòng.');
      }

      // 1. Mode Bán giao hàng
      try {
        const tab = Array.from(document.querySelectorAll('a.nav-link')).find(a => a.textContent.includes('Bán giao hàng'));
        if (tab) { tab.click(); await sleep(400); }
      } catch(e){}

      // 2. Chọn khách hàng
      if (order.customer) {
        log('Chọn khách: ' + order.customer);
        const cinp = document.getElementById('customerSearchInput') || findInp('Tìm khách hàng');
        if (cinp) {
          cinp.focus();
          setVal(cinp, order.customer);
          await sleep(1000);
          const h5s = Array.from(document.querySelectorAll('h5')).filter(h => h.offsetParent !== null);
          const matched = h5s.find(h => h.textContent.toLowerCase().includes(order.customer.toLowerCase().slice(0, 8))) || h5s[0];
          if (matched) { matched.click(); await sleep(500); log('Đã chọn: ' + matched.textContent.trim()); }
        }
      }

      // 3. Chọn Người nhận đặt (Salesman / Seller)
      if (order.receiver) {
        log('Chọn người nhận đặt: ' + order.receiver);
        try {
          // Method A: Kendo Dropdown
          let salesmanDd = document.querySelector('.saleman-dropdown, .salesman-dropdown, #salesman .k-dropdown, [ng-model*="SaleUser"], [ng-model*="saleman"], [ng-model*="Seller"]')
            || Array.from(document.querySelectorAll('.k-dropdown')).find(d => /người nhận|người bán|nhân viên|salesman/i.test(d.textContent || ''));

          if (!salesmanDd) {
            const labels = Array.from(document.querySelectorAll('label, span, div'))
              .filter(el => /người nhận đặt|người bán|nhân viên/i.test(el.textContent || '') && el.offsetParent !== null);
            for (const lbl of labels) {
              const p = lbl.closest('.form-group, .row, div');
              if (p) {
                const dd = p.querySelector('.k-dropdown, select, input');
                if (dd) { salesmanDd = dd; break; }
              }
            }
          }

          if (salesmanDd) {
            const currentLabel = salesmanDd.querySelector('.k-input') || salesmanDd;
            const curText = currentLabel ? (currentLabel.textContent || currentLabel.value || '').trim() : '';
            if (!curText.toLowerCase().includes(order.receiver.toLowerCase())) {
              const clickTarget = salesmanDd.querySelector('.k-select') || salesmanDd;
              clickTarget.click();
              await sleep(600);

              const popups = Array.from(document.querySelectorAll('.k-animation-container .k-list-container, .k-list-container, .k-popup, ul.k-list'))
                .filter(p => p.offsetParent !== null);
              const activePopup = popups[popups.length - 1] || popups[0];
              if (activePopup) {
                const items = Array.from(activePopup.querySelectorAll('.k-item, li'));
                const targetName = order.receiver.toLowerCase();
                const match = items.find(i => i.textContent.trim().toLowerCase() === targetName)
                  || items.find(i => i.textContent.trim().toLowerCase().includes(targetName))
                  || items.find(i => {
                    const words = targetName.split(/\\s+/).filter(Boolean);
                    const itText = i.textContent.trim().toLowerCase();
                    return words.length > 0 && words.every(w => itText.includes(w));
                  });

                if (match) {
                  match.click();
                  await sleep(400);
                  log('Đã chọn người nhận đặt: ' + match.textContent.trim());
                } else {
                  document.body.click();
                  await sleep(200);
                  log('Không tìm thấy trong dropdown: ' + order.receiver);
                }
              } else {
                document.body.click();
                await sleep(200);
              }
            } else {
              log('Người nhận đặt đã đúng: ' + curText);
            }
          } else {
            // Method B: Input field
            const recInp = findInp('Người nhận đặt') || findInp('Người bán') || findInp('Nhân viên');
            if (recInp) {
              recInp.focus();
              setVal(recInp, order.receiver);
              await sleep(800);
              const matchedH5 = Array.from(document.querySelectorAll('h5, .k-item')).find(el => el.textContent.toLowerCase().includes(order.receiver.toLowerCase()));
              if (matchedH5) {
                matchedH5.click();
                await sleep(300);
                log('Đã chọn người nhận đặt (input): ' + matchedH5.textContent.trim());
              }
            }
          }
        } catch (errRec) {
          log('Lỗi chọn người nhận: ' + errRec.message);
        }
      }

      // 4. Bổ sung từng sản phẩm — SCAN giỏ tab đang mở trước:
      //    đủ SL → bỏ qua · lệch SL → sửa đúng dòng đó · thiếu → thêm mới.
      const items = order.items || [];
      const failed = [];
      let added = 0, updated = 0, skipped = 0;

      // Trạng thái giỏ KHỞI ĐẦU (tab user chủ động chọn trước khi bấm lên đơn)
      const initRows = readCartRows();
      const cartCustomer = getCartCustomer();

      function pickTarget(h5s, unitStr) {
        const u = (unitStr || 'thùng').toLowerCase();
        let t = null;
        if (u.indexOf('thùng') !== -1 || u.indexOf('thung') !== -1) {
          t = h5s.find(h => h.textContent.indexOf('Thùng') !== -1 || h.textContent.indexOf('Thung') !== -1);
        } else {
          const nonBox = h5s.filter(h => !/Thùng|Thung/i.test(h.textContent));
          if (nonBox.length > 0) t = nonBox[0];
        }
        if (!t && h5s.length > 0) t = h5s[0];
        return t;
      }

      // Poll chờ dropdown kết quả tìm kiếm (thay vì chờ cứng rồi đọc 1 lần)
      async function waitForResults(ms) {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
          const h5s = Array.from(document.querySelectorAll('h5')).filter(h => h.offsetParent !== null);
          if (h5s.length > 0) return h5s;
          await sleep(200);
        }
        return [];
      }

      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const term = it.code || it.name || it.rawProduct || it.matchedProductId || '';
        log('Xử lý SP ' + (i + 1) + '/' + items.length + ': ' + term);

        await dismissIntro();

        // Re-scan FRESH mỗi vòng — index dòng đổi khi thêm mới (KV chèn vào ĐẦU giỏ)
        const wantQty = parseInt(it.qty) || 1;
        const row = findRow(readCartRows(), it);

        if (row) {
          // ĐÃ CÓ trong giỏ — chỉ can thiệp khi lệch SL/giá
          if (row.qty === wantQty) {
            skipped++;
            log('⏭ Đã đủ x' + wantQty + ' trong giỏ, bỏ qua: ' + term);
          } else {
            const okQty = await setQtyAt(row.index, wantQty)
              ? true : await setQtyAt(row.index, wantQty); // thử lại 1 lần nếu chưa khớp
            if (okQty) {
              updated++;
              log('✏ Sửa SL dòng ' + (row.index + 1) + ': x' + row.qty + ' → x' + wantQty + ' (' + term + ')');
            } else {
              failed.push({ term, reason: 'QTY_SET_FAILED' });
              log('⚠ Không sửa được SL dòng ' + (row.index + 1) + ': ' + term);
              continue;
            }
          }
          // Đồng bộ giá theo đơn nếu JSON khai báo (kể cả 0đ FOC)
          const pr = (it.price !== undefined && it.price !== null) ? it.price : (it.explicitPrice || (it.isGift ? 0 : null));
          if (pr !== null && pr !== undefined) {
            const okPrice = await setPriceAt(row.index, pr);
            log(okPrice
              ? ('💰 Giá dòng ' + (row.index + 1) + ' = ' + (pr === 0 ? '0đ (FOC)' : Number(pr).toLocaleString()) + ' ✓')
              : ('⚠ Không sửa được giá dòng ' + (row.index + 1) + ': ' + term));
          }
          continue;
        }

        // CHƯA CÓ → thêm mới như luồng chuẩn
        const pinp = document.getElementById('productSearchInput') || findInp('Tìm hàng hóa');
        if (!pinp) { failed.push({ term, reason: 'SEARCH_INPUT_NOT_FOUND' }); log('❌ Không tìm thấy ô tìm hàng hóa'); continue; }

        // Đóng dropdown còn sót trước khi gõ từ khóa mới
        document.body.click();
        await sleep(150);
        pinp.focus();
        setVal(pinp, term);

        let h5s = await waitForResults(6000);
        if (h5s.length === 0) {
          // Retry: gõ lại từ khóa (lần đầu input có thể chưa nhận)
          log('⚠ Chưa thấy kết quả tìm kiếm, thử lại: ' + term);
          setVal(pinp, '');
          await sleep(200);
          setVal(pinp, term);
          h5s = await waitForResults(4000);
        }
        const target = pickTarget(h5s, it.unit);
        if (!target) {
          failed.push({ term, reason: 'SEARCH_NOT_FOUND' });
          log('❌ Không tìm thấy SP trong kết quả tìm kiếm: ' + term);
          continue;
        }

        const before = cartCount();
        target.click();

        // Chờ dòng mới xuất hiện trong giỏ (KiotViet thêm SP mới vào ĐẦU giỏ → index 0)
        let inCart = false;
        const t1 = Date.now();
        while (Date.now() - t1 < 3000) {
          if (cartCount() > before) { inCart = true; break; }
          await sleep(150);
        }
        if (!inCart) {
          failed.push({ term, reason: 'CLICK_NO_CART' });
          log('⚠ Đã bấm chọn nhưng SP không vào giỏ: ' + term);
          await sleep(300);
          continue;
        }
        added++;
        await sleep(400);

        // Qty — dòng vừa thêm đang nằm ở index 0
        if (wantQty > 1) {
          const qel = await waitEl(() => document.getElementById('note-cartitem-0'), 2500);
          if (qel) {
            const okQty = await setQtyAt(0, wantQty)
              ? true : await setQtyAt(0, wantQty);
            if (!okQty) log('⚠ SL cần x' + wantQty + ', chưa khớp sau khi gõ: ' + term);
          }
        }

        // Price
        const pr = (it.price !== undefined && it.price !== null) ? it.price : (it.explicitPrice || (it.isGift ? 0 : null));
        if (pr !== null && pr !== undefined) {
          await setPriceAt(0, pr);
        }
        await sleep(300);
      }
      if (failed.length) log('❌ TỔNG KẾT: ' + failed.length + ' SP không xử lý được: ' + failed.map(f => f.term + ' [' + f.reason + ']').join(', '));

      // 5. Ghi chú
      const note = Array.isArray(order.notes) ? order.notes.join('; ') : (order.note || '');
      if (note) {
        const ninp = findInp('Ghi chú');
        if (ninp) {
          ninp.focus();
          setVal(ninp, note);
          await sleep(200);
        }
      }

      // 6. VERIFY bằng DOM (read-back): đọc lại giỏ, đối chiếu từng item — mã + SL + giá nếu khai báo.
      //    Thay thế hoàn toàn nhu cầu AI verify: rẻ, tức thì, xác định.
      function verifyDom() {
        const rows = readCartRows();
        const out = [];
        for (const it of items) {
          const vTerm = it.code || it.name || it.rawProduct || '';
          const wantQty = parseInt(it.qty) || 1;
          const row = findRow(rows, it);
          if (!row) { out.push({ term: vTerm, reason: 'MISSING_IN_CART' }); continue; }
          if (row.qty !== wantQty) out.push({ term: vTerm, reason: 'QTY_MISMATCH', expected: wantQty, actual: row.qty });
          const pr = (it.price !== undefined && it.price !== null) ? it.price : (it.explicitPrice || (it.isGift ? 0 : null));
          if (pr !== null && pr !== undefined) {
            const btn = document.querySelector('button.cart-item-' + row.index);
            const actual = btn ? (parseInt((btn.textContent || '').replace(/[^0-9]/g, '')) || 0) : null;
            if (actual !== null && actual !== pr) out.push({ term: vTerm, reason: 'PRICE_MISMATCH', expected: pr, actual });
          }
        }
        return out;
      }
      const mismatches = verifyDom();
      if (mismatches.length) log('⚠ VERIFY phát hiện ' + mismatches.length + ' lệch: ' + mismatches.map(m => m.term + ' (' + m.reason + ')').join(', '));
      else log('✓ VERIFY: giỏ khớp đơn (' + items.length + ' SP).');

      return { success: true, count: items.length, summary: { added, updated, skipped }, failed, mismatches, existingCount: initRows.length, cartCustomer, mode: MODE, logs };
    }`;
  }

  /**
   * Run the KiotViet order automation task.
   * @param {object} orderData - Parsed order data (from ai-service.js callAI output)
   * @param {object} options - Additional options
   */
  async runKiotVietOrder(orderData, options = {}) {
    if (this._running) {
      throw new Error('[Agent] Already running. Wait for completion or abort.');
    }

    this._running = true;
    this._aborted = false;
    this._stepCount = 0;
    this._history = [];

    const aiConfig = options.aiConfig || {};
    const endpoint = aiConfig.endpoint || options.endpoint || this._config.lmStudioEndpoint;
    const model = aiConfig.model || options.model || this._config.model;
    const maxSteps = options.maxSteps || this._config.maxSteps;

    try {
      // Build task description from order data and execution options
      const taskDescription = this._buildTaskDescription(orderData, options);
      this._addLog('agent', 'info', `Starting KiotViet order: ${orderData.customer || 'Unknown'}`);
      this.emit('started', { orderData, taskDescription });

      // Navigate to KiotViet order page
      this._addLog('agent', 'info', `Navigating to ${this._config.kiotVietUrl}`);
      await this._mcp.navigate(this._config.kiotVietUrl);
      await this._mcp.wait(2000); // Wait for page load

      // Initialize conversation with system prompt + task
      this._history = [
        { role: 'system', content: KIOTVIET_SYSTEM_PROMPT },
        { role: 'user', content: `## NHIỆM VỤ\n${taskDescription}\n\nHãy bắt đầu bằng cách lấy snapshot trang hiện tại.` },
      ];

      // Agent loop
      while (this._stepCount < maxSteps && !this._aborted && this._running) {
        this._stepCount++;
        this._addLog('agent', 'info', `--- Step ${this._stepCount}/${maxSteps} ---`);
        this.emit('step', { step: this._stepCount, maxSteps });

        // 1. Get browser state
        let browserState;
        try {
          const snapshotResult = await this._mcp.snapshot();
          browserState = McpClient.extractText(snapshotResult);
        } catch (e) {
          this._addLog('agent', 'error', `Snapshot failed: ${e.message}`);
          browserState = `[Lỗi: Không lấy được snapshot - ${e.message}]`;
        }

        // 2. Add browser state to conversation
        this._history.push({
          role: 'user',
          content: `## DOM SNAPSHOT (Bước ${this._stepCount})\n\`\`\`\n${browserState.slice(0, 8000)}\n\`\`\`\n\nDựa vào DOM trên, hãy thực hiện bước tiếp theo.`,
        });

        // 3. Call AI
        let aiResponse;
        try {
          aiResponse = await this._callAI(aiConfig, endpoint, model);
        } catch (e) {
          this._addLog('agent', 'error', `AI call failed: ${e.message}`);
          if (this._aborted) break; // user ngắt — post-loop emit 'aborted', không báo lỗi giả
          this.emit('error', { step: this._stepCount, error: e.message });
          break;
        }

        // 4. Parse AI response
        let parsed;
        try {
          parsed = this._parseAIResponse(aiResponse);
        } catch (e) {
          this._addLog('agent', 'error', `Failed to parse AI response: ${e.message}`);
          // Add error feedback to conversation
          this._history.push({
            role: 'user',
            content: `[Lỗi parse] Response không phải JSON hợp lệ. Hãy trả về đúng format JSON.`,
          });
          continue;
        }

        this._addLog('agent', 'info', `AI thinking: ${parsed.thinking || 'N/A'}`);
        this._history.push({ role: 'assistant', content: aiResponse });

        // 5. Check if done
        if (parsed.done) {
          this._addLog('agent', 'info', `✅ Agent completed: ${parsed.summary || 'Done'}`);
          this.emit('completed', { steps: this._stepCount, summary: parsed.summary });
          break;
        }

        // 6. Execute action
        if (parsed.action && parsed.action.tool) {
          const { tool, args } = parsed.action;
          this._addLog('agent', 'info', `Executing: ${tool}(${JSON.stringify(args || {}).slice(0, 150)})`);
          this.emit('action', { step: this._stepCount, tool, args });

          try {
            let result;
            if (tool === 'browser_wait') {
              await this._mcp.wait(args.ms || 1000);
              result = { content: [{ type: 'text', text: `Waited ${args.ms || 1000}ms` }] };
            } else {
              result = await this._mcp.callTool(tool, args || {});
            }

            const resultText = McpClient.extractText(result);
            this._addLog('agent', 'info', `Result: ${resultText.slice(0, 200)}`);

            // Feed result back to conversation
            this._history.push({
              role: 'user',
              content: `## KẾT QUẢ TOOL\nTool: ${tool}\nKết quả: ${resultText.slice(0, 2000)}`,
            });
          } catch (e) {
            this._addLog('agent', 'error', `Tool execution failed: ${e.message}`);
            this._history.push({
              role: 'user',
              content: `[Lỗi tool] ${tool} thất bại: ${e.message}. Hãy thử cách khác hoặc snapshot lại.`,
            });
          }
        }

        // Delay between steps
        await this._mcp.wait(this._config.stepDelayMs);

        // Trim conversation history to prevent token overflow
        this._trimHistory();
      }

      if (this._aborted) {
        this._addLog('agent', 'warn', 'Agent aborted by user');
        this.emit('aborted', { steps: this._stepCount });
      } else if (this._stepCount >= maxSteps) {
        this._addLog('agent', 'warn', `Agent reached max steps (${maxSteps})`);
        this.emit('maxStepsReached', { steps: this._stepCount });
        this.emit('completed', { steps: this._stepCount, summary: `Đã đạt giới hạn tối đa ${maxSteps} bước. Vui lòng kiểm tra lại đơn hàng trên trình duyệt.` });
      }

    } finally {
      this._running = false;
    }
  }

  /**
   * Execute a single manual action (for UI-driven control).
   */
  async executeAction(tool, args = {}) {
    if (!this._mcp.isConnected()) {
      throw new Error('[Agent] Not connected to BrowserMCP');
    }
    const result = await this._mcp.callTool(tool, args);
    return McpClient.extractText(result);
  }

  /**
   * Execute a browser MCP tool and return the RAW result content (HTTP API
   * path): text parts kept verbatim + images (vd browser_take_screenshot)
   * as base64 — extractText would drop the image payload.
   */
  async executeActionRaw(tool, args = {}) {
    if (!this._mcp.isConnected()) {
      throw new Error('[Agent] Not connected to BrowserMCP');
    }
    const result = await this._mcp.callTool(tool, args);
    const content = (result && Array.isArray(result.content)) ? result.content : [];
    const out = { text: '', images: [] };
    for (const part of content) {
      if (part && part.type === 'text' && part.text) out.text += (out.text ? '\n' : '') + part.text;
      else if (part && part.type === 'image' && part.data) out.images.push(part.data);
      else if (part && part.type === 'resource' && part.resource && part.resource.text) {
        out.text += (out.text ? '\n' : '') + part.resource.text;
      }
    }
    return out;
  }

  /**
   * Get current page snapshot.
   */
  async getPageSnapshot() {
    if (!this._mcp.isConnected()) {
      throw new Error('[Agent] Not connected to BrowserMCP');
    }
    const result = await this._mcp.snapshot();
    return McpClient.extractText(result);
  }

  // ==================== PRIVATE METHODS ====================

  /**
   * Build task description from parsed order data.
   */
  _buildTaskDescription(orderData, options = {}) {
    let desc = `Tạo đơn hàng trên KiotViet với thông tin:\n\n`;
    desc += `**Khách hàng:** ${orderData.customer || 'Chưa xác định'}\n`;
    desc += `**Thanh toán:** ${this._paymentLabel(orderData.payment)}\n`;

    if (orderData.items && orderData.items.length > 0) {
      desc += `\n**Sản phẩm:**\n`;
      orderData.items.forEach((item, i) => {
        desc += `${i + 1}. ${item.rawProduct || item.matchedProductId} — SL: ${item.qty} ${item.unit || ''}`;
        if (item.explicitPrice) desc += ` — Giá: ${item.explicitPrice.toLocaleString()}`;
        if (item.isGift) desc += ` (Hàng tặng/FOC)`;
        if (item.priceTierQty) desc += ` (Mốc giá: ${item.priceTierQty} thùng)`;
        desc += `\n`;
      });
    }

    if (orderData.notes && orderData.notes.length > 0) {
      desc += `\n**Ghi chú:**\n`;
      orderData.notes.forEach(n => { desc += `- ${n}\n`; });
    }

    // Directives based on options
    desc += `\n**Chỉ thị thực hiện:**\n`;
    if (options.autoSubmit) {
      desc += `- Sau khi điền xong và kiểm tra đúng thông tin, hãy bấm nút "Đặt hàng" (hoặc F9) để hoàn tất đơn hàng.\n`;
    } else {
      desc += `- Điền đầy đủ thông tin vào giỏ hàng nhưng KHÔNG bấm Đặt hàng (để người dùng tự kiểm tra lại).\n`;
    }

    if (options.savePdf) {
      desc += `- Sau khi hoàn tất đặt hàng, in hoặc lưu phiếu đơn hàng sang PDF.\n`;
    }

    if (options.warehouseRules) {
      const wh = options.warehouseRules;
      if (wh.switchable && wh.switchable.length > 0) {
        desc += `- Quy tắc kho: Nếu hết hàng ở kho chỉ định, được phép chuyển sang các kho sau: ${wh.switchable.join(', ')}.\n`;
      }
    }

    return desc;
  }

  /**
   * Map payment code to Vietnamese label.
   */
  _paymentLabel(code) {
    const map = {
      ck: 'Chuyển khoản',
      cod: 'Thu hộ (COD)',
      tt: 'Tiền mặt',
      congno: 'Công nợ',
      other: 'Khác',
    };
    return map[code] || code || 'Mặc định';
  }

  /**
   * Run a generic KiotViet task.
   */
  async runGenericTask(taskDescription, options = {}) {
    if (this._running) {
      throw new Error('[Agent] Already running. Wait for completion or abort.');
    }

    this._running = true;
    this._aborted = false;
    this._stepCount = 0;
    this._history = [];

    const aiConfig = options.aiConfig || {};
    const endpoint = aiConfig.endpoint || options.endpoint || this._config.lmStudioEndpoint;
    const model = aiConfig.model || options.model || this._config.model;
    const maxSteps = options.maxSteps || this._config.maxSteps;

    try {
      this._addLog('agent', 'info', `Starting generic task: ${taskDescription}`);
      this.emit('started', { taskDescription });

      const startUrl = options.startUrl || this._config.kiotVietUrl;
      if (startUrl) {
        this._addLog('agent', 'info', `Navigating to ${startUrl}`);
        await this._mcp.navigate(startUrl);
        await this._mcp.wait(2000);
      }

      this._history = [
        { role: 'system', content: KIOTVIET_SYSTEM_PROMPT },
        { role: 'user', content: `## NHIỆM VỤ\n${taskDescription}\n\nHãy bắt đầu bằng cách lấy snapshot trang hiện tại.` },
      ];

      while (this._stepCount < maxSteps && !this._aborted && this._running) {
        this._stepCount++;
        this._addLog('agent', 'info', `--- Step ${this._stepCount}/${maxSteps} ---`);
        this.emit('step', { step: this._stepCount, maxSteps });

        let browserState;
        try {
          const snapshotResult = await this._mcp.snapshot();
          browserState = McpClient.extractText(snapshotResult);
        } catch (e) {
          this._addLog('agent', 'error', `Snapshot failed: ${e.message}`);
          browserState = `[Lỗi: Không lấy được snapshot - ${e.message}]`;
        }

        this._history.push({
          role: 'user',
          content: `## DOM SNAPSHOT (Bước ${this._stepCount})\n\`\`\`\n${browserState.slice(0, 8000)}\n\`\`\`\n\nDựa vào DOM trên, hãy thực hiện bước tiếp theo.`,
        });

        let aiResponse;
        try {
          aiResponse = await this._callAI(aiConfig, endpoint, model);
        } catch (e) {
          this._addLog('agent', 'error', `AI call failed: ${e.message}`);
          if (this._aborted) break; // user ngắt — post-loop emit 'aborted', không báo lỗi giả
          this.emit('error', { step: this._stepCount, error: e.message });
          break;
        }

        let parsed;
        try {
          parsed = this._parseAIResponse(aiResponse);
        } catch (e) {
          this._addLog('agent', 'error', `Failed to parse AI response: ${e.message}`);
          this._history.push({
            role: 'user',
            content: `[Lỗi parse] Response không phải JSON hợp lệ. Hãy trả về đúng format JSON.`,
          });
          continue;
        }

        this._addLog('agent', 'info', `AI thinking: ${parsed.thinking || 'N/A'}`);
        this._history.push({ role: 'assistant', content: aiResponse });

        if (parsed.done) {
          this._addLog('agent', 'info', `✅ Agent completed: ${parsed.summary || 'Done'}`);
          this.emit('completed', { steps: this._stepCount, summary: parsed.summary });
          break;
        }

        if (parsed.action && parsed.action.tool) {
          const { tool, args } = parsed.action;
          this._addLog('agent', 'info', `Executing: ${tool}(${JSON.stringify(args || {}).slice(0, 150)})`);
          this.emit('action', { step: this._stepCount, tool, args });

          try {
            let result;
            if (tool === 'browser_wait') {
              await this._mcp.wait(args.ms || 1000);
              result = { content: [{ type: 'text', text: `Waited ${args.ms || 1000}ms` }] };
            } else {
              result = await this._mcp.callTool(tool, args || {});
            }

            const resultText = McpClient.extractText(result);
            this._addLog('agent', 'info', `Result: ${resultText.slice(0, 200)}`);

            this._history.push({
              role: 'user',
              content: `## KẾT QUẢ TOOL\nTool: ${tool}\nKết quả: ${resultText.slice(0, 2000)}`,
            });
          } catch (e) {
            this._addLog('agent', 'error', `Tool execution failed: ${e.message}`);
            this._history.push({
              role: 'user',
              content: `[Lỗi tool] ${tool} thất bại: ${e.message}. Hãy thử cách khác hoặc snapshot lại.`,
            });
          }
        }

        await this._mcp.wait(this._config.stepDelayMs);
        this._trimHistory();
      }

      if (this._aborted) {
        this._addLog('agent', 'warn', 'Agent aborted by user');
        this.emit('aborted', { steps: this._stepCount });
      } else if (this._stepCount >= maxSteps) {
        this._addLog('agent', 'warn', `Agent reached max steps (${maxSteps})`);
        this.emit('maxStepsReached', { steps: this._stepCount });
        this.emit('completed', { steps: this._stepCount, summary: `Đã đạt giới hạn ${maxSteps} bước.` });
      }
    } finally {
      this._running = false;
    }
  }

  /**
   * Call AI model (LM Studio, Gemini, OpenAI, or any OpenAI-compatible provider).
   */
  async _callAI(aiConfig, endpoint, model) {
    const provider = (aiConfig && aiConfig.provider) || 'lmstudio';
    const apiKey = (aiConfig && aiConfig.apiKey) || '';
    const targetModel = (aiConfig && aiConfig.model) || model || this._config.model || '';
    const targetEndpoint = (aiConfig && aiConfig.endpoint) || endpoint || this._config.lmStudioEndpoint;

    // Controller cho pha chờ AI — abort() gắn cờ _aborted sẽ hủy fetch đang treo
    // (call mới tạo controller mới, ghi đè không cần dọn cái cũ — abort trên
    // fetch đã kết thúc là no-op)
    const aiAbort = new AbortController();
    this._aiAbort = aiAbort;

    // Direct Gemini API
    if (provider === 'gemini' && !targetEndpoint.includes('chat/completions')) {
      if (!apiKey) {
        throw new Error('Chưa cấu hình API Key cho Google Gemini. Vui lòng vào Cài đặt → Cấu hình AI để nhập API Key.');
      }
      const geminiModel = targetModel || 'gemini-2.5-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`;

      const contents = this._history.filter(m => m.role !== 'system').map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));
      const systemInstruction = this._history.find(m => m.role === 'system');

      const body = {
        contents,
        generationConfig: {
          temperature: this._config.temperature,
          maxOutputTokens: 1024,
        }
      };
      if (systemInstruction) {
        body.systemInstruction = { parts: [{ text: systemInstruction.content }] };
      }

      let response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: aiAbort.signal
        });
      } catch (e) {
        const cause = e.cause ? ` (${e.cause.code || e.cause.message || ''})` : '';
        throw new Error(`Không thể kết nối đến Google Gemini API${cause}. Hãy kiểm tra kết nối mạng internet.`);
      }

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gemini API Error (${response.status}): ${errText.slice(0, 200)}`);
      }
      const data = await response.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }

    // Anthropic Messages API (x-api-key + system top-level)
    if (provider === 'anthropic' || /\/v1\/messages$/i.test(targetEndpoint)) {
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) {
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
      }
      const systemMsg = this._history.find(m => m.role === 'system');
      const body = {
        model: targetModel || 'claude-sonnet-5',
        max_tokens: 1024,
        temperature: this._config.temperature,
        messages: this._history
          .filter(m => m.role !== 'system')
          .map(m => ({ role: m.role, content: m.content })),
      };
      if (systemMsg) body.system = systemMsg.content;

      const url = targetEndpoint || 'https://api.anthropic.com/v1/messages';
      let response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: aiAbort.signal,
        });
      } catch (e) {
        const cause = e.cause ? ` (${e.cause.code || e.cause.message || ''})` : '';
        throw new Error(`Không thể kết nối tới Anthropic API tại ${url}${cause}. Hãy kiểm tra kết nối mạng.`);
      }
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Anthropic API Error (${response.status}): ${errText.slice(0, 200)}`);
      }
      const data = await response.json();
      return (data.content || []).map(c => c.text || '').join('\n');
    }

    // OpenAI-compatible endpoint (LM Studio, OpenAI, Groq, OpenRouter, Proxy, Ollama, etc.)
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const body = {
      messages: this._history,
      temperature: this._config.temperature,
      max_tokens: 1024,
    };
    if (targetModel) body.model = targetModel;

    const url = targetEndpoint || (provider === 'openai' ? 'https://api.openai.com/v1/chat/completions' : this._config.lmStudioEndpoint);

    if (provider === 'openai' && !apiKey && !targetEndpoint) {
      throw new Error('Chưa cấu hình API Key cho OpenAI. Vui lòng vào Cài đặt → Cấu hình AI để nhập API Key.');
    }

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: aiAbort.signal,
      });
    } catch (e) {
      const cause = e.cause ? ` (${e.cause.code || e.cause.message || ''})` : '';
      if (url.includes('localhost') || url.includes('127.0.0.1')) {
        throw new Error(`Không thể kết nối tới server AI cục bộ tại ${url}${cause}. Hãy đảm bảo server (LM Studio / Proxy) đã được BẬT trước khi lên đơn.`);
      }
      throw new Error(`Không thể kết nối tới máy chủ AI tại ${url}${cause}. Hãy kiểm tra kết nối mạng.`);
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`AI API Error (${response.status}): ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      throw new Error('AI API returned invalid response');
    }

    return data.choices[0].message.content;
  }

  /**
   * Backward-compatibility alias for LM Studio calling.
   */
  async _callLMStudio(endpoint, model) {
    return this._callAI({ provider: 'lmstudio' }, endpoint, model);
  }

  /**
   * Parse AI response into structured action.
   * Handles markdown headers, code fences, and surrounding prose.
   */
  _parseAIResponse(text) {
    // Fallback: detect XML tool-call format — common with Qwen/tool-finetuned models
    const xmlParsed = this._parseXMLToolCall(text);
    if (xmlParsed) return xmlParsed;

    // Strip markdown code block if present
    let cleaned = text.trim();
    const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      cleaned = codeBlockMatch[1].trim();
    }
    // If response has markdown headers/prose around the JSON, extract the object
    if (!cleaned.startsWith('{') && !cleaned.startsWith('[')) {
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start >= 0 && end > start) {
        cleaned = cleaned.slice(start, end + 1);
      }
    }

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      // Retry: strip trailing commas (common LLM artifact)
      try {
        parsed = JSON.parse(cleaned.replace(/,\s*([}\]])/g, '$1'));
      } catch (_) {
        const snippet = text.slice(0, 200).replace(/\n/g, ' ');
        throw new Error(`AI trả về không phải JSON hợp lệ. Phản hồi: "${snippet}..."`);
      }
    }

    if (typeof parsed.done !== 'boolean') {
      parsed.done = false;
    }

    return parsed;
  }

  /**
   * Detect and convert XML tool-call format to standard JSON action structure.
   * Handles formats commonly emitted by tool-finetuned models (Qwen, Hermes, etc.).
   * Returns parsed action object or null if not XML tool-call format.
   */
  _parseXMLToolCall(text) {
    const trimmed = (text || '').trim();
    const invokeOpen = trimmed.match(/<invoke\s+name=["']([^"']+)["']/);
    if (invokeOpen) {
      const tool = invokeOpen[1];
      const reParam = new RegExp('<parameter\\s+name=["\']([^"\']+)["\']\\s*>([\\s\\S]*?)(?:<' + '/parameter>|$)', 'g');
      const args = {};
      let pm;
      while ((pm = reParam.exec(trimmed)) !== null) {
        let val = pm[2].trim();
        try { val = JSON.parse(val); } catch (_) { /* keep as string */ }
        args[pm[1]] = val;
      }
      const preInvoke = trimmed.slice(0, trimmed.indexOf('<invoke')).trim();
      const thinking = preInvoke.length > 0 ? preInvoke.slice(0, 300) : ('XML tool-call auto-converted: ' + tool);
      this._addLog('agent', 'info', '[Parse] Phat hien XML tool-call format, chuyen doi sang JSON action: ' + tool);
      return { thinking, action: { tool, args }, done: false };
    }

    const tcOpen = trimmed.indexOf('<tool_call>');
    if (tcOpen >= 0) {
      const jsonStart = trimmed.indexOf('{', tcOpen);
      const jsonEnd = trimmed.lastIndexOf('}');
      if (jsonStart >= 0 && jsonEnd > jsonStart) {
        try {
          const payload = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1));
          const toolName = payload.name || payload.tool || '';
          const toolArgs = payload.arguments || payload.args || {};
          if (toolName) {
            const pre = trimmed.slice(0, tcOpen).trim();
            this._addLog('agent', 'info', '[Parse] Phat hien tool_call XML format, chuyen doi sang JSON action: ' + toolName);
            return {
              thinking: pre.length > 0 ? pre.slice(0, 300) : ('tool_call XML auto-converted: ' + toolName),
              action: { tool: toolName, args: toolArgs },
              done: false
            };
          }
        } catch (_) { /* not parseable - fall through */ }
      }
    }

    return null;
  }

  /**
   * Trim conversation history to prevent token overflow.
   * Keeps system prompt + last N messages.
   */
  _trimHistory() {
    const MAX_MESSAGES = 20; // Keep last 20 messages + system prompt
    if (this._history.length > MAX_MESSAGES + 1) {
      const system = this._history[0];
      const task = this._history[1];
      const recent = this._history.slice(-(MAX_MESSAGES - 2));
      this._history = [system, task, ...recent];
      this._addLog('agent', 'info', `Trimmed history to ${this._history.length} messages`);
    }
  }

  /**
   * Add a log entry.
   */
  _addLog(source, level, msg) {
    const entry = {
      ts: new Date().toISOString(),
      source,
      level,
      msg,
    };
    this._logs.push(entry);
    // Keep last 500 logs
    if (this._logs.length > 500) {
      this._logs = this._logs.slice(-500);
    }
    this.emit('log', entry);
  }

  /**
   * Gate auto-submit từ kết quả fill script: có SP thất bại hoặc VERIFY DOM
   * đọc lại giỏ lệch (SL/giá/thiếu dòng) → true = không được tự bấm Đặt hàng.
   * @param {object|null} fillResult - JSON script điền đơn trả về {failed, mismatches}
   * @returns {boolean}
   */
  static fillVerifyBlocked(fillResult) {
    // Không đọc được kết quả fill (script crash/JSON hỏng) → không xác nhận
    // được giỏ → coi như chặn, không auto-submit trên trạng thái mù.
    if (!fillResult || typeof fillResult !== 'object' || Array.isArray(fillResult)) return true;
    return (Array.isArray(fillResult.failed) && fillResult.failed.length > 0) ||
      (Array.isArray(fillResult.mismatches) && fillResult.mismatches.length > 0);
  }

  /**
   * Rút mã đơn KiotViet (DHxxxxxx) từ text trang sau khi bấm Đặt hàng.
   * Chấp nhận text có quote JSON bao ngoài ("DH001234") — evaluate trả string.
   */
  static _extractOrderCode(text) {
    const m = String(text || '').match(/DH\d{6,}/);
    return m ? m[0] : null;
  }
}

module.exports = { BrowserAgent, AGENT_CONFIG, KIOTVIET_SYSTEM_PROMPT };
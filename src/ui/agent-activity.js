// =========================================================================
//  AI ACTIVITY FEED (src/ui/agent-activity.js)
//  Panel "Hoạt Động AI" — hiển thị realtime mọi thao tác của AI agent ngoài
//  qua MCP server (parse, dữ liệu, Excel, KiotViet, trình duyệt...). Event
//  'agent-activity' do mcp-server.js bắn (tại registerTool — phễu duy nhất
//  của mọi tool call) qua IPC whitelist AGENT_EVENT_CHANNELS.
//
//  Panel ẩn mặc định; tự mở khi có hoạt động đầu tiên của phiên; sau khi
//  user đã gập/mở/ẩn tay lần nào thì tôn trọng lựa chọn (chỉ badge đếm chưa
//  đọc + dot nhấp nháy nhắc). Console giữ tối đa MAX_ENTRIES dòng.
//
//  Nút phải trên summary là NÚT KÉP theo trạng thái AI:
//   - AI rảnh      → "Xóa": dọn log + ẨN luôn panel (hoạt động sau hiện
//                    lại ở dạng gập, không tự xòe ép).
//   - AI đang chạy → "Ngắt": abort() ngắt cứng run đang chạy (hủy ngay lệnh
//                    MCP/fetch AI đang bay). Bấm lần 2 hoặc 6s chưa dừng →
//                    reset() cưỡng bức, giống 2-bước nút Dừng modal KV.
// =========================================================================

const MAX_ENTRIES = 300;
const ACTIVE_WINDOW_MS = 5000;
const BUSY_POLL_MS = 2000; // poll backend status khi panel đang hiện
const STOP_ARM_MS = 6000;  // sau bấm Ngắt: cửa sổ chờ bấm lần 2 (reset)

// Nhãn tiếng Việt thân thiện theo tool MCP — phần không khớp hiện path thô
// (mcp-server.js đã gắn sẵn entry.label nên bảng này chỉ là fallback).
const PATH_LABELS = [
  ['/mcp/parse_order', 'Phân tích đơn hàng'],
  ['/mcp/parse_order_offline', 'Phân tích đơn hàng (offline)'],
  ['/mcp/auto_run_order', 'Tự động chạy đơn 1-click'],
  ['/mcp/run_kiotviet_order', 'Lên đơn KiotViet'],
  ['/mcp/abort_run', 'Hủy tiến trình đang chạy'],
  ['/mcp/export_excel', 'Xuất Excel'],
  ['/mcp/connect_browser', 'Kết nối trình duyệt'],
  ['/mcp/get_browser_tools', 'Xem tool trình duyệt'],
  ['/mcp/get_browser_snapshot', 'Đọc trang trình duyệt'],
  ['/mcp/execute_browser_tool', 'Thao tác trình duyệt'],
  ['/mcp/get_current_order', 'Xem đơn hiện tại'],
  ['/mcp/get_products', 'Sản phẩm'],
  ['/mcp/delete_product', 'Xóa sản phẩm'],
  ['/mcp/get_campaigns', 'Chiến dịch'],
  ['/mcp/get_aliases', 'Alias sản phẩm'],
  ['/mcp/set_aliases', 'Alias sản phẩm'],
  ['/mcp/get_kv_map', 'Mã KiotViet'],
  ['/mcp/get_memory', 'Bộ nhớ AI'],
  ['/mcp/set_memory', 'Bộ nhớ AI'],
  ['/mcp/get_sellers', 'Nhân viên sales'],
  ['/mcp/export_database', 'Xuất database'],
  ['/mcp/import_database', 'Nhập database'],
  ['/mcp/reset_database', 'Reset database'],
  ['/mcp/get_ai_status', 'Trạng thái AI'],
  ['/mcp/test_ai_profiles', 'Test kết nối AI'],
  ['/mcp/manage_ai_profiles', 'Cấu hình AI profile'],
];

function labelFor(entry) {
  // Ưu tiên label động main gắn sẵn (vd "Trình duyệt: browser_click")
  if (entry.label) return entry.label;
  const hit = PATH_LABELS.find(([p]) => entry.path === p || entry.path.startsWith(p + '/'));
  if (hit) return hit[1];
  return entry.path;
}

function formatTime(ts) {
  const d = new Date(ts || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const AgentActivity = {
  _userToggled: false,
  _unread: 0,
  _dotTimer: null,
  _backendRunning: false, // browserAgent.status().running (poll 2s)
  _stopArmed: false,      // đã bấm Ngắt, đang chờ agent dừng (bấm lần 2 = reset)
  _stopArmTimer: null,

  init() {
    if (!window.electronAPI || !window.electronAPI.browserAgent || !window.electronAPI.browserAgent.on) return;

    const panel = document.getElementById('aiActivityPanel');
    const consoleEl = document.getElementById('aiActivityConsole');
    const badge = document.getElementById('aiActivityBadge');
    const dot = document.getElementById('aiActivityDot');
    const clearBtn = document.getElementById('aiActivityClear');
    if (!panel || !consoleEl) return;

    this._panel = panel;
    this._console = consoleEl;
    this._badge = badge;
    this._dot = dot;
    this._btn = clearBtn;
    this._btnText = clearBtn ? clearBtn.querySelector('.ai-activity-clear-text') : null;

    panel.addEventListener('toggle', () => {
      this._userToggled = true;
      if (panel.open) {
        this._unread = 0;
        badge.style.display = 'none';
      }
    });

    if (clearBtn) {
      clearBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this._isBusy()) { this._requestStop(); return; }
        // Xóa: dọn log + ẨN luôn panel. Gập cả details (open=false) + đánh dấu
        // _userToggled để lần hoạt động sau panel chỉ hiện lại ở dạng gập
        // (dot + badge), không tự xòe ép.
        consoleEl.innerHTML = '';
        this._unread = 0;
        badge.style.display = 'none';
        this._userToggled = true;
        panel.open = false;
        panel.style.display = 'none';
      });
    }

    // Poll nhẹ 2s CHỈ khi panel đang hiện: nhận diện run đang chạy cả những
    // pha im lặng không có entry mới (vd đang chờ AI verify trả lời).
    setInterval(() => { this._pollStatus().catch(() => {}); }, BUSY_POLL_MS);

    window.electronAPI.browserAgent.on('agent-activity', (entry) => {
      try {
        this._append(panel, consoleEl, badge, dot, entry || {});
        this._updateButton();
      }
      catch (_) { /* feed không được phép ném lỗi ra ngoài */ }
    });
  },

  async _pollStatus() {
    if (!this._panel || this._panel.style.display === 'none') return;
    try {
      const status = await window.electronAPI.browserAgent.status();
      const running = !!(status && status.running);
      if (running !== this._backendRunning) {
        this._backendRunning = running;
        this._updateButton();
      }
      // Run đã kết thúc thật (không đợi hết cửa sổ STOP_ARM) → trả nút về Xóa/Ngắt
      if (!running && this._stopArmed && !this._dot.classList.contains('active')) {
        this._clearStopArm();
        this._updateButton();
      }
    } catch (_) { /* backend chưa sẵn sàng */ }
  },

  _isBusy() {
    return this._backendRunning || this._stopArmed ||
      !!(this._dot && this._dot.classList.contains('active'));
  },

  async _requestStop() {
    if (!window.electronAPI || !window.electronAPI.browserAgent) return;
    if (this._stopArmed) {
      // LẦN 2 (hoặc lần 1 chưa đủ) → RESET cưỡng bức: buộc thoát run để chạy lại ngay
      this._clearStopArm();
      try { await window.electronAPI.browserAgent.reset(); } catch (_) { /* ignore */ }
      this._backendRunning = false;
      this._logLocal('🔄 Đã RESET cưỡng bức agent — tiến trình AI bị buộc dừng.', 'warn');
      this._updateButton();
      return;
    }
    // LẦN 1 → abort(): cờ _aborted + hủy ngay lệnh MCP/fetch AI đang bay
    this._stopArmed = true;
    clearTimeout(this._stopArmTimer);
    this._stopArmTimer = setTimeout(() => { this._stopArmed = false; this._updateButton(); }, STOP_ARM_MS);
    this._logLocal('⛔ Đã yêu cầu ngắt AI agent... (bấm lần nữa để RESET cứng)', 'warn');
    try { await window.electronAPI.browserAgent.abort(); } catch (_) { /* ignore */ }
    this._updateButton();
  },

  _clearStopArm() {
    this._stopArmed = false;
    if (this._stopArmTimer) {
      clearTimeout(this._stopArmTimer);
      this._stopArmTimer = null;
    }
  },

  // Dòng log địa phương (không qua API) — cùng format với entry thường
  _logLocal(text, level) {
    const consoleEl = this._console;
    const panel = this._panel;
    if (!consoleEl || !panel) return;
    if (panel.style.display !== '') panel.style.display = '';
    const line = document.createElement('div');
    line.className = 'ai-activity-entry ' + (level || 'warn');
    line.textContent = `[${formatTime(Date.now())}] ${text}`;
    consoleEl.appendChild(line);
    while (consoleEl.childElementCount > MAX_ENTRIES) consoleEl.firstElementChild.remove();
    consoleEl.scrollTop = consoleEl.scrollHeight;
  },

  // Đổi nút theo trạng thái: AI rảnh → "Xóa"; AI chạy → "Ngắt"; vừa bấm → "Reset"
  _updateButton() {
    const btn = this._btn;
    if (!btn) return;
    const armed = this._stopArmed;
    const busy = this._isBusy();
    btn.classList.toggle('is-abort', busy);
    if (this._btnText) this._btnText.textContent = armed ? 'Reset' : (busy ? 'Ngắt' : 'Xóa');
    btn.title = armed
      ? 'Bấm lần nữa để RESET cứng tiến trình AI'
      : (busy ? 'Ngắt tiến trình AI đang chạy' : 'Xóa nhật ký & ẩn panel');
  },

  _append(panel, consoleEl, badge, dot, entry) {
    // Hiện panel ở hoạt động đầu tiên; tự mở nếu user chưa can thiệp
    if (panel.style.display !== '') panel.style.display = '';
    if (!this._userToggled && !panel.open) panel.open = true;

    if (!panel.open) {
      this._unread += 1;
      badge.textContent = String(this._unread > 99 ? '99+' : this._unread);
      badge.style.display = '';
    } else {
      this._unread = 0;
      badge.style.display = 'none';
    }

    dot.classList.add('active');
    clearTimeout(this._dotTimer);
    this._dotTimer = setTimeout(() => {
      dot.classList.remove('active');
      this._updateButton();
    }, ACTIVE_WINDOW_MS);

    const status = Number(entry.status) || 0;
    const level = status >= 500 ? 'err' : (status >= 400 ? 'warn' : 'ok');
    const icon = status >= 500 ? '❌' : (status >= 400 ? '⚠️' : '✅');
    const method = entry.method || '';
    const line = document.createElement('div');
    line.className = 'ai-activity-entry ' + level;
    let text = `[${formatTime(entry.ts)}] ${icon} ${labelFor(entry)} — ${status}`;
    if (entry.message && level !== 'ok') text += ` · ${entry.message}`;
    else if (method === 'GET') text += ` (GET ${entry.path})`;
    line.textContent = text;
    consoleEl.appendChild(line);
    while (consoleEl.childElementCount > MAX_ENTRIES) consoleEl.firstElementChild.remove();
    consoleEl.scrollTop = consoleEl.scrollHeight;
  },
};

export function initAgentActivity() {
  AgentActivity.init();
}

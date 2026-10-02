# README — Order Automation (Tự Động Hóa Đơn Hàng)

> **Đọc trước nếu bạn là AI agent / developer mới:** file này là bản đồ của toàn bộ dự án.
> Nó cho bạn biết (1) dự án là gì, (2) bắt đầu đọc code từ đâu, và (3) khi cần làm một tác vụ
> cụ thể thì bắt đầu từ file nào, theo bước nào. Đừng sửa code trước khi đọc mục 6 và 7.
>
> **Ghi chú khi vừa đổi IDE / AI coding tool mới:** tool mới không có bộ nhớ về dự án này —
> mọi context cần thiết đã có trong README (bạn đang đọc). `PROJECT_CODE_SUMMARY.md` là dump
> code cũ (7/2026) chỉ dùng tham khảo; khi khác nhau → luôn theo file thật trên đĩa.
> Bắt đầu nhanh: đọc mục 4 (bản đồ file) + mục 6 (quy tắc bất biến) + mục 7 (playbook cho tác vụ).

---

## 1. Dự án này là gì?

Ứng dụng desktop **Electron (Windows)** dùng nội bộ cho đội bán hàng ngành dầu nhớt.
Mục đích: tự động hóa toàn bộ vòng đời một đơn hàng từ đại lý/sales:

1. **Dán tin nhắn đặt hàng** của sales (text tự do, tiếng Việt) vào app.
2. App **phân tích** tin nhắn bằng AI (Gemini/OpenAI) hoặc parser offline (regex + fuzzy matching)
   để ra danh sách sản phẩm + số lượng.
3. Tự động **phân loại chiến dịch** (campaign), **tính giá theo bậc số lượng** (tiered pricing),
   **cộng quà khuyến mãi FOC** và **quà marketing MKT**.
4. **Xuất file Excel** đơn hàng vào template của từng brand (file Excel thật, giữ nguyên công thức
   VLOOKUP/SUM) — chạy qua **Python + win32com** điều khiển Excel thật.
5. **Lên đơn trên KiotViet** (`YOUR_TENANT.kiotviet.vn`) — qua browser agent (MCP), userscript,
   hoặc JSON export.

Các brand đang xử lý: **XVIL, Zentor (MXO/PCMO), Torvex, Veltron, Veltra, Petrix, TVX**
(8 chiến dịch sản phẩm — xem mục campaigns trong `db.js`).

---

## 2. Chạy nhanh (Quick start)

Yêu cầu máy Windows: **Node.js**, **Python 3 + pywin32** (`win32com`), **Microsoft Excel** đã cài.

```bat
:: Cài dependencies (lần đầu)
npm install

:: Chạy app (cách 1 — script tiếng Việt)
Chay Len Don Hang.bat

:: Chạy app (cách 2)
npm start

:: Chạy renderer ở chế độ dev (Vite, port 5173) + Electron
npm run dev
npm run dev:electron

:: Chạy toàn bộ test
npm test

:: Build installer EXE (output: "Ứng dụng Lên Đơn Hàng\")
Build EXE.bat
:: hoặc: npm run build

:: Xuất mã nguồn bàn giao (zip tại "Mã nguồn bàn giao\")
Xuat Ma Nguon.bat
:: hoặc: npm run package:source

:: Kiểm tra sức khỏe môi trường (Node, Python, pywin32, Excel...)
npm run doctor
```

**Biến môi trường** — copy `.env.example` thành `.env`:
- `AI_API_KEY` — key LLM cho AI parser (cũng có thể cấu hình trong app: tab Cài Đặt → AI Analysis).
- `PYTHON_PATH` — đường dẫn đầy đủ tới `python.exe` (nếu không set, app tự dò `python`/`python3`/`py` trên PATH).

> **Máy người dùng cuối (bản installer):** Node.js/Python/Excel chỉ cần cho máy dev.
> Chức năng lên đơn KiotViet chạy được ngay sau khi cài app — bộ điều khiển browser
> (`@playwright/mcp`) đã gói sẵn, chạy bằng runtime Node của Electron; có Chrome hoặc Edge là đủ
> (xem mục 7.4). Xuất Excel vẫn cần Excel thật + Python trên máy đó.

---

## 3. Tech stack

| Lớp | Công nghệ |
|---|---|
| Desktop shell | Electron 33, electron-builder 25 (Windows) |
| Renderer | Vanilla JS ES modules + Vite 8 (entry: `index.html` → `src/main.js`), CSS thuần (dark glassmorphism) |
| State/persist | `store.js` (pub/sub) + `db-store.js` (IndexedDB/localStorage) |
| AI parsing | `ai-service.js` — **12 provider** (Gemini, OpenAI, Claude, DeepSeek, Groq, OpenRouter, Mistral, Qwen, Z.AI GLM, Ollama, LM Studio, Custom), multi-profile failover/round-robin; fallback `parser.js` offline |
| Fuzzy matching | Web Worker `matching.worker.js` (không block UI) |
| Excel export | `excel_automation.py` — Python **win32com** điều khiển Excel thật (giữ công thức nguyên vẹn; openpyxl chỉ dùng cho test/phụ trợ) |
| KiotViet | 3 cơ chế: browser agent MCP (`browser-agent.js` + `mcp-client.js`), userscript (`kiotviet-auto-order.user.js`), automation renderer (`src/kiotviet/automation.js`) |
| MCP cho agent ngoài | MCP Streamable HTTP `127.0.0.1:8048/mcp` (`mcp-server.js`, 36 tools) + stdio proxy cho IDE agent (`mcp-stdio-proxy.js`), token auth cho tool ghi — **docs đầy đủ: `docs/MCP.md`** |
| Test | `node --test` (JS) + `test/test_excel_automation.py` (Python) |

---

## 4. Cấu trúc thư mục (bản đồ)

> **Vị trí dự án (từ 12/09/2026):** toàn bộ dự án nằm trong `C:\Antigravity\Order Automation\` — folder gốc `C:\Antigravity\` giờ là folder quản lý tổng nhiều dự án (chỉ còn `.zcode`, `.agents`, `agentic-awesome-skills-main` và file `AGENTS.md` chỉ dẫn). Repo git, dữ liệu `I.ĐƠN HÀNG`/`Bảng giá`, bản build và mọi path tuyệt đối trong script đều theo đường dẫn mới này. App đã cài chạy độc lập với vị trí source (userData ở `%APPDATA%\order-automation`); `app-config.json` đã được cập nhật `orderDir` sang đường dẫn mới.

### 4.1. Main process (Electron) — CommonJS, chạy ở Node
| File | Vai trò |
|---|---|
| `main.js` | Entry Electron: tạo BrowserWindow, **IPC handlers**, export mutex, kiểm tra khóa file Excel, spawn Python export, ghi `crash.log` |
| `preload.js` | Bridge IPC an toàn → expose `window.electronAPI` cho renderer (whitelist chặt) |
| `mcp-server.js` | MCP server nội bộ (Streamable HTTP `POST /mcp` port **8048**) cho AI agent/tool ngoài gọi — **docs chính thống: `docs/MCP.md`**. 36 tools: read/parse (`get_server_info`, `get_status`, `get_products`, `get_campaigns`, `get_aliases`, `get_kv_map`, `get_memory`, `get_sellers`, `get_current_order`, `export_database`, `get_ai_status`, `get_browser_tools`, `get_browser_snapshot`, `parse_order`, `parse_order_offline`), write (cần token trong `userData/mcp-token.txt`): `upsert_product`, `delete_product`, `add/update/delete_campaign`, `set_aliases`, `set_kv_code`, `set_memory`, `save_sellers`, `import/export_database`, `reset_database` (cần `confirm: true`), `export_excel` (có `dryRun`), `connect_browser`, `execute_browser_tool`, `run_kiotviet_order`, `auto_run_order` (1-click), `abort_run`, `test/manage_ai_profiles` (apiKey bỏ trống = giữ key cũ, response không bao giờ chứa key). IDE agent (ZCode/Cursor/Claude) nối qua stdio proxy `mcp-stdio-proxy.js` (config sẵn `.zcode/config.json`). Mọi thao tác của agent hiển thị realtime trên panel **"Hoạt Động AI"** của UI (event `agent-activity`; nút phải panel là nút kép: "Xóa" dọn log + ẩn panel khi AI rảnh, "Ngắt" hủy run khi AI đang thao tác). Data layer: `src/api/headless.js` (`window.__ORDER_API__` v2) |
| `browser-agent.js` | Agent loop: MCP → tự thao tác trên KiotViet; VERIFY DOM (read-back giỏ) **gate auto-submit** (`fillVerifyBlocked`: SP thất bại / lệch SL/giá / không đọc được kết quả fill → không tự bấm Đặt hàng); AI Verify (tùy chọn, mặc định tắt) dùng đúng AI profile chọn trong modal KV (`options.aiConfig`), không chọn thì mặc định LM Studio (`localhost:1234`) |
| `browser-agent-ipc.js` | IPC wiring renderer ↔ browser agent; spawn MCP server bằng Electron-as-Node (`ELECTRON_RUN_AS_NODE`), chọn browser Chrome → Edge → Brave |
| `mcp-client.js` | MCP client (JSON-RPC qua stdio tới Playwright MCP server) |
| `script-registry.js` | Kho script browser tái sử dụng (`~/.kv-browser-profile/script-registry/scripts.json`) — script chạy tốt được lưu lại để lần sau 0 AI call |
| `kv-browser-helpers.js` | Helper DOM cho KiotViet |

### 4.2. Renderer (UI) — ES modules
File gốc ở **root**, module tính năng ở **`src/`**:

| File / thư mục | Vai trò |
|---|---|
| `index.html` | SPA chính (3 tab: Nhập Đơn Hàng / Danh Mục Sản Phẩm / Cài Đặt & Dữ Liệu); load `<script type="module" src="/src/main.js">` |
| `style.css` | Design system (CSS variables, dark theme) |
| `src/main.js` | **Entry renderer**: import và khởi tạo mọi feature module — thêm module mới phải init ở đây |
| ~~`app.js`~~ | **Đã dọn khỏi root (9/2026)**: legacy monolith của renderer, logic chạy thật đã module hóa vào `src/` từ lâu nên file được chuyển sang `test/fixtures/app-legacy.js` — chỉ `test/app.test.js` còn require để test các util cũ (`debounce`, `WorkerManager`, `getFinalUnitPrice`). Sửa tính năng thì sửa trong `src/`, đừng hồi sinh file này |
| `ui-renderer.js` | Render bảng sản phẩm, đơn hàng, drag-and-drop; toast `showToast` |
| `db.js` | **Logic database**: `ProductDatabase`, alias manager, `classifyOrder()`, `getKvCode()`, FOC/MKT engine — KHÔNG còn chứa dữ liệu giá (đã tách 10/2026); dữ liệu nạp từ `default-db.json` qua import |
| `default-db.json` | **Nguồn dữ liệu thật** (530 SP, `priceVersion`, `promoRulesVersion`) — db.js import trực tiếp, Vite nhúng vào bundle dist khi build — **chỉ tồn tại local, KHÔNG nằm trong git/GitHub** vì chứa giá hàng nội bộ (đã purge khỏi lịch sử 10/2026); khôi phục từ backup hoặc `npm run sync:default-db` sau khi clone |
| `kv-name-map.json` | Mapping tên sản phẩm → mã KiotViet (kvCode); được copy vào `dist/` khi build — **chỉ tồn tại local, KHÔNG nằm trong git/GitHub** vì chứa mã KV nội bộ (đã purge khỏi lịch sử 10/2026) |
| `default-aliases.json` | DEFAULT_ALIASES — alias tên hàng hóa (db.js import trực tiếp) — **chỉ tồn tại local, KHÔNG nằm trong git/GitHub** (tách khỏi db.js 10/2026) |
| `internal-codes.json` | Mã KV hàng quà tặng MKT dùng trong logic seed — **chỉ tồn tại local, KHÔNG nằm trong git/GitHub** (tách khỏi db.js 10/2026) |
| `default-memory.json` | Bộ nhớ mặc định AI (DEFAULT_MEMORY) — db.js import trực tiếp — **chỉ tồn tại local, KHÔNG nằm trong git/GitHub** (tách khỏi db.js 10/2026) |
| `ai-classifier.json` | Rules phân loại AI (từ khóa thương hiệu/hàng hóa) — db.js import trực tiếp — **chỉ tồn tại local, KHÔNG nằm trong git/GitHub** |
| `local-config.json` | Cấu hình máy: `kvTenantUrl` (domain tenant KiotViet) — browser-agent + browser-agent-ipc đọc qua fs — **chỉ tồn tại local, KHÔNG nằm trong git/GitHub**; thiếu file → fallback `https://YOUR_TENANT.kiotviet.vn` |
| `db-store.js` | Lớp lưu trữ bền vững (IndexedDB/localStorage) |
| `store.js` | State management pub/sub |
| `parser.js` | Parser offline: regex + normalize + fuzzy matching |
| `matching.worker.js` | Web Worker fuzzy matching |
| `ai-service.js` | Gọi LLM parse tin nhắn — 12 provider, multi-profile (failover/round-robin), key mã hóa safeStorage |
| `ai-providers.mjs` | Registry **12 provider AI**: endpoint, model mặc định, model gợi ý (`models` cho datalist), link lấy key (`keyUrl`), structured output |
| `sync.js` | Đồng bộ dữ liệu sản phẩm từ Excel vào db |
| `kv-import.js` | Import mapping KV từ Excel |

### 4.3. `src/` — feature modules (ES modules)
```
src/
├── main.js               # Entry renderer (khởi tạo app + global error handler → toast "Lỗi promise")
├── order/
│   ├── actions.js        # Sửa/xóa/reorder item, quà tặng, custom promo, validate trước xuất; parseOrder giờ chỉ XẾP HÀNG task parse nền
│   ├── parse-pipeline.js # ★ Pipeline phân tích AI THUẦN (không UI): AI → sanitize → repair → match → brand-ctx → AI-FINAL → price-guard → học alias. Dùng chung cho parse thường & song song
│   ├── parse-queue.js    # ★ Hàng đợi phân tích SONG SONG (mặc định 2, setting 1–5): dán liên tiếp nhiều đơn, xong tự vào Đơn chờ duyệt; dải trạng thái #parseQueueStrip
│   ├── parse-apply.js    # Áp kết quả parse lên màn hình (store + form + preview + toast) khi màn hình đang chờ đúng đơn đó
│   ├── builder.js        # Dựng object đơn hàng + auto-rescan khi text đổi
│   ├── calculator.js     # Tính giá bậc (tiered), tổng tiền
│   ├── export.js         # ★ Dựng payload JSON → gửi IPC xuất Excel; AI diagnose lỗi file; dialog kết quả từng hãng
│   ├── pending.js        # ★ Đơn chờ duyệt: TỰ ĐỘNG lưu/giữ qua đóng-mở app; chỉ rời khi bấm Hoàn tất hoặc Xóa; tab Đã xử lý (có "Mở lại"); createPendingFromOrder cho parse nền
│   ├── note-sanitizer.js # Làm sạch ghi chú đơn hàng
│   ├── extraction-repair.js / json-extractor.js # Sửa lỗi trích xuất JSON từ AI
│   ├── tln-coverage.mjs  # ★ Kiểm tra bản chia dòng AI phủ đủ nội dung dán + tách dòng quy tắc cục bộ
│   └── order-schema.mjs  # Schema validate output AI
├── catalog/delegation.js # Event delegation tab Danh Mục
├── kiotviet/automation.js# Tự động hóa KiotViet phía renderer (capture id đơn chờ trước khi agent chạy nền)
├── settings/ui.js        # UI tab Cài Đặt & Dữ Liệu
├── ai/profile-manager.js # Quản lý AI profiles (provider/model/key)
├── api/headless.js       # HeadlessOrderAPI — pipeline parse chạy qua executeJavaScript
├── prefix/manager.js     # Quản lý mã tiền tố đơn hàng
├── seller/manager.js     # Dropdown người nhận đặt + bộ đếm số PO (peek/commit)
├── customer-notes.js     # Ghi chú khách hàng
├── product-edit.js       # Sửa sản phẩm (kèm audit)
├── edit-tracker.js       # Theo dõi chỉnh sửa
├── worker-manager.js     # Quản lý matching worker
├── ui/confirm-dialog.js  # ★ Modal confirm + focus trap (thay window.confirm/alert)
├── ui/persist-watch.js   # Giám sát lỗi persist → banner cảnh báo
├── logger.js, utils.js   # Tiện ích
└── matching.worker.js    # Web Worker fuzzy matching
```

### 4.4. Python & script hệ thống
| File | Vai trò |
|---|---|
| `excel_automation.py` | ★ **Xuất Excel thật qua win32com**: clone sheet template, chèn dòng, FillDown công thức, dọn ô lỗi `#N/A`/`0`, giữ VLOOKUP/SUM nguyên vẹn. CLI: `python excel_automation.py --file <xlsx> --customer <tên> --date <ngày> --items <items.json> [--tln <tln.json>] [--title <tiêu đề>]` |
| `excel_create_month.py` | Clone template Excel theo tháng mới cho từng brand |
| `launch-order-app.ps1` | Script khởi chạy app (PowerShell) |
| `scripts/doctor.js` | Khám bệnh môi trường (`npm run doctor`) |
| `scripts/sync-default-db.js` | Đồng bộ `db.js` → `default-db.json` |
| `validate-build.js` | Kiểm tra pre/post build (được `npm run build` gọi) |

### 4.5. Dữ liệu nghiệp vụ (KHÔNG phải code)
| Thư mục | Nội dung |
|---|---|
| `I.ĐƠN HÀNG/` | **Template + file Excel đơn hàng theo brand & tháng**: `1. VELTRA`, `2. XVIL`, `3. PETRIX`, `4. VELTRON`, `5. TORVEX`, `6. ZENTOR`, `Lub-sales report-*` (báo cáo doanh thu/hoa hồng). File backup hậu tố `_backup_<timestamp>` do app tự tạo trước khi ghi |
| `Bảng giá/` | Bảng giá NPP (PDF/Excel) |
| `Ứng dụng Lên Đơn Hàng/` | Output build (installer + unpacked) — không sửa tay |

### 4.6. Tài liệu & artifact (đọc để hiểu ngữ cảnh/lịch sử)
| Đường dẫn | Nội dung |
|---|---|
| `ORIGINAL_REQUEST.md` | Các yêu cầu gốc của user theo thời gian — đọc để biết "tại sao có code này" |
| `PROJECT_CODE_SUMMARY.md` | **Bản dump toàn bộ mã nguồn + kiến trúc (~252KB)** — tra cứu chi tiết nhất; mục 6 là kiến trúc & quy tắc kinh doanh |
| `docs/MCP.md` | ★ **MCP Reference chính thống** cho agent ngoài (thay thế `docs/API.md` — REST API cũ đã xóa) |
| `docs/plans/` | Kế hoạch tối ưu gần đây |
| `.agents/` | Artifact các phiên đa agent (briefing/handoff/progress) — lịch sử, không phải code chạy |
| `.archive/` | Artifact đã về hưu: `MCP Gate/` (browser-agent cũ), backup DB/kv-map 24/8, zip source cũ — lịch sử |
| `agentic-awesome-skills-main/` | Kho skills agent (`.agents/skills.json` tham chiếu) |

### 4.7. Test
| File | Kiểm tra |
|---|---|
| `test/parser.test.js` | Parser offline |
| `test/app.test.js` | Logic app (debounce, WorkerManager, getFinalUnitPrice) |
| `test/excel_automation.test.js`, `test/excel_smoke.test.js` | Pipeline xuất Excel |
| `test/note-sanitizer.test.mjs` | Làm sạch ghi chú |
| `test/product-edit.test.mjs` | Sửa sản phẩm |
| `test/alias-audit.test.js` | Audit alias |
| `test/matching-golden.test.mjs` | Golden test fuzzy matching |
| `test/rescan.test.mjs` | Rescan dữ liệu |
| `test/json-extractor.test.mjs` | Trích xuất JSON từ phản hồi LLM |
| `test/extraction-repair.test.mjs` | Tự sửa dữ liệu JSON lỗi từ LLM |
| `test/order-schema.test.mjs` | Kiểm tra schema dữ liệu đơn hàng |
| `test/db-store.test.mjs` | Tầng lưu trữ IndexedDB/localStorage |
| `test/pending-orders.test.mjs` | Đơn chờ duyệt: auto-save, dedup, chỉ Hoàn tất/Xóa mới rút đơn, giữ qua restart, chống hồi sinh, mở lại đơn Đã xử lý |
| `test/parse-queue.test.mjs` | Hàng đợi parse song song: giới hạn cùng lúc, chặn trùng, chọn đường màn hình/chờ duyệt, lỗi + thử lại, hủy, offline fallback |
| `test/tln-coverage.test.mjs` | Độ phủ trích xuất từng dòng lời thoại sales |
| `test/browser-agent.test.js` | 2 chế độ lên đơn KV (giỏ mới / bổ sung) qua mock POS + Electron harness |
| `test/browser-agent-ipc.test.js` | Kết nối KV "zero-install": fallback Chrome→Edge→Brave, spawn Electron-as-Node, fake MCP server |
| `test/mkt-gifts.test.mjs` | Quy tắc quà MKT theo mốc doanh số/thùng |
| `test/price-disambiguation.test.mjs` | Cơ chế gần giá và phân biệt sản phẩm |
| `test/correction-learning.test.mjs` | Học sửa đổi từ thao tác người dùng |
| `test/offroad-qualifier.test.mjs` | Qualifier "off road": thứ tự đảo/dấu phẩy/multiline không nhầm Chain Lube bản trắng; merge dòng continuation |
| `test/mcp-server.test.js` | MCP initialize, tool catalog 36 tools, token gate, APP_NOT_READY/BROWSER_NOT_CONNECTED/UNAUTHORIZED, 404/403 transport, encoding TV |
| `test/price-seed-migration.test.mjs` | Seed giá theo `priceVersion` cho máy cũ (giữ kvCode tay, giữ SP user tự thêm) |
| `test/promo-text-rules.test.mjs` | Đăng ký "chương trình KM dạng text" (promoTextRules): match keyword 2 chiều, unitHint, scope campaign/global, resolve trước fuzzy |
| `test/test_excel_automation.py` | Helper/unit test phía Python |

Chạy: `npm test` (32 file; 25/09/2026: **495 tests — 494 pass, 1 skipped**; skip duy nhất là smoke Excel-COM vì thiếu workbook sandbox).

---

## 5. Kiến trúc & luồng dữ liệu

```
┌──────────────────────── Electron App ────────────────────────┐
│  MAIN (main.js)                                              │
│   ├─ IPC handlers (export-excel, save-file, dialog...)       │
│   ├─ mcp-server.js ← MCP Streamable HTTP 127.0.0.1:8048/mcp (token auth) │
│   └─ browser-agent-ipc.js → browser-agent.js → mcp-client.js │
│                                          │                   │
│  RENDERER (index.html + src/main.js)     │                   │
│   ├─ parser.js / ai-service.js (phân tích tin nhắn)          │
│   ├─ db.js (sản phẩm, campaign, FOC/MKT, kvCode)             │
│   ├─ order/calculator.js + builder.js (giá, đơn hàng)        │
│   └─ order/export.js (dựng payload xuất Excel)               │
└──────────┬──────────────────────────────┬────────────────────┘
           │ execFile python              │ BrowserMCP / userscript
           ▼                              ▼
  excel_automation.py              YOUR_TENANT.kiotviet.vn
  (win32com → Excel thật)          (lên đơn KiotViet)
           │
           ▼
  I.ĐƠN HÀNG/<brand>/<tháng>/<file>.xlsx  (+ bản backup _timestamp)
```

**Luồng một đơn hàng:**
1. User dán tin nhắn → bấm "Phân tích" → **xếp hàng parse nền** (`src/order/parse-queue.js`): nhiều đơn được AI
   phân tích SONG SONG (mặc định 2, setting 1–5 trong Cài đặt → AI), cùng pipeline chất lượng như parse thường
   (`src/order/parse-pipeline.js`: AI → sanitize → repair → match → brand-ctx → AI-FINAL → price-guard → học alias).
   Ô tin nhắn tự do ngay để dán đơn kế tiếp; quá hạn mức → đơn đứng chờ trong hàng đợi, tự chạy tiếp khi có
   slot (muốn tuần tự hoàn toàn → đặt 1). Bấm Phân tích có toast xác nhận đã xếp hàng. Đơn xong: hiện trên màn
   hình nếu user vẫn chờ đúng đơn đó (`parse-apply.js` — kể cả khi nháp auto-save đã gắn `_pendingId`), và được
   lưu vào **Đơn chờ duyệt NGAY** (không chờ debounce 2s); nếu màn hình đang bận việc khác → đổ thẳng vào
   **Đơn chờ duyệt** (`pending.createPendingFromOrder`, dedup theo rawChatText — nạp đè bản nháp 📝).
   Task ✅ giữ trên dải trạng thái 6s rồi tự ẩn. Lỗi → task ❌ + Thử lại; hủy được từng task hoặc tất cả.
2. `db.classifyOrder()` detect campaign từ sản phẩm.
3. `order/calculator.js` áp giá bậc theo số thùng; FOC tự thêm khi đủ ngưỡng; MKT hiển thị dạng banner/badge.
4. `order/export.js` dựng payload JSON (items + `kvCode` unit-aware: chai = mã gốc, thùng = mã gốc + `-1`/override) → IPC → `main.js` spawn `excel_automation.py` (timeout 2 phút, có mutex chống ghi đồng thời, kiểm tra file đang bị Excel khóa).
5. Python clone sheet template, chèn dòng, `FillDown` công thức, dọn ô lỗi `#N/A`/`0`, ghi mã KT — **không bao giờ ghi đè text cứng lên cột có công thức VLOOKUP**.
6. KiotViet: export JSON → (a) browser agent MCP, (b) userscript `kiotviet-auto-order.user.js` (hỗ trợ WebSocket API), hoặc (c) `src/kiotviet/automation.js`.

---

## 6. Quy tắc bất biến — ĐỌC TRƯỚC KHI SỬA CODE

1. **Không ghi đè text cứng lên cột công thức Excel** (Phân loại, Bao bì/Spec, mã KT, thành tiền, footer SUM). Excel phải tự chạy VLOOKUP/SUM; Python chỉ FillDown/tái gieo công thức, chỉ ghi giá trị static khi ô đích **không có formula**.
2. **`kvCode` là bất biến** — khi sync/import từ Excel chỉ attach thêm, KHÔNG overwrite mã đã có. Nguồn chân lý theo thứ tự: `kv-name-map.json` → `product.kvCode` → hậu tố `-1`/override cho đơn vị thùng (`db.getKvCode(product, unit)`).
3. **Tên sản phẩm phải khớp dữ liệu Excel "good data"** — không dùng format nội bộ khi xuất.
4. **MKT gifts** lưu trong `mkt_gift_rules`, KHÔNG inject sản phẩm giả vào `DEFAULT_DB`. Mỗi mốc khai quà bằng `gift_items` (link `product_id` trong danh mục; quà "1 trong N" thêm `give_product_options`). **Hàng tặng KHÔNG tính vào tổng thùng/tiền xét mốc MKT** (`ui-renderer.js` bỏ qua item `isGift` khi cộng `campaignTotals`; `db.getMKTGifts` làm tròn xuống số thùng nguyên cho mốc `unit: "boxes"`). Test: `test/mkt-gifts.test.mjs`.
5. **FOC rows**: khi xuất Excel phải xóa nội dung các ô hiển thị (cột đỏ C, D, E, G, H, K) nhưng **giữ mã KT** với hàng dầu nhớt.
6. **Backup trước khi ghi** file Excel đơn hàng (`*_backup_<timestamp>`); không bao giờ ghi khi file đang bị Excel khóa (`~$file.xlsx`).
7. **`preload.js` có whitelist IPC chặt** — thêm IPC channel mới phải khai báo đủ 3 nơi: `main.js` (handler), `preload.js` (whitelist), renderer (nơi gọi).
8. **Renderer là vanilla JS + ES modules** (không framework); entry là `src/main.js`. Comment trong code viết **tiếng Việt** — giữ nguyên phong cách.
9. **`db.js` chỉ còn logic (~3.100 dòng)** — dữ liệu danh mục + giá nằm riêng ở `default-db.json` (11.400+ dòng khi render, local-only) mà db.js import với `with { type: 'json' }`. Sửa logic đụng db.js, sửa dữ liệu đụng `default-db.json`.
10. Thanh toán: CK (chuyển khoản), COD (thu hộ), TT (tiền mặt), Công nợ.
11. **Đơn chờ duyệt — TỰ ĐỘNG LƯU + chỉ rời danh sách khi bấm "Hoàn tất" hoặc "Xóa"**: đơn đang soạn
    (≥1 SP hoặc nháp text chưa parse) được auto-save vào envelope `order_automation_pending_state_v2`
    trong IndexedDB/localStorage (debounce 2s sau mỗi
    thay đổi state/input; không bắt buộc tên KH — hiện "(không tên)"); nút "Lưu chờ duyệt" thủ công
    lưu ngay + toast. Đóng rồi mở lại app, record vẫn còn nguyên và mở được; nếu lỗi đọc
    storage, app chặn ghi thay vì đè danh sách cũ bằng mảng rỗng. Trên mỗi card đã có sản phẩm,
    nút **"Xuất Excel"** xuất thẳng snapshot của đúng đơn (không nạp đơn lên editor); nút **"Lên KiotViet"**
    mở thẳng modal preview/tùy chọn của đúng đơn, vẫn phải bấm "Bắt đầu lên đơn" để chạy. Sau khi flow
    kết thúc, danh sách mở lại; chip đã xanh bị disable để tránh tạo file/đơn trùng. Cả hai luồng deep-clone
    order trước khi dựng rows vì `getOrderTableRows()` có mutate subtotal/rowOrder, có lock chống double-click,
    và chỉ `markDone(id, source, expectedSignature)` khi thành công + record chưa bị sửa trong lúc chạy.
    `markDone` chỉ bật chip ✓ tiến độ, KHÔNG rút record — đủ cả hai bước đơn vẫn ở "Chờ duyệt". Chỉ nút
    **"Hoàn tất"** (chuyển sang lịch sử "Đã xử lý", giữ tối đa 3 ngày / 30 bản) hoặc **"Xóa"** (xoá vĩnh viễn,
    cả hai có confirm) mới được rút khỏi danh sách. Parse đơn MỚI phải reset `_pendingId: null`. Nếu nội dung
    một record đã xuất/lên KV thay đổi, cả `excelDone` và `kvDone` reset false vì kết quả cũ không còn áp dụng.
    Sau Hoàn tất/Xóa, auto-save chặn "hồi sinh" khi signature nội dung chưa đổi; nếu nội dung thật sự đổi
    thì lưu thành bản ghi mới. **"Mở để sửa"** flush `autoSaveNow` TRƯỚC khi thay thế màn hình. Form lưu cả
    `orderText`; nháp 0 SP mở ra bấm Phân tích là thành đơn thật. Lịch sử "Đã xử lý" giữ đủ dữ liệu để
    **"Mở lại"** đưa đơn về Chờ duyệt. Test: `test/pending-orders.test.mjs`,
    `test/pending-direct-export.test.mjs`, `test/kv-pending-direct.test.mjs`.
12. **Sửa renderer mà không thấy tác dụng** → kiểm tra đã `npm run build:renderer` + restart app chưa (mục 7.1).
13. **Không thêm `contain: layout` (hay `overflow` khác `visible`) lên `.order-results` và các tổ tiên giữa nó với `.order-split`** — `contain: layout` biến phần tử thành containing block của `position: sticky`, phá thanh tổng kết (`#orderSummary`, sticky bottom) lẫn tiêu đề bảng (`.order-table thead th`, sticky top). Lỗi từng xảy ra 28/8/2026: thanh tổng kết trôi theo trang khi cuộn. **Cả class tạm `is-dragging`** (kéo sắp xếp dòng đơn) từng là thủ phạm tiềm ẩn thứ 2: `.order-results.is-dragging` PHẢI dùng `overflow: clip` (không được `hidden` — hidden tạo scroll container); cleanup class này nằm ở `clearDragState()` gọi trong CẢ `drop` lẫn `dragend` + tự chữa ở đầu `renderOrderResults` (07/9/2026 — trước đây chỉ có `dragend` trên tbody, drop re-render detach dòng nguồn → dragend không bubble → class kẹt → mất sticky tới khi tắt app).
14. **Unit hint trong `findBestProductMatch` chỉ là tie-breaker, không lật được match tên** — ứng viên khớp ĐỦ từ khóa tên (chấm ≥100 điểm) là ứng viên trừ khi sales ghi GIÁ (cơ chế gần giá vẫn thắng tất cả); bonus/penalty đơn vị chỉ phân xử giữa các ứng viên <100 khi chênh nhau ít, tính theo TẦNG TÍN HIỆU: unit bán trùng hint `+15`, spec `+10`, packaging `+5` (pack "12 chai/thùng" gần như SP chai nào cũng có → tín hiệu yếu, lỗi 04/9: 2 bản Veltron Engine Cleaner hòa điểm vì cùng pack → chọn nhầm bản bình). NGOẠI LỆ duy nhất cho alias: sales đích danh đòi đơn vị khác đơn vị bán của SP alias (`wantsOtherUnit` — cả hint lẫn unit SP đều nằm trong `UNIT_HINT_TERMS` và khác nhau) → fuzzy có unit bonus được lật alias nếu khớp tên ≥ điểm alias (`via: 'fuzzy-unit-over-alias'`); ngoài case này alias vẫn tuyệt đối (bất biến correction-learning). RIÊNG hint `thùng` không bao giờ kích hoạt `wantsOtherUnit` (`BULK_HINT_UNITS` — thùng là quy đổi số lượng của CHÍNH SP đó, kvCodeThùng = mã gốc + "-1", không phải đòi quy cách khác); lỗi 22/9/2026: để hint "thùng" kích hoạt, "1 Thùng Chain Cleaner" (alias tự học → bản Zentor) bị nhả cho fuzzy, hòa 100-100 với Xvil Chain Cleaner rồi tie-break "ít từ hơn thắng" chọn nhầm brand. `"bình"` ≡ `"chai"` trong thực tế bán hàng (không nằm trong `SOFT_CONFLICT_HEAVY`, không bị trừ điểm) — chính catalog Zentor ghi "(1L/bình)" cho SP bán theo chai. Lỗi từng xảy ra 04/9/2026: "1 chai Fork 10 giá thùng" trúng nhầm Zentor Topgear GP Fork Oil 10W thay vì Xvil Fork 10 (sai brand, sai kvCode, chênh 58k/chai). Test: `test/matching-golden.test.mjs` (case "989 Workhop"), `test/price-disambiguation.test.mjs` (đơn "Nam Thành").
15. **Bộ đếm số PO chỉ tăng khi Xuất Excel THÀNH CÔNG** — `generateOrderTitle()` (`src/seller/manager.js`) là
    hàm thuần: peek STT kế tiếp qua `peekOrderSequence()` (KHÔNG ghi localStorage); chỉ gọi
    `commitOrderSequence(brand, seq)` sau khi IPC `exportOrder` trả `success` (GUI: `src/order/export.js`,
    headless MCP: `src/api/headless.js` — dryRun KHÔNG BAO GIỜ commit). Xuất lỗi rồi xuất lại phải dùng lại
    đúng số cũ (không phát sinh khoảng trống STT); commit có guard `seq > current` (không lùi bộ đếm khi user
    đã đặt lại STT trong Cài đặt). AI-retry dùng lại payload cũ (giữ số đã peek), thành công mới commit.
    Test: `test/order-title-sequence.test.mjs`.

---

## 7. Playbook — cần làm X thì bắt đầu từ đâu?

### 7.1. Sửa lỗi / thêm tính năng XUẤT EXCEL
1. Đọc plan liên quan trong `docs/plans/` (spec cũ trong `.trae/` đã dọn vào `.archive/`).
2. Payload phía JS: `src/order/export.js` (item, kvCode, quà FOC/MKT).
3. Logic ghi Excel: `excel_automation.py` (`write_items`, FillDown, dọn ô lỗi, footer SUM,
   `normalize_item_row_heights` — quy ước chiều cao dòng cố định, chỉ giãn dòng tên SP dài vượt merge).
4. IPC + spawn Python + khóa file: `main.js` (tìm `excel_automation.py`, `EXPORT_TIMEOUT_MS`).
5. ⚠️ **Sau khi sửa renderer**: chạy `npm run build:renderer` rồi **khởi động lại app** — app thường nạp
   bundle từ `dist/`, không phải `src/` (quên bước này → tưởng code sai trong khi chỉ chưa build).
   Sửa `excel_automation.py` thì phải copy sang `Ứng dụng Lên Đơn Hàng\win-unpacked\resources\app.asar.unpacked\` nếu chạy bản installed.
6. Chạy `npm test` (excel tests) và test tay: xuất 1 đơn thật, mở Excel kiểm tra công thức còn nguyên.

### 7.2. Thêm/sửa SẢN PHẨM, CAMPAIGN, GIÁ, FOC/MKT
1. Sửa `default-db.json` (nguồn dữ liệu thật — db.js import trực tiếp; sync từ export app bằng `npm run sync:default-db`).
   - ⚠️ **Cập nhật bảng giá/danh mục muốn máy cũ tự nhận khi cài đè bộ cài**: ngoài việc sửa dữ liệu
     trong `default-db.json`, phải **bump trường `"priceVersion"`** (VD `"2026.09"` → `"2026.10"`).
     Lúc boot, máy có db cũ trong IndexedDB thấy `priceVersion` khác bản seed sẽ tự chạy
     `_applyPriceSeedMigration()` — seed `name/spec/packaging/unit/box_size/tiers/foc_rules/mkt_gift_rules`
     từ catalog kèm bộ cài vào db đã lưu (KHÔNG đụng kvCode, alias, SP user tự thêm, đơn hàng, AI config).
     Không bump version → máy cũ tiếp tục chạy dữ liệu cũ dù đã cài bộ cài mới. Test: `test/price-seed-migration.test.mjs`.
   - `mkt_gift_rules` (quà MKT theo mốc thương hiệu): khai `gift_items` có `product_id` trỏ sản phẩm quà trong danh mục — KHÔNG dùng chuỗi `gifts` trần (mốc XVIL "1 thùng" là ví dụ quà 1-trong-N qua `give_product_options`). Sửa thẳng trong `default-db.json` (db.js không còn chứa dữ liệu).
   - `promoTextRules` (chương trình KM dạng text — từ v1.2.0): mỗi rule khai `keywords` (từ khóa sales ghi, bỏ dấu cũng khớp), `unitHint` (tùy chọn), `productId` (sản phẩm quà chuẩn hóa trong danh mục), `defaultQty`, `global` (áp dụng mọi campaign). `db.getPromoTextMatch()` resolve trước mọi heuristic/fuzzy trong `processExplicitGift()` — KHÔNG cần bump priceVersion (không đụng dữ liệu máy cũ, rule là cấu hình user tự thêm). *(UI đăng ký rule — nút "📝 Đăng ký KM" trên bảng đơn + card Settings — đã bỏ từ 23/9/2026; engine nhận diện và dữ liệu rule vẫn giữ nguyên.)*
   - **Đổi vị trí rule KM (từ 16/9/2026)**: các danh sách rule khuyến mãi trong Settings editor (mốc MKT thương hiệu, FOC theo sản phẩm, MKT theo sản phẩm) xếp lại bằng **kéo thả** — giữ drag-handle (⣿) kéo dòng tới vị trí mong muốn trong CÙNG danh sách; thứ tự lưu thẳng vào `campaign.promoRules[]` (không cần bump priceVersion — không đụng dữ liệu máy cũ). Tab Danh Mục vẫn dùng nút ▲/▼ (đã có từ 07/9).
   - **Đổi tên sản phẩm qua UI** (`applyProductFieldEdit` field `name`): tên cũ TỰ ĐỘNG thành alias của SP đó (`result.aliasAdded`) — sales gọi tên cũ vẫn khớp đúng SP, và alias ưu tiên hơn mọi fuzzy/price hint. Không cướp alias đã thuộc SP khác.
   - **Sửa tay SP sai trên bảng đơn** (`changeRowProduct`): mọi cú sửa tay (chọn từ combobox hoặc gõ lại) đều TỰ HỌC alias "tên sales gõ" (`rawProduct` **hoặc** `rawName` của dòng chưa khớp) → SP user chọn, kèm toast ↩ Hoàn tác. Alias học được thắng mọi tín hiệu ở lần parse sau (alias là ưu tiên cao nhất sau mã KV). Test: `test/correction-learning.test.mjs`.
2. Mapping mã KiotViet: `kv-name-map.json` (hoặc tab Cài Đặt trong app / `kv-import.js`).
   - **Form thêm SP 1 lần đủ (từ 16/9/2026)**: modal Thêm SP gồm giá NHIỀU mốc ngay lúc tạo (mặc định 1 dòng "Tất cả"),
     ô **mã KV thùng** riêng (trống = tự phân mã lẻ + '-1'),
     preview **"Hiển thị trên đơn: 12 chai/thùng"** live theo box_size + đơn vị, và section gập
     **KM nhanh "Mua X tặng Y cùng loại"** (tạo luôn rule qty/foc với `productId: '__same__'`).
     Lưu qua `createProductFull()` trong `src/product-edit.js` (addProduct + tiers + alias + KV gốc/thùng + rule KM),
     validate chung `validateNewProduct()` (tên trống, box_size rác — KHÔNG tự ép 12 im lặng, giá âm,
     mã KV trùng SP khác, alias cướp — lỗi hiện đỏ inline tại từng ô). Giá 0đ là hợp lệ, không cần cờ quà/tặng.
3. Kiểm tra missing KV code: `node check_kv_codes.js` → `missing_kv_codes_report.md`.
   - **Badge "sức khỏe" SP trong Danh Mục**: mỗi dòng catalog chỉ gắn cờ ⚠ khi thiếu mã KV hoặc chưa có mốc giá;
     giá 0đ không bị xem là lỗi. Filter nhóm hàng có mục "⚠ Cần hoàn thiện" để xử lý hàng loạt.
   - **UX xem Danh Mục (từ 16/9/2026)**: bấm vào **tên SP** mở/đóng chi tiết (không chỉ nút ▸ nhỏ);
     header thương hiệu hiện **"X/Y khớp"** khi đang lọc (tìm kiếm/nhóm hàng/cần hoàn thiện) thay vì tổng số;
     thương hiệu không còn SP khớp bộ lọc thì ẩn cả section; dải badge tự wrap xuống dòng ở màn hình ≤1100px.
   - **Nút "💾 Lưu thành SP" trên dòng tự nhập** ở bảng đơn: mở form thêm hàng đã điền sẵn tên/đơn vị/giá,
     lưu xong học tên custom thành alias + gắn SP mới vào dòng (`saveCustomAsProduct` trong `src/order/actions.js`).
4. Chạy `npm test` (alias-audit, matching-golden, mkt-gifts, product-create).

### 7.3. Sửa PARSER tin nhắn (AI hoặc offline)
1. Offline: `parser.js` + `matching.worker.js`; test: `test/parser.test.js`, `test/matching-golden.test.mjs`, `test/price-disambiguation.test.mjs`.
2. AI: `ai-service.js` (+ profiles: `src/ai/profile-manager.js`, providers: `ai-providers.mjs`).
   - **Pipeline parse nằm ở `src/order/parse-pipeline.js`** (tách từ `actions.js` 22/09/2026) — module THUẦN,
     inject `{ db, aiService }`, không đụng store/DOM/toast. Parse thường (màn hình) và parse SONG SONG
     (`src/order/parse-queue.js`) đều đi qua đúng pipeline này — sửa chất lượng parse chỉ cần sửa 1 nơi.
     `parseOrder` trong `actions.js` giờ chỉ đọc text + xếp hàng; hậu kỳ UI nằm ở `parse-apply.js`.
   - **Profile AI (Cài đặt → AI)**: đa profile 12 provider, failover/round-robin, key mã hóa safeStorage. Form thêm profile có **datalist gợi ý model** (registry `models`; bấm "Test Kết Nối" nạp thêm model thật từ `/v1/models`), link **"Lấy API key"** theo provider (`keyUrl`), nút **"🔌 Test tất cả"**. Dòng AI dưới sidebar click → mở thẳng tab này. Cùng tab có **"Phân tích song song"** (1–5, mặc định 2 — localStorage `parse_queue_concurrency`).
   - **Dropdown "AI Provider" trong modal KiotViet** truyền đúng profile được chọn vào AI Verify (`options.aiConfig` — trước 9/2026 lựa chọn bị bỏ qua, luôn rơi về LM Studio).
   - Khớp SP có 3 lớp tín hiệu phân biệt: thuộc tính (hard filter) → đơn vị → **GIÁ** (cơ chế "gần giá nào chọn giá đấy": giá sales khớp gần chính xác giá list ≤2% → +45 gần-quyết định, lệch xa dần trừ dần tới −15; so cả mốc giá chai lẫn giá thùng). Giá là tiêu chí quyết định khi 2 brand trùng tên gọi (VD "Fork 10" tồn tại ở cả Xvil 173k lẫn Zentor 228k). Không có giá sales → xếp hạng như cũ theo tên/đơn vị.
   - `actions.js` có **Price-Guard** cuối flow: giá sales lệch rõ SP đã chọn mà có SP khác khớp ĐÚNG giá + tên đủ giống (score ≥60) → tự đổi SP (`matchVia: 'price-fix'`). Guard KHÔNG đụng dòng khớp qua `alias`/`kvcode` — alias là ưu tiên cao nhất sau mã KV.
   - Tên khách có thể bắt đầu bằng số ("7C motor") — dòng đầu có ≥2 chữ cái, không phải mảnh số lượng/giá → customer.
   - **Ký tự rác giữa số lượng và đơn vị** ("1' thùng Chain Lube Offroad" — dấu nháy dính khi copy
     tin nhắn điện thoại, bug 22/9/2026: dòng bị nuốt vào ghi chú, mất khỏi đơn): `stripQtyJunk()`
     trong `parser.js` gỡ họ dấu nháy/quote (`' ' ´ \` " “ ”`) đứng giữa số và đơn vị ngay sau
     `normalizeVietnameseQty`, trước mọi pattern qty — dùng chung cả `extraction-repair.js`
     (`isQtyLine`/`parseLineQty`/`qtyLinesOf`/`splitQtySegments`) lẫn `countQtyLines` của
     `ai-service.js`. KHÔNG đụng dấu thập phân ("1.5 thùng", "1,5 lít"). Lưới an toàn cuối
     `parseOrderText`: dòng vẫn còn cụm số + từ đơn vị sau khi mọi pattern gãy → UNMATCHED (vàng),
     cấm nuốt lặng lẽ vào ghi chú. Test: `test/parser.test.js` (describe "ký tự rác…").
   - **Dòng mốc giá đứng riêng** ("Giá 2 thùng", "giá thùng", "áp giá 3 thùng" — mốc áp TOÀN ĐƠN):
     `parseOrderText` trả type `tier-override` (helper `isStandaloneTierLine`/`standaloneTierQty`),
     KHÔNG tạo item (trước đây "Giá" bị match nhầm thành "Poster Pricelist" 0đ); `buildOrderFromText`
     áp mốc cho mọi item không có giá tường minh/mốc riêng và không phải quà. **Đường AI cũng được
     bảo đảm bằng CODE** (`parse-pipeline.js`): tự quét dòng mốc trong text thô → áp `orderTierQty`
     cho item thiếu mốc/giá, và BỎ item ma "Giá" do model nhặt — luật prompt + ORDER_SEMANTICS
     (AI tự đặt `priceTierQty=N`) chỉ là lớp phụ trợ, model lơ rule vẫn đúng giá;
     `extraction-repair` loại dòng mốc khỏi danh sách dòng SP thiếu.
     Test: `test/order-tier-override.test.mjs` (offline builder + runParsePipeline AI mode).
   - **Alias phân biệt biến thể**: khi 1 dòng SP có bản "gần trùng tên" (chain lube/max/transparent/off road),
     phải có alias exact cho TỪNG biến thể — alias word-boundary (95đ) của tên ngắn ("chain lube") sẽ nuốt
     input dài hơn ("chain lube max") nếu thiếu alias exact (100đ). Sửa prompt AI kèm theo ở `_buildSystemPrompt`
     (rule mốc giá/phụ từ tên/payment/hóa đơn) + `ORDER_SEMANTICS` (order-schema.mjs) — sửa 1 trong 2 nhớ đồng bộ cả 2.
   - **Qualifier "off road" là thuộc tính phân biệt (bug 24/9/2026)**: 3 dạng tin ghi rõ "off road" vẫn bị
     đẩy sang bản Chain Lube trắng — thứ tự đảo ("off road chain lube"), dính dấu phẩy ("chain lube, loại
     off road"), và xuống dòng offline ("2 thùng chain lube" / "off road zentor"): alias match so chuỗi
     LIÊN TỤC theo thứ tự từ nên cụm đảo/dính phẩy không khớp alias "chain lube off road" nhưng vẫn match
     trọn alias trần "chain lube" (95–100đ) của bản trắng. Sửa trong `parser.js`:
     (1) `hasAttributeConflict` thêm hard filter qualifier `OFF_ROAD_RE` — input có "off road"/"offroad"
     mà SP không có → score 0 (chiều ngược KHÔNG cấm: "chain lube" thuần vẫn ra bản trắng); `buildShortlist`
     (nguồn alias + brand family) cũng guard để bản trắng không lọt vào ứng viên AI-FINAL.
     (2) `parseOrderText` merge dòng continuation: dòng không có qty ngay sau dòng SP mà MỌI từ có nghĩa
     (≥3 ký tự) đều nằm trong tên SP mà merged text match được → gộp vào tên SP; ghi chú thật
     ("Ghi chú thêm gì đó") không có từ nào thuộc tên SP → giữ nguyên ignored/notes. Test:
     `test/offroad-qualifier.test.mjs` (12 assertions).
   - **Tương thích nhiều model**: cấu trúc JSON được ÉP theo khả năng từng provider (registry `structuredOutput`
     trong `ai-providers.mjs`): Gemini = responseSchema native, openai/groq = json_schema strict, openrouter/deepseek/
     qwen/mistral = json_object, anthropic = prefill `{`; lmstudio/ollama/custom = thử json_schema strict, server
     trả 400/422 thì tự bỏ ép gửi lại. Đổi model/key không đổi hành vi pipeline; failover đa profile tự chuyển key
     khi lỗi/quota. Chất lượng ngữ nghĩa (giữ nguyên văn tên, mốc giá, tên khách) do prompt + sanitizer bảo đảm —
     thêm rule mới nhớ sửa CẢ prompt lẫn `ORDER_SEMANTICS`.
3. Pipeline đầy đủ cho agent ngoài: `mcp-server.js` → `src/api/headless.js` (36 MCP tools: đọc/ghi sản phẩm, campaign, alias, kv-map, memory, sellers, export Excel headless — tool list trong `docs/MCP.md`). Sửa xong renderer nhớ `npm run build:renderer` + restart app (mục 7.1).

### 7.4. Tự động hóa KIOTVIET
1. Browser agent (MCP + LM Studio): `browser-agent.js`, `browser-agent-ipc.js`, `mcp-client.js`, `script-registry.js`.
   - **KHÔNG cần cài Node.js trên máy người dùng**: `@playwright/mcp` được vendor vào app
     (dependency pin chính xác trong `package.json`); MCP server chạy bằng chính runtime Node của
     Electron — `browser-agent-ipc.js` spawn `process.execPath` (electron.exe) với env
     `ELECTRON_RUN_AS_NODE=1`, trỏ vào `cli.js` trong `app.asar.unpacked/node_modules/`
     (asarUnpack cấu hình trong `electron-builder.yml`). Không qua `npx` → không cần mạng lần đầu.
   - **Fallback trình duyệt** (`pickBrowserLaunchArgs`): Chrome → Edge (`--browser msedge`) →
     Brave (`--executable-path`). Windows 10/11 luôn có Edge nên máy mới không cần cài browser;
     không có browser nào → connect trả lỗi tiếng Việt hướng dẫn cài.
   - Login KV lưu bền trong profile riêng `~/.kv-browser-profile` — đăng nhập 1 lần.
   - **2 chế độ lên đơn** (checkbox "🔁 Bổ sung giỏ đang mở" trong modal KV):
     - *Giỏ mới (mặc định, TẮT)*: pre-flight probe trang (`productSearchInput`) — POS chưa mở mới navigate (poll chờ ~8s);
       giỏ active có hàng → tự bấm nút **"+"** mở giỏ MỚI của KV (giỏ cũ giữ nguyên) rồi điền.
     - *Bổ sung (BẬT)*: tái dùng đúng tab/giỏ user đã chọn (KHÔNG reload), quét từng dòng giỏ
       (`note-cartitem-N` — text dòng chứa tên + mã KV): đủ SL → bỏ qua · lệch SL → sửa đúng dòng · thiếu → thêm mới.
   - **VERIFY DOM** sau khi điền: đọc lại giỏ đối chiếu mã + SL + giá → báo lệch trong log (thay AI verify, 0 AI call). **Gate auto-submit** (`BrowserAgent.fillVerifyBlocked`): có SP thất bại, đọc lại giỏ lệch, hoặc không đọc được JSON kết quả fill → **KHÔNG tự bấm Đặt hàng** (log ⛔ + toast lỗi, kiểm tra giỏ rồi bấm thủ công); summary/event mang cờ `verifyBlocked`. AI Verify (checkbox `kvAiVerify`, mặc định tắt) chỉ là lớp phụ trợ — tắt vẫn còn nguyên lớp an toàn DOM.
   - **Bắt mã đơn**: sau Đặt hàng tự động, rút `DHxxxxxx` từ trang → toast/log trong app.
   - Overlay hướng dẫn intro.js tự gỡ trước khi thao tác (nó chặn click). Failed kèm mã lỗi
     (SEARCH_NOT_FOUND / CLICK_NO_CART / QTY_SET_FAILED).
   - Test hành vi: `test/browser-agent.test.js` + mock `test/fixtures/kv-pos-mock.html` (multi-cart, nút "+",
     popover giá, overlay intro) chạy trong Electron qua `test/kv-fill-harness.js` — không cần KV thật.
   - Test kết nối zero-install: `test/browser-agent-ipc.test.js` — mock `Module._load` (electron/fs/child_process)
     + fake MCP server trả lời JSON-RPC qua stdio; có 2 test handshake thật qua binary Electron/packaged
     (skip khi thiếu binary). Sửa spawn/fallback/connect thì chạy file này.
2. Userscript (Tampermonkey, có WebSocket API): `kiotviet-auto-order.user.js`.
3. Phía renderer: `src/kiotviet/automation.js`.
4. Trigger từ agent ngoài: tool `run_kiotviet_order` (MCP, cần token; truyền `options.mode = 'new'|'supplement'`).

### 7.5. Sửa UI

**Kiểm tra UX 18/9/2026 — phạm vi đã chốt (chưa phát hành):**
- Signature đơn chờ duyệt canonicalize toàn bộ `order + form`, nên mọi state được persist — kể cả FOC/Extra, customPromos, rowOrder, gift overrides/qty và ô tin nhắn — đều tạo bản ghi cập nhật; regression trong `test/pending-orders.test.mjs`.
- Payload KiotViet bỏ dòng SL 0 (cả số `0` và chuỗi `"0"`), giữ hàng quà giá 0đ có SL dương; test `test/kv-zero-qty.test.mjs`. Không đổi auto-submit hoặc nghiệp vụ Khuyến Mãi Ngoài.
- Đóng modal chi tiết SP bằng Esc commit ô giá đang gõ trước khi gỡ DOM; Esc ở ô thuộc EditTracker vẫn hoàn tác ô và giữ modal mở. Test jsdom `test/product-modal-close.test.mjs`.
- Audit toàn app chưa đồng nghĩa toàn bộ kế hoạch đã triển khai. Lệch override sau xóa dòng đã tái hiện, còn là TODO trong `test/order-action-ux.test.mjs` (chạy riêng, chưa đưa vào suite chính). Các mục Undo, lưu đầy đủ quà/KM/thứ tự, trạng thái xuất và polish còn lại chưa làm.
- Xác minh bằng test logic/jsdom và build renderer; chưa nghiệm thu GUI trực quan hay xuất Excel/KV thật. Không cập nhật Setup/source zip ở đợt này.
- **25/09/2026 — ô thêm sản phẩm trong đơn:** khối “Thêm Sản Phẩm Vào Đơn Hàng” hiện luôn, không còn bấm mũi tên để mở; chỉ giữ tìm kiếm trong danh mục để chọn sản phẩm thêm vào đơn hiện tại. Bỏ form “Nhập sản phẩm tự do (kiểm tra hàng)” và handler tạo dòng `isCustom`; dữ liệu dòng tự nhập cũ vẫn được renderer/rescan đọc để không làm hỏng đơn đã lưu. Test DOM hồi quy trong `test/campaign-editor.test.mjs`.

1. `index.html` (cấu trúc tab/modal) + `style.css` (design tokens).
2. Rendering: `ui-renderer.js` + module tương ứng trong `src/` (`order/actions.js`, `settings/ui.js`, `catalog/delegation.js`...).
3. Event binding tập trung ở `src/main.js` — thêm module mới phải import/init tại đây.
4. Sửa giá chai/thùng trên bảng đơn là luồng 2 pha — KHÔNG gộp lại thành một: đang gõ (`input`) →
   `updateDualPriceLive` bản light trong `src/order/actions.js` (chỉ targeted update + `refreshOrderSummary`,
   cấm gọi `snapshotGiftStructure`/`setState` từng phím — mỗi lượt là trọn pipeline `getOrderTableRows`);
   commit giá (`change` khi blur/Enter) → `commitDualPrice` (setState đúng 1 lần → một full rebuild để quà
   MKT + badge FOC/EXTRA của hàng giá 0 chốt lại). Lịch sử: fix delay sửa giá về 0, 04/9/2026.

### 7.6. Thêm IPC CHANNEL mới (renderer ↔ main)
1. Handler: `main.js` (`ipcMain.handle`).
2. Whitelist: `preload.js`.
3. Gọi trong renderer qua `window.electronAPI.<tên>`.

### 7.7. BUILD / ĐÓNG GÓI
1. `npm run build` (= Vite build renderer → `validate-build.js pre` → electron-builder → `validate-build.js post`) hoặc `Build EXE.bat`.
2. Cấu hình đóng gói: `electron-builder.yml`; icon: `resources/icon.ico`.
3. Ghi chú tối ưu build: bản `.trae/documents/` đã dọn — quy trình build hiện tại là mục này + `validate-build.js` (pre/post check tự chạy trong `npm run build`).
4. **Checklist phát hành bản mới:**
   - **(trong v1.0.8 — 06/09/2026)**: Cập nhật bảng giá Torvex 01/09/2026 + cơ chế **priceVersion/seed giá**:
     8 giá dầu xe tải FURVEX/Hydraulic theo bảng đại lý (xô/phuy cho 15W40 CI-4, CK-4, 20W50 CI-4/CF-4 và Hydraulic HLP AW68 — giá chi tiết nằm trong catalog nội bộ; bảng đội xe không áp). Sửa chính sách khuyến mãi MXO 9/2026: gỡ quà
     "1 chai tặng DD súc rửa Veltron/XVIL" khỏi Furox 10W30/10W40 (bảng 9/2026 chỉ áp cho 10W50);
     hoàn thiện rule quà cleaner của Furox 10W50 + Furox Racing (thêm `buy_unit: "chai"` — quà scale
     theo số chai, và link 2 quà chọn 1: Veltron Engine Cleaner shot hoặc XVIL XTORQ Chain Road 100ml —
     trước đây rule không có id nên migration vá buy_unit không nhận diện được). Cơ chế mới: `DEFAULT_DB.priceVersion`
     — máy có db cũ trong IndexedDB khi boot thấy version khác bản seed sẽ tự nhận giá/khuyến mãi mới qua
     `_applyPriceSeedMigration()` (không đụng kvCode/alias/SP tự thêm); từ giờ cập nhật bảng giá chỉ cần
     sửa db.js + bump priceVersion + build. Test mới `test/price-seed-migration.test.mjs` (326/326 pass).
   - Sửa `version` trong `package.json` (ví dụ `1.0.2` → `1.0.3`). Nếu đổi danh mục/bảng giá → chạy `npm run sync:default-db` trước khi build.
   - `npm run build` → file cài nằm ở `Ứng dụng Lên Đơn Hàng\Lên đơn hàng Setup <version>.exe`.
    - Ghi lại "bản này sửa gì" vào ghi chú changelog (README hoặc file riêng) để sau tra cứu:
      - **v1.5.4 (27/09/2026)**: **Gộp bản parse headless + sửa 3 bug đường lên đơn MCP**:
        (a) `headlessAiParse` (`src/api/headless.js`) là bản chép tay của `runParsePipeline` và đã LỆCH 7 chặng
        (dòng tier-line đứng riêng, mốc giá N thùng toàn đơn, pattern giá `tr`, brand-context 2-pass, AI-FINAL
        shortlist, price-guard, học alias) → cùng một tin nhắn, bấm "Phân tích" trên GUI và gọi qua MCP/HTTP
        cho KHÁC giá, khác SP, không có cờ mơ hồ; bản chép còn vứt mất `repair.missing`. Xoá hẳn bản chép
        (~191 dòng), `parseWithAI` giờ gọi `runParsePipeline(text, {db, aiService}, {learnAliases:false})` —
        headless là API điều kiện, không được ghi vào registry alias chung.
        (b) `auto_run_order action:"both"` xuất Excel **GẤP ĐÔI mọi dòng quà**: `parseOrderToRunFormat` đã bung
        FOC + quà MKT, còn `exportOrderToExcel` lại bung lần nữa từ `calc.foc`. Thêm cờ `giftsExpanded` ngay tại
        seam (chỉ gắn trên kết quả trả về, KHÔNG đưa vào store — snapshot đơn chờ duyệt không mang cờ này nên
        đường xuất thường vẫn tự sinh quà).
        (c) Đường MCP mất hẳn **"Người nhận đặt"**: `parseOrderToRunFormat` không sinh `receiver` trong khi
        `normalizeOrderData` (`mcp-server.js`) vẫn đọc nó → field luôn rỗng, khác hẳn đường GUI. Tách
        `resolveSellerReceiver()` vào `src/seller/manager.js`; `KiotVietAutomation.buildOrderData` (trước đây
        tự resolve inline 20 dòng) và headless cùng gọi một nơi; tool `auto_run_order` thêm param `seller`
        (tuỳ chọn) để agent ngoài truyền được tên người nhận.
        (d) `AGENTS.md` §2 — mục "file root là legacy" **SAI**: `parser.js` (15 nơi import), `ui-renderer.js`
        (module lớn nhất repo), `ai-service.js`, `store.js`, `db-store.js`, `db.js` đều LIVE — `src/main.js:6-10`
        import trực tiếp, `electron-builder.yml:24-49` đóng gói, `validate-build.js:6-30` hard-fail nếu thiếu;
        `app.js` không còn tồn tại (đã dời thành `test/fixtures/app-legacy.js`). Viết lại theo bằng chứng.
        Test: suite 512 tests / 511 pass / 1 skip / 0 fail.
      - **v1.5.1 (22/09/2026)**: **Parse SONG SONG nhiều đơn bằng AI** — bấm "Phân tích" (hoặc Ctrl+Enter)
        giờ XẾP HÀNG task parse nền thay vì chờ tại chỗ: dán liên tiếp nhiều đơn, N đơn (mặc định 2, chỉnh
        1–5 trong Cài đặt → AI, localStorage `parse_queue_concurrency`) được AI phân tích CÙNG LÚC qua
        round-robin profiles. Kiến trúc: tách toàn bộ pipeline parse thuần từ `actions.js` sang
        `src/order/parse-pipeline.js` (inject `{db, aiService}`, không UI — parse thường & song song chung
        1 code path, chất lượng đồng nhất 100%: sanitize, extraction-repair, brand-context 2-pass,
        AI-FINAL, price-guard, học alias); `src/order/parse-queue.js` điều phối pool + AbortSignal từng task
        + chặn trùng text đang chạy; `src/order/parse-apply.js` áp kết quả lên màn hình. Đơn xong: hiện trên
        màn hình nếu user vẫn chờ đúng đơn đó (ô tin nhắn còn nguyên text, không có task mới hơn, bản ghi
        đang mở không phải nháp của chính đơn đó), và được **lưu vào Đơn chờ duyệt NGAY sau khi hoàn tất**
        (`autoSaveNow` flush — không phụ thuộc debounce 2s), ngược lại đổ thẳng vào Đơn chờ duyệt qua
        `pending.createPendingFromOrder()` (dedup rawChatText — nạp đè bản nháp 📝 đã auto-save; KHÔNG đụng
        `_pendingId` của store). UI: dải trạng thái `#parseQueueStrip` dưới hàng nút Phân tích (task đang
        chạy/chờ/lỗi/✅-tự-ẩn-sau-6s, Hủy tất cả, Thử lại), mục "Đang phân tích" trên đầu danh sách Chờ duyệt;
        bấm Phân tích có toast xác nhận đã xếp hàng (X đang chạy · Y chờ); nút Phân tích không còn tự hủy đơn
        đang parse (hủy qua dải trạng thái). Lỗi AI/network → task ❌ giữ text gốc + Thử lại, không tạo bản
        ghi rác. Quá hạn mức song song → task đứng chờ trong hàng đợi, tự chạy tiếp khi có slot (đặt 1 =
        tuần tự hoàn toàn, không mất đơn). Offline fallback khi không có profile AI hoạt động như cũ.
        Test mới `test/parse-queue.test.mjs` (10 case, có case mô phỏng đúng chuỗi app thật: paste → nháp
        auto-save gắn `_pendingId` → parse xong hiện màn hình + nạp đè đúng nháp); suite 438 tests / 438 pass / 1 skip.
      - **v1.5.1 (22/09/2026) — bổ sung**: **Bộ đếm số PO chỉ tăng khi Xuất Excel thành công** — trước đây
        `generateOrderTitle()` vừa sinh tiêu đề vừa tăng bộ đếm `orderSeq_*` NGAY LÚC GỌI: xuất bị lỗi
        (thiếu file template, Excel đang mở...) đã đốt số → xuất lại nhảy số, phát sinh khoảng trống STT;
        `export_excel` headless với `dryRun:true` cũng làm tăng bộ đếm dù không ghi file. Tách làm 3 hàm ở
        `src/seller/manager.js`: `peekOrderSequence()` (xem số kế tiếp, không ghi), `generateOrderTitle()`
        (hàm thuần, nhận seq), `commitOrderSequence()` (ghi bộ đếm, guard không lùi). GUI (`export.js`) và
        headless (`headless.js`) chỉ commit sau khi IPC `exportOrder` thành công từng brand; dryRun không
        commit. Test mới `test/order-title-sequence.test.mjs` (4 case).
      - **v1.5.2 (22/09/2026)**: **Mở lại đơn trong lịch sử "Đã xử lý"** — trước đây tab Đã xử lý chỉ đọc
        (chỉ Xóa được); giờ mỗi bản ghi có nút **"Mở lại"**: đơn quay về danh sách Chờ duyệt (reset
        excelDone/kvDone, giữ nguyên id nên hoàn tất lại không nhân bản) và được nạp lên màn hình để sửa
        rồi Xuất Excel / Lên đơn KiotViet lại. `moveToProcessed()` giờ giữ nguyên `order` + `_sig` trong
        bản ghi lịch sử (vẫn giữ 3 ngày / 30 bản — chi phí lưu không đáng kể); bản ghi cũ tạo trước bản
        này không có `order` → không hiện nút Mở lại (chỉ còn Xóa). Có đơn đang soạn khác trên màn hình
        → confirm thay thế + flush `autoSaveNow` như "Mở để sửa"; bản ghi được trả về chờ duyệt TRƯỚC khi
        flush để auto-save của đơn trùng rawChatText dedup vào đúng bản ghi đó (không nhân bản).
        Refactor: `loadPending` tách dùng chung `guardReplaceScreen()` + `restoreRecordOnScreen()` với
        `reopenProcessed()`. Test mới 3 case trong `test/pending-orders.test.mjs` (16/16 pass).
      - **v1.5.2 (22/09/2026) — bổ sung**: **Sửa lớp lỗi "phân tích xong mà không ra kết quả" + đơn lẻ tự hiện
        màn hình**. Diagnostic (chạy pipeline + hàng đợi + ui-renderer THẬT với AI giả trong Node) bắt được:
        `ui-renderer.js` (file legacy) dùng ẩn ~20 chỗ global `window.db` — mọi render ở ngữ cảnh thiếu global
        này văng "db is not defined"; vì render nằm trong đường hoàn tất của task nên PARSE THÀNH CÔNG vẫn bị
        coi là ❌ và KẾT QUẢ BỊ VỨT (suite cũ không phát hiện vì đã monkey-patch renderAIDetection). Sửa 2 lớp:
        (a) `ui-renderer.js` import `{ db }` tường minh từ `db.js` — bỏ phụ thuộc global ẩn; (b) `_run` trong
        `parse-queue.js` bọc đường "hiện lên màn hình" — render nổ thì TỰ ĐỔ VỀ CHỜ DUYỆT + toast cảnh báo,
        tuyệt đối không mất đơn đã parse thành công. UX: đơn DUY NHẤT trong hàng đợi giờ LUÔN tự hiện lên màn
        hình khi xong (kể cả ô tin nhắn đã bị xóa/sửa trong lúc chờ — trước đây chỉ hiện khi ô còn nguyên text);
        có đơn khác chờ/chạy → giữ nguyên tắc (ô tin nhắn còn nguyên text + không có task mới hơn); đang MỞ bản
        ghi chờ duyệt khác → vẫn rót vào danh sách, không giật màn hình. Test: `test/parse-queue.test.mjs`
        12 case (thêm case đơn-lẻ-tự-hiện + render-nổ-không-mất-đơn); suite 466 tests / 465 pass / 1 skip.
      - **v1.5.0 (18/09/2026)**: **Danh Mục phẳng xuyên thương hiệu** — tab Danh Mục bỏ dropdown
        thương hiệu, thay bằng thanh chip (Tất cả + 1 chip/thương hiệu: dot màu, số SP, số ⚠ cần hoàn
        thiện); mặc định một danh sách liền mạch mọi thương hiệu, mỗi hàng có chip brand; toggle
        Danh sách / Theo thương hiệu (lưu `localStorage`); nút Thêm sản phẩm toàn cục (pre-select
        thương hiệu đang lọc). Sub-tab Sản Phẩm trong Cài Đặt đã xóa hẳn (18/9 dọn nốt màn dẫn
        + wiring form cũ chết; chỉnh SP qua nút ⚙️ từng hàng Danh Mục; nút Đóng form tạo thương hiệu
        ẩn form, nút Thêm hiện lại). Thêm cảnh báo trùng tên xuyên thương
        hiệu khi tạo SP (`DUPLICATE_NAME_CROSS_CAMPAIGN`). Test mới 2 case (`test/product-create.test.mjs`).
        **Sửa hồi quy editor thương hiệu**: sub-tab Thương Hiệu giữ danh sách chọn/xóa thương hiệu,
        cấu hình chung + MKT theo tổng đơn + KM dạng text; chỉ bỏ danh sách sản phẩm trùng.
        Nút «Quản lý thương hiệu» trong Danh Mục mở đúng sub-tab và thương hiệu đang lọc.
        Test Node `test/campaign-editor.test.mjs` nạp `index.html` bằng jsdom, bấm chuyển thương hiệu,
        kiểm tra editor MKT/text không trùng danh sách SP, và nhảy quy cách qua bộ lọc.
        Khi quy cách đích bị ẩn, liên kết xóa bộ lọc tìm kiếm/nhóm và mở đúng thương hiệu + chi tiết SP.
        ĐÃ build Setup: `Lên đơn hàng Setup 1.5.0.exe` + source zip `Order-Automation_Ma-nguon_v1.5.0_2026-09-18_1c3c73b.zip` (18/09/2026, commit 1c3c73b).
        **UX Thương hiệu cải thiện**: copy màn trống đúng (quản lý cấu hình/MKT/KM, SP ở Danh Mục);
        sidebar hiển thị đếm MKT/KM text + ⚠ SP cần hoàn thiện; card MKT/KM text collapse mặc định
        có badge đếm rule; bỏ emoji khỏi card-title + icon input; Brand Key ghi rõ "không đổi được";
        thêm link "Xem SP trong Danh Mục →" ngược từ editor; confirm xóa brand hiển thị tên + số SP;
        xóa dead code `toggleAddCampaignForm`.
        **UX Danh Mục — quà MKT gọn**: khối quà MKT thương hiệu trong cả chế độ phẳng/gom mặc định gập,
        chỉ hiện tóm tắt số mốc; bấm tiêu đề mới mở danh sách quà chi tiết. Các chip quà, mã KV và thao tác
        chỉnh sửa bên trong giữ nguyên.
        **Modal thêm sản phẩm — form gọn**: bỏ tùy chọn “hàng quà/tặng” vì giá 0đ là trạng thái bình
        thường; nhãn mô tả đóng gói rút gọn, phần giải thích chuyển xuống dưới ô nhập để các trường
        không lệch nhau. Danh Mục không còn ping cảnh báo “Giá 0đ”; vẫn cảnh báo thiếu mã KV/chưa có
        mốc giá.
      - **v1.4.3 (16/09/2026)**: **Fix chọn FOC ↔ Extra khả dụng với mọi loại hàng khi giá 0đ** —
       sửa lỗi cache render trong `orderTableSignature` (`ui-renderer.js` từng bỏ quên `giftKindOverrides`
       khiến bấm nút đổi FOC/Extra bị dính cache HTML cũ, giao diện không đổi); đồng bộ điều kiện dòng free
       (`subtotal === 0 || bottlePrice === 0`) trên toàn bộ luồng UI, KiotViet preview và xuất Excel
       (`src/order/export.js` truyền đúng `isGift: true` và `giftKind` cho hàng giá 0đ thay vì chỉ dòng `type === 'gift'`).
       Kèm tinh chỉnh UI/UX: dropdown nhóm hàng Danh mục hiển thị số lượng SP `⚠ Cần hoàn thiện (N)` theo thương hiệu;
       dọn CSS `grid-template-*` thừa trên layout `.order-split` trong các media query (`style.css`).
       Test mới `test/foc-extra-toggle.test.mjs` (4 case).
     - **v1.4.2 (16/09/2026)**: **Ép lại box_size theo text packaging ĐÚNG 1 LẦN (pass V2, cờ `_packingFixedV2`)** —
       các SP thêm mới/sửa chuỗi đóng gói sau khi pass v1.3.4 (`_packingFixedV1`) chạy thì chưa bao giờ được
       đồng bộ. Boot đầu tiên trên bản này: mọi SP có số trong chuỗi packaging được ép `box_size` theo số đó
       (dùng `parsePackagingQty`), sau đó box_size hoàn toàn do user quyết định — KHÔNG tự ép nữa (muốn ép
       lần nữa → thêm cờ V3). Fix kèm parser: số thập phân trong text KHÔNG còn bị đọc là số lượng —
       "10 bình x 1,5 lít" giờ parse ra 10 (trước đây "x 1" trong "1,5" bị bắt → ép 10 → 1, sai nghịch 10 lần;
       ảnh hưởng TTC Coolant Premix 1,5L). 2 SP seed lệch text được V2 sửa đúng theo text lúc boot:
       Professional Engine Cleaner 0,3L + Leather Cleaner 0,5L (text "12 bình/..." nhưng box_size 1 → 12).
       Test +4 case (`test/promo-migration-fix.test.mjs`). 404 tests / 403 pass.
     - **v1.4.1 (16/09/2026)**: UX xem Danh Mục — bấm tên SP mở chi tiết (không chỉ nút ▸ nhỏ), header
       thương hiệu hiện "X/Y khớp" khi lọc, ẩn section 0 kết quả (đúng cả filter nhóm/cần hoàn thiện),
       nới vùng bấm nút ▸, badge tự wrap ở màn hình ≤1100px.
     - **v1.4.0 (16/09/2026)**: Form thêm hàng 1 lần đủ — giá nhiều mốc lúc tạo, ô mã KV thùng riêng,
       checkbox hàng quà/tặng, preview "12 chai/thùng" live, KM nhanh "Mua X tặng Y cùng loại", lỗi đỏ
       inline (box_size rác không tự ép 12; chặn mã KV trùng + alias cướp) qua `validateNewProduct()` +
       `createProductFull()` (`src/product-edit.js`). Danh mục: badge sức khỏe (thiếu mã KV/chưa có mốc
       giá/giá 0đ) + filter "Cần hoàn thiện". Bảng đơn: nút "Lưu thành SP" trên dòng tự nhập
       (`saveCustomAsProduct` — mở form điền sẵn, học alias). Test mới `test/product-create.test.mjs`.
     - **v1.3.6 (16/09/2026)**: **Chữ quy cách/đóng gói hiển thị TỰ SINH theo box_size** —
       trước đây chỗ hiển thị "tham khảo" (badge 📦 danh mục, dòng quy cách trên đơn,
       combobox sản phẩm, chip package) lấy chuỗi `packaging` tự nhập → dễ lệch số với
       phép nhân thùng (vd packaging "4 Kit/Thùng" cạnh badge ×12). Thêm
       `packagingAutoText()` (ui-renderer.js): hiển thị = `box_size` + unit (vd
       "12 chai/thùng"); SP bán đơn chiếc (box_size=1) chỉ hiện unit. Chuỗi packaging
       gốc vẫn giữ trong DB + ô input, chỉ không dùng để hiển thị số quy cách nữa
       (còn thấy trong tooltip).
     - **v1.3.5 (16/09/2026)**: **AI parse không còn mất dòng khi sales gõ sai chính tả phụ từ** — đơn thật
       "Bảo Long Detailing": "6 chai moto SR scooer 10w40" (typo scooter) + "6 chai moto SR 10w40" là 2 sản phẩm
       KHÁC NHAU (Moto XP 10W40 **Scooter** 8230014 vs Moto XP 4T 10W40 8230015) nhưng AI-FINAL (quy tắc
       "phụ từ sales ghi phải có mặt trong tên SP", `ai-service.js`) không tìm thấy "scooer" trong tên nào →
       tự chọn bản 4T gần nhất → 2 dòng cùng map 1 productId → `mergeDuplicateItems` gộp 6+6=12, đơn 4 dòng
       hoá 3 (giỏ KV vẫn quét đủ 4 SP vì đọc thẳng DOM POS — 2 nguồn khác nhau). Sửa 3 chỗ, không phình prompt:
       (1) synonym `'scooer' → 'scooter'` trong `DOMAIN_SYNONYMS` (`parser.js`) — bước khớp variant về code,
       không phụ thuộc óc model yếu (2.5 Flash); (2) AI-FINAL giờ nhìn `rawProduct` đã chuẩn hóa synonym
       (`disambiguateItems` dùng `normalizeFull`) — nhất quán với matching local; (3) thêm 2 ví dụ few-shot
       ngắn vào prompt (2 dòng cùng brand+grade khác phụ từ = 2 SP riêng; dòng mở đầu "TT" có số lượng + tên
       SP = dòng sản phẩm, không phải dòng payment) — với model yếu, ví dụ in/out hiệu quả hơn câu khẩu lệnh.
       Test 5 case mới trong `test/matching-golden.test.mjs` (typo → bản Scooter; "moto xp 10w40" → bản 4T;
       2 variant 10W40 không merge; cùng productId viết 2 kiểu VẪN merge 6+6=12 — chốt hành vi hợp lệ).
     - **v1.3.4 (16/09/2026)**: **box_size không còn bị ép lại mỗi lần mở app** —
       `ensurePackingConsistency()` (db.js) docstring từng hứa "chạy 1 lần (cờ
       `_packingFixedV1`)" nhưng loop chung (mọi campaign) vẫn chạy MỖI boot không cờ,
       ép `box_size` theo số trong chuỗi packaging → user sửa tay box_size (đóng gói
       thực tế lệch chuỗi text) bị đè lại ở lần mở kế. Giờ gate đúng 1 lần bằng cờ
       `_packingFixedV1` (pattern zentor v1.3.3): lần đầu ép hết lệch lịch sử
       (bug Chain Care Kit cũ), sau đó box_size do user/seed quyết định, không tự ép.
       Muốn ép lại đồng loạt → xoá cờ trong data. Test thêm 2 case
       (`test/promo-migration-fix.test.mjs`).
     - **v1.3.3 (16/09/2026)**: **Không còn tự reset khuyến mãi về mặc định mỗi lần mở app** — bug:
       `_ensureZentorMktRulesSynced()` chạy MỖI boot không gated, user thêm/bớt sản phẩm-quà trong
       CTKM Zentor là boot sau bị thay nguyên bộ mốc quà (`type:'total'`) bằng seed DEFAULT_DB →
       tưởng "bộ cài làm mất dữ liệu" nhưng chính app tự ghi đè lúc khởi động. Đã chuyển thành migration
       `_applyZentorMktFix()` gated 1 lần (`zntMktFixedVersion`), boot sau chỉnh sửa user được GIỮ;
       bộ lọc FOC sai của 2 SP znt_mxo cũng gated luôn. Kèm sửa lớp seed giá: `_applyPromoMigration`
       chạy TRƯỚC `_applyPriceSeedMigration` (hết trùng rule khi máy nâng từ ≤1.2.x) và price-seed chỉ
       thay rule qty theo SP catalog (giữ rule `total` campaign + rule `text` user đăng ký). Thêm
       snapshot DB nguyên trạng trước mọi migration mỗi boot (rolling 3 bản, key `oa_db_preboot_backups`,
       không có UI — dùng khôi phục khẩn cấp). Kéo thả sắp xếp rule KM trong Settings editor (4 danh
       sách) + fix kéo thả bảng đơn không render lại sau gate-render v1.3.1 (thêm `rowOrder` vào
       `orderTableSignature`). Test mới `test/promo-migration-fix.test.mjs` (4 case).
     - **v1.3.2 (15/09/2026)**: **Xuất Excel ổn định hơn khi file đang mở sẵn** — tự lưu + đóng
       workbook đang mở trong Excel giờ **retry tới 3 lần** (trước: thử đúng 1 lần, Excel nhả file
       chậm hoặc `GetActiveObject` bắt hụt instance là trả lỗi bắt đóng tay oan) và chờ OS nhả khóa
       tối đa **10s/lần** (trước 5s — log thật cho thấy Excel có lúc cần ~27s). Kèm theo bản này:
       tối ưu hiệu năng cuộn danh sách đơn (bdecb5f) đã chốt trong Git.
     - **v1.3.1 (15/09/2026)**: **Chặn file rác vô hạn khi lên đơn KV** — log console của browser do
       Playwright MCP ghi từng rơi vào `.playwright-mcp/` ngay cwd app (mỗi phiên lên đơn sinh hàng chục file,
       không bao giờ xoá). Giờ `browser-agent-ipc.js` truyền `--output-dir` (dồn về `%TEMP%oa-kiotviet-mcp`)
       và `--output-max-size` 50MB để MCP tự evict file cũ nhất. Test `test/browser-agent-ipc.test.js` cập nhật theo.
     - **v1.3.0 (15/09/2026)**: **Thiết kế lại toàn bộ cấu hình khuyến mãi — Schema số thống nhất (`campaign.promoRules[]`)** —
       loại bỏ hoàn toàn cơ chế "ghi text" / runtime đoán quà từ câu chữ (`note`). Ba hệ thống rời rạc
       (`mkt_gift_rules`, `product.foc_rules`, `product.mkt_gift_rules`, `promoTextRules`) được hợp nhất về MỘT mảng
       `promoRules[]` trên mỗi campaign.
       (a) **Schema số chuẩn**: phân loại bằng `type: 'qty' | 'total' | 'text'`. Mốc luôn là số (`buy.qty` hoặc `threshold.min`/`threshold.max`),
       quà luôn link sản phẩm danh mục (`gifts[].productId`), label được TỰ SINH từ số (`db._buildPromoLabel()`).
       Hỗ trợ thêm mốc TIỀN/SỐ LƯỢNG theo từng dòng sản phẩm (`getProductMoneyPromoRule` — scope: 'product', type: 'total').
       (b) **Migration tự động**: `migratePromoRules(data)` nâng cấp dữ liệu người dùng cũ ngay lúc nạp (idempotent, version=3),
       giải mã triệt để 50 rule FOC cũ thiếu mã sản phẩm sang sản phẩm chuẩn một lần duy nhất lúc migrate.
       (c) **Data & UI đồng bộ**: `DEFAULT_DB` (db.js) và `default-db.json` chuyển 100% sang schema mới.
       Settings, Catalog delegation và Renderer cập nhật đọc/ghi trực tiếp vào `promoRules[]`.
       Test suite toàn diện 370 tests / 369 pass (1 skip cũ).
     - **Tối ưu hiệu năng danh sách đơn hàng (15/09/2026)**: bảng đơn sau parse cuộn mượt, hết khựng.
       (a) `src/main.js` — subscriber chỉ render lại bảng khi "hình dạng bảng" đổi (signature items + quà):
       state vô can (`isLoading`, `pendingId`, AI...) không còn kéo rebuild toàn bộ tbody (trước: MỌI
       `setState` đều build lại bảng + chạy lại pipeline quà). (b) `ui-renderer.js` — memoize HTML bảng theo
       cùng signature: render trùng hình dạng chỉ `tbody.innerHTML = cache`, bỏ chạy lại `getOrderTableRows`.
       (c) `style.css` — `scrollbar-gutter: stable` cho `.order-split` (thanh cuộn luôn chiếm chỗ → đơn ngắn
       thấy rõ là hết chỗ cuộn), `.results-scroll { flex-shrink: 0 }`. KHÔNG dùng `content-visibility` trên
       `table-row` (Chromium không hỗ trợ `contain: layout` trên `tr` → scrollHeight ước thiếu, kẹt cuối
       bảng). **Hồi quy 16/9/2026 + fix**: perf đóng gói trong v1.3.2 nhưng signature ban đầu KHÔNG gồm
       `rowOrder` (kéo thả dòng chỉ đổi `rowOrder`, items giữ nguyên) → sau drop signature không đổi →
       subscriber skip render → bảng KHÔNG cập nhật thứ tự (Excel vẫn đúng, chỉ màn hình không nhúc nhích).
       Fix (16/9/2026, chưa đóng gói): thêm `|ro:` (rowOrder) vào `orderTableSignature` để kéo thả đổi
       thứ tự bảng vẫn render lại.
     - **v1.2.0 (14/09/2026)**: **Đăng ký "chương trình KM dạng text" thành rule chuẩn** — KM
       khách nhắn dạng text ("tặng nón XVIL", "FOC: 1 bình xịt"...) từng bị fuzzy-match đoán mò hoặc
       rơi vào `__unmatched_gift__` (không có kvCode → fail khi lên KiotViet). Giờ mỗi campaign có
       registry `promoTextRules`: từ khóa nhận diện + đơn vị quà (tùy chọn) + sản phẩm quà chuẩn hóa
       (chọn từ danh mục, hiển thị mã KV) + SL mặc định + cờ "Mọi campaign" (rule global áp dụng mọi
       thương hiệu). `db.getPromoTextMatch()` (db.js) match 2 chiều sau bỏ dấu (name chứa keyword /
       keyword chứa name, keyword ≥3 ký tự), lọc `unitHint`, ưu tiên rule campaign cụ thể > global, bỏ
       rule trỏ sản phẩm đã xóa; `processExplicitGift()` (`src/order/calculator.js`) resolve qua registry
       TRƯỚC mọi heuristic/fuzzy → cả 3 đường parse (offline `builder.js`, AI `actions.js`, headless API)
       hưởng chung. Test mới `test/promo-text-rules.test.mjs` (13 case gồm cả regression rule
       không-global chỉ áp dụng trong campaign của nó) — 370 test / 369 pass, 1 skip cũ. *(UI đăng ký
       rule — nút "📝 Đăng ký KM" trên bảng đơn + card Settings — đã bỏ từ 23/9/2026; engine nhận diện
       và dữ liệu rule vẫn giữ nguyên.)*
     - **v1.1.0 (11/09/2026)**: **Fix AI nhận nhầm đơn "chain lube max giá 2
       thùng"** — đơn "ANYWHERE MAN / 2 thùng chain lube max giá 2 thùng / TT CK / HĐ" từng match nhầm
       bản Chain Lube **trắng** 154k thay vì bản **Max** 158k (thiếu 99k/2 thùng), tên khách bị sửa
       "ANYWAY MAN", mốc giá "giá 2 thùng" bị bỏ. 3 tầng fix: (a) **alias phân biệt biến thể** —
       `DEFAULT_ALIASES` thêm `chain lube max/transparent/transperant/off road/trắng/trang` (alias
       exact 100đ thắng alias word-boundary 95đ của alias học "chain lube" → bản trắng; đã push alias
       lên app đang chạy qua `POST /api/aliases` nên máy thật hết lỗi nhầm giá NGAY, không chờ bản mới);
       (b) **prompt AI** (`ai-service.js` + `ORDER_SEMANTICS`): "giá N thùng" = priceTierQty của cùng
       dòng, KHÔNG tách thành item thứ 2/KHÔNG nhân đôi qty; phụ từ trước "giá" (max, transparent...)
       là một phần tên SP; "TT CK" → payment `ck`; "HĐ"/"hóa đơn"/"VAT" → notes, không tạo item; tên
       khách copy NGUYÊN VĂN kể cả ALL-CAPS tiếng Anh; AI-FINAL thêm rule "phụ từ sales ghi phải có
       mặt trong tên SP được chọn". (c) **sanitizer** (`note-sanitizer.js`): lọc item "ma" chỉ gồm
       token meta (HĐ/TT CK/VAT), tách phần tử notes chứa "\n". (d) **Structured output cho
       provider local/custom** (`ai-service.js`): provider registry = null (lmstudio/ollama/custom)
       trước đây KHÔNG ép JSON gì cả — giờ THỬ `json_schema` strict trước, server/model không hỗ trợ
       (400/422) thì tự bỏ `response_format` gửi lại như cũ → model nhỏ local cũng không thể sai format.
       Verify live qua `/api/parse` (instance cách ly + model local thật): offline lẫn AI đều ra đúng
       Max 8230005-1 @158k, tổng 3.792.000; "chain lube" thường vẫn ra bản trắng. Test:
       parser.test.js + matching-golden.test.mjs + note-sanitizer.test.mjs — 353 pass / 1 skip.
     - **v1.0.7 (07/09/2026)**: Ô chọn "Sản phẩm tặng" (Cùng loại) trong dòng FOC của tab
       Danh Mục đổi từ dropdown thường sang **bộ chọn gõ-để-tìm** (cùng pattern Settings Editor):
       bấm vào ô là list mở ra, gõ để lọc fuzzy theo tên, click là chọn — xong. Select ẩn mang class
       `catalog-foc-input` + data-field `give_product` nên luồng lưu cũ không đổi. `buildFocGiftPickerHtml`
       /`buildGiftProductOptionsHtml` (ui-renderer.js) nhận thêm `opts` (`sameLabel`/`hiddenClass`/
       `hiddenAttrs`/`width`/`inputStyle`); wiring focusin/input/mousedown/focusout mới trong
       `src/catalog/delegation.js` (gợi ý = chính các option của select ẩn, lọc qua `fuzzySearchScore`;
       blur không chọn → hoàn tên đã chọn). Verify browser thật trên bản build: 326/326 test pass.
       Cùng dịp đó: **nút ▲/▼ đảo thứ tự dòng FOC & quà MKT** trong card Danh Mục (chỉ hiện khi có ≥2
       dòng, disable ở mép trên/dưới) — swap 2 phần tử liền kề trong `foc_rules`/`mkt_gift_rules` +
       lưu + `refreshCatalog()` giữ nguyên vị trí cuộn (`.catalog-panel-wrap`). Thứ tự dòng chỉ để dễ
       đối chiếu lúc nhập — calculator xét mốc theo điều kiện, không phụ thuộc vị trí. Helper chung
       `buildRuleMoveButtonsHtml` (ui-renderer.js) + `moveCatalogRule` (delegation.js), CSS class
       `.btn-move-catalog-foc`/`.btn-move-catalog-mkt` (style.css). Verify browser: đảo cả FOC lẫn MKT.
       Fix **thanh tổng kết mất sticky**: thủ phạm là class `is-dragging` (kéo sắp xếp dòng đơn) kẹt
       vĩnh viễn — drop re-render detach dòng nguồn nên `dragend` không bubble tới tbody, cleanup không
       chạy → `.order-results` kẹt `overflow: hidden` thành scroll container giả → `#orderSummary` +
       thead bám nhầm chỗ. Sửa 3 lớp: `clearDragState()` gọi trong cả `drop` lẫn `dragend`; tự chữa gỡ
       class ở đầu `renderOrderResults`; CSS đổi `hidden` → `clip` (clip không tạo scroll container —
       kể cả class kẹt sticky vẫn chạy). Verify browser: thanh dính đáy cả khi sạch lẫn khi ép class kẹt.
       Cùng dịp: **header modal KiotViet dính mép trên khi cuộn** (`.kv-modal-content > .card-header`
       position: sticky + nền phủ full bề ngang bằng margin âm 2 bên) — nút "✕ Đóng" luôn trong tầm tay
       khi preview/log dài; `.kv-modal-content` phải `padding-top: 0` (sticky không chạy nếu phần tử
       nằm ngoài containing block do padding-top của container). Verify browser: cuộn giữa/đáy header
       vẫn dính, nút Đóng bấm được. Fix theo dõi (11/9/2026): thead bảng preview trong modal kế thừa
       rule chung `.order-table thead th` (sticky, z-index 10) — cùng dính `top: 0` với header modal
       (sticky, z-index 5) trên cùng vùng cuộn `.modal-content`, nên cuộn xuống thead phủ lên CHE nút
       Đóng. Override `.kv-modal-content .kv-preview-table thead th { position: static; }` (specificity
       0,2,2 thắng 0,1,2) — thead chỉ cần sticky ở trang chính, không đụng rule chung/`contain: layout`.
     - **v1.1.0 (11/09/2026) — phần 2**: (a) **Nút kép trên panel "Hoạt Động AI"** — khi AI agent
       rảnh, nút "Xóa" dọn log VÀ ẨN luôn panel (hoạt động mới sau đó hiện lại panel ở dạng gập,
       badge đếm chưa đọc — tôn trọng lựa chọn ẩn của user); khi AI đang thao tác (có request ≤5s,
       hoặc poll `browserAgent.status()` mỗi 2s khi panel đang hiện — phủ cả pha chờ AI verify im
       lặng), nút tự đổi thành **"Ngắt"** (icon SVG stop đỏ theo currentColor) gọi
       `browserAgent.abort()`; bấm lần 2 hoặc 6s chưa dừng → `reset()` cưỡng bức (ngữ nghĩa 2-bước
       của nút Dừng modal KV). (`src/ui/agent-activity.js`, `index.html`, `style.css`). (b) **Abort
       giờ là NGẮT CỨNG** — `BrowserAgent.abort()` gọi thêm `McpClient.abortPending()` (hàm có sẵn
       từ trước nhưng không ai gọi — lệnh MCP đang bay từng phải chờ tới timeout 90s) và
       `_aiAbort.abort()` hủy fetch AI verify đang treo (fetch trước giờ không có signal);
       `runDirectOrder` emit `'aborted'` thay `'error'` khi do user ngắt (modal KV mở khóa bằng
       toast "Đã dừng", không báo "Lỗi" giả), 2 run kia không emit `'error'` giả trước `'aborted'`.
       Áp dụng cho mọi đường abort: nút Dừng modal KV, `POST /api/run-abort`, nút "Ngắt" trên feed.
       (c) **Lịch sử "Đã xử lý" gọn lại** — giữ 3 ngày / tối đa 30 bản ghi (trước: 30 ngày / 200),
       xóa 1 bản ghi lịch sử KHÔNG còn hỏi confirm (đơn thật nằm nguyên trong Excel/KiotViet, lịch
       sử chỉ là tóm tắt — khác với xóa đơn chờ duyệt vẫn giữ confirm).
       Test: +2 unit trong `test/browser-agent.test.js` (357 test — 356 pass, 1 skip cũ).
     - **v1.0.10 (10/09/2026)**: (a) **Đơn chờ duyệt TỰ ĐỘNG LƯU** — mọi đơn đang soạn (≥1 SP) auto-save
       vào IndexedDB theo debounce 2s (trigger: thay đổi state qua `store.subscribe` + input các ô
       form; flush ngay khi đóng app/ẩn cửa sổ qua beforeunload/pagehide/visibilitychange), KHÔNG bắt
       buộc tên khách (bản nháp hiện "(không tên)"); nút "Lưu chờ duyệt" tay vẫn giữ (lưu ngay + toast
       + verify sau ghi). (b) **Đơn chỉ rời danh sách khi CẢ Excel LẪN KiotViet đều xong** —
       `consumeById` đổi thành `markDone(id, source)`: set cờ `excelDone`/`kvDone` (chip ✓ Excel/✓
       KiotViet ngay trên từng đơn trong danh sách), đủ cả hai mới chuyển sang **tab "Đã xử lý"** trong
       cùng modal (giữ 200 đơn/30 ngày — nền móng v1.0.9 nay có UI); đơn chỉ cần 1 flow bấm "Hoàn tất"
       tay (có confirm). (c) **Fix bug mất đơn khi CHƯA xuất/KV** — parse đơn mới (offline/AI) và Xóa
       form phải reset `_pendingId: null`: merge spread của store giữ id cũ nếu key vắng → lần lưu sau
       ĐÈ MẤT bản ghi của đơn trước đó (nguyên nhân thật cảnh báo "chưa bấm xuất Excel/KV mà đơn vẫn
       mất"). (d) Chống "hồi sinh": auto-save bị chặn 15s sau khi record rời danh sách nếu nội dung
       màn hình chưa đổi; dedup re-parse cùng đơn (khớp rawChatText) không nhân bản record.
       Test mới `test/pending-orders.test.mjs` (9 case regression mất đơn) — 346 test pass / 1 skip.
     - **v1.0.9 (09/09/2026)**: (a) **Copy phiếu giao hàng theo hiện trạng bảng** — `copySummary`
       (src/order/actions.js) lấy dữ liệu từ `getOrderTableRows(currentOrder)` (cùng nguồn với bảng
       render, không rescan tin nhắn — luôn theo đơn đang chỉnh sửa); dòng hàng tặng 0đ (`isGift`
       hoặc subtotal 0, cả matched lẫn unmatched) in `🎁 TẶNG [FOC/EXTRA]` kèm "— 0 đ" thay vì in
       như hàng mua giá 0đ; nhãn FOC/EXTRA theo đúng toggle đang chọn trên bảng (`giftKind`), nguồn
       (KM FOC/KM MKT) + ghi chú rule chuyển vào phần ghi chú cuối dòng quà. (b) **Đơn chờ duyệt
       chống mất đơn** — `saveCurrentOrder` (src/order/pending.js) `await ensureLoaded()` trước khi
       ghi (bấm Lưu quá sớm sau khi mở app trước đây có thể persist trên nền mảng rỗng và ĐÈ MẤT
       các đơn đã lưu); persist lỗi thì dừng, không báo "đã lưu" sai; sau ghi đọc lại IndexedDB
       xác nhận ghi thật, không chắc chắn thì cảnh báo cho sales. Kèm nền móng lịch sử đơn đã xử
       lý (IndexedDB `order_automation_processed_orders_v1`, giữ 200 đơn/30 ngày) — chưa gắn UI.
       336 test pass / 1 skip (không fail).
     - **v1.0.8 (08/09/2026)**: (a) **AI Profiles API** — agent ngoài thao tác app như một người
       dùng, bao gồm tự cấu hình AI: `GET /api/ai/status` (trạng thái profiles/strategy, KHÔNG bao giờ
       trả API key — chỉ `hasKey`/`keyError`), `POST /api/ai/test` (test kết nối 1 hoặc tất cả profile
       đang bật), `POST /api/ai-profiles` (upsert/xóa profile + đặt strategy/activeId; apiKey bỏ
       trống = giữ key cũ, key mã hóa safeStorage/DPAPI ngay khi lưu). `POST /api/parse` nhận thêm
       `mode: ai` ép pipeline AI (lỗi AI báo rõ, hết fallback offline âm thầm) và mọi lần fallback
       đều kèm `fallbackReason` — khắc phục tình cảnh môi trường test cách ly không có AI config
       nên parse lúc nào cũng offline mà agent không cách nào biết. (b) **Browser API** — mở trình
       duyệt Chrome-KV (Playwright MCP do app kết nối) cho agent ngoài đọc/thao tác mà KHÔNG cần
       extension hay computer-use: `GET /api/browser/tools` (discovery tool), `GET /api/browser/snapshot`
       (cây accessibility kèm ref), `POST /api/browser/execute` (pass-through mọi tool `browser_*` —
       click/type/fill_form/evaluate/screenshot/tabs; trả cả ảnh base64; 409 `TASK_RUNNING` khi app
       đang tự lên đơn để không phá pipeline). (c) **AI Activity Feed** — panel "Hoạt Động AI" trên
       UI hiển thị realtime mọi request agent ngoài gửi vào API (nhãn tiếng Việt + trạng thái, tự mở,
       badge chưa đọc): intercept tại `sendJson` trong `api-server.js` → IPC `agent-activity` →
       `src/ui/agent-activity.js`. apiVersion 2.3.0. Kèm icon panel đổi từ emoji robot sang SVG
       pulse theo bộ icon stroke của app. **Ghi chú:** bản 1.0.8 còn gộp 2 đợt chưa phát hành
       dưới đây (cấu hình AI 06/09 + bảng giá Torvex/priceVersion 06/09).
     - **(trong v1.0.8 — 06/09/2026)**: Nâng cấp mục Cấu hình AI cho dễ cấu hình: form profile có datalist
       gợi ý model (registry `models` + model thật nạp từ `/v1/models` khi bấm Test Kết Nối), link "Lấy API key"
       theo provider (`keyUrl`), nút "🔌 Test tất cả"; dòng AI dưới sidebar click mở thẳng Cài đặt → AI.
       Fix dropdown "AI Provider" modal KiotViet vô tác dụng (selectedValue bị đọc nhưng không truyền vào
       runOrder → AI Verify luôn chạy LM Studio); bổ sung nhánh Anthropic Messages API cho `_callAI`
       (browser-agent); bỏ option ma "Gemini Flash (Proxy 8045)" (proxy không tồn tại). Làm mới model mặc định
       theo catalog 9/2026 (đối chiếu docs chính thức từng hãng): OpenAI `gpt-5.6-luna`, Claude `claude-sonnet-5`,
       Z.AI `glm-4.7-flash` — Gemini giữ `gemini-2.5-flash` (vẫn được Google hỗ trợ), chỉ ảnh hưởng profile mới.
       Đồng bộ `/api/status` trả `apiVersion 2.1.0` khớp `/api/agent-info`. 320/320 test pass.
     - **v1.0.5 (04/09/2026)**: Fix delay khi sửa đơn giá về 0 để hiện badge FOC/Extra: tách luồng sửa giá
       thành 2 pha — đang gõ (`input`) chỉ targeted update (không chạy pipeline quà `snapshotGiftStructure`
       2 lần/phím nữa, không re-render, không mất focus); commit giá (blur/Enter) qua `commitDualPrice` mới
       re-render đúng 1 lần để quà MKT + badge FOC/EXTRA của hàng giá 0 chốt lại ngay; focus tự khôi phục
       đúng ô sau rebuild (`scheduleTableFocusRestore`). Verify thực tế trên bản build + 312/312 test pass.
       Fix parsing đơn "Nam Thành" ("1 can Prostream 20L tặng thêm 6 chai Veltron Engine cleaner"): (a) chữ
       "thêm/kèm (theo)" chen giữa không còn làm gãy pattern quà — "tặng thêm" không dính vào SP trước,
       SP chính không bị đánh dấu `isGift`/ép giá 0 khi dòng có quà tường minh (`explicitGift`), dòng quà
       rời lẻ giữ được marker; (b) unit hint phân xử đúng SP trùng tên khác quy cách: bonus tầng hóa
       (+15 unit bán / +10 spec / +5 packaging — pack "12 chai/thùng" là tín hiệu yếu) và khi sales đích
       danh đòi đơn vị KHÁC đơn vị bán của SP alias thì fuzzy (có unit bonus) được lật nếu khớp tên ≥ điểm
       alias (alias vẫn tuyệt đối trong mọi trường hợp khác); (c) quà tường minh `processExplicitGift`
       truyền unit hint + cùng-campaign chỉ thắng khi điểm không thua match toàn cục. "6 chai Veltron
       Engine cleaner" giờ ra đúng VELTRON Professional (unit chai), không nhầm bản 0,1L/bình. 321/321 test pass.
     - **v1.0.4 (04/09/2026)**: Fix lỗi font tiếng Việt trên đường API: `readBody` gom Buffer decode UTF-8 một lần (trước đây chunk cắt giữa ký tự TV vỡ font), `mcp-client` decode trên ranh giới message, tự vá mojibake agent gửi (`repairMojibake`), escape payload script lên KV, Excel truyền tên khách/tiêu đề qua file tạm UTF-8. Fix khớp sản phẩm: unit hint không lật ngược match đủ từ khóa ("1 chai Fork 10" → Xvil Fork 10 chứ không nhảy sang Zentor), "bình" ≡ "chai"; "giá thùng" không cần số (`priceTierQty=1`); endpoint 1-click `POST /api/order/auto-run`; instance test cách ly `OA_USER_DATA`/`OA_API_PORT` (312/312 test pass).
     - **v1.0.3 (03/09/2026)**: Tối ưu cho AI agent ngoài: bổ sung machine discovery `GET /api/agent-info` (và `GET /`), đường dẫn token tuyệt đối trong 401, endpoint `GET /api/run-status` (lấy mã đơn KV `orderCode`, logs, tiến trình) và `POST /api/run-abort`, chuẩn hóa HTTP 409 khi browser chưa kết nối, guard `(app && app.isPackaged)` trong `browser-agent-ipc.js`, đồng bộ đủ 20 test suite vào `validate-build.js` (298/298 test pass).
     - **v1.0.2 (31/08/2026)**: Hiển thị số phiên bản ở sidebar; vendor `@playwright/mcp` 0.0.79 chạy zero-install qua Electron-as-Node.
5. **Cập nhật app cho máy khác** (phát hành bằng cách gửi file — không cần server):
   - Gửi file `Lên đơn hàng Setup <version>.exe` (Zalo/Gmail/USB; không cần gửi `.blockmap`).
   - Người nhận bấm đúp mở file → Next → xong: bộ cài NSIS tự nhận bản cũ đang cài, nâng cấp đè đúng chỗ cũ, **giữ nguyên toàn bộ dữ liệu** (đơn hàng IndexedDB, thư mục `I.ĐƠN HÀNG`, cấu hình AI, danh sách người nhận đặt). Không cần gỡ bản cũ, không cần cấu hình lại.
   - Người nhận kiểm tra bản mới đã lên chưa: mở app nhìn góc dưới sidebar — dòng **"Phiên bản vX.Y.Z"**.
6. Lần cài **đầu tiên** trên máy mới: Windows SmartScreen có thể cảnh báo vì app chưa ký số → bấm "More info" → "Run anyway". Các lần nâng cấp sau (cài đè) không còn cảnh báo này.

### 7.8. DEBUG / CHẨN ĐOÁN
1. `npm run doctor` (môi trường: Node, Python, pywin32, Excel).
2. Crash log: `crash.log` ở thư mục app (dev) hoặc thư mục `userData` (bản packaged).
3. Lỗi EPIPE khi chạy từ `.bat` là **vô hại** (đã có guard trong `main.js`).
4. MCP token: `userData/mcp-token.txt`; log agent: console của process Electron.
5. **Chạy instance cách ly để test** (không đụng dữ liệu/port của bản đang chạy): set `OA_USER_DATA`
   (userData riêng → IndexedDB + token riêng) và `OA_MCP_PORT` (port MCP riêng) rồi khởi động app, vd:
   `OA_USER_DATA=C:\Antigravity\.test-env\userdata OA_MCP_PORT=18048 npx electron .`
   — instance nạp catalog mặc định từ `default-db.json` (không có AI config, sẽ chạy parse offline;
   agent muốn test pipeline AI có thể tự tạo profile qua tool `manage_ai_profiles` rồi `mode:"ai"`);
   test MCP đúng hệt agent ngoài qua `http://127.0.0.1:18048/mcp` (`parse_order` không cần token).
   Stdio proxy (`mcp-stdio-proxy.js`) cũng nhận đúng 2 env này — chạy proxy với cùng bộ env là nối
   thẳng vào instance cách ly (URL + token tự resolve, khỏi cấu hình tay).

### 7.9. Tìm hiểu lịch sử / lý do có một đoạn code
1. `ORIGINAL_REQUEST.md` → yêu cầu gốc.
2. `.agents/*/handoff.md`, `progress.md` → các phiên đa agent đã xử lý gì.
3. `PROJECT_CODE_SUMMARY.md` mục 6 → kiến trúc + quy tắc kinh doanh.

### 7.10. XUẤT MÃ NGUỒN BÀN GIAO
1. Chạy `Xuat Ma Nguon.bat` (hoặc `npm run package:source` = `node scripts/package-source.js`)
   → zip tại folder riêng **`Mã nguồn bàn giao/`**, tên file chứa version + ngày + git-sha:
   `Order-Automation_Ma-nguon_v1.0.5_2026-09-04_dd7dfe8.zip`.
2. Danh sách file = ĐÚNG những gì git đang track (`git ls-files`) — không quản tay nên không bao giờ
   sót file mới; `.gitignore` đã chặn sẵn node_modules/dist/build output/dữ liệu kinh doanh/`.env`.
   Script còn chặn phòng thủ lần nữa + cảnh báo nếu working tree còn thay đổi chưa commit.
3. Trong zip có **`MANIFEST.txt`**: phiên bản, commit, ngày xuất, danh sách file và các bước chạy lại
   trên máy mới (`npm install` → `npm test` → `npm start`).
4. **KHÔNG nằm trong zip** — bàn giao RIÊNG nếu người nhận cần chạy thật:
   `I.ĐƠN HÀNG/` (template Excel theo brand — app CẦN template để xuất Excel), `Bảng giá/`,
   `.env` (người nhận tự khởi tạo từ `.env.example`), `ORIGINAL_REQUEST.md` (lịch sử nội bộ),
   bản EXE (đóng gói riêng bằng `Build EXE.bat`, gửi file theo mục 7.7.5).

---

## 8. Quy ước làm việc trong repo này

- Ngôn ngữ comment/UI: **tiếng Việt**; tên file/thư mục dữ liệu có dấu và khoảng trắng (`I.ĐƠN HÀNG`, `Bảng giá`) — luôn quote đường dẫn khi chạy lệnh.
- Không commit `.env`, `node_modules`, file backup `*_backup_*`, output build.
- Thêm file test mới → cập nhật script `"test"` trong `package.json`.
- Thay đổi cấu trúc lớn → cập nhật README này (và nếu cần, `PROJECT_CODE_SUMMARY.md`).
- Thông báo cho user qua **toast** (`showToast` trong `ui-renderer.js`), không dùng `alert`.
- **Push GitHub chỉ đi qua `node scripts/build-public-repo.mjs`** — KHÔNG `git push` trực tiếp:
  script snapshot toàn bộ file tracked, sanitize identifier thật (brand/campaign key/tên SP/mã KV/giá → tên giả),
  commit 1 commit duy nhất rồi force-push. Từ điển nằm trong script (local-only, gitignored).
  Hook pre-push chặn push trực tiếp khi working tree còn token thật.

---

## 9. Tóm tắt điểm vào (entry points) — tra nhanh

| Muốn hiểu... | Đọc file này trước |
|---|---|
| App khởi động thế nào | `main.js` → `preload.js` → `index.html` → `src/main.js` |
| Tin nhắn biến thành đơn hàng ra sao | `parser.js` / `ai-service.js` → `db.js` (`classifyOrder`) → `src/order/calculator.js` |
| Xuất Excel hoạt động ra sao | `src/order/export.js` → `main.js` (IPC) → `excel_automation.py` |
| Nút Copy phiếu giao hàng hoạt động ra sao | `src/order/actions.js` (`copySummary`) — copy từ `getOrderTableRows(currentOrder)`, cùng nguồn với bảng render: luôn theo hiện trạng đơn đang chỉnh sửa, không rescan tin nhắn |
| KiotViet lên đơn thế nào | `browser-agent.js` + `kiotviet-auto-order.user.js` |
| Agent ngoài tích hợp qua đâu | `mcp-server.js` (MCP `127.0.0.1:8048/mcp`, stdio proxy cho IDE agent) — đọc `docs/MCP.md` |
| Dữ liệu sản phẩm nằm ở đâu | `default-db.json` (nguồn thật, db.js import; local-only) + `kv-name-map.json` (local-only) — `db.js` chỉ còn logic |

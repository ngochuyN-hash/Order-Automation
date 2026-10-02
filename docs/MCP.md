# MCP Reference — Order Automation (MCP Server)

> **Tài liệu chính thống cho AI agent / tool ngoài tích hợp với app.**
> Nguồn chân lý: `mcp-server.js` (MCP Streamable HTTP trong Electron main
> process) + `src/api/headless.js` (`window.__ORDER_API__` — data layer) +
> `mcp-stdio-proxy.js` (proxy stdio cho IDE agent).
>
> App từng dùng HTTP REST API (`api-server.js`, port 8048, `docs/API.md`) —
> đã thay hoàn toàn bằng MCP từ bản này. Mọi route `/api/*` cũ không còn tồn
> tại; endpoint duy nhất là `POST /mcp` (MCP Streamable HTTP).

---

## 1. Tổng quan

App mở một **MCP server nội bộ** trong Electron main process để AI agent /
tool cùng máy gọi được toàn bộ khả năng của app: phân tích tin nhắn sales
thành đơn hàng, đọc/sửa dữ liệu sản phẩm–giá–quà–alias–mã KiotViet, xuất Excel
thật, và lên đơn KiotViet tự động.

| Thuộc tính | Giá trị |
|---|---|
| Endpoint MCP | `http://127.0.0.1:8048/mcp` (Streamable HTTP) |
| Phạm vi | **Chỉ lắng nghe 127.0.0.1** — không truy cập được từ máy khác |
| Protocol | MCP Streamable HTTP (JSON-RPC 2.0): `initialize` → `tools/list` → `tools/call` |
| Encoding | **UTF-8 bắt buộc** — body tiếng Việt phải encode UTF-8. App tự vá được text bị encode sai kiểu Latin-1 (mojibake "HÄ‘" → "HĐ") ở các trường text của đơn, nhưng đừng dựa vào: client gửi đúng UTF-8 luôn là an toàn nhất |
| App phải đang mở | **Có** — MCP server chạy trong process Electron; renderer phải load xong mới gọi được data layer |
| Stdio cho IDE agent | `node mcp-stdio-proxy.js` (ZCode/Cursor/Claude spawn qua stdio; proxy chuyển tiếp tới app đang mở) |

## 2. Kết nối

### 2.1. IDE agent (ZCode, Cursor, Claude) — stdio

Repo đã có sẵn `.zcode/config.json` khai báo MCP server `order-automation`
(chạy `node mcp-stdio-proxy.js`). Mở project bằng ZCode là agent tự thấy 36
tool, không cần cấu hình thêm.

Điều kiện duy nhất: **app desktop đang mở** (proxy nối vào đúng instance app
đang chạy tại `http://127.0.0.1:8048/mcp` — database IndexedDB chỉ sống trong
renderer của instance đó, proxy không spawn app mới).

Proxy tôn trọng cùng biến môi trường với app: `ORDER_AUTOMATION_MCP_URL`
(url đầy đủ) hoặc `OA_MCP_PORT` (chỉ port), và tự đọc token từ
`OA_USER_DATA/mcp-token.txt` khi set — muốn proxy nối vào **instance test cách
ly** thì chỉ cần chạy proxy với cùng bộ env như khi mở instance đó.

### 2.2. External agent (n8n, Make, bot, script) — Streamable HTTP

Dùng bất kỳ MCP client nào trỏ tới `http://127.0.0.1:8048/mcp`:

```js
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const client = new Client({ name: 'my-agent', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(
  new URL('http://127.0.0.1:8048/mcp'),
  { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } },
));

const { tools } = await client.listTools();
const res = await client.callTool({ name: 'parse_order', arguments: { text: '...' } });
```

## 3. Xác thực (token)

Tool **đọc dữ liệu và parse**: không cần token.

Tool **ghi** (sửa dữ liệu, xuất Excel, lên đơn KV, kết nối trình duyệt, cấu
hình AI): bắt buộc một trong hai header trên **mọi request HTTP**:

```
Authorization: Bearer <token>
```

hoặc `X-Auth-Token: <token>`.

**Token nằm ở đâu:**
- File `userData/mcp-token.txt` (app tự sinh lần đầu, 64 ký tự hex, permission 0600).
  - Bản dev: `<thư mục app>/userData/mcp-token.txt` hoặc theo Electron:
    `%APPDATA%/order-automation/mcp-token.txt`.
  - Có thể override bằng biến môi trường `ORDER_AUTOMATION_MCP_TOKEN` trước khi mở app.
- Stdio proxy (`mcp-stdio-proxy.js`) tự đọc token từ cùng file (hoặc
  `ORDER_AUTOMATION_MCP_TOKEN`) nên IDE agent không cần truyền tay.
- Lỗi thiếu/sai token: tool trả `isError: true`, `code: "UNAUTHORIZED"`.

**Bảo mật khác:** request với header `Host` không phải loopback → 403 (chặn DNS
rebinding); request cross-origin từ website → 403, kể cả `Origin: null`
(file://, sandboxed iframe); so sánh token timing-safe.

**Môi trường test cách ly (cho agent/dev):** khởi động thêm một instance app với
userData + port MCP riêng để test thoải mái mà không đụng dữ liệu thật của bản chính:

```bash
OA_USER_DATA=C:\Antigravity\Order Automation\.test-env\userdata OA_MCP_PORT=18048 npx electron .
```

- Instance chạy song song với bản chính (single-instance lock theo userData nên không cản nhau).
- Catalog mặc định seed từ `default-db.json` — không có config AI → tool `parse_order` chạy pipeline offline (deterministic).
- Token của instance nằm tại `<OA_USER_DATA>/mcp-token.txt`; MCP endpoint `http://127.0.0.1:18048/mcp`.
- Stdio proxy cũng nhận `OA_USER_DATA`/`OA_MCP_PORT` — nối thẳng vào instance cách ly mà không cần cấu hình lại.

## 4. Mô hình response & lỗi

Tool thành công trả:

```json
{ "success": true, "...": "..." }
```

Tool thất bại trả `isError: true` và `structuredContent`:

```json
{ "success": false, "code": "APP_NOT_READY", "error": "App window not available..." }
```

| `code` | Ý nghĩa |
|---|---|
| `UNAUTHORIZED` | Thiếu/sai token (tool ghi) |
| `APP_NOT_READY` | App đang mở nhưng renderer chưa load xong — chờ vài giây rồi thử lại |
| `BROWSER_NOT_CONNECTED` | Browser chưa kết nối — gọi tool `connect_browser` trước |
| `TASK_RUNNING` | App đang tự lên đơn KV — poll `get_run_status` tới khi xong rồi mới thao tác trình duyệt |
| `RENDERER_ERROR`, `INVALID_ORDER`, `PARSE_FAILED` | Dữ liệu gửi vào sai — đọc `error` để sửa |
| `INVALID_PARAMS` | Thiếu tham số bắt buộc theo ngữ cảnh (vd `upsert_product` cần `product.id` khi update hoặc `product.name` khi tạo mới) |
| `INVALID_IMPORT` | `import_database`: `data` không đúng shape export (phải có `database.campaigns` hoặc `campaigns`) |

---

## 5. Tool tham khảo

### 5.1. Trạng thái & Discovery

| Tool | Token | Mô tả |
|---|---|---|
| `get_server_info` | không | Discovery máy đọc được: trạng thái app, endpoint MCP, đường dẫn token, khả năng hỗ trợ |
| `get_status` | không | Trạng thái app + browser agent (KiotViet) |
| `get_run_status` | không | Tiến độ, log thực thi (50 dòng cuối) và kết quả lần chạy gần nhất (`orderCode`, `success`, `error`, `finishedAt`) |
| `abort_run` | có | Hủy/dừng quy trình chạy KiotViet đang diễn ra |

### 5.2. Phân tích tin nhắn sales → đơn hàng

| Tool | Token | Mô tả |
|---|---|---|
| `parse_order` | không | Pipeline đầy đủ như nút "Phân Tích Đơn Hàng": AI trích xuất (nếu đã cấu hình profile AI) → khớp sản phẩm → phân loại campaign → tính giá bậc → quà FOC. `mode`: `auto` (mặc định, fallback offline kèm `fallbackReason`), `ai` (ép pipeline AI, lỗi trả rõ ràng KHÔNG fallback), `offline` (chỉ regex + fuzzy) |
| `parse_order_offline` | không | Chỉ regex + fuzzy matching, không gọi AI — nhanh, deterministic |

Response thêm `mode` (`"ai"` / `"offline"` — pipeline nào thực sự chạy) và
`fallbackReason` (`null` nếu chạy đúng intent; `"no_enabled_profile"` hoặc
`"ai_error: <lý do>"` khi auto phải fallback). Xem trước khi gọi:
`get_ai_status`.

### 5.3. Sản phẩm & dữ liệu

| Tool | Token | Mô tả |
|---|---|---|
| `get_products` | không | Liệt kê sản phẩm đầy đủ (giá bậc, FOC, alias, mã KV đã resolve). Input: `campaign`, `q` (tìm theo tên/spec/alias/mã KV, bỏ dấu), `limit`, `offset` |
| `upsert_product` | có | Thêm mới hoặc cập nhật sản phẩm — **có `id` = update (partial: chỉ gửi trường muốn sửa, không cần `name`), không có `id` = tạo mới** (tạo mới bắt buộc `campaign` + `name`). Nhận `aliases` (mảng — **thay toàn bộ**), `kvCode`/`kvCodeThung` |
| `delete_product` | có | Xóa sản phẩm (`id`). Tự dọn mã KV + alias như GUI |
| `get_campaigns` | không | Danh sách campaign. `includeProducts: true` kèm toàn bộ `products` và `promoRules` |
| `add_campaign` | có | Thêm campaign (`key`: chỉ `a-z0-9_`; trùng key → lỗi) |
| `update_campaign` | có | Sửa campaign (`key` + `updates`, gồm được `promoRules`) |
| `delete_campaign` | có | Xóa campaign (`key`, `force: true` để xóa cả khi còn sản phẩm) |
| `get_aliases` | không | Map toàn bộ alias → productId |
| `set_aliases` | có | Thay toàn bộ alias của 1 sản phẩm (`productId` + `aliases`) |
| `get_kv_map` | không | Map mã KiotViet runtime (`kvCodeMap`, `kvCodeThungMap`) |
| `set_kv_code` | có | Set mã KV (`productId`, `base` lẻ, `thung` override; chuỗi rỗng = xóa) |
| `get_memory` / `set_memory` | đọc không / ghi có | Bộ nhớ quy tắc AI (text tự do, nhét vào prompt khi AI parse) |
| `get_sellers` / `save_sellers` | đọc không / ghi có | Nhân viên sales + tiền tố mã đơn theo brand (`sellers`, `brandPrefixes`) |
| `get_current_order` | không | Đơn hàng đang mở trong UI (giá/FOC đã tính, kèm `kvCode`, `pendingId`, `rawChatText`) |
| `export_database` / `import_database` | đọc không / ghi có | Dump toàn bộ database (như nút "Xuất JSON") / nhập lại từ dump (**ghi đè toàn bộ**; `data` nhận object export hoặc chuỗi JSON — shape sai → `INVALID_IMPORT` chứ không nuốt câm) |
| `reset_database` | có | Reset database về mặc định gốc (**phá hủy** — bắt buộc `confirm: true`) |

Dữ liệu persist **giống hệt GUI**: IndexedDB + mirror localStorage; mã KV còn
ghi cả vào `kv-name-map.json`.

### 5.4. Đơn hàng & xuất Excel

| Tool | Token | Mô tả |
|---|---|---|
| `export_excel` | có | **Xuất Excel thật** (Python win32com ghi vào template từng brand) — headless, không đụng UI. Input `order`: `customer` (bắt buộc), `items[]` (`id`/`code`/`name`, `qty` > 0, `unit`, `price` override, `isGift`), `payment`, `seller`, `discount`, `orderDate`, `note`, `dryRun` (`true` → **không ghi file**, trả payload dự kiến). Quà FOC/MKT tự tính. Đơn nhiều brand → tự tách nhiều file |

Dòng hàng resolve theo thứ tự: product id → mã KV (lẻ **hoặc** thùng) → tên chính xác → fuzzy. Không resolve được → lỗi kèm dòng gây lỗi.

### 5.5. KiotViet

| Tool | Token | Mô tả |
|---|---|---|
| `connect_browser` | có | Kết nối BrowserMCP (tự phát hiện Chrome → Edge → Brave, profile `~/.kv-browser-profile`, zero-install) |
| `run_kiotviet_order` | có | Lên đơn KiotViet tự động (điền giỏ POS, verify DOM, tự bấm Đặt hàng, bắt mã đơn `DHxxxxxx`). Input `orderData` + `options` (`mode: new\|supplement`, `autoSubmit`, `skipVerify`, `savePdf`). **`qty` mỗi dòng bắt buộc số nguyên > 0** — sai → `INVALID_ORDER`, không bao giờ âm thầm ép thành 1. Chưa kết nối browser → `BROWSER_NOT_CONNECTED` |
| `auto_run_order` | có | **1-click end-to-end**: nhận thẳng text sales → tự parse (tính giá thùng cho chai lẻ, FOC, MKT) → nạp vào GUI → xuất Excel và/hoặc lên đơn KiotViet. `action`: `kiotviet` (mặc định) \| `excel` \| `both` \| `parse-only`. Trả `kiotvietStarted` + `poll: "get_run_status"` |

**Ngắt cứng**: `abort_run` hủy ngay lệnh Playwright MCP đang bay và fetch AI
verify đang chờ; run kết thúc bằng event terminal `aborted`. Nút **"Ngắt"**
trên panel "Hoạt Động AI" của UI gọi cùng cơ chế (bấm lần 2 → reset cưỡng bức).
Sau abort hoặc lỗi, `get_run_status` trả `lastRun.success: false` kèm `error`
— không bao giờ báo success giả.

### 5.6. AI Profiles (agent tự cấu hình + chẩn đoán AI)

**Bất biến bảo mật: API key KHÔNG BAO GIỜ xuất hiện trong response** — chỉ có
`hasKey` (bool) và `keyError`.

| Tool | Token | Mô tả |
|---|---|---|
| `get_ai_status` | không | Trạng thái AI profiles (strategy, activeId, danh sách profile đã mask key). Rỗng/không có `enabled: true` → `parse_order` chạy offline |
| `test_ai_profiles` | có | Test kết nối 1 profile theo `id`, hoặc **tất cả profile đang bật** khi bỏ `id` (tốn quota) |
| `manage_ai_profiles` | có | Upsert/xóa AI profiles, đặt `strategy` (`failover`\|`roundrobin`) và `activeId`. `provider` thuộc registry 12 provider (`gemini, openai, anthropic, deepseek, groq, openrouter, mistral, qwen, zai, ollama, lmstudio, custom`). Không `id` → tạo mới; có `id` → ghi đè trường được gửi. **`apiKey` bỏ trống → GIỮ key cũ**; `"clearKey": true` mới xóa. Key mã hóa DPAPI ngay khi lưu |

### 5.7. Browser — agent đọc/thao tác trình duyệt của app

App kết nối trình duyệt Chrome (profile riêng `~/.kv-browser-profile`) qua
Playwright MCP nội bộ — **không cần extension hay computer-use**.

| Tool | Token | Mô tả |
|---|---|---|
| `get_browser_tools` | không | Danh sách tool Playwright MCP đang khả dụng (tên + mô tả) — agent tự discovery |
| `get_browser_snapshot` | không | Cây accessibility trang hiện tại (text). Mỗi phần tử có `ref` dùng cho `execute_browser_tool` — đúng vòng lặp Playwright MCP: `snapshot → tìm ref → execute` |
| `execute_browser_tool` | có | Pass-through **mọi tool `browser_*`** (~75 tool: `browser_click`, `browser_type`, `browser_take_screenshot`, `browser_tabs`...). Input `{ tool, args }`. Khi app **đang tự lên đơn KV** → `TASK_RUNNING`. Kết quả `{ text, images[] }` — `images[]` chứa ảnh base64 (vd screenshot) |

> Mọi thao tác của agent qua các tool đều được app hiển thị realtime trong
> panel **"Hoạt Động AI"** trên giao diện — người dùng luôn thấy AI đang làm gì.

---

## 6. Ví dụ workflow cho AI agent

### Cách 1: Nhanh nhất (1-click với `auto_run_order`)

1. Lấy token: đọc file `%APPDATA%/order-automation/mcp-token.txt`.
2. Gọi 1 tool duy nhất:

```
auto_run_order({
  text: "Anywhere Man\n1 thùng prostream 10W50\n1 chai Prostream 15W50 giá thùng\nTT CK\nHđ",
  action: "kiotviet",
  options: { autoSubmit: true },
})
```

3. Poll `get_run_status` tới khi `lastRun.finishedAt` có giá trị → nhận `orderCode` (`DHxxxxxx`).

### Cách 2: Từng bước thủ công (flexible)

1. `get_server_info` — kiểm tra khả năng + đường dẫn token.
2. `get_status` — kiểm tra app còn sống.
3. `parse_order({ text })` — nhận đơn hoàn chỉnh (giá + FOC đã tính).
4. `export_excel({ order: { ..., dryRun: true } })` — kiểm tra trước khi ghi file.
5. `export_excel` (thật) + `run_kiotviet_order` — xuất Excel + lên đơn KV.
6. Poll `get_run_status` tới khi xong.

### Cách 3: Agent tự cấu hình AI rồi parse bằng AI (môi trường mới / test cách ly)

1. `get_ai_status` — profiles rỗng / không có `enabled: true` → parse sẽ chạy offline.
2. `manage_ai_profiles({ profiles: [{ name, provider, model, apiKey, enabled: true }] })` — key gửi 1 lần, mã hóa DPAPI, không đọc lại được.
3. `test_ai_profiles({})` — test kết nối (tùy chọn).
4. `parse_order({ text, mode: "ai" })` — ép AI; AI hỏng báo lỗi rõ ràng thay vì fallback âm thầm.

### Cách 4: Agent tự đọc/thao tác trình duyệt KiotViet (không extension)

1. `connect_browser({})` (đã kết nối trong app là no-op).
2. `get_browser_snapshot({})` — đọc trang (cây accessibility kèm ref).
3. `execute_browser_tool({ tool: "browser_type", args: { target: "e5", text: "..." } })` — thao tác theo ref.
4. `get_browser_tools({})` — xem tool khả dụng khi cần thao tác phức tạp.

> ⚠️ `import_database` và `reset_database` **ghi đè/xóa toàn bộ dữ liệu** —
> chỉ gọi khi đã có dump mới (`export_database`).

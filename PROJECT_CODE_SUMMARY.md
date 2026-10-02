# TỔNG HỢP MÃ NGUỒN DỰ ÁN — ORDER AUTOMATION

> **Vị trí dự án (từ 12/09/2026):** `C:\Antigravity\Order Automation\` — folder gốc `C:\Antigravity\` là folder quản lý tổng nhiều dự án; repo git và toàn bộ dữ liệu nằm trong folder dự án.

Tài liệu này chứa bản dump mã nguồn cốt lõi của dự án **Order Automation** (Tự động hóa đơn hàng) dùng để review code. 
Phần dữ liệu sản phẩm tĩnh khổng lồ trong `db.js` đã được rút gọn cấu trúc để người review có thể tập trung vào logic xử lý chính.

> ⚠️ **QUAN TRỌNG KHI ĐỌC TÀI LIỆU NÀY BẰNG IDE/AI AGENT MỚI:**
> Các mục 2–5 (dump code `index.html`, `style.css`, `app.js`, `db.js`) là **ảnh chụp tại tháng 7/2026** — chỉ dùng tham khảo.
> **Nguồn chân lý luôn là file thật trên đĩa.** Renderer đã module hóa vào `src/`; `app.js` giờ là legacy monolith
> không còn được import bởi entry thật. Khi dump trong tài liệu khác file thật → theo file thật.
> Bản đồ chính xác & mới nhất: **`README.md`**.

### Trạng thái hiện tại (cập nhật 9/2026)
- **Nền tảng**: Electron 33 desktop app (Windows), đóng gói bằng electron-builder 25
- **Excel export**: `excel_automation.py` — Python **win32com điều khiển Excel thật** (clone sheet template, chèn dòng,
  FillDown công thức VLOOKUP/SUM). `main.js` spawn qua IPC + mutex chống ghi đồng thời + backup `*_backup_<timestamp>`.
  ⚠️ Đã **BỎ** cơ chế cũ PowerShell `excel-automation.ps1` + local HTTP server port 8046 (chỉ còn trong lịch sử).
- **KiotViet** (`YOUR_TENANT.kiotviet.vn`) — 3 cơ chế: (a) browser agent MCP tự lập trình (`browser-agent.js` + `mcp-client.js`,
  AI local LM Studio `localhost:1234`, `script-registry.js` tái sử dụng script chạy tốt), (b) userscript Tampermonkey
  `kiotviet-auto-order.user.js` (WebSocket API), (c) automation renderer `src/kiotviet/automation.js`.
  **Zero-install (31/8/2026)**: `@playwright/mcp` vendor vào app (pin `0.0.79`), MCP server chạy bằng Electron-as-Node
  (`ELECTRON_RUN_AS_NODE=1` + `cli.js` trong `app.asar.unpacked`) — máy người dùng KHÔNG cần cài Node.js;
  fallback browser Chrome → Edge → Brave (`pickBrowserLaunchArgs` trong `browser-agent-ipc.js`), không có browser
  nào thì connect trả lỗi tiếng Việt hướng dẫn cài. `McpClient` có listener mặc định cho sự kiện `error`
  (spawn ENOENT từng có thể crash main). Test giả lập kết nối: `test/browser-agent-ipc.test.js` (mock
  Module._load + fake MCP stdio + 2 handshake thật skip-khi-thiếu-binary). Chi tiết: README mục 7.4.
- **MCP cho agent ngoài (9/2026)**: `mcp-server.js` — MCP Streamable HTTP `127.0.0.1:8048/mcp` (36 tools, thay hoàn toàn REST API `api-server.js` cũ), token auth cho tool ghi (`userData/mcp-token.txt` hoặc `ORDER_AUTOMATION_MCP_TOKEN`); stdio proxy `mcp-stdio-proxy.js` cho IDE agent (ZCode/Cursor/Claude, config `.zcode/config.json`; tôn trọng `OA_USER_DATA`/`OA_MCP_PORT` khi test instance cách ly). Tool discovery: `get_server_info`; error codes (`APP_NOT_READY`, `BROWSER_NOT_CONNECTED`, `UNAUTHORIZED`, `TASK_RUNNING`, `INVALID_ORDER`, `INVALID_PARAMS`, `INVALID_IMPORT`); `get_run_status` (lấy mã đơn `DHxxxxxx`, log 50 dòng, trạng thái chạy — abort/lỗi luôn `success:false`, không báo success giả), `abort_run` (hủy chạy KiotViet). **Hardening (20/9/2026)**: `qty` dòng hàng bắt buộc số nguyên > 0 (chặn trước cả check browser); `upsert_product` update theo `id` được partial (không cần `name`); `import_database` validate shape export; sanitize `__proto__`/`constructor`/`prototype` trên object agent gửi (chống prototype pollution); chặn `Origin: null` (403). Đủ tool đọc/ghi: products/campaigns/aliases/kv-map/memory/sellers CRUD, current_order, export/import/reset_database, export_excel headless (FOC+MKT tự tính, dryRun) + parse_order/parse_order_offline + run_kiotviet_order/auto_run_order + AI tools (get/test/manage_ai_profiles — key không bao giờ trả về) + browser tools (get/execute_browser_tool). **Docs chính thống: `docs/MCP.md`**
- **Renderer đã module hóa**: entry `src/main.js`; event binding tập trung tại đây — thêm module mới phải init ở đó
- **Tính năng đã thêm sau 7/2026** (chi tiết README mục 7):
  - **Gộp bản parse headless + 3 bug đường lên đơn MCP (27/9/2026, v1.5.4)**:
    `headlessAiParse` (`src/api/headless.js`) bị xoá — đây là bản chép tay của `runParsePipeline` đã lệch 7 chặng
    (tier-line strip, mốc giá N thùng, pattern giá `tr`, brand-context 2-pass, AI-FINAL, price-guard, học alias),
    nên GUI và MCP/HTTP cho kết quả khác nhau. `parseWithAI` giờ là adapter gọi `runParsePipeline(...,
    {learnAliases:false})`. Thêm cờ `giftsExpanded` tại seam `parseOrderToRunFormat` → `exportOrderToExcel`
    (luồng `action:"both"` từng xuất mỗi dòng FOC/MKT 2 lần). Tách `resolveSellerReceiver()` vào
    `src/seller/manager.js` — cả `KiotVietAutomation.buildOrderData` lẫn headless cùng gọi, tool `auto_run_order`
    thêm param `seller` (trước đây field `receiver` không tồn tại ở đường MCP). `AGENTS.md` §2 viết lại: root
    `parser.js`/`ui-renderer.js`/`ai-service.js`/`store.js`/`db.js` là LIVE chứ không phải legacy.
  - **Ô thêm sản phẩm trong đơn (25/9/2026)**: `index.html` đổi khối `<details>` thành
    `.add-product-panel` cố định, không cần bấm mở; chỉ giữ ô tìm trong danh mục và dropdown
    chọn sản phẩm để thêm vào `currentOrder.items`. Bỏ form “Nhập sản phẩm tự do (kiểm tra hàng)”,
    handler `btnAddCustomProduct` và hàm `addCustomProductToOrder()`; giữ nguyên hỗ trợ đọc/render
    dòng `isCustom` cũ để tương thích dữ liệu đã lưu. CSS bỏ trạng thái collapse và lưới form tự nhập.
    Test hồi quy DOM trong `test/campaign-editor.test.mjs`.
  - **Bộ đếm số PO chỉ tăng khi Xuất Excel thành công (22/9/2026)**:
    `generateOrderTitle()` (`src/seller/manager.js`) trước đây vừa sinh tiêu đề vừa tăng bộ đếm
    `orderSeq_{PREFIX}_{YYMM}` NGAY LÚC GỌI — xuất bị lỗi (thiếu file template, Excel đang mở) đã đốt số →
    xuất lại nhảy số, vỡ chuỗi STT; `export_excel` headless `dryRun:true` cũng tăng bộ đếm dù không ghi file.
    Tách 3 hàm: `peekOrderSequence()` (xem số kế tiếp, không ghi), `generateOrderTitle()` (thuần, nhận seq),
    `commitOrderSequence()` (ghi + guard không lùi). GUI (`src/order/export.js`) và headless
    (`src/api/headless.js`) chỉ commit sau khi IPC `exportOrder` thành công từng brand; dryRun không commit;
    AI-retry giữ số đã peek. Test mới `test/order-title-sequence.test.mjs` (4 case).
  - **Audit UX + 3 fix giữ dữ liệu (18/9/2026, chưa phát hành)**:
    audit UX toàn app (shell, luồng đơn, settings/catalog/KV modal) rút ra ~40 mục; phiên này
    chỉ chốt 3 fix có test chứng minh, còn lại ghi ở README 7.5:
    (1) `src/order/pending.js` — `orderSignature` thêm `giftKindOverrides` vào dirty-check,
    đổi FOC↔Extra không bị nuốt khi auto-save/lưu tay (regression trong `test/pending-orders.test.mjs`);
    (2) `src/kiotviet/automation.js` — `buildOrderData` lọc dòng SL 0 (số `0` lẫn chuỗi `"0"`) trước khi
    map, `qty: Number(r.qty)` thay `r.qty || 1` — SL 0 không còn thành 1 trên KV, quà 0đ SL dương giữ
    nguyên (`test/kv-zero-qty.test.mjs`); (3) `src/settings/ui.js` — `closeProductEditorModal` dispatch
    `change` cho ô active chưa commit trước khi gỡ DOM (Esc đóng modal không mất giá đang gõ; Esc ô
    tracked vẫn hoàn tác giữ modal — `test/product-modal-close.test.mjs`). KM ngoài KHÔNG xuất Excel/KV
    là chủ ý (đơn ghi lại đủ), không phải bug. Lệch override sau xóa dòng đã tái hiện, TODO tại
    `test/order-action-ux.test.mjs` (chạy riêng). Xác minh: 419 tests, 418 pass, 1 skip; build renderer
    OK; chưa nghiệm thu GUI/Excel/KV thật.
  - **Danh Mục phẳng xuyên thương hiệu (18/9/2026, v1.5.0)**:
    bỏ dropdown thương hiệu, thay bằng chip bar (Tất cả + chip/brand: dot màu, số SP, số ⚠);
    mặc định flat một danh sách liền mạch + chip brand trên hàng (`_catalogRowHtml` chung);
    toggle Danh sách/Theo thương hiệu lưu `localStorage`; nút Thêm SP toàn cục pre-select brand
    đang lọc; sub-tab Sản Phẩm trong Cài Đặt đã xóa hẳn (18/9 dọn nốt màn dẫn + wiring form cũ;
    nút Đóng form tạo thương hiệu ẩn form, nút Thêm hiện lại); warning trùng tên
    xuyên brand `DUPLICATE_NAME_CROSS_CAMPAIGN` (`src/product-edit.js`, `src/settings/ui.js`).
    CSS mới: `.catalog-brand-chips`, `.catalog-view-toggle`, `.catalog-row-brand`.
    Cài Đặt → Thương Hiệu giữ editor cấu hình chung/MKT tổng đơn/KM dạng text và danh sách
    chọn/xóa thương hiệu, không còn render danh sách SP trùng. Nút Quản lý thương hiệu trong
    Danh Mục mở thương hiệu đang lọc. Liên kết Quy cách khác bỏ bộ lọc ẩn đích trước khi mở chi tiết.
    Test `test/campaign-editor.test.mjs` dùng jsdom nạp index.html và bấm các luồng trên.
    Xác minh: 412 tests, 411 pass, 1 skip (thiếu workbook Excel sandbox).
    ĐÃ build Setup 1.5.0 (18/9, commit 1c3c73b): installer + source zip trong thư mục bàn giao.
    **UX Thương hiệu cải thiện (19/9)**: copy màn trống đúng, sidebar đếm MKT/KM + ⚠,
    card MKT/KM collapse mặc định có badge đếm, bỏ emoji card-title/icon input,
    Brand Key ghi "không đổi được", link "Xem SP trong Danh Mục →" ngược,
    confirm xóa brand hiện tên + số SP, xóa dead code `toggleAddCampaignForm`.
    CSS: `.campaign-sub-count`, `.editor-section-card`.
    Xác minh: 419 tests, 418 pass, 1 skip; build renderer OK.
    **UX Danh Mục — quà MKT gọn (25/9/2026)**: `_campaignMktStripHtml` + `renderCatalog` gom phần
    quà MKT thương hiệu vào `<details>` mặc định đóng ở cả chế độ phẳng/gom; summary chỉ còn tên và
    số mốc, bấm mới bung chip quà/mã KV. CSS mới `.catalog-mkt-summary`, `.catalog-mkt-strip`.
    **Modal thêm sản phẩm — form gọn (25/9/2026)**: bỏ tùy chọn “hàng quà/tặng” vì giá 0đ là trạng
    thái bình thường; `validateNewProduct` không còn chặn giá 0đ, Danh Mục không còn ping `Giá 0đ`.
    Nhãn đóng gói rút gọn và chú thích chuyển xuống dưới input; CSS `.new-product-form-card` giữ
    lưới 2 cột không lệch nhau. Vẫn giữ cảnh báo thiếu mã KV/chưa có mốc giá.
  - **Fix chọn FOC/Extra khả dụng trên mọi loại hàng khi giá 0đ (16/9/2026, v1.4.3)**:
    thêm `|gk:` (`giftKindOverrides`) vào `orderTableSignature` (`ui-renderer.js`) để lượt click đổi FOC ↔ Extra
    không còn bị cache HTML bảng nuốt; đồng bộ điều kiện dòng free (`subtotal === 0 || bottlePrice === 0`)
    cho cả hàng khớp danh mục, chưa khớp, tự nhập `isCustom`; đồng bộ `isGift` và `giftKind` khi xuất Excel
    (`src/order/export.js`) và preview KiotViet (`src/kiotviet/automation.js`). Test mới `test/foc-extra-toggle.test.mjs` (4 case).
    Kèm tinh chỉnh UX Danh mục: option bộ lọc `⚠ Cần hoàn thiện (N)` tự đếm số SP lỗi dữ liệu theo thương hiệu;
    dọn dead CSS `grid-template-*` trên layout flexbox `.order-split` trong breakpoint media query (`style.css`).
  - **Pass V2 ép box_size theo text packaging 1 lần (16/9/2026, v1.4.2)**: `ensurePackingConsistency()`
    thêm pass gated `_packingFixedV2` — boot đầu trên bản này ép đồng loạt box_size theo số trong chuỗi
    packaging cho SP thêm/sửa text sau pass v1.3.4, sau đó tôn trọng tuyệt đối số user sửa. Fix kèm
    `parsePackagingQty`: số thập phân ("x 1,5 lít") không còn bị đọc là số lượng (trước ép 10 → 1).
  - **Form thêm hàng 1 lần đủ + badge sức khỏe SP (16/9/2026, v1.4.0)**:
    `src/product-edit.js` thêm `validateNewProduct()` (thuần, test khóa), `createProductFull()`
    (addProduct + tiers + alias + KV gốc/thùng + rule KM nhanh `__same__`), `productHealthFlags()`,
    `packagingPreviewText()`. Modal Thêm SP (`src/settings/ui.js`): giá NHIỀU mốc ngay lúc tạo,
    ô mã KV thùng riêng, checkbox hàng quà/tặng, preview "12 chai/thùng" live, KM nhanh gập,
    lỗi đỏ inline từng ô (box_size rác không còn tự ép 12 im lặng; mã KV trùng/alias cướp bị chặn).
    Danh mục: badge ⚠ Thiếu mã KV/Chưa có mốc giá/Giá 0đ + filter "Cần hoàn thiện".
    Bảng đơn: nút "Lưu thành SP" trên dòng tự nhập (`saveCustomAsProduct`) — mở form điền sẵn,
    học alias tên custom, gắn SP mới vào dòng. Test mới `test/product-create.test.mjs` (19 case).
  - **UX xem Danh Mục (16/9/2026, v1.4.1)**: bấm tên SP toggle chi tiết (delegation
    `src/catalog/delegation.js`), header thương hiệu "X/Y khớp" khi lọc + ẩn section 0 kết quả
    (đúng cả filter nhóm/cần hoàn thiện, không chỉ khi search), nút ▸ nới vùng bấm,
    badge wrap ở ≤1100px (`style.css`).
  - **Chữ quy cách/đóng gói hiển thị tự sinh theo box_size (16/9/2026, v1.3.6)**:
    `ui-renderer.js` thêm `packagingAutoText()` — các chỗ hiển thị "tham khảo" (badge
    📦 danh mục, dòng quy cách trên đơn, combobox sản phẩm, chip package) giờ lấy
    `box_size` + unit (vd "12 chai/thùng") thay vì chuỗi `packaging` tự nhập (dễ lệch
    số với phép nhân thùng). Chuỗi packaging gốc giữ trong DB/input, chỉ còn trong
    tooltip. `src/order/actions.js` import helper dùng chung.
  - **AI parse không mất dòng khi sales gõ sai chính tả phụ từ (16/9/2026, v1.3.5)**:
    đơn thật "Bảo Long Detailing" — "moto SR scooer 10w40" (typo) + "moto SR 10w40" = 2 SP
    khác nhau (Moto XP 10W40 **Scooter** 8230014 vs Moto XP 4T 10W40 8230015) nhưng
    AI-FINAL rule "phụ từ phải có mặt trong tên SP" không thấy "scooer" trong tên nào
    → tự chọn bản 4T → 2 dòng map 1 productId → `mergeDuplicateItems` gộp 6+6=12
    (đơn 4 dòng hoá 3; giỏ KV vẫn quét đủ 4 SP vì đọc DOM POS — 2 nguồn khác nhau).
    Fix 3 chỗ, không phình prompt (model yếu 2.5 Flash): (1) `parser.js` `DOMAIN_SYNONYMS`
    + `'scooer': 'scooter'` — khớp variant về code; (2) `ai-service.js` `disambiguateItems`
    hiển thị rawProduct qua `normalizeFull` — AI-FINAL nhìn typo đã chuẩn hóa, nhất quán
    matching local; (3) thêm 2 ví dụ few-shot (2 dòng cùng brand+grade khác phụ từ = 2 SP
    riêng; dòng mở đầu "TT" có số lượng+tên SP = dòng sản phẩm, không phải payment).
    Test +5 case trong `test/matching-golden.test.mjs` (chốt cả hành vi merge hợp lệ
    khi cùng productId viết 2 kiểu: vẫn gộp 6+6=12). 381 tests / 380 pass.
  - **box_size không còn bị ép lại mỗi boot (16/9/2026, v1.3.4)**: `db.js`
    `ensurePackingConsistency()` — loop chung mọi campaign chạy MỖI boot không cờ (ép
    `box_size` theo số trong chuỗi packaging, đè cả giá trị user sửa tay; docstring cũ
    hứa cờ `_packingFixedV1` nhưng không bao giờ cài). Giờ gate đúng 1 lần bằng
    `data._packingFixedV1` (lần đầu ép hết lệch lịch sử — bug Chain Care Kit — sau đó
    mặc định tôn trọng box_size user). Test +2 case. 376 tests / 375 pass.
  - **Hết reset KM về mặc định mỗi boot + an toàn dữ liệu khi migration (16/9/2026, v1.3.3)**:
    `db.js` — `_ensureZentorMktRulesSynced()` từng chạy MỖI boot không gated (user thêm/bớt sản
    phẩm-quà trong CTKM Zentor là boot sau bị thay nguyên bộ `type:'total'` rules bằng seed
    DEFAULT_DB → tưởng mất dữ liệu khi cập nhật). Đổi thành migration `_applyZentorMktFix()`
    gated `zntMktFixedVersion=1` (chỉ chạy đúng 1 lần; muốn áp lại seed → bump hằng). Bộ lọc
    FOC sai 2 SP znt_mxo chuyển vào fix gated luôn (không xóa mỗi boot). Thứ tự boot: 
    `_applyPromoMigration` TRƯỚC `_applyPriceSeedMigration` (hết trùng rule khi nâng từ ≤1.2.x);
    price-seed chỉ thay rule qty theo SP catalog seed, GIỮ rule `total` campaign + rule `text`
    user (filter cũ vứt theo `productId`). Snapshot DB nguyên trạng trước mọi migration mỗi boot
    (rolling 3 bản, key `oa_db_preboot_backups`, không UI — khôi phục khẩn cấp qua dbStore).
    Settings: kéo thả đổi vị trí rule KM (4 danh sách). Test `test/promo-migration-fix.test.mjs`
    (4 case: zentor fix 1 lần + giữ chỉnh sửa sau flag + migrate trước seed không trùng + rolling
    backup). 374 tests / 373 pass.
  - **Xuất Excel: tự đóng file đang mở ổn định hơn (15/9/2026, v1.3.2)**: `main.js` (root) — nhánh
    auto-close giờ retry `closeExcelWorkbookGracefully` tối đa 3 lần (~2.5s cách nhau) thay vì thử 1
    lần; poll chờ OS nhả khóa nới 5s → 10s (Excel có lúc nhả chậm ~27s theo `export-log.jsonl`, bản cũ
    trả lỗi "đóng thủ công" oan dù đã đóng xong); lỗi dự phòng giữ hướng dẫn đóng tay + gợi ý bấm Xuất
    lại. Không đổi Python/renderer.
  - **Thiết kế lại toàn bộ cấu hình khuyến mãi — Schema số thống nhất (15/9/2026, v1.3.0)**:
    Loại bỏ hoàn toàn cơ chế "ghi text" và runtime đoán quà bằng regex/heuristic từ câu chữ (`note`).
    Bốn nguồn rule khuyến mãi (`campaign.mkt_gift_rules`, `product.foc_rules`, `product.mkt_gift_rules`,
    `campaign.promoTextRules`) được hợp nhất về **MỘT mảng `campaign.promoRules[]`**:
    - **Schema số chuẩn**: `{ id, type: 'qty' | 'total' | 'text', scope: 'product' | 'campaign', enabled, kind, productId?, buy?, threshold?, gifts: [{ qty, productId, unit?, options?, subOptions?, name? }], keywords?, unitHint?, defaultQty?, global?, label, note }`.
    - **Mốc luôn là số**: `buy.qty` hoặc `threshold.min`/`threshold.max`. Quà luôn link mã sản phẩm thật trong danh mục (`gifts[].productId`).
    - **Label tự sinh từ số**: hàm `db._buildPromoLabel(rule)` tự sinh chuỗi hiển thị chuẩn ("Mua 1 thùng tặng 2 chai...", "2-5 triệu: tặng..."), người dùng và hệ thống không còn nhập text mô tả tay.
    - **Hỗ trợ mốc TIỀN theo từng dòng sản phẩm**: hàm mới `db.getProductMoneyPromoRule(product, lineSubtotal, lineQty)` (scope: 'product', type: 'total') cho phép cấu hình "Mua 1.8tr tặng nón" hoàn toàn bằng số, tích hợp vào `calculateOrderItem` và headless.
    - **Migration tự động 1 lần**: `migratePromoRules(data)` (version=3) tự động chuyển đổi dữ liệu người dùng cũ từ IndexedDB/localStorage, giải mã 50 rule FOC cũ thiếu mã sản phẩm sang sản phẩm chuẩn một lần duy nhất lúc migrate.
    - **Dữ liệu & UI đồng bộ**: `DEFAULT_DB` trong `db.js` và `default-db.json` chuyển 100% sang `promoRules[]`. Các tab Settings, Danh mục, và Renderer được cập nhật đọc/ghi trực tiếp vào schema mới.
    - **Tests**: toàn bộ test suite chạy xanh (370 tests / 369 pass, 1 skip cũ).
  - **Kéo thả đổi vị trí rule khuyến mãi trong Settings editor (16/9/2026)**: 3 danh sách rule
    (`mkt-rule-row` mốc MKT/total, `foc-row` FOC theo sản phẩm,
    `product-mkt-row` MKT theo sản phẩm) có drag-handle (SVG 8 chấm `currentColor`, class `drag-handle`
    dùng chung bảng đơn) + `draggable="true"`; drop chỉ hợp lệ trong CÙNG danh sách
    (`.promo-rule-list`), di chuyển rule trong `campaign.promoRules` bằng splice trên vị trí thật
    (`indexOf` — đúng cả khi type xen kẽ), `db.save()` + re-render theo vùng (mốc full
    `renderSettingsEditor`, FOC/MKT-pp partial). Listener delegated trong
    `src/settings/ui.js` `attachProductEditorDelegation` (PROMO_ROW_KINDS — copy filter y hệt handler
    xóa từng loại); dọn state `clearPromoDragState()` NGAY tại drop (bài học bug `is-dragging` kẹt,
    xem bảng đơn). CSS `.promo-rule-draggable` (dragging/drag-over) trong style.css. Thứ tự có ý nghĩa
    thật: rule `total` khớp theo thứ tự mảng, rule text dùng thứ tự làm tiebreak cùng điểm keyword.
  - **Tối ưu hiệu năng danh sách đơn hàng (15/9/2026)**: bảng đơn sau parse cuộn mượt, hết khựng — subscriber
    `src/main.js` chỉ render lại khi "hình dạng bảng" đổi (`uiRenderer.getOrderTableSignature`), `ui-renderer.js`
    memoize HTML bảng theo cùng signature (render trùng chỉ gán `tbody.innerHTML`, bỏ chạy lại pipeline quà
    `getOrderTableRows`); `style.css` thêm `scrollbar-gutter: stable` vào `.order-split` + `flex-shrink: 0`
    cho `.results-scroll`. Cấm `content-visibility` trên `table-row` (Chromium không hỗ trợ `contain: layout`
    trên `tr` → scrollHeight ước thiếu kẹt cuối bảng).
  - **Fix kéo thả dòng đơn bị "ăn không" sau gate-render (16/9/2026)**: hồi quy đúng 1 ngày sau v1.3.1 —
    `orderTableSignature` ban đầu KHÔNG gồm `rowOrder` (kéo thả dòng chỉ đổi `currentOrder.rowOrder`,
    items giữ nguyên) → subscriber `src/main.js` thấy signature không đổi → skip `renderOrderResults` →
    sau drop bảng không cập nhật thứ tự (Excel vẫn xuất đúng vì export đọc rowOrder — chỉ màn hình
    không nhúc nhích). Fix 1 dòng: thêm `|ro:` (nối `rowOrder`) vào `orderTableSignature` — kéo thả giờ
    làm signature đổi → render lại. Không đụng panel Settings drag (drop self re-render, không qua gate).
  - **Chặn file rác vô hạn khi lên đơn KiotViet (15/9/2026, v1.3.1)**: log console của browser do
    Playwright MCP ghi từng rơi vào `.playwright-mcp/` ngay cwd app (mỗi phiên lên đơn sinh hàng chục
    file `console-*.log`, không cleanup nào). `buildMcpLaunchArgs()` (`browser-agent-ipc.js`) giờ truyền
    `--output-dir` (dồn về `%TEMP%\oa-kiotviet-mcp`) và `--output-max-size` 50MB để MCP tự evict file cũ
    nhất (`_enforceOutputBudget` trong playwright-core) — hết sinh file vô hạn, không cần cleanup riêng.
  - **Đăng ký "chương trình KM dạng text" (14/9/2026, v1.2.0)**: KM khách nhắn dạng text ("tặng nón
    XVIL", "FOC: 1 bình xịt"...) từng bị fuzzy-match đoán mò hoặc rơi vào `__unmatched_gift__` (không
    có kvCode → fail khi lên KiotViet). Mỗi campaign giờ có registry `promoTextRules`: `keywords` (từ
    khóa sales ghi, bỏ dấu cũng khớp, ≥3 ký tự), `unitHint` (tùy chọn — lọc đơn vị quà), `productId`
    (sản phẩm quà chuẩn hóa, chọn từ danh mục có mã KV), `defaultQty`, `global` (áp dụng mọi campaign).
    `db.getPromoTextMatch()` (db.js, cạnh getMKTGifts) match 2 chiều (name chứa keyword / keyword chứa
    name), ưu tiên rule campaign cụ thể > global + keyword dài hơn, bỏ rule trỏ sản phẩm đã xóa;
    `processExplicitGift()` (src/order/calculator.js) resolve qua registry TRƯỚC mọi heuristic/fuzzy →
    mọi đường parse (offline builder, AI actions, headless API) hưởng chung, kèm note "Khớp chương trình
    KM" + `_promoRuleId`. Migration `sanitizeCampaigns` seed field rỗng cho campaign cũ; `addCampaign`
    seed mặc định. Test: `test/promo-text-rules.test.mjs` (13 case — gồm regression rule không-global chỉ
    áp dụng trong campaign của nó; 370 test / 369 pass, 1 skip cũ).
    *(23/9/2026: bỏ UI đăng ký rule — nút "📝 Đăng ký KM" trên bảng đơn, modal `openPromoTextRegisterModal`,
    callback `registerPromoText`, card Settings "Chương trình KM dạng text". Engine nhận diện
    `getPromoTextMatch` và dữ liệu rule đã lưu vẫn giữ nguyên — đơn mới vẫn khớp như cũ.)*
  - **Fix AI nhận nhầm đơn "chain lube max giá 2 thùng" (11/9/2026)** — đơn "ANYWHERE MAN / 2 thùng chain
    lube max giá 2 thùng / TT CK / HĐ" từng ra nhầm bản Chain Lube **trắng** 154k thay vì bản **Max** 158k
    (thiếu 99k/2 thùng), tên khách bị sửa "ANYWAY MAN", mốc giá bị bỏ. 3 tầng nguyên nhân + fix:
    (1) **Alias "chain lube" → bản trắng** (học từ chỉnh tay) nuốt "chain lube max" qua word-boundary 95đ,
    thắng fuzzy bản Max 84đ → thêm alias mặc định phân biệt biến thể `chain lube max/transparent/transperant/
    off road/trắng/trang` (`DEFAULT_ALIASES` db.js) — alias exact 100đ thắng word-boundary 95đ; đã push alias
    lên máy đang chạy qua `POST /api/aliases`. (2) **Prompt AI** (`ai-service.js` `_buildSystemPrompt` +
    `ORDER_SEMANTICS`): "giá N thùng" là priceTierQty của cùng dòng — KHÔNG tách thành item thứ 2/KHÔNG nhân
    đôi qty (ví dụ thẳng chính đơn này); phụ từ trước "giá" (max/transparent...) là một phần tên SP; "TT CK" →
    payment ck; "HĐ"/"hóa đơn"/"VAT" → notes KHÔNG tạo item; tên khách copy NGUYÊN VĂN kể cả ALL-CAPS tiếng Anh;
    AI-FINAL thêm rule biến thể (phụ từ sales ghi phải có mặt trong tên SP được chọn). (3) **Sanitizer**
    (`note-sanitizer.js`): lọc item "ma" chỉ gồm token meta (HĐ/TT CK/VAT...) + tách phần tử notes chứa "\n"
    (model nhét "TÊN KHÁCH\nHĐ" vào một chuỗi). (4) **Structured output cho provider local/custom**
    (`ai-service.js`): registry `structuredOutput` = null (lmstudio/ollama/custom) trước đây không ép JSON
    gì cả → giờ THỬ `json_schema` strict, server/model không hỗ trợ (400/422) tự bỏ ép gửi lại — model nhỏ
    local không thể sai format. Verify live: offline + AI (qwen3-vl-8b local) đều ra đúng
    Max 8230005-1 @158k mốc ≥2, tổng 3.792.000; "chain lube" thường vẫn ra bản trắng. Test:
    `test/parser.test.js` (đơn gốc offline), `test/matching-golden.test.mjs` (alias exact vs word-boundary),
    `test/note-sanitizer.test.mjs` (item ma + notes \n).
  - **Bộ chọn quà FOC gõ-để-tìm ở tab Danh Mục (07/9/2026)**: ô "Cùng loại/Sản phẩm tặng" trong dòng
    FOC thay select thường bằng picker gõ-tìm (bấm mở list + lọc fuzzy) — tái dùng `buildFocGiftPickerHtml`
    của Settings Editor (thêm `opts`: sameLabel/hiddenClass/hiddenAttrs/width/inputStyle), select ẩn giữ
    class `catalog-foc-input` để luồng lưu cũ nguyên vẹn; wiring mới trong `src/catalog/delegation.js`
    (focusin mở list, input lọc `fuzzySearchScore`, mousedown chọn + phát change, focusout hoàn tên).
    Kèm nút **▲/▼ đảo thứ tự dòng FOC & quà MKT** trong card (≥2 dòng mới hiện, disable ở mép; swap
    mảng + `refreshCatalog()` giữ scrollTop — thứ tự chỉ để nhìn, calculator không phụ thuộc).
    **Fix thanh tổng kết mất sticky (07/9/2026)**: class `is-dragging` (kéo sắp xếp dòng đơn) từng kẹt
    vĩnh viễn do `dragend` không bubble sau khi drop re-render detach dòng nguồn → `.order-results`
    thành `overflow: hidden` (scroll container giả) → `#orderSummary` + thead bám nhầm. Sửa 3 lớp:
    `clearDragState()` gọi trong cả `drop` lẫn `dragend`, tự chữa gỡ class ở đầu `renderOrderResults`,
    CSS `.order-results.is-dragging` đổi `hidden` → `clip` (clip không tạo scroll container).
    **Header modal KiotViet sticky (07/9/2026)**: tiêu đề + nút "✕ Đóng" dính mép trên khi cuộn
    (`.kv-modal-content > .card-header` sticky, `padding-top: 0` trên container — sticky hỏng nếu
    phần tử nằm ngoài containing block). Fix theo dõi (11/9/2026): thead `kv-preview-table` kế thừa
    rule chung `.order-table thead th` (sticky, z-index 10) đè che header modal (z-index 5) khi cuộn
    → override `.kv-modal-content .kv-preview-table thead th { position: static }` (style.css,
    thead chỉ cần sticky ở trang chính)
  - **Copy phiếu theo hiện trạng bảng (09/9/2026)**: nút Copy (`copySummary` trong `src/order/actions.js`)
    copy phiếu giao hàng từ `getOrderTableRows(currentOrder)` — cùng nguồn với bảng render, KHÔNG rescan
    tin nhắn (luôn theo đơn đang chỉnh sửa, không quay lại kết quả phân tích). Nhãn quà theo toggle
    FOC↔EXTRA hiện tại (`giftKind`, nguồn KM FOC/KM MKT chuyển vào ghi chú); dòng hàng tặng 0đ
    (`isGift` hoặc subtotal 0, cả matched lẫn unmatched) in `🎁 TẶNG [FOC/EXTRA]` thay vì hàng mua giá 0đ.
  - **Đơn chờ duyệt TỰ ĐỘNG LƯU + xử lý trực tiếp trên card** (`src/order/pending.js`, cập nhật 25/9/2026):
    mọi đơn đang soạn (≥1 SP hoặc nháp text chưa parse) auto-save vào envelope `order_automation_pending_state_v2`
    (atomic pending + processed) trong IndexedDB/localStorage theo debounce 2s; nút Lưu tay lưu ngay + toast + verify.
    Đóng/mở lại app không làm mất record; lỗi đọc storage sẽ chặn mọi ghi pending để không đè dữ liệu cũ bằng mảng rỗng.
    Card có nút **Xuất Excel** và **Lên KiotViet** khi bước chưa xong: Excel xuất thẳng snapshot đúng record;
    KiotViet mở modal preview/tùy chọn đúng record rồi user bấm Bắt đầu (không auto-submit). `src/main.js` inject hai
    action để tránh circular import. `exportToExcel(context)` và `KiotVietAutomation.openPanelForOrder(snapshot)`
    deep-clone order trước `getOrderTableRows`, không đọc/mutate đơn đang mở; có lock chống chạy trùng. Excel dùng
    `buildExcelExportPlan()` chung; KiotViet stage `orderData + pendingId + expectedSignature` từ preview đến run,
    terminal event có `runId` để event cũ không chạm run mới. `markDone(id, source, expectedSignature)` chỉ bật chip
    khi thành công và record chưa đổi; chip xanh bị disable. Sau flow, danh sách mở lại; với KV chỉ mở lại sau khi modal
    thực sự đóng để không chồng focus trap. Dù cả hai bước xong, record vẫn ở "Chờ duyệt"; chỉ **Hoàn tất** hoặc **Xóa**
    mới rút record. Sửa nội dung record sẽ reset `excelDone/kvDone=false`. Sau khi rút, auto-save chặn hồi sinh theo
    signature; nội dung thật sự đổi thì tạo bản ghi mới. Hoàn tất/Mở lại ghi atomic; mutation lỗi rollback memory.
    Test: `test/pending-orders.test.mjs`, `test/pending-direct-export.test.mjs`, `test/kv-pending-direct.test.mjs`.
  - **Parse SONG SONG nhiều đơn** (`src/order/parse-queue.js` + `parse-pipeline.js` + `parse-apply.js`, thêm 22/9/2026):
    bấm "Phân tích" XẾP HÀNG task parse nền (không chờ tại chỗ) — dán liên tiếp nhiều đơn, N đơn (mặc định 2,
    chỉnh 1–5 trong Cài đặt → AI, localStorage `parse_queue_concurrency`) được AI phân tích CÙNG LÚC. Pipeline
    parse thuần tách từ `actions.js` sang `parse-pipeline.js` (inject `{db, aiService}`, không UI) — parse thường
    và song song chung 1 code path nên chất lượng đồng nhất 100% (sanitize, extraction-repair, brand-context
    2-pass, AI-FINAL, price-guard, học alias). Đơn xong (cập nhật 22/9/v1.5.2): đơn DUY NHẤT trong hàng đợi →
    LUÔN tự hiện lên màn hình (kể cả ô tin nhắn đã bị sửa/trống trong lúc chờ — không rót âm thầm vào danh sách);
    có đơn khác đang chờ/chạy → hiện trên màn hình nếu ô tin nhắn còn nguyên text và không có task mới hơn;
    đang MỞ một bản ghi chờ duyệt khác → không giật màn hình, đổ thẳng vào Đơn chờ duyệt qua
    `pending.createPendingFromOrder()` (dedup rawChatText, nạp đè bản nháp 📝; KHÔNG đụng `_pendingId` của store).
    Đơn lên màn hình được lưu vào Đơn chờ duyệt NGAY (autoSaveNow flush, không chờ debounce 2s). LỖI RENDER sau
    khi parse thành công (renderer/DOM nổ) → KHÔNG vứt kết quả: tự đổ về chờ duyệt + toast cảnh báo. Quá hạn mức →
    task chờ trong hàng đợi, tự chạy tiếp
    khi có slot (đặt 1 = tuần tự). Bấm Phân tích có toast xác nhận; task ✅ giữ trên dải 6s rồi tự ẩn. UI: dải
    `#parseQueueStrip` dưới nút Phân tích + mục "Đang phân tích" trên đầu danh sách Chờ duyệt; lỗi → task ❌ +
    Thử lại (giữ text gốc); hủy từng task / Hủy tất cả qua AbortSignal. Không profile AI → tự rơi parser offline
    như cũ. Test: `test/parse-queue.test.mjs` (12 case)
  - **ui-renderer.js import `db` tường minh** (22/9/2026): file legacy từng dùng ẩn ~20 chỗ global `window.db`
    (db.js tự gán) — chỉ sống trong trình duyệt; thêm `import { db } from './db.js'` để không còn văng
    "db is not defined" trong ngữ cảnh không có global (Node test, render nền). Lỗi thật đã bắt được qua
    diagnostic: task parse thành công vẫn ❌ "db is not defined" → kết quả bị vứt (mà tests cũ không phát hiện
    vì đã monkey-patch renderAIDetection).
  - **TLN coverage check** (`src/order/tln-coverage.mjs`): kiểm tra bản chia dòng của AI phủ đủ nội dung dán không,
    kèm fallback tách dòng theo quy tắc cục bộ — không bao giờ mất thông tin
  - **AI diagnose lỗi xuất Excel** (`src/order/export.js`): không tìm thấy file template → AI phân tích cấu trúc thư mục,
    đề xuất use_file/rename_file, tự xuất lại
  - **Quy ước chiều cao dòng Excel** (`normalize_item_row_heights` trong `excel_automation.py`): mọi dòng bảng SP một
    chiều cao cố định theo template; chỉ giãn dòng nào tên SP dài vượt bề rộng merge
  - **Confirm dialog + focus trap** (`src/ui/confirm-dialog.js`) thay `window.confirm()`; dialog kết quả xuất Excel
    theo từng hãng (non-blocking, thay `alert()`)
  - **Lên đơn KiotViet 2 chế độ + verify DOM** (8/2026, `browser-agent.js` + `src/kiotviet/automation.js`):
    pre-flight probe tái dụng POS đang mở (không reload); chế độ *giỏ mới* (mặc định) tự bấm "+" mở giỏ sạch khi
    giỏ active có hàng (giỏ cũ giữ nguyên); chế độ *bổ sung* (checkbox "Bổ sung giỏ đang mở") quét từng dòng giỏ
    (`note-cartitem-N`, khớp mã KV nguyên token) → đủ SL bỏ qua / lệch SL sửa đúng dòng / thiếu thêm mới;
    VERIFY đọc lại giỏ đối chiếu mã+SL+giá và **gate auto-submit** (`fillVerifyBlocked`: SP thất bại / lệch / không đọc được kết quả fill → KHÔNG tự bấm Đặt hàng, log ⛔ + toast lỗi, event `verifyBlocked`; 9/2026); bắt mã đơn `DHxxxxxx` sau Đặt hàng tự động; tự gỡ overlay intro.js.
    Test hành vi qua mock KV POS + Electron harness (`test/browser-agent.test.js`) — 0 AI call, 0 vision.
  - **Fix quà MKT thương hiệu sinh ảo (8/2026)**: hàng tặng (item `isGift`) không còn bị cộng vào
    `campaignTotals` khi xét mốc quà MKT trong `ui-renderer.getOrderTableRows()` (trước đây 1 thảm quà
    box_size=1 bị tính 1 thùng → đơn 1 thùng đạt mốc "2 thùng" → sinh bình xịt lên KV);
    `db.getMKTGifts()` làm tròn xuống thùng nguyên cho mốc `unit:"boxes"` (đơn 2 thùng + chai lẻ vẫn
    đạt mốc 2, không rơi hổng giữa 2 mốc); `mkt_gift_rules` XVIL chuẩn hóa sang `gift_items` có
    `product_id` (mốc 1 thùng dùng `give_product_options` chọn túi canvas/nón) — đồng nhất với Zentor.
    Regression: `test/mkt-gifts.test.mjs`.
  - **Fix sai brand khi trùng tên gọi + mất tên khách đầu số (8/2026)**: đơn "7C motor — 2 chai
    Fork 10 giá 228k" từng ra nhầm Xvil Fork 10 (173k) thay vì Zentor GP Fork Oil 10W (228k
    khớp giá). `parser.findBestProductMatch` nhận thêm `priceHint` (tham số 5) theo cơ chế
    **"gần giá nào chọn giá đấy"**: giá khớp gần chính xác giá list (≤2%, so cả mốc chai lẫn
    thùng) → +45 gần-quyết định; lệch xa dần trừ dần tới −15 (helper `priceHintMatches` dùng cho
    Price-Guard với ngữ nghĩa khớp chính xác); không có giá sales → xếp hạng theo tên như cũ.
    `actions.js` lưu `explicitPrice` thô trên item, truyền giá vào mọi lượt match, có bước
    **Price-Guard** cuối flow — giá lệch rõ + tồn tại SP khác khớp ĐÚNG giá (score ≥60) → tự đổi
    SP (`matchVia:'price-fix'`, KHÔNG đụng dòng khớp alias/kvcode); shortlist gửi AI phân xử có
    thêm giá list + giá sales, prompt có rule chọn theo giá. Tên khách bắt đầu bằng số
    ("7C motor") giờ được nhận ở fallback dòng đầu của `parseOrderText` (chặn mảnh số lượng/giá).
    **Đổi tên SP qua UI tự sinh alias tên cũ** (`src/product-edit.js` → `db.addAlias`, kết quả
    `result.aliasAdded`, không cướp alias của SP khác) — alias ưu tiên cao nhất sau mã KV.
    **Sửa tay SP sai trên bảng đơn tự học alias** (`changeRowProduct`: correction hoặc dòng
    yếu/chưa khớp → học "tên sales gõ" từ `rawProduct` lẫn `rawName` → SP user chọn, toast ↩
    hoàn tác) — lần parse sau tên đó ra đúng SP không cần giá. Test:
    `test/price-disambiguation.test.mjs`, `test/product-edit.test.mjs`,
    `test/correction-learning.test.mjs`.
  - **Fix unit hint lật ngược match tên (04/9/2026)** — mặt trái của cơ chế unit
    bonus ở bullet trên: đơn "989 Workhop" — "1 chai Fork 10 giá thùng" (KHÔNG có giá sales)
    khớp đủ từ khóa tên "Xvil Fork 10" (100đ) nhưng bị phạt unit −20 vì packaging "6 bình x 1
    lít" nằm trong soft-conflict 'bình' → rơi 80đ, còn "Zentor Topgear GP Fork Oil 10W"
    (76đ) được cộng +15 unit chai → 91 lật kèo thắng sai (sai brand, sai kvCode 8230016 vs
    800213, chênh 58k). 2 thay đổi trong `parser.js`: (1) bonus/penalty đơn vị chỉ áp cho ứng
    viên <100 điểm — match đủ từ khóa tên là ứng viên trừ khi sales ghi giá (priceHint vẫn
    thắng tất cả); (2) 'bình' gỡ khỏi `SOFT_CONFLICT_HEAVY` (thương mại VN "bình" ≡ "chai" —
    chính catalog Zentor ghi "(1L/bình)" cho SP unit=chai). Test:
    `test/matching-golden.test.mjs` (case "989 Workhop").
  - **Fix đơn "Nam Thành": SP chính thành quà + Veltron nhầm quy cách (04/9/2026)** — đơn
    "1 can Prostream TT 10W50 20L tặng thêm 6 chai Veltron Engine cleaner": (a) chữ "thêm/kèm
    (theo)" chen giữa keyword và số lượng làm gãy `qtyPatternStart`, `giftRegex` lẫn guard
    ranh giới tách multi-SP (trước đây chỉ khớp "tặng" đứng ngay trước số) → đuôi "tặng thêm"
    dính vào segment SP trước, `isGift` test TOÀN bộ segment nên SP chính thành hàng tặng giá 0
    (giờ khối standalone-FOC chuyển xuống sau khối quà tường minh và chỉ áp khi KHÔNG có
    `explicitGift`); dòng quà rời lẻ ("tặng thêm 6 chai X") qua nhánh midQty từng bị vứt marker
    → giờ bóc marker khỏi prefix, đặt `isGift=true`, phần prefix còn lại vẫn là tên khách.
    (b) Unit hint phân xử 2 SP trùng tên khác quy cách: bonus tầng hóa +15 (unit bán) / +10
    (spec) / +5 (packaging — pack "12 chai/thùng" là tín hiệu yếu: 2 bản Veltron Engine Cleaner
    cùng pack từng hòa 107-107, tie-break theo catalog chọn nhầm bản 0,1L/bình) và thêm NGOẠI
    LỆ duy nhất cho alias: sales đòi đơn vị khác đơn vị bán của SP alias (`wantsOtherUnit`) →
    fuzzy có unit bonus lật alias nếu khớp tên ≥ điểm alias (`via: 'fuzzy-unit-over-alias'`).
    (c) `processExplicitGift` truyền unit hint vào `findBestProductMatch` + cùng-campaign chỉ
    thắng khi điểm không thua match toàn cục (trước đây quà brand khác bị nuốt bởi fuzzy trong
    campaign mẹ → "Veltron Engine cleaner" ra nhầm Zentor Radiator Cleaner). Kết quả: "6 chai
    Veltron Engine cleaner" → đúng VELTRON Professional (unit chai). AI prompt thêm ví dụ quy
    tắc "tặng thêm N <SP>" (dòng chính `isGift=false` + `explicitGift`). Test:
    `test/parser.test.js` + `test/price-disambiguation.test.mjs` (321/321 pass).
  - **Xuất mã nguồn bàn giao (04/9/2026)**: `scripts/package-source.js` viết lại — danh sách
    file lấy từ `git ls-files` (bản cũ quản tay từng file, dễ sót khi repo thêm file mới);
    chặn phòng thủ node_modules/.env/dist/build output/backup; cảnh báo khi working tree còn
    thay đổi chưa commit; ghi `MANIFEST.txt` (version, commit, ngày xuất, hướng dẫn chạy máy
    mới); zip vào folder riêng `Mã nguồn bàn giao/` với tên ASCII chứa version+ngày+git-sha
    (PowerShell Compress-Archive, fallback tar.exe đường dẫn tương đối). 1-click:
    `Xuat Ma Nguon.bat` / `npm run package:source`. Dữ liệu kinh doanh (`I.ĐƠN HÀNG/`,
    `Bảng giá/`), `.env`, `ORIGINAL_REQUEST.md` và bản EXE không nằm trong zip — bàn giao
    riêng. Xem README mục 7.10.
  - **Môi trường test cách ly (04/9/2026)**: `main.js` nhận 2 biến môi trường khi khởi động —
    `OA_USER_DATA` (chỉ `app.setPath('userData')` TRƯỚC `requestSingleInstanceLock` vì lock
    scope theo userData) + `OA_MCP_PORT` (port MCP riêng) → chạy song song với bản chính mà
    không đụng IndexedDB/token/port; instance nạp catalog mặc định từ `default-db.json`
    (không AI config → parse offline deterministic; muốn test pipeline AI thì tạo profile qua
    tool `manage_ai_profiles` rồi gọi `parse_order` với `mode:"ai"`). Cách test MCP y hệt agent ngoài:
    `OA_USER_DATA=... OA_MCP_PORT=18048 npx electron .` rồi gọi tool qua `http://127.0.0.1:18048/mcp`.
    Xem README mục 7.8, docs/MCP.md mục 3.
  - **Fix delay sửa đơn giá về 0 / badge FOC-EXTRA hiện chậm (04/9/2026)**: `updateDualPriceLive` từng chạy
    `snapshotGiftStructure` ×2 mỗi phím gõ vào ô giá (mỗi lượt = trọn pipeline `getOrderTableRows` ~440 dòng)
    và re-render toàn bảng ngay khi mốc quà MKT rớt → giật, mất focus giữa chừng; đơn không rớt mốc thì ngược
    lại — không render nào cả nên badge FOC/EXTRA của hàng giá 0 không bao giờ hiện. Tách 2 pha trong
    `src/order/actions.js`: đang gõ (`input`) → `updateDualPriceLive` bản light (targeted update ô thành tiền +
    `refreshOrderSummary`, KHÔNG `setState`); commit (`change` — blur/Enter) → `commitDualPrice` mới:
    `setState` đúng 1 lần → một full rebuild duy nhất (quà MKT chuẩn + badge hiện ngay).
    `ui-renderer.js` đổi delegate `change` giá chai/thùng sang `commitDualPrice` và thêm
    `getTableFocusRestoreSelector` / `scheduleTableFocusRestore` khôi phục focus vào node mới sau rebuild
    (rAF đăng ký sau rAF render của `store.notify` nên chắc chắn chạy sau render). Verify thực tế trên bản
    build: gõ giá về 0 không giật không mất focus, commit 1 lần badge FOC hiện ngay, sửa giá về lại số dương
    thì badge gỡ + mốc quà quay lại; 312/312 test pass.
  - **Fix lỗi font tiếng Việt trên đường API (04/9/2026)** — user báo agent ngoài gửi đơn qua
    API lên KV bị lỗi font. 3 điểm sửa: (1) `api-server.js readBody()` gom Buffer rồi
    `Buffer.concat().toString('utf8')` MỘT lần — trước đây `data += chunk` decode từng chunk,
    ký tự TV 2-3 byte bị TCP cắt giữa chunk vỡ thành U+FFFD NGAY TỪ CỬA VÀO (hỏng lan
    parse/GUI/KV/Excel); (2) `mcp-client.js _onData()` cùng bug trên stdout MCP — giữ Buffer,
    chỉ decode trên ranh giới message hoàn chỉnh (ndjson + Content-Length framing) — trước
    đây hỏng đường đọc verify (mã đơn, snapshot giỏ); (3) `repairMojibake()` tự vá tại cửa API
    cho agent ngoài encode SAI kiểu UTF-8-decode-nhầm-Latin1 ("HĐ cập nhật" thành
    "HÄ‘ cáº­p nháº­t") — áp vào `text` của parse/parse-offline/auto-run và toàn bộ trường text
    của run-kiotviet-order/export-excel (`repairOrderTextEncoding`). Cứng hóa thêm:
    `_buildDirectFillScript` escape `` ` ``/`${` cho payload (tên khách chứa ký tự đặc biệt
    không còn vỡ script); Excel truyền `--customer/--title` qua file tạm `--meta` UTF-8 thay
    vì argv (nhất quán tlnText; `excel_automation.py` ưu tiên meta file). Trang KV nhập bằng
    native value setter không gõ phím nên an toàn Unicode sẵn. Test: `test/api-server.test.js`
    (chunk 1 byte cắt giữa ký tự TV, mojibake round-trip), `test/browser-agent-ipc.test.js`
    (ndjson + Content-Length cắt giữa ký tự TV).
  - **Fix ghi rõ "off road" vẫn bị đẩy sang Chain Lube bản trắng (24/9/2026)**: 3 dạng tin thật đều
    match nhầm bản trắng 154k dù sales ghi "off road": (a) thứ tự đảo "off road chain lube zentor",
    (b) dính phẩy "chain lube, loại off road, zentor" (sai ở cả offline lẫn AI mode), (c) multiline
    offline "2 thùng chain lube" + "off road zentor" (vế sau rơi vào notes). Nguyên nhân: alias match
    so chuỗi LIÊN TỤC theo thứ tự từ — cụm đảo thứ tự/dính phẩy không khớp alias "chain lube off road"
    nhưng vẫn khớp trọn alias trần "chain lube" (correction-learning học về bản trắng) → 95–100đ thắng
    tuyệt đối, qualifier "off road" thành token thừa. Sửa: (1) `parser.js` thêm `OFF_ROAD_RE` + hard
    filter qualifier trong `hasAttributeConflict` — input có "off road"/"offroad" mà SP không có →
    score 0, áp cho alias guard + fuzzy + `findTopProductMatches`; `buildShortlist` guard nguồn alias +
    brand family (bản trắng không lọt shortlist AI-FINAL); (2) `parseOrderText` merge dòng continuation —
    dòng không có qty ngay sau dòng SP, mọi từ có nghĩa đều nằm trong tên SP match được từ merged text
    → gộp (điều kiện từ vựng chặn ghi chú thật bị nuốt: "Ghi chú thêm gì đó" không thuộc tên SP nào →
    giữ nguyên ignored). Không hồi quy: "chain lube" thuần → bản trắng 100đ, đúng thứ tự vẫn Off Road,
    Xvil Chain Road không bị qualifier chặn. Deploy: `npm run build:renderer` + `npm run build:dir` →
    thay `app.asar` cài đặt (backup `app.asar.bak-pre-offroad`), restart app. Test mới:
    `test/offroad-qualifier.test.mjs` (12 assertions); `npm test` 481 pass/0 fail (1 skip excel_smoke
    theo môi trường); re-verify MCP live 6/6 case (đảo thứ tự, phẩy, multiline, thuần, đúng thứ tự,
    ghi chú giữ nguyên).
  - **Fix dòng hàng dính ký tự rác sau số lượng bị nuốt + "thùng" lật alias nhầm brand (22/9/2026)**:
    đơn "Anywhere Man" — dòng "1' thùng Chain Lube Offroad" (dấu nháy dính khi copy tin nhắn điện
    thoại) làm gãy TOÀN BỘ regex qty+unit của `parseOrderText` (chỉ chấp nhận khoảng trắng giữa số
    và đơn vị) → dòng không được coi là dòng hàng, trôi vào ghi chú, MẤT KHỎI ĐƠN. 3 tầng sửa:
    (A) `stripQtyJunk()` (parser.js, export mới) gỡ họ dấu nháy/quote (`' ' ´ \` " “ ”`) đứng giữa
    số và đơn vị, chạy ngay sau `normalizeVietnameseQty` trước mọi pattern — phủ chung offline,
    AI-local, auto-rescan, worker, MCP; `extraction-repair.js` (`isQtyLine`/`parseLineQty`/
    `qtyLinesOf`/`splitQtySegments`) và `ai-service.js countQtyLines` đồng bộ dùng luôn để nhánh
    tự vá dòng sót của AI cũng "thấy" dòng bẩn. KHÔNG đụng dấu thập phân ("1.5 thùng" giữ nguyên).
    (B) Lưới an toàn cuối `parseOrderText`: dòng vẫn còn cụm số + từ đơn vị sau khi mọi pattern
    gãy (ký tự lạ khác) → đẩy thành dòng UNMATCHED (vàng) thay vì ignored — sales thấy và sửa
    tay, không mất lặng lẽ. (C) `findBestProductMatch`: hint "thùng" (`BULK_HINT_UNITS`) không còn
    kích hoạt `wantsOtherUnit` — thùng là quy đổi số lượng của CHÍNH SP đó (kvCodeThùng = mã gốc
    + "-1"), không phải đòi quy cách khác; trước đây hint "thùng" ≠ unit SP "chai" nhả alias cho
    fuzzy, input generic 2 từ ("chain cleaner") hòa 100-100 với SP khác brand (brand "xvil" nằm
    trong IGNORE_TOKENS được miễn phạt từ thừa, đuôi "0,75L/bình" normalize thành "075lbinh" bắt
    đầu bằng số cũng bị bỏ qua) rồi tie-break "ít từ hơn thắng" → chọn NHẦM Xvil Chain Cleaner
    91k thay vì bản Zentor của alias — match 100 điểm "tự tin", không báo nghi vấn. Test:
    `test/parser.test.js` (2 describe mới: ký tự rác + unit thùng giữ alias),
    `test/matching-golden.test.mjs` (Golden 09/25). 449/450 test pass (1 skip excel_smoke theo
    môi trường).
  - **Fix dòng "Giá 2 thùng" đứng riêng: sinh item ma + không item nào được áp mốc (22/9/2026)**:
    đơn Anywhere Man khai mốc giá bằng dòng riêng "Giá 2 thùng" — parser nhặt thành dòng hàng
    (qty=2, tên "Giá") rồi match nhầm "Zentor Poster Pricelist" 75đ (item ma 0đ), và KHÔNG item
    nào được áp mốc ≥2 (Chain Cleaner 1 thùng đứng 141k thay vì 131k; mốc chỉ hoạt động khi viết
    chung dòng SP). Sửa: (1) `parser.js` thêm `isStandaloneTierLine()` + type dòng `tier-override`
    — dòng mốc giá standalone ("Giá 2 thùng"/"giá thùng"=1/"áp giá 3 thùng") không còn vào pipeline
    hàng; (2) `buildOrderFromText` đọc mốc toàn đơn và áp cho mọi item KHÔNG có giá tường minh,
    KHÔNG có mốc riêng trên dòng, KHÔNG phải hàng tặng (`effectiveTierQty` — mốc riêng/giá riêng
    vẫn thắng); (3) nhánh AI: prompt + ORDER_SEMANTICS quy định gặp dòng mốc đứng riêng → đặt
    `priceTierQty=N` cho mọi item chưa có giá, KHÔNG tạo item; `extraction-repair` (qtyLinesOf/
    splitQtySegments) lọc dòng này khỏi danh sách dòng SP thiếu; (4) preview hiển thị "💵 Áp mốc
    giá N thùng cho toàn đơn". Test: `test/order-tier-override.test.mjs` (đơn Anywhere Man: Max
    158k, Off Road 1 thùng 158k, Cleaner 131k, hết item ma; giá tường minh/mốc riêng không bị đè)
    + case trong parser.test.js/extraction-repair.test.mjs. **Bổ sung cùng ngày — đường AI áp mốc
    bằng CODE, không phụ thuộc model**: user báo CHẾ ĐỘ AI không nhận mốc; ban đầu chỉ thêm luật
    prompt/ORDER_SEMANTICS (model tự đặt priceTierQty cho từng item) — không đủ bảo đảm vì model
    có thể lơ rule. `parse-pipeline.js` giờ TỰ quét dòng mốc trong text thô
    (`standaloneTierQty` + `stripQtyJunk`) → áp `orderTierQty` cho item thiếu mốc/giá (giá tường
    minh + hàng tặng không bị đè), và BỎ item ma "Giá" do model nhặt (filter
    `isStandaloneTierLine` trên `parsedJson.items` sau repair, trước khi chấm điểm campaign).
    Rule prompt hạ xuống lớp phụ trợ. Test: 3 case `runParsePipeline` trong
    `test/order-tier-override.test.mjs` (model lơ rule + nhặt item ma → vẫn đúng 155/155/131k).
  - **Fix thanh tổng kết không dính khi cuộn (28/8/2026)**: `contain: layout style` từng bị thêm vào
    `.order-results` trong `style.css` → biến nó thành containing block của `position: sticky`, làm cả
    thanh tổng kết (`#orderSummary`, sticky bottom) lẫn tiêu đề bảng (`thead th`, sticky top) trôi theo
    trang khi cuộn. Đã gỡ containment — `.order-results` phải giữ `overflow: visible`, không thêm lại
    `contain: layout` (xem README mục 6, quy tắc 13).
  - **Fix label modal KiotViet vỡ chữ dọc (28/8/2026)**: 3 checkbox tùy chọn (Bổ sung giỏ đang mở /
    AI Verify / Lưu PDF) + nhãn AI Provider + select bị nhồi chung 1 hàng flex không wrap, select
    chiếm gần hết bề rộng → label bị co ép còn vài ký tự, chữ rơi thành cột dọc. Đã sửa trong
    `style.css`: cho nhóm tùy chọn wrap theo cụm nguyên vẹn (`.kv-control-row .kv-control-group.flex-1`
    có `flex-wrap`), khóa co ép label (`flex-shrink: 0` + `white-space: nowrap` trên title/hint),
    giới hạn `select.ai-provider-select` 320px.
  - **Hiển thị phiên bản app + quy trình phát hành qua file cài (31/8/2026)**: sidebar footer thêm
    dòng "Phiên bản vX.Y.Z" (IPC `app:get-version` → `preload.getAppVersion()` → `#sidebarAppVersion`,
    ẩn khi thu gọn sidebar). Cập nhật cho máy khác = gửi file `Lên đơn hàng Setup <version>.exe`
    (NSIS tự nâng cấp đè bản cũ, giữ nguyên dữ liệu IndexedDB + `I.ĐƠN HÀNG` + config) — KHÔNG có
    auto-update/electron-updater. Checklist phát hành: README mục 7.7 (bump `version` trong
    `package.json` → `npm run build` → gửi file Setup → ghi changelog).
  - **Gỡ bỏ hoàn toàn tính năng chuyển đổi kho / Warehouse Rules (9/2026)**: Xóa bỏ thẻ UI `<details id="kvWarehouseConfig">` trong `index.html`, toàn bộ CSS `.kv-warehouse-*` / `.kv-wh-*` trong `style.css`, logic `loadWarehouseRules` / `renderWarehouseRules` / `toggleWarehouseRule` trong `app.js`, cùng 2 IPC channel `config:get-warehouse-rules` / `config:set-warehouse-rules` trong `preload.js` và `main.js`.
  - **Nâng cấp Cấu hình AI — dễ cấu hình + fix dropdown KV (06/9/2026)**: form AI profile (Cài đặt → AI)
    có datalist gợi ý model (registry `models` trong `ai-providers.mjs`; bấm "Test Kết Nối" nạp thêm model
    thật từ `/v1/models` — `testProfile` trả `models` sẵn), link "Lấy API key" theo provider (`keyUrl`),
    nút "🔌 Test tất cả" test tuần tự từng profile đang bật; dòng AI dưới sidebar click mở thẳng Cài đặt → AI.
    Fix dropdown "AI Provider" modal KiotViet vô tác dụng: `automation.js startOrder` đọc `selectedValue`
    nhưng không truyền vào `runOrder` → AI Verify luôn chạy LM Studio; giờ `_resolveKvAiConfig()` dựng
    `aiConfig` từ profile được chọn (fallback: config phân tích khi chưa có profile) truyền qua
    `options.aiConfig` → `browser-agent.js` `_callAI` (bổ sung nhánh Anthropic Messages API). Bỏ option ma
    "Gemini Flash (Proxy 8045)". Model mặc định làm mới theo catalog 9/2026 (đối chiếu docs chính thức):
    OpenAI `gpt-5.6-luna`, Claude `claude-sonnet-5`, Z.AI `glm-4.7-flash`; Gemini giữ `gemini-2.5-flash`
    (vẫn được hỗ trợ), Qwen giữ `qwen3.7-plus` (endpoint MaaS riêng) — chỉ ảnh hưởng profile mới, không tự
    lật model profile hiện có. `/api/status` trả `apiVersion 2.1.0` khớp `/api/agent-info`. 320/320 test.
  - **AI Profiles API — agent ngoài tự cấu hình + chẩn đoán AI (phát hành v1.0.8, 08/09/2026)**: trước đây `/api/parse`
    fallback offline ÂM THẦM khi không có AI profile bật (môi trường test cách ly `OA_USER_DATA` riêng
    không kế thừa `app-config.json` của app thật) và không có endpoint nào đọc trạng thái/test/ghi AI
    profile → agent không thể biết vì sao "phân tích AI không chạy". Bổ sung 3 endpoint trong
    `api-server.js` gọi method mới của `window.__ORDER_API__` (`src/api/headless.js`):
    `GET /api/ai/status` (profiles/strategy/activeId, key mask còn `hasKey`/`keyError`), `POST /api/ai/test`
    (test 1 theo id hoặc tất cả enabled, tái dùng `aiService.testProfile`), `POST /api/ai-profiles`
    (upsert/xóa + strategy/activeId; apiKey thiếu = GIỮ key cũ, `clearKey:true` mới xóa; validate
    provider theo registry `ai-providers.mjs`; lưu qua IPC `config:set-ai-profiles` → main mã hóa
    safeStorage như GUI). `POST /api/parse` nhận thêm `mode: ai|offline|auto` — `ai` ép pipeline,
    lỗi trả rõ ràng không fallback; mọi fallback kèm `fallbackReason` (`no_enabled_profile` /
    `ai_error: ...`). Bất biến: API key không bao giờ xuất hiện trong response. apiVersion 2.2.0
    (`agent-info` + `/api/status` + `HeadlessOrderAPI.version`), `capabilities.aiConfig: true`,
    catalog/404/listen-log liệt kê endpoint mới. Test route + gate: `test/api-server.test.js`.
  - **Browser API + AI Activity Feed (phát hành v1.0.8, 08/09/2026)**: cho AI agent ngoài (1) đọc/thao tác chính trình
    duyệt Chrome-KV mà app kết nối qua Playwright MCP — không extension, không computer-use — qua 3
    endpoint trong `api-server.js` gọi thẳng `getAgent()` từ main: `GET /api/browser/tools` (discovery
    tool), `GET /api/browser/snapshot` (cây accessibility kèm `ref` cho click/type), `POST /api/browser/execute`
    (pass-through mọi tool `browser_*`; validate prefix; 409 `TASK_RUNNING` khi `agent._running` để không
    phá pipeline lên đơn; response `{text, images[]}` — ảnh base64 giữ lại nhờ method mới
    `executeActionRaw` trong `browser-agent.js`, vì `executeAction` cũ dùng `extractText` làm mất ảnh);
    (2) thấy được trên UI mọi thao tác của agent: panel console **"Hoạt Động AI"** (`<details
    id="aiActivityPanel">` trong `index.html` sau `#persistErrorBanner`, ẩn mặc định, tự mở ở hoạt động
    đầu tiên, badge chưa đọc + dot nhấp nháy khi đang thao tác, giữ 300 dòng) — data từ intercept tại
    `sendJson` (`_maybeEmitApiActivity`: mọi POST + mọi lỗi 4xx/5xx + GET ngoài nhóm quiet paths
    `/`,`agent-info`,`status`,`run-status`,`db-info` để không spam poll; handler gán
    `res.__activityLabel` cho nhãn động như "Trình duyệt: browser_click") → IPC channel `agent-activity`
    (whitelist `AGENT_EVENT_CHANNELS` trong `preload.js` — bất biến #4) → `src/ui/agent-activity.js`
    render nhãn tiếng Việt theo path. **Nút phải trên summary là nút kép (11/09/2026)**: AI rảnh →
    "Xóa" dọn log + ẨN luôn panel (`display:none` + `open=false` + `_userToggled` → hoạt động sau
    hiện lại gập kèm badge); AI đang thao tác (activity ≤5s hoặc poll `status()` 2s) → "Ngắt" gọi
    `browserAgent.abort()`, lần 2/6s chưa dừng → `reset()` (giống 2-bước nút Dừng modal KV).
    apiVersion 2.3.0, `capabilities.browserControl: true`.
  - **Cơ chế priceVersion + seed bảng giá cho máy cũ (06/09/2026)**: `DEFAULT_DB` khai báo trường
    `priceVersion` (VD "2026.09"). `ProductDatabase.init()` ưu tiên db đã lưu trong IndexedDB của máy →
    bộ cài mới vốn không tự đổi giá trên máy cũ; giờ khi boot thấy `priceVersion` của máy khác bản seed,
    `_applyPriceSeedMigration()` seed `name/spec/packaging/unit/box_size/tiers/foc_rules/mkt_gift_rules`
    từ DEFAULT_DB vào db đã lưu (KHÔNG đụng kvCode — bất biến #2, alias, SP user tự thêm; SP mới trong
    seed được bổ sung, campaign thiếu được clone) rồi persist + refresh UI. Quy trình cập nhật bảng giá:
    sửa `default-db.json` (nguồn dữ liệu thật từ 10/2026 — db.js import trực tiếp, không còn chứa data) →
    bump `priceVersion` → build. Kèm cập nhật
    bảng giá Torvex 01/09/2026 (8 giá FURVEX/Hydraulic đại lý + chính sách MKT MXO 9/2026: gỡ quà DD súc
    rửa khỏi Furox 10W30/10W40, rule cleaner 10W50/Furox Racing có `buy_unit:"chai"` + link 2 quà
    chọn 1). Test: `test/price-seed-migration.test.mjs`. 326/326 pass.
- **8 chiến dịch sản phẩm** trong `db.js`:
  1. `xvil` — XVIL Dầu Nhớt Xe Máy (Clear Stock)
  2. `znt_mxo` — Zentor MXO Dầu Nhớt Xe Máy (Workshop)
  3. `znt_pcmo` — Zentor PCMO Dầu Ô Tô (Workshop)
  4. `torvex` — Torvex Dầu Nhớt Xe Máy (Cửa Hàng)
  5. `tvx_reseller` — TVX Dầu Nhớt Xe Tải (Đại Lý)
  6. `tvx_fleet` — TVX Dầu Nhớt Xe Tải (Đội Xe)
  7. `veltron_npp` — Veltron Clear Stock (NPP)
  8. `veltron_workshop` — Veltron Clear Stock (Workshop)
- **Thương hiệu chính**: XVIL, Zentor, Torvex, Veltron, Veltra, Petrix (Veltra & Petrix có thư mục đơn hàng riêng, dữ liệu giá cập nhật theo kỳ)

---

## 1. Cấu trúc thư mục dự án
```text
c:\Antigravity/
├── main.js              # Electron main process — tạo BrowserWindow, IPC handlers, export mutex, spawn Python
├── preload.js           # Preload script — expose electronAPI cho renderer (whitelist IPC chặt)
├── mcp-server.js       # MCP Streamable HTTP nội bộ 127.0.0.1:8048/mcp cho agent ngoài (token auth) — docs: docs/MCP.md
├── mcp-stdio-proxy.js  # Proxy stdio cho IDE agent (ZCode/Cursor/Claude) nối vào app đang mở
├── browser-agent.js     # Agent loop: LM Studio + BrowserMCP → tự thao tác trên KiotViet
├── browser-agent-ipc.js # IPC wiring giữa renderer và browser agent
├── mcp-client.js        # MCP client (kết nối BrowserMCP)
├── script-registry.js   # Kho script browser tái sử dụng (script tốt → 0 AI call lần sau)
├── kv-browser-helpers.js # Helper DOM cho KiotViet
├── ui-renderer.js       # Render UI đơn hàng, bảng sản phẩm, drag-and-drop, toast
├── app.js               # Legacy monolith — KHÔNG còn được import bởi entry thật (chỉ test dùng)
├── db.js                # Logic database (ProductDatabase, FOC/MKT, alias) — KHÔNG chứa dữ liệu giá từ 10/2026
├── default-db.json      # NGUỒN DỮ LIỆU THẬT (db.js import; Vite nhúng vào dist) — CHỈ LOCAL, không nằm trong git (giá nội bộ)
├── kv-name-map.json     # Mapping tên SP → mã KiotViet — CHỈ LOCAL, không nằm trong git (mã nội bộ)
├── default-aliases.json # DEFAULT_ALIASES tên hàng hóa — CHỈ LOCAL, không nằm trong git
├── internal-codes.json  # Mã KV quà tặng MKT trong logic seed — CHỈ LOCAL, không nằm trong git
├── default-memory.json  # DEFAULT_MEMORY AI — CHỈ LOCAL, không nằm trong git
├── ai-classifier.json   # Rules phân loại AI — CHỈ LOCAL, không nằm trong git
├── local-config.json    # kvTenantUrl (domain tenant KiotViet) — CHỈ LOCAL, không nằm trong git
├── db-store.js          # IndexedDB/localStorage persistence layer
├── store.js             # State management (pub/sub)
├── parser.js            # Regex + fuzzy matching parser (chế độ Offline)
├── ai-service.js        # Gọi LLM AI parsing — 12 provider, multi-profile failover/round-robin
├── ai-providers.mjs     # Registry 12 provider AI (endpoint, model mặc định, models gợi ý, keyUrl)
├── matching.worker.js   # Web Worker cho fuzzy matching (không block UI)
├── sync.js              # Đồng bộ dữ liệu sản phẩm từ Excel vào db
├── kv-import.js         # Import mapping KV từ Excel
├── kiotviet-auto-order.user.js # Userscript Tampermonkey (WebSocket API)
├── excel_automation.py  # ★ Xuất Excel thật qua win32com (clone template, FillDown công thức)
├── excel_create_month.py # Clone template Excel theo tháng mới cho từng brand
├── launch-order-app.ps1 # Script khởi chạy app
├── validate-build.js    # Kiểm tra trước/sau khi build Electron
├── index.html           # Giao diện chính (SPA, entry → /src/main.js)
├── style.css            # Dark glassmorphism design system
├── package.json         # Electron + electron-builder config
├── electron-builder.yml # Cấu hình đóng gói Windows installer
├── src/                 # ★ Feature modules (ES modules) — entry: src/main.js
│   ├── main.js          # Khởi tạo app + global error handler (toast "Lỗi promise"...)
│   ├── order/           # actions (sửa đơn + parseOrder xếp hàng), parse-pipeline (pipeline AI thuần
│   │                    # dùng chung), parse-queue (hàng đợi parse SONG SONG), parse-apply (áp kết quả
│   │                    # lên màn hình), builder, calculator, export, pending (đơn chờ duyệt),
│   │                    # note-sanitizer, extraction-repair, json-extractor,
│   │                    # tln-coverage.mjs, order-schema.mjs
│   ├── kiotviet/automation.js # Tự động hóa KV phía renderer
│   ├── ai/profile-manager.js  # Quản lý AI profiles
│   ├── api/headless.js  # HeadlessOrderAPI — pipeline parse qua executeJavaScript
│   ├── ui/              # confirm-dialog (modal + focus trap), persist-watch
│   ├── catalog/delegation.js # Event delegation tab Danh Mục
│   ├── settings/ui.js   # UI tab Cài Đặt & Dữ Liệu
│   ├── seller/manager.js, prefix/manager.js, customer-notes.js
│   ├── product-edit.js, edit-tracker.js, worker-manager.js, logger.js, utils.js
│   └── matching.worker.js
├── I.ĐƠN HÀNG/          # Dữ liệu đơn hàng theo brand (Veltra, XVIL, Petrix, Veltron, Torvex, Zentor)
├── Bảng giá/            # Bảng giá từ NPP (PDF, Excel)
└── Ứng dụng Lên Đơn Hàng/ # Build output (installer + unpacked) — không sửa tay
```

---

## 2. index.html
```html
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Order Automation — Tự động hóa đơn hàng</title>
  <meta name="description" content="Ứng dụng tự động hóa đơn hàng: phân tích tin nhắn sales, tính giá theo mốc số lượng, khuyến mãi FOC và quà tặng MKT." />
  <link rel="stylesheet" href="style.css" />
  <style>
    /* === AI Detection Card === */
    .ai-detection-card { }
    .ai-result-row { display: flex; align-items: center; gap: var(--space-md); }
    .ai-campaign-badge { font-size: 1.1rem; font-weight: 700; padding: var(--space-sm) var(--space-md); border-radius: var(--radius-md); }
    .confidence-bar { width: 150px; height: 6px; background: rgba(255,255,255,0.1); border-radius: var(--radius-full); overflow: hidden; }
    .confidence-fill { height: 100%; border-radius: var(--radius-full); transition: width 0.5s ease; }
    .confidence-text { font-size: 0.82rem; font-weight: 700; margin-left: var(--space-sm); }
    .ai-details { margin-top: var(--space-sm); font-size: 0.82rem; color: var(--text-secondary); }
    .ai-override { margin-top: var(--space-md); display: flex; align-items: center; gap: var(--space-sm); font-size: 0.82rem; }

    /* === PDF Drop Zone === */
    .pdf-drop-zone { border: 2px dashed var(--border-color); border-radius: var(--radius-md); padding: var(--space-xl); text-align: center; cursor: pointer; transition: all var(--transition-fast); color: var(--text-tertiary); }
    .pdf-drop-zone:hover, .pdf-drop-zone.drag-over { border-color: var(--accent-blue); background: var(--accent-blue-dim); color: var(--accent-blue); }

    /* === Modal Overlay === */
    .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 1000; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(4px); }
    .modal-content { background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: var(--space-xl); max-width: 600px; width: 90%; max-height: 85vh; overflow-y: auto; }

    /* === Tier / FOC Rows === */
    .tier-row input, .foc-row input { font-size: 0.82rem; padding: var(--space-xs) var(--space-sm); }

    /* === Alias Tags === */
    .alias-tag { display: inline-flex; align-items: center; gap: 4px; background: var(--accent-purple-dim); color: var(--accent-purple); padding: 2px 8px; border-radius: var(--radius-full); font-size: 0.75rem; font-weight: 500; margin: 2px; }
    .alias-tag button { background: none; border: none; color: inherit; cursor: pointer; font-size: 0.8rem; }

    /* === Score Bars === */
    .score-bar-container { display: flex; align-items: center; gap: var(--space-sm); margin: 2px 0; }
    .score-bar-label { font-size: 0.75rem; width: 100px; color: var(--text-secondary); }
    .score-bar { flex: 1; height: 4px; background: rgba(255,255,255,0.06); border-radius: var(--radius-full); overflow: hidden; }
    .score-bar-fill { height: 100%; border-radius: var(--radius-full); }
  </style>
</head>
<body>

<div class="app-container">
  <!-- ═══════════════════════════════════════════════════════════════════ -->
  <!--  HEADER                                                           -->
  <!-- ═══════════════════════════════════════════════════════════════════ -->
  <header class="app-header">
    <h1>⚙️ Order Automation</h1>
    <p class="subtitle">Dán tin nhắn sales → Tự động phân tích sản phẩm, giá &amp; khuyến mãi</p>
  </header>

  <!-- ═══════════════════════════════════════════════════════════════════ -->
  <!--  NAV TABS                                                         -->
  <!-- ═══════════════════════════════════════════════════════════════════ -->
  <nav class="nav-tabs" id="mainNav">
    <button class="nav-tab active" data-tab="order" id="tabOrder">
      <span class="tab-icon">📋</span> Nhập Đơn Hàng
    </button>
    <button class="nav-tab" data-tab="catalog" id="tabCatalog">
      <span class="tab-icon">📦</span> Danh Mục Sản Phẩm
    </button>
    <button class="nav-tab" data-tab="settings" id="tabSettings">
      <span class="tab-icon">⚙️</span> Cài Đặt &amp; Dữ Liệu
    </button>
  </nav>

  <!-- ═══════════════════════════════════════════════════════════════════ -->
  <!--  TAB 1: ORDER INPUT & RESULTS                                     -->
  <!-- ═══════════════════════════════════════════════════════════════════ -->
  <div class="tab-panel active" id="panelOrder">
    <div class="order-layout">

      <!-- LEFT: Input Panel -->
      <div class="input-panel">
        <div class="card">
          <div class="card-header">
            <div class="card-title"><span class="icon">📝</span> Nhập Đơn Hàng</div>
          </div>

          <!-- Customer Info -->
          <div class="customer-info">
            <div class="input-group">
              <label for="customerName">Tên KH / Cửa hàng</label>
              <input type="text" id="customerName" class="input-field" />
            </div>
            <div class="input-group">
              <label for="paymentMethod">Thanh toán</label>
              <select id="paymentMethod" class="input-field">
                <option value="ck">Chuyển khoản (CK)</option>
                <option value="cod">COD</option>
                <option value="tt">Thanh toán trực tiếp (TT)</option>
                <option value="congno">Công nợ</option>
                <option value="other">Khác</option>
              </select>
            </div>
          </div>

          <!-- Order Text Input -->
          <div class="order-input-area">
            <textarea
              id="orderText"
              class="order-textarea"
              placeholder="Dán tin nhắn của sales vào đây..."
            ></textarea>
          </div>

          <!-- Parse Actions -->
          <div class="parse-actions">
            <button class="btn btn-primary btn-lg btn-block" id="btnParse">
              🔍 Phân Tích Đơn Hàng
            </button>
          </div>
          <div class="button-row">
            <button class="btn btn-ghost btn-sm" id="btnClear">🗑️ Xóa</button>
            <button class="btn btn-ghost btn-sm" id="btnSample">📄 Mẫu thử</button>
          </div>

          <!-- Parsed Preview -->
          <div class="parsed-preview" id="parsedPreview"></div>
        </div>
      </div>

      <!-- AI Detection Card (before results) -->
      <div class="card ai-detection-card" id="aiDetectionCard" style="display:none; margin-bottom: var(--space-md);">
        <div class="card-header">
          <div class="card-title"><span class="icon">🤖</span> AI Nhận Diện Đơn Hàng</div>
        </div>
        <div class="ai-detection-content">
          <div class="ai-result-row">
            <div class="ai-campaign-badge" id="aiCampaignBadge"></div>
            <div class="ai-confidence">
              <div class="confidence-bar"><div class="confidence-fill" id="aiConfidenceFill"></div></div>
              <span class="confidence-text" id="aiConfidenceText">0%</span>
            </div>
          </div>
          <div class="ai-details" id="aiDetails"></div>
          <div class="ai-override">
            <label>Ghi đè thủ công:</label>
            <select id="aiOverrideCampaign" class="input-field">
              <option value="">— Tự động —</option>
            </select>
          </div>
        </div>
      </div>

      <!-- RIGHT: Results Panel -->
      <div class="results-panel">
        <div class="card">
          <div class="card-header">
            <div class="card-title"><span class="icon">📊</span> Chi Tiết Đơn Hàng</div>
            <div style="display: flex; gap: var(--space-sm);">
              <button class="btn btn-ghost btn-sm copy-summary-btn" id="btnCopy" style="display:none;">
                📋 Copy tóm tắt
              </button>
            </div>
          </div>

          <!-- Empty State -->
          <div class="empty-state" id="emptyState">
            <div class="empty-icon">📭</div>
            <h3>Chưa có đơn hàng</h3>
            <p>Dán tin nhắn của sales vào ô bên trái và nhấn "Phân Tích Đơn Hàng" để bắt đầu.</p>
          </div>

          <!-- Order Results (hidden initially) -->
          <div class="order-results" id="orderResults" style="display:none;">
            <table class="order-table">
              <thead>
                <tr>
                  <th style="width:30px;"></th>
                  <th>Sản phẩm</th>
                  <th class="text-center">SL</th>
                  <th class="text-right">Đơn giá (Chai / Thùng)</th>
                  <th class="text-right">Thành tiền</th>
                </tr>
              </thead>
              <tbody id="orderTableBody">
              </tbody>
            </table>

            <!-- Quick Add Product Search (Previously manual add product card) -->
            <div class="quick-add-section" style="margin-top: var(--space-md); border-top: 1px dashed var(--border-color); padding-top: var(--space-md); padding-bottom: var(--space-md);">
              <div style="font-size: 0.85rem; font-weight: 600; color: var(--text-secondary); margin-bottom: var(--space-xs);"><span class="icon">➕</span> Thêm Sản Phẩm Thủ Công Vào Đơn Hàng:</div>
              <div class="search-dropdown-container" style="margin-top: 0;">
                <span class="search-icon">🔍</span>
                <input
                  type="text"
                  class="product-search-input"
                  id="manualProductSearch"
                  placeholder="Nhập tên sản phẩm để tìm kiếm và click thêm trực tiếp..."
                  autocomplete="off"
                />
                <div class="search-dropdown" id="manualSearchDropdown"></div>
              </div>
            </div>

            <!-- Order Summary Cards -->
            <div class="order-summary" id="orderSummary">
              <div class="summary-card">
                <div class="summary-label">Tổng sản phẩm</div>
                <div class="summary-value" id="summaryProducts">0</div>
              </div>
              <div class="summary-card">
                <div class="summary-label">Tổng số thùng</div>
                <div class="summary-value" id="summaryBoxes">0</div>
              </div>
              <div class="summary-card total-card">
                <div class="summary-label">Tổng tiền đơn hàng</div>
                <div class="summary-value highlight" id="summaryTotal">0 ₫</div>
              </div>
            </div>

            <!-- MKT Gifts -->
            <div class="mkt-gifts-section" id="mktGiftsSection" style="display:none;">
            </div>

            <!-- Custom Extra Promos -->
            <div class="custom-promo-section">
              <div class="card-header" style="margin-top: var(--space-md);">
                <div class="card-title"><span class="icon">🎁</span> Khuyến Mãi Ngoài (Tùy chỉnh)</div>
              </div>
              <div class="custom-promo-list" id="customPromoList"></div>
              <div class="promo-add-row">
                <input type="text" class="input-field" id="customPromoInput" placeholder="VD: Tặng thêm 1 áo polo..." />
                <button class="btn btn-success btn-sm" id="btnAddPromo">+ Thêm</button>
              </div>
            </div>

            <!-- Payment Note -->
            <div class="payment-note" id="paymentNote" style="display:none;">
              <span>💳</span>
              <span id="paymentNoteText"></span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- ═══════════════════════════════════════════════════════════════════ -->
  <!--  TAB 2: PRODUCT CATALOG                                           -->
  <!-- ═══════════════════════════════════════════════════════════════════ -->
  <div class="tab-panel" id="panelCatalog">
    <div class="card">
      <div class="card-header">
        <div class="card-title"><span class="icon">📦</span> Danh Mục Sản Phẩm &amp; Bảng Giá</div>
        <div>
          <select id="catalogCampaignFilter" class="input-field">
            <option value="all">Tất cả chiến dịch</option>
          </select>
        </div>
      </div>
      <div id="catalogContent"></div>
    </div>
  </div>

  <!-- ═══════════════════════════════════════════════════════════════════ -->
  <!--  TAB 3: SETTINGS & DATA                                          -->
  <!-- ═══════════════════════════════════════════════════════════════════ -->
  <div class="tab-panel" id="panelSettings">
    <div class="settings-grid">

      <!-- Campaign Sidebar -->
      <div class="card">
        <div class="card-header">
          <div class="card-title"><span class="icon">📂</span> Chiến dịch</div>
        </div>
        <div class="campaign-list" id="settingsCampaignList"></div>

        <!-- Add Product / Campaign Buttons -->
        <div class="button-row" style="margin-top: var(--space-md);">
          <button class="btn btn-primary btn-sm btn-block" id="btnToggleAddProduct">➕ Thêm SP</button>
          <button class="btn btn-ghost btn-sm btn-block" id="btnToggleAddCampaign">📁 Thêm CĐ</button>
        </div>

        <!--  ADD CAMPAIGN FORM (embedded here) -->
        <div class="card" id="addCampaignCard" style="display:none; margin-top: var(--space-md); border: 1px solid var(--accent-blue); padding: var(--space-sm);">
          <div class="card-header">
            <div class="card-title"><span class="icon">📁</span> Thêm Chiến Dịch Mới</div>
            <button class="btn btn-ghost btn-sm" id="btnCloseCampaignForm">✕ Đóng</button>
          </div>
          <div class="input-group" style="margin-bottom:var(--space-sm)">
            <label>Tên chiến dịch (ID)</label>
            <input type="text" id="newCampaignId" class="input-field" placeholder="VD: zentor_t7_2026" />
          </div>
          <div class="input-group" style="margin-bottom:var(--space-sm)">
            <label>Tên hiển thị</label>
            <input type="text" id="newCampaignLabel" class="input-field" placeholder="VD: Zentor Tháng 7/2026" />
          </div>
          <div class="input-group" style="margin-bottom:var(--space-sm)">
            <label>Mô tả (tùy chọn)</label>
            <input type="text" id="newCampaignDesc" class="input-field" placeholder="VD: Bảng giá Zentor áp dụng từ 01/07/2026" />
          </div>
          <div class="customer-info">
            <div class="input-group">
              <label>Ngày bắt đầu</label>
              <input type="date" id="newCampaignStart" class="input-field" />
            </div>
            <div class="input-group">
              <label>Ngày kết thúc</label>
              <input type="date" id="newCampaignEnd" class="input-field" />
            </div>
          </div>
          <div class="button-row" style="margin-top:var(--space-md)">
            <button class="btn btn-success btn-lg btn-block" id="btnSaveCampaign">💾 Lưu Chiến Dịch</button>
          </div>
        </div>

        <!-- Data Import/Export -->
        <div class="data-actions" style="margin-top: var(--space-md);">
          <button class="btn btn-ghost btn-sm" id="btnExport">📤 Xuất JSON</button>
          <button class="btn btn-ghost btn-sm" id="btnImportTrigger">📥 Nhập JSON</button>
          <button class="btn btn-danger btn-sm" id="btnReset">🔄 Reset mặc định</button>
        </div>
        <input type="file" id="importFileInput" class="hidden-input" accept=".json" />
      </div>

      <!-- AI Model Settings Card -->
      <div class="card" style="margin-top: var(--space-md);">
        <div class="card-header">
          <div class="card-title"><span class="icon">🤖</span> Phân Tích Đơn Bằng AI</div>
        </div>
        <div style="padding: var(--space-xs) 0;">
          <div class="input-group" style="margin-bottom: var(--space-sm);">
            <label>Phương thức phân tích</label>
            <select id="aiProvider" class="input-field" style="width: 100%;">
              <option value="none" selected>🔒 Offline Mode (Regular Expression)</option>
              <option value="gemini">✨ Google Gemini API</option>
              <option value="openai">🧠 OpenAI API (GPT)</option>
              <option value="custom">⚙️ Custom OpenAI-Compatible Endpoint</option>
            </select>
          </div>

          <!-- API Key Configuration (hidden by default) -->
          <div id="aiConfigPanel" style="display: none;">
            <div class="input-group" style="margin-bottom: var(--space-sm);">
              <label for="aiApiKey">🔑 API Key</label>
              <div style="position: relative;">
                <input type="password" id="aiApiKey" class="input-field" placeholder="Dán API Key của bạn vào đây..." style="width: 100%; padding-right: 70px;" autocomplete="off" />
                <button class="btn btn-ghost btn-sm" id="btnToggleKeyVisibility" style="position: absolute; right: 4px; top: 50%; transform: translateY(-50%); font-size: 0.75rem; padding: 2px 8px;">👁️ Hiện</button>
              </div>
              <div style="font-size: 0.72rem; color: var(--text-tertiary); margin-top: 2px;">
                API Key được lưu trên trình duyệt của bạn (localStorage), không gửi đi đâu khác ngoài API AI.
              </div>
            </div>

            <div class="input-group" style="margin-bottom: var(--space-sm);">
              <label for="aiModelName">📦 Model</label>
              <input type="text" id="aiModelName" class="input-field" placeholder="VD: gemini-2.5-flash, gpt-4o-mini" style="width: 100%;" />
            </div>

            <!-- Custom endpoint URL (only for 'custom' provider) -->
            <div id="aiEndpointGroup" class="input-group" style="margin-bottom: var(--space-sm); display: none;">
              <label for="aiEndpointUrl">🌐 Endpoint URL</label>
              <input type="text" id="aiEndpointUrl" class="input-field" placeholder="VD: https://api.example.com/v1/chat/completions" style="width: 100%;" />
            </div>

            <button class="btn btn-primary btn-sm btn-block" id="btnSaveAiConfig" style="margin-top: var(--space-xs);">💾 Lưu Cấu Hình AI</button>

            <div id="aiTestResult" style="margin-top: var(--space-sm); display: none;"></div>
          </div>

          <div id="aiStatusBadge" style="margin-top: var(--space-xs); font-size: 0.78rem; color: var(--text-secondary); text-align: center; font-weight: 500;">
            🔒 Đang chạy Offline (Regular Expression)
          </div>
        </div>
      </div>

      <!-- AI Rules Memory Card -->
      <div class="card" style="margin-top: var(--space-md);">
        <div class="card-header">
          <div class="card-title"><span class="icon">🧠</span> Bộ Nhớ Quy Tắc AI</div>
        </div>
        <div style="padding: var(--space-xs) 0;">
          <div class="input-group" style="margin-bottom: var(--space-sm);">
            <label for="aiMemoryInput">Bộ nhớ quy tắc (Nhớ tên viết tắt, cách tính...)</label>
            <textarea id="aiMemoryInput" class="input-field" style="width: 100%; height: 160px; font-family: monospace; font-size: 0.78rem; resize: vertical; line-height: 1.4;" placeholder="Nhập quy tắc bộ nhớ tại đây..."></textarea>
          </div>
          <button class="btn btn-primary btn-sm btn-block" id="btnSaveMemory">💾 Lưu Bộ Nhớ</button>
        </div>
      </div>

      <!-- Product Editor -->
      <div class="card">
        <div class="card-header">
          <div class="card-title"><span class="icon">✏️</span> Sản phẩm — <span id="settingsEditorTitle">Chọn chiến dịch</span></div>
        </div>

        <!--  ADD PRODUCT FORM (embedded here) -->
        <div class="card" id="addProductCard" style="display:none; margin: var(--space-md); border: 1px dashed var(--accent-blue); background: rgba(0,122,255,0.02);">
          <div class="card-header">
            <div class="card-title"><span class="icon">➕</span> Thêm Sản Phẩm Mới</div>
            <button class="btn btn-ghost btn-sm" id="btnCloseProductForm">✕ Đóng</button>
          </div>
          <!-- Product Name -->
          <div class="input-group" style="margin-bottom:var(--space-sm)">
            <label>Tên sản phẩm</label>
            <input type="text" id="newProductName" class="input-field" placeholder="VD: Zentor ProActive 5W30" />
          </div>
          <div class="customer-info">
            <div class="input-group">
              <label>Spec</label>
              <input type="text" id="newProductSpec" class="input-field" placeholder="VD: 5W30 SN PLUS" />
            </div>
            <div class="input-group">
              <label>Đóng gói</label>
              <input type="text" id="newProductPackaging" class="input-field" placeholder="VD: 1L x 12 chai/thùng" />
            </div>
          </div>
          <div class="customer-info">
            <div class="input-group">
              <label>Đơn vị tính</label>
              <select id="newProductUnit" class="input-field">
                <option value="thùng">Thùng</option>
                <option value="chai">Chai</option>
                <option value="can">Can</option>
                <option value="phuy">Phuy</option>
              </select>
            </div>
            <div class="input-group">
              <label>Số lượng/thùng (box_size)</label>
              <input type="number" id="newProductBoxSize" class="input-field" value="12" min="1" />
            </div>
          </div>
          <!-- Price Tiers -->
          <div style="margin-top:var(--space-md)">
            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:var(--space-sm)">
              <label style="font-size:0.78rem; font-weight:600; color:var(--text-secondary); text-transform:uppercase;">Bậc giá (Tiers)</label>
              <button class="btn btn-ghost btn-sm" id="btnAddNewTier">+ Thêm bậc</button>
            </div>
            <div id="newProductTiers">
              <div class="tier-row" style="display:grid; grid-template-columns:1fr 1fr 1fr 1fr auto; gap:var(--space-xs); margin-bottom:var(--space-xs);">
                <input type="number" class="input-field tier-min" placeholder="Từ" value="1" min="1" />
                <input type="number" class="input-field tier-max" placeholder="Đến" value="9999" />
                <input type="number" class="input-field tier-price" placeholder="Giá" value="0" />
                <input type="text" class="input-field tier-label" placeholder="Nhãn" value="Tất cả" />
                <button class="btn btn-ghost btn-sm" onclick="this.closest('.tier-row').remove()">✕</button>
              </div>
            </div>
          </div>
          <!-- FOC Rules -->
          <div style="margin-top:var(--space-md)">
            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:var(--space-sm)">
              <label style="font-size:0.78rem; font-weight:600; color:var(--text-secondary); text-transform:uppercase;">Khuyến mãi FOC</label>
              <button class="btn btn-ghost btn-sm" id="btnAddNewFOC">+ Thêm FOC</button>
            </div>
            <div id="newProductFOC"></div>
          </div>
          <!-- Alias -->
          <div class="input-group" style="margin-top:var(--space-md)">
            <label>Tên gọi tắt (aliases, cách nhau bởi dấu phẩy)</label>
            <input type="text" id="newProductAliases" class="input-field" placeholder="VD: proactive 5w30, zentor proactive" />
          </div>
          <!-- Save -->
          <div class="button-row" style="margin-top:var(--space-md)">
            <button class="btn btn-success btn-lg btn-block" id="btnSaveProduct">💾 Lưu Sản Phẩm</button>
          </div>
        </div>

        <div class="product-editor" id="productEditor">
          <div class="empty-state">
            <div class="empty-icon">👈</div>
            <h3>Chọn chiến dịch bên trái</h3>
            <p>Bạn sẽ thấy danh sách sản phẩm và có thể chỉnh sửa giá, khuyến mãi tại đây.</p>
          </div>
        </div>
      </div>



      <!-- ═══════════════════════════════════════════════════════════════ -->
      <!--  ALIASES MANAGER                                               -->
      <!-- ═══════════════════════════════════════════════════════════════ -->
      <div class="card" style="margin-top: var(--space-md);">
        <div class="card-header">
          <div class="card-title"><span class="icon">🏷️</span> Quản Lý Tên Gọi Tắt (Aliases)</div>
        </div>
        <div class="input-group" style="margin-bottom:var(--space-sm)">
          <label>Tìm sản phẩm để quản lý alias</label>
          <input type="text" id="aliasSearchInput" class="input-field" placeholder="Nhập tên sản phẩm..." />
        </div>
        <div id="aliasEditorContent">
          <div class="empty-state" style="padding: var(--space-md);">
            <p style="color: var(--text-tertiary); font-size: 0.85rem;">Tìm sản phẩm ở trên để xem và chỉnh sửa aliases.</p>
          </div>
        </div>
      </div>

    </div>
  </div>
</div>

<!-- ═══════════════════════════════════════════════════════════════════ -->
<!--  MODAL OVERLAY (Campaign Creation / General Purpose)              -->
<!-- ═══════════════════════════════════════════════════════════════════ -->
<div class="modal-overlay" id="modalOverlay" style="display:none;">
  <div class="modal-content" onclick="event.stopPropagation()">
    <div class="card-header" style="margin-bottom: var(--space-md);">
      <div class="card-title" id="modalTitle">Tiêu đề</div>
      <button class="btn btn-ghost btn-sm" id="btnCloseModal">✕ Đóng</button>
    </div>
    <div id="modalBody"></div>
  </div>
</div>

<!-- Toast Container -->
<div class="toast-container" id="toastContainer"></div>

<!-- Scripts -->
<script src="db.js"></script>
<script>
// Error boundary: check if db loaded successfully
if (typeof db === 'undefined' || !db) {
  document.addEventListener('DOMContentLoaded', function() {
    var banner = document.createElement('div');
    banner.id = 'dbErrorBanner';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#ff1744;color:white;padding:12px 20px;font-size:14px;text-align:center;font-family:sans-serif;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
    banner.innerHTML = '⚠️ <b>Lỗi nạp cơ sở dữ liệu!</b> Kiểm tra file db.js có lỗi cú pháp. Nhấn F12 → Console để xem chi tiết. <button onclick="this.parentElement.remove()" style="margin-left:16px;background:white;color:#ff1744;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-weight:bold;">Đóng</button>';
    document.body.prepend(banner);
  });
} else if (db._isFallback) {
  document.addEventListener('DOMContentLoaded', function() {
    var banner = document.createElement('div');
    banner.id = 'dbErrorBanner';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#ff9100;color:white;padding:12px 20px;font-size:14px;text-align:center;font-family:sans-serif;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
    banner.innerHTML = '⚠️ <b>Cơ sở dữ liệu đang chạy ở chế độ khẩn cấp!</b> Dữ liệu sản phẩm có thể không đầy đủ. Nhấn F12 → Console để xem chi tiết. <button onclick="this.parentElement.remove()" style="margin-left:16px;background:white;color:#ff9100;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-weight:bold;">Đóng</button>';
    document.body.prepend(banner);
  });
}
</script>
<script src="app.js"></script>
</body>
</html>

```

---

## 3. style.css
```css
/* =========================================================================
 *  ORDER AUTOMATION - DESIGN SYSTEM (style.css)
 * =========================================================================
 *  Premium dark theme with glassmorphism, smooth animations,
 *  and a professional color palette. Google Font: Inter.
 * ========================================================================= */

@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap');

/* ─── CSS Custom Properties ──────────────────────────────────────────────── */
:root {
  /* Base Colors */
  --bg-primary: #0b0e14;
  --bg-secondary: #111620;
  --bg-tertiary: #161c28;
  --bg-card: rgba(22, 28, 40, 0.7);
  --bg-card-hover: rgba(30, 38, 55, 0.85);
  --bg-glass: rgba(17, 22, 32, 0.6);
  --bg-input: rgba(11, 14, 20, 0.8);

  /* Surface & Border */
  --border-color: rgba(255, 255, 255, 0.06);
  --border-glow: rgba(99, 179, 237, 0.15);
  --surface-hover: rgba(255, 255, 255, 0.04);

  /* Text */
  --text-primary: #e8ecf4;
  --text-secondary: #8b95a8;
  --text-tertiary: #5a6478;
  --text-on-accent: #ffffff;

  /* Accent Colors */
  --accent-blue: #4fc3f7;
  --accent-blue-dim: rgba(79, 195, 247, 0.15);
  --accent-purple: #ab47bc;
  --accent-purple-dim: rgba(171, 71, 188, 0.15);
  --accent-green: #66bb6a;
  --accent-green-dim: rgba(102, 187, 106, 0.15);
  --accent-orange: #ff8a65;
  --accent-orange-dim: rgba(255, 138, 101, 0.15);
  --accent-red: #ef5350;
  --accent-red-dim: rgba(239, 83, 80, 0.15);
  --accent-yellow: #ffd54f;
  --accent-yellow-dim: rgba(255, 213, 79, 0.15);
  --accent-teal: #4db6ac;
  --accent-teal-dim: rgba(77, 182, 172, 0.15);

  /* Gradients */
  --gradient-primary: linear-gradient(135deg, #4fc3f7 0%, #ab47bc 100%);
  --gradient-success: linear-gradient(135deg, #66bb6a 0%, #4db6ac 100%);
  --gradient-warning: linear-gradient(135deg, #ffd54f 0%, #ff8a65 100%);
  --gradient-danger: linear-gradient(135deg, #ef5350 0%, #ec407a 100%);
  --gradient-glass: linear-gradient(135deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%);

  /* Shadows */
  --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.3);
  --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.4);
  --shadow-lg: 0 8px 32px rgba(0, 0, 0, 0.5);
  --shadow-glow-blue: 0 0 20px rgba(79, 195, 247, 0.15);
  --shadow-glow-purple: 0 0 20px rgba(171, 71, 188, 0.15);

  /* Radius */
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;
  --radius-xl: 24px;
  --radius-full: 9999px;

  /* Spacing */
  --space-xs: 4px;
  --space-sm: 8px;
  --space-md: 16px;
  --space-lg: 24px;
  --space-xl: 32px;
  --space-2xl: 48px;

  /* Typography */
  --font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;

  /* Transitions */
  --transition-fast: 150ms cubic-bezier(0.4, 0, 0.2, 1);
  --transition-normal: 250ms cubic-bezier(0.4, 0, 0.2, 1);
  --transition-slow: 400ms cubic-bezier(0.4, 0, 0.2, 1);
}

/* ─── Reset & Base ───────────────────────────────────────────────────────── */
*,
*::before,
*::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html {
  font-size: 14px;
  scroll-behavior: smooth;
}

body {
  font-family: var(--font-family);
  background: var(--bg-primary);
  color: var(--text-primary);
  line-height: 1.6;
  min-height: 100vh;
  overflow-x: hidden;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

/* Background ambient glow */
body::before {
  content: '';
  position: fixed;
  top: -200px;
  left: -200px;
  width: 600px;
  height: 600px;
  background: radial-gradient(circle, rgba(79, 195, 247, 0.06) 0%, transparent 70%);
  pointer-events: none;
  z-index: 0;
}

body::after {
  content: '';
  position: fixed;
  bottom: -200px;
  right: -200px;
  width: 600px;
  height: 600px;
  background: radial-gradient(circle, rgba(171, 71, 188, 0.06) 0%, transparent 70%);
  pointer-events: none;
  z-index: 0;
}

/* ─── Scrollbar ──────────────────────────────────────────────────────────── */
::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.1);
  border-radius: var(--radius-full);
}

::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.2);
}

/* ─── Layout ─────────────────────────────────────────────────────────────── */
.app-container {
  position: relative;
  z-index: 1;
  max-width: 1440px;
  margin: 0 auto;
  padding: var(--space-lg);
}

/* ─── Header ─────────────────────────────────────────────────────────────── */
.app-header {
  text-align: center;
  padding: var(--space-xl) 0 var(--space-lg);
  position: relative;
}

.app-header h1 {
  font-size: 2rem;
  font-weight: 800;
  background: var(--gradient-primary);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  letter-spacing: -0.5px;
  margin-bottom: var(--space-xs);
}

.app-header .subtitle {
  color: var(--text-secondary);
  font-size: 0.92rem;
  font-weight: 400;
}

/* ─── Tabs / Navigation ──────────────────────────────────────────────────── */
.nav-tabs {
  display: flex;
  gap: var(--space-xs);
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  padding: var(--space-xs);
  margin-bottom: var(--space-lg);
  backdrop-filter: blur(12px);
}

.nav-tab {
  flex: 1;
  padding: var(--space-sm) var(--space-md);
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-family);
  font-size: 0.88rem;
  font-weight: 500;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all var(--transition-fast);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-sm);
}

.nav-tab:hover {
  color: var(--text-primary);
  background: var(--surface-hover);
}

.nav-tab.active {
  background: var(--accent-blue-dim);
  color: var(--accent-blue);
  font-weight: 600;
}

.nav-tab .tab-icon {
  font-size: 1.1rem;
}

/* ─── Panels ─────────────────────────────────────────────────────────────── */
.tab-panel {
  display: none;
  animation: fadeIn 0.3s ease;
}

.tab-panel.active {
  display: block;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ─── Cards ──────────────────────────────────────────────────────────────── */
.card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  padding: var(--space-lg);
  backdrop-filter: blur(12px);
  transition: all var(--transition-normal);
}

.card:hover {
  border-color: var(--border-glow);
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-md);
  padding-bottom: var(--space-md);
  border-bottom: 1px solid var(--border-color);
}

.card-title {
  font-size: 1rem;
  font-weight: 700;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

.card-title .icon {
  font-size: 1.2rem;
}

/* ─── Main Layout Centered Flex ───────────────────────────────────────────── */
.order-layout {
  display: flex;
  flex-direction: column;
  gap: var(--space-lg);
  max-width: 1100px;
  margin: 0 auto;
  align-items: stretch;
}

/* ─── Input Panel ────────────────────────────────────────────────────────── */
.input-panel {
  max-width: 650px;
  width: 100%;
  margin: 0 auto;
}

.order-input-area {
  position: relative;
}

.order-textarea {
  width: 100%;
  min-height: 180px;
  max-height: 400px;
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: var(--space-md);
  color: var(--text-primary);
  font-family: var(--font-family);
  font-size: 0.92rem;
  line-height: 1.7;
  resize: vertical;
  transition: border-color var(--transition-fast);
  outline: none;
}

.order-textarea::placeholder {
  color: var(--text-tertiary);
  font-style: italic;
}

.order-textarea:focus {
  border-color: var(--accent-blue);
  box-shadow: var(--shadow-glow-blue);
}

/* Customer name field */
.customer-info {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-sm);
  margin-bottom: var(--space-md);
}

.input-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
}

.input-group label {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.input-field {
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  padding: var(--space-sm) var(--space-md);
  color: var(--text-primary);
  font-family: var(--font-family);
  font-size: 0.88rem;
  outline: none;
  transition: border-color var(--transition-fast);
}

.input-field:focus {
  border-color: var(--accent-blue);
}

.input-field::placeholder {
  color: var(--text-tertiary);
}

/* ─── Buttons ────────────────────────────────────────────────────────────── */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  border: none;
  border-radius: var(--radius-sm);
  font-family: var(--font-family);
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: all var(--transition-fast);
  white-space: nowrap;
}

.btn-primary {
  background: var(--gradient-primary);
  color: var(--text-on-accent);
  box-shadow: var(--shadow-sm);
}

.btn-primary:hover {
  box-shadow: var(--shadow-glow-blue);
  transform: translateY(-1px);
}

.btn-success {
  background: var(--gradient-success);
  color: var(--text-on-accent);
}

.btn-success:hover {
  box-shadow: 0 0 15px rgba(102, 187, 106, 0.3);
  transform: translateY(-1px);
}

.btn-danger {
  background: var(--gradient-danger);
  color: var(--text-on-accent);
}

.btn-danger:hover {
  box-shadow: 0 0 15px rgba(239, 83, 80, 0.3);
  transform: translateY(-1px);
}

.btn-ghost {
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
}

.btn-ghost:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
  border-color: var(--border-glow);
}

.btn-sm {
  padding: var(--space-xs) var(--space-sm);
  font-size: 0.78rem;
}

.btn-lg {
  padding: var(--space-md) var(--space-xl);
  font-size: 0.95rem;
  border-radius: var(--radius-md);
}

.btn-icon {
  width: 32px;
  height: 32px;
  padding: 0;
  border-radius: var(--radius-sm);
}

.btn-block {
  width: 100%;
}

.button-row {
  display: flex;
  gap: var(--space-sm);
  margin-top: var(--space-md);
}

.button-row .btn {
  flex: 1;
}

/* ─── Parse Actions ──────────────────────────────────────────────────────── */
.parse-actions {
  margin-top: var(--space-md);
  display: flex;
  gap: var(--space-sm);
}

/* ─── Results Panel ──────────────────────────────────────────────────────── */
.results-panel {
  min-height: 300px;
  width: 100%;
  margin: 0 auto;
}

/* Empty State */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--space-2xl);
  text-align: center;
}

.empty-state .empty-icon {
  font-size: 3.5rem;
  margin-bottom: var(--space-md);
  opacity: 0.4;
}

.empty-state h3 {
  font-size: 1.1rem;
  color: var(--text-secondary);
  margin-bottom: var(--space-sm);
}

.empty-state p {
  color: var(--text-tertiary);
  font-size: 0.85rem;
  max-width: 350px;
}

/* ─── Order Results Table ────────────────────────────────────────────────── */
.order-results {
  overflow-x: auto;
}

.order-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}

.order-table thead th {
  background: rgba(255, 255, 255, 0.03);
  color: var(--text-secondary);
  font-weight: 600;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: var(--space-sm) var(--space-md);
  text-align: left;
  border-bottom: 1px solid var(--border-color);
  white-space: nowrap;
}

.order-table thead th.text-right {
  text-align: right;
}

.order-table thead th.text-center {
  text-align: center;
}

.order-table tbody tr {
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
  transition: background var(--transition-fast);
}

.order-table tbody tr:hover {
  background: var(--surface-hover);
}

.order-table tbody td {
  padding: var(--space-sm) var(--space-md);
  vertical-align: middle;
}

.order-table tbody td.text-right {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.order-table tbody td.text-center {
  text-align: center;
}

/* Product cell */
.product-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.product-name {
  font-weight: 600;
  color: var(--text-primary);
}

.product-spec {
  font-size: 0.75rem;
  color: var(--text-tertiary);
}

.product-campaign {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.7rem;
  padding: 2px 6px;
  border-radius: var(--radius-full);
  font-weight: 500;
}

/* Price cell */
.price-cell {
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}

.price-amount {
  color: var(--text-primary);
  font-weight: 600;
}

.price-tier {
  font-size: 0.72rem;
  color: var(--text-tertiary);
  display: block;
}

/* FOC cell */
.foc-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.foc-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--accent-green-dim);
  color: var(--accent-green);
  padding: 2px 8px;
  border-radius: var(--radius-full);
  font-size: 0.75rem;
  font-weight: 600;
}

.foc-detail {
  font-size: 0.72rem;
  color: var(--text-tertiary);
}

/* Subtotal */
.subtotal-amount {
  font-weight: 700;
  color: var(--accent-blue);
  font-size: 0.95rem;
}

/* Dual Price Cell (Chai & Thùng) */
.dual-price-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: flex-end;
}

.price-row-item {
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: flex-end;
}

.price-label-badge {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-secondary);
  background: rgba(255, 255, 255, 0.06);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  min-width: 44px;
  text-align: center;
  border: 1px solid rgba(255, 255, 255, 0.08);
}

/* Editable price */
.editable-price {
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  padding: 3px 8px;
  color: var(--text-primary);
  font-family: var(--font-family);
  font-size: 0.84rem;
  font-weight: 600;
  width: 105px;
  text-align: right;
  transition: all var(--transition-fast);
  font-variant-numeric: tabular-nums;
}

.editable-price:hover {
  border-color: var(--accent-blue);
  background: var(--bg-input);
}

.editable-price:focus {
  border-color: var(--accent-blue);
  background: var(--bg-input);
  outline: none;
  box-shadow: 0 0 0 2px var(--accent-blue-dim);
}

/* Editable qty */
.editable-qty {
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  padding: 2px 6px;
  color: var(--text-primary);
  font-family: var(--font-family);
  font-size: 0.85rem;
  font-weight: 600;
  width: 60px;
  text-align: center;
  transition: all var(--transition-fast);
}

.editable-qty:hover {
  border-color: var(--border-color);
  background: var(--bg-input);
}

.editable-qty:focus {
  border-color: var(--accent-blue);
  background: var(--bg-input);
  outline: none;
  box-shadow: 0 0 0 2px var(--accent-blue-dim);
}

/* Delete row button */
.btn-delete-row {
  background: transparent;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  font-size: 1rem;
  padding: 4px;
  border-radius: var(--radius-sm);
  transition: all var(--transition-fast);
}

.btn-delete-row:hover {
  color: var(--accent-red);
  background: var(--accent-red-dim);
}

/* ─── Order Summary ──────────────────────────────────────────────────────── */
.order-summary {
  margin-top: var(--space-lg);
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-md);
}

@media (max-width: 700px) {
  .order-summary {
    grid-template-columns: 1fr;
  }
}

.summary-card {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: var(--space-md);
}

.summary-card.total-card {
  grid-column: 1 / -1;
  background: linear-gradient(135deg, rgba(79, 195, 247, 0.08) 0%, rgba(171, 71, 188, 0.08) 100%);
  border-color: rgba(79, 195, 247, 0.2);
}

.summary-label {
  font-size: 0.75rem;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
  margin-bottom: var(--space-xs);
}

.summary-value {
  font-size: 1.4rem;
  font-weight: 800;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.summary-value.highlight {
  background: var(--gradient-primary);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

/* ─── MKT Gifts Section ──────────────────────────────────────────────────── */
.mkt-gifts-section {
  margin-top: var(--space-lg);
}

.mkt-gift-card {
  background: var(--accent-yellow-dim);
  border: 1px solid rgba(255, 213, 79, 0.2);
  border-radius: var(--radius-md);
  padding: var(--space-md);
  margin-bottom: var(--space-sm);
}

.mkt-gift-title {
  font-size: 0.78rem;
  font-weight: 700;
  color: var(--accent-yellow);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: var(--space-xs);
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

.mkt-gift-content {
  color: var(--text-primary);
  font-size: 0.88rem;
  font-weight: 500;
}

.mkt-gift-label {
  font-size: 0.75rem;
  color: var(--text-tertiary);
  margin-top: var(--space-xs);
}

/* ─── Custom Promo Section ───────────────────────────────────────────────── */
.custom-promo-section {
  margin-top: var(--space-lg);
}

.promo-add-row {
  display: flex;
  gap: var(--space-sm);
  margin-top: var(--space-sm);
}

.promo-add-row .input-field {
  flex: 1;
}

.custom-promo-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  margin-top: var(--space-sm);
}

.custom-promo-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--accent-teal-dim);
  border: 1px solid rgba(77, 182, 172, 0.2);
  border-radius: var(--radius-sm);
  padding: var(--space-sm) var(--space-md);
}

.custom-promo-text {
  font-size: 0.85rem;
  color: var(--text-primary);
  font-weight: 500;
}

/* ─── Parsed Preview ─────────────────────────────────────────────────────── */
.parsed-preview {
  margin-top: var(--space-md);
}

.parsed-line {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  border-radius: var(--radius-sm);
  margin-bottom: var(--space-xs);
  font-size: 0.85rem;
  animation: slideIn 0.2s ease forwards;
  opacity: 0;
}

.parsed-line:nth-child(1) { animation-delay: 0ms; }
.parsed-line:nth-child(2) { animation-delay: 60ms; }
.parsed-line:nth-child(3) { animation-delay: 120ms; }
.parsed-line:nth-child(4) { animation-delay: 180ms; }
.parsed-line:nth-child(5) { animation-delay: 240ms; }
.parsed-line:nth-child(6) { animation-delay: 300ms; }
.parsed-line:nth-child(7) { animation-delay: 360ms; }
.parsed-line:nth-child(8) { animation-delay: 420ms; }

@keyframes slideIn {
  from { opacity: 0; transform: translateX(-10px); }
  to { opacity: 1; transform: translateX(0); }
}

.parsed-line.matched {
  background: var(--accent-green-dim);
  border: 1px solid rgba(102, 187, 106, 0.15);
}

.parsed-line.unmatched {
  background: var(--accent-orange-dim);
  border: 1px solid rgba(255, 138, 101, 0.15);
}

.parsed-line.info {
  background: var(--accent-blue-dim);
  border: 1px solid rgba(79, 195, 247, 0.15);
}

.parsed-line.ignored {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--border-color);
  color: var(--text-tertiary);
}

.parsed-status {
  font-size: 1rem;
}

.parsed-text {
  flex: 1;
}

.parsed-match-name {
  font-weight: 600;
  color: var(--accent-green);
}

.parsed-qty {
  font-weight: 700;
  color: var(--accent-blue);
  margin-left: auto;
}

/* ─── Settings Panel ─────────────────────────────────────────────────────── */
.settings-grid {
  display: grid;
  grid-template-columns: 260px 1fr;
  gap: var(--space-md);
  min-height: 500px;
}

@media (max-width: 900px) {
  .settings-grid {
    grid-template-columns: 1fr;
  }
}

.campaign-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
}

.campaign-item {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all var(--transition-fast);
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--text-secondary);
  border: 1px solid transparent;
}

.campaign-item:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.campaign-item.active {
  background: var(--accent-blue-dim);
  color: var(--accent-blue);
  border-color: rgba(79, 195, 247, 0.15);
  font-weight: 600;
}

.campaign-item .campaign-icon {
  font-size: 1.1rem;
}

.campaign-item .campaign-count {
  margin-left: auto;
  font-size: 0.72rem;
  background: rgba(255, 255, 255, 0.06);
  padding: 1px 8px;
  border-radius: var(--radius-full);
  font-weight: 600;
}

/* Product Editor */
.product-editor {
  overflow-y: auto;
  max-height: 70vh;
}

.product-editor-item {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: var(--space-md);
  margin-bottom: var(--space-sm);
  transition: all var(--transition-fast);
}

.product-editor-item:hover {
  border-color: var(--border-glow);
}

.product-editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-sm);
}

.product-editor-name {
  font-weight: 700;
  color: var(--text-primary);
  font-size: 0.92rem;
}

.product-editor-spec {
  font-size: 0.78rem;
  color: var(--text-tertiary);
}

.tier-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: var(--space-sm);
  margin-top: var(--space-sm);
}

.tier-item {
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  padding: var(--space-sm);
  text-align: center;
}

.tier-label {
  font-size: 0.7rem;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.3px;
  font-weight: 600;
  margin-bottom: 2px;
}

.tier-price {
  font-size: 0.88rem;
  font-weight: 700;
  color: var(--accent-blue);
  font-variant-numeric: tabular-nums;
}

/* FOC Rules Editor */
.foc-rules-list {
  margin-top: var(--space-sm);
}

.foc-rule-item {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-xs) 0;
  font-size: 0.82rem;
  color: var(--text-secondary);
}

.foc-rule-item .foc-badge {
  font-size: 0.7rem;
}

/* ─── Data Actions ───────────────────────────────────────────────────────── */
.data-actions {
  display: flex;
  gap: var(--space-sm);
  flex-wrap: wrap;
  padding: var(--space-md) 0;
  border-top: 1px solid var(--border-color);
  margin-top: var(--space-md);
}

/* ─── Toast Notification ─────────────────────────────────────────────────── */
.toast-container {
  position: fixed;
  top: var(--space-lg);
  right: var(--space-lg);
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}

.toast {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: var(--space-md) var(--space-lg);
  backdrop-filter: blur(16px);
  box-shadow: var(--shadow-lg);
  animation: toastIn 0.3s ease;
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  min-width: 280px;
  max-width: 400px;
}

.toast.success {
  border-left: 3px solid var(--accent-green);
}

.toast.error {
  border-left: 3px solid var(--accent-red);
}

.toast.info {
  border-left: 3px solid var(--accent-blue);
}

.toast-icon {
  font-size: 1.2rem;
}

.toast-text {
  font-size: 0.85rem;
  color: var(--text-primary);
  font-weight: 500;
}

@keyframes toastIn {
  from { opacity: 0; transform: translateX(30px); }
  to { opacity: 1; transform: translateX(0); }
}

@keyframes toastOut {
  from { opacity: 1; transform: translateX(0); }
  to { opacity: 0; transform: translateX(30px); }
}

/* ─── Copy Summary ───────────────────────────────────────────────────────── */
.copy-summary-btn {
  position: relative;
}

.copy-summary-btn::after {
  content: 'Đã copy!';
  position: absolute;
  top: -28px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--accent-green);
  color: var(--text-on-accent);
  padding: 2px 10px;
  border-radius: var(--radius-sm);
  font-size: 0.72rem;
  font-weight: 600;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--transition-fast);
}

.copy-summary-btn.copied::after {
  opacity: 1;
}

/* ─── Product Search Dropdown ────────────────────────────────────────────── */
.search-dropdown-container {
  position: relative;
  margin-top: var(--space-md);
}

.product-search-input {
  width: 100%;
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  padding: var(--space-sm) var(--space-md);
  padding-left: 36px;
  color: var(--text-primary);
  font-family: var(--font-family);
  font-size: 0.85rem;
  outline: none;
  transition: border-color var(--transition-fast);
}

.product-search-input:focus {
  border-color: var(--accent-blue);
}

.search-icon {
  position: absolute;
  left: var(--space-md);
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-tertiary);
  font-size: 0.88rem;
  pointer-events: none;
}

.search-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-top: none;
  border-radius: 0 0 var(--radius-md) var(--radius-md);
  max-height: 260px;
  overflow-y: auto;
  z-index: 100;
  display: none;
  box-shadow: var(--shadow-lg);
}

.search-dropdown.visible {
  display: block;
}

.search-dropdown-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-sm) var(--space-md);
  cursor: pointer;
  transition: background var(--transition-fast);
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
}

.search-dropdown-item:hover {
  background: var(--surface-hover);
}

.search-dropdown-item .item-name {
  font-weight: 600;
  font-size: 0.85rem;
  color: var(--text-primary);
}

.search-dropdown-item .item-campaign {
  font-size: 0.72rem;
  color: var(--text-tertiary);
}

.search-dropdown-item .item-price {
  font-size: 0.8rem;
  color: var(--accent-blue);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

/* ─── Payment note ───────────────────────────────────────────────────────── */
.payment-note {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  background: var(--accent-blue-dim);
  border: 1px solid rgba(79, 195, 247, 0.15);
  border-radius: var(--radius-sm);
  margin-top: var(--space-sm);
  font-size: 0.82rem;
  color: var(--accent-blue);
  font-weight: 500;
}

/* ─── Animations ─────────────────────────────────────────────────────────── */
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.loading {
  animation: pulse 1.5s infinite;
}

/* Row removal animation */
.order-table tbody tr.removing {
  animation: rowRemove 0.3s ease forwards;
}

@keyframes rowRemove {
  to {
    opacity: 0;
    transform: translateX(20px);
    max-height: 0;
    padding: 0;
  }
}

/* ─── Responsive ─────────────────────────────────────────────────────────── */
@media (max-width: 768px) {
  html { font-size: 13px; }

  .app-container {
    padding: var(--space-md);
  }

  .app-header h1 {
    font-size: 1.5rem;
  }

  .order-layout {
    grid-template-columns: 1fr;
  }

  .input-panel {
    position: static;
  }

  .customer-info {
    grid-template-columns: 1fr;
  }

  .order-summary {
    grid-template-columns: 1fr;
  }

  .settings-grid {
    grid-template-columns: 1fr;
  }
}

/* ─── Select Styles ──────────────────────────────────────────────────────── */
select.input-field {
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238b95a8' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
  padding-right: 30px;
  cursor: pointer;
}

select.input-field option {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

/* ─── Unmatched Row Highlight ────────────────────────────────────────────── */
.order-table tbody tr.unmatched-row {
  background: var(--accent-orange-dim);
}

.order-table tbody tr.unmatched-row td {
  color: var(--accent-orange);
}

/* ─── Hidden file input ──────────────────────────────────────────────────── */
.hidden-input {
  display: none;
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  NEW: AI Detection Card                                                    */
/* ═══════════════════════════════════════════════════════════════════════════ */
.ai-detection-card {
  border-left: 3px solid var(--accent-purple);
  background: linear-gradient(135deg, rgba(171, 71, 188, 0.06) 0%, var(--bg-card) 100%);
}

.ai-result-row {
  display: flex;
  align-items: center;
  gap: var(--space-md);
  flex-wrap: wrap;
}

.ai-campaign-badge {
  font-size: 1.05rem;
  font-weight: 700;
  padding: var(--space-sm) var(--space-lg);
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  white-space: nowrap;
}

.ai-confidence {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

.confidence-bar {
  width: 160px;
  height: 7px;
  background: rgba(255, 255, 255, 0.08);
  border-radius: var(--radius-full);
  overflow: hidden;
}

.confidence-fill {
  height: 100%;
  border-radius: var(--radius-full);
  transition: width 0.6s cubic-bezier(0.34, 1.56, 0.64, 1);
  background: var(--gradient-primary);
}

.confidence-fill.high {
  background: var(--gradient-success);
}

.confidence-fill.medium {
  background: var(--gradient-warning);
}

.confidence-fill.low {
  background: var(--gradient-danger);
}

.confidence-text {
  font-size: 0.85rem;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  min-width: 40px;
}

.ai-details {
  margin-top: var(--space-md);
  padding-top: var(--space-sm);
  border-top: 1px solid var(--border-color);
}

.ai-override {
  margin-top: var(--space-md);
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  font-size: 0.82rem;
  color: var(--text-secondary);
}

.ai-override label {
  white-space: nowrap;
  font-weight: 500;
}

.ai-override select {
  max-width: 220px;
}

/* Score bars (inside AI details) */
.score-bar-container {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin: 3px 0;
}

.score-bar-label {
  font-size: 0.72rem;
  width: 130px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.score-bar {
  flex: 1;
  height: 5px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: var(--radius-full);
  overflow: hidden;
}

.score-bar-fill {
  height: 100%;
  border-radius: var(--radius-full);
  transition: width 0.4s ease;
}

.score-bar-value {
  font-size: 0.7rem;
  font-weight: 700;
  color: var(--text-tertiary);
  min-width: 28px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  NEW: PDF Import Drop Zone                                                 */
/* ═══════════════════════════════════════════════════════════════════════════ */
.pdf-drop-zone {
  border: 2px dashed var(--border-color);
  border-radius: var(--radius-lg);
  padding: var(--space-2xl) var(--space-xl);
  text-align: center;
  cursor: pointer;
  transition: all var(--transition-normal);
  color: var(--text-tertiary);
  font-size: 0.88rem;
}

.pdf-drop-zone:hover,
.pdf-drop-zone.drag-over {
  border-color: var(--accent-blue);
  background: var(--accent-blue-dim);
  color: var(--accent-blue);
}

.pdf-drop-zone .drop-icon {
  font-size: 2.5rem;
  margin-bottom: var(--space-sm);
  display: block;
}

.pdf-drop-zone p {
  line-height: 1.6;
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  NEW: Modal Overlay                                                        */
/* ═══════════════════════════════════════════════════════════════════════════ */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.75);
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(6px);
  animation: fadeIn 0.2s ease;
}

.modal-content {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  padding: var(--space-xl);
  max-width: 640px;
  width: 92%;
  max-height: 85vh;
  overflow-y: auto;
  box-shadow: var(--shadow-lg);
  animation: modalIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

@keyframes modalIn {
  from { opacity: 0; transform: scale(0.95) translateY(10px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-lg);
  padding-bottom: var(--space-md);
  border-bottom: 1px solid var(--border-color);
}

.modal-title {
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  NEW: Dynamic Form Rows (Tier / FOC)                                       */
/* ═══════════════════════════════════════════════════════════════════════════ */
.tier-row,
.foc-row {
  display: grid;
  gap: var(--space-xs);
  margin-bottom: var(--space-xs);
  animation: slideIn 0.2s ease;
}

.tier-row {
  grid-template-columns: 1fr 1fr 1.3fr 1fr auto;
}

.foc-row {
  grid-template-columns: 0.8fr 0.8fr 0.8fr 1.5fr auto;
}

.tier-row input,
.foc-row input,
.tier-row select,
.foc-row select {
  font-size: 0.8rem;
  padding: var(--space-xs) var(--space-sm);
}

.form-section-title {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-sm);
  margin-top: var(--space-md);
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  NEW: Alias Tags                                                           */
/* ═══════════════════════════════════════════════════════════════════════════ */
.alias-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: var(--space-sm);
}

.alias-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--accent-purple-dim);
  color: var(--accent-purple);
  padding: 3px 10px;
  border-radius: var(--radius-full);
  font-size: 0.75rem;
  font-weight: 500;
  animation: scaleIn 0.2s ease;
}

@keyframes scaleIn {
  from { opacity: 0; transform: scale(0.8); }
  to { opacity: 1; transform: scale(1); }
}

.alias-tag button {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 0.85rem;
  padding: 0 2px;
  opacity: 0.6;
  transition: opacity var(--transition-fast);
}

.alias-tag button:hover {
  opacity: 1;
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  NEW: Settings action buttons                                              */
/* ═══════════════════════════════════════════════════════════════════════════ */
.settings-actions {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  margin-top: var(--space-md);
  padding-top: var(--space-md);
  border-top: 1px solid var(--border-color);
}

.settings-actions .btn {
  justify-content: flex-start;
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  NEW: Campaign form color picker                                           */
/* ═══════════════════════════════════════════════════════════════════════════ */
.color-picker-row {
  display: flex;
  gap: var(--space-sm);
  flex-wrap: wrap;
}

.color-swatch {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  border: 2px solid transparent;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.color-swatch:hover,
.color-swatch.selected {
  border-color: var(--text-primary);
  transform: scale(1.15);
  box-shadow: var(--shadow-sm);
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  NEW: PDF progress & status                                                */
/* ═══════════════════════════════════════════════════════════════════════════ */
.pdf-status {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  border-radius: var(--radius-sm);
  font-size: 0.82rem;
  margin-top: var(--space-sm);
}

.pdf-status.processing {
  background: var(--accent-blue-dim);
  color: var(--accent-blue);
}

.pdf-status.success {
  background: var(--accent-green-dim);
  color: var(--accent-green);
}

.pdf-status.error {
  background: var(--accent-red-dim);
  color: var(--accent-red);
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  NEW: Inline edit mode for product editor                                  */
/* ═══════════════════════════════════════════════════════════════════════════ */
.product-editor-item.editing {
  border-color: var(--accent-blue);
  background: var(--accent-blue-dim);
}

.product-editor-actions {
  display: flex;
  gap: var(--space-xs);
}

/* Responsive for dynamic rows */
@media (max-width: 768px) {
  .tier-row {
    grid-template-columns: 1fr 1fr;
  }

  .foc-row {
    grid-template-columns: 1fr 1fr;
  }

  .ai-result-row {
    flex-direction: column;
    align-items: flex-start;
  }

  .confidence-bar {
    width: 100%;
  }

  .score-bar-label {
    width: 80px;
  }
}

/* Gift rows styling */
.order-table tr.gift-row {
  background-color: rgba(76, 175, 80, 0.08) !important;
  color: var(--accent-green);
}
.order-table tr.gift-row td {
  border-bottom: 1px dashed rgba(76, 175, 80, 0.2);
}
.gift-badge {
  background: var(--accent-green-dim);
  color: var(--accent-green);
  font-size: 0.7rem;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  text-transform: uppercase;
  margin-left: var(--space-xs);
  display: inline-block;
}

/* Searchable Combobox inline style */
.combobox-container {
  position: relative;
  width: 100%;
  max-width: 380px;
}
.combobox-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  max-height: 250px;
  overflow-y: auto;
  z-index: 100;
  display: none;
  box-shadow: var(--shadow-lg);
}
.combobox-dropdown.visible {
  display: block;
}
.combobox-item {
  padding: 6px 12px;
  cursor: pointer;
  font-size: 0.85rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.02);
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.combobox-item:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}
.combobox-item-name {
  font-weight: 500;
}
.combobox-item-campaign {
  font-size: 0.72rem;
  color: var(--text-tertiary);
}

/* Campaign promotions rules list styling */
.mkt-gift-rule-row {
  display: grid;
  grid-template-columns: 1fr 1fr 0.8fr 2fr auto;
  gap: var(--space-xs);
  margin-bottom: var(--space-xs);
  align-items: center;
}
.foc-rule-row {
  display: grid;
  grid-template-columns: 0.8fr 0.8fr 0.8fr 2fr 1.5fr auto;
  gap: var(--space-xs);
  margin-bottom: var(--space-xs);
  align-items: center;
}

```

---

## 4. app.js
```javascript
/**
 * =========================================================================
 *  ORDER AUTOMATION - APPLICATION LOGIC (app.js) v3
 * =========================================================================
 *  Core: AI classifier, text parser, price calculator, promotion engine,
 *  full CRUD database management, alias manager.
 *  
 *  v3 Changes: All event handlers attached via JS (no inline onclick),
 *  robust error handling, offline-first mode.
 *  
 *  KiotViet Integration (cập nhật):
 *  - Playwright automation ĐÃ LOẠI BỎ (không còn kv-automation.js)
 *  - Thay bằng JSON export + browser-use MCP skill
 *  - launchKiotVietAutomation() xuất kiotvietData JSON → ghi file → mở KiotViet
 *  - AI agent (browser-use MCP) đọc JSON và nhập liệu tự động trên KiotViet
 *  
 *  Excel Export:
 *  - Gửi JSON tới local HTTP server (port 8046)
 *  - Server gọi excel-automation.ps1 điền template Excel theo brand
 *  - FOC rows: xóa ô đỏ (category, spec, giá, mã KT), hỗ trợ drag-and-drop độc lập
 * =========================================================================
 */

// ─── State ──────────────────────────────────────────────────────────────────
let currentOrder = {
  customer: '',
  payment: 'ck',
  items: [],
  customPromos: [],
  parsedLines: [],
  aiResult: null,
};
let selectedSettingsCampaign = null;

// ─── Tab Navigation ─────────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const panelId = 'panel' + capitalize(tab.dataset.tab);
      const panel = document.getElementById(panelId);
      if (panel) panel.classList.add('active');
      if (tab.dataset.tab === 'catalog') renderCatalog();
      if (tab.dataset.tab === 'settings') renderSettingsSidebar();
    });
  });
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ═══════════════════════════════════════════════════════════════════════════
//  TEXT PARSER
// ═══════════════════════════════════════════════════════════════════════════
function parseOrderText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const results = [];
  
  // Allow leading bullets, dashes, numbers, etc. (e.g. "- 3 thùng" or "1. 3 thùng")
  const qtyPattern = /^[-*•+0-9.]*\s*(?:tặng|tang|foc|free)?\s*(\d+)\s*(thùng|thg|thung|carton|ctn|box|chai|lon|can|bottle|btl|phuy|phụy|drum|bộ|bo|lít|lit|hộp|hop|pcs|cái|cai|kg|túi|tui)\b/i;
  
  const paymentPatterns = [
    { pattern: /\btt\s*ck\b/i, value: 'ck', label: 'Chuyển khoản' },
    { pattern: /\bchuyển\s*khoản\b/i, value: 'ck', label: 'Chuyển khoản' },
    { pattern: /\bck\b/i, value: 'ck', label: 'Chuyển khoản' },
    { pattern: /\bcod\b/i, value: 'cod', label: 'COD' },
    { pattern: /\bcông\s*nợ\b/i, value: 'congno', label: 'Công nợ' },
    { pattern: /\btiền\s*mặt\b/i, value: 'tt', label: 'Tiền mặt' },
    { pattern: /\btt\b/i, value: 'tt', label: 'Thanh toán trực tiếp' },
  ];

  let customerDetected = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineResult = { raw: line, type: 'unknown', data: null };

    // Payment detection
    let isPayment = false;
    for (const pp of paymentPatterns) {
      if (pp.pattern.test(line) && line.length < 20) {
        lineResult.type = 'payment';
        lineResult.data = { value: pp.value, label: pp.label };
        isPayment = true;
        break;
      }
    }

    if (!isPayment) {
      const qtyMatch = line.match(qtyPattern);
      if (qtyMatch) {
        const qty = parseInt(qtyMatch[1]);
        const unit = normalizeUnit(qtyMatch[2]);
        const rawProduct = line.substring(qtyMatch[0].length).trim();
        
        let cleanedProduct = rawProduct;
        let explicitPrice = undefined;
        let explicitGift = undefined;
        
        // Detect standalone FOC/free/gift items
        if (/\b(?:foc|tặng|tang|quà|qua|free)\b/i.test(line)) {
          explicitPrice = 0;
        }
        
        // 1. Detect and extract explicit price override
        const priceRegex = /(?:(?:giá|gia|price)\s*:?\s*(\d+(?:\.\d+)?)\s*(k|K|đ|d|đ\b|d\b)?(?:\/(chai|lon|can|thùng|thg|thung|carton|ctn|box|bottle|btl))?)|(?:\b(\d+(?:\.\d+)?)\s*(k|K)\b(?:\/(chai|lon|can|thùng|thg|thung|carton|ctn|box|bottle|btl))?)/i;
        const priceMatch = cleanedProduct.match(priceRegex);
        if (priceMatch) {
          const valStr = priceMatch[1] || priceMatch[4];
          const unitIndicator = priceMatch[2] || priceMatch[5] || '';
          
          let val = parseFloat(valStr);
          if (unitIndicator.toLowerCase() === 'k') {
            val = val * 1000;
          } else if (val < 1000) {
            val = val * 1000;
          }
          
          explicitPrice = val;
          cleanedProduct = cleanedProduct.replace(priceMatch[0], '');
        }
        
        // 2. Detect and extract explicit gift override
        const giftRegex = /(?:\d+\s*(?:thùng|thg|thung|carton|ctn|box|chai|lon|can|bottle|btl)\s+)?(?:tặng|tang)\s*(\d+)\s*([a-zA-ZÀ-ỹ\s\d\.]+?)(?:$|;|\n|\.|\:|,)/i;
        const giftMatch = cleanedProduct.match(giftRegex);
        if (giftMatch) {
          const giftQty = parseInt(giftMatch[1]);
          const rawGiftProduct = giftMatch[2].trim();
          let giftName = rawGiftProduct.replace(/[.,;:!\-\s]+$/, '').trim();
          let giftUnit = 'cái';
          
          const giftNameLower = giftName.toLowerCase();
          if (giftNameLower.includes('lon')) giftUnit = 'lon';
          else if (giftNameLower.includes('chai')) giftUnit = 'chai';
          else if (giftNameLower.includes('can')) giftUnit = 'can';
          else if (giftNameLower.includes('tuyp') || giftNameLower.includes('tuýp')) giftUnit = 'tuýp';
          else if (giftNameLower.includes('ao') || giftNameLower.includes('áo')) giftUnit = 'áo';
          else if (giftNameLower.includes('non') || giftNameLower.includes('nón')) giftUnit = 'nón';
          
          explicitGift = { qty: giftQty, name: giftName, unit: giftUnit };
          cleanedProduct = cleanedProduct.replace(giftMatch[0], '');
        }
        
        // Clean leftover separators
        cleanedProduct = cleanedProduct.replace(/^[:\s,.\-]+|[:\s,.\-]+$/g, '').trim();
        
        // Perform fuzzy matching
        const match = findBestProductMatch(cleanedProduct);
        lineResult.type = match ? 'matched' : 'unmatched';
        lineResult.data = { 
          qty, 
          unit, 
          rawProduct: cleanedProduct || rawProduct, 
          matchedProduct: match ? match.product : null, 
          matchScore: match ? match.score : 0,
          explicitPrice,
          explicitGift
        };
      } else if (i === 0 && !/\d/.test(line.charAt(0))) {
        lineResult.type = 'customer';
        lineResult.data = { name: line };
        customerDetected = line;
      } else {
        lineResult.type = 'ignored';
      }
    }
    results.push(lineResult);
  }
  return { lines: results, customerDetected };
}

function normalizeUnit(raw) {
  const lower = raw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
  const map = { 'thung': 'thùng', 'thg': 'thùng', 'carton': 'thùng', 'ctn': 'thùng', 'box': 'thùng', 'chai': 'chai', 'lon': 'chai', 'bottle': 'chai', 'btl': 'chai', 'can': 'can', 'phuy': 'phuy', 'drum': 'phuy', 'bo': 'bộ', 'lit': 'lít', 'hop': 'hộp', 'pcs': 'pcs', 'cai': 'pcs', 'kg': 'kg', 'tui': 'túi', 'túi': 'túi' };
  return map[lower] || raw;
}

// ═══════════════════════════════════════════════════════════════════════════
//  FUZZY MATCHING
// ═══════════════════════════════════════════════════════════════════════════
function findBestProductMatch(rawText) {
  if (!rawText || rawText.trim().length === 0) return null;
  const normalized = normalizeText(rawText);
  if (!normalized) return null;

  const aliases = db.getAliases();
  const sortedAliases = Object.entries(aliases).sort((a, b) => b[0].length - a[0].length);

  // 1. Exact alias match or full word match for aliases length >= 3
  for (const [alias, productId] of sortedAliases) {
    const aliasNorm = normalizeText(alias);
    if (!aliasNorm) continue;
    if (normalized === aliasNorm) {
      const product = db.findProductById(productId);
      if (product) return { product, score: 100 };
    }
    if (aliasNorm.length >= 4) {
      const regex = new RegExp('\\b' + aliasNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
      if (regex.test(normalized)) {
        const product = db.findProductById(productId);
        if (product) return { product, score: 98 };
      }
    }
  }

  // 2. Word-based alias match
  for (const [alias, productId] of sortedAliases) {
    const aliasNorm = normalizeText(alias);
    const aliasWords = aliasNorm.split(/\s+/).filter(Boolean);
    const textWords = normalized.split(/\s+/).filter(Boolean);
    if (aliasWords.length >= 2 && aliasWords.every(aw => textWords.some(tw => tw === aw || (aw.length >= 3 && tw.includes(aw))))) {
      const product = db.findProductById(productId);
      if (product) return { product, score: 90 };
    }
  }

  // 3. Fuzzy match all valid products
  const allProducts = db.getAllProducts();
  let bestMatch = null, bestScore = 0;
  for (const product of allProducts) {
    if (!product || !product.name || product.name === '1' || product.name === 'X' || product.name === 'ĐH 2.000.000') continue;
    const score = calculateMatchScore(normalized, product);
    if (score > bestScore && score >= 40) { bestScore = score; bestMatch = product; }
  }
  return bestMatch ? { product: bestMatch, score: bestScore } : null;
}

function normalizeText(text) {
  if (!text) return '';
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd')
    .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function calculateMatchScore(normalizedInput, product) {
  if (!product || !product.name || product.name === '1' || product.name === 'X' || product.name === 'ĐH 2.000.000') return 0;
  const productName = normalizeText(product.name);
  const productSpec = normalizeText(product.spec || '');
  const inputWords = normalizedInput.split(/\s+/).filter(Boolean);
  const allProductWords = [...productName.split(/\s+/), ...productSpec.split(/\s+/)].filter(Boolean);
  let matchedWords = 0, totalWeight = 0;
  for (const iw of inputWords) {
    if (!iw) continue;
    let bestWordMatch = 0;
    for (const pw of allProductWords) {
      if (!pw) continue;
      if (pw === iw) { bestWordMatch = Math.max(bestWordMatch, 2); break; }
      if (pw.length >= 3 && iw.length >= 3 && (pw.includes(iw) || iw.includes(pw))) { bestWordMatch = Math.max(bestWordMatch, 1.5); }
      else if (levenshtein(iw, pw) <= 1 && iw.length >= 4) { bestWordMatch = Math.max(bestWordMatch, 1); }
    }
    matchedWords += bestWordMatch;
    totalWeight += 2;
  }
  return totalWeight === 0 ? 0 : Math.round((matchedWords / totalWeight) * 100);
}

function levenshtein(a, b) {
  const m = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      m[i][j] = a[i-1] === b[j-1] ? m[i-1][j-1] : Math.min(m[i-1][j]+1, m[i][j-1]+1, m[i-1][j-1]+1);
  return m[a.length][b.length];
}

// ═══════════════════════════════════════════════════════════════════════════
//  PRICE & PROMO CALCULATOR
// ═══════════════════════════════════════════════════════════════════════════

function calculateOrderItem(product, qty, unit) {
  const isBox = (unit === 'thùng');
  const boxSize = product.box_size || 12;
  const totalUnits = isBox ? qty * boxSize : qty;
  const boxEquivalent = isBox ? qty : qty / boxSize;

  const unitPrice = db.getPriceForQty(product, boxEquivalent);
  const subtotal = totalUnits * unitPrice;
  const foc = db.getFOCForQty(product, boxEquivalent);

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

// ═══════════════════════════════════════════════════════════════════════════
//  EXPLICIT PRICE CONVERSION HEURISTIC
// ═══════════════════════════════════════════════════════════════════════════
function getFinalUnitPrice(product, salesPrice, isBox) {
  if (!product) return salesPrice;
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
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  GIFT PROCESSING HEURISTIC
// ═══════════════════════════════════════════════════════════════════════════
function processExplicitGift(explicitGift, parentProduct, dbFoc) {
  if (!explicitGift) return null;
  let give_product_id = '';
  let note = 'Khuyến mãi theo tin nhắn sales';

  const name = (explicitGift.name || '').toLowerCase().trim();
  const unit = (explicitGift.unit || 'chai').toLowerCase().trim();

  // If the gift name is generic, default to parent product
  const isGeneric = name === '' || name === 'chai' || name === 'lon' || name === 'thùng' || name === 'can' || name === 'phuy' || name === 'hộp' || name === 'túi';
  if (isGeneric || (parentProduct && name === parentProduct.name.toLowerCase())) {
     give_product_id = parentProduct ? parentProduct.id : '';
  } else {
     const match = findBestProductMatch(explicitGift.name);
     if (match) {
        give_product_id = match.product.id;
     } else {
        give_product_id = explicitGift.name;
        note = 'Sản phẩm tặng không có trong DB';
     }
  }

  // Cross-reference with DB FOC
  if (dbFoc) {
     const dbGiftId = dbFoc.give_product || (parentProduct ? parentProduct.id : '');
     const dbGiftQty = dbFoc.total_give;
     if (give_product_id === dbGiftId && explicitGift.qty === dbGiftQty) {
        note = 'Khớp với chương trình KM';
     } else {
        const dbGiftProd = db.findProductById(dbGiftId);
        note = `⚠️ Khác với gốc: Tặng ${dbGiftQty} ${dbFoc.give_unit} ${dbGiftProd ? dbGiftProd.name : ''}`;
     }
  }

  return {
    total_give: explicitGift.qty,
    give_unit: unit,
    give_product: give_product_id,
    note: note
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  MAIN PARSE & DISPLAY
// ═══════════════════════════════════════════════════════════════════════════
async function parseOrder() {
  const text = document.getElementById('orderText').value.trim();
  if (!text) { showToast('Vui lòng nhập tin nhắn đơn hàng!', 'error'); return; }

  const btnParse = document.getElementById('btnParse');
  const originalBtnText = btnParse.innerHTML;
  
  const provider = document.getElementById('aiProvider').value;

  if (provider === 'none') {
    try {
      runOfflineParser(text);
    } catch (err) {
      console.error('Offline parser error:', err);
      showToast('Lỗi phân tích: ' + err.message, 'error');
    }
    return;
  }

  btnParse.disabled = true;
  btnParse.innerHTML = `⏳ AI đang phân tích đơn hàng...`;

  try {
    const systemPrompt = `Bạn là một AI chuyên phân tích đơn hàng dầu nhớt từ tin nhắn chat của Sales.
Nhiệm vụ của bạn là đọc tin nhắn đơn hàng và phân tích thành dữ liệu JSON cấu trúc chính xác.

[BỘ NHỚ QUY TẮC NGHIỆC VỤ & PHÂN TÍCH (BẮT BUỘC TUÂN THỦ)]:
${db.getMemory()}
- Standalone Gift parsing: Nếu tin nhắn có dòng tặng quà riêng lẻ (không đi kèm sản phẩm cụ thể ở trên, ví dụ: 'tặng 9 túi rút' ở cuối đơn), bạn hãy đưa quà tặng đó vào danh sách 'items' như một sản phẩm bình thường với 'explicitPrice' bằng 0 (hoặc null), và khớp 'productId' với sản phẩm quà tặng tương ứng trong Database nếu có (ví dụ: 'stringbag'), nếu không có thì để null.

Đoạn chat có thể viết tắt, không dấu, lộn xộn. Bạn cần trả về một JSON object có cấu trúc như sau:
{
  "customer": "Tên khách hàng hoặc tên cửa hàng (nếu có, ví dụ: 'Anywhere Man', nếu không rõ để null)",
  "payment": "Hình thức thanh toán: 'ck' (chuyển khoản, banking), 'cod' (thu hộ), 'tt' (tiền mặt, trực tiếp), 'congno' (công nợ), hoặc 'other' (nếu không rõ hoặc khác)",
  "items": [
    {
      "qty": 3,
      "unit": "thùng",
      "rawProduct": "Tên sản phẩm gốc ghi trên tin nhắn",
      "explicitPrice": 103000,
      "explicitGift": { "qty": 2, "name": "lon", "unit": "lon" }
    }
  ]
}

Hãy trả về DUY NHẤT một JSON object hợp lệ, không kèm giải thích hay markdown code block.`;

    // Load AI config from localStorage
    const aiConfig = getAiConfig();
    if (!aiConfig.apiKey) {
      throw new Error('Chưa cấu hình API Key! Vào tab Cài Đặt → Phân Tích Đơn Bằng AI → Nhập API Key.');
    }

    const aiEndpoint = getEndpointForProvider(aiConfig.provider, aiConfig.endpoint);
    const aiModel = aiConfig.model || getDefaultModel(aiConfig.provider);

    const response = await fetch(aiEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${aiConfig.apiKey}`
      },
      body: JSON.stringify({
        model: aiModel,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text }
        ],
        temperature: 0.1
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const resData = await response.json();
    const resultText = resData.choices[0].message.content.trim();
    const parsedJson = JSON.parse(resultText);

    currentOrder.customer = parsedJson.customer || '';
    if (currentOrder.customer) document.getElementById('customerName').value = currentOrder.customer;
    
    currentOrder.payment = parsedJson.payment || 'ck';
    document.getElementById('paymentMethod').value = currentOrder.payment;

    currentOrder.items = [];
    currentOrder.parsedLines = [];

    if (parsedJson.items && Array.isArray(parsedJson.items)) {
      parsedJson.items.forEach(item => {
        const match = findBestProductMatch(item.rawProduct || '');
        const product = match ? match.product : null;
        
        let finalManualPrice = null;
        let finalUnitPrice = 0;
        let finalSubtotal = 0;
        let finalFoc = null;
        let finalTierLabel = '';

        if (product) {
          const isBox = (item.unit === 'thùng');
          const boxSize = product.box_size || 12;
          
          const calc = calculateOrderItem(product, item.qty, item.unit);
          finalUnitPrice = calc.unitPrice;
          finalSubtotal = calc.subtotal;
          finalFoc = calc.foc;
          finalTierLabel = calc.tierLabel;

          if (item.explicitPrice !== undefined && item.explicitPrice !== null) {
            finalManualPrice = getFinalUnitPrice(product, item.explicitPrice, isBox);
            const totalUnits = isBox ? item.qty * boxSize : item.qty;
            finalSubtotal = finalManualPrice * totalUnits;
          }
          
          if (item.explicitGift) {
            finalFoc = processExplicitGift(item.explicitGift, product, calc.foc);
            finalTierLabel = 'Khuyến mãi tin nhắn';
          }

          currentOrder.items.push({
            product, qty: item.qty, unit: item.unit,
            unitPrice: finalUnitPrice, subtotal: finalSubtotal, foc: finalFoc, tierLabel: finalTierLabel, manualPrice: finalManualPrice
          });

          currentOrder.parsedLines.push({
            raw: item.rawProduct,
            type: 'matched',
            data: { qty: item.qty, unit: item.unit, rawProduct: item.rawProduct, matchedProduct: product }
          });
        } else {
          finalManualPrice = item.explicitPrice !== null && item.explicitPrice !== undefined ? item.explicitPrice : null;
          finalSubtotal = finalManualPrice !== null ? finalManualPrice * item.qty : 0;

          if (item.explicitGift) {
            finalFoc = processExplicitGift(item.explicitGift, null, null);
          }

          currentOrder.items.push({
            product: null, qty: item.qty, unit: item.unit, rawName: item.rawProduct,
            unitPrice: finalManualPrice !== null ? finalManualPrice : 0, subtotal: finalSubtotal, foc: finalFoc, tierLabel: item.explicitGift ? 'Khuyến mãi tin nhắn' : '', manualPrice: finalManualPrice
          });

          currentOrder.parsedLines.push({
            raw: item.rawProduct,
            type: 'unmatched',
            data: { qty: item.qty, unit: item.unit, rawProduct: item.rawProduct }
          });
        }
      });
    }

    const aiResult = classifyOrder(text);
    currentOrder.aiResult = aiResult;
    renderAIDetection(aiResult);

    renderParsedPreview(currentOrder.parsedLines);
    renderOrderResults();
    showToast(`Đã phân tích đơn hàng bằng AI thành công!`, 'success');

  } catch (err) {
    console.error('AI parse error:', err);
    showToast('Lỗi AI: ' + err.message + ' (Chuyển sang Offline)', 'error');
    try {
      runOfflineParser(text);
    } catch (offlineErr) {
      console.error('Offline parser also failed:', offlineErr);
      showToast('Lỗi phân tích offline: ' + offlineErr.message, 'error');
    }
  } finally {
    btnParse.disabled = false;
    btnParse.innerHTML = originalBtnText;
  }
}

function runOfflineParser(text) {
  const aiResult = classifyOrder(text);
  currentOrder.aiResult = aiResult;
  renderAIDetection(aiResult);

  const parsed = parseOrderText(text);
  if (parsed.customerDetected) document.getElementById('customerName').value = parsed.customerDetected;

  currentOrder.items = [];
  currentOrder.parsedLines = [];

  for (const line of parsed.lines) {
    if (line.type === 'matched' && line.data.matchedProduct) {
      const calc = calculateOrderItem(line.data.matchedProduct, line.data.qty, line.data.unit);
      
      let finalManualPrice = null;
      let finalUnitPrice = calc.unitPrice;
      let finalSubtotal = calc.subtotal;
      
      if (line.data.explicitPrice !== undefined && line.data.explicitPrice !== null) {
        const isBox = (line.data.unit === 'thùng');
        finalManualPrice = getFinalUnitPrice(line.data.matchedProduct, line.data.explicitPrice, isBox);
        const boxSize = line.data.matchedProduct.box_size || 12;
        const totalUnits = isBox ? line.data.qty * boxSize : line.data.qty;
        
        finalSubtotal = finalManualPrice * totalUnits;
      }
      
      let finalFoc = calc.foc;
      let finalTierLabel = calc.tierLabel;
      if (line.data.explicitGift) {
        finalFoc = {
          total_give: line.data.explicitGift.qty,
          give_unit: line.data.explicitGift.unit,
          give_product: line.data.explicitGift.name,
          note: 'Khuyến mãi theo tin nhắn sales'
        };
        finalTierLabel = 'Khuyến mãi tin nhắn';
      }

      currentOrder.items.push({
        product: line.data.matchedProduct, qty: line.data.qty, unit: line.data.unit,
        unitPrice: finalUnitPrice, subtotal: finalSubtotal, foc: finalFoc, tierLabel: finalTierLabel, manualPrice: finalManualPrice
      });
      currentOrder.parsedLines.push(line);
    } else if (line.type === 'unmatched') {
      let finalManualPrice = line.data.explicitPrice !== undefined ? line.data.explicitPrice : null;
      let finalSubtotal = finalManualPrice !== null ? finalManualPrice * line.data.qty : 0;
      
      let finalFoc = null;
      if (line.data.explicitGift) {
        finalFoc = {
          total_give: line.data.explicitGift.qty,
          give_unit: line.data.explicitGift.unit,
          give_product: line.data.explicitGift.name,
          note: 'Khuyến mãi theo tin nhắn sales'
        };
      }

      currentOrder.items.push({
        product: null, qty: line.data.qty, unit: line.data.unit, rawName: line.data.rawProduct,
        unitPrice: finalManualPrice !== null ? finalManualPrice : 0, subtotal: finalSubtotal, foc: finalFoc, tierLabel: line.data.explicitGift ? 'Khuyến mãi tin nhắn' : '', manualPrice: finalManualPrice
      });
      currentOrder.parsedLines.push(line);
    } else if (line.type === 'payment') {
      document.getElementById('paymentMethod').value = line.data.value;
      currentOrder.parsedLines.push(line);
    } else {
      currentOrder.parsedLines.push(line);
    }
  }

  currentOrder.customer = document.getElementById('customerName').value;
  currentOrder.payment = document.getElementById('paymentMethod').value;

  renderParsedPreview(currentOrder.parsedLines);
  renderOrderResults();
  showToast(`Đã phân tích đơn hàng (Chế độ Offline)!`, 'success');
}

// ═══════════════════════════════════════════════════════════════════════════
//  AI DETECTION UI
// ═══════════════════════════════════════════════════════════════════════════
function renderAIDetection(result) {
  const card = document.getElementById('aiDetectionCard');
  if (!card) return;
  card.style.display = '';

  // Campaign badge
  const badge = document.getElementById('aiCampaignBadge');
  if (result.primaryCampaign) {
    const campaign = db.data.campaigns[result.primaryCampaign];
    const name = campaign ? campaign.name : result.campaignLabel;
    const icon = campaign ? campaign.icon : '📦';
    const color = result.campaignColor || '#4fc3f7';
    badge.innerHTML = `${icon} ${name}`;
    badge.style.background = color + '22';
    badge.style.color = color;
  } else {
    badge.innerHTML = '❓ Không xác định';
    badge.style.background = 'rgba(255,255,255,0.05)';
    badge.style.color = 'var(--text-secondary)';
  }

  // Confidence bar
  const fill = document.getElementById('aiConfidenceFill');
  const confText = document.getElementById('aiConfidenceText');
  const pct = result.confidencePercent;
  fill.style.width = pct + '%';
  fill.className = 'confidence-fill ' + (pct >= 70 ? 'high' : pct >= 40 ? 'medium' : 'low');
  confText.textContent = pct + '%';
  confText.style.color = pct >= 70 ? 'var(--accent-green)' : pct >= 40 ? 'var(--accent-yellow)' : 'var(--accent-red)';

  // Score details
  const details = document.getElementById('aiDetails');
  let detailsHtml = '';
  const maxScore = Math.max(...Object.values(result.allScores), 1);
  for (const [key, score] of Object.entries(result.allScores)) {
    const campaign = db.data.campaigns[key];
    if (!campaign) continue;
    const pctBar = Math.round((score / maxScore) * 100);
    const color = campaign.color || '#666';
    detailsHtml += `<div class="score-bar-container">
      <span class="score-bar-label">${campaign.icon} ${campaign.name}</span>
      <div class="score-bar"><div class="score-bar-fill" style="width:${pctBar}%; background:${color}"></div></div>
      <span class="score-bar-value">${score}</span>
    </div>`;
  }
  details.innerHTML = detailsHtml;

  // Override dropdown
  const override = document.getElementById('aiOverrideCampaign');
  if (override && override.options.length <= 1) {
    for (const [key, campaign] of Object.entries(db.data.campaigns)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = `${campaign.icon} ${campaign.name}`;
      override.appendChild(opt);
    }
  }
}

function overrideCampaign() {
  const val = document.getElementById('aiOverrideCampaign').value;
  if (val && currentOrder.aiResult) {
    currentOrder.aiResult.primaryCampaign = val;
    const campaign = db.data.campaigns[val];
    if (campaign) {
      currentOrder.aiResult.campaignLabel = `${campaign.icon} ${campaign.name}`;
      currentOrder.aiResult.campaignColor = campaign.color;
      currentOrder.aiResult.confidencePercent = 100;
      currentOrder.aiResult.confidence = 1;
    }
    renderAIDetection(currentOrder.aiResult);
    showToast('Đã ghi đè chiến dịch!', 'info');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  RENDER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════
function renderParsedPreview(lines) {
  const container = document.getElementById('parsedPreview');
  if (!container) return;
  container.innerHTML = '';
  for (const line of lines) {
    const div = document.createElement('div');
    let icon = '❓', text = escapeHtml(line.raw), extra = '';
    switch (line.type) {
      case 'customer': icon = '👤'; text = `Khách hàng: <strong>${escapeHtml(line.data.name)}</strong>`; div.className = 'parsed-line info'; break;
      case 'matched': icon = '✅'; text = `${escapeHtml(line.data.rawProduct)}`; extra = `<span class="parsed-match-name">→ ${escapeHtml(line.data.matchedProduct.name)}</span><span class="parsed-qty">${line.data.qty} ${line.data.unit}</span>`; div.className = 'parsed-line matched'; break;
      case 'unmatched': icon = '⚠️'; text = `"${escapeHtml(line.data.rawProduct)}" — <em>Chưa khớp</em>`; extra = `<span class="parsed-qty">${line.data.qty} ${line.data.unit}</span>`; div.className = 'parsed-line unmatched'; break;
      case 'payment': icon = '💳'; text = `Thanh toán: <strong>${escapeHtml(line.data.label)}</strong>`; div.className = 'parsed-line info'; break;
      default: icon = '⏭️'; text = `<span style="text-decoration:line-through">${escapeHtml(line.raw)}</span>`; div.className = 'parsed-line ignored';
    }
    div.innerHTML = `<span class="parsed-status">${icon}</span> ${text} ${extra}`;
    container.appendChild(div);
  }
}

function parseMKTGiftString(giftStr) {
  if (!giftStr) return [];
  const parts = giftStr.split('+').map(p => p.trim());
  const gifts = [];
  parts.forEach(part => {
    const match = part.match(/^(\d+)\s+(.+)$/);
    if (match) {
      const qty = parseInt(match[1]);
      const name = match[2].trim();
      let unit = 'cái';
      const nameLower = name.toLowerCase();
      if (nameLower.includes('ao')) unit = 'áo';
      else if (nameLower.includes('non') || nameLower.includes('mu')) unit = 'nón';
      else if (nameLower.includes('tui') || nameLower.includes('balo')) unit = 'túi';
      else if (nameLower.includes('sticker')) unit = 'sticker';
      else if (nameLower.includes('moc khoa') || nameLower.includes('keyring')) unit = 'móc khóa';
      else if (nameLower.includes('ao mua') || nameLower.includes('raincoat')) unit = 'áo mưa';
      
      gifts.push({ qty, name, unit });
    } else {
      gifts.push({ qty: 1, name: part, unit: 'cái' });
    }
  });
  return gifts;
}

function getOrderTableRows() {
  const rows = [];
  let grandTotal = 0;
  let totalBoxes = 0;
  const campaignTotals = {};

  currentOrder.items.forEach((item, index) => {
    if (!item.product) {
      const bottlePrice = item.manualPrice !== null && item.manualPrice !== undefined ? item.manualPrice : (item.unitPrice || 0);
      const boxSize = 12;
      const boxPrice = bottlePrice * boxSize;
      const sub = bottlePrice * item.qty;
      item.subtotal = sub;
      grandTotal += sub;

      rows.push({
        type: 'unmatched',
        index,
        qty: item.qty,
        unit: item.unit,
        rawName: item.rawName,
        bottlePrice,
        boxPrice,
        boxSize,
        subtotal: sub
      });
    } else {
      const isBox = (item.unit === 'thùng');
      const boxSize = item.product.box_size || 12;
      const bottlePrice = item.manualPrice !== null && item.manualPrice !== undefined ? item.manualPrice : item.unitPrice;
      const boxPrice = bottlePrice * boxSize;
      const showPrice = isBox ? boxPrice : bottlePrice;
      const totalUnits = isBox ? item.qty * boxSize : item.qty;
      const sub = bottlePrice * totalUnits;
      
      item.subtotal = sub;
      grandTotal += sub;
      
      const boxesCount = isBox ? item.qty : item.qty / boxSize;
      totalBoxes += boxesCount;

      if (!campaignTotals[item.product.campaignKey]) {
        campaignTotals[item.product.campaignKey] = { amount: 0, boxes: 0 };
      }
      campaignTotals[item.product.campaignKey].amount += sub;
      campaignTotals[item.product.campaignKey].boxes += boxesCount;

      rows.push({
        type: 'matched',
        index,
        product: item.product,
        qty: item.qty,
        unit: item.unit,
        bottlePrice,
        boxPrice,
        boxSize,
        showPrice,
        subtotal: sub,
        tierLabel: item.tierLabel
      });

      if (item.foc) {
        const giftId = 'foc_' + index;
        let giftProductId = item.foc.give_product || null;
        if (currentOrder.giftOverrides && currentOrder.giftOverrides[giftId] !== undefined) {
          giftProductId = currentOrder.giftOverrides[giftId];
        }
        
        let giftName = item.foc.give_product ? '' : item.product.name;
        if (giftProductId) {
          const giftProd = db.findProductById(giftProductId);
          if (giftProd) giftName = giftProd.name;
        } else if (!giftProductId && item.foc.give_product) {
          const giftProd = db.findProductById(item.foc.give_product);
          if (giftProd) giftName = giftProd.name;
        }

        rows.push({
          type: 'gift',
          giftId: giftId,
          giftSource: 'FOC',
          name: giftName || '— Khác —',
          productId: giftProductId,
          qty: item.foc.total_give,
          unit: item.foc.give_unit,
          spec: 'Miễn phí',
          note: item.foc.note,
          campaignIcon: item.product.campaignIcon,
          campaignName: item.product.campaignName,
          campaignColor: item.product.campaignColor
        });
      }
    }
  });

  for (const [key, totals] of Object.entries(campaignTotals)) {
    const giftRule = db.getMKTGifts(key, totals.amount, totals.boxes);
    if (giftRule) {
      const campaign = db.data.campaigns[key];
      if (!campaign) continue;
      const parsedGifts = parseMKTGiftString(giftRule.gifts);
      parsedGifts.forEach((g, gIdx) => {
        const giftId = 'mkt_' + key + '_' + gIdx;
        let giftProductId = null;
        let giftName = g.name;
        
        const initialMatch = findBestProductMatch(g.name);
        if (initialMatch && initialMatch.product) {
          giftProductId = initialMatch.product.id;
          giftName = initialMatch.product.name;
        }

        if (currentOrder.giftOverrides && currentOrder.giftOverrides[giftId] !== undefined) {
          giftProductId = currentOrder.giftOverrides[giftId];
          const overrideProd = db.findProductById(giftProductId);
          if (overrideProd) {
             giftName = overrideProd.name;
          } else if (!giftProductId) {
             giftName = '— Khác —';
          }
        }

        rows.push({
          type: 'gift',
          giftId: giftId,
          giftSource: 'MKT',
          name: giftName,
          productId: giftProductId,
          qty: g.qty,
          unit: g.unit,
          spec: `Quà tặng Marketing (${giftRule.label})`,
          note: `Đạt mốc chiến dịch ${campaign.name}`,
          campaignIcon: campaign.icon,
          campaignName: campaign.name,
          campaignColor: campaign.color
        });
      });
    }
  }

  return { rows, grandTotal, totalBoxes, campaignTotals };
}

function buildSearchableComboboxHTML(index, selectedProduct, fallbackName = '') {
  const allProducts = db.getAllProducts();
  let displayName = fallbackName;
  if (selectedProduct) {
    displayName = selectedProduct.name;
    if (selectedProduct.packaging && !selectedProduct.name.toLowerCase().includes(selectedProduct.packaging.toLowerCase())) {
      displayName += ` [${selectedProduct.packaging}]`;
    }
  }
  const inputBorderColor = selectedProduct ? '' : 'border-color: var(--accent-orange);';

  let dropdownItemsHtml = `<div class="combobox-item" data-index="${index}" data-product-id="" data-search-text="">
    <span class="combobox-item-name" style="color:var(--text-secondary);">— Chưa khớp / Khác —</span>
  </div>`;
  
  allProducts.forEach(p => {
    const searchText = normalizeText(`${p.name} ${p.spec || ''} ${p.campaignName || ''}`);
    dropdownItemsHtml += `<div class="combobox-item" data-index="${index}" data-product-id="${p.id}" data-search-text="${searchText}">
      <span class="combobox-item-name">${p.campaignIcon || '📦'} ${escapeHtml(p.name)}</span>
      <span class="combobox-item-campaign" style="color:${p.campaignColor}">${escapeHtml(p.campaignName)}</span>
    </div>`;
  });

  return `<div class="combobox-container" id="combobox-container-${index}">
    <input type="text" class="input-field combobox-input" id="combobox-input-${index}" 
      value="${escapeHtml(displayName)}" 
      placeholder="Tìm sản phẩm (ví dụ: prostream)..." 
      style="padding: var(--space-xs); font-size: 0.88rem; width: 100%; ${inputBorderColor}" 
      data-combobox-index="${index}"
      autocomplete="off" />
    <div class="combobox-dropdown" id="combobox-dropdown-${index}">
      ${dropdownItemsHtml}
    </div>
  </div>`;
}

function changeRowProduct(index, productId) {
  const isGift = String(index).startsWith('foc_') || String(index).startsWith('mkt_');
  if (isGift) {
    currentOrder.giftOverrides = currentOrder.giftOverrides || {};
    currentOrder.giftOverrides[index] = productId;
    renderOrderResults();
    return;
  }
  
  const itemIndex = parseInt(index);
  const item = currentOrder.items[itemIndex];
  if (!item) return;
  
  if (!productId) {
    item.product = null;
    item.unitPrice = 0;
    item.subtotal = 0;
    item.foc = null;
    item.tierLabel = '';
    item.manualPrice = null;
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
      
      // Tự động ghi nhớ alias cho các đơn hàng sau
      if (item.rawProduct) {
        db.addAlias(item.rawProduct, productId);
        showToast(`Đã tự động ghi nhớ alias: "${item.rawProduct}" -> ${product.name}`, 'success');
      }
    }
  }
  renderOrderResults();
}

function renderOrderResults() {
  const tbody = document.getElementById('orderTableBody');
  const emptyState = document.getElementById('emptyState');
  const orderResults = document.getElementById('orderResults');
  const btnCopy = document.getElementById('btnCopy');

  if (!tbody || !emptyState || !orderResults) return;

  if (currentOrder.items.length === 0) {
    emptyState.style.display = ''; orderResults.style.display = 'none'; 
    if (btnCopy) btnCopy.style.display = 'none'; 
    return;
  }
  emptyState.style.display = 'none'; orderResults.style.display = ''; 
  if (btnCopy) btnCopy.style.display = '';
  tbody.innerHTML = '';

  const { rows, grandTotal, totalBoxes, campaignTotals } = getOrderTableRows();

  rows.forEach((row) => {
    const tr = document.createElement('tr');
    
    if (row.type === 'unmatched') {
      tr.className = 'unmatched-row';
      tr.innerHTML = `<td><button class="btn-delete-row" data-remove-index="${row.index}">✕</button></td>
        <td>
          <div class="product-cell" style="gap: var(--space-xs);">
            <div style="font-weight: 600; color: var(--accent-orange); margin-bottom: 2px;">⚠️ Dòng gốc: "${escapeHtml(row.rawName || 'Không xác định')}"</div>
            ${buildSearchableComboboxHTML(row.index, null)}
          </div>
        </td>
        <td class="text-center"><input type="number" class="editable-qty" value="${row.qty}" min="1" data-qty-index="${row.index}" /></td>
        <td class="text-right">
          <div class="dual-price-cell">
            <div class="price-row-item">
              <span class="price-label-badge">Chai</span>
              <input type="text" class="editable-price editable-price-bottle" value="${formatNumberWithDots(Math.round(row.bottlePrice))}" data-price-bottle-index="${row.index}" placeholder="Giá chai" />
            </div>
            <div class="price-row-item">
              <span class="price-label-badge">Thùng</span>
              <input type="text" class="editable-price editable-price-box" value="${formatNumberWithDots(Math.round(row.boxPrice))}" data-price-box-index="${row.index}" placeholder="Giá thùng" />
            </div>
          </div>
        </td>
        <td class="text-right subtotal-amount">${formatCurrency(row.subtotal || 0)}</td>`;
    } else if (row.type === 'matched') {
      const campColor = row.product.campaignColor || '#666';
      const campBadge = `<span class="product-campaign" style="background:${campColor}22;color:${campColor}">${row.product.campaignIcon||'📦'} ${escapeHtml(row.product.campaignName)}</span>`;

      tr.innerHTML = `<td><button class="btn-delete-row" data-remove-index="${row.index}">✕</button></td>
        <td>
          <div class="product-cell" style="gap: var(--space-xs);">
            ${buildSearchableComboboxHTML(row.index, row.product)}
            <span class="product-spec" style="margin-top: 4px;">${escapeHtml(row.product.spec||'')} · ${escapeHtml(row.product.packaging||'')}</span>
            ${campBadge}
          </div>
        </td>
        <td class="text-center"><input type="number" class="editable-qty" value="${row.qty}" min="1" data-qty-index="${row.index}" /></td>
        <td class="text-right">
          <div class="dual-price-cell">
            <div class="price-row-item">
              <span class="price-label-badge">Chai</span>
              <input type="text" class="editable-price editable-price-bottle" value="${formatNumberWithDots(Math.round(row.bottlePrice))}" data-price-bottle-index="${row.index}" title="Đơn giá chai (1 chai)" />
            </div>
            <div class="price-row-item">
              <span class="price-label-badge">Thùng</span>
              <input type="text" class="editable-price editable-price-box" value="${formatNumberWithDots(Math.round(row.boxPrice))}" data-price-box-index="${row.index}" title="Đơn giá thùng (${row.boxSize} chai/thùng)" />
            </div>
            ${row.tierLabel ? `<span class="price-tier">${escapeHtml(row.tierLabel)}</span>` : ''}
          </div>
        </td>
        <td class="text-right subtotal-amount">${formatCurrency(row.subtotal)}</td>`;
    } else if (row.type === 'gift') {
      tr.className = 'gift-row';
      const campColor = row.campaignColor || '#666';
      const campBadge = `<span class="product-campaign" style="background:${campColor}22;color:${campColor}">${row.campaignIcon||'📦'} ${escapeHtml(row.campaignName)}</span>`;
      const giftBadgeText = row.giftSource === 'FOC' ? 'Miễn phí' : 'MKT 0đ';
      
      const focNoteText = row.note ? `${escapeHtml(row.note)}` : '';
      const searchHtml = buildSearchableComboboxHTML(row.giftId, db.findProductById(row.productId), row.name);
      
      tr.innerHTML = `<td></td>
        <td><div class="product-cell"><div style="margin-bottom:4px;display:flex;align-items:center;gap:8px">${searchHtml}<span class="gift-badge">${giftBadgeText}</span></div><span class="product-spec">${focNoteText}</span>${campBadge}</div></td>
        <td class="text-center" style="font-weight:700;color:var(--accent-green);">${row.qty} ${row.unit}</td>
        <td class="text-right" style="color:var(--text-tertiary);">Miễn phí</td>
        <td class="text-right subtotal-amount" style="color:var(--text-tertiary);">Miễn phí</td>`;
    }
    
    tbody.appendChild(tr);
  });

  // Attach delegated event listeners for the dynamically created elements
  attachOrderTableListeners();

  const summaryProducts = document.getElementById('summaryProducts');
  const summaryBoxes = document.getElementById('summaryBoxes');
  const summaryTotal = document.getElementById('summaryTotal');
  if (summaryProducts) summaryProducts.textContent = currentOrder.items.filter(i => i.product).length;
  if (summaryBoxes) summaryBoxes.textContent = totalBoxes.toFixed(1).replace('.0', '');
  if (summaryTotal) summaryTotal.textContent = formatCurrency(grandTotal);

  // MKT gifts are now rendered as table rows, hide old section
  const mktSection = document.getElementById('mktGiftsSection');
  if (mktSection) mktSection.style.display = 'none';

  const paymentNote = document.getElementById('paymentNote');
  const paymentLabels = { ck:'Chuyển khoản (CK)', cod:'COD', tt:'Thanh toán trực tiếp', congno:'Công nợ', other:'Khác' };
  if (paymentNote) {
    paymentNote.style.display = '';
    const paymentNoteText = document.getElementById('paymentNoteText');
    if (paymentNoteText) {
      paymentNoteText.textContent = `Phương thức: ${paymentLabels[document.getElementById('paymentMethod').value] || ''}`;
    }
  }
}

function attachOrderTableListeners() {
  // Remove buttons
  document.querySelectorAll('.btn-delete-row[data-remove-index]').forEach(btn => {
    btn.addEventListener('click', function() {
      const index = parseInt(this.getAttribute('data-remove-index'));
      removeOrderItem(index);
    });
  });

  // Qty inputs
  document.querySelectorAll('.editable-qty[data-qty-index]').forEach(input => {
    input.addEventListener('change', function() {
      const index = parseInt(this.getAttribute('data-qty-index'));
      updateItemQty(index, this.value);
    });
  });

  // Bottle price inputs (Chai)
  document.querySelectorAll('.editable-price-bottle[data-price-bottle-index]').forEach(input => {
    input.addEventListener('input', function() {
      const index = parseInt(this.getAttribute('data-price-bottle-index'));
      updateDualPriceLive(index, 'bottle', this);
    });
    input.addEventListener('change', function() {
      const index = parseInt(this.getAttribute('data-price-bottle-index'));
      updateDualPriceLive(index, 'bottle', this);
    });
  });

  // Box price inputs (Thùng)
  document.querySelectorAll('.editable-price-box[data-price-box-index]').forEach(input => {
    input.addEventListener('input', function() {
      const index = parseInt(this.getAttribute('data-price-box-index'));
      updateDualPriceLive(index, 'box', this);
    });
    input.addEventListener('change', function() {
      const index = parseInt(this.getAttribute('data-price-box-index'));
      updateDualPriceLive(index, 'box', this);
    });
  });

  // Combobox inputs
  document.querySelectorAll('.combobox-input[data-combobox-index]').forEach(input => {
    input.addEventListener('focus', function() {
      showComboboxDropdown(this.getAttribute('data-combobox-index'));
    });
    input.addEventListener('input', function() {
      filterComboboxOptions(this.getAttribute('data-combobox-index'), this.value);
    });
  });

  // Combobox items (delegated)
  document.querySelectorAll('.combobox-item[data-index]').forEach(item => {
    item.addEventListener('click', function() {
      const index = this.getAttribute('data-index');
      const productId = this.getAttribute('data-product-id') || '';
      selectComboboxItem(index, productId);
    });
  });
}

function renderMKTGifts(campaignTotals) {
  const section = document.getElementById('mktGiftsSection');
  if (!section) return;
  section.innerHTML = '';
  let hasGifts = false;
  for (const [key, totals] of Object.entries(campaignTotals)) {
    const gift = db.getMKTGifts(key, totals.amount, totals.boxes);
    if (gift) {
      hasGifts = true;
      const campaign = db.data.campaigns[key];
      if (!campaign) continue;
      section.innerHTML += `<div class="mkt-gift-card"><div class="mkt-gift-title">🎁 Quà MKT — ${campaign.name}</div><div class="mkt-gift-content">${escapeHtml(gift.gifts)}</div><div class="mkt-gift-label">Mốc: ${gift.label} ${gift.unit === 'boxes' ? `(${totals.boxes} thùng)` : `(${formatCurrency(totals.amount)})`}</div></div>`;
    }
  }
  section.style.display = hasGifts ? '' : 'none';
}

// ═══════════════════════════════════════════════════════════════════════════
//  ITEM EDITING
// ═══════════════════════════════════════════════════════════════════════════
function updateItemQty(index, val) {
  const item = currentOrder.items[index]; if (!item) return;
  item.qty = parseInt(val) || 1;
  if (item.product) {
    const calc = calculateOrderItem(item.product, item.qty, item.unit);
    if (item.manualPrice === null) item.unitPrice = calc.unitPrice;
    item.foc = calc.foc; item.tierLabel = calc.tierLabel;
    
    const isBox = (item.unit === 'thùng');
    const boxSize = item.product.box_size || 12;
    const totalUnits = isBox ? item.qty * boxSize : item.qty;
    item.subtotal = (item.manualPrice !== null ? item.manualPrice : item.unitPrice) * totalUnits;
  }
  renderOrderResults();
}

function updateItemPrice(index, val) {
  const item = currentOrder.items[index]; if (!item) return;
  const inputVal = parseInt(val) || 0;
  
  if (item.product) {
    const isBox = (item.unit === 'thùng');
    const boxSize = item.product.box_size || 12;
    item.manualPrice = isBox ? inputVal / boxSize : inputVal;
    
    const totalUnits = isBox ? item.qty * boxSize : item.qty;
    item.subtotal = item.manualPrice * totalUnits;
  } else {
    item.manualPrice = inputVal;
    item.subtotal = item.manualPrice * item.qty;
  }
  renderOrderResults();
}

function updateDualPriceLive(index, source, inputEl) {
  const item = currentOrder.items[index];
  if (!item) return;

  const numericVal = formatInputWithDotsAndPreserveCursor(inputEl);
  const boxSize = (item.product && item.product.box_size) ? item.product.box_size : 12;

  const tr = inputEl.closest('tr');

  if (source === 'bottle') {
    item.manualPrice = numericVal;
    const boxVal = Math.round(numericVal * boxSize);
    if (tr) {
      const boxInput = tr.querySelector('.editable-price-box');
      if (boxInput && document.activeElement !== boxInput) {
        boxInput.value = formatNumberWithDots(boxVal);
      }
    }
  } else if (source === 'box') {
    const bottleVal = numericVal / boxSize;
    item.manualPrice = bottleVal;
    if (tr) {
      const bottleInput = tr.querySelector('.editable-price-bottle');
      if (bottleInput && document.activeElement !== bottleInput) {
        bottleInput.value = formatNumberWithDots(Math.round(bottleVal));
      }
    }
  }

  const displayBottlePrice = (item.manualPrice !== null && item.manualPrice !== undefined) ? item.manualPrice : (item.unitPrice || 0);
  const isBox = (item.unit === 'thùng');
  const totalUnits = isBox ? item.qty * boxSize : item.qty;
  item.subtotal = displayBottlePrice * totalUnits;

  if (tr) {
    const subEl = tr.querySelector('.subtotal-amount');
    if (subEl) subEl.textContent = formatCurrency(item.subtotal);
  }

  updateLiveOrderTotals();
}

function updateLiveOrderTotals() {
  let grandTotal = 0;
  let totalBoxes = 0;

  currentOrder.items.forEach((item) => {
    if (item.product) {
      const isBox = (item.unit === 'thùng');
      const boxSize = item.product.box_size || 12;
      const displayPrice = (item.manualPrice !== null && item.manualPrice !== undefined) ? item.manualPrice : item.unitPrice;
      const totalUnits = isBox ? item.qty * boxSize : item.qty;
      const sub = displayPrice * totalUnits;
      item.subtotal = sub;
      grandTotal += sub;

      const boxesCount = isBox ? item.qty : item.qty / boxSize;
      totalBoxes += boxesCount;
    } else {
      const displayPrice = (item.manualPrice !== null && item.manualPrice !== undefined) ? item.manualPrice : 0;
      const sub = displayPrice * item.qty;
      item.subtotal = sub;
      grandTotal += sub;
    }
  });

  const summaryProducts = document.getElementById('summaryProducts');
  const summaryBoxes = document.getElementById('summaryBoxes');
  const summaryTotal = document.getElementById('summaryTotal');
  if (summaryProducts) summaryProducts.textContent = currentOrder.items.filter(i => i.product).length;
  if (summaryBoxes) summaryBoxes.textContent = totalBoxes.toFixed(1).replace('.0', '');
  if (summaryTotal) summaryTotal.textContent = formatCurrency(grandTotal);
}

function removeOrderItem(index) {
  currentOrder.items.splice(index, 1);
  renderOrderResults();
}

// ═══════════════════════════════════════════════════════════════════════════
//  CUSTOM PROMOS
// ═══════════════════════════════════════════════════════════════════════════
function addCustomPromo() {
  const input = document.getElementById('customPromoInput');
  if (!input || !input.value.trim()) return;
  currentOrder.customPromos.push(input.value.trim());
  input.value = '';
  renderCustomPromos();
  showToast('Đã thêm khuyến mãi ngoài!', 'success');
}

function removeCustomPromo(i) { currentOrder.customPromos.splice(i, 1); renderCustomPromos(); }

function renderCustomPromos() {
  const list = document.getElementById('customPromoList');
  if (!list) return;
  list.innerHTML = '';
  currentOrder.customPromos.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'custom-promo-item';
    div.innerHTML = `<span class="custom-promo-text">🎁 ${escapeHtml(p)}</span><button class="btn-delete-row" data-promo-index="${i}">✕</button>`;
    list.appendChild(div);
  });
  // Attach remove listeners
  list.querySelectorAll('.btn-delete-row[data-promo-index]').forEach(btn => {
    btn.addEventListener('click', function() {
      removeCustomPromo(parseInt(this.getAttribute('data-promo-index')));
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  MANUAL PRODUCT ADD
// ═══════════════════════════════════════════════════════════════════════════
function onManualSearch(query) {
  const dropdown = document.getElementById('manualSearchDropdown');
  if (!dropdown) return;
  const allProducts = db.getAllProducts();
  let filtered;
  if (!query || query.length < 1) {
    filtered = allProducts.slice(0, 15);
  } else {
    const norm = normalizeText(query);
    filtered = allProducts.map(p => ({ product: p, score: calculateMatchScore(norm, p) }))
      .filter(s => s.score > 20).sort((a, b) => b.score - a.score).slice(0, 10).map(s => s.product);
  }
  dropdown.innerHTML = '';
  for (const p of filtered) {
    const price = p.tiers && p.tiers.length > 0 ? p.tiers[0].price : 0;
    const div = document.createElement('div');
    div.className = 'search-dropdown-item';
    div.innerHTML = `<div><div class="item-name">${p.campaignIcon||'📦'} ${escapeHtml(p.name)}</div><div class="item-campaign">${escapeHtml(p.campaignName)} · ${escapeHtml(p.spec||'')}</div></div><div class="item-price">${formatCurrency(price)}</div>`;
    div.addEventListener('click', () => addManualProduct(p));
    dropdown.appendChild(div);
  }
  if (filtered.length === 0) dropdown.innerHTML = '<div class="search-dropdown-item"><span class="item-campaign">Không tìm thấy</span></div>';
  dropdown.classList.add('visible');
}

function addManualProduct(product) {
  const calc = calculateOrderItem(product, 1, product.unit || 'thùng');
  currentOrder.items.push({ product, qty: 1, unit: product.unit || 'thùng', unitPrice: calc.unitPrice, subtotal: calc.subtotal, foc: calc.foc, tierLabel: calc.tierLabel, manualPrice: null });
  document.getElementById('manualProductSearch').value = '';
  document.getElementById('manualSearchDropdown').classList.remove('visible');
  renderOrderResults();
  showToast(`Đã thêm ${product.name}!`, 'success');
}

// ═══════════════════════════════════════════════════════════════════════════
//  COPY SUMMARY
// ═══════════════════════════════════════════════════════════════════════════
function copySummary() {
  const customer = document.getElementById('customerName').value || 'Không tên';
  const payLabels = { ck:'CK', cod:'COD', tt:'TT', congno:'Công nợ', other:'Khác' };
  let text = `📋 ĐƠN HÀNG — ${customer}\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

  const { rows, grandTotal } = getOrderTableRows();
  let lineNo = 0;

  rows.forEach((row) => {
    lineNo++;
    if (row.type === 'unmatched') {
      text += `${lineNo}. ⚠️ ${row.rawName || 'Chưa khớp'}\n   ${row.qty} ${row.unit} × 0 ₫ = 0 ₫\n`;
    } else if (row.type === 'matched') {
      text += `${lineNo}. ${row.product.name}\n   ${row.qty} ${row.unit} × ${formatCurrency(row.showPrice)} = ${formatCurrency(row.subtotal)}\n`;
    } else if (row.type === 'gift') {
      if (row.giftSource === 'FOC') {
        text += `${lineNo}. ${row.name}\n   ${row.qty} ${row.unit} — Miễn phí\n`;
      } else {
        text += `${lineNo}. 🎁 ${row.name} (Quà MKT)\n   ${row.qty} ${row.unit} × 0 ₫ = 0 ₫\n`;
      }
    }
  });

  text += `━━━━━━━━━━━━━━━━━━━━━━━━━━\n💰 TỔNG: ${formatCurrency(grandTotal)}\n💳 Thanh toán: ${payLabels[document.getElementById('paymentMethod').value] || ''}\n`;
  if (currentOrder.customPromos.length > 0) {
    text += `\n🎁 Khuyến mãi ngoài:\n`;
    currentOrder.customPromos.forEach(p => { text += `   • ${p}\n`; });
  }
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('btnCopy');
    if (btn) {
      btn.classList.add('copied');
      showToast('Đã copy tóm tắt!', 'success');
      setTimeout(() => btn.classList.remove('copied'), 2000);
    }
  }).catch(() => {
    showToast('Không thể copy! Hãy thử lại.', 'error');
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  CLEAR / SAMPLE
// ═══════════════════════════════════════════════════════════════════════════
function clearOrder() {
  document.getElementById('orderText').value = '';
  document.getElementById('customerName').value = '';
  document.getElementById('parsedPreview').innerHTML = '';
  const aiCard = document.getElementById('aiDetectionCard');
  if (aiCard) aiCard.style.display = 'none';
  currentOrder = { customer: '', payment: 'ck', items: [], customPromos: [], parsedLines: [], aiResult: null };
  renderOrderResults();
  renderCustomPromos();
}

function loadSampleOrder() {
  document.getElementById('orderText').value = "Anywhere Man\n2 thùng Zentor prostream 10w40\n1 thùng Zentor prostream15w50\nTT CK";
  showToast('Đã tải đơn hàng mẫu!', 'info');
}

// ═══════════════════════════════════════════════════════════════════════════
//  CATALOG TAB
// ═══════════════════════════════════════════════════════════════════════════
function renderCatalog() {
  const filter = document.getElementById('catalogCampaignFilter').value;
  const container = document.getElementById('catalogContent');
  if (!container) return;
  container.innerHTML = '';
  const select = document.getElementById('catalogCampaignFilter');
  if (select && select.options.length <= 1) {
    for (const [key, c] of Object.entries(db.data.campaigns)) {
      const opt = document.createElement('option'); opt.value = key; opt.textContent = `${c.icon||'📦'} ${c.name}`; select.appendChild(opt);
    }
  }
  const list = filter === 'all' ? Object.entries(db.data.campaigns) : Object.entries(db.data.campaigns).filter(([k]) => k === filter);
  for (const [key, campaign] of list) {
    let html = `<div style="margin-bottom:var(--space-lg)"><h3 style="color:${campaign.color||'var(--text-primary)'};margin-bottom:var(--space-md);font-size:1.05rem">${campaign.icon||'📦'} ${campaign.name} (${campaign.products.length})</h3>`;
    for (const p of campaign.products) {
      html += `<div class="product-editor-item"><div class="product-editor-header"><div><input type="text" class="input-field catalog-input-name" value="${escapeHtml(p.name)}" data-product-field="name" data-product-id="${p.id}" style="font-weight:700;font-size:0.95rem;width:250px" /><span class="product-editor-spec"> · ${escapeHtml(p.spec||'')} · ${escapeHtml(p.packaging||'')}</span></div></div><div class="tier-grid">`;
      if (p.tiers) {
        for (let ti = 0; ti < p.tiers.length; ti++) {
          const t = p.tiers[ti];
          html += `<div class="tier-item"><div class="tier-label">${t.label}</div><div class="tier-price"><input type="text" class="input-field catalog-input-price" value="${formatNumberWithDots(t.price)}" data-tier-field="price" data-tier-product="${p.id}" data-tier-index="${ti}" style="width:90px;text-align:right" /></div></div>`;
        }
      }
      html += `</div>`;
      if (p.foc_rules && p.foc_rules.length > 0) {
        html += `<div class="foc-rules-list">`;
        for (const r of p.foc_rules) html += `<div class="foc-rule-item"><span class="foc-badge">🎁 FOC</span><span>${escapeHtml(r.note||`Mua ${r.buy_qty} tặng ${r.give_qty} ${r.give_unit}`)}</span></div>`;
        html += `</div>`;
      }
      html += `</div>`;
    }
    if (campaign.mkt_gift_rules && campaign.mkt_gift_rules.length > 0) {
      html += `<div class="mkt-gift-card" style="margin-top:var(--space-md)"><div class="mkt-gift-title">🎁 Quà MKT</div>`;
      for (const r of campaign.mkt_gift_rules) html += `<div style="padding:4px 0;font-size:0.85rem"><strong>${r.label}:</strong> ${escapeHtml(r.gifts)}</div>`;
      html += `</div>`;
    }
    html += `</div>`;
    container.innerHTML += html;
  }
  attachCatalogListeners();
}

function attachCatalogListeners() {
  const container = document.getElementById('catalogContent');
  if (!container) return;
  
  container.querySelectorAll('.catalog-input-name').forEach(input => {
    input.addEventListener('change', function() {
      updateProductField(this.getAttribute('data-product-id'), 'name', this.value);
    });
  });
  
  container.querySelectorAll('.catalog-input-price').forEach(input => {
    input.addEventListener('change', function() {
      const productId = this.getAttribute('data-tier-product');
      const index = parseInt(this.getAttribute('data-tier-index'));
      updateTier(productId, index, 'price', this.value);
      this.value = formatNumberWithDots(parseInt(this.value.replace(/\./g, '')) || 0);
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  SETTINGS TAB — Full CRUD
// ═══════════════════════════════════════════════════════════════════════════
function renderSettingsSidebar() {
  const list = document.getElementById('settingsCampaignList');
  if (!list) return;
  list.innerHTML = '';
  for (const [key, campaign] of Object.entries(db.data.campaigns)) {
    const div = document.createElement('div');
    div.className = `campaign-item ${selectedSettingsCampaign === key ? 'active' : ''}`;
    div.innerHTML = `<span class="campaign-icon">${campaign.icon||'📦'}</span><span>${campaign.name}</span><span class="campaign-count">${campaign.products.length}</span>`;
    div.addEventListener('click', () => { selectedSettingsCampaign = key; renderSettingsSidebar(); renderSettingsEditor(key); });
    list.appendChild(div);
  }
}

function renderSettingsEditor(campaignKey) {
  const campaign = db.data.campaigns[campaignKey];
  if (!campaign) return;
  const titleEl = document.getElementById('settingsEditorTitle');
  if (titleEl) titleEl.textContent = campaign.name;
  const editor = document.getElementById('productEditor');
  if (!editor) return;
  editor.innerHTML = '';

  // 1. Render Campaign Promotions (MKT Gifts) Card
  const promoDiv = document.createElement('div');
  promoDiv.className = 'card campaign-promo-card';
  promoDiv.style.cssText = 'margin-bottom: var(--space-md); border: 1px solid var(--accent-yellow); padding: var(--space-md);';
  
  let promoHtml = `<div class="card-header" style="margin-bottom: var(--space-sm); padding-bottom: var(--space-sm); border-bottom: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center;">
    <div class="card-title" style="font-weight:700; color: var(--accent-yellow);"><span class="icon">🎁</span> Quản lý Quà MKT (Bảng giá/Chiến dịch)</div>
    <button class="btn btn-ghost btn-sm" data-add-mkt-rule="${campaignKey}">+ Thêm mốc quà</button>
  </div>
  <div style="display:flex; flex-direction:column; gap: var(--space-xs);">`;
  
  if (campaign.mkt_gift_rules && campaign.mkt_gift_rules.length > 0) {
    campaign.mkt_gift_rules.forEach((rule, ri) => {
      promoHtml += `<div class="mkt-gift-rule-row">
        <div style="display:flex; align-items:center; gap:4px;">
          <span style="font-size:0.75rem; color:var(--text-secondary);">Từ:</span>
          <input type="number" class="input-field" value="${rule.min_total}" placeholder="Từ" data-mkt-field="min_total" data-mkt-campaign="${campaignKey}" data-mkt-index="${ri}" style="font-size:0.8rem; width:80px;" />
          <span style="font-size:0.75rem; color:var(--text-secondary);">đến:</span>
          <input type="number" class="input-field" value="${rule.max_total}" placeholder="Đến" data-mkt-field="max_total" data-mkt-campaign="${campaignKey}" data-mkt-index="${ri}" style="font-size:0.8rem; width:80px;" />
        </div>
        <select class="input-field" data-mkt-field="unit" data-mkt-campaign="${campaignKey}" data-mkt-index="${ri}" style="font-size:0.8rem; padding: 2px 6px;">
          <option value="money" ${rule.unit !== 'boxes' ? 'selected' : ''}>đ (Tiền)</option>
          <option value="boxes" ${rule.unit === 'boxes' ? 'selected' : ''}>Thùng</option>
        </select>
        <input type="text" class="input-field" value="${escapeHtml(rule.gifts)}" placeholder="Tên quà tặng..." data-mkt-field="gifts" data-mkt-campaign="${campaignKey}" data-mkt-index="${ri}" style="font-size:0.8rem; flex:1;" />
        <input type="text" class="input-field" value="${escapeHtml(rule.label || '')}" placeholder="Nhãn..." data-mkt-field="label" data-mkt-campaign="${campaignKey}" data-mkt-index="${ri}" style="font-size:0.8rem; width:100px;" />
        <button class="btn btn-ghost btn-sm" data-remove-mkt-rule="${campaignKey}" data-remove-mkt-index="${ri}">✕</button>
      </div>`;
    });
  } else {
    promoHtml += `<div style="font-size: 0.85rem; color: var(--text-tertiary); text-align: center; padding: var(--space-sm);">Chưa có mốc quà Marketing cho chiến dịch này.</div>`;
  }
  promoHtml += `</div>`;
  promoDiv.innerHTML = promoHtml;
  editor.appendChild(promoDiv);

  // 2. Render Products list
  const allProducts = db.getAllProducts();

  for (const product of campaign.products) {
    const div = document.createElement('div');
    div.className = 'product-editor-item';
    div.id = 'editor-' + product.id;

    let html = `<div class="product-editor-header">
      <div style="flex:1">
        <input type="text" class="input-field" value="${escapeHtml(product.name)}" style="font-weight:700;font-size:0.92rem;width:100%;margin-bottom:4px" data-product-field="name" data-product-id="${product.id}" />
        <div class="customer-info" style="margin-top:4px">
          <input type="text" class="input-field" value="${escapeHtml(product.spec||'')}" placeholder="Spec" data-product-field="spec" data-product-id="${product.id}" />
          <input type="text" class="input-field" value="${escapeHtml(product.packaging||'')}" placeholder="Đóng gói" data-product-field="packaging" data-product-id="${product.id}" />
        </div>
      </div>
      <div class="product-editor-actions">
        <button class="btn btn-danger btn-sm" data-delete-product="${product.id}">🗑️</button>
      </div>
    </div>`;

    // Tiers
    html += `<div class="form-section-title"><span>Bậc giá</span><button class="btn btn-ghost btn-sm" data-add-tier="${product.id}">+ Thêm</button></div>`;
    html += `<div id="tiers-${product.id}">`;
    if (product.tiers) {
      product.tiers.forEach((tier, ti) => {
        html += `<div class="tier-row">
          <input type="number" class="input-field" value="${tier.min_qty}" placeholder="Từ" data-tier-field="min_qty" data-tier-product="${product.id}" data-tier-index="${ti}" />
          <input type="number" class="input-field" value="${tier.max_qty}" placeholder="Đến" data-tier-field="max_qty" data-tier-product="${product.id}" data-tier-index="${ti}" />
          <input type="text" class="input-field" value="${formatNumberWithDots(tier.price)}" placeholder="Giá" data-tier-field="price" data-tier-product="${product.id}" data-tier-index="${ti}" />
          <input type="text" class="input-field" value="${escapeHtml(tier.label)}" placeholder="Nhãn" data-tier-field="label" data-tier-product="${product.id}" data-tier-index="${ti}" />
          <button class="btn btn-ghost btn-sm" data-remove-tier="${product.id}" data-remove-tier-index="${ti}">✕</button>
        </div>`;
      });
    }
    html += `</div>`;

    // FOC
    html += `<div class="form-section-title"><span>Khuyến mãi FOC</span><button class="btn btn-ghost btn-sm" data-add-foc="${product.id}">+ Thêm</button></div>`;
    html += `<div id="focs-${product.id}">`;
    if (product.foc_rules) {
      product.foc_rules.forEach((foc, fi) => {
        let giftSelectHtml = `<select class="input-field" data-foc-field="give_product" data-foc-product="${product.id}" data-foc-index="${fi}" style="font-size:0.8rem; padding: 2px 6px; max-width: 180px;">`;
        giftSelectHtml += `<option value="">— Cùng loại (Tặng SP này) —</option>`;
        allProducts.forEach(ap => {
          const selected = foc.give_product === ap.id ? 'selected' : '';
          giftSelectHtml += `<option value="${ap.id}" ${selected}>[${ap.campaignIcon || '📦'}] ${escapeHtml(ap.name)}</option>`;
        });
        giftSelectHtml += `</select>`;

        html += `<div class="foc-rule-row">
          <div style="display:flex; align-items:center; gap: 4px;">
            <span style="font-size:0.75rem; color:var(--text-secondary);">Mua:</span>
            <input type="number" class="input-field" value="${foc.buy_qty}" placeholder="Mua" data-foc-field="buy_qty" data-foc-product="${product.id}" data-foc-index="${fi}" style="width:50px; font-size:0.8rem;" />
            <span style="font-size:0.75rem; color:var(--text-secondary);">tặng:</span>
            <input type="number" class="input-field" value="${foc.give_qty}" placeholder="Tặng" data-foc-field="give_qty" data-foc-product="${product.id}" data-foc-index="${fi}" style="width:50px; font-size:0.8rem;" />
            <input type="text" class="input-field" value="${escapeHtml(foc.give_unit||'chai')}" placeholder="Đơn vị" data-foc-field="give_unit" data-foc-product="${product.id}" data-foc-index="${fi}" style="width:60px; font-size:0.8rem;" />
          </div>
          <div style="display:flex; align-items:center; gap: 4px;">
            <span style="font-size:0.75rem; color:var(--text-secondary);">Quà:</span>
            ${giftSelectHtml}
          </div>
          <input type="text" class="input-field" value="${escapeHtml(foc.note||'')}" placeholder="Ghi chú..." data-foc-field="note" data-foc-product="${product.id}" data-foc-index="${fi}" style="flex:1; font-size:0.8rem;" />
          <button class="btn btn-ghost btn-sm" data-remove-foc="${product.id}" data-remove-foc-index="${fi}">✕</button>
        </div>`;
      });
    }
    html += `</div>`;

    // Aliases
    const aliases = db.getAliasesForProduct(product.id);
    html += `<div class="form-section-title"><span>Tên gọi tắt (Aliases)</span></div>`;
    html += `<div class="alias-tags" id="aliases-${product.id}">`;
    for (const a of aliases) {
      const canDelete = a.isCustom;
      html += `<span class="alias-tag">${escapeHtml(a.alias)} ${canDelete ? `<button data-remove-alias="${a.alias}" data-alias-product="${product.id}">✕</button>` : ''}</span>`;
    }
    html += `</div>`;
    html += `<div style="display:flex;gap:var(--space-xs);margin-top:var(--space-xs)">
      <input type="text" class="input-field" id="alias-input-${product.id}" placeholder="Thêm alias mới..." style="flex:1;font-size:0.8rem" />
      <button class="btn btn-ghost btn-sm" data-add-alias="${product.id}">+</button>
    </div>`;

    div.innerHTML = html;
    editor.appendChild(div);
  }

  // Attach all settings editor event listeners
  attachSettingsEditorListeners(campaignKey);
}

function attachSettingsEditorListeners(campaignKey) {
  const editor = document.getElementById('productEditor');
  if (!editor) return;

  // Product field updates
  editor.querySelectorAll('[data-product-field]').forEach(input => {
    input.addEventListener('change', function() {
      updateProductField(this.getAttribute('data-product-id'), this.getAttribute('data-product-field'), this.value);
    });
  });

  // Tier updates
  editor.querySelectorAll('[data-tier-field]').forEach(input => {
    if (input.getAttribute('data-tier-field') === 'price') {
      input.addEventListener('input', function() {
        formatInputWithDotsAndPreserveCursor(this);
      });
    }
    input.addEventListener('change', function() {
      const field = this.getAttribute('data-tier-field');
      const val = field === 'price' ? parseFormattedNumber(this.value) : this.value;
      updateTier(this.getAttribute('data-tier-product'), parseInt(this.getAttribute('data-tier-index')), field, val);
    });
  });

  // Add tier
  editor.querySelectorAll('[data-add-tier]').forEach(btn => {
    btn.addEventListener('click', function() { addTierToProduct(this.getAttribute('data-add-tier')); });
  });

  // Remove tier
  editor.querySelectorAll('[data-remove-tier]').forEach(btn => {
    btn.addEventListener('click', function() { removeTier(this.getAttribute('data-remove-tier'), parseInt(this.getAttribute('data-remove-tier-index'))); });
  });

  // FOC updates
  editor.querySelectorAll('[data-foc-field]').forEach(input => {
    input.addEventListener('change', function() {
      updateFOC(this.getAttribute('data-foc-product'), parseInt(this.getAttribute('data-foc-index')), this.getAttribute('data-foc-field'), this.value);
    });
  });

  // Add FOC
  editor.querySelectorAll('[data-add-foc]').forEach(btn => {
    btn.addEventListener('click', function() { addFOCToProduct(this.getAttribute('data-add-foc')); });
  });

  // Remove FOC
  editor.querySelectorAll('[data-remove-foc]').forEach(btn => {
    btn.addEventListener('click', function() { removeFOC(this.getAttribute('data-remove-foc'), parseInt(this.getAttribute('data-remove-foc-index'))); });
  });

  // Delete product
  editor.querySelectorAll('[data-delete-product]').forEach(btn => {
    btn.addEventListener('click', function() { deleteSettingsProduct(this.getAttribute('data-delete-product')); });
  });

  // Alias add
  editor.querySelectorAll('[data-add-alias]').forEach(btn => {
    btn.addEventListener('click', function() { addProductAlias(this.getAttribute('data-add-alias')); });
  });

  // Alias remove
  editor.querySelectorAll('[data-remove-alias]').forEach(btn => {
    btn.addEventListener('click', function() { removeProductAlias(this.getAttribute('data-remove-alias'), this.getAttribute('data-alias-product')); });
  });

  // MKT rule updates
  editor.querySelectorAll('[data-mkt-field]').forEach(input => {
    input.addEventListener('change', function() {
      updateMktRule(this.getAttribute('data-mkt-campaign'), parseInt(this.getAttribute('data-mkt-index')), this.getAttribute('data-mkt-field'), this.value);
    });
  });

  // Add MKT rule
  editor.querySelectorAll('[data-add-mkt-rule]').forEach(btn => {
    btn.addEventListener('click', function() { addMktRuleToCampaign(this.getAttribute('data-add-mkt-rule')); });
  });

  // Remove MKT rule
  editor.querySelectorAll('[data-remove-mkt-rule]').forEach(btn => {
    btn.addEventListener('click', function() { removeMktRule(this.getAttribute('data-remove-mkt-rule'), parseInt(this.getAttribute('data-remove-mkt-index'))); });
  });
}

// --- Product field updates ---
function updateProductField(id, field, value) {
  db.updateProduct(id, { [field]: value });
  showToast('Đã cập nhật!', 'success');
}

// --- Tier CRUD ---
function updateTier(productId, tierIdx, field, value, silent = false) {
  for (const c of Object.values(db.data.campaigns)) {
    const p = c.products.find(x => x.id === productId);
    if (p && p.tiers[tierIdx]) {
      p.tiers[tierIdx][field] = field === 'label' ? value : (parseFormattedNumber(value) || 0);
      db.save();
      if (!silent) showToast('Đã cập nhật giá!', 'success');
      return;
    }
  }
}

function addTierToProduct(productId) {
  for (const c of Object.values(db.data.campaigns)) {
    const p = c.products.find(x => x.id === productId);
    if (p) { p.tiers.push({ min_qty: 1, max_qty: 9999, price: 0, label: 'Mới' }); db.save(); renderSettingsEditor(selectedSettingsCampaign); return; }
  }
}

function removeTier(productId, tierIdx) {
  for (const c of Object.values(db.data.campaigns)) {
    const p = c.products.find(x => x.id === productId);
    if (p && p.tiers[tierIdx]) { p.tiers.splice(tierIdx, 1); db.save(); renderSettingsEditor(selectedSettingsCampaign); return; }
  }
}

// --- FOC CRUD ---
function updateFOC(productId, focIdx, field, value) {
  for (const c of Object.values(db.data.campaigns)) {
    const p = c.products.find(x => x.id === productId);
    if (p && p.foc_rules[focIdx]) {
      p.foc_rules[focIdx][field] = (field === 'note' || field === 'give_unit' || field === 'give_product') ? value : (parseInt(value) || 0);
      db.save(); showToast('Đã cập nhật FOC!', 'success'); return;
    }
  }
}

function addFOCToProduct(productId) {
  for (const c of Object.values(db.data.campaigns)) {
    const p = c.products.find(x => x.id === productId);
    if (p) { p.foc_rules.push({ buy_qty: 1, give_qty: 1, give_unit: 'chai', give_product: '', note: '' }); db.save(); renderSettingsEditor(selectedSettingsCampaign); return; }
  }
}

function removeFOC(productId, focIdx) {
  for (const c of Object.values(db.data.campaigns)) {
    const p = c.products.find(x => x.id === productId);
    if (p && p.foc_rules[focIdx]) { p.foc_rules.splice(focIdx, 1); db.save(); renderSettingsEditor(selectedSettingsCampaign); return; }
  }
}

// --- Alias CRUD ---
function addProductAlias(productId) {
  const input = document.getElementById('alias-input-' + productId);
  if (!input || !input.value.trim()) return;
  db.addAlias(input.value.trim(), productId);
  input.value = '';
  renderSettingsEditor(selectedSettingsCampaign);
  showToast('Đã thêm alias!', 'success');
}

function removeProductAlias(alias, productId) {
  db.removeAlias(alias);
  renderSettingsEditor(selectedSettingsCampaign);
  showToast('Đã xóa alias!', 'info');
}

function deleteSettingsProduct(productId) {
  if (confirm('Xóa sản phẩm này?')) {
    db.deleteProduct(productId);
    renderSettingsEditor(selectedSettingsCampaign);
    renderSettingsSidebar();
    showToast('Đã xóa!', 'info');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  ADD NEW PRODUCT FORM
// ═══════════════════════════════════════════════════════════════════════════
function toggleAddProductForm() {
  const card = document.getElementById('addProductCard');
  if (card) card.style.display = card.style.display === 'none' ? '' : 'none';
}

function addNewTierRow() {
  const container = document.getElementById('newProductTiers');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'tier-row';
  div.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 1fr 1fr auto;gap:var(--space-xs);margin-bottom:var(--space-xs)';
  div.innerHTML = `<input type="number" class="input-field tier-min" placeholder="Từ" value="1" min="1" /><input type="number" class="input-field tier-max" placeholder="Đến" value="9999" /><input type="number" class="input-field tier-price" placeholder="Giá" value="0" /><input type="text" class="input-field tier-label" placeholder="Nhãn" value="" /><button class="btn btn-ghost btn-sm btn-remove-tier-row">✕</button>`;
  div.querySelector('.btn-remove-tier-row').addEventListener('click', () => div.remove());
  container.appendChild(div);
}

function addNewFOCRow() {
  const container = document.getElementById('newProductFOC');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'foc-row';
  div.style.cssText = 'display:grid;grid-template-columns:0.8fr 0.8fr 0.8fr 1.5fr auto;gap:var(--space-xs);margin-bottom:var(--space-xs)';
  div.innerHTML = `<input type="number" class="input-field" placeholder="Mua" value="1" /><input type="number" class="input-field" placeholder="Tặng" value="1" /><input type="text" class="input-field" placeholder="ĐV" value="chai" /><input type="text" class="input-field" placeholder="Ghi chú" /><button class="btn btn-ghost btn-sm btn-remove-foc-row">✕</button>`;
  div.querySelector('.btn-remove-foc-row').addEventListener('click', () => div.remove());
  container.appendChild(div);
}

function saveNewProduct() {
  const name = document.getElementById('newProductName').value.trim();
  if (!name) { showToast('Vui lòng nhập tên sản phẩm!', 'error'); return; }
  if (!selectedSettingsCampaign) { showToast('Vui lòng chọn chiến dịch bên trái trước!', 'error'); return; }

  const tiers = [];
  document.querySelectorAll('#newProductTiers .tier-row').forEach(row => {
    const inputs = row.querySelectorAll('input');
    tiers.push({ min_qty: parseInt(inputs[0].value)||1, max_qty: parseInt(inputs[1].value)||9999, price: parseInt(inputs[2].value)||0, label: inputs[3].value||'' });
  });

  const foc_rules = [];
  document.querySelectorAll('#newProductFOC .foc-row').forEach(row => {
    const inputs = row.querySelectorAll('input');
    foc_rules.push({ buy_qty: parseInt(inputs[0].value)||1, give_qty: parseInt(inputs[1].value)||1, give_unit: inputs[2].value||'chai', note: inputs[3].value||'', give_product: '' });
  });

  const product = {
    name,
    spec: document.getElementById('newProductSpec').value.trim(),
    packaging: document.getElementById('newProductPackaging').value.trim(),
    unit: document.getElementById('newProductUnit').value,
    box_size: parseInt(document.getElementById('newProductBoxSize').value) || 12,
    tiers,
    foc_rules,
  };

  db.addProduct(selectedSettingsCampaign, product);

  const aliasText = document.getElementById('newProductAliases').value.trim();
  if (aliasText) {
    aliasText.split(',').forEach(a => {
      if (a.trim()) db.addAlias(a.trim(), product.id);
    });
  }

  document.getElementById('newProductName').value = '';
  document.getElementById('newProductSpec').value = '';
  document.getElementById('newProductPackaging').value = '';
  document.getElementById('newProductAliases').value = '';
  document.getElementById('newProductTiers').innerHTML = '';
  document.getElementById('newProductFOC').innerHTML = '';
  addNewTierRow();

  renderSettingsEditor(selectedSettingsCampaign);
  renderSettingsSidebar();
  showToast(`Đã thêm "${name}"!`, 'success');
}

// ═══════════════════════════════════════════════════════════════════════════
//  ADD NEW CAMPAIGN
// ═══════════════════════════════════════════════════════════════════════════
function toggleAddCampaignForm() {
  const card = document.getElementById('addCampaignCard');
  if (card) card.style.display = card.style.display === 'none' ? '' : 'none';
}

function saveNewCampaign() {
  const id = document.getElementById('newCampaignId').value.trim().replace(/\s+/g, '_').toLowerCase();
  const label = document.getElementById('newCampaignLabel').value.trim();
  if (!id || !label) { showToast('Vui lòng nhập ID và tên chiến dịch!', 'error'); return; }
  if (db.data.campaigns[id]) { showToast('ID chiến dịch đã tồn tại!', 'error'); return; }

  db.addCampaign(id, { name: label, icon: '📦', color: '#4fc3f7', products: [], mkt_gift_rules: [] });

  document.getElementById('newCampaignId').value = '';
  document.getElementById('newCampaignLabel').value = '';
  document.getElementById('newCampaignDesc').value = '';

  renderSettingsSidebar();
  selectedSettingsCampaign = id;
  renderSettingsEditor(id);
  toggleAddCampaignForm();
  showToast(`Đã tạo chiến dịch "${label}"!`, 'success');
}

// ═══════════════════════════════════════════════════════════════════════════
//  ALIASES MANAGER (in Settings)
// ═══════════════════════════════════════════════════════════════════════════
function searchAliasProduct(query) {
  const container = document.getElementById('aliasEditorContent');
  if (!container) return;
  if (!query || query.length < 2) {
    container.innerHTML = '<div class="empty-state" style="padding:var(--space-md)"><p style="color:var(--text-tertiary);font-size:0.85rem">Nhập ít nhất 2 ký tự để tìm.</p></div>';
    return;
  }
  const norm = normalizeText(query);
  const products = db.getAllProducts().filter(p => normalizeText(p.name).includes(norm) || p.id.includes(norm)).slice(0, 10);

  if (products.length === 0) {
    container.innerHTML = '<p style="color:var(--text-tertiary);font-size:0.85rem;padding:var(--space-md)">Không tìm thấy sản phẩm.</p>';
    return;
  }

  container.innerHTML = '';
  for (const p of products) {
    const aliases = db.getAliasesForProduct(p.id);
    const div = document.createElement('div');
    div.className = 'product-editor-item';
    div.style.marginBottom = 'var(--space-sm)';
    
    let html = `<div class="product-editor-name">${p.campaignIcon||'📦'} ${escapeHtml(p.name)}</div>
      <div class="product-editor-spec">${escapeHtml(p.spec||'')} — ${escapeHtml(p.campaignName)}</div>
      <div class="alias-tags" style="margin-top:var(--space-sm)">`;
    for (const a of aliases) {
      html += `<span class="alias-tag">${escapeHtml(a.alias)} ${a.isCustom ? `<button data-alias-mgr-remove="${a.alias}" data-alias-mgr-product="${p.id}">✕</button>` : ''}</span>`;
    }
    html += `</div>
      <div style="display:flex;gap:var(--space-xs);margin-top:var(--space-xs)">
        <input type="text" class="input-field" id="alias-mgr-${p.id}" placeholder="Thêm alias..." style="flex:1;font-size:0.8rem" />
        <button class="btn btn-ghost btn-sm" data-alias-mgr-add="${p.id}">+</button>
      </div>`;
    div.innerHTML = html;
    container.appendChild(div);
  }

  // Attach listeners
  container.querySelectorAll('[data-alias-mgr-remove]').forEach(btn => {
    btn.addEventListener('click', function() {
      db.removeAlias(this.getAttribute('data-alias-mgr-remove'));
      searchAliasProduct(document.getElementById('aliasSearchInput').value);
    });
  });
  container.querySelectorAll('[data-alias-mgr-add]').forEach(btn => {
    btn.addEventListener('click', function() {
      const productId = this.getAttribute('data-alias-mgr-add');
      const inp = document.getElementById('alias-mgr-' + productId);
      if (inp && inp.value.trim()) {
        db.addAlias(inp.value.trim(), productId);
        inp.value = '';
        searchAliasProduct(document.getElementById('aliasSearchInput').value);
        showToast('Đã thêm!', 'success');
      }
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  DATABASE IMPORT/EXPORT
// ═══════════════════════════════════════════════════════════════════════════
function exportDatabase() {
  const json = db.exportJSON();
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `order_db_${new Date().toISOString().slice(0,10)}.json`; a.click();
  URL.revokeObjectURL(url);
  showToast('Đã xuất JSON!', 'success');
}

function importDatabase(event) {
  const file = event.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    if (db.importJSON(e.target.result)) {
      showToast('Đã nhập dữ liệu!', 'success');
      const aiMemoryInput = document.getElementById('aiMemoryInput');
      if (aiMemoryInput) aiMemoryInput.value = db.getMemory();
      if (selectedSettingsCampaign) { renderSettingsSidebar(); renderSettingsEditor(selectedSettingsCampaign); }
    } else { showToast('File JSON không hợp lệ!', 'error'); }
  };
  reader.readAsText(file);
  event.target.value = '';
}

function resetDatabase() {
  if (confirm('Reset toàn bộ dữ liệu về mặc định?')) {
    db.reset();
    showToast('Đã reset!', 'info');
    const aiMemoryInput = document.getElementById('aiMemoryInput');
    if (aiMemoryInput) aiMemoryInput.value = db.getMemory();
    selectedSettingsCampaign = null;
    renderSettingsSidebar();
    const editor = document.getElementById('productEditor');
    if (editor) editor.innerHTML = '<div class="empty-state"><div class="empty-icon">👈</div><h3>Chọn chiến dịch bên trái</h3></div>';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  MODAL
// ═══════════════════════════════════════════════════════════════════════════
function closeModal(event) {
  if (event.target.id === 'modalOverlay') document.getElementById('modalOverlay').style.display = 'none';
}

// ═══════════════════════════════════════════════════════════════════════════
//  SEARCHABLE COMBOBOX
// ═══════════════════════════════════════════════════════════════════════════
function showComboboxDropdown(index) {
  document.querySelectorAll('.combobox-dropdown').forEach(d => d.classList.remove('visible'));
  const dropdown = document.getElementById(`combobox-dropdown-${index}`);
  if (dropdown) dropdown.classList.add('visible');
}

function filterComboboxOptions(index, query) {
  const dropdown = document.getElementById(`combobox-dropdown-${index}`);
  if (!dropdown) return;
  const normQuery = normalizeText(query);
  const items = dropdown.querySelectorAll('.combobox-item');
  items.forEach(item => {
    const searchText = item.getAttribute('data-search-text') || '';
    item.style.display = (!normQuery || searchText.includes(normQuery)) ? 'flex' : 'none';
  });
}

function selectComboboxItem(index, productId) {
  changeRowProduct(index, productId);
}

// ═══════════════════════════════════════════════════════════════════════════
//  CAMPAIGN PROMOTIONS (MKT) HANDLERS
// ═══════════════════════════════════════════════════════════════════════════
function addMktRuleToCampaign(campaignKey) {
  const campaign = db.data.campaigns[campaignKey];
  if (campaign) {
    if (!campaign.mkt_gift_rules) campaign.mkt_gift_rules = [];
    campaign.mkt_gift_rules.push({ min_total: 1000000, max_total: 9999999, gifts: '1 Quà tặng mới', label: '1-10 triệu', unit: 'money' });
    db.save();
    renderSettingsEditor(campaignKey);
    showToast('Đã thêm mốc quà Marketing!', 'success');
  }
}

function updateMktRule(campaignKey, idx, field, value) {
  const campaign = db.data.campaigns[campaignKey];
  if (campaign && campaign.mkt_gift_rules && campaign.mkt_gift_rules[idx]) {
    let parsedVal = value;
    if (field === 'min_total' || field === 'max_total') {
      parsedVal = parseInt(value) || 0;
    }
    campaign.mkt_gift_rules[idx][field] = parsedVal;
    db.save();
    showToast('Đã cập nhật mốc quà!', 'success');
  }
}

function removeMktRule(campaignKey, idx) {
  const campaign = db.data.campaigns[campaignKey];
  if (campaign && campaign.mkt_gift_rules && campaign.mkt_gift_rules[idx]) {
    campaign.mkt_gift_rules.splice(idx, 1);
    db.save();
    renderSettingsEditor(campaignKey);
    showToast('Đã xóa mốc quà!', 'info');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  AI CONFIGURATION MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════
const AI_CONFIG_KEY = 'order_automation_ai_config_v1';

function getAiConfig() {
  try {
    const saved = localStorage.getItem(AI_CONFIG_KEY);
    if (saved) {
      const config = JSON.parse(saved);
      // Auto fix invalid model saved in localStorage
      if (config.model === 'gemini-3.5-flash') {
        config.model = 'gemini-2.5-flash';
        localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(config));
      }
      return config;
    }
  } catch (e) {}
  return { provider: 'none', apiKey: '', model: '', endpoint: '' };
}

function saveAiConfig(config) {
  localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(config));
}

function getDefaultModel(provider) {
  const defaults = { gemini: 'gemini-2.5-flash', openai: 'gpt-4o-mini', custom: 'gpt-4o-mini' };
  return defaults[provider] || '';
}

function getEndpointForProvider(provider, customEndpoint) {
  if (provider === 'gemini') return 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
  if (provider === 'openai') return 'https://api.openai.com/v1/chat/completions';
  if (provider === 'custom') return customEndpoint || '';
  return '';
}

function onAiProviderChange() {
  const val = document.getElementById('aiProvider').value;
  const badge = document.getElementById('aiStatusBadge');
  const configPanel = document.getElementById('aiConfigPanel');
  const endpointGroup = document.getElementById('aiEndpointGroup');
  if (!badge) return;

  if (val === 'none') {
    configPanel.style.display = 'none';
    badge.textContent = '🔒 Đang chạy Offline (Regular Expression)';
    badge.style.color = 'var(--text-secondary)';
  } else {
    configPanel.style.display = 'block';
    endpointGroup.style.display = (val === 'custom') ? 'block' : 'none';

    // Load saved config or set defaults
    const config = getAiConfig();
    const apiKeyInput = document.getElementById('aiApiKey');
    const modelInput = document.getElementById('aiModelName');
    const endpointInput = document.getElementById('aiEndpointUrl');

    if (config.provider === val && config.apiKey) {
      apiKeyInput.value = config.apiKey;
      modelInput.value = config.model || getDefaultModel(val);
      endpointInput.value = config.endpoint || '';
      badge.innerHTML = '🟢 AI đã cấu hình — sẵn sàng phân tích!';
      badge.style.color = 'var(--accent-green)';
    } else {
      apiKeyInput.value = '';
      modelInput.value = getDefaultModel(val);
      endpointInput.value = '';
      badge.innerHTML = '🟡 Vui lòng nhập API Key để kích hoạt AI';
      badge.style.color = 'var(--accent-yellow, #ffc107)';
    }
  }
}

function onSaveAiConfig() {
  const provider = document.getElementById('aiProvider').value;
  const apiKey = document.getElementById('aiApiKey').value.trim();
  const model = document.getElementById('aiModelName').value.trim();
  const endpoint = document.getElementById('aiEndpointUrl').value.trim();

  if (!apiKey) {
    showToast('Vui lòng nhập API Key!', 'error');
    return;
  }

  if (provider === 'custom' && !endpoint) {
    showToast('Vui lòng nhập Endpoint URL cho chế độ Custom!', 'error');
    return;
  }

  const config = { provider, apiKey, model: model || getDefaultModel(provider), endpoint };
  saveAiConfig(config);

  const badge = document.getElementById('aiStatusBadge');
  const providerLabels = { gemini: 'Google Gemini', openai: 'OpenAI', custom: 'Custom Endpoint' };
  badge.innerHTML = `🟢 ${providerLabels[provider] || 'AI'} — Model: <strong>${config.model}</strong> — Sẵn sàng!`;
  badge.style.color = 'var(--accent-green)';

  showToast(`Đã lưu cấu hình AI (${providerLabels[provider]})! API Key đã được ghi nhớ.`, 'success');
}

function restoreAiConfig() {
  const config = getAiConfig();
  const providerSelect = document.getElementById('aiProvider');
  if (!providerSelect) return;

  if (config.provider && config.provider !== 'none') {
    // Check if the option exists
    const optionExists = Array.from(providerSelect.options).some(o => o.value === config.provider);
    if (optionExists) {
      providerSelect.value = config.provider;
      onAiProviderChange();
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════════════════
function formatNumberWithDots(val) {
  if (val === null || val === undefined || val === '') return '';
  const n = Math.round(Number(val));
  if (isNaN(n)) return '';
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function parseFormattedNumber(str) {
  if (str === null || str === undefined) return 0;
  const cleaned = String(str).replace(/[^0-9-]/g, '');
  const num = parseInt(cleaned, 10);
  return isNaN(num) ? 0 : num;
}

function formatInputWithDotsAndPreserveCursor(inputEl) {
  const oldVal = inputEl.value;
  const cursorPos = inputEl.selectionStart || 0;
  
  let digitsBeforeCursor = 0;
  for (let i = 0; i < cursorPos && i < oldVal.length; i++) {
    if (/\d/.test(oldVal[i])) digitsBeforeCursor++;
  }
  
  const raw = oldVal.replace(/[^0-9]/g, '');
  if (!raw) {
    inputEl.value = '';
    return 0;
  }
  
  const formatted = raw.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  inputEl.value = formatted;
  
  let newCursor = 0;
  let digitsSeen = 0;
  while (newCursor < formatted.length && digitsSeen < digitsBeforeCursor) {
    if (/\d/.test(formatted[newCursor])) digitsSeen++;
    newCursor++;
  }
  inputEl.setSelectionRange(newCursor, newCursor);
  return parseInt(raw, 10) || 0;
}

function formatCurrency(amount) { return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount); }

function escapeHtml(str) { if (!str) return ''; const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  toast.innerHTML = `<span class="toast-icon">${icons[type]||'ℹ️'}</span><span class="toast-text">${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.animation = 'toastOut 0.3s ease forwards'; setTimeout(() => toast.remove(), 300); }, 3000);
}

// ═══════════════════════════════════════════════════════════════════════════
//  INITIALIZE — All event listeners attached here
// ═══════════════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  try {
    // Guard: ensure db is available
    if (typeof db === 'undefined' || !db) {
      console.error('❌ CRITICAL: db is not defined! Check data.js and db.js for errors.');
      alert('Lỗi nghiêm trọng: Cơ sở dữ liệu không khởi tạo được.\n\nKiểm tra Console (F12) để biết chi tiết.\nCó thể file data.js hoặc db.js bị lỗi cú pháp.');
      return;
    }

    // Initialize tabs
    initTabs();

    // Main parse button
    const btnParse = document.getElementById('btnParse');
    if (btnParse) {
      btnParse.addEventListener('click', () => {
        parseOrder().catch(err => {
          console.error('parseOrder unhandled error:', err);
          showToast('Lỗi không xác định: ' + err.message, 'error');
        });
      });
    }

    // Clear and Sample buttons
    const btnClear = document.getElementById('btnClear');
    if (btnClear) btnClear.addEventListener('click', clearOrder);

    const btnSample = document.getElementById('btnSample');
    if (btnSample) btnSample.addEventListener('click', loadSampleOrder);

    // Copy button
    const btnCopy = document.getElementById('btnCopy');
    if (btnCopy) btnCopy.addEventListener('click', copySummary);

    // Custom promo
    const btnAddPromo = document.getElementById('btnAddPromo');
    if (btnAddPromo) btnAddPromo.addEventListener('click', addCustomPromo);
    
    const customPromoInput = document.getElementById('customPromoInput');
    if (customPromoInput) customPromoInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addCustomPromo(); });

    // Order text Ctrl+Enter shortcut
    const orderText = document.getElementById('orderText');
    if (orderText) {
      orderText.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          parseOrder().catch(err => console.error(err));
        }
      });
    }

    // Manual product search
    const manualSearch = document.getElementById('manualProductSearch');
    if (manualSearch) {
      manualSearch.addEventListener('input', function() { onManualSearch(this.value); });
      manualSearch.addEventListener('focus', function() { onManualSearch(this.value); });
    }

    // AI provider change
    const aiProvider = document.getElementById('aiProvider');
    if (aiProvider) aiProvider.addEventListener('change', onAiProviderChange);

    // AI override campaign
    const aiOverride = document.getElementById('aiOverrideCampaign');
    if (aiOverride) aiOverride.addEventListener('change', overrideCampaign);

    // Catalog filter
    const catalogFilter = document.getElementById('catalogCampaignFilter');
    if (catalogFilter) catalogFilter.addEventListener('change', renderCatalog);

    // Settings buttons
    const btnToggleAddProduct = document.getElementById('btnToggleAddProduct');
    if (btnToggleAddProduct) btnToggleAddProduct.addEventListener('click', toggleAddProductForm);

    const btnToggleAddCampaign = document.getElementById('btnToggleAddCampaign');
    if (btnToggleAddCampaign) btnToggleAddCampaign.addEventListener('click', toggleAddCampaignForm);

    const btnCloseProductForm = document.getElementById('btnCloseProductForm');
    if (btnCloseProductForm) btnCloseProductForm.addEventListener('click', toggleAddProductForm);

    const btnCloseCampaignForm = document.getElementById('btnCloseCampaignForm');
    if (btnCloseCampaignForm) btnCloseCampaignForm.addEventListener('click', toggleAddCampaignForm);

    const btnSaveProduct = document.getElementById('btnSaveProduct');
    if (btnSaveProduct) btnSaveProduct.addEventListener('click', saveNewProduct);

    const btnSaveCampaign = document.getElementById('btnSaveCampaign');
    if (btnSaveCampaign) btnSaveCampaign.addEventListener('click', saveNewCampaign);

    const btnAddNewTier = document.getElementById('btnAddNewTier');
    if (btnAddNewTier) btnAddNewTier.addEventListener('click', addNewTierRow);

    const btnAddNewFOC = document.getElementById('btnAddNewFOC');
    if (btnAddNewFOC) btnAddNewFOC.addEventListener('click', addNewFOCRow);

    // Data import/export
    const btnExport = document.getElementById('btnExport');
    if (btnExport) btnExport.addEventListener('click', exportDatabase);

    const btnImportTrigger = document.getElementById('btnImportTrigger');
    if (btnImportTrigger) btnImportTrigger.addEventListener('click', () => {
      document.getElementById('importFileInput').click();
    });

    const importFileInput = document.getElementById('importFileInput');
    if (importFileInput) importFileInput.addEventListener('change', importDatabase);

    const btnReset = document.getElementById('btnReset');
    if (btnReset) btnReset.addEventListener('click', resetDatabase);

    // Modal
    const modalOverlay = document.getElementById('modalOverlay');
    if (modalOverlay) modalOverlay.addEventListener('click', closeModal);

    const btnCloseModal = document.getElementById('btnCloseModal');
    if (btnCloseModal) btnCloseModal.addEventListener('click', () => {
      document.getElementById('modalOverlay').style.display = 'none';
    });

    // Alias search
    const aliasSearchInput = document.getElementById('aliasSearchInput');
    if (aliasSearchInput) aliasSearchInput.addEventListener('input', function() { searchAliasProduct(this.value); });

    // AI Memory rules initialization
    const aiMemoryInput = document.getElementById('aiMemoryInput');
    if (aiMemoryInput && db && typeof db.getMemory === 'function') {
      aiMemoryInput.value = db.getMemory();
    }

    const btnSaveMemory = document.getElementById('btnSaveMemory');
    if (btnSaveMemory) {
      btnSaveMemory.addEventListener('click', () => {
        if (!db || typeof db.saveMemory !== 'function') {
          showToast('Cơ sở dữ liệu chưa sẵn sàng!', 'error');
          return;
        }
        const text = aiMemoryInput.value;
        if (db.saveMemory(text)) {
          showToast('Đã lưu bộ nhớ quy tắc AI!', 'success');
        } else {
          showToast('Không thể lưu bộ nhớ!', 'error');
        }
      });
    }

    // AI Config: Save button
    const btnSaveAiConfig = document.getElementById('btnSaveAiConfig');
    if (btnSaveAiConfig) btnSaveAiConfig.addEventListener('click', onSaveAiConfig);

    // AI Config: Toggle key visibility
    const btnToggleKeyVisibility = document.getElementById('btnToggleKeyVisibility');
    if (btnToggleKeyVisibility) {
      btnToggleKeyVisibility.addEventListener('click', () => {
        const keyInput = document.getElementById('aiApiKey');
        if (keyInput.type === 'password') {
          keyInput.type = 'text';
          btnToggleKeyVisibility.textContent = '🙈 Ẩn';
        } else {
          keyInput.type = 'password';
          btnToggleKeyVisibility.textContent = '👁️ Hiện';
        }
      });
    }

    // AI Config: Restore saved config on startup
    restoreAiConfig();

    // Global click handlers (close dropdowns)
    document.addEventListener('click', (e) => {
      // Close manual search dropdown
      const searchContainer = document.querySelector('.search-dropdown-container');
      if (searchContainer && !searchContainer.contains(e.target)) {
        const dropdown = document.getElementById('manualSearchDropdown');
        if (dropdown) dropdown.classList.remove('visible');
      }
      // Close combobox dropdowns
      if (!e.target.closest('.combobox-container')) {
        document.querySelectorAll('.combobox-dropdown').forEach(d => d.classList.remove('visible'));
      }
    });

    // Remove the tier row close button listener for the default tier row
    const defaultTierRemove = document.querySelector('#newProductTiers .tier-row .btn.btn-ghost.btn-sm');
    if (defaultTierRemove) {
      defaultTierRemove.addEventListener('click', function() {
        this.closest('.tier-row').remove();
      });
    }

    const productCount = (db && typeof db.getAllProducts === 'function') ? db.getAllProducts().length : 0;
    const aliasCount = (db && typeof db.getAliases === 'function') ? Object.keys(db.getAliases()).length : 0;
    console.log('🚀 Order Automation v3 initialized! Products:', productCount, '| Aliases:', aliasCount);
    showToast('Hệ thống sẵn sàng! Dán tin nhắn sales và nhấn "Phân Tích Đơn Hàng".', 'info');
  } catch (initErr) {
    console.error('❌ Initialization error:', initErr);
    alert('Lỗi khởi tạo ứng dụng: ' + initErr.message + '\n\nVui lòng mở Console (F12) để xem chi tiết.');
  }
});

```

---

## 5. db.js (Logic & Database Structure)
> **Lưu ý:** Phần danh mục sản phẩm tĩnh `DEFAULT_DB` đã được rút gọn để dễ đọc. Logic của lớp `ProductDatabase` và hàm phân loại `classifyOrder` được giữ nguyên vẹn 100%.

### Danh sách 8 campaigns trong DEFAULT_DB:
| Campaign Key | Tên | Thương hiệu |
|---|---|---|
| `xvil` | XVIL - Dầu Nhớt Xe Máy (Clear Stock) | XVIL |
| `znt_mxo` | Zentor MXO - Dầu Nhớt Xe Máy (Workshop) | Zentor |
| `znt_pcmo` | Zentor PCMO - Dầu Ô Tô (Workshop) | Zentor |
| `torvex` | Torvex - Dầu Nhớt Xe Máy (Cửa Hàng) | Torvex |
| `tvx_reseller` | TVX - Dầu Nhớt Xe Tải (Đại Lý) | TVX |
| `tvx_fleet` | TVX - Dầu Nhớt Xe Tải (Đội Xe) | TVX |
| `veltron_npp` | Veltron Clear Stock (NPP) | Veltron |
| `veltron_workshop` | Veltron Clear Stock (Workshop) | Veltron |

### Cấu trúc dữ liệu mỗi campaign:
- `products[]` — danh sách sản phẩm với `kvCode`, `tiers[]` (bậc giá), `foc_rules[]`, `box_size`
- `mkt_gift_rules` — quà marketing cấp chiến dịch (banner + badge trong UI, KHÔNG inject fake product)
- `foc_rules` — quà FOC tự động khi đủ ngưỡng mua (`buy_qty` → `give_qty`)

### KiotViet JSON Export workflow (thay thế Playwright):
1. `app.js` → `launchKiotVietAutomation()` xây dựng `kiotvietData` JSON
2. Gọi `electronAPI.exportKiotvietOrder()` để ghi JSON ra file
3. Mở `YOUR_TENANT.kiotviet.vn/man/#/Orders` trong tab mới
4. **Browser-use MCP skill** (AI agent) đọc JSON và tự động nhập liệu trên KiotViet

```javascript
﻿// DATABASE QUY CHUáº¨N - ORDER AUTOMATION v2
// Cáº­p nháº­t theo chuáº©n Exact Match 100% vá»›i Master Data Excel
const DEFAULT_DB = 
{
    "campaigns":  {
                      "xvil":  {
                                    "name":  "XVIL - Dầu Nhớt Xe Máy (Clear Stock)",
                                    "color":  "#ef5350",
                                    "icon":  "🔥",
                                    "products":  [
                                                     {
                                                         "id":  "xvil_xvil_hand_cleaner_4l",
                                                         "name":  "Xvil Hand Cleaner (4L/bình)",
                                                         "spec":  "4L",
                                                         "packaging":  "4L x 6 can/thùng",
                                                         "unit":  "can",
                                                         "box_size":  6,
                                                         "tiers":  [
                                                                       {
                                                                           "min_qty":  1,
                                                                           "max_qty":  14,
                                                                           "price":  190017,
                                                                           "label":  "1-14 thùng"
                                                                       },
                                                                       {
                                                                           "min_qty":  15,
                                                                           "max_qty":  29,
                                                                           "price":  160017,
                                                                           "label":  "15-29 thùng"
                                                                       },
                                                                       {
                                                                           "min_qty":  30,
                                                                           "max_qty":  9999,
                                                                           "price":  149017,
                                                                           "label":  "≥30 thùng"
                                                                       }
                                                                   ],
                                                         "foc_rules":  [

                                                                       ]
                                                     },
                                                      // ...
                                                      // [Đã lược bỏ ~5500 dòng dữ liệu sản phẩm tĩnh của DEFAULT_DB để file review gọn gàng hơn]
                                                      // ...
                                                  ]
                              }
          }
};

Bản nội dung đầy đủ của DEFAULT_ALIASES (277 dòng alias tên hàng hóa nội bộ) đã tách sang
default-aliases.json — file local-only, KHÔNG nằm trong git/GitHub (10/2026).


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

class ProductDatabase {
  constructor() {
    this.data = this.load();
    this.ensureGiftProducts();
    this.customAliases = this.loadAliases();
    this.memory = this.loadMemory();
  }

  load() {
    try {
      const saved = localStorage.getItem(DB_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.campaigns && parsed.campaigns.znt_pcmo) {
          // Force reset if old format detected
          const hasOldDummy = parsed.campaigns.znt_pcmo.products.some(p => p.id === 'znt_pcmo_active_defence_10w40');
          if (hasOldDummy) {
            console.log("Old dummy database detected. Force resetting to correct defaults.");
            localStorage.removeItem(DB_STORAGE_KEY);
            return JSON.parse(JSON.stringify(DEFAULT_DB));
          }
        }
        if (parsed.campaigns) return parsed;
      }
    } catch (e) {
      console.warn('Failed to load DB, using defaults:', e);
    }
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }

  save() {
    try {
      localStorage.setItem(DB_STORAGE_KEY, JSON.stringify(this.data));
      return true;
    } catch (e) { console.error('Save failed:', e); return false; }
  }

  loadAliases() {
    try {
      const saved = localStorage.getItem(ALIAS_STORAGE_KEY);
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return {};
  }

  saveAliases() {
    try {
      localStorage.setItem(ALIAS_STORAGE_KEY, JSON.stringify(this.customAliases));
    } catch (e) {}
  }

  loadMemory() {
    try {
      const saved = localStorage.getItem(MEMORY_STORAGE_KEY);
      if (saved) return saved;
    } catch (e) {}
    return DEFAULT_MEMORY;
  }

  saveMemory(text) {
    try {
      this.memory = text;
      localStorage.setItem(MEMORY_STORAGE_KEY, text);
      return true;
    } catch (e) {
      console.error('Save memory failed:', e);
      return false;
    }
  }

  getMemory() {
    return this.memory || DEFAULT_MEMORY;
  }

  reset() {
    this.data = JSON.parse(JSON.stringify(DEFAULT_DB));
    this.customAliases = {};
    this.memory = DEFAULT_MEMORY;
    localStorage.removeItem(DB_STORAGE_KEY);
    localStorage.removeItem(ALIAS_STORAGE_KEY);
    localStorage.removeItem(MEMORY_STORAGE_KEY);
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
      this.save();
      this.saveAliases();
      this.saveMemory(this.memory);
      return true;
    } catch (e) { console.error('Import failed:', e); return false; }
  }

  getAllProducts() {
    const products = [];
    for (const [campaignKey, campaign] of Object.entries(this.data.campaigns)) {
      for (const product of campaign.products) {
        products.push({ ...product, campaignKey, campaignName: campaign.name, campaignColor: campaign.color, campaignIcon: campaign.icon });
      }
    }
    return products;
  }

  findProductById(id) {
    for (const [campaignKey, campaign] of Object.entries(this.data.campaigns)) {
      const product = campaign.products.find(p => p.id === id);
      if (product) return { ...product, campaignKey, campaignName: campaign.name, campaignColor: campaign.color, campaignIcon: campaign.icon };
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

  ensureGiftProducts() {
    let modified = false;
    const addIfMissing = (campaignKey, product) => {
      const campaign = this.data.campaigns[campaignKey];
      if (campaign) {
        const exists = campaign.products.some(p => p.id === product.id);
        if (!exists) {
          campaign.products.unshift(product);
          modified = true;
          console.log(`Injected missing gift product: ${product.name} (${product.id}) to ${campaignKey}`);
        }
      }
    };

    addIfMissing('torvex', {
      id: 'stringbag',
      name: 'Túi rút Torvex',
      spec: 'Quà tặng MKT',
      packaging: 'Cái',
      unit: 'cái',
      box_size: 1,
      tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Miễn phí' }],
      foc_rules: []
    });

    addIfMissing('znt_mxo', {
      id: 'oil_pump',
      name: 'Bơm Nhớt phuy',
      spec: 'Quà tặng FOC phuy',
      packaging: 'Cái',
      unit: 'bom',
      box_size: 1,
      tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Miễn phí' }],
      foc_rules: []
    });

    addIfMissing('xvil', {
      id: 'mkt_keychain',
      name: 'Móc khóa MKT',
      spec: 'Quà tặng MKT',
      packaging: 'Cái',
      unit: 'cái',
      box_size: 1,
      tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Miễn phí' }],
      foc_rules: []
    });

    addIfMissing('xvil', {
      id: 'mkt_raincoat',
      name: 'Áo mưa MKT',
      spec: 'Quà tặng MKT',
      packaging: 'Cái',
      unit: 'cái',
      box_size: 1,
      tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Miễn phí' }],
      foc_rules: []
    });

    addIfMissing('xvil', {
      id: 'mkt_cap',
      name: 'Nón MKT',
      spec: 'Quà tặng MKT',
      packaging: 'Cái',
      unit: 'cái',
      box_size: 1,
      tiers: [{ min_qty: 1, max_qty: 9999, price: 0, label: 'Miễn phí' }],
      foc_rules: []
    });

    if (modified) {
      this.save();
    }
  }

  getFOCForQty(product, qty) {
    if (!product.foc_rules || product.foc_rules.length === 0) return null;
    const sorted = [...product.foc_rules].sort((a, b) => b.buy_qty - a.buy_qty);
    for (const rule of sorted) {
      if (qty >= rule.buy_qty) {
        const times = Math.floor(qty / rule.buy_qty);
        let giveProduct = rule.give_product || '';
        if (!giveProduct) {
          const unit = (rule.give_unit || '').toLowerCase().trim();
          const note = (rule.note || '').toLowerCase().trim();
          if (unit === 'bom' || unit === 'bơm') {
            giveProduct = 'oil_pump';
          } else if (unit === 'tuýp' || unit === 'tuyp' || note.includes('hộp số') || note.includes('hop so')) {
            if (product.campaignKey === 'torvex' || product.id.startsWith('torvex')) {
              giveProduct = 'torvex_gear_oil';
            } else if (product.campaignKey && product.campaignKey.includes('veltron')) {
              giveProduct = 'veltron_veltron_scooter_gear_oil_sae_80w_90';
            } else {
              giveProduct = 'torvex_gear_oil';
            }
          } else if (unit === 'túi' || unit === 'tui' || note.includes('túi') || note.includes('tui')) {
            giveProduct = 'stringbag';
          } else if (note.includes('summerscreen') || note.includes('display')) {
            giveProduct = 'veltron_veltron_display_summerscreen_konz_1_100_orange';
          } else {
            giveProduct = product.id;
          }
        }
        return { ...rule, give_product: giveProduct, total_give: times * rule.give_qty, times };
      }
    }
    return null;
  }

  getMKTGifts(campaignKey, totalAmount, totalBoxes) {
    const campaign = this.data.campaigns[campaignKey];
    if (!campaign || !campaign.mkt_gift_rules || campaign.mkt_gift_rules.length === 0) return null;
    for (const rule of campaign.mkt_gift_rules) {
      const compareVal = rule.unit === 'boxes' ? totalBoxes : totalAmount;
      if (compareVal >= rule.min_total && compareVal <= rule.max_total) return rule;
    }
    return null;
  }

  addCampaign(key, data) {
    if (this.data.campaigns[key]) return false;
    this.data.campaigns[key] = { name: data.name || key, color: data.color || '#4fc3f7', icon: data.icon || 'ðŸ“¦', products: [], mkt_gift_rules: [], ...data };
    this.save();
    return true;
  }

  updateCampaign(key, updates) {
    if (!this.data.campaigns[key]) return false;
    Object.assign(this.data.campaigns[key], updates);
    this.save();
    return true;
  }

  deleteCampaign(key) {
    if (!this.data.campaigns[key]) return false;
    delete this.data.campaigns[key];
    this.save();
    return true;
  }

  generateProductId(name) {
    return name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/Ä‘/g, 'd')
      .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') + '_' + Date.now().toString(36).slice(-4);
  }

  addProduct(campaignKey, product) {
    if (!this.data.campaigns[campaignKey]) return false;
    if (!product.id) product.id = this.generateProductId(product.name || 'product');
    if (!product.tiers) product.tiers = [];
    if (!product.foc_rules) product.foc_rules = [];
    this.data.campaigns[campaignKey].products.push(product);
    this.save();
    return true;
  }

  updateProduct(productId, updates) {
    for (const campaign of Object.values(this.data.campaigns)) {
      const idx = campaign.products.findIndex(p => p.id === productId);
      if (idx !== -1) { campaign.products[idx] = { ...campaign.products[idx], ...updates }; this.save(); return true; }
    }
    return false;
  }

  deleteProduct(productId) {
    for (const campaign of Object.values(this.data.campaigns)) {
      const idx = campaign.products.findIndex(p => p.id === productId);
      if (idx !== -1) { campaign.products.splice(idx, 1); this.save(); return true; }
    }
    return false;
  }

  updateProductTiers(productId, tiers) {
    for (const campaign of Object.values(this.data.campaigns)) {
      const product = campaign.products.find(p => p.id === productId);
      if (product) { product.tiers = tiers; this.save(); return true; }
    }
    return false;
  }

  updateProductFOC(productId, foc_rules) {
    for (const campaign of Object.values(this.data.campaigns)) {
      const product = campaign.products.find(p => p.id === productId);
      if (product) { product.foc_rules = foc_rules; this.save(); return true; }
    }
    return false;
  }

  getAliases() {
    return { ...DEFAULT_ALIASES, ...this.customAliases };
  }

  addAlias(alias, productId) {
    this.customAliases[alias.toLowerCase().trim()] = productId;
    this.saveAliases();
  }

  removeAlias(alias) {
    delete this.customAliases[alias.toLowerCase().trim()];
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
    if (!this.data.campaigns[campaignKey]) return 0;
    let count = 0;
    for (const p of products) {
      if (!p.id) p.id = this.generateProductId(p.name || 'imported');
      if (!p.tiers) p.tiers = [];
      if (!p.foc_rules) p.foc_rules = [];
      this.data.campaigns[campaignKey].products.push(p);
      count++;
    }
    this.save();
    return count;
  }
}

const db = new ProductDatabase();

```

---

## 6. Kiến trúc tổng thể & Luồng xử lý

### 6.1. Tổng quan kiến trúc
```
┌─────────────────────────────────────────────────────────────────┐
│  Electron Desktop App (main.js + preload.js)                    │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Browser Window (renderer, entry src/main.js)             │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │  │
│  │  │ index.html│  │ src/*    │  │ db.js    │  │ai-service│ │  │
│  │  │ style.css │  │modules   │  │db-store  │  │parser.js │ │  │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘ │  │
│  └───────────────────────────────────────────────────────────┘  │
│         │ IPC (preload whitelist)     │ MCP :8048/mcp (mcp-server) │
│         ▼                              ▼                         │
│  ┌──────────────────┐        ┌─────────────────────┐             │
│  │ excel_automation │        │ JSON cho agent ngoài │            │
│  │ .py (win32com →  │        │ (token auth)         │            │
│  │ Excel thật)      │        └─────────────────────┘             │
│  └──────────────────┘                                            │
└─────────────────────────────────────────────────────────────────┘
         │                       │
         ▼                       ▼
  I.ĐƠN HÀNG/<brand>/     BrowserMCP / userscript / automation.js
  .xlsx (+ backup)        → lên đơn YOUR_TENANT.kiotviet.vn
```

### 6.2. Luồng xử lý đơn hàng
1. **Nhập liệu**: Dán tin nhắn sales → bấm "Phân tích" → task vào hàng đợi parse nền (`src/order/parse-queue.js`,
   N đơn song song, mặc định 2) → AI parser (12 provider qua AI profiles, failover/round-robin) hoặc Offline
   parser (regex + fuzzy) qua pipeline chung `src/order/parse-pipeline.js`. Đơn xong: lên màn hình nếu đang chờ
   đúng đơn đó, ngược lại vào "Đơn chờ duyệt" tự động
2. **Phân loại chiến dịch**: `classifyOrder()` trong db.js tự động detect campaign từ sản phẩm
3. **Tính giá**: Áp dụng bậc giá (tiered pricing) theo số lượng thùng
4. **FOC/MKT gifts**: Tự động thêm quà FOC khi đủ ngưỡng; MKT gifts hiển thị dạng banner/badge
5. **Xuất Excel**: `src/order/export.js` dựng payload → IPC → `main.js` spawn `excel_automation.py`
   (timeout 2 phút, mutex, backup) → win32com clone sheet template + FillDown công thức
6. **Lên KiotViet**: export JSON → (a) browser agent MCP, (b) userscript, hoặc (c) `src/kiotviet/automation.js`;
   xong bước KV chỉ cập nhật chip tiến độ, đơn vẫn ở "Đơn chờ duyệt" (`src/order/pending.js`) cho tới khi
   người dùng bấm "Hoàn tất" hoặc "Xóa"

### 6.3. Quy tắc kinh doanh quan trọng
- **Tên sản phẩm**: Phải khớp chính xác với dữ liệu Excel order ("good data"), không dùng format nội bộ
- **FOC rows**: Xóa nội dung ô đỏ (columns C, D, E, G, H, K) khi xuất Excel; hỗ trợ kéo thả độc lập
- **MKT gifts**: Lưu trong `mkt_gift_rules`, KHÔNG inject sản phẩm giả vào `DEFAULT_DB`
- **Mã sản phẩm (kvCode)**: Bất biến — chỉ attach thêm, không overwrite khi sync từ Excel
- **Thanh toán**: CK (chuyển khoản), COD (thu hộ), TT (tiền mặt), Công nợ

## Phụ lục — Push GitHub công khai (vỏ tính năng)

Repo GitHub chỉ nhận **vỏ tính năng đã sanitize**: chạy `node scripts/build-public-repo.mjs`
(script snapshot file tracked, thay identifier thật — brand/campaign key/tên SP/mã KV/giá — bằng tên giả,
commit 1 commit rồi force-push). KHÔNG `git push` trực tiếp; hook pre-push chặn khi working tree còn token thật.
Từ điển ánh xạ nằm trong script đó — local-only, gitignored, không commit, không vào source zip.

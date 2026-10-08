# Codebase Optimizations & Production Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Tối ưu hóa toàn diện codebase của dự án Order Automation: vá lỗ hổng đóng gói Electron, đồng bộ kênh IPC bảo mật, hoàn thiện coverage kiểm thử tự động, và dọn dẹp vệ sinh repo.

**Architecture:** Kiến trúc Electron đa tiến trình (Main, Preload, Renderer qua Vite, Python Worker COM/Excel). Tối ưu hóa việc phân tách tầng, quản lý file bundling qua `electron-builder.yml`, và bảo vệ IPC qua channel whitelisting.

**Tech Stack:** Electron 33, Node.js (test runner tích hợp), Vite, Vanilla ES Modules, Python 3 (win32com / openpyxl), WebSocket (ws).

---

## Audit Findings & Risk Summary

Đã dùng bộ kỹ năng `vibe-code-auditor`, `clean-code`, `electron-development`, `simplify-code`:

1. **[CRITICAL] Thiếu file trong cấu hình đóng gói `electron-builder.yml` & `validate-build.js`**:
   - `api-server.js` được import trong `main.js` (`const apiServer = require('./api-server');`), nhưng chưa có trong danh sách `files:` của `electron-builder.yml` và thiếu trong `REQUIRED_FILES` của `validate-build.js`. Khi build EXE đóng gói app.asar, khởi động sẽ bị lỗi thiếu module.
   - Thư viện `ws` (`dependencies`) cần đảm bảo được bundle đúng cách cho Browser Agent / MCP client.

2. **[HIGH] Kênh IPC chưa đồng bộ trong Whitelist `preload.js`**:
   - `config:get-customer-notes` và `config:set-customer-notes` đã được expose qua `electronAPI.getCustomerNotes` / `setCustomerNotes` và xử lý trong `main.js`, nhưng chưa được khai báo trong danh sách hằng số `ALLOWED_INVOKE_CHANNELS` ở đầu file `preload.js`.

3. **[HIGH] Test Suite trong `package.json` và `validate-build.js` bị sót test cases**:
   - Hiện `test/alias-audit.test.js` và `test/matching-golden.test.mjs` (28 tests golden về fuzzy match và alias) không nằm trong `npm test` và `validate-build.js`.
   - `validate-build.js` thiếu 3 test suites: `excel_smoke.test.js`, `note-sanitizer.test.mjs`, `product-edit.test.mjs`.

4. **[MEDIUM] Repo clutter & `.gitignore` còn lỏng**:
   - Thư mục gốc chứa nhiều file tạm thử nghiệm (`_*.py`, `_*.js`, `_*.txt`, `_*.xlsx`, `_sandbox_*`, `*.bak`, `tmp_*.txt`, `_*.png`).
   - `.gitignore` chưa chặn triệt để các tiền tố file debug/scratch.

---

### Task 1: Vá cấu hình đóng gói Electron (`electron-builder.yml` & `validate-build.js`)

**Files:**
- Modify: `electron-builder.yml:20-41`
- Modify: `validate-build.js:6-28`

**Step 1: Cập nhật danh sách files trong `electron-builder.yml`**
Bổ sung `"api-server.js"` vào `files:` trong `electron-builder.yml`.

**Step 2: Cập nhật `REQUIRED_FILES` trong `validate-build.js`**
Thêm `'api-server.js'` vào mảng `REQUIRED_FILES`.

**Step 3: Chạy prebuild validation để kiểm tra**
Run: `node validate-build.js pre`
Expected: PASS không báo thiếu file.

**Step 4: Commit**
```bash
git add electron-builder.yml validate-build.js
git commit -m "fix(build): add api-server.js to electron-builder files and build validator"
```

---

### Task 2: Đồng bộ Whitelist IPC Channels trong `preload.js`

**Files:**
- Modify: `preload.js:13-48`

**Step 1: Bổ sung các channels còn thiếu vào `ALLOWED_INVOKE_CHANNELS`**
Thêm `'config:get-customer-notes'` và `'config:set-customer-notes'` vào `ALLOWED_INVOKE_CHANNELS`.

**Step 2: Kiểm tra tính nhất quán giữa invoke calls và whitelist**
Đảm bảo 100% method trong `contextBridge.exposeInMainWorld` có channel nằm trong `ALLOWED_INVOKE_CHANNELS`.

**Step 3: Run test suite**
Run: `npm test`
Expected: PASS 100%.

**Step 4: Commit**
```bash
git add preload.js
git commit -m "fix(security): sync customer notes channels in preload invoke whitelist"
```

---

### Task 3: Đồng bộ toàn bộ Test Suites vào `package.json` và `validate-build.js`

**Files:**
- Modify: `package.json:11`
- Modify: `validate-build.js:83-88`

**Step 1: Cập nhật script `test` trong `package.json`**
Bao gồm đầy đủ tất cả các test suites:
- `test/parser.test.js`
- `test/app.test.js`
- `test/excel_automation.test.js`
- `test/excel_smoke.test.js`
- `test/note-sanitizer.test.mjs`
- `test/product-edit.test.mjs`
- `test/alias-audit.test.js`
- `test/matching-golden.test.mjs`

**Step 2: Cập nhật mảng `TEST_SUITES` trong `validate-build.js`**
Đồng bộ 8 file test trên vào pre-build verification gate.

**Step 3: Chạy toàn bộ test suite**
Run: `npm test`
Expected: Chạy toàn bộ 128+ tests và PASS 100%.

**Step 4: Commit**
```bash
git add package.json validate-build.js
git commit -m "test: include alias-audit and matching-golden suites in full test runner and prebuild gate"
```

---

### Task 4: Dọn dẹp vệ sinh Repository & Cập nhật `.gitignore`

**Files:**
- Modify: `.gitignore`

**Step 1: Cập nhật `.gitignore`**
Thêm các pattern mở rộng cho file tạm, dump, và ảnh chụp kiểm thử.

**Step 2: Kiểm tra `git status`**
Run: `git status -s`
Expected: Cây git gọn gàng, chỉ chứa các file nguồn chính thức.

**Step 3: Commit**
```bash
git add .gitignore
git commit -m "chore: expand gitignore patterns for scratch and diagnostic dumps"
```

---

## Verification Plan

### Automated Tests
1. **Toàn bộ Unit & Integration tests:**
   `npm test`
2. **Build Validation Gate:**
   `npm run validate`
3. **Renderer Vite Build:**
   `npm run build:renderer`

### Manual Verification
- Khởi động thử `npm run start` (hoặc `npm run dev:electron`) để xác nhận không có lỗi module resolution hay runtime error.

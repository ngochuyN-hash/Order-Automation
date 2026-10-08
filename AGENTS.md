# HƯỚNG DẪN DÀNH CHO CODING AGENT (AGENTS.MD)

Tài liệu này chứa các quy tắc bất biến và chỉ dẫn bắt buộc dành cho mọi Coding Agent / AI Assistant (Cursor, Copilot, ZCode, Claude, v.v.) khi làm việc trên codebase **Order Automation**.

---

## 1. QUY TẮC BẤT BIẾN VỀ `db.js` (TRÁNH TRÀN TOKEN)
- **Tuyệt đối KHÔNG đọc toàn bộ file `default-db.json`** bằng lệnh đọc nguyên file (`Read` không giới hạn dòng). Với `db.js` (~3.100 dòng logic) cũng hạn chế đọc nguyên file, dùng grep/đọc có giới hạn.
- Từ 10/2026: **dữ liệu danh mục + GIÁ nằm riêng ở `default-db.json`** (530 SP, 4 chiến dịch, hơn 11.000 dòng JSON khi render) — `db.js` KHÔNG còn chứa dữ liệu, chỉ `import default-db.json` và giữ logic. File JSON này chứa giá nội bộ, **chỉ tồn tại local, KHÔNG nằm trong git/GitHub**.
- Việc đọc nguyên các file này sẽ làm tràn context window và lãng phí token vô ích.
- **Cách tra cứu đúng khi cần:**
  - Tra cứu hàm nghiệp vụ (logic tính giá, quà tặng, alias): Sử dụng công cụ tìm kiếm từ khóa (`grep`, `ast_grep`) hoặc đọc có giới hạn (`offset` và `limit` tối đa 100-200 dòng quanh vị trí cần tìm) trên `db.js`.
  - Tra cứu cấu trúc/giá danh mục sản phẩm: grep hoặc đọc có giới hạn trên `default-db.json` (file thật, local-only), hoặc đọc tóm tắt trong `README.md` / `PROJECT_CODE_SUMMARY.md`.
  - Sửa dữ liệu sản phẩm/giá → sửa `default-db.json`; sửa logic → sửa `db.js`. Chỉ sửa khi người dùng yêu cầu rõ ràng.

---

## 2. QUY TẮC VỀ RENDERER & CODEBASE
- **Entry chính của Renderer là `src/main.js`**:
  - **`app.js` KHÔNG tồn tại ở root nữa** — bản monolith cũ đã dời thành `test/fixtures/app-legacy.js` (chỉ test dùng). Không có file legacy nào ở root.
  - **Các file root dưới đây là LIVE, được import và được đóng gói — sửa nặng ngang `src/`:**
    `parser.js` (15 nơi import) · `ui-renderer.js` (module lớn nhất repo, 16 nơi) · `ai-service.js` · `store.js` · `db-store.js` · `db.js`.
    Xác minh: `src/main.js:6-10` import trực tiếp; `electron-builder.yml:24-49` liệt kê trong `files:`; `validate-build.js:6-30` hard-fail nếu thiếu.
    **Không được coi chúng là legacy và bỏ qua.**
  - Mọi logic giao diện, sự kiện click/input, luồng xử lý đơn hàng ở phía renderer nên đặt trong thư mục `src/` (`src/main.js`, `src/order/*`, `src/ui/*`, `src/kiotviet/*`).
  - Sau khi sửa code trong `src/`, cần build renderer (`npm run build:renderer`) nếu cần kiểm thử trên bản phân phối.

---

## 3. CÁC NGUYÊN TẮC BẤT BIẾN KHÁC (INVARIANTS)
1. **Luôn đọc & cập nhật `README.md` và `PROJECT_CODE_SUMMARY.md`**: Khi bắt đầu một phiên làm việc, luôn đối chiếu hai tài liệu này; làm xong tính năng mới phải cập nhật lại cả hai.
2. **Không ghi đè công thức Excel**: Cột Phân loại, Bao bì, Spec, Mã KT, Thành tiền và footer SUM phải do Excel tự tính; Python chỉ điều khiển `FillDown`.
3. **Mã `kvCode` là bất biến**: Tra cứu theo thứ tự `kv-name-map.json` -> `product.kvCode` -> hậu tố quy cách.
4. **Whitelist IPC nghiêm ngặt**: Mọi kênh IPC mới giữa Main và Renderer đều phải khai báo trong `preload.js`.
5. **Giữ nguyên `position: sticky`**: Không được thêm `contain: layout` vào `.order-results` trong `style.css`.
6. **Kiểm thử trước khi hoàn tất**: Luôn chạy `npm test` để bảo đảm toàn bộ test suite vượt qua trước khi kết thúc tác vụ.
7. **Quy tắc làm việc với Excel & Đóng file (Bất biến)**:
   - **Bắt buộc LƯU file trước khi đóng:** Khi đóng bất kỳ file/workbook nào, bắt buộc phải lưu (`wb.Save()`, `wb.Close(SaveChanges=True)`) rồi mới được tắt. Tuyệt đối không được đóng ngang hoặc kill tiến trình khi chưa lưu.
   - **Chỉ đóng có chọn lọc:** Tuyệt đối KHÔNG BAO GIỜ tắt toàn bộ ứng dụng Excel hoặc kill tiến trình hàng loạt (`taskkill /im excel.exe`, `Stop-Process -Name excel`, `xl.Quit()` bừa bãi khi có file khác đang mở). Chỉ đóng có chọn lọc đúng workbook làm việc (`wb.Close()`), bảo toàn nguyên vẹn mọi file khác của người dùng.
   - **Bắt buộc hỏi ý kiến người dùng** trước khi đóng bất kỳ file Excel nào.
8. **Push GitHub chỉ qua script sanitize (Bất biến)**: KHÔNG bao giờ `git push` trực tiếp từ repo này
   (hook pre-push chặn vì working tree chứa identifier thật). Chạy `node scripts/build-public-repo.mjs` —
   script build snapshot đã sanitize (brand thật → tên giả Zentor/Torvex/Xvil/Veltron…, mã KV/giá → giả),
   commit 1 commit duy nhất rồi force-push. Từ điển nằm trong script — file local-only gitignored:
   KHÔNG commit, KHÔNG đưa vào source zip. Bản hiển thị trên GitHub = vỏ tính năng, không chạy được
   vì thiếu các file dữ liệu local-only (đúng chủ đích).


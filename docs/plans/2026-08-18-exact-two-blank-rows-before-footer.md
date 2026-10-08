# Chuẩn hóa đúng 2 dòng trống trước hàng Tổng cộng (Footer) trong Excel Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Đảm bảo khi xuất đơn hàng ra Excel, bảng dữ liệu luôn có đúng số dòng sản phẩm + đúng 2 dòng trống đệm trước hàng Tổng cộng (Footer), không bị thừa khoảng trắng khi đơn ít món và không bị thiếu khi đơn nhiều món.

**Architecture:** Điều chỉnh logic co giãn dòng trong `excel_automation.py` ở Bước 7: nếu số dòng hiện tại của sheet nguồn nhiều hơn `len(items) + 2`, thực hiện xóa các dòng thừa (`sheet.Rows(...).Delete()`); nếu ít hơn, thực hiện chèn thêm dòng (`sheet.Rows(...).Insert()`). Sau đó cập nhật dải fill và footer target row chuẩn xác.

**Tech Stack:** Python 3.12, win32com (Excel COM Automation).

---

### Task 1: Cập nhật cơ chế điều chỉnh số dòng trong `excel_automation.py`

**Files:**
- Modify: `excel_automation.py:1370-1390`
- Test: `_test_blank_rows.py`

**Step 1: Viết test case kiểm tra việc giữ đúng 2 dòng trống**
- Tạo script test tạo đơn 2 sản phẩm trên template có 18 dòng trống ban đầu.
- Xác thực vị trí footer: `footer_row == start_row + 2 + 2 = start_row + 4`.
- Xác thực công thức `=SUM(...)` và các định dạng ô đệm.

**Step 2: Cập nhật code trong `excel_automation.py`**
- Tại Bước 7:
  - Tính `target_total_rows = new_item_rows + 2`.
  - Nếu `target_total_rows > existing_item_rows`: chèn thêm `target_total_rows - existing_item_rows` dòng.
  - Nếu `target_total_rows < existing_item_rows`: xóa `existing_item_rows - target_total_rows` dòng thừa ngay trước footer.
  - Đặt `total_rows = target_total_rows`.
  - Đặt `footer_target_row = start_row + total_rows`.

**Step 3: Chạy test kiểm thử tự động và kiểm tra kết quả**
- Chạy test với đơn 1 món, đơn 2 món, đơn 10 món, đơn 25 món.
- Đảm bảo khoảng cách giữa dòng sản phẩm cuối và hàng footer luôn luôn là 2 dòng trống.

**Step 4: Dọn dẹp test script**

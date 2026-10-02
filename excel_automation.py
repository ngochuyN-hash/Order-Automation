#!/usr/bin/env python3
"""
excel_automation.py — Excel order automation driven via win32com (real Excel).

This is a faithful Python port of the proven `excel-automation.ps1`. By driving
the real Excel application through COM we get native behaviour that openpyxl
cannot replicate:
  * `Range.FillDown()` propagates formulas + values + formats AND adjusts
    relative row references (e.g. =H24*I24 -> =H25*I25).
  * `Rows.Insert()` shifts rows AND rewrites every formula reference in the
    sheet (footer =SUM(...), downstream =J44*0.04, VLOOKUP ranges, ...).
  * Inserted rows inherit row height / borders / merged cells automatically.

The CLI is intentionally identical to the previous openpyxl version so that
`main.js` needs no changes:

    python excel_automation.py --file <path> --customer <name> --date <date> \
        --items <json_path> [--tln <tln_path>] [--title <order_title>] \
        [--meta <meta_json_path>]
"""

import argparse
import glob
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import zipfile
import hashlib
from datetime import datetime

# ── Force UTF-8 stdout/stderr (Windows console mặc định cp1252 → lỗi tiếng Việt) ──
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

import pythoncom
import win32com.client

# ─────────────────────────── Excel COM constants ───────────────────────────
# Late binding (Dispatch) → no generated constants, so use numeric values.

XL_SHIFT_DOWN = -4121        # Rows.Insert shift direction
XL_VALUES = -4163            # Find LookIn:=xlValues
XL_WHOLE = 1                 # Find LookAt:=xlWhole
XL_PART = 2                  # Find LookAt:=xlPart
XL_CONSTANTS = 2             # SpecialCells xlCellTypeConstants
XL_LAST_CELL = 11            # SpecialCells xlCellTypeLastCell
XL_COLOR_NONE = -4142        # Interior.ColorIndex := xlNone / Borders LineStyle xlNone
XL_CENTER = -4108            # HorizontalAlignment := xlCenter
XL_RIGHT = -4152             # HorizontalAlignment := xlRight
GIFT_GREEN = 5296274         # RGB for gift/FOC rows (matches PS1)
FONT_RED = 255               # Font colour for Extra rows (COM BGR: FF0000 → 255)
FONT_BLACK = 0               # Default black font (FOC rows / paid rows reset)

# Border edge indices (XlBordersIndex) for per-cell border capture/restore.
XL_EDGE_LEFT = 7
XL_EDGE_TOP = 8
XL_EDGE_BOTTOM = 9
XL_EDGE_RIGHT = 10
ROW_EDGES = (XL_EDGE_LEFT, XL_EDGE_TOP, XL_EDGE_BOTTOM, XL_EDGE_RIGHT)

LAST_COL = 15                # Columns to scan for mapping & footer save
SEARCH_LIMIT = 500           # Max rows to scan for footer
MAX_SHEET_NUM = 200          # Ignore sheets numbered >= 200
V_THUNG = "th\u00f9ng"       # thùng


# ─────────────────────────── Helpers ───────────────────────────────────────

def col_letter(idx):
    """1-based column index -> letter (valid for columns 1-26, we use <=15)."""
    return chr(64 + idx)


def clear_cell_keep_formula(sheet, r, c):
    """Xoá nội dung ô CHỈ khi nó là giá trị tĩnh. Ô CÔNG THỨC được giữ nguyên.

    Trong file PO gốc, mã KT (VLOOKUP theo tên sản phẩm) và tổng trước thuế
    (thành tiền/1.08...) là công thức — xoá trắng chúng là mất vĩnh viễn công
    thức. Giữ lại để Excel tự tính lại theo tên SP / số lượng vừa ghi.
    """
    try:
        cell = sheet.Cells(r, c)
        if bool(cell.HasFormula):
            return
        cell.Value2 = ""
    except Exception:
        pass


def extract_vlookup_expr(formula_str):
    """Extract inner VLOOKUP(...) call from a formula string."""
    if not formula_str or not isinstance(formula_str, str):
        return None
    idx = formula_str.upper().find("VLOOKUP(")
    if idx == -1:
        return None
    start = idx
    paren_count = 0
    end = -1
    for i in range(idx + len("VLOOKUP"), len(formula_str)):
        char = formula_str[i]
        if char == '(':
            paren_count += 1
        elif char == ')':
            paren_count -= 1
            if paren_count == 0:
                end = i + 1
                break
    if end != -1:
        return formula_str[start:end]
    return None


def wrap_vlookup_formula(formula_str):
    """
    Wrap VLOOKUP formula to clean #N/A, 0, and '0' errors.
    Formula structure:
    =IFERROR(IF(OR(VLOOKUP(...)=0, VLOOKUP(...)="0", VLOOKUP(...)=""), "", VLOOKUP(...)), "")
    """
    if not formula_str or not isinstance(formula_str, str):
        return formula_str

    clean = formula_str.upper().replace(" ", "")
    if "IFERROR(IF(OR(VLOOKUP(" in clean:
        return formula_str

    vlookup_expr = extract_vlookup_expr(formula_str)
    if not vlookup_expr:
        return formula_str

    wrapped = f"=IFERROR(IF(OR({vlookup_expr}=0, {vlookup_expr}=\"0\", {vlookup_expr}=\"\"), \"\", {vlookup_expr}), \"\")"
    return wrapped



def get_excel_pids():
    """Return the set of currently running EXCEL.EXE process ids."""
    pids = set()
    try:
        out = subprocess.check_output(
            ['tasklist', '/FI', 'IMAGENAME eq EXCEL.EXE', '/FO', 'CSV', '/NH'],
            text=True, stderr=subprocess.DEVNULL,
        )
        for line in out.splitlines():
            if 'EXCEL.EXE' not in line.upper():
                continue
            parts = line.replace('"', '').split(',')
            if len(parts) >= 2 and parts[1].strip().isdigit():
                pids.add(int(parts[1]))
    except Exception:
        pass
    return pids


def deduplicate_media_images(xlsx_path, verbose=False):
    """Khử trùng lặp ảnh trong gói OpenXML (.xlsx) sau khi tạo đơn."""
    if not xlsx_path or not os.path.isfile(xlsx_path) or not str(xlsx_path).lower().endswith('.xlsx'):
        return False
    try:
        with zipfile.ZipFile(xlsx_path, 'r') as zin:
            names = zin.namelist()
            media_files = [n for n in names if n.startswith('xl/media/')]
            if len(media_files) <= 1:
                return True

            by_hash = {}
            for mf in media_files:
                data = zin.read(mf)
                h = hashlib.sha256(data).hexdigest()
                by_hash.setdefault(h, []).append(mf)

            dup_map = {}
            canonical_files = set()
            for h, files in by_hash.items():
                files_sorted = sorted(files, key=lambda x: (len(os.path.splitext(os.path.basename(x))[0]), x))
                canon = files_sorted[0]
                canonical_files.add(canon)
                canon_name = os.path.basename(canon)
                for f in files_sorted[1:]:
                    dup_map[os.path.basename(f)] = canon_name

            if not dup_map:
                return True

            new_contents = {}
            for name in names:
                if name.endswith('.rels'):
                    content = zin.read(name).decode('utf-8')
                    modified = False
                    for dup_name, canon_name in dup_map.items():
                        if dup_name in content:
                            content = content.replace(dup_name, canon_name)
                            modified = True
                    if modified:
                        new_contents[name] = content.encode('utf-8')

            temp_out = xlsx_path + f".tmp_dedup_{os.getpid()}.xlsx"
            with zipfile.ZipFile(temp_out, 'w', compression=zipfile.ZIP_DEFLATED) as zout:
                for item in zin.infolist():
                    if item.filename.startswith('xl/media/') and item.filename not in canonical_files:
                        continue
                    if item.filename in new_contents:
                        zout.writestr(item.filename, new_contents[item.filename])
                    else:
                        zout.writestr(item, zin.read(item.filename))

        with zipfile.ZipFile(temp_out, 'r') as zcheck:
            if zcheck.testzip() is not None:
                if os.path.exists(temp_out):
                    os.remove(temp_out)
                return False

        os.replace(temp_out, xlsx_path)
        if verbose:
            print(f"[DedupMedia] Đã khử trùng lặp {len(dup_map)} ảnh thừa trong {os.path.basename(xlsx_path)}.")
        return True
    except Exception as e:
        if verbose:
            print(f"[DedupMedia] Bỏ qua tối ưu ảnh: {e}")
        return False


# COM error codes for transient "Excel is busy" states.
_RPC_E_CALL_REJECTED = -2147418111
_RPC_E_SERVERCALL_RETRYLATER = -2147417846


# ─── Backup / Restore ────────────────────────────────────────────────────────

MAX_BACKUPS = 5


def prune_old_backups(file_path, keep=MAX_BACKUPS):
    """Keep only the `keep` newest backups of `file_path`; delete the rest."""
    base, ext = os.path.splitext(file_path)
    pattern = f"{base}_backup_*{ext}"
    backups = sorted(glob.glob(pattern), reverse=True)  # name embeds sortable timestamp
    for old in backups[keep:]:
        try:
            os.remove(old)
            print(f"Backup pruned: {old}")
        except Exception as err:
            print(f"WARNING: Could not prune old backup {old}: {err}")


def backup_workbook(file_path):
    """Create a timestamped backup of the workbook before mutation.
    Returns the backup path, or None if backup was skipped."""
    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    base, ext = os.path.splitext(file_path)
    backup_path = f"{base}_backup_{ts}{ext}"
    shutil.copy2(file_path, backup_path)
    print(f"Backup created: {backup_path}")
    prune_old_backups(file_path)
    return backup_path


def restore_from_backup(backup_path, file_path):
    """Restore the original workbook from a backup after a failed save."""
    if backup_path and os.path.exists(backup_path):
        try:
            shutil.copy2(backup_path, file_path)
            print(f"Restored from backup: {backup_path}")
        except Exception as restore_err:
            print(f"WARNING: Could not restore from backup: {restore_err}")


def _launch_excel():
    """
    Start Excel and set it up, retrying through transient COM busy/rejected
    states that can occur right after launch (e.g. a previous instance is
    still terminating). Cleans up partially-initialised instances on failure.
    """
    last_err = None
    for attempt in range(6):
        app = None
        try:
            # DispatchEx forces a brand-new isolated Excel instance (never
            # attaches to a stale/busy one already running).
            app = win32com.client.DispatchEx("Excel.Application")
            app.Visible = False
            app.DisplayAlerts = False
            app.ScreenUpdating = False
            return app
        except (pythoncom.com_error, AttributeError) as e:
            last_err = e
            try:
                if app is not None:
                    app.Quit()
            except Exception:
                pass
            time.sleep(0.4 * (attempt + 1))
    raise RuntimeError(
        "Kh\u00f4ng th\u1ec3 kh\u1edfi \u0111\u1ed9ng Excel. "
        "Vui l\u00f2ng c\u00e0i \u0111\u1eb7t Microsoft Excel. "
        f"(Cannot start Excel: {last_err})"
    )


def find_cell(sheet, text):
    """
    Find a cell containing `text` in the used range.
    Tries whole-cell match first, then partial match (mirrors PS1 Find-Cell).
    Returns a Range or None.
    """
    used = sheet.UsedRange
    found = used.Find(What=text, LookIn=XL_VALUES, LookAt=XL_WHOLE)
    if found is None:
        found = used.Find(What=text, LookIn=XL_VALUES, LookAt=XL_PART)
    return found


# ─────────────────────── 1. Sheet discovery / cloning ──────────────────────

def extract_seq_from_title(title):
    """
    Extract the order sequence number from the order title
    (format: {PREFIX}{YY}{MM}-{seq}-...).
    E.g. 'AUXSG2607-16-Phúc-CH-3%' → 16
    Returns int or None if not extractable.
    """
    if not title:
        return None
    m = re.search(r'\d{4}-(\d+)-', title)
    if m:
        return int(m.group(1))
    return None


def find_rightmost_numbered_sheet(wb):
    """
    Find the sheet with the highest numeric prefix (pattern N-CustomerName,
    N < 200), scanning from the right. Returns (sheet, maxNum, 1-based index)
    or (first_sheet, 0, 1) when none matches.
    """
    pattern = re.compile(r'^0*(\d+)-(.*)')
    max_num = -1
    target = None
    target_idx = 1

    for i in range(wb.Sheets.Count, 0, -1):
        name = wb.Sheets.Item(i).Name
        m = pattern.match(name)
        if m:
            num = int(m.group(1))
            if num < MAX_SHEET_NUM:
                max_num = num
                target = wb.Sheets.Item(i)
                target_idx = i
                break

    if target is None:
        target = wb.Sheets.Item(1)
        max_num = 0
        target_idx = 1

    return target, max_num, target_idx


# ─────────────────── 2. Customer / date / title filling ────────────────────

def _write_below_label(sheet, label, value):
    """
    Write `value` into the cell directly below `label`, resolving to the
    top-left cell of any merged range (writing to a secondary merged cell
    raises a COM error).
    """
    cell = sheet.Cells(label.Row + 1, label.Column)
    if cell.MergeCells:
        cell = cell.MergeArea.Cells(1, 1)
    cell.Value2 = str(value)


def fill_customer_and_date(sheet, customer_name, order_date, order_title):
    """Write customer name, order title and date below their labels."""
    cust_label = find_cell(sheet, "Kh\u00e1ch h\u00e0ng")   # Khách hàng
    if cust_label is None:
        cust_label = find_cell(sheet, "Khach hang")

    if cust_label is not None:
        _write_below_label(sheet, cust_label, customer_name)
    else:
        sheet.Cells(9, 1).Value2 = str(customer_name)

    # Order title: prefer a dedicated PO / order-number field; fall back to the
    # cell right of the customer name only when it is safely writable.
    if order_title:
        title_label = find_cell(sheet, "\u0110\u01a1n h\u00e0ng s\u1ed1")  # Đơn hàng số
        if title_label is None:
            title_label = find_cell(sheet, "PO no")
        if title_label is not None:
            _write_below_label(sheet, title_label, order_title)
        elif cust_label is not None:
            tcell = sheet.Cells(cust_label.Row + 1, cust_label.Column + 1)
            if tcell.MergeCells:
                top_left = tcell.MergeArea.Cells(1, 1)
                if top_left.Address != tcell.Address:
                    # Secondary merged cell (e.g. B9 in A9:B11) — skip past
                    # this merge area to the next writable column.
                    merge_end_col = tcell.MergeArea.Column + tcell.MergeArea.Columns.Count - 1
                    tcell = sheet.Cells(cust_label.Row + 1, merge_end_col + 1)
            if tcell.MergeCells:
                tcell = tcell.MergeArea.Cells(1, 1)
            tcell.Value2 = str(order_title)
        else:
            sheet.Cells(9, 2).Value2 = str(order_title)

    date_label = find_cell(sheet, "Ng\u00e0y")              # Ngày
    if date_label is None:
        date_label = find_cell(sheet, "Ngay")

    if date_label is not None:
        _write_below_label(sheet, date_label, order_date)
    else:
        sheet.Cells(9, 8).Value2 = str(order_date)


# ─────────────────── 3. Header detection ───────────────────────────────────

def find_header_row(sheet):
    """Locate the item-table header row by finding 'Sản phẩm'/'Product name'."""
    header_cell = find_cell(sheet, "S\u1ea3n ph\u1ea9m")    # Sản phẩm
    if header_cell is None:
        header_cell = find_cell(sheet, "Product name")
    if header_cell is None:
        raise RuntimeError("Could not find table header (S\u1ea3n ph\u1ea9m / Product name)")
    return header_cell.Row


# ─────────────── 4. Footer detection (3-pass fallback) ─────────────────────

def detect_footer_row(sheet, start_row, items_count):
    """
    Detect the footer (total) row.
      Pass 1: text scan for 'Tổng'/'Total' in columns 1-8.
      Pass 2: formula scan for =SUM/=SUMPRODUCT/=SUBTOTAL with range check.
      Pass 3: last non-empty row in columns 1-5.
      Default: max(20, items+5) rows below the header.
    """
    footer_row = 0

    # Pass 1: text-based
    print(f"Searching for footer row from {start_row} to {start_row + SEARCH_LIMIT}...")
    for r in range(start_row, start_row + SEARCH_LIMIT + 1):
        for c in range(1, 9):
            try:
                val = sheet.Cells(r, c).Text
            except Exception:
                try:
                    val = sheet.Cells(r, c).Value2
                except Exception:
                    val = None
            if val is None:
                continue
            s = str(val).strip()
            if re.match(r'(?i)^T.{1,3}ng', s) and len(s) <= 30 and not s[0].isdigit() and re.search(r'(?i)(tiền|thanh|toán|cộng|trả|payment|amount)', s):
                footer_row = r
                break
            if re.search(r'(?i)\bTotal\b', s):
                footer_row = r
                break
        if footer_row > 0:
            break

    # Pass 2: formula-based
    if footer_row == 0:
        print("Text search failed, trying formula-based detection...")
        for r in range(start_row + 3, start_row + SEARCH_LIMIT + 1):
            for c in range(1, 16):
                try:
                    f = sheet.Cells(r, c).Formula
                    if f is None:
                        continue
                    fs = str(f)
                    if re.match(r'(?i)^(=SUM\(|=SUMPRODUCT\(|=SUBTOTAL\()', fs):
                        m = re.search(r'(\d+):', fs)
                        if m:
                            range_start = int(m.group(1))
                            if abs(range_start - start_row) <= 2:
                                footer_row = r
                                print(f"Found footer via formula at row {r}, col {c}: {fs}")
                                break
                        else:
                            footer_row = r
                            print(f"Found footer via column formula at row {r}, col {c}: {fs}")
                            break
                except Exception:
                    pass
            if footer_row > 0:
                break

    # Pass 3: last non-empty row
    if footer_row == 0:
        print("Formula search failed, using last non-empty row fallback...")
        try:
            last_row = sheet.Cells.SpecialCells(XL_LAST_CELL).Row
            if last_row > start_row:
                for r in range(last_row, start_row - 1, -1):
                    for c in range(1, 6):
                        try:
                            val = sheet.Cells(r, c).Text
                        except Exception:
                            try:
                                val = sheet.Cells(r, c).Value2
                            except Exception:
                                val = None
                        if val is None:
                            continue
                        if str(val).strip():
                            footer_row = r
                            break
                    if footer_row > 0:
                        break
        except Exception:
            pass

    # Default
    if footer_row == 0:
        min_rows = max(20, items_count + 5)
        footer_row = start_row + min_rows
        print(f"WARNING: Could not detect footer row. Using safe default: row {footer_row}")

    print(f"Footer row detected: {footer_row}")
    return footer_row


# ───────────────── 5. Column mapping ───────────────────────────────────────

def map_columns(sheet, header_row):
    """Map header-row labels to column indices (Vietnamese + English)."""
    cols = {k: 0 for k in (
        'product', 'category', 'spec', 'carton_qty', 'bottle_qty',
        'bottle_price', 'carton_price', 'amount', 'before_tax',
        'invoice_price', 'ma_kt',
    )}

    for c in range(1, LAST_COL + 1):
        try:
            val = sheet.Cells(header_row, c).Text
        except Exception:
            try:
                val = sheet.Cells(header_row, c).Value2
            except Exception:
                val = None
        if val is None:
            continue
        v = str(val).lower()

        if ("s\u1ea3n ph\u1ea9m" in v or "product" in v) and cols['product'] == 0:
            cols['product'] = c
        elif ("ph\u00e2n lo\u1ea1i" in v or "category" in v) and cols['category'] == 0:
            cols['category'] = c
        elif (v.strip() == "z" or "spec" in v or "package" in v or "bao b" in v) and cols['spec'] == 0:
            cols['spec'] = c
        elif ("th\u00f9ng" in v and ("s\u1ed1 l\u01b0\u1ee3ng" in v or "qty" in v or "unit" in v or "\u0111\u01a1n v\u1ecb" in v)) and cols['carton_qty'] == 0:
            cols['carton_qty'] = c
        elif (("b\u00ecnh" in v or "chai" in v or "lon" in v or "bottle" in v or "quantity" in v)
              and ("s\u1ed1 l\u01b0\u1ee3ng" in v or "qty" in v or "\u0111\u01a1n v\u1ecb" in v)) and cols['bottle_qty'] == 0:
            cols['bottle_qty'] = c
        elif ("\u0111\u01a1n gi\u00e1" in v and ("b\u00ecnh" in v or "chai" in v or "lon" in v or "bottle" in v)) and cols['bottle_price'] == 0:
            cols['bottle_price'] = c
        elif ("\u0111\u01a1n gi\u00e1" in v and ("th\u00f9ng" in v or "carton" in v or "x\u00f4" in v or "phuy" in v)) and cols['carton_price'] == 0:
            cols['carton_price'] = c
        elif ("th\u00e0nh ti\u1ec1n" in v or "amount" in v) and cols['amount'] == 0:
            cols['amount'] = c
        elif ("tr\u01b0\u1edbc thu\u1ebf" in v or "before tax" in v) and cols['before_tax'] == 0:
            cols['before_tax'] = c
        elif ("gi\u00e1 h\u0111" in v or "gi\u00e1 ho\u00e1 \u0111\u01a1n" in v) and cols['invoice_price'] == 0:
            cols['invoice_price'] = c
        elif ("m\u00e3 kt" in v or "m\u00e3 k\u1ebf to\u00e1n" in v or "product code" in v) and cols['ma_kt'] == 0:
            cols['ma_kt'] = c

    return cols


# ─────────────── 6. Footer save / restore ──────────────────────────────────

def save_footer_data(sheet, footer_row):
    """Capture footer values/formulas before row operations.

    Formatting (fill, bold, borders) is deliberately NOT sampled here: the
    footer row keeps its native formatting both when it stays in place and
    when Rows.Insert shifts it down. The old approach sampled column 1's
    fill/bold and re-painted the whole row with them, which wiped per-cell
    styling — e.g. Torvex's grey bold 'Tổng tiền đơn hàng:' label merged
    across B:D while column A is plain white/non-bold.
    """
    data = {}
    for c in range(1, LAST_COL + 1):
        cell = sheet.Cells(footer_row, c)
        try:
            has_formula = bool(cell.HasFormula)
        except Exception:
            has_formula = False
        if has_formula:
            data[c] = ('formula', cell.Formula, cell.NumberFormat)
        else:
            data[c] = ('value', cell.Value2, cell.NumberFormat)
    return data


def restore_footer_data(sheet, footer_target_row, data, start_row, normal_row_intervals=None):
    """Write the saved footer back at its (possibly moved) position, expanding
    any aggregate range so it covers the new data region (excluding FOC / gift rows).
    Only values and formulas are rewritten — the row's formatting is left untouched so the
    template's fill/bold/borders survive."""
    data_end_row = footer_target_row - 1
    for c in range(1, LAST_COL + 1):
        cell = sheet.Cells(footer_target_row, c)
        info = data.get(c)
        if not info:
            continue
        kind, val, nf = info
        if kind == 'formula':
            cell.Formula = _rewrite_footer_formula(
                str(val), start_row, data_end_row, normal_row_intervals,
                fallback_col=col_letter(c))
            cell.NumberFormat = nf
        elif val is not None:
            # Skip empty cells (e.g. secondary cells of the merged label)
            # so their native formatting is never disturbed.
            cell.Value2 = val
            cell.NumberFormat = nf


# ─────────────── Merged-cell handling ─────────────────────────────────

def _rewrite_footer_formula(formula, start_row, end_row, normal_row_intervals=None, fallback_col=None):
    """
    Rewrite a footer aggregate formula so its item-table range covers
    normal_row_intervals (excluding FOC / gift rows). If normal_row_intervals
    is None, covers start_row..end_row.
    Robust across multiple sheet generations: handles single-range SUM(L20:L25)
    and multi-range SUM(L20:L20, L22:L22) without drift or duplication.
    fallback_col: cột của chính ô footer đang ghi — dùng để chữa lành các
    công thức đã hỏng dạng SUM(0) (tàn dư của đơn toàn quà tặng) mà không
    còn chữ cột nào bên trong để suy ra range.
    """
    if not formula or not isinstance(formula, str):
        return formula

    def _repl_sum(m):
        inner = m.group(1).strip()
        col_match = re.search(r'([A-Z]{1,3})\$?\d+', inner, re.I)
        if col_match:
            col = col_match.group(1).upper()
        elif fallback_col:
            col = fallback_col.upper()
        else:
            return m.group(0)

        if normal_row_intervals is None:
            return f"SUM({col}{start_row}:{col}{end_row})"
        if len(normal_row_intervals) == 0:
            return "SUM(0)"
        arg_str = ", ".join(f"{col}{s}:{col}{e}" for s, e in normal_row_intervals)
        return f"SUM({arg_str})"

    return re.sub(r'(?i)SUM\s*\(([^)]+)\)', _repl_sum, formula)


def detect_merge_pattern(sheet, row):
    """
    Detect single-row horizontal merged ranges in `row`.
    Returns a list of (col_start, col_end) tuples (1-based, inclusive).
    """
    patterns = []
    c = 1
    while c <= LAST_COL:
        cell = sheet.Cells(row, c)
        if cell.MergeCells:
            area = cell.MergeArea
            if area.Rows.Count == 1 and area.Column == c:
                col_end = area.Column + area.Columns.Count - 1
                patterns.append((area.Column, col_end))
                c = col_end + 1
                continue
        c += 1
    if patterns:
        print(f"Detected {len(patterns)} merge pattern(s) in row {row}: {patterns}")
    return patterns


def unmerge_data_region(sheet, start_row, end_row):
    """Unmerge every merged range that lies fully within the data region."""
    count = 0
    for r in range(start_row, end_row + 1):
        for c in range(1, LAST_COL + 1):
            try:
                cell = sheet.Cells(r, c)
                if cell.MergeCells:
                    area = cell.MergeArea
                    if area.Row >= start_row and area.Row + area.Rows.Count - 1 <= end_row:
                        area.UnMerge()
                        count += 1
            except Exception:
                pass
    if count:
        print(f"Unmerged {count} range(s) in data region.")


def apply_merge_pattern(sheet, start_row, total_rows, patterns):
    """Re-apply the per-row merge pattern to each data row."""
    if not patterns:
        return
    count = 0
    for offset in range(total_rows):
        r = start_row + offset
        for (col_start, col_end) in patterns:
            sheet.Range(sheet.Cells(r, col_start), sheet.Cells(r, col_end)).Merge()
            count += 1
    print(f"Applied {count} merged range(s) across {total_rows} rows.")


# ─────────────── Template row format preservation ───────────────────

def row_is_gift_painted(sheet, row, product_col, gift_color=GIFT_GREEN):
    """True when the row is painted with the gift/FOC colour (full-row paint)."""
    try:
        cell = sheet.Cells(row, product_col if product_col > 0 else 2)
        if cell.Interior.Pattern in (None, XL_COLOR_NONE):
            return False
        return int(cell.Interior.Color) == gift_color
    except Exception:
        return False

def capture_row_format(sheet, row, ignore_color=None):
    """
    Capture the visible per-cell formatting of a template row: the four
    edge borders (LineStyle/Weight/Color) and the fill colour of every
    column. Read BEFORE unmerging, so merged ranges report exactly what
    the user sees (the top-left cell's formatting).

    ignore_color: if set, any cell whose fill RGB equals this value is
    treated as 'no fill' (set to None). Used to exclude the detected gift
    colour when capturing fmt_first/fmt_mid. Pass None to keep all fills
    (e.g. when capturing fmt_gift itself).
    """
    fmt = {}
    for c in range(1, LAST_COL + 1):
        cell = sheet.Cells(row, c)
        borders = {}
        for edge in ROW_EDGES:
            try:
                ls = cell.Borders(edge).LineStyle
            except Exception:
                ls = None
            if ls is None or ls == XL_COLOR_NONE:
                borders[edge] = None
                continue
            try:
                weight = cell.Borders(edge).Weight
            except Exception:
                weight = 2  # xlThin
            try:
                color = cell.Borders(edge).Color
            except Exception:
                color = 0
            borders[edge] = (ls, weight, color)

        fill = None
        try:
            pattern = cell.Interior.Pattern
        except Exception:
            pattern = None
        if pattern not in (None, XL_COLOR_NONE):
            try:
                rgb = int(cell.Interior.Color)
                if ignore_color is not None and rgb == ignore_color:
                    fill = None
                else:
                    fill = rgb
            except Exception:
                fill = None

        fmt[c] = {'borders': borders, 'fill': fill}
    return fmt


def find_gift_format_row(sheet, start_row, end_row, fmt_first):
    """
    Scan the data region for a 'gift sample' row: a row where >= 60% of
    cells share the same non-white, non-default fill colour that differs
    from the template's standard fill (fmt_first's dominant fill).

    Returns (gift_row_idx, gift_color) or (None, GIFT_GREEN) as fallback.
    """
    # White / default fills are never a meaningful gift colour.
    IGNORE_FILLS = {16777215}  # 0xFFFFFF = white

    # Determine the dominant fill of fmt_first (most common non-None fill).
    fill_counts = {}
    for c in range(1, LAST_COL + 1):
        f = fmt_first[c]['fill']
        if f is not None:
            fill_counts[f] = fill_counts.get(f, 0) + 1
    dominant_fill = max(fill_counts, key=fill_counts.get) if fill_counts else None

    threshold = int(LAST_COL * 0.6)  # 60% of LAST_COL cells

    for r in range(start_row, end_row + 1):
        color_counts = {}
        for c in range(1, LAST_COL + 1):
            cell = sheet.Cells(r, c)
            try:
                pattern = cell.Interior.Pattern
            except Exception:
                continue
            if pattern in (None, XL_COLOR_NONE):
                continue
            try:
                rgb = int(cell.Interior.Color)
            except Exception:
                continue
            if rgb in IGNORE_FILLS:
                continue
            color_counts[rgb] = color_counts.get(rgb, 0) + 1

        if not color_counts:
            continue

        # Find the most common fill in this row
        top_color = max(color_counts, key=color_counts.get)
        top_count = color_counts[top_color]

        if top_count >= threshold and top_color != dominant_fill:
            print(f"Gift format row detected at row {r} "
                  f"(color={top_color}, {top_count}/{LAST_COL} cells).")
            return r, top_color

    return None, GIFT_GREEN


# ─────────────── Footer format preservation ───────────────────

FOOTER_LABEL_COL = 2   # the 'Tổng...' label is merged starting at column B
WHITE_FILL = 16777215  # 0xFFFFFF


def capture_footer_format(sheet, footer_row):
    """Per-cell borders + fill + bold of a footer row (COM truth)."""
    fmt = {}
    for c in range(1, LAST_COL + 1):
        cell = sheet.Cells(footer_row, c)
        borders = {}
        for edge in ROW_EDGES:
            try:
                ls = cell.Borders(edge).LineStyle
            except Exception:
                ls = None
            if ls is None or ls == XL_COLOR_NONE:
                borders[edge] = None
            else:
                try:
                    w = cell.Borders(edge).Weight
                except Exception:
                    w = 2
                try:
                    col = cell.Borders(edge).Color
                except Exception:
                    col = 0
                borders[edge] = (ls, w, col)
        fill = None
        try:
            if cell.Interior.Pattern not in (None, XL_COLOR_NONE):
                fill = int(cell.Interior.Color)
        except Exception:
            fill = None
        try:
            bold = bool(cell.Font.Bold)
        except Exception:
            bold = False
        fmt[c] = {'borders': borders, 'fill': fill, 'bold': bold}
    return fmt


def apply_footer_format(sheet, footer_row, fmt):
    """Write captured footer formatting back, cell by cell (values untouched).

    The TOP edge is deliberately skipped: it is the shared 'closing line' of
    the data grid, owned by the last data row's bottom border (fmt_last).
    """
    for c in range(1, LAST_COL + 1):
        cell = sheet.Cells(footer_row, c)
        info = fmt[c]
        for edge in ROW_EDGES:
            if edge == XL_EDGE_TOP:
                continue
            spec = info['borders'].get(edge)
            try:
                if spec is None:
                    cell.Borders(edge).LineStyle = XL_COLOR_NONE
                else:
                    ls, w, col = spec
                    cell.Borders(edge).LineStyle = ls
                    cell.Borders(edge).Weight = w
                    cell.Borders(edge).Color = col
            except Exception:
                pass
        try:
            if info['fill'] is None:
                cell.Interior.ColorIndex = XL_COLOR_NONE
            else:
                cell.Interior.Color = info['fill']
        except Exception:
            pass  # secondary merged cells: the primary already covers the range
        try:
            cell.Font.Bold = info['bold']
        except Exception:
            pass  # secondary merged cells inherit the primary's font


def footer_label_intact(sheet, footer_row):
    """True when the footer label cell is bold AND painted with a non-white
    fill — i.e. NOT bleached by the legacy 'paint the whole footer with the
    label-column fill' bug (which left it white/non-bold)."""
    try:
        label = sheet.Cells(footer_row, FOOTER_LABEL_COL)
        if not bool(label.Font.Bold):
            return False
        if label.Interior.Pattern in (None, XL_COLOR_NONE):
            return False
        return int(label.Interior.Color) != WHITE_FILL
    except Exception:
        return False


def find_intact_footer_sheet(wb, exclude_name):
    """Scan numbered order sheets right-to-left and return the first one whose
    footer label is still intact (bold + coloured fill) — the best style
    reference for healing a bleached footer. Returns (sheet, footer_row) or
    (None, 0)."""
    pattern = re.compile(r'^0*(\d+)-(.*)')
    for i in range(wb.Sheets.Count, 0, -1):
        sh = wb.Sheets.Item(i)
        name = sh.Name
        if name == exclude_name:
            continue
        m = pattern.match(name)
        if not m or int(m.group(1)) >= MAX_SHEET_NUM:
            continue
        try:
            hdr = find_header_row(sh)
            fr = detect_footer_row(sh, hdr + 1, 0)
            if footer_label_intact(sh, fr):
                print(f"Intact footer reference sheet: '{name}' (footer row {fr})")
                return sh, fr
        except Exception:
            continue
    return None, 0


def find_formula_donor(wb, exclude_name, col_idx, header_row):
    """Tìm sheet anh em còn GIỮ công thức ở cột `col_idx` dòng start_row
    (header_row + 1) để hồi phục công thức bị mất trên sheet đích.

    Bối cảnh: trang quà tặng (FOC) từng bị xoá trắng công thức mã KT / tổng
    trước thuế; clone từ trang đó làm các trang sau mất công thức theo. Vì mọi
    sheet trong cùng file có cùng layout (cùng header row), gán trực tiếp
    chuỗi formula của donor là chính xác về tham chiếu tương đối.
    Trả về chuỗi formula hoặc None. Bỏ qua formula chứa #REF! (đã hỏng).
    """
    pattern = re.compile(r'^0*(\d+)-(.*)')
    for i in range(wb.Sheets.Count, 0, -1):
        sh = wb.Sheets.Item(i)
        name = sh.Name
        if name == exclude_name:
            continue
        if not pattern.match(name):
            continue
        try:
            if find_header_row(sh) != header_row:
                continue
            cell = sh.Cells(header_row + 1, col_idx)
            if not bool(cell.HasFormula):
                continue
            f = str(cell.Formula or '')
            if not f.startswith('=') or '#REF!' in f.upper():
                continue
            print(f"Formula donor for col {col_idx}: '{name}' -> {f[:80]}")
            return f
        except Exception:
            continue
    return None


def apply_template_format(sheet, start_row, total_rows, fmt_first, fmt_mid,
                          merge_patterns, items, fmt_gift=None, fmt_last=None,
                          fill_mode='set', fmt_pre_last=None):
    """
    Re-apply the captured template-row formatting to the whole data region
    after the unmerge → FillDown → re-merge cycle. Without this, borders
    stored on secondary merged cells resurface on re-merge (turning the
    template's dotted row separators into double lines) and the template's
    fills (e.g. the grey amount columns) are lost. The first row keeps its
    own captured formatting (header-adjacent edges); every other row uses
    the middle-row pattern. Free/gift rows use the captured gift format
    (fmt_gift) when available, otherwise preserve the legacy GIFT_GREEN
    paint applied by write_items.

    fmt_last (optional): formatting of the template's LAST data row. Its
    bottom edge is the table's 'closing line' above the footer, which some
    templates style differently from the mid-row separators (e.g. Xvil uses
    a solid rule there while mid rows use dashes). Applied to the bottom
    edge of the region's final row.

    fill_mode: 'set' (default) applies the captured fills verbatim;
    'gaps' only paints cells that currently have NO fill — used by the
    repair tool to restore lost template fills without clobbering
    per-sheet custom colours.

    Every cell — including secondary cells of merged ranges — gets its
    captured formatting back. Formats are read BEFORE the unmerge, so they
    describe exactly what the user sees: for templates that keep their
    row separators on each cell of the merged product range (e.g. Veltron,
    Veltra, Petrix) the dashed/dotted segments survive; for templates
    that store nothing on secondary cells (e.g. Torvex) the captured
    'no border' specs keep them clean, which also prevents stale borders
    from resurfacing on the next unmerge/merge cycle.
    """
    # Gift fill colours for in-place detection when item info is unavailable
    # (repair mode: items == []). White is never a gift colour — the captured
    # gift row can carry white fills on merged secondary cells, and counting
    # them would flag every ordinary white row as a gift.
    gift_fills = {GIFT_GREEN}
    if fmt_gift is not None:
        for c in range(1, LAST_COL + 1):
            f = fmt_gift[c]['fill']
            if f is not None and f != WHITE_FILL:
                gift_fills.add(f)

    for offset in range(total_rows):
        r = start_row + offset
        if offset == 0:
            fmt = fmt_first
        elif offset == total_rows - 1 and fmt_last is not None:
            # The template's last row can carry its own look (e.g. Veltron
            # tints the closing blank row) — use it in full.
            fmt = fmt_last
        elif offset == total_rows - 2 and fmt_pre_last is not None:
            # Some templates style the line above the closing row specially
            # (e.g. Veltra: solid rule between the last item rows).
            fmt = fmt_pre_last
        else:
            fmt = fmt_mid
        _item = items[offset] if offset < len(items) else None
        if _item is not None:
            is_free = bool(_item.get('isGift')) or _item.get('unitPrice', 0) == 0
        else:
            # Repair mode: detect gift rows by their existing paint.
            painted = 0
            for c in range(1, LAST_COL + 1):
                try:
                    cc = sheet.Cells(r, c)
                    if (cc.Interior.Pattern not in (None, XL_COLOR_NONE)
                            and int(cc.Interior.Color) in gift_fills):
                        painted += 1
                except Exception:
                    pass
            is_free = painted > 0
        for c in range(1, LAST_COL + 1):
            cell = sheet.Cells(r, c)
            info = fmt[c]
            for edge in ROW_EDGES:
                # Rows below the first never rewrite their TOP edge: that
                # shared line is owned by the row above's BOTTOM (written
                # just before, which also clears stale storage on this side).
                # Re-writing it here would flatten templates that style
                # individual separator lines differently (e.g. Petrix keeps
                # a dotted rule under the first item and dashes below).
                if edge == XL_EDGE_TOP and offset > 0:
                    continue
                spec = info['borders'].get(edge)
                # Closing line above the footer: the template's last data row
                # may carry a different bottom edge than mid rows.
                if (fmt_last is not None and edge == XL_EDGE_BOTTOM
                        and offset == total_rows - 1):
                    spec = fmt_last[c]['borders'].get(XL_EDGE_BOTTOM)
                if spec is None:
                    cell.Borders(edge).LineStyle = XL_COLOR_NONE
                else:
                    ls, weight, color = spec
                    cell.Borders(edge).LineStyle = ls
                    cell.Borders(edge).Weight = weight
                    cell.Borders(edge).Color = color

            if is_free:
                if fmt_gift is not None:
                    # Apply the captured gift format (borders + fill)
                    gift_info = fmt_gift[c]
                    for edge in ROW_EDGES:
                        # TOP is always owned elsewhere: the header line above
                        # row 0 (kept from fmt_first by the pass above) or the
                        # previous row's bottom — never rewrite it here.
                        if edge == XL_EDGE_TOP:
                            continue
                        spec = gift_info['borders'].get(edge)
                        if spec is None:
                            cell.Borders(edge).LineStyle = XL_COLOR_NONE
                        else:
                            ls, weight, color = spec
                            cell.Borders(edge).LineStyle = ls
                            cell.Borders(edge).Weight = weight
                            cell.Borders(edge).Color = color
                    fill = gift_info['fill']
                    try:
                        if fill_mode == 'gaps' and \
                                cell.Interior.Pattern not in (None, XL_COLOR_NONE):
                            pass  # repair mode: keep the row's existing paint
                        elif fill is not None:
                            cell.Interior.Color = fill
                        else:
                            cell.Interior.ColorIndex = XL_COLOR_NONE
                    except Exception:
                        pass  # secondary merged cells may reject fill writes
                else:
                    continue  # legacy: preserve GIFT_GREEN painted by write_items
            else:
                fill = info['fill']
                try:
                    if fill_mode == 'gaps':
                        # Repair mode: only restore fills that were lost (cell
                        # has no paint at all); never clobber existing fills.
                        if fill is not None and \
                                cell.Interior.Pattern in (None, XL_COLOR_NONE):
                            cell.Interior.Color = fill
                    elif fill is None:
                        cell.Interior.ColorIndex = XL_COLOR_NONE
                    else:
                        cell.Interior.Color = fill
                except Exception:
                    pass  # secondary merged cells may reject fill writes;
                    # the merged range shows the primary cell's fill anyway


# ─────────────── 7. Write item data ────────────────────────────────────────

def write_items(sheet, start_row, items, cols, new_item_rows_and_blank, fmt_gift=None):
    """Write product rows (values + formulas) and gift/FOC formatting."""
    # Clear the STT column and data columns across the whole new-row region first
    # to prevent leftover data from leaking into new items or padding rows.
    # Ô CÔNG THỨC (mã KT VLOOKUP...) được GIỮ NGUYÊN — chỉ xoá giá trị tĩnh;
    # công thức sẽ tự tính lại theo tên sản phẩm mới được ghi xuống.
    for r in range(start_row, start_row + new_item_rows_and_blank):
        sheet.Cells(r, 1).Value2 = ""
        for key in ('product', 'ma_kt', 'carton_qty', 'bottle_qty', 'bottle_price', 'carton_price'):
            if cols[key] > 0:
                clear_cell_keep_formula(sheet, r, cols[key])

    for k, item in enumerate(items):
        r = start_row + k

        sheet.Cells(r, 1).Value2 = k + 1

        prod_name = ""
        box_size = 12
        category_val = ""
        spec_val = ""
        product = item.get("product")
        if product:
            prod_name = product.get("name", "")
            if product.get("box_size"):
                box_size = int(product["box_size"])
            category_val = product.get("category", "")
            spec_val = product.get("spec", "")
        else:
            prod_name = item.get("rawProduct", "")

        if cols['product'] > 0:
            sheet.Cells(r, cols['product']).Value2 = str(prod_name)
        # Lưu ý: KHÔNG ghi mã KT tĩnh. Mã KV chỉ dùng cho chức năng lên đơn
        # KiotViet; trong Excel, cột mã KT là công thức VLOOKUP theo tên SP
        # (đã được giữ nguyên ở pre-clear) và tự tính lại sau khi ghi tên.

        unit = item.get("unit", "")
        qty = item.get("qty", 0)
        is_gift = item.get("isGift", False)

        # Phân loại dòng free: 'foc' (chữ đen) / 'extra' (chữ đỏ + ghi 'extra'
        # ở cột SL Thùng). Ưu tiên lựa chọn của user trên bảng đơn (giftKind);
        # thiếu → fallback theo logic cũ focSource ('manual' → extra).
        gift_kind = str(item.get("giftKind") or "").strip().lower()
        if gift_kind not in ("foc", "extra"):
            gift_kind = "extra" if str(item.get("focSource") or "") == "manual" else "foc"

        if unit == V_THUNG or unit == "thung":
            total_bottles = qty * box_size
        else:
            total_bottles = qty

        cartons = math.floor(total_bottles / box_size)
        bottles = total_bottles % box_size

        if cols['carton_qty'] > 0:
            sheet.Cells(r, cols['carton_qty']).Value2 = float(cartons)
            sheet.Cells(r, cols['carton_qty']).HorizontalAlignment = XL_CENTER

        if cols['bottle_qty'] > 0:
            sheet.Cells(r, cols['bottle_qty']).HorizontalAlignment = XL_CENTER
            if bottles == 0 and cartons > 0 and not is_gift:
                letter = col_letter(cols['carton_qty'])
                sheet.Cells(r, cols['bottle_qty']).Value2 = f"={letter}{r}*{box_size}"
            else:
                sheet.Cells(r, cols['bottle_qty']).Value2 = float(total_bottles)

        unit_price = item.get("unitPrice", 0)
        is_free = is_gift or (unit_price == 0)

        if cols['bottle_price'] > 0:
            sheet.Cells(r, cols['bottle_price']).Value2 = float(unit_price)
            sheet.Cells(r, cols['bottle_price']).HorizontalAlignment = XL_RIGHT
            sheet.Cells(r, cols['bottle_price']).NumberFormat = "#,##0"

        if cols['carton_price'] > 0:
            if not is_free and unit_price > 0:
                letter = col_letter(cols['bottle_price'])
                sheet.Cells(r, cols['carton_price']).Value2 = f"={letter}{r}*{box_size}"
                sheet.Cells(r, cols['carton_price']).HorizontalAlignment = XL_RIGHT
                sheet.Cells(r, cols['carton_price']).NumberFormat = "#,##0"
            else:
                # Clear carton_price for free/FOC items
                sheet.Cells(r, cols['carton_price']).Value2 = ""

        # Amount / before-tax / invoice columns keep their FillDown formulas;
        # we only normalise alignment + number format.
        # Ensure amount formula is present even if the source row had it cleared.
        if cols['amount'] > 0 and cols['bottle_qty'] > 0 and cols['bottle_price'] > 0:
            try:
                amt_cell = sheet.Cells(r, cols['amount'])
                if not bool(amt_cell.HasFormula):
                    qty_col = col_letter(cols['bottle_qty'])
                    price_col = col_letter(cols['bottle_price'])
                    amt_cell.Formula = f"={qty_col}{r}*{price_col}{r}"
            except Exception:
                pass

        for key in ('amount', 'before_tax', 'invoice_price'):
            if cols[key] > 0:
                sheet.Cells(r, cols[key]).HorizontalAlignment = XL_RIGHT
                sheet.Cells(r, cols[key]).NumberFormat = "#,##0"

        rng = sheet.Range(sheet.Cells(r, 1), sheet.Cells(r, LAST_COL))

        if is_free:
            print(f"Item {k}: Formatting as Gift/FOC row (unitPrice={unit_price})...")
            if fmt_gift is None:
                # Legacy fallback: paint hard-coded green
                rng.Interior.Color = GIFT_GREEN
            # else: do NOT paint here; apply_template_format handles it

            # Clear non-relevant cells for free items (keep bottle_price and amount formula)
            # Per user request: "Giá thùng cho FOC thì xóa trắng đi"
            # Ô CÔNG THỨC (mã KT, tổng trước thuế, giá hoá đơn) được GIỮ NGUYÊN —
            # quà tặng cũng dùng công thức của mã KT / trước thuế như hàng thường;
            # chỉ xoá giá trị tĩnh (giá thùng...).
            for key in ('carton_price', 'before_tax', 'invoice_price', 'ma_kt'):
                if cols[key] > 0:
                    clear_cell_keep_formula(sheet, r, cols[key])

            # Màu chữ phân loại trên nền xanh: FOC → đen, Extra → đỏ
            rng.Font.Color = FONT_RED if gift_kind == "extra" else FONT_BLACK

            # Dòng Extra (quà ngoài chương trình / hàng tự nhập 0đ): ghi chữ
            # "extra" vào cột SL Thùng để kế toán phân biệt
            if gift_kind == "extra" and cols['carton_qty'] > 0:
                sheet.Cells(r, cols['carton_qty']).Value2 = "extra"
                sheet.Cells(r, cols['carton_qty']).HorizontalAlignment = XL_CENTER
        else:
            rng.Interior.ColorIndex = XL_COLOR_NONE
            # Reset về đen: màu đỏ của lần xuất trước không dính lại khi
            # xuất đè lên sheet cũ
            rng.Font.Color = FONT_BLACK


def capture_base_item_height(sheet, start_row, footer_row):
    """Capture chiều cao dòng CHUẨN của template từ bản clone tươi.

    Sheet mới được clone từ sheet đơn trước đó (right-most numbered sheet):
    các dòng item cũ có thể đang mang chiều cao đã giãn (bởi AutoFit các lần
    xuất trước). Chiều cao chuẩn của template = giá trị NHỎ NHẤT trong vùng
    dữ liệu gốc — dòng tên ngắn / dòng đệm trống luôn giữ đúng chiều cao
    template. Trả về None nếu không đọc được → caller bỏ qua normalization.
    """
    try:
        heights = []
        for r in range(start_row, min(footer_row, start_row + 60)):
            h = sheet.Rows(r).RowHeight
            if h and float(h) > 0:
                heights.append(float(h))
        return min(heights) if heights else None
    except Exception:
        return None


def normalize_item_row_heights(sheet, start_row, item_count, total_rows,
                               merge_patterns, name_col, base_height):
    """Áp dụng quy ước chiều cao CỐ ĐỊNH cho các dòng sản phẩm (expand-only).

    LỖI CŨ: gọi row.AutoFit() khi ô CHƯA merge — Excel đo chiều cao theo bề
    rộng của 1 cột hẹp, trong khi sau khi merge lại (bước 11b) tên SP trải
    qua nhiều cột và thường chỉ chiếm 1 dòng → hầu hết dòng bị giãn CAO THỪA.

    QUY ƯỚC MỚI (theo sheet mẫu của user, vd "27 Trần Văn Hải"):
      1. Mọi dòng trong bảng (item + dòng đệm) = MỘT chiều cao cố định
         (base_height capture từ template lúc mới clone) → bảng đồng nhất.
      2. Chỉ dòng nào tên SP dài quá bề rộng MERGE (ước lượng wrap > 1 dòng)
         mới được giãn thêm vừa đủ số dòng hiển thị.
    """
    if base_height is None or base_height <= 0:
        return

    # Bề rộng hiển thị mà ô tên SP được phép chiếm (sau khi merge lại):
    # tổng ColumnWidth của các cột trong merge span chứa name_col.
    try:
        span = None
        for (cs, ce) in (merge_patterns or []):
            if cs <= name_col <= ce:
                span = (cs, ce)
                break
        cols_range = range(span[0], span[1] + 1) if span else [name_col]
        name_width = sum(sheet.Columns(c).ColumnWidth or 0 for c in cols_range)
    except Exception:
        name_width = 0

    # 1. Reset mọi dòng bảng về chiều cao quy ước (gỡ luôn di chứng cao thừa
    #    do các lần xuất cũ bằng AutoFit).
    for r in range(start_row, start_row + total_rows):
        try:
            sheet.Rows(r).RowHeight = base_height
        except Exception:
            pass

    if item_count <= 0 or name_col <= 0 or name_width <= 0:
        return

    # ~1 ký tự text ≈ 1 đơn vị ColumnWidth (bề rộng chữ '0' font chuẩn);
    # hệ số 0.9 an toàn cho font tỉ lệ (chữ hoa/W rộng hơn) — thà giãn sớm
    # một chút còn hơn cắt mất chữ.
    chars_per_line = max(8.0, name_width * 0.9)

    # 2. Chỉ giãn dòng nào tên SP vượt bề rộng merge.
    for r in range(start_row, start_row + item_count):
        try:
            cell = sheet.Cells(r, name_col)
            text = str(cell.Value2 or "")
            if not text or not cell.WrapText:
                continue
            lines = max(1, math.ceil(len(text) / chars_per_line))
            if lines <= 1:
                continue
            font_size = cell.Font.Size or 11
            line_h = float(font_size) * 1.32
            needed = base_height + (lines - 1) * line_h
            sheet.Rows(r).RowHeight = round(needed, 1)
        except Exception:
            pass  # lỗi 1 dòng không được làm hỏng cả lần xuất
    print(f"Row heights normalized: fixed={base_height}pt on {total_rows} row(s), "
          f"overflow expansion checked on {item_count} item row(s).")


# ─────────────── 8. TLN section ────────────────────────────────────────────

def write_tln_section(sheet, footer_target_row, tln_path):
    """Write the order transcript (TLN) a couple of rows below the footer.

    Quy tắc vị trí TLN: cách lề trái 1 cột (bắt đầu từ cột B) và cách
    dòng tên ("Tổng tiền đơn hàng") 1 dòng trống (footer + 2).
    MỌI dòng TLN đều được ghi nguyên văn dạng TEXT — không để Excel tự ép
    kiểu (SĐT mất số 0 dẫn đầu, dòng dạng ngày tháng bị đổi định dạng).
    """
    if not tln_path or not os.path.isfile(tln_path):
        return

    with open(tln_path, 'r', encoding='utf-8-sig') as f:
        tln_text = f.read()

    tln_lines = [s.strip() for s in tln_text.split('\n')]
    tln_lines = [s for s in tln_lines if s]
    if not tln_lines:
        return

    print(f"Writing TLN section ({len(tln_lines)} lines)...")
    tln_start = footer_target_row + 2
    try:
        # Clear từ cột A để dọn cả tàn dư TLN cũ nằm sát lề trái; vùng clear
        # phải phủ đủ số dòng TLN sắp ghi (không giới hạn cứng 21 dòng).
        clear_end = max(tln_start + 20, tln_start + len(tln_lines) + 5)
        sheet.Range(sheet.Cells(tln_start, 1), sheet.Cells(clear_end, 5)).ClearContents()
    except Exception:
        pass

    tln_row = tln_start
    for line in tln_lines:
        # Cột 2 (B): cách lề trái 1 cột — KHÔNG ghi sát lề trái (cột A)
        cell = sheet.Cells(tln_row, 2)
        try:
            cell.NumberFormat = '@'  # định dạng text: giữ nguyên văn SĐT/ngày tháng
        except Exception:
            pass
        cell.Value2 = line
        tln_row += 1


# ─────────────── Core automation (mirrors PS1 flow) ────────────────────────

def run_automation(file_path, customer_name, order_date, items, tln_path, order_title, no_backup=False):
    """Drive Excel end-to-end. Raises on failure; always cleans up COM."""
    pythoncom.CoInitialize()

    before_pids = get_excel_pids()
    app = None
    wb = None
    our_pid = None
    backup_path = None

    try:
        # 0. Backup the workbook before any mutation.
        if not no_backup:
            backup_path = backup_workbook(file_path)
        else:
            print("Backup skipped (--no-backup).")

        app = _launch_excel()

        # Identify the EXCEL.EXE process we just launched (for guaranteed cleanup).
        for _ in range(5):
            new_pids = get_excel_pids() - before_pids
            if new_pids:
                our_pid = sorted(new_pids)[-1]
                break
            time.sleep(0.2)

        # openpyxl-written workbooks can require an Excel "repair" on open:
        # interactive Excel repairs silently, background automation throws.
        repaired = False
        try:
            wb = app.Workbooks.Open(file_path)
        except pythoncom.com_error:
            print("Normal Open failed - retrying with CorruptLoad=xlRepairFile...")
            wb = app.Workbooks.Open(file_path, CorruptLoad=1)
            repaired = True
        if wb.ReadOnly:
            raise RuntimeError(
                "Workbook \u0111ang \u1edf ch\u1ebf \u0111\u1ed9 Read-Only! "
                "Vui l\u00f2ng \u0111\u00f3ng file trong Excel n\u1ebfu \u0111ang m\u1edf."
            )
        # Hidden window state (workbookView visibility="hidden") makes
        # Worksheet.Copy fail with 0x800AC472 in background instances.
        try:
            wb.Windows(1).Visible = True
        except Exception:
            pass

        # 1. Find + clone the right-most numbered sheet.
        #    STT lấy từ order title để đồng bộ với số PO no.
        source, max_num, _source_idx = find_rightmost_numbered_sheet(wb)
        title_seq = extract_seq_from_title(order_title)
        new_num = title_seq if title_seq is not None else max_num + 1
        new_name = f"{new_num}-{customer_name}"
        if len(new_name) > 31:
            new_name = new_name[:31]

        print(f"Copying sheet '{source.Name}' as '{new_name}'...")
        before_names = set(wb.Sheets.Item(i).Name for i in range(1, wb.Sheets.Count + 1))
        # NOTE: positional args are required. win32com late-binding ignores the
        # After= keyword and would otherwise copy the sheet into a NEW workbook.
        source.Copy(None, source)
        sheet = None
        for i in range(1, wb.Sheets.Count + 1):
            if wb.Sheets.Item(i).Name not in before_names:
                sheet = wb.Sheets.Item(i)
                break
        if sheet is None:
            raise RuntimeError("Kh\u00f4ng th\u1ec3 clone sheet (sheet copy failed).")
        sheet.Name = new_name

        # 2. Customer / date / title.
        fill_customer_and_date(sheet, customer_name, order_date, order_title)

        # 3. Header row.
        header_row = find_header_row(sheet)
        start_row = header_row + 1
        print(f"Header row: {header_row}, Start row: {start_row}")

        # 4. Footer row.
        footer_row = detect_footer_row(sheet, start_row, len(items))

        existing_item_rows = footer_row - start_row

        # 4b. Capture chiều cao dòng chuẩn của template từ bản clone TƯƠI
        #     (trước mọi thao tác chèn/xoá/unmerge) — làm quy ước cố định cho
        #     bước 11a. Dòng tên ngắn / dòng đệm giữ đúng chiều cao template
        #     → min của vùng dữ liệu = chiều cao chuẩn (loại di chứng giãn
        #     cao của các lần xuất cũ).
        base_item_height = capture_base_item_height(sheet, start_row, footer_row)
        print(f"Base item row height (template convention): {base_item_height}")
        new_item_rows = len(items)
        new_item_rows_and_blank = new_item_rows + 2

        print(f"Header: {header_row}, Start: {start_row}, Footer: {footer_row}, "
              f"Existing Rows: {existing_item_rows}, New Rows: {new_item_rows_and_blank}")

        # 5. Column mapping.
        cols = map_columns(sheet, header_row)
        print(f"Column mapping: {cols}")
        if cols['product'] == 0:
            raise RuntimeError("Kh\u00f4ng t\u00ecm th\u1ea5y c\u1ed9t S\u1ea3n ph\u1ea9m trong header.")

        # 6. Save footer before any row operation.
        print(f"Saving footer data from row {footer_row}...")
        footer_data = save_footer_data(sheet, footer_row)

        # 6b. Detect the per-row merged-cell pattern (e.g. product name spanning
        #     several columns) so it can be restored after FillDown.
        merge_patterns = detect_merge_pattern(sheet, start_row)

        # 6c. Capture the template rows' visible per-cell formatting (borders
        #     + fills) BEFORE any unmerge so the original look (dotted row
        #     separators, grey amount columns...) can be restored after the
        #     FillDown/merge cycle instead of degrading generation by generation.
        #     Order: detect gift row FIRST, then capture fmt_mid excluding it.
        try:
            # Step A: Capture fmt_first raw (need dominant fill for comparison)
            fmt_first_raw = capture_row_format(sheet, start_row, ignore_color=None)

            # Step B: Detect gift row and its colour
            product_col = cols['product']
            gift_row_idx, gift_color = find_gift_format_row(
                sheet, start_row, footer_row - 1, fmt_first_raw)

            # Step C: Capture fmt_gift (keep all fills)
            if gift_row_idx is not None:
                fmt_gift = capture_row_format(sheet, gift_row_idx, ignore_color=None)
                print(f"Gift format captured from row {gift_row_idx}, color={gift_color}")
            else:
                fmt_gift = None
                print("No gift format row found; using legacy GIFT_GREEN fallback.")

            # Step D: Re-capture fmt_first with gift colour excluded
            fmt_first = capture_row_format(sheet, start_row, ignore_color=gift_color)

            # Step E: Find mid_row (skip gift-painted rows using detected colour)
            if existing_item_rows >= 2:
                mid_row = start_row + 1
                last_candidate = start_row + existing_item_rows - 1
                while mid_row <= last_candidate and row_is_gift_painted(sheet, mid_row, product_col, gift_color):
                    mid_row += 1
                if mid_row > last_candidate:
                    mid_row = start_row + 1  # all rows gift — fall back
                fmt_mid = capture_row_format(sheet, mid_row, ignore_color=gift_color)
            else:
                fmt_mid = fmt_first

            # Step F: Capture the LAST data row's formatting — its bottom edge
            #         is the table's 'closing line' above the footer, which some
            #         templates style differently from mid-row separators (e.g.
            #         Xvil: solid rule above the footer, dashes between items).
            if footer_row - 1 >= start_row:
                fmt_last = capture_row_format(sheet, footer_row - 1,
                                              ignore_color=gift_color)
            else:
                fmt_last = None
            # Step F2: The SECOND-TO-LAST row — a template may also style the
            #          line above the closing row specially (e.g. Veltra keeps
            #          a solid rule there while mid separators are dotted).
            if footer_row - 2 >= start_row:
                fmt_pre_last = capture_row_format(sheet, footer_row - 2,
                                                  ignore_color=gift_color)
            else:
                fmt_pre_last = None

            # Step G: Fill fallback — the first/last source rows may have lost
            #         their fills to legacy damage; the mid row carries the
            #         template's canonical per-column fills (grey amount cols…).
            #         Only meaningful (non-white) fills are restored: white is
            #         visually identical to 'no fill' and needs no rewrite.
            for _f in (fmt_first, fmt_pre_last, fmt_last):
                if _f is None:
                    continue
                for c in range(1, LAST_COL + 1):
                    mid_fill = fmt_mid[c]['fill']
                    if _f[c]['fill'] is None and mid_fill is not None \
                            and mid_fill != WHITE_FILL:
                        _f[c]['fill'] = mid_fill

            # Step H: Footer formatting (per-cell borders + fill + bold). When
            #         this sheet's footer was bleached by the legacy paint bug
            #         (white label), borrow the formatting from an intact
            #         sibling sheet so the damage stops propagating.
            footer_fmt = capture_footer_format(sheet, footer_row)
            if not footer_label_intact(sheet, footer_row):
                ref_sh, ref_fr = find_intact_footer_sheet(wb, sheet.Name)
                if ref_sh is not None:
                    footer_fmt = capture_footer_format(ref_sh, ref_fr)
                    print("Footer format borrowed from intact sibling sheet.")
                else:
                    print("No intact sibling footer found; keeping source footer format.")
        except Exception as e:
            print(f"Warning: template format capture failed ({e}); skipping style preservation.")
            fmt_first = fmt_mid = fmt_gift = fmt_last = fmt_pre_last = footer_fmt = None

        # 7. Adjust row count so there are always exactly len(items) product rows + 2 blank rows.
        # (Excel rewrites all references natively on Insert/Delete).
        if new_item_rows_and_blank > existing_item_rows:
            rows_to_insert = new_item_rows_and_blank - existing_item_rows
            insert_at = start_row + existing_item_rows
            print(f"Inserting {rows_to_insert} rows before footer at row {insert_at}...")
            for _ in range(rows_to_insert):
                sheet.Rows(insert_at).Insert(XL_SHIFT_DOWN)
        elif new_item_rows_and_blank < existing_item_rows:
            rows_to_delete = existing_item_rows - new_item_rows_and_blank
            delete_at = start_row + new_item_rows_and_blank
            print(f"Deleting {rows_to_delete} excess rows before footer at row {delete_at}...")
            for _ in range(rows_to_delete):
                sheet.Rows(delete_at).Delete()

        total_rows = new_item_rows_and_blank
        footer_target_row = start_row + total_rows
        print(f"Footer at row {footer_target_row} "
              f"(existing: {existing_item_rows}, processing: {total_rows}, items: {new_item_rows}, blank rows: 2)")

        # 7b. Unmerge the data region: merged cells in the source row otherwise
        #     make FillDown silently do nothing.
        if merge_patterns:
            unmerge_data_region(sheet, start_row, footer_target_row - 1)

        # 7c. Ensure Category and Spec VLOOKUP formulas on start_row are wrapped
        #     with IFERROR/IF/OR logic to clean #N/A, 0, and '0' errors BEFORE FillDown.
        for key in ('category', 'spec'):
            if cols[key] > 0:
                try:
                    cell = sheet.Cells(start_row, cols[key])
                    f_str = str(cell.Formula or '')
                    if f_str and 'VLOOKUP' in f_str.upper():
                        wrapped_f = wrap_vlookup_formula(f_str)
                        if wrapped_f != f_str:
                            cell.Formula = wrapped_f
                except Exception as e:
                    print(f"Warning: could not wrap formula for {key}: {e}")

        # 7d. Ensure Amount formula on start_row is intact BEFORE FillDown,
        #     even if the source sheet's start_row was an FOC row or had its formula cleared.
        if cols['amount'] > 0 and cols['bottle_qty'] > 0 and cols['bottle_price'] > 0:
            try:
                cell = sheet.Cells(start_row, cols['amount'])
                f_str = str(cell.Formula or '')
                if not f_str.startswith('='):
                    qty_col = col_letter(cols['bottle_qty'])
                    price_col = col_letter(cols['bottle_price'])
                    cell.Formula = f"={qty_col}{start_row}*{price_col}{start_row}"
                    print(f"Restored amount formula on start_row {start_row}: {cell.Formula}")
            except Exception as e:
                print(f"Warning: could not restore amount formula on start_row: {e}")

        # 7d-bis. TỰ CHỮA LÀNH công thức bị mất trên start_row (di chứng trang
        #     quà tặng: gift-clear cũ đã xoá trắng before_tax / invoice_price /
        #     ma_kt rồi FillDown nhân bản ô trống xuống cả vùng). Mượn công thức
        #     từ sheet anh em còn nguyên — cùng layout nên tham chiếu khớp.
        for key in ('category', 'spec', 'before_tax', 'invoice_price', 'ma_kt'):
            if cols[key] > 0:
                try:
                    cell = sheet.Cells(start_row, cols[key])
                    f_str = str(cell.Formula or '')
                    if f_str.startswith('='):
                        continue
                    donor_f = find_formula_donor(wb, sheet.Name, cols[key], header_row)
                    if donor_f:
                        if key in ('category', 'spec', 'ma_kt'):
                            donor_f = wrap_vlookup_formula(donor_f)
                        cell.Formula = donor_f
                        print(f"Healed {key} formula on start_row from sibling: {donor_f[:80]}")
                except Exception as e:
                    print(f"Warning: could not heal {key} formula: {e}")

        # 8. FillDown from the first item row: copies formats AND formulas with
        #    adjusted relative references, and propagates helper-column values.
        print(f"Filling down formats from row {start_row} for {total_rows} rows...")
        sheet.Activate()
        fill_range = sheet.Range(
            sheet.Cells(start_row, 1),
            sheet.Cells(start_row + total_rows - 1, LAST_COL),
        )
        fill_range.FillDown()

        # 8b. Ensure wrapped formulas are present across all data rows
        for r in range(start_row, start_row + total_rows):
            for key in ('category', 'spec'):
                if cols[key] > 0:
                    try:
                        cell = sheet.Cells(r, cols[key])
                        f_str = str(cell.Formula or '')
                        if f_str and 'VLOOKUP' in f_str.upper():
                            wrapped_f = wrap_vlookup_formula(f_str)
                            if wrapped_f != f_str:
                                cell.Formula = wrapped_f
                    except Exception:
                        pass

        # 9. Clear data rows (constants only, keep formulas) + blank rows fully.
        print("Clearing data rows (values only, keep formulas)...")
        for k in range(new_item_rows):
            r = start_row + k
            try:
                # Restrict clearing to the table columns to preserve data outside the table
                rng = sheet.Range(sheet.Cells(r, 1), sheet.Cells(r, LAST_COL))
                rng.SpecialCells(XL_CONSTANTS).ClearContents()
            except Exception:
                pass

        print("Clearing blank rows (all content)...")
        for k in range(new_item_rows, total_rows):
            r = start_row + k
            rng = sheet.Range(sheet.Cells(r, 1), sheet.Cells(r, LAST_COL))
            rng.ClearContents()
            rng.Interior.ColorIndex = XL_COLOR_NONE

        # 10. Restore footer at its target position (excluding FOC / gift rows from SUM).
        normal_row_intervals = []
        current_interval_start = None
        current_interval_end = None
        for k, item in enumerate(items):
            r = start_row + k
            is_gift = item.get("isGift", False)
            unit_price = item.get("unitPrice", 0)
            is_free = is_gift or (unit_price == 0)
            if not is_free:
                if current_interval_start is None:
                    current_interval_start = r
                    current_interval_end = r
                else:
                    current_interval_end = r
            else:
                if current_interval_start is not None:
                    normal_row_intervals.append((current_interval_start, current_interval_end))
                    current_interval_start = None
                    current_interval_end = None
        if current_interval_start is not None:
            normal_row_intervals.append((current_interval_start, current_interval_end))

        print(f"Restoring footer at row {footer_target_row} (normal row intervals: {normal_row_intervals})...")
        restore_footer_data(sheet, footer_target_row, footer_data, start_row, normal_row_intervals)

        # 11. Write item data.
        write_items(sheet, start_row, items, cols, new_item_rows_and_blank, fmt_gift)

        # 11a. Chuẩn hoá chiều cao dòng bảng SP về QUY ƯỚC CỐ ĐỊNH của template
        #      (chỉ giãn dòng nào tên SP dài vượt bề rộng merge) — thay cho
        #      AutoFit cũ vốn đo theo cột hẹp chưa merge làm dòng cao thừa.
        normalize_item_row_heights(sheet, start_row, new_item_rows,
                                   total_rows, merge_patterns, cols['product'],
                                   base_item_height)

        # 11b. Re-apply the per-row merged-cell pattern.
        if merge_patterns:
            apply_merge_pattern(sheet, start_row, total_rows, merge_patterns)

        # 11c. Restore the template's original per-cell formatting on the data
        #      region (dotted separators, grey fills) after the merge cycle.
        if fmt_first is not None:
            print("Restoring template row formatting on data region...")
            apply_template_format(sheet, start_row, total_rows, fmt_first,
                                  fmt_mid, merge_patterns, items, fmt_gift,
                                  fmt_last,
                                  fmt_pre_last=fmt_pre_last)

        # 11d. Restore the footer's per-cell formatting (borders / fill / bold).
        #      Values + formulas were rewritten in step 10; the formatting may
        #      have been borrowed from an intact sibling sheet to heal legacy
        #      bleaching (white footer label).
        if footer_fmt is not None:
            print("Restoring footer formatting...")
            apply_footer_format(sheet, footer_target_row, footer_fmt)

        # 12. Write TLN.
        write_tln_section(sheet, footer_target_row, tln_path)

        # 13. Save. (Repair-loaded workbooks must use SaveAs; Save() fails.)
        if repaired:
            wb.SaveAs(file_path)
        else:
            wb.Save()
        print("Workbook saved successfully.")
        print("Excel Automation completed.")

    except Exception:
        # Restore the original workbook from backup on any failure.
        restore_from_backup(backup_path, file_path)
        raise

    finally:
        try:
            if wb is not None:
                wb.Close(SaveChanges=False)
        except Exception:
            pass
        try:
            if app is not None:
                app.Quit()
        except Exception:
            pass
        # Guarantee our Excel process is gone even if Quit() failed.
        if our_pid is not None and our_pid in get_excel_pids():
            try:
                subprocess.run(
                    ['taskkill', '/PID', str(our_pid), '/F'],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
            except Exception:
                pass
        pythoncom.CoUninitialize()

        # Tự động khử trùng lặp ảnh media (giữ file luôn gọn nhẹ ~2MB)
        deduplicate_media_images(file_path, verbose=True)


# ─────────────── Main entry point ──────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Excel order automation (win32com)")
    parser.add_argument('--file', required=True, help="Path to Excel workbook")
    parser.add_argument('--customer', required=True, help="Customer name")
    parser.add_argument('--date', required=True, help="Order date string")
    parser.add_argument('--items', required=True, help="Path to items JSON file")
    parser.add_argument('--tln', default=None, help="Path to TLN text file")
    parser.add_argument('--title', default=None, help="Order title")
    parser.add_argument('--meta', default=None,
                        help="Path to meta JSON {customer,title,date} — text tiếng Việt "
                             "đi qua file tạm UTF-8 thay vì argv để khỏi lệch encoding; "
                             "khi có thì GHI ĐÈ lên --customer/--date/--title trên argv")
    parser.add_argument('--no-backup', action='store_true', default=False,
                        help="Skip creating a timestamped backup before mutation")
    args = parser.parse_args()

    if args.meta:
        if not os.path.isfile(args.meta):
            print(f"ERROR: Meta JSON file not found at {args.meta}", file=sys.stderr)
            sys.exit(1)
        with open(args.meta, 'r', encoding='utf-8-sig') as f:
            meta = json.load(f)
        if meta.get('customer'):
            args.customer = meta['customer']
        if meta.get('date'):
            args.date = meta['date']
        if meta.get('title'):
            args.title = meta['title']

    print("Starting Excel Automation (win32com)...")
    print(f"File: {args.file}")
    print(f"Customer: {args.customer}")
    print(f"Date: {args.date}")
    print(f"Order Title: {args.title or '(none)'}")

    if not os.path.isfile(args.items):
        print(f"ERROR: Items JSON file not found at {args.items}", file=sys.stderr)
        sys.exit(1)

    with open(args.items, 'r', encoding='utf-8-sig') as f:
        items = json.load(f)
    print(f"Loaded {len(items)} items from JSON.")

    if not os.path.isfile(args.file):
        print(f"ERROR: Workbook not found at {args.file}", file=sys.stderr)
        sys.exit(1)

    try:
        run_automation(args.file, args.customer, args.date, items, args.tln, args.title,
                       no_backup=args.no_backup)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == '__main__':
    main()

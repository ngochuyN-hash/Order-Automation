# -*- coding: utf-8 -*-
"""
dedup_po_media.py — Khử trùng lặp ảnh (Media Deduplication) cho file Excel (.xlsx)

Nguyên nhân:
Khi nhân bản sheet (qua win32com hoặc openpyxl), mỗi sheet tạo ra một bản copy vật lý
mới của logo header trong thư mục xl/media/ (vd: image1.png ... image80.png), khiến file
phình to từ ~2MB lên 30-40MB dù dữ liệu tính toán chỉ chiếm ~2MB.

Giải pháp:
1. Quét toàn bộ file media trong gói ZIP (xl/media/).
2. Tính hash SHA-256 để gom các file ảnh có nội dung giống hệt nhau.
3. Chọn 1 file ảnh chuẩn (canonical) cho mỗi nhóm ảnh trùng lặp.
4. Cập nhật lại toàn bộ file quan hệ (.rels) để trỏ chung về file ảnh chuẩn.
5. Loại bỏ các file ảnh thừa, giảm 90-95% dung lượng file mà không làm mất/lỗi bất kỳ sheet hay logo nào.

Sử dụng:
    python dedup_po_media.py --file <path_to_file.xlsx>
    python dedup_po_media.py --dir <path_to_directory> [--recursive]
"""

import os
import sys
import argparse
import zipfile
import hashlib
from pathlib import Path

# Force UTF-8 encoding for Windows console
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')


def deduplicate_media_images(xlsx_path, dry_run=False, verbose=True):
    """
    Khử trùng lặp ảnh trong file .xlsx.
    Trả về dict thống kê kết quả:
    {
        'success': bool,
        'orig_size': int,
        'new_size': int,
        'total_media': int,
        'unique_media': int,
        'removed_media': int,
        'saved_bytes': int
    }
    """
    p = Path(xlsx_path)
    if not p.exists() or not p.is_file():
        if verbose:
            print(f"[DedupMedia] Lỗi: Không tìm thấy file {p}")
        return {'success': False, 'error': 'File not found'}

    if not p.suffix.lower() == '.xlsx':
        if verbose:
            print(f"[DedupMedia] Bỏ qua file không phải .xlsx: {p.name}")
        return {'success': False, 'error': 'Not an xlsx file'}

    orig_size = p.stat().st_size

    try:
        with zipfile.ZipFile(p, 'r') as zin:
            names = zin.namelist()
            media_files = [n for n in names if n.startswith('xl/media/')]

            if len(media_files) <= 1:
                if verbose:
                    print(f"[DedupMedia] {p.name}: Chỉ có {len(media_files)} media, không cần tối ưu.")
                return {
                    'success': True,
                    'orig_size': orig_size,
                    'new_size': orig_size,
                    'total_media': len(media_files),
                    'unique_media': len(media_files),
                    'removed_media': 0,
                    'saved_bytes': 0
                }

            # Nhóm các file ảnh theo hash SHA-256
            by_hash = {}
            for mf in media_files:
                data = zin.read(mf)
                h = hashlib.sha256(data).hexdigest()
                by_hash.setdefault(h, []).append(mf)

            dup_map = {}  # { 'image59.png': 'image1.png' }
            canonical_files = set()

            for h, files in by_hash.items():
                # Ưu tiên file tên ngắn / số nhỏ hơn làm canonical
                files_sorted = sorted(files, key=lambda x: (len(Path(x).stem), x))
                canon = files_sorted[0]
                canonical_files.add(canon)
                canon_name = Path(canon).name

                for f in files_sorted[1:]:
                    dup_name = Path(f).name
                    dup_map[dup_name] = canon_name

            removed_count = len(media_files) - len(canonical_files)

            if not dup_map:
                if verbose:
                    print(f"[DedupMedia] {p.name}: Không có ảnh trùng lặp ({len(media_files)} ảnh duy nhất).")
                return {
                    'success': True,
                    'orig_size': orig_size,
                    'new_size': orig_size,
                    'total_media': len(media_files),
                    'unique_media': len(canonical_files),
                    'removed_media': 0,
                    'saved_bytes': 0
                }

            if dry_run:
                if verbose:
                    print(f"[DedupMedia] [DRY RUN] {p.name}: {len(media_files)} media -> {len(canonical_files)} duy nhất. Sẽ loại bỏ {removed_count} ảnh trùng.")
                return {
                    'success': True,
                    'orig_size': orig_size,
                    'new_size': orig_size,
                    'total_media': len(media_files),
                    'unique_media': len(canonical_files),
                    'removed_media': removed_count,
                    'saved_bytes': 0
                }

            # Cập nhật các file quan hệ (.rels)
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

            # Đóng gói file zip tạm an toàn
            temp_out = p.parent / f"{p.stem}_tmp_dedup_{os.getpid()}.xlsx"
            with zipfile.ZipFile(temp_out, 'w', compression=zipfile.ZIP_DEFLATED) as zout:
                for item in zin.infolist():
                    # Bỏ qua các file ảnh trùng lặp
                    if item.filename.startswith('xl/media/') and item.filename not in canonical_files:
                        continue
                    if item.filename in new_contents:
                        zout.writestr(item.filename, new_contents[item.filename])
                    else:
                        zout.writestr(item, zin.read(item.filename))

        # Kiểm tra tính toàn vẹn zip trước khi thay thế
        with zipfile.ZipFile(temp_out, 'r') as zcheck:
            if zcheck.testzip() is not None:
                if temp_out.exists():
                    temp_out.unlink()
                raise RuntimeError(f"Lỗi kiểm tra tính toàn vẹn gói ZIP cho {p.name}")

        new_size = temp_out.stat().st_size
        os.replace(temp_out, p)

        saved_bytes = orig_size - new_size
        pct = (saved_bytes / orig_size * 100) if orig_size > 0 else 0

        if verbose:
            print(f"[DedupMedia] {p.name}: Khử trùng lặp thành công! "
                  f"{orig_size/1024/1024:.2f} MB -> {new_size/1024/1024:.2f} MB "
                  f"(Giảm {saved_bytes/1024/1024:.2f} MB ~ {pct:.1f}%, bỏ {removed_count} ảnh thừa)")

        return {
            'success': True,
            'orig_size': orig_size,
            'new_size': new_size,
            'total_media': len(media_files),
            'unique_media': len(canonical_files),
            'removed_media': removed_count,
            'saved_bytes': saved_bytes
        }

    except Exception as e:
        if verbose:
            print(f"[DedupMedia] Lỗi khi xử lý {p.name}: {e}")
        return {'success': False, 'error': str(e)}


def main():
    parser = argparse.ArgumentParser(description="Khử trùng lặp ảnh (Media Deduplication) cho file Excel PO")
    parser.add_argument('--file', help="Đường dẫn đến file .xlsx cần tối ưu")
    parser.add_argument('--dir', help="Đường dẫn đến thư mục chứa các file .xlsx cần tối ưu")
    parser.add_argument('--recursive', action='store_true', help="Quét đệ quy thư mục con khi dùng --dir")
    parser.add_argument('--dry-run', action='store_true', help="Chỉ kiểm tra và báo cáo số lượng ảnh trùng, không ghi đè file")
    args = parser.parse_args()

    if not args.file and not args.dir:
        parser.print_help()
        sys.exit(1)

    if args.file:
        deduplicate_media_images(args.file, dry_run=args.dry_run, verbose=True)

    if args.dir:
        d = Path(args.dir)
        if not d.exists() or not d.is_dir():
            print(f"Lỗi: Thư mục không tồn tại: {d}")
            sys.exit(1)

        pattern = "**/*.xlsx" if args.recursive else "*.xlsx"
        files = list(d.glob(pattern))
        print(f"Tìm thấy {len(files)} file .xlsx trong {d}")

        total_saved = 0
        success_count = 0
        for f in files:
            res = deduplicate_media_images(f, dry_run=args.dry_run, verbose=True)
            if res.get('success'):
                success_count += 1
                total_saved += res.get('saved_bytes', 0)

        print(f"\n Hoàn tất: {success_count}/{len(files)} file thành công. Tổng dung lượng tiết kiệm: {total_saved/1024/1024:.2f} MB")


if __name__ == '__main__':
    main()

// scripts/package-source.js
// Xuất MÃ NGUỒN BÀN GIAO — bản sạch để giao cho người nhận (dev/agent khác).
//
// Nguyên tắc: danh sách file = ĐÚNG những gì git đang track (`git ls-files`).
// .gitignore đã chặn sẵn node_modules/dist/build output/dữ liệu kinh doanh/.env
// nên danh sách không bao giờ drift (bản cũ quản tay từng file, dễ sót khi
// repo thêm file mới). Chạy: `npm run package:source` hoặc `Xuat Ma Nguon.bat`.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf-8'));
const VERSION = PKG.version || '0.0.0';

const OUT_DIR = path.join(ROOT_DIR, 'Mã nguồn bàn giao');
const STAGING_DIR = path.join(ROOT_DIR, '_clean_source_staging');

// Phòng thủ kép: dù git ls-files không bao giờ trả các path này (đã bị
// .gitignore), vẫn chặn một lần nữa trước khi copy — file nhạy cảm/khỏi cần
// không bao giờ được phép lọt vào bản bàn giao.
const DENY_PATTERNS = [
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])\.env$/,            // .env thật — chỉ .env.example được phép
  /(^|[\\/])dist([\\/]|$)/,
  /(^|[\\/])Ứng dụng Lên Đơn Hàng([\\/]|$)/,
  /(^|[\\/])I\.ĐƠN HÀNG([\\/]|$)/,
  /(^|[\\/])Bảng giá([\\/]|$)/,
  /_backup_\d+/,
];

function git(args) {
  return execFileSync('git', args, { cwd: ROOT_DIR, encoding: 'utf8' });
}

function listTrackedFiles() {
  const raw = git(['ls-files', '-z']);
  return raw.split('\0').filter(Boolean);
}

function main() {
  // Phải chạy trong git repo — danh sách file phụ thuộc git
  try {
    git(['rev-parse', '--is-inside-work-tree']);
  } catch (e) {
    console.error('[LỖI] Đây không phải git working tree — script cần `git ls-files` làm danh sách file chuẩn.');
    process.exit(1);
  }

  // Cảnh báo nếu working tree còn thay đổi chưa commit (bản xuất lấy NỘI DUNG
  // working tree hiện tại — muốn bàn giao đúng bản đã chốt thì commit trước)
  let dirty = '';
  try {
    dirty = git(['status', '--porcelain']).trim();
  } catch (e) { /* bỏ qua */ }
  if (dirty) {
    const n = dirty.split('\n').filter(Boolean).length;
    console.warn(`⚠️  Còn ${n} file CHƯA COMMIT — zip sẽ chứa nội dung working tree, không phải bản đã chốt trong git.`);
  }

  const shortSha = git(['rev-parse', '--short', 'HEAD']).trim();
  const now = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const zipName = `Order-Automation_Ma-nguon_v${VERSION}_${dateStr}_${shortSha}.zip`;

  const allFiles = listTrackedFiles();
  const skipped = [];
  const files = allFiles.filter((f) => {
    const norm = f.replace(/\\/g, '/');
    if (DENY_PATTERNS.some((re) => re.test(norm))) { skipped.push(f); return false; }
    return true;
  });

  console.log(`📦 Xuất mã nguồn bàn giao v${VERSION} (commit ${shortSha}, ${dateStr})...`);
  console.log(`   Git đang track ${allFiles.length} file — xuất ${files.length} file${skipped.length ? `, chặn ${skipped.length} file nhạy cảm: ${skipped.join(', ')}` : ''}.`);

  // ── 1. Copy vào staging (tên ASCII để tránh vấn đề encoding khi nén) ──
  if (fs.existsSync(STAGING_DIR)) fs.rmSync(STAGING_DIR, { recursive: true, force: true });
  fs.mkdirSync(STAGING_DIR, { recursive: true });

  let copied = 0;
  for (const rel of files) {
    const src = path.join(ROOT_DIR, rel);
    const dest = path.join(STAGING_DIR, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    copied++;
  }
  if (copied !== files.length) {
    console.error(`[LỖI] Copy thiếu file: ${copied}/${files.length} — hủy để không bàn giao bản thiếu.`);
    fs.rmSync(STAGING_DIR, { recursive: true, force: true });
    process.exit(1);
  }

  // ── 2. MANIFEST.txt cho người nhận ──
  const manifest = [
    'ORDER AUTOMATION — MÃ NGUỒN BÀN GIAO',
    '=====================================',
    `Phiên bản : v${VERSION}`,
    `Commit    : ${shortSha} (${git(['log', '-1', '--format=%cI']).trim()})`,
    `Ngày xuất : ${dateStr}`,
    `Số file   : ${copied}`,
    '',
    'Cách chạy lại trên máy mới (Windows):',
    '  1. Cài Node.js + Python 3 (pywin32) + Microsoft Excel',
    '  2. npm install',
    '  3. Copy .env.example thành .env (điền AI_API_KEY nếu dùng AI parser)',
    '  4. npm test        (kiểm tra sức khỏe mã nguồn)',
    '  5. npm start       (hoặc Chay Len Don Hang.bat)',
    '',
    'KHÔNG nằm trong bản xuất này (bàn giao riêng nếu cần):',
    '  - I.ĐƠN HÀNG/  : template + file Excel đơn hàng theo brand (app CẦN template để xuất Excel)',
    '  - Bảng giá/    : bảng giá NPP',
    '  - .env         : cấu hình thật (khởi tạo từ .env.example)',
    '  - node_modules : tự tạo bằng npm install',
    '  - Bản build EXE: đóng gói riêng bằng Build EXE.bat',
    '',
    'Tài liệu bắt đầu: README.md (bản đồ dự án) + docs/MCP.md (MCP cho agent ngoài).',
    '',
    'Danh sách file:',
    ...files.map((f) => '  ' + f.replace(/\\/g, '/')),
  ].join('\r\n');
  fs.writeFileSync(path.join(STAGING_DIR, 'MANIFEST.txt'), manifest, 'utf8');

  // ── 3. Nén zip vào folder bàn giao (ưu tiên tar.exe của Windows — an toàn
  //      Unicode; fallback PowerShell Compress-Archive) ──
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const zipPath = path.join(OUT_DIR, zipName);
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  try {
    // PowerShell nén deflate (nhỏ hơn tar ~4x) — execFileSync truyền args qua
    // CreateProcessW nên path tiếng Việt ("Mã nguồn bàn giao") không vỡ font.
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Compress-Archive -Path '${STAGING_DIR}\\*' -DestinationPath '${zipPath}' -Force`], { stdio: 'inherit' });
  } catch (e) {
    // Fallback: tar.exe của Windows (bsdtar) — phải dùng đường dẫn TƯƠNG ĐỐI
    // (bsdtar parse "C:\..." thành host:port remote nếu truyền path tuyệt đối)
    console.log('   PowerShell không dùng được, fallback tar.exe...');
    const zipRel = path.relative(STAGING_DIR, zipPath);
    execFileSync('tar', ['-a', '-cf', zipRel, '-C', STAGING_DIR, '.'], { stdio: 'inherit', cwd: STAGING_DIR });
  }

  fs.rmSync(STAGING_DIR, { recursive: true, force: true });

  const zipStat = fs.statSync(zipPath);
  const size = zipStat.size > 1024 * 1024
    ? (zipStat.size / (1024 * 1024)).toFixed(2) + ' MB'
    : (zipStat.size / 1024).toFixed(1) + ' KB';

  console.log('');
  console.log('🎉 XUẤT MÃ NGUỒN THÀNH CÔNG!');
  console.log(`📁 ${zipPath}`);
  console.log(`📊 ${copied} file + MANIFEST.txt — ${size}`);
  console.log('ℹ️  Nhớ: template Excel (I.ĐƠN HÀNG/), Bảng giá/ và .env bàn giao RIÊNG nếu người nhận cần chạy thật.');
}

main();

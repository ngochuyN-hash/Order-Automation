// validate-build.js - Pre/post build validation
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REQUIRED_FILES = [
  'main.js',
  'index.html',
  // dist/index.html = built renderer bundle; production main.js loads dist/index.html
  'dist/index.html',
  'ui-renderer.js',
  'style.css',
  'db.js',
  // Dữ liệu danh mục + giá (db.js import trực tiếp; Vite nhúng vào bundle dist).
  // Local-only, KHÔNG nằm trong git — mất file này thì build renderer fail.
  'default-db.json',
  'default-aliases.json',
  'default-memory.json',
  'ai-classifier.json',
  'internal-codes.json',
  'local-config.json',
  'store.js',
  'db-store.js',
  'preload.js',
  'parser.js',
  // sync.js (legacy ActiveX rename script) moved to .archive/legacy-scripts/ — dead file,
  // not packaged (absent from electron-builder.yml) and imported by nothing.
  'ai-service.js',
  'browser-agent-ipc.js',
  'browser-agent.js',
  'mcp-client.js',
  'ai-providers.mjs',
  'script-registry.js',
  'mcp-server.js',
  'mcp-stdio-proxy.js',
  'excel_automation.py',
  'excel_create_month.py'
];
// NOTE: matching.worker.js (root) is intentionally NOT required:
// the renderer runs the Vite bundle in dist/ instead. app.js (legacy monolith)
// has been moved out of root to test/fixtures/app-legacy.js (test-only).

// ─── Secret Scan ─────────────────────────────────────────────────────────────
const SECRET_PATTERNS = [
  { regex: /sk-[a-zA-Z0-9]{20,}/, label: 'API key (sk-...)' },
  { regex: /api[_-]?key\s*[:=]\s*['"][^'"]{8,}['"]/i, label: 'Hardcoded API key assignment' },
  { regex: /password\s*[:=]\s*['"][^'"]{4,}['"]/i, label: 'Hardcoded password' },
  { regex: /secret\s*[:=]\s*['"][^'"]{8,}['"]/i, label: 'Hardcoded secret' },
  { regex: /ghp_[A-Za-z0-9]{10,}/, label: 'GitHub token (ghp-...)' },
  { regex: /\bxox[bap]-/i, label: 'Slack token (xox...)' },
  { regex: /AKIA[0-9A-Z]{16}/, label: 'AWS access key (AKIA...)' },
];

const SCAN_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.md', '.json', '.py', '.yml', '.yaml', '.bat', '.ps1']);
const SCAN_DIRS = ['.', 'src', 'scripts', '.agents'];
// Bỏ qua: dependency/output/cache + test + archive + notes ngoài luồng. Lưu ý:
// bỏ qua test/, .archive/, Tracking/ có nghĩa test-fixture, file lưu trữ hay
// ghi chú chứa key mẫu VẪN lọt lưới — trước khi build hãy grep tay `sk-`,
// `ghp_`, `xox` trong ba thư mục này.
const SCAN_SKIP = new Set(['node_modules', '.git', 'dist', 'test', '.archive', 'Tracking', 'agentic-awesome-skills-main', '.qoder', 'Ứng dụng Lên Đơn Hàng', 'Mã nguồn bàn giao']);
// File chứa token mẫu trong tài liệu (không phải secret thật) — đối chiếu theo
// basename để không phụ thuộc đường dẫn tuyệt đối của máy build.
const SCAN_ALLOWLIST = new Set(['mcp-server.test.js', 'MCP.md']);

function scanOneFile(filePath, displayName) {
  const ext = path.extname(filePath).toLowerCase();
  if (!SCAN_EXTENSIONS.has(ext)) return false;
  if (SCAN_ALLOWLIST.has(path.basename(filePath))) return false;
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (_) {
    return false; // file nhị phân hoặc không đọc được — bỏ qua
  }
  const lines = content.split('\n');
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    for (const { regex, label } of SECRET_PATTERNS) {
      if (regex.test(lines[i])) {
        console.error(`  ❌ ${label} in ${displayName}:${i + 1}`);
        found = true;
      }
    }
  }
  return found;
}

function walkDir(absDir, displayDir, onFile) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch (_) {
    return; // thư mục không tồn tại — bỏ qua
  }
  for (const entry of entries) {
    if (SCAN_SKIP.has(entry.name)) continue;
    const abs = path.join(absDir, entry.name);
    const display = path.join(displayDir, entry.name);
    if (entry.isDirectory()) {
      walkDir(abs, display, onFile);
    } else if (entry.isFile()) {
      onFile(abs, display);
    }
  }
}

function scanForSecrets() {
  console.log('\n🔒 Scanning for plaintext secrets...');
  let found = false;

  for (const dir of SCAN_DIRS) {
    const absDir = path.join(__dirname, dir);
    if (!fs.existsSync(absDir)) continue;
    walkDir(absDir, dir, (abs, display) => {
      if (scanOneFile(abs, display)) found = true;
    });
  }

  if (found) {
    console.error('  ❌ SECRET SCAN FAILED! Remove plaintext secrets before building.');
    return false;
  }
  console.log('  ✓ No plaintext secrets detected');
  return true;
}

// ─── Test Runner ─────────────────────────────────────────────────────────────

// Must match the suites declared in package.json "test" script
const TEST_SUITES = [
  'parser.test.js',
  'app.test.js',
  'excel_automation.test.js',
  'excel_smoke.test.js',
  'note-sanitizer.test.mjs',
  'product-edit.test.mjs',
  'alias-audit.test.js',
  'matching-golden.test.mjs',
  'rescan.test.mjs',
  'json-extractor.test.mjs',
  'extraction-repair.test.mjs',
  'order-schema.test.mjs',
  'db-store.test.mjs',
  'tln-coverage.test.mjs',
  'browser-agent.test.js',
  'browser-agent-ipc.test.js',
  'mkt-gifts.test.mjs',
  'price-disambiguation.test.mjs',
  'correction-learning.test.mjs',
  'mcp-server.test.js',
  'price-seed-migration.test.mjs',
  'pending-orders.test.mjs',
  'promo-text-rules.test.mjs',
];

function runTests() {
  console.log('\n🧪 Running behavioral tests...');
  const testFiles = TEST_SUITES.map(f => path.join(__dirname, 'test', f));
  const missing = testFiles.filter(f => !fs.existsSync(f));
  if (missing.length === testFiles.length) {
    console.log('  ⚠ No test files found, skipping tests.');
    return true;
  }
  for (const f of missing) {
    console.error(`  ❌ MISSING test suite: ${path.relative(__dirname, f)}`);
  }
  if (missing.length > 0) return false;
  try {
    const args = testFiles.map(f => `"${f}"`).join(' ');
    execSync(`node --test ${args}`, { stdio: 'inherit', cwd: __dirname });
    console.log('  ✓ All tests passed');
    return true;
  } catch (e) {
    console.error('  ❌ Tests FAILED!');
    return false;
  }
}

function validateSource() {
  console.log('\n🔍 Validating source files...');
  let allGood = true;

  for (const file of REQUIRED_FILES) {
    const fullPath = path.join(__dirname, file);
    if (!fs.existsSync(fullPath)) {
      console.error(`  ❌ MISSING: ${file}`);
      allGood = false;
    } else {
      const stat = fs.statSync(fullPath);
      console.log(`  ✓ ${file} (${(stat.size / 1024).toFixed(1)} KB)`);
    }
  }

  // Check electron-builder.yml has asarUnpack for PY
  const builderYml = fs.readFileSync(path.join(__dirname, 'electron-builder.yml'), 'utf-8');
  if (!builderYml.includes('asarUnpack')) {
    console.error('  ❌ electron-builder.yml missing asarUnpack directive!');
    allGood = false;
  } else {
    console.log('  ✓ asarUnpack configured');
  }

  // Check main.js uses getUnpackedPath
  const mainJs = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf-8');
  if (!mainJs.includes('getUnpackedPath')) {
    console.error('  ❌ main.js missing getUnpackedPath() helper!');
    allGood = false;
  } else {
    console.log('  ✓ main.js uses getUnpackedPath');
  }

  if (!allGood) {
    console.error('\n❌ BUILD VALIDATION FAILED! Fix issues above before building.');
    process.exit(1);
  }

  // Secret scan gate
  if (!scanForSecrets()) {
    process.exit(1);
  }

  // Behavioral test gate
  if (!runTests()) {
    process.exit(1);
  }

  console.log('\n✅ All source files validated. Ready to build!\n');
}

function validateOutput() {
  console.log('\n🔍 Validating build output...');
  const outputDir = path.join(__dirname, 'Ứng dụng Lên Đơn Hàng', 'win-unpacked', 'resources');

  if (!fs.existsSync(outputDir)) {
    console.error(`  ❌ Output directory not found: ${outputDir}`);
    process.exit(1);
  }

  // Check asar exists
  const asarPath = path.join(outputDir, 'app.asar');
  if (!fs.existsSync(asarPath)) {
    console.error('  ❌ app.asar not found in output!');
    process.exit(1);
  }
  console.log('  ✓ app.asar exists');

  // Check unpacked PY files
  const unpackedDir = path.join(outputDir, 'app.asar.unpacked');
  const pyFiles = ['excel_automation.py', 'excel_create_month.py'];
  let allGood = true;

  for (const py of pyFiles) {
    const pyPath = path.join(unpackedDir, py);
    if (!fs.existsSync(pyPath)) {
      console.error(`  ❌ MISSING unpacked: ${py}`);
      allGood = false;
    } else {
      console.log(`  ✓ ${py} unpacked correctly`);
    }
  }

  // Check installer exists (nếu còn nhiều bản trong thư mục → in bản mới nhất theo tên)
  const installerDir = path.join(__dirname, 'Ứng dụng Lên Đơn Hàng');
  const installers = fs.readdirSync(installerDir).filter(f => f.endsWith('.exe') && f.includes('Setup')).sort();
  if (installers.length > 0) {
    console.log(`  ✓ Installer: ${installers[installers.length - 1]}`);
  } else {
    console.error('  ❌ No Setup .exe found!');
    allGood = false;
  }

  if (!allGood) {
    console.error('\n❌ BUILD OUTPUT VALIDATION FAILED!');
    process.exit(1);
  }
  console.log('\n✅ Build output validated! EXE is ready to use.\n');
}

// Run based on argument
const mode = process.argv[2];
if (mode === 'pre') validateSource();
else if (mode === 'post') validateOutput();
else {
  validateSource();
  console.log('---');
  validateOutput();
}

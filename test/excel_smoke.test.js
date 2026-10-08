/**
 * Smoke test: excel_automation.py end-to-end via COM (bounded, sandbox-only).
 *
 * Runs the documented sandbox route against a temporary workbook copy:
 *   python excel_automation.py --file <scratch>.xlsx --customer Test \
 *       --date 2026-01-01 --items <empty.json> --no-backup
 *
 * Skips cleanly when Python or Excel/COM is unavailable.
 * Run: node --test test/excel_smoke.test.js
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'excel_automation.py');
// Use a sandbox fixture — never a real order workbook.
const SOURCE_WB = path.join(ROOT, '_sandbox_test', 'torvex.xlsx');

let tmpDir = null;
let skipReason = null;

/**
 * Detect whether the environment can run the COM-based smoke test.
 * Returns null if ready, or a string describing why we must skip.
 */
function detectEnvironment() {
  // 1. Python available?
  try {
    execFileSync('python', ['--version'], { encoding: 'utf-8', timeout: 10000, stdio: 'pipe' });
  } catch {
    return 'Python not found on PATH';
  }

  // 2. win32com (pywin32) importable?
  try {
    execFileSync('python', ['-c', 'import win32com.client'], {
      encoding: 'utf-8',
      timeout: 15000,
      stdio: 'pipe',
    });
  } catch {
    return 'pywin32 (win32com) not installed — Excel/COM unavailable';
  }

  // 3. Source sandbox workbook exists?
  if (!fs.existsSync(SOURCE_WB)) {
    return `Sandbox workbook not found: ${SOURCE_WB}`;
  }

  return null;
}

describe('excel_automation.py smoke (COM)', () => {
  before(() => {
    skipReason = detectEnvironment();
    if (!skipReason) {
      // Create isolated temp directory with a workbook copy + empty items JSON.
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xl-smoke-'));
      fs.copyFileSync(SOURCE_WB, path.join(tmpDir, 'scratch.xlsx'));
      fs.writeFileSync(path.join(tmpDir, 'items.json'), '[]', 'utf-8');
    }
  });

  after(() => {
    // Cleanup temp artifacts regardless of outcome.
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
      tmpDir = null;
    }
  });

  it('runs end-to-end with empty items against a temp workbook copy', (t) => {
    if (skipReason) {
      t.skip(`SKIP: ${skipReason}`);
      return;
    }

    const wbCopy = path.join(tmpDir, 'scratch.xlsx');
    const itemsJson = path.join(tmpDir, 'items.json');

    let stdout;
    try {
      stdout = execFileSync(
        'python',
        [
          SCRIPT,
          '--file', wbCopy,
          '--customer', 'Test',
          '--date', '2026-01-01',
          '--items', itemsJson,
          '--no-backup',
        ],
        { encoding: 'utf-8', timeout: 90000, cwd: ROOT, stdio: 'pipe' }
      );
    } catch (err) {
      // Surface stderr for diagnostics before failing.
      const detail = err.stderr ? `\nSTDERR:\n${err.stderr}` : '';
      assert.fail(`excel_automation.py exited with code ${err.status}${detail}`);
    }

    // Basic sanity: script announced start and skipped backup.
    assert.match(stdout, /Starting Excel Automation/);
    assert.match(stdout, /Backup skipped/);
  });
});

#!/usr/bin/env node

/**
 * Doctor script - checks documented prerequisites
 * Exits 0 if all prerequisites found, nonzero with precise messages otherwise
 */

const { execFileSync } = require('child_process');

let hasError = false;

function check(label, testFn) {
  try {
    const result = testFn();
    console.log(`✓ ${label}: ${result}`);
  } catch (err) {
    console.error(`✗ ${label}: ${err.message}`);
    hasError = true;
  }
}

// 1. Check Python (reusing candidate order from main.js getPythonPath)
let pythonCmd = null;
check('Python', () => {
  const candidates = [];
  const explicitPath = process.env.PYTHON_PATH;

  if (explicitPath) {
    // When PYTHON_PATH is explicitly set, only try that path
    candidates.push(explicitPath);
  } else {
    // Otherwise try common names
    candidates.push('python', 'python3', 'py');
  }

  for (const candidate of candidates) {
    try {
      const version = execFileSync(candidate, ['--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000
      }).trim();
      pythonCmd = candidate;
      return `${candidate} (${version})`;
    } catch (e) {
      // try next
    }
  }

  if (explicitPath) {
    throw new Error(`PYTHON_PATH set to '${explicitPath}' but not executable`);
  } else {
    throw new Error(`No Python executable found. Tried: ${candidates.join(', ')}. Set PYTHON_PATH env var.`);
  }
});

// 1b. Check Python packages required by excel_automation.py (warning only,
//     same policy as the Excel check below)
if (process.platform === 'win32' && pythonCmd) {
  try {
    execFileSync(pythonCmd, ['-c', 'import win32com.client, openpyxl'], {
      stdio: 'ignore',
      timeout: 15000
    });
    console.log('✓ Python packages: pywin32 + openpyxl installed');
  } catch (e) {
    console.warn('⚠ Python packages: pywin32/openpyxl missing — Excel automation will fail. Run: pip install pywin32 openpyxl');
  }
}

// 2. Check Node version
check('Node.js', () => {
  const version = process.version;
  const major = parseInt(version.slice(1).split('.')[0], 10);
  if (major < 18) {
    throw new Error(`Node ${version} found, but Node 18+ required`);
  }
  return version;
});

// 3. Check Excel on win32 (optional — warning only)
if (process.platform === 'win32') {
  try {
    execFileSync('powershell.exe', [
      '-Command',
      'try { $null = New-Object -ComObject Excel.Application; exit 0 } catch { exit 1 }'
    ], { stdio: 'ignore', timeout: 10000 });
    console.log('✓ Microsoft Excel: found');
  } catch (e) {
    console.warn('⚠ Microsoft Excel: not detected (optional — required for Windows order automation)');
  }
}

if (hasError) {
  console.error('\nPrerequisites check failed. Please install missing dependencies.');
  process.exit(1);
} else {
  console.log('\nAll prerequisites satisfied.');
  process.exit(0);
}

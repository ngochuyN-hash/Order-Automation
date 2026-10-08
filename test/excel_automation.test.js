/**
 * Bridge test: runs Python unittest for excel_automation.py pure helpers
 * Run: node --test test/excel_automation.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

describe('excel_automation.py', () => {
  it('passes all Python unit tests for pure helpers', () => {
    const script = path.join(__dirname, 'test_excel_automation.py');
    execFileSync('python', [script, '-v'], {
      encoding: 'utf-8',
      timeout: 30000,
      cwd: path.join(__dirname, '..'),
    });
    // execFileSync throws on non-zero exit; reaching here means all passed
  });
});

/**
 * =========================================================================
 *  KV FILL HARNESS (test/kv-fill-harness.js)
 * =========================================================================
 *  Chạy ĐÚNG chuỗi script điền đơn sinh từ BrowserAgent._buildDirectFillScript()
 *  bên trong một BrowserWindow Electron ẩn, nạp trang mock KiotViet POS
 *  (test/fixtures/kv-pos-mock.html) — cho phép test hành vi giỏ mới/bổ sung
 *  KHÔNG cần đăng nhập KiotViet thật.
 *
 *  Giao thức:
 *    - ARGV[2] : JSON seed kịch bản (preloadItems/customer/intro) cho trang mock
 *    - ARGV[3] : đường dẫn fixture HTML
 *    - ARGV[4] : đường dẫn file chứa chuỗi fill script ("async () => {...}")
 *                (dùng file thay vì stdin — Electron trên Windows không đảm bảo stdin)
 *    - STDOUT  : dòng "KV_FILL_RESULT:{...json...}" + "KV_DUMP:{...}" trạng thái mock
 * =========================================================================
 */

const { app, BrowserWindow } = require('electron');
const fs = require('fs');

// Bỏ GPU để chạy ổn ở môi trường CI/RDP
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  // Watchdog: không bao giờ treo test cha
  const watchdog = setTimeout(() => {
    console.log('KV_FILL_TIMEOUT');
    app.exit(3);
  }, 90000);

  try {
    const seedArg = process.argv[2] || '{}';
    const fixturePath = process.argv[3];
    const scriptFile = process.argv[4];
    if (!fixturePath || !scriptFile) throw new Error('Thiếu argv fixture/script file');

    const win = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    const url = 'file://' + fixturePath.replace(/\\/g, '/')
      + '?seed=' + encodeURIComponent(seedArg);
    await win.loadURL(url);
    await new Promise((r) => setTimeout(r, 400)); // chờ init() của mock chạy xong

    const fillScript = fs.readFileSync(scriptFile, 'utf8');
    if (!fillScript.trim()) throw new Error('Fill script rỗng');

    // Script là "async () => {...}" → bọc ngoặc rồi gọi để thực thi
    const result = await win.webContents.executeJavaScript('(' + fillScript + ')()', true);
    const dump = await win.webContents.executeJavaScript('window.__kvDump && window.__kvDump()');

    console.log('KV_FILL_RESULT:' + JSON.stringify(result));
    console.log('KV_DUMP:' + JSON.stringify(dump));
    clearTimeout(watchdog);
    app.exit(0);
  } catch (err) {
    console.log('KV_FILL_ERROR:' + String(err && err.message ? err.message : err));
    clearTimeout(watchdog);
    app.exit(2);
  }
});

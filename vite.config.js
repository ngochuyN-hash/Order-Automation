import { defineConfig } from 'vite';
import { copyFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

// Strip `crossorigin` attribute from built HTML (breaks file:// loading in Electron)
function stripCrossOrigin() {
  return {
    name: 'strip-crossorigin',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(/ crossorigin/g, '');
    }
  };
}

// Copy static data files needed at runtime (XHR/fetch from renderer)
function copyStaticData() {
  return {
    name: 'copy-static-data',
    closeBundle() {
      const files = ['kv-name-map.json'];
      for (const f of files) {
        try { copyFileSync(resolve(__dirname, f), resolve(__dirname, 'dist', f)); }
        catch (e) { /* file may not exist */ }
      }
    }
  };
}

export default defineConfig({
  base: './',              // relative paths for Electron file:// loading
  plugins: [stripCrossOrigin(), copyStaticData()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    modulePreload: false,  // disable module preload (avoids crossorigin issues on file://)
    rollupOptions: {
      input: 'index.html'  // Vite processes index.html as entry
    }
  },
  server: { port: 5173 }
});

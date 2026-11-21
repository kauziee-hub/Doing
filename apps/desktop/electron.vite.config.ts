import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

/** Strict CSP for production renderer bundles (dev needs inline preamble + HMR websocket). */
const PROD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";
function cspPlugin(): Plugin {
  return {
    name: 'hirora-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('<head>', `<head>
    <meta http-equiv="Content-Security-Policy" content="${PROD_CSP}" />`);
    },
  };
}

// Everything except Electron, Node built-ins and optional native accelerators is
// bundled, so the packaged app needs no node_modules at runtime (simpler, smaller,
// and no native modules to rebuild for Electron's ABI).
const optionalNative = ['bufferutil', 'utf-8-validate', 'canvas', '@napi-rs/canvas'];

export default defineConfig({
  main: {
    build: {
      externalizeDeps: false,
      outDir: 'out/main',
      sourcemap: true,
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/main/index.ts') },
        external: ['electron', /^node:/, ...optionalNative],
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/preload/index.ts') },
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src'),
    plugins: [react(), cspPlugin()],
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      sourcemap: false,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/index.html'),
          overlay: resolve(__dirname, 'src/overlay.html'),
        },
      },
    },
  },
});

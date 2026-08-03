import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: {
    outDir: '../../dist/web',
    // tsc also emits dist/web/server.js (the web server module loaded at
    // runtime by dist/cli/index.js). Keep the directory intact — vite only
    // overwrites index.html and writes fingerprinted assets alongside.
    emptyOutDir: false,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
  resolve: {
    alias: {
      // So the web code can import from the root project
      '@': path.resolve('src'),
    },
  },
});

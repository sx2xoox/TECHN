import { defineConfig } from 'vite';

const target = process.env.ISOMORPH_SERVER ?? 'http://127.0.0.1:4000';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: target.replace(/^http/, 'ws'), ws: true },
      '/api': target,
      '/generated': target,
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
});

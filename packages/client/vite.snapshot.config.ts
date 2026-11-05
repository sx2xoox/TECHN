import { defineConfig } from 'vite';

/**
 * 공유본 보기 화면: 자바스크립트·스타일·글꼴을 모두 한 파일에 넣을 수 있게 하나로 묶는다.
 * 서버가 이 결과(dist-snapshot/snapshot.html)에 세계 자료를 끼워 넣어 HTML 하나를 만든다.
 */
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist-snapshot',
    target: 'es2022',
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 50 * 1024 * 1024,
    chunkSizeWarningLimit: 8000,
    rollupOptions: {
      input: { snapshot: 'snapshot.html' },
      output: { inlineDynamicImports: true },
    },
  },
});

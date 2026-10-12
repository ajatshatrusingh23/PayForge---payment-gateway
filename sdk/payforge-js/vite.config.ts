import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'PayForge', // UMD global: window.PayForge(publishableKey)
      formats: ['es', 'umd'],
      fileName: (format) => (format === 'es' ? 'payforge.js' : 'payforge.umd.cjs'),
    },
    target: 'es2019',
    sourcemap: true,
  },
});

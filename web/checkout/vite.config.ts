import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5174, strictPort: true },
  preview: { port: 5174, strictPort: true },
  build: { target: 'es2020', sourcemap: true },
});

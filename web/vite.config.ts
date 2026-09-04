import { defineConfig } from 'vite';

export default defineConfig({
  build: { outDir: 'dist', sourcemap: false },
  server: {
    port: 5173,
    // 本機開發時把 /api 轉給 Functions emulator（Hosting emulator 亦可）。
    proxy: { '/api': 'http://localhost:5000' },
  },
});

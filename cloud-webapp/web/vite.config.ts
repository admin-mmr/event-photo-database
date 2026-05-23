import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxy /api/* to the local Cloud Run-equivalent on :8080.
    // This makes dev and prod identical from the browser's POV — the
    // frontend always calls relative `/api/...` URLs.
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  build: {
    sourcemap: true,
    outDir: 'dist',
    target: 'es2020',
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: process.env.REVIEW_API_PROXY ?? 'http://localhost:8080',
        changeOrigin: true,
      },
      '/openapi.json': {
        target: process.env.REVIEW_API_PROXY ?? 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
    clearMocks: true,
  },
});

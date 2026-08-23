import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const apiProxy = process.env.REVIEW_API_PROXY ?? 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: apiProxy,
        changeOrigin: true,
      },
      '/openapi.json': {
        target: apiProxy,
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

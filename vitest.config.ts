import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const migrations = await readD1Migrations('./migrations');

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
    miniflare: {
      compatibilityDate: '2026-08-22',
      bindings: {
        TEST_MIGRATIONS: migrations,
        REVIEW_ADMIN_TOKEN: 'worker-test-only-administrator-token',
      },
    },
  })],
  test: { include: ['worker/test/**/*.test.ts'] },
});

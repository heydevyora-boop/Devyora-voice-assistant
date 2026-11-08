import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * NestJS 12 ships as pure ESM, which a CommonJS test registry cannot load.
 * Vitest runs ESM natively; the SWC plugin is what supplies decorator
 * metadata, since esbuild — Vitest's default transform — does not emit it
 * and Nest's dependency injection cannot resolve constructors without it.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // The suite shares one source address, so the rate limits are scaled up
    // under NODE_ENV=test (see src/security/rate-limits.ts). The limiter
    // itself stays installed and is exercised by rate-limit.spec.ts.
    env: { NODE_ENV: 'test' },
    include: ['test/**/*.spec.ts', 'src/**/*.spec.ts'],
    // Integration specs share one database; serial avoids cross-talk.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.module.ts', 'src/main.ts', 'src/**/README.md'],
    },
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});

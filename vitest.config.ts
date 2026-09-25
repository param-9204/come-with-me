import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    // Pipeline stage logs ("[geocode] …") are asserted on directly; keep test output readable.
    onConsoleLog: (log) => !/^\[(run|media|frames|ocr|vision|transcript|evidence|model|candidates|geocode|db)\]/.test(log),
  },
});

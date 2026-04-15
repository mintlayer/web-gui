import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'node',
    environmentMatchGlobs: [
      ['src/components/**/*.test.tsx', 'jsdom'],
      ['src/lib/txWatcher.test.ts', 'jsdom'],
    ],
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/lib/**', 'src/pages/api/**'],
      exclude: [
        // WASM dependency — requires native binary at runtime
        'src/lib/tx-decoder.ts',
        // Large HTTP client for the optional indexer service
        'src/lib/indexer.ts',
        // SSE/WebSocket bridge — streaming Response not supported in test environment
        'src/pages/api/block-stream.ts',
        // Fan-out indexer proxy with complex HTTP orchestration
        'src/pages/api/address-tokens.ts',
        // External IPFS/Pinata integration
        'src/pages/api/ipfs-upload.ts',
        // Module-level side effect: seeds DB from env on startup, no exported API to test
        'src/lib/settings-migration.ts',
        // Telegram daemon processes: long-poll loops and WebSocket state machines
        'src/lib/telegram-bot.ts',
        'src/lib/telegram-commands.ts',
        'src/lib/telegram-notifications.ts',
      ],
      reporter: ['text', 'lcov', 'html'],
      thresholds: { lines: 80, branches: 75 },
    },
  },
  resolve: {
    alias: { '@': resolve(__dirname, './src') },
  },
});

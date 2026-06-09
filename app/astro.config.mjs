import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import react from '@astrojs/react';

export default defineConfig({
  output: 'server',
  adapter: node({
    mode: 'standalone',
  }),
  integrations: [react()],
  security: {
    checkOrigin: true,
  },
  server: {
    host: process.env.HOST || '0.0.0.0',
    port: parseInt(process.env.PORT || '4321'),
  },
  vite: {
    server: {
      hmr: {
        // When running inside Docker, the HMR WebSocket must use the
        // host-side address — not the container's internal hostname.
        host: 'localhost',
      },
    },
    optimizeDeps: {
      // msw is test-only; exclude it so Vite doesn't try to pre-bundle it
      exclude: ['msw'],
    },
  },
});

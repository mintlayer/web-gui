import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import react from '@astrojs/react';

export default defineConfig({
  output: 'server',
  adapter: node({
    mode: 'standalone',
  }),
  integrations: [react()],
  // Astro 7 changed the compressHTML default from `true` to `'jsx'`, which strips
  // whitespace between inline elements differently. Pin the v6 behavior so the
  // upgrade doesn't silently alter rendered output. (TODO: drop this pin once a
  // jsx-mode rendering audit confirms no layout regressions.)
  compressHTML: true,
  security: {
    // Disabled here because the built-in check derives the request scheme
    // from the socket, which breaks every form POST behind the TLS-
    // terminating caddy gateway (the app sees http://, the browser sends
    // Origin: https://). lib/csrf.ts + the top of src/middleware.ts provide
    // a proxy-aware equivalent with identical semantics and pipeline
    // coverage.
    checkOrigin: false,
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

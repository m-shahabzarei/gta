/**
 * Vite build configuration.
 *
 * - Resolves the `@` alias to the `src` directory (kept in sync with tsconfig.json).
 * - Configures a deterministic dev server port.
 * - Produces an optimised, source-mapped production bundle in `dist/`.
 * - Splits the (large) Phaser runtime into its own chunk for better caching.
 */
import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    open: true,
    host: true,
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: true,
    chunkSizeWarningLimit: 2048,
    rollupOptions: {
      output: {
        manualChunks: {
          phaser: ['phaser'],
        },
      },
    },
  },
});

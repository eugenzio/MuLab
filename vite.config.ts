import { defineConfig } from 'vite';

// Vitest config is merged here via the `test` field (vitest reads vite.config.ts).
export default defineConfig({
  worker: {
    format: 'es',
  },
  build: {
    rollupOptions: {
      // Two HTML entries: the app and the benchmark harness page.
      input: { main: 'index.html', bench: 'benchmarks/bench.html' },
    },
  },
  test: {
    // Parser tests run pure Node logic over ArrayBuffers — no DOM needed in Phase 1.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: true,
  },
});

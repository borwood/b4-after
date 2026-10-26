import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      // Run against the ledger sources so tests do not need a build step.
      '@like-b4/ledger': new URL('../ledger/src/index.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    },
  },
})

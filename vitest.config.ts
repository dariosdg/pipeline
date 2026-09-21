import { defineConfig } from 'vitest/config';

/** Prevent compiled test artifacts from being executed alongside source tests. */
export default defineConfig({
  test: {
    exclude: ['dist/**', 'node_modules/**'],
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    // The job store touches a real JSON file on disk.
    fileParallelism: false,
    testTimeout: 20000,
  },
});

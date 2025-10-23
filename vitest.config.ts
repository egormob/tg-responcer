import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/**/*.{test,spec}.ts'],
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'logs/coverage'
    }
  }
});

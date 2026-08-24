import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    env: {
      GEMINI_MODEL: 'gemini-2.5-flash',
      OLLAMA_MODEL: 'llama3',
      AI_PROVIDER: 'google',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/types.ts',
        '**/*-types.ts',
      ],
      // A ratchet, not a target. Set just below the numbers the suite actually produced
      // the first time coverage ran, so it catches a regression without failing today.
      // Raise them when the real figures move up; never lower them to make a build pass.
      thresholds: {
        statements: 82,
        branches: 70,
        functions: 85,
        lines: 83,
      },
    },
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    setupFiles: ['./tests/setup-genkit.ts'],
    pool: 'threads',
    isolate: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      '@serapeum/shared-schemas': path.resolve(
        import.meta.dirname,
        './packages/shared-schemas/src/index.ts'
      ),
    },
  },
});

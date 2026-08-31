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
        // The Genkit eval harness: scorers driven by `npm run eval:compare` against the
        // datasets in .genkit/, never by the request path. It entered this report only
        // because app.ts registers the evaluators at import; measuring it here would
        // rebase the ratchet below on code the suite was never calibrated against.
        'src/evals/**',
      ],
      // A ratchet, not a target. Set just below the numbers the suite actually produced
      // the first time coverage ran, so it catches a regression without failing today.
      // Raise them when the real figures move up; never lower them to make a build pass.
      thresholds: {
        statements: 85,
        branches: 73,
        functions: 87,
        lines: 85,
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

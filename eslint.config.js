import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import tsParser from '@typescript-eslint/parser';
import prettierPlugin from 'eslint-plugin-prettier';

export default [
    // Global ignores
    {
        ignores: ['dist/**', 'node_modules/**', 'eslint.config.js', 'commitlint.config.js'],
    },

    // The recommended sets, rather than a hand-picked subset. `typescript-eslint` switches
    // off the core rules that `tsc` already enforces better (no-undef, no-dupe-keys,
    // no-unreachable), so the two do not fight — what is left is what the compiler cannot see.
    js.configs.recommended,
    ...tseslint.configs.recommended,

    // TypeScript & Prettier Configuration
    {
        files: ['src/**/*.ts'],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                ecmaVersion: 2022,
                sourceType: 'module',
                project: './tsconfig.json',
                tsconfigRootDir: import.meta.dirname,
            },
        },
        plugins: {
            prettier: prettierPlugin,
        },
        rules: {
            // Prettier
            'prettier/prettier': 'error',

            // Project overrides on top of the recommended sets
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            '@typescript-eslint/explicit-function-return-type': 'warn',
            '@typescript-eslint/strict-boolean-expressions': 'off',
            '@typescript-eslint/no-empty-interface': 'warn',

            // General
            'no-console': 'off',
            'no-debugger': 'error',
        },
    },
];

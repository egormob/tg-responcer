module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    project: './tsconfig.json',
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: {
    es2021: true,
    node: true,
  },
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['apps/worker-main/core/*'],
            message: 'The frozen core can only be accessed via its public API exports.',
          },
          {
            group: ['../core/*'],
            message: 'The frozen core can only be accessed via its public API exports.',
          },
        ],
      },
    ],
  },
  ignorePatterns: ['dist', 'logs', 'snapshot', 'memory-bank', 'vitest.config.ts'],
};

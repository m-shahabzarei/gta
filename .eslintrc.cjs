/**
 * ESLint configuration.
 *
 * Enforces the TypeScript recommended rule set and defers all formatting
 * concerns to Prettier (via eslint-config-prettier) so the two never conflict.
 */
module.exports = {
  root: true,
  env: {
    browser: true,
    es2021: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    project: './tsconfig.json',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ],
  rules: {
    '@typescript-eslint/explicit-member-accessibility': [
      'warn',
      { accessibility: 'explicit', overrides: { constructors: 'no-public' } },
    ],
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/no-explicit-any': 'warn',
    'no-console': 'off',
    eqeqeq: ['error', 'always'],
    curly: ['error', 'multi-line'],
  },
  ignorePatterns: ['dist/', 'node_modules/', '*.cjs', 'vite.config.ts'],
};

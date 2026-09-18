import js from '@eslint/js';
import globals from 'globals';

const shared = {
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
  'no-console': 'off',
  eqeqeq: ['error', 'smart'],
  'prefer-const': 'error',
  'no-var': 'error'
};

export default [
  { ignores: ['node_modules/**', 'public/vendor/**'] },
  js.configs.recommended,
  {
    files: ['server.js', 'src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: shared
  },
  {
    files: ['test/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: { ...shared, 'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }] }
  },
  {
    files: ['public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser, io: 'readonly' }
    },
    rules: shared
  },
  {
    files: ['public/js/landing.js'],
    languageOptions: { sourceType: 'script' }
  },
  {
    files: ['public/js/room/ticker-worker.js'],
    languageOptions: { globals: { ...globals.worker } }
  }
];

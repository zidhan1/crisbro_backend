const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/**', 'generated/**', '.vercel/**', 'coverage/**'],
  },
  {
    files: ['src/**/*.js', 'scripts/**/*.js', 'test/**/*.js', 'test-integration/**/*.js', 'api/**/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        fetch: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      // Existing modules intentionally expose helper constants/functions for
      // scripts and tests; unused cleanup is handled separately from this
      // correctness gate.
      'no-unused-vars': 'off',
    },
  },
];

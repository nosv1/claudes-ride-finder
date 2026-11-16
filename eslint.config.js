// Lint rules for the coding standard (CODING.md): each group says which of its rules it checks. npm run lint runs this
// with --max-warnings 0. Code that broke a rule before the standard came in is listed in eslint-suppressions.json; fix it
// when you're in there anyway (then npm run lint:prune), and don't add to it.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Rules 1, 4, 6 and 10 (and 2 where a linter can see it), for every JS file.
const standard = {
  ...js.configs.recommended.rules,
  // 1. Simple control flow.
  'no-labels': 'error',
  'no-restricted-syntax': ['error', { selector: 'WithStatement', message: 'Rule 1: no with.' }],
  // 2. Every loop has a bound: no while (true) or for (;;).
  'no-constant-condition': ['error', { checkLoops: 'all' }],
  // 4. Short, simple functions.
  'max-lines-per-function': ['error', { max: 60, skipBlankLines: true, skipComments: true, IIFEs: true }],
  'complexity': ['error', 15],
  'max-depth': ['error', 4],
  'max-params': ['error', 5],
  'max-nested-callbacks': ['error', 4],
  // 6. Data in the smallest scope.
  'no-var': 'error',
  'prefer-const': ['error', { destructuring: 'all' }],
  'no-shadow': ['error', { builtinGlobals: false, hoist: 'functions' }],
  'block-scoped-var': 'error',
  'no-implicit-globals': 'error',
  // 10. No warnings, nothing left unused, no surprising comparisons.
  'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none' }],
  'eqeqeq': ['error', 'smart'],
  'no-eval': 'error',
  'no-implied-eval': 'error',
};

export default tseslint.config(
  { ignores: ['node_modules/', 'tiles/', 'raw/', 'worker/.wrangler/', 'voice/', 'icons/'] },
  // The app (browser modules).
  {
    files: ['js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022, sourceType: 'module',
      globals: { ...globals.browser, maplibregl: 'readonly', google: 'readonly' },
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      ...standard,
      // 7. Check what calls return: a promise is awaited, returned or given a .catch, never dropped.
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false, attributes: false } }],
    },
  },
  // The service worker and the accounts API.
  {
    files: ['sw.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: { ...globals.serviceworker } },
    // A classic script: its top-level functions live in the worker's own scope, not a page's.
    rules: { ...standard, 'no-implicit-globals': 'off' },
  },
  {
    files: ['worker/src/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.serviceworker, ...globals.es2021 } },
    rules: standard,
  },
  // Tools and tests run in Node. Tests are long lists of steps by nature, so rule 4's length limit is off for them.
  {
    files: ['tools/**/*.mjs', 'tests/**/*.mjs', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node } },
    rules: { ...standard, 'max-lines-per-function': 'off', 'max-nested-callbacks': 'off' },
  },
);

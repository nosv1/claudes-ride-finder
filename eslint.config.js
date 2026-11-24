// Lint for the coding standard (nosv1/nosv1 CODING.md; rules in eslint-standard.mjs, a copy of the hub's, and this
// repo's notes in CODING.md). npm run lint runs this with --max-warnings 0. Code that broke a rule before the standard
// came in is listed in eslint-suppressions.json; fix it when you're in there anyway (then npm run lint:prune), and
// don't add to it.
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { linterOptions, standardRules, testRuleOverrides, typeAwareRules } from './eslint-standard.mjs';

export default [
  { ignores: ['node_modules/', 'tiles/', 'raw/', 'worker/.wrangler/', 'voice/', 'icons/'] },
  { linterOptions },
  // The app (browser modules), type-checked by tsconfig.json.
  {
    files: ['js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022, sourceType: 'module',
      globals: { ...globals.browser, maplibregl: 'readonly', google: 'readonly' },
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: { ...standardRules, ...typeAwareRules },
  },
  // The service worker and the accounts API.
  {
    files: ['sw.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: { ...globals.serviceworker } },
    // A classic script: its top-level functions live in the worker's own scope, not a page's.
    rules: { ...standardRules, 'no-implicit-globals': 'off' },
  },
  {
    files: ['worker/src/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.serviceworker, ...globals.es2021 } },
    rules: standardRules,
  },
  // Tools and tests run in Node. Tests are long lists of steps by nature, so rule 4's size limits are off for them.
  {
    files: ['tools/**/*.mjs', 'tests/**/*.mjs', 'eslint.config.js', 'eslint-standard.mjs'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node } },
    rules: { ...standardRules, ...testRuleOverrides },
  },
];

// The coding standard's ESLint rules (nosv1/nosv1 CODING.md). Canonical copy: nosv1/nosv1
// standard/eslint-standard.mjs. Repos keep a copy beside eslint.config.mjs; change the hub's and copy it out.
// Each group names the Power of 10 rule it checks. Run ESLint with --max-warnings 0: every rule here is an error.
import js from '@eslint/js';

// For every JavaScript file.
export const standardRules = {
  ...js.configs.recommended.rules,
  // 1. Simple control flow: no labels, no `with`, no `arguments.callee`.
  'no-labels': 'error',
  'no-restricted-syntax': ['error', { selector: 'WithStatement', message: 'Rule 1: no with.' }],
  'no-caller': 'error',
  // 2. Every loop has a bound: no `while (true)` or `for (;;)`.
  'no-constant-condition': ['error', { checkLoops: 'all' }],
  'no-unmodified-loop-condition': 'error',
  // 4. A function fits on a page and stays simple.
  'max-lines-per-function': ['error', { max: 60, skipBlankLines: true, skipComments: true, IIFEs: true }],
  'complexity': ['error', 10],
  'max-depth': ['error', 4],
  'max-params': ['error', 4],
  'max-nested-callbacks': ['error', 3],
  // 6. Data in the smallest scope.
  'no-var': 'error',
  'prefer-const': ['error', { destructuring: 'all' }],
  'no-shadow': ['error', { builtinGlobals: false, hoist: 'all' }],
  'block-scoped-var': 'error',
  'no-implicit-globals': 'error',
  'no-param-reassign': 'error',
  // 7. Check every result: nothing unused, no empty catch, no expression thrown away.
  'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'all',
    caughtErrorsIgnorePattern: '^_' }],
  'no-empty': ['error', { allowEmptyCatch: false }],
  'no-unused-expressions': 'error',
  'no-throw-literal': 'error',
  'prefer-promise-reject-errors': 'error',
  'no-promise-executor-return': 'error',
  'array-callback-return': 'error',
  // 8. No metaprogramming: no eval or code from strings, no monkeypatching built-ins.
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',
  'no-script-url': 'error',
  'no-extend-native': 'error',
  'no-proto': 'error',
  'no-global-assign': 'error',
  // 10. No surprising comparisons or coercions.
  'eqeqeq': ['error', 'always', { null: 'ignore' }],
  'no-implicit-coercion': 'error',
  'radix': 'error',
};

// Rule 7 for code the type checker can see (needs typescript-eslint with parserOptions.projectService):
// a promise is awaited, returned, given a .catch, or marked `void` when the callee handles its own failure.
export const typeAwareRules = {
  '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
  '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false, attributes: false } }],
  '@typescript-eslint/await-thenable': 'error',
  '@typescript-eslint/require-array-sort-compare': 'error',
  '@typescript-eslint/switch-exhaustiveness-check': 'error',
};

// Tests and build tools: long step lists are their nature, so rule 4's size limits are off; the rest holds.
export const testRuleOverrides = {
  'max-lines-per-function': 'off',
  'max-nested-callbacks': 'off',
  'complexity': 'off',
};

// Rule 10: a disable comment that no longer disables anything is itself an error.
export const linterOptions = { reportUnusedDisableDirectives: 'error' };

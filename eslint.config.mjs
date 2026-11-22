import js from '@eslint/js';
import ts from 'typescript-eslint';

export default ts.config(
  { ignores: ['main.js', 'node_modules/**', 'docs/**', 'test-vault/**', 'output/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  { files: ['**/*.mjs'], languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly' } } },
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      'no-restricted-globals': [
        'error',
        { name: 'setTimeout', message: 'Use window.setTimeout for Obsidian multi-window compatibility.' },
        { name: 'clearTimeout', message: 'Use window.clearTimeout for Obsidian multi-window compatibility.' },
      ],
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);

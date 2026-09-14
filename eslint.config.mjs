import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import jupyterPlugin from '@jupyter/eslint-plugin';

export default defineConfig([
  {
    ignores: [
      'node_modules',
      'lib',
      'coverage',
      'jupyter_aiterminal/labextension',
      '**/*.js',
      '**/*.d.ts'
    ]
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    plugins: { jupyter: jupyterPlugin }
  },
  jupyterPlugin.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2015,
        ...globals.node,
        ...globals.jest
      },
      parserOptions: {
        project: 'tsconfig.json',
        sourceType: 'module'
      }
    }
  },
  prettierRecommended
]);

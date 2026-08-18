import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    plugins: {
      prettier,
    },
    rules: {
      'prettier/prettier': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-empty-object-type': 'off',
      'require-yield': 'off',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-unused-expressions': 'off',
      'no-useless-assignment': 'off',
      // Allow empty catch blocks without a filler comment (`/* ignore */`).
      // Empty catches are an intentional idiom for swallowing expected errors
      // (e.g. unlinkSync on a non-existent pid file). Clean Code P3-3.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  // Test files often use 'any' for mock/spy typing convenience
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  // Node 脚本（mock CLI 等）：flat config 已不支持 eslint-env 注释，
  // 用 languageOptions.globals 声明 Node 全局。
  {
    files: ['tests/lib/*.js'],
    languageOptions: {
      globals: {
        process: 'readonly',
        setInterval: 'readonly',
      },
    },
  },
  {
    ignores: ['dist/', 'node_modules/', '*.js', '*.d.ts', '*.js.map'],
  },
);

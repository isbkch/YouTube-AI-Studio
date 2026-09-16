import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['node_modules/**', '.build/**', '.demo/**', 'apps/**', 'dist/**'] },
  ...tseslint.configs.recommended,
  { rules: { '@typescript-eslint/no-explicit-any': 'error', '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] } }
);

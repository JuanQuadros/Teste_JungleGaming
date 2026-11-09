import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolve os aliases de caminho definidos em tsconfig.json, inclusive os
  // adicionados por `nest g library`. Esta opção requer o Vite 8.
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
  },
});

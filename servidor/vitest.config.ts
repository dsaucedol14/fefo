import { defineConfig } from 'vitest/config';

// Las pruebas de integración usan una base aparte (fefo_prueba) que se recrea en cada corrida
export default defineConfig({
  test: {
    env: {
      DATABASE_NAME: 'fefo_prueba',
      DATABASE_URL: process.env.DATABASE_URL_PRUEBA ?? 'postgres://app_fefo:app-fefo-dev@localhost:5433/fefo_prueba',
      COOKIE_SEGURA: '0',
    },
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

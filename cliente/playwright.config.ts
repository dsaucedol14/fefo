import { defineConfig, devices } from '@playwright/test';

// Pruebas extremo a extremo (P3, Tabla XIII): teléfono Android emulado contra el servidor en marcha
// con la base del caso simulado (npm run bd:preparar + bd:cargar-sim).
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: process.env.URL_FEFO ?? 'http://localhost:3000',
    ...devices['Pixel 7'],
    locale: 'es-MX',
    timezoneId: 'America/Mexico_City',
    screenshot: 'only-on-failure',
  },
  outputDir: process.env.SALIDA_E2E ?? 'test-results',
});

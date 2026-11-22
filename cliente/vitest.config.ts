import { defineConfig } from 'vitest/config';

// Unitarias del cliente; las de extremo a extremo (e2e/) son de Playwright
export default defineConfig({ test: { include: ['src/**/*.test.ts'], environment: 'node' } });

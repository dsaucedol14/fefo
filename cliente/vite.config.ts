import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// PWA instalable desde Chrome (ADR-002): el Service Worker guarda la aplicación para abrirla sin red;
// los datos sin red viven en IndexedDB (cola de movimientos, ADR-004), no en la caché del Service Worker.
export default defineConfig({
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },
  build: { target: 'es2022', sourcemap: true },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icono.svg'],
      manifest: {
        name: 'FEFO Tarimas',
        short_name: 'FEFO',
        description: 'Trazabilidad de tarimas y control FEFO de perecederos',
        lang: 'es-MX',
        start_url: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#F4F6F9',
        theme_color: '#1F4E79',
        icons: [
          { src: 'icono.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icono-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icono-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
      },
    }),
  ],
});

import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The router serves the build under /dashboard: assets live at /dashboard/assets and the app's router base is /dashboard.
export default defineConfig({
  base: '/dashboard/',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: { outDir: '../../dist/apps/dashboard', emptyOutDir: true, sourcemap: false },
  server: { port: 5173, proxy: { '/dashboard/api': 'http://127.0.0.1:18933', '/dashboard/auth': 'http://127.0.0.1:18933' } },
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: { outDir: '../../dist/web', emptyOutDir: true },
  server: {
    port: 5173,
    // '/api/' med snedstreck så att modulen /api.ts inte proxas till API-servern
    proxy: { '/api/': 'http://localhost:3000' },
  },
});

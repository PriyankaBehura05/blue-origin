import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: {
    // Dev: the frontend calls /api/... and Vite forwards it to the FastAPI backend.
    proxy: { '/api': { target: process.env.VITE_PROXY_TARGET ?? 'http://localhost:8000', changeOrigin: true } },
  },
});

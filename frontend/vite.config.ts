import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, 'VITE_'); // .env.development, .env.remote, ...
  return {
    plugins: [react()],
    resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
    server: {
      // Dev: the frontend calls /api/... and Vite forwards it to the FastAPI backend.
      proxy: { '/api': { target: env.VITE_PROXY_TARGET ?? 'http://localhost:8000', changeOrigin: true } },
    },
  };
});

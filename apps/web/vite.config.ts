import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const port = env.WEB_PORT ? Number(env.WEB_PORT) : 5173;
  // Em container o host da API é o nome do serviço (`api`); no host local é `localhost`.
  const apiTarget = env.VITE_API_PROXY_TARGET ?? 'http://localhost:3333';

  return {
    plugins: [react()],
    server: {
      port,
      // `host: true` faz o Vite escutar em 0.0.0.0 (necessário dentro do container).
      host: true,
      // Polling garante hot-reload confiável em bind mounts Docker (inotify não propaga).
      watch: { usePolling: true },
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
        },
        '/ws': {
          target: apiTarget,
          ws: true,
          changeOrigin: true,
        },
      },
    },
    resolve: {
      alias: {
        '@': new URL('./src', import.meta.url).pathname,
      },
    },
  };
});

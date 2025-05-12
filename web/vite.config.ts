// @ts-ignore
import { resolve } from 'path';
import { defineConfig, loadEnv } from 'vite';
import solidPlugin from 'vite-plugin-solid';

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  let host = "127.0.0.1";
  if (env["INFUMAP_DEV_HOST"]) {
    host = env["INFUMAP_DEV_HOST"];
  }
  return {
    plugins: [solidPlugin()],
    server: {
      port: 3000,
      proxy: {
        '/assets': {
          target: `http://${host}:8000`,
          changeOrigin: true
        },
        '/account': {
          target: `http://${host}:8000`,
          changeOrigin: true
        },
        '/admin': {
          target: `http://${host}:8000`,
          changeOrigin: true
        },
        '/command': {
          target: `http://${host}:8000`,
          changeOrigin: true
        },
        '/files': {
          target: `http://${host}:8000`,
          changeOrigin: true
        },
        '/add': {
          target: `http://${host}:8000`,
          changeOrigin: true
        },
      }
    },
    build: {
      target: 'esnext',
      outDir: './dist',
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        input: {
          // @ts-ignore
          main: resolve(__dirname, 'index.html'),
          // @ts-ignore
          add: resolve(__dirname, 'add.html'),
        },
      },
    },
  }
});

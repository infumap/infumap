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

  // Check if we should disable minification
  const noMinify = process.env.NO_MINIFY === 'true' || process.env.NODE_ENV === 'development';

  return {
    plugins: [solidPlugin()],
    server: {
      port: 3000,
      proxy: {
        '/assets': {
          target: `http://${host}:8000`,
          // Preserve the browser-facing Host header so backend same-origin
          // session checks keep accepting cookies when running through Vite.
          changeOrigin: false
        },
        '/account': {
          target: `http://${host}:8000`,
          changeOrigin: false
        },
        '/admin': {
          target: `http://${host}:8000`,
          changeOrigin: false
        },
        '/command': {
          target: `http://${host}:8000`,
          changeOrigin: false
        },
        '/ingest': {
          target: `http://${host}:8000`,
          changeOrigin: false
        },
        '/files': {
          target: `http://${host}:8000`,
          changeOrigin: false
        },
        '/add': {
          target: `http://${host}:8000`,
          changeOrigin: false
        },
      }
    },
    build: {
      target: 'esnext',
      outDir: './dist',
      chunkSizeWarningLimit: 1000,
      minify: noMinify ? false : 'esbuild',
      sourcemap: noMinify ? true : false,
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

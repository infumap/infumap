import { resolve } from 'path';
import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solidPlugin()],
  server: {
    port: 3000,
    proxy: {
      '/assets': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true
      },
      '/account': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true
      },
      '/admin': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true
      },
      '/command': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true
      },
      '/files': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true
      },
      '/add': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true
      },
    }
  },
  build: {
    target: 'esnext',
    outDir: './dist',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        add: resolve(__dirname, 'add.html'),
      },
    },
  },
});

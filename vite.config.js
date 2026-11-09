import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const page = (name) => fileURLToPath(new URL(`./${name}.html`, import.meta.url));

// Multi-page build: include every standalone demo page
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: page('index'),
        church: page('church'),
        temple: page('temple'),
        warehouse: page('warehouse'),
        creek: page('creek'),
      },
    },
  },
});

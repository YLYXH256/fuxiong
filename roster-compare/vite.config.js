import { defineConfig } from 'vite';

export default defineConfig({
  base: '/fuxiong/roster-compare/',
  server: {
    watch: { ignored: ['**/artifacts/**', '**/server*.log'] },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: { spreadsheet: ['xlsx', 'papaparse'], icons: ['lucide'] },
      },
    },
  },
});

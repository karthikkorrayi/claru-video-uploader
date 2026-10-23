import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The browser only ever talks to this dev server; /api is passed to the Node
// server on 8080, so cookies stay same-origin (no CORS).
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:8080' },
  },
});

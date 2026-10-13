import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8150', '/assets': 'http://localhost:8150', '/media': 'http://localhost:8150' },
  },
  build: { sourcemap: true, chunkSizeWarningLimit: 900, assetsDir: 'static' },
})

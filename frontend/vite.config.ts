import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

const backendProxy = {
  target: 'http://localhost:8090',
  changeOrigin: true
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  server: {
    port: 3000,
    proxy: {
      '/v2': backendProxy,
      '^/[^?]+\\.mp3(?:\\?|$)': backendProxy
    }
  }
})

import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// Vite config with dev proxies and "@/..." alias → "<repo>/src"
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // Dev proxy target: default to the DCAD API on 127.0.0.1:8000
  // You can override with VITE_PROXY_TARGET env var if needed.
  const target = env.VITE_PROXY_TARGET || 'http://127.0.0.1:8000'

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      proxy: {
        '/api':    { target, changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') },
        '/health': { target, changeOrigin: true }
      }
    }
  }
})

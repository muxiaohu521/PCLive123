import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import fs from 'fs'
import http from 'http'
import https from 'https'
import { URL } from 'url'

export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'serve-sources-json',
      configureServer(server) {
        // Serve sources.json
        server.middlewares.use((req, res, next) => {
          if (req.url === '/sources.json') {
            const filePath = resolve(__dirname, 'sources.json')
            try {
              const content = fs.readFileSync(filePath, 'utf-8')
              res.setHeader('Content-Type', 'application/json; charset=utf-8')
              res.setHeader('Access-Control-Allow-Origin', '*')
              res.end(content)
            } catch {
              res.statusCode = 404
              res.end('[]')
            }
            return
          }
          next()
        })

        // Generic HTTP proxy for dev mode (avoids CORS when fetching external live sources)
        server.middlewares.use((req, res, next) => {
          const url = new URL(req.url || '', 'http://127.0.0.1:5173')
          const targetUrl = url.searchParams.get('url')
          if (!targetUrl || url.pathname !== '/proxy') {
            next()
            return
          }

          if (!/^https?:\/\//i.test(targetUrl)) {
            res.statusCode = 400
            res.end('Invalid URL')
            return
          }

          const parsed = new URL(targetUrl)
          const protocol = parsed.protocol === 'https:' ? https : http
          const proxyReq = protocol.request({
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: 'GET',
            headers: {
              'User-Agent': 'okhttp/3.15',
              'Accept': '*/*',
              'Accept-Language': 'zh-CN,zh;q=0.9',
              'Accept-Encoding': 'gzip, deflate',
              'Host': parsed.host,
            },
            timeout: 15000,
            rejectUnauthorized: false,
          }, (proxyRes) => {
            res.statusCode = proxyRes.statusCode || 200
            res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'text/plain; charset=utf-8')
            res.setHeader('Access-Control-Allow-Origin', '*')
            let body = ''
            proxyRes.setEncoding('utf-8')
            proxyRes.on('data', chunk => body += chunk)
            proxyRes.on('end', () => res.end(body))
          })
          proxyReq.on('error', () => { res.statusCode = 502; res.end('Proxy error') })
          proxyReq.on('timeout', () => { proxyReq.destroy(); res.statusCode = 504; res.end('Proxy timeout') })
          proxyReq.end()
        })
      }
    }
  ],
  base: './',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@shared': resolve(__dirname, 'electron/shared')
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:9978',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets'
  }
})
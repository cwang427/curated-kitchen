import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'
import { copyFileSync } from 'node:fs'

// GitHub Pages serves a project site from /<repo>/. Override with
// BASE_PATH=/ when deploying to a custom domain or Firebase Hosting.
const base = process.env.BASE_PATH ?? '/curated-kitchen/'

export default defineConfig({
  base,
  build: {
    rollupOptions: {
      output: {
        // Firebase dwarfs the app code and changes far less often; keeping it
        // in its own chunk means app deploys don't re-download it.
        manualChunks: {
          firebase: ['firebase/app', 'firebase/auth', 'firebase/firestore'],
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  plugins: [
    {
      // GitHub Pages has no SPA rewrite, so a deep link like /r/<slug> 404s.
      // Serving the app from 404.html hands those URLs to the router instead.
      name: 'pages-spa-fallback',
      closeBundle() {
        copyFileSync('dist/index.html', 'dist/404.html')
      },
    },
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon.png'],
      manifest: {
        name: 'Curated Kitchen',
        short_name: 'Kitchen',
        description: 'Recipes, live cooking, and the grocery list — in one place.',
        theme_color: '#1c1917',
        background_color: '#faf9f7',
        display: 'standalone',
        orientation: 'portrait',
        scope: base,
        start_url: base,
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // Firestore has its own offline persistence; don't let Workbox
        // shadow its requests with a stale cache.
        navigateFallbackDenylist: [/^\/__/, /firestore\.googleapis\.com/],
      },
    }),
  ],
})

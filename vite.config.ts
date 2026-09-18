import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

// GitHub Pages serves a project site from /<repo>/. Override with
// BASE_PATH=/ when deploying to a custom domain or Firebase Hosting.
const base = process.env.BASE_PATH ?? '/curated-kitchen/'

// A build stamp so Settings can show which version is running and whether a
// newer one has been deployed. The commit comes from git (available in the CI
// checkout); it falls back to 'local' for a plain `npm run build`.
function buildInfo(): { version: string; commit: string; time: string } {
  let commit = 'local'
  try {
    commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    // No git (e.g. a tarball build) — 'local' is fine.
  }
  const version = JSON.parse(readFileSync('./package.json', 'utf8')).version as string
  return { version, commit, time: new Date().toISOString() }
}

const BUILD = buildInfo()

export default defineConfig({
  base,
  // Compiled into the bundle so the running app knows its own version.
  define: { __BUILD__: JSON.stringify(BUILD) },
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
      name: 'pages-spa-fallback',
      closeBundle() {
        // GitHub Pages has no SPA rewrite, so a deep link like /r/<slug> 404s.
        // Serving the app from 404.html hands those URLs to the router instead.
        copyFileSync('dist/index.html', 'dist/404.html')
        // A tiny, un-precached manifest the app fetches to detect a newer
        // deploy. Not in the Workbox glob (json isn't listed), so it's always
        // served fresh from the network rather than the service-worker cache.
        writeFileSync('dist/version.json', JSON.stringify(BUILD))
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

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

const stub = (name: string) => fileURLToPath(new URL(`./.preview/stubs/${name}`, import.meta.url))

// Renders the real pages and components against fixture data, with Firebase
// swapped out, so the UI can be checked without a live project.
export default defineConfig({
  root: fileURLToPath(new URL('./.preview', import.meta.url)),
  resolve: {
    alias: [
      { find: /^.*\/lib\/firebase$/, replacement: stub("firebase.ts") },
      { find: /^.*\/auth\/AuthProvider$/, replacement: stub("AuthProvider.tsx") },
      { find: /^.*\/data\/recipes$/, replacement: stub("recipes.tsx") },
    ],
  },
  plugins: [react(), tailwindcss()],
})

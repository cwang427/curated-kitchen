import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

const stub = (name: string) => fileURLToPath(new URL(`./.preview/stubs/${name}`, import.meta.url))

// Renders the real pages and components against fixture data, with Firebase
// swapped out, so the UI can be checked without a live project.
export default defineConfig({
  define: {
    __BUILD__: JSON.stringify({ version: '0.0.0', commit: 'preview', time: new Date().toISOString() }),
  },
  root: fileURLToPath(new URL('./.preview', import.meta.url)),
  resolve: {
    alias: [
      { find: /^.*\/lib\/firebase$/, replacement: stub("firebase.ts") },
      // Must match the WHOLE specifier — Vite replaces only the matched
      // portion, and imports arrive as both "./AuthProvider" and
      // "../auth/AuthProvider".
      { find: /^.*AuthProvider$/, replacement: stub("AuthProvider.tsx") },
      { find: /^.*\/data\/recipes$/, replacement: stub("recipes.tsx") },
      { find: /^.*\/data\/invites$/, replacement: stub("invites.ts") },
      { find: /^.*\/data\/household$/, replacement: stub("household.ts") },
      { find: /^.*\/data\/grocery$/, replacement: stub("grocery.ts") },
      { find: /^.*\/data\/plan$/, replacement: stub("plan.ts") },
      { find: /^.*\/data\/cooksession$/, replacement: stub("cooksession.ts") },
    ],
  },
  plugins: [react(), tailwindcss()],
})

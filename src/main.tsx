import { createRoot } from 'react-dom/client'
import { StrictMode } from 'react'
import { isConfigured } from './lib/firebaseConfig'
import SetupNotice from './components/SetupNotice'
import './index.css'

const root = createRoot(document.getElementById('root')!)

if (!isConfigured) {
  // Render the setup steps without importing anything that touches Firebase —
  // initializing it with an empty config throws before React can mount.
  root.render(
    <StrictMode>
      <SetupNotice />
    </StrictMode>,
  )
} else {
  Promise.all([
    import('react-router-dom'),
    import('./App'),
    import('./auth/AuthProvider'),
  ]).then(([{ BrowserRouter }, { default: App }, { AuthProvider }]) => {
    root.render(
      <StrictMode>
        {/* BASE_URL carries the GitHub Pages subpath, so routes resolve
            correctly at /curated-kitchen/ and at a custom domain alike. */}
        <BrowserRouter basename={import.meta.env.BASE_URL}>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </StrictMode>,
    )
  })
}

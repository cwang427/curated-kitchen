import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'

/** How many in-app pages sit behind this one. React Router's BrowserRouter
 * stamps each history entry it creates with an index; 0 means the app was
 * opened straight onto this screen (a reload or a link). */
export function historyDepth(): number {
  return (window.history.state as { idx?: number } | null)?.idx ?? 0
}

/**
 * Go back the way the iPhone edge-swipe does: one step in history. An installed
 * web app can't turn that gesture off, so every on-screen back / close / "done"
 * control follows it instead — if a button jumped somewhere else (or pushed a
 * new page), the button and the swipe would land on different screens. With no
 * in-app page behind this one, go to `fallback` instead, replacing this entry.
 */
export function useGoBack(fallback: string): () => void {
  const navigate = useNavigate()
  return useCallback(() => {
    if (historyDepth() > 0) navigate(-1)
    else navigate(fallback, { replace: true })
  }, [navigate, fallback])
}

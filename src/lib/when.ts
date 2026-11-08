/** "just now", "12 min ago", "3 h ago", then the date ("Nov 7") — how long ago
 * something happened, at a glance. Used by the import list and the feedback
 * inbox. */
export function agoText(at: number | null, now: number): string {
  if (!at) return ''
  const min = Math.round((now - at) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} h ago`
  return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** A heart glyph — filled when active, otherwise a stroked outline. Draws from
 * the current text colour, so callers set the colour with a text-* class. Used
 * by the favorite button/indicator on cards, the recipe reader, and the list's
 * "favorites only" filter toggle. */
export default function HeartIcon({
  filled,
  className = 'size-6',
}: {
  filled: boolean
  className?: string
}) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill={filled ? 'currentColor' : 'none'} aria-hidden="true">
      <path
        d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  )
}

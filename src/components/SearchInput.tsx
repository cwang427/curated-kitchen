import { useRef } from 'react'

interface Props {
  value: string
  onChange: (value: string) => void
  placeholder: string
  label: string
}

/**
 * A search box with a ✕ on the right to clear it once there's text — the usual
 * single-line field behaviour. (The browser's own clear button is hidden in
 * index.css: iOS doesn't show one, and it's too small to hit with wet hands.)
 */
export default function SearchInput({ value, onChange, placeholder, label }: Props) {
  const input = useRef<HTMLInputElement>(null)
  const wasTyping = useRef(false)
  return (
    <div className="relative">
      <input
        ref={input}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        enterKeyHint="search"
        className="min-h-12 w-full rounded-xl border border-line bg-card pl-4 pr-12 text-base outline-none placeholder:text-ink-faint focus:border-accent"
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          // If you were typing, the keyboard stays up for the next search; if
          // you weren't, clearing doesn't pop it up. (Holding focus on press
          // isn't reliable on iOS, so refocus after clearing as well.)
          onPointerDown={(event) => {
            wasTyping.current = document.activeElement === input.current
            event.preventDefault()
          }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onChange('')
            if (wasTyping.current) input.current?.focus()
          }}
          className="absolute inset-y-0 right-0 grid w-12 place-items-center text-ink-faint transition active:text-ink"
        >
          <span className="grid size-6 place-items-center rounded-full bg-line">
            <svg viewBox="0 0 24 24" className="size-3.5" fill="none" aria-hidden="true">
              <path d="M7 7l10 10M17 7L7 17" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
            </svg>
          </span>
        </button>
      )}
    </div>
  )
}

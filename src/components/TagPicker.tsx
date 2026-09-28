import { TAG_GROUPS, droppedTags, normalizeTags } from '../lib/tags'

interface Props {
  /** The draft's tags, comma-separated (how the draft holds them). */
  value: string
  onChange: (value: string) => void
}

const split = (value: string) =>
  value
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)

/**
 * Tags are picked from the fixed list (lib/tags.ts), grouped the way the
 * kitchen is browsed, instead of typed — so every recipe's tags line up with
 * the kitchen's filters. An older recipe's other tags are listed underneath;
 * they're dropped when the recipe is saved.
 */
export default function TagPicker({ value, onChange }: Props) {
  const raw = split(value)
  const selected = new Set(normalizeTags(raw))
  const legacy = droppedTags(raw)

  const toggle = (tag: string) => {
    const next = new Set(selected)
    if (next.has(tag)) next.delete(tag)
    else next.add(tag)
    // Keep the old tags in the draft until save, so the note below stays true.
    onChange([...normalizeTags([...next]), ...legacy].join(', '))
  }

  return (
    <fieldset className="space-y-3">
      <legend className="mb-1 block text-sm text-ink-soft">Tags</legend>
      {TAG_GROUPS.map((group) => (
        <div key={group.key}>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">{group.label}</p>
          <div className="flex flex-wrap gap-2">
            {group.tags.map((tag) => {
              const on = selected.has(tag)
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => toggle(tag)}
                  aria-pressed={on}
                  className={`min-h-10 rounded-full border px-3.5 text-sm transition ${
                    on
                      ? 'border-accent bg-accent text-white dark:text-stone-900'
                      : 'border-line bg-card text-ink-soft'
                  }`}
                >
                  {tag}
                </button>
              )
            })}
          </div>
        </div>
      ))}
      {legacy.length > 0 && (
        <p className="text-sm text-ink-faint">
          Older tags not on the list, removed when you save: {legacy.join(', ')}
        </p>
      )}
    </fieldset>
  )
}

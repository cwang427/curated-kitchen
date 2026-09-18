import { SCALE_PRESETS, formatQuantity } from '../lib/quantity'
import type { RecipeYield } from '../lib/types'

interface Props {
  scale: number
  onChange: (scale: number) => void
  recipeYield: RecipeYield
}

export default function ScaleControl({ scale, onChange, recipeYield }: Props) {
  const amount = formatQuantity(recipeYield.amount * scale, null)
  const amountMax =
    recipeYield.amountMax === null
      ? null
      : formatQuantity(recipeYield.amountMax * scale, null)

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div
        role="group"
        aria-label="Scale recipe"
        className="flex overflow-hidden rounded-full border border-line bg-card"
      >
        {SCALE_PRESETS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => onChange(value)}
            aria-pressed={scale === value}
            className={`min-h-11 min-w-12 px-3 text-sm font-medium transition ${
              scale === value
                ? 'bg-accent text-white dark:text-stone-900'
                : 'text-ink-soft active:bg-accent-soft'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <p className="text-sm text-ink-soft" aria-live="polite">
        Makes{' '}
        <span className="font-medium text-ink">
          {amountMax ? `${amount}–${amountMax}` : amount} {recipeYield.unit}
        </span>
      </p>
    </div>
  )
}

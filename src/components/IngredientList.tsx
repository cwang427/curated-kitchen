import { formatIngredient } from '../lib/quantity'
import type { Ingredient } from '../lib/types'

interface Props {
  ingredients: Ingredient[]
  groups: string[]
  scale: number
}

// Bulleted like the Equipment list, with the bullet hanging outside so a
// long line wraps under its text, not under the dot. No checkboxes: gathering
// has cook mode's per-step checklist, and shopping the "Add to grocery list"
// picker.
const LIST = 'list-disc space-y-2 pl-6 marker:text-ink-faint'

function IngredientRow({ ingredient, scale }: { ingredient: Ingredient; scale: number }) {
  const formatted = formatIngredient(ingredient, scale)

  return (
    <li className="pl-1">
      <span>
        {formatted.quantity && (
          <span className="font-medium tabular-nums">
            {formatted.quantity}
            {formatted.unit ? ` ${formatted.unit}` : ''}{' '}
          </span>
        )}
        <span>{formatted.item}</span>
        {formatted.prep && <span className="text-ink-soft">, {formatted.prep}</span>}
        {formatted.note && (
          <span className="text-ink-faint"> ({formatted.note})</span>
        )}
        {formatted.optional && (
          <span className="text-ink-faint italic"> — optional</span>
        )}
      </span>
    </li>
  )
}

export default function IngredientList({ ingredients, groups, scale }: Props) {
  // Ungrouped ingredients come first, then each declared group in order.
  const ungrouped = ingredients.filter((i) => !i.group)
  const sections = groups
    .map((group) => ({ group, items: ingredients.filter((i) => i.group === group) }))
    .filter((section) => section.items.length > 0)

  return (
    <div className="space-y-5">
      {ungrouped.length > 0 && (
        <ul className={LIST}>
          {ungrouped.map((ingredient) => (
            <IngredientRow key={ingredient.id} ingredient={ingredient} scale={scale} />
          ))}
        </ul>
      )}

      {sections.map(({ group, items }) => (
        <div key={group}>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-faint">
            {group}
          </h3>
          <ul className={LIST}>
            {items.map((ingredient) => (
              <IngredientRow key={ingredient.id} ingredient={ingredient} scale={scale} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

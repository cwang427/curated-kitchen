import { formatIngredient } from '../lib/quantity'
import type { Ingredient } from '../lib/types'

interface Props {
  ingredients: Ingredient[]
  groups: string[]
  scale: number
  /** Ingredient ids to highlight — used when a step is focused. */
  highlighted?: Set<string>
}

function IngredientRow({
  ingredient,
  scale,
  highlighted,
}: {
  ingredient: Ingredient
  scale: number
  highlighted: boolean
}) {
  const formatted = formatIngredient(ingredient, scale)

  return (
    // A plain list: gathering has cook mode's per-step checklist, and shopping
    // has the "Add to grocery list" picker.
    <li className={`rounded-lg px-2 py-1.5 transition ${highlighted ? 'bg-accent-soft' : ''}`}>
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

export default function IngredientList({
  ingredients,
  groups,
  scale,
  highlighted,
}: Props) {
  // Ungrouped ingredients come first, then each declared group in order.
  const ungrouped = ingredients.filter((i) => !i.group)
  const sections = groups
    .map((group) => ({ group, items: ingredients.filter((i) => i.group === group) }))
    .filter((section) => section.items.length > 0)

  return (
    <div className="space-y-5">
      {ungrouped.length > 0 && (
        <ul className="-mx-2">
          {ungrouped.map((ingredient) => (
            <IngredientRow
              key={ingredient.id}
              ingredient={ingredient}
              scale={scale}
              highlighted={highlighted?.has(ingredient.id) ?? false}
            />
          ))}
        </ul>
      )}

      {sections.map(({ group, items }) => (
        <div key={group}>
          <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-ink-faint">
            {group}
          </h3>
          <ul className="-mx-2">
            {items.map((ingredient) => (
              <IngredientRow
                key={ingredient.id}
                ingredient={ingredient}
                scale={scale}
                highlighted={highlighted?.has(ingredient.id) ?? false}
              />
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

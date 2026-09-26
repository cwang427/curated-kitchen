import { useEffect, useMemo, useState, type FormEvent } from 'react'
import AppHeader from '../components/AppHeader'
import { useAuth } from '../auth/AuthProvider'
import { addToList, clearChecked, removeItem, toggleItem, useGroceryList } from '../data/grocery'
import { categoryLabel, formatGroceryAmount, groupByAisle, parseQuickAdd } from '../lib/grocery'
import { GROCERY_CATEGORIES, type GroceryCategory, type GroceryItem } from '../lib/types'

function ItemRow({
  item,
  householdId,
}: {
  item: GroceryItem
  householdId: string
}) {
  const amount = formatGroceryAmount(item)
  return (
    <li className="group flex items-center gap-3">
      <label className="flex min-h-12 flex-1 cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          checked={item.checked}
          onChange={() => toggleItem(householdId, item.id, !item.checked)}
          className="size-5 shrink-0 accent-[var(--check)]"
        />
        <span className={item.checked ? 'text-ink-faint line-through' : ''}>
          {amount && <span className="font-medium tabular-nums">{amount} </span>}
          {item.name}
          {item.note && <span className="text-ink-faint"> · {item.note}</span>}
        </span>
      </label>
      <button
        type="button"
        onClick={() => removeItem(householdId, item.id)}
        aria-label={`Remove ${item.name}`}
        className="grid size-9 shrink-0 place-items-center rounded-full text-ink-faint transition active:bg-line"
      >
        <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
    </li>
  )
}

export default function GroceryListPage() {
  const { user, household } = useAuth()
  const householdId = household?.id ?? null
  const { items, loading, error } = useGroceryList(householdId)

  const [name, setName] = useState('')
  const [category, setCategory] = useState<GroceryCategory>('produce')
  // Once you pick an aisle by hand, stop auto-guessing it from the text.
  const [aisleTouched, setAisleTouched] = useState(false)
  const [adding, setAdding] = useState(false)

  const parsed = useMemo(() => parseQuickAdd(name), [name])

  // Let the aisle follow the parsed guess as you type, until you override it.
  useEffect(() => {
    if (!aisleTouched && parsed) setCategory(parsed.category)
  }, [parsed, aisleTouched])

  if (!user || !household || !householdId) return null

  const unchecked = items.filter((i) => !i.checked)
  const checked = items.filter((i) => i.checked)
  const aisles = groupByAisle(unchecked)

  const onAdd = async (event: FormEvent) => {
    event.preventDefault()
    if (!parsed || adding) return
    setAdding(true)
    try {
      // Use the parsed quantity/unit/name, with the (possibly overridden) aisle.
      await addToList(householdId, user.uid, [{ ...parsed, category }])
      setName('')
      setAisleTouched(false)
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="min-h-dvh">
      <AppHeader title="Groceries" back />

      <main className="pad-safe-bottom mx-auto max-w-3xl px-4 py-4">
        {/* Quick add — separated from the list below so it doesn't read as a
            filter. The aisle is guessed from what you type and only appears as
            an override once there's something to add. */}
        <form onSubmit={onAdd} className="border-b border-line pb-4">
          <div className="flex gap-2">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Add an item — e.g. 2 lemons, milk…"
              aria-label="Add an item"
              autoCapitalize="none"
              className="min-h-12 min-w-0 flex-1 rounded-xl border border-line bg-card px-4 text-base outline-none placeholder:text-ink-faint focus:border-accent"
            />
            <button
              type="submit"
              disabled={!parsed || adding}
              className="min-h-12 shrink-0 rounded-xl bg-accent px-5 text-sm font-semibold text-white transition active:scale-[0.98] disabled:opacity-50 dark:text-stone-900"
            >
              Add
            </button>
          </div>

          {parsed && (
            <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-ink-faint">
              <span>
                Adding{' '}
                <span className="font-medium text-ink-soft">
                  {[
                    formatGroceryAmount({
                      id: '', name: '', canonical: '', quantity: parsed.quantity,
                      quantityMax: parsed.quantityMax, unit: parsed.unit, category, checked: false,
                      note: null, addedBy: null, createdAt: null, updatedAt: null,
                    }),
                    parsed.name,
                  ]
                    .filter(Boolean)
                    .join(' ')}
                </span>{' '}
                to
              </span>
              <select
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value as GroceryCategory)
                  setAisleTouched(true)
                }}
                aria-label="Aisle"
                className="rounded-lg border border-line bg-card px-2 py-1 text-sm text-ink-soft outline-none focus:border-accent"
              >
                {GROCERY_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {categoryLabel(c)}
                  </option>
                ))}
              </select>
            </div>
          )}
        </form>

        {error && (
          <p role="alert" className="mt-4 text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        {loading && <p className="mt-10 text-center text-ink-faint">Loading…</p>}

        {!loading && items.length === 0 && (
          <div className="mt-16 space-y-2 text-center">
            <p className="font-serif text-xl">Nothing on the list yet</p>
            <p className="mx-auto max-w-sm text-balance text-sm text-ink-soft">
              Add an item above, or open a recipe and tap <strong>Add to grocery list</strong>.
            </p>
          </div>
        )}

        {/* Aisles */}
        <div className="mt-5 space-y-6">
          {aisles.map((aisle) => (
            <section key={aisle.category}>
              <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-ink-faint">
                {aisle.label}
              </h2>
              <ul className="divide-y divide-line">
                {aisle.items.map((item) => (
                  <ItemRow key={item.id} item={item} householdId={householdId} />
                ))}
              </ul>
            </section>
          ))}
        </div>

        {/* Checked-off */}
        {checked.length > 0 && (
          <section className="mt-8">
            <div className="mb-1 flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-faint">
                In the cart ({checked.length})
              </h2>
              <button
                type="button"
                onClick={() => clearChecked(householdId)}
                className="text-sm text-accent underline underline-offset-2"
              >
                Clear
              </button>
            </div>
            <ul className="divide-y divide-line opacity-70">
              {checked.map((item) => (
                <ItemRow key={item.id} item={item} householdId={householdId} />
              ))}
            </ul>
          </section>
        )}
      </main>
    </div>
  )
}

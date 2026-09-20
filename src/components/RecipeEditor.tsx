import { useState, type ChangeEvent, type ReactNode } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { createRecipeInHousehold, updateRecipe } from '../data/recipes'
import { uploadStepPhoto } from '../data/photos'
import { parseRecipe } from '../lib/recipeSchema'
import { slugify } from '../lib/importRecipe'
import { categoryLabel } from '../lib/grocery'
import {
  blankIngredient,
  blankStep,
  draftToInput,
  seedToDraft,
  blankDraft,
  type DraftIngredient,
  type DraftStep,
  type RecipeDraft,
} from '../lib/recipeDraft'
import { GROCERY_CATEGORIES, type RecipeSeed, type Visibility } from '../lib/types'

const input =
  'min-h-11 w-full rounded-xl border border-line bg-card px-3 text-base outline-none focus:border-accent'
const small = 'min-h-11 rounded-xl border border-line bg-card px-2 text-base outline-none focus:border-accent'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-faint">{title}</h2>
      {children}
    </section>
  )
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm text-ink-soft">{label}</span>
      {children}
    </label>
  )
}

function move<T>(arr: T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir
  if (j < 0 || j >= arr.length) return arr
  const next = arr.slice()
  ;[next[i], next[j]] = [next[j], next[i]]
  return next
}

function RowControls({
  onUp, onDown, onRemove, canRemove,
}: { onUp: () => void; onDown: () => void; onRemove: () => void; canRemove: boolean }) {
  const btn = 'grid size-9 place-items-center rounded-full border border-line text-ink-soft transition active:bg-line'
  return (
    <div className="flex items-center gap-2">
      <button type="button" onClick={onUp} aria-label="Move up" className={btn}>↑</button>
      <button type="button" onClick={onDown} aria-label="Move down" className={btn}>↓</button>
      <button
        type="button"
        onClick={onRemove}
        disabled={!canRemove}
        aria-label="Remove"
        className="grid size-9 place-items-center rounded-full border border-red-300 text-red-600 transition active:bg-line disabled:opacity-30 dark:border-red-900 dark:text-red-400"
      >
        <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}

/**
 * Edit a recipe (overall details, the ingredient list, and each step's full
 * text + the concise cook-mode "brief"), then validate against the same schema
 * CI uses and save it. Three ways in: the ingestion preview, starting from
 * scratch, and editing an existing recipe in place. When `editingSlug` is set,
 * saving updates that recipe (its slug/URL never changes); otherwise it mints a
 * fresh slug and creates a new app recipe.
 */
export default function RecipeEditor({
  initial,
  editingSlug = null,
  onSaved,
  onCancel,
}: {
  initial: RecipeSeed | null
  /** The slug of an existing recipe to update in place, or null to create new. */
  editingSlug?: string | null
  onSaved: (slug: string) => void
  onCancel: () => void
}) {
  const { user, household } = useAuth()
  const [draft, setDraft] = useState<RecipeDraft>(() => (initial ? seedToDraft(initial) : blankDraft()))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Which step is mid-upload (its id), and any photo error to surface.
  const [uploadingStep, setUploadingStep] = useState<string | null>(null)
  const [photoError, setPhotoError] = useState<string | null>(null)

  const set = (patch: Partial<RecipeDraft>) => setDraft((d) => ({ ...d, ...patch }))
  const patchIng = (i: number, patch: Partial<DraftIngredient>) =>
    setDraft((d) => ({ ...d, ingredients: d.ingredients.map((x, k) => (k === i ? { ...x, ...patch } : x)) }))
  const patchStep = (i: number, patch: Partial<DraftStep>) =>
    setDraft((d) => ({ ...d, steps: d.steps.map((x, k) => (k === i ? { ...x, ...patch } : x)) }))

  const addPhoto = async (i: number, e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // let the same file be re-picked after a remove
    if (!file || !household) return
    const step = draft.steps[i]
    if (step.images.length >= 3) return
    setPhotoError(null)
    setUploadingStep(step.id)
    try {
      const url = await uploadStepPhoto(household.id, step.id, file)
      // Re-find the step by id — its index may have shifted during the upload.
      setDraft((d) => ({
        ...d,
        steps: d.steps.map((s) => (s.id === step.id ? { ...s, images: [...s.images, url] } : s)),
      }))
    } catch (cause) {
      setPhotoError(cause instanceof Error ? cause.message : 'Couldn’t add that photo.')
    } finally {
      setUploadingStep(null)
    }
  }

  const removePhoto = (stepId: string, url: string) => {
    // Only drop the reference from this recipe — never delete the Storage file.
    // A copied recipe shares the same file, so deleting it here would blank the
    // photo on the original (or other copies) too. Leaving the file is the safe
    // choice (and matches recipe deletion, which also doesn't touch Storage);
    // unreferenced files just orphan, which is cheap for a kitchen this size.
    setDraft((d) => ({
      ...d,
      steps: d.steps.map((s) => (s.id === stepId ? { ...s, images: s.images.filter((u) => u !== url) } : s)),
    }))
  }

  if (!user || !household) return null

  const save = async () => {
    setError(null)
    setSaving(true)
    try {
      // Editing keeps the existing slug (the doc id / URL is stable); a new
      // recipe mints one from the title.
      const slug =
        editingSlug ?? `${slugify(draft.title) || 'recipe'}-${Math.random().toString(36).slice(2, 7)}`
      const { recipe } = parseRecipe({ ...draftToInput(draft), slug })
      const saved = editingSlug
        ? await updateRecipe(recipe)
        : await createRecipeInHousehold(recipe, household.id, user.uid)
      onSaved(saved)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t save — check the fields above.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-7 pb-28">
      <Section title="Details">
        <Labeled label="Title">
          <input className={input} value={draft.title} onChange={(e) => set({ title: e.target.value })} />
        </Labeled>
        <Labeled label="Subtitle">
          <input className={input} value={draft.subtitle} onChange={(e) => set({ subtitle: e.target.value })} />
        </Labeled>
        <Labeled label="Description">
          <textarea className={`${input} min-h-20`} value={draft.description} onChange={(e) => set({ description: e.target.value })} />
        </Labeled>

        <div className="grid grid-cols-2 gap-3">
          <Labeled label="Servings"><input className={input} inputMode="numeric" value={draft.yieldAmount} onChange={(e) => set({ yieldAmount: e.target.value })} /></Labeled>
          <Labeled label="Serving unit"><input className={input} value={draft.yieldUnit} onChange={(e) => set({ yieldUnit: e.target.value })} placeholder="servings" /></Labeled>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Labeled label="Prep (min)"><input className={input} inputMode="numeric" value={draft.prepMin} onChange={(e) => set({ prepMin: e.target.value })} /></Labeled>
          <Labeled label="Cook (min)"><input className={input} inputMode="numeric" value={draft.cookMin} onChange={(e) => set({ cookMin: e.target.value })} /></Labeled>
          <Labeled label="Total (min)"><input className={input} inputMode="numeric" value={draft.totalMin} onChange={(e) => set({ totalMin: e.target.value })} /></Labeled>
          <Labeled label="Active (min)"><input className={input} inputMode="numeric" value={draft.activeMin} onChange={(e) => set({ activeMin: e.target.value })} /></Labeled>
        </div>

        <Labeled label="Source (name)"><input className={input} value={draft.sourceName} onChange={(e) => set({ sourceName: e.target.value })} placeholder="e.g. Serious Eats" /></Labeled>
        <div className="grid grid-cols-2 gap-3">
          <Labeled label="Author"><input className={input} value={draft.sourceAuthor} onChange={(e) => set({ sourceAuthor: e.target.value })} /></Labeled>
          <Labeled label="Link"><input className={input} value={draft.sourceUrl} onChange={(e) => set({ sourceUrl: e.target.value })} placeholder="https://…" /></Labeled>
        </div>

        <Labeled label="Tags (comma-separated)"><input className={input} value={draft.tags} onChange={(e) => set({ tags: e.target.value })} placeholder="weeknight, pasta" /></Labeled>
        <Labeled label="Who can see it">
          <select className={input} value={draft.visibility} onChange={(e) => set({ visibility: e.target.value as Visibility })}>
            <option value="friends">Everyone in this kitchen (members + guests)</option>
            <option value="household">Members only (hide from guests)</option>
          </select>
        </Labeled>
      </Section>

      <Section title="Ingredients">
        {draft.ingredients.map((ing, i) => (
          <div key={ing.id} className="space-y-2 rounded-2xl border border-line bg-card p-3">
            <div className="flex items-start justify-between gap-2">
              <input
                className={`${input} flex-1`}
                value={ing.item}
                onChange={(e) => patchIng(i, { item: e.target.value })}
                placeholder="Ingredient, e.g. yellow onion"
              />
            </div>
            <div className="grid grid-cols-[3.5rem_4.5rem_1fr] gap-2">
              <input className={small} inputMode="text" value={ing.quantity} onChange={(e) => patchIng(i, { quantity: e.target.value })} placeholder="Qty" aria-label="Quantity" />
              <input className={small} value={ing.unit} onChange={(e) => patchIng(i, { unit: e.target.value })} placeholder="Unit" aria-label="Unit" />
              <select className={small} value={ing.category} onChange={(e) => patchIng(i, { category: e.target.value as DraftIngredient['category'] })} aria-label="Aisle">
                {GROCERY_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{categoryLabel(c)}</option>
                ))}
              </select>
            </div>
            <input className={input} value={ing.prep} onChange={(e) => patchIng(i, { prep: e.target.value })} placeholder="Prep, e.g. finely diced (optional)" />
            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <div className="flex gap-4 text-sm text-ink-soft">
                <label className="flex items-center gap-1.5"><input type="checkbox" className="size-4 accent-[var(--accent)]" checked={ing.scalable} onChange={(e) => patchIng(i, { scalable: e.target.checked })} /> scales</label>
                <label className="flex items-center gap-1.5"><input type="checkbox" className="size-4 accent-[var(--accent)]" checked={ing.optional} onChange={(e) => patchIng(i, { optional: e.target.checked })} /> optional</label>
              </div>
              <RowControls
                canRemove={draft.ingredients.length > 1}
                onUp={() => set({ ingredients: move(draft.ingredients, i, -1) })}
                onDown={() => set({ ingredients: move(draft.ingredients, i, 1) })}
                onRemove={() => set({ ingredients: draft.ingredients.filter((_, k) => k !== i) })}
              />
            </div>
          </div>
        ))}
        <button
          type="button"
          onClick={() => set({ ingredients: [...draft.ingredients, blankIngredient()] })}
          className="text-sm font-medium text-accent underline underline-offset-2"
        >
          ＋ Add ingredient
        </button>
      </Section>

      <Section title="Steps">
        {draft.steps.map((step, i) => (
          <div key={step.id} className="space-y-2 rounded-2xl border border-line bg-card p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-ink-faint">Step {i + 1}</span>
              <RowControls
                canRemove={draft.steps.length > 1}
                onUp={() => set({ steps: move(draft.steps, i, -1) })}
                onDown={() => set({ steps: move(draft.steps, i, 1) })}
                onRemove={() => set({ steps: draft.steps.filter((_, k) => k !== i) })}
              />
            </div>
            <textarea
              className={`${input} min-h-24`}
              value={step.text}
              onChange={(e) => patchStep(i, { text: e.target.value })}
              placeholder="Full instructions. Wrap amounts that scale in {{ }}, e.g. Add {{2 tbsp}} butter."
            />
            <Labeled label="Cook-mode bullets — one per line (optional)">
              <textarea
                className={`${input} min-h-20`}
                value={step.brief}
                onChange={(e) => patchStep(i, { brief: e.target.value })}
                placeholder="A short, one-action-per-line version shown while cooking."
              />
            </Labeled>

            {/* Photos: up to 3 per step, shown in the reader and cook mode. */}
            <div>
              <span className="mb-1 block text-sm text-ink-soft">Photos — up to 3 (optional)</span>
              <div className="flex flex-wrap gap-2">
                {step.images.map((url) => (
                  <div key={url} className="relative size-20 overflow-hidden rounded-xl border border-line">
                    <img src={url} alt="" className="size-full object-cover" />
                    <button
                      type="button"
                      onClick={() => removePhoto(step.id, url)}
                      aria-label="Remove photo"
                      className="absolute right-1 top-1 grid size-6 place-items-center rounded-full bg-black/60 text-white"
                    >
                      <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden="true">
                        <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                      </svg>
                    </button>
                  </div>
                ))}
                {step.images.length < 3 && (
                  <label
                    className={`grid size-20 cursor-pointer place-items-center rounded-xl border border-dashed border-line text-center text-xs text-ink-soft ${
                      uploadingStep === step.id ? 'opacity-50' : ''
                    }`}
                  >
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => addPhoto(i, e)}
                      disabled={uploadingStep === step.id}
                      className="hidden"
                    />
                    {uploadingStep === step.id ? 'Adding…' : '＋ Photo'}
                  </label>
                )}
              </div>
            </div>
          </div>
        ))}
        {photoError && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {photoError}
          </p>
        )}
        <button
          type="button"
          onClick={() => set({ steps: [...draft.steps, blankStep()] })}
          className="text-sm font-medium text-accent underline underline-offset-2"
        >
          ＋ Add step
        </button>
      </Section>

      <Section title="More">
        <Labeled label="Equipment — one per line"><textarea className={`${input} min-h-20`} value={draft.equipment} onChange={(e) => set({ equipment: e.target.value })} /></Labeled>
        <Labeled label="Notes — one per line"><textarea className={`${input} min-h-20`} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} /></Labeled>
      </Section>

      {/* Sticky save bar */}
      <div className="pad-safe-bottom fixed inset-x-0 bottom-0 border-t border-line bg-paper/95 px-4 pt-3 backdrop-blur">
        {error && (
          <p role="alert" className="mx-auto mb-2 max-w-3xl text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <div className="mx-auto flex max-w-3xl gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="grid h-12 flex-1 place-items-center rounded-2xl border border-line text-base font-semibold text-ink-soft transition active:scale-[0.99] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || !draft.title.trim()}
            className="grid h-12 flex-[1.4] place-items-center rounded-2xl bg-accent text-base font-semibold text-white transition active:scale-[0.99] disabled:opacity-50 dark:text-stone-900"
          >
            {saving ? 'Saving…' : editingSlug ? 'Save changes' : 'Save recipe'}
          </button>
        </div>
      </div>
    </div>
  )
}

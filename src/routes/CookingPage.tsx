import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import { useAuth } from '../auth/AuthProvider'
import { useRecipes } from '../data/recipes'
import { clearBoard, useCookBoard } from '../data/cookBoard'
import { useCookSession } from '../data/cooksession'
import { buildTimeline, type AgendaItem } from '../lib/cookboard'
import { formatStepQuantity, parseStepText, splitStepText } from '../lib/quantity'
import type { Recipe } from '../lib/types'

/* ---------------------------------------------------------------- *
 * Cooking now — the multi-dish timeline
 *
 * A coordination view over everything you're cooking at once on this device. It
 * reads only what's real: where you are in each dish and its running timers
 * (which carry a wall-clock end time). So it can say truthfully which dishes have
 * nothing counting down and need you now, and exactly when each timer will ring —
 * a compact strip for the glance, an "Up next" list for the doing. It does not
 * predict the future shape of steps you haven't reached; that needs per-step
 * durations (a later phase). Cook-together (two phones, one recipe) is separate
 * and shown only as a link.
 * ---------------------------------------------------------------- */

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const m = Math.floor(s / 60)
  const rem = s % 60
  return `${m}:${rem.toString().padStart(2, '0')}`
}

/** Timer labels carry a " · Recipe" suffix; drop it where the dish is already named. */
function shortLabel(label: string): string {
  return label.split(' · ')[0]
}

/** One line of step prose with its {{ }} amounts scaled. */
function StepText({ line, scale }: { line: string; scale: number }) {
  return (
    <>
      {parseStepText(line).map((seg, i) =>
        seg.type === 'text' ? (
          <span key={i}>{seg.value}</span>
        ) : (
          <strong key={i} className="font-semibold tabular-nums">
            {formatStepQuantity(seg, scale)}
          </strong>
        ),
      )}
    </>
  )
}

/** The first cook-mode line of a dish's current step, or null. */
function currentLine(recipe: Recipe | undefined, stepIndex: number): string | null {
  if (!recipe || recipe.steps.length === 0) return null
  const step = recipe.steps[Math.min(stepIndex, recipe.steps.length - 1)]
  const lines = step.brief && step.brief.length > 0 ? step.brief : splitStepText(step.text)
  return lines[0] ?? step.text
}

export default function CookingPage() {
  const navigate = useNavigate()
  const { household } = useAuth()
  const householdId = household?.id ?? null
  const { recipes } = useRecipes(householdId)
  const { session } = useCookSession(householdId)
  const board = useCookBoard()

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [])

  const recipeBySlug = useMemo(() => new Map(recipes.map((r) => [r.slug, r] as const)), [recipes])
  const scaleBySlug = useMemo(
    () => new Map(board.dishes.map((d) => [d.slug, d.scale] as const)),
    [board.dishes],
  )
  const timeline = useMemo(() => buildTimeline(board.dishes, now), [board.dishes, now])

  const cookHref = (slug: string) => `/r/${slug}/cook?x=${scaleBySlug.get(slug) ?? 1}`

  // Strip window: round the furthest live timer up to a friendly 5-minute mark.
  const horizonMin = timeline.horizonMs ? Math.max(5, Math.ceil(timeline.horizonMs / 60000 / 5) * 5) : 0
  const horizonMs = horizonMin * 60000

  const attentionCount = timeline.statuses.filter((s) => s.attention).length
  const soonest = timeline.statuses
    .map((s) => s.soonestEndsAt)
    .filter((e): e is number => e !== null)
    .sort((a, b) => a - b)[0]

  const empty = board.dishes.length === 0

  return (
    <div className="min-h-dvh">
      <AppHeader title="Cooking now" back cart />

      <main className="pad-safe-bottom mx-auto max-w-3xl px-4 py-4">
        {/* Two-phone cook-together is a separate mode; surface it as a link. */}
        {session && (
          <Link
            to={`/r/${session.recipeSlug}/cook?x=${session.scale}`}
            className="mb-3 flex items-center gap-2 rounded-xl border border-line bg-card px-4 py-2.5 text-sm text-ink-soft transition active:scale-[0.99]"
          >
            <span aria-hidden="true">⇄</span>
            <span className="min-w-0 flex-1 truncate">
              Cooking together — <span className="font-medium text-ink">{session.recipeTitle}</span>
            </span>
            <span aria-hidden="true">›</span>
          </Link>
        )}

        {empty ? (
          <div className="mt-16 space-y-3 text-center">
            <p className="font-serif text-xl">Nothing cooking right now</p>
            <p className="mx-auto max-w-sm text-balance text-sm text-ink-soft">
              Start a recipe and it shows up here. Cook a few at once — the ribs, the rice, the
              beans — and this timeline keeps them all in view.
            </p>
            <Link
              to="/"
              className="inline-grid h-12 place-items-center rounded-2xl bg-accent px-6 text-base font-semibold text-white dark:text-stone-900"
            >
              Browse recipes
            </Link>
          </div>
        ) : (
          <>
            {/* A one-line read on the whole session. */}
            <p className="mb-3 text-sm text-ink-soft">
              {board.dishes.length} {board.dishes.length === 1 ? 'dish' : 'dishes'} cooking
              {attentionCount > 0 && (
                <>
                  {' · '}
                  <span className="font-semibold text-accent">
                    {attentionCount} need{attentionCount === 1 ? 's' : ''} you now
                  </span>
                </>
              )}
              {attentionCount === 0 && soonest && (
                <> · next check-in {clock((soonest - now) / 1000)}</>
              )}
            </p>

            {/* The strip: one lane per dish, only meaningful while a timer runs. */}
            {timeline.horizonMs !== null && (
              <div className="rounded-2xl border border-line bg-card p-3">
                <div className="mb-1 flex justify-between pl-24 text-xs text-ink-faint">
                  <span>now</span>
                  {horizonMin >= 10 && <span>+{Math.round(horizonMin / 2)}m</span>}
                  <span>+{horizonMin}m</span>
                </div>

                <div className="space-y-1.5">
                  {timeline.statuses.map((s) => {
                    const live = s.running.filter((t) => !t.done)
                    const rang = s.running.some((t) => t.done)
                    const stepCount = recipeBySlug.get(s.slug)?.steps.length
                    const barFrac = live[0] ? Math.min(1, (live[0].endsAt - now) / horizonMs) : 0
                    return (
                      <Link key={s.slug} to={cookHref(s.slug)} className="flex items-center gap-2">
                        <span className="w-24 shrink-0 pr-1">
                          <span className="block truncate text-sm leading-tight">{s.title}</span>
                          <span className="block text-xs text-ink-faint">
                            step {s.stepIndex + 1}
                            {stepCount ? `/${stepCount}` : ''}
                          </span>
                        </span>
                        <span className="relative h-7 flex-1 overflow-hidden rounded-lg bg-paper">
                          {/* "now" edge */}
                          <span className="absolute inset-y-0 left-0 w-0.5 bg-accent/40" aria-hidden="true" />
                          {live[0] && (
                            <span
                              className="absolute inset-y-0 left-0 flex items-center rounded-lg border border-accent/40 bg-accent-soft pl-2 text-xs text-accent"
                              style={{ width: `${Math.max(barFrac * 100, 12)}%` }}
                            >
                              <span className="truncate">
                                {shortLabel(live[0].label)} {clock(live[0].secondsLeft)}
                              </span>
                            </span>
                          )}
                          {/* Extra concurrent timers as end-cap dots. */}
                          {live.slice(1).map((t) => (
                            <span
                              key={t.id}
                              className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-accent bg-card"
                              style={{ left: `${Math.min(100, ((t.endsAt - now) / horizonMs) * 100)}%` }}
                              aria-hidden="true"
                            />
                          ))}
                          {rang && (
                            <span className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-white dark:text-stone-900">
                               up
                            </span>
                          )}
                          {live.length === 0 && !rang && (
                            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs font-medium text-accent">
                              hands-on
                            </span>
                          )}
                        </span>
                      </Link>
                    )
                  })}
                </div>

                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 pl-24 text-xs text-ink-faint">
                  <span>
                    <span className="mr-1 inline-block size-2.5 rounded-sm border border-accent/40 bg-accent-soft align-[-1px]" />
                    a timer running
                  </span>
                  <span>
                    <span className="mr-1 inline-block size-2.5 rounded-full bg-accent align-[-1px]" />
                    needs you now
                  </span>
                </div>
              </div>
            )}

            {/* Up next: the actual to-do surface, merged and time-sorted. */}
            <h2 className="mb-2 mt-6 text-sm font-semibold uppercase tracking-wide text-ink-faint">
              Up next
            </h2>
            <ul className="space-y-2">
              {timeline.agenda.map((item) => (
                <AgendaRow
                  key={item.key}
                  item={item}
                  now={now}
                  recipe={recipeBySlug.get(item.dishSlug)}
                  stepIndex={
                    timeline.statuses.find((s) => s.slug === item.dishSlug)?.stepIndex ?? 0
                  }
                  scale={scaleBySlug.get(item.dishSlug) ?? 1}
                  onOpen={() => navigate(cookHref(item.dishSlug))}
                />
              ))}
            </ul>

            <div className="mt-6 flex items-center justify-between">
              <Link
                to="/"
                className="text-sm font-medium text-accent underline underline-offset-2"
              >
                + Cook another recipe
              </Link>
              <button
                type="button"
                onClick={() => {
                  if (confirm('Clear the cooking timeline? This won’t change your recipes.')) {
                    clearBoard()
                  }
                }}
                className="text-sm text-ink-faint underline underline-offset-2"
              >
                Clear all
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  )
}

function AgendaRow({
  item,
  now,
  recipe,
  stepIndex,
  scale,
  onOpen,
}: {
  item: AgendaItem
  now: number
  recipe: Recipe | undefined
  stepIndex: number
  scale: number
  onOpen: () => void
}) {
  const stepCount = recipe?.steps.length
  const stepLabel = stepCount ? `step ${stepIndex + 1}/${stepCount}` : null
  const line = currentLine(recipe, stepIndex)

  // The "when" chip: now for anything needing you, else a live countdown.
  const when =
    item.kind === 'timer' && item.endsAt !== null ? clock((item.endsAt - now) / 1000) : 'now'
  const urgent = item.kind === 'now'

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={`flex w-full items-center gap-3 rounded-2xl border px-3 py-3 text-left transition active:scale-[0.99] ${
          item.done
            ? 'border-accent bg-accent-soft'
            : urgent
              ? 'border-accent/50 bg-card'
              : 'border-line bg-card'
        }`}
      >
        <span className="w-14 shrink-0 text-center">
          <span
            className={`block text-lg font-semibold tabular-nums leading-none ${urgent ? 'text-accent' : ''}`}
          >
            {when}
          </span>
          {item.kind === 'timer' && (
            <span className="mt-0.5 block text-[10px] uppercase tracking-wide text-ink-faint">
              until
            </span>
          )}
        </span>

        <span className="min-w-0 flex-1">
          {item.done ? (
            <>
              <span className="block font-medium">Timer’s up — {shortLabel(item.label)}</span>
              <span className="block truncate text-sm text-ink-soft">{item.dishTitle}</span>
            </>
          ) : item.kind === 'now' ? (
            <>
              <span className="font-medium leading-snug line-clamp-2">
                {line ? <StepText line={line} scale={scale} /> : item.dishTitle}
              </span>
              <span className="block truncate text-sm text-ink-soft">
                {item.dishTitle}
                {stepLabel && ` · ${stepLabel}`}
              </span>
            </>
          ) : (
            <>
              <span className="block font-medium">{item.dishTitle}</span>
              <span className="block truncate text-sm text-ink-soft">
                {shortLabel(item.label)}
                {stepLabel && ` · ${stepLabel}`}
              </span>
            </>
          )}
        </span>

        {item.done ? (
          <span className="shrink-0 rounded-full bg-accent px-2.5 py-1 text-xs font-semibold text-white dark:text-stone-900">
            now
          </span>
        ) : item.kind === 'now' ? (
          <span className="shrink-0 rounded-full bg-accent-soft px-2.5 py-1 text-xs font-semibold text-accent">
            do now
          </span>
        ) : (
          <span className="shrink-0 text-ink-faint" aria-hidden="true">
            ⏱
          </span>
        )}
      </button>
    </li>
  )
}

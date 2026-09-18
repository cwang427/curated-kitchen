import { formatIngredient, formatStepQuantity, parseStepText } from '../lib/quantity'
import type { Ingredient, Step } from '../lib/types'

interface Props {
  steps: Step[]
  ingredients: Ingredient[]
  groups: string[]
  scale: number
  done: Set<string>
  onToggle: (id: string) => void
}

function formatTimer(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`
}

function StepRow({
  step,
  index,
  ingredients,
  scale,
  done,
  onToggle,
}: {
  step: Step
  index: number
  ingredients: Map<string, Ingredient>
  scale: number
  done: boolean
  onToggle: () => void
}) {
  const used = step.ingredientIds
    .map((id) => ingredients.get(id))
    .filter((i): i is Ingredient => i !== undefined)

  return (
    <li className="flex gap-3">
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={done}
        aria-label={`Mark step ${index} ${done ? 'not done' : 'done'}`}
        className={`mt-0.5 grid size-8 shrink-0 place-items-center rounded-full border text-sm font-semibold tabular-nums transition ${
          done
            ? 'border-check bg-check text-white'
            : 'border-line bg-card text-ink-soft'
        }`}
      >
        {done ? '✓' : index}
      </button>

      <div className={`flex-1 space-y-2 pb-2 ${done ? 'opacity-50' : ''}`}>
        <p className="text-[17px] leading-relaxed">
          {parseStepText(step.text).map((segment, i) =>
            segment.type === 'text' ? (
              <span key={i}>{segment.value}</span>
            ) : (
              <strong key={i} className="font-semibold text-accent tabular-nums">
                {formatStepQuantity(segment, scale)}
              </strong>
            ),
          )}
        </p>

        {(used.length > 0 || step.timers.length > 0 || step.temperature) && (
          <div className="flex flex-wrap gap-1.5 text-xs">
            {used.map((ingredient) => {
              const formatted = formatIngredient(ingredient, scale)
              return (
                <span
                  key={ingredient.id}
                  className="rounded-full bg-accent-soft px-2 py-1 text-accent"
                >
                  {[formatted.quantity, formatted.unit, formatted.item]
                    .filter(Boolean)
                    .join(' ')}
                </span>
              )
            })}

            {step.temperature && (
              <span className="rounded-full border border-line px-2 py-1 text-ink-soft">
                {step.temperature.value}°{step.temperature.unit}
                {step.temperature.mode !== 'other' && ` ${step.temperature.mode}`}
              </span>
            )}

            {step.timers.map((timer) => (
              <span
                key={timer.label}
                className="rounded-full border border-line px-2 py-1 text-ink-soft"
              >
                ⏱ {timer.label} · {formatTimer(timer.seconds)}
              </span>
            ))}
          </div>
        )}
      </div>
    </li>
  )
}

export default function StepList({
  steps,
  ingredients,
  groups,
  scale,
  done,
  onToggle,
}: Props) {
  const byId = new Map(ingredients.map((i) => [i.id, i]))

  // Number steps continuously across groups so "step 7" means one thing.
  let counter = 0
  const numbered = steps.map((step) => ({ step, index: ++counter }))

  const ungrouped = numbered.filter(({ step }) => !step.group)
  const sections = groups
    .map((group) => ({ group, items: numbered.filter(({ step }) => step.group === group) }))
    .filter((section) => section.items.length > 0)

  return (
    <div className="space-y-6">
      {ungrouped.length > 0 && (
        <ol className="space-y-4">
          {ungrouped.map(({ step, index }) => (
            <StepRow
              key={step.id}
              step={step}
              index={index}
              ingredients={byId}
              scale={scale}
              done={done.has(step.id)}
              onToggle={() => onToggle(step.id)}
            />
          ))}
        </ol>
      )}

      {sections.map(({ group, items }) => (
        <div key={group}>
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-faint">
            {group}
          </h3>
          <ol className="space-y-4">
            {items.map(({ step, index }) => (
              <StepRow
                key={step.id}
                step={step}
                index={index}
                ingredients={byId}
                scale={scale}
                done={done.has(step.id)}
                onToggle={() => onToggle(step.id)}
              />
            ))}
          </ol>
        </div>
      ))}
    </div>
  )
}

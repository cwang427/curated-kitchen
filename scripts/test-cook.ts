/**
 * Pure-logic tests for the "cooking now" timeline: the multi-dish merge that
 * turns a board of concurrent cooks into the sorted "Up next" agenda and the
 * strip window. Runs under Node against src/lib/cookboard.ts.
 *
 *   npm run test:cook
 */
import { buildTimeline } from '../src/lib/cookboard'
import type { CookDish, SyncTimer } from '../src/lib/types'

let passed = 0
let failed = 0
function check(label: string, cond: boolean): void {
  if (cond) { console.log(`  ✓ ${label}`); passed++ }
  else { console.error(`  ✗ ${label}`); failed++ }
}
function eq(label: string, a: unknown, b: unknown): void {
  check(`${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`, JSON.stringify(a) === JSON.stringify(b))
}

const NOW = 1_000_000_000_000

function timer(label: string, endsAtOffsetSec: number | null, id = label): SyncTimer {
  return {
    id,
    label,
    total: 600,
    endsAt: endsAtOffsetSec === null ? null : NOW + endsAtOffsetSec * 1000,
    remaining: endsAtOffsetSec ?? 600,
    source: `s:${label}`,
  }
}

function dish(slug: string, timers: SyncTimer[], stepIndex = 0): CookDish {
  return { slug, title: slug, scale: 1, stepIndex, timers, startedAt: NOW, updatedAt: NOW }
}

console.log('a dish with no running timer needs you now (attention)')
{
  const t = buildTimeline([dish('rice', [])], NOW)
  eq('one status', t.statuses.length, 1)
  check('attention', t.statuses[0].attention === true)
  eq('one now item', t.agenda.length, 1)
  eq('agenda item is a now/hands-on', t.agenda[0].kind, 'now')
  eq('no strip horizon (nothing counting down)', t.horizonMs, null)
}

console.log('a running timer is not attention and drives the horizon')
{
  const t = buildTimeline([dish('ribs', [timer('braise', 1800)])], NOW) // 30 min
  check('not attention', t.statuses[0].attention === false)
  eq('soonest end recorded', t.statuses[0].soonestEndsAt, NOW + 1800 * 1000)
  eq('horizon is the timer remaining (ms)', t.horizonMs, 1800 * 1000)
  eq('one timer agenda item', t.agenda.length, 1)
  eq('it is a timer kind', t.agenda[0].kind, 'timer')
  eq('countdown seconds', t.agenda[0].secondsUntil, 1800)
}

console.log('agenda ordering: rung timers, then hands-on, then soonest upcoming')
{
  const t = buildTimeline(
    [
      dish('ribs', [timer('braise', 1200)]), // rings in 20 min
      dish('rice', []), // hands-on now
      dish('eggs', [timer('boil', -5)]), // already rang
      dish('sauce', [timer('reduce', 300)]), // rings in 5 min
    ],
    NOW,
  )
  const kinds = t.agenda.map((i) => `${i.dishSlug}:${i.kind}:${i.done ? 'done' : 'live'}`)
  eq('rung first, hands-on next, then soonest→latest timers', kinds, [
    'eggs:now:done',
    'rice:now:live',
    'sauce:timer:live',
    'ribs:timer:live',
  ])
  eq('horizon is the furthest live timer', t.horizonMs, 1200 * 1000)
}

console.log('a paused timer counts as needing you (no live countdown)')
{
  const t = buildTimeline([dish('stew', [timer('simmer', null)])], NOW)
  check('attention despite having a (paused) timer', t.statuses[0].attention === true)
  eq('paused timer produces a hands-on now item', t.agenda[0].kind, 'now')
  eq('and no strip', t.horizonMs, null)
}

console.log('multiple timers on one dish: soonest is its next check-in, all listed')
{
  const t = buildTimeline([dish('roast', [timer('rest', 900, 'a'), timer('carve', 300, 'b')])], NOW)
  eq('both timers running', t.statuses[0].running.length, 2)
  eq('soonest end is the 5-min one', t.statuses[0].soonestEndsAt, NOW + 300 * 1000)
  eq('two timer agenda items', t.agenda.filter((i) => i.kind === 'timer').length, 2)
  eq('sorted soonest first', t.agenda[0].secondsUntil, 300)
}

console.log('a rung timer keeps the dish in attention even with a second still running')
{
  const t = buildTimeline([dish('ribs', [timer('probe', -1, 'a'), timer('braise', 600, 'b')])], NOW)
  check('attention (something rang)', t.statuses[0].attention === true)
  const done = t.agenda.filter((i) => i.done)
  eq('the rung timer surfaces as a now item', done.length, 1)
  eq('the still-running one is a later timer item', t.agenda.filter((i) => i.kind === 'timer').length, 1)
}

console.log('empty board → empty timeline')
{
  const t = buildTimeline([], NOW)
  eq('no statuses', t.statuses.length, 0)
  eq('no agenda', t.agenda.length, 0)
  eq('no horizon', t.horizonMs, null)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)

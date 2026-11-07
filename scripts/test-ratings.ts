/**
 * Pure-logic tests for "made it" + 1–10 scores (src/lib/ratings.ts): reading
 * a profile's records safely, the "made Nov 7" wording, and the line that
 * says what everyone else gave a recipe.
 *
 *   npm run test:ratings
 */
import { describeOthers, formatMadeOn, isRating, parseCooked } from '../src/lib/ratings'

let passed = 0
let failed = 0
function eq(label: string, a: unknown, b: unknown): void {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  if (ok) { console.log(`  ✓ ${label} (${JSON.stringify(a)})`); passed++ }
  else { console.error(`  ✗ ${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); failed++ }
}

console.log('isRating')
eq('1 and 10 are scores', [isRating(1), isRating(10)], [true, true])
eq('0, 11, 7.5, "8", null are not', [isRating(0), isRating(11), isRating(7.5), isRating('8'), isRating(null)], [false, false, false, false, false])

console.log('parseCooked')
eq('missing field → nothing made', parseCooked(undefined), {})
eq('not an object → nothing made', parseCooked('oops'), {})
eq('an array → nothing made', parseCooked([1, 2]), {})
eq('made + scored', parseCooked({ chowder: { madeAt: 1000, rating: 8 } }), { chowder: { madeAt: 1000, rating: 8 } })
eq('made, no score field (markMade alone)', parseCooked({ chowder: { madeAt: 1000 } }), { chowder: { madeAt: 1000, rating: null } })
eq('score cleared to null', parseCooked({ chowder: { madeAt: 1000, rating: null } }), { chowder: { madeAt: 1000, rating: null } })
eq('scored before a date was known', parseCooked({ chowder: { rating: 6 } }), { chowder: { madeAt: null, rating: 6 } })
eq('junk score → no score, still made', parseCooked({ chowder: { madeAt: 1000, rating: 42 } }), { chowder: { madeAt: 1000, rating: null } })
eq('junk date → no date', parseCooked({ chowder: { madeAt: 'yesterday', rating: 3 } }), { chowder: { madeAt: null, rating: 3 } })
eq('a non-object entry is skipped', parseCooked({ chowder: true, brisket: { madeAt: 5 } }), { brisket: { madeAt: 5, rating: null } })

console.log('formatMadeOn')
const now = new Date(2026, 10, 7, 9, 30).getTime() // Nov 7 2026, 9:30 local
eq('earlier today', formatMadeOn(new Date(2026, 10, 7, 0, 5).getTime(), now), 'today')
eq('late last night is yesterday', formatMadeOn(new Date(2026, 10, 6, 23, 50).getTime(), now), 'yesterday')
eq('this year', formatMadeOn(new Date(2026, 9, 31, 19).getTime(), now), 'Oct 31')
eq('another year names it', formatMadeOn(new Date(2025, 11, 24, 18).getTime(), now), 'Dec 24, 2025')

console.log('describeOthers')
const made = (rating: number | null) => ({ madeAt: 1, rating })
eq('nobody', describeOthers([]), '')
eq('one score', describeOthers([{ uid: 'p', name: 'Jordan', entry: made(7) }]), 'Jordan 7/10')
eq(
  'scores high to low, then made-only by name',
  describeOthers([
    { uid: 's', name: 'Sam', entry: made(null) },
    { uid: 'p', name: 'Jordan', entry: made(7) },
    { uid: 'a', name: 'Alex', entry: made(null) },
    { uid: 'r', name: 'Riley', entry: made(9) },
  ]),
  'Riley 9/10 · Jordan 7/10 · Alex made it · Sam made it',
)
eq(
  'equal scores by name',
  describeOthers([
    { uid: 'p', name: 'Jordan', entry: made(8) },
    { uid: 'a', name: 'Alex', entry: made(8) },
  ]),
  'Alex 8/10 · Jordan 8/10',
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)

/**
 * Pure-logic tests for "made it" + 1–10 scores (src/lib/ratings.ts): reading
 * a profile's records safely, the line that says what everyone else gave a
 * recipe, the kitchen's average, and the one score a kitchen tile shows.
 *
 *   npm run test:ratings
 */
import { describeOthers, formatScore, isRating, kitchenScore, othersWhoMade, parseCooked, recipeScore, isTopRated, type KitchenPerson } from '../src/lib/ratings'

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

console.log('kitchenScore')
const people: KitchenPerson[] = [
  { uid: 'p', name: 'Jordan', cooked: { soup: { madeAt: 1, rating: 7 }, stew: { madeAt: 1, rating: null } } },
  { uid: 's', name: 'Sam', cooked: { soup: { madeAt: 1, rating: 8 } } },
]
eq('nobody else scored it → none (not your own score again)', kitchenScore('stew', { madeAt: 1, rating: 9 }, people), null)
eq('not made by anyone → none', kitchenScore('pie', null, people), null)
eq("others' average when you haven't scored it", kitchenScore('soup', null, people), 7.5)
eq("others' average when you only made it", kitchenScore('soup', { madeAt: 1, rating: null }, people), 7.5)
eq('your score counts in once others have scored', kitchenScore('soup', { madeAt: 1, rating: 9 }, people), 8)

console.log('othersWhoMade')
eq('only the people who made it', othersWhoMade('stew', people).map((o) => o.name), ['Jordan'])
eq('nobody', othersWhoMade('pie', people), [])

console.log('formatScore')
eq('whole', formatScore(8), '8')
eq('half', formatScore(7.5), '7.5')
eq('thirds round to one place', formatScore(23 / 3), '7.7')
eq('rounds up to whole', formatScore(7.96), '8')

console.log('recipeScore (cards and Top rated)')
const mine8 = { madeAt: 1, rating: 8 }
eq('both: yours by default', recipeScore(mine8, 6.5), { score: 8, yours: true })
eq('both: the kitchen\'s when that\'s the setting', recipeScore(mine8, 6.5, 'kitchen'), { score: 6.5, yours: false })
eq('only yours', recipeScore(mine8, null, 'kitchen'), { score: 8, yours: true })
eq('only the kitchen\'s (not made)', recipeScore(null, 7.5), { score: 7.5, yours: false })
eq('only the kitchen\'s (made, not scored)', recipeScore({ madeAt: 1, rating: null }, 7.5), { score: 7.5, yours: false })
eq('neither', recipeScore({ madeAt: 1, rating: null }, null), null)

console.log('isTopRated')
eq('7 is top rated', isTopRated({ score: 7 }), true)
eq('6.5 isn\'t', isTopRated({ score: 6.5 }), false)
eq('an average that reads "7/10" counts (6.96)', isTopRated({ score: 6.96 }), true)
eq('…one that reads "6.9/10" doesn\'t (6.94)', isTopRated({ score: 6.94 }), false)
eq('unrated isn\'t', isTopRated(null), false)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)

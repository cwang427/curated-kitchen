/**
 * "I've made this" and a 1–10 score, per person (v0.54). Each person keeps
 * their own on their profile doc (`users/{uid}.cooked.<slug>`), so a guest
 * can rate a recipe in a kitchen they visit with no rules change — anyone
 * may write their own profile — and everyone in a kitchen can see what the
 * others gave it (profiles are readable by any signed-in user).
 *
 * Pure: no React/Firebase, so the scripts can test it under Node.
 */

export const RATING_MAX = 10

/** One person's record of one recipe. Being in the map at all means "made it". */
export interface CookedEntry {
  /** When they last made it (ms, the phone's clock), if known. Not shown —
   * the owner found the date beside a score an irrelevant detail (and odd for
   * something made many times) — but it's what a plain "made it" writes. */
  madeAt: number | null
  /** Their score, 1–10, or null when they haven't scored it. */
  rating: number | null
}

/** A person's records, keyed by recipe slug (recipe slugs are global). */
export type CookedMap = Record<string, CookedEntry>

export function isRating(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= RATING_MAX
}

/**
 * Read a profile's raw `cooked` field. It's written only by the app, but a
 * bad value must never break a screen: anything that isn't a record object
 * is skipped, and a junk score or date becomes null.
 */
export function parseCooked(raw: unknown): CookedMap {
  const out: CookedMap = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [slug, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    out[slug] = {
      madeAt: typeof entry.madeAt === 'number' && Number.isFinite(entry.madeAt) ? entry.madeAt : null,
      rating: isRating(entry.rating) ? entry.rating : null,
    }
  }
  return out
}

/** Someone else in the kitchen who has made a recipe. */
export interface OtherCook {
  uid: string
  name: string
  entry: CookedEntry
}

/**
 * What the recipe page says about everyone else: "Jordan 7/10 · Sam made it".
 * Scored first (highest first), then those who only made it, each by name, so
 * the line reads the same on every phone.
 */
export function describeOthers(others: OtherCook[]): string {
  return [...others]
    .sort(
      (a, b) =>
        (b.entry.rating ?? 0) - (a.entry.rating ?? 0) || a.name.localeCompare(b.name),
    )
    .map((o) => (o.entry.rating !== null ? `${o.name} ${o.entry.rating}/${RATING_MAX}` : `${o.name} made it`))
    .join(' · ')
}

/** Someone else in the kitchen, with all their records. */
export interface KitchenPerson {
  uid: string
  name: string
  cooked: CookedMap
}

/** The people in `people` who have made this recipe — the recipe page's line. */
export function othersWhoMade(slug: string, people: KitchenPerson[]): OtherCook[] {
  return people.flatMap((p) => (p.cooked[slug] ? [{ uid: p.uid, name: p.name, entry: p.cooked[slug] }] : []))
}

/**
 * The kitchen's score for a recipe: the average of everyone in it who has
 * scored it, you included. Null unless someone besides you has scored it —
 * otherwise it would just repeat your own score under another name.
 */
export function kitchenScore(slug: string, mine: CookedEntry | null, people: KitchenPerson[]): number | null {
  const scores = people.map((p) => p.cooked[slug]?.rating).filter(isRating)
  if (scores.length === 0) return null
  const own = mine?.rating
  if (isRating(own)) scores.push(own)
  return scores.reduce((sum, score) => sum + score, 0) / scores.length
}

/** 7.666… → "7.7", 8 → "8": one decimal, and none when it's whole. */
export function formatScore(score: number): string {
  const rounded = Math.round(score * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

/** Which score wins when a recipe has both yours and the kitchen's — a
 * per-phone setting (Settings › Ratings), "mine" unless changed. */
export type ScorePreference = 'mine' | 'kitchen'

/** "Top rated" means at least this, out of RATING_MAX. */
export const TOP_RATED_MIN = 7

/**
 * The one score a recipe goes by — on its kitchen card ("★ 8/10") and for
 * the Top rated filter, so a card in Top rated always shows the score that
 * put it there. Both yours and the kitchen's average: the setting decides.
 * Only one: that one (a recipe you made but didn't score shows the
 * kitchen's). Neither: none. `yours` colours the star — amber for yours,
 * grey for the kitchen's.
 */
export function recipeScore(
  mine: CookedEntry | null,
  kitchen: number | null,
  prefer: ScorePreference = 'mine',
): { score: number; yours: boolean } | null {
  const own = mine?.rating ?? null
  if (own !== null && kitchen !== null) {
    return prefer === 'kitchen' ? { score: kitchen, yours: false } : { score: own, yours: true }
  }
  if (own !== null) return { score: own, yours: true }
  if (kitchen !== null) return { score: kitchen, yours: false }
  return null
}

/** At least 7/10 — as the card shows it (an average of 6.96 reads "7/10"). */
export function isTopRated(score: { score: number } | null): boolean {
  return score !== null && Math.round(score.score * 10) / 10 >= TOP_RATED_MIN
}

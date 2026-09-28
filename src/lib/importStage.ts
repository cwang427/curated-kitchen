/**
 * An import's progress, in words and as a rough fraction for the bar. Only
 * real events drive it (what the Worker reports as it goes, then the photos
 * arriving on the phone) — nothing moves on a timer, so a stuck import looks
 * stuck rather than nearly done. Pure (no React/DOM), for test:import.
 */

/** Where an import is. The first five are the Worker's own (its `Stage`);
 * the rest happen on the phone. */
export type ImportProgress =
  | { stage: 'starting' }
  | { stage: 'opening'; host: string }
  | { stage: 'another-way' }
  | { stage: 'reading' }
  | { stage: 'writing'; ingredients: number; steps: number }
  | { stage: 'finishing' }
  | { stage: 'photos'; got: number; wanted: number }
  | { stage: 'saving' }

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function progressLine(p: ImportProgress): string {
  switch (p.stage) {
    case 'starting':
      return 'Starting…'
    case 'opening':
      return `Opening ${p.host}…`
    case 'another-way':
      return 'The site is being difficult — trying another way in…'
    case 'reading':
      return 'Reading the recipe…'
    case 'writing':
      return p.steps > 0
        ? `Writing it up — ${plural(p.ingredients, 'ingredient', 'ingredients')}, ${plural(p.steps, 'step', 'steps')} so far…`
        : `Found ${plural(p.ingredients, 'ingredient', 'ingredients')} so far…`
    case 'finishing':
      return 'Tidying it up…'
    case 'photos':
      return p.wanted > 0 ? `Pulling in photos — ${p.got} of ${p.wanted}…` : 'Pulling in photos…'
    case 'saving':
      return 'Saving…'
  }
}

/** 0–1, for the bar. Writing moves with what's been written (a recipe is
 * rarely more than ~25 ingredients and steps together). */
export function progressFraction(p: ImportProgress): number {
  switch (p.stage) {
    case 'starting':
      return 0.05
    case 'opening':
      return 0.12
    case 'another-way':
      return 0.25
    case 'reading':
      return 0.4
    case 'writing':
      return 0.45 + 0.3 * Math.min(1, (p.ingredients + p.steps) / 25)
    case 'finishing':
      return 0.8
    case 'photos':
      return 0.84 + (p.wanted > 0 ? 0.12 * (p.got / p.wanted) : 0)
    case 'saving':
      return 0.97
  }
}

/**
 * Read the Worker's streamed answer (newline-delimited JSON): each
 * {"progress": …} line as it comes, then the {"status", "body"} it ends with.
 * Null if the stream ended without one (the connection dropped).
 */
export async function readProgressStream<S, B>(
  body: ReadableStream<Uint8Array>,
  onProgress: (stage: S) => void,
): Promise<{ status: number; body: B } | null> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let final: { status: number; body: B } | null = null
  const take = (line: string) => {
    if (!line.trim()) return
    try {
      const msg = JSON.parse(line) as { progress?: S; status?: number; body?: B }
      if (msg.progress) onProgress(msg.progress)
      else if (typeof msg.status === 'number') final = { status: msg.status, body: (msg.body ?? {}) as B }
    } catch {
      /* not a whole line of JSON — skip it */
    }
  }
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    pending += decoder.decode(value, { stream: true })
    let end: number
    while ((end = pending.indexOf('\n')) >= 0) {
      take(pending.slice(0, end))
      pending = pending.slice(end + 1)
    }
  }
  take(pending)
  return final
}

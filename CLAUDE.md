# Curated Kitchen

A recipe log, live cooking helper, and shared grocery list, built as an
installable PWA (React + TypeScript + Vite + Firebase) so it runs on iPhone
without an Apple developer account. Used by a couple and a few friends — not a
public product.

## Working with the owner (read this first)

The owner is comfortable pushing changes from a phone by chatting, but is **not
a web developer**. Two obligations follow:

- **Always call out manual steps.** When a change needs the owner to do
  something outside the code — re-publish Firestore rules, add a GitHub secret
  or variable, change a Pages/Firebase console setting, reinstall the PWA —
  say so explicitly at the end of the reply, with the exact clicks. Never
  assume a config or console step happened on its own.
- **Explain the "why" briefly, in plain terms.** A one-line reason beats a
  wall of jargon.

## Deploy tracks (the #1 source of "it didn't work")

Different things ship on different tracks. Mixing them up is the most common
confusion:

- **App code → automatic.** Every push to the working branch runs
  `.github/workflows/deploy.yml` (typecheck → validate recipes → build →
  GitHub Pages). ~2 min, push to live. Nothing manual.
- **`firestore.rules` → MANUAL.** Rules do **not** deploy with the app. After
  any commit that changes `firestore.rules`, the owner must re-publish them:
  **Firebase console → Firestore Database → Rules → paste → Publish** (or
  `npm run deploy:rules` from a computer). **Whenever a change touches
  `firestore.rules`, tell the owner to re-publish, every time.**
- **Recipe content → on push, if configured.** Editing `recipes/*.json` runs
  `.github/workflows/sync-recipes.yml`, which writes to Firestore using the
  `FIREBASE_SERVICE_ACCOUNT` repo secret and the `KITCHEN_HOUSEHOLD_ID` repo
  variable. Fails with a clear message if those aren't set. CI syncs with
  `--prune`, so the repo is authoritative: renaming or deleting a recipe file
  removes the old Firestore document instead of leaving a duplicate (the doc id
  is the slug). Renaming a recipe = new slug + delete old file; prune handles
  the cleanup. Synced recipes are tagged `origin: 'repo'`; the prune only
  removes repo-tagged recipes, so recipes **created or copied inside the app**
  (`origin: 'app'`) are never deleted by a sync. Deleting a repo recipe in the
  app is futile — the next sync re-creates it; remove its file instead.
- **Recipe import Worker → MANUAL (Cloudflare, one-time).** In-app "Add recipe"
  (paste text or a photo → Claude → our structured shape → validated by the same
  `parseRecipe` → editable preview → save as an `origin: 'app'` recipe) calls a
  tiny Cloudflare Worker in `worker/` that holds the Anthropic API key — the key
  must never live in the public app. Deploy it once (`worker/README.md`) and put
  its URL in `src/lib/aiConfig.ts` (not secret; empty until set, which just
  shows a setup note). The Worker verifies the caller's Firebase ID token, so
  only signed-in members can spend the key. No `firestore.rules` change —
  creating a recipe is already a member action. `worker/` is outside the app's
  tsc build; `wrangler` builds it.

## The core bet: ingredients are structured data

Everything good falls out of the `Ingredient` shape in `src/lib/types.ts`
(quantity, unit, item, `canonical`, `category`, `scalable`, `alt`). Scaling,
grocery aggregation, and step↔ingredient links all depend on it; free-text
ingredients would break all three. `src/lib/` (types, units, quantity,
recipeSchema) is the heart of the app and has no React/DOM dependency, so it
also runs under Node in the scripts.

Rules of thumb, already enforced — keep them:
- Combine quantities only **within** a dimension (mass/volume/count). Never
  convert volume↔mass (needs density); the code refuses rather than guess.
- Scaled amounts snap to cook-friendly fractions and only promote units
  (`6 tsp`→`2 tbsp`) when the conversion is exact.
- Parenthetical measurements are structured (`alt`) so they scale; amounts in
  step prose scale via `{{ }}` tokens. Times/temperatures stay plain text.
- Every recipe has `schemaVersion`; bump it and migrate deliberately.
- A step may carry an optional `brief`: a concise, one-action-per-line version
  shown in **cook mode** (the recipe reader always shows the full `text`). When
  `brief` is absent, cook mode auto-splits `text` into sentence bullets. `brief`
  lines may carry `{{ }}` tokens so amounts still scale. Never let a meaningful
  instruction live only in `brief` — `text` stays the complete original prose.

## Sharing model

A **household** is the unit of trust. Members (the couple) read/write
everything; friends get read-only on recipes marked `visibility: 'friends'`,
never the grocery list. Rules key on `request.auth.uid`, never the email or
provider. Joining is by invite link (`src/data/invites.ts`, Settings screen).

Role management is **owner-gated**: only the household **owner** (its creator)
can remove or demote a member or promote a friend; **either member** can remove
a read-only friend; **anyone but the owner** can leave on their own. The owner
can never be removed or demoted (they must stay in `memberUids`), and ownership
isn't transferable yet. These live in `src/data/household.ts` and the
`households` update rule; change them together and re-run `npm run test:rules`.

A user can belong to several kitchens (`UserProfile.householdIds`), with one
**active** at a time (`defaultHouseholdId`). The Settings "Your kitchens"
switcher (`fetchHouseholds` / `switchHousehold` / `createHousehold` in
`src/data/household.ts`) flips between them and starts new ones; everyone gets a
personal kitchen on first sign-in. A kitchen with only you reads as "Personal",
otherwise "Shared" — a derived label, not a stored field. Switching just
repoints `defaultHouseholdId`, and every screen re-subscribes to the active
household, so no rules change was needed for it.

Redemption is security-sensitive: a rule can read documents but not client
variables or query filters, so the joiner **stages the invite code on their own
user doc** first; the household rule then `get()`s that doc, looks up the
invite, and allows a single-element self-add only if it names this exact
household and role. If you change the join flow, change the rules and the
client together, and re-run the rules test.

## Auth

Email/password (not Google — its cross-domain redirect breaks in an installed
iOS PWA). Accounts are created in the Firebase console; there is no in-app
sign-up. `firebaseConfig.ts` is committed on purpose — those values aren't
secret; `firestore.rules` is the security boundary.

## Versioning

`__BUILD__` (version + git commit + time) is injected by Vite's `define` and
shown in Settings; the build also writes `dist/version.json`, which the app
fetches (no-store) to tell the owner if a newer deploy is live. `version.json`
must stay out of the Workbox precache glob so it's always fetched fresh.

The git commit + build time advance automatically every deploy (that's what
the "up to date / update available" check compares). The human-readable
`version` in `package.json` does **not** — bump it by hand when shipping a
feature so the number reflects reality: `npm version <x.y.z> --no-git-tag-version`
(updates both package.json and the lockfile; no git tag). Convention: minor
bump (0.x.0) per shipped feature, patch (0.x.y) for fixes.

## Verifying changes (do this before pushing)

- `npm run typecheck` — always.
- `npm run validate:recipes` — after any recipe or schema change.
- `npm run test:rules` — after any `firestore.rules` change. Runs ~30
  allow/deny assertions against the Firestore emulator (needs Java; first run
  downloads the CLI + emulator).
- `npm run test:import` / `npm run test:grocery` / `npm run test:plan` /
  `npm run test:steps` / `npm run test:draft` / `npm run test:cook` — pure-logic
  unit tests for the JSON-LD converter, the grocery merge/aisle logic, the
  meal-plan day window + plan→groceries aggregation, the cook-mode sentence
  splitter, the recipe editor's draft↔schema round-trip, and the "cooking now"
  multi-dish timeline (attention/agenda merge + ordering). Run after touching
  `src/lib/importRecipe.ts`, `src/lib/grocery.ts`, `src/lib/plan.ts`,
  `src/lib/quantity.ts`, `src/lib/recipeDraft.ts`, or `src/lib/cookboard.ts`.
- `npm run ui` / `npm run ui:build` — renders real pages against fixtures with
  Firebase stubbed (`.preview/stubs/`), for visual checks without credentials.
  Screenshot at phone width (393×852) and confirm no horizontal overflow,
  light and dark.

CI re-runs typecheck + validate + build on every push, so a red build blocks
the deploy and leaves the previous version up.

## Conventions

- Match the surrounding code's style; comments explain *why*, not *what*.
- Keep touch targets generous and type large — this is used at arm's length
  with wet hands. Palette is CSS tokens on `:root` with a dark-mode block.
- Never commit secrets. The service-account key lives only in the GitHub
  secret; `./secrets/` is gitignored.

## Roadmap

Done: sign-in, recipe reader + scaling, household/friend sharing by invite,
recipe sync CI, version stamp, cook mode (full-screen steps, wake lock,
cross-step timers, large controls, per-step mise-en-place checklist,
scannable step bullets — authored `brief` or auto-split prose, resume an
interrupted solo cook — several dishes at once — via the cook board
(`src/data/cookBoard.ts`) in localStorage),
pull-to-refresh, screen-name editor, recipe import (URL via CI, or paste text),
the shared grocery list (add-from-recipe, merge by canonical + unit, aisle
order, realtime check-off, quick-add), the meal plan (plan recipes onto a
rolling week → one-tap "add the week to groceries"), and two-phone "cook
together" sync (both phones follow the same step and timers via a shared
`sessions/{householdId}` doc), and member/role management (owner removes/
demotes members and promotes friends; either member manages guests; anyone but
the owner can leave), and a multi-kitchen switcher (belong to several kitchens,
switch the active one, create/name new ones — "Personal" vs "Shared" derived
from membership), and cross-kitchen recipe management (copy a recipe to another
kitchen you're a member of, delete a recipe with confirm; the sync prune spares
app-copied recipes via `origin`), and AI recipe ingestion (paste text or a photo
→ Claude via the `worker/` Cloudflare Worker → structured → validated by the same
`parseRecipe` → editable preview → save as `origin: 'app'`; the JSON pipeline
stays as a power-user path), and a full in-app recipe editor (`RecipeEditor` +
`src/lib/recipeDraft.ts`: edit overall details, the ingredient list, and each
step's text + cook-mode `brief`; start from scratch or edit an ingestion result
before saving — draft↔schema round-trip validated by the same `parseRecipe`),
and a **live cooking timeline** (`/cooking`, `src/routes/CookingPage.tsx`) that
coordinates several dishes at once from the local cook board: a glanceable strip
of each dish's running timers plus a merged, time-sorted "Up next" list of what
needs you now (a rung timer or a dish with nothing counting down) and when each
timer will ring — pure merge logic in `src/lib/cookboard.ts` (`buildTimeline`).
It reads only real data (step position + `endsAt` timers), so it needs no schema
or rules change; a back-timed "ready by 6:45" scheduler (needing per-step
durations) is a deliberate later phase.
Next: an **on-device ingestion engine** (free, no paid API) — OCR (Tesseract.js
and/or iOS Live Text) + a rule-based text→recipe parser building on
`parseIngredientLine`, to pre-fill the editor from pasted text or a photo (the
paid Claude Worker in `worker/` is left dormant/optional); then more pathways
(URL JSON-LD fast path, PWA share-target) and ownership transfer / co-owner. The
cook log is intentionally skipped —
journaling lives in ConsoliDated; this app stays focused on planning and
executing.

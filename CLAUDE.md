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
- **`storage.rules` → MANUAL (+ enable Storage once).** Step photos live in
  Firebase **Storage** (`src/data/photos.ts`, path `recipe-photos/<hid>/…`).
  Storage must be **enabled once** in the Firebase console, and `storage.rules`
  deploys separately from the app — **Firebase console → Storage → Rules →
  paste → Publish** (or `npm run deploy:storage`). Same as firestore.rules:
  **whenever `storage.rules` changes, tell the owner to re-publish.** It gates
  `recipe-photos/<householdId>/…` to that household's members (write) and
  members + guests (read), checking membership via `firestore.get()` on the
  household doc. Verify with `npm run test:storage-rules` (Firestore + Auth +
  Storage emulators).
- **Recipe content → authored in the app now (repo sync RETIRED).** Recipes are
  created, edited, copied, and deleted **inside the app** (`RecipeEditor` →
  `origin: 'app'` docs). The old repo→Firestore sync — where `recipes/*.json`
  was authoritative and pushed to Firestore on every commit — is retired,
  because a live sync would clobber in-app edits by slug on each push. The
  `recipes/*.json` files are kept only as a **frozen archive/backup**, and
  `.github/workflows/sync-recipes.yml` no longer runs on push: it's now
  **manual-only** ("Restore recipes from archive"), runs **without `--prune`**,
  and is for disaster recovery — running it re-seeds from the archive and would
  overwrite in-app edits to any recipe whose slug matches an archived file, so
  reach for it only to recover a lost kitchen. (Follow-up idea if a live backup
  is wanted: reverse the direction — a scheduled Firestore→`recipes/*.json`
  snapshot that never overwrites live edits.) Editing a recipe in the app marks
  it `origin: 'app'`; deleting one is now permanent (nothing re-creates it).
- **Recipe backup → automatic (owner-only).** `.github/workflows/backup-recipes.yml`
  (`scripts/backup-recipes.ts`) is the safety net now that the app owns recipes:
  it snapshots the `KITCHEN_HOUSEHOLD_ID` household's recipes from Firestore into
  `backups/recipes/*.json` (weekly + manual) and commits them with `[skip ci]`.
  Owner-only by construction — it runs in CI with the repo's service-account
  secret, never in the app, so members can't reach it. It's **additive** (never
  deletes, so an empty read can't wipe the archive; deleted recipes live on in
  git history). Restore is manual, for disaster recovery:
  `npm run backup:recipes -- --household=<id> --restore`. NOTE: GitHub runs the
  weekly `schedule` only from the default branch, so it kicks in once this is on
  main; run it by hand from the Actions tab any time. It reuses the existing
  `FIREBASE_SERVICE_ACCOUNT` secret + `KITCHEN_HOUSEHOLD_ID` variable — no new
  setup.
- **Recipe import Worker → MANUAL (Cloudflare, one-time).** The `worker/`
  Cloudflare Worker powers "Add a recipe" imports and has **two routes**:
  - **`/url` (FREE) — paste a link.** The app can't fetch another site directly
    (browser CORS), so the Worker fetches the page server-side and returns the
    schema.org **JSON-LD** most recipe sites embed; the app converts it with the
    same pure `recipeFromJsonLd` (`src/lib/importRecipe.ts`) and validates with
    `parseRecipe` → editable preview → save as `origin: 'app'`. **No API key** —
    reading structured data is deterministic. Fragile per-site (bot walls / no
    JSON-LD), so it degrades to paste/photo; that's expected.
  - **root (PAID, optional) — paste text or a photo → Claude.** Needs the
    Anthropic key (a Worker secret; never in the public app). Off in the app
    until `AI_IMPORT_ENABLED = true`.

  Deploy once (`worker/README.md`); URL import needs only `FIREBASE_PROJECT_ID`.
  Put the Worker URL in `src/lib/aiConfig.ts` (`IMPORT_WORKER_URL`; not secret,
  empty until set → the options that need it stay hidden). The Worker verifies
  the caller's Firebase ID token (members only) and guards its fetcher against
  private/loopback hosts (basic SSRF). No `firestore.rules` change. `worker/` is
  outside the app's tsc build; `wrangler` builds it.

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
everything. **Recipes are shared with guests (friends) by default** —
`visibility` defaults to `'friends'`, and the editor's "Who can see it" offers
two states: *Everyone in this kitchen* (`'friends'`) or *Members only*
(`'household'`, the hide option; legacy `'private'` is treated as members-only).
Guests never see the grocery list, meal plan, or cook session. Rules key on
`request.auth.uid`, never the email or provider. Joining is by invite link
(`src/data/invites.ts`, Settings screen).

What a guest can do with a shared recipe: **view, cook (solo), copy it into
their own kitchen, and add its ingredients to their own grocery list** — but
**not edit it in place** (Edit/Delete stay members-only), and not touch the
kitchen's own list/plan/session. This needed **no rules change**: copy creates a
recipe in a kitchen the guest is a *member* of, and add-to-list writes that
*member* kitchen's list — both already allowed. `copyRecipeToHousehold` and
`AddToListSheet` therefore target one of the guest's own kitchens (a picker when
they have several), never the kitchen they're visiting.

A guest's reads must still be **scoped in the client**: a friend may only list
recipes filtered to `visibility == 'friends'` (Firestore refuses an unfiltered
household listing for them — it could return docs they can't read), so
`useRecipes(id, nonce, friendsOnly)` adds that filter for non-members. The
grocery/plan/session subscriptions and the members-only UI (header cart/plan,
add-to-plan, cook-together, Edit/Delete) are hidden for guests — a member-only
read would just permission-deny. `test:rules` locks in the member-lists-all /
friend-lists-only-friends behavior. Recipes created before share-by-default are
brought in with one tap: **Settings › Guests › "Make N hidden recipes visible
to guests"** (`shareRecipesWithGuests`, a member batch write).

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
- `npm run test:rules` — after any `firestore.rules` change. Runs ~60
  allow/deny assertions against the Firestore emulator (needs Java; first run
  downloads the CLI + emulator).
- `npm run test:storage-rules` — after any `storage.rules` change. Runs the
  step-photo allow/deny assertions against the Firestore + Auth + Storage
  emulators (the rule's membership check is a cross-service `firestore.get()`).
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
kitchen you're a member of, delete a recipe with confirm; copies remember their
lineage via `copiedFrom` so the copy sheet flags "already copied" and confirms
before making a duplicate — copies stay independent forks, no live propagation),
and **share-with-guests-by-default** (recipes default to guest-visible; a member
can hide one via the editor; guests can view, cook, copy into their own kitchen,
and add ingredients to their own grocery list, but never edit in place or see the
kitchen's list/plan — no rules change, since copy/add-to-list act on the guest's
own kitchen; Settings › Guests one-taps pre-existing recipes into the default),
and recipe import from a link (Add a recipe → **Paste a link** →
the `worker/` `/url` route fetches the page → `recipeFromJsonLd` reads its
schema.org JSON-LD → validated by the same `parseRecipe` → editable preview →
save as `origin: 'app'`; free/no-key, degrades to paste/photo on sites that block
it or lack structured data), and AI recipe ingestion (paste text or a photo
→ Claude via the same Worker's paid route, off unless enabled → structured →
validated by the same `parseRecipe` → editable preview → save as `origin: 'app'`;
the JSON pipeline stays as a power-user path), and a full in-app recipe editor (`RecipeEditor` +
`src/lib/recipeDraft.ts`: edit overall details, the ingredient list, and each
step's text + cook-mode `brief`; start from scratch, edit an ingestion result
before saving, or **edit an existing recipe in place** at `/r/:slug/edit`
(`EditRecipePage` → `updateRecipe`, same slug/URL, becomes `origin: 'app'`) —
draft↔schema round-trip validated by the same `parseRecipe`; recipe authoring is
now fully in-app and the repo→Firestore sync is retired to a manual archive
restore, see Deploy tracks),
and a **live cooking timeline** (`/cooking`, `src/routes/CookingPage.tsx`) that
coordinates several dishes at once from the local cook board: a glanceable strip
of each dish's running timers plus a merged, time-sorted "Up next" list of what
needs you now (a rung timer or a dish with nothing counting down) and when each
timer will ring — pure merge logic in `src/lib/cookboard.ts` (`buildTimeline`).
It reads only real data (step position + `endsAt` timers), so it needs no schema
or rules change; a back-timed "ready by 6:45" scheduler (needing per-step
durations) is a deliberate later phase.
And an **owner-only recipe backup** (`.github/workflows/backup-recipes.yml` +
`scripts/backup-recipes.ts`): a weekly/manual Firestore→`backups/recipes/*.json`
snapshot committed to git, the safety net now that the app owns recipes (additive,
disaster-recovery restore via `--restore`; see Deploy tracks).
And **per-step photos** (up to 3, `Step.images`): add them in the editor
(`src/data/photos.ts` compresses in-browser → Firebase Storage → download URL),
shown in the recipe reader and cook mode. Members add/replace/delete, members +
guests view — enforced by `storage.rules` (a new security surface; enable
Storage once + publish the rules — see Deploy tracks). Copies KEEP step photos
by carrying over the same download URLs (the token grants access cross-household
and `<img>` isn't CORS-restricted, so they render in the new kitchen) — they
reference the source object rather than duplicating bytes. Because of that
sharing, **removing a photo only drops the reference from that recipe; the app
never deletes the Storage file** (matching recipe deletion), so editing a copy's
photos can't blank the original and vice-versa. The cost is orphaned files,
which are cheap here; a true independent duplicate (so each kitchen owns its
bytes) would need the bucket's CORS configured for a browser-side re-upload.
Next: an **on-device ingestion engine** (free, no paid API) — OCR (Tesseract.js
and/or iOS Live Text) + a rule-based text→recipe parser building on
`parseIngredientLine`, to pre-fill the editor from pasted text or a photo (the
paid Claude Worker route is left dormant/optional; the free link import already
covers sites with structured data); then a PWA share-target ("Share → Curated
Kitchen" hands over the page text, sidestepping CORS) and ownership transfer /
co-owner. The
cook log is intentionally skipped —
journaling lives in ConsoliDated; this app stays focused on planning and
executing.

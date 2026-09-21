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
- **Step photos → live in Firestore now (NO Storage, no billing).** Step photos
  are compressed in-browser to JPEG data URLs and stored as documents in the
  `photos` Firestore collection (`src/data/photos.ts`) — `Step.images` holds the
  photo doc ids. This is the ConsoliDated approach, and it's deliberate: enabling
  Firebase **Storage** now requires attaching a **billing account (Blaze plan)**,
  which the owner doesn't want; Firestore stays on the free Spark plan. So there
  is **no `storage.rules` and no Storage to enable** — the `photos` collection is
  gated by `firestore.rules` (members write, members + guests read), and its
  allow/deny cases are covered by `npm run test:rules` like every other
  collection. The only manual step is the usual one: **whenever `firestore.rules`
  changes, re-publish it** (see above). Trade-off: each photo must fit in a
  Firestore doc (~1 MB), so `compressToDataUrl` downscales + drops quality until
  it fits; copies duplicate the photo docs into the new kitchen, so they're fully
  independent (removing a photo from one recipe never touches another).
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
    JSON-LD), so it degrades to paste/photo; that's expected. **Currently the
    "Paste a link" option is disabled (greyed) in the Add-recipe chooser** —
    too many sites block the server-side fetch to be worth it, and text/photo
    import cover it. The route and its `link` mode still work; to re-enable, drop
    `disabled` and restore the `onClick={() => setMode('link')}` on that button in
    `src/routes/AddRecipePage.tsx`.
  - **root (FREE with Gemini) — paste text or a photo → AI.** Uses Google
    Gemini's **free tier** (an AI Studio key with no billing) by default —
    `GEMINI_API_KEY`, a Worker secret, never in the public app; `GEMINI_MODEL`
    overrides the model. Default is `gemini-3.5-flash-lite` with a fallback to
    `gemini-3.5-flash`: on the free tier the fuller flash models are heavily
    contended (sustained 503s, and sometimes they hang until a Cloudflare 524),
    while `-lite` reliably has capacity and is plenty for structured extraction.
    Each model call has a 30s abort so a hung model doesn't stall the request;
    any 5xx (503/524/…) or a 404 skips to the next model, and a 400 retries that
    model once without the responseSchema (the app's zod schema is the real
    validator). No `thinkingConfig` — the `-lite` tier 400s on it. Pinning
    `GEMINI_MODEL` forces one model with no fallback (e.g. `gemini-3.6-flash`
    once it settles). A retired id shows up as a 404 "no longer available." It reads any layout (blog-style pages the
    `/url` route can't) and photos/screenshots — the app posts `{ images: [...] }`
    (one or several photos of the SAME recipe, read together; the legacy single
    `{ image }` is still accepted) — via structured JSON output → the same
    `parseRecipe` → editable preview → save.
    When AI is enabled it's the **default engine for text** (the on-device
    `importText` parser is the offline/rate-limit fallback) and the **only
    engine for photos**. A paid Anthropic Claude route (`ANTHROPIC_API_KEY`,
    forced `save_recipe` tool) is kept as an alternative — the Worker uses it
    only when no Gemini key is set. Off in the app until `AI_IMPORT_ENABLED = true`.

  Deploy once (`worker/README.md`); URL import needs only `FIREBASE_PROJECT_ID`.
  Put the Worker URL in `src/lib/aiConfig.ts` (`IMPORT_WORKER_URL`; not secret,
  empty until set → the options that need it stay hidden). The Worker verifies
  the caller's Firebase ID token (members only) and guards its fetcher against
  private/loopback hosts (basic SSRF). No `firestore.rules` change. `worker/` is
  outside the app's tsc build; `wrangler` builds it.

  **Redeploying the Worker ships from LOCAL files, not GitHub** (unlike the app,
  which CI always builds from the pushed branch). So after ANY commit that
  changes `worker/`, tell the owner to update their computer's copy *before*
  `wrangler deploy` — `git checkout <working branch> && git pull`, then
  `cd worker && npx wrangler deploy` — otherwise a stale local copy silently
  redeploys the old behavior and it looks like the change "didn't work." When a
  Worker-code change is what shipped, this pull-then-deploy is the manual step to
  spell out, every time.

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
- `npm run test:rules` — after any `firestore.rules` change. Runs ~70
  allow/deny assertions against the Firestore emulator (needs Java; first run
  downloads the CLI + emulator), including the `photos` collection (members
  write, members + guests read).
- `npm run test:import` / `npm run test:text` / `npm run test:grocery` /
  `npm run test:plan` / `npm run test:steps` / `npm run test:draft` /
  `npm run test:cook` — pure-logic unit tests for the JSON-LD converter, the
  free pasted-text importer (real full-page fixtures under
  `scripts/fixtures/text/`), the grocery merge/aisle logic, the meal-plan day
  window + plan→groceries aggregation, the cook-mode sentence splitter, the
  recipe editor's draft↔schema round-trip, and the "cooking now" multi-dish
  timeline (attention/agenda merge + ordering). Run after touching
  `src/lib/importRecipe.ts`, `src/lib/importText.ts`, `src/lib/grocery.ts`,
  `src/lib/plan.ts`, `src/lib/quantity.ts`, `src/lib/recipeDraft.ts`, or
  `src/lib/cookboard.ts`.
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
→ AI via the same Worker — Google Gemini's **free** tier by default, off unless
enabled → structured → validated by the same `parseRecipe` → editable preview →
save as `origin: 'app'`; when enabled, the default engine for text with the
on-device parser as the offline/rate-limit fallback, and the only engine for
photos/screenshots — several at once, since a long recipe rarely fits one phone
screenshot, downscaled in-browser via `compressForImport` and combined into one
recipe; a paid Claude route stays available as an alternative), and
a full in-app recipe editor (`RecipeEditor` +
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
And **in-recipe multitasking** (cook mode's "Meanwhile", `src/routes/CookPage.tsx`):
when a timer you started belongs to a step you've moved on from, it shows in a
**Meanwhile band** above the current step — named by its step ("Meanwhile · Step
3"), counting down, tap to jump back; when it rings the band turns into a
prominent "← Back to step N" (and still beeps). Timers already persisted across
steps (they're dish-level, keyed by `source = "<stepId>:<label>"`); this just
partitions them into current-step (full-control tray) vs. away (the bands, via
`stepIndexForSource`), and adds a footer **work-ahead nudge** shown while the
current step is cooking ("This is cooking — work ahead"). Pure cook-mode UI over
existing timer state — no schema/rules change, works solo and in a cook-together
session. Phase 2 (later): Gemini tags hands-off steps (simmer/bake/rest) +
realistic durations so the nudge only appears on genuine waits and can suggest
which upcoming steps are safe to start; a keyword heuristic backfills recipes
imported before the tag.
And an **owner-only recipe backup** (`.github/workflows/backup-recipes.yml` +
`scripts/backup-recipes.ts`): a weekly/manual Firestore→`backups/recipes/*.json`
snapshot committed to git, the safety net now that the app owns recipes (additive,
disaster-recovery restore via `--restore`; see Deploy tracks).
And **per-step photos** (up to 3, `Step.images`): add them in the editor
(`src/data/photos.ts` compresses in-browser → JPEG data URL → a document in the
`photos` Firestore collection; `Step.images` holds the photo doc ids), shown in
the recipe reader and cook mode (resolved back to data URLs by `usePhotoUrls`).
Members add/delete, members + guests view — enforced by `firestore.rules` on the
`photos` collection (NOT Firebase Storage: enabling Storage now needs a billing
account, which we avoid; see Deploy tracks). Copies **duplicate** the photo docs
into the new kitchen — Firestore reads/writes aren't CORS-restricted, so the copy
truly owns its bytes and is fully independent. **Removing a photo only drops the
reference from that recipe's step; the app never deletes the `photos` doc**
(matching recipe deletion), which is safe now that copies don't share bytes;
unreferenced docs just orphan, which is cheap here (a future reference-aware
sweep could reclaim them). Each photo must fit a Firestore doc (~1 MB), so
`compressToDataUrl` downscales + drops quality until it does.
And a **free pasted-text importer** (`src/lib/importText.ts`, Add a recipe →
**Paste text**): the cook copies a recipe — the whole page or just the recipe
section — and a rule-based, on-device parser (no network, no AI, no cost) anchors
on the "Ingredients"/"Directions" headings to pull out the title, times,
ingredients, and steps, discarding nav/headnotes/photo credits/captions/reviews,
then validates with the same `parseRecipe` → editable preview → save. Built on
the same `parseIngredientLine` as the link importer; handles both numbered and
paragraph steps; tuned against real full-page pastes in `npm run test:text`
(`scripts/fixtures/text/`). This is the free fallback for the big commercial
recipe sites (AllRecipes, Serious Eats, etc.) that block the link route's
server-side fetch.
And **kitchen-wide favorites** (`Recipe.favorite`, a shared boolean): a heart
button on each recipe card and on the reader (members toggle via
`setRecipeFavorite` — a member merge-update of just `favorite`+`updatedAt`, no
rules change; guests see a filled heart but can't toggle, same as editing).
Favorites **pin to the top** of the recipe list (the `useRecipes` sort keys on
`favorite` then title). (A "favorites only" filter was tried and removed —
redundant once they pin to the top.) `favorite` is deliberately excluded from
`RecipeSeed`, so it's toggled on
its own and a recipe edit/copy never carries or clobbers it (a copy starts
un-favorited). Shared `HeartIcon` component; `test:rules` unchanged since the
existing member-updates-recipe rule already covers it.
Photos/screenshots are now handled by the free Gemini vision route (above), so
the earlier on-device OCR idea (Tesseract.js / iOS Live Text) is shelved unless a
fully-offline photo path is ever wanted. Next: a PWA share-target
("Share → Curated Kitchen" hands over the page text, sidestepping CORS) and
ownership transfer / co-owner. The cook log is intentionally skipped —
journaling lives in ConsoliDated; this app stays focused on planning and
executing.

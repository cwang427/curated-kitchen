# Curated Kitchen

A recipe log, a live cooking helper, and a shared grocery list — as an
installable web app, so it runs on iPhone without an Apple developer account.

Built on React + TypeScript + Vite with Firebase (Auth, Firestore, Hosting).

**Status: phase 1.** Recipes, scaling, and the reader are done. Cook mode and
the grocery list are next — see [Roadmap](#roadmap).

---

## Getting it running

### 1. Create the Firebase project

In the [Firebase console](https://console.firebase.google.com):

1. **Create a project.** Google Analytics is not needed.
2. **Build › Authentication › Get started › Google.** Enable it, set a support
   email, save.
3. **Build › Firestore Database › Create database.** Start in *production
   mode* — the rules in this repo replace the defaults. Pick the region
   closest to you; it cannot be changed later.
4. **Project settings › General › Your apps › Web (`</>`).** Register the app
   and copy the `firebaseConfig` values.

### 2. Configure this repo

```bash
npm install
cp .env.example .env.local   # paste your firebaseConfig values in
npm run dev
```

The `VITE_FIREBASE_*` values are not secrets — they ship in the client bundle
by design. Access is controlled by `firestore.rules`, not by hiding them.

### 3. Deploy the rules and the app

```bash
npm install -g firebase-tools
firebase login
firebase use --add            # select the project you just created
firebase deploy --only firestore:rules,firestore:indexes
npm run deploy                # builds, then deploys hosting
```

Sign in to the deployed app once. That creates your user profile and a
household, which you'll need in the next step.

### 4. Install it on your phone

Open the hosting URL in **Safari** (not Chrome — only Safari can install to
the iOS home screen), then **Share › Add to Home Screen**. It launches
full-screen with no browser chrome, and it's what makes web push and durable
storage work on iOS.

---

## Adding recipes

Recipe content lives as JSON in [`recipes/`](recipes/), one file per recipe,
named `<slug>.json`. Those files are the source of truth: a recipe's Firestore
document id *is* its slug, so re-syncing overwrites cleanly and every change
shows up in `git diff`.

```bash
npm run validate:recipes                          # check before syncing
npm run sync:recipes -- --household=<householdId> --dry-run
npm run sync:recipes -- --household=<householdId>
```

Find `<householdId>` in the Firestore console under `households`, or set
`KITCHEN_HOUSEHOLD_ID` in your environment to skip the flag.

Syncing uses the Admin SDK and needs a service account:
**Project settings › Service accounts › Generate new private key**. Save it to
`./secrets/` (gitignored) and point `GOOGLE_APPLICATION_CREDENTIALS` at it.

See [`recipes/README.md`](recipes/README.md) for the authoring format.

---

## How it's put together

```
recipes/*.json        Recipe content — the source of truth
scripts/              Validation, Firestore sync, icon generation
src/lib/              Types, units, scaling, schema validation  ← the core
src/data/             Firestore reads and the household bootstrap
src/routes/           Pages
src/components/       UI
firestore.rules       Access control
```

### Ingredients are data, not prose

The whole app rests on this shape:

```ts
{ quantity: 340, unit: 'g', item: 'bucatini', canonical: 'bucatini',
  alt: { quantity: 12, unit: 'oz' }, category: 'pantry', scalable: true }
```

Three things fall out of it, none of which work with free-text ingredients:

- **Scaling** — `2×` recomputes every quantity and picks a friendlier unit
  (`6 tsp` → `2 tbsp`), while `scalable: false` keeps "salt to taste" put.
- **Grocery aggregation** — `canonical` merges two onions from two recipes
  into one line; `category` sorts the list into walking order.
- **Cook mode** — each step lists the ingredient ids it uses, so the app can
  show you exactly what you need right now.

Quantities are only ever combined *within* a dimension (mass, volume, count).
Converting volume to mass needs a per-ingredient density, so the app refuses
rather than producing confidently wrong numbers.

### Scaling is honest

A recipe that scales its ingredient list but not its method is worse than one
that doesn't scale at all. So amounts written into step text can be wrapped in
`{{ }}` and scale with everything else:

```
"Reserve {{1.5 cup}} of the pasta water, then drain."
```

Times, temperatures, and pan sizes stay plain prose and never scale, which is
the correct default. The validator rejects a malformed token rather than
letting it render as literal braces, and warns when a number is left sitting
in a free-text note where it would go stale.

### Access control

A **household** is the unit of trust. Members (you and your partner) read and
write everything it owns. Friends get read-only access to recipes explicitly
marked `"visibility": "friends"` — never to grocery lists.

Rules resolve membership with `get()` on the household document. Firestore
caps a request at 10 such lookups, and repeated reads of the *same* path
count once, so queries must stay scoped to a single household — which is why
`useRecipes` always filters on `householdId`.

---

## Development

```bash
npm run dev               # the real app (needs .env.local)
npm run ui                # UI harness with Firebase stubbed out
npm run typecheck
npm run validate:recipes
python3 scripts/make-icons.py   # regenerate PWA icons
```

`npm run ui` renders the real pages and components against fixture data with
Firebase swapped out, so layout and scaling can be checked without
credentials or a network. Fixtures live in `.preview/stubs/`.

---

## Roadmap

- [x] **0** — Project scaffold, auth, Firestore, PWA shell
- [x] **1** — Recipe schema, sync pipeline, reader, scaling
- [ ] **2** — Grocery list: add-from-recipe, aggregation, aisle order,
      realtime check-off
- [ ] **3** — Cook mode: full-screen steps, wake lock, concurrent timers,
      two-phone session sync
- [ ] **4** — Household invites, friend sharing, cook log
- [ ] **5** — Recipe import (JSON-LD for sites that publish it, paste-and-parse
      for those that don't)

## Notes

Recipes here are kept for personal use by a small, private group. Ingredient
lists aren't copyrightable, but headnotes and instruction prose are — so
recipes adapted from a source record that source, and the app has no public
sharing surface.

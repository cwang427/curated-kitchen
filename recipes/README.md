# Recipe format

One JSON file per recipe, named `<slug>.json` to match its `slug` field.
Run `npm run validate:recipes` before syncing — it catches broken ingredient
references, undeclared groups, malformed amounts, and stale numbers.

## Minimal example

```json
{
  "slug": "garlic-bread",
  "title": "Garlic Bread",
  "yield": { "amount": 4, "unit": "servings" },
  "ingredients": [
    { "id": "bread", "quantity": 1, "unit": "loaf", "item": "ciabatta", "category": "bakery" },
    { "id": "butter", "quantity": 113, "unit": "g", "item": "unsalted butter",
      "alt": { "quantity": 8, "unit": "tbsp" }, "prep": "softened", "category": "dairy" }
  ],
  "steps": [
    { "text": "Heat the oven to 400°F.", "temperature": { "value": 400, "unit": "F" } },
    { "text": "Split the loaf and spread with the butter.", "uses": ["bread", "butter"] }
  ]
}
```

Anything not listed below can be omitted.

## Ingredients

| Field | Notes |
|---|---|
| `item` | **Required.** Singular display name: `"yellow onion"`. |
| `category` | **Required.** Which aisle — see the list below. |
| `quantity` | Omit for "salt to taste". |
| `quantityMax` | Upper bound of a range: `2`–`3` cloves. Must exceed `quantity`. |
| `unit` | `g`, `cup`, `tbsp`, `clove`… Omit for countable items (`2 eggs`). |
| `alt` | A parallel measurement shown in parentheses: `{ "quantity": 12, "unit": "oz" }`. **Scales.** |
| `note` | Non-numeric aside: `"plus more for serving"`. Does *not* scale. |
| `prep` | `"finely diced"`, `"at room temperature"`. |
| `id` | Defaults to a slug of `item`. Set it when steps need to refer to this line. |
| `canonical` | Merge key for the grocery list. Defaults to a slug of `item`. |
| `itemPlural` | Only when the automatic plural is wrong. |
| `optional` | Default `false`. |
| `scalable` | Default `true`. Set `false` for "salt to taste", "oil for frying". |
| `group` | Component name; must also appear in the recipe's `groups` array. |
| `raw` | The original line, verbatim. Generated if omitted. |

Categories: `produce` `meat` `seafood` `dairy` `bakery` `deli` `frozen`
`pantry` `spices` `condiments` `baking` `beverages` `alcohol` `household`
`other`

### Two ingredients with the same name

Give each an explicit `id` and refer to those ids from steps — otherwise the
validator rejects the ambiguous reference:

```json
{ "id": "butter_dough", "item": "unsalted butter", "quantity": 113, "unit": "g", "category": "dairy" },
{ "id": "butter_filling", "item": "unsalted butter", "quantity": 57, "unit": "g", "category": "dairy" }
```

## Steps

| Field | Notes |
|---|---|
| `text` | **Required.** See amounts below. |
| `uses` | Ingredient ids (or canonical names) used here. Drives cook mode. |
| `timers` | `[{ "label": "Boil pasta", "seconds": 480 }]` |
| `temperature` | `{ "value": 400, "unit": "F", "mode": "oven" }` — modes: `oven` `internal` `oil` `surface` `water` `other`. |
| `group` | Component name; must appear in `groups`. |

### Amounts in step text

Wrap an amount in `{{ }}` and it scales with the rest of the recipe:

```
"Reserve {{1.5 cup}} of the pasta water."   →  3 cups at 2×
"Bring {{2 quart}} of water to a boil."     →  4 quarts at 2×
```

Accepts `{{2}}`, `{{1.5 cup}}`, `{{1 1/2 cup}}`, `{{1/2 tsp}}`, `{{2-3 tbsp}}`.

Leave times, temperatures, and pan sizes as plain prose — those must not
scale. A number left in a free-text ingredient `note` gets a warning, since it
would go stale the moment someone doubles the recipe.

## Groups

For recipes with components, declare them in order and tag the lines:

```json
{
  "groups": ["For the sauce", "For the pasta"],
  "ingredients": [{ "item": "anchovy", "group": "For the sauce", "...": "" }],
  "steps": [{ "text": "Melt the anchovies…", "group": "For the sauce" }]
}
```

Ungrouped lines render first. Steps are numbered continuously across groups.

## Recipe-level fields

`title` `subtitle` `description` `source` `yield` `times` `tags` `equipment`
`notes` `images` `visibility`

- `source`: `{ name, author, url, book, note }` — `note` is where adaptations
  go (`"halved the garlic"`).
- `times`: `{ prepMin, cookMin, totalMin, activeMin }`. `activeMin` is what
  actually decides a weeknight, so set it when you can.
- `visibility`: `household` (default), `friends`, or `private`.

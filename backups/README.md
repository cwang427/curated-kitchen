# Recipe backups

Automated, versioned snapshots of the household's recipes, pulled from Firestore
by `.github/workflows/backup-recipes.yml` (weekly + on demand). The app is the
source of truth for recipes now; this is the safety net so nothing is lost.

- **`backups/recipes/*.json`** — one file per live recipe, as stored. Additive:
  the backup never deletes, so a recipe removed in the app still lives on in git
  history.
- Separate from **`recipes/*.json`**, which is the original hand-authored seed
  archive (the retired repo→Firestore sync's source).

Restore after a mishap (owner, from a computer with the service-account key):

```
npm run backup:recipes -- --household=<householdId> --restore
```

This writes the snapshot straight back to Firestore by slug. Disaster recovery
only — it overwrites the current documents for those slugs.

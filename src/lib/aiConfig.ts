/**
 * Where the recipe-import Worker lives. Not a secret (like firebaseConfig) —
 * it's just a URL; the Worker itself checks that callers are signed-in members.
 *
 * Empty until you deploy the Worker (see worker/README.md), which keeps the
 * app building and deploying fine — the "Add recipe" screen simply shows a
 * "set up AI import" note until this is filled in. Paste the deployed URL here,
 * commit, and push.
 */
export const AI_IMPORT_URL = ''

export const aiImportConfigured = AI_IMPORT_URL.length > 0

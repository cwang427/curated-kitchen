/**
 * Turn a Firestore/Auth failure into a message that tells the two people
 * running this app what to actually do — a permission error (usually rules
 * that need re-publishing) reads very differently from a dropped connection,
 * and "check your connection" for both is what made the last bug confusing.
 */
export function describeFirestoreError(cause: unknown, action: string): string {
  const code = (cause as { code?: string })?.code ?? ''

  if (code.includes('permission-denied')) {
    return `Not allowed to ${action}. This is usually the Firestore rules — re-publish firestore.rules in the Firebase console.`
  }
  if (code.includes('unauthenticated')) {
    return `You’ve been signed out. Sign in again to ${action}.`
  }
  if (
    code.includes('unavailable') ||
    code.includes('deadline-exceeded') ||
    code === 'auth/network-request-failed'
  ) {
    return `Couldn’t reach the database to ${action}. Check your connection and try again.`
  }
  return `Couldn’t ${action}. ${cause instanceof Error ? cause.message : 'Please try again.'}`
}

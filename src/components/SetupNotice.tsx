/**
 * Shown when src/lib/firebaseConfig.ts is still empty. Renders without
 * touching Firebase at all, so a fresh clone deploys and explains itself
 * instead of showing a blank page.
 */
export default function SetupNotice() {
  return (
    <div className="mx-auto max-w-lg px-6 py-16">
      <h1 className="font-serif text-3xl tracking-tight">Curated Kitchen</h1>
      <p className="mt-2 text-ink-soft">
        Almost there — the app needs a Firebase project before it can sign you in.
      </p>

      <ol className="mt-8 space-y-4 text-sm leading-relaxed">
        <li>
          <span className="font-semibold">1.</span> In the{' '}
          <a
            href="https://console.firebase.google.com"
            target="_blank"
            rel="noreferrer noopener"
            className="text-accent underline"
          >
            Firebase console
          </a>
          , create a project. Analytics isn't needed.
        </li>
        <li>
          <span className="font-semibold">2.</span> Build › Authentication › enable{' '}
          <span className="font-medium">Email/Password</span>, then add your
          accounts under the Users tab.
        </li>
        <li>
          <span className="font-semibold">3.</span> Build › Firestore Database › create one in{' '}
          <span className="font-medium">production mode</span>.
        </li>
        <li>
          <span className="font-semibold">4.</span> Project settings › Your apps › Web (
          <code className="text-accent">&lt;/&gt;</code>), then paste the config values into{' '}
          <code className="text-accent">src/lib/firebaseConfig.ts</code> and push.
        </li>
      </ol>

      <p className="mt-8 border-l-2 border-line pl-3 text-sm text-ink-faint">
        Those values aren't secrets — they ship in the bundle either way. The
        Firestore rules are what protect your data.
      </p>
    </div>
  )
}

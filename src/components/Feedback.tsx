import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { FEEDBACK_KITCHEN, sendFeedback, setFeedbackDone, useFeedback } from '../data/feedback'
import { FEEDBACK_MAX, feedbackForClaude, type FeedbackItem } from '../lib/feedback'
import { agoText } from '../lib/when'

const button = 'min-h-11 rounded-full px-4 text-sm transition active:scale-[0.98] disabled:opacity-50'

/**
 * Settings' feedback section: a "Send feedback" box for friends, and the
 * inbox for the app's owner. Friends used to text the owner; this keeps it in
 * one private place, with the version and phone each message came from.
 */
export default function Feedback() {
  const { owner } = useFeedback()
  // A build without the main kitchen's id (local dev) has nowhere to send it.
  if (!FEEDBACK_KITCHEN) return null
  return owner ? <FeedbackInbox /> : <FeedbackForm />
}

type Status = { kind: 'sent' | 'queued' | 'error'; text: string } | null

function FeedbackForm() {
  const { user, profile } = useAuth()
  const { ownerName } = useFeedback()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  if (!user) return null

  const to = ownerName ?? 'the app’s owner'
  const send = () => {
    const message = text.trim()
    if (!message || sending) return
    setSending(true)
    setStatus(null)
    const name = profile?.displayName ?? user.email?.split('@')[0] ?? 'Someone'
    // With no signal, Firestore keeps the message on the phone and sends it
    // when it can — so after a few seconds, say so rather than spin.
    const slow = setTimeout(() => {
      setSending(false)
      setText('')
      setStatus({ kind: 'queued', text: 'Saved on your phone — it’ll send by itself when you’re back online.' })
    }, 4000)
    sendFeedback(user.uid, name, message)
      .then(() => {
        clearTimeout(slow)
        setText('')
        setStatus({ kind: 'sent', text: `Sent to ${to} — thanks!` })
      })
      .catch(() => {
        clearTimeout(slow)
        // Keep what they wrote, and give them a way that always works.
        setText(message)
        setStatus({
          kind: 'error',
          text: `Couldn’t send it just now. Try again in a bit — or text it to ${ownerName ?? 'them'} instead.`,
        })
      })
      .finally(() => setSending(false))
  }

  const left = FEEDBACK_MAX - text.length
  return (
    <section className="rounded-2xl border border-line bg-card p-4">
      <h3 className="font-medium">Send feedback</h3>
      <p className="mt-1 text-sm text-ink-soft">
        Something confusing, broken, or missing? Tell {to} here — only they will see it.
      </p>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          if (status?.kind !== 'error') setStatus(null)
        }}
        maxLength={FEEDBACK_MAX}
        rows={4}
        aria-label="Your feedback"
        placeholder="What happened, or what you’d like…"
        className="mt-3 w-full resize-y rounded-xl border border-line bg-paper px-3 py-2 text-base outline-none focus:border-accent"
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="text-xs tabular-nums text-ink-faint">{left < 200 ? `${left} characters left` : ''}</span>
        <button
          type="button"
          onClick={send}
          disabled={!text.trim() || sending}
          className={`${button} bg-accent font-semibold text-white dark:text-stone-900`}
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
      {status && (
        <p
          role={status.kind === 'error' ? 'alert' : 'status'}
          className={`mt-2 text-sm ${status.kind === 'error' ? 'text-red-600 dark:text-red-400' : 'text-check'}`}
        >
          {status.text}
        </p>
      )}
    </section>
  )
}

function FeedbackInbox() {
  const { items } = useFeedback()
  const [showDone, setShowDone] = useState(false)
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // Keep "12 min ago" honest while Settings stays open.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  const open = items.filter((f) => !f.done)
  const done = items.filter((f) => f.done)
  const forClaude = feedbackForClaude(items)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(forClaude)
      setCopied('yes')
      setTimeout(() => setCopied(null), 2000)
    } catch {
      // Clipboard blocked: show the text to select and copy by hand.
      setCopied('failed')
    }
  }

  return (
    <section className="rounded-2xl border border-line bg-card p-4">
      <h3 className="flex items-baseline gap-2 font-medium">
        Feedback from friends
        {open.length > 0 && <span className="text-sm font-normal text-ink-faint">{open.length} open</span>}
      </h3>
      {open.length === 0 ? (
        <p className="mt-1 text-sm text-ink-soft">
          Nothing waiting. Friends send it from Settings › Send feedback — only you can read it.
        </p>
      ) : (
        <>
          <ul className="mt-3 space-y-2">
            {open.map((item) => (
              <FeedbackCard key={item.id} item={item} now={now} />
            ))}
          </ul>
          <div className="mt-3">
            <button
              type="button"
              onClick={() => void copy()}
              className={`${button} w-full border border-line font-medium text-ink-soft`}
            >
              {copied === 'yes' ? 'Copied ✓' : 'Copy open feedback for Claude'}
            </button>
            <p className="mt-1 text-xs text-ink-faint">Paste it into a chat with Claude to work through it.</p>
            {copied === 'failed' && (
              <textarea
                readOnly
                value={forClaude}
                rows={6}
                aria-label="Open feedback, to copy"
                onFocus={(e) => e.currentTarget.select()}
                className="mt-2 w-full rounded-xl border border-line bg-paper px-3 py-2 text-sm"
              />
            )}
          </div>
        </>
      )}
      {done.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowDone((v) => !v)}
            aria-expanded={showDone}
            className="min-h-11 text-sm text-ink-faint underline underline-offset-2"
          >
            {showDone ? 'Hide' : 'Show'} {done.length} done
          </button>
          {showDone && (
            <ul className="mt-1 space-y-2">
              {done.map((item) => (
                <FeedbackCard key={item.id} item={item} now={now} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

function FeedbackCard({ item, now }: { item: FeedbackItem; now: number }) {
  const [error, setError] = useState(false)
  const toggle = () => {
    setError(false)
    setFeedbackDone(item.id, !item.done).catch(() => setError(true))
  }
  return (
    <li className={`rounded-xl border border-line p-3 ${item.done ? 'bg-paper' : 'bg-card'}`}>
      <p className="text-sm">
        <span className="font-medium">{item.name}</span>
        <span className="text-ink-faint"> · {agoText(item.createdAt, now) || 'sending…'}</span>
      </p>
      <p className={`mt-1 whitespace-pre-wrap text-pretty ${item.done ? 'text-ink-faint' : 'text-ink'}`}>{item.text}</p>
      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="min-w-0 text-xs text-ink-faint">
          {item.device} · v{item.version}
        </p>
        <button
          type="button"
          onClick={toggle}
          className={`${button} shrink-0 border border-line ${item.done ? 'text-ink-faint' : 'font-medium text-check'}`}
        >
          {item.done ? 'Not done' : 'Done ✓'}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-1 text-sm text-red-600 dark:text-red-400">
          Couldn’t update it — try again.
        </p>
      )}
    </li>
  )
}

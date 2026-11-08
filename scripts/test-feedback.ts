/**
 * Pure-logic tests for feedback (src/lib/feedback.ts): the phone a message
 * came from, in words, and the block the owner copies for Claude.
 *
 *   npm run test:feedback
 */
import { deviceLabel, feedbackForClaude, type FeedbackItem } from '../src/lib/feedback'

let passed = 0
let failed = 0
function eq(label: string, a: unknown, b: unknown): void {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  if (ok) { console.log(`  ✓ ${label} (${JSON.stringify(a)})`); passed++ }
  else { console.error(`  ✗ ${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); failed++ }
}

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
const IPAD_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15'
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

console.log('deviceLabel')
eq('iPhone, installed', deviceLabel(IPHONE, true), 'iPhone · iOS 18.2 · Home Screen app')
eq('iPhone, in Safari', deviceLabel(IPHONE, false), 'iPhone · iOS 18.2 · browser')
eq('an iPad asking for the desktop site (touchscreen)', deviceLabel(IPAD_DESKTOP, true, 5), 'iPad · Home Screen app')
eq('a real Mac (no touchscreen)', deviceLabel(IPAD_DESKTOP, false, 0), 'Mac · browser')
eq('Android (not "Linux")', deviceLabel(ANDROID, false), 'Android 14 · browser')
eq('Windows', deviceLabel(WINDOWS, false), 'Windows · browser')
eq('something unknown', deviceLabel('curl/8.0', false), 'Unknown device · browser')

console.log('feedbackForClaude')
const item = (id: string, at: number | null, done: boolean, text: string, name = 'Sam'): FeedbackItem => ({
  id, uid: `u-${id}`, name, text, version: '0.55.0 (abc1234)', device: 'iPhone · iOS 18.2 · Home Screen app', createdAt: at, done,
})
const nov7 = new Date(2026, 10, 7, 12).getTime()
const nov8 = new Date(2026, 10, 8, 12).getTime()
eq('nothing open → nothing to copy', feedbackForClaude([item('a', nov7, true, 'old')]), '')
eq(
  'open ones only, oldest first, multi-line text indented',
  feedbackForClaude([
    item('b', nov8, false, 'Can the list\nsort by store?', 'Jordan'),
    item('a', nov7, false, 'The star confused me'),
    item('c', nov7, true, 'Already handled'),
  ]),
  [
    'Feedback from friends using Curated Kitchen (2 open):',
    '',
    '1. Sam — Nov 7, 2026 · iPhone · iOS 18.2 · Home Screen app · v0.55.0 (abc1234)',
    '   The star confused me',
    '',
    '2. Jordan — Nov 8, 2026 · iPhone · iOS 18.2 · Home Screen app · v0.55.0 (abc1234)',
    '   Can the list',
    '   sort by store?',
    '',
  ].join('\n'),
)
eq('one still sending (no server time yet) goes last', feedbackForClaude([item('n', null, false, 'just sent'), item('a', nov7, false, 'earlier')]).indexOf('earlier') < feedbackForClaude([item('n', null, false, 'just sent'), item('a', nov7, false, 'earlier')]).indexOf('just sent'), true)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)

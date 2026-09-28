/*
 * Notifications, added to the app's service worker (vite.config.ts →
 * workbox.importScripts). The Worker sends them (worker/src/notify.ts):
 * { title, body, tag, path, kind, summary }.
 *
 * iPhone insists every push shows a notification (or it stops delivering
 * them), so this always shows one.
 */
self.addEventListener('push', (event) => {
  let msg = {}
  try {
    msg = event.data ? event.data.json() : {}
  } catch {
    msg = { title: 'Curated Kitchen', body: event.data ? event.data.text() : '' }
  }
  const scope = self.registration.scope
  const shown = [
    self.registration.showNotification(msg.title || 'Curated Kitchen', {
      body: msg.body || '',
      tag: msg.tag || undefined,
      icon: `${scope}icons/icon-192.png`,
      data: { path: msg.path || '' },
    }),
  ]
  // A timer rang: swap the "timers running" note for what's still counting down.
  if (msg.kind === 'timer' && 'summary' in msg) {
    shown.push(
      self.registration.getNotifications({ tag: 'timers' }).then((old) => {
        for (const n of old) n.close()
        if (msg.summary) {
          return self.registration.showNotification(msg.summary.title, {
            body: msg.summary.body,
            tag: 'timers',
            silent: true,
            icon: `${scope}icons/icon-192.png`,
            data: { path: msg.path || '' },
          })
        }
      }),
    )
  }
  event.waitUntil(Promise.all(shown))
})

// Tapping one opens the app on that screen — the app itself moves there (so
// nothing in progress is lost), or it opens fresh at that address.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const path = (event.notification.data && event.notification.data.path) || ''
  const scope = self.registration.scope
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const app = windows.find((w) => w.url.startsWith(scope))
      if (app) {
        await app.focus()
        app.postMessage({ type: 'open', path: `/${path}` })
        return
      }
      await self.clients.openWindow(`${scope}${path}`)
    })(),
  )
})

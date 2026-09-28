/**
 * The Worker's entry point. Everything lives in importer.ts (the import queue
 * in queue.ts, notifications in notify.ts), so the tests (scripts/test-*.ts)
 * can import their pieces without them becoming exports of the Worker itself.
 */
import { DurableObject } from 'cloudflare:workers'
import { worker, type Env } from './importer'
import { QueueCore, type QueueState } from './queue'
import { NotifyCore } from './notify'

/** The import queue's Durable Object — Cloudflare finds it by this export's
 * name (wrangler.toml). A thin wrapper: the logic is QueueCore (queue.ts),
 * which the tests run without Cloudflare's runtime. */
export class ImportQueue extends DurableObject<Env> {
  private readonly core: QueueCore
  constructor(ctx: QueueState, env: Env) {
    super(ctx, env)
    this.core = new QueueCore(ctx, env)
  }
  fetch(request: Request): Promise<Response> {
    return this.core.fetch(request)
  }
  alarm(): Promise<void> {
    return this.core.alarm()
  }
}

/** Notifications' Durable Object (one per person): push subscriptions and
 * running timers. Separate from the queue so a timer never waits on an import. */
export class Notifier extends DurableObject<Env> {
  private readonly core: NotifyCore
  constructor(ctx: QueueState, env: Env) {
    super(ctx, env)
    this.core = new NotifyCore(ctx, env)
  }
  fetch(request: Request): Promise<Response> {
    return this.core.fetch(request)
  }
  alarm(): Promise<void> {
    return this.core.alarm()
  }
}

export default worker

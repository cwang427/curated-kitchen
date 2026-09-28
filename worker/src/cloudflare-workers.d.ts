// The part of Cloudflare's runtime module this Worker uses, for type-checking
// (wrangler supplies the real one when it builds).
declare module 'cloudflare:workers' {
  export abstract class DurableObject<Env = unknown> {
    protected ctx: unknown
    protected env: Env
    constructor(ctx: unknown, env: Env)
  }
}

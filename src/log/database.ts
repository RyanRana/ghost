import type { GhostCall } from "../call.js"
import type { GhostRowChange } from "../patch.js"
import type { GhostHeld, GhostLog, GhostWrite, GhostWriteKind, NewHeld, NewWrite } from "./types.js"

type Entry = { seq: number; at: string; kind: "write" | "held"; entry: Record<string, unknown> }
type Page = { startedAt: string | null; entries: Entry[]; total: number | string }
type Kept = { startedAt: string | null; entries: Entry[] }

/** A deployed session, kept in the database's ghost.sessions/ghost.entries: the same on every server, ignored after
 *  12 h idle. `call` must reach the database directly, never through ghost. */
export class DatabaseGhostLog implements GhostLog {
  readonly store = "database" as const
  constructor(readonly id: string, private call: GhostCall) {}

  // Every ghosted read asks for the session's writes, and a page makes hundreds of reads: reading the whole log each
  // time (every write's body and row images) is most of what a long session costs. The log is kept here and only
  // what was written since is fetched.
  private kept: { startedAt: string; entries: Entry[]; last: number } | null = null
  private checking: Promise<Kept> | null = null
  private queued: Promise<Kept> | null = null

  private read(): Promise<Kept> {
    if (!this.checking) return this.check()
    // A check already under way may have started before a write this caller must see: share the one after it.
    return (this.queued ??= this.checking.then(() => this.check(), () => this.check()))
  }

  private check(): Promise<Kept> {
    this.queued = null
    const run = this.fresh()
    this.checking = run
    const done = () => { if (this.checking === run) this.checking = null }
    run.then(done, done)
    return run
  }

  private async since(after: number): Promise<Page> {
    return (await this.call("ghost_log_entries", { p_session: this.id, p_after: after })) as Page
  }

  private async fresh(): Promise<Kept> {
    const kept = this.kept
    let page = await this.since(kept?.last ?? 0)
    if (!page.startedAt) { this.kept = null; return { startedAt: null, entries: [] } }
    let entries = kept?.startedAt === page.startedAt ? [...kept.entries, ...page.entries] : null
    // A reset starts the session over, and an entry that committed late can sit below the newest seq: both show as a
    // total that doesn't add up, and the log is read whole again.
    if (!entries || entries.length !== Number(page.total)) {
      page = kept ? await this.since(0) : page
      if (!page.startedAt) { this.kept = null; return { startedAt: null, entries: [] } }
      entries = page.entries
    }
    this.kept = { startedAt: page.startedAt, entries, last: Number(entries.at(-1)?.seq ?? 0) }
    return { startedAt: page.startedAt, entries }
  }

  async startedAt() { return (await this.read()).startedAt ?? "" }

  async addWrite(w: NewWrite) {
    await this.call("ghost_log_add", { p_session: this.id, p_kind: "write", p_entry: w })
  }

  async writes(): Promise<GhostWrite[]> {
    return (await this.read()).entries.filter((e) => e.kind === "write").map(({ seq, at, entry: r }) => ({
      seq: Number(seq), at, kind: r.kind as GhostWriteKind, method: String(r.method), target: String(r.target), path: String(r.path),
      headers: (r.headers ?? {}) as Record<string, string>, body: r.body == null ? null : String(r.body),
      changes: (r.changes ?? null) as GhostRowChange[] | null,
    }))
  }

  async addHeld(h: NewHeld) {
    await this.call("ghost_log_add", { p_session: this.id, p_kind: "held", p_entry: h })
  }

  async held(): Promise<GhostHeld[]> {
    return (await this.read()).entries.filter((e) => e.kind === "held").map(({ seq, at, entry: r }) => ({
      seq: Number(seq), at, method: String(r.method), host: String(r.host), path: String(r.path), summary: String(r.summary),
    }))
  }

  async reset() {
    this.kept = null
    await this.call("ghost_log_reset", { p_session: this.id })
  }

  async end() {
    this.kept = null
    await this.call("ghost_log_end", { p_session: this.id })
  }
}

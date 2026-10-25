import type { GhostCall } from "../call.js"
import type { GhostRowChange } from "../patch.js"
import type { GhostHeld, GhostLog, GhostWrite, GhostWriteKind, NewHeld, NewWrite } from "./types.js"

type Entry = { seq: number; at: string; kind: "write" | "held"; entry: Record<string, unknown> }

/** A deployed session, kept in the database's ghost.sessions/ghost.entries: the same on every server, ignored after
 *  12 h idle. `call` must reach the database directly, never through ghost. */
export class DatabaseGhostLog implements GhostLog {
  readonly store = "database" as const
  constructor(readonly id: string, private call: GhostCall) {}

  private async read(): Promise<{ startedAt: string | null; entries: Entry[] }> {
    return (await this.call("ghost_log_entries", { p_session: this.id })) as { startedAt: string | null; entries: Entry[] }
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

  async reset() { await this.call("ghost_log_reset", { p_session: this.id }) }
  async end() { await this.call("ghost_log_end", { p_session: this.id }) }
}

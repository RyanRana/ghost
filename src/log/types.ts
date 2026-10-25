import type { GhostRowChange } from "../patch.js"

export type GhostWriteKind = "table" | "rpc" | "storage" | "function" | "sql"

/** A database write exactly as the app sent it. */
export interface GhostWrite {
  seq: number
  at: string
  kind: GhostWriteKind
  method: string
  /** The table, the RPC's name, `storage:<bucket>`, the edge function's name, or `sql` for a statement run on a connection. */
  target: string
  /** Path and query string, e.g. `/rest/v1/orders?id=eq.1&select=*`. */
  path: string
  /** Prefer, Accept, Content-Type and the profile headers, when sent. */
  headers: Record<string, string>
  /** The raw request body; null for storage uploads, whose bytes aren't kept. */
  body: string | null
  /** Every row the database's real logic changed for this write inside its rolled-back run; later reads replay these. */
  changes?: GhostRowChange[] | null
}

/** A send to anything outside the database (email, chat, payments) that ghost held instead of sending. */
export interface GhostHeld { seq: number; at: string; method: string; host: string; path: string; summary: string }

export type NewWrite = Omit<GhostWrite, "seq" | "at">
export type NewHeld = Omit<GhostHeld, "seq" | "at">

/** One person's ghost session: only its own writes and held sends. */
export interface GhostLog {
  readonly id: string
  readonly store: "memory" | "file" | "database"
  startedAt(): Promise<string>
  addWrite(write: NewWrite): Promise<void>
  writes(): Promise<GhostWrite[]>
  addHeld(held: NewHeld): Promise<void>
  held(): Promise<GhostHeld[]>
  /** Empties this session; it goes on. */
  reset(): Promise<void>
  /** Ends this session and deletes what it kept. */
  end(): Promise<void>
}

export async function sessionSummary(log: GhostLog, recent = 20) {
  const [writes, held, startedAt] = await Promise.all([log.writes(), log.held(), log.startedAt()])
  const byTarget: Record<string, number> = {}
  for (const w of writes) byTarget[w.target] = (byTarget[w.target] ?? 0) + 1
  return {
    sessionId: log.id,
    store: log.store,
    startedAt,
    writeCount: writes.length,
    writes: byTarget,
    heldSends: held.length,
    recent: [
      ...writes.map((w) => ({ seq: w.seq, at: w.at, what: `${w.method} ${w.kind} ${w.target}` })),
      ...held.map((h) => ({ seq: h.seq, at: h.at, what: `held ${h.method} ${h.host}${h.path}` })),
    ].sort((a, b) => b.seq - a.seq).slice(0, recent),
  }
}

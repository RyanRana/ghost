import type { GhostHeld, GhostLog, GhostWrite, GhostWriteKind, NewHeld, NewWrite } from "./types.js"

type DatabaseSync = import("node:sqlite").DatabaseSync
type SqlRow = Record<string, string | number | null>

const stamp = () => new Date().toISOString()
const SQLITE_VERSION = 1
const SQLITE_SCHEMA = `
  create table if not exists sessions (id text primary key, started_at text not null, last_seen_at text not null);
  create table if not exists writes (session_id text not null, seq integer not null, at text not null, kind text not null,
    method text not null, target text not null, path text not null, headers text not null, body text, changes text,
    primary key (session_id, seq));
  create table if not exists held (session_id text not null, seq integer not null, at text not null, method text not null,
    host text not null, path text not null, summary text not null, primary key (session_id, seq));
`

// One handle per file, shared by every session in it and kept across dev-server reloads.
const files = ((globalThis as { __ghostFiles?: Map<string, DatabaseSync> }).__ghostFiles ??= new Map())

/** The SQLite file, created or brought to this layout (an older layout is dropped). */
export function openGhostFile(path: string): DatabaseSync {
  const open = files.get(path)
  if (open) return open
  // getBuiltinModule keeps bundlers from resolving node:sqlite for code paths that never open a file.
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite")
  const { mkdirSync } = process.getBuiltinModule("node:fs") as typeof import("node:fs")
  const { dirname } = process.getBuiltinModule("node:path") as typeof import("node:path")
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  const version = Number((db.prepare("pragma user_version").get() as SqlRow).user_version ?? 0)
  if (version !== SQLITE_VERSION) {
    db.exec(`drop table if exists writes; drop table if exists held; drop table if exists sessions;
      ${SQLITE_SCHEMA} pragma user_version = ${SQLITE_VERSION};`)
  }
  files.set(path, db)
  return db
}

/** A local session in a file: it survives a restart, and other sessions in the file never see it. */
export class SqliteGhostLog implements GhostLog {
  readonly store = "file" as const
  private db: DatabaseSync

  constructor(readonly id: string, readonly path: string) {
    this.db = openGhostFile(path)
    const now = stamp()
    this.db.prepare("insert into sessions (id, started_at, last_seen_at) values (?, ?, ?) on conflict (id) do update set last_seen_at = excluded.last_seen_at")
      .run(id, now, now)
  }

  // Writes and held sends share one sequence per session, so it reads back in the order it happened.
  private nextSeq(): number {
    const row = this.db.prepare(`select max(seq) as seq from (select seq from writes where session_id = ?
      union all select seq from held where session_id = ?)`).get(this.id, this.id) as SqlRow
    return Number(row.seq ?? 0) + 1
  }

  async startedAt() {
    return String((this.db.prepare("select started_at from sessions where id = ?").get(this.id) as SqlRow | undefined)?.started_at ?? "")
  }

  async addWrite(w: NewWrite) {
    this.db.prepare("insert into writes (session_id, seq, at, kind, method, target, path, headers, body, changes) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(this.id, this.nextSeq(), stamp(), w.kind, w.method, w.target, w.path, JSON.stringify(w.headers), w.body,
        w.changes ? JSON.stringify(w.changes) : null)
  }

  async writes(): Promise<GhostWrite[]> {
    return (this.db.prepare("select * from writes where session_id = ? order by seq").all(this.id) as SqlRow[]).map((r) => ({
      seq: Number(r.seq), at: String(r.at), kind: r.kind as GhostWriteKind, method: String(r.method), target: String(r.target),
      path: String(r.path), headers: JSON.parse(String(r.headers)), body: r.body == null ? null : String(r.body),
      changes: r.changes == null ? null : JSON.parse(String(r.changes)),
    }))
  }

  async addHeld(h: NewHeld) {
    this.db.prepare("insert into held (session_id, seq, at, method, host, path, summary) values (?, ?, ?, ?, ?, ?, ?)")
      .run(this.id, this.nextSeq(), stamp(), h.method, h.host, h.path, h.summary)
  }

  async held(): Promise<GhostHeld[]> {
    return (this.db.prepare("select * from held where session_id = ? order by seq").all(this.id) as SqlRow[]).map((r) => ({
      seq: Number(r.seq), at: String(r.at), method: String(r.method), host: String(r.host), path: String(r.path), summary: String(r.summary),
    }))
  }

  async reset() {
    this.db.prepare("delete from writes where session_id = ?").run(this.id)
    this.db.prepare("delete from held where session_id = ?").run(this.id)
    this.db.prepare("update sessions set started_at = ? where id = ?").run(stamp(), this.id)
  }

  async end() {
    for (const table of ["writes", "held"]) this.db.prepare(`delete from ${table} where session_id = ?`).run(this.id)
    this.db.prepare("delete from sessions where id = ?").run(this.id)
  }
}

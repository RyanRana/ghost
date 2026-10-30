import { MemoryGhostLog } from "../log/memory.js"
import { sessionSummary, type GhostLog } from "../log/types.js"
import { GhostError, isGhostError, retrying, serial } from "./errors.js"
import type { Check, Conn, ConnSource, Dialect, DialectName, Migration, Row, RowChange } from "./types.js"

export type Query = (sql: string, params?: readonly unknown[]) => Promise<{ rows: Row[]; affected: number }>

export interface GhostDbOptions {
  dialect: Dialect
  source: ConnSource
  /** Where sessions are kept. Default: memory. */
  log?: (id: string) => GhostLog
  /** Branch migrations to run first in every run (see migrationLoader). */
  migrations?: () => Promise<Migration[]>
  /** Statement timeout inside a run. Default 5 s. */
  timeoutMs?: number
  /** Tries per run when the database answers with a deadlock, a lock wait or busy. Default 8 (about 3 s at most):
   *  ghost never waits long for a lock live traffic holds, so it asks again instead. */
  tries?: number
  /** Install or refresh ghost before a run when tables or triggers are new since the last install. Default false. */
  autoInstall?: boolean
}

export interface GhostDbSession {
  readonly id: string
  readonly log: GhostLog
  /** One statement as a ghost write: it runs for real, the rows it changed join the session, nothing is kept. */
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: Row[]; affected: number; changes: RowChange[] }>
  /** A read that sees the session's earlier writes. Even a read runs inside a rolled-back transaction. */
  read(sql: string, params?: readonly unknown[]): Promise<{ rows: Row[] }>
  /** Several statements in one run, as one write. On a deadlock `run` can be called again, like any retrying transaction. */
  transaction<T>(run: (query: Query) => Promise<T>): Promise<{ result: T; changes: RowChange[] }>
  /** Every row this session changed, in order. */
  changes(): Promise<RowChange[]>
  summary(): ReturnType<typeof sessionSummary>
  /** Forgets what this session did; it goes on. */
  reset(): Promise<void>
  /** Ends the session and deletes its log. */
  end(): Promise<void>
}

export interface GhostDb {
  readonly dialect: DialectName
  session(id?: string): GhostDbSession
  /** Adds or refreshes what ghost needs in the database. Safe to run again. */
  install(): Promise<Record<string, unknown>>
  doctor(): Promise<{ ok: boolean; checks: Check[] }>
  /** Closes connections ghost opened itself. */
  close(): Promise<void>
}

const SESSION_ID = /^[A-Za-z0-9_.:-]{1,64}$/
const STALE_CHECK_MS = 30_000

export function createGhostDb(options: GhostDbOptions): GhostDb {
  const { dialect, source } = options
  const makeLog = options.log ?? ((id: string) => new MemoryGhostLog(id))
  const timeoutMs = options.timeoutMs ?? 5_000
  const tries = options.tries ?? 8
  const sessions = new Map<string, GhostDbSession>()

  const withConn = async <T>(fn: (conn: Conn, broke: () => void) => Promise<T>) => {
    const { conn, release } = await source.acquire()
    let broken = false
    let result: T
    try {
      result = await fn(conn, () => { broken = true })
    } catch (error) {
      // The run's own error says more than one from handing the connection back.
      try { await release(broken) } catch {}
      throw error
    }
    await release(broken)
    return result
  }

  let checkedAt = 0
  let installing: Promise<unknown> | null = null
  const freshen = async () => {
    if (!options.autoInstall || Date.now() - checkedAt < STALE_CHECK_MS) return
    installing ??= withConn(async (conn) => {
      if (await dialect.stale(conn)) await dialect.install(conn)
      checkedAt = Date.now()
    }).finally(() => { installing = null })
    await installing
  }

  /** One ghost run: open, the session's rows back, `body`, collect, roll back. Retried whole on a transient error. */
  const run = async <T>(log: GhostLog, capture: boolean, body: (query: Query) => Promise<T>) => {
    await freshen()
    const [prior, migrations] = await Promise.all([sessionChanges(log), options.migrations?.() ?? []])
    return retrying(() => withConn(async (conn, broke) => {
      try {
        await dialect.open(conn, prior, { capture, migrations, timeoutMs })
        const query: Query = async (sql, params) => {
          const why = await dialect.refuse(sql, conn)
          if (why) throw new GhostError("refused", why)
          return conn.query(sql, params)
        }
        const result = await body(query)
        const changes = capture ? await dialect.close(conn) : []
        return { result, changes }
      } finally {
        // A connection that couldn't roll back is dropped: the database rolls back whatever it still holds when it goes.
        // Ghost's own alarm (something committed) is the run's answer; any other failure leaves the run's own.
        try {
          await dialect.rollback(conn)
        } catch (error) {
          broke()
          if (isGhostError(error)) throw error
        }
      }
    }), { tries, transient: dialect.transient })
  }

  const remember = async (log: GhostLog, label: string, changes: RowChange[]) => {
    if (!changes.length) return
    const tables = [...new Set(changes.map((c) => c.table))].sort().join(", ")
    await log.addWrite({ kind: "sql", method: "SQL", target: tables, path: "", headers: {}, body: label, changes })
  }

  const session = (id = "default"): GhostDbSession => {
    if (!SESSION_ID.test(id)) throw new Error(`[ghost] a session id is 1-64 letters, digits, dots, colons, dashes or underscores, not ${JSON.stringify(id)}`)
    const open = sessions.get(id)
    if (open) return open
    const log = makeLog(id)
    // One run at a time per session, so each one sees every write before it.
    const turn = serial()
    const s: GhostDbSession = {
      id,
      log,
      query: (sql, params) => turn(async () => {
        const { result, changes } = await run(log, true, (q) => q(sql, params))
        await remember(log, sql, changes)
        return { ...result, changes }
      }),
      read: (sql, params) => turn(async () => ({ rows: (await run(log, false, (q) => q(sql, params))).result.rows })),
      transaction: (body) => turn(async () => {
        const out = await run(log, true, body)
        await remember(log, "transaction", out.changes)
        return out
      }),
      changes: () => sessionChanges(log),
      summary: () => sessionSummary(log),
      reset: () => turn(() => log.reset()),
      end: () => turn(async () => {
        await log.end()
        sessions.delete(id)
      }),
    }
    sessions.set(id, s)
    return s
  }

  return {
    dialect: dialect.name,
    session,
    install: () => withConn(async (conn) => {
      const report = await dialect.install(conn)
      checkedAt = Date.now()
      return report
    }),
    async doctor() {
      const checks = await withConn((conn) => dialect.doctor(conn)).catch((error: Error) =>
        [{ name: "database connection", ok: false, detail: error.message || String(error) }])
      return { ok: checks.every((c) => c.ok), checks }
    },
    close: async () => { await source.close?.() },
  }
}

export async function sessionChanges(log: GhostLog): Promise<RowChange[]> {
  return (await log.writes()).flatMap((w) => w.changes ?? [])
}

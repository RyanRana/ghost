import { readFileSync } from "node:fs"
import { splitStatements } from "../migrations.js"
import { errorCode, GhostError, serial } from "./errors.js"
import { refusal } from "./guard.js"
import { fastPlan } from "./plan.js"
import type { Check, Conn, ConnSource, Dialect, Row } from "./types.js"

// Postgres keeps ghost in the database (sql/ghost.sql): capture triggers that only fire inside a run, a guard at the
// top of each trigger function so replay skips them, ghost twins of every sequence, and a deferred trigger that makes
// any transaction that replayed a session impossible to commit.

let ghostSql: string | null = null
export const installSql = () => (ghostSql ??= readFileSync(new URL("../../sql/ghost.sql", import.meta.url), "utf8"))

/** Anything with query(text, values) → { rows }: node-postgres, PGlite, a pool client. */
export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount?: number | null; affectedRows?: number }>
  exec?(sql: string): Promise<unknown>
}

/** postgres.js (the `postgres` package): sql.unsafe and sql.reserve. */
export interface PostgresJs {
  unsafe(text: string, values?: unknown[]): Promise<Row[] & { count?: number }>
  reserve(): Promise<PostgresJs & { release(): void }>
  end(options?: { timeout?: number }): Promise<void>
}

export const isPostgresJs = (x: unknown): x is PostgresJs => {
  const sql = x as Partial<PostgresJs> | null
  return typeof x === "function" && typeof sql?.unsafe === "function" && typeof sql?.reserve === "function"
}

/** A node-postgres Pool: connect() hands out clients with release(destroy?). */
export interface PgPool {
  connect(): Promise<PgQueryable & { release(destroy?: boolean | Error): void }>
  end(): Promise<void>
}

export const isPgPool = (x: unknown): x is PgPool =>
  !!x && typeof (x as PgPool).connect === "function" && typeof (x as PgQueryable).query === "function" && "totalCount" in (x as object)

const fromQueryable = (q: PgQueryable): Conn => ({
  async query(sql, params = []) {
    const r = await q.query(sql, params as unknown[])
    return { rows: r.rows, affected: Number(r.rowCount ?? r.affectedRows ?? r.rows.length) }
  },
})

const fromPostgresJs = (q: PostgresJs): Conn => ({
  async query(sql, params = []) {
    const rows = await q.unsafe(sql, params as unknown[])
    return { rows: [...rows], affected: Number(rows.count ?? rows.length) }
  },
})

export function postgresJsSource(sql: PostgresJs, owned: boolean): ConnSource {
  return {
    async acquire() {
      const reserved = await sql.reserve()
      return { conn: fromPostgresJs(reserved), release: () => reserved.release() }
    },
    close: async () => { if (owned) await sql.end({ timeout: 5 }) },
  }
}

export function pgPoolSource(pool: PgPool, owned: boolean): ConnSource {
  return {
    async acquire() {
      const client = await pool.connect()
      return { conn: fromQueryable(client), release: (broken) => client.release(broken || undefined) }
    },
    close: async () => { if (owned) await pool.end() },
  }
}

/** One connection (a pg Client, PGlite): one run at a time. */
export function pgSingleSource(q: PgQueryable): ConnSource {
  const conn = fromQueryable(q)
  const turn = serial()
  return {
    async acquire() {
      let done!: () => void
      const finished = new Promise<void>((resolve) => { done = resolve })
      await new Promise<void>((started) => { void turn(() => { started(); return finished }) })
      return {
        conn,
        release(broken) {
          done()
          if (broken) throw new GhostError("unsafe", "Ghost couldn't roll back its run on this connection; don't keep using it")
        },
      }
    },
  }
}

const json = (v: unknown) => JSON.stringify(v)

/** SQLSTATEs worth a fresh try: serialization, deadlock, a lock ghost wouldn't wait for, a dropped connection. */
const TRANSIENT = new Set(["40001", "40P01", "55P03", "57P01", "08000", "08003", "08006", "ECONNRESET", "CONNECTION_CLOSED"])

const unguardedSql = `select
  (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    join pg_catalog.pg_language l on l.oid = p.prolang
    where n.nspname = 'public' and l.lanname = 'plpgsql' and p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
      and position('ghost.replay' in pg_catalog.pg_get_functiondef(p.oid)) = 0)::int as unguarded,
  (select count(*) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
      and exists (select 1 from pg_catalog.pg_index i where i.indrelid = c.oid and i.indisprimary)
      and not exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = c.oid and t.tgname = '0_ghost_capture'))::int as uncaptured`

const installed = async (conn: Conn) =>
  !!(await conn.query("select pg_catalog.to_regprocedure('ghost.open_run(jsonb, jsonb, boolean, jsonb)') is not null as ok")).rows[0]?.ok

export const postgresDialect: Dialect = {
  name: "postgres",

  async open(conn, changes, options) {
    await conn.query("begin")
    await conn.query(`set local statement_timeout = ${Math.max(1, Math.round(options.timeoutMs))}`)
    try {
      await conn.query("select ghost.open_run($1::text::jsonb, $2::text::jsonb, $3::boolean, $4::text::jsonb)", [
        json(changes), options.migrations.length ? json(options.migrations) : null, options.capture,
        changes.length > 1 ? json(fastPlan(changes)) : null])
    } catch (e) {
      const code = errorCode(e)
      if (code === "42883" || code === "3F000") {
        throw new GhostError("install", "Ghost isn't installed in this database yet: run `runghost install`", { cause: e })
      }
      if (code === "GH409") throw new GhostError("collision", (e as Error).message, { cause: e })
      throw e
    }
  },

  async close(conn) {
    // What a commit would have checked: deferred constraints, all but ghost's own never-commit trigger.
    await conn.query("select ghost.deferred_checks()")
    const { rows } = await conn.query("select ghost.close_run() as changes")
    const changes = rows[0]?.changes
    return (typeof changes === "string" ? JSON.parse(changes) : changes ?? []) as never
  },

  async rollback(conn) {
    await conn.query("rollback")
  },

  async refuse(sql) {
    const why = refusal("postgres", sql)
    if (why) return why
    if (/\bpg_advisory_lock(_shared)?\s*\(/i.test(sql)) {
      return "Ghost can't take a session advisory lock: it would outlive the rollback (pg_advisory_xact_lock works)"
    }
    return null
  },

  transient: (e) => TRANSIENT.has(errorCode(e) ?? ""),

  async install(conn) {
    for (const statement of splitStatements(installSql())) await conn.query(statement)
    const { rows } = await conn.query("select ghost.install() as report")
    const report = rows[0]?.report
    return (typeof report === "string" ? JSON.parse(report) : report) as Record<string, unknown>
  },

  async stale(conn) {
    if (!(await installed(conn))) return 1
    const row = (await conn.query(unguardedSql)).rows[0]!
    return Number(row.unguarded) + Number(row.uncaptured)
  },

  async doctor(conn) {
    const version = String((await conn.query("select pg_catalog.current_setting('server_version') as v")).rows[0]?.v)
    const checks: Check[] = [{ name: "database", ok: true, detail: `Postgres ${version}` }]
    if (!(await installed(conn))) {
      checks.push({ name: "ghost installed", ok: false, detail: "not yet: run `runghost install` (it adds a ghost schema, a capture trigger per table and a guard per trigger function)" })
      return checks
    }
    const row = (await conn.query(unguardedSql)).rows[0]!
    const stale = Number(row.unguarded) + Number(row.uncaptured)
    checks.push({ name: "install is current", ok: stale === 0, detail: stale
      ? `${row.unguarded} trigger functions and ${row.uncaptured} tables are new since the last install: run \`runghost install\``
      : "every table and trigger function is covered" })
    try {
      await postgresDialect.open(conn, [], { capture: true, migrations: [], timeoutMs: 5_000 })
      await postgresDialect.close(conn)
      checks.push({ name: "rolled-back run", ok: true, detail: "opens, captures and rolls back" })
    } catch (e) {
      checks.push({ name: "rolled-back run", ok: false, detail: (e as Error).message })
    } finally {
      await conn.query("rollback").catch(() => {})
    }
    return checks
  },
}

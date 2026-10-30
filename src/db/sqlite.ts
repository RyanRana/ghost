import { GhostError, serial } from "./errors.js"
import { refusal } from "./guard.js"
import { exactPlan, fastPlan, type ReplayBatch } from "./plan.js"
import type { Check, Conn, ConnSource, Dialect, OpenOptions, Row, RowChange } from "./types.js"

// SQLite needs nothing installed. Each connection gets TEMP capture triggers on every table: they live only on that
// connection, fire only while a ghost run has capture on, and are rebuilt when the schema changes. Replay drops your
// triggers inside the run's transaction and puts them back before your statements run; the rollback undoes both.

/** node:sqlite's DatabaseSync and better-sqlite3 both fit. */
export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement
  exec(sql: string): unknown
}
export interface SqliteStatement {
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): { changes: number | bigint }
  columns?(): unknown[]
  reader?: boolean
}

export const isSqliteDatabase = (x: unknown): x is SqliteDatabase =>
  !!x && typeof (x as SqliteDatabase).prepare === "function" && typeof (x as SqliteDatabase).exec === "function"
    && typeof (x as { query?: unknown }).query !== "function"

const q = (name: string) => `"${name.replace(/"/g, '""')}"`
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`

/** What ghost binds: booleans as 0/1, {$hex} back to bytes, other objects as JSON text. */
function bindable(v: unknown): unknown {
  if (v === undefined) return null
  if (typeof v === "boolean") return v ? 1 : 0
  if (v instanceof Date) return v.toISOString()
  if (v && typeof v === "object" && !(v instanceof Uint8Array)) {
    const hex = (v as { $hex?: unknown }).$hex
    return typeof hex === "string" && Object.keys(v).length === 1 ? Buffer.from(hex, "hex") : JSON.stringify(v)
  }
  return v
}

const conns = new WeakMap<SqliteDatabase, Conn>()

/** One SQLite handle as a ghost connection. Statements are prepared once and kept. */
export function sqliteConn(db: SqliteDatabase): Conn {
  const known = conns.get(db)
  if (known) return known
  const prepared = new Map<string, SqliteStatement>()
  const prepare = (sql: string) => {
    let stmt = prepared.get(sql)
    if (!stmt) {
      stmt = db.prepare(sql)
      if (prepared.size >= 256) prepared.delete(prepared.keys().next().value!)
      prepared.set(sql, stmt)
    }
    return stmt
  }
  const conn: Conn = {
    async query(sql, params = []) {
      const stmt = prepare(sql)
      const values = params.map(bindable)
      const returnsRows = "reader" in stmt ? !!stmt.reader : typeof stmt.columns === "function" ? stmt.columns().length > 0 : null
      if (returnsRows === false) return { rows: [], affected: Number(stmt.run(...values).changes) }
      const rows = stmt.all(...values) as Row[]
      if (returnsRows) return { rows, affected: rows.length }
      const changed = prepare("select changes() as n").all() as { n: number }[]
      return { rows, affected: rows.length || Number(changed[0]?.n ?? 0) }
    },
  }
  conns.set(db, conn)
  return conn
}

/** A single handle: one run at a time. */
export function sqliteSource(db: SqliteDatabase, close?: () => void): ConnSource {
  const conn = sqliteConn(db)
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
          // One handle can't be swapped for a fresh one: say so rather than let the app write into an open transaction.
          if (broken) throw new GhostError("unsafe", "Ghost couldn't roll back its run on this SQLite handle; don't keep using it")
        },
      }
    },
    close: async () => close?.(),
  }
}

interface Table {
  name: string
  cols: string[]
  pk: string[]
  autoincrement: boolean
  rowid: boolean
  /** Numbered by SQLite (rowid or INTEGER PRIMARY KEY): without AUTOINCREMENT a number can be used again. */
  numbered: boolean
}

interface State { version: number | null; tables: Map<string, Table>; foreignKeys: boolean }
const states = new WeakMap<Conn, State>()
const stateOf = (conn: Conn) => {
  let s = states.get(conn)
  if (!s) states.set(conn, s = { version: null, tables: new Map(), foreignKeys: false })
  return s
}

const one = async (conn: Conn, sql: string, params: unknown[] = []) => (await conn.query(sql, params)).rows[0] ?? {}

async function readTables(conn: Conn): Promise<Map<string, Table>> {
  const out = new Map<string, Table>()
  const list = (await conn.query(
    "select l.name, l.wr, s.sql from pragma_table_list l join main.sqlite_schema s on s.name = l.name "
    + "where l.schema = 'main' and l.type = 'table' and l.name not like 'sqlite\\_%' escape '\\' order by l.name")).rows
  for (const t of list) {
    const name = String(t.name)
    const info = (await conn.query("select name, type, pk, hidden from pragma_table_xinfo(?) order by cid", [name])).rows
    const cols = info.filter((c) => Number(c.hidden) === 0).map((c) => String(c.name))
    const pk = info.filter((c) => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((c) => String(c.name))
    const rowid = pk.length === 0 && !Number(t.wr)
    const intKey = pk.length === 1 && !Number(t.wr) && /^integer$/i.test(String(info.find((c) => c.name === pk[0])?.type ?? ""))
    out.set(name, { name, cols: rowid ? ["rowid", ...cols] : cols, pk: rowid ? ["rowid"] : pk, rowid,
      autoincrement: /\bautoincrement\b/i.test(String(t.sql ?? "")), numbered: rowid || intKey })
  }
  return out
}

// A value as JSON: bytes become {"$hex": "..."}, since JSON can't hold them.
const val = (ref: string) => `case typeof(${ref}) when 'blob' then json_object('$hex', hex(${ref})) else ${ref} end`

function jsonOf(ref: "new" | "old", cols: readonly string[]): string {
  const pair = (c: string) => `${lit(c)}, ${val(`${ref}.${q(c)}`)}`
  // Older SQLite caps a function at 127 arguments: wide rows add the rest with json_set.
  let expr = `json_object(${cols.slice(0, 60).map(pair).join(", ")})`
  for (let i = 60; i < cols.length; i += 60) {
    expr = `json_set(${expr}, ${cols.slice(i, i + 60).map((c) => `${lit(`$."${c}"`)}, ${val(`${ref}.${q(c)}`)}`).join(", ")})`
  }
  return expr
}

function captureTriggers(t: Table, i: number): string[] {
  const on = `main.${q(t.name)}`
  const when = "(select v from temp.ghost_state)"
  const pkNew = jsonOf("new", t.pk), pkOld = jsonOf("old", t.pk)
  const name = lit(t.name)
  const exists = t.pk.map((c) => `${q(c)} is new.${q(c)}`).join(" and ")
  return [
    // A REPLACE deletes the row it replaces without firing a delete trigger: note that the key was taken, so the
    // insert is kept as an update of that row.
    `create temp trigger ghost_${i}_bi before insert on ${on} when ${when} and exists (select 1 from ${on} where ${exists}) begin `
      + `insert into temp.ghost_existed (tbl, pk) values (${name}, ${pkNew}); end`,
    `create temp trigger ghost_${i}_ai after insert on ${on} when ${when} begin `
      + `insert into temp.ghost_changes (tbl, op, pk, old_row, new_row) values (${name}, case when exists (select 1 from temp.ghost_existed e `
      + `where e.tbl = ${name} and e.pk = ${pkNew}) then 'UPDATE' else 'INSERT' end, ${pkNew}, null, ${jsonOf("new", t.cols)}); `
      + `delete from temp.ghost_existed where tbl = ${name} and pk = ${pkNew}; end`,
    `create temp trigger ghost_${i}_au after update on ${on} when ${when} begin `
      + `insert into temp.ghost_changes (tbl, op, pk, old_row, new_row) values (${name}, 'UPDATE', ${pkOld}, ${jsonOf("old", t.cols)}, ${jsonOf("new", t.cols)}); end`,
    `create temp trigger ghost_${i}_ad after delete on ${on} when ${when} begin `
      + `insert into temp.ghost_changes (tbl, op, pk, old_row, new_row) values (${name}, 'DELETE', ${pkOld}, ${jsonOf("old", t.cols)}, null); end`,
  ]
}

async function buildCapture(conn: Conn, tables: Map<string, Table>) {
  for (const r of (await conn.query("select name from temp.sqlite_schema where type = 'trigger' and name like 'ghost\\_%' escape '\\'")).rows) {
    await conn.query(`drop trigger temp.${q(String(r.name))}`)
  }
  let i = 0
  for (const t of tables.values()) for (const sql of captureTriggers(t, i++)) await conn.query(sql)
}

/** Temp tables and capture triggers for the current schema, built outside any transaction so they stay. */
async function ready(conn: Conn, s: State) {
  const version = Number((await one(conn, "pragma schema_version")).schema_version)
  s.foreignKeys = Number((await one(conn, "pragma foreign_keys")).foreign_keys) === 1
  if (s.version === version) return
  for (const sql of [
    "create temp table if not exists ghost_changes (seq integer primary key, tbl text, op text, pk text, old_row text, new_row text)",
    "create temp table if not exists ghost_existed (tbl text, pk text)",
    "create temp table if not exists ghost_state (v integer not null)",
    "insert into temp.ghost_state (v) select 0 where not exists (select 1 from temp.ghost_state)",
    // Never commit: a deferred foreign key that's always broken inside a run, so COMMIT fails (when foreign_keys is on).
    "create temp table if not exists ghost_nothing (id integer primary key)",
    "create temp table if not exists ghost_guard (x integer references ghost_nothing (id) deferrable initially deferred)",
  ]) await conn.query(sql)
  s.tables = await readTables(conn)
  await buildCapture(conn, s.tables)
  s.version = version
}

const sqliteCode = (e: unknown) => {
  const err = e as { errcode?: number; code?: string }
  if (typeof err?.errcode === "number") return err.errcode & 0xff
  const m = /^SQLITE_([A-Z]+)/.exec(String(err?.code ?? ""))
  return m ? ({ BUSY: 5, LOCKED: 6, CONSTRAINT: 19 } as Record<string, number>)[m[1]!] ?? -1 : -1
}
const isConstraint = (e: unknown) => sqliteCode(e) === 19

const where = (pk: readonly string[]) => pk.map((c) => `${q(c)} is ?`).join(" and ")

async function insertRow(conn: Conn, t: Table, row: Row) {
  const cols = t.cols.filter((c) => c in row)
  await conn.query(`insert into main.${q(t.name)} (${cols.map(q).join(", ")}) values (${cols.map(() => "?").join(", ")})`,
    cols.map((c) => row[c]))
}

async function applyBatch(conn: Conn, t: Table, batch: ReplayBatch, changes: readonly RowChange[], exact: boolean) {
  for (const i of batch.idx) {
    const c = changes[i]!
    const key = t.pk.map((k) => c.pk[k])
    if (batch.op === "delete") {
      await conn.query(`delete from main.${q(t.name)} where ${where(t.pk)}`, key)
    } else if (batch.op === "insert") {
      try {
        await insertRow(conn, t, c.new!)
      } catch (e) {
        if (exact && isConstraint(e)) {
          throw new GhostError("collision", `A real row in ${t.name} now has the key ${JSON.stringify(c.pk)}, which this session's own `
            + "insert used, so the session can't be put back. Reset the session to start over", { cause: e })
        }
        throw e
      }
    } else {
      const cols = t.cols.filter((col) => col in c.new!)
      const { affected } = await conn.query(`update main.${q(t.name)} set ${cols.map((col) => `${q(col)} = ?`).join(", ")} where ${where(t.pk)}`,
        [...cols.map((col) => c.new![col]), ...key])
      if (!affected) await insertRow(conn, t, c.new!)
    }
  }
}

async function replay(conn: Conn, s: State, changes: readonly RowChange[]) {
  const triggers = (await conn.query("select name, sql from main.sqlite_schema where type = 'trigger' order by rowid")).rows
  for (const t of triggers) await conn.query(`drop trigger main.${q(String(t.name))}`)
  let tables = s.tables
  const table = async (name: string) => {
    if (!tables.has(name)) tables = await readTables(conn)
    const t = tables.get(name)
    if (!t) throw new GhostError("replay", `This session changed ${name}, which isn't in the database any more, so it can't be put back. Reset the session`)
    return t
  }
  const apply = async (plan: ReplayBatch[], exact: boolean) => {
    for (const b of plan) await applyBatch(conn, await table(b.table), b, changes, exact)
  }
  await conn.query("savepoint ghost_replay")
  try {
    await apply(fastPlan(changes), false)
  } catch {
    await conn.query("rollback to ghost_replay")
    try {
      await apply(exactPlan(changes), true)
    } catch (err) {
      if ((err as { ghost?: boolean }).ghost) throw err
      throw new GhostError("replay", `This session's earlier rows don't fit the live data any more (${(err as Error).message}). Reset the session`, { cause: err })
    }
  }
  await conn.query("release ghost_replay")
  for (const t of triggers) await conn.query(String(t.sql))
}

// Ghost's own inserts number from far above the real rows, so a real insert later never reuses a ghost row's id.
const GHOST_BASE = 9_000_000

async function ghostCounters(conn: Conn, s: State) {
  const auto = [...s.tables.values()].filter((t) => t.autoincrement).map((t) => t.name)
  if (!auto.length) return
  for (const name of auto) {
    await conn.query("insert into main.sqlite_sequence (name, seq) select ?, 0 where not exists (select 1 from main.sqlite_sequence where name = ?)", [name, name])
  }
  await conn.query(`update main.sqlite_sequence set seq = max(seq, min(max(${GHOST_BASE}, seq * 10), 4503599627370496)) `
    + `where name in (${auto.map(() => "?").join(", ")})`, auto)
}

export const sqliteDialect: Dialect = {
  name: "sqlite",

  async open(conn, changes, options: OpenOptions) {
    const s = stateOf(conn)
    await ready(conn, s)
    await conn.query("begin immediate")
    if (s.foreignKeys) await conn.query("insert into temp.ghost_guard (x) values (1)")
    if (options.migrations.length) {
      const { splitStatements } = await import("../migrations.js")
      for (const m of options.migrations) {
        for (const statement of splitStatements(m.sql)) {
          const why = refusal("sqlite", statement)
          if (why) throw new GhostError("refused", `Branch migration ${m.file}: ${why}`)
          await conn.query(statement).catch((e: Error) => {
            throw new GhostError("replay", `Branch migration ${m.file} failed: ${e.message}`, { cause: e })
          })
        }
      }
      // The run's own schema: capture triggers for it, rolled back with everything else.
      s.tables = await readTables(conn)
      await buildCapture(conn, s.tables)
      s.version = null
    }
    // Counters first, from the real numbers: the replayed ghost rows then carry them on from there.
    if (options.capture) await ghostCounters(conn, s)
    if (changes.length) await replay(conn, s, changes)
    if (options.capture) await conn.query("update temp.ghost_state set v = 1")
  },

  async close(conn) {
    const rows = (await conn.query("select tbl, op, pk, old_row, new_row from temp.ghost_changes order by seq")).rows
    await conn.query("update temp.ghost_state set v = 0")
    const parse = (v: unknown) => (v == null ? null : JSON.parse(String(v)) as Row)
    return rows.map((r) => ({ table: String(r.tbl), op: r.op as RowChange["op"], pk: parse(r.pk)!, old: parse(r.old_row), new: parse(r.new_row) }))
  },

  async rollback(conn) {
    try {
      await conn.query("rollback")
    } catch (e) {
      if (!/no transaction is active/.test((e as Error).message)) throw e
    }
  },

  refuse: async (sql) => refusal("sqlite", sql),
  transient: (e) => [5, 6].includes(sqliteCode(e)),
  install: async () => ({ installed: false, note: "SQLite needs nothing installed: ghost uses temp triggers on its own connection." }),
  stale: async () => 0,

  async doctor(conn) {
    const s = stateOf(conn)
    await ready(conn, s)
    const version = String((await one(conn, "select sqlite_version() as v")).v)
    const tables = [...s.tables.values()]
    const reused = tables.filter((t) => t.numbered && !t.autoincrement).map((t) => t.name)
    const checks: Check[] = [
      { name: "database", ok: true, detail: `SQLite ${version}, ${tables.length} tables captured with temp triggers (nothing installed)` },
      { name: "commit guard", ok: s.foreignKeys, detail: s.foreignKeys
        ? "foreign_keys is on: a ghost run can't commit even if something tries"
        : "foreign_keys is off, so the commit guard is off; ghost still refuses COMMIT and always rolls back. Turn on PRAGMA foreign_keys for both" },
    ]
    if (reused.length) {
      checks.push({ name: "row ids", ok: true, detail: `${reused.join(", ")} number rows without AUTOINCREMENT, so a real insert can reuse a ghost `
        + "row's id; ghost says so when it happens" })
    }
    return checks
  },
}


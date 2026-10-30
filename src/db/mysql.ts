import { createHash, randomUUID } from "node:crypto"
import { GhostError, serial } from "./errors.js"
import { calledProcedures, refusal, shape } from "./guard.js"
import { exactPlan, fastPlan, type ReplayBatch } from "./plan.js"
import type { Check, Conn, ConnSource, Dialect, Row, RowChange } from "./types.js"

// MySQL and MariaDB save DDL the moment it runs, so nothing can be set up inside the run. `runghost install` adds:
//   _ghost_changes        where capture writes, inside the run's transaction (so the rollback takes it away)
//   _ghost_meta           which table shape each table's capture triggers were made for
//   _ghost_a{i,u,d}_<t>   AFTER triggers on each table with a primary key, firing only while @ghost_capture = 1
//   and wraps each of your triggers in IF @ghost_replay IS NULL, so replayed rows don't fire them twice.
// There is no deferred trigger to stop a commit, so ghost refuses every statement that could commit, checks the
// procedures you CALL, and after every run checks its own marker didn't survive the rollback.

/** mysql2's promise Connection, PoolConnection or Pool. */
export interface MysqlQueryable {
  query(sql: string, values?: unknown): Promise<[unknown, unknown]>
}
export interface MysqlPool extends MysqlQueryable {
  getConnection(): Promise<MysqlQueryable & { release(): void; destroy(): void }>
  end(): Promise<void>
}

export const isMysqlPool = (x: unknown): x is MysqlPool =>
  !!x && typeof (x as MysqlPool).getConnection === "function" && typeof (x as MysqlPool).query === "function"
export const isMysqlConnection = (x: unknown): boolean =>
  !!x && typeof (x as MysqlQueryable).query === "function" && typeof (x as { execute?: unknown }).execute === "function"
    && typeof (x as { beginTransaction?: unknown }).beginTransaction === "function"

// One Conn per physical connection (a pool hands the same ones out again), so what's learned about it is kept.
const conns = new WeakMap<MysqlQueryable, Conn>()
const fromMysql = (q: MysqlQueryable): Conn => {
  let conn = conns.get(q)
  if (!conn) {
    conns.set(q, conn = {
      async query(sql, params = []) {
        const [result] = await q.query(sql, params)
        if (Array.isArray(result)) return { rows: result as Row[], affected: result.length }
        return { rows: [], affected: Number((result as { affectedRows?: number }).affectedRows ?? 0) }
      },
    })
  }
  return conn
}

export function mysqlPoolSource(pool: MysqlPool, owned: boolean): ConnSource {
  return {
    async acquire() {
      const c = await pool.getConnection()
      return { conn: fromMysql(c), release: (broken) => (broken ? c.destroy() : c.release()) }
    },
    close: async () => { if (owned) await pool.end() },
  }
}

export function mysqlSingleSource(q: MysqlQueryable): ConnSource {
  const conn = fromMysql(q)
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

const q = (name: string) => `\`${name.replace(/`/g, "``")}\``
const lit = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`
const hash = (s: string) => createHash("sha256").update(s).digest("hex")
const TRIGGER_VERSION = "1"

interface Column { name: string; type: string; generated: boolean }
interface Table { name: string; cols: Column[]; pk: string[] }

const BINARY = /^(binary|varbinary|tinyblob|blob|mediumblob|longblob)$/
const SPATIAL = /^(geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection|geomcollection)$/

/** How a column goes into a captured image: JSON can't hold bytes, bits or shapes, so those are encoded. */
function captureExpr(ref: "NEW" | "OLD", c: Column): string {
  const v = `${ref}.${q(c.name)}`
  if (BINARY.test(c.type)) return `IF(${v} IS NULL, NULL, JSON_OBJECT('$b64', TO_BASE64(${v})))`
  if (c.type === "bit") return `CAST(${v} AS UNSIGNED)`
  if (SPATIAL.test(c.type)) return `IF(${v} IS NULL, NULL, JSON_OBJECT('$wkb', TO_BASE64(ST_AsWKB(${v})), 'srid', ST_SRID(${v})))`
  if (c.type === "decimal") return `CAST(${v} AS CHAR)`
  return v
}

const jsonObject = (ref: "NEW" | "OLD", cols: readonly Column[]) =>
  `JSON_OBJECT(${cols.map((c) => `${lit(c.name)}, ${captureExpr(ref, c)}`).join(", ")})`

const triggerName = (kind: string, table: string) => `_ghost_a${kind}_${table.slice(0, 40)}_${hash(table).slice(0, 8)}`

/** The capture triggers for a table. Each goes ahead of your AFTER triggers (`first`, by event), so a row is captured
 *  before what its triggers do: a parent before the child a trigger inserts, the order replay needs. */
function captureTriggers(t: Table, first: Map<string, string> = new Map()): { name: string; sql: string }[] {
  const cols = t.cols.filter((c) => !c.generated)
  const pkCols = t.pk.map((n) => cols.find((c) => c.name === n) ?? { name: n, type: "", generated: false })
  const row = (op: string, pk: "NEW" | "OLD", oldRow: string, newRow: string) => {
    const ahead = first.get(op)
    return `AFTER ${op} ON ${q(t.name)} FOR EACH ROW ${ahead ? `PRECEDES ${q(ahead)} ` : ""}`
      + `IF @ghost_capture = 1 THEN INSERT INTO _ghost_changes (conn, tbl, op, pk, old_row, new_row) VALUES (CONNECTION_ID(), ${lit(t.name)}, `
      + `'${op}', ${jsonObject(pk, pkCols)}, ${oldRow}, ${newRow}); END IF`
  }
  return [
    { name: triggerName("i", t.name), sql: row("INSERT", "NEW", "NULL", jsonObject("NEW", cols)) },
    { name: triggerName("u", t.name), sql: row("UPDATE", "OLD", jsonObject("OLD", cols), jsonObject("NEW", cols)) },
    { name: triggerName("d", t.name), sql: row("DELETE", "OLD", jsonObject("OLD", cols), "NULL") },
  ]
}

const shapeOf = (t: Table) => hash(JSON.stringify([TRIGGER_VERSION, t.cols, t.pk]))

async function readTables(conn: Conn): Promise<Map<string, Table>> {
  const cols = (await conn.query(
    "select c.table_name as t, c.column_name as name, c.data_type as type, c.extra as extra, c.column_key as k, c.ordinal_position as pos "
    + "from information_schema.columns c join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name "
    + "where c.table_schema = database() and x.table_type = 'BASE TABLE' and c.table_name not like '\\_ghost\\_%' order by c.table_name, c.ordinal_position")).rows
  const pks = (await conn.query(
    "select table_name as t, column_name as name from information_schema.key_column_usage "
    + "where table_schema = database() and constraint_name = 'PRIMARY' order by table_name, ordinal_position")).rows
  const out = new Map<string, Table>()
  for (const c of cols) {
    const name = String(c.t)
    const t = out.get(name) ?? { name, cols: [], pk: [] }
    t.cols.push({ name: String(c.name), type: String(c.type).toLowerCase(), generated: /generated/i.test(String(c.extra ?? "")) })
    out.set(name, t)
  }
  for (const k of pks) out.get(String(k.t))?.pk.push(String(k.name))
  return out
}

interface Flavor { mariadb: boolean; version: string }
const flavors = new WeakMap<Conn, Flavor>()
async function flavor(conn: Conn): Promise<Flavor> {
  let f = flavors.get(conn)
  if (!f) {
    const version = String((await conn.query("select version() as v")).rows[0]?.v ?? "")
    flavors.set(conn, f = { mariadb: /mariadb/i.test(version), version })
  }
  return f
}

const tablesCache = new WeakMap<Conn, { at: number; tables: Map<string, Table> }>()
async function tablesOf(conn: Conn, fresh = false) {
  const hit = tablesCache.get(conn)
  if (hit && !fresh && Date.now() - hit.at < 30_000) return hit.tables
  const tables = await readTables(conn)
  tablesCache.set(conn, { at: Date.now(), tables })
  return tables
}

/** A value from a captured image, ready to bind; `expr` wraps the placeholder when the column needs it. */
function bindValue(c: Column | undefined, v: unknown, mariadb: boolean): { expr: string; value: unknown } {
  if (v === undefined || v === null) return { expr: "?", value: null }
  const o = v as { $b64?: string; $wkb?: string; srid?: number }
  if (typeof v === "object" && typeof o.$b64 === "string") return { expr: "?", value: Buffer.from(o.$b64, "base64") }
  if (typeof v === "object" && typeof o.$wkb === "string") return { expr: `ST_GeomFromWKB(?, ${Number(o.srid ?? 0)})`, value: Buffer.from(o.$wkb, "base64") }
  if (c?.type === "json") return { expr: mariadb ? "?" : "CAST(? AS JSON)", value: typeof v === "string" && mariadb ? v : JSON.stringify(v) }
  if (typeof v === "object") return { expr: "?", value: JSON.stringify(v) }
  return { expr: "?", value: v }
}

const DUPLICATE = new Set(["ER_DUP_ENTRY", "ER_DUP_KEY"])
const CONSTRAINT = new Set([...DUPLICATE, "ER_NO_REFERENCED_ROW", "ER_NO_REFERENCED_ROW_2", "ER_ROW_IS_REFERENCED", "ER_ROW_IS_REFERENCED_2",
  "ER_CHECK_CONSTRAINT_VIOLATED", "ER_CONSTRAINT_FAILED", "ER_BAD_NULL_ERROR"])
const TRANSIENT = new Set(["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT", "PROTOCOL_CONNECTION_LOST", "ECONNRESET", "ER_QUERY_INTERRUPTED"])
const codeOf = (e: unknown) => String((e as { code?: unknown })?.code ?? "")

async function applyBatch(conn: Conn, t: Table, batch: ReplayBatch, changes: readonly RowChange[], exact: boolean, mariadb: boolean) {
  const cols = t.cols.filter((c) => !c.generated)
  const colOf = (name: string) => cols.find((c) => c.name === name)
  const rows = batch.idx.map((i) => changes[i]!)
  const keyMatch = (alias: string, other: string) => t.pk.map((k) => `${alias}.${q(k)} = ${other}.${q(k)}`).join(" and ")
  // A derived table of rows, one SELECT per row, so one statement can update or insert them all.
  const derived = (images: Row[], names: string[]) => {
    const params: unknown[] = []
    const selects = images.map((img) => `select ${names.map((n) => {
      const b = bindValue(colOf(n), img[n], mariadb)
      params.push(b.value)
      return `${b.expr} as ${q(n)}`
    }).join(", ")}`)
    return { sql: `(${selects.join(" union all ")})`, params }
  }
  // Placeholders are capped at 65535 a statement.
  const per = Math.max(1, Math.floor(30_000 / Math.max(1, cols.length)))
  for (let start = 0; start < rows.length; start += per) {
    const chunk = rows.slice(start, start + per)
    if (batch.op === "delete") {
      const v = derived(chunk.map((c) => c.pk), t.pk)
      await conn.query(`delete x from ${q(t.name)} x join ${v.sql} v on ${keyMatch("x", "v")}`, v.params)
      continue
    }
    const names = cols.map((c) => c.name).filter((n) => chunk.some((c) => c.new && n in c.new))
    const list = names.map(q).join(", ")
    if (batch.op === "insert") {
      const v = derived(chunk.map((c) => c.new!), names)
      try {
        await conn.query(`insert into ${q(t.name)} (${list}) select * from ${v.sql} v`, v.params)
      } catch (e) {
        if (exact && DUPLICATE.has(codeOf(e))) {
          throw new GhostError("collision", `A real row in ${t.name} now clashes with the row ${JSON.stringify(chunk[0]!.pk)} this session inserted, `
            + "so the session can't be put back. Reset the session to start over", { cause: e })
        }
        throw e
      }
      continue
    }
    // upsert: by the key each row had (it can change), then the ones that weren't there.
    const k = derived(chunk.map((c) => Object.fromEntries([...t.pk.map((p) => [`_k_${p}`, c.pk[p]]), ...names.map((n) => [n, c.new![n]])])),
      [...t.pk.map((p) => `_k_${p}`), ...names])
    const kParams = k.params
    await conn.query(`update ${q(t.name)} x join ${k.sql} v on ${t.pk.map((p) => `x.${q(p)} = v.${q(`_k_${p}`)}`).join(" and ")} `
      + `set ${names.map((n) => `x.${q(n)} = v.${q(n)}`).join(", ")}`, kParams)
    const v = derived(chunk.map((c) => c.new!), names)
    await conn.query(`insert into ${q(t.name)} (${list}) select * from ${v.sql} v where not exists (select 1 from ${q(t.name)} x where ${keyMatch("x", "v")})`,
      v.params)
  }
}

async function replay(conn: Conn, changes: readonly RowChange[], mariadb: boolean) {
  let tables = await tablesOf(conn)
  const table = async (name: string) => {
    if (!tables.has(name)) tables = await tablesOf(conn, true)
    const t = tables.get(name)
    if (!t?.pk.length) throw new GhostError("replay", `This session changed ${name}, which isn't in the database any more, so it can't be put back. Reset the session`)
    return t
  }
  const apply = async (plan: ReplayBatch[], exact: boolean) => {
    for (const b of plan) await applyBatch(conn, await table(b.table), b, changes, exact, mariadb)
  }
  await conn.query("set @ghost_replay = 1")
  await conn.query("savepoint ghost_replay")
  try {
    await apply(fastPlan(changes), false)
  } catch (e) {
    if (TRANSIENT.has(codeOf(e)) || !CONSTRAINT.has(codeOf(e))) throw e
    await conn.query("rollback to savepoint ghost_replay")
    try {
      await apply(exactPlan(changes), true)
    } catch (err) {
      if ((err as { ghost?: boolean }).ghost || TRANSIENT.has(codeOf(err))) throw err
      throw new GhostError("replay", `This session's earlier rows don't fit the live data any more (${(err as Error).message}). Reset the session`, { cause: err })
    }
  }
  await conn.query("release savepoint ghost_replay")
  await conn.query("set @ghost_replay = null")
}

/** Each run's marker: if it's still there after the rollback, something in the run committed. */
const markers = new WeakMap<Conn, string>()

// A procedure is checked, with the ones it calls, before a CALL: it mustn't commit, run DDL or build SQL at runtime.
const COMMITS = /\b(commit|rollback(?! to\b)|start transaction|begin work|xa|lock tables?|unlock tables?|prepare|execute|create|alter|drop|truncate|rename|grant|revoke|set autocommit|load data)\b/
const verdicts = new Map<string, { at: number; why: string | null }>()

async function procedureVerdict(conn: Conn, name: string, depth = 0): Promise<string | null> {
  const hit = verdicts.get(name)
  if (hit && Date.now() - hit.at < 60_000) return hit.why
  const row = (await conn.query("select routine_definition as body from information_schema.routines "
    + "where routine_schema = database() and routine_name = ? and routine_type = 'PROCEDURE'", [name])).rows[0]
  let why: string | null = null
  if (!row || row.body == null) why = `Ghost can't see inside procedure ${name}, so it can't tell whether it commits`
  else {
    const body = shape(String(row.body), { mysql: true })
    const m = COMMITS.exec(body)
    if (m) why = `Ghost can't CALL ${name}: it runs ${m[1]!.toUpperCase()}, which MySQL would save for real`
    else if (depth < 5) {
      for (const inner of calledProcedures(String(row.body))) {
        why = await procedureVerdict(conn, inner, depth + 1)
        if (why) break
      }
    }
  }
  verdicts.set(name, { at: Date.now(), why })
  return why
}

async function guardTriggers(conn: Conn): Promise<{ guarded: number; failed: { trigger: string; why: string }[] }> {
  const rows = (await conn.query(
    "select trigger_name as name, event_manipulation as event, event_object_table as tbl, action_statement as body, "
    + "action_timing as timing, action_order as ord, definer as definer, sql_mode as mode from information_schema.triggers "
    + "where trigger_schema = database() and trigger_name not like '\\_ghost\\_%' order by event_object_table, action_timing, event_manipulation, action_order")).rows
  const groups = new Map<string, Row[]>()
  for (const r of rows) {
    const key = `${r.tbl}\u0000${r.timing}\u0000${r.event}`
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  let guarded = 0
  const failed: { trigger: string; why: string }[] = []
  const [{ mode: current } = { mode: "" }] = (await conn.query("select @@session.sql_mode as mode")).rows as { mode: string }[]
  for (const group of groups.values()) {
    if (group.every((r) => String(r.body).includes("@ghost_replay"))) continue
    const table = String(group[0]!.tbl)
    // Dropped and made again in order, with the table locked so no write slips past without them.
    await conn.query(`lock tables ${q(table)} write`)
    try {
      for (const r of group) await conn.query(`drop trigger ${q(String(r.name))}`)
      for (const r of group) {
        const body = String(r.body)
        const wrapped = body.includes("@ghost_replay") ? body : `IF @ghost_replay IS NULL THEN ${body.replace(/;\s*$/, "")}; END IF`
        const [user = "", host = ""] = String(r.definer).split("@")
        try {
          await conn.query("set session sql_mode = ?", [String(r.mode ?? "")])
          await conn.query(`create definer = ${q(user)}@${q(host)} trigger ${q(String(r.name))} ${r.timing} ${r.event} on ${q(table)} for each row ${wrapped}`)
          if (wrapped !== body) guarded++
        } catch (e) {
          failed.push({ trigger: String(r.name), why: (e as Error).message })
          await conn.query(`create definer = ${q(user)}@${q(host)} trigger ${q(String(r.name))} ${r.timing} ${r.event} on ${q(table)} for each row ${body}`)
        }
      }
    } finally {
      await conn.query("set session sql_mode = ?", [current])
      await conn.query("unlock tables")
    }
  }
  return { guarded, failed }
}

export const mysqlDialect: Dialect = {
  name: "mysql",

  async open(conn, changes, options) {
    if (options.migrations.length) {
      throw new GhostError("refused", "Ghost can't run branch migrations on MySQL: MySQL saves DDL the moment it runs")
    }
    const f = await flavor(conn)
    await conn.query("set session innodb_lock_wait_timeout = 2")
    if (f.mariadb) await conn.query(`set session max_statement_time = ${Math.max(0.001, options.timeoutMs / 1000)}`)
    else await conn.query(`set session max_execution_time = ${Math.max(1, Math.round(options.timeoutMs))}`)
    await conn.query("set @ghost_capture = null, @ghost_replay = null")
    await conn.query("start transaction")
    const marker = randomUUID()
    markers.set(conn, marker)
    try {
      await conn.query("insert into _ghost_changes (conn, tbl, op, pk) values (connection_id(), '', 'OPEN', json_object('run', ?))", [marker])
    } catch (e) {
      if (codeOf(e) === "ER_NO_SUCH_TABLE") throw new GhostError("install", "Ghost isn't installed in this database yet: run `runghost install`", { cause: e })
      throw e
    }
    if (changes.length) await replay(conn, changes, f.mariadb)
    if (options.capture) await conn.query("set @ghost_capture = 1")
  },

  async close(conn) {
    await conn.query("set @ghost_capture = null")
    const rows = (await conn.query("select tbl, op, pk, old_row, new_row from _ghost_changes where conn = connection_id() and op <> 'OPEN' order by seq")).rows
    const parse = (v: unknown) => (v == null ? null : typeof v === "string" ? JSON.parse(v) as Row : v as Row)
    return rows.map((r) => ({ table: String(r.tbl), op: r.op as RowChange["op"], pk: parse(r.pk)!, old: parse(r.old_row), new: parse(r.new_row) }))
  },

  async rollback(conn) {
    await conn.query("rollback")
    const f = await flavor(conn)
    await conn.query("set @ghost_capture = null, @ghost_replay = null")
    await conn.query(`set session innodb_lock_wait_timeout = default, ${f.mariadb ? "max_statement_time" : "max_execution_time"} = default`)
    const marker = markers.get(conn)
    markers.delete(conn)
    if (!marker) return
    const kept = (await conn.query("select count(*) as n from _ghost_changes where conn = connection_id() and op = 'OPEN' and json_unquote(json_extract(pk, '$.run')) = ?", [marker])).rows[0]
    if (Number(kept?.n ?? 0) > 0) {
      await conn.query("delete from _ghost_changes where conn = connection_id()")
      throw new GhostError("unsafe", "Something in this ghost run committed for real: its writes may have been saved. Check what ran; ghost has dropped the connection")
    }
  },

  async refuse(sql, conn) {
    const why = refusal("mysql", sql)
    if (why) return why
    for (const name of calledProcedures(sql)) {
      const found = await procedureVerdict(conn, name)
      if (found) return found
    }
    return null
  },

  transient: (e) => TRANSIENT.has(codeOf(e)),

  async install(conn) {
    await conn.query("create table if not exists _ghost_changes (conn bigint unsigned not null, seq bigint unsigned not null auto_increment primary key, "
      + "tbl varchar(64) not null, op varchar(6) not null, pk json not null, old_row json null, new_row json null, key (conn)) engine = InnoDB")
    await conn.query("create table if not exists _ghost_meta (tbl varchar(64) primary key, shape char(64) not null) engine = InnoDB")
    const tables = await tablesOf(conn, true)
    const meta = new Map((await conn.query("select tbl, shape from _ghost_meta")).rows.map((r) => [String(r.tbl), String(r.shape)]))
    const existing = new Set((await conn.query("select trigger_name as name from information_schema.triggers where trigger_schema = database() "
      + "and trigger_name like '\\_ghost\\_%'")).rows.map((r) => String(r.name)))
    // Your first AFTER trigger per table and event, which capture goes ahead of.
    const firsts = new Map<string, Map<string, string>>()
    for (const r of (await conn.query("select event_object_table as tbl, event_manipulation as event, trigger_name as name "
      + "from information_schema.triggers where trigger_schema = database() and action_timing = 'AFTER' and trigger_name not like '\\_ghost\\_%' "
      + "order by action_order desc")).rows) {
      const byEvent = firsts.get(String(r.tbl)) ?? new Map<string, string>()
      byEvent.set(String(r.event), String(r.name))
      firsts.set(String(r.tbl), byEvent)
    }
    let captured = 0
    const skipped: string[] = []
    for (const t of tables.values()) {
      if (!t.pk.length) { skipped.push(t.name); continue }
      const triggers = captureTriggers(t, firsts.get(t.name))
      if (meta.get(t.name) === shapeOf(t) && triggers.every((x) => existing.has(x.name))) continue
      for (const x of triggers) {
        await conn.query(`drop trigger if exists ${q(x.name)}`)
        await conn.query(`create trigger ${q(x.name)} ${x.sql}`)
      }
      await conn.query("replace into _ghost_meta (tbl, shape) values (?, ?)", [t.name, shapeOf(t)])
      captured++
    }
    const guards = await guardTriggers(conn)
    tablesCache.delete(conn)
    return { captured, skippedNoPrimaryKey: skipped, guarded: guards.guarded, failed: guards.failed }
  },

  async stale(conn) {
    const has = (await conn.query("select count(*) as n from information_schema.tables where table_schema = database() and table_name = '_ghost_meta'")).rows[0]
    if (!Number(has?.n)) return 1
    const tables = await tablesOf(conn, true)
    const meta = new Map((await conn.query("select tbl, shape from _ghost_meta")).rows.map((r) => [String(r.tbl), String(r.shape)]))
    let stale = [...tables.values()].filter((t) => t.pk.length && meta.get(t.name) !== shapeOf(t)).length
    const unguarded = (await conn.query("select count(*) as n from information_schema.triggers where trigger_schema = database() "
      + "and trigger_name not like '\\_ghost\\_%' and action_statement not like '%@ghost\\_replay%'")).rows[0]
    stale += Number(unguarded?.n ?? 0)
    return stale
  },

  async doctor(conn) {
    const f = await flavor(conn)
    const checks: Check[] = [{ name: "database", ok: true, detail: `${f.mariadb ? "MariaDB" : "MySQL"} ${f.version}` }]
    const stale = await mysqlDialect.stale(conn)
    const has = (await conn.query("select count(*) as n from information_schema.tables where table_schema = database() and table_name = '_ghost_meta'")).rows[0]
    if (!Number(has?.n)) {
      checks.push({ name: "ghost installed", ok: false, detail: "not yet: run `runghost install` (it adds two _ghost_ tables, capture triggers per table and a guard in each of your triggers)" })
      return checks
    }
    checks.push({ name: "install is current", ok: stale === 0, detail: stale ? `${stale} tables or triggers are new or changed since the last install: run \`runghost install\`` : "every table and trigger is covered" })
    checks.push({ name: "commit guard", ok: true, detail: "MySQL has no deferred trigger to stop a commit: ghost refuses statements that commit, checks procedures before a CALL, and checks after every run" })
    try {
      await mysqlDialect.open(conn, [], { capture: true, migrations: [], timeoutMs: 5_000 })
      await mysqlDialect.close(conn)
      checks.push({ name: "rolled-back run", ok: true, detail: "opens, captures and rolls back" })
    } catch (e) {
      checks.push({ name: "rolled-back run", ok: false, detail: (e as Error).message })
    } finally {
      await mysqlDialect.rollback(conn).catch(() => {})
    }
    return checks
  },
}

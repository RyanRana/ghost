// The branch's migrations the database doesn't have yet, made ready to run inside a ghost run's own rolled-back transaction:
// transaction control and pgrst notifies stripped, speed-only index builds skipped, statements Postgres runs instantly
// kept as light, statements that rewrite, scan, backfill or index a live table kept as heavy (they run under the
// runners' 200 ms lock_timeout and wait for a turn), and only effects that would outlive the rollback refused.

export interface HeavyStatement {
  statement: string
  table: string
  /** What it does to the table, read as "this migration <does> <table>". */
  does: string
}

export interface PreparedMigration {
  file: string
  version: string | null
  /** Why it counts as pending: the database's ledger lacks it, or it was applied and has been edited on this branch since. */
  reason: "new" | "edited"
  /** The SQL the ghost run executes, or null when the file is refused. */
  sql: string | null
  skipped: string[]
  heavy: HeavyStatement[]
  refused: { statement: string; table: string | null; why: string } | null
}

export interface BranchMigrations {
  checkedAt: string
  runnable: PreparedMigration[]
  refused: PreparedMigration[]
  /** Tables the runnable migrations create, which exist only inside a ghost run. */
  createdTables: string[]
}

export const heavyNotice = (h: HeavyStatement) => `this migration ${h.does} ${h.table}, it may take a while`

/** Statements in order, split on semicolons outside quotes, comments and dollar-quoted bodies. */
export function splitStatements(sql: string): string[] {
  const out: string[] = []
  let cur = "", i = 0
  while (i < sql.length) {
    const ch = sql[i]!, next = sql[i + 1]
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i)
      const stop = end < 0 ? sql.length : end
      cur += sql.slice(i, stop); i = stop
    } else if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2)
      const stop = end < 0 ? sql.length : end + 2
      cur += sql.slice(i, stop); i = stop
    } else if (ch === "'" || ch === '"') {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === ch) { if (sql[j + 1] === ch) { j += 2; continue } break }
        j++
      }
      cur += sql.slice(i, j + 1); i = j + 1
    } else if (ch === "$") {
      const tag = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i))?.[0]
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length)
        const stop = end < 0 ? sql.length : end + tag.length
        cur += sql.slice(i, stop); i = stop
      } else { cur += ch; i++ }
    } else if (ch === ";") {
      if (cur.trim()) out.push(cur.trim())
      cur = ""; i++
    } else { cur += ch; i++ }
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** The statement with comments and quoted bodies blanked, lowercased: what the rules below look at. */
function shape(statement: string): string {
  return statement
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

const ident = String.raw`(?:only\s+)?((?:"?[a-z_][a-z0-9_$]*"?\.)?"?[a-z_][a-z0-9_$]*"?)`
const tableName = (raw: string) => raw.replace(/"/g, "").replace(/^public\./, "")
// Stable defaults (now(), a constant) are stored once in the catalog; only a volatile one is computed row by row.
const VOLATILE = /\b(clock_timestamp|gen_random_uuid|uuid_generate_v4|random|nextval|timeofday)\s*\(/

// Effects that outlive a rollback or reach outside the transaction: never run, whatever the file.
const ESCAPES: [RegExp, string][] = [
  [/\bpg_advisory_(?:un)?lock(?:_shared)?\s*\(/, "takes a session advisory lock, which survives the rollback"],
  [/\bdblink\b|\bpostgres_fdw\b/, "reaches another database"],
  [/\bcopy\b[^;]*\bprogram\b/, "runs a program"],
  [/\blo_(?:import|export)\s*\(/, "reads or writes server files"],
  [/^alter system\b/, "changes server settings"],
  [/^(?:set|reset) (?:local )?(?:role|session authorization)\b/, "changes the database role"],
  [/^alter type\b[^;]*\badd value\b/, "adds an enum value, which can't be used until it commits"],
  [/^vacuum\b|^refresh materialized view concurrently\b/, "can't run inside a transaction"],
]

const SPEED_ONLY = [/^create index\b/, /^create index concurrently\b/, /^drop index concurrently\b/, /^reindex\b/, /^analyze\b/]
const TRANSACTION = [/^begin\b/, /^start transaction\b/, /^commit\b/, /^end\b$/, /^rollback\b/, /^notify pgrst\b/,
  /^select pg_notify\s*\(\s*''\s*,/, /^select pg_notify\('pgrst'/]

interface Rules { existing: (table: string) => boolean }

/** ALTER TABLE actions, split on the commas between them (not those inside parentheses). */
function actions(rest: string): string[] {
  const out: string[] = []
  let depth = 0, cur = ""
  for (const ch of rest) {
    if (ch === "(") depth++
    else if (ch === ")") depth--
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = "" } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** What one ALTER TABLE action does to every row, or null when Postgres does it from the catalog alone. */
function alterCost(action: string): string | null {
  if (/^alter (?:column )?\S+ (?:set data )?type\b/.test(action)) return "rewrites"
  if (/^alter (?:column )?\S+ set not null\b/.test(action)) return "checks every row of"
  if (/^add (?:column )?(?:if not exists )?\S+ /.test(action) && !/^add (?:constraint|primary key|unique|check|foreign key|exclude)\b/.test(action)) {
    if (/\bgenerated always as\b[^,]*\bstored\b/.test(action)) return "rewrites"
    if (/\bdefault\b/.test(action) && VOLATILE.test(action)) return "rewrites"
    if (/\b(?:primary key|unique)\b/.test(action)) return "builds an index over"
    if (/\bcheck\s*\(/.test(action)) return "checks every row of"
    return null
  }
  if (/^add\b/.test(action)) {
    if (/\bnot valid\b/.test(action) || /\busing index\b/.test(action)) return null
    if (/\b(?:primary key|unique|exclude)\b/.test(action)) return "builds an index over"
    if (/\b(?:check|foreign key)\b/.test(action)) return "checks every row of"
    return null
  }
  if (/^validate constraint\b/.test(action)) return "checks every row of"
  if (/^set (?:logged|unlogged|tablespace)\b|^set without oids\b/.test(action)) return "rewrites"
  return null
}

type Verdict = { kind: "refused"; table: string | null; why: string } | { kind: "heavy"; table: string; does: string } | null

/** Whether this statement can't run, or has to wait its turn on a live table. `created` holds tables the branch makes. */
function verdictOf(s: string, rules: Rules, created: Set<string>): Verdict {
  for (const [re, why] of ESCAPES) if (re.test(s)) return { kind: "refused", table: null, why }
  const live = (raw: string) => {
    const t = tableName(raw)
    return rules.existing(t) && !created.has(t) ? t : null
  }
  let m = new RegExp(String.raw`^alter table (?:if exists )?${ident}(.*)$`).exec(s)
  if (m) {
    const t = live(m[1]!)
    if (!t) return null
    for (const action of actions(m[2]!.trim())) {
      const does = alterCost(action)
      if (does) return { kind: "heavy", table: t, does }
    }
    return null
  }
  m = new RegExp(String.raw`^create unique index (?:concurrently )?(?:if not exists )?(?:[a-z0-9_"]+ )?on ${ident}`).exec(s)
  if (m && live(m[1]!)) return { kind: "heavy", table: tableName(m[1]!), does: "builds a unique index over" }
  for (const re of [new RegExp(String.raw`^update ${ident}`), new RegExp(String.raw`^delete from ${ident}`),
    new RegExp(String.raw`^merge into ${ident}`), new RegExp(String.raw`^truncate (?:table )?${ident}`)]) {
    m = re.exec(s)
    if (m && live(m[1]!)) return { kind: "heavy", table: tableName(m[1]!), does: "backfills" }
  }
  m = new RegExp(String.raw`^(?:with .*? )?insert into ${ident}[^;]*?\bselect\b`).exec(s)
  if (m && live(m[1]!)) return { kind: "heavy", table: tableName(m[1]!), does: "backfills" }
  m = new RegExp(String.raw`^(?:cluster|refresh materialized view) ${ident}`).exec(s)
  if (m) return { kind: "heavy", table: tableName(m[1]!), does: "rewrites" }
  // A DO block's body gets the same rules, statement by statement.
  m = /^do (?:language [a-z]+ )?\$([a-z_0-9]*)\$([\s\S]*)\$\1\$/.exec(s)
  if (m) {
    for (const inner of splitStatements(m[2]!)) {
      const found = verdictOf(shape(inner).replace(/^(?:begin|declare\b[\s\S]*?begin)\s+/, ""), rules, created)
      if (found) return found
    }
  }
  return null
}

/** One file made ready to run inside a rolled-back ghost run, or refused. */
export function prepareMigration(
  file: string, sql: string, rules: Rules, created: Set<string>, reason: PreparedMigration["reason"] = "new",
): PreparedMigration {
  const version = /^(\d+)_/.exec(file)?.[1] ?? null
  const kept: string[] = []
  const skipped: string[] = []
  const heavy: HeavyStatement[] = []
  for (const statement of splitStatements(sql)) {
    const s = shape(statement)
    if (!s) continue
    if (TRANSACTION.some((re) => re.test(s))) continue
    if (SPEED_ONLY.some((re) => re.test(s))) { skipped.push(statement.split("\n")[0]!.slice(0, 120)); continue }
    // DO-block bodies keep their quoting, so the rules read the raw text there.
    const verdict = verdictOf(/^do\b/.test(s) ? statement.toLowerCase().replace(/\s+/g, " ") : s, rules, created)
    if (verdict?.kind === "refused") {
      return { file, version, reason, sql: null, skipped, heavy, refused: { statement: statement.slice(0, 200), table: verdict.table, why: verdict.why } }
    }
    if (verdict?.kind === "heavy") heavy.push({ statement: statement.slice(0, 200), table: verdict.table, does: verdict.does })
    const made = new RegExp(String.raw`^create (?:unlogged )?table (?:if not exists )?${ident}`).exec(s)
    if (made) created.add(tableName(made[1]!))
    kept.push(statement)
  }
  return { file, version, reason, sql: kept.length ? kept.join(";\n") + ";" : "", skipped, heavy, refused: null }
}

export interface LedgerRow { version: string; name: string | null }

/** Which files the database hasn't applied, by version or name, plus any applied file
 *  this branch has edited since main. */
export function pendingFiles(
  files: string[], ledger: LedgerRow[], baseline: Set<string>, editedSinceMain: Set<string>,
): { file: string; reason: PreparedMigration["reason"] }[] {
  const versions = new Set(ledger.map((r) => r.version))
  const names = new Set(ledger.map((r) => r.name).filter(Boolean) as string[])
  const out: { file: string; reason: PreparedMigration["reason"] }[] = []
  for (const file of [...files].filter((f) => f.endsWith(".sql")).sort()) {
    const stem = file.replace(/\.sql$/, "")
    const m = /^(\d+)_(.+)$/.exec(stem)
    const applied = baseline.has(file) || (m && (versions.has(m[1]!) || names.has(m[2]!))) || names.has(stem)
    if (!applied) out.push({ file, reason: "new" })
    else if (editedSinceMain.has(file)) out.push({ file, reason: "edited" })
  }
  return out
}

export function prepareAll(
  pending: { file: string; reason: PreparedMigration["reason"] }[], read: (file: string) => string, rules: Rules,
): BranchMigrations {
  const created = new Set<string>()
  const runnable: PreparedMigration[] = []
  const refused: PreparedMigration[] = []
  for (const { file, reason } of pending) {
    const prepared = prepareMigration(file, read(file), rules, created, reason)
    ;(prepared.refused ? refused : runnable).push(prepared)
  }
  return { checkedAt: new Date().toISOString(), runnable, refused, createdTables: [...created].sort() }
}

/** What ghost runs ship to the database: only files with something left to run. */
export function migrationPayload(m: BranchMigrations | null): { file: string; sql: string }[] {
  return (m?.runnable ?? []).filter((p) => p.sql).map((p) => ({ file: p.file, sql: p.sql! }))
}

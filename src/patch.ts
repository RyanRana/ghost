import { latestRows, pkKey } from "./db/plan.js"
import { matches, type ParsedQuery } from "./query.js"

export { latestRows }

/** One row a ghost click changed, exactly as the database's logic left it inside the rolled-back run. `pk` is the key
 *  the row had before the write (for an insert, the one it was given); an update that changed it has the new one in `new`. */
export interface GhostRowChange {
  table: string
  op: "INSERT" | "UPDATE" | "DELETE"
  pk: Record<string, unknown>
  old: Record<string, unknown> | null
  new: Record<string, unknown> | null
}

type Row = Record<string, unknown>

function keyOf(row: Row, pkCols: readonly string[]): string | null {
  if (!pkCols.length || pkCols.some((c) => !(c in row))) return null
  return pkKey(Object.fromEntries(pkCols.map((c) => [c, row[c]])))
}

const project = (row: Row, columns: readonly string[] | null) =>
  columns ? Object.fromEntries(columns.map((c) => [c, row[c] ?? null])) : row

/** Session changes laid over rows PostgREST returned: changed rows take their ghost values, deleted ones go, and
 *  inserted ones join when the query's filters can be evaluated exactly. Embedded rows get the same by primary key. */
export function patchRows(
  rows: Row[], q: ParsedQuery, changes: Map<string, Map<string, Row | null>>, pkOf: (table: string) => readonly string[],
): Row[] {
  const own = changes.get(q.table)
  const pkCols = pkOf(q.table)
  const seen = new Set<string>()
  const out: Row[] = []
  for (const row of rows) {
    const key = keyOf(row, pkCols)
    if (key) seen.add(key)
    const ghost = key && own?.has(key) ? own.get(key) : undefined
    if (ghost === null) continue
    let next: Row = ghost ? { ...row, ...pick(ghost, row) } : { ...row }
    if (ghost && q.evaluable && !matches(ghost, q.conditions)) continue
    for (const e of q.embeds) next = patchEmbed(next, e.key, e.table, changes, pkOf)
    out.push(next)
  }
  if (own && q.evaluable && q.embeds.length === 0) {
    for (const [key, ghost] of own) {
      if (ghost && !seen.has(key) && matches(ghost, q.conditions)) out.push(project(ghost, q.columns))
    }
  }
  return q.limit != null ? out.slice(0, q.limit) : out
}

// Only the columns the row came back with: a narrow select stays narrow.
function pick(ghost: Row, shape: Row): Row {
  return Object.fromEntries(Object.keys(shape).filter((k) => k in ghost).map((k) => [k, ghost[k]]))
}

function patchEmbed(row: Row, key: string, table: string | null, changes: Map<string, Map<string, Row | null>>,
  pkOf: (table: string) => readonly string[]): Row {
  const own = table ? changes.get(table) : undefined
  if (!own || row[key] == null) return row
  const pkCols = pkOf(table!)
  const one = (r: Row): Row | null => {
    const k = keyOf(r, pkCols)
    if (!k || !own.has(k)) return r
    const ghost = own.get(k)
    return ghost === null ? null : { ...r, ...pick(ghost!, r) }
  }
  const value = row[key]
  return { ...row, [key]: Array.isArray(value) ? value.map((r) => one(r as Row)).filter(Boolean) : one(value as Row) }
}

/** The tables a read touches: its own and every embed's that can be told. */
export function touchedTables(q: ParsedQuery): string[] {
  return [q.table, ...q.embeds.map((e) => e.table).filter((t): t is string => !!t)]
}

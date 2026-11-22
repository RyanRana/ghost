export type FilterOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like" | "ilike" | "is" | "in" | "cs"
const OPS = new Set<string>(["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in", "cs"])

export interface Filter { col: string; op: FilterOp; value: unknown; not?: boolean }
export type Condition = Filter | { or: Condition[] } | { and: Condition[] }

export interface ParsedQuery {
  table: string
  /** Plain columns, or null for `*`; null too when the select has anything else (casts, aliases, json paths). */
  columns: string[] | null
  /** The select is `*` or plain columns only, so the dispatcher can run it as written. */
  plain: boolean
  /** Embedded resources by the name they come back under, with the table each reads from when it can be told
   *  (`table` may be a foreign key column or constraint: PostgREST accepts those too), its `!hint`, whether it is an
   *  inner join, and the select inside its parentheses. */
  embeds: { key: string; table: string | null; hint?: string; inner?: boolean; select?: string }[]
  conditions: Condition[]
  /** False when a filter uses an operator ghost can't evaluate exactly (cd, ov, fts, any/all modifiers...). */
  evaluable: boolean
  order: { col: string; dir: "asc" | "desc"; nulls?: "first" | "last" }[]
  limit?: number
  offset?: number
}

const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"])

/** Splits on commas outside parentheses and double quotes. */
function splitTop(s: string): string[] {
  const out: string[] = []
  let depth = 0, quoted = false, cur = ""
  for (const ch of s) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && ch === "(") depth++
    else if (!quoted && ch === ")") depth--
    if (ch === "," && depth === 0 && !quoted) { out.push(cur); cur = "" } else cur += ch
  }
  if (cur) out.push(cur)
  return out
}

const unquote = (v: string) => (v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1).replace(/\\"/g, '"') : v)

function parseValue(op: FilterOp, raw: string): unknown {
  if (op === "in") {
    const inner = raw.replace(/^\(/, "").replace(/\)$/, "")
    return inner === "" ? [] : splitTop(inner).map(unquote)
  }
  if (op === "is") return raw === "null" ? null : raw === "true" ? true : raw === "false" ? false : raw
  if (op === "cs") {
    // JSON for a jsonb column; `{a,b}` is a Postgres array literal, whose members arrive as text.
    try { return JSON.parse(raw) } catch { /* not JSON */ }
    return /^\{.*\}$/.test(raw) ? splitTop(raw.slice(1, -1)).map(unquote) : undefined
  }
  return unquote(raw)
}

/** `op.value` or `not.op.value`, the right-hand side of a PostgREST filter; null when it isn't one ghost evaluates. */
export function parseFilter(col: string, rhs: string): Filter | null {
  let rest = rhs, not = false
  if (rest.startsWith("not.")) { not = true; rest = rest.slice(4) }
  const dot = rest.indexOf(".")
  if (dot < 0) return null
  const op = rest.slice(0, dot)
  if (!OPS.has(op) || /\((any|all)\)$/.test(op)) return null
  const value = parseValue(op as FilterOp, rest.slice(dot + 1))
  if (op === "cs" && value === undefined) return null
  return { col, op: op as FilterOp, value, ...(not ? { not } : {}) }
}

/** `a.eq.1,b.gt.2,and(c.is.null,d.eq.x)` inside or=()/and=(). */
function parseGroup(inner: string): { conditions: Condition[]; evaluable: boolean } {
  const conditions: Condition[] = []
  let evaluable = true
  for (const part of splitTop(inner)) {
    const m = /^(not\.)?(or|and)\((.*)\)$/.exec(part)
    if (m) {
      const sub = parseGroup(m[3]!)
      evaluable &&= sub.evaluable && !m[1]
      conditions.push(m[2] === "or" ? { or: sub.conditions } : { and: sub.conditions })
      continue
    }
    const dot = part.indexOf(".")
    const f = dot > 0 ? parseFilter(part.slice(0, dot), part.slice(dot + 1)) : null
    if (f) conditions.push(f)
    else evaluable = false
  }
  return { conditions, evaluable }
}

function parseSelect(select: string | null): Pick<ParsedQuery, "columns" | "embeds" | "plain"> {
  if (!select || select === "*") return { columns: null, embeds: [], plain: true }
  const columns: string[] = []
  const embeds: ParsedQuery["embeds"] = []
  let plain = true
  for (const raw of splitTop(select)) {
    const item = raw.trim()
    const embed = /^(?:([A-Za-z0-9_]+):)?([A-Za-z0-9_]+)((?:![A-Za-z0-9_]+)*)\(/.exec(item)
    if (embed) {
      const marks = embed[3]!.split("!").filter(Boolean)
      const hint = marks.find((mark) => mark !== "inner" && mark !== "left")
      embeds.push({ key: embed[1] ?? embed[2]!, table: embed[2]!, ...(hint ? { hint } : {}), ...(marks.includes("inner") ? { inner: true } : {}),
        ...(item.endsWith(")") ? { select: item.slice(item.indexOf("(") + 1, -1) } : {}) })
      continue
    }
    if (item === "*") { plain = false; continue }
    if (/^[A-Za-z0-9_]+$/.test(item)) columns.push(item)
    else plain = false
  }
  return { columns: plain && columns.length ? columns : null, embeds, plain: plain && embeds.length === 0 && columns.length > 0 }
}

export function parseQuery(url: URL): ParsedQuery {
  const table = decodeURIComponent(url.pathname.replace(/^\/rest\/v1\//, ""))
  const select = parseSelect(url.searchParams.get("select"))
  const conditions: Condition[] = []
  let evaluable = true
  for (const [key, value] of url.searchParams) {
    if (RESERVED.has(key)) continue
    if (key === "or" || key === "and" || key === "not.or" || key === "not.and") {
      const sub = parseGroup(value.replace(/^\(/, "").replace(/\)$/, ""))
      evaluable &&= sub.evaluable && !key.startsWith("not.")
      conditions.push(key.endsWith("or") ? { or: sub.conditions } : { and: sub.conditions })
      continue
    }
    if (key.includes(".")) { evaluable = false; continue } // a filter on an embedded resource
    const f = parseFilter(key, value)
    if (f) conditions.push(f)
    else evaluable = false
  }
  const order = (url.searchParams.get("order") ?? "").split(",").filter(Boolean).map((o) => {
    const [col, ...mods] = o.split(".")
    return { col: col!, dir: mods.includes("desc") ? "desc" as const : "asc" as const,
      ...(mods.includes("nullsfirst") ? { nulls: "first" as const } : mods.includes("nullslast") ? { nulls: "last" as const } : {}) }
  })
  const limit = url.searchParams.get("limit"), offset = url.searchParams.get("offset")
  return { table, ...select, conditions, evaluable, order,
    ...(limit ? { limit: Number(limit) } : {}), ...(offset ? { offset: Number(offset) } : {}) }
}

const likeToRegExp = (pattern: string, flags: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/[%*]/g, ".*").replace(/_/g, ".")}$`, flags)

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" || typeof b === "number") return Number(a) - Number(b)
  if (typeof a === "boolean" || typeof b === "boolean") return String(a) === String(b) ? 0 : String(a) < String(b) ? -1 : 1
  const x = String(a), y = String(b)
  // Timestamps compare as instants: PostgREST sends them back with an offset the filter may not repeat.
  const tx = Date.parse(x), ty = Date.parse(y)
  if (/^\d{4}-\d\d-\d\d[T ]/.test(x) && /^\d{4}-\d\d-\d\d[T ]/.test(y) && !Number.isNaN(tx) && !Number.isNaN(ty)) return tx - ty
  return x < y ? -1 : x > y ? 1 : 0
}

const JSON_PATH = /->>?/
const parseJson = (text: string): unknown => { try { return JSON.parse(text) } catch { return text } }

/** `payload->>unit`, `meta->a->>b`: the value PostgREST would filter on (`->>` gives text). */
function columnValue(row: Record<string, unknown>, col: string): unknown {
  if (!JSON_PATH.test(col)) return row[col]
  const parts = col.split(/(->>?)/)
  let v: unknown = row[parts[0]!]
  if (typeof v === "string") { try { v = JSON.parse(v) } catch { return undefined } }
  for (let i = 1; i < parts.length; i += 2) {
    const key = parts[i + 1]!
    v = v != null && typeof v === "object" ? (v as Record<string, unknown>)[Array.isArray(v) ? Number(key) : key] : undefined
    if (parts[i] === "->>" && v != null) v = typeof v === "object" ? JSON.stringify(v) : String(v)
  }
  return v
}

/** jsonb `@>`: an array holds every wanted member, an object every wanted key. Array members from a literal are text. */
function contains(have: unknown, want: unknown): boolean {
  if (Array.isArray(want)) return Array.isArray(have) && want.every((w) => have.some((h) => contains(h, w)))
  if (want && typeof want === "object") {
    return !!have && typeof have === "object" && !Array.isArray(have)
      && Object.entries(want).every(([key, w]) => key in have && contains((have as Record<string, unknown>)[key], w))
  }
  return have === want || (have != null && typeof have !== "object" && typeof want === "string" && String(have) === want)
}

function testFilter(row: Record<string, unknown>, f: Filter): boolean {
  const v = columnValue(row, f.col)
  let hit: boolean
  switch (f.op) {
    case "cs": hit = contains(typeof v === "string" ? parseJson(v) : v, f.value); break
    case "is": hit = f.value === null ? v == null : v === f.value; break
    case "in": hit = v != null && (f.value as unknown[]).some((x) => compare(v, x) === 0); break
    case "like": hit = v != null && likeToRegExp(String(f.value), "").test(String(v)); break
    case "ilike": hit = v != null && likeToRegExp(String(f.value), "i").test(String(v)); break
    default: {
      if (v == null) { hit = false; break }
      const c = compare(v, f.value)
      hit = f.op === "eq" ? c === 0 : f.op === "neq" ? c !== 0 : f.op === "gt" ? c > 0 : f.op === "gte" ? c >= 0 : f.op === "lt" ? c < 0 : c <= 0
    }
  }
  return f.not ? !hit : hit
}

export function matches(row: Record<string, unknown>, conditions: Condition[]): boolean {
  return conditions.every((c) => "or" in c ? c.or.some((x) => matches(row, [x]))
    : "and" in c ? matches(row, c.and) : testFilter(row, c))
}

/** The filters as the ghost dispatcher takes them; null when they aren't a plain AND of simple filters it can run. */
export function dispatcherFilters(q: ParsedQuery): { col: string; op: FilterOp; value: unknown }[] | null {
  if (!q.evaluable) return null
  const out: { col: string; op: FilterOp; value: unknown }[] = []
  for (const c of q.conditions) {
    // The runner has no containment operator: such a read is answered live and patched with the session's rows.
    if ("or" in c || "and" in c || c.not || c.op === "cs" || JSON_PATH.test(c.col)) return null
    out.push({ col: c.col, op: c.op, value: c.value })
  }
  return out
}

/** Rows in the query's order; nulls go last ascending and first descending, as Postgres puts them. */
export function sortRows<T extends Record<string, unknown>>(rows: T[], order: ParsedQuery["order"]): T[] {
  if (!order.length) return rows
  return [...rows].sort((a, b) => {
    for (const o of order) {
      const x = columnValue(a, o.col), y = columnValue(b, o.col)
      if (x == null || y == null) {
        if (x == null && y == null) continue
        const nullsFirst = o.nulls ? o.nulls === "first" : o.dir === "desc"
        return (x == null) === nullsFirst ? -1 : 1
      }
      const c = compare(x, y)
      if (c !== 0) return o.dir === "desc" ? -c : c
    }
    return 0
  })
}

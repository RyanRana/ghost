export type FilterOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like" | "ilike" | "is" | "in"
const OPS = new Set<string>(["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in"])

export interface Filter { col: string; op: FilterOp; value: unknown; not?: boolean }
export type Condition = Filter | { or: Condition[] } | { and: Condition[] }

export interface ParsedQuery {
  table: string
  /** Plain columns, or null for `*`; null too when the select has anything else (casts, aliases, json paths). */
  columns: string[] | null
  /** The select is `*` or plain columns only, so the dispatcher can run it as written. */
  plain: boolean
  /** Embedded resources by the name they come back under, with the table each reads from when it can be told. */
  embeds: { key: string; table: string | null }[]
  conditions: Condition[]
  /** False when a filter uses an operator ghost can't evaluate exactly (cs, fts, any/all modifiers...). */
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
    const embed = /^(?:([A-Za-z0-9_]+):)?([A-Za-z0-9_]+)(?:!([A-Za-z0-9_]+))?(?:!inner|!left)?\(/.exec(item)
    if (embed) {
      embeds.push({ key: embed[1] ?? embed[2]!, table: embed[2]! })
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

function testFilter(row: Record<string, unknown>, f: Filter): boolean {
  const v = row[f.col]
  let hit: boolean
  switch (f.op) {
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
    if ("or" in c || "and" in c || c.not) return null
    out.push({ col: c.col, op: c.op, value: c.value })
  }
  return out
}

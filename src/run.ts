import { dispatcherFilters, parseQuery, type ParsedQuery } from "./query.js"
import { latestRows, patchRows, touchedTables, type GhostRowChange } from "./patch.js"
import type { Reaches } from "./reach.js"

export interface ForeignKey { name: string; table: string; columns: string[]; refColumns: string[] }
export interface Relation { kind: "table" | "view"; pk: string[]; fks?: ForeignKey[] }
export type Relations = Record<string, Relation>

type Json = unknown
type DispatchAnswer = { result?: Json; changes?: GhostRowChange[]; error?: { code: string; message: string; details?: string; hint?: string } }

const RPC = /^\/rest\/v1\/rpc\/([^/]+)$/
const TABLE = /^\/rest\/v1\/([^/]+)$/
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" }

/** PostgREST's status for an error: PTxyz is HTTP xyz, the usual SQLSTATEs map as it maps them. */
export function errorStatus(code: string): number {
  const pt = /^PT(\d{3})$/.exec(code)
  if (pt) return Number(pt[1])
  if (code === "23505" || code === "23503" || code === "40001" || code === "GH409") return 409
  if (code === "42501") return 403
  if (code === "42883" || code === "PGRST202" || code === "PGRST205" || code === "42P01") return 404
  if (code === "57014") return 504
  if (code === "55P03") return 503
  return 400
}

const wantsObject = (request: Request) => (request.headers.get("accept") ?? "").includes("vnd.pgrst.object")

function shaped(request: Request, status: number, value: Json): Response {
  if (wantsObject(request) && Array.isArray(value)) {
    if (value.length !== 1) {
      return Response.json({ code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned",
        details: `The result contains ${value.length} rows`, hint: null }, { status: 406 })
    }
    return new Response(JSON.stringify(value[0]), { status, headers: JSON_HEADERS })
  }
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS })
}

const errorResponse = (e: NonNullable<DispatchAnswer["error"]>) =>
  Response.json({ code: e.code, message: e.message, details: e.details ?? null, hint: e.hint ?? null }, { status: errorStatus(e.code) })

const refusal = (message: string) => Response.json({ code: "0A000", message, details: null, hint: null }, { status: 400 })

function rpcArgsFromQuery(url: URL): Record<string, string> {
  return Object.fromEntries([...url.searchParams].filter(([k]) => !["select", "order", "limit", "offset"].includes(k)))
}

async function bodyJson(request: Request): Promise<Json> {
  const text = await request.clone().text()
  return text ? JSON.parse(text) : {}
}

/** The dispatcher request for a database write, or a refusal when ghost can't run it exactly. */
export async function writeRequest(request: Request, relations: Relations): Promise<{ request: Json } | { refuse: string }> {
  const url = new URL(request.url)
  const rpc = RPC.exec(url.pathname)
  if (rpc) return { request: { kind: "rpc", name: decodeURIComponent(rpc[1]!), args: await bodyJson(request) } }
  const table = TABLE.exec(url.pathname)
  if (!table) return { refuse: "Ghost can't run this kind of write." }
  const q = parseQuery(url)
  const prefer = request.headers.get("prefer") ?? ""
  if (request.method === "POST" || request.method === "PUT") {
    const upsert = request.method === "PUT" || /resolution=(merge|ignore)-duplicates/.test(prefer)
    // Left out or empty ("?on_conflict="), PostgREST uses the primary key.
    const named = url.searchParams.get("on_conflict")?.split(",").filter(Boolean) ?? []
    const onConflict = named.length ? named : relations[q.table]?.pk ?? []
    return { request: { kind: "table", table: q.table, method: upsert ? "upsert" : "insert", body: await bodyJson(request),
      onConflict, ignoreDuplicates: /resolution=ignore-duplicates/.test(prefer) } }
  }
  const filters = dispatcherFilters(q)
  if (!filters) return { refuse: `Ghost can't run this ${request.method} on ${q.table}: its filters aren't plain eq/neq/in/is/gt/gte/lt/lte yet.` }
  if (request.method === "PATCH") return { request: { kind: "table", table: q.table, method: "update", filters, body: await bodyJson(request) } }
  if (request.method === "DELETE") return { request: { kind: "table", table: q.table, method: "delete", filters } }
  return { refuse: `Ghost can't run a ${request.method} yet.` }
}

/** How PostgREST would have answered the write, from what the real logic returned inside the rolled-back run. */
export function writeResponse(request: Request, answer: DispatchAnswer): Response {
  if (answer.error) return errorResponse(answer.error)
  const url = new URL(request.url)
  if (RPC.test(url.pathname)) return shaped(request, 200, answer.result ?? null)
  const representation = /return=representation/.test(request.headers.get("prefer") ?? "")
  const created = request.method === "POST" || request.method === "PUT"
  if (!representation) return new Response(null, { status: created ? 201 : 204 })
  const q = parseQuery(url)
  const rows = (Array.isArray(answer.result) ? answer.result : []) as Record<string, unknown>[]
  const projected = q.columns ? rows.map((r) => Object.fromEntries(q.columns!.map((c) => [c, r[c] ?? null]))) : rows
  return shaped(request, created ? 201 : 200, projected)
}

export type Dispatch = (fn: "ghost_run" | "ghost_read", changes: GhostRowChange[], request: Json) => Promise<DispatchAnswer>

/** A read in a session that has changes: replayed in the database when it can be run as written (views, RPCs, plain
 *  table reads), else read live and patched with the session's rows. Null means read live as usual. */
export async function ghostRead(
  request: Request, changes: GhostRowChange[], relations: Relations, dispatch: Dispatch, live: (asked?: Request) => Promise<Response>,
  branch: { tables: Set<string> } | null = null, reach: Reaches | null = null,
): Promise<Response | null> {
  // With branch migrations every read is replayed: PostgREST's schema cache can't see what they add.
  if (!changes.length && !branch) return null
  const url = new URL(request.url)
  // Another table's rows as this session sees them, for filling the embeds of a row the session added.
  const reader: ReadRows = async (path) => {
    const headers = new Headers({ accept: "application/json" })
    for (const name of ["apikey", "authorization", "accept-profile"]) {
      const value = request.headers.get(name)
      if (value) headers.set(name, value)
    }
    const asked = new Request(new URL(`/rest/v1/${path}`, url), { headers })
    const response = (await ghostRead(asked, changes, relations, dispatch, (again) => live(again ?? asked), branch, reach)) ?? await live(asked)
    if (!response.ok) throw new Error(`${path.split("?")[0]} ${response.status}`)
    return await response.json() as Row[]
  }
  const rpc = RPC.exec(url.pathname)
  if (rpc) {
    const name = decodeURIComponent(rpc[1]!)
    // A function that can't reach anything the session changed reads exactly what live reads.
    if (!branch && !seesSession(reach?.("function", name), changes)) return null
    const answer = await dispatch("ghost_read", changes, { kind: "rpc", name, args: rpcArgsFromQuery(url) })
    return answer.error ? errorResponse(answer.error) : shaped(request, 200, answer.result ?? null)
  }
  if (!TABLE.test(url.pathname)) return null
  const q = parseQuery(url)
  const relation = relations[q.table]
  const touched = new Set(changes.map((c) => c.table))
  const hit = !!branch || (relation?.kind === "view" && seesSession(reach?.("view", q.table), changes))
    || touchedTables(q).some((t) => touched.has(t))
  if (!hit) return null
  const counted = /count=/.test(request.headers.get("prefer") ?? "")
  const filters = dispatcherFilters(q)
  if (q.plain && filters && !counted && q.embeds.length === 0) {
    const answer = await dispatch("ghost_read", changes, { kind: "table", table: q.table, filters,
      ...(q.columns ? { select: q.columns } : {}), order: q.order,
      ...(q.limit != null ? { limit: q.limit } : {}), ...(q.offset != null ? { offset: q.offset } : {}) })
    if (!answer.error) return shaped(request, 200, answer.result ?? [])
    // A branch migration that failed must say so, not fall back to a live read that hides it.
    if (branch) return errorResponse(answer.error)
  }
  if (branch && touchedTables(q).some((t) => branch.tables.has(t))) {
    return refusal(`Ghost can't show ${q.table} through this read yet: it comes from a branch migration, and only plain reads `
      + "(plain columns, eq/neq/in/is/gt/gte/lt/lte filters, no embeds or counts) run against it.")
  }
  if (relation?.kind === "view" || !changes.length) return null
  return patchLive(request, q, changes, relations, live, reader)
}

/** Whether a function or view can read a row the session changed. Not knowing what it reads counts as yes. */
export function seesSession(within: ReadonlySet<string> | null | undefined, changes: readonly GhostRowChange[]): boolean {
  return !within || changes.some((change) => within.has(change.table))
}

type ReadRows = (path: string) => Promise<Row[]>
type Row = Record<string, unknown>

const inList = (values: unknown[]) => `in.(${values.map((value) => typeof value === "number" ? value : `"${String(value).replace(/"/g, '\\"')}"`).join(",")})`

/** The embeds of rows the session added, which live cannot join: each is read from its own table through the foreign
 *  key PostgREST would have followed. One it can't place (no single matching key) stays null. */
async function fillEmbeds(added: { row: Row; image: Row }[], q: ParsedQuery, relations: Relations, read: ReadRows): Promise<void> {
  for (const embed of q.embeds) {
    const named = (fk: ForeignKey) => !embed.hint || fk.name === embed.hint || fk.columns[0] === embed.hint
    const single = (fk: ForeignKey) => fk.columns.length === 1 && fk.refColumns.length === 1
    // `alias:table(...)`, or the foreign key itself: `alias:fk_column(...)` and `alias:constraint(...)`.
    const toOne = (relations[q.table]?.fks ?? []).filter(single)
      .filter((fk) => fk.table === embed.table || fk.columns[0] === embed.table || fk.name === embed.table).filter(named)
    const toMany = (embed.table ? relations[embed.table]?.fks ?? [] : []).filter(single).filter((fk) => fk.table === q.table).filter(named)
    for (const { row } of added) row[embed.key] = null
    const fk = toOne.length === 1 && !toMany.length ? toOne[0]! : toMany.length === 1 && !toOne.length ? toMany[0]! : null
    if (!fk || embed.select === undefined) continue
    const one = fk === toOne[0]
    const [mine, theirs, table] = one ? [fk.columns[0]!, fk.refColumns[0]!, fk.table] : [fk.refColumns[0]!, fk.columns[0]!, embed.table!]
    const values = [...new Set(added.map(({ image }) => image[mine]).filter((value) => value != null))]
    if (!one) for (const { row } of added) row[embed.key] = []
    if (!values.length) continue
    const selected = embed.select === "*" || embed.select.split(",").map((part) => part.trim()).includes(theirs)
    try {
      const found = await read(`${table}?select=${encodeURIComponent(selected ? embed.select : `${embed.select},${theirs}`)}&${theirs}=${encodeURIComponent(inList(values))}`)
      const shown = (item: Row) => selected ? item : Object.fromEntries(Object.entries(item).filter(([key]) => key !== theirs))
      for (const { row, image } of added) {
        const matched = found.filter((item) => String(item[theirs]) === String(image[mine])).map(shown)
        row[embed.key] = one ? matched[0] ?? null : matched
      }
    } catch (error) {
      console.error(`[ghost] could not fill ${q.table}.${embed.key} for a row the session added`, error)
    }
  }
}

async function patchLive(request: Request, q: ParsedQuery, changes: GhostRowChange[], relations: Relations,
  live: (asked?: Request) => Promise<Response>, read?: ReadRows): Promise<Response> {
  const pkOf = (t: string) => relations[t]?.pk ?? ["id"]
  // Live answers a one-row request with an error when the row is only in the session, and a select without the
  // primary key can't be matched to the session's rows: ask for the rows, with their key, and shape the answer here.
  const object = wantsObject(request)
  const missing = q.plain && q.columns ? pkOf(q.table).filter((column) => !q.columns!.includes(column)) : []
  let asked: Request | undefined
  if (object || missing.length) {
    const url = new URL(request.url)
    if (missing.length) url.searchParams.set("select", [...q.columns!, ...missing].join(","))
    const headers = new Headers(request.headers)
    if (object) headers.set("accept", "application/json")
    asked = new Request(url, { method: request.method, headers })
  }
  const response = await live(asked)
  if (!response.ok) return response
  const text = await response.text()
  let body: unknown
  try { body = JSON.parse(text) } catch { return new Response(text, { status: response.status, headers: response.headers }) }
  if (body == null && !object) return new Response(text, { status: response.status, headers: response.headers })
  const single = !Array.isArray(body)
  const added: { row: Row; image: Row }[] = []
  let patched = patchRows((single ? (body == null ? [] : [body]) : body) as Row[], q, latestRows(changes), pkOf,
    q.embeds.length && read ? added : undefined)
  if (added.length && read) {
    await fillEmbeds(added, q, relations, read)
    // An inner join drops a row with nothing on the other side.
    const empty = (value: unknown) => value == null || (Array.isArray(value) && !value.length)
    const dropped = new Set(added.filter(({ row }) => q.embeds.some((embed) => embed.inner && empty(row[embed.key]))).map(({ row }) => row))
    if (dropped.size) patched = patched.filter((row) => !dropped.has(row))
  }
  const rows = missing.length ? patched.map((row) => Object.fromEntries(q.columns!.map((column) => [column, row[column] ?? null]))) : patched
  if (object) return shaped(request, 200, rows)
  const out = single ? rows[0] ?? null : rows
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  return new Response(JSON.stringify(out), { status: response.status, headers })
}

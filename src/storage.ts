import type { GhostLog, NewWrite } from "./log/types.js"
import { tokenObject } from "./browser.js"

// A ghosted upload really lands, but under ghost/<session>/ in the same bucket, so nobody else can reach it and the
// session's end can delete it. The app keeps using the original path; only this session's storage calls are mapped.
export const GHOST_STORAGE_PREFIX = "ghost"

export const ghostObjectPath = (session: string, path: string) => `${GHOST_STORAGE_PREFIX}/${session}/${path}`

/** What a ghost upload recorded: the original object, where it really went, or that the session deleted it. */
export interface StorageMapping { bucket: string; path: string; ghostPath: string | null }

const OBJECT = "/storage/v1/object/"

export type StorageOp =
  | { kind: "upload-sign"; bucket: string; path: string }
  | { kind: "upload-signed"; bucket: string; path: string; token: string }
  | { kind: "upload"; bucket: string; path: string }
  | { kind: "sign"; bucket: string; path: string }
  | { kind: "sign-many"; bucket: string }
  | { kind: "list"; bucket: string }
  | { kind: "info"; bucket: string; path: string; prefix: string }
  | { kind: "download"; bucket: string; path: string; prefix: string }
  | { kind: "remove"; bucket: string }
  | { kind: "copy" | "move" }

const split = (rest: string): { bucket: string; path: string } | null => {
  const i = rest.indexOf("/")
  if (i <= 0 || i === rest.length - 1) return null
  return { bucket: decodeURIComponent(rest.slice(0, i)), path: decodeURIComponent(rest.slice(i + 1)) }
}

/** The storage-js call a request is, from its method and path; null for anything else. */
export function storageOp(method: string, url: URL): StorageOp | null {
  if (!url.pathname.startsWith(OBJECT)) return null
  const rest = url.pathname.slice(OBJECT.length)
  const m = method.toUpperCase()
  if (rest === "copy" || rest === "move") return m === "POST" ? { kind: rest } : null
  for (const [head, kind] of [["upload/sign/", "upload-sign"], ["sign/", "sign"], ["list/", "list"]] as const) {
    if (!rest.startsWith(head)) continue
    const tail = rest.slice(head.length)
    if (kind === "list") return m === "POST" && tail ? { kind, bucket: decodeURIComponent(tail.split("/")[0]!) } : null
    if (kind === "sign" && !tail.includes("/")) return m === "POST" && tail ? { kind: "sign-many", bucket: decodeURIComponent(tail) } : null
    const at = split(tail)
    if (!at) return null
    if (kind === "upload-sign") {
      const token = url.searchParams.get("token")
      if (m === "PUT" && token) return { kind: "upload-signed", ...at, token }
      return m === "POST" ? { kind, ...at } : null
    }
    return m === "POST" ? { kind, ...at } : null
  }
  for (const prefix of ["info/authenticated/", "info/public/", "info/"]) {
    if (!rest.startsWith(prefix)) continue
    const at = split(rest.slice(prefix.length))
    return at && (m === "GET" || m === "POST") ? { kind: "info", ...at, prefix: OBJECT + prefix } : null
  }
  for (const prefix of ["authenticated/", "public/"]) {
    if (!rest.startsWith(prefix)) continue
    const at = split(rest.slice(prefix.length))
    return at && (m === "GET" || m === "HEAD") ? { kind: "download", ...at, prefix: OBJECT + prefix } : null
  }
  if (!rest.includes("/")) return m === "DELETE" ? { kind: "remove", bucket: decodeURIComponent(rest) } : null
  const at = split(rest)
  if (!at) return null
  if (m === "POST" || m === "PUT") return { kind: "upload", ...at }
  if (m === "GET" || m === "HEAD") return { kind: "download", ...at, prefix: OBJECT }
  return null
}

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/")

/** The same request aimed at another object path, method, body and headers kept. */
export async function retarget(request: Request, pathname: string, search = new URL(request.url).search): Promise<Request> {
  const url = new URL(request.url)
  url.pathname = pathname
  url.search = search
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.clone().arrayBuffer()
  return new Request(url, { method: request.method, headers: request.headers, body })
}

export const objectUrlPath = (head: string, bucket: string, path: string) => `${head}${encodeURIComponent(bucket)}/${encodePath(path)}`

export function mappingWrite(method: string, url: URL, mapping: StorageMapping): NewWrite {
  return {
    kind: "storage", target: `storage:${mapping.bucket}`, method, path: url.pathname + url.search, headers: {},
    body: JSON.stringify(mapping),
  }
}

/** The session's storage map: the latest word on each original object (uploaded to a ghost path, or deleted). */
export async function sessionStorage(log: GhostLog): Promise<Map<string, StorageMapping>> {
  const out = new Map<string, StorageMapping>()
  for (const w of await log.writes()) {
    if (w.kind !== "storage" || !w.body) continue
    try {
      const m = JSON.parse(w.body) as StorageMapping
      if (m && typeof m.bucket === "string" && typeof m.path === "string") out.set(`${m.bucket}/${m.path}`, m)
    } catch {}
  }
  return out
}

export const storageBuckets = (map: Map<string, StorageMapping>) => [...new Set([...map.values()].map((m) => m.bucket))]

type ListEntry = { name: string; id?: string | null } & Record<string, unknown>

/** The real folder listing with this session's objects laid over it: its uploads in, its deletes out. */
export function mergeListing(real: ListEntry[], ghost: ListEntry[], deleted: Set<string>): ListEntry[] {
  const byName = new Map(real.filter((e) => !deleted.has(e.name)).map((e) => [e.name, e]))
  for (const e of ghost) byName.set(e.name, e)
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

const notFound = () => Response.json({ statusCode: "404", error: "not_found", message: "Object not found" }, { status: 400 })
const refused = (message: string) => Response.json({ statusCode: "405", error: "ghost", message }, { status: 400 })
const jsonBody = async (request: Request) => (await request.clone().json().catch(() => ({}))) as Record<string, any>
const withBody = (request: Request, body: unknown) =>
  new Request(request.url, { method: request.method, headers: request.headers, body: JSON.stringify(body) })
const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "")
const folder = (prefix: string) => prefix.replace(/^\/+|\/+$/g, "")

/** A ghost session's storage call: writes really land under ghost/<session>/, and reads of what the session wrote
 *  or deleted resolve to it. Returns null when the call doesn't touch the session's objects and can go out as is.
 *  `real` sends for real (outside ghost), so it must never route back here. */
export async function ghostStorage(request: Request, log: GhostLog, real: (request: Request) => Promise<Response>): Promise<Response | null> {
  const url = new URL(request.url)
  const op = storageOp(request.method, url)
  if (!op) return null
  const session = log.id
  const map = await sessionStorage(log)
  const mapped = (bucket: string, path: string) => map.get(`${bucket}/${path}`)
  const record = (m: StorageMapping) => log.addWrite(mappingWrite(request.method, url, m))
  const upload = async (head: string, bucket: string, path: string) => {
    const ghostPath = ghostObjectPath(session, path)
    const response = await real(await retarget(request, objectUrlPath(head, bucket, ghostPath)))
    if (response.ok) await record({ bucket, path, ghostPath })
    return response
  }
  switch (op.kind) {
    case "upload-sign":
      return upload(`${OBJECT}upload/sign/`, op.bucket, op.path)
    case "upload": {
      const response = await upload(OBJECT, op.bucket, op.path)
      if (!response.ok) return response
      return Response.json({ ...(await response.json().catch(() => ({}))), Key: `${op.bucket}/${op.path}` }, { status: response.status })
    }
    case "upload-signed": {
      const object = tokenObject(op.token)
      if (!object?.startsWith(`${op.bucket}/${GHOST_STORAGE_PREFIX}/${session}/`)) {
        return refused("Ghost mode only uploads to its own ghost/ folder; this upload was signed outside the session.")
      }
      return real(await retarget(request, `${OBJECT}upload/sign/${object.split("/").map(encodeURIComponent).join("/")}`))
    }
    case "sign":
    case "info":
    case "download": {
      const m = mapped(op.bucket, op.path)
      if (!m) return null
      if (!m.ghostPath) return notFound()
      const head = op.kind === "sign" ? `${OBJECT}sign/` : op.prefix
      return real(await retarget(request, objectUrlPath(head, op.bucket, m.ghostPath)))
    }
    case "sign-many": {
      const body = await jsonBody(request)
      const paths: string[] = Array.isArray(body.paths) ? body.paths : []
      if (!paths.some((p) => mapped(op.bucket, p))) return null
      const live = paths.filter((p) => mapped(op.bucket, p)?.ghostPath !== null)
      const sent = live.map((p) => mapped(op.bucket, p)?.ghostPath ?? p)
      const response = await real(withBody(request, { ...body, paths: sent }))
      if (!response.ok) return response
      const signed = (await response.json()) as Array<{ path: string | null } & Record<string, unknown>>
      const back = new Map(sent.map((s, i) => [s, live[i]!]))
      const byPath = new Map(signed.map((e) => [back.get(e.path ?? "") ?? e.path, { ...e, path: back.get(e.path ?? "") ?? e.path }]))
      return Response.json(paths.map((p) => byPath.get(p) ?? { error: "Either the object does not exist or you do not have access to it", path: p, signedURL: null }))
    }
    case "list": {
      const body = await jsonBody(request)
      const at = folder(String(body.prefix ?? ""))
      const under = (path: string) => !at || parentOf(path) === at || parentOf(path).startsWith(`${at}/`)
      const mine = [...map.values()].filter((m) => m.bucket === op.bucket && under(m.path))
      const hideGhost = at === ""
      if (!mine.length && !hideGhost) return null
      const response = await real(request)
      if (!response.ok || !mine.length) {
        if (!response.ok) return response
        const rows = (await response.json()) as ListEntry[]
        return Response.json(rows.filter((e) => e.name !== GHOST_STORAGE_PREFIX))
      }
      const realRows = ((await response.json()) as ListEntry[]).filter((e) => !(hideGhost && e.name === GHOST_STORAGE_PREFIX))
      const ghostAt = folder(ghostObjectPath(session, at))
      const ghostResponse = await real(withBody(request, { ...body, prefix: ghostAt }))
      const ghostRows = ghostResponse.ok ? ((await ghostResponse.json()) as ListEntry[]) : []
      const deleted = new Set(mine.filter((m) => !m.ghostPath && parentOf(m.path) === at).map((m) => m.path.slice(at ? at.length + 1 : 0)))
      return Response.json(mergeListing(realRows, ghostRows, deleted))
    }
    case "remove": {
      const body = await jsonBody(request)
      const prefixes: string[] = Array.isArray(body.prefixes) ? body.prefixes : []
      const ghostPaths = prefixes.flatMap((p) => mapped(op.bucket, p)?.ghostPath ?? [])
      if (ghostPaths.length) await real(withBody(request, { prefixes: ghostPaths }))
      for (const path of prefixes) await record({ bucket: op.bucket, path, ghostPath: null })
      return Response.json(prefixes.map((name) => ({ name, bucket_id: op.bucket })))
    }
    case "copy":
    case "move": {
      const body = await jsonBody(request)
      const from = String(body.bucketId ?? "")
      const to = String(body.destinationBucket ?? from)
      const source = mapped(from, String(body.sourceKey ?? ""))
      if (source && !source.ghostPath) return notFound()
      const destinationKey = String(body.destinationKey ?? "")
      const ghostPath = ghostObjectPath(session, destinationKey)
      // A move in ghost is a copy: the real source stays where it is and only disappears for this session.
      const copy = new Request(new URL(`${OBJECT}copy`, url), { method: "POST", headers: request.headers,
        body: JSON.stringify({ ...body, sourceKey: source?.ghostPath ?? body.sourceKey, destinationKey: ghostPath }) })
      const response = await real(copy)
      if (!response.ok) return response
      await record({ bucket: to, path: destinationKey, ghostPath })
      if (op.kind === "move") {
        await record({ bucket: from, path: String(body.sourceKey), ghostPath: null })
        return Response.json({ message: "Successfully moved" })
      }
      return Response.json({ Key: `${to}/${destinationKey}` })
    }
  }
}

/** Deletes everything a session really uploaded: its ghost/<session>/ folder in every bucket it used, and in every
 *  bucket there is when storage lists them (a session idle past its expiry forgets which buckets it used). */
export async function deleteGhostObjects(session: string, used: string[], base: string, headers: Record<string, string>, send: typeof fetch): Promise<number> {
  if (!/^[A-Za-z0-9-]+$/.test(session)) throw new Error(`[ghost] refusing to clean storage for session ${JSON.stringify(session)}`)
  const root = `${GHOST_STORAGE_PREFIX}/${session}`
  const all = await send(`${base}/storage/v1/bucket`, { headers }).then(async (r) => r.ok ? ((await r.json()) as Array<{ id: string }>).map((b) => b.id) : [])
    .catch(() => [] as string[])
  const buckets = [...new Set([...used, ...all])]
  let deleted = 0
  const list = async (bucket: string, prefix: string): Promise<string[]> => {
    const out: string[] = []
    for (let offset = 0; ; offset += 1000) {
      const res = await send(`${base}${OBJECT}list/${encodeURIComponent(bucket)}`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: "name", order: "asc" } }),
      })
      if (!res.ok) throw new Error(`[ghost] list ${bucket}/${prefix}: ${res.status} ${await res.text()}`)
      const rows = (await res.json()) as ListEntry[]
      for (const row of rows) {
        const path = `${prefix}/${row.name}`
        if (row.id) out.push(path)
        else out.push(...(await list(bucket, path)))
      }
      if (rows.length < 1000) return out
    }
  }
  for (const bucket of buckets) {
    const paths = (await list(bucket, root)).filter((p) => p.startsWith(`${root}/`))
    for (let i = 0; i < paths.length; i += 1000) {
      const res = await send(`${base}${OBJECT}${encodeURIComponent(bucket)}`, {
        method: "DELETE", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ prefixes: paths.slice(i, i + 1000) }),
      })
      if (!res.ok) throw new Error(`[ghost] delete in ${bucket}: ${res.status} ${await res.text()}`)
      deleted += paths.slice(i, i + 1000).length
    }
  }
  return deleted
}

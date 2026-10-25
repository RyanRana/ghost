import type { GhostLog, GhostWriteKind, NewWrite } from "./log/types.js"
import type { GhostRowChange } from "./patch.js"
import { writeRequest, writeResponse, type Dispatch, type Relations } from "./run.js"
import { ghostStorage } from "./storage.js"

/** An edge function's own code, run in-process instead of the deployed copy. Its fetches come back through ghost. */
export type EdgeFunction = (request: Request) => Promise<Response>

export interface WriteEngine {
  dispatch: Dispatch
  relations: () => Promise<Relations>
  /** Sends for real, outside ghost: storage writes really land, under the session's ghost/ folder. */
  real: (request: Request) => Promise<Response>
  functions: Record<string, EdgeFunction>
  /** Runs code as this session, so the global guard (when installed) ghosts what it sends. */
  inSession: <T>(run: () => Promise<T>) => Promise<T>
}

export async function sessionChanges(log: GhostLog): Promise<GhostRowChange[]> {
  return (await log.writes()).flatMap((w) => w.changes ?? [])
}

const KEPT_HEADERS = ["prefer", "accept", "content-type", "content-profile", "accept-profile"]
// Signing a URL, listing a folder or reading an object's info goes out as POST but writes nothing.
const STORAGE_READS = /^\/storage\/v1\/object\/(sign|list|info)\//

export const isStorageRead = (url: URL) => STORAGE_READS.test(url.pathname)

/** Where a database write was going, or null for a path that isn't data (auth, a storage read). */
function targetOf(url: URL): { kind: GhostWriteKind; target: string } | null {
  const path = url.pathname
  let m = /^\/rest\/v1\/rpc\/([^/]+)$/.exec(path)
  if (m) return { kind: "rpc", target: decodeURIComponent(m[1]!) }
  m = /^\/rest\/v1\/([^/]+)$/.exec(path)
  if (m) return { kind: "table", target: decodeURIComponent(m[1]!) }
  if (isStorageRead(url)) return null
  if (/^\/storage\/v1\/object\/(copy|move)$/.test(path)) return { kind: "storage", target: "storage:objects" }
  m = /^\/storage\/v1\/object\/([^/]+)/.exec(path)
  if (m) return { kind: "storage", target: `storage:${m[1]}` }
  m = /^\/functions\/v1\/([^/]+)/.exec(path)
  if (m) return { kind: "function", target: m[1]! }
  if (/^\/realtime\/v1\/api\/broadcast/.test(path)) return { kind: "function", target: "realtime:broadcast" }
  return null
}

/** The write as sent: method, path with its query string, the headers that change its meaning, and its body. */
export function describeWrite(request: Request, body: string | null): NewWrite | null {
  const url = new URL(request.url)
  const target = targetOf(url)
  if (!target) return null
  const headers: Record<string, string> = {}
  for (const name of KEPT_HEADERS) {
    const value = request.headers.get(name)
    if (value) headers[name] = value
  }
  return { ...target, method: request.method, path: url.pathname + url.search, headers, body: target.kind === "storage" ? null : body }
}

// The log failing must not turn a ghosted click into an error.
const keep = (log: GhostLog, write: NewWrite) => log.addWrite(write).catch((error) => console.error("[ghost] log write", error))

/** A ghosted write to the database host: tables and RPCs run for real and roll back, uploads land under the session's
 *  folder, edge functions run in-process, a realtime broadcast is held. Auth and storage reads go out as they are. */
export async function ghostDatabaseWrite(request: Request, log: GhostLog, engine: WriteEngine): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname.startsWith("/storage/v1/")) {
    const stored = await ghostStorage(request, log, engine.real)
    if (stored) return stored
  }
  const target = targetOf(url)
  if (!target) return engine.real(request)
  const body = target.kind === "storage" ? null : await request.clone().text()
  const write = describeWrite(request, body)!
  if (write.kind === "table" || write.kind === "rpc") return runForReal(request, write, log, engine)
  if (write.kind === "function" && !write.target.startsWith("realtime:")) return runEdgeFunctionHere(request, write, body, log, engine)
  await keep(log, write)
  await log.addHeld({ method: request.method, host: url.host, path: url.pathname, summary: `held: ${write.target}` })
    .catch((error) => console.error("[ghost] log held send", error))
  return Response.json({}, { status: 202 })
}

// The deployed function would write for real, so its own code runs here instead, as this session. A function nobody
// registered is answered "simulated" and listed with the held sends.
async function runEdgeFunctionHere(request: Request, write: NewWrite, body: string | null, log: GhostLog, engine: WriteEngine): Promise<Response> {
  await keep(log, write)
  const handler = engine.functions[write.target]
  if (handler) {
    const copy = new Request(request.url, { method: request.method, headers: request.headers, body: body || undefined })
    return engine.inSession(() => handler(copy))
  }
  const url = new URL(request.url)
  await log.addHeld({ method: request.method, host: url.host, path: url.pathname,
    summary: `simulated: would have run ${write.target} (not registered with ghost)` })
    .catch((error) => console.error("[ghost] log held send", error))
  return Response.json({ ghost: "simulated", function: write.target }, { status: 200 })
}

// The real logic runs inside a transaction that always rolls back; the answer and every row it changed come back, and
// the changes join the session so later clicks and reads see them.
async function runForReal(request: Request, write: NewWrite, log: GhostLog, engine: WriteEngine): Promise<Response> {
  const planned = await writeRequest(request, await engine.relations())
  if ("refuse" in planned) {
    await keep(log, write)
    return Response.json({ code: "0A000", message: planned.refuse, details: null, hint: null }, { status: 400 })
  }
  const answer = await engine.dispatch("ghost_run", await sessionChanges(log), planned.request)
  // An RPC that changed nothing was a read: nothing to keep.
  if (answer.changes?.length || (write.kind === "table" && !answer.error)) await keep(log, { ...write, changes: answer.changes ?? [] })
  return writeResponse(request, answer)
}

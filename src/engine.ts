import { AsyncLocalStorage } from "node:async_hooks"
import { GhostCallError, restCall, type GhostCall } from "./call.js"
import { DatabaseGhostLog } from "./log/database.js"
import { MemoryGhostLog } from "./log/memory.js"
import { SqliteGhostLog } from "./log/sqlite.js"
import { sessionSummary, type GhostLog } from "./log/types.js"
import { migrationPayload, type BranchMigrations, type LedgerRow } from "./migrations.js"
import { migrationLoader, type MigrationSource } from "./migrations-node.js"
import { bodySummary, DEFAULT_ALLOWED_HOSTS, isOutboundWrite, type HostRule } from "./outbound.js"
import { ghostRead, type Dispatch, type Relations } from "./run.js"
import { deleteGhostObjects, ghostStorage, sessionStorage, storageBuckets } from "./storage.js"
import { BranchTurns, failedMigration, ghostStatusText, isNoTurn } from "./turns.js"
import { ghostDatabaseWrite, sessionChanges, type EdgeFunction, type WriteEngine } from "./write.js"

export type LogFactory = (id: string, context: { call: GhostCall }) => GhostLog

export const memoryLog = (): LogFactory => (id) => new MemoryGhostLog(id)
/** Every session in one SQLite file: local sessions survive a restart. */
export const sqliteLog = (path: string): LogFactory => (id) => new SqliteGhostLog(id, path)
/** Sessions in the database itself (ghost.sessions): for a deployment with more than one server. */
export const databaseLog = (): LogFactory => (id, { call }) => new DatabaseGhostLog(id, call)

export interface GhostOptions {
  /** The Supabase (or any PostgREST) URL, e.g. https://xyz.supabase.co. */
  url: string
  /** The service role key: ghost's runners are granted to service_role only. */
  serviceKey: string
  /** Where sessions are kept. Default: memory. */
  log?: LogFactory
  /** Run your branch's migrations the database doesn't have yet, inside every ghost run. Local development only. */
  migrations?: MigrationSource
  /** Edge functions to run in-process, by name. Any other function call is held and answered "simulated". */
  functions?: Record<string, EdgeFunction>
  /** Outside hosts whose writes still go out in ghost. Default: Sentry ingest. */
  allowHosts?: HostRule[]
  /** The fetch ghost sends real requests with. Default: the global fetch as it was when ghost was created. */
  fetch?: typeof fetch
}

export interface GhostSession {
  readonly id: string
  readonly log: GhostLog
  /** Give this to createClient(url, key, { global: { fetch } }): that client is ghosted for this session. */
  fetch: typeof fetch
  /** Runs code as this session: with the guard installed, every fetch inside is ghosted. */
  run<T>(fn: () => Promise<T>): Promise<T>
  summary(): ReturnType<typeof sessionSummary>
  /** Forgets everything this session did; it goes on. */
  reset(): Promise<void>
  /** Ends the session: its log and its uploads are deleted. */
  end(): Promise<void>
}

export interface Ghost {
  session(id: string): GhostSession
  /** Code inside sends for real, even inside a session (a dry run that rolls itself back, ghost's own calls). */
  real<T>(fn: () => Promise<T>): Promise<T>
  /** Patches globalThis.fetch: inside session.run(), database requests are ghosted and outside sends are held. */
  installGuard(): void
  /** The branch migrations ghost runs, when `migrations` is set. */
  branch(): Promise<BranchMigrations | null>
  /** One line and any notices, for a status bar. */
  status(): Promise<{ label: string; notices: string[] }>
}

const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/
const RELATIONS_TTL_MS = 10 * 60_000
const READS = new Set(["GET", "HEAD", "OPTIONS"])
const GUARD = Symbol.for("ghost.guard")

export function createGhost(options: GhostOptions): Ghost {
  const send = options.fetch ?? globalThis.fetch.bind(globalThis)
  const base = options.url.replace(/\/+$/, "")
  const dbHost = new URL(base).host
  const allow = options.allowHosts ?? DEFAULT_ALLOWED_HOSTS
  const functions = options.functions ?? {}
  const makeLog = options.log ?? memoryLog()

  const realScope = new AsyncLocalStorage<true>()
  const sessionScope = new AsyncLocalStorage<GhostSession>()
  const real = <T>(fn: () => Promise<T>) => realScope.run(true, fn)
  const realSend: typeof fetch = (input, init) => real(() => send(input, init))
  const call = restCall(base, options.serviceKey, realSend)

  let relationsCache: { at: number; value: Promise<Relations> } | null = null
  const relations = () => {
    if (!relationsCache || Date.now() - relationsCache.at > RELATIONS_TTL_MS) {
      const value = call("ghost_relations", {}) as Promise<Relations>
      value.catch(() => { relationsCache = null })
      relationsCache = { at: Date.now(), value }
    }
    return relationsCache.value
  }

  const loadBranch = options.migrations
    ? migrationLoader(options.migrations, {
      ledger: async () => (await call("ghost_applied_migrations", {})) as LedgerRow[],
      tables: async () => new Set(Object.keys(await relations())),
    })
    : null

  const turns = new BranchTurns(async (migrations) => {
    try {
      const answer = (await call("ghost_read", { p_changes: [], p_request: { kind: "migrations", migrations } })) as { error?: { code?: string; message?: string } }
      return answer?.error ?? null
    } catch (e) {
      return { code: (e as GhostCallError).code, message: (e as Error).message }
    }
  })

  const branch = async (): Promise<BranchMigrations | null> => {
    if (!loadBranch) return null
    try {
      const found = await loadBranch()
      turns.sync(found)
      return found
    } catch (error) {
      console.error("[ghost] branch migrations", error)
      return null
    }
  }

  const dispatch: Dispatch = async (fn, changes, request) => {
    const migrations = migrationPayload(await branch())
    let answer: Awaited<ReturnType<Dispatch>>
    try {
      answer = (await call(fn, { p_changes: changes, p_request: migrations.length ? { ...(request as object), migrations } : request })) as typeof answer
    } catch (e) {
      return { error: { code: (e as GhostCallError).code ?? "XX000", message: (e as Error).message } }
    }
    const file = isNoTurn(answer.error?.code) ? failedMigration(answer.error?.message) : null
    if (file && answer.error) {
      turns.missed(file)
      return { ...answer, error: { ...answer.error, message: turns.messageFor(file) ?? answer.error.message } }
    }
    return answer
  }

  const sessions = new Map<string, GhostSession>()

  const handle = async (request: Request, session: GhostSession): Promise<Response> => {
    const url = new URL(request.url)
    const method = request.method.toUpperCase()
    if (url.host !== dbHost) {
      if (!isOutboundWrite(method, url, dbHost, allow)) return send(request)
      await session.log.addHeld({ method, host: url.host, path: url.pathname, summary: await bodySummary(request) })
        .catch((error) => console.error("[ghost] log held send", error))
      return Response.json({}, { status: 200 })
    }
    if (!READS.has(method)) {
      const engine: WriteEngine = { dispatch, relations, real: (r) => realSend(r), functions, inSession: (fn) => session.run(fn) }
      return ghostDatabaseWrite(request, session.log, engine)
    }
    if (url.pathname.startsWith("/storage/v1/")) return (await ghostStorage(request, session.log, (r) => realSend(r))) ?? realSend(request)
    if (method === "GET" && url.pathname.startsWith("/rest/v1/")) {
      const [changes, found] = await Promise.all([sessionChanges(session.log), branch()])
      const pending = migrationPayload(found).length > 0
      if (changes.length || pending) {
        const answer = await ghostRead(request, changes, await relations(), dispatch, () => realSend(new Request(request)),
          pending ? { tables: new Set(found!.createdTables) } : null)
        if (answer) return answer
      }
    }
    return realSend(request)
  }

  const session = (id: string): GhostSession => {
    if (!SESSION_ID.test(id)) throw new Error(`[ghost] a session id is 1-64 letters, digits or dashes, not ${JSON.stringify(id)}`)
    const open = sessions.get(id)
    if (open) return open
    const log = makeLog(id, { call })
    const s: GhostSession = {
      id,
      log,
      fetch: (input, init) => {
        if (realScope.getStore()) return send(input, init)
        return handle(new Request(input, init), s)
      },
      run: (fn) => sessionScope.run(s, fn),
      summary: () => sessionSummary(log),
      reset: async () => {
        await deleteUploads(log)
        await log.reset()
      },
      end: async () => {
        await deleteUploads(log)
        await log.end()
        sessions.delete(id)
      },
    }
    sessions.set(id, s)
    return s
  }

  const deleteUploads = async (log: GhostLog) => {
    const buckets = storageBuckets(await sessionStorage(log))
    const headers = { apikey: options.serviceKey, authorization: `Bearer ${options.serviceKey}` }
    await deleteGhostObjects(log.id, buckets, base, headers, realSend).catch((error) => console.error("[ghost] delete uploads", error))
  }

  return {
    session,
    real,
    installGuard() {
      const scope = globalThis as typeof globalThis & { [GUARD]?: true }
      if (scope[GUARD]) return
      scope[GUARD] = true
      const original = globalThis.fetch.bind(globalThis)
      globalThis.fetch = (input, init) => {
        const current = sessionScope.getStore()
        if (!current || realScope.getStore()) return original(input, init)
        return current.fetch(input, init)
      }
    },
    branch,
    async status() {
      return ghostStatusText(await branch(), turns.status())
    },
  }
}

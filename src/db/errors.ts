/** Why ghost stopped a run. The database's own errors (a check that failed, a bad column) pass through unchanged. */
export type GhostErrorCode =
  /** A statement that can't run inside a transaction that has to roll back. */
  | "refused"
  /** A row the session inserted now clashes with a real row added since. */
  | "collision"
  /** The session's earlier rows couldn't be put back: the live data changed under them. */
  | "replay"
  /** Ghost isn't installed in this database, or the install is out of date. */
  | "install"
  /** Ghost couldn't confirm the run rolled back. */
  | "unsafe"

const NOTHING_SAVED = "Nothing was saved."

export class GhostError extends Error {
  readonly ghost = true
  constructor(readonly code: GhostErrorCode, message: string, options?: { cause?: unknown }) {
    super(message.endsWith(NOTHING_SAVED) ? message : `${message.replace(/\.?$/, ".")} ${NOTHING_SAVED}`, options)
    this.name = "GhostError"
  }
}

export const isGhostError = (e: unknown): e is GhostError => !!e && typeof e === "object" && (e as { ghost?: unknown }).ghost === true

export interface RetryOptions {
  tries: number
  transient: (error: unknown) => boolean
  baseMs?: number
  capMs?: number
}

/** Runs `fn` again on a transient error, backing off with full jitter. Safe here: a ghost run never keeps anything. */
export async function retrying<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const { tries, transient, baseMs = 25, capMs = 1_000 } = options
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt)
    } catch (error) {
      if (attempt >= tries || isGhostError(error) || !transient(error)) throw error
      const wait = Math.random() * Math.min(capMs, baseMs * 2 ** attempt)
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }
}

/** One at a time: a session's runs, or every run on a single connection. */
export function serial() {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn)
    tail = run.catch(() => {})
    return run
  }
}

export function errorCode(error: unknown): string | undefined {
  const e = error as { code?: unknown; errno?: unknown } | null
  if (!e || typeof e !== "object") return undefined
  return typeof e.code === "string" ? e.code : typeof e.code === "number" ? String(e.code) : undefined
}

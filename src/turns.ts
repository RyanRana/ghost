import { heavyNotice, migrationPayload, type BranchMigrations, type HeavyStatement } from "./migrations.js"

// A heavy branch migration needs a lock on a live table. Ghost never waits for one: every try gives up after the
// runners' 200 ms lock_timeout, and the server asks again in the background, backing off, until it gets a turn.

export type TurnState = "waiting" | "ok" | "no-turn" | "failed"

export interface Turn {
  file: string
  heavy: HeavyStatement
  state: TurnState
  tries: number
  nextAt: number | null
  message: string | null
}

/** A try that couldn't get its lock (55P03) or ran past the runners' statement_timeout (57014). */
export const isNoTurn = (code: string | undefined) => code === "55P03" || code === "57014"

/** The file a runner's "Branch migration <file> failed: …" error names. */
export function failedMigration(message: string | undefined): string | null {
  return /^Branch migration (\S+) failed:/.exec(message ?? "")?.[1] ?? null
}

export interface TurnOptions { maxTries: number; baseMs: number; capMs: number }
export const TURN_DEFAULTS: TurnOptions = { maxTries: 8, baseMs: 1_000, capMs: 60_000 }

type Probe = (migrations: { file: string; sql: string }[]) => Promise<{ code?: string; message?: string } | null>

export class BranchTurns {
  private turns = new Map<string, Turn & { sql: string }>()
  private payload: { file: string; sql: string }[] = []

  constructor(
    private probe: Probe,
    private options: TurnOptions = TURN_DEFAULTS,
    private now: () => number = Date.now,
    private later: (run: () => void, ms: number) => void = (run, ms) => { setTimeout(run, ms).unref?.() },
  ) {}

  /** Follows the branch's current migrations: a heavy file that's new or edited starts waiting for its turn. */
  sync(m: BranchMigrations | null): void {
    this.payload = migrationPayload(m)
    const seen = new Set<string>()
    for (const p of m?.runnable ?? []) {
      if (!p.heavy.length || !p.sql) continue
      seen.add(p.file)
      if (this.turns.get(p.file)?.sql === p.sql) continue
      this.turns.set(p.file, { file: p.file, heavy: p.heavy[0]!, sql: p.sql, state: "waiting", tries: 0, nextAt: this.now(), message: null })
      this.later(() => void this.attempt(p.file), 0)
    }
    for (const file of this.turns.keys()) if (!seen.has(file)) this.turns.delete(file)
  }

  /** A click's run couldn't get this file's lock: it waits for a turn again. */
  missed(file: string): void {
    const turn = this.turns.get(file)
    if (!turn || turn.state === "waiting") return
    Object.assign(turn, { state: "waiting", tries: 0, nextAt: this.now(), message: null })
    this.later(() => void this.attempt(file), 0)
  }

  status(): Turn[] {
    return [...this.turns.values()].map(({ sql: _sql, ...turn }) => turn)
  }

  /** What a click that hit this file's lock should say. */
  messageFor(file: string): string | null {
    const turn = this.turns.get(file)
    if (!turn) return null
    if (turn.state === "no-turn") return turn.message
    return `Ghost is waiting for a turn on ${turn.heavy.table} for ${file}: ${heavyNotice(turn.heavy)}. It keeps trying in the background; try again in a moment.`
  }

  private async attempt(file: string): Promise<void> {
    const turn = this.turns.get(file)
    if (!turn || turn.state !== "waiting") return
    const upTo = this.payload.slice(0, this.payload.findIndex((p) => p.file === file) + 1)
    let error: { code?: string; message?: string } | null
    try {
      error = await this.probe(upTo)
    } catch (e) {
      error = { message: e instanceof Error ? e.message : String(e) }
    }
    if (this.turns.get(file) !== turn) return
    turn.tries++
    if (!error) {
      Object.assign(turn, { state: "ok", nextAt: null, message: null })
    } else if (!isNoTurn(error.code)) {
      Object.assign(turn, { state: "failed", nextAt: null, message: error.message ?? "The ghost run didn't answer." })
    } else if (turn.tries >= this.options.maxTries) {
      Object.assign(turn, { state: "no-turn", nextAt: null,
        message: `Ghost couldn't get a turn on ${turn.heavy.table} for ${file} after ${turn.tries} tries: live traffic kept it busy, so the migration hasn't run in ghost.` })
    } else {
      const wait = Math.min(this.options.capMs, this.options.baseMs * 2 ** (turn.tries - 1))
      turn.nextAt = this.now() + wait
      this.later(() => void this.attempt(file), wait)
    }
  }
}

/** Plain words for a status line: what ghost runs on, and anything about the branch's migrations a person should know. */
export function ghostStatusText(m: BranchMigrations | null, turns: Turn[]): { label: string; notices: string[] } {
  const n = m?.runnable.length ?? 0
  const label = n ? `Ghost · live database + ${n} branch migration${n === 1 ? "" : "s"}` : "Ghost · live database"
  const notices = (m?.refused ?? []).map((p) =>
    `${p.file} isn't running in ghost: it ${p.refused!.why}${p.refused!.table ? ` (${p.refused!.table})` : ""}.`)
  for (const turn of turns) {
    if (turn.state === "waiting") notices.push(`${turn.file}: ${heavyNotice(turn.heavy)}.`)
    else if (turn.state === "no-turn") notices.push(turn.message!)
    else if (turn.state === "failed") notices.push(`${turn.file} failed in ghost: ${turn.message}`)
  }
  return { label, notices }
}

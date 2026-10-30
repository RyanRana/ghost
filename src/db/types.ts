import type { GhostRowChange } from "../patch.js"

export type Row = Record<string, unknown>
export type RowChange = GhostRowChange

/** One database connection, whatever the driver: everything ghost runs goes through this. */
export interface Conn {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: Row[]; affected: number }>
}

/** Hands out one connection for one run. `release` is always called, after the rollback; `broken` means drop it. */
export interface ConnSource {
  acquire(): Promise<{ conn: Conn; release(broken?: boolean): void | Promise<void> }>
  close?(): Promise<void>
}

export interface Migration { file: string; sql: string }

export interface OpenOptions {
  /** Record every row the run changes. Off for reads. */
  capture: boolean
  /** Branch migrations to run first, inside the same rolled-back transaction. */
  migrations: Migration[]
  /** Statement timeout for the run, in milliseconds. */
  timeoutMs: number
}

export interface Check { name: string; ok: boolean; detail: string }

export type DialectName = "postgres" | "mysql" | "sqlite"

/** What one database needs to run a ghost run: open it, collect what changed, roll it back. */
export interface Dialect {
  readonly name: DialectName
  /** Begins the run on `conn`: the never-commit guard, the session's rows replayed with triggers skipped, capture on. */
  open(conn: Conn, changes: readonly RowChange[], options: OpenOptions): Promise<void>
  /** Capture off, and every row the run changed, in the order they changed. */
  close(conn: Conn): Promise<RowChange[]>
  /** Always rolls back, and clears anything a run could leave on the connection. */
  rollback(conn: Conn): Promise<void>
  /** Why this statement can't run inside a run that has to roll back, or null. */
  refuse(statement: string, conn: Conn): Promise<string | null>
  /** A deadlock, a lock wait or a busy database: the whole run can go again, since nothing was kept. */
  transient(error: unknown): boolean
  /** Adds or refreshes what ghost needs in the database. Safe to run again. */
  install(conn: Conn): Promise<Record<string, unknown>>
  /** How many tables or triggers are new since the last install (0 when there's nothing to install). */
  stale(conn: Conn): Promise<number>
  doctor(conn: Conn): Promise<Check[]>
}

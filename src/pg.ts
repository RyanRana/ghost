import type { Query } from "./call.js"
import { createGhostDb } from "./db/engine.js"
import { pgSingleSource, postgresDialect } from "./db/postgres.js"
import type { GhostLog } from "./log/types.js"
import type { GhostRowChange } from "./patch.js"

export interface GhostPgOptions {
  /** Branch migrations to run first in every run, as { file, sql } (see prepareMigration / migrationLoader). */
  migrations?: () => Promise<{ file: string; sql: string }[]>
}

export interface GhostPg {
  /** One statement as a ghost write: it runs for real, the rows it changed join the session, nothing is kept. */
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; changes: GhostRowChange[] }>
  /** Several statements in one ghost run, as one write. */
  transaction<T>(run: (query: Query) => Promise<T>): Promise<{ result: T; changes: GhostRowChange[] }>
  /** A read that sees the session's earlier writes. */
  read(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

/** Ghost on one plain Postgres connection (a pool client, not the pool), with a session log you already have.
 *  For a URL or a pool, `connect()` is simpler. */
export function ghostPg(client: { query: Query }, log: GhostLog, options: GhostPgOptions = {}): GhostPg {
  const db = createGhostDb({ dialect: postgresDialect, source: pgSingleSource(client), log: () => log, migrations: options.migrations })
  const session = db.session(log.id)
  return {
    async query(text, values) {
      const { rows, changes } = await session.query(text, values)
      return { rows, changes }
    },
    transaction: (run) => session.transaction(run),
    read: (text, values) => session.read(text, values),
  }
}

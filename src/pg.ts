import type { Query } from "./call.js"
import type { GhostLog } from "./log/types.js"
import type { GhostRowChange } from "./patch.js"
import { sessionChanges } from "./write.js"

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

/** Ghost on a plain Postgres connection. `client` must be one connection (a pool client, not the pool): the run is
 *  a real transaction on it that always rolls back, and the database refuses to commit it whatever happens. */
export function ghostPg(client: { query: Query }, log: GhostLog, options: GhostPgOptions = {}): GhostPg {
  const open = async (capture: boolean) => {
    const [changes, migrations] = await Promise.all([sessionChanges(log), options.migrations?.() ?? []])
    await client.query("begin")
    await client.query("select ghost.open_run($1::text::jsonb, $2::text::jsonb, $3::boolean)",
      [JSON.stringify(changes), migrations.length ? JSON.stringify(migrations) : null, capture])
  }
  const rollback = () => client.query("rollback").catch(() => {})

  const transaction = async <T>(run: (query: Query) => Promise<T>, label: string) => {
    await open(true)
    try {
      const result = await run((text, values) => client.query(text, values))
      const { rows } = await client.query("select ghost.close_run() as changes")
      const changes = (rows[0]?.changes ?? []) as GhostRowChange[]
      await rollback()
      if (changes.length) {
        await log.addWrite({ kind: "sql", method: "SQL", target: "sql", path: "", headers: {}, body: label, changes })
      }
      return { result, changes }
    } catch (error) {
      await rollback()
      throw error
    }
  }

  return {
    async query(text, values) {
      const { result, changes } = await transaction((q) => q(text, values), text)
      return { rows: result.rows, changes }
    },
    transaction: (run) => transaction(run, "transaction"),
    async read(text, values) {
      await open(false)
      try {
        return { rows: (await client.query(text, values)).rows }
      } finally {
        await rollback()
      }
    },
  }
}

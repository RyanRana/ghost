import { createGhostDb, type GhostDb, type GhostDbOptions } from "./engine.js"
import { isMysqlConnection, isMysqlPool, mysqlDialect, mysqlPoolSource, mysqlSingleSource, type MysqlPool, type MysqlQueryable } from "./mysql.js"
import { isPgPool, isPostgresJs, pgPoolSource, pgSingleSource, postgresDialect, postgresJsSource, type PgQueryable, type PostgresJs } from "./postgres.js"
import { isSqliteDatabase, sqliteDialect, sqliteSource, type SqliteDatabase } from "./sqlite.js"
import type { ConnSource, Dialect, DialectName } from "./types.js"

export interface ConnectOptions extends Omit<GhostDbOptions, "dialect" | "source"> {
  /** Which database a driver object talks to, when ghost can't tell (a bare `{ query }`). */
  dialect?: DialectName
  /** Connections in the pool ghost opens for a URL. Default 5. */
  pool?: number
}

const DIALECTS: Record<DialectName, Dialect> = { postgres: postgresDialect, mysql: mysqlDialect, sqlite: sqliteDialect }

/** Which database a URL or path points at. */
export function dialectOf(url: string): DialectName | null {
  if (/^postgres(ql)?:\/\//i.test(url)) return "postgres"
  if (/^(mysql2?|mariadb):\/\//i.test(url)) return "mysql"
  if (/^(sqlite3?|file):/i.test(url) || url === ":memory:" || /\.(db|db3|sqlite|sqlite3)$/i.test(url)) return "sqlite"
  return null
}

function sqlitePath(url: string): string {
  if (url === ":memory:") return url
  const path = url.replace(/^(sqlite3?|file):(\/\/)?/i, "")
  return path || ":memory:"
}

async function fromUrl(url: string, pool: number): Promise<{ dialect: Dialect; source: ConnSource }> {
  const name = dialectOf(url)
  if (name === "postgres") {
    const { default: postgres } = await import("postgres")
    const sql = postgres(url, { max: pool, onnotice: () => {}, prepare: false }) as unknown as PostgresJs
    return { dialect: postgresDialect, source: postgresJsSource(sql, true) }
  }
  if (name === "mysql") {
    const mysql = await import("mysql2/promise").catch(() => {
      throw new Error("runghost: MySQL needs the mysql2 package: npm install mysql2")
    })
    const created = mysql.createPool({ uri: url.replace(/^(mysql2|mariadb):/i, "mysql:"), connectionLimit: pool, multipleStatements: false })
    return { dialect: mysqlDialect, source: mysqlPoolSource(created as unknown as MysqlPool, true) }
  }
  if (name === "sqlite") {
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite")
    const db = new DatabaseSync(sqlitePath(url))
    db.exec("pragma busy_timeout = 5000")
    return { dialect: sqliteDialect, source: sqliteSource(db, () => db.close()) }
  }
  throw new Error(`runghost: can't tell which database ${JSON.stringify(url.replace(/\/\/[^@/]*@/, "//***@"))} is. `
    + "Use a postgres://, mysql://, mariadb:// or sqlite: URL, or a .db/.sqlite path.")
}

function fromDriver(driver: unknown, named?: DialectName): { dialect: Dialect; source: ConnSource } {
  if (isPostgresJs(driver)) return { dialect: postgresDialect, source: postgresJsSource(driver, false) }
  if (isPgPool(driver)) return { dialect: postgresDialect, source: pgPoolSource(driver, false) }
  if (isMysqlPool(driver)) return { dialect: mysqlDialect, source: mysqlPoolSource(driver, false) }
  if (isMysqlConnection(driver) || (named === "mysql" && typeof (driver as MysqlQueryable)?.query === "function")) {
    return { dialect: mysqlDialect, source: mysqlSingleSource(driver as MysqlQueryable) }
  }
  if (isSqliteDatabase(driver)) return { dialect: sqliteDialect, source: sqliteSource(driver as SqliteDatabase) }
  if (typeof (driver as PgQueryable)?.query === "function" && (!named || named === "postgres")) {
    return { dialect: postgresDialect, source: pgSingleSource(driver as PgQueryable) }
  }
  throw new Error("runghost: can't tell what database driver this is. Pass a URL, or { dialect } with a postgres.js, pg, PGlite, mysql2 or SQLite handle.")
}

/** Ghost on any database: a URL (postgres://, mysql://, mariadb://, sqlite:, a .db path) or a driver you already have
 *  (postgres.js, a pg Pool or Client, PGlite, a mysql2 pool or connection, node:sqlite or better-sqlite3).
 *    const ghost = await connect(process.env.DATABASE_URL)
 *    const { rows, changes } = await ghost.session("agent-1").query("update orders set shipped = true where id = $1", [7]) */
export async function connect(target: string | object, options: ConnectOptions = {}): Promise<GhostDb> {
  const { dialect: named, pool = 5, ...rest } = options
  const found = typeof target === "string" ? await fromUrl(target, pool) : fromDriver(target, named)
  const dialect = named && typeof target === "string" ? DIALECTS[named] : found.dialect
  return createGhostDb({ ...rest, dialect, source: found.source })
}

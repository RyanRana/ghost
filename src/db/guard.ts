import { splitStatements, type SqlSyntax } from "../migrations.js"
import type { DialectName } from "./types.js"

// Every ghost run is one transaction that always rolls back. A statement that ends that transaction, or that the
// database saves the moment it runs, would let what follows land for real, so it never reaches the database.

/** The statement with comments and quoted text blanked, lowercased, on one line. */
export function shape(statement: string, syntax: SqlSyntax = {}): string {
  let s = statement.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ")
  if (syntax.mysql) s = s.replace(/#[^\n]*/g, " ").replace(/'(?:[^'\\]|\\.|'')*'/g, "''").replace(/"(?:[^"\\]|\\.|"")*"/g, '""')
  else s = s.replace(/'(?:[^']|'')*'/g, "''").replace(/\$([A-Za-z_0-9]*)\$[\s\S]*?\$\1\$/g, "$$$$")
  return s.replace(/\s+/g, " ").trim().toLowerCase()
}

const verb = (s: string) => s.replace(/^\(+\s*/, "").split(" ", 3)

const TRANSACTION = /^(begin|start transaction|commit|end|abort|rollback(?! to\b)|prepare transaction|commit prepared|rollback prepared|xa)\b/

const ends = (word: string) => `Ghost can't run ${word.toUpperCase()}: every ghost run is one transaction that always rolls back`

function refusePostgres(s: string): string | null {
  if (TRANSACTION.test(s)) return ends(verb(s)[0]!)
  if (/^(vacuum|checkpoint|discard|create database|drop database|alter system|create tablespace|drop tablespace)\b/.test(s)) {
    return `Ghost can't run ${verb(s).slice(0, 2).join(" ").toUpperCase()}: Postgres can't run it inside a transaction`
  }
  if (/\bdblink(_exec)?\s*\(/.test(s)) return "Ghost can't run dblink: it writes to another database, outside the rollback"
  if (/\bcopy\b.*\bprogram\b/.test(s)) return "Ghost can't run COPY ... PROGRAM: it runs a program outside the database"
  if (/\blo_(import|export)\s*\(/.test(s)) return "Ghost can't run lo_import/lo_export: they touch server files"
  return null
}

function refuseSqlite(s: string): string | null {
  if (/^(begin|commit|end|rollback(?! to\b))\b/.test(s)) return ends(verb(s)[0]!)
  if (/^(vacuum|attach|detach)\b/.test(s)) return `Ghost can't run ${verb(s)[0]!.toUpperCase()} inside a transaction`
  if (/^pragma\s+[a-z_.]+\s*=/.test(s)) return "Ghost can't change a PRAGMA: it would outlive the rollback"
  return null
}

// MySQL saves DDL, LOCK TABLES and more the moment they run (an implicit commit), so only statements known to stay
// inside the transaction are let through.
const MYSQL_RUNS = new Set(["select", "insert", "update", "delete", "replace", "with", "values", "table", "do", "show",
  "describe", "desc", "explain", "savepoint", "call", "set", "rollback", "release", "handler"])

function refuseMysql(s: string): string | null {
  const [first = "", second = ""] = verb(s)
  if (!MYSQL_RUNS.has(first)) {
    if (TRANSACTION.test(s)) return ends(first)
    return `Ghost can't run ${[first, second].join(" ").trim().toUpperCase()} on MySQL: MySQL saves it the moment it runs, so it can't be rolled back`
  }
  if (first === "rollback" && second !== "to") return ends("rollback")
  if (first === "release" && second !== "savepoint") return ends("release")
  if (first === "set" && !/^set\s+@(?!@)/.test(s)) {
    return "Ghost can't change MySQL session settings (only @variables): they'd outlive the rollback"
  }
  if (/\binto\s+(outfile|dumpfile)\b/.test(s)) return "Ghost can't write files with SELECT ... INTO OUTFILE"
  return null
}

const RULES: Record<DialectName, (s: string) => string | null> = { postgres: refusePostgres, sqlite: refuseSqlite, mysql: refuseMysql }

/** Why ghost can't run this SQL, or null. Every statement in it is checked. */
export function refusal(dialect: DialectName, sql: string): string | null {
  const syntax = { mysql: dialect === "mysql" }
  for (const statement of splitStatements(sql, syntax)) {
    const why = RULES[dialect](shape(statement, syntax))
    if (why) return why
  }
  return null
}

/** The procedures a statement CALLs (MySQL), lowercased and unquoted. */
export function calledProcedures(sql: string): string[] {
  const out: string[] = []
  for (const statement of splitStatements(sql, { mysql: true })) {
    const m = /^call\s+`?([a-z0-9_$.]+)`?/.exec(shape(statement, { mysql: true }))
    if (m) out.push(m[1]!.split(".").pop()!)
  }
  return out
}

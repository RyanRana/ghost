import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, watch } from "node:fs"
import { join } from "node:path"
import { pendingFiles, prepareAll, type BranchMigrations, type LedgerRow } from "./migrations.js"

export interface MigrationSource {
  /** The folder of .sql migrations, e.g. supabase/migrations. */
  dir: string
  /** Files counted as applied whatever the ledger says (for a ledger that starts after the repo did). */
  baseline?: string[]
  /** A git ref: files already applied but edited since it count as pending again. */
  editedSince?: string
}

export interface MigrationDeps {
  ledger: () => Promise<LedgerRow[]>
  /** The database's tables and views; null when they can't be read, so every table counts as live. */
  tables: () => Promise<Set<string> | null>
}

const CHECK_TTL_MS = 5 * 60_000

function editedSince(dir: string, ref: string | undefined): Set<string> {
  if (!ref) return new Set()
  try {
    const out = execFileSync("git", ["diff", "--name-only", ref, "--", "."], { cwd: dir, encoding: "utf8" })
    return new Set(out.split("\n").filter(Boolean).map((p) => p.split("/").pop()!))
  } catch {
    return new Set()
  }
}

/** The branch's pending migrations, read once and kept until a file in the folder changes or five minutes pass. */
export function migrationLoader(source: MigrationSource, deps: MigrationDeps): () => Promise<BranchMigrations> {
  let at = 0
  let value: Promise<BranchMigrations> | null = null
  if (existsSync(source.dir)) {
    try {
      watch(source.dir, () => { value = null }).unref()
    } catch {
      // No watcher (read-only checkout): the five-minute check still catches a change.
    }
  }
  const load = async (): Promise<BranchMigrations> => {
    const [ledger, tables] = await Promise.all([deps.ledger(), deps.tables().catch(() => null)])
    const files = existsSync(source.dir) ? readdirSync(source.dir) : []
    const pending = pendingFiles(files, ledger, new Set(source.baseline ?? []), editedSince(source.dir, source.editedSince))
    return prepareAll(pending, (file) => readFileSync(join(source.dir, file), "utf8"), { existing: (t) => (tables ? tables.has(t) : true) })
  }
  return () => {
    if (!value || Date.now() - at > CHECK_TTL_MS) {
      const next = load()
      next.catch(() => { if (value === next) value = null })
      value = next
      at = Date.now()
    }
    return value
  }
}

#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { createInterface } from "node:readline"
import { restCall } from "./call.js"
import { connect, dialectOf } from "./db/connect.js"
import type { GhostDb } from "./db/engine.js"
import { SqliteGhostLog, openGhostFile } from "./log/sqlite.js"
import { sessionSummary } from "./log/types.js"

const HELP = `runghost: test on your real database without saving anything.
Postgres, Supabase, MySQL, MariaDB and SQLite.

  runghost init           ask for your database, save it to .env.local, install ghost, check it works
  runghost install        install or update ghost in the database (SQLite needs nothing)
  runghost doctor         check every piece is connected
  runghost sql            print the Postgres install SQL (paste it into the Supabase SQL editor)
  runghost query "<sql>"  run one statement in ghost and print { rows, changes } as JSON
                          --read for a read, --session <id> to keep it in a session, --params '[1, "a"]'
  runghost sessions       list local sessions (.ghost/ghost.sqlite)
  runghost show <id>      every row one session changed, as JSON
  runghost reset <id>     forget one local session's changes

  DATABASE_URL (or --db) is postgres://, mysql://, mariadb://, sqlite:<path> or a .db/.sqlite path.
  Flags for agents and CI (no prompts): --db <url> --url <supabase url> --key <service role key> --yes
  Add --json to doctor and sessions for machine-readable output.`

const SQL_PATH = new URL("../sql/ghost.sql", import.meta.url)
const ENV_FILE = ".env.local"
const SESSION_FILE = ".ghost/ghost.sqlite"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const has = (name: string) => args.includes(`--${name}`)
const json = has("json")

function loadEnv() {
  for (const file of [ENV_FILE, ".env"]) {
    if (existsSync(file)) {
      try { process.loadEnvFile(file) } catch {}
    }
  }
}

const env = () => ({
  url: flag("url") || process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || undefined,
  key: flag("key") || process.env.SUPABASE_SERVICE_ROLE_KEY || undefined,
  db: flag("db") || process.env.DATABASE_URL || undefined,
})

function ask(question: string, { secret = false, fallback = "" } = {}): Promise<string> {
  if (has("yes") || !process.stdin.isTTY) return Promise.resolve(fallback)
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  const shown = fallback && !secret ? ` (${fallback})` : fallback ? " (keep current)" : ""
  if (secret) {
    const write = (rl as unknown as { _writeToOutput: (s: string) => void })
    const plain = write._writeToOutput.bind(rl)
    let prompted = false
    write._writeToOutput = (s: string) => {
      if (!prompted) { plain(s); prompted = s.includes(":") } else if (s.includes("\n")) plain("\n")
      else plain("*")
    }
  }
  return new Promise((resolve) => rl.question(`${question}${shown}: `, (answer) => {
    rl.close()
    resolve(answer.trim() || fallback)
  }))
}

const AGENT_NOTE = `
## Testing on the real database (ghost)

This project has ghost (runghost): writes run through the real database logic and are rolled back.
- Check it works: \`npx runghost doctor --json\`
- One statement: \`npx runghost query "update ... returning *" --session agent-<task>\` prints the rows and every row it changed.
  Later statements in the same session see those rows; nobody else does.
- In code: \`const s = (await (await import("runghost")).connect(process.env.DATABASE_URL)).session("agent-<task>")\`, then
  \`await s.query(sql, params)\` and \`await s.read(sql, params)\`. On Supabase, \`ghostClient("agent-<task>")\` gives a supabase-js
  client instead, and outside sends (email, Slack, payments) are held, never sent.
- Clean up: \`npx runghost reset agent-<task>\`. Prove changes in ghost before doing them for real; never work around a ghost refusal.
`

/** Adds the ghost note to the project's AGENTS.md (or CLAUDE.md when that's what it has), once. */
function addAgentNote(): string {
  const file = existsSync("AGENTS.md") || !existsSync("CLAUDE.md") ? "AGENTS.md" : "CLAUDE.md"
  const text = existsSync(file) ? readFileSync(file, "utf8") : ""
  if (text.includes("runghost")) return `${file} already mentions ghost`
  appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}${AGENT_NOTE}`)
  return `added a ghost note to ${file}`
}

const yes = async (question: string) => has("yes") || /^y/i.test(await ask(`${question} [y/n]`))

/** Adds or replaces KEY=value lines in .env.local and keeps that file out of git. */
function saveEnv(values: Record<string, string | undefined>) {
  let text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : ""
  for (const [k, v] of Object.entries(values)) {
    if (!v) continue
    const line = `${k}=${v}`
    text = new RegExp(`^${k}=.*$`, "m").test(text) ? text.replace(new RegExp(`^${k}=.*$`, "m"), line) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`
  }
  writeFileSync(ENV_FILE, text, { mode: 0o600 })
  const ignore = existsSync(".gitignore") ? readFileSync(".gitignore", "utf8") : ""
  const missing = [ENV_FILE, ".ghost"].filter((p) => !ignore.split("\n").some((l) => l.trim() === p || l.trim() === `${p}/`))
  if (missing.length) appendFileSync(".gitignore", `${ignore && !ignore.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`)
}

/** Ghost on DATABASE_URL, with sessions in the local file; closed when `run` is done. */
async function withDb<T>(run: (ghost: GhostDb) => Promise<T>): Promise<T> {
  const { db } = env()
  if (!db) throw new Error("DATABASE_URL isn't set. Run `npx runghost init`, or pass --db <url>.")
  const ghost = await connect(db, { log: (id) => new SqliteGhostLog(id, SESSION_FILE), pool: 1 })
  try {
    return await run(ghost)
  } finally {
    await ghost.close()
  }
}

/** One line for what an install did, whichever database it was. */
function installSummary(report: Record<string, any>): string {
  if (report.capture) {
    const failed = [...(report.guards?.failed ?? []), ...(report.counters?.failed ?? [])]
    return `installed: ${report.capture.added} capture triggers, ${report.guards.patched} guarded trigger functions, ${report.counters.twins} ghost counters`
      + (failed.length ? `\ncould not rewrite: ${JSON.stringify(failed)}` : "")
  }
  if ("captured" in report) {
    return `installed: capture on ${report.captured} tables, ${report.guarded} of your triggers guarded`
      + (report.skippedNoPrimaryKey?.length ? `\nno primary key, so not captured: ${report.skippedNoPrimaryKey.join(", ")}` : "")
      + (report.failed?.length ? `\ncould not guard: ${JSON.stringify(report.failed)}` : "")
  }
  return String(report.note ?? JSON.stringify(report))
}

type Check = { name: string; ok: boolean; detail: string }

async function doctor(): Promise<Check[]> {
  const { url, key, db } = env()
  // Any database needs only DATABASE_URL; Supabase also needs the URL and key for its API, and then DATABASE_URL only to install.
  const supabase = !!(url || key) || !db
  const kind = db ? dialectOf(db) : null
  const checks: Check[] = supabase
    ? [
      { name: "SUPABASE_URL", ok: !!url, detail: url ?? "not set" },
      { name: "SUPABASE_SERVICE_ROLE_KEY", ok: !!key, detail: key ? "set" : "not set" },
      { name: "DATABASE_URL", ok: true, detail: db ? "set (used to install and for runghost query)" : "not set: install from the SQL editor with `runghost sql`" },
    ]
    : [{ name: "DATABASE_URL", ok: !!kind, detail: kind ? `set (${kind})` : "not a postgres://, mysql://, mariadb:// or sqlite: URL" }]
  if (url && key) {
    const call = restCall(url, key)
    try {
      const relations = (await call("ghost_relations", {})) as Record<string, unknown>
      checks.push({ name: "ghost installed", ok: true, detail: `${Object.keys(relations).length} tables and views visible` })
      const answer = (await call("ghost_read", { p_changes: [], p_request: { kind: "migrations", migrations: [] } })) as { error?: { message: string } }
      checks.push({ name: "rolled-back run", ok: !answer?.error, detail: answer?.error?.message ?? "runs and rolls back" })
    } catch (e) {
      checks.push({ name: "ghost installed", ok: false, detail: `${(e as Error).message}. Run runghost install, then reload the API schema.` })
    }
  }
  if (kind) {
    try {
      checks.push(...(await withDb((ghost) => ghost.doctor())).checks)
    } catch (e) {
      const err = e as Error & { code?: string }
      checks.push({ name: "database connection", ok: false, detail: err.message || err.code || String(e) })
    }
  }
  return checks
}

function printChecks(checks: Check[]) {
  if (json) return console.log(JSON.stringify({ ok: checks.every((c) => c.ok), checks }, null, 2))
  for (const c of checks) console.log(`${c.ok ? "ok  " : "FIX "} ${c.name}: ${c.detail}`)
}

async function main() {
  loadEnv()
  const [command, ...rest] = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--") && !["--yes", "--json"].includes(args[i - 1]!)))
  switch (command) {
    case "init": {
      const current = env()
      console.log("ghost setup. Everything is saved to .env.local, which is kept out of git.\n")
      const db = await ask("Database URL (postgres://, mysql://, mariadb://, sqlite:./app.db; blank for Supabase's SQL editor)",
        { secret: true, fallback: current.db ?? "" })
      if (db && !dialectOf(db)) throw new Error("That isn't a postgres://, mysql://, mariadb:// or sqlite: URL.")
      let url = current.url ?? "", key = current.key ?? ""
      if (!db || dialectOf(db) === "postgres") {
        console.log("\nOn Supabase? Project Settings → API has the URL and service_role key (for ghostClient). Leave blank otherwise.\n")
        url = await ask("Supabase project URL", { fallback: url })
        key = url ? await ask("Service role key", { secret: true, fallback: key }) : ""
      }
      saveEnv({ SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key, DATABASE_URL: db })
      process.env.SUPABASE_URL = url
      process.env.SUPABASE_SERVICE_ROLE_KEY = key
      if (db) process.env.DATABASE_URL = db
      const what = { postgres: "a ghost schema, a capture trigger per table and a two-line guard per trigger function",
        mysql: "two _ghost_ tables, capture triggers per table and a guard in each of your triggers", sqlite: "" }[dialectOf(db) ?? "postgres"]
      if (db && what && await yes(`Install ghost into this database now? It adds ${what}`)) {
        console.log(installSummary(await withDb((ghost) => ghost.install())))
      } else if (!db) {
        console.log("\nPaste the output of `npx runghost sql` into the Supabase SQL editor, then run: select ghost.install();")
      }
      if (await yes("Add a short ghost note to this project's AGENTS.md so coding agents use it")) console.log(addAgentNote())
      console.log("")
      printChecks(await doctor())
      console.log('\nTry it: npx runghost query "select 1"')
      return
    }
    case "install": {
      const report = await withDb((ghost) => ghost.install())
      console.log(json ? JSON.stringify(report, null, 2) : installSummary(report))
      return
    }
    case "doctor": {
      const checks = await doctor()
      printChecks(checks)
      process.exitCode = checks.every((c) => c.ok) ? 0 : 1
      return
    }
    case "sql":
      process.stdout.write(`${readFileSync(SQL_PATH, "utf8")}\nselect ghost.install();\n`)
      return
    case "query": {
      const text = rest[0]
      if (!text) throw new Error('What should run? runghost query "<sql>"')
      const params = flag("params") ? JSON.parse(flag("params")!) as unknown[] : []
      if (!Array.isArray(params)) throw new Error("--params is a JSON array, e.g. --params '[1, \"a\"]'")
      const id = flag("session")
      const out = await withDb(async (ghost) => {
        // Without --session the statement runs in a throwaway session nobody keeps.
        const session = ghost.session(id ?? `once-${process.pid}`)
        try {
          return has("read") ? await session.read(text, params) : await session.query(text, params)
        } finally {
          if (!id) await session.end()
        }
      })
      console.log(JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2))
      return
    }
    case "show": {
      const id = rest[0]
      if (!id) throw new Error("Which session? runghost show <id> (see runghost sessions)")
      if (!existsSync(SESSION_FILE)) throw new Error("No local sessions yet.")
      console.log(JSON.stringify((await new SqliteGhostLog(id, SESSION_FILE).writes()).flatMap((w) => w.changes ?? []), null, 2))
      return
    }
    case "sessions": {
      if (!existsSync(SESSION_FILE)) return console.log(json ? "[]" : "no local sessions")
      const db = openGhostFile(SESSION_FILE)
      const ids = (db.prepare("select id from sessions order by last_seen_at desc").all() as { id: string }[]).map((r) => r.id)
      const summaries = await Promise.all(ids.map((id) => sessionSummary(new SqliteGhostLog(id, SESSION_FILE), 5)))
      if (json) return console.log(JSON.stringify(summaries, null, 2))
      for (const s of summaries) console.log(`${s.sessionId}  ${s.writeCount} writes, ${s.heldSends} held sends, since ${s.startedAt}`)
      return
    }
    case "reset": {
      const id = rest[0]
      if (!id) throw new Error("Which session? runghost reset <id> (see runghost sessions)")
      await new SqliteGhostLog(id, SESSION_FILE).reset()
      console.log(`reset ${id}`)
      return
    }
    default:
      console.log(HELP)
  }
}

main().catch((error) => {
  console.error(`runghost: ${(error as Error).message}`)
  process.exitCode = 1
})

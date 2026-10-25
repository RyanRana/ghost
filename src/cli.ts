#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { createInterface } from "node:readline"
import { restCall } from "./call.js"
import { SqliteGhostLog, openGhostFile } from "./log/sqlite.js"
import { ghostPg } from "./pg.js"
import { sessionSummary } from "./log/types.js"

const HELP = `runghost: test on your real database without saving anything.

  runghost init         ask for your keys, save them to .env.local, install ghost, check it works
  runghost install      install or update ghost in the database (needs DATABASE_URL)
  runghost doctor       check every piece is connected
  runghost sql          print the install SQL (paste it into the Supabase SQL editor)
  runghost query "<sql>"  run one statement in ghost and print { rows, changes } as JSON (--read for a read,
                        --session <id> to keep it in a session; needs DATABASE_URL)
  runghost sessions     list local sessions (.ghost/ghost.sqlite)
  runghost reset <id>   forget one local session's changes

  Flags for agents and CI (no prompts): --url <supabase url> --key <service role key> --db <connection string> --yes
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

This project has [ghost](https://github.com/RyanRana/ghost): writes run through the real database logic and are rolled back.
- Check it works: \`npx runghost doctor --json\`
- One statement: \`npx runghost query "update ... returning *" --session agent-<task>\` prints the rows and every row it changed.
- In code: \`const { db } = await (await import("runghost")).ghostClient("agent-<task>")\` is a Supabase client whose writes roll back
  and whose reads see your session's earlier writes. Outside sends (email, Slack, payments) are held, never sent.
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

async function install(db: string) {
  const { default: postgres } = await import("postgres")
  const sql = postgres(db, { max: 1, onnotice: () => {}, prepare: false })
  try {
    await sql.unsafe(readFileSync(SQL_PATH, "utf8"))
    const [row] = await sql.unsafe("select ghost.install() as report")
    return row!.report as Record<string, any>
  } finally {
    await sql.end()
  }
}

type Check = { name: string; ok: boolean; detail: string }

async function doctor(): Promise<Check[]> {
  const { url, key, db } = env()
  // Plain Postgres needs only the connection string; Supabase needs the URL and key, and the string only to install.
  const supabase = !!(url || key) || !db
  const checks: Check[] = supabase
    ? [
      { name: "SUPABASE_URL", ok: !!url, detail: url ?? "not set" },
      { name: "SUPABASE_SERVICE_ROLE_KEY", ok: !!key, detail: key ? "set" : "not set" },
      { name: "DATABASE_URL", ok: true, detail: db ? "set (used to install and for runghost query)" : "not set: install from the SQL editor with `runghost sql`" },
    ]
    : [{ name: "DATABASE_URL", ok: true, detail: "set (plain Postgres: no Supabase keys needed)" }]
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
  if (db) {
    try {
      const { default: postgres } = await import("postgres")
      const sql = postgres(db, { max: 1, onnotice: () => {}, prepare: false })
      try {
        const [row] = await sql.unsafe(`select
          (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
            where n.nspname = 'public' and l.lanname = 'plpgsql' and p.prorettype = 'trigger'::regtype
              and position('ghost.replay' in pg_get_functiondef(p.oid)) = 0)::int as unguarded,
          (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'
            and exists (select 1 from pg_index i where i.indrelid = c.oid and i.indisprimary)
            and not exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'zz_ghost_capture'))::int as uncaptured`)
        const stale = Number(row!.unguarded) + Number(row!.uncaptured)
        checks.push({ name: "install is current", ok: stale === 0,
          detail: stale ? `${row!.unguarded} trigger functions and ${row!.uncaptured} tables are new since the last install: run runghost install` : "every table and trigger function is covered" })
      } finally {
        await sql.end()
      }
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
      console.log("ghost setup. Keys are saved to .env.local, which is kept out of git.\n")
      console.log("Supabase: Project Settings → API (URL, service_role key) and → Database (connection string).\n")
      const url = await ask("Supabase project URL", { fallback: current.url ?? "" })
      const key = await ask("Service role key", { secret: true, fallback: current.key ?? "" })
      const db = await ask("Database connection string (only to install; blank to use the SQL editor)", { secret: true, fallback: current.db ?? "" })
      saveEnv({ SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key, DATABASE_URL: db })
      process.env.SUPABASE_URL = url
      process.env.SUPABASE_SERVICE_ROLE_KEY = key
      if (db) process.env.DATABASE_URL = db
      if (db && await yes("Install ghost into this database now? It adds a ghost schema, a capture trigger per table and a two-line guard per trigger function")) {
        const report = await install(db)
        console.log(`installed: ${report.capture.added} capture triggers, ${report.guards.patched} guarded trigger functions, ${report.counters.twins} ghost counters`)
        if (report.guards.failed.length || report.counters.failed.length) console.log("could not rewrite:", JSON.stringify([...report.guards.failed, ...report.counters.failed]))
      } else if (!db) {
        console.log("\nPaste the output of `npx runghost sql` into the Supabase SQL editor, then run: select ghost.install();")
      }
      if (await yes("Add a short ghost note to this project's AGENTS.md so coding agents use it")) console.log(addAgentNote())
      console.log("")
      printChecks(await doctor())
      console.log('\nTry it: npx runghost query "select now()"')
      return
    }
    case "install": {
      const { db } = env()
      if (!db) throw new Error("DATABASE_URL isn't set. Run runghost init, or paste `runghost sql` into the SQL editor.")
      console.log(JSON.stringify(await install(db), null, 2))
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
      const { db } = env()
      if (!text) throw new Error('What should run? runghost query "<sql>"')
      if (!db) throw new Error("DATABASE_URL isn't set. Run npx runghost init.")
      const { default: postgres } = await import("postgres")
      const sql = postgres(db, { max: 1, onnotice: () => {}, prepare: false })
      const connection = await sql.reserve()
      try {
        const query = async (q: string, values: unknown[] = []) => ({ rows: [...(await connection.unsafe(q, values as never[]))] as Record<string, unknown>[] })
        const id = flag("session")
        const pg = ghostPg({ query }, id ? new SqliteGhostLog(id, SESSION_FILE) : new (await import("./log/memory.js")).MemoryGhostLog("once"))
        const out = has("read") ? await pg.read(text) : await pg.query(text)
        console.log(JSON.stringify(out, null, 2))
      } finally {
        connection.release()
        await sql.end()
      }
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

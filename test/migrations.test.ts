import { describe, expect, it, vi } from "vitest"
import { migrationPayload, pendingFiles, prepareAll, prepareMigration, splitStatements, type BranchMigrations } from "../src/migrations.js"
import { BranchTurns, failedMigration, ghostStatusText } from "../src/turns.js"
import { ghostRead, type Dispatch, type Relations } from "../src/run.js"

const live = new Set(["nest_groups", "order_parts", "inventory_items"])
const rules = { existing: (t: string) => live.has(t) }
const prep = (sql: string, created = new Set<string>()) => prepareMigration("20991231000000_x.sql", sql, rules, created)

describe("finding the branch's pending migrations", () => {
  const ledger = [{ version: "20261001000000", name: "a" }, { version: "20261024120000", name: "renamed_on_apply" }]
  it("counts a file applied by version, by name, or by the baseline, and an applied file edited since main as pending", () => {
    const files = ["20261001000000_a.sql", "20261002000000_renamed_on_apply.sql", "20261003000000_old.sql",
      "20261004000000_new.sql", "20261001000000_a.sql.bak", "README.md"]
    expect(pendingFiles(files, ledger, new Set(["20261003000000_old.sql"]), new Set(["20261001000000_a.sql"]))).toEqual([
      { file: "20261001000000_a.sql", reason: "edited" },
      { file: "20261004000000_new.sql", reason: "new" },
    ])
  })
})

describe("preparing a migration for the ghost transaction", () => {
  it("splits on semicolons outside quotes, comments and dollar bodies", () => {
    expect(splitStatements("select ';'; -- a; b\ncreate function f() returns int as $f$ begin return 1; end $f$ language plpgsql; select 2"))
      .toEqual(["select ';'", "-- a; b\ncreate function f() returns int as $f$ begin return 1; end $f$ language plpgsql", "select 2"])
  })

  it("strips transaction control and pgrst notifies, and skips speed-only index builds", () => {
    const p = prep("begin;\ncreate index concurrently if not exists a on nest_groups (x);\ndrop index concurrently b;\n"
      + "create index c on order_parts (y);\ncreate function f() returns int language sql as $$ select 1 $$;\nnotify pgrst, 'reload schema';\ncommit;")
    expect(p.refused).toBeNull()
    expect(p.heavy).toEqual([])
    expect(p.skipped).toHaveLength(3)
    expect(p.sql).toBe("create function f() returns int language sql as $$ select 1 $$;")
  })

  it("keeps what Postgres does from the catalog alone as light", () => {
    for (const sql of [
      "alter table nest_groups add column note text",
      "alter table nest_groups add column if not exists flag boolean not null default false",
      "alter table nest_groups add column at timestamptz default now()",
      "alter table nest_groups add constraint c check (x > 0) not valid",
      "alter table nest_groups add constraint f foreign key (a) references order_parts (id) not valid",
      "alter table nest_groups drop column old, alter column x set default 3, alter column y drop not null",
      "alter table nest_groups rename column a to b",
      "create trigger t after insert on nest_groups for each row execute function f()",
    ]) expect(prep(sql).heavy, sql).toEqual([])
  })

  it("marks rewrites, row checks, unique indexes and backfills on live tables heavy, naming the table", () => {
    const cases: [string, string][] = [
      ["alter table public.nest_groups alter column x type numeric", "rewrites"],
      ["alter table nest_groups add column id2 uuid default gen_random_uuid()", "rewrites"],
      ["alter table nest_groups alter column x set not null", "checks every row of"],
      ["alter table nest_groups add constraint c check (x > 0)", "checks every row of"],
      ["alter table nest_groups validate constraint c", "checks every row of"],
      ["alter table nest_groups add constraint u unique (a, b)", "builds an index over"],
      ["create unique index u on nest_groups (a)", "builds a unique index over"],
      ["update nest_groups set x = 1 where x is null", "backfills"],
      ["insert into order_parts (a) select a from nest_groups", "backfills"],
      ["do $$ begin update inventory_items set y = 2; end $$", "backfills"],
    ]
    for (const [sql, does] of cases) {
      const p = prep(sql)
      expect(p.refused, sql).toBeNull()
      expect(p.sql, sql).not.toBe("")
      expect(p.heavy[0], sql).toMatchObject({ does })
    }
    expect(prep("update inventory_items set y = 2").heavy[0]!.table).toBe("inventory_items")
  })

  it("treats a table the branch creates as light, whatever it does to it", () => {
    const created = new Set<string>()
    const p = prep("create table zz_new (id uuid primary key, x int);\nalter table zz_new alter column x type bigint;\nupdate zz_new set x = 1", created)
    expect(p.heavy).toEqual([])
    expect([...created]).toEqual(["zz_new"])
  })

  it("refuses only what would outlive the rollback, naming the file and statement", () => {
    for (const sql of ["select pg_advisory_lock(1)", "alter type status add value 'x'", "vacuum nest_groups",
      "refresh materialized view concurrently mv", "set role postgres", "select dblink('x', 'y')"]) {
      const p = prep(`create function ok() returns int language sql as $$ select 1 $$;\n${sql}`)
      expect(p.sql, sql).toBeNull()
      expect(p.refused?.statement, sql).toBe(sql)
    }
  })

  it("collects created tables across files and ships only files with something to run", () => {
    const files: Record<string, string> = {
      "1_a.sql": "create table zz_a (id int primary key);",
      "2_b.sql": "create index i on zz_a (id);",
      "3_c.sql": "select pg_advisory_lock(1);",
    }
    const m = prepareAll(Object.keys(files).map((file) => ({ file, reason: "new" as const })), (f) => files[f]!, rules)
    expect(m.createdTables).toEqual(["zz_a"])
    expect(m.refused.map((p) => p.file)).toEqual(["3_c.sql"])
    expect(migrationPayload(m)).toEqual([{ file: "1_a.sql", sql: "create table zz_a (id int primary key);" }])
  })
})

const heavyBranch = (): BranchMigrations => prepareAll([{ file: "5_h.sql", reason: "new" }],
  () => "alter table nest_groups alter column x type numeric;", rules)

describe("heavy migrations waiting for a turn", () => {
  const harness = (answers: ({ code?: string; message?: string } | null)[]) => {
    const queue: { run: () => void; ms: number }[] = []
    const probe = vi.fn(async () => answers.shift() ?? null)
    const turns = new BranchTurns(probe, { maxTries: 3, baseMs: 100, capMs: 1000 }, () => 0, (run, ms) => { queue.push({ run, ms }) })
    const step = async () => { const next = queue.shift()!; next.run(); await new Promise((r) => setTimeout(r, 0)); return next.ms }
    return { turns, probe, queue, step }
  }
  const locked = { code: "55P03", message: "Branch migration 5_h.sql failed: canceling statement due to lock timeout" }

  it("retries with backoff until the lock is free", async () => {
    const { turns, probe, step } = harness([locked, locked, null])
    turns.sync(heavyBranch())
    expect(turns.status()[0]).toMatchObject({ state: "waiting", tries: 0 })
    expect(ghostStatusText(heavyBranch(), turns.status()).notices).toEqual(["5_h.sql: this migration rewrites nest_groups, it may take a while."])
    expect(await step()).toBe(0)
    expect(await step()).toBe(100)
    expect(await step()).toBe(200)
    expect(turns.status()[0]).toMatchObject({ state: "ok", tries: 3 })
    expect(probe).toHaveBeenCalledWith([{ file: "5_h.sql", sql: "alter table nest_groups alter column x type numeric;" }])
  })

  it("says plainly when it never got a turn, and starts over when a click misses the lock later", async () => {
    const { turns, step, queue } = harness([locked, locked, locked])
    turns.sync(heavyBranch())
    await step(); await step(); await step()
    expect(turns.status()[0]!.state).toBe("no-turn")
    expect(turns.messageFor("5_h.sql")).toMatch(/couldn't get a turn on nest_groups for 5_h.sql after 3 tries/)
    expect(queue).toHaveLength(0)
    turns.missed("5_h.sql")
    expect(turns.status()[0]).toMatchObject({ state: "waiting", tries: 0 })
    expect(turns.messageFor("5_h.sql")).toMatch(/waiting for a turn on nest_groups.*rewrites nest_groups, it may take a while/)
  })

  it("stops retrying a migration that fails for a reason other than its lock", async () => {
    const { turns, step } = harness([{ code: "42P01", message: "Branch migration 5_h.sql failed: no such table" }])
    turns.sync(heavyBranch())
    await step()
    expect(turns.status()[0]).toMatchObject({ state: "failed" })
    expect(failedMigration("Branch migration 5_h.sql failed: x")).toBe("5_h.sql")
  })
})

describe("the ghost bar", () => {
  it("names the live database and how many branch migrations run, and why one doesn't", () => {
    expect(ghostStatusText(null, []).label).toBe("Ghost · live database")
    const m = prepareAll([{ file: "1_a.sql", reason: "new" }, { file: "2_b.sql", reason: "new" }],
      (f) => (f === "1_a.sql" ? "create table zz_a (id int primary key);" : "select pg_advisory_lock(1);"), rules)
    const text = ghostStatusText(m, [])
    expect(text.label).toBe("Ghost · live database + 1 branch migration")
    expect(text.notices).toEqual(["2_b.sql isn't running in ghost: it takes a session advisory lock, which survives the rollback."])
  })
})

describe("reads while the branch has migrations", () => {
  const BASE = "https://test.supabase.co/rest/v1"
  const relations: Relations = { nest_groups: { kind: "table", pk: ["id"] } }
  const branch = { tables: new Set(["zz_branch"]) }
  const liveRead = async () => Response.json([{ id: "live" }])

  it("replays a plain read in the database even with no session changes", async () => {
    const dispatch = vi.fn<Dispatch>(async () => ({ result: [{ id: "g" }] }))
    const res = await ghostRead(new Request(`${BASE}/nest_groups?select=id&id=eq.g`), [], relations, dispatch, liveRead, branch)
    expect(await res!.json()).toEqual([{ id: "g" }])
    expect(dispatch.mock.calls[0]![0]).toBe("ghost_read")
  })

  it("sends a branch-only RPC read through the runner", async () => {
    const dispatch = vi.fn<Dispatch>(async () => ({ result: { ok: true } }))
    const res = await ghostRead(new Request(`${BASE}/rpc/zz_branch_fn?a=1`), [], relations, dispatch, liveRead, branch)
    expect(await res!.json()).toEqual({ ok: true })
    expect(dispatch.mock.calls[0]![2]).toMatchObject({ kind: "rpc", name: "zz_branch_fn" })
  })

  it("surfaces a failed migration instead of falling back to a live read", async () => {
    const dispatch = vi.fn<Dispatch>(async () => ({ error: { code: "42P01", message: "Branch migration 1_a.sql failed: boom" } }))
    const res = await ghostRead(new Request(`${BASE}/nest_groups?select=id`), [], relations, dispatch, liveRead, branch)
    expect(res!.status).toBeGreaterThanOrEqual(400)
    expect((await res!.json()).message).toMatch(/1_a.sql failed/)
  })

  it("refuses an embed read of a branch table, and leaves one of a live table live", async () => {
    const dispatch = vi.fn<Dispatch>(async () => ({ result: [] }))
    const refused = await ghostRead(new Request(`${BASE}/zz_branch?select=id,nest_groups(id)`), [], relations, dispatch, liveRead, branch)
    expect((await refused!.json()).message).toMatch(/Ghost can't show zz_branch through this read yet/)
    expect(await ghostRead(new Request(`${BASE}/nest_groups?select=id,order_parts(id)`), [], relations, dispatch, liveRead, branch)).toBeNull()
  })
})

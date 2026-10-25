import { describe, expect, it } from "vitest"
import { one, shop } from "./fixture.js"

const run = (db: Awaited<ReturnType<typeof shop>>, changes: unknown[], request: unknown) =>
  one(db, "select public.ghost_run($1::jsonb, $2::jsonb)", [JSON.stringify(changes), JSON.stringify(request)])
const read = (db: Awaited<ReturnType<typeof shop>>, changes: unknown[], request: unknown) =>
  one(db, "select public.ghost_read($1::jsonb, $2::jsonb)", [JSON.stringify(changes), JSON.stringify(request)])

describe("ghost.sql", () => {
  it("installs counters, capture triggers and replay guards", async () => {
    const db = await shop()
    const again = await one(db, "select ghost.install()")
    expect(again.capture.added).toBe(0)
    expect(again.guards.patched).toBe(0)
    expect(await one(db, "select count(*)::int from ghost.sequence_map")).toBeGreaterThanOrEqual(4)
  })

  it("runs a write for real and keeps nothing, numbers included", async () => {
    const db = await shop()
    const answer = await run(db, [], { kind: "table", table: "orders", method: "insert", body: { customer_id: 1 } })
    expect(answer.error).toBeUndefined()
    expect(Number(answer.result[0].order_no)).toBeGreaterThanOrEqual(9000001)
    expect(answer.changes.map((c: any) => `${c.op} ${c.table}`)).toEqual(["INSERT orders"])
    expect(await one(db, "select count(*)::int from orders")).toBe(1)
    expect(await one(db, "select nextval('order_no_seq')::int")).toBe(1002)
  })

  it("captures what triggers changed, not just the row asked for", async () => {
    const db = await shop()
    const answer = await run(db, [], { kind: "rpc", name: "add_line", args: { p_order: 1, p_qty: 3, p_price: 2.5 } })
    expect(answer.changes.map((c: any) => `${c.op} ${c.table}`).sort()).toEqual(["INSERT order_lines", "UPDATE orders"])
    expect(Number(answer.changes.find((c: any) => c.table === "orders").new.total)).toBe(7.5)
    expect(await one(db, "select total::numeric from orders where id = 1")).toBe("0")
  })

  it("replays a session's changes so later reads and writes see them", async () => {
    const db = await shop()
    const first = await run(db, [], { kind: "rpc", name: "add_line", args: { p_order: 1, p_qty: 2, p_price: 10 } })
    const seen = await read(db, first.changes, { kind: "table", table: "order_totals", filters: [{ col: "id", op: "eq", value: 1 }] })
    expect(seen.result).toEqual([{ id: 1, order_no: 1001, total: 20, lines: 1 }])

    const shipped = await run(db, first.changes, { kind: "table", table: "orders", method: "update",
      filters: [{ col: "id", op: "eq", value: 1 }], body: { shipped: true } })
    expect(shipped.error).toBeUndefined()
    // The real guard runs on the new write, and the replayed rows skip it.
    const refused = await run(db, [...first.changes, ...shipped.changes], { kind: "rpc", name: "add_line", args: { p_order: 1, p_qty: 1, p_price: 1 } })
    expect(refused.error).toMatchObject({ code: "P0001", message: "Shipped orders are final" })
    expect(await one(db, "select shipped from orders where id = 1")).toBe(false)
  })

  it("never lets a replay commit", async () => {
    const db = await shop()
    const first = await run(db, [], { kind: "rpc", name: "add_line", args: { p_order: 1, p_qty: 1, p_price: 1 } })
    await expect(db.exec(`begin; select ghost.apply_changes('${JSON.stringify(first.changes)}'::jsonb); commit;`))
      .rejects.toThrow("A ghost replay can never commit.")
    await db.exec("rollback").catch(() => {})
    expect(await one(db, "select count(*)::int from order_lines")).toBe(0)
  })

  it("refuses to commit a run opened on a real connection", async () => {
    const db = await shop()
    await db.exec("begin")
    await db.query("select ghost.open_run()")
    await db.query("insert into order_lines (order_id, qty, price) values (1, 4, 5)")
    const changes = await one(db, "select ghost.close_run()")
    // Capture order follows trigger order: the rollup's update lands before the line's own capture trigger fires.
    expect(changes.map((c: any) => `${c.op} ${c.table}`).sort()).toEqual(["INSERT order_lines", "UPDATE orders"])
    await expect(db.exec("commit")).rejects.toThrow("A ghost replay can never commit.")
    expect(await one(db, "select count(*)::int from order_lines")).toBe(0)
  })

  it("lets a run's own SET CONSTRAINTS ALL IMMEDIATE through", async () => {
    const db = await shop()
    await db.exec(`create function settle() returns void language plpgsql as $$ begin set constraints all immediate; end $$;`)
    const answer = await run(db, [], { kind: "rpc", name: "settle", args: {} })
    expect(answer.error).toBeUndefined()
  })

  it("runs branch migrations inside the run and nowhere else", async () => {
    const db = await shop()
    const migrations = [{ file: "20990101000000_notes.sql", sql: "alter table orders add column notes text;" }]
    const written = await run(db, [], { kind: "table", table: "orders", method: "update", migrations,
      filters: [{ col: "id", op: "eq", value: 1 }], body: { notes: "rush" } })
    expect(written.error).toBeUndefined()
    const seen = await read(db, written.changes, { kind: "table", table: "orders", select: ["id", "notes"], migrations })
    expect(seen.result).toEqual([{ id: 1, notes: "rush" }])
    expect(await one(db, "select count(*)::int from information_schema.columns where table_name = 'orders' and column_name = 'notes'")).toBe(0)
  })

  it("refuses a branch migration whose effect would outlive the rollback", async () => {
    const db = await shop()
    const answer = await read(db, [], { kind: "migrations", migrations: [{ file: "x.sql", sql: "select pg_advisory_lock(1);" }] })
    expect(answer.error.message).toContain("would outlive the ghost run")
  })

  it("calls rewrite hooks with the definition before and after", async () => {
    const db = await shop()
    await db.exec(`
      create table hook_log (fn text, had_guard_before boolean, has_guard_after boolean);
      create function note_rewrite(p_fn regprocedure, p_old text, p_new text) returns void language sql as $$
        insert into hook_log values (p_fn::text, position('ghost.replay' in p_old) > 0, position('ghost.replay' in p_new) > 0);
      $$;
      insert into ghost.rewrite_hooks values ('note_rewrite(regprocedure, text, text)');
      create function stamp() returns trigger language plpgsql as $$ begin return new; end $$;
    `)
    await db.query("select ghost.install()")
    expect((await db.query("select * from hook_log")).rows).toEqual([{ fn: "stamp()", had_guard_before: false, has_guard_after: true }])
  })

  it("keeps a session log", async () => {
    const db = await shop()
    await db.query("select public.ghost_log_add('s1', 'write', '{\"target\":\"orders\"}')")
    await db.query("select public.ghost_log_add('s1', 'held', '{\"host\":\"api.slack.com\"}')")
    await db.query("select public.ghost_log_add('s2', 'write', '{}')")
    const log = await one(db, "select public.ghost_log_entries('s1')")
    expect(log.entries.map((e: any) => e.kind)).toEqual(["write", "held"])
    await db.query("select public.ghost_log_reset('s1')")
    expect((await one(db, "select public.ghost_log_entries('s1')")).entries).toEqual([])
    await db.query("select public.ghost_log_end('s2')")
    expect((await one(db, "select public.ghost_log_entries('s2')")).startedAt).toBeNull()
  })
})

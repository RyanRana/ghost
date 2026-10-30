import { PGlite } from "@electric-sql/pglite"
import { describe, expect, it } from "vitest"
import { connect } from "../src/db/connect.js"
import { SHOP_SQL } from "./fixture.js"

async function setup() {
  const db = new PGlite()
  await db.exec(SHOP_SQL)
  await db.exec(`
    create table tags (name text primary key, n int not null default 0);
    create table people (id bigserial primary key, email text not null unique);
    create function first_line() returns trigger language plpgsql as $$
    begin
      insert into order_lines (order_id, qty, price) values (new.id, 1, 0);
      return null;
    end $$;
    create trigger orders_first_line after insert on orders for each row execute function first_line();
  `)
  const ghost = await connect(db)
  const report = await ghost.install()
  const one = async (sql: string) => Object.values((await db.query<Record<string, unknown>>(sql)).rows[0] ?? {})[0]
  return { db, ghost, report, one }
}

describe("postgres through connect()", () => {
  it("installs from the dialect and reports what it covered", async () => {
    const { ghost, report } = await setup()
    expect(report).toMatchObject({ capture: { added: 5 } })
    const doctor = await ghost.doctor()
    expect(doctor.checks.map((c) => `${c.ok ? "ok" : "FIX"} ${c.name}`)).toEqual(["ok database", "ok install is current", "ok rolled-back run"])
  })

  it("captures a parent before the child its trigger inserts, and replays both", async () => {
    const { ghost, one } = await setup()
    const s = ghost.session("alice")
    const { rows, changes } = await s.query("insert into orders (customer_id) values (1) returning id")
    expect(Number(rows[0]!.id)).toBeGreaterThanOrEqual(9_000_001)
    // The order, then the line its trigger added, then the total that line's trigger rolled up.
    expect(changes.map((c) => `${c.op} ${c.table}`)).toEqual(["INSERT orders", "INSERT order_lines", "UPDATE orders"])
    expect((await s.read("select count(*)::int as n from order_lines")).rows).toEqual([{ n: 1 }])
    expect(await one("select count(*)::int from orders")).toBe(1)
  })

  it("puts a long session back in batches, and exactly when the batches don't fit", async () => {
    const { ghost } = await setup()
    const s = ghost.session("alice")
    await s.transaction(async (q) => {
      for (let i = 0; i < 150; i++) await q("select add_line(1, 1, 2)")
    })
    expect((await s.read("select total, (select count(*)::int from order_lines) as lines from orders where id = 1")).rows)
      .toEqual([{ total: "300", lines: 150 }])
    // A unique value handed from one row to another through a third: only the exact order replays it.
    await s.query("insert into people (email) values ('a@x'), ('b@x')")
    await s.query("update people set email = 'tmp' where email = 'a@x'")
    await s.query("update people set email = 'a@x' where email = 'b@x'")
    await s.query("update people set email = 'b@x' where email = 'tmp'")
    expect((await s.read("select email from people order by id")).rows).toEqual([{ email: "b@x" }, { email: "a@x" }])
  })

  it("follows a key that changed", async () => {
    const { ghost } = await setup()
    const s = ghost.session("alice")
    await s.query("insert into tags (name, n) values ('rush', 1)")
    const { changes } = await s.query("update tags set name = 'urgent' where name = 'rush'")
    expect(changes[0]).toMatchObject({ op: "UPDATE", pk: { name: "rush" }, new: { name: "urgent" } })
    expect((await s.read("select name from tags")).rows).toEqual([{ name: "urgent" }])
  })

  it("says so when a real row takes a key the session used", async () => {
    const { db, ghost } = await setup()
    const s = ghost.session("alice")
    await s.query("insert into tags (name) values ('rush')")
    await db.query("insert into tags (name) values ('rush')")
    await expect(s.read("select * from tags")).rejects.toMatchObject({ code: "collision", message: expect.stringContaining("Nothing was saved.") })
  })

  it("checks deferred constraints the way a commit would", async () => {
    const { db, ghost } = await setup()
    await db.exec(`create table parents (id int primary key);
      create table kids (id int primary key, parent int references parents deferrable initially deferred);`)
    await ghost.install()
    await expect(ghost.session("alice").query("insert into kids values (1, 99)")).rejects.toThrow(/foreign key/)
  })

  it("refuses what would end the transaction, before it reaches the database", async () => {
    const { ghost, one } = await setup()
    const s = ghost.session("alice")
    await expect(s.transaction(async (q) => {
      await q("insert into order_lines (order_id, qty, price) values (1, 1, 1)")
      await q("rollback")
      await q("insert into order_lines (order_id, qty, price) values (1, 1, 1)")
    })).rejects.toMatchObject({ code: "refused" })
    await expect(s.query("select 1; commit")).rejects.toMatchObject({ code: "refused" })
    await expect(s.query("select pg_advisory_lock(1)")).rejects.toMatchObject({ code: "refused" })
    expect(await one("select count(*)::int from order_lines")).toBe(0)
  })

  it("runs ghost DDL and keeps none of it", async () => {
    const { ghost, one } = await setup()
    await ghost.session("alice").query("alter table orders add column notes text")
    expect(await one("select count(*)::int from information_schema.columns where table_name = 'orders' and column_name = 'notes'")).toBe(0)
  })

  it("tells you when ghost isn't installed", async () => {
    const db = new PGlite()
    const ghost = await connect(db)
    await expect(ghost.session("x").read("select 1")).rejects.toMatchObject({ code: "install" })
    expect((await ghost.doctor()).ok).toBe(false)
  })
})

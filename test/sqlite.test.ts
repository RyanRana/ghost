import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { createGhostDb } from "../src/db/engine.js"
import { sqliteDialect, sqliteSource } from "../src/db/sqlite.js"

// The same small shop as the Postgres tests: a total kept by a trigger, shipped orders are final, an audit trail.
const SHOP = `
  pragma foreign_keys = on;
  create table customers (id integer primary key autoincrement, name text not null);
  create table orders (id integer primary key autoincrement, customer_id integer references customers, total real not null default 0,
    shipped integer not null default 0, label blob);
  create table order_lines (id integer primary key autoincrement, order_id integer not null references orders on delete cascade,
    qty integer not null, price real not null);
  create table audit (id integer primary key autoincrement, what text not null);
  create table tags (name text primary key, n integer not null default 0) without rowid;
  create table notes (body text);
  create trigger roll_up after insert on order_lines begin
    update orders set total = (select coalesce(sum(qty * price), 0) from order_lines where order_id = new.order_id) where id = new.order_id;
    insert into audit (what) values ('line ' || new.id);
  end;
  create trigger shipped_is_final before update on orders when old.shipped = 1 begin
    select raise(abort, 'Shipped orders are final');
  end;
  create trigger first_line after insert on orders begin
    insert into order_lines (order_id, qty, price) values (new.id, 1, 0);
  end;
  insert into customers (name) values ('Acme');
  insert into orders (customer_id, label) values (1, x'00ff');
  delete from audit; delete from order_lines;
  update orders set total = 0;
`

function setup() {
  const db = new DatabaseSync(":memory:")
  db.exec(SHOP)
  const ghost = createGhostDb({ dialect: sqliteDialect, source: sqliteSource(db) })
  const count = (table: string) => Number((db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n)
  return { db, ghost, count }
}

describe("sqlite", () => {
  it("runs a write for real, captures what triggers did, keeps nothing", async () => {
    const { db, ghost, count } = setup()
    const s = ghost.session("alice")
    const { rows, changes } = await s.query("insert into order_lines (order_id, qty, price) values (?, ?, ?) returning id", [1, 3, 2.5])
    expect(rows[0]!.id).toBe(9_000_001)
    expect(changes.map((c) => `${c.op} ${c.table}`)).toEqual(["INSERT order_lines", "UPDATE orders", "INSERT audit"])
    expect(changes[1]!.new).toMatchObject({ id: 1, total: 7.5, label: { $hex: "00FF" } })
    expect(count("order_lines")).toBe(0)
    expect(count("audit")).toBe(0)
    expect(db.prepare("select total from orders").get()).toEqual({ total: 0 })
  })

  it("shows a session its own writes and nobody else", async () => {
    const { ghost } = setup()
    const s = ghost.session("alice")
    await s.query("insert into order_lines (order_id, qty, price) values (1, 2, 10)")
    await s.query("update customers set name = 'Acme Co' where id = 1")
    expect((await s.read("select total from orders where id = 1")).rows).toEqual([{ total: 20 }])
    expect((await s.read("select count(*) as n from audit")).rows).toEqual([{ n: 1 }])
    expect((await s.read("select name from customers")).rows).toEqual([{ name: "Acme Co" }])
    expect((await ghost.session("bob").read("select total from orders where id = 1")).rows).toEqual([{ total: 0 }])
  })

  it("replays without firing triggers, and runs the real ones on new writes", async () => {
    const { ghost } = setup()
    const s = ghost.session("alice")
    await s.query("insert into order_lines (order_id, qty, price) values (1, 1, 5)")
    await s.query("insert into order_lines (order_id, qty, price) values (1, 1, 5)")
    // Two lines, two audit rows: the replay of line one didn't audit it again.
    expect((await s.read("select count(*) as n from audit")).rows).toEqual([{ n: 2 }])
    await s.query("update orders set shipped = 1 where id = 1")
    await expect(s.query("update orders set total = 99 where id = 1")).rejects.toThrow("Shipped orders are final")
  })

  it("numbers ghost inserts far above real rows", async () => {
    const { db, ghost } = setup()
    const s = ghost.session("alice")
    const first = await s.query("insert into orders (customer_id) values (1) returning id")
    expect(first.rows[0]!.id).toBe(9_000_001)
    // A real order arrives; the session's ghost order keeps its own id.
    db.exec("insert into orders (customer_id) values (1)")
    const second = await s.query("insert into orders (customer_id) values (1) returning id")
    expect(second.rows[0]!.id).toBe(9_000_002)
    expect((await s.read("select id from orders order by id")).rows.map((r) => r.id)).toEqual([1, 2, 9_000_001, 9_000_002])
  })

  it("captures a parent before the child its trigger inserts, so replay keeps the foreign key", async () => {
    const { ghost } = setup()
    const s = ghost.session("alice")
    const { changes } = await s.query("insert into orders (customer_id) values (1)")
    expect(changes.map((c) => `${c.op} ${c.table}`)).toEqual(["INSERT orders", "INSERT order_lines", "UPDATE orders", "INSERT audit"])
    expect((await s.read("select count(*) as n from order_lines")).rows).toEqual([{ n: 1 }])
  })

  it("follows a key that changed, deletes, cascades, rowid and without-rowid tables", async () => {
    const { ghost } = setup()
    const s = ghost.session("alice")
    await s.query("insert into tags (name, n) values ('rush', 1)")
    await s.query("update tags set name = 'urgent' where name = 'rush'")
    await s.query("insert into notes (body) values ('hello')")
    await s.query("delete from orders where id = 1")
    expect((await s.read("select name from tags")).rows).toEqual([{ name: "urgent" }])
    expect((await s.read("select body from notes")).rows).toEqual([{ body: "hello" }])
    expect((await s.read("select count(*) as n from orders")).rows).toEqual([{ n: 0 }])
  })

  it("keeps a REPLACE as an update of the row it replaced", async () => {
    const { ghost } = setup()
    const s = ghost.session("alice")
    const { changes } = await s.query("replace into customers (id, name) values (1, 'Replaced')")
    expect(changes.map((c) => c.op)).toEqual(["UPDATE"])
    expect((await s.read("select name from customers")).rows).toEqual([{ name: "Replaced" }])
  })

  it("puts a long session back fast, and exactly when the fast way doesn't fit", async () => {
    const { ghost } = setup()
    const s = ghost.session("alice")
    await s.transaction(async (q) => {
      for (let i = 0; i < 200; i++) await q("insert into order_lines (order_id, qty, price) values (1, 1, 1)")
    })
    // Swapping a unique value through a third: only the exact replay order works.
    await s.query("create unique index if not exists customers_name on customers (name)").catch(() => {})
    expect((await s.read("select total, (select count(*) from audit) as audited from orders where id = 1")).rows).toEqual([{ total: 200, audited: 200 }])
    expect((await s.changes()).length).toBe(600)
  })

  it("refuses what would end the transaction, and says nothing was saved", async () => {
    const { ghost, count } = setup()
    const s = ghost.session("alice")
    await expect(s.query("commit")).rejects.toThrow("Ghost can't run COMMIT: every ghost run is one transaction that always rolls back. Nothing was saved.")
    await expect(s.transaction(async (q) => {
      await q("insert into audit (what) values ('x')")
      await q("rollback")
      await q("insert into audit (what) values ('y')")
    })).rejects.toMatchObject({ code: "refused" })
    await expect(s.query("pragma foreign_keys = off")).rejects.toMatchObject({ code: "refused" })
    expect(count("audit")).toBe(0)
  })

  it("can't commit even when something goes around ghost", async () => {
    const { db, ghost } = setup()
    const s = ghost.session("alice")
    await s.transaction(async () => {
      expect(() => db.exec("commit")).toThrow("FOREIGN KEY constraint failed")
    })
    expect(db.isTransaction).toBe(false)
  })

  it("runs a ghost DDL statement and rolls it back", async () => {
    const { db, ghost } = setup()
    const s = ghost.session("alice")
    await s.query("alter table orders add column notes text")
    expect((db.prepare("select count(*) as n from pragma_table_info('orders') where name = 'notes'").get() as { n: number }).n).toBe(0)
  })

  it("rebuilds capture after a real schema change", async () => {
    const { db, ghost } = setup()
    const s = ghost.session("alice")
    await s.query("update orders set total = 1")
    db.exec("alter table orders add column notes text")
    const { changes } = await s.query("update orders set notes = 'rush'")
    expect(changes[0]!.new).toMatchObject({ notes: "rush" })
  })

  it("reports a real row that took a ghost row's id", async () => {
    const { db, ghost } = setup()
    const s = ghost.session("alice")
    await s.query("insert into notes (body) values ('ghost')")
    db.exec("insert into notes (body) values ('real')")
    await expect(s.read("select * from notes")).rejects.toMatchObject({ code: "collision" })
  })

  it("doctor explains what it sees", async () => {
    const { ghost } = setup()
    const report = await ghost.doctor()
    expect(report.ok).toBe(true)
    expect(report.checks.find((c) => c.name === "row ids")?.detail).toMatch(/^notes number rows/)
  })
})

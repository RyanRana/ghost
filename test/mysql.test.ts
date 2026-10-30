import mysql from "mysql2/promise"
import { describe, expect, it } from "vitest"
import { connect } from "../src/db/connect.js"

// Needs a real server: MYSQL_URL and/or MARIADB_URL, e.g. mysql://root:ghost@127.0.0.1:33061/shop. Skipped without.
const SERVERS = [["mysql", process.env.MYSQL_URL], ["mariadb", process.env.MARIADB_URL]].filter(([, url]) => url) as [string, string][]

const SHOP = [
  "drop procedure if exists add_line", "drop procedure if exists sneaky",
  "drop table if exists audit", "drop table if exists order_lines", "drop table if exists orders", "drop table if exists customers",
  "drop table if exists notes", "drop table if exists _ghost_changes", "drop table if exists _ghost_meta",
  "create table customers (id bigint auto_increment primary key, name varchar(100) not null unique)",
  `create table orders (id bigint auto_increment primary key, customer_id bigint references customers (id), total decimal(12, 2) not null default 0,
    shipped tinyint(1) not null default 0, label varbinary(16) null, meta json null, foreign key (customer_id) references customers (id))`,
  `create table order_lines (id bigint auto_increment primary key, order_id bigint not null, qty int not null, price decimal(12, 2) not null,
    foreign key (order_id) references orders (id) on delete cascade)`,
  "create table audit (id bigint auto_increment primary key, what varchar(200) not null)",
  "create table notes (body text)",
  `create trigger roll_up after insert on order_lines for each row begin
    update orders set total = (select coalesce(sum(qty * price), 0) from order_lines where order_id = new.order_id) where id = new.order_id;
    insert into audit (what) values (concat('line ', new.id));
  end`,
  `create trigger shipped_is_final before update on orders for each row begin
    if old.shipped = 1 then signal sqlstate '45000' set message_text = 'Shipped orders are final'; end if;
  end`,
  `create procedure add_line(p_order bigint, p_qty int, p_price decimal(12, 2)) begin
    insert into order_lines (order_id, qty, price) values (p_order, p_qty, p_price);
  end`,
  "create procedure sneaky() begin insert into audit (what) values ('x'); commit; end",
  "insert into customers (name) values ('Acme')",
  "insert into orders (customer_id, label, meta) values (1, x'00ff', json_object('rush', true))",
]

async function setup(url: string) {
  const admin = await mysql.createConnection({ uri: url, multipleStatements: false })
  for (const sql of SHOP) await admin.query(sql)
  const ghost = await connect(url)
  await ghost.install()
  const count = async (table: string) => Number(((await admin.query(`select count(*) as n from ${table}`))[0] as { n: number }[])[0]!.n)
  return { admin, ghost, count, done: async () => { await ghost.close(); await admin.end() } }
}

describe.skipIf(!SERVERS.length).each(SERVERS)("%s", (_name, url) => {
  it("installs capture and guards, and again changes nothing", async () => {
    const { ghost, done } = await setup(url)
    const again = await ghost.install()
    expect(again).toMatchObject({ captured: 0, guarded: 0, failed: [] })
    expect((await ghost.doctor()).ok).toBe(true)
    await done()
  })

  it("runs a write for real, captures what triggers did, keeps nothing", async () => {
    const { ghost, count, admin, done } = await setup(url)
    const s = ghost.session("alice")
    const { changes } = await s.query("insert into order_lines (order_id, qty, price) values (?, ?, ?)", [1, 3, "2.50"])
    // Captured before its own trigger ran: the line, then what the trigger did.
    expect(changes.map((c) => `${c.op} ${c.table}`)).toEqual(["INSERT order_lines", "UPDATE orders", "INSERT audit"])
    expect(changes[1]!.new).toMatchObject({ total: "7.50", label: { $b64: "AP8=" } })
    expect(await count("order_lines")).toBe(0)
    expect(await count("audit")).toBe(0)
    expect(((await admin.query("select total from orders"))[0] as Row[])[0]!.total).toBe("0.00")
    await done()
  })

  it("shows a session its own writes and nobody else, without firing triggers twice", async () => {
    const { ghost, done } = await setup(url)
    const s = ghost.session("alice")
    await s.query("insert into order_lines (order_id, qty, price) values (1, 2, 10)")
    await s.query("call add_line(1, 1, 5)")
    await s.query("update customers set name = 'Acme Co' where id = 1")
    expect((await s.read("select total, label, meta from orders where id = 1")).rows).toEqual([{ total: "25.00", label: Buffer.from([0, 255]), meta: expect.anything() }])
    expect((await s.read("select count(*) as n from audit")).rows).toEqual([{ n: 2 }])
    expect((await s.read("select name from customers")).rows).toEqual([{ name: "Acme Co" }])
    expect((await ghost.session("bob").read("select total from orders where id = 1")).rows).toEqual([{ total: "0.00" }])
    await s.query("update orders set shipped = 1 where id = 1")
    await expect(s.query("update orders set total = 1 where id = 1")).rejects.toThrow("Shipped orders are final")
    await done()
  })

  it("puts a long session back, cascades and a key that changed", async () => {
    const { ghost, done } = await setup(url)
    const s = ghost.session("alice")
    await s.transaction(async (q) => {
      for (let i = 0; i < 100; i++) await q("insert into order_lines (order_id, qty, price) values (1, 1, 1)")
    })
    expect((await s.read("select total, (select count(*) from audit) as audited from orders where id = 1")).rows).toEqual([{ total: "100.00", audited: 100 }])
    await s.query("insert into customers (name) values ('Bolt')")
    await s.query("update customers set id = 77 where name = 'Bolt'")
    expect((await s.read("select id from customers order by id")).rows).toEqual([{ id: 1 }, { id: 77 }])
    await s.query("delete from orders where id = 1")
    expect((await s.read("select count(*) as n from order_lines")).rows).toEqual([{ n: 0 }])
    await done()
  })

  it("refuses what MySQL would save on the spot", async () => {
    const { ghost, count, done } = await setup(url)
    const s = ghost.session("alice")
    await expect(s.query("create table x (id int)")).rejects.toThrow("MySQL saves it the moment it runs")
    await expect(s.query("commit")).rejects.toMatchObject({ code: "refused" })
    await expect(s.query("set autocommit = 1")).rejects.toMatchObject({ code: "refused" })
    await expect(s.query("call sneaky()")).rejects.toThrow("Ghost can't CALL sneaky: it runs COMMIT")
    await expect(s.transaction(async (q) => {
      await q("insert into audit (what) values ('a')")
      await q("rollback")
    })).rejects.toMatchObject({ code: "refused" })
    expect(await count("audit")).toBe(0)
    await done()
  })

  it("says so when something commits around ghost", async () => {
    const { count, done } = await setup(url)
    const raw = await mysql.createConnection({ uri: url })
    const ghost = await connect(raw)
    // A COMMIT on the connection itself, which ghost never sees: the check after the rollback catches it.
    await expect(ghost.session("alice").transaction(async (q) => {
      await q("insert into audit (what) values ('leaked')")
      await raw.query("commit")
    })).rejects.toMatchObject({ code: "unsafe", message: expect.stringContaining("committed for real") })
    expect(await count("audit")).toBe(1)
    await raw.end()
    await done()
  })

  it("tells ghost isn't installed in plain words", async () => {
    const admin = await mysql.createConnection({ uri: url })
    await admin.query("drop table if exists _ghost_changes")
    await admin.query("drop table if exists _ghost_meta")
    const ghost = await connect(url)
    await expect(ghost.session("x").read("select 1")).rejects.toThrow("Ghost isn't installed in this database yet")
    await ghost.close()
    await admin.end()
  })
})

type Row = Record<string, unknown>

import { describe, expect, it } from "vitest"
import { refusal } from "../src/db/guard.js"
import { exactPlan, fastPlan, latestRows } from "../src/db/plan.js"
import type { RowChange } from "../src/db/types.js"

const ins = (table: string, id: number, row = {}): RowChange => ({ table, op: "INSERT", pk: { id }, old: null, new: { id, ...row } })
const upd = (table: string, id: number, row = {}): RowChange => ({ table, op: "UPDATE", pk: { id }, old: { id }, new: { id, ...row } })
const del = (table: string, id: number): RowChange => ({ table, op: "DELETE", pk: { id }, old: { id }, new: null })

describe("replay plans", () => {
  it("puts each change back on its own, exactly", () => {
    expect(exactPlan([ins("a", 1), upd("a", 1), del("a", 1)]).map((b) => b.op)).toEqual(["insert", "upsert", "delete"])
  })

  it("puts a rollup back as every line in one batch and the order's last total", () => {
    const changes: RowChange[] = []
    for (let i = 1; i <= 3; i++) changes.push(ins("lines", i), upd("orders", 1, { total: i }), ins("audit", i))
    expect(fastPlan(changes)).toEqual([
      { table: "lines", op: "insert", idx: [0, 3, 6] },
      { table: "audit", op: "insert", idx: [2, 5, 8] },
      { table: "orders", op: "upsert", idx: [7] },
    ])
  })

  it("makes a new row once, as it ended up, where it was first made", () => {
    expect(fastPlan([ins("orders", 9), ins("lines", 1), upd("orders", 9, { total: 5 })])).toEqual([
      { table: "orders", op: "insert", idx: [2] },
      { table: "lines", op: "insert", idx: [1] },
    ])
  })

  it("drops a row the session made and then deleted", () => {
    expect(fastPlan([ins("a", 1), upd("a", 1), del("a", 1), upd("b", 2)])).toEqual([{ table: "b", op: "upsert", idx: [3] }])
  })

  it("keeps every change when a key moved", () => {
    const moved: RowChange = { table: "tags", op: "UPDATE", pk: { id: 1 }, old: { id: 1 }, new: { id: 2 } }
    expect(fastPlan([ins("tags", 1), moved, upd("tags", 2)]).map((b) => b.idx)).toEqual([[0], [1], [2]])
    const latest = latestRows([ins("tags", 1), moved]).get("tags")!
    expect([...latest.values()]).toEqual([null, { id: 2 }])
  })
})

describe("what ghost won't run", () => {
  it("ends the transaction", () => {
    for (const sql of ["commit", "COMMIT;", "end", "rollback", "begin", "start transaction", "select 1; commit", "/* x */ rollback"]) {
      expect(refusal("postgres", sql), sql).toMatch(/^Ghost can't run/)
    }
    expect(refusal("postgres", "rollback to savepoint a")).toBeNull()
    expect(refusal("postgres", "select 'commit'")).toBeNull()
    expect(refusal("postgres", "do $$ begin commit; end $$")).toBeNull()
  })

  it("on MySQL, anything MySQL saves on the spot", () => {
    for (const sql of ["create table x (id int)", "alter table x add y int", "drop table x", "truncate x", "lock tables x write",
      "set autocommit = 1", "set names utf8mb4", "select * into outfile '/tmp/x' from t", "release foo"]) {
      expect(refusal("mysql", sql), sql).not.toBeNull()
    }
    for (const sql of ["select 1", "insert into t values (1)", "update t set a = 'commit'", "call p()", "set @a = 1", "savepoint s",
      "rollback to savepoint s", "with x as (select 1) select * from x", "# a comment\nselect 1", "select 'it\\'s; commit'"]) {
      expect(refusal("mysql", sql), sql).toBeNull()
    }
  })

  it("on SQLite, transaction control and PRAGMA changes", () => {
    expect(refusal("sqlite", "pragma foreign_keys = off")).not.toBeNull()
    expect(refusal("sqlite", "pragma table_info(t)")).toBeNull()
    expect(refusal("sqlite", "vacuum")).not.toBeNull()
    expect(refusal("sqlite", "create table t (id integer primary key)")).toBeNull()
  })
})

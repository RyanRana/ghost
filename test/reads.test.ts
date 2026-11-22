import type { PGlite } from "@electric-sql/pglite"
import { createClient } from "@supabase/supabase-js"
import { describe, expect, it } from "vitest"
import { createGhost, DatabaseGhostLog, pgCall } from "../src/index.js"
import type { GhostRowChange } from "../src/patch.js"
import { patchRows, latestRows } from "../src/patch.js"
import { matches, parseQuery, sortRows } from "../src/query.js"
import { reaches } from "../src/reach.js"
import { ghostRead, type Relations } from "../src/run.js"
import { describeWrite } from "../src/write.js"
import { one, shop } from "./fixture.js"

const q = (path: string) => parseQuery(new URL(`https://db.test/rest/v1/${path}`))
const ins = (table: string, row: Record<string, unknown>): GhostRowChange => ({ table, op: "INSERT", pk: { id: row.id }, old: null, new: row })

describe("filters ghost evaluates itself", () => {
  it("evaluates cs on jsonb and on array literals", () => {
    const json = q(`events?payload=cs.${encodeURIComponent('{"unit":"BO"}')}`)
    expect(json.evaluable).toBe(true)
    expect(matches({ payload: { unit: "BO", n: 1 } }, json.conditions)).toBe(true)
    expect(matches({ payload: '{"unit":"BO"}' }, json.conditions)).toBe(true)
    expect(matches({ payload: { unit: "SR" } }, json.conditions)).toBe(false)
    const array = q("events?tags=cs.{a,b}")
    expect(matches({ tags: ["a", "b", "c"] }, array.conditions)).toBe(true)
    expect(matches({ tags: ["a"] }, array.conditions)).toBe(false)
  })

  it("reads json paths, and never hands them or cs to the database runner", async () => {
    const path = q("events?payload->>unit=eq.BO")
    expect(matches({ payload: { unit: "BO" } }, path.conditions)).toBe(true)
    const { dispatcherFilters } = await import("../src/query.js")
    expect(dispatcherFilters(path)).toBeNull()
    expect(dispatcherFilters(q("events?tags=cs.{a}"))).toBeNull()
  })

  it("leaves cd, ov and fts unevaluated", () => {
    expect(q("events?tags=cd.{a}").evaluable).toBe(false)
    expect(q("events?tags=ov.{a}").evaluable).toBe(false)
  })

  it("sorts as Postgres does: nulls last ascending, first descending", () => {
    const rows = [{ n: 2 }, { n: null }, { n: 1 }]
    expect(sortRows(rows, [{ col: "n", dir: "asc" }]).map((r) => r.n)).toEqual([1, 2, null])
    expect(sortRows(rows, [{ col: "n", dir: "desc" }]).map((r) => r.n)).toEqual([null, 2, 1])
  })

  it("parses an embed's hint, inner join and select", () => {
    expect(q("orders?select=id,who:customers!orders_customer_id_fkey!inner(name)").embeds)
      .toEqual([{ key: "who", table: "customers", hint: "orders_customer_id_fkey", inner: true, select: "name" }])
  })
})

describe("patching a live read", () => {
  it("puts a row the session added where the order says, not at the end", () => {
    const rows = patchRows([{ id: 1, n: 1 }, { id: 3, n: 3 }], q("t?order=n.asc"), latestRows([ins("t", { id: 2, n: 2 })]), () => ["id"])
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3])
  })

  it("re-sorts a row the session moved", () => {
    const moved: GhostRowChange = { table: "t", op: "UPDATE", pk: { id: 1 }, old: { id: 1, n: 1 }, new: { id: 1, n: 9 } }
    const rows = patchRows([{ id: 1, n: 1 }, { id: 3, n: 3 }], q("t?order=n.asc"), latestRows([moved]), () => ["id"])
    expect(rows.map((r) => r.id)).toEqual([3, 1])
  })

  const relations: Relations = {
    orders: { kind: "table", pk: ["id"], fks: [{ name: "orders_customer_id_fkey", table: "customers", columns: ["customer_id"], refColumns: ["id"] }] },
    customers: { kind: "table", pk: ["id"] },
    order_lines: { kind: "table", pk: ["id"], fks: [{ name: "order_lines_order_id_fkey", table: "orders", columns: ["order_id"], refColumns: ["id"] }] },
  }
  const live = (request: Request) => async (asked?: Request) => {
    const url = new URL((asked ?? request).url)
    if (url.pathname.endsWith("/customers")) return Response.json([{ id: 1, name: "Acme" }].filter((c) => url.searchParams.get("id")?.includes("1")))
    if (url.pathname.endsWith("/order_lines")) return Response.json([])
    if (url.pathname.endsWith("/orders")) return Response.json([])
    return new Response("no", { status: 500 })
  }
  const noDispatch = async () => { throw new Error("no replay expected") }

  it("joins a row the session added to the embeds it reads, to-one and to-many", async () => {
    const changes = [ins("orders", { id: 7, customer_id: 1, total: 0 }), ins("order_lines", { id: 70, order_id: 7, qty: 2, price: 1 })]
    const request = new Request("https://db.test/rest/v1/orders?select=id,customer:customers(name),order_lines(qty)&id=eq.7")
    // The to-many side is a plain read of a table the session changed, so it is replayed: answer as the replay would.
    const replayed: unknown[] = []
    const dispatch = async (_fn: string, _changes: GhostRowChange[], req: unknown) => {
      replayed.push(req)
      return { result: [{ qty: 2, order_id: 7 }] }
    }
    const answer = await ghostRead(request, changes, relations, dispatch, live(request))
    expect(await answer!.json()).toEqual([{ id: 7, customer: { name: "Acme" }, order_lines: [{ qty: 2 }] }])
    expect(replayed).toEqual([expect.objectContaining({ table: "order_lines", select: ["qty", "order_id"],
      filters: [{ col: "order_id", op: "in", value: ["7"] }] })])
  })

  it("leaves out an added row an inner join has nothing for", async () => {
    const changes = [ins("orders", { id: 8, customer_id: 99, total: 0 })]
    const request = new Request("https://db.test/rest/v1/orders?select=id,customers!inner(name)&id=eq.8")
    expect(await (await ghostRead(request, changes, relations, noDispatch, live(request)))!.json()).toEqual([])
  })

  it("answers a one-row read whose row is only in the session, even without its key selected", async () => {
    const changes = [ins("customers", { id: 5, name: "Zed" })]
    const asked: string[] = []
    const answer = await ghostRead(
      new Request("https://db.test/rest/v1/customers?select=name&or=(id.eq.5,id.eq.6)", { headers: { accept: "application/vnd.pgrst.object+json" } }),
      changes, relations, noDispatch, async (r) => { asked.push(new URL(r!.url).searchParams.get("select")!); return Response.json([]) })
    expect(answer!.status).toBe(200)
    expect(await answer!.json()).toEqual({ name: "Zed" })
    expect(asked).toEqual(["name,id"])
  })
})

describe("read reach", () => {
  it("follows calls and views to every table, and gives up on opaque functions", () => {
    const reach = reaches({ edges: { "f:a": ["f:b", "r:t1"], "f:b": ["r:v"], "r:v": ["r:t2"], "f:c": ["f:dyn"], "f:dyn": [] }, opaque: ["dyn"] })
    expect([...reach("function", "a")!].sort()).toEqual(["t1", "t2", "v"])
    expect(reach("function", "c")).toBeNull()
    expect(reach("function", "missing")).toBeNull()
  })

  it("is mapped by the database, with policies, other languages and EXECUTE handled safely", async () => {
    const db = await shop()
    await db.exec(`
      create function order_count() returns bigint language sql stable as $$ select count(*) from orders $$;
      create function dynamic_read(t text) returns bigint language plpgsql stable as $$ declare n bigint; begin execute format('select count(*) from %I', t) into n; return n; end $$;
      create function via_dynamic() returns bigint language sql stable as $$ select dynamic_read('orders') $$;
      create function customer_name(p bigint) returns text language sql stable begin atomic select name from customers where id = p; end;
      alter table order_lines enable row level security;
      create policy lines_of_open on order_lines using (exists (select 1 from customers));
    `)
    const map = reaches(await one(db, "select public.ghost_read_reach()"))
    expect([...map("function", "order_count")!]).toEqual(["orders"])
    expect([...map("view", "order_totals")!].sort()).toEqual(["customers", "order_lines", "order_totals", "orders"])
    expect(map("function", "via_dynamic")).toBeNull()
    expect(map("function", "customer_name")).toBeNull()
    expect(await one(db, "select public.ghost_read_functions()")).toEqual(expect.arrayContaining(["order_count", "dynamic_read"]))
    expect(await one(db, "select public.ghost_read_functions()")).not.toContain("add_line")
  })

  it("lists each table's foreign keys", async () => {
    const db = await shop()
    const relations = await one(db, "select public.ghost_relations()")
    expect(relations.orders.fks).toEqual([{ name: "orders_customer_id_fkey", table: "customers", columns: ["customer_id"], refColumns: ["id"] }])
  })
})

describe("a function that can't write", () => {
  async function setup() {
    const db = await shop()
    await db.exec("create function order_count() returns bigint language sql stable as $$ select count(*) from orders $$")
    const call = pgCall((text, values) => db.query(text, values))
    const sent: string[] = []
    const send: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      const name = /\/rpc\/(\w+)$/.exec(new URL(request.url).pathname)![1]!
      const body = await request.text()
      sent.push(name)
      if (name.startsWith("ghost_")) return Response.json(await call(name, body ? JSON.parse(body) : {}))
      return Response.json(await one(db, `select to_jsonb(public.${name}())`))
    }
    const ghost = createGhost({ url: "https://shop.supabase.test", serviceKey: "k", fetch: send })
    const session = ghost.session("s")
    const supabase = createClient("https://shop.supabase.test", "k", { global: { fetch: session.fetch }, auth: { persistSession: false } })
    return { sent, session, supabase }
  }

  it("is answered live when the session has nothing it could read", async () => {
    const { sent, supabase } = await setup()
    expect((await supabase.rpc("order_count")).data).toBe(1)
    expect(sent.filter((n) => n === "ghost_run" || n === "ghost_read")).toEqual([])
    expect(sent).toContain("order_count")
  })

  it("runs as a read that sees the session once the session changed what it reads", async () => {
    const { sent, supabase } = await setup()
    await supabase.from("orders").insert({ customer_id: 1 })
    expect((await supabase.rpc("order_count")).data).toBe(2)
    expect(sent.at(-1)).toBe("ghost_read")
  })
})

describe("the database log", () => {
  it("fetches only what's new, and reads it whole after a reset elsewhere", async () => {
    const db: PGlite = await shop()
    const call = pgCall((text, values) => db.query(text, values))
    const asked: unknown[] = []
    const counted = (async (fn: string, args: Record<string, unknown>) => { if (fn === "ghost_log_entries") asked.push(args.p_after); return call(fn, args) }) as typeof call
    const log = new DatabaseGhostLog("s", counted)
    const other = new DatabaseGhostLog("s", call)
    const write = { kind: "table" as const, method: "POST", target: "orders", path: "/rest/v1/orders", headers: {}, body: "{}", changes: [] }
    await log.addWrite(write)
    expect(await log.writes()).toHaveLength(1)
    await log.addWrite(write)
    expect(await log.writes()).toHaveLength(2)
    expect(asked.at(-1)).toBeGreaterThan(0)
    await other.reset()
    await other.addWrite(write)
    expect(await log.writes()).toHaveLength(1)
    await other.end()
    expect(await log.writes()).toEqual([])
  })

  it("never misses a write made while a check was under way", async () => {
    const db: PGlite = await shop()
    const log = new DatabaseGhostLog("s", pgCall((text, values) => db.query(text, values)))
    const write = { kind: "table" as const, method: "POST", target: "orders", path: "/rest/v1/orders", headers: {}, body: "{}", changes: [] }
    await log.addWrite(write)
    const early = log.writes()
    await log.addWrite(write)
    const late = log.writes()
    expect((await early).length).toBeGreaterThanOrEqual(1)
    expect(await late).toHaveLength(2)
  })
})

describe("the guard and the log", () => {
  it("never keeps a key from a query string", () => {
    const write = describeWrite(new Request("https://db.test/realtime/v1/api/broadcast?apikey=secret", { method: "POST" }), "{}")
    expect(write!.path).not.toContain("secret")
  })

  it("stays on when something puts back the fetch it saved", async () => {
    const saved = globalThis.fetch
    const ghost = createGhost({ url: "https://shop.supabase.test", serviceKey: "k", fetch: async () => new Response("real") })
    ghost.installGuard()
    globalThis.fetch = saved
    const session = ghost.session("g")
    const answer = await session.run(() => fetch("https://hooks.slack.test/x", { method: "POST", body: "{}" }))
    expect(await answer.json()).toEqual({})
    expect(await session.log.held()).toHaveLength(1)
  })
})

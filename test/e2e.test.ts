import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PGlite } from "@electric-sql/pglite"
import { createClient } from "@supabase/supabase-js"
import { describe, expect, it } from "vitest"
import { createGhost, ghostPg, MemoryGhostLog, pgCall } from "../src/index.js"
import { parseQuery } from "../src/query.js"
import { one, shop } from "./fixture.js"

const URL_BASE = "https://shop.supabase.test"
const KEY = "service-key"

/** Just enough of Supabase for these tests: RPCs and plain table reads, run on PGlite. Anything else fails loudly. */
function fakeSupabase(db: PGlite) {
  const call = pgCall((text, values) => db.query(text, values))
  const outside: string[] = []
  const send: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.origin !== URL_BASE) {
      outside.push(`${request.method} ${url.host}${url.pathname}`)
      return new Response("sent for real", { status: 200 })
    }
    const rpc = /^\/rest\/v1\/rpc\/(\w+)$/.exec(url.pathname)
    if (rpc && request.method === "POST") {
      const body = await request.text()
      try {
        if (rpc[1]!.startsWith("ghost_")) return Response.json(await call(rpc[1]!, body ? JSON.parse(body) : {}))
        const { rows } = await db.query(`select to_jsonb(public.${rpc[1]}(${Object.keys(JSON.parse(body)).map((k, i) => `${k} => $${i + 1}`).join(", ")})) as out`,
          Object.values(JSON.parse(body)))
        return Response.json((rows[0] as { out: unknown }).out)
      } catch (e) {
        return Response.json({ code: (e as any).code, message: (e as Error).message }, { status: 400 })
      }
    }
    if (request.method === "GET" && url.pathname.startsWith("/rest/v1/")) {
      const q = parseQuery(url)
      const where = q.conditions.map((c: any, i) => `${c.col}::text = $${i + 1}`).join(" and ") || "true"
      const { rows } = await db.query(`select ${q.columns?.join(", ") ?? "*"} from public.${q.table} where ${where} order by 1`,
        q.conditions.map((c: any) => String(c.value)))
      return Response.json(rows)
    }
    if (request.method !== "GET") return Response.json({ code: "PGRST000", message: "a real write reached the fake database" }, { status: 500 })
    return new Response("not faked", { status: 501 })
  }
  return { send, outside }
}

async function setup(options: { migrations?: string } = {}) {
  const db = await shop()
  const fake = fakeSupabase(db)
  const ghost = createGhost({
    url: URL_BASE, serviceKey: KEY, fetch: fake.send,
    functions: { "send-receipt": async (request) => Response.json({ ran: "in-process", got: await request.json() }) },
    ...(options.migrations ? { migrations: { dir: options.migrations } } : {}),
  })
  const session = ghost.session("alice")
  const supabase = createClient(URL_BASE, KEY, { global: { fetch: session.fetch }, auth: { persistSession: false } })
  return { db, fake, ghost, session, supabase }
}

describe("createGhost with supabase-js", () => {
  it("runs writes for real, keeps nothing, and shows them to later reads", async () => {
    const { db, session, supabase } = await setup()
    const inserted = await supabase.from("orders").insert({ customer_id: 1 }).select().single()
    expect(inserted.error).toBeNull()
    expect(Number(inserted.data!.order_no)).toBeGreaterThanOrEqual(9000001)

    const line = await supabase.rpc("add_line", { p_order: 1, p_qty: 3, p_price: 2.5 })
    expect(line.error).toBeNull()

    const order = await supabase.from("orders").select("id,total").eq("id", 1)
    expect(order.data).toEqual([{ id: 1, total: 7.5 }])
    const view = await supabase.from("order_totals").select("*").eq("id", 1)
    expect(view.data?.[0]).toMatchObject({ total: 7.5, lines: 1 })

    expect(await one(db, "select count(*)::int from orders")).toBe(1)
    expect(await one(db, "select count(*)::int from order_lines")).toBe(0)
    expect((await session.summary()).writeCount).toBe(2)

    await session.reset()
    expect((await supabase.from("orders").select("id,total").eq("id", 1)).data).toEqual([{ id: 1, total: "0" }])
  })

  it("answers with the database's own refusal", async () => {
    const { supabase } = await setup()
    await supabase.from("orders").update({ shipped: true }).eq("id", 1)
    const refused = await supabase.rpc("add_line", { p_order: 1, p_qty: 1, p_price: 1 })
    expect(refused.error?.message).toBe("Shipped orders are final")
  })

  it("keeps sessions apart", async () => {
    const { ghost, supabase } = await setup()
    await supabase.rpc("add_line", { p_order: 1, p_qty: 2, p_price: 2 })
    const bob = createClient(URL_BASE, KEY, { global: { fetch: ghost.session("bob").fetch }, auth: { persistSession: false } })
    expect((await bob.from("orders").select("id,total").eq("id", 1)).data).toEqual([{ id: 1, total: "0" }])
  })

  it("holds outside sends and runs registered edge functions in-process", async () => {
    const { fake, ghost, session, supabase } = await setup()
    ghost.installGuard()
    const sent = await session.run(() => fetch("https://hooks.slack.test/T1", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "order shipped" }) }))
    expect(sent.status).toBe(200)
    expect(fake.outside).toEqual([])
    expect((await session.log.held())[0]).toMatchObject({ host: "hooks.slack.test", summary: expect.stringContaining("text") })

    const fn = await supabase.functions.invoke("send-receipt", { body: { order: 1 } })
    expect(fn.data).toEqual({ ran: "in-process", got: { order: 1 } })
    const other = await supabase.functions.invoke("charge-card", { body: {} })
    expect(other.data).toMatchObject({ ghost: "simulated" })
    expect((await session.log.held()).some((h) => h.summary.includes("charge-card"))).toBe(true)

    // Outside a session the guard does nothing.
    await fetch("https://hooks.slack.test/T1", { method: "POST", body: "{}" }).catch(() => {})
  })

  it("runs the branch's own migrations inside every run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runghost-migrations-"))
    writeFileSync(join(dir, "20990101000000_order_notes.sql"), "begin;\nalter table orders add column notes text;\ncommit;\n")
    const { db, ghost, supabase } = await setup({ migrations: dir })
    expect((await ghost.status()).label).toBe("Ghost · live database + 1 branch migration")
    const updated = await supabase.from("orders").update({ notes: "rush" }).eq("id", 1).select("id,notes")
    expect(updated.error).toBeNull()
    expect((await supabase.from("orders").select("id,notes").eq("id", 1)).data).toEqual([{ id: 1, notes: "rush" }])
    expect(await one(db, "select count(*)::int from information_schema.columns where table_name = 'orders' and column_name = 'notes'")).toBe(0)
  })
})

describe("ghostPg on a plain connection", () => {
  it("runs statements for real, remembers what they changed, keeps nothing", async () => {
    const db = await shop()
    const log = new MemoryGhostLog("cli")
    const pg = ghostPg({ query: (text, values) => db.query(text, values) }, log)
    const { changes } = await pg.query("insert into order_lines (order_id, qty, price) values ($1, $2, $3)", [1, 4, 5])
    expect(changes.map((c) => c.table).sort()).toEqual(["order_lines", "orders"])
    expect((await pg.read("select total from orders where id = 1")).rows).toEqual([{ total: "20" }])
    expect(await one(db, "select total::text from orders where id = 1")).toBe("0")
    await expect(pg.query("insert into order_lines (order_id, qty, price) values (999, 1, 1)")).rejects.toThrow()
    expect(await one(db, "select count(*)::int from order_lines")).toBe(0)
  })
})

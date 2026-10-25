/** Calls one of ghost's database functions by name with named arguments and returns its JSON. Throws on failure. */
export type GhostCall = (fn: string, args: Record<string, unknown>) => Promise<unknown>

export class GhostCallError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

/** Through PostgREST (Supabase): POST /rest/v1/rpc/<fn> with the service key. `send` must not route back into ghost. */
export function restCall(url: string, key: string, send: typeof fetch = fetch): GhostCall {
  const base = url.replace(/\/+$/, "")
  return async (fn, args) => {
    const res = await send(`${base}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(args),
    })
    const text = await res.text()
    const body = text ? JSON.parse(text) : null
    if (!res.ok) throw new GhostCallError(body?.code ?? String(res.status), body?.message ?? `${fn} answered ${res.status}`)
    return body
  }
}

export type Query = (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>

/** On a Postgres connection (node-postgres, PGlite, or anything with query(text, values) → { rows }). */
export function pgCall(query: Query): GhostCall {
  return async (fn, args) => {
    const names = Object.keys(args)
    const values = names.map((k) => {
      const v = args[k]
      return v !== null && typeof v === "object" ? JSON.stringify(v) : v
    })
    const list = names.map((k, i) => {
      const v = args[k]
      return `${k} => $${i + 1}${v !== null && typeof v === "object" ? "::text::jsonb" : ""}`
    }).join(", ")
    try {
      const { rows } = await query(`select public.${fn}(${list}) as out`, values)
      return rows[0]?.out ?? null
    } catch (error) {
      const e = error as { code?: string; message?: string }
      throw new GhostCallError(e.code ?? "XX000", e.message ?? String(error))
    }
  }
}

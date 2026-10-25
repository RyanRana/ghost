import { existsSync } from "node:fs"
import type { SupabaseClient } from "@supabase/supabase-js"
import { createGhost, sqliteLog, type Ghost, type GhostSession } from "./engine.js"

let shared: Ghost | null = null

/** One line to a ghosted Supabase client, from the keys `runghost init` saved:
 *    const { db } = await ghostClient("agent-fix-totals")
 *  Sessions live in .ghost/ghost.sqlite; supabase/migrations runs as branch migrations when it exists. */
export async function ghostClient(session = "default"): Promise<{ db: SupabaseClient; session: GhostSession; ghost: Ghost }> {
  for (const file of [".env.local", ".env"]) {
    if (existsSync(file)) {
      try { process.loadEnvFile(file) } catch {}
    }
  }
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("runghost: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY aren't set. Run npx runghost init.")
  shared ??= createGhost({
    url, serviceKey: key, log: sqliteLog(".ghost/ghost.sqlite"),
    ...(existsSync("supabase/migrations") ? { migrations: { dir: "supabase/migrations" } } : {}),
  })
  shared.installGuard()
  const s = shared.session(session)
  const { createClient } = await import("@supabase/supabase-js")
  const db = createClient(url, key, { global: { fetch: s.fetch }, auth: { persistSession: false, autoRefreshToken: false } })
  return { db, session: s, ghost: shared }
}

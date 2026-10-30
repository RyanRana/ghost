import type { Row, RowChange } from "./types.js"

// A session's earlier rows go back into every run before it starts. Two ways to put them back:
//   exact: every change, one at a time, in the order it happened. Always right, slow for a long session.
//   fast:  each row once (its first insert and its latest image, or its delete), and every row of one table and one
//          kind in one statement, tables in the order the session first touched them. Much faster; a unique or foreign
//          key that cared about the order can refuse it, and then the run puts the session back the exact way instead.

/** insert: the row is new and its key must be free. upsert: update by key, insert if missing. delete: by key. */
export type ReplayOp = "insert" | "upsert" | "delete"

/** One statement's worth of replay: rows of one table, by their index in the session's changes. */
export interface ReplayBatch { table: string; op: ReplayOp; idx: number[] }

const canonical = (v: Row) => JSON.stringify(Object.keys(v).sort().map((k) => [k, v[k]]))
const rowKey = (c: RowChange) => `${c.table}\u0000${canonical(c.pk)}`

/** An update that changed the row's own key: `pk` is the key it had, `new` holds the key it has now. */
export function keyChanged(c: RowChange): boolean {
  if (c.op !== "UPDATE" || !c.new) return false
  return Object.keys(c.pk).some((k) => JSON.stringify(c.new![k] ?? null) !== JSON.stringify(c.pk[k] ?? null))
}

const exactOp = (c: RowChange): ReplayOp => (c.op === "INSERT" ? "insert" : c.op === "UPDATE" ? "upsert" : "delete")

/** Every change on its own, in order. */
export function exactPlan(changes: readonly RowChange[]): ReplayBatch[] {
  return changes.map((c, i) => ({ table: c.table, op: exactOp(c), idx: [i] }))
}

/** Each row once, every row of one table and one kind in one batch (a row whose key changed stays on its own). */
export function fastPlan(changes: readonly RowChange[]): ReplayBatch[] {
  // `at` is where the row goes back, `i` the change whose image it goes back with.
  const kept: { at: number; i: number; op: ReplayOp }[] = []
  if (changes.some(keyChanged)) {
    // A key that moved makes "the same row" hard to follow: keep every change, only group them.
    changes.forEach((c, i) => kept.push({ at: i, i, op: exactOp(c) }))
  } else {
    const byRow = new Map<string, number[]>()
    changes.forEach((c, i) => {
      const k = rowKey(c)
      const list = byRow.get(k)
      if (list) list.push(i)
      else byRow.set(k, [i])
    })
    for (const ids of byRow.values()) {
      const first = ids[0]!, last = ids[ids.length - 1]!
      const existedBefore = changes[first]!.op !== "INSERT"
      const existsAfter = changes[last]!.op !== "DELETE"
      if (!existedBefore && !existsAfter) continue
      // A row the session made goes in once, as it ended up, where it was first made (rows that point at it come after).
      if (!existedBefore) kept.push({ at: first, i: last, op: "insert" })
      // A real row the session changed takes its last image, or goes, where it last changed.
      else kept.push({ at: last, i: last, op: existsAfter ? "upsert" : "delete" })
    }
    kept.sort((a, b) => a.at - b.at)
  }
  const out: ReplayBatch[] = []
  const open = new Map<string, ReplayBatch>()
  for (const { i, op } of kept) {
    const c = changes[i]!
    if (keyChanged(c)) {
      // Everything before it stays before it.
      open.clear()
      out.push({ table: c.table, op, idx: [i] })
      continue
    }
    const k = `${c.table}\u0000${op}`
    const batch = open.get(k)
    if (batch) batch.idx.push(i)
    else {
      const fresh = { table: c.table, op, idx: [i] }
      open.set(k, fresh)
      out.push(fresh)
    }
  }
  return out
}

/** The latest image of every row a session touched, per table and key; null for a row it deleted. */
export function latestRows(changes: readonly RowChange[]): Map<string, Map<string, Row | null>> {
  const out = new Map<string, Map<string, Row | null>>()
  for (const c of changes) {
    const rows = out.get(c.table) ?? new Map<string, Row | null>()
    if (c.op === "DELETE") rows.set(canonical(c.pk), null)
    else if (keyChanged(c)) {
      rows.set(canonical(c.pk), null)
      rows.set(canonical(Object.fromEntries(Object.keys(c.pk).map((k) => [k, c.new![k]]))), c.new)
    } else rows.set(canonical(c.pk), c.new)
    out.set(c.table, rows)
  }
  return out
}

/** The key a row is filed under in latestRows. */
export const pkKey = canonical

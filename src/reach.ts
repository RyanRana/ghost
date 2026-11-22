/** What each SQL function and view names, from ghost_read_reach: `f:<function>` and `r:<relation>` nodes. */
export interface ReadReach { edges: Record<string, string[]>; opaque: string[] }

/** The relations a function or a view can read, through everything it calls; null when that can't be told (not in the
 *  map, or it reaches a function that builds its SQL at run time). */
export type Reaches = (kind: "function" | "view", name: string) => ReadonlySet<string> | null

export function reaches(reach: ReadReach): Reaches {
  const opaque = new Set(reach.opaque)
  const known = new Map<string, ReadonlySet<string> | null>()
  const walk = (root: string): ReadonlySet<string> | null => {
    if (!Object.hasOwn(reach.edges, root)) return null
    const relations = new Set<string>()
    const seen = new Set([root])
    const todo = [root]
    while (todo.length) {
      const node = todo.pop()!
      const name = node.slice(2)
      if (node.startsWith("f:") && opaque.has(name)) return null
      if (node.startsWith("r:")) relations.add(name)
      for (const next of Object.hasOwn(reach.edges, node) ? reach.edges[node]! : []) {
        if (!seen.has(next)) { seen.add(next); todo.push(next) }
      }
    }
    return relations
  }
  return (kind, name) => {
    const root = `${kind === "function" ? "f" : "r"}:${name}`
    if (!known.has(root)) known.set(root, walk(root))
    return known.get(root)!
  }
}

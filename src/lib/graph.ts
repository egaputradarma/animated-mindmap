// Graph analysis feeding both the layout and the reveal choreography.
//
// The mindmap is treated as undirected here. Edge direction matters for nothing this file
// computes — a mindmap drawn hub-outward and one drawn leaf-inward should animate the same
// way — so `hub` and `depth` come from connectivity, not from which end of an edge the
// author happened to click first.

import type { Mindmap, MindmapEdge, MindmapNode } from '../types/mindmap'

export interface GraphView {
  nodes: MindmapNode[]
  byKey: Map<string, MindmapNode>
  /** Undirected adjacency, insertion-ordered. */
  neighbours: Map<string, string[]>
  hub: string
  /** Hop count from `hub`. Unreachable nodes (separate components) get depth 0. */
  depth: Map<string, number>
  /** Spanning-tree parent from a BFS rooted at `hub`. `null` for the hub and any root of a
   *  disconnected component. */
  parent: Map<string, string | null>
  children: Map<string, string[]>
  /** Roots of every component, hub first. A mindmap need not be fully connected. */
  roots: string[]
  maxDepth: number
}

export function buildGraph(m: Mindmap): GraphView {
  const byKey = new Map(m.nodes.map(n => [n.node_key, n]))
  const neighbours = new Map<string, string[]>(m.nodes.map(n => [n.node_key, []]))

  for (const e of m.edges) {
    // Import already drops edges with unknown endpoints, but a mindmap can also be mutated
    // in the editor, so this stays defensive rather than trusting the invariant.
    if (!byKey.has(e.source_node_key) || !byKey.has(e.target_node_key)) continue
    neighbours.get(e.source_node_key)!.push(e.target_node_key)
    neighbours.get(e.target_node_key)!.push(e.source_node_key)
  }

  const hub = pickHub(m.nodes, neighbours)
  const { depth, parent, children, roots } = spanningTree(m.nodes, neighbours, hub)

  return {
    nodes: m.nodes,
    byKey,
    neighbours,
    hub,
    depth,
    parent,
    children,
    roots,
    maxDepth: Math.max(0, ...depth.values()),
  }
}

/**
 * An explicit `hero` flag always wins — the author overriding the heuristic is the whole
 * point of that field. Otherwise the most-connected node is the hub, which is what makes a
 * mindmap read as radial. Ties break on the earliest node so the choice is deterministic
 * (an unstable hub would make the layout jump between renders of the same mindmap).
 */
export function pickHub(nodes: MindmapNode[], neighbours: Map<string, string[]>): string {
  if (nodes.length === 0) throw new Error('Cannot analyse an empty mindmap.')

  const flagged = nodes.find(n => n.hero)
  if (flagged) return flagged.node_key

  let best = nodes[0]
  let bestDegree = -1
  for (const n of nodes) {
    const degree = neighbours.get(n.node_key)?.length ?? 0
    if (degree > bestDegree) {
      best = n
      bestDegree = degree
    }
  }
  return best.node_key
}

function spanningTree(nodes: MindmapNode[], neighbours: Map<string, string[]>, hub: string) {
  const depth = new Map<string, number>()
  const parent = new Map<string, string | null>()
  const children = new Map<string, string[]>(nodes.map(n => [n.node_key, []]))
  const roots: string[] = []

  // Hub first, then any node not yet reached. Visiting in node order after that keeps
  // disconnected components in authoring order rather than hash order.
  const starts = [hub, ...nodes.map(n => n.node_key)]

  for (const start of starts) {
    if (depth.has(start)) continue
    roots.push(start)
    depth.set(start, 0)
    parent.set(start, null)

    const queue = [start]
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i]
      for (const next of neighbours.get(current) ?? []) {
        if (depth.has(next)) continue
        depth.set(next, depth.get(current)! + 1)
        parent.set(next, current)
        children.get(current)!.push(next)
        queue.push(next)
      }
    }
  }

  return { depth, parent, children, roots }
}

/**
 * Leaves in each subtree, used to weight angular allocation so a bushy branch gets more of
 * the circle than a single-child one. Without this, a hub with one heavy and one light
 * branch splits the circle 50/50 and the heavy side collides with itself.
 */
export function leafCounts(g: GraphView): Map<string, number> {
  const counts = new Map<string, number>()

  const walk = (key: string): number => {
    const cached = counts.get(key)
    if (cached !== undefined) return cached
    const kids = g.children.get(key) ?? []
    // Set before recursing so a cycle in a malformed tree cannot spin forever.
    counts.set(key, 1)
    const total = kids.length === 0 ? 1 : kids.reduce((sum, k) => sum + walk(k), 0)
    counts.set(key, total)
    return total
  }

  for (const root of g.roots) walk(root)
  return counts
}

/**
 * Reveal order: hub, then outward by depth. Within a depth, ties break on the parent's
 * order then authoring order, so a branch reveals as a contiguous run instead of scattering
 * across the canvas. Returns a 0-based index per node key.
 */
export function revealOrder(g: GraphView): Map<string, number> {
  const order = new Map<string, number>()
  let next = 0

  const queue = [...g.roots]
  for (let i = 0; i < queue.length; i++) {
    const key = queue[i]
    if (order.has(key)) continue
    order.set(key, next++)
    queue.push(...(g.children.get(key) ?? []))
  }

  // Anything the walk missed (shouldn't happen — roots covers every component) still needs
  // an index, or the renderer would treat it as never revealed.
  for (const n of g.nodes) if (!order.has(n.node_key)) order.set(n.node_key, next++)
  return order
}

/**
 * An edge may only draw once both endpoints exist, so its reveal slot is the later of the
 * two. This is what stops a connector reaching into empty space mid-cascade.
 */
export function edgeRevealOrder(edge: MindmapEdge, nodeOrder: Map<string, number>): number {
  const a = nodeOrder.get(edge.source_node_key) ?? 0
  const b = nodeOrder.get(edge.target_node_key) ?? 0
  return Math.max(a, b)
}

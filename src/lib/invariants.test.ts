// Property tests for the guarantees this tool actually sells.
//
// These are not coverage-driven. Each block below corresponds to a claim made elsewhere in the
// code — "the loop is seamless", "the signature is always inside the frame", "every node makes
// it into the animation" — and exists so that claim is checked rather than asserted in a
// comment. All of it runs in plain node: the geometry, timeline and layout layers are pure by
// design, which is what makes them testable without a canvas.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { arcBetween, measure, pointAtFraction, tangentAtFraction } from './bezier'
import { buildGraph, edgeRevealOrder, revealOrder } from './graph'
import { exportAuthoringJson, importMindmap } from './importMindmap'
import { layoutMindmap, type LayoutOptions, type PlacedNode } from './layout'
import { edgeArrowOf, edgeWeightOf, migrateEdge } from '../types/mindmap'
import { opaqueBoundsFromAlpha, signatureRect, type SignatureCorner, type SignatureOptions } from './signature'
import { estimator, wrapText } from './text'
import { edgeState, frameState, nodeState, packetCyclesFor, seedFromString, type TimelineOptions } from './timeline'
import { MAX_ENCODE_SIDE, outputSize } from './export/frames'
import type { Mindmap } from '../types/mindmap'

// ── Fixtures ──

/** Lopsided on purpose: one bushy branch, one thin, a grandchild, a reserved node, and one edge
 *  exercising semi weight plus double arrowheads. */
function fixture(): Mindmap {
  return {
    id: 'm1',
    name: 'Test map',
    description: null,
    nodes: [
      { node_key: 'hub', label: 'Central platform', position_x: 0, position_y: 0, hero: true, icon: '⚙️', detail: 'The hub' },
      { node_key: 'a', label: 'Alpha', position_x: 100, position_y: -80, detail: 'First branch' },
      { node_key: 'b', label: 'Beta', position_x: 120, position_y: 90 },
      { node_key: 'c', label: 'Gamma', position_x: -110, position_y: 70 },
      { node_key: 'd', label: 'Delta', position_x: -130, position_y: -60, reserved: true, tag: 'planned' },
      { node_key: 'a1', label: 'Alpha child one', position_x: 240, position_y: -140 },
      { node_key: 'a2', label: 'Alpha child two', position_x: 250, position_y: -30 },
    ],
    edges: [
      { id: 'e1', source_node_key: 'hub', target_node_key: 'a' },
      { id: 'e2', source_node_key: 'hub', target_node_key: 'b' },
      { id: 'e3', source_node_key: 'hub', target_node_key: 'c' },
      { id: 'e4', source_node_key: 'hub', target_node_key: 'd', weight: 'semi', arrow: 'both' },
      { id: 'e5', source_node_key: 'a', target_node_key: 'a1' },
      { id: 'e6', source_node_key: 'a', target_node_key: 'a2' },
    ],
    updated_at: new Date().toISOString(),
  }
}

const layoutOptions = (over: Partial<LayoutOptions> = {}): LayoutOptions => ({
  width: 1200,
  height: 1200,
  mode: 'radial',
  spread: 1,
  nodeGap: 18,
  preventOverlap: true,
  uniformCardHeight: false,
  curvature: 0.14,
  padding: 66,
  titleSpace: 120,
  footerSpace: 110,
  ...over,
})

const PRESETS = [
  { width: 1200, height: 1200 },
  { width: 1080, height: 1350 },
  { width: 1920, height: 1080 },
]

// ── Loop seamlessness ──
//
// The claim: a GIF/MP4 cut from the last frame back to the first shows no visible jump. What has
// to hold is that everything drawn at t=0 matches what is drawn as t approaches 1 — not that the
// raw timeline values match, since `build` mode reaches the same empty frame by a different
// route (nothing revealed yet, versus everything faded out).

describe('loop seamlessness', () => {
  const timeline: TimelineOptions = { mode: 'build', lastOrder: 6, packetCycles: 3 }

  it('build mode starts and ends on a visually empty frame', () => {
    const frames = 300
    const last = 1 - 1 / frames

    // t=0: full global alpha but nothing revealed yet.
    expect(frameState(0, timeline).global).toBeCloseTo(1, 5)
    for (let order = 0; order <= timeline.lastOrder; order++) {
      expect(nodeState(0, order, timeline).appear).toBeCloseTo(0, 5)
    }

    // t→1: everything revealed but faded to nothing. Effective opacity is the product, and it is
    // that product which has to agree across the seam.
    const tailGlobal = frameState(last, timeline).global
    for (let order = 0; order <= timeline.lastOrder; order++) {
      const startOpacity = frameState(0, timeline).global * nodeState(0, order, timeline).appear
      const endOpacity = tailGlobal * nodeState(last, order, timeline).appear
      expect(Math.abs(endOpacity - startOpacity)).toBeLessThan(0.02)
    }
  })

  it('packet phase returns exactly to its start, because cycle counts are integers', () => {
    for (const id of ['e1', 'e2', 'e3', 'e4', 'e5', 'e6']) {
      const seed = seedFromString(id)
      // Sampled in `flow` mode so the packet is never gated off by the draw-on progress.
      const flow: TimelineOptions = { ...timeline, mode: 'flow' }
      const atZero = edgeState(0, 0, seed, flow).packet
      const atOne = edgeState(1, 0, seed, flow).packet
      expect(atZero).not.toBeNull()
      expect(atOne).toBeCloseTo(atZero as number, 9)
    }
  })

  it('assigns whole-number packet cycles regardless of seed', () => {
    for (let seed = -50; seed <= 50; seed++) {
      const cycles = packetCyclesFor(seed, 3)
      expect(Number.isInteger(cycles)).toBe(true)
      expect(cycles).toBeGreaterThanOrEqual(1)
    }
  })

  it('flow mode is continuous across the seam', () => {
    const flow: TimelineOptions = { mode: 'flow', lastOrder: 6, packetCycles: 2 }
    expect(frameState(0, flow).hubPulse).toBeCloseTo(frameState(1, flow).hubPulse, 9)
    expect(nodeState(0, 3, flow).appear).toBeCloseTo(nodeState(1, 3, flow).appear, 9)
  })

  it('accepts times outside [0,1) by wrapping them', () => {
    expect(frameState(2.25, { mode: 'flow', lastOrder: 3, packetCycles: 2 }).hubPulse).toBeCloseTo(
      frameState(0.25, { mode: 'flow', lastOrder: 3, packetCycles: 2 }).hubPulse,
      9,
    )
  })
})

// ── Reveal ordering ──
//
// The claim: no connector is ever drawn into empty space. An edge may only start drawing once
// both of its endpoint cards exist.

describe('reveal choreography', () => {
  it('never draws an edge before both endpoints have appeared', () => {
    const map = fixture()
    const graph = buildGraph(map)
    const order = revealOrder(graph)

    for (const edge of map.edges) {
      const slot = edgeRevealOrder(edge, order)
      expect(slot).toBeGreaterThanOrEqual(order.get(edge.source_node_key)!)
      expect(slot).toBeGreaterThanOrEqual(order.get(edge.target_node_key)!)
    }
  })

  it('reveals the hub first and orders cards outward by depth', () => {
    const graph = buildGraph(fixture())
    const order = revealOrder(graph)

    expect(order.get(graph.hub)).toBe(0)
    for (const [key, slot] of order) {
      for (const [otherKey, otherSlot] of order) {
        // A shallower node can never reveal after a deeper one.
        if (graph.depth.get(key)! < graph.depth.get(otherKey)!) expect(slot).toBeLessThan(otherSlot)
      }
    }
  })

  it('honours an explicit hero flag over raw degree', () => {
    const map = fixture()
    // 'hub' has degree 4; make 'a' the flagged hero even though it only has degree 3.
    map.nodes[0].hero = false
    map.nodes[1].hero = true
    expect(buildGraph(map).hub).toBe('a')
  })

  it('gives every node a depth even when the graph is disconnected', () => {
    const map = fixture()
    map.nodes.push({ node_key: 'orphan', label: 'Orphan', position_x: 400, position_y: 400 })
    const graph = buildGraph(map)
    expect(graph.depth.has('orphan')).toBe(true)
    expect(revealOrder(graph).size).toBe(map.nodes.length)
  })
})

// ── Layout completeness ──

describe('layout', () => {
  it('places every node exactly once', () => {
    const map = fixture()
    const layout = layoutMindmap(map, layoutOptions())

    expect(layout.nodes).toHaveLength(map.nodes.length)
    expect(new Set(layout.nodes.map(n => n.key)).size).toBe(map.nodes.length)
  })

  it('keeps every edge whose endpoints exist', () => {
    const map = fixture()
    const layout = layoutMindmap(map, layoutOptions())
    expect(layout.edges).toHaveLength(map.edges.length)
  })

  it('drops edges pointing at missing nodes instead of throwing', () => {
    const map = fixture()
    map.edges.push({ id: 'bad', source_node_key: 'hub', target_node_key: 'does-not-exist' })
    expect(layoutMindmap(map, layoutOptions()).edges).toHaveLength(6)
  })

  it('fits all cards inside the drawable box for every preset', () => {
    for (const preset of PRESETS) {
      const options = layoutOptions(preset)
      const layout = layoutMindmap(fixture(), options)

      for (const node of layout.nodes) {
        expect(node.x - node.w / 2).toBeGreaterThanOrEqual(options.padding - 1)
        expect(node.x + node.w / 2).toBeLessThanOrEqual(preset.width - options.padding + 1)
        expect(node.y - node.h / 2).toBeGreaterThanOrEqual(options.padding + options.titleSpace - 1)
        // The footer band is reserved so the signature never overlaps a card.
        expect(node.y + node.h / 2).toBeLessThanOrEqual(preset.height - options.padding - options.footerSpace + 1)
      }
    }
  })

  it('does not overlap sibling cards in the radial layout', () => {
    expectNoOverlaps(layoutMindmap(fixture(), layoutOptions()))
  })

  /**
   * The case that was broken.
   *
   * A hub with many children puts cards all the way round the ring, and the old radius formula sized it
   * from card WIDTH alone. On the left and right flanks the ring runs vertically, so neighbours stack and
   * their HEIGHT is what needs to clear — which was never accounted for, and those flanks overlapped.
   */
  it('keeps a wide fan of children clear at every ring position', () => {
    for (const count of [8, 12, 17, 24]) {
      const map: Mindmap = {
        id: `fan-${count}`,
        name: `Fan of ${count}`,
        description: null,
        nodes: [
          { node_key: 'hub', label: 'Hub', position_x: 0, position_y: 0, hero: true },
          ...Array.from({ length: count }, (_, i) => ({
            node_key: `n${i}`,
            label: `${i + 1} · Stage name here`,
            // A detail line long enough to wrap, which is what makes cards tall enough to collide.
            detail: 'Several words of supporting detail that wraps onto more than one line',
            position_x: 0,
            position_y: 0,
          })),
        ],
        edges: Array.from({ length: count }, (_, i) => ({
          id: `e${i}`,
          source_node_key: 'hub',
          target_node_key: `n${i}`,
        })),
        updated_at: new Date().toISOString(),
      }

      expectNoOverlaps(layoutMindmap(map, layoutOptions()), `fan of ${count}`)
    }
  })

  it('keeps the real 17-stage library mindmap clear', () => {
    const raw = readFileSync(join(process.cwd(), 'public', 'library', 'it-ops-roadmap-full.json'), 'utf8')
    const { mindmap } = importMindmap(raw)

    // The exact map that was overlapping on screen, checked at every preset.
    for (const preset of PRESETS) {
      expectNoOverlaps(layoutMindmap(mindmap, layoutOptions(preset)), `${preset.width}x${preset.height}`)
    }
  })

  it('honours the requested gap, not merely touching', () => {
    const layout = layoutMindmap(fixture(), layoutOptions({ nodeGap: 40 }))
    // The gap is in abstract units, so compare in the same space.
    const gapInPx = 40 * layout.scale

    for (let i = 0; i < layout.nodes.length; i++) {
      for (let j = i + 1; j < layout.nodes.length; j++) {
        const a = layout.nodes[i]
        const b = layout.nodes[j]
        const clearX = Math.abs(a.x - b.x) - (a.w + b.w) / 2
        const clearY = Math.abs(a.y - b.y) - (a.h + b.h) / 2
        // Separated on at least one axis by at least the gap, minus a rounding allowance.
        expect(Math.max(clearX, clearY)).toBeGreaterThan(gapInPx - 2)
      }
    }
  })

  it('spaces cards further apart as the gap rises', () => {
    const tight = layoutMindmap(fixture(), layoutOptions({ nodeGap: 4 }))
    const loose = layoutMindmap(fixture(), layoutOptions({ nodeGap: 70 }))

    // Both are fitted to the same canvas, so a larger gap shows up as smaller cards rather than a
    // larger graph. That is the observable consequence of asking for more space.
    expect(loose.scale).toBeLessThan(tight.scale)
  })

  it('separates overlapping hand-arranged cards', () => {
    const stacked: Mindmap = {
      id: 'stacked',
      name: 'Stacked',
      description: null,
      nodes: [
        { node_key: 'hub', label: 'Hub', position_x: 0, position_y: 0, hero: true },
        // Deliberately dropped almost on top of the hub, as dragging easily produces.
        { node_key: 'a', label: 'Alpha', position_x: 6, position_y: 8 },
        { node_key: 'b', label: 'Beta', position_x: 12, position_y: 16 },
      ],
      edges: [
        { id: 'e1', source_node_key: 'hub', target_node_key: 'a' },
        { id: 'e2', source_node_key: 'hub', target_node_key: 'b' },
      ],
      updated_at: new Date().toISOString(),
    }

    expectNoOverlaps(layoutMindmap(stacked, layoutOptions({ mode: 'manual' })), 'manual')
  })

  it('leaves overlaps alone when tidying is switched off', () => {
    const stacked: Mindmap = {
      id: 'stacked2',
      name: 'Stacked',
      description: null,
      nodes: [
        { node_key: 'hub', label: 'Hub', position_x: 0, position_y: 0, hero: true },
        { node_key: 'a', label: 'Alpha', position_x: 4, position_y: 4 },
      ],
      edges: [{ id: 'e1', source_node_key: 'hub', target_node_key: 'a' }],
      updated_at: new Date().toISOString(),
    }

    const layout = layoutMindmap(stacked, layoutOptions({ mode: 'manual', preventOverlap: false }))
    const [a, b] = layout.nodes
    // Confirms the toggle actually gates the behaviour rather than the fix being unconditional.
    expect(Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2).toBe(true)
  })

  it('survives a single-node mindmap', () => {
    const solo: Mindmap = {
      id: 's',
      name: 'Solo',
      description: null,
      nodes: [{ node_key: 'only', label: 'Only node', position_x: 0, position_y: 0 }],
      edges: [],
      updated_at: new Date().toISOString(),
    }
    const layout = layoutMindmap(solo, layoutOptions())
    expect(layout.nodes).toHaveLength(1)
    expect(Number.isFinite(layout.nodes[0].x)).toBe(true)
    expect(Number.isFinite(layout.scale)).toBe(true)
  })

  it('respects editor positions in manual mode', () => {
    const map = fixture()
    const layout = layoutMindmap(map, layoutOptions({ mode: 'manual' }))

    // Absolute coordinates change under the fit, but relative ordering must survive it.
    const hub = layout.nodes.find(n => n.key === 'hub')!
    const right = layout.nodes.find(n => n.key === 'b')!
    const left = layout.nodes.find(n => n.key === 'c')!
    expect(right.x).toBeGreaterThan(hub.x)
    expect(left.x).toBeLessThan(hub.x)
  })

  it('treats manual positions as top-left, so editor alignment survives into the export', () => {
    // Two nodes sharing a position_y must come out with aligned TOPS. They previously came out with
    // aligned centres, because the stored position was read as a centre — and since card heights differ
    // with text length, aligning tops in the editor produced misaligned tops in the animation.
    const map: Mindmap = {
      id: 'm',
      name: 'Aligned',
      description: null,
      nodes: [
        { node_key: 'short', label: 'Short', position_x: 0, position_y: 100, hero: true },
        { node_key: 'tall', label: 'Tall one', detail: 'Two lines of detail text here', position_x: 400, position_y: 100 },
      ],
      edges: [{ id: 'e', source_node_key: 'short', target_node_key: 'tall' }],
      updated_at: new Date().toISOString(),
    }

    const layout = layoutMindmap(map, layoutOptions({ mode: 'manual' }))
    const short = layout.nodes.find(n => n.key === 'short')!
    const tall = layout.nodes.find(n => n.key === 'tall')!

    expect(tall.h).toBeGreaterThan(short.h)
    expect(short.y - short.h / 2).toBeCloseTo(tall.y - tall.h / 2, 3)
  })

  it('equalises card heights when asked, so aligned edges stay aligned', () => {
    const map = fixture()

    const ragged = layoutMindmap(map, layoutOptions())
    const uniform = layoutMindmap(map, layoutOptions({ uniformCardHeight: true }))

    // The fixture has nodes with and without detail lines, so heights differ by default.
    expect(new Set(ragged.nodes.map(n => Math.round(n.h))).size).toBeGreaterThan(1)
    expect(new Set(uniform.nodes.map(n => Math.round(n.h))).size).toBe(1)
  })

  it('sizes uniform cards to the tallest, never shrinking one', () => {
    const map = fixture()
    const ragged = layoutMindmap(map, layoutOptions())
    const uniform = layoutMindmap(map, layoutOptions({ uniformCardHeight: true }))

    // Compared in abstract units, not canvas pixels. Equalising heights enlarges the content bounding
    // box, so fitToCanvas picks a smaller scale and every card ends up fewer pixels tall — which makes
    // a direct pixel comparison between two layouts meaningless. Dividing by each layout's own scale
    // recovers the pre-fit height, where "never shrink a card" is actually a statement about sizing.
    const tallestBefore = Math.max(...ragged.nodes.map(n => n.h / ragged.scale))

    for (const node of uniform.nodes) {
      expect(node.h / uniform.scale).toBeCloseTo(tallestBefore, 3)
    }
  })
})

// ── Connection weight, arrows and trims ──

describe('connections', () => {
  it('defaults to standard weight and no arrowheads', () => {
    const edge = { id: 'x', source_node_key: 'a', target_node_key: 'b' }
    expect(edgeWeightOf(edge)).toBe('standard')
    // Arrows are opt-in: turning them on by default would have restyled every existing mindmap.
    expect(edgeArrowOf(edge)).toBe('none')
  })

  it('migrates a legacy dashed edge to semi weight', () => {
    expect(migrateEdge({ id: 'x', source_node_key: 'a', target_node_key: 'b', dashed: true }).weight).toBe('semi')
    expect(migrateEdge({ id: 'x', source_node_key: 'a', target_node_key: 'b', dashed: false }).weight).toBe('standard')
  })

  it('leaves an explicit weight alone when a stale dashed flag is also present', () => {
    const migrated = migrateEdge({
      id: 'x',
      source_node_key: 'a',
      target_node_key: 'b',
      weight: 'heavy',
      dashed: true,
    })
    expect(migrated.weight).toBe('heavy')
    // The obsolete field must not survive, or it would keep re-triggering migration logic.
    expect('dashed' in migrated).toBe(false)
  })

  it('accepts weight and arrow through the importer, including legacy dashed', () => {
    const { mindmap } = importMindmap(
      JSON.stringify({
        name: 'Weights',
        nodes: [{ key: 'a', label: 'A', hero: true }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' }],
        edges: [
          { from: 'a', to: 'b', weight: 'heavy', arrow: 'both' },
          { from: 'a', to: 'c', dashed: true },
        ],
      }),
    )

    expect(mindmap.edges[0].weight).toBe('heavy')
    expect(mindmap.edges[0].arrow).toBe('both')
    expect(mindmap.edges[1].weight).toBe('semi')
  })

  it('ignores an unrecognised weight or arrow rather than storing it', () => {
    const { mindmap } = importMindmap(
      JSON.stringify({
        name: 'Bad values',
        nodes: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }],
        edges: [{ from: 'a', to: 'b', weight: 'ultra', arrow: 'sideways' }],
      }),
    )

    expect(mindmap.edges[0].weight).toBe('standard')
    expect(mindmap.edges[0].arrow).toBe('none')
  })

  it('round-trips weight and arrow through the authoring export', () => {
    const { mindmap } = importMindmap(
      JSON.stringify({
        name: 'Round trip',
        nodes: [{ key: 'a', label: 'A', hero: true }, { key: 'b', label: 'B' }],
        edges: [{ from: 'a', to: 'b', weight: 'heavy', arrow: 'start' }],
      }),
    )

    const reimported = importMindmap(exportAuthoringJson(mindmap)).mindmap
    expect(reimported.edges[0].weight).toBe('heavy')
    expect(reimported.edges[0].arrow).toBe('start')
  })

  it('carries weight and arrow through to the layout', () => {
    const layout = layoutMindmap(fixture(), layoutOptions())
    const semi = layout.edges.find(e => e.edge.id === 'e4')!

    expect(semi.weight).toBe('semi')
    expect(semi.arrow).toBe('both')
    // Node 'd' is reserved, so nothing flows down this connection.
    expect(semi.inert).toBe(true)
    expect(layout.edges.find(e => e.edge.id === 'e1')!.inert).toBe(false)
  })

  it('trims every connection clear of both cards', () => {
    const layout = layoutMindmap(fixture(), layoutOptions())

    for (const edge of layout.edges) {
      // Arrowheads and packets are placed between these, so an inverted or degenerate range would
      // put them behind a card or off the line entirely.
      expect(edge.startTrim).toBeGreaterThanOrEqual(0)
      expect(edge.endTrim).toBeLessThanOrEqual(1)
      expect(edge.startTrim).toBeLessThan(edge.endTrim)

      const source = layout.nodes.find(n => n.key === edge.edge.source_node_key)!
      const target = layout.nodes.find(n => n.key === edge.edge.target_node_key)!
      const start = pointAtFraction(edge.geom, edge.startTrim)
      const end = pointAtFraction(edge.geom, edge.endTrim)

      // The whole point of trimming: both ends have to be in the visible gap, not buried under the
      // card that is painted over the wire.
      expect(insideCard(start, source)).toBe(false)
      expect(insideCard(end, target)).toBe(false)
    }
  })

  it('points the two arrowheads in opposite directions', () => {
    const layout = layoutMindmap(fixture(), layoutOptions())
    const edge = layout.edges.find(e => e.edge.id === 'e4')!

    const atStart = tangentAtFraction(edge.geom, edge.startTrim)
    const atEnd = tangentAtFraction(edge.geom, edge.endTrim)
    // The start head is drawn against travel, so its effective direction is the negated tangent.
    // Those two must not coincide, or both heads would point the same way.
    const dot = -atStart.x * atEnd.x + -atStart.y * atEnd.y
    expect(dot).toBeLessThan(0)
  })
})

/**
 * Asserts no two cards overlap, naming the offending pair on failure.
 *
 * Reporting which cards collided matters: "expected true to be false" on a 17-node layout tells you
 * nothing about where to look.
 */
function expectNoOverlaps(layout: { nodes: PlacedNode[] }, context = ''): void {
  const collisions: string[] = []

  for (let i = 0; i < layout.nodes.length; i++) {
    for (let j = i + 1; j < layout.nodes.length; j++) {
      const a = layout.nodes[i]
      const b = layout.nodes[j]
      const overlapX = Math.abs(a.x - b.x) < (a.w + b.w) / 2
      const overlapY = Math.abs(a.y - b.y) < (a.h + b.h) / 2
      if (overlapX && overlapY) collisions.push(`${a.key} ↔ ${b.key}`)
    }
  }

  expect(collisions, `overlapping cards${context ? ` (${context})` : ''}`).toEqual([])
}

const insideCard = (p: { x: number; y: number }, node: { x: number; y: number; w: number; h: number }): boolean =>
  p.x > node.x - node.w / 2 && p.x < node.x + node.w / 2 && p.y > node.y - node.h / 2 && p.y < node.y + node.h / 2

// ── Attachment sides ──
//
// With `auto` the line runs centre-to-centre and is clipped where it emerges, which suits a radial
// layout. Naming a side pins the line to the midpoint of that face and makes it depart perpendicular.
// These check the anchor really lands on the named face, and that the curve leaves in the right
// direction rather than cutting back across its own card.

describe('connection sides', () => {
  /** Two cards side by side, so every face is unambiguous. */
  const pair = (sourceSide: string, targetSide: string): Mindmap => ({
    id: 'p',
    name: 'Pair',
    description: null,
    nodes: [
      { node_key: 'a', label: 'Alpha', position_x: -200, position_y: 0, hero: true },
      { node_key: 'b', label: 'Beta', position_x: 200, position_y: 0 },
    ],
    edges: [
      {
        id: 'e',
        source_node_key: 'a',
        target_node_key: 'b',
        source_side: sourceSide as never,
        target_side: targetSide as never,
      },
    ],
    updated_at: new Date().toISOString(),
  })

  const edgeOf = (map: Mindmap) => {
    const layout = layoutMindmap(map, layoutOptions({ mode: 'manual' }))
    return { layout, edge: layout.edges[0], nodes: layout.nodes }
  }

  it('defaults both ends to auto', () => {
    const edge = layoutMindmap(fixture(), layoutOptions()).edges[0]
    expect(edge.sourceSide).toBe('auto')
    expect(edge.targetSide).toBe('auto')
  })

  it('anchors on the named face, not the card centre', () => {
    const { edge, nodes } = edgeOf(pair('right', 'left'))
    const a = nodes.find(n => n.key === 'a')!
    const b = nodes.find(n => n.key === 'b')!

    // Right face of A: x at its right edge, y level with its centre.
    expect(edge.geom.p0.x).toBeGreaterThan(a.x + a.w / 2 - 1)
    expect(edge.geom.p0.y).toBeCloseTo(a.y, 3)

    // Left face of B.
    expect(edge.geom.p1.x).toBeLessThan(b.x - b.w / 2 + 1)
    expect(edge.geom.p1.y).toBeCloseTo(b.y, 3)
  })

  it('anchors top and bottom faces on the vertical axis', () => {
    const { edge, nodes } = edgeOf(pair('top', 'bottom'))
    const a = nodes.find(n => n.key === 'a')!
    const b = nodes.find(n => n.key === 'b')!

    expect(edge.geom.p0.x).toBeCloseTo(a.x, 3)
    expect(edge.geom.p0.y).toBeLessThan(a.y - a.h / 2 + 1)
    expect(edge.geom.p1.x).toBeCloseTo(b.x, 3)
    expect(edge.geom.p1.y).toBeGreaterThan(b.y + b.h / 2 - 1)
  })

  it('leaves perpendicular to the named face', () => {
    const { edge } = edgeOf(pair('top', 'bottom'))

    // Departure direction at the very start of the curve. Leaving the top face must head upward
    // (negative y), not straight at the target.
    const heading = tangentAtFraction(edge.geom, 0)
    expect(heading.y).toBeLessThan(-0.5)

    // Arriving at B's bottom face, the curve approaches from below, so it is still travelling up.
    const arriving = tangentAtFraction(edge.geom, 1)
    expect(arriving.y).toBeLessThan(0)
  })

  it('skips trimming at a named end, since the anchor is already outside the card', () => {
    const { edge } = edgeOf(pair('right', 'left'))
    expect(edge.startTrim).toBe(0)
    expect(edge.endTrim).toBe(1)
  })

  it('still trims the auto end when only one side is named', () => {
    const { edge, nodes } = edgeOf(pair('right', 'auto'))

    expect(edge.startTrim).toBe(0)
    // The target end has no named face, so it is clipped at the card boundary as before.
    expect(edge.endTrim).toBeLessThan(1)

    const b = nodes.find(n => n.key === 'b')!
    expect(insideCard(pointAtFraction(edge.geom, edge.endTrim), b)).toBe(false)
  })

  it('keeps arrowheads and packets on the visible stretch for every side pairing', () => {
    for (const source of ['auto', 'top', 'right', 'bottom', 'left']) {
      for (const target of ['auto', 'top', 'right', 'bottom', 'left']) {
        const { edge } = edgeOf(pair(source, target))
        expect(edge.startTrim).toBeGreaterThanOrEqual(0)
        expect(edge.endTrim).toBeLessThanOrEqual(1)
        expect(edge.startTrim).toBeLessThan(edge.endTrim)
      }
    }
  })

  it('reads sides from a React Flow dump handle id', () => {
    const { mindmap } = importMindmap(
      JSON.stringify({
        name: 'Flow dump',
        nodes: [
          { id: 'a', data: { label: 'A' }, position: { x: 0, y: 0 } },
          { id: 'b', data: { label: 'B' }, position: { x: 200, y: 0 } },
        ],
        edges: [{ id: 'e', source: 'a', target: 'b', sourceHandle: 'r', targetHandle: 'l' }],
      }),
    )

    // `r`/`l` are the handle ids the editor declares; a dump carries those rather than side names.
    expect(mindmap.edges[0].source_side).toBe('right')
    expect(mindmap.edges[0].target_side).toBe('left')
  })

  it('round-trips sides through the authoring export', () => {
    const { mindmap } = importMindmap(
      JSON.stringify({
        name: 'Sides',
        nodes: [{ key: 'a', label: 'A', hero: true }, { key: 'b', label: 'B' }],
        edges: [{ from: 'a', to: 'b', source_side: 'bottom', target_side: 'top' }],
      }),
    )

    const again = importMindmap(exportAuthoringJson(mindmap)).mindmap
    expect(again.edges[0].source_side).toBe('bottom')
    expect(again.edges[0].target_side).toBe('top')
  })

  it('ignores an unrecognised side rather than storing it', () => {
    const { mindmap } = importMindmap(
      JSON.stringify({
        name: 'Bad side',
        nodes: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }],
        edges: [{ from: 'a', to: 'b', source_side: 'diagonal' }],
      }),
    )

    expect(mindmap.edges[0].source_side).toBe('auto')
  })
})

// ── Signature containment ──
//
// The claim from the original request: "ensure proper offset from sides". This sweeps the whole
// settings space rather than spot-checking the default.

describe('signature placement', () => {
  const corners: SignatureCorner[] = ['bottom-left', 'bottom-right', 'top-left', 'top-right']

  const options = (over: Partial<SignatureOptions> = {}): SignatureOptions => ({
    corner: 'bottom-left',
    insetRatio: 0.034,
    heightRatio: 0.055,
    opacity: 0.92,
    caption: null,
    ...over,
  })

  it('stays fully inside the frame with at least the requested inset', () => {
    for (const preset of PRESETS) {
      for (const corner of corners) {
        // Includes a very wide banner mark and a very tall one.
        for (const aspect of [0.25, 1, 2.3, 12]) {
          for (const insetRatio of [0.01, 0.034, 0.1]) {
            for (const heightRatio of [0.02, 0.055, 0.14]) {
              const rect = signatureRect(
                preset.width,
                preset.height,
                aspect,
                options({ corner, insetRatio, heightRatio }),
              )
              const inset = Math.min(preset.width, preset.height) * insetRatio

              expect(rect.x).toBeGreaterThanOrEqual(inset - 1e-6)
              expect(rect.y).toBeGreaterThanOrEqual(inset - 1e-6)
              expect(rect.x + rect.width).toBeLessThanOrEqual(preset.width - inset + 1e-6)
              expect(rect.y + rect.height).toBeLessThanOrEqual(preset.height - inset + 1e-6)
              expect(rect.width).toBeGreaterThan(0)
              expect(rect.height).toBeGreaterThan(0)
            }
          }
        }
      }
    }
  })

  it('anchors to the requested corner', () => {
    const w = 1200
    const h = 1200
    const left = signatureRect(w, h, 2, options({ corner: 'bottom-left' }))
    const right = signatureRect(w, h, 2, options({ corner: 'bottom-right' }))
    const top = signatureRect(w, h, 2, options({ corner: 'top-left' }))

    expect(right.x).toBeGreaterThan(left.x)
    expect(top.y).toBeLessThan(left.y)
  })

  it('preserves the mark aspect ratio when it has to shrink to fit', () => {
    // A 12:1 banner at 14% height would be far wider than the frame allows.
    const rect = signatureRect(1080, 1350, 12, options({ heightRatio: 0.14 }))
    expect(rect.width / rect.height).toBeCloseTo(12, 4)
  })

  it('falls back to a sane box for a nonsense aspect', () => {
    for (const aspect of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const rect = signatureRect(1200, 1200, aspect, options())
      expect(Number.isFinite(rect.width)).toBe(true)
      expect(rect.width).toBeGreaterThan(0)
    }
  })
})

// ── Transparent-margin trimming ──
//
// The marks in public/brand/ fill roughly 62% of their file's width and 66% of its height, with
// asymmetric padding (11% above, 21% below). Without trimming, the size setting would scale the
// padding and the inset would be measured to an invisible edge — so the visible gap beside the
// mark would not match the gap beneath it.

describe('opaque bounds', () => {
  /** RGBA buffer with an opaque block at the given rect and transparency everywhere else. */
  const withBlock = (w: number, h: number, bx: number, by: number, bw: number, bh: number) => {
    const data = new Uint8ClampedArray(w * h * 4)
    for (let y = by; y < by + bh; y++) {
      for (let x = bx; x < bx + bw; x++) data[(y * w + x) * 4 + 3] = 255
    }
    return data
  }

  it('finds the tight box around visible pixels', () => {
    const bounds = opaqueBoundsFromAlpha(withBlock(100, 80, 20, 10, 40, 30), 100, 80)
    expect(bounds).toEqual({ x: 20, y: 10, width: 40, height: 30 })
  })

  it('reproduces the padding profile of the real brand files', () => {
    // Mirrors signature-black.png: 1536×1024 canvas, ink at x 292..1238, y 113..808.
    const w = 1536
    const h = 1024
    const bounds = opaqueBoundsFromAlpha(withBlock(w, h, 292, 113, 947, 696), w, h)!

    expect(bounds).toEqual({ x: 292, y: 113, width: 947, height: 696 })
    // The corrected aspect is the ink's, not the file's 1.5.
    expect(bounds.width / bounds.height).toBeCloseTo(1.361, 3)
  })

  it('makes the drawn mark match the requested height once trimmed', () => {
    const w = 1536
    const h = 1024
    const bounds = opaqueBoundsFromAlpha(withBlock(w, h, 292, 113, 947, 696), w, h)!
    const opts: SignatureOptions = {
      corner: 'bottom-left',
      insetRatio: 0.034,
      heightRatio: 0.055,
      opacity: 1,
      caption: null,
    }

    const trimmed = signatureRect(1200, 1200, bounds.width / bounds.height, opts)
    // 0.055 × 1200 = 66px of actual ink.
    expect(trimmed.height).toBeCloseTo(66, 4)

    // Untrimmed, the same request would have spent 32% of that height on empty padding.
    const untrimmed = signatureRect(1200, 1200, w / h, opts)
    const visibleInkHeight = untrimmed.height * (696 / h)
    expect(visibleInkHeight).toBeLessThan(46)
  })

  it('returns null for a fully transparent image', () => {
    expect(opaqueBoundsFromAlpha(new Uint8ClampedArray(40 * 40 * 4), 40, 40)).toBeNull()
  })

  it('handles ink running to the very edge', () => {
    expect(opaqueBoundsFromAlpha(withBlock(10, 10, 0, 0, 10, 10), 10, 10)).toEqual({
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    })
  })

  it('ignores near-transparent antialiasing fringe', () => {
    const data = withBlock(50, 50, 20, 20, 10, 10)
    // A faint halo at alpha 8 sits below the threshold and must not widen the box.
    for (let x = 0; x < 50; x++) data[(5 * 50 + x) * 4 + 3] = 8
    expect(opaqueBoundsFromAlpha(data, 50, 50)).toEqual({ x: 20, y: 20, width: 10, height: 10 })
  })
})

// ── Text fitting ──

describe('text wrapping', () => {
  it('never produces a line wider than the limit', () => {
    const measure = estimator(20)
    const samples = [
      'Short',
      'Microsoft Entra ID single sign-on',
      'Averyveryverylongsinglewordwithnobreaksatallhere',
      'QA: SQL DB · Prod: SQL MI · 60 EF migrations',
    ]
    for (const sample of samples) {
      for (const maxWidth of [60, 120, 240]) {
        for (const line of wrapText(sample, maxWidth, measure, 3)) {
          expect(measure(line)).toBeLessThanOrEqual(maxWidth + 1e-6)
        }
      }
    }
  })

  it('honours the line cap and ellipsises the overflow', () => {
    const measure = estimator(14)
    const lines = wrapText('one two three four five six seven eight nine ten eleven twelve', 70, measure, 2)
    expect(lines.length).toBeLessThanOrEqual(2)
    expect(lines.at(-1)).toContain('…')
  })

  it('returns nothing for blank input', () => {
    expect(wrapText('   ', 100, estimator(12))).toEqual([])
  })
})

// ── Geometry ──

describe('curve geometry', () => {
  it('advances a packet at near-constant speed along a curve', () => {
    const geom = measure(arcBetween({ x: 0, y: 0 }, { x: 400, y: 300 }, 0.2))
    const steps = 20
    const distances: number[] = []
    let previous = pointAtFraction(geom, 0)

    for (let i = 1; i <= steps; i++) {
      const next = pointAtFraction(geom, i / steps)
      distances.push(Math.hypot(next.x - previous.x, next.y - previous.y))
      previous = next
    }

    // Arc-length parameterisation should keep every step within a few percent of the mean.
    const mean = distances.reduce((a, b) => a + b, 0) / distances.length
    for (const d of distances) expect(Math.abs(d - mean) / mean).toBeLessThan(0.06)
  })

  it('anchors the curve to its endpoints', () => {
    const a = { x: 10, y: 20 }
    const b = { x: 300, y: 140 }
    const geom = measure(arcBetween(a, b, 0.18))
    expect(pointAtFraction(geom, 0)).toEqual(a)
    const end = pointAtFraction(geom, 1)
    expect(end.x).toBeCloseTo(b.x, 3)
    expect(end.y).toBeCloseTo(b.y, 3)
  })

  it('handles coincident endpoints without dividing by zero', () => {
    const p = { x: 5, y: 5 }
    const geom = measure(arcBetween(p, p, 0.2))
    expect(geom.length).toBe(0)
    expect(pointAtFraction(geom, 0.5)).toEqual(p)
  })
})

// ── Output sizing ──

describe('output size', () => {
  const composition = (width: number, height: number) =>
    ({ width, height }) as unknown as Parameters<typeof outputSize>[0]

  it('produces even dimensions, as H.264 requires', () => {
    for (const preset of PRESETS) {
      for (const maxSide of [361, 640, 721, 1080, 1920]) {
        const size = outputSize(composition(preset.width, preset.height), maxSide)
        expect(size.width % 2).toBe(0)
        expect(size.height % 2).toBe(0)
      }
    }
  })

  it('never exceeds the requested maxSide', () => {
    for (const preset of PRESETS) {
      for (const maxSide of [400, 900, 2160, 4000]) {
        const size = outputSize(composition(preset.width, preset.height), maxSide)
        expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(maxSide)
      }
    }
  })

  it('renders above the composition size when asked, rather than clamping to it', () => {
    // This is the behaviour that was missing: a clamp to scale <= 1 meant MP4 could never exceed the
    // preset's own dimensions, so the square preset topped out at 1200px however high the slider went.
    // Upscaling is valid here because frames are drawn from scratch at the output size, not resampled.
    const size = outputSize(composition(1200, 1200), 2400)
    expect(size.width).toBe(2400)
    expect(size.height).toBe(2400)
  })

  it('caps at the encoder ceiling even when more is requested', () => {
    const size = outputSize(composition(1200, 1200), 10_000)
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(MAX_ENCODE_SIDE)
  })

  it('caps by the longest side, so the shorter axis cannot exceed the ceiling either', () => {
    const size = outputSize(composition(1080, 1350), 10_000)
    expect(size.height).toBeLessThanOrEqual(MAX_ENCODE_SIDE)
    expect(size.width).toBeLessThanOrEqual(MAX_ENCODE_SIDE)
  })

  it('keeps the aspect ratio when scaling up', () => {
    const size = outputSize(composition(1080, 1350), 2700)
    expect(size.width / size.height).toBeCloseTo(1080 / 1350, 2)
  })

  it('keeps the aspect ratio within rounding error', () => {
    const size = outputSize(composition(1080, 1350), 720)
    expect(size.width / size.height).toBeCloseTo(1080 / 1350, 2)
  })
})

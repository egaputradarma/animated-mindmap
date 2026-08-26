// Turns a mindmap into absolute pixel geometry for a given canvas size.
//
// Two-stage on purpose. Stage one places cards in an abstract unit space where a card is
// CARD_W units wide, which lets ring radii be reasoned about in card-widths and keeps the
// arithmetic independent of the export resolution. Stage two measures the result and scales
// it once to fill the available box.
//
// Doing it in that order is what makes a single mindmap look right at 1:1, 4:5 and 16:9
// without per-preset tuning: the abstract layout is identical, only the final fit differs.
// It also means type scales with the cards, so legibility tracks how much of the frame the
// graph fills rather than the pixel dimensions.

import {
  curveBetweenAnchors,
  fractionOutside,
  measure as measureCurve,
  type Anchor,
  type CurveGeometry,
  type Point,
  type Rect,
} from './bezier'
import { separateBoxes } from './arrange'
import { buildGraph, edgeRevealOrder, leafCounts, revealOrder, type GraphView } from './graph'
import { estimator, wrapText } from './text'
import {
  ACCENT_NAMES,
  edgeArrowOf,
  edgeSourceSideOf,
  edgeTargetSideOf,
  edgeWeightOf,
  type AccentName,
  type EdgeArrow,
  type EdgeSide,
  type EdgeWeight,
  type Mindmap,
  type MindmapEdge,
  type MindmapNode,
} from '../types/mindmap'

/**
 * Card bounds, padded slightly so a wire clears the visible border rather than stopping flush
 * against it. Returns null for a missing node so callers can fall back.
 */
function cardRect(node: PlacedNode | undefined): Rect | null {
  if (!node) return null
  const pad = cardPad(node)
  return {
    x: node.x - node.w / 2 - pad,
    y: node.y - node.h / 2 - pad,
    width: node.w + pad * 2,
    height: node.h + pad * 2,
  }
}

const cardPad = (node: PlacedNode): number => Math.max(2, node.w * 0.03)

/** Outward unit normal of each card face. */
const SIDE_NORMALS: Record<Exclude<EdgeSide, 'auto'>, Point> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
}

/**
 * Where a connection attaches to a card, and which way it leaves.
 *
 * For `auto` the anchor is the card centre with no departure direction — the line runs centre-to-
 * centre and gets clipped where it emerges, which is what suits a radial layout. For a named side the
 * anchor sits on the midpoint of that face, nudged just outside by the same padding the trim uses, so
 * the line visibly touches the card rather than disappearing under its border.
 */
function anchorFor(node: PlacedNode | undefined, centre: Point, side: EdgeSide): Anchor {
  if (!node || side === 'auto') return { point: centre, normal: null }

  const normal = SIDE_NORMALS[side]
  const pad = cardPad(node)
  // Half-extent along the normal: width for the vertical faces, height for the horizontal ones.
  const reach = normal.x !== 0 ? node.w / 2 + pad : node.h / 2 + pad

  return {
    point: { x: centre.x + normal.x * reach, y: centre.y + normal.y * reach },
    normal,
  }
}

/** Abstract card width. Every other size in the abstract space is a ratio of this. */
const CARD_W = 150
const HERO_W = 172

// Type ratios run a little larger than the reference document's, which was built for a
// desktop reader sitting a foot from the screen. A LinkedIn card is viewed at roughly 40% of
// its exported width in-feed, so the reference's 12.3px title would land near 5 effective
// pixels. These ratios keep the title legible after that downscale.
const TITLE_RATIO = 0.1
const DETAIL_RATIO = 0.076
const ICON_RATIO = 0.14
const TAG_RATIO = 0.058

const PAD_V = 11
const PAD_H = 12
const LINE_SPACING = 1.28

export type LayoutMode = 'radial' | 'manual'

export interface LayoutOptions {
  width: number
  height: number
  mode: LayoutMode
  /** Multiplies ring radii. Below 1 tightens the graph (bigger cards), above 1 loosens it. */
  spread: number
  /**
   * Give every card the same height, taken from the tallest.
   *
   * Card height normally follows text length, so a one-word node sits noticeably shorter than one with
   * a detail line. That is fine radially, where cards rarely sit edge to edge, but it makes a
   * hand-arranged grid look ragged — and it means aligning edges in the editor cannot align them in the
   * export, because the export re-derives each height. Equalising removes both problems.
   */
  uniformCardHeight: boolean
  /**
   * Minimum clearance between any two cards, in abstract units where a card is 150 wide.
   *
   * In radial mode this drives the ring radii directly, so raising it pushes rings outward rather than
   * just adding padding. It is the single control for how far apart everything sits.
   */
  nodeGap: number
  /**
   * Nudge overlapping cards apart after placement.
   *
   * Radial placement should not need it; hand-arranged layouts almost always do.
   */
  preventOverlap: boolean
  /** Perpendicular bow of the connectors as a fraction of their span. 0 draws straight lines. */
  curvature: number
  /** Inset from every canvas edge, in px. */
  padding: number
  /** Vertical px reserved at the top for the title block. 0 when no title is drawn. */
  titleSpace: number
  /** Vertical px reserved at the bottom so the signature never sits on top of a card. */
  footerSpace: number
}

export interface CardText {
  titleLines: string[]
  detailLines: string[]
  tag: string | null
}

export interface PlacedNode {
  key: string
  node: MindmapNode
  /** Card centre, in canvas px. */
  x: number
  y: number
  w: number
  h: number
  depth: number
  /** Reveal slot, 0 = hub. Drives the cascade stagger. */
  order: number
  accent: AccentName
  isHub: boolean
  /**
   * Key of the depth-1 ancestor this node hangs from, or null for the hub itself. Groups a subtree
   * so the camera can frame one branch at a time.
   */
  branch: string | null
  text: CardText
  fonts: { title: number; detail: number; icon: number; tag: number }
}

export interface PlacedEdge {
  edge: MindmapEdge
  geom: CurveGeometry
  /** Reveal slot — the later of the two endpoints, so a wire never predates a card. */
  order: number
  accent: AccentName
  weight: EdgeWeight
  arrow: EdgeArrow
  /** Resolved attachment sides. `auto` means the line ran centre-to-centre and was clipped. */
  sourceSide: EdgeSide
  targetSide: EdgeSide
  /** Fraction at which the curve clears the source card. Arrowheads and packets start here. */
  startTrim: number
  /** Fraction at which the curve reaches the target card. Arrowheads and packets end here. */
  endTrim: number
  /**
   * True when either endpoint is marked `reserved`. Nothing flows to a connection that is not
   * wired up, so the renderer suppresses the packet — this is the "planned, not wired" semantic
   * that used to be conflated with a dashed line.
   */
  inert: boolean
}

export interface Layout {
  width: number
  height: number
  nodes: PlacedNode[]
  edges: PlacedEdge[]
  /** Abstract-units-to-px factor. Exposed so the renderer can scale stroke widths to match. */
  scale: number
  /** Highest reveal slot in use, i.e. `nodes.length - 1`. */
  lastOrder: number
}

/** Placement in abstract units, before the fit-to-canvas pass. */
interface AbstractNode {
  key: string
  node: MindmapNode
  x: number
  y: number
  /** Angle on the ring, radians. Radial mode only; assigned before radii are known. */
  angle: number
  w: number
  h: number
  depth: number
  order: number
  accent: AccentName
  isHub: boolean
  text: CardText
}

export function layoutMindmap(mindmap: Mindmap, options: LayoutOptions): Layout {
  const graph = buildGraph(mindmap)
  const order = revealOrder(graph)
  const { accents, branches } = assignAccents(graph)

  const abstract = mindmap.nodes.map(node => {
    const isHub = node.node_key === graph.hub
    const w = isHub ? HERO_W : CARD_W
    const text = measureCardText(node, w)
    return {
      key: node.node_key,
      node,
      x: 0,
      y: 0,
      angle: 0,
      w,
      h: cardHeight(text, w),
      depth: graph.depth.get(node.node_key) ?? 0,
      order: order.get(node.node_key) ?? 0,
      accent: accents.get(node.node_key) ?? 'blue',
      isHub,
      text,
    } satisfies AbstractNode
  })

  if (options.uniformCardHeight && abstract.length > 0) {
    // Tallest wins, so no card ever has to shrink its text to fit.
    const tallest = Math.max(...abstract.map(a => a.h))
    for (const node of abstract) node.h = tallest
  }

  const byKey = new Map(abstract.map(a => [a.key, a]))
  if (options.mode === 'manual') placeManual(abstract, mindmap.nodes)
  else placeRadial(abstract, byKey, graph, options.spread, options.nodeGap)

  if (options.preventOverlap) {
    // Radial placement already guarantees clearance, so this is a backstop there. In manual mode it is
    // doing real work: hand-dragged cards overlap constantly, and the hub is pinned so the arrangement
    // spreads outward from it rather than drifting as a whole.
    separateAbstractNodes(abstract, options.nodeGap, graph.hub)
  }

  return fitToCanvas(abstract, byKey, mindmap.edges, accents, branches, options, order)
}

/**
 * Branch colouring. Every node inherits the accent of the depth-1 ancestor it hangs from, so
 * a branch reads as one colour and the hub's spokes are all distinct — the same convention
 * the reference diagram uses. An explicit `accent` on a node always overrides this.
 */
function assignAccents(graph: GraphView): { accents: Map<string, AccentName>; branches: Map<string, string | null> } {
  const accents = new Map<string, AccentName>()
  const branches = new Map<string, string | null>()

  // Palette order is fixed, so the same mindmap always colours identically.
  const branchAccent = new Map<string, AccentName>()
  const topLevel = graph.children.get(graph.hub) ?? []
  topLevel.forEach((key, i) => branchAccent.set(key, ACCENT_NAMES[i % ACCENT_NAMES.length]))

  const branchRootOf = (key: string): string | null => {
    let current: string | null = key
    let guard = 0
    while (current && guard++ < 1000) {
      if (branchAccent.has(current)) return current
      current = graph.parent.get(current) ?? null
    }
    return null
  }

  for (const node of graph.nodes) {
    const isHub = node.node_key === graph.hub
    const root = isHub ? null : branchRootOf(node.node_key)
    branches.set(node.node_key, root)

    if (node.accent) {
      accents.set(node.node_key, node.accent)
      continue
    }
    if (isHub) {
      accents.set(node.node_key, 'blue')
      continue
    }
    accents.set(node.node_key, (root !== null ? branchAccent.get(root) : undefined) ?? 'slate')
  }

  return { accents, branches }
}

function measureCardText(node: MindmapNode, cardWidth: number): CardText {
  const inner = cardWidth - PAD_H * 2
  const titleFont = cardWidth * TITLE_RATIO
  const detailFont = cardWidth * DETAIL_RATIO

  return {
    titleLines: wrapText(node.label, inner, estimator(titleFont), 2),
    detailLines: node.detail ? wrapText(node.detail, inner, estimator(detailFont), 3) : [],
    tag: node.reserved ? (node.tag ?? null) : null,
  }
}

function cardHeight(text: CardText, cardWidth: number): number {
  const titleFont = cardWidth * TITLE_RATIO
  const detailFont = cardWidth * DETAIL_RATIO
  const iconFont = cardWidth * ICON_RATIO
  const tagFont = cardWidth * TAG_RATIO

  let h = PAD_V * 2
  h += iconFont + 5
  h += Math.max(1, text.titleLines.length) * titleFont * LINE_SPACING
  if (text.detailLines.length) h += 3 + text.detailLines.length * detailFont * LINE_SPACING
  if (text.tag) h += 4 + tagFont * LINE_SPACING
  return h
}

/**
 * Uses the editor's own coordinates.
 *
 * `position_x/position_y` are the card's TOP-LEFT corner, matching what React Flow stores, while this
 * layout works in centres — hence the half-size offset.
 *
 * Getting this wrong is subtle and was: treating the stored position as a centre shifts every node by
 * half its own size relative to the editor, and because card heights depend on text length, each node
 * shifts by a different amount. Arrangement done in the editor then did not survive into the export,
 * which makes any alignment tool meaningless.
 */
function placeManual(nodes: AbstractNode[], source: MindmapNode[]): void {
  const positions = new Map(source.map(n => [n.node_key, { x: n.position_x, y: n.position_y }]))
  for (const n of nodes) {
    const p = positions.get(n.key)
    n.x = (p?.x ?? 0) + n.w / 2
    n.y = (p?.y ?? 0) + n.h / 2
  }
}

/**
 * Runs the overlap separation over abstract nodes.
 *
 * Bridges between this module's centre-based coordinates and `arrange.ts`, which works in top-left boxes
 * so it can be shared with the editor's alignment tools.
 */
function separateAbstractNodes(nodes: AbstractNode[], gap: number, hub: string): void {
  const placements = separateBoxes(
    nodes.map(n => ({ key: n.key, x: n.x - n.w / 2, y: n.y - n.h / 2, width: n.w, height: n.h })),
    gap,
    new Set([hub]),
  )
  if (placements.size === 0) return

  for (const node of nodes) {
    const next = placements.get(node.key)
    if (next) {
      node.x = next.x + node.w / 2
      node.y = next.y + node.h / 2
    }
  }
}

/**
 * Radial tree placement.
 *
 * Each node owns an angular wedge; its children divide that wedge in proportion to how many
 * leaves each subtree contains. Weighting by leaves rather than splitting evenly is what
 * keeps a lopsided mindmap from colliding with itself — an even split gives a 6-leaf branch
 * the same room as a 1-leaf sibling, and the 6-leaf side then overlaps.
 *
 * Ring radii come from the circumference each ring needs to seat its cards side by side,
 * floored by a minimum gap from the ring inside it. Deriving radius from occupancy means a
 * sparse ring sits close in (bigger cards after the fit) while a crowded one pushes out only
 * as far as it must.
 */
function placeRadial(
  nodes: AbstractNode[],
  byKey: Map<string, AbstractNode>,
  graph: GraphView,
  spread: number,
  nodeGap: number,
): void {
  const leaves = leafCounts(graph)

  // Angles first, radii second. The order matters: how much room a card needs alongside its neighbour
  // depends on which way round the circle it sits, so the radius cannot be computed until the angles
  // are known. Getting this backwards is what caused cards to overlap on the left and right flanks.
  for (const root of graph.roots) {
    const rootNode = byKey.get(root)
    if (!rootNode) continue
    rootNode.x = 0
    rootNode.y = 0
    rootNode.angle = 0

    // Start at -90° so the first branch sits at the top, reading top-down like the reference.
    assignWedge(root, -Math.PI / 2, Math.PI * 2, byKey, graph, leaves)
  }

  const radii = ringRadii(nodes, spread, nodeGap)

  for (const node of nodes) {
    if (node.depth === 0) continue
    const radius = radii[Math.min(node.depth, radii.length - 1)]
    node.x = Math.cos(node.angle) * radius
    node.y = Math.sin(node.angle) * radius
  }
}

/** Assigns an angle to every node. Radius is applied later, once extents are known. */
function assignWedge(
  key: string,
  centreAngle: number,
  span: number,
  byKey: Map<string, AbstractNode>,
  graph: GraphView,
  leaves: Map<string, number>,
): void {
  const children = graph.children.get(key) ?? []
  if (children.length === 0) return

  const totalLeaves = children.reduce((sum, c) => sum + (leaves.get(c) ?? 1), 0) || 1

  // Each child sits at the centre of its own slot. That holds for a full circle and for a
  // narrowed wedge alike, because the recursive call below shrinks the span it hands down —
  // which is what stops cousins from interleaving without needing a special case here.
  let cursor = centreAngle - span / 2

  for (const child of children) {
    const weight = (leaves.get(child) ?? 1) / totalLeaves
    const slot = span * weight
    const angle = cursor + slot / 2
    cursor += slot

    const childNode = byKey.get(child)
    if (childNode) childNode.angle = angle

    // Children fan out within their parent's slot, narrowed so cousins cannot interleave.
    assignWedge(child, angle, slot * 0.86, byKey, graph, leaves)
  }
}

/**
 * Half-extent of an axis-aligned card measured along the ring (perpendicular to the radius).
 *
 * This is the number the old formula was missing. Cards are never rotated to follow the circle, so how
 * much of the ring one occupies depends on where it sits: at the top or bottom, neighbours sit
 * side by side and the card's WIDTH is what has to clear; on the left and right flanks the ring runs
 * vertically, neighbours stack, and its HEIGHT is what has to clear.
 *
 * Using width alone — as before — under-reserves space by roughly the difference between width and
 * height wherever the ring is steep, which is exactly where the overlapping happened.
 */
function tangentialHalfExtent(node: AbstractNode): number {
  const sin = Math.abs(Math.sin(node.angle))
  const cos = Math.abs(Math.cos(node.angle))
  return (node.w / 2) * sin + (node.h / 2) * cos
}

/** Half-extent along the radius, used to keep consecutive rings clear of one another. */
function radialHalfExtent(node: AbstractNode): number {
  const sin = Math.abs(Math.sin(node.angle))
  const cos = Math.abs(Math.cos(node.angle))
  return (node.w / 2) * cos + (node.h / 2) * sin
}

/**
 * Radius per ring, derived so that no two neighbours on it can touch.
 *
 * For adjacent nodes separated by Δθ, the straight-line distance between their centres is
 * `2·r·sin(Δθ/2)`. Requiring that to be at least the sum of their facing half-extents plus the gap and
 * solving for `r` gives the smallest radius that guarantees clearance. Taking the maximum across
 * adjacent pairs sizes the ring for its tightest pinch rather than its average.
 */
function ringRadii(nodes: AbstractNode[], spread: number, nodeGap: number): number[] {
  const byDepth = new Map<number, AbstractNode[]>()
  let maxDepth = 0
  for (const n of nodes) {
    const list = byDepth.get(n.depth)
    if (list) list.push(n)
    else byDepth.set(n.depth, [n])
    maxDepth = Math.max(maxDepth, n.depth)
  }

  const radii = [0]

  for (let depth = 1; depth <= maxDepth; depth++) {
    const ring = (byDepth.get(depth) ?? []).slice().sort((a, b) => a.angle - b.angle)
    const inner = byDepth.get(depth - 1) ?? []

    let required = CARD_W * 1.35

    // ── Tangential: clearance between neighbours on this ring ──
    for (let i = 0; i < ring.length; i++) {
      const current = ring[i]
      // Wrap to the first node, closing the circle. Without this the pair spanning the -90° seam is
      // never checked, and that is where the first and last branch meet.
      const next = ring[(i + 1) % ring.length]
      if (ring.length < 2) break

      let delta = next.angle - current.angle
      if (i === ring.length - 1) delta += Math.PI * 2
      // Antipodal or beyond needs no help; sin would also start shrinking again past π.
      if (delta >= Math.PI) continue

      const halfChord = Math.sin(delta / 2)
      if (halfChord <= 1e-6) continue

      const needed = (tangentialHalfExtent(current) + tangentialHalfExtent(next) + nodeGap) / (2 * halfChord)
      required = Math.max(required, needed)
    }

    // ── Radial: clearance from the ring inside this one ──
    const innerReach = inner.length > 0 ? Math.max(...inner.map(radialHalfExtent)) : 0
    const outerReach = ring.length > 0 ? Math.max(...ring.map(radialHalfExtent)) : 0
    required = Math.max(required, radii[depth - 1] + innerReach + outerReach + nodeGap)

    radii.push(required)
  }

  // Spread is applied at the end so it scales the whole arrangement uniformly. Folding it in per ring
  // compounded, because each radius is built from the previous one.
  return radii.map(r => r * spread)
  return radii
}

/**
 * Scales and centres the abstract layout into the drawable box, then builds the connector
 * curves in final pixel space.
 *
 * Curves are built after scaling rather than scaled along with the points because the arc
 * bow is a fraction of the span: computing it pre-scale and then scaling non-uniformly (which
 * a non-square canvas would do if width and height scaled independently) would skew the
 * arcs. A single uniform `scale` avoids that entirely, at the cost of not filling both axes.
 */
function fitToCanvas(
  abstract: AbstractNode[],
  byKey: Map<string, AbstractNode>,
  edges: MindmapEdge[],
  accents: Map<string, AccentName>,
  branches: Map<string, string | null>,
  options: LayoutOptions,
  order: Map<string, number>,
): Layout {
  const boxLeft = options.padding
  const boxTop = options.padding + options.titleSpace
  const boxRight = options.width - options.padding
  const boxBottom = options.height - options.padding - options.footerSpace
  const boxW = Math.max(1, boxRight - boxLeft)
  const boxH = Math.max(1, boxBottom - boxTop)

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of abstract) {
    minX = Math.min(minX, n.x - n.w / 2)
    maxX = Math.max(maxX, n.x + n.w / 2)
    minY = Math.min(minY, n.y - n.h / 2)
    maxY = Math.max(maxY, n.y + n.h / 2)
  }
  // A single node has zero extent in one axis; guard the division.
  const contentW = Math.max(1e-6, maxX - minX)
  const contentH = Math.max(1e-6, maxY - minY)

  // Cap magnification so a two-node mindmap does not render as two billboards.
  const scale = Math.min(boxW / contentW, boxH / contentH, 4)

  const contentCentreX = (minX + maxX) / 2
  const contentCentreY = (minY + maxY) / 2
  const originX = boxLeft + boxW / 2 - contentCentreX * scale
  const originY = boxTop + boxH / 2 - contentCentreY * scale
  const toCanvas = (n: AbstractNode): Point => ({ x: originX + n.x * scale, y: originY + n.y * scale })

  const placed: PlacedNode[] = abstract.map(n => {
    const p = toCanvas(n)
    const w = n.w * scale
    return {
      key: n.key,
      node: n.node,
      x: p.x,
      y: p.y,
      w,
      h: n.h * scale,
      depth: n.depth,
      order: n.order,
      accent: n.accent,
      isHub: n.isHub,
      branch: branches.get(n.key) ?? null,
      text: n.text,
      fonts: {
        title: w * TITLE_RATIO,
        detail: w * DETAIL_RATIO,
        icon: w * ICON_RATIO,
        tag: w * TAG_RATIO,
      },
    }
  })

  const placedById = new Map(placed.map(p => [p.key, p]))

  const placedEdges: PlacedEdge[] = []
  for (const edge of edges) {
    const a = byKey.get(edge.source_node_key)
    const b = byKey.get(edge.target_node_key)
    if (!a || !b) continue

    const sourceSide = edgeSourceSideOf(edge)
    const targetSide = edgeTargetSideOf(edge)

    const sourceAnchor = anchorFor(placedById.get(a.key), toCanvas(a), sourceSide)
    const targetAnchor = anchorFor(placedById.get(b.key), toCanvas(b), targetSide)
    const geom = measureCurve(curveBetweenAnchors(sourceAnchor, targetAnchor, options.curvature))

    // Trims are resolved once here rather than per frame: the geometry is fixed for the life of a
    // layout, and the sampling below is far too costly to repeat 300 times during an export.
    // Searched across the whole curve rather than just the near half. A card's half-height can be
    // most of the distance to a vertically-adjacent neighbour, so the exit point legitimately sits
    // past the midpoint and a narrower window would miss it.
    //
    // A named side needs no trim at that end: the anchor already sits just outside the card face, so
    // the whole curve is visible and sampling for a crossing would only find the far card.
    const sourceRect = sourceSide === 'auto' ? cardRect(placedById.get(a.key)) : null
    const targetRect = targetSide === 'auto' ? cardRect(placedById.get(b.key)) : null
    let startTrim = sourceRect ? fractionOutside(geom, sourceRect, 0, 1) : 0
    let endTrim = targetRect ? fractionOutside(geom, targetRect, 1, 0) : 1

    if (startTrim >= endTrim) {
      // The two cards cover the entire curve between them, which happens when they overlap or sit
      // closer than their own dimensions. There is no truly visible stretch, so a thin band around
      // the midpoint at least keeps arrowheads and packets on the line and in the right order.
      const middle = (startTrim + endTrim) / 2
      startTrim = Math.max(0, middle - 0.04)
      endTrim = Math.min(1, middle + 0.04)
    }

    placedEdges.push({
      edge,
      geom,
      order: edgeRevealOrder(edge, order),
      // The wire takes the colour of whichever end is further from the hub, so a spoke
      // matches the branch it feeds rather than the hub it leaves.
      accent: (a.depth >= b.depth ? accents.get(a.key) : accents.get(b.key)) ?? 'slate',
      weight: edgeWeightOf(edge),
      arrow: edgeArrowOf(edge),
      sourceSide,
      targetSide,
      startTrim,
      endTrim,
      inert: a.node.reserved === true || b.node.reserved === true,
    })
  }

  return {
    width: options.width,
    height: options.height,
    nodes: placed,
    edges: placedEdges,
    scale,
    lastOrder: Math.max(0, ...placed.map(n => n.order)),
  }
}

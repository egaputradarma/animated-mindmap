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

import { arcBetween, measure as measureCurve, type CurveGeometry, type Point } from './bezier'
import { buildGraph, edgeRevealOrder, leafCounts, revealOrder, type GraphView } from './graph'
import { estimator, wrapText } from './text'
import { ACCENT_NAMES, type AccentName, type Mindmap, type MindmapEdge, type MindmapNode } from '../types/mindmap'

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
  text: CardText
  fonts: { title: number; detail: number; icon: number; tag: number }
}

export interface PlacedEdge {
  edge: MindmapEdge
  geom: CurveGeometry
  /** Reveal slot — the later of the two endpoints, so a wire never predates a card. */
  order: number
  accent: AccentName
  dashed: boolean
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
  const accents = assignAccents(graph)

  const abstract = mindmap.nodes.map(node => {
    const isHub = node.node_key === graph.hub
    const w = isHub ? HERO_W : CARD_W
    const text = measureCardText(node, w)
    return {
      key: node.node_key,
      node,
      x: 0,
      y: 0,
      w,
      h: cardHeight(text, w),
      depth: graph.depth.get(node.node_key) ?? 0,
      order: order.get(node.node_key) ?? 0,
      accent: accents.get(node.node_key) ?? 'blue',
      isHub,
      text,
    } satisfies AbstractNode
  })

  const byKey = new Map(abstract.map(a => [a.key, a]))
  if (options.mode === 'manual') placeManual(abstract, mindmap.nodes)
  else placeRadial(abstract, byKey, graph, options.spread)

  return fitToCanvas(abstract, byKey, mindmap.edges, accents, options, order)
}

/**
 * Branch colouring. Every node inherits the accent of the depth-1 ancestor it hangs from, so
 * a branch reads as one colour and the hub's spokes are all distinct — the same convention
 * the reference diagram uses. An explicit `accent` on a node always overrides this.
 */
function assignAccents(graph: GraphView): Map<string, AccentName> {
  const result = new Map<string, AccentName>()

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
    if (node.accent) {
      result.set(node.node_key, node.accent)
      continue
    }
    if (node.node_key === graph.hub) {
      result.set(node.node_key, 'blue')
      continue
    }
    const root = branchRootOf(node.node_key)
    result.set(node.node_key, (root !== null ? branchAccent.get(root) : undefined) ?? 'slate')
  }

  return result
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

/** Uses the editor's own coordinates, recentred on the origin. */
function placeManual(nodes: AbstractNode[], source: MindmapNode[]): void {
  const positions = new Map(source.map(n => [n.node_key, { x: n.position_x, y: n.position_y }]))
  for (const n of nodes) {
    const p = positions.get(n.key)
    n.x = p?.x ?? 0
    n.y = p?.y ?? 0
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
): void {
  const leaves = leafCounts(graph)
  const radii = ringRadii(nodes, spread)

  // Components are laid out concentrically around a shared centre; the hub's component
  // dominates and any stragglers land on the same rings. Disconnected mindmaps are a corner
  // case, not a use case, so this only has to be sane, not pretty.
  for (const root of graph.roots) {
    const rootNode = byKey.get(root)
    if (!rootNode) continue
    rootNode.x = 0
    rootNode.y = 0

    // Start at -90° so the first branch sits at the top, reading top-down like the reference.
    assignWedge(root, -Math.PI / 2, Math.PI * 2, byKey, graph, leaves, radii)
  }
}

function assignWedge(
  key: string,
  centreAngle: number,
  span: number,
  byKey: Map<string, AbstractNode>,
  graph: GraphView,
  leaves: Map<string, number>,
  radii: number[],
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
    if (childNode) {
      const depth = graph.depth.get(child) ?? 1
      const radius = radii[Math.min(depth, radii.length - 1)]
      childNode.x = Math.cos(angle) * radius
      childNode.y = Math.sin(angle) * radius
    }

    // Children fan out within their parent's slot, narrowed so cousins cannot interleave.
    assignWedge(child, angle, slot * 0.86, byKey, graph, leaves, radii)
  }
}

function ringRadii(nodes: AbstractNode[], spread: number): number[] {
  const perDepth = new Map<number, number>()
  let maxDepth = 0
  for (const n of nodes) {
    perDepth.set(n.depth, (perDepth.get(n.depth) ?? 0) + 1)
    maxDepth = Math.max(maxDepth, n.depth)
  }

  const radii = [0]
  for (let depth = 1; depth <= maxDepth; depth++) {
    const count = perDepth.get(depth) ?? 1
    // Arc length each card needs, with breathing room between neighbours.
    const needed = (count * CARD_W * 1.18) / (Math.PI * 2)
    // Radial clearance from the previous ring: card height plus a gap.
    const stepped = radii[depth - 1] + CARD_W * 0.62
    radii.push(Math.max(needed, stepped, CARD_W * 1.35) * spread)
  }
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
      text: n.text,
      fonts: {
        title: w * TITLE_RATIO,
        detail: w * DETAIL_RATIO,
        icon: w * ICON_RATIO,
        tag: w * TAG_RATIO,
      },
    }
  })

  const placedEdges: PlacedEdge[] = []
  for (const edge of edges) {
    const a = byKey.get(edge.source_node_key)
    const b = byKey.get(edge.target_node_key)
    if (!a || !b) continue

    const from = toCanvas(a)
    const to = toCanvas(b)
    placedEdges.push({
      edge,
      geom: measureCurve(arcBetween(from, to, options.curvature)),
      order: edgeRevealOrder(edge, order),
      // The wire takes the colour of whichever end is further from the hub, so a spoke
      // matches the branch it feeds rather than the hub it leaves.
      accent: (a.depth >= b.depth ? accents.get(a.key) : accents.get(b.key)) ?? 'slate',
      dashed: edge.dashed === true,
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

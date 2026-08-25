// The mindmap model this app animates.
//
// It deliberately mirrors MICA's wire shape (`ea-architecture-app`): snake_case fields,
// `node_key` as node identity, edges addressing nodes by key rather than array index.
// Keeping the shapes aligned means a MICA payload imports with a field-for-field copy
// (see lib/mica.ts) and that this renderer could migrate back into MICA later without a
// translation layer in between.
//
// What MICA does NOT have is the presentation metadata the animated view needs — icon,
// detail line, accent colour, hub/planned flags. In MICA those live inside the per-node
// `data_json` escape hatch, so adopting them there needs no schema migration. Here they
// are first-class optional fields.

/** Palette slot names. Resolved to actual colours per theme in lib/palette.ts. */
export type AccentName = 'blue' | 'pink' | 'cyan' | 'gold' | 'green' | 'purple' | 'red' | 'slate'

export const ACCENT_NAMES: readonly AccentName[] = [
  'blue',
  'cyan',
  'green',
  'gold',
  'pink',
  'purple',
  'red',
  'slate',
]

export interface MindmapNode {
  /** Stable identity. Edges reference this, never an array position. */
  node_key: string
  label: string
  /** Free canvas coordinates from the editor. Only used by the 'manual' layout mode. */
  position_x: number
  position_y: number
  /** Short glyph shown above the title. An emoji works; so does one or two letters. */
  icon?: string | null
  /** The muted description line under the title. Kept short — it is a card, not a paragraph. */
  detail?: string | null
  /** Palette slot. When null the layout assigns one per branch so siblings differ. */
  accent?: AccentName | null
  /**
   * Marks the hub. At most one node should set this; when none does, the layout picks the
   * highest-degree node. The hub renders larger with an accent border and a wide glow.
   */
  hero?: boolean
  /** "Planned / not wired yet" styling: dimmed card, dashed border, dashed connectors. */
  reserved?: boolean
  /** Small uppercase tag under the detail line. Only drawn when `reserved` is set. */
  tag?: string | null
}

/**
 * How much a connection carries, expressed as line weight.
 *
 *  - `heavy`    thick solid line. The main path.
 *  - `standard` normal solid line. The default.
 *  - `semi`     thinner dashed line. A partial or intermittent path.
 */
export type EdgeWeight = 'heavy' | 'standard' | 'semi'

/** Which ends of a connection get an arrowhead. */
export type EdgeArrow = 'none' | 'start' | 'end' | 'both'

export const EDGE_WEIGHTS: readonly EdgeWeight[] = ['heavy', 'standard', 'semi']
export const EDGE_ARROWS: readonly EdgeArrow[] = ['none', 'end', 'start', 'both']

export const DEFAULT_EDGE_WEIGHT: EdgeWeight = 'standard'
// `none` rather than `end` so adding this feature did not silently put arrowheads on every
// existing mindmap. The reference diagram this app's look is drawn from has no arrowheads either —
// it conveys direction with travelling packets — so arrows are opt-in per edge.
export const DEFAULT_EDGE_ARROW: EdgeArrow = 'none'

export interface MindmapEdge {
  id: string
  source_node_key: string
  target_node_key: string
  label?: string | null
  /** Line weight. Absent means `standard`. */
  weight?: EdgeWeight
  /** Arrowhead placement. Absent means `none`. */
  arrow?: EdgeArrow
}

export const edgeWeightOf = (edge: MindmapEdge): EdgeWeight => edge.weight ?? DEFAULT_EDGE_WEIGHT
export const edgeArrowOf = (edge: MindmapEdge): EdgeArrow => edge.arrow ?? DEFAULT_EDGE_ARROW

/** Labels for the editor controls, kept next to the type so the two cannot drift apart. */
export const EDGE_WEIGHT_LABELS: Record<EdgeWeight, string> = {
  heavy: 'Heavy',
  standard: 'Standard',
  semi: 'Semi',
}

export const EDGE_ARROW_LABELS: Record<EdgeArrow, string> = {
  none: 'None',
  end: 'To end',
  start: 'To start',
  both: 'Both',
}

export interface Mindmap {
  id: string
  name: string
  description: string | null
  nodes: MindmapNode[]
  edges: MindmapEdge[]
  /** ISO timestamp, used only for list ordering. */
  updated_at: string
}

export interface MindmapSummary {
  id: string
  name: string
  description: string | null
  node_count: number
  updated_at: string
}

/**
 * Brings an edge from any older shape up to date.
 *
 * `dashed: boolean` was the original field, and it meant two things at once: draw a dashed line,
 * and treat the connection as not-yet-real (no travelling packet). Those are now separate — weight
 * is purely visual, and "nothing flows here" comes from an endpoint node's `reserved` flag. So a
 * legacy `dashed: true` becomes `weight: 'semi'`, and the packet suppression it used to imply is
 * already carried by the reserved node it pointed at.
 *
 * Applied on both import and storage read, because mindmaps saved before this change are sitting
 * in localStorage and must not silently lose their dashed styling.
 */
export function migrateEdge(edge: MindmapEdge & { dashed?: unknown }): MindmapEdge {
  const { dashed, ...rest } = edge
  if (rest.weight) return rest
  return { ...rest, weight: dashed === true ? 'semi' : DEFAULT_EDGE_WEIGHT }
}

export const summarise = (m: Mindmap): MindmapSummary => ({
  id: m.id,
  name: m.name,
  description: m.description,
  node_count: m.nodes.length,
  updated_at: m.updated_at,
})

/** Blank node at a given canvas point, ready for the editor to drop in. */
export function emptyNode(key: string, x: number, y: number): MindmapNode {
  return {
    node_key: key,
    label: 'New node',
    position_x: x,
    position_y: y,
    icon: null,
    detail: null,
    accent: null,
    hero: false,
    reserved: false,
    tag: null,
  }
}

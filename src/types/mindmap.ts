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

export interface MindmapEdge {
  id: string
  source_node_key: string
  target_node_key: string
  label?: string | null
  /** Dashed, packet-less connector. Mirrors `.wire-base.dashed` in the reference. */
  dashed?: boolean
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

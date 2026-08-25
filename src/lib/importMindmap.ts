// One paste box, four accepted shapes.
//
// The point of sniffing rather than asking the user to pick a format is that every source
// of a mindmap here produces a different shape and none of them are worth a separate UI:
//
//  1. `authoring`  — the hand/AI-written shape documented in docs/mindmap-schema.md.
//                    Terse on purpose: `{from,to}` edges, keys optional, no coordinates.
//                    This is what an assistant produces when handed a reference image.
//  2. `mica-front` — MICA's frontend DTO (snake_case, `node_key`), i.e. what you get from
//                    `useMindmap()` in ea-architecture-app.
//  3. `mica-api`   — MICA's raw API JSON (camelCase, `nodeKey`), i.e. the response body of
//                    `GET /api/mindmaps/{id}` straight out of devtools or curl.
//  4. `reactflow`  — a React Flow graph dump (`id` + `position.{x,y}`, `source`/`target`).
//
// Everything converges on the internal Mindmap model. Presentation metadata (icon, detail,
// accent, hero, reserved, tag) is read from a node's `data_json` when the source is MICA,
// because that is the only place MICA has to put it without a schema migration.

import { uid } from './id'
import {
  ACCENT_NAMES,
  DEFAULT_EDGE_ARROW,
  DEFAULT_EDGE_WEIGHT,
  EDGE_ARROWS,
  EDGE_WEIGHTS,
  type AccentName,
  type EdgeArrow,
  type EdgeWeight,
  type Mindmap,
  type MindmapEdge,
  type MindmapNode,
} from '../types/mindmap'

export type SourceFormat = 'authoring' | 'mica-front' | 'mica-api' | 'reactflow'

export interface ImportResult {
  mindmap: Mindmap
  format: SourceFormat
  /** Non-fatal notes worth surfacing — dropped edges, generated keys, and so on. */
  warnings: string[]
}

export class ImportError extends Error {}

type Json = Record<string, unknown>

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const asArray = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isObj) : [])
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const bool = (v: unknown): boolean => v === true

function accent(v: unknown): AccentName | null {
  const s = str(v)?.toLowerCase()
  return s && (ACCENT_NAMES as readonly string[]).includes(s) ? (s as AccentName) : null
}

function edgeWeight(v: unknown): EdgeWeight | null {
  const s = str(v)?.toLowerCase()
  return s && (EDGE_WEIGHTS as readonly string[]).includes(s) ? (s as EdgeWeight) : null
}

function edgeArrow(v: unknown): EdgeArrow | null {
  const s = str(v)?.toLowerCase()
  return s && (EDGE_ARROWS as readonly string[]).includes(s) ? (s as EdgeArrow) : null
}

/** MICA stores presentation metadata as a JSON string. Unparseable is not an error here. */
function parseDataJson(v: unknown): Json {
  const s = str(v)
  if (!s) return {}
  try {
    const parsed: unknown = JSON.parse(s)
    return isObj(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function detectFormat(root: Json): SourceFormat {
  const nodes = asArray(root.nodes)
  const edges = asArray(root.edges)
  if (nodes.some(n => 'node_key' in n)) return 'mica-front'
  if (nodes.some(n => 'nodeKey' in n)) return 'mica-api'
  if (nodes.some(n => isObj(n.position)) || edges.some(e => 'source' in e && !('from' in e))) return 'reactflow'
  return 'authoring'
}

/**
 * Turns a label into a stable key. The authoring shape lets `key` be omitted so an
 * assistant can write less, but edges still have to address nodes somehow — so labels
 * become the fallback identity and must therefore be unique. `seen` enforces that by
 * suffixing duplicates rather than silently merging two nodes into one.
 */
function keyFromLabel(label: string, seen: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'node'
  let key = base
  let n = 2
  while (seen.has(key)) key = `${base}-${n++}`
  seen.add(key)
  return key
}

/** Reads the presentation fields, which sit at the top level in every shape but MICA's. */
function readPresentation(src: Json): Pick<MindmapNode, 'icon' | 'detail' | 'accent' | 'hero' | 'reserved' | 'tag'> {
  return {
    icon: str(src.icon),
    detail: str(src.detail) ?? str(src.description) ?? str(src.subtitle),
    accent: accent(src.accent) ?? accent(src.color),
    hero: bool(src.hero) || bool(src.isHero) || bool(src.root),
    reserved: bool(src.reserved) || bool(src.planned),
    tag: str(src.tag),
  }
}

export function importMindmap(raw: string): ImportResult {
  let root: unknown
  try {
    root = JSON.parse(raw)
  } catch (err) {
    throw new ImportError(`That is not valid JSON — ${err instanceof Error ? err.message : 'parse failed'}`)
  }
  if (!isObj(root)) throw new ImportError('Expected a JSON object at the top level.')

  const format = detectFormat(root)
  const warnings: string[] = []
  const rawNodes = asArray(root.nodes)
  if (rawNodes.length === 0) throw new ImportError('No nodes found. Expected a non-empty "nodes" array.')

  const seen = new Set<string>()
  const nodes: MindmapNode[] = []

  for (const src of rawNodes) {
    // Identity, in source-specific precedence order.
    const explicit =
      str(src.node_key) ?? str(src.nodeKey) ?? str(src.key) ?? (format === 'reactflow' ? str(src.id) : null)

    // React Flow keeps the label inside `data`; MICA and the authoring shape keep it flat.
    const data = isObj(src.data) ? src.data : {}
    const label = str(src.label) ?? str(data.label) ?? str(src.name) ?? str(src.title)
    if (!label && !explicit) {
      warnings.push('Skipped a node with neither a label nor a key.')
      continue
    }

    const key = explicit && !seen.has(explicit) ? (seen.add(explicit), explicit) : keyFromLabel(label ?? 'node', seen)
    if (explicit && key !== explicit) warnings.push(`Duplicate key "${explicit}" — renamed to "${key}".`)

    // MICA hides presentation metadata in data_json; every other shape has it up top.
    const meta = format === 'mica-front' || format === 'mica-api' ? parseDataJson(src.data_json ?? src.dataJson) : {}
    const presentation = readPresentation({ ...data, ...meta, ...src })

    const pos = isObj(src.position) ? src.position : {}
    nodes.push({
      node_key: key,
      label: label ?? key,
      position_x: num(src.position_x) ?? num(src.positionX) ?? num(pos.x) ?? num(src.x) ?? 0,
      position_y: num(src.position_y) ?? num(src.positionY) ?? num(pos.y) ?? num(src.y) ?? 0,
      ...presentation,
    })
  }

  if (nodes.length === 0) throw new ImportError('Every node was skipped — none had a usable label or key.')

  // Labels are the fallback identity for keyless authoring input, so edges may address a
  // node either way. Resolving through both maps keeps `{"from":"Azure SQL"}` working.
  const byKey = new Map(nodes.map(n => [n.node_key, n.node_key]))
  const byLabel = new Map(nodes.map(n => [n.label.toLowerCase(), n.node_key]))
  const resolve = (v: unknown): string | null => {
    const s = str(v)
    if (!s) return null
    return byKey.get(s) ?? byLabel.get(s.toLowerCase()) ?? null
  }

  const edges: MindmapEdge[] = []
  const pairs = new Set<string>()
  for (const src of asArray(root.edges)) {
    const from = resolve(src.source_node_key ?? src.sourceNodeKey ?? src.from ?? src.source)
    const to = resolve(src.target_node_key ?? src.targetNodeKey ?? src.to ?? src.target)
    const rawFrom = str(src.source_node_key ?? src.sourceNodeKey ?? src.from ?? src.source) ?? '?'
    const rawTo = str(src.target_node_key ?? src.targetNodeKey ?? src.to ?? src.target) ?? '?'

    if (!from || !to) {
      warnings.push(`Dropped edge ${rawFrom} → ${rawTo}: unknown node.`)
      continue
    }
    if (from === to) {
      warnings.push(`Dropped self-loop on "${from}".`)
      continue
    }
    // Undirected for layout purposes, so A→B and B→A would stack two identical curves.
    const pair = [from, to].sort().join('\u0000')
    if (pairs.has(pair)) {
      warnings.push(`Dropped duplicate edge ${rawFrom} → ${rawTo}.`)
      continue
    }
    pairs.add(pair)

    const meta = parseDataJson(src.data_json ?? src.dataJson)
    // `dashed` is still accepted from every source: it is what older library files and MICA
    // payloads carry, and a React Flow dump expresses it as a dasharray in `style`.
    const legacyDashed =
      bool(src.dashed) || bool(meta.dashed) || str(src.style)?.includes('dash') === true

    edges.push({
      id: str(src.id) ?? uid('e'),
      source_node_key: from,
      target_node_key: to,
      label: str(src.label),
      weight: edgeWeight(src.weight ?? meta.weight) ?? (legacyDashed ? 'semi' : DEFAULT_EDGE_WEIGHT),
      arrow: edgeArrow(src.arrow ?? meta.arrow) ?? DEFAULT_EDGE_ARROW,
    })
  }

  if (edges.length === 0) {
    warnings.push('No edges were imported — the animation will show unconnected cards.')
  }

  return {
    mindmap: {
      id: uid('mm'),
      name: str(root.name) ?? str(root.title) ?? 'Imported mindmap',
      description: str(root.description) ?? null,
      nodes,
      edges,
      updated_at: new Date().toISOString(),
    },
    format,
    warnings,
  }
}

/** Round-trips to the authoring shape — the compact one, suitable for handing to an AI. */
export function exportAuthoringJson(m: Mindmap): string {
  return JSON.stringify(
    {
      name: m.name,
      description: m.description || undefined,
      nodes: m.nodes.map(n => ({
        key: n.node_key,
        label: n.label,
        icon: n.icon || undefined,
        detail: n.detail || undefined,
        accent: n.accent || undefined,
        hero: n.hero || undefined,
        reserved: n.reserved || undefined,
        tag: n.tag || undefined,
      })),
      edges: m.edges.map(e => ({
        from: e.source_node_key,
        to: e.target_node_key,
        label: e.label || undefined,
        // Defaults stay omitted so a round-trip produces the same terse JSON it came from.
        weight: e.weight && e.weight !== DEFAULT_EDGE_WEIGHT ? e.weight : undefined,
        arrow: e.arrow && e.arrow !== DEFAULT_EDGE_ARROW ? e.arrow : undefined,
      })),
    },
    null,
    2,
  )
}

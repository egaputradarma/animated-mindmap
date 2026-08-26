// Markdown to mindmap.
//
// Inspired by markmap (https://github.com/markmap/markmap), which visualises markdown documents as
// mindmaps. This is a deliberately small parser rather than a dependency: markmap's own pipeline
// pulls in a full markdown-it stack to render rich inline content into foreignObject nodes, none of
// which this app can use — the renderer draws plain strings onto a canvas. Nested headings and list
// items are the only structure that maps onto the model, and that is a few dozen lines.
//
// The point is authoring speed. Nested bullets are far quicker to write, and to dictate to an
// assistant, than the JSON shape — and the structure is legible at a glance in a way JSON is not.
//
// Output is the documented authoring shape from docs/mindmap-schema.md, which is then handed to
// `importMindmap`. Going through the same importer as the paste box means key generation, duplicate
// handling and edge validation cannot drift between the two entry points.

import { importMindmap, type ImportResult } from './importMindmap'
import {
  ACCENT_NAMES,
  EDGE_WEIGHTS,
  type AccentName,
  type EdgeArrow,
  type EdgeSide,
  type EdgeWeight,
} from '../types/mindmap'

/** A node in the authoring shape. Mirrors the JSON documented in docs/mindmap-schema.md. */
interface AuthoringNode {
  key: string
  label: string
  icon?: string
  detail?: string
  accent?: AccentName
  hero?: boolean
  reserved?: boolean
  tag?: string
}

interface AuthoringEdge {
  from: string
  to: string
  weight?: EdgeWeight
  arrow?: EdgeArrow
  source_side?: EdgeSide
  target_side?: EdgeSide
}

export interface AuthoringDoc {
  name: string
  description?: string
  nodes: AuthoringNode[]
  edges: AuthoringEdge[]
}

export interface MarkdownParseResult {
  doc: AuthoringDoc
  warnings: string[]
}

/**
 * Separators between a label and its detail line. An em dash reads naturally in prose; the pipe is
 * there because em dashes are awkward to type. A colon is deliberately NOT a separator — labels like
 * "QA: SQL DB" are common and would be silently split.
 */
const DETAIL_SEPARATOR = /\s+(?:—|\||–)\s+/

/** Leading emoji becomes the node icon. Handles ZWJ sequences and variation selectors. */
const LEADING_EMOJI = /^(\p{Extended_Pictographic}(?:\uFE0F)?(?:\u200D\p{Extended_Pictographic}\uFE0F?)*)\s+/u

const HEADING = /^(#{1,6})\s+(.+?)\s*$/
const BULLET = /^(\s*)[-*+]\s+(.+?)\s*$/
/** Optional modifiers in braces, e.g. `{heavy}` or `{planned} {gold}`. */
const DIRECTIVE = /\{([a-z:]+)\}/gi

interface Modifiers {
  weight?: EdgeWeight
  arrow?: EdgeArrow
  accent?: AccentName
  reserved?: boolean
  hero?: boolean
  sourceSide?: EdgeSide
  targetSide?: EdgeSide
}

/**
 * Pulls `{...}` modifiers out of a line, returning the cleaned text alongside them.
 *
 * Modifiers are optional throughout: plain markdown produces a perfectly good mindmap, and these
 * exist so weight, arrows and the planned/hub flags are reachable without leaving the text box.
 */
function extractModifiers(text: string, warnings: string[]): { text: string; modifiers: Modifiers } {
  const modifiers: Modifiers = {}
  const cleaned = text.replace(DIRECTIVE, (_match, raw: string) => {
    const token = raw.toLowerCase()

    if ((EDGE_WEIGHTS as readonly string[]).includes(token)) {
      modifiers.weight = token as EdgeWeight
      return ''
    }
    if ((ACCENT_NAMES as readonly string[]).includes(token)) {
      modifiers.accent = token as AccentName
      return ''
    }
    switch (token) {
      case 'planned':
      case 'reserved':
        modifiers.reserved = true
        return ''
      case 'hub':
      case 'root':
        modifiers.hero = true
        return ''
      case 'arrow':
      case 'arrow:end':
        modifiers.arrow = 'end'
        return ''
      case 'arrow:start':
        modifiers.arrow = 'start'
        return ''
      case 'arrows':
      case 'arrow:both':
        modifiers.arrow = 'both'
        return ''
      case 'arrow:none':
        modifiers.arrow = 'none'
        return ''
      default: {
        // `from:` and `to:` name the card faces the connection attaches to.
        const side = /^(from|to):(top|right|bottom|left|auto)$/.exec(token)
        if (side) {
          if (side[1] === 'from') modifiers.sourceSide = side[2] as EdgeSide
          else modifiers.targetSide = side[2] as EdgeSide
          return ''
        }
        warnings.push(`Ignored unknown modifier {${raw}}.`)
        return ''
      }
    }
  })

  return { text: cleaned.replace(/\s{2,}/g, ' ').trim(), modifiers }
}

/** Splits one line into the node fields it describes. */
function parseLine(raw: string, warnings: string[]): { node: Omit<AuthoringNode, 'key'>; modifiers: Modifiers } | null {
  const { text, modifiers } = extractModifiers(raw, warnings)
  if (!text) return null

  let remainder = text
  let icon: string | undefined

  const emoji = LEADING_EMOJI.exec(remainder)
  if (emoji) {
    icon = emoji[1]
    remainder = remainder.slice(emoji[0].length)
  }

  const [label, ...rest] = remainder.split(DETAIL_SEPARATOR)
  const detail = rest.join(' ').trim() || undefined
  if (!label?.trim()) return null

  return {
    node: {
      label: label.trim(),
      icon,
      detail,
      accent: modifiers.accent,
      hero: modifiers.hero,
      reserved: modifiers.reserved,
    },
    modifiers,
  }
}

/** One level of the outline being built. */
interface StackEntry {
  key: string
  depth: number
  /** Leading whitespace width for list items; -1 for headings, which nest by level instead. */
  indent: number
  isHeading: boolean
}

/** Tabs count as four columns so mixed indentation still nests predictably. */
const indentWidth = (whitespace: string): number => whitespace.replace(/\t/g, '    ').length

export function markdownToAuthoring(markdown: string, fallbackName = 'Mindmap'): MarkdownParseResult {
  const warnings: string[] = []
  const nodes: AuthoringNode[] = []
  const edges: AuthoringEdge[] = []
  const stack: StackEntry[] = []
  const usedKeys = new Set<string>()

  const keyFor = (label: string): string => {
    const base =
      label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32) || 'node'
    let key = base
    let n = 2
    while (usedKeys.has(key)) key = `${base}-${n++}`
    usedKeys.add(key)
    return key
  }

  // Fenced code blocks are skipped wholesale: a `#` comment or a `-` flag inside one is not outline
  // structure, and treating it as such produces baffling nodes.
  let inFence = false

  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence || !line.trim()) continue
    // Blockquote markers and list checkboxes are noise here, not structure.
    const normalised = line.replace(/^(\s*)>\s?/, '$1').replace(/\[[ xX]\]\s*/, '')

    const heading = HEADING.exec(normalised)
    const bullet = heading ? null : BULLET.exec(normalised)
    if (!heading && !bullet) continue

    const depthHint = heading ? heading[1].length - 1 : null
    const indent = bullet ? indentWidth(bullet[1]) : -1
    const parsed = parseLine(heading ? heading[2] : bullet![2], warnings)
    if (!parsed) continue

    if (heading) {
      // Headings nest by their own level, so unwind to anything shallower.
      while (stack.length > 0 && stack[stack.length - 1].depth >= depthHint!) stack.pop()
    } else {
      // List items nest by indentation, but must never escape the heading that contains them.
      while (stack.length > 0 && !stack[stack.length - 1].isHeading && stack[stack.length - 1].indent >= indent) {
        stack.pop()
      }
    }

    const parent = stack[stack.length - 1]
    const depth = heading ? depthHint! : (parent?.depth ?? -1) + 1
    const key = keyFor(parsed.node.label)

    nodes.push({ key, ...parsed.node })
    if (parent) {
      edges.push({
        from: parent.key,
        to: key,
        weight: parsed.modifiers.weight,
        arrow: parsed.modifiers.arrow,
        source_side: parsed.modifiers.sourceSide,
        target_side: parsed.modifiers.targetSide,
      })
    }

    stack.push({ key, depth, indent, isHeading: Boolean(heading) })
  }

  if (nodes.length === 0) {
    return { doc: { name: fallbackName, nodes: [], edges: [] }, warnings }
  }

  // Anything with no incoming edge is a root. One root is the normal case and becomes the hub;
  // several means the outline has no single top level, so a hub is synthesised to join them —
  // otherwise the layout would render disconnected islands.
  const hasParent = new Set(edges.map(e => e.to))
  const roots = nodes.filter(n => !hasParent.has(n.key))

  let name = fallbackName
  if (roots.length === 1) {
    name = roots[0].label
    if (!nodes.some(n => n.hero)) roots[0].hero = true
  } else {
    const rootKey = keyFor(fallbackName)
    nodes.unshift({ key: rootKey, label: fallbackName, hero: true })
    for (const root of roots) edges.push({ from: rootKey, to: root.key })
    warnings.push(`Found ${roots.length} top-level items, so "${fallbackName}" was added as the hub.`)
  }

  return { doc: { name, nodes, edges }, warnings }
}

/** Parses markdown and runs it through the shared importer. */
export function importMarkdown(markdown: string, fallbackName = 'Mindmap'): ImportResult {
  const { doc, warnings } = markdownToAuthoring(markdown, fallbackName)
  if (doc.nodes.length === 0) {
    throw new Error('No headings or list items found. Use "# Heading" or "- item" lines.')
  }

  const result = importMindmap(JSON.stringify(doc))
  return { ...result, warnings: [...warnings, ...result.warnings] }
}

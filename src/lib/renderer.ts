// Draws one frame of the animation to a 2D canvas.
//
// This is a port of the visual language in `ea-architecture-app/docs/ea-tools-project-
// overview.html` — gradient cards, a dim base wire under a bright coloured one, glowing
// packets riding the wires, a staggered rise-in cascade — from CSS/SVG to canvas 2D.
//
// WHY CANVAS RATHER THAN RASTERISING THE DOM
//
// The obvious alternative was to keep the reference's DOM/SVG technique and screenshot each
// frame with `html-to-image`, which the MICA PNG export already does. Three reasons that does
// not survive contact with an export:
//
//   1. `html-to-image` drops stylesheet-driven SVG presentation when it clones a node. MICA's
//      own `canvasExport.ts` carries a long comment about this: class-styled edges come out as
//      invisible paths and edge labels as black boxes, so the stroke has to be inlined on
//      every element. Animated strokes and `<animateMotion>` make that far worse.
//   2. CSS animation timing is not addressable. You cannot ask the DOM for "the frame at
//      t=0.42" — you can only wait and hope, which gives duplicated and torn frames.
//   3. Rasterising a large DOM takes on the order of a second per frame. A 10s/30fps loop is
//      300 frames.
//
// Drawing from a pure `(state, t) -> pixels` function fixes all three: any frame is
// addressable, output is deterministic and reproducible, and it renders at any resolution.
// The cost is that the reference's CSS had to be hand-ported, which is what this file is.

import { pointAtFraction } from './bezier'
import type { Layout, PlacedEdge, PlacedNode } from './layout'
import { accentColour, mix, rgba, type Theme } from './palette'
import { edgeState, frameState, nodeState, seedFromString, type TimelineOptions } from './timeline'
import { ellipsise, wrapText } from './text'

/** Reference stroke widths, in abstract layout units. Scaled by `layout.scale` when drawn. */
const WIRE_BASE_WIDTH = 5
const WIRE_WIDTH = 2.4
const PACKET_RADIUS = 5.2
const CARD_RADIUS = 12
const RISE_DISTANCE = 14

const FONT_STACK = 'system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'

export interface TitleBlock {
  title: string
  subtitle: string | null
}

export interface RenderOptions {
  theme: Theme
  timeline: TimelineOptions
  /** Null hides the title block entirely; the layout should then reserve no space for it. */
  titleBlock: TitleBlock | null
  /** Vertical band at the top the title block draws into, in px. */
  titleSpace: number
}

export function drawFrame(ctx: CanvasRenderingContext2D, layout: Layout, options: RenderOptions, t: number): void {
  const frame = frameState(t, options.timeline)
  const { theme } = options

  drawBackground(ctx, layout, theme)

  // A single global alpha on the whole composition is what makes `build` mode's fade-out
  // land exactly on the t=0 state. Applying it per element instead would let the background
  // fade too, which would flash.
  ctx.save()
  ctx.globalAlpha = frame.global

  if (options.titleBlock) {
    drawTitleBlock(ctx, layout, options.titleBlock, theme, options.titleSpace, frame.title)
  }

  // Painter's order matches the reference's z-index: wires beneath, cards on top. Packets sit
  // between the two so they slide under a card rather than over it.
  for (const edge of layout.edges) drawWireBase(ctx, edge, layout, theme, t, options.timeline)
  for (const edge of layout.edges) drawWire(ctx, edge, layout, theme, t, options.timeline)
  for (const edge of layout.edges) drawPacket(ctx, edge, layout, theme, t, options.timeline)
  for (const node of layout.nodes) drawCard(ctx, node, layout, theme, t, options.timeline, frame.hubPulse)

  ctx.restore()
}

function drawBackground(ctx: CanvasRenderingContext2D, layout: Layout, theme: Theme): void {
  ctx.save()
  ctx.globalAlpha = 1
  ctx.fillStyle = rgba(theme.bg)
  ctx.fillRect(0, 0, layout.width, layout.height)

  // Centre-weighted vignette. Lifts the hub off a flat backdrop and keeps the corners dark so
  // the signature reads against them.
  const radius = Math.hypot(layout.width, layout.height) * 0.62
  const gradient = ctx.createRadialGradient(
    layout.width / 2,
    layout.height * 0.46,
    0,
    layout.width / 2,
    layout.height * 0.46,
    radius,
  )
  gradient.addColorStop(0, rgba(theme.bgVignette, theme.name === 'dark' ? 0.55 : 0.75))
  gradient.addColorStop(1, rgba(theme.bg, 0))
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, layout.width, layout.height)
  ctx.restore()
}

function drawTitleBlock(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  block: TitleBlock,
  theme: Theme,
  titleSpace: number,
  reveal: number,
): void {
  if (reveal <= 0.001) return

  const titleSize = Math.max(16, titleSpace * 0.34)
  const subtitleSize = titleSize * 0.5
  const centreX = layout.width / 2
  const maxWidth = layout.width * 0.86

  ctx.save()
  ctx.globalAlpha *= reveal
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  // Slides down as it fades in, echoing the cards' rise-in but in the opposite direction so
  // the title reads as a header rather than another node.
  ctx.translate(0, -(1 - reveal) * titleSize * 0.4)

  ctx.font = `650 ${titleSize}px ${FONT_STACK}`
  ctx.fillStyle = rgba(theme.text)
  const title = ellipsise(block.title, maxWidth, text => ctx.measureText(text).width)
  const titleY = titleSpace * 0.52
  ctx.fillText(title, centreX, titleY)

  if (block.subtitle) {
    ctx.font = `450 ${subtitleSize}px ${FONT_STACK}`
    ctx.fillStyle = rgba(theme.textFaint)
    const subtitle = ellipsise(block.subtitle, maxWidth, text => ctx.measureText(text).width)
    ctx.fillText(subtitle, centreX, titleY + subtitleSize * 1.6)
  }
  ctx.restore()
}

/** Traces a curve without stroking it, so callers can vary the dash and stroke settings. */
function tracePath(ctx: CanvasRenderingContext2D, edge: PlacedEdge): void {
  const { p0, c1, c2, p1 } = edge.geom
  ctx.beginPath()
  ctx.moveTo(p0.x, p0.y)
  ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p1.x, p1.y)
}

/**
 * The dim thick stroke every wire sits on (`.wire-base`). It follows the same draw-on
 * progress as the bright wire, otherwise the full-length grey path would be visible from t=0
 * and give away the shape before the reveal.
 */
function drawWireBase(
  ctx: CanvasRenderingContext2D,
  edge: PlacedEdge,
  layout: Layout,
  theme: Theme,
  t: number,
  timeline: TimelineOptions,
): void {
  const state = edgeState(t, edge.order, seedFromString(edge.edge.id), timeline)
  if (state.draw <= 0.001) return

  ctx.save()
  ctx.globalAlpha *= 0.6
  ctx.strokeStyle = rgba(theme.wireBase)
  ctx.lineWidth = WIRE_BASE_WIDTH * layout.scale
  ctx.lineCap = 'round'
  applyDrawOn(ctx, edge, state.draw)
  tracePath(ctx, edge)
  ctx.stroke()
  ctx.restore()
}

function drawWire(
  ctx: CanvasRenderingContext2D,
  edge: PlacedEdge,
  layout: Layout,
  theme: Theme,
  t: number,
  timeline: TimelineOptions,
): void {
  const state = edgeState(t, edge.order, seedFromString(edge.edge.id), timeline)
  if (state.draw <= 0.001) return

  // A dashed edge means "planned, not wired" — it keeps the base stroke and the dash pattern
  // but never gets a bright overlay or a packet, matching `.wire-base.dashed`.
  if (edge.dashed) {
    ctx.save()
    ctx.globalAlpha *= 0.4
    ctx.strokeStyle = rgba(theme.wireBase)
    ctx.lineWidth = WIRE_BASE_WIDTH * layout.scale
    ctx.setLineDash([6 * layout.scale, 7 * layout.scale])
    tracePath(ctx, edge)
    ctx.stroke()
    ctx.restore()
    return
  }

  const colour = accentColour(theme.name, edge.accent)
  ctx.save()
  ctx.globalAlpha *= 0.92
  ctx.strokeStyle = rgba(colour)
  ctx.lineWidth = WIRE_WIDTH * layout.scale
  ctx.lineCap = 'round'
  applyDrawOn(ctx, edge, state.draw)
  tracePath(ctx, edge)
  ctx.stroke()

  if (edge.edge.label) drawEdgeLabel(ctx, edge, layout, theme, state.draw)
  ctx.restore()
}

/**
 * Canvas equivalent of the reference's `stroke-dasharray:1; stroke-dashoffset:1` trick.
 *
 * A dash pattern of [drawn, total] with no offset paints the first `drawn` units and then
 * gaps for a full path length, which is always enough to cover whatever remains. Expressing
 * it this way means no offset bookkeeping and it degenerates correctly at both ends.
 */
function applyDrawOn(ctx: CanvasRenderingContext2D, edge: PlacedEdge, progress: number): void {
  const total = edge.geom.length
  if (progress >= 0.999 || total === 0) {
    ctx.setLineDash([])
    return
  }
  ctx.setLineDash([total * progress, total])
}

function drawEdgeLabel(
  ctx: CanvasRenderingContext2D,
  edge: PlacedEdge,
  layout: Layout,
  theme: Theme,
  progress: number,
): void {
  const label = edge.edge.label
  if (!label || progress < 0.9) return

  const at = pointAtFraction(edge.geom, 0.5)
  const size = Math.max(9, 8.5 * layout.scale)
  ctx.save()
  ctx.setLineDash([])
  // Ramps in over the tail of the draw so the label does not pop before the wire lands.
  ctx.globalAlpha *= Math.min(1, (progress - 0.9) / 0.1)
  ctx.font = `600 ${size}px ${FONT_STACK}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  const padX = size * 0.55
  const padY = size * 0.32
  const width = ctx.measureText(label).width + padX * 2
  const height = size + padY * 2

  // Chip behind the text: an unbacked label over a wire is unreadable.
  ctx.fillStyle = rgba(theme.bg, 0.88)
  ctx.beginPath()
  ctx.roundRect(at.x - width / 2, at.y - height / 2, width, height, height / 2)
  ctx.fill()
  ctx.strokeStyle = rgba(theme.cardBorder, 0.9)
  ctx.lineWidth = Math.max(1, layout.scale * 0.7)
  ctx.stroke()

  ctx.fillStyle = rgba(theme.textFaint)
  ctx.fillText(label, at.x, at.y)
  ctx.restore()
}

function drawPacket(
  ctx: CanvasRenderingContext2D,
  edge: PlacedEdge,
  layout: Layout,
  theme: Theme,
  t: number,
  timeline: TimelineOptions,
): void {
  if (edge.dashed) return
  const state = edgeState(t, edge.order, seedFromString(edge.edge.id), timeline)
  if (state.packet === null) return

  // Keep the packet clear of both cards. Travelling the full 0..1 would bury it under the
  // card art at each end, and the reference gets away with that only because its packets are
  // small relative to the gap.
  const travel = 0.07 + state.packet * 0.86
  const at = pointAtFraction(edge.geom, travel)
  const colour = accentColour(theme.name, edge.accent)

  // Fade at both extremes so the wrap from the far end back to the near end reads as a pulse
  // rather than a jump. Purely a function of phase, so it stays loop-safe.
  const edgeFade = Math.min(1, state.packet / 0.12, (1 - state.packet) / 0.12)

  ctx.save()
  ctx.setLineDash([])
  ctx.globalAlpha *= 0.95 * Math.max(0, edgeFade)
  ctx.shadowColor = rgba(colour, 0.95)
  ctx.shadowBlur = 9 * layout.scale
  ctx.fillStyle = rgba(colour)
  ctx.beginPath()
  ctx.arc(at.x, at.y, PACKET_RADIUS * layout.scale, 0, Math.PI * 2)
  ctx.fill()
  // Second pass deepens the bloom; one pass at high blur washes the core out.
  ctx.fill()
  ctx.restore()
}

function drawCard(
  ctx: CanvasRenderingContext2D,
  node: PlacedNode,
  layout: Layout,
  theme: Theme,
  t: number,
  timeline: TimelineOptions,
  hubPulse: number,
): void {
  const state = nodeState(t, node.order, timeline)
  if (state.appear <= 0.001) return

  const colour = accentColour(theme.name, node.accent)
  const rise = (1 - state.appear) * RISE_DISTANCE * layout.scale
  const left = node.x - node.w / 2
  const top = node.y - node.h / 2 + rise
  const radius = CARD_RADIUS * layout.scale

  ctx.save()
  ctx.setLineDash([])
  ctx.globalAlpha *= state.appear * (node.node.reserved ? 0.62 : 1)

  // ── Body ──
  ctx.save()
  ctx.shadowColor = rgba(theme.shadow, theme.name === 'dark' ? 0.42 : 0.16)
  ctx.shadowBlur = 22 * layout.scale
  ctx.shadowOffsetY = 6 * layout.scale

  if (node.isHub) {
    // The hero's wide accent bloom. Drawn as an extra shadow pass under the fill because
    // canvas has no equivalent of the reference's layered `box-shadow`.
    ctx.shadowColor = rgba(colour, 0.16 + hubPulse * 0.2)
    ctx.shadowBlur = (34 + hubPulse * 20) * layout.scale
    ctx.shadowOffsetY = 0
  }

  const gradient = ctx.createLinearGradient(left, top, left + node.w, top + node.h)
  gradient.addColorStop(0, rgba(theme.cardTop))
  gradient.addColorStop(0.65, rgba(theme.cardBottom))
  gradient.addColorStop(1, rgba(mix(theme.cardBottom, theme.bg, 0.35)))
  ctx.fillStyle = gradient
  ctx.beginPath()
  ctx.roundRect(left, top, node.w, node.h, radius)
  ctx.fill()
  ctx.restore()

  // ── Border ──
  ctx.beginPath()
  ctx.roundRect(left, top, node.w, node.h, radius)
  ctx.lineWidth = Math.max(1, (node.isHub ? 1.6 : 1.1) * layout.scale)
  ctx.strokeStyle = node.isHub ? rgba(colour, 0.85) : rgba(theme.cardBorder)
  if (node.node.reserved) ctx.setLineDash([5 * layout.scale, 4 * layout.scale])
  ctx.stroke()
  ctx.setLineDash([])

  // A slim accent rail on non-hero cards. The reference only colours the border on hover,
  // which a still export cannot express, so the branch colour needs a permanent home.
  if (!node.isHub) {
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(left, top, node.w, node.h, radius)
    ctx.clip()
    ctx.fillStyle = rgba(colour, 0.9)
    ctx.fillRect(left, top, Math.max(2, 3 * layout.scale), node.h)
    ctx.restore()
  }

  drawCardText(ctx, node, theme, top)
  ctx.restore()
}

function drawCardText(ctx: CanvasRenderingContext2D, node: PlacedNode, theme: Theme, top: number): void {
  const centreX = node.x
  const padV = (node.h - contentHeight(node)) / 2
  let y = top + padV
  const inner = node.w - node.fonts.title * 2.4

  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'

  if (node.node.icon) {
    ctx.font = `${node.fonts.icon}px ${FONT_STACK}`
    ctx.fillStyle = rgba(theme.text)
    ctx.fillText(node.node.icon, centreX, y)
    y += node.fonts.icon + 5 * (node.fonts.icon / 21)
  }

  // Re-wrap with real font metrics. The layout pass estimated line counts to size the card;
  // measuring here is what guarantees the drawn text actually fits inside that card.
  ctx.font = `650 ${node.fonts.title}px ${FONT_STACK}`
  const titleLines = wrapText(node.node.label, inner, text => ctx.measureText(text).width, 2)
  ctx.fillStyle = rgba(theme.text)
  for (const line of titleLines) {
    ctx.fillText(line, centreX, y)
    y += node.fonts.title * 1.28
  }

  if (node.node.detail) {
    y += 3
    ctx.font = `450 ${node.fonts.detail}px ${FONT_STACK}`
    const detailLines = wrapText(node.node.detail, inner, text => ctx.measureText(text).width, 3)
    ctx.fillStyle = rgba(theme.textFaint)
    for (const line of detailLines) {
      ctx.fillText(line, centreX, y)
      y += node.fonts.detail * 1.28
    }
  }

  if (node.text.tag) {
    y += 4
    ctx.font = `600 ${node.fonts.tag}px ${FONT_STACK}`
    ctx.fillStyle = rgba(theme.textFaint, 0.85)
    ctx.fillText(node.text.tag.toUpperCase(), centreX, y)
  }
}

/** Height of the drawn content, used to centre it vertically inside the card. */
function contentHeight(node: PlacedNode): number {
  let h = 0
  if (node.node.icon) h += node.fonts.icon + 5 * (node.fonts.icon / 21)
  h += Math.max(1, node.text.titleLines.length) * node.fonts.title * 1.28
  if (node.text.detailLines.length) h += 3 + node.text.detailLines.length * node.fonts.detail * 1.28
  if (node.text.tag) h += 4 + node.fonts.tag * 1.28
  return h
}

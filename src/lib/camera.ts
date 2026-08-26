// Camera movement over the loop.
//
// WHY THIS EXISTS
//
// Without a camera, everything has to fit the frame at once, so legibility is bounded by node count.
// The measurement in examples.test.ts is blunt about it: the 17-stage roadmap renders titles at about
// 4px once LinkedIn scales the image down, against roughly 9px for the 7-phase version.
//
// A camera breaks that ceiling. Instead of shrinking the graph to fit, the view establishes the whole
// map, then moves in on one branch at a time. Cards are drawn at a readable size because only part of
// the graph is on screen at any moment — dense mindmaps become a legible tour rather than an
// illegible poster.
//
// SEAM SAFETY
//
// Same discipline as timeline.ts: the camera must return to exactly where it started, or the loop
// visibly jumps. Stops are traversed in order and the last one eases back to the first, so
// `cameraAt(0)` and `cameraAt(1)` are the same state by construction rather than by tuning.

import { clamp01 } from './bezier'
import type { Layout } from './layout'
import { easeInOutCubic, fract } from './timeline'

export interface CameraState {
  /** Point in canvas px that sits at the centre of the frame. */
  x: number
  y: number
  /** Magnification. 1 means the layout is shown exactly as laid out. */
  zoom: number
}

export interface CameraStop extends CameraState {
  /** Node key this stop frames, or null for the establishing wide shot. Diagnostic only. */
  focus: string | null
}

export type CameraMode = 'fit' | 'tour'

/** Share of each stop's slot spent holding still before moving to the next. */
const HOLD_RATIO = 0.55

/**
 * How much of the frame a branch should occupy when framed. Below 1 so the branch does not sit flush
 * against the edges, and so neighbouring cards stay partly visible for context.
 */
const BRANCH_FILL = 0.82

/** Zoom is clamped: never below the establishing shot, never so far in that context is lost. */
const MIN_ZOOM = 1
const MAX_ZOOM = 3.2

export const wideShot = (layout: Layout): CameraStop => ({
  x: layout.width / 2,
  y: layout.height / 2,
  zoom: 1,
  focus: null,
})

/**
 * Builds the tour: an establishing wide shot, then one stop per branch.
 *
 * Branches are visited in reveal order so the camera follows the same sequence the cascade does,
 * rather than jumping around the graph in whatever order the nodes happen to be stored.
 */
export function buildCameraStops(layout: Layout): CameraStop[] {
  const stops: CameraStop[] = [wideShot(layout)]

  // Group cards by the branch they hang from. The hub belongs to no branch and is visible in the
  // wide shot, so it needs no stop of its own.
  const byBranch = new Map<string, typeof layout.nodes>()
  for (const node of layout.nodes) {
    if (!node.branch) continue
    const existing = byBranch.get(node.branch)
    if (existing) existing.push(node)
    else byBranch.set(node.branch, [node])
  }

  const branchOrder = [...byBranch.keys()].sort((a, b) => {
    const orderOf = (key: string) => layout.nodes.find(n => n.key === key)?.order ?? 0
    return orderOf(a) - orderOf(b)
  })

  for (const branch of branchOrder) {
    const members = byBranch.get(branch)
    if (!members || members.length === 0) continue

    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const node of members) {
      minX = Math.min(minX, node.x - node.w / 2)
      maxX = Math.max(maxX, node.x + node.w / 2)
      minY = Math.min(minY, node.y - node.h / 2)
      maxY = Math.max(maxY, node.y + node.h / 2)
    }

    const spanX = Math.max(1, maxX - minX)
    const spanY = Math.max(1, maxY - minY)
    const zoom = clampZoom(Math.min((layout.width * BRANCH_FILL) / spanX, (layout.height * BRANCH_FILL) / spanY))

    stops.push({ x: (minX + maxX) / 2, y: (minY + maxY) / 2, zoom, focus: branch })
  }

  return stops
}

/**
 * Camera state at normalised loop time `t`.
 *
 * Each stop owns an equal slice of the loop: hold, then ease across to the next. The final stop eases
 * back to the first, which is what closes the seam.
 */
export function cameraAt(stops: CameraStop[], t: number): CameraState {
  if (stops.length === 0) return { x: 0, y: 0, zoom: 1 }
  if (stops.length === 1) return { ...stops[0] }

  const time = fract(Number.isFinite(t) ? t : 0)
  const slot = 1 / stops.length
  const index = Math.min(stops.length - 1, Math.floor(time / slot))
  const local = (time - index * slot) / slot

  const from = stops[index]
  if (local <= HOLD_RATIO) return { x: from.x, y: from.y, zoom: from.zoom }

  // Wrapping to stop 0 on the last slot is what makes t=1 identical to t=0.
  const to = stops[(index + 1) % stops.length]
  const progress = easeInOutCubic(clamp01((local - HOLD_RATIO) / (1 - HOLD_RATIO)))

  return {
    x: lerp(from.x, to.x, progress),
    y: lerp(from.y, to.y, progress),
    // Zoom interpolates geometrically. Linear interpolation between, say, 1x and 3x spends most of
    // the move already zoomed in, which reads as a lurch rather than a smooth push.
    zoom: from.zoom * Math.pow(to.zoom / from.zoom, progress),
  }
}

/**
 * Applies the camera to a context whose origin is the top-left of the canvas.
 *
 * Order matters: move the focal point to the frame centre, scale about that centre, then shift back.
 * Doing it in the other order scales the offset too and the camera drifts as it zooms.
 */
export function applyCamera(
  ctx: CanvasRenderingContext2D,
  camera: CameraState,
  width: number,
  height: number,
): void {
  ctx.translate(width / 2, height / 2)
  ctx.scale(camera.zoom, camera.zoom)
  ctx.translate(-camera.x, -camera.y)
}

const clampZoom = (v: number): number =>
  !Number.isFinite(v) ? MIN_ZOOM : v < MIN_ZOOM ? MIN_ZOOM : v > MAX_ZOOM ? MAX_ZOOM : v

const lerp = (a: number, b: number, amount: number): number => a + (b - a) * amount

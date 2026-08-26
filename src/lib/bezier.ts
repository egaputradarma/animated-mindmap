// Cubic Bézier helpers for the connector wires.
//
// Why arc-length sampling rather than just using the Bézier parameter t: a packet advanced
// by equal steps of t speeds up and slows down along a curved path, because t is not
// proportional to distance. On a gentle arc that reads as a slight stutter, and with several
// packets at different speeds it looks like a bug. Sampling a cumulative-length table once
// per curve and looking distance up in it gives constant visual speed for a fixed cost.
//
// The same table supplies the total length, which the draw-on animation needs to convert a
// 0..1 progress into a dash offset.

export interface Point {
  x: number
  y: number
}

export interface Cubic {
  p0: Point
  c1: Point
  c2: Point
  p1: Point
}

/** Samples per curve for the length table. 24 is well past the point of visible error for
 *  the shallow arcs this app draws, and keeps the table small enough to build per frame. */
const SAMPLES = 24

/**
 * Below this, a curve counts as having no length at all.
 *
 * Summing 24 segments between identical points does not give exactly 0 — the Bézier basis
 * weights sum to 1 only up to floating-point rounding, leaving noise around 1e-14. Without a
 * threshold, a degenerate curve (both endpoints on the same spot, which happens when two nodes
 * land on top of each other) reports a non-zero length, skips the zero-length guard, and then
 * divides by a near-zero LUT span.
 */
const LENGTH_EPSILON = 1e-9

export interface CurveGeometry extends Cubic {
  length: number
  /** Cumulative arc length at each of SAMPLES+1 evenly spaced t values. */
  lut: Float64Array
}

export function cubicAt(c: Cubic, t: number): Point {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const d = 3 * u * t * t
  const e = t * t * t
  return {
    x: a * c.p0.x + b * c.c1.x + d * c.c2.x + e * c.p1.x,
    y: a * c.p0.y + b * c.c1.y + d * c.c2.y + e * c.p1.y,
  }
}

export function measure(c: Cubic): CurveGeometry {
  const lut = new Float64Array(SAMPLES + 1)
  let previous = c.p0
  let total = 0
  for (let i = 1; i <= SAMPLES; i++) {
    const point = cubicAt(c, i / SAMPLES)
    total += Math.hypot(point.x - previous.x, point.y - previous.y)
    lut[i] = total
    previous = point
  }
  return { ...c, length: total < LENGTH_EPSILON ? 0 : total, lut }
}

/**
 * Point at `fraction` of the curve's *length* (not its parameter). Linear interpolation
 * inside a LUT segment is accurate enough because the segments are short and the curvature
 * is low.
 */
export function pointAtFraction(g: CurveGeometry, fraction: number): Point {
  if (g.length < LENGTH_EPSILON) return g.p0
  const target = clamp01(fraction) * g.length
  const lut = g.lut

  // Small, sorted table — a linear scan beats a binary search's branching here.
  let i = 1
  while (i < lut.length - 1 && lut[i] < target) i++

  const spanStart = lut[i - 1]
  const spanLength = lut[i] - spanStart
  const withinSpan = spanLength > 0 ? (target - spanStart) / spanLength : 0
  return cubicAt(g, (i - 1 + withinSpan) / SAMPLES)
}

/**
 * Unit direction of travel at `fraction` along the curve.
 *
 * Uses a central difference over arc-length points rather than the analytic derivative: the
 * derivative is in Bézier-parameter space, so at a given *distance* along the curve it points the
 * right way but would need renormalising against the arc-length mapping anyway. Sampling either
 * side is simpler and already consistent with how everything else here is positioned.
 */
export function tangentAtFraction(g: CurveGeometry, fraction: number): Point {
  const step = 0.02
  const before = pointAtFraction(g, clamp01(fraction - step))
  const after = pointAtFraction(g, clamp01(fraction + step))
  const dx = after.x - before.x
  const dy = after.y - before.y
  const length = Math.hypot(dx, dy)
  // Degenerate curve: any direction is as wrong as any other, so pick one deterministically.
  return length === 0 ? { x: 1, y: 0 } : { x: dx / length, y: dy / length }
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Fraction along the curve at which it clears `rect`, searching from `from` toward `to`.
 *
 * Wires are laid out centre-to-centre and cards are painted over them, so the first and last
 * stretch of every curve is hidden. Anything that must stay visible — an arrowhead, a travelling
 * packet — has to start beyond the card's edge. Sampling for the crossing adapts to each card's
 * real size, which a fixed inset cannot: the same 7% that clears a small card leaves an arrowhead
 * buried under a large one.
 */
export function fractionOutside(g: CurveGeometry, rect: Rect, from: number, to: number): number {
  const STEPS = 48
  for (let i = 0; i <= STEPS; i++) {
    const fraction = from + ((to - from) * i) / STEPS
    const point = pointAtFraction(g, fraction)
    if (!containsPoint(rect, point)) return fraction
  }
  // Entirely inside — overlapping cards, or a curve shorter than the card. Fall back to the
  // midpoint so callers still get something drawable.
  return (from + to) / 2
}

const containsPoint = (rect: Rect, p: Point): boolean =>
  p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height

/**
 * One end of a connection: where it attaches, and which way it should leave.
 *
 * A null `normal` means "no opinion" — the curve is then shaped from the straight line between the
 * two ends, which is the radial-layout default. A non-null normal is the outward direction of a
 * named card face, and the curve is made to depart along it.
 */
export interface Anchor {
  point: Point
  normal: Point | null
}

/**
 * Curve between two anchors.
 *
 * With no normals this is exactly `arcBetween`: a consistent one-sided bow, which is what gives the
 * reference diagram its pinwheel look.
 *
 * With a normal, that end's control point is pushed straight out along the card face instead. This
 * is what makes a connection leaving the right edge actually head right before turning, rather than
 * cutting diagonally back across its own card. Mixed ends work too — the named end departs along
 * its face while the other is still shaped from the line.
 */
export function curveBetweenAnchors(a: Anchor, b: Anchor, curvature: number): Cubic {
  if (!a.normal && !b.normal) return arcBetween(a.point, b.point, curvature)

  const dx = b.point.x - a.point.x
  const dy = b.point.y - a.point.y
  const span = Math.hypot(dx, dy)
  if (span === 0) return { p0: a.point, c1: a.point, c2: b.point, p1: b.point }

  // Control arm length, scaled by span so short links stay tight and long ones sweep. The floor
  // matters: without it a very short link's departure direction is invisible and the curve reads as
  // a straight diagonal.
  const arm = Math.max(span * 0.42, 28)

  // Used for whichever end has no named side, so it keeps its previous shape.
  const bow = curvature * span
  const nx = dy / span
  const ny = -dx / span

  const c1 = a.normal
    ? { x: a.point.x + a.normal.x * arm, y: a.point.y + a.normal.y * arm }
    : { x: a.point.x + dx / 3 + nx * bow, y: a.point.y + dy / 3 + ny * bow }

  const c2 = b.normal
    ? { x: b.point.x + b.normal.x * arm, y: b.point.y + b.normal.y * arm }
    : { x: b.point.x - dx / 3 + nx * bow, y: b.point.y - dy / 3 + ny * bow }

  return { p0: a.point, c1, c2, p1: b.point }
}

/**
 * A cubic bowing consistently to one side of the straight line A→B. Offsetting both control
 * points on the same side by a fraction of the span gives every spoke the same handedness,
 * which is what produces the pinwheel look of the reference diagram instead of a mess of
 * arcs curving in random directions.
 */
export function arcBetween(a: Point, b: Point, curvature: number): Cubic {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const span = Math.hypot(dx, dy)
  if (span === 0) return { p0: a, c1: a, c2: b, p1: b }

  // Unit normal, rotated -90° from the direction vector.
  const nx = dy / span
  const ny = -dx / span
  const bow = curvature * span

  return {
    p0: a,
    c1: { x: a.x + dx / 3 + nx * bow, y: a.y + dy / 3 + ny * bow },
    c2: { x: a.x + (dx * 2) / 3 + nx * bow, y: a.y + (dy * 2) / 3 + ny * bow },
    p1: b,
  }
}

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

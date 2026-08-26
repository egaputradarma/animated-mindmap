// Align and distribute, for the "As arranged" layout mode.
//
// Radial mode computes positions, so it needs none of this. Manual mode is hand-arranged, and doing
// that by dragging alone makes tidy rows and columns very hard — hence the alignment operations every
// design tool has.
//
// Pure functions over boxes, returning only the positions that changed. Keeping the geometry out of the
// editor component means it can be tested directly, and "distribute evenly" is exactly the kind of
// arithmetic that is easy to get subtly wrong and hard to eyeball.
//
// Boxes use TOP-LEFT origin, matching React Flow and the `position_x/position_y` stored on a node.

export interface Box {
  key: string
  /** Top-left corner. */
  x: number
  y: number
  width: number
  height: number
}

export interface Placement {
  x: number
  y: number
}

export type AlignMode = 'left' | 'center-x' | 'right' | 'top' | 'middle' | 'bottom'
export type DistributeAxis = 'horizontal' | 'vertical'

const left = (b: Box) => b.x
const right = (b: Box) => b.x + b.width
const top = (b: Box) => b.y
const bottom = (b: Box) => b.y + b.height


/**
 * Aligns boxes to the outer bound of the selection.
 *
 * The reference is taken from the selection's own extent rather than a fixed guide, which is what makes
 * these idempotent — aligning left twice leaves everything where it was.
 *
 * Centre and middle use the midpoint of the whole selection, not the average of the individual centres.
 * The average would drift toward whichever side happens to hold more boxes.
 */
export function alignBoxes(boxes: Box[], mode: AlignMode): Map<string, Placement> {
  const result = new Map<string, Placement>()
  if (boxes.length < 2) return result

  const minLeft = Math.min(...boxes.map(left))
  const maxRight = Math.max(...boxes.map(right))
  const minTop = Math.min(...boxes.map(top))
  const maxBottom = Math.max(...boxes.map(bottom))
  const midX = (minLeft + maxRight) / 2
  const midY = (minTop + maxBottom) / 2

  for (const box of boxes) {
    let { x, y } = box

    switch (mode) {
      case 'left':
        x = minLeft
        break
      case 'right':
        x = maxRight - box.width
        break
      case 'center-x':
        x = midX - box.width / 2
        break
      case 'top':
        y = minTop
        break
      case 'bottom':
        y = maxBottom - box.height
        break
      case 'middle':
        y = midY - box.height / 2
        break
    }

    result.set(box.key, { x: round(x), y: round(y) })
  }

  return result
}

/**
 * Spreads boxes so the GAPS between them are equal, holding the two outermost in place.
 *
 * Equal gaps rather than equal centre spacing: with cards of differing size, evenly spaced centres
 * leave visibly uneven space between the boxes themselves, which is the thing the eye actually reads.
 *
 * The gap can come out negative when the boxes are collectively wider than the span they occupy. That
 * is left alone deliberately — the span is what the user established by placing the outer two, and
 * silently widening it would move a box they did not select to move.
 */
export function distributeBoxes(boxes: Box[], axis: DistributeAxis): Map<string, Placement> {
  const result = new Map<string, Placement>()
  if (boxes.length < 3) return result

  const horizontal = axis === 'horizontal'
  const sizeOf = (b: Box) => (horizontal ? b.width : b.height)
  const startOf = (b: Box) => (horizontal ? b.x : b.y)

  const ordered = [...boxes].sort((a, b) => startOf(a) - startOf(b))
  const first = ordered[0]
  const last = ordered[ordered.length - 1]

  const spanStart = startOf(first)
  const spanEnd = startOf(last) + sizeOf(last)
  const occupied = ordered.reduce((sum, b) => sum + sizeOf(b), 0)
  const gap = (spanEnd - spanStart - occupied) / (ordered.length - 1)

  let cursor = spanStart
  for (const box of ordered) {
    result.set(box.key, {
      x: round(horizontal ? cursor : box.x),
      y: round(horizontal ? box.y : cursor),
    })
    cursor += sizeOf(box) + gap
  }

  return result
}

/**
 * Which axis a selection is more spread along.
 *
 * Used to pick a sensible default for "distribute": a row of cards should space horizontally, a column
 * vertically, and guessing from the extent is more reliable than asking.
 */
export function dominantAxis(boxes: Box[]): DistributeAxis {
  if (boxes.length < 2) return 'horizontal'

  const spanX = Math.max(...boxes.map(right)) - Math.min(...boxes.map(left))
  const spanY = Math.max(...boxes.map(bottom)) - Math.min(...boxes.map(top))
  return spanX >= spanY ? 'horizontal' : 'vertical'
}

/**
 * Lays boxes out on a grid, preserving reading order.
 *
 * A fallback for a selection that has drifted into no particular shape, where align and distribute have
 * nothing sensible to work with. Row-major by current position, so what was roughly top-left stays
 * top-left.
 */
export function gridBoxes(boxes: Box[], columns: number, gapX = 40, gapY = 40): Map<string, Placement> {
  const result = new Map<string, Placement>()
  if (boxes.length < 2 || columns < 1) return result

  // Rows are grouped by vertical band first so existing structure is respected, then ordered
  // left-to-right within the row.
  const ordered = [...boxes].sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y))

  const originX = Math.min(...boxes.map(left))
  const originY = Math.min(...boxes.map(top))
  const cellWidth = Math.max(...boxes.map(b => b.width)) + gapX
  const cellHeight = Math.max(...boxes.map(b => b.height)) + gapY

  ordered.forEach((box, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    result.set(box.key, { x: round(originX + column * cellWidth), y: round(originY + row * cellHeight) })
  })

  return result
}

/**
 * Pushes overlapping boxes apart until every pair clears `gap`.
 *
 * Iterative pairwise relaxation rather than a single analytical pass. Separating one pair can push a box
 * into a third, so the whole set has to be revisited; a handful of passes settles any realistic mindmap,
 * and the iteration cap stops a pathological arrangement from spinning.
 *
 * Each overlapping pair is separated along its axis of *least* penetration, which moves cards the
 * shortest distance and so preserves the arrangement the user made. Pushing along the centre-to-centre
 * line instead would look more physical but drags cards diagonally out of rows they were aligned into.
 *
 * `pinned` keys are held still. Anchoring the hub keeps the graph spreading outward from its centre
 * rather than the whole cluster drifting.
 */
export function separateBoxes(
  boxes: Box[],
  gap: number,
  pinned: ReadonlySet<string> = new Set(),
  iterations = 24,
): Map<string, Placement> {
  if (boxes.length < 2) return new Map()

  // Worked on a copy so the caller's boxes are untouched.
  const working = boxes.map(b => ({ ...b }))
  let moved = false

  for (let pass = 0; pass < iterations; pass++) {
    let collided = false

    for (let i = 0; i < working.length; i++) {
      for (let j = i + 1; j < working.length; j++) {
        const a = working[i]
        const b = working[j]

        // Penetration depth on each axis, treating `gap` as part of each box's footprint.
        const overlapX = (a.width + b.width) / 2 + gap - Math.abs(centreOf(a).x - centreOf(b).x)
        const overlapY = (a.height + b.height) / 2 + gap - Math.abs(centreOf(a).y - centreOf(b).y)
        if (overlapX <= 0 || overlapY <= 0) continue

        collided = true
        moved = true

        const aPinned = pinned.has(a.key)
        const bPinned = pinned.has(b.key)
        if (aPinned && bPinned) continue

        // Split the correction between the two, unless one is pinned and cannot move.
        const shareA = aPinned ? 0 : bPinned ? 1 : 0.5
        const shareB = 1 - shareA

        if (overlapX < overlapY) {
          const direction = centreOf(a).x <= centreOf(b).x ? -1 : 1
          a.x += direction * overlapX * shareA
          b.x -= direction * overlapX * shareB
        } else {
          const direction = centreOf(a).y <= centreOf(b).y ? -1 : 1
          a.y += direction * overlapY * shareA
          b.y -= direction * overlapY * shareB
        }
      }
    }

    if (!collided) break
  }

  if (!moved) return new Map()
  return new Map(working.map(b => [b.key, { x: round(b.x), y: round(b.y) }]))
}

const centreOf = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })

/** Whole pixels: fractional node positions serve no purpose and make saved JSON noisy. */
const round = (v: number): number => Math.round(v)

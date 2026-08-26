// Tests for align and distribute.
//
// This is arithmetic that looks obviously right and is easy to get subtly wrong — an off-by-half-a-width
// on right alignment, or distribute spacing centres instead of gaps. Both produce output that looks
// almost correct, which is exactly the kind of bug that survives eyeballing.

import { describe, expect, it } from 'vitest'
import { alignBoxes, distributeBoxes, dominantAxis, gridBoxes, type Box } from './arrange'

/** Deliberately different sizes: uniform boxes hide the difference between edge and centre alignment. */
const boxes = (): Box[] => [
  { key: 'a', x: 0, y: 0, width: 100, height: 40 },
  { key: 'b', x: 250, y: 90, width: 60, height: 80 },
  { key: 'c', x: 500, y: 200, width: 140, height: 20 },
]

const at = (result: Map<string, { x: number; y: number }>, key: string) => result.get(key)!

describe('align', () => {
  it('aligns left edges to the leftmost box', () => {
    const result = alignBoxes(boxes(), 'left')
    for (const key of ['a', 'b', 'c']) expect(at(result, key).x).toBe(0)
  })

  it('aligns right edges, accounting for differing widths', () => {
    const result = alignBoxes(boxes(), 'right')
    // Rightmost edge is c at 500+140 = 640. Each box's x must place its own right edge there.
    expect(at(result, 'a').x).toBe(540)
    expect(at(result, 'b').x).toBe(580)
    expect(at(result, 'c').x).toBe(500)
  })

  it('aligns horizontal centres on the selection midpoint', () => {
    const result = alignBoxes(boxes(), 'center-x')
    // Extent is 0..640, so the midpoint is 320.
    for (const key of ['a', 'b', 'c']) {
      const box = boxes().find(b => b.key === key)!
      expect(at(result, key).x + box.width / 2).toBeCloseTo(320, 6)
    }
  })

  it('aligns top edges to the topmost box', () => {
    const result = alignBoxes(boxes(), 'top')
    for (const key of ['a', 'b', 'c']) expect(at(result, key).y).toBe(0)
  })

  it('aligns bottom edges, accounting for differing heights', () => {
    const result = alignBoxes(boxes(), 'bottom')
    // Lowest edge is c at 200+20 = 220.
    expect(at(result, 'a').y).toBe(180)
    expect(at(result, 'b').y).toBe(140)
    expect(at(result, 'c').y).toBe(200)
  })

  it('aligns vertical middles on the selection midpoint', () => {
    const result = alignBoxes(boxes(), 'middle')
    for (const key of ['a', 'b', 'c']) {
      const box = boxes().find(b => b.key === key)!
      expect(at(result, key).y + box.height / 2).toBeCloseTo(110, 6)
    }
  })

  it('leaves the other axis untouched', () => {
    const result = alignBoxes(boxes(), 'left')
    expect(at(result, 'b').y).toBe(90)
    expect(at(result, 'c').y).toBe(200)
  })

  it('is idempotent', () => {
    const once = alignBoxes(boxes(), 'right')
    const moved = boxes().map(b => ({ ...b, ...at(once, b.key) }))
    const twice = alignBoxes(moved, 'right')

    for (const key of ['a', 'b', 'c']) expect(at(twice, key)).toEqual(at(once, key))
  })

  it('does nothing with fewer than two boxes', () => {
    expect(alignBoxes([], 'left').size).toBe(0)
    expect(alignBoxes([boxes()[0]], 'left').size).toBe(0)
  })
})

describe('distribute', () => {
  it('equalises the gaps between boxes, not their centres', () => {
    const result = distributeBoxes(boxes(), 'horizontal')
    const sized = boxes()

    const placed = ['a', 'b', 'c'].map(key => {
      const box = sized.find(b => b.key === key)!
      return { left: at(result, key).x, right: at(result, key).x + box.width }
    })

    const gapOne = placed[1].left - placed[0].right
    const gapTwo = placed[2].left - placed[1].right
    // Equal gaps is the property; equal centre spacing would leave these different because the widths
    // differ (100, 60, 140).
    expect(gapTwo).toBeCloseTo(gapOne, 6)
  })

  it('holds the outermost two boxes in place', () => {
    const result = distributeBoxes(boxes(), 'horizontal')
    expect(at(result, 'a').x).toBe(0)
    expect(at(result, 'c').x).toBe(500)
  })

  it('distributes vertically without touching x', () => {
    const result = distributeBoxes(boxes(), 'vertical')

    expect(at(result, 'a').y).toBe(0)
    expect(at(result, 'c').y).toBe(200)
    expect(at(result, 'b').x).toBe(250)
  })

  it('orders by position, not by array order', () => {
    const shuffled = [boxes()[2], boxes()[0], boxes()[1]]
    const result = distributeBoxes(shuffled, 'horizontal')

    // 'a' is leftmost by position and must stay pinned, despite arriving second in the array.
    expect(at(result, 'a').x).toBe(0)
    expect(at(result, 'c').x).toBe(500)
  })

  it('needs at least three boxes to mean anything', () => {
    expect(distributeBoxes(boxes().slice(0, 2), 'horizontal').size).toBe(0)
  })

  it('still produces a result when boxes are wider than their span', () => {
    // Collectively 300 wide inside a 150 span: the gap goes negative and they overlap. Preserving the
    // span is the intent, so this must not throw or silently widen the selection.
    const cramped: Box[] = [
      { key: 'a', x: 0, y: 0, width: 100, height: 10 },
      { key: 'b', x: 20, y: 0, width: 100, height: 10 },
      { key: 'c', x: 50, y: 0, width: 100, height: 10 },
    ]
    const result = distributeBoxes(cramped, 'horizontal')

    expect(result.size).toBe(3)
    expect(at(result, 'a').x).toBe(0)
    expect(at(result, 'c').x).toBe(50)
  })
})

describe('dominant axis', () => {
  it('picks horizontal for a row', () => {
    expect(
      dominantAxis([
        { key: 'a', x: 0, y: 0, width: 50, height: 50 },
        { key: 'b', x: 400, y: 10, width: 50, height: 50 },
      ]),
    ).toBe('horizontal')
  })

  it('picks vertical for a column', () => {
    expect(
      dominantAxis([
        { key: 'a', x: 0, y: 0, width: 50, height: 50 },
        { key: 'b', x: 10, y: 400, width: 50, height: 50 },
      ]),
    ).toBe('vertical')
  })
})

describe('grid', () => {
  it('lays boxes out row-major from the selection origin', () => {
    const result = gridBoxes(boxes(), 2, 10, 10)

    // Widest is 140 and tallest 80, so cells are 150 x 90 from origin (0, 0).
    expect(at(result, 'a')).toEqual({ x: 0, y: 0 })
    expect(at(result, 'b')).toEqual({ x: 150, y: 0 })
    expect(at(result, 'c')).toEqual({ x: 0, y: 90 })
  })

  it('preserves reading order rather than array order', () => {
    const shuffled = [boxes()[2], boxes()[1], boxes()[0]]
    const result = gridBoxes(shuffled, 3, 10, 10)

    // Sorted by y then x, so 'a' (top-left) takes the first cell.
    expect(at(result, 'a').x).toBeLessThan(at(result, 'b').x)
    expect(at(result, 'b').x).toBeLessThan(at(result, 'c').x)
  })
})

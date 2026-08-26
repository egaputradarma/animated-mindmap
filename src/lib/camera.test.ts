// Tests for the camera tour.
//
// The load-bearing property is seam closure: a camera that does not return exactly to its starting
// position makes the loop jump, and unlike a subtle easing flaw it is impossible to miss. The rest
// check that stops actually frame their branch and that zoom stays within useful bounds.

import { describe, expect, it } from 'vitest'
import { buildCameraStops, cameraAt, wideShot } from './camera'
import { layoutMindmap, type LayoutOptions } from './layout'
import type { Mindmap } from '../types/mindmap'

/** Hub with three branches, one of which has children — enough for a multi-stop tour. */
function branched(): Mindmap {
  return {
    id: 'm',
    name: 'Branched',
    description: null,
    nodes: [
      { node_key: 'hub', label: 'Hub', position_x: 0, position_y: 0, hero: true },
      { node_key: 'a', label: 'Alpha', position_x: 200, position_y: 0 },
      { node_key: 'a1', label: 'Alpha one', position_x: 380, position_y: -80 },
      { node_key: 'a2', label: 'Alpha two', position_x: 380, position_y: 80 },
      { node_key: 'b', label: 'Beta', position_x: -200, position_y: 0 },
      { node_key: 'c', label: 'Gamma', position_x: 0, position_y: 220 },
    ],
    edges: [
      { id: 'e1', source_node_key: 'hub', target_node_key: 'a' },
      { id: 'e2', source_node_key: 'a', target_node_key: 'a1' },
      { id: 'e3', source_node_key: 'a', target_node_key: 'a2' },
      { id: 'e4', source_node_key: 'hub', target_node_key: 'b' },
      { id: 'e5', source_node_key: 'hub', target_node_key: 'c' },
    ],
    updated_at: new Date().toISOString(),
  }
}

const options = (): LayoutOptions => ({
  width: 1200,
  height: 1200,
  mode: 'radial',
  spread: 1,
  nodeGap: 18,
  preventOverlap: true,
  uniformCardHeight: false,
  curvature: 0.14,
  padding: 66,
  titleSpace: 156,
  footerSpace: 110,
})

const layoutOf = () => layoutMindmap(branched(), options())

describe('camera tour', () => {
  it('opens on a wide shot and adds one stop per branch', () => {
    const layout = layoutOf()
    const stops = buildCameraStops(layout)

    // Wide shot plus Alpha, Beta, Gamma.
    expect(stops).toHaveLength(4)
    expect(stops[0].focus).toBeNull()
    expect(stops[0].zoom).toBe(1)
    expect(stops.slice(1).map(s => s.focus)).toEqual(['a', 'b', 'c'])
  })

  it('visits branches in reveal order', () => {
    const layout = layoutOf()
    const stops = buildCameraStops(layout)

    const orderOf = (key: string) => layout.nodes.find(n => n.key === key)!.order
    const visited = stops.slice(1).map(s => orderOf(s.focus!))
    // Following the cascade's own sequence, rather than storage order, keeps the tour coherent.
    expect(visited).toEqual([...visited].sort((a, b) => a - b))
  })

  it('returns exactly to its starting state at the seam', () => {
    const stops = buildCameraStops(layoutOf())

    const start = cameraAt(stops, 0)
    const end = cameraAt(stops, 1)

    expect(end.x).toBeCloseTo(start.x, 9)
    expect(end.y).toBeCloseTo(start.y, 9)
    expect(end.zoom).toBeCloseTo(start.zoom, 9)
  })

  it('approaches the start state continuously as t approaches 1', () => {
    const stops = buildCameraStops(layoutOf())
    const start = cameraAt(stops, 0)
    const nearEnd = cameraAt(stops, 1 - 1 / 300)

    // A discontinuity here would read as a jolt on the final frame even though t=1 matches t=0.
    expect(Math.hypot(nearEnd.x - start.x, nearEnd.y - start.y)).toBeLessThan(30)
    expect(Math.abs(nearEnd.zoom - start.zoom)).toBeLessThan(0.05)
  })

  it('holds still for part of each stop rather than panning constantly', () => {
    const stops = buildCameraStops(layoutOf())
    const slot = 1 / stops.length

    // Early in a slot the camera should be parked on that stop.
    const a = cameraAt(stops, slot * 0.1)
    const b = cameraAt(stops, slot * 0.4)
    expect(a.x).toBeCloseTo(b.x, 6)
    expect(a.zoom).toBeCloseTo(b.zoom, 6)
  })

  it('frames each branch within the viewport at its stop', () => {
    const layout = layoutOf()
    const stops = buildCameraStops(layout)

    for (const stop of stops.slice(1)) {
      const members = layout.nodes.filter(n => n.branch === stop.focus)
      expect(members.length).toBeGreaterThan(0)

      for (const node of members) {
        // Screen position under this stop's transform.
        const sx = (node.x - stop.x) * stop.zoom + layout.width / 2
        const sy = (node.y - stop.y) * stop.zoom + layout.height / 2
        expect(sx).toBeGreaterThanOrEqual(0)
        expect(sx).toBeLessThanOrEqual(layout.width)
        expect(sy).toBeGreaterThanOrEqual(0)
        expect(sy).toBeLessThanOrEqual(layout.height)
      }
    }
  })

  it('magnifies branches, which is the whole point', () => {
    const stops = buildCameraStops(layoutOf())
    const branchStops = stops.slice(1)

    // If zoom never exceeded 1 the tour would achieve nothing over a fixed view.
    expect(Math.max(...branchStops.map(s => s.zoom))).toBeGreaterThan(1)
    for (const stop of branchStops) {
      expect(stop.zoom).toBeGreaterThanOrEqual(1)
      expect(stop.zoom).toBeLessThanOrEqual(3.2)
    }
  })

  it('degenerates safely for a hub with no branches', () => {
    const solo: Mindmap = {
      id: 's',
      name: 'Solo',
      description: null,
      nodes: [{ node_key: 'only', label: 'Only', position_x: 0, position_y: 0 }],
      edges: [],
      updated_at: new Date().toISOString(),
    }
    const layout = layoutMindmap(solo, options())
    const stops = buildCameraStops(layout)

    expect(stops).toHaveLength(1)
    // A single stop must not divide by zero or drift.
    expect(cameraAt(stops, 0.42)).toEqual({ x: stops[0].x, y: stops[0].y, zoom: 1, focus: null })
  })

  it('wraps times outside [0,1)', () => {
    const stops = buildCameraStops(layoutOf())
    expect(cameraAt(stops, 2.25).x).toBeCloseTo(cameraAt(stops, 0.25).x, 9)
  })

  it('wide shot centres the frame at zoom 1', () => {
    const layout = layoutOf()
    const shot = wideShot(layout)
    expect(shot.x).toBeCloseTo(layout.width / 2, 6)
    expect(shot.zoom).toBe(1)
  })
})

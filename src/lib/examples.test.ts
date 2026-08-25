// Validates the shipped example mindmaps in examples/.
//
// Two things worth guarding. First, that the files actually import — a malformed example is worse
// than none, because it teaches the wrong schema. Second, and the reason this file exists at all:
// that the "overview" variant is genuinely legible in a social feed while the "full" 17-stage
// variant is measurably not.
//
// LinkedIn renders a feed image at roughly 40% of its exported width on desktop, so a title drawn
// at 20px in a 1200px export lands near 8px for the reader. That is the floor these numbers are
// checked against — it turns "keep it under 12 nodes" from advice in a doc into an assertion.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { importMindmap } from './importMindmap'
import { layoutMindmap, type LayoutOptions } from './layout'

const EXAMPLES_DIR = join(process.cwd(), 'examples')

const load = (file: string) => importMindmap(readFileSync(join(EXAMPLES_DIR, file), 'utf8'))

/** Mirrors what buildComposition derives for a 1:1 export with a title and a signature band. */
const squarePreset = (): LayoutOptions => ({
  width: 1200,
  height: 1200,
  mode: 'radial',
  spread: 1,
  curvature: 0.14,
  padding: 1200 * 0.055,
  titleSpace: 1200 * 0.13,
  footerSpace: 1200 * 0.055 + 1200 * 0.034 * 1.7,
})

/** Effective on-screen size for a LinkedIn desktop feed reader. */
const FEED_SCALE = 0.4
/** Below roughly this, body text stops being comfortably readable on a phone or in-feed. */
const READABLE_FLOOR_PX = 7.5

describe('example mindmaps', () => {
  it('overview imports as the authoring shape with no warnings', () => {
    const { mindmap, format, warnings } = load('it-ops-roadmap-overview.json')

    expect(format).toBe('authoring')
    expect(warnings).toEqual([])
    expect(mindmap.nodes).toHaveLength(8)
    expect(mindmap.edges).toHaveLength(7)
    expect(mindmap.nodes.filter(n => n.hero)).toHaveLength(1)
  })

  it('full roadmap imports with all seventeen stages', () => {
    const { mindmap, format, warnings } = load('it-ops-roadmap-full.json')

    expect(format).toBe('authoring')
    expect(warnings).toEqual([])
    // Hub plus 17 stages.
    expect(mindmap.nodes).toHaveLength(18)
    expect(mindmap.edges).toHaveLength(17)
    expect(mindmap.nodes.filter(n => n.hero)).toHaveLength(1)
  })

  it('keeps the dashed "not yet there" edge on both variants', () => {
    for (const file of ['it-ops-roadmap-overview.json', 'it-ops-roadmap-full.json']) {
      const { mindmap } = load(file)
      expect(mindmap.edges.filter(e => e.dashed)).toHaveLength(1)
      expect(mindmap.nodes.filter(n => n.reserved)).toHaveLength(1)
    }
  })

  it('overview stays readable at feed scale', () => {
    const { mindmap } = load('it-ops-roadmap-overview.json')
    const layout = layoutMindmap(mindmap, squarePreset())

    const smallestTitle = Math.min(...layout.nodes.map(n => n.fonts.title))
    const effective = smallestTitle * FEED_SCALE

    // Surfaced so the actual number is visible in the run, not just pass/fail.
    console.info(`overview: title ${smallestTitle.toFixed(1)}px -> ${effective.toFixed(1)}px in-feed`)
    expect(effective).toBeGreaterThan(READABLE_FLOOR_PX)
  })

  it('demonstrates why the full roadmap is a poster, not a feed graphic', () => {
    const { mindmap } = load('it-ops-roadmap-full.json')
    const layout = layoutMindmap(mindmap, squarePreset())

    const smallestTitle = Math.min(...layout.nodes.map(n => n.fonts.title))
    const effective = smallestTitle * FEED_SCALE

    console.info(`full:     title ${smallestTitle.toFixed(1)}px -> ${effective.toFixed(1)}px in-feed`)
    // Asserting the limitation rather than the capability: 17 spokes on one ring cannot be read
    // in a feed. If a future layout change made this pass, the guidance in docs/mindmap-schema.md
    // and the existence of the overview variant would both need revisiting.
    expect(effective).toBeLessThan(READABLE_FLOOR_PX)
  })

  it('fits both variants inside the drawable box', () => {
    for (const file of ['it-ops-roadmap-overview.json', 'it-ops-roadmap-full.json']) {
      const { mindmap } = load(file)
      const options = squarePreset()
      const layout = layoutMindmap(mindmap, options)

      for (const node of layout.nodes) {
        expect(node.x - node.w / 2).toBeGreaterThanOrEqual(options.padding - 1)
        expect(node.x + node.w / 2).toBeLessThanOrEqual(options.width - options.padding + 1)
        expect(node.y - node.h / 2).toBeGreaterThanOrEqual(options.padding + options.titleSpace - 1)
        expect(node.y + node.h / 2).toBeLessThanOrEqual(
          options.height - options.padding - options.footerSpace + 1,
        )
      }
    }
  })
})

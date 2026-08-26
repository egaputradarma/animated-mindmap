// Tests for palette mapping and dithering.
//
// The claim being checked is specific: on a smooth gradient quantised to a small palette, error
// diffusion should reproduce the *local average* colour far more accurately than nearest-colour
// mapping does. That is what "less banding" actually means perceptually — per-pixel error goes up,
// because pixels are deliberately pushed to the wrong side to carry error, but averaged over a small
// block the result lands much closer to the original.
//
// Measuring block error rather than eyeballing a screenshot is what makes this assertable at all.

import { describe, expect, it } from 'vitest'
import type { Palette } from 'gifenc'
import { mapToPalette } from './dither'

/** Horizontal greyscale ramp — the pattern that bands worst against a coarse palette. */
function greyGradient(width: number, height: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = Math.round((x / (width - 1)) * 255)
      const p = (y * width + x) * 4
      data[p] = value
      data[p + 1] = value
      data[p + 2] = value
      data[p + 3] = 255
    }
  }
  return data
}

/** Deliberately coarse: 5 grey steps, so a 256-level ramp has to be approximated. */
const COARSE_GREYS: Palette = [
  [0, 0, 0],
  [64, 64, 64],
  [128, 128, 128],
  [192, 192, 192],
  [255, 255, 255],
]

/**
 * Mean absolute error of block-averaged luminance. Blocks are where dithering wins: it trades
 * per-pixel accuracy for accuracy of the local mean.
 */
function blockError(
  original: Uint8ClampedArray,
  indices: Uint8Array,
  palette: Palette,
  width: number,
  height: number,
  block: number,
): number {
  let total = 0
  let blocks = 0

  for (let by = 0; by + block <= height; by += block) {
    for (let bx = 0; bx + block <= width; bx += block) {
      let wanted = 0
      let got = 0
      for (let y = by; y < by + block; y++) {
        for (let x = bx; x < bx + block; x++) {
          wanted += original[(y * width + x) * 4]
          got += palette[indices[y * width + x]][0]
        }
      }
      const pixels = block * block
      total += Math.abs(wanted / pixels - got / pixels)
      blocks++
    }
  }

  return blocks === 0 ? 0 : total / blocks
}

describe('palette mapping', () => {
  const width = 96
  const height = 32

  it('returns one index per pixel, all within the palette', () => {
    const data = greyGradient(width, height)
    const indices = mapToPalette(data, width, height, COARSE_GREYS, 'floyd-steinberg')

    expect(indices).toHaveLength(width * height)
    for (const index of indices) expect(index).toBeLessThan(COARSE_GREYS.length)
  })

  it('reproduces local average colour far better than nearest-colour mapping', () => {
    const data = greyGradient(width, height)

    const plain = mapToPalette(data, width, height, COARSE_GREYS, 'none')
    const dithered = mapToPalette(data, width, height, COARSE_GREYS, 'floyd-steinberg')

    const plainError = blockError(data, plain, COARSE_GREYS, width, height, 4)
    const ditheredError = blockError(data, dithered, COARSE_GREYS, width, height, 4)

    // Surfaced so the actual improvement is visible in the run rather than just pass/fail.
    console.info(`4x4 block error: nearest ${plainError.toFixed(1)} -> dithered ${ditheredError.toFixed(1)}`)
    expect(ditheredError).toBeLessThan(plainError * 0.35)
  })

  it('uses more of the palette on a gradient than nearest-colour mapping does', () => {
    const data = greyGradient(width, height)

    const plain = new Set(mapToPalette(data, width, height, COARSE_GREYS, 'none'))
    const dithered = new Set(mapToPalette(data, width, height, COARSE_GREYS, 'floyd-steinberg'))

    // Not a quality metric on its own, but it demonstrates the mechanism: neighbouring entries are
    // mixed to hit shades the palette cannot represent directly.
    expect(dithered.size).toBeGreaterThanOrEqual(plain.size)
  })

  it('is deterministic, so re-encoding the same frame is reproducible', () => {
    const data = greyGradient(width, height)
    const first = mapToPalette(data, width, height, COARSE_GREYS, 'floyd-steinberg')
    const second = mapToPalette(data, width, height, COARSE_GREYS, 'floyd-steinberg')

    expect(Array.from(first)).toEqual(Array.from(second))
  })

  it('reduces to nearest-colour mapping at zero strength', () => {
    const data = greyGradient(width, height)
    const plain = mapToPalette(data, width, height, COARSE_GREYS, 'none')
    const zeroStrength = mapToPalette(data, width, height, COARSE_GREYS, 'floyd-steinberg', 0)

    expect(Array.from(zeroStrength)).toEqual(Array.from(plain))
  })

  it('picks exact palette entries when the image only contains them', () => {
    // A flat fill on a colour the palette holds exactly must come back untouched — dithering should
    // never add noise where there is no error to diffuse.
    const flat = new Uint8ClampedArray(width * height * 4)
    for (let i = 0; i < width * height; i++) {
      flat[i * 4] = 128
      flat[i * 4 + 1] = 128
      flat[i * 4 + 2] = 128
      flat[i * 4 + 3] = 255
    }

    const indices = mapToPalette(flat, width, height, COARSE_GREYS, 'floyd-steinberg')
    expect(new Set(indices)).toEqual(new Set([2]))
  })

  it('handles a single-colour palette without looping forever', () => {
    const data = greyGradient(16, 4)
    const indices = mapToPalette(data, 16, 4, [[10, 20, 30]], 'floyd-steinberg')

    expect(indices).toHaveLength(64)
    expect(new Set(indices)).toEqual(new Set([0]))
  })
})

// Error-diffusion dithering for the GIF palette mapping step.
//
// WHY THIS EXISTS
//
// GIF allows 256 colours per frame. This design is mostly flat cards, which quantise fine — but the
// background is a radial gradient and the packets have soft glows, and those are exactly what banding
// destroys: a smooth ramp collapses into visible stepped bands.
//
// gifenc's own documentation is upfront that it has no dithering support and is best suited to flat
// vector graphics rather than material needing careful colour handling. Its `applyPalette` picks the
// nearest palette entry per pixel and discards the error.
//
// gifski solves this properly with cross-frame palettes and temporal dithering, and produces far
// better GIFs — but it is AGPL-3.0-or-later, which would make the whole app AGPL and, being the
// network variant, oblige anyone served the app to be offered its source. That is a licensing
// decision, not a technical one, so this takes the licence-clean path instead: keep gifenc (MIT) for
// quantisation and diffuse the quantisation error here.
//
// HOW
//
// Floyd–Steinberg error diffusion. Each pixel takes the nearest palette colour, and the difference
// between what was wanted and what was used is pushed onto neighbours not yet visited. Fine-grained
// noise replaces coarse banding, which the eye integrates back into the intended shade.
//
// Two details that matter:
//
//   * Serpentine traversal. Scanning every row left-to-right pushes error consistently rightward and
//     leaves diagonal streaks. Alternating direction per row cancels that bias.
//   * A nearest-colour cache. A 256-entry palette searched per pixel is 256 distance computations
//     across ~1.5M pixels per frame, times hundreds of frames. Results are memoised against the
//     pixel's high 5 bits per channel, which is where almost all the cost goes.

import type { Palette } from 'gifenc'

/** Bits per channel kept in the cache key. 5 gives 32768 buckets — small, and a high hit rate. */
const CACHE_BITS = 5
const CACHE_SIZE = 1 << (CACHE_BITS * 3)
const CACHE_SHIFT = 8 - CACHE_BITS

export type DitherMode = 'none' | 'floyd-steinberg'

/**
 * Maps RGBA pixels onto `palette`, returning one index per pixel.
 *
 * With `mode: 'none'` this is a plain nearest-colour mapping, equivalent to gifenc's `applyPalette`
 * but sharing the same cache. `strength` scales the diffused error: 1 is full Floyd–Steinberg, lower
 * values trade some banding back for less visible noise.
 */
export function mapToPalette(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  palette: Palette,
  mode: DitherMode = 'floyd-steinberg',
  strength = 1,
): Uint8Array {
  const indices = new Uint8Array(width * height)
  const cache = new Int16Array(CACHE_SIZE).fill(-1)

  // Flattened palette in plain arrays: indexing three typed arrays beats reaching into nested
  // JS arrays inside the innermost loop.
  const count = palette.length
  const pr = new Float32Array(count)
  const pg = new Float32Array(count)
  const pb = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    pr[i] = palette[i][0]
    pg[i] = palette[i][1]
    pb[i] = palette[i][2]
  }

  const nearest = (r: number, g: number, b: number): number => {
    const key =
      ((r >> CACHE_SHIFT) << (CACHE_BITS * 2)) | ((g >> CACHE_SHIFT) << CACHE_BITS) | (b >> CACHE_SHIFT)
    const cached = cache[key]
    if (cached >= 0) return cached

    let best = 0
    let bestDistance = Infinity
    for (let i = 0; i < count; i++) {
      // Squared Euclidean distance in RGB. Not perceptually uniform, but it is what gifenc's own
      // quantiser optimised the palette for, so matching it keeps the two consistent.
      const dr = r - pr[i]
      const dg = g - pg[i]
      const db = b - pb[i]
      const distance = dr * dr + dg * dg + db * db
      if (distance < bestDistance) {
        bestDistance = distance
        best = i
      }
    }
    cache[key] = best
    return best
  }

  if (mode === 'none') {
    for (let p = 0, i = 0; i < indices.length; i++, p += 4) {
      indices[i] = nearest(rgba[p], rgba[p + 1], rgba[p + 2])
    }
    return indices
  }

  // Only two rows of error are ever live, so this holds the current row and the next one rather than
  // a full-frame buffer — which at 1200x1200 would be 17 MB of Float32 per channel.
  let errorR = new Float32Array(width + 2)
  let errorG = new Float32Array(width + 2)
  let errorB = new Float32Array(width + 2)
  let nextR = new Float32Array(width + 2)
  let nextG = new Float32Array(width + 2)
  let nextB = new Float32Array(width + 2)

  for (let y = 0; y < height; y++) {
    const leftToRight = y % 2 === 0
    const start = leftToRight ? 0 : width - 1
    const step = leftToRight ? 1 : -1

    for (let n = 0; n < width; n++) {
      const x = start + n * step
      const p = (y * width + x) * 4
      const e = x + 1 // error arrays are padded by one on each side

      const r = clamp255(rgba[p] + errorR[e])
      const g = clamp255(rgba[p + 1] + errorG[e])
      const b = clamp255(rgba[p + 2] + errorB[e])

      const index = nearest(r, g, b)
      indices[y * width + x] = index

      const dr = (r - pr[index]) * strength
      const dg = (g - pg[index]) * strength
      const db = (b - pb[index]) * strength

      // Floyd–Steinberg weights, mirrored when travelling right-to-left.
      const ahead = leftToRight ? 1 : -1
      spread(errorR, errorG, errorB, e + ahead, dr, dg, db, 7 / 16)
      spread(nextR, nextG, nextB, e - ahead, dr, dg, db, 3 / 16)
      spread(nextR, nextG, nextB, e, dr, dg, db, 5 / 16)
      spread(nextR, nextG, nextB, e + ahead, dr, dg, db, 1 / 16)
    }

    // Recycle: the finished row's buffer becomes the next "next row", zeroed.
    const spentR = errorR
    const spentG = errorG
    const spentB = errorB
    errorR = nextR
    errorG = nextG
    errorB = nextB
    spentR.fill(0)
    spentG.fill(0)
    spentB.fill(0)
    nextR = spentR
    nextG = spentG
    nextB = spentB
  }

  return indices
}

function spread(
  r: Float32Array,
  g: Float32Array,
  b: Float32Array,
  at: number,
  dr: number,
  dg: number,
  db: number,
  weight: number,
): void {
  // Padding means only the true frame edges fall outside, and error there is simply dropped.
  if (at < 0 || at >= r.length) return
  r[at] += dr * weight
  g[at] += dg * weight
  b[at] += db * weight
}

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v)

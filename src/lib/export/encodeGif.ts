// Animated GIF encoding.
//
// GIF is the format LinkedIn autoplays as an *image* — no play button, no video analytics —
// which is why it is here despite being a poor fit technically. Two constraints shape
// everything below.
//
// COLOUR. GIF allows 256 colours per frame. The dark card gradients and packet glows in this
// design are exactly the content that banding hurts most. Quantising each frame independently
// gives the best per-frame fidelity but makes the palette shift frame to frame, which reads as
// a shimmer across flat areas — far more objectionable than banding. So a single global
// palette is sampled across the loop and reused, trading a little accuracy for stability.
//
// TIMING. Frame delays are stored in centiseconds. 30fps is 3.33cs, which rounds to 3cs and
// plays at 33.3fps — the loop still closes cleanly, it just runs ~11% fast. Any fps dividing
// 100 (20, 25, 50) avoids the drift entirely, hence the default of 25.

import { GIFEncoder, quantize } from 'gifenc'
import type { Composition } from '../composition'
import { mapToPalette, type DitherMode } from './dither'
import { createFrameCanvas, frameCount, shouldYield, yieldToBrowser, type EncodeSettings, type ProgressFn } from './frames'

/** Frames sampled to build the global palette. Spread across the loop, not clustered at the start. */
const PALETTE_SAMPLES = 10
/** gifenc's fastest quantiser format that still handles gradients acceptably. */
const PALETTE_FORMAT = 'rgb565'

export interface GifOptions {
  /**
   * `floyd-steinberg` diffuses quantisation error, which is what keeps the background gradient and
   * the packet glows from banding. Costs roughly 2-3x the encode time; see dither.ts.
   */
  dither: DitherMode
  /** 0..1. Scales the diffused error, trading banding against visible noise. */
  ditherStrength: number
}

export const DEFAULT_GIF_OPTIONS: GifOptions = { dither: 'floyd-steinberg', ditherStrength: 0.9 }

export interface GifResult {
  blob: Blob
  width: number
  height: number
  frames: number
  /** Actual delay written per frame, in centiseconds. */
  delayCentiseconds: number
}

export async function encodeGif(
  composition: Composition,
  settings: EncodeSettings,
  onProgress?: ProgressFn,
  options: GifOptions = DEFAULT_GIF_OPTIONS,
): Promise<GifResult> {
  const total = frameCount(settings)
  const frame = createFrameCanvas(composition, settings.maxSide)
  const { width, height } = frame

  // ── Pass 1: global palette ──
  // Concatenating samples into one buffer and quantising once gives a palette that covers the
  // whole loop. Quantising a single frame instead would miss colours that only appear later —
  // in `build` mode the first frame is an empty background, so sampling it alone would yield a
  // palette of two greys.
  onProgress?.({ value: 0, label: 'Sampling colours…' })
  const sampleCount = Math.min(PALETTE_SAMPLES, total)
  const samples: Uint8ClampedArray[] = []
  for (let s = 0; s < sampleCount; s++) {
    // Bias sampling into the built-up part of the loop, where nearly all the colour lives.
    const t = total === 1 ? 0 : (0.25 + (s / Math.max(1, sampleCount - 1)) * 0.7) % 1
    frame.drawAt(t)
    samples.push(frame.ctx.getImageData(0, 0, width, height).data)
    if (shouldYield(s)) await yieldToBrowser()
  }

  const merged = new Uint8ClampedArray(samples.reduce((n, s) => n + s.length, 0))
  let offset = 0
  for (const s of samples) {
    merged.set(s, offset)
    offset += s.length
  }
  const palette = quantize(merged, 256, { format: PALETTE_FORMAT })

  // ── Pass 2: encode ──
  const gif = GIFEncoder()
  const delayCentiseconds = Math.max(2, Math.round(100 / settings.fps))
  const delayMs = delayCentiseconds * 10

  const label = options.dither === 'none' ? 'Encoding GIF' : 'Encoding GIF (dithered)'

  for (let i = 0; i < total; i++) {
    frame.drawAt(i / total)
    const { data } = frame.ctx.getImageData(0, 0, width, height)
    // Replaces gifenc's `applyPalette`, which has no dithering. Same palette, same nearest-colour
    // metric — the difference is that the quantisation error is diffused rather than discarded.
    const indexed = mapToPalette(data, width, height, palette, options.dither, options.ditherStrength)

    // Only the first frame carries the palette; gifenc then writes it as the global colour
    // table and later frames reference it. Repeating it per frame would add a local table to
    // every single frame for no visual gain.
    gif.writeFrame(indexed, width, height, i === 0 ? { palette, delay: delayMs } : { delay: delayMs })

    onProgress?.({ value: (i + 1) / total, label: `${label} · frame ${i + 1}/${total}` })
    if (shouldYield(i)) await yieldToBrowser()
  }

  gif.finish()

  return {
    blob: new Blob([gif.bytesView() as unknown as BlobPart], { type: 'image/gif' }),
    width,
    height,
    frames: total,
    delayCentiseconds,
  }
}

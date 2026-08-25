// Shared frame-generation plumbing for every exporter.
//
// Frame `i` of `n` is sampled at `t = i / n`, deliberately never at t = 1. The loop's closing
// step is the cut from frame n-1 back to frame 0, so sampling t=1 would emit a duplicate of
// frame 0 and stall the loop for one frame tick. This is also why `frameCount` matters more
// than duration: it is the actual quantisation of the timeline.

import type { Composition } from '../composition'

export interface EncodeSettings {
  fps: number
  durationSeconds: number
  /** Longest side of the output. Frames are rendered at composition size then scaled to fit. */
  maxSide: number
}

export interface EncodeProgress {
  /** 0..1 across the whole job, including any encoder flush. */
  value: number
  label: string
}

export type ProgressFn = (progress: EncodeProgress) => void

export const frameCount = (settings: EncodeSettings): number =>
  Math.max(1, Math.round(settings.fps * settings.durationSeconds))

/**
 * Output dimensions after honouring `maxSide`, kept even because H.264 requires even
 * dimensions and an odd width silently fails to configure on some encoders.
 */
export function outputSize(composition: Composition, maxSide: number): { width: number; height: number } {
  const longest = Math.max(composition.width, composition.height)
  const scale = Math.min(1, maxSide / longest)
  return {
    width: makeEven(composition.width * scale),
    height: makeEven(composition.height * scale),
  }
}

const makeEven = (v: number) => {
  const rounded = Math.max(2, Math.round(v))
  return rounded % 2 === 0 ? rounded : rounded - 1
}

export interface FrameCanvas {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  width: number
  height: number
  /** Renders composition time `t` into the canvas at output resolution. */
  drawAt: (t: number) => void
}

/**
 * A canvas at output size that renders the composition scaled to fit.
 *
 * Scaling via a transform rather than rendering at composition size and downsampling
 * afterwards keeps strokes and text crisp — the renderer draws hairlines at the target
 * resolution instead of having them averaged away by a resample.
 */
export function createFrameCanvas(composition: Composition, maxSide: number): FrameCanvas {
  const { width, height } = outputSize(composition, maxSide)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  // `alpha: false` lets the compositor skip per-pixel blending; every frame is fully opaque
  // because the renderer always paints a background first.
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('Could not get a 2D canvas context.')

  const scale = width / composition.width

  return {
    canvas,
    ctx,
    width,
    height,
    drawAt(t: number) {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, width, height)
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
      composition.render(ctx, t)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
    },
  }
}

/**
 * Hands control back to the browser so progress UI can paint mid-encode.
 *
 * `setTimeout(0)` rather than a microtask or `requestAnimationFrame`: a microtask would not
 * let the renderer run at all, and rAF is throttled to ~0 in a background tab, which would
 * stall an export the moment the user switches away.
 */
export const yieldToBrowser = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

/** Yield roughly every 8 frames — often enough to keep the bar moving, rare enough to not dominate. */
export const shouldYield = (index: number): boolean => index % 8 === 7

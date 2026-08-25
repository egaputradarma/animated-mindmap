// The animation as a pure function of normalised loop time.
//
// Everything the renderer draws is derived from `t ∈ [0, 1)` and nothing else — no elapsed
// wall time, no frame counter, no mutable state between frames. That single constraint is
// what makes the export correct: frame k is `state(k / frameCount)`, so encoding 300 frames
// offline produces exactly what playback shows, and re-encoding is reproducible.
//
// SEAMLESS LOOPING
//
// The requirement is `state(1) === state(0)`, because a GIF or MP4 loop cuts straight from
// the last frame back to the first. Two rules get us there, and every animated quantity in
// this file obeys one of them:
//
//   Rule A — return to the start value. In `build` mode the reveal runs forward, holds, then
//            fades back out, so at t→1 every opacity and progress is 0, which is exactly the
//            t=0 state.
//   Rule B — cycle an integer number of times. Anything continuous (packets, the hub's glow
//            pulse) is a function of `frac(t * n + offset)` for integer `n`, so it lands back
//            on its starting phase at t=1.
//
// The reference document violates Rule B: its packets use durations of 2.2s–3.8s against no
// particular loop length, which is fine for a page that never loops but would tear visibly in
// an exported GIF. Desynchronising packets *and* keeping them seamless means varying their
// integer cycle counts, never their fractional speed — see `packetCyclesFor`.

import { clamp01 } from './bezier'

export type LoopMode = 'build' | 'flow'

export interface TimelineOptions {
  mode: LoopMode
  /** Highest reveal slot, from the layout. 0 means a single node. */
  lastOrder: number
  /** Base number of times a packet traverses its wire per loop. Must be a positive integer. */
  packetCycles: number
}

/** Per-node animated state at a given time. */
export interface NodeState {
  /** 0 = absent, 1 = fully drawn. Drives opacity and the rise-in offset together. */
  appear: number
}

/** Per-edge animated state at a given time. */
export interface EdgeState {
  /** Fraction of the wire drawn, from the source end. */
  draw: number
  /** Position of the travelling packet along the wire, or null when it should not be drawn. */
  packet: number | null
}

export interface FrameState {
  /** Multiplies everything, including the title and the signature. */
  global: number
  /** Title block reveal, 0..1. */
  title: number
  /** Extra glow on the hub card, 0..1, breathing across the loop. */
  hubPulse: number
}

// Build-mode phase boundaries, in normalised loop time.
const REVEAL_START = 0.03
const REVEAL_END = 0.55
/** How long one card takes to rise in, as a share of the loop. */
const NODE_DURATION = 0.1
/** How long one wire takes to draw. */
const EDGE_DURATION = 0.09
/** A wire starts once its later endpoint is most of the way in. */
const EDGE_LAG = 0.06
const FADE_START = 0.88

export function frameState(t: number, options: TimelineOptions): FrameState {
  const time = wrap(t)

  if (options.mode === 'flow') {
    return {
      global: 1,
      title: 1,
      // Rule B: one full cosine cycle per loop.
      hubPulse: 0.5 - Math.cos(time * Math.PI * 2) * 0.5,
    }
  }

  // Rule A: fade the whole frame back to nothing so t=1 matches t=0.
  const global = time < FADE_START ? 1 : 1 - easeInOutCubic((time - FADE_START) / (1 - FADE_START))

  return {
    global,
    title: smoothstep(0.02, 0.14, time),
    hubPulse: 0.5 - Math.cos(time * Math.PI * 2) * 0.5,
  }
}

export function nodeState(t: number, order: number, options: TimelineOptions): NodeState {
  if (options.mode === 'flow') return { appear: 1 }

  const start = nodeStart(order, options.lastOrder)
  return { appear: easeOutCubic(smoothstep(start, start + NODE_DURATION, wrap(t))) }
}

export function edgeState(t: number, order: number, edgeSeed: number, options: TimelineOptions): EdgeState {
  const time = wrap(t)
  const cycles = packetCyclesFor(edgeSeed, options.packetCycles)
  const offset = hashToUnit(edgeSeed)

  // Rule B: integer `cycles` means frac() returns to `offset` at t=1.
  const packetPhase = fract(time * cycles + offset)

  if (options.mode === 'flow') return { draw: 1, packet: packetPhase }

  const start = nodeStart(order, options.lastOrder) + EDGE_LAG
  const draw = easeOutCubic(smoothstep(start, start + EDGE_DURATION, time))

  // Hiding the packet until the wire is nearly complete stops it flying through empty space
  // ahead of the stroke that is supposed to carry it.
  return { draw, packet: draw > 0.85 ? packetPhase : null }
}

/**
 * When card `order` begins rising in. Slots are spread across the reveal window, leaving room
 * for the last one to finish before the window closes.
 */
function nodeStart(order: number, lastOrder: number): number {
  if (lastOrder <= 0) return REVEAL_START
  const span = Math.max(0, REVEAL_END - NODE_DURATION - REVEAL_START)
  return REVEAL_START + (span * Math.min(order, lastOrder)) / lastOrder
}

/**
 * Per-edge traversal count. Varying the *integer* count (rather than the speed) is what lets
 * packets run at visibly different rates while every one of them still completes a whole
 * number of trips per loop. Clamped to at least 1 so a packet always moves.
 */
export function packetCyclesFor(seed: number, base: number): number {
  const spread = [0, 1, -1, 2][Math.abs(seed) % 4]
  return Math.max(1, Math.round(base) + spread)
}

/** Deterministic 0..1 from an integer seed, used for packet phase offsets. */
export function hashToUnit(seed: number): number {
  let h = (seed | 0) + 0x9e3779b9
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad)
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

/** Stable seed from an edge id so packet phases survive reloads and re-exports. */
export function seedFromString(input: string): number {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h | 0
}

export const fract = (v: number) => v - Math.floor(v)

/** Normalises any real time into [0,1), so callers may pass t=1 or t=2.5 safely. */
export const wrap = (t: number) => (Number.isFinite(t) ? fract(t) : 0)

export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0
  const v = clamp01((x - edge0) / (edge1 - edge0))
  return v * v * (3 - 2 * v)
}

export const easeOutCubic = (v: number) => 1 - Math.pow(1 - clamp01(v), 3)

export const easeInOutCubic = (v: number) => {
  const x = clamp01(v)
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
}

/**
 * A good still frame: deep into the hold phase, where the graph is fully drawn but the fade
 * has not started. Used for the PNG poster and the editor thumbnail.
 */
export const POSTER_TIME = 0.75

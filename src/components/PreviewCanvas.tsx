// Live preview of the composition.
//
// Renders through the exact same `composition.render(ctx, t)` the encoders call, at a smaller
// resolution. That is what makes the preview trustworthy: there is no second drawing path that
// could disagree with the exported file.

import { useEffect, useRef } from 'react'
import type { Composition } from '../lib/composition'

export interface PreviewCanvasProps {
  composition: Composition
  /** Wall-clock seconds for one loop. Only affects playback speed, never the frame content. */
  durationSeconds: number
  playing: boolean
  /** When set, pins the preview to this normalised time and ignores `playing`. */
  scrubTime: number | null
  /** Longest side in device px. Kept modest — this repaints every frame. */
  maxSide?: number
  onTimeChange?: (t: number) => void
}

export default function PreviewCanvas({
  composition,
  durationSeconds,
  playing,
  scrubTime,
  maxSide = 720,
  onTimeChange,
}: PreviewCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // Held in a ref, not state: advancing playback must not re-render React 30 times a second.
  const timeRef = useRef(0)
  const frameRef = useRef<number | null>(null)
  const onTimeChangeRef = useRef(onTimeChange)
  onTimeChangeRef.current = onTimeChange

  const aspect = composition.width / composition.height
  const width = Math.round(aspect >= 1 ? maxSide : maxSide * aspect)
  const height = Math.round(aspect >= 1 ? maxSide / aspect : maxSide)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return

    const scale = width / composition.width
    const paint = (t: number) => {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, width, height)
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
      composition.render(ctx, t)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
    }

    // Scrubbing is a one-shot paint; no animation loop should be running.
    if (scrubTime !== null) {
      timeRef.current = scrubTime
      paint(scrubTime)
      return
    }

    if (!playing) {
      paint(timeRef.current)
      return
    }

    // Anchor the start so resuming continues from the current position instead of restarting.
    let previous = performance.now()
    const step = (now: number) => {
      const delta = (now - previous) / 1000
      previous = now
      timeRef.current = (timeRef.current + delta / Math.max(0.1, durationSeconds)) % 1
      paint(timeRef.current)
      onTimeChangeRef.current?.(timeRef.current)
      frameRef.current = requestAnimationFrame(step)
    }
    frameRef.current = requestAnimationFrame(step)

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
  }, [composition, durationSeconds, playing, scrubTime, width, height])

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className="h-auto w-full rounded-lg shadow-2xl ring-1 ring-ink-700"
      style={{ aspectRatio: `${composition.width} / ${composition.height}` }}
      role="img"
      aria-label="Animated mindmap preview"
    />
  )
}

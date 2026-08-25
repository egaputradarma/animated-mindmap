// Still-frame PNG export.
//
// Serves two jobs: a poster image for a LinkedIn post that would rather be a static graphic,
// and the thumbnails on the mindmap list. Both want the same thing — the loop sampled at
// POSTER_TIME, where the graph is fully drawn and the fade has not begun.

import type { Composition } from '../composition'
import { POSTER_TIME } from '../timeline'
import { createFrameCanvas } from './frames'

export interface PngResult {
  blob: Blob
  dataUrl: string
  width: number
  height: number
}

export async function encodePng(composition: Composition, maxSide: number, t = POSTER_TIME): Promise<PngResult> {
  const frame = createFrameCanvas(composition, maxSide)
  frame.drawAt(t)

  const blob = await new Promise<Blob>((resolve, reject) => {
    frame.canvas.toBlob(
      result => (result ? resolve(result) : reject(new Error('Canvas could not produce a PNG.'))),
      'image/png',
    )
  })

  return {
    blob,
    dataUrl: frame.canvas.toDataURL('image/png'),
    width: frame.width,
    height: frame.height,
  }
}

/**
 * Small data-URL still for the mindmap list. JPEG rather than PNG, and deliberately tiny:
 * these are held in localStorage alongside the mindmaps, where PNG at any useful size would
 * eat the quota within a handful of entries.
 */
export function renderThumbnail(composition: Composition, maxSide = 320): string {
  const frame = createFrameCanvas(composition, maxSide)
  frame.drawAt(POSTER_TIME)
  return frame.canvas.toDataURL('image/jpeg', 0.72)
}

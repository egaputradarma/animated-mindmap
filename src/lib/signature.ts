// Signature/watermark compositing.
//
// The mark is baked into every exported frame rather than overlaid once, because a GIF has no
// concept of a static overlay and an MP4 would need a filter pass. Drawing it per frame also
// means it fades with the loop in `build` mode instead of hanging on a black screen.
//
// Sizing is proportional to the canvas, never absolute, so the same settings hold at 1080px
// and 1920px. `signatureRect` is deliberately pure and canvas-free: "the mark is always fully
// inside the frame with at least the requested inset" is the one property here worth testing
// directly, and it should be testable without a DOM.

import { rgba, type Theme } from './palette'

export type SignatureCorner = 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right'

export interface SignatureOptions {
  corner: SignatureCorner
  /** Inset from both edges, as a fraction of the canvas's shorter side. */
  insetRatio: number
  /** Mark height as a fraction of canvas height. */
  heightRatio: number
  opacity: number
  /** Optional text beside the mark. Also used as the fallback when no image is available. */
  caption: string | null
}

export const DEFAULT_SIGNATURE: SignatureOptions = {
  // public/brand/README.md documents bottom-left, so that is the default here.
  corner: 'bottom-left',
  insetRatio: 0.034,
  heightRatio: 0.055,
  opacity: 0.92,
  caption: null,
}

export interface SignatureAsset {
  image: CanvasImageSource
  /**
   * The opaque region of the source bitmap — what actually gets drawn.
   *
   * Exported logos routinely carry a wide transparent margin, and it is usually not even
   * symmetric. Both marks in public/brand/ fill about 62% of their file's width and 66% of its
   * height, with 11% padding above and 21% below. Drawing the whole file would make
   * `heightRatio` size the padding rather than the logo (a 66px request rendering a 45px mark)
   * and would measure the inset to an invisible edge, so the gap below the mark would differ
   * from the gap beside it. Cropping to this rect makes both settings mean what they say.
   */
  trim: Rect
  /** Aspect of the *visible ink*, `trim.width / trim.height` — not of the file. */
  aspect: number
  source: 'brand-file' | 'custom-upload'
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Alpha at or below this counts as transparent when locating the ink. */
const ALPHA_THRESHOLD = 12

/**
 * Where the mark lands, in canvas px.
 *
 * Order matters: size is resolved first (and shrunk if it cannot fit inside the insets), then
 * the corner anchor is applied, then the result is clamped. Clamping last means a bad
 * ratio degrades to a correctly-inset mark rather than one hanging off the edge.
 */
export function signatureRect(
  canvasWidth: number,
  canvasHeight: number,
  aspect: number,
  options: SignatureOptions,
): Rect {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  const inset = Math.min(canvasWidth, canvasHeight) * clampRatio(options.insetRatio, 0, 0.25)

  // Never let the mark dominate: cap at a fifth of the height and half the usable width.
  const maxHeight = Math.max(1, Math.min(canvasHeight * 0.2, canvasHeight - inset * 2))
  const maxWidth = Math.max(1, Math.min(canvasWidth * 0.5, canvasWidth - inset * 2))

  let height = canvasHeight * clampRatio(options.heightRatio, 0.005, 0.2)
  let width = height * safeAspect

  if (width > maxWidth) {
    width = maxWidth
    height = width / safeAspect
  }
  if (height > maxHeight) {
    height = maxHeight
    width = height * safeAspect
  }

  const right = options.corner === 'bottom-right' || options.corner === 'top-right'
  const bottom = options.corner === 'bottom-left' || options.corner === 'bottom-right'

  const x = right ? canvasWidth - inset - width : inset
  const y = bottom ? canvasHeight - inset - height : inset

  return {
    x: clamp(x, inset, Math.max(inset, canvasWidth - width - inset)),
    y: clamp(y, inset, Math.max(inset, canvasHeight - height - inset)),
    width,
    height,
  }
}

export function drawSignature(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  asset: SignatureAsset | null,
  theme: Theme,
  options: SignatureOptions,
  alpha = 1,
): Rect | null {
  const effectiveAlpha = options.opacity * alpha
  if (effectiveAlpha <= 0.002) return null

  // With no image the caption becomes the signature, so exports are still attributed. Better
  // than silently shipping an unbranded asset.
  if (!asset) return options.caption ? drawTextOnly(ctx, canvasWidth, canvasHeight, theme, options, effectiveAlpha) : null

  const rect = signatureRect(canvasWidth, canvasHeight, asset.aspect, options)

  ctx.save()
  ctx.globalAlpha = effectiveAlpha
  ctx.setLineDash([])
  ctx.shadowColor = 'rgba(0,0,0,0)'
  // Source rect crops the file's transparent margin, so `rect` describes the visible mark.
  ctx.drawImage(
    asset.image,
    asset.trim.x,
    asset.trim.y,
    asset.trim.width,
    asset.trim.height,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
  )

  if (options.caption) {
    const size = rect.height * 0.34
    ctx.font = `500 ${size}px system-ui, "Segoe UI", Roboto, sans-serif`
    ctx.fillStyle = rgba(theme.textFaint, 0.9)
    ctx.textBaseline = 'middle'
    const onRight = options.corner.endsWith('right')
    // The caption sits on the inboard side of the mark so the pair stays inside the inset.
    ctx.textAlign = onRight ? 'right' : 'left'
    const gap = rect.height * 0.28
    ctx.fillText(
      options.caption,
      onRight ? rect.x - gap : rect.x + rect.width + gap,
      rect.y + rect.height / 2,
    )
  }

  ctx.restore()
  return rect
}

function drawTextOnly(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  theme: Theme,
  options: SignatureOptions,
  alpha: number,
): Rect {
  const caption = options.caption ?? ''
  const size = canvasHeight * clampRatio(options.heightRatio, 0.005, 0.2) * 0.52
  const inset = Math.min(canvasWidth, canvasHeight) * clampRatio(options.insetRatio, 0, 0.25)

  ctx.save()
  ctx.globalAlpha = alpha
  ctx.setLineDash([])
  ctx.font = `600 ${size}px system-ui, "Segoe UI", Roboto, sans-serif`
  const width = ctx.measureText(caption).width
  const onRight = options.corner.endsWith('right')
  const onBottom = options.corner.startsWith('bottom')

  const x = onRight ? canvasWidth - inset - width : inset
  const y = onBottom ? canvasHeight - inset - size : inset

  ctx.fillStyle = rgba(theme.textFaint, 0.95)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillText(caption, x, y)
  ctx.restore()

  return { x, y, width, height: size }
}

/** File the theme expects, per public/brand/README.md. */
export const signatureFileFor = (theme: Theme): string => `/brand/signature-${theme.signature}.png`

/**
 * Loads the themed brand file, resolving to null when it is absent so the caller can fall
 * back to a caption. A missing signature is a configuration gap to surface in the UI, not an
 * error that should abort an export.
 */
export async function loadBrandSignature(theme: Theme): Promise<SignatureAsset | null> {
  try {
    return await loadImageAsset(signatureFileFor(theme), 'brand-file')
  } catch {
    return null
  }
}

export async function loadImageAsset(
  src: string,
  source: SignatureAsset['source'] = 'custom-upload',
): Promise<SignatureAsset> {
  const image = new Image()
  // Brand files are same-origin, but a pasted data URL may not be; this keeps the canvas
  // untainted either way so `getImageData` below (and `toDataURL` on export) keep working.
  image.crossOrigin = 'anonymous'
  image.decoding = 'sync'
  image.src = src
  await image.decode()

  const width = image.naturalWidth
  const height = image.naturalHeight
  if (!width || !height) throw new Error('Signature image has no intrinsic size.')

  const trim = findOpaqueBounds(image, width, height) ?? { x: 0, y: 0, width, height }
  return { image, trim, aspect: trim.width / trim.height, source }
}

/**
 * Tight bounding box of the non-transparent pixels, or null if the image is blank or
 * unreadable.
 *
 * Reading pixels needs an untainted canvas. Brand files are same-origin and uploads arrive as
 * data URLs, so both qualify — but a cross-origin image would throw a SecurityError here, which
 * is why the failure path returns null and lets the caller fall back to the full bitmap rather
 * than refusing to draw a signature at all.
 */
export function findOpaqueBounds(image: CanvasImageSource, width: number, height: number): Rect | null {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null

    ctx.drawImage(image, 0, 0)
    const { data } = ctx.getImageData(0, 0, width, height)
    return opaqueBoundsFromAlpha(data, width, height)
  } catch {
    return null
  }
}

/**
 * Scans RGBA bytes for the extent of visible pixels. Split out from the canvas work above so
 * the scan itself is a pure function over a byte array and can be tested directly.
 */
export function opaqueBoundsFromAlpha(data: Uint8ClampedArray, width: number, height: number): Rect | null {
  let minX = width
  let maxX = -1
  let minY = height
  let maxY = -1

  for (let y = 0; y < height; y++) {
    const row = y * width * 4
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] <= ALPHA_THRESHOLD) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  if (maxX < 0 || maxY < 0) return null
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const clampRatio = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? clamp(v, lo, hi) : lo)

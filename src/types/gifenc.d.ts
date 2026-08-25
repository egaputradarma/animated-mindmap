// `gifenc` ships as plain JavaScript with no bundled type declarations, so this describes the
// slice of its API the exporter uses. Written against node_modules/gifenc/src/index.js at
// version 1.0.3 — check that file if this ever drifts.

declare module 'gifenc' {
  export type PaletteFormat = 'rgb565' | 'rgb444' | 'rgba4444'

  /** Array of colour tuples, `[r, g, b]` or `[r, g, b, a]`, at most 256 entries. */
  export type Palette = number[][]

  export interface QuantizeOptions {
    format?: PaletteFormat
    oneBitAlpha?: boolean | number
    clearAlpha?: boolean
    clearAlphaColor?: number
    clearAlphaThreshold?: number
  }

  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: QuantizeOptions,
  ): Palette

  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: Palette,
    format?: PaletteFormat,
  ): Uint8Array

  export function prequantize(
    rgba: Uint8Array | Uint8ClampedArray,
    options?: { roundRGB?: number; roundAlpha?: number; oneBitAlpha?: boolean | number },
  ): void

  export interface WriteFrameOptions {
    /** Required on the first frame; becomes the global colour table that later frames reuse. */
    palette?: Palette
    /** Frame delay in milliseconds. Stored as centiseconds, so effectively rounded to 10ms. */
    delay?: number
    /** Loop count: -1 plays once, 0 loops forever, >0 repeats that many times. Default 0. */
    repeat?: number
    transparent?: boolean
    transparentIndex?: number
    dispose?: number
    colorDepth?: number
    /** Only consulted when the encoder was created with `{ auto: false }`. */
    first?: boolean
  }

  export interface GifEncoderInstance {
    writeFrame(index: Uint8Array, width: number, height: number, options?: WriteFrameOptions): void
    writeHeader(): void
    finish(): void
    /** Copy of the encoded bytes. */
    bytes(): Uint8Array
    /** View onto the encoded bytes — no copy, invalidated by further writes. */
    bytesView(): Uint8Array
    reset(): void
    readonly buffer: ArrayBuffer
  }

  export function GIFEncoder(options?: { auto?: boolean; initialCapacity?: number }): GifEncoderInstance

  export default GIFEncoder
}

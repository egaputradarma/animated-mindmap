// Encoder capability checks.
//
// Deliberately separate from the encoders themselves. The UI needs these synchronously during render
// to decide whether to offer a format, and importing them from `encodeMp4.ts` would pull Mediabunny
// into the initial bundle purely to answer "is this button enabled" — defeating the point of loading
// the encoders on demand.

/**
 * Whether WebCodecs video encoding exists at all.
 *
 * Note this is necessary but not sufficient: whether a *specific* codec works at a *specific*
 * resolution is an async question the browser has to be asked, which `encodeMp4` does at export time.
 *
 * Also worth knowing: WebCodecs requires a secure context. `localhost` counts, but reaching the app
 * over plain HTTP at a LAN address does not, so this returns false there.
 */
export const isMp4Supported = (): boolean =>
  typeof globalThis.VideoEncoder === 'function' && typeof globalThis.VideoFrame === 'function'

// H.264 MP4 encoding via WebCodecs, muxed by mp4-muxer.
//
// MP4 is the higher-quality option: no 256-colour ceiling, so the card gradients and packet
// glows survive intact, at roughly a tenth of the GIF's size. The tradeoff is that LinkedIn
// treats it as a video post — play button, video analytics — rather than an inline image.
//
// WHY NOT MediaRecorder, THE USUAL ANSWER
//
// `MediaRecorder` on a canvas stream captures in real time, so a 10s loop takes 10s and any
// dropped frame is baked in. It also defaults to `video/webm`, which LinkedIn does not accept.
// WebCodecs instead encodes frames as fast as the CPU allows, from an addressable timeline,
// which is the whole point of making the renderer a pure function of `t`.
//
// The remaining alternative was `ffmpeg.wasm`, which works everywhere but adds ~25MB to the
// bundle. WebCodecs is native, has no bundle cost, and covers current Chrome and Edge. Where
// it is missing, `isMp4Supported` reports so and the UI steers to GIF instead.

import { ArrayBufferTarget, Muxer } from 'mp4-muxer'
import type { Composition } from '../composition'
import { createFrameCanvas, frameCount, shouldYield, yieldToBrowser, type EncodeSettings, type ProgressFn } from './frames'

/**
 * Tried in order. High profile first for the best compression on flat gradients; the baseline
 * entries are fallbacks for encoders that refuse High at the requested resolution. Level is
 * part of the string, so 1920×1080 needs at least 4.0 (`...28`).
 */
const CODEC_CANDIDATES = ['avc1.640028', 'avc1.4D0028', 'avc1.42E028', 'avc1.640020', 'avc1.42001F'] as const

export interface Mp4Result {
  blob: Blob
  width: number
  height: number
  frames: number
  codec: string
}

export const isMp4Supported = (): boolean =>
  typeof globalThis.VideoEncoder === 'function' && typeof globalThis.VideoFrame === 'function'

/**
 * Bitrate target. Scaled by pixel count and frame rate so a 1920×1080 clip is not starved and
 * a 1080×1350 one is not bloated. 0.11 bits per pixel per frame is generous for synthetic flat
 * art, which compresses far better than camera footage.
 */
function bitrateFor(width: number, height: number, fps: number): number {
  return Math.round(Math.min(16_000_000, Math.max(2_000_000, width * height * fps * 0.11)))
}

async function pickCodec(width: number, height: number, fps: number): Promise<string> {
  for (const codec of CODEC_CANDIDATES) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec,
        width,
        height,
        bitrate: bitrateFor(width, height, fps),
        framerate: fps,
      })
      if (support.supported) return codec
    } catch {
      // An unparseable codec string throws rather than reporting unsupported; try the next.
    }
  }
  throw new Error('No supported H.264 encoder configuration was found for this size.')
}

export async function encodeMp4(
  composition: Composition,
  settings: EncodeSettings,
  onProgress?: ProgressFn,
): Promise<Mp4Result> {
  if (!isMp4Supported()) {
    throw new Error('This browser has no WebCodecs VideoEncoder. Use Chrome or Edge, or export a GIF instead.')
  }

  const total = frameCount(settings)
  const frame = createFrameCanvas(composition, settings.maxSide)
  const { width, height } = frame
  const codec = await pickCodec(width, height, settings.fps)

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height, frameRate: settings.fps },
    // Metadata at the front. Costs memory during finalisation but produces a file that starts
    // playing without a full download — which is what a social feed needs.
    fastStart: 'in-memory',
  })

  let encodeError: Error | null = null
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    // The encoder reports failures on this callback, not by rejecting; capture and rethrow
    // after the loop so the error surfaces instead of vanishing.
    error: err => {
      encodeError = err instanceof Error ? err : new Error(String(err))
    },
  })

  encoder.configure({
    codec,
    width,
    height,
    bitrate: bitrateFor(width, height, settings.fps),
    framerate: settings.fps,
    latencyMode: 'quality',
  })

  const frameDuration = 1_000_000 / settings.fps // microseconds

  try {
    for (let i = 0; i < total; i++) {
      if (encodeError) throw encodeError
      frame.drawAt(i / total)

      const videoFrame = new VideoFrame(frame.canvas, {
        timestamp: Math.round(i * frameDuration),
        duration: Math.round(frameDuration),
      })
      // A keyframe every ~2s keeps seeking responsive and gives the loop a clean entry point.
      encoder.encode(videoFrame, { keyFrame: i % Math.max(1, Math.round(settings.fps * 2)) === 0 })
      videoFrame.close()

      onProgress?.({ value: (i / total) * 0.92, label: `Encoding MP4 · frame ${i + 1}/${total}` })

      // Without this the queue grows unbounded and memory climbs to the point of a tab crash
      // on longer clips; the encoder needs the main thread back to drain it.
      if (shouldYield(i)) await yieldToBrowser()
    }

    onProgress?.({ value: 0.95, label: 'Finalising MP4…' })
    await encoder.flush()
    if (encodeError) throw encodeError
    muxer.finalize()
  } finally {
    // `close()` on an already-errored encoder throws again; the state is unrecoverable either
    // way, so the original error is the one worth propagating.
    try {
      encoder.close()
    } catch {
      /* ignore */
    }
  }

  const { buffer } = muxer.target
  onProgress?.({ value: 1, label: 'Done' })

  return {
    blob: new Blob([buffer], { type: 'video/mp4' }),
    width,
    height,
    frames: total,
    codec,
  }
}

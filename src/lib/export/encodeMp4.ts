// H.264 MP4 encoding via Mediabunny.
//
// MP4 is the higher-quality option: no 256-colour ceiling, so the card gradients and packet glows
// survive intact, at roughly a tenth of the GIF's size. The tradeoff is that LinkedIn treats it as
// a video post — play button, video analytics — rather than an inline image.
//
// WHY MEDIABUNNY RATHER THAN mp4-muxer
//
// This previously drove WebCodecs by hand and muxed with mp4-muxer, which its author has since
// deprecated in favour of Mediabunny (same author; Mediabunny's MP4 muxer grew out of it). Beyond
// clearing the deprecation, `CanvasSource` replaces the entire manual encoder stack: no VideoEncoder
// to configure, no VideoFrame to construct and close, no codec-string probing, and no queue to
// babysit. `add()` returns a promise that resolves when the pipeline is ready for more, so awaiting
// it is the backpressure handling that previously had to be approximated by yielding every 8 frames.
//
// WHY NOT MediaRecorder, THE USUAL ANSWER
//
// `MediaRecorder` on a canvas stream captures in real time, so a 10s loop takes 10s and any dropped
// frame is baked in. It also defaults to `video/webm`, which LinkedIn does not accept. Encoding from
// an addressable timeline is the whole point of making the renderer a pure function of `t`.

import {
  BufferTarget,
  CanvasSource,
  getFirstEncodableVideoCodec,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  type VideoCodec,
} from 'mediabunny'
import type { Composition } from '../composition'
import { isMp4Supported } from './capabilities'
import { createFrameCanvas, frameCount, shouldYield, yieldToBrowser, type EncodeSettings, type ProgressFn } from './frames'

/**
 * Tried in order. AVC (H.264) first and by a wide margin: it is the only one of these that every
 * social platform and player reliably decodes. The rest exist so an unusual browser still produces
 * *something*, and the codec actually used is reported back so the UI can say so.
 */
const CODEC_PREFERENCE: VideoCodec[] = ['avc', 'hevc', 'av1', 'vp9']

/** Key frame every 2s: good seeking without inflating a short loop. */
const KEY_FRAME_INTERVAL_SECONDS = 2

export interface Mp4Result {
  blob: Blob
  width: number
  height: number
  frames: number
  codec: VideoCodec
  /** True when the codec is not H.264, which is worth warning about before posting. */
  unusualCodec: boolean
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

  onProgress?.({ value: 0, label: 'Checking encoder support…' })
  const codec = await getFirstEncodableVideoCodec(CODEC_PREFERENCE, { width, height })
  if (!codec) {
    throw new Error(`No video encoder available for ${width}×${height} in this browser.`)
  }

  // Held separately rather than read back off `output.target`, which avoids threading Output's
  // target generic through this function for no benefit.
  const target = new BufferTarget()
  const output = new Output({
    // Metadata at the front. Costs memory during finalisation but produces a file that starts
    // playing without a full download — what a social feed needs.
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target,
  })

  const source = new CanvasSource(frame.canvas, {
    codec,
    // A qualitative preset rather than a hand-computed bitrate: Mediabunny already scales these by
    // resolution and frame rate, which is exactly what the old bits-per-pixel arithmetic was for.
    quality: QUALITY_HIGH,
    keyFrameInterval: KEY_FRAME_INTERVAL_SECONDS,
  })

  output.addVideoTrack(source, { frameRate: settings.fps })
  await output.start()

  const frameDuration = 1 / settings.fps

  for (let i = 0; i < total; i++) {
    frame.drawAt(i / total)
    // Awaiting respects encoder and writer backpressure, so the queue cannot grow unbounded the way
    // it could when frames were pushed at a VideoEncoder as fast as the loop ran.
    await source.add(i * frameDuration, frameDuration)

    onProgress?.({ value: (i / total) * 0.92, label: `Encoding MP4 · frame ${i + 1}/${total}` })

    // Backpressure yields to the microtask queue, which is not enough for the browser to repaint the
    // progress bar. This hands back a full task occasionally so the UI stays alive.
    if (shouldYield(i)) await yieldToBrowser()
  }

  onProgress?.({ value: 0.95, label: 'Finalising MP4…' })
  await output.finalize()

  const buffer = target.buffer
  if (!buffer) throw new Error('Encoding finished but produced no data.')

  onProgress?.({ value: 1, label: 'Done' })

  return {
    blob: new Blob([buffer], { type: 'video/mp4' }),
    width,
    height,
    frames: total,
    codec,
    unusualCodec: codec !== 'avc',
  }
}

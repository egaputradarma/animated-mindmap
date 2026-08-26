// Binds mindmap + settings + signature into a single addressable frame function.
//
// Preview and export both go through `buildComposition`, and neither has its own drawing code.
// That is the only way "what you see is what you post" actually holds — the moment the
// exporter has a second render path, the two drift and the GIF stops matching the preview.
//
// A composition is built once per settings change and then sampled by time. Layout, curve
// measurement and text wrapping all happen in the build, not per frame, which is what keeps
// a 300-frame encode from re-laying-out the graph 300 times.

import { buildCameraStops, type CameraMode } from './camera'
import { layoutMindmap, type Layout, type LayoutMode } from './layout'
import { THEMES, type ThemeName } from './palette'
import { drawFrame, type RenderOptions } from './renderer'
import { drawSignature, type SignatureAsset, type SignatureOptions } from './signature'
import { frameState, type LoopMode, type TimelineOptions } from './timeline'
import type { Mindmap } from '../types/mindmap'

export type PresetName = 'square' | 'portrait' | 'landscape'

export interface SizePreset {
  name: PresetName
  label: string
  hint: string
  width: number
  height: number
}

// LinkedIn renders feed images at roughly 40% of these widths on desktop and reflows on
// mobile, so these are chosen to survive that downscale rather than to be maximal.
export const SIZE_PRESETS: Record<PresetName, SizePreset> = {
  square: { name: 'square', label: '1:1 Square', hint: '1200 × 1200 · safest in-feed', width: 1200, height: 1200 },
  portrait: {
    name: 'portrait',
    label: '4:5 Portrait',
    hint: '1080 × 1350 · most vertical space',
    width: 1080,
    height: 1350,
  },
  landscape: {
    name: 'landscape',
    label: '16:9 Landscape',
    hint: '1920 × 1080 · best for wide maps',
    width: 1920,
    height: 1080,
  },
}

export interface CompositionSpec {
  mindmap: Mindmap
  preset: PresetName
  theme: ThemeName
  layoutMode: LayoutMode
  /** Ring spacing multiplier. Lower packs the graph tighter and so enlarges the cards. */
  spread: number
  curvature: number
  loopMode: LoopMode
  /** Packet traversals per loop. Rounded to an integer — see timeline.ts on why. */
  packetCycles: number
  /** `tour` moves the camera branch to branch, which is what makes a dense mindmap legible. */
  cameraMode: CameraMode
  showTitle: boolean
  /** Falls back to the mindmap name when blank. */
  title: string
  subtitle: string
  signature: SignatureOptions
}

export const DEFAULT_SPEC: Omit<CompositionSpec, 'mindmap' | 'signature'> = {
  preset: 'square',
  theme: 'dark',
  layoutMode: 'radial',
  spread: 1,
  curvature: 0.14,
  loopMode: 'build',
  packetCycles: 3,
  // Fixed by default: the camera is the answer to a dense mindmap, not something to impose on a
  // seven-node one that already fits comfortably.
  cameraMode: 'fit',
  showTitle: true,
  title: '',
  subtitle: '',
}

export interface Composition {
  layout: Layout
  width: number
  height: number
  timeline: TimelineOptions
  /** Draws the frame at normalised loop time `t`. Safe to call with any real number. */
  render: (ctx: CanvasRenderingContext2D, t: number) => void
}

export function buildComposition(spec: CompositionSpec, signature: SignatureAsset | null): Composition {
  const preset = SIZE_PRESETS[spec.preset]
  const theme = THEMES[spec.theme]

  const titleText = spec.title.trim() || spec.mindmap.name
  const showTitle = spec.showTitle && titleText.length > 0
  const titleSpace = showTitle ? preset.height * (spec.subtitle.trim() ? 0.13 : 0.1) : 0

  // Reserving the signature's band up front is what keeps a card from ever sitting under the
  // mark. Clamping it after the fact would move cards around per settings change instead.
  const footerSpace =
    preset.height * spec.signature.heightRatio + Math.min(preset.width, preset.height) * spec.signature.insetRatio * 1.7

  const layout = layoutMindmap(spec.mindmap, {
    width: preset.width,
    height: preset.height,
    mode: spec.layoutMode,
    spread: spec.spread,
    curvature: spec.curvature,
    padding: Math.min(preset.width, preset.height) * 0.055,
    titleSpace,
    footerSpace,
  })

  const timeline: TimelineOptions = {
    mode: spec.loopMode,
    lastOrder: layout.lastOrder,
    // Non-integer cycle counts break the loop, so this is enforced here rather than trusted.
    packetCycles: Math.max(1, Math.round(spec.packetCycles)),
  }

  // Stops are derived from the finished layout, so this must come after it. Built once per
  // composition rather than per frame — the geometry is fixed for the life of a layout.
  const cameraStops = spec.cameraMode === 'tour' ? buildCameraStops(layout) : null

  const renderOptions: RenderOptions = {
    theme,
    timeline,
    titleBlock: showTitle ? { title: titleText, subtitle: spec.subtitle.trim() || null } : null,
    titleSpace,
    // A tour of one stop is just the wide shot, so it is not worth the transform.
    cameraStops: cameraStops && cameraStops.length > 1 ? cameraStops : null,
  }

  return {
    layout,
    width: preset.width,
    height: preset.height,
    timeline,
    render(ctx, t) {
      drawFrame(ctx, layout, renderOptions, t)
      // The mark fades with the composition in `build` mode; passing the global alpha rather
      // than drawing at full strength is what keeps t=1 identical to t=0.
      const { global } = frameState(t, timeline)
      drawSignature(ctx, preset.width, preset.height, signature, theme, spec.signature, global)
    },
  }
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Download, Image as ImageIcon, Pause, Play, Upload } from 'lucide-react'
import AppLogo from '../components/AppLogo'
import PreviewCanvas from '../components/PreviewCanvas'
import { Banner, Button, Field, SectionHeading, SegmentedControl, Select, Slider, TextInput, Toggle } from '../components/ui'
import type { CameraMode } from '../lib/camera'
import { buildComposition, DEFAULT_SPEC, SIZE_PRESETS, type CompositionSpec, type PresetName } from '../lib/composition'
import { isMp4Supported } from '../lib/export/capabilities'
import type { DitherMode } from '../lib/export/dither'
import { downloadBlob, formatBytes, LINKEDIN_GIF_LIMIT_BYTES } from '../lib/export/download'
import { encodePng, renderThumbnail } from '../lib/export/encodePng'
import { MAX_ENCODE_SIDE, outputSize, type EncodeProgress } from '../lib/export/frames'
import { slugify } from '../lib/id'
import type { LayoutMode } from '../lib/layout'
import type { ThemeName } from '../lib/palette'
import { DEFAULT_SIGNATURE, type SignatureCorner, type SignatureOptions } from '../lib/signature'
import { getMindmap, loadSpec, saveSpec, saveThumbnail } from '../lib/storage'
import type { LoopMode } from '../lib/timeline'
import { useSignature } from '../hooks/useSignature'
import type { Mindmap } from '../types/mindmap'

type Format = 'gif' | 'mp4' | 'png'

interface ExportSettings {
  fps: number
  durationSeconds: number
  maxSide: number
}

// GIF and MP4 want genuinely different settings, so switching format swaps the defaults rather
// than carrying one set across both.
//
// GIF: 20fps divides 100 exactly, so frame delays land on whole centiseconds with no timing
// drift (see encodeGif.ts). 720px keeps the file under LinkedIn's ~8MB inline-image ceiling.
// MP4: 30fps and full resolution — H.264 has none of GIF's constraints.
const FORMAT_DEFAULTS: Record<Format, ExportSettings> = {
  gif: { fps: 20, durationSeconds: 9, maxSide: 720 },
  // 2160 rather than the preset's own size. The renderer is fully vector, so rendering above the
  // composition's nominal dimensions is real supersampling — see outputSize in frames.ts.
  mp4: { fps: 30, durationSeconds: 9, maxSide: 2160 },
  png: { fps: 1, durationSeconds: 1, maxSide: 2400 },
}

/**
 * Upper limit offered per format.
 *
 * GIF stays modest: it is capped at 256 colours and every frame is stored whole, so resolution is the
 * fastest way to blow past LinkedIn's inline limit. MP4 and PNG go to the encoder ceiling, because for
 * those the only cost of more pixels is time.
 */
const MAX_SIDE_BY_FORMAT: Record<Format, number> = {
  gif: 1280,
  mp4: MAX_ENCODE_SIDE,
  png: MAX_ENCODE_SIDE,
}

interface ExportResult {
  format: Format
  filename: string
  bytes: number
  width: number
  height: number
  note: string | null
}

export default function AnimatePage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [mindmap, setMindmap] = useState<Mindmap | null | 'missing'>(null)
  const [spec, setSpec] = useState<Omit<CompositionSpec, 'mindmap'>>({
    ...DEFAULT_SPEC,
    signature: DEFAULT_SIGNATURE,
  })
  const [format, setFormat] = useState<Format>('gif')
  const [exportSettings, setExportSettings] = useState<ExportSettings>(FORMAT_DEFAULTS.gif)
  // Smooth by default: banding on the gradient background is the most visible flaw in a GIF export,
  // and the extra encode time is a few seconds at the default resolution.
  const [gifDither, setGifDither] = useState<DitherMode>('floyd-steinberg')

  const [playing, setPlaying] = useState(true)
  const [scrubTime, setScrubTime] = useState<number | null>(null)
  const [progress, setProgress] = useState<EncodeProgress | null>(null)
  const [result, setResult] = useState<ExportResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const signature = useSignature(spec.theme)

  // ── Load ──
  useEffect(() => {
    if (!id) return
    const loaded = getMindmap(id)
    if (!loaded) {
      setMindmap('missing')
      return
    }
    setMindmap(loaded)

    const saved = loadSpec(id)
    if (saved) setSpec(previous => ({ ...previous, ...saved, signature: { ...previous.signature, ...saved.signature } }))
  }, [id])

  // Honour the OS motion preference for the on-screen preview. The exported file is unaffected:
  // the user explicitly asked for an animation, so suppressing it there would be wrong.
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) setPlaying(false)
  }, [])

  useEffect(() => {
    if (id && mindmap && mindmap !== 'missing') saveSpec(id, spec)
  }, [id, mindmap, spec])

  const update = useCallback(<K extends keyof Omit<CompositionSpec, 'mindmap'>>(key: K, value: Omit<CompositionSpec, 'mindmap'>[K]) => {
    setSpec(previous => ({ ...previous, [key]: value }))
    setResult(null)
  }, [])

  const updateSignature = useCallback(<K extends keyof SignatureOptions>(key: K, value: SignatureOptions[K]) => {
    setSpec(previous => ({ ...previous, signature: { ...previous.signature, [key]: value } }))
    setResult(null)
  }, [])

  const composition = useMemo(() => {
    if (!mindmap || mindmap === 'missing') return null
    try {
      return buildComposition({ ...spec, mindmap }, signature.asset)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not lay out this mindmap.')
      return null
    }
  }, [mindmap, spec, signature.asset])

  // Refresh the list thumbnail whenever the look changes, so the gallery matches the export.
  // Debounced because settings arrive in bursts while a slider is dragged, and each render is a
  // full offscreen draw.
  useEffect(() => {
    if (!composition || !id) return
    const timer = setTimeout(() => {
      try {
        saveThumbnail(id, renderThumbnail(composition))
      } catch {
        /* a stale thumbnail is not worth surfacing */
      }
    }, 600)
    return () => clearTimeout(timer)
  }, [composition, id])

  const changeFormat = (next: Format) => {
    setFormat(next)
    // No longer clamped to the preset's own dimensions. That clamp was what held MP4 down to 1200px on
    // the square preset: the aspect presets describe the *composition*, not a resolution ceiling.
    setExportSettings({
      ...FORMAT_DEFAULTS[next],
      maxSide: Math.min(FORMAT_DEFAULTS[next].maxSide, MAX_SIDE_BY_FORMAT[next]),
    })
    setResult(null)
  }

  const runExport = async () => {
    if (!composition || !mindmap || mindmap === 'missing') return
    setError(null)
    setResult(null)
    setProgress({ value: 0, label: 'Starting…' })
    // Playback competes with the encoder for the main thread and slows the export noticeably.
    setPlaying(false)

    const base = slugify(mindmap.name, 'mindmap')
    try {
      if (format === 'png') {
        const png = await encodePng(composition, exportSettings.maxSide)
        downloadBlob(png.blob, `${base}-poster.png`)
        setResult({
          format,
          filename: `${base}-poster.png`,
          bytes: png.blob.size,
          width: png.width,
          height: png.height,
          note: null,
        })
      } else if (format === 'gif') {
        // Loaded on demand. The GIF and MP4 encoders together are a large share of the bundle
        // (Mediabunny, and gifski's wasm payload), and neither is needed to browse or preview.
        const { encodeGif, DEFAULT_GIF_OPTIONS } = await import('../lib/export/encodeGif')
        const gif = await encodeGif(composition, exportSettings, setProgress, {
          ...DEFAULT_GIF_OPTIONS,
          dither: gifDither,
        })
        downloadBlob(gif.blob, `${base}.gif`)
        setResult({
          format,
          filename: `${base}.gif`,
          bytes: gif.blob.size,
          width: gif.width,
          height: gif.height,
          note:
            gif.blob.size > LINKEDIN_GIF_LIMIT_BYTES
              ? `Over LinkedIn's ~${formatBytes(LINKEDIN_GIF_LIMIT_BYTES)} inline limit. Drop the resolution or duration, or post the MP4 instead.`
              : null,
        })
      } else {
        const { encodeMp4 } = await import('../lib/export/encodeMp4')
        const mp4 = await encodeMp4(composition, exportSettings, setProgress)
        downloadBlob(mp4.blob, `${base}.mp4`)
        setResult({
          format,
          filename: `${base}.mp4`,
          bytes: mp4.blob.size,
          width: mp4.width,
          height: mp4.height,
          note: mp4.unusualCodec
            ? `Encoded as ${mp4.codec.toUpperCase()} because H.264 was unavailable here. Some platforms will not play that — check before posting.`
            : mp4.downscaled
              ? `This browser refused the requested resolution, so it was encoded at ${mp4.width}×${mp4.height} instead.`
              : 'Posts as a video, so it gets a play button and video analytics rather than inline image autoplay.',
        })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed.')
    } finally {
      setProgress(null)
    }
  }

  if (mindmap === 'missing') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="text-slate-400">That mindmap no longer exists.</p>
        <Button variant="primary" onClick={() => navigate('/mindmaps')}>
          Back to mindmaps
        </Button>
      </div>
    )
  }

  if (!mindmap || !composition) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="text-sm text-slate-500">{error ?? 'Loading…'}</p>
      </div>
    )
  }

  const preset = SIZE_PRESETS[spec.preset]
  const busy = progress !== null
  const mp4Available = isMp4Supported()
  // Number of camera stops a tour would have: the establishing wide shot plus one per branch.
  const branchCount = new Set(composition.layout.nodes.map(n => n.branch).filter(Boolean)).size + 1
  // Shown next to the slider so the actual pixel dimensions are never a surprise.
  const outputDimensions = outputSize(composition, exportSettings.maxSide)

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-ink-800 bg-ink-900/80 px-4 py-2.5 backdrop-blur">
        <Link to="/mindmaps" aria-label="All mindmaps" className="shrink-0 opacity-80 transition-opacity hover:opacity-100">
          <AppLogo size={22} />
        </Link>
        <Link
          to={`/mindmaps/${mindmap.id}`}
          className="inline-flex items-center gap-1.5 text-sm text-slate-400 transition-colors hover:text-slate-100"
        >
          <ArrowLeft size={15} /> Editor
        </Link>
        <span className="truncate font-semibold text-slate-100">{mindmap.name}</span>
        <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-slate-500">
          Animated
        </span>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* ── Preview ── */}
        <main className="preview-backdrop flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-auto bg-ink-950 p-6">
          <div className="w-full" style={{ maxWidth: preset.width >= preset.height ? 760 : 520 }}>
            <PreviewCanvas
              composition={composition}
              durationSeconds={exportSettings.durationSeconds}
              playing={playing && !busy}
              scrubTime={scrubTime}
            />
          </div>

          <div className="flex w-full max-w-xl items-center gap-3">
            <Button onClick={() => setPlaying(p => !p)} disabled={busy} title={playing ? 'Pause' : 'Play'}>
              {playing ? <Pause size={14} /> : <Play size={14} />}
              {playing ? 'Pause' : 'Play'}
            </Button>
            <input
              type="range"
              min={0}
              max={0.999}
              step={0.001}
              value={scrubTime ?? 0}
              aria-label="Scrub the loop"
              onChange={e => {
                setPlaying(false)
                setScrubTime(Number(e.target.value))
              }}
              className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-ink-700 accent-blue-500"
            />
            {scrubTime !== null && (
              <Button
                variant="ghost"
                onClick={() => {
                  setScrubTime(null)
                  setPlaying(true)
                }}
              >
                Resume
              </Button>
            )}
          </div>
          <p className="text-center text-[11px] text-slate-600">
            {preset.width} × {preset.height} · {spec.loopMode === 'build' ? 'builds, holds, then fades back to the start' : 'fully drawn, packets only'} · loops seamlessly
          </p>
        </main>

        {/* ── Settings ── */}
        <aside className="w-full shrink-0 space-y-6 overflow-y-auto border-t border-ink-800 bg-ink-900 p-5 lg:w-[380px] lg:border-l lg:border-t-0">
          <section>
            <SectionHeading>Export</SectionHeading>
            <div className="space-y-3">
              <SegmentedControl
                value={format}
                onChange={changeFormat}
                options={[
                  { value: 'gif', label: 'GIF' },
                  { value: 'mp4', label: 'MP4' },
                  { value: 'png', label: 'PNG' },
                ]}
              />

              {format === 'gif' && (
                <>
                  <Banner tone="info">
                    Autoplays inline as an image — no play button. Capped at 256 colours, so keep the
                    resolution modest to stay under LinkedIn&apos;s ~8&nbsp;MB limit.
                  </Banner>
                  <Field
                    label="Colour handling"
                    hint={
                      gifDither === 'none'
                        ? 'Fastest. The background gradient will show visible bands.'
                        : 'Diffuses the 256-colour error so the gradient and glows stay smooth. Slower to encode.'
                    }
                  >
                    <SegmentedControl<DitherMode>
                      value={gifDither}
                      onChange={setGifDither}
                      options={[
                        { value: 'floyd-steinberg', label: 'Smooth' },
                        { value: 'none', label: 'Fast' },
                      ]}
                    />
                  </Field>
                </>
              )}
              {format === 'mp4' && !mp4Available && (
                <Banner tone="warn">
                  This browser has no WebCodecs encoder. Use Chrome or Edge for MP4, or export a GIF.
                </Banner>
              )}
              {format === 'mp4' && mp4Available && (
                <Banner tone="info">
                  Much smaller and cleaner than GIF at the same size, but LinkedIn treats it as a video post.
                </Banner>
              )}

              {format !== 'png' && (
                <>
                  <Field label="Loop length" hint="8–12s reads well in-feed without dragging.">
                    <Slider
                      value={exportSettings.durationSeconds}
                      onChange={v => setExportSettings(s => ({ ...s, durationSeconds: v }))}
                      min={4}
                      max={20}
                      step={0.5}
                      format={v => `${v}s`}
                      ariaLabel="Loop length in seconds"
                    />
                  </Field>
                  <Field
                    label="Frame rate"
                    hint={
                      format === 'gif' && 100 % exportSettings.fps !== 0
                        ? `GIF delays are whole centiseconds, so ${exportSettings.fps}fps will play slightly fast. 20, 25 or 50 are exact.`
                        : undefined
                    }
                  >
                    <Slider
                      value={exportSettings.fps}
                      onChange={v => setExportSettings(s => ({ ...s, fps: v }))}
                      min={10}
                      max={format === 'gif' ? 30 : 60}
                      step={format === 'gif' ? 5 : 6}
                      format={v => `${v}fps`}
                      ariaLabel="Frames per second"
                    />
                  </Field>
                </>
              )}

              <Field
                label="Resolution"
                hint={
                  format === 'gif'
                    ? `Longest side. Every frame is stored whole, so this drives file size hard.`
                    : `Longest side. Above ${Math.max(preset.width, preset.height)}px the frame is re-rendered larger, not upscaled — text stays sharp.`
                }
              >
                <Slider
                  value={exportSettings.maxSide}
                  onChange={v => setExportSettings(s => ({ ...s, maxSide: v }))}
                  min={360}
                  max={MAX_SIDE_BY_FORMAT[format]}
                  step={format === 'gif' ? 40 : 120}
                  format={v => `${v}px`}
                  ariaLabel="Longest side in pixels"
                />
              </Field>
              {format !== 'gif' && (
                <p className="text-[11px] text-slate-500">
                  Output {outputDimensions.width} × {outputDimensions.height}
                  {exportSettings.maxSide > Math.max(preset.width, preset.height) &&
                    ` · ${(exportSettings.maxSide / Math.max(preset.width, preset.height)).toFixed(1)}× supersampled`}
                </p>
              )}

              {format !== 'png' && (
                <p className="text-[11px] text-slate-500">
                  {Math.round(exportSettings.fps * exportSettings.durationSeconds)} frames to encode.
                </p>
              )}

              <Button
                variant="primary"
                onClick={runExport}
                disabled={busy || (format === 'mp4' && !mp4Available)}
                className="w-full"
              >
                {format === 'png' ? <ImageIcon size={14} /> : <Download size={14} />}
                {busy ? 'Working…' : `Export ${format.toUpperCase()}`}
              </Button>

              {progress && (
                <div className="space-y-1.5">
                  <div className="h-1.5 overflow-hidden rounded-full bg-ink-700">
                    <div
                      className="h-full rounded-full bg-blue-500 transition-[width] duration-150"
                      style={{ width: `${Math.round(progress.value * 100)}%` }}
                    />
                  </div>
                  <p className="text-[11px] text-slate-500">{progress.label}</p>
                </div>
              )}

              {error && <Banner tone="error">{error}</Banner>}
              {result && (
                <Banner tone={result.note ? 'warn' : 'success'}>
                  Saved <span className="font-mono">{result.filename}</span> · {result.width}×{result.height} ·{' '}
                  {formatBytes(result.bytes)}
                  {result.note && <span className="mt-1 block">{result.note}</span>}
                </Banner>
              )}
            </div>
          </section>

          <section>
            <SectionHeading>Canvas</SectionHeading>
            <div className="space-y-3">
              <Field label="Aspect" hint={preset.hint}>
                <Select<PresetName>
                  value={spec.preset}
                  onChange={v => update('preset', v)}
                  options={Object.values(SIZE_PRESETS).map(p => ({ value: p.name, label: p.label }))}
                  ariaLabel="Aspect ratio preset"
                />
              </Field>
              <Field label="Theme">
                <SegmentedControl<ThemeName>
                  value={spec.theme}
                  onChange={v => update('theme', v)}
                  options={[
                    { value: 'dark', label: 'Dark' },
                    { value: 'light', label: 'Light' },
                  ]}
                />
              </Field>
              <Toggle checked={spec.showTitle} onChange={v => update('showTitle', v)} label="Show title block" />
              {spec.showTitle && (
                <>
                  <Field label="Title" hint="Blank uses the mindmap name.">
                    <TextInput value={spec.title} onChange={v => update('title', v)} placeholder={mindmap.name} maxLength={80} />
                  </Field>
                  <Field label="Subtitle">
                    <TextInput value={spec.subtitle} onChange={v => update('subtitle', v)} placeholder="Optional" maxLength={110} />
                  </Field>
                </>
              )}
            </div>
          </section>

          <section>
            <SectionHeading>Layout &amp; motion</SectionHeading>
            <div className="space-y-3">
              <Field
                label="Arrangement"
                hint={
                  spec.layoutMode === 'radial'
                    ? 'Ignores editor positions and rebuilds as a hub-and-spoke fitted to the frame.'
                    : 'Keeps the positions you arranged in the editor.'
                }
              >
                <SegmentedControl<LayoutMode>
                  value={spec.layoutMode}
                  onChange={v => update('layoutMode', v)}
                  options={[
                    { value: 'radial', label: 'Auto radial' },
                    { value: 'manual', label: 'As arranged' },
                  ]}
                />
              </Field>
              {spec.layoutMode === 'radial' && (
                <Field label="Spread" hint="Lower packs the graph tighter, which makes the cards bigger.">
                  <Slider
                    value={spec.spread}
                    onChange={v => update('spread', v)}
                    min={0.7}
                    max={1.6}
                    step={0.05}
                    format={v => `${v.toFixed(2)}×`}
                    ariaLabel="Ring spread"
                  />
                </Field>
              )}
              <Field label="Wire curve">
                <Slider
                  value={spec.curvature}
                  onChange={v => update('curvature', v)}
                  min={0}
                  max={0.3}
                  step={0.01}
                  format={v => v.toFixed(2)}
                  ariaLabel="Connector curvature"
                />
              </Field>
              <Field
                label="Loop style"
                hint={
                  spec.loopMode === 'build'
                    ? 'Cards cascade in, hold, then fade out so the loop closes on an empty frame.'
                    : 'Everything stays drawn; only the packets move. Shorter and calmer.'
                }
              >
                <SegmentedControl<LoopMode>
                  value={spec.loopMode}
                  onChange={v => update('loopMode', v)}
                  options={[
                    { value: 'build', label: 'Build up' },
                    { value: 'flow', label: 'Flow only' },
                  ]}
                />
              </Field>
              <Field label="Packet trips" hint="Whole trips per loop — fractional counts would break the seam.">
                <Slider
                  value={spec.packetCycles}
                  onChange={v => update('packetCycles', v)}
                  min={1}
                  max={8}
                  step={1}
                  format={v => `${v}×`}
                  ariaLabel="Packet traversals per loop"
                />
              </Field>
              <Field
                label="Camera"
                hint={
                  spec.cameraMode === 'tour'
                    ? `Establishing shot, then moves in on each branch. ${branchCount} stops — pairs well with a longer loop.`
                    : 'Fixed view with the whole map in frame.'
                }
              >
                <SegmentedControl<CameraMode>
                  value={spec.cameraMode}
                  onChange={v => update('cameraMode', v)}
                  options={[
                    { value: 'fit', label: 'Fixed' },
                    { value: 'tour', label: 'Tour branches' },
                  ]}
                />
              </Field>
              {spec.cameraMode === 'tour' && branchCount <= 1 && (
                <Banner tone="warn">
                  This mindmap has no branches to tour, so the camera will stay put. Add nodes under the hub
                  first.
                </Banner>
              )}
            </div>
          </section>

          <section>
            <SectionHeading>Signature</SectionHeading>
            <div className="space-y-3">
              {signature.status === 'missing' && (
                <Banner tone="warn">
                  No mark found at <span className="font-mono">{signature.expectedPath}</span>. Drop the file there, or
                  upload one below — exports carry the caption text until then.
                </Banner>
              )}
              {signature.status === 'brand' && (
                <Banner tone="success">
                  Using <span className="font-mono">{signature.expectedPath}</span>.
                </Banner>
              )}
              {signature.status === 'custom' && (
                <Banner tone="success">Using your uploaded {signature.variant} mark.</Banner>
              )}

              <div className="flex items-center gap-2">
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-ink-600 bg-ink-800 px-3 py-1.5 text-sm text-slate-200 transition-colors hover:bg-ink-700">
                  <Upload size={14} />
                  Upload {signature.variant} mark
                  <input
                    type="file"
                    accept="image/png,image/svg+xml,image/webp"
                    className="hidden"
                    onChange={async e => {
                      const file = e.target.files?.[0]
                      if (!file) return
                      try {
                        await signature.uploadFor(signature.variant, file)
                        setError(null)
                      } catch (err) {
                        setError(err instanceof Error ? err.message : 'Could not read that image.')
                      }
                    }}
                  />
                </label>
                {signature.store[signature.variant] && (
                  <Button variant="danger" onClick={() => signature.clear(signature.variant)}>
                    Remove
                  </Button>
                )}
              </div>
              <p className="text-[11px] leading-snug text-slate-500">
                The {spec.theme} theme uses the <strong>{signature.variant}</strong> mark. Upload both to switch themes
                freely.
              </p>

              <Field label="Corner">
                <Select<SignatureCorner>
                  value={spec.signature.corner}
                  onChange={v => updateSignature('corner', v)}
                  options={[
                    { value: 'bottom-left', label: 'Bottom left' },
                    { value: 'bottom-right', label: 'Bottom right' },
                    { value: 'top-left', label: 'Top left' },
                    { value: 'top-right', label: 'Top right' },
                  ]}
                  ariaLabel="Signature corner"
                />
              </Field>
              <Field label="Size">
                <Slider
                  value={spec.signature.heightRatio}
                  onChange={v => updateSignature('heightRatio', v)}
                  min={0.02}
                  max={0.14}
                  step={0.005}
                  format={v => `${Math.round(v * preset.height)}px`}
                  ariaLabel="Signature height"
                />
              </Field>
              <Field label="Inset" hint="Distance from both edges, as a share of the shorter side.">
                <Slider
                  value={spec.signature.insetRatio}
                  onChange={v => updateSignature('insetRatio', v)}
                  min={0.01}
                  max={0.1}
                  step={0.002}
                  format={v => `${Math.round(v * Math.min(preset.width, preset.height))}px`}
                  ariaLabel="Signature inset"
                />
              </Field>
              <Field label="Opacity">
                <Slider
                  value={spec.signature.opacity}
                  onChange={v => updateSignature('opacity', v)}
                  min={0.2}
                  max={1}
                  step={0.02}
                  format={v => `${Math.round(v * 100)}%`}
                  ariaLabel="Signature opacity"
                />
              </Field>
              <Field label="Caption" hint="Optional text beside the mark. Used alone if no image is available.">
                <TextInput
                  value={spec.signature.caption ?? ''}
                  onChange={v => updateSignature('caption', v || null)}
                  placeholder="e.g. your name or handle"
                  maxLength={40}
                />
              </Field>
            </div>
          </section>
        </aside>
      </div>
    </div>
  )
}

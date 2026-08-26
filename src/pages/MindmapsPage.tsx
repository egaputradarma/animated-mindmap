import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { BookOpen, Copy, FileJson, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react'
import AppLogo from '../components/AppLogo'
import { Banner, Button, Field, SectionHeading, SegmentedControl, TextInput } from '../components/ui'
import { useLibrary, type LibraryEntry } from '../hooks/useLibrary'
import { importMarkdown } from '../lib/markdown'
import { exportAuthoringJson, importMindmap, ImportError } from '../lib/importMindmap'
import {
  createMindmap,
  deleteMindmap,
  getMindmap,
  importAsNew,
  listMindmaps,
  loadThumbnail,
} from '../lib/storage'
import type { MindmapSummary } from '../types/mindmap'

export default function MindmapsPage() {
  const navigate = useNavigate()
  const [items, setItems] = useState<MindmapSummary[]>(() => listMindmaps())
  const [newName, setNewName] = useState('')
  const [importOpen, setImportOpen] = useState(false)

  const library = useLibrary()

  const refresh = useCallback(() => setItems(listMindmaps()), [])

  /** Copies a library mindmap into local storage and opens it. */
  const addFromLibrary = (entry: LibraryEntry) => {
    const saved = importAsNew(entry.mindmap, entry.mindmap.name)
    refresh()
    navigate(`/mindmaps/${saved.id}/animate`)
  }

  const create = () => {
    const created = createMindmap(newName)
    setNewName('')
    navigate(`/mindmaps/${created.id}`)
  }

  const duplicate = (id: string) => {
    const source = getMindmap(id)
    if (!source) return
    importAsNew(source, `${source.name} (copy)`)
    refresh()
  }

  const remove = (summary: MindmapSummary) => {
    if (!window.confirm(`Delete "${summary.name}"? This cannot be undone.`)) return
    deleteMindmap(summary.id)
    refresh()
  }

  return (
    <div className="mx-auto min-h-full max-w-6xl px-6 py-8">
      <header className="mb-8 flex items-start gap-4">
        <AppLogo size={56} className="mt-0.5" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">Animated Mindmap Generator</h1>
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-slate-400">
            Draft a mindmap, generate a looping animation from it, and export a watermarked GIF or MP4 ready to post.
          </p>
        </div>
      </header>

      <div className="mb-8 flex flex-wrap items-end gap-3">
        <div className="min-w-[240px] flex-1">
          <Field label="New mindmap">
            <TextInput
              value={newName}
              onChange={setNewName}
              placeholder="Central idea…"
              maxLength={80}
              ariaLabel="New mindmap name"
            />
          </Field>
        </div>
        <Button variant="primary" onClick={create}>
          <Plus size={14} /> Create
        </Button>
        <Button onClick={() => setImportOpen(true)}>
          <FileJson size={14} /> Import JSON
        </Button>
      </div>

      {importOpen && (
        <ImportPanel
          onClose={() => setImportOpen(false)}
          onImported={id => {
            refresh()
            setImportOpen(false)
            navigate(`/mindmaps/${id}`)
          }}
        />
      )}

      {library.entries.length > 0 && (
        <section className="mb-10">
          <div className="mb-3 flex items-baseline gap-2">
            <SectionHeading>
              <span className="inline-flex items-center gap-1.5">
                <BookOpen size={13} /> Starter library
              </span>
            </SectionHeading>
            <span className="text-[11px] text-slate-600">served from public/library/</span>
          </div>

          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {library.entries.map(entry => {
              const alreadyAdded = items.some(i => i.name === entry.mindmap.name)
              return (
                <li
                  key={entry.file}
                  className="flex items-start gap-3 rounded-xl border border-ink-700 bg-ink-850/60 p-3.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate text-sm font-semibold text-slate-100">{entry.mindmap.name}</h3>
                      {entry.recommended && (
                        <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-emerald-300">
                          Recommended
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      {entry.mindmap.nodes.length} nodes · {entry.mindmap.edges.length} links
                      {alreadyAdded && ' · already added'}
                    </p>
                    {entry.note && <p className="mt-1.5 text-[11px] leading-snug text-slate-400">{entry.note}</p>}
                  </div>
                  <Button
                    variant={entry.recommended && !alreadyAdded ? 'primary' : 'outline'}
                    onClick={() => addFromLibrary(entry)}
                    title="Copy into your mindmaps and open the animated view"
                  >
                    <Plus size={13} /> Add
                  </Button>
                </li>
              )
            })}
          </ul>

          {library.problems.length > 0 && (
            <div className="mt-3">
              <Banner tone="warn">
                <ul className="list-inside list-disc space-y-0.5">
                  {library.problems.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </Banner>
            </div>
          )}
        </section>
      )}

      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-ink-700 p-12 text-center">
          <AppLogo size={72} className="opacity-40" />
          <p className="text-sm text-slate-500">
            {library.entries.length > 0
              ? 'Nothing of your own yet. Add one from the library above, or create a mindmap.'
              : 'No mindmaps yet. Create one above, or import some JSON.'}
          </p>
        </div>
      ) : (
        <>
        {library.entries.length > 0 && <SectionHeading>My mindmaps</SectionHeading>}
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map(item => {
            const thumbnail = loadThumbnail(item.id)
            return (
              <li
                key={item.id}
                className="group overflow-hidden rounded-xl border border-ink-700 bg-ink-850 transition-colors hover:border-ink-600"
              >
                <button
                  type="button"
                  onClick={() => navigate(`/mindmaps/${item.id}/animate`)}
                  className="block w-full text-left"
                  title="Open the animated view"
                >
                  <div className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-ink-950">
                    {thumbnail ? (
                      <img src={thumbnail} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="text-[11px] text-slate-600">No preview yet</span>
                    )}
                  </div>
                </button>

                <div className="p-3.5">
                  <h3 className="truncate text-sm font-semibold text-slate-100">{item.name}</h3>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    {item.node_count} {item.node_count === 1 ? 'node' : 'nodes'} ·{' '}
                    {new Date(item.updated_at).toLocaleDateString()}
                  </p>

                  <div className="mt-3 flex items-center gap-1.5">
                    <Button variant="primary" onClick={() => navigate(`/mindmaps/${item.id}/animate`)} className="flex-1">
                      <Sparkles size={13} /> Animate
                    </Button>
                    <Button onClick={() => navigate(`/mindmaps/${item.id}`)} title="Edit nodes">
                      <Pencil size={13} />
                    </Button>
                    <Button onClick={() => duplicate(item.id)} title="Duplicate">
                      <Copy size={13} />
                    </Button>
                    <Button variant="danger" onClick={() => remove(item)} title="Delete">
                      <Trash2 size={13} />
                    </Button>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
        </>
      )}
    </div>
  )
}

const MARKDOWN_EXAMPLE = `# Zero Trust, in practice

## 🔐 Identity — MFA and conditional access
- Device posture
- Session risk

## 💻 Device health — compliance before access
- Encryption check
- Patch status

## 🕸️ Microsegmentation — blast radius containment {heavy}

## 🤖 Continuous verification {planned} {semi}`

const EXAMPLE = `{
  "name": "Zero Trust, in practice",
  "nodes": [
    { "key": "hub", "label": "Zero Trust", "icon": "🛡️", "detail": "Never trust, always verify", "hero": true },
    { "key": "identity", "label": "Identity", "icon": "🔐", "detail": "MFA + conditional access" },
    { "key": "device", "label": "Device health", "icon": "💻", "detail": "Compliance before access" },
    { "key": "network", "label": "Microsegmentation", "icon": "🕸️", "detail": "Blast radius containment" }
  ],
  "edges": [
    { "from": "hub", "to": "identity" },
    { "from": "hub", "to": "device" },
    { "from": "hub", "to": "network" }
  ]
}`

type ImportMode = 'markdown' | 'json'

function ImportPanel({ onClose, onImported }: { onClose: () => void; onImported: (id: string) => void }) {
  // Markdown first: it is faster to write and read, and JSON is the fallback for machine output.
  const [mode, setMode] = useState<ImportMode>('markdown')
  const [raw, setRaw] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])

  const example = mode === 'markdown' ? MARKDOWN_EXAMPLE : EXAMPLE

  const switchMode = (next: ImportMode) => {
    setMode(next)
    setError(null)
    setWarnings([])
    // Only clear text that was the other mode's example, so real work is never discarded.
    if (raw.trim() === MARKDOWN_EXAMPLE.trim() || raw.trim() === EXAMPLE.trim()) setRaw('')
  }

  const run = () => {
    setError(null)
    setWarnings([])
    try {
      const { mindmap, format, warnings: notes } =
        mode === 'markdown' ? importMarkdown(raw, 'Mindmap') : importMindmap(raw)
      const saved = importAsNew(mindmap, mindmap.name)
      if (notes.length) {
        // Surface the notes but still navigate — they are advisory, not blocking.
        setWarnings([mode === 'markdown' ? 'Read as markdown outline.' : `Read as ${format}.`, ...notes])
        setTimeout(() => onImported(saved.id), 1800)
        return
      }
      onImported(saved.id)
    } catch (err) {
      setError(err instanceof ImportError ? err.message : err instanceof Error ? err.message : 'Import failed.')
    }
  }

  return (
    <div className="mb-8 panel">
      <SectionHeading>Import a mindmap</SectionHeading>

      <div className="mb-3 max-w-xs">
        <SegmentedControl<ImportMode>
          value={mode}
          onChange={switchMode}
          options={[
            { value: 'markdown', label: 'Markdown' },
            { value: 'json', label: 'JSON' },
          ]}
        />
      </div>

      {mode === 'markdown' ? (
        <>
          <p className="mb-2 text-xs leading-relaxed text-slate-400">
            Nested headings and bullets become the hierarchy. A leading emoji becomes the node icon, and text
            after <span className="font-mono text-slate-300">—</span> or{' '}
            <span className="font-mono text-slate-300">|</span> becomes the detail line.
          </p>
          <p className="mb-3 text-xs leading-relaxed text-slate-400">
            Optional modifiers in braces:{' '}
            <span className="font-mono text-slate-300">{'{heavy}'}</span>{' '}
            <span className="font-mono text-slate-300">{'{semi}'}</span>{' '}
            <span className="font-mono text-slate-300">{'{arrow}'}</span>{' '}
            <span className="font-mono text-slate-300">{'{planned}'}</span>{' '}
            <span className="font-mono text-slate-300">{'{gold}'}</span>
          </p>
        </>
      ) : (
        <>
          <p className="mb-2 text-xs leading-relaxed text-slate-400">
            Paste any of: the compact authoring shape, a MICA mindmap (either its API JSON or its frontend
            DTO), or a React Flow graph dump. The format is detected automatically.
          </p>
          <p className="mb-3 text-xs leading-relaxed text-slate-400">
            To build one from a reference image, hand that image and{' '}
            <span className="font-mono text-slate-300">docs/mindmap-schema.md</span> to your AI assistant and paste
            back what it returns.
          </p>
        </>
      )}

      <textarea
        value={raw}
        onChange={e => setRaw(e.target.value)}
        placeholder={example}
        spellCheck={false}
        aria-label={mode === 'markdown' ? 'Mindmap markdown outline' : 'Mindmap JSON'}
        className="h-56 w-full resize-y rounded-lg border border-ink-600 bg-ink-950 p-3 font-mono text-[11px] leading-relaxed text-slate-200 placeholder:text-slate-600 focus:border-blue-500 focus:outline-none"
      />

      <div className="mt-3 flex items-center gap-2">
        <Button variant="primary" onClick={run} disabled={!raw.trim()}>
          Import
        </Button>
        <Button onClick={() => setRaw(example)}>Use the example</Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>

      {error && (
        <div className="mt-3">
          <Banner tone="error">{error}</Banner>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="mt-3">
          <Banner tone="warn">
            <ul className="list-inside list-disc space-y-0.5">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </Banner>
        </div>
      )}
    </div>
  )
}

/** Re-exported for the editor's "copy as JSON" action, keeping the schema in one place. */
export { exportAuthoringJson }

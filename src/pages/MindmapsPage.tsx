import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Copy, FileJson, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react'
import AppLogo from '../components/AppLogo'
import { Banner, Button, Field, SectionHeading, TextInput } from '../components/ui'
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

  const refresh = useCallback(() => setItems(listMindmaps()), [])

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

      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-ink-700 p-12 text-center">
          <AppLogo size={72} className="opacity-40" />
          <p className="text-sm text-slate-500">No mindmaps yet. Create one above, or import some JSON.</p>
        </div>
      ) : (
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
      )}
    </div>
  )
}

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

function ImportPanel({ onClose, onImported }: { onClose: () => void; onImported: (id: string) => void }) {
  const [raw, setRaw] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])

  const run = () => {
    setError(null)
    setWarnings([])
    try {
      const { mindmap, format, warnings: notes } = importMindmap(raw)
      const saved = importAsNew(mindmap, mindmap.name)
      if (notes.length) {
        // Surface the notes but still navigate — they are advisory, not blocking.
        setWarnings([`Read as ${format}.`, ...notes])
        setTimeout(() => onImported(saved.id), 1400)
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
      <p className="mb-3 text-xs leading-relaxed text-slate-400">
        Paste any of: the compact authoring shape below, a MICA mindmap (either its API JSON or its
        frontend DTO), or a React Flow graph dump. The format is detected automatically.
      </p>
      <p className="mb-3 text-xs leading-relaxed text-slate-400">
        To build one from a reference image, hand that image and{' '}
        <span className="font-mono text-slate-300">docs/mindmap-schema.md</span> to your AI assistant and paste back what
        it returns.
      </p>

      <textarea
        value={raw}
        onChange={e => setRaw(e.target.value)}
        placeholder={EXAMPLE}
        spellCheck={false}
        aria-label="Mindmap JSON"
        className="h-56 w-full resize-y rounded-lg border border-ink-600 bg-ink-950 p-3 font-mono text-[11px] leading-relaxed text-slate-200 placeholder:text-slate-600 focus:border-blue-500 focus:outline-none"
      />

      <div className="mt-3 flex items-center gap-2">
        <Button variant="primary" onClick={run} disabled={!raw.trim()}>
          Import
        </Button>
        <Button onClick={() => setRaw(EXAMPLE)}>Use the example</Button>
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

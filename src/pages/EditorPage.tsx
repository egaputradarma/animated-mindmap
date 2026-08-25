import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import ReactFlow, {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  ConnectionMode,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlowProvider,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { ArrowLeft, Check, Clipboard, Plus, Sparkles, Trash2 } from 'lucide-react'
import AppLogo from '../components/AppLogo'
import { Banner, Button, Field, SectionHeading, Select, TextInput, Toggle } from '../components/ui'
import { exportAuthoringJson } from '../lib/importMindmap'
import { accentColour, rgba } from '../lib/palette'
import { getMindmap, saveMindmap } from '../lib/storage'
import { uid } from '../lib/id'
import { ACCENT_NAMES, emptyNode, type AccentName, type Mindmap, type MindmapNode } from '../types/mindmap'

/** React Flow node payload. Carries the domain node straight through. */
interface CardData {
  node: MindmapNode
}

// Every side is a source; ConnectionMode.Loose then allows any handle to act as a target. This
// mirrors MICA's canvas, where a connection can leave and enter a card on whichever side reads
// best rather than being pinned to a fixed in/out pair.
const HANDLE_SIDES = [
  { id: 't', position: Position.Top },
  { id: 'r', position: Position.Right },
  { id: 'b', position: Position.Bottom },
  { id: 'l', position: Position.Left },
] as const

function CardNode({ data, selected }: NodeProps<CardData>) {
  const { node } = data
  const colour = accentColour('dark', node.accent ?? 'slate')

  return (
    <div
      className={`min-w-[150px] max-w-[220px] rounded-lg border bg-ink-850 px-3 py-2 shadow-lg transition-colors ${
        selected ? 'border-blue-400' : 'border-ink-600'
      }`}
      style={{ borderLeft: `3px solid ${rgba(colour)}`, borderStyle: node.reserved ? 'dashed' : undefined }}
    >
      {HANDLE_SIDES.map(side => (
        <Handle
          key={side.id}
          id={side.id}
          type="source"
          position={side.position}
          className="!h-2 !w-2 !border-ink-900 !bg-slate-500"
        />
      ))}

      <div className="flex items-center gap-1.5">
        {node.icon && <span className="text-sm leading-none">{node.icon}</span>}
        <span className="truncate text-xs font-semibold text-slate-100">{node.label}</span>
        {node.hero && <span className="ml-auto text-[9px] uppercase tracking-wide text-blue-300">hub</span>}
      </div>
      {node.detail && <p className="mt-1 line-clamp-2 text-[10px] leading-snug text-slate-400">{node.detail}</p>}
    </div>
  )
}

const NODE_TYPES = { card: CardNode }

export default function EditorPage() {
  return (
    <ReactFlowProvider>
      <EditorInner />
    </ReactFlowProvider>
  )
}

function EditorInner() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [mindmap, setMindmap] = useState<Mindmap | null | 'missing'>(null)
  const [nodes, setNodes] = useState<Node<CardData>[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  // Guards the autosave effect from firing on the initial hydration.
  const hydrated = useRef(false)

  useEffect(() => {
    if (!id) return
    const loaded = getMindmap(id)
    if (!loaded) {
      setMindmap('missing')
      return
    }
    setMindmap(loaded)
    setName(loaded.name)
    setNodes(
      loaded.nodes.map(node => ({
        id: node.node_key,
        type: 'card',
        position: { x: node.position_x, y: node.position_y },
        data: { node },
      })),
    )
    setEdges(
      loaded.edges.map(edge => ({
        id: edge.id,
        source: edge.source_node_key,
        target: edge.target_node_key,
        label: edge.label ?? undefined,
        animated: !edge.dashed,
        style: { stroke: '#475569', strokeDasharray: edge.dashed ? '6 5' : undefined },
      })),
    )
    hydrated.current = true
  }, [id])

  const selectedNode = useMemo(() => nodes.find(n => n.id === selectedId) ?? null, [nodes, selectedId])

  const toMindmap = useCallback((): Mindmap | null => {
    if (!mindmap || mindmap === 'missing') return null
    return {
      ...mindmap,
      name: name.trim() || mindmap.name,
      nodes: nodes.map(n => ({
        ...n.data.node,
        // React Flow owns position while editing, so it is authoritative on save.
        position_x: Math.round(n.position.x),
        position_y: Math.round(n.position.y),
      })),
      edges: edges.map(e => ({
        id: e.id,
        source_node_key: e.source,
        target_node_key: e.target,
        label: typeof e.label === 'string' ? e.label : null,
        dashed: typeof e.style?.strokeDasharray === 'string',
      })),
    }
  }, [mindmap, name, nodes, edges])

  const persist = useCallback(() => {
    const next = toMindmap()
    if (!next) return null
    const stored = saveMindmap(next)
    setMindmap(stored)
    return stored
  }, [toMindmap])

  // Debounced autosave. Local storage writes are cheap and there is no server round-trip or
  // concurrency to coordinate, so an explicit Save button would be friction for no benefit —
  // it stays only as a way to confirm the write landed.
  useEffect(() => {
    if (!hydrated.current || !mindmap || mindmap === 'missing') return
    const timer = setTimeout(() => {
      try {
        persist()
      } catch {
        /* surfaced on the explicit save instead */
      }
    }, 800)
    return () => clearTimeout(timer)
  }, [nodes, edges, name, mindmap, persist])

  const patchSelected = (patch: Partial<MindmapNode>) => {
    if (!selectedId) return
    setNodes(current =>
      current.map(n => {
        if (n.id !== selectedId) return n
        return { ...n, data: { node: { ...n.data.node, ...patch } } }
      }),
    )
  }

  /** Only one node may be the hub, so setting it clears the flag everywhere else. */
  const setHero = (value: boolean) => {
    if (!selectedId) return
    setNodes(current =>
      current.map(n => ({
        ...n,
        data: { node: { ...n.data.node, hero: value && n.id === selectedId } },
      })),
    )
  }

  const addNode = () => {
    const key = uid('n')
    // Offset from the selection so a new node lands somewhere visible rather than under an
    // existing one.
    const anchor = selectedNode?.position ?? { x: 0, y: 0 }
    const node = emptyNode(key, anchor.x + 220, anchor.y + 60)
    setNodes(current => [...current, { id: key, type: 'card', position: { x: node.position_x, y: node.position_y }, data: { node } }])

    // Wire it to the selection immediately — an orphan node contributes nothing to the layout.
    if (selectedId) {
      setEdges(current => [
        ...current,
        { id: uid('e'), source: selectedId, target: key, animated: true, style: { stroke: '#475569' } },
      ])
    }
    setSelectedId(key)
  }

  const deleteSelected = () => {
    if (!selectedId || nodes.length <= 1) return
    setNodes(current => current.filter(n => n.id !== selectedId))
    setEdges(current => current.filter(e => e.source !== selectedId && e.target !== selectedId))
    setSelectedId(null)
  }

  const copyJson = async () => {
    const next = toMindmap()
    if (!next) return
    await navigator.clipboard.writeText(exportAuthoringJson(next))
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  const goAnimate = () => {
    const stored = persist()
    if (stored) navigate(`/mindmaps/${stored.id}/animate`)
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
  if (!mindmap) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-slate-500">Loading…</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-ink-800 bg-ink-900/80 px-4 py-2.5">
        <Link
          to="/mindmaps"
          className="inline-flex items-center gap-1.5 text-sm text-slate-400 transition-colors hover:text-slate-100"
        >
          <AppLogo size={22} />
          <ArrowLeft size={15} /> Mindmaps
        </Link>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          onBlur={() => {
            if (!name.trim()) setName(mindmap.name)
          }}
          maxLength={80}
          aria-label="Mindmap name"
          className="ml-2 min-w-0 max-w-xs flex-1 truncate rounded border border-transparent bg-transparent px-1.5 py-0.5 font-semibold text-slate-100 hover:border-ink-600 focus:border-blue-500 focus:outline-none"
        />
        <div className="ml-auto flex items-center gap-2">
          <Button onClick={addNode}>
            <Plus size={14} /> Add node
          </Button>
          <Button onClick={copyJson} title="Copy as authoring JSON">
            {copied ? <Check size={14} /> : <Clipboard size={14} />} {copied ? 'Copied' : 'Copy JSON'}
          </Button>
          <Button
            onClick={() => {
              persist()
              setSaved(true)
              setTimeout(() => setSaved(false), 1500)
            }}
          >
            {saved ? <Check size={14} /> : null} {saved ? 'Saved' : 'Save'}
          </Button>
          <Button variant="primary" onClick={goAnimate}>
            <Sparkles size={14} /> Generate Animated
          </Button>
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={(changes: NodeChange[]) => setNodes(current => applyNodeChanges(changes, current))}
          onEdgesChange={(changes: EdgeChange[]) => setEdges(current => applyEdgeChanges(changes, current))}
          onConnect={(connection: Connection) =>
            setEdges(current =>
              addEdge({ ...connection, id: uid('e'), animated: true, style: { stroke: '#475569' } }, current),
            )
          }
          onNodeClick={(_e, node) => setSelectedId(node.id)}
          onPaneClick={() => setSelectedId(null)}
          connectionMode={ConnectionMode.Loose}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#1e293b" gap={22} />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            maskColor="rgba(8,11,20,0.7)"
            nodeColor={n => rgba(accentColour('dark', (n.data as CardData).node.accent ?? 'slate'))}
            style={{ background: '#0d1120', border: '1px solid #232d45' }}
          />
        </ReactFlow>

        {selectedNode && (
          <aside className="absolute right-3 top-3 z-10 w-72 space-y-3 rounded-xl border border-ink-700 bg-ink-900/95 p-4 shadow-2xl backdrop-blur">
            <SectionHeading>Node</SectionHeading>

            <Field label="Label">
              <TextInput
                value={selectedNode.data.node.label}
                onChange={v => patchSelected({ label: v })}
                maxLength={60}
                ariaLabel="Node label"
              />
            </Field>
            <Field label="Icon" hint="One emoji, or a couple of letters.">
              <TextInput
                value={selectedNode.data.node.icon ?? ''}
                onChange={v => patchSelected({ icon: v || null })}
                placeholder="💡"
                maxLength={4}
                ariaLabel="Node icon"
              />
            </Field>
            <Field label="Detail" hint="The muted line under the title. Keep it to a phrase.">
              <TextInput
                value={selectedNode.data.node.detail ?? ''}
                onChange={v => patchSelected({ detail: v || null })}
                placeholder="Optional"
                maxLength={110}
                ariaLabel="Node detail"
              />
            </Field>
            <Field label="Accent" hint="Auto colours each branch from the hub outward.">
              <Select<AccentName | 'auto'>
                value={selectedNode.data.node.accent ?? 'auto'}
                onChange={v => patchSelected({ accent: v === 'auto' ? null : v })}
                options={[
                  { value: 'auto', label: 'Auto (by branch)' },
                  ...ACCENT_NAMES.map(a => ({ value: a, label: a[0].toUpperCase() + a.slice(1) })),
                ]}
                ariaLabel="Node accent colour"
              />
            </Field>

            <Toggle checked={selectedNode.data.node.hero === true} onChange={setHero} label="Hub node" />
            <Toggle
              checked={selectedNode.data.node.reserved === true}
              onChange={v => patchSelected({ reserved: v })}
              label="Planned / not wired"
            />
            {selectedNode.data.node.reserved && (
              <Field label="Tag">
                <TextInput
                  value={selectedNode.data.node.tag ?? ''}
                  onChange={v => patchSelected({ tag: v || null })}
                  placeholder="e.g. planned · post v1.0"
                  maxLength={40}
                  ariaLabel="Node tag"
                />
              </Field>
            )}

            <Button variant="danger" onClick={deleteSelected} disabled={nodes.length <= 1} className="w-full">
              <Trash2 size={13} /> Delete node
            </Button>
            {nodes.length <= 1 && <p className="text-[11px] text-slate-500">A mindmap needs at least one node.</p>}
          </aside>
        )}

        {!selectedNode && (
          <div className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2">
            <Banner tone="info">
              Click a node to edit it · drag from any edge of a card to connect · positions only matter in
              &ldquo;As arranged&rdquo; mode
            </Banner>
          </div>
        )}
      </div>
    </div>
  )
}

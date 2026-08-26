import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import ReactFlow, {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  ConnectionMode,
  Controls,
  Handle,
  MarkerType,
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
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalSpaceAround,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalSpaceAround,
  ArrowLeft,
  ArrowLeftRight,
  Check,
  Clipboard,
  LayoutGrid,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react'
import AppLogo from '../components/AppLogo'
import {
  Banner,
  Button,
  Field,
  SectionHeading,
  SegmentedControl,
  Select,
  TextInput,
  Toggle,
} from '../components/ui'
import {
  alignBoxes,
  distributeBoxes,
  gridBoxes,
  type AlignMode,
  type Box,
  type DistributeAxis,
} from '../lib/arrange'
import { exportAuthoringJson } from '../lib/importMindmap'
import { accentColour, rgba } from '../lib/palette'
import { getMindmap, saveMindmap } from '../lib/storage'
import { uid } from '../lib/id'
import {
  ACCENT_NAMES,
  DEFAULT_EDGE_ARROW,
  DEFAULT_EDGE_WEIGHT,
  EDGE_ARROW_LABELS,
  EDGE_ARROWS,
  EDGE_SIDE_LABELS,
  EDGE_SIDES,
  EDGE_WEIGHT_LABELS,
  EDGE_WEIGHTS,
  edgeArrowOf,
  edgeSourceSideOf,
  edgeTargetSideOf,
  edgeWeightOf,
  emptyNode,
  type AccentName,
  type EdgeArrow,
  type EdgeSide,
  type EdgeWeight,
  type Mindmap,
  type MindmapEdge,
  type MindmapNode,
} from '../types/mindmap'

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

/**
 * Editor card width, fixed rather than content-sized.
 *
 * The animation draws every card at one width, so letting these grow with their text would mean edges
 * that line up here do not line up there — which would make the alignment tools lie.
 */
const CARD_WIDTH = 168

function CardNode({ data, selected }: NodeProps<CardData>) {
  const { node } = data
  const colour = accentColour('dark', node.accent ?? 'slate')

  return (
    <div
      className={`rounded-lg border bg-ink-850 px-3 py-2 shadow-lg transition-colors ${
        selected ? 'border-blue-400' : 'border-ink-600'
      }`}
      style={{
        width: CARD_WIDTH,
        borderLeft: `3px solid ${rgba(colour)}`,
        borderStyle: node.reserved ? 'dashed' : undefined,
      }}
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

/** Square icon button for the alignment toolbar. Label carries the meaning for screen readers. */
function IconAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-ink-800 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
    >
      {children}
    </button>
  )
}

/** Presentation rides along on the React Flow edge so `style` stays a derived value. */
interface EdgeData {
  weight: EdgeWeight
  arrow: EdgeArrow
  sourceSide: EdgeSide
  targetSide: EdgeSide
}

/** Side names map onto the four handle ids declared on every card. */
const SIDE_TO_HANDLE: Record<Exclude<EdgeSide, 'auto'>, string> = {
  top: 't',
  right: 'r',
  bottom: 'b',
  left: 'l',
}

const HANDLE_TO_SIDE: Record<string, EdgeSide> = { t: 'top', r: 'right', b: 'bottom', l: 'left' }

/**
 * React Flow always needs a concrete handle to draw from, so `auto` has to resolve to something. It
 * picks the pair of faces that point at each other, which is the closest the editor can get to the
 * animation's centre-to-centre line.
 */
function autoHandles(
  nodes: Node<CardData>[],
  sourceKey: string,
  targetKey: string,
): { source: string; target: string } {
  const a = nodes.find(n => n.id === sourceKey)?.position
  const b = nodes.find(n => n.id === targetKey)?.position
  if (!a || !b) return { source: 'r', target: 'l' }

  const dx = b.x - a.x
  const dy = b.y - a.y
  // Whichever axis dominates decides the faces used.
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { source: 'r', target: 'l' } : { source: 'l', target: 'r' }
  }
  return dy >= 0 ? { source: 'b', target: 't' } : { source: 't', target: 'b' }
}

const EDGE_STROKE = '#64748b'

/** Editor preview of a weight, chosen to echo what renderer.ts draws in the animation. */
const FLOW_WEIGHT: Record<EdgeWeight, { width: number; dash?: string }> = {
  heavy: { width: 3.4 },
  standard: { width: 1.8 },
  semi: { width: 1.5, dash: '7 6' },
}

const ARROW_MARKER = { type: MarkerType.ArrowClosed, color: EDGE_STROKE, width: 18, height: 18 } as const

/** Explains each weight in the terms the feature was asked for. */
const WEIGHT_HINTS: Record<EdgeWeight, string> = {
  heavy: 'Heavy delivery — thick solid line, larger packet.',
  standard: 'Standard delivery — normal solid line.',
  semi: 'Semi delivery — thinner dashed line.',
}

const currentWeight = (edge: Edge): EdgeWeight => ((edge.data as Partial<EdgeData>)?.weight ?? DEFAULT_EDGE_WEIGHT)
const currentArrow = (edge: Edge): EdgeArrow => ((edge.data as Partial<EdgeData>)?.arrow ?? DEFAULT_EDGE_ARROW)
const currentSourceSide = (edge: Edge): EdgeSide => ((edge.data as Partial<EdgeData>)?.sourceSide ?? 'auto')
const currentTargetSide = (edge: Edge): EdgeSide => ((edge.data as Partial<EdgeData>)?.targetSide ?? 'auto')

/** Human-readable node name for the connection header, falling back to the key. */
const labelFor = (nodes: Node<CardData>[], key: string): string =>
  nodes.find(n => n.id === key)?.data.node.label ?? key

/**
 * Maps a domain edge onto the React Flow edge the canvas renders.
 *
 * `nodes` is only needed to resolve `auto` sides to concrete handles; pass it whenever positions are
 * known so the editor preview matches what the animation will draw.
 */
function toFlowEdge(edge: MindmapEdge, nodes: Node<CardData>[] = []): Edge {
  const weight = edgeWeightOf(edge)
  const arrow = edgeArrowOf(edge)
  const sourceSide = edgeSourceSideOf(edge)
  const targetSide = edgeTargetSideOf(edge)
  const style = FLOW_WEIGHT[weight]

  const auto = autoHandles(nodes, edge.source_node_key, edge.target_node_key)

  return {
    id: edge.id,
    source: edge.source_node_key,
    target: edge.target_node_key,
    sourceHandle: sourceSide === 'auto' ? auto.source : SIDE_TO_HANDLE[sourceSide],
    targetHandle: targetSide === 'auto' ? auto.target : SIDE_TO_HANDLE[targetSide],
    label: edge.label ?? undefined,
    data: { weight, arrow, sourceSide, targetSide } satisfies EdgeData,
    // Only the flowing weights animate, mirroring the packet suppression in the animation.
    animated: weight !== 'semi',
    style: { stroke: EDGE_STROKE, strokeWidth: style.width, strokeDasharray: style.dash },
    markerEnd: arrow === 'end' || arrow === 'both' ? ARROW_MARKER : undefined,
    markerStart: arrow === 'start' || arrow === 'both' ? ARROW_MARKER : undefined,
    labelStyle: { fill: '#cbd5e1', fontSize: 11 },
    labelBgStyle: { fill: '#0d1120' },
    labelBgPadding: [6, 3] as [number, number],
    labelBgBorderRadius: 4,
  }
}

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
  // One selection across both kinds, so picking an edge clears any selected node and the inspector
  // never has to guess which panel to show.
  const [selected, setSelected] = useState<{ kind: 'node' | 'edge'; id: string } | null>(null)
  const selectedId = selected?.kind === 'node' ? selected.id : null
  const selectedEdgeId = selected?.kind === 'edge' ? selected.id : null
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
    const flowNodes = loaded.nodes.map(node => ({
      id: node.node_key,
      type: 'card',
      position: { x: node.position_x, y: node.position_y },
      data: { node },
    }))
    setEdges(loaded.edges.map(edge => toFlowEdge(edge, flowNodes)))
    hydrated.current = true
  }, [id])

  const selectedNode = useMemo(() => nodes.find(n => n.id === selectedId) ?? null, [nodes, selectedId])
  const selectedEdge = useMemo(
    () => edges.find(e => e.id === selectedEdgeId) ?? null,
    [edges, selectedEdgeId],
  )

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
      edges: edges.map(e => {
        // Weight and arrow live in `data`, and the React Flow `style` is derived from them. Reading
        // them back out of the rendered style would mean parsing a dasharray string to recover a
        // value we already had.
        const data = (e.data ?? {}) as Partial<EdgeData>
        return {
          id: e.id,
          source_node_key: e.source,
          target_node_key: e.target,
          label: typeof e.label === 'string' && e.label ? e.label : null,
          weight: data.weight ?? DEFAULT_EDGE_WEIGHT,
          arrow: data.arrow ?? DEFAULT_EDGE_ARROW,
          source_side: data.sourceSide ?? 'auto',
          target_side: data.targetSide ?? 'auto',
        }
      }),
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

  /** Applies a change to the selected edge and re-derives its rendered style. */
  const patchSelectedEdge = (patch: Partial<EdgeData> & { label?: string | null }) => {
    if (!selectedEdgeId) return
    setEdges(current =>
      current.map(e => {
        if (e.id !== selectedEdgeId) return e
        const data = (e.data ?? {}) as Partial<EdgeData>
        // Rebuilt through toFlowEdge rather than patched in place, so style, markers, handles and the
        // animated flag cannot drift out of step with the underlying values.
        return toFlowEdge(
          {
            id: e.id,
            source_node_key: e.source,
            target_node_key: e.target,
            label: patch.label !== undefined ? patch.label : typeof e.label === 'string' ? e.label : null,
            weight: patch.weight ?? data.weight ?? DEFAULT_EDGE_WEIGHT,
            arrow: patch.arrow ?? data.arrow ?? DEFAULT_EDGE_ARROW,
            source_side: patch.sourceSide ?? data.sourceSide ?? 'auto',
            target_side: patch.targetSide ?? data.targetSide ?? 'auto',
          },
          nodes,
        )
      }),
    )
  }

  /**
   * Boxes for the currently multi-selected nodes.
   *
   * Measured dimensions come from React Flow once a node has rendered; before that they are null, so
   * the fixed card width and a rough height stand in. Falling back matters because an alignment run
   * immediately after adding a node would otherwise treat it as zero-sized.
   */
  const selectedBoxes = useMemo<Box[]>(
    () =>
      nodes
        .filter(n => n.selected)
        .map(n => ({
          key: n.id,
          x: n.position.x,
          y: n.position.y,
          width: n.width ?? CARD_WIDTH,
          height: n.height ?? 64,
        })),
    [nodes],
  )

  /** Writes a set of computed positions back onto the nodes. */
  const applyPlacements = (placements: Map<string, { x: number; y: number }>) => {
    if (placements.size === 0) return
    setNodes(current =>
      current.map(n => {
        const next = placements.get(n.id)
        return next ? { ...n, position: next } : n
      }),
    )
  }

  const runAlign = (mode: AlignMode) => applyPlacements(alignBoxes(selectedBoxes, mode))
  const runDistribute = (axis: DistributeAxis) => applyPlacements(distributeBoxes(selectedBoxes, axis))
  const runGrid = () =>
    applyPlacements(gridBoxes(selectedBoxes, Math.max(2, Math.round(Math.sqrt(selectedBoxes.length)))))

  const deleteSelectedEdge = () => {
    if (!selectedEdgeId) return
    setEdges(current => current.filter(e => e.id !== selectedEdgeId))
    setSelected(null)
  }

  /** Swaps which end is source and which is target, flipping the connection's direction. */
  const reverseSelectedEdge = () => {
    if (!selectedEdgeId) return
    setEdges(current =>
      current.map(e => {
        if (e.id !== selectedEdgeId) return e
        const data = (e.data ?? {}) as Partial<EdgeData>
        return toFlowEdge(
          {
            id: e.id,
            source_node_key: e.target,
            target_node_key: e.source,
            label: typeof e.label === 'string' ? e.label : null,
            weight: data.weight ?? DEFAULT_EDGE_WEIGHT,
            arrow: data.arrow ?? DEFAULT_EDGE_ARROW,
            // Sides swap with the ends, or reversing would move where the line attaches.
            source_side: data.targetSide ?? 'auto',
            target_side: data.sourceSide ?? 'auto',
          },
          nodes,
        )
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
      const created = toFlowEdge(
        {
          id: uid('e'),
          source_node_key: selectedId,
          target_node_key: key,
          label: null,
          weight: DEFAULT_EDGE_WEIGHT,
          arrow: DEFAULT_EDGE_ARROW,
        },
        nodes,
      )
      setEdges(current => [...current, created])
    }
    setSelected({ kind: 'node', id: key })
  }

  const deleteSelected = () => {
    if (!selectedId || nodes.length <= 1) return
    setNodes(current => current.filter(n => n.id !== selectedId))
    setEdges(current => current.filter(e => e.source !== selectedId && e.target !== selectedId))
    setSelected(null)
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
          onConnect={(connection: Connection) => {
            if (!connection.source || !connection.target) return
            // The handles dragged between are recorded as explicit sides. Dragging from a specific dot
            // is a clear statement of intent, and discarding it would snap the line somewhere else the
            // moment it was drawn.
            const created = toFlowEdge(
              {
                id: uid('e'),
                source_node_key: connection.source,
                target_node_key: connection.target,
                label: null,
                weight: DEFAULT_EDGE_WEIGHT,
                arrow: DEFAULT_EDGE_ARROW,
                source_side: HANDLE_TO_SIDE[connection.sourceHandle ?? ''] ?? 'auto',
                target_side: HANDLE_TO_SIDE[connection.targetHandle ?? ''] ?? 'auto',
              },
              nodes,
            )
            // addEdge still runs so React Flow's own duplicate-connection guard applies.
            setEdges(current => addEdge(created, current))
          }}
          onNodeClick={(_e, node) => setSelected({ kind: 'node', id: node.id })}
          onEdgeClick={(_e, edge) => setSelected({ kind: 'edge', id: edge.id })}
          onPaneClick={() => setSelected(null)}
          connectionMode={ConnectionMode.Loose}
          fitView
          proOptions={{ hideAttribution: true }}
          // Shift-drag draws a selection box; the alignment tools need more than one node to act on.
          selectionOnDrag
          panOnDrag={[1, 2]}
          selectionKeyCode="Shift"
          multiSelectionKeyCode={['Control', 'Meta']}
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

        {selectedEdge && (
          <aside className="absolute right-3 top-3 z-10 w-72 space-y-3 rounded-xl border border-ink-700 bg-ink-900/95 p-4 shadow-2xl backdrop-blur">
            <SectionHeading>Connection</SectionHeading>

            <p className="text-[11px] leading-snug text-slate-500">
              <span className="text-slate-300">{labelFor(nodes, selectedEdge.source)}</span>
              {' → '}
              <span className="text-slate-300">{labelFor(nodes, selectedEdge.target)}</span>
            </p>

            <Field label="Type" hint={WEIGHT_HINTS[currentWeight(selectedEdge)]}>
              <SegmentedControl<EdgeWeight>
                value={currentWeight(selectedEdge)}
                onChange={v => patchSelectedEdge({ weight: v })}
                options={EDGE_WEIGHTS.map(w => ({ value: w, label: EDGE_WEIGHT_LABELS[w] }))}
              />
            </Field>

            <Field label="Arrows" hint="Which ends of the line get an arrowhead.">
              <SegmentedControl<EdgeArrow>
                value={currentArrow(selectedEdge)}
                onChange={v => patchSelectedEdge({ arrow: v })}
                options={EDGE_ARROWS.map(a => ({ value: a, label: EDGE_ARROW_LABELS[a] }))}
              />
            </Field>

            <div className="grid grid-cols-2 gap-2">
              <Field label="Leaves from">
                <Select<EdgeSide>
                  value={currentSourceSide(selectedEdge)}
                  onChange={v => patchSelectedEdge({ sourceSide: v })}
                  options={EDGE_SIDES.map(s => ({ value: s, label: EDGE_SIDE_LABELS[s] }))}
                  ariaLabel="Side the connection leaves from"
                />
              </Field>
              <Field label="Arrives at">
                <Select<EdgeSide>
                  value={currentTargetSide(selectedEdge)}
                  onChange={v => patchSelectedEdge({ targetSide: v })}
                  options={EDGE_SIDES.map(s => ({ value: s, label: EDGE_SIDE_LABELS[s] }))}
                  ariaLabel="Side the connection arrives at"
                />
              </Field>
            </div>
            <p className="text-[11px] leading-snug text-slate-500">
              Auto runs the line centre to centre and clips it at the card edge. Naming a side makes the
              line leave perpendicular to that face. You can also just drag between the dots on each card.
            </p>

            <Field label="Label" hint="Optional chip drawn mid-line.">
              <TextInput
                value={typeof selectedEdge.label === 'string' ? selectedEdge.label : ''}
                onChange={v => patchSelectedEdge({ label: v || null })}
                placeholder="e.g. to-be"
                maxLength={40}
                ariaLabel="Connection label"
              />
            </Field>

            <Button onClick={reverseSelectedEdge} className="w-full">
              <ArrowLeftRight size={13} /> Reverse direction
            </Button>
            <Button variant="danger" onClick={deleteSelectedEdge} className="w-full">
              <Trash2 size={13} /> Delete connection
            </Button>
          </aside>
        )}

        {/* Alignment toolbar. Only useful with a multi-selection, so it appears with one. */}
        {selectedBoxes.length >= 2 && (
          <div className="absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-xl border border-ink-700 bg-ink-900/95 p-2 shadow-2xl backdrop-blur">
            <div className="flex items-center gap-1">
              <span className="px-1.5 text-[11px] font-medium text-slate-500">{selectedBoxes.length} selected</span>

              <span className="mx-1 h-5 w-px bg-ink-700" />
              <IconAction label="Align left" onClick={() => runAlign('left')}>
                <AlignStartVertical size={15} />
              </IconAction>
              <IconAction label="Align horizontal centres" onClick={() => runAlign('center-x')}>
                <AlignCenterVertical size={15} />
              </IconAction>
              <IconAction label="Align right" onClick={() => runAlign('right')}>
                <AlignEndVertical size={15} />
              </IconAction>

              <span className="mx-1 h-5 w-px bg-ink-700" />
              <IconAction label="Align top" onClick={() => runAlign('top')}>
                <AlignStartHorizontal size={15} />
              </IconAction>
              <IconAction label="Align vertical middles" onClick={() => runAlign('middle')}>
                <AlignCenterHorizontal size={15} />
              </IconAction>
              <IconAction label="Align bottom" onClick={() => runAlign('bottom')}>
                <AlignEndHorizontal size={15} />
              </IconAction>

              <span className="mx-1 h-5 w-px bg-ink-700" />
              <IconAction
                label="Distribute horizontally (equal gaps)"
                disabled={selectedBoxes.length < 3}
                onClick={() => runDistribute('horizontal')}
              >
                <AlignHorizontalSpaceAround size={15} />
              </IconAction>
              <IconAction
                label="Distribute vertically (equal gaps)"
                disabled={selectedBoxes.length < 3}
                onClick={() => runDistribute('vertical')}
              >
                <AlignVerticalSpaceAround size={15} />
              </IconAction>
              <IconAction label="Arrange in a grid" onClick={runGrid}>
                <LayoutGrid size={15} />
              </IconAction>
            </div>
            <p className="mt-1.5 px-1.5 text-[10px] leading-snug text-slate-600">
              Applies in &ldquo;As arranged&rdquo; mode. Distribute needs three or more.
            </p>
          </div>
        )}

        {!selectedNode && !selectedEdge && selectedBoxes.length < 2 && (
          <div className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2">
            <Banner tone="info">
              Click a node or a connection to edit it · shift-drag to select several and align them ·
              positions only matter in &ldquo;As arranged&rdquo; mode
            </Banner>
          </div>
        )}
      </div>
    </div>
  )
}

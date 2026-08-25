// localStorage persistence.
//
// No backend on purpose: this tool produces personal content, has no sharing or permission
// model to enforce, and every mindmap it holds is small. MICA already owns the multi-user,
// audited, server-persisted case — duplicating that here would mean auth, an API and a
// database for what is a single-user scratchpad.
//
// Every read is defensive. localStorage is shared with anything else on the origin, survives
// across versions of this code, and is user-editable via devtools, so a malformed or
// stale-shaped payload is a normal condition rather than an exceptional one. A bad record is
// dropped, never thrown.

import { uid } from './id'
import type { Mindmap, MindmapSummary } from '../types/mindmap'
import { summarise } from '../types/mindmap'
import type { SignatureOptions } from './signature'
import type { CompositionSpec } from './composition'

const MINDMAPS_KEY = 'amg.mindmaps.v1'
const SETTINGS_KEY = 'amg.settings.v1'
const SIGNATURE_KEY = 'amg.signature.v1'
const THUMBNAIL_KEY = 'amg.thumbnails.v1'

type Stored = Record<string, Mindmap>

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const parsed: unknown = JSON.parse(raw)
    return parsed === null || typeof parsed !== 'object' ? fallback : (parsed as T)
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (err) {
    // Quota is the realistic failure, and thumbnails are the realistic cause. Surfacing it
    // here rather than swallowing it lets the caller decide whether the write mattered.
    throw new Error(
      `Could not save to local storage${err instanceof Error ? ` (${err.name})` : ''}. Browser storage may be full.`,
    )
  }
}

/** Rejects anything that would crash the layout — missing keys, absent nodes, wrong types. */
function isUsableMindmap(value: unknown): value is Mindmap {
  if (typeof value !== 'object' || value === null) return false
  const m = value as Partial<Mindmap>
  return (
    typeof m.id === 'string' &&
    typeof m.name === 'string' &&
    Array.isArray(m.nodes) &&
    m.nodes.length > 0 &&
    m.nodes.every(n => typeof n?.node_key === 'string') &&
    Array.isArray(m.edges)
  )
}

function readAll(): Stored {
  const raw = readJson<Record<string, unknown>>(MINDMAPS_KEY, {})
  const clean: Stored = {}
  for (const [id, value] of Object.entries(raw)) if (isUsableMindmap(value)) clean[id] = value
  return clean
}

export function listMindmaps(): MindmapSummary[] {
  return Object.values(readAll())
    .map(summarise)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
}

export const getMindmap = (id: string): Mindmap | null => readAll()[id] ?? null

export function saveMindmap(mindmap: Mindmap): Mindmap {
  const all = readAll()
  const next: Mindmap = { ...mindmap, updated_at: new Date().toISOString() }
  all[next.id] = next
  writeJson(MINDMAPS_KEY, all)
  return next
}

export function deleteMindmap(id: string): void {
  const all = readAll()
  delete all[id]
  writeJson(MINDMAPS_KEY, all)

  const thumbnails = readJson<Record<string, string>>(THUMBNAIL_KEY, {})
  delete thumbnails[id]
  writeJson(THUMBNAIL_KEY, thumbnails)
}

export function createMindmap(name: string): Mindmap {
  const id = uid('mm')
  return saveMindmap({
    id,
    name: name.trim() || 'Untitled mindmap',
    description: null,
    // A blank canvas would break the layout, which requires at least one node. Seeding the hub
    // also gives the editor something to attach the first child to.
    nodes: [
      {
        node_key: 'hub',
        label: name.trim() || 'Central idea',
        position_x: 0,
        position_y: 0,
        icon: '💡',
        detail: null,
        accent: 'blue',
        hero: true,
        reserved: false,
        tag: null,
      },
    ],
    edges: [],
    updated_at: new Date().toISOString(),
  })
}

/** Copies a mindmap under a new id. Used by "Duplicate" and by importing over an existing map. */
export function importAsNew(mindmap: Mindmap, name?: string): Mindmap {
  return saveMindmap({ ...mindmap, id: uid('mm'), name: name ?? mindmap.name })
}

// ── Export settings ──
// Persisted per mindmap, keyed by id: tuning the spread and loop for one map should not reset
// the settings on another.

export type PersistedSpec = Omit<CompositionSpec, 'mindmap'>

export const loadSpec = (mindmapId: string): Partial<PersistedSpec> | null =>
  readJson<Record<string, Partial<PersistedSpec>>>(SETTINGS_KEY, {})[mindmapId] ?? null

export function saveSpec(mindmapId: string, spec: PersistedSpec): void {
  const all = readJson<Record<string, PersistedSpec>>(SETTINGS_KEY, {})
  all[mindmapId] = spec
  writeJson(SETTINGS_KEY, all)
}

// ── Signature ──
// An uploaded mark is stored as a data URL so it survives reloads without the user having to
// drop files into public/brand/. That file path stays the documented default; this is the
// zero-friction override.

export interface StoredSignature {
  /** Data URL of the mark used on dark backgrounds. */
  white: string | null
  /** Data URL of the mark used on light backgrounds. */
  black: string | null
  options: SignatureOptions | null
}

export const loadSignatureStore = (): StoredSignature =>
  readJson<StoredSignature>(SIGNATURE_KEY, { white: null, black: null, options: null })

export function saveSignatureStore(store: StoredSignature): void {
  writeJson(SIGNATURE_KEY, store)
}

// ── Thumbnails ──

export const loadThumbnail = (id: string): string | null =>
  readJson<Record<string, string>>(THUMBNAIL_KEY, {})[id] ?? null

export function saveThumbnail(id: string, dataUrl: string): void {
  const all = readJson<Record<string, string>>(THUMBNAIL_KEY, {})
  all[id] = dataUrl
  try {
    writeJson(THUMBNAIL_KEY, all)
  } catch {
    // A thumbnail is a nicety. If the quota is gone, drop the cache and carry on rather than
    // failing the save that triggered it.
    try {
      localStorage.removeItem(THUMBNAIL_KEY)
    } catch {
      /* ignore */
    }
  }
}

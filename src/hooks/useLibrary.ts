// The starter library: mindmap files shipped in public/library/ and offered for one-click add.
//
// This exists to close the loop the import textarea left open. Turning a reference image into a
// mindmap produces a JSON document, and having to shuttle that through the clipboard makes the
// assistant-authored path feel like a workaround rather than a feature. Dropping the file into
// public/library/ and adding a manifest entry means the mindmap simply appears in the app.
//
// Served as static files rather than bundled imports so the set can change without a rebuild —
// docker-compose.yml already bind-mounts public/, so a new file is live on refresh.
//
// Note the directory is `library` and not `mindmaps`: a public/mindmaps/ directory would shadow
// the app's own /mindmaps route, and nginx's `try_files $uri $uri/ /index.html` would then resolve
// /mindmaps to a directory with no index.html and stop serving the SPA there.

import { useCallback, useEffect, useState } from 'react'
import { importMindmap } from '../lib/importMindmap'
import type { Mindmap } from '../types/mindmap'

const MANIFEST_URL = '/library/index.json'

export interface LibraryEntry {
  file: string
  mindmap: Mindmap
  note: string | null
  recommended: boolean
}

export interface LibraryState {
  entries: LibraryEntry[]
  loading: boolean
  /** Per-file problems. Surfaced rather than thrown so one bad file cannot hide the rest. */
  problems: string[]
  reload: () => void
}

interface ManifestEntry {
  file?: unknown
  note?: unknown
  recommended?: unknown
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

export function useLibrary(): LibraryState {
  const [entries, setEntries] = useState<LibraryEntry[]>([])
  const [problems, setProblems] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)

  const reload = useCallback(() => setNonce(n => n + 1), [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    const run = async () => {
      const found: LibraryEntry[] = []
      const issues: string[] = []

      try {
        const response = await fetch(MANIFEST_URL, { cache: 'no-cache' })
        // An absent manifest is a valid state - the library section just does not render. It is
        // not worth an error banner on a page that works fine without it.
        if (!response.ok) throw new Error(`manifest ${response.status}`)

        const manifest: unknown = await response.json()
        const list =
          typeof manifest === 'object' && manifest !== null && Array.isArray((manifest as { mindmaps?: unknown }).mindmaps)
            ? ((manifest as { mindmaps: ManifestEntry[] }).mindmaps)
            : []

        for (const item of list) {
          const file = str(item?.file)
          if (!file) continue

          try {
            const fileResponse = await fetch(`/library/${file}`, { cache: 'no-cache' })
            if (!fileResponse.ok) throw new Error(`HTTP ${fileResponse.status}`)

            // Parsed through the same importer the paste box uses, so a library file cannot rely
            // on behaviour the documented schema does not have.
            const { mindmap } = importMindmap(await fileResponse.text())
            found.push({
              file,
              mindmap,
              note: str(item?.note),
              recommended: item?.recommended === true,
            })
          } catch (err) {
            issues.push(`${file}: ${err instanceof Error ? err.message : 'could not be read'}`)
          }
        }
      } catch {
        // No manifest, or it is unreadable. Leave the library empty and silent.
      }

      if (cancelled) return
      setEntries(found)
      setProblems(issues)
      setLoading(false)
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [nonce])

  return { entries, loading, problems, reload }
}

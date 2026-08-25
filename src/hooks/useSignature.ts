// Resolves which signature mark to composite, and where it came from.
//
// Two sources, in priority order:
//
//   1. An upload held in localStorage as a data URL. Zero friction — pick the file in the UI
//      and it is there on the next reload, no filesystem access needed.
//   2. `public/brand/signature-{black,white}.png`, the contract already documented in
//      public/brand/README.md. Survives a cleared browser profile and is what a checked-out
//      copy of the repo picks up automatically.
//
// The theme decides which variant is wanted: dark exports need the white mark, light exports
// the black one. Resolution is per theme, so switching theme re-resolves rather than reusing a
// mark that will vanish against the new background.
//
// Absence is a first-class state, not an error. `status: 'missing'` lets the UI say so plainly
// while exports continue with the caption fallback.

import { useCallback, useEffect, useState } from 'react'
import { THEMES, type ThemeName } from '../lib/palette'
import { loadBrandSignature, loadImageAsset, signatureFileFor, type SignatureAsset } from '../lib/signature'
import { loadSignatureStore, saveSignatureStore, type StoredSignature } from '../lib/storage'

export type SignatureStatus = 'loading' | 'custom' | 'brand' | 'missing'

export interface SignatureState {
  asset: SignatureAsset | null
  status: SignatureStatus
  /** Which variant the current theme asked for. */
  variant: 'black' | 'white'
  /** Path checked on disk, surfaced in the UI so the fix is obvious. */
  expectedPath: string
  store: StoredSignature
  uploadFor: (variant: 'black' | 'white', file: File) => Promise<void>
  clear: (variant: 'black' | 'white') => void
}

export function useSignature(themeName: ThemeName): SignatureState {
  const theme = THEMES[themeName]
  const variant = theme.signature
  const [store, setStore] = useState<StoredSignature>(() => loadSignatureStore())
  const [asset, setAsset] = useState<SignatureAsset | null>(null)
  const [status, setStatus] = useState<SignatureStatus>('loading')

  useEffect(() => {
    let cancelled = false
    setStatus('loading')

    const resolve = async () => {
      const custom = store[variant]
      if (custom) {
        try {
          const loaded = await loadImageAsset(custom, 'custom-upload')
          if (!cancelled) {
            setAsset(loaded)
            setStatus('custom')
          }
          return
        } catch {
          // A corrupt stored data URL should fall through to the brand file rather than
          // leaving the export unsigned.
        }
      }

      const brand = await loadBrandSignature(theme)
      if (cancelled) return
      setAsset(brand)
      setStatus(brand ? 'brand' : 'missing')
    }

    void resolve()
    return () => {
      cancelled = true
    }
  }, [store, variant, theme])

  const uploadFor = useCallback(async (target: 'black' | 'white', file: File) => {
    const dataUrl = await readAsDataUrl(file)
    // Validate before persisting: storing an unreadable file would fail silently at render time.
    await loadImageAsset(dataUrl, 'custom-upload')

    setStore(previous => {
      const next: StoredSignature = { ...previous, [target]: dataUrl }
      saveSignatureStore(next)
      return next
    })
  }, [])

  const clear = useCallback((target: 'black' | 'white') => {
    setStore(previous => {
      const next: StoredSignature = { ...previous, [target]: null }
      saveSignatureStore(next)
      return next
    })
  }, [])

  return { asset, status, variant, expectedPath: signatureFileFor(theme), store, uploadFor, clear }
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not read that file.'))
    }
    reader.onerror = () => reject(new Error('Could not read that file.'))
    reader.readAsDataURL(file)
  })
}

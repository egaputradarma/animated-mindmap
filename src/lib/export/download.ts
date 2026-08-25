/** Triggers a browser download for a blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()

  // Revoking synchronously can cancel the download in some browsers before it starts, so this
  // waits a beat. The delay is not load-bearing beyond that.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * LinkedIn's practical ceiling for an inline animated GIF. Past this the upload is rejected or
 * silently transcoded to a still, so it is worth warning before the user posts rather than
 * after.
 */
export const LINKEDIN_GIF_LIMIT_BYTES = 8 * 1024 * 1024

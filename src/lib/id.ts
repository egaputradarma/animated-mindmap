/**
 * Short collision-resistant ids. `crypto.randomUUID` where available (all current
 * browsers over HTTPS/localhost), falling back to random bytes so this stays usable in a
 * plain test runner without a DOM.
 */
export function uid(prefix = ''): string {
  const c = globalThis.crypto
  const raw =
    typeof c?.randomUUID === 'function'
      ? c.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6)
  return prefix ? `${prefix}_${raw}` : raw
}

/** Slug safe for use as a download filename. Never returns an empty string. */
export function slugify(input: string, fallback = 'mindmap'): string {
  const s = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || fallback
}

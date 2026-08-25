// Text wrapping shared by the layout pass and the renderer.
//
// These two have to agree on line counts or cards get sized for one thing and drawn with
// another — the classic symptom being a detail line spilling out of the card's rounded
// rectangle. They agree by calling the same `wrapText` with different measurers: the layout
// pass has no canvas so it estimates, while the renderer passes `ctx.measureText`.
//
// The estimator is deliberately biased to over-estimate (see AVG_GLYPH_RATIO). Over-
// estimating costs a little empty space inside a card; under-estimating overflows it.

export type Measure = (text: string) => number

/**
 * Mean advance width as a fraction of font size for mixed-case Latin text in the UI sans
 * stack. Real value sits near 0.50; 0.58 buys headroom for wide strings (caps, digits, "W")
 * so the estimate errs toward a taller card rather than a clipped one.
 */
const AVG_GLYPH_RATIO = 0.58

export const estimateWidth = (text: string, fontSize: number): number => text.length * fontSize * AVG_GLYPH_RATIO

export const estimator =
  (fontSize: number): Measure =>
  text =>
    estimateWidth(text, fontSize)

/**
 * Greedy word wrap, capped at `maxLines`. The last line is ellipsised when content remains,
 * so a long detail string degrades to "…" instead of pushing the card out of shape.
 *
 * A single word longer than `maxWidth` is broken mid-word — rare for labels, but leaving it
 * unbroken would overflow, and overflow is the one outcome not worth allowing.
 */
export function wrapText(text: string, maxWidth: number, measure: Measure, maxLines = 3): string[] {
  const normalised = text.replace(/\s+/g, ' ').trim()
  if (!normalised) return []
  if (maxWidth <= 0 || maxLines <= 0) return []

  const lines: string[] = []
  let current = ''
  /** Set when content had to be dropped, so the result can be marked as cut short. */
  let truncated = false

  const words = normalised.split(' ')
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    const candidate = current ? `${current} ${word}` : word

    if (measure(candidate) <= maxWidth) {
      current = candidate
      continue
    }

    if (current) lines.push(current)
    current = ''

    if (lines.length >= maxLines) {
      truncated = true
      break
    }

    // The word alone still does not fit: hard-break it across as many lines as remain.
    if (measure(word) > maxWidth) {
      let rest = word
      while (measure(rest) > maxWidth && lines.length < maxLines) {
        let cut = rest.length
        while (cut > 1 && measure(rest.slice(0, cut)) > maxWidth) cut--
        lines.push(rest.slice(0, cut))
        rest = rest.slice(cut)
      }
      if (lines.length >= maxLines && rest) {
        truncated = true
        break
      }
      current = rest
    } else {
      current = word
    }
  }

  if (current) {
    if (lines.length < maxLines) lines.push(current)
    else truncated = true
  }

  // Marking truncation is NOT the same operation as trimming to fit. `ellipsise` leaves a string
  // alone when it already fits, which is right for a standalone label but wrong here: the line
  // fits precisely because the overflowing words were dropped, so it needs the ellipsis to show
  // that something is missing.
  if (truncated && lines.length > 0) {
    lines[lines.length - 1] = appendEllipsis(lines[lines.length - 1], maxWidth, measure)
  }

  return lines
}

/** Trims only when needed, then appends an ellipsis. Use when text was actually cut. */
function appendEllipsis(text: string, maxWidth: number, measure: Measure): string {
  let out = text
  while (out.length > 0 && measure(`${out}…`) > maxWidth) out = out.slice(0, -1)
  return `${out}…`
}

/** Trims until the string fits, adding an ellipsis only if it did not already. */
export function ellipsise(text: string, maxWidth: number, measure: Measure): string {
  if (measure(text) <= maxWidth) return text
  return appendEllipsis(text, maxWidth, measure)
}

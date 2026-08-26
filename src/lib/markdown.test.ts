// Tests for the markdown outline parser.
//
// Nesting is where this can quietly go wrong: a list item escaping the heading that contains it, or
// indentation being misread, produces a mindmap that imports cleanly and is simply the wrong shape.
// So most of these assert parent/child structure rather than node counts.

import { describe, expect, it } from 'vitest'
import { importMarkdown, markdownToAuthoring } from './markdown'

/** Parent key of a node, via the edge that points at it. */
const parentOf = (doc: { edges: { from: string; to: string }[] }, key: string): string | null =>
  doc.edges.find(e => e.to === key)?.from ?? null

describe('markdown outline', () => {
  it('nests headings by level', () => {
    const { doc } = markdownToAuthoring(`
# Root
## Alpha
### Alpha child
## Beta
`)

    expect(doc.name).toBe('Root')
    expect(parentOf(doc, 'alpha')).toBe('root')
    expect(parentOf(doc, 'alpha-child')).toBe('alpha')
    // Beta returns to level 2, so it hangs off the root rather than off Alpha's child.
    expect(parentOf(doc, 'beta')).toBe('root')
  })

  it('nests list items by indentation', () => {
    const { doc } = markdownToAuthoring(`
# Root
- One
  - One A
    - One A i
  - One B
- Two
`)

    expect(parentOf(doc, 'one')).toBe('root')
    expect(parentOf(doc, 'one-a')).toBe('one')
    expect(parentOf(doc, 'one-a-i')).toBe('one-a')
    // Dedenting back to One A's level makes One B its sibling, not its child.
    expect(parentOf(doc, 'one-b')).toBe('one')
    expect(parentOf(doc, 'two')).toBe('root')
  })

  it('keeps list items inside the heading that contains them', () => {
    const { doc } = markdownToAuthoring(`
# Root
## Alpha
- Under alpha
## Beta
- Under beta
`)

    // The critical case: "Under beta" must not attach to Alpha's subtree just because the previous
    // bullet was at the same indentation.
    expect(parentOf(doc, 'under-alpha')).toBe('alpha')
    expect(parentOf(doc, 'under-beta')).toBe('beta')
  })

  it('treats tabs as four columns so mixed indentation still nests', () => {
    const { doc } = markdownToAuthoring('# Root\n- One\n\t- Tabbed child\n')
    expect(parentOf(doc, 'tabbed-child')).toBe('one')
  })

  it('marks the single root as the hub', () => {
    const { doc } = markdownToAuthoring('# Only root\n- Child\n')
    expect(doc.nodes.find(n => n.key === 'only-root')?.hero).toBe(true)
  })

  it('synthesises a hub when the outline has several top-level items', () => {
    const { doc, warnings } = markdownToAuthoring('- One\n- Two\n- Three\n', 'My map')

    expect(doc.nodes[0].label).toBe('My map')
    expect(doc.nodes[0].hero).toBe(true)
    // Without this the layout would render three disconnected islands.
    expect(parentOf(doc, 'one')).toBe(doc.nodes[0].key)
    expect(parentOf(doc, 'three')).toBe(doc.nodes[0].key)
    expect(warnings.join(' ')).toContain('hub')
  })

  it('splits a detail line on an em dash or a pipe', () => {
    const { doc } = markdownToAuthoring('# Root\n- Alpha — first branch\n- Beta | second branch\n')

    expect(doc.nodes.find(n => n.key === 'alpha')?.detail).toBe('first branch')
    expect(doc.nodes.find(n => n.key === 'beta')?.detail).toBe('second branch')
  })

  it('does not split on a colon, which appears inside real labels', () => {
    const { doc } = markdownToAuthoring('# Root\n- QA: SQL DB\n')
    const node = doc.nodes.find(n => n.key === 'qa-sql-db')

    expect(node?.label).toBe('QA: SQL DB')
    expect(node?.detail).toBeUndefined()
  })

  it('lifts a leading emoji into the icon', () => {
    const { doc } = markdownToAuthoring('# Root\n- 🔐 Identity — MFA\n')
    const node = doc.nodes.find(n => n.label === 'Identity')

    expect(node?.icon).toBe('🔐')
    expect(node?.label).toBe('Identity')
    expect(node?.detail).toBe('MFA')
  })

  it('reads weight, arrow, accent and planned modifiers', () => {
    const { doc } = markdownToAuthoring(`
# Root
- Heavy path {heavy} {arrow}
- Planned thing {planned} {semi}
- Coloured {gold}
`)

    const heavyEdge = doc.edges.find(e => e.to === 'heavy-path')
    expect(heavyEdge?.weight).toBe('heavy')
    expect(heavyEdge?.arrow).toBe('end')

    expect(doc.edges.find(e => e.to === 'planned-thing')?.weight).toBe('semi')
    expect(doc.nodes.find(n => n.key === 'planned-thing')?.reserved).toBe(true)
    expect(doc.nodes.find(n => n.key === 'coloured')?.accent).toBe('gold')

    // Modifiers must not survive into the visible label.
    expect(doc.nodes.find(n => n.key === 'heavy-path')?.label).toBe('Heavy path')
  })

  it('reads from: and to: side modifiers', () => {
    const { doc } = markdownToAuthoring('# Root\n- Pinned {from:bottom} {to:top}\n')
    const edge = doc.edges.find(e => e.to === 'pinned')

    expect(edge?.source_side).toBe('bottom')
    expect(edge?.target_side).toBe('top')
    expect(doc.nodes.find(n => n.key === 'pinned')?.label).toBe('Pinned')
  })

  it('rejects a nonsense side as an unknown modifier', () => {
    const { doc, warnings } = markdownToAuthoring('# Root\n- Thing {from:diagonal}\n')

    expect(doc.edges.find(e => e.to === 'thing')?.source_side).toBeUndefined()
    expect(warnings.join(' ')).toContain('from:diagonal')
  })

  it('warns about an unknown modifier instead of putting it in the label', () => {
    const { doc, warnings } = markdownToAuthoring('# Root\n- Thing {nonsense}\n')

    expect(doc.nodes.find(n => n.key === 'thing')?.label).toBe('Thing')
    expect(warnings.join(' ')).toContain('nonsense')
  })

  it('ignores fenced code blocks', () => {
    const { doc } = markdownToAuthoring(`
# Root
\`\`\`sh
# not a heading
- not a bullet
\`\`\`
- Real child
`)

    // Only Root and "Real child" — the fence contents look like outline syntax but are not.
    expect(doc.nodes).toHaveLength(2)
    expect(doc.nodes.map(n => n.key)).toContain('real-child')
  })

  it('strips blockquote markers and task checkboxes', () => {
    const { doc } = markdownToAuthoring('# Root\n> - Quoted item\n- [x] Done thing\n')

    expect(doc.nodes.map(n => n.label)).toContain('Quoted item')
    expect(doc.nodes.map(n => n.label)).toContain('Done thing')
  })

  it('gives duplicate labels distinct keys rather than merging them', () => {
    const { doc } = markdownToAuthoring('# Root\n- Same\n- Same\n')

    const keys = doc.nodes.map(n => n.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(doc.edges).toHaveLength(2)
  })

  it('imports end-to-end through the shared importer', () => {
    const { mindmap } = importMarkdown('# Platform\n- 🗄️ Database — Postgres\n- API {heavy}\n', 'Fallback')

    expect(mindmap.name).toBe('Platform')
    expect(mindmap.nodes).toHaveLength(3)
    expect(mindmap.edges).toHaveLength(2)
    expect(mindmap.nodes.find(n => n.label === 'Database')?.icon).toBe('🗄️')
    expect(mindmap.edges.find(e => e.target_node_key === 'api')?.weight).toBe('heavy')
  })

  it('rejects input with no outline at all', () => {
    expect(() => importMarkdown('just a paragraph of prose', 'X')).toThrow(/headings or list items/i)
  })
})

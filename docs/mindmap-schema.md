# Mindmap authoring schema

Hand this file plus a reference image to an AI assistant and ask for a mindmap. There are two ways
to get the result into the app:

- **Starter library (no copy-paste).** Save the JSON into `public/library/`, add an entry to
  `public/library/index.json`, and refresh. It appears on the mindmaps page with a one-click
  **Add**. This is the better route when an assistant with filesystem access is doing the work,
  and `docker-compose.yml` bind-mounts `public/` so no rebuild is needed.
- **Import JSON.** Paste into the textarea on the mindmaps page. Use this for a one-off, or when
  the JSON arrives by some route other than the filesystem.

The library directory is `library`, not `mindmaps`, because a `public/mindmaps/` directory would
shadow the app's `/mindmaps` route — nginx would resolve that path to a directory with no
`index.html` and stop serving the SPA there.

## Shape

```json
{
  "name": "string, required",
  "description": "string, optional",
  "nodes": [
    {
      "key": "string, optional — defaults to a slug of the label",
      "label": "string, required — the card title",
      "icon": "string, optional — one emoji or 1-2 letters",
      "detail": "string, optional — one short phrase under the title",
      "accent": "blue | cyan | green | gold | pink | purple | red | slate, optional",
      "hero": "boolean, optional — marks the hub; at most one node",
      "reserved": "boolean, optional — dashed 'planned / not wired' styling",
      "tag": "string, optional — small uppercase line, only shown when reserved is true"
    }
  ],
  "edges": [
    {
      "from": "node key or label",
      "to": "node key or label",
      "label": "string, optional — small chip drawn mid-wire",
      "weight": "heavy | standard | semi, optional — defaults to standard",
      "arrow": "none | end | start | both, optional — defaults to none"
    }
  ]
}
```

### Connection weight

| value | line | packet |
| --- | --- | --- |
| `heavy` | thick solid | larger |
| `standard` | normal solid | normal |
| `semi` | thinner dashed | smaller |

Weight is purely visual. Whether anything *flows* along a connection is decided by its endpoints:
a connection touching a `reserved` node draws dim and carries no packet, because nothing travels to
something that is not wired up yet. That means a dashed line can carry traffic and a solid one can
be inert — the two ideas are independent.

`dashed: true` is still accepted from older files and maps to `weight: "semi"`.

### Arrowheads

`none` (default), `end`, `start`, or `both`. Heads are placed where the line clears the card, which
is measured per connection — a fixed inset would bury the head under a larger card.

Default is `none` because the reference diagram this app's look comes from uses travelling packets
rather than arrowheads to convey direction. Set them per connection where the direction matters.

## Rules that matter

- **No coordinates.** The radial layout computes positions. Supplying `x`/`y` is accepted but only
  used in "As arranged" mode.
- **One hub.** Set `hero: true` on the central node. Omit it and the most-connected node is chosen.
- **Connected graph.** Every non-hub node should have at least one edge, otherwise it floats
  unconnected in the animation.
- **`accent` is usually best omitted.** Left out, each branch off the hub is auto-assigned a
  distinct colour and its descendants inherit it, which is what makes branches readable.
- **Keep `detail` to a phrase.** It wraps to at most three lines and then ellipsises. Roughly 60
  characters is the comfortable ceiling.
- **Keep `label` short.** Two lines maximum, around 28 characters.

## Sizing guidance

Aim for **5–9 nodes** and a depth of **1–2**. This is a social-feed graphic viewed at roughly 40%
of its exported width — every extra node shrinks the type. Past about 12 nodes the labels stop
being legible in-feed, and the layout compensates by scaling everything down.

## Example

```json
{
  "name": "Why EA programmes stall",
  "description": "Four failure modes, one root cause",
  "nodes": [
    { "key": "hub", "label": "Programme stalls", "icon": "🧭", "detail": "Strategy outruns delivery", "hero": true },
    { "key": "data", "label": "No single source", "icon": "🗄️", "detail": "Four systems disagree on the same asset" },
    { "key": "owner", "label": "Unclear ownership", "icon": "🪪", "detail": "Everyone consulted, nobody accountable" },
    { "key": "cadence", "label": "Annual cadence", "icon": "🗓️", "detail": "Decisions age out before approval" },
    { "key": "tooling", "label": "Slideware architecture", "icon": "📊", "detail": "Diagrams with no live source" },
    { "key": "fix", "label": "Governed tooling", "icon": "🛠️", "detail": "One model, reviewed continuously", "reserved": true, "tag": "the way out" }
  ],
  "edges": [
    { "from": "hub", "to": "data" },
    { "from": "hub", "to": "owner" },
    { "from": "hub", "to": "cadence" },
    { "from": "hub", "to": "tooling" },
    { "from": "tooling", "to": "fix", "label": "replace", "dashed": true }
  ]
}
```

## Worked examples

`public/library/` holds two versions of the same source infographic, which together show the sizing
guidance above in practice:

| file | nodes | title at 1200px | in-feed (40%) |
| --- | --- | --- | --- |
| `it-ops-roadmap-overview.json` | 8 | 22.9px | 9.2px — readable |
| `it-ops-roadmap-full.json` | 18 | 10.9px | 4.3px — too small |

Both come from a 17-stage roadmap poster. The overview groups those stages into seven phases and
pushes the detail into each card's `detail` line; the full version keeps all seventeen as separate
spokes. Same information, and the only difference is how much of it competes for one ring.

`src/lib/examples.test.ts` asserts those numbers, so the guidance cannot silently drift from what
the layout actually produces.

## Other accepted formats

Import also detects, without being told which:

| Source | Recognised by |
| --- | --- |
| MICA frontend DTO | `nodes[].node_key` |
| MICA API JSON | `nodes[].nodeKey` |
| React Flow dump | `nodes[].position.{x,y}` |

For the two MICA shapes, presentation metadata (`icon`, `detail`, `accent`, `hero`, `reserved`,
`tag`) is read out of each node's `data_json` string — which is where MICA can hold it without a
schema migration.

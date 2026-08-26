#!/usr/bin/env node
// MCP server for the Animated Mindmap Generator.
//
// Lets an AI assistant put a mindmap into the app directly, which is the gap the starter library only
// half-closed: files still had to be written and the manifest edited by hand.
//
// WHY NO DEPENDENCIES
//
// MCP's stdio transport is JSON-RPC 2.0 with newline-delimited messages, and this server implements
// three tools. The official SDK would be a second package.json, its own install, and a version to
// keep current — for perhaps eighty lines of protocol. So it is implemented directly and
// `node mcp-server/index.mjs` runs with nothing installed.
//
// WHY IT WRITES FILES RATHER THAN TALKING TO THE APP
//
// Mindmaps live in browser localStorage, which no external process can reach. Writing into
// public/library/ and letting the app pull is the honest architecture: docker-compose.yml already
// bind-mounts public/, so a file written here is live on the next refresh with no rebuild.
//
// Markdown is written through verbatim rather than converted here. The app owns the outline parser,
// and a second copy in this file would inevitably drift from it.
//
// CRITICAL: stdout is the protocol channel. Anything printed there that is not a JSON-RPC message
// corrupts the stream and the client disconnects. All diagnostics go to stderr.

import { readFile, writeFile, mkdir, unlink, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIBRARY_DIR = resolve(HERE, '..', 'public', 'library')
const MANIFEST = join(LIBRARY_DIR, 'index.json')

const PROTOCOL_VERSION = '2024-11-05'
const log = (...args) => console.error('[mindmap-mcp]', ...args)

// ── Library file handling ──

/** Filename-safe slug. Never returns empty, and never escapes the library directory. */
function slugify(input) {
  const s = String(input ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return s || 'mindmap'
}

async function readManifest() {
  try {
    const parsed = JSON.parse(await readFile(MANIFEST, 'utf8'))
    return Array.isArray(parsed?.mindmaps) ? parsed : { mindmaps: [] }
  } catch {
    // Absent or malformed manifest is a normal starting state, not an error.
    return { mindmaps: [] }
  }
}

async function writeManifest(manifest) {
  const payload = {
    $comment:
      'Manifest for the in-app starter library. Maintained by mcp-server/index.mjs; safe to edit by hand. Entries may be .json (authoring shape) or .md (markdown outline).',
    mindmaps: manifest.mindmaps,
  }
  await mkdir(LIBRARY_DIR, { recursive: true })
  await writeFile(MANIFEST, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

/**
 * Rejects anything that would write outside the library directory. The filename is derived from
 * model-supplied text, so path traversal is a real input to defend against rather than a hypothetical.
 */
function safeLibraryPath(filename) {
  const target = resolve(LIBRARY_DIR, filename)
  if (target !== join(LIBRARY_DIR, filename) || !target.startsWith(LIBRARY_DIR)) {
    throw new Error(`Refusing to write outside the library directory: ${filename}`)
  }
  return target
}

// ── Tools ──

const TOOLS = [
  {
    name: 'create_mindmap',
    description:
      'Create a mindmap in the Animated Mindmap Generator library. Supply either `markdown` (nested headings and bullets) or `json` (the authoring shape). It appears in the app under Starter library, ready to add with one click.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name; also used for the filename.' },
        markdown: {
          type: 'string',
          description:
            'Markdown outline. Headings and list indentation set the hierarchy. A leading emoji becomes the node icon; text after an em dash or a pipe becomes the detail line. Optional modifiers in braces: {heavy} {semi} {arrow} {planned} {hub} or an accent colour name.',
        },
        json: {
          type: 'string',
          description: 'Authoring-shape JSON, as documented in docs/mindmap-schema.md. Use instead of `markdown`.',
        },
        note: { type: 'string', description: 'Short note shown beside the entry in the app.' },
        recommended: { type: 'boolean', description: 'Badge this entry as the recommended one.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_mindmaps',
    description: 'List the mindmaps currently in the library, with their filenames and notes.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'delete_mindmap',
    description: 'Remove a mindmap from the library by filename.',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string', description: 'Filename as returned by list_mindmaps.' } },
      required: ['file'],
    },
  },
]

async function createMindmap({ name, markdown, json, note, recommended }) {
  if (!name || typeof name !== 'string') throw new Error('`name` is required.')
  if (!markdown && !json) throw new Error('Supply either `markdown` or `json`.')
  if (markdown && json) throw new Error('Supply only one of `markdown` or `json`.')

  // Validated here so a malformed payload fails with a useful message now, rather than becoming a
  // silent warning in the app's library panel later.
  if (json) {
    let parsed
    try {
      parsed = JSON.parse(json)
    } catch (err) {
      throw new Error(`\`json\` is not valid JSON: ${err.message}`)
    }
    if (!Array.isArray(parsed?.nodes) || parsed.nodes.length === 0) {
      throw new Error('`json` needs a non-empty "nodes" array.')
    }
  } else if (!/^\s*(#{1,6}\s|[-*+]\s)/m.test(markdown)) {
    throw new Error('`markdown` contains no headings or list items, so it has no structure to read.')
  }

  const extension = markdown ? 'md' : 'json'
  const filename = `${slugify(name)}.${extension}`
  const target = safeLibraryPath(filename)

  await mkdir(LIBRARY_DIR, { recursive: true })
  await writeFile(target, markdown ?? json, 'utf8')

  const manifest = await readManifest()
  const entry = { file: filename }
  if (note) entry.note = String(note)
  if (recommended === true) {
    // Exactly one recommended entry, or the badge stops meaning anything.
    for (const other of manifest.mindmaps) delete other.recommended
    entry.recommended = true
  }

  const existing = manifest.mindmaps.findIndex(m => m.file === filename)
  if (existing >= 0) manifest.mindmaps[existing] = entry
  else manifest.mindmaps.push(entry)
  await writeManifest(manifest)

  log(`wrote ${filename}`)
  return {
    file: filename,
    replaced: existing >= 0,
    hint: 'Refresh the mindmaps page; it appears under Starter library.',
  }
}

async function listMindmaps() {
  const manifest = await readManifest()
  let onDisk = []
  try {
    onDisk = (await readdir(LIBRARY_DIR)).filter(f => /\.(json|md|markdown)$/i.test(f) && f !== 'index.json')
  } catch {
    /* directory may not exist yet */
  }

  return {
    mindmaps: manifest.mindmaps,
    // Surfaced so a file dropped in by hand without a manifest entry is discoverable rather than
    // invisible.
    unlisted: onDisk.filter(f => !manifest.mindmaps.some(m => m.file === f)),
  }
}

async function deleteMindmap({ file }) {
  if (!file || typeof file !== 'string') throw new Error('`file` is required.')
  const target = safeLibraryPath(file)

  const manifest = await readManifest()
  const before = manifest.mindmaps.length
  manifest.mindmaps = manifest.mindmaps.filter(m => m.file !== file)
  await writeManifest(manifest)

  try {
    await unlink(target)
  } catch {
    // Already gone. Removing the manifest entry was the meaningful part.
  }

  return { file, removedFromManifest: before !== manifest.mindmaps.length }
}

const HANDLERS = {
  create_mindmap: createMindmap,
  list_mindmaps: listMindmaps,
  delete_mindmap: deleteMindmap,
}

// ── JSON-RPC plumbing ──

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

async function handle(request) {
  const { id, method, params } = request

  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'animated-mindmap-generator', version: '0.1.0' },
      })

    case 'tools/list':
      return reply(id, { tools: TOOLS })

    case 'tools/call': {
      const handler = HANDLERS[params?.name]
      if (!handler) return fail(id, -32602, `Unknown tool: ${params?.name}`)

      try {
        const result = await handler(params.arguments ?? {})
        return reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] })
      } catch (err) {
        // Reported as a tool-level failure rather than a protocol error, so the model sees the
        // message and can correct its input instead of the connection breaking.
        return reply(id, { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true })
      }
    }

    case 'ping':
      return reply(id, {})

    default:
      // Notifications have no id and must never be answered.
      if (id === undefined || id === null) return
      return fail(id, -32601, `Method not found: ${method}`)
  }
}

log(`library at ${LIBRARY_DIR}`)

createInterface({ input: process.stdin }).on('line', line => {
  const trimmed = line.trim()
  if (!trimmed) return

  let request
  try {
    request = JSON.parse(trimmed)
  } catch {
    log('ignored a non-JSON line')
    return
  }

  // Kept off the main path: an unhandled rejection here would take the server down mid-session.
  handle(request).catch(err => {
    log('handler failed:', err)
    if (request?.id !== undefined && request.id !== null) fail(request.id, -32603, String(err?.message ?? err))
  })
})

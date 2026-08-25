// Seed content, installed once on first run.
//
// The first map is a rebuild of the animated "System map" from
// `ea-architecture-app/docs/ea-tools-project-overview.html` — the reference this tool's visual
// language was ported from. Having it present on launch means the animation and the export can
// be judged against their own source material, including the dashed "planned, not wired" node
// that the reference uses for the LLM assistant.

import { uid } from './id'
import { listMindmaps, saveMindmap } from './storage'
import type { Mindmap } from '../types/mindmap'

const SEED_FLAG = 'amg.seeded.v1'

function eaToolsSystemMap(): Mindmap {
  return {
    id: uid('mm'),
    name: 'EA Tools · System Map',
    description: 'One App Service, same-origin API, and the services around it',
    nodes: [
      {
        node_key: 'hero',
        label: 'Azure App Service',
        detail: '.NET 10 API · serves /api/* and wwwroot, same origin',
        icon: '⚙️',
        accent: 'blue',
        position_x: 0,
        position_y: 0,
        hero: true,
        reserved: false,
        tag: null,
      },
      {
        node_key: 'browser',
        label: 'React 19 SPA',
        detail: 'MSAL popup SSO · HTTPS + JWT',
        icon: '🖥️',
        accent: 'blue',
        position_x: 0,
        position_y: -260,
        hero: false,
        reserved: false,
        tag: null,
      },
      {
        node_key: 'entra',
        label: 'Microsoft Entra ID',
        detail: 'SSO sign-in · nightly org-structure sync',
        icon: '🔐',
        accent: 'pink',
        position_x: 329,
        position_y: -130,
        hero: false,
        reserved: false,
        tag: null,
      },
      {
        node_key: 'mail',
        label: 'Mail',
        detail: 'Graph API primary, SMTP (MailKit) fallback',
        icon: '✉️',
        accent: 'cyan',
        position_x: 329,
        position_y: 130,
        hero: false,
        reserved: false,
        tag: null,
      },
      {
        node_key: 'sql',
        label: 'Azure SQL',
        detail: 'QA: SQL DB · Prod: SQL MI · 60 EF migrations',
        icon: '🗄️',
        accent: 'gold',
        position_x: 0,
        position_y: 260,
        hero: false,
        reserved: false,
        tag: null,
      },
      {
        node_key: 'cicd',
        label: 'GitHub Actions',
        detail: 'Self-hosted runner · gated production deploy',
        icon: '🚀',
        accent: 'green',
        position_x: -329,
        position_y: 130,
        hero: false,
        reserved: false,
        tag: null,
      },
      {
        node_key: 'llm',
        label: 'LLM Assistant',
        detail: 'Any OpenAI-compatible provider · code written, not connected',
        icon: '🤖',
        accent: 'purple',
        position_x: -329,
        position_y: -130,
        hero: false,
        // Mirrors `.net-card.reserved` in the reference: dimmed, dashed, and paired with a
        // dashed connector carrying no packet.
        reserved: true,
        tag: 'planned · post v1.0',
      },
    ],
    edges: [
      { id: 'e-browser', source_node_key: 'hero', target_node_key: 'browser', label: null, dashed: false },
      { id: 'e-entra', source_node_key: 'hero', target_node_key: 'entra', label: null, dashed: false },
      { id: 'e-mail', source_node_key: 'hero', target_node_key: 'mail', label: null, dashed: false },
      { id: 'e-sql', source_node_key: 'hero', target_node_key: 'sql', label: null, dashed: false },
      { id: 'e-cicd', source_node_key: 'hero', target_node_key: 'cicd', label: null, dashed: false },
      { id: 'e-llm', source_node_key: 'hero', target_node_key: 'llm', label: 'to-be', dashed: true },
    ],
    updated_at: new Date().toISOString(),
  }
}

/**
 * Installs seed content on first run only.
 *
 * Guarded by both a flag and an emptiness check: the flag alone would re-seed anyone who
 * cleared it, and the emptiness check alone would re-seed someone who deliberately deleted
 * every map. Together they mean seeding happens exactly once.
 */
export function ensureSeeded(): void {
  try {
    if (localStorage.getItem(SEED_FLAG)) return
    localStorage.setItem(SEED_FLAG, new Date().toISOString())
    if (listMindmaps().length > 0) return
    saveMindmap(eaToolsSystemMap())
  } catch {
    // Private-mode browsers throw on localStorage. Running without seed content is fine.
  }
}

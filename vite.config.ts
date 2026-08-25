// `defineConfig` comes from `vitest/config`, not `vite`, because the `test` block below is not
// part of Vite's own config type. Vitest re-exports an extended version that accepts both.
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Set by the `dev` service in docker-compose.yml. inotify events do not propagate across a
// Windows bind mount, so a watcher inside the container never sees host edits and hot reload
// appears to be broken. Polling is the workaround; it costs CPU, so it stays opt-in rather than
// being on by default for people running Vite directly on the host.
const usePolling = process.env.VITE_USE_POLLING === 'true'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    // Fail loudly instead of silently moving to 5181: the port is part of the origin, and
    // localStorage — which holds every mindmap — is scoped per origin. A silent fallback would
    // present an empty app and look like data loss.
    strictPort: true,
    watch: usePolling ? { usePolling: true, interval: 300 } : undefined,
  },
  test: {
    // The suites here cover pure geometry, timeline and layout logic — no DOM needed, so the
    // faster node environment is the right default.
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Both of Vitest's pools intermittently fail here with "Timeout waiting for worker to respond"
    // when the machine is busy — worker *startup* stalling, not a test failing. Switching pool type
    // did not help, because the cost is spawning a worker per test file at all.
    //
    // These suites are pure functions over geometry, timelines and layout: no globals to leak, no
    // DOM to reset, nothing that needs process isolation. So they run in one long-lived thread,
    // which removes the startup contention and is faster besides.
    // Vitest 4 removed `poolOptions`; worker counts are top-level now.
    pool: 'threads',
    maxWorkers: 1,
    fileParallelism: false,
  },
})

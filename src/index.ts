/**
 * dsh-mcp-manage — host half: the MCP management backend.
 *
 * One route family under /api/dsh-mcp-manage that lists every installed MCP
 * tool, and adds / edits / deletes / enables / disables MCP servers at
 * runtime. Definitions persist in `$DSH_HOME/mcp-manage/servers.json` (the
 * record store); every enabled record is loaded as a live
 * `@deepseek-ai/dsh-mcp-client` child instance of this plugin (the runtime
 * manager), so a change takes effect immediately and survives a host restart.
 * Composition-configured mcp-client rows (cordis.yml / patch layers) are
 * equally manageable: enable/disable and remove run through the Loader, with
 * the override persisted here and re-applied as rows appear at boot.
 * The browser half (./client) renders the 设置 → MCP 管理 page.
 *
 * @module dsh-mcp-manage
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { McpExternalOverride, McpServerDef } from './types.ts'
import { carriedOverride, loadStore, mintId, saveStore, storePath, validate, type StoreShape } from './host/store.ts'
import { McpManager } from './host/manager.ts'

/** Route prefix for this plugin's JSON operations. */
export const ROUTE_PREFIX = '/api/dsh-mcp-manage'

/** Request-body byte cap — well above any legitimate server definition. */
const MAX_BODY_BYTES = 256 * 1024

export const inject = ['webServer', 'tools']

/** One JSON envelope response. */
function json(res: ServerResponse, payload: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/** Read the request body (bounded) as UTF-8 text. */
function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new Error(`request body exceeds ${maxBytes} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Parse a JSON body or undefined on failure. */
async function parseJsonBody<T>(req: IncomingMessage): Promise<T | undefined> {
  try {
    return JSON.parse(await readBody(req)) as T
  } catch {
    return undefined
  }
}

/** Split the URL into decoded path segments under the route prefix. */
function routePath(url: string | undefined): string[] {
  const raw = (url ?? '').split('?')[0]
  if (raw === ROUTE_PREFIX) return ['']
  if (!raw.startsWith(`${ROUTE_PREFIX}/`)) return ['']
  return raw.slice(ROUTE_PREFIX.length + 1).split('/').map(segment => decodeURIComponent(segment))
}

/**
 * Normalize a client-submitted server payload into a full definition.
 * Returns the first validation problem instead of a definition on failure.
 */
function normalizeServer(payload: unknown):
  { server?: McpServerDef; problem?: string } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { problem: 'expected a server definition object' }
  }
  const input = payload as Partial<McpServerDef>
  const problem = validate(input)
  if (problem !== undefined) return { problem }
  const server: McpServerDef = {
    id: '',
    serverName: input.serverName!,
    transport: input.transport!,
    enabled: input.enabled !== false,
    command: input.command,
    args: input.args ?? [],
    env: input.env ?? {},
    cwd: input.cwd ?? '',
    url: input.url,
    headers: input.headers ?? {},
    toolCallTimeoutMs: input.toolCallTimeoutMs,
    // Default true: a management surface must surface a bad definition as a
    // visible failed row instead of silently retrying in the background.
    failOnStartupError: input.failOnStartupError ?? true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  return { server }
}

/**
 * Whether `serverName` collides with another record (edit) or any record
 * (add). Server-name uniqueness is the generic client's hard namespace
 * requirement; refusing here beats failing the fiber later.
 * `exceptId` skips one managed record (managed edit), `exceptEntryId` skips
 * one loader row (external config edit).
 */
function nameCollision(store: StoreShape, serverName: string, exceptId?: string, exceptEntryId?: string): boolean {
  if (store.servers.some(other => other.serverName === serverName && other.id !== exceptId)) return true
  // A live composition row owns its serverName too, unless overridden away.
  const overridden = (entryId: string): boolean => {
    const state = store.overrides[entryId]?.state
    return state === 'disabled' || state === 'removed'
  }
  return managerRef?.externalEntries().some(row =>
    row.entryId !== exceptEntryId
    && row.serverName === serverName
    && !overridden(row.entryId)) ?? false
}

/** Late-bound manager for collision checks (set once in apply). */
let managerRef: McpManager | undefined

/**
 * Register the MCP-management route family over one manager.
 * @returns the route disposer.
 */
function registerRoutes(ctx: Context, manager: McpManager): () => void {
  /** Snapshot the whole surface (managed rows + composition-owned tools),
   * re-enforcing persisted composition overrides first so the view never
   * reports rows a user-patch reload quietly revived. */
  const listPayload = async (): Promise<Record<string, unknown>> => {
    const store = await loadStore()
    await manager.enforceOverrides(store.overrides)
    const { managed, external } = manager.views(store.servers, store.overrides)
    return { ok: true, servers: managed, external, storePath: storePath() }
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const segments = routePath(req.url)
    const sub = segments[0] ?? ''
    try {
      // ── list: every managed server + every installed MCP tool ──────────
      if (sub === 'servers' && req.method === 'GET' && segments.length === 1) {
        json(res, await listPayload())
        return
      }

      // ── composition rows: enable toggle / edit config / revert / remove /
      //    restore ─────────────────────────────────────────────────────────
      if (sub === 'external' && segments.length >= 2) {
        const entryId = segments[1]
        const action = segments[2] ?? ''
        const store = await loadStore()

        // POST /external/:entryId/enabled — enable or disable the loader row.
        // A stored config edit rides along: disable keeps it dormant,
        // re-enable restores it as `modified` (rows never edited keep the
        // historical bare shapes).
        if (req.method === 'POST' && action === 'enabled') {
          const body = await parseJsonBody<{ enabled?: unknown }>(req)
          if (body === undefined || typeof body.enabled !== 'boolean') {
            json(res, { ok: false, error: 'expected { enabled: boolean }' }, 400)
            return
          }
          await manager.setExternalEnabled(entryId, body.enabled)
          const prior = store.overrides[entryId]
          const next = { ...store.overrides }
          if (body.enabled) {
            const carried = carriedOverride(prior, 'modified')
            if (carried !== undefined) next[entryId] = carried
            else delete next[entryId]
          } else {
            next[entryId] = carriedOverride(prior, 'disabled')!
          }
          await saveStore({ ...store, overrides: next })
          const { external } = manager.views(store.servers, next)
          json(res, { ok: true, external })
          return
        }

        // PUT /external/:entryId/config — replace the row's mcp-client
        // config from an edit form. The body is a server definition shaped
        // like the managed PUT; it is mapped through the manager's own
        // toConfig so a config the boot path would load is by construction
        // acceptable here. The row restarts under the new config when live,
        // or keeps it dormant when disabled; the edit persists as a
        // `modified` / `disabled` override and is re-enforced after every
        // reload. The original loader options are snapshotted on the first
        // edit so `revert` can always walk the row back.
        if (req.method === 'PUT' && action === 'config') {
          const row = manager.externalEntries().find(entry => entry.entryId === entryId)
          if (row === undefined) {
            json(res, { ok: false, error: 'entry not found (removed rows must be restored first)' }, 404)
            return
          }
          const body = await parseJsonBody<{ server?: unknown }>(req)
          if (body === undefined) { json(res, { ok: false, error: 'invalid JSON body' }, 400); return }
          const { server, problem } = normalizeServer(body.server)
          if (server === undefined) { json(res, { ok: false, error: problem }, 400); return }
          if (nameCollision(store, server.serverName, undefined, entryId)) {
            json(res, { ok: false, error: `serverName "${server.serverName}" is already in use` }, 409)
            return
          }
          const prior = store.overrides[entryId]
          const options = prior?.options ?? manager.cloneExternalOptions(entryId)
          const config = manager.toConfig(server)
          // Fields the edit form does not model (failOnStartupError) must
          // not be silently reset by the edit — carry the row's original.
          const originalConfig = typeof options.config === 'object' && options.config !== null
            ? options.config as Record<string, unknown>
            : undefined
          if (typeof originalConfig?.failOnStartupError === 'boolean') {
            config.failOnStartupError = originalConfig.failOnStartupError
          }
          const state = prior?.state === 'disabled' || row.disabled ? 'disabled' as const : 'modified' as const
          await manager.updateExternalConfig(entryId, config)
          const next = { ...store.overrides, [entryId]: { state, config, options } }
          await saveStore({ ...store, overrides: next })
          const { external } = manager.views(store.servers, next)
          json(res, { ok: true, external })
          return
        }

        // POST /external/:entryId/revert — undo a config edit: a live row
        // returns to its original loader options; a disabled row's config
        // reverts while it stays dormant. Nothing to revert is a 404.
        if (req.method === 'POST' && action === 'revert') {
          const override = store.overrides[entryId]
          const options = override?.options
          if (override === undefined || override.config === undefined
            || typeof options !== 'object' || options === null) {
            json(res, { ok: false, error: 'nothing to revert' }, 404)
            return
          }
          const originalConfig = typeof options.config === 'object' && options.config !== null
            ? options.config as Record<string, unknown>
            : undefined
          if (originalConfig === undefined) {
            json(res, { ok: false, error: 'original config unavailable' }, 409)
            return
          }
          const next = { ...store.overrides }
          if (override.state === 'disabled') next[entryId] = { state: 'disabled', options }
          else delete next[entryId]
          // Persist BEFORE the mutation: entry.update emits entry-init
          // re-entrantly and enforcement must not re-read a stale override.
          await saveStore({ ...store, overrides: next })
          await manager.withMutation(async () => {
            if (override.state === 'disabled') {
              await manager.updateExternalConfig(entryId, structuredClone(originalConfig))
            } else {
              await manager.revertExternal(entryId, structuredClone(options))
            }
          })
          const { external } = manager.views(store.servers, next)
          json(res, { ok: true, external })
          return
        }

        // DELETE /external/:entryId — remove the row (restorable).
        if (req.method === 'DELETE' && action === '') {
          let options: Record<string, unknown>
          try {
            options = await manager.removeExternal(entryId)
          } catch (error) {
            json(res, { ok: false, error: `entry not found: ${String((error as Error)?.message ?? error)}` }, 404)
            return
          }
          const next = { ...store.overrides, [entryId]: { state: 'removed' as const, options } }
          await saveStore({ ...store, overrides: next })
          const { external } = manager.views(store.servers, next)
          json(res, { ok: true, external })
          return
        }

        // POST /external/:entryId/restore — undo remove/disable. The store
        // drops (or re-arms, for edited rows) the override BEFORE the row is
        // re-created: group.create emits entry-init re-entrantly, and
        // enforcement must not see the stale override it is about to remove.
        if (req.method === 'POST' && action === 'restore') {
          const override: McpExternalOverride | undefined = store.overrides[entryId]
          if (override === undefined) { json(res, { ok: false, error: 'no override to restore' }, 404); return }
          const next = { ...store.overrides }
          if (override.state === 'removed' && override.options !== undefined) {
            delete next[entryId]
            await saveStore({ ...store, overrides: next })
            await manager.withMutation(async () => {
              await manager.restoreExternal(override.options!)
            })
          } else {
            const carried = carriedOverride(override, 'modified')
            if (carried !== undefined) next[entryId] = carried
            else delete next[entryId]
            await saveStore({ ...store, overrides: next })
            await manager.withMutation(async () => {
              await manager.setExternalEnabled(entryId, true)
            })
          }
          const { external } = manager.views(store.servers, next)
          json(res, { ok: true, external })
          return
        }
      }

      // ── add ─────────────────────────────────────────────────────────────
      if (sub === 'servers' && req.method === 'POST' && segments.length === 1) {
        const body = await parseJsonBody<{ server?: unknown }>(req)
        if (body === undefined) { json(res, { ok: false, error: 'invalid JSON body' }, 400); return }
        const { server, problem } = normalizeServer(body.server)
        if (server === undefined) { json(res, { ok: false, error: problem }, 400); return }
        const store = await loadStore()
        if (nameCollision(store, server.serverName)) {
          json(res, { ok: false, error: `serverName "${server.serverName}" is already in use` }, 409)
          return
        }
        server.id = mintId(store.servers.map(row => row.id))
        const servers = [...store.servers, server]
        await saveStore({ ...store, servers })
        let startError: string | undefined
        if (server.enabled) {
          try {
            await manager.start(server)
          } catch (error) {
            startError = error instanceof Error ? error.message : String(error)
          }
        }
        const after = await loadStore()
        const { managed, external } = manager.views(after.servers, after.overrides)
        json(res, { ok: true, server: managed.find(row => row.id === server.id), external, startError })
        return
      }

      // ── id-targeted routes: edit / delete / enable toggle ──────────────
      if (sub === 'servers' && segments.length >= 2) {
        const id = segments[1]
        const action = segments[2] ?? ''
        const store = await loadStore()
        const index = store.servers.findIndex(row => row.id === id)
        if (index < 0) { json(res, { ok: false, error: 'server not found' }, 404); return }
        const current = store.servers[index]

        // PUT /servers/:id — edit the definition; a live instance restarts
        // under the new config when the row is (still) enabled.
        if (req.method === 'PUT' && action === '') {
          const body = await parseJsonBody<{ server?: unknown }>(req)
          if (body === undefined) { json(res, { ok: false, error: 'invalid JSON body' }, 400); return }
          const { server, problem } = normalizeServer(body.server)
          if (server === undefined) { json(res, { ok: false, error: problem }, 400); return }
          if (nameCollision(store, server.serverName, id)) {
            json(res, { ok: false, error: `serverName "${server.serverName}" is already in use` }, 409)
            return
          }
          const next: McpServerDef = { ...server, id, createdAt: current.createdAt, updatedAt: Date.now() }
          const servers = [...store.servers]
          servers[index] = next
          await saveStore({ ...store, servers })
          await manager.stop(id)
          manager.clearFailure(id)
          let startError: string | undefined
          if (next.enabled) {
            try {
              await manager.start(next)
            } catch (error) {
              startError = error instanceof Error ? error.message : String(error)
            }
          }
          const after = await loadStore()
          const { managed, external } = manager.views(after.servers, after.overrides)
          json(res, { ok: true, server: managed.find(row => row.id === id), external, startError })
          return
        }

        // DELETE /servers/:id — dispose the live instance and remove the row.
        if (req.method === 'DELETE' && action === '') {
          const servers = store.servers.filter(row => row.id !== id)
          await saveStore({ ...store, servers })
          await manager.stop(id)
          manager.clearFailure(id)
          const { managed, external } = manager.views(servers, store.overrides)
          json(res, { ok: true, servers: managed, external })
          return
        }

        // POST /servers/:id/enabled — enable (load now) or disable (dispose).
        if (req.method === 'POST' && action === 'enabled') {
          const body = await parseJsonBody<{ enabled?: unknown }>(req)
          if (body === undefined || typeof body.enabled !== 'boolean') {
            json(res, { ok: false, error: 'expected { enabled: boolean }' }, 400)
            return
          }
          const next: McpServerDef = { ...current, enabled: body.enabled, updatedAt: Date.now() }
          const servers = [...store.servers]
          servers[index] = next
          await saveStore({ ...store, servers })
          await manager.stop(id)
          let startError: string | undefined
          if (next.enabled) {
            try {
              await manager.start(next)
            } catch (error) {
              startError = error instanceof Error ? error.message : String(error)
            }
          }
          const after = await loadStore()
          const { managed, external } = manager.views(after.servers, after.overrides)
          json(res, { ok: true, server: managed.find(row => row.id === id), external, startError })
          return
        }
      }

      res.writeHead(405)
      res.end()
    } catch (error: unknown) {
      ctx.logger.warn(`dsh-mcp-manage: ${String(error)}`)
      json(res, { ok: false, error: String((error as Error)?.message ?? error) }, 500)
    }
  }

  return ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
}

/**
 * Plugin entry: restore every enabled record as a live instance, keep the
 * persisted composition overrides enforced as loader rows appear, then serve
 * the management route family. Disposal (host teardown or plugin removal)
 * disposes every instance through the fiber effect scope.
 * @param ctx - the plugin context (webServer + tools injected).
 */
export async function apply(ctx: Context): Promise<void> {
  const manager = new McpManager(ctx)
  managerRef = manager
  ctx.effect(() => () => {
    managerRef = undefined
    void manager.disposeAll()
  }, 'mcp-manage: instances')

  const store = await loadStore()
  for (const server of store.servers) {
    if (!server.enabled) continue
    try {
      await manager.start(server)
    } catch (error) {
      ctx.logger.warn(`dsh-mcp-manage: ${server.serverName}: ${String(error)}`)
    }
  }

  // Composition rows may mount after this plugin (later patch layers); the
  // entry-init and config-update hooks re-enforce overrides as they appear,
  // and `enforceOverrides` converges by observation so repeats are no-ops.
  // The vendor loader owns these event names; 4.0.1 typings predate them, so
  // the subscription goes through a widened structural face.
  const on = ctx.on as unknown as (event: string, listener: () => void) => () => void
  const enforce = (): void => {
    void loadStore()
      .then(current => manager.enforceOverrides(current.overrides))
      .catch(error => ctx.logger.warn(`dsh-mcp-manage: enforce: ${String(error)}`))
  }
  ctx.effect(() => on('loader/entry-init', enforce), 'mcp-manage: entry-init enforcement')
  ctx.effect(() => on('loader/config-update', enforce), 'mcp-manage: config-update enforcement')
  enforce()

  ctx.effect(() => registerRoutes(ctx, manager), 'mcp-manage: routes')
}

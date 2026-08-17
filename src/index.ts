/**
 * dsh-mcp-manage — host half: the MCP management backend.
 *
 * One route family under /api/dsh-mcp-manage that lists every installed MCP
 * tool, and adds / edits / deletes / enables / disables MCP servers at
 * runtime. Definitions persist in `$DSH_HOME/mcp-manage/servers.json` (the
 * record store); every enabled record is loaded as a live
 * `@deepseek-ai/dsh-mcp-client` child instance of this plugin (the runtime
 * manager), so a change takes effect immediately and survives a host restart.
 * The browser half (./client) renders the 设置 → MCP 管理 page.
 *
 * @module dsh-mcp-manage
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { McpServerDef } from './types.ts'
import { loadStore, mintId, saveStore, storePath, validate } from './host/store.ts'
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
 */
function nameCollision(servers: readonly McpServerDef[], serverName: string, exceptId?: string): boolean {
  return servers.some(other => other.serverName === serverName && other.id !== exceptId)
}

/**
 * Register the MCP-management route family over one manager.
 * @returns the route disposer.
 */
function registerRoutes(ctx: Context, manager: McpManager): () => void {
  /** Snapshot the whole surface (managed rows + composition-owned tools). */
  const listPayload = async (): Promise<Record<string, unknown>> => {
    const servers = await loadStore()
    const { managed, external } = manager.views(servers)
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

      // ── add ─────────────────────────────────────────────────────────────
      if (sub === 'servers' && req.method === 'POST' && segments.length === 1) {
        const body = await parseJsonBody<{ server?: unknown }>(req)
        if (body === undefined) { json(res, { ok: false, error: 'invalid JSON body' }, 400); return }
        const { server, problem } = normalizeServer(body.server)
        if (server === undefined) { json(res, { ok: false, error: problem }, 400); return }
        const servers = await loadStore()
        if (nameCollision(servers, server.serverName)) {
          json(res, { ok: false, error: `serverName "${server.serverName}" is already in use` }, 409)
          return
        }
        server.id = mintId(servers.map(row => row.id))
        servers.push(server)
        await saveStore(servers)
        let startError: string | undefined
        if (server.enabled) {
          try {
            await manager.start(server)
          } catch (error) {
            startError = error instanceof Error ? error.message : String(error)
          }
        }
        const { managed, external } = manager.views(await loadStore())
        json(res, { ok: true, server: managed.find(row => row.id === server.id), external, startError })
        return
      }

      // ── id-targeted routes: edit / delete / enable toggle ──────────────
      if (sub === 'servers' && segments.length >= 2) {
        const id = segments[1]
        const action = segments[2] ?? ''
        const servers = await loadStore()
        const index = servers.findIndex(row => row.id === id)
        if (index < 0) { json(res, { ok: false, error: 'server not found' }, 404); return }
        const current = servers[index]

        // PUT /servers/:id — edit the definition; a live instance restarts
        // under the new config when the row is (still) enabled.
        if (req.method === 'PUT' && action === '') {
          const body = await parseJsonBody<{ server?: unknown }>(req)
          if (body === undefined) { json(res, { ok: false, error: 'invalid JSON body' }, 400); return }
          const { server, problem } = normalizeServer(body.server)
          if (server === undefined) { json(res, { ok: false, error: problem }, 400); return }
          if (nameCollision(servers, server.serverName, id)) {
            json(res, { ok: false, error: `serverName "${server.serverName}" is already in use` }, 409)
            return
          }
          const next: McpServerDef = { ...server, id, createdAt: current.createdAt, updatedAt: Date.now() }
          servers[index] = next
          await saveStore(servers)
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
          const { managed, external } = manager.views(await loadStore())
          json(res, { ok: true, server: managed.find(row => row.id === id), external, startError })
          return
        }

        // DELETE /servers/:id — dispose the live instance and remove the row.
        if (req.method === 'DELETE' && action === '') {
          servers.splice(index, 1)
          await saveStore(servers)
          await manager.stop(id)
          manager.clearFailure(id)
          const { managed, external } = manager.views(await loadStore())
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
          servers[index] = next
          await saveStore(servers)
          await manager.stop(id)
          let startError: string | undefined
          if (next.enabled) {
            try {
              await manager.start(next)
            } catch (error) {
              startError = error instanceof Error ? error.message : String(error)
            }
          }
          const { managed, external } = manager.views(await loadStore())
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
 * Plugin entry: restore every enabled record as a live instance, then serve
 * the management route family. Disposal (host teardown or plugin removal)
 * disposes every instance through the fiber effect scope.
 * @param ctx - the plugin context (webServer + tools injected).
 */
export async function apply(ctx: Context): Promise<void> {
  const manager = new McpManager(ctx)
  ctx.effect(() => () => {
    void manager.disposeAll()
  }, 'mcp-manage: instances')

  const servers = await loadStore()
  for (const server of servers) {
    if (!server.enabled) continue
    try {
      await manager.start(server)
    } catch (error) {
      ctx.logger.warn(`dsh-mcp-manage: ${server.serverName}: ${String(error)}`)
    }
  }

  ctx.effect(() => registerRoutes(ctx, manager), 'mcp-manage: routes')
}

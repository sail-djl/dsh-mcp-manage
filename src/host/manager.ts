/**
 * MCP runtime manager — the live half of MCP management.
 *
 * Loads one `@deepseek-ai/dsh-mcp-client` plugin instance per enabled record
 * as an effect-scoped child of this plugin's fiber, tracks each instance's
 * activation state, and enumerates the MCP tools visible on `ctx.tools`.
 * Combined with the record store this gives add / edit / delete / enable /
 * disable at runtime, with no host restart.
 *
 * @module dsh-mcp-manage/host/manager
 */

import type { Context } from '@deepseek-ai/cordis'
import type { McpExternalServer, McpRuntimeState, McpServerDef, McpServerView } from '../types.ts'

/** Public tool-name prefix the generic mcp-client registers under. */
const MCP_TOOL_PREFIX = /^mcp__([A-Za-z0-9_-]{1,64})__(.+)$/

/** Structural face of the generic mcp-client plugin this manager loads. */
interface McpClientModule {
  name: string
  inject: string[]
  apply: (ctx: Context, config: Record<string, unknown>) => Promise<void>
}

/** The vendor loader declaration-merges `entry` onto Fiber; 4.0.1 typings predate it. */
interface EntryCarrier {
  entry?: { parent?: { tree?: { import: (name: string) => Promise<unknown> } } }
}

/** What `ctx.plugin()` hands back for one loaded instance. */
interface PluginHandle {
  await: () => Promise<void>
  dispose: () => Promise<void>
}

/** One live managed instance. */
interface LiveInstance {
  def: McpServerDef
  handle: PluginHandle
  state: Exclude<McpRuntimeState, 'disabled'>
  error?: string
}

/**
 * Per-plugin manager. One instance per host fiber; disposal of the owning
 * plugin disposes every live instance through the fiber effect scope.
 */
export class McpManager {
  /** Loaded instances keyed by record id. */
  private readonly live = new Map<string, LiveInstance>()
  /** Last activation failure text per record id (survives instance disposal). */
  private readonly failures = new Map<string, string>()
  /** The mcp-client module, imported once per manager. */
  private module: McpClientModule | undefined
  /** In-flight import so concurrent starts share one attempt. */
  private importing: Promise<McpClientModule> | undefined

  constructor(private readonly ctx: Context) {}

  /**
   * Import the generic mcp-client. Resolution order mirrors the loader: the
   * owning entry tree first (bare names resolve against the same base as
   * every composed row — the dsh installation), then a plain import (a
   * profile-local dependency install).
   */
  private async resolveModule(): Promise<McpClientModule> {
    if (this.module !== undefined) return this.module
    this.importing ??= (async () => {
      // The loader tree that mounted this plugin resolves bare names against
      // the same base as every composed row (the dsh installation).
      const tree = (this.ctx.fiber as unknown as EntryCarrier).entry?.parent?.tree
      if (tree !== undefined) {
        try {
          const mod = await tree.import('@deepseek-ai/dsh-mcp-client') as McpClientModule
          if (typeof mod?.apply === 'function') return mod
        } catch {
          // Fall through to the plain import below.
        }
      }
      // Dynamic specifier: the package is an optional peer resolved from the
      // running dsh installation, not from this plugin's own install.
      const specifier = '@deepseek-ai/dsh-mcp-client'
      const mod = await import(/* @vite-ignore */ specifier) as McpClientModule
      if (typeof mod?.apply !== 'function') {
        throw new Error('@deepseek-ai/dsh-mcp-client resolved without an apply export')
      }
      return mod
    })()
    try {
      this.module = await this.importing
      return this.module
    } finally {
      this.importing = undefined
    }
  }

  /** Translate one record into the generic client's config shape. */
  private toConfig(def: McpServerDef): Record<string, unknown> {
    if (def.transport === 'stdio') {
      return {
        transport: 'stdio',
        serverName: def.serverName,
        command: def.command,
        args: def.args ?? [],
        env: def.env ?? {},
        cwd: def.cwd === undefined || def.cwd === '' ? process.cwd() : def.cwd,
        toolCallTimeoutMs: def.toolCallTimeoutMs ?? 60_000,
        failOnStartupError: def.failOnStartupError ?? false,
      }
    }
    return {
      transport: 'streamable-http',
      serverName: def.serverName,
      url: def.url,
      headers: def.headers ?? {},
      toolCallTimeoutMs: def.toolCallTimeoutMs ?? 60_000,
      failOnStartupError: def.failOnStartupError ?? false,
    }
  }

  /**
   * Load one enabled record as a live instance. The fork is awaited so the
   * caller's HTTP response reports the settled activation: `active` on
   * success, `error` (already disposed) on rejection.
   */
  async start(def: McpServerDef): Promise<void> {
    if (this.live.has(def.id)) return
    const mod = await this.resolveModule()
    const handle = this.ctx.plugin(mod, this.toConfig(def)) as unknown as PluginHandle
    const instance: LiveInstance = { def, handle, state: 'connecting' }
    this.live.set(def.id, instance)
    try {
      await instance.handle.await()
      instance.state = 'active'
      instance.error = undefined
      this.failures.delete(def.id)
    } catch (error) {
      instance.state = 'error'
      instance.error = error instanceof Error ? error.message : String(error)
      this.failures.set(def.id, instance.error)
      await this.disposeInstance(def.id)
      throw error
    }
  }

  /** Clear one record's remembered failure (after a successful edit). */
  clearFailure(id: string): void {
    this.failures.delete(id)
  }

  /** Last activation failure text for a record, if any. */
  failureOf(id: string): string | undefined {
    return this.failures.get(id)
  }

  /** Dispose one live instance (idempotent; missing ids are a no-op). */
  async stop(id: string): Promise<void> {
    await this.disposeInstance(id)
  }

  private async disposeInstance(id: string): Promise<void> {
    const instance = this.live.get(id)
    if (instance === undefined) return
    this.live.delete(id)
    try {
      await instance.handle.dispose()
    } catch (error) {
      this.ctx.logger.warn(`dsh-mcp-manage: disposing ${instance.def.serverName}: ${String(error)}`)
    }
  }

  /** Live `serverName`s this manager owns (collision checks on add/edit). */
  activeServerNames(): Set<string> {
    return new Set([...this.live.values()].map(instance => instance.def.serverName))
  }

  /** The record a live instance was loaded from (status views). */
  instanceDef(id: string): McpServerDef | undefined {
    return this.live.get(id)?.def
  }

  /** MCP tools visible on `ctx.tools`, grouped by server namespace. */
  toolsByServer(): Map<string, string[]> {
    const groups = new Map<string, string[]>()
    const registry = this.ctx.get('tools')
    if (registry === undefined) return groups
    for (const schema of registry.schemas() as Array<{ name: string }>) {
      const match = MCP_TOOL_PREFIX.exec(schema.name)
      if (match === null) continue
      const [, serverName, tool] = match
      const bucket = groups.get(serverName)
      if (bucket === undefined) groups.set(serverName, [tool])
      else bucket.push(tool)
    }
    for (const tools of groups.values()) tools.sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
    return groups
  }

  /**
   * Project the record list into view rows: managed state plus discovered
   * tools, and the composition-configured servers this plugin does not own.
   */
  views(servers: readonly McpServerDef[]): { managed: McpServerView[]; external: McpExternalServer[] } {
    const groups = this.toolsByServer()
    const managed = servers.map((def): McpServerView => {
      const instance = this.live.get(def.id)
      const tools = groups.get(def.serverName) ?? []
      if (instance === undefined) {
        if (!def.enabled) return { ...def, state: 'disabled', tools: [] }
        const failure = this.failures.get(def.id)
        if (failure !== undefined) return { ...def, state: 'error', error: failure, tools: [] }
        return { ...def, state: 'connecting', tools: [] }
      }
      return { ...def, state: instance.state, error: instance.error, tools }
    })
    const mine = new Set(servers.map(def => def.serverName))
    const external: McpExternalServer[] = []
    for (const [serverName, tools] of groups) {
      if (mine.has(serverName)) continue
      external.push({ serverName, tools })
    }
    external.sort((a, b) => a.serverName < b.serverName ? -1 : 1)
    return { managed, external }
  }

  /** Dispose every live instance (plugin teardown). */
  async disposeAll(): Promise<void> {
    for (const id of [...this.live.keys()]) await this.disposeInstance(id)
  }
}

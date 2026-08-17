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
import type {
  McpExternalOverride, McpExternalServer, McpRuntimeState, McpServerDef, McpServerView,
} from '../types.ts'

/** Public tool-name prefix the generic mcp-client registers under. */
const MCP_TOOL_PREFIX = /^mcp__([A-Za-z0-9_-]{1,64})__(.+)$/

/** Package name of the generic mcp-client rows in a composition. */
const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'

/** Structural face of one vendored-Loader entry row. */
interface LoaderEntry {
  /** Path-qualified id (nested trees join segments with ':'). */
  id: string
  disabled: boolean
  options: { id: string; name?: unknown; config?: unknown; disabled?: unknown }
  parent: LoaderGroup
  /** Merge options and restart as needed — does NOT persist to disk. */
  update(options: Record<string, unknown>): Promise<void>
}

/** Structural face of one loader entry group. */
interface LoaderGroup {
  /** The group's serialized row list; a restored row must join it or the next
   * reconciliation (config reload) drops it again. */
  data: Array<Record<string, unknown>>
  create(options: Record<string, unknown>): Promise<string>
  remove(id: string): Promise<void>
}

/** Structural face of one loader entry tree. */
interface LoaderTree {
  import(name: string): Promise<unknown>
  root: LoaderGroup
}

/** Structural face of the vendored Loader service (4.0.1 typings omit it). */
interface LoaderFace {
  entries(): Iterable<LoaderEntry>
  resolve(id: string): LoaderEntry
}

/** Structural face of the generic mcp-client plugin this manager loads. */
interface McpClientModule {
  name: string
  inject: string[]
  apply: (ctx: Context, config: Record<string, unknown>) => Promise<void>
}

/** The vendor loader declaration-merges `entry` onto Fiber; 4.0.1 typings predate it. */
interface EntryCarrier {
  entry?: { parent?: { tree?: LoaderTree } }
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
  /**
   * Set while an explicit mutation (restore) is settling. The loader emits
   * `entry-init` re-entrantly inside `group.create`, and the enforcement hook
   * must not read a stale override store and undo the very row being built.
   */
  private mutating = false

  /** Run `task` with enforcement suspended (explicit mutations own ordering). */
  async withMutation<T>(task: () => Promise<T>): Promise<T> {
    this.mutating = true
    try {
      return await task()
    } finally {
      this.mutating = false
    }
  }

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
   * tools, and the composition-configured servers this plugin does not own
   * (with their persisted override state).
   */
  views(servers: readonly McpServerDef[], overrides: Readonly<Record<string, McpExternalOverride>> = {}):
    { managed: McpServerView[]; external: McpExternalServer[] } {
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
    for (const row of this.externalEntries()) {
      if (mine.has(row.serverName)) continue
      const stored = overrides[row.entryId]
      const override: McpExternalServer['override'] = stored === undefined ? 'none' : stored.state
      external.push({
        entryId: row.entryId,
        serverName: row.serverName,
        override,
        tools: override === 'none' ? groups.get(row.serverName) ?? [] : [],
      })
    }
    // Removed rows are absent from the loader; surface them from the overrides
    // so the UI can offer restore.
    const present = new Set(external.map(row => row.entryId))
    for (const [entryId, override] of Object.entries(overrides)) {
      if (override.state !== 'removed' || present.has(entryId)) continue
      const name = (override.options?.config as { serverName?: unknown } | undefined)?.serverName
      if (typeof name !== 'string') continue
      if (mine.has(name)) continue
      external.push({ entryId, serverName: name, override: 'removed', tools: [] })
    }
    external.sort((a, b) => a.serverName < b.serverName ? -1 : 1)
    return { managed, external }
  }

  // ---- composition (external) mcp-client rows, managed through the loader ----

  /** Structural face of the vendored Loader service (4.0.1 typings omit it). */
  private loaderFace(): LoaderFace | undefined {
    return this.ctx.get('loader') as LoaderFace | undefined
  }

  /**
   * Every composition mcp-client row currently in the loader tree.
   * Entries created by this manager's own instances carry no loader row.
   */
  externalEntries(): Array<{ entryId: string; serverName: string; disabled: boolean }> {
    const loader = this.loaderFace()
    if (loader === undefined) return []
    const rows: Array<{ entryId: string; serverName: string; disabled: boolean }> = []
    for (const entry of loader.entries()) {
      if (entry.options.name !== MCP_CLIENT_PACKAGE) continue
      const serverName = (entry.options.config as { serverName?: unknown } | undefined)?.serverName
      if (typeof serverName !== 'string') continue
      rows.push({ entryId: entry.id, serverName, disabled: entry.disabled })
    }
    return rows
  }

  /**
   * Disable (or re-enable) one composition row. Runs through the entry's own
   * `update`, which mounts/disposes the fiber WITHOUT persisting to the
   * composition file — this plugin's store is the single persistence for
   * overrides, so a user-patch HMR reload that resets rows is re-enforced
   * from here instead of fighting a materialized write-back.
   */
  async setExternalEnabled(entryId: string, enabled: boolean): Promise<void> {
    const entry = this.resolveExternal(entryId)
    await entry.update({ disabled: enabled ? null : true })
  }

  /** Remove one composition row, returning its options for a later restore. */
  async removeExternal(entryId: string): Promise<Record<string, unknown>> {
    const entry = this.resolveExternal(entryId)
    const options = structuredClone(entry.options) as unknown as Record<string, unknown>
    // group.remove stops the fiber and unlinks the row; the disk file is
    // deliberately untouched (see setExternalEnabled).
    await entry.parent.remove(entry.options.id)
    return options
  }

  /** Re-create a previously removed composition row in its original tree. */
  async restoreExternal(options: Record<string, unknown>): Promise<string> {
    const loader = this.loaderFace()
    const tree = (this.ctx.fiber as unknown as EntryCarrier).entry?.parent?.tree
    const group = tree?.root
    if (loader === undefined || group === undefined) throw new Error('loader entry tree unavailable')
    const id = await group.create(options)
    // Mirror EntryTree.create's bookkeeping (minus the disk write): the row
    // must sit in the group's data list or the next reconciliation drops it.
    let created: Record<string, unknown> | undefined
    try {
      created = loader.resolve(id).options as unknown as Record<string, unknown>
    } catch {
      created = undefined
    }
    if (created !== undefined && !group.data.includes(created)) group.data.push(created)
    return id
  }

  /** Resolve one composition row or throw the loader's own not-found error. */
  private resolveExternal(entryId: string): LoaderEntry {
    const loader = this.loaderFace()
    if (loader === undefined) throw new Error('loader service unavailable')
    return loader.resolve(entryId)
  }

  /**
   * Idempotently apply persisted overrides against the live tree. Converging
   * by observation (is the row already in the desired state?) keeps repeated
   * calls — boot entry-init events, config reloads, list reads — free of
   * side effects.
   */
  async enforceOverrides(overrides: Readonly<Record<string, McpExternalOverride>>): Promise<void> {
    if (this.mutating) return
    const loader = this.loaderFace()
    if (loader === undefined) return
    for (const [entryId, override] of Object.entries(overrides)) {
      let entry: LoaderEntry | undefined
      try {
        entry = loader.resolve(entryId)
      } catch {
        entry = undefined
      }
      try {
        if (override.state === 'disabled' && entry !== undefined && !entry.disabled) {
          await entry.update({ disabled: true })
        } else if (override.state === 'removed' && entry !== undefined) {
          await entry.parent.remove(entry.options.id)
        }
      } catch (error) {
        this.ctx.logger.warn(`dsh-mcp-manage: override ${entryId}: ${String(error)}`)
      }
    }
  }

  /** Dispose every live instance (plugin teardown). */
  async disposeAll(): Promise<void> {
    for (const id of [...this.live.keys()]) await this.disposeInstance(id)
  }
}

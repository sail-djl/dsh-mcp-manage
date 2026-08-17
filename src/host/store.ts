/**
 * MCP server record store — the durable half of MCP management.
 *
 * Records live in `$DSH_HOME/mcp-manage/servers.json` (outside every session
 * workspace) and are mutated only through this module: load, save, mint ids,
 * and validate definitions. The runtime half (loading live
 * `@deepseek-ai/dsh-mcp-client` instances) lives in ./manager.ts.
 *
 * @module dsh-mcp-manage/host/store
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import type { McpExternalOverride, McpServerDef, McpServerId } from '../types.ts'

/** Same `serverName` budget the generic mcp-client enforces. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** On-disk document shape; `version` gates future migrations. */
interface StoreDocument {
  version: 1
  servers: McpServerDef[]
  /** Runtime overrides against composition mcp-client rows, keyed by entry id. */
  overrides?: Record<string, McpExternalOverride>
}

/** The whole durable store. */
export interface StoreShape {
  servers: McpServerDef[]
  overrides: Record<string, McpExternalOverride>
}

/** An empty store. */
export function emptyStore(): StoreShape {
  return { servers: [], overrides: {} }
}

/** Resolve the plugin's storage directory under the DSH home. */
export function storeDir(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'mcp-manage')
}

/** Absolute path of the servers document. */
export function storePath(): string {
  return join(storeDir(), 'servers.json')
}

/** Mint a record id that is unique against `existing`. */
export function mintId(existing: readonly McpServerId[]): McpServerId {
  let id: string
  do {
    id = `srv-${Math.random().toString(16).slice(2, 10)}`
  } while (existing.includes(id))
  return id
}

/**
 * Load the store; a missing document is an empty store (first use), while an
 * unreadable or malformed one throws loud — a present file that cannot parse
 * is a corruption the operator must see, never silently reset.
 */
export async function loadStore(): Promise<StoreShape> {
  let text: string
  try {
    text = await readFile(storePath(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return emptyStore()
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`dsh-mcp-manage: cannot parse ${storePath()}: ${String(error)}`)
  }
  return normalizeDocument(parsed)
}

/** Validate a parsed document into the full store, dropping nothing silently. */
function normalizeDocument(parsed: unknown): StoreShape {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`dsh-mcp-manage: ${storePath()} must hold { version, servers }`)
  }
  const doc = parsed as Partial<StoreDocument>
  if (doc.version !== 1 || !Array.isArray(doc.servers)) {
    throw new Error(`dsh-mcp-manage: ${storePath()} must hold { version: 1, servers: [...] }`)
  }
  for (const [index, server] of doc.servers.entries()) {
    const problem = validate(server)
    if (problem !== undefined) {
      throw new Error(`dsh-mcp-manage: ${storePath()} server ${index + 1}: ${problem}`)
    }
  }
  const overrides = doc.overrides ?? {}
  for (const [entryId, override] of Object.entries(overrides)) {
    if (override?.state !== 'disabled' && override?.state !== 'removed') {
      throw new Error(`dsh-mcp-manage: ${storePath()} override ${entryId}: state must be "disabled" or "removed"`)
    }
    if (override.state === 'removed' && (typeof override.options !== 'object' || override.options === null)) {
      throw new Error(`dsh-mcp-manage: ${storePath()} override ${entryId}: removed rows must retain their options`)
    }
  }
  return { servers: doc.servers, overrides }
}

/** Persist the store atomically (tmp file + rename), creating the directory. */
export async function saveStore(store: StoreShape): Promise<void> {
  const document: StoreDocument = {
    version: 1,
    servers: [...store.servers],
    overrides: store.overrides,
  }
  const path = storePath()
  await mkdir(storeDir(), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

/**
 * Validate one definition; returns the first problem or undefined.
 * Mirrors the generic mcp-client config contract without importing it.
 */
export function validate(server: Partial<McpServerDef>): string | undefined {
  if (typeof server.serverName !== 'string' || SERVER_NAME_PATTERN.test(server.serverName) === false) {
    return 'serverName must match [A-Za-z0-9_-]{1,32}'
  }
  if (server.transport !== 'stdio' && server.transport !== 'streamable-http') {
    return 'transport must be "stdio" or "streamable-http"'
  }
  if (server.transport === 'stdio') {
    if (typeof server.command !== 'string' || server.command.length === 0) {
      return 'stdio transport requires a non-empty command'
    }
    if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some(a => typeof a !== 'string'))) {
      return 'args must be an array of strings'
    }
    if (server.env !== undefined && (typeof server.env !== 'object' || server.env === null
      || Object.entries(server.env).some(([k, v]) => typeof k !== 'string' || typeof v !== 'string'))) {
      return 'env must be a string-to-string mapping'
    }
    if (server.cwd !== undefined && server.cwd !== '' && (typeof server.cwd !== 'string' || !isAbsolute(server.cwd))) {
      return 'cwd must be an absolute path or empty'
    }
  } else {
    if (typeof server.url !== 'string' || !/^https?:\/\//.test(server.url)) {
      return 'streamable-http transport requires an http(s) url'
    }
    if (server.headers !== undefined && (typeof server.headers !== 'object' || server.headers === null
      || Object.entries(server.headers).some(([k, v]) => typeof k !== 'string' || typeof v !== 'string'))) {
      return 'headers must be a string-to-string mapping'
    }
  }
  if (server.toolCallTimeoutMs !== undefined
    && (typeof server.toolCallTimeoutMs !== 'number' || !Number.isFinite(server.toolCallTimeoutMs) || server.toolCallTimeoutMs <= 0)) {
    return 'toolCallTimeoutMs must be a positive number'
  }
  return undefined
}

/** Whether the store file exists (first-run detection for the UI). */
export function storeExists(): boolean {
  return existsSync(storePath())
}

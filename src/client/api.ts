/**
 * Browser-side API client for the /api/dsh-mcp-manage route family.
 * Plain fetch, same origin — the only data path the MCP page uses.
 *
 * @module dsh-mcp-manage/client/api
 */

import type { McpExternalServer, McpServerDef, McpServerView } from '../types.ts'

/** Route prefix the host half serves. */
export const ROUTE_PREFIX = '/api/dsh-mcp-manage'

/** Full surface read (GET /servers). */
export interface ServersSnapshot {
  servers: McpServerView[]
  external: McpExternalServer[]
  storePath: string
}

/** Result of one mutation (add / edit / toggle): the settled row plus the
 * activation failure text when the live instance could not start. */
export interface MutationResult {
  server?: McpServerView
  startError?: string
}

/** Raw JSON envelope every route answers with. */
interface Envelope {
  ok: boolean
  error?: string
  startError?: string
}

/** Fetch and check one route, returning the parsed envelope. */
async function request(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${ROUTE_PREFIX}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let parsed: Record<string, unknown>
  try {
    parsed = await response.json() as Record<string, unknown>
  } catch {
    throw new Error(`HTTP ${String(response.status)}`)
  }
  if (!parsed.ok) throw new Error(typeof parsed.error === 'string' ? parsed.error : `HTTP ${String(response.status)}`)
  return parsed
}

/** Read every managed server and composition-owned MCP tool group. */
export async function listServers(): Promise<ServersSnapshot> {
  const parsed = await request('GET', '/servers')
  return {
    servers: (parsed.servers ?? []) as McpServerView[],
    external: (parsed.external ?? []) as McpExternalServer[],
    storePath: typeof parsed.storePath === 'string' ? parsed.storePath : '',
  }
}

/** Add one server definition; loads it immediately when enabled. */
export async function addServer(server: McpServerDef): Promise<MutationResult> {
  const parsed = await request('POST', '/servers', { server })
  return { server: parsed.server as McpServerView | undefined, startError: parsed.startError as string | undefined }
}

/** Replace one server definition; restarts its live instance when enabled. */
export async function updateServer(id: string, server: McpServerDef): Promise<MutationResult> {
  const parsed = await request('PUT', `/servers/${encodeURIComponent(id)}`, { server })
  return { server: parsed.server as McpServerView | undefined, startError: parsed.startError as string | undefined }
}

/** Delete one server definition and dispose its live instance. */
export async function deleteServer(id: string): Promise<void> {
  await request('DELETE', `/servers/${encodeURIComponent(id)}`)
}

/** Enable (load now) or disable (dispose) one server. */
export async function setServerEnabled(id: string, enabled: boolean): Promise<MutationResult> {
  const parsed = await request('POST', `/servers/${encodeURIComponent(id)}/enabled`, { enabled })
  return { server: parsed.server as McpServerView | undefined, startError: parsed.startError as string | undefined }
}

/** Enable (or disable) one composition-provided MCP row through the loader. */
export async function setExternalEnabled(entryId: string, enabled: boolean): Promise<McpExternalServer[]> {
  const parsed = await request('POST', `/external/${encodeURIComponent(entryId)}/enabled`, { enabled })
  return (parsed.external ?? []) as McpExternalServer[]
}

/** Remove one composition-provided MCP row (restorable). */
export async function removeExternal(entryId: string): Promise<McpExternalServer[]> {
  const parsed = await request('DELETE', `/external/${encodeURIComponent(entryId)}`)
  return (parsed.external ?? []) as McpExternalServer[]
}

/** Undo a remove/disable override on one composition-provided row. */
export async function restoreExternal(entryId: string): Promise<McpExternalServer[]> {
  const parsed = await request('POST', `/external/${encodeURIComponent(entryId)}/restore`)
  return (parsed.external ?? []) as McpExternalServer[]
}

/** Replace one composition row's mcp-client config (runtime edit). */
export async function updateExternalConfig(entryId: string, server: McpServerDef): Promise<McpExternalServer[]> {
  const parsed = await request('PUT', `/external/${encodeURIComponent(entryId)}/config`, { server })
  return (parsed.external ?? []) as McpExternalServer[]
}

/** Revert one composition row's runtime config edit to its original options. */
export async function revertExternalConfig(entryId: string): Promise<McpExternalServer[]> {
  const parsed = await request('POST', `/external/${encodeURIComponent(entryId)}/revert`)
  return (parsed.external ?? []) as McpExternalServer[]
}

export type { Envelope }

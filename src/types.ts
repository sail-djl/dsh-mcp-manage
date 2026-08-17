/**
 * Shared MCP-management wire types — the single vocabulary the host route
 * family serves and the browser settings page renders. Kept dependency-free
 * so both halves (and unit tests) import it without pulling cordis.
 *
 * @module dsh-mcp-manage/types
 */

/** Stable record id minted by the host (`srv-<8 hex>`). */
export type McpServerId = string

/** One persisted MCP server definition (stored under `$DSH_HOME/mcp-manage/servers.json`). */
export interface McpServerDef {
  /** Stable record id; the runtime instance and every API call key on it. */
  id: McpServerId
  /**
   * Local namespace for the server's model-facing tool names
   * (`mcp__<serverName>__<tool>`). Must match `[A-Za-z0-9_-]{1,32}` and be
   * unique across every live mcp-client instance.
   */
  serverName: string
  /** Transport selector: spawned stdio child or Streamable HTTP endpoint. */
  transport: 'stdio' | 'streamable-http'
  /** Whether the host loads a live mcp-client instance for this record. */
  enabled: boolean
  /** stdio: executable used to start the server. */
  command?: string
  /** stdio: arguments passed directly, without shell interpolation. */
  args?: string[]
  /** stdio: extra env vars merged on top of the scrubbed ambient env. */
  env?: Record<string, string>
  /** stdio: working directory for the child process (empty = DSH cwd). */
  cwd?: string
  /** streamable-http: MCP endpoint URL. */
  url?: string
  /** streamable-http: additional headers attached to MCP requests. */
  headers?: Record<string, string>
  /** Per-tool-call timeout in milliseconds (default 60000). */
  toolCallTimeoutMs?: number
  /** Fail the instance when the initial connection or tool sync fails. */
  failOnStartupError?: boolean
  /** Record creation time (epoch ms). */
  createdAt: number
  /** Last modification time (epoch ms). */
  updatedAt: number
}

/** Live runtime state of one managed server's mcp-client instance. */
export type McpRuntimeState = 'disabled' | 'connecting' | 'active' | 'error'

/** One managed server row as the settings page renders it. */
export interface McpServerView extends McpServerDef {
  /** Current runtime state of the live instance. */
  state: McpRuntimeState
  /** Last activation failure text, present when `state` is `error`. */
  error?: string
  /** Discovered tool names (`mcp__<serverName>__<tool>`) of the live instance. */
  tools: string[]
}

/** One read-only server discovered from the composition (not managed here). */
export interface McpExternalServer {
  /** Namespace parsed from the `mcp__<serverName>__<tool>` prefix. */
  serverName: string
  /** Its registered tool names. */
  tools: string[]
}

/** GET /api/dsh-mcp-manage/servers response body. */
export interface McpServersResult {
  ok: boolean
  servers?: McpServerView[]
  external?: McpExternalServer[]
  storePath?: string
  error?: string
}

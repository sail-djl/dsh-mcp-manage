/**
 * The MCP management settings page body (JSX component).
 *
 * Sections: managed MCP server cards (state badge, tool list behind the
 * clickable tool count, enable switch, edit, delete), an add/edit form
 * (stdio command/args/env/cwd or Streamable HTTP url/headers), and the
 * composition-provided MCP catalog — equally manageable at runtime
 * (enable/disable, delete with restore). Styled after the official settings
 * pages (theme variables, card rows).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import {
  addServer,
  deleteServer,
  listServers,
  removeExternal,
  restoreExternal,
  setExternalEnabled,
  setServerEnabled,
  updateServer,
  type MutationResult,
  type ServersSnapshot,
} from './api.ts'
import type { McpExternalServer, McpServerDef, McpServerView } from '../types.ts'

/** Plugin CSS, scoped by a package-unique class prefix. */
export const CSS = `
.mcpm-page { display: flex; flex-direction: column; gap: 16px; width: min(100%, 760px); color: var(--dsw-alias-label-primary); }
.mcpm-section { border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; background: var(--dsw-alias-bg-layer-1); }
.mcpm-section-head { margin: 0; font-size: 14px; font-weight: 600; }
.mcpm-desc { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.mcpm-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mcpm-btn { height: 32px; padding: 0 16px; border: none; border-radius: 16px; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-foreground, #fff); cursor: pointer; font-size: 13px; }
.mcpm-btn:not(:disabled):hover { opacity: 0.9; }
.mcpm-btn:disabled { opacity: 0.5; cursor: default; }
.mcpm-btn-ghost { height: 30px; padding: 0 14px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 15px; background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer; font-size: 13px; }
.mcpm-btn-ghost:not(:disabled):hover { background: var(--dsw-alias-bg-layer-2); }
.mcpm-btn-ghost:disabled { opacity: 0.5; cursor: default; }
.mcpm-btn-danger { color: var(--dsw-alias-state-error-primary); }
.mcpm-err { font-size: 12px; color: var(--dsw-alias-state-error-primary); }
.mcpm-ok { font-size: 12px; color: var(--dsw-alias-state-success-primary); }
.mcpm-meta { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.mcpm-mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; color: var(--dsw-alias-label-secondary); word-break: break-all; }
.mcpm-loading { font-size: 13px; color: var(--dsw-alias-label-secondary); }
.mcpm-empty { font-size: 12px; color: var(--dsw-alias-label-secondary); margin: 0; }
.mcpm-card { display: flex; flex-direction: column; gap: 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 10px 12px; }
.mcpm-card-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mcpm-name { font-size: 14px; font-weight: 600; }
.mcpm-badge { font-size: 11px; padding: 2px 8px; border-radius: 9px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.mcpm-badge-active { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.mcpm-badge-error { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.mcpm-badge-connecting { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.mcpm-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.mcpm-switch { position: relative; width: 36px; height: 20px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); cursor: pointer; padding: 0; }
.mcpm-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--dsw-alias-label-secondary); transition: transform 120ms ease, background 120ms ease; }
.mcpm-switch[data-on='true'] { background: var(--dsw-alias-brand-primary); }
.mcpm-switch[data-on='true']::after { transform: translateX(16px); background: #fff; }
.mcpm-switch:disabled { opacity: 0.5; cursor: default; }
.mcpm-tools { display: flex; flex-wrap: wrap; gap: 4px; }
.mcpm-tool { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; padding: 2px 6px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); word-break: break-all; }
.mcpm-count { margin-left: auto; font-size: 12px; color: var(--dsw-alias-label-secondary); background: none; border: none; padding: 2px 8px; border-radius: 8px; cursor: pointer; font-family: inherit; }
.mcpm-count:hover { background: var(--dsw-alias-bg-layer-2); }
.mcpm-count:disabled { cursor: default; opacity: 0.6; }
.mcpm-form { display: flex; flex-direction: column; gap: 10px; }
.mcpm-field { display: flex; flex-direction: column; gap: 4px; }
.mcpm-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.mcpm-input, .mcpm-select { height: 30px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; outline: none; }
.mcpm-input:focus, .mcpm-select:focus { border-color: var(--dsw-alias-brand-primary); }
.mcpm-area { box-sizing: border-box; width: 100%; min-height: 60px; resize: vertical; padding: 8px 10px; font: inherit; font-size: 12px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; line-height: 1.6; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); outline: none; }
.mcpm-area:focus { border-color: var(--dsw-alias-brand-primary); }
.mcpm-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
.mcpm-external { display: flex; flex-direction: column; gap: 8px; }
`

/** Human label for one runtime state. */
function stateLabel(state: McpServerView['state']): string {
  if (state === 'active') return '运行中'
  if (state === 'error') return '启动失败'
  if (state === 'connecting') return '连接中'
  return '已停用'
}

function stateClass(state: McpServerView['state']): string {
  if (state === 'active') return 'mcpm-badge mcpm-badge-active'
  if (state === 'error') return 'mcpm-badge mcpm-badge-error'
  if (state === 'connecting') return 'mcpm-badge mcpm-badge-connecting'
  return 'mcpm-badge'
}

/** The clickable tool-count chip: expands the hidden tool list on click. */
function ToolCount(props: { tools: readonly string[]; expanded: boolean; onToggle: () => void }): JSX.Element {
  return (
    <button type='button' className='mcpm-count'
      disabled={props.tools.length === 0}
      onClick={props.onToggle}
      title={props.tools.length === 0 ? '未发现工具' : props.expanded ? '收起工具列表' : '展开工具列表'}>
      {props.tools.length} 个工具 {props.tools.length > 0 ? (props.expanded ? '▲' : '▼') : ''}
    </button>
  )
}

/** The expandable tool list itself. */
function ToolList(props: { tools: readonly string[]; expanded: boolean }): JSX.Element | null {
  if (!props.expanded || props.tools.length === 0) return null
  return (
    <div className='mcpm-tools'>
      {props.tools.map(tool => <span key={tool} className='mcpm-tool'>{tool}</span>)}
    </div>
  )
}

/** One managed server card. */
function ServerCard(props: {
  server: McpServerView
  busy: boolean
  onToggle: (server: McpServerView) => void
  onEdit: (server: McpServerView) => void
  onDelete: (server: McpServerView) => void
}): JSX.Element {
  const { server, busy, onToggle, onEdit, onDelete } = props
  const [expanded, setExpanded] = useState(false)
  const [confirming, setConfirming] = useState(false)
  return (
    <div className='mcpm-card'>
      <div className='mcpm-card-top'>
        <span className='mcpm-name'>{server.serverName}</span>
        <span className='mcpm-badge'>{server.transport === 'stdio' ? 'stdio' : 'http'}</span>
        <span className={stateClass(server.state)}>{stateLabel(server.state)}</span>
        <ToolCount tools={server.tools} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
        <span className='mcpm-actions'>
          <button type='button' className='mcpm-switch' data-on={server.enabled} disabled={busy}
            title={server.enabled ? '停用' : '启用'}
            onClick={() => onToggle(server)} aria-label={server.enabled ? '停用' : '启用'} />
          <button type='button' className='mcpm-btn-ghost' disabled={busy} onClick={() => onEdit(server)}>编辑</button>
          {confirming
            ? (
              <>
                <button type='button' className='mcpm-btn-ghost mcpm-btn-danger' disabled={busy}
                  onClick={() => onDelete(server)}>确认删除</button>
                <button type='button' className='mcpm-btn-ghost' disabled={busy} onClick={() => setConfirming(false)}>取消</button>
              </>
            )
            : (
              <button type='button' className='mcpm-btn-ghost mcpm-btn-danger' disabled={busy}
                onClick={() => setConfirming(true)}>删除</button>
            )}
        </span>
      </div>
      {server.error !== undefined && server.error !== '' ? <div className='mcpm-err'>{server.error}</div> : null}
      <ToolList tools={server.tools} expanded={expanded} />
      {server.transport === 'stdio'
        ? <div className='mcpm-mono'>{[server.command, ...(server.args ?? [])].join(' ')}</div>
        : <div className='mcpm-mono'>{server.url}</div>}
    </div>
  )
}

/** One composition-provided MCP card: enable switch, delete, restore. */
function ExternalCard(props: {
  row: McpExternalServer
  busy: boolean
  onToggle: (row: McpExternalServer) => void
  onDelete: (row: McpExternalServer) => void
  onRestore: (row: McpExternalServer) => void
}): JSX.Element {
  const { row, busy, onToggle, onDelete, onRestore } = props
  const [expanded, setExpanded] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const removed = row.override === 'removed'
  const disabled = row.override === 'disabled'
  return (
    <div className='mcpm-card' style={removed ? { opacity: 0.65 } : undefined}>
      <div className='mcpm-card-top'>
        <span className='mcpm-name'>{row.serverName}</span>
        <span className='mcpm-badge'>组合</span>
        {removed
          ? <span className='mcpm-badge'>已删除</span>
          : <span className={disabled ? 'mcpm-badge' : 'mcpm-badge mcpm-badge-active'}>{disabled ? '已停用' : '运行中'}</span>}
        {!removed
          ? <ToolCount tools={row.tools} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
          : <span className='mcpm-meta'>已从运行组合中移除</span>}
        <span className='mcpm-actions'>
          {removed
            ? <button type='button' className='mcpm-btn-ghost' disabled={busy} onClick={() => onRestore(row)}>恢复</button>
            : (
              <>
                <button type='button' className='mcpm-switch' data-on={!disabled} disabled={busy}
                  title={disabled ? '启用' : '停用'}
                  onClick={() => onToggle(row)} aria-label={disabled ? '启用' : '停用'} />
                {confirming
                  ? (
                    <>
                      <button type='button' className='mcpm-btn-ghost mcpm-btn-danger' disabled={busy}
                        onClick={() => onDelete(row)}>确认移除</button>
                      <button type='button' className='mcpm-btn-ghost' disabled={busy} onClick={() => setConfirming(false)}>取消</button>
                    </>
                  )
                  : (
                    <button type='button' className='mcpm-btn-ghost mcpm-btn-danger' disabled={busy}
                      onClick={() => setConfirming(true)}>移除</button>
                  )}
              </>
            )}
        </span>
      </div>
      <ToolList tools={row.tools} expanded={expanded} />
    </div>
  )
}

/** Draft form state derived from a definition (or blank for add). */
interface Draft {
  serverName: string
  transport: 'stdio' | 'streamable-http'
  command: string
  argsText: string
  envText: string
  cwd: string
  url: string
  headersText: string
  toolCallTimeoutMs: string
}

const EMPTY_DRAFT: Draft = {
  serverName: '',
  transport: 'stdio',
  command: '',
  argsText: '',
  envText: '',
  cwd: '',
  url: '',
  headersText: '',
  toolCallTimeoutMs: '',
}

/** Build a draft from an existing definition for editing. */
function draftOf(server: McpServerDef): Draft {
  return {
    serverName: server.serverName,
    transport: server.transport,
    command: server.command ?? '',
    argsText: (server.args ?? []).join('\n'),
    envText: Object.entries(server.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
    cwd: server.cwd ?? '',
    url: server.url ?? '',
    headersText: Object.entries(server.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n'),
    toolCallTimeoutMs: server.toolCallTimeoutMs === undefined ? '' : String(server.toolCallTimeoutMs),
  }
}

/** Parse `KEY=VALUE` lines into a mapping, throwing on a malformed line. */
function parseEnvLines(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) throw new Error(`环境变量行格式应为 KEY=VALUE：${trimmed}`)
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
  }
  return env
}

/** Parse `KEY: VALUE` lines into a mapping, throwing on a malformed line. */
function parseHeaderLines(text: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const colon = trimmed.indexOf(':')
    if (colon <= 0) throw new Error(`请求头行格式应为 KEY: VALUE：${trimmed}`)
    headers[trimmed.slice(0, colon).trim()] = trimmed.slice(colon + 1).trim()
  }
  return headers
}

/** Turn a draft into a definition payload, throwing the first problem. */
function draftToServer(draft: Draft): McpServerDef {
  const timeout = draft.toolCallTimeoutMs.trim() === '' ? undefined : Number(draft.toolCallTimeoutMs)
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) throw new Error('工具调用超时必须是正数（毫秒）')
  const base = {
    id: '',
    serverName: draft.serverName.trim(),
    transport: draft.transport,
    enabled: true,
    toolCallTimeoutMs: timeout,
    createdAt: 0,
    updatedAt: 0,
  }
  if (draft.transport === 'stdio') {
    return {
      ...base,
      command: draft.command.trim(),
      args: draft.argsText.split('\n').map(line => line.trim()).filter(line => line !== ''),
      env: parseEnvLines(draft.envText),
      cwd: draft.cwd.trim(),
    }
  }
  return { ...base, url: draft.url.trim(), headers: parseHeaderLines(draft.headersText) }
}

/** Add / edit form. */
function ServerForm(props: {
  initial: McpServerDef | null
  busy: boolean
  onSubmit: (server: McpServerDef) => void
  onCancel: () => void
}): JSX.Element {
  const { initial, busy, onSubmit, onCancel } = props
  const [draft, setDraft] = useState<Draft>(initial === null ? EMPTY_DRAFT : draftOf(initial))
  const [error, setError] = useState('')
  const set = (patch: Partial<Draft>): void => setDraft({ ...draft, ...patch })
  const submit = (): void => {
    try {
      onSubmit(draftToServer(draft))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <div className='mcpm-form'>
      <div className='mcpm-grid'>
        <div className='mcpm-field'>
          <label className='mcpm-label'>服务器名称（serverName，工具前缀 mcp__名称__*，仅字母数字_-，≤32）</label>
          <input className='mcpm-input' value={draft.serverName}
            onChange={e => set({ serverName: e.target.value })} placeholder='例如 adb' />
        </div>
        <div className='mcpm-field'>
          <label className='mcpm-label'>传输方式</label>
          <select className='mcpm-select' value={draft.transport}
            onChange={e => set({ transport: e.target.value as Draft['transport'] })}>
            <option value='stdio'>stdio（本地命令）</option>
            <option value='streamable-http'>Streamable HTTP（远程端点）</option>
          </select>
        </div>
      </div>
      {draft.transport === 'stdio' ? (
        <>
          <div className='mcpm-grid'>
            <div className='mcpm-field'>
              <label className='mcpm-label'>启动命令（command）</label>
              <input className='mcpm-input' value={draft.command}
                onChange={e => set({ command: e.target.value })} placeholder='例如 node' />
            </div>
            <div className='mcpm-field'>
              <label className='mcpm-label'>工作目录（cwd，留空 = DSH 当前目录）</label>
              <input className='mcpm-input' value={draft.cwd}
                onChange={e => set({ cwd: e.target.value })} placeholder='H:\\AIGC\\mcp\\adb-mcp-master' />
            </div>
          </div>
          <div className='mcpm-field'>
            <label className='mcpm-label'>参数（args，每行一个）</label>
            <textarea className='mcpm-area' value={draft.argsText}
              onChange={e => set({ argsText: e.target.value })} placeholder={'dist/index.js'} />
          </div>
          <div className='mcpm-field'>
            <label className='mcpm-label'>环境变量（每行 KEY=VALUE）</label>
            <textarea className='mcpm-area' value={draft.envText}
              onChange={e => set({ envText: e.target.value })} placeholder={'API_KEY=...'} />
          </div>
        </>
      ) : (
        <>
          <div className='mcpm-field'>
            <label className='mcpm-label'>端点 URL（http/https）</label>
            <input className='mcpm-input' value={draft.url}
              onChange={e => set({ url: e.target.value })} placeholder='http://127.0.0.1:3000/mcp' />
          </div>
          <div className='mcpm-field'>
            <label className='mcpm-label'>附加请求头（每行 KEY: VALUE）</label>
            <textarea className='mcpm-area' value={draft.headersText}
              onChange={e => set({ headersText: e.target.value })} placeholder={'Authorization: Bearer ...'} />
          </div>
        </>
      )}
      <div className='mcpm-field'>
        <label className='mcpm-label'>工具调用超时（毫秒，留空 = 60000）</label>
        <input className='mcpm-input' value={draft.toolCallTimeoutMs}
          onChange={e => set({ toolCallTimeoutMs: e.target.value })} placeholder='60000' />
      </div>
      {error !== '' ? <div className='mcpm-err'>{error}</div> : null}
      <div className='mcpm-row'>
        <button type='button' className='mcpm-btn' disabled={busy} onClick={submit}>保存并加载</button>
        <button type='button' className='mcpm-btn-ghost' disabled={busy} onClick={onCancel}>取消</button>
      </div>
    </div>
  )
}

/** The whole settings page. */
export function McpManageSection(): JSX.Element {
  const [snapshot, setSnapshot] = useState<ServersSnapshot | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState<McpServerDef | null>(null)
  const [showForm, setShowForm] = useState(false)
  const noticeTimer = useRef<number | undefined>(undefined)

  const clearNoticeSoon = useCallback((): void => {
    if (noticeTimer.current !== undefined) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(''), 3000)
  }, [])

  const refresh = useCallback((): void => {
    setLoaded(false)
    listServers()
      .then(result => {
        setSnapshot(result)
        setError('')
      })
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoaded(true))
  }, [])

  useEffect(refresh, [refresh])

  /** Apply one mutation result: refresh, surface activation failures. */
  const apply = (result: MutationResult, okText: string): void => {
    refresh()
    if (result.startError !== undefined && result.startError !== '') {
      setError(`已保存，但实例启动失败：${result.startError}`)
    } else {
      setError('')
      setNotice(okText)
      clearNoticeSoon()
    }
  }

  const run = (action: () => Promise<unknown>, okText: string): void => {
    setBusy(true)
    action()
      .then(() => {
        refresh()
        setError('')
        setNotice(okText)
        clearNoticeSoon()
      })
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  const toggle = (server: McpServerView): void => {
    run(() => setServerEnabled(server.id, !server.enabled), server.enabled ? '已停用' : '已启用')
  }

  const remove = (server: McpServerView): void => {
    run(() => deleteServer(server.id), '已删除')
  }

  const submit = (server: McpServerDef): void => {
    const done = (): void => {
      setShowForm(false)
      setEditing(null)
    }
    if (editing === null) {
      setBusy(true)
      addServer(server)
        .then(result => { apply(result, '已添加并加载'); done() })
        .catch(e => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setBusy(false))
    } else {
      setBusy(true)
      updateServer(editing.id, server)
        .then(result => { apply(result, '已保存并重启'); done() })
        .catch(e => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setBusy(false))
    }
  }

  const toggleExternal = (row: McpExternalServer): void => {
    run(() => setExternalEnabled(row.entryId, row.override !== 'none'),
      row.override === 'none' ? '已停用' : '已启用')
  }

  const deleteExternal = (row: McpExternalServer): void => {
    run(() => removeExternal(row.entryId), '已移除（可恢复）')
  }

  const restoreExternalRow = (row: McpExternalServer): void => {
    run(() => restoreExternal(row.entryId), '已恢复')
  }

  return (
    <div className='mcpm-page'>
      <section className='mcpm-section'>
        <h3 className='mcpm-section-head'>MCP 服务器</h3>
        <p className='mcpm-desc'>
          管理接入 DSH 的 MCP 服务器：启用后立即加载为运行实例，工具以 mcp__名称__* 注册到当前会话；
          停用立即卸载。点击“N 个工具”展开或收起工具列表。配置保存在本机，主机重启后自动恢复。
        </p>
        {snapshot !== null && snapshot.storePath !== '' ? <div className='mcpm-mono'>{snapshot.storePath}</div> : null}
        {error !== '' ? <div className='mcpm-err'>{error}</div> : null}
        {notice !== '' ? <div className='mcpm-ok'>{notice}</div> : null}
        {!loaded ? <div className='mcpm-loading'>加载中…</div> : null}
        {loaded && snapshot !== null && snapshot.servers.length === 0
          ? <p className='mcpm-empty'>尚未配置 MCP 服务器。</p>
          : null}
        {snapshot !== null
          ? snapshot.servers.map(server => (
            <ServerCard key={server.id} server={server} busy={busy}
              onToggle={toggle} onEdit={s => { setEditing(s); setShowForm(true) }} onDelete={remove} />
          ))
          : null}
        {!showForm ? (
          <button type='button' className='mcpm-btn' style={{ alignSelf: 'flex-start' }}
            onClick={() => { setEditing(null); setShowForm(true) }}>添加服务器</button>
        ) : null}
        {showForm ? (
          <ServerForm initial={editing} busy={busy} onSubmit={submit}
            onCancel={() => { setShowForm(false); setEditing(null) }} />
        ) : null}
      </section>

      <section className='mcpm-section'>
        <h3 className='mcpm-section-head'>来自组合配置的 MCP</h3>
        <p className='mcpm-desc'>
          以下 MCP 服务器由 DSH 组合文件（cordis.yml / patch）提供，同样可以停用或移除（可恢复）；
          覆盖状态保存在本机，主机重启后自动维持。源组合文件不会被修改。
        </p>
        {loaded && snapshot !== null && snapshot.external.length === 0
          ? <p className='mcpm-empty'>没有来自组合配置的 MCP 服务器。</p>
          : null}
        {snapshot !== null && snapshot.external.length > 0 ? (
          <div className='mcpm-external'>
            {snapshot.external.map(row => (
              <ExternalCard key={row.entryId} row={row} busy={busy}
                onToggle={toggleExternal} onDelete={deleteExternal} onRestore={restoreExternalRow} />
            ))}
          </div>
        ) : null}
      </section>
    </div>
  )
}

/**
 * Unit tests for the MCP-management host store: validation, id minting,
 * and document round-tripping. Runs against a temporary DSH_HOME so the
 * operator's real store is never touched.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { carriedOverride, loadStore, mintId, saveStore, storePath, validate } from '../src/host/store.ts'

let home: string

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'mcp-manage-test-'))
  process.env.DSH_HOME = home
})

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('validate', () => {
  it('accepts a stdio definition', () => {
    expect(validate({
      serverName: 'adb', transport: 'stdio', command: 'node',
      args: ['x'], env: { A: 'b' }, cwd: '',
    })).toBeUndefined()
  })

  it('accepts a streamable-http definition', () => {
    expect(validate({
      serverName: 'remote', transport: 'streamable-http', url: 'http://127.0.0.1:3000/mcp',
      headers: { Authorization: 'Bearer x' },
    })).toBeUndefined()
  })

  it('rejects a malformed serverName', () => {
    expect(validate({ serverName: 'has space', transport: 'stdio', command: 'x' }))
      .toMatch(/serverName/)
    expect(validate({ serverName: 'x'.repeat(33), transport: 'stdio', command: 'x' }))
      .toMatch(/serverName/)
  })

  it('rejects stdio without a command', () => {
    expect(validate({ serverName: 'a', transport: 'stdio' })).toMatch(/command/)
  })

  it('rejects http without an http(s) url', () => {
    expect(validate({ serverName: 'a', transport: 'streamable-http', url: 'ftp://x' })).toMatch(/url/)
  })

  it('rejects a relative cwd and a non-positive timeout', () => {
    expect(validate({ serverName: 'a', transport: 'stdio', command: 'x', cwd: 'rel/path' })).toMatch(/cwd/)
    expect(validate({ serverName: 'a', transport: 'stdio', command: 'x', toolCallTimeoutMs: 0 }))
      .toMatch(/toolCallTimeoutMs/)
  })
})

describe('store round-trip', () => {
  it('returns an empty store for a missing document', async () => {
    await expect(loadStore()).resolves.toEqual({ servers: [], overrides: {} })
  })

  it('persists and reloads records atomically', async () => {
    const record = {
      id: mintId([]), serverName: 'echo', transport: 'stdio' as const, enabled: true,
      command: 'node', args: [], env: {}, cwd: '',
      createdAt: 1, updatedAt: 2,
    }
    await saveStore({ servers: [record], overrides: {} })
    await expect(loadStore()).resolves.toEqual({ servers: [record], overrides: {} })
  })

  it('round-trips external overrides', async () => {
    await saveStore({
      servers: [],
      overrides: {
        'mcp-x': { state: 'disabled' },
        'mcp-y': { state: 'removed', options: { id: 'mcp-y', name: '@deepseek-ai/dsh-mcp-client' } },
      },
    })
    const store = await loadStore()
    expect(store.overrides['mcp-x']).toEqual({ state: 'disabled' })
    expect(store.overrides['mcp-y']?.state).toBe('removed')
  })

  it('throws loud on a malformed document', async () => {
    await writeFile(storePath(), '{ not json', 'utf8')
    await expect(loadStore()).rejects.toThrow(/cannot parse/)
    await writeFile(storePath(), '{"version": 2, "servers": []}', 'utf8')
    await expect(loadStore()).rejects.toThrow(/version: 1/)
  })
})

describe('mintId', () => {
  it('never collides with the provided existing ids', () => {
    const existing = Array.from({ length: 100 }, () => mintId([]))
    const one = mintId(existing)
    expect(existing).not.toContain(one)
    expect(one).toMatch(/^srv-[0-9a-f]{8}$/)
  })
})

describe('carriedOverride', () => {
  it('keeps the historical bare shapes when no edit exists', () => {
    expect(carriedOverride(undefined, 'disabled')).toEqual({ state: 'disabled' })
    expect(carriedOverride({ state: 'disabled' }, 'disabled')).toEqual({ state: 'disabled' })
    expect(carriedOverride(undefined, 'modified')).toBeUndefined()
    expect(carriedOverride({ state: 'disabled' }, 'modified')).toBeUndefined()
  })

  it('carries a config edit across a toggle in both directions', () => {
    const edited = { state: 'modified' as const, config: { serverName: 'x' }, options: { id: 'e1' } }
    const dormant = carriedOverride(edited, 'disabled')
    expect(dormant).toEqual({ state: 'disabled', config: { serverName: 'x' }, options: { id: 'e1' } })
    expect(carriedOverride(dormant, 'modified')).toEqual(edited)
  })

  it('round-trips an edited override through the store document', async () => {
    await saveStore({
      servers: [],
      overrides: {
        'mcp-edited': { state: 'modified', config: { transport: 'stdio', serverName: 'x', command: 'node' }, options: { id: 'mcp-edited' } },
        'mcp-edited-off': { state: 'disabled', config: { transport: 'stdio', serverName: 'y', command: 'node' }, options: { id: 'mcp-edited-off' } },
      },
    })
    const store = await loadStore()
    expect(store.overrides['mcp-edited']?.state).toBe('modified')
    expect(store.overrides['mcp-edited-off']).toEqual({
      state: 'disabled', config: { transport: 'stdio', serverName: 'y', command: 'node' }, options: { id: 'mcp-edited-off' },
    })
  })
})

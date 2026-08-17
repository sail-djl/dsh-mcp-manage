#!/usr/bin/env node
/**
 * Minimal stdio MCP server used by dsh-mcp-manage's tests: hand-rolled
 * JSON-RPC 2.0 over newline-delimited stdin/stdout implementing exactly the
 * initialize / tools/list / tools/call surface the generic mcp-client needs.
 * No dependencies; run with `node echo-mcp-server.mjs`.
 */

const PROTOCOL = '2024-11-05'
const TOOLS = [
  {
    name: 'echo',
    description: 'Echo back the input value.',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
  },
  {
    name: 'ping',
    description: 'Answer pong.',
    inputSchema: { type: 'object', properties: {} },
  },
]

process.stdin.setEncoding('utf8')
let buffer = ''
process.stdin.on('data', chunk => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line === '') continue
    handle(JSON.parse(line))
  }
})

function reply(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function handle(request) {
  const { id, method, params } = request
  if (method === 'initialize') {
    reply({ jsonrpc: '2.0', id, result: { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'echo-mcp', version: '1.0.0' } } })
    return
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
  if (method === 'tools/list') {
    reply({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    return
  }
  if (method === 'tools/call') {
    const tool = params?.name
    if (tool === 'echo') {
      reply({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(params?.arguments?.value ?? '') }] } })
    } else if (tool === 'ping') {
      reply({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'pong' }] } })
    } else {
      reply({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${String(tool)}` } })
    }
    return
  }
  reply({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${String(method)}` } })
}

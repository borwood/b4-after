// Drives LikeC4's MCP server over stdio and measures response sizes per tool.
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { here, workspace, bytes, writeOut, section } from './_common.mjs'

const bin = join(here, '..', 'node_modules', 'likec4', 'bin', 'likec4.mjs')
const proc = spawn(process.execPath, [bin, 'mcp', '--stdio', workspace], { stdio: ['pipe', 'pipe', 'pipe'] })
let stderr = ''
proc.stderr.on('data', d => { stderr += d })

let buf = ''
const pending = new Map()
proc.stdout.on('data', chunk => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
    if (!line) continue
    try {
      const msg = JSON.parse(line)
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
    } catch { /* non-JSON noise */ }
  }
})
let nextId = 1
const call = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++
  const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 60000)
  pending.set(id, (m) => { clearTimeout(t); resolve(m) })
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
})
const notify = (method, params) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')

try {
  const init = await call('initialize', {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'phase-a-spike', version: '0.0.0' },
  })
  notify('notifications/initialized', {})
  section('server')
  console.log(' ', JSON.stringify(init.result?.serverInfo), 'protocol', init.result?.protocolVersion)

  section('tools/list')
  const list = await call('tools/list', {})
  const tools = list.result?.tools ?? []
  console.log(' tool count:', tools.length, '| tools/list payload:', bytes(list), 'bytes')
  for (const t of tools) {
    const props = Object.keys(t.inputSchema?.properties ?? {})
    console.log(`  - ${t.name}(${props.join(', ')})`)
  }
  writeOut('05-mcp-tools.json', tools)

  section('tool call footprints (bytes of text content returned)')
  const projectsRaw = await call('tools/call', { name: 'list-projects', arguments: {} })
  console.log(' raw list-projects result shape:', JSON.stringify(projectsRaw.result, (k, v) => typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '...' : v).slice(0, 700))
  const projectId = JSON.stringify(projectsRaw.result).match(/"(?:id|name|project(?:Id)?)"\s*:\s*"([^"]+)"/)?.[1] ?? 'default'
  console.log(' using project id:', projectId)

  const probes = [
    ['read-project-summary', { project: projectId }],
    ['search-element', { search: 'billing' }],
    ['read-element', { id: 'billing.billing_api', project: projectId }],
    ['batch-read-elements', { ids: ['billing.invoice_ui', 'billing.ledger_db'], project: projectId }],
    ['query-graph', { elementId: 'billing', queryType: 'children', project: projectId }],
    ['subgraph-summary', { elementId: 'billing', maxDepth: 2, project: projectId }],
    ['read-view', { viewId: 'billing', project: projectId }],
    ['query-by-metadata', { key: 'stable_id', value: 'ent-charges', matchMode: 'exact', project: projectId }],
    ['find-relationships', { element1: 'billing.invoice_ui', element2: 'billing.billing_api', project: projectId }],
  ]
  const results = {}
  for (const [name, sent] of probes) {
    const tool = tools.find(t => t.name === name)
    if (!tool) { console.log(`  ${name}: (not offered by server)`); continue }
    const res = await call('tools/call', { name, arguments: sent })
    const content = res.result?.content ?? []
    const text = content.map(c => c.type === 'text' ? c.text : `[${c.type}]`).join('\n')
    const structured = res.result?.structuredContent
    const total = bytes(text) + (structured ? bytes(structured) : 0)
    const err = res.error ? ` ERROR ${res.error.message}` : res.result?.isError ? ' isError' : ''
    const types = content.map(c => c.type).join('+') || 'none'
    console.log(`  ${name.padEnd(22)} -> ${String(total).padStart(6)} bytes  content=[${types}] structured=${structured ? 'yes' : 'no'}${err}`)
    results[name] = { args: sent, bytes: total, contentTypes: types, error: res.error ?? null, isError: res.result?.isError ?? false, text, structured }
  }
  writeOut('05-mcp-results.json', results)
  const preview = (name, n = 20) => {
    const r = results[name]
    const body = r?.text || (r?.structured ? JSON.stringify(r.structured, null, 1) : '')
    console.log(`\n ${name} preview:\n` + body.split('\n').slice(0, n).map(l => '   ' + l).join('\n'))
  }
  preview('read-project-summary', 30)
  preview('read-element', 25)
  preview('query-graph', 15)
} catch (e) {
  console.log('MCP probe failed:', e.message)
  console.log('stderr tail:', stderr.slice(-1500))
} finally {
  proc.kill()
}

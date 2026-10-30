// Human-readable output for a projection or baseline (AR-14, AT-10). The data is materialised as
// a disposable LikeC4 workspace; nothing here maintains a second diagram source.
//
// `html` is the format for people: LikeC4's interactive single-file site, where every view can be
// explored, elements expanded, and parallel relationships told apart. `png` needs Playwright.
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Ledger } from './ledger.js'
import type { ParsedModelData } from './model.js'
import { workspaceFiles, writeWorkspace } from './workspace.js'

export type Renderable = { data: ParsedModelData }

/** The DSL as one text: specification, model and generated views. */
export async function projectionToDSL(data: ParsedModelData, ledger?: Ledger): Promise<string> {
  return Object.values(await workspaceFiles(data, ledger)).join('\n')
}

export interface MaterializedWorkspace { dir: string; files: string[]; dispose(): Promise<void> }

export interface MaterializeOptions {
  /** Directory to write into. Default: a temporary directory removed by dispose(). */
  dir?: string
  /** Ledger, so generated target views can show pending property updates. */
  ledger?: Ledger
}

/** Write the data to a LikeC4 workspace. Caller disposes. */
export async function materializeProjection(projection: Renderable, opts: MaterializeOptions = {}): Promise<MaterializedWorkspace> {
  const dir = opts.dir ?? await mkdtemp(join(tmpdir(), 'cb4-projection-'))
  const files = await workspaceFiles(projection.data, opts.ledger)
  await writeWorkspace(dir, files)
  return { dir, files: Object.keys(files), dispose: () => opts.dir ? Promise.resolve() : rm(dir, { recursive: true, force: true }) }
}

export type RenderFormat = 'dsl' | 'png' | 'html'

export interface RenderOptions {
  format: RenderFormat
  /** View ids to render (png). Default: all views. */
  views?: string[]
  /** Output directory for png or html files. Default: a temporary directory the caller must clean up. */
  outDir?: string
  theme?: 'light' | 'dark'
  timeoutMs?: number
  ledger?: Ledger
}

export type RenderResult =
  | { format: 'dsl'; dsl: string }
  | { format: 'png'; outDir: string; files: string[]; log: string }
  | { format: 'html'; outDir: string; file: string; log: string }

/** Render a projection or baseline. `png` and `html` use the likec4 CLI; `png` also needs Playwright with Chromium. */
export async function renderProjection(projection: Renderable, opts: RenderOptions): Promise<RenderResult> {
  if (opts.format === 'dsl') return { format: 'dsl', dsl: await projectionToDSL(projection.data, opts.ledger) }

  const ws = await materializeProjection(projection, { ledger: opts.ledger })
  try {
    const outDir = opts.outDir ?? await mkdtemp(join(tmpdir(), 'cb4-render-'))
    const timeout = opts.timeoutMs ?? 180_000
    if (opts.format === 'html') {
      const log = await likec4(['build', ws.dir, '-o', outDir, '--output-single-file', '--use-hash-history', ...(opts.theme ? ['--theme', opts.theme] : [])], timeout)
      return { format: 'html', outDir, file: join(outDir, 'index.html'), log }
    }
    const args = ['export', 'png', ws.dir, '-o', outDir, '--flat', '--max-attempts', '1']
    if (opts.theme) args.push('--theme', opts.theme)
    for (const v of opts.views ?? []) args.push('-f', v)
    const log = await likec4(args, timeout)
    const files = (await readdir(outDir)).filter(f => f.endsWith('.png')).sort()
    return { format: 'png', outDir, files, log }
  } finally {
    await ws.dispose()
  }
}

function likec4(args: string[], timeoutMs: number): Promise<string> {
  const require = createRequire(import.meta.url)
  const bin = join(dirname(require.resolve('likec4/package.json')), 'bin', 'likec4.mjs')
  return run(process.execPath, [bin, ...args], timeoutMs)
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { out += d })
    const t = setTimeout(() => { child.kill(); reject(new Error(`render timed out after ${timeoutMs}ms\n${out.slice(-2000)}`)) }, timeoutMs)
    child.on('error', e => { clearTimeout(t); reject(e) })
    child.on('close', code => {
      clearTimeout(t)
      if (code === 0) resolve(out)
      else reject(new Error(`likec4 ${args[1]} exited with ${code}\n${out.slice(-2000)}`))
    })
  })
}

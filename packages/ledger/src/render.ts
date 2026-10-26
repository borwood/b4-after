// Human-readable output for a projection (AR-14, AT-10). The projection is materialised as a
// disposable LikeC4 workspace; nothing here maintains a second diagram source.
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Projection } from './projection.js'
import { generateDSL, type ParsedModelData } from './model.js'

export async function projectionToDSL(data: ParsedModelData): Promise<string> {
  return generateDSL(data)
}

export interface MaterializedWorkspace { dir: string; file: string; dispose(): Promise<void> }

/** Write the projection to a temporary LikeC4 workspace. Caller disposes. */
export async function materializeProjection(projection: Pick<Projection, 'data'>, dir?: string): Promise<MaterializedWorkspace> {
  const target = dir ?? await mkdtemp(join(tmpdir(), 'b4-after-projection-'))
  await mkdir(target, { recursive: true })
  const file = join(target, 'model.c4')
  await writeFile(file, await projectionToDSL(projection.data), 'utf8')
  return { dir: target, file, dispose: () => dir ? Promise.resolve() : rm(target, { recursive: true, force: true }) }
}

export interface RenderOptions {
  format: 'dsl' | 'png'
  /** View ids to render (png). Default: all views. */
  views?: string[]
  /** Output directory for png files. Default: a temporary directory the caller must clean up. */
  outDir?: string
  theme?: 'light' | 'dark'
  timeoutMs?: number
}

export type RenderResult =
  | { format: 'dsl'; dsl: string }
  | { format: 'png'; outDir: string; files: string[]; log: string }

/** Render a projection. `png` uses the likec4 CLI (Playwright + Chromium must be available). */
export async function renderProjection(projection: Pick<Projection, 'data'>, opts: RenderOptions): Promise<RenderResult> {
  if (opts.format === 'dsl') return { format: 'dsl', dsl: await projectionToDSL(projection.data) }

  const ws = await materializeProjection(projection)
  try {
    const outDir = opts.outDir ?? await mkdtemp(join(tmpdir(), 'b4-after-render-'))
    const require = createRequire(import.meta.url)
    const bin = join(dirname(require.resolve('likec4/package.json')), 'bin', 'likec4.mjs')
    const args = [bin, 'export', 'png', ws.dir, '-o', outDir, '--flat', '--max-attempts', '1']
    if (opts.theme) args.push('--theme', opts.theme)
    for (const v of opts.views ?? []) args.push('-f', v)
    const log = await run(process.execPath, args, opts.timeoutMs ?? 180_000)
    const files = (await readdir(outDir)).filter(f => f.endsWith('.png')).sort()
    return { format: 'png', outDir, files, log }
  } finally {
    await ws.dispose()
  }
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
      else reject(new Error(`likec4 export exited with ${code}\n${out.slice(-2000)}`))
    })
  })
}

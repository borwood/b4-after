// cb4 [repoDir] [--actor <name>]        start the MCP server (stdio) over a model repository
// cb4 skill [name...] [--codex] [--to <dir>]   install the shipped skills into the current project
// Env: CB4_REPO, CB4_ACTOR.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RepoContext } from './context.js'
import { resolveRepoDir } from './paths.js'
import { createServer, SERVER_VERSION } from './server.js'

const USAGE = `usage:
  cb4 [repoDir] [--actor <name>]     MCP server (stdio) over a model repository
  cb4 skill [name...] [--codex] [--to <dir>]
            install the shipped skills (cb4-guide, cb4-adopt) for your coding agent;
            name one or more to install only those

  repoDir   model repository: its own git repository with model/, changes/, evidence/.
            Created on first use by the bootstrap tool. Default: $CB4_REPO or cwd.
  --actor   default actor recorded on writes (env CB4_ACTOR); tools may override per call.
  --codex   install skills to .agents/skills/ (Codex) instead of .claude/skills/ (Claude Code).
  --to      install skills under this skills directory instead.
`

const SKILLS_DIR = new URL('../skills/', import.meta.url)

/** Install every skill shipped with this package, or the named ones, into a skills directory. */
async function installSkill(args: string[]): Promise<void> {
  let target: string | undefined
  let codex = false
  const names: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--codex') codex = true
    else if (a === '--claude') codex = false
    else if (a === '--to') target = args[++i]
    else if (a.startsWith('-')) { process.stderr.write(`unknown option ${a}\n${USAGE}`); process.exit(2) }
    else names.push(a)
  }
  const available = (await readdir(fileURLToPath(SKILLS_DIR), { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name).sort()
  const unknown = names.filter(n => !available.includes(n))
  if (unknown.length) { process.stderr.write(`unknown skill(s): ${unknown.join(', ')}; available: ${available.join(', ')}\n`); process.exit(2) }
  const skillsDir = resolve(target ?? (codex ? '.agents/skills' : '.claude/skills'))
  for (const name of names.length ? names : available) {
    const dest = join(skillsDir, name, 'SKILL.md')
    await mkdir(join(skillsDir, name), { recursive: true })
    await writeFile(dest, await readFile(fileURLToPath(new URL(`${name}/SKILL.md`, SKILLS_DIR)), 'utf8'), 'utf8')
    process.stdout.write(`installed ${name} -> ${dest}\n`)
  }
}

async function serve(args: string[]): Promise<void> {
  let repoDir = process.env.CB4_REPO ?? process.cwd()
  let actor = process.env.CB4_ACTOR
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--actor') actor = args[++i]
    else if (a.startsWith('-')) { process.stderr.write(`unknown option ${a}\n${USAGE}`); process.exit(2) }
    else repoDir = a
  }
  // A relative path anchors to the main worktree of the surrounding code repository, so every
  // linked worktree, subagent, and the main session share one ledger (see paths.ts).
  const resolved = await resolveRepoDir(repoDir)
  const ctx = new RepoContext(resolved.dir, { actor })
  const server = createServer(ctx)
  await server.connect(new StdioServerTransport())
  const anchor = resolved.via === 'main-worktree' ? ` (relative to main worktree ${resolved.mainWorktree})` : ''
  process.stderr.write(`cb4 ${SERVER_VERSION}: ${ctx.repoDir}${anchor}${actor ? ` (actor ${actor})` : ''}\n`)
}

const argv = process.argv.slice(2)
if (argv.includes('-h') || argv.includes('--help')) { process.stdout.write(USAGE); process.exit(0) }
if (argv.includes('-v') || argv.includes('--version')) { process.stdout.write(`${SERVER_VERSION}\n`); process.exit(0) }
if (argv[0] === 'skill') await installSkill(argv.slice(1))
else await serve(argv)

// b4-after [repoDir] [--actor <name>]        start the MCP server (stdio) over a model repository
// b4-after skill [--codex] [--to <dir>]      install the adoption skill into the current project
// Env: B4_AFTER_REPO, B4_AFTER_ACTOR.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RepoContext } from './context.js'
import { resolveRepoDir } from './paths.js'
import { createServer, SERVER_VERSION } from './server.js'

const USAGE = `usage:
  b4-after [repoDir] [--actor <name>]     MCP server (stdio) over a model repository
  b4-after skill [--codex] [--to <dir>]   install the b4-after-adopt skill for your coding agent

  repoDir   model repository: its own git repository with model/, changes/, evidence/.
            Created on first use by the bootstrap tool. Default: $B4_AFTER_REPO or cwd.
  --actor   default actor recorded on writes (env B4_AFTER_ACTOR); tools may override per call.
  --codex   install the skill to .agents/skills/ (Codex) instead of .claude/skills/ (Claude Code).
  --to      install the skill under this skills directory instead.
`

const SKILL_NAME = 'b4-after-adopt'

async function installSkill(args: string[]): Promise<void> {
  let target: string | undefined
  let codex = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--codex') codex = true
    else if (a === '--claude') codex = false
    else if (a === '--to') target = args[++i]
    else { process.stderr.write(`unknown option ${a}\n${USAGE}`); process.exit(2) }
  }
  const skillsDir = resolve(target ?? (codex ? '.agents/skills' : '.claude/skills'))
  const src = fileURLToPath(new URL(`../skills/${SKILL_NAME}/SKILL.md`, import.meta.url))
  const dest = join(skillsDir, SKILL_NAME, 'SKILL.md')
  await mkdir(join(skillsDir, SKILL_NAME), { recursive: true })
  await writeFile(dest, await readFile(src, 'utf8'), 'utf8')
  process.stdout.write(`installed ${SKILL_NAME} -> ${dest}\n`)
}

async function serve(args: string[]): Promise<void> {
  let repoDir = process.env.B4_AFTER_REPO ?? process.cwd()
  let actor = process.env.B4_AFTER_ACTOR
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
  process.stderr.write(`b4-after ${SERVER_VERSION}: ${ctx.repoDir}${anchor}${actor ? ` (actor ${actor})` : ''}\n`)
}

const argv = process.argv.slice(2)
if (argv.includes('-h') || argv.includes('--help')) { process.stdout.write(USAGE); process.exit(0) }
if (argv.includes('-v') || argv.includes('--version')) { process.stdout.write(`${SERVER_VERSION}\n`); process.exit(0) }
if (argv[0] === 'skill') await installSkill(argv.slice(1))
else await serve(argv)

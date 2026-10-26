// like-b4-mcp [repoDir] [--actor <name>]   (stdio transport)
// Env: LIKE_B4_REPO, LIKE_B4_ACTOR.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { resolve } from 'node:path'
import { RepoContext } from './context.js'
import { createServer } from './server.js'

const args = process.argv.slice(2)
let repoDir = process.env.LIKE_B4_REPO ?? process.cwd()
let actor = process.env.LIKE_B4_ACTOR
for (let i = 0; i < args.length; i++) {
  const a = args[i]!
  if (a === '--actor') actor = args[++i]
  else if (a === '-h' || a === '--help') {
    process.stderr.write('usage: like-b4-mcp [repoDir] [--actor <name>]\n  repoDir: model-data repository (default: LIKE_B4_REPO or cwd)\n  --actor: default actor for writes (LIKE_B4_ACTOR)\n')
    process.exit(0)
  } else if (!a.startsWith('-')) repoDir = a
}

const ctx = new RepoContext(resolve(repoDir), { actor })
const server = createServer(ctx)
const transport = new StdioServerTransport()
await server.connect(transport)
process.stderr.write(`like-b4 mcp: ${ctx.repoDir}${actor ? ` (actor ${actor})` : ''}\n`)

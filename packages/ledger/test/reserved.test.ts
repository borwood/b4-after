// LikeC4 cannot quote element names, so a grammar keyword used as a name makes the regenerated model
// unparseable. The reserved list must track what the pinned grammar actually refuses (issue #1).
import { describe, expect, it } from 'vitest'
import { LIKEC4_RESERVED_WORDS, isLikeC4ReservedWord } from '../src/reserved.js'
import { loadWorkspaceFiles, MODEL_FILE } from '../src/workspace.js'

const parses = async (name: string): Promise<boolean> => {
  const dsl = `specification { element system }\nmodel {\n  ${name} = system 'X'\n  parent = system 'P' {\n    ${name} = system 'Y'\n  }\n}\n`
  const loaded = await loadWorkspaceFiles({ [MODEL_FILE]: dsl })
  return loaded.errors.length === 0
}

describe('LikeC4 reserved words', () => {
  it('lists words the LikeC4 grammar refuses as element names', async () => {
    for (const w of ['head', 'tail', 'title', 'kind', 'metadata', 'view']) {
      expect(isLikeC4ReservedWord(w), w).toBe(true)
      expect(await parses(w), `${w} should not parse`).toBe(false)
    }
  })

  it('does not list keywords the grammar accepts as names', async () => {
    for (const w of ['model', 'element', 'person', 'component', 'source', 'target', 'api']) {
      expect(isLikeC4ReservedWord(w), w).toBe(false)
      expect(await parses(w), `${w} should parse`).toBe(true)
    }
    expect(LIKEC4_RESERVED_WORDS.size).toBeGreaterThan(50)
  })
})

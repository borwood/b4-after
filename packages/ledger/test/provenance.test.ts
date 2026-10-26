import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { commitMessageFor, provenanceOf, recordChangeSet } from '../src/provenance.js'
import { Ledger } from '../src/ledger.js'
import { ChangeSet } from '../src/schema.js'
import { makeRepo, type Fixture } from './fixture.js'

let fx: Fixture
beforeAll(async () => { fx = await makeRepo() })
afterAll(async () => { await fx.cleanup() })

const cs = ChangeSet.parse({
  id: 'CHG-044',
  title: 'Split charges handler',
  intent: 'Separate authorisation from capture\nso retries only touch capture',
  sources: [{ ref: 'https://example.test/issues/260', role: 'issue' }, { ref: 'REQ-260', role: 'requirement' }],
  depends_on: ['CHG-042'],
  disposition: 'proposed',
  operations: [{ op: 'update_element', id: 'ent-charges', set: { title: 'Capture Handler' } }],
})

describe('provenance', () => {
  it('generates a readable subject and machine-readable trailers (PRD 9)', () => {
    const msg = commitMessageFor(cs, { actor: 'implementation-agent' })
    expect(msg.split('\n')[0]).toBe('propose CHG-044: Split charges handler')
    expect(msg).toContain('\nChange-Id: CHG-044\n')
    expect(msg).toContain('\nOrigin: REQ-260\n') // requirement preferred over issue
    expect(msg).toContain('\nActor: implementation-agent\n')
    expect(msg).toContain('\nIntent: Separate authorisation from capture so retries only touch capture\n')
    expect(msg).toContain('\nDisposition: proposed\n')
    expect(provenanceOf(msg)).toEqual({
      changeId: 'CHG-044', origin: 'REQ-260', actor: 'implementation-agent',
      intent: 'Separate authorisation from capture so retries only touch capture',
      disposition: 'proposed', implementation: 'not_started',
    })
  })

  it('records a change set as a commit the ledger then sees as recorded', async () => {
    const head = await fx.git.headSha()
    const res = await recordChangeSet(fx.dir, cs, { actor: 'test-agent', expectedHead: head!, date: '2026-04-01T09:00:00+00:00' })
    expect(res.path).toBe('changes/CHG-044.yaml')
    const [commit] = await fx.git.log({ rev: res.sha, paths: ['changes/CHG-044.yaml'] })
    expect(commit!.sha).toBe(res.sha)
    expect(provenanceOf(commit!.body).changeId).toBe('CHG-044')
    expect(commit!.files).toEqual(['changes/CHG-044.yaml'])

    const ledger = await Ledger.load(fx.dir)
    const rec = ledger.get('CHG-044')!
    expect(rec.unrecorded).toBe(false)
    expect(rec.firstRecordedAt).toBe('2026-04-01T09:00:00.000Z')
    expect(ledger.all().map(r => r.changeSet.id)).toEqual(['CHG-037', 'CHG-042', 'CHG-043', 'CHG-044'])
  })

  it('refuses to write on a stale view of the repository', async () => {
    await expect(recordChangeSet(fx.dir, cs, { actor: 'x', expectedHead: fx.shas.stage1 })).rejects.toThrow(/repository moved/)
  })
})

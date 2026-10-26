import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { assertPathWithin, resolveRunPath, validateRunId } from '../src/safe-paths.js'

test('run identifiers reject traversal and shell metacharacters while allowing existing Chinese names', () => {
  assert.equal(validateRunId('loopskill_searchqa_攒金币_20261026_120000'), 'loopskill_searchqa_攒金币_20261026_120000')
  for (const value of ['', '..', '../other', 'a/b', 'a\\b', '$(anything)', 'id;command', 'x\u0000y', 'a'.repeat(256)]) {
    assert.throws(() => validateRunId(value))
  }
})

test('existing and future paths stay within their authorized root', async () => {
  const base = await mkdtemp(join(tmpdir(), 'skillopt-paths-'))
  try {
    const root = join(base, 'outputs')
    await mkdir(join(root, 'run_1'), { recursive: true })
    await writeFile(join(root, 'run_1', 'file.txt'), 'fixture')
    const run = await resolveRunPath(root, 'run_1')
    assert.equal(await assertPathWithin(run, join(run, 'file.txt')), join(run, 'file.txt'))
    assert.equal(await assertPathWithin(run, join(run, 'new', 'file.txt'), { allowMissing: true }), join(run, 'new', 'file.txt'))
    await assert.rejects(assertPathWithin(run, resolve(run, '..', 'other')))
    await assert.rejects(assertPathWithin(run, `${run}_other/file.txt`, { allowMissing: true }))
    await assert.rejects(resolveRunPath(root, 'missing'))
    assert.equal(await resolveRunPath(root, 'missing', true), join(resolve(run, '..'), 'missing'))
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('symlink escapes and run aliases cannot cross task boundaries', async () => {
  const base = await mkdtemp(join(tmpdir(), 'skillopt-links-'))
  try {
    const root = join(base, 'outputs')
    const outside = join(base, 'outside')
    await mkdir(join(root, 'run_a'), { recursive: true })
    await mkdir(join(root, 'run_b'))
    await mkdir(outside)
    await symlink(outside, join(root, 'run_a', 'escape'))
    await symlink(join(base, 'missing'), join(root, 'run_a', 'dangling'))
    await symlink(join(root, 'run_b'), join(root, 'alias'))
    await assert.rejects(assertPathWithin(join(root, 'run_a'), join(root, 'run_a', 'escape', 'new.txt'), { allowMissing: true }))
    await assert.rejects(assertPathWithin(join(root, 'run_a'), join(root, 'run_a', 'dangling', 'new.txt'), { allowMissing: true }))
    await assert.rejects(resolveRunPath(root, 'alias'))
  } finally { await rm(base, { recursive: true, force: true }) }
})

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ChildProcess } from 'node:child_process'
import type { RunState } from '../../shared/run-state'
import { RunConflict, RunLifecycle } from '../src/run-lifecycle.js'

class FakeProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  kills = 0
  kill() { this.kills++; return true }
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

async function setup(sync: () => Promise<void> = async () => {}) {
  const dir = await mkdtemp(join(tmpdir(), 'skillopt-lifecycle-'))
  const events: RunState[] = []
  const stored: RunState[] = []
  const lifecycle = new RunLifecycle({
    persist: async (_, state) => { stored.push(structuredClone(state)); return true },
    publish: (_, state) => { events.push(structuredClone(state)) },
    log: () => {}, completed: sync,
  })
  const state = await lifecycle.prepare('run', null)
  const child = new FakeProcess()
  lifecycle.attach('run', state.instanceId, child as unknown as ChildProcess, dir)
  const emit = (phase: string, sequence: number, status = 'running', extra = {}) => {
    const snapshot = {
      instance_id: state.instanceId, sequence, status, phase,
      current_step: 2, last_completed_step: 2, total_steps: 2,
      current_score: 0.5, best_score: 0.5, updated_at: new Date().toISOString(),
      recipe_hash: 'fingerprint', ...extra,
    }
    const line = `SKILLOPT_STATE ${JSON.stringify(snapshot)}\n`
    child.stdout.write(line.slice(0, 13))
    child.stdout.write(line.slice(13))
  }
  const finishSummary = () => writeFile(join(dir, 'summary.json'), JSON.stringify({
    status: 'completed', runtime_instance_id: state.instanceId, recipe_hash: 'fingerprint',
  }))
  return { lifecycle, state, child, events, stored, dir, emit, finishSummary }
}

test('final evaluation remains training; final status persists before broadcast and slow archive', async () => {
  let resolveSync!: () => void
  const sync = new Promise<void>(resolve => { resolveSync = resolve })
  const ctx = await setup(() => sync)
  try {
    ctx.emit('baseline_test', 1)
    ctx.emit('best_test', 2)
    await tick()
    assert.equal(ctx.lifecycle.get('run')?.phase, 'best_test')
    assert.equal(ctx.lifecycle.get('run')?.status, 'training')
    await ctx.finishSummary()
    ctx.emit('completed', 3, 'completed')
    ctx.child.emit('close', 0, null)
    for (let i = 0; i < 20 && ctx.lifecycle.get('run')?.status !== 'completed'; i++) await tick()
    assert.equal(ctx.lifecycle.get('run')?.status, 'completed')
    assert.equal(ctx.lifecycle.get('run')?.artifactSync, 'syncing')
    assert.equal(ctx.stored.at(-1)?.status, 'completed')
    resolveSync()
    await ctx.lifecycle.waitForClose('run')
    assert.equal(ctx.events.at(-1)?.artifactSync, 'synced')
    assert.ok(await readFile(join(ctx.dir, 'summary.json'), 'utf8'))
  } finally { resolveSync(); await rm(ctx.dir, { recursive: true, force: true }) }
})

test('old sequence and wrong instance cannot complete a run', async () => {
  const ctx = await setup()
  try {
    ctx.emit('best_test', 2)
    ctx.emit('rollout', 1)
    await tick()
    assert.equal(ctx.lifecycle.get('run')?.phase, 'best_test')
    await ctx.finishSummary()
    ctx.emit('completed', 3, 'completed', { instance_id: 'old-instance' })
    ctx.child.emit('close', 0, null)
    await ctx.lifecycle.waitForClose('run')
    assert.equal(ctx.lifecycle.get('run')?.status, 'failed')
  } finally { await rm(ctx.dir, { recursive: true, force: true }) }
})

test('old summary and signal exits cannot be reported as successful', async () => {
  for (const signal of [null, 'SIGTERM']) {
    const ctx = await setup()
    try {
      await writeFile(join(ctx.dir, 'summary.json'), JSON.stringify({ status: 'completed', runtime_instance_id: 'old', recipe_hash: 'fingerprint' }))
      ctx.emit('completed', 1, 'completed')
      ctx.child.emit('close', signal ? null : 0, signal)
      await ctx.lifecycle.waitForClose('run')
      assert.equal(ctx.lifecycle.get('run')?.status, 'failed')
    } finally { await rm(ctx.dir, { recursive: true, force: true }) }
  }
})

test('unknown process fails closed and stopping waits for actual close', async () => {
  const ctx = await setup()
  try {
    await assert.rejects(ctx.lifecycle.stop('missing'), RunConflict)
    const stopping = ctx.lifecycle.stop('run', 1000)
    assert.equal(ctx.child.kills, 1)
    assert.equal(ctx.lifecycle.get('run')?.status, 'training')
    ctx.child.emit('close', null, 'SIGTERM')
    await stopping
    assert.equal(ctx.lifecycle.get('run')?.status, 'stopped')
    const next = await ctx.lifecycle.prepare('run', ctx.lifecycle.get('run'))
    assert.equal(next.attempt, 2)
    assert.notEqual(next.instanceId, ctx.state.instanceId)
  } finally { await rm(ctx.dir, { recursive: true, force: true }) }
})

test('archive failure preserves completed status and reports failed synchronization', async () => {
  const ctx = await setup(async () => { throw new Error('database unavailable') })
  try {
    await ctx.finishSummary()
    ctx.emit('completed', 1, 'completed')
    ctx.child.emit('close', 0, null)
    await ctx.lifecycle.waitForClose('run')
    assert.equal(ctx.lifecycle.get('run')?.status, 'completed')
    assert.equal(ctx.lifecycle.get('run')?.artifactSync, 'failed')
    assert.match(ctx.lifecycle.get('run')?.artifactError ?? '', /database unavailable/)
    assert.ok(await readFile(join(ctx.dir, 'summary.json'), 'utf8'))
  } finally { await rm(ctx.dir, { recursive: true, force: true }) }
})

test('same-run concurrent operations conflict', async () => {
  const ctx = await setup()
  let release!: () => void
  try {
    const first = ctx.lifecycle.exclusive('run', () => new Promise<void>(resolve => { release = resolve }))
    await assert.rejects(ctx.lifecycle.exclusive('run', async () => {}), RunConflict)
    release()
    await first
  } finally { ctx.child.emit('close', 1, null); await ctx.lifecycle.waitForClose('run'); await rm(ctx.dir, { recursive: true, force: true }) }
})

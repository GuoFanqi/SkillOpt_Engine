import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RunState } from '../shared/run-state'
import type { TrainingRun } from '../src/types'
import { applyRunState, chooseRunState, isRunState, mergeTrainingRun, mergeTrainingRuns, needsRunRefresh, runStateLabel } from '../src/lib/runState'

function state(overrides: Partial<RunState> = {}): RunState {
  return {
    instanceId: 'run-1', attempt: 1, version: 1, status: 'training', phase: 'rollout',
    currentStep: 1, completedSteps: 0, totalSteps: 4, currentScore: 0.2, bestScore: 0.2,
    updatedAt: '2026-10-26T00:00:00.000Z', artifactSync: 'pending', ...overrides,
  }
}

function run(id = 'first'): TrainingRun {
  return {
    id, name: id, path: '', status: 'training', currentScore: 20, bestScore: 20,
    initialScore: 20, baselineTestScore: 0, testScore: 0, acceptRate: 0, totalSteps: 0,
    accepts: 0, slowUpdates: 0, rejects: 0, skips: 0, model: 'test', epochs: 1,
    batchSize: 1, editBudget: 1, lrScheduler: 'constant', gateMetric: 'soft', slowUpdate: false,
    totalTime: '', avgPerStep: '', createdAt: '', updatedAt: '',
  }
}

test('older REST state cannot overwrite a newer completion', () => {
  const complete = state({ version: 5, status: 'completed', phase: 'completed', completedSteps: 4 })
  const current = applyRunState(run(), complete)
  const merged = mergeTrainingRun(current, { ...run(), state: state({ version: 2 }) })
  assert.equal(merged.status, 'completed')
  assert.equal(merged.totalSteps, 4)
  assert.equal(merged.state, complete)
})

test('legacy response without state cannot discard terminal state', () => {
  const current = applyRunState(run(), state({ status: 'completed', phase: 'completed' }))
  assert.equal(mergeTrainingRun(current, run()).status, 'completed')
})

test('same-instance terminal status cannot revert even with a higher version', () => {
  const complete = state({ version: 4, status: 'completed', phase: 'completed' })
  assert.equal(chooseRunState(complete, state({ version: 9 })), complete)
})

test('new attempt wins and delayed previous-instance updates are rejected', () => {
  const old = state({ version: 100, status: 'completed', phase: 'completed' })
  const next = state({ attempt: 2, instanceId: 'run-2', version: 0 })
  assert.equal(chooseRunState(old, next), next)
  assert.equal(chooseRunState(next, old), next)
  assert.equal(chooseRunState(next, state({ attempt: 2, instanceId: 'unexpected', version: 999 })), next)
})

test('artifact synchronization can advance after terminal state without restarting training', () => {
  const complete = state({ version: 4, status: 'completed', phase: 'completed' })
  const synced = state({ version: 5, status: 'completed', phase: 'completed', artifactSync: 'synced' })
  assert.equal(chooseRunState(complete, synced), synced)
  const failed = { ...synced, version: 6, artifactSync: 'failed' as const, artifactError: 'synthetic DB failure' }
  assert.equal(chooseRunState(synced, failed).status, 'completed')
  assert.match(runStateLabel(failed), /原件保留/)
})

test('all task states survive a batched update without leaking between tasks', () => {
  const first = state({ status: 'completed', phase: 'completed', completedSteps: 4 })
  const second = state({ instanceId: 'other', phase: 'baseline_test', completedSteps: 2 })
  const merged = mergeTrainingRuns([], [run('first'), run('second')], { first, second })
  assert.equal(merged[0].status, 'completed')
  assert.equal(merged[0].totalSteps, 4)
  assert.equal(merged[1].status, 'training')
  assert.equal(merged[1].state?.phase, 'baseline_test')
  assert.equal(merged[1].totalSteps, 2)
})

test('zero score is preserved and normalized once', () => {
  const measured = applyRunState(run(), state({ currentScore: 0, bestScore: 0.75 }))
  assert.equal(measured.currentScore, 0)
  assert.equal(measured.bestScore, 75)
  assert.equal(measured.state?.currentScore, 0)
})

test('measurement absence is retained in state instead of reusing the old measurement', () => {
  const measured = applyRunState(run(), state({ currentScore: null }))
  assert.equal(measured.state?.currentScore, null)
  assert.equal(measured.currentScore, 0)
})

test('state validation rejects malformed or negative versions', () => {
  assert.equal(isRunState(state()), true)
  assert.equal(isRunState(null), false)
  assert.equal(isRunState(state({ version: -1 })), false)
  assert.equal(isRunState({ ...state(), currentScore: '0.5' }), false)
  assert.equal(isRunState({ ...state(), phase: 'made-up' }), false)
})

test('final evaluation remains running and has a distinct label', () => {
  const testing = state({ phase: 'best_test', completedSteps: 4 })
  assert.match(runStateLabel(testing), /最佳技能测试中/)
  assert.equal(needsRunRefresh(applyRunState(run(), testing)), true)
})

test('completed syncing tasks continue refreshing, synced tasks stop polling', () => {
  const complete = state({ status: 'completed', phase: 'completed', artifactSync: 'syncing' })
  assert.equal(needsRunRefresh(applyRunState(run(), complete)), true)
  assert.equal(needsRunRefresh(applyRunState(run(), { ...complete, artifactSync: 'synced' })), false)
})

test('persistence error never claims a persisted completion', () => {
  const complete = state({ status: 'completed', phase: 'completed', persistenceError: 'offline' })
  assert.match(runStateLabel(complete), /状态尚未保存/)
  assert.equal(applyRunState(run(), complete).status, 'completed')
})

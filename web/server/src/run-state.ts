import type { RunPhase, RunState } from '../../shared/run-state'

export const STATE_PREFIX = 'SKILLOPT_STATE '
const phases = new Set<RunPhase>([
  'pending', 'baseline', 'rollout', 'reflect', 'aggregate', 'select', 'update',
  'validation', 'slow_update', 'meta_skill', 'final_validation', 'baseline_test',
  'best_test', 'final_test', 'finalizing', 'completed', 'failed', 'stopped',
])

export interface TrainerSnapshot {
  instance_id: string
  sequence: number
  status: 'running' | 'completed' | 'failed' | 'stopped'
  phase: RunPhase
  current_step: number
  last_completed_step: number
  total_steps: number
  current_score: number | null
  best_score: number | null
  updated_at: string
  recipe_hash: string
  error?: string
}

export function isTerminal(status: RunState['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'stopped'
}

export function readState(value: unknown): RunState | null {
  try {
    const state = typeof value === 'string' ? JSON.parse(value) : value
    if (!state || typeof state !== 'object' || typeof state.instanceId !== 'string') return null
    if (!Number.isSafeInteger(state.attempt) || !Number.isSafeInteger(state.version)) return null
    return state as RunState
  } catch {
    return null
  }
}

export function newRunState(instanceId: string, attempt: number): RunState {
  return {
    instanceId, attempt, version: 0, status: 'training', phase: 'pending',
    currentStep: 0, completedSteps: 0, totalSteps: 0,
    currentScore: null, bestScore: null, updatedAt: new Date().toISOString(),
    artifactSync: 'pending',
  }
}

export function parseTrainerSnapshot(text: string, instanceId: string): TrainerSnapshot {
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object') throw new Error('Invalid training state')
  const row = value as Record<string, unknown>
  if (row.instance_id !== instanceId) throw new Error('State belongs to another training instance')
  for (const key of ['sequence', 'current_step', 'last_completed_step', 'total_steps']) {
    if (!Number.isSafeInteger(row[key]) || Number(row[key]) < 0) throw new Error(`Invalid ${key}`)
  }
  if (Number(row.last_completed_step) > Number(row.total_steps) || Number(row.current_step) > Number(row.total_steps)) {
    throw new Error('Step exceeds total steps')
  }
  if (!phases.has(row.phase as RunPhase) || !['running', 'completed', 'failed', 'stopped'].includes(String(row.status))) {
    throw new Error('Unknown training phase or status')
  }
  for (const key of ['current_score', 'best_score']) {
    const score = row[key]
    if (score !== null && (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1)) {
      throw new Error(`Invalid ${key}`)
    }
  }
  if (typeof row.updated_at !== 'string' || !Number.isFinite(Date.parse(row.updated_at))) throw new Error('Invalid state timestamp')
  if (typeof row.recipe_hash !== 'string' || !row.recipe_hash) throw new Error('Missing recipe fingerprint')
  if (row.error !== undefined && typeof row.error !== 'string') throw new Error('Invalid state error')
  return row as unknown as TrainerSnapshot
}

export function mergeTrainerSnapshot(state: RunState, snapshot: TrainerSnapshot): RunState {
  if (snapshot.instance_id !== state.instanceId || isTerminal(state.status)) return state
  if (snapshot.last_completed_step < state.completedSteps) throw new Error('Completed steps moved backwards')
  return {
    ...state, version: state.version + 1,
    phase: snapshot.phase === 'completed' ? 'finalizing' : snapshot.phase,
    currentStep: snapshot.current_step, completedSteps: snapshot.last_completed_step,
    totalSteps: snapshot.total_steps, currentScore: snapshot.current_score,
    bestScore: snapshot.best_score, updatedAt: snapshot.updated_at,
    ...(snapshot.error ? { error: snapshot.error } : {}),
  }
}

export type RunStatus = 'pending' | 'training' | 'completed' | 'failed' | 'stopped' | 'empty'

export type RunPhase =
  | 'pending' | 'baseline' | 'rollout' | 'reflect' | 'aggregate' | 'select'
  | 'update' | 'validation' | 'slow_update' | 'meta_skill' | 'final_validation'
  | 'baseline_test' | 'best_test' | 'final_test' | 'finalizing'
  | 'completed' | 'failed' | 'stopped'

export type ArtifactSyncStatus = 'pending' | 'syncing' | 'synced' | 'failed'

export interface RunState {
  instanceId: string
  attempt: number
  version: number
  status: RunStatus
  phase: RunPhase
  currentStep: number
  completedSteps: number
  totalSteps: number
  currentScore: number | null
  bestScore: number | null
  updatedAt: string
  artifactSync: ArtifactSyncStatus
  error?: string
  artifactError?: string
  persistenceError?: string
  timing?: Record<string, number>
}

export type RunSocketMessage =
  | { type: 'authenticated' }
  | { type: 'state'; runId: string; data: RunState }
  | { type: 'log' | 'error'; runId: string; data: string }
  | { type: 'timing'; runId: string; data: Record<string, number> }

import type { RunState } from '../../shared/run-state'
export type { RunState, RunPhase, RunStatus } from '../../shared/run-state'

export interface TrainingRun {
  state?: RunState
  id: string
  name: string
  path: string
  status: 'completed' | 'training' | 'failed' | 'pending' | 'empty' | 'stopped'
  errorMessage?: string
  currentScore: number
  bestScore: number
  initialScore: number
  baselineTestScore: number
  testScore: number
  acceptRate: number
  totalSteps: number
  accepts: number
  slowUpdates: number
  rejects: number
  skips: number
  model: string
  epochs: number
  batchSize: number
  editBudget: number
  lrScheduler: string
  gateMetric: string
  slowUpdate: boolean
  aiSummary?: string
  totalTime: string
  avgPerStep: string
  createdAt: string
  updatedAt: string
}

export interface StepHistory {
  step: number
  action: 'accept' | 'reject' | 'skip'
  rawAction: string
  score: number
  epoch: number
  step_in_epoch: number
  rollout_hard: number
  rollout_soft: number
  n_patches: number
  n_success_patches: number
  n_failure_patches: number
  current_score: number
  best_score: number
  skill_len: number
  wall_time_s: number
  timing: { rollout_s: number; reflect_s: number }
  edits?: number
  support?: number[]
  candidateSkill?: string
  timestamp: string
  // 拒绝相关字段
  candidate_gate_score?: number
  selection_hard?: number
  selection_soft?: number
  gate_metric?: string
  current_origin?: string
  best_origin?: string
  best_step?: number
  isSlowUpdate?: boolean
}

export interface TrainingData {
  train: QADataItem[]
  val: QADataItem[]
  test: QADataItem[]
}

export interface QADataItem {
  id: string
  question: string
  context: string
  answers: string[]
}

export interface SkillVersion {
  version: string
  path: string
  chars: number
  score: number
  timestamp: string
}

export interface ChartDataPoint {
  step: number
  selection: number
  rollout: number
  bestScore: number
  action: 'accept' | 'reject' | 'skip'
  nPatches: number
  nSuccessPatches: number
}

export interface EvaluationResult {
  id: string
  question: string
  prediction: string
  gold: string
  correct: boolean
  time: number
}

export interface TrainingConfig {
  env: {
    name: string
    splitDir: string
    skillInit: string
  }
  model: {
    backend: string
    optimizer: string
    target: string
  }
  train: {
    numEpochs: number
    batchSize: number
    editBudget: number
    lrScheduler: string
    minEditBudget: number
  }
}

// ─── Step Detail ───
export interface RolloutResult {
  id: string
  question: string
  em: number
  f1: number
  hard: number
  soft: number
  predicted_answer: string
  gold_answers: string[]
  response: string
  fail_reason: string
  agent_ok: boolean
  n_turns?: number
}

export interface MergedPatch {
  reasoning?: string
  edits?: Array<{ op: string; path: string; content?: string; old_string?: string; new_string?: string }>
}

// ─── Playground / Chat ───
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  thinking?: string
}

export interface ChatRequest {
  model: string
  skill: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
}


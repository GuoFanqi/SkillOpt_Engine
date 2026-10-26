import type { RunPhase, RunState } from '../../shared/run-state'
import type { TrainingRun } from '../types'

const terminalStatuses = new Set(['completed', 'failed', 'stopped', 'empty'])
const phases = new Set<RunPhase>([
  'pending', 'baseline', 'rollout', 'reflect', 'aggregate', 'select', 'update',
  'validation', 'slow_update', 'meta_skill', 'final_validation', 'baseline_test',
  'best_test', 'final_test', 'finalizing', 'completed', 'failed', 'stopped',
])

export function isRunState(value: unknown): value is RunState {
  if (!value || typeof value !== 'object') return false
  const state = value as Record<string, unknown>
  return typeof state.instanceId === 'string' && state.instanceId.length > 0
    && ['attempt', 'version', 'currentStep', 'completedSteps', 'totalSteps'].every(
      key => Number.isSafeInteger(state[key]) && Number(state[key]) >= 0,
    )
    && ['pending', 'training', 'completed', 'failed', 'stopped', 'empty'].includes(String(state.status))
    && phases.has(state.phase as RunPhase)
    && ['pending', 'syncing', 'synced', 'failed'].includes(String(state.artifactSync))
    && typeof state.updatedAt === 'string'
    && ['currentScore', 'bestScore'].every(key => state[key] === null
      || (typeof state[key] === 'number' && Number.isFinite(state[key])))
}

export function chooseRunState(current: RunState | undefined, incoming: RunState): RunState {
  if (!current) return incoming
  if (incoming.attempt !== current.attempt) return incoming.attempt > current.attempt ? incoming : current
  if (incoming.instanceId !== current.instanceId || incoming.version <= current.version) return current
  if (terminalStatuses.has(current.status) && incoming.status !== current.status) return current
  return incoming
}

export function applyRunState(run: TrainingRun, state: RunState | undefined): TrainingRun {
  if (!state) return run
  const accepted = chooseRunState(run.state, state)
  return {
    ...run,
    state: accepted,
    status: accepted.status,
    totalSteps: accepted.completedSteps,
    currentScore: accepted.currentScore === null ? 0 : Math.round(accepted.currentScore * 100),
    bestScore: accepted.bestScore === null ? 0 : Math.round(accepted.bestScore * 100),
    updatedAt: accepted.updatedAt,
    errorMessage: accepted.error,
  }
}

export function mergeTrainingRun(current: TrainingRun | null, incoming: TrainingRun): TrainingRun {
  if (!current || current.id !== incoming.id) return applyRunState(incoming, incoming.state)
  const state = incoming.state ? chooseRunState(current.state, incoming.state) : current.state
  return applyRunState({ ...current, ...incoming }, state)
}

export function mergeTrainingRuns(current: TrainingRun[], incoming: TrainingRun[], states: Record<string, RunState>): TrainingRun[] {
  const previous = new Map(current.map(run => [run.id, run]))
  return incoming.map(run => applyRunState(mergeTrainingRun(previous.get(run.id) ?? null, run), states[run.id]))
}

const phaseLabels: Record<RunPhase, string> = {
  pending: '等待启动', baseline: '基线评测中', rollout: '执行训练样本', reflect: '分析训练结果',
  aggregate: '合并修改建议', select: '筛选修改建议', update: '更新技能', validation: '验证候选技能',
  slow_update: '慢更新中', meta_skill: '元技能整理中', final_validation: '最终验证中',
  baseline_test: '初始技能测试中', best_test: '最佳技能测试中', final_test: '最终技能测试中',
  finalizing: '写入最终结果', completed: '训练与评测已完成', failed: '训练失败', stopped: '已停止',
}

export function runStateLabel(state: RunState): string {
  if (state.persistenceError) return `${phaseLabels[state.phase]}，状态尚未保存`
  if (state.status === 'completed') {
    if (state.artifactSync === 'failed') return '计算已完成，详情同步失败，原件保留'
    if (state.artifactSync !== 'synced') return '训练与评测已完成，详情整理中'
    return '训练与评测已完成'
  }
  return phaseLabels[state.phase]
}

export function needsRunRefresh(run: TrainingRun): boolean {
  return run.status === 'training' || run.status === 'pending' || !!run.state?.persistenceError
    || (!!run.state && terminalStatuses.has(run.state.status) && ['pending', 'syncing'].includes(run.state.artifactSync))
}

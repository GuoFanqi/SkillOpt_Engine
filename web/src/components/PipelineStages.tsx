import { useMemo, useState, useEffect } from 'react'
import {
  Play, BrainCircuit, GitMerge, CheckCircle2, PenLine, ShieldCheck,
  ChevronDown, Target, Layers, Clock, TrendingUp, FileEdit, Filter,
  BarChart3, AlertTriangle, XCircle, ArrowRight, Zap,
  Eye, Lightbulb, Scale, Ban, ThumbsUp, ThumbsDown, ListChecks,
  BookOpen, Wrench, Sparkles, HelpCircle,
} from 'lucide-react'
import { StepHistory } from '../types'
import {
  LineChart, Line, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Legend, ReferenceLine, ComposedChart,
} from 'recharts'
import { useWebSocket } from '../hooks/useWebSocket'

interface PipelineStagesProps {
  runId: string
  status: string
  totalSteps: number
  isActive: boolean
  history: StepHistory[]
}

const PIPELINE_STAGES = [
  { key: 'baseline', label: 'Baseline', Icon: BarChart3, desc: '基线评估：用初始 Skill 在验证集上打分，建立基准线' },
  { key: 'rollout', label: 'Rollout', Icon: Play, desc: '用当前 Skill 逐条跑训练集 QA，找出答错的题目' },
  { key: 'reflect', label: 'Reflect', Icon: BrainCircuit, desc: '分析每道错题的原因，针对性生成修改建议 (Patch)' },
  { key: 'aggregate', label: 'Aggregate', Icon: GitMerge, desc: '合并多条建议，去重并解决规则冲突' },
  { key: 'select', label: 'Select', Icon: CheckCircle2, desc: '将修改后的 Skill 放到验证集上评估，筛选有效修改' },
  { key: 'update', label: 'Update', Icon: PenLine, desc: '根据 Gate 判断标准决定接受或回滚修改' },
  { key: 'gate', label: 'Gate', Icon: ShieldCheck, desc: '质量门控：候选分数 > 当前分数 → 接受，否则拒绝' },
]

export default function PipelineStages({ runId: _runId, status, totalSteps: _totalSteps, isActive, history }: PipelineStagesProps) {
  const [expandedSubStage, setExpandedSubStage] = useState<string | null>(null)
  const { messages } = useWebSocket()
  const [latestTiming, setLatestTiming] = useState<Record<string, number>>({})
  const [showTiming, setShowTiming] = useState(false)

  // Listen for timing WebSocket messages
  useEffect(() => {
    const lastMsg = messages[messages.length - 1]
    if (lastMsg?.type === 'timing' && lastMsg.data && typeof lastMsg.data === 'object') {
      setLatestTiming(lastMsg.data as Record<string, number>)
    }
  }, [messages])

  const currentStage = useMemo(() => {
    if (status === 'completed') return 'gate'
    if (status === 'failed' || !isActive) return null
    if (history.length > 0) {
      const latest = history[history.length - 1]
      // Each step goes: rollout → reflect → aggregate → select → update(+gate)
      // update & gate are atomic (happen together in one decision), so show them as one unit
      if (latest.rollout_hard != null && latest.n_patches == null) return 'rollout'
      if (latest.n_patches != null && latest.selection_hard == null) return 'reflect'
      if (latest.selection_hard != null && latest.action === undefined) return 'select'
      // When action is set (accept/reject/skip), but training is still active,
      // it means we're starting a new epoch, so show rollout instead of gate
      if (latest.action != null) {
        return isActive ? 'rollout' : 'gate'
      }
      return 'gate'
    }
    return 'baseline'
  }, [status, isActive, history])

  const currentSubIdx = currentStage ? PIPELINE_STAGES.findIndex((s) => s.key === currentStage) : -1
  const isBaseline = currentStage === 'baseline'

  const sortedHistory = useMemo(() =>
    [...history].sort((a, b) => a.epoch !== b.epoch ? a.epoch - b.epoch : a.step - b.step),
    [history])

  // 初始分数：用 first step 的 rollout_hard（编辑前对原始 Skill 的验证集评分）
  // 注意：best_score / current_score 是编辑后候选分数，不能当初始分
  const getStepScore = (h: StepHistory): number => {
    if (h.best_score != null && !isNaN(h.best_score)) return h.best_score
    if (h.current_score != null && !isNaN(h.current_score)) return h.current_score
    if (h.score != null && !isNaN(h.score) && h.score > 0) return h.score
    return NaN
  }

  // 真实基线：第一步的 rollout（编辑前原始 Skill 在验证集上的准确率）
  const trueBaseline = sortedHistory.length > 0
    ? sortedHistory[0].rollout_hard ?? sortedHistory[0].rollout_soft
    : NaN

  const initialScore = (!isNaN(trueBaseline) && trueBaseline > 0) ? trueBaseline : (
    sortedHistory.length > 0 ? getStepScore(sortedHistory[0]) : NaN
  )
  const currentEpoch = history.length > 0 ? Math.max(...history.map(h => h.epoch)) : 0

  // 最佳分数（安全处理，防止 Math.max(-Infinity)）
  const validScores = useMemo(() =>
    history.map(getStepScore).filter(s => !isNaN(s) && s > 0),
  [history])

  const subStats = useMemo(() => {
    const latest = history[history.length - 1]
    return {
      baseline: {
        score: !isNaN(initialScore) && initialScore > 0 ? `${(initialScore * 100).toFixed(1)}%` : '--',
        status: (sortedHistory.length > 0 || status === 'completed') ? 'done' : isBaseline ? 'active' : 'pending',
        stepCount: sortedHistory.length,
      },
      rollout: {
        hard: latest?.rollout_hard != null ? `${(latest.rollout_hard * 100).toFixed(0)}%` : '--',
        soft: latest?.rollout_soft != null ? `${(latest.rollout_soft * 100).toFixed(0)}%` : '--',
        wrongCount: latest?.rollout_hard != null ? `${Math.round((1 - latest.rollout_hard) * 100) || 0} 题` : '--',
        time: latest?.timing?.rollout_s ? `${latest.timing.rollout_s.toFixed(1)}s` : '--',
      },
      reflect: {
        patches: latest?.n_patches ?? '--',
        success: latest?.n_success_patches ?? '--',
        failure: latest?.n_failure_patches ?? '--',
        time: latest?.timing?.reflect_s ? `${latest.timing.reflect_s.toFixed(1)}s` : '--',
      },
      aggregate: {
        success: latest?.n_success_patches ?? '--',
        total: latest?.n_patches ?? '--',
        dedupRate: latest?.n_patches && latest.n_success_patches ? `${((latest.n_patches - latest.n_success_patches) / Math.max(latest.n_patches, 1) * 100).toFixed(0)}%` : '--',
      },
      select: {
        hard: latest?.selection_hard != null ? `${(latest.selection_hard * 100).toFixed(0)}%` : '--',
        soft: latest?.selection_soft != null ? `${(latest.selection_soft * 100).toFixed(0)}%` : '--',
        improved: latest?.selection_hard != null && latest?.rollout_hard != null
          ? ((latest.selection_hard - latest.rollout_hard) > 0 ? `+${((latest.selection_hard - latest.rollout_hard) * 100).toFixed(0)}%` : `${((latest.selection_hard - latest.rollout_hard) * 100).toFixed(0)}%`) : '--',
      },
      update: {
        action: latest?.action ?? '--',
        scoreBefore: latest?.current_score != null ? `${(latest.current_score * 100).toFixed(1)}%` : '--',
        scoreAfter: latest?.score > 0 ? `${(latest.score * 100).toFixed(1)}%` : '--',
        skillLen: latest?.skill_len ?? '--',
      },
      gate: {
        accepts: history.filter(h => h.action === 'accept').length,
        rejects: history.filter(h => h.action === 'reject').length,
        skips: history.filter(h => h.action === 'skip').length,
        candidateScore: latest?.candidate_gate_score != null ? `${(latest.candidate_gate_score * 100).toFixed(1)}%` : '--',
        currentScore: latest?.current_score != null ? `${(latest.current_score * 100).toFixed(1)}%` : '--',
        gateMetric: latest?.gate_metric ?? '--',
      },
    }
  }, [history, initialScore, isBaseline, sortedHistory.length, status])

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-6 mb-6 space-y-0">
      <div className="flex items-center justify-between mb-5">
        <h3 className="text-sm font-semibold text-gray-700">训练流水线</h3>
        <div className="flex items-center gap-3">
          {/* Timing toggle */}
          {(Object.keys(latestTiming).length > 0 || history.some(h => h.timing)) && (
            <button
              onClick={() => setShowTiming(!showTiming)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                showTiming ? 'bg-orange-100 text-orange-700' : 'bg-gray-100 text-gray-500 hover:text-gray-700'
              }`}
            >
              <Clock className="w-3 h-3" />
              耗时
            </button>
          )}
          {isActive && currentStage && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-indigo-50 text-indigo-600 rounded-full text-xs font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />
              {isBaseline ? '基线评估中' : currentEpoch > 0 ? `Epoch ${currentEpoch}` : '初始化中'}
            </span>
          )}
          {status === 'completed' && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-50 text-emerald-600 rounded-full text-xs font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> 已完成
            </span>
          )}
          {!isActive && status !== 'completed' && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-gray-50 text-gray-500 rounded-full text-xs font-medium">待开始</span>
          )}
        </div>
      </div>

      {/* ── Timing Visualization ── */}
      {showTiming && <StageTimingBar timing={latestTiming} history={history} />}

      {/* Static pipeline with Baseline + 6 stages */}
      <div className="relative mb-3">
        {/* 连接线背景 */}
        <div className="absolute top-[28px] left-[60px] right-[60px] h-1 bg-gray-100 rounded-full" />
        
        {/* 进度线 */}
        {currentSubIdx > 0 && currentStage !== 'rollout' && isActive && (
          <div 
            className="absolute top-[28px] left-[60px] h-1 bg-emerald-300 rounded-full transition-all duration-500"
            style={{ width: `${Math.min(100, (currentSubIdx / (PIPELINE_STAGES.length - 1)) * 100)}%` }}
          />
        )}
        
        <div className="relative flex justify-between items-start px-1">
          {PIPELINE_STAGES.map((ss, idx) => {
            // 判断完成状态
            const latest = history.length > 0 ? history[history.length - 1] : null
            const isBaselineStage = ss.key === 'baseline'
            
            let isSubDone = false
            if (status === 'completed') {
              isSubDone = true
            } else if (isBaselineStage) {
              // Baseline永远是完成的
              isSubDone = sortedHistory.length > 0
            } else if (latest && isActive) {
              // 训练阶段：每个新epoch开始时，只有当前阶段之前的才算完成
              // 如果当前是rollout阶段，说明开始新epoch，只有baseline是完成的
              if (currentStage !== 'rollout' && currentSubIdx > idx && idx > 0) {
                isSubDone = true
              }
            }
            
            const isSubActive = idx === currentSubIdx && isActive
            const Icon = ss.Icon

            return (
              <div key={ss.key} className="flex flex-col items-center relative z-10" style={{ width: 80 }}>
                <button
                  onClick={() => setExpandedSubStage(expandedSubStage === ss.key ? null : ss.key)}
                  disabled={status === 'idle' || status === 'waiting'}
                  className={`
                    relative w-[56px] h-[56px] rounded-xl flex items-center justify-center
                    transition-all duration-500 ease-out hover:scale-105 cursor-pointer
                    ${ss.key === 'baseline'
                      ? (isSubDone ? 'bg-emerald-50 border-2 border-emerald-200 text-emerald-600 shadow-sm'
                        : isSubActive ? 'bg-indigo-500 text-white shadow-lg shadow-indigo-200 scale-110 z-10'
                        : 'bg-white border-2 border-gray-200 text-gray-300')
                      : isSubDone
                        ? 'bg-emerald-50 border-2 border-emerald-200 text-emerald-600 shadow-sm'
                        : isSubActive
                          ? 'bg-indigo-500 text-white shadow-lg shadow-indigo-200 scale-110 z-10'
                          : 'bg-white border-2 border-gray-200 text-gray-300'}
                  `}
                  title={ss.desc}
                >
                  {isSubDone && ss.key !== 'baseline' ? (
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  ) : ss.key === 'baseline' && isSubDone ? (
                    <BarChart3 className="w-5 h-5" />
                  ) : isSubActive ? (
                    <>
                      <Icon className="w-5 h-5" />
                      <div className="absolute inset-0 rounded-xl ring-2 ring-indigo-300 ring-offset-1 ring-offset-white animate-ping opacity-20" />
                    </>
                  ) : (
                    <Icon className="w-5 h-5" />
                  )}
                </button>
                <div className={`text-[11px] mt-2 font-semibold text-center leading-tight ${isSubDone ? 'text-emerald-600' : isSubActive ? 'text-indigo-600' : 'text-gray-400'}`}>
                  {ss.label}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {expandedSubStage && (
        <RichSubStageDetail
          stageKey={expandedSubStage}
          stats={subStats[expandedSubStage as keyof typeof subStats]}
          history={history}
          isActive={isActive}
          onClose={() => setExpandedSubStage(null)}
        />
      )}

      {/* Completed summary */}
      {status === 'completed' && history.length > 0 && (
        <div className="border-t border-gray-100 pt-4 mt-4 grid grid-cols-4 gap-3">
          <MiniMetric icon={CheckCircle2} label="总 Accept" value={`${history.filter(h => h.action === 'accept').length}`} color="emerald" />
          <MiniMetric icon={TrendingUp} label="总 Reject" value={`${history.filter(h => h.action === 'reject').length}`} color="red" />
          <MiniMetric icon={Target} label="最佳分数" value={validScores.length > 0 ? `${(Math.max(...validScores) * 100).toFixed(0)}%` : '--'} color="indigo" />
          <MiniMetric icon={Clock} label="总步数" value={`${history.length}`} color="gray" />
        </div>
      )}

    </div>
  )
}

// ════════════════════════════════════════════════════════════
// StageChart — 阶段展开区域的可视化图表
// ════════════════════════════════════════════════════════════
function StageChart({
  type, data, height = 180,
}: {
  type: 'rollout' | 'reflect' | 'select' | 'decision' | 'gate-score'
  data: { step?: number; value1?: number; value2?: number; value3?: number; label?: string }[]
  height?: number
}) {
  if (data.length === 0) return null
  const h = height

  if (type === 'rollout') {
    return (
      <div className="bg-white rounded-xl border border-blue-100 p-4">
        <h5 className="text-xs font-semibold text-gray-700 flex items-center gap-1.5 mb-3"><BarChart3 className="w-3.5 h-3.5 text-blue-500" />正确率趋势</h5>
        <ResponsiveContainer width="100%" height={h}>
          <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f4ff" />
            <XAxis dataKey="step" tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
            <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} unit="%" />
            <Tooltip
              contentStyle={{ borderRadius: 10, fontSize: 11, border: 'none', boxShadow: '0 2px 8px rgba(0,0,0,.08)' }}
              formatter={(v: number) => [`${v.toFixed(1)}%`]}
              labelFormatter={(l: string) => `Step ${l}`}
            />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            <defs>
              <linearGradient id="rolloutGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#3b82f6" stopOpacity={0.25}/><stop offset="100%" stopColor="#3b82f6" stopOpacity={0}/></linearGradient>
            </defs>
            <Area type="monotone" dataKey="value1" name="Hard 正确率" stroke="#3b82f6" fill="url(#rolloutGrad)" strokeWidth={2} dot={{ r: 3, fill: '#3b82f6' }} />
            <Line type="monotone" dataKey="value2" name="Soft 正确率" stroke="#a78bfa" strokeWidth={1.8} strokeDasharray="4 2" dot={{ r: 2.5, fill: '#a78bfa' }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    )
  }

  if (type === 'reflect') {
    return (
      <div className="bg-white rounded-xl border border-violet-100 p-4">
        <h5 className="text-xs font-semibold text-gray-700 flex items-center gap-1.5 mb-3"><BarChart3 className="w-3.5 h-3.5 text-violet-500" />建议趋势</h5>
        <ResponsiveContainer width="100%" height={h}>
          <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f5f0ff" />
            <XAxis dataKey="step" tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
            <Tooltip
              contentStyle={{ borderRadius: 10, fontSize: 11, border: 'none', boxShadow: '0 2px 8px rgba(0,0,0,.08)' }}
              formatter={(v: number) => [`${v} 条`]}
              labelFormatter={(l: string) => `Step ${l}`}
            />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            <Bar dataKey="value1" name="生成建议" fill="#8b5cf6" radius={[3, 3, 0, 0]} maxBarSize={24} />
            <Bar dataKey="value2" name="有效建议" fill="#10b981" radius={[3, 3, 0, 0]} maxBarSize={24} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    )
  }

  if (type === 'select') {
    return (
      <div className="bg-white rounded-xl border border-teal-100 p-4">
        <h5 className="text-xs font-semibold text-gray-700 flex items-center gap-1.5 mb-3"><BarChart3 className="w-3.5 h-3.5 text-teal-500" />分数对比</h5>
        <ResponsiveContainer width="100%" height={h}>
          <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e6fffa" />
            <XAxis dataKey="step" tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
            <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} unit="%" />
            <Tooltip
              contentStyle={{ borderRadius: 10, fontSize: 11, border: 'none', boxShadow: '0 2px 8px rgba(0,0,0,.08)' }}
              formatter={(v: number) => [`${v.toFixed(1)}%`]}
              labelFormatter={(l: string) => `Step ${l}`}
            />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="4 4" label={{ value: '基线', position: 'insideLeft', fontSize: 9, fill: '#94a3b8' }} />
            <Line type="monotone" dataKey="value1" name="Rollout (训练集)" stroke="#3b82f6" strokeWidth={2} dot={{ r: 3, fill: '#3b82f6' }} />
            <Line type="monotone" dataKey="value2" name="Select (验证集)" stroke="#14b8a6" strokeWidth={2} dot={{ r: 3, fill: '#14b8a6' }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    )
  }

  if (type === 'decision') {
    const acceptCount = data.filter(d => d.label === 'accept').length
    const rejectCount = data.filter(d => d.label === 'reject').length
    const skipCount = data.filter(d => d.label === 'skip').length
    const total = acceptCount + rejectCount + skipCount || 1
    return (
      <div className="bg-white rounded-xl border border-indigo-100 p-4">
        <h5 className="text-xs font-semibold text-gray-700 flex items-center gap-1.5 mb-3"><BarChart3 className="w-3.5 h-3.5 text-indigo-500" />决策分布</h5>
        {/* 决策分布条 */}
        <div className="flex gap-1.5 mb-3 h-7 rounded-lg overflow-hidden">
          {acceptCount > 0 && (
            <div className="bg-emerald-400 flex items-center justify-center text-[10px] text-white font-bold transition-all"
                 style={{ width: `${(acceptCount / total) * 100}%`, minWidth: acceptCount > 0 ? 28 : 0 }}>
              Accept {acceptCount}
            </div>
          )}
          {rejectCount > 0 && (
            <div className="bg-red-400 flex items-center justify-center text-[10px] text-white font-bold"
                 style={{ width: `${(rejectCount / total) * 100}%`, minWidth: rejectCount > 0 ? 28 : 0 }}>
              Reject {rejectCount}
            </div>
          )}
          {skipCount > 0 && (
            <div className="bg-gray-300 flex items-center justify-center text-[10px] text-gray-600 font-bold"
                 style={{ width: `${(skipCount / total) * 100}%`, minWidth: skipCount > 0 ? 28 : 0 }}>
              Skip {skipCount}
            </div>
          )}
        </div>
        {/* 时间线 */}
        <ResponsiveContainer width="100%" height={Math.max(h - 50, 120)}>
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eef2ff" />
            <XAxis dataKey="step" tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
            <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} unit="%" hide />
            <Tooltip
              contentStyle={{ borderRadius: 10, fontSize: 11, border: 'none', boxShadow: '0 2px 8px rgba(0,0,0,.08)' }}
              formatter={(v: number, n: string) => {
                if (n === '分数') return [`${v.toFixed(1)}%`, '分数']
                return [v, n]
              }}
              labelFormatter={(l: string) => `Step ${l}`}
            />
            <Line type="stepAfter" dataKey="value1" name="分数" stroke="#6366f1" strokeWidth={2} dot={{ r: 3, strokeWidth: 2, fill: '#fff' }}
              activeDot={{ r: 5 }} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      </div>
    )
  }

  if (type === 'gate-score') {
    return (
      <div className="bg-white rounded-xl border border-indigo-100 p-4">
        <h5 className="text-xs font-semibold text-gray-700 flex items-center gap-1.5 mb-3"><BarChart3 className="w-3.5 h-3.5 text-indigo-500" />候选 vs 当前分数</h5>
        <ResponsiveContainer width="100%" height={h}>
          <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eef2ff" />
            <XAxis dataKey="step" tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
            <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} unit="%" />
            <Tooltip
              contentStyle={{ borderRadius: 10, fontSize: 11, border: 'none', boxShadow: '0 2px 8px rgba(0,0,0,.08)' }}
              formatter={(v: number) => [`${v.toFixed(1)}%`]}
              labelFormatter={(l: string) => `Step ${l}`}
            />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            <Bar dataKey="value1" name="当前分数" fill="#93c5fd" radius={[3, 3, 0, 0]} maxBarSize={20} />
            <Line type="monotone" dataKey="value2" name="候选分数" stroke="#6366f1" strokeWidth={2.5} dot={{ r: 4, fill: '#6366f1', stroke: '#fff', strokeWidth: 2 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    )
  }

  return null
}

// ════════════════════════════════════════════════════════════
// Rich Sub-Stage Detail — 每个阶段展开后的详细面板
// ════════════════════════════════════════════════════════════
function RichSubStageDetail({ stageKey, stats, history, isActive, onClose }: {
  stageKey: string; stats: any; history: StepHistory[]; isActive: boolean; onClose: () => void
}) {
  const [selectedStepIdx, setSelectedStepIdx] = useState(history.length - 1)
  // 每次 history 变化时自动选中最新一步
  useEffect(() => {
    setSelectedStepIdx(history.length - 1)
  }, [history.length])

  const latest = history.length > 0 ? history[history.length - 1] : null
  const selected = selectedStepIdx >= 0 ? (history[selectedStepIdx] ?? latest) : null
  const isOverall = selectedStepIdx === -1
  const sortedHistory = [...history].sort((a, b) => a.epoch !== b.epoch ? a.epoch - b.epoch : a.step - b.step)

  // 按 Epoch 分组
  const epochGroups = useMemo(() => {
    const map = new Map<number, StepHistory[]>()
    for (const s of sortedHistory) {
      const list = map.get(s.epoch) || []
      list.push(s)
      map.set(s.epoch, list)
    }
    return Array.from(map.entries()).sort(([a], [b]) => a - b)
  }, [sortedHistory])

  // Step selector component
  const StepSelector = () => (
    history.length <= 1 ? null : (
      <div className="mb-4 flex items-center gap-2">
        <span className="text-[10px] text-gray-400">查看步骤：</span>
        <div className="flex gap-1.5 flex-wrap">
          <button
            onClick={() => setSelectedStepIdx(-1)}
            className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-colors ${
              isOverall
                ? 'bg-gradient-to-r from-indigo-500 to-purple-500 text-white shadow-sm'
                : 'bg-gradient-to-r from-indigo-50 to-purple-50 text-indigo-600 border border-indigo-200 hover:border-indigo-300'
            }`}
            title="查看所有 Step 的汇总指标"
          >
            📊 总体
          </button>
          <span className="text-gray-200 mx-0.5">|</span>
          {epochGroups.map(([epoch, steps]) => (
            <div key={epoch} className="flex items-center gap-0.5">
              <span className="text-[9px] text-gray-300 font-medium px-0.5">E{epoch}</span>
              {steps.map((s) => {
                const globalIdx = sortedHistory.indexOf(s)
                const isActive = globalIdx === selectedStepIdx
                return (
                  <button
                    key={s.step}
                    onClick={() => setSelectedStepIdx(globalIdx)}
                    className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
                      isActive
                        ? 'bg-indigo-500 text-white shadow-sm'
                        : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                    }`}
                    title={`Epoch ${s.epoch}, Step ${s.step_in_epoch + 1} | ${s.action === 'accept' ? '接受' : s.action === 'reject' ? '拒绝' : '跳过'}`}
                  >
                    S{s.step_in_epoch + 1}
                    {s.action === 'accept' ? '' : s.action === 'reject' ? '✗' : '−'}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    )
  )

  // ── Baseline 详情 ──
  if (stageKey === 'baseline') {
    return (
      <div className="p-5 bg-gradient-to-br from-emerald-50/80 to-teal-50/50 rounded-2xl border border-emerald-100">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-white border border-emerald-200 flex items-center justify-center"><BarChart3 className="w-4 h-4 text-emerald-600" /></div>
            <div><h4 className="text-sm font-semibold text-gray-900">Baseline · 基线评估</h4><p className="text-xs text-gray-500 mt-0.5">使用初始 Skill 在验证集上评估，建立性能基准（全局唯一，非按 Step 变化）</p></div>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-200 rounded-lg text-gray-400"><ChevronDown className="w-4 h-4 rotate-180" /></button>
        </div>
        {history.length === 0 && !isActive ? (
          <div className="text-sm text-gray-400 py-6 text-center">等待基线评估开始...</div>
        ) : (
          <div className="grid grid-cols-4 gap-3">
            <MiniMetric icon={BarChart3} label="初始分数" value={stats.score} color="emerald" />
            <MiniMetric icon={ListChecks} label="训练步数" value={`${stats.stepCount}`} color="indigo" />
            <MiniMetric icon={Clock} label="总耗时" value={history.reduce((s, h) => s + (h.wall_time_s || 0), 0) > 0 ? `${history.reduce((s, h) => s + (h.wall_time_s || 0), 0).toFixed(1)}s` : '--'} color="gray" />
            <MiniMetric icon={Layers} label="Epoch 数" value={`${Math.max(...history.map(h => h.epoch), 0)}`} color="blue" />
          </div>
        )}
        {history[0] && (
          <div className="mt-3 p-3 bg-white rounded-xl border border-emerald-100 text-[11px] text-gray-600 leading-relaxed">
            <span className="font-medium text-gray-800">基线说明：</span>
            {(() => {
              const first = history[0]
              // 用 rollout_hard（编辑前原始 Skill 验证集评分）作为真实基线
              const s = first?.rollout_hard ?? first?.rollout_soft
              const scoreStr = s != null && !isNaN(s) && s > 0 ? `${(s * 100).toFixed(1)}%` : '暂无'
              return <>基线分数 {scoreStr} 是初始 Skill 在验证集上的准确率，后续所有修改都以此为基准判断是否有效。</>
            })()}
            训练目标是通过多轮迭代让 Skill 分数持续超过此基准。
          </div>
        )}
      </div>
    )
  }

  // ── Rollout 详情 ──
  if (stageKey === 'rollout') {
    const hardPct = selected?.rollout_hard != null ? (selected.rollout_hard * 100).toFixed(0) : null
    const softPct = selected?.rollout_soft != null ? (selected.rollout_soft * 100).toFixed(0) : null
    const wrongCount = selected?.rollout_hard != null ? Math.round((1 - selected.rollout_hard) * 100) || 0 : 0
    const rightCount = selected?.rollout_hard != null ? Math.round(selected.rollout_hard * 100) : 0
    // 总体聚合
    const rolloutData = history.filter(h => h.rollout_hard != null)
    const avgHard = rolloutData.length > 0 ? (rolloutData.reduce((s, h) => s + h.rollout_hard, 0) / rolloutData.length * 100).toFixed(0) : null
    const totalWrong = rolloutData.length > 0 ? Math.round(rolloutData.reduce((s, h) => s + (1 - h.rollout_hard) * 100, 0)) : 0
    const totalTime = history.reduce((s, h) => s + (h.timing?.rollout_s || 0), 0)
    return (
      <div className="p-5 bg-blue-50/50 rounded-2xl border border-blue-100">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-white border border-blue-200 flex items-center justify-center"><Play className="w-4 h-4 text-blue-600" /></div>
            <div><h4 className="text-sm font-semibold text-gray-900">Rollout · 滚动执行</h4><p className="text-xs text-gray-500 mt-0.5">用当前 Skill 逐条跑训练集 QA，找出答错题目</p></div>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-200 rounded-lg text-gray-400"><ChevronDown className="w-4 h-4 rotate-180" /></button>
        </div>
        <StepSelector />
        {isOverall ? (
          <div className="text-[10px] text-gray-500 mb-3">📍 当前查看：<b className="text-gray-700">📊 总体汇总</b>（{rolloutData.length} 个有效 Step）</div>
        ) : selected && (
          <div className="text-[10px] text-gray-500 mb-3">📍 当前查看：<b className="text-gray-700">Epoch {selected.epoch}, Step {selected.step_in_epoch + 1}</b>（{selected.action === 'accept' ? '已接受' : selected.action === 'reject' ? '已拒绝' : '跳过'}）</div>
        )}
        {isOverall ? (
          <>
            <div className="grid grid-cols-5 gap-3 mb-3">
              <MiniMetric icon={Target} label="平均 Hard" value={avgHard ? `${avgHard}%` : '--'} color="blue" />
              <MiniMetric icon={Layers} label="执行次数" value={`${rolloutData.length} 次`} color="purple" />
              <MiniMetric icon={CheckCircle2} label="累计正确" value={`${Math.round((rolloutData.length * 100) - totalWrong)} 题次`} color="emerald" />
              <MiniMetric icon={XCircle} label="累计错误" value={`${totalWrong} 题次`} color="red" />
              <MiniMetric icon={Clock} label="总耗时" value={totalTime > 0 ? `${totalTime.toFixed(1)}s` : '--'} color="orange" />
            </div>
            <StageChart
              type="rollout"
              data={rolloutData.map((h, i) => ({
                step: i + 1,
                value1: Math.round((h.rollout_hard ?? 0) * 100),
                value2: Math.round((h.rollout_soft ?? 0) * 100),
              }))}
            />
            <div className="mt-3 bg-blue-50/50 rounded-xl p-3 text-[11px] text-gray-600 leading-relaxed">
              共执行 <b>{rolloutData.length}</b> 次 Rollout，平均 Hard 正确率 <b className="text-blue-600">{avgHard ?? '--'}%</b>，
              累计发现 <b className="text-red-600">{totalWrong}</b> 题次错误。
            </div>
          </>
        ) : !selected ? (
          <div className="text-sm text-gray-400 py-6 text-center">等待 Rollout 开始...</div>
        ) : (
          <>
            <div className="grid grid-cols-5 gap-3 mb-3">
              <MiniMetric icon={Target} label="Hard 正确率" value={`${hardPct ?? '--'}%`} color="blue" />
              <MiniMetric icon={Filter} label="Soft 正确率" value={`${softPct ?? '--'}%`} color="purple" />
              <MiniMetric icon={CheckCircle2} label="正确数" value={`${rightCount} 题`} color="emerald" />
              <MiniMetric icon={XCircle} label="错误数" value={`${wrongCount} 题`} color="red" />
              <MiniMetric icon={Clock} label="执行耗时" value={selected?.timing?.rollout_s != null ? `${selected.timing.rollout_s.toFixed(1)}s` : '--'} color="orange" />
            </div>
            {/* 单步也展示历史趋势 */}
            {rolloutData.length > 1 && (
              <StageChart
                type="rollout"
                data={rolloutData.map((h, i) => ({
                  step: i + 1,
                  value1: Math.round((h.rollout_hard ?? 0) * 100),
                  value2: Math.round((h.rollout_soft ?? 0) * 100),
                }))}
                height={140}
              />
            )}
            <div className="bg-white rounded-xl border border-blue-100 p-4 space-y-2">
              <h5 className="text-xs font-semibold text-gray-700 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5 text-amber-500" />错误分析</h5>
              {wrongCount > 0 ? (
                <div className="space-y-1.5">
                  <p className="text-[11px] text-gray-600 leading-relaxed">
                    Epoch {selected.epoch} Step {selected.step_in_epoch + 1} 的 Skill 在训练集上有 <b className="text-red-600">{wrongCount} 题</b> 答错，Hard 正确率 <b>{hardPct}%</b>。
                    这些错题被送入 Reflect 阶段分析并生成修改建议。
                  </p>
                  <div className="flex gap-2 mt-2">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-red-50 text-red-600 rounded-md text-[10px] font-medium">
                      <XCircle className="w-3 h-3" /> {wrongCount} 道待修复
                    </span>
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 text-blue-600 rounded-md text-[10px] font-medium">
                      <BrainCircuit className="w-3 h-3" /> 进入 Reflect
                    </span>
                  </div>
                </div>
              ) : (
                <p className="text-[11px] text-gray-500">暂无 Rollout 数据或全部正确。</p>
              )}
            </div>
          </>
        )}
      </div>
    )
  }

  // ── Reflect 详情 ──
  if (stageKey === 'reflect') {
    const patches = selected?.n_patches ?? 0
    const success = selected?.n_success_patches ?? 0
    const failure = selected?.n_failure_patches ?? 0
    // 总体聚合
    const reflectData = history.filter(h => h.n_patches != null)
    const totalPatches = reflectData.reduce((s, h) => s + (h.n_patches || 0), 0)
    const totalSuccess = reflectData.reduce((s, h) => s + (h.n_success_patches || 0), 0)
    const totalFailure = reflectData.reduce((s, h) => s + (h.n_failure_patches || 0), 0)
    const totalTime = history.reduce((s, h) => s + (h.timing?.reflect_s || 0), 0)
    return (
      <div className="p-5 bg-violet-50/40 rounded-2xl border border-violet-100">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-white border border-violet-200 flex items-center justify-center"><BrainCircuit className="w-4 h-4 text-violet-600" /></div>
            <div><h4 className="text-sm font-semibold text-gray-900">Reflect · 反思分析</h4><p className="text-xs text-gray-500 mt-0.5">逐题分析错题原因，生成规则修改建议 (Patch)</p></div>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-200 rounded-lg text-gray-400"><ChevronDown className="w-4 h-4 rotate-180" /></button>
        </div>
        <StepSelector />
        {isOverall ? (
          <div className="text-[10px] text-gray-500 mb-3">📍 当前查看：<b className="text-gray-700">📊 总体汇总</b>（{reflectData.length} 个有效 Step）</div>
        ) : selected && (
          <div className="text-[10px] text-gray-500 mb-3">📍 当前查看：<b className="text-gray-700">Epoch {selected.epoch}, Step {selected.step_in_epoch + 1}</b></div>
        )}
        {isOverall ? (
          <>
            <div className="grid grid-cols-5 gap-3 mb-3">
              <MiniMetric icon={FileEdit} label="总生成建议" value={`${totalPatches} 条`} color="blue" />
              <MiniMetric icon={Lightbulb} label="总有效建议" value={`${totalSuccess} 条`} color="emerald" />
              <MiniMetric icon={Ban} label="总无效建议" value={`${totalFailure} 条`} color="red" />
              <MiniMetric icon={Zap} label="总体有效率" value={totalPatches > 0 ? `${(totalSuccess / totalPatches * 100).toFixed(0)}%` : '--'} color="indigo" />
              <MiniMetric icon={Clock} label="总耗时" value={totalTime > 0 ? `${totalTime.toFixed(1)}s` : '--'} color="orange" />
            </div>
            {reflectData.length > 0 && (
              <StageChart
                type="reflect"
                data={reflectData.map((h, i) => ({
                  step: i + 1,
                  value1: h.n_patches ?? 0,
                  value2: h.n_success_patches ?? 0,
                }))}
              />
            )}
            <div className="mt-3 bg-violet-50/50 rounded-xl p-3 text-[11px] text-gray-600 leading-relaxed">
              共执行 <b>{reflectData.length}</b> 次 Reflect，累计生成 <b className="text-violet-700">{totalPatches}</b> 条修改建议，
              其中 <b className="text-emerald-600">{totalSuccess}</b> 条有效，
              <b className="text-red-600">{totalFailure}</b> 条无效。
            </div>
          </>
        ) : !selected || selected.n_patches == null ? (
          <div className="text-sm text-gray-400 py-6 text-center">等待 Reflect 开始...</div>
        ) : (
          <>
            <div className="grid grid-cols-5 gap-3 mb-3">
              <MiniMetric icon={FileEdit} label="生成建议数" value={`${patches} 条`} color="blue" />
              <MiniMetric icon={Lightbulb} label="有效建议" value={`${success} 条`} color="emerald" />
              <MiniMetric icon={Ban} label="无效建议" value={`${failure} 条`} color="red" />
              <MiniMetric icon={Zap} label="有效率" value={patches > 0 ? `${(success / patches * 100).toFixed(0)}%` : '--'} color="indigo" />
              <MiniMetric icon={Clock} label="分析耗时" value={selected?.timing?.reflect_s != null ? `${selected.timing.reflect_s.toFixed(1)}s` : '--'} color="orange" />
            </div>
            {reflectData.length > 1 && (
              <StageChart
                type="reflect"
                data={reflectData.map((h, i) => ({
                  step: i + 1,
                  value1: h.n_patches ?? 0,
                  value2: h.n_success_patches ?? 0,
                }))}
                height={140}
              />
            )}
            <div className="bg-white rounded-xl border border-violet-100 p-4 space-y-3">
              <h5 className="text-xs font-semibold text-gray-700 flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5 text-violet-500" />建议详情</h5>
              <div className="space-y-2.5">
                <div className="p-3 bg-violet-50/60 rounded-lg">
                  <div className="text-[11px] font-medium text-gray-700 mb-1">📝 生成的 Patch 类型</div>
                  <div className="text-[11px] text-gray-600 leading-relaxed">
                    Epoch {selected.epoch} Step {selected.step_in_epoch + 1} 的 AI 逐题分析 Rollout 错题后，
                    共生成 <b className="text-violet-700">{patches}</b> 条修改建议，
                    含规则新增、条件修改、边界调整等。
                  </div>
                </div>
                {failure > 0 && (
                  <div className="p-3 bg-amber-50/60 rounded-lg">
                    <div className="text-[11px] font-medium text-amber-700 mb-1">⚠️ 无效建议 ({failure} 条)</div>
                    <div className="text-[11px] text-gray-600 leading-relaxed">
                      部分 Patch 因安全校验未通过或与现有规则冲突被标记为无效，不进入 Aggregate。
                    </div>
                  </div>
                )}
                {success > 0 && (
                  <div className="p-3 bg-emerald-50/60 rounded-lg">
                    <div className="text-[11px] font-medium text-emerald-700 mb-1">✅ 有效建议 ({success} 条)</div>
                    <div className="text-[11px] text-gray-600 leading-relaxed">
                      通过安全校验的有效 Patch，进入 Aggregate 合并去重。
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    )
  }

  // ── Aggregate 详情 ──
  if (stageKey === 'aggregate') {
    const total = selected?.n_patches ?? 0
    const success = selected?.n_success_patches ?? 0
    const deduped = total - success
    // 总体聚合
    const aggData = history.filter(h => h.n_patches != null)
    const totalInput = aggData.reduce((s, h) => s + (h.n_patches || 0), 0)
    const totalOutput = aggData.reduce((s, h) => s + (h.n_success_patches || 0), 0)
    const totalDeduped = totalInput - totalOutput
    return (
      <div className="p-5 bg-cyan-50/30 rounded-2xl border border-cyan-100">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-white border border-cyan-200 flex items-center justify-center"><GitMerge className="w-4 h-4 text-cyan-600" /></div>
            <div><h4 className="text-sm font-semibold text-gray-900">Aggregate · 梯度聚合</h4><p className="text-xs text-gray-500 mt-0.5">合并修改建议，去重解决冲突</p></div>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-200 rounded-lg text-gray-400"><ChevronDown className="w-4 h-4 rotate-180" /></button>
        </div>
        <StepSelector />
        {isOverall ? (
          <div className="text-[10px] text-gray-500 mb-3">📍 当前查看：<b className="text-gray-700">📊 总体汇总</b>（{aggData.length} 个有效 Step）</div>
        ) : selected && (
          <div className="text-[10px] text-gray-500 mb-3">📍 当前查看：<b className="text-gray-700">Epoch {selected.epoch}, Step {selected.step_in_epoch + 1}</b></div>
        )}
        {isOverall ? (
          <>
            <div className="grid grid-cols-4 gap-3 mb-3">
              <MiniMetric icon={GitMerge} label="总输入建议" value={`${totalInput} 条`} color="blue" />
              <MiniMetric icon={Layers} label="总去重后" value={`${totalOutput} 条`} color="emerald" />
              <MiniMetric icon={Wrench} label="总去重数" value={`${totalDeduped} 条`} color="amber" />
              <MiniMetric icon={Scale} label="总体去重率" value={totalInput > 0 ? `${(totalDeduped / totalInput * 100).toFixed(0)}%` : '--'} color="indigo" />
            </div>
            <div className="bg-white rounded-xl border border-cyan-100 p-4">
              <h5 className="text-xs font-semibold text-gray-700 flex items-center gap-1.5 mb-2"><TrendingUp className="w-3.5 h-3.5 text-cyan-500" />总体趋势</h5>
              <div className="text-[11px] text-gray-600 leading-relaxed">
                共执行 <b>{aggData.length}</b> 次 Aggregate，累计处理 <b>{totalInput}</b> 条建议，
                去重合并后输出 <b className="text-emerald-600">{totalOutput}</b> 条，总体去重率 <b>{totalInput > 0 ? `${(totalDeduped / totalInput * 100).toFixed(0)}%` : '--'}</b>。
              </div>
            </div>
          </>
        ) : !selected || selected.n_patches == null ? (
          <div className="text-sm text-gray-400 py-6 text-center">等待 Aggregate 开始...</div>
        ) : (
          <>
            <div className="grid grid-cols-4 gap-3 mb-3">
              <MiniMetric icon={GitMerge} label="输入建议" value={`${total} 条`} color="blue" />
              <MiniMetric icon={Layers} label="去重后" value={`${success} 条`} color="emerald" />
              <MiniMetric icon={Wrench} label="去重数量" value={`${deduped} 条`} color="amber" />
              <MiniMetric icon={Scale} label="去重率" value={total > 0 ? `${(deduped / total * 100).toFixed(0)}%` : '--'} color="indigo" />
            </div>
            <div className="bg-white rounded-xl border border-cyan-100 p-4 space-y-2.5">
              <h5 className="text-xs font-semibold text-gray-700 flex items-center gap-1.5"><Wrench className="w-3.5 h-3.5 text-cyan-600" />合并结果</h5>
              <div className="text-[11px] text-gray-600 leading-relaxed space-y-2">
                <p>Epoch {selected.epoch} Step {selected.step_in_epoch + 1}：从 Reflect 的 <b>{total}</b> 条建议中处理：</p>
                <ul className="list-disc list-inside space-y-1 ml-1 text-[10px] text-gray-500">
                  <li><b className="text-gray-700">语义去重</b>：高度相似建议合并，保留最详细版本</li>
                  <li><b className="text-gray-700">冲突检测</b>：互相矛盾修改需仲裁</li>
                  <li><b className="text-gray-700">优先级排序</b>：支持数高者优先保留</li>
                </ul>
                <p>输出 <b className="text-emerald-600">{success}</b> 条合并后修改，送入 Select 评估。</p>
              </div>
            </div>
          </>
        )}
      </div>
    )
  }

  // ── Select 详情 ──
  if (stageKey === 'select') {
    const selHard = selected?.selection_hard != null ? `${(selected.selection_hard * 100).toFixed(0)}%` : null
    const selSoft = selected?.selection_soft != null ? `${(selected.selection_soft * 100).toFixed(0)}%` : null
    const rollHard = selected?.rollout_hard != null ? `${(selected.rollout_hard * 100).toFixed(0)}%` : null
    const diff = (selected?.selection_hard ?? 0) - (selected?.rollout_hard ?? 0)
    // 总体聚合
    const selData = history.filter(h => h.selection_hard != null)
    const improved = selData.filter(h => (h.selection_hard ?? 0) > (h.rollout_hard ?? 0)).length
    const avgDiff = selData.length > 0 ? selData.reduce((s, h) => s + ((h.selection_hard ?? 0) - (h.rollout_hard ?? 0)), 0) / selData.length * 100 : 0
    return (
      <div className="p-5 bg-teal-50/30 rounded-2xl border border-teal-100">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-white border border-teal-200 flex items-center justify-center"><CheckCircle2 className="w-4 h-4 text-teal-600" /></div>
            <div><h4 className="text-sm font-semibold text-gray-900">Select · 择优评估</h4><p className="text-xs text-gray-500 mt-0.5">候选 Skill 在验证集上打分，检验泛化效果</p></div>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-200 rounded-lg text-gray-400"><ChevronDown className="w-4 h-4 rotate-180" /></button>
        </div>
        <StepSelector />
        {isOverall ? (
          <div className="text-[10px] text-gray-500 mb-3">📍 当前查看：<b className="text-gray-700">📊 总体汇总</b>（{selData.length} 个有效 Step）</div>
        ) : selected && (
          <div className="text-[10px] text-gray-500 mb-3">📍 当前查看：<b className="text-gray-700">Epoch {selected.epoch}, Step {selected.step_in_epoch + 1}</b></div>
        )}
        {isOverall ? (
          <>
            <div className="grid grid-cols-5 gap-3 mb-3">
              <MiniMetric icon={Layers} label="评估次数" value={`${selData.length} 次`} color="teal" />
              <MiniMetric icon={TrendingUp} label="提升次数" value={`${improved} 次`} color="emerald" />
              <MiniMetric icon={ArrowRight} label="平均变化" value={avgDiff >= 0 ? `+${avgDiff.toFixed(1)}%` : `${avgDiff.toFixed(1)}%`} color={avgDiff >= 0 ? 'emerald' : 'red'} />
              <MiniMetric icon={HelpCircle} label="提升率" value={selData.length > 0 ? `${(improved / selData.length * 100).toFixed(0)}%` : '--'} color="indigo" />
              <MiniMetric icon={Scale} label="有效步数" value={`${selData.length} / ${history.length}`} color="purple" />
            </div>
            {selData.length > 0 && (
              <StageChart
                type="select"
                data={selData.map((h, i) => ({
                  step: i + 1,
                  value1: Math.round((h.rollout_hard ?? 0) * 100),
                  value2: Math.round((h.selection_hard ?? 0) * 100),
                }))}
              />
            )}
            <div className="mt-3 bg-teal-50/50 rounded-xl p-3 text-[11px] text-gray-600 leading-relaxed">
              共执行 <b>{selData.length}</b> 次 Select，其中 <b className="text-emerald-600">{improved}</b> 次验证集分数提升，
              平均泛化变化 <b className={avgDiff >= 0 ? 'text-emerald-600' : 'text-red-600'}>{avgDiff >= 0 ? `+${avgDiff.toFixed(1)}%` : `${avgDiff.toFixed(1)}%`}</b>。
            </div>
          </>
        ) : !selected || selected.selection_hard == null ? (
          <div className="text-sm text-gray-400 py-6 text-center">等待 Select 开始...</div>
        ) : (
          <>
            <div className="grid grid-cols-5 gap-3 mb-3">
              <MiniMetric icon={Eye} label="验证集 Hard" value={`${selHard ?? '--'}`} color="teal" />
              <MiniMetric icon={Filter} label="验证集 Soft" value={`${selSoft ?? '--'}`} color="purple" />
              <MiniMetric icon={TrendingUp} label="训练集 Hard" value={`${rollHard ?? '--'}`} color="blue" />
              <MiniMetric icon={ArrowRight} label="分数变化" value={diff >= 0 ? `+${(diff * 100).toFixed(0)}%` : `${(diff * 100).toFixed(0)}%`} color={diff >= 0 ? 'emerald' : 'red'} />
              <MiniMetric icon={HelpCircle} label="是否提升" value={diff > 0 ? '是 ✓' : diff === 0 ? '持平' : '否 ✗'} color={diff > 0 ? 'emerald' : diff === 0 ? 'gray' : 'red'} />
            </div>
            {selData.length > 1 && (
              <StageChart
                type="select"
                data={selData.map((h, i) => ({
                  step: i + 1,
                  value1: Math.round((h.rollout_hard ?? 0) * 100),
                  value2: Math.round((h.selection_hard ?? 0) * 100),
                }))}
                height={140}
              />
            )}
            <div className="bg-white rounded-xl border border-teal-100 p-4 space-y-2.5">
              <h5 className="text-xs font-semibold text-gray-700 flex items-center gap-1.5"><Scale className="w-3.5 h-3.5 text-teal-600" />评估结论</h5>
              <div className={`p-3 rounded-lg ${diff > 0 ? 'bg-emerald-50/70 border border-emerald-100' : diff < 0 ? 'bg-red-50/70 border border-red-100' : 'bg-gray-50 border border-gray-100'}`}>
                <div className="text-[11px] font-medium mb-1">{diff > 0 ? '✅ 验证集提升 — 泛化能力增强' : diff < 0 ? '⚠️ 验证集下降 — 可能过拟合' : '➡️ 验证集持平'}</div>
                <div className="text-[11px] text-gray-600 leading-relaxed">
                  候选 Skill 在<b>未见过的验证集</b>上：训练集 Hard <b>{rollHard}</b> → 验证集 Hard <b>{selHard}</b>
                  {diff > 0 ? '。修改提升了泛化能力。'
                   : diff < 0 ? '。可能过拟合，Gate 很可能拒绝。'
                   : '。无明显变化。'}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    )
  }

  // ── Update 详情 ──
  if (stageKey === 'update') {
    const action = selected?.action
    const beforeScore = selected?.current_score != null ? `${(selected.current_score * 100).toFixed(1)}%` : '--'
    const afterScore = selected?.score != null && selected.score > 0 ? `${(selected.score * 100).toFixed(1)}%` : '--'
    const scoreDelta = ((selected?.score ?? 0) - (selected?.current_score ?? 0)) * 100
    const skillLen = selected?.skill_len ?? '--'
    // 总体聚合
    const updateData = history.filter(h => h.action === 'accept' || h.action === 'reject')
    const accepts = updateData.filter(h => h.action === 'accept').length
    const rejects = updateData.filter(h => h.action === 'reject').length
    const totalSkips = history.filter(h => h.action === 'skip').length
    const avgDelta = updateData.length > 0 ? updateData.reduce((s, h) => s + ((h.score ?? 0) - (h.current_score ?? 0)) * 100, 0) / updateData.length : 0
    const maxScore = updateData.length > 0 ? Math.max(...updateData.map(h => h.score || 0)) * 100 : 0
    return (
      <div className="p-5 bg-amber-50/20 rounded-2xl border border-amber-100">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-white border border-amber-200 flex items-center justify-center"><PenLine className="w-4 h-4 text-amber-600" /></div>
            <div><h4 className="text-sm font-semibold text-gray-900">Update · 决策更新</h4><p className="text-xs text-gray-500 mt-0.5">根据 Gate 判断决定接受或拒绝本轮修改</p></div>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-200 rounded-lg text-gray-400"><ChevronDown className="w-4 h-4 rotate-180" /></button>
        </div>
        <StepSelector />
        {isOverall ? (
          <div className="text-[10px] text-gray-500 mb-3">📍 当前查看：<b className="text-gray-700">📊 总体汇总</b>（{updateData.length} 次决策）</div>
        ) : selected && (
          <div className="text-[10px] text-gray-500 mb-3">📍 当前查看：<b className="text-gray-700">Epoch {selected.epoch}, Step {selected.step_in_epoch + 1}</b>（{selected.action === 'accept' ? '已接受' : selected.action === 'reject' ? '已拒绝' : '跳过'}）</div>
        )}
        {isOverall ? (
          <>
            <div className="grid grid-cols-6 gap-3 mb-3">
              <MiniMetric icon={ThumbsUp} label="总 Accept" value={`${accepts} 次`} color="emerald" />
              <MiniMetric icon={ThumbsDown} label="总 Reject" value={`${rejects} 次`} color="red" />
              <MiniMetric icon={Ban} label="总 Skip" value={`${totalSkips} 次`} color="gray" />
              <MiniMetric icon={TrendingUp} label="通过率" value={updateData.length > 0 ? `${(accepts / updateData.length * 100).toFixed(0)}%` : '--'} color="indigo" />
              <MiniMetric icon={ArrowRight} label="平均Δ" value={avgDelta >= 0 ? `+${avgDelta.toFixed(1)}%` : `${avgDelta.toFixed(1)}%`} color={avgDelta >= 0 ? 'emerald' : 'red'} />
              <MiniMetric icon={Target} label="最高分" value={maxScore > 0 ? `${maxScore.toFixed(1)}%` : '--'} color="blue" />
            </div>
            {history.length > 0 && (
              <StageChart
                type="decision"
                data={sortedHistory.map((h) => ({
                  step: h.step,
                  label: h.action === 'accept' ? 'accept'
                    : h.action === 'reject' ? 'reject' : 'skip',
                  value1: Math.round(((h.best_score ?? h.current_score ?? h.score ?? 0)) * 100),
                }))}
                height={180}
              />
            )}
            <div className="mt-3 bg-amber-50/50 rounded-xl p-3 text-[11px] text-gray-600 leading-relaxed">
              共执行 <b>{history.length}</b> 步训练，完成 <b>{updateData.length}</b> 次决策：
              接受 <b className="text-emerald-600">{accepts}</b> 次、拒绝 <b className="text-red-600">{rejects}</b> 次、跳过 <b>{totalSkips}</b> 次，
              平均分数变化 <b className={avgDelta >= 0 ? 'text-emerald-600' : 'text-red-600'}>{avgDelta >= 0 ? `+${avgDelta.toFixed(1)}%` : `${avgDelta.toFixed(1)}%`}</b>。
            </div>
          </>
        ) : !action || action === 'skip' ? (
          <div className="text-sm text-gray-400 py-6 text-center">{!selected ? '等待 Update...' : '本轮跳过更新'}</div>
        ) : (
          <>
            <div className="grid grid-cols-5 gap-3 mb-3">
              <MiniMetric icon={action === 'accept' ? ThumbsUp : ThumbsDown} label="决策" value={action === 'accept' ? '接受 ✓' : '拒绝 ✗'} color={action === 'accept' ? 'emerald' : 'red'} />
              <MiniMetric icon={BookOpen} label="修改前分数" value={beforeScore} color="blue" />
              <MiniMetric icon={Sparkles} label="修改后分数" value={afterScore} color={scoreDelta >= 0 ? 'emerald' : 'red'} />
              <MiniMetric icon={TrendingUp} label="分数变化" value={scoreDelta >= 0 ? `+${scoreDelta.toFixed(1)}%` : `${scoreDelta.toFixed(1)}%`} color={scoreDelta >= 0 ? 'emerald' : 'red'} />
              <MiniMetric icon={Layers} label="Skill 长度" value={`${skillLen} 字符`} color="indigo" />
            </div>
            <div className={`rounded-xl border p-4 ${action === 'accept' ? 'bg-emerald-50/70 border-emerald-100' : 'bg-red-50/70 border-red-100'}`}>
              <h5 className="text-xs font-semibold flex items-center gap-1.5 mb-2">
                {action === 'accept'
                  ? <><ThumbsUp className="w-3.5 h-3.5 text-emerald-600" /> 接受原因</>
                  : <><ThumbsDown className="w-3.5 h-3.5 text-red-600" /> 拒绝原因</>}
              </h5>
              <div className="text-[11px] text-gray-700 leading-relaxed space-y-1.5">
                {action === 'accept' ? (
                  <>
                    <p><b className="text-emerald-700">候选分数 {afterScore} &gt; 当前分数 {beforeScore}</b>，满足 Gate 接受条件。</p>
                    <p>Skill 文档已更新至新版本，长度为 <b>{skillLen}</b> 字符。</p>
                    <p>下一轮训练将基于此更新后的 Skill 继续迭代优化。</p>
                  </>
                ) : (
                  <>
                    <p><b className="text-red-700">候选分数 {afterScore} ≤ 当前分数 {beforeScore}</b>，不满足 Gate 接受条件。</p>
                    <p>本轮所有修改被回滚，Skill 保持不变。这可能是：</p>
                    <ul className="list-disc list-inside space-y-0.5 ml-1 text-[10px] text-gray-600">
                      <li>修改引入了新的误判（在验证集上反而变差）</li>
                      <li>Patch 质量不足，未能真正改进核心逻辑</li>
                      <li>当前已接近 Skill 的性能上限</li>
                    </ul>
                  </>
                )}
              </div>
              <div className="mt-2 pt-2 border-t border-gray-100/50 text-[10px] text-gray-400">
                Gate 判断标准: {selected?.gate_metric === 'hard' ? '硬匹配（答案完全一致）' : selected?.gate_metric === 'soft' ? '软匹配（语义相似即可）' : selected?.gate_metric || '--'}
              </div>
            </div>
          </>
        )}
      </div>
    )
  }

  // ── Gate 详情 ──
  if (stageKey === 'gate') {
    const accepts = history.filter(h => h.action === 'accept').length
    const rejects = history.filter(h => h.action === 'reject').length
    const skips = history.filter(h => h.action === 'skip').length
    const candScore = selected?.candidate_gate_score != null ? `${(selected.candidate_gate_score * 100).toFixed(1)}%` : '--'
    const currScore = selected?.current_score != null ? `${(selected.current_score * 100).toFixed(1)}%` : '--'
    const gateMetric = selected?.gate_metric ?? '--'
    // 总体聚合
    const gateData = history.filter(h => h.candidate_gate_score != null)
    const avgCandScore = gateData.length > 0 ? gateData.reduce((s, h) => s + (h.candidate_gate_score || 0), 0) / gateData.length * 100 : 0
    const avgCurrScore = gateData.length > 0 ? gateData.reduce((s, h) => s + (h.current_score || 0), 0) / gateData.length * 100 : 0
    return (
      <div className="p-5 bg-indigo-50/20 rounded-2xl border border-indigo-100">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-white border border-indigo-200 flex items-center justify-center"><ShieldCheck className="w-4 h-4 text-indigo-600" /></div>
            <div><h4 className="text-sm font-semibold text-gray-900">Gate · 质量门控</h4><p className="text-xs text-gray-500 mt-0.5">最终验收：候选分数 &gt; 当前分数 → 接受，否则拒绝</p></div>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-200 rounded-lg text-gray-400"><ChevronDown className="w-4 h-4 rotate-180" /></button>
        </div>
        <StepSelector />
        {isOverall ? (
          <div className="text-[10px] text-gray-500 mb-3">📍 当前查看：<b className="text-gray-700">📊 总体汇总</b>（{gateData.length} 个有效 Step）</div>
        ) : selected && (
          <div className="text-[10px] text-gray-500 mb-3">📍 当前查看：<b className="text-gray-700">Epoch {selected.epoch}, Step {selected.step_in_epoch + 1}</b>（{selected.action === 'accept' ? '已接受' : selected.action === 'reject' ? '已拒绝' : '跳过'}）</div>
        )}
        {isOverall ? (
          <div className="grid grid-cols-7 gap-3 mb-3">
            <MiniMetric icon={ThumbsUp} label="总 Accept" value={`${accepts} 次`} color="emerald" />
            <MiniMetric icon={ThumbsDown} label="总 Reject" value={`${rejects} 次`} color="red" />
            <MiniMetric icon={Ban} label="总 Skip" value={`${skips} 次`} color="gray" />
            <MiniMetric icon={Target} label="平均候选分" value={avgCandScore > 0 ? `${avgCandScore.toFixed(1)}%` : '--'} color="indigo" />
            <MiniMetric icon={BarChart3} label="平均当前分" value={avgCurrScore > 0 ? `${avgCurrScore.toFixed(1)}%` : '--'} color="blue" />
            <MiniMetric icon={TrendingUp} label="平均Δ" value={(avgCandScore - avgCurrScore) >= 0 ? `+${(avgCandScore - avgCurrScore).toFixed(1)}%` : `${(avgCandScore - avgCurrScore).toFixed(1)}%`} color={(avgCandScore - avgCurrScore) >= 0 ? 'emerald' : 'red'} />
            <MiniMetric icon={Scale} label="通过率" value={accepts + rejects > 0 ? `${(accepts / (accepts + rejects) * 100).toFixed(0)}%` : '--'} color={accepts + rejects > 0 && accepts / (accepts + rejects) > 0.5 ? 'emerald' : 'red'} />
          </div>
        ) : (
          <div className="grid grid-cols-7 gap-3 mb-3">
            <MiniMetric icon={ThumbsUp} label="全局 Accept" value={`${accepts} 次`} color="emerald" />
            <MiniMetric icon={ThumbsDown} label="全局 Reject" value={`${rejects} 次`} color="red" />
            <MiniMetric icon={Ban} label="全局 Skip" value={`${skips} 次`} color="gray" />
            <MiniMetric icon={Target} label="候选分数" value={candScore} color="indigo" />
            <MiniMetric icon={BarChart3} label="当前分数" value={currScore} color="blue" />
            <MiniMetric icon={Scale} label="判断标准" value={gateMetric === 'hard' ? '硬匹配' : gateMetric === 'soft' ? '软匹配' : gateMetric === 'mixed' ? '混合' : '--'} color="purple" />
            <MiniMetric icon={TrendingUp} label="通过率" value={accepts + rejects > 0 ? `${(accepts / (accepts + rejects) * 100).toFixed(0)}%` : '--'} color={accepts + rejects > 0 && accepts / (accepts + rejects) > 0.5 ? 'emerald' : 'red'} />
          </div>
        )}
        {/* Gate 分数对比图 */}
        {gateData.length > 0 && (
          <StageChart
            type="gate-score"
            data={gateData.map((h, i) => ({
              step: i + 1,
              value1: Math.round((h.current_score ?? 0) * 100),
              value2: Math.round((h.candidate_gate_score ?? 0) * 100),
            }))}
            height={180}
          />
        )}
        {/* 决策历史 */}
        {history.length > 0 && (
          <div className="bg-white rounded-xl border border-indigo-100 p-4">
            <h5 className="text-xs font-semibold text-gray-700 mb-3 flex items-center gap-1.5"><ListChecks className="w-3.5 h-3.5 text-indigo-500" />决策历史</h5>
            <div className="space-y-1.5 max-h-[180px] overflow-auto">
              {history.map((h, i) => (
                <div key={i} className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-[11px] ${
                  h.action === 'accept' ? 'bg-emerald-50/60 border border-emerald-100'
                  : h.action === 'reject' ? 'bg-red-50/60 border border-red-100'
                  : 'bg-gray-50 border border-gray-100'
                }`}>
                  <div className={`shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold ${
                    h.action === 'accept' ? 'bg-emerald-100 text-emerald-700'
                    : h.action === 'reject' ? 'bg-red-100 text-red-700'
                    : 'bg-gray-100 text-gray-500'
                  }`}>{h.step}</div>
                  <span className="font-medium text-gray-600 shrink-0">Step {h.step}</span>
                  <span className={`font-semibold shrink-0 ${
                    h.action === 'accept' ? 'text-emerald-600'
                    : h.action === 'reject' ? 'text-red-600'
                    : 'text-gray-400'
                  }`}>
                    {h.action === 'accept' ? '✓ Accept' : h.action === 'reject' ? '✗ Reject' : '○ Skip'}
                  </span>
                  <span className="text-gray-400 ml-auto shrink-0">
                    {h.score > 0 ? `${(h.score * 100).toFixed(1)}%` : '--'}
                  </span>
                  <span className="text-gray-300 shrink-0">
                    E{h.epoch}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        {/* Gate 规则说明 */}
        <div className="mt-3 p-3 bg-indigo-50/40 rounded-xl text-[11px] text-gray-600 leading-relaxed">
          <span className="font-medium text-indigo-700">Gate 判断规则：</span>
          将修改后的候选 Skill 在验证集上打分，如果候选分数高于当前分数则接受修改（写入 Skill），
          否则拒绝（保持原 Skill 不变）。这是防止过拟合的关键机制——只在真正提升时才采纳。
        </div>
      </div>
    )
  }

  return null
}

// ════════════════════════════════════════════════════════════
// StageTimingBar — 各阶段执行耗时可视化进度条
// ════════════════════════════════════════════════════════════
const STAGE_COLORS: Record<string, { bg: string; bar: string; label: string }> = {
  rollout:   { bg: 'bg-blue-50',    bar: 'bg-blue-400',   label: 'Rollout 执行' },
  reflect:   { bg: 'bg-violet-50',  bar: 'bg-violet-400', label: 'Reflect 反思' },
  aggregate: { bg: 'bg-cyan-50',    bar: 'bg-cyan-400',   label: 'Aggregate 合并' },
  select:    { bg: 'bg-teal-50',    bar: 'bg-teal-400',   label: 'Select 评估' },
  evaluate:  { bg: 'bg-amber-50',   bar: 'bg-amber-400',  label: 'Evaluate 验证' },
}
const STAGE_ORDER = ['rollout', 'reflect', 'aggregate', 'select', 'evaluate']

function StageTimingBar({ timing, history }: { timing: Record<string, number>; history: StepHistory[] }) {
  // Use latest WS timing, or fallback to latest history step timing
  const latest = history.length > 0 ? history[history.length - 1] : null
  const histTiming = latest?.timing as any
  const wsTiming: Record<string, number> = Object.keys(timing).length > 0 ? timing :
    (histTiming ? {
      rollout: histTiming.rollout_s || 0,
      reflect: histTiming.reflect_s || 0,
      aggregate: histTiming.aggregate_s || 0,
      select: histTiming.select_s || 0,
      evaluate: histTiming.evaluate_s || 0,
    } : {})

  const validStages = STAGE_ORDER.filter(k => (wsTiming as any)[k] > 0)
  if (validStages.length === 0) {
    return (
      <div className="mb-4 p-3 bg-gray-50 rounded-xl text-[11px] text-gray-400 text-center">
        暂无阶段耗时数据
      </div>
    )
  }

  const total = validStages.reduce((s, k) => s + ((wsTiming as any)[k] || 0), 0)
  const maxTime = Math.max(...validStages.map(k => (wsTiming as any)[k] || 0))

  return (
    <div className="mb-4 p-4 bg-orange-50/30 rounded-xl border border-orange-100">
      {/* Total time header */}
      <div className="flex items-center justify-between mb-3">
        <h5 className="text-xs font-semibold text-gray-700 flex items-center gap-1.5">
          <Clock className="w-3.5 h-3.5 text-orange-500" />
          最新步骤各阶段耗时 {total > 0 && <span className="text-orange-600">（总计 {total.toFixed(1)}s）</span>}
        </h5>
        {latest && (
          <span className="text-[10px] text-gray-400">
            Step {latest.step} · Epoch {latest.epoch}
          </span>
        )}
      </div>

      {/* Per-stage bars */}
      <div className="space-y-2">
        {validStages.map(key => {
          const time = (wsTiming as any)[key] || 0
          const pct = total > 0 ? (time / total) * 100 : 0
          const barPct = maxTime > 0 ? (time / maxTime) * 100 : 0
          const cfg = STAGE_COLORS[key] || { bg: 'bg-gray-50', bar: 'bg-gray-300', label: key }
          return (
            <div key={key} className="flex items-center gap-3">
              <div className="w-[110px] shrink-0 flex items-center justify-between">
                <span className="text-[11px] font-medium text-gray-600">{cfg.label}</span>
                <span className="text-[11px] font-semibold text-gray-800 tabular-nums">{time.toFixed(1)}s</span>
              </div>
              <div className="flex-1 h-5 bg-gray-100 rounded-full overflow-hidden relative">
                <div
                  className={`h-full ${cfg.bar} rounded-full transition-all duration-700 flex items-center justify-end pr-1.5`}
                  style={{ width: `${Math.max(barPct, 2)}%` }}
                >
                  <span className="text-[9px] text-white font-semibold tabular-nums">
                    {pct.toFixed(0)}%
                  </span>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Tip */}
      {total > 60 && (
        <div className="mt-3 p-2 bg-amber-50/60 rounded-lg text-[10px] text-amber-700 flex items-center gap-1.5">
          <AlertTriangle className="w-3 h-3 shrink-0" />
          当前步骤总耗时超过 60s，聚合(Aggregate)阶段的 LLM 调用是主要瓶颈。可通过减少 Batch Size 或切换更快模型加速。
        </div>
      )}
    </div>
  )
}

function MiniMetric({ icon: Icon, label, value, color }: { icon: any; label: string; value: string; color: string }) {
  const cm: Record<string, string> = {
    blue: 'bg-blue-50 text-blue-600', purple: 'bg-purple-50 text-purple-600',
    emerald: 'bg-emerald-50 text-emerald-600', amber: 'bg-amber-50 text-amber-600',
    orange: 'bg-orange-50 text-orange-600', red: 'bg-red-50 text-red-600',
    indigo: 'bg-indigo-50 text-indigo-600', gray: 'bg-gray-100 text-gray-500',
  }
  return (
    <div className="bg-white rounded-xl p-3 border border-gray-100">
      <div className="flex items-center gap-1.5 mb-1">
        <div className={`w-5 h-5 rounded-md flex items-center justify-center ${cm[color]}`}><Icon className="w-3 h-3" /></div>
        <span className="text-[10px] text-gray-400 uppercase">{label}</span>
      </div>
      <div className="text-sm font-bold text-gray-900">{value}</div>
    </div>
  )
}

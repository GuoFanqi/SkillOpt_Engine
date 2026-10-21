import { Link } from 'react-router-dom'
import { RefreshCw, Activity, TrendingUp, CheckCircle, Layers, Trash2, Clock, StopCircle, ChevronRight, Zap, ArrowRight, RotateCw, Square, CheckSquare } from 'lucide-react'
import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { fetchTrainingRuns, startTraining, deleteTraining, stopTraining, restartTraining } from '../services/api'
import { useAuth } from '../contexts/AuthContext'
import { TrainingRun } from '../types'
import NewTrainingModal, { NewTrainingConfig } from '../components/NewTrainingModal'
import { useWebSocket } from '../hooks/useWebSocket'
import { useToast } from '../components/Toast'
import { useConfirm } from '../components/ConfirmDialog'
import { DashboardSkeleton } from '../components/Loading'

// Memoize run names to prevent NewTrainingModal useEffect from resetting template selection
function useRunNames(runs: TrainingRun[]) {
  return useMemo(() => runs.map(r => r.name), [runs])
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  const diffHour = Math.floor(diffMs / 3600000)
  const diffDay = Math.floor(diffMs / 86400000)
  if (diffMin < 1) return '刚刚'
  if (diffMin < 60) return `${diffMin} 分钟前`
  if (diffHour < 24) return `${diffHour} 小时前`
  if (diffDay < 7) return `${diffDay} 天前`
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export default function Dashboard() {
  const { token } = useAuth()
  const [runs, setRuns] = useState<TrainingRun[]>([])
  const [loading, setLoading] = useState(true)
  const [showNewTrainingModal, setShowNewTrainingModal] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [refreshing, setRefreshing] = useState(false)
  const { messages } = useWebSocket()
  const { showToast } = useToast()
  const { confirm } = useConfirm()
  const existingNames = useRunNames(runs)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startTimeRef = useRef<Record<string, number>>({})

  // Ticker for live elapsed time & relative date
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => tick((n: number) => n + 1), 60_000)
    const fastTimer = runs.some((r) => r.status === 'training')
      ? setInterval(() => tick((n: number) => n + 1), 1000)
      : null
    return () => { clearInterval(timer); if (fastTimer) clearInterval(fastTimer) }
  }, [runs])

  // Elapsed time computation
  const now = Date.now()
  const displayElapsed: Record<string, string> = {}
  runs.forEach((run) => {
    if (run.status === 'training') {
      if (!startTimeRef.current[run.id]) {
        if (run.totalTime && run.totalTime !== '0s' && run.totalTime !== '0.0s') {
          const parts = run.totalTime.split(' ')
          let secs = 0
          for (const p of parts) {
            if (p.endsWith('s')) secs += parseInt(p)
            else if (p.endsWith('m')) secs += parseInt(p) * 60
            else if (p.endsWith('h')) secs += parseInt(p) * 3600
          }
          startTimeRef.current[run.id] = now - secs * 1000
        } else if (run.createdAt) {
          const createdMs = new Date(run.createdAt).getTime()
          startTimeRef.current[run.id] = !isNaN(createdMs) ? createdMs : now
        } else {
          startTimeRef.current[run.id] = now
        }
      }
      const start = startTimeRef.current[run.id]
      const elapsed = Math.floor((now - start) / 1000)
      if (elapsed < 60) displayElapsed[run.id] = `${elapsed}s`
      else if (elapsed < 3600) displayElapsed[run.id] = `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
      else displayElapsed[run.id] = `${Math.floor(elapsed / 3600)}h ${Math.floor((elapsed % 3600) / 60)}m`
    }
  })

  const loadData = useCallback(async () => {
    try {
      const runsData = await fetchTrainingRuns()
      setRuns(runsData)
    } catch (error) {
      console.error('Failed to load data:', error)
      setRuns([])
    }
  }, [token])

  useEffect(() => {
    setLoading(true)
    loadData().finally(() => setLoading(false))
  }, [loadData])

  // Real-time progress from WebSocket
  useEffect(() => {
    const lastMsg = messages[messages.length - 1]
    if (!lastMsg) return
    if (lastMsg.type === 'complete') {
      loadData() // Refresh immediately on completion
    }
    if (lastMsg.type === 'progress' && lastMsg.data && typeof lastMsg.data === 'object') {
      const { step, currentScore, bestScore } = lastMsg.data as { step: number; currentScore: number; bestScore: number }
      setRuns(prev => prev.map(r => {
        if (r.id === lastMsg.runId) {
          return {
            ...r,
            totalSteps: step,
            currentScore: currentScore,
            bestScore: bestScore,
            status: 'training',
          }
        }
        return r
      }))
    }
  }, [messages])

  // Auto-refresh when training
  useEffect(() => {
    const hasTraining = runs.some((r) => r.status === 'training')
    if (hasTraining) {
      if (!pollRef.current) pollRef.current = setInterval(loadData, 5000)
    } else {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
  }, [runs.map(r => r.status).join(','), loadData])

  // WebSocket refresh
  useEffect(() => {
    const lastMsg = messages[messages.length - 1]
    if (lastMsg?.type === 'complete') setTimeout(() => loadData(), 1000)
    if (lastMsg?.type === 'log' || lastMsg?.type === 'error') loadData()
  }, [messages, loadData])

  // ── Computed stats ────────────────────────────────────────
  // 过滤掉空壳任务（从未真正训练过）
  const activeRuns = useMemo(() => runs.filter(r => r.status !== 'empty'), [runs])
  const completedRuns = useMemo(() => activeRuns.filter(r => r.status === 'completed'), [activeRuns])
  const totalAccepts = useMemo(() => completedRuns.reduce((s, r) => s + r.accepts, 0), [completedRuns])
  const totalRejects = useMemo(() => completedRuns.reduce((s, r) => s + r.rejects, 0), [completedRuns])
  const avgScore = useMemo(() =>
    activeRuns.length > 0 ? Math.round(activeRuns.reduce((a, r) => a + Math.max(r.bestScore || r.currentScore, r.currentScore), 0) / activeRuns.length) : 0,
    [runs]
  )
  const maxScore = useMemo(() => activeRuns.length > 0 ? Math.max(...activeRuns.map(r => Math.max(r.bestScore || r.currentScore, r.currentScore))) : 0, [activeRuns])
  const totalStepsAll = useMemo(() => activeRuns.reduce((s, r) => s + r.totalSteps, 0), [activeRuns])

  // Bar chart data — each task is one bar
  const barData = useMemo(() => {
    return runs.map((r, i) => ({
      name: r.name.length > 12 ? r.name.slice(0, 11) + '…' : r.name,
      fullName: r.name,
      score: r.currentScore,
      status: r.status,
      steps: r.totalSteps,
      id: r.id,
      index: i,
    }))
  }, [runs])

  // 计算整体优化效果
  const overallImprovement = useMemo(() => {
    const validRuns = completedRuns.filter(r => r.initialScore > 0 && r.currentScore > 0)
    if (validRuns.length === 0) return { count: 0, avg: 0, max: 0 }
    
    const improvements = validRuns.map(r => r.currentScore - r.initialScore)
    const avg = Math.round(improvements.reduce((a, b) => a + b, 0) / improvements.length)
    const max = Math.max(...improvements)
    const improvedCount = improvements.filter(i => i > 0).length
    
    return { count: improvedCount, avg, max }
  }, [completedRuns])

  // Stats cards
  const stats = [
    {
      label: '总训练次数', value: activeRuns.length.toString(),
      subtext: `共 ${totalStepsAll} 步`,
      icon: Layers, color: 'blue',
    },
    {
      label: '平均提升', 
      value: overallImprovement.count > 0 
        ? `${overallImprovement.avg > 0 ? '+' : ''}${overallImprovement.avg}%`
        : '--',
      subtext: `${overallImprovement.count}/${completedRuns.length} 次优化成功`,
      icon: TrendingUp, 
      color: overallImprovement.avg > 0 ? 'green' : overallImprovement.avg < 0 ? 'red' : 'gray',
    },
    {
      label: '最大提升', 
      value: overallImprovement.max > 0 ? `+${overallImprovement.max}%` : '--',
      subtext: overallImprovement.count > 0 ? '最强优化效果' : '暂无优化数据',
      icon: Zap, 
      color: overallImprovement.max > 20 ? 'purple' : 'blue',
    },
    {
      label: '验证集最高分', 
      value: `${maxScore}%`,
      subtext: maxScore >= 99 ? '基线已满分' : `平均 ${avgScore}%`,
      icon: CheckCircle, 
      color: maxScore >= 99 ? 'green' : 'purple',
    },
  ]

  const handleNewTraining = async (config: NewTrainingConfig) => {
    try {
      const result = await startTraining(config)
      showToast('success', `训练已启动！\n运行ID: ${result.runId}`)
      loadData()
    } catch (error: any) {
      showToast('error', error?.message || '启动训练失败，请检查后端服务是否正常运行')
    }
  }

  const handleStop = async (runId: string, runName: string) => {
    const confirmed = await confirm({
      message: `确定要停止「${runName}」吗？当前训练进度将会丢失。`,
      confirmText: '确认停止',
      variant: 'warning',
    })
    if (!confirmed) return

    try {
      await stopTraining(runId)
      showToast('success', `已暂停「${runName}」`)
      // Update local state immediately so UI shows "已暂停" without waiting for poll
      setRuns(prev => prev.map(r => r.id === runId ? { ...r, status: 'stopped' as const } : r))
    } catch (error) {
      showToast('error', `停止失败: ${error}`)
    }
    loadData()
  }

  const handleRestart = async (runId: string, runName: string) => {
    try {
      showToast('info', `正在重新启动「${runName}」...`)
      await restartTraining(runId)
      showToast('success', `「${runName}」已重新启动`)
      loadData()
    } catch (error: any) {
      showToast('error', error?.message || `重新启动失败`)
    }
  }

  const handleDelete = async (runId: string, runName: string) => {
    await deleteTraining(runId)
    showToast('success', `已删除「${runName}」`)
    setSelectedIds(prev => { const next = new Set(prev); next.delete(runId); return next })
    loadData()
  }

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === activeRuns.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(activeRuns.map(r => r.id)))
    }
  }

  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return
    const count = selectedIds.size
    const confirmed = await confirm({
      message: `确定要删除选中的 ${count} 个训练任务吗？此操作不可撤销。`,
      confirmText: `确认删除 ${count} 项`,
      variant: 'danger',
    })
    if (!confirmed) return
    let success = 0
    let failed = 0
    for (const id of selectedIds) {
      try { await deleteTraining(id); success++ } catch { failed++ }
    }
    if (failed > 0) {
      showToast('warning', `删除完成：${success} 个成功，${failed} 个失败`)
    } else {
      showToast('success', `已删除 ${success} 个训练任务`)
    }
    setSelectedIds(new Set())
    loadData()
  }

  const getStatusBadge = (status: TrainingRun['status']) => {
    switch (status) {
      case 'completed': return <span className="badge bg-green-50 text-green-600 border border-green-100">已完成</span>
      case 'training': return <span className="badge bg-blue-50 text-blue-600 border border-blue-100">训练中</span>
      case 'failed': return <span className="badge bg-red-50 text-red-600 border border-red-100">失败</span>
      case 'pending': return <span className="badge bg-yellow-50 text-yellow-600 border border-yellow-100">等待中</span>
      case 'stopped': return <span className="badge bg-orange-50 text-orange-600 border border-orange-100">已暂停</span>
    }
  }

  const getStatusColor = (status: TrainingRun['status']) => {
    switch (status) {
      case 'completed': return 'bg-green-500'
      case 'training': return 'bg-blue-500 animate-pulse'
      case 'failed': return 'bg-red-500'
      case 'pending': return 'bg-yellow-500'
      case 'stopped': return 'bg-orange-500'
    }
  }

  if (loading) return <DashboardSkeleton />

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">仪表盘</h1>
          <p className="text-gray-500">管理您的训练任务和技能</p>
        </div>
        <div className="flex gap-3">
          <button onClick={() => setShowNewTrainingModal(true)} className="btn-primary flex items-center gap-2">
            新建训练
          </button>
          <button onClick={() => window.location.reload()} className="btn-secondary flex items-center gap-2">
            <RefreshCw className="w-4 h-4" />
            刷新
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-4 gap-5 mb-8">
        {stats.map((stat) => (
          <div key={stat.label} className={`rounded-2xl p-5 border border-gray-100 bg-white hover:shadow-md transition-all duration-200`}>
            <div className="flex items-center justify-between mb-3">
              <span className="text-gray-500 text-sm font-medium">{stat.label}</span>
              <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${
                stat.color === 'blue' ? 'bg-blue-50 text-blue-600' :
                stat.color === 'purple' ? 'bg-purple-50 text-purple-600' :
                stat.color === 'green' ? 'bg-emerald-50 text-emerald-600' :
                'bg-amber-50 text-amber-600'
              }`}>
                <stat.icon className="w-4.5 h-4.5" />
              </div>
            </div>
            <div className="text-2xl font-bold text-gray-900 tabular-nums">{stat.value}</div>
            <div className="text-xs mt-1.5 text-gray-400">{stat.subtext}</div>
          </div>
        ))}
      </div>

      {/* Training Achievement Panel - 展示 LoopSkill 优化效果 */}
      <div className="mb-8">
        {/* 关键洞察横条 */}
        {barData.length > 0 && (
          <div className="bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 rounded-2xl p-5 mb-6 text-white shadow-lg shadow-indigo-200/50">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 bg-white/15 rounded-xl flex items-center justify-center backdrop-blur-sm">
                  <Zap className="w-6 h-6 text-yellow-300" />
                </div>
                <div>
                  <p className="text-sm text-blue-100 font-medium">训练成果</p>
                  <p className="text-lg font-bold mt-0.5">
                    已完成 <span className="text-2xl">{completedRuns.length}</span> 次训练
                    {maxScore >= 99 ? ' · 基线已满分' : ` · 验证集最高 ${maxScore}%`}
                     · 
                    执行 <span className="text-2xl">{totalStepsAll}</span> 步
                  </p>
                </div>
              </div>
              <div className="hidden md:flex items-center gap-6 text-sm">
                <div className="text-center">
                  <div className="text-2xl font-bold tabular-nums">{totalAccepts}</div>
                  <div className="text-blue-200 text-xs">✅ 编辑接受</div>
                </div>
                <div className="w-px h-10 bg-white/20" />
                <div className="text-center">
                  <div className="text-2xl font-bold tabular-nums">{totalRejects}</div>
                  <div className="text-blue-200 text-xs">❌ 编辑拒绝</div>
                </div>
                <div className="w-px h-10 bg-white/20" />
                <div className="text-center">
                  <div className="text-2xl font-bold tabular-nums">
                    {totalAccepts + totalRejects > 0 ? Math.round(totalAccepts / (totalAccepts + totalRejects) * 100) : 0}%
                  </div>
                  <div className="text-blue-200 text-xs">Gate 通过率</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 标题 */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">训练成果一览</h3>
            <p className="text-xs text-gray-400 mt-0.5">每个任务的 Skill 优化前后对比</p>
          </div>
          <div className="flex items-center gap-3 text-xs text-gray-400">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500" /> 已完成</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" /> 训练中</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500" /> 失败</span>
          </div>
        </div>

        {barData.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-4 bg-gradient-to-b from-gray-50/80 to-white border-2 border-dashed border-gray-100 rounded-2xl">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-100 flex items-center justify-center">
              <Zap className="w-8 h-8 text-blue-300" />
            </div>
            <div className="text-center">
              <p className="text-gray-500 font-medium text-sm">还没有训练成果</p>
              <p className="text-gray-400 text-xs mt-1 max-w-xs">启动第一次训练，看训练如何自动把你的 Skill 从「勉强能用」优化到「表现优异」</p>
            </div>
            <button onClick={() => setShowNewTrainingModal(true)} className="btn-primary text-sm mt-1 flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5" /> 开始首次优化
            </button>
          </div>
        ) : (
          /* ──────── 任务卡片 ──────── */
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {activeRuns.map((run) => {
              const acceptRate = run.accepts + run.rejects > 0
                ? Math.round(run.accepts / (run.accepts + run.rejects) * 100) : 0
              // 优先展示测试集分数，无数据时降级到验证集
              const hasTestScores = run.testScore > 0 || run.baselineTestScore > 0
              const testInit = hasTestScores ? (run.baselineTestScore || run.testScore || 0) : run.initialScore
              const testFinal = hasTestScores ? (run.testScore || run.baselineTestScore || 0) : (run.bestScore > 0 ? run.bestScore : run.currentScore)
              const optimizedScore = hasTestScores ? testFinal : (run.bestScore > 0 ? run.bestScore : run.currentScore)
              const initialScore = hasTestScores ? testInit : run.initialScore
              const improved = optimizedScore > initialScore
              const degraded = optimizedScore < initialScore
              const delta = optimizedScore - initialScore
              const hadPeak = run.bestScore > 0 && run.bestScore > run.currentScore && run.currentScore > 0
              const hasInitialScore = initialScore > 0
              const isPending = run.status === 'pending' || run.status === 'training'
              const isFailed = run.status === 'failed' || run.status === 'empty'
              const isStopped = run.status === 'stopped'
              const showErrorState = isFailed && !hasInitialScore && optimizedScore === 0
              const isEarlyStop = run.initialScore === 100 && run.currentScore === 100 && run.totalSteps === 0

              return (
                <Link
                  key={run.id}
                  to={`/training/${encodeURIComponent(run.id)}`}
                  className={`group relative rounded-xl p-5 border transition-all duration-200 hover:shadow-lg hover:-translate-y-0.5 ${
                    run.status === 'completed' ? 'bg-white border-gray-100 hover:border-blue-200' :
                    run.status === 'training' ? 'bg-blue-50/50 border-blue-100 hover:border-blue-300' :
                    run.status === 'failed' ? 'bg-red-50/30 border-red-100 hover:border-red-200' :
                    run.status === 'stopped' ? 'bg-orange-50/30 border-orange-100 hover:border-orange-200' :
                    'bg-gray-50 border-gray-100 hover:border-gray-200'
                  }`}
                >
                  {/* 状态 + 名称 */}
                  <div className="flex items-center gap-2 mb-4">
                    <div className={`w-2 h-2 rounded-full shrink-0 ${getStatusColor(run.status)} ${run.status === 'training' ? 'animate-pulse' : ''}`} />
                    <span className="text-sm font-semibold text-gray-800 truncate">
                      {run.name.replace(/loopskill_\w+_/, '').replace(/_\d{8}_\d{6}$/, '')}
                    </span>
                    {getStatusBadge(run.status)}
                  </div>

                  {/* ── 核心：优化效果对比 ── */}
                  {showErrorState ? (
                    <div className="mb-4 text-center py-2">
                      <div className="text-lg font-bold text-red-500">训练失败</div>
                      <div className="text-xs text-gray-400 mt-1 line-clamp-2">{run.errorMessage || '未知错误'}</div>
                    </div>
                  ) : isPending ? (
                    <div className="mb-4">
                      <p className="text-sm text-gray-400 font-medium">等待开始...</p>
                      <div className="mt-3 w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
                        <div className="h-full bg-gray-200 rounded-full animate-pulse" style={{ width: '30%' }} />
                      </div>
                    </div>
                  ) : isStopped ? (
                    <div className="mb-4">
                      <div className="flex items-center justify-center gap-2 mb-2">
                        <StopCircle className="w-4 h-4 text-orange-500" />
                        <p className="text-sm font-medium text-orange-600">已暂停</p>
                      </div>
                      <p className="text-xs text-gray-400 text-center">{run.errorMessage || '训练已手动停止'}</p>
                      {hasInitialScore ? (
                        <div className="mt-3 text-center">
                          <span className="text-lg font-bold text-gray-500 tabular-nums">{optimizedScore}%</span>
                          <span className="text-[10px] text-gray-400 ml-1">（停止时分数）</span>
                        </div>
                      ) : (
                        <div className="mt-3 w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
                          <div className="h-full bg-orange-200 rounded-full" style={{ width: '40%' }} />
                        </div>
                      )}
                    </div>
                  ) : isEarlyStop ? (
                    <div className="mb-4 text-center py-2">
                      <div className="text-sm font-medium text-emerald-600 mb-1">基线已满分</div>
                      <div className="text-3xl font-bold text-emerald-600">100%</div>
                      <div className="text-[10px] text-gray-400 mt-1">无需优化，技能已完美</div>
                    </div>
                  ) : hasInitialScore ? (
                    <div className="mb-4">
                      {/* 大号对比 */}
                      <div className="flex items-center justify-center gap-3 mb-3">
                        <div className="text-center">
                          <div className="text-[11px] text-gray-400 mb-0.5">优化前</div>
                          <div className="text-2xl font-bold text-gray-400 tabular-nums">{initialScore}%</div>
                        </div>
                        <div className="flex flex-col items-center">
                          <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                            improved ? 'bg-emerald-100 text-emerald-600' :
                            degraded ? 'bg-red-100 text-red-600' :
                            hadPeak ? 'bg-amber-100 text-amber-600' :
                            'bg-gray-100 text-gray-500'
                          }`}>
                            {improved ? '↑' : degraded ? '↓' : hadPeak ? '↗' : '→'}
                          </div>
                          <span className={`text-xs font-bold mt-0.5 tabular-nums ${
                            improved ? 'text-emerald-600' : degraded ? 'text-red-500' : hadPeak ? 'text-amber-600' : 'text-gray-400'
                          }`}>
                            {delta !== 0 ? `${improved ? '+' : ''}${delta}%` : hadPeak ? `曾达${run.bestScore}%` : '持平'}
                          </span>
                          {/* 有接受但无提升的提示 */}
                          {(() => {
                            const isEarlyStop = run.initialScore === 100 && run.currentScore === 100 && run.totalSteps === 0
                            const hasSlowUpdates = (run.slowUpdates || 0) > 0
                            if (isEarlyStop) return <span className="text-[9px] text-emerald-500 mt-0.5">基线满分 · 无需优化</span>
                            if (hasSlowUpdates && run.accepts === run.slowUpdates) return <span className="text-[9px] text-violet-500 mt-0.5">{run.slowUpdates}次慢更新·长期优化</span>
                            if (!improved && !degraded && !hadPeak && run.accepts > 0) return <span className="text-[9px] text-gray-400 mt-0.5">{run.accepts}次优化·未提升</span>
                            return null
                          })()}
                        </div>
                        <div className="text-center">
                          <div className="text-[11px] text-gray-400 mb-0.5">优化后</div>
                          <div className={`text-2xl font-bold tabular-nums ${
                            improved ? 'text-emerald-600' : degraded ? 'text-red-500' : 'text-gray-700'
                          }`}>{optimizedScore}%</div>
                        </div>
                      </div>
                      {/* 进度条 */}
                      <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
                        <div className={`h-full rounded-full transition-all duration-700 ${
                          improved ? 'bg-gradient-to-r from-emerald-400 to-emerald-500' :
                          degraded ? 'bg-gradient-to-r from-red-400 to-red-500' :
                          hadPeak ? 'bg-gradient-to-r from-amber-300 to-amber-400' :
                          'bg-gradient-to-r from-gray-300 to-gray-400'
                        }`} style={{ width: `${Math.max(hadPeak ? run.bestScore : optimizedScore, 2)}%` }} />
                        {/* 如果曾有峰值高于当前，显示峰值标记 */}
                        {hadPeak && (
                          <div className="relative w-full h-0">
                            <div
                              className="absolute top-[-5px] w-0.5 h-[12px] bg-amber-500 rounded-full"
                              style={{ left: `${run.bestScore}%` }}
                              title={`历史最高: ${run.bestScore}%`}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="mb-4 text-center">
                      <div className={`text-3xl font-bold tabular-nums ${optimizedScore >= 80 ? 'text-emerald-600' : optimizedScore >= 50 ? 'text-blue-600' : 'text-gray-700'}`}>{optimizedScore}%</div>
                      <div className="text-[11px] text-gray-400">
                        {hasTestScores ? '测试集准确率' : '验证集准确率'}
                        {!hasTestScores && run.currentScore > 0 && (
                          <span className="text-gray-400">（需开启 eval_test）</span>
                        )}
                      </div>
                    </div>
                  )}

                  {/* 训练中断但有有效数据 → 显示警告提示 */}
                  {isFailed && !showErrorState && run.errorMessage && (
                    <div className="mb-3 px-2.5 py-1.5 bg-amber-50 border border-amber-100 rounded-lg">
                      <p className="text-[10px] text-amber-700 leading-tight">{run.errorMessage}</p>
                    </div>
                  )}

                  {/* Accept / Reject 简化为比例条 */}
                  <div className="flex items-center gap-2 mb-3">
                    <div className="flex-1 bg-gray-100 rounded-full h-1.5 overflow-hidden flex">
                      {run.accepts + run.rejects > 0 ? (
                        <>
                          <div className="h-full bg-emerald-400 rounded-l-full transition-all"
                            style={{ width: `${acceptRate}%` }} />
                          <div className="h-full bg-red-300 rounded-r-full transition-all"
                            style={{ width: `${100 - acceptRate}%` }} />
                        </>
                      ) : (
                        <div className="h-full bg-gray-200 w-full" />
                      )}
                    </div>
                    <span className="text-[10px] text-gray-400 tabular-nums whitespace-nowrap">
                      {run.accepts}✓ {run.rejects}✗
                    </span>
                  </div>

                  {/* 底部信息 */}
                  <div className="flex items-center justify-between text-[11px] text-gray-400">
                    <span>{run.totalSteps}步</span>
                    <span>{run.model?.replace(/^gpt-/, '') || '--'}</span>
                    <ChevronRight className="w-3.5 h-3.5 text-gray-300 group-hover:text-blue-400 transition-colors" />
                  </div>

                  {/* 训练中：实时进度条 */}
                  {run.status === 'training' && run.totalSteps > 0 && (
                    <div className="mt-2">
                      <div className="flex justify-between text-[10px] text-gray-500 mb-1">
                        <span>训练中 · 第 {run.totalSteps} 步</span>
                        <span>{run.currentScore}%</span>
                      </div>
                      <div className="w-full bg-gray-100 rounded-full h-1 overflow-hidden">
                        <div className="h-full bg-blue-400 rounded-full animate-pulse" style={{ width: '40%' }} />
                      </div>
                    </div>
                  )}

                  {/* 训练中脉冲 */}
                  {run.status === 'training' && (
                    <div className="absolute inset-0 rounded-xl border-2 border-blue-200 pointer-events-none opacity-60">
                      <div className="absolute inset-0 rounded-xl bg-gradient-to-r from-transparent via-blue-100/30 to-transparent animate-[shimmer_2s_infinite]" />
                    </div>
                  )}
                </Link>
              )
            })}
          </div>
        )}

        <style>{`
          @keyframes shimmer {
            0% { transform: translateX(-100%); }
            100% { transform: translateX(100%); }
          }
        `}</style>
      </div>

      {/* Recent Training List */}
      <div className="mb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h3 className="text-lg font-semibold text-gray-900">最近训练</h3>
            <button
              onClick={toggleSelectAll}
              className="inline-flex items-center gap-1.5 text-xs text-gray-400 hover:text-blue-600 transition-colors"
            >
              {selectedIds.size === activeRuns.length && activeRuns.length > 0
                ? <CheckSquare className="w-4 h-4 text-blue-500" />
                : <Square className="w-4 h-4" />}
              全选
            </button>
            {selectedIds.size > 0 && (
              <button
                onClick={handleBatchDelete}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 transition-all"
              >
                <Trash2 className="w-3 h-3" /> 删除选中 ({selectedIds.size})
              </button>
            )}
          </div>
          <Link to="/training" className="text-sm text-blue-600 hover:text-blue-700">查看全部 →</Link>
        </div>
      </div>

      <div className="space-y-4">
        {activeRuns.map((run) => (
          <div key={run.id} className="card bg-white border border-gray-100 hover:border-gray-200 hover:shadow-md transition-all duration-200 rounded-2xl p-5 group relative">
            <div className="flex items-start justify-between">
              {/* 复选框 */}
              <button
                onClick={(e) => { e.preventDefault(); toggleSelect(run.id) }}
                className="mr-3 mt-0.5 shrink-0 text-gray-300 hover:text-blue-500 transition-colors"
              >
                {selectedIds.has(run.id)
                  ? <CheckSquare className="w-4 h-4 text-blue-500" />
                  : <Square className="w-4 h-4" />}
              </button>
              {/* 左侧：可点击跳转详情 */}
              <Link to={`/training/${encodeURIComponent(run.id)}`} className="flex-1 min-w-0 block">
                <div className="flex items-center gap-3 mb-3">
                  <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${getStatusColor(run.status)}`}></div>
                  <span className="font-semibold text-gray-900 truncate text-sm">{run.name}</span>
                  {getStatusBadge(run.status)}
                </div>
                <div className="flex items-center gap-5 text-sm text-gray-400 flex-wrap">
                  {/* 分数对比：初始 → 优化后 */}
                  {(() => {
                    const hasTest = run.testScore > 0 || run.baselineTestScore > 0
                    const opt = hasTest ? (run.testScore || run.baselineTestScore || 0) : (run.bestScore > 0 ? run.bestScore : run.currentScore)
                    const init = hasTest ? (run.baselineTestScore || run.testScore || 0) : (run.initialScore || 0)
                    const listHadPeak = run.bestScore > 0 && run.bestScore > run.currentScore && run.currentScore > 0
                    return (
                    <span className="flex items-center gap-2">
                      <span className="flex items-center gap-1">
                        <span className="text-xs text-gray-500">{hasTest ? '初始(测试)' : '初始(验证)'}</span>
                        <span className="font-semibold text-gray-600 tabular-nums">{init}%</span>
                      </span>
                      <ArrowRight className="w-4 h-4 text-gray-300" />
                      <span className="flex items-center gap-1">
                        <span className="text-xs text-gray-500">{hasTest ? '最终(测试)' : '最终(验证)'}</span>
                        <span className={`font-semibold tabular-nums ${opt > init ? 'text-emerald-600' : opt < init ? 'text-red-500' : listHadPeak ? 'text-amber-600' : 'text-gray-700'}`}>{opt}%</span>
                      </span>
                      {/* 提升幅度 */}
                      {init > 0 && opt !== init && (
                        <span className={`flex items-center gap-0.5 px-2 py-0.5 rounded-full text-xs font-semibold ${opt > init ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-600'}`}>
                          {opt > init ? '+' : ''}{opt - init}%
                        </span>
                      )}
                      {/* 曾达峰值 */}
                      {listHadPeak && init === opt && (
                        <span className="flex items-center gap-0.5 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
                          最高 {run.bestScore}%
                        </span>
                      )}
                      {/* 有优化但无净提升 — 排除基线满分 / 慢更新 */}
                      {(() => {
                        const isEarlyStop = run.initialScore === 100 && run.currentScore === 100 && run.totalSteps === 0
                        const hasSlowUpdates = (run.slowUpdates || 0) > 0
                        if (isEarlyStop) return <span className="text-[10px] text-emerald-500">基线满分</span>
                        if (hasSlowUpdates && run.accepts === run.slowUpdates) return <span className="text-[10px] text-violet-500">{run.slowUpdates}次慢更新</span>
                        if (!listHadPeak && init > 0 && opt === init && run.accepts > 0) return <span className="text-[10px] text-gray-400">{run.accepts}次优化·无变化</span>
                        return null
                      })()}
                    </span>
                    )
                  })()}
                  <span className="flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5 text-gray-300" />
                    步骤：<span className="font-medium text-gray-700">{run.totalSteps}</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Activity className="w-3.5 h-3.5 text-gray-300" />
                    模型：<span className="font-medium text-gray-700">{run.model}</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-gray-300" />
                    耗时：<span className="font-medium text-gray-700">{run.status === 'training' ? (displayElapsed[run.id] || '--') : run.totalTime}</span>
                  </span>
                  {run.createdAt && (
                    <span className="text-xs text-gray-300 ml-auto">{formatDate(run.createdAt)}</span>
                  )}
                </div>
                {run.status === 'training' && (() => {
                  const steps = run.totalSteps || 0
                  // @ts-ignore - config may not be in type but exists at runtime
                  const total = (run as any).config?.total_steps || (run.epochs || 2) * 2
                  const pct = total > 0 ? Math.min(95, (steps / total) * 100) : 5
                  return (
                  <div className="mt-4 bg-gradient-to-r from-blue-50/80 to-indigo-50/60 rounded-xl p-3.5 border border-blue-100/60">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <div className="relative flex h-2 w-2">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-500 opacity-75" />
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-600" />
                        </div>
                        <span className="text-xs font-medium text-blue-700">{steps > 0 ? '正在训练' : '准备中'}</span>
                      </div>
                      <span className={`text-xs font-semibold tabular-nums ${steps > 0 ? 'text-blue-700' : 'text-gray-400'}`}>
                        {steps > 0 ? `${Math.round(pct)}% · ${steps}/${total} 步` : '初始化中...'}
                      </span>
                    </div>
                    <div className="w-full bg-white/70 rounded-lg h-2.5 overflow-hidden shadow-inner ring-1 ring-black/4">
                      {steps > 0 ? (
                        <div
                          className="h-2.5 rounded-lg transition-all duration-700 ease-out relative"
                          style={{ width: `${pct}%`, background: `linear-gradient(90deg, #3B82F6, #6366F1)` }}
                        >
                          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/40 to-transparent animate-[shimmer_1.8s_infinite]" />
                        </div>
                      ) : (
                        <div className="h-2.5 w-[45%] rounded-lg relative overflow-hidden">
                          <div
                            className="absolute inset-0 -translate-x-full animate-[indeterminate_1.4s_ease-in-out_infinite]"
                            style={{ background: `linear-gradient(90deg, transparent, rgba(99,102,241,0.5), transparent)` }}
                          />
                        </div>
                      )}
                    </div>
                    <style>{`
                      @keyframes shimmer {
                        0% { transform: translateX(-100%); }
                        100% { transform: translateX(100%); }
                      }
                      @keyframes indeterminate {
                        0% { transform: translateX(-150%); }
                        100% { transform: translateX(250%); }
                      }
                    `}</style>
                  </div>
                  )
                })()}
                {run.status === 'failed' && run.errorMessage && (
                  <div className="mt-3 p-3 bg-red-50 border border-red-100 rounded-xl">
                    <p className="text-xs text-red-600">{run.errorMessage}</p>
                  </div>
                )}
              </Link>
              {/* 右侧：操作按钮 */}
              <div className="flex items-center gap-2 ml-4 shrink-0 self-center">
                <Link
                  to={`/training/${encodeURIComponent(run.id)}`}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-50 border border-gray-200 rounded-lg hover:bg-white hover:border-gray-300 hover:text-gray-900 transition-all"
                >
                  详情 <ChevronRight className="w-3 h-3" />
                </Link>
                {run.status === 'training' && (
                  <button
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      handleStop(run.id, run.name)
                    }}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-amber-600 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 hover:border-amber-300 transition-all"
                  >
                    <StopCircle className="w-3.5 h-3.5" /> 停止
                  </button>
                )}
                {run.status === 'stopped' && (
                  <span className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-orange-500 bg-orange-50 border border-orange-200 rounded-lg">
                    <StopCircle className="w-3.5 h-3.5" /> 已暂停
                  </span>
                )}
                {(run.status !== 'training') && (
                  <button
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      handleRestart(run.id, run.name)
                    }}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-blue-600 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 hover:border-blue-300 transition-all"
                  >
                    <RotateCw className="w-3.5 h-3.5" /> 重新启动
                  </button>
                )}
                <button
                  onClick={async (e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    const ok = await confirm({
                      message: `确定要删除「${run.name}」吗？此操作不可撤销。`,
                      confirmText: '确认删除',
                      variant: 'danger',
                    })
                    if (ok) handleDelete(run.id, run.name)
                  }}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 hover:border-red-300 transition-all"
                >
                  <Trash2 className="w-3.5 h-3.5" /> 删除
                </button>
              </div>
            </div>
          </div>
        ))}

        {activeRuns.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-100 flex items-center justify-center">
              <Layers className="w-8 h-8 text-blue-300" />
            </div>
            <div className="text-center">
              <p className="text-gray-400 font-medium">还没有训练任务</p>
              <p className="text-gray-300 text-xs mt-1">创建你的第一个训练，让 AI 帮你自动优化 Skill</p>
            </div>
            <button onClick={() => setShowNewTrainingModal(true)} className="btn-primary mt-1">✨ 新建训练</button>
          </div>
        )}
      </div>

      <NewTrainingModal
        isOpen={showNewTrainingModal}
        onClose={() => setShowNewTrainingModal(false)}
        onSubmit={handleNewTraining}
        existingNames={existingNames}
      />
    </div>
  )
}

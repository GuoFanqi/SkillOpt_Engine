import { Link, useSearchParams } from 'react-router-dom'
import { RefreshCw, TrendingUp, CheckCircle, Clock, XCircle, Layers, Download, GitCompare, StopCircle, Trash2, Loader2, X } from 'lucide-react'
import { useEffect, useState, useCallback, useRef } from 'react'
import { fetchTrainingRuns, deleteTraining, stopTraining, fetchSkillContent } from '../services/api'
import { useAuth } from '../contexts/AuthContext'
import { TrainingRun } from '../types'
import { useToast } from '../components/Toast'
import { useConfirm } from '../components/ConfirmDialog'
import { ListSkeleton } from '../components/Loading'
import { useWebSocket } from '../hooks/useWebSocket'
import { applyRunState, mergeTrainingRuns, needsRunRefresh, runStateLabel } from '../lib/runState'

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

export default function TrainingList() {
  const { token } = useAuth()
  const [runs, setRuns] = useState<TrainingRun[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [downloading, setDownloading] = useState<Record<string, boolean>>({})
  const { showToast } = useToast()
  const { confirm } = useConfirm()
  const [searchParams] = useSearchParams()
  const { states, connectionVersion } = useWebSocket()
  const statesRef = useRef(states)
  statesRef.current = states
  const requestRef = useRef<AbortController | null>(null)

  // Read search query from URL param (set by global search in Layout)
  useEffect(() => {
    const q = searchParams.get('search')
    if (q) setSearch(q)
  }, [searchParams])

  const loadData = useCallback(async () => {
    if (requestRef.current) return
    const controller = new AbortController()
    requestRef.current = controller
    try {
      const data = await fetchTrainingRuns(controller.signal)
      if (!controller.signal.aborted) setRuns(previous => mergeTrainingRuns(previous, data, statesRef.current))
    } catch (error) {
      if (!controller.signal.aborted) showToast('error', error instanceof Error ? error.message : '读取训练列表失败')
    } finally {
      if (requestRef.current === controller) requestRef.current = null
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [token, showToast])

  const handleStop = async (runId: string, runName: string) => {
    await stopTraining(runId)
    showToast('success', `已停止「${runName}」`)
    loadData()
  }

  const handleDelete = async (runId: string, runName: string) => {
    try {
      await deleteTraining(runId)
      showToast('success', `已删除「${runName}」`)
      loadData()
    } catch (err: any) {
      showToast('error', err.message || '删除失败')
    }
  }

  const handleDownload = async (runId: string, runName: string) => {
    setDownloading(prev => ({ ...prev, [runId]: true }))
    try {
      const content = await fetchSkillContent(runId, 'best')
      const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${runName.replace(/[\/\\:*?"<>|]/g, '_')}_best_skill.md`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      showToast('success', 'Skill 已下载')
    } catch {
      showToast('error', '下载失败，请检查网络连接')
    } finally {
      setDownloading(prev => ({ ...prev, [runId]: false }))
    }
  }

  useEffect(() => {
    void loadData()
    return () => { requestRef.current?.abort(); requestRef.current = null }
  }, [loadData, connectionVersion])

  useEffect(() => {
    setRuns(previous => previous.map(run => applyRunState(run, states[run.id])))
  }, [states])

  const shouldRefresh = runs.some(needsRunRefresh)
  useEffect(() => {
    if (!shouldRefresh) return
    const interval = setInterval(loadData, 3000)
    return () => clearInterval(interval)
  }, [shouldRefresh, loadData])

  const filtered = runs.filter(r =>
    !search || r.name.toLowerCase().includes(search.toLowerCase())
  )

  const getStatusBadge = (run: TrainingRun) => {
    if (run.state) return <span className="badge bg-blue-50 text-blue-700">{runStateLabel(run.state)}</span>
    switch (run.status) {
      case 'completed': return <span className="badge bg-green-50 text-green-600 border border-green-100">已完成</span>
      case 'training': return <span className="badge bg-blue-50 text-blue-600 border border-blue-100">训练中</span>
      case 'failed': return <span className="badge bg-red-50 text-red-600 border border-red-100">失败</span>
      case 'pending': return <span className="badge bg-yellow-50 text-yellow-600 border border-yellow-100">等待中</span>
    }
  }

  const getStatusIcon = (status: TrainingRun['status']) => {
    switch (status) {
      case 'completed': return <CheckCircle className="w-5 h-5 text-green-500" />
      case 'training': return <Clock className="w-5 h-5 text-blue-500" />
      case 'failed': return <XCircle className="w-5 h-5 text-red-500" />
      case 'pending': return <Clock className="w-5 h-5 text-yellow-500" />
    }
  }

  if (loading) return <ListSkeleton rows={5} />

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">所有训练</h1>
          <p className="text-gray-500">共 {runs.length} 个训练任务</p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={loadData} className="btn-secondary flex items-center gap-2">
            <RefreshCw className="w-4 h-4" />
            刷新
          </button>
        </div>
      </div>

      {/* Search indicator when filtering by URL param */}
      {search && (
        <div className="mb-4 flex items-center gap-2">
          <span className="text-xs text-gray-500">搜索：</span>
          <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-blue-50 text-blue-700 text-xs font-medium rounded-lg">
            "{search}"
            <button onClick={() => setSearch('')} className="hover:text-blue-900">
              <X className="w-3 h-3" />
            </button>
          </span>
          <span className="text-xs text-gray-400">— {filtered.length} 个结果</span>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 gap-4">
          <Layers className="w-12 h-12 text-gray-300" />
          <p className="text-gray-500">{search ? '没有匹配的训练任务' : '暂无训练任务'}</p>
          {!search && (
            <Link to="/" className="btn-primary">返回仪表盘新建训练</Link>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((run) => (
            <div
              key={run.id}
              className="card bg-gray-50 rounded-2xl p-5 card-hover"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4 flex-1">
                  {getStatusIcon(run.status)}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-2">
                      <Link
                        to={`/training/${encodeURIComponent(run.id)}`}
                        className="font-medium text-gray-900 hover:text-blue-600 truncate"
                      >
                        {run.name}
                      </Link>
                      {getStatusBadge(run)}
                    </div>
                    <div className="flex items-center gap-6 text-sm text-gray-500 flex-wrap">
                      <span className="flex items-center gap-1">
                        <TrendingUp className="w-3.5 h-3.5" />
                        验证集分数：<span className="font-medium text-gray-900">{run.currentScore}%</span>
                      </span>
                      <span>步骤：<span className="font-medium text-gray-900">{run.totalSteps}</span></span>
                      <span>接受率：<span className="font-medium text-gray-900">{run.acceptRate}%</span></span>
                      <span>模型：<span className="font-medium text-gray-900">{run.model}</span></span>
                      <span>耗时：<span className="font-medium text-gray-900">{run.totalTime}</span></span>
                      {run.createdAt && (
                        <span className="text-xs text-gray-400">{formatDate(run.createdAt)}</span>
                      )}
                    </div>
                    {run.status === 'failed' && run.errorMessage && (
                      <div className="mt-3 p-2 bg-red-50 border border-red-100 rounded-lg">
                        <p className="text-xs text-red-600 truncate">{run.errorMessage}</p>
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 ml-4">
                  <Link
                    to={`/training/${encodeURIComponent(run.id)}`}
                    className="btn-secondary text-sm"
                  >
                    详情
                  </Link>
                  <Link
                    to={`/skill/${encodeURIComponent(run.id)}`}
                    className="btn-secondary text-sm"
                  >
                    技能
                  </Link>
                  <Link
                    to={`/compare?run=${encodeURIComponent(run.id)}`}
                    className="btn-secondary text-sm flex items-center gap-1"
                  >
                    <GitCompare className="w-3.5 h-3.5" />
                    对比
                  </Link>
                  {run.status === 'completed' && (
                    <button
                      onClick={() => handleDownload(run.id, run.name)}
                      disabled={downloading[run.id]}
                      className="btn-secondary text-sm flex items-center gap-1"
                      title="下载最佳 Skill"
                    >
                      {downloading[run.id] ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Download className="w-3.5 h-3.5" />
                      )}
                    </button>
                  )}
                  {run.status === 'training' && (
                    <button
                      onClick={() => handleStop(run.id, run.name)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-amber-600 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 hover:border-amber-300 transition-all"
                    >
                      <StopCircle className="w-3.5 h-3.5" /> 停止
                    </button>
                  )}
                  <button
                    onClick={async () => {
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
        </div>
      )}
    </div>
  )
}

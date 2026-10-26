import { useParams, Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, Download, Settings, RefreshCw, RotateCw, X, CheckCircle, XCircle, FileDiff, BarChart3, Code, MessageSquare, ChevronRight, ChevronDown, Loader2, Sparkles } from 'lucide-react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine, Area } from 'recharts'
import { useEffect, useState, useMemo, useRef, useCallback } from 'react'
import { diffArrays } from 'diff'
import ReactMarkdown from 'react-markdown'
import { useToast } from '../components/Toast'
import { useConfirm } from '../components/ConfirmDialog'
import {
  fetchTrainingRun,
  fetchStepHistory,
  fetchChartData,
  fetchTrainingConfig,
  fetchTrainingData,
  fetchSkillVersions,
  fetchSkillContent,
  fetchCandidateSkill,
  fetchTrainingRuns,
  fetchStepRecord,
  fetchRolloutResults,
  fetchSelectionResults,
  fetchStepPatches,
  restartTraining,
  fetchTrainingLogs,
  fetchEvalSummary,
  fetchEvalDetails,
  generateAISummaryStream,
  askAIChat,
  readAIStream,
} from '../services/api'
import type { EvalSummary, EvalDetail } from '../services/api'
import { TrainingRun, StepHistory, ChartDataPoint, SkillVersion, TrainingData, RolloutResult, MergedPatch } from '../types'
import PipelineStages from '../components/PipelineStages'
import { useWebSocket } from '../hooks/useWebSocket'
import { DetailSkeleton } from '../components/Loading'
import { applyRunState, mergeTrainingRun, needsRunRefresh, runStateLabel } from '../lib/runState'

const tabs = ['概览', '日志', '历史', '步骤', '评估', '数据', '技能']

export default function TrainingDetail() {
  const { id } = useParams<{ id?: string }>()
  const navigate = useNavigate()
  const { showToast } = useToast()
  const { confirm } = useConfirm()
  const [run, setRun] = useState<TrainingRun | null>(null)
  const [history, setHistory] = useState<StepHistory[]>([])
  const [chartData, setChartData] = useState<ChartDataPoint[]>([])
  const [loadError, setLoadError] = useState('')
  const [activeTab, setActiveTab] = useState('概览')
  const [loading, setLoading] = useState(true)
  const [diffModalStep, setDiffModalStep] = useState<StepHistory | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  // 任务列表（用于选择器）
  const [allRuns, setAllRuns] = useState<TrainingRun[]>([])

  // WebSocket 实时更新
  const { messages, states, connectionVersion } = useWebSocket()
  const statesRef = useRef(states)
  statesRef.current = states
  const requestRef = useRef<AbortController | null>(null)
  const pendingRef = useRef<Promise<void> | null>(null)
  const stateRequestRef = useRef<AbortController | null>(null)
  const refreshQueued = useRef(false)
  const seenLogId = useRef(0)
  const lastDetailState = useRef('')
  const evalRequestRef = useRef<AbortController | null>(null)
  const streamRequests = useRef(new Set<AbortController>())
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const logEndRef = useRef<HTMLDivElement>(null)
  const [consoleLines, setConsoleLines] = useState<Array<{ text: string; time: string; type: 'stdout' | 'stderr' }>>([])

  // AI Chat
  const [chatMessages, setChatMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([])
  const [chatInput, setChatInput] = useState('')
  const [chatStreaming, setChatStreaming] = useState(false)
  const [showChat, setShowChat] = useState(false)

  const handleChatSubmit = useCallback(async () => {
    if (!id || !chatInput.trim() || chatStreaming) return
    const question = chatInput.trim()
    setChatInput('')
    setShowChat(true)
    setChatMessages(prev => [...prev, { role: 'user', content: question }])
    setChatStreaming(true)
    const controller = new AbortController()
    streamRequests.current.add(controller)
    try {
      const response = await askAIChat(decodeURIComponent(id), question, controller.signal)
      await readAIStream(response, text => {
        setChatMessages(previous => {
          const last = previous[previous.length - 1]
          return last?.role === 'assistant'
            ? [...previous.slice(0, -1), { role: 'assistant', content: text }]
            : [...previous, { role: 'assistant', content: text }]
        })
      }, controller.signal)
    } catch (error) {
      if (!controller.signal.aborted) showToast('error', error instanceof Error ? error.message : '提问失败')
    } finally {
      streamRequests.current.delete(controller)
      if (!controller.signal.aborted) setChatStreaming(false)
    }
  }, [id, chatInput, chatStreaming, showToast])

  // AI Summary streaming
  const [streamingSummary, setStreamingSummary] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)

  const startStreamSummary = useCallback(async () => {
    if (!id || isStreaming) return
    setIsStreaming(true)
    setStreamingSummary('')
    const controller = new AbortController()
    streamRequests.current.add(controller)
    try {
      const response = await generateAISummaryStream(decodeURIComponent(id), controller.signal)
      const summary = await readAIStream(response, setStreamingSummary, controller.signal)
      if (!controller.signal.aborted) setRun(previous => previous ? { ...previous, aiSummary: summary } : previous)
    } catch (error) {
      if (!controller.signal.aborted) setStreamingSummary(error instanceof Error ? error.message : '生成总结失败')
    } finally {
      streamRequests.current.delete(controller)
      if (!controller.signal.aborted) setIsStreaming(false)
    }
  }, [id, isStreaming])
  useEffect(() => {
    setConsoleLines([])
    if (!id) return
    const controller = new AbortController()
    fetchTrainingLogs(decodeURIComponent(id), 500, controller.signal).then(logs => {
      if (controller.signal.aborted) return
      setConsoleLines(previous => [...logs.map(log => ({
        text: log.text,
        time: new Date(log.created_at).toLocaleTimeString('zh-CN', { hour12: false }),
        type: log.type,
      })), ...previous].slice(-500))
    }).catch(() => {})
    return () => controller.abort()
  }, [id])

  // Evaluation data
  const [evalSummary, setEvalSummary] = useState<EvalSummary[]>([])
  const [evalDetails, setEvalDetails] = useState<EvalDetail[]>([])
  const [selectedEvalStep, setSelectedEvalStep] = useState<number>(0)
  const [selectedEvalPhase, setSelectedEvalPhase] = useState<string>('')
  const [expandedEvalId, setExpandedEvalId] = useState<number | null>(null)

  const loadEvalDetails = (step: number, phase: string) => {
    if (!id) return
    evalRequestRef.current?.abort()
    const controller = new AbortController()
    evalRequestRef.current = controller
    setSelectedEvalStep(step)
    setSelectedEvalPhase(phase)
    setEvalDetails([])
    fetchEvalDetails(decodeURIComponent(id), step, phase || undefined, controller.signal)
      .then(details => { if (!controller.signal.aborted) setEvalDetails(details) })
      .catch(() => {})
  }

  const loadData = useCallback((runId?: string, silent = false): Promise<void> => {
    const targetId = runId || id
    if (!targetId) { setLoading(false); return Promise.resolve() }
    if (pendingRef.current) {
      refreshQueued.current = true
      return pendingRef.current
    }
    if (!silent) setLoading(true)
    const controller = new AbortController()
    requestRef.current = controller
    const decodedId = decodeURIComponent(targetId)
    const pending = Promise.all([
      fetchTrainingRun(decodedId, controller.signal).then(runData => {
        if (!controller.signal.aborted) {
          setRun(previous => applyRunState(mergeTrainingRun(previous, runData), statesRef.current[decodedId]))
          setLoading(false)
        }
      }),
      fetchStepHistory(decodedId, controller.signal),
      fetchChartData(decodedId, controller.signal),
      fetchEvalSummary(decodedId, controller.signal),
    ]).then(([, historyData, chart, evaluations]) => {
      if (controller.signal.aborted) return
      setHistory(historyData)
      setChartData(chart)
      setEvalSummary(evaluations)
      setLoadError('')
    }).catch(error => {
      if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : '读取训练详情失败')
    }).finally(() => {
      if (requestRef.current !== controller) return
      requestRef.current = null
      pendingRef.current = null
      if (!controller.signal.aborted) setLoading(false)
      if (refreshQueued.current && !controller.signal.aborted) {
        refreshQueued.current = false
        void loadData(undefined, true)
      }
    })
    pendingRef.current = pending
    return pending
  }, [id])

  const refreshState = useCallback(async () => {
    if (!id || stateRequestRef.current) return
    const controller = new AbortController()
    stateRequestRef.current = controller
    const decodedId = decodeURIComponent(id)
    try {
      const incoming = await fetchTrainingRun(decodedId, controller.signal)
      if (!controller.signal.aborted) {
        setRun(previous => applyRunState(mergeTrainingRun(previous, incoming), statesRef.current[decodedId]))
      }
    } catch (error) {
      if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : '状态同步失败')
    } finally {
      if (stateRequestRef.current === controller) stateRequestRef.current = null
    }
  }, [id])

  useEffect(() => {
    const controller = new AbortController()
    setRun(null)
    setHistory([])
    setChartData([])
    setEvalDetails([])
    setEvalSummary([])
    setChatMessages([])
    setStreamingSummary('')
    setLoadError('')
    lastDetailState.current = ''
    seenLogId.current = 0
    void loadData()
    fetchTrainingRuns(controller.signal).then(data => {
      if (!controller.signal.aborted) setAllRuns(data)
    }).catch(() => {})
    return () => {
      controller.abort()
      requestRef.current?.abort()
      requestRef.current = null
      pendingRef.current = null
      refreshQueued.current = false
      stateRequestRef.current?.abort()
      stateRequestRef.current = null
      evalRequestRef.current?.abort()
      streamRequests.current.forEach(request => request.abort())
      streamRequests.current.clear()
    }
  }, [loadData])

  useEffect(() => {
    if (!id) return
    const decodedId = decodeURIComponent(id)
    const entries = messages.filter(message => message.id > seenLogId.current && message.runId === decodedId
      && (message.type === 'log' || message.type === 'error'))
    seenLogId.current = messages[messages.length - 1]?.id ?? seenLogId.current
    if (entries.length) setConsoleLines(previous => [...previous, ...entries.map(message => ({
      text: String(message.data),
      time: new Date(message.receivedAt).toLocaleTimeString('zh-CN', { hour12: false }),
      type: message.type === 'error' ? 'stderr' as const : 'stdout' as const,
    }))].slice(-500))
  }, [messages, id])

  useEffect(() => {
    if (!id) return
    const state = states[decodeURIComponent(id)]
    if (state) setRun(previous => previous ? applyRunState(previous, state) : previous)
  }, [states, id])

  const detailStateKey = run?.state
    ? `${run.state.attempt}:${run.state.completedSteps}:${run.state.status}:${run.state.artifactSync}:${run.state.status === 'training' ? '' : run.state.version}`
    : run?.status ?? ''
  useEffect(() => {
    if (!detailStateKey || detailStateKey === lastDetailState.current) return
    const hadState = !!lastDetailState.current
    lastDetailState.current = detailStateKey
    if (hadState) void loadData(undefined, true)
  }, [detailStateKey, loadData])

  useEffect(() => {
    if (connectionVersion > 0) void loadData(undefined, true)
  }, [connectionVersion, loadData])

  const shouldRefresh = run ? needsRunRefresh(run) : false
  useEffect(() => {
    if (!shouldRefresh) return
    pollRef.current = setInterval(refreshState, 3000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [shouldRefresh, refreshState])

  // Auto-scroll log panel
  useEffect(() => {
    if (consoleLines.length > 0 && activeTab === '日志') {
      requestAnimationFrame(() => logEndRef.current?.scrollIntoView(false))
    }
  }, [consoleLines.length, activeTab])

  // 手动刷新
  const handleRefresh = async () => {
    setRefreshing(true)
    await loadData(undefined, false)
    setRefreshing(false)
  }

  // 重新启动训练
  const handleRestart = async () => {
    if (!run) return
    const confirmed = await confirm({
      message: '确定要重新启动该训练任务吗？',
      confirmText: '重新启动',
      variant: 'warning',
    })
    if (!confirmed) return
    try {
      await restartTraining(run.id)
      await loadData()
    } catch (error: any) {
      showToast('error', error?.message || '重新启动失败')
    }
  }

  // 导出训练报告
  const [exporting, setExporting] = useState(false)
  const handleExport = async () => {
    if (!run) return
    setExporting(true)
    try {
      // 获取最佳 Skill 和配置
      const [skillContent, configData] = await Promise.all([
        fetchSkillContent(run.id, 'best').catch(() => ''),
        fetchTrainingConfig(run.id).catch(() => null),
      ])

      const report = {
        runName: run.name,
        runId: run.id,
        model: run.model,
        status: run.status,
        currentScore: run.currentScore,
        bestScore: run.bestScore,
        initialScore: run.initialScore,
        totalSteps: run.totalSteps,
        accepts: run.accepts,
        rejects: run.rejects,
        skips: run.skips,
        acceptRate: run.acceptRate,
        totalTime: run.totalTime,
        avgPerStep: run.avgPerStep,
        epochs: run.epochs,
        batchSize: run.batchSize,
        editBudget: run.editBudget,
        lrScheduler: run.lrScheduler,
        createdAt: run.createdAt,
        config: configData,
        bestSkill: skillContent,
        exportedAt: new Date().toISOString(),
      }

      const jsonStr = JSON.stringify(report, null, 2)
      const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${run.name.replace(/[\/\\:*?"<>|]/g, '_')}_report.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (error: any) {
      console.error('导出失败:', error)
    } finally {
      setExporting(false)
    }
  }

  const handleRunChange = (newId: string) => {
    setConsoleLines([])
    navigate(`/training/${encodeURIComponent(newId)}`)
  }

  const getActionBadge = (item: StepHistory) => {
    switch (item.action) {
      case 'accept':
        return <span className="badge bg-green-50 text-green-600">接受</span>
      case 'reject':
        return <span className="badge bg-red-50 text-red-600">拒绝</span>
      case 'skip':
        return <span className="badge bg-gray-100 text-gray-600">跳过 · {getSkipReason(item.rawAction)}</span>
      default:
        return <span className="badge bg-gray-100 text-gray-600">{item.action}</span>
    }
  }

  const getSkipReason = (rawAction: string): string => {
    switch (rawAction) {
      case 'skip_no_patches': return '未生成任何修改'
      case 'skip_no_rewrite': return '未生成重写内容'
      case 'skip_no_improvement': return '无改进'
      case 'skip_first_epoch': return '首轮跳过'
      case 'no_content': return '未产出内容'
      default: return rawAction
    }
  }

  if (loading) return <DetailSkeleton />

  if (!run && !loading) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <div className="text-gray-500">{loadError || '请从仪表盘选择一个训练任务'}</div>
        <Link to="/" className="btn-primary">返回仪表盘</Link>
      </div>
    )
  }

  if (!run) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400 animate-pulse">加载中...</div>
      </div>
    )
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Link to="/" className="p-2 hover:bg-gray-100 rounded-xl">
            <ArrowLeft className="w-5 h-5 text-gray-600" />
          </Link>
          {allRuns.length > 1 && (
            <select
              value={id || ''}
              onChange={(e) => handleRunChange(e.target.value)}
              className="px-3 py-2 bg-gray-100 rounded-xl text-sm font-medium text-gray-700 border-none min-w-[200px]"
            >
              {allRuns.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.status === 'completed' ? '已完成' : r.status === 'training' ? '训练中' : r.status === 'failed' ? '失败' : '等待'})
                </option>
              ))}
            </select>
          )}
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 mb-2">训练详情</h1>
            <p className="text-gray-500">ID: {run?.id}</p>
          </div>
        </div>
        <div className="flex gap-3">
          <button onClick={handleRefresh} className="btn-secondary flex items-center gap-2" disabled={refreshing}>
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            刷新
          </button>
          {(run.status !== 'training') && (
            <button onClick={handleRestart} className="btn-primary flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white">
              <RotateCw className="w-4 h-4" />
              重新启动
            </button>
          )}
          <button onClick={handleExport} className="btn-secondary flex items-center gap-2" disabled={exporting}>
            {exporting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Download className="w-4 h-4" />
            )}
            导出
          </button>
          <Link
            to="/settings"
            className="p-2 hover:bg-gray-100 rounded-xl inline-flex"
            title="API Key 配置"
          >
            <Settings className="w-5 h-5 text-gray-600" />
          </Link>
        </div>
      </div>

      <div role="status" className="mb-3 text-sm bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 space-y-1">
        <p className="font-medium text-blue-700">{run.state ? runStateLabel(run.state) : run.status === 'completed' ? '训练已完成（历史记录）' : run.status === 'failed' ? '训练失败' : run.status === 'stopped' ? '已停止' : '等待真实阶段同步'}</p>
        {run.state && <p className="text-xs text-gray-600">优化步骤 {run.state.completedSteps}/{run.state.totalSteps} · 状态更新时间 {new Date(run.state.updatedAt).toLocaleTimeString('zh-CN')}</p>}
        {run.state?.persistenceError && <p className="text-amber-700">状态保存失败，尚未同步：{run.state.persistenceError}</p>}
        {run.state?.artifactError && <p className="text-amber-700">详情同步失败：{run.state.artifactError}</p>}
        {loadError && <p className="text-amber-700">{loadError}；当前保留最近一次有效状态。</p>}
      </div>

      {/* AI 总结 */}
      {(run.aiSummary || isStreaming || streamingSummary) ? (
        <div className="bg-gradient-to-r from-indigo-50 to-purple-50 rounded-2xl border border-indigo-100 p-5 mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles className={`w-4 h-4 ${isStreaming ? 'text-indigo-400 animate-pulse' : 'text-indigo-500'}`} />
            <h3 className="text-sm font-semibold text-indigo-700">AI 训练总结</h3>
            {isStreaming && <span className="text-[10px] text-indigo-400 animate-pulse">生成中...</span>}
            {run.aiSummary && !isStreaming && (
              <button onClick={startStreamSummary} className="text-[10px] text-indigo-400 hover:text-indigo-600 ml-auto">重新生成</button>
            )}
          </div>
          <div className="text-sm text-gray-700 leading-relaxed prose prose-sm max-w-none prose-headings:text-indigo-700 prose-strong:text-gray-900 prose-a:text-indigo-500">
            {isStreaming ? (
              <span>{streamingSummary}<span className="animate-pulse">▊</span></span>
            ) : (
              <ReactMarkdown>{run.aiSummary || streamingSummary}</ReactMarkdown>
            )}
          </div>
          {/* Chat section */}
          {!isStreaming && run.status !== 'training' && (
            <div className="border-t border-indigo-100 pt-3 mt-3">
              {!showChat ? (
                <button onClick={() => setShowChat(true)} className="text-xs text-indigo-500 hover:text-indigo-700 flex items-center gap-1">
                  <MessageSquare className="w-3 h-3" /> 提问
                </button>
              ) : (
                <div className="space-y-3">
                  <div className="max-h-[300px] overflow-auto space-y-2">
                    {chatMessages.map((m, i) => (
                      <div key={i} className={`text-xs rounded-lg px-3 py-2 ${m.role === 'user' ? 'bg-indigo-100 text-indigo-800 ml-4' : 'bg-white text-gray-700 mr-4 border border-gray-100'}`}>
                        {m.role === 'assistant' ? (
                          <ReactMarkdown>{m.content}</ReactMarkdown>
                        ) : m.content}
                        {chatStreaming && i === chatMessages.length - 1 && m.role === 'assistant' && <span className="animate-pulse">▊</span>}
                      </div>
                    ))}
                    {chatMessages.length === 0 && (
                      <p className="text-[10px] text-gray-400 text-center py-2">可以问我关于这次训练的任何问题</p>
                    )}
                  </div>
                  {chatStreaming && chatMessages.length === 0 && (
                    <div className="text-xs text-gray-400 animate-pulse">AI 思考中<span className="animate-pulse">▊</span></div>
                  )}
                  <div className="flex gap-2">
                    <input
                      value={chatInput}
                      onChange={e => setChatInput(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleChatSubmit()}
                      placeholder="例如：为什么步骤2被拒绝了？"
                      className="flex-1 text-xs px-3 py-2 bg-white border border-gray-200 rounded-lg focus:outline-none focus:border-indigo-300"
                    />
                    <button onClick={handleChatSubmit} disabled={chatStreaming || !chatInput.trim()} className="text-xs px-3 py-2 bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 disabled:opacity-50 transition-colors">发送</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="bg-gradient-to-r from-indigo-50 to-purple-50 rounded-2xl border border-indigo-100 p-5 mb-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-indigo-400" />
              <h3 className="text-sm font-semibold text-indigo-700">AI 训练总结</h3>
            </div>
            <button onClick={startStreamSummary} className="text-xs px-3 py-1.5 bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 transition-colors">生成总结</button>
          </div>
          <p className="text-xs text-gray-400 mt-2">AI 将分析本次训练结果并给出改进建议</p>
        </div>
      )}

      {/* Pipeline Stages */}
      <PipelineStages
        runId={run.id}
        status={run.status}
        totalSteps={run.totalSteps}
        isActive={run.status === 'training'}
        history={history}
        state={run.state}
      />

      {/* Tabs */}
      <div className="card overflow-hidden mb-6">
        <div className="px-8 py-4 bg-gray-50/50 border-b border-gray-100">
          <div className="flex gap-8">
            {tabs.map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`py-4 text-sm font-medium border-b-2 transition-colors ${
                  tab === activeTab
                    ? 'text-gray-900 border-gray-900'
                    : 'text-gray-500 border-transparent hover:text-gray-700'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="p-8">
          {activeTab === '概览' && (
            <div>
              {run.status === 'failed' && run.errorMessage && (
                <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-2xl">
                  <h4 className="text-sm font-semibold text-red-700 mb-1">训练失败</h4>
                  <p className="text-sm text-red-600 leading-relaxed">{run.errorMessage}</p>
                </div>
              )}
              <div className="grid grid-cols-3 gap-6">
              {/* Left Column */}
              <div className="space-y-5">
                {/* Metrics */}
                <div className="bg-gray-50 rounded-2xl p-5">
                  <h4 className="font-semibold text-gray-900 mb-4">指标</h4>
                  <div className="space-y-3">
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-500">当前分数 <span className="text-gray-400 text-xs ml-1">(验证集准确率)</span></span>
                      <span className="font-semibold text-green-600">{run.currentScore}%</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-500">最佳分数 <span className="text-gray-400 text-xs ml-1">(验证集历史最高)</span></span>
                      <span className="font-medium text-gray-900">{run.bestScore}%</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-500">接受率 <span className="text-gray-400 text-xs ml-1">(接受/总步数)</span></span>
                      <span className="font-medium text-gray-900">{run.acceptRate}%</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-500">总步骤</span>
                      <span className="font-medium text-gray-900">{run.totalSteps}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-500">接受数 <span className="text-gray-400 text-xs ml-1">(得分提升)</span></span>
                      <span className="font-medium text-gray-900">{run.accepts}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-500">拒绝数 <span className="text-gray-400 text-xs ml-1">(未提升)</span></span>
                      <span className="font-medium text-red-600">{run.rejects}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-500">跳过数 <span className="text-gray-400 text-xs ml-1">(安全校验等)</span></span>
                      <span className="font-medium text-gray-400">{run.skips}</span>
                    </div>
                  </div>
                </div>

                {/* Timing */}
                <div className="bg-gray-50 rounded-2xl p-5">
                  <h4 className="font-semibold text-gray-900 mb-4">时间</h4>
                  <div className="space-y-3">
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-500">总耗时</span>
                      <span className="font-medium text-gray-900">{run.totalTime}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-500">平均步耗时</span>
                      <span className="font-medium text-gray-900">{run.avgPerStep}</span>
                    </div>
                  </div>
                </div>

                {/* Config */}
                <div className="bg-gray-50 rounded-2xl p-5">
                  <h4 className="font-semibold text-gray-900 mb-4">配置</h4>
                  <div className="space-y-3">
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-500">模型</span>
                      <span className="font-medium text-gray-900">{run.model}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-500">训练轮数 <span className="text-gray-400 text-xs ml-1">(完整遍历训练集的次数)</span></span>
                      <span className="font-medium text-gray-900">{run.epochs}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-500">批次大小 <span className="text-gray-400 text-xs ml-1">(每批处理的题目数)</span></span>
                      <span className="font-medium text-gray-900">{run.batchSize}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-500">编辑预算 <span className="text-gray-400 text-xs ml-1">(每步最多允许的修改条数)</span></span>
                      <span className="font-medium text-gray-900">{run.editBudget}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-500">学习率调度 <span className="text-gray-400 text-xs ml-1">(编辑预算递减策略)</span></span>
                      <span className="font-medium text-gray-900">{run.lrScheduler}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-500">慢更新 <span className="text-gray-400 text-xs ml-1">(跨轮次纵向学习)</span></span>
                      <span className="font-medium text-green-600">
                        {run.slowUpdate ? '已启用' : '已禁用'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Right Column — 图表区 */}
              <div className="col-span-2 space-y-5">
                {/* 训练进度：分数轨迹图 + 决策标记 */}
                <div className="bg-gray-50 rounded-2xl p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h4 className="font-semibold text-gray-900">训练进度</h4>
                    {chartData.length > 0 && (
                      <div className="flex items-center gap-2 text-[10px]">
                        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500" /> 接受</span>
                        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-400" /> 拒绝</span>
                        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-gray-300" /> 跳过</span>
                      </div>
                    )}
                  </div>
                  {chartData.length === 0 ? (
                    <div className="h-56 flex items-center justify-center text-gray-400">暂无进度数据</div>
                  ) : (
                    <>
                      {/* 主图：分数轨迹 */}
                      <div className="h-48">
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#f0f4ff" vertical={false} />
                            <XAxis dataKey="step" stroke="#9CA3AF" fontSize={11} tickLine={false} axisLine={false} />
                            <YAxis domain={[0, 100]} stroke="#9CA3AF" fontSize={11} tickFormatter={(v: number) => `${v}%`} width={38} axisLine={false} tickLine={false} />
                            <Tooltip
                              contentStyle={{ backgroundColor: '#fff', border: 'none', borderRadius: 12, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', padding: '10px 14px', fontSize: 12 }}
                              formatter={(value: number, name: string, props: any) => {
                                const action = props.payload?.action
                                const suffix = action === 'skip' ? ' (跳过-沿用上步分)' : ''
                                return [`${value}%${suffix}`, name]
                              }}
                              labelFormatter={(label) => `Step ${label}`}
                            />
                            {/* 基线参考线 */}
                            <ReferenceLine y={chartData[0]?.selection ?? 0} stroke="#94A3B8" strokeDasharray="4 4" strokeWidth={1}
                              label={{ value: `基线 ${chartData[0]?.selection ?? 0}%`, position: 'insideTopRight', fontSize: 9, fill: '#94A3B8' }} />
                            {/* 辅助训练集分数 */}
                            <Line type="monotone" dataKey="rollout" name="训练集" stroke="#E2E8F0" strokeWidth={1.5} dot={false} strokeDasharray="3 3" />
                            {/* 主分数轨迹 */}
                            <defs>
                              <linearGradient id="scoreGrad" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor="#6366F1" stopOpacity={0.15} />
                                <stop offset="100%" stopColor="#6366F1" stopOpacity={0} />
                              </linearGradient>
                            </defs>
                            <Area type="monotone" dataKey="selection" fill="url(#scoreGrad)" stroke="none" />
                            <Line type="monotone" dataKey="selection" name="验证集分数" stroke="#6366F1" strokeWidth={2.5}
                              dot={(props: any) => {
                                const { cx, cy, payload } = props
                                if (cx == null || cy == null) return <g />
                                const isAccept = payload.action === 'accept'
                                const isReject = payload.action === 'reject'
                                return (
                                  <g>
                                    <circle cx={cx} cy={cy} r={6}
                                      fill={isAccept ? '#22C55E' : isReject ? '#EF4444' : '#D1D5DB'}
                                      stroke="#fff" strokeWidth={2.5} />
                                    <circle cx={cx} cy={cy} r={isAccept || isReject ? 6 : 0}
                                      fill="none" stroke={isAccept ? '#22C55E' : '#EF4444'} strokeWidth={1}
                                      opacity={0} className="group-hover:opacity-100" />
                                  </g>
                                )
                              }}
                              activeDot={{ r: 8, fill: '#6366F1', stroke: '#fff', strokeWidth: 3 }}
                              connectNulls={false}
                            />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>

                      {/* 决策时间线 */}
                      <div className="mt-4 pt-4 border-t border-gray-200">
                        <div className="flex gap-1.5 overflow-x-auto pb-1">
                          {chartData.map((d, i) => {
                            const isAccept = d.action === 'accept'
                            const isReject = d.action === 'reject'
                            const isSkip = d.action === 'skip'
                            const prev = i > 0 ? chartData[i - 1] : null
                            const up = prev ? d.selection > prev.selection : null
                            const down = prev ? d.selection < prev.selection : null

                            return (
                              <div key={d.step}
                                className={`flex-shrink-0 w-14 rounded-lg p-2 text-center cursor-default transition-colors ${
                                  isAccept ? 'bg-emerald-50 border border-emerald-200' :
                                  isReject ? 'bg-red-50 border border-red-200' :
                                  'bg-gray-100 border border-gray-200'
                                }`}
                                title={`Step ${d.step}: ${isAccept ? 'Accept' : isReject ? 'Reject' : 'Skip (未重新评估，沿用上步分数)'} — 验证集 ${d.selection}%`}
                              >
                                <div className="text-[9px] text-gray-400">S{d.step}</div>
                                <div className={`text-[11px] font-bold ${
                                  isAccept ? 'text-emerald-700' : isReject ? 'text-red-600' : 'text-gray-400'
                                }`}>
                                  {isSkip ? <span className="text-[10px]">跳过</span> : `${d.selection}%`}
                                </div>
                                <div className={`text-[9px] font-medium mt-0.5 ${
                                  up === true ? 'text-emerald-500' : down === true ? 'text-red-400' : 'text-gray-400'
                                }`}>
                                  {isSkip ? '—' :
                                   up === true ? `↑${d.selection - prev!.selection}` :
                                   down === true ? `↓${prev!.selection - d.selection}` :
                                   i > 0 ? '→' : '—'}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    </>
                  )}
                </div>

                {/* Terminology guide */}
                <div className="bg-blue-50 border border-blue-200 rounded-2xl p-5">
                  <h4 className="font-semibold text-blue-900 mb-3">术语说明</h4>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs text-blue-800 leading-relaxed">
                    <div><b className="text-blue-900">Epoch</b> — 训练轮次，完整遍历一遍训练集</div>
                    <div><b className="text-blue-900">Step</b> — 训练步骤，一轮中的一次修改尝试</div>
                    <div><b className="text-blue-900">训练集 (Rollout)</b> — 用于分析错误、生成修改建议</div>
                    <div><b className="text-blue-900">验证集 (Selection)</b> — 用于检验修改是否真的有进步</div>
                    <div><b className="text-blue-900">硬匹配</b> — 答案完全一致才算对，分数严格</div>
                    <div><b className="text-blue-900">软匹配</b> — 答案语义相似即可，分数宽容</div>
                    <div><b className="text-blue-900">修改 (Patch)</b> — AI 生成的规则修改建议</div>
                    <div><b className="text-blue-900">判断标准 (Gate)</b> — 候选分数 &gt; 当前分数 → 接受</div>
                    <div><b className="text-blue-900">慢更新</b> — 跨轮次的长期趋势学习</div>
                    <div><b className="text-blue-900">Token</b> — AI 处理文本的计量单位</div>
                  </div>
                </div>

                {/* History */}
                <div className="bg-gray-50 rounded-2xl p-5">
                  <h4 className="font-semibold text-gray-900 mb-4">训练历史</h4>
                  <div className="space-y-3">
                    {history.map((item) => (
                      <div
                        key={item.step}
                        className="flex items-center justify-between p-3 bg-white rounded-xl"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-7 h-7 bg-gray-100 rounded-full flex items-center justify-center text-xs font-medium text-gray-600">
                            {item.step}
                          </div>
                          <div>
                            <div className="font-medium text-gray-900 text-sm">步骤 {item.step}</div>
                            <div className="text-xs text-gray-500">
                              {getActionBadge(item)} · {item.score ?? '-'}
                            </div>
                          </div>
                        </div>
                        <button
                          onClick={() => setDiffModalStep(item)}
                          className="text-xs text-blue-600 font-medium cursor-pointer hover:underline"
                        >
                          查看详情 →
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            </div>
          )}

          {activeTab === '日志' && (
            <div className="bg-gray-900 rounded-2xl overflow-hidden">
              {/* Console header */}
              <div className="flex items-center justify-between px-4 py-3 bg-gray-800 border-b border-gray-700">
                <div className="flex items-center gap-3">
                  <h4 className="text-sm font-semibold text-gray-300">训练实时日志</h4>
                  <span className="text-[10px] text-gray-500">{consoleLines.length} 行</span>
                  {run?.status === 'training' && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-900/50 text-green-400 rounded text-[10px]">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" /> 实时
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => setConsoleLines([])} className="text-[11px] text-gray-400 hover:text-gray-200 px-2 py-1 rounded hover:bg-gray-700 transition-colors">
                    清空
                  </button>
                  <button onClick={() => logEndRef.current?.scrollIntoView({ behavior: 'smooth' })}
                    className="text-[11px] text-gray-400 hover:text-gray-200 px-2 py-1 rounded hover:bg-gray-700 transition-colors">
                    回到底部
                  </button>
                </div>
              </div>
              {/* Log output */}
              <div className="h-[600px] overflow-auto p-4 font-mono text-xs leading-relaxed" style={{ fontFamily: "'SF Mono', 'Menlo', 'Monaco', monospace" }}>
                {consoleLines.length === 0 ? (
                  <div className="text-gray-600 pt-20 text-center">
                    <p className="mb-2">等待训练输出...</p>
                    <p className="text-[11px]">日志会在此处实时显示</p>
                  </div>
                ) : (
                  consoleLines.map((line, i) => (
                    <div key={i} className={`flex gap-3 py-0.5 ${line.type === 'stderr' ? 'text-red-400' : 'text-green-300/80'}`}>
                      <span className="text-gray-600 shrink-0 select-none w-14 text-right">{line.time}</span>
                      <span className="whitespace-pre-wrap break-all">{line.text}</span>
                    </div>
                  ))
                )}
                <div ref={logEndRef} />
              </div>
            </div>
          )}
          {activeTab === '历史' && (
            <div className="bg-gray-50 rounded-2xl p-6">
              <h4 className="font-semibold text-gray-900 mb-4">完整训练历史</h4>
              {history.length === 0 ? (
                <div className="text-gray-400 text-center py-8">暂无历史记录</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-gray-500 border-b border-gray-200">
                        <th className="pb-3 pr-4">步骤</th>
                        <th className="pb-3 pr-4">轮次 <span className="text-gray-400 font-normal text-xs">(第几轮)</span></th>
                        <th className="pb-3 pr-4">动作</th>
                        <th className="pb-3 pr-4">当前分数（验证集）</th>
                        <th className="pb-3 pr-4">最佳分数（验证集）</th>
                        <th className="pb-3 pr-4">修改数</th>
                        <th className="pb-3 pr-4">耗时</th>
                        <th className="pb-3">规则长度</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.map((item) => (
                        <tr key={item.step} className="border-b border-gray-100 hover:bg-white rounded-lg">
                          <td className="py-3 pr-4 font-medium">{item.step}</td>
                          <td className="py-3 pr-4 text-gray-600">{item.epoch}</td>
                          <td className="py-3 pr-4">{getActionBadge(item)}</td>
                          <td className="py-3 pr-4">{item.current_score != null ? item.current_score : '-'}</td>
                          <td className="py-3 pr-4">{item.best_score != null ? item.best_score : '-'}</td>
                          <td className="py-3 pr-4">{item.n_patches ?? '-'}/{item.n_success_patches ?? '-'}</td>
                          <td className="py-3 pr-4">{item.wall_time_s != null ? `${item.wall_time_s.toFixed(1)}s` : '-'}</td>
                          <td className="py-3">{item.skill_len ?? '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {activeTab === '步骤' && (
            <div className="space-y-4">
              <h4 className="font-semibold text-gray-900 mb-4">各步骤详情</h4>
              {history.length === 0 ? (
                <div className="text-gray-400 text-center py-8">暂无步骤数据</div>
              ) : (
                history.map((item) => (
                  <div key={item.step} className="bg-gray-50 rounded-2xl p-6">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-blue-100 rounded-xl flex items-center justify-center text-sm font-bold text-blue-600">
                          步骤 {item.step}
                        </div>
                        <div>
                          <div className="font-semibold text-gray-900">
                            Epoch {item.epoch} · Step {item.step_in_epoch + 1} <span className="text-gray-400 font-normal text-xs ml-1">(第{item.epoch}轮 第{item.step_in_epoch + 1}步)</span>
                          </div>
                          <div className="text-xs text-gray-500 mt-0.5">
                            {getActionBadge(item)}
                          </div>
                          {item.action === 'skip' && item.rawAction && (
                            <div className="text-xs text-amber-600 mt-1 bg-amber-50 rounded-lg px-2 py-1 inline-block">
                              原因：{getSkipReason(item.rawAction)}
                            </div>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={() => setDiffModalStep(item)}
                        className="text-sm text-blue-600 font-medium hover:underline"
                      >
                        查看详情 →
                      </button>
                    </div>
                    <div className="grid grid-cols-4 gap-4 text-sm">
                      <div className="bg-white rounded-xl p-3">
                        <div className="text-gray-400 text-xs mb-1">训练集分数 <span className="text-gray-300">(Rollout)</span></div>
                        <div className="font-semibold text-gray-900">
                          硬匹配: {item.rollout_hard ?? 0} / 软匹配: {item.rollout_soft ?? 0}
                        </div>
                      </div>
                      <div className="bg-white rounded-xl p-3">
                        <div className="text-gray-400 text-xs mb-1">修改统计</div>
                        <div className="font-semibold text-gray-900">
                          总计: {item.n_patches ?? 0} · 成功: {item.n_success_patches ?? 0}
                        </div>
                      </div>
                      <div className="bg-white rounded-xl p-3">
                        <div className="text-gray-400 text-xs mb-1">耗时</div>
                        <div className="font-semibold text-gray-900">
                          执行: {item.timing?.rollout_s?.toFixed(1) || 0}s · 反思: {item.timing?.reflect_s?.toFixed(1) || 0}s
                        </div>
                      </div>
                      <div className="bg-white rounded-xl p-3">
                        <div className="text-gray-400 text-xs mb-1">规则长度</div>
                        <div className="font-semibold text-gray-900">{item.skill_len ?? 0} 字符</div>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {activeTab === '评估' && (
            <div className="space-y-6">
              {/* Stats */}
              <div className="bg-gray-50 rounded-2xl p-6">
                <h4 className="font-semibold text-gray-900 mb-4">评估结果</h4>
                <div className="grid grid-cols-2 gap-6">
                  <div className="bg-white rounded-xl p-5">
                    <div className="text-gray-400 text-sm mb-2">最终测试分数 <span className="text-gray-300 text-xs">测试集准确率</span></div>
                    <div className="text-3xl font-bold text-green-600">{run.currentScore}%</div>
                  </div>
                  <div className="bg-white rounded-xl p-5">
                    <div className="text-gray-400 text-sm mb-2">最佳测试分数 <span className="text-gray-300 text-xs">测试集历史最高</span></div>
                    <div className="text-3xl font-bold text-blue-600">{run.bestScore}%</div>
                  </div>
                  <div className="bg-white rounded-xl p-5">
                    <div className="text-gray-400 text-sm mb-2">总步骤数</div>
                    <div className="text-3xl font-bold text-gray-900">{run.totalSteps}</div>
                  </div>
                  <div className="bg-white rounded-xl p-5">
                    <div className="text-gray-400 text-sm mb-2">接受率 <span className="text-gray-300 text-xs">接受/总步数</span></div>
                    <div className="text-3xl font-bold text-purple-600">{run.acceptRate}%</div>
                  </div>
                </div>
              </div>

              {/* Evaluation Details — LLM prompt/response records */}
              <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                  <h4 className="font-semibold text-gray-900">LLM 评估记录</h4>
                  <span className="text-xs text-gray-400">Skill + 题目 → 模型 → 判分</span>
                </div>

                {evalSummary.length === 0 ? (
                  <div className="p-12 text-center text-gray-400 text-sm">
                    暂无评估记录数据
                    <p className="text-xs mt-1 text-gray-300">训练完成后自动同步到此处</p>
                  </div>
                ) : (
                  <div className="flex">
                    {/* Left: Step/Phase selector */}
                    <div className="w-[200px] shrink-0 border-r border-gray-100 max-h-[500px] overflow-auto">
                      {(() => {
                        const steps = [...new Set(evalSummary.map(e => e.step))].sort((a, b) => a - b)
                        const phaseLabel: Record<string, string> = {
                          baseline_selection: '基线评估', baseline_test: '基线测试',
                          rollout: '训练Rollout', selection: '验证Selection', test: '最终测试',
                        }
                        return steps.map(step => {
                          const stepEvals = evalSummary.filter(e => e.step === step)
                          return (
                            <div key={step}>
                              <div className="px-4 py-2 text-[11px] font-semibold text-gray-400 bg-gray-50/50">
                                {step === 0 ? '初始/最终评估' : `Step ${String(step).padStart(4, '0')}`}
                              </div>
                              {stepEvals.map(ev => (
                                <button
                                  key={ev.phase}
                                  onClick={() => loadEvalDetails(ev.step, ev.phase)}
                                  className={`w-full text-left px-4 py-2.5 text-xs flex items-center justify-between transition-colors ${
                                    selectedEvalStep === ev.step && selectedEvalPhase === ev.phase
                                      ? 'bg-blue-50 text-blue-700' : 'hover:bg-gray-50 text-gray-600'
                                  }`}
                                >
                                  <span>{phaseLabel[ev.phase] || ev.phase}</span>
                                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                                    ev.total > 0 && ev.correct === ev.total ? 'bg-green-100 text-green-700' :
                                    ev.total > 0 ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'
                                  }`}>
                                    {ev.correct}/{ev.total}
                                  </span>
                                </button>
                              ))}
                            </div>
                          )
                        })
                      })()}
                    </div>

                    {/* Right: Evaluation records table */}
                    <div className="flex-1 max-h-[500px] overflow-auto">
                      {evalDetails.length === 0 ? (
                        <div className="p-12 text-center text-gray-400 text-sm">
                          选择左侧评估阶段查看详细记录
                        </div>
                      ) : (
                        <table className="w-full text-xs">
                          <thead className="sticky top-0 bg-gray-50 text-gray-500">
                            <tr>
                              <th className="text-left px-4 py-2 font-medium">题目</th>
                              <th className="text-left px-4 py-2 font-medium w-[120px]">模型回答</th>
                              <th className="text-left px-4 py-2 font-medium w-[100px]">标准答案</th>
                              <th className="text-center px-4 py-2 font-medium w-[60px]">结果</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-50">
                            {evalDetails.map(ev => (
                              <tr key={ev.id} className="hover:bg-gray-50/50">
                                <td className="px-4 py-2.5">
                                  <button
                                    onClick={() => setExpandedEvalId(expandedEvalId === ev.id ? null : ev.id)}
                                    className="text-left text-gray-700 hover:text-blue-600 max-w-[300px] truncate block"
                                  >
                                    {ev.question || `题目 ${ev.item_id}`}
                                  </button>
                                </td>
                                <td className="px-4 py-2.5">
                                  <span className="text-gray-600 truncate block max-w-[120px]" title={ev.extracted_answer}>
                                    {ev.extracted_answer || '—'}
                                  </span>
                                </td>
                                <td className="px-4 py-2.5 text-gray-500 truncate max-w-[100px]">
                                  {ev.gold_answer || '—'}
                                </td>
                                <td className="px-4 py-2.5 text-center">
                                  {ev.is_correct === 1 ? (
                                    <span className="inline-flex items-center gap-1 text-green-600 font-medium">
                                      <span className="w-1.5 h-1.5 rounded-full bg-green-500" />✓
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1 text-red-500 font-medium">
                                      <span className="w-1.5 h-1.5 rounded-full bg-red-500" />✗
                                    </span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  </div>
                )}

                {/* Expanded detail panel */}
                {expandedEvalId !== null && (() => {
                  const ev = evalDetails.find(e => e.id === expandedEvalId)
                  if (!ev) return null
                  return (
                    <div className="border-t border-gray-200 p-4 bg-gray-50 space-y-3">
                      <div className="flex items-center justify-between">
                        <h5 className="text-sm font-semibold text-gray-700">
                          评估详情 · {ev.item_id}
                        </h5>
                        <button onClick={() => setExpandedEvalId(null)} className="text-xs text-gray-400 hover:text-gray-600">关闭</button>
                      </div>
                      {/* System Prompt */}
                      <details className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                        <summary className="px-4 py-2 text-xs font-medium text-gray-600 cursor-pointer hover:bg-gray-50 select-none">
                          System Prompt（含 Skill 规则）
                        </summary>
                        <pre className="px-4 py-3 text-[10px] text-gray-700 whitespace-pre-wrap break-all font-mono leading-relaxed max-h-[300px] overflow-auto border-t border-gray-100">
                          {ev.system_prompt || '无'}
                        </pre>
                      </details>
                      {/* User Prompt */}
                      <details className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                        <summary className="px-4 py-2 text-xs font-medium text-gray-600 cursor-pointer hover:bg-gray-50 select-none">
                          User Prompt（Context + 题目）
                        </summary>
                        <pre className="px-4 py-3 text-[10px] text-gray-700 whitespace-pre-wrap break-all font-mono leading-relaxed max-h-[300px] overflow-auto border-t border-gray-100">
                          {ev.user_prompt || '无'}
                        </pre>
                      </details>
                      {/* Model Response */}
                      <details className="bg-white rounded-xl border border-gray-200 overflow-hidden" open>
                        <summary className="px-4 py-2 text-xs font-medium text-gray-600 cursor-pointer hover:bg-gray-50 select-none">
                          模型回复（提取答案: {ev.extracted_answer || '无'} · F1: {ev.score_f1?.toFixed(3)} · {ev.is_correct ? '✓ 正确' : '✗ 错误'}）
                        </summary>
                        <pre className="px-4 py-3 text-[10px] text-gray-700 whitespace-pre-wrap break-all font-mono leading-relaxed max-h-[400px] overflow-auto border-t border-gray-100">
                          {ev.model_response || '无'}
                        </pre>
                      </details>
                    </div>
                  )
                })()}
              </div>
            </div>
          )}

          {activeTab === '数据' && (
            <DataTabContent runId={run!.id} />
          )}

          {activeTab === '技能' && (
            <SkillTabContent runId={run!.id} />
          )}
        </div>

      {/* Step Detail Modal */}
      {diffModalStep && (
        <StepDetailModal
          step={diffModalStep}
          runId={run!.id}
          allSteps={history}
          onClose={() => setDiffModalStep(null)}
        />
      )}
      </div>
    </div>
  )
}

function DataTabContent({ runId }: { runId: string }) {
  const [data, setData] = useState<TrainingData | null>(null)
  const [activeSplit, setActiveSplit] = useState<'train' | 'val' | 'test'>('train')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchTrainingData(runId).then((d) => {
      setData(d)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [runId])

  if (loading) return <div className="text-gray-400 text-center py-8">加载中...</div>
  if (!data || (data.train.length === 0 && data.val.length === 0 && data.test.length === 0)) {
    return <div className="text-gray-400 text-center py-8">暂无问答数据</div>
  }

  const splits: Array<{ key: 'train' | 'val' | 'test'; label: string; color: string }> = [
    { key: 'train', label: '训练集', color: 'blue' },
    { key: 'val', label: '验证集', color: 'amber' },
    { key: 'test', label: '测试集', color: 'green' },
  ]

  const currentItems = data[activeSplit]

  return (
    <div>
      {/* Split selector */}
      <div className="flex gap-2 mb-5">
        {splits.map((s) => (
          <button
            key={s.key}
            onClick={() => setActiveSplit(s.key)}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
              activeSplit === s.key
                ? `bg-${s.color}-50 text-${s.color}-700 border border-${s.color}-200`
                : 'bg-gray-50 text-gray-500 hover:bg-gray-100'
            }`}
          >
            {s.label}
            <span className="ml-1.5 text-xs text-gray-400">({data[s.key].length})</span>
          </button>
        ))}
      </div>

      {/* QA List */}
      <div className="space-y-3">
        {currentItems.length === 0 ? (
          <div className="text-gray-400 text-center py-8">该数据集暂无数据</div>
        ) : (
          currentItems.map((item, i) => (
            <div key={item.id} className="bg-gray-50 rounded-2xl p-5">
              <div className="flex items-start gap-3">
                <span className="w-7 h-7 bg-white rounded-lg flex items-center justify-center text-xs font-medium text-gray-500 shrink-0 mt-0.5">
                  {i + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 mb-2">{item.question}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {item.answers.map((a, j) => (
                      <span
                        key={j}
                        className="inline-flex items-center px-2.5 py-0.5 rounded-lg text-xs font-medium bg-green-50 text-green-700 border border-green-100"
                      >
                        答案: {a}
                      </span>
                    ))}
                  </div>
                  {item.context && (
                    <p className="text-xs text-gray-400 mt-2 truncate">上下文: {item.context}</p>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Summary */}
      <div className="mt-6 p-4 bg-gray-50 rounded-2xl flex gap-6">
        <div className="text-sm">
          <span className="text-gray-500">训练集: </span>
          <span className="font-semibold text-blue-600">{data.train.length} 条</span>
        </div>
        <div className="text-sm">
          <span className="text-gray-500">验证集: </span>
          <span className="font-semibold text-amber-600">{data.val.length} 条</span>
        </div>
        <div className="text-sm">
          <span className="text-gray-500">测试集: </span>
          <span className="font-semibold text-green-600">{data.test.length} 条</span>
        </div>
        <div className="text-sm">
          <span className="text-gray-500">总计: </span>
          <span className="font-semibold text-gray-900">{data.train.length + data.val.length + data.test.length} 条</span>
        </div>
      </div>
    </div>
  )
}

function SkillTabContent({ runId }: { runId: string }) {
  const [skills, setSkills] = useState<SkillVersion[]>([])
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null)
  // 对比基准版本 — 默认选上一个，用户可手动切换
  const [compareVersion, setCompareVersion] = useState<string | null>(null)
  const [content, setContent] = useState<string>('')
  const [copied, setCopied] = useState(false)
  const [loading, setLoading] = useState(true)
  const [showDiff, setShowDiff] = useState(true)
  const [baseContent, setBaseContent] = useState<string>('')

  // 计算默认对比目标（上一个版本）
  // - 具体版本 vv00NN → 对比 vv00(N-1)，不存在则 fallback 到 initial
  //   - vv0001 → 对比 initial（它是第一个生成版，上溯到原始 skill）
  //   - 最佳版本 → 对比最后一个具体版本，没有则 fallback 到 initial
  const getDefaultCompareVersion = useCallback((sel: string | null): string => {
    if (skills.length === 0) return 'initial'
    if (!sel || sel === 'initial') return 'initial'
    if (sel === 'best') {
      const sorted = [...skills].sort((a, b) => parseInt(a.version, 10) - parseInt(b.version, 10))
      // 最佳版本的前一版 = 最后一个具体版本
      return sorted.length > 1 ? sorted[sorted.length - 2].version : (sorted.length === 1 ? sorted[0].version : 'initial')
    }
    const verNum = parseInt(sel, 10)
    if (verNum > 0) {
      const prevVer = String(verNum - 1).padStart(4, '0')
      if (skills.find(s => s.version === prevVer)) return prevVer
      return 'initial'
    }
    return 'initial'
  }, [skills])

  useEffect(() => {
    fetchSkillVersions(runId).then((data) => {
      setSkills(data)
      if (data.length > 0) {
        setSelectedVersion('best')
        const sorted = [...data].sort((a, b) => parseInt(a.version, 10) - parseInt(b.version, 10))
        // 默认对比最佳版本的前一版
        const prevVer = sorted.length > 1 ? sorted[sorted.length - 2].version : 'initial'
        setCompareVersion(prevVer)
      }
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [runId])

  // 当 selectedVersion 或 compareVersion 变化时加载内容
  useEffect(() => {
    if (!selectedVersion || skills.length === 0) return
    fetchSkillContent(runId, selectedVersion).then(setContent).catch(() => setContent(''))
    const baseVer = compareVersion || getDefaultCompareVersion(selectedVersion)
    fetchSkillContent(runId, baseVer).catch(() => '')
      .then((c) => { if (c) setBaseContent(c) })
  }, [runId, selectedVersion, skills, compareVersion, getDefaultCompareVersion])

  // Build diff rows — MUST be before any early returns (React hooks rule)
  const diffRows = useMemo(() => {
    if (!showDiff || !content || !baseContent) return null
    const baseLines = baseContent.split('\n')
    const newLines = content.split('\n')
    const changes = diffArrays(baseLines, newLines)
    interface DiffRow { type: 'same' | 'added' | 'removed'; line: string; idx: number }
    const rows: DiffRow[] = []
    let n = 0
    for (const part of changes) {
      if (part.added) for (const v of part.value) rows.push({ type: 'added', line: v, idx: n++ })
      else if (part.removed) for (const v of part.value) rows.push({ type: 'removed', line: v, idx: n++ })
      else for (const v of part.value) rows.push({ type: 'same', line: v, idx: n++ })
    }
    return rows
  }, [showDiff, content, baseContent])

  const addedCount = diffRows?.filter(r => r.type === 'added').length ?? 0
  const removedCount = diffRows?.filter(r => r.type === 'removed').length ?? 0

  // 可选的对比目标列表（当前选中版本之前的所有版本号）
  const compareOptions: { value: string; label: string }[] = useMemo(() => {
    const opts: { value: string; label: string }[] = []
    // 按 version 排序，只显示早于选中版本的版本号，排除特殊版本
    const sorted = [...skills].filter(s => s.version !== 'best' && s.version !== 'initial')
      .sort((a, b) => parseInt(a.version, 10) - parseInt(b.version, 10))
    for (const s of sorted) {
      if (selectedVersion && selectedVersion !== 'best' && parseInt(selectedVersion, 10) > 0 && parseInt(s.version, 10) >= parseInt(selectedVersion, 10)) continue
      opts.push({ value: s.version, label: `v${s.version}` })
    }
    return opts
  }, [skills, selectedVersion])

  if (loading) return <div className="text-gray-400 text-center py-8">加载中...</div>
  if (skills.length === 0) return <div className="text-gray-400 text-center py-8">暂无技能版本</div>

  return (
    <div className="grid grid-cols-[240px_1fr] gap-6">
      <div className="bg-gray-50 rounded-2xl p-4 space-y-2">
        <h4 className="font-semibold text-gray-900 mb-3 px-1">版本列表</h4>
        <button
          onClick={() => {
            setSelectedVersion('best')
            // 对比基准：取倒数第二个版本（即最佳版本的前一版），没有则用 initial
            const sorted = [...skills].sort((a, b) => parseInt(a.version, 10) - parseInt(b.version, 10))
            const prevVer = sorted.length > 1 ? sorted[sorted.length - 2].version : 'initial'
            setCompareVersion(prevVer)
          }}
          className={`w-full text-left px-3 py-2.5 rounded-xl text-sm transition-colors ${
            selectedVersion === 'best' ? 'bg-blue-50 text-blue-700 font-medium' : 'hover:bg-white text-gray-600'
          }`}
        >
          ★ 最佳版本
        </button>
        {skills.filter(s => s.version !== 'best' && s.version !== 'initial').map((s) => (
          <button
            key={s.version}
            onClick={() => {
              setSelectedVersion(s.version)
              // 默认对比上一个版本
              const verNum = parseInt(s.version, 10)
              if (verNum > 0) {
                const prevVer = String(verNum - 1).padStart(4, '0')
                setCompareVersion(skills.find(v => v.version === prevVer) ? prevVer : 'initial')
              } else {
                setCompareVersion('initial')
              }
            }}
            className={`w-full text-left px-3 py-2.5 rounded-xl text-sm transition-colors ${
              selectedVersion === s.version ? 'bg-blue-50 text-blue-700 font-medium' : 'hover:bg-white text-gray-600'
            }`}
          >
            v{s.version}
          </button>
        ))}
      </div>
      <div className="bg-gray-50 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <h4 className="font-semibold text-gray-900">
              {selectedVersion === 'best' ? '最佳规则' : `规则 v${selectedVersion}`}
            </h4>
            {showDiff && (
              <span className="text-xs text-gray-400 font-mono flex items-center gap-1.5">
                对比{' '}
                {/* 对比目标选择器 */}
                <select
                  value={compareVersion || 'initial'}
                  onChange={(e) => {
                    const val = e.target.value
                    setCompareVersion(val)
                    fetchSkillContent(runId, val).catch(() => '')
                      .then((c) => { if (c) setBaseContent(c) })
                  }}
                  className="text-[11px] font-mono bg-white border border-gray-200 rounded-md px-1.5 py-0.5 text-red-500 cursor-pointer hover:border-gray-300 outline-none"
                >
                  <option value="initial">初始规则</option>
                  {compareOptions.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                {' '}→ <span className="text-green-600">{selectedVersion === 'best' ? '最佳' : `v${selectedVersion}`}</span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Diff toggle */}
            <div className="inline-flex bg-white border border-gray-200 rounded-lg p-0.5">
              <button
                onClick={() => setShowDiff(true)}
                className={`text-[11px] px-2.5 py-1 rounded-md font-medium transition-colors ${
                  showDiff ? 'bg-indigo-500 text-white shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                差异对比
              </button>
              <button
                onClick={() => setShowDiff(false)}
                className={`text-[11px] px-2.5 py-1 rounded-md font-medium transition-colors ${
                  !showDiff ? 'bg-indigo-500 text-white shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                原始文本
              </button>
            </div>
            {content && (
              <button
                onClick={async () => { try { await navigator.clipboard.writeText(content); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch {} }}
                className={`text-xs px-3 py-1.5 rounded-lg transition-all ${copied ? 'bg-green-500 text-white border-green-500' : 'bg-white border border-gray-200 hover:bg-gray-50'}`}
              >
                {copied ? '✓ 已复制' : '复制内容'}
              </button>
            )}
          </div>
        </div>

        {/* Diff stats bar */}
        {showDiff && diffRows && (
          <div className="mb-3 flex items-center gap-3 text-xs">
            <span className="px-2.5 py-1 bg-green-50 text-green-700 rounded-md font-semibold border border-green-200">
              +{addedCount} 新增
            </span>
            <span className="px-2.5 py-1 bg-red-50 text-red-600 rounded-md font-semibold border border-red-200">
              -{removedCount} 删除
            </span>
            <span className="text-gray-300">|</span>
            <span className="text-gray-400">共 {diffRows.length} 行</span>
          </div>
        )}

        {/* Content area */}
        {!showDiff ? (
          <pre className="text-sm text-gray-700 bg-white rounded-xl p-5 overflow-auto max-h-[60vh] whitespace-pre-wrap break-words leading-relaxed font-mono">
            {content || '加载中...'}
          </pre>
        ) : diffRows && diffRows.length > 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 overflow-auto max-h-[60vh]">
            <table className="w-full text-[13px] leading-[1.65] font-mono border-collapse" style={{ tableLayout: 'fixed' }}>
              <tbody>
                {diffRows.map((row, i) => (
                  <tr key={i} className={
                    row.type === 'added' ? 'bg-emerald-50/70' :
                    row.type === 'removed' ? 'bg-red-50/70' :
                    'hover:bg-gray-50/30'
                  }>
                    <td className={`shrink-0 w-8 pl-3 pr-2 text-right select-none tabular-nums ${
                      row.type === 'added' ? 'text-emerald-400' :
                      row.type === 'removed' ? 'text-red-300' : 'text-gray-300'
                    }`}>
                      {row.type === 'added' ? '+' : row.type === 'removed' ? '-' : ' '}
                    </td>
                    <td className={`px-3 whitespace-pre-wrap break-all ${
                      row.type === 'added' ? 'text-green-800 bg-green-100/40' :
                      row.type === 'removed' ? 'text-red-800 bg-red-100/40 line-through decoration-red-300' :
                      'text-gray-600'
                    }`}>
                      {row.line || '\u00A0'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-gray-400 text-center py-12 bg-white rounded-xl border border-gray-200">
            暂无对比数据（请选择具体版本号）
          </div>
        )}
      </div>
    </div>
  )
}

function StepDetailModal({ step, runId, allSteps, onClose }: { step: StepHistory; runId: string; allSteps: StepHistory[]; onClose: () => void }) {
  const [activeSection, setActiveSection] = useState<'diff' | 'qa' | 'patches' | 'reason'>('diff')
  // Skill diff data
  const [prevSkill, setPrevSkill] = useState<string>('')
  const [prevLabel, setPrevLabel] = useState<string>('初始')
  const [currSkill, setCurrSkill] = useState<string>('')
  // QA results
  const [rolloutResults, setRolloutResults] = useState<RolloutResult[]>([])
  const [selectionResults, setSelectionResults] = useState<RolloutResult[]>([])
  // Patch data
  const [patches, setPatches] = useState<MergedPatch>({})
  // Record
  const [record, setRecord] = useState<Record<string, any>>({})
  const [loading, setLoading] = useState(true)
  const [expandedQaId, setExpandedQaId] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    Promise.all([
      // "Before" skill — always the previous step's candidate, or initial for step 1
      (async () => {
        const currentIdx = allSteps.findIndex(s => s.step === step.step)
        if (currentIdx <= 0) {
          // Step 1: use initial skill as baseline
          setPrevLabel('初始规则')
          return fetchSkillContent(runId, 'initial').catch(() => fetchSkillContent(runId, 'best').catch(() => ''))
        } else {
          // Step N: use previous step's candidate skill as baseline
          const prevStep = allSteps[currentIdx - 1]
          setPrevLabel(`步骤 ${prevStep.step}`)
          return fetchCandidateSkill(runId, prevStep.step).catch(() => '')
        }
      })(),

      // "After" — this step's candidate skill
      fetchCandidateSkill(runId, step.step).catch(() => ''),

      // New data
      fetchRolloutResults(runId, step.step).catch(() => []),
      fetchSelectionResults(runId, step.step).catch(() => []),
      fetchStepPatches(runId, step.step).catch(() => {}),
      fetchStepRecord(runId, step.step).catch(() => {}),
    ]).then(([prev, cand, rollout, sel, patchData, rec]) => {
      setPrevSkill(prev)
      setCurrSkill(cand || '')
      setRolloutResults(rollout as RolloutResult[])
      setSelectionResults(sel as RolloutResult[])
      setPatches(patchData as MergedPatch || {})
      setRecord(rec || {})
      setLoading(false)
    })
  }, [step.step, runId])

  // ── Diff rows ──
  const diffRows = useMemo(() => {
    if (!prevSkill && !currSkill) return []
    const prevLines = prevSkill.split('\n')
    const currLines = currSkill.split('\n')
    const changes = diffArrays(prevLines, currLines)
    interface DiffRow { left: string | null; right: string | null; leftNum: number | null; rightNum: number | null; type: 'same' | 'removed' | 'added' }
    const rows: DiffRow[] = []
    let lNum = 1, rNum = 1
    for (const part of changes) {
      if (part.added) for (const v of part.value) rows.push({ left: null, right: v, leftNum: null, rightNum: rNum++, type: 'added' })
      else if (part.removed) for (const v of part.value) rows.push({ left: v, right: null, leftNum: lNum++, rightNum: null, type: 'removed' })
      else for (const v of part.value) rows.push({ left: v, right: v, leftNum: lNum++, rightNum: rNum++, type: 'same' })
    }
    return rows
  }, [prevSkill, currSkill])

  const [qaDataset, setQaDataset] = useState<'rollout' | 'selection'>('rollout')
  const qaToShow = qaDataset === 'rollout' ? rolloutResults : selectionResults

  // Accept/reject reason text
  const decisionReason = useMemo(() => {
    if (step.action === 'accept') {
      const parts: string[] = []
      if (step.score != null) parts.push(`分数提升至 ${(step.score * 100).toFixed(1)}%`)
      if (record.best_score != null) parts.push(`达到历史最佳 ${(record.best_score * 100).toFixed(1)}%`)
      return parts.length > 0 ? parts.join('，') : '新版本表现优于当前版本'
    } else if (step.action === 'reject') {
      const parts: string[] = []
      if (step.candidate_gate_score != null) parts.push(`候选分数 ${(step.candidate_gate_score * 100).toFixed(1)}% ≤ 当前分数 ${(step.current_score * 100)?.toFixed(1)}%`)
      if (step.gate_metric) parts.push(`Gate 指标: ${step.gate_metric}`)
      if (step.rawAction === 'reject' && record.trajectory_digest?.rejection_reasons) {
        parts.push(record.trajectory_digest.rejection_reasons.join('；'))
      }
      return parts.length > 0 ? parts.join('，') : '未通过门控评估'
    } else {
      return getSkipReason(step.rawAction)
    }
  }, [step, record])

  if (loading) return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-[1100px] max-h-[90vh] flex flex-col items-center justify-center py-20">
        <div className="text-gray-400">加载步骤详情...</div>
      </div>
    </div>
  )

  const sectionTabs: { key: typeof activeSection; label: string; icon: React.ReactNode }[] = [
    { key: 'diff', label: '规则变更', icon: <FileDiff className="w-4 h-4" /> },
    { key: 'qa', label: `答题结果 (${qaToShow.length})`, icon: <BarChart3 className="w-4 h-4" /> },
    { key: 'patches', label: `修改详情 (${patches.edits?.length ?? 0})`, icon: <Code className="w-4 h-4" /> },
    { key: 'reason', label: '决策原因', icon: <MessageSquare className="w-4 h-4" /> },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-[90vw] max-h-[92vh] max-w-[1500px] flex flex-col overflow-hidden">

        {/* ── Header ── */}
        <div className="px-6 py-4 border-b border-gray-100 shrink-0 bg-gradient-to-r from-gray-50 to-white">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-xl transition-colors" title="关闭">
                <ArrowLeft className="w-5 h-5 text-gray-500" />
              </button>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">步骤 {step.step} · 详细报告</h3>
                <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-3">
                  <span>Epoch {step.epoch} · Step {step.step_in_epoch + 1} <span className="text-gray-400">(第{step.epoch}轮 第{step.step_in_epoch + 1}步)</span></span>
                  {step.action === 'accept' ? (
                    <span className="flex items-center gap-1 text-green-600 font-medium"><CheckCircle className="w-3.5 h-3.5" /> 接受</span>
                  ) : step.action === 'reject' ? (
                    <span className="flex items-center gap-1 text-red-600 font-medium"><XCircle className="w-3.5 h-3.5" /> 拒绝</span>
                  ) : (
                    <span className="text-gray-500">跳过</span>
                  )}
                  <span className="text-gray-400">|</span>
                  <span>训练集: {(step.rollout_hard * 100).toFixed(0)}% / 验证集: {(step.selection_hard || step.current_score || 0).toFixed(0)}%</span>
                </div>
              </div>
            </div>
            <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-xl transition-colors">
              <X className="w-5 h-5 text-gray-500" />
            </button>
          </div>

          {/* Section tabs */}
          <div className="flex gap-1 mt-2">
            {sectionTabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveSection(tab.key)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  activeSection === tab.key ? 'bg-blue-50 text-blue-700' : 'text-gray-500 hover:bg-gray-100'
                }`}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* ── Content ── */}
        <div className="flex-1 overflow-auto p-6">

          {/* === Tab: Skill Diff === */}
          {activeSection === 'diff' && (
            <div className="space-y-4">
              {/* Summary cards */}
              <div className="grid grid-cols-4 gap-3">
                <div className={`rounded-xl p-3 ${step.action === 'accept' ? 'bg-green-50' : step.action === 'reject' ? 'bg-red-50' : 'bg-gray-50'}`}>
                  <div className="text-[11px] text-gray-400 mb-1">决策</div>
                  <div className={`text-sm font-bold ${step.action === 'accept' ? 'text-green-700' : step.action === 'reject' ? 'text-red-700' : 'text-gray-600'}`}>
                    {step.action === 'accept' ? '接受 ✓' : step.action === 'reject' ? '拒绝 ✗' : '跳过 ○'}
                  </div>
                </div>
                <div className="bg-gray-50 rounded-xl p-3">
                  <div className="text-[11px] text-gray-400 mb-1">训练集分数（Rollout）</div>
                  <div className="text-sm font-bold text-gray-800">{(step.rollout_hard * 100).toFixed(0)}%</div>
                </div>
                <div className="bg-gray-50 rounded-xl p-3">
                  <div className="text-[11px] text-gray-400 mb-1">Patch 数量</div>
                  <div className="text-sm font-bold text-gray-800">{step.n_patches ?? 0} / {step.n_success_patches ?? 0}</div>
                </div>
                <div className="bg-gray-50 rounded-xl p-3">
                  <div className="text-[11px] text-gray-400 mb-1">耗时</div>
                  <div className="text-sm font-bold text-gray-800">{step.wall_time_s?.toFixed(1) || '-'}s</div>
                </div>
              </div>

              {/* Rejection banner */}
              {step.action === 'reject' && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-4">
                  <div className="flex items-start gap-3">
                    <XCircle className="w-5 h-5 text-red-500 mt-0.5 shrink-0" />
                    <div>
                      <div className="text-sm font-semibold text-red-700 mb-1">已拒绝 — 修改未采纳</div>
                      <div className="text-xs text-red-600 leading-relaxed">
                        {decisionReason}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Diff view — unified vertical layout */}
              <div className="border border-gray-200 rounded-xl overflow-hidden flex flex-col" style={{ maxHeight: '55vh' }}>
                <div className="flex items-center justify-between border-b border-gray-200 bg-gray-50 px-4 py-2.5 text-sm font-medium text-gray-500 shrink-0">
                  <span>规则变更: {prevLabel} → 步骤 {step.step}</span>
                  <span className="text-xs font-normal text-gray-400">{prevSkill.length} → {currSkill.length} 字符 · {currSkill.length - prevSkill.length > 0 ? '+' : ''}{currSkill.length - prevSkill.length}</span>
                </div>
                <div className="overflow-auto flex-1">
                  {diffRows.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 text-gray-400">
                      <FileDiff className="w-8 h-8 mb-2 text-gray-300" />
                      <span className="text-sm">{step.action === 'reject' ? '修改被拒绝，规则未变更' : '无规则变更数据'}</span>
                    </div>
                  ) : (
                    <table className="w-full text-[14px] leading-7 font-mono border-collapse" style={{ tableLayout: 'fixed' }}>
                      <tbody>
                        {diffRows.map((row, i) => (
                          row.type !== 'same'
                            ? (
                              <tr key={i}>
                                {/* removed line */}
                                {row.left && (
                                  <td colSpan={2} className={`py-0.5 pl-4 pr-3 ${row.type === 'removed' ? 'bg-red-50' : 'bg-white'}`}>
                                  <span className="select-none text-gray-400 mr-2 text-xs w-5 inline-block text-right">-</span>
                                      <span className={`whitespace-pre-wrap break-all ${row.type === 'removed' ? 'text-red-700 bg-red-200/40 rounded px-0.5' : 'text-gray-400'}`}>
                                        {row.left}
                                      </span>
                                </td>
                                )}
                                {/* added line */}
                                {row.right && (
                                  <td colSpan={2} className={`py-0.5 pl-4 pr-3 ${row.type === 'added' ? 'bg-green-50' : 'bg-white'}`}>
                                    <span className="select-none text-gray-400 mr-2 text-xs w-5 inline-block text-right">+</span>
                                    <span className={`whitespace-pre-wrap break-all ${row.type === 'added' ? 'text-green-800 bg-green-200/50 rounded px-0.5' : 'text-gray-400'}`}>
                                        {row.right}
                                    </span>
                                </td>
                                )}
                              </tr>
                            )
                            : (
                              // unchanged context lines (collapsed)
                              <tr key={i} className="text-gray-400 hover:bg-gray-50">
                                <td colSpan={2} className="py-0.5 pl-8 pr-3 whitespace-pre-wrap break-all text-gray-500">
                                    <span className="select-none text-gray-300 mr-2 text-xs w-5 inline-block text-right">{' '}</span>
                                    {row.left || ''}
                                </td>
                              </tr>
                            )
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
                <div className="px-4 py-2 bg-gray-50 border-t border-gray-100 text-xs text-gray-400 shrink-0 flex justify-between">
                  <span><span className="text-green-600 font-medium">+{diffRows.filter(r => r.type === 'added').length} 新增</span> &nbsp; <span className="text-red-600 font-medium">-{diffRows.filter(r => r.type === 'removed').length} 删除</span></span>
                </div>
              </div>
            </div>
          )}

          {/* === Tab: QA Results === */}
          {activeSection === 'qa' && (
            <div className="space-y-4">
              {qaToShow.length === 0 && rolloutResults.length === 0 && selectionResults.length === 0 ? (
                <div className="text-gray-400 text-center py-12">该步骤暂无答题评估结果</div>
              ) : (
                <>
                  {/* Analysis guide */}
                  <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
                    <div className="text-xs font-medium text-blue-700 mb-2">分析角度</div>
                    <div className="grid grid-cols-2 gap-3 text-xs text-blue-800 leading-relaxed">
                      <div>
                        <div className="font-medium text-blue-900 mb-0.5">训练集（错误分析）</div>
                        <div>AI 用来分析错误的题目，看到哪些答错了 → 生成修改建议。高正确率说明修改有效；低正确率说明问题还没解决。</div>
                      </div>
                      <div>
                        <div className="font-medium text-blue-900 mb-0.5">验证集（新题检验）</div>
                        <div>AI 没见过的新题，用来检验修改是否有泛化能力。分数上升 = 真改进；分数下降 = 可能过拟合。</div>
                      </div>
                      <div className="col-span-2">
                        <div className="font-medium text-blue-900 mb-0.5">诊断视角</div>
                        <div>训练集↑验证集↑ → 真正进步 · 训练集↑验证集↓ → 过拟合，改坏了 · 训练集↓验证集↑ → 泛化性意外提升 · 都↓ → 修改方向错误</div>
                      </div>
                    </div>
                  </div>

                  {/* Dataset switcher */}
                  <div className="flex items-center gap-2">
                    {rolloutResults.length > 0 && (
                      <button
                        onClick={() => setQaDataset('rollout')}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                          qaDataset === 'rollout' ? 'bg-blue-50 text-blue-700' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                        }`}
                      >
                        训练集（错误分析）· {rolloutResults.filter(r => r.hard === 1).length}/{rolloutResults.length} 正确
                      </button>
                    )}
                    {selectionResults.length > 0 && (
                      <button
                        onClick={() => setQaDataset('selection')}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                          qaDataset === 'selection' ? 'bg-blue-50 text-blue-700' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                        }`}
                      >
                        验证集（新题检验）· {selectionResults.filter(r => r.hard === 1).length}/{selectionResults.length} 正确
                      </button>
                    )}
                  </div>

                  {qaToShow.length === 0 ? (
                    <div className="text-gray-400 text-center py-8">该数据集暂无评估数据</div>
                  ) : (
                    <div className="space-y-2">
                      <div className="flex items-center gap-4 text-xs text-gray-500">
                        <span>正确: <b className="text-green-600">{qaToShow.filter(r => r.hard === 1).length}</b></span>
                        <span>错误: <b className="text-red-600">{qaToShow.filter(r => r.hard === 0).length}</b></span>
                        <span>{qaDataset === 'rollout' ? '训练集' : '验证集'}</span>
                      </div>
                      {qaToShow.map((r) => (
                      <div
                        key={r.id}
                        className={`rounded-xl border p-4 cursor-pointer transition-colors hover:bg-gray-50 ${
                          r.hard === 1 ? 'border-green-200 bg-green-50/30' : 'border-red-200 bg-red-50/30'
                        }`}
                        onClick={() => setExpandedQaId(expandedQaId === r.id ? null : r.id)}
                      >
                        <div className="flex items-start gap-3">
                          <span className={`shrink-0 mt-0.5 ${r.hard === 1 ? 'text-green-500' : 'text-red-500'}`}>
                            {r.hard === 1 ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-gray-800 line-clamp-1">{r.question.slice(0, 80)}{r.question.length > 80 ? '...' : ''}</div>
                            <div className="flex items-center gap-3 mt-1.5">
                              <span className="text-xs"><span className="text-gray-400">预测:</span> <span className={`font-medium ${r.hard === 1 ? 'text-green-700' : 'text-red-600'}`}>{r.predicted_answer}</span></span>
                              <span className="text-xs"><span className="text-gray-400">标准:</span> <span className="font-medium text-gray-700">{r.gold_answers?.join(', ')}</span></span>
                              {r.fail_reason && <span className="text-xs text-red-400 truncate max-w-[200px]" title={r.fail_reason}>· {r.fail_reason}</span>}
                            </div>
                            {expandedQaId === r.id && (
                              <div className="mt-3 pt-3 border-t border-gray-200 space-y-2">
                                <div><span className="text-xs text-gray-400">完整问题:</span><p className="text-sm text-gray-800 mt-0.5">{r.question}</p></div>
                                <div><span className="text-xs text-gray-400">AI 完整回复:</span><pre className="text-xs text-gray-600 bg-white rounded-lg p-3 mt-0.5 whitespace-pre-wrap leading-relaxed font-sans max-h-32 overflow-auto">{r.response}</pre></div>
                              </div>
                            )}
                          </div>
                          <span className="shrink-0 text-xs text-gray-400">{expandedQaId === r.id ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                </>
              )}
            </div>
          )}

          {/* === Tab: Patches === */}
          {activeSection === 'patches' && (
            <div className="space-y-4">
              {!patches.reasoning && !patches.edits?.length ? (
                <div className="text-gray-400 text-center py-12">该步骤无修改数据（可能是跳过的步骤）</div>
              ) : (
                <>
                  {patches.reasoning && (
                    <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
                      <div className="text-xs font-medium text-blue-700 mb-1.5 flex items-center gap-1.5">
                        <MessageSquare className="w-3.5 h-3.5" /> 编辑理由（AI 分析为什么需要修改）
                      </div>
                      <pre className="text-xs text-blue-900 whitespace-pre-wrap leading-relaxed font-sans">{patches.reasoning}</pre>
                    </div>
                  )}
                  {patches.edits && patches.edits.length > 0 && (
                    <div className="space-y-2">
                      {/* 操作类型说明 */}
                      <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 grid grid-cols-4 gap-2 text-[10px]">
                        <div className="flex items-center gap-1.5">
                          <span className="font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 shrink-0">替换</span>
                          <span className="text-gray-500">修改已有规则</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="font-bold px-1.5 py-0.5 rounded bg-green-100 text-green-700 shrink-0">追加</span>
                          <span className="text-gray-500">末尾新增规则</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="font-bold px-1.5 py-0.5 rounded bg-green-100 text-green-700 shrink-0">插入</span>
                          <span className="text-gray-500">中间插入规则</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-700 shrink-0">删除</span>
                          <span className="text-gray-500">移除过时规则</span>
                        </div>
                      </div>

                      <div className="text-xs font-medium text-gray-500">编辑列表 ({patches.edits.length} 条)</div>
                      {patches.edits.map((edit: any, i) => {
                        const op = edit.op || 'unknown'
                        // 兼容多种字段命名: target/old_string, content/new_string
                        const oldStr = edit.old_string || edit.target || ''
                        const newStr = edit.new_string || edit.content || ''
                        const hasChange = oldStr || newStr
                        return (
                        <div key={i} className="border border-gray-200 rounded-xl p-4 bg-gray-50">
                          <div className="flex items-center gap-2 mb-2">
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                              op === 'replace' ? 'bg-amber-100 text-amber-700' :
                              (op === 'insert' || op === 'append') ? 'bg-green-100 text-green-700' :
                              op === 'delete' ? 'bg-red-100 text-red-700' :
                              'bg-gray-100 text-gray-700'
                            }`}>
                              #{i + 1} {op === 'replace' ? '替换' : op === 'append' ? '追加' : op === 'insert' ? '插入' : op === 'delete' ? '删除' : op.toUpperCase()}
                              <span className="font-normal text-gray-400 ml-1">
                                {op === 'replace' ? '(修改已有规则)' : op === 'append' ? '(末尾新增)' : op === 'insert' ? '(中间插入)' : op === 'delete' ? '(移除内容)' : ''}
                              </span>
                            </span>
                            {edit.path && <span className="text-[11px] text-gray-400 font-mono">{edit.path}</span>}
                            {edit.source_type && (
                              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                                edit.source_type === 'failure' ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-600'
                              }`}>
                                {edit.source_type === 'failure' ? '失败驱动' : '成功驱动'}
                              </span>
                            )}
                            {edit.support_count != null && (
                              <span className="text-[10px] text-gray-400">支持数: {edit.support_count}</span>
                            )}
                          </div>
                          {hasChange ? (
                            <>
                              {oldStr && (
                                <div className="mb-2">
                                  <div className="text-[10px] text-gray-400 mb-0.5">{op === 'append' ? '位置参考 (target):' : '删除内容:'}</div>
                                  <pre className="text-xs bg-red-50 text-red-800 rounded-lg p-2.5 whitespace-pre-wrap font-mono leading-relaxed max-h-32 overflow-auto">{oldStr}</pre>
                                </div>
                              )}
                              {newStr && (
                                <div>
                                  <div className="text-[10px] text-gray-400 mb-0.5">{op === 'append' || op === 'insert' ? '新增内容:' : '替换为:'}</div>
                                  <pre className="text-xs bg-green-50 text-green-800 rounded-lg p-2.5 whitespace-pre-wrap font-mono leading-relaxed max-h-32 overflow-auto">{newStr}</pre>
                                </div>
                              )}
                            </>
                          ) : (
                            <div className="text-xs text-gray-400 italic">无详细修改内容</div>
                          )}
                        </div>
                        )})}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* === Tab: Reason === */}
          {activeSection === 'reason' && (
            <div className="space-y-4 max-w-2xl">
              <div className={`rounded-xl p-5 ${step.action === 'accept' ? 'bg-green-50 border border-green-200' : step.action === 'reject' ? 'bg-red-50 border border-red-200' : 'bg-gray-50 border border-gray-200'}`}>
                <div className="flex items-center gap-2 mb-3">
                  {step.action === 'accept' ? <CheckCircle className="w-5 h-5 text-green-600" /> :
                   step.action === 'reject' ? <XCircle className="w-5 h-5 text-red-600" /> :
                   <span className="w-5 h-5 rounded-full border-2 border-gray-300" />}
                  <h4 className="font-bold text-base">
                    {step.action === 'accept' ? '接受原因' : step.action === 'reject' ? '拒绝原因' : '跳过原因'}
                  </h4>
                </div>
                <p className={`text-sm leading-relaxed ${step.action === 'accept' ? 'text-green-800' : step.action === 'reject' ? 'text-red-800' : 'text-gray-700'}`}>
                  {decisionReason}
                </p>
              </div>

              {/* Detailed metrics */}
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-white border border-gray-200 rounded-xl p-4">
                  <div className="text-xs text-gray-400 mb-1">当前分数 <span className="text-gray-300">(当前规则在验证集上的得分)</span></div>
                  <div className="text-xl font-bold text-gray-900">{step.current_score != null ? `${(step.current_score * 100).toFixed(1)}%` : '-'}</div>
                </div>
                <div className="bg-white border border-gray-200 rounded-xl p-4">
                  <div className="text-xs text-gray-400 mb-1">候选分数 <span className="text-gray-300">(修改后规则在验证集上的得分)</span></div>
                  <div className="text-xl font-bold text-gray-900">{step.candidate_gate_score != null ? `${(step.candidate_gate_score * 100).toFixed(1)}%` : '-'}</div>
                </div>
                <div className="bg-white border border-gray-200 rounded-xl p-4">
                  <div className="text-xs text-gray-400 mb-1">历史最佳 <span className="text-gray-300">(验证集历史最高)</span></div>
                  <div className="text-xl font-bold text-blue-600">{step.best_score != null ? `${(step.best_score * 100).toFixed(1)}%` : '-'}</div>
                </div>
                <div className="bg-white border border-gray-200 rounded-xl p-4 col-span-2">
                  <div className="text-xs text-gray-400 mb-2">判断标准（决定接受/拒绝的依据）</div>
                  <div className="flex items-center gap-3">
                    <span className={`text-sm font-bold px-2 py-0.5 rounded ${
                      step.gate_metric === 'hard' ? 'bg-blue-100 text-blue-700' :
                      step.gate_metric === 'soft' ? 'bg-purple-100 text-purple-700' :
                      step.gate_metric === 'mixed' ? 'bg-amber-100 text-amber-700' :
                      'bg-gray-100 text-gray-700'
                    }`}>
                      {step.gate_metric === 'hard' ? '硬匹配' : step.gate_metric === 'soft' ? '软匹配' : step.gate_metric === 'mixed' ? '混合匹配' : step.gate_metric || '-'}
                    </span>
                    <span className="text-xs text-gray-500">
                      {step.gate_metric === 'hard' ? '答案完全一致才算对，分数严格' :
                       step.gate_metric === 'soft' ? '答案语义相似即可，分数宽容' :
                       step.gate_metric === 'mixed' ? '硬匹配 + 软匹配加权平均' :
                       '未知指标'}
                    </span>
                  </div>
                  <div className="mt-3 pt-3 border-t border-gray-100 text-xs text-gray-400">
                    {step.gate_metric === 'hard' ? '候选分数 > 当前分数 → 接受，否则拒绝' :
                     step.gate_metric === 'soft' ? '候选分数 > 当前分数 → 接受，否则拒绝（语义匹配更宽容，更容易通过）' :
                     step.gate_metric === 'mixed' ? '候选分数 > 当前分数 → 接受，否则拒绝' :
                     ''}
                    {step.gate_metric && step.gate_metric !== '-' ? <span className="ml-2 text-gray-300">| 可在训练配置中修改判断标准类型</span> : ''}
                  </div>
                </div>
              </div>

              {/* Raw action */}
              <div className="bg-gray-50 rounded-xl p-4">
                <div className="text-xs text-gray-400 mb-1">原始动作标识</div>
                <code className="text-sm text-gray-800 font-mono bg-white rounded-lg px-3 py-1.5 inline-block">{step.rawAction}</code>
              </div>

              {/* Timing breakdown */}
              {step.timing && (
                <div className="bg-gray-50 rounded-xl p-4">
                  <div className="text-xs text-gray-400 mb-2">时间分解</div>
                  <div className="flex gap-4 text-sm">
                    <div><span className="text-gray-500">执行:</span> <b>{step.timing.rollout_s?.toFixed(1)}s</b></div>
                    <div><span className="text-gray-500">反思:</span> <b>{step.timing.reflect_s?.toFixed(1)}s</b></div>
                    <div><span className="text-gray-500">总耗时:</span> <b>{step.wall_time_s?.toFixed(1)}s</b></div>
                  </div>
                </div>
              )}

              {/* Token usage from record */}
              {record.tokens && Object.keys(record.tokens).length > 0 && (
                <div className="bg-gray-50 rounded-xl p-4">
                  <div className="text-xs text-gray-400 mb-2">AI 调用量 <span className="text-gray-300">(Token: AI 处理文本的计量单位)</span></div>
                  <div className="space-y-2">
                    {Object.entries(record.tokens).map(([key, val]) => (
                      <div key={key} className="bg-white border border-gray-200 rounded-lg p-3">
                        <div className="text-[11px] text-gray-500 font-medium mb-1.5 capitalize">{key.replace(/_/g, ' ')}</div>
                        {typeof val === 'object' && val !== null ? (
                          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs font-mono">
                            {Object.entries(val as Record<string, unknown>).map(([k, v]) => (
                              <div key={k} className="flex justify-between">
                                <span className="text-gray-500">{k}:</span>
                                <span className="text-gray-800 font-medium">{typeof v === 'number' ? v.toLocaleString() : String(v)}</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <code className="text-sm font-mono text-gray-800 break-all">{typeof val === 'number' ? val.toLocaleString() : JSON.stringify(val)}</code>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  )
}

// Helper used in StepDetailModal
function getSkipReason(rawAction: string): string {
  switch (rawAction) {
    case 'skip_no_patches': return '未生成任何 patch'
    case 'skip_no_rewrite': return '未生成重写内容'
    case 'skip_no_improvement': return '无改进'
    case 'skip_first_epoch': return '首轮跳过'
    case 'no_content': return '未产出内容'
    default: return rawAction
  }
}

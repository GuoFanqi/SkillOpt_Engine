import { useSearchParams } from 'react-router-dom'
import { GitCompare, ArrowRightLeft } from 'lucide-react'
import { diffLines } from 'diff'
import { useMemo, useState, useEffect } from 'react'
import { fetchSkillVersions, fetchSkillContent, fetchTrainingRuns } from '../services/api'
import { SkillVersion, TrainingRun } from '../types'

export default function Compare() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [viewMode, setViewMode] = useState<'unified' | 'split'>('unified')

  // 同一个训练任务
  const [allRuns, setAllRuns] = useState<TrainingRun[]>([])
  const [runId, setRunId] = useState(searchParams.get('run') || '')

  // 该任务下的所有版本
  const [versions, setVersions] = useState<SkillVersion[]>([])
  const [selectedV1, setSelectedV1] = useState(searchParams.get('v1') || 'initial')
  const [selectedV2, setSelectedV2] = useState(searchParams.get('v2') || 'best')

  const [contentV1, setContentV1] = useState('')
  const [contentV2, setContentV2] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Load run list on mount
  useEffect(() => {
    fetchTrainingRuns().then(setAllRuns).catch(console.error)
  }, [])

  // Sync searchParams
  useEffect(() => {
    const params: Record<string, string> = {}
    if (runId) params.run = runId
    if (selectedV1) params.v1 = selectedV1
    if (selectedV2) params.v2 = selectedV2
    setSearchParams(params, { replace: true })
  }, [runId, selectedV1, selectedV2])

  // Load versions when run selected
  useEffect(() => {
    if (!runId) { setVersions([]); return }
    setError('')
    const decoded = decodeURIComponent(runId)
    fetchSkillVersions(decoded)
      .then((data) => {
        setVersions(data)
        // 有 versions 时自动设默认值
        const hasInitial = data.some((v) => v.version === 'initial')
        const hasBest = data.some((v) => v.version === 'best')
        if (hasInitial && hasBest) {
          setSelectedV1('initial')
          setSelectedV2('best')
        } else if (data.length >= 2) {
          setSelectedV1(data[0].version)
          setSelectedV2(data[data.length - 1].version)
        } else if (data.length === 1) {
          setSelectedV1(data[0].version)
          setSelectedV2(data[0].version)
        }
      })
      .catch(() => setVersions([]))
  }, [runId])

  // Load contents when versions change
  useEffect(() => {
    if (!runId || !selectedV1 || !selectedV2) return
    setLoading(true)
    setError('')
    const decoded = decodeURIComponent(runId)
    Promise.all([
      fetchSkillContent(decoded, selectedV1),
      fetchSkillContent(decoded, selectedV2),
    ])
      .then(([v1, v2]) => {
        if (v1 === undefined || v2 === undefined) {
          setError('无法加载所选版本内容')
          setContentV1('')
          setContentV2('')
        } else {
          setContentV1(v1)
          setContentV2(v2)
        }
      })
      .catch(() => {
        setError('加载失败，请重试')
        setContentV1('')
        setContentV2('')
      })
      .finally(() => setLoading(false))
  }, [runId, selectedV1, selectedV2])

  const swapVersions = () => {
    setSelectedV1(selectedV2)
    setSelectedV2(selectedV1)
  }

  const diff = useMemo(() => {
    return diffLines(contentV1, contentV2)
  }, [contentV1, contentV2])

  const stats = useMemo(() => {
    let added = 0
    let removed = 0
    let unchanged = 0
    diff.forEach((part) => {
      const lines = part.value.split('\n').filter((l) => l.length > 0).length
      if (part.added) added += lines
      else if (part.removed) removed += lines
      else unchanged += lines
    })
    return { added, removed, unchanged }
  }, [diff])

  const run = allRuns.find((r) => r.id === runId)
  const v1Label = versions.find((v) => v.version === selectedV1)?.path || selectedV1
  const v2Label = versions.find((v) => v.version === selectedV2)?.path || selectedV2

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900 mb-2">版本对比</h1>
        <p className="text-gray-500">对比同一训练任务中两个版本的 Skill 差异</p>
      </div>

      {/* Selectors */}
      <div className="card bg-gray-50 rounded-2xl p-5 mb-6">
        {/* Step 1: Choose run */}
        <div className="mb-4">
          <label className="block text-xs font-medium text-gray-500 mb-1.5">选择训练任务</label>
          <select
            value={runId}
            onChange={(e) => setRunId(e.target.value)}
            className="w-full max-w-lg px-4 py-2.5 bg-white rounded-xl text-sm font-medium text-gray-700 border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-200"
          >
            <option value="">-- 选择训练任务 --</option>
            {allRuns.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} — 验证集 {r.currentScore}%，{versions.length || '?'} 个版本
              </option>
            ))}
          </select>
        </div>

        {/* Step 2: Choose two versions */}
        {runId && versions.length > 0 && (
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <label className="block text-xs font-medium text-gray-500 mb-1.5">基准版本（左）</label>
              <select
                value={selectedV1}
                onChange={(e) => setSelectedV1(e.target.value)}
                className="w-full px-4 py-2 bg-white rounded-xl text-sm border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-200"
              >
                {versions.map((v) => (
                  <option key={v.version} value={v.version}>
                    {v.path} ({v.chars} 字符)
                  </option>
                ))}
              </select>
            </div>

            <button
              onClick={swapVersions}
              className="p-2.5 bg-white rounded-xl border border-gray-200 hover:bg-gray-50 mt-5 shrink-0"
              title="交换版本"
            >
              <ArrowRightLeft className="w-5 h-5 text-gray-500" />
            </button>

            <div className="flex-1">
              <label className="block text-xs font-medium text-gray-500 mb-1.5">对比版本（右）</label>
              <select
                value={selectedV2}
                onChange={(e) => setSelectedV2(e.target.value)}
                className="w-full px-4 py-2 bg-white rounded-xl text-sm border border-gray-200 focus:outline-none focus:ring-2 focus:ring-green-200"
              >
                {versions.map((v) => (
                  <option key={v.version} value={v.version}>
                    {v.path} ({v.chars} 字符)
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {runId && versions.length === 0 && !loading && (
          <p className="text-sm text-gray-400 mt-2">该任务暂无版本记录</p>
        )}
      </div>

      {/* No selection hint */}
      {!runId && (
        <div className="card bg-gray-50 rounded-2xl p-12 flex flex-col items-center justify-center gap-4">
          <GitCompare className="w-12 h-12 text-gray-300" />
          <p className="text-gray-500 text-sm">请先选择一个训练任务，再选择两个版本进行对比</p>
        </div>
      )}

      {/* Diff view */}
      {runId && selectedV1 && selectedV2 && !loading && !error && contentV1 && contentV2 && (
        <>
          {/* Stats bar */}
          <div className="flex items-center gap-6 mb-4 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-500">任务：</span>
              <span className="text-sm font-medium text-gray-900">{run?.name || runId}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-500">对比：</span>
              <span className="text-xs px-2 py-0.5 bg-blue-50 text-blue-700 rounded font-mono">{v1Label}</span>
              <span className="text-gray-300">→</span>
              <span className="text-xs px-2 py-0.5 bg-green-50 text-green-700 rounded font-mono">{v2Label}</span>
            </div>
            <div className="flex-1" />
            <div className="flex items-center gap-3">
              <button
                onClick={() => setViewMode('unified')}
                className={`text-xs px-3 py-1 rounded-lg ${viewMode === 'unified' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'}`}
              >
                统一视图
              </button>
              <button
                onClick={() => setViewMode('split')}
                className={`text-xs px-3 py-1 rounded-lg ${viewMode === 'split' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600'}`}
              >
                分屏视图
              </button>
            </div>
            <div className="flex items-center gap-4 text-xs text-gray-500">
              <span className="text-green-600 font-medium">+{stats.added} 新增</span>
              <span className="text-red-600 font-medium">-{stats.removed} 删除</span>
              <span>{stats.unchanged} 未变</span>
            </div>
          </div>

          {/* Diff content */}
          <div className="card bg-gray-50 rounded-2xl overflow-hidden">
            {viewMode === 'unified' ? (
              <div className="p-6 font-mono text-sm leading-relaxed whitespace-pre-wrap max-h-[600px] overflow-auto">
                {diff.map((part, i) => {
                  const bg = part.added ? 'bg-green-50 text-green-800' : part.removed ? 'bg-red-50 text-red-800' : 'text-gray-700'
                  const prefix = part.added ? '+ ' : part.removed ? '- ' : '  '
                  return (
                    <div key={i} className={`${bg} px-3 py-0.5`}>
                      {part.value.split('\n').map((line, j) => (
                        <div key={j}>{line ? prefix + line : ''}</div>
                      ))}
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="grid grid-cols-2 divide-x divide-gray-200">
                <div>
                  <div className="px-4 py-2 bg-blue-50 text-blue-700 text-xs font-medium border-b border-gray-200">
                    {v1Label}
                  </div>
                  <div className="p-6 font-mono text-sm leading-relaxed whitespace-pre-wrap text-gray-700 overflow-auto max-h-[600px]">
                    {contentV1}
                  </div>
                </div>
                <div>
                  <div className="px-4 py-2 bg-green-50 text-green-700 text-xs font-medium border-b border-gray-200">
                    {v2Label}
                  </div>
                  <div className="p-6 font-mono text-sm leading-relaxed whitespace-pre-wrap text-gray-700 overflow-auto max-h-[600px]">
                    {contentV2}
                  </div>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {runId && selectedV1 && selectedV2 && error && (
        <div className="card bg-red-50 rounded-2xl p-8 text-center">
          <p className="text-red-600 text-sm">{error}</p>
        </div>
      )}

      {runId && selectedV1 && selectedV2 && loading && (
        <div className="flex items-center justify-center h-64 text-gray-400">加载中...</div>
      )}
    </div>
  )
}

import { Link } from 'react-router-dom'
import { FileText, TrendingUp, Layers } from 'lucide-react'
import { useEffect, useState } from 'react'
import { fetchTrainingRuns, fetchSkillContent } from '../services/api'
import { TrainingRun } from '../types'
import { ListSkeleton } from '../components/Loading'

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

export default function SkillBrowser() {
  const [runs, setRuns] = useState<TrainingRun[]>([])
  const [skills, setSkills] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchTrainingRuns()
      .then((data) => {
        setRuns(data)
        // Load best skill for each run
        data.forEach(async (run) => {
          try {
            const content = await fetchSkillContent(run.id, 'best')
            setSkills((prev) => ({ ...prev, [run.id]: content || '' }))
          } catch {
            setSkills((prev) => ({ ...prev, [run.id]: '' }))
          }
        })
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <ListSkeleton rows={4} />

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900 mb-2">技能查看</h1>
        <p className="text-gray-500">查看和编辑所有训练的最佳技能</p>
      </div>

      {runs.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 gap-4">
          <Layers className="w-12 h-12 text-gray-300" />
          <p className="text-gray-500">暂无训练任务</p>
          <Link to="/" className="btn-primary">返回仪表盘新建训练</Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {runs.map((run) => {
            const skillContent = skills[run.id] || ''
            const preview = skillContent
              ? skillContent.replace(/<!--[\s\S]*?-->/g, '').trim().split('\n').slice(0, 6).join('\n')
              : '(无内容)'
            const lineCount = skillContent ? skillContent.split('\n').length : 0
            const charCount = skillContent.length

            return (
              <Link
                key={run.id}
                to={`/skill/${encodeURIComponent(run.id)}`}
                className="card bg-gray-50 rounded-2xl p-5 card-hover block"
              >
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-blue-100 rounded-xl flex items-center justify-center">
                      <FileText className="w-5 h-5 text-blue-600" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-gray-900 text-sm">{run.name}</h3>
                      <span className="text-xs text-gray-500">{lineCount} 行 · {charCount} 字符</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-900 flex items-center gap-1">
                      <TrendingUp className="w-3.5 h-3.5 text-purple-500" />
                      {run.currentScore}%
                    </span>
                  </div>
                </div>
                <div className="bg-white rounded-xl p-3 border border-gray-100">
                  <pre className="text-xs text-gray-600 whitespace-pre-wrap font-mono leading-relaxed max-h-32 overflow-hidden">
                    {preview || '(空技能)'}
                  </pre>
                </div>
                <div className="mt-3 flex items-center gap-4 text-xs text-gray-400">
                  <span>模型：{run.model}</span>
                  <span>接受率：{run.acceptRate}%</span>
                  <span>{run.totalSteps} 步骤</span>
                  {run.createdAt && <span>{formatDate(run.createdAt)}</span>}
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}

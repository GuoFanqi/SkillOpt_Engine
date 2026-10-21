import { useParams, Link, useSearchParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Save, Loader2, CheckCircle, AlertCircle } from 'lucide-react'
import Editor from '@monaco-editor/react'
import { useState, useEffect } from 'react'
import { fetchSkillContent, fetchSkillVersions, fetchTrainingRuns, saveSkill } from '../services/api'
import { SkillVersion, TrainingRun } from '../types'

export default function SkillEditor() {
  const { id: urlId } = useParams<{ id?: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const backTo = searchParams.has('step') ? `/training/${urlId}` : '/skill'

  const [allRuns, setAllRuns] = useState<TrainingRun[]>([])
  const [skill, setSkill] = useState('')
  const [versions, setVersions] = useState<SkillVersion[]>([])
  const [selectedVersion, setSelectedVersion] = useState('best')
  const [isSaved, setIsSaved] = useState(true)
  const [loading, setLoading] = useState(true)
  const [saveLoading, setSaveLoading] = useState(false)
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    fetchTrainingRuns().then(setAllRuns).catch(() => {})
  }, [])

  useEffect(() => {
    loadData()
  }, [urlId, selectedVersion])

  const loadData = async () => {
    if (!urlId) {
      setLoading(false)
      setSkill('')
      return
    }
    setLoading(true)
    try {
      const decodedId = decodeURIComponent(urlId)
      const [versionsData, skillData] = await Promise.all([
        fetchSkillVersions(decodedId),
        fetchSkillContent(decodedId, selectedVersion),
      ])
      setVersions(versionsData)
      setSkill(skillData || '')
    } catch (error) {
      console.error('Failed to load skill:', error)
      setSkill('')
    } finally {
      setLoading(false)
    }
  }

  const handleRunChange = (newId: string) => {
    navigate(`/skill/${encodeURIComponent(newId)}`)
  }

  const handleEditorChange = (value: string | undefined) => {
    setSkill(value || '')
    setIsSaved(false)
    setSaveMessage(null)
  }

  const handleSave = async () => {
    if (!urlId || isSaved) return
    
    setSaveLoading(true)
    setSaveMessage(null)
    
    try {
      const decodedId = decodeURIComponent(urlId)
      const run = allRuns.find(r => r.id === decodedId)
      
      await saveSkill({
        skillId: decodedId,
        skillName: run?.name || 'Untitled Skill',
        skillContent: skill,
        description: 'Saved from Skill Editor',
      })
      
      setIsSaved(true)
      setSaveMessage({ type: 'success', text: '技能保存成功！' })
    } catch (error) {
      console.error('Failed to save skill:', error)
      setSaveMessage({ type: 'error', text: '保存失败：' + (error as any).message })
    } finally {
      setSaveLoading(false)
      setTimeout(() => setSaveMessage(null), 3000)
    }
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Link to={backTo} className="p-2 hover:bg-gray-100 rounded-xl">
            <ArrowLeft className="w-5 h-5 text-gray-600" />
          </Link>
          {allRuns.length > 1 && (
            <select
              value={urlId || ''}
              onChange={(e) => handleRunChange(e.target.value)}
              className="px-3 py-2 bg-gray-100 rounded-xl text-sm font-medium text-gray-700 border-none min-w-[200px]"
            >
              {allRuns.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          )}
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-gray-100 rounded-xl flex items-center justify-center">
              <span className="text-gray-600 text-sm font-mono">{}</span>
            </div>
            <span className="font-semibold text-gray-900">best_skill.md</span>
            <select
              value={selectedVersion}
              onChange={(e) => setSelectedVersion(e.target.value)}
              className="px-3 py-1 bg-gray-100 rounded-lg text-sm border-none"
            >
              <option value="best">最佳版本</option>
              {versions.map((v) => (
                <option key={v.version} value={v.version}>
                  {v.name} ({v.chars} chars)
                </option>
              ))}
            </select>
            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
              isSaved ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'
            }`}>
              {isSaved ? '已保存' : '未保存'}
            </span>
          </div>
        </div>
        <div className="flex gap-3">
          {saveMessage && (
            <div className={`flex items-center gap-2 px-3 py-2 rounded-xl ${
              saveMessage.type === 'success' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
            }`}>
              {saveMessage.type === 'success' ? (
                <CheckCircle className="w-4 h-4" />
              ) : (
                <AlertCircle className="w-4 h-4" />
              )}
              <span className="text-sm">{saveMessage.text}</span>
            </div>
          )}
          <button
            onClick={handleSave}
            disabled={saveLoading || isSaved}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors ${
              saveLoading || isSaved
                ? 'bg-gray-200 text-gray-500 cursor-not-allowed'
                : 'bg-indigo-500 text-white hover:bg-indigo-600'
            }`}
          >
            {saveLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                保存中...
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                保存更改
              </>
            )}
          </button>
        </div>
      </div>

      {/* Editor */}
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        {/* Toolbar */}
        <div className="px-8 py-3 bg-gray-50/50 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-500">
              版本：{selectedVersion} | {skill.length} 字符
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400">
              最后更新：{versions.find((v) => v.version === selectedVersion)?.timestamp || '-'}
            </span>
          </div>
        </div>

        {/* Editor Content */}
        <div className="grid grid-cols-2" style={{ minHeight: '500px' }}>
          {/* Monaco Editor */}
          <div className="border-r border-gray-100">
            {loading ? (
              <div className="flex items-center justify-center h-full text-gray-500">
                <Loader2 className="w-6 h-6 animate-spin mr-2" />
                加载中...
              </div>
            ) : (
              <Editor
                height="500px"
                defaultLanguage="markdown"
                value={skill}
                onChange={handleEditorChange}
                theme="vs-light"
                options={{
                  minimap: { enabled: false },
                  fontSize: 14,
                  lineNumbers: 'on',
                  wordWrap: 'on',
                  padding: { top: 16 },
                }}
              />
            )}
          </div>

          {/* Preview */}
          <div className="p-6 overflow-auto bg-white">
            <div className="text-xs text-gray-400 mb-3">预览</div>
            <div className="prose prose-sm max-w-none">
              <pre className="whitespace-pre-wrap text-sm text-gray-700 font-sans">{skill}</pre>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-8 py-3 bg-gray-50/50 border-t border-gray-100 flex items-center justify-between text-xs text-gray-400">
          <span>Markdown 编辑器</span>
          <span>UTF-8</span>
        </div>
      </div>
    </div>
  )
}
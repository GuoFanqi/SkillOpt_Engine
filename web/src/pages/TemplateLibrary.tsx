import { useState, useMemo, useEffect } from 'react'
import { Search, TrendingUp, BarChart3, Clock, ChevronRight, Zap, Copy, Check, Edit2, Save, X, Plus, Trash2 } from 'lucide-react'
import { TEMPLATES, CATEGORIES, SkillTemplate, DEFAULT_CONFIG, DEFAULT_METRICS } from '../data/templates'
import { NewTrainingConfig } from '../components/NewTrainingModal'
import { startTraining, fetchTemplates, saveTemplate as apiSaveTemplate, deleteTemplate as apiDeleteTemplate } from '../services/api'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../components/Toast'
import { useNavigate } from 'react-router-dom'

interface TemplateLibraryProps {
  allTemplates?: SkillTemplate[]
}

function DatasetPreview({ tpl }: { tpl: SkillTemplate }) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)
  // 合并训练+验证集为一个列表，用 isTrain 标记
  const allItems = useMemo(() => {
    const ratio = tpl.splitRatio ?? 0.8
    const total = tpl.trainQa.length + tpl.valQa.length
    const splitAt = total > 0 ? tpl.trainQa.length : 0
    return [...tpl.trainQa, ...tpl.valQa].map((qa, i) => ({
      ...qa,
      isTrain: i < splitAt,
      idx: i,
    }))
  }, [tpl])

  return (
    <div className="bg-gray-50 rounded-xl overflow-hidden border border-gray-100">
      <div className="px-3 py-2 bg-white border-b border-gray-100 flex items-center justify-between">
        <span className="text-[11px] text-gray-500">
          📊 数据集（共 {allItems.length} 题）
        </span>
        <span className="text-[10px] text-gray-400">
          训练 {(tpl.splitRatio ?? 0.8) * 100}% / 验证 {Math.round((1 - (tpl.splitRatio ?? 0.8)) * 100)}%
        </span>
      </div>
      <div className="max-h-[260px] overflow-auto">
        {allItems.map((qa) => {
          const isOpen = expandedIdx === qa.idx
          return (
            <div
              key={qa.idx}
              className={`border-b border-gray-100 last:border-b-0 ${
                isOpen ? 'bg-white' : 'bg-gray-50/50 hover:bg-white'
              }`}
            >
              <button
                onClick={() => setExpandedIdx(isOpen ? null : qa.idx)}
                className="w-full text-left px-3 py-2 flex items-start gap-2"
              >
                <span className={`shrink-0 w-5 h-5 rounded-md flex items-center justify-center text-[9px] font-bold ${
                  qa.isTrain ? 'bg-blue-100 text-blue-600' : 'bg-emerald-100 text-emerald-600'
                }`}>
                  {qa.idx + 1}
                </span>
                <span className="text-[11px] text-gray-700 line-clamp-1 flex-1">
                  {qa.question.slice(0, 60)}{qa.question.length > 60 ? '…' : ''}
                </span>
                <span className={`shrink-0 text-[9px] px-1.5 py-0.5 rounded ${
                  qa.isTrain ? 'bg-blue-50 text-blue-500' : 'bg-emerald-50 text-emerald-500'
                }`}>
                  {qa.isTrain ? '训练' : '验证'}
                </span>
                <ChevronRight className={`w-3 h-3 text-gray-300 shrink-0 mt-0.5 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
              </button>
              {isOpen && (
                <div className="px-3 pb-3 pl-10 space-y-2">
                  <div>
                    <div className="text-[10px] text-gray-400 mb-1">问题</div>
                    <div className="text-[11px] text-gray-800 leading-relaxed whitespace-pre-wrap">{qa.question}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-gray-400 mb-1">参考答案 ({qa.answers.length} 个)</div>
                    {qa.answers.map((ans, ai) => (
                      <div key={ai} className="text-[11px] text-gray-700 bg-gray-50 rounded-lg p-2.5 mt-1 leading-relaxed whitespace-pre-wrap border border-gray-100">
                        {ans.length > 300 ? ans.slice(0, 300) + '\n…(截断)' : ans}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function TemplateLibrary({ allTemplates }: TemplateLibraryProps) {
  const { user, loading: authLoading } = useAuth()
  const { showToast } = useToast()
  const isLoggedIn = !!user
  const [templates, setTemplates] = useState<SkillTemplate[]>(allTemplates || [])
  const [templatesLoaded, setTemplatesLoaded] = useState(false)

  // Load templates from API
  useEffect(() => {
    if (authLoading) return // Wait until auth state is known
    if (allTemplates) { setTemplates(allTemplates); setTemplatesLoaded(true); return }
    fetchTemplates().then(custom => {
      const builtInIds = new Set(TEMPLATES.map(t => t.id))
      if (isLoggedIn) {
        // Logged-in users: see built-in templates + own custom templates
        const extraCustom = custom.filter(t => !builtInIds.has(t.id))
        setTemplates([...TEMPLATES, ...extraCustom])
      } else {
        // Guest: show built-in TEMPLATES + custom from API (dedup)
        const extraCustom = custom.filter(t => !builtInIds.has(t.id))
        setTemplates([...TEMPLATES, ...extraCustom])
      }
    }).catch(() => {}).finally(() => setTemplatesLoaded(true))
  }, [allTemplates, isLoggedIn, authLoading])

  const saveTemplates = async (newTemplates: SkillTemplate[]) => {
    setTemplates(newTemplates)
    // Save custom (non-built-in) templates to API
    const builtInIds = new Set(TEMPLATES.map(t => t.id))
    for (const tpl of newTemplates) {
      if (!builtInIds.has(tpl.id)) {
        try { await apiSaveTemplate(tpl) } catch {}
      }
    }
  }

  const [searchQuery, setSearchQuery] = useState('')
  const [activeCategory, setActiveCategory] = useState('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [useModalId, setUseModalId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTemplate, setEditingTemplate] = useState<SkillTemplate | null>(null)
  const [isNewTemplate, setIsNewTemplate] = useState(false)
  const [showNewTemplateModal, setShowNewTemplateModal] = useState(false)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const navigate = useNavigate()

  const handleSaveTemplate = () => {
    if (!editingTemplate) return
    saveTemplates(templates.map(t => t.id === editingTemplate.id ? editingTemplate : t))
    setEditingId(null)
    setEditingTemplate(null)
    setIsNewTemplate(false)
  }

  const handleDeleteTemplate = (id: string) => {
    setDeleteConfirmId(id)
  }

  const confirmDeleteTemplate = async () => {
    if (!deleteConfirmId) return
    const newTemplates = templates.filter(t => t.id !== deleteConfirmId)
    setTemplates(newTemplates)
    setExpandedId(null)
    setDeleteConfirmId(null)
    try { await apiDeleteTemplate(deleteConfirmId) } catch {}
  }

  const handleCreateTemplate = (nameOverride?: string) => {
    const name = nameOverride?.trim() || '新建案例'
    const newTemplate: SkillTemplate = {
      id: `custom-${Date.now()}`,
      name,
      description: '自定义案例描述',
      icon: '📝',
      category: 'analysis',
      difficulty: 'medium',
      skillContent: '# 自定义 Skill\n\n## 角色\n你是一位专家。\n\n## 任务\n描述你的任务。',
      trainQa: [{ question: '示例问题', answers: ['示例答案'] }],
      valQa: [],
      splitRatio: 0.8,
      config: { ...DEFAULT_CONFIG },
      expectedMetrics: { ...DEFAULT_METRICS },
      highlights: ['自定义案例'],
    }
    // Don't save yet — wait for user to edit first
    setTemplates(prev => [...prev, newTemplate])
    setEditingId(newTemplate.id)
    setEditingTemplate(newTemplate)
    setIsNewTemplate(true)
    setShowNewTemplateModal(false)
  }

  const handleCancelEdit = () => {
    // If editing a newly created template that hasn't been saved yet, remove it
    if (editingTemplate && editingTemplate.id.startsWith('custom-') && isNewTemplate) {
      setTemplates(prev => prev.filter(t => t.id !== editingTemplate.id))
    }
    setEditingId(null)
    setEditingTemplate(null)
    setIsNewTemplate(false)
  }

  const filtered = useMemo(() => {
    return templates.filter(t => {
      const matchCat = activeCategory === 'all' || t.category === activeCategory
      const q = searchQuery.toLowerCase()
      const matchSearch = !q ||
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.highlights.some(h => h.toLowerCase().includes(q))
      return matchCat && matchSearch
    })
  }, [templates, activeCategory, searchQuery])

  const handleUseTemplate = async (e: React.FormEvent, tpl: SkillTemplate) => {
    e.preventDefault()
    if (!isLoggedIn) {
      showToast('info', '请先登录后再使用模板创建训练')
      return
    }
    const form = e.target as HTMLFormElement
    const formData = new FormData(form)
    const trainingName = (formData.get('trainingName') as string).trim() || `${tpl.name} - 训练`

    const trainContent = tpl.trainQa.map(q => ({
      question: q.question,
      answers: q.answers,
    }))
    const valContent = tpl.valQa.map(q => ({
      question: q.question,
      answers: q.answers,
    }))

    const trainJsonl = trainContent.map(q => JSON.stringify(q)).join('\n')
    const valJsonl = valContent.map(q => JSON.stringify(q)).join('\n')

    const trainFile = new File([trainJsonl], 'train.jsonl', { type: 'application/jsonl' })
    const valFile = new File([valJsonl], 'val.jsonl', { type: 'application/jsonl' })
    const skillFile = new File([tpl.skillContent], 'initial_skill.md', { type: 'text/markdown' })

    const config: NewTrainingConfig = {
      trainingName,
      env: tpl.env,
      model: 'deepseek-chat',
      epochs: tpl.config.epochs,
      batchSize: tpl.config.batchSize,
      editBudget: tpl.config.editBudget,
      lrScheduler: tpl.config.lrScheduler,
      gateMetric: tpl.config.gateMetric,
      analystWorkers: tpl.config.analystWorkers,
      useSlowUpdate: true,
      useMetaSkill: true,
      dataMode: 'upload',
      uploadedFiles: {
        train: trainFile,
        val: valFile,
        test: null,
        initialSkill: skillFile,
      },
    }

    try {
      const result = await startTraining(config)
      setUseModalId(null)
      navigate(`/training/${encodeURIComponent(result.runId)}`)
    } catch (err) {
      console.error('启动训练失败:', err)
    }
  }

  const handleCopySkill = (tpl: SkillTemplate) => {
    navigator.clipboard.writeText(tpl.skillContent)
    setCopiedId(tpl.id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 mb-1">Skill 案例库</h1>
          <p className="text-sm text-gray-500">选择预设案例快速启动训练，展示训练优化效果</p>
        </div>
        <div className="flex items-center gap-2">
            {isLoggedIn && (
              <button
                onClick={() => setShowNewTemplateModal(true)}
                className="flex items-center gap-2 px-4 py-2.5 bg-indigo-500 text-white rounded-xl text-sm font-medium hover:bg-indigo-600 transition-colors shadow-sm"
              >
                <Plus className="w-4 h-4" />
                新建案例
              </button>
            )}
          </div>
        </div>

      {/* Search + Category filter */}
      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="搜索案例名称、描述或亮点..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300"
          />
        </div>
        <div className="flex gap-1.5 bg-gray-100 p-1 rounded-xl">
          {CATEGORIES.map(cat => (
            <button
              key={cat.key}
              onClick={() => setActiveCategory(cat.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                activeCategory === cat.key
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <span className="mr-1">{cat.icon}</span>
              {cat.label}
            </button>
          ))}
        </div>
      </div>

      {/* Template cards grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {filtered.map(tpl => {
          const isExpanded = expandedId === tpl.id
          const eta = CATEGORIES.find(c => c.key === tpl.category)
          return (
            <div
              key={tpl.id}
              className={`bg-white rounded-2xl border transition-all duration-200 ${
                isExpanded
                  ? 'border-indigo-200 shadow-lg shadow-indigo-50 ring-1 ring-indigo-100'
                  : 'border-gray-100 hover:border-gray-200 hover:shadow-sm'
              }`}
            >
              {/* Card header */}
              <div
                className="p-5 cursor-pointer"
                onClick={() => setExpandedId(isExpanded ? null : tpl.id)}
              >
                <div className="flex items-start gap-4">
                  <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-2xl shrink-0 ${
                    tpl.category === 'analysis' ? 'bg-blue-50'
                    : tpl.category === 'computation' ? 'bg-amber-50'
                    : tpl.category === 'reasoning' ? 'bg-violet-50'
                    : 'bg-emerald-50'
                  }`}>
                    {tpl.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <h3 className="text-sm font-semibold text-gray-900">{tpl.name}</h3>
                      <span className={`px-1.5 py-0.5 rounded-md text-[10px] font-medium ${
                        tpl.difficulty === 'hard' ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-600'
                      }`}>
                        {tpl.difficulty === 'hard' ? '高难度' : '中等'}
                      </span>
                      <span className="text-[10px] text-gray-400">{eta?.icon} {eta?.label}</span>
                    </div>
                    <p className="text-xs text-gray-500 line-clamp-2">{tpl.description}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {isLoggedIn && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setEditingId(tpl.id); setEditingTemplate(tpl); setIsNewTemplate(false) }}
                        className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
                        title="编辑案例"
                      >
                        <Edit2 className="w-4 h-4 text-gray-400 hover:text-gray-600" />
                      </button>
                    )}
                    {isLoggedIn && tpl.id.startsWith('custom-') && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteTemplate(tpl.id) }}
                        className="p-1.5 hover:bg-red-50 rounded-lg transition-colors"
                        title="删除案例"
                      >
                        <Trash2 className="w-4 h-4 text-gray-400 hover:text-red-500" />
                      </button>
                    )}
                    <ChevronRight className={`w-4 h-4 text-gray-300 shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                  </div>
                </div>

                {/* Quick stats */}
                <div className="flex items-center gap-4 mt-3 pt-3 border-t border-gray-50">
                  <span className="flex items-center gap-1 text-[11px] text-gray-500">
                    <BarChart3 className="w-3 h-3 text-gray-400" />
                    基线: <b className="text-gray-600">{tpl.expectedMetrics.baselineAccuracy}</b>
                  </span>
                  <span className="flex items-center gap-1 text-[11px] text-gray-500">
                    <TrendingUp className="w-3 h-3 text-emerald-400" />
                    优化: <b className="text-emerald-600">{tpl.expectedMetrics.optimizedAccuracy}</b>
                  </span>
                  <span className="flex items-center gap-1 text-[11px] text-gray-500">
                    <Zap className="w-3 h-3 text-amber-400" />
                    提升: <b className="text-amber-600">{tpl.expectedMetrics.accuracyGain}</b>
                  </span>
                  <span className="flex items-center gap-1 text-[11px] text-gray-500">
                    <Clock className="w-3 h-3 text-gray-400" />
                    {tpl.expectedMetrics.avgSteps} 步
                  </span>
                  <span className="flex items-center gap-1 text-[11px] text-gray-500">
                    拆分 {(tpl.splitRatio ?? 0.8) * 100}/{100 - (tpl.splitRatio ?? 0.8) * 100}
                  </span>
                </div>
              </div>

              {/* Expanded detail */}
              {isExpanded && (
                <div className="px-5 pb-5 border-t border-gray-100 pt-4 space-y-4">
                  {/* Highlights */}
                  <div>
                    <h4 className="text-xs font-semibold text-gray-700 mb-2 flex items-center gap-1.5">
                      <span className="w-1 h-4 bg-indigo-400 rounded-full" />
                      案例亮点
                    </h4>
                    <ul className="space-y-1">
                      {tpl.highlights.map((h, i) => (
                        <li key={i} className="flex items-start gap-2 text-[11px] text-gray-600">
                          <span className="text-green-500 shrink-0 mt-0.5">✓</span>
                          {h}
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* Expected metrics */}
                  <div>
                    <h4 className="text-xs font-semibold text-gray-700 mb-2 flex items-center gap-1.5">
                      <span className="w-1 h-4 bg-emerald-400 rounded-full" />
                      预期训练效果
                    </h4>
                    <div className="grid grid-cols-4 gap-2">
                      <div className="bg-gray-50 rounded-xl p-3 text-center">
                        <div className="text-[10px] text-gray-400 mb-0.5">基线正确率</div>
                        <div className="text-sm font-bold text-gray-700">{tpl.expectedMetrics.baselineAccuracy}</div>
                      </div>
                      <div className="bg-emerald-50 rounded-xl p-3 text-center">
                        <div className="text-[10px] text-gray-400 mb-0.5">优化后</div>
                        <div className="text-sm font-bold text-emerald-700">{tpl.expectedMetrics.optimizedAccuracy}</div>
                      </div>
                      <div className="bg-amber-50 rounded-xl p-3 text-center">
                        <div className="text-[10px] text-gray-400 mb-0.5">提升幅度</div>
                        <div className="text-sm font-bold text-amber-700">{tpl.expectedMetrics.accuracyGain}</div>
                      </div>
                      <div className="bg-indigo-50 rounded-xl p-3 text-center">
                        <div className="text-[10px] text-gray-400 mb-0.5">训练参数</div>
                        <div className="text-xs font-bold text-indigo-700">{tpl.config.epochs}轮/{tpl.config.editBudget}预算</div>
                      </div>
                    </div>
                  </div>

                  {/* SKILL preview */}
                  <div>
                    <h4 className="text-xs font-semibold text-gray-700 mb-2 flex items-center gap-1.5">
                      <span className="w-1 h-4 bg-violet-400 rounded-full" />
                      Skill 定义
                    </h4>
                    <div className="relative">
                      <pre className="text-[10px] text-gray-600 bg-gray-50 rounded-xl p-4 overflow-auto max-h-[200px] leading-relaxed font-mono whitespace-pre-wrap">
                        {tpl.skillContent.slice(0, 800)}{tpl.skillContent.length > 800 ? '\n... (截断显示)' : ''}
                      </pre>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleCopySkill(tpl) }}
                        className="absolute top-2 right-2 p-1.5 bg-white rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors"
                        title="复制 Skill 内容"
                      >
                        {copiedId === tpl.id
                          ? <Check className="w-3.5 h-3.5 text-green-500" />
                          : <Copy className="w-3.5 h-3.5 text-gray-400" />}
                      </button>
                    </div>
                  </div>

                  {/* Dataset preview */}
                  <div>
                    <h4 className="text-xs font-semibold text-gray-700 mb-2 flex items-center gap-1.5">
                      <span className="w-1 h-4 bg-blue-400 rounded-full" />
                      数据集预览
                    </h4>
                    <DatasetPreview tpl={tpl} />
                  </div>

                  {/* Dataset summary */}
                  <div className="flex items-center gap-4 text-[10px] text-gray-400">
                    <span>数据集: <b className="text-gray-600">{tpl.trainQa.length + tpl.valQa.length} 题</b></span>
                    <span>拆分: <b className="text-gray-600">{(tpl.splitRatio ?? 0.8) * 100}/{Math.round((1 - (tpl.splitRatio ?? 0.8)) * 100)}</b></span>
                    <span>Gate指标: <b className="text-gray-600">{tpl.config.gateMetric}</b></span>
                  </div>

                  {/* Action button */}
                  <button
                    onClick={(e) => { e.stopPropagation(); setUseModalId(tpl.id) }}
                    className="w-full py-2.5 bg-gradient-to-r from-indigo-500 to-indigo-600 text-white rounded-xl text-sm font-medium hover:from-indigo-600 hover:to-indigo-700 transition-all shadow-sm"
                  >
                    <Zap className="w-4 h-4 inline mr-1.5" />
                    使用此案例启动训练
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-16 text-gray-400">
          <div className="text-4xl mb-3">📦</div>
          <p className="text-sm">暂无案例模板</p>
          <p className="text-xs mt-1">
            {isLoggedIn ? '点击「新建案例」创建自定义模板' : '登录后可创建自定义案例'}
          </p>
        </div>
      )}

      {/* Quick-start modal */}
      {useModalId && (() => {
        const tpl = templates.find(t => t.id === useModalId)
        if (!tpl) return null
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 bg-black/30" onClick={() => setUseModalId(null)} />
            <div className="relative bg-white rounded-2xl shadow-2xl w-[480px] max-h-[90vh] overflow-auto">
              <div className="p-6 border-b border-gray-100">
                <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                  <span className="text-xl">{tpl.icon}</span>
                  使用 "{tpl.name}" 案例
                </h3>
                <p className="text-xs text-gray-500 mt-1">
                  数据集 {tpl.trainQa.length + tpl.valQa.length} 题，按 {(tpl.splitRatio ?? 0.8) * 100}/{(1 - (tpl.splitRatio ?? 0.8)) * 100} 拆分为训练/验证集。
                </p>
              </div>
              <form onSubmit={(e) => handleUseTemplate(e, tpl)} className="p-6 space-y-4">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1.5">训练名称</label>
                  <input
                    name="trainingName"
                    defaultValue={`${tpl.name} - 训练`}
                    className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
                    placeholder="输入训练名称"
                  />
                </div>

                <div className="bg-gray-50 rounded-xl p-4 space-y-2 text-xs">
                  <div className="flex justify-between">
                    <span className="text-gray-500">案例</span>
                    <span className="text-gray-800 font-medium">{tpl.name}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Epochs</span>
                    <span className="text-gray-800">{tpl.config.epochs}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Batch Size</span>
                    <span className="text-gray-800">{tpl.config.batchSize}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Edit Budget</span>
                    <span className="text-gray-800">{tpl.config.editBudget}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">数据集</span>
                    <span className="text-gray-800">{tpl.trainQa.length + tpl.valQa.length} 题</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">训练/验证</span>
                    <span className="text-gray-800">{(tpl.splitRatio ?? 0.8) * 100}/{(1 - (tpl.splitRatio ?? 0.8)) * 100}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">预期提升</span>
                    <span className="text-emerald-600 font-bold">{tpl.expectedMetrics.accuracyGain}</span>
                  </div>
                </div>

                <div className="flex gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setUseModalId(null)}
                    className="flex-1 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    className="flex-1 py-2.5 bg-indigo-500 text-white rounded-xl text-sm font-medium hover:bg-indigo-600 transition-colors shadow-sm"
                  >
                    开始训练
                  </button>
                </div>
              </form>
            </div>
          </div>
        )
      })()}

      {/* Edit Template Modal */}
      {editingId && editingTemplate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30" onClick={handleCancelEdit} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-[800px] max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-100 shrink-0 bg-white rounded-t-2xl">
              <h3 className="text-base font-semibold text-gray-900">编辑案例: {editingTemplate.name}</h3>
              <button
                onClick={handleCancelEdit}
                className="p-1.5 hover:bg-gray-100 rounded-lg"
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <div className="p-6 space-y-6 overflow-auto flex-1">
              <div className="grid grid-cols-2 gap-6">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1.5">案例名称</label>
                  <input
                    value={editingTemplate.name}
                    onChange={(e) => setEditingTemplate(prev => ({ ...prev, name: e.target.value }))}
                    className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1.5">图标</label>
                  <input
                    value={editingTemplate.icon}
                    onChange={(e) => setEditingTemplate(prev => ({ ...prev, icon: e.target.value }))}
                    className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1.5">分类</label>
                  <select
                    value={editingTemplate.category}
                    onChange={(e) => setEditingTemplate(prev => ({ ...prev, category: e.target.value as SkillTemplate['category'] }))}
                    className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
                  >
                    <option value="analysis">分析类</option>
                    <option value="computation">计算类</option>
                    <option value="reasoning">推理类</option>
                    <option value="comprehensive">综合类</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1.5">难度</label>
                  <select
                    value={editingTemplate.difficulty}
                    onChange={(e) => setEditingTemplate(prev => ({ ...prev, difficulty: e.target.value as SkillTemplate['difficulty'] }))}
                    className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
                  >
                    <option value="medium">中等</option>
                    <option value="hard">高难度</option>
                  </select>
                </div>
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-gray-700 mb-1.5">描述</label>
                  <textarea
                    value={editingTemplate.description}
                    onChange={(e) => setEditingTemplate(prev => ({ ...prev, description: e.target.value }))}
                    rows={2}
                    className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 resize-none"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-gray-700 mb-1.5">Skill 内容</label>
                  <textarea
                    value={editingTemplate.skillContent}
                    onChange={(e) => setEditingTemplate(prev => ({ ...prev, skillContent: e.target.value }))}
                    rows={8}
                    className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 font-mono resize-none"
                  />
                </div>
              </div>

              {/* ──────── 数据集（统一编辑，按比例拆分） ──────── */}
              {/* ──────── 训练参数 ──────── */}
              <div className="border-t border-gray-100 pt-4">
                <h4 className="text-xs font-semibold text-gray-700 mb-3">训练参数</h4>
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className="block text-[10px] text-gray-500 mb-1">Epochs</label>
                    <input type="number" value={editingTemplate.config.epochs} min={1} max={20}
                      onChange={(e) => setEditingTemplate(prev => ({ ...prev, config: { ...prev.config, epochs: parseInt(e.target.value) || 1 } }))}
                      className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200" />
                  </div>
                  <div>
                    <label className="block text-[10px] text-gray-500 mb-1">Batch Size</label>
                    <input type="number" value={editingTemplate.config.batchSize} min={1} max={100}
                      onChange={(e) => setEditingTemplate(prev => ({ ...prev, config: { ...prev.config, batchSize: parseInt(e.target.value) || 1 } }))}
                      className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200" />
                  </div>
                  <div>
                    <label className="block text-[10px] text-gray-500 mb-1">Edit Budget</label>
                    <input type="number" value={editingTemplate.config.editBudget} min={1} max={20}
                      onChange={(e) => setEditingTemplate(prev => ({ ...prev, config: { ...prev.config, editBudget: parseInt(e.target.value) || 1 } }))}
                      className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200" />
                  </div>
                  <div>
                    <label className="block text-[10px] text-gray-500 mb-1">调度器</label>
                    <select value={editingTemplate.config.lrScheduler}
                      onChange={(e) => setEditingTemplate(prev => ({ ...prev, config: { ...prev.config, lrScheduler: e.target.value } }))}
                      className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200">
                      <option value="cosine">Cosine</option>
                      <option value="constant">Constant</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] text-gray-500 mb-1">Gate 评分</label>
                    <select value={editingTemplate.config.gateMetric}
                      onChange={(e) => setEditingTemplate(prev => ({ ...prev, config: { ...prev.config, gateMetric: e.target.value } }))}
                      className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200">
                      <option value="soft">Soft (F1)</option>
                      <option value="hard">Hard (精确)</option>
                      <option value="mixed">Mixed</option>
                    </select>
                  </div>
                <div>
                  <label className="block text-[10px] text-gray-500 mb-1">分析线程</label>
                  <input type="number" value={editingTemplate.config.analystWorkers} min={1} max={32}
                    onChange={(e) => setEditingTemplate(prev => ({ ...prev, config: { ...prev.config, analystWorkers: parseInt(e.target.value) || 1 } }))}
                    className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200" />
                </div>
                <div>
                  <label className="block text-[10px] text-gray-500 mb-1">环境</label>
                  <select value={editingTemplate.env}
                    onChange={(e) => setEditingTemplate(prev => ({ ...prev, env: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200">
                    <option value="searchqa">SearchQA</option>
                  </select>
                </div>
              </div>
              </div>

              {/* ──────── 数据集 ──────── */}
              <div className="border-t border-gray-100 pt-4">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-xs font-semibold text-gray-700">
                    数据集（共 {editingTemplate.trainQa.length + editingTemplate.valQa.length} 题）
                  </h4>
                  <div className="flex items-center gap-2 text-[10px] text-gray-400">
                    <span>训练/验证拆分：</span>
                    <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-0.5">
                      {[60, 70, 80, 90].map(pct => (
                        <button
                          key={pct}
                          onClick={() => setEditingTemplate(prev => ({ ...prev, splitRatio: pct / 100 }))}
                          className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                            Math.round((editingTemplate.splitRatio ?? 0.8) * 100) === pct
                              ? 'bg-white text-indigo-600 shadow-sm'
                              : 'text-gray-500 hover:text-gray-700'
                          }`}
                        >
                          {pct}/{100 - pct}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                {/* 拆分预览条 */}
                <div className="mb-3 w-full bg-gray-100 rounded-full h-1.5 overflow-hidden flex">
                  <div className="h-full bg-blue-400 rounded-l-full" style={{ width: `${(editingTemplate.splitRatio ?? 0.8) * 100}%` }} />
                  <div className="h-full bg-emerald-400 rounded-r-full" style={{ width: `${(1 - (editingTemplate.splitRatio ?? 0.8)) * 100}%` }} />
                </div>
                <div className="flex justify-between text-[9px] text-gray-400 mb-2">
                  <span className="text-blue-500">训练集 ~{Math.ceil((editingTemplate.trainQa.length + editingTemplate.valQa.length) * (editingTemplate.splitRatio ?? 0.8))}题</span>
                  <span className="text-emerald-500">验证集 ~{Math.floor((editingTemplate.trainQa.length + editingTemplate.valQa.length) * (1 - (editingTemplate.splitRatio ?? 0.8)))}题</span>
                </div>

                <div className="space-y-3">
                  {/* 合并 trainQa + valQa 展示 */}
                  {(() => {
                    const allQa = [...editingTemplate.trainQa, ...editingTemplate.valQa]
                    const splitAt = editingTemplate.trainQa.length
                    return allQa.map((qa, idx) => (
                      <div key={idx} className="flex items-start gap-3">
                        <div className="shrink-0 mt-1.5">
                          <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold ${
                            idx < splitAt ? 'bg-blue-100 text-blue-600' : 'bg-emerald-100 text-emerald-600'
                          }`}>
                            {idx < splitAt ? 'T' : 'V'}
                          </span>
                        </div>
                        <div className="flex-1">
                          <textarea
                            value={qa.question}
                            onChange={(e) => {
                              const newAll = allQa.map((q, i) => i === idx ? { ...q, question: e.target.value } : q)
                              const sp = splitAt
                              setEditingTemplate(prev => ({
                                ...prev,
                                trainQa: newAll.slice(0, sp),
                                valQa: newAll.slice(sp),
                              }))
                            }}
                            rows={2}
                            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono focus:outline-none focus:ring-2 focus:ring-indigo-200 resize-none"
                            placeholder="问题内容"
                          />
                          <input
                            value={qa.answers.join(', ')}
                            onChange={(e) => {
                              const newAll = allQa.map((q, i) => i === idx ? { ...q, answers: e.target.value.split(',').map(s => s.trim()).filter(Boolean) } : q)
                              const sp = splitAt
                              setEditingTemplate(prev => ({
                                ...prev,
                                trainQa: newAll.slice(0, sp),
                                valQa: newAll.slice(sp),
                              }))
                            }}
                            className="w-full mt-1 px-3 py-1.5 border border-gray-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-indigo-200"
                            placeholder="答案（多个用逗号分隔）"
                          />
                        </div>
                        <button
                          onClick={() => {
                            const newAll = allQa.filter((_, i) => i !== idx)
                            // 保持比例重算 split
                            const ratio = editingTemplate.splitRatio ?? 0.8
                            const newSp = Math.ceil(newAll.length * ratio)
                            setEditingTemplate(prev => ({
                              ...prev,
                              trainQa: newAll.slice(0, newSp),
                              valQa: newAll.slice(newSp),
                            }))
                          }}
                          className="p-2 hover:bg-red-50 rounded-lg shrink-0"
                        >
                          <Trash2 className="w-4 h-4 text-gray-400 hover:text-red-500" />
                        </button>
                      </div>
                    ))
                  })()}
                  <button
                    onClick={() => {
                      const allQa = [...editingTemplate.trainQa, ...editingTemplate.valQa, { question: '', answers: [''] }]
                      const ratio = editingTemplate.splitRatio ?? 0.8
                      const newSp = Math.ceil(allQa.length * ratio)
                      setEditingTemplate(prev => ({
                        ...prev,
                        trainQa: allQa.slice(0, newSp),
                        valQa: allQa.slice(newSp),
                      }))
                    }}
                    className="w-full py-2 border border-dashed border-gray-300 rounded-xl text-xs text-gray-500 hover:border-indigo-400 hover:text-indigo-500 transition-colors"
                  >
                    <Plus className="w-4 h-4 inline mr-1" />
                    添加题目
                  </button>
                </div>
              </div>

              <div className="flex gap-3 pt-4 border-t border-gray-100">
                <button
                  onClick={handleCancelEdit}
                  className="flex-1 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleSaveTemplate}
                  className="flex-1 py-2.5 bg-indigo-500 text-white rounded-xl text-sm font-medium hover:bg-indigo-600 transition-colors shadow-sm flex items-center justify-center gap-2"
                >
                  <Save className="w-4 h-4" />
                  保存修改
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* New Template Modal */}
      {showNewTemplateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowNewTemplateModal(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-[480px]">
            <div className="p-6 border-b border-gray-100">
              <h3 className="text-base font-semibold text-gray-900">新建案例</h3>
              <p className="text-xs text-gray-500 mt-1">创建一个新的自定义案例</p>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1.5">案例名称</label>
                <input
                  id="new-template-name"
                  defaultValue="新建案例"
                  className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
                  placeholder="输入案例名称"
                />
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowNewTemplateModal(false)}
                  className="flex-1 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={() => {
                    const input = document.getElementById('new-template-name') as HTMLInputElement
                    handleCreateTemplate(input?.value)
                  }}
                  className="flex-1 py-2.5 bg-indigo-500 text-white rounded-xl text-sm font-medium hover:bg-indigo-600 transition-colors shadow-sm"
                >
                  创建
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirm Modal */}
      {deleteConfirmId && (() => {
        const tpl = templates.find(t => t.id === deleteConfirmId)
        if (!tpl) return null
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 bg-black/30" onClick={() => setDeleteConfirmId(null)} />
            <div className="relative bg-white rounded-2xl shadow-2xl w-[420px]">
              <div className="p-6 text-center">
                <div className="w-14 h-14 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Trash2 className="w-7 h-7 text-red-500" />
                </div>
                <h3 className="text-base font-semibold text-gray-900 mb-2">确认删除</h3>
                <p className="text-sm text-gray-500">确定要删除案例 <span className="font-medium text-gray-700">"{tpl.name}"</span> 吗？此操作无法撤销。</p>
              </div>
              <div className="px-6 pb-6 flex gap-3">
                <button
                  onClick={() => setDeleteConfirmId(null)}
                  className="flex-1 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={confirmDeleteTemplate}
                  className="flex-1 py-2.5 bg-red-500 text-white rounded-xl text-sm font-medium hover:bg-red-600 transition-colors shadow-sm"
                >
                  删除
                </button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}

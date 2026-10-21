import { useState, useRef, DragEvent, useEffect } from 'react'
import { X, Upload, Plus, Trash2, FileText, Check, AlertCircle, BookTemplate, ChevronDown, Zap, TrendingUp, BarChart3, Settings2 } from 'lucide-react'
import { fetchApiKeys, ApiKeySettings } from '../services/api'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../components/Toast'
import { useNavigate } from 'react-router-dom'
import { TEMPLATES, SkillTemplate } from '../data/templates'

interface NewTrainingModalProps {
  isOpen: boolean
  onClose: () => void
  onSubmit: (config: NewTrainingConfig) => void
  existingNames?: string[] // 已有训练名称，用于生成默认名和去重校验
  template?: TemplatePrefill | null // 外部传入的模板预填数据（来自模板库页跳转）
}

export interface TemplatePrefill {
  name: string
  skillContent: string
  qaPairs: Array<{ question: string; answer: string }>
  env: string
  epochs: number
  batchSize: number
  editBudget: number
  lrScheduler: string
  gateMetric: string
  analystWorkers: number
}

export interface QAPair {
  id: string
  question: string
  answer: string
}

export interface NewTrainingConfig {
  trainingName: string
  env: string
  model: string
  epochs: number
  batchSize: number
  editBudget: number
  lrScheduler: string
  gateMetric: string
  analystWorkers: number       // 并行分析线程数
  useSlowUpdate: boolean       // 慢更新（epoch 边界动量）
  slowUpdateGate: boolean      // 门控慢更新（仅验证通过后更新）
  useMetaSkill: boolean        // 元技能（跨 epoch 优化器记忆）
  useSkillAwareReflection: boolean       // 技能感知反思
  skillAwareAppendixSource: 'both' | 'failure_only'  // 附录来源
  skillAwareConsolidateThreshold: number  // LLM 整理阈值，0=关闭
  // 数据来源
  dataMode: 'upload' | 'manual'
  // 上传模式
  uploadedFiles?: {
    train: File | null
    val: File | null
    test: File | null
    initialSkill: File | null
  }
  // 手动填写模式
  skillContent?: string
  qaPairs?: QAPair[]
  // 手动填写模式下的拆分比例
  trainSplit?: number
  valSplit?: number
}

type DataMode = 'upload' | 'manual'

// 处理模板预填数据的辅助函数
function applyTemplate(tpl: SkillTemplate): {
  name: string; config: Record<string, any>; skillContent: string; qaPairs: QAPair[]
} {
  return {
    name: `${tpl.name} - 训练`,
    config: {
      env: tpl.env,
      epochs: tpl.config.epochs,
      batchSize: tpl.config.batchSize,
      editBudget: tpl.config.editBudget,
      lrScheduler: tpl.config.lrScheduler,
      gateMetric: tpl.config.gateMetric,
      analystWorkers: tpl.config.analystWorkers,
    },
    skillContent: tpl.skillContent,
    qaPairs: tpl.trainQa.map((q, i) => ({
      id: String(i + 1),
      question: q.question,
      answer: q.answers.join('\n'),
    })),
  }
}

export default function NewTrainingModal({ isOpen, onClose, onSubmit, existingNames = [], template }: NewTrainingModalProps) {
  const { token } = useAuth()
  const { showToast } = useToast()
  const navigate = useNavigate()
  const [step, setStep] = useState<'select' | 'config' | 'data'>('select')
  const [dataMode, setDataMode] = useState<DataMode>('upload')
  const [trainingName, setTrainingName] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [selectedTemplateIds, setSelectedTemplateIds] = useState<string[]>([])
  const [isCustomMode, setIsCustomMode] = useState(false)

  // 训练参数
  const [config, setConfig] = useState({
    env: 'searchqa',
    model: 'deepseek-flash',
    epochs: 2,
    batchSize: 4,
    editBudget: 3,
    lrScheduler: 'cosine',
    gateMetric: 'soft',
    analystWorkers: 16,
    useSlowUpdate: true,
    slowUpdateGate: false,
    useMetaSkill: true,
    useSkillAwareReflection: false,
    skillAwareAppendixSource: 'both' as 'both' | 'failure_only',
    skillAwareConsolidateThreshold: 0,
  })

  // 上传文件
  const [uploadedFiles, setUploadedFiles] = useState<Record<string, File | null>>({
    train: null,
    val: null,
    test: null,
    initialSkill: null,
  })

  // 多模板独立数据
  const [activeMultiTab, setActiveMultiTab] = useState(0)
  const [multiData, setMultiData] = useState<Record<string, { trainingName?: string; skillContent?: string; qaPairs?: QAPair[] }>>({})

  // 手动填写
  const [skillContent, setSkillContent] = useState(`# 搜索问答技能

## 规则

1. 根据搜索结果回答问题
2. 尽量给出答案`)
  const [qaPairs, setQaPairs] = useState<QAPair[]>([
    { id: '1', question: '小明今年8岁，他的哥哥比他大5岁，他们的妈妈今年35岁。请问10年后，哥哥和妈妈的年龄差是多少？', answer: '22岁' },
    { id: '2', question: '以下哪两个城市都举办过夏季奥运会？A.东京和首尔 B.北京和东京 C.上海和伦敦', answer: 'B' },
    { id: '3', question: '公司2024年Q1营收500万，Q2营收600万，Q3营收550万，Q4营收700万。上半年营销费用共计120万，下半年营销费用共计150万。请问去除营销费用后的年度净利润是多少？', answer: '1580万' },
    { id: '4', question: '关于光合作用，以下说法正确的是？A.只在白天进行 B.只在有光的条件下进行 C.只在叶片中进行', answer: 'B' },
    { id: '5', question: '一段文字中提到："甲比乙高，乙比丙高，但丁比甲高。"请按身高从高到低排序。', answer: '丁 > 甲 > 乙 > 丙' },
    { id: '6', question: '一个篮子里有5个红球、3个蓝球、2个绿球。随机取出2个球，两个都是红球的概率是多少？', answer: '2/9（约22.2%）' },
    { id: '7', question: '下列诗句中，哪些是杜甫写的？A."床前明月光" B."国破山河在" C."锄禾日当午"', answer: 'B' },
    { id: '8', question: '如果所有的猫都怕水，而有些动物不怕水，那么能不能推出"有些动物不是猫"？', answer: '能' },
    { id: '9', question: '某公司有员工100人，其中60人会Python，40人会Java，有20人两种语言都会。请问至少会一种语言的员工有多少人？', answer: '80人' },
    { id: '10', question: '阅读下文回答问题："A说：B说谎。B说：C说谎。C说：A和B都说谎。"请问三个人中，有几人说真话？', answer: '1人' },
  ])
  const [trainSplit, setTrainSplit] = useState(60)
  const [valSplit, setValSplit] = useState(20)
  const [apiKeys, setApiKeys] = useState<ApiKeySettings>({})

  // Handle template selection (multi-select)
  const toggleTemplateSelection = (tplId: string) => {
    setSelectedTemplateIds(prev => {
      if (prev.includes(tplId)) {
        return prev.filter(id => id !== tplId)
      }
      return [...prev, tplId]
    })
  }

  const clearTemplateSelection = () => {
    setSelectedTemplateIds([])
  }

  const handleSelectSingleTemplate = (tplId: string) => {
    setSelectedTemplateIds([tplId])
    setErrors({})
    if (!tplId) return

    const tpl = TEMPLATES.find(t => t.id === tplId)
    if (!tpl) return

    const prefill = applyTemplate(tpl)
    setTrainingName(prefill.name)
    setConfig(prev => ({ ...prev, ...prefill.config, model: prev.model || 'deepseek-flash' }))
    setDataMode('manual')
    setSkillContent(prefill.skillContent)
    setQaPairs(prefill.qaPairs)
    setTrainSplit(70)
    setValSplit(30)
  }

  // Load API keys status & generate default training name when modal opens
  useEffect(() => {
    if (!isOpen) return

    // Reset to mode selection on every open
    setStep('select')
    setIsCustomMode(false)
    setSelectedTemplateIds([])

    // 1. If external template prop provided (from TemplateLibrary page), use it
    if (template) {
      setSelectedTemplateIds([]) // External template doesn't map to a single template ID
      setTrainingName(template.name)
      setConfig(prev => ({
        ...prev,
        env: template.env,
        epochs: template.epochs,
        batchSize: template.batchSize,
        editBudget: template.editBudget,
        lrScheduler: template.lrScheduler,
        gateMetric: template.gateMetric,
        analystWorkers: template.analystWorkers,
      }))
      setDataMode('manual')
      setStep('data')
      setSkillContent(template.skillContent)
      setQaPairs(template.qaPairs.map((qa, i) => ({
        id: String(i + 1),
        question: qa.question,
        answer: qa.answer,
      })))
      setTrainSplit(70)
      setValSplit(30)
    } else {
      // 2. If no template, reset to defaults
      setSelectedTemplateIds([])
      const baseName = '训练任务'
      const nameSet = new Set(existingNames)
      let defaultName = baseName
      let counter = 1
      while (nameSet.has(defaultName)) {
        counter++
        defaultName = `${baseName} ${counter}`
      }
      setTrainingName(defaultName)
    }

    fetchApiKeys().then((keys) => {
      setApiKeys(keys)
      // Auto-select first configured model if current selection is unconfigured
      const currentModel = config.model
      const currentConfigured = (() => {
        if (currentModel.startsWith('deepseek')) return !!keys.deepseek?.apiKeyConfigured
        if (currentModel.startsWith('gpt-') || currentModel.startsWith('o3') || currentModel.startsWith('o4') || currentModel.startsWith('gpt-5')) return !!keys.openai?.apiKeyConfigured
        if (currentModel.startsWith('claude')) return !!keys.anthropic?.apiKeyConfigured
        if (currentModel.startsWith('qwen')) return !!keys.qwen?.apiKeyConfigured
        if (currentModel.startsWith('minimax') || currentModel.startsWith('MiniMax')) return !!keys.minimax?.apiKeyConfigured
        // OpenAI-compatible relay models (glm / mimo / ...) share the openai provider
        return !!keys.openai?.apiKeyConfigured
      })()
      if (!currentConfigured) {
        const firstAvailable = modelOptions.find((opt) => {
          if (opt.value.startsWith('deepseek')) return keys.deepseek?.apiKeyConfigured
          if (opt.value.startsWith('gpt-') || opt.value.startsWith('o3') || opt.value.startsWith('o4') || opt.value.startsWith('gpt-5')) return keys.openai?.apiKeyConfigured
          if (opt.value.startsWith('claude')) return keys.anthropic?.apiKeyConfigured
          if (opt.value.startsWith('qwen')) return keys.qwen?.apiKeyConfigured
          if (opt.value.startsWith('minimax') || opt.value.startsWith('MiniMax')) return keys.minimax?.apiKeyConfigured
          return keys.openai?.apiKeyConfigured
        })
        if (firstAvailable) {
          setConfig((prev) => ({ ...prev, model: firstAvailable.value }))
        } else {
          // No model configured at all — clear selection
          setConfig((prev) => ({ ...prev, model: '' }))
        }
      }
    }).catch(() => {})
  }, [isOpen, existingNames])

  if (!isOpen) return null

  const addQAPair = () => {
    setQaPairs([...qaPairs, { id: String(Date.now()), question: '', answer: '' }])
  }

  const removeQAPair = (id: string) => {
    if (qaPairs.length <= 1) return
    setQaPairs(qaPairs.filter((p) => p.id !== id))
  }

  const updateQAPair = (id: string, field: 'question' | 'answer', value: string) => {
    setQaPairs(qaPairs.map((p) => (p.id === id ? { ...p, [field]: value } : p)))
  }

  const saveCurrentMultiTab = () => {
    if (selectedTemplateIds.length <= 1) return
    const tplId = selectedTemplateIds[activeMultiTab]
    if (!tplId) return
    setMultiData(prev => ({
      ...prev,
      [tplId]: {
        trainingName,
        skillContent,
        qaPairs: [...qaPairs],
      }
    }))
  }

  const switchMultiTab = (index: number) => {
    if (index === activeMultiTab) return
    saveCurrentMultiTab()
    setActiveMultiTab(index)
    const tplId = selectedTemplateIds[index]
    if (!tplId) return
    const md = multiData[tplId]
    if (md) {
      setTrainingName(md.trainingName || '')
      setSkillContent(md.skillContent || '')
      setQaPairs(md.qaPairs || [])
    } else {
      // Fallback: load from template
      const tpl = TEMPLATES.find(t => t.id === tplId)
      if (tpl) {
        const prefill = applyTemplate(tpl)
        setTrainingName(prefill.name)
        setSkillContent(prefill.skillContent)
        setQaPairs(prefill.qaPairs)
      }
    }
  }

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {}

    if (!trainingName.trim()) {
      newErrors.trainingName = '请输入训练名称'
    } else if (existingNames.includes(trainingName.trim())) {
      newErrors.trainingName = '该名称已存在，请使用其他名称'
    }

    if (!config.model || !isModelConfigured(config.model)) {
      newErrors.model = config.model
        ? `模型 "${config.model}" 的 API Key 未配置，请先在设置中配置`
        : '请选择一个已配置 API Key 的模型'
    }

    if (dataMode === 'upload') {
      if (!uploadedFiles.train) newErrors.train = '请上传训练集'
      if (!uploadedFiles.initialSkill) newErrors.initialSkill = '请上传初始 Skill 文件'
    } else {
      if (!skillContent.trim()) newErrors.skillContent = '请输入 Skill 内容'
      const filledPairs = qaPairs.filter((p) => p.question.trim() && p.answer.trim())
      if (filledPairs.length < 2) {
        newErrors.qaPairs = '至少需要 2 组问答对'
      }
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    
    // 多模板：进入数据准备步骤
    if (selectedTemplateIds.length > 1 && step === 'config') {
      // Initialize per-template data
      const initial: Record<string, any> = {}
      selectedTemplateIds.forEach(id => {
        const tpl = TEMPLATES.find(t => t.id === id)
        if (tpl) {
          const prefill = applyTemplate(tpl)
          initial[id] = {
            trainingName: prefill.name,
            skillContent: prefill.skillContent,
            qaPairs: prefill.qaPairs,
          }
        }
      })
      setMultiData(initial)
      setActiveMultiTab(0)
      // Load first template's data into form
      const first = initial[selectedTemplateIds[0]]
      if (first) {
        setTrainingName(first.trainingName)
        setSkillContent(first.skillContent)
        setQaPairs(first.qaPairs)
      }
      setConfig(prev => ({ ...prev, model: prev.model || 'deepseek-flash' }))
      setDataMode('manual')
      setStep('data')
      return
    }
    
    // 多模板：数据准备后提交
    if (selectedTemplateIds.length > 1 && step === 'data') {
      // Save current tab data before submit
      saveCurrentMultiTab()
      if (!token) {
        showToast('info', '请先登录后再开始训练')
        return
      }
      if (!Object.values(apiKeys).some((v: any) => v?.apiKeyConfigured)) {
        showToast('info', '请先配置 API Key（头像 > API Key 配置）')
        return
      }
      const trainConfigs = selectedTemplateIds.map((tplId) => {
        const tpl = TEMPLATES.find(t => t.id === tplId)
        if (!tpl) return null
        const md = multiData[tplId] || {}
        const prefill = applyTemplate(tpl)
        return {
          trainingName: md.trainingName || prefill.name,
          ...config,
          dataMode: 'manual' as const,
          skillContent: md.skillContent || prefill.skillContent,
          qaPairs: md.qaPairs?.length ? md.qaPairs.filter((p: QAPair) => p.question.trim() && p.answer.trim()) : prefill.qaPairs,
          trainSplit,
          valSplit,
        }
      }).filter(Boolean) as NewTrainingConfig[]
      
      trainConfigs.forEach((cfg, index) => {
        setTimeout(() => onSubmit(cfg), index * 500)
      })
      handleClose()
      return
    }
    
    // 单模板或手动配置模式
    if (step === 'config') {
      // 如果只选了一个模板但还没配置，先进入配置步骤
      if (selectedTemplateIds.length === 1) {
        const tpl = TEMPLATES.find(t => t.id === selectedTemplateIds[0])
        if (tpl) {
          const prefill = applyTemplate(tpl)
          setTrainingName(prefill.name)
          setConfig(prev => ({ ...prev, ...prefill.config, model: prev.model || 'deepseek-flash' }))
          setDataMode('manual')
          setSkillContent(prefill.skillContent)
          setQaPairs(prefill.qaPairs)
          setTrainSplit(70)
          setValSplit(30)
        }
      }
      setStep('data')
      return
    }
    if (!validate()) return

    const uploadFiles: NewTrainingConfig['uploadedFiles'] =
      dataMode === 'upload'
        ? {
            train: uploadedFiles.train,
            val: uploadedFiles.val,
            test: uploadedFiles.test,
            initialSkill: uploadedFiles.initialSkill,
          }
        : undefined

    onSubmit({
      trainingName: trainingName.trim(),
      ...config,
      dataMode,
      uploadedFiles: uploadFiles,
      skillContent: dataMode === 'manual' ? skillContent : undefined,
      qaPairs: dataMode === 'manual' ? qaPairs.filter((p) => p.question.trim() && p.answer.trim()) : undefined,
      trainSplit: dataMode === 'manual' ? trainSplit : undefined,
      valSplit: dataMode === 'manual' ? valSplit : undefined,
    })
    handleClose()
  }

  const handleClose = () => {
    setStep('config')
    setDataMode('upload')
    setErrors({})
    onClose()
  }

  const handleFileChange = (key: string, file: File | null) => {
    setUploadedFiles((prev) => ({ ...prev, [key]: file }))
    if (errors[key]) {
      setErrors((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
    }
  }

  const testSplit = 100 - trainSplit - valSplit

  // Check if a model's API key is configured
  const isModelConfigured = (modelValue: string): boolean => {
    if (modelValue.startsWith('deepseek')) return !!apiKeys.deepseek?.apiKeyConfigured
    if (modelValue.startsWith('gpt-') || modelValue.startsWith('o3') || modelValue.startsWith('o4') || modelValue.startsWith('gpt-5')) return !!apiKeys.openai?.apiKeyConfigured
    if (modelValue.startsWith('claude')) return !!apiKeys.anthropic?.apiKeyConfigured
    if (modelValue.startsWith('qwen')) return !!apiKeys.qwen?.apiKeyConfigured
    if (modelValue.startsWith('minimax') || modelValue.startsWith('MiniMax')) return !!apiKeys.minimax?.apiKeyConfigured
    return !!apiKeys.openai?.apiKeyConfigured
  }

  const envOptions = [
    { value: 'searchqa', label: 'SearchQA - 开放域问答' },
    { value: 'livemath', label: 'LiveMath - 数学推理' },
    { value: 'spreadsheet', label: 'SpreadsheetBench - 电子表格' },
    { value: 'officeqa', label: 'OfficeQA - 企业问答' },
    { value: 'docvqa', label: 'DocVQA - 文档问答' },
  ]

  const modelOptions = [
    { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
    { value: 'deepseek-flash', label: 'DeepSeek Flash' },
    { value: 'glm-5.3', label: 'GLM-5.3' },
    { value: 'glm-5.3-flash', label: 'GLM-5.3 Flash' },
    { value: 'mimo-v2.6-flash', label: 'MiMo V2.6 Flash' },
    { value: 'mimo-v2.6-pro', label: 'MiMo V2.6 Pro' },
    { value: 'mimo-v2.6-pro-ultraspeed', label: 'MiMo V2.6 Pro UltraSpeed' },
  ]

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 overflow-y-auto">
      <div className="bg-white rounded-3xl w-full max-w-2xl mx-4 my-4 max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-100">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">
              {step === 'select' ? '新建训练' : step === 'config' ? '训练参数' : '数据准备'}
            </h2>
            <p className="text-sm text-gray-500 mt-1">
              {step === 'select' ? '选择创建方式' : step === 'config' ? '步骤 1/2 - 训练参数配置' : '步骤 2/2 - 数据准备'}
            </p>
          </div>
          <button onClick={handleClose} className="p-2 hover:bg-gray-100 rounded-xl">
            <X className="w-5 h-5 text-gray-600" />
          </button>
        </div>

        {/* Progress Steps */}
        {step !== 'select' && (
          <div className="px-8 pt-4">
            <div className="flex items-center gap-2 mb-6">
              <div className={`flex items-center gap-2 ${step === 'config' ? 'opacity-100' : 'opacity-50'}`}>
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold ${step === 'config' ? 'bg-gray-900 text-white' : 'bg-green-500 text-white'}`}>
                  {step === 'config' ? '1' : <Check className="w-3.5 h-3.5" />}
                </div>
                <span className="text-sm font-medium text-gray-700">训练参数</span>
              </div>
              <div className="flex-1 h-px bg-gray-200" />
              <div className={`flex items-center gap-2 ${step === 'data' ? 'opacity-100' : 'opacity-50'}`}>
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold ${step === 'data' ? 'bg-gray-900 text-white' : 'bg-gray-200 text-gray-500'}`}>
                  2
                </div>
                <span className="text-sm font-medium text-gray-700">数据准备</span>
              </div>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto">
            {step === 'select' ? (
              /* ─── Mode Selection ─── */
              <div className="p-6 pt-0 space-y-3">
                {!Object.values(apiKeys).some((v: any) => v?.apiKeyConfigured) && (
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <div className="text-sm font-medium text-amber-800">尚未配置 API Key</div>
                      <div className="text-xs text-amber-600 mt-0.5">请先前往「API Key 配置」页面添加至少一个模型提供商的密钥，才能开始训练。</div>
                      <button type="button" onClick={() => { onClose(); navigate('/settings') }}
                        className="mt-2 text-xs font-medium text-amber-700 underline hover:text-amber-900">前往配置 →</button>
                    </div>
                  </div>
                )}
                  <button
                    type="button"
                    onClick={() => { setIsCustomMode(false); setStep('config'); setSelectedTemplateIds([]) }}
                    className="w-full text-left p-5 rounded-2xl border-2 border-gray-200 hover:border-indigo-400 hover:bg-indigo-50/30 transition-all group"
>
                    <div className="flex items-start gap-4">
                      <div className="w-12 h-12 rounded-xl bg-indigo-100 flex items-center justify-center flex-shrink-0 group-hover:bg-indigo-200 transition-colors">
                        <BookTemplate className="w-6 h-6 text-indigo-600" />
                      </div>
                      <div>
                        <h3 className="text-base font-semibold text-gray-900">使用模板库</h3>
                        <p className="text-sm text-gray-500 mt-1">选择预设案例，自动填充 Skill、QA 和参数，快速启动训练</p>
                        <span className="inline-block mt-2 text-xs text-indigo-600 font-medium">推荐 →</span>
                      </div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setIsCustomMode(true); setStep('config'); setSelectedTemplateIds([]) }}
                    className="w-full text-left p-5 rounded-2xl border-2 border-gray-200 hover:border-gray-400 hover:bg-gray-50 transition-all group"
                >
                  <div className="flex items-start gap-4">
                    <div className="w-12 h-12 rounded-xl bg-gray-100 flex items-center justify-center flex-shrink-0 group-hover:bg-gray-200 transition-colors">
                      <Settings2 className="w-6 h-6 text-gray-600" />
                    </div>
                    <div>
                      <h3 className="text-base font-semibold text-gray-900">自定义参数</h3>
                      <p className="text-sm text-gray-500 mt-1">手动填写 Skill 内容、QA 数据和所有训练超参数</p>
                    </div>
                  </div>
                </button>
              </div>
            ) : step === 'config' ? (
              <div className="p-6 pt-0 space-y-4">
                {/* API Key warning */}
                {!Object.values(apiKeys).some((v: any) => v?.apiKeyConfigured) && (
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <div className="text-sm font-medium text-amber-800">尚未配置 API Key</div>
                      <div className="text-xs text-amber-600 mt-0.5">请先前往「API Key 配置」页面添加至少一个模型提供商的密钥，才能开始训练。</div>
                      <button
                        type="button"
                        onClick={() => { onClose(); navigate('/settings') }}
                        className="mt-2 text-xs font-medium text-amber-700 underline hover:text-amber-900"
                      >
                        前往配置 →
                      </button>
                    </div>
                  </div>
                )}
                {/* 模板选择器 — only for template mode */}
              {!isCustomMode && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-medium text-gray-700">
                    <BookTemplate className="w-4 h-4 inline mr-1.5 text-indigo-500" />
                    引用模板库
                  </label>
                  {selectedTemplateIds.length > 0 && (
                    <button
                      type="button"
                      onClick={clearTemplateSelection}
                      className="text-xs text-gray-500 hover:text-red-500 transition-colors"
                    >
                      清除选择
                    </button>
                  )}
                </div>
                
                {/* 多选模板列表 */}
                <div className="grid grid-cols-1 gap-1.5 max-h-[180px] overflow-y-auto pr-1">
                  {TEMPLATES.map(tpl => (
                    <label
                      key={tpl.id}
                      className={`flex items-center gap-2.5 p-2.5 rounded-lg border cursor-pointer transition-all ${
                        selectedTemplateIds.includes(tpl.id)
                          ? 'border-indigo-500 bg-indigo-50'
                          : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={selectedTemplateIds.includes(tpl.id)}
                        onChange={() => toggleTemplateSelection(tpl.id)}
                        className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 shrink-0"
                      />
                      <span className="text-base">{tpl.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-medium text-gray-800 truncate">{tpl.name}</span>
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${tpl.difficulty === 'hard' ? 'bg-red-100 text-red-600' : 'bg-amber-100 text-amber-600'}`}>
                            {tpl.difficulty === 'hard' ? '高' : '中'}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-[10px] text-gray-500 mt-0.5">
                          <span>{tpl.category === 'analysis' ? '分析' : tpl.category === 'computation' ? '计算' : tpl.category === 'reasoning' ? '推理' : '综合'}</span>
                          <span>{tpl.expectedMetrics.baselineAccuracy}→{tpl.expectedMetrics.optimizedAccuracy}</span>
                        </div>
                      </div>
                    </label>
                  ))}
                </div>

                {/* 已选模板数量提示 */}
                {selectedTemplateIds.length > 0 && (
                  <div className="mt-2 p-2 bg-indigo-50 border border-indigo-100 rounded-lg">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-700">
                          已选择 <b className="text-indigo-600">{selectedTemplateIds.length}</b> 个案例
                        </span>
                        {selectedTemplateIds.length > 1 && (
                          <span className="flex items-center gap-1 px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded text-[10px]">
                            <Zap className="w-3 h-3" />
                            并行
                          </span>
                        )}
                      </div>
                      {selectedTemplateIds.length === 1 && (
                        <button
                          type="button"
                          onClick={() => {
                            const tpl = TEMPLATES.find(t => t.id === selectedTemplateIds[0])
                            if (tpl) {
                              const prefill = applyTemplate(tpl)
                              setTrainingName(prefill.name)
                              setConfig(prev => ({ ...prev, ...prefill.config, model: prev.model || 'deepseek-flash' }))
                              setDataMode('manual')
                              setSkillContent(prefill.skillContent)
                              setQaPairs(prefill.qaPairs)
                              setTrainSplit(70)
                              setValSplit(30)
                              setStep('data')
                            }
                          }}
                          className="text-xs text-indigo-600 hover:text-indigo-700 font-medium"
                        >
                          配置详情
                        </button>
                      )}
                    </div>
                  </div>
                )}

                <p className="text-xs text-gray-400 mt-1.5">
                  {selectedTemplateIds.length > 1 
                    ? '点击"开始训练"并行启动所有任务' 
                    : selectedTemplateIds.length === 1
                    ? '点击"配置详情"自定义参数，或直接开始训练'
                    : '选择模板，支持并行训练'}
                </p>
              </div>
              )}

              {/* 训练名称 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  训练名称 {selectedTemplateIds.length <= 1 && <span className="text-red-400">*</span>}
                </label>
                <input
                  type="text"
                  value={trainingName}
                  onChange={(e) => {
                    setTrainingName(e.target.value)
                    if (errors.trainingName) setErrors((prev) => { const n = { ...prev }; delete n.trainingName; return n })
                  }}
                  disabled={selectedTemplateIds.length > 1}
                  className={`w-full px-4 py-2.5 rounded-xl text-sm border-none focus:outline-none focus:ring-2 ${
                    selectedTemplateIds.length > 1
                      ? 'bg-gray-50 text-gray-400 cursor-not-allowed'
                      : `bg-gray-100 ${errors.trainingName ? 'ring-2 ring-red-400' : 'focus:ring-gray-900'}`
                  }`}
                  placeholder={selectedTemplateIds.length > 1 ? '将使用各模板的默认名称' : '例如：SearchQA 实验 v1'}
                />
                {errors.trainingName && <p className="text-red-500 text-xs mt-1">{errors.trainingName}</p>}
                {selectedTemplateIds.length > 1 && (
                  <p className="text-xs text-amber-600 mt-1">
                    已选择多个模板，每个训练将使用模板的默认名称
                  </p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-5">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">环境类型</label>
                  <select
                    value={config.env}
                    onChange={(e) => setConfig({ ...config, env: e.target.value })}
                    className="w-full px-4 py-2.5 bg-gray-100 rounded-xl text-sm border-none focus:outline-none focus:ring-2 focus:ring-gray-900"
                  >
                    {envOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>



                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">模型</label>
                  <select
                    value={config.model}
                    onChange={(e) => { setConfig({ ...config, model: e.target.value }); if (errors.model) setErrors((prev) => { const n = { ...prev }; delete n.model; return n }) }}
                    className={`w-full px-4 py-2.5 bg-gray-100 rounded-xl text-sm border-none focus:outline-none focus:ring-2 ${errors.model ? 'ring-2 ring-red-400' : 'focus:ring-gray-900'}${!isModelConfigured(config.model) ? ' text-gray-400' : ''}`}
                  >
                    {(() => {
                      const configured = modelOptions.filter((opt) => isModelConfigured(opt.value))
                      const unconfigured = modelOptions.filter((opt) => !isModelConfigured(opt.value))
                      // If no model configured, show a placeholder prompt
                      if (configured.length === 0) {
                        return (
                          <>
                            <option value="" disabled>请先在「设置」中配置 API Key</option>
                            {unconfigured.map((opt) => (
                              <option key={opt.value} value={opt.value} disabled>{opt.label}</option>
                            ))}
                          </>
                        )
                      }
                      return (
                        <>
                          {configured.length > 0 && (
                            <optgroup label="已配置">
                              {configured.map((opt) => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                              ))}
                            </optgroup>
                          )}
                          {unconfigured.length > 0 && (
                            <optgroup label="未配置 API Key">
                              {unconfigured.map((opt) => (
                                <option key={opt.value} value={opt.value} disabled>{opt.label}</option>
                              ))}
                            </optgroup>
                          )}
                        </>
                      )
                    })()}
                  </select>
                  {errors.model && <p className="text-red-500 text-xs mt-1">{errors.model}</p>}
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">训练轮数 (Epochs)</label>
                  <input
                    type="number"
                    value={config.epochs}
                    onChange={(e) => setConfig({ ...config, epochs: parseInt(e.target.value) || 1 })}
                    className="w-full px-4 py-2.5 bg-gray-100 rounded-xl text-sm border-none focus:outline-none focus:ring-2 focus:ring-gray-900"
                    min="1"
                    max="20"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">批次大小 (Batch Size)</label>
                  <input
                    type="number"
                    value={config.batchSize}
                    onChange={(e) => setConfig({ ...config, batchSize: parseInt(e.target.value) || 1 })}
                    className="w-full px-4 py-2.5 bg-gray-100 rounded-xl text-sm border-none focus:outline-none focus:ring-2 focus:ring-gray-900"
                    min="1"
                    max="64"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">编辑预算 (Edit Budget)</label>
                  <input
                    type="number"
                    value={config.editBudget}
                    onChange={(e) => setConfig({ ...config, editBudget: parseInt(e.target.value) || 1 })}
                    className="w-full px-4 py-2.5 bg-gray-100 rounded-xl text-sm border-none focus:outline-none focus:ring-2 focus:ring-gray-900"
                    min="1"
                    max="10"
                  />
                  <p className="text-xs text-gray-400 mt-1">每轮允许的最大编辑次数</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">学习率调度</label>
                  <select
                    value={config.lrScheduler}
                    onChange={(e) => setConfig({ ...config, lrScheduler: e.target.value })}
                    className="w-full px-4 py-2.5 bg-gray-100 rounded-xl text-sm border-none focus:outline-none focus:ring-2 focus:ring-gray-900"
                  >
                    <option value="constant">Constant - 恒定</option>
                    <option value="linear">Linear - 线性衰减</option>
                    <option value="cosine">Cosine - 余弦衰减</option>
                    <option value="autonomous">Autonomous - 自适应</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Gate 评分方式</label>
                  <select
                    value={config.gateMetric}
                    onChange={(e) => setConfig({ ...config, gateMetric: e.target.value })}
                    className="w-full px-4 py-2.5 bg-gray-100 rounded-xl text-sm border-none focus:outline-none focus:ring-2 focus:ring-gray-900"
                  >
                    <option value="hard">Hard - 精确匹配 (EM)</option>
                    <option value="soft">Soft - 模糊匹配 (F1)</option>
                    <option value="mixed">Mixed - 混合评分</option>
                  </select>
                  <p className="text-xs text-gray-400 mt-1">
                    {config.gateMetric === 'hard' && '答案必须与预期完全一致，严格但精确'}
                    {config.gateMetric === 'soft' && '考虑部分匹配（F1分数），更宽容，推荐小样本时使用'}
                    {config.gateMetric === 'mixed' && 'Hard×0.5 + Soft×0.5，兼顾精确与宽容'}
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">并行分析线程 (Analyst Workers)</label>
                  <input
                    type="number"
                    value={config.analystWorkers}
                    onChange={(e) => setConfig({ ...config, analystWorkers: Math.min(32, Math.max(1, parseInt(e.target.value) || 16)) })}
                    className="w-full px-4 py-2.5 bg-gray-100 rounded-xl text-sm border-none focus:outline-none focus:ring-2 focus:ring-gray-900"
                    min="1"
                    max="32"
                  />
                  <p className="text-xs text-gray-400 mt-1">Reflect 阶段并行分析的线程数，越大越快但更耗资源</p>
                </div>
              </div>

              {/* 高级选项 */}
              <div className="pt-2 border-t border-gray-100">
                <p className="text-xs text-gray-400 mb-3 uppercase tracking-wide">高级选项</p>
                <div className="grid grid-cols-2 gap-4">
                  <label className="flex items-center gap-3 p-4 bg-gray-50 rounded-xl cursor-pointer hover:bg-gray-100 transition-colors">
                    <input
                      type="checkbox"
                      checked={config.useSlowUpdate}
                      onChange={(e) => setConfig({ ...config, useSlowUpdate: e.target.checked })}
                      className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    <div>
                      <span className="text-sm font-medium text-gray-700">Slow Update</span>
                      <p className="text-xs text-gray-400 mt-0.5">Epoch 边界动量更新，缓慢演进 Skill</p>
                    </div>
                  </label>
                  <label className="flex items-center gap-3 p-4 bg-gray-50 rounded-xl cursor-pointer hover:bg-gray-100 transition-colors">
                    <input
                      type="checkbox"
                      checked={config.slowUpdateGate}
                      onChange={(e) => setConfig({ ...config, slowUpdateGate: e.target.checked })}
                      className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    <div>
                      <span className="text-sm font-medium text-gray-700">Gate 门控更新</span>
                      <p className="text-xs text-gray-400 mt-0.5">仅验证通过后才更新技能，更保守</p>
                    </div>
                  </label>
                  <label className="flex items-center gap-3 p-4 bg-gray-50 rounded-xl cursor-pointer hover:bg-gray-100 transition-colors">
                    <input
                      type="checkbox"
                      checked={config.useMetaSkill}
                      onChange={(e) => setConfig({ ...config, useMetaSkill: e.target.checked })}
                      className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    <div>
                      <span className="text-sm font-medium text-gray-700">Meta Skill</span>
                      <p className="text-xs text-gray-400 mt-0.5">跨 Epoch 优化器记忆，总结历史经验</p>
                    </div>
                  </label>
                </div>
              </div>

              {/* Skill-Aware Reflection */}
              <div className="pt-2 border-t border-gray-100">
                <p className="text-xs text-gray-400 mb-3 uppercase tracking-wide">技能感知反思</p>
                <label className="flex items-center gap-3 p-4 bg-gray-50 rounded-xl cursor-pointer hover:bg-gray-100 transition-colors mb-3">
                  <input
                    type="checkbox"
                    checked={config.useSkillAwareReflection}
                    onChange={(e) => setConfig({ ...config, useSkillAwareReflection: e.target.checked })}
                    className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <div>
                    <span className="text-sm font-medium text-gray-700">启用技能感知反思</span>
                    <p className="text-xs text-gray-400 mt-0.5">区分技能缺陷 vs 执行失误，避免过度修改</p>
                  </div>
                </label>
                {config.useSkillAwareReflection && (
                  <div className="grid grid-cols-2 gap-4 ml-7">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">附录来源</label>
                      <select
                        value={config.skillAwareAppendixSource}
                        onChange={(e) => setConfig({ ...config, skillAwareAppendixSource: e.target.value as 'both' | 'failure_only' })}
                        className="w-full px-4 py-2.5 bg-gray-100 rounded-xl text-sm border-none focus:outline-none focus:ring-2 focus:ring-gray-900"
                      >
                        <option value="both">Both - 成功和失败都记录</option>
                        <option value="failure_only">Failure Only - 仅记录失败</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">LLM 整理阈值 (0=关闭)</label>
                      <input
                        type="number"
                        value={config.skillAwareConsolidateThreshold}
                        onChange={(e) => setConfig({ ...config, skillAwareConsolidateThreshold: Math.max(0, parseInt(e.target.value) || 0) })}
                        className="w-full px-4 py-2.5 bg-gray-100 rounded-xl text-sm border-none focus:outline-none focus:ring-2 focus:ring-gray-900"
                        min="0"
                        max="50"
                      />
                      <p className="text-xs text-gray-400 mt-1">附录条目超过 N 时自动整理</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="p-6 pt-0 overflow-y-auto max-h-[calc(90vh-200px)]">
              {/* API Key warning for data step */}
              {step === 'data' && !Object.values(apiKeys).some((v: any) => v?.apiKeyConfigured) && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3 mb-4">
                  <AlertCircle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-amber-800">尚未配置 API Key，无法开始训练</div>
                    <div className="text-xs text-amber-600 mt-0.5">请先前往「API Key 配置」页面添加至少一个模型提供商的密钥。</div>
                    <button
                      type="button"
                      onClick={() => { onClose(); navigate('/settings') }}
                      className="mt-2 text-xs font-medium text-amber-700 underline hover:text-amber-900"
                    >
                      前往配置 →
                    </button>
                  </div>
                </div>
              )}
              {/* Multi-template tabs */}
              {selectedTemplateIds.length > 1 && (
                <div className="flex gap-1 mb-3 bg-gray-100 rounded-lg p-1">
                  {selectedTemplateIds.map((tplId, idx) => {
                    const tpl = TEMPLATES.find(t => t.id === tplId)
                    return (
                      <button
                        key={tplId}
                        type="button"
                        onClick={() => switchMultiTab(idx)}
                        className={`flex-1 py-2 px-2 rounded-md text-xs font-medium transition-all truncate ${
                          idx === activeMultiTab ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                        }`}
                      >
                        {tpl?.icon} {tpl?.name || tplId}
                      </button>
                    )
                  })}
                </div>
              )}
              {/* Data Mode Selector */}
              <div className="flex gap-2 mb-4 p-1 bg-gray-100 rounded-xl">
                <button
                  type="button"
                  onClick={() => { setDataMode('upload'); setErrors({}) }}
                  className={`flex-1 py-2.5 px-4 rounded-lg text-sm font-medium transition-all ${
                    dataMode === 'upload' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  <Upload className="w-4 h-4 inline mr-1.5" />
                  上传文件
                </button>
                <button
                  type="button"
                  onClick={() => { setDataMode('manual'); setErrors({}) }}
                  className={`flex-1 py-2.5 px-4 rounded-lg text-sm font-medium transition-all ${
                    dataMode === 'manual' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  <Plus className="w-4 h-4 inline mr-1.5" />
                  手动填写
                </button>
              </div>

              {dataMode === 'upload' ? (
                <div className="space-y-4">
                  {/* Upload: Train */}
                  <FileUploader
                    label="训练集 (train.jsonl)"
                    description="每行一个 JSON，包含 question、context、answer 字段"
                    accept=".jsonl,.json"
                    file={uploadedFiles.train}
                    onChange={(f) => handleFileChange('train', f)}
                    error={errors.train}
                    required
                  />

                  {/* Upload: Val (optional) */}
                  <FileUploader
                    label="验证集 (val.jsonl)"
                    description="可选，格式同训练集"
                    accept=".jsonl,.json"
                    file={uploadedFiles.val}
                    onChange={(f) => handleFileChange('val', f)}
                  />

                  {/* Upload: Test */}
                  <FileUploader
                    label="测试集 (test.jsonl)"
                    description="可选，格式同训练集"
                    accept=".jsonl,.json"
                    file={uploadedFiles.test}
                    onChange={(f) => handleFileChange('test', f)}
                  />

                  {/* Upload: Initial Skill */}
                  <FileUploader
                    label="初始 Skill 文档 (initial_skill.md)"
                    description="Markdown 格式的初始 Skill 文档"
                    accept=".md"
                    file={uploadedFiles.initialSkill}
                    onChange={(f) => handleFileChange('initialSkill', f)}
                    error={errors.initialSkill}
                    required
                  />
                </div>
              ) : (
                <div className="space-y-5">
                  {/* Manual: Skill Content */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Skill 文档内容 <span className="text-red-400">*</span>
                    </label>
                    <textarea
                      value={skillContent}
                      onChange={(e) => {
                        setSkillContent(e.target.value)
                        if (errors.skillContent) setErrors((prev) => { const n = { ...prev }; delete n.skillContent; return n })
                      }}
                      className={`w-full px-4 py-3 bg-gray-100 rounded-xl text-sm border-none focus:outline-none focus:ring-2 focus:ring-gray-900 font-mono min-h-[120px] resize-y ${errors.skillContent ? 'ring-2 ring-red-400' : ''}`}
                      placeholder="# My Skill\n\n## Rules\n..."
                    />
                    {errors.skillContent && <p className="text-red-500 text-xs mt-1">{errors.skillContent}</p>}
                  </div>

                  {/* Manual: QA Pairs */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-sm font-medium text-gray-700">
                        问答数据 <span className="text-red-400">*</span>
                      </label>
                      <button
                        type="button"
                        onClick={addQAPair}
                        className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 font-medium"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        添加问答对
                      </button>
                    </div>
                    {errors.qaPairs && <p className="text-red-500 text-xs mb-2">{errors.qaPairs}</p>}

                    <div className="space-y-2 max-h-[300px] overflow-y-auto">
                      {qaPairs.map((pair, index) => (
                        <div key={pair.id} className="flex gap-2 items-start p-3 bg-gray-50 rounded-xl">
                          <span className="text-xs text-gray-400 mt-2.5 w-5 shrink-0">{index + 1}</span>
                          <div className="flex-1 space-y-2">
                            <input
                              type="text"
                              value={pair.question}
                              onChange={(e) => updateQAPair(pair.id, 'question', e.target.value)}
                              className="w-full px-3 py-2 bg-white rounded-lg text-sm border border-gray-200 focus:outline-none focus:ring-1 focus:ring-gray-900"
                              placeholder="问题..."
                            />
                            <input
                              type="text"
                              value={pair.answer}
                              onChange={(e) => updateQAPair(pair.id, 'answer', e.target.value)}
                              className="w-full px-3 py-2 bg-white rounded-lg text-sm border border-gray-200 focus:outline-none focus:ring-1 focus:ring-gray-900"
                              placeholder="答案..."
                            />
                          </div>
                          <button
                            type="button"
                            onClick={() => removeQAPair(pair.id)}
                            className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg shrink-0"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                    </div>
                    <p className="text-xs text-gray-400 mt-2">
                      已添加 {qaPairs.length} 组，其中 {qaPairs.filter((p) => p.question.trim() && p.answer.trim()).length} 组已填写
                    </p>
                  </div>

                  {/* Manual: Split Ratio */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-3">数据拆分比例</label>
                    <div className="flex items-center gap-3">
                      <div className="flex-1">
                        <label className="text-xs text-gray-500 mb-1 block">训练集</label>
                        <input
                          type="number"
                          value={trainSplit}
                          onChange={(e) => setTrainSplit(Math.min(90, Math.max(10, parseInt(e.target.value) || 60)))}
                          className="w-full px-3 py-2 bg-gray-100 rounded-lg text-sm text-center font-medium border-none focus:outline-none focus:ring-2 focus:ring-gray-900"
                          min="10"
                          max="90"
                        />
                        <span className="text-xs text-gray-400">%</span>
                      </div>
                      <div className="flex-1">
                        <label className="text-xs text-gray-500 mb-1 block">验证集</label>
                        <input
                          type="number"
                          value={valSplit}
                          onChange={(e) => setValSplit(Math.min(40, Math.max(5, parseInt(e.target.value) || 20)))}
                          className="w-full px-3 py-2 bg-gray-100 rounded-lg text-sm text-center font-medium border-none focus:outline-none focus:ring-2 focus:ring-gray-900"
                          min="5"
                          max="40"
                        />
                        <span className="text-xs text-gray-400">%</span>
                      </div>
                      <div className="flex-1">
                        <label className="text-xs text-gray-500 mb-1 block">测试集</label>
                        <div className="w-full px-3 py-2 bg-gray-50 rounded-lg text-sm text-center font-medium text-gray-400">
                          {testSplit}%
                        </div>
                      </div>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-1.5 mt-3 overflow-hidden">
                      <div className="flex h-full">
                        <div className="bg-blue-500 h-full" style={{ width: `${trainSplit}%` }} />
                        <div className="bg-amber-500 h-full" style={{ width: `${valSplit}%` }} />
                        <div className="bg-green-500 h-full" style={{ width: `${testSplit}%` }} />
                      </div>
                    </div>
                    <div className="flex gap-4 mt-1.5 text-xs text-gray-400">
                      <span className="flex items-center gap-1"><span className="w-2 h-2 bg-blue-500 rounded-full" />训练 {trainSplit}%</span>
                      <span className="flex items-center gap-1"><span className="w-2 h-2 bg-amber-500 rounded-full" />验证 {valSplit}%</span>
                      <span className="flex items-center gap-1"><span className="w-2 h-2 bg-green-500 rounded-full" />测试 {testSplit}%</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
          </div>

          {/* Footer */}
          <div className="flex gap-3 justify-between p-6 border-t border-gray-100">
            <div>
              {step === 'data' && (
                <button type="button" onClick={() => setStep('config')} className="btn-secondary">
                  上一步
                </button>
              )}
              {step === 'config' && (
                <button type="button" onClick={() => setStep('select')} className="btn-secondary">
                  上一步
                </button>
              )}
            </div>
            <div className="flex gap-3">
              <button type="button" onClick={handleClose} className="btn-secondary">
                取消
              </button>
              {step !== 'select' && (
                <button
                  type="submit"
                  disabled={step === 'data' && !Object.values(apiKeys).some((v: any) => v?.apiKeyConfigured)}
                  className="btn-primary disabled:opacity-40 disabled:cursor-not-allowed"
                  title={!Object.values(apiKeys).some((v: any) => v?.apiKeyConfigured) ? '请先配置 API Key' : undefined}
                >
                  {step === 'config' ? '下一步' : '开始训练'}
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}

/* ───────── File Uploader Component ───────── */
function FileUploader({
  label,
  description,
  accept,
  file,
  onChange,
  error,
  required,
}: {
  label: string
  description?: string
  accept: string
  file: File | null
  onChange: (f: File | null) => void
  error?: string
  required?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const droppedFile = e.dataTransfer.files[0]
    if (droppedFile) onChange(droppedFile)
  }

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault()
    setDragOver(true)
  }

  const handleDragLeave = () => setDragOver(false)

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation()
    onChange(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1.5">
        {label}
        {required && <span className="text-red-400 ml-0.5">*</span>}
      </label>

      {file ? (
        <div className="flex items-center gap-3 px-4 py-3 bg-green-50 border border-green-200 rounded-xl">
          <FileText className="w-5 h-5 text-green-600 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-green-800 truncate">{file.name}</p>
            <p className="text-xs text-green-600">{(file.size / 1024).toFixed(1)} KB</p>
          </div>
          <button
            type="button"
            onClick={handleRemove}
            className="p-1.5 text-green-600 hover:text-red-600 hover:bg-red-50 rounded-lg"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <div
          onClick={() => inputRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          className={`border-2 border-dashed rounded-xl px-4 py-5 text-center cursor-pointer transition-colors ${
            dragOver
              ? 'border-gray-900 bg-gray-50'
              : error
                ? 'border-red-300 bg-red-50/30'
                : 'border-gray-300 hover:border-gray-400 bg-gray-50/50'
          }`}
        >
          <Upload className={`w-5 h-5 mx-auto mb-1.5 ${error ? 'text-red-400' : 'text-gray-400'}`} />
          <p className={`text-sm ${error ? 'text-red-500' : 'text-gray-500'}`}>
            点击或拖拽上传
          </p>
          {description && (
            <p className="text-xs text-gray-400 mt-1">{description}</p>
          )}
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={accept}
        onChange={(e) => onChange(e.target.files?.[0] || null)}
        className="hidden"
      />

      {error && (
        <p className="flex items-center gap-1 text-red-500 text-xs mt-1">
          <AlertCircle className="w-3 h-3" />
          {error}
        </p>
      )}
    </div>
  )
}

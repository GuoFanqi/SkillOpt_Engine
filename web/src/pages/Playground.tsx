import { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import Editor from '@monaco-editor/react'
import {
  MessageSquare, Send, StopCircle, Pencil, Save, X,
  Settings, Trash2, ChevronDown, ChevronRight, Eye,
  Play, CheckCircle, AlertCircle, Loader2,
} from 'lucide-react'
import {
  fetchTrainingRuns, fetchSkillVersions, fetchSkillContent, chat,
  fetchTrainingData, testSkill,
} from '../services/api'
import { TrainingRun, SkillVersion, ChatMessage, TrainingData, QADataItem } from '../types'

const MODELS = [
  { value: 'deepseek-chat', label: 'DeepSeek Chat' },
  { value: 'deepseek-reasoner', label: 'DeepSeek Reasoner' },
  { value: 'gpt-4o-mini', label: 'GPT-4O Mini' },
  { value: 'gpt-4o', label: 'GPT-4O' },
  { value: 'claude-3-5-sonnet-latest', label: 'Claude 3.5 Sonnet' },
]

export default function Playground() {
  const [runs, setRuns] = useState<TrainingRun[]>([])
  const [selectedRunId, setSelectedRunId] = useState('')
  const [versions, setVersions] = useState<SkillVersion[]>([])
  const [selectedVersion, setSelectedVersion] = useState('best')

  const [skillContent, setSkillContent] = useState('')
  const [skillLoading, setSkillLoading] = useState(false)
  const [isEditingSkill, setIsEditingSkill] = useState(false)
  const [editedSkill, setEditedSkill] = useState('')

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [inputValue, setInputValue] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [abortHandle, setAbortHandle] = useState<{ abort: () => void } | null>(null)
  useEffect(() => () => abortHandle?.abort(), [abortHandle])
  const [expandedThinking, setExpandedThinking] = useState<Set<number>>(new Set())

  const [selectedModel, setSelectedModel] = useState('deepseek-reasoner')
  const [temperature, setTemperature] = useState(0.7)
  const [maxTokens, setMaxTokens] = useState(2000)
  const [showSettings, setShowSettings] = useState(false)

  const [trainingData, setTrainingData] = useState<TrainingData | null>(null)
  const [dataSplit, setDataSplit] = useState<'train' | 'val' | 'test'>('train')
  const [selectedDataItem, setSelectedDataItem] = useState<QADataItem | null>(null)

  const [skillHeight, setSkillHeight] = useState(300)
  const resizingRef = useRef(false)

  const chatEndRef = useRef<HTMLDivElement>(null)
  const [searchParams] = useSearchParams()

  // Test skill state
  const [testLoading, setTestLoading] = useState(false)
  const [testResults, setTestResults] = useState<{
    success: boolean
    results: Array<{
      question: string
      predictedAnswer: string
      expectedAnswers: string[]
      match: boolean
      em: number
      f1: number
    }>
    overallAccuracy: number
    message: string
  } | null>(null)
  const [showTestResults, setShowTestResults] = useState(false)

  useEffect(() => {
    fetchTrainingRuns().then(setRuns).catch(console.error)
  }, [])

  useEffect(() => {
    const runId = searchParams.get('run')
    const version = searchParams.get('version')
    if (runId && runs.length > 0) {
      setSelectedRunId(runId)
      if (version) setSelectedVersion(version)
    } else if (runs.length > 0 && !selectedRunId) {
      setSelectedRunId(runs[0].id)
    }
  }, [runs])

  useEffect(() => {
    if (!selectedRunId) return
    setSkillLoading(true)
    fetchSkillVersions(selectedRunId)
      .then((data) => {
        setVersions(data)
        setSelectedVersion('best')
      })
      .catch(() => setVersions([]))
      .finally(() => setSkillLoading(false))
  }, [selectedRunId])

  useEffect(() => {
    if (!selectedRunId) {
      setTrainingData(null)
      return
    }
    fetchTrainingData(selectedRunId)
      .then(setTrainingData)
      .catch(() => setTrainingData(null))
  }, [selectedRunId])

  useEffect(() => {
    if (!selectedRunId || !selectedVersion) return
    setSkillLoading(true)
    fetchSkillContent(selectedRunId, selectedVersion)
      .then((content) => {
        setSkillContent(content || '')
        setEditedSkill(content || '')
      })
      .catch(() => {
        setSkillContent('')
        setEditedSkill('')
      })
      .finally(() => setSkillLoading(false))
  }, [selectedRunId, selectedVersion])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (isLoading && messages.length > 0) {
      const lastIdx = messages.length - 1
      if (messages[lastIdx]?.role === 'assistant' && messages[lastIdx].thinking) {
        setExpandedThinking(prev => new Set([...prev, lastIdx]))
      }
    }
  }, [messages, isLoading])

  const handleSelectDataItem = (item: QADataItem) => {
    const parts = [item.question]
    if (item.context) parts.push(`上下文：${item.context}`)
    setInputValue(parts.join('\n'))
    setSelectedDataItem(item)
  }

  const handleSend = useCallback(() => {
    const text = inputValue.trim()
    if (!text || isLoading) return

    const userMsg: ChatMessage = { role: 'user', content: text }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setInputValue('')
    setIsLoading(true)

    const skillToUse = isEditingSkill ? editedSkill : skillContent

    const handle = chat(
      {
        model: selectedModel,
        skill: skillToUse,
        messages: newMessages,
        temperature,
        maxTokens,
      },
      (content) => {
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (last?.role === 'assistant') {
            return [
              ...prev.slice(0, -1),
              { ...last, content: last.content + content },
            ]
          } else {
            return [...prev, { role: 'assistant' as const, content }]
          }
        })
      },
      () => {
        setIsLoading(false)
        setAbortHandle(null)
      },
      (message) => {
        setIsLoading(false)
        setAbortHandle(null)
        setMessages((prev) => [...prev, { role: 'assistant', content: `[错误] ${message}` }])
      },
      (content) => {
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (last?.role === 'assistant') {
            return [
              ...prev.slice(0, -1),
              { ...last, thinking: (last.thinking || '') + content },
            ]
          } else {
            return [...prev, { role: 'assistant' as const, content: '', thinking: content }]
          }
        })
      },
    )

    setAbortHandle(handle)
  }, [inputValue, isLoading, messages, selectedModel, skillContent, editedSkill, isEditingSkill, temperature, maxTokens])

  const handleStop = () => {
    abortHandle?.abort()
    setIsLoading(false)
    setAbortHandle(null)
  }

  const handleClear = () => {
    setMessages([])
  }

  const handleVerifySkill = () => {
    const verifyMsg = '请列出你的 system prompt / 技能规则中包含的所有规则条目。如果你看不到任何技能规则，请回答"看不到"。'
    ;(document.querySelector('textarea') as HTMLTextAreaElement)?.focus()
    setInputValue(verifyMsg)
  }

  const handleSaveSkill = () => {
    setSkillContent(editedSkill)
    setIsEditingSkill(false)
  }

  const handleCancelEdit = () => {
    setEditedSkill(skillContent)
    setIsEditingSkill(false)
  }

  const handleTestSkill = async () => {
    if (!trainingData) return
    
    setTestLoading(true)
    setShowTestResults(true)
    
    try {
      const testCases = trainingData.val.slice(0, 5).map(item => ({
        question: item.question,
        expectedAnswers: item.answers || [],
      }))
      
      const skillToUse = isEditingSkill ? editedSkill : skillContent
      
      const result = await testSkill({
        skillContent: skillToUse,
        testCases,
        model: selectedModel,
      })
      
      setTestResults(result)
    } catch (error) {
      console.error('Test skill failed:', error)
      setTestResults({
        success: false,
        results: [],
        overallAccuracy: 0,
        message: '测试失败：' + (error as any).message,
      })
    } finally {
      setTestLoading(false)
    }
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    resizingRef.current = true
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'row-resize'

    const startY = e.clientY
    const startHeight = skillHeight

    const onMouseMove = (e: MouseEvent) => {
      if (!resizingRef.current) return
      e.preventDefault()
      const delta = e.clientY - startY
      setSkillHeight(Math.max(150, Math.min(600, startHeight + delta)))
    }
    const onMouseUp = () => {
      resizingRef.current = false
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  const selectedRun = runs.find((r) => r.id === selectedRunId)

  return (
    <div className="flex flex-col h-[calc(100vh-120px)]" id="playground-container">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 mb-1">Playground</h1>
          <p className="text-gray-500 text-sm">选择 Skill 版本，与模型对话测试效果</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleVerifySkill}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-green-600 hover:bg-green-50 rounded-xl transition-colors"
            disabled={!skillContent && !isEditingSkill}
            title={!skillContent ? '请先选择任务加载 Skill' : '发送测试消息验证 AI 是否能看到 Skill'}
          >
            <Eye className="w-4 h-4" />
            验证 Skill
          </button>
          <button
            onClick={handleTestSkill}
            disabled={!trainingData || !skillContent || testLoading}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm rounded-xl transition-colors ${
              !trainingData || !skillContent || testLoading
                ? 'bg-gray-200 text-gray-500 cursor-not-allowed'
                : 'bg-indigo-500 text-white hover:bg-indigo-600'
            }`}
          >
            {testLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                测试中...
              </>
            ) : (
              <>
                <Play className="w-4 h-4" />
                运行测试
              </>
            )}
          </button>
          <button
            onClick={handleClear}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-xl transition-colors"
          >
            <Trash2 className="w-4 h-4" />
            清空对话
          </button>
          <button
            onClick={() => setShowSettings(!showSettings)}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm rounded-xl transition-colors ${
              showSettings ? 'bg-gray-200 text-gray-800' : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            <Settings className="w-4 h-4" />
            参数
          </button>
        </div>
      </div>

      {showTestResults && (
        <div className="mb-4 bg-white border border-gray-100 rounded-2xl overflow-hidden">
          <div className="px-4 py-3 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">测试结果</span>
            <button
              onClick={() => setShowTestResults(false)}
              className="p-1 hover:bg-gray-200 rounded-lg"
            >
              <X className="w-4 h-4 text-gray-500" />
            </button>
          </div>
          <div className="p-4">
            {testLoading ? (
              <div className="flex items-center justify-center py-8 text-gray-500">
                <Loader2 className="w-6 h-6 animate-spin mr-2" />
                正在测试中...
              </div>
            ) : testResults ? (
              <>
                <div className="flex items-center gap-4 mb-4">
                  <div className={`px-4 py-2 rounded-xl ${
                    testResults.success ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                  }`}>
                    {testResults.success ? (
                      <span className="flex items-center gap-2">
                        <CheckCircle className="w-5 h-5" />
                        测试完成
                      </span>
                    ) : (
                      <span className="flex items-center gap-2">
                        <AlertCircle className="w-5 h-5" />
                        测试失败
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-gray-600">
                    验证集准确率：<strong className="text-indigo-600">{testResults.overallAccuracy}%</strong>
                  </div>
                  {testResults.message && (
                    <div className="text-sm text-gray-500">{testResults.message}</div>
                  )}
                </div>
                <div className="space-y-3 max-h-[300px] overflow-auto">
                  {testResults.results.map((result, idx) => (
                    <div
                      key={idx}
                      className={`p-3 rounded-xl border ${
                        result.match ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-2">
                        {result.match ? (
                          <CheckCircle className="w-4 h-4 text-green-600" />
                        ) : (
                          <AlertCircle className="w-4 h-4 text-red-600" />
                        )}
                        <span className={`text-xs font-medium ${
                          result.match ? 'text-green-700' : 'text-red-700'
                        }`}>
                          测试用例 {idx + 1}
                        </span>
                      </div>
                      <div className="text-xs space-y-1">
                        <div>
                          <span className="text-gray-500">问题：</span>
                          <span className="text-gray-700">{result.question}</span>
                        </div>
                        <div>
                          <span className="text-gray-500">预期答案：</span>
                          <span className="text-gray-700">{result.expectedAnswers.join(', ')}</span>
                        </div>
                        <div>
                          <span className="text-gray-500">实际回答：</span>
                          <span className="text-gray-700">{result.predictedAnswer}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        </div>
      )}

      {showSettings && (
        <div className="mb-4 bg-white border border-gray-100 rounded-2xl p-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">模型</label>
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="w-full px-3 py-2 bg-gray-100 rounded-xl text-sm border-none"
              >
                {MODELS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">
                Temperature: {temperature}
              </label>
              <input
                type="range"
                min="0"
                max="2"
                step="0.1"
                value={temperature}
                onChange={(e) => setTemperature(parseFloat(e.target.value))}
                className="w-full accent-gray-900"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">
                Max Tokens: {maxTokens}
              </label>
              <input
                type="range"
                min="256"
                max="4096"
                step="256"
                value={maxTokens}
                onChange={(e) => setMaxTokens(parseInt(e.target.value))}
                className="w-full accent-gray-900"
              />
            </div>
            <div className="flex items-end">
              <div className="text-xs text-gray-400">
                当前：{MODELS.find(m => m.value === selectedModel)?.label} |
                T={temperature} | Max={maxTokens}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="mb-3 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">任务：</span>
          <select
            value={selectedRunId}
            onChange={(e) => setSelectedRunId(e.target.value)}
            className="px-3 py-1.5 bg-gray-100 rounded-lg text-sm border-none min-w-[180px]"
          >
            <option value="">-- 选择任务 --</option>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">版本：</span>
          <select
            value={selectedVersion}
            onChange={(e) => setSelectedVersion(e.target.value)}
            className="px-3 py-1.5 bg-gray-100 rounded-lg text-sm border-none min-w-[140px]"
            disabled={!selectedRunId}
          >
            <option value="best">最佳版本 (best)</option>
            <option value="initial">初始版本 (initial)</option>
            {versions
              .filter((v) => v.version !== 'best' && v.version !== 'initial')
              .map((v) => (
                <option key={v.version} value={v.version}>
                  {v.version} ({v.chars} chars)
                </option>
              ))}
          </select>
        </div>

        {selectedRunId && trainingData && (() => {
          const currentData = trainingData[dataSplit] || []
          return (
            <>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500">拆分：</span>
                <select
                  value={dataSplit}
                  onChange={(e) => setDataSplit(e.target.value as 'train' | 'val' | 'test')}
                  className="px-3 py-1.5 bg-gray-100 rounded-lg text-sm border-none min-w-[80px]"
                >
                  <option value="train">训练 ({trainingData.train.length})</option>
                  <option value="val">验证 ({trainingData.val.length})</option>
                  <option value="test">测试 ({trainingData.test.length})</option>
                </select>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500">数据：</span>
                <select
                  value=""
                  onChange={(e) => {
                    const idx = parseInt(e.target.value)
                    if (idx >= 0 && currentData[idx]) handleSelectDataItem(currentData[idx])
                  }}
                  className="px-3 py-1.5 bg-gray-100 rounded-lg text-sm border-none min-w-[140px] max-w-[220px]"
                  disabled={currentData.length === 0}
                >
                  <option value="">-- 选择 ({currentData.length}) --</option>
                  {currentData.map((item, idx) => {
                    const questionPreview = item.question.length > 25 ? item.question.slice(0, 25) + '...' : item.question
                    return (
                      <option key={item.id || idx} value={idx}>
                        [{item.id || idx + 1}] Q: {questionPreview}
                      </option>
                    )
                  })}
                </select>
              </div>
            </>
          )
        })()}

        {selectedRun && (
          <div className="text-xs text-gray-400">
            模型: {selectedRun.model} | 验证集分数: {selectedRun.currentScore}%
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          {!isEditingSkill ? (
            <button
              onClick={() => setIsEditingSkill(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-xl transition-colors"
            >
              <Pencil className="w-3.5 h-3.5" />
              编辑 Skill
            </button>
          ) : (
            <>
              <button
                onClick={handleSaveSkill}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-indigo-500 text-white rounded-xl hover:bg-indigo-600 transition-colors"
              >
                <Save className="w-3.5 h-3.5" />
                应用修改
              </button>
              <button
                onClick={handleCancelEdit}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-xl transition-colors"
              >
                <X className="w-3.5 h-3.5" />
                取消
              </button>
            </>
          )}
        </div>
      </div>

        {selectedDataItem && (
          <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 border border-amber-200 rounded-lg text-xs max-w-[280px]">
            <span className="text-amber-600 font-medium shrink-0">期望:</span>
            <span className="text-amber-800 truncate">{selectedDataItem.answers[0] || '(无)'}</span>
            <button
              onClick={() => setSelectedDataItem(null)}
              className="text-amber-400 hover:text-amber-600 shrink-0 ml-auto"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex-shrink-0" style={{ height: skillHeight }}>
          <div className="bg-white border border-gray-100 rounded-2xl h-full overflow-hidden flex flex-col">
            <div className="px-4 py-2 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
              <span className="text-xs font-medium text-gray-500">
                Skill 编辑器
                {isEditingSkill && <span className="ml-2 text-amber-600">(编辑中...)</span>}
              </span>
              <span className="text-xs text-gray-400">
                {isEditingSkill ? editedSkill.length : skillContent.length} 字符
              </span>
            </div>
            <div className="flex-1 min-h-0">
              {skillLoading ? (
                <div className="flex items-center justify-center h-full text-gray-400 text-sm">
                  加载中...
                </div>
              ) : (
                <Editor
                  height="100%"
                  defaultLanguage="markdown"
                  value={isEditingSkill ? editedSkill : skillContent}
                  onChange={(v) => isEditingSkill && setEditedSkill(v || '')}
                  theme="vs-light"
                  options={{
                    minimap: { enabled: false },
                    fontSize: 13,
                    lineNumbers: 'on',
                    wordWrap: 'on',
                    padding: { top: 8 },
                    readOnly: !isEditingSkill,
                  }}
                />
              )}
            </div>
          </div>
        </div>

        <div
          className="h-2 cursor-row-resize hover:bg-gray-300 transition-colors flex items-center justify-center"
          onMouseDown={handleMouseDown}
        >
          <div className="w-8 h-0.5 bg-gray-300 rounded-full" />
        </div>

        <div className="flex-1 min-h-0 flex flex-col">
          <div className="bg-white border border-gray-100 rounded-2xl h-full flex flex-col overflow-hidden">
            <div className="px-4 py-2 bg-gray-50 border-b border-gray-100 flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-gray-400" />
              <span className="text-xs font-medium text-gray-500">聊天窗口</span>
              <span className={`text-xs ml-auto ${(isEditingSkill ? editedSkill : skillContent).length > 0 ? 'text-green-600' : 'text-red-400'}`}>
                Skill: {(isEditingSkill ? editedSkill : skillContent).length > 0 ? `${(isEditingSkill ? editedSkill : skillContent).length} chars` : '未加载'}
              </span>
              {isLoading && (
                <span className="text-xs text-amber-600">生成中...</span>
              )}
            </div>

            <div className="flex-1 overflow-auto p-4 space-y-3">
              {messages.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full text-gray-400">
                  <MessageSquare className="w-10 h-10 mb-3 text-gray-300" />
                  <p className="text-sm">选择一个 Skill，开始对话测试</p>
                  <p className="text-xs mt-1">Skill 将作为 system prompt 发送给模型</p>
                </div>
              )}
              {messages.map((msg, idx) => (
                <div
                  key={idx}
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  {msg.role === 'assistant' ? (
                    <div className="max-w-[85%]">
                      {msg.thinking && (
                        <div
                          className="mb-1.5 rounded-xl border border-gray-200 overflow-hidden"
                          onClick={() => setExpandedThinking(prev => {
                            const next = new Set(prev)
                            next.has(idx) ? next.delete(idx) : next.add(idx)
                            return new Set(next)
                          })}
                        >
                          <div className="flex items-center gap-2 px-3.5 py-2 bg-gray-50 cursor-pointer hover:bg-gray-100 transition-colors select-none">
                            {expandedThinking.has(idx)
                              ? <ChevronDown className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                              : <ChevronRight className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                            }
                            <span className="text-xs font-medium text-gray-500">思考过程</span>
                            {!expandedThinking.has(idx) && (
                              <span className="text-xs text-gray-400 truncate ml-1">{msg.thinking.slice(0, 80)}...</span>
                            )}
                          </div>
                          {expandedThinking.has(idx) && (
                            <div className="px-4 pb-3 pt-0">
                              <pre className="whitespace-pre-wrap text-xs text-gray-500 leading-relaxed font-sans">{msg.thinking}</pre>
                            </div>
                          )}
                        </div>
                      )}
                      <div className="bg-gray-100 text-gray-800 rounded-2xl rounded-bl-md px-4 py-2.5 text-sm leading-relaxed">
                        <pre className="whitespace-pre-wrap font-sans">{msg.content || (msg.thinking && !isLoading ? '' : '')}</pre>
                      </div>
                    </div>
                  ) : (
                    <div className="max-w-[80%] bg-gray-900 text-white rounded-2xl rounded-br-md px-4 py-2.5 text-sm leading-relaxed">
                      <pre className="whitespace-pre-wrap font-sans">{msg.content}</pre>
                    </div>
                  )}
                </div>
              ))}
              {isLoading && messages[messages.length - 1]?.role === 'user' && (
                <div className="flex justify-start">
                  <div className="bg-gray-100 text-gray-800 rounded-2xl rounded-bl-md px-4 py-2.5 text-sm">
                    <span className="inline-flex gap-1">
                      <span className="animate-bounce">●</span>
                      <span className="animate-bounce [animation-delay:0.15s]">●</span>
                      <span className="animate-bounce [animation-delay:0.3s]">●</span>
                    </span>
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            <div className="px-4 py-3 border-t border-gray-100">
              <div className="flex items-end gap-2">
                <div className="flex-1 relative">
                  <textarea
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        handleSend()
                      }
                    }}
                    placeholder="输入消息... (Enter 发送，Shift+Enter 换行)"
                    className="w-full px-4 py-3 bg-gray-100 rounded-2xl text-sm border-none focus:outline-none focus:ring-2 focus:ring-gray-900 resize-none"
                    rows={2}
                    disabled={isLoading}
                  />
                </div>
                {isLoading ? (
                  <button
                    onClick={handleStop}
                    className="p-3 bg-red-500 text-white rounded-2xl hover:bg-red-600 transition-colors"
                  >
                    <StopCircle className="w-5 h-5" />
                  </button>
                ) : (
                  <button
                    onClick={handleSend}
                    disabled={!inputValue.trim()}
                    className="p-3 bg-gray-900 text-white rounded-2xl hover:bg-gray-800 transition-colors disabled:opacity-40"
                  >
                    <Send className="w-5 h-5" />
                  </button>
                )}
              </div>
              <div className="flex items-center justify-between mt-1.5">
                <span className="text-xs text-gray-400">
                  {isEditingSkill ? '⚠️ 使用编辑中的 Skill' : (skillContent ? `Skill: ${skillContent.length} chars → ${selectedVersion}` : '⚠️ Skill 未加载')}
                </span>
                <span className="text-xs text-gray-400">
                  Enter 发送 · Shift+Enter 换行
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
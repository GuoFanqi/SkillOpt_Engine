import { TrainingRun, StepHistory, SkillVersion, ChartDataPoint, TrainingConfig, TrainingData } from '../types'
import { NewTrainingConfig } from '../components/NewTrainingModal'

const API_BASE = 'http://localhost:3002/api'

const getAuthHeaders = (includeContentType = true): Record<string, string> => {
  const token = localStorage.getItem('skillopt_token')
  const headers: Record<string, string> = {}
  if (includeContentType) headers['Content-Type'] = 'application/json'
  if (token) headers['Authorization'] = `Bearer ${token}`
  return headers
}

const handleApiError = async (res: Response, defaultMessage: string) => {
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: defaultMessage }))
    throw new Error(err.message || err.error || defaultMessage)
  }
  return res
}

export async function fetchTrainingRuns(): Promise<TrainingRun[]> {
  const res = await fetch(`${API_BASE}/runs`, { headers: getAuthHeaders() })
  if (!res.ok) throw new Error('Failed to fetch')
  return res.json()
}

export async function fetchTrainingRun(id: string): Promise<TrainingRun | null> {
  const res = await fetch(`${API_BASE}/runs/${encodeURIComponent(id)}`, { headers: getAuthHeaders() })
  if (!res.ok) throw new Error('Failed to fetch')
  return res.json()
}

export async function fetchStepHistory(runId: string): Promise<StepHistory[]> {
  const res = await fetch(`${API_BASE}/runs/${encodeURIComponent(runId)}/history`)
  if (!res.ok) throw new Error('Failed to fetch')
  return res.json()
}

export async function fetchChartData(runId: string): Promise<ChartDataPoint[]> {
  const res = await fetch(`${API_BASE}/runs/${encodeURIComponent(runId)}/chart`)
  if (!res.ok) throw new Error('Failed to fetch')
  return res.json()
}

export async function fetchSkillVersions(runId: string): Promise<SkillVersion[]> {
  const res = await fetch(`${API_BASE}/runs/${encodeURIComponent(runId)}/skills`)
  if (!res.ok) throw new Error('Failed to fetch')
  return res.json()
}

export async function fetchSkillContent(runId: string, version: string): Promise<string> {
  const res = await fetch(`${API_BASE}/runs/${encodeURIComponent(runId)}/skills/${encodeURIComponent(version)}`)
  if (!res.ok) throw new Error('Failed to fetch')
  return res.text()
}

export async function fetchCandidateSkill(runId: string, step: number | string): Promise<string> {
  const res = await fetch(`${API_BASE}/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(step)}/candidate-skill`)
  if (!res.ok) return ''
  return res.text()
}

// ─── Step Detail APIs ───
export interface StepRecord {
  [key: string]: any
}

export interface RolloutResult {
  id: string
  question: string
  em: number
  f1: number
  hard: number
  soft: number
  predicted_answer: string
  gold_answers: string[]
  response: string
  fail_reason: string
  agent_ok: boolean
  n_turns?: number
}

export interface MergedPatch {
  reasoning?: string
  edits?: Array<{ op: string; path: string; content?: string; old_string?: string; new_string?: string }>
}

export async function fetchStepRecord(runId: string, step: number | string): Promise<StepRecord> {
  const res = await fetch(`${API_BASE}/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(step)}/record`)
  if (!res.ok) return {}
  return res.json()
}

export async function fetchRolloutResults(runId: string, step: number | string): Promise<RolloutResult[]> {
  const res = await fetch(`${API_BASE}/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(step)}/rollout-results`)
  if (!res.ok) return []
  return res.json()
}

export async function fetchSelectionResults(runId: string, step: number | string): Promise<RolloutResult[]> {
  const res = await fetch(`${API_BASE}/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(step)}/selection-results`)
  if (!res.ok) return []
  return res.json()
}

export async function fetchStepPatches(runId: string, step: number | string): Promise<MergedPatch> {
  const res = await fetch(`${API_BASE}/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(step)}/patches`)
  if (!res.ok) return {}
  return res.json()
}

export async function fetchTrainingConfig(runId: string): Promise<TrainingConfig | null> {
  const res = await fetch(`${API_BASE}/runs/${encodeURIComponent(runId)}/config`)
  if (!res.ok) throw new Error('Failed to fetch')
  return res.json()
}

export async function fetchTrainingData(runId: string): Promise<TrainingData> {
  const res = await fetch(`${API_BASE}/runs/${encodeURIComponent(runId)}/data`)
  if (!res.ok) throw new Error('Failed to fetch')
  return res.json()
}

export interface StartTrainingResponse {
  runId: string
  status: string
  message: string
}

export async function startTraining(config: NewTrainingConfig): Promise<StartTrainingResponse> {
  if (config.dataMode === 'upload') {
    // File upload mode: use FormData
    const formData = new FormData()
    formData.append('trainingName', config.trainingName)
    formData.append('env', config.env)
    formData.append('model', config.model)
    formData.append('epochs', String(config.epochs))
    formData.append('batchSize', String(config.batchSize))
    formData.append('editBudget', String(config.editBudget))
    formData.append('lrScheduler', config.lrScheduler)
    formData.append('gateMetric', config.gateMetric || 'hard')
    formData.append('analystWorkers', String(config.analystWorkers ?? 16))
    formData.append('useSlowUpdate', String(config.useSlowUpdate ?? true))
    formData.append('slowUpdateGate', String(config.slowUpdateGate ?? false))
    formData.append('useMetaSkill', String(config.useMetaSkill ?? true))
    formData.append('useSkillAwareReflection', String(config.useSkillAwareReflection ?? false))
    formData.append('skillAwareAppendixSource', config.skillAwareAppendixSource ?? 'both')
    formData.append('skillAwareConsolidateThreshold', String(config.skillAwareConsolidateThreshold ?? 0))
    formData.append('dataMode', 'upload')

    if (config.uploadedFiles?.train) formData.append('trainFile', config.uploadedFiles.train)
    if (config.uploadedFiles?.val) formData.append('valFile', config.uploadedFiles.val)
    if (config.uploadedFiles?.test) formData.append('testFile', config.uploadedFiles.test)
    if (config.uploadedFiles?.initialSkill) formData.append('skillFile', config.uploadedFiles.initialSkill)

    const res = await fetch(`${API_BASE}/train`, {
      method: 'POST',
      headers: getAuthHeaders(false),
      body: formData,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to start training' }))
      throw new Error(err.message || err.error || 'Failed to start training')
    }
    return res.json()
  } else {
    // Manual mode: send JSON
    const res = await fetch(`${API_BASE}/train`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        trainingName: config.trainingName,
        env: config.env,
        model: config.model,
        epochs: config.epochs,
        batchSize: config.batchSize,
        editBudget: config.editBudget,
        lrScheduler: config.lrScheduler,
        gateMetric: config.gateMetric || 'hard',
        analystWorkers: config.analystWorkers ?? 16,
        useSlowUpdate: config.useSlowUpdate ?? true,
        slowUpdateGate: config.slowUpdateGate ?? false,
        useMetaSkill: config.useMetaSkill ?? true,
        useSkillAwareReflection: config.useSkillAwareReflection ?? false,
        skillAwareAppendixSource: config.skillAwareAppendixSource ?? 'both',
        skillAwareConsolidateThreshold: config.skillAwareConsolidateThreshold ?? 0,
        dataMode: 'manual',
        skillContent: config.skillContent,
        qaPairs: config.qaPairs,
        trainSplit: config.trainSplit,
        valSplit: config.valSplit,
      }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to start training' }))
      throw new Error(err.message || err.error || 'Failed to start training')
    }
    return res.json()
  }
}

export async function stopTraining(runId: string): Promise<{ status: string; message: string }> {
  const res = await fetch(`${API_BASE}/train/${encodeURIComponent(runId)}/stop`, {
    method: 'POST',
    headers: getAuthHeaders(),
  })
  if (!res.ok) throw new Error('Failed to stop training')
  return res.json()
}

export async function restartTraining(runId: string): Promise<{ status: string; runId: string; message: string }> {
  const res = await fetch(`${API_BASE}/train/${encodeURIComponent(runId)}/restart`, {
    method: 'POST',
    headers: getAuthHeaders(),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.message || 'Failed to restart training')
  }
  return res.json()
}

export async function deleteTraining(runId: string): Promise<{ status: string; message: string }> {
  const res = await fetch(`${API_BASE}/runs/${encodeURIComponent(runId)}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || '删除失败')
  }
  return res.json()
}

// ─── Settings / API Keys ───
export interface ApiKeySettings {
  openai?: { apiKeyConfigured?: boolean; apiKeyPreview?: string; baseUrl?: string }
  deepseek?: { apiKeyConfigured?: boolean; apiKeyPreview?: string; baseUrl?: string }
  azure?: { apiKeyConfigured?: boolean; apiKeyPreview?: string; endpoint?: string; apiVersion?: string }
  anthropic?: { apiKeyConfigured?: boolean; apiKeyPreview?: string }
  qwen?: { apiKeyConfigured?: boolean; apiKeyPreview?: string; baseUrl?: string }
  minimax?: { apiKeyConfigured?: boolean; apiKeyPreview?: string; baseUrl?: string }
}

export interface SaveApiKeysPayload {
  openai?: { apiKey?: string; baseUrl?: string }
  deepseek?: { apiKey?: string; baseUrl?: string }
  azure?: { apiKey?: string; endpoint?: string; apiVersion?: string }
  anthropic?: { apiKey?: string }
  qwen?: { apiKey?: string; baseUrl?: string }
  minimax?: { apiKey?: string; baseUrl?: string }
}

export async function fetchApiKeys(): Promise<ApiKeySettings> {
  const res = await fetch(`${API_BASE}/settings/api-keys`, { headers: getAuthHeaders() })
  if (!res.ok) throw new Error('Failed to load settings')
  return res.json()
}

export async function saveApiKeys(payload: SaveApiKeysPayload): Promise<{ status: string; keys: ApiKeySettings }> {
  const res = await fetch(`${API_BASE}/settings/api-keys`, {
    method: 'PUT',
    headers: getAuthHeaders(),
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error('Failed to save settings')
  return res.json()
}

export interface TestApiKeyResult {
  success: boolean
  model: string
  message: string
  details?: string
}

export async function testApiKey(provider: string): Promise<TestApiKeyResult> {
  const res = await fetch(`${API_BASE}/settings/api-keys/test`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ provider }),
  })
  if (!res.ok) throw new Error('Failed to test')
  return res.json()
}

export async function deleteApiKey(provider: string): Promise<{ status: string; keys: ApiKeySettings }> {
  const res = await fetch(`${API_BASE}/settings/api-keys/${encodeURIComponent(provider)}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  })
  if (!res.ok) throw new Error('Failed to delete API key')
  return res.json()
}

// ─── Skill Management ───
export interface SaveSkillPayload {
  skillId: string
  skillName: string
  skillContent: string
  description?: string
}

export interface SaveSkillResponse {
  success: boolean
  message: string
  skillId: string
}

export async function saveSkill(payload: SaveSkillPayload): Promise<SaveSkillResponse> {
  const res = await fetch(`${API_BASE}/skills/${encodeURIComponent(payload.skillId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  await handleApiError(res, 'Failed to save skill')
  return res.json()
}

export interface TestSkillPayload {
  skillContent: string
  testCases: Array<{
    question: string
    expectedAnswers: string[]
  }>
  model?: string
}

export interface TestSkillResult {
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
}

export async function testSkill(payload: TestSkillPayload): Promise<TestSkillResult> {
  const res = await fetch(`${API_BASE}/skills/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  await handleApiError(res, 'Failed to test skill')
  return res.json()
}

// ─── Playground Chat (SSE streaming) ───
import { ChatRequest } from '../types'

export function chat(
  request: ChatRequest,
  onChunk: (content: string) => void,
  onDone?: () => void,
  onError?: (message: string) => void,
  onReasoning?: (content: string) => void,
): { abort: () => void } {
  const controller = new AbortController()

  ;(async () => {
    try {
      const res = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: request.model,
          skill: request.skill,
          messages: request.messages,
          temperature: request.temperature ?? 0.7,
          maxTokens: request.maxTokens ?? 2000,
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        onError?.(err.error || 'Failed to start chat')
        return
      }

      if (!res.body) {
        onError?.('No response body')
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (data === '[DONE]') {
            onDone?.()
            return
          }
          try {
            const parsed = JSON.parse(data)
            if (parsed.type === 'reasoning' && parsed.content) {
              onReasoning?.(parsed.content)
            } else if (parsed.type === 'chunk' && parsed.content) {
              onChunk(parsed.content)
            } else if (parsed.type === 'done') {
              onDone?.()
              return
            } else if (parsed.type === 'error') {
              onError?.(parsed.message || 'Unknown error')
              return
            }
          } catch {
            // Ignore malformed SSE lines
          }
        }
      }
      onDone?.()
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        onError?.(err.message || 'Chat failed')
      }
    }
  })()

  return { abort: () => controller.abort() }
}

// ─── Templates API ───
export interface SkillTemplate {
  id: string; name: string; description: string; icon: string; category: string
  difficulty: string; skillContent: string; trainQa: any[]; valQa: any[]
  splitRatio: number; config: any; expectedMetrics: any; highlights: string[]
}

export async function fetchTemplates(): Promise<SkillTemplate[]> {
  const res = await fetch(`${API_BASE}/templates`, { headers: getAuthHeaders() })
  if (!res.ok) throw new Error('Failed to fetch templates')
  return res.json()
}

export async function saveTemplate(tpl: SkillTemplate): Promise<void> {
  const res = await fetch(`${API_BASE}/templates`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(tpl),
  })
  if (!res.ok) throw new Error('Failed to save template')
}

export async function deleteTemplate(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/templates/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  })
  if (!res.ok) throw new Error('Failed to delete template')
}

// ─── Training Logs ───
export interface LogEntry {
  id: number
  type: 'stdout' | 'stderr'
  text: string
  created_at: string
}

export async function fetchTrainingLogs(runId: string, limit = 500): Promise<LogEntry[]> {
  const res = await fetch(`${API_BASE}/runs/${encodeURIComponent(runId)}/logs?limit=${limit}`)
  if (!res.ok) throw new Error('Failed to fetch logs')
  return res.json()
}

// ─── AI Summary (streaming) ───
export async function generateAISummaryStream(runId: string): Promise<Response> {
  return fetch(`${API_BASE}/runs/${encodeURIComponent(runId)}/generate-summary?stream=1`, {
    method: 'POST',
    headers: getAuthHeaders(),
  })
}

export async function askAIChat(runId: string, question: string): Promise<Response> {
  return fetch(`${API_BASE}/runs/${encodeURIComponent(runId)}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  })
}

// ─── Evaluation Details ───
export interface EvalDetail {
  id: number
  run_id: string
  step: number
  phase: string
  item_id: string
  question: string
  gold_answer: string
  system_prompt: string
  user_prompt: string
  model_response: string
  extracted_answer: string
  is_correct: number
  score_em: number
  score_f1: number
  n_turns: number
  created_at: string
}

export interface EvalSummary {
  phase: string
  step: number
  total: number
  correct: number
  avg_f1: number
}

export async function fetchEvalSummary(runId: string): Promise<EvalSummary[]> {
  const res = await fetch(`${API_BASE}/runs/${encodeURIComponent(runId)}/evaluations`)
  if (!res.ok) throw new Error('Failed to fetch evaluations')
  return res.json()
}

export async function fetchEvalDetails(runId: string, step: number, phase?: string): Promise<EvalDetail[]> {
  let url = `${API_BASE}/runs/${encodeURIComponent(runId)}/evaluations?step=${step}`
  if (phase) url += `&phase=${phase}`
  const res = await fetch(url)
  if (!res.ok) throw new Error('Failed to fetch evaluation details')
  return res.json()
}

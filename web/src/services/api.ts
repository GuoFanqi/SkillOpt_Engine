import { TrainingRun, StepHistory, SkillVersion, ChartDataPoint, TrainingConfig, TrainingData } from '../types'
import { NewTrainingConfig } from '../components/NewTrainingModal'

import { API_BASE } from '../lib/endpoints'
import { CATEGORIES, DEFAULT_CONFIG, DEFAULT_METRICS, type SkillTemplate } from '../data/templates'

async function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem('skillopt_token')
  const headers = new Headers(options.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const response = await window.fetch(url, { ...options, headers })
  if (localStorage.getItem('skillopt_token') !== token) throw new DOMException('Account changed', 'AbortError')
  if (response.status === 401 && token) {
    window.dispatchEvent(new CustomEvent('skillopt-auth-expired', { detail: token }))
  }
  return response
}

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

async function readJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await apiFetch(`${API_BASE}${path}`, { signal })
  await handleApiError(res, '读取失败')
  return res.json()
}

export function fetchTrainingRuns(signal?: AbortSignal): Promise<TrainingRun[]> {
  return readJson('/runs', signal)
}

export function fetchTrainingRun(id: string, signal?: AbortSignal): Promise<TrainingRun> {
  return readJson(`/runs/${encodeURIComponent(id)}`, signal)
}

export function fetchStepHistory(runId: string, signal?: AbortSignal): Promise<StepHistory[]> {
  return readJson(`/runs/${encodeURIComponent(runId)}/history`, signal)
}

export function fetchChartData(runId: string, signal?: AbortSignal): Promise<ChartDataPoint[]> {
  return readJson(`/runs/${encodeURIComponent(runId)}/chart`, signal)
}

export function fetchSkillVersions(runId: string, signal?: AbortSignal): Promise<SkillVersion[]> {
  return readJson(`/runs/${encodeURIComponent(runId)}/skills`, signal)
}

export async function fetchSkillContent(runId: string, version: string, signal?: AbortSignal): Promise<string> {
  const res = await apiFetch(`${API_BASE}/runs/${encodeURIComponent(runId)}/skills/${encodeURIComponent(version)}`, { signal })
  await handleApiError(res, '读取技能失败')
  return res.text()
}

export async function fetchCandidateSkill(runId: string, step: number | string, signal?: AbortSignal): Promise<string> {
  const res = await apiFetch(`${API_BASE}/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(step)}/candidate-skill`, { signal })
  if (res.status === 404) return ''
  await handleApiError(res, '读取候选技能失败')
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
  const res = await apiFetch(`${API_BASE}/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(step)}/record`)
  if (!res.ok) return {}
  return res.json()
}

export async function fetchRolloutResults(runId: string, step: number | string): Promise<RolloutResult[]> {
  const res = await apiFetch(`${API_BASE}/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(step)}/rollout-results`)
  if (!res.ok) return []
  return res.json()
}

export async function fetchSelectionResults(runId: string, step: number | string): Promise<RolloutResult[]> {
  const res = await apiFetch(`${API_BASE}/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(step)}/selection-results`)
  if (!res.ok) return []
  return res.json()
}

export async function fetchStepPatches(runId: string, step: number | string): Promise<MergedPatch> {
  const res = await apiFetch(`${API_BASE}/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(step)}/patches`)
  if (!res.ok) return {}
  return res.json()
}

export function fetchTrainingConfig(runId: string, signal?: AbortSignal): Promise<TrainingConfig | null> {
  return readJson(`/runs/${encodeURIComponent(runId)}/config`, signal)
}

export function fetchTrainingData(runId: string, signal?: AbortSignal): Promise<TrainingData> {
  return readJson(`/runs/${encodeURIComponent(runId)}/data`, signal)
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

    const res = await apiFetch(`${API_BASE}/train`, {
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
    const res = await apiFetch(`${API_BASE}/train`, {
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
  const res = await apiFetch(`${API_BASE}/train/${encodeURIComponent(runId)}/stop`, {
    method: 'POST',
    headers: getAuthHeaders(),
  })
  if (!res.ok) throw new Error('Failed to stop training')
  return res.json()
}

export async function restartTraining(runId: string): Promise<{ status: string; runId: string; message: string }> {
  const res = await apiFetch(`${API_BASE}/train/${encodeURIComponent(runId)}/restart`, {
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
  const res = await apiFetch(`${API_BASE}/runs/${encodeURIComponent(runId)}`, {
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
  const res = await apiFetch(`${API_BASE}/settings/api-keys`, { headers: getAuthHeaders() })
  if (!res.ok) throw new Error('Failed to load settings')
  return res.json()
}

export async function saveApiKeys(payload: SaveApiKeysPayload): Promise<{ status: string; keys: ApiKeySettings }> {
  const res = await apiFetch(`${API_BASE}/settings/api-keys`, {
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
  const res = await apiFetch(`${API_BASE}/settings/api-keys/test`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ provider }),
  })
  if (!res.ok) throw new Error('Failed to test')
  return res.json()
}

export async function deleteApiKey(provider: string): Promise<{ status: string; keys: ApiKeySettings }> {
  const res = await apiFetch(`${API_BASE}/settings/api-keys/${encodeURIComponent(provider)}`, {
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
  const res = await apiFetch(`${API_BASE}/skills/${encodeURIComponent(payload.skillId)}`, {
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
  const res = await apiFetch(`${API_BASE}/skills/test`, {
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
      const res = await apiFetch(`${API_BASE}/chat`, {
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
export type { SkillTemplate } from '../data/templates'

type StoredTemplate = Omit<SkillTemplate, 'categoryLabel' | 'env'> & Partial<Pick<SkillTemplate, 'categoryLabel' | 'env'>>

export async function fetchTemplates(signal?: AbortSignal): Promise<SkillTemplate[]> {
  const templates = await readJson<StoredTemplate[]>('/templates', signal)
  return templates.map(template => ({
    ...template,
    categoryLabel: template.categoryLabel || CATEGORIES.find(category => category.key === template.category)?.label || '自定义',
    env: template.env || template.config?.env || 'searchqa',
    config: { ...DEFAULT_CONFIG, ...template.config },
    expectedMetrics: { ...DEFAULT_METRICS, ...template.expectedMetrics },
  }))
}

export async function saveTemplate(tpl: SkillTemplate): Promise<void> {
  const res = await apiFetch(`${API_BASE}/templates`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ ...tpl, config: { ...tpl.config, env: tpl.env } }),
  })
  if (!res.ok) throw new Error('Failed to save template')
}

export async function deleteTemplate(id: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/templates/${encodeURIComponent(id)}`, {
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

export function fetchTrainingLogs(runId: string, limit = 500, signal?: AbortSignal): Promise<LogEntry[]> {
  return readJson(`/runs/${encodeURIComponent(runId)}/logs?limit=${limit}`, signal)
}

// ─── AI Summary (streaming) ───
export async function generateAISummaryStream(runId: string, signal?: AbortSignal): Promise<Response> {
  return apiFetch(`${API_BASE}/runs/${encodeURIComponent(runId)}/generate-summary?stream=1`, {
    method: 'POST',
    headers: getAuthHeaders(),
    signal,
  })
}

export async function askAIChat(runId: string, question: string, signal?: AbortSignal): Promise<Response> {
  return apiFetch(`${API_BASE}/runs/${encodeURIComponent(runId)}/chat`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ question }),
    signal,
  })
}

export async function readAIStream(response: Response, onText: (text: string) => void, signal: AbortSignal): Promise<string> {
  await handleApiError(response, '请求失败')
  if (!response.body) throw new Error('响应内容为空')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (signal.aborted) throw new DOMException('Request cancelled', 'AbortError')
      buffer += done ? decoder.decode() + '\n' : decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') return text
        const data = JSON.parse(payload) as { text?: string; done?: boolean; error?: string }
        if (data.error) throw new Error(data.error)
        if (data.text) { text += data.text; onText(text) }
        if (data.done) return text
      }
      if (done) return text
    }
    throw new DOMException('Request cancelled', 'AbortError')
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
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

export function fetchEvalSummary(runId: string, signal?: AbortSignal): Promise<EvalSummary[]> {
  return readJson(`/runs/${encodeURIComponent(runId)}/evaluations`, signal)
}

export function fetchEvalDetails(runId: string, step: number, phase?: string, signal?: AbortSignal): Promise<EvalDetail[]> {
  const phaseQuery = phase ? `&phase=${encodeURIComponent(phase)}` : ''
  return readJson(`/runs/${encodeURIComponent(runId)}/evaluations?step=${step}${phaseQuery}`, signal)
}

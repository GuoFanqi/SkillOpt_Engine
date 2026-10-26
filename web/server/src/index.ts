import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { registerAdminRoutes } from './admin-api.js'
import { readFile, mkdir, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
import { WebSocketServer, WebSocket } from 'ws'
import { createServer } from 'http'
import { apiKeys as dbApiKeys, trainingRuns as dbTrainingRuns, stepHistory as dbStepHistory, skillVersions as dbSkillVersions, trainingData as dbTrainingData, userSkills as dbUserSkills, templates as dbTemplates, users as dbUsers, trainingLogs as dbTrainingLogs, evaluationDetails as dbEvalDetails } from './db.js'
import bcrypt from 'bcryptjs'
import { authenticateToken, verifyToken, signToken, requireAuth, canAccessRun, AuthError } from './auth.js'
import { assertPathWithin, resolveRunPath, validateRunId, PathError } from './safe-paths.js'
import { readRunArtifacts } from './run-artifacts.js'
import { replaceRunArtifacts } from './db.js'
import { createTrainingService } from './training.js'
import { isTerminal, readState } from './run-state.js'

const app = express()
const server = createServer(app)
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 })

app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? (process.env.CORS_ORIGIN || 'http://localhost:3000') 
    : ['http://localhost:3000', 'http://localhost:5173'],
  credentials: true,
}))
app.use(express.json({ limit: '50mb' }))

// Serve built frontend in production
const frontendDist = process.env.FRONTEND_DIST || join(__dirname, '..', '..', 'dist')
if (process.env.NODE_ENV === 'production' && existsSync(frontendDist)) {
  app.use(express.static(frontendDist))
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next()
    res.sendFile(join(frontendDist, 'index.html'))
  })
}

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..')
const uploadsDir = resolve(process.env.SKILLOPT_UPLOADS_DIR || join(PROJECT_ROOT, 'web', 'uploads'))
const OUTPUTS_DIR = resolve(process.env.SKILLOPT_OUTPUTS_DIR || join(PROJECT_ROOT, 'web', 'outputs'))

// ─── AI Summary ───────────────────────────────────────────────────────────
async function buildAISummaryPrompt(runId: string) {
  const dbRun = await dbTrainingRuns.getById(runId) as any
  if (!dbRun) return null

  const history = await dbStepHistory.getByRunId(runId) as any[]
  const skillVersions = await dbSkillVersions.getByRunId(runId) as any[]

  // Stats
  const accepts = history.filter((h: any) => h.action?.includes('accept') || h.action === 'force_accept').length
  const rejects = history.filter((h: any) => h.action === 'reject' || h.action === 'rejected').length
  const skips = history.filter((h: any) => h.action === 'skip' || h.action === 'skip_no_patches' || h.action === 'skip_no_rewrite').length
  const totalWall = history.reduce((s: number, h: any) => s + (h.wall_time_s || 0), 0)

  // Per-step details with full metrics
  const stepDetails = history.map((h: any, i: number) => {
    const cur = Math.round((h.current_score || 0) * 100)
    const best = Math.round((h.best_score || 0) * 100)
    const valH = Math.round((h.selection_hard || 0) * 100)
    const valS = Math.round((h.selection_soft || 0) * 100)
    const trainH = Math.round((h.rollout_hard || 0) * 100)
    const nPatches = h.n_patches || 0
    const nSuccess = h.n_success_patches || 0
    const dt = (h.wall_time_s || 0).toFixed(1)
    const skillLen = h.skill_len || 0
    const prevLen = i > 0 ? (history[i - 1].skill_len || 0) : skillLen
    const lenDelta = skillLen - prevLen
    const actionLabel = (a: string) => {
      if (a === 'accept_new_best') return '接受(新最佳)'
      if (a?.includes('accept')) return '接受'
      if (a === 'reject') return '拒绝'
      return '跳过'
    }
    return `步骤${h.step} [${actionLabel(h.action)}]：训练集准确率${trainH}% | 验证集 hard=${valH}% soft=${valS}% | 分数 ${cur}%→${best}% | 修改补丁 ${nSuccess}/${nPatches} | 耗时${dt}s | Skill长度 ${skillLen}字(${lenDelta >= 0 ? '+' : ''}${lenDelta})`
  }).join('\n')

  // Skill version summary
  const versionSummary = skillVersions.length > 0
    ? skillVersions.map((s: any) => `v${s.version}: ${(s.content || '').length}字`).join(', ')
    : '无版本记录'

  // Epoch grouping
  const epochs = [...new Set(history.map((h: any) => h.epoch || 1))].sort((a: any, b: any) => a - b)
  const epochSummary = epochs.map((e: any) => {
    const es = history.filter((h: any) => (h.epoch || 1) === e)
    const eAcc = es.filter((h: any) => h.action?.includes('accept') || h.action === 'force_accept').length
    const eRej = es.filter((h: any) => h.action === 'reject' || h.action === 'rejected').length
    const eSkip = es.length - eAcc - eRej
    const eBest = Math.max(...es.map((h: any) => Math.round((h.best_score || 0) * 100)))
    return `Epoch ${e}: ${es.length}步 接受${eAcc} 拒绝${eRej} 跳过${eSkip} 最佳${eBest}%`
  }).join('\n')

  // Gate metric
  const gateMetric = history[0]?.gate_metric || dbRun.gate_metric || 'soft'

  // Pre-compute complex data
  const bestSkill = skillVersions.find((s: any) => s.version === 'best') || skillVersions[skillVersions.length - 1]
  const bestSkillPreview = (bestSkill?.content || '无').slice(0, 1500)
  const dataBySplit = await dbTrainingData.getByRunId(runId) as any
  const trainCount = dbRun.train_size || dataBySplit?.train?.length || '?'
  const valCount = dbRun.val_size || dataBySplit?.val?.length || '?'
  const testCount = dbRun.test_size || dataBySplit?.test?.length || '?'
  let evalStatsText = '无'
  try {
    const evalSummary = await dbEvalDetails.getSummary(runId) as any[]
    evalStatsText = evalSummary.map((e: any) => `${e.phase === 'baseline_selection' ? '基线' : e.phase === 'rollout' ? '训练Rollout' : e.phase === 'selection' ? '验证Selection' : e.phase}: Step${e.step} 正确${e.correct}/${e.total}`).join('\n')
  } catch {}

  const prompt = `你是一个 AI 训练分析助手，请用Markdown格式简要分析以下训练结果（200字以内，不要重复）：

1. 训练效果概述（初始→最终分数）
2. 关键步骤分析（最大提升步骤和被拒原因）
3. 改进建议

【训练基本信息】
名称：${dbRun.name}
模型：${dbRun.model} | Epochs：${dbRun.epochs} | Batch：${dbRun.batch_size || '?'} | Gate：${gateMetric}
初始Skill分：${Math.round(dbRun.initial_score || 0)}% → 最终分：${Math.round(dbRun.current_score || 0)}% | 历史最佳：${Math.round(dbRun.best_score || 0)}%
总步骤：${history.length} | 接受：${accepts} | 拒绝：${rejects} | 跳过：${skips} | 总耗时：${totalWall.toFixed(0)}s

【逐步骤详情】
${stepDetails || '无训练步骤'}

【Epoch 汇总】
${epochSummary || '无Epoch数据'}

【Skill版本历史】
${versionSummary}

【最终Skill内容预览（最佳版本前1500字）】
${bestSkillPreview}

【数据集概况】
训练集：${trainCount} 题 | 验证集：${valCount} 题 | 测试集：${testCount} 题
${dbRun.baseline_test_score ? `基线测试分：${Math.round(dbRun.baseline_test_score)}% ` : ''}${dbRun.test_score ? `最终测试分：${Math.round(dbRun.test_score)}%` : ''}

【各阶段评估统计】
${evalStatsText}`

  const runUserId = dbRun.user_id || null
  const keys = await loadApiKeys(runUserId)
  const model = dbRun.model || 'deepseek-flash'
  const apiKey = (model.startsWith('deepseek') ? keys.deepseek?.apiKey : keys.openai?.apiKey) || ''
  if (!apiKey) return null

  return { prompt, model, apiKey, baseUrl: keys.deepseek?.baseUrl || keys.openai?.baseUrl }
}

async function generateAISummary(runId: string, expectedInstanceId?: string) {
  try {
    const ctx = await buildAISummaryPrompt(runId)
    if (!ctx) return
    const { prompt, model, apiKey } = ctx

    const dbRun = await dbTrainingRuns.getById(runId) as any
    const instanceId = readState(dbRun?.state_json)?.instanceId ?? null
    if (expectedInstanceId && instanceId !== expectedInstanceId) return
    if (dbRun?.ai_summary) return

    const baseUrl = ctx.baseUrl || (model.startsWith('deepseek') ? 'https://api.deepseek.com/v1' : 'https://api.openai.com/v1')
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: model.startsWith('deepseek') ? 'deepseek-flash' : 'glm-5.3',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 400, temperature: 0.7, frequency_penalty: 0.3,
      }),
    })
    const data = await resp.json() as any
    const summary = data?.choices?.[0]?.message?.content || ''
    if (summary) {
      if (await dbTrainingRuns.saveSummary(runId, summary, instanceId)) {
        console.log(`[AI] Summary generated for ${runId}`)
      }
    }
  } catch (e: any) {
    console.error(`[AI] Summary failed for ${runId}:`, e.message)
  }
}

async function syncRunToDb(runId: string): Promise<void> {
  const runPath = await resolveRunPath(OUTPUTS_DIR, runId)
  const snapshot = await readRunArtifacts(runPath, runId, uploadsDir)
  await replaceRunArtifacts(runId, snapshot)
}

// ─── API Key helpers (DB-backed) ───
type ApiKeyConfig = Partial<Record<'openai' | 'deepseek' | 'azure' | 'anthropic' | 'qwen' | 'minimax', {
  apiKey: string
  baseUrl?: string
  endpoint?: string
  apiVersion?: string
}>>

async function loadApiKeys(userId?: number | null): Promise<ApiKeyConfig> {
  const all = await dbApiKeys.getAll(userId ?? null)
  const result: ApiKeyConfig = {}
  for (const [provider, cfg] of Object.entries(all)) {
    const raw = await dbApiKeys.getRaw(provider, userId ?? null)
    if (raw && cfg.apiKeyConfigured) {
      ;(result as any)[provider] = {
        apiKey: raw.api_key,
        baseUrl: cfg.baseUrl,
        endpoint: cfg.endpoint,
        apiVersion: cfg.apiVersion,
      }
    }
  }
  return result
}

async function saveApiKeys(config: ApiKeyConfig): Promise<void> {
  for (const [provider, cfg] of Object.entries(config)) {
    if (!cfg) continue
    await dbApiKeys.save(provider, {
      api_key: cfg.apiKey || '',
      base_url: cfg.baseUrl || '',
      endpoint: cfg.endpoint || '',
      api_version: cfg.apiVersion || '',
    })
  }
}

async function loadMaskedApiKeys(): Promise<Record<string, any>> {
  return await dbApiKeys.getAll()
}

/** Resolve env vars to inject based on selected model and saved API keys */
async function resolveModelEnv(model: string, userId?: number | null): Promise<Record<string, string>> {
  const keys = await loadApiKeys(userId ?? null)
  const env: Record<string, string> = {}
  const isDeepSeek = model.startsWith('deepseek')
  const isOpenAI = !model.startsWith('deepseek') && !model.startsWith('claude')
  const isClaude = model.startsWith('claude')

  if (isDeepSeek && keys.deepseek) {
    env.OPENAI_API_KEY = keys.deepseek.apiKey
    env.OPENAI_BASE_URL = keys.deepseek.baseUrl || 'https://api.deepseek.com/v1'
  } else if (isOpenAI && keys.openai) {
    env.OPENAI_API_KEY = keys.openai.apiKey
    if (keys.openai.baseUrl) env.OPENAI_BASE_URL = keys.openai.baseUrl
  } else if (isClaude && keys.anthropic) {
    env.ANTHROPIC_API_KEY = keys.anthropic.apiKey
  }

  // Azure OpenAI keys for evaluation backend
  // Only inject if both apiKey and endpoint are configured; otherwise
  // let spawn logic remove them from the child env entirely (empty strings
  // still count as "present" for `'KEY' in os.environ` checks in Python)
  if (keys.azure?.apiKey && keys.azure?.endpoint) {
    env.AZURE_OPENAI_ENDPOINT = keys.azure.endpoint
    env.AZURE_OPENAI_API_KEY = keys.azure.apiKey
    if (keys.azure.apiVersion) env.AZURE_OPENAI_API_VERSION = keys.azure.apiVersion
  }

  return env
}

/**
 * Build child-process environment, merging modelEnv into process.env.
 *
 * When the backend is 'openai_chat' (e.g. DeepSeek or OpenAI), the Python
 * azure_openai.py module needs AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_AUTH_MODE
 * to create a compatible OpenAI client. We set them based on the model type.
 *
 * When Azure is NOT configured, delete AZURE_* keys entirely so Python's
 * `'AZURE_OPENAI_API_KEY' in os.environ` returns False.
 */
function buildChildEnv(modelEnv: Record<string, string>, model: string): Record<string, string> {
  const env: Record<string, string> = { PYTHONUNBUFFERED: '1' }
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/(?:API_KEY|JWT_SECRET|MYSQL_PASSWORD|SMTP_PASS|SMS_SECRET|TOKEN)/i.test(key)) env[key] = value
  }
  Object.assign(env, modelEnv)

  const azureVars = [
    'AZURE_OPENAI_ENDPOINT',
    'AZURE_OPENAI_API_KEY',
    'AZURE_OPENAI_API_VERSION',
    'AZURE_OPENAI_AUTH_MODE',
    'OPTIMIZER_AZURE_OPENAI_ENDPOINT',
    'OPTIMIZER_AZURE_OPENAI_API_KEY',
    'TARGET_AZURE_OPENAI_ENDPOINT',
    'TARGET_AZURE_OPENAI_API_KEY',
  ]

  // If no Azure endpoint is configured, configure the "endpoint" for
  // openai_chat-compatible backends (DeepSeek, OpenAI) so that
  // azure_openai._make_client() can create an OpenAI() client.
  if (!modelEnv.AZURE_OPENAI_ENDPOINT) {
    const isDeepSeek = model.startsWith('deepseek')
    const isOpenAI = !model.startsWith('deepseek') && !model.startsWith('claude')

    if (isDeepSeek && env.OPENAI_BASE_URL) {
      env.AZURE_OPENAI_ENDPOINT = env.OPENAI_BASE_URL
      env.AZURE_OPENAI_AUTH_MODE = 'openai_compatible'
      env.AZURE_OPENAI_API_KEY = env.OPENAI_API_KEY || ''
    } else if (isOpenAI && env.OPENAI_BASE_URL) {
      env.AZURE_OPENAI_ENDPOINT = env.OPENAI_BASE_URL
      env.AZURE_OPENAI_AUTH_MODE = 'openai_compatible'
      env.AZURE_OPENAI_API_KEY = env.OPENAI_API_KEY || ''
    } else if (isOpenAI && env.OPENAI_API_KEY) {
      // Default OpenAI endpoint
      env.AZURE_OPENAI_ENDPOINT = 'https://api.openai.com/v1'
      env.AZURE_OPENAI_AUTH_MODE = 'openai_compatible'
      env.AZURE_OPENAI_API_KEY = env.OPENAI_API_KEY
    } else {
      // No compatible backend configured — strip Azure vars
      for (const key of azureVars) {
        delete env[key]
      }
    }
  }

  return env
}

// ─── Auth (Phone + Verification Code) ───
const authMiddleware = requireAuth

const optionalAuth = async (req: any, res: any, next: any) => {
  const header = req.headers.authorization
  if (!header) return next()
  if (!header.startsWith('Bearer ')) return res.status(401).json({ error: '登录已过期或无效' })
  try { req.user = await authenticateToken(header.slice(7)); next() }
  catch (error) {
    if (error instanceof AuthError) res.status(401).json({ error: error.message })
    else next(error)
  }
}

// In-memory verification code store (phone → {code, expires})
const codeStore = new Map<string, { code: string; expires: number }>()
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of codeStore) { if (v.expires < now) codeStore.delete(k) }
}, 60000).unref()

app.post('/api/auth/send-code', async (req, res) => {
  try {
    const { phone } = req.body as { phone: string }
    if (!phone || !/^1\d{10}$/.test(phone)) return res.status(400).json({ error: '请输入正确的手机号' })

    // Rate limit: 60s between sends
    const existing = codeStore.get(phone)
    if (existing && existing.expires > Date.now() + 240000) {
      return res.status(429).json({ error: '请 60 秒后再试' })
    }

    const code = String(Math.floor(100000 + Math.random() * 900000))
    codeStore.set(phone, { code, expires: Date.now() + 300000 }) // 5min expiry
    const response: any = { success: true, message: '验证码已发送' }
    if (process.env.NODE_ENV !== 'production') response.dev_code = code
    res.json(response)
  } catch (e: any) { console.error(e); res.status(500).json({ error: '发送失败' }) }
})

app.post('/api/auth/register', async (req, res) => {
  try {
    const { phone, code, password } = req.body as { phone: string; code: string; password: string }
    if (!phone || !code || !password) return res.status(400).json({ error: '参数不完整' })
    if (!/^1\d{10}$/.test(phone)) return res.status(400).json({ error: '手机号格式错误' })
    if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' })

    // Verify code
    const stored = codeStore.get(phone)
    if (!stored || stored.expires < Date.now()) return res.status(400).json({ error: '验证码已过期' })
    if (stored.code !== code) return res.status(400).json({ error: '验证码错误' })
    codeStore.delete(phone)

    const existing = await dbUsers.findByPhone(phone)
    if (existing) return res.status(409).json({ error: '该手机号已注册，请直接登录' })

    const hash = await bcrypt.hash(password, 10)
    const user = await dbUsers.create(phone, hash)
    const token = signToken({ id: user.id, phone: user.phone })
    res.json({ user: { id: user.id, phone: user.phone, is_admin: 0 }, token })
  } catch (e) { res.status(500).json({ error: '注册失败' }) }
})

app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone, code, password } = req.body as { phone: string; code?: string; password?: string }
    if (!phone) return res.status(400).json({ error: '请输入手机号' })

    const user = await dbUsers.findByPhone(phone)
    if (!user) return res.status(401).json({ error: '该手机号未注册' })

    let authenticated = false

    // 验证码登录
    if (code) {
      const stored = codeStore.get(phone)
      if (!stored || stored.expires < Date.now()) return res.status(400).json({ error: '验证码已过期' })
      if (stored.code !== code) return res.status(400).json({ error: '验证码错误' })
      codeStore.delete(phone)
      authenticated = true
    }
    // 密码登录
    else if (password) {
      authenticated = await bcrypt.compare(password, user.password_hash)
    } else {
      return res.status(400).json({ error: '请输入验证码或密码' })
    }

    if (!authenticated) return res.status(401).json({ error: '密码错误' })

    const token = signToken({ id: user.id, phone: user.phone })
    res.json({ user: { id: user.id, phone: user.phone, is_admin: user.is_admin || 0 }, token })
  } catch (e) { res.status(500).json({ error: '登录失败' }) }
})

app.get('/api/auth/me', authMiddleware, async (req: any, res) => {
  try {
    const user = await dbUsers.findById(req.user.id)
    if (!user) return res.status(401).json({ error: '用户不存在' })
    res.json({ id: user.id, phone: user.phone, is_admin: user.is_admin || 0 })
  } catch { res.status(500).json({ error: '获取用户信息失败' }) }
})

// ─── Settings / API Keys (DB-backed) ───
app.get('/api/settings/api-keys', requireAuth, async (req: any, res) => {
  try {
    const userId = req.user?.id || null
    res.json(await dbApiKeys.getAll(userId))
  } catch (error) {
    res.status(500).json({ error: 'Failed to load settings' })
  }
})

app.post('/api/settings/api-keys/test', requireAuth, async (req: any, res) => {
  try {
    const { provider } = req.body as { provider: string }
    if (!provider) {
      return res.status(400).json({ error: 'Missing provider' })
    }

    const userId = req.user?.id || null
    const raw = await dbApiKeys.getRaw(provider, userId)
    const apiKey = raw?.api_key
    if (!apiKey) {
      return res.status(400).json({ error: '该提供商未配置 API Key' })
    }

    let result: { success: boolean; model: string; message: string; details?: string }
    const cfg = {
      apiKey,
      baseUrl: raw?.base_url || '',
      endpoint: raw?.endpoint || '',
      apiVersion: raw?.api_version || '',
    }

    if (provider === 'deepseek' || provider === 'openai') {
      const baseUrl = cfg.baseUrl || (provider === 'deepseek' ? 'https://api.deepseek.com/v1' : 'https://api.openai.com/v1')
      const testModel = provider === 'deepseek' ? 'deepseek-flash' : 'glm-5.3'
      const resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: testModel, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 }),
      })
      if (resp.ok) result = { success: true, model: testModel, message: '连接成功，API Key 有效' }
      else {
        const errBody = await resp.text().catch(() => '')
        let errMsg = `HTTP ${resp.status}`
        try { const j = JSON.parse(errBody); if (j.error?.message) errMsg = j.error.message; else if (j.message) errMsg = j.message } catch {}
        result = { success: false, model: testModel, message: '连接失败', details: errMsg }
      }
    } else if (provider === 'anthropic') {
      const testModel = 'claude-3-haiku-20240307'
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: testModel, max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
      })
      if (resp.ok) {
        result = { success: true, model: testModel, message: '连接成功，API Key 有效' }
      } else {
        const errBody = await resp.text().catch(() => '')
        let errMsg = `HTTP ${resp.status}`
        try {
          const errJson = JSON.parse(errBody)
          if (errJson.error?.message) errMsg = errJson.error.message
        } catch {}
        result = { success: false, model: testModel, message: '连接失败', details: errMsg }
      }
    } else if (provider === 'azure') {
      // Azure: use a simple test with the configured endpoint
      if (!cfg.endpoint) {
        return res.status(400).json({ error: 'Azure 需要配置 Endpoint' })
      }
      const endpoint = cfg.endpoint.replace(/\/+$/, '')
      const apiVersion = cfg.apiVersion || '2024-12-01-preview'

      // Azure needs a deployment — just try listing models or a simple call
      const resp = await fetch(`${endpoint}/openai/models?api-version=${apiVersion}`, {
        headers: {
          'api-key': cfg.apiKey,
        },
      })

      if (resp.ok) {
        result = { success: true, model: 'azure', message: '连接成功，Azure API Key 有效' }
      } else {
        const errBody = await resp.text().catch(() => '')
        let errMsg = `HTTP ${resp.status}`
        try {
          const errJson = JSON.parse(errBody)
          if (errJson.error?.message) errMsg = errJson.error.message
        } catch {}
        result = { success: false, model: 'azure', message: '连接失败', details: errMsg }
      }
    } else {
      return res.status(400).json({ error: '不支持的提供商' })
    }

    res.json(result)
  } catch (err: any) {
    res.status(500).json({ error: '测试请求失败', details: err.message || String(err) })
  }
})

app.put('/api/settings/api-keys', requireAuth, async (req: any, res) => {
  try {
    const body = req.body as ApiKeyConfig
    const userId = req.user?.id || null

    for (const provider of ['openai', 'deepseek', 'azure', 'anthropic', 'qwen', 'minimax'] as const) {
      if (body[provider]) {
        const incoming = body[provider]!
        const raw = await dbApiKeys.getRaw(provider, userId)
        const existingKey = raw?.api_key || ''
        const newKey = incoming.apiKey && !incoming.apiKey.includes('****') ? incoming.apiKey : existingKey
        await dbApiKeys.save(provider, {
          api_key: newKey || existingKey,
          base_url: incoming.baseUrl ?? (raw?.base_url || ''),
          endpoint: incoming.endpoint ?? (raw?.endpoint || ''),
          api_version: incoming.apiVersion ?? (raw?.api_version || ''),
        }, userId)
      }
    }

    res.json({ status: 'saved', keys: await dbApiKeys.getAll(userId) })
  } catch (error) {
    res.status(500).json({ error: 'Failed to save settings' })
  }
})

app.delete('/api/settings/api-keys/:provider', requireAuth, async (req: any, res) => {
  try {
    const userId = req.user?.id || null
    await dbApiKeys.delete(req.params.provider, userId)
    res.json({ status: 'deleted', keys: await dbApiKeys.getAll(userId) })
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete API key' })
  }
})

const socketTokens = new WeakMap<WebSocket, string>()
wss.on('connection', socket => {
  let expires: ReturnType<typeof setTimeout> | undefined
  let authenticating = false
  const deadline = setTimeout(() => socket.close(1008, '需要登录'), 5000)
  socket.on('message', async data => {
    if (socketTokens.has(socket) || authenticating) return socket.close(1008, '无效的认证消息')
    authenticating = true
    try {
      const message = JSON.parse(data.toString())
      if (message.type !== 'auth' || typeof message.token !== 'string') throw new AuthError('需要登录')
      await authenticateToken(message.token)
      const payload = verifyToken(message.token)
      if (socket.readyState !== WebSocket.OPEN) return
      clearTimeout(deadline)
      socketTokens.set(socket, message.token)
      expires = setTimeout(() => socket.close(1008, '登录已过期'), Math.min(2147483647, Math.max(0, payload.exp! * 1000 - Date.now())))
      socket.send(JSON.stringify({ type: 'authenticated' }))
    } catch { socket.close(1008, '登录已过期或无效') }
  })
  socket.on('close', () => {
    clearTimeout(deadline)
    if (expires) clearTimeout(expires)
    socketTokens.delete(socket)
  })
})

function publishRun(runId: string, message: object): void {
  void (async () => {
    const run = await dbTrainingRuns.getById(runId)
    if (!run) return
    await Promise.all([...wss.clients].map(async socket => {
      const token = socketTokens.get(socket)
      if (!token || socket.readyState !== WebSocket.OPEN) return
      try {
        const user = await authenticateToken(token)
        if (canAccessRun(user, run) && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
      } catch (error) {
        if (error instanceof AuthError) socket.close(1008, '登录已过期或无效')
      }
    }))
  })().catch(error => console.error(`[publish:${runId}]`, error.message))
}

const training = createTrainingService({
  projectRoot: PROJECT_ROOT, outputsRoot: OUTPUTS_DIR, uploadsRoot: uploadsDir,
  publish: publishRun, sync: syncRunToDb, summarize: generateAISummary,
  modelEnv: resolveModelEnv, childEnv: buildChildEnv,
})

async function ensureRunDeletable(id: string): Promise<void> {
  const run = await dbTrainingRuns.getById(id)
  const state = training.lifecycle.get(id) ?? readState(run?.state_json)
  if (!run || training.lifecycle.isActive(id) || !isTerminal(state?.status ?? run.status)) {
    throw Object.assign(new Error('任务仍在运行或进程身份不明，不能删除'), { status: 409 })
  }
  await training.lifecycle.waitForClose(id)
}

function runResponse(run: any) {
  const state = training.lifecycle.get(run.id) ?? readState(run.state_json)
  return {
    id: run.id, name: run.name, path: '', state,
    status: state?.status ?? run.status, errorMessage: state?.error ?? run.error_message,
    currentScore: state ? state.currentScore === null ? null : state.currentScore * 100 : run.current_score,
    bestScore: state ? state.bestScore === null ? null : state.bestScore * 100 : run.best_score,
    initialScore: run.initial_score, baselineTestScore: run.baseline_test_score ?? 0, testScore: run.test_score ?? 0,
    acceptRate: run.accept_rate, totalSteps: state?.completedSteps ?? run.total_steps, accepts: run.accepts,
    slowUpdates: run.slow_updates ?? 0, rejects: run.rejects, skips: run.skips,
    model: run.model, env: run.env, epochs: run.epochs, batchSize: run.batch_size,
    editBudget: run.edit_budget, lrScheduler: run.lr_scheduler, slowUpdate: run.slow_update === 1,
    aiSummary: run.ai_summary || '', totalTime: run.total_time, avgPerStep: run.avg_per_step,
    createdAt: run.created_at, updatedAt: state?.updatedAt ?? run.updated_at,
    artifactSync: state?.artifactSync ?? run.artifact_sync_status,
    artifactError: state?.artifactError ?? run.artifact_sync_error,
  }
}

app.use('/api/runs', requireAuth)
app.use('/api/runs/:id', async (req: any, res, next) => {
  try {
    const id = validateRunId(req.params.id)
    const run = await dbTrainingRuns.getById(id)
    if (!canAccessRun(req.user, run)) return res.status(404).json({ error: '任务不存在或无权访问' })
    req.run = run
    next()
  } catch (error) {
    if (error instanceof PathError) res.status(404).json({ error: '任务不存在或无权访问' })
    else next(error)
  }
})
app.param('step', (req, res, next, value) => {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return res.status(400).json({ error: '无效步骤' })
  next()
})
app.param('version', (req, res, next, value) => {
  if (!/^(?:\d+|initial|best|final)$/.test(value)) return res.status(400).json({ error: '无效版本' })
  next()
})

async function runFile(req: any, ...parts: string[]): Promise<string> {
  const root = await resolveRunPath(OUTPUTS_DIR, req.run.id)
  return assertPathWithin(root, join(root, ...parts), { allowMissing: true })
}

app.get('/api/runs', async (req: any, res) => {
  try {
    const userId = req.user?.id || null
    const isAdmin = req.user?.is_admin === 1
    const dbRuns = isAdmin
      ? await dbTrainingRuns.getAll() as any[]
      : await dbTrainingRuns.getByUserId(userId) as any[]
    res.json(dbRuns.map(runResponse))
  } catch (error) {
    console.error('Error fetching runs:', error)
    res.status(500).json({ error: 'Failed to fetch runs' })
  }
})

app.get('/api/runs/:id', async (req: any, res) => {
  try {
    res.json(runResponse(req.run))
  } catch (error) {
    res.status(404).json({ error: 'Run not found' })
  }
})

app.get('/api/runs/:id/history', async (req, res) => {
  try {
    const dbHistory = await dbStepHistory.getByRunId(req.params.id) as any[]
    res.json(dbHistory.map((h: any) => {
      const action = (h.action === 'accept' || h.action === 'accepted' || h.action === 'accept_new_best' || h.action === 'force_accept') ? 'accept'
        : (h.action === 'reject' || h.action === 'rejected') ? 'reject' : 'skip'
      const isSlowUpdate = action === 'accept' && h.selection_hard === 1.0 && h.rollout_hard < 1.0
      return {
        step: h.step, epoch: h.epoch, step_in_epoch: h.step_in_epoch,
        action, rawAction: h.raw_action || h.action, isSlowUpdate,
        current_score: h.current_score, best_score: h.best_score,
        rollout_hard: h.rollout_hard, rollout_soft: h.rollout_soft,
        selection_hard: h.selection_hard, selection_soft: h.selection_soft,
        n_patches: h.n_patches, n_success_patches: h.n_success_patches,
        wall_time_s: h.wall_time_s, skill_len: h.skill_len,
        tokens: typeof h.tokens_json === 'string' ? JSON.parse(h.tokens_json) : (h.tokens_json || {}),
        timing: typeof h.timing_json === 'string' ? JSON.parse(h.timing_json) : (h.timing_json || {}),
      }
    }))
  } catch (error: any) {
    console.error('[History] Error:', error.message)
    res.status(404).json({ error: 'History not found' })
  }
})

app.get('/api/runs/:id/chart', async (req, res) => {
  try {
    const dbHistory = await dbStepHistory.getByRunId(req.params.id) as any[]
    if (dbHistory.length > 0) {
      let prevSelection = 0
      let prevRollout = 0
      const chartData = dbHistory.map((h: any, index: number) => {
        const action = (h.action === 'accept' || h.action === 'accepted' || h.action === 'accept_new_best') ? 'accept'
          : (h.action === 'reject' || h.action === 'rejected') ? 'reject' : 'skip'
        const rawSelection = h.selection_hard
        const rawRollout = h.rollout_hard
        const selection = (action !== 'skip' && rawSelection != null)
          ? Math.round(rawSelection * 100) : prevSelection
        const rollout = (action !== 'skip' && rawRollout != null)
          ? Math.round(rawRollout * 100) : prevRollout
        prevSelection = selection
        prevRollout = rollout
        return {
          step: index + 1, selection, rollout,
          bestScore: Math.round((h.best_score ?? h.current_score ?? 0) * 100),
          action, nPatches: h.n_patches ?? 0, nSuccessPatches: h.n_success_patches ?? 0,
        }
      })
      return res.json(chartData)
    }
    // Fallback: try file system
    const historyPath = await runFile(req, 'history.json')
    if (!existsSync(historyPath)) return res.json([])
    const history = JSON.parse(await readFile(historyPath, 'utf-8'))
    let prevSelection = 0
    let prevRollout = 0
    res.json(history.map((h: any, index: number) => {
      const action = (h.action === 'accept' || h.action === 'accepted' || h.action === 'accept_new_best') ? 'accept'
        : (h.action === 'reject' || h.action === 'rejected') ? 'reject' : 'skip'
      const rawSelection = h.selection_hard ?? h.selection_score ?? h.score
      const rawRollout = h.rollout_hard ?? h.rollout_score
      const selection = (action !== 'skip' && rawSelection != null) ? Math.round(rawSelection * 100) : prevSelection
      const rollout = (action !== 'skip' && rawRollout != null) ? Math.round(rawRollout * 100) : prevRollout
      prevSelection = selection; prevRollout = rollout
      return { step: index + 1, selection, rollout, bestScore: Math.round((h.best_score ?? h.current_score ?? 0) * 100), action, nPatches: h.n_patches ?? 0, nSuccessPatches: h.n_success_patches ?? 0 }
    }))
  } catch (error) {
    res.json([])
  }
})

app.get('/api/runs/:id/skills', async (req, res) => {
  try {
    const dbSkills = await dbSkillVersions.getByRunId(req.params.id) as any[]
    res.json(dbSkills.map((s: any) => ({
      version: s.version, name: s.name, path: s.path,
      chars: s.chars, timestamp: s.timestamp,
    })))
  } catch (error) {
    res.status(404).json({ error: 'Skills not found' })
  }
})

app.get('/api/runs/:id/skills/:version', async (req, res) => {
  try {
    const dbSkill = await dbSkillVersions.getByRunAndVersion(req.params.id, req.params.version) as any
    if (dbSkill?.content) return res.send(dbSkill.content)
    res.status(404).json({ error: 'Skill not found' })
  } catch (error) {
    res.status(404).json({ error: 'Skill not found' })
  }
})

// 获取某个步骤的候选 skill（变更后的内容）
app.get('/api/runs/:id/steps/:step/candidate-skill', async (req, res) => {
  try {
    const stepNum = parseInt(req.params.step, 10)
    // Try DB first: candidate_skill column in step_history
    const dbHistory = await dbStepHistory.getByRunId(req.params.id) as any[]
    const dbStep = dbHistory.find((h: any) => h.step === stepNum)
    if (dbStep?.candidate_skill) return res.send(dbStep.candidate_skill)

    // Fallback: try filesystem
    const padded = String(stepNum).padStart(4, '0')
    const candPath = await runFile(req, `steps/step_${padded}/candidate_skill.md`)
    if (!existsSync(candPath)) return res.status(404).send('')
    res.send(await readFile(candPath, 'utf-8'))
  } catch (error) {
    res.status(404).send('')
  }
})

// 获取步骤完整记录
app.get('/api/runs/:id/steps/:step/record', async (req, res) => {
  try {
    const stepNum = parseInt(req.params.step, 10)
    const recordPath = await runFile(req, `steps/step_${String(stepNum).padStart(4, '0')}`, 'step_record.json')

    if (!existsSync(recordPath)) {
      return res.status(404).json({ error: 'Step record not found' })
    }
    const record = JSON.parse(await readFile(recordPath, 'utf-8'))
    res.json(record)
  } catch (error) {
    res.status(500).json({ error: 'Failed to read step record' })
  }
})

// 获取 rollout 评估结果（逐条 QA）
app.get('/api/runs/:id/steps/:step/rollout-results', async (req, res) => {
  try {
    const stepNum = parseInt(req.params.step, 10)
    const resultsPath = await runFile(req, `steps/step_${String(stepNum).padStart(4, '0')}`, 'rollout', 'results.jsonl')
    if (!existsSync(resultsPath)) {
      return res.json([])
    }
    const content = await readFile(resultsPath, 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    const results = lines.map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
    res.json(results)
  } catch (error) {
    res.json([])
  }
})

// 获取 selection 评估结果（逐条 QA）
app.get('/api/runs/:id/steps/:step/selection-results', async (req, res) => {
  try {
    const stepNum = parseInt(req.params.step, 10)
    const resultsPath = await runFile(req, `steps/step_${String(stepNum).padStart(4, '0')}`, 'selection_eval', 'results.jsonl')
    if (!existsSync(resultsPath)) {
      return res.json([])
    }
    const content = await readFile(resultsPath, 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    const results = lines.map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
    res.json(results)
  } catch (error) {
    res.json([])
  }
})

// 获取步骤的合并 patch 详情
app.get('/api/runs/:id/steps/:step/patches', async (req, res) => {
  try {
    const stepNum = parseInt(req.params.step, 10)
    const patchesPath = await runFile(req, `steps/step_${String(stepNum).padStart(4, '0')}`, 'merged_patch.json')
    if (!existsSync(patchesPath)) {
      return res.status(404).json({ error: 'Patches not found' })
    }
    const patches = JSON.parse(await readFile(patchesPath, 'utf-8'))
    res.json(patches)
  } catch (error) {
    res.status(500).json({ error: 'Failed to read patches' })
  }
})

app.get('/api/runs/:id/data', async (req, res) => {
  try {
    res.json(await dbTrainingData.getByRunId(req.params.id))
  } catch (error) {
    res.status(404).json({ error: 'Data not found' })
  }
})

app.get('/api/runs/:id/config', async (req: any, res) => {
  try {
    const config = req.run.train_config_json ?? req.run.config_json
    res.json(typeof config === 'string' ? JSON.parse(config) : config ?? {})
  } catch (error) {
    res.status(404).json({ error: 'Config not found' })
  }
})

app.get('/api/runs/:id/logs', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 500
    const logs = await dbTrainingLogs.getByRunId(req.params.id, limit)
    if (logs.length === 0) console.log(`[Logs] No logs for run: ${req.params.id} (length=${req.params.id.length})`)
    res.json(logs)
  } catch (error: any) {
    console.error('[Logs] Error:', error.message)
    res.json([])
  }
})

app.post('/api/runs/:id/generate-summary', authMiddleware, async (req: any, res) => {
  try {
    const stream = req.query.stream === '1'
    const ctx = await buildAISummaryPrompt(req.params.id)
    if (!ctx) return res.status(400).json({ error: 'No API key or run not found' })

    if (!stream) {
      await generateAISummary(req.params.id)
      const dbRun = await dbTrainingRuns.getById(req.params.id) as any
      return res.json({ summary: dbRun?.ai_summary || '' })
    }

    // SSE streaming mode
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    const baseUrl = ctx.baseUrl || (ctx.model.startsWith('deepseek') ? 'https://api.deepseek.com/v1' : 'https://api.openai.com/v1')
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ctx.apiKey}` },
      body: JSON.stringify({
        model: ctx.model.startsWith('deepseek') ? 'deepseek-flash' : 'glm-5.3',
        messages: [{ role: 'user', content: ctx.prompt }],
        max_tokens: 400, temperature: 0.7, frequency_penalty: 0.3, stream: true,
      }),
    })

    if (!resp.ok || !resp.body) {
      res.write(`data: ${JSON.stringify({ error: 'API request failed' })}\n\n`)
      return res.end()
    }

    let fullText = ''
    const reader = (resp.body as any).getReader()
    const decoder = new TextDecoder()

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        const lines = chunk.split('\n').filter((l: string) => l.startsWith('data: '))
        for (const line of lines) {
          const data = line.slice(6).trim()
          if (data === '[DONE]') continue
          try {
            const parsed = JSON.parse(data)
            const delta = parsed?.choices?.[0]?.delta?.content || ''
            if (delta) {
              fullText += delta
              res.write(`data: ${JSON.stringify({ text: delta })}\n\n`)
            }
          } catch {}
        }
      }
    } finally { reader.releaseLock() }

    // Save final result
    if (fullText) {
      await dbTrainingRuns.saveSummary(req.params.id, fullText, readState(req.run.state_json)?.instanceId ?? null)
    }
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`)
    res.end()
  } catch (e: any) {
    console.error('generate-summary error:', e.message)
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to generate summary' })
    } else {
      res.write(`data: ${JSON.stringify({ error: 'Failed to generate summary' })}\n\n`)
      res.end()
    }
  }
})

app.post('/api/runs/:id/chat', authMiddleware, async (req: any, res) => {
  try {
    const { question } = req.body || {}
    if (!question) return res.status(400).json({ error: 'Missing question' })

    // Guard: reject irrelevant / infringing questions
    const blockedPatterns = [
      '破解', '绕过', '免杀', '木马', '病毒', '漏洞攻击', 'sql注入', 'xss', 'ddos',
      '刷票', '刷单', '水军', '盗版', '翻墙', 'vpn', '色情', '赌博', '毒品',
      'hack', 'crack', 'exploit', 'malware', 'ransomware', 'phishing',
      '生成.*身份证', '生成.*手机号', '伪造', '假文凭', '假证',
      '股票.*推荐', '投资.*建议', '彩票.*预测',
      '政治', '敏感', '分裂', '颠覆',
    ]
    for (const p of blockedPatterns) {
      if (new RegExp(p, 'i').test(question)) {
        return res.status(403).json({
          error: '该问题涉及受限内容，无法回答。',
          allowedTopics: [
            '训练步骤分析（为什么某步被接受/拒绝？）',
            'Skill 文档优化建议',
            '训练数据质量分析',
            '模型参数解释（Epoch/Batch/Gate等）',
            '分数变化原因分析',
            '最优版本 Skill 内容解读',
          ],
        })
      }
    }

    const ctx = await buildAISummaryPrompt(req.params.id)
    if (!ctx) return res.status(400).json({ error: 'Run not found or no API key' })

    const systemPrompt = '你是一个 AI 训练分析专家，主要回答与 Skill 训练优化相关的问题。你可以访问以下训练数据。\n\n规则：\n- 你能做什么/你是谁等关于你自身的介绍性问题：简要介绍自己并引导用户询问训练相关问题\n- 与训练分析相关的问题：结合训练数据详细回答\n- 无关的请求（代写代码/文章/论文、法律咨询、闲聊等）：回复「此问题超出训练分析范围，您可以询问训练步骤分析、Skill优化建议、分数变化原因等」\n\n=== 训练数据 ===\n' + ctx.prompt + '\n\n请只回答训练相关的问题。简明扼要，Markdown格式，200字以内。'

    const baseUrl = ctx.model.startsWith('deepseek') ? 'https://api.deepseek.com/v1' : 'https://api.openai.com/v1'
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ctx.apiKey}` },
      body: JSON.stringify({
        model: ctx.model.startsWith('deepseek') ? 'deepseek-flash' : 'glm-5.3',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: question },
        ],
        max_tokens: 500, temperature: 0.5, stream: true,
      }),
    })

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    if (!resp.ok || !resp.body) {
      res.write(`data: ${JSON.stringify({ error: 'API request failed' })}\n\n`)
      return res.end()
    }

    const reader = (resp.body as any).getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        const lines = chunk.split('\n').filter((l: string) => l.startsWith('data: '))
        for (const line of lines) {
          const data = line.slice(6).trim()
          if (data === '[DONE]') continue
          try {
            const parsed = JSON.parse(data)
            const delta = parsed?.choices?.[0]?.delta?.content || ''
            if (delta) res.write(`data: ${JSON.stringify({ text: delta })}\n\n`)
          } catch {}
        }
      }
    } finally { reader.releaseLock() }
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`)
    res.end()
  } catch (e: any) {
    console.error('chat error:', e.message)
    if (!res.headersSent) res.status(500).json({ error: 'Failed to process chat' })
    else { res.write(`data: ${JSON.stringify({ error: 'Failed to process chat' })}\n\n`); res.end() }
  }
})

app.get('/api/runs/:id/evaluations', async (req, res) => {
  try {
    const step = req.query.step ? parseInt(req.query.step as string) : undefined
    const phase = req.query.phase as string | undefined
    if (step !== undefined && !isNaN(step)) {
      const details = await dbEvalDetails.getByRunAndStep(req.params.id, step, phase)
      res.json(details)
    } else {
      const summary = await dbEvalDetails.getSummary(req.params.id)
      res.json(summary)
    }
  } catch (error) {
    res.json([])
  }
})

// ─── Training management ───
app.use('/api/train', training.router)

app.delete('/api/runs/:id', async (req: any, res) => {
  try {
    await training.lifecycle.exclusive(req.run.id, async () => {
      await ensureRunDeletable(req.run.id)
      const runDir = await resolveRunPath(OUTPUTS_DIR, req.run.id, true)
      if (existsSync(runDir)) await rm(runDir, { recursive: true, force: true })
      await dbStepHistory.deleteByRunId(req.run.id)
      await dbSkillVersions.deleteByRunId(req.run.id)
      await dbTrainingData.deleteByRunId(req.run.id)
      await dbTrainingLogs.deleteByRunId(req.run.id)
      await dbEvalDetails.deleteByRunId(req.run.id)
      await dbTrainingRuns.delete(req.run.id)
    })
    res.json({ status: 'deleted', message: 'Training run deleted successfully' })
  } catch (error: any) { res.status(error.status || 500).json({ error: error.message }) }
})

// ─── Chat (Playground) ───
app.post('/api/chat', requireAuth, async (req: any, res) => {
  try {
    const {
      model,
      skill,
      messages,
      temperature = 0.7,
      maxTokens = 2000,
    } = req.body as {
      model: string
      skill: string
      messages: Array<{ role: string; content: string }>
      temperature?: number
      maxTokens?: number
    }

    if (!model || !messages) {
      return res.status(400).json({ error: 'Missing model or messages' })
    }

    // Load API keys
    const keys = await loadApiKeys(req.user?.id || null)
    const isDeepSeek = model.startsWith('deepseek')
    const isOpenAI = !model.startsWith('deepseek') && !model.startsWith('claude')
    const isClaude = model.startsWith('claude')

    let apiKey = ''
    let baseUrl = ''

    if (isDeepSeek && keys.deepseek) {
      apiKey = keys.deepseek.apiKey
      baseUrl = keys.deepseek.baseUrl || 'https://api.deepseek.com/v1'
    } else if (isOpenAI && keys.openai) {
      apiKey = keys.openai.apiKey
      baseUrl = keys.openai.baseUrl || 'https://api.openai.com/v1'
    } else if (isClaude && keys.anthropic) {
      apiKey = keys.anthropic.apiKey
      // Claude uses anthropic SDK; for simplicity use messages API directly
      baseUrl = 'https://api.anthropic.com/v1'
    } else {
      return res.status(400).json({ error: 'API Key not configured for selected model' })
    }

    if (!apiKey) {
      return res.status(400).json({ error: 'API Key not configured for selected model' })
    }

    // Build final messages: prepend skill as system message with emphasis
    const skillLen = skill ? skill.length : 0
    console.log(`[Chat] skill=${skillLen}chars, model=${model}, messages=${messages.length}`)
    const finalMessages = skill
      ? [
          { role: 'system' as const, content: `You MUST strictly follow the rules below. These rules override any default behavior:\n\n${skill}` },
          ...messages.filter(m => m.role !== 'system'),
        ]
      : messages

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    // Call model API (streaming)
    const apiUrl = `${baseUrl.replace(/\/+$/, '')}/chat/completions`
    const abortController = new AbortController()

    req.on('close', () => abortController.abort())

    const modelResp = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: finalMessages,
        temperature,
        max_tokens: maxTokens,
        stream: true,
      }),
      signal: abortController.signal,
    })

    if (!modelResp.ok) {
      const errText = await modelResp.text()
      res.write(`data: ${JSON.stringify({ type: 'error', message: `Model API error: ${modelResp.status} ${errText}` })}\n\n`)
      res.end()
      return
    }

    if (!modelResp.body) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'No response body from model API' })}\n\n`)
      res.end()
      return
    }

    // Stream the response (Node 18+ fetch returns ReadableStream)
    const decoder = new TextDecoder()
    let buffer = ''

    // Helper: process one SSE line
    const processLine = (line: string) => {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith('data:')) return
      const data = trimmed.slice(5).trim()
      if (data === '[DONE]') {
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`)
        return 'done'
      }
      try {
        const parsed = JSON.parse(data)
        const content = parsed.choices?.[0]?.delta?.content
        const reasoning = parsed.choices?.[0]?.delta?.reasoning_content
        if (reasoning) {
          res.write(`data: ${JSON.stringify({ type: 'reasoning', content: reasoning })}\n\n`)
        }
        if (content) {
          res.write(`data: ${JSON.stringify({ type: 'chunk', content })}\n\n`)
        }
      } catch {
        // Ignore malformed SSE chunks
      }
      return null
    }

    try {
      const reader = (modelResp.body as any).getReader()
      let done = false
      while (!done) {
        const { value, done: readerDone } = await reader.read()
        done = readerDone
        if (value) {
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''
          for (const line of lines) {
            const result = processLine(line)
            if (result === 'done') {
              res.end()
              return
            }
          }
        }
      }
      // Stream ended normally
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`)
      res.end()
    } catch (streamErr: any) {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: streamErr.message || 'Stream error' })}\n\n`)
        res.end()
      }
    }

  } catch (error: any) {
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || 'Internal server error' })
    }
  }
})

// ─── Skill Management APIs (DB-backed) ───
// Save skill to DB
app.put('/api/skills/:skillId', authMiddleware, async (req: any, res) => {
  try {
    const { skillId } = req.params
    const { skillName, skillContent, description } = req.body as {
      skillName: string
      skillContent: string
      description?: string
    }
    if (!skillName || !skillContent) {
      return res.status(400).json({ error: 'Missing skill name or content' })
    }
    await dbUserSkills.upsert(skillId, { name: skillName, content: skillContent, description: description || '' })
    res.json({ success: true, message: 'Skill saved successfully', skillId })
  } catch (error) {
    console.error('Error saving skill:', error)
    res.status(500).json({ error: 'Failed to save skill' })
  }
})

// Test skill with test cases
app.post('/api/skills/test', authMiddleware, async (req: any, res) => {
  try {
    const { skillContent, testCases, model } = req.body as {
      skillContent: string
      testCases: Array<{ question: string; expectedAnswers: string[] }>
      model?: string
    }

    if (!skillContent || !testCases || testCases.length === 0) {
      return res.status(400).json({ error: 'Missing skill content or test cases' })
    }

    const targetModel = model || 'deepseek-flash'
    const keys = await loadApiKeys(req.user?.id || null)
    const isDeepSeek = targetModel.startsWith('deepseek')
    const isOpenAI = !targetModel.startsWith('deepseek') && !targetModel.startsWith('claude')

    let apiKey = ''
    let baseUrl = ''

    if (isDeepSeek && keys.deepseek) {
      apiKey = keys.deepseek.apiKey
      baseUrl = keys.deepseek.baseUrl || 'https://api.deepseek.com/v1'
    } else if (isOpenAI && keys.openai) {
      apiKey = keys.openai.apiKey
      baseUrl = keys.openai.baseUrl || 'https://api.openai.com/v1'
    } else {
      return res.status(400).json({ error: 'API Key not configured for selected model' })
    }

    if (!apiKey) {
      return res.status(400).json({ error: 'API Key not configured' })
    }

    const results: Array<{
      question: string
      predictedAnswer: string
      expectedAnswers: string[]
      match: boolean
      em: number
      f1: number
    }> = []

    for (const testCase of testCases) {
      const finalMessages = [
        { role: 'system' as const, content: `You MUST strictly follow the rules below. These rules override any default behavior:\n\n${skillContent}` },
        { role: 'user' as const, content: testCase.question },
      ]

      const apiUrl = `${baseUrl.replace(/\/+$/, '')}/chat/completions`
      const apiResp = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: targetModel,
          messages: finalMessages,
          temperature: 0,
          max_tokens: 500,
        }),
      })

      let predictedAnswer = ''
      if (apiResp.ok) {
        const apiJson = await apiResp.json()
        predictedAnswer = apiJson.choices?.[0]?.message?.content?.trim() || ''
      } else {
        predictedAnswer = `API Error: ${apiResp.status}`
      }

      const lowerPredicted = predictedAnswer.toLowerCase()
      const match = testCase.expectedAnswers.some(ans => 
        lowerPredicted.includes(ans.toLowerCase()) || 
        ans.toLowerCase().includes(lowerPredicted)
      )

      const em = match ? 1 : 0
      const f1 = match ? 1 : 0

      results.push({
        question: testCase.question,
        predictedAnswer,
        expectedAnswers: testCase.expectedAnswers,
        match,
        em,
        f1,
      })
    }

    const overallAccuracy = results.filter(r => r.match).length / results.length

    res.json({
      success: true,
      results,
      overallAccuracy: Math.round(overallAccuracy * 100),
      message: `测试完成，准确率: ${Math.round(overallAccuracy * 100)}%`,
    })
  } catch (error) {
    console.error('Error testing skill:', error)
    res.status(500).json({ error: 'Failed to test skill', details: (error as any).message })
  }
})

// ─── Templates API (DB-backed) ───
app.get('/api/templates', optionalAuth, async (req: any, res) => {
  try {
    const userId = req.user?.id || null
    const rows = await dbTemplates.getAll(userId) as any[]
    res.json(rows.map((r: any) => ({
      id: r.id, name: r.name, description: r.description,
      icon: r.icon, category: r.category, difficulty: r.difficulty,
      skillContent: r.skill_content,
      trainQa: JSON.parse(r.train_qa_json || '[]'),
      valQa: JSON.parse(r.val_qa_json || '[]'),
      splitRatio: r.split_ratio, config: JSON.parse(r.config_json || '{}'),
      expectedMetrics: JSON.parse(r.expected_metrics_json || '{}'),
      highlights: JSON.parse(r.highlights_json || '[]'),
      userId: r.user_id,
      isOwner: r.user_id === userId,
    })))
  } catch (e) { res.status(500).json({ error: 'Failed to fetch templates' }) }
})

app.post('/api/templates', authMiddleware, async (req: any, res) => {
  try {
    const { id, name, description, icon, category, difficulty, skillContent, trainQa, valQa, splitRatio, config, expectedMetrics, highlights } = req.body
    if (!id || !name) return res.status(400).json({ error: 'Missing id or name' })
    const userId = req.user?.id
    await dbTemplates.upsert(id, {
      name, description: description || '', icon: icon || '', category: category || '', difficulty: difficulty || 'medium',
      skill_content: skillContent || '',
      train_qa_json: JSON.stringify(trainQa || []), val_qa_json: JSON.stringify(valQa || []),
      split_ratio: splitRatio ?? 0.8, config_json: JSON.stringify(config || {}),
      expected_metrics_json: JSON.stringify(expectedMetrics || {}), highlights_json: JSON.stringify(highlights || []),
      user_id: userId,
    })
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: 'Failed to save template' }) }
})

app.delete('/api/templates/:id', authMiddleware, async (req: any, res) => {
  try {
    const t = await dbTemplates.getById(req.params.id) as any
    if (!t) return res.status(404).json({ error: 'Template not found' })
    // Guests can't delete built-in templates
    if (!t.user_id) return res.status(403).json({ error: '不能删除内置案例' })
    // Must be owner
    if (t.user_id !== req.user?.id) return res.status(403).json({ error: '无权删除此案例' })
    await dbTemplates.delete(req.params.id)
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: 'Failed to delete template' }) }
})

// ─── Admin API ─────────────────────────────────────────────────────────
registerAdminRoutes(app, {
  withRunsLocked: async (ids, operation) => {
    const runIds = [...new Set(ids)].sort()
    const lock = async (index: number): Promise<void> => {
      if (index === runIds.length) { await operation(); return }
      await training.lifecycle.exclusive(runIds[index], async () => {
        await ensureRunDeletable(runIds[index])
        await lock(index + 1)
      })
    }
    await lock(0)
  },
})

app.use((error: any, _req: any, res: any, _next: any) => {
  if (!res.headersSent) res.status(error.status || 500).json({ error: error.status ? error.message : '请求处理失败' })
})

async function syncCompletedRuns(): Promise<void> {
  const runs = await dbTrainingRuns.getAll() as any[]
  for (const run of runs) {
    const state = readState(run.state_json)
    if ((state?.status ?? run.status) !== 'completed' || (state?.artifactSync ?? run.artifact_sync_status) === 'synced') continue
    try {
      await training.lifecycle.exclusive(run.id, async () => {
        await syncRunToDb(run.id)
        if (state) await dbTrainingRuns.updateState(run.id, { ...state, version: state.version + 1, artifactSync: 'synced', artifactError: undefined, updatedAt: new Date().toISOString() })
      })
    } catch (error: any) {
      if (state) await dbTrainingRuns.updateState(run.id, { ...state, version: state.version + 1, artifactSync: 'failed', artifactError: error.message, updatedAt: new Date().toISOString() }).catch(() => {})
      else await dbTrainingRuns.upsert({ id: run.id, artifact_sync_status: 'failed', artifact_sync_error: error.message }).catch(() => {})
      console.error('[Startup sync]', run.id, error.message)
    }
  }
}

async function startServer(): Promise<void> {
  await mkdir(OUTPUTS_DIR, { recursive: true })
  await mkdir(uploadsDir, { recursive: true })
  const port = Number(process.env.PORT || 3002)
  server.listen(port, '127.0.0.1', () => {
    console.log('Server listening on localhost:' + port)
    if (process.env.SKILLOPT_DISABLE_STARTUP_SYNC !== '1') void syncCompletedRuns().catch(error => console.error('[Startup sync]', error.message))
  })
}

if (process.env.SKILLOPT_DISABLE_LISTEN !== '1') void startServer().catch(error => { console.error(error); process.exitCode = 1 })

export { app, server, wss, training, runResponse, publishRun, syncRunToDb, ensureRunDeletable }

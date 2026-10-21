import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { registerAdminRoutes } from './admin-api.js'
import { readdir, readFile, writeFile, mkdir, rm } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { join, basename, dirname } from 'path'
import { fileURLToPath } from 'url'
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
import { existsSync, readdirSync, statSync } from 'fs'
import { WebSocketServer, WebSocket } from 'ws'
import { createServer } from 'http'
import { spawn, ChildProcess, execSync } from 'child_process'
import multer from 'multer'
import { apiKeys as dbApiKeys, trainingRuns as dbTrainingRuns, stepHistory as dbStepHistory, skillVersions as dbSkillVersions, trainingData as dbTrainingData, userSkills as dbUserSkills, templates as dbTemplates, users as dbUsers, trainingLogs as dbTrainingLogs, evaluationDetails as dbEvalDetails } from './db.js'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { sendVerificationCode } from './sms.js'

const app = express()
const server = createServer(app)
const wss = new WebSocketServer({ server })

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

// ─── File upload setup ───
// Anchor to web/ via __dirname (web/server/src → web) so the location does not
// depend on the launch cwd; matches the web/uploads/.gitkeep and the Docker
// volume mounts (/app/web/uploads, /app/web/outputs).
const uploadsDir = join(__dirname, '..', '..', 'uploads')
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const dir = join(uploadsDir, req.body.trainingName || 'default')
    await mkdir(dir, { recursive: true })
    cb(null, dir)
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname)
  },
})
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } })

const OUTPUTS_DIR = join(__dirname, '..', '..', 'outputs')

// ─── Stage detection from training logs ──────────────────────────────────
function parseTrainingStage(line: string): string | null {
  const lower = line.toLowerCase()
  if (lower.includes('baseline') && lower.includes('evaluate')) return 'baseline'
  if (lower.includes('1/6') || lower.includes('rollout')) return 'rollout'
  if (lower.includes('2/6') || lower.includes('reflect')) return 'reflect'
  if (lower.includes('3/6') || (lower.includes('aggregate') || lower.includes('merge'))) return 'aggregate'
  if (lower.includes('4/6') || lower.includes('select')) return 'select'
  if (lower.includes('5/6') || lower.includes('update')) return 'update'
  if (lower.includes('6/6') || lower.includes('gate')) return 'gate'
  if (lower.includes('slow update')) return 'slow_update'
  if (lower.includes('meta skill')) return 'meta_skill'
  return null
}

// ─── Runtime info parsing from training logs ────────────────────────────
// Parses lines like "[config] epochs=2 steps/epoch=2 total_steps=4"
// and "[EPOCH 1/2]" and "[STEP 1/4]"
function parseTrainingRuntime(line: string): object | null {
  const lower = line.toLowerCase()
  // Parse config summary line
  const cfgMatch = lower.match(/\[config\]\s+epochs=(\d+).*?steps\/epoch=(\d+).*?total_steps=(\d+)/)
  if (cfgMatch) {
    return {
      kind: 'config',
      epochs: parseInt(cfgMatch[1]),
      stepsPerEpoch: parseInt(cfgMatch[2]),
      totalSteps: parseInt(cfgMatch[3]),
    }
  }
  // Parse epoch progress
  const epochMatch = line.match(/\[EPOCH\s+(\d+)\/(\d+)\]/i)
  if (epochMatch) {
    return {
      kind: 'epoch',
      current: parseInt(epochMatch[1]),
      total: parseInt(epochMatch[2]),
    }
  }
  // Parse step progress
  const stepMatch = line.match(/\[STEP\s+(\d+)\/(\d+)\]/i)
  if (stepMatch) {
    return {
      kind: 'step',
      current: parseInt(stepMatch[1]),
      total: parseInt(stepMatch[2]),
    }
  }
  return null
}
const DATA_DIR = join(process.cwd(), 'data')

// Ensure data dir exists
await mkdir(DATA_DIR, { recursive: true })

// ─── Import evaluation details (prompts + LLM responses) ────────────────
async function importEvalDetails(runPath: string, runId: string) {
  const evals: Array<{ dir: string; step: number; phase: string }> = []

  // Baseline selection eval
  evals.push({ dir: join(runPath, 'selection_eval_baseline'), step: 0, phase: 'baseline_selection' })
  // Baseline test eval
  evals.push({ dir: join(runPath, 'selection_eval_test_baseline'), step: 0, phase: 'baseline_test' })
  // Final test eval
  evals.push({ dir: join(runPath, 'selection_eval_test'), step: 0, phase: 'test' })

  // Step evaluations
  const stepsDir = join(runPath, 'steps')
  if (existsSync(stepsDir)) {
    const stepDirs = await readdir(stepsDir)
    for (const sd of stepDirs) {
      const stepMatch = sd.match(/step_(\d+)/)
      if (!stepMatch) continue
      const step = parseInt(stepMatch[1], 10)
      evals.push({ dir: join(stepsDir, sd, 'rollout'), step, phase: 'rollout' })
      evals.push({ dir: join(stepsDir, sd, 'selection_eval'), step, phase: 'selection' })
    }
  }

  // Delete old records for this run
  await dbEvalDetails.deleteByRunId(runId)

  for (const evalDir of evals) {
    const predsDir = join(evalDir.dir, 'predictions')
    if (!existsSync(predsDir)) continue
    const items = await readdir(predsDir)
    for (const itemId of items) {
      const itemDir = join(predsDir, itemId)
      try {
        const sysPrompt = await readFile(join(itemDir, 'target_system_prompt.txt'), 'utf-8').catch(() => '')
        const userPrompt = await readFile(join(itemDir, 'target_user_prompt.txt'), 'utf-8').catch(() => '')
        let conv: any = {}
        try { conv = JSON.parse(await readFile(join(itemDir, 'conversation.json'), 'utf-8')) } catch {}

        // Extract model response and eval info from conversation
        const messages = Array.isArray(conv) ? conv : []
        const modelMsgs = messages.filter((m: any) => m.type === 'message' || m.role === 'assistant')
        const modelResponse = modelMsgs.map((m: any) => m.content || '').join('\n---\n')
        
        // Extract evaluation result
        const evalMsg = messages.find((m: any) => m.role === 'system' && m.content?.includes('Exact Match:'))
        let isCorrect = 0, scoreEm = 0, scoreF1 = 0, extractedAnswer = ''
        if (evalMsg?.content) {
          const emMatch = evalMsg.content.match(/Exact Match:\s*(True|False|1|0)/i)
          if (emMatch) isCorrect = (emMatch[1] === 'True' || emMatch[1] === '1') ? 1 : 0
          const f1Match = evalMsg.content.match(/F1:\s*([\d.]+)/)
          if (f1Match) scoreF1 = parseFloat(f1Match[1])
          scoreEm = isCorrect
          const predMatch = evalMsg.content.match(/Predicted answer:\s*'([^']*)'/)
          if (predMatch) extractedAnswer = predMatch[1]
        }

        // Extract question/gold_answer from user prompt
        let question = '', goldAnswer = ''
        const qMatch = userPrompt.match(/## Question\n(.+?)(?:\n##|$)/s)
        if (qMatch) question = qMatch[1].trim().slice(0, 1000)
        const aMatch = userPrompt.match(/## Answer\n(.+?)(?:\n##|$)/s)
        if (aMatch) goldAnswer = aMatch[1].trim().slice(0, 500)

        await dbEvalDetails.upsert({
          run_id: runId, step: evalDir.step, phase: evalDir.phase, item_id: itemId,
          question, gold_answer: goldAnswer,
          system_prompt: sysPrompt.slice(0, 5000),
          user_prompt: userPrompt.slice(0, 3000),
          model_response: modelResponse.slice(0, 5000),
          extracted_answer: extractedAnswer,
          is_correct: isCorrect, score_em: scoreEm, score_f1: scoreF1,
          n_turns: modelMsgs.length || 1,
        })
      } catch {}
    }
  }
}

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
    const cur = Math.round(h.current_score || 0)
    const best = Math.round(h.best_score || 0)
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
    const eBest = Math.max(...es.map((h: any) => Math.round(h.best_score || 0)))
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

async function generateAISummary(runId: string) {
  try {
    const ctx = await buildAISummaryPrompt(runId)
    if (!ctx) return
    const { prompt, model, apiKey } = ctx

    const dbRun = await dbTrainingRuns.getById(runId) as any
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
      const p = await (await import('mysql2/promise')).default.createConnection({ host:'127.0.0.1', port:3306, user:'root', password: process.env.MYSQL_PASSWORD || 'hankun926', database:'skillopt' })
      await p.execute('UPDATE training_runs SET ai_summary = ? WHERE id = ?', [summary, runId])
      await p.end()
      console.log(`[AI] Summary generated for ${runId}`)
    }
  } catch (e: any) {
    console.error(`[AI] Summary failed for ${runId}:`, e.message)
  }
}

// ─── Sync run from files to DB ───
async function syncRunToDb(runId: string) {
  try {
    const runPath = join(OUTPUTS_DIR, runId)
    if (!existsSync(runPath)) return
    const run = await parseTrainingRun(runPath, runId)
    if (!run) return
    await dbTrainingRuns.upsert({
      id: run.id,
      name: run.name,
      env: '',
      model: run.model || '',
      status: run.status,
      error_message: run.errorMessage || '',
      current_score: run.currentScore,
      best_score: run.bestScore,
      initial_score: run.initialScore || 0,
      baseline_test_score: run.baselineTestScore || 0,
      test_score: run.testScore || 0,
      accept_rate: run.acceptRate,
      total_steps: run.totalSteps,
      accepts: run.accepts,
      slow_updates: run.slowUpdates || 0,
      rejects: run.rejects,
      skips: run.skips,
      total_time: run.totalTime || '',
      avg_per_step: run.avgPerStep || '',
      epochs: run.epochs || 0,
      batch_size: run.batchSize || 0,
      edit_budget: run.editBudget || 0,
      lr_scheduler: run.lrScheduler || '',
      slow_update: run.slowUpdate ? 1 : 0,
      config_json: JSON.stringify({}),
      summary_json: JSON.stringify({}),
      token_usage_json: JSON.stringify({}),
    })

    // Sync history
    const historyPath = join(OUTPUTS_DIR, runId, 'history.json')
    if (existsSync(historyPath)) {
      const history = JSON.parse(await readFile(historyPath, 'utf-8'))
      await dbStepHistory.deleteByRunId(runId)
      for (const [idx, h] of history.entries()) {
        const stepNum = h.step || idx + 1
        const padded = String(stepNum).padStart(4, '0')
        // Read candidate skill if available
        let candidateSkill = ''
        const candPath = join(OUTPUTS_DIR, runId, `steps/step_${padded}/candidate_skill.md`)
        if (existsSync(candPath)) {
          try { candidateSkill = await readFile(candPath, 'utf-8') } catch {}
        }
        await dbStepHistory.upsert(runId, stepNum, {
          epoch: h.epoch || 1,
          step_in_epoch: h.step_in_epoch || 0,
          action: h.action || h.raw_action || 'skip',
          raw_action: h.raw_action || '',
          current_score: h.current_score || 0,
          best_score: h.best_score || 0,
          rollout_hard: h.rollout_hard || 0,
          rollout_soft: h.rollout_soft || 0,
          selection_hard: h.selection_hard || 0,
          selection_soft: h.selection_soft || 0,
          n_patches: h.n_patches || 0,
          n_success_patches: h.n_success_patches || 0,
          wall_time_s: h.wall_time_s || 0,
          skill_len: h.skill_len || 0,
          tokens_json: JSON.stringify(h.tokens || {}),
          timing_json: JSON.stringify(h.timing || {}),
          candidate_skill: candidateSkill || '',
        })
      }
    }

    // Sync skill versions
    await dbSkillVersions.deleteByRunId(runId)
    const skillsDir = join(OUTPUTS_DIR, runId, 'skills')
    if (existsSync(skillsDir)) {
      const files = readdirSync(skillsDir).filter(f => f.endsWith('.md'))
      for (const f of files) {
        const verMatch = f.match(/skill_vv?(\d+)\.md/)
        if (!verMatch) continue
        const version = verMatch[1].padStart(4, '0')
        const content = await readFile(join(skillsDir, f), 'utf-8')
        await dbSkillVersions.upsert(runId, version, {
          name: f,
          path: `skills/${f}`,
          chars: content.length,
          content,
          timestamp: new Date().toISOString(),
        })
      }
    }
    // Best skill
    const bestPath = join(OUTPUTS_DIR, runId, 'best_skill.md')
    if (existsSync(bestPath)) {
      const content = await readFile(bestPath, 'utf-8')
      await dbSkillVersions.upsert(runId, 'best', {
        name: 'best_skill.md',
        path: 'best_skill.md',
        chars: content.length,
        content,
        timestamp: new Date().toISOString(),
      })
    }
    // Initial skill
    const initPaths = [
      join(OUTPUTS_DIR, runId, 'data', 'initial_skill.md'),
      join(OUTPUTS_DIR, runId, 'initial_skill.md'),
    ]
    for (const p of initPaths) {
      if (existsSync(p)) {
        const content = await readFile(p, 'utf-8')
        await dbSkillVersions.upsert(runId, 'initial', {
          name: 'initial_skill.md',
          path: 'data/initial_skill.md',
          chars: content.length,
          content,
          timestamp: new Date().toISOString(),
        })
        break
      }
    }
    // Sync training data
    const dataDir = join(OUTPUTS_DIR, runId, 'data')
    if (existsSync(dataDir)) {
      const files = readdirSync(dataDir)
      for (const file of files) {
        const match = file.match(/^(train|val|test)\.(?:jsonl|json)$/)
        if (!match) continue
        const split = match[1]
        try {
          const content = (await readFile(join(dataDir, file), 'utf-8')).trim()
          const items = content.split('\n').filter(Boolean).map(line => {
            try { return JSON.parse(line) } catch { return { question: line, answers: [] } }
          })
          await dbTrainingData.upsertBatch(runId, split, items)
        } catch {}
      }
    }
    // Import evaluation details (prompts + responses)
    await importEvalDetails(runPath, runId)
    // Auto-cleanup: only delete if training is truly done (not still running or stopped)
    let canClean = true
    try {
      const dbRun = await dbTrainingRuns.getById(runId) as any
      if (dbRun?.status === 'stopped') canClean = false
    } catch {}
    try {
      const rsPath = join(runPath, 'runtime_state.json')
      if (existsSync(rsPath)) {
        const rs = JSON.parse(await readFile(rsPath, 'utf-8'))
        if (rs.status === 'running') canClean = false
      }
    } catch {}
    if (canClean) {
      try { await rm(runPath, { recursive: true, force: true }) } catch {}
    }
  } catch (e: any) {
    console.error(`[syncRunToDb] Failed for ${runId}:`, e.message)
  }
}

// ─── API Key helpers (DB-backed) ───
interface ApiKeyConfig {
  openai?: { apiKey: string; baseUrl?: string }
  deepseek?: { apiKey: string; baseUrl?: string }
  azure?: { endpoint: string; apiKey: string; apiVersion?: string }
  anthropic?: { apiKey: string }
}

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
  const env = { ...process.env, PYTHONUNBUFFERED: '1', ...modelEnv }

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

interface TrainingRun {
  id: string
  name: string
  path: string
  status: 'completed' | 'training' | 'failed' | 'pending' | 'stopped' | 'empty'
  errorMessage?: string
  aiSummary?: string
  env?: string
  currentScore: number
  bestScore: number
  initialScore: number
  baselineTestScore: number
  testScore: number
  acceptRate: number
  totalSteps: number
  accepts: number
  slowUpdates: number
  rejects: number
  skips: number
  model: string
  epochs: number
  batchSize: number
  editBudget: number
  lrScheduler: string
  gateMetric: string
  slowUpdate: boolean
  totalTime: string
  avgPerStep: string
  createdAt: string
  updatedAt: string
}

async function parseTrainingRun(dirPath: string, dirName: string): Promise<TrainingRun | null> {
  try {
    const summaryPath = join(dirPath, 'summary.json')
    const configPath = join(dirPath, 'config.json')
    const historyPath = join(dirPath, 'history.json')

    if (!existsSync(summaryPath)) return null

    const summary = JSON.parse(await readFile(summaryPath, 'utf-8'))
    const config = existsSync(configPath) ? JSON.parse(await readFile(configPath, 'utf-8')) : {}
    const history = existsSync(historyPath) ? JSON.parse(await readFile(historyPath, 'utf-8')) : []

    // Normalize action: map train.py actions to frontend display values
    const normalizeAction = (raw: string): 'accept' | 'reject' | 'skip' => {
      if (raw === 'accept' || raw === 'accepted' || raw === 'accept_new_best' || raw === 'force_accept') return 'accept'
      if (raw === 'reject' || raw === 'rejected') return 'reject'
      return 'skip' // skip_no_patches, skip_no_improvement, etc.
    }

    const totalSteps = history.length
    const accepts = history.filter((h: any) => normalizeAction(h.action) === 'accept').length
    const slowUpdates = history.filter((h: any) => normalizeAction(h.action) === 'accept' && h.selection_hard === 1.0 && h.rollout_hard < 1.0).length
    const rejects = history.filter((h: any) => normalizeAction(h.action) === 'reject').length
    const skips = totalSteps - accepts - rejects

    // 尝试读取 runtime_state.json（记录了训练中断时的最新状态）
    let runtimeState: any = {}
    try {
      const rsPath = join(dirPath, 'runtime_state.json')
      if (existsSync(rsPath)) {
        runtimeState = JSON.parse(await readFile(rsPath, 'utf-8'))
      }
    } catch {}

    // runtimeState 保留用于其他场景（如 status 推断等）
    const _rtCurrentScore: number | undefined = runtimeState.current_score
    const _rtBestScore: number | undefined = runtimeState.best_score

    // Get initial score from first step's rollout, or runtime_state, or selection eval baseline
    let initialScore = 0
    if (history.length > 0) {
      const firstStep = history[0]
      const rolloutScore = firstStep.rollout_hard ?? firstStep.rollout_soft
      if (rolloutScore != null && rolloutScore > 0) {
        initialScore = Math.round(rolloutScore * 100)
      } else {
        // Fallback for edge cases
        initialScore = Math.round((firstStep.current_score || firstStep.score || 0) * 100)
      }
    }

    let status: TrainingRun['status'] = 'completed'
    let errorMessage: string | undefined

    // 提前判断是否有步骤数据（后续状态推断和分数计算都需要）
    const hasStepDirs = existsSync(join(dirPath, 'steps')) &&
      readdirSync(join(dirPath, 'steps')).some((f: string) =>
        statSync(join(dirPath, 'steps', f)).isDirectory()
      )
    const stepDirCount = hasStepDirs
      ? readdirSync(join(dirPath, 'steps')).filter((f: string) =>
          statSync(join(dirPath, 'steps', f)).isDirectory()
        ).length
      : 0

    // totalSteps > 0 means training ran to completion
    // status from summary if available, otherwise infer from history
    if (summary.status === 'training') {
      status = 'training'
    } else if (totalSteps === 0 && summary.status !== 'completed') {
      // 无 history 步骤记录，判断原因：
      //   - 有 step 目录但无 history → 训练中途被中断（incomplete）
      //   - 无任何数据 → 从未启动（empty）
      if (hasStepDirs) {
        // 进一步检查：step 目录数是否与 history 记录数匹配
        if (history.length > 0 && history.length < stepDirCount) {
          // 有历史记录但少于 step 目录 → 最后步骤被中断
          status = 'failed'
          // 尝试读取 crash_dump.json 获取具体错误原因
          let crashDetail = ''
          try {
            const stepDirs = readdirSync(join(dirPath, 'steps')).filter((f: string) =>
              statSync(join(dirPath, 'steps', f)).isDirectory()
            ).sort()
            const lastStepDir = stepDirs[stepDirs.length - 1]
            const crashPath = join(dirPath, 'steps', lastStepDir, 'crash_dump.json')
            if (existsSync(crashPath)) {
              const crashData = JSON.parse(await readFile(crashPath, 'utf-8'))
              crashDetail = `: ${crashData.error_type || 'Error'} - ${crashData.error || '未知错误'}`
            }
          } catch {}
          errorMessage = `训练在 Step ${history.length + 1} 被中断（共 ${stepDirCount} 个步骤目录，仅 ${history.length} 步完成记录）${crashDetail}`
        } else if (history.length === 0 && stepDirCount > 0) {
          // 有 step 目录但零历史记录 → trainer 崩溃，runtime_state 有最后状态
          const lastStep = runtimeState.last_completed_step || stepDirCount
          status = 'failed'
          // 尝试读取 crash_dump.json 获取具体错误原因
          let crashDetail = ''
          try {
            const stepDirs = readdirSync(join(dirPath, 'steps')).filter((f: string) =>
              statSync(join(dirPath, 'steps', f)).isDirectory()
            ).sort()
            for (const sd of stepDirs) {
              const crashPath = join(dirPath, 'steps', sd, 'crash_dump.json')
              if (existsSync(crashPath)) {
                const crashData = JSON.parse(await readFile(crashPath, 'utf-8'))
                crashDetail = `: ${crashData.error_type || 'Error'} - ${crashData.error || '未知错误'}`
                break
              }
            }
          } catch {}
          errorMessage = `训练在 Step ${lastStep} 后异常终止（${stepDirCount} 个步骤目录，但未生成 history 记录）${crashDetail}`
        } else {
          status = 'empty'  // 完全空壳
        }
      } else {
        status = 'empty'  // 从未启动
      }
    }

    // ── 额外检查：即使有 history 记录，也要确认最后一步是否完整 ──
    // 如果 step 目录数 > history 记录数，说明最后的步骤被中断了
    if (status === 'completed' && hasStepDirs) {
      if (stepDirCount > history.length) {
        status = 'failed'
        let crashDetail = ''
        try {
          const sdList = readdirSync(join(dirPath, 'steps')).filter((f: string) =>
            statSync(join(dirPath, 'steps', f)).isDirectory()
          ).sort()
          const crashPath = join(dirPath, 'steps', sdList[sdList.length - 1], 'crash_dump.json')
          if (existsSync(crashPath)) {
            const crashData = JSON.parse(await readFile(crashPath, 'utf-8'))
            crashDetail = `: ${crashData.error_type || 'Error'} - ${crashData.error || '未知错误'}`
          }
        } catch {}
        errorMessage = `训练在 Step ${history.length + 1} 被中断（共 ${stepDirCount} 个步骤目录，仅完成 ${history.length} 步）${crashDetail}`
      }
    }

    // Detect "no-op" trainings: all steps skipped with no patches and zero tokens
    // This means the model was never actually called (e.g. missing API key)
    if (status === 'completed' && totalSteps > 0) {
      const allSkipped = history.every((h: any) => {
        const raw = h.action
        return raw === 'skip_no_patches' || raw === 'skip' || raw === 'skip_no_improvement'
      })
      const zeroTokens = history.every((h: any) => {
        const t = h.tokens || {}
        const total = Object.values(t).reduce((sum: number, v: any) => sum + (v.total || v), 0)
        return total === 0
      })
      const zeroScore = (summary.best_selection_hard || 0) === 0 && (summary.best_score || 0) === 0

      if (allSkipped && zeroTokens && zeroScore) {
        status = 'failed'

        // Try to determine the root cause from rollout results
        try {
          const stepsDir = join(dirPath, 'steps')
          if (existsSync(stepsDir)) {
            const stepDirs = await readdir(stepsDir)
            for (const sd of stepDirs.slice(0, 1)) {
              const resultsPath = join(stepsDir, sd, 'rollout', 'results.jsonl')
              if (existsSync(resultsPath)) {
                const lines = (await readFile(resultsPath, 'utf-8')).trim().split('\n')
                for (const line of lines.slice(0, 1)) {
                  try {
                    const r = JSON.parse(line)
                    if (r.fail_reason) {
                      errorMessage = r.fail_reason
                    }
                  } catch {}
                }
              }
            }
          }
        } catch {}

        if (!errorMessage) {
          errorMessage = '训练未生成任何有效 patch，所有步骤均跳过。可能是模型 API key 未配置或模型调用失败。'
        }
      }
    }

    // Read training name from .training_name file (trainer overwrites config.json)
    let trainingName = config.trainingName || dirName
    const trainingNamePath = join(dirPath, '.training_name')
    try {
      if (existsSync(trainingNamePath)) {
        trainingName = (await readFile(trainingNamePath, 'utf-8')).trim() || trainingName
      }
    } catch {}

    // ── 从 history 提取 trainer 维护的分数（用于 fallback） ──
    let histBestScore: number | null = null
    let histCurrentScore: number | null = null
    if (history.length > 0) {
      const lastStep = history[history.length - 1]
      const histBest = lastStep.best_score ?? lastStep.best_selection_hard
      if (histBest != null) histBestScore = histBest
      const histCurr = lastStep.current_score ?? lastStep.current_selection_hard
      if (histCurr != null) histCurrentScore = histCurr
    }
    // runtime_state 兜底：trainer 崩溃时 history 可能缺失，但 runtime_state 记录最后状态
    const rtScore: number | null = runtimeState.best_score ?? runtimeState.current_score ?? null

    // ── Dashboard 分数计算（统一使用验证集指标） ──
    //
    // Dashboard 卡片展示的是"优化效果"，必须用同类数据对比才有意义：
    //   initialScore (初始验证集) → currentScore (最终验证集)
    //
    // 数据优先级（降级链）：
    //   初始(基线): baseline_selection_hard > history[0].selection > baseline_test_hard
    //   最终(优化): history.last.current_score > test_hard† > best_selection_hard† > runtime_state > baseline
    //   最佳(峰值): history.last.best_score > best_selection_hard† > runtime_state > final
    //   † = 需交叉验证可信（与 history/runtime_state 偏离 ≤20%）

    // 初始分数 = 基线验证集分数（优化前的 skill 在验证集上的表现）
    const correctInitialScore: number = (() => {
      // 1. 最准确：summary 记录的基线验证集分（>0 才是有效值，0 表示未记录）
      if (summary.baseline_selection_hard != null && summary.baseline_selection_hard > 0)
        return Math.round(summary.baseline_selection_hard * 100)
      // 2. fallback：history 第一步的 selection 就是基线验证集评估
      if (history.length > 0) {
        const firstSel = history[0].selection_hard ?? history[0].selection_score ?? history[0].score
        if (firstSel != null && firstSel > 0) return Math.round(firstSel * 100)
      }
      // 3. 最后 fallback：baseline 测试集分
      if (summary.baseline_test_hard != null && summary.baseline_test_hard > 0)
        return Math.round(summary.baseline_test_hard * 100)
      return 0
    })()

    // 优化后分数 = 最终验证集分数（history 权威，summary_runtime 辅助）
    const correctCurrentScore: number = (() => {
      // ── 交叉验证：summary 字段可能含脏数据，必须和 history/runtime 对比 ──
      const histMax = histBestScore ?? histCurrentScore ?? rtScore
      const isSummaryTrustworthy = (val: number | null) => {
        if (val == null || val <= 0) return false
        if (histMax != null && Math.abs(val - histMax) > 0.2) return false
        return true
      }

      // 1. history 当前分（最可靠：trainer 全程维护）
      if (histCurrentScore != null && histCurrentScore > 0)
        return Math.round(histCurrentScore * 100)

      // 2. runtime_state 记录（history 缺失时的兜底）
      if (histCurrentScore == null && rtScore != null && rtScore > 0)
        return Math.round(rtScore * 100)

      // 3. test_hard（最终测试），仅当可信时使用
      if (isSummaryTrustworthy(summary.test_hard))
        return Math.round(summary.test_hard! * 100)

      // 4. best_selection_hard，仅当可信时使用
      if (isSummaryTrustworthy(summary.best_selection_hard))
        return Math.round(summary.best_selection_hard! * 100)

      // 5. fallback: history best 或 initial
      if (histBestScore != null) return Math.round(histBestScore * 100)
      return correctInitialScore
    })()

    // 最佳分数 = 验证集历史最高（history 权威）
    const correctBestScore: number = (() => {
      // 1. history 维护的最佳分（最可靠）
      if (histBestScore != null && histBestScore > 0)
        return Math.round(histBestScore * 100)

      // 2. runtime_state 记录（history 缺失时的兜底）
      if (histBestScore == null && rtScore != null && rtScore > 0)
        return Math.round(rtScore * 100)

      // 3. summary best_selection_hard，需可信
      if (summary.best_selection_hard != null && summary.best_selection_hard > 0) {
        // 如果有 history/runtime 且差异太大则跳过
        const refScore = histBestScore ?? rtScore
        if (!refScore || Math.abs(summary.best_selection_hard - refScore) <= 0.2)
          return Math.round(summary.best_selection_hard * 100)
      }

      // 4. fallback
      return correctCurrentScore
    })()

    // ── 分数归零策略 ──
    // 只有在「从未产生任何训练数据」时才清零，即：
    //   无 step 目录 + 无 history + 无 runtime_state
    // 有 step 数据但 trainer 崩溃 → 保留 summary/runtime_state 中的分数
    let finalInitialScore = correctInitialScore
    let finalCurrentScore = correctCurrentScore
    let finalBestScore = correctBestScore
    const trulyEmpty = !hasStepDirs && totalSteps === 0 && rtScore == null
    if (trulyEmpty) {
      finalInitialScore = 0
      finalCurrentScore = 0
      finalBestScore = 0
    }

    return {
      id: dirName,
      name: trainingName,
      path: dirPath,
      status,
      errorMessage,
      currentScore: finalCurrentScore,
      bestScore: finalBestScore,
      initialScore: finalInitialScore,
      baselineTestScore: summary.baseline_test_hard != null ? Math.round(summary.baseline_test_hard * 100) : 0,
      testScore: summary.test_hard != null ? Math.round(summary.test_hard * 100) : 0,
      acceptRate: totalSteps > 0 ? Math.round((accepts / totalSteps) * 100) : 0,
      totalSteps,
      accepts,
      slowUpdates,
      rejects,
      skips,
      // config.json may be either nested (from web UI) or flat (from train.py output)
      model: config.model?.target || config.target_model || 'unknown',
      epochs: config.train?.num_epochs || config.num_epochs || 0,
      batchSize: config.train?.batch_size || config.batch_size || 0,
      editBudget: config.train?.edit_budget || config.edit_budget || 0,
      lrScheduler: config.train?.lr_scheduler || config.optimizer?.lr_scheduler || config.lr_scheduler || 'unknown',
      gateMetric: config.train?.gate_metric || config.gate_metric || 'soft',
      slowUpdate: config.train?.slow_update ?? true,
      totalTime: typeof summary.total_wall_time_s === 'number' ? `${summary.total_wall_time_s.toFixed(1)}s` : (summary.total_time || '0s'),
      avgPerStep: totalSteps > 0 ? `${(parseFloat(String(summary.total_wall_time_s || summary.total_time || 0)) / totalSteps).toFixed(1)}s` : '0s',
      createdAt: summary.config?.out_root ? new Date().toISOString() : (summary.start_time || new Date().toISOString()),
      updatedAt: summary.end_time || new Date().toISOString(),
    }
  } catch (error) {
    console.error(`Error parsing ${dirName}:`, error)
    return null
  }
}

// ─── Auth (Phone + Verification Code) ───
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'dev-secret')
const TOKEN_EXPIRY = process.env.TOKEN_EXPIRY || '24h'

const authMiddleware = (req: any, res: any, next: any) => {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: '未登录' })
  try { req.user = jwt.verify(header.slice(7), JWT_SECRET); next() }
  catch { res.status(401).json({ error: '登录已过期' }) }
}

// Soft auth: attaches user if token present, but doesn't block
const optionalAuth = (req: any, _res: any, next: any) => {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) {
    try { req.user = jwt.verify(header.slice(7), JWT_SECRET) } catch {}
  }
  next()
}

// Admin only middleware
const adminOnly = (req: any, res: any, next: any) => {
  if (!req.user?.is_admin) return res.status(403).json({ error: '需要管理员权限' })
  next()
}

// In-memory verification code store (phone → {code, expires})
const codeStore = new Map<string, { code: string; expires: number }>()
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of codeStore) { if (v.expires < now) codeStore.delete(k) }
}, 60000)

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
    const token = jwt.sign({ id: user.id, phone: user.phone, is_admin: user.is_admin || 0 }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY })
    res.json({ user: { id: user.id, phone: user.phone, is_admin: user.is_admin || 0 }, token })
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

    const token = jwt.sign({ id: user.id, phone: user.phone, is_admin: user.is_admin || 0 }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY })
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
app.get('/api/settings/api-keys', optionalAuth, async (req: any, res) => {
  try {
    const userId = req.user?.id || null
    res.json(await dbApiKeys.getAll(userId))
  } catch (error) {
    res.status(500).json({ error: 'Failed to load settings' })
  }
})

app.post('/api/settings/api-keys/test', optionalAuth, async (req: any, res) => {
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

app.put('/api/settings/api-keys', optionalAuth, async (req: any, res) => {
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

app.delete('/api/settings/api-keys/:provider', optionalAuth, async (req: any, res) => {
  try {
    const userId = req.user?.id || null
    await dbApiKeys.delete(req.params.provider, userId)
    res.json({ status: 'deleted', keys: await dbApiKeys.getAll(userId) })
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete API key' })
  }
})

app.get('/api/runs', optionalAuth, async (req: any, res) => {
  try {
    const userId = req.user?.id || null
    const isAdmin = req.user?.is_admin === 1
    // Admin sees all runs; regular users see only their own; guests see public runs
    const dbRuns = isAdmin
      ? await dbTrainingRuns.getAll() as any[]
      : await dbTrainingRuns.getByUserId(userId) as any[]
    res.json(dbRuns.map((r: any) => ({
      id: r.id, name: r.name, path: '',
      status: r.status, errorMessage: r.error_message,
      currentScore: r.current_score, bestScore: r.best_score,
      initialScore: r.initial_score, baselineTestScore: r.baseline_test_score || 0, testScore: r.test_score || 0,
      acceptRate: r.accept_rate,
      totalSteps: r.total_steps, accepts: r.accepts,
      slowUpdates: r.slow_updates || 0,
      rejects: r.rejects, skips: r.skips,
      model: r.model, epochs: r.epochs, batchSize: r.batch_size,
      editBudget: r.edit_budget, lrScheduler: r.lr_scheduler,
      slowUpdate: r.slow_update === 1,
      aiSummary: r.ai_summary || '',
      totalTime: r.total_time, avgPerStep: r.avg_per_step,
      createdAt: r.created_at, updatedAt: r.updated_at,
    })))
  } catch (error) {
    console.error('Error fetching runs:', error)
    res.status(500).json({ error: 'Failed to fetch runs' })
  }
})

app.get('/api/runs/:id', async (req: any, res) => {
  try {
    // Allow guest viewing of any run
    const dbRun = await dbTrainingRuns.getById(req.params.id) as any
    if (!dbRun) return res.status(404).json({ error: 'Run not found' })
    res.json({
      id: dbRun.id, name: dbRun.name, path: '',
      status: dbRun.status, errorMessage: dbRun.error_message,
      currentScore: dbRun.current_score, bestScore: dbRun.best_score,
      initialScore: dbRun.initial_score, baselineTestScore: dbRun.baseline_test_score || 0, testScore: dbRun.test_score || 0,
      acceptRate: dbRun.accept_rate,
      totalSteps: dbRun.total_steps, accepts: dbRun.accepts,
      slowUpdates: dbRun.slow_updates || 0,
      rejects: dbRun.rejects, skips: dbRun.skips,
      model: dbRun.model, epochs: dbRun.epochs, batchSize: dbRun.batch_size,
      editBudget: dbRun.edit_budget, lrScheduler: dbRun.lr_scheduler,
      slowUpdate: dbRun.slow_update === 1,
      aiSummary: dbRun.ai_summary || '',
      totalTime: dbRun.total_time, avgPerStep: dbRun.avg_per_step,
      createdAt: dbRun.created_at, updatedAt: dbRun.updated_at,
    })
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
    const historyPath = join(OUTPUTS_DIR, req.params.id, 'history.json')
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
    const candPath = join(OUTPUTS_DIR, req.params.id, `steps/step_${padded}/candidate_skill.md`)
    if (!existsSync(candPath)) return res.status(404).send('')
    res.send(await readFile(candPath, 'utf-8'))
  } catch (error) {
    res.status(404).send('')
  }
})

// Helper: resolve step directory path
function getStepDir(runId: string, stepNum: number): string {
  return join(OUTPUTS_DIR, runId, `steps/step_${String(stepNum).padStart(4, '0')}`)
}

// 获取步骤完整记录
app.get('/api/runs/:id/steps/:step/record', async (req, res) => {
  try {
    const stepNum = parseInt(req.params.step, 10)
    const recordPath = join(getStepDir(req.params.id, stepNum), 'step_record.json')

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
    const resultsPath = join(getStepDir(req.params.id, stepNum), 'rollout', 'results.jsonl')
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
    const resultsPath = join(getStepDir(req.params.id, stepNum), 'selection_eval', 'results.jsonl')
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
    const patchesPath = join(getStepDir(req.params.id, stepNum), 'merged_patch.json')
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

app.get('/api/runs/:id/config', async (req, res) => {
  try {
    const dbRun = await dbTrainingRuns.getById(req.params.id) as any
    if (dbRun?.config_json) {
      try { return res.json(JSON.parse(dbRun.config_json)) } catch {}
    }
    res.json({})
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
      const p = await (await import('mysql2/promise')).default.createConnection({ host:'127.0.0.1', port:3306, user:'root', password: process.env.MYSQL_PASSWORD || 'hankun926', database:'skillopt' })
      await p.execute('UPDATE training_runs SET ai_summary = ? WHERE id = ?', [fullText, req.params.id])
      await p.end()
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
const activeTrainings = new Map<string, ChildProcess>()

// ─── Log storage buffer ─────────────────────────────────────────────────
const logBuffers = new Map<string, Array<{ type: 'stdout' | 'stderr'; text: string }>>()
let logFlusher: ReturnType<typeof setInterval> | null = null

function bufferLog(runId: string, type: 'stdout' | 'stderr', text: string) {
  if (!logBuffers.has(runId)) logBuffers.set(runId, [])
  logBuffers.get(runId)!.push({ type, text })
  if (!logFlusher) {
    logFlusher = setInterval(flushLogBuffers, 3000)
  }
}

async function flushLogBuffers() {
  const entries = [...logBuffers.entries()]
  for (const [runId, lines] of entries) {
    if (lines.length === 0) continue
    try { await dbTrainingLogs.appendBatch(runId, lines.splice(0, lines.length)) } catch {}
  }
  for (const [runId, lines] of logBuffers) {
    if (lines.length === 0) logBuffers.delete(runId)
  }
  if (logBuffers.size === 0 && logFlusher) {
    clearInterval(logFlusher)
    logFlusher = null
  }
}

/**
 * Create a new training run — supports both file upload and manual modes
 */
async function handleStartTraining(
  res: any,
  params: {
    trainingName: string
    env: string
    model: string
    epochs: number
    batchSize: number
    editBudget: number
    lrScheduler: string
    gateMetric: string
    analystWorkers: number
    useSlowUpdate: boolean
    useMetaSkill: boolean
    dataMode: 'upload' | 'manual'
    uploadedFiles?: Record<string, string>
    skillContent?: string
    qaPairs?: Array<{ question: string; answer: string }>
    trainSplit?: number
    valSplit?: number
    userId?: number
  }
) {
  const projectRoot = process.cwd()
  const { trainingName, env, model, epochs, batchSize, editBudget, lrScheduler, gateMetric, analystWorkers, useSlowUpdate, useMetaSkill, dataMode, uploadedFiles, skillContent, qaPairs, trainSplit, valSplit, userId } = params

  const safeName = trainingName.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '_').slice(0, 50)
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_')
  const runId = `loopskill_${env}_${safeName}_${timestamp}`
  const runDir = join(OUTPUTS_DIR, runId)

  await mkdir(runDir, { recursive: true })
  await mkdir(join(runDir, 'skills'), { recursive: true })

  // Determine data directory
  let splitDir: string

  if (dataMode === 'upload' && uploadedFiles) {
    // Use uploaded files directory
    splitDir = join(uploadsDir, safeName)
    // Files are already saved by multer, ensure they exist
    if (!existsSync(splitDir)) {
      await mkdir(splitDir, { recursive: true })
    }
    // Convert flat uploaded .jsonl files into the train/val/test subdirectory
    // layout expected by skillopt datasets (split_mode: 'split_dir'), mirroring
    // the manual-mode output format {id, question, context, answers[]}.
    if (!existsSync(join(splitDir, 'train'))) {
      const readItems = async (p?: string): Promise<any[]> => {
        if (!p || !existsSync(p)) return []
        const lines = (await readFile(p, 'utf-8')).split('\n').map(l => l.trim()).filter(Boolean)
        return lines.map((l, i) => {
          const it = JSON.parse(l)
          return {
            id: it.id ?? `up_${String(i + 1).padStart(3, '0')}`,
            question: it.question ?? '',
            context: it.context ?? '',
            answers: [it.answer ?? it.answers?.[0] ?? ''],
          }
        })
      }
      let trainItems = await readItems(uploadedFiles.train)
      let valItems = await readItems(uploadedFiles.val)
      let testItems = await readItems(uploadedFiles.test)
      if (!trainItems.length) {
        return res.status(400).json({ error: '训练集为空或不可解析：需要每行一个 JSON，含 question/answer 字段' })
      }
      if (!valItems.length || !testItems.length) {
        if (trainItems.length >= 3) {
          if (!testItems.length) testItems = trainItems.splice(-Math.max(1, Math.floor(trainItems.length * 0.2)))
          if (!valItems.length) valItems = trainItems.splice(-Math.max(1, Math.floor(trainItems.length * 0.25)))
        } else {
          if (!valItems.length) valItems = [...trainItems]
          if (!testItems.length) testItems = [...trainItems]
        }
      }
      for (const [name, items] of [['train', trainItems], ['val', valItems], ['test', testItems]] as const) {
        await mkdir(join(splitDir, name), { recursive: true })
        await writeFile(join(splitDir, name, 'data.json'), JSON.stringify(items, null, 2), 'utf-8')
      }
    }
  } else if (dataMode === 'manual') {
    // Generate data files from manual input
    splitDir = join(runDir, 'data')
    await mkdir(splitDir, { recursive: true })

    // Generate initial_skill.md
    await writeFile(join(splitDir, 'initial_skill.md'), skillContent || '# My Skill\n\n## Rules\n...', 'utf-8')

    // Generate JSONL files from QA pairs
    const pairs = qaPairs || []
    const total = pairs.length

    if (total > 0) {
      const tSplit = (trainSplit || 60) / 100
      const vSplit = (valSplit || 20) / 100
      const trainCount = Math.max(1, Math.floor(total * tSplit))
      const valCount = Math.max(1, Math.floor(total * vSplit))

      // Shuffle pairs
      const shuffled = [...pairs].sort(() => Math.random() - 0.5)

      const trainData = shuffled.slice(0, trainCount)
      const valData = shuffled.slice(trainCount, trainCount + valCount)
      const testData = shuffled.slice(trainCount + valCount)

      // Convert QA pairs to dataset items with required fields: id, question, context, answers[]
      const toDatasetItems = (data: typeof pairs) =>
        data.map((p, i) => ({
          id: `qa_${String(i + 1).padStart(3, '0')}`,
          question: p.question,
          context: '',
          answers: [p.answer],
        }))

      // Create subdirectories and write .json files for each split
      const trainDir = join(splitDir, 'train')
      const valDir = join(splitDir, 'val')
      const testDir = join(splitDir, 'test')
      await mkdir(trainDir, { recursive: true })
      await mkdir(valDir, { recursive: true })
      await mkdir(testDir, { recursive: true })

      await writeFile(join(trainDir, 'data.json'), JSON.stringify(toDatasetItems(trainData), null, 2), 'utf-8')
      await writeFile(join(valDir, 'data.json'), JSON.stringify(toDatasetItems(valData), null, 2), 'utf-8')
      await writeFile(join(testDir, 'data.json'), JSON.stringify(toDatasetItems(testData), null, 2), 'utf-8')
    }
  } else {
    return res.status(400).json({ error: 'Invalid data mode or missing files' })
  }

  // Build config — inherit from base defaults, only override what's needed
  const baseDefaultPath = join(projectRoot, 'configs', '_base_', 'default.yaml')

  // Determine backend from model type to avoid Azure leaking in
  const isDeepSeek = model.startsWith('deepseek')
  const isOpenAI = !model.startsWith('deepseek') && !model.startsWith('claude')
  const isClaude = model.startsWith('claude')
  const backend = isDeepSeek ? 'openai_chat' : isOpenAI ? 'openai_chat' : isClaude ? 'anthropic_messages' : 'openai_chat'

  const config = {
    _base_: baseDefaultPath,
    trainingName,
    model: {
      backend,
      optimizer: model,
      target: model,
      optimizer_backend: backend,
      target_backend: backend,
    },
    train: {
      num_epochs: epochs,
      batch_size: batchSize,
      train_size: 0,  // 0 = auto-derive from dataset split
    },
    optimizer: {
      learning_rate: editBudget,
      lr_scheduler: lrScheduler,
      min_learning_rate: Math.max(1, Math.floor(editBudget / 2)),
      use_slow_update: useSlowUpdate ?? true,
      use_meta_skill: useMetaSkill ?? true,
    },
    gradient: {
      analyst_workers: analystWorkers ?? 16,
    },
    evaluation: {
      gate_metric: gateMetric || 'soft',
    },
    eval_test: true,
    env: {
      name: env,
      split_dir: splitDir,
      skill_init: join(splitDir, 'initial_skill.md'),
      split_mode: 'split_dir',
      workers: 4,
      training_name: trainingName,
    },
  }

  // Save as YAML for scripts/train.py
  const yamlModule = await import('yaml')
  const yaml = (yamlModule as any).default || yamlModule
  const configYaml = yaml.stringify(config)
  await writeFile(join(runDir, 'config.yaml'), configYaml, 'utf-8')
  // Also save JSON for the frontend to read
  await writeFile(join(runDir, 'config.json'), JSON.stringify(config, null, 2))
  // Store training name separately — the trainer overwrites config.json
  await writeFile(join(runDir, '.training_name'), trainingName, 'utf-8')

  const summary = {
    start_time: new Date().toISOString(),
    status: 'training',
  }
  await writeFile(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2))

  // Pre-flight: check that API key is configured for the selected model
  const modelEnv = await resolveModelEnv(model, userId)

  const keys = await loadApiKeys(userId)
  let keyMissing = false
  if (isDeepSeek && !keys.deepseek?.apiKey) keyMissing = true
  if (isOpenAI && !keys.openai?.apiKey) keyMissing = true
  if (isClaude && !keys.anthropic?.apiKey) keyMissing = true

  if (keyMissing) {
    return res.status(400).json({
      error: 'API Key 未配置',
      message: `模型 "${model}" 需要配置对应的 API Key。请先在「设置」页面中配置好 API Key 后再开始训练。`,
      model,
    })
  }

  // Validate API key by making a real test call
  try {
    const testKey = modelEnv.OPENAI_API_KEY || modelEnv.ANTHROPIC_API_KEY || ''
    const testBase = modelEnv.OPENAI_BASE_URL || 'https://api.openai.com/v1'
    if (testKey && testKey.length > 10 && !testKey.includes('****')) {
      const testRes = await fetch(`${testBase.replace(/\/+$/, '')}/models`, {
        headers: { Authorization: `Bearer ${testKey}` },
        signal: AbortSignal.timeout(8000),
      })
      if (!testRes.ok) {
        return res.status(400).json({
          error: 'API Key 无效',
          message: `API Key 验证失败 (HTTP ${testRes.status})。请前往「API Key 配置」检查 ${isDeepSeek ? 'DeepSeek' : isOpenAI ? 'OpenAI' : 'Claude'} 密钥是否正确。`,
          model,
        })
      }
    } else {
      return res.status(400).json({
        error: 'API Key 无效',
        message: 'API Key 格式不正确。请前往「API Key 配置」页面重新设置有效密钥。',
        model,
      })
    }
  } catch (err: any) {
    // Network timeout — warn but don't block (API might be slow on first call)
    console.warn('Pre-flight API key verification failed (network):', err.message)
  }

  const venvPython = join(projectRoot, 'venv', 'bin', 'python3')
  const pythonCmd = existsSync(venvPython) ? venvPython : (process.platform === 'win32' ? 'python' : 'python3')
  const trainScript = join(projectRoot, 'scripts', 'train.py')
  const trainingProcess = spawn(pythonCmd, [
    trainScript,
    '--config', join(runDir, 'config.yaml'),
    '--out_root', runDir,
  ], {
    cwd: projectRoot,
    stdio: 'pipe',
    env: buildChildEnv(modelEnv, model),
  })

  activeTrainings.set(runId, trainingProcess)
  let lastDbUpdate = 0

  trainingProcess.stdout?.on('data', (data) => {
    console.log(`[${runId}] ${data}`)
    const text = data.toString()
    bufferLog(runId, 'stdout', text)
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'log', runId, data: text }))
        // Push stage update if detected
        const stage = parseTrainingStage(text)
        if (stage) {
          client.send(JSON.stringify({ type: 'stage', runId, data: stage }))
        }
        // Push runtime info if detected
        const runtime = parseTrainingRuntime(text)
        if (runtime) {
          client.send(JSON.stringify({ type: 'runtime', runId, data: runtime }))
        }
      }
    })

    // Parse step completion and sync to DB for live progress
    const stepMatch = text.match(/\[STEP\s+(\d+)\s+done\].*?current=([\d.]+).*?best=([\d.]+)/)
    if (stepMatch) {
      const step = parseInt(stepMatch[1], 10)
      const cur = Math.round(parseFloat(stepMatch[2]) * 100)
      const best = Math.round(parseFloat(stepMatch[3]) * 100)
      const now = Date.now()
      if (now - lastDbUpdate > 5000) { // Throttle: max every 5s
        lastDbUpdate = now
        dbTrainingRuns.upsert({
          id: runId, name: trainingName, env, model, status: 'training',
          total_steps: step, current_score: cur, best_score: best,
        }).catch(() => {})
      }
      wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) {
          c.send(JSON.stringify({ type: 'progress', runId, data: { step, currentScore: cur, bestScore: best } }))
        }
      })
    }

    // Parse timing line and send as WS message
    const timingMatch = text.match(/timing:\s*(\S+.*)/)
    if (timingMatch) {
      const timingParts = timingMatch[1].split(/\s+/)
      const timing: Record<string, number> = {}
      timingParts.forEach((p: string) => {
        const m = p.match(/^(\w+)=([\d.]+)s$/)
        if (m) timing[m[1]] = parseFloat(m[2])
      })
      if (Object.keys(timing).length > 0) {
        wss.clients.forEach(c => {
          if (c.readyState === WebSocket.OPEN) {
            c.send(JSON.stringify({ type: 'timing', runId, data: timing }))
          }
        })
      }
    }
  })

  const stderrParts: string[] = []
  trainingProcess.stderr?.on('data', (data) => {
    const text = data.toString()
    bufferLog(runId, 'stderr', text)
    stderrParts.push(text)
    console.error(`[${runId}] ERROR: ${text}`)
  })

  trainingProcess.on('close', async (code) => {
    console.log(`[${runId}] Training finished with code ${code}`)
    activeTrainings.delete(runId)
    const fullError = stderrParts.join('')
    // Flush any remaining buffered logs (fire-and-forget)
    flushLogBuffers().catch(() => {})

    // Check if user manually stopped — don't overwrite 'stopped' with 'failed'
    let dbStatus = ''
    try {
      const existing = await dbTrainingRuns.getById(runId) as any
      if (existing) dbStatus = existing.status
    } catch {}

    if (dbStatus === 'stopped') {
      // User-initiated stop — persist elapsed time from runtime_state.json
      try {
        const runPath = join(OUTPUTS_DIR, runId)
        const rsPath = join(runPath, 'runtime_state.json')
        if (existsSync(rsPath)) {
          const rs = JSON.parse(await readFile(rsPath, 'utf-8'))
          const elapsed = rs.elapsed_wall_time_s || rs.total_wall_time_s || 0
          if (elapsed > 0) {
            const totalTime = `${elapsed.toFixed(1)}s`
            const totalSteps = (await dbStepHistory.getByRunId(runId) as any[]).length || 1
            const avgPerStep = `${(elapsed / totalSteps).toFixed(1)}s`
            dbTrainingRuns.upsert({ id: runId, status: 'stopped', total_time: totalTime, avg_per_step: avgPerStep }).catch(() => {})
          }
        }
      } catch {}
      wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) {
          c.send(JSON.stringify({ type: 'complete', runId, code: 0 }))
        }
      })
    } else if (code !== 0 && code !== null) {
      // Actual failure (non-zero exit code, not killed by signal)
      dbTrainingRuns.upsert({ 
        id: runId, name: trainingName, env, model, status: 'failed', 
        error_message: (fullError || `Process exited with code ${code}`).slice(0, 1000) 
      }).catch(() => {})
      wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) {
          c.send(JSON.stringify({ type: 'complete', runId, code, error: fullError || `Exited with code ${code}` }))
        }
      })
    } else {
      syncRunToDb(runId).then(() => generateAISummary(runId)).catch(e => console.error('[sync] failed:', e.message))
      wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) {
          c.send(JSON.stringify({ type: 'complete', runId, code }))
        }
      })
    }
  })

  // Insert pending training run into DB immediately
  await dbTrainingRuns.upsert({
    id: runId, name: trainingName, env, model,
    status: 'training',
    epochs, batch_size: batchSize, edit_budget: editBudget,
    lr_scheduler: lrScheduler, slow_update: useSlowUpdate ? 1 : 0,
    config_json: JSON.stringify({ env, model, epochs, batchSize, editBudget, lrScheduler, gateMetric, useSlowUpdate, useMetaSkill }),
    train_config_json: JSON.stringify(config),
    user_id: userId || null,
  })

  res.json({ runId, status: 'started', message: 'Training started successfully' })
}

// POST /api/train — JSON mode (manual data entry)
app.post('/api/train', optionalAuth, async (req: any, res, next) => {
  try {
    const body = req.body
    if (body.dataMode === 'manual') {
      return handleStartTraining(res, {
        trainingName: body.trainingName,
        env: body.env,
        model: body.model,
        epochs: body.epochs,
        batchSize: body.batchSize,
        editBudget: body.editBudget,
        lrScheduler: body.lrScheduler,
        gateMetric: body.gateMetric || 'soft',
        analystWorkers: body.analystWorkers ?? 16,
        useSlowUpdate: body.useSlowUpdate ?? true,
        useMetaSkill: body.useMetaSkill ?? true,
        dataMode: 'manual',
        skillContent: body.skillContent,
        qaPairs: body.qaPairs,
        trainSplit: body.trainSplit,
        valSplit: body.valSplit,
        userId: req.user?.id,
      })
    }
    // If JSON but not manual, pass through to multipart handler
    return next()
  } catch (error) {
    console.error('Error starting training:', error)
    res.status(500).json({ error: 'Failed to start training' })
  }
})

// POST /api/train — Multipart mode (file upload)
app.post('/api/train', optionalAuth, upload.fields([
  { name: 'trainFile', maxCount: 1 },
  { name: 'valFile', maxCount: 1 },
  { name: 'testFile', maxCount: 1 },
  { name: 'skillFile', maxCount: 1 },
]), async (req: any, res) => {
  try {
    const body = req.body as any
    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined

    if (body.dataMode !== 'upload') {
      // This was already handled by the JSON handler above
      return
    }

    // Map uploaded files to paths
    const uploadedFiles: Record<string, string> = {}
    if (files) {
      if (files.trainFile?.[0]) uploadedFiles.train = files.trainFile[0].path
      if (files.valFile?.[0]) uploadedFiles.val = files.valFile[0].path
      if (files.testFile?.[0]) uploadedFiles.test = files.testFile[0].path
      if (files.skillFile?.[0]) uploadedFiles.skill = files.skillFile[0].path
    }

    // For upload mode, also ensure initial_skill.md exists in the data dir
    if (uploadedFiles.skill) {
      const dir = join(uploadsDir, body.trainingName || 'default')
      const skillDest = join(dir, 'initial_skill.md')
      if (!existsSync(skillDest) && existsSync(uploadedFiles.skill)) {
        await writeFile(skillDest, await readFile(uploadedFiles.skill))
      }
    }

    return handleStartTraining(res, {
      trainingName: body.trainingName,
      env: body.env,
      model: body.model,
      epochs: parseInt(body.epochs),
      batchSize: parseInt(body.batchSize),
      editBudget: parseInt(body.editBudget),
      lrScheduler: body.lrScheduler,
      gateMetric: body.gateMetric || 'soft',
      analystWorkers: parseInt(body.analystWorkers) || 16,
      useSlowUpdate: body.useSlowUpdate !== 'false',
      useMetaSkill: body.useMetaSkill !== 'false',
      dataMode: 'upload',
      uploadedFiles,
      userId: req.user?.id,
    })
  } catch (error) {
    console.error('Error starting training (upload):', error)
    res.status(500).json({ error: 'Failed to start training' })
  }
})

app.post('/api/train/:id/stop', optionalAuth, async (req: any, res) => {
  try {
    const { id } = req.params
    console.log(`[STOP] Attempting to stop training: ${id}`)

    let killed = false

    // 1. Try in-memory process
    const existingProc = activeTrainings.get(id)
    if (existingProc) {
      console.log(`[STOP] Found process in memory, killing with SIGTERM`)
      try { existingProc.kill('SIGTERM') } catch {}
      activeTrainings.delete(id)
      killed = true
    }

    // 2. Try pgrep by run ID
    if (!killed) {
      try {
        const result = execSync(`pgrep -f "train.py.*${id}"`, { encoding: 'utf-8', timeout: 5000 })
        const pids = result.trim().split('\n').filter(Boolean)
        for (const pid of pids) {
          try { process.kill(parseInt(pid), 'SIGTERM'); killed = true } catch {}
        }
      } catch {}
    }

    // 3. Save checkpoint to DB (runtime state for resume)
    let runtimeState = ''
    try {
      const rsPath = join(OUTPUTS_DIR, id, 'runtime_state.json')
      if (existsSync(rsPath)) runtimeState = await readFile(rsPath, 'utf-8')
    } catch {}

    // 4. Update DB status
    const dbRun = await dbTrainingRuns.getById(id) as any
    if (dbRun) {
      await dbTrainingRuns.upsert({ ...dbRun, status: 'stopped', error_message: 'Training stopped by user', runtime_state: runtimeState })
    } else {
      await dbTrainingRuns.upsert({ id, name: id, status: 'stopped', error_message: 'Training stopped by user', runtime_state: runtimeState })
    }

    res.json({ status: 'stopped', message: 'Training stopped successfully' })
  } catch (error) {
    console.error('[STOP] Error:', error)
    res.status(500).json({ error: 'Failed to stop training' })
  }
})

app.post('/api/train/:id/restart', optionalAuth, async (req: any, res) => {
  try {
    const { id } = req.params
    console.log(`[RESTART] Attempting to restart training: ${id}`)

    const dbRun = await dbTrainingRuns.getById(id) as any
    if (!dbRun) return res.status(404).json({ error: 'Training run not found' })

    // 1. Stop existing process if any
    const existingProc = activeTrainings.get(id)
    if (existingProc) { try { existingProc.kill('SIGTERM') } catch {}; activeTrainings.delete(id) }
    try {
      const r = execSync(`pgrep -f "train.py.*${id}"`, { encoding: 'utf-8', timeout: 3000 })
      for (const pid of r.trim().split('\n').filter(Boolean)) {
        try { process.kill(parseInt(pid), 'SIGTERM') } catch {}
      }
    } catch {}

    // 2. Restore config files from DB
    const runDir = join(OUTPUTS_DIR, id)
    await mkdir(runDir, { recursive: true })
    let config: any = {}
    // Prefer the full nested train_config_json, fallback to flat config_json
    if (dbRun.train_config_json) {
      try { config = JSON.parse(dbRun.train_config_json) } catch {}
    }
    if (!config._base_ && dbRun.config_json) {
      // Reconstruct from flat params
      try {
        const flat = JSON.parse(dbRun.config_json)
        const backend = flat.model?.startsWith?.('deepseek') ? 'openai_chat' : 'openai_chat'
        const baseDefaultPath = join(projectRoot, 'configs', '_base_', 'default.yaml')
        const splitDir = join(runDir, 'data')
        config = {
          _base_: baseDefaultPath,
          trainingName: dbRun.name || flat.trainingName,
          model: { backend, optimizer: flat.model, target: flat.model, optimizer_backend: backend, target_backend: backend },
          train: { num_epochs: flat.epochs || 2, batch_size: flat.batchSize || 4, train_size: 0 },
          optimizer: {
            learning_rate: flat.editBudget || 3, lr_scheduler: flat.lrScheduler || 'cosine',
            min_learning_rate: Math.max(1, Math.floor((flat.editBudget || 3) / 2)),
            use_slow_update: flat.useSlowUpdate ?? true, use_meta_skill: flat.useMetaSkill ?? true,
          },
          gradient: { analyst_workers: 16 },
          evaluation: { gate_metric: flat.gateMetric || 'soft' },
          eval_test: true,
          env: { name: flat.env || 'searchqa', split_dir: splitDir, skill_init: join(splitDir, 'initial_skill.md'), split_mode: 'split_dir', workers: 4, training_name: dbRun.name },
        }
      } catch {}
    }
    config.out_root = runDir
    const { stringify: yamlStringify } = await import('yaml')
    const configYaml = yamlStringify(config)
    await writeFile(join(runDir, 'config.yaml'), configYaml, 'utf-8')
    await writeFile(join(runDir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8')

    // 2.5 Restore data files (train/val/test splits) from DB
    const splitDir = join(runDir, 'data')
    await mkdir(splitDir, { recursive: true })
    const dataBySplit = await dbTrainingData.getByRunId(id) as any
    const allDataKeys = Object.keys(dataBySplit || {})
    for (const split of allDataKeys) {
      const items = dataBySplit[split]
      if (!Array.isArray(items) || items.length === 0) continue
      const splitPath = join(splitDir, split)
      await mkdir(splitPath, { recursive: true })
      const formatted = items.map((item: any) => ({
        id: item.id || `qa_${String(Math.random()).slice(2, 8)}`,
        question: item.question || '',
        context: item.context || '',
        answers: Array.isArray(item.answers) ? item.answers : [],
      }))
      await writeFile(join(splitPath, 'data.json'), JSON.stringify(formatted, null, 2), 'utf-8')
    }
    // Restore initial_skill.md from skill_versions
    let initialSkillContent = ''
    const initialSkill = await dbSkillVersions.getByRunAndVersion(id, 'initial') as any
    if (initialSkill?.content) {
      initialSkillContent = initialSkill.content
    } else {
      const v0 = await dbSkillVersions.getByRunAndVersion(id, '0000') as any
      if (v0?.content) initialSkillContent = v0.content
    }
    if (initialSkillContent) {
      await writeFile(join(splitDir, 'initial_skill.md'), initialSkillContent, 'utf-8')
    }

    // 3. Restore checkpoint (runtime_state.json) for resume
    const hasCheckpoint = dbRun.runtime_state && typeof dbRun.runtime_state === 'string' && dbRun.runtime_state.trim()
    if (hasCheckpoint) {
      try {
        const rs = JSON.parse(dbRun.runtime_state)
        const lastStep = rs.last_completed_step || 0
        // Restore skills directory from DB skill_versions
        const skills = await dbSkillVersions.getByRunId(id) as any[]
        if (skills.length > 0) {
          await mkdir(join(runDir, 'skills'), { recursive: true })
          for (const sv of skills) {
            if (sv.content) {
              const ver = sv.version === 'best' ? '' : sv.version === 'initial' ? '0000' : sv.version
              const skillPath = join(runDir, 'skills', `skill_v${ver}.md`)
              await writeFile(skillPath, sv.content, 'utf-8')
            }
          }
        }
        // Write runtime_state.json for resume
        await writeFile(join(runDir, 'runtime_state.json'), dbRun.runtime_state, 'utf-8')
        console.log(`[RESTART] Restored checkpoint from step ${lastStep}`)
      } catch (e: any) {
        console.log(`[RESTART] Could not restore checkpoint: ${e.message}`)
      }
    }

    const model = dbRun.model || config.model || 'deepseek-flash'

    // 3. Check API key (use run owner's API keys)
    const runUserId = dbRun.user_id || null
    const keys = await loadApiKeys(runUserId)
    const isDeepSeek = model.startsWith('deepseek')
    const isOpenAI = !model.startsWith('deepseek') && !model.startsWith('claude')
    if ((isDeepSeek && !keys.deepseek?.apiKey) || (isOpenAI && !keys.openai?.apiKey)) {
      return res.status(400).json({ error: `模型 "${model}" 需要配置对应的 API Key` })
    }

    // 4. Update DB status
    await dbTrainingRuns.upsert({ ...dbRun, status: 'training', error_message: '' })

    // 5. Re-spawn
    const projectRoot = process.cwd()
    const venvPython = join(projectRoot, 'venv', 'bin', 'python3')
    const pythonCmd = existsSync(venvPython) ? venvPython : (process.platform === 'win32' ? 'python' : 'python3')
    const trainScript = join(projectRoot, 'scripts', 'train.py')
    if (!existsSync(trainScript)) return res.status(500).json({ error: `训练脚本不存在: ${trainScript}` })

    const modelEnv = await resolveModelEnv(model, runUserId)
    const trainingProcess = spawn(pythonCmd, [trainScript, '--config', join(runDir, 'config.yaml'), '--out_root', runDir], {
      cwd: projectRoot, stdio: 'pipe', env: buildChildEnv(modelEnv, model),
    })

    activeTrainings.set(id, trainingProcess)
    const restartStderr: string[] = []

    trainingProcess.stdout?.on('data', (data) => {
      const text = data.toString()
      bufferLog(id, 'stdout', text)
      wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'log', runId: id, data: text })) })
    })
    trainingProcess.stderr?.on('data', (data) => {
      const text = data.toString()
      bufferLog(id, 'stderr', text)
      restartStderr.push(text)
    })
    trainingProcess.on('close', async (code) => {
      activeTrainings.delete(id)
      await flushLogBuffers()
      const fullErr = restartStderr.join('')

      // Check if user manually stopped
      let dbStatus = ''
      try { const existing = await dbTrainingRuns.getById(id) as any; if (existing) dbStatus = existing.status } catch {}

      if (dbStatus === 'stopped') {
        // Persist elapsed time
        try {
          const runPath = join(OUTPUTS_DIR, id)
          const rsPath = join(runPath, 'runtime_state.json')
          if (existsSync(rsPath)) {
            const rs = JSON.parse(await readFile(rsPath, 'utf-8'))
            const elapsed = rs.elapsed_wall_time_s || rs.total_wall_time_s || 0
            if (elapsed > 0) {
              const totalSteps = (await dbStepHistory.getByRunId(id) as any[]).length || 1
              dbTrainingRuns.upsert({ id, status: 'stopped', total_time: `${elapsed.toFixed(1)}s`, avg_per_step: `${(elapsed / totalSteps).toFixed(1)}s` }).catch(() => {})
            }
          }
        } catch {}
      } else if (code !== 0 && code !== null) {
        dbTrainingRuns.upsert({ id, name: dbRun.name, env: dbRun.env || '', model: dbRun.model || '', status: 'failed', error_message: (fullErr || `Exited with code ${code}`).slice(0, 1000) }).catch(() => {})
      } else {
        syncRunToDb(id).catch(() => {})
      }
      wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'complete', runId: id, code, error: (dbStatus !== 'stopped' && code !== 0 && code !== null) ? (fullErr || `Exited with code ${code}`) : undefined })) })
    })
    trainingProcess.on('error', () => { activeTrainings.delete(id) })

    res.json({ status: 'started', runId: id, message: 'Training restarted successfully' })
  } catch (err: any) {
    console.error('[RESTART] Error:', err)
    res.status(500).json({ error: `Failed to restart training: ${err?.message || String(err)}` })
  }
})

app.delete('/api/runs/:id', authMiddleware, async (req: any, res) => {
  try {
    const { id } = req.params
    // Check ownership (admin can delete any)
    const isAdmin = req.user?.is_admin === 1
    const run = isAdmin
      ? await dbTrainingRuns.getById(id) as any
      : await dbTrainingRuns.getByIdAndUser(id, req.user?.id) as any
    if (!run) return res.status(404).json({ error: 'Run not found or no permission' })
    // Stop if running
    const existingProc = activeTrainings.get(id)
    if (existingProc) {
      try { existingProc.kill('SIGTERM') } catch {}
      activeTrainings.delete(id)
    }
    // Clean up files if they exist (may have been auto-deleted by syncRunToDb)
    const runDir = join(OUTPUTS_DIR, id)
    if (existsSync(runDir)) await rm(runDir, { recursive: true, force: true })
    // Delete from DB (cascades to history, skills, data)
    await dbTrainingRuns.delete(id)
    await dbStepHistory.deleteByRunId(id)
    await dbSkillVersions.deleteByRunId(id)
    await dbTrainingData.deleteByRunId(id)
    await dbTrainingLogs.deleteByRunId(id)
    await dbEvalDetails.deleteByRunId(id)
    res.json({ status: 'deleted', message: 'Training run deleted successfully' })
  } catch (error) {
    console.error('Error deleting run:', error)
    res.status(500).json({ error: 'Failed to delete training run' })
  }
})

// ─── Chat (Playground) ───
app.post('/api/chat', optionalAuth, async (req: any, res) => {
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
registerAdminRoutes(app)


const PORT = parseInt(process.env.PORT || '3002')
server.listen(PORT, async () => {
  // Startup: sync any orphaned outputs to DB (from previous server crash)
  if (existsSync(OUTPUTS_DIR)) {
    const dirs = await readdir(OUTPUTS_DIR)
    for (const dir of dirs) {
      const runPath = join(OUTPUTS_DIR, dir)
      try {
        // Check if training is still running (don't touch it)
        const rsPath = join(runPath, 'runtime_state.json')
        if (existsSync(rsPath)) {
          try {
            const rs = JSON.parse(await readFile(rsPath, 'utf-8'))
            if (rs.status === 'running') {
              // Still running — ensure DB shows training, skip sync
              await dbTrainingRuns.upsert({ id: dir, status: 'training' })
              console.log(`[Startup] Still running: ${dir}`)
              continue
            }
          } catch {}
        }

        // Check if already in DB with completed status
        const existing = await dbTrainingRuns.getById(dir) as any
        if (existing && existing.status === 'completed') continue

        // Sync completed/failed runs
        await syncRunToDb(dir)
        console.log(`[Startup] Synced: ${dir}`)
      } catch (e: any) { console.log(`[Startup] Skip ${dir}: ${e.message}`) }
    }
  }
  console.log(`Server running on http://localhost:${PORT}`)
  console.log(`WebSocket running on ws://localhost:${PORT}`)
  console.log(`Outputs directory: ${OUTPUTS_DIR}`)
  console.log(`Uploads directory: ${uploadsDir}`)
})

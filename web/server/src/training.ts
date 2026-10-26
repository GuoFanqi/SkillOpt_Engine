import { Router } from 'express'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import multer from 'multer'
import { parse, stringify } from 'yaml'
import { requireAuth, canAccessRun } from './auth.js'
import { assertPathWithin, resolveRunPath, validateRunId } from './safe-paths.js'
import { trainingRuns, trainingLogs } from './db.js'
import { RunLifecycle, RunConflict } from './run-lifecycle.js'
import { readState } from './run-state.js'
import type { RunState } from '../../shared/run-state'

interface TrainingOptions {
  projectRoot: string
  outputsRoot: string
  uploadsRoot: string
  publish: (id: string, message: object) => void
  sync: (id: string) => Promise<void>
  summarize: (id: string, instanceId?: string) => Promise<void>
  modelEnv: (model: string, userId: number) => Promise<Record<string, string>>
  childEnv: (env: Record<string, string>, model: string) => Record<string, string>
}

interface DatasetItem {
  id: string
  question: string
  context: string
  answers: string[]
  forbidden_terms?: string[]
}

function parseObject(value: unknown): Record<string, any> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('训练配置必须为对象')
  return parsed as Record<string, any>
}

function itemsFrom(value: unknown): DatasetItem[] {
  if (!Array.isArray(value)) throw new Error('训练数据必须为数组')
  const ids = new Set<string>()
  return value.map((raw, index) => {
    const row = parseObject(raw)
    const answers = row.answers ?? (row.answer === undefined ? undefined : [row.answer])
    if (typeof row.question !== 'string' || !row.question.trim() || !Array.isArray(answers) || !answers.length || !answers.every(a => typeof a === 'string')) {
      throw new Error('每条数据需要非空question与字符串answers数组')
    }
    if (row.forbidden_terms !== undefined && (!Array.isArray(row.forbidden_terms) || !row.forbidden_terms.every((term: unknown) => typeof term === 'string' && term.length > 0))) {
      throw new Error('forbidden_terms必须为非空字符串数组')
    }
    const id = row.id === undefined ? `qa_${index + 1}` : String(row.id)
    if (!id || ids.has(id) || !/^[\p{L}\p{N}_-]+$/u.test(id)) throw new Error('样本ID必须唯一且不能含路径字符')
    ids.add(id)
    return { id, question: row.question, context: typeof row.context === 'string' ? row.context : '', answers, ...(row.forbidden_terms ? { forbidden_terms: row.forbidden_terms } : {}) }
  })
}

async function readItems(buffer?: Buffer): Promise<DatasetItem[]> {
  if (!buffer) return []
  const text = buffer.toString('utf8').trim()
  if (!text) return []
  return itemsFrom(text.startsWith('[') ? JSON.parse(text) : text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)))
}

function positiveInt(value: unknown, fallback: number, name: string): number {
  const n = value === undefined || value === '' ? fallback : Number(value)
  if (!Number.isSafeInteger(n) || n < 1 || n > 10000) throw new Error(`${name}必须为1到10000的整数`)
  return n
}

function bool(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  throw new Error('布尔参数必须为true或false')
}

export function createTrainingService(options: TrainingOptions) {
  const logQueues = new Map<string, Promise<void>>()
  const logBuffers = new Map<string, Array<{ type: 'stdout' | 'stderr'; text: string }>>()
  const logTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const flushLogs = (id: string): Promise<void> => {
    clearTimeout(logTimers.get(id))
    logTimers.delete(id)
    const lines = logBuffers.get(id) ?? []
    logBuffers.delete(id)
    const previous = logQueues.get(id) ?? Promise.resolve()
    if (!lines.length) return previous
    for (const type of ['stdout', 'stderr'] as const) {
      const text = lines.filter(line => line.type === type).map(line => line.text).join('')
      if (text) options.publish(id, { type: type === 'stderr' ? 'error' : 'log', runId: id, data: text })
    }
    const next = previous.then(async () => {
      const path = await resolveRunPath(options.outputsRoot, id)
      await appendFile(join(path, 'process.log'), lines.map(line => `[${line.type}] ${line.text}`).join(''))
      await trainingLogs.appendBatch(id, lines)
    }).catch(error => console.error(`[logs:${id}]`, error.message))
    logQueues.set(id, next)
    void next.finally(() => { if (logQueues.get(id) === next) logQueues.delete(id) })
    return next
  }
  const lifecycle = new RunLifecycle({
    persist: (id, state) => trainingRuns.updateState(id, state),
    publish: (id, state) => options.publish(id, { type: 'state', runId: id, data: state }),
    log: (id, stream, text) => {
      const lines = logBuffers.get(id) ?? []
      lines.push({ type: stream, text })
      logBuffers.set(id, lines)
      if (lines.length >= 100) void flushLogs(id)
      else if (!logTimers.has(id)) {
        const timer = setTimeout(() => { void flushLogs(id) }, 200)
        timer.unref()
        logTimers.set(id, timer)
      }
    },
    completed: async id => {
      await flushLogs(id)
      await options.sync(id)
      const instanceId = lifecycle.get(id)?.instanceId
      void options.summarize(id, instanceId).then(async () => {
        if (instanceId) await lifecycle.setArtifactState(id, instanceId, 'synced')
      }).catch(error => console.error(`[summary:${id}]`, error.message))
    },
  })

  const router = Router()
  router.use(requireAuth)
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 4, fields: 40 } })
  const guard = async (req: any, res: any, next: any) => {
    try {
      const id = validateRunId(req.params.id)
      const run = await trainingRuns.getById(id)
      if (!canAccessRun(req.user, run)) return res.status(404).json({ error: '任务不存在或无权访问' })
      req.run = run
      next()
    } catch { res.status(404).json({ error: '任务不存在或无权访问' }) }
  }

  const startProcess = async (id: string, runDir: string, model: string, userId: number, previous: unknown, configFile = 'config.yaml') => {
    const env = await options.modelEnv(model, userId)
    const key = model.startsWith('claude') ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY
    if (!key) throw new Error(`请先配置模型 ${model} 的API Key`)
    const script = join(options.projectRoot, 'scripts', 'train.py')
    const python = join(options.projectRoot, '.venv', 'bin', process.platform === 'win32' ? 'python.exe' : 'python3')
    if (!existsSync(script) || !existsSync(python)) throw new Error('本地训练脚本或.venv解释器不存在')
    const state = await lifecycle.prepare(id, previous)
    const child = spawn(python, [script, '--config', join(runDir, configFile), '--out_root', runDir], {
      cwd: options.projectRoot, stdio: 'pipe',
      env: { ...options.childEnv(env, model), SKILLOPT_INSTANCE_ID: state.instanceId },
    })
    lifecycle.attach(id, state.instanceId, child, runDir)
  }

  router.post('/', upload.fields([
    { name: 'trainFile', maxCount: 1 }, { name: 'valFile', maxCount: 1 },
    { name: 'testFile', maxCount: 1 }, { name: 'skillFile', maxCount: 1 },
  ]), async (req: any, res) => {
    let runDir: string | undefined
    let createdId: string | undefined
    try {
      const body = parseObject(req.body)
      const userId = req.user.id as number
      if (typeof body.trainingName !== 'string' || !body.trainingName.trim() || body.trainingName.length > 100) throw new Error('请输入100字以内的训练名称')
      if (!['searchqa', 'officeqa', 'docvqa', 'livemathematicianbench', 'spreadsheetbench', 'alfworld'].includes(body.env)) throw new Error('不支持的训练环境')
      if (typeof body.model !== 'string' || !body.model.trim()) throw new Error('请选择模型')
      const files = req.files as Record<string, Array<{ buffer: Buffer }>> | undefined
      let train: DatasetItem[], val: DatasetItem[] = [], test: DatasetItem[] = [], skill: string
      if (body.dataMode === 'manual') {
        const pairs = itemsFrom(body.qaPairs)
        if (pairs.length < 3) throw new Error('至少需要3条样本建立独立训练、验证和测试集')
        const tr = Number(body.trainSplit ?? 0.6), vr = Number(body.valSplit ?? 0.2)
        if (!(tr > 0 && vr > 0 && tr + vr < 1)) throw new Error('训练与验证比例之和必须小于1，并为测试集留出样本')
        const trainCount = Math.min(pairs.length - 2, Math.max(1, Math.floor(pairs.length * tr)))
        const valCount = Math.min(pairs.length - trainCount - 1, Math.max(1, Math.floor(pairs.length * vr)))
        train = pairs.slice(0, trainCount)
        val = pairs.slice(trainCount, trainCount + valCount)
        test = pairs.slice(trainCount + valCount)
        skill = typeof body.skillContent === 'string' ? body.skillContent : ''
      } else if (body.dataMode === 'upload') {
        train = await readItems(files?.trainFile?.[0]?.buffer)
        val = await readItems(files?.valFile?.[0]?.buffer)
        test = await readItems(files?.testFile?.[0]?.buffer)
        const missing = Number(!val.length) + Number(!test.length)
        if (train.length < missing + 1) throw new Error('样本不足：请补齐独立训练、验证和测试集，不能复制训练集')
        if (!test.length) test = train.splice(-Math.max(1, Math.floor(train.length * 0.2)))
        if (!val.length) val = train.splice(-Math.max(1, Math.floor(train.length * 0.25)))
        skill = files?.skillFile?.[0]?.buffer.toString('utf8') ?? ''
      } else throw new Error('请选择手工或上传数据模式')
      if (!skill.trim()) throw new Error('初始Skill不能为空')
      const fingerprints = new Set<string>()
      for (const split of [train, val, test]) {
        for (const item of split) {
          const key = JSON.stringify([item.question.trim(), item.context, item.answers])
          if (fingerprints.has(key)) throw new Error('数据集存在重复样本，请去重并确保各集合独立')
          fingerprints.add(key)
        }
      }
      const epochs = positiveInt(body.epochs, 2, 'epochs')
      const batchSize = positiveInt(body.batchSize, 4, 'batchSize')
      const editBudget = positiveInt(body.editBudget, 3, 'editBudget')
      const workers = positiveInt(body.analystWorkers, 1, 'analystWorkers')
      const lr = body.lrScheduler ?? 'cosine'
      if (!['constant', 'linear', 'cosine', 'autonomous'].includes(lr)) throw new Error('不支持的学习率调度')
      const gateMetric = body.gateMetric ?? 'soft'
      if (!['hard', 'soft', 'mixed'].includes(gateMetric)) throw new Error('无效gateMetric')
      const id = `loopskill_${body.env}_${randomUUID()}`
      runDir = await resolveRunPath(options.outputsRoot, id, true)
      await mkdir(join(runDir, 'data'), { recursive: true })
      for (const [name, data] of [['train', train], ['val', val], ['test', test]] as const) {
        await mkdir(join(runDir, 'data', name))
        await writeFile(join(runDir, 'data', name, 'data.json'), JSON.stringify(data, null, 2))
      }
      await writeFile(join(runDir, 'data', 'initial_skill.md'), skill)
      const backend = body.model.startsWith('claude') ? 'claude_chat' : 'openai_chat'
      const config = {
        _base_: join(options.projectRoot, 'configs', '_base_', 'default.yaml'),
        model: { backend, optimizer: body.model, target: body.model, optimizer_backend: backend, target_backend: backend },
        train: { num_epochs: epochs, batch_size: batchSize, train_size: 0 },
        optimizer: {
          learning_rate: editBudget, min_learning_rate: Math.min(2, editBudget), lr_scheduler: lr,
          use_slow_update: bool(body.useSlowUpdate, true), use_meta_skill: bool(body.useMetaSkill, true),
          slow_update_gate_with_selection: bool(body.slowUpdateGate, false),
          use_skill_aware_reflection: bool(body.useSkillAwareReflection, false),
          skill_aware_appendix_source: body.skillAwareAppendixSource ?? 'both',
          skill_aware_consolidate_threshold: Number(body.skillAwareConsolidateThreshold ?? 0),
        },
        gradient: { analyst_workers: workers },
        evaluation: { gate_metric: gateMetric, eval_test: true },
        env: { name: body.env, split_dir: join(runDir, 'data'), skill_init: join(runDir, 'data', 'initial_skill.md'), split_mode: 'split_dir', workers: 1, training_name: body.trainingName, out_root: runDir },
      }
      await writeFile(join(runDir, 'config.yaml'), stringify(config))
      await writeFile(join(runDir, 'config.json'), JSON.stringify(config, null, 2))
      await writeFile(join(runDir, '.training_name'), body.trainingName)
      await trainingRuns.upsert({
        id, name: body.trainingName, env: body.env, model: body.model, user_id: userId, status: 'pending',
        epochs, batch_size: batchSize, edit_budget: editBudget, lr_scheduler: lr,
        slow_update: config.optimizer.use_slow_update ? 1 : 0,
        config_json: JSON.stringify(config), train_config_json: JSON.stringify(config),
      })
      createdId = id
      await startProcess(id, runDir, body.model, userId, null)
      res.json({ runId: id, status: 'started', message: '训练已启动' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (createdId) await trainingRuns.upsert({ id: createdId, status: 'failed', error_message: message }).catch(() => {})
      else if (runDir) await rm(runDir, { recursive: true, force: true })
      res.status(error instanceof RunConflict ? 409 : 400).json({ error: message })
    }
  })

  router.post('/:id/stop', guard, async (req: any, res) => {
    try {
      await lifecycle.exclusive(req.params.id, () => lifecycle.stop(req.params.id))
      res.json({ status: 'stopped' })
    } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }) }
  })

  router.post('/:id/restart', guard, async (req: any, res) => {
    try {
      await lifecycle.exclusive(req.params.id, async () => {
        const id = req.params.id
        const run = req.run
        if (lifecycle.isActive(id)) await lifecycle.stop(id)
        else if (['training', 'pending'].includes(run.status) && !lifecycle.get(id)) throw new RunConflict('无法确认旧训练进程身份，请先由管理员核实')
        await lifecycle.waitForClose(id)
        const runDir = await resolveRunPath(options.outputsRoot, id)
        const configPath = await assertPathWithin(runDir, join(runDir, 'config.yaml'))
        const config = parseObject(parse(await readFile(configPath, 'utf8')))
        if (!config.model || !config.env || !config.train) throw new Error('原始配置不完整，不能安全恢复')
        const dataRoot = resolve(config.env.split_dir ?? '')
        const skill = resolve(config.env.skill_init ?? '')
        for (const path of [dataRoot, skill]) {
          try { await assertPathWithin(runDir, path) }
          catch { await assertPathWithin(options.uploadsRoot, path) }
        }
        for (const split of ['train', 'val', 'test']) {
          const path = join(dataRoot, split)
          if (!existsSync(join(path, 'data.json')) && !existsSync(join(path, 'items.json'))) throw new Error(`缺失${split}原始样本，不能从展示数据伪造恢复`)
        }
        if (existsSync(join(runDir, 'runtime_state.json'))) {
          const saved = parseObject(JSON.parse(await readFile(join(runDir, 'runtime_state.json'), 'utf8')))
          for (const key of ['current_skill_path', 'best_skill_path']) {
            if (saved[key]) await assertPathWithin(runDir, saved[key])
          }
        }
        const backend = config.model.target_backend
        if (!['openai_chat', 'claude_chat', 'qwen_chat', 'minimax_chat'].includes(backend)) throw new Error('配置中的目标模型后端不可用')
        const launchConfig = structuredClone(config)
        launchConfig._base_ = join(options.projectRoot, 'configs', '_base_', 'default.yaml')
        launchConfig.evaluation ??= {}
        if (Object.prototype.hasOwnProperty.call(launchConfig, 'eval_test')) {
          launchConfig.evaluation.eval_test = launchConfig.eval_test
          delete launchConfig.eval_test
        }
        delete launchConfig.out_root
        launchConfig.env.out_root = runDir
        await writeFile(join(runDir, 'launch_config.yaml'), stringify(launchConfig))
        await startProcess(id, runDir, run.model, run.user_id ?? req.user.id, run.state_json, 'launch_config.yaml')
      })
      res.json({ status: 'started', runId: req.params.id })
    } catch (error) { res.status(error instanceof RunConflict ? 409 : 400).json({ error: error instanceof Error ? error.message : String(error) }) }
  })

  return { router, lifecycle }
}

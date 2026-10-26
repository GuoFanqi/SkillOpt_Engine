import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { assertPathWithin, PathError, resolveRunPath, validateRunId } from './safe-paths.js'

export type JsonObject = Record<string, any>
export type DataSplit = 'train' | 'val' | 'test'

export interface ArtifactSkill {
  version: string
  name: string
  path: string
  chars: number
  content: string
  timestamp: string
}

export interface ArtifactEvaluation {
  step: number
  phase: string
  item_id: string
  question: string
  gold_answer: string
  system_prompt: string
  user_prompt: string
  model_response: string
  extracted_answer: string
  is_correct: number | null
  score_em: number | null
  score_f1: number | null
  n_turns: number
  tokens_prompt: number
  tokens_completion: number
}

export interface RunArtifactsSnapshot {
  runId: string
  runPath: string
  config?: JsonObject
  trainConfig?: JsonObject
  summary?: JsonObject
  tokenUsage?: unknown
  runtimeState?: JsonObject
  history?: JsonObject[]
  skills?: ArtifactSkill[]
  data: Partial<Record<DataSplit, JsonObject[]>>
  evaluations?: ArtifactEvaluation[]
  evidence: Record<string, string>
}

function object(value: unknown, source: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`产物不是JSON对象: ${source}`)
  return value as JsonObject
}

export function parseArtifactItems(text: string, source: string): JsonObject[] {
  const input = text.trim()
  let values: unknown[]
  if (!input) values = []
  else if (input.startsWith('[')) {
    const parsed: unknown = JSON.parse(input)
    if (!Array.isArray(parsed)) throw new Error(`产物不是JSON数组: ${source}`)
    values = parsed
  } else {
    values = input.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line))
  }
  return values.map(value => object(value, source))
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value)
}

export async function readRunArtifacts(runPath: string, runId: string, allowedUploadsRoot: string): Promise<RunArtifactsSnapshot> {
  validateRunId(runId)
  if (basename(resolve(runPath)) !== runId) throw new PathError('训练目录与任务ID不匹配')
  const root = await resolveRunPath(dirname(resolve(runPath)), runId)
  const evidence: Record<string, string> = {}
  const snapshot: RunArtifactsSnapshot = { runId, runPath: root, data: {}, evidence }

  async function exists(path: string, allowedRoot = root): Promise<boolean> {
    const safe = await assertPathWithin(allowedRoot, path, { allowMissing: true })
    try { await lstat(safe); return true } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  async function readText(path: string, allowedRoot = root): Promise<string> {
    const safe = await assertPathWithin(allowedRoot, path)
    const content = await readFile(safe, 'utf8')
    const canonicalRoot = allowedRoot === root ? root : await assertPathWithin(allowedRoot, allowedRoot)
    const key = allowedRoot === root ? relative(root, safe) : `uploads/${relative(canonicalRoot, safe)}`
    evidence[key] = content
    return content
  }

  async function readObject(name: string): Promise<JsonObject | undefined> {
    const path = join(root, name)
    if (!await exists(path)) return undefined
    return object(JSON.parse(await readText(path)), name)
  }

  snapshot.config = await readObject('config.json')
  snapshot.summary = await readObject('summary.json')
  snapshot.runtimeState = await readObject('runtime_state.json')
  if (await exists(join(root, 'config.yaml'))) {
    snapshot.trainConfig = object(parseYaml(await readText(join(root, 'config.yaml'))), 'config.yaml')
  }
  if (snapshot.summary && Object.prototype.hasOwnProperty.call(snapshot.summary, 'token_summary')) snapshot.tokenUsage = snapshot.summary.token_summary
  else if (await exists(join(root, 'token_usage.json'))) snapshot.tokenUsage = JSON.parse(await readText(join(root, 'token_usage.json')))
  else if (snapshot.summary && Object.prototype.hasOwnProperty.call(snapshot.summary, 'token_usage')) snapshot.tokenUsage = snapshot.summary.token_usage

  const historyPath = join(root, 'history.json')
  if (await exists(historyPath)) {
    const parsed = JSON.parse(await readText(historyPath))
    if (!Array.isArray(parsed)) throw new Error('history.json 必须是数组')
    const steps = new Set<number>()
    snapshot.history = parsed.map((value, index) => {
      const row = object(value, 'history.json')
      const step = row.step ?? index + 1
      if (!Number.isSafeInteger(step) || step < 1 || steps.has(step)) throw new Error('history.json 包含无效或重复步骤')
      steps.add(step)
      return { ...row, step }
    })
    if (typeof snapshot.summary?.total_steps === 'number' && snapshot.summary.total_steps !== snapshot.history.length) {
      throw new Error('history.json 与 summary.json 的步骤数量不一致')
    }
    for (const row of snapshot.history) {
      const dir = join(root, 'steps', `step_${String(row.step).padStart(4, '0')}`)
      const candidate = join(dir, 'candidate_skill.md')
      if (await exists(candidate)) row.candidate_skill = await readText(candidate)
      for (const name of ['step_record.json', 'merged_patch.json', 'selected_patch.json']) {
        const path = join(dir, name)
        if (await exists(path)) JSON.parse(await readText(path))
      }
    }
  }

  const skills: ArtifactSkill[] = []
  async function addSkill(version: string, path: string, allowedRoot = root): Promise<void> {
    const safe = await assertPathWithin(allowedRoot, path)
    const content = await readText(path, allowedRoot)
    skills.push({ version, name: basename(path), path: allowedRoot === root ? relative(root, safe) : `data/${basename(path)}`, content, chars: content.length, timestamp: (await stat(safe)).mtime.toISOString() })
  }
  const skillsDir = join(root, 'skills')
  if (await exists(skillsDir)) {
    for (const name of (await readdir(await assertPathWithin(root, skillsDir))).sort()) {
      const match = /^skill_vv?(\d+)\.md$/.exec(name)
      if (match) await addSkill(match[1].padStart(4, '0'), join(skillsDir, name))
    }
  }
  for (const [version, name] of [['best', 'best_skill.md'], ['final', 'final_skill.md']] as const) {
    if (await exists(join(root, name))) await addSkill(version, join(root, name))
  }

  const localData = join(root, 'data')
  const configuredData = snapshot.trainConfig?.env?.split_dir ?? snapshot.config?.split_dir ?? snapshot.config?.env?.split_dir
  let externalData: string | undefined
  async function getExternalData(): Promise<string | undefined> {
    if (externalData) return externalData
    if (typeof configuredData !== 'string' || !configuredData ||
        [localData, join(resolve(runPath), 'data')].includes(resolve(configuredData))) return undefined
    externalData = await assertPathWithin(allowedUploadsRoot, resolve(configuredData))
    return externalData
  }
  async function findSplit(dir: string, split: DataSplit, allowedRoot: string): Promise<JsonObject[] | undefined> {
    for (const name of [`${split}/data.json`, `${split}/items.json`, `${split}.json`, `${split}.jsonl`]) {
      const path = join(dir, name)
      if (await exists(path, allowedRoot)) return parseArtifactItems(await readText(path, allowedRoot), name)
    }
    return undefined
  }
  for (const split of ['train', 'val', 'test'] as const) {
    let items = await findSplit(localData, split, root)
    if (items === undefined) {
      const external = await getExternalData()
      if (external) items = await findSplit(external, split, allowedUploadsRoot)
    }
    if (items !== undefined) snapshot.data[split] = items
  }
  let initialPath: string | undefined
  for (const path of [join(localData, 'initial_skill.md'), join(root, 'initial_skill.md')]) {
    if (await exists(path)) { initialPath = path; break }
  }
  if (initialPath) await addSkill('initial', initialPath)
  else {
    const external = await getExternalData()
    if (external && await exists(join(external, 'initial_skill.md'), allowedUploadsRoot)) await addSkill('initial', join(external, 'initial_skill.md'), allowedUploadsRoot)
  }
  if (skills.length) snapshot.skills = skills

  const evaluations: ArtifactEvaluation[] = []
  const evalDirs: Array<{ path: string; step: number; phase: string }> = [
    { path: 'selection_eval_baseline', step: 0, phase: 'baseline_selection' },
    { path: 'test_eval_baseline', step: 0, phase: 'baseline_test' },
    { path: 'test_eval', step: 0, phase: 'test' },
    { path: 'test_eval_final', step: 0, phase: 'final_test' },
    { path: 'final_selection_eval', step: 0, phase: 'final_selection' },
    { path: 'selection_eval_test_baseline', step: 0, phase: 'baseline_test' },
    { path: 'selection_eval_test', step: 0, phase: 'test' },
  ]
  const stepsDir = join(root, 'steps')
  if (await exists(stepsDir)) {
    for (const name of await readdir(await assertPathWithin(root, stepsDir))) {
      const match = /^step_(\d+)$/.exec(name)
      if (!match) continue
      for (const [dir, phase] of [['rollout', 'rollout'], ['selection_eval', 'selection']]) {
        evalDirs.push({ path: `steps/${name}/${dir}`, step: Number(match[1]), phase })
      }
    }
  }
  const seen = new Set<string>()
  for (const dir of evalDirs) {
    const resultsPath = join(root, dir.path, 'results.jsonl')
    if (!await exists(resultsPath)) continue
    const results = parseArtifactItems(await readText(resultsPath), resultsPath)
    for (const result of results) {
      const id = result.id
      if ((typeof id !== 'string' && typeof id !== 'number') || !String(id)) throw new Error('评估结果缺少样本ID')
      if (String(id).length > 128 || /[\\/\u0000]/.test(String(id)) || ['.', '..'].includes(String(id))) throw new PathError('无效的评估样本路径')
      const key = `${dir.step}:${dir.phase}:${id}`
      if (seen.has(key)) throw new Error('评估产物包含重复样本')
      seen.add(key)
      const predDir = join(root, dir.path, 'predictions', String(id))
      await assertPathWithin(join(root, dir.path), predDir, { allowMissing: true })
      async function optionalText(name: string): Promise<string> {
        const path = join(predDir, name)
        return await exists(path) ? readText(path) : ''
      }
      const conversationText = await optionalText('conversation.json')
      const conversation = conversationText ? JSON.parse(conversationText) : []
      if (!Array.isArray(conversation)) throw new Error('conversation.json 必须是数组')
      const messages = conversation.filter((item: JsonObject) => item.type === 'message' || item.role === 'assistant')
      const hard = numeric(result.em ?? result.hard)
      const soft = numeric(result.f1 ?? result.soft)
      evaluations.push({
        step: dir.step, phase: dir.phase, item_id: String(id),
        question: textValue(result.question ?? result.task_description),
        gold_answer: textValue(result.gold_answers ?? result.gold_answer ?? result.answers),
        system_prompt: await optionalText('target_system_prompt.txt'),
        user_prompt: await optionalText('target_user_prompt.txt'),
        model_response: textValue(result.response) || messages.map((item: JsonObject) => textValue(item.content)).join('\n---\n'),
        extracted_answer: textValue(result.predicted_answer),
        is_correct: hard === null ? null : hard === 1 ? 1 : 0,
        score_em: hard, score_f1: soft, n_turns: result.n_turns ?? messages.length,
        tokens_prompt: result.tokens_prompt ?? 0, tokens_completion: result.tokens_completion ?? 0,
      })
    }
  }
  if (evaluations.length) snapshot.evaluations = evaluations
  return snapshot
}

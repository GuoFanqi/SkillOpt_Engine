import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import type { RunState } from '../../shared/run-state.js'
import { isNewerRunState, replaceRunArtifacts, trainingData, trainingRuns, type DbConnection } from '../src/db.js'
import { parseArtifactItems, readRunArtifacts, type RunArtifactsSnapshot } from '../src/run-artifacts.js'

class FakeConnection implements DbConnection {
  run: any = { id: 'run_1', user_id: 7, status: 'completed', state_json: null, config_json: { original: true } }
  tables: Record<string, any[]> = { training_data_items: [], step_history: [], skill_versions: [], evaluation_details: [] }
  calls: string[] = []
  failTable = ''
  backup: any
  async beginTransaction() { this.calls.push('BEGIN'); this.backup = structuredClone({ run: this.run, tables: this.tables }) }
  async commit() { this.calls.push('COMMIT'); this.backup = undefined }
  async rollback() { this.calls.push('ROLLBACK'); this.run = this.backup.run; this.tables = this.backup.tables; this.backup = undefined }
  release() { this.calls.push('RELEASE') }
  async execute(sql: string, values: any[] = []): Promise<[any, any]> {
    this.calls.push(sql)
    if (sql.startsWith('SELECT state_json')) return [this.run ? [{ state_json: this.run.state_json }] : [], []]
    if (sql.startsWith('SELECT id FROM training_runs')) return [this.run ? [{ id: this.run.id }] : [], []]
    if (sql.startsWith('SELECT * FROM training_data_items')) return [this.tables.training_data_items.filter(row => row.run_id === values[0]), []]
    if (sql.startsWith('UPDATE training_runs SET state_json')) {
      Object.assign(this.run, { state_json: values[0], status: values[1], current_score: values[2], best_score: values[3], total_steps: values[4], error_message: values[5], artifact_sync_status: values[6], artifact_sync_error: values[7] })
      if (values[8]) this.run.ai_summary = ''
      return [{ affectedRows: 1 }, []]
    }
    if (sql.startsWith('UPDATE training_runs SET ai_summary')) {
      this.run.ai_summary = values[0]
      return [{ affectedRows: 1 }, []]
    }
    if (sql.startsWith('UPDATE training_runs SET artifact_sync_status')) {
      this.run.artifact_sync_status = 'synced'
      this.run.artifact_sync_error = ''
      return [{ affectedRows: 1 }, []]
    }
    if (sql.startsWith('UPDATE training_runs SET')) {
      const keys = [...sql.matchAll(/`([^`]+)` = \?/g)].map(match => match[1])
      keys.forEach((key, index) => { this.run[key] = values[index] })
      return [{ affectedRows: 1 }, []]
    }
    if (sql.startsWith('DELETE FROM training_data_items')) {
      this.tables.training_data_items = this.tables.training_data_items.filter(row => row.run_id !== values[0] || row.split !== values[1])
      return [{ affectedRows: 1 }, []]
    }
    if (sql.startsWith('DELETE FROM step_history')) {
      this.tables.step_history = this.tables.step_history.filter(row => row.run_id !== values[0])
      return [{ affectedRows: 1 }, []]
    }
    const insert = /^INSERT INTO `([^`]+)` \(([^)]+)\)/.exec(sql)
    if (insert) {
      const table = insert[1]
      if (table === this.failTable) throw new Error('simulated database write failure')
      const columns = insert[2].split(',').map(value => value.replaceAll('`', ''))
      for (let start = 0; start < values.length; start += columns.length) {
        const row = Object.fromEntries(columns.map((column, index) => [column, values[start + index]]))
        const keys = table === 'skill_versions' ? ['run_id', 'version'] : ['run_id', 'step', 'phase', 'item_id']
        const existing = sql.includes('ON DUPLICATE KEY') ? this.tables[table].find(item => keys.every(key => item[key] === row[key])) : undefined
        if (existing) Object.assign(existing, row)
        else this.tables[table].push(row)
      }
      return [{ affectedRows: 1 }, []]
    }
    throw new Error(`Unexpected offline query: ${sql}`)
  }
}

async function fixture(work: (run: string, uploads: string, write: (path: string, value: string | object) => Promise<void>) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), 'skillopt-artifacts-'))
  const run = join(base, 'run_1')
  const uploads = join(base, 'uploads')
  await mkdir(run)
  await mkdir(uploads)
  const write = async (path: string, value: string | object) => {
    const full = join(run, path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, typeof value === 'string' ? value : JSON.stringify(value))
  }
  try { await work(run, uploads, write) } finally { await rm(base, { recursive: true, force: true }) }
}

function state(overrides: Partial<RunState> = {}): RunState {
  return { instanceId: 'instance-1', attempt: 1, version: 1, status: 'training', phase: 'rollout', currentStep: 1, completedSteps: 0, totalSteps: 3, currentScore: 0, bestScore: 0.25, updatedAt: new Date().toISOString(), artifactSync: 'pending', ...overrides }
}

test('JSON arrays and JSONL retain original IDs and optional business constraints', () => {
  const item = { id: 'original-id', question: 'question', answers: ['answer'], forbidden_terms: ['到账'] }
  assert.deepEqual(parseArtifactItems(JSON.stringify([item], null, 2), 'array.json'), [item])
  assert.deepEqual(parseArtifactItems(`${JSON.stringify(item)}\n`, 'rows.jsonl'), [item])
  assert.throws(() => parseArtifactItems('{broken json}', 'rows.jsonl'))
  assert.throws(() => parseArtifactItems('["not an object"]', 'array.json'))
})

test('snapshot reads nested data and full evidence without deleting original files', async () => {
  await fixture(async (run, uploads, write) => {
    const item = { id: 'question-id', question: 'question', answers: ['answer'], forbidden_terms: ['到账'] }
    await write('config.json', { env: 'searchqa', num_epochs: 1 })
    await write('summary.json', { total_steps: 1, token_usage: { prompt: 123 } })
    await write('history.json', [{ step: 1, epoch: 1, current_score: 0, action: 'accept' }])
    await write('data/train/data.json', [item])
    await write('data/val/items.json', [item])
    await write('data/test.jsonl', `${JSON.stringify(item)}\n`)
    await write('data/initial_skill.md', '# Initial')
    await write('skills/skill_v0001.md', '# Improved')
    await write('steps/step_0001/candidate_skill.md', '# Candidate')
    await write('steps/step_0001/step_record.json', { action: 'accept' })
    await write('steps/step_0001/merged_patch.json', { edits: [] })
    const response = 'response'.repeat(1500)
    await write('test_eval/results.jsonl', `${JSON.stringify({ id: 'question-id', question: 'question', response, predicted_answer: 'answer', hard: 1, soft: 1 })}\n`)
    await write('test_eval/predictions/question-id/target_system_prompt.txt', 'prompt'.repeat(2000))
    await write('test_eval/predictions/question-id/conversation.json', [{ role: 'assistant', content: response }])
    const snapshot = await readRunArtifacts(run, 'run_1', uploads)
    assert.deepEqual(snapshot.data.train, [item])
    assert.deepEqual(snapshot.data.val, [item])
    assert.deepEqual(snapshot.tokenUsage, { prompt: 123 })
    assert.equal(snapshot.evaluations?.[0].model_response, response)
    assert.equal(snapshot.evaluations?.[0].system_prompt.length, 12000)
    assert.equal(snapshot.evidence['steps/step_0001/merged_patch.json'], '{"edits":[]}')
    assert.equal(await readFile(join(run, 'skills/skill_v0001.md'), 'utf8'), '# Improved')
    const connection = new FakeConnection()
    connection.run.state_json = JSON.stringify(state({ status: 'completed', phase: 'completed' }))
    const oldState = connection.run.state_json
    await replaceRunArtifacts('run_1', snapshot, connection)
    await replaceRunArtifacts('run_1', snapshot, connection)
    assert.equal(connection.tables.step_history.length, 1)
    assert.equal(connection.tables.skill_versions.length, 2)
    assert.equal(connection.tables.evaluation_details.length, 1)
    assert.equal(connection.tables.training_data_items.length, 3)
    assert.equal(connection.run.user_id, 7)
    assert.equal(connection.run.status, 'completed')
    assert.equal(connection.run.state_json, oldState)
    const restored = await trainingData.getByRunId('run_1', connection)
    assert.deepEqual(restored.train, [item])
    assert.equal(JSON.parse(connection.run.config_json).env, 'searchqa')
    assert.equal(connection.run.artifact_sync_status, 'synced')
  })
})

test('trainer summary fields drive total time and token usage without legacy shadowing', async () => {
  await fixture(async (run, uploads, write) => {
    await write('history.json', [{ step: 1 }, { step: 2 }])
    await write('summary.json', {
      version: 'skillopt-0.1.0', status: 'completed', total_steps: 2,
      total_wall_time_s: 120.5, wall_time_s: 999,
      token_summary: { optimizer: { prompt_tokens: 4321 }, target: { completion_tokens: 1234 } },
      token_usage: { outdated: true },
    })
    await write('token_usage.json', { outdated_file: true })
    const snapshot = await readRunArtifacts(run, 'run_1', uploads)
    const connection = new FakeConnection()
    await replaceRunArtifacts('run_1', snapshot, connection)
    assert.equal(connection.run.total_time, '120.5s')
    assert.equal(connection.run.avg_per_step, '60.3s')
    assert.deepEqual(JSON.parse(connection.run.token_usage_json), { optimizer: { prompt_tokens: 4321 }, target: { completion_tokens: 1234 } })
    await write('summary.json', { total_steps: 2, wall_time_s: 60, token_usage: { legacy: true } })
    await rm(join(run, 'token_usage.json'))
    const legacy = await readRunArtifacts(run, 'run_1', uploads)
    await replaceRunArtifacts('run_1', legacy, connection)
    assert.equal(connection.run.total_time, '60.0s')
    assert.deepEqual(JSON.parse(connection.run.token_usage_json), { legacy: true })
  })
})

test('missing collections never clear existing data, while corrupted files reject the snapshot', async () => {
  await fixture(async (run, uploads, write) => {
    const snapshot = await readRunArtifacts(run, 'run_1', uploads)
    assert.equal(snapshot.history, undefined)
    assert.equal(snapshot.skills, undefined)
    assert.equal(snapshot.evaluations, undefined)
    assert.deepEqual(snapshot.data, {})
    const connection = new FakeConnection()
    connection.tables.training_data_items = [{ run_id: 'run_1', split: 'train', item_json: { id: 'old', forbidden_terms: ['到账'] } }]
    await replaceRunArtifacts('run_1', snapshot, connection)
    assert.equal(connection.tables.training_data_items.length, 1)
    assert.deepEqual(connection.run.config_json, { original: true })
    assert.equal(connection.calls.some(sql => sql.startsWith('DELETE')), false)
    await write('data/train/data.json', '{broken}')
    await assert.rejects(readRunArtifacts(run, 'run_1', uploads))
  })
})

test('transaction failure rolls back removed rows and metadata', async () => {
  const connection = new FakeConnection()
  connection.tables.training_data_items = [{ run_id: 'run_1', split: 'train', item_json: { id: 'old' } }]
  connection.failTable = 'training_data_items'
  const snapshot: RunArtifactsSnapshot = { runId: 'run_1', runPath: '/fixture', config: { replacement: true }, data: { train: [{ id: 'new' }] }, evidence: {} }
  await assert.rejects(replaceRunArtifacts('run_1', snapshot, connection), /simulated database/)
  assert.equal(connection.tables.training_data_items[0].item_json.id, 'old')
  assert.deepEqual(connection.run.config_json, { original: true })
  assert.ok(connection.calls.includes('ROLLBACK'))
  assert.ok(!connection.calls.includes('COMMIT'))
  assert.notEqual(connection.run.artifact_sync_status, 'synced')
})

test('state writes preserve units and reject stale attempts, instances and terminal regressions', async () => {
  const connection = new FakeConnection()
  assert.equal(await trainingRuns.updateState('run_1', state(), connection), true)
  assert.equal(connection.run.current_score, 0)
  assert.equal(connection.run.best_score, 25)
  assert.equal(connection.run.total_steps, 0)
  assert.equal(await trainingRuns.updateState('run_1', state(), connection), false)
  assert.equal(await trainingRuns.updateState('run_1', state({ instanceId: 'other', version: 9 }), connection), false)
  assert.equal(await trainingRuns.updateState('run_1', state({ attempt: 0, version: 9 }), connection), false)
  const completed = state({ version: 2, status: 'completed', phase: 'completed', completedSteps: 3, currentStep: 3 })
  assert.equal(await trainingRuns.updateState('run_1', completed, connection), true)
  assert.equal(await trainingRuns.updateState('run_1', state({ version: 3 }), connection), false)
  connection.run.state_json = JSON.parse(connection.run.state_json)
  assert.equal(await trainingRuns.updateState('run_1', { ...completed, version: 3, artifactSync: 'synced' }, connection), true)
  assert.equal(await trainingRuns.updateState('run_1', state({ attempt: 2, instanceId: 'new' }), connection), true)
  assert.throws(() => isNewerRunState(undefined, state({ currentScore: 50 })), /无效/)
})

test('late summaries cannot overwrite a newer training instance', async () => {
  const connection = new FakeConnection()
  await trainingRuns.updateState('run_1', state(), connection)
  assert.equal(await trainingRuns.saveSummary('run_1', 'first summary', 'instance-1', connection), true)
  assert.equal(connection.run.ai_summary, 'first summary')
  await trainingRuns.updateState('run_1', state({ attempt: 2, instanceId: 'instance-2' }), connection)
  assert.equal(connection.run.ai_summary, '')
  assert.equal(await trainingRuns.saveSummary('run_1', 'late first summary', 'instance-1', connection), false)
  assert.equal(connection.run.ai_summary, '')
  assert.equal(await trainingRuns.saveSummary('run_1', 'new summary', 'instance-2', connection), true)
  assert.equal(connection.run.ai_summary, 'new summary')
})

test('invalid run identity and partial history fail before archival', async () => {
  await fixture(async (run, uploads, write) => {
    await assert.rejects(readRunArtifacts(run, 'another', uploads), /不匹配/)
    await write('history.json', [])
    await write('summary.json', { total_steps: 2 })
    await assert.rejects(readRunArtifacts(run, 'run_1', uploads), /数量不一致/)
  })
})

test('a local input directory can have missing optional splits without using another upload directory', async () => {
  await fixture(async (run, uploads, write) => {
    await write('config.json', { split_dir: join(run, 'data') })
    await write('data/train/data.json', [{ id: 'only-train' }])
    const snapshot = await readRunArtifacts(run, 'run_1', uploads)
    assert.equal(snapshot.data.train?.[0].id, 'only-train')
    assert.equal(snapshot.data.val, undefined)
    assert.equal(snapshot.data.test, undefined)
  })
})

test('evaluation identities cannot escape their prediction directory', async () => {
  await fixture(async (run, uploads, write) => {
    await write('test_eval/results.jsonl', JSON.stringify({ id: '../other', hard: 1 }))
    await assert.rejects(readRunArtifacts(run, 'run_1', uploads), /样本路径/)
  })
})

test('legacy upload input is read only from its configured authorized directory', async () => {
  await fixture(async (run, uploads, write) => {
    const source = join(uploads, 'legacy')
    await mkdir(source)
    await writeFile(join(source, 'train.json'), JSON.stringify([{ id: 'legacy', forbidden_terms: ['到账'] }]))
    await writeFile(join(source, 'initial_skill.md'), '# Legacy')
    await write('config.json', { split_dir: source })
    const snapshot = await readRunArtifacts(run, 'run_1', uploads)
    assert.equal(snapshot.data.train?.[0].id, 'legacy')
    assert.equal(snapshot.skills?.find(skill => skill.version === 'initial')?.content, '# Legacy')
    await write('config.json', { split_dir: dirname(uploads) })
    await assert.rejects(readRunArtifacts(run, 'run_1', uploads), /超出授权目录/)
  })
})

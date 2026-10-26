import mysql from 'mysql2/promise'
import { join } from 'path'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import type { RunState } from '../../shared/run-state.js'
import type { JsonObject, RunArtifactsSnapshot } from './run-artifacts.js'

// ─── MySQL connection config ───
const DB_CONFIG = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: parseInt(process.env.MYSQL_PORT || '3306'),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'skillopt',
  charset: 'utf8mb4',
}

let poolReady: Promise<mysql.Pool> | undefined

async function getPool(): Promise<mysql.Pool> {
  if (!poolReady) {
    const pool = mysql.createPool({ ...DB_CONFIG, waitForConnections: true, connectionLimit: 10 })
    poolReady = (async () => {
      const initConn = await mysql.createConnection({
        host: DB_CONFIG.host, port: DB_CONFIG.port,
        user: DB_CONFIG.user, password: DB_CONFIG.password,
      })
      try {
        await initConn.execute(`CREATE DATABASE IF NOT EXISTS \`${DB_CONFIG.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
      } finally {
        await initConn.end()
      }
      await createTables(pool)
      return pool
    })().catch(async error => {
      await pool.end()
      poolReady = undefined
      throw error
    })
  }
  return poolReady
}

async function createTables(p: mysql.Pool) {
  await p.execute(`
    CREATE TABLE IF NOT EXISTS api_keys (
      workspace_id VARCHAR(64) NOT NULL DEFAULT 'default',
      user_id INT DEFAULT NULL,
      provider VARCHAR(32) NOT NULL,
      api_key TEXT NOT NULL,
      base_url TEXT,
      endpoint TEXT,
      api_version TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (workspace_id, provider)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  await p.execute(`
    CREATE TABLE IF NOT EXISTS training_runs (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(500) NOT NULL,
      env VARCHAR(64) DEFAULT '',
      model VARCHAR(128) DEFAULT '',
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      error_message TEXT,
      current_score DOUBLE DEFAULT 0,
      best_score DOUBLE DEFAULT 0,
      initial_score DOUBLE DEFAULT 0,
      accept_rate DOUBLE DEFAULT 0,
      total_steps INT DEFAULT 0,
      accepts INT DEFAULT 0,
      rejects INT DEFAULT 0,
      skips INT DEFAULT 0,
      total_time VARCHAR(32) DEFAULT '',
      avg_per_step VARCHAR(32) DEFAULT '',
      epochs INT DEFAULT 0,
      batch_size INT DEFAULT 0,
      edit_budget INT DEFAULT 0,
      lr_scheduler VARCHAR(64) DEFAULT '',
      slow_update TINYINT DEFAULT 1,
      slow_updates INT DEFAULT 0,
      baseline_test_score DOUBLE DEFAULT 0,
      test_score DOUBLE DEFAULT 0,
      ai_summary TEXT,
      train_config_json JSON,
      runtime_state TEXT,
      state_json JSON,
      artifact_sync_status VARCHAR(32) NOT NULL DEFAULT 'pending',
      artifact_sync_error TEXT,
      user_id INT DEFAULT NULL,
      config_json JSON,
      summary_json JSON,
      token_usage_json JSON,
      INDEX idx_user (user_id),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  await p.execute(`
    CREATE TABLE IF NOT EXISTS step_history (
      id INT AUTO_INCREMENT PRIMARY KEY,
      run_id VARCHAR(255) NOT NULL,
      step INT NOT NULL,
      epoch INT DEFAULT 1,
      step_in_epoch INT DEFAULT 0,
      action VARCHAR(32) DEFAULT 'skip',
      raw_action VARCHAR(64) DEFAULT '',
      current_score DOUBLE DEFAULT 0,
      best_score DOUBLE DEFAULT 0,
      rollout_hard DOUBLE DEFAULT 0,
      rollout_soft DOUBLE DEFAULT 0,
      selection_hard DOUBLE DEFAULT 0,
      selection_soft DOUBLE DEFAULT 0,
      n_patches INT DEFAULT 0,
      n_success_patches INT DEFAULT 0,
      wall_time_s DOUBLE DEFAULT 0,
      skill_len INT DEFAULT 0,
      tokens_json JSON,
      timing_json JSON,
      candidate_skill MEDIUMTEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_run_step (run_id, step),
      FOREIGN KEY (run_id) REFERENCES training_runs(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  await p.execute(`
    CREATE TABLE IF NOT EXISTS skill_versions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      run_id VARCHAR(255) NOT NULL,
      version VARCHAR(64) NOT NULL,
      name VARCHAR(255) DEFAULT '',
      path VARCHAR(500) DEFAULT '',
      chars INT DEFAULT 0,
      content MEDIUMTEXT,
      timestamp VARCHAR(64) DEFAULT '',
      UNIQUE KEY uk_run_version (run_id, version),
      INDEX idx_run (run_id),
      FOREIGN KEY (run_id) REFERENCES training_runs(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  await p.execute(`
    CREATE TABLE IF NOT EXISTS training_data_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      run_id VARCHAR(255) NOT NULL,
      split VARCHAR(16) NOT NULL,
      item_index INT DEFAULT 0,
      question TEXT NOT NULL,
      context TEXT,
      answers_json JSON,
      item_json JSON,
      INDEX idx_run_split (run_id, split),
      FOREIGN KEY (run_id) REFERENCES training_runs(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  await p.execute(`
    CREATE TABLE IF NOT EXISTS user_skills (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(500) NOT NULL DEFAULT '',
      content MEDIUMTEXT NOT NULL,
      description TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  await p.execute(`
    CREATE TABLE IF NOT EXISTS templates (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(500) NOT NULL DEFAULT '',
      description TEXT,
      icon VARCHAR(16) DEFAULT '',
      category VARCHAR(64) DEFAULT '',
      difficulty VARCHAR(16) DEFAULT 'medium',
      skill_content MEDIUMTEXT,
      train_qa_json JSON,
      val_qa_json JSON,
      split_ratio DOUBLE DEFAULT 0.8,
      config_json JSON,
      expected_metrics_json JSON,
      highlights_json JSON,
      user_id INT DEFAULT NULL,
      INDEX idx_user (user_id),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  await p.execute(`
    CREATE TABLE IF NOT EXISTS training_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      run_id VARCHAR(255) NOT NULL,
      type ENUM('stdout', 'stderr') NOT NULL DEFAULT 'stdout',
      text TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_run_id (run_id),
      INDEX idx_created (run_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  await p.execute(`
    CREATE TABLE IF NOT EXISTS evaluation_details (
      id INT AUTO_INCREMENT PRIMARY KEY,
      run_id VARCHAR(255) NOT NULL,
      step INT NOT NULL DEFAULT 0,
      phase VARCHAR(64) NOT NULL DEFAULT '',
      item_id VARCHAR(128) NOT NULL DEFAULT '',
      question TEXT,
      gold_answer TEXT,
      system_prompt TEXT,
      user_prompt TEXT,
      model_response MEDIUMTEXT,
      extracted_answer TEXT,
      is_correct INT DEFAULT 0,
      score_em DOUBLE DEFAULT 0,
      score_f1 DOUBLE DEFAULT 0,
      n_turns INT DEFAULT 1,
      tokens_prompt INT DEFAULT 0,
      tokens_completion INT DEFAULT 0,
      UNIQUE KEY uk_run_step_phase_item (run_id, step, phase, item_id),
      INDEX idx_run (run_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  await p.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      phone VARCHAR(20) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      is_admin TINYINT DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  const additions: Record<string, Record<string, string>> = {
    training_runs: {
      state_json: 'JSON',
      artifact_sync_status: "VARCHAR(32) NOT NULL DEFAULT 'pending'",
      artifact_sync_error: 'TEXT',
    },
    training_data_items: { item_json: 'JSON' },
  }
  for (const [table, fields] of Object.entries(additions)) {
    const [rows] = await p.execute('SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]) as any[]
    const names = new Set(rows.map((row: any) => row.name))
    for (const [name, definition] of Object.entries(fields)) {
      if (names.has(name)) continue
      try { await p.execute(`ALTER TABLE \`${table}\` ADD COLUMN \`${name}\` ${definition}`) }
      catch (error) { if ((error as { code?: string }).code !== 'ER_DUP_FIELDNAME') throw error }
    }
  }
  for (const [table, columns] of Object.entries({
    training_logs: ['text'],
    evaluation_details: ['question', 'gold_answer', 'system_prompt', 'user_prompt'],
    training_data_items: ['question', 'context'],
  })) {
    const [rows] = await p.execute('SELECT COLUMN_NAME AS name, DATA_TYPE AS type FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]) as any[]
    for (const name of columns) {
      if (rows.find((row: any) => row.name === name)?.type !== 'text') continue
      await p.execute(`ALTER TABLE \`${table}\` MODIFY COLUMN \`${name}\` MEDIUMTEXT${table === 'training_data_items' && name === 'question' ? ' NOT NULL' : ''}`)
    }
  }
}

// ─── Training Logs ───
export const trainingLogs = {
  append: async (runId: string, type: 'stdout' | 'stderr', text: string) => {
    const p = await getPool()
    await p.execute('INSERT INTO training_logs (run_id, type, text) VALUES (?, ?, ?)', [runId, type, text])
  },

  appendBatch: async (runId: string, lines: Array<{ type: 'stdout' | 'stderr'; text: string }>) => {
    if (lines.length === 0) return
    const p = await getPool()
    const values = lines.map(() => '(?, ?, ?)').join(', ')
    const params: any[] = []
    for (const l of lines) { params.push(runId, l.type, l.text) }
    await p.execute(`INSERT INTO training_logs (run_id, type, text) VALUES ${values}`, params)
  },

  getByRunId: async (runId: string, limit = 500): Promise<Array<{ id: number; type: string; text: string; created_at: string }>> => {
    const p = await getPool()
    const [rows] = await p.execute(
      `SELECT id, type, text, created_at FROM training_logs WHERE run_id = ? ORDER BY id DESC LIMIT ${Math.max(1, limit)}`,
      [runId]
    ) as any[]
    return rows.reverse()
  },

  deleteByRunId: async (runId: string) => {
    const p = await getPool()
    await p.execute('DELETE FROM training_logs WHERE run_id = ?', [runId])
  },
}

// ─── Users ───
export const users = {
  create: async (phone: string, passwordHash: string) => {
    const p = await getPool()
    const [result] = await p.execute('INSERT INTO users (phone, password_hash) VALUES (?, ?)', [phone, passwordHash]) as any
    return { id: result.insertId, phone }
  },

  findByPhone: async (phone: string) => {
    const p = await getPool()
    const [rows] = await p.execute('SELECT * FROM users WHERE phone = ?', [phone]) as any[]
    return rows[0] || null
  },

  findById: async (id: number) => {
    const p = await getPool()
    const [rows] = await p.execute('SELECT id, phone, is_admin, created_at FROM users WHERE id = ?', [id]) as any[]
    return rows[0] || null
  },
}

// ─── API Keys ───
export const apiKeys = {
  getAll: async (userId: number | null = null) => {
    const p = await getPool()
    const wsId = userId !== null ? `user_${userId}` : 'default'
    const [rows] = await p.execute('SELECT * FROM api_keys WHERE workspace_id = ?', [wsId]) as any[]
    const result: Record<string, any> = {}
    for (const r of rows) {
      const preview = r.api_key ? r.api_key.slice(0, 6) + '••••' + r.api_key.slice(-4) : ''
      result[r.provider] = {
        apiKeyConfigured: !!r.api_key,
        apiKeyPreview: preview,
        baseUrl: r.base_url || undefined,
        endpoint: r.endpoint || undefined,
        apiVersion: r.api_version || undefined,
      }
    }
    return result
  },

  getRaw: async (provider: string, userId: number | null = null) => {
    const p = await getPool()
    const wsId = userId !== null ? `user_${userId}` : 'default'
    const [rows] = await p.execute('SELECT * FROM api_keys WHERE workspace_id = ? AND provider = ?', [wsId, provider]) as any[]
    return rows[0] || null
  },

  save: async (provider: string, data: any, userId: number | null = null) => {
    const p = await getPool()
    const wsId = userId !== null ? `user_${userId}` : 'default'
    const id = userId ?? 0
    await p.execute(
      `INSERT INTO api_keys (workspace_id, user_id, provider, api_key, base_url, endpoint, api_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         user_id = VALUES(user_id),
         api_key = VALUES(api_key),
         base_url = VALUES(base_url),
         endpoint = VALUES(endpoint),
         api_version = VALUES(api_version)`,
      [wsId, userId, provider, data.api_key || '', data.base_url || '', data.endpoint || '', data.api_version || '']
    )
    return apiKeys.getAll(userId)
  },

  delete: async (provider: string, userId: number | null = null) => {
    const p = await getPool()
    const wsId = userId !== null ? `user_${userId}` : 'default'
    await p.execute('DELETE FROM api_keys WHERE workspace_id = ? AND provider = ?', [wsId, provider])
  },
}

// ─── Training Runs ───
export const trainingRuns = {
  getAll: async () => {
    const p = await getPool()
    const [rows] = await p.execute('SELECT * FROM training_runs ORDER BY created_at DESC')
    return rows
  },

  getByUserId: async (userId: number | null) => {
    if (userId === null) return []
    const p = await getPool()
    const [rows] = await p.execute('SELECT * FROM training_runs WHERE user_id = ? ORDER BY created_at DESC', [userId])
    return rows
  },

  getById: async (id: string) => {
    const p = await getPool()
    const [rows] = await p.execute('SELECT * FROM training_runs WHERE id = ?', [id]) as any[]
    return rows[0] || null
  },

  getByIdAndUser: async (id: string, userId: number | null) => {
    if (userId === null) return null
    const p = await getPool()
    const [rows] = await p.execute('SELECT * FROM training_runs WHERE id = ? AND user_id = ?', [id, userId]) as any[]
    return rows[0] || null
  },

  updateState: async (id: string, state: RunState, connection?: DbConnection): Promise<boolean> => {
    return inTransaction(connection, async conn => {
      const [rows] = await conn.execute('SELECT state_json FROM training_runs WHERE id = ? FOR UPDATE', [id])
      if (!rows.length) return false
      const previous = jsonValue(rows[0].state_json) as RunState | undefined
      if (!isNewerRunState(previous, state)) return false
      await conn.execute(
        `UPDATE training_runs SET state_json = ?, status = ?, current_score = ?, best_score = ?,
          total_steps = ?, error_message = ?, artifact_sync_status = ?, artifact_sync_error = ?,
          ai_summary = IF(?, '', ai_summary) WHERE id = ?`,
        [JSON.stringify(state), state.status, state.currentScore === null ? null : state.currentScore * 100,
          state.bestScore === null ? null : state.bestScore * 100, state.completedSteps, state.error ?? '',
          state.artifactSync, state.artifactError ?? '', previous?.instanceId !== state.instanceId, id],
      )
      return true
    })
  },

  saveSummary: async (id: string, summary: string, instanceId: string | null, connection?: DbConnection): Promise<boolean> => {
    return inTransaction(connection, async conn => {
      const [rows] = await conn.execute('SELECT state_json FROM training_runs WHERE id = ? FOR UPDATE', [id])
      if (!rows.length) return false
      const state = jsonValue(rows[0].state_json) as RunState | undefined
      if ((state?.instanceId ?? null) !== instanceId) return false
      await conn.execute('UPDATE training_runs SET ai_summary = ? WHERE id = ?', [summary, id])
      return true
    })
  },

  upsert: async (data: any) => {
    const p = await getPool()
    const keys = Object.keys(data)
    const values = Object.values(data) as any[]
    const placeholders = keys.map(() => '?').join(', ')
    const updates = keys.filter(k => k !== 'id' && k !== 'created_at').map(k => `${k} = VALUES(${k})`).join(', ')
    await p.execute(
      `INSERT INTO training_runs (${keys.join(', ')}) VALUES (${placeholders})
       ON DUPLICATE KEY UPDATE ${updates}`,
      values
    )
  },

  delete: async (id: string) => {
    const p = await getPool()
    await p.execute('DELETE FROM training_runs WHERE id = ?', [id])
  },

  getCount: async () => {
    const p = await getPool()
    const [rows] = await p.execute('SELECT COUNT(*) as count FROM training_runs') as any[]
    return rows[0].count
  },
}

// ─── Step History ───
export const stepHistory = {
  getByRunId: async (runId: string) => {
    const p = await getPool()
    const [rows] = await p.execute('SELECT * FROM step_history WHERE run_id = ? ORDER BY step', [runId])
    return rows
  },

  upsert: async (runId: string, step: number, data: any) => {
    const p = await getPool()
    const [existing] = await p.execute('SELECT id FROM step_history WHERE run_id = ? AND step = ?', [runId, step]) as any[]
    if (existing.length > 0) {
      const keys = Object.keys(data)
      const sets = keys.map(k => `${k} = ?`).join(', ')
      await p.execute(`UPDATE step_history SET ${sets} WHERE id = ?`, [...keys.map(k => data[k]), existing[0].id])
    } else {
      const allData = { run_id: runId, step, ...data }
      const keys = Object.keys(allData)
      const placeholders = keys.map(() => '?').join(', ')
      await p.execute(`INSERT INTO step_history (${keys.join(', ')}) VALUES (${placeholders})`, Object.values(allData))
    }
  },

  deleteByRunId: async (runId: string) => {
    const p = await getPool()
    await p.execute('DELETE FROM step_history WHERE run_id = ?', [runId])
  },
}

// ─── Evaluation Details ───
export const evaluationDetails = {
  upsert: async (data: {
    run_id: string; step: number; phase: string; item_id: string;
    question?: string; gold_answer?: string;
    system_prompt?: string; user_prompt?: string;
    model_response?: string; extracted_answer?: string;
    is_correct?: number; score_em?: number; score_f1?: number;
    n_turns?: number; tokens_prompt?: number; tokens_completion?: number;
  }) => {
    const p = await getPool()
    await p.execute(`INSERT INTO evaluation_details 
      (run_id, step, phase, item_id, question, gold_answer, system_prompt, user_prompt, 
       model_response, extracted_answer, is_correct, score_em, score_f1, n_turns, tokens_prompt, tokens_completion)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE 
        question=VALUES(question), gold_answer=VALUES(gold_answer),
        system_prompt=VALUES(system_prompt), user_prompt=VALUES(user_prompt),
        model_response=VALUES(model_response), extracted_answer=VALUES(extracted_answer),
        is_correct=VALUES(is_correct), score_em=VALUES(score_em), score_f1=VALUES(score_f1),
        n_turns=VALUES(n_turns), tokens_prompt=VALUES(tokens_prompt), tokens_completion=VALUES(tokens_completion)`,
    [
      data.run_id, data.step, data.phase, data.item_id,
      data.question || '', data.gold_answer || '',
      data.system_prompt || '', data.user_prompt || '',
      data.model_response || '', data.extracted_answer || '',
      data.is_correct || 0, data.score_em || 0, data.score_f1 || 0,
      data.n_turns || 1, data.tokens_prompt || 0, data.tokens_completion || 0,
    ])
  },

  getByRunAndStep: async (runId: string, step: number, phase?: string) => {
    const p = await getPool()
    let sql = 'SELECT * FROM evaluation_details WHERE run_id = ? AND step = ?'
    const params: any[] = [runId, step]
    if (phase) { sql += ' AND phase = ?'; params.push(phase) }
    sql += ' ORDER BY item_id'
    const [rows] = await p.execute(sql, params)
    return rows as any[]
  },

  getSummary: async (runId: string) => {
    const p = await getPool()
    const [rows] = await p.execute(
      `SELECT phase, step, COUNT(*) as total, SUM(is_correct) as correct,
       ROUND(AVG(score_f1), 3) as avg_f1
       FROM evaluation_details WHERE run_id = ? 
       GROUP BY phase, step ORDER BY step, phase`, [runId])
    return rows as any[]
  },

  deleteByRunId: async (runId: string) => {
    const p = await getPool()
    await p.execute('DELETE FROM evaluation_details WHERE run_id = ?', [runId])
  },
}

// ─── Skill Versions ───
export const skillVersions = {
  getByRunId: async (runId: string) => {
    const p = await getPool()
    const [rows] = await p.execute('SELECT * FROM skill_versions WHERE run_id = ? ORDER BY version', [runId])
    return rows
  },

  getByRunAndVersion: async (runId: string, version: string) => {
    const p = await getPool()
    const [rows] = await p.execute('SELECT * FROM skill_versions WHERE run_id = ? AND version = ?', [runId, version]) as any[]
    return rows[0] || null
  },

  upsert: async (runId: string, version: string, data: any) => {
    const p = await getPool()
    const [existing] = await p.execute('SELECT id FROM skill_versions WHERE run_id = ? AND version = ?', [runId, version]) as any[]
    if (existing.length > 0) {
      const keys = Object.keys(data).filter(k => k !== 'run_id' && k !== 'version')
      const sets = keys.map(k => `${k} = ?`).join(', ')
      await p.execute(`UPDATE skill_versions SET ${sets} WHERE id = ?`, [...keys.map(k => data[k]), existing[0].id])
    } else {
      const allData = { run_id: runId, version, ...data }
      const keys = Object.keys(allData)
      const placeholders = keys.map(() => '?').join(', ')
      await p.execute(`INSERT INTO skill_versions (${keys.join(', ')}) VALUES (${placeholders})`, Object.values(allData))
    }
  },

  deleteByRunId: async (runId: string) => {
    const p = await getPool()
    await p.execute('DELETE FROM skill_versions WHERE run_id = ?', [runId])
  },
}

// ─── Training Data ───
export const trainingData = {
  getByRunId: async (runId: string, connection?: Pick<DbConnection, 'execute'>) => {
    const p = connection ?? await getPool()
    const [rows] = await p.execute('SELECT * FROM training_data_items WHERE run_id = ? ORDER BY split, item_index', [runId]) as any[]
    const result: any = { train: [], val: [], test: [] }
    for (const r of rows) {
      const original = jsonValue(r.item_json)
      result[r.split]?.push(original && typeof original === 'object' && !Array.isArray(original) ? original : {
        id: String(r.item_index),
        question: r.question,
        context: r.context || '',
        answers: jsonValue(r.answers_json) ?? [],
      })
    }
    return result
  },

  upsertBatch: async (runId: string, split: string, items: any[], connection?: DbConnection) => {
    if (!['train', 'val', 'test'].includes(split)) throw new Error('无效的数据集分组')
    await inTransaction(connection, conn => replaceDataSplit(conn, runId, split, items))
  },

  deleteByRunId: async (runId: string) => {
    const p = await getPool()
    await p.execute('DELETE FROM training_data_items WHERE run_id = ?', [runId])
  },
}

// ─── User Skills ───
export const userSkills = {
  getAll: async () => {
    const p = await getPool()
    const [rows] = await p.execute('SELECT * FROM user_skills ORDER BY updated_at DESC')
    return rows
  },

  getById: async (id: string) => {
    const p = await getPool()
    const [rows] = await p.execute('SELECT * FROM user_skills WHERE id = ?', [id]) as any[]
    return rows[0] || null
  },

  upsert: async (id: string, data: any) => {
    const p = await getPool()
    await p.execute(
      `INSERT INTO user_skills (id, name, content, description) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), content = VALUES(content), description = VALUES(description)`,
      [id, data.name || '', data.content || '', data.description || '']
    )
  },

  delete: async (id: string) => {
    const p = await getPool()
    await p.execute('DELETE FROM user_skills WHERE id = ?', [id])
  },
}

// ─── Templates ───
export const templates = {
  getAll: async (userId: number | null = null) => {
    const p = await getPool()
    if (userId !== null) {
      // Logged-in users: only see their own templates
      const [rows] = await p.execute('SELECT * FROM templates WHERE user_id = ? ORDER BY created_at DESC', [userId])
      return rows
    }
    // Guest: show built-in templates
    const [rows] = await p.execute('SELECT * FROM templates WHERE user_id IS NULL ORDER BY created_at DESC')
    return rows
  },

  getById: async (id: string) => {
    const p = await getPool()
    const [rows] = await p.execute('SELECT * FROM templates WHERE id = ?', [id]) as any[]
    return rows[0] || null
  },

  upsert: async (id: string, data: any) => {
    const p = await getPool()
    const keys = Object.keys(data)
    const values = Object.values(data) as any[]
    const placeholders = keys.map(() => '?').join(', ')
    const updates = keys.filter(k => k !== 'id' && k !== 'created_at').map(k => `${k} = VALUES(${k})`).join(', ')
    await p.execute(
      `INSERT INTO templates (${keys.join(', ')}) VALUES (${placeholders})
       ON DUPLICATE KEY UPDATE ${updates}`,
      values
    )
  },

  delete: async (id: string) => {
    const p = await getPool()
    await p.execute('DELETE FROM templates WHERE id = ?', [id])
  },
}

// ─── Migration from old file-based storage ───
export async function migrateFromFiles() {
  const p = await getPool()
  const [rows] = await p.execute('SELECT COUNT(*) as count FROM training_runs') as any[]
  if (rows[0].count > 0) {
    console.log('[DB] Migration skipped: data already exists')
    return
  }

  const OUTPUTS_DIR = join(process.cwd(), '..', 'outputs')
  console.log('[DB] Starting migration from file storage...')

  if (!existsSync(OUTPUTS_DIR)) {
    console.log('[DB] No outputs directory found, skipping migration')
    return
  }

  let migrated = 0
  try {
    const dirs = readdirSync(OUTPUTS_DIR)
    for (const dir of dirs) {
      try {
        const dirPath = join(OUTPUTS_DIR, dir)
        if (!statSync(dirPath).isDirectory()) continue

        let summary: any = {}
        try { summary = JSON.parse(readFileSync(join(dirPath, 'summary.json'), 'utf-8')) } catch {}
        let config: any = {}
        try { config = JSON.parse(readFileSync(join(dirPath, 'config.json'), 'utf-8')) } catch {}
        let history: any[] = []
        try { history = JSON.parse(readFileSync(join(dirPath, 'history.json'), 'utf-8')) } catch {}
        let runtimeState: any = {}
        try { runtimeState = JSON.parse(readFileSync(join(dirPath, 'runtime_state.json'), 'utf-8')) } catch {}

        let trainingName = dir.replace(/^skillopt_\w+_/, '').replace(/_\d{8}_\d{6}$/, '')
        try {
          const n = readFileSync(join(dirPath, 'training_name.txt'), 'utf-8').trim()
          if (n) trainingName = n
        } catch {}

        const totalSteps = summary.total_steps || history.length
        let accepts = 0, rejects = 0, skips = 0
        history.forEach((h: any) => {
          if (h.action === 'accept') accepts++
          else if (h.action === 'reject') rejects++
          else skips++
        })

        let status = 'completed'
        if (runtimeState?.status === 'running') status = 'training'
        if (runtimeState?.status === 'pending') status = 'pending'
        try {
          const s = JSON.parse(readFileSync(join(dirPath, 'summary.json'), 'utf-8'))
          if (s.error || s.status === 'failed') status = 'failed'
        } catch {}

        let initialScore = 0
        if (history.length > 0) {
          const score = history[0].rollout_hard ?? history[0].rollout_soft ?? 0
          if (score > 0) initialScore = Math.round(score * 100)
        }
        if (initialScore === 0 && summary.baseline_selection_hard) initialScore = Math.round(summary.baseline_selection_hard * 100)

        let currentScore = 0, bestScore = 0
        if (history.length > 0) {
          const last = history[history.length - 1]
          currentScore = Math.round((last.current_score || 0) * 100)
          bestScore = Math.round((last.best_score || 0) * 100)
        }

        let totalTime = ''
        if (summary.wall_time_s) {
          const s = summary.wall_time_s
          totalTime = s < 60 ? `${s.toFixed(0)}s` : s < 3600 ? `${Math.floor(s / 60)}m ${(s % 60).toFixed(0)}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
        }

        const avgPerStep = totalSteps > 0 ? `${(summary.wall_time_s / totalSteps).toFixed(1)}s` : ''
        const acceptRate = totalSteps > 0 ? Math.round((accepts / totalSteps) * 100) : 0

        await trainingRuns.upsert({
          id: dir,
          name: trainingName,
          env: config.env?.name || '',
          model: config.model || '',
          status,
          current_score: currentScore,
          best_score: bestScore,
          initial_score: initialScore,
          accept_rate: acceptRate,
          total_steps: totalSteps,
          accepts, rejects, skips,
          total_time: totalTime,
          avg_per_step: avgPerStep,
          epochs: config.epochs || 2,
          batch_size: config.batch_size || 4,
          edit_budget: config.edit_budget || 3,
          slow_update: config.slow_update ? 1 : 0,
          config_json: JSON.stringify(config),
          summary_json: JSON.stringify(summary),
          token_usage_json: JSON.stringify(summary.token_usage || {}),
        })

        // History
        await stepHistory.deleteByRunId(dir)
        history.forEach((h: any, idx: number) => {
          stepHistory.upsert(dir, h.step || idx + 1, {
            epoch: h.epoch || 1, step_in_epoch: h.step_in_epoch || 0,
            action: h.action || 'skip', raw_action: h.raw_action || '',
            current_score: h.current_score || 0, best_score: h.best_score || 0,
            rollout_hard: h.rollout_hard || 0, rollout_soft: h.rollout_soft || 0,
            selection_hard: h.selection_hard || 0, selection_soft: h.selection_soft || 0,
            n_patches: h.n_patches || 0, n_success_patches: h.n_success_patches || 0,
            wall_time_s: h.wall_time_s || 0, skill_len: h.skill_len || 0,
            tokens_json: JSON.stringify(h.tokens || {}),
            timing_json: JSON.stringify(h.timing || {}),
          })
        })

        // Skill versions
        await skillVersions.deleteByRunId(dir)
        const skillsDir = join(dirPath, 'skills')
        if (existsSync(skillsDir)) {
          for (const f of readdirSync(skillsDir).filter(f => f.endsWith('.md'))) {
            const m = f.match(/skill_vv?(\d+)\.md/)
            if (!m) continue
            const content = readFileSync(join(skillsDir, f), 'utf-8')
            await skillVersions.upsert(dir, m[1].padStart(4, '0'), {
              name: f, path: `skills/${f}`, chars: content.length, content,
              timestamp: new Date().toISOString(),
            })
          }
        }
        for (const { v, p: fp } of [{ v: 'best', p: join(dirPath, 'best_skill.md') }, { v: 'initial', p: join(dirPath, 'data', 'initial_skill.md') }]) {
          if (existsSync(fp)) {
            const content = readFileSync(fp, 'utf-8')
            await skillVersions.upsert(dir, v, {
              name: `${v}_skill.md`, path: fp.replace(dirPath + '/', ''),
              chars: content.length, content, timestamp: new Date().toISOString(),
            })
          }
        }

        migrated++
      } catch (e: any) {
        console.error(`[DB] Failed migrate run ${dir}:`, e.message)
      }
    }
    console.log(`[DB] Migrated ${migrated} training runs`)
  } catch (e: any) {
    console.error('[DB] Migration error:', e.message)
  }
}

export interface DbConnection {
  execute(sql: string, values?: any[]): Promise<[any, any]>
  beginTransaction(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
  release(): void
}

function jsonValue(value: any): any {
  return typeof value === 'string' ? JSON.parse(value) : value ?? undefined
}

async function inTransaction<T>(provided: DbConnection | undefined, work: (connection: DbConnection) => Promise<T>): Promise<T> {
  const connection = provided ?? await (await getPool()).getConnection()
  let started = false
  try {
    await connection.beginTransaction()
    started = true
    const result = await work(connection)
    await connection.commit()
    return result
  } catch (error) {
    if (started) {
      try { await connection.rollback() } catch { /* Preserve the original database error. */ }
    }
    throw error
  } finally {
    if (!provided) connection.release()
  }
}

const terminalStatuses = new Set(['completed', 'failed', 'stopped', 'empty'])

export function isNewerRunState(previous: RunState | undefined | null, incoming: RunState): boolean {
  if (!incoming.instanceId || !Number.isSafeInteger(incoming.attempt) || incoming.attempt < 0 ||
      !Number.isSafeInteger(incoming.version) || incoming.version < 0 ||
      !Number.isSafeInteger(incoming.completedSteps) || incoming.completedSteps < 0 ||
      !Number.isSafeInteger(incoming.totalSteps) || incoming.totalSteps < incoming.completedSteps ||
      !Number.isSafeInteger(incoming.currentStep) || incoming.currentStep < 0 ||
      !['pending', 'training', 'completed', 'failed', 'stopped', 'empty'].includes(incoming.status) ||
      !['pending', 'syncing', 'synced', 'failed'].includes(incoming.artifactSync) ||
      [incoming.currentScore, incoming.bestScore].some(score => score !== null && (!Number.isFinite(score) || score < 0 || score > 1))) {
    throw new Error('无效的训练状态')
  }
  if (!previous) return true
  if (incoming.attempt > previous.attempt) return true
  if (incoming.attempt !== previous.attempt || incoming.instanceId !== previous.instanceId || incoming.version <= previous.version) return false
  if (terminalStatuses.has(previous.status) && (incoming.status !== previous.status || incoming.phase !== previous.phase)) return false
  return incoming.completedSteps >= previous.completedSteps
}

async function insertRows(connection: DbConnection, table: string, columns: string[], rows: any[][], updateKeys?: string[]): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += 100) {
    const batch = rows.slice(offset, offset + 100)
    const placeholders = batch.map(() => `(${columns.map(() => '?').join(',')})`).join(',')
    const updates = updateKeys?.length ? ` ON DUPLICATE KEY UPDATE ${updateKeys.map(key => `\`${key}\`=VALUES(\`${key}\`)`).join(',')}` : ''
    await connection.execute(`INSERT INTO \`${table}\` (${columns.map(key => `\`${key}\``).join(',')}) VALUES ${placeholders}${updates}`, batch.flat())
  }
}

async function replaceDataSplit(connection: DbConnection, runId: string, split: string, items: JsonObject[]): Promise<void> {
  await connection.execute('DELETE FROM training_data_items WHERE run_id = ? AND split = ?', [runId, split])
  await insertRows(connection, 'training_data_items', ['run_id', 'split', 'item_index', 'question', 'context', 'answers_json', 'item_json'],
    items.map((item, index) => [runId, split, index, item.question ?? '', item.context ?? '', JSON.stringify(item.answers ?? []), JSON.stringify(item)]))
}

export async function replaceRunArtifacts(runId: string, snapshot: RunArtifactsSnapshot, connection?: DbConnection) {
  if (snapshot.runId !== runId) throw new Error('产物与任务ID不匹配')
  const counts = {
    history: snapshot.history?.length ?? null,
    skills: snapshot.skills?.length ?? null,
    data: Object.fromEntries(Object.entries(snapshot.data).map(([split, items]) => [split, items?.length ?? 0])),
    evaluations: snapshot.evaluations?.length ?? null,
  }
  return inTransaction(connection, async conn => {
    const [runs] = await conn.execute('SELECT id FROM training_runs WHERE id = ? FOR UPDATE', [runId])
    if (!runs.length) throw new Error('训练任务不存在')
    const metadata: Record<string, any> = {}
    if (snapshot.config !== undefined) metadata.config_json = JSON.stringify(snapshot.config)
    if (snapshot.trainConfig !== undefined) metadata.train_config_json = JSON.stringify(snapshot.trainConfig)
    if (snapshot.summary !== undefined) metadata.summary_json = JSON.stringify(snapshot.summary)
    if (snapshot.tokenUsage !== undefined) metadata.token_usage_json = JSON.stringify(snapshot.tokenUsage)
    const summary = snapshot.summary
    for (const [source, target] of [['baseline_selection_hard', 'initial_score'], ['baseline_test_hard', 'baseline_test_score'], ['test_hard', 'test_score']] as const) {
      if (typeof summary?.[source] === 'number') metadata[target] = summary[source] * 100
    }
    if (snapshot.history !== undefined) {
      metadata.accepts = snapshot.history.filter(row => String(row.action ?? '').includes('accept')).length
      metadata.rejects = snapshot.history.filter(row => row.action === 'reject').length
      metadata.skips = snapshot.history.length - metadata.accepts - metadata.rejects
      metadata.accept_rate = snapshot.history.length ? Math.round(metadata.accepts / snapshot.history.length * 100) : 0
      metadata.slow_updates = snapshot.history.filter(row => row.slow_update).length
    }
    const wallTime = summary?.total_wall_time_s ?? summary?.wall_time_s
    if (typeof wallTime === 'number') {
      metadata.total_time = `${wallTime.toFixed(1)}s`
      if (snapshot.history?.length) metadata.avg_per_step = `${(wallTime / snapshot.history.length).toFixed(1)}s`
    }
    if (Object.keys(metadata).length) {
      await conn.execute(`UPDATE training_runs SET ${Object.keys(metadata).map(key => `\`${key}\` = ?`).join(', ')} WHERE id = ?`, [...Object.values(metadata), runId])
    }
    if (snapshot.history !== undefined) {
      await conn.execute('DELETE FROM step_history WHERE run_id = ?', [runId])
      const columns = ['run_id', 'step', 'epoch', 'step_in_epoch', 'action', 'raw_action', 'current_score', 'best_score', 'rollout_hard', 'rollout_soft', 'selection_hard', 'selection_soft', 'n_patches', 'n_success_patches', 'wall_time_s', 'skill_len', 'tokens_json', 'timing_json', 'candidate_skill']
      await insertRows(conn, 'step_history', columns, snapshot.history.map(row => [
        runId, row.step, row.epoch ?? 1, row.step_in_epoch ?? 0, row.action ?? 'skip', row.raw_action ?? row.action ?? '',
        row.current_score ?? null, row.best_score ?? null, row.rollout_hard ?? null, row.rollout_soft ?? null,
        row.selection_hard ?? null, row.selection_soft ?? null, row.n_patches ?? 0, row.n_success_patches ?? 0,
        row.wall_time_s ?? 0, row.skill_len ?? 0, JSON.stringify(row.tokens ?? {}), JSON.stringify(row.timing ?? {}), row.candidate_skill ?? '',
      ]))
    }
    if (snapshot.skills !== undefined) {
      const columns = ['run_id', 'version', 'name', 'path', 'chars', 'content', 'timestamp']
      await insertRows(conn, 'skill_versions', columns, snapshot.skills.map(skill => [runId, skill.version, skill.name, skill.path, skill.chars, skill.content, skill.timestamp]), columns.slice(2))
    }
    for (const split of ['train', 'val', 'test'] as const) {
      const items = snapshot.data[split]
      if (items !== undefined) await replaceDataSplit(conn, runId, split, items)
    }
    if (snapshot.evaluations !== undefined) {
      const columns = ['run_id', 'step', 'phase', 'item_id', 'question', 'gold_answer', 'system_prompt', 'user_prompt', 'model_response', 'extracted_answer', 'is_correct', 'score_em', 'score_f1', 'n_turns', 'tokens_prompt', 'tokens_completion']
      await insertRows(conn, 'evaluation_details', columns, snapshot.evaluations.map(row => [
        runId, row.step, row.phase, row.item_id, row.question, row.gold_answer, row.system_prompt, row.user_prompt,
        row.model_response, row.extracted_answer, row.is_correct, row.score_em, row.score_f1, row.n_turns, row.tokens_prompt, row.tokens_completion,
      ]), columns.slice(4))
    }
    await conn.execute("UPDATE training_runs SET artifact_sync_status = 'synced', artifact_sync_error = '' WHERE id = ?", [runId])
    return counts
  })
}

export { getPool as getConnection }

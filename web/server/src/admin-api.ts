import { Router } from 'express'
import type { PoolConnection } from 'mysql2/promise'
import { requireAuth } from './auth.js'
import { getConnection } from './db.js'

interface AdminOptions {
  withRunsLocked: (ids: string[], operation: () => Promise<void>) => Promise<void>
}

const adminOnly = (req: any, res: any, next: any) => {
  if (req.user?.is_admin !== 1) return res.status(403).json({ error: '需要管理员权限' })
  next()
}

async function withConnection<T>(work: (connection: PoolConnection) => Promise<T>): Promise<T> {
  const connection = await (await getConnection()).getConnection()
  try { return await work(connection) } finally { connection.release() }
}

export function registerAdminRoutes(app: any, options: AdminOptions) {
  const router = Router()
  router.use(requireAuth)
  router.use(adminOnly)
  const tables = ['training_runs', 'templates', 'step_history', 'skill_versions', 'training_data_items', 'training_logs', 'evaluation_details', 'user_skills', 'users']
  const runTables = new Set(['training_runs', 'step_history', 'skill_versions', 'training_data_items', 'training_logs', 'evaluation_details'])
  const fail = (res: any, error: any) => res.status(error.status || 500).json({ error: error.status ? error.message : '数据库操作失败' })

  router.get('/table/:table', async (req: any, res) => {
    const table = req.params.table
    if (!tables.includes(table)) return res.status(400).json({ error: 'Invalid table' })
    const limit = Math.max(1, Math.min(parseInt(req.query.limit as string) || 500, 500))
    try {
      const rows = await withConnection(async connection => {
        const [rows] = await connection.execute(`SELECT * FROM \`${table}\` ORDER BY id DESC LIMIT ${limit}`)
        return rows
      })
      res.json(rows)
    } catch (error) { fail(res, error) }
  })

  router.get('/table/:table/:id', async (req: any, res) => {
    const table = req.params.table
    if (!tables.includes(table)) return res.status(400).json({ error: 'Invalid table' })
    try {
      const row = await withConnection(async connection => {
        const [rows] = await connection.execute(`SELECT * FROM \`${table}\` WHERE id = ?`, [req.params.id]) as any[]
        return rows[0]
      })
      if (!row) return res.status(404).json({ error: 'Not found' })
      res.json(row)
    } catch (error) { fail(res, error) }
  })

  router.delete('/table/:table/:id', async (req: any, res) => {
    const table = req.params.table
    if (!tables.includes(table)) return res.status(400).json({ error: 'Invalid table' })
    if (table === 'training_runs') return res.status(409).json({ error: '请通过训练管理删除任务，避免丢失产物与状态' })
    try {
      await withConnection(async connection => {
        const [rows] = await connection.execute(`SELECT * FROM \`${table}\` WHERE id = ?`, [req.params.id]) as any[]
        if (!rows[0]) throw Object.assign(new Error('Not found'), { status: 404 })
        if (table === 'users') {
          const [runs] = await connection.execute('SELECT id FROM training_runs WHERE user_id = ?', [req.params.id]) as any[]
          if (runs.length) throw Object.assign(new Error('用户仍有训练任务，请先通过训练管理逐个处理，不能级联删除'), { status: 409 })
          await connection.beginTransaction()
          try {
            await connection.execute('DELETE FROM templates WHERE user_id = ?', [req.params.id])
            await connection.execute('DELETE FROM api_keys WHERE user_id = ?', [req.params.id])
            await connection.execute('DELETE FROM users WHERE id = ?', [req.params.id])
            await connection.commit()
          } catch (error) { await connection.rollback(); throw error }
          return
        }
        const ids = runTables.has(table) ? [table === 'training_runs' ? String(rows[0].id) : String(rows[0].run_id)] : []
        await options.withRunsLocked(ids, async () => {
          await connection.execute(`DELETE FROM \`${table}\` WHERE id = ?`, [req.params.id])
        })
      })
      res.json({ success: true })
    } catch (error) { fail(res, error) }
  })

  router.put('/table/:table/:id', async (req: any, res) => {
    const table = req.params.table
    if (!tables.includes(table)) return res.status(400).json({ error: 'Invalid table' })
    if (runTables.has(table)) return res.status(409).json({ error: '训练状态与产物只允许通过训练接口更新' })
    const data = req.body
    if (!data || typeof data !== 'object' || Array.isArray(data)) return res.status(400).json({ error: 'No data' })
    const keys = Object.keys(data).filter(key => key !== 'id')
    if (!keys.length || keys.some(key => !/^[a-z][a-z0-9_]*$/.test(key))) return res.status(400).json({ error: 'Invalid fields' })
    try {
      await withConnection(async connection => {
        const [columns] = await connection.execute(`SHOW COLUMNS FROM \`${table}\``) as any[]
        if (keys.some(key => !columns.some((column: any) => column.Field === key))) throw Object.assign(new Error('Invalid fields'), { status: 400 })
        await connection.execute(`UPDATE \`${table}\` SET ${keys.map(key => `\`${key}\` = ?`).join(', ')} WHERE id = ?`, [...keys.map(key => data[key]), req.params.id])
      })
      res.json({ success: true })
    } catch (error) { fail(res, error) }
  })

  router.post('/reset-password', async (req: any, res) => {
    const { user_id, password } = req.body
    if (!user_id || typeof password !== 'string' || password.length < 6) return res.status(400).json({ error: '密码至少6位，并需指定用户' })
    try {
      const bcrypt = await import('bcryptjs')
      const hash = await bcrypt.hash(password, 10)
      await withConnection(connection => connection.execute('UPDATE users SET password_hash = ? WHERE id = ?', [hash, user_id]))
      res.json({ success: true })
    } catch (error) { fail(res, error) }
  })

  router.post('/users', async (req: any, res) => {
    const { phone, password, is_admin } = req.body
    if (!phone || typeof password !== 'string' || password.length < 6) return res.status(400).json({ error: 'phone required; password must contain at least 6 characters' })
    try {
      const bcrypt = await import('bcryptjs')
      const hash = await bcrypt.hash(password, 10)
      const id = await withConnection(async connection => {
        const [result] = await connection.execute('INSERT INTO users (phone, password_hash, is_admin) VALUES (?, ?, ?)', [phone, hash, is_admin ? 1 : 0]) as any[]
        return result.insertId
      })
      res.json({ id, phone, is_admin: is_admin ? 1 : 0 })
    } catch (error) { fail(res, error) }
  })

  router.get('/db-summary', async (_req: any, res) => {
    try {
      const result = await withConnection(async connection => {
        const counts: Record<string, number> = {}
        for (const table of tables) {
          const [rows] = await connection.execute(`SELECT COUNT(*) AS cnt FROM \`${table}\``) as any[]
          counts[table] = rows[0].cnt
        }
        return counts
      })
      res.json(result)
    } catch (error) { fail(res, error) }
  })

  router.post('/sql', async (req: any, res) => {
    const sql = req.body?.sql
    if (typeof sql !== 'string' || !/^(SELECT|SHOW|DESCRIBE|EXPLAIN)\b/i.test(sql.trim()) || /\bINTO\s+(OUTFILE|DUMPFILE)\b/i.test(sql)) {
      return res.status(400).json({ error: '仅支持只读查询' })
    }
    try {
      const rows = await withConnection(async connection => {
        const [rows] = await connection.execute(sql)
        return rows
      })
      res.json(rows)
    } catch (error) { fail(res, error) }
  })

  app.use('/api/admin', router)
}

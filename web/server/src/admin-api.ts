// Admin CRUD API handlers
import { Router } from 'express'
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'dev-secret')
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || ''

const authMiddleware = (req: any, res: any, next: any) => {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: '未登录' })
  try { req.user = jwt.verify(header.slice(7), JWT_SECRET); next() }
  catch { res.status(401).json({ error: '登录已过期' }) }
}

const adminOnly = (req: any, res: any, next: any) => {
  if (!req.user?.is_admin) return res.status(403).json({ error: '需要管理员权限' })
  next()
}

async function getConn() {
  const { default: mysql2 } = await import('mysql2/promise')
  return mysql2.createConnection({ host:'127.0.0.1', port:3306, user:'root', password: MYSQL_PASSWORD, database:'skillopt' })
}

export function registerAdminRoutes(app: any) {
  const router = Router()
  router.use(authMiddleware)
  router.use(adminOnly)

  // Allowed tables for direct CRUD
  const tables = ['training_runs', 'templates', 'step_history', 'skill_versions', 'training_data_items', 'training_logs', 'evaluation_details', 'user_skills', 'users']

  // List table data
  router.get('/table/:table', async (req: any, res) => {
    const table = req.params.table
    if (!tables.includes(table)) return res.status(400).json({ error: 'Invalid table' })
    const limit = Math.min(parseInt(req.query.limit as string) || 500, 500)
    try {
      const p = await getConn()
      const col = table === 'training_logs' || table === 'evaluation_details' ? 'id' : 'id'
      const [rows] = await p.execute(`SELECT * FROM \`${table}\` ORDER BY \`${col}\` DESC LIMIT ${limit}`)
      await p.end()
      res.json(rows)
    } catch (e: any) { res.status(500).json({ error: e.message }) }
  })

  // Get single row
  router.get('/table/:table/:id', async (req: any, res) => {
    const table = req.params.table
    if (!tables.includes(table)) return res.status(400).json({ error: 'Invalid table' })
    try {
      const p = await getConn()
      const [rows] = await p.execute(`SELECT * FROM \`${table}\` WHERE id = ?`, [req.params.id]) as any[]
      await p.end()
      if (rows.length === 0) return res.status(404).json({ error: 'Not found' })
      res.json(rows[0])
    } catch (e: any) { res.status(500).json({ error: e.message }) }
  })

  // Delete row (with cascade for users)
  router.delete('/table/:table/:id', async (req: any, res) => {
    const table = req.params.table
    if (!tables.includes(table)) return res.status(400).json({ error: 'Invalid table' })
    try {
      const p = await getConn()
      // Cascade: deleting a user removes all their data
      if (table === 'users') {
        const userId = parseInt(req.params.id)
        // Find all training runs owned by this user
        const [runs] = await p.execute('SELECT id FROM training_runs WHERE user_id = ?', [userId]) as any[]
        for (const run of runs) {
          await p.execute('DELETE FROM step_history WHERE run_id = ?', [run.id])
          await p.execute('DELETE FROM skill_versions WHERE run_id = ?', [run.id])
          await p.execute('DELETE FROM training_data_items WHERE run_id = ?', [run.id])
          await p.execute('DELETE FROM training_logs WHERE run_id = ?', [run.id])
          await p.execute('DELETE FROM evaluation_details WHERE run_id = ?', [run.id])
        }
        await p.execute('DELETE FROM training_runs WHERE user_id = ?', [userId])
        await p.execute('DELETE FROM templates WHERE user_id = ?', [userId])
        await p.execute('DELETE FROM api_keys WHERE workspace_id = ?', [`user_${userId}`])
        await p.execute('DELETE FROM user_skills WHERE user_id = ?', [userId])
        await p.execute('DELETE FROM users WHERE id = ?', [userId])
      } else {
        await p.execute(`DELETE FROM \`${table}\` WHERE id = ?`, [req.params.id])
      }
      await p.end()
      res.json({ success: true })
    } catch (e: any) { res.status(500).json({ error: e.message }) }
  })

  // Update row
  router.put('/table/:table/:id', async (req: any, res) => {
    const table = req.params.table
    if (!tables.includes(table)) return res.status(400).json({ error: 'Invalid table' })
    const data = req.body
    if (!data || Object.keys(data).length === 0) return res.status(400).json({ error: 'No data' })
    // Remove protected fields
    delete data.id
    try {
      const p = await getConn()
      const keys = Object.keys(data)
      const sets = keys.map(k => `\`${k}\` = ?`).join(', ')
      const values = Object.values(data)
      await p.execute(`UPDATE \`${table}\` SET ${sets} WHERE id = ?`, [...values, req.params.id])
      await p.end()
      res.json({ success: true })
    } catch (e: any) { res.status(500).json({ error: e.message }) }
  })

  // Reset password
  router.post('/reset-password', async (req: any, res) => {
    const { user_id, password } = req.body
    if (!user_id || !password) return res.status(400).json({ error: 'user_id and password required' })
    try {
      const bcrypt = await import('bcryptjs')
      const hash = await bcrypt.hash(password, 10)
      const p = await getConn()
      await p.execute('UPDATE users SET password_hash = ? WHERE id = ?', [hash, user_id])
      await p.end()
      res.json({ success: true })
    } catch (e: any) { res.status(500).json({ error: e.message }) }
  })

  // Create user
  router.post('/users', async (req: any, res) => {
    const { phone, password, is_admin } = req.body
    if (!phone || !password) return res.status(400).json({ error: 'phone and password required' })
    try {
      const bcrypt = await import('bcryptjs')
      const hash = await bcrypt.hash(password, 10)
      const p = await getConn()
      const [result] = await p.execute('INSERT INTO users (phone, password_hash, is_admin) VALUES (?, ?, ?)', [phone, hash, is_admin ? 1 : 0]) as any
      await p.end()
      res.json({ id: result.insertId, phone, is_admin: is_admin ? 1 : 0 })
    } catch (e: any) { res.status(500).json({ error: e.message }) }
  })

  // DB summary
  router.get('/db-summary', async (_req: any, res) => {
    try {
      const p = await getConn()
      const result: Record<string, number> = {}
      for (const t of tables) {
        const [rows] = await p.execute(`SELECT COUNT(*) as cnt FROM \`${t}\``) as any[]
        result[t] = rows[0].cnt
      }
      await p.end()
      res.json(result)
    } catch (e: any) { res.status(500).json({ error: e.message }) }
  })

  // Run raw SQL (read-only: SELECT only)
  router.post('/sql', async (req: any, res) => {
    const { sql } = req.body
    if (!sql || typeof sql !== 'string') return res.status(400).json({ error: 'Invalid SQL' })
    const trimmed = sql.trim().toUpperCase()
    if (!trimmed.startsWith('SELECT') && !trimmed.startsWith('SHOW') && !trimmed.startsWith('DESCRIBE') && !trimmed.startsWith('EXPLAIN')) {
      return res.status(400).json({ error: '仅支持 SELECT 查询' })
    }
    try {
      const p = await getConn()
      const [rows] = await p.execute(sql)
      await p.end()
      res.json(rows)
    } catch (e: any) { res.status(500).json({ error: e.message }) }
  })

  app.use('/api/admin', router)
}

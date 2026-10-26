import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { EventEmitter } from 'node:events'
import { trainingRuns, trainingData } from '../src/db.js'
import jwt from 'jsonwebtoken'
import { users } from '../src/db.js'

const testSecret = 'offline-auth-test-secret-with-at-least-32-characters'
const previousSecret = process.env.JWT_SECRET
process.env.JWT_SECRET = testSecret
const { authenticateToken, canAccessRun, requireAuth, signToken, verifyToken } = await import('../src/auth.js')
if (previousSecret === undefined) delete process.env.JWT_SECRET
else process.env.JWT_SECRET = previousSecret

async function withUser(user: any, work: () => Promise<void>) {
  const original = users.findById
  users.findById = async () => user
  try { await work() } finally { users.findById = original }
}

test('tokens are validated and administrator rights come from the current database user', async () => {
  await withUser({ id: 7, phone: 'test', is_admin: 0 }, async () => {
    const forgedRole = jwt.sign({ id: 7, is_admin: 1 }, testSecret, { algorithm: 'HS256', expiresIn: '1h' })
    assert.equal((await authenticateToken(forgedRole)).is_admin, 0)
    const signed = signToken({ id: 7, phone: 'test' })
    assert.equal(verifyToken(signed).id, 7)
    assert.equal(verifyToken(signed).is_admin, undefined)
  })
  await withUser({ id: 7, phone: 'test', is_admin: 1 }, async () => {
    assert.equal((await authenticateToken(signToken({ id: 7 }))).is_admin, 1)
  })
})

test('missing users, malformed identities, expired tokens and other algorithms are rejected', async () => {
  await withUser(null, async () => {
    await assert.rejects(authenticateToken(signToken({ id: 7 })), /用户不存在/)
  })
  for (const token of [
    jwt.sign({ id: -1 }, testSecret),
    jwt.sign({ id: '7' }, testSecret),
    jwt.sign({ id: 7, exp: 1 }, testSecret),
    jwt.sign({ id: 7 }, testSecret, { algorithm: 'HS384' }),
    jwt.sign({ id: 7, is_admin: 1 }, 'dev-secret'),
    jwt.sign({ id: 7 }, testSecret),
    '',
  ]) assert.throws(() => verifyToken(token))
})

test('run access permits only owners and administrators, including unowned legacy runs', () => {
  const user = { id: 7, phone: 'test', is_admin: 0 }
  assert.equal(canAccessRun(null, { user_id: null }), false)
  assert.equal(canAccessRun(user, { user_id: null }), false)
  assert.equal(canAccessRun(user, { user_id: 8 }), false)
  assert.equal(canAccessRun(user, { user_id: 7 }), true)
  assert.equal(canAccessRun({ ...user, is_admin: 1 }, { user_id: null }), true)
  assert.equal(canAccessRun({ ...user, is_admin: 1 }, null), false)
})

test('a local process without a configured strong key does not accept another process token', () => {
  const executable = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url))
  const module = fileURLToPath(new URL('../src/auth.ts', import.meta.url))
  const env = { ...process.env, JWT_SECRET: '', NODE_ENV: 'test' }
  const create = spawnSync(executable, ['-e', `import { signToken } from ${JSON.stringify(module)}; console.log(signToken({id:7}))`], { env, encoding: 'utf8' })
  assert.equal(create.status, 0, create.stderr)
  const token = create.stdout.trim()
  const verify = spawnSync(executable, ['-e', `import { verifyToken } from ${JSON.stringify(module)}; try { verifyToken(${JSON.stringify(token)}); process.exit(1) } catch { process.exit(0) }`], { env, encoding: 'utf8' })
  assert.equal(verify.status, 0, verify.stderr)
})

test('anonymous requests are rejected before reaching their handler', async () => {
  let code = 0
  let payload: any
  let next = false
  const response = { status(value: number) { code = value; return this }, json(value: any) { payload = value; return this } }
  await requireAuth({ headers: {} } as any, response as any, (() => { next = true }) as any)
  assert.equal(code, 401)
  assert.deepEqual(payload, { error: '未登录' })
  assert.equal(next, false)
})

process.env.SKILLOPT_DISABLE_LISTEN = '1'
process.env.SKILLOPT_DISABLE_STARTUP_SYNC = '1'
process.env.DOTENV_CONFIG_PATH = '/dev/null'
const { app, wss, publishRun } = await import('../src/index.js')

function request(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const socket = new Socket()
    const req = new IncomingMessage(socket) as any
    req.method = method
    req.url = path
    req.body = body
    req.headers = token ? { authorization: `Bearer ${token}` } : {}
    const res = new ServerResponse(req)
    res.end = ((chunk?: any) => {
      socket.destroy()
      const text = chunk == null ? '' : String(chunk)
      try { resolve({ status: res.statusCode, body: JSON.parse(text) }) }
      catch { resolve({ status: res.statusCode, body: text }) }
      return res
    }) as any
    app.handle(req, res, (error?: any) => { socket.destroy(); reject(error ?? new Error('No route matched')) })
  })
}

async function withRuns(work: (tokens: { a: string; b: string; admin: string }) => Promise<void>) {
  const originalUsers = users.findById
  const originalRun = trainingRuns.getById
  const originalData = trainingData.getByRunId
  users.findById = async id => ({ id, phone: 'offline', is_admin: id === 9 ? 1 : 0 })
  trainingRuns.getById = async id => id === 'missing' ? null : { id, user_id: id === 'unowned' ? null : 7, status: 'completed', total_steps: 2, current_score: 20, best_score: 30 }
  trainingData.getByRunId = async () => ({ train: [{ id: 'private-data' }], val: [], test: [] })
  try { await work({ a: signToken({ id: 7 }), b: signToken({ id: 8 }), admin: signToken({ id: 9 }) }) }
  finally { users.findById = originalUsers; trainingRuns.getById = originalRun; trainingData.getByRunId = originalData }
}

test('all private entry points reject anonymous requests without touching database or processes', async () => {
  for (const [method, path] of [
    ['GET', '/api/runs'], ['GET', '/api/runs/run_a'], ['GET', '/api/runs/run_a/data'],
    ['POST', '/api/train'], ['POST', '/api/train/run_a/stop'], ['POST', '/api/train/run_a/restart'],
    ['DELETE', '/api/runs/run_a'], ['GET', '/api/settings/api-keys'], ['POST', '/api/chat'],
    ['POST', '/api/runs/run_a/generate-summary'], ['GET', '/api/admin/db-summary'],
  ]) assert.equal((await request(method, path)).status, 401, path)
})

test('run guards cover subresources, lifecycle operations and unowned legacy tasks', async () => {
  await withRuns(async tokens => {
    assert.equal((await request('GET', '/api/runs/run_a', tokens.a)).status, 200)
    assert.equal((await request('GET', '/api/runs/run_a/data', tokens.a)).body.train[0].id, 'private-data')
    for (const [method, path] of [
      ['GET', '/api/runs/run_a'], ['GET', '/api/runs/run_a/history'], ['GET', '/api/runs/run_a/config'],
      ['GET', '/api/runs/run_a/data'], ['GET', '/api/runs/run_a/logs'], ['GET', '/api/runs/run_a/skills/best'],
      ['GET', '/api/runs/run_a/steps/1/record'], ['GET', '/api/runs/run_a/evaluations'],
      ['POST', '/api/runs/run_a/generate-summary'], ['POST', '/api/runs/run_a/chat'],
      ['POST', '/api/train/run_a/stop'], ['POST', '/api/train/run_a/restart'], ['DELETE', '/api/runs/run_a'],
    ]) assert.equal((await request(method, path, tokens.b)).status, 404, path)
    assert.equal((await request('GET', '/api/runs/unowned', tokens.a)).status, 404)
    assert.equal((await request('GET', '/api/runs/unowned', tokens.admin)).status, 200)
    assert.equal((await request('GET', '/api/runs/missing', tokens.admin)).status, 404)
    assert.equal((await request('GET', '/api/runs/run_a/steps/not-a-number/record', tokens.a)).status, 400)
    assert.equal((await request('DELETE', '/api/admin/table/training_runs/run_a', tokens.admin)).status, 409)
    assert.equal((await request('PUT', '/api/admin/table/training_runs/run_a', tokens.admin, { status: 'completed' })).status, 409)
  })
})

class FakeWebSocket extends EventEmitter {
  readyState = 1
  sent: any[] = []
  close() { this.readyState = 3; this.emit('close') }
  send(value: string) { this.sent.push(JSON.parse(value)) }
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

test('websocket authentication precedes every private message and broadcasts respect current ownership', async () => {
  await withRuns(async tokens => {
    const a = new FakeWebSocket(), b = new FakeWebSocket(), admin = new FakeWebSocket(), guest = new FakeWebSocket()
    const sockets = [a, b, admin, guest]
    try {
      for (const socket of sockets) { wss.clients.add(socket as any); wss.emit('connection', socket as any) }
      a.emit('message', Buffer.from(JSON.stringify({ type: 'auth', token: tokens.a })))
      b.emit('message', Buffer.from(JSON.stringify({ type: 'auth', token: tokens.b })))
      admin.emit('message', Buffer.from(JSON.stringify({ type: 'auth', token: tokens.admin })))
      await tick()
      assert.deepEqual(a.sent, [{ type: 'authenticated' }])
      publishRun('run_a', { type: 'log', runId: 'run_a', data: 'private-log' })
      await tick()
      assert.equal(a.sent.at(-1).data, 'private-log')
      assert.equal(admin.sent.at(-1).data, 'private-log')
      assert.equal(b.sent.length, 1)
      assert.equal(guest.sent.length, 0)
      users.findById = async id => ({ id, phone: 'offline', is_admin: 0 })
      publishRun('unowned', { type: 'log', runId: 'unowned', data: 'hidden' })
      await tick()
      assert.equal(admin.sent.length, 2)
    } finally {
      for (const socket of sockets) { socket.close(); wss.clients.delete(socket as any) }
    }
  })
})

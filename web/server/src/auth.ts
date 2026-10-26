import { randomBytes } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken'
import { users } from './db.js'

export interface AuthUser {
  id: number
  phone: string
  is_admin: number
}

export class AuthError extends Error {
  readonly status = 401
}

const configuredSecret = process.env.JWT_SECRET?.trim()
const hasSecureSecret = !!configuredSecret && Buffer.byteLength(configuredSecret, 'utf8') >= 32
if (process.env.NODE_ENV === 'production' && !hasSecureSecret) {
  throw new Error('JWT_SECRET must contain at least 32 bytes for production')
}
const secret = hasSecureSecret ? configuredSecret! : randomBytes(32).toString('hex')

export function signToken(user: { id: number; phone?: string }, expiresIn: SignOptions['expiresIn'] = (process.env.TOKEN_EXPIRY || '24h') as SignOptions['expiresIn']): string {
  if (!Number.isSafeInteger(user.id) || user.id <= 0) throw new AuthError('无效用户')
  return jwt.sign({ id: user.id, phone: user.phone }, secret, { algorithm: 'HS256', expiresIn })
}

export function verifyToken(token: string): JwtPayload & { id: number } {
  let payload: string | JwtPayload
  try {
    payload = jwt.verify(token, secret, { algorithms: ['HS256'] })
  } catch {
    throw new AuthError('登录已过期或无效')
  }
  if (typeof payload === 'string' || !Number.isSafeInteger(payload.id) || payload.id <= 0 || typeof payload.exp !== 'number') {
    throw new AuthError('无效用户')
  }
  return payload as JwtPayload & { id: number }
}

export async function authenticateToken(token: string): Promise<AuthUser> {
  const payload = verifyToken(token)
  const user = await users.findById(payload.id)
  if (!user || !Number.isSafeInteger(user.id) || user.id !== payload.id) throw new AuthError('用户不存在')
  return { id: user.id, phone: user.phone, is_admin: user.is_admin === 1 ? 1 : 0 }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: '未登录' })
    return
  }
  try {
    ;(req as Request & { user: AuthUser }).user = await authenticateToken(header.slice(7))
    next()
  } catch (error) {
    if (error instanceof AuthError) res.status(401).json({ error: error.message })
    else next(error)
  }
}

export function canAccessRun(user: AuthUser | null | undefined, run: { user_id?: number | null } | null | undefined): boolean {
  if (!user || !run || !Number.isSafeInteger(user.id) || user.id <= 0) return false
  return user.is_admin === 1 || (run.user_id != null && run.user_id === user.id)
}

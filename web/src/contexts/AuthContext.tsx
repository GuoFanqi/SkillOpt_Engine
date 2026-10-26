import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'

import { API_BASE } from '../lib/endpoints'

interface Account { phone: string; token: string; userId: number; isAdmin?: boolean; lastLoginAt?: number }
interface User { id: number; phone: string; is_admin?: number }

interface AuthContextType {
  user: User | null
  token: string | null
  loading: boolean
  isAdmin: boolean
  savedAccounts: Account[]
  sendCode: (phone: string) => Promise<{ success: boolean; dev_code?: string }>
  register: (phone: string, code: string, password: string) => Promise<void>
  login: (phone: string, code: string) => Promise<void>
  loginByPassword: (phone: string, password: string) => Promise<void>
  switchAccount: (account: Account) => void
  switchToGuest: () => void
  removeAccount: (phone: string) => void
  logout: () => void
}

const AuthContext = createContext<AuthContextType>(null!)

function loadAccounts(): Account[] {
  try { return JSON.parse(localStorage.getItem('skillopt_accounts') || '[]') }
  catch { return [] }
}

function saveAccounts(accounts: Account[]) {
  localStorage.setItem('skillopt_accounts', JSON.stringify(accounts))
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [savedAccounts, setSavedAccounts] = useState<Account[]>(loadAccounts)
  const [token, setToken] = useState<string | null>(() => {
    return localStorage.getItem('skillopt_token')
  })
  const [loading, setLoading] = useState(true)
  const [guestMode, setGuestMode] = useState(false)

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === 'skillopt_accounts') setSavedAccounts(loadAccounts())
      if (event.key === 'skillopt_token') {
        setUser(null)
        setGuestMode(!event.newValue)
        setLoading(!!event.newValue)
        setToken(event.newValue)
      }
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let disposed = false
    if (token) {
      setLoading(true)
      localStorage.setItem('skillopt_token', token)
      fetch(`${API_BASE}/auth/me`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
        .then(r => r.ok ? r.json() : Promise.reject(new Error('登录已过期')))
        .then(u => {
          if (disposed) return
          setUser(u)
          setGuestMode(false)
          setLoading(false)
        })
        .catch(() => {
          if (disposed) return
          localStorage.removeItem('skillopt_token')
          const accounts = loadAccounts().filter(a => a.token !== token)
          saveAccounts(accounts)
          setSavedAccounts(accounts)
          setUser(null)
          if (accounts.length > 0) {
            localStorage.setItem('skillopt_token', accounts[0].token)
            setToken(accounts[0].token)
          } else {
            setToken(null)
            setLoading(false)
          }
        })
    } else if (!guestMode) {
      const accounts = loadAccounts()
      if (accounts.length > 0) {
        localStorage.setItem('skillopt_token', accounts[0].token)
        setToken(accounts[0].token)
      } else {
        setLoading(false)
      }
    } else {
      setLoading(false)
    }
    return () => { disposed = true; controller.abort() }
  }, [token, guestMode])

  useEffect(() => {
    const expire = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== token) return
      const accounts = loadAccounts().filter(account => account.token !== token)
      saveAccounts(accounts)
      setSavedAccounts(accounts)
      localStorage.removeItem('skillopt_token')
      setGuestMode(true)
      setToken(null)
      setUser(null)
      setLoading(false)
    }
    window.addEventListener('skillopt-auth-expired', expire)
    return () => window.removeEventListener('skillopt-auth-expired', expire)
  }, [token])

  const saveCurrentAccount = (newToken: string, newUser: User) => {
    const accounts = loadAccounts().filter(a => a.phone !== newUser.phone)
    accounts.unshift({ phone: newUser.phone, token: newToken, userId: newUser.id, isAdmin: (newUser.is_admin || 0) === 1, lastLoginAt: Date.now() })
    saveAccounts(accounts)
    setSavedAccounts(accounts)
    localStorage.setItem('skillopt_token', newToken)
    setGuestMode(false)
    setToken(newToken)
    setUser(newUser)
  }

  const sendCode = useCallback(async (phone: string) => {
    const res = await fetch(`${API_BASE}/auth/send-code`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    })
    if (!res.ok) { const e = await res.json(); throw new Error(e.error) }
    return res.json()
  }, [])

  const register = useCallback(async (phone: string, code: string, password: string) => {
    const res = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, code, password }),
    })
    if (!res.ok) { const e = await res.json(); throw new Error(e.error) }
    const data = await res.json()
    saveCurrentAccount(data.token, data.user)
  }, [])

  const login = useCallback(async (phone: string, code: string) => {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, code }),
    })
    if (!res.ok) { const e = await res.json(); throw new Error(e.error) }
    const data = await res.json()
    saveCurrentAccount(data.token, data.user)
  }, [])

  const loginByPassword = useCallback(async (phone: string, password: string) => {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, password }),
    })
    if (!res.ok) { const e = await res.json(); throw new Error(e.error) }
    const data = await res.json()
    saveCurrentAccount(data.token, data.user)
  }, [])

  const switchAccount = useCallback((account: Account) => {
    const accounts = loadAccounts().filter(a => a.phone !== account.phone)
    accounts.unshift({ ...account, lastLoginAt: Date.now() })
    saveAccounts(accounts)
    setSavedAccounts(accounts)
    localStorage.setItem('skillopt_token', account.token)
    setLoading(true)
    setUser(null)
    setToken(account.token)
  }, [])

  const removeAccount = useCallback((phone: string) => {
    const accounts = loadAccounts().filter(a => a.phone !== phone)
    saveAccounts(accounts)
    setSavedAccounts(accounts)
    // If removing current account, switch to another or logout
    if (user?.phone === phone) {
      if (accounts.length > 0) {
        localStorage.setItem('skillopt_token', accounts[0].token)
        setLoading(true)
        setUser(null)
        setToken(accounts[0].token)
      } else {
        localStorage.removeItem('skillopt_token')
        setToken(null)
        setUser(null)
      }
    }
  }, [user])

  const switchToGuest = useCallback(() => {
    localStorage.removeItem('skillopt_token')
    setGuestMode(true)
    setToken(null)
    setUser(null)
  }, [])

  const logout = useCallback(() => {
    const accounts = loadAccounts().filter(a => a.phone !== user?.phone)
    saveAccounts(accounts)
    setSavedAccounts(accounts)
    localStorage.removeItem('skillopt_token')
    if (accounts.length > 0) {
      localStorage.setItem('skillopt_token', accounts[0].token)
      setLoading(true)
      setUser(null)
      setToken(accounts[0].token)
    } else {
      setToken(null)
      setUser(null)
    }
  }, [user])

  return (
    <AuthContext.Provider value={{ user, token, loading, savedAccounts, isAdmin: (user?.is_admin || 0) === 1, sendCode, register, login, loginByPassword, switchAccount, switchToGuest, removeAccount, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() { return useContext(AuthContext) }

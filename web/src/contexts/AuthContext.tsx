import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'

const API_BASE = 'http://localhost:3002/api'

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

  // Periodically sync saved accounts from localStorage (for other tabs)
  useEffect(() => {
    const sync = () => setSavedAccounts(loadAccounts())
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  // Verify current token or auto-login first saved account
  useEffect(() => {
    if (token) {
      // Verify existing token
      fetch(`${API_BASE}/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.ok ? r.json() : Promise.reject())
        .then(u => {
          setUser(u)
          setGuestMode(false)
          localStorage.setItem('skillopt_token', token)
          setLoading(false)
        })
        .catch(() => {
          localStorage.removeItem('skillopt_token')
          // Try next saved account
          const accounts = loadAccounts().filter(a => a.token !== token)
          saveAccounts(accounts)
          setSavedAccounts(accounts)
          if (accounts.length > 0) {
            setToken(accounts[0].token)
          } else {
            setToken(null)
            setUser(null)
            setLoading(false)
          }
        })
    } else if (!guestMode) {
      // No token — try auto-login with first saved account (unless in guest mode)
      const accounts = loadAccounts()
      if (accounts.length > 0) {
        setToken(accounts[0].token)
      } else {
        setLoading(false)
      }
    } else {
      setLoading(false)
    }
  }, [token])

  const saveCurrentAccount = (newToken: string, newUser: User) => {
    const accounts = loadAccounts().filter(a => a.phone !== newUser.phone)
    accounts.unshift({ phone: newUser.phone, token: newToken, userId: newUser.id, isAdmin: (newUser.is_admin || 0) === 1, lastLoginAt: Date.now() })
    saveAccounts(accounts)
    setSavedAccounts(accounts)
    localStorage.setItem('skillopt_token', newToken)
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
    setToken(account.token)
    setUser({ id: account.userId, phone: account.phone, is_admin: account.isAdmin ? 1 : 0 })
  }, [])

  const removeAccount = useCallback((phone: string) => {
    const accounts = loadAccounts().filter(a => a.phone !== phone)
    saveAccounts(accounts)
    setSavedAccounts(accounts)
    // If removing current account, switch to another or logout
    if (user?.phone === phone) {
      if (accounts.length > 0) {
        setToken(accounts[0].token)
        setUser({ id: accounts[0].userId, phone: accounts[0].phone, is_admin: accounts[0].isAdmin ? 1 : 0 })
      } else {
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
      setToken(accounts[0].token)
      setUser({ id: accounts[0].userId, phone: accounts[0].phone, is_admin: accounts[0].isAdmin ? 1 : 0 })
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

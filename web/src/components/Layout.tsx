import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom'
import { Search, Bell, Settings, LogOut, Zap, CheckCircle, AlertCircle, X, ChevronRight, ChevronDown, LogIn, MessageCircle, Copy, Shield, Eye, EyeOff } from 'lucide-react'
import { useState, useRef, useEffect, useCallback } from 'react'
import { useWebSocket } from '../hooks/useWebSocket'
import { useAuth } from '../contexts/AuthContext'
import { getAvatarColor, getAvatarInitial } from '../lib/avatar'
import AuthModal from '../components/AuthModal'
import AccountSwitcher from '../components/AccountSwitcher'
import { fetchTrainingRuns } from '../services/api'
import { TrainingRun } from '../types'

interface Notification {
  id: string
  type: 'complete' | 'error' | 'stage' | 'log'
  runId: string
  runName?: string
  message: string
  fullError?: string
  time: number
  read: boolean
}

export default function Layout() {
  const location = useLocation()
  const navigate = useNavigate()
  const { user, token, logout, isAdmin, savedAccounts, switchToGuest } = useAuth()

  const isActive = (path: string) => {
    if (path === '/' && location.pathname === '/') return true
    if (path !== '/' && location.pathname.startsWith(path)) return true
    return false
  }

  // ─── Global search ───
  const [searchValue, setSearchValue] = useState('')
  const [searchResults, setSearchResults] = useState<TrainingRun[]>([])
  const [showSearchDropdown, setShowSearchDropdown] = useState(false)
  const [isSearching, setIsSearching] = useState(false)
  const searchRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout>>()
  const searchRequest = useRef<AbortController | null>(null)
  const searchVersion = useRef(0)

  const handleSearch = useCallback((query: string) => {
    setSearchValue(query)
    clearTimeout(searchTimeoutRef.current)
    searchRequest.current?.abort()
    const version = ++searchVersion.current
    if (!token || !query.trim()) {
      setSearchResults([])
      setShowSearchDropdown(false)
      return
    }
    searchTimeoutRef.current = setTimeout(async () => {
      const controller = new AbortController()
      searchRequest.current = controller
      setIsSearching(true)
      try {
        const allRuns = await fetchTrainingRuns(controller.signal)
        if (controller.signal.aborted || searchVersion.current !== version) return
        const q = query.toLowerCase()
        const filtered = allRuns.filter(run => run.name.toLowerCase().includes(q)
          || run.model?.toLowerCase().includes(q) || run.id.toLowerCase().includes(q))
        setSearchResults(filtered.slice(0, 8))
        setShowSearchDropdown(filtered.length > 0)
      } catch {
        if (!controller.signal.aborted && searchVersion.current === version) setSearchResults([])
      } finally {
        if (searchVersion.current === version) setIsSearching(false)
      }
    }, 300)
  }, [token])

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && searchValue.trim()) {
      navigate(`/training?search=${encodeURIComponent(searchValue.trim())}`)
      setShowSearchDropdown(false)
    }
    if (e.key === 'Escape') {
      setShowSearchDropdown(false)
    }
  }

  // Close search dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowSearchDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // ─── Notification bell ───
  const { states } = useWebSocket()
  const seenStatuses = useRef<Record<string, string>>({})
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [showNotifications, setShowNotifications] = useState(false)
  const [expandedNotifId, setExpandedNotifId] = useState<string | null>(null)
  const notifRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const added: Notification[] = []
    for (const [runId, state] of Object.entries(states)) {
      const key = `${state.instanceId}:${state.status}:${state.artifactSync}`
      const previous = seenStatuses.current[runId]
      seenStatuses.current[runId] = key
      if (!previous || previous === key) continue
      const failedSync = state.status === 'completed' && state.artifactSync === 'failed'
      const reachedTerminal = ['completed', 'failed', 'stopped'].includes(state.status)
        && !previous.startsWith(`${state.instanceId}:${state.status}:`)
      if (!failedSync && !reachedTerminal) continue
      const error = failedSync ? state.artifactError : state.error
      added.push({
        id: key,
        type: failedSync || state.status === 'failed' ? 'error' : 'complete',
        runId,
        message: failedSync ? '计算已完成，详情同步失败，原件保留'
          : state.status === 'stopped' ? '训练已停止'
          : state.status === 'failed' ? `训练失败：${error || '请查看日志'}` : '训练与评测已完成',
        fullError: error,
        time: Date.now(),
        read: false,
      })
    }
    if (!added.length) return
    setNotifications(previous => [...added, ...previous].slice(0, 20))
    setShowNotifications(true)
    const timer = setTimeout(() => setShowNotifications(false), 5000)
    return () => clearTimeout(timer)
  }, [states])

  useEffect(() => {
    searchVersion.current++
    clearTimeout(searchTimeoutRef.current)
    searchRequest.current?.abort()
    setSearchValue('')
    setSearchResults([])
    setShowSearchDropdown(false)
    setIsSearching(false)
    setNotifications([])
    setShowNotifications(false)
    seenStatuses.current = {}
    return () => {
      searchVersion.current++
      clearTimeout(searchTimeoutRef.current)
      searchRequest.current?.abort()
    }
  }, [token])

  // Close notification dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setShowNotifications(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const unreadCount = notifications.filter(n => !n.read).length

  const markAllRead = () => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })))
  }

  // ─── Contact ───
  const [showContact, setShowContact] = useState(false)
  const [contactCopied, setContactCopied] = useState(false)
  const contactRef = useRef<HTMLDivElement>(null)

  // ─── Auth ───
  const [showAuthModal, setShowAuthModal] = useState(false)
  const [authDefaultMode, setAuthDefaultMode] = useState<'login' | 'register'>('login')
  const [showAccountSwitcher, setShowAccountSwitcher] = useState(false)

  // ─── Avatar dropdown ───
  const [showAvatarMenu, setShowAvatarMenu] = useState(false)
  const avatarRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (avatarRef.current && !avatarRef.current.contains(e.target as Node)) {
        setShowAvatarMenu(false)
      }
      if (contactRef.current && !contactRef.current.contains(e.target as Node)) {
        setShowContact(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const formatTime = (ts: number) => {
    const diff = Math.floor((Date.now() - ts) / 1000)
    if (diff < 60) return '刚刚'
    if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`
    return `${Math.floor(diff / 3600)}小时前`
  }

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="bg-white border-b border-gray-100 px-8 py-4 sticky top-0 z-40">
        <div className="flex items-center justify-between max-w-7xl mx-auto">
          <div className="flex items-center gap-8">
            <Link to="/" className="flex items-center gap-3">
              <div className="w-9 h-9 bg-gradient-to-br from-gray-800 to-gray-900 rounded-2xl flex items-center justify-center">
                <span className="text-white font-semibold text-sm">S</span>
              </div>
              <span className="font-semibold text-gray-900">Godfrey's SkillOpt Engine</span>
            </Link>
            <nav className="flex items-center gap-6">
              <Link
                to="/"
                className={`text-sm font-medium ${
                  isActive('/') ? 'text-gray-900' : 'text-gray-500 hover:text-gray-900'
                }`}
              >
                仪表盘
              </Link>
              <Link
                to="/templates"
                className={`text-sm font-medium ${
                  isActive('/templates') ? 'text-gray-900' : 'text-gray-500 hover:text-gray-900'
                }`}
              >
                案例库
              </Link>
              <Link
                to="/training"
                className={`text-sm font-medium ${
                  isActive('/training') ? 'text-gray-900' : 'text-gray-500 hover:text-gray-900'
                }`}
              >
                训练
              </Link>
              <Link
                to="/skill"
                className={`text-sm font-medium ${
                  isActive('/skill') ? 'text-gray-900' : 'text-gray-500 hover:text-gray-900'
                }`}
              >
                技能
              </Link>
              <Link
                to="/playground"
                className={`text-sm font-medium ${
                  isActive('/playground') ? 'text-gray-900' : 'text-gray-500 hover:text-gray-900'
                }`}
              >
                测试
              </Link>
              <Link
                to="/compare"
                className={`text-sm font-medium ${
                  isActive('/compare') ? 'text-gray-900' : 'text-gray-500 hover:text-gray-900'
                }`}
              >
                对比
              </Link>
            </nav>
          </div>
          <div className="flex items-center gap-4">
            {/* ─── Global search ─── */}
            <div className="relative" ref={searchRef}>
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                ref={searchInputRef}
                type="text"
                placeholder="搜索训练任务、模型..."
                value={searchValue}
                onChange={(e) => handleSearch(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                onFocus={() => searchResults.length > 0 && setShowSearchDropdown(true)}
                className="w-64 pl-10 pr-4 py-2.5 bg-gray-100 rounded-xl text-sm hover:bg-gray-200 transition-colors focus:outline-none focus:ring-2 focus:ring-gray-200 focus:bg-white"
              />

              {/* Search dropdown */}
              {showSearchDropdown && (
                <div className="absolute top-full mt-1 left-0 w-80 bg-white border border-gray-200 rounded-xl shadow-lg z-30 overflow-hidden">
                  <div className="px-3 py-2 border-b border-gray-100 flex items-center justify-between">
                    <span className="text-[11px] text-gray-500">
                      {isSearching ? '搜索中...' : `找到 ${searchResults.length} 个结果`}
                    </span>
                    <span className="text-[10px] text-gray-400">
                      Enter 跳转到训练列表
                    </span>
                  </div>
                  {searchResults.length > 0 ? (
                    <div className="max-h-[300px] overflow-auto">
                      {searchResults.map((run) => (
                        <button
                          key={run.id}
                          onClick={() => {
                            navigate(`/training/${encodeURIComponent(run.id)}`)
                            setShowSearchDropdown(false)
                            setSearchValue('')
                            setSearchResults([])
                          }}
                          className="w-full text-left px-4 py-2.5 hover:bg-gray-50 flex items-center gap-3 transition-colors"
                        >
                          <span className={`w-2 h-2 rounded-full shrink-0 ${
                            run.status === 'completed' ? 'bg-green-500' :
                            run.status === 'training' ? 'bg-blue-500 animate-pulse' :
                            run.status === 'failed' ? 'bg-red-500' : 'bg-yellow-500'
                          }`} />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-gray-800 truncate">{run.name}</div>
                            <div className="text-[10px] text-gray-400">
                              验证集 {run.currentScore}% · {run.totalSteps}步 · {run.model || '--'}
                            </div>
                          </div>
                          <ChevronRight className="w-3.5 h-3.5 text-gray-300 shrink-0" />
                        </button>
                      ))}
                    </div>
                  ) : !isSearching ? (
                    <div className="px-4 py-6 text-center text-xs text-gray-400">
                      无匹配结果，按 Enter 跳转训练列表查看
                    </div>
                  ) : null}
                </div>
              )}
            </div>

            {/* ─── Notification bell ─── */}
            <div className="relative" ref={notifRef}>
              <button
                onClick={() => {
                  setShowNotifications(!showNotifications)
                  if (!showNotifications) markAllRead()
                }}
                className="p-2 hover:bg-gray-100 rounded-xl relative"
              >
                <Bell className="w-5 h-5 text-gray-600" />
                {unreadCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
              </button>

              {showNotifications && (
                <div className="absolute right-0 top-full mt-1 w-80 bg-white border border-gray-200 rounded-xl shadow-lg z-30 overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-900">通知</span>
                    {notifications.length > 0 && (
                      <button
                        onClick={() => {
                          setNotifications([])
                          setShowNotifications(false)
                        }}
                        className="text-[11px] text-gray-400 hover:text-gray-600"
                      >
                        清空
                      </button>
                    )}
                  </div>
                  {notifications.length === 0 ? (
                    <div className="px-4 py-8 text-center text-xs text-gray-400">
                      <Bell className="w-6 h-6 mx-auto mb-2 text-gray-300" />
                      暂无通知
                    </div>
                  ) : (
                    <div className="max-h-[400px] overflow-auto">
                      {notifications.map((n) => (
                        <div key={n.id} className="border-b border-gray-100">
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              if (n.type === 'error') {
                                if (expandedNotifId === n.id) {
                                  setExpandedNotifId(null)
                                } else {
                                  navigate(`/training/${encodeURIComponent(n.runId)}`)
                                  setShowNotifications(false)
                                  setExpandedNotifId(null)
                                }
                              } else {
                                navigate(`/training/${encodeURIComponent(n.runId)}`)
                                setShowNotifications(false)
                                setExpandedNotifId(null)
                              }
                            }}
                            className={`w-full text-left px-4 py-3 hover:bg-gray-50 flex items-start gap-3 transition-colors ${
                              !n.read ? 'bg-blue-50/50' : ''
                            }`}
                          >
                            {n.type === 'complete' ? (
                              <CheckCircle className="w-4 h-4 text-green-500 mt-0.5 shrink-0" />
                            ) : n.type === 'error' ? (
                              <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                            ) : (
                              <Zap className="w-4 h-4 text-blue-500 mt-0.5 shrink-0" />
                            )}
                            <div className="flex-1 min-w-0">
                              <div className={`text-xs ${!n.read ? 'font-semibold text-gray-900' : 'text-gray-700'} ${n.fullError ? 'whitespace-pre-wrap break-all' : ''}`}>
                                {n.message}
                              </div>
                              <div className="text-[10px] text-gray-400 mt-0.5 flex items-center gap-2">
                                <span>{n.runName || n.runId.slice(-8)} · {formatTime(n.time)}</span>
                                {n.type === 'error' && n.fullError && (
                                  <span className="text-indigo-500 cursor-pointer flex items-center gap-0.5">
                                    详情
                                    <ChevronDown className={`w-2.5 h-2.5 transition-transform ${expandedNotifId === n.id ? 'rotate-180' : ''}`} />
                                  </span>
                                )}
                              </div>
                            </div>
                            {!n.read && (
                              <span className="w-1.5 h-1.5 rounded-full bg-blue-500 mt-1.5 shrink-0" />
                            )}
                          </button>
                          {/* Expandable full error */}
                          {expandedNotifId === n.id && n.fullError && (
                            <div className="px-4 pb-3 pl-11">
                              <pre className="text-[10px] text-red-700 bg-red-50 rounded-lg p-2 max-h-[200px] overflow-auto whitespace-pre-wrap break-all font-mono leading-relaxed">
                                {n.fullError}
                              </pre>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <Link
              to="/settings"
              className={`p-2 rounded-xl transition-colors ${
                isActive('/settings') ? 'bg-gray-100 text-gray-900' : 'text-gray-500 hover:text-gray-900 hover:bg-gray-100'
              }`}
            >
              <Settings className="w-5 h-5" />
            </Link>

            {/* ─── 联系作者 ─── */}
            <div className="relative" ref={contactRef}>
              <button
                onClick={() => setShowContact(!showContact)}
                className={`p-2 rounded-xl transition-colors ${showContact ? 'bg-green-50 text-green-600' : 'text-gray-500 hover:text-green-600 hover:bg-green-50'}`}
                title="联系作者"
              >
                <MessageCircle className="w-5 h-5" />
              </button>
              {showContact && (
                <div className="absolute right-0 top-12 w-72 bg-white rounded-2xl shadow-xl border border-gray-100 p-5 z-50">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-sm font-semibold text-gray-900">联系作者</h4>
                    <button onClick={() => setShowContact(false)} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
                  </div>
                  {/* 微信二维码 */}
                  <div className="bg-green-50 rounded-xl p-3 mb-3">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-2xl">💬</span>
                      <span className="text-sm font-medium text-green-800">微信 WeChat</span>
                    </div>
                    <div className="flex flex-col items-center gap-2">
                      <div className="bg-white rounded-xl border-2 border-green-100 overflow-hidden w-36 h-36 flex items-center justify-center">
                        <img 
                          src="/wechat-qr.png" 
                          alt="微信二维码" 
                          className="w-full h-full object-cover"
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = 'none';
                            (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden');
                          }}
                        />
                        <span className="hidden text-[10px] text-gray-400 text-center px-2">
                          请将微信二维码截图保存为<br/><code className="text-green-600">public/wechat-qr.png</code>
                        </span>
                      </div>
                      <div className="flex items-center justify-between w-full bg-white rounded-lg px-3 py-1.5 border border-green-100">
                        <code className="text-sm font-mono text-green-700">yanjinya99</code>
                        <button
                          onClick={async () => { try { await navigator.clipboard.writeText('yanjinya99'); setContactCopied(true); setTimeout(() => setContactCopied(false), 2000) } catch {} }}
                          className="text-xs px-2 py-1 bg-green-100 text-green-700 rounded-md hover:bg-green-200 transition-colors flex items-center gap-1"
                        >
                          {contactCopied ? '✓ 已复制' : <><Copy className="w-3 h-3" /> 复制</>}
                        </button>
                      </div>
                    </div>
                  </div>
                  <p className="text-[11px] text-gray-400 leading-relaxed">
                    扫码或搜索微信号添加作者微信，获取技术支持、反馈建议或商务合作。
                  </p>
                  {/* 字节飞书 */}
                  <div className="mt-3 bg-blue-50 rounded-xl p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-lg">📨</span>
                      <span className="text-xs font-medium text-blue-800">字节飞书</span>
                    </div>
                    <div className="text-[10px] text-blue-600 mb-2">飞书搜索「hanyankun」即可找到</div>
                    <div className="flex items-center justify-between bg-white rounded-lg px-3 py-1.5 border border-blue-100">
                      <code className="text-sm font-mono text-blue-700">hanyankun</code>
                      <button
                        onClick={async () => { try { await navigator.clipboard.writeText('hanyankun'); setContactCopied(true); setTimeout(() => setContactCopied(false), 2000) } catch {} }}
                        className="text-xs px-2 py-1 bg-blue-100 text-blue-700 rounded-md hover:bg-blue-200 transition-colors flex items-center gap-1"
                      >
                        {contactCopied ? '✓ 已复制' : <><Copy className="w-3 h-3" /> 复制</>}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* ─── User / Avatar ─── */}
            {user ? (
              <div className="relative flex items-center gap-2" ref={avatarRef}>
                {/* Guest mode quick toggle — switch style */}
                <button
                  onClick={() => switchToGuest()}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-all
                    bg-white border-gray-200 text-gray-500 hover:border-gray-300 hover:bg-gray-50 hover:text-gray-700
                    active:scale-95"
                  title="切换访客模式 — 浏览公开模板和案例"
                >
                  <EyeOff className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="hidden sm:inline whitespace-nowrap">切为访客</span>
                </button>

                <button
                  onClick={() => setShowAvatarMenu(!showAvatarMenu)}
                  className={`w-9 h-9 bg-gradient-to-br ${getAvatarColor(user.phone)} rounded-full flex items-center justify-center hover:shadow-md transition-shadow`}
                >
                  <span className="text-white text-xs font-semibold">{getAvatarInitial(user.phone)}</span>
                </button>

                {showAvatarMenu && (
                  <div className="absolute right-0 top-full mt-1 w-48 bg-white border border-gray-200 rounded-xl shadow-lg z-30 overflow-hidden">
                    <div className="px-4 py-3 border-b border-gray-100">
                      <div className="text-sm font-medium text-gray-900">{user.phone}</div>
                      <div className="text-[11px] text-gray-400">{savedAccounts.length > 1 ? `已保存 ${savedAccounts.length} 个账号` : '已认证用户'}</div>
                    </div>
                    <div className="py-1">
                      <button onClick={() => { setShowAvatarMenu(false); setShowAccountSwitcher(true) }}
                        className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-50 transition-colors">
                        <Zap className="w-4 h-4 text-gray-400" /> 切换账号
                      </button>
                      <Link to="/settings" onClick={() => setShowAvatarMenu(false)}
                        className="flex items-center gap-3 px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-50 transition-colors">
                        <Settings className="w-4 h-4 text-gray-400" /> API Key 配置
                      </Link>
                      {isAdmin && (
                        <Link to="/admin" onClick={() => setShowAvatarMenu(false)}
                          className="flex items-center gap-3 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 transition-colors">
                          <Shield className="w-4 h-4 text-red-400" /> 管理后台
                        </Link>
                      )}
                      <Link to="/" onClick={() => setShowAvatarMenu(false)}
                        className="flex items-center gap-3 px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-50 transition-colors">
                        <Zap className="w-4 h-4 text-gray-400" /> 返回仪表盘
                      </Link>
                      <button onClick={() => { setShowAvatarMenu(false); logout() }}
                        className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 transition-colors">
                        <LogOut className="w-4 h-4" /> 退出登录
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                {/* Guest indicator */}
                <span className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-gray-100 text-gray-500 rounded-lg border border-gray-200 whitespace-nowrap">
                  <Eye className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">访客</span>
                </span>
                {savedAccounts.length > 0 ? (
                  <button
                    onClick={() => setShowAccountSwitcher(true)}
                    className="flex items-center gap-1.5 px-3 py-2 bg-indigo-50 text-indigo-600 rounded-xl text-xs font-medium hover:bg-indigo-100 transition-colors"
                    title="切换到已保存账号"
                  >
                    切换账号
                  </button>
                ) : (
                  <>
                    <button onClick={() => { setAuthDefaultMode('login'); setShowAuthModal(true) }}
                      className="flex items-center gap-2 px-4 py-2 bg-indigo-500 text-white rounded-xl text-sm font-medium hover:bg-indigo-600 transition-colors">
                      <LogIn className="w-4 h-4" /> 登录
                    </button>
                    <button onClick={() => { setAuthDefaultMode('register'); setShowAuthModal(true) }}
                      className="flex items-center gap-2 px-4 py-2 bg-white text-indigo-600 border border-indigo-200 rounded-xl text-sm font-medium hover:bg-indigo-50 transition-colors">
                      注册
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Guest mode banner */}
      {!user && (
        <div className="bg-gray-50 border-b border-gray-200 px-8 py-2.5">
          <div className="max-w-7xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <Eye className="w-4 h-4" />
              <span>当前为访客模式 — 仅可浏览公开模板和案例库</span>
            </div>
            {savedAccounts.length > 0 && (
              <button
                onClick={() => setShowAccountSwitcher(true)}
                className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
              >
                登录已有账号 →
              </button>
            )}
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className="p-8">
        <div className="max-w-7xl mx-auto">
          <Outlet key={token ?? 'guest'} />
        </div>
      </main>

      <AuthModal isOpen={showAuthModal} onClose={() => setShowAuthModal(false)} defaultMode={authDefaultMode} />
      <AccountSwitcher
        isOpen={showAccountSwitcher}
        onClose={() => setShowAccountSwitcher(false)}
        onAddAccount={() => { setAuthDefaultMode('login'); setShowAuthModal(true) }}
      />
    </div>
  )
}

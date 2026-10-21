import { useState, useRef, useEffect } from 'react'
import { X, Smartphone, Lock, Loader2 } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import SliderCaptcha from './SliderCaptcha'

type Mode = 'login' | 'register'

export default function AuthModal({ isOpen, onClose, defaultMode = 'login' }: { isOpen: boolean; onClose: () => void; defaultMode?: Mode }) {
  const { sendCode, register, loginByPassword } = useAuth()
  const [mode, setMode] = useState<Mode>(defaultMode)
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [countdown, setCountdown] = useState(0)
  const [waitSeconds, setWaitSeconds] = useState(0)
  const [captchaVerified, setCaptchaVerified] = useState(false)
  const [codeSent, setCodeSent] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval>>()

  useEffect(() => { setMode(defaultMode); resetForm() }, [defaultMode, isOpen])

  useEffect(() => {
    if (countdown > 0) {
      timerRef.current = setInterval(() => setCountdown(c => c - 1), 1000)
      return () => clearInterval(timerRef.current)
    }
  }, [countdown])

  // Random 2-10s wait after captcha passed
  useEffect(() => {
    if (captchaVerified && waitSeconds > 0) {
      timerRef.current = setInterval(() => {
        setWaitSeconds(w => {
          if (w <= 1) { clearInterval(timerRef.current); doSendCode(); return 0 }
          return w - 1
        })
      }, 1000)
      return () => clearInterval(timerRef.current)
    }
  }, [captchaVerified, waitSeconds])

  // ─── Login ───
  const handlePasswordLogin = async () => {
    setError('')
    if (!/^1\d{10}$/.test(phone)) return setError('请输入正确的手机号')
    if (!password) return setError('请输入密码')
    setLoading(true)
    try {
      await loginByPassword(phone, password)
      onClose()
      resetForm()
    } catch (err: any) {
      setError(err.message || '登录失败')
    } finally {
      setLoading(false)
    }
  }

  // ─── Register ───
  const handleCaptchaVerified = () => {
    setCaptchaVerified(true)
    const delay = Math.floor(Math.random() * 9) + 2
    setWaitSeconds(delay)
  }

  const doSendCode = async () => {
    setLoading(true)
    try {
      const result = await sendCode(phone)
      if (result.dev_code) setCode(result.dev_code)
      setCodeSent(true)
      setCountdown(60)
    } catch (err: any) {
      setError(err.message || '发送失败')
      setCaptchaVerified(false)
    } finally {
      setLoading(false)
    }
  }

  const handleRegister = async () => {
    setError('')
    if (!/^1\d{10}$/.test(phone)) return setError('请输入正确的手机号')
    if (code.length !== 6) return setError('请输入验证码')
    if (password.length < 6) return setError('密码至少 6 位')
    setLoading(true)
    try {
      await register(phone, code, password)
      onClose()
      resetForm()
    } catch (err: any) {
      setError(err.message || '注册失败')
    } finally {
      setLoading(false)
    }
  }

  const resetForm = () => {
    setPhone(''); setCode(''); setPassword(''); setError('')
    setCountdown(0); setWaitSeconds(0); setCaptchaVerified(false); setCodeSent(false)
    setMode(defaultMode)
  }

  const handleClose = () => { resetForm(); onClose() }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={handleClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-[380px] p-8">
        <button onClick={handleClose} className="absolute top-4 right-4 p-2 hover:bg-gray-100 rounded-xl text-gray-400 z-10">
          <X className="w-5 h-5" />
        </button>

        {/* Header */}
        <div className="text-center mb-6">
          <div className="w-14 h-14 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Smartphone className="w-7 h-7 text-white" />
          </div>
            <div className="flex bg-gray-100 rounded-xl p-0.5 mb-3">
            <button onClick={() => { setMode('login'); setError(''); setCaptchaVerified(false) }}
              className={`flex-1 py-2 text-sm font-medium rounded-lg transition-all ${mode === 'login' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>登录</button>
            <button onClick={() => { setMode('register'); setError(''); setCaptchaVerified(false); setCodeSent(false); setCode('') }}
              className={`flex-1 py-2 text-sm font-medium rounded-lg transition-all ${mode === 'register' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>注册</button>
          </div>
          <h2 className="text-xl font-semibold text-gray-900">{mode === 'login' ? '登录' : '注册'}</h2>
          <p className="text-sm text-gray-500 mt-1">
            {mode === 'login' ? '输入手机号和密码登录' : '输入手机号注册新账号'}
          </p>
        </div>

        <div className="space-y-4">
          {/* Phone */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">手机号</label>
            <div className="relative">
              <Smartphone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="tel" value={phone} autoFocus maxLength={11}
                onChange={e => setPhone(e.target.value.replace(/\D/g, ''))}
                placeholder="输入手机号"
                className="w-full pl-10 pr-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
              />
            </div>
          </div>

          {mode === 'login' ? (
            <>
              {/* Password (Login) */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1.5">密码</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
                    type="password" value={password}
                    onChange={e => setPassword(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handlePasswordLogin()}
                    placeholder="输入密码"
                    className="w-full pl-10 pr-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
                  />
                </div>
              </div>
              {/* Captcha (Login) */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1.5">安全验证</label>
                <SliderCaptcha onVerify={() => setCaptchaVerified(true)} onReset={() => setCaptchaVerified(false)} disabled={phone.length < 11} />
              </div>

              {error && <div className="p-3 bg-red-50 border border-red-100 rounded-xl text-xs text-red-600">{error}</div>}
              <button onClick={handlePasswordLogin} disabled={loading || phone.length < 11 || !password || !captchaVerified}
                className="w-full py-2.5 bg-indigo-500 text-white rounded-xl text-sm font-medium hover:bg-indigo-600 disabled:opacity-50 flex items-center justify-center gap-2">
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null} 登录
              </button>
            </>
          ) : (
            <>
              {/* Captcha (Register) */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1.5">安全验证</label>
                <SliderCaptcha onVerify={handleCaptchaVerified} onReset={() => { setCaptchaVerified(false); setCodeSent(false); setCode('') }} disabled={phone.length < 11} />
              </div>

              {/* Sending countdown */}
              {captchaVerified && !codeSent && (
                <div className="bg-indigo-50 rounded-xl p-3 flex items-center gap-2">
                  <Loader2 className="w-4 h-4 text-indigo-500 animate-spin shrink-0" />
                  <span className="text-xs text-indigo-600">验证码将在 <b>{waitSeconds}</b> 秒后发送</span>
                </div>
              )}

              {/* Code (Register) */}
              {/* Code (Register) */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1.5">验证码</label>
                <input
                  type="text" value={code} maxLength={6}
                  onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
                  placeholder={captchaVerified && !codeSent ? '验证码发送中...' : '输入 6 位验证码'}
                  disabled={!codeSent}
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm text-center tracking-[8px] text-lg font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400 disabled:opacity-50"
                />
                {codeSent && (
                  <div className="text-center mt-1">
                    <button onClick={doSendCode} disabled={countdown > 0 || loading} className="text-[11px] text-indigo-500 hover:text-indigo-600 disabled:text-gray-400">
                      {countdown > 0 ? `${countdown}s 后重新发送` : '重新发送'}
                    </button>
                  </div>
                )}
              </div>

              {/* Password (Register) */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1.5">设置密码（至少6位）</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
                    type="password" value={password}
                    onChange={e => setPassword(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleRegister()}
                    placeholder="设置登录密码"
                    className="w-full pl-10 pr-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
                  />
                </div>
              </div>

              {error && <div className="p-3 bg-red-50 border border-red-100 rounded-xl text-xs text-red-600">{error}</div>}
              <button onClick={handleRegister} disabled={loading || phone.length < 11 || code.length !== 6 || password.length < 6}
                className="w-full py-2.5 bg-indigo-500 text-white rounded-xl text-sm font-medium hover:bg-indigo-600 disabled:opacity-50 flex items-center justify-center gap-2">
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null} 注册
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

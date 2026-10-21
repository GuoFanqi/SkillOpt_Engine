import { useState, useEffect } from 'react'
import { X, Plus, Check, Eye } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { getAvatarColor, getAvatarInitial } from '../lib/avatar'

interface Props {
  isOpen: boolean
  onClose: () => void
  onAddAccount: () => void
}

export default function AccountSwitcher({ isOpen, onClose, onAddAccount }: Props) {
  const { user, savedAccounts, switchAccount, switchToGuest, removeAccount } = useAuth()
  const [showManage, setShowManage] = useState(false)
  const [switchingTo, setSwitchingTo] = useState<string | null>(null)

  // Cleanup on close
  useEffect(() => {
    if (!isOpen) {
      setShowManage(false)
      setSwitchingTo(null)
    }
  }, [isOpen])

  if (!isOpen) return null

  const handleSwitch = (account: typeof savedAccounts[0]) => {
    if (showManage) return
    if (account.phone === user?.phone) return
    setSwitchingTo(account.phone)
    setTimeout(() => {
      switchAccount(account)
      onClose()
    }, 600)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30" />

      {/* Switching overlay */}
      {switchingTo && (
        <div className="absolute inset-0 z-10 flex items-center justify-center">
          <div className="bg-white/95 backdrop-blur-md rounded-3xl px-10 py-8 shadow-2xl flex flex-col items-center gap-4 animate-in zoom-in-95 duration-300">
            <div className="relative">
              {/* Spinner ring */}
              <div className="w-16 h-16 rounded-full border-4 border-indigo-100 border-t-indigo-500 animate-spin" />
              {/* Inner icon */}
              <div className="absolute inset-0 flex items-center justify-center">
                <div className={`
                  w-9 h-9 rounded-xl bg-gradient-to-br ${getAvatarColor(switchingTo)}
                  flex items-center justify-center text-white text-xs font-semibold
                `}>
                  {getAvatarInitial(switchingTo)}
                </div>
              </div>
            </div>
            <div className="text-center">
              <div className="text-sm font-medium text-gray-900">正在切换</div>
              <div className="text-[12px] text-gray-400 mt-0.5">{switchingTo}</div>
            </div>
            {/* Progress dots */}
            <div className="flex gap-1.5">
              <div className="w-2 h-2 rounded-full bg-indigo-500 animate-bounce" />
              <div className="w-2 h-2 rounded-full bg-indigo-500 animate-bounce" style={{ animationDelay: '0.15s' }} />
              <div className="w-2 h-2 rounded-full bg-indigo-500 animate-bounce" style={{ animationDelay: '0.3s' }} />
            </div>
          </div>
        </div>
      )}

      {/* Card */}
      <div
        className="relative bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="text-base font-semibold text-gray-900">切换账号</h3>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowManage(!showManage)}
              className="text-[13px] font-medium text-indigo-600 hover:text-indigo-700"
            >
              {showManage ? '完成' : '管理'}
            </button>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Account List */}
        <div className="max-h-[320px] overflow-y-auto">
          {savedAccounts.map((account) => {
            const isCurrent = account.phone === user?.phone
            const isSwitching = account.phone === switchingTo
            return (
              <div
                key={account.phone}
                onClick={() => handleSwitch(account)}
                className={`
                  flex items-center gap-3 px-5 py-3.5 border-b border-gray-50 transition-all duration-300
                  ${!showManage && !isCurrent ? 'cursor-pointer hover:bg-indigo-50/50' : ''}
                  ${isCurrent ? 'bg-indigo-50/30' : ''}
                  ${isSwitching ? 'opacity-50 scale-[0.98]' : ''}
                `}
              >
                {/* Avatar */}
                <div className={`
                  w-11 h-11 rounded-xl bg-gradient-to-br ${getAvatarColor(account.phone)}
                  flex items-center justify-center text-white text-sm font-semibold flex-shrink-0
                `}>
                  {getAvatarInitial(account.phone)}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[15px] text-gray-900 font-medium truncate">
                      {account.phone}
                    </span>
                    {isCurrent && (
                      <Check className="w-4 h-4 text-indigo-500 flex-shrink-0" />
                    )}
                  </div>
                  <div className="text-[12px] text-gray-400 mt-0.5">
                    {isCurrent ? '当前登录' : `上次登录 ${formatTime(account.lastLoginAt)}`}
                  </div>
                </div>

                {/* Manage: delete button — show for all accounts */}
                {showManage && (
                  <button
                    onClick={(e) => { e.stopPropagation(); removeAccount(account.phone) }}
                    className="w-7 h-7 rounded-full bg-red-50 flex items-center justify-center hover:bg-red-100 flex-shrink-0"
                  >
                    <X className="w-3.5 h-3.5 text-red-500" />
                  </button>
                )}
              </div>
            )
          })}
        </div>

        {/* Footer: Guest mode + Add Account */}
        {!showManage && (
          <div className="border-t border-gray-100">
            {/* Guest mode toggle */}
            {user ? (
              <button
                onClick={() => { switchToGuest(); onClose() }}
                className="w-full flex items-center gap-3 px-5 py-3.5 text-gray-500 hover:bg-gray-50 transition-colors"
              >
                <div className="w-11 h-11 rounded-xl bg-gray-100 flex items-center justify-center flex-shrink-0">
                  <Eye className="w-5 h-5 text-gray-400" />
                </div>
                <div className="text-left">
                  <div className="text-[15px] font-medium">切换访客模式</div>
                  <div className="text-[11px] text-gray-400">查看所有公开训练</div>
                </div>
              </button>
            ) : (
              <div className="w-full flex items-center gap-3 px-5 py-3.5">
                <div className="w-11 h-11 rounded-xl bg-gray-100 flex items-center justify-center flex-shrink-0">
                  <Eye className="w-5 h-5 text-green-500" />
                </div>
                <div className="text-left">
                  <div className="text-[15px] font-medium text-gray-400">当前为访客模式</div>
                  <div className="text-[11px] text-gray-400">登录后可查看私有训练</div>
                </div>
              </div>
            )}

            <button
              onClick={() => { onAddAccount(); onClose() }}
              className="w-full flex items-center gap-3 px-5 py-3.5 text-gray-500 hover:bg-gray-50 transition-colors"
            >
              <div className="w-11 h-11 rounded-xl border-2 border-dashed border-gray-300 flex items-center justify-center flex-shrink-0">
                <Plus className="w-5 h-5 text-gray-400" />
              </div>
              <span className="text-[15px] font-medium">添加账号</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function formatTime(ts?: number) {
  if (!ts) return '未知'
  const now = Date.now()
  const diff = now - ts
  if (diff < 0) return '刚刚'
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`
  return `${Math.floor(diff / 86400000)}天前`
}

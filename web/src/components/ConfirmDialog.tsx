import { useState, useEffect, useCallback, useRef } from 'react'
import { X, AlertTriangle, Info } from 'lucide-react'

interface ConfirmOptions {
  title?: string
  message: string
  confirmText?: string
  cancelText?: string
  variant?: 'danger' | 'warning' | 'info'
}

let globalConfirm: ((options: ConfirmOptions) => Promise<boolean>) | null = null

export function useConfirm() {
  const fn = useCallback((options: ConfirmOptions) => {
    if (globalConfirm) return globalConfirm(options)
    return Promise.resolve(false)
  }, [])
  return { confirm: fn }
}

export default function ConfirmDialogProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const [confirmText, setConfirmText] = useState('确定')
  const [cancelText, setCancelText] = useState('取消')
  const [variant, setVariant] = useState<'danger' | 'warning' | 'info'>('danger')
  const resolveRef = useRef<((value: boolean) => void) | null>(null)
  const cancelRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    globalConfirm = (options: ConfirmOptions): Promise<boolean> => {
      return new Promise<boolean>((resolve) => {
        resolveRef.current = resolve
        setTitle(options.title ?? '请确认')
        setMessage(options.message)
        setConfirmText(options.confirmText ?? '确定')
        setCancelText(options.cancelText ?? '取消')
        setVariant(options.variant ?? 'danger')
        setOpen(true)
      })
    }
    return () => { globalConfirm = null }
  }, [])

  const handleConfirm = () => {
    setOpen(false)
    resolveRef.current?.(true)
  }

  const handleCancel = () => {
    setOpen(false)
    resolveRef.current?.(false)
  }

  // ESC key close
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleCancel()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open])

  // Click overlay close
  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) handleCancel()
  }

  const iconColor = variant === 'danger' ? 'text-red-500 bg-red-50' :
                    variant === 'warning' ? 'text-amber-500 bg-amber-50' :
                    'text-blue-500 bg-blue-50'

  const btnVariant = variant === 'danger'
    ? 'bg-red-600 hover:bg-red-700 border-red-600 text-white shadow-red-200/50 hover:shadow-red-300/50'
    : variant === 'warning'
      ? 'bg-blue-600 hover:bg-blue-700 border-blue-600 text-white shadow-blue-200/50 hover:shadow-blue-300/50'
      : 'bg-gray-800 hover:bg-gray-900 border-gray-800 text-white shadow-gray-200/50'

  const IconComp = variant === 'info' ? Info : AlertTriangle

  return (
    <>
      {children}
      {/* Overlay */}
      {open && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center p-4 animate-fade-in"
          onClick={handleOverlayClick}
          style={{ backgroundColor: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(4px)' }}
        >
          <div
            className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl border border-gray-100 overflow-hidden animate-dialog-in"
            role="dialog"
            aria-modal="true"
          >
            {/* Header icon bar */}
            <div className="flex items-start gap-4 p-6 pb-2">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${iconColor}`}>
                <IconComp className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0 pt-0.5">
                <h3 className="text-base font-semibold text-gray-900">{title}</h3>
              </div>
              <button
                onClick={handleCancel}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Body */}
            <div className="px-6 pb-6">
              <p className="text-sm text-gray-600 leading-relaxed pl-14">
                {message}
              </p>

              {/* Buttons */}
              <div className="flex items-center justify-end gap-3 mt-6 pl-14">
                <button
                  onClick={handleCancel}
                  className="inline-flex items-center justify-center h-9 px-4 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 hover:border-gray-300 transition-all active:scale-[0.98] min-w-[72px]"
                >
                  {cancelText}
                </button>
                <button
                  onClick={handleConfirm}
                  className={`inline-flex items-center justify-center h-9 px-5 text-sm font-semibold rounded-xl transition-all active:scale-[0.98] min-w-[80px] shadow-sm hover:shadow-md ${btnVariant}`}
                >
                  {confirmText}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes dialogIn {
          from { opacity: 0; transform: scale(0.96) translateY(8px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }
        .animate-fade-in { animation: fadeIn 0.15s ease-out forwards; }
        .animate-dialog-in { animation: dialogIn 0.2s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
      `}</style>
    </>
  )
}

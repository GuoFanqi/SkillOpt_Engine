import { useState, useCallback } from 'react'
import { createContext, useContext } from 'react'
import { CheckCircle, XCircle, AlertCircle, X } from 'lucide-react'

interface ToastMessage {
  id: string
  type: 'success' | 'error' | 'info' | 'warning'
  message: string
}

const ToastIcon = ({ type }: { type: ToastMessage['type'] }) => {
  switch (type) {
    case 'success':
      return <CheckCircle className="w-5 h-5 text-green-500" />
    case 'error':
      return <XCircle className="w-5 h-5 text-red-500" />
    case 'info':
      return <AlertCircle className="w-5 h-5 text-blue-500" />
    case 'warning':
      return <AlertCircle className="w-5 h-5 text-amber-500" />
  }
}

const ToastContainer = ({ messages, removeMessage }: { messages: ToastMessage[]; removeMessage: (id: string) => void }) => {
  return (
    <div className="fixed top-4 right-4 z-50 space-y-2">
      {messages.map((msg) => (
        <div
          key={msg.id}
          className={`flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg backdrop-blur-sm min-w-[280px] max-w-[400px] ${
            msg.type === 'success' ? 'bg-green-50 border border-green-200' :
            msg.type === 'error' ? 'bg-red-50 border border-red-200' :
            'bg-blue-50 border border-blue-200'
          }`}
        >
          <ToastIcon type={msg.type} />
          <span className="flex-1 text-sm font-medium text-gray-800">{msg.message}</span>
          <button
            onClick={() => removeMessage(msg.id)}
            className="p-1 hover:bg-black/5 rounded-lg transition-colors"
          >
            <X className="w-4 h-4 text-gray-400" />
          </button>
        </div>
      ))}
    </div>
  )
}

const ToastContext = createContext<{
  showToast: (type: ToastMessage['type'], message: string) => void
  showSuccess: (message: string) => void
  showError: (message: string) => void
  showInfo: (message: string) => void
} | null>(null)

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [messages, setMessages] = useState<ToastMessage[]>([])

  const removeMessage = useCallback((id: string) => {
    setMessages((prev) => prev.filter((msg) => msg.id !== id))
  }, [])

  const showToast = useCallback((type: ToastMessage['type'], message: string) => {
    const id = `toast-${Date.now()}`
    setMessages((prev) => [...prev, { id, type, message }])
    setTimeout(() => removeMessage(id), 5000)
  }, [removeMessage])

  const showSuccess = useCallback((message: string) => showToast('success', message), [showToast])
  const showError = useCallback((message: string) => showToast('error', message), [showToast])
  const showInfo = useCallback((message: string) => showToast('info', message), [showToast])

  return (
    <ToastContext.Provider value={{ showToast, showSuccess, showError, showInfo }}>
      {children}
      <ToastContainer messages={messages} removeMessage={removeMessage} />
    </ToastContext.Provider>
  )
}

export function useToast() {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider')
  }
  return context
}

export default ToastProvider
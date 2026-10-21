import { useState, useEffect } from 'react'
import { Check, AlertCircle, Key, Eye, EyeOff, Trash2, Plus, ChevronDown, Zap, Loader2 } from 'lucide-react'
import { fetchApiKeys, saveApiKeys, testApiKey, deleteApiKey, ApiKeySettings } from '../services/api'
import { useAuth } from '../contexts/AuthContext'

interface ProviderForm {
  apiKey: string
  baseUrl?: string
  endpoint?: string
  apiVersion?: string
}

interface ProviderDef {
  id: string
  name: string
  desc: string
  fields: string[]
  defaultBaseUrl?: string
  defaultApiVersion?: string
}

const ALL_PROVIDERS: ProviderDef[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    desc: 'deepseek-chat / deepseek-reasoner',
    fields: ['apiKey', 'baseUrl'],
    defaultBaseUrl: 'https://api.deepseek.com/v1',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    desc: 'GPT-4o / GPT-4.1 / o3 / o4-mini',
    fields: ['apiKey', 'baseUrl'],
  },
  {
    id: 'azure',
    name: 'Azure OpenAI',
    desc: '用于评估后端（evaluation backend）',
    fields: ['apiKey', 'endpoint', 'apiVersion'],
    defaultApiVersion: '2024-12-01-preview',
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    desc: 'Claude 3.5 Sonnet / Haiku',
    fields: ['apiKey'],
  },
  {
    id: 'qwen',
    name: 'Qwen Chat (通义千问)',
    desc: 'Qwen3.5-4B / 14B / 32B',
    fields: ['apiKey', 'baseUrl'],
    defaultBaseUrl: 'http://localhost:8000/v1',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    desc: 'MiniMax-M2.7',
    fields: ['apiKey', 'baseUrl'],
    defaultBaseUrl: 'https://api.minimax.io/v1',
  },
]

export default function Settings() {
  const { token } = useAuth()
  const [saved, setSaved] = useState<ApiKeySettings>({})
  const [forms, setForms] = useState<Record<string, ProviderForm>>({})
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [messages, setMessages] = useState<Record<string, { type: 'success' | 'error'; text: string }>>({})
  const [showAddDropdown, setShowAddDropdown] = useState(false)
  const [editingProviders, setEditingProviders] = useState<Set<string>>(new Set())
  const [testing, setTesting] = useState<Record<string, boolean>>({})
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; message: string }>>({})

  useEffect(() => {
    setLoading(true)
    setSaved({})
    setForms({})
    setEditingProviders(new Set())
    setTestResults({})
    fetchApiKeys().then((data) => {
      setSaved(data)
      const initial: Record<string, ProviderForm> = {}
      for (const p of ALL_PROVIDERS) {
        const savedCfg = (data as any)[p.id]
        initial[p.id] = {
          apiKey: '',  // Always start empty — placeholder shows preview
          baseUrl: savedCfg?.baseUrl || (p.defaultBaseUrl || ''),
          endpoint: savedCfg?.endpoint || '',
          apiVersion: savedCfg?.apiVersion || (p.defaultApiVersion || ''),
        }
      }
      setForms(initial)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [token])

  const getConfiguredProviders = (): string[] => {
    return ALL_PROVIDERS.filter((p) => (saved as any)[p.id]?.apiKeyConfigured).map((p) => p.id)
  }

  const getAvailableProviders = (): ProviderDef[] => {
    const configured = new Set(getConfiguredProviders())
    return ALL_PROVIDERS.filter((p) => !configured.has(p.id))
  }

  const handleSave = async (providerId: string) => {
    setSaving((prev) => ({ ...prev, [providerId]: true }))
    setMessages((prev) => { const n = { ...prev }; delete n[providerId]; return n })

    try {
      const form = forms[providerId]
      const payload: any = { [providerId]: {} }

      if (form.apiKey && form.apiKey !== '••••••••') {
        payload[providerId].apiKey = form.apiKey
      }

      if ('baseUrl' in form && form.baseUrl) {
        payload[providerId].baseUrl = form.baseUrl
      } else if (providerId === 'deepseek' && !form.baseUrl) {
        payload[providerId].baseUrl = 'https://api.deepseek.com/v1'
      }

      if ('endpoint' in form && form.endpoint) {
        payload[providerId].endpoint = form.endpoint
      }
      if ('apiVersion' in form && form.apiVersion) {
        payload[providerId].apiVersion = form.apiVersion
      }

      const result = await saveApiKeys(payload)
      setSaved(result.keys)
      setEditingProviders((prev) => { const n = new Set(prev); n.delete(providerId); return n })
      setMessages({ [providerId]: { type: 'success', text: '已保存' } })

      if (form.apiKey && form.apiKey !== '••••••••') {
        setForms((prev) => ({ ...prev, [providerId]: { ...prev[providerId], apiKey: '' } }))
      }

      setShowAddDropdown(false)
    } catch (err: any) {
      setMessages({ [providerId]: { type: 'error', text: err.message || '保存失败' } })
    } finally {
      setSaving((prev) => ({ ...prev, [providerId]: false }))
    }
  }

  const handleDelete = async (providerId: string) => {
    setSaving((prev) => ({ ...prev, [providerId]: true }))
    try {
      const result = await deleteApiKey(providerId)
      setSaved(result.keys)
      setEditingProviders((prev) => { const n = new Set(prev); n.delete(providerId); return n })
      setForms((prev) => ({ ...prev, [providerId]: { apiKey: '', baseUrl: '', endpoint: '', apiVersion: '' } }))
      setMessages({ [providerId]: { type: 'success', text: '已删除' } })
      setTestResults((prev) => { const n = { ...prev }; delete n[providerId]; return n })
    } catch (err: any) {
      setMessages({ [providerId]: { type: 'error', text: err.message || '删除失败' } })
    } finally {
      setSaving((prev) => ({ ...prev, [providerId]: false }))
    }
  }

  const handleTest = async (providerId: string) => {
    setTesting((prev) => ({ ...prev, [providerId]: true }))
    setTestResults((prev) => { const n = { ...prev }; delete n[providerId]; return n })
    try {
      const result = await testApiKey(providerId)
      setTestResults({ [providerId]: { success: result.success, message: result.success ? '连接成功' : (result.details || result.message) } })
    } catch (err: any) {
      setTestResults({ [providerId]: { success: false, message: err.message || '网络请求失败' } })
    } finally {
      setTesting((prev) => ({ ...prev, [providerId]: false }))
    }
  }

  const handleAddProvider = (providerId: string) => {
    setShowAddDropdown(false)
    setEditingProviders((prev) => new Set(prev).add(providerId))
    // Pre-fill with defaults
    const def = ALL_PROVIDERS.find((p) => p.id === providerId)
    if (def) {
      setForms((prev) => ({
        ...prev,
        [providerId]: {
          apiKey: '',
          baseUrl: def.defaultBaseUrl || '',
          endpoint: '',
          apiVersion: def.defaultApiVersion || '',
        },
      }))
    }
  }

  if (loading) {
    return <div className="text-gray-400 text-center py-16">加载中...</div>
  }

  const configuredIds = getConfiguredProviders()
  const availableProviders = getAvailableProviders()

  // Find providers that are being added (selected from dropdown but not yet saved)
  const newProviderIds = ALL_PROVIDERS
    .filter((p) => !configuredIds.includes(p.id) && editingProviders.has(p.id))
    .map((p) => p.id)

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">API Key 配置</h1>
          <p className="text-sm text-gray-500 mt-2">
            为你使用的模型配置 API Key。训练启动时会自动选择对应的密钥。
          </p>
        </div>
      </div>

      {/* Configured providers */}
      <div className="space-y-5">
        {ALL_PROVIDERS.map((provider) => {
          const isConfigured = configuredIds.includes(provider.id)
          const isBeingEdited = newProviderIds.includes(provider.id)

          if (!isConfigured && !isBeingEdited) return null

          const savedCfg = (saved as any)[provider.id]
          const msg = messages[provider.id]

          return (
            <div key={provider.id} className="bg-white border border-gray-200 rounded-2xl p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div
                    className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                      isConfigured ? 'bg-green-100' : 'bg-gray-100'
                    }`}
                  >
                    <Key className={`w-5 h-5 ${isConfigured ? 'text-green-600' : 'text-gray-400'}`} />
                  </div>
                  <div>
                    <h3 className="font-semibold text-gray-900">{provider.name}</h3>
                    <p className="text-xs text-gray-500">{provider.desc}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {isConfigured ? (
                    <span className="flex items-center gap-1 text-xs font-medium text-green-600 bg-green-50 px-2.5 py-1 rounded-full">
                      <Check className="w-3.5 h-3.5" />
                      已配置
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-xs font-medium text-orange-600 bg-orange-50 px-2.5 py-1 rounded-full">
                      <AlertCircle className="w-3.5 h-3.5" />
                      填写中
                    </span>
                  )}
                </div>
              </div>

              <div className="space-y-3">
                {/* API Key */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1.5">
                    API Key
                    {isConfigured && !forms[provider.id]?.apiKey && (
                      <span className="ml-1.5 text-gray-400 font-normal">— 输入新 key 可更换</span>
                    )}
                  </label>
                  <div className="relative">
                    <input
                      type={showKeys[provider.id] ? 'text' : 'password'}
                      value={forms[provider.id]?.apiKey || ''}
                      onChange={(e) =>
                        setForms((prev) => ({
                          ...prev,
                          [provider.id]: { ...prev[provider.id], apiKey: e.target.value },
                        }))
                      }
                      placeholder={isConfigured ? `已配置 (${savedCfg.apiKeyPreview})` : 'sk-...'}
                      className="w-full px-3 py-2.5 bg-gray-50 rounded-xl text-sm border border-gray-200 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent pr-10"
                    />
                    <button
                      onClick={() => setShowKeys((prev) => ({ ...prev, [provider.id]: !prev[provider.id] }))}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    >
                      {showKeys[provider.id] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {/* Base URL */}
                {provider.fields.includes('baseUrl') && (
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1.5">
                      Base URL <span className="text-gray-400 font-normal">(可选)</span>
                    </label>
                    <input
                      type="text"
                      value={forms[provider.id]?.baseUrl || ''}
                      onChange={(e) =>
                        setForms((prev) => ({
                          ...prev,
                          [provider.id]: { ...prev[provider.id], baseUrl: e.target.value },
                        }))
                      }
                      placeholder={provider.defaultBaseUrl || 'https://api.openai.com/v1'}
                      className="w-full px-3 py-2.5 bg-gray-50 rounded-xl text-sm border border-gray-200 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent"
                    />
                  </div>
                )}

                {/* Endpoint (Azure) */}
                {provider.fields.includes('endpoint') && (
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1.5">Endpoint</label>
                    <input
                      type="text"
                      value={forms[provider.id]?.endpoint || ''}
                      onChange={(e) =>
                        setForms((prev) => ({
                          ...prev,
                          [provider.id]: { ...prev[provider.id], endpoint: e.target.value },
                        }))
                      }
                      placeholder="https://your-resource.openai.azure.com/"
                      className="w-full px-3 py-2.5 bg-gray-50 rounded-xl text-sm border border-gray-200 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent"
                    />
                  </div>
                )}

                {/* API Version (Azure) */}
                {provider.fields.includes('apiVersion') && (
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1.5">API Version</label>
                    <input
                      type="text"
                      value={forms[provider.id]?.apiVersion || ''}
                      onChange={(e) =>
                        setForms((prev) => ({
                          ...prev,
                          [provider.id]: { ...prev[provider.id], apiVersion: e.target.value },
                        }))
                      }
                      placeholder="2024-12-01-preview"
                      className="w-full px-3 py-2.5 bg-gray-50 rounded-xl text-sm border border-gray-200 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent"
                    />
                  </div>
                )}
              </div>

              {/* Actions */}
              <div className="flex items-center justify-between mt-4 pt-3 border-t border-gray-100">
                <div>
                  {msg && (
                    <span
                      className={`text-xs font-medium ${
                        msg.type === 'success' ? 'text-green-600' : 'text-red-600'
                      }`}
                    >
                      {msg.text}
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  {isConfigured && (
                    <button
                      onClick={() => handleDelete(provider.id)}
                      disabled={saving[provider.id]}
                      className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      删除
                    </button>
                  )}
                  <button
                    onClick={() => handleSave(provider.id)}
                    disabled={saving[provider.id]}
                    className="px-4 py-2 bg-gray-900 text-white text-xs font-medium rounded-lg hover:bg-gray-800 transition-colors disabled:opacity-50"
                  >
                    {saving[provider.id] ? '保存中...' : isConfigured ? '更新' : '保存'}
                  </button>
                </div>
              </div>

              {/* Test button & result — only for configured providers */}
              {isConfigured && (
                <div className="mt-3 pt-3 border-t border-gray-100">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => handleTest(provider.id)}
                      disabled={testing[provider.id]}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
                    >
                      {testing[provider.id] ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Zap className="w-3.5 h-3.5" />
                      )}
                      测试连接
                    </button>
                    {testResults[provider.id] && (
                      <span
                        className={`text-xs font-medium ${
                          testResults[provider.id].success ? 'text-green-600' : 'text-red-600'
                        }`}
                      >
                        {testResults[provider.id].success ? '✓' : '✗'} {testResults[provider.id].message}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Empty state */}
      {configuredIds.length === 0 && newProviderIds.length === 0 && (
        <div className="text-center py-16 bg-gray-50 rounded-2xl border-2 border-dashed border-gray-200">
          <Key className="w-12 h-12 text-gray-300 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-700 mb-2">尚未配置任何 API Key</h3>
          <p className="text-sm text-gray-500 mb-6">
            点击下方按钮添加一个 API 提供商配置
          </p>
        </div>
      )}

      {/* Add button */}
      <div className="mt-6 relative">
        {availableProviders.length > 0 ? (
          <>
            <button
              onClick={() => setShowAddDropdown(!showAddDropdown)}
              className="flex items-center gap-2 px-4 py-2.5 bg-white border-2 border-dashed border-gray-300 rounded-xl text-sm font-medium text-gray-600 hover:border-gray-400 hover:text-gray-800 transition-colors"
            >
              <Plus className="w-4 h-4" />
              新增配置
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showAddDropdown ? 'rotate-180' : ''}`} />
            </button>

            {showAddDropdown && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowAddDropdown(false)} />
                <div className="absolute left-0 top-full mt-1 z-20 w-64 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden">
                  <div className="px-3 py-2 border-b border-gray-100">
                    <p className="text-xs text-gray-500">选择一个提供商</p>
                  </div>
                  {availableProviders.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => handleAddProvider(p.id)}
                      className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 transition-colors"
                    >
                      <div className="w-8 h-8 bg-gray-100 rounded-lg flex items-center justify-center">
                        <Key className="w-4 h-4 text-gray-500" />
                      </div>
                      <div>
                        <div className="text-sm font-medium text-gray-900">{p.name}</div>
                        <div className="text-xs text-gray-500">{p.desc}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </>
            )}
          </>
        ) : (
          <div className="text-center py-4">
            <p className="text-xs text-gray-400">所有提供商已配置完毕</p>
          </div>
        )}
      </div>

      {/* Info box */}
      <div className="mt-8 bg-blue-50 border border-blue-100 rounded-2xl p-5">
        <h4 className="font-medium text-blue-900 mb-2">如何使用</h4>
        <ul className="text-sm text-blue-700 space-y-1.5">
          <li>• 点击「新增配置」选择要使用的 AI 服务提供商</li>
          <li>• 填入 API Key 和对应参数后点击保存</li>
          <li>• 新建训练时选择对应模型，系统会自动注入正确的环境变量</li>
          <li>• Key 经过加密处理存储在服务器本地，不会泄漏到前端</li>
          <li>• 使用 <strong>DeepSeek</strong> 模型时，Base URL 默认为 <code className="bg-blue-100 px-1.5 py-0.5 rounded text-xs">https://api.deepseek.com/v1</code></li>
        </ul>
      </div>
    </div>
  )
}

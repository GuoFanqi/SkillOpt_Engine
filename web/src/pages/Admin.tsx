import { useState, useEffect } from 'react'
import { Database, Table, ArrowLeft, Shield, Trash2, Save, Plus, Edit2, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

const API = 'http://localhost:3002/api/admin'
const TABLE_LIST = ['users', 'training_runs', 'templates', 'step_history', 'skill_versions', 'training_data_items', 'training_logs', 'evaluation_details', 'user_skills']

export default function AdminPage() {
  const { token, isAdmin } = useAuth()
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  if (!token) return <div className="p-8 text-center text-gray-400">请先登录</div>
  if (!isAdmin) return <div className="p-8 text-center text-red-500 font-medium">无权访问管理后台</div>

  const [dbSummary, setDbSummary] = useState<Record<string, number>>({})
  const [selectedTable, setSelectedTable] = useState('')
  const [tableData, setTableData] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [editingRow, setEditingRow] = useState<any>(null)
  const [editValues, setEditValues] = useState<Record<string, string>>({})
  const [editCols, setEditCols] = useState<string[]>([])
  const [showNewUser, setShowNewUser] = useState(false)
  const [newUser, setNewUser] = useState({ phone: '', password: '', is_admin: false })
  const [toast, setToast] = useState('')

  useEffect(() => {
    fetch(`${API}/db-summary`, { headers }).then(r => r.json()).then(setDbSummary).catch(() => {})
  }, [])

  const loadTable = async (table: string) => {
    setSelectedTable(table); setLoading(true); setEditingRow(null)
    try { const res = await fetch(`${API}/table/${table}`, { headers }); setTableData(await res.json()) }
    catch {} finally { setLoading(false) }
  }

  const deleteRow = async (table: string, id: any) => {
    if (!confirm(`确定删除 ${table} #${id}？不可撤销。`)) return
    await fetch(`${API}/table/${table}/${id}`, { method: 'DELETE', headers })
    setToast(`已删除 ${table} #${id}`); setTimeout(() => setToast(''), 2000)
    loadTable(table)
  }

  const startEdit = (row: any) => {
    setEditingRow(row)
    const keys = Object.keys(row)
    setEditCols(keys)
    const vals: Record<string, string> = {}
    for (const [k, v] of Object.entries(row)) vals[k] = v === null ? '' : String(v)
    setEditValues(vals)
  }

  const saveEdit = async () => {
    if (!editingRow || !selectedTable) return
    const body: Record<string, any> = {}
    for (const [k, v] of Object.entries(editValues)) {
      if (v === '' || v === 'null') body[k] = null
      else if (v === 'true') body[k] = true
      else if (v === 'false') body[k] = false
      else if (/^-?\d+$/.test(v) && k !== 'phone') body[k] = parseInt(v)
      else if (/^-?\d+\.\d+$/.test(v)) body[k] = parseFloat(v)
      else body[k] = v
    }
    await fetch(`${API}/table/${selectedTable}/${editingRow.id}`, { method: 'PUT', headers, body: JSON.stringify(body) })
    setEditingRow(null); setToast('保存成功'); setTimeout(() => setToast(''), 2000)
    loadTable(selectedTable)
  }

  const createUser = async () => {
    const res = await fetch(`${API}/users`, { method: 'POST', headers, body: JSON.stringify(newUser) })
    if (res.ok) { setShowNewUser(false); setNewUser({ phone: '', password: '', is_admin: false }); loadTable('users'); setToast('用户已创建') }
    else { const e = await res.json(); setToast(e.error) }
    setTimeout(() => setToast(''), 2000)
  }

  // Highlighted columns for better readability
  const highlightCol = (k: string, v: any) => {
    if (k === 'password_hash') return <span className="text-gray-400 font-mono text-[11px]">{String(v).slice(0, 30)}...</span>
    if (k === 'password_plain') return <span className="text-gray-300 italic">已移除</span>
    if (k === 'is_admin' || k === 'is_correct' || k === 'slow_update') return v === 1 || v === true ? '✅' : '❌'
    if (k === 'status') return <span className={v === 'completed' ? 'text-green-600' : v === 'training' ? 'text-blue-600' : v === 'failed' ? 'text-red-600' : v === 'stopped' ? 'text-orange-500' : 'text-gray-600'}>{v}</span>
    if (v === null) return <span className="text-gray-300 italic">NULL</span>
    return String(v).slice(0, 80)
  }

  const cols = tableData.length > 0 ? Object.keys(tableData[0]) : []

  return (
    <div className="max-w-full mx-auto px-4 py-6 space-y-6">
      <div className="flex items-center gap-4">
        <Link to="/" className="p-2 hover:bg-gray-100 rounded-xl"><ArrowLeft className="w-5 h-5 text-gray-500" /></Link>
        <Shield className="w-6 h-6 text-red-500" />
        <h1 className="text-xl font-bold text-gray-900">管理后台</h1>
        {toast && <span className="text-xs bg-green-50 text-green-600 px-3 py-1 rounded-full">{toast}</span>}
      </div>

      {/* Table selector + Quick Actions */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        <div className="lg:col-span-3 bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
            <Database className="w-4 h-4 text-gray-500" />
            <h2 className="text-sm font-semibold text-gray-700">数据库表</h2>
            <span className="text-[10px] text-gray-400 ml-auto">点击查看所有字段</span>
          </div>
          <div className="p-4 grid grid-cols-3 gap-3">
            {TABLE_LIST.map(t => (
              <button key={t} onClick={() => loadTable(t)}
                className={`text-left p-3 rounded-xl border transition-colors ${selectedTable === t ? 'bg-indigo-50 border-indigo-200 ring-1 ring-indigo-200' : 'bg-gray-50 border-gray-100 hover:bg-gray-100'}`}>
                <div className="text-[10px] text-gray-400 font-mono">{t}</div>
                <div className="text-lg font-bold text-gray-700">{dbSummary[t] || 0} <span className="text-[10px] text-gray-400 font-normal">条</span></div>
              </button>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 p-5 space-y-3">
          <h3 className="text-sm font-semibold text-gray-700">新建用户</h3>
          <button onClick={() => { setShowNewUser(!showNewUser); loadTable('users') }}
            className="w-full py-2 bg-indigo-500 text-white rounded-xl text-sm font-medium hover:bg-indigo-600 flex items-center justify-center gap-1.5">
            <Plus className="w-3.5 h-3.5" /> 新建用户
          </button>
          {showNewUser && (
            <div className="space-y-2 pt-2">
              <input placeholder="手机号" value={newUser.phone} onChange={e => setNewUser(p => ({ ...p, phone: e.target.value }))}
                className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-xs" />
              <input placeholder="密码" type="text" value={newUser.password} onChange={e => setNewUser(p => ({ ...p, password: e.target.value }))}
                className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-xs" />
              <label className="flex items-center gap-2 text-xs text-gray-600">
                <input type="checkbox" checked={newUser.is_admin} onChange={e => setNewUser(p => ({ ...p, is_admin: e.target.checked }))} /> 管理员
              </label>
              <button onClick={createUser} className="w-full py-1.5 bg-green-500 text-white rounded-lg text-xs font-medium">创建</button>
            </div>
          )}
          {/* Reset Password (users table only) */}
          {selectedTable === 'users' && <ResetPassword token={token!} onDone={() => { setToast('密码已重置'); setTimeout(() => setToast(''), 2000); loadTable('users') }} />}
          {selectedTable && (
            <div className="pt-2 border-t border-gray-100">
              <div className="text-[10px] text-gray-400 mb-1">当前表: {selectedTable}</div>
              <button onClick={() => loadTable(selectedTable)} className="w-full py-1.5 bg-gray-100 text-gray-600 rounded-lg text-xs hover:bg-gray-200">刷新数据</button>
            </div>
          )}
        </div>
      </div>

      {/* Data Table - ALL columns */}
      {selectedTable && (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2 justify-between">
            <div className="flex items-center gap-2">
              <Table className="w-4 h-4 text-gray-500" />
              <h2 className="text-sm font-semibold text-gray-700 font-mono">{selectedTable}</h2>
              <span className="text-[10px] text-gray-400">{tableData.length} 行 · {cols.length} 列</span>
              {loading && <span className="text-[10px] text-gray-400 animate-pulse">加载中...</span>}
            </div>
          </div>

          {/* Inline Edit Panel */}
          {editingRow && (
            <div className="bg-amber-50 border-b border-amber-100 p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-semibold text-amber-700">编辑 #{selectedTable} ID: {editingRow.id}</span>
                <div className="flex items-center gap-2">
                  <button onClick={saveEdit} className="px-3 py-1.5 bg-green-500 text-white rounded-lg text-xs font-medium flex items-center gap-1 hover:bg-green-600"><Save className="w-3 h-3" /> 保存修改</button>
                  <button onClick={() => setEditingRow(null)} className="px-2 py-1.5 bg-white border border-gray-200 rounded-lg text-xs text-gray-600 hover:bg-gray-50"><X className="w-3 h-3" /></button>
                </div>
              </div>
              <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
                {editCols.map(k => (
                  <div key={k}>
                    <div className="text-[9px] text-gray-500 mb-0.5 truncate font-mono">{k}</div>
                    <input value={editValues[k] || ''} onChange={e => setEditValues(v => ({ ...v, [k]: e.target.value }))}
                      className="w-full px-2 py-1.5 border border-amber-200 rounded text-[10px] font-mono focus:outline-none focus:ring-1 focus:ring-amber-400 bg-white" />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Table with all columns */}
          <div className="overflow-auto max-h-[600px]">
            <table className="w-full text-[10px] table-auto">
              <thead className="bg-gray-50 text-gray-500 sticky top-0 z-10">
                <tr>
                  <th className="text-left px-3 py-2 font-medium whitespace-nowrap sticky left-0 bg-gray-50 z-20">#</th>
                  {cols.map(k => (
                    <th key={k} className="text-left px-3 py-2 font-medium whitespace-nowrap">{k}</th>
                  ))}
                  <th className="text-center px-3 py-2 font-medium sticky right-0 bg-gray-50 z-20 w-[90px]">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {tableData.map((row, i) => (
                  <tr key={i} className="hover:bg-indigo-50/30 group">
                    <td className="px-3 py-2 text-gray-400 sticky left-0 bg-white group-hover:bg-indigo-50/30">{i + 1}</td>
                    {cols.map(k => (
                      <td key={k} className="px-3 py-2 text-gray-700 max-w-[200px] truncate" title={row[k] !== null ? String(row[k]) : 'NULL'}>
                        {highlightCol(k, row[k])}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-center sticky right-0 bg-white group-hover:bg-indigo-50/30">
                      <div className="flex items-center justify-center gap-1">
                        <button onClick={() => startEdit(row)} className="p-1.5 hover:bg-indigo-100 rounded-lg" title="编辑">
                          <Edit2 className="w-3 h-3 text-indigo-500" />
                        </button>
                        <button onClick={() => deleteRow(selectedTable, row.id)} className="p-1.5 hover:bg-red-100 rounded-lg" title="删除">
                          <Trash2 className="w-3 h-3 text-red-400" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function ResetPassword({ token, onDone }: { token: string; onDone: () => void }) {
  const [userId, setUserId] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  const handleReset = async () => {
    if (!userId || !newPassword) return
    await fetch(`${API}/reset-password`, { method: 'POST', headers, body: JSON.stringify({ user_id: parseInt(userId), password: newPassword }) })
    setUserId(''); setNewPassword(''); onDone()
  }

  return (
    <div className="pt-2 border-t border-gray-100 space-y-2">
      <div className="text-[10px] text-gray-500 font-medium">重置密码</div>
      <input placeholder="用户ID" value={userId} onChange={e => setUserId(e.target.value)} className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-xs" />
      <input placeholder="新密码" type="text" value={newPassword} onChange={e => setNewPassword(e.target.value)} className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-xs" />
      <button onClick={handleReset} className="w-full py-1.5 bg-red-500 text-white rounded-lg text-xs font-medium hover:bg-red-600">重置密码</button>
    </div>
  )
}

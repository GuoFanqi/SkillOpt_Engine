import { Fragment, useState, type ReactNode } from 'react'
import { Routes, Route, useParams } from 'react-router-dom'
import Layout from './components/Layout'
import ToastProvider from './components/Toast'
import ConfirmDialogProvider from './components/ConfirmDialog'
import AuthModal from './components/AuthModal'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { WebSocketProvider } from './hooks/useWebSocket'
import Dashboard from './pages/Dashboard'
import TrainingList from './pages/TrainingList'
import TrainingDetail from './pages/TrainingDetail'
import SkillBrowser from './pages/SkillBrowser'
import SkillEditor from './pages/SkillEditor'
import Playground from './pages/Playground'
import Compare from './pages/Compare'
import Settings from './pages/Settings'
import TemplateLibrary from './pages/TemplateLibrary'
import AdminPage from './pages/Admin'

function PrivatePage({ children }: { children: ReactNode }) {
  const { user, token, loading } = useAuth()
  const [showLogin, setShowLogin] = useState(false)
  if (loading) return <div className="p-8 text-gray-500">正在验证登录状态…</div>
  if (!user) return (
    <div className="p-8 text-center space-y-4">
      <h1 className="text-xl font-semibold">请先登录</h1>
      <p className="text-gray-500">训练、技能和运行数据仅对所属用户开放。公开模板仍可浏览。</p>
      <button onClick={() => setShowLogin(true)} className="btn-primary">登录</button>
      <AuthModal isOpen={showLogin} onClose={() => setShowLogin(false)} />
    </div>
  )
  return <Fragment key={token}>{children}</Fragment>
}

function SessionLayout() {
  const { token } = useAuth()
  return <Layout key={token ?? 'guest'} />
}

function TrainingDetailPage() {
  const { id } = useParams()
  return <TrainingDetail key={id} />
}

function App() {
  return (
    <AuthProvider>
      <WebSocketProvider>
        <ToastProvider>
          <ConfirmDialogProvider>
            <Routes>
              <Route path="/" element={<SessionLayout />}>
                <Route index element={<PrivatePage><Dashboard /></PrivatePage>} />
                <Route path="training" element={<PrivatePage><TrainingList /></PrivatePage>} />
                <Route path="training/:id" element={<PrivatePage><TrainingDetailPage /></PrivatePage>} />
                <Route path="templates" element={<TemplateLibrary />} />
                <Route path="skill" element={<PrivatePage><SkillBrowser /></PrivatePage>} />
                <Route path="skill/:id" element={<PrivatePage><SkillEditor /></PrivatePage>} />
                <Route path="playground" element={<PrivatePage><Playground /></PrivatePage>} />
                <Route path="compare" element={<PrivatePage><Compare /></PrivatePage>} />
                <Route path="settings" element={<PrivatePage><Settings /></PrivatePage>} />
                <Route path="admin" element={<PrivatePage><AdminPage /></PrivatePage>} />
              </Route>
            </Routes>
          </ConfirmDialogProvider>
        </ToastProvider>
      </WebSocketProvider>
    </AuthProvider>
  )
}

export default App

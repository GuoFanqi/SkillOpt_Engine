import { Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import ToastProvider from './components/Toast'
import ConfirmDialogProvider from './components/ConfirmDialog'
import { AuthProvider } from './contexts/AuthContext'
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
function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <ConfirmDialogProvider>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="training" element={<TrainingList />} />
            <Route path="training/:id" element={<TrainingDetail />} />
            <Route path="templates" element={<TemplateLibrary />} />
            <Route path="skill" element={<SkillBrowser />} />
            <Route path="skill/:id" element={<SkillEditor />} />
            <Route path="playground" element={<Playground />} />
            <Route path="compare" element={<Compare />} />
            <Route path="settings" element={<Settings />} />
            <Route path="admin" element={<AdminPage />} />
          </Route>
        </Routes>
        </ConfirmDialogProvider>
      </ToastProvider>
    </AuthProvider>
  )
}

export default App

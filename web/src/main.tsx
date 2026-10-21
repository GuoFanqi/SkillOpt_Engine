import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { BrowserRouter } from 'react-router-dom'

// 移除 index.html 中的 preloader（React 渲染后渐隐）
const hidePreloader = () => {
  const el = document.getElementById('preloader')
  if (el) {
    el.style.opacity = '0'
    setTimeout(() => el.remove(), 350)
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)

// React 首次渲染后移除 preloader
requestAnimationFrame(() => {
  requestAnimationFrame(hidePreloader)
})

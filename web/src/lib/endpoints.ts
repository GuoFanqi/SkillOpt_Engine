export const API_BASE = (import.meta.env?.VITE_API_BASE_URL || 'http://localhost:3002/api').replace(/\/+$/, '')

export function socketUrl(): string {
  const url = new URL(API_BASE, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = url.pathname.replace(/\/api\/?$/, '') || '/'
  url.search = ''
  url.hash = ''
  return url.toString()
}

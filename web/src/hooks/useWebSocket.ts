import { createContext, createElement, useContext, useEffect, useState, type ReactNode } from 'react'
import type { RunSocketMessage, RunState } from '../../shared/run-state'
import { useAuth } from '../contexts/AuthContext'
import { chooseRunState, isRunState } from '../lib/runState'
import { socketUrl } from '../lib/endpoints'

export type LiveMessage = Exclude<RunSocketMessage, { type: 'authenticated' }> & {
  id: number
  receivedAt: string
}

interface SocketSnapshot {
  token: string | null
  isConnected: boolean
  connectionVersion: number
  messages: LiveMessage[]
  states: Record<string, RunState>
  timings: Record<string, Record<string, number>>
}

const emptySnapshot: SocketSnapshot = {
  token: null, isConnected: false, connectionVersion: 0, messages: [], states: {}, timings: {},
}
const SocketContext = createContext<SocketSnapshot>(emptySnapshot)

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const { token, user } = useAuth()
  const [snapshot, setSnapshot] = useState<SocketSnapshot>(emptySnapshot)

  useEffect(() => {
    setSnapshot({ ...emptySnapshot, token })
    if (!token || !user) return
    let disposed = false
    let socket: WebSocket | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    let authTimer: ReturnType<typeof setTimeout> | undefined
    let sequence = 0
    let backoff = 500

    const connect = () => {
      if (disposed) return
      const ws = new WebSocket(socketUrl())
      socket = ws
      let authenticated = false
      ws.onopen = () => {
        if (disposed || socket !== ws) return
        ws.send(JSON.stringify({ type: 'auth', token }))
        authTimer = setTimeout(() => ws.close(1000, 'authentication timeout'), 8000)
      }
      ws.onmessage = event => {
        if (disposed || socket !== ws) return
        let message: RunSocketMessage
        try {
          const parsed: unknown = JSON.parse(event.data)
          if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) return
          message = parsed as RunSocketMessage
        } catch { return }
        if (message.type === 'authenticated') {
          authenticated = true
          clearTimeout(authTimer)
          backoff = 500
          setSnapshot(prev => ({ ...prev, isConnected: true, connectionVersion: prev.connectionVersion + 1 }))
          return
        }
        if (!authenticated || !('runId' in message) || typeof message.runId !== 'string') return
        const runId = message.runId
        if (message.type === 'state' && isRunState(message.data)) {
          const incoming = message.data
          setSnapshot(prev => {
            const accepted = chooseRunState(prev.states[runId], incoming)
            if (accepted === prev.states[runId]) return prev
            return { ...prev, states: { ...prev.states, [runId]: accepted } }
          })
        } else if ((message.type === 'log' || message.type === 'error') && typeof message.data === 'string') {
          const entry: LiveMessage = { ...message, id: ++sequence, receivedAt: new Date().toISOString() }
          setSnapshot(prev => ({ ...prev, messages: [...prev.messages, entry].slice(-500) }))
        } else if (message.type === 'timing' && message.data && typeof message.data === 'object'
          && Object.values(message.data).every(value => typeof value === 'number' && Number.isFinite(value))) {
          const timing = message.data
          setSnapshot(prev => ({ ...prev, timings: { ...prev.timings, [runId]: timing } }))
        }
      }
      ws.onclose = event => {
        clearTimeout(authTimer)
        if (disposed || socket !== ws) return
        setSnapshot(prev => ({ ...prev, isConnected: false }))
        if (event.code === 1008 || event.code === 4001 || event.code === 4401) {
          window.dispatchEvent(new CustomEvent('skillopt-auth-expired', { detail: token }))
          return
        }
        retry = setTimeout(connect, backoff)
        backoff = Math.min(backoff * 2, 5000)
      }
      ws.onerror = () => ws.close()
    }
    connect()
    return () => {
      disposed = true
      clearTimeout(retry)
      clearTimeout(authTimer)
      socket?.close()
    }
  }, [token, user?.id])

  const value = snapshot.token === token && user ? snapshot : emptySnapshot
  return createElement(SocketContext.Provider, { value }, children)
}

export function useWebSocket() {
  return useContext(SocketContext)
}

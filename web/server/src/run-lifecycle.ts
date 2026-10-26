import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { RunState } from '../../shared/run-state'
import { isTerminal, mergeTrainerSnapshot, newRunState, parseTrainerSnapshot, readState, STATE_PREFIX } from './run-state.js'
import type { TrainerSnapshot } from './run-state.js'

export class RunConflict extends Error {
  status = 409
}

interface ManagedRun {
  process?: ChildProcess
  state: RunState
  trainer?: TrainerSnapshot
  sequence: number
  stopped: boolean
  closed: Promise<void>
  resolveClosed: () => void
  queue: Promise<void>
  protocolError?: string
  stderr: string
}

interface LifecycleOptions {
  persist: (id: string, state: RunState) => Promise<boolean>
  publish: (id: string, state: RunState) => void
  log: (id: string, stream: 'stdout' | 'stderr', text: string) => void
  completed: (id: string) => Promise<void>
}

export class RunLifecycle {
  private entries = new Map<string, ManagedRun>()
  private locks = new Set<string>()

  constructor(private options: LifecycleOptions) {}

  get(id: string): RunState | null {
    return this.entries.get(id)?.state ?? null
  }

  isActive(id: string): boolean {
    const entry = this.entries.get(id)
    return !!entry && !isTerminal(entry.state.status)
  }

  async exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (this.locks.has(id)) throw new RunConflict('任务正在处理另一项操作，请稍后重试')
    this.locks.add(id)
    try { return await operation() } finally { this.locks.delete(id) }
  }

  async prepare(id: string, previousValue: unknown): Promise<RunState> {
    if (this.isActive(id)) throw new RunConflict('任务仍在运行')
    const previous = this.get(id) ?? readState(previousValue)
    const state = newRunState(randomUUID(), (previous?.attempt ?? 0) + 1)
    let resolveClosed!: () => void
    const entry: ManagedRun = {
      state, sequence: 0, stopped: false, queue: Promise.resolve(), stderr: '',
      closed: new Promise(resolve => { resolveClosed = resolve }), resolveClosed,
    }
    if (!await this.options.persist(id, state)) throw new RunConflict('启动状态已被更新，请刷新后重试')
    this.entries.set(id, entry)
    this.options.publish(id, state)
    return state
  }

  private async persist(id: string, entry: ManagedRun, state: RunState): Promise<void> {
    if (this.entries.get(id) !== entry) return
    entry.state = state
    try {
      if (!await this.options.persist(id, state)) return
      delete entry.state.persistenceError
    } catch (error) {
      entry.state.persistenceError = `状态保存失败：${error instanceof Error ? error.message : String(error)}`
      this.options.log(id, 'stderr', entry.state.persistenceError)
    }
    this.options.publish(id, { ...entry.state })
  }

  attach(id: string, instanceId: string, child: ChildProcess, runPath: string): void {
    const entry = this.entries.get(id)
    if (!entry || entry.state.instanceId !== instanceId || entry.process) throw new RunConflict('训练实例不匹配')
    entry.process = child
    let buffered = ''
    const handleLine = (line: string) => {
      if (!line.startsWith(STATE_PREFIX)) {
        if (line) this.options.log(id, 'stdout', line + '\n')
        return
      }
      entry.queue = entry.queue.then(async () => {
        if (this.entries.get(id) !== entry || isTerminal(entry.state.status)) return
        try {
          const snapshot = parseTrainerSnapshot(line.slice(STATE_PREFIX.length), instanceId)
          if (snapshot.sequence <= entry.sequence) return
          entry.sequence = snapshot.sequence
          entry.trainer = snapshot
          await this.persist(id, entry, mergeTrainerSnapshot(entry.state, snapshot))
        } catch (error) {
          entry.protocolError = `训练状态无效：${error instanceof Error ? error.message : String(error)}`
          this.options.log(id, 'stderr', entry.protocolError)
        }
      })
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffered += chunk
      let newline: number
      while ((newline = buffered.indexOf('\n')) >= 0) {
        handleLine(buffered.slice(0, newline).replace(/\r$/, ''))
        buffered = buffered.slice(newline + 1)
      }
      if (buffered.length > 1024 * 1024) {
        entry.protocolError = '训练输出行超过允许大小'
        buffered = ''
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (text: string) => {
      entry.stderr = (entry.stderr + text).slice(-16000)
      this.options.log(id, 'stderr', text)
    })
    child.on('error', error => { entry.protocolError = error.message })
    child.on('close', (code, signal) => {
      if (buffered) handleLine(buffered)
      entry.queue = entry.queue.then(async () => {
        try {
          if (this.entries.get(id) !== entry) return
          let status: RunState['status'] = 'failed'
          let error = entry.protocolError || entry.trainer?.error || entry.stderr.trim()
          if (entry.stopped) {
            status = 'stopped'
            error = ''
          } else if (code === 0 && !signal && !entry.protocolError) {
            try {
              const summary = JSON.parse(await readFile(join(runPath, 'summary.json'), 'utf8'))
              if (
                entry.trainer?.status !== 'completed' || summary.status !== 'completed'
                || summary.runtime_instance_id !== instanceId
                || summary.recipe_hash !== entry.trainer.recipe_hash
              ) throw new Error('缺少当前训练实例的完整评测结果')
              status = 'completed'
              error = ''
            } catch (failure) {
              error = failure instanceof Error ? failure.message : String(failure)
            }
          }
          if (status === 'failed' && !error) error = `训练异常退出（code=${code}, signal=${signal}）`
          await this.persist(id, entry, {
            ...entry.state, version: entry.state.version + 1, status, phase: status,
            updatedAt: new Date().toISOString(), artifactSync: status === 'completed' ? 'syncing' : 'pending',
            error: error || undefined,
          })
          if (status === 'completed') {
            try {
              await this.options.completed(id)
              await this.setArtifactState(id, instanceId, 'synced')
            } catch (failure) {
              await this.setArtifactState(id, instanceId, 'failed', failure instanceof Error ? failure.message : String(failure))
            }
          }
        } finally {
          entry.resolveClosed()
        }
      })
    })
  }

  async setArtifactState(id: string, instanceId: string, state: RunState['artifactSync'], error?: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry || entry.state.instanceId !== instanceId) return
    await this.persist(id, entry, {
      ...entry.state, version: entry.state.version + 1, updatedAt: new Date().toISOString(),
      artifactSync: state, artifactError: error,
    })
  }

  async stop(id: string, timeout = 10000): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry?.process || isTerminal(entry.state.status)) throw new RunConflict('无法确认可安全停止的训练进程')
    entry.stopped = true
    if (!entry.process.kill('SIGTERM')) {
      entry.stopped = false
      throw new RunConflict('未能发送停止信号，训练状态未更改')
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        entry.closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new RunConflict('训练尚未退出，不能标记已停止或启动新实例')), timeout)
        }),
      ])
    } finally { if (timer) clearTimeout(timer) }
  }

  async waitForClose(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (entry) await entry.closed
  }
}

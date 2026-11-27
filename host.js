/**
 * Supervises the long-lived PowerShell desktop helper that performs screen
 * capture, window enumeration, and input injection for this plugin.
 *
 * One helper process is shared by every call. Requests are serialized so that
 * pointer and keyboard actions keep the order the model intended, and a crash
 * rejects everything in flight so the next call starts a fresh process instead
 * of writing into a half-dead one.
 * @module dsh-computer-use-windows/host
 */

import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

/** Default time one helper request may take. */
const DEFAULT_TIMEOUT_MS = 20_000

/** How long the helper may take to compile its Win32 bindings and report ready. */
const STARTUP_TIMEOUT_MS = 20_000

/** Resolve the Windows PowerShell executable without depending on PATH. */
function powershellPath() {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

/** An error raised by the helper process rather than by this plugin. */
export class DesktopHostError extends Error {
  constructor(message, code = 'DESKTOP_HELPER_ERROR') {
    super(message)
    this.name = 'DesktopHostError'
    this.code = code
  }
}

/**
 * One lazily started, restartable helper process.
 */
export class DesktopHost {
  #scriptPath
  #timeoutMs
  #child = null
  #starting = null
  #ready = false
  #pending = new Map()
  #sequence = 0
  #queue = Promise.resolve()
  #stderrTail = ''
  #disposed = false
  #decoder = new StringDecoder('utf8')
  #buffer = ''

  /**
   * @param options - helper locations and limits.
   * @param options.scriptPath - absolute path of `host.ps1`.
   * @param options.timeoutMs - per-request budget.
   */
  constructor({ scriptPath, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.#scriptPath = scriptPath
    this.#timeoutMs = timeoutMs
  }

  /** Start the helper if it is not running; resolves when it reports ready. */
  async start() {
    if (this.#disposed) throw new DesktopHostError('the desktop helper has been shut down', 'DESKTOP_HELPER_DISPOSED')
    if (this.#child !== null) return
    if (this.#starting !== null) {
      await this.#starting
      return
    }
    this.#starting = this.#spawnHelper()
    try {
      await this.#starting
    } finally {
      this.#starting = null
    }
  }

  /** Spawn the helper and wait for its readiness line. */
  #spawnHelper() {
    return new Promise((resolve, reject) => {
      let settled = false
      const child = spawn(powershellPath(), [
        '-NoProfile',
        '-NonInteractive',
        '-Sta',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        this.#scriptPath,
      ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })

      this.#buffer = ''
      this.#stderrTail = ''

      const startupTimer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill()
        reject(new DesktopHostError(
          `the desktop helper did not start within ${STARTUP_TIMEOUT_MS} ms${this.#stderrDetail()}`,
          'DESKTOP_HELPER_START_TIMEOUT',
        ))
      }, STARTUP_TIMEOUT_MS)

      const failStartup = (message) => {
        if (settled) return
        settled = true
        clearTimeout(startupTimer)
        this.#child = null
        reject(new DesktopHostError(message, 'DESKTOP_HELPER_START_FAILED'))
      }

      child.on('error', (error) => {
        failStartup(`cannot start the desktop helper: ${error.message}`)
        this.#failPending('the desktop helper failed to start')
      })
      child.on('exit', (code) => {
        if (this.#child === child) this.#child = null
        this.#failPending(`the desktop helper exited with code ${code}${this.#stderrDetail()}`)
        if (!settled) failStartup(`the desktop helper exited with code ${code}${this.#stderrDetail()}`)
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        this.#stderrTail = (this.#stderrTail + chunk).slice(-4000)
      })
      child.stdin.on('error', () => { /* the exit handler reports the real failure */ })

      child.stdout.on('data', (chunk) => {
        this.#buffer += this.#decoder.write(chunk)
        let newline = this.#buffer.indexOf('\n')
        while (newline !== -1) {
          const line = this.#buffer.slice(0, newline).replace(/\r$/u, '')
          this.#buffer = this.#buffer.slice(newline + 1)
          this.#handleLine(line)
          if (!settled && this.#ready) {
            settled = true
            clearTimeout(startupTimer)
            resolve()
          }
          newline = this.#buffer.indexOf('\n')
        }
      })

      this.#child = child
      this.#ready = false
    })
  }

  /** Dispatch one decoded helper line to the startup handshake or a waiting call. */
  #handleLine(line) {
    if (line.trim().length === 0) return
    let payload
    try {
      payload = JSON.parse(line)
    } catch {
      return
    }
    if (payload.ready === true) {
      this.#ready = true
      return
    }
    const pending = this.#pending.get(payload.id)
    if (pending === undefined) return
    this.#pending.delete(payload.id)
    clearTimeout(pending.timer)
    if (payload.ok === true) pending.resolve(payload.result)
    else pending.reject(new DesktopHostError(payload.error?.message ?? 'the desktop helper failed', payload.error?.code ?? 'DESKTOP_HELPER_ERROR'))
  }

  /** Reject every in-flight request after the helper died. */
  #failPending(reason) {
    this.#ready = false
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer)
      pending.reject(new DesktopHostError(reason, 'DESKTOP_HELPER_EXITED'))
    }
    this.#pending.clear()
  }

  /** Quote the tail of the helper's stderr for a diagnostic message. */
  #stderrDetail() {
    const tail = this.#stderrTail.trim()
    return tail.length === 0 ? '' : `: ${tail.slice(-600)}`
  }

  /**
   * Perform one operation, serialized behind earlier operations.
   * @param op - helper operation name.
   * @param args - operation arguments.
   * @param overrideTimeoutMs - per-call override for the default budget.
   * @returns the operation result.
   */
  request(op, args = {}, overrideTimeoutMs) {
    const run = async () => {
      await this.start()
      return this.#dispatch(op, args, overrideTimeoutMs ?? this.#timeoutMs)
    }
    const result = this.#queue.then(run, run)
    this.#queue = result.then(() => undefined, () => undefined)
    return result
  }

  /** Write one request to the running helper and await its matching reply. */
  #dispatch(op, args, timeoutMs) {
    const child = this.#child
    if (child === null || !this.#ready) {
      return Promise.reject(new DesktopHostError('the desktop helper is not running', 'DESKTOP_HELPER_NOT_RUNNING'))
    }
    const id = ++this.#sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new DesktopHostError(`the desktop helper did not answer "${op}" within ${timeoutMs} ms${this.#stderrDetail()}`, 'DESKTOP_HELPER_TIMEOUT'))
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer })
      try {
        child.stdin.write(`${JSON.stringify({ id, op, args })}\n`)
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(new DesktopHostError(`cannot talk to the desktop helper: ${error.message}`, 'DESKTOP_HELPER_WRITE_FAILED'))
      }
    })
  }

  /** Stop the helper and reject anything still in flight. */
  dispose() {
    if (this.#disposed) return
    this.#disposed = true
    const child = this.#child
    this.#child = null
    this.#ready = false
    this.#failPending('the desktop helper was shut down')
    if (child !== null) {
      try {
        child.stdin.end()
      } catch { /* already closed */ }
      try {
        child.kill()
      } catch { /* already gone */ }
    }
  }
}

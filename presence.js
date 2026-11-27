/**
 * Owns the desktop presence layer: one WPF overlay process that draws the
 * screen-edge glow, the action card, permission requests, and the reply box.
 *
 * The overlay is a separate OS window because it must stay visible while the
 * agent drives other applications. Host and overlay exchange one JSON object
 * per line; requests are fire-and-forget except permission asks, which resolve
 * like a promise.
 * @module dsh-computer-use-windows/presence
 */

import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

/** How long the overlay may take to compile its XAML and report ready. */
const STARTUP_TIMEOUT_MS = 25_000

/** Resolve the Windows PowerShell executable without depending on PATH. */
function powershellPath() {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

/**
 * One overlay process plus the protocol state that outlives its restarts.
 */
export class Presence {
  #scriptPath
  #cardWidth
  #accent
  #cardHeight
  #cardMargin
  #cardCorner
  #cardX
  #cardY
  #hotkey
  #dockHotkey
  #pauseHotkey
  #child = null
  #ready = false
  #starting = null
  #disposed = false
  #sequence = 0
  #pendingWrites = []
  #asks = new Map()
  #handlers = new Map()
  #stderrTail = ''
  /** Last policy text sent to the running overlay, so it is not sent twice. */
  #sentPolicy = ''
  #decoder = new StringDecoder('utf8')
  #buffer = ''
  /**
   * Which visible accessories are allowed. The Settings page owns the switches,
   * and clean mode turns all of them off at once; the plugin keeps them here so
   * a single place decides what reaches the screen.
   */
  #policy = { glow: true, banner: true, preview: true, card: true, target: true, clickPoint: true, notice: true }

  /**
   * @param options - overlay script path, card size/position, and accent colour.
   */
  constructor({ scriptPath, cardWidth = 520, cardHeight = 680, cardMargin = 0, cardCorner = 'topright', cardX, cardY, accent = '#2F7DF6', hotkey = '', dockHotkey = '', pauseHotkey = 'ctrl+alt+q' }) {
    this.#scriptPath = scriptPath
    this.#cardWidth = cardWidth
    this.#cardHeight = cardHeight
    this.#cardMargin = cardMargin
    this.#cardCorner = cardCorner
    this.#cardX = cardX
    this.#cardY = cardY
    this.#hotkey = hotkey
    this.#dockHotkey = dockHotkey
    this.#pauseHotkey = pauseHotkey
    this.#accent = accent
  }

  /** Replace the accessory policy; missing keys keep their current value. */
  setPolicy(next) {
    this.#policy = { ...this.#policy, ...(next ?? {}) }
    // A running overlay keeps whatever it was last told. Switching an accessory
    // off in Settings has to take it off the screen now — waiting for the next
    // turn is what made "关掉光带" look broken while the card stayed lit.
    this.syncPolicy()
  }

  /**
   * Push the current policy to a running overlay. Deliberately does not start
   * one: turning a switch off must never be the reason an overlay appears.
   * Identical policies are not re-sent — this runs on every tool call.
   */
  syncPolicy() {
    if (!this.#ready) return
    const message = {
      type: 'policy',
      glow: this.#policy.glow !== false,
      card: this.#policy.card !== false,
      banner: this.#policy.banner !== false,
      preview: this.#policy.preview !== false,
      target: this.#policy.target !== false,
      clickPoint: this.#policy.clickPoint !== false,
      notice: this.#policy.notice !== false,
    }
    const text = JSON.stringify(message)
    if (text === this.#sentPolicy) return
    this.#sentPolicy = text
    this.#writeRaw(message)
  }

  /** Whether one accessory is allowed right now. */
  allows(kind) {
    return this.#policy[kind] !== false
  }

  /** Change the edge-glow colour; the overlay picks it up on its next start. */
  setAccent(hex) {
    if (typeof hex === 'string' && hex.length > 0) this.#accent = hex
  }

  /**
   * Where the floating card sits. Read when the overlay spawns, so it follows the
   * same corner as the docked panel instead of being nailed to the top-right.
   */
  setCardPlacement(corner, x, y) {
    if (typeof corner === 'string' && corner.length > 0) this.#cardCorner = corner
    this.#cardX = Number.isInteger(x) ? x : undefined
    this.#cardY = Number.isInteger(y) ? y : undefined
  }

  /** Change the pause hotkey; the overlay registers it on its next start. */
  setPauseHotkey(spec) {
    if (typeof spec === 'string') this.#pauseHotkey = spec
  }

  /** Subscribe to an overlay event: `stop`, `reply`, or `closed`. */
  on(event, handler) {
    const list = this.#handlers.get(event) ?? []
    list.push(handler)
    this.#handlers.set(event, list)
    return () => {
      const current = this.#handlers.get(event) ?? []
      this.#handlers.set(event, current.filter((entry) => entry !== handler))
    }
  }

  #emit(event, payload) {
    for (const handler of this.#handlers.get(event) ?? []) {
      try {
        handler(payload)
      } catch { /* an observer must not break the protocol */ }
    }
  }

  /** Whether the overlay process is up and interactive. */
  get available() {
    return this.#ready && this.#child !== null && !this.#disposed
  }

  /** Whether the overlay is currently showing its card. */
  get visible() {
    return this.#visible
  }

  #visible = false

  async start() {
    if (this.#disposed) return
    if (this.#child !== null) return
    if (this.#starting !== null) {
      await this.#starting
      return
    }
    this.#starting = this.#spawn()
    try {
      await this.#starting
    } finally {
      this.#starting = null
    }
  }

  #spawn() {
    return new Promise((resolve) => {
      let settled = false
      const child = spawn(powershellPath(), [
        '-NoProfile',
        '-NonInteractive',
        '-Sta',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        this.#scriptPath,
        '-Accent',
        this.#accent,
        '-CardWidth',
        String(this.#cardWidth),
        '-CardHeight',
        String(this.#cardHeight),
        '-CardMargin',
        String(this.#cardMargin),
        '-CardCorner',
        this.#cardCorner,
        ...Number.isInteger(this.#cardX) ? ['-CardX', String(this.#cardX)] : [],
        ...Number.isInteger(this.#cardY) ? ['-CardY', String(this.#cardY)] : [],
        '-Hotkey',
        this.#hotkey,
        '-DockHotkey',
        this.#dockHotkey,
        '-PauseHotkey',
        this.#pauseHotkey,
        '-StartHidden',
      ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })

      this.#buffer = ''
      this.#stderrTail = ''
      // A fresh process knows nothing: whatever it was told last must be sent again.
      this.#sentPolicy = ''

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { child.kill() } catch { /* already gone */ }
        resolve()
      }, STARTUP_TIMEOUT_MS)

      const settle = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }

      child.on('error', () => {
        this.#child = null
        settle()
      })
      child.on('exit', () => {
        if (this.#child === child) {
          this.#child = null
          this.#ready = false
          this.#visible = false
        }
        for (const [, ask] of this.#asks) {
          clearTimeout(ask.timer)
          ask.resolve('unavailable')
        }
        this.#asks.clear()
        settle()
        this.#emit('closed', {})
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        this.#stderrTail = (this.#stderrTail + chunk).slice(-2000)
      })
      child.stdin.on('error', () => { /* the exit handler reports the failure */ })

      child.stdout.on('data', (chunk) => {
        this.#buffer += this.#decoder.write(chunk)
        let newline = this.#buffer.indexOf('\n')
        while (newline !== -1) {
          const line = this.#buffer.slice(0, newline).replace(/\r$/u, '')
          this.#buffer = this.#buffer.slice(newline + 1)
          this.#handleLine(line, settle)
          newline = this.#buffer.indexOf('\n')
        }
      })

      this.#child = child
      this.#ready = false
    })
  }

  #handleLine(line, settleReady) {
    if (line.trim().length === 0) return
    let payload
    try {
      payload = JSON.parse(line)
    } catch {
      return
    }
    if (payload.type === 'ready') {
      this.#ready = true
      for (const message of this.#pendingWrites.splice(0)) this.#writeRaw(message)
      settleReady?.()
      return
    }
    if (payload.type === 'snapshot') return
    if (payload.type === 'stop') {
      this.#emit('stop', {})
      return
    }
    if (payload.type === 'dock-toggle') {
      this.#emit('dock-toggle', {})
      return
    }
    if (payload.type === 'pause-toggle') {
      this.#emit('pause-toggle', {})
      return
    }
    if (payload.type === 'pause-ready') {
      this.#emit('pause-ready', { hotkey: String(payload.hotkey ?? '') })
      return
    }
    if (payload.type === 'pause-failed') {
      this.#emit('pause-failed', { hotkey: String(payload.hotkey ?? '') })
      return
    }
    if (payload.type === 'hotkey') {
      this.#emit('hotkey', {})
      return
    }
    if (payload.type === 'hotkey-failed') {
      this.#emit('hotkey-failed', { hotkey: String(payload.hotkey ?? '') })
      return
    }
    if (payload.type === 'voice') {
      const audioPath = typeof payload.path === 'string' ? payload.path : ''
      if (audioPath.length > 0) this.#emit('voice', { path: audioPath })
      return
    }
    if (payload.type === 'resized') {
      const width = Number(payload.width)
      const height = Number(payload.height)
      if (Number.isFinite(width) && Number.isFinite(height)) this.#emit('resized', { width, height })
      return
    }
    if (payload.type === 'preview-moved') {
      // The user dragged the preview by its handle; where it landed is the spot
      // the next free-placed preview should return to.
      const x = Number(payload.x)
      const y = Number(payload.y)
      if (Number.isInteger(x) && Number.isInteger(y)) this.#emit('preview-moved', { x, y })
      return
    }
    if (payload.type === 'reply') {
      const text = typeof payload.text === 'string' ? payload.text.trim() : ''
      if (text.length > 0) this.#emit('reply', { text, immediate: payload.immediate === true })
      return
    }
    if (payload.type === 'permission') {
      const ask = this.#asks.get(payload.id)
      if (ask === undefined) return
      this.#asks.delete(payload.id)
      clearTimeout(ask.timer)
      ask.resolve(payload.decision === 'allow' ? 'allow' : 'deny')
    }
  }

  #writeRaw(message) {
    const child = this.#child
    if (child === null) return
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    } catch { /* the exit handler resets state */ }
  }

  #write(message) {
    // A helper that died while the plugin still believed it was ready used to
    // swallow every later message: the card kept working (it is the real window)
    // while the glow and the status strip silently never came back. Notice the
    // dead process and start a fresh one instead.
    if (this.#child !== null && this.#child.exitCode !== null) {
      this.#child = null
      this.#ready = false
    }
    if (!this.#ready) {
      if (!this.#disposed) void this.start().catch(() => { })
      this.#pendingWrites.push(message)
      if (this.#pendingWrites.length > 60) this.#pendingWrites.shift()
      return
    }
    this.#writeRaw(message)
  }

  /**
   * Show the card and glow, resetting the action feed when asked.
   *
   * Either half is a reason to bring the overlay up. `show` used to be the only
   * path that lit the edge light, and it bailed out when the card was switched
   * off — so turning off 「显示控制窗口」 took the blue edge down with it, even
   * though 「蓝边」 has its own switch. With the card off the overlay is started
   * for the glow alone, and the card stays collapsed.
   */
  async show({ title, status, reset = false } = {}) {
    const card = this.#policy.card !== false
    const glow = this.#policy.glow !== false
    if (!card && !glow) return
    await this.start()
    this.#visible = true
    if (!card) {
      this.#write({ type: 'glow-only' })
      return
    }
    // The overlay lights the edge only when the caller says so: a card must not
    // turn `effectGlow: false` back into a lit screen.
    this.#write({ type: 'show', title, status, reset, glow })
  }

  /** Replace the one-line activity status. */
  status(text) {
    if (!this.available || !this.#visible) return
    this.#write({ type: 'status', text })
  }

  /**
   * Append one row to the action feed, optionally with a preview image.
   * `merge` names a series: a later row of the same series replaces this one in
   * place, so input/mouse rows tick in a single line instead of stacking up.
   */
  action(kind, text, thumb, merge) {
    if (!this.available || !this.#visible) return
    this.#write({
      type: 'action',
      kind,
      text,
      ...thumb === undefined ? {} : { thumb },
      ...merge === undefined ? {} : { merge },
    })
  }

  /** Show the prominent centre-screen notice that control has started. */
  async notice({ title, detail, seconds } = {}) {
    if (!this.#policy.notice) return
    await this.start()
    if (!this.available) return
    this.#write({ type: 'notice', title, detail, seconds })
  }

  /** Step the edge light back so it does not cover the docked window. */
  glowDock({ x, y, width, height }) {
    if (!this.available) return
    this.#write({ type: 'glow-dock', x, y, width, height })
  }

  /** Restore the full edge light. */
  glowDockClear() {
    if (!this.available) return
    this.#write({ type: 'glow-dock-clear' })
  }

  /** Pin a one-line status strip over the docked window. */
  banner({ text, x, y, width }) {
    if (!this.#policy.banner || !this.available) return
    this.#write({ type: 'banner', text, x, y, width })
  }

  /** Remove the status strip. */
  bannerHide() {
    if (!this.available) return
    this.#write({ type: 'banner-hide' })
  }

  /** Show a small floating copy of the frame that was just captured. */
  /** Show the floating copy of a capture for `ms`. `follow: 'card'` hugs the card. */
  preview({ path, caption, x, y, follow, ms }) {
    if (!this.#policy.preview || !this.available) return
    this.#write({
      type: 'preview',
      path,
      caption,
      x,
      y,
      ...follow === undefined ? {} : { follow },
      ms,
    })
  }

  /** Take the capture preview down immediately. */
  previewHide() {
    if (!this.available) return
    this.#write({ type: 'preview-hide' })
  }

  /**
   * Keep the edge glow only: the docked window already shows the conversation.
   * The card is gone from the screen, so `visible` must say so — leaving it true
   * made the next approval ask a card nobody could see, and made a later
   * switch back to float skip the re-show.
   */
  glowOnly(appHandle) {
    if (!this.#policy.glow || !this.available) return
    this.#visible = false
    this.#write({ type: 'glow-only', app: appHandle })
  }

  /** Hide only the card, keeping the edge glow alive (used while docked). */
  hideCard() {
    if (!this.available) return
    this.#visible = false
    this.#write({ type: 'card-hide' })
  }

  /** Show a step counter in the card header. */
  progress({ step, total, label }) {
    if (!this.available) return
    this.#write({ type: 'progress', step, total, label })
  }

  /** Mark the exact screen point the next click will use. */
  point(x, y) {
    if (!this.#policy.clickPoint || !this.available) return
    this.#write({ type: 'point', x, y })
  }

  /** Bring the input box to the keyboard, used by the summon hotkey. */
  focusInput() {
    if (!this.available) return
    this.#write({ type: 'focus-input' })
  }

  /** Put a finished transcript into the card's input box. */
  voiceText(text) {
    if (!this.available) return
    this.#write({ type: 'voice-text', text })
  }

  /** Report a transcription failure in the card. */
  voiceError(message) {
    if (!this.available) return
    this.#write({ type: 'voice-error', message })
  }

  /** Outline one window on screen so the user sees which window is driven. */
  target(rect) {
    if (!this.#policy.target || !this.available) return
    this.#write({ type: 'target', ...rect })
  }

  /** Remove the window outline. */
  targetClear() {
    if (!this.available) return
    this.#write({ type: 'target-clear' })
  }

  /** Show the agent's evolving output line; an empty string clears it. */
  live(text) {
    if (!this.available || !this.#visible) return
    this.#write(text.length === 0 ? { type: 'live-clear' } : { type: 'live', text })
  }

  /** Report that the turn finished; the overlay hides itself shortly after. */
  finish(text = '已完成') {
    if (!this.available) return
    this.#visible = false
    this.#write({ type: 'done', text })
  }

  /** Hide immediately, for example when the user stops the turn. */
  hide() {
    this.#visible = false
    this.#write({ type: 'hide' })
  }

  /** Acknowledge a stop request in the status line. */
  stopAck(text = '已停止') {
    this.#write({ type: 'stop-ack', text })
  }

  /**
   * Ask the user to approve one desktop action in the overlay card.
   * @returns `allow`, `deny`, `timeout`, or `unavailable`.
   */
  async ask({ title, detail, app, risk, danger = false, timeoutMs = 300_000 }) {
    // Asking a card that the user switched off is a guaranteed timeout: answer
    // "unavailable" at once so the caller can fall back to DSH's own prompt.
    if (!this.#policy.card) return 'unavailable'
    await this.start()
    if (!this.available) return 'unavailable'
    const id = `perm-${++this.#sequence}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#asks.delete(id)
        this.#write({ type: 'permission-clear' })
        resolve('timeout')
      }, timeoutMs)
      this.#asks.set(id, { resolve, timer })
      this.#write({
        type: 'permission',
        id,
        title,
        detail,
        ...app === undefined ? {} : { app },
        ...risk === undefined ? {} : { risk },
        danger,
      })
    })
  }

  /** Stop the helper but keep this instance reusable for the next call. */
  stop() {
    const child = this.#child
    this.#child = null
    this.#ready = false
    this.#visible = false
    if (child === null) return
    try { child.stdin.end() } catch { /* already closed */ }
    try { child.kill() } catch { /* already gone */ }
    if (process.platform === 'win32' && typeof child.pid === 'number') {
      try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref() } catch { }
    }
  }

  /** Stop the overlay process. */
  dispose() {
    if (this.#disposed) return
    this.#disposed = true
    const child = this.#child
    this.#child = null
    this.#ready = false
    this.#visible = false
    for (const [, ask] of this.#asks) {
      clearTimeout(ask.timer)
      ask.resolve('unavailable')
    }
    this.#asks.clear()
    if (child !== null) {
      try { child.stdin.end() } catch { /* already closed */ }
      try { child.kill() } catch { /* already gone */ }
      // A surviving helper would keep the global hotkey registration and make
      // every later instance look broken, so the whole tree is killed on Windows.
      if (process.platform === 'win32' && typeof child.pid === 'number') {
        try {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
            .on('error', () => {})
            .unref()
        } catch { /* nothing left to kill */ }
      }
    }
  }
}

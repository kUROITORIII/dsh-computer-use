/**
 * Windows computer-use tools: let the agent see the desktop, move the pointer,
 * click, drag, scroll, type, and press keys on the real desktop the user works in.
 *
 * Screen capture and input injection live in a long-lived PowerShell helper
 * (`scripts/host.ps1`) because Node offers no Win32 interop; this module owns
 * the model-facing tools, the coordinate space, approval gating, and image admission.
 * @module dsh-computer-use-windows
 */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { appendFile, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DesktopHost } from './host.js'
import { Presence } from './presence.js'
import z from './vendor/schemastery.js'

/** The tool registry must exist before this plugin may register its tools. */
export const inject = ['tools']

/** Plugin row name reported by the Loader. */
export const name = 'computer-use-windows'

/** Version of the code actually running, read from the manifest beside this file. */
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? '0'
  } catch {
    return '0'
  }
})()

/** Tool names this plugin owns; every name is prefixed to stay collision-free. */
const TOOL_PREFIX = 'computer_'
/** Approval modes accepted from the plugin config. */
const APPROVAL_MODES = ['once-per-session', 'every-action', 'never']

/** Selectable edge-glow accents; DSH blue leads because it matches the app theme. */
const ACCENTS = {
  blue: '#2F7DF6',
  orange: '#FF8A3D',
  purple: '#8B5CF6',
  green: '#22C55E',
  pink: '#EC4899',
  red: '#EF4444',
}

/**
 * Cap on the downscaled screenshot width handed to the model. 1596 is exactly 38
 * cells of the model's 42 px patch grid; 1600 would be padded out to the same 38
 * cells anyway, so the extra 4 px only cost tokens. Do not round this up.
 */
const DEFAULT_MAX_IMAGE_WIDTH = 1596

/** Cap on how many windows one listing returns. */
const WINDOW_LIST_LIMIT = 60

/**
 * Model-facing guidance appended to the system prompt while the plugin is loaded.
 * It states only behavior these tools implement and the limits that change a plan.
 */
const GUIDANCE = `# Desktop control

The computer_* tools operate this Windows computer's real desktop — the same screen, pointer, and keyboard the user is using.

Reach for these tools whenever the request is about something that exists on the user's screen or inside their applications: reading a page or a dialog, checking what an app currently shows, opening or operating a program, clicking through a UI, moving files the user can see, or verifying that something visual actually happened. Never guess what is on screen, and never turn a desktop task into a list of steps for the user to perform themselves.

Stay without them for pure writing, reasoning, code, or file edits that need no visual check — a screenshot costs the user time and tokens.

**Look cheaply first.** A screenshot is the most expensive observation available: it costs roughly two thousand tokens and is re-sent with every later turn. computer_look reads the UI Automation control list and only falls back when the app exposes too few usable controls — first to computer_ocr, which reads the text for a fraction of the tokens, then to a picture. Act on named controls through computer_ui by path — a path addresses the control itself, so scrolling, resizing, or moving the window cannot make it miss. Keep computer_screenshot for canvas areas, games, and apps that expose no elements.

**Zoom instead of squinting.** When the full picture is too coarse to read a label or to place a click precisely, computer_zoom crops one region and returns it at native resolution. It is cheaper than a second screenshot and sharper than the first, and the zoomed image becomes the coordinate space for the next click.

**Batch instead of chatting.** computer_sequence runs up to 24 already-planned steps in one call and takes a single picture at the end. Five clicks behind one dialog is one round trip, not five. Plan the steps from one look and batch them; look again only when the next step depends on what you would see.

- Take computer_look (or computer_screenshot when you specifically need the pixels) before the first interaction; a batch already ends with a fresh picture of the result.
- Coordinates passed to computer_click, computer_drag, and computer_scroll are pixels in the most recently returned image, not physical screen pixels. Each image result states both sizes and how they map. A picture older than the coordinate time limit is refused instead of guessed from — take a fresh screenshot, or pass allow_stale for a target that provably did not move.
- The exception is space: "screen": use it for numbers that are already physical pixels, such as the @x,y of an OCR line or a UIA rectangle. Those must not be pushed through a picture they were not read from.
- When the screen shows many identical controls — a column of switches, a grid of icons, repeated list rows — never pick one by a coordinate read off a small crop: every row looks the same, and one pixel is the difference between two plugins. Instead name the target (target: {text: "dsh-pet"}) or anchor the click to unique text on that row (anchor plus dx/dy). If neither can tell two candidates apart, say so and stop instead of clicking a guess.
- Click the control, not the pixel: a coordinate is an estimate read off a downscaled picture, so a 16 px checkbox is only 10 px wide in the image. target resolves the control rectangle and clicks its exact centre; a plain coordinate is snapped to a nearby control centre when that is unambiguous, and the result reports the real cursor position and what it landed on. Read that line before assuming the click worked.
- In a batch, space belongs to each step, and it is easy to add it to the click and forget the drag or the scroll next to it: a step written without it reads image pixels, and its own result line says so — "image (x, y) = screen (a, b)". When a drag or scroll lands somewhere unexpected, read that line first: it is how a missing space shows itself. A coordinate outside the picture is refused with an error instead of being pulled to the edge, so a wrong space now stops the batch rather than acting in the wrong place.
- A capture whose pixels match the previous one comes back as a one-line "no change" answer with no new image: the coordinates you already hold remain valid, so acting on them is correct.
- A control list names its snapshot, e.g. 快照 s3. Pass that id back as the snapshot argument on the action: if the interface changed in between, the action is refused with STALE_REF instead of landing on whatever took the control's place.
- The user can pause you at any moment with Ctrl+Alt+Q. While paused, every click, keystroke, scroll and UIA action is refused with PAUSED. When that happens, stop and tell the user what is left to do — do not retry, and do not look for another tool that gets around it.
- To put text into a control, give computer_type its window and path: it writes through UI Automation, so the field is filled without taking the focus and the user can keep working in another window. Only submit (Enter) and fields without a Value pattern fall back to pasting into the focused window.
- To work inside one window, list handles with computer_windows, bring it forward with computer_focus_window, and prefer capturing that window so its coordinates survive other windows moving.
- Check your own work in the same turn. A tool's result says what was sent, not what the application did, so confirm the outcome before moving on — and confirm it cheaply: a zoom of the exact region costs a fraction of a screenshot, and a control list or an OCR line already carries the position. When you fix one instance of a problem, look for the same pattern everywhere before reporting: the sibling controls, the other rows, every object with the same defect. Say what you checked, what you fixed, and what you deliberately left alone.
- Prefer keyboard shortcuts (computer_key) with computer_type over clicking through menus; typing pastes the clipboard, so Unicode text works.
- Do not start destructive or irreversible steps — deleting files, sending messages, purchases, closing unsaved work — unless the user asked for exactly that; ask when a step is ambiguous.
- Screenshots can omit hardware-accelerated or elevated windows; if a click appears to miss, look again before retrying.`

/** Every config key this plugin reads; anything else is a typo worth reporting. */
const KNOWN_SETTINGS = new Set([
  'approval', 'maxImageWidth', 'helperTimeoutMs', 'defaultMonitor', 'accent', 'mirror',
  'noticeSeconds', 'activateBeforeActing', 'stepTimeoutMs', 'retryOnce', 'failureLimit',
  'dockWindow', 'windowMode', 'dockWidth', 'dockHeight', 'dockMargin', 'clickPreview', 'previewMs',
  'settleMs', 'dedupeShots', 'stepPauseMs', 'sequenceMaxSteps', 'uiaMinControls',
  'coordinateTtlMs', 'hotkey', 'hotkeyMode', 'dockHotkey', 'hotkeyPrompt',
  'clickSnap', 'snapRadius', 'verifyClick', 'retryOnMiss',
  'shotDir', 'keepShots', 'previewCorner', 'previewFollow',
  'cardWidth', 'cardHeight', 'cardMargin', 'previewShotMs', 'zoomMaxSide', 'ocrMaxLines', 'ocrFallbackLines',
  'pauseHotkey', 'dockIdleMs',
  'cleanMode', 'effectGlow', 'effectBanner', 'effectPreview', 'effectCard',
  'effectTarget', 'effectClickPoint', 'effectNotice', 'effectDock', 'effectSurface',
  'dockCorner', 'noticeTitle',
])

/** Build one object-rooted parameter schema from its properties. */
function objectSchema(properties, required) {
  return {
    type: 'object',
    properties,
    ...required === undefined ? {} : { required },
  }
}

/** Shared output value: one model-facing summary of what happened. */
const SUMMARY_VALUE_SCHEMA = objectSchema({ summary: { type: 'string' } }, ['summary'])

/**
 * Screenshot output: the image reference plus its summary. The image is optional
 * because an unchanged screen is reported as text alone — re-sending identical
 * pixels would cost tokens without telling the model anything new.
 */
const SCREENSHOT_VALUE_SCHEMA = objectSchema({
  image: objectSchema({
    attachmentId: { type: 'string' },
    mediaType: { type: 'string' },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
  }, ['attachmentId', 'mediaType', 'bytes', 'width', 'height']),
  summary: { type: 'string' },
}, ['summary'])

/**
 * Render a capture result: the summary, plus the image only when one was actually
 * attached. An unchanged screen comes back as text alone by design.
 */
function renderCapture(_args, value) {
  if (value?.image === undefined) return [{ type: 'text', text: value.summary }]
  return [
    { type: 'text', text: value.summary },
    {
      type: 'image',
      attachment: {
        attachmentId: value.image.attachmentId,
        mediaType: value.image.mediaType,
        bytes: value.image.bytes,
        width: value.image.width,
        height: value.image.height,
        ...value.image.name === undefined ? {} : { name: value.image.name },
      },
    },
  ]
}

/** File that remembers the size the user dragged the card to. */
function cardSizePath() {
  const home = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
  return path.join(home, 'computer-use-card.json')
}

/** Read the saved card size, or undefined when the user never resized it. */
function readSavedCardSize() {
  try {
    const raw = readFileSync(cardSizePath(), 'utf8').replace(/^\uFEFF/u, '')
    const saved = JSON.parse(raw)
    if (Number.isInteger(saved.width) && Number.isInteger(saved.height)) {
      return { width: saved.width, height: saved.height }
    }
  } catch { /* first run, or an unreadable file: fall back to config defaults */ }
  return undefined
}

/** Read a non-negative integer from plugin config, falling back to a default. */
function nonNegativeInteger(value, fallback, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback
  return Math.min(Math.round(value), maximum)
}

/** Read a positive integer from plugin config, falling back to a default. */
function positiveInteger(value, fallback, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.round(value), maximum)
}

/** Read one config value, whether the Host handed over a plain value or a volatile reference. */
function live(value, fallback) {
  let current = value
  if (current !== null && typeof current === 'object' && typeof current.get === 'function') {
    try { current = current.get() } catch { current = undefined }
  }
  return current === undefined || current === null ? fallback : current
}

/**
 * Which visible accessories are allowed right now.
 *
 * Clean mode is the master switch: it wins over every individual toggle, so
 * "just control the computer" cannot be spoiled by one leftover effect. The
 * individual switches stay remembered and come back when clean mode is off.
 */
function resolveEffects(raw) {
  const clean = live(raw?.cleanMode, false) === true
  const on = (value) => !clean && live(value, true) !== false
  // The master for "show a control window at all": the floating card and the
  // docked panel are one decision for the user, so turning it off hides the card
  // and leaves the conversation window alone, whatever the two rows below say.
  const surface = on(raw?.effectSurface)
  return {
    glow: on(raw?.effectGlow),
    banner: on(raw?.effectBanner),
    preview: on(raw?.effectPreview),
    card: surface && on(raw?.effectCard),
    target: on(raw?.effectTarget),
    clickPoint: on(raw?.effectClickPoint),
    notice: on(raw?.effectNotice),
    dock: surface && on(raw?.effectDock),
    surface,
  }
}

/**
 * The plugin's declared configuration.
 *
 * Every field is `.volatile()`: the Plugins page writes it into the profile
 * patch and this instance sees the new value on its next operation, without
 * remounting — a remount would kill the PowerShell helper and the overlay in
 * the middle of a turn. Fields are flat on purpose: a settings path is then one
 * key, and older yml config keeps working unchanged.
 */
const boolField = (fallback, text) => z.boolean().default(fallback).description(text).volatile()
const numberField = (fallback, text) => z.number().default(fallback).description(text).volatile()
const textField = (fallback, text) => z.string().default(fallback).description(text).volatile()

export const Config = z.object({
  cleanMode: boolField(false, '纯净模式：不画光带、不显状态条、不弹预览、不画目标框和落点、不缩停靠窗口——只操作电脑'),
  effectGlow: boolField(true, '屏幕四周的光带'),
  effectBanner: boolField(true, '窗口上沿的一行状态条'),
  effectPreview: boolField(true, '截图预览小窗'),
  effectCard: boolField(true, '控制卡片：说明、进度、权限询问和回复框'),
  effectTarget: boolField(true, '正在操作的目标窗口边框'),
  effectClickPoint: boolField(true, '点击前在落点闪一下'),
  effectNotice: boolField(true, '屏幕中央的一次性提示'),
  effectSurface: boolField(true, '控制期间显示控制窗口（悬浮卡片 + 停靠）：关掉后两者都不出现，会话窗口一个像素都不动'),
  effectDock: boolField(true, '允许把会话窗口缩到右上角（关掉等于 float）'),
  windowMode: z.union(['dock', 'float']).default('dock')
    .description('dock=控制期间把会话窗口缩到右上角；float=只出卡片，窗口一个像素都不动').volatile(),
  dockCorner: z.union(['topright', 'topleft', 'bottomright', 'bottomleft', 'custom']).default('topright')
    .description('停靠位置：四个角，或 custom=记住你上次把它拖到的位置').volatile(),
  noticeTitle: z.string().default('DeepSeek 正在使用你的电脑')
    .description('居中的那句话，可以换成你自己的说法').volatile(),
  dockWindow: z.boolean().description('旧键：false 等于 windowMode=float').volatile(),
  accent: z.union(Object.keys(ACCENTS)).default('blue').description('光带颜色').volatile(),
  dockWidth: numberField(520, '停靠面板宽度（像素）'),
  dockHeight: numberField(720, '停靠面板高度（像素）'),
  dockMargin: numberField(0, '停靠面板离屏幕边的距离（0=完全贴右上角）'),
  dockIdleMs: numberField(0, '空闲多少毫秒把窗口还给你；0=整个回合都停靠在角落'),
  cardWidth: numberField(520, '卡片宽度（像素）'),
  cardHeight: numberField(680, '卡片高度（像素）'),
  cardMargin: numberField(0, '卡片离屏幕边的距离'),
  pauseHotkey: textField('ctrl+alt+q', '暂停/恢复热键，留空=关闭；暂停中所有输入都被拒绝'),
  hotkey: textField('', '召唤热键，留空=关闭'),
  dockHotkey: textField('', '停靠/悬浮切换热键，留空=关闭'),
  hotkeyMode: z.union(['summon', 'prompt']).default('summon').description('召唤热键只叫起，还是同时发一句话').volatile(),
  hotkeyPrompt: textField('继续', 'hotkeyMode=prompt 时替你发出的那句话'),
  approval: z.union(APPROVAL_MODES).default('never').description('危险动作要不要先在卡片里问一句').volatile(),
  activateBeforeActing: boolField(true, '动作前把目标窗口提到前台'),
  clickPreview: boolField(true, '旧键：等价于 effectClickPoint'),
  previewMs: numberField(260, '落点光圈停留时间（毫秒）'),
  previewShotMs: numberField(4000, '截图预览小窗停留时间（毫秒）'),
  shotDir: textField('', '截图保存目录；留空 = %TEMP%\\dsh-computer-use\\shots；支持 %TEMP% 这类环境变量'),
  keepShots: numberField(50, '保留最近几张截图；0 = 不落盘（截图读完就删）'),
  previewCorner: z.union(['topright', 'topleft', 'bottomright', 'bottomleft', 'custom']).default('topright')
    .description('没有控制窗口时，截图预览放哪个角；custom = 用停靠面板记下的自定义位置').volatile(),
  previewFollow: boolField(true, '控制窗口出现时，把截图预览贴在它边上（左右自动选空的一侧）'),
  noticeSeconds: numberField(5, '居中提示停留时间（秒）'),
  mirror: boolField(true, '把会话内容镜像到卡片上'),
  maxImageWidth: numberField(1596, '截图下采样宽度；1596 正好贴模型 patch 网格，改大只会更贵'),
  dedupeShots: boolField(true, '画面没变时不给新图、只回一行字'),
  settleMs: numberField(180, '动作后等多久再截图（等界面重绘）'),
  coordinateTtlMs: numberField(15_000, '截图坐标多旧就作废（点击/拖动前）；旧图会被拒绝，除非显式允许'),
  clickSnap: boolField(true, '点击前把坐标吸附到附近控件的正中心'),
  snapRadius: numberField(24, '吸附半径（像素）'),
  verifyClick: boolField(true, '点击后核对落点，并检查画面是否真的变了'),
  retryOnMiss: boolField(true, '落点没进目标控件时，按控件中心自动重试一次'),
  zoomMaxSide: numberField(2000, '单次放大（zoom）的最长边'),
  uiaMinControls: numberField(3, '可操作控件少于这个数才退回 OCR/截图'),
  ocrFallbackLines: numberField(6, 'OCR 至少读出几行才代替截图'),
  ocrMaxLines: numberField(60, '一次 OCR 最多列几行'),
  sequenceMaxSteps: numberField(24, '一次批量最多几步'),
  stepPauseMs: numberField(80, '批量里每步之间停多久（毫秒）'),
  defaultMonitor: numberField(1, '默认拍哪个显示器'),
  helperTimeoutMs: numberField(20_000, '单次辅助进程调用超时（毫秒）'),
  stepTimeoutMs: numberField(60_000, '单步超时（毫秒）'),
  retryOnce: boolField(true, '可重试的失败自动重试一次'),
  failureLimit: numberField(3, '连续失败几次就停下不再尝试'),
})

/** Apply defaults and keep unusable config values from changing behavior silently. */
function resolveSettings(config) {
  const raw = {}
  for (const [key, value] of Object.entries(config ?? {})) raw[key] = live(value, undefined)
  const saved = readSavedCardSize()
  // How the tool shows itself while it works:
  //   dock  — the conversation window shrinks into the corner chosen by dockCorner
  //   float — only the floating card appears; the conversation window is untouched
  // `windowMode` is the single owner. `effectDock` / `dockWindow` are no longer
  // read: with a schema default they can never be "absent", so the old-key branch
  // was unreachable anyway (and a stale `effectDock: false` once silently turned
  // 「会话窗口」 into 悬浮窗). Clean mode and the surface master force float.
  const effects = resolveEffects(raw)
  const windowMode = raw.cleanMode === true || raw.effectSurface === false
    ? 'float'
    : raw.windowMode === 'float' ? 'float' : 'dock'
  return {
    cleanMode: raw.cleanMode === true,
    effects,
    approval: APPROVAL_MODES.includes(raw.approval) ? raw.approval : 'once-per-session',
    maxImageWidth: positiveInteger(raw.maxImageWidth, DEFAULT_MAX_IMAGE_WIDTH, 3840),
    helperTimeoutMs: positiveInteger(raw.helperTimeoutMs, 20_000, 120_000),
    defaultMonitor: positiveInteger(raw.defaultMonitor, 1, 8),
    accent: Object.hasOwn(ACCENTS, raw.accent) ? raw.accent : 'blue',
    mirror: raw.mirror !== false,
    noticeSeconds: positiveInteger(raw.noticeSeconds, 5, 30),
    activateBeforeActing: raw.activateBeforeActing !== false,
    stepTimeoutMs: Number.isInteger(raw.stepTimeoutMs) ? Math.min(Math.max(raw.stepTimeoutMs, 5_000), 300_000) : 60_000,
    retryOnce: raw.retryOnce !== false,
    failureLimit: Number.isInteger(raw.failureLimit) ? Math.min(Math.max(raw.failureLimit, 1), 10) : 3,
    windowMode,
    dockWindow: windowMode === 'dock',
    // Where the panel goes. "custom" reuses the spot it was last left at.
    dockCorner: ['topright', 'topleft', 'bottomright', 'bottomleft', 'custom'].includes(raw.dockCorner)
      ? raw.dockCorner
      : 'topright',
    // The one sentence in the centred notice; the user may replace it.
    noticeTitle: typeof raw.noticeTitle === 'string' && raw.noticeTitle.trim().length > 0
      ? raw.noticeTitle.trim()
      : 'DeepSeek 正在使用你的电脑',
    dockWidth: Number.isInteger(raw.dockWidth) ? Math.min(Math.max(raw.dockWidth, 360), 1200) : 520,
    dockHeight: Number.isInteger(raw.dockHeight) ? Math.min(Math.max(raw.dockHeight, 320), 1400) : 720,
    dockMargin: Number.isInteger(raw.dockMargin) ? Math.min(Math.max(raw.dockMargin, 0), 200) : 0,
    clickPreview: raw.clickPreview !== false,
    previewMs: Number.isInteger(raw.previewMs) ? Math.min(Math.max(raw.previewMs, 0), 1000) : 260,
    // A capture taken the instant an action returns catches the frame before the
    // repaint. Waiting a moment is what makes "act, then look" trustworthy.
    settleMs: Number.isInteger(raw.settleMs) ? Math.min(Math.max(raw.settleMs, 0), 2000) : 180,
    // Identical pixels are answered with text instead of a second image.
    dedupeShots: raw.dedupeShots !== false,
    // A batch runs planned steps back to back; the pause lets the UI keep up.
    stepPauseMs: Number.isInteger(raw.stepPauseMs) ? Math.min(Math.max(raw.stepPauseMs, 0), 800) : 80,
    sequenceMaxSteps: Number.isInteger(raw.sequenceMaxSteps) ? Math.min(Math.max(raw.sequenceMaxSteps, 1), 60) : 24,
    // Below this many actionable controls a screenshot is worth its cost.
    uiaMinControls: Number.isInteger(raw.uiaMinControls) ? Math.min(Math.max(raw.uiaMinControls, 1), 20) : 3,
    // Text the OCR fallback must find before it replaces a screenshot.
    ocrFallbackLines: Number.isInteger(raw.ocrFallbackLines) ? Math.min(Math.max(raw.ocrFallbackLines, 1), 100) : 6,
    // How old a screenshot may be before its coordinate mapping is called stale.
    // 15 s is the line between "I just looked" and "the layout may have moved":
    // the previous 120 s silently accepted two-minute-old pictures, which is one
    // of the three ways a click lands on the wrong control.
    coordinateTtlMs: Number.isInteger(raw.coordinateTtlMs) ? Math.min(Math.max(raw.coordinateTtlMs, 5_000), 3_600_000) : 15_000,
    // Snapping, verification and the one retry: the three things that turn "a
    // point" into "a target". Each can be switched off on its own.
    clickSnap: raw.clickSnap !== false,
    snapRadius: Number.isInteger(raw.snapRadius) ? Math.min(Math.max(raw.snapRadius, 6), 80) : 24,
    verifyClick: raw.verifyClick !== false,
    retryOnMiss: raw.retryOnMiss !== false,
    // The longest side a zoom may ask for, so one call cannot ask for the desktop.
    zoomMaxSide: Number.isInteger(raw.zoomMaxSide) ? Math.min(Math.max(raw.zoomMaxSide, 40), 8_000) : 2_000,
    // OCR lines are listed at ~15 tokens each; a screenshot is ~1.8k. Past this
    // many lines the text is no longer cheaper than looking, so it is cut off.
    ocrMaxLines: Number.isInteger(raw.ocrMaxLines) ? Math.min(Math.max(raw.ocrMaxLines, 5), 400) : 60,
    // How long the floating copy of a capture stays on screen.
    previewShotMs: Number.isInteger(raw.previewShotMs) ? Math.min(Math.max(raw.previewShotMs, 800), 20_000) : 4_000,
    // Where screenshots land. The default is a real directory rather than the
    // transient temp folder the old code read-and-deleted from, so the user can
    // actually open what the agent saw.
    shotDir: typeof raw.shotDir === 'string' ? raw.shotDir.trim() : '',
    keepShots: Number.isInteger(raw.keepShots) ? Math.min(Math.max(raw.keepShots, 0), 2000) : 50,
    // Preview placement when no control window is on screen: four corners, or the
    // spot the user dragged the dock to.
    previewCorner: ['topright', 'topleft', 'bottomright', 'bottomleft', 'custom'].includes(raw.previewCorner)
      ? raw.previewCorner
      : 'topright',
    previewFollow: raw.previewFollow !== false,
    hotkey: typeof raw.hotkey === 'string' ? raw.hotkey.trim() : '',
    hotkeyMode: raw.hotkeyMode === 'prompt' ? 'prompt' : 'summon',
    dockHotkey: typeof raw.dockHotkey === 'string' ? raw.dockHotkey.trim() : '',
    // The user's own brake. Only this key sets or clears the pause; while it is
    // on, nothing that touches the desktop is allowed through. Empty disables it.
    pauseHotkey: typeof raw.pauseHotkey === 'string' ? raw.pauseHotkey.trim() : 'ctrl+alt+q',
    // How long the docked window may sit in the corner with no tool call before
    // it is handed back. 0 keeps it docked for the whole turn, which is what a
    // long task wants: the corner keeps showing that the work is still going.
    dockIdleMs: Number.isInteger(raw.dockIdleMs) ? Math.min(Math.max(raw.dockIdleMs, 0), 600_000) : 0,
    hotkeyPrompt: typeof raw.hotkeyPrompt === 'string' && raw.hotkeyPrompt.trim().length > 0 ? raw.hotkeyPrompt.trim() : '继续',
    cardWidth: Math.min(Math.max(saved?.width ?? positiveInteger(raw.cardWidth, 520, 1200), 380), 1200),
    cardHeight: Math.min(Math.max(saved?.height ?? positiveInteger(raw.cardHeight, 680, 1400), 320), 1400),
    cardMargin: nonNegativeInteger(raw.cardMargin, 0, 200),
  }
}

/** Localized approval prompt text for one input action. */
function approvalReason(what) {
  return {
    en: `Allow this agent to ${what} on your desktop?`,
    zh: `允许这个智能体在你的桌面上${what}吗？`,
    ja: `このエージェントにデスクトップで${what}ことを許可しますか？`,
  }
}

/** Require one integer argument, since the registry does not validate raw schemas. */
function integerArg(args, name) {
  const value = args?.[name]
  if (!Number.isInteger(value)) throw new Error(`"${name}" must be an integer, received ${JSON.stringify(value)}`)
  return value
}

/**
 * Register the computer-use tools on a plugin context.
 * @param ctx - Cordis context carrying the tool registry and optional services.
 * @param config - the plugin row's config object.
 */
export function apply(ctx, config) {
  // `let`, not `const`: every field is volatile, so the Settings page can change
  // a value between two operations. The object is rebuilt from the same config
  // reference the Host keeps updating, never from a stale copy.
  let settings = resolveSettings(config)
  // A misspelt config key otherwise looks exactly like the plugin refusing to honour
  // a setting, so record every key it does not understand where it can be read back.
  const unknownKeys = Object.keys(config ?? {}).filter(key => !KNOWN_SETTINGS.has(key))
  // DSH's loader caches ESM modules by their resolved path, so `disable -> enable`
  // can hand back the module it already imported. Recording the start time makes
  // "which version is live right now" answerable instead of a guess.
  try {
    const home = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
    // Read the manifest again instead of using the module-level constant: DSH
    // caches ESM by path, so a disable/enable can re-run this function from a
    // module that was imported before the version was bumped. The stamp has to
    // describe what is on disk now, or it stops being usable as evidence.
    let liveVersion = PLUGIN_VERSION
    try {
      liveVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? PLUGIN_VERSION
    } catch { /* keep the imported constant */ }
    writeFileSync(path.join(home, 'computer-use-start.json'), JSON.stringify({
      version: liveVersion,
      tool: name,
      at: new Date().toISOString(),
      pid: process.pid,
      unknownKeys,
    }))
  } catch { /* diagnostics only; never block tool registration */ }
  if (unknownKeys.length > 0) {
    console.warn(`[computer-use] ignoring unknown config keys: ${unknownKeys.join(', ')}`)
  }
  const scriptPath = fileURLToPath(new URL('./scripts/host.ps1', import.meta.url))
  const host = new DesktopHost({ scriptPath, timeoutMs: settings.helperTimeoutMs })

  /**
   * The user's pause switch, mirrored from the overlay hotkey. Two layers refuse
   * input while it is on: this wrapper (so the model sees a clear error instead
   * of a silent no-op) and the host itself (so nothing slips through even if a
   * code path here forgets to ask).
   */
  let paused = false
  /** When the last helper call started or ended, for the idle dock release. */
  let lastActivityAt = Date.now()
  /** Calls in flight, so a long batch is never mistaken for idleness. */
  let inFlight = 0
  /**
   * Batches currently replaying steps. A step that only waits makes no helper call,
   * so `inFlight` drops to zero between two steps: with `dockIdleMs` on, the panel
   * would be handed back in the middle of a batch and grabbed again by the next
   * step. A whole batch counts as busy from the first step to the last.
   */
  let batchDepth = 0
  /** Operations that move the pointer, press keys, or take the foreground. */
  const ACTING_OPS = new Set(['click', 'drag', 'scroll', 'type', 'key', 'uiact', 'focus'])
  const PAUSE_ERROR = 'PAUSED: 主人按了暂停键（Ctrl+Alt+Q），现在不接管电脑。停下等他放开，不要重试。'
  /**
   * A refusal the user caused, not a failure of the plugin. It must never be
   * counted towards the stuck-action breaker: three paused actions used to trip
   * "连续 3 次动作失败" and hide the real reason.
   */
  class PausedError extends Error {}
  const requestHost = host.request.bind(host)
  host.request = async (op, args, ...rest) => {
    lastActivityAt = Date.now()
    refreshSettings()
    if (paused && ACTING_OPS.has(op)) throw new PausedError(PAUSE_ERROR)
    inFlight += 1
    try {
      // `rest` carries the per-call timeout the caller asked for. Dropping it made
      // every call fall back to the helper-wide timeout: a 25 s wait died at 20 s
      // and reported "the helper did not answer" instead of "the screen kept moving".
      const result = await requestHost(op, args, ...rest)
      helperStarted = true
      return result
    } finally {
      inFlight -= 1
      lastActivityAt = Date.now()
    }
  }

  /** Whether the helper has ever answered, so a lone pause does not spawn one. */
  let helperStarted = false

  /**
   * Flip the user's brake, whoever asked: the global hotkey, the /pause command,
   * or the model on an explicit instruction. All three land here so the card,
   * the strip and the host never disagree about whether input is allowed.
   */
  function applyPauseState(next, source) {
    paused = next
    lastActivityAt = Date.now()
    if (helperStarted) {
      // A running helper must be told too: its own guard is the backstop, and it
      // would refuse the first action after the user resumed.
      void host.request('pause', { on: paused }).catch(() => { })
    }
    if (paused) {
      setStatus(`已暂停 · ${source} 恢复`)
      presence.action('user', `⏸ 暂停，不再接管电脑（${source} 恢复）`)
    } else {
      setStatus('已恢复控制')
      presence.action('user', '▶ 已恢复控制')
    }
  }

  /** Screenshot coordinate space per agent, so clicks map onto physical screen pixels. */
  const captures = new Map()
  /**
   * What each window's control tree looked like when it was last printed, per
   * agent. A path like `0/1/3` is a position in a tree, not the identity of a
   * control: read a menu, close it, and that path is now something else. Keeping
   * the name and type of every path we handed out is what lets an action refuse
   * to fire on a control it is no longer sure about.
   */
  const uiSnapshots = new Map()
  let uiSnapshotSeq = 0
  /** Sessions the user already approved under `once-per-session`. */
  const approvedSessions = new Set()
  let tempDirectory

  /** The desktop card: screen-edge glow, action feed, permission asks, replies. */
  const presence = new Presence({
    scriptPath: fileURLToPath(new URL('./scripts/overlay.ps1', import.meta.url)),
    cardWidth: settings.cardWidth,
    cardHeight: settings.cardHeight,
    cardMargin: settings.cardMargin,
    accent: ACCENTS[settings.accent],
    hotkey: settings.hotkey,
    dockHotkey: settings.dockHotkey,
    pauseHotkey: settings.pauseHotkey,
  })

  /**
   * Re-read the config before an operation.
   *
   * `loader/volatile-update` is the fast path, but it can arrive after the next
   * tool call has already started — the user toggles Clean mode and the glow
   * stayed on until a reload. Reading the same config reference again is cheap
   * and makes "one switch changes the next action" true regardless of timing.
   */
  function refreshSettings() {
    try {
      const cardWasAllowed = settings.effects.card
      settings = resolveSettings(config)
      presence.setPolicy(settings.effects)
      presence.setAccent(ACCENTS[settings.accent])
      presence.setPauseHotkey(settings.pauseHotkey)
      // The floating card follows the same corner choice as the docked panel.
      const rememberedCardPos = settings.dockCorner === 'custom' ? readCustomPos() : undefined
      presence.setCardPlacement(settings.dockCorner, rememberedCardPos?.x, rememberedCardPos?.y)
      // Clean mode takes the card off the screen; switching it back off must put
      // the card back now, not at the next turn — but only while a turn really
      // owns the card, or a stray panel would survive the end of the turn.
      if (!cardWasAllowed && settings.effects.card && activeAgentId !== null
        && (presence.visible || inFlight > 0)) {
        void presence.show({ title: 'DeepSeek 正在使用你的电脑', status: '继续控制' })
      }
    } catch { /* a half-written value must not take the tools down */ }
  }
  presence.setPolicy(settings.effects)
  ctx.on('loader/volatile-update', () => {
    refreshSettings()
    // Turning the corner panel off (or Clean mode on) has to bring the window
    // back now. Waiting for the end of the turn left it sitting in the corner
    // while the switch already said it was off.
    if (docked !== null && !settings.dockWindow) void releaseDockNow()
  })
  /** The one agent whose turn owns the card; the overlay shows a single session. */
  let activeAgentId = null
  let lastNoticeAt = 0
  /** Pending "stop the overlay after this turn" timer; a new turn cancels it. */
  let turnStopTimer = null
  /** The idle-release interval, stopped when the plugin is disposed. */
  let idleTimerHandle = null
  /** Consecutive desktop failures in this session; a stuck run stops asking. */
  /** Journal file a long task appends to, so a later run can resume. */
  function journalPath() {
    const home = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
    return path.join(home, 'computer-use-journal.md')
  }
  let consecutiveFailures = 0
  /** Saved geometry while this window is docked in the corner. */
  let docked = null
  /** What each in-flight approval is about, keyed by call id and read by the overlay. */
  const pendingIntents = new Map()
  /** Latest foreground window label, used as the permission card's application chip. */
  let activeWindowLabel = ''

  /** Build the identified user message that steering needs. */
  function userMessage(text) {
    return Object.freeze({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
  }

  /** Reveal the card for this agent, or just refresh its status line. */
  async function beginPresence(exec, statusText) {
    refreshSettings()
    // A new turn cancels the previous turn's "stop the overlay" timer, which
    // would otherwise kill this turn's card and hotkey six seconds later.
    if (turnStopTimer !== null) { clearTimeout(turnStopTimer); turnStopTimer = null }
    // The dock switch was turned off after the window had already been shrunk:
    // put it back before doing anything else, so the panel is not left behind
    // over the window the agent is about to drive.
    if (!settings.dockWindow) await releaseDockNow()
    const agent = exec.agent
    if (agent === undefined) return
    // The helper is no longer kept alive between turns, so it must be started
    // before any of the docked-mode messages are written to it.
    try { await presence.start() } catch { }
    // A fresh overlay starts knowing nothing: tell it which accessories this
    // configuration allows before the first show/grow message reaches it.
    presence.syncPolicy()
    if (settings.dockWindow && docked === null && !paused) await dockSelf()
    if (docked !== null) {
      // Docked: the real window is the panel now, so only the edge light stays.
      activeAgentId = agent.id
      presence.glowOnly(docked.handle)
      // Raise the panel first: raising it after the strip would bury the strip,
      // which is the only status the user can see while docked.
      await raiseDocked(docked.handle)
      await syncDockRect()
      setStatus(statusText)
      return
    }
    if (activeAgentId !== agent.id || !presence.visible) {
      activeAgentId = agent.id
      await presence.show({ title: 'DeepSeek 正在使用你的电脑', status: statusText, reset: true })
      // The centred notice explains the glow once, not on every turn.
      if (Date.now() - lastNoticeAt > 90_000) {
        lastNoticeAt = Date.now()
        await presence.notice({
          title: settings.noticeTitle,
          seconds: settings.noticeSeconds,
        })
      }
    } else {
      setStatus(statusText)
    }
  }

  /**
   * Two tickers instead of a wall of rows: one for pointer/keyboard actions and
   * one for tool activity. Each replaces its own previous row, so a run of
   * clicks reads as one line that keeps changing — the replies, the screenshots
   * and the errors stay where the user can find them.
   */
  function actRow(text) {
    presence.action('input', clipText(text, 90), undefined, 'act')
  }
  function toolRow(text) {
    presence.action('tool', clipText(text, 90), undefined, 'tool')
  }

  /** One-line strip pinned over the docked window. */
  function showBanner(text) {
    if (docked === null || docked.rect === undefined) return
    presence.banner({
      text,
      x: docked.rect.x,
      y: docked.rect.y,
      width: docked.rect.width,
    })
  }

  /**
   * Update the one-line status. While docked the card is hidden and `presence.status`
   * is a no-op there, so the strip over the panel is the only status the user can
   * see — per-step batch progress has to go to both surfaces or it goes nowhere.
   */
  function setStatus(text) {
    presence.status(text)
    if (docked !== null) showBanner(text)
  }

  /**
   * The placement the window had before it was docked. Kept on disk as well as
   * in memory, because a reload or a dropped message must not cost the user
   * their window geometry.
   */
  const dockRecordPath = path.join(tmpdir(), 'dsh-computer-use-dock.json')
  /** Where the panel was last dragged to, for `dockCorner: custom`. */
  const customPosPath = path.join(tmpdir(), 'dsh-computer-use-dockpos.json')

  /** Read the saved custom corner position, if the user ever dragged the panel. */
  function readCustomPos() {
    try {
      const saved = JSON.parse(readFileSync(customPosPath, 'utf8'))
      if (Number.isInteger(saved?.x) && Number.isInteger(saved?.y)) return saved
    } catch { /* first run with custom, or an unreadable file */ }
    return undefined
  }

  /** Read where the preview window was last dragged to, if it ever was. */
  function readPreviewPos() {
    try {
      const saved = JSON.parse(readFileSync(path.join(tmpdir(), 'dsh-computer-use-previewpos.json'), 'utf8'))
      if (Number.isInteger(saved?.x) && Number.isInteger(saved?.y)) return saved
    } catch { /* never dragged */ }
    return undefined
  }

  /** Remember where the panel sat when it was handed back. */
  async function rememberCustomPos(handle) {
    if (settings.dockCorner !== 'custom') return
    try {
      const rect = await host.request('windowrect', { handle }, 2_000)
      if (Number.isInteger(rect?.x) && Number.isInteger(rect?.y)) {
        await writeFile(customPosPath, JSON.stringify({ x: rect.x, y: rect.y }), 'utf8')
      }
    } catch { /* custom simply keeps its previous spot */ }
  }

  async function rememberDock(state) {
    try {
      await mkdir(path.dirname(dockRecordPath), { recursive: true })
      await writeFile(dockRecordPath, JSON.stringify(state), 'utf8')
    } catch { /* the in-memory copy still works */ }
  }

  async function forgetDock() {
    try { await rm(dockRecordPath, { force: true }) } catch { }
  }

  /**
   * A record is only useful when it holds the user's window. A narrow panel
   * glued to the top-right corner is the docked shape itself, which an older
   * build could save by mistake; restoring to that would look like "nothing
   * happened", so such a record is ignored and rewritten from the host.
   */
  function looksDocked(saved) {
    const parts = String(saved).split(',').map(Number)
    if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return true
    const [x, y, width] = parts
    return width <= 700 && y <= 60 && x >= 1400
  }

  async function loadDock() {
    try {
      const parsed = JSON.parse(await readFile(dockRecordPath, 'utf8'))
      if (Number.isInteger(parsed?.handle) && typeof parsed?.saved === 'string' && !looksDocked(parsed.saved)) return parsed
    } catch { /* nothing remembered */ }
    return null
  }

  /**
   * Keep the docked panel above whatever window the agent is driving. The panel
   * is the user's conversation, so it must not disappear behind the app being
   * clicked; topmost is the only thing an activation elsewhere cannot undo.
   */
  async function raiseDocked(handle) {
    if (!Number.isInteger(handle)) return
    try { await host.request('raise', { handle, topmost: true }, 4_000) } catch { }
  }

  /**
   * Keep the panel and the plugin's belief about it in step. If something outside
   * this plugin moves the conversation window — Windows restoring it, the app
   * relaying it out, the user dragging it — the status strip would still be drawn
   * at the old corner, and a batch would drive a picture of a window that is no
   * longer where the plugin thinks.
   */
  let dockRectCheckedAt = 0
  async function syncDockRect() {
    if (docked === null || docked.rect === undefined) return
    if (Date.now() - dockRectCheckedAt < 1_500) return
    dockRectCheckedAt = Date.now()
    let rect
    try { rect = await host.request('windowrect', { handle: docked.handle }, 2_000) } catch { return }
    if (rect === undefined || !Number.isInteger(rect?.x) || rect.width <= 1 || rect.height <= 1) return
    const same = Math.abs(rect.x - docked.rect.x) <= 2 && Math.abs(rect.y - docked.rect.y) <= 2
      && Math.abs(rect.width - docked.rect.width) <= 4 && Math.abs(rect.height - docked.rect.height) <= 4
    if (same) return
    // Back at the geometry it had before docking: the window was restored behind
    // our back. Dock it again instead of believing the corner still holds it.
    const saved = String(docked.saved ?? '').split(',').map(Number)
    const backHome = saved.length === 4 && saved.every(Number.isFinite)
      && Math.abs(rect.x - saved[0]) <= 40 && Math.abs(rect.y - saved[1]) <= 40
      && Math.abs(rect.width - saved[2]) <= 40
    if (backHome) {
      docked = null
      toolRow('窗口被还原了，重新停靠')
      await dockSelf()
      return
    }
    // Somewhere else entirely (the user moved it): follow it, never fight it.
    docked.rect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }

  /** Shrink this application's own window into the chosen corner. */
  async function dockSelf() {
    if (docked !== null) return
    try {
      const remembered = settings.dockCorner === 'custom' ? readCustomPos() : undefined
      const result = await host.request('dock', {
        process: 'DeepSeek Harness',
        width: settings.dockWidth,
        height: settings.dockHeight,
        margin: settings.dockMargin,
        corner: settings.dockCorner,
        ...remembered === undefined ? {} : { x: remembered.x, y: remembered.y },
      }, 8_000)
      if (typeof result?.saved === 'string' && Number.isInteger(result.handle)) {
        // An earlier turn may have been interrupted while docked: keep the
        // placement it recorded instead of the geometry the window has now.
        const previous = await loadDock()
        const saved = previous !== null && previous.handle === result.handle ? previous.saved : result.saved
        // A window the user had minimised is restored only for as long as the
        // agent needs it; undockSelf puts it back the way it was found.
        const wasMinimized = result.wasMinimized === true || previous?.wasMinimized === true
        docked = { saved, handle: result.handle, rect: result.rect, wasMinimized }
        await rememberDock({ saved, handle: result.handle, wasMinimized })
        await raiseDocked(result.handle)
        // The strip and the preview hug the frame the user can actually see, not the
        // invisible resize border GetWindowRect includes — otherwise they hang a few
        // pixels outside the panel and the self-check below would keep "fixing" it.
        try {
          const visible = await host.request('windowrect', { handle: result.handle }, 2_000)
          if (Number.isInteger(visible?.x) && visible.width > 1 && visible.height > 1) {
            docked.rect = { x: visible.x, y: visible.y, width: visible.width, height: visible.height }
          }
        } catch { /* keep the frame rect */ }
      }
    } catch (error) {
      setStatus(`停靠失败：${error?.message ?? '未知错误'}`)
    }
  }

  /** Put this application's window back where the user had it. */
  async function undockSelf() {
    // A dock record on disk means an earlier instance left the window in a corner
    // (crash, reload, disable), so it is restored even when this instance never
    // docked it and the mode is already float. Returns whether it restored.
    const state = docked ?? await loadDock()
    if (state === null) return false
    // A dragged panel is the user's answer to "where do you want it": keep that
    // spot for `dockCorner: custom` before the window is put back.
    await rememberCustomPos(state.handle)
    docked = null
    presence.bannerHide()
    const savedWidth = Number(state.saved.split(',')[2])
    let restored = false
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = await host.request('dock', {
          handle: state.handle,
          restore: true,
          saved: state.saved,
          minimize: state.wasMinimized === true,
        }, 8_000)
        restored = Number.isFinite(result?.rect?.width) ? Math.abs(result.rect.width - savedWidth) <= 40 : true
        if (restored) break
      } catch {
        if (attempt === 2) break
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    // Only drop the record once the window is really back at its old size: that
    // is what makes "docked but never restored" recoverable on the next turn.
    if (restored) await forgetDock()
    try { await host.request('raise', { handle: state.handle, topmost: false }, 4_000) } catch { }
    return restored
  }

  /**
   * Bring the window back the moment the dock switch is turned off.
   *
   * The end-of-turn restore is not enough: the switch lives on the settings page
   * and the corner panel is the thing the user is trying to get rid of, so a turn
   * that is still running used to keep the panel on screen for minutes after the
   * switch said "off".
   */
  let releaseInFlight = false
  async function releaseDockNow() {
    // No `docked === null` guard: a window left in a corner by an earlier process
    // must still come back, and undockSelf reads the on-disk record for exactly
    // that case. It returns false when there was nothing to restore.
    if (releaseInFlight) return false
    releaseInFlight = true
    try {
      const restored = await undockSelf()
      if (restored) {
        presence.glowDockClear()
        toolRow('右上角悬浮窗已关，窗口回到原位')
      }
      return restored
    } catch { return false } finally {
      releaseInFlight = false
    }
  }

  /**
   * The docked panel stays on top, so a click aimed at something it covers would
   * land on the panel itself. The host checks the point against the panel and,
   * when they collide, slips the panel behind everything for that one action.
   */
  function panelHandle() {
    return docked === null ? undefined : docked.handle
  }


  // A reply typed into the card joins the running turn as steering input.
  presence.on('reply', ({ text, immediate }) => {
    const agents = ctx.get('agents')
    const agent = agents === undefined || activeAgentId === null ? undefined : agents.get(activeAgentId)
    if (agent === undefined) {
      setStatus('当前没有可以接收消息的会话')
      return
    }
    const message = userMessage(text)
    // Enter queues the text as the next turn's work; Ctrl+Enter steers this turn.
    if (immediate) agent.steer(message)
    else agent.followup(message)
  })

  // Persist the size the user settles on, so the next run opens the same way.
  let cardSizeTimer = null
  presence.on('resized', ({ width, height }) => {
    if (cardSizeTimer !== null) clearTimeout(cardSizeTimer)
    const clampedWidth = Math.min(Math.max(Math.round(width), 380), 1200)
    const clampedHeight = Math.min(Math.max(Math.round(height), 320), 1400)
    cardSizeTimer = setTimeout(() => {
      cardSizeTimer = null
      writeFile(cardSizePath(), JSON.stringify({ width: clampedWidth, height: clampedHeight }), 'utf8')
        .catch(() => { /* a read-only home directory must not break the overlay */ })
    }, 400)
  })

  // The preview's grab handle reports where the user dropped it; that spot then
  // beats the corner setting until it is draggeed somewhere else.
  presence.on('preview-moved', ({ x, y }) => {
    manualPreview = { x, y }
  })

  // A finished recording goes to the same local recognizer the app uses, which
  // is far more accurate for Chinese than the system dictation engine.
  presence.on('voice', async ({ path: audioPath }) => {
    const speech = ctx.get('speechToText')
    if (speech === undefined) {
      presence.voiceError('这台机器没有挂载语音识别服务')
      return
    }
    try {
      const audio = await readFile(audioPath)
      // The local model may still be cold; prepare it and wait for readiness so
      // the first recording after a restart is not rejected.
      const snapshot = speech.snapshot()
      const providerId = snapshot?.selection?.providerId
      const provider = snapshot?.providers?.find(entry => entry.id === providerId)
      if (providerId !== undefined && provider?.preparation?.phase !== 'ready') {
        try { speech.prepare(providerId) } catch { /* reported by the wait below */ }
        const deadline = Date.now() + 45_000
        while (Date.now() < deadline) {
          const current = speech.snapshot()?.providers?.find(entry => entry.id === providerId)
          if (current?.preparation?.phase === 'ready') break
          if (current?.preparation?.phase === 'failed') throw new Error(current.preparation.message ?? '语音模型准备失败')
          await new Promise(resolve => setTimeout(resolve, 300))
        }
      }
      const spec = speech.resolve({ audio, language: 'zh' })
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 60_000)
      const transcript = await speech.transcribe(spec, controller.signal).finally(() => clearTimeout(timer))
      const text = String(transcript?.text ?? '').trim()
      if (text.length === 0) presence.voiceError('没有识别出内容')
      else presence.voiceText(text)
    } catch (error) {
      presence.voiceError(error?.message ?? '未知错误')
    } finally {
      await rm(audioPath, { force: true }).catch(() => {})
    }
  })

  // The hotkey summons the card from anywhere and puts the caret in its input
  // box; it only submits a prompt when the profile asks for that explicitly.
  presence.on('hotkey', async () => {
    try {
      try { await presence.start() } catch { }
      // Docked mode has no card of its own: bring the real window forward
      // instead, otherwise the summon hotkey resurrects the old floating panel.
      if (settings.dockWindow && docked === null) await dockSelf()
      if (docked !== null) {
        presence.glowOnly(docked.handle)
        await raiseDocked(docked.handle)
        showBanner('热键唤起 — 直接在窗口里输入')
        return
      }
      const agents = ctx.get('agents')
      let agent = activeAgentId === null ? undefined : agents?.get(activeAgentId)
      if (agent === undefined) {
        for (const candidate of liveAgents.values()) agent = candidate
      }
      if (agent === undefined) {
        await presence.show({
          title: 'DeepSeek 正在使用你的电脑',
          status: '热键已唤起 — 先在主窗口发一条消息，之后热键就能直接接管这个会话',
        })
        presence.focusInput()
        return
      }
      activeAgentId = agent.id
    await presence.show({ title: 'DeepSeek 正在使用你的电脑', status: '热键唤起 — 直接输入，或点麦克风说话' })
    presence.focusInput()
      if (settings.hotkeyMode === 'prompt') {
        presence.action('user', `热键：${settings.hotkeyPrompt}`)
        agent.followup(userMessage(settings.hotkeyPrompt))
      }
    } catch (error) {
      setStatus(`热键处理失败：${error?.message ?? '未知错误'}`)
    }
  })

  // A second hotkey flips between the two window modes without touching any
  // config file: dock (the conversation window takes the corner) and float (only
  // a card appears and the window is left exactly where the user put it).
  presence.on('dock-toggle', async () => {
    settings.windowMode = settings.windowMode === 'dock' ? 'float' : 'dock'
    settings.dockWindow = settings.windowMode === 'dock'
    if (settings.windowMode === 'float' && docked !== null) {
      await undockSelf()
      presence.notice({
        title: '已切到悬浮窗',
        detail: '会话窗口回到原位；控制期间只出一张卡片，需要你确认时也在这里。',
        seconds: 3,
      })
      return
    }
    if (settings.windowMode === 'dock') {
      docked = null
      await dockSelf()
      if (docked !== null) {
        presence.glowOnly(docked.handle)
        await raiseDocked(docked.handle)
        presence.notice({ title: '已切到停靠', detail: '控制期间这个窗口会缩到右上角，结束自动还原。', seconds: 3 })
      }
    }
  })

  // The user's brake: one keypress stops every input until they press it again.
  // The host is told as well, so the refusal holds in the layer that sends the
  // input even if this side is busy or the model retries.
  presence.on('pause-toggle', () => {
    applyPauseState(!paused, settings.pauseHotkey)
  })

  presence.on('pause-failed', ({ hotkey }) => {
    console.warn(`[computer-use] pause hotkey ${hotkey} could not be registered`)
  })

  /** How the user lifts the brake, spelled out for the places that say so. */
  function pauseKeyLabel() {
    return settings.pauseHotkey.length > 0 ? settings.pauseHotkey : '/pause off'
  }

  /**
   * A tool that only reads or flips the brake. It is not in ACTING_OPS, so it
   * still works while paused — otherwise nothing could report the state, and a
   * hotkey that failed to register would leave the user with no way back.
   * Lifting it is the user's decision, so the guidance keeps the model from
   * resuming on its own.
   */
  ctx.effect(() => ctx.tools.register({
    name: `${TOOL_PREFIX}paused`,
    description: 'Read or set the pause switch the user controls with a hotkey or /pause. While paused every click, '
      + 'keystroke, scroll and UIA action is refused, so use "status" freely but pass "resume" only after the user '
      + 'explicitly asks to continue — never to get yourself unstuck.',
    parameters: objectSchema({
      action: {
        type: 'string',
        enum: ['status', 'pause', 'resume'],
        description: 'status (default) only reports; pause and resume flip the switch.',
      },
    }),
    output: {
      schema: SUMMARY_VALUE_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const action = args?.action === 'pause' || args?.action === 'resume' ? args.action : 'status'
      if (action === 'pause' && !paused) applyPauseState(true, pauseKeyLabel())
      if (action === 'resume' && paused) applyPauseState(false, pauseKeyLabel())
      return {
        summary: paused
          ? `已暂停：点击、按键、滚动和 UIA 动作全部被拒绝。恢复方式：按 ${pauseKeyLabel()}，或让主人发 /pause off。`
          : '没有暂停，输入是允许的。',
      }
    },
  }))

  /**
   * /pause is the keyboard-free way to work the brake, and the way back when the
   * global hotkey could not be registered (another app may already own it). It
   * runs against the session directly, so it works whether or not a turn is
   * running, and it never becomes a model message.
   */
  try {
    const commands = ctx.get('commands')
    if (commands !== undefined && typeof commands.register === 'function') {
      ctx.effect(() => {
        const disposer = commands.register({
          name: 'pause',
          description: '暂停/恢复桌面控制（等同 Ctrl+Alt+Q）',
          input: { hint: '[on|off]' },
          handler: ({ rawInput }) => {
            const want = String(rawInput ?? '').trim().toLowerCase()
            if (want !== '' && want !== 'on' && want !== 'off' && want !== 'status') {
              return { kind: 'error', text: '用法：/pause（切换）、/pause on、/pause off' }
            }
            if (want === 'on') applyPauseState(true, pauseKeyLabel())
            else if (want === 'off') applyPauseState(false, pauseKeyLabel())
            else if (want === '') applyPauseState(!paused, pauseKeyLabel())
            return {
              kind: 'success',
              text: paused
                ? `已暂停：点击、按键、滚动、UIA 全部拒绝。恢复：/pause off，或按 ${pauseKeyLabel()}。`
                : '已恢复控制。',
            }
          },
        })
        return typeof disposer === 'function' ? disposer : () => { }
      })
      // The start stamp is written before registrations happen, so the command
      // surface records itself here where diagnostics can read it back.
      try {
        const home = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
        writeFileSync(path.join(home, 'computer-use-commands.json'), JSON.stringify({
          commands: ['pause'],
          registeredAt: new Date().toISOString(),
        }), 'utf8')
      } catch { /* diagnostics only */ }
    }
  } catch (error) {
    console.warn(`[computer-use] could not register /pause: ${error?.message ?? 'unknown error'}`)
  }

  presence.on('hotkey-failed', ({ hotkey }) => {
    setStatus(`全局热键 ${hotkey} 注册失败，可能被其它程序占用`)
  })

  presence.on('stop', () => {
    const agents = ctx.get('agents')
    const agent = agents === undefined || activeAgentId === null ? undefined : agents.get(activeAgentId)
    if (agent === undefined) {
      presence.hide()
      return
    }
    presence.stopAck('正在停止…')
    try {
      agent.cancel({ kind: 'user' })
    } catch {
      presence.hide()
    }
  })

  // The card mirrors the live session so the user can follow the work without
  // switching windows: their own messages, the agent's wording, and its tools.
  ctx.on('session/event', (session, event) => {
    if (activeAgentId === null || session.id !== activeAgentId) return
    if (event.type === 'turn/end') {
      liveBuffer = ''
      stopLiveTimer()
      stopTargetTracking()
      presence.live('')
      presence.finish(event.data?.reason?.kind === 'aborted' ? '已停止' : '已完成')
      // Nothing needs the helper between turns any more (no global hotkey), so
      // let it exit instead of idling in the background. The window comes back
      // first, and undockSelf reads its record from disk when this instance has
      // lost it, so a docked corner can never survive the end of a turn.
      const stopTimer = setTimeout(() => {
        // A new turn may have started inside these six seconds: its card and
        // hotkey must not be killed by the previous turn's timer.
        if (docked === null && !presence.visible) presence.stop()
      }, 6_000)
      stopTimer.unref?.()
      turnStopTimer = stopTimer
      void undockSelf().catch(() => { })
      return
    }
    if (!settings.mirror) return
    if (event.type === 'user/message') {
      const text = messageText(event.data?.content)
      if (text.length > 0 && !text.startsWith('<system-reminder')) {
        presence.action('user', `你：${clipText(text, 160)}`)
      }
      // A fresh instruction from the user clears the stuck-run breaker.
      consecutiveFailures = 0
      return
    }
    if (event.type === 'assistant/message') {
      const text = messageText(event.data?.message?.content)
      if (text.length > 0) presence.action('assistant', clipText(text, 240))
      liveBuffer = ''
      stopLiveTimer()
      presence.live('')
      return
    }
    if (event.type === 'tool/call') {
      // One row per tool call turned the card into a log of names ("调用 X",
      // "调用 Y"). The tool row is now a single line that keeps changing, so the
      // call ticker and the tool's own result share it and never stack up.
      const name = String(event.data?.name ?? '')
      if (name.length > 0 && !name.startsWith(TOOL_PREFIX)) toolRow(`调用 ${name}`)
      if (name === 'ask_user_question' || name === 'ask_user') {
        const question = firstQuestion(event.data)
        if (question.length > 0) presence.action('assistant', `问：${clipText(question, 200)}`)
      }
    }
  })

  /** The first question text of an ask-style tool call, if it carries one. */
  function firstQuestion(data) {
    const list = data?.args?.questions ?? data?.input?.questions ?? data?.questions
    const text = Array.isArray(list) ? list[0]?.question : list?.question
    return typeof text === 'string' ? text.trim() : ''
  }

  /** Plain text of one message's content blocks, trimmed. */
  function messageText(content) {
    if (!Array.isArray(content)) return ''
    const parts = []
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join('\n').trim()
  }

  /** Bound one mirrored line so a long answer cannot flood the card. */
  function clipText(text, maximum) {
    return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`
  }

  /** Buffer of the agent's current, not-yet-committed output. */
  let liveBuffer = ''
  /** Pending throttle timer for live output updates. */
  let liveTimer = null

  /** Drop the pending live-output update. */
  function stopLiveTimer() {
    if (liveTimer === null) return
    clearTimeout(liveTimer)
    liveTimer = null
  }

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (!settings.mirror || activeAgentId === null || agent.id !== activeAgentId) return
    if (frame?.type !== 'chunk' || frame.chunk?.type !== 'text-delta') return
    liveBuffer += String(frame.chunk.text ?? '')
    if (liveBuffer.length > 800) liveBuffer = liveBuffer.slice(-800)
    if (liveTimer !== null) return
    liveTimer = setTimeout(() => {
      liveTimer = null
      presence.live(liveBuffer.slice(-180))
    }, 400)
  })

  const liveAgents = new Map()
  ctx.on('agent/created', ({ agent }) => {
    liveAgents.set(agent.id, agent)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    liveAgents.delete(agent.id)
    if (activeAgentId === null || agent.id !== activeAgentId) return
    activeAgentId = null
    presence.hide()
    // Closing the conversation is the user's natural "we are done": hand the
    // window back instead of leaving it shrunk in a corner until the next turn.
    void undockSelf().catch(() => { })
  })

  ctx.effect(() => {
    // A helper left over from an earlier plugin generation keeps the hotkey
    // registration and makes the new layer look broken, so clear them first.
    // The match must distinguish a live overlay ("-Sta ... overlay.ps1") from
    // this very command line, which also contains the script name.
    const cleanup = new Promise((resolve) => {
      if (process.platform !== 'win32') {
        resolve()
        return
      }
      const sweep = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*-Sta*overlay.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
      ], { windowsHide: true, stdio: 'ignore' })
      sweep.on('exit', () => resolve())
      sweep.on('error', () => resolve())
    })
    // The floating layer owns the summon hotkey, so it has to exist before the
    // first desktop action; it starts with both windows hidden.
    cleanup.catch(() => {})
    return () => {
      stopLiveTimer()
      stopTargetTracking()
      // The idle interval and a docked window would outlive the plugin: stop the
      // timer and hand the window back before the helper processes go away.
      if (idleTimerHandle !== null) { clearInterval(idleTimerHandle); idleTimerHandle = null }
      void undockSelf().catch(() => { })
      presence.dispose()
      host.dispose()
      captures.clear()
      approvedSessions.clear()
      pendingIntents.clear()
    }
  })

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    ctx.effect(() => systemPrompt.section({ name: 'computer-use-windows', order: 60, text: GUIDANCE }))
  }

  /** Resolve the configured screenshot directory, expanding %VAR% placeholders. */
  function resolveShotDir() {
    const raw = typeof settings.shotDir === 'string' ? settings.shotDir.trim() : ''
    const base = raw.length === 0 ? path.join(tmpdir(), 'dsh-computer-use', 'shots') : raw
    const expanded = base.replace(/%([^%]+)%/g, (whole, envName) => process.env[envName] ?? whole)
    return path.resolve(expanded)
  }

  /** Keep the newest `keepShots` screenshots; older ones are deleted. */
  async function pruneShots(directory) {
    if (settings.keepShots <= 0) return
    try {
      const entries = await readdir(directory, { withFileTypes: true })
      const files = []
      for (const entry of entries) {
        // Thumbnails are transient: the preview timer deletes them, and counting
        // them here would push real screenshots out of the window.
        if (entry.isFile() !== true || !/^screen-.*\.png$/i.test(entry.name)) continue
        const full = path.join(directory, entry.name)
        try { files.push({ full, at: (await stat(full)).mtimeMs }) } catch { /* vanished mid-scan */ }
      }
      if (files.length <= settings.keepShots) return
      files.sort((left, right) => right.at - left.at)
      for (const file of files.slice(settings.keepShots)) {
        await rm(file.full, { force: true }).catch(() => { })
      }
    } catch { /* pruning is housekeeping, never fatal */ }
  }

  /** Resolve (and create once) the directory holding screenshots. */
  async function captureDirectory() {
    const wanted = resolveShotDir()
    if (tempDirectory !== wanted) {
      tempDirectory = wanted
      await mkdir(tempDirectory, { recursive: true }).catch(() => { })
    }
    return tempDirectory
  }

  // Keystrokes and submissions used to be classified as "dangerous" and needed
  // the red confirmation card, which made typing a command and pressing Enter
  // impossible while docked. The user asked for that gate to be removed: key and
  // text input now follow the normal approval policy like any other action.
  // The file tool keeps its own danger flag for delete / move / overwrite.

  /** Ask once per configured policy before an input action. */
  async function requireApproval(exec, toolName, what, intent) {
    const danger = intent?.danger === true
    if (settings.approval === 'never' && !danger) return
    const agent = exec.agent
    if (agent === undefined) {
      throw new Error(`${toolName} needs an interactive agent session to approve desktop control`)
    }
    if (!danger && settings.approval === 'once-per-session' && approvedSessions.has(agent.id)) return
    const approval = ctx.get('approval')
    if (approval === undefined) return
    // Ask in the floating card first: that is the surface the user is already
    // watching while the agent drives the desktop. Docked mode keeps that card
    // collapsed, so without bringing it back the question would have nowhere to
    // appear and a confirmation could never be answered.
    const showCardFirst = presence.available && !presence.visible && docked !== null
    if (showCardFirst) {
      await presence.show({ title: 'DeepSeek 想先确认这一步', status: intent?.label ?? toolName })
    }
    try {
      if (presence.available && presence.visible) {
        toolRow(`请求确认：${intent?.label ?? toolName}`)
        const answer = await presence.ask({
          title: intent?.title ?? `DeepSeek 想在您的电脑上执行 ${toolName}`,
          detail: intent?.detail ?? '',
          app: activeWindowLabel,
          risk: danger
            ? '这一步不可撤销，请先确认目标窗口和将要发生的改变。'
            : '可以打开、更改或删除任何文件，并运行应用和脚本。',
          danger,
          timeoutMs: danger ? 180_000 : 120_000,
        })
        if (answer !== 'allow') {
          presence.action('error', answer === 'deny' ? '已拒绝' : '未应答，改为在 DSH 中确认')
        }
        if (answer === 'allow') {
          if (!danger && settings.approval === 'once-per-session') approvedSessions.add(agent.id)
          return
        }
        if (answer === 'deny') {
          throw new Error(`the user denied ${what} on the desktop`)
        }
        // A dangerous action never falls through to a policy that auto-approves.
        if (danger) {
          throw new Error(`${what} was not confirmed in the floating card, so it was not performed`)
        }
        // A timeout or an overlay failure falls through to the app prompt below.
      }
    } finally {
      if (showCardFirst) {
        // Give the corner back to the docked window once the question is answered.
        if (docked !== null) presence.glowOnly(docked.handle)
        presence.hideCard()
      }
    }
    // Dangerous actions have no fallback: without the card they are refused,
    // because the session policy may approve everything.
    if (danger) {
      throw new Error(`${what} needs confirmation in the floating card, which is not available right now`)
    }
    pendingIntents.set(exec.callId, {
      title: intent?.title ?? `DeepSeek 想在您的电脑上执行 ${toolName}`,
      detail: intent?.detail ?? '',
      app: activeWindowLabel,
    })
    let outcome
    try {
      outcome = await approval.request({
        agent,
        toolName,
        callId: exec.callId,
        reason: `computer control: ${what}`,
        displayReason: approvalReason(what),
        signal: exec.signal,
      })
    } finally {
      pendingIntents.delete(exec.callId)
    }
    if (outcome !== 'allowed-once') {
      throw new Error(`the user did not approve ${what} on the desktop (${outcome})`)
    }
    if (settings.approval === 'once-per-session') approvedSessions.add(agent.id)
  }

  /** Flash the exact spot the next click will land, so the user sees it coming. */
  async function previewPoint(screenX, screenY) {
    if (!settings.clickPreview) return
    presence.point(screenX, screenY)
    if (settings.previewMs > 0) await new Promise(resolve => setTimeout(resolve, settings.previewMs))
  }

  /**
   * Map a point from the last screenshot's image space onto physical screen pixels.
   * `space: 'screen'` skips the mapping: the numbers came from something that
   * already speaks screen pixels (an OCR line, a UIA rectangle), and pushing them
   * through a picture they were not read from would move them.
   *
   * A point outside the picture is refused rather than pulled back to the edge.
   * Clamping looked helpful and was the opposite: (5000,5000) became the corner of
   * the screen and a real click landed there — which once minimised every window.
   * Only a zoom may clamp, and it says so in its result.
   */
  function toScreen(exec, x, y, space, options = {}) {
    if (space === 'screen') {
      return { screenX: Math.round(x), screenY: Math.round(y), clamped: false, mapped: false, literal: true }
    }
    const capture = captures.get(exec.agent?.id ?? '')
    if (capture === undefined) {
      // Without a capture the number is taken literally as a screen pixel. That is
      // the right reading of UIA coordinates, and it must be said out loud.
      return { screenX: Math.round(x), screenY: Math.round(y), clamped: false, mapped: false }
    }
    const maxX = Math.max(0, capture.imageWidth - 1)
    const maxY = Math.max(0, capture.imageHeight - 1)
    if (options.clamp !== true && (x < 0 || y < 0 || x > maxX || y > maxY)) {
      throw new Error(
        `坐标 (${x}, ${y}) 不在上一张截图里（图是 0..${maxX} × 0..${maxY}）——这次什么都没做，没有点击也没有拖动。`
        + '两个办法：重新截一张图再给坐标；或者如果这些数字本来就是屏幕像素（OCR 的行、控件矩形），'
        + '在这些坐标所在的步骤上加 space:"screen"。',
      )
    }
    const safeX = Math.min(Math.max(x, 0), maxX)
    const safeY = Math.min(Math.max(y, 0), maxY)
    // The age that matters is the picture's, not the window geometry's: following
    // a window refreshes where it is, not what it shows.
    const ageMs = Date.now() - (capture.shotAt ?? capture.at ?? Date.now())
    // Actions refuse a picture old enough that the layout may have moved. A
    // warning was not enough: the model reads the pixels it just saw and assumes
    // nothing changed, while a page can reflow in seconds. `allow_stale` is the
    // explicit way to say "I know the picture is old, this target did not move".
    if (options.strictAge === true && ageMs > settings.coordinateTtlMs && options.allowStale !== true) {
      throw new Error(
        `上一张截图是 ${(ageMs / 1000).toFixed(1)} 秒前拍的，超过了 ${(settings.coordinateTtlMs / 1000).toFixed(0)} 秒的时效——`
        + '界面可能已经变了，这次什么都没有做。先重新截一张图再点；如果确认画面没动，给这一步加 allow_stale:true。',
      )
    }
    return {
      screenX: Math.round(capture.screenX + safeX * (capture.screenWidth / capture.imageWidth)),
      screenY: Math.round(capture.screenY + safeY * (capture.screenHeight / capture.imageHeight)),
      clamped: safeX !== x || safeY !== y,
      mapped: true,
      ageMs,
    }
  }

  /** Render a point the way its own coordinate space names it. */
  function describePoint(space, x, y, mapped) {
    if (space === 'screen') return `screen (${mapped.screenX}, ${mapped.screenY})`
    return `image (${x}, ${y}) = screen (${mapped.screenX}, ${mapped.screenY})${clampNote(mapped)}${freshnessNote(mapped)}`
  }

  /** Note in a summary when a zoom rectangle was pulled back inside the capture. */
  function clampNote(mapped) {
    return mapped.clamped ? '（矩形超出了这张图，已裁到图的边缘）' : ''
  }

  /**
   * Say how trustworthy the coordinate mapping is. A click derived from a picture
   * taken minutes ago is the most common way desktop automation lands on the wrong
   * control, and the model cannot see the age unless the result tells it. The age
   * is the picture's: following a window keeps the mapping right, not the content.
   */
  function freshnessNote(mapped) {
    if (mapped.mapped === false) {
      return ' (no screenshot yet: the coordinates were taken as physical screen pixels)'
    }
    if (mapped.ageMs > settings.coordinateTtlMs) {
      return ` (warning: that screenshot is ${Math.round(mapped.ageMs / 1000)} s old — look again if anything moved)`
    }
    return ''
  }

  /**
   * Say where a keystroke or a paste actually landed. Key events follow the focus,
   * so a silent mis-delivery looks exactly like an application ignoring the input.
   */
  function deliveryNote(exec, result) {
    const title = typeof result?.title === 'string' ? result.title : ''
    const where = title.length > 0 ? ` Sent to 「${title.slice(0, 40)}」.` : ''
    const capture = captures.get(exec?.agent?.id ?? '')
    if (capture !== undefined && Number.isInteger(capture.handle)
      && Number.isInteger(result?.foreground) && result.foreground !== capture.handle) {
      return `${where} (that is not the window you last captured — focus it first if the input was meant for it)`
    }
    return where
  }

  /** Define an input action tool whose outcome is one summary line. */
  /** A single desktop step that never reported back in time. */
  class StepTimeout extends Error {}

  /** Failures that are worth one automatic retry before asking the user. */
  function isRetryable(error) {
    if (error instanceof StepTimeout) return true
    const text = String(error?.message ?? '')
    return /no longer exists|not found|not ready|timed out|timeout|ECONNRESET|EPIPE|窗口|元素不在|挂起/u.test(text)
  }

  /** Run one step under a deadline so a hung call cannot stall the whole run. */
  async function runWithTimeout(task, milliseconds) {
    if (!(milliseconds > 0)) return await task()
    let timer
    try {
      return await Promise.race([
        task(),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new StepTimeout(`这一步超过 ${Math.round(milliseconds / 1000)} 秒没有结果`))
          }, milliseconds)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * The bare step implementations, keyed by tool name, so a batch can replay them
   * without going back through a model round trip for each one.
   */
  const actionPerforms = new Map()

  function actionTool({ name, description, parameters, what, whatZh, describe, perform, noAlign = false }) {
    actionPerforms.set(name, perform)
    return {
      name,
      description,
      parameters,
      output: {
        schema: SUMMARY_VALUE_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const input = args ?? {}
        // The user's brake comes first: while paused there is nothing to attempt,
        // so this must not reach the approval card or the failure counter.
        if (paused) throw new PausedError(PAUSE_ERROR)
        if (consecutiveFailures >= settings.failureLimit) {
          throw new Error(
            `已暂停：连续 ${consecutiveFailures} 次动作失败。先用 computer_screenshot 看清屏幕，把卡住的地方告诉用户，再决定下一步。`,
          )
        }
        await beginPresence(exec, `正在${whatZh}…`)
        await requireApproval(exec, name, what, {
          title: `DeepSeek 想在您的电脑上${whatZh}`,
          detail: describe?.(input) ?? '',
          label: whatZh,
          danger: false,
        })
        setStatus(`正在${whatZh}…`)
        // Keys and text go wherever the user (or the model) put the focus; only
        // coordinate actions need the captured window brought back up front.
        const focusNote = noAlign ? '' : await alignWindowTarget(exec)
        const attempts = settings.retryOnce ? 2 : 1
        let failure
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          try {
            const summary = await runWithTimeout(() => perform(input, exec), settings.stepTimeoutMs)
            consecutiveFailures = 0
            presence.action('input', clipText(summary, 90), undefined, 'act')
            return { summary: `${summary}${focusNote}` }
          } catch (error) {
            if (error instanceof PausedError) throw error
            failure = error
            if (attempt < attempts && isRetryable(error)) {
              presence.action('error', `第 ${attempt} 次没成（${error?.message ?? '未知错误'}），重试一次`)
              setStatus('重试中…')
              await new Promise(resolve => setTimeout(resolve, 400))
              continue
            }
            break
          }
        }
        consecutiveFailures += 1
        const reason = failure?.message ?? '未知错误'
        const breakerTripped = consecutiveFailures >= settings.failureLimit
        const message = breakerTripped
          ? `${reason}（已连续失败 ${consecutiveFailures} 次，动作已暂停：先截图确认屏幕现状，再向用户说明卡在哪）`
          : reason
        presence.action('error', breakerTripped ? `已暂停：${message}` : `失败：${message}`)
        throw new Error(message)
      },
    }
  }

  /** Poll timer that keeps the on-screen target frame glued to its window. */
  let targetTimer = null

  /** Stop tracking the current window target. */
  function stopTargetTracking() {
    if (targetTimer === null) return
    clearInterval(targetTimer)
    targetTimer = null
    presence.targetClear()
  }

  /** Follow one window so the user can see which one is being driven. */
  function startTargetTracking(capture) {
    stopTargetTracking()
    if (capture.kind !== 'window' || !Number.isInteger(capture.handle)) return
    const follow = async () => {
      try {
        const rect = await host.request('windowrect', { handle: capture.handle })
        if (rect === undefined || rect.width <= 1 || rect.height <= 1) {
          presence.targetClear()
          return
        }
        reanchorCapture(capture, rect)
        presence.target({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          label: `${capture.process ? `${capture.process} · ` : ''}${capture.title ?? ''}`.slice(0, 60),
        })
      } catch { /* a closed window simply loses its frame */ }
    }
    void follow()
    targetTimer = setInterval(() => { void follow() }, 400)
  }

  /**
   * Point a capture's coordinate mapping at its window's current rectangle.
   *
   * A picture of a *piece* of the window keeps its offset from the window's corner
   * and its own size — a zoomed picture is 60x40 screen pixels, not the 1282x821
   * window. Overwriting the size here is what made "zoom, then click in the zoomed
   * image" land hundreds of pixels away, because the record ended up claiming the
   * tiny image covered the whole window.
   */
  function reanchorCapture(capture, rect) {
    const regionOffsetX = Number.isInteger(capture.regionOffsetX) ? capture.regionOffsetX : undefined
    capture.screenX = rect.x + (regionOffsetX ?? 0)
    capture.screenY = rect.y + (Number.isInteger(capture.regionOffsetY) ? capture.regionOffsetY : 0)
    if (regionOffsetX === undefined) {
      capture.screenWidth = rect.width
      capture.screenHeight = rect.height
    }
    // The picture is old but its mapping is not: the window is followed, so a
    // click derived from it still lands on the same relative spot.
    capture.at = Date.now()
  }

  /**
   * Bring the window capture's window forward and refresh its geometry. Returns a
   * note for the result when the focus really had to move — the model should know
   * that its keystroke or click was aimed by the plugin, not by where it had just
   * clicked.
   */
  async function alignWindowTarget(exec) {
    const capture = captures.get(exec.agent?.id ?? '')
    if (capture === undefined || capture.kind !== 'window' || !Number.isInteger(capture.handle)) return ''
    if (!settings.activateBeforeActing) return ''
    try {
      const focus = await host.request('focus', { handle: capture.handle })
      const rect = await host.request('windowrect', { handle: capture.handle })
      if (rect !== undefined && rect.width > 1 && rect.height > 1) {
        // Re-read geometry means the mapping is current, even if the pixels are not.
        // A zoomed region keeps its offset and its own size (see reanchorCapture).
        reanchorCapture(capture, rect)
      }
      if (focus?.wasForeground === true) return ''
      return ` (the input went to 「${(capture.title || 'window').slice(0, 40)}」, which was brought to the front first)`
    } catch { return '' }
  }
  /** Last picture fingerprint per agent and target, so a static screen costs no image. */
  const lastShotHash = new Map()

  /** Where the floating capture preview sits, so it can be masked out of captures. */
  let lastPreviewRect = null
  /** Where the user last dragged the preview; wins over the corner setting. */
  let manualPreview
  /** Corner setting seen last call, so choosing a corner clears a stale drag. */
  let lastPreviewCorner = settings.previewCorner

  /** The virtual desktop rectangle, cached for a few seconds. */
  let screenBoundsCache
  async function screenBounds() {
    const now = Date.now()
    if (screenBoundsCache !== undefined && now - screenBoundsCache.at < 10_000) return screenBoundsCache.rect
    let rect = { left: 0, top: 0, width: 1920, height: 1080 }
    try {
      const listing = await host.request('monitors', {}, 3_000)
      const monitors = Array.isArray(listing?.monitors) ? listing.monitors : []
      const usable = monitors.filter((monitor) => Number.isInteger(monitor?.x) && Number.isInteger(monitor?.y)
        && Number.isFinite(monitor?.width) && Number.isFinite(monitor?.height) && monitor.width > 0 && monitor.height > 0)
      if (usable.length > 0) {
        const left = Math.min(...usable.map((monitor) => monitor.x))
        const top = Math.min(...usable.map((monitor) => monitor.y))
        const right = Math.max(...usable.map((monitor) => monitor.x + monitor.width))
        const bottom = Math.max(...usable.map((monitor) => monitor.y + monitor.height))
        rect = { left, top, width: right - left, height: bottom - top }
      }
    } catch { /* keep the fallback */ }
    screenBoundsCache = { at: now, rect }
    return rect
  }

  const PREVIEW_WIDTH = 340
  const PREVIEW_HEIGHT = 228

  /**
   * Where the floating copy of a capture goes.
   *
   * Follow mode: beside the docked panel, or beside the floating card — the
   * overlay computes that side from its own window, so it stays glued even when
   * the card is resized. Free mode: the corner the user picked, or the remembered
   * custom spot. Everything is clamped to the virtual desktop, so the preview can
   * never hang off the screen.
   */
  async function previewRect() {
    const gap = 12
    if (lastPreviewCorner !== settings.previewCorner) {
      // Picking a corner in Settings means "forget where I dragged it".
      lastPreviewCorner = settings.previewCorner
      manualPreview = undefined
      void rm(path.join(tmpdir(), 'dsh-computer-use-previewpos.json'), { force: true }).catch(() => { })
    }
    const bounds = await screenBounds()
    if (settings.previewFollow && docked !== null && docked.rect !== undefined) {
      const panel = docked.rect
      let x = panel.x - PREVIEW_WIDTH - gap
      if (x < bounds.left + 8) x = panel.x + panel.width + gap
      let y = panel.y + gap
      if (x + PREVIEW_WIDTH > bounds.left + bounds.width - 8) {
        x = Math.max(bounds.left + 8, bounds.left + bounds.width - PREVIEW_WIDTH - 8)
      }
      if (y + PREVIEW_HEIGHT > bounds.top + bounds.height - 8) {
        y = Math.max(bounds.top + 8, bounds.top + bounds.height - PREVIEW_HEIGHT - 8)
      }
      return { x: Math.round(x), y: Math.round(y), width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT }
    }
    if (settings.previewFollow && settings.effects.card) {
      // The overlay owns the card, so it is the one that can hug its edge.
      return { follow: 'card', width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT }
    }
    let x
    let y
    const dragged = manualPreview ?? readPreviewPos()
    if (dragged !== undefined) {
      // The user put it somewhere by hand: that wins over the corner setting.
      x = dragged.x
      y = dragged.y
    } else if (settings.previewCorner === 'custom') {
      const custom = readCustomPos()
      x = Number.isInteger(custom?.x) ? custom.x : bounds.left + gap
      y = Number.isInteger(custom?.y) ? custom.y : bounds.top + gap
    } else {
      const corner = settings.previewCorner
      const leftSide = corner === 'topleft' || corner === 'bottomleft'
      const topSide = corner === 'topleft' || corner === 'topright'
      x = leftSide ? bounds.left + gap : bounds.left + bounds.width - PREVIEW_WIDTH - gap
      y = topSide ? bounds.top + gap : bounds.top + bounds.height - PREVIEW_HEIGHT - gap
    }
    x = Math.min(Math.max(x, bounds.left + 8), bounds.left + bounds.width - PREVIEW_WIDTH - 8)
    y = Math.min(Math.max(y, bounds.top + 8), bounds.top + bounds.height - PREVIEW_HEIGHT - 8)
    return { x: Math.round(x), y: Math.round(y), width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT }
  }

  /** Give the UI a moment to repaint before its pixels are trusted. */
  async function settleFrame() {
    if (settings.settleMs > 0) await new Promise((resolve) => { setTimeout(resolve, settings.settleMs) })
  }

  /** Key one window's snapshot by agent, since two agents act independently. */
  function uiSnapshotKey(exec, handle) {
    return `${exec.agent?.id ?? ''}:${handle}`
  }

  /**
   * Remember one read of a control tree, so a later action can check that a path
   * still points at the control the model was told about.
   */
  function rememberUiSnapshot(exec, handle, tree) {
    uiSnapshotSeq += 1
    const snapshot = {
      id: `s${uiSnapshotSeq.toString(36)}`,
      handle,
      at: Date.now(),
      elements: new Map(),
    }
    for (const element of tree.elements) {
      snapshot.elements.set(String(element.path), { type: element.type, name: String(element.name ?? '') })
    }
    uiSnapshots.set(uiSnapshotKey(exec, handle), snapshot)
    return snapshot
  }

  /** How a read of the tree is identified in the text the model sees. */
  function snapshotHint(snapshot) {
    return `快照 ${snapshot.id}：操作时把它一起传回来（snapshot: "${snapshot.id}"），`
      + '界面在这之后变过它就作废，避免误点到同名控件。'
  }

  /**
   * The identity a path must still have before an action runs.
   *
   * The snapshot id the model carried along is checked first, because that is the
   * one case a name check cannot catch: two different controls that look alike
   * swapping places between two reads. What is returned is what the host compares
   * against the live control just before it acts.
   */
  function uiExpectation(exec, handle, path, snapshotId) {
    const snapshot = uiSnapshots.get(uiSnapshotKey(exec, handle))
    if (snapshot === undefined) return {}
    const wanted = typeof snapshotId === 'string' ? snapshotId.trim() : ''
    if (wanted.length > 0 && wanted !== snapshot.id) {
      throw new Error(`STALE_REF: 快照 ${wanted} 已经被 ${snapshot.id} 取代——这个窗口的元素树在那之后又读过一遍。`
        + ' 界面可能已经变了，所以这次操作没有执行；请用新快照里列出的路径重来。')
    }
    const known = snapshot.elements.get(path)
    if (known === undefined) return {}
    // Named the way the host reads them: the comparison happens on the live
    // control inside the same helper call that is about to act on it.
    return { expectType: known.type ?? '', expectName: known.name ?? '' }
  }

  /**
   * Run one UI Automation action. A path that no longer resolves is the same
   * situation as an outdated snapshot — the control the model meant is gone — so
   * it is reported with the same STALE_REF prefix instead of as a generic error
   * the model may read as "the tool is broken".
   */
  async function uiAct(payload) {
    try {
      return await host.request('uiact', payload)
    } catch (error) {
      const text = String(error?.message ?? '')
      if (!text.startsWith('STALE_REF') && /不在当前窗口里|no longer in this window/u.test(text)) {
        throw new Error(`STALE_REF: ${text}。这次操作没有执行。`)
      }
      throw error
    }
  }

  /**
   * Render a UI Automation tree as the compact text list the model acts on. The
   * bracketed names are exactly the computer_ui actions that element accepts.
   */
  function formatControlTree(tree, limit) {
    const rows = []
    for (const element of tree.elements) {
      if (element.offscreen === true && element.name === '') continue
      if (element.name === '' && element.patterns.length === 0 && element.type === 'Pane') continue
      const label = `${element.path}  ${element.type}`
        + `${element.name === '' ? '' : ` 「${element.name}」`}`
        + `${element.patterns.length === 0 ? '  (不可操作)' : ` [${element.patterns.join(' ')}]`}`
        + `  @${element.x},${element.y} ${element.width}×${element.height}`
      rows.push(element.offscreen === true ? `${label}  (屏外)` : label)
      if (rows.length >= limit) break
    }
    return rows
  }

  /** Controls that expose at least one action, which is what makes a tree worth reading. */
  function actionableCount(tree) {
    let count = 0
    for (const element of tree.elements) {
      if (element.offscreen !== true && element.patterns.length > 0) count += 1
    }
    return count
  }

  /**
   * Capture the desktop or one window. Identical pixels are reported as text and
   * never saved again: the model already holds that picture and its coordinate map,
   * and a second copy would cost tokens without telling it anything new.
   */
  async function captureOnce(exec, options) {
    const attachments = ctx.get('attachments')
    if (attachments === undefined) {
      throw new Error('cannot capture the desktop: no attachment service is mounted to hold the screenshot')
    }
    const windowHandle = Number.isInteger(options?.window) ? options.window : undefined
    const monitor = Number.isInteger(options?.monitor) ? options.monitor : settings.defaultMonitor
    /** One rectangle of the screen, in physical pixels, instead of the whole target. */
    const region = options?.region ?? undefined
    if (options?.settle !== false) await settleFrame()
    const directory = await captureDirectory()
    const file = path.join(directory, `screen-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
    let captured
    let bytes
    // Our own panel floats above the app and repaints on every capture, which made
    // two stills of the same screen differ byte for byte and defeated the duplicate
    // check. It covers whatever is behind it anyway, so painting it flat loses no
    // information the model could otherwise have had. The capture preview is ours
    // too, so it goes the same way.
    const masks = []
    if (windowHandle === undefined && docked !== null && docked.rect !== undefined
      && Number.isInteger(docked.rect.x) && Number.isInteger(docked.rect.y)) {
      masks.push({
        x: docked.rect.x - 6,
        y: docked.rect.y - 6,
        width: docked.rect.width + 12,
        height: docked.rect.height + 12,
      })
    }
    if (windowHandle === undefined && lastPreviewRect !== null) {
      masks.push({
        x: lastPreviewRect.x - 4,
        y: lastPreviewRect.y - 4,
        width: lastPreviewRect.width + 8,
        height: lastPreviewRect.height + 8,
      })
    }
    try {
      if (region !== undefined) {
        captured = await host.request('zoomshot', {
          outPath: file,
          maxWidth: settings.maxImageWidth,
          x: region.x,
          y: region.y,
          width: region.width,
          height: region.height,
          ...windowHandle === undefined ? { monitor } : { handle: windowHandle },
          ...masks.length === 0 ? {} : { masks },
        })
      } else if (windowHandle === undefined) {
        captured = await host.request('screenshot', { outPath: file, monitor, maxWidth: settings.maxImageWidth, ...masks.length === 0 ? {} : { masks } })
      } else {
        captured = await host.request('windowshot', { handle: windowHandle, outPath: file, maxWidth: settings.maxImageWidth })
      }
      bytes = await readFile(file)
    } finally {
      // With `keepShots > 0` the file stays: the user asked to be able to open
      // exactly what the agent saw. Pruning keeps the folder bounded.
      if (settings.keepShots <= 0) await rm(file, { force: true })
    }
    const isWindow = windowHandle !== undefined
    const isRegion = region !== undefined
    // A region capture reports its own rectangle, so both shapes of response are
    // read from the one field that is always the region when one was asked for.
    const direct = isWindow || isRegion
    const screenWidth = direct ? captured.width : captured.screenWidth
    const screenHeight = direct ? captured.height : captured.screenHeight
    const screenX = direct ? captured.x : captured.screenX
    const screenY = direct ? captured.y : captured.screenY
    const agentKey = exec.agent?.id ?? ''
    // A zoom dedupes against the same rectangle only: a region that happens to
    // match the last full-screen capture would otherwise be reported as "no
    // change" while pointing at a completely different picture.
    const targetKey = `${agentKey}:${isWindow ? `window:${windowHandle}` : `monitor:${monitor}`}`
      + `${isRegion ? `:r:${region.x},${region.y},${region.width},${region.height}` : ''}`
    const hash = createHash('sha1').update(bytes).digest('hex')
    const unchanged = settings.dedupeShots && lastShotHash.get(targetKey) === hash
    lastShotHash.set(targetKey, hash)
    const record = {
      kind: isWindow ? 'window' : 'screen',
      screenX,
      screenY,
      screenWidth,
      screenHeight,
      imageWidth: captured.imageWidth,
      imageHeight: captured.imageHeight,
      // `at` moves whenever the geometry is re-read; `shotAt` only when pixels are
      // taken (or proven identical), and that is the age the model is told about.
      at: Date.now(),
      shotAt: Date.now(),
      // Where the region sits inside its window, so following the window keeps a
      // zoomed picture's mapping valid instead of replacing it with a full rect.
      ...isRegion && Number.isInteger(captured.sourceX)
        ? { regionOffsetX: screenX - captured.sourceX, regionOffsetY: screenY - captured.sourceY }
        : {},
      ...isWindow
        ? { handle: windowHandle, title: captured.title ?? '', process: captured.process ?? '' }
        : {},
    }
    const ratio = captured.imageWidth / screenWidth
    const scale = ratio === 1 ? 'unscaled' : `downscaled to ${Math.round(ratio * 100)}%`
    const mapping = `computer_click, computer_drag, and computer_scroll read coordinates in this image: `
      + `(0,0) is ${isRegion ? 'the zoomed region top-left' : isWindow ? 'the window top-left' : 'the screen top-left'}, `
      + `(${captured.imageWidth - 1},${captured.imageHeight - 1}) its bottom-right.`
    if (unchanged) {
      presence.action('capture', '画面没有变化（未附新图）')
      consecutiveFailures = 0
      const kept = captures.get(agentKey)
      // The pixels were just proven identical to what the model already holds, so
      // that picture is current again — otherwise a long turn would keep warning
      // about an image it has already re-verified.
      if (kept !== undefined && kept.handle === record.handle
        && kept.imageWidth === record.imageWidth && kept.imageHeight === record.imageHeight) {
        kept.shotAt = Date.now()
        kept.at = Date.now()
      }
      return {
        record: kept ?? record,
        unchanged: true,
        summary: [
          `No change: every pixel matches the previous capture of the same target (image ${captured.imageWidth}x${captured.imageHeight}).`,
          `No new image is attached — the one you already have is still current, so ${mapping}`,
        ].join('\n'),
      }
    }
    const ref = await attachments.saveImage({ data: bytes, mediaType: 'image/png', name: 'capture.png' })
    captures.set(agentKey, record)
    if (isWindow) startTargetTracking(record)
    else stopTargetTracking()
    const geometry = isRegion
      ? `Zoomed ${isWindow ? `window "${record.title}"` : `monitor ${captured.monitor ?? monitor}`} at ${screenX},${screenY} ${screenWidth}x${screenHeight} screen px; image ${captured.imageWidth}x${captured.imageHeight} px (${scale}).`
      : isWindow
        ? `Captured window "${record.title}"${record.process === '' ? '' : ` (${record.process})`} at ${screenX},${screenY} ${screenWidth}x${screenHeight}; image ${captured.imageWidth}x${captured.imageHeight} px (${scale}).`
        : `Captured monitor ${captured.monitor ?? monitor}: ${screenWidth}x${screenHeight} px screen, image ${captured.imageWidth}x${captured.imageHeight} px (${scale}).`
    const maskNote = windowHandle === undefined && masks.length > 0
      ? '（画面里的灰色块是本插件自己的停靠面板或截图预览，截图前抹平了；要看那块内容就用 computer_screenshot 的 window 参数单独截它。）'
      : ''
    const cursor = captured.cursor ?? { x: 0, y: 0 }
    const active = captured.activeWindow ?? { title: '', handle: 0, process: '' }
    const summary = isWindow
      ? [geometry, mapping, `[handle ${record.handle}] The window is brought to the front before input is sent.`].join('\n')
      : [
          geometry,
          mapping,
          `Pointer at (${cursor.x}, ${cursor.y}). Active window: ${active.title.length === 0 ? '(none)' : `"${active.title}"`}${active.process.length === 0 ? '' : ` (${active.process})`} [handle ${active.handle}].`,
          ...maskNote === '' ? [] : [maskNote],
        ].join('\n')
    if (isWindow) {
      activeWindowLabel = `${(record.title || '窗口').slice(0, 24)} · 仅点击`
    } else if (active.title.length > 0) {
      activeWindowLabel = `${active.title.slice(0, 24)} · 仅点击`
    }
    try {
      const thumb = path.join(directory, `thumb-${Date.now()}.png`)
      await writeFile(thumb, bytes)
      // Prune after the new frame is on disk, so the count includes it and the
      // folder settles at exactly `keepShots` screenshots.
      await pruneShots(directory)
      const feedText = isRegion
        ? `放大了 ${screenWidth}×${screenHeight} 的局部`
        : isWindow
          ? `截取了窗口「${record.title || '未命名'}」`
          : `截取了显示器 ${monitor}（${screenWidth}×${screenHeight}）`
      // The preview goes first: it loads the file with OnLoad, and whoever shows the
      // picture also owns deleting it.
      // The preview goes first: it loads the file with OnLoad, and whoever shows the
      // picture also owns deleting it. It now appears in every mode — beside the
      // docked panel, beside the floating card, or in the chosen corner when no
      // control window is on screen.
      const rect = await previewRect()
      lastPreviewRect = rect.follow === undefined
        ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        : null
      if (rect !== undefined) {
        presence.preview({
          path: thumb,
          caption: `${feedText} · ${captured.imageWidth}×${captured.imageHeight}`,
          x: rect.x,
          y: rect.y,
          follow: rect.follow,
          ms: settings.previewShotMs,
        })
        // While docked the card is hidden, so its row handler — the thing that used
        // to delete this file — never runs. Without this the thumbnails piled up.
        setTimeout(() => { void rm(thumb, { force: true }).catch(() => { }) }, settings.previewShotMs + 3_000).unref?.()
      } else if (presence.visible) {
        lastPreviewRect = null
        presence.action('capture', feedText, thumb)
      } else {
        // Nothing on screen shows the picture: drop it straight away.
        lastPreviewRect = null
        void rm(thumb, { force: true }).catch(() => { })
      }
    } catch { /* the feed preview is optional */ }
    // Looking at the screen is how a stuck run recovers, so it clears the count.
    consecutiveFailures = 0
    return {
      record,
      unchanged: false,
      summary,
      image: {
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        name: ref.name ?? 'capture.png',
      },
    }
  }

  ctx.effect(() => ctx.tools.register({
    name: `${TOOL_PREFIX}progress`,
    description: 'Report where a long multi-step task stands: the floating card shows "[3/8] 正在…" with a thin progress bar, '
      + 'and the line is appended to a journal file so a later run can resume where this one stopped. '
      + 'Call it when starting each step of any longer job; read the journal with computer_files (action read) to recover.',
    parameters: objectSchema({
      step: { type: 'integer', description: 'Current step number, starting at 1.' },
      total: { type: 'integer', description: 'Total steps, when known; omit or 0 otherwise.' },
      label: { type: 'string', description: 'What is happening right now, one short line.' },
    }),
    output: {
      schema: SUMMARY_VALUE_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const step = Number.isInteger(args?.step) ? Math.max(args.step, 1) : 1
      const total = Number.isInteger(args?.total) ? Math.max(args.total, 0) : 0
      const label = String(args?.label ?? '').slice(0, 120)
      await beginPresence(exec, label.length > 0 ? label : `第 ${step} 步`)
      presence.progress({ step, total, label })
      showBanner(total > 0 ? `[${step}/${total}] ${label}` : label)
      const stamp = new Date().toISOString().slice(11, 19)
      const line = `- ${stamp} ${total > 0 ? `[${step}/${total}] ` : ''}${label}\n`
      try {
        await mkdir(path.dirname(journalPath()), { recursive: true })
        await appendFile(journalPath(), line)
      } catch { /* the journal is a convenience, not a hard requirement */ }
      return {
        summary: total > 0
          ? `已记录第 ${step}/${total} 步：${label}`
          : `已记录第 ${step} 步：${label}`,
      }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: `${TOOL_PREFIX}clipboard`,
    description: 'Read or write the system clipboard. Reading is how you extract text from an application exactly and cheaply: '
      + 'send ctrl+a then ctrl+c with computer_key, then read the clipboard here instead of OCR-ing a screenshot. '
      + 'Writing lets you stage text before pasting it somewhere with ctrl+v.',
    parameters: objectSchema({
      action: {
        type: 'string',
        enum: ['get', 'set'],
        description: 'Read the clipboard (get) or replace it (set).',
      },
      text: { type: 'string', description: 'Text to place on the clipboard when action is set.' },
    }),
    output: {
      schema: SUMMARY_VALUE_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const input = args ?? {}
      const action = input.action === 'set' ? 'set' : 'get'
      if (action === 'set') {
        const text = String(input.text ?? '')
        await host.request('clipboard', { mode: 'set', text })
        return { summary: `已把 ${text.length} 个字符放进剪贴板。` }
      }
      const result = await host.request('clipboard', { mode: 'get' })
      const text = String(result?.text ?? '')
      if (text.length === 0) return { summary: '剪贴板里没有文本。' }
      const clipped = text.length > 8000 ? `${text.slice(0, 8000)}\n…（共 ${text.length} 字，只显示前 8000）` : text
      return { summary: `剪贴板里有 ${text.length} 个字符：\n${clipped}` }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: `${TOOL_PREFIX}monitors`,
    description: 'List the connected displays with their index, primary flag, and screen bounds. '
      + 'Pass the index to computer_screenshot to capture a specific display; coordinates then start at that display\'s top-left.',
    parameters: objectSchema({}),
    output: {
      schema: SUMMARY_VALUE_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      const result = await host.request('monitors')
      const list = result?.monitors ?? []
      const rows = list.map(monitor => `${monitor.index}. ${monitor.width}×${monitor.height} @ ${monitor.x},${monitor.y}`
        + `${monitor.primary ? ' · 主显示器' : ''} (${monitor.deviceName})`)
      return { summary: `共 ${rows.length} 块显示器：\n${rows.join('\n')}` }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: `${TOOL_PREFIX}wait`,
    description: 'Wait for the screen to settle instead of taking screenshots in a loop. '
      + 'mode "element" waits until a UI Automation control with `name` appears (or disappears when state is "disappear"); '
      + 'mode "stable" waits until the window picture stops changing (page loaded, import finished); '
      + 'mode "pixel" waits until a region changes (change) or stops changing (same). '
      + 'Returns as soon as the condition holds, or reports a timeout with the last difference.',
    parameters: objectSchema({
      mode: {
        type: 'string',
        enum: ['element', 'stable', 'pixel'],
        description: 'What to wait for (default stable).',
      },
      window: {
        type: 'integer',
        description: 'Window handle to watch; defaults to the last captured window, else the foreground window.',
      },
      name: {
        type: 'string',
        description: 'For mode element: part of the control name to look for, for example "In Library".',
      },
      state: {
        type: 'string',
        enum: ['appear', 'disappear'],
        description: 'For mode element: wait until it appears (default) or disappears.',
      },
      change: {
        type: 'string',
        enum: ['change', 'same'],
        description: 'For mode pixel: wait until the region changes (default) or stops changing.',
      },
      x: { type: 'integer', description: 'For mode pixel: region left, in screen pixels.' },
      y: { type: 'integer', description: 'For mode pixel: region top, in screen pixels.' },
      width: { type: 'integer', description: 'For mode pixel: region width.' },
      height: { type: 'integer', description: 'For mode pixel: region height.' },
      timeoutMs: { type: 'integer', description: 'Give up after this long, 500 to 120000 (default 15000).' },
      intervalMs: { type: 'integer', description: 'Sampling interval, 100 to 2000 (default 350).' },
      tolerance: { type: 'integer', description: 'Per-channel colour tolerance, 0 to 80 (default 12).' },
      threshold: { type: 'number', description: 'Fraction of samples that must differ, 0.0001 to 1 (default 0.01).' },
    }),
    output: {
      schema: SUMMARY_VALUE_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = args ?? {}
      const mode = ['element', 'stable', 'pixel'].includes(input.mode) ? input.mode : 'stable'
      const timeoutMs = Number.isInteger(input.timeoutMs) ? Math.min(Math.max(input.timeoutMs, 500), 120_000) : 15_000
      let handle = Number.isInteger(input.window) ? input.window : undefined
      if (handle === undefined) {
        const capture = captures.get(exec.agent?.id ?? '')
        if (Number.isInteger(capture?.handle)) handle = capture.handle
      }
      await beginPresence(exec, mode === 'element' ? '正在等界面出现…' : '正在等画面稳定…')

      if (mode === 'element') {
        const needle = String(input.name ?? '').trim().toLowerCase()
        if (needle.length === 0) throw new Error('mode element needs `name` (part of the control name)')
        const wantGone = input.state === 'disappear'
        const deadline = Date.now() + timeoutMs
        let lastCount = -1
        while (Date.now() < deadline) {
          let tree
          try {
            let target = handle
            if (target === undefined) {
              const listed = await host.request('windows')
              target = listed?.windows?.find(entry => entry.active === true)?.handle
            }
            if (!Number.isInteger(target)) throw new Error('no window to watch: pass `window`')
            tree = await host.request('uitree', { handle: target, depth: 8, limit: 120 })
          } catch (error) {
            if (Date.now() >= deadline) throw error
            await new Promise(resolve => setTimeout(resolve, 400))
            continue
          }
          const matches = (tree.elements ?? []).filter(element => String(element.name ?? '').toLowerCase().includes(needle))
          const visible = matches.filter(element => element.offscreen !== true)
          lastCount = visible.length
          const present = visible.length > 0
          if (wantGone ? !present : present) {
            const label = visible[0]?.name ?? input.name
            toolRow(`等到了：${wantGone ? '「' + label + '」已消失' : '「' + label + '」出现了'}`)
            return {
              summary: wantGone
                ? `「${label}」已经消失（用时约 ${Math.round((timeoutMs - (deadline - Date.now())) / 100) / 10} 秒）。`
                : `「${label}」已经出现（用时约 ${Math.round((timeoutMs - (deadline - Date.now())) / 100) / 10} 秒）。`,
            }
          }
          await new Promise(resolve => setTimeout(resolve, Number.isInteger(input.intervalMs) ? Math.min(Math.max(input.intervalMs, 100), 2000) : 400))
        }
        return {
          summary: `等了 ${Math.round(timeoutMs / 1000)} 秒，没有等到名字包含「${input.name}」的控件`
            + (lastCount > 0 ? `（当前有 ${lastCount} 个近似项，可能名字不同）` : '')
            + '。先截一张图看看现在的界面。',
        }
      }

      const payload = { mode: mode === 'pixel' ? (input.change === 'same' ? 'same' : 'change') : 'stable' }
      if (handle !== undefined) payload.handle = handle
      if (mode === 'pixel' && Number.isInteger(input.x) && Number.isInteger(input.y)
        && Number.isInteger(input.width) && Number.isInteger(input.height)) {
        payload.x = input.x
        payload.y = input.y
        payload.width = input.width
        payload.height = input.height
      }
      payload.timeoutMs = timeoutMs
      for (const key of ['intervalMs', 'tolerance', 'threshold']) {
        if (input[key] !== undefined) payload[key] = input[key]
      }
      let result
      try {
        result = await host.request('wait', payload, timeoutMs + 5_000)
      } catch (error) {
        const text = String(error?.message ?? '')
        if (/did not answer|timed out|timeout/u.test(text)) {
          // "The helper did not answer" reads like a crash. It is not: the wait ran
          // out while the screen kept changing, which is a different thing to do.
          throw new Error(
            `等待超时：${Math.round(timeoutMs / 1000)} 秒内画面没有${mode === 'pixel' ? '到指定状态' : '稳定下来'}。`
            + '这不是插件坏了，是新界面一直在变（加载、动画、光标闪烁）。先截图看看它在忙什么，或把 timeoutMs 调大。',
          )
        }
        throw error
      }
      const elapsed = Math.round((result.elapsedMs ?? 0) / 100) / 10
      if (mode === 'pixel') {
        if (result.timedOut === true) {
          return { summary: `等了 ${elapsed} 秒，这块区域没有${payload.mode === 'same' ? '稳定下来' : '发生变化'}（最后差异 ${result.diff}）。` }
        }
        return { summary: `这块区域${payload.mode === 'same' ? '已经稳定' : '发生了变化'}，用时 ${elapsed} 秒（差异 ${result.diff}）。` }
      }
      if (result.timedOut === true) {
        return { summary: `等了 ${elapsed} 秒，画面一直在变（最后差异 ${result.diff}），可能还在加载或动画里。` }
      }
      return { summary: `画面已经稳定，用时 ${elapsed} 秒（差异 ${result.diff}）。可以继续下一步了。` }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: `${TOOL_PREFIX}files`,
    description: 'Work with files and downloads directly instead of clicking through a UI — faster and exact. '
      + 'Actions: "list" (path), "read" (first few KB of a text file), "copy" (path, to, overwrite), "move" (path, to), '
      + '"mkdir" (path), "delete" (path, recursive) and "download" (url, to). '
      + 'Deleting, moving and overwriting always require the user to confirm in the floating card.',
    parameters: objectSchema({
      action: {
        type: 'string',
        enum: ['list', 'read', 'copy', 'move', 'mkdir', 'delete', 'download'],
        description: 'What to do.',
      },
      path: { type: 'string', description: 'Source path (absolute, or relative to the working directory).' },
      to: { type: 'string', description: 'Destination path for copy, move and download.' },
      url: { type: 'string', description: 'URL to download.' },
      overwrite: { type: 'boolean', description: 'Allow replacing an existing destination file.' },
      recursive: { type: 'boolean', description: 'For delete: remove a directory and its contents.' },
    }),
    output: {
      schema: SUMMARY_VALUE_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const input = args ?? {}
      const action = typeof input.action === 'string' ? input.action : 'list'
      const resolvePath = (value) => (typeof value === 'string' && value.length > 0 ? path.resolve(value) : undefined)
      const source = resolvePath(input.path)
      const destination = resolvePath(input.to)
      const risky = action === 'delete' || action === 'move' || (action === 'copy' && input.overwrite === true)
      await beginPresence(exec, `正在处理文件（${action}）…`)
      if (risky) {
        await requireApproval(exec, `${TOOL_PREFIX}files`, '改动或删除磁盘上的文件', {
          title: `DeepSeek 想在你的磁盘上${action === 'delete' ? '删除文件' : action === 'move' ? '移动文件' : '覆盖文件'}`,
          detail: `${source ?? input.path ?? ''}${destination === undefined ? '' : ` → ${destination}`}`,
          label: '文件操作',
          danger: true,
        })
      }

      if (action === 'list') {
        if (source === undefined) throw new Error('action list needs `path`')
        const entries = await readdir(source, { withFileTypes: true })
        const rows = []
        for (const entry of entries.slice(0, 200)) {
          let size = ''
          try {
            if (entry.isFile()) size = ` ${Math.round((await stat(path.join(source, entry.name))).size / 1024)}KB`
          } catch { /* size is decoration */ }
          rows.push(`${entry.isDirectory() ? 'DIR ' : 'FILE'} ${entry.name}${size}`)
        }
        return { summary: `${source} 里有 ${entries.length} 项${entries.length > 200 ? '（只显示前 200）' : ''}：\n${rows.join('\n')}` }
      }
      if (action === 'read') {
        if (source === undefined) throw new Error('action read needs `path`')
        const info = await stat(source)
        if (info.size > 2_000_000) throw new Error(`文件太大（${Math.round(info.size / 1024)}KB），请用别的办法读取`)
        const text = await readFile(source, 'utf8')
        const clipped = text.length > 4000 ? `${text.slice(0, 4000)}\n…（共 ${text.length} 字，只显示前 4000）` : text
        return { summary: `${source}（${Math.round(info.size / 1024)}KB）：\n${clipped}` }
      }
      if (action === 'mkdir') {
        if (source === undefined) throw new Error('action mkdir needs `path`')
        await mkdir(source, { recursive: true })
        return { summary: `已创建目录 ${source}。` }
      }
      if (action === 'delete') {
        if (source === undefined) throw new Error('action delete needs `path`')
        await rm(source, { recursive: input.recursive === true, force: false })
        toolRow(`删除了 ${source}`)
        return { summary: `已删除 ${source}${input.recursive === true ? '（含子目录）' : ''}。` }
      }
      if (action === 'move') {
        if (source === undefined || destination === undefined) throw new Error('action move needs `path` and `to`')
        await rename(source, destination)
        toolRow(`移动 ${source} → ${destination}`)
        return { summary: `已移动：${source} → ${destination}` }
      }
      if (action === 'copy') {
        if (source === undefined || destination === undefined) throw new Error('action copy needs `path` and `to`')
        await cp(source, destination, { recursive: true, force: input.overwrite === true, errorOnExist: input.overwrite !== true })
        toolRow(`复制 ${source} → ${destination}`)
        return { summary: `已复制：${source} → ${destination}` }
      }
      if (action === 'download') {
        const url = typeof input.url === 'string' ? input.url : ''
        if (!/^https?:\/\//u.test(url)) throw new Error('action download needs an http(s) `url`')
        if (destination === undefined) throw new Error('action download needs `to` (destination file path)')
        const response = await fetch(url)
        if (!response.ok) throw new Error(`下载失败：HTTP ${response.status} ${response.statusText}`)
        const buffer = Buffer.from(await response.arrayBuffer())
        await mkdir(path.dirname(destination), { recursive: true })
        await writeFile(destination, buffer)
        toolRow(`下载 ${Math.round(buffer.byteLength / 1024)}KB → ${destination}`)
        return { summary: `已下载 ${Math.round(buffer.byteLength / 1024)}KB 到 ${destination}（HTTP ${response.status}）。` }
      }
      throw new Error(`unknown action ${action}`)
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: `${TOOL_PREFIX}ui`,
    description: 'Act on a UI Automation control by path instead of guessing pixels: "list" returns the control tree, '
      + 'then invoke (buttons), select (menu items, rows), toggle (checkboxes), expand (combo boxes, tree nodes), '
      + 'value (text inputs), focus, or click (pointer-only elements). A path addresses the control itself, so it survives '
      + 'scrolling and moving windows. Use computer_look to read the tree cheaply first; keep computer_click for canvas areas and games.',
    parameters: objectSchema({
      window: {
        type: 'integer',
        description: 'Window handle from computer_windows. Defaults to the window captured last, else the foreground window.',
      },
      action: {
        type: 'string',
        enum: ['list', 'invoke', 'click', 'select', 'toggle', 'expand', 'focus', 'value'],
        description: 'What to do; "list" returns the control tree, everything else acts on one path.',
      },
      path: {
        type: 'string',
        description: 'Element path from a previous list, for example "0/1/0/0/3".',
      },
      snapshot: {
        type: 'string',
        description: 'Optional snapshot id from that list, e.g. "s3". Passing it back makes a stale path fail loudly '
          + 'instead of acting on whatever took its place.',
      },
      value: {
        type: 'string',
        description: 'Text to set when the action is "value".',
      },
      depth: {
        type: 'integer',
        description: 'How deep to walk when listing (default 6).',
      },
      limit: {
        type: 'integer',
        description: 'Maximum elements to walk when listing (default 80).',
      },
    }),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['summary'],
        properties: { summary: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const action = typeof args?.action === 'string' ? args.action : 'list'
      let handle = Number.isInteger(args?.window) ? args.window : undefined
      if (handle === undefined) {
        const capture = captures.get(exec.agent?.id ?? '')
        if (Number.isInteger(capture?.handle)) handle = capture.handle
      }
      if (handle === undefined) {
        const listed = await host.request('windows')
        handle = listed?.windows?.find(entry => entry.active === true)?.handle
      }
      if (!Number.isInteger(handle)) throw new Error('no window to inspect: pass `window` from computer_windows')
      await beginPresence(exec, action === 'list' ? '正在读取界面元素…' : '正在操作控件…')
      if (action === 'list') {
        const depth = Number.isInteger(args?.depth) ? Math.min(Math.max(args.depth, 1), 12) : 6
        const limit = Number.isInteger(args?.limit) ? Math.min(Math.max(args.limit, 1), 400) : 80
        const tree = await host.request('uitree', { handle, depth, limit })
        const snapshot = rememberUiSnapshot(exec, handle, tree)
        const rows = formatControlTree(tree, limit)
        toolRow(`读取了「${tree.elements[0]?.name || handle}」的元素树：${tree.visible} 个可见控件`)
        const header = `窗口「${tree.elements[0]?.name || handle}」共 ${tree.count} 个元素，其中 ${tree.visible} 个可见。`
          + ' 用 path 再次调用本工具执行动作：invoke / select / toggle / expand / focus / value / click。'
          + ` ${snapshotHint(snapshot)}`
        return { summary: rows.length === 0 ? `${header}\n（没有找到可操作的元素，这个窗口可能需要用截图加坐标点击。）` : `${header}\n${rows.join('\n')}` }
      }
      const path = typeof args?.path === 'string' ? args.path.trim() : ''
      if (path.length === 0) throw new Error(`action ${action} needs the element \`path\` from a previous list`)
      const payload = { handle, path, action }
      // Refuse to fire on a path whose control is not the one the model was shown:
      // the host compares this against the live element just before it acts.
      Object.assign(payload, uiExpectation(exec, handle, path, args?.snapshot))
      if (args?.value !== undefined) payload.value = String(args.value)
      const result = await uiAct(payload)
      const label = result.name === '' ? result.type : `${result.type}「${result.name}」`
      toolRow(`对${label}执行了 ${result.acted}`)
      return { summary: `已对${label}执行 ${result.acted}（窗口 ${handle}，路径 ${path}）。` }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: `${TOOL_PREFIX}screenshot`,
    description: 'Capture the desktop — or one window with `window` — and return the image, its size, the pointer, and the active window. '
      + 'An unchanged screen comes back as one line of text with no image, which still leaves your coordinates valid. '
      + 'Prefer computer_look when you only need to find controls.',
    parameters: objectSchema({
      monitor: {
        type: 'integer',
        description: 'Which monitor to capture, counting from 1 (default 1).',
      },
      window: {
        type: 'integer',
        description: 'Optional window handle from computer_windows. Captures just that window; coordinates then refer to the window instead of the screen.',
      },
    }),
    output: {
      schema: SCREENSHOT_VALUE_SCHEMA,
      render: renderCapture,
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      await beginPresence(exec, '正在截屏…')
      const result = await captureOnce(exec, {
        window: Number.isInteger(args?.window) ? args.window : undefined,
        monitor: Number.isInteger(args?.monitor) ? args.monitor : undefined,
      })
      return result.image === undefined
        ? { summary: result.summary }
        : { summary: result.summary, image: result.image }
    },
  }))
  /**
   * Read text off one window or one screen rectangle with the OS OCR engine. The
   * work image is written at native resolution and removed again: the engine is
   * the one consumer that must never be handed a downscaled picture.
   */
  async function readScreenText(target) {
    const directory = await captureDirectory()
    const file = path.join(directory, `ocr-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
    try {
      return await host.request('ocr', { ...target, outPath: file })
    } finally {
      await rm(file, { force: true })
    }
  }

  // ── 「命中」探测：这个屏幕点上真正压着什么控件 ─────────────────────────
  //
  // 工具过去只说「打到了哪个像素」，模型没法判断自己点中的是拖拽热区、浮层
  // 还是别的窗口，于是一遍遍重试。UI Automation 的 ElementFromPoint 能直接
  // 回答这个问题，但必须在动作**之后**问（点开的菜单、弹出的浮层之后才存在）。
  // 它只是一条附加信息：超时、异常、辅助进程没起来都不许影响已经完成的点击，
  // 所以这里的错误全部吞掉，由调用方写成「取不到」。
  /** 一次命中探测的预算：读不到就是读不到，不能拖慢点击本身。 */
  const HIT_TIMEOUT_MS = 1_500
  /** anchor 一次最多探测多少行候选：一个请求问完，问不到就退回 OCR 原顺序。 */
  const HIT_CANDIDATE_LIMIT = 24
  /** 命中这些 ControlType 就算「控件」：anchor 的候选里它们排在纯文本前面。 */
  const CONTROL_HIT_TYPES = new Set([
    'Button', 'MenuItem', 'Hyperlink', 'CheckBox', 'RadioButton', 'TabItem', 'ComboBox', 'Edit',
  ])
  /**
   * 纯文本与容器类。Chromium 类应用里一段普通文字常常报成 Group/Pane，
   * 所以在排序里它们和 Text/Document 一样算「文本」，同样排在控件之后。
   */
  const TEXT_HIT_TYPES = new Set(['Text', 'Document', 'Pane', 'Group', 'Custom'])

  /** 问一个屏幕点命中什么；取不到返回 undefined。 */
  async function probeHit(screenX, screenY) {
    try {
      return await host.request('hit', { x: screenX, y: screenY }, HIT_TIMEOUT_MS)
    } catch {
      return undefined
    }
  }

  /** 一次问多个屏幕点（anchor 的候选行），逐点返回命中或 undefined。 */
  async function probeHits(points) {
    const blank = points.map(() => undefined)
    if (points.length === 0) return blank
    try {
      const result = await host.request('hit', { points }, HIT_TIMEOUT_MS + points.length * 200)
      const hits = Array.isArray(result?.hits) ? result.hits : []
      return points.map((_point, index) => (hits[index]?.ok === true ? hits[index] : undefined))
    } catch {
      return blank
    }
  }

  /**
   * 「命中」那一行：类型加名字，名字为空就写无标题，取不到就写取不到。
   * 只报这两项，是因为模型要判断的是「点到的是不是我以为的那个东西」。
   */
  function hitLine(hit, label = '命中') {
    const type = typeof hit?.controlType === 'string' ? hit.controlType : ''
    if (type.length === 0) return `${label}：取不到`
    const name = typeof hit?.name === 'string' ? hit.name.trim() : ''
    const window = typeof hit?.window === 'string' && hit.window.trim().length > 0 ? ` in 「${hit.window.trim()}」` : ''
    return `${label}：${type}「${name.length > 0 ? name : '<无标题>'}」${window}`
  }

  /** Render OCR lines as the text block both computer_ocr and computer_look print. */
  function formatOcrReport(result, target) {
    const lines = Array.isArray(result.lines) ? result.lines : []
    if (lines.length === 0) return undefined
    const shown = lines.slice(0, settings.ocrMaxLines)
    const rows = shown.map((line) => `「${line.text}」  @${line.x},${line.y} ${line.width}×${line.height}`)
    const more = lines.length > shown.length ? `… 还有 ${lines.length - shown.length} 行没列出来，缩小区域再识别。` : ''
    return {
      count: lines.length,
      summary: [
        `OCR（${result.language}）在${target}里认出 ${lines.length} 行文字${ocrScaleNote(result)}。坐标是**物理屏幕像素**——`
          + '点击时传 space:"screen"。需要看排版就用 computer_zoom 放大那个位置。',
        ...rows,
        more,
      ].filter(text => text.length > 0).join('\n'),
    }
  }

  /**
   * 放大识别那一句说明：成功就报实际倍率，失败就明说退回了原尺寸。
   * 没有放大（scale 1）时什么都不加，免得每次 OCR 都多一句废话。
   */
  function ocrScaleNote(result) {
    if (result?.scaleFailed === true) return '（放大失败，按原尺寸识别）'
    const scale = Number.isInteger(result?.scale) ? result.scale : 1
    return scale > 1 ? `（放大 ×${scale} 后识别，坐标已除回原比例）` : ''
  }

  /** How a capture target is named in an OCR report. */
  function ocrTargetName(result) {
    return result.kind === 'window'
      ? `窗口「${result.title || result.handle}」[${result.handle}]`
      : `屏幕 ${result.x},${result.y} ${result.width}×${result.height}`
  }

  /**
   * Which window a zoom or an OCR read applies to.
   *
   * `window: 0` is the explicit "the screen, not a window" form. Without it there
   * is no way to ask for the screen once a window has been captured, because the
   * default follows the last capture — and that is the case where the two would
   * silently disagree about what the numbers mean.
   */
  function zoomTarget(args, exec) {
    if (args?.window === 0) return {}
    if (Number.isInteger(args?.window) && args.window > 0) return { handle: args.window }
    const capture = captures.get(exec.agent?.id ?? '')
    return capture?.kind === 'window' && Number.isInteger(capture.handle) ? { handle: capture.handle } : {}
  }

  /**
   * 给 anchor 的候选行排序，并记住每一行命中的是什么。
   *
   * 「同一段字」可能既是按钮标签，又是正文里的同一句话：OCR 只认文字不认角色，
   * 所以正文也会被算进候选，模型很容易点到聊天内容。这里用与点击回报同一个
   * hit 探测每行文字位置上的 UIA 元素，把控件排在纯文本前面——match:<index>
   * 的编号因此与「最可能是按钮的那一行」一致。
   *
   * 探测失败（超时、没有 UIA）时保持 OCR 的原顺序，绝不因此报错。
   */
  async function rankAnchorCandidates(hits) {
    const probePoints = hits.slice(0, HIT_CANDIDATE_LIMIT).map((line) => ({
      x: Math.round(line.x),
      y: Math.round(line.y + line.height / 2),
    }))
    const probes = await probeHits(probePoints)
    // 没探到的行（探测失败，或超出上限）按文本对待：它们不该因为「不知道」
    // 就插到已确认是控件的行前面；同一档里保持 OCR 的原顺序。
    const rankOf = (hit) => {
      const type = typeof hit?.controlType === 'string' ? hit.controlType : ''
      if (CONTROL_HIT_TYPES.has(type)) return 0
      if (type.length === 0 || TEXT_HIT_TYPES.has(type)) return 2
      return 1
    }
    return hits.map((line, index) => ({
      line,
      hit: index < probes.length ? probes[index] : undefined,
      order: index,
    })).sort((left, right) => rankOf(left.hit) - rankOf(right.hit) || left.order - right.order)
  }

  /** 候选行的一行说明：标明它是控件还是文本，决定 match:<index> 怎么数。 */
  function describeAnchorCandidate(row, index) {
    const text = String(row.line.text ?? '')
    const at = `@${row.line.x},${Math.round(row.line.y + row.line.height / 2)}`
    const type = typeof row.hit?.controlType === 'string' ? row.hit.controlType : ''
    if (type.length === 0) return `[${index}] 未取到「${text}」 ${at}`
    const hitName = typeof row.hit.name === 'string' ? row.hit.name.trim() : ''
    const name = hitName.length > 0 ? hitName : text
    const kind = CONTROL_HIT_TYPES.has(type) ? '控件' : TEXT_HIT_TYPES.has(type) ? '文本' : '其他'
    return `[${index}] ${kind} ${type}「${name}」 ${at}`
  }

  /**
   * Turn "click the row that says X" into a screen point.
   *
   * A screen full of identical switches cannot be told apart by pixel
   * coordinates: one row's toggle looks exactly like the next row's, so a click
   * read off a small crop is a coin flip between two plugins. The text on the
   * row is the only thing that identifies it, so the anchor is resolved through
   * OCR, and an ambiguous anchor is refused loudly instead of silently taking
   * the first match.
   */
  async function resolveAnchorPoint(args, exec) {
    const anchor = String(args.anchor).trim()
    const target = zoomTarget(args, exec)
    const result = await readScreenText({
      ...target.handle === undefined ? { monitor: settings.defaultMonitor } : { handle: target.handle },
    })
    const lines = Array.isArray(result.lines) ? result.lines : []
    const needle = anchor.toLowerCase()
    const hits = lines.filter((line) => String(line.text ?? '').toLowerCase().includes(needle))
    const where = ocrTargetName(result)
    if (hits.length === 0) {
      const sample = lines.slice(0, 5).map((line) => `「${line.text}」`).join(' ')
      throw new Error(`anchor 「${anchor}」 is not in ${where}; nothing was clicked.`
        + (sample.length > 0
          ? ` Lines it does show: ${sample}`
          : ' That target has no readable text — use computer_look, or a screenshot plus a coordinate.'))
    }
    // 控件优先：正文里有同一句话时，按钮必须排在前面，否则 match 数到的第一行
    // 往往是聊天内容。探测拿不到就保持 OCR 原顺序。
    const rows = await rankAnchorCandidates(hits)
    const wanted = Number.isInteger(args.match) ? args.match : undefined
    if (wanted === undefined && rows.length > 1) {
      const listed = rows.slice(0, 8).map((row, index) => describeAnchorCandidate(row, index)).join('\n')
      throw new Error(`anchor 「${anchor}」 matches ${rows.length} rows in ${where}; refusing to guess which one — `
        + 'that is exactly how the wrong switch gets clicked. Pass match:<index>, or a longer anchor. '
        + `候选按「控件在前、文本在后」排列，[i] 就是 match 的编号：\n${listed}`)
    }
    const chosen = rows[wanted ?? 0]
    if (chosen === undefined) throw new Error(`match=${wanted} is out of range: ${rows.length} row(s) match 「${anchor}」.`)
    const pick = chosen.line
    const dx = Number.isInteger(args.dx) ? args.dx : 0
    const dy = Number.isInteger(args.dy) ? args.dy : 0
    // Centre of the text line, not its left edge: the left edge was a systematic
    // half-line bias, and on a wide row the first character can sit far from the
    // thing that actually reacts to a click.
    return {
      screenX: Math.round(pick.x + pick.width / 2 + dx),
      screenY: Math.round(pick.y + pick.height / 2 + dy),
      label: String(pick.text),
      where,
      match: wanted ?? 0,
      total: rows.length,
      rect: {
        x: Math.round(pick.x),
        y: Math.round(pick.y),
        width: Math.round(pick.width),
        height: Math.round(pick.height),
      },
    }
  }

  /**
   * The panel to slip aside for one action, or undefined when that action is
   * aimed at the panel itself.
   *
   * Sliding the docked window behind everything is what lets a click reach an
   * application it covers. But when the last capture WAS that window, the panel
   * is the target, not an obstruction: slipping it sends the click to whatever
   * is underneath, and the result is indistinguishable from "the click did
   * nothing at all" — the failure that made a page full of switches so easy to
   * mis-handle.
   */
  function panelToAvoid(exec) {
    const panel = panelHandle()
    if (panel === undefined) return undefined
    const capture = captures.get(exec.agent?.id ?? '')
    return capture?.handle === panel ? undefined : panel
  }

  // ── 让「点一个目标」成为可能：吸附、目标解析、落点核对 ─────────────────────
  // 坐标换算本身是准的（≤1 px），真正不准的是「模型从缩小的图里估中心」。
  // 这一组函数把这件事从估挪到算：先找控件、再用控件矩形中心。

  /** Control types a snap may pull a point onto. */
  const SNAP_HIT_TYPES = new Set([
    ...CONTROL_HIT_TYPES, 'TabItem', 'TreeItem', 'ListItem', 'SplitButton', 'Slider',
  ])
  /**
   * Only these get the one automatic retry. Clicking a button twice is harmless;
   * a menu item that already opened a dialog, or a link that navigated, is not.
   */
  const IDEMPOTENT_HIT_TYPES = new Set([
    'Button', 'CheckBox', 'RadioButton', 'TabItem', 'MenuItem', 'Hyperlink',
    'TreeItem', 'ListItem', 'SplitButton',
  ])
  /** A snap candidate must look like a control, not like a whole panel or list. */
  const SNAP_MAX_WIDTH = 360
  const SNAP_MAX_HEIGHT = 96
  /** One JSON line per click, so accuracy can be counted instead of argued about. */
  const CLICK_LOG_PATH = path.join(tmpdir(), 'dsh-click-log.jsonl')

  /** The rectangle a hit reported, or undefined when it could not measure one. */
  function hitRect(hit) {
    const rect = hit?.rect
    if (rect === undefined || rect === null) return undefined
    const values = [rect.x, rect.y, rect.width, rect.height]
    if (!values.every(value => Number.isInteger(value))) return undefined
    if (rect.width <= 0 || rect.height <= 0) return undefined
    return rect
  }

  /** Centre of a rectangle, in whole screen pixels. */
  function rectCentre(rect) {
    return {
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2),
    }
  }

  /** Whether a point falls inside a rectangle, optionally padded. */
  function pointInRect(x, y, rect, pad = 0) {
    if (rect === undefined) return false
    return x >= rect.x - pad && x <= rect.x + rect.width + pad
      && y >= rect.y - pad && y <= rect.y + rect.height + pad
  }

  /** 「Button「保存」」——用于结果里说明吸附到/命中了什么。 */
  function hitLabel(hit) {
    const type = typeof hit?.controlType === 'string' && hit.controlType.length > 0 ? hit.controlType : '元素'
    const name = typeof hit?.name === 'string' ? hit.name.trim() : ''
    return `${type}「${name.length > 0 ? name : '<无标题>'}」`
  }

  /**
   * `target` accepts a bare string (treated as text) or `{text, role, path, window}`.
   * A string is the common case: "click the 保存 button" without guessing a pixel.
   */
  function readTargetSpec(value) {
    if (typeof value === 'string') {
      const text = value.trim()
      return text.length > 0 ? { text } : undefined
    }
    if (value === undefined || value === null || typeof value !== 'object') return undefined
    const spec = {}
    for (const key of ['text', 'role', 'path']) {
      if (typeof value[key] === 'string' && value[key].trim().length > 0) spec[key] = value[key].trim()
    }
    if (Number.isInteger(value.window)) spec.window = value.window
    return Object.keys(spec).length > 0 ? spec : undefined
  }

  /**
   * Resolve a named target to a rectangle, through the window's control tree.
   * Multiple matches are refused with the list: picking the first one is exactly
   * how the wrong button gets pressed.
   */
  async function resolveTarget(spec, exec) {
    const capture = captures.get(exec.agent?.id ?? '')
    let handle = Number.isInteger(spec.window) ? spec.window : undefined
    if (handle === undefined && capture?.kind === 'window' && Number.isInteger(capture.handle)) {
      handle = capture.handle
    }
    if (handle === undefined) {
      const listing = await host.request('windows', {})
      const active = (listing?.windows ?? []).find(window => window.active === true)
      handle = active?.handle
    }
    if (!Number.isInteger(handle) || handle <= 0) {
      throw new Error('target 需要知道在哪个窗口里找：先截一张目标窗口的图，或给 target.window 一个句柄。')
    }
    const tree = await host.request('uitree', { handle, depth: 12, limit: 800 }, 8_000)
    const elements = Array.isArray(tree?.elements) ? tree.elements : []
    const wantText = typeof spec.text === 'string' ? spec.text.toLowerCase() : ''
    const wantRole = typeof spec.role === 'string' ? spec.role : ''
    const wantPath = typeof spec.path === 'string' ? spec.path : ''
    const rows = elements.filter((element) => {
      if (element.offscreen === true || element.width <= 0 || element.height <= 0) return false
      if (wantPath.length > 0 && element.path !== wantPath) return false
      if (wantRole.length > 0 && element.type !== wantRole) return false
      if (wantText.length > 0 && !String(element.name ?? '').toLowerCase().includes(wantText)) return false
      return true
    })
    const describeElement = (element) => `[${element.path}] ${element.type}「${element.name}」@${element.x},${element.y} ${element.width}×${element.height}`
    if (rows.length === 0) {
      const sample = elements.slice(0, 6).map(element => `${element.type}「${element.name}」`).join(' ')
      throw new Error(`target 「${spec.text ?? spec.path ?? spec.role}」在窗口 ${handle} 里找不到${sample.length > 0 ? `；它现有：${sample}` : ''}。`
        + '可以先用 computer_look 看控件名，或改用坐标点。')
    }
    // A button and its own caption both match "保存" — the caption is inside the
    // button, so the button is the thing to click. Prefer interactive containers
    // before refusing; only a real tie (two separate buttons) is ambiguous.
    const interactive = rows.filter((element) => CONTROL_HIT_TYPES.has(element.type) || IDEMPOTENT_HIT_TYPES.has(element.type))
    const pool = interactive.length > 0 ? interactive : rows
    if (pool.length > 1) {
      throw new Error(`target 命中 ${pool.length} 个元素，拒绝猜：\n${pool.slice(0, 8).map(describeElement).join('\n')}\n`
        + '把 role 或更完整的 text 说清楚，或直接给 path。')
    }
    const one = pool[0]
    return {
      rect: { x: one.x, y: one.y, width: one.width, height: one.height },
      type: one.type,
      name: one.name,
      path: one.path,
      handle,
    }
  }

  /**
   * Pull a point onto the centre of a nearby control.
   *
   * Two passes: what is under the point itself (the common case — the model
   * clicked near a button's edge), then a ring of probes at the snap radius
   * (the point landed just outside the button). Only a single candidate may win;
   * several candidates mean the plugin does not know, and it says so by not
   * moving the point.
   */
  async function snapPoint(x, y) {
    const radius = settings.snapRadius
    const direct = await probeHit(x, y)
    const directRect = hitRect(direct)
    if (directRect !== undefined && SNAP_HIT_TYPES.has(direct?.controlType ?? '')
      && directRect.width <= SNAP_MAX_WIDTH && directRect.height <= SNAP_MAX_HEIGHT
      && pointInRect(x, y, directRect)) {
      const centre = rectCentre(directRect)
      if (centre.x !== x || centre.y !== y) {
        return { x: centre.x, y: centre.y, rect: directRect, label: hitLabel(direct) }
      }
    }
    // The point already sits on a real element (a button's text label, an icon, a
    // cell): pulling it to a *neighbouring* control would move the click off the
    // thing the caller aimed at. ClickLab caught exactly that — aiming at the
    // centre of button 6 and landing on button 5 because 6's text child is not a
    // snap type and the ring probe found 5 first.
    if (directRect !== undefined && pointInRect(x, y, directRect)
      && !['Window', 'Pane', 'Document', 'Group', 'Custom'].includes(String(direct?.controlType ?? ''))) {
      return undefined
    }
    const offsets = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]
    const hits = await probeHits(offsets.map(([dx, dy]) => ({ x: x + dx * radius, y: y + dy * radius })))
    const candidates = []
    for (const hit of hits) {
      const rect = hitRect(hit)
      if (rect === undefined || !SNAP_HIT_TYPES.has(hit?.controlType ?? '')) continue
      if (rect.width > SNAP_MAX_WIDTH || rect.height > SNAP_MAX_HEIGHT) continue
      const key = `${rect.x},${rect.y},${rect.width},${rect.height}`
      if (!candidates.some(candidate => candidate.key === key)) candidates.push({ key, rect, hit })
    }
    if (candidates.length !== 1) return undefined
    const chosen = candidates[0]
    if (!pointInRect(x, y, chosen.rect, radius)) return undefined
    const centre = rectCentre(chosen.rect)
    if (centre.x === x && centre.y === y) return undefined
    return { x: centre.x, y: centre.y, rect: chosen.rect, label: hitLabel(chosen.hit) }
  }

  /** A small picture signature around a point, for "did the click change anything". */
  async function sampleSignature(x, y) {
    const size = 120
    const region = { x: Math.max(0, x - size / 2), y: Math.max(0, y - size / 2), width: size, height: size }
    try {
      const result = await host.request('signature', region, 3_000)
      return Array.isArray(result?.samples) ? result.samples : undefined
    } catch {
      return undefined
    }
  }

  /** Whether two signatures differ anywhere that matters (per channel, 12 levels). */
  function signatureChanged(before, after) {
    if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) return undefined
    let changed = 0
    for (let index = 0; index + 2 < before.length; index += 3) {
      const delta = Math.max(
        Math.abs(before[index] - after[index]),
        Math.abs(before[index + 1] - after[index + 1]),
        Math.abs(before[index + 2] - after[index + 2]),
      )
      if (delta > 12) changed += 1
    }
    return changed > 0
  }

  /** Append one click record; never let logging break the click itself. */
  function logClick(record) {
    try {
      appendFileSync(CLICK_LOG_PATH, `${JSON.stringify(record)}\n`, 'utf8')
    } catch { /* diagnostics only */ }
  }

  ctx.effect(() => ctx.tools.register({
    name: `${TOOL_PREFIX}zoom`,
    description: 'Look closely at one part of the screen or of a window: the region is cropped and returned at native '
      + 'resolution, so small text, an icon, a toolbar, or a status bar becomes readable and a tight click becomes possible. '
      + 'Use it instead of another full screenshot when the full picture is too coarse. x,y,width,height are read in the last '
      + 'screenshot image, exactly like computer_click, and the zoomed image becomes the new coordinate space.',
    parameters: objectSchema({
      x: { type: 'integer', description: 'Left edge of the region, in the last screenshot image.' },
      y: { type: 'integer', description: 'Top edge of the region, in the last screenshot image.' },
      width: { type: 'integer', description: 'Region width in image pixels; 40 is enough for one word, 400 for a dialog.' },
      height: { type: 'integer', description: 'Region height in image pixels.' },
      window: {
        type: 'integer',
        description: 'Window handle to zoom inside, when the last capture was the whole screen. Defaults to the last captured window, else the screen; 0 forces the screen.',
      },
      space: {
        type: 'string',
        enum: ['image', 'screen'],
        description: 'Which space the rectangle is in: "image" (default) from the last screenshot, '
          + '"screen" for physical screen pixels picked from an OCR line.',
      },
    }, ['x', 'y', 'width', 'height']),
    output: {
      schema: SCREENSHOT_VALUE_SCHEMA,
      render: renderCapture,
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const space = args?.space === 'screen' ? 'screen' : 'image'
      const x = integerArg(args, 'x')
      const y = integerArg(args, 'y')
      const width = integerArg(args, 'width')
      const height = integerArg(args, 'height')
      if (width < 8 || height < 8) throw new Error('the region must be at least 8x8 px; a zoom of nothing is a crop of nothing')
      await beginPresence(exec, '正在放大局部…')
      // Keep the target the same as the coordinates came from: a rectangle read
      // off a window's picture must be cropped out of that window, not out of
      // whatever happens to be on top of it now.
      const target = zoomTarget(args, exec)
      const limited = { width: Math.min(width, settings.zoomMaxSide), height: Math.min(height, settings.zoomMaxSide) }
      const from = toScreen(exec, x, y, space, { clamp: true })
      const to = toScreen(exec, x + limited.width - 1, y + limited.height - 1, space, { clamp: true })
      const region = {
        x: from.screenX,
        y: from.screenY,
        width: Math.max(to.screenX - from.screenX + 1, 8),
        height: Math.max(to.screenY - from.screenY + 1, 8),
      }
      const result = await captureOnce(exec, {
        ...target.handle === undefined ? { monitor: settings.defaultMonitor } : { window: target.handle },
        region,
      })
      // A zoom is the one place where an out-of-picture rectangle is clamped: the
      // result states the region it really cropped, so the caller can see it.
      const cropped = from.clamped || to.clamped ? '（要求的矩形超出了这张图，已裁到边缘）' : ''
      const summary = `${result.summary}${cropped ? `\n${cropped}` : ''}`
      return result.image === undefined
        ? { summary }
        : { summary, image: result.image }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: `${TOOL_PREFIX}ocr`,
    description: 'Read the text on screen with the operating system OCR engine and get each line back with its position — '
      + 'far cheaper than a screenshot when an application has no usable control tree (a canvas, a game, a GPU-rendered '
      + 'editor). Lines are reported in physical screen pixels, so pass them to computer_click with space:"screen". '
      + 'When small toolbar text comes back wrong, pass scale 2 or 3: the region is enlarged before recognition and the '
      + 'boxes are divided back, so the coordinates are still physical screen pixels. '
      + 'Use computer_look first: a control tree is always better than OCR when one exists.',
    parameters: objectSchema({
      window: {
        type: 'integer',
        description: 'Window to read; defaults to the last captured window, else the screen under the default monitor. 0 forces the screen.',
      },
      x: { type: 'integer', description: 'Optional left edge of a region to read, in physical screen pixels.' },
      y: { type: 'integer', description: 'Optional top edge of the region.' },
      width: { type: 'integer', description: 'Optional region width.' },
      height: { type: 'integer', description: 'Optional region height.' },
      lang: {
        type: 'string',
        description: 'OCR language tag such as "en-US" or "zh-Hans-CN"; default follows the system profile languages.',
      },
      scale: {
        type: 'integer',
        description: 'In 1–3 (default 1): enlarge the region before recognizing it, for small toolbar text. The reported '
          + 'coordinates are divided back, so they are still physical screen pixels.',
      },
    }),
    output: {
      schema: SUMMARY_VALUE_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      await beginPresence(exec, '正在识别屏幕文字…')
      // 放大倍率只收 1–3：注册表不校验原始 schema，所以这里自己把关。
      const scale = args?.scale === undefined ? 1 : integerArg(args, 'scale')
      if (scale < 1 || scale > 3) throw new Error(`"scale" 只能是 1–3 的整数，收到 ${scale}`)
      const target = zoomTarget(args, exec)
      const payload = {
        ...target.handle === undefined ? { monitor: settings.defaultMonitor } : { handle: target.handle },
        ...typeof args?.lang === 'string' && args.lang.trim().length > 0 ? { lang: args.lang.trim() } : {},
        ...scale > 1 ? { scale } : {},
      }
      const regionGiven = [args?.x, args?.y, args?.width, args?.height].every(value => Number.isInteger(value))
      if (regionGiven) {
        payload.x = args.x
        payload.y = args.y
        payload.width = Math.min(Math.max(args.width, 8), settings.zoomMaxSide)
        payload.height = Math.min(Math.max(args.height, 8), settings.zoomMaxSide)
      }
      const result = await readScreenText(payload)
      const report = formatOcrReport(result, ocrTargetName(result))
      if (report === undefined) {
        return {
          summary: `OCR（${result.language}）在${ocrTargetName(result)}里没认出任何文字${ocrScaleNote(result)}。这个界面可能没有可读的文字——改用 computer_screenshot 或 computer_zoom 看图。`,
        }
      }
      toolRow(`识别到 ${report.count} 行文字`)
      return { summary: report.summary }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: `${TOOL_PREFIX}windows`,
    description: 'List the visible top-level windows on this computer with their handle, title, process, and screen bounds. '
      + 'Use a handle with computer_focus_window before interacting with a window.',
    parameters: objectSchema({}),
    output: {
      schema: SUMMARY_VALUE_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      const result = await host.request('windows', {})
      const windows = Array.isArray(result.windows) ? result.windows : []
      const lines = windows.slice(0, WINDOW_LIST_LIMIT).map((window) => {
        const process = typeof window.process === 'string' && window.process.length > 0 ? window.process : 'unknown'
        return `[${window.handle}] "${window.title}" — ${process} (${window.x},${window.y} ${window.width}x${window.height})${window.active ? ' active' : ''}`
      })
      const header = `${windows.length} visible window${windows.length === 1 ? '' : 's'}`
      const truncated = windows.length > WINDOW_LIST_LIMIT ? `\n... ${windows.length - WINDOW_LIST_LIMIT} more omitted` : ''
      return { summary: lines.length === 0 ? `${header}.` : `${header}:\n${lines.join('\n')}${truncated}` }
    },
  }))

  ctx.effect(() => ctx.tools.register(actionTool({
    name: `${TOOL_PREFIX}focus_window`,
    description: 'Bring one window to the foreground so it receives pointer and keyboard input. Pass a handle from computer_windows.',
    parameters: objectSchema({
      handle: { type: 'integer', description: 'Window handle reported by computer_windows.' },
    }, ['handle']),
    what: 'focus a window',
    whatZh: '把窗口切到前台',
    describe: (args) => `把窗口 ${args.handle} 切换到前台。`,
    async perform(args) {
      const handle = integerArg(args, 'handle')
      const result = await host.request('focus', { handle })
      if (result.focused === true) {
        return `Focused window ${handle}${result.title ? ` "${result.title}"` : ''}.`
      }
      return `Windows did not hand focus to ${handle}; the foreground window is now ${result.foreground}`
        + `${result.title ? ` "${result.title}"` : ''}. Take a screenshot before acting.`
    },
  })))

  ctx.effect(() => ctx.tools.register(actionTool({
    name: `${TOOL_PREFIX}click`,
    description: 'Click at a coordinate in the last screenshot, on a row identified by its text (anchor), or on a control '
      + 'identified by its name (target). Prefer target/anchor for anything small or repeated: a coordinate is an estimate '
      + 'read off a downscaled picture, while target resolves the control rectangle and clicks its exact centre. '
      + 'A coordinate is snapped to the nearest control centre when that is unambiguous. After the click the result '
      + 'reports the real cursor position, what is under it, and whether the target was actually hit. '
      + 'button "move" only moves the pointer without pressing.',
    parameters: objectSchema({
      x: { type: 'integer', description: 'Horizontal position in the last screenshot image. Omit when using anchor or target.' },
      y: { type: 'integer', description: 'Vertical position in the last screenshot image. Omit when using anchor or target.' },
      anchor: {
        type: 'string',
        description: 'Text on the target row; the click lands on the centre of that text, shifted by dx/dy. Use instead of '
          + 'x,y when identical controls repeat down the screen, so the choice is made by the row label and not by a guessed pixel.',
      },
      target: {
        type: 'object',
        additionalProperties: false,
        description: 'Find a control by name in the window\'s control tree and click its exact centre. More accurate than a '
          + 'coordinate for buttons, checkboxes and icons. Give text (or path), optionally role.',
        properties: {
          text: { type: 'string', description: 'Part of the control name, case-insensitive. Several matches are refused with the list.' },
          role: { type: 'string', description: 'ControlType, e.g. Button, CheckBox, MenuItem, TabItem.' },
          path: { type: 'string', description: 'Exact control path from computer_look / computer_ui list.' },
          window: { type: 'integer', description: 'Window handle to search; defaults to the last captured window, else the foreground window.' },
        },
      },
      dx: {
        type: 'integer',
        description: 'With anchor: horizontal offset from the text\'s centre (default 0). Positive reaches a control '
          + 'sitting to the right of its label, such as a row\'s switch.',
      },
      dy: { type: 'integer', description: 'With anchor: vertical offset from the text\'s vertical centre (default 0).' },
      match: {
        type: 'integer',
        description: 'With anchor: which match to use when more than one row contains the text, counted from the top, 0-based.',
      },
      window: {
        type: 'integer',
        description: 'With anchor: the window whose text is searched. Defaults to the last captured window, else the screen; 0 forces the screen.',
      },
      button: {
        type: 'string',
        enum: ['left', 'right', 'middle', 'move'],
        description: 'Mouse button to press (default left); "move" only moves the pointer.',
      },
      clicks: {
        type: 'integer',
        description: 'How many times to press: 1 (default), 2 for a double-click, 3 for a triple-click.',
      },
      space: {
        type: 'string',
        enum: ['image', 'screen'],
        description: 'Which space x,y are in: "image" (default) reads them off the last screenshot; '
          + '"screen" means physical screen pixels, as reported by computer_ocr or computer_look. Ignored with anchor or target.',
      },
      allow_stale: {
        type: 'boolean',
        description: 'Accept a screenshot older than the coordinate time limit. Only for a target that provably did not '
          + 'move; otherwise take a fresh screenshot.',
      },
    }),
    what: 'click the mouse',
    whatZh: '点击鼠标',
    describe: (args) => {
      const where = typeof args.anchor === 'string' && args.anchor.trim().length > 0
        ? `「${args.anchor}」这一行`
        : args.target !== undefined
          ? `控件「${typeof args.target === 'string' ? args.target : (args.target?.text ?? args.target?.path ?? '?')}」`
          : ` (${args.x}, ${args.y})`
      return `${args.button === 'move' ? '移动指针到' : '点击'}${where}。`
    },
    async perform(args, exec) {
      const anchored = typeof args?.anchor === 'string' && args.anchor.trim().length > 0
      const targetSpec = readTargetSpec(args?.target)
      if (anchored && targetSpec !== undefined) {
        throw new Error('anchor 和 target 只能给一个：anchor 按 OCR 文字找行，target 按控件树找元素，两套定位不要混用。')
      }
      const button = ['left', 'right', 'middle'].includes(args.button) ? args.button : 'left'
      const clicks = Number.isInteger(args.clicks) ? Math.min(Math.max(args.clicks, 1), 3) : 1
      let mapped
      /** Where the caller aimed, before any snap moved the point. */
      let aimed
      let where
      let expected
      let expectedLabel = ''
      let snappedNote = ''
      let input = {}
      if (targetSpec !== undefined) {
        const found = await resolveTarget(targetSpec, exec)
        expected = found.rect
        expectedLabel = `${found.type}「${found.name}」`
        const centre = rectCentre(found.rect)
        mapped = { screenX: centre.x, screenY: centre.y, mapped: true, ageMs: 0 }
        aimed = { x: centre.x, y: centre.y }
        where = `target ${expectedLabel} = screen (${centre.x}, ${centre.y})`
        input = { target: targetSpec }
      } else if (anchored) {
        const point = await resolveAnchorPoint(args, exec)
        expected = point.rect
        const centre = rectCentre(point.rect)
        mapped = { screenX: centre.x, screenY: centre.y, mapped: true, ageMs: 0 }
        aimed = { x: centre.x, y: centre.y }
        where = `「${point.label}」${point.total > 1 ? ` (match ${point.match + 1}/${point.total})` : ''} = screen (${centre.x}, ${centre.y})`
        input = { anchor: args.anchor, match: args.match }
      } else {
        const x = integerArg(args, 'x')
        const y = integerArg(args, 'y')
        const space = args.space === 'screen' ? 'screen' : 'image'
        mapped = toScreen(exec, x, y, space, { strictAge: true, allowStale: args.allow_stale === true })
        aimed = { x: mapped.screenX, y: mapped.screenY }
        where = describePoint(space, x, y, mapped)
        input = { space, x, y }
        // A point read off a picture is an estimate; a control's centre is not.
        // Snapping is skipped for "move": that call is meant to preview a point.
        if (settings.clickSnap && args.button !== 'move') {
          const snap = await snapPoint(mapped.screenX, mapped.screenY)
          if (snap !== undefined) {
            const offsetX = snap.x - mapped.screenX
            const offsetY = snap.y - mapped.screenY
            mapped = { ...mapped, screenX: snap.x, screenY: snap.y }
            expected = snap.rect
            expectedLabel = snap.label
            snappedNote = `\n吸附到 ${snap.label} 中心（${offsetX >= 0 ? '+' : ''}${offsetX}, ${offsetY >= 0 ? '+' : ''}${offsetY}）。`
          }
        }
      }
      if (args.button === 'move') {
        await host.request('click', { x: mapped.screenX, y: mapped.screenY, button: 'move' })
        // 只看不动也是「在这一点上要知道压着什么」的场合：给了这一行，
        // 模型才敢用 move 预演后再真点。
        const movedHit = await probeHit(mapped.screenX, mapped.screenY)
        return `Moved the pointer to ${where}.\n${hitLine(movedHit)}`
      }
      await previewPoint(mapped.screenX, mapped.screenY)
      const panel = panelToAvoid(exec)
      const panelArg = panel === undefined ? {} : { panel }
      const before = settings.verifyClick && expected !== undefined
        ? await sampleSignature(mapped.screenX, mapped.screenY)
        : undefined
      const first = await host.request('click', {
        x: mapped.screenX,
        y: mapped.screenY,
        button,
        clicks,
        ...panelArg,
      })
      // The cursor position is measured, not assumed: a window can refuse the
      // move, a monitor edge can clamp it, and then the click landed elsewhere.
      const landed = {
        x: Number.isInteger(first?.cursorX) ? first.cursorX : mapped.screenX,
        y: Number.isInteger(first?.cursorY) ? first.cursorY : mapped.screenY,
      }
      // 命中必须在点击之后取：菜单、浮层、焦点都是这一下才出现的。
      // 但如果这一点上压着插件自己的浮层，host 已经把它临时穿透再点，并在穿透
      // 状态下读好了「下面是什么」（hitAfter）。等浮层还回来再 probe，只会读到
      // 自己的卡片——「点到了下面的按钮」就被报成「点到了浮层」，模型据此以为
      // 没点中，会再点一次，把动作重复触发。
      const slipped = first?.slipped === true
      const hit = slipped && first?.hitAfter !== undefined
        ? first.hitAfter
        : await probeHit(mapped.screenX, mapped.screenY)
      const notes = []
      const hitInteractive = CONTROL_HIT_TYPES.has(hit?.controlType ?? '')
        || IDEMPOTENT_HIT_TYPES.has(hit?.controlType ?? '')
      const missed = expected !== undefined && !pointInRect(landed.x, landed.y, expected)
      if (missed) {
        notes.push(`⚠ 落点 (${landed.x}, ${landed.y}) 不在目标矩形 ${expected.x},${expected.y} ${expected.width}×${expected.height} 内。`)
      }
      if (slipped) {
        const cover = typeof first?.hitBefore?.window === 'string'
          ? `「${first.hitBefore.window}」`
          : '插件自己的浮层'
        const beneath = typeof hit?.window === 'string' ? `「${hit.window}」` : '下面的窗口'
        notes.push(`⚠ 这一点上压着插件自己的浮层${cover}——已临时让它穿透再点，实际落在${beneath}上。`)
      } else if (typeof hit?.window === 'string' && hit.window.startsWith('DSH computer use')) {
        notes.push(`⚠ 这一点上压着插件自己的浮层「${hit.window}」——已临时让它穿透，但下面那块未必是你要的窗口。`)
      }
      let retried = false
      let finalHit = hit
      if (missed && settings.retryOnMiss && button === 'left' && clicks === 1 && expected !== undefined
        && !hitInteractive) {
        // 只在这种情况重试：第一次确实落在目标外，且它打中的东西不是控件——
        // 也就是说这一下大概什么都没发生，再点一次不会重复执行动作。
        const centre = rectCentre(expected)
        const retry = await host.request('click', { x: centre.x, y: centre.y, button, clicks: 1, ...panelArg })
        retried = true
        notes.push(`已按目标中心 (${centre.x}, ${centre.y}) 重试一次。`)
        finalHit = await probeHit(centre.x, centre.y)
        mapped = { ...mapped, screenX: centre.x, screenY: centre.y }
      }
      if (settings.verifyClick && expected !== undefined && before !== undefined) {
        // 画面被插件自己的浮层挡着时，前后两次采样读到的都是浮层，比较没有意义。
        if (slipped) notes.push('（这块上面压着插件自己的浮层，跳过「画面有没有变化」的比较。）')
        else {
          const settle = settings.settleMs > 0 ? Math.min(settings.settleMs, 300) : 150
          await new Promise((resolve) => { setTimeout(resolve, settle) })
          const after = await sampleSignature(mapped.screenX, mapped.screenY)
          if (signatureChanged(before, after) === false) {
            notes.push(missed
              ? '⚠ 点完这一小块画面没有任何变化，而且落点不在目标里——大概没点中。'
              : '⚠ 落点在目标里，但这一小块画面没有变化：它可能在别处生效（菜单、对话框、状态栏），也可能本来就不改外观。要看结果就截图。')
          }
        }
      }
      const label = clicks === 1 ? 'Clicked' : `${clicks === 2 ? 'Double' : 'Triple'}-clicked`
      logClick({
        at: new Date().toISOString(),
        agent: exec.agent?.id ?? '',
        input,
        expected,
        // `aimed` is what the caller asked for; `requested` is where the click
        // actually headed after snapping. The pair is what makes "it clicked the
        // neighbouring button" measurable instead of invisible.
        aimed,
        requested: { x: mapped.screenX, y: mapped.screenY },
        landed,
        hit: finalHit === undefined ? undefined : { type: finalHit.controlType, name: finalHit.name, window: finalHit.window },
        snapped: snappedNote.length > 0,
        retried,
        ageMs: mapped.ageMs ?? 0,
        tookMs: Number.isInteger(first?.tookMs) ? first.tookMs : undefined,
      })
      return `${label} ${button} at ${where}.${snappedNote}`
        + `${notes.length > 0 ? `\n${notes.join('\n')}` : ''}`
        + `\n落点 (${landed.x}, ${landed.y})；${hitLine(finalHit)}`
    },
  })))

  ctx.effect(() => ctx.tools.register(actionTool({
    name: `${TOOL_PREFIX}drag`,
    description: 'Press the pointer at one point in the last screenshot, move to another point, and release — for selecting text, resizing, or dragging items.',
    parameters: objectSchema({
      from_x: { type: 'integer', description: 'Start position, horizontal, in the last screenshot image.' },
      from_y: { type: 'integer', description: 'Start position, vertical, in the last screenshot image.' },
      to_x: { type: 'integer', description: 'End position, horizontal, in the last screenshot image.' },
      to_y: { type: 'integer', description: 'End position, vertical, in the last screenshot image.' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button to hold (default left).' },
      space: {
        type: 'string',
        enum: ['image', 'screen'],
        description: 'Which space the coordinates are in: "image" (default) from the last screenshot, '
          + '"screen" for physical screen pixels.',
      },
      allow_stale: {
        type: 'boolean',
        description: 'Accept a screenshot older than the coordinate time limit; only when the target provably did not move.',
      },
    }, ['from_x', 'from_y', 'to_x', 'to_y']),
    what: 'drag the mouse',
    whatZh: '拖动鼠标',
    describe: (args) => `从 (${args.from_x}, ${args.from_y}) 拖到 (${args.to_x}, ${args.to_y})。`,
    async perform(args, exec) {
      const fromX = integerArg(args, 'from_x')
      const fromY = integerArg(args, 'from_y')
      const toX = integerArg(args, 'to_x')
      const toY = integerArg(args, 'to_y')
      const space = args.space === 'screen' ? 'screen' : 'image'
      const from = toScreen(exec, fromX, fromY, space, { strictAge: true, allowStale: args.allow_stale === true })
      const to = toScreen(exec, toX, toY, space, { strictAge: true, allowStale: args.allow_stale === true })
      const button = ['left', 'right', 'middle'].includes(args.button) ? args.button : 'left'
      await previewPoint(from.screenX, from.screenY)
      const panel = panelToAvoid(exec)
      const result = await host.request('drag', {
        fromX: from.screenX,
        fromY: from.screenY,
        toX: to.screenX,
        toY: to.screenY,
        button,
        ...panel === undefined ? {} : { panel },
      })
      // 拖拽的起点才是「我抓住了什么」，所以只探测起点。
      const hit = await probeHit(from.screenX, from.screenY)
      return `Dragged with the ${result.button} button from ${describePoint(space, fromX, fromY, from)} `
        + `to ${describePoint(space, toX, toY, to)}.\n${hitLine(hit, '命中（拖动起点）')}`
    },
  })))

  ctx.effect(() => ctx.tools.register(actionTool({
    name: `${TOOL_PREFIX}scroll`,
    description: 'Scroll the window under the pointer, or at an optional point in the last screenshot.',
    parameters: objectSchema({
      direction: {
        type: 'string',
        enum: ['up', 'down', 'left', 'right'],
        description: 'Scroll direction.',
      },
      amount: { type: 'integer', description: 'Notches to scroll, 1 to 30 (default 3).' },
      x: { type: 'integer', description: 'Optional horizontal position in the last screenshot image; omitted scrolls under the pointer.' },
      y: { type: 'integer', description: 'Optional vertical position in the last screenshot image.' },
      space: {
        type: 'string',
        enum: ['image', 'screen'],
        description: 'Which space x,y are in: "image" (default) or "screen" for physical screen pixels.',
      },
      allow_stale: {
        type: 'boolean',
        description: 'Accept a screenshot older than the coordinate time limit; only when the target provably did not move.',
      },
    }, ['direction']),
    what: 'scroll the desktop',
    whatZh: '滚动屏幕',
    describe: (args) => `向${args.direction}滚动 ${args.amount ?? 3} 格。`,
    async perform(args, exec) {
      const direction = ['up', 'down', 'left', 'right'].includes(args.direction) ? args.direction : 'down'
      const payload = {
        direction,
        amount: Number.isInteger(args.amount) ? Math.min(Math.max(args.amount, 1), 30) : 3,
      }
      if (Number.isInteger(args.x) && Number.isInteger(args.y)) {
        const mapped = toScreen(exec, args.x, args.y, args.space === 'screen' ? 'screen' : 'image', { strictAge: true, allowStale: args.allow_stale === true })
        payload.x = mapped.screenX
        payload.y = mapped.screenY
      }
      const panel = panelToAvoid(exec)
      if (panel !== undefined) payload.panel = panel
      const result = await host.request('scroll', payload)
      return `Scrolled ${result.direction} ${result.amount} notch${result.amount === 1 ? '' : 'es'}. Take a screenshot to see the new position.`
    },
  })))

  ctx.effect(() => ctx.tools.register(actionTool({
    name: `${TOOL_PREFIX}type`,
    description: 'Type text into a control. Give `window` and `path` to write straight into that control through UI Automation: '
      + 'the window does not need the focus and the pointer never moves, so the user keeps working. That path either works or '
      + 'fails loudly — it never quietly pastes into another window. Without `window`+`path`, or with `submit` (Enter needs the '
      + 'focus), the text is pasted into the focused window instead. Chinese and other Unicode text works either way.',
    parameters: objectSchema({
      text: { type: 'string', description: 'Text to insert.' },
      submit: { type: 'boolean', description: 'Press Enter after typing (default false). Always needs the focus, so it forces the pasting path.' },
      window: {
        type: 'integer',
        description: 'Window holding the control, for the no-focus path. Defaults to the last captured window.',
      },
      path: {
        type: 'string',
        description: 'Control path from computer_ui list or computer_look — the field to write into.',
      },
      mode: {
        type: 'string',
        enum: ['append', 'replace'],
        description: 'For the no-focus path: append to the current text (default) or replace the whole field.',
      },
      snapshot: {
        type: 'string',
        description: 'Optional snapshot id from the list, so a path that moved is refused instead of written into.',
      },
    }, ['text']),
    what: 'type text',
    whatZh: '输入文字',
    noAlign: true,
    describe: (args) => `输入 ${typeof args.text === 'string' ? args.text.length : 0} 个字符${args.submit === true ? '并回车' : ''}。`,
    async perform(args, exec) {
      if (typeof args.text !== 'string' || args.text.length === 0) {
        throw new Error('text must be a non-empty string')
      }
      const path = typeof args.path === 'string' ? args.path.trim() : ''
      let handle = Number.isInteger(args.window) ? args.window : undefined
      if (handle === undefined) {
        const capture = captures.get(exec.agent?.id ?? '')
        if (Number.isInteger(capture?.handle)) handle = capture.handle
      }
      // Enter can only be pressed into a focused window, so a submit always takes
      // the pasting path; everything else gets one try at writing without focus.
      if (path.length > 0 && Number.isInteger(handle) && args.submit !== true) {
        try {
          const payload = {
            handle,
            path,
            action: 'type',
            value: args.text,
            mode: args.mode === 'replace' ? 'replace' : 'append',
          }
          Object.assign(payload, uiExpectation(exec, handle, path, args?.snapshot))
          const result = await uiAct(payload)
          const label = result.name === '' ? result.type : `${result.type}「${result.name}」`
          const how = args.mode === 'replace' ? '替换成' : '追加了'
          const stolen = Number.isInteger(result.foreground) && Number.isInteger(result.previousForeground)
            && result.foreground !== result.previousForeground
          return `Typed ${args.text.length} character${args.text.length === 1 ? '' : 's'} into ${label} without taking the focus `
            + `(${how} ${result.afterLength} 个字符的字段)；光标没动。`
            + `${stolen ? ' 注意：这个控件的提供方在处理时把前台窗口拉过去了。' : ''}`
        } catch (error) {
          // A stale reference must keep its own short name: it says what to do.
          if (String(error?.message ?? '').startsWith('STALE_REF')) throw error
          // No silent fallback: the caller asked for one specific control. Pasting
          // into whatever happens to be focused would put the text into another
          // application, which is worse than failing and saying so.
          throw new Error(`没有写入「${path}」：${error?.message ?? '未知错误'} `
            + '（没有退回到粘贴——那样会把文字打进当前焦点窗口。重新读取元素树后再试；'
            + '确实要往焦点窗口输入就别传 path。）')
        }
      }
      const result = await host.request('type', { text: args.text, submit: args.submit === true })
      return `Typed ${result.characters} character${result.characters === 1 ? '' : 's'}${result.submitted ? ' and pressed Enter' : ''} `
        + `into the focused window.${deliveryNote(exec, result)}`
    },
  })))

  ctx.effect(() => ctx.tools.register(actionTool({
    name: `${TOOL_PREFIX}key`,
    description: 'Press a key or a chord such as "ctrl+s", "alt+tab", "enter", "esc", or "f5". '
      + 'Named keys and single characters are both accepted; modifiers go first in the chord.',
    parameters: objectSchema({
      spec: { type: 'string', description: 'Key or chord, for example "ctrl+shift+s" or "enter".' },
      repeat: { type: 'integer', description: 'How many times to press it, 1 to 20 (default 1).' },
    }, ['spec']),
    what: 'press keys',
    whatZh: '按键',
    noAlign: true,
    describe: (args) => `按下 ${args.spec}。`,
    async perform(args, exec) {
      if (typeof args.spec !== 'string' || args.spec.length === 0) {
        throw new Error('spec must be a non-empty key name or chord')
      }
      const repeat = Number.isInteger(args.repeat) ? Math.min(Math.max(args.repeat, 1), 20) : 1
      const result = await host.request('key', { spec: args.spec, repeat })
      return `Pressed ${result.spec}${result.repeat > 1 ? ` ${result.repeat} times` : ''}.${deliveryNote(exec, result)} Take a screenshot to confirm the effect.`
    },
  })))

  /** Step actions a batch understands, and the tool each one reuses. */
  const STEP_ACTIONS = ['click', 'drag', 'scroll', 'type', 'key', 'focus', 'wait']
  const STEP_TOOL = {
    click: `${TOOL_PREFIX}click`,
    drag: `${TOOL_PREFIX}drag`,
    scroll: `${TOOL_PREFIX}scroll`,
    type: `${TOOL_PREFIX}type`,
    key: `${TOOL_PREFIX}key`,
    focus: `${TOOL_PREFIX}focus_window`,
  }

  /** One short line describing a planned step, for the card and the transcript. */
  function stepLabel(step) {
    const action = typeof step?.action === 'string' ? step.action : '?'
    if (action === 'click') {
      if (typeof step.anchor === 'string' && step.anchor.trim().length > 0) return `点击「${step.anchor}」这一行`
      if (step.target !== undefined) {
        const name = typeof step.target === 'string' ? step.target : (step.target?.text ?? step.target?.path ?? '?')
        return `点击控件「${name}」`
      }
      return `点击 (${step.x}, ${step.y})`
    }
    if (action === 'drag') return `拖动 (${step.from_x},${step.from_y})→(${step.to_x},${step.to_y})`
    if (action === 'scroll') return `滚动 ${step.direction ?? 'down'}`
    if (action === 'type') return `输入 ${typeof step.text === 'string' ? step.text.length : 0} 字`
    if (action === 'key') return `按键 ${step.spec ?? ''}`
    if (action === 'focus') return `切到窗口 ${step.handle ?? ''}`
    if (action === 'wait') return `等待 ${step.ms ?? 0} ms`
    return action
  }

  /** Replay one planned step through the very implementation its own tool uses. */
  async function runBatchStep(step, exec) {
    const action = typeof step?.action === 'string' ? step.action : ''
    if (action === 'wait') {
      const ms = Number.isInteger(step.ms) ? Math.min(Math.max(step.ms, 0), 10_000) : 300
      await new Promise((resolve) => { setTimeout(resolve, ms) })
      return `waited ${ms} ms`
    }
    const toolName = STEP_TOOL[action]
    const perform = toolName === undefined ? undefined : actionPerforms.get(toolName)
    if (perform === undefined) {
      throw new Error(`unknown step action "${action}"; use one of ${STEP_ACTIONS.join(', ')}`)
    }
    const input = { ...step }
    delete input.action
    return await runWithTimeout(() => perform(input, exec), settings.stepTimeoutMs)
  }

  ctx.effect(() => ctx.tools.register({
    name: `${TOOL_PREFIX}sequence`,
    description: 'Run up to 24 already-planned desktop steps in one call and take a single screenshot at the end. '
      + 'Steps: {action:"click",x,y[,button,clicks]}, {action:"drag",from_x,from_y,to_x,to_y}, '
      + '{action:"scroll",direction[,amount,x,y]}, {action:"type",text[,submit]}, {action:"key",spec[,repeat]}, '
      + '{action:"focus",handle}, {action:"wait",ms}. Coordinates use the image from your last capture, unless a step '
      + 'says space:"screen" — that is how a batch clicks OCR lines. '
      + 'Execution stops at the first failure and says which step failed. Prefer this over one call per click.',
    parameters: objectSchema({
      steps: {
        type: 'array',
        description: 'Ordered steps, run back to back.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', enum: STEP_ACTIONS },
            x: { type: 'integer' },
            y: { type: 'integer' },
            anchor: {
              type: 'string',
              description: 'For a click step: the row text to click, resolved through OCR instead of x,y. Use it when the '
                + 'screen repeats identical controls.',
            },
            target: {
              type: 'object',
              description: 'For a click step: click the centre of a control found by name in the window control tree. '
                + 'More accurate than coordinates.',
              properties: {
                text: { type: 'string' },
                role: { type: 'string' },
                path: { type: 'string' },
                window: { type: 'integer' },
              },
            },
            allow_stale: {
              type: 'boolean',
              description: 'Accept a screenshot older than the coordinate time limit; only when the target provably did not move.',
            },
            dx: { type: 'integer' },
            dy: { type: 'integer' },
            match: { type: 'integer' },
            button: { type: 'string', enum: ['left', 'right', 'middle', 'move'] },
            clicks: { type: 'integer' },
            from_x: { type: 'integer' },
            from_y: { type: 'integer' },
            to_x: { type: 'integer' },
            to_y: { type: 'integer' },
            direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
            amount: { type: 'integer' },
            space: {
              type: 'string',
              enum: ['image', 'screen'],
              description: 'For click, drag, and scroll steps: "image" (default) reads the coordinates off the last '
                + 'screenshot, "screen" means physical screen pixels such as an OCR line.',
            },
            text: { type: 'string' },
            submit: { type: 'boolean' },
            spec: { type: 'string' },
            repeat: { type: 'integer' },
            handle: { type: 'integer' },
            ms: { type: 'integer' },
          },
          required: ['action'],
        },
      },
      capture: { type: 'boolean', description: 'Take one screenshot after the last step (default true).' },
      window: { type: 'integer', description: 'Capture this window handle at the end instead of the whole monitor.' },
    }, ['steps']),
    output: {
      schema: SCREENSHOT_VALUE_SCHEMA,
      render: renderCapture,
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const steps = Array.isArray(args?.steps) ? args.steps : []
      if (steps.length === 0) throw new Error('steps must hold at least one action')
      const planned = steps.slice(0, settings.sequenceMaxSteps)
      await beginPresence(exec, `正在批量执行 ${planned.length} 步…`)
      await alignWindowTarget(exec)
      const done = []
      let failure
      let failedStep = 0
      batchDepth += 1
      try {
        for (let index = 0; index < planned.length; index += 1) {
          const step = planned[index] ?? {}
          const label = stepLabel(step)
          setStatus(`第 ${index + 1}/${planned.length} 步：${label}`)
          try {
            done.push(await runBatchStep(step, exec))
          } catch (error) {
            failure = error
            failedStep = index + 1
            break
          }
          presence.action('input', `第 ${index + 1} 步：${label}`, undefined, 'step')
          if (index < planned.length - 1 && settings.stepPauseMs > 0) {
            await new Promise((resolve) => { setTimeout(resolve, settings.stepPauseMs) })
          }
        }
      } finally {
        batchDepth -= 1
      }
      const lines = done.map((line, index) => `${index + 1}. ${line}`)
      // A pause is the user's doing, so it names itself and never counts towards
      // the stuck-action breaker — otherwise the fourth paused call looked like a
      // crash while the brake was simply on.
      const pausedStep = failure instanceof PausedError
      const header = failure === undefined
        ? `Ran ${done.length} of ${planned.length} step${planned.length === 1 ? '' : 's'} in one call.`
        : pausedStep
          ? `Stopped at step ${failedStep}/${planned.length} because the user paused desktop control. `
            + `${done.length} earlier step${done.length === 1 ? '' : 's'} went through.`
          : `Stopped at step ${failedStep}/${planned.length}: ${failure?.message ?? 'unknown error'}. `
          + `${done.length} earlier step${done.length === 1 ? '' : 's'} went through.`
      if (failure === undefined) consecutiveFailures = 0
      else if (pausedStep) {
        setStatus(`批量停在第 ${failedStep} 步：已暂停`)
        presence.action('user', `批量停在第 ${failedStep} 步：主人暂停了电脑控制`)
      } else {
        consecutiveFailures += 1
        setStatus(`批量中断于第 ${failedStep} 步：${failure?.message ?? '未知错误'}`)
        presence.action('error', `批量中断于第 ${failedStep} 步：${failure?.message ?? '未知错误'}`)
      }
      if (failure === undefined) setStatus(`批量完成 · ${done.length} 步`)
      if (args?.capture === false) return { summary: [header, ...lines].join('\n') }
      try {
        const shot = await captureOnce(exec, {
          window: Number.isInteger(args?.window) ? args.window : undefined,
        })
        const summary = [header, ...lines, '', shot.summary].join('\n')
        return shot.image === undefined ? { summary } : { summary, image: shot.image }
      } catch (error) {
        return { summary: [header, ...lines, `(final screenshot failed: ${error?.message ?? 'unknown error'})`].join('\n') }
      }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: `${TOOL_PREFIX}look`,
    description: 'Cheapest way to see what a window offers: return its UI Automation controls as a text list — path, type, name, '
      + 'the actions each accepts, and its coordinates — and only fall back when the app exposes fewer than a few usable controls: '
      + 'first to OS text recognition (cheap, and it keeps the line positions), then to a screenshot. '
      + 'Prefer this over computer_screenshot; then act with computer_ui using the listed paths.',
    parameters: objectSchema({
      window: {
        type: 'integer',
        description: 'Window handle from computer_windows. Defaults to the window captured last, else the foreground window.',
      },
      depth: { type: 'integer', description: 'How deep to walk the tree (default 6).' },
      limit: { type: 'integer', description: 'Maximum controls to list (default 60).' },
      image: {
        type: 'string',
        enum: ['auto', 'always', 'never'],
        description: 'auto (default) screenshots only when the control list is too thin; always forces a picture; never returns text only.',
      },
      ocr: {
        type: 'string',
        enum: ['auto', 'never'],
        description: 'auto (default) tries the OS text recognizer before falling back to a screenshot, which costs far '
          + 'fewer tokens when the window has readable text; never goes straight to the picture.',
      },
    }),
    output: {
      schema: SCREENSHOT_VALUE_SCHEMA,
      render: renderCapture,
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const mode = ['auto', 'always', 'never'].includes(args?.image) ? args.image : 'auto'
      const ocrMode = args?.ocr === 'never' ? 'never' : 'auto'
      let handle = Number.isInteger(args?.window) ? args.window : undefined
      if (handle === undefined) {
        const capture = captures.get(exec.agent?.id ?? '')
        if (Number.isInteger(capture?.handle)) handle = capture.handle
      }
      if (handle === undefined) {
        const listed = await host.request('windows')
        const activeHandle = listed?.windows?.find((entry) => entry.active === true)?.handle
        const panel = panelHandle()
        // Never inspect our own panel: it is the tool's window, not the user's app.
        handle = activeHandle !== undefined && activeHandle !== panel
          ? activeHandle
          : listed?.windows?.find((entry) => entry.active !== true && entry.handle !== panel)?.handle
      }
      if (!Number.isInteger(handle)) throw new Error('no window to inspect: pass `window` from computer_windows')
      await beginPresence(exec, '正在读取界面…')
      const depth = Number.isInteger(args?.depth) ? Math.min(Math.max(args.depth, 1), 12) : 6
      const limit = Number.isInteger(args?.limit) ? Math.min(Math.max(args.limit, 1), 200) : 60
      let tree
      try {
        tree = await host.request('uitree', { handle, depth, limit: Math.max(limit * 4, 200) })
      } catch (error) {
        if (mode === 'never') throw error
        tree = undefined
      }
      const actionable = tree === undefined ? 0 : actionableCount(tree)
      if (mode !== 'never' && (mode === 'always' || tree === undefined || actionable < settings.uiaMinControls)) {
        const why = mode === 'always'
          ? '按 image:"always" 的要求直接给图'
          : tree === undefined
            ? '这个窗口读不到控件树'
            : `只读到 ${actionable} 个可操作控件（阈值 ${settings.uiaMinControls}）`
        // The cheap rung before the picture: a window with text but no controls
        // (a canvas, a GPU-rendered editor) is exactly what OCR is for, and its
        // result costs a few hundred tokens against a screenshot's ~1.8k.
        if (mode === 'auto' && ocrMode !== 'never') {
          try {
            const text = await readScreenText({ handle })
            const report = formatOcrReport(text, ocrTargetName(text))
            if (report !== undefined && report.count >= settings.ocrFallbackLines) {
              toolRow(`改用 OCR：${why}`)
              return {
                summary: [`改用文字识别：${why}，但这个窗口有可读的文字。`, report.summary].join('\n'),
              }
            }
          } catch { /* no engine, or nothing readable: fall through to the picture */ }
        }
        const shot = await captureOnce(exec, { window: handle })
        const summary = [`改用截图：${why}。`, shot.summary].join('\n')
        return shot.image === undefined ? { summary } : { summary, image: shot.image }
      }
      const title = tree.elements[0]?.name || handle
      const snapshot = rememberUiSnapshot(exec, handle, tree)
      const rows = formatControlTree(tree, limit)
      toolRow(`读取了「${title}」的控件树：${actionable} 个可操作控件`)
      const header = `窗口「${title}」[${handle}]：${tree.count} 个元素，${actionable} 个可操作。`
        + ' 用 computer_ui 的 path 直接操作（invoke/select/toggle/expand/focus/value），不需要截图。'
        + ' 列表里的 @x,y 是物理屏幕像素，只用来估算位置——不要把它们交给 computer_click，那个工具吃的是截图图像坐标。'
        + ` ${snapshotHint(snapshot)}`
      return {
        summary: rows.length === 0
          ? `${header}\n（没列出任何控件：这个窗口只能靠截图，改用 computer_screenshot。）`
          : `${header}\n${rows.join('\n')}`,
      }
    },
  }))

  /**
   * Hand the window back while nothing is happening. A long job wants the corner
   * (it shows the work is still going), but a turn that is mostly thinking does
   * not: `dockIdleMs` releases the window after that long without a tool call and
   * the next call docks it again. Off by default, so the corner keeps its place
   * unless the user asks for this.
   */
  async function releaseIdleDock() {
    if (docked === null) return
    try {
      await undockSelf()
      toolRow('空闲，先把窗口还给你')
    } catch { /* the next tool call docks again anyway */ }
  }

  // The interval is always running and reads `dockIdleMs` on every tick: creating
  // it once at load made the setting one-way — a value added later never took
  // effect, and a value removed kept the "hand the window back" firing instantly.
  const idleTimer = setInterval(() => {
    if (settings.dockIdleMs <= 0 || docked === null || paused || inFlight > 0 || batchDepth > 0) return
    if (Date.now() - lastActivityAt < settings.dockIdleMs) return
    void releaseIdleDock()
  }, 500)
  idleTimer.unref?.()
  /** Stopped when the plugin is disposed, or it keeps calling a dead host. */
  idleTimerHandle = idleTimer

  /**
   * A reload or a restart leaves the docked panel behind whatever window has focus
   * and the overlay process dead, which reads as "the window and the glow are
   * gone". Restore both as soon as this instance comes up, without waiting for the
   * first action of a turn.
   */
  async function restoreDockedPresence() {
    if (docked !== null) return
    const state = await loadDock()
    if (state === null) return
    await dockSelf()
    if (docked === null) return
    try { await presence.start() } catch { /* the next action retries */ }
    if (!presence.available) return
    presence.glowOnly(docked.handle)
    showBanner('已恢复控制面板')
  }

  if (settings.dockWindow) {
    const repair = setTimeout(() => { void restoreDockedPresence().catch(() => { }) }, 1_200)
    repair.unref?.()
  }

  /**
   * Drop stale work images. Thumbnails were written for the card feed, which is
   * hidden while docked, so the row handler that deletes each file never ran and
   * they accumulated (79 MB in a day on this machine). OCR work images are
   * removed on the way out of every call, but a crash mid-read would leave one.
   */
  async function sweepThumbs() {
    try {
      const directory = await captureDirectory()
      const cutoff = Date.now() - 2 * 60 * 60 * 1_000
      for (const entry of await readdir(directory)) {
        if (!entry.startsWith('thumb-') && !entry.startsWith('ocr-')) continue
        const full = path.join(directory, entry)
        try {
          const info = await stat(full)
          if (info.mtimeMs < cutoff) await rm(full, { force: true })
        } catch { /* a file another process is showing right now */ }
      }
    } catch { /* the sweep is housekeeping only */ }
  }

  const sweep = setTimeout(() => { void sweepThumbs() }, 4_000)
  sweep.unref?.()
}

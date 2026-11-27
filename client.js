/**
 * Browser half of DSH-Computer-Use: the row's configuration page.
 *
 * The Plugins page opens this page from the row's 配置 control and hands it
 * `form.state` (the entry's accepted values plus a revision fence) and
 * `form.mutate` (atomic writes). Every control writes immediately — one click,
 * no save button — because the Host validates the whole Config before it
 * persists, and a volatile field reaches the running plugin on its next call.
 */
window.__ModuleLoader__.load({
  id: 'dsh-computer-use-windows',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useCallback } = React

    /** `<package name>#<row id>`, exactly as the bundle patch declares the row. */
    const ROW_KEY = 'dsh-computer-use-windows#computer-use-windows'

    const S = {
      group: { margin: '22px 0 6px', fontSize: 13, fontWeight: 600, letterSpacing: '.01em' },
      hint: { margin: '2px 0 10px', fontSize: 12, opacity: 0.62, lineHeight: 1.5 },
      row: {
        display: 'flex', alignItems: 'center', gap: 12, padding: '7px 0',
        borderTop: '1px solid rgba(127,127,127,.14)',
      },
      label: { flex: 1, minWidth: 0, fontSize: 13 },
      sub: { display: 'block', fontSize: 11.5, opacity: 0.55, marginTop: 2, lineHeight: 1.45 },
      input: {
        width: 132, padding: '5px 8px', borderRadius: 7, fontSize: 12.5, textAlign: 'right',
        border: '1px solid rgba(127,127,127,.3)', background: 'transparent', color: 'inherit',
      },
      select: {
        width: 168, padding: '5px 8px', borderRadius: 7, fontSize: 12.5,
        border: '1px solid rgba(127,127,127,.3)', background: 'transparent', color: 'inherit',
      },
      segmented: { display: 'flex', gap: 6, flex: 'none' },
      segment: {
        padding: '5px 12px', borderRadius: 7, fontSize: 12.5, border: '1px solid',
        background: 'transparent', color: 'inherit',
      },
      switch: {
        position: 'relative', width: 38, height: 21, borderRadius: 999, flex: 'none',
        border: '1px solid rgba(127,127,127,.35)', background: 'transparent', cursor: 'pointer',
        padding: 0,
      },
      knob: {
        position: 'absolute', top: 2, width: 15, height: 15, borderRadius: '50%',
        background: 'rgba(127,127,127,.65)', transition: 'left .12s ease, background .12s ease',
      },
      note: { margin: '10px 0 0', fontSize: 12, opacity: 0.7, lineHeight: 1.5 },
      status: { margin: '14px 0 0', fontSize: 12, opacity: 0.6 },
    }

    function Switch({ on, disabled, onToggle, label }) {
      return h('button', {
        type: 'button', role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': label,
        disabled: disabled === true, onClick: onToggle,
        style: {
          ...S.switch,
          opacity: disabled === true ? 0.35 : 1,
          cursor: disabled === true ? 'not-allowed' : 'pointer',
          borderColor: on ? '#2F7DF6' : 'rgba(127,127,127,.35)',
          background: on ? 'rgba(47,125,246,.18)' : 'transparent',
        },
      }, h('span', { style: { ...S.knob, left: on ? 20 : 2, background: on ? '#2F7DF6' : 'rgba(127,127,127,.65)' } }))
    }

    function ToggleRow({ name, label, hint, value, disabled, onWrite }) {
      return h('div', { style: S.row },
        h('div', { style: S.label }, label, hint === undefined ? null : h('span', { style: S.sub }, hint)),
        h(Switch, { on: value !== false, disabled, label, onToggle: () => { onWrite(name, value === false) } }))
    }

    function NumberRow({ name, label, hint, value, disabled, onWrite }) {
      const [draft, setDraft] = useState(null)
      const text = draft ?? (typeof value === 'number' ? String(value) : '')
      const commit = () => {
        const parsed = Number(text)
        if (!Number.isFinite(parsed) || text.trim() === '') { setDraft(null); return }
        setDraft(null)
        if (parsed !== value) onWrite(name, parsed)
      }
      return h('div', { style: S.row },
        h('div', { style: { ...S.label, opacity: disabled === true ? 0.5 : 1 } }, label, hint === undefined ? null : h('span', { style: S.sub }, hint)),
        h('input', {
          type: 'text', inputMode: 'numeric', value: text, disabled: disabled === true,
          style: { ...S.input, opacity: disabled === true ? 0.45 : 1, cursor: disabled === true ? 'not-allowed' : 'text' },
          onChange: (event) => { setDraft(event.target.value) },
          onBlur: commit, onKeyDown: (event) => { if (event.key === 'Enter') commit() },
        }))
    }

    function TextRow({ name, label, hint, value, disabled, onWrite }) {
      const [draft, setDraft] = useState(null)
      const text = draft ?? (typeof value === 'string' ? value : '')
      const commit = () => {
        setDraft(null)
        if (text !== value) onWrite(name, text)
      }
      return h('div', { style: S.row },
        h('div', { style: { ...S.label, opacity: disabled === true ? 0.5 : 1 } }, label, hint === undefined ? null : h('span', { style: S.sub }, hint)),
        h('input', {
          type: 'text', value: text, disabled: disabled === true,
          style: { ...S.input, opacity: disabled === true ? 0.45 : 1, cursor: disabled === true ? 'not-allowed' : 'text' },
          onChange: (event) => { setDraft(event.target.value) },
          onBlur: commit, onKeyDown: (event) => { if (event.key === 'Enter') commit() },
        }))
    }

    function SelectRow({ name, label, hint, value, options, disabled, onWrite }) {
      return h('div', { style: S.row },
        h('div', { style: { ...S.label, opacity: disabled === true ? 0.5 : 1 } }, label, hint === undefined ? null : h('span', { style: S.sub }, hint)),
        h('select', {
          value: typeof value === 'string' ? value : '', disabled: disabled === true,
          style: {
            ...S.select, opacity: disabled === true ? 0.45 : 1,
            cursor: disabled === true ? 'not-allowed' : 'pointer',
            // The native popup follows color-scheme; without this it was a white
            // panel with white text, so every option but the highlighted one vanished.
            colorScheme: 'dark',
          },
          onChange: (event) => { onWrite(name, event.target.value) },
        }, options.map(option => h('option', {
          key: option.value, value: option.value,
          style: { background: '#1B1B1F', color: '#F2F4F8' },
        }, option.label))))
    }

    /**
     * A two-state control that reads as a button pair rather than a switch: the
     * docked session window and the floating card are two different things, so
     * both names are on screen and the current one is highlighted.
     */
    function SegmentedRow({ name, label, hint, value, options, disabled, onWrite }) {
      return h('div', { style: S.row },
        h('div', { style: { ...S.label, opacity: disabled === true ? 0.5 : 1 } }, label, hint === undefined ? null : h('span', { style: S.sub }, hint)),
        h('div', { style: { ...S.segmented, opacity: disabled === true ? 0.45 : 1 } },
          options.map(option => h('button', {
            key: option.value, type: 'button', disabled: disabled === true,
            onClick: () => { if (option.value !== value) onWrite(name, option.value) },
            style: {
              ...S.segment,
              background: option.value === value ? 'rgba(47,125,246,.24)' : 'transparent',
              color: option.value === value ? '#9CC2FF' : 'inherit',
              borderColor: option.value === value ? '#2F7DF6' : 'rgba(127,127,127,.3)',
              cursor: disabled === true ? 'not-allowed' : 'pointer',
            },
          }, option.label))))
    }

    /**
     * Render the row's configuration page.
     * @param props - `view` (summary or page) and the owner-supplied `form`.
     */
    function Panel(props) {
      const { view, form } = props
      const state = form === undefined ? undefined : form.state
      const values = state === undefined || state.value === undefined ? {} : state.value
      const ready = state !== undefined && state.status === 'ready'
      const disabled = !ready || state.writable !== true
      const [failure, setFailure] = useState('')

      const write = useCallback((name, value) => {
        if (form === undefined) return
        setFailure('')
        void form.mutate([{ op: 'set', path: [name], value }], state === undefined ? undefined : state.revision)
          .then((accepted) => { if (accepted !== true) setFailure('宿主拒绝了这次修改（值越界或已被别处改过）') })
          .catch((error) => { setFailure(String(error && error.message ? error.message : error)) })
      }, [form, state])

      if (view === 'summary') {
        return h('div', { style: { fontSize: 12.5, opacity: 0.7, lineHeight: 1.5 } },
          '屏幕四周的光带、状态条、截图预览、目标框和落点都能单独开关；纯净模式一键全关，只操作电脑不出任何效果。')
      }
      if (!ready) {
        return h('p', { style: S.note }, state !== undefined && state.status === 'unavailable'
          ? '这个插件的配置页没有暴露给当前客户端。'
          : '正在读取配置…（如果一直停在这里，请从这一行的「配置」进入本页。）')
      }

      const group = (title, hint, rows) => h('section', { key: title },
        h('h3', { style: S.group }, title),
        hint === undefined ? null : h('p', { style: S.hint }, hint),
        rows)

      // While Clean mode is on, the accessory switches cannot do anything (it
      // wins over every one of them). Letting them look operable was the
      // "拨了没反应" complaint: they are locked instead, with the reason attached.
      const clean = values.cleanMode === true
      const locked = disabled || clean
      // The surface master owns the card and the docked panel; off means both are
      // impossible, so the window group and the card row are locked with it.
      const surface = values.effectSurface !== false
      const lockedSurface = locked || !surface
      // What the plugin will actually do, not what the profile stores: clean mode
      // and the surface master force float, and a highlighted 会话窗口 next to a
      // floating card is exactly the "buttons look swapped" report.
      const effectiveMode = clean || !surface ? 'float' : values.windowMode === 'float' ? 'float' : 'dock'
      const masterHint = clean
        ? '纯净模式开着：下面两组已经全部熄灭并锁住——先关掉纯净模式再单独调。'
        : '这两个开关是总闸：纯净模式熄灭全部效果；「显示控制窗口」关掉后，卡片不出现、会话窗口也不动。下面两组跟着它们的开关状态锁灰。'

      return h('div', null,
        group('总开关', masterHint, [
          h(ToggleRow, { key: 'cleanMode', name: 'cleanMode', label: '纯净模式', hint: '不画光带、不显状态条、不弹预览、不画目标框和落点、不缩停靠窗口', value: values.cleanMode, disabled, onWrite: write }),
          h(ToggleRow, { key: 'effectSurface', name: 'effectSurface', label: '显示控制窗口（悬浮卡片 + 停靠）', hint: !surface ? '关着：不出卡片、窗口也不缩；「蓝边」不受影响，照它的开关走' : '关掉后：悬浮卡片不出现，会话窗口一个像素都不动，蓝边照旧', value: values.effectSurface, disabled: locked, onWrite: write }),
        ]),
        group('窗口与停靠', surface ? '只在「显示控制窗口」开着时生效；关掉它，这一组全部锁灰，会话窗口一个像素都不动。' : '「显示控制窗口」关着，这一组锁灰：窗口不会被缩小，也不会有停靠面板。', [
          h(SegmentedRow, {
            key: 'windowMode', name: 'windowMode', label: '显示方式', value: effectiveMode, disabled: lockedSurface,
            hint: clean || !surface
              ? '总开关把当前形态强制成悬浮窗（不碰会话窗口）；关掉总开关后才会按这里的选项来'
              : '会话窗口：把它缩到你选的位置；悬浮窗：会话窗口一个像素都不动，只出卡片',
            options: [{ value: 'dock', label: '会话窗口' }, { value: 'float', label: '悬浮窗' }], onWrite: write,
          }),
          h(SelectRow, {
            key: 'dockCorner', name: 'dockCorner', label: '停靠位置', value: values.dockCorner, disabled: lockedSurface,
            hint: '四个角任选；「自定义」会记住你上次把它拖到哪儿',
            options: [
              { value: 'topright', label: '右上角' },
              { value: 'topleft', label: '左上角' },
              { value: 'bottomright', label: '右下角' },
              { value: 'bottomleft', label: '左下角' },
              { value: 'custom', label: '自定义（记住拖到的位置）' },
            ], onWrite: write,
          }),
          h(NumberRow, { key: 'dockWidth', name: 'dockWidth', label: '停靠面板宽度', hint: '像素；改小一点，停靠时不至于挡住要点的东西', value: values.dockWidth, disabled: lockedSurface, onWrite: write }),
          h(NumberRow, { key: 'dockHeight', name: 'dockHeight', label: '停靠面板高度', hint: '像素', value: values.dockHeight, disabled: lockedSurface, onWrite: write }),
          h(NumberRow, { key: 'dockIdleMs', name: 'dockIdleMs', label: '空闲多久把窗口还给你', hint: '毫秒；0 = 整个回合都停靠着', value: values.dockIdleMs, disabled: lockedSurface, onWrite: write }),
        ]),
        group('画面元素', clean ? '纯净模式开着：这一组全部熄灭并锁住。' : '纯净模式开着时全部熄灭；「光带颜色」只跟着「蓝边」走，和其它项无关。', [
          h(ToggleRow, { key: 'effectCard', name: 'effectCard', label: '控制卡片', hint: !surface ? '「显示控制窗口」已关' : clean ? '纯净模式已熄灭' : '说明、进度、权限询问和回复框', value: values.effectCard, disabled: lockedSurface, onWrite: write }),
          h(ToggleRow, { key: 'effectGlow', name: 'effectGlow', label: '蓝边（屏幕四周的光带）', hint: clean ? '纯净模式已熄灭' : undefined, value: values.effectGlow, disabled: locked, onWrite: write }),
          h(SelectRow, {
            key: 'accent', name: 'accent', label: '光带颜色', value: values.accent, disabled: locked,
            options: [
              { value: 'blue', label: 'DSH 蓝' }, { value: 'orange', label: '橙' }, { value: 'purple', label: '紫' },
              { value: 'green', label: '绿' }, { value: 'pink', label: '粉' }, { value: 'red', label: '红' },
            ], onWrite: write,
          }),
          h(ToggleRow, { key: 'effectBanner', name: 'effectBanner', label: '状态条', hint: clean ? '纯净模式已熄灭' : '停在窗口上沿的一行进度；停靠时也用它', value: values.effectBanner, disabled: locked, onWrite: write }),
          h(ToggleRow, { key: 'effectTarget', name: 'effectTarget', label: '目标窗口边框', hint: clean ? '纯净模式已熄灭' : '被别的窗口压住时会自动收起', value: values.effectTarget, disabled: locked, onWrite: write }),
          h(SelectRow, {
            key: 'pillCorner', name: 'pillCorner', label: '「正在操作谁」标牌放哪', value: values.pillCorner, disabled: locked,
            hint: '标牌写着进程和窗口标题，边框收起时也不消失；选「自定义」后拖它左边那个小把手定位',
            options: [
              { value: 'topcenter', label: '顶部居中' },
              { value: 'topleft', label: '左上角' },
              { value: 'topright', label: '右上角' },
              { value: 'bottomleft', label: '左下角' },
              { value: 'bottomright', label: '右下角' },
              { value: 'custom', label: '自定义（拖动记住位置）' },
            ], onWrite: write,
          }),
          h(ToggleRow, { key: 'effectClickPoint', name: 'effectClickPoint', label: '点击落点光圈', hint: clean ? '纯净模式已熄灭' : undefined, value: values.effectClickPoint, disabled: locked, onWrite: write }),
          h(ToggleRow, { key: 'effectNotice', name: 'effectNotice', label: '居中提示', hint: clean ? '纯净模式已熄灭' : undefined, value: values.effectNotice, disabled: locked, onWrite: write }),
          h(TextRow, { key: 'noticeTitle', name: 'noticeTitle', label: '提示里写什么', hint: '默认「DeepSeek 正在使用你的电脑」；改成你自己的说法，下一轮生效', value: values.noticeTitle, disabled: locked, onWrite: write }),
        ]),
        group('截图与预览', '预览不依赖「显示控制窗口」：卡片关掉也照样弹，位置单独选；截图会落到一个你能打开的目录。', [
          h(ToggleRow, { key: 'effectPreview', name: 'effectPreview', label: '截图预览小窗', hint: clean ? '纯净模式已熄灭' : '不受「显示控制窗口」影响；关掉只是不弹这个窗口', value: values.effectPreview, disabled: locked, onWrite: write }),
          h(ToggleRow, { key: 'previewFollow', name: 'previewFollow', label: '贴在控制窗口边上', hint: '卡片或停靠面板在时紧贴它，左右自动选有空的一侧；关掉就按下面的位置放', value: values.previewFollow, disabled: locked, onWrite: write }),
          h(SelectRow, {
            key: 'previewCorner', name: 'previewCorner', label: '没有控制窗口时放哪', value: values.previewCorner, disabled: locked,
            hint: '没有卡片、也没有停靠时用这个位置；「自定义」用停靠位置里记住的那个点',
            options: [
              { value: 'topright', label: '右上角' },
              { value: 'topleft', label: '左上角' },
              { value: 'bottomright', label: '右下角' },
              { value: 'bottomleft', label: '左下角' },
              { value: 'custom', label: '自定义（同停靠自定义位置）' },
            ], onWrite: write,
          }),
          h(TextRow, { key: 'shotDir', name: 'shotDir', label: '截图保存目录', hint: '留空 = %TEMP%\\dsh-computer-use\\shots；支持 %TEMP% 这类变量，改完下一张生效', value: values.shotDir, disabled: locked, onWrite: write }),
          h(NumberRow, { key: 'keepShots', name: 'keepShots', label: '保留最近几张截图', hint: '0 = 不落盘（读完就删）；超出的旧图会被自动清掉', value: values.keepShots, disabled: locked, onWrite: write }),
        ]),
        group('控制权', '暂停键是真正的主动权：按一下，所有点击、按键、滚动和 UIA 动作都被拒绝。', [
          h(TextRow, { key: 'pauseHotkey', name: 'pauseHotkey', label: '暂停热键', hint: '例如 ctrl+alt+q；留空 = 关闭', value: values.pauseHotkey, disabled, onWrite: write }),
          h(SelectRow, {
            key: 'approval', name: 'approval', label: '危险动作要不要先问', value: values.approval, disabled,
            options: [
              { value: 'never', label: '从不问（最快）' },
              { value: 'once-per-session', label: '每个会话问一次' },
              { value: 'every-action', label: '每次都问' },
            ], onWrite: write,
          }),
          h(ToggleRow, { key: 'activateBeforeActing', name: 'activateBeforeActing', label: '动作前把目标窗口提到前台', value: values.activateBeforeActing, disabled, onWrite: write }),
          h(ToggleRow, { key: 'clickSnap', name: 'clickSnap', label: '点击吸附到控件中心', hint: '坐标落在控件边缘时自动吸到它的中心；附近有多个控件就不动', value: values.clickSnap, disabled, onWrite: write }),
          h(NumberRow, { key: 'snapRadius', name: 'snapRadius', label: '吸附半径', hint: '像素；点落在控件外多远还能吸回来', value: values.snapRadius, disabled, onWrite: write }),
          h(ToggleRow, { key: 'verifyClick', name: 'verifyClick', label: '点击后核对落点', hint: '报告真实光标位置、点到什么，并检查画面有没有变化', value: values.verifyClick, disabled, onWrite: write }),
          h(ToggleRow, { key: 'retryOnMiss', name: 'retryOnMiss', label: '没点中时自动重试一次', hint: '只在第一次落点确实在目标外、且没打到别的控件时', value: values.retryOnMiss, disabled, onWrite: write }),
        ]),
        group('成本', '截图是这里最贵的东西：一图约 1.8k token，文字清单约 0.5k。', [
          h(NumberRow, { key: 'maxImageWidth', name: 'maxImageWidth', label: '截图下采样宽度', hint: '1596 正好贴模型 patch 网格，改大只会更贵', value: values.maxImageWidth, disabled, onWrite: write }),
          h(ToggleRow, { key: 'dedupeShots', name: 'dedupeShots', label: '画面没变就不给新图', value: values.dedupeShots, disabled, onWrite: write }),
          h(NumberRow, { key: 'settleMs', name: 'settleMs', label: '动作后等多久再截图', hint: '毫秒；调小会拍到旧画面', value: values.settleMs, disabled, onWrite: write }),
          h(NumberRow, { key: 'coordinateTtlMs', name: 'coordinateTtlMs', label: '截图坐标多旧就提示过期', hint: '毫秒', value: values.coordinateTtlMs, disabled, onWrite: write }),
          h(NumberRow, { key: 'ocrMaxLines', name: 'ocrMaxLines', label: '一次 OCR 最多列几行', value: values.ocrMaxLines, disabled, onWrite: write }),
        ]),
        group('稳定性', '出问题时的兜底：超时、重试、连续失败几次就停。', [
          h(NumberRow, { key: 'helperTimeoutMs', name: 'helperTimeoutMs', label: '单次辅助调用超时', hint: '毫秒', value: values.helperTimeoutMs, disabled, onWrite: write }),
          h(NumberRow, { key: 'stepTimeoutMs', name: 'stepTimeoutMs', label: '单步超时', hint: '毫秒', value: values.stepTimeoutMs, disabled, onWrite: write }),
          h(ToggleRow, { key: 'retryOnce', name: 'retryOnce', label: '可重试的失败自动重试一次', value: values.retryOnce, disabled, onWrite: write }),
          h(NumberRow, { key: 'failureLimit', name: 'failureLimit', label: '连续失败几次就停下', value: values.failureLimit, disabled, onWrite: write }),
          h(NumberRow, { key: 'sequenceMaxSteps', name: 'sequenceMaxSteps', label: '一次批量最多几步', value: values.sequenceMaxSteps, disabled, onWrite: write }),
        ]),
        failure === '' ? null : h('p', { style: { ...S.note, color: '#EF4444' } }, failure),
        h('p', { style: S.status }, `改动立即生效并写回 profile；当前值来自 ${state.writable === true ? 'profile 覆盖 + 默认值' : '只读快照'}。`))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Strip the temporary diagnostics an earlier build appended to the title.
        try {
          if (typeof document !== 'undefined') document.title = document.title.replace(/ \[cu\]/g, '').replace(/ \[bundle\]/g, '')
        } catch { /* a headless host has no document */ }
        // The row page: `<package name>#<row id>`, exactly as the bundle patch
        // declares the row (verified against the page's own DEBUG line).
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: ROW_KEY,
          order: 20,
        }, Panel))
      },
    }
  },
})

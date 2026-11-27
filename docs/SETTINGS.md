# 设置项清单（v0.30.0）

两条改法，效果一样：

- **界面**：侧栏「插件」→ 点开 **DSH-Computer-Use** 那一行 → 在它自己的页面里找到「包含的组件」→ **点组件名 `DSH-Computer-Use ›` 这一行标题**，开关就在打开的页面里。列表行上**没有**叫「配置」的按钮，也没有这两个字。点一下即时生效并写回 profile，不需要重载、不用打命令、不用按热键。设置页暴露 29 项（下面表格里「页」列有勾的）。如果进页面后看不到表单，说明浏览器半边没进模块图，重启 App 一次。
- **文件**：`~/.dsh/profiles/desktop/cordis.patch.yml` 里 `- id: computer-use-windows` 那段 `config:`。适合设置页没有的项（19 项）和批量改。

> 生效链：Config 默认值 → profile patch 覆盖 → `resolveSettings()` 兜底与夹取。源码位置：`index.js` 第 238 行（`Config`）、第 295 行（`resolveSettings`）、第 210 行（`resolveEffects`）、第 101 行（`KNOWN_SETTINGS`，写错的键会被记进启动戳里）。

## 一、总开关与画面元素（10 项，全部在设置页）

> 设置页按"谁影响谁"分组（0.26.9）：**总开关**（纯净模式、显示控制窗口）→ **窗口与停靠**（下节）→ **画面元素**（本节的其余 8 项）。纯净模式关掉一切；显示控制窗口关掉卡片与停靠；任一总开关关掉时，它管辖的那一组会**整组锁灰**并写明原因。

| 键 | 页面标签 | 默认 | 管什么 |
| --- | --- | --- | --- |
| `cleanMode` | 纯净模式 | `false` | **总开关**。开：下面 9 项全部熄灭，且不缩停靠窗口（`windowMode` 被强制当 `float`），暂停热键仍然有效。关：各项恢复自己记住的值 |
| `effectGlow` | 蓝边（屏幕四周的光带） | `true` | 屏幕四边的光带 |
| `effectBanner` | 状态条 | `true` | 停在窗口上沿的一行进度 |
| `effectPreview` | 截图预览小窗 | `true` | 把拍到的画面浮出来给你看 |
| `effectCard` | 控制卡片 | `true` | 说明、进度、权限询问、回复框 |
| `effectTarget` | 目标窗口边框 | `true` | 正在操作的那个窗口加一圈边 |
| `effectClickPoint` | 点击落点光圈 | `true` | 点击前在落点闪一个圈 |
| `effectNotice` | 居中提示 | `true` | 「DeepSeek 正在使用你的电脑」这类一次性居中提示 |
| `noticeTitle` | 提示里写什么 | `DeepSeek 正在使用你的电脑` | 居中提示的那一句话，可以换成你自己的说法；下一轮控制开始时生效 |
| `effectSurface` | 显示控制窗口（悬浮卡片 + 停靠） | `true` | **总开关**：关掉后悬浮卡片不出现、会话窗口一个像素都不动（`windowMode` 强制 float），并把「控制卡片」和「窗口与停靠」整组锁灰；已经停靠的窗口会立刻还原。**它只管卡片与停靠，不碰蓝边**：蓝边跟自己的 `effectGlow` 走（0.27.7 前关总开关会把蓝边一起熄灭，是 bug） |

> `effectDock`（旧键「允许停靠」）0.27.0 起从设置页移除，0.27.5 起**代码也不再读取**——`windowMode` 是唯一决定者。字段保留只为让老 yml 仍能通过校验。

决策逻辑在 `resolveEffects()`：**clean mode 赢过一切**，单项开关的值仍然被记住，关掉纯净模式后各自回来——所以"只想干净地控制电脑"不会被某个遗留开关破坏。

> 纯净模式开着时，设置页会把其余 9 个开关、显示形态、光带颜色、停靠尺寸全部**置灰锁定**，并在组标题下写明原因（0.26.2）。它们此刻本来就不生效；让人能点却没效果，正是"拨了没反应"的来源。

## 二、窗口与停靠（5 项在设置页）

| 键 | 默认 | 范围 | 作用 |
| --- | --- | --- | --- |
| `windowMode` | `dock` | `dock` / `float` | **显示方式**（分段按钮）：`dock` = 会话窗口，控制期间缩到「停靠位置」；`float` = 悬浮窗，会话窗口一个像素都不动，只出卡片 |
| `dockCorner` | `topright` | `topright` / `topleft` / `bottomright` / `bottomleft` / `custom` | **停靠位置**。四个角任选；`custom` = 记住你上次把面板拖到的位置（还原前写入 `%TEMP%\dsh-computer-use-dockpos.json`），下次停回那里 |
| `accent` | `blue` | `blue/orange/purple/green/pink/red` | 光带颜色（`#2F7DF6` / `#FF8A3D` / `#8B5CF6` / `#22C55E` / 粉 / 红） |
| `dockIdleMs` | `0` | 0–600000 ms | 最后一次操作后多久把窗口还给你。`0` = 整个回合都不还。**只对 dock 有意义** |
| `dockWidth` | `520` | 360–1200 | 停靠面板宽 |
| `dockHeight` | `720` | 320–1400 | 停靠面板高 |

优先级（0.27.5 起）：`cleanMode: true` 或 `effectSurface: false` → 强制 `float`；否则 `windowMode` 说了算（`float` = 悬浮窗，其它值 = 会话窗口）。旧键 `effectDock` / `dockWindow` **不再参与判断**；它们留着只是不让老 yml 校验失败。

## 二之二、截图与预览（5 项在设置页，0.29.0）

预览是独立的一层：**关掉「显示控制窗口」照样能看**（0.29.0 前预览只挂在停靠面板旁边，卡片模式下一律不弹，所以打开 float 或关掉总开关就"看不到预览"）。

| 键 | 默认 | 范围 | 作用 |
| --- | --- | --- | --- |
| `effectPreview` | `true` | 开关 | 截图预览小窗本身。关掉只是不弹这个窗口，不影响截图与其它元素；**不受 `effectSurface` 影响** |
| `previewFollow` | `true` | 开关 | 有控制窗口（停靠面板或悬浮卡片）时贴它边上：左右自动选有空的一侧，上下按 12 px 间距，全程夹在虚拟桌面内。此时预览**没有**拖动手柄 |
| `previewCorner` | `topright` | `topright/topleft/bottomright/bottomleft/custom` | **没有控制窗口时**放哪个角；`custom` = 你上次拖动预览放下的位置（`%TEMP%\dsh-computer-use-previewpos.json`），没拖过则用 `dockCorner: custom` 的坐标 |
| `shotDir` | 空（= `%TEMP%\dsh-computer-use\shots`） | 任意路径，支持 `%TEMP%` 这类变量 | 截图落到哪。0.29.0 前截图读完就删，现在**默认留最近 50 张**，可以直接打开看 |
| `keepShots` | `50` | 0–2000 | 保留最近几张；`0` = 不落盘（读完就删）。超出部分**每次截图后**清一次，只清 `screen-*.png`（`thumb-*.png` 由预览计时器自己删） |

> **拖动预览（0.29.1）**：没有控制窗口时，预览右上角有一个小把手（`⣿`，34×22）。按住它拖，预览跟着走，松手就把位置写进 `%TEMP%\dsh-computer-use-previewpos.json`，下一张自动回到那里；拖动时全程夹在虚拟桌面内。把手是预览唯一能接收鼠标的像素（图本身仍然点击穿透，不会吃掉你的点击）。在设置里换「预览位置」会清掉这个记忆。

## 三、控制权（7 项在设置页）

| 键 | 默认 | 取值 | 作用 |
| --- | --- | --- | --- |
| `pauseHotkey` | `ctrl+alt+q` | 热键字符串，空 = 关闭 | 主人的刹车：按一下，所有输入被拒绝；再按恢复。被别的软件占用时用 `/pause` 兜底 |
| `approval` | `never` | `never` / `once-per-session` / `every-action` | 危险动作要不要先在卡片里问一句。**注意**：schema 默认是 `never`，只有写入非法值时才回落成 `once-per-session` |
| `activateBeforeActing` | `true` | true/false | 动作前是否把目标窗口提到前台。关掉更少打扰，但按键可能落错窗口 |
| `clickSnap` | `true` | 开关 | 坐标点击前把点吸附到附近唯一控件的中心（0.28.0） |
| `snapRadius` | `24` | 6–80 px | 吸附半径：点落在控件外多远还能吸回来 |
| `verifyClick` | `true` | 开关 | 点击后核对**实测落点**是否在目标矩形内，并比较点击前后的画面指纹，报「没有变化」 |
| `retryOnMiss` | `true` | 开关 | 落点确实在目标外、且没打到别的控件时，按目标中心重试**一次** |

> 关于「两个鼠标」：Windows 只有一个系统光标和一个键盘焦点。能"不打扰"的只有不碰光标的路径（`computer_ui` 的 invoke/select/toggle/value、OCR、截图）；像素点击和按键必然要占用——所以**暂停键才是真正的主动权**。

## 四、成本（5 项在设置页）

| 键 | 默认 | 范围 | 作用 |
| --- | --- | --- | --- |
| `maxImageWidth` | `1596` | 1–3840 | 截图下采样宽度。1596 = 38×42，正好贴模型 patch 网格，**别四舍五入**；改大只会多花钱 |
| `dedupeShots` | `true` | 开关 | 同一目标像素没变时只回一行字、不附新图 |
| `settleMs` | `180` | 0–2000 ms | 动作后等多久再拍（等重绘）。调小会拍到旧画面 |
| `coordinateTtlMs` | `15000` | 5000–3600000 ms | 截图坐标的时效：超过就**拒绝**点击/拖动/滚动（0.28.0 起，之前是 120 s 只警告）。确认画面没动时给那一步 `allow_stale:true` |
| `ocrMaxLines` | `60` | 5–400 | 一次 OCR 最多列几行（一行约 15 token） |

## 五、稳定性（5 项在设置页）

| 键 | 默认 | 范围 | 作用 |
| --- | --- | --- | --- |
| `helperTimeoutMs` | `20000` | 1–120000 ms | 单次辅助进程调用超时 |
| `stepTimeoutMs` | `60000` | 5000–300000 ms | 批量里单步超时 |
| `retryOnce` | `true` | 开关 | 可重试的失败自动重试一次 |
| `failureLimit` | `3` | 1–10 | 连续失败几次就停下不再尝试 |
| `sequenceMaxSteps` | `24` | 1–60 | 一次 `computer_sequence` 最多几步 |

## 六、只在 yml 里的 19 项（设置页没暴露）

| 键 | 默认 | 范围/取值 | 作用 |
| --- | --- | --- | --- |
| `dockWindow` | 无 | true/false | **旧键，0.27.5 起不生效**（只为兼容老 yml 的校验）。请用 `windowMode` |
| `clickPreview` | `true` | 开关 | **旧键**：等价于 `effectClickPoint`（`resolveSettings` 仍读它） |
| `dockMargin` | `0` | 0–200 | 停靠面板离屏幕边的距离（0 = 完全贴右上角） |
| `cardWidth` | `520` | 380–1200 | 卡片宽（拖过之后以 `computer-use-card.json` 为准） |
| `cardHeight` | `680` | 320–1400 | 卡片高（同上） |
| `cardMargin` | `0` | 0–200 | 卡片离屏幕边的距离 |
| `previewMs` | `260` | 0–1000 ms | 落点光圈停留时间 |
| `previewShotMs` | `4000` | 800–20000 ms | 截图预览小窗停留时间 |
| `noticeSeconds` | `5` | 1–30 s | 居中提示停留时间 |
| `mirror` | `true` | 开关 | 把会话内容镜像到控制卡片上 |
| `zoomMaxSide` | `2000` | 40–8000 | 单次 `computer_zoom` 的最长边，防止一次要看整个桌面 |
| `uiaMinControls` | `3` | 1–20 | 可操作控件少于这个数才退回 OCR/截图 |
| `ocrFallbackLines` | `6` | 1–100 | OCR 至少读出这么多行才代替截图 |
| `stepPauseMs` | `80` | 0–800 ms | 批量里每步之间停多久（给界面喘息） |
| `defaultMonitor` | `1` | 1–8 | 默认拍哪个显示器 |
| `hotkey` | `''` | 热键字符串 | 召唤热键（默认关闭） |
| `dockHotkey` | `''` | 热键字符串 | 停靠/悬浮切换热键（默认关闭） |
| `hotkeyMode` | `summon` | `summon`/`prompt` | 召唤热键只叫起，还是同时替你发一句话 |
| `hotkeyPrompt` | `继续` | 文本 | `hotkeyMode: prompt` 时替你发的那句话 |

## 七、为什么"改一下就生效"

1. 每个字段都声明了 `.volatile()`（`Config` 里用 `boolField/numberField/textField` 三个助手统一加）。DSH 只把 volatile 字段投影给运行中的实例。
2. 值变了，Host 发 `loader/volatile-update`；插件收到后 `resolveSettings(config)` 重算，并立刻下发三件事：效果策略 `presence.setPolicy(settings.effects)`、颜色 `setAccent`、暂停热键 `setPauseHotkey`。
3. 另外 `refreshSettings()`（第 560 行）在每次 `beginPresence()` 和 `host.request` 包装里再读一遍，防止某次事件丢失导致用的是旧值。**这一条是后补的**：早期只靠事件，界面关掉纯净模式后光带不回来，加了这个才修好。
4. 效果开关**会真的下发到正在运行的浮层**（0.26.1 起）：`presence.setPolicy()` 合并策略后立刻写 `{type:'policy', glow, card, banner, preview, target, clickPoint, notice}`，浮层收到就把对应窗口收起/恢复；`beginPresence()` 在 `start()` 之后再补发一次，保证新起的浮层知道当前策略。**这一条是 0.26.1 补的**：此前只改 JS 侧对象，卡片一出现就把光带点亮（`Set-CardVisible $true` 把两者绑在一起），所以「关掉光带」看起来完全没用。
5. 两个方向的"回来"也补了：关掉纯净模式时 `refreshSettings()` 检测到 card 由关到开，会补一次 `show`（卡片立刻回来，不用等下一回合）；停靠开关关掉时 `releaseDockNow()` 立刻把会话窗口放回原位。
6. 实测（未重载）：把 `maxImageWidth` 从 1596 改成 700，下一次截图直接是 700×448；改回 1596，下一次立刻回到 1282×821。说明 volatile 通道本来就是通的，问题只在浮层没收到策略。

## 八、存在哪

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- insert:
    - id: computer-use-windows
      name: dsh-computer-use-windows
      inject: ['tools']
      config:
        cleanMode: false      # 设置页写进来的就是这种平铺键
        effectGlow: true
        windowMode: dock
        pauseHotkey: ctrl+alt+q
        approval: never
```

平铺设计是故意的：一个设置路径就是一个键，老 yml 不用迁移。写错的键不会报错，而是被记进 `%DSH_HOME%/computer-use-start.json` 的 `unknownKeys`，可以事后查。

## 九、三套现成组合

| 模式 | 怎么配 | 适合 |
| --- | --- | --- |
| **悬浮窗** | `windowMode: float` | 你做你的事，卡片待在右上角，会话窗口一个像素都不动 |
| **长任务** | `windowMode: dock` + `dockIdleMs: 0` | 你走开一会儿，回来它干完了。角落一直显示进度，光带一直亮 |
| **边干边用** | `windowMode: dock` + `dockIdleMs: 4000` | 它想的时候窗口立刻还你，动手时再收回去 |
| **纯净** | `cleanMode: true` | 什么都别画，只要它操作电脑 |

## 十、还没做的（想加之前先看这里）

| 东西 | 现状 |
| --- | --- |
| 细粒度授权（"允许点击但不许按键"） | ⏳ 只有全局暂停 + `approval` 三档 |
| 悬浮卡片点击穿透 | ⏳ 停靠模式下面板会自己让开（`panelHandle()`），悬浮卡片不会：卡片覆盖的那块区域点下去会点到卡片，绕法是把卡片拖开或改用 dock |
| 设置页的界面文案本地化 | ⏳ `client.js` 里是中文硬编码，没有走 `ctx.locale.register` |
| 暂停状态的持久化 | ✅ 已定为「重载后恢复可用」（2026-11-22 决定）：暂停是"这一次别动我的电脑"，不是跨会话状态 |

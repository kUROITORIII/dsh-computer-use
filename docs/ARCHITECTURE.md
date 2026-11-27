# 结构、协议与改动地图（v0.30.0）

## 一、五个部分，两种进程

```
┌─ DSH 主进程（Node） ────────────────────────────────────────────┐
│  index.js    插件本体：46 个配置项、19 个工具、暂停、停靠、效果策略 │
│  host.js     常驻 PowerShell 辅助进程的监管者（JSON 行协议）        │
│  presence.js 浮层接口：起 WPF 子进程、下发消息、策略过滤、热键事件  │
└───────┬───────────────────────────────┬─────────────────────────┘
        │ spawn + stdin/stdout 行协议    │ spawn + stdin 行协议
        ▼                               ▼
  scripts/host.ps1                scripts/overlay.ps1
  截屏 / 窗口枚举 / UIA /           WPF 无边框窗口：光带、状态条、
  输入注入 / OCR / 放大 / 停靠     目标框、落点、提示、预览、卡片

┌─ 浏览器（Web GUI） ─────────────┐
│  client.js  插件页里该行的设置表单（slot plugins.row.config）    │
└─────────────────────────────────┘
```

两个 PowerShell 进程都是**懒启动**：第一次真正用到才起（`host` 在第一次请求、`overlay` 在第一次 `beginPresence`）。插件停用时一起退出，所以「插件关了还有没有后台进程」可以直接用 `Get-Process powershell` 验证。

## 二、host 协议（index.js ↔ host.ps1）

`host.js` 负责：懒启动、ready 握手、串行队列、超时、崩溃后整批 reject。

| 方向 | 一行 JSON |
| --- | --- |
| 启动 | host 打印 `{"ready":true}`（启动上限 20 s） |
| 请求 | `{"id":3,"op":"click","args":{...}}` |
| 成功 | `{"id":3,"ok":true,"result":{...}}` |
| 失败 | `{"id":3,"error":{"code":"...","message":"..."}}` |

- **串行**：所有请求排一条链（`#queue`），保证"先点后输"不会被并发打乱。
- **超时**：默认 `helperTimeoutMs`；`computer_wait` 这类长请求可以带 per-call 超时（早期漏传这个参数，25 s 的 wait 会在 20 s 报"helper 没回答"）。
- **崩溃**：子进程 exit 时把所有 in-flight 请求一起 reject，下次调用重新起进程，不会往半死进程里写。
- 常用 op：`ping screenshot monitors clipboard windows wait dock raise clickthrough uitree uiact hit signature zoomshot ocr windowrect windowshot focus click drag scroll type key cursor pause`。全部在 `scripts/host.ps1` 的 `switch ($op)` 里。
- `hit` 是 0.26.0 加的只读探测：`{x,y}` 返回 `{controlType,name,class,processId}`（UIA `ElementFromPoint`，辅助进程本来就是 `-Sta` 启动的，满足 UIA 的线程要求）；`{points:[{x,y},…]}` 一次问多点、返回 `{count,hits:[…]}`，anchor 的候选行就是这么一次问完的。0.28.0 起额外返回 `rect{x,y,width,height}`、`hwnd`（`RootAt`）与 `window`（标题）——吸附、落点核对、遮挡判断都靠这三个字段。它不进 `ACTING_OPS`，暂停时仍可用。
- `signature` 是 0.28.0 加的：`{x,y,width,height[,cols,rows]}` 返回 8×6 个采样点的 RGB（`Get-FrameSignature`）。用途只有一个——点击前后各取一次，判断「这一下有没有让画面变」。不是哈希，同一块像素重复取完全一致。
- 点击链路（0.28.0）：`target`/`anchor` 解析矩形 → 纯坐标则 `toScreen`（时效检查）→ `snapPoint` 吸附 → `click` → 读回实测光标 → `hit` → 必要时按目标中心重试一次 → `signature` 比较 → 写 `%TEMP%\dsh-click-log.jsonl`。`click/drag/scroll` 三条 op 在 host 侧还会检查点上是不是插件自己的浮层（标题 `DSH computer use*`），是就临时 `SetPanelAway` 让它穿透，动作结束立刻恢复。

## 三、overlay 协议（presence.js ↔ overlay.ps1）

启动参数（一次性）：`-Accent -CardWidth -CardHeight -CardMargin -Hotkey -DockHotkey -PauseHotkey -StartHidden`。
之后父进程只写 stdin，消息类型（`scripts/overlay.ps1` 的 `Handle-Message`）：

`show hide card-hide policy glow-only glow-dock glow-dock-clear banner banner-hide status action target target-clear progress point live live-clear notice preview permission permission-clear done stop-ack focus-input voice-text voice-error quit`

`preview` 的字段（0.29.0 起）：`{path, caption, x, y, follow, ms}`。`x/y` 是 Node 侧算好的落点（停靠面板旁、或 `previewCorner` 选的四角/自定义点，已夹在虚拟桌面内）；`follow: 'card'` 表示"交给浮层算"——浮层按自己卡片的 `Left/Top/ActualWidth/Height` 取左右空的一侧再夹取，所以卡片改尺寸时预览不会脱开。两条路径都关不掉"预览在控制窗口关闭时也显示"这一点：`previewRect()` 不再要求 `docked !== null`。

overlay 回传的事件（`presence.js` 的 `#handleLine`）：`ready snapshot stop dock-toggle pause-toggle pause-ready pause-failed hotkey hotkey-failed voice resized reply permission closed`。

**保留、当前没人发/没人收**（改协议时别以为它们在跑）：
- `glow-dock` / `glow-dock-clear`：让光带给停靠窗口让位，但 `index.js` 从不调用——用户要求"光带挡住面板也可以"，这段是死代码；
- `quit`：`presence.stop()` 直接 kill 进程，不发消息；
- `show` 的 `card:false` 分支：`presence.show()` 从不带 `card` 字段（策略在 Node 侧就拦掉了）；
- `pause-ready`：浮层会发，插件没有监听它（只监听 `pause-failed`）。

**效果开关两头都拦**：Node 侧 `presence.setPolicy(effects)` 在 `show/notice/banner/preview/glowOnly/point/target` 前面做 `allows()` 判断（少重启浮层）；同时把策略合并成一条 `{type:'policy', glow, card, banner, preview, target, clickPoint, notice}` 发给运行中的浮层，浮层收到就把对应窗口收起/恢复。**只做 Node 侧是不够的**：`show` 曾经把卡片和光带绑在一起（`Set-CardVisible $true`），关掉 `effectGlow` 后卡片一出现光带又亮了，看起来就是开关失效。加新的可见消息时，两处都要接：`presence.js` 的 `allows()` 判断 + `overlay.ps1` 的 `policy` 分支。

## 四、pause 走两条路

1. **index 侧**：`ACTING_OPS = {click, drag, scroll, type, key, uiact, focus}`，命中就抛 `PausedError`，模型看到的是"已拒绝 + 恢复方式"。
2. **host 侧**：`applyPauseState` 会同时给 host 发 `{op:'pause'}`，让真正注入输入的那层也拒绝。两边都拦，是因为模型可能重试、而热键注册可能失败。

三个入口（全局热键 / `/pause` 命令 / `computer_paused` 工具）都汇到 `applyPauseState()`（`index.js` 第 490 行），保证卡片、状态条、host 三处不会各说各话。

## 五、落盘的东西（都在 `%DSH_HOME%`，默认 `C:\Users\<你>\.dsh`）

| 文件 | 谁写 | 用途 |
| --- | --- | --- |
| `computer-use-start.json` | `apply()` 开头 | **版本证据**：`version/tool/at/pid/unknownKeys/schemaProbe` |
| `computer-use-commands.json` | `/pause` 注册处 | 记录命令面板注册过什么 |
| `computer-use-card.json` | 用户拖过卡片尺寸后 | 下次恢复卡片大小 |
| `computer-use-journal.md` | `computer_progress` | 长任务进度，断了可读回来续 |
| `%TEMP%\dsh-computer-use-dock.json` | `dockSelf` / `undockSelf` | 停靠前窗口的位置，崩溃后下次启动还能还原 |

## 六、改动地图：想改什么，改哪里

| 想做的事 | 改这里 | 别忘了 |
| --- | --- | --- |
| 加一个配置项 | `index.js` 的 `Config`（第 238 行）+ `resolveSettings`（第 295 行）夹取 + `KNOWN_SETTINGS`（第 101 行） | 必须 `.volatile()`；否则设置页改了不生效。再决定要不要进设置页 |
| 让它在设置页出现 | `client.js` 的 `Panel`（第 143 行起五个 `group`）加一行 `ToggleRow/NumberRow/TextRow/SelectRow` | `form.mutate([{op:'set',path:[name],value}])`，一次一键，无保存按钮 |
| 加一个可见效果 | `presence.js` 加方法 + `#policy` 键 + `allows()` 判断；`overlay.ps1` 加消息分支；`resolveEffects` 加开关 | 纯净模式要能一键灭掉它 |
| 加一个工具 | `index.js` 里 `ctx.tools.register({name: \`${TOOL_PREFIX}xxx\`, …})` | 要动的工具要进 `ACTING_OPS`；参数要自己校验（注册表不校验原始 schema，见 `integerArg`） |
| 加一个 host 能力 | `scripts/host.ps1` 的 `switch ($op)` 加分支 | 文件必须保持 UTF-8 **BOM** |
| 改插件列表里的名字/描述 | `locale/zh.json`、`locale/en.json` 的 `meta.title` / `meta.description` | 名字来自 locale，不是 package.json |
| 改详情页 | `docs/DETAIL.md`（英文）、`docs/DETAIL.zh.md`（中文） | 路径写在 locale 的 `meta.detail` |
| 改图标 | `icon.svg`（手绘矢量，不经过生图） | 生图默认带"AI生成"水印，别用 |
| 改版本 | 只改 `package.json` 的 `version` | 启动戳会重新读它；文档里的版本号顺手一起改 |

## 七、性能基线（2026-11-22 实测：脚本直连 `host.ps1` 连发 25 次请求，0 失败）

| 操作 | 耗时 |
| --- | --- |
| helper 启动（Add-Type + ready 握手） | 402 ms |
| `cursor` / `windowrect` | 0.2 ms |
| `key`（单键） | 15.4 ms |
| pointer move | 30.9 ms |
| `click` | 62.9 ms |
| `screenshot`（全屏 → PNG） | 141 ms |

端到端（模型 → 工具 → 屏幕）一次动作约 3 s，其中插件本身只占 ~60 ms，其余是模型与编排开销。**插件不是瓶颈，截图次数才是成本来源**——这也是"先 look 再 ocr 最后 screenshot"的原因。

## 八、五个坑（都真踩过）

1. **PowerShell 脚本必须有 BOM**。没有 BOM → Windows PowerShell 5.1 按 GBK 解析，中文字面量直接把解析器打崩，症状是"helper 起不来"或整轮助手进程全废。检查：前三个字节 `EF BB BF`（命令见 `docs/MAINTENANCE.md` 第二节）。
2. **ESM 模块缓存按路径**。改完 `index.js` 只做 `disable → enable` 有可能拿到旧模块，所以要确认启动戳里的 `version`/`at` 变了才算真重载。
3. **浏览器半边的模块图要重发布**。`client.js` 是 link 安装的新客户端模块，第一次不会自己进图——表现是**点开插件页看不到设置表单**（列表行上并没有一个叫「配置」的按钮，别去找这两个字）。当时的解法是开关另一个客户端插件（`dsh-pet`）触发重新发布；`ctrl+r` 在打包版里不可靠，重启 App 最干净。
4. **`plugins.bundle.config` 没有 `form` prop**。想放一个能存的表单，只能用 `plugins.row.config`，键是 `<包名>#<行 id>`（这里是 `dsh-computer-use-windows#computer-use-windows`），拿到的是 `form.state`（含 `revision` 栅栏）和 `form.mutate`。
5. **`maxImageWidth` 不是随便调的数**。1596 是 38×42（模型 patch 网格）的整数倍，改成 1600 之类会让图被重新切，白花钱。

## 九、已知缺口（下一轮可以捡）

| 缺口 | 说明 |
| --- | --- |
| `anchor` 定位的是"文字"，不是"行" | 点击原点是该行文字的左边与垂直中心。同一行右侧的开关如果和文字不在同一条基线上（插件页里开关对齐的是标题，标题又常被 OCR 漏掉，只能拿说明文字当锚），`dy` 要按开关自己的基线补——实测**差 5 px 就点空**，而且行本身不可点，看起来像"点击没生效"。稳妥做法：先 `button:"move"`，看结果里的 `screen (x, y)` 落在哪，再决定 `dy` |
| 换颜色/换暂停热键要等浮层重启 | `presence.setAccent` / `setPauseHotkey` 只改内存里的**启动参数**，源码注释写明 "picks it up on its next start"。设置页改完，正在跑的浮层仍是旧颜色/旧热键，浮层进程退出后下次才应用 |
| 悬浮卡片不参与点击穿透 | 停靠模式下面板会自动让开（`panelHandle()`），悬浮卡片没有这一步 |
| 没有细粒度授权 | 只有全局暂停 + `approval` 三档，"允许点击但不许按键"没做 |
| 设置页文案硬编码中文 | `client.js` 没用 `ctx.locale.register` |
| 暂停不拦 `files` / `clipboard` 写 | `ACTING_OPS` 只含输入类。暂停时 `computer_files` 的 delete/move 仍会执行（有确认卡片兜底，但语义上不算"暂停"） |

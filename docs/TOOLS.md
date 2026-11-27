# 工具清单（v0.30.0）

19 个 `computer_*` 工具，全部在 `index.js` 里用 `ctx.tools.register` 注册，名字前缀是常量 `TOOL_PREFIX = 'computer_'`。
「参数」列只列常用项，完整 schema 以运行时的工具定义为准；「暂停时」列说明 `Ctrl+Alt+Q` 暂停后还能不能用。

暂停只拦**输入类**：`index.js` 里 `ACTING_OPS = { click, drag, scroll, type, key, uiact, focus }`。其余（读、OCR、文件、剪贴板）不受暂停影响。

## 一、看（先试这些，别一上来就截图）

| 工具 | 作用 | 常用参数 | 成本 | 暂停时 |
| --- | --- | --- | --- | --- |
| `computer_look` | 首选观察方式：列 UI 自动化控件树（路径/类型/名字/可用动作/坐标），树太薄时自动退到 OCR，再退到截图 | `window` 句柄、`depth`(6)、`limit`(60)、`image: auto\|always\|never`、`ocr: auto\|never` | 控件树是文字，最便宜；`image:"always"` 才花钱 | 可用（只读） |
| `computer_ocr` | 系统 OCR，按行返回文字 + **物理屏幕坐标**（可直接配 `space:"screen"` 点击） | `window`、区域 `x/y/width/height`、`lang`、`scale`(1–3) | ≈15 token/行，`ocrMaxLines` 截断（默认 60 行）；`scale` 放大后再识别，坐标已除回原比例 | 可用 |
| `computer_screenshot` | 拍桌面或单个窗口 | `monitor`、`window` | 1596×868 ≈ **1.8k token**；像素没变时只回一行字（`dedupeShots`） | 可用 |
| `computer_zoom` | 只放大一块区域，返回原生分辨率；放大后的图就是下一次点击的坐标系 | `x/y/width/height`、`window`、`space` | 与面积成正比（834×111 ≈ 100 token） | 可用 |
| `computer_monitors` | 列出显示器：序号、是否主屏、屏幕范围 | — | 极小 | 可用 |
| `computer_windows` | 列出可见顶层窗口：句柄、标题、进程、范围 | — | 每窗一行 | 可用 |
| `computer_wait` | 等界面稳定，而不是截图轮询：`element` 等控件出现/消失、`stable` 等画面不再变、`pixel` 等某区域变/不变 | `mode`、`name`、`state`、`x/y/width/height`、`timeoutMs`、`threshold` | 成功时几乎免费 | 可用 |

> 观察顺序的经验值：`look` → 控件少于 `uiaMinControls`（3）个或完全没有 → `ocr` → 读出的行少于 `ocrFallbackLines`（6）→ 才 `screenshot`。

## 二、动（暂停时全部拒绝）

| 工具 | 作用 | 常用参数 | 备注 |
| --- | --- | --- | --- |
| `computer_click` | 移动指针并点击；`button: move` 只移动不按。**小控件、重复控件用 `target` 或 `anchor`**，不要用坐标 | `x, y`、`target`（`{text/role/path/window}`，按控件名点它的中心）、`anchor`（该行的文字）、`dx/dy`（相对文字**中心**/垂直中心的偏移）、`match`、`button`、`clicks`、`space`、`allow_stale` | 坐标空间写错会**被拒绝**（越界不夹取）；超过 `coordinateTtlMs`（默认 15 s）的图会被拒绝，确认没动就传 `allow_stale:true`；纯坐标会**吸附**到附近唯一控件的中心；`target`/`anchor` 命中 0 个或多个都报错并列出候选；结果给出**实测落点 + 命中 + 是否重试**，画面没变化会额外提示 |
| `computer_drag` | 按住拖到另一点 | `from_x/from_y/to_x/to_y`、`button`、`space` | 选文字、拉分隔条、拖文件；结果里带 `命中（拖动起点）：…` |
| `computer_scroll` | 在当前指针位置或指定点滚动 | `direction`、`amount`(1–30)、`x/y`、`space` | — |
| `computer_type` | 往控件写文字；给 `window`+`path` 时走 UIA 直接写，**不抢焦点、不动指针** | `text`、`window`、`path`、`mode: append\|replace`、`snapshot`、`submit` | 中文/Unicode 走剪贴板粘贴；`submit` 需要焦点 |
| `computer_key` | 按一个键或组合键 | `spec`（`ctrl+shift+s`、`enter`、`f5`）、`repeat`(1–20) | 快捷键优先于点菜单 |
| `computer_ui` | 按控件路径操作：`list/invoke/select/toggle/expand/focus/value/click` | `action`、`path`、`window`、`snapshot`、`value`、`depth`、`limit` | 传 `snapshot` 时路径过期会 **STALE_REF** 拒绝，而不是点到替身控件上 |
| `computer_focus_window` | 把某个窗口提到前台 | `handle` | 输入前常用 |
| `computer_sequence` | 一次执行最多 24 个已想好的步骤，最后只拍一张图 | `steps[{action: click/drag/scroll/type/key/focus/wait, …}]`、`capture`、`window` | 中途失败就停在失败步并说明是哪一步；比逐步调用省掉十几次截图。**每个 click/drag 步骤各自带自己那一行 `命中：…`**（一步一行，不合并） |

### 「落点 / 命中」那两行（0.28.0 起）

点击、移动指针（`button:"move"`）、拖拽起点之后，结果里会说明这一下到底落在哪：

```
Clicked left at target Button「保存」 = screen (268, 211).
落点 (268, 211)；命中：Text「保存」 in 「记事本」
```

- **落点**是点击后 `GetCursorPos` 的**实测值**，不是请求值：窗口拒绝移动、显示器边界、系统吸边都会让它与请求不同。
- **命中**取自 UI Automation 的 `ElementFromPoint`，**在动作之后取**：菜单、浮层、焦点都是这一下才出现的。
- 落点不在目标矩形内会写 `⚠ 落点 … 不在目标矩形 … 内`；点到插件自己的浮层会单独提示；画面指纹前后一致会写「这一小块画面没有变化」。
- 吸附发生时多一行 `吸附到 Button「小」 中心（-16, +0）`——说明你给的坐标被拉到了控件中心。
- `target`/`anchor` 的落点核对用的是**目标矩形**，所以它比纯坐标多一层保证；纯坐标只有在吸附成功时才有矩形可核。

## 三、重复/小控件：用 target 或 anchor，不要用坐标

一屏 20 个一模一样的开关时，坐标只差几个像素就是另一个插件——这是真实踩过的坑（插件页里点错行）。0.28.0 起优先按名字点：

```
computer_click { target: { text: "保存", role: "Button" } }     # 控件树里唯一命中 → 点它的矩形中心
computer_click { anchor: "dsh-pet", dx: 910 }                  # 没有 UIA（canvas/网页截图）时按 OCR 行点
```

规则：

1. `target` 在**控件树**里按名字找（`text` 子串、可选 `role`、或精确 `path`），点 `BoundingRectangle` 的中心；同名按钮与它的文字会一起命中，**优先取可交互容器**，真正多个独立候选才拒绝并列出；
2. `anchor` 走 OCR（在最后截图的窗口里找，或 `window: 0` 找整屏），原点是行文字的**中心**（0.28.0 之前是左缘，会系统性偏左半个字）；
2. 命中 **0 行** → 报错，并把该窗口读到的前 5 行贴出来，说明"这个目标没有可读文字，改用 computer_look 或截图坐标"；
3. 命中 **多行** → 报错，把候选逐行列出，让你用更长的文字或 `match` 指定——**不会替你选第一行**；
4. 候选行会先用 UIA 探一下"这一行文字位置上压着的是什么"：`[0] 控件 Button「放大」 @2330,103` 是控件（Button/MenuItem/Hyperlink/CheckBox/RadioButton/TabItem/ComboBox/Edit），`[1] 文本 Text「放大」 @…` 是正文/容器（Text/Document/Pane/Group/Custom），`[2] 其他 …` 是其余类型，`未取到` 表示这一行没探到。**排序规则是控件在前、文本在后，`[i]` 就是 `match` 的编号**——所以正文里出现同一句话时，`match:0` 会更可能落在按钮上而不是聊天记录里（Chromium 类应用有时把一个按钮仍报成 `Group`，那时就只能按原顺序排，这是已知边界）；
5. 探测失败（超时、没有 UIA）就退回 OCR 的原顺序，不报错——**"多行必须拒绝"这条规则在两种情况下都不变**；
6. `computer_sequence` 的 click 步骤支持同样的 `anchor/dx/dy/match`，所以批量里也不会因为坐标漂移点错行。

没有文字可认的重复图标（工具栏）：先用 `computer_look` 拿 UIA 路径，用 `computer_ui` 按控件名操作；两条路都走不通时，明确告诉用户"这两个目标无法区分"，而不是猜一个。

## 四、文件、剪贴板与状态

| 工具 | 作用 | 常用参数 | 暂停时 |
| --- | --- | --- | --- |
| `computer_files` | `list/read/copy/move/mkdir/delete/download`；读文件前几 KB、下载 URL 到本地 | `action`、`path`、`to`、`recursive`、`overwrite`、`url` | 可用（`delete/move/overwrite` 需要用户确认卡片） |
| `computer_clipboard` | 读/写系统剪贴板 | `action: get\|set`、`text` | 可用 |
| `computer_progress` | 上报长任务进度：浮窗显示 `[3/8] 正在…`，并追加到 `%DSH_HOME%/computer-use-journal.md` | `step`、`total`、`label` | 可用 |
| `computer_paused` | 读/切暂停开关 | `action: status\|pause\|resume` | 可用（它就是管这个的；`resume` 只应在用户明确说继续时用） |

## 五、成本速查

| 动作 | 量级 |
| --- | --- |
| 一张默认截图（1596 宽） | ≈1.8k token |
| 一次 OCR（满 60 行） | ≈0.9k token |
| 控件树（`look`，20 个控件） | ≈0.3–0.6k token |
| 一次 `zoom`（834×111） | ≈0.1k token |
| 一次 `ui/windows/monitors/wait` | 几十到几百 token |

改大 `maxImageWidth` 只会更贵：1596 正好贴模型的 patch 网格（38×42）。要看细节请用 `computer_zoom`，别整屏重拍。

## 六、返回值的统一形状

- 观察类工具最后都渲染成一段**文字摘要**（有的附图片卡片）；`computer_files` 的读文件返回前几 KB 文本。
- 出错时带稳定的错误码前缀：`DESKTOP_HELPER_*`（PowerShell 那层）、`STALE_REF`（快照过期）、暂停中的拒绝信息（含恢复方式）。
- `computer_sequence` 失败时会指出**第几步**失败，并把该步的 `space`/坐标一并回显，方便判断是"点错了"还是"空间写错了"。
- 动作类结果的第一行永远是"做了什么、落在哪个屏幕点"，之后**另起一行**给 `命中：…`（点击/移动/拖拽起点各一行）；两者不合并，这样"坐标对了但打到别的东西上"一眼就能看出来。
- OCR 结果的第一行说明语言、行数与是否放大（`（放大 ×2 后识别，坐标已除回原比例）` / `（放大失败，按原尺寸识别）`），之后每行是 `「文字」  @x,y 宽×高`（物理屏幕像素）。

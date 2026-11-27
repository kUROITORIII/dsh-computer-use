# 更新与维护手册

给"下一次要改它"的人。按顺序做，别跳。

## 〇、改之前先留一份可回滚的东西

这个项目踩过一次真实的坑：一次错误的文本替换把 `index.js` 写成乱码，而当时最近的备份是一个月前的版本，最后只能重建。规则很简单：

| 规则 | 说明 |
| --- | --- |
| 什么时候做 | **改 `.js` / `.ps1` 之前一次、发版之后一次**；只改文档可以跳过 |
| 怎么留 | 用 git：先 `git status` 确认干净，改完 `git commit`；发版打 tag（见第四节）。没有 git 就整目录复制一份，名字带版本号 |
| 留完自检 | `node --check` 四个 `.js` 全过、两个 `.ps1` 都能被 `Parser::ParseFile` 解析、`index.js` 的 sha256 记下来 |
| 保留 | 当前版 + 上一版；更老的按需清，判据是"回滚时真的会用到" |

## 一、每次改动前的 30 秒

```powershell
$repo = 'C:\path\to\dsh-computer-use-windows'   # 换成你的克隆路径

git status --short            # 工作区应该是干净的
Get-Content "$env:DSH_HOME\computer-use-start.json"   # 现在是哪一版在跑
```

## 二、改完必做的静态检查

```powershell
$repo = 'C:\path\to\dsh-computer-use-windows'

# JS 语法
foreach ($f in 'index.js','host.js','presence.js','client.js') { node --check "$repo\$f" }

# PowerShell 语法
foreach ($f in 'host.ps1','overlay.ps1') {
  $e = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile("$repo\scripts\$f", [ref]$null, [ref]$e)
  if ($e) { "$f : $($e[0].Message)" } else { "$f : PARSE_OK" }
}

# BOM 检查：两个 .ps1 的前 3 字节必须是 EF BB BF
# 缺 BOM 时 PowerShell 5.1 会按本地代码页读中文 → 乱码，甚至整段解析失败
foreach ($f in 'host.ps1','overlay.ps1') {
  $b = [System.IO.File]::ReadAllBytes("$repo\scripts\$f")[0..2]
  '{0}: {1}' -f $f, (($b | ForEach-Object { $_.ToString('X2') }) -join ' ')
}

# 文档链接
npm run check
```

> 很多编辑器/工具在保存时会剥掉 BOM。改完 `.ps1` 一定回头跑上面的 BOM 检查；补 BOM 用 `[System.IO.File]::WriteAllText($path, $text, [System.Text.UTF8Encoding]::new($true))`。

## 三、让改动真的生效

| 改了什么 | 怎么生效 | 怎么证明 |
| --- | --- | --- |
| 只改 `docs/` / `README.md` | 立即 | — |
| 改 `index.js` / `host.js` / `presence.js` / `scripts/*.ps1` / `package.json` | 插件页把 **DSH-Computer-Use** 那一行关掉再打开；改 `package.json` 时把 `version` 一起 +1 更可靠 | `computer-use-start.json` 的 `at` 变了、`version` 变成新号 |
| 改 `client.js`（设置页） | 同上，并且浏览器半边模块图要重新发布 | 进插件自己的页面能看到设置表单 |

- **ESM 按路径缓存**：只调一次 `disable → enable` 有时会拿到旧模块，所以改代码时顺手改版本号。
- **客户端模块图**：link 安装的新客户端模块第一次不一定自己进图，表现是**点开插件页看不到设置表单**。触发办法是切一下另一个客户端插件，或者**重启 DSH**（最干净）。
- 设置页里改值**不需要**重载：`.volatile()` 字段走 `loader/volatile-update`，下一次操作就用新值。但 `accent`（颜色）和 `pauseHotkey` 是浮层的**启动参数**，要等浮层进程重启。

## 四、发版清单

1. `package.json` 的 `version` +1（唯一来源）。
2. `docs/CHANGELOG.md` 顶部加一行：改了什么、为什么、怎么验证的（带数字）。
3. 改了行为就同步 `docs/SETTINGS.md` / `docs/TOOLS.md` / `docs/ARCHITECTURE.md` 里受影响的描述。
4. 关→开插件行，`computer-use-start.json` 的 `version` 是新号且 `unknownKeys` 为 `[]`。
5. 设置页五个分组都在，拨一个开关再拨回去。
6. `git commit` → `git tag -a vX.Y.Z -m "..."` → `git push` + `git push --tags`，在 GitHub 上写 Release。

## 五、验证：怎么确认"它真的能用"

| 要证明的事 | 最省的做法 |
| --- | --- |
| 工具注册上了 | 任意只读工具（`computer_windows`）能返回结果 |
| helper 起来了 | 第一次观察类调用 < 1 s；`Get-Process powershell` 里能看到两个进程 |
| 浮层活着 | 调一次会画光带的动作，看屏幕四周 |
| 暂停有效 | 按 `Ctrl+Alt+Q` 后调一个 `computer_click`，应被拒绝；再按一次恢复 |
| 设置页生效 | 把 `effectGlow` 关掉，再调动作类工具，光带不出现 |
| 纯净模式 | 开 `cleanMode` 做一次点击：无光带/无卡片/无落点，且会话窗口没被缩 |
| 停靠还原 | `windowMode: dock` 做一次动作，回合结束后窗口回原位 |
| 截图落盘 | 截一张图，`%TEMP%\dsh-computer-use\shots` 里多一个 `screen-*.png` |

## 六、故障速查

| 症状 | 先查 | 常见原因 |
| --- | --- | --- |
| 工具全不见了 | 插件页那一行是不是关着；profile 的 `bundles` 里还有没有这个包 | 被停用 / profile 没装 |
| 点开插件页没有设置表单 | 浏览器半边有没有进模块图 | 见第三节，重启 DSH |
| 设置页空白 / 一直"正在读取配置…" | `client.js` 是否被加载；插件是否 enabled | 从插件自己的页面进入 |
| 改了配置没反应 | `computer-use-start.json` 的 `unknownKeys` | 键名拼错会被静默忽略并记录 |
| 改代码没生效 | 启动戳的 `at` / `version` | ESM 缓存，见第三节 |
| helper 起不来 | `scripts/host.ps1` 的 BOM；`node` 版本 | 缺 BOM → 解析崩；启动超时 20 s |
| 光带不亮 | `cleanMode`、`effectGlow`、`effectSurface` | 纯净模式赢过一切；`cleanMode:true` / `effectSurface:false` 会强制 float 并熄灭全部效果 |
| 会话窗口没缩到角落 | `windowMode` 是不是 `float` | 总开关关闭时强制 float |
| 暂停按了没反应 | `pauseHotkey` 是否被别的软件占用 | 热键注册失败会 `console.warn`，此时 `/pause` 仍有效 |
| 点到了错误的地方 | 坐标空间：`space:"image"` vs `"screen"` | OCR/UIA 的 `@x,y` 是物理像素，必须 `space:"screen"` |
| 点击"位置全错" | 重载后是否还没截图 | 重载会清空截图缓存，先 `computer_screenshot` |
| 颜色/暂停热键改了没变 | 浮层进程是否重启过 | 两者都是启动参数 |

## 七、回滚

```powershell
git log --oneline -5          # 找到要回去的那个提交
git checkout <sha> -- .       # 或者 git revert <sha>
# 然后插件页关→开，确认 computer-use-start.json 的 version 回到旧号
```

## 八、仓库里哪些目录是本地用的

| 路径 | 进仓库？ | 内容 |
| --- | --- | --- |
| `dev/` | 否（`.gitignore`） | 开发笔记、旧评测、事故记录、历史快照 |
| `.lab/` | 否 | 实验脚本与截图（采样像素、量耗时、验证光带、点击试验台） |
| `tools/` | 是 | 只有一个 `check-docs.cjs`：查文档相对链接，`npm run check` 跑它 |

`package.json` 的 `files` 是白名单，`dev/` 和 `.lab/` 本来就不会进 npm 包；提交前用 `git status` 再看一眼有没有意外加进去的东西。

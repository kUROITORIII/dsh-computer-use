# 可选：用 CLI 驱动有源码的软件

这份文档描述一条**和本插件无关、但常常更省事**的路线：把有源码的桌面软件变成一组命令行工具，让模型用命令操作它，而不是截屏找按钮。

- 上游项目：[HKUDS/CLI-Anything](https://github.com/HKUDS/CLI-Anything)（MIT）
- 注册表：[CLI-Hub](https://clianything.cc/)
- 本文只解释「什么时候换这条路」和「怎么装」，**不复制上游代码**，也不承诺它的版本。

## 什么时候该换

| 情况 | 建议 |
| --- | --- |
| 目标软件有源码，或 CLI-Hub 里已有它的 harness（Blender、GIMP、LibreOffice、OBS、drawio…） | 优先 CLI：确定、可测、输出 `--json`，几乎不烧截图 token |
| 只有编译好的商业软件（微信、Photoshop、某些驱动面板） | 用本插件（像素 + 控件树） |
| 网页应用 | 浏览器自动化，两边都不合适 |
| 一次性点几下就完事 | 用本插件，装 harness 不划算 |

两者的分工不是替代关系：本插件是「能看见就能点」的通用手；CLI harness 是「有源码就能精确调」的专业手。

## 怎么装（Windows）

```powershell
# 1. Python 3.10+（WindowsApps 下那个是商店占位符，不算）
python --version
python -m pip --version

# 2. 注册表/包管理器
python -m pip install --user cli-anything-hub

# 3. 找、看、装
cli-hub list
cli-hub search blender
cli-hub info blender
cli-hub install blender
```

装完会多一个 `cli-anything-<app>` 命令：

```powershell
cli-anything-blender --help          # 先看它有什么命令
cli-anything-blender --json ...      # 给程序读的结构化输出
cli-anything-blender                 # 进 REPL（有状态：项目、撤销/重做）
```

已知的两个 Windows 小坑：

- `cli-hub` 可能装在 `%APPDATA%\Python\Python312\Scripts`，不在 PATH 上，用全路径调用；
- 调它之前设 `$env:PYTHONUTF8='1'`，否则它打印 `✓` 之类符号会在 GBK 控制台抛 `UnicodeEncodeError`。

## 怎么判断装好了

1. `Get-Command cli-anything-<app>` 有路径；
2. `cli-anything-<app> --json <命令>` 的输出能被 `ConvertFrom-Json` 解析；
3. 跑它自带的 `python -m pytest`（有测试的话）全绿；
4. 做一件真事并检查产物：PDF 以 `%PDF-` 开头、PNG 能解码、视频时长对得上。

## 为什么不在本仓库里打包它

- 它是第三方项目（有自己的作者、版本、许可），本仓库只该指路；
- 它会引入 Python + pip + harness 三层外部依赖，而本插件只依赖 PowerShell；
- 两条路线互不依赖：装不装 CLI，本插件的 19 个工具行为都不变。

## 生成自己的 harness（进阶）

上游的 `cli-anything-plugin/HARNESS.md` 是一份可复用的方法论（分析源码 → 设计命令 → 实现 CLI → 测试 → 文档 → 发布），核心几条：

- **必须调真实软件**：不能用 Pillow 顶替 GIMP、不能自己写渲染器顶替 Blender；
- **渲染鸿沟**：只改项目文件、用简化导出器，特效会被静默丢掉；
- **输出验证**：退出码 0 不等于成功，要验魔术字节、结构、像素或时长。

在 DSH 里没有 `/cli-anything` 斜杠命令，等价做法是克隆上游仓库、把 `HARNESS.md` 当 SOP 自己按阶段推进。

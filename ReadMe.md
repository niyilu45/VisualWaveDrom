# VisualWaveDrom

VisualWaveDrom 是一个本地 WaveDrom 波形编辑器，支持多张波形图、波形目录、连接线、分组、说明文字和单图编辑。服务模式与直接打开 HTML 模式统一使用标准 SQLite 波形库。

## 快速开始

推荐双击 `VisualWaveDrom.bat` 使用服务模式。默认打开：

```text
http://127.0.0.1:4173/VisualWaveDrom.html
```

端口 `4173` 已被其他程序占用时会自动选择空闲端口；同一工程的服务已经运行时会直接复用。运行服务模式需要安装 Node.js，并确保 `node` 命令可用。

HTML 文件名和默认波形库只需在 BAT 顶部配置：

```bat
set "HTML_FILE_NAME=VisualWaveDrom.html"
set "WAVE_LIBRARY_RELATIVE_PATH=Wave\VisualWaveDrom-library\library.sqlite"
```

路径以 BAT 所在目录为基准。工程整体复制到其他磁盘或电脑后，只要内部相对路径不变，就不需要修改绝对路径。关闭全部页面后，本地服务和 BAT 窗口会自动退出。

## 两种运行模式

### 服务模式

`VisualWaveDrom.js` 直接读写磁盘上的 SQLite 文件。

- 目录页只查询波形摘要，打开某张图时才读取该图的完整 JSON。
- 修改波形时只更新对应数据库记录；目录和归属关系使用同一事务保存。
- SQLite 使用索引、事务和 WAL，单张波形损坏不会阻止其他图读取。
- 每次写入保留波形修订号，用于发现完整页面与单图页面之间的同步冲突。
- 功能菜单中的“导入波形库”用于切换 `Wave` 下不同的波形库文件夹。

这是大型波形库、自动保存和 Word 单图链接的推荐模式。

### 直接打开 HTML

直接双击 `VisualWaveDrom.html` 不需要 Node.js。页面会加载随项目提供的 SQLite WebAssembly 运行文件。

- “导入波形库”可选择 `.sqlite`、`.db`、`.vwdlib`，也兼容旧完整库 `.json`。
- “保存波形库”始终下载标准 `.sqlite` 文件。
- 编辑中的 SQLite 快照保存在浏览器 IndexedDB，刷新页面后会自动恢复。
- 浏览器安全限制不允许网页静默覆盖用户选择的原文件，因此需要点击“保存波形库”下载更新后的文件。
- 只发送 HTML 文件不会携带浏览器中的波形；共享时应同时发送导出的 SQLite 文件和 `inc` 目录。

## SQLite 波形库

`Wave` 是波形库根目录。每个一级子文件夹是一套独立波形库，文件夹名称就是界面中的库名称：

```text
Wave\
├─ VisualWaveDrom-library\
│  └─ library.sqlite
└─ OtherLibrary\
   └─ library.sqlite
```

一个 `library.sqlite` 包含：

- 每张波形图的 WaveDrom JSON、标题缓存、说明和修订号。
- 多级波形目录、显示顺序和波形归属关系。
- 当前编辑波形图、当前选择目录和永久 `libraryId`。

SQLite 虽然是单文件，但会使用数据库页和索引按需读取，不需要像单个巨大 JSON 那样先解析全部波形。服务端修改单图时也不重写整个库。

### 旧库自动迁移

启动服务时会自动识别以下旧格式：

- `Wave\ProjectA.json`：旧完整单文件库。
- `Wave\ProjectA\library.json` 与 `documents\*.json`：旧拆分库。

迁移结果写入 `Wave\ProjectA\library.sqlite`。旧 JSON 文件和 `documents` 文件夹会保留，不会自动删除或覆盖。确认 SQLite 库无误后，可自行归档旧文件。

## 波形库转换

根目录的 `WaveLibraryConverter.exe` 支持 SQLite 与完整 JSON 双向转换，并可直接读取旧拆分库。

| 输入 | 输出命令 | 典型用途 |
| --- | --- | --- |
| 完整库 JSON | `to-sqlite` | 升级旧工程 |
| 旧拆分库目录或 `library.json` | `to-sqlite` | 升级早期 `speed` 库 |
| SQLite 波形库 | `to-json` | 交给只支持旧 JSON 的版本 |

转换会保留目录、多级标题、归属关系、显示顺序、当前选择、波形内部名称和 `libraryId`。写入前会校验每张波形 JSON 和重复名称。

### 双击和拖放

双击 `WaveLibraryConverter.exe` 后拖入源路径，或直接把源文件、旧拆分库文件夹拖到 EXE 图标上：

- JSON 或旧拆分目录会自动转成 SQLite。
- SQLite 会自动导出成完整 JSON。
- 目标已存在时不会直接覆盖；交互窗口会要求输入大写 `YES`。

### 命令行

```bat
WaveLibraryConverter.exe to-sqlite <完整库.json|旧拆分库> [输出.sqlite] [--force]
WaveLibraryConverter.exe to-json <波形库.sqlite> [输出.json] [--force]
WaveLibraryConverter.exe verify <SQLite|完整JSON|旧拆分库>
```

`--force` 或 `-f` 允许覆盖目标，适合已确认路径的自动化脚本。路径含空格时应使用双引号。

旧的 `unpack` 和 `pack` 命令仍保留，仅用于旧完整 JSON 与旧拆分 JSON 之间转换；新工程应使用 SQLite 命令。

### 示例一：完整 JSON 转 SQLite

```bat
WaveLibraryConverter.exe verify "Wave\ProjectA.json"
WaveLibraryConverter.exe to-sqlite "Wave\ProjectA.json" "Wave\ProjectA\library.sqlite"
WaveLibraryConverter.exe verify "Wave\ProjectA\library.sqlite"
```

然后把 BAT 顶部改为：

```bat
set "WAVE_LIBRARY_RELATIVE_PATH=Wave\ProjectA\library.sqlite"
```

### 示例二：旧拆分库转 SQLite

```bat
WaveLibraryConverter.exe to-sqlite "Wave\ProjectA" "Wave\ProjectA\library.sqlite"
WaveLibraryConverter.exe verify "Wave\ProjectA\library.sqlite"
```

也可以把 `Wave\ProjectA\library.json` 作为输入，结果相同。

### 示例三：SQLite 反向导出 JSON

```bat
WaveLibraryConverter.exe to-json "Wave\ProjectA\library.sqlite" "Wave\ProjectA-export.json"
WaveLibraryConverter.exe verify "Wave\ProjectA-export.json"
```

### 往返校验

```bat
WaveLibraryConverter.exe to-json "Wave\ProjectA\library.sqlite" "Wave\ProjectA-roundtrip.json"
WaveLibraryConverter.exe to-sqlite "Wave\ProjectA-roundtrip.json" "Wave\ProjectA-roundtrip\library.sqlite"
WaveLibraryConverter.exe verify "Wave\ProjectA-roundtrip\library.sqlite"
```

## 迁移和共享

1. 服务模式下，复制整个 `Wave` 文件夹即可携带全部波形库。
2. 纯 HTML 模式下，点击“保存波形库”下载当前 `.sqlite` 文件。
3. 在另一台电脑上通过“导入波形库”选择该 SQLite 文件。
4. 重要修改后建议保留一份关闭服务后复制的 `library.sqlite` 备份。

## Word 带链接截图和单图模式

每张波形图卡片都提供“复制图片到剪贴板”按钮。点击后可以选择：

- “仅复制图片”：复制不带链接的 PNG。
- “复制带链接截图”：同时复制 PNG、Word 可识别的 HTML 图片链接和纯文本链接。
- “仅复制链接”：只复制该波形图的单图链接。

完整波形库中的每张波形图还提供“单独打开”按钮。点击后会在新窗口或新标签页打开与 Word 超链接相同的单图页面，只渲染目标波形图，编辑结果仍会定向写回当前波形库。

带链接截图仍然不包含波形图下方的 `description` 说明。粘贴到 Word 后，点击图片会通过为当前波形库注册的 `visualwavedrom-…://` 链接打开目标波形图。单图页面隐藏波形目录和其他波形图，但保留工具栏和 JSON 编辑区；修改有效 JSON 后会自动定向写回原波形库中的同一张图，不改变其他波形、目录关系或排列顺序。

服务模式会为波形库和波形图补充永久 ID，并使用版本号防止两个页面静默覆盖同一张图。同一浏览器中同时打开完整波形库和单图页面时，保存后会自动刷新另一页面；若两边同时存在未保存修改，会提示同步冲突。

### 第一次在新电脑使用 Word 链接

1. 保持 Word、VisualWaveDrom 和波形库之间的相对目录结构不变。
2. 在新电脑上先正常双击一次 `VisualWaveDrom.bat`。
3. BAT 会在当前用户范围自动注册波形库专用链接协议，不需要管理员权限；不同工程可以同时保留各自的 Word 链接。
4. 此后点击 Word 中的带链接图片，即使服务没有运行，也会自动启动 BAT、打开服务并进入对应单图页面。

注册信息中会记录当前 BAT 的绝对位置。项目整体移动到新位置后，重新双击一次新位置中的 BAT 即可更新注册信息。直接打开 HTML 的模式受浏览器权限限制，不能通过 Word 链接自动写回原始波形库。

## 波形目录和波形图

左侧“波形目录”用于组织多张波形图。

- 根目录的 `+` 可新增目录标题。
- 可创建多级目录。
- “新增波形图”会在当前选中目录下创建空波形图；未选中目录时会放在根目录。
- 目录内可包含多张波形图。
- 点击目录中的波形图标题会打开该图进行编辑，当前编辑图会以高亮边框显示。
- 波形图卡片提供删除和移动操作。
- 移动时，在弹出的目录列表中直接单击目标标题即可完成移动。
- 删除目录时，目录中的波形图和子目录会提升到上一级目录。

## 撤销和重做

工具栏的撤销/重做，以及 `Ctrl+Z` / `Ctrl+Shift+Z`，支持：

- JSON 与波形编辑。
- 新增、删除、移动信号行。
- 新增、删除分组。
- 新增、删除、移动波形图。
- 新增、删除目录和子目录。
- 将波形图收录或移动到其他目录。

删除波形图后可立即撤销，恢复原波形内容和原目录位置。

## 编辑波形

右侧工具栏提供信号行、波形符号、分组、连接线和缩放工具。

### 信号行

- 新增行会创建可选中的空信号行。
- 单击信号名称可编辑名称。
- 可上移、下移、删除信号行。
- 选中一行后，点击波形符号可写入或插入波形字符。
- 工具栏造成波形 JSON 变化后会自动格式化 JSON。

### 数据标签

数据格式字符 `2` 到 `9` 以及 `=` 可对应 `data` 数组中的文字。

- 即使初始没有文字，单击数据格也可以输入数据标签。
- `4444` 表示四个独立数据格，可分别编辑四个标签。
- `4...` 表示一个延续数据格，点击 `4` 或后续的 `.` 编辑同一个标签。
- 输入数据标签后按 Enter 保存。

### 分组

1. 点击“分组”。
2. 在波形区依次选择起始行和结束行；起止行可以相同。
3. 新分组会写入 WaveDrom 的嵌套 `signal` 数组，支持多级分组。

单击分组标签可选中分组；双击分组标签可修改文字。选中分组后使用删除按钮只会删除分组标签，波形行会保留。

### 连接线

1. 点击“新增连接”。
2. 在波形边沿依次选择起点和终点。
3. 选择箭头样式并填写可选标签。
4. 点击样式即可生成连接线。

连接线写入 WaveDrom JSON 的 `edge` 字段。选中已有连接线后可修改样式、标签或删除。

### 波形说明

每张波形图可使用顶层 `description` 字段保存说明文字。

- 说明框位于波形图卡片底部。
- 仅当前编辑中的波形图可编辑说明。
- 说明编辑框支持换行；点击“完成”保存。
- 说明内容较长时，波形区域支持滚动查看。

## JSON 面板

JSON 面板标题栏中的“隐藏”按钮可以直接隐藏 WaveDrom JSON 编辑窗口；隐藏后可通过功能菜单中的“显示 JSON”恢复。显示状态会保存到浏览器本地设置中。

功能菜单中的“添加列号”按 `Off → Tick → Tock → Off` 循环：`Tick` 写入 `head.tick`，在列边界显示编号；`Tock` 写入 `head.tock`，在列中间显示编号。首次启用默认从 `0` 开始，切换模式时保留已有起始编号，并支持撤销和重做。

JSON 面板提供格式化和导出功能。JSON 解析失败时，错误行左侧会显示 `×`。

## Vim 模式

功能菜单中的“Vim 模式”用于开启或关闭波形区域的键盘操作，开关状态会保存在浏览器中。“Vim 模式说明”按钮或 `?` 可打开完整使用手册。Vim 只在当前编辑波形图的波形区域内生效；单击目录、工具栏、JSON 或说明区后，按键恢复为这些区域的普通操作。底部状态栏会显示当前模式、是否聚焦波形、数字前缀和等待中的组合键。

### 波形和信号行

- `h`、`j`、`k`、`l`：移动波形光标；支持数字前缀，例如 `5l`。
- `w`、`b`：跳到后一个或前一个波形变化点；`0`、`$`、`gg`、`G` 跳到边界。
- `v`：按波形格选择；`V`：按信号行选择；`o` 交换可视选择起点和终点。
- `y`、`p`、`x`：复制、覆盖粘贴、删除选中的波形格。
- `r` 后输入一个波形字符执行一次替换；`R` 进入连续替换，按 `Esc` 退出；`|` 可以直接把当前选中位置替换为间隔。
- `i`：进入波形插入模式；输入波形字符会在当前格前插入并向后移动。数据格插入在已有文本前时，`data` 会自动插入 `"."` 占位，按 `Esc` 退出。
- `t`：当前选中内容可编辑时，直接打开数据、分组或连接标签输入框。
- `yy`、`dd`：复制或删除当前信号行。复制行不会复制连接端点使用的 `node` 字段。
- `o`、`O`：在当前行后方或前方插入空白信号行。
- `[r`、`]r`：上移或下移信号行；可使用数字前缀指定移动数量。
- 可视行模式下按 `Space`、`g`，可将选中的连续信号行建立为分组。

### 生效范围和其他操作

- 不再提供区域切换组合键；目录、工具栏、JSON 和说明区不使用 Vim。
- Vim 开启时，JSON 编辑器只作只读显示，不能获得编辑光标或选择代码；关闭 Vim 后恢复普通编辑。
- `Space`、`a`：在波形区域开始新增连接；`Space`、`c`：选择已有连接线。
- `u`、`Ctrl+r`：使用 VisualWaveDrom 的统一历史记录撤销和重做；`.` 重复最近一次可重复修改。

### 命令行

按 `:` 打开命令行。打开波形图时只输入目录中的自动编号，不输入标题，例如：

```vim
:open 1.2
```

常用命令还包括 `:w` 保存波形库、`:format` 格式化 JSON、`:json` 显示或隐藏 JSON、`:nav` 显示或隐藏目录、`:new` 新建波形图、`:debug` 切换调试模式、`:noh` 清除高亮，以及 `:set vim` / `:set novim`。

## 调试模式

功能菜单可以打开 Debug Mode，并复制调试日志。

调试日志用于定位点击、数据标签、分组标签、连接线和波形库操作问题。提交问题时，请附上复制出的完整日志，以及所使用的 SQLite 波形库或兼容 JSON（如可公开）。

## 文件说明

```text
VisualWaveDrom.html      主页面
VisualWaveDrom.js        本地服务
VisualWaveDrom.bat       Windows 双击启动入口
inc/                     页面样式、应用逻辑和依赖库
inc/sqlite/              SQLite 官方 Windows 与 WebAssembly 运行文件
inc/visualwavedrom-vim.js Vim 键盘控制器
Wave/                    多个 SQLite 波形库及旧版兼容 JSON
WaveLibraryConverter.exe SQLite 与兼容 JSON 双向转换工具
WaveLibraryConverter-README.md 转换器简明说明
tools/WaveLibraryConverter/ 转换器源码和构建脚本
```

`Wave/default.json` 仅作为旧版默认波形模板和首次建库的兜底来源。服务模式的日常数据保存在 `Wave\<波形库名称>\library.sqlite`；旧 `library.json`、`documents\` 和根目录单文件库仅用于兼容与迁移。

## 常见问题

### 为什么复制 HTML 后看不到我的波形？

直接打开 HTML 时，SQLite 快照保存在当前浏览器的 IndexedDB 中，不会嵌入 HTML。请使用“保存波形库”导出 `.sqlite` 文件，或使用服务模式并复制 `Wave` 文件夹。

### 为什么无法选择任意路径自动保存？

浏览器安全策略不允许纯 HTML 任意写入本机文件。服务模式将数据固定写入项目的 `Wave` 文件夹，以便可靠备份和迁移。

### 为什么同一个数据格只显示一个标签？

`4...` 是一个延续数据格；需要多个独立标签时，请使用多个数据字符，例如 `4444`。

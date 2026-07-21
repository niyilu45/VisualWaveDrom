# WaveLibraryConverter

`WaveLibraryConverter.exe` 用于在以下两种 VisualWaveDrom 波形库格式之间转换：

- **master 单文件库**：全部目录、波形和关系保存在一个 JSON 文件中。
- **speed 拆分库**：`library.json` 保存目录和索引，`documents/*.json` 每个文件保存一张 WaveDrom 波形。

## 最简单的用法

双击 `WaveLibraryConverter.exe`，然后把源 JSON 文件或拆分库目录拖入窗口。

也可以直接把以下内容拖到 EXE 文件上：

- master 波形库 JSON：自动拆分成 speed 波形库。
- speed 拆分库目录或其中的 `library.json`：自动合并成 master 波形库。

工具默认不会覆盖已有文件。需要覆盖时，交互窗口会要求输入大写 `YES`。

## 命令行

```bat
WaveLibraryConverter.exe unpack Wave\old-library.json Wave\new-library
WaveLibraryConverter.exe pack Wave\new-library Wave\old-library.json
WaveLibraryConverter.exe verify Wave\new-library
```

自动化脚本需要覆盖输出时添加 `--force`：

```bat
WaveLibraryConverter.exe unpack source.json target-folder --force
```

## speed 拆分库结构

```text
Wave\VisualWaveDrom-library\
├─ library.json
└─ documents\
   ├─ wave-one-xxxxxxxxxx.json
   ├─ wave-two-xxxxxxxxxx.json
   └─ ...
```

波形文件使用内部稳定名称和哈希命名。修改波形 `title` 不会改变文件名。

`speed` 分支启动时默认读取 `Wave\VisualWaveDrom-library\library.json`。如果该拆分库尚不存在、但同级存在旧的 `Wave\VisualWaveDrom-library.json`，服务会自动生成拆分库，同时保留原文件不变。

`Wave` 下可以放置多个拆分库，每个库必须使用独立的一级文件夹：

```text
Wave\LibraryA\library.json
Wave\LibraryA\documents\*.json
Wave\LibraryB\library.json
Wave\LibraryB\documents\*.json
```

文件夹名称作为波形库名称显示在选择窗口中。

服务启动时也会自动识别 `Wave` 根目录中的旧单文件库，将其复制拆分到同名文件夹；旧文件不会删除或覆盖。

## 安全说明

- 转换前会完整校验所有波形 JSON；任何一张无效都会停止转换。
- 输出先写入临时位置，完成后再替换目标。
- 拆分库中的文件路径会进行越界检查。
- 建议保留原始波形库备份，确认转换结果后再删除旧文件。

转换器源码和编译脚本位于 `tools\WaveLibraryConverter\`。

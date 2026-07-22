# WaveLibraryConverter

`WaveLibraryConverter.exe` 用于在 VisualWaveDrom SQLite 波形库与旧完整 JSON 之间双向转换，也能直接升级旧拆分 JSON 波形库。

## 支持格式

- 当前格式：`Wave\<库名称>\library.sqlite`。
- 旧完整库：一个 `.json` 文件包含目录、归属关系和全部波形。
- 旧拆分库：`library.json` 保存清单，`documents\*.json` 每个文件保存一张波形。

转换会保留 `libraryId`、多级目录、波形归属、显示顺序、当前选择和每张波形的内部名称。写入前会校验所有波形 JSON。

## 最简单用法

双击 `WaveLibraryConverter.exe`，然后拖入源文件或旧拆分库目录；也可以直接把源路径拖到 EXE 图标上。

- 输入 JSON 或旧拆分目录：自动生成 SQLite。
- 输入 SQLite：自动导出完整 JSON。
- 默认不覆盖已有目标；交互模式下输入大写 `YES` 才会覆盖。

转换器需要与项目的 `inc\sqlite\sqlite3.exe` 保持相对位置，不要只把 EXE 单独移走。

## 命令行

```bat
WaveLibraryConverter.exe to-sqlite <完整库.json|旧拆分库> [输出.sqlite] [--force]
WaveLibraryConverter.exe to-json <波形库.sqlite> [输出.json] [--force]
WaveLibraryConverter.exe verify <SQLite|完整JSON|旧拆分库>
```

`--force` 或 `-f` 允许覆盖目标。路径中有空格时需要使用双引号。

旧的 `unpack` 与 `pack` 命令仍保留，用于旧完整 JSON 和旧拆分 JSON 之间转换。

## 双向示例

完整 JSON 转 SQLite：

```bat
WaveLibraryConverter.exe to-sqlite "Wave\ProjectA.json" "Wave\ProjectA\library.sqlite"
WaveLibraryConverter.exe verify "Wave\ProjectA\library.sqlite"
```

旧拆分库转 SQLite：

```bat
WaveLibraryConverter.exe to-sqlite "Wave\ProjectA" "Wave\ProjectA\library.sqlite"
```

SQLite 导出完整 JSON：

```bat
WaveLibraryConverter.exe to-json "Wave\ProjectA\library.sqlite" "Wave\ProjectA-export.json"
WaveLibraryConverter.exe verify "Wave\ProjectA-export.json"
```

## 服务自动迁移

服务启动时会识别 `Wave\ProjectA.json` 或 `Wave\ProjectA\library.json`，生成 `Wave\ProjectA\library.sqlite`。旧文件不会删除。需要自定义输出路径、反向导出或批量转换时再使用本工具。

## 安全说明

- 输出先写入同目录临时文件，校验成功后再替换目标。
- 旧拆分库的逐图文件路径会进行越界检查。
- 建议保留源库备份，确认波形数量和目录关系后再归档旧文件。

源码和构建脚本位于 `tools\WaveLibraryConverter\`。

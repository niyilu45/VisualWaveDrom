# VisualWaveDrom 快速上手

按顺序完成一张图，再按需要导入数据、打开示波器。**每段 GIF 展示实际操作，旁边的图解只标注这一步用到的 2～4 处，不再罗列全部按钮。** 蓝色编号是图内短注，GIF 橙框表示当前操作位置。

[从零绘制](#first-wave) · [等差填充](#wave-fill) · [复制粘贴](#copy-long-wave) · [导入数据](#import-data) · [示波器](#scope-hands-on) · [完整说明](ReadMe.md)

<a id="start"></a>
## 1. 启动

保留完整工具目录。Windows 双击 `VisualWaveDrom.bat`；Linux 在工具目录执行 `bash VisualWaveDrom.sh`。浏览器打开后，编辑期间不要关闭启动窗口。

以下演示使用独立的 `QuickStartDemo` 示例库，不含个人数据。右侧菜单可以左右分列，也可以分页；GIF 中会出现这两种布局，按钮功能相同。

<a id="first-wave"></a>
## 2. 创建一张波形图

1. 左侧点 **新增波形图**，新图自带 `clk`、`signal` 两行，并自动进入编辑状态。
2. 点 **文本编辑**，再单击新图标题，输入名称后按 `Enter`。
3. 再点文本编辑退出。蓝框表示当前操作的图。

![GIF：点击新增波形图，查看初始模板，再编辑标题并确认](ReadMeFig/quickstart-create-wave.gif)

![本步骤图解：只标出新增波形图和当前图的编辑状态](ReadMeFig/quickstart-step-create.png)

## 3. 新增行并命名

1. 单击 `signal` 行，再点 **新增行**，空行插在它的下方；未选中行时加到末尾。
2. 开启 **文本编辑**，单击空行左侧的空白名称区，输入 `data`，回车确认。
3. 同样把 `signal` 改为 `valid`，然后退出文本编辑。

![GIF：选中 signal 后新增空行，命名 data，再把 signal 改名为 valid](ReadMeFig/quickstart-add-row.gif)

![本步骤图解：新增行、文本编辑和空白信号名输入位置](ReadMeFig/quickstart-step-add-row.png)

<a id="draw-wave"></a>
## 4. 绘制电平和数据波形

1. 保持 **修改模式**。单击 `valid` 的目标格，再点 `0` 或 `1`，绘制低、高电平。
2. 单击 `data` 行，开 **画笔模式**，选择数据类型 `=`，依次点 8 个格子。
3. 点 **退出画笔**。本例得到 8 个独立的数据段。

![GIF：点选格子修改高低电平，再用画笔逐格画出八个独立数据段](ReadMeFig/quickstart-draw-wave.gif)

![本步骤图解：画笔、数据类型等号和逐格绘制的位置](ReadMeFig/quickstart-step-draw.png)

**注意：** 这里要逐格点画。拖选多格后一次替换为数据类型，会合并成一段，不适合下面的逐项等差填充。`4...` 是一段，`4444` 是四段。

<a id="multiline-data"></a>
## 5. 填写数据文字

按 `t` 或点 **文本编辑**，再单击数据段输入文字。`Enter` 确认，`Alt+Enter` 换行，`Esc` 取消。多行文字只增高这一条信号行。

![GIF：单击数据标签输入 CMD，按 Alt+Enter 换行并确认](ReadMeFig/quickstart-data-text.gif)

<a id="wave-fill"></a>
## 6. 等差推理填充

1. 在第 4 节的 8 个数据段中，前两格分别填 `D01`、`D03`，然后退出文本编辑。
2. 拖选这两格，按住选区**右下角的小填充柄**，向右拖到第 8 格。
3. 松开后得到 `D05、D07……D15`。`Ctrl+Z` 可一次撤销。

![GIF：输入 D01 D03，拖选前两格，再拖动填充柄生成 D05 到 D15，并演示撤销和重做](ReadMeFig/quickstart-infer-series.gif)

![本步骤图解：等差起始值、右下角填充柄和待填充的虚线区域](ReadMeFig/quickstart-step-infer.png)

原选区必须都是数据波形；虚线区只更新**已有数据段的文字**，不会把 `0`、`1`、`x` 或空白自动改成数据波形。更多规则见[推理填充说明](ReadMe.md#wave-fill)。

<a id="wave-hands-on"></a>
## 7. 双击按住，选择候选波形

退出文本编辑、画笔和连接选点模式。在同一格上，**第一下点按松开，第二下按住约半秒**，弹出候选菜单。松开后选一种波形；点菜单外或按 `Esc` 取消。

![GIF：双击第二下按住弹出候选波形，再选择高电平替换目标格](ReadMeFig/quickstart-wave-candidates.gif)

普通双击或默认按键 `q` 只在本分类内循环切换。没弹菜单时，检查 **设置 → 波形分类器** 是否开启。

<a id="copy-long-wave"></a>
## 8. 复制、粘贴一长段

1. 在源行按住左键向右拖选，松开后按 `Ctrl+C`。
2. 单击目标行的起始格，按 `Ctrl+V`；也可用菜单中的 **复制波形 / 粘贴波形**。
3. 从目标格开始覆盖后续格子，数据文字一起复制，目标信号名不变。

![GIF：在较长的示例图中拖选十四格，复制并覆盖粘贴到 copy_to 行](ReadMeFig/quickstart-wave-copy.gif)

这段 GIF 使用较长的独立示例。选中多行也能复制，保留行列关系；可跨图粘贴。粘贴错了按 `Ctrl+Z`。

## 9. 新增连接

点 **新增连接**，依次选两格之间的起点、终点边沿，默认生成直线箭头。选完后按 `t` 输入标签，例如 `delay=2`，回车确认。

![GIF：选 valid 起点和 data 终点，按 t 输入 delay 等于二的连接标签](ReadMeFig/quickstart-add-connection.gif)

![本步骤图解：新增连接按钮与连接标签输入后的显示位置](ReadMeFig/quickstart-step-connection.png)

<a id="save"></a>
## 10. 保存波形库

点 **功能菜单 → 保存波形库**，等待保存完成。要保留原库、另存副本时点 **波形库另存为**。改完文字、切换图或退出编辑框，都不等于已经正式保存。

![GIF：切换功能菜单，点击保存波形库并等待保存成功](ReadMeFig/quickstart-save-wave.gif)

![本步骤图解：保存当前库和另存为副本两个按钮](ReadMeFig/quickstart-step-save.png)

备份或交付时复制对应 `.sqlite` 文件，不是只发 HTML。需要静态图片时，点图框 **复制图片到剪贴板**，按 Word / PPT / Markdown 用途选择格式。

<a id="import-data"></a>
<a id="import-hands-on"></a>
## 11. 导入一个数据文件

需通过 BAT / SH 启动，本机有可用的 Python。

1. **功能菜单 → 导入波形数据**，选择文件；也可粘贴路径后点 **读取路径**，Linux 同样适用。
2. 等待前 5 行和推荐预设出现，填写信号名。第一列确实是序号时才勾选 **包含序号**。
3. 点 **生成预览**，核对后点 **确认导入**。

![GIF：读取单列 TXT，命名 sample，检查自动编号和预览，然后确认导入](ReadMeFig/quickstart-import-single.gif)

![本步骤图解：文件路径、序号勾选、生成预览和确认导入](ReadMeFig/quickstart-step-import-single.png)

单列数据不勾序号，自动从 0 编号；复数会拆成 `_I`、`_Q` 两路。导入后还需 **保存波形库**。

<a id="collection-hands-on"></a>
## 12. 导入波形数据预设集合

1. 打开 **导入波形数据预设集合**，填**数据文件夹**，选择预设 JSON 或粘贴其路径后 **读取预设**。
2. 填写自动提取的变量，本例 `idx=0`；点 **搜索数据**。
3. 展开 TXT 核对内容。CSV 选择序号列、勾选所需信号；有需要再填写各列过滤条件并应用预览。
4. 核对后点 **确定导入**。保存预设可记住解析选择，保存波形库才正式保存导入结果。

![GIF：选择目录和预设，搜索 capture 与 CSV 文件，展开内容、选择序号列并批量导入](ReadMeFig/quickstart-import-collection.gif)

![本步骤图解：数据文件夹、预设 JSON 路径和搜索数据按钮](ReadMeFig/quickstart-step-import-collection.png)

![本步骤图解：CSV 序号列、信号勾选和确认导入按钮](ReadMeFig/quickstart-step-import-table.png)

不要把**数据文件夹**与**预设目录/文件**互换。需要编写预设时看[批量预设示例](ReadMe.md#import-batch)，这里不展开全部配置。

<a id="scope-hands-on"></a>
## 13. 示波器：缩放和游标

导入完成后，点击这张图框上的 **示波器**。

1. 点 **A**、在图上定位；再用 **B** 设置另一端，底部 `B-A` 显示距离。点 **适应游标** 放大两者之间。
2. 再点 A / B 取消选中，左键拖出选区，按 `z` 或点 **适应选区**。
3. 点行尾 **总线** 打开卡片，按需改成 **模拟**；小数采样核对浮点类型。点 **适应窗口** 恢复全范围。

![GIF：设置 AB、适应游标、框选后按 z，再切换模拟显示](ReadMeFig/quickstart-scope-operation.gif)

![本步骤图解：选择游标、适应游标和适应选区](ReadMeFig/quickstart-step-scope.png)

只查看不用保存。编辑后要保留时，先点示波器的 **保存修改** 或 **保存为展示实例**，再回主界面 **保存波形库**。

<a id="timing-series"></a>
## 14. 时延检查中的等差补全（按需）

这与第 6 节的拖动填充不同：时延检查是**只读展开预览**。例如数据为 `0、2、4、|、58`，已知步长为 2，可补出 `6、8……56`。

1. 功能菜单点 **显示 JSON**，将当前图替换为下面的小示例。
2. 点击 **时延检查**，选左侧 `data` 查看推算依据。
3. 点 **全部展开** 对照原序列。展开结果不会自动写回原图。

```json
{
  "signal": [{ "name": "data", "wave": "222|2", "data": ["0", "2", "4", "58"] }]
}
```

![GIF：准备带省略号的数据序列，打开时延检查，查看等差补全与原序列参考](ReadMeFig/quickstart-timing-series.gif)

![本步骤图解：逐行结果、推算依据和原序列展开按钮](ReadMeFig/quickstart-step-timing.png)

## 继续使用

[完整功能手册](ReadMe.md) · [目录管理](ReadMe.md#directory) · [参数表](ReadMe.md#parameter-matrix) · [演讲者模式](ReadMe.md#presenter) · [Vim 手册](ReadMe.md#vim) · [常见问题](ReadMe.md#troubleshooting)

点文字没反应时，先确认这张图处于编辑状态，再开启文本编辑。保存失败时先保留网页和未保存内容，确认服务仍在运行，不要急着刷新。

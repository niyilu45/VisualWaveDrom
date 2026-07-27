from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
FIGURE_DIR = ROOT / "ReadMeFig"
SOURCE_SIZE = (1280, 720)
SCREEN_SIZE = (960, 540)
HEADER_HEIGHT = 58
OUTPUT_SIZE = (SCREEN_SIZE[0], SCREEN_SIZE[1] + HEADER_HEIGHT)
SCALE = SCREEN_SIZE[0] / SOURCE_SIZE[0]
ACCENT = (250, 204, 21, 255)
BLUE = (96, 165, 250, 255)
RESAMPLING = getattr(Image, "Resampling", Image)
QUANTIZE = getattr(Image, "Quantize", Image)
DITHER = getattr(Image, "Dither", Image)


def frame(source, caption, rectangles=(), clicks=()):
    return {
        "source": source,
        "caption": caption,
        "rectangles": rectangles,
        "clicks": clicks,
    }


STEPS = [
    {
        "output": "01-start-service.gif",
        "frames": [
            frame("01-start-service.png", "双击 VisualWaveDrom.bat 启动服务"),
            frame("01-start-service.png", "浏览器自动打开，等待波形库名称出现", [(1060, 176, 1268, 220)]),
            frame("01-start-service.png", "左侧是波形目录", [(0, 0, 243, 720)]),
            frame("01-start-service.png", "中间上方显示波形图", [(244, 40, 1060, 384)]),
            frame("01-start-service.png", "中间下方显示当前波形的 JSON", [(244, 383, 1060, 720)]),
            frame("01-start-service.png", "右侧是功能菜单和波形菜单", [(1060, 0, 1279, 720)]),
            frame("01-start-service.png", "启动完成，可以开始编辑"),
        ],
    },
    {
        "output": "02-new-wave-template.gif",
        "frames": [
            frame("01-start-service.png", "起始：当前波形库已经打开"),
            frame("01-start-service.png", "点击左上角“新增波形图”", [(10, 118, 230, 155)], [(120, 136)]),
            frame("02-new-wave-template.png", "目录中出现自动编号的新图", [(24, 278, 218, 316)]),
            frame("02-new-wave-template.png", "新图保持原位置并自动进入编辑状态", [(245, 130, 1022, 360)]),
            frame("02-new-wave-template.png", "初始模板包含 clk 和 signal 两行", [(272, 188, 675, 294)]),
            frame("02-new-wave-template.png", "JSON 区域已经切换到新图", [(245, 383, 1048, 718)]),
            frame("02-new-wave-template.png", "完成：可以直接修改初始模板"),
        ],
    },
    {
        "output": "03-edit-title-signals.gif",
        "frames": [
            frame("02-new-wave-template.png", "起始：打开刚创建的模板"),
            frame("03-edit-title-signals.png", "在右侧菜单中开启“文本编辑”模式", [(1060, 70, 1279, 610)]),
            frame("03-edit-title-signals.png", "单击波形框标题，输入“SPI 写时序”", [(246, 130, 520, 170)], [(390, 150)]),
            frame("03-edit-title-signals.png", "波形图内部标题同步更新", [(420, 185, 610, 230)]),
            frame("03-edit-title-signals.png", "依次把信号名改为 sclk 和 mosi", [(270, 225, 330, 294)], [(301, 245), (301, 277)]),
            frame("03-edit-title-signals.png", "目录中的波形名称跟随 title 更新", [(24, 278, 216, 316)]),
            frame("03-edit-title-signals.png", "JSON 中的 title、head 和 name 同步变化", [(280, 425, 620, 625)]),
        ],
    },
    {
        "output": "04-paint-waveform.gif",
        "frames": [
            frame("03-edit-title-signals.png", "起始：选中需要修改的信号行"),
            frame("04-paint-waveform.png", "点击“画笔模式”并保持画笔开启", [(1070, 192, 1256, 251)], [(1120, 220)]),
            frame("04-paint-waveform.png", "在波形按钮中选择需要的符号", [(1070, 344, 1258, 575)], [(1166, 363)]),
            frame("04-paint-waveform.png", "连续单击 sclk 行中的目标格子", [(314, 202, 665, 260)], [(410, 230), (490, 230), (570, 230)]),
            frame("04-paint-waveform.png", "继续绘制 mosi，不会自动退出画笔", [(314, 252, 665, 294)], [(485, 275), (575, 275)]),
            frame("04-paint-waveform.png", "对应 wave 字段同步变化并自动格式化", [(286, 465, 1040, 530)]),
            frame("04-paint-waveform.png", "完成：点击“退出画笔”结束连续绘制", [(1162, 192, 1256, 251)], [(1210, 220)]),
        ],
    },
    {
        "output": "05-data-labels.gif",
        "frames": [
            frame("04-paint-waveform.png", "起始：准备增加 data 信号行"),
            frame("05-data-labels.png", "点击“新增行”，并把信号名改为 data", [(1070, 32, 1256, 73)], [(1117, 52)]),
            frame("05-data-labels.png", "选择数据、数据2、数据3等波形按钮", [(1070, 425, 1258, 665)]),
            frame("05-data-labels.png", "在 data 行画出多个独立数据段", [(314, 255, 645, 294)], [(344, 276), (392, 276), (525, 276)]),
            frame("05-data-labels.png", "开启文本编辑后，单击数据段输入文字", [(1070, 340, 1256, 380), (314, 255, 370, 294)], [(344, 276)]),
            frame("05-data-labels.png", "依次填写 CMD、ADDR、DATA", [(314, 255, 645, 294)]),
            frame("05-data-labels.png", "wave 与 data 数组保持顺序对应", [(286, 452, 470, 610)]),
            frame("05-data-labels.png", "完成：数据波形与文字作为整体处理"),
        ],
    },
    {
        "output": "06-group-signals.gif",
        "frames": [
            frame("05-data-labels.png", "起始：准备把三条信号建立为一组"),
            frame("06-group-signals.png", "点击右侧“分组”按钮", [(1070, 232, 1256, 274)], [(1162, 253)]),
            frame("06-group-signals.png", "依次选择起始行和结束行", [(286, 202, 670, 290)], [(320, 214), (320, 276)]),
            frame("06-group-signals.png", "输入分组名“SPI 总线”并确认", [(262, 200, 294, 292)], [(280, 246)]),
            frame("06-group-signals.png", "左侧出现分组括号和竖排标签", [(262, 200, 298, 292)]),
            frame("06-group-signals.png", "JSON 的 signal 中形成嵌套分组", [(286, 420, 470, 620)]),
            frame("06-group-signals.png", "完成：分组标签可继续编辑或单独删除"),
        ],
    },
    {
        "output": "07-add-connection.gif",
        "frames": [
            frame("06-group-signals.png", "起始：准备建立信号间连接"),
            frame("07-add-connection.png", "点击“新增连接”进入选点模式", [(1070, 366, 1162, 426)], [(1116, 397)]),
            frame("07-add-connection.png", "先选择连接线起点", [(372, 201, 402, 232)], [(386, 216)]),
            frame("07-add-connection.png", "再选择连接线终点", [(488, 228, 518, 263)], [(503, 247)]),
            frame("07-add-connection.png", "选择箭头和实线、虚线、折线或曲线", [(1070, 470, 1257, 714)]),
            frame("07-add-connection.png", "连接线和“采样”标签出现在波形中", [(372, 200, 520, 264)]),
            frame("07-add-connection.png", "edge 字段同步保存连接关系", [(296, 575, 430, 625)]),
            frame("07-add-connection.png", "完成：选中连接线后可继续修改属性"),
        ],
    },
    {
        "output": "08-edit-description.gif",
        "frames": [
            frame("07-add-connection.png", "起始：确认当前波形图处于编辑状态"),
            frame("08-edit-description.png", "单击波形图下方的说明框", [(258, 302, 680, 384)], [(350, 350)]),
            frame("08-edit-description.png", "在说明框中输入第一行文字", [(274, 344, 615, 383)]),
            frame("08-edit-description.png", "按 Enter 换行并继续输入", [(274, 344, 615, 383)], [(420, 374)]),
            frame("08-edit-description.png", "点击右上角“完成”保存并退出", [(618, 314, 669, 347)], [(644, 331)]),
            frame("08-edit-description.png", "description 字段保留换行内容", [(288, 605, 800, 647)]),
            frame("08-edit-description.png", "完成：说明在波形图内独立显示"),
        ],
    },
    {
        "output": "09-organize-directory.gif",
        "frames": [
            frame("08-edit-description.png", "起始：波形图仍位于根目录"),
            frame("09-organize-directory.png", "点击根目录右侧的加号", [(178, 218, 222, 246)], [(209, 226)]),
            frame("09-organize-directory.png", "输入目录名“接口时序”", [(38, 244, 207, 280)]),
            frame("09-organize-directory.png", "点击波形图右侧的移动按钮", [(202, 278, 224, 318)], [(214, 298)]),
            frame("09-organize-directory.png", "在目标列表中单击“接口时序”"),
            frame("09-organize-directory.png", "目录与波形自动编号为 1. 和 1.1", [(38, 244, 208, 318)]),
            frame("09-organize-directory.png", "波形框标题同步显示目录编号", [(246, 210, 1024, 255)]),
            frame("09-organize-directory.png", "完成：点击目录波形可定位且不改变顺序"),
        ],
    },
    {
        "output": "10-save-and-share.gif",
        "frames": [
            frame("09-organize-directory.png", "起始：所有编辑内容已经准备完成"),
            frame("10-save-and-share.png", "点击右侧“保存波形库”", [(1060, 259, 1267, 304)], [(1162, 282)]),
            frame("10-save-and-share.png", "绿色状态显示波形库已经保存", [(820, 383, 1058, 424)]),
            frame("10-save-and-share.png", "点击卡片上的按钮可复制图片到剪贴板", [(724, 218, 862, 250)], [(792, 234)]),
            frame("10-save-and-share.png", "复制时可选择图片、带链接截图或纯链接", [(724, 218, 862, 250)]),
            frame("10-save-and-share.png", "点击“单独打开”可只编辑当前波形", [(906, 218, 976, 250)], [(942, 234)]),
            frame("10-save-and-share.png", "SQLite 文件可随整个工程一起备份和分享"),
            frame("10-save-and-share.png", "完成：可以安全关闭页面"),
        ],
    },
]


def load_font(size, bold=False):
    names = [
        "C:/Windows/Fonts/msyhbd.ttc" if bold else "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/simhei.ttf",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/System/Library/Fonts/PingFang.ttc",
    ]
    for name in names:
        if Path(name).exists():
            return ImageFont.truetype(name, size)
    return ImageFont.load_default()


def fit_font(draw, text, maximum_width):
    for size in range(24, 15, -1):
        font = load_font(size, bold=True)
        if draw.textbbox((0, 0), text, font=font)[2] <= maximum_width:
            return font
    return load_font(15, bold=True)


def scaled_rectangle(rectangle):
    left, top, right, bottom = rectangle
    return (
        round(left * SCALE),
        round(top * SCALE) + HEADER_HEIGHT,
        round(right * SCALE),
        round(bottom * SCALE) + HEADER_HEIGHT,
    )


def draw_click(draw, point):
    x = round(point[0] * SCALE)
    y = round(point[1] * SCALE) + HEADER_HEIGHT
    draw.ellipse((x - 15, y - 15, x + 15, y + 15), outline=ACCENT, width=4)
    draw.ellipse((x - 5, y - 5, x + 5, y + 5), fill=(255, 255, 255, 255), outline=(17, 24, 39, 255), width=2)


def render_frame(step_number, frame_index, total_frames, definition):
    screenshot = Image.open(FIGURE_DIR / definition["source"]).convert("RGB")
    if screenshot.size != SOURCE_SIZE:
        raise ValueError(f"{definition['source']} must be {SOURCE_SIZE[0]}x{SOURCE_SIZE[1]}")
    screenshot = screenshot.resize(SCREEN_SIZE, RESAMPLING.LANCZOS)

    canvas = Image.new("RGBA", OUTPUT_SIZE, (17, 24, 39, 255))
    canvas.paste(screenshot, (0, HEADER_HEIGHT))
    overlay = Image.new("RGBA", OUTPUT_SIZE, (0, 0, 0, 0))
    overlay_draw = ImageDraw.Draw(overlay)
    for rectangle in definition["rectangles"]:
        target = scaled_rectangle(rectangle)
        overlay_draw.rectangle(target, fill=(250, 204, 21, 32), outline=ACCENT, width=4)
    for point in definition["clicks"]:
        draw_click(overlay_draw, point)
    canvas = Image.alpha_composite(canvas, overlay)

    draw = ImageDraw.Draw(canvas)
    step_font = load_font(18, bold=True)
    caption_font = fit_font(draw, definition["caption"], 705)
    progress_font = load_font(16)
    draw.rounded_rectangle((14, 12, 103, 46), radius=6, fill=(37, 99, 235, 255))
    draw.text((26, 17), f"第 {step_number} 步", font=step_font, fill=(255, 255, 255, 255))
    draw.text((120, 13), definition["caption"], font=caption_font, fill=(248, 250, 252, 255))
    progress = f"{frame_index}/{total_frames}"
    progress_width = draw.textbbox((0, 0), progress, font=progress_font)[2]
    draw.text((OUTPUT_SIZE[0] - progress_width - 18, 18), progress, font=progress_font, fill=BLUE)
    return canvas.convert("RGB")


def save_gif(step_number, definition):
    frames = [
        render_frame(step_number, index, len(definition["frames"]), item)
        for index, item in enumerate(definition["frames"], start=1)
    ]
    paletted = [
        item.quantize(colors=128, method=QUANTIZE.MEDIANCUT, dither=DITHER.FLOYDSTEINBERG)
        for item in frames
    ]
    durations = [1100] * len(paletted)
    durations[0] = 1400
    durations[-1] = 1800
    paletted[0].save(
        FIGURE_DIR / definition["output"],
        save_all=True,
        append_images=paletted[1:],
        duration=durations,
        loop=0,
        optimize=True,
        disposal=1,
    )


def main():
    for step_number, definition in enumerate(STEPS, start=1):
        save_gif(step_number, definition)
        print(f"generated {definition['output']}: {len(definition['frames'])} key frames")


if __name__ == "__main__":
    main()

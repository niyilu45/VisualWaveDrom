(function (global) {
  'use strict';

  const WORKER_URL = 'inc/visualwavedrom-scope-worker.js?v=20260731-scope-v16';
  const DEFAULT_ROW_HEIGHT = 42;
  const MIN_ANALOG_ROW_HEIGHT = 28;
  const MAX_ANALOG_ROW_HEIGHT = 480;
  const FULL_RESOLUTION_TARGET_LIMIT = 2000;
  const LARGE_WAVE_TARGET_POINTS = 1000;
  const AXIS_HEIGHT = 38;
  const OVERVIEW_HEIGHT = 76;
  const MAX_HISTORY = 100;
  const CURSOR_HIT_RADIUS = 10;
  const COLOR_PRESETS = [
    { name: '绿色', value: '#07853d' },
    { name: '青色', value: '#0097a7' },
    { name: '橙色', value: '#d66b00' },
    { name: '洋红', value: '#cf2f7b' },
    { name: '红色', value: '#b3261e' },
    { name: '蓝色', value: '#536dfe' },
    { name: '紫色', value: '#7b3fc6' },
    { name: '黑色', value: '#25282d' }
  ];
  const BACKGROUND_COLOR_PRESETS = [
    { name: '淡黄色', value: '#fff1a8' },
    { name: '淡蓝色', value: '#e6f0ff' },
    { name: '淡青色', value: '#e2f4f4' },
    { name: '淡绿色', value: '#e7f5e9' },
    { name: '淡橙色', value: '#ffe7cf' },
    { name: '淡红色', value: '#fde5e2' },
    { name: '淡紫色', value: '#eee5fa' },
    { name: '浅灰色', value: '#eef0f2' }
  ];
  const COLORS = COLOR_PRESETS.map((preset) => preset.value);

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function initialTargetPointCount(totalColumns) {
    const total = Math.max(2, Math.floor(Number(totalColumns) || 2));
    return total <= FULL_RESOLUTION_TARGET_LIMIT
      ? total
      : Math.min(total, LARGE_WAVE_TARGET_POINTS);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function debounce(callback, delay) {
    let timer = null;
    return function debounced() {
      const args = arguments;
      clearTimeout(timer);
      timer = setTimeout(() => callback.apply(null, args), delay);
    };
  }

  function niceStep(value) {
    const safe = Math.max(1e-12, value);
    const power = Math.pow(10, Math.floor(Math.log(safe) / Math.LN10));
    const normalized = safe / power;
    const factor = normalized <= 1 ? 1 : (normalized <= 2 ? 2 : (normalized <= 5 ? 5 : 10));
    return factor * power;
  }

  function normalizeAnalogFormat(candidate, fallbackType) {
    const source = candidate && typeof candidate === 'object' ? candidate : {};
    const supported = ['unsigned', 'signed', 'ufixed', 'sfixed', 'float'];
    const requestedType = String(
      source.type || source.numericType || source.dataType || fallbackType || 'unsigned'
    ).toLowerCase();
    const type = supported.indexOf(requestedType) >= 0 ? requestedType : 'unsigned';
    let bitWidth = clamp(Math.floor(Number(source.bitWidth) || 32), 1, 64);
    if (type === 'float') bitWidth = bitWidth <= 32 ? 32 : 64;
    const fractionalBits = clamp(
      Math.floor(Number(source.fractionalBits) || 0),
      0,
      Math.max(0, bitWidth - 1)
    );
    return { type, bitWidth, fractionalBits };
  }

  function normalizeScopeColor(value) {
    const color = String(value == null ? '' : value).trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(color)) return color;
    if (/^#[0-9a-f]{3}$/.test(color)) {
      return '#' + color.slice(1).split('').map((character) => character + character).join('');
    }
    return '';
  }

  function overlayBackgroundRange(ranges, start, end, color) {
    const next = [];
    (ranges || []).forEach((range) => {
      if (range.end <= start || range.start >= end) {
        next.push(Object.assign({}, range));
        return;
      }
      if (range.start < start) {
        next.push({ start: range.start, end: start, color: range.color });
      }
      if (range.end > end) {
        next.push({ start: end, end: range.end, color: range.color });
      }
    });
    if (color && end > start) next.push({ start, end, color });
    next.sort((left, right) => left.start - right.start || left.end - right.end);
    return next.reduce((merged, range) => {
      const previous = merged[merged.length - 1];
      if (previous && previous.color === range.color && previous.end === range.start) {
        previous.end = range.end;
      } else {
        merged.push(range);
      }
      return merged;
    }, []);
  }

  function normalizeRowStyle(candidate) {
    const source = candidate && typeof candidate === 'object' ? candidate : {};
    return {
      waveColor: normalizeScopeColor(source.waveColor),
      backgroundColor: normalizeScopeColor(source.backgroundColor),
      backgroundRanges: (Array.isArray(source.backgroundRanges)
        ? source.backgroundRanges
        : []).map((range) => ({
        start: Math.max(0, Math.floor(Number(range.start) || 0)),
        end: Math.max(0, Math.ceil(Number(range.end) || 0)),
        color: normalizeScopeColor(range.color)
      })).filter((range) => range.color && range.end > range.start)
    };
  }

  function parseColumnSelection(value, totalColumns) {
    const text = String(value == null ? '' : value).trim();
    if (!text) throw new Error('请输入列号，例如 1,3-5');
    const maximum = Math.max(1, Math.floor(Number(totalColumns) || 1));
    const ranges = [];
    text.replace(/[，；;]/g, ',').split(',').forEach((part) => {
      const token = part.trim();
      const match = token.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
      if (!match) throw new Error('列号格式错误：' + token);
      const first = Number(match[1]);
      const last = Number(match[2] || match[1]);
      if (first < 1 || last < 1 || first > maximum || last > maximum) {
        throw new Error('列号必须在 1-' + maximum + ' 范围内');
      }
      ranges.push({
        start: Math.min(first, last) - 1,
        end: Math.max(first, last)
      });
    });
    ranges.sort((left, right) => left.start - right.start || left.end - right.end);
    return ranges.reduce((merged, range) => {
      const previous = merged[merged.length - 1];
      if (previous && range.start <= previous.end) {
        previous.end = Math.max(previous.end, range.end);
      } else {
        merged.push(range);
      }
      return merged;
    }, []);
  }

  class ScopeWorkerClient {
    constructor(log) {
      this.log = typeof log === 'function' ? log : function () {};
      this.sequence = 0;
      this.pending = new Map();
      this.worker = null;
      this.fallback = global.VisualWaveDromScopeWorkerCore || null;
      try {
        this.worker = new Worker(WORKER_URL);
        this.worker.addEventListener('message', (event) => this.handleResponse(event.data || {}));
        this.worker.addEventListener('error', (event) => {
          this.log('scope-worker', {
            phase: 'worker-error',
            message: event && event.message ? event.message : 'worker failed'
          });
        });
      } catch (error) {
        this.worker = null;
        this.log('scope-worker', {
          phase: 'worker-fallback',
          message: error && error.message ? error.message : String(error)
        });
      }
    }

    handleResponse(response) {
      const pending = this.pending.get(response.requestId);
      if (!pending) return;
      this.pending.delete(response.requestId);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new Error(response.error || 'Scope worker failed'));
    }

    call(type, payload) {
      const requestId = ++this.sequence;
      const request = Object.assign({}, payload || {}, { type, requestId });
      if (this.worker) {
        return new Promise((resolve, reject) => {
          this.pending.set(requestId, { resolve, reject });
          this.worker.postMessage(request);
        });
      }
      const core = this.fallback || global.VisualWaveDromScopeWorkerCore;
      if (!core || typeof core.handleRequest !== 'function') {
        return Promise.reject(new Error('示波器计算模块不可用'));
      }
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          const response = core.handleRequest(request);
          if (response.ok) resolve(response.result);
          else reject(new Error(response.error || 'Scope worker failed'));
        }, 0);
      });
    }

    close() {
      if (this.worker) this.worker.terminate();
      this.pending.forEach((item) => item.reject(new Error('Scope window closed')));
      this.pending.clear();
    }
  }

  class ScopeView {
    constructor(adapter) {
      this.adapter = adapter;
      this.log = adapter && typeof adapter.log === 'function'
        ? adapter.log
        : function () {};
      this.worker = new ScopeWorkerClient(this.log);
      this.document = null;
      this.meta = null;
      this.modes = {};
      this.analogFormats = {};
      this.rowStyles = {};
      this.rowHeights = [];
      this.rowOffsets = [0];
      this.windowData = null;
      this.simplified = null;
      this.outputContent = '';
      this.viewStart = 0;
      this.viewEnd = 1;
      this.cursorA = null;
      this.cursorB = null;
      this.activeCursor = 'A';
      this.activeCursorRow = 0;
      this.connectionMode = false;
      this.connectionDraftStart = null;
      this.connectionHover = null;
      this.connections = [];
      this.selectedConnectionId = '';
      this.connectionSequence = 0;
      this.showOriginal = false;
      this.cursorInspectSequence = 0;
      this.cursorNavigationSequence = 0;
      this.cursorReadoutFrame = 0;
      this.cursorReadoutInFlight = false;
      this.cursorReadoutQueued = false;
      this.selectedPoint = null;
      this.columnSelection = null;
      this.lockedColumns = new Set();
      this.undoStack = [];
      this.redoStack = [];
      this.windowRequestSequence = 0;
      this.buildSequence = 0;
      this.drag = null;
      this.overviewDrag = null;
      this.overviewWindowRequestFrame = 0;
      this.overviewWindowRequestInFlight = false;
      this.overviewWindowRequestQueued = false;
      this.rowResize = null;
      this.presentationDraftDirty = false;
      this.dataDraftDirty = false;
      this.saveInFlight = false;
      this.styleControlRow = null;
      this.stylePopoverAnchor = null;
      this.columnBackgroundPopoverAnchor = null;
      this.columnBackgroundColor = BACKGROUND_COLOR_PRESETS[0].value;
      this.rowStart = 0;
      this.rowEnd = 0;
      this.resizeObserver = null;
      this.scheduleWindowRequest = debounce(() => this.requestWindow(), 24);
      this.scheduleBuild = debounce(() => this.rebuildOutput(), 80);
      this.handleBeforeUnload = (event) => {
        if (!this.hasUnsavedChanges()) return;
        event.preventDefault();
        event.returnValue = '';
      };
    }

    async mount() {
      document.body.classList.add('scope-wave-view');
      this.buildShell();
      this.bindEvents();
      this.setStatus('正在加载波形数据');
      this.document = await this.adapter.getDocument();
      if (!this.document || typeof this.document.content !== 'string') {
        throw new Error('指定的波形图不存在或尚未载入');
      }
      this.meta = await this.worker.call('prepare', { content: this.document.content });
      this.meta.rows.forEach((row) => {
        this.modes[row.index] = row.mode;
        this.analogFormats[row.index] = normalizeAnalogFormat(
          row.analogFormat,
          row.detectedMode === 'analog' ? 'float' : 'unsigned'
        );
        this.rowStyles[row.index] = normalizeRowStyle(row.style);
      });
      this.rowHeights = this.meta.rows.map((row) => row.rowHeight || DEFAULT_ROW_HEIGHT);
      this.rebuildRowOffsets();
      this.viewStart = 0;
      this.viewEnd = this.meta.totalColumns;
      this.cursorA = 0;
      this.cursorB = Math.max(0, this.meta.totalColumns - 1);
      this.activeCursorRow = this.meta.rows.length ? this.meta.rows[0].index : 0;
      this.titleEl.textContent = this.meta.title;
      document.title = this.meta.title + ' - 示波器';
      this.targetInput.max = String(Math.max(2, this.meta.totalColumns));
      this.targetInput.value = String(initialTargetPointCount(this.meta.totalColumns));
      this.rangeStartInput.value = '1';
      this.rangeEndInput.value = String(this.meta.totalColumns);
      this.renderSignalRows();
      this.updateCursorControls();
      this.updateMeasurements();
      this.updateLayout();
      await this.requestWindow();
      await this.runSimplify(false);
      await this.updateCursorReadout();
      this.updateDraftState();
      this.setStatus('示波器数据已就绪');
      this.log('scope-view', {
        phase: 'ready',
        waveId: this.document.name,
        rows: this.meta.rows.length,
        totalColumns: this.meta.totalColumns
      });
    }

    buildShell() {
      const normalApp = document.getElementById('app');
      if (normalApp) normalApp.setAttribute('aria-hidden', 'true');
      const root = document.createElement('div');
      root.className = 'scope-app';
      root.id = 'scope-app';
      const buildPresetButtons = (presets, attribute, label) => presets.map((preset) => `
        <button type="button" class="scope-color-preset"
            ${attribute}="${preset.value}"
            style="--scope-preset-color:${preset.value}"
            title="${escapeHtml(preset.name)}"
            aria-label="${escapeHtml(label)}：${escapeHtml(preset.name)}"
            aria-pressed="false"></button>
      `).join('');
      const waveColorPresetButtons = buildPresetButtons(
        COLOR_PRESETS,
        'data-scope-wave-color',
        '波形颜色'
      );
      const rowBackgroundPresetButtons = buildPresetButtons(
        BACKGROUND_COLOR_PRESETS,
        'data-scope-row-background',
        '整行背景'
      );
      const columnBackgroundPresetButtons = buildPresetButtons(
        BACKGROUND_COLOR_PRESETS,
        'data-scope-column-background',
        '指定列背景'
      );
      root.innerHTML = `
        <header class="scope-toolbar">
          <div class="scope-title-block">
            <strong id="scope-title">示波器</strong>
            <span id="scope-library-name"></span>
          </div>
          <div class="scope-toolbar-group" aria-label="视图控制">
            <button type="button" class="scope-command-btn" id="scope-connections"
                aria-pressed="false">连接线</button>
            <button type="button" class="scope-command-btn" id="scope-original-data"
                aria-pressed="false" title="显示或隐藏原始数据">原始数据 Off</button>
          </div>
          <div class="scope-toolbar-group scope-cursor-controls" aria-label="游标工具">
            <span class="scope-toolbar-label">游标</span>
            <button type="button" class="scope-cursor-choice active" id="scope-cursor-a" aria-pressed="true">A</button>
            <button type="button" class="scope-cursor-choice" id="scope-cursor-b" aria-pressed="false">B</button>
            <span class="scope-cursor-signal" id="scope-cursor-signal"></span>
            <span class="scope-toolbar-label">边沿</span>
            <button type="button" class="scope-icon-btn scope-small-icon" id="scope-cursor-prev-edge" title="跳到上一个边沿" aria-label="跳到上一个边沿">◀</button>
            <button type="button" class="scope-icon-btn scope-small-icon" id="scope-cursor-next-edge" title="跳到下一个边沿" aria-label="跳到下一个边沿">▶</button>
            <label>值
              <input type="text" id="scope-cursor-value" aria-label="游标目标值">
            </label>
            <button type="button" class="scope-icon-btn scope-small-icon" id="scope-cursor-prev-value" title="跳到上一个指定值" aria-label="跳到上一个指定值">◀</button>
            <button type="button" class="scope-icon-btn scope-small-icon" id="scope-cursor-next-value" title="跳到下一个指定值" aria-label="跳到下一个指定值">▶</button>
            <label>条件
              <input type="text" id="scope-cursor-condition" placeholder="&gt;=10 &amp;&amp; &lt;20"
                  aria-label="游标跳转条件" title="支持 ==、!=、&gt;、&gt;=、&lt;、&lt;=、&amp;&amp;、||">
            </label>
            <button type="button" class="scope-icon-btn scope-small-icon" id="scope-cursor-prev-condition"
                title="跳到上一个条件由假变真的边沿" aria-label="上一个条件成立边沿">◀</button>
            <button type="button" class="scope-icon-btn scope-small-icon" id="scope-cursor-next-condition"
                title="跳到下一个条件由假变真的边沿" aria-label="下一个条件成立边沿">▶</button>
          </div>
          <div class="scope-toolbar-group scope-analog-controls" aria-label="模拟波形数据解释">
            <span class="scope-toolbar-label">模拟解析</span>
            <label>类型
              <select id="scope-analog-type" aria-label="模拟波形数据类型">
                <option value="unsigned">无符号整数</option>
                <option value="signed">有符号整数</option>
                <option value="ufixed">无符号定点</option>
                <option value="sfixed">有符号定点</option>
                <option value="float">浮点数</option>
              </select>
            </label>
            <label>位宽
              <input type="number" id="scope-analog-width" min="1" max="64" step="1" value="32">
            </label>
            <label>小数位
              <input type="number" id="scope-analog-fraction" min="0" max="63" step="1" value="0">
            </label>
          </div>
          <div class="scope-toolbar-group scope-style-controls" aria-label="波形显示样式">
            <span class="scope-toolbar-label">行样式</span>
            <span class="scope-style-signal" id="scope-style-signal"></span>
            <label>指定列
              <input type="text" id="scope-style-columns" placeholder="1,3-5"
                  aria-label="需要设置背景色的列">
            </label>
            <button type="button" class="scope-command-btn" id="scope-style-use-cursors"
                title="使用 A、B 游标之间的列">使用 A-B</button>
            <button type="button" class="scope-command-btn" id="scope-column-background-apply"
                aria-haspopup="dialog" aria-expanded="false"
                aria-controls="scope-column-background-popover"
                title="选择预设颜色并应用到当前选区">列背景</button>
            <button type="button" class="scope-command-btn" id="scope-column-background-clear">清除列背景</button>
          </div>
          <div class="scope-toolbar-group scope-simplify-controls">
            <label>方法
              <select id="scope-method">
                <option value="event-preserving">事件与峰谷保留</option>
                <option value="transitions">跳变优先</option>
                <option value="uniform">均匀采样</option>
                <option value="lttb">趋势与峰值</option>
              </select>
            </label>
            <label>目标点数
              <input type="number" id="scope-target-points" min="2" step="1" value="100">
            </label>
            <label>起始列
              <input type="number" id="scope-range-start" min="1" step="1" value="1">
            </label>
            <label>结束列
              <input type="number" id="scope-range-end" min="1" step="1" value="1">
            </label>
            <button type="button" class="scope-command-btn" id="scope-use-view">使用当前窗口</button>
            <button type="button" class="scope-command-btn scope-primary" id="scope-simplify">生成简化实例</button>
          </div>
          <div class="scope-toolbar-group scope-save-controls">
            <label class="scope-title-input-label">实例标题
              <input type="text" id="scope-output-title">
            </label>
            <span class="scope-draft-state" id="scope-draft-state">已保存</span>
            <button type="button" class="scope-command-btn scope-primary"
                id="scope-save-source" disabled>保存修改</button>
            <button type="button" class="scope-command-btn" id="scope-save-instance">保存为展示实例</button>
            <button type="button" class="scope-command-btn" id="scope-open-normal">普通编辑</button>
          </div>
        </header>
        <main class="scope-workspace">
          <aside class="scope-signal-column">
            <div class="scope-signal-heading">
              <span>信号</span>
              <span>显示</span>
            </div>
            <div class="scope-signal-scroll" id="scope-signal-scroll">
              <div id="scope-signal-list"></div>
            </div>
            <div class="scope-overview-label">
              <div class="scope-overview-label-header">
                <strong>全局预览</strong>
                <div class="scope-overview-zoom-controls" aria-label="全局预览缩放">
                  <button type="button"
                      class="scope-icon-btn scope-overview-zoom-btn"
                      id="scope-zoom-in" title="放大" aria-label="放大全局预览">+</button>
                  <button type="button"
                      class="scope-icon-btn scope-overview-zoom-btn"
                      id="scope-zoom-out" title="缩小" aria-label="缩小全局预览">−</button>
                  <button type="button"
                      class="scope-command-btn scope-overview-fit-btn"
                      id="scope-fit">适应窗口</button>
                </div>
              </div>
              <span>拖动定位</span>
            </div>
          </aside>
          <section class="scope-plot-column">
            <canvas class="scope-axis" id="scope-axis" aria-label="时间轴"></canvas>
            <div class="scope-plot-viewport" id="scope-plot-viewport">
              <div class="scope-plot-spacer" id="scope-plot-spacer"></div>
              <canvas class="scope-plot" id="scope-plot" tabindex="0" aria-label="示波器波形区域"></canvas>
            </div>
            <canvas class="scope-overview" id="scope-overview" aria-label="全局波形预览"></canvas>
          </section>
        </main>
        <section class="scope-editor-strip">
          <div class="scope-point-editor" id="scope-point-editor">
            <strong>简化点编辑</strong>
            <span id="scope-point-position">单击简化波形选择数据点</span>
            <label>数值
              <input type="text" id="scope-point-value" disabled>
            </label>
            <label>标签
              <input type="text" id="scope-point-label" disabled>
            </label>
            <button type="button" class="scope-command-btn" id="scope-point-apply" disabled>应用</button>
            <button type="button" class="scope-command-btn" id="scope-point-insert" disabled>插入点</button>
            <button type="button" class="scope-command-btn" id="scope-point-delete" disabled>删除点</button>
            <button type="button" class="scope-command-btn" id="scope-point-lock" disabled>保留关键点</button>
            <button type="button" class="scope-icon-btn" id="scope-undo" title="撤销" disabled>↶</button>
            <button type="button" class="scope-icon-btn" id="scope-redo" title="重做" disabled>↷</button>
          </div>
          <div class="scope-measurements" id="scope-measurements">
            <span>A：未设置</span>
            <span>B：未设置</span>
            <strong>Δt：--</strong>
          </div>
        </section>
        <footer class="scope-statusbar">
          <span id="scope-status">初始化</span>
          <span id="scope-metrics"></span>
        </footer>
        <div class="scope-style-popover" id="scope-style-popover" role="dialog"
            aria-label="信号颜色设置" hidden>
          <div class="scope-style-popover-header">
            <strong id="scope-style-popover-title"></strong>
            <button type="button" class="scope-icon-btn scope-small-icon"
                id="scope-style-popover-close" title="关闭" aria-label="关闭颜色设置">×</button>
          </div>
          <div class="scope-style-popover-row">
            <span>波形颜色</span>
            <div class="scope-color-presets" id="scope-wave-color-presets"
                role="group" aria-label="波形预设颜色">${waveColorPresetButtons}</div>
            <button type="button" class="scope-icon-btn scope-small-icon" id="scope-wave-color-reset"
                title="恢复自动波形颜色" aria-label="恢复自动波形颜色">↺</button>
          </div>
          <div class="scope-style-popover-row">
            <span>整行背景</span>
            <div class="scope-color-presets scope-background-presets"
                id="scope-row-background-presets"
                role="group" aria-label="整行背景预设颜色">${rowBackgroundPresetButtons}</div>
            <button type="button" class="scope-icon-btn scope-small-icon" id="scope-row-background-clear"
              title="清除整行背景色" aria-label="清除整行背景色">×</button>
          </div>
        </div>
        <div class="scope-style-popover scope-column-background-popover"
            id="scope-column-background-popover" role="dialog"
            aria-labelledby="scope-column-background-popover-title" hidden>
          <div class="scope-style-popover-header">
            <strong id="scope-column-background-popover-title">选区背景</strong>
            <button type="button" class="scope-icon-btn scope-small-icon"
                id="scope-column-background-popover-close"
                title="关闭" aria-label="关闭列背景颜色选择">×</button>
          </div>
          <p class="scope-column-background-summary"
              id="scope-column-background-summary"></p>
          <div class="scope-color-presets scope-background-presets scope-column-background-palette"
              id="scope-column-background-presets"
              role="group" aria-label="选区背景预设颜色">${columnBackgroundPresetButtons}</div>
        </div>
      `;
      document.body.appendChild(root);

      this.root = root;
      this.titleEl = root.querySelector('#scope-title');
      this.libraryNameEl = root.querySelector('#scope-library-name');
      this.signalScroll = root.querySelector('#scope-signal-scroll');
      this.signalList = root.querySelector('#scope-signal-list');
      this.plotViewport = root.querySelector('#scope-plot-viewport');
      this.plotSpacer = root.querySelector('#scope-plot-spacer');
      this.axisCanvas = root.querySelector('#scope-axis');
      this.plotCanvas = root.querySelector('#scope-plot');
      this.overviewCanvas = root.querySelector('#scope-overview');
      this.methodSelect = root.querySelector('#scope-method');
      this.targetInput = root.querySelector('#scope-target-points');
      this.rangeStartInput = root.querySelector('#scope-range-start');
      this.rangeEndInput = root.querySelector('#scope-range-end');
      this.outputTitleInput = root.querySelector('#scope-output-title');
      this.connectionButton = root.querySelector('#scope-connections');
      this.originalDataButton = root.querySelector('#scope-original-data');
      this.cursorAButton = root.querySelector('#scope-cursor-a');
      this.cursorBButton = root.querySelector('#scope-cursor-b');
      this.cursorSignalEl = root.querySelector('#scope-cursor-signal');
      this.cursorValueInput = root.querySelector('#scope-cursor-value');
      this.cursorPrevEdgeButton = root.querySelector('#scope-cursor-prev-edge');
      this.cursorNextEdgeButton = root.querySelector('#scope-cursor-next-edge');
      this.cursorPrevValueButton = root.querySelector('#scope-cursor-prev-value');
      this.cursorNextValueButton = root.querySelector('#scope-cursor-next-value');
      this.cursorConditionInput = root.querySelector('#scope-cursor-condition');
      this.cursorPrevConditionButton = root.querySelector('#scope-cursor-prev-condition');
      this.cursorNextConditionButton = root.querySelector('#scope-cursor-next-condition');
      this.analogTypeSelect = root.querySelector('#scope-analog-type');
      this.analogWidthInput = root.querySelector('#scope-analog-width');
      this.analogFractionInput = root.querySelector('#scope-analog-fraction');
      this.styleSignalEl = root.querySelector('#scope-style-signal');
      this.stylePopover = root.querySelector('#scope-style-popover');
      this.stylePopoverTitle = root.querySelector('#scope-style-popover-title');
      this.stylePopoverCloseButton = root.querySelector('#scope-style-popover-close');
      this.waveColorPresets = root.querySelector('#scope-wave-color-presets');
      this.waveColorResetButton = root.querySelector('#scope-wave-color-reset');
      this.rowBackgroundPresets = root.querySelector('#scope-row-background-presets');
      this.rowBackgroundClearButton = root.querySelector('#scope-row-background-clear');
      this.styleColumnsInput = root.querySelector('#scope-style-columns');
      this.styleUseCursorsButton = root.querySelector('#scope-style-use-cursors');
      this.columnBackgroundPresets = root.querySelector('#scope-column-background-presets');
      this.columnBackgroundApplyButton = root.querySelector('#scope-column-background-apply');
      this.columnBackgroundClearButton = root.querySelector('#scope-column-background-clear');
      this.columnBackgroundPopover = root.querySelector('#scope-column-background-popover');
      this.columnBackgroundPopoverTitle = root.querySelector(
        '#scope-column-background-popover-title'
      );
      this.columnBackgroundSummary = root.querySelector('#scope-column-background-summary');
      this.columnBackgroundPopoverCloseButton = root.querySelector(
        '#scope-column-background-popover-close'
      );
      this.statusEl = root.querySelector('#scope-status');
      this.metricsEl = root.querySelector('#scope-metrics');
      this.measurementsEl = root.querySelector('#scope-measurements');
      this.pointPositionEl = root.querySelector('#scope-point-position');
      this.pointValueInput = root.querySelector('#scope-point-value');
      this.pointLabelInput = root.querySelector('#scope-point-label');
      this.pointApplyButton = root.querySelector('#scope-point-apply');
      this.pointInsertButton = root.querySelector('#scope-point-insert');
      this.pointDeleteButton = root.querySelector('#scope-point-delete');
      this.pointLockButton = root.querySelector('#scope-point-lock');
      this.undoButton = root.querySelector('#scope-undo');
      this.redoButton = root.querySelector('#scope-redo');
      this.saveSourceButton = root.querySelector('#scope-save-source');
      this.draftStateEl = root.querySelector('#scope-draft-state');
      this.libraryNameEl.textContent = this.adapter.libraryName || '';
    }

    bindEvents() {
      this.root.querySelector('#scope-zoom-in').addEventListener('click', () => this.zoom(0.5));
      this.root.querySelector('#scope-zoom-out').addEventListener('click', () => this.zoom(2));
      this.root.querySelector('#scope-fit').addEventListener('click', () => this.fit());
      this.connectionButton.addEventListener('click', () => this.toggleConnectionMode());
      this.originalDataButton.addEventListener('click', () => this.toggleOriginalData());
      this.cursorAButton.addEventListener('click', () => this.setActiveCursor('A', true));
      this.cursorBButton.addEventListener('click', () => this.setActiveCursor('B', true));
      this.cursorPrevEdgeButton.addEventListener('click', () => {
        void this.navigateActiveCursor('edge', -1);
      });
      this.cursorNextEdgeButton.addEventListener('click', () => {
        void this.navigateActiveCursor('edge', 1);
      });
      this.cursorPrevValueButton.addEventListener('click', () => {
        void this.navigateActiveCursor('value', -1);
      });
      this.cursorNextValueButton.addEventListener('click', () => {
        void this.navigateActiveCursor('value', 1);
      });
      this.cursorPrevConditionButton.addEventListener('click', () => {
        void this.navigateActiveCursor('condition', -1);
      });
      this.cursorNextConditionButton.addEventListener('click', () => {
        void this.navigateActiveCursor('condition', 1);
      });
      this.cursorValueInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        void this.navigateActiveCursor('value', event.shiftKey ? -1 : 1);
      });
      this.cursorConditionInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        void this.navigateActiveCursor('condition', event.shiftKey ? -1 : 1);
      });
      this.analogTypeSelect.addEventListener('change', () => this.applyAnalogFormatControls());
      this.analogWidthInput.addEventListener('change', () => this.applyAnalogFormatControls());
      this.analogFractionInput.addEventListener('change', () => this.applyAnalogFormatControls());
      this.waveColorPresets.addEventListener('click', (event) => {
        const button = event.target.closest('[data-scope-wave-color]');
        if (!button || button.disabled) return;
        this.applyWaveColor(button.dataset.scopeWaveColor);
      });
      this.waveColorResetButton.addEventListener('click', () => this.resetWaveColor());
      this.rowBackgroundPresets.addEventListener('click', (event) => {
        const button = event.target.closest('[data-scope-row-background]');
        if (!button || button.disabled) return;
        this.applyRowBackground(button.dataset.scopeRowBackground);
      });
      this.rowBackgroundClearButton.addEventListener('click', () => this.clearRowBackground());
      this.stylePopoverCloseButton.addEventListener('click', () => this.closeStylePopover());
      this.columnBackgroundPresets.addEventListener('click', (event) => {
        const button = event.target.closest('[data-scope-column-background]');
        if (!button || button.disabled) return;
        this.columnBackgroundColor = button.dataset.scopeColumnBackground;
        this.updateStyleControls();
        this.applyColumnBackground(false);
        this.closeColumnBackgroundPopover(true);
      });
      this.columnBackgroundPopoverCloseButton.addEventListener('click', () => {
        this.closeColumnBackgroundPopover(true);
      });
      this.styleUseCursorsButton.addEventListener('click', () => this.useCursorColumnSelection());
      this.columnBackgroundApplyButton.addEventListener('click', () => {
        this.openColumnBackgroundPopover(this.columnBackgroundApplyButton);
      });
      this.columnBackgroundClearButton.addEventListener('click', () => {
        this.applyColumnBackground(true);
      });
      this.styleColumnsInput.addEventListener('input', () => {
        this.closeColumnBackgroundPopover();
        this.updateColumnBackgroundAvailability();
      });
      this.styleColumnsInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        this.openColumnBackgroundPopover(this.columnBackgroundApplyButton);
      });
      this.root.querySelector('#scope-use-view').addEventListener('click', () => this.useCurrentViewRange());
      this.root.querySelector('#scope-simplify').addEventListener('click', () => this.runSimplify(true));
      this.root.querySelector('#scope-save-instance').addEventListener('click', () => this.saveInstance());
      this.saveSourceButton.addEventListener('click', () => this.saveChanges());
      this.root.querySelector('#scope-open-normal').addEventListener('click', () => this.adapter.openNormalView());
      this.pointApplyButton.addEventListener('click', () => this.applySelectedPoint());
      this.pointInsertButton.addEventListener('click', () => this.insertSelectedPoint());
      this.pointDeleteButton.addEventListener('click', () => this.deleteSelectedPoint());
      this.pointLockButton.addEventListener('click', () => this.toggleSelectedPointLock());
      this.undoButton.addEventListener('click', () => this.undo());
      this.redoButton.addEventListener('click', () => this.redo());

      this.signalList.addEventListener('change', (event) => {
        const select = event.target.closest('[data-scope-mode-row]');
        if (!select) return;
        const rowIndex = Number(select.dataset.scopeModeRow);
        const nextMode = select.value;
        if (this.modes[rowIndex] === nextMode) return;
        if (this.simplified) this.pushHistory();
        const scrollTop = this.plotViewport.scrollTop;
        this.cursorNavigationSequence += 1;
        this.modes[rowIndex] = nextMode;
        this.markDraftDirty('presentation');
        this.activeCursorRow = rowIndex;
        this.renderSignalRows();
        this.plotViewport.scrollTop = scrollTop;
        this.signalScroll.scrollTop = this.plotViewport.scrollTop;
        this.updateAnalogControls();
        this.scheduleWindowRequest();
        void this.runSimplify(false);
      });

      this.signalList.addEventListener('pointerdown', (event) => {
        const handle = event.target.closest('[data-scope-row-resize]');
        if (!handle) return;
        this.startRowResize(event, handle);
      });
      this.signalList.addEventListener('pointermove', (event) => this.moveRowResize(event));
      this.signalList.addEventListener('pointerup', (event) => this.finishRowResize(event));
      this.signalList.addEventListener('pointercancel', (event) => this.finishRowResize(event));
      this.signalList.addEventListener('click', (event) => {
        const swatch = event.target.closest('[data-scope-swatch-row]');
        if (swatch) {
          event.preventDefault();
          this.openStylePopover(Number(swatch.dataset.scopeSwatchRow), swatch);
          return;
        }
        if (event.target.closest('select, [data-scope-row-resize]')) return;
        const row = event.target.closest('[data-scope-signal-row]');
        if (!row) return;
        this.setActiveCursorRow(Number(row.dataset.scopeSignalRow));
      });
      this.signalList.addEventListener('keydown', (event) => {
        const handle = event.target.closest('[data-scope-row-resize]');
        if (handle && /^(ArrowUp|ArrowDown|Home)$/.test(event.key)) {
          event.preventDefault();
          const rowIndex = Number(handle.dataset.scopeRowResize);
          const previousHeight = this.rowHeight(rowIndex);
          const requestedHeight = event.key === 'Home'
            ? DEFAULT_ROW_HEIGHT
            : previousHeight + (event.key === 'ArrowUp' ? -8 : 8);
          const nextHeight = clamp(
            requestedHeight,
            MIN_ANALOG_ROW_HEIGHT,
            MAX_ANALOG_ROW_HEIGHT
          );
          if (nextHeight !== previousHeight && this.simplified) this.pushHistory();
          const changed = this.setAnalogRowHeight(rowIndex, nextHeight, handle);
          if (changed) this.markDraftDirty('presentation');
          this.setStatus('已将 ' + this.meta.rows[rowIndex].name
            + ' 行高设为 ' + this.rowHeight(rowIndex) + ' px');
          return;
        }
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const row = event.target.closest('[data-scope-signal-row]');
        if (!row || event.target.closest('select, [data-scope-row-resize], [data-scope-swatch-row]')) return;
        event.preventDefault();
        this.setActiveCursorRow(Number(row.dataset.scopeSignalRow));
      });

      this.plotViewport.addEventListener('scroll', () => {
        this.closeStylePopover();
        this.closeColumnBackgroundPopover();
        this.signalScroll.scrollTop = this.plotViewport.scrollTop;
        this.positionPlotCanvas();
        this.scheduleWindowRequest();
      }, { passive: true });
      this.signalScroll.addEventListener('wheel', (event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey) return;
        event.preventDefault();
        this.scrollPlotVertically(event.deltaY, event.deltaMode);
      }, { passive: false });

      this.plotCanvas.addEventListener('pointerdown', (event) => this.onPlotPointerDown(event));
      this.plotCanvas.addEventListener('pointermove', (event) => this.onPlotPointerMove(event));
      this.plotCanvas.addEventListener('pointerup', (event) => this.onPlotPointerUp(event));
      this.plotCanvas.addEventListener('pointercancel', (event) => this.cancelPlotDrag(event));
      this.plotCanvas.addEventListener('pointerleave', () => {
        if (!this.drag) this.plotCanvas.classList.remove('cursor-hover');
        if (!this.connectionHover || this.drag) return;
        this.connectionHover = null;
        this.draw();
      });
      this.plotCanvas.addEventListener('wheel', (event) => this.onPlotWheel(event), { passive: false });
      this.overviewCanvas.addEventListener('pointerdown', (event) => this.onOverviewPointerDown(event));
      this.overviewCanvas.addEventListener('pointermove', (event) => this.onOverviewPointerMove(event));
      this.overviewCanvas.addEventListener('pointerup', (event) => this.finishOverviewDrag(event, false));
      this.overviewCanvas.addEventListener('pointercancel', (event) => this.finishOverviewDrag(event, true));
      this.overviewCanvas.addEventListener('wheel', (event) => {
        this.onOverviewWheel(event);
      }, { passive: false });
      this.outputTitleInput.addEventListener('input', () => this.scheduleBuild());

      global.addEventListener('keydown', (event) => {
        if (event.key === 'Escape'
            && this.columnBackgroundPopover
            && !this.columnBackgroundPopover.hidden) {
          event.preventDefault();
          this.closeColumnBackgroundPopover(true);
          return;
        }
        if (event.key === 'Escape' && this.stylePopover && !this.stylePopover.hidden) {
          event.preventDefault();
          this.closeStylePopover();
          return;
        }
        if (event.key === 'Escape' && this.connectionDraftStart) {
          event.preventDefault();
          this.connectionDraftStart = null;
          this.connectionHover = null;
          this.draw();
          this.setStatus('已取消当前连接线起点');
          this.log('scope-connection', { phase: 'draft-cancel' });
          return;
        }
        if (event.key === 'Escape' && this.selectedConnectionId) {
          event.preventDefault();
          this.selectedConnectionId = '';
          this.draw();
          this.setStatus('已取消连接线选择');
          this.log('scope-connection', { phase: 'selection-clear' });
          return;
        }
        if (event.key === 'Escape' && this.connectionMode) {
          event.preventDefault();
          this.setConnectionMode(false);
          this.setStatus('已退出连接线模式');
          return;
        }
        const target = event.target;
        const editingText = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
        if (editingText) return;
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
          event.preventDefault();
          if (event.shiftKey) this.redo();
          else this.undo();
        } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
          event.preventDefault();
          this.redo();
        } else if (event.key === 'Delete' && this.selectedConnectionId) {
          event.preventDefault();
          this.deleteSelectedConnection();
        } else if (event.key === 'Delete' && this.selectedPoint) {
          event.preventDefault();
          this.deleteSelectedPoint();
        }
      });

      this.root.addEventListener('pointerdown', (event) => {
        if (this.stylePopover && !this.stylePopover.hidden
            && !this.stylePopover.contains(event.target)
            && !event.target.closest('[data-scope-swatch-row]')) {
          this.closeStylePopover();
        }
        if (this.columnBackgroundPopover && !this.columnBackgroundPopover.hidden
            && !this.columnBackgroundPopover.contains(event.target)
            && !event.target.closest('#scope-column-background-apply')) {
          this.closeColumnBackgroundPopover();
        }
      });

      if (typeof ResizeObserver === 'function') {
        this.resizeObserver = new ResizeObserver(() => this.updateLayout());
        this.resizeObserver.observe(this.plotViewport);
      } else {
        global.addEventListener('resize', () => this.updateLayout());
      }
      global.addEventListener('beforeunload', this.handleBeforeUnload);
      global.addEventListener('pagehide', () => {
        if (this.cursorReadoutFrame) global.cancelAnimationFrame(this.cursorReadoutFrame);
        if (this.overviewWindowRequestFrame) {
          global.cancelAnimationFrame(this.overviewWindowRequestFrame);
        }
        this.worker.close();
      }, { once: true });
    }

    setStatus(message, error) {
      if (!this.statusEl) return;
      this.statusEl.textContent = String(message || '');
      this.statusEl.classList.toggle('error', !!error);
    }

    hasUnsavedChanges() {
      return !!(this.presentationDraftDirty || this.dataDraftDirty);
    }

    updateDraftState() {
      const dirty = this.hasUnsavedChanges();
      if (this.saveSourceButton) {
        this.saveSourceButton.disabled = !dirty || this.saveInFlight;
        this.saveSourceButton.textContent = this.saveInFlight ? '保存中...' : '保存修改';
        this.saveSourceButton.classList.toggle('scope-unsaved', dirty);
        this.saveSourceButton.title = dirty
          ? '将当前示波器草稿写回原波形'
          : '当前没有未保存修改';
      }
      if (this.draftStateEl) {
        this.draftStateEl.textContent = dirty ? '未保存' : '已保存';
        this.draftStateEl.classList.toggle('unsaved', dirty);
      }
    }

    markDraftDirty(kind) {
      if (kind === 'data') this.dataDraftDirty = true;
      else this.presentationDraftDirty = true;
      this.updateDraftState();
      this.log('scope-draft', {
        phase: 'changed',
        kind: kind === 'data' ? 'data' : 'presentation',
        waveId: this.document && this.document.name
      });
    }

    clearDraftDirty() {
      this.presentationDraftDirty = false;
      this.dataDraftDirty = false;
      this.updateDraftState();
    }

    rowHeight(rowIndex) {
      if (this.modes[rowIndex] !== 'analog') return DEFAULT_ROW_HEIGHT;
      return clamp(
        Math.round(Number(this.rowHeights[rowIndex]) || DEFAULT_ROW_HEIGHT),
        MIN_ANALOG_ROW_HEIGHT,
        MAX_ANALOG_ROW_HEIGHT
      );
    }

    rebuildRowOffsets() {
      const offsets = [0];
      const rowCount = this.meta && this.meta.rows ? this.meta.rows.length : 0;
      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        offsets.push(offsets[rowIndex] + this.rowHeight(rowIndex));
      }
      this.rowOffsets = offsets;
      if (this.plotSpacer) {
        this.plotSpacer.style.height = offsets[offsets.length - 1] + 'px';
      }
    }

    rowTop(rowIndex) {
      return this.rowOffsets[rowIndex] || 0;
    }

    rowIndexAtOffset(offset) {
      const rowCount = this.meta && this.meta.rows ? this.meta.rows.length : 0;
      if (!rowCount) return 0;
      const target = Math.max(0, Number(offset) || 0);
      if (target >= this.rowOffsets[rowCount]) return rowCount;
      let low = 0;
      let high = rowCount;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (this.rowOffsets[middle + 1] <= target) low = middle + 1;
        else high = middle;
      }
      return low;
    }

    renderSignalRows() {
      this.closeStylePopover();
      this.closeColumnBackgroundPopover();
      this.rebuildRowOffsets();
      this.signalList.innerHTML = this.meta.rows.map((row) => {
        const group = row.groups && row.groups.length ? row.groups.join(' / ') : '';
        const rowHeight = this.rowHeight(row.index);
        const analogMode = this.modes[row.index] === 'analog';
        const waveColor = this.rowWaveColor(row.index);
        return `
          <div class="scope-signal-row${row.index === this.activeCursorRow ? ' active' : ''}${analogMode ? ' scope-signal-row-analog' : ''}"
              data-row-index="${row.index}" data-scope-signal-row="${row.index}"
              tabindex="0" aria-label="选择信号 ${escapeHtml(row.name)}"
              style="height:${rowHeight}px">
            <button type="button" class="scope-swatch" data-scope-swatch-row="${row.index}"
                style="background:${waveColor}"
                title="设置 ${escapeHtml(row.name)} 的波形和背景颜色"
                aria-label="设置 ${escapeHtml(row.name)} 的波形和背景颜色"
                aria-haspopup="dialog" aria-expanded="false"></button>
            <span class="scope-signal-name" title="${escapeHtml(row.name)}">
              ${group ? `<small>${escapeHtml(group)}</small>` : ''}
              <strong>${escapeHtml(row.name)}</strong>
              <em>
                <span>${escapeHtml(String(row.sampleCount || 0))} 点${row.unit ? ` · ${escapeHtml(row.unit)}` : ''}</span>
                <b data-scope-cursor-value-row="${row.index}">${escapeHtml(this.activeCursor)}：--</b>
              </em>
            </span>
            <select data-scope-mode-row="${row.index}" aria-label="${escapeHtml(row.name)} 显示模式">
              <option value="digital"${this.modes[row.index] === 'digital' ? ' selected' : ''}>数字</option>
              <option value="bus"${this.modes[row.index] === 'bus' ? ' selected' : ''}>总线</option>
              <option value="analog"${this.modes[row.index] === 'analog' ? ' selected' : ''}>模拟</option>
            </select>
            ${analogMode ? `
              <span class="scope-row-resize-handle" data-scope-row-resize="${row.index}"
                  role="separator" aria-orientation="horizontal"
                  aria-label="调整 ${escapeHtml(row.name)} 行高"
                  aria-valuemin="${MIN_ANALOG_ROW_HEIGHT}" aria-valuemax="${MAX_ANALOG_ROW_HEIGHT}"
                  aria-valuenow="${rowHeight}" tabindex="0" title="拖动调整模拟波形行高"></span>
            ` : ''}
          </div>
        `;
      }).join('');
      if (this.cursorAButton) {
        this.updateCursorControls();
        void this.updateCursorReadout();
      }
    }

    rowStyle(rowIndex) {
      const index = Math.max(0, Math.floor(Number(rowIndex) || 0));
      if (!this.rowStyles[index]) this.rowStyles[index] = normalizeRowStyle(null);
      return this.rowStyles[index];
    }

    rowWaveColor(rowIndex) {
      return this.rowStyle(rowIndex).waveColor || COLORS[rowIndex % COLORS.length];
    }

    updateStyleControls() {
      if (!this.styleSignalEl) return;
      const row = this.meta && this.meta.rows[this.activeCursorRow];
      const waveColorButtons = Array.from(
        this.waveColorPresets.querySelectorAll('[data-scope-wave-color]')
      );
      const rowBackgroundButtons = Array.from(
        this.rowBackgroundPresets.querySelectorAll('[data-scope-row-background]')
      );
      const columnBackgroundButtons = Array.from(
        this.columnBackgroundPresets.querySelectorAll('[data-scope-column-background]')
      );
      const controls = [
        ...waveColorButtons,
        ...rowBackgroundButtons,
        ...columnBackgroundButtons,
        this.waveColorResetButton,
        this.rowBackgroundClearButton,
        this.styleColumnsInput,
        this.styleUseCursorsButton,
        this.columnBackgroundApplyButton,
        this.columnBackgroundClearButton
      ];
      controls.forEach((control) => { control.disabled = !row; });
      if (!row) {
        this.styleSignalEl.textContent = '';
        this.stylePopoverTitle.textContent = '';
        waveColorButtons.concat(rowBackgroundButtons, columnBackgroundButtons).forEach((button) => {
          button.classList.remove('active');
          button.setAttribute('aria-pressed', 'false');
        });
        this.updateColumnBackgroundAvailability();
        return;
      }
      const style = this.rowStyle(row.index);
      if (this.styleControlRow !== row.index) {
        this.styleColumnsInput.value = '';
        this.styleControlRow = row.index;
      }
      this.styleSignalEl.textContent = row.name;
      this.styleSignalEl.title = row.name;
      this.stylePopoverTitle.textContent = row.name;
      const effectiveWaveColor = this.rowWaveColor(row.index);
      waveColorButtons.forEach((button) => {
        const active = button.dataset.scopeWaveColor === effectiveWaveColor;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      });
      this.waveColorResetButton.disabled = !style.waveColor;
      rowBackgroundButtons.forEach((button) => {
        const active = button.dataset.scopeRowBackground === style.backgroundColor;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      });
      this.rowBackgroundClearButton.disabled = !style.backgroundColor;
      columnBackgroundButtons.forEach((button) => {
        const active = button.dataset.scopeColumnBackground === this.columnBackgroundColor;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      });
      const count = style.backgroundRanges.length;
      this.styleSignalEl.dataset.rangeCount = String(count);
      this.styleSignalEl.setAttribute(
        'aria-label',
        row.name + (count ? '，已设置 ' + count + ' 个列背景区间' : '')
      );
      this.updateColumnBackgroundAvailability();
    }

    updateColumnBackgroundAvailability() {
      if (!this.columnBackgroundApplyButton) return false;
      const row = this.meta && this.meta.rows[this.activeCursorRow];
      const columnText = this.styleColumnsInput
        ? String(this.styleColumnsInput.value || '').trim()
        : '';
      const available = !!row && !!columnText;
      this.columnBackgroundApplyButton.disabled = !available;
      this.columnBackgroundClearButton.disabled = !available;
      Array.from(
        this.columnBackgroundPresets.querySelectorAll('[data-scope-column-background]')
      ).forEach((button) => {
        button.disabled = !available;
      });
      if (this.columnBackgroundPopoverTitle) {
        this.columnBackgroundPopoverTitle.textContent = row
          ? '选区背景 · ' + row.name
          : '选区背景';
      }
      if (this.columnBackgroundSummary) {
        this.columnBackgroundSummary.textContent = available
          ? row.name + '：第 ' + columnText + ' 列'
          : '请先在波形区域选择需要设置背景的列';
      }
      if (!available) this.closeColumnBackgroundPopover();
      return available;
    }

    openStylePopover(rowIndex, anchor) {
      const index = clamp(
        Math.floor(Number(rowIndex) || 0),
        0,
        Math.max(0, this.meta.rows.length - 1)
      );
      if (!anchor || !this.meta.rows[index]) return;
      this.closeStylePopover();
      this.closeColumnBackgroundPopover();
      this.setActiveCursorRow(index);
      this.stylePopoverAnchor = anchor;
      anchor.classList.add('active');
      anchor.setAttribute('aria-expanded', 'true');
      this.stylePopover.hidden = false;
      this.stylePopover.style.visibility = 'hidden';
      this.updateStyleControls();
      const anchorRect = anchor.getBoundingClientRect();
      const popoverRect = this.stylePopover.getBoundingClientRect();
      const margin = 8;
      const viewportWidth = Math.max(1, document.documentElement.clientWidth);
      const viewportHeight = Math.max(1, document.documentElement.clientHeight);
      let left = anchorRect.right + 8;
      if (left + popoverRect.width > viewportWidth - margin) {
        left = anchorRect.left - popoverRect.width - 8;
      }
      const top = clamp(
        anchorRect.top,
        margin,
        Math.max(margin, viewportHeight - popoverRect.height - margin)
      );
      this.stylePopover.style.left = clamp(
        left,
        margin,
        Math.max(margin, viewportWidth - popoverRect.width - margin)
      ) + 'px';
      this.stylePopover.style.top = top + 'px';
      this.stylePopover.style.visibility = '';
      this.setStatus('正在设置 ' + this.meta.rows[index].name + ' 的波形和背景颜色');
    }

    openColumnBackgroundPopover(anchor) {
      const row = this.meta && this.meta.rows[this.activeCursorRow];
      if (!anchor || !row || !this.updateColumnBackgroundAvailability()) {
        this.setStatus('请先在波形区域选择需要设置背景的列', true);
        return;
      }
      let selection;
      try {
        selection = parseColumnSelection(this.styleColumnsInput.value, this.meta.totalColumns);
      } catch (error) {
        this.setStatus(error.message || String(error), true);
        this.styleColumnsInput.focus();
        return;
      }
      this.closeStylePopover();
      this.closeColumnBackgroundPopover();
      this.columnBackgroundPopoverAnchor = anchor;
      anchor.classList.add('active');
      anchor.setAttribute('aria-expanded', 'true');
      this.columnBackgroundSummary.textContent = row.name + '：第 ' + selection.map((range) => {
        const first = range.start + 1;
        const last = range.end;
        return first === last ? String(first) : first + '-' + last;
      }).join('、') + ' 列';
      this.columnBackgroundPopover.hidden = false;
      this.columnBackgroundPopover.style.visibility = 'hidden';
      const anchorRect = anchor.getBoundingClientRect();
      const popoverRect = this.columnBackgroundPopover.getBoundingClientRect();
      const margin = 8;
      const viewportWidth = Math.max(1, document.documentElement.clientWidth);
      const viewportHeight = Math.max(1, document.documentElement.clientHeight);
      let left = anchorRect.left;
      let top = anchorRect.bottom + 6;
      if (top + popoverRect.height > viewportHeight - margin) {
        top = anchorRect.top - popoverRect.height - 6;
      }
      this.columnBackgroundPopover.style.left = clamp(
        left,
        margin,
        Math.max(margin, viewportWidth - popoverRect.width - margin)
      ) + 'px';
      this.columnBackgroundPopover.style.top = clamp(
        top,
        margin,
        Math.max(margin, viewportHeight - popoverRect.height - margin)
      ) + 'px';
      this.columnBackgroundPopover.style.visibility = '';
      const activeButton = this.columnBackgroundPresets.querySelector(
        '[data-scope-column-background].active'
      );
      const firstButton = this.columnBackgroundPresets.querySelector(
        '[data-scope-column-background]'
      );
      const focusTarget = activeButton || firstButton;
      if (focusTarget) focusTarget.focus({ preventScroll: true });
      this.setStatus('请选择 ' + row.name + ' 选中区域的背景颜色');
    }

    closeColumnBackgroundPopover(restoreFocus) {
      if (!this.columnBackgroundPopover || this.columnBackgroundPopover.hidden) return;
      const anchor = this.columnBackgroundPopoverAnchor;
      if (anchor) {
        anchor.classList.remove('active');
        anchor.setAttribute('aria-expanded', 'false');
      }
      this.columnBackgroundPopoverAnchor = null;
      this.columnBackgroundPopover.hidden = true;
      this.columnBackgroundPopover.style.visibility = '';
      if (restoreFocus && anchor) anchor.focus({ preventScroll: true });
    }

    closeStylePopover() {
      if (!this.stylePopover || this.stylePopover.hidden) return;
      if (this.stylePopoverAnchor) {
        this.stylePopoverAnchor.classList.remove('active');
        this.stylePopoverAnchor.setAttribute('aria-expanded', 'false');
      }
      this.stylePopoverAnchor = null;
      this.stylePopover.hidden = true;
      this.stylePopover.style.visibility = '';
    }

    updateSignalStyleIndicator(rowIndex) {
      const swatch = this.signalList.querySelector(
        '[data-scope-swatch-row="' + rowIndex + '"]'
      );
      if (!swatch) return;
      const color = this.rowWaveColor(rowIndex);
      swatch.style.background = color;
      const row = this.meta.rows[rowIndex];
      swatch.title = '设置 ' + (row ? row.name : '') + ' 的波形和背景颜色';
    }

    changeRowStyle(update, message) {
      const row = this.meta && this.meta.rows[this.activeCursorRow];
      if (!row) return;
      const previous = clone(this.rowStyle(row.index));
      const next = clone(previous);
      update(next);
      const normalized = normalizeRowStyle(next);
      if (JSON.stringify(previous) === JSON.stringify(normalized)) return;
      if (this.simplified) this.pushHistory();
      this.rowStyles[row.index] = normalized;
      this.updateSignalStyleIndicator(row.index);
      this.updateStyleControls();
      this.draw();
      this.scheduleBuild();
      this.markDraftDirty('presentation');
      this.setStatus(message);
    }

    applyWaveColor(presetColor) {
      const color = normalizeScopeColor(presetColor);
      if (!color) return;
      const row = this.meta.rows[this.activeCursorRow];
      this.changeRowStyle((style) => { style.waveColor = color; }, '已设置 ' + row.name + ' 的波形颜色');
    }

    resetWaveColor() {
      const row = this.meta.rows[this.activeCursorRow];
      this.changeRowStyle((style) => { style.waveColor = ''; }, '已恢复 ' + row.name + ' 的自动波形颜色');
    }

    applyRowBackground(presetColor) {
      const color = normalizeScopeColor(presetColor);
      if (!color) return;
      const row = this.meta.rows[this.activeCursorRow];
      this.changeRowStyle(
        (style) => { style.backgroundColor = color; },
        '已设置 ' + row.name + ' 的整行背景色'
      );
    }

    clearRowBackground() {
      const row = this.meta.rows[this.activeCursorRow];
      this.changeRowStyle(
        (style) => { style.backgroundColor = ''; },
        '已清除 ' + row.name + ' 的整行背景色'
      );
    }

    useCursorColumnSelection() {
      if (this.cursorA == null || this.cursorB == null) return;
      const maximum = Math.max(1, this.meta.totalColumns);
      const left = clamp(Math.min(this.cursorA, this.cursorB), 0, maximum - 1);
      const right = clamp(Math.max(this.cursorA, this.cursorB), 0, maximum);
      const start = clamp(Math.floor(left) + 1, 1, maximum);
      const end = Math.abs(right - left) < 1e-7
        ? start
        : clamp(Math.ceil(right), start, maximum);
      this.styleColumnsInput.value = start === end ? String(start) : start + '-' + end;
      this.updateColumnBackgroundAvailability();
      this.styleColumnsInput.focus();
      this.styleColumnsInput.select();
    }

    applyColumnBackground(clear) {
      const row = this.meta && this.meta.rows[this.activeCursorRow];
      if (!row) return;
      let selection;
      try {
        selection = parseColumnSelection(this.styleColumnsInput.value, this.meta.totalColumns);
      } catch (error) {
        this.setStatus(error.message || String(error), true);
        this.styleColumnsInput.focus();
        return;
      }
      const color = clear ? '' : normalizeScopeColor(this.columnBackgroundColor);
      if (!clear && !color) return;
      this.changeRowStyle((style) => {
        selection.forEach((range) => {
          style.backgroundRanges = overlayBackgroundRange(
            style.backgroundRanges,
            range.start,
            range.end,
            color
          );
        });
      }, (clear ? '已清除 ' : '已设置 ') + row.name + ' 指定列的背景色');
    }

    resizeCanvas(canvas, width, height) {
      const dpr = Math.max(1, Math.min(2, global.devicePixelRatio || 1));
      const cssWidth = Math.max(1, Math.floor(width));
      const cssHeight = Math.max(1, Math.floor(height));
      if (canvas.width !== Math.floor(cssWidth * dpr)
          || canvas.height !== Math.floor(cssHeight * dpr)) {
        canvas.width = Math.floor(cssWidth * dpr);
        canvas.height = Math.floor(cssHeight * dpr);
        canvas.style.width = cssWidth + 'px';
        canvas.style.height = cssHeight + 'px';
      }
      const context = canvas.getContext('2d');
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { context, width: cssWidth, height: cssHeight, dpr };
    }

    updateLayout() {
      if (!this.meta || !this.plotViewport.clientWidth) return;
      this.resizeCanvas(this.axisCanvas, this.plotViewport.clientWidth, AXIS_HEIGHT);
      this.resizeCanvas(
        this.plotCanvas,
        this.plotViewport.clientWidth,
        Math.max(1, this.plotViewport.clientHeight)
      );
      this.resizeCanvas(this.overviewCanvas, this.plotViewport.clientWidth, OVERVIEW_HEIGHT);
      this.positionPlotCanvas();
      this.scheduleWindowRequest();
      this.draw();
    }

    positionPlotCanvas() {
      this.plotCanvas.style.transform = 'translateY(' + this.plotViewport.scrollTop + 'px)';
    }

    visibleRows() {
      const scrollTop = this.plotViewport.scrollTop;
      const height = Math.max(1, this.plotViewport.clientHeight);
      const rowCount = this.meta.rows.length;
      const firstVisible = this.rowIndexAtOffset(scrollTop);
      const lastVisible = this.rowIndexAtOffset(scrollTop + height);
      const start = clamp(firstVisible - 1, 0, rowCount);
      const end = clamp(lastVisible + 2, start, rowCount);
      return { start, end };
    }

    setAnalogRowHeight(rowIndex, height, handle) {
      if (this.modes[rowIndex] !== 'analog') return false;
      const nextHeight = clamp(
        Math.round(Number(height) || DEFAULT_ROW_HEIGHT),
        MIN_ANALOG_ROW_HEIGHT,
        MAX_ANALOG_ROW_HEIGHT
      );
      if (this.rowHeight(rowIndex) === nextHeight) return false;
      this.rowHeights[rowIndex] = nextHeight;
      const row = this.signalList.querySelector(
        '[data-scope-signal-row="' + rowIndex + '"]'
      );
      if (row) row.style.height = nextHeight + 'px';
      const resizeHandle = handle || (row && row.querySelector('[data-scope-row-resize]'));
      if (resizeHandle) resizeHandle.setAttribute('aria-valuenow', String(nextHeight));
      this.rebuildRowOffsets();
      this.positionPlotCanvas();
      this.scheduleWindowRequest();
      this.draw();
      return true;
    }

    startRowResize(event, handle) {
      const rowIndex = Number(handle.dataset.scopeRowResize);
      if (!Number.isInteger(rowIndex) || this.modes[rowIndex] !== 'analog') return;
      event.preventDefault();
      event.stopPropagation();
      this.rowResize = {
        pointerId: event.pointerId,
        rowIndex,
        startY: event.clientY,
        startHeight: this.rowHeight(rowIndex),
        historySnapshot: this.snapshot(),
        handle
      };
      handle.classList.add('active');
      document.body.classList.add('scope-row-resizing');
      try { handle.setPointerCapture(event.pointerId); } catch (_error) {}
      this.setActiveCursorRow(rowIndex);
      this.log('scope-row-resize', {
        phase: 'start',
        rowIndex,
        height: this.rowResize.startHeight
      });
    }

    moveRowResize(event) {
      if (!this.rowResize || this.rowResize.pointerId !== event.pointerId) return;
      event.preventDefault();
      const nextHeight = this.rowResize.startHeight + event.clientY - this.rowResize.startY;
      this.setAnalogRowHeight(this.rowResize.rowIndex, nextHeight, this.rowResize.handle);
    }

    finishRowResize(event) {
      if (!this.rowResize || this.rowResize.pointerId !== event.pointerId) return;
      const resize = this.rowResize;
      try { resize.handle.releasePointerCapture(event.pointerId); } catch (_error) {}
      resize.handle.classList.remove('active');
      document.body.classList.remove('scope-row-resizing');
      this.rowResize = null;
      const height = this.rowHeight(resize.rowIndex);
      if (height !== resize.startHeight) {
        this.pushHistorySnapshot(resize.historySnapshot);
        this.markDraftDirty('presentation');
      }
      this.setStatus('已将 ' + this.meta.rows[resize.rowIndex].name + ' 行高设为 ' + height + ' px');
      this.log('scope-row-resize', {
        phase: 'complete',
        rowIndex: resize.rowIndex,
        height
      });
    }

    async requestWindow() {
      if (!this.meta || !this.plotViewport.clientWidth) return;
      const visible = this.visibleRows();
      const sequence = ++this.windowRequestSequence;
      try {
        const result = await this.worker.call('window', {
          start: this.viewStart,
          end: this.viewEnd,
          width: this.plotViewport.clientWidth,
          rowStart: visible.start,
          rowEnd: visible.end,
          modes: this.modes,
          analogFormats: this.analogFormats
        });
        if (sequence !== this.windowRequestSequence) return;
        this.rowStart = result.rowStart;
        this.rowEnd = result.rowEnd;
        this.windowData = result;
        this.draw();
      } catch (error) {
        if (sequence !== this.windowRequestSequence) return;
        this.setStatus(error.message || String(error), true);
        this.log('scope-view', { phase: 'window-error', message: error.message || String(error) });
      }
    }

    xForColumn(column, width) {
      return (column - this.viewStart) / Math.max(1e-9, this.viewEnd - this.viewStart) * width;
    }

    columnForX(x, width) {
      return this.viewStart + clamp(x / Math.max(1, width), 0, 1) * (this.viewEnd - this.viewStart);
    }

    formatTime(column) {
      const value = column * this.meta.samplePeriod;
      const rounded = Math.abs(value) >= 1000
        ? Math.round(value)
        : Math.round(value * 1000) / 1000;
      return rounded + ' ' + this.meta.timeUnit;
    }

    drawAxis() {
      const resized = this.resizeCanvas(this.axisCanvas, this.plotViewport.clientWidth, AXIS_HEIGHT);
      const context = resized.context;
      const width = resized.width;
      const height = resized.height;
      context.clearRect(0, 0, width, height);
      context.fillStyle = '#f7f8fa';
      context.fillRect(0, 0, width, height);
      context.strokeStyle = '#c8ccd2';
      context.beginPath();
      context.moveTo(0, height - 0.5);
      context.lineTo(width, height - 0.5);
      context.stroke();
      const span = this.viewEnd - this.viewStart;
      const step = niceStep(span / Math.max(2, Math.floor(width / 120)));
      const first = Math.ceil(this.viewStart / step) * step;
      context.font = '12px "Segoe UI", sans-serif';
      context.fillStyle = '#30343a';
      context.textAlign = 'center';
      context.textBaseline = 'top';
      for (let column = first; column <= this.viewEnd + step * 0.1; column += step) {
        const x = this.xForColumn(column, width);
        context.strokeStyle = '#8f959e';
        context.beginPath();
        context.moveTo(x + 0.5, height - 8);
        context.lineTo(x + 0.5, height);
        context.stroke();
        context.fillText(this.formatTime(column), x, 5);
      }
    }

    drawGrid(context, width, height) {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
    }

    drawGridLines(context, width, height) {
      const span = this.viewEnd - this.viewStart;
      const minor = niceStep(span / Math.max(4, Math.floor(width / 42)));
      const major = minor * 5;
      let first = Math.ceil(this.viewStart / minor) * minor;
      for (let column = first; column <= this.viewEnd + minor * 0.1; column += minor) {
        const x = this.xForColumn(column, width);
        const isMajor = Math.abs(column / major - Math.round(column / major)) < 1e-7;
        context.strokeStyle = isMajor ? '#d4d8dd' : '#eef0f2';
        context.beginPath();
        context.moveTo(Math.round(x) + 0.5, 0);
        context.lineTo(Math.round(x) + 0.5, height);
        context.stroke();
      }
    }

    drawRowBackground(context, rowIndex, rowTop, rowHeight, width) {
      const style = this.rowStyle(rowIndex);
      context.save();
      context.beginPath();
      context.rect(0, rowTop, width, rowHeight);
      context.clip();
      if (style.backgroundColor) {
        context.fillStyle = style.backgroundColor;
        context.fillRect(0, rowTop, width, rowHeight);
      }
      style.backgroundRanges.forEach((range) => {
        if (range.end <= this.viewStart || range.start >= this.viewEnd) return;
        const x1 = this.xForColumn(Math.max(range.start, this.viewStart), width);
        const x2 = this.xForColumn(Math.min(range.end, this.viewEnd), width);
        context.fillStyle = range.color;
        context.fillRect(x1, rowTop, Math.max(1, x2 - x1), rowHeight);
      });
      context.restore();
    }

    drawOverviewRowBackground(context, rowIndex, yTop, yBottom, width) {
      const style = this.rowStyle(rowIndex);
      if (style.backgroundColor) {
        context.fillStyle = style.backgroundColor;
        context.fillRect(0, yTop, width, Math.max(1, yBottom - yTop));
      }
      style.backgroundRanges.forEach((range) => {
        const x1 = range.start / Math.max(1, this.meta.totalColumns) * width;
        const x2 = range.end / Math.max(1, this.meta.totalColumns) * width;
        context.fillStyle = range.color;
        context.fillRect(x1, yTop, Math.max(1, x2 - x1), Math.max(1, yBottom - yTop));
      });
    }

    drawClockMarker(context, x, yTop, yBottom, edge, color) {
      const centerY = (yTop + yBottom) / 2;
      const direction = edge === 'falling' ? 1 : -1;
      context.fillStyle = color;
      context.beginPath();
      context.moveTo(x - 3.5, centerY - direction * 3.5);
      context.lineTo(x + 3.5, centerY - direction * 3.5);
      context.lineTo(x, centerY + direction * 3.5);
      context.closePath();
      context.fill();
    }

    drawWaveGap(context, x, yTop, yBottom) {
      context.save();
      context.fillStyle = '#ffffff';
      context.fillRect(x - 4, yTop, 8, Math.max(1, yBottom - yTop));
      context.strokeStyle = '#7b818a';
      context.lineWidth = 1.15;
      context.beginPath();
      [x - 2, x + 2].forEach((lineX) => {
        context.moveTo(lineX, yTop + 2);
        context.lineTo(lineX - 2, (yTop + yBottom) / 2);
        context.lineTo(lineX, yBottom - 2);
      });
      context.stroke();
      context.restore();
    }

    drawUnknownDigitalSegment(context, x1, x2, yTop, yBottom, lineWidth, compact) {
      const left = Math.min(x1, x2);
      const right = Math.max(x1, x2);
      const segmentWidth = Math.max(1, right - left);
      const inset = Math.min(5, Math.max(1, (yBottom - yTop) * 0.2));
      const highY = Math.min(yBottom, yTop + inset);
      const lowY = Math.max(yTop, yBottom - inset);
      const centerY = (highY + lowY) / 2;
      const hatchWidth = compact ? 8 : 14;
      context.save();
      context.fillStyle = 'rgba(111, 118, 128, 0.14)';
      context.fillRect(left, highY, segmentWidth, Math.max(1, lowY - highY));
      context.strokeStyle = '#60666f';
      context.lineWidth = lineWidth || 1.5;
      context.beginPath();
      context.moveTo(left, highY);
      context.lineTo(right, highY);
      context.moveTo(left, lowY);
      context.lineTo(right, lowY);
      if (segmentWidth >= (compact ? 3 : 7)) {
        for (let hatchX = left; hatchX < right; hatchX += hatchWidth) {
          const hatchRight = Math.min(right, hatchX + hatchWidth);
          context.moveTo(hatchX, highY);
          context.lineTo(hatchRight, lowY);
          context.moveTo(hatchX, lowY);
          context.lineTo(hatchRight, highY);
        }
      }
      context.stroke();
      if (!compact && segmentWidth >= 28) {
        context.fillStyle = '#4f555d';
        context.font = '600 10px "Segoe UI", sans-serif';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText('X', (left + right) / 2, centerY);
      }
      context.restore();
      return centerY;
    }

    drawDigitalDecorations(context, data, yTop, yBottom, width, color) {
      const highY = yTop + 5;
      const lowY = yBottom - 5;
      context.save();
      (data.clockEdges || []).forEach((clockEdge) => {
        const x = this.xForColumn(clockEdge.column, width);
        if (x < -2 || x > width + 2) return;
        context.strokeStyle = color;
        context.lineWidth = clockEdge.marked ? 2 : 1.5;
        context.beginPath();
        context.moveTo(x, clockEdge.edge === 'falling' ? highY : lowY);
        context.lineTo(x, clockEdge.edge === 'falling' ? lowY : highY);
        context.stroke();
        if (clockEdge.marked) {
          this.drawClockMarker(context, x, yTop, yBottom, clockEdge.edge, color);
        }
      });
      (data.gaps || []).forEach((column) => {
        const x = this.xForColumn(column, width);
        if (x < -4 || x > width + 4) return;
        this.drawWaveGap(context, x, yTop, yBottom);
      });
      context.restore();
    }

    drawSegments(context, rowResult, rowIndex, yTop, yBottom, width, color) {
      const data = rowResult.data;
      const mode = rowResult.mode;
      if (data.kind === 'points' || data.kind === 'envelope') {
        this.drawAnalog(context, data, yTop, yBottom, width, color);
        return;
      }
      if (data.kind === 'buckets') {
        data.items.forEach((bucket) => {
          const x1 = this.xForColumn(bucket.start, width);
          const x2 = this.xForColumn(bucket.end, width);
          if (bucket.bus) {
            context.fillStyle = 'rgba(0, 151, 167, 0.12)';
            context.fillRect(x1, yTop + 3, Math.max(1, x2 - x1), yBottom - yTop - 6);
            context.strokeStyle = color;
            context.strokeRect(x1, yTop + 3, Math.max(1, x2 - x1), yBottom - yTop - 6);
          } else {
            const highY = yTop + 5;
            const lowY = yBottom - 5;
            if (bucket.unknown) {
              this.drawUnknownDigitalSegment(context, x1, x2, yTop, yBottom, 1, true);
            }
            context.strokeStyle = color;
            context.beginPath();
            if (bucket.high) {
              context.moveTo(x1, highY);
              context.lineTo(x2, highY);
            }
            if (bucket.low) {
              context.moveTo(x1, lowY);
              context.lineTo(x2, lowY);
            }
            if (bucket.high && bucket.low) {
              context.moveTo((x1 + x2) / 2, highY);
              context.lineTo((x1 + x2) / 2, lowY);
            }
            context.stroke();
          }
        });
        if (mode === 'digital') {
          this.drawDigitalDecorations(context, data, yTop, yBottom, width, color);
        }
        return;
      }
      let previousY = null;
      data.items.forEach((segment) => {
        const x1 = this.xForColumn(segment.start, width);
        const x2 = this.xForColumn(segment.end, width);
        if (segment.kind === 'bus' || mode === 'bus') {
          const top = yTop + 5;
          const bottom = yBottom - 5;
          context.fillStyle = 'rgba(0, 151, 167, 0.08)';
          context.fillRect(x1, top, Math.max(1, x2 - x1), bottom - top);
          context.strokeStyle = color;
          context.beginPath();
          context.moveTo(x1, (top + bottom) / 2);
          context.lineTo(x1 + 4, top);
          context.lineTo(Math.max(x1 + 4, x2 - 4), top);
          context.lineTo(x2, (top + bottom) / 2);
          context.lineTo(Math.max(x1 + 4, x2 - 4), bottom);
          context.lineTo(x1 + 4, bottom);
          context.closePath();
          context.stroke();
          if (x2 - x1 > 38) {
            context.fillStyle = '#165d68';
            context.font = '11px "Segoe UI", sans-serif';
            context.textAlign = 'center';
            context.textBaseline = 'middle';
            const label = String(segment.value == null ? '' : segment.value);
            context.fillText(label.length > 18 ? label.slice(0, 17) + '…' : label, (x1 + x2) / 2, (top + bottom) / 2);
          }
          previousY = null;
          return;
        }
        const state = String(
          segment.state == null || segment.state === '' ? 'x' : segment.state
        ).toLowerCase();
        if (state === 'x') {
          previousY = this.drawUnknownDigitalSegment(
            context,
            x1,
            x2,
            yTop,
            yBottom,
            1.5,
            false
          );
          return;
        }
        const y = state === '1'
          ? yTop + 5
          : (state === '0' ? yBottom - 5 : (yTop + yBottom) / 2);
        context.strokeStyle = state === 'z' ? '#6f7680' : color;
        context.lineWidth = 1.5;
        context.setLineDash(state === 'z' ? [5, 3] : []);
        context.beginPath();
        if (previousY != null && Math.abs(previousY - y) > 0.5) {
          context.moveTo(x1, previousY);
          context.lineTo(x1, y);
        }
        context.moveTo(x1, y);
        context.lineTo(x2, y);
        context.stroke();
        context.setLineDash([]);
        previousY = y;
      });
      if (mode === 'digital') {
        this.drawDigitalDecorations(context, data, yTop, yBottom, width, color);
      }
    }

    drawAnalog(context, data, yTop, yBottom, width, color) {
      const range = data.range || { min: -1, max: 1 };
      const scale = Math.max(1e-12, range.max - range.min);
      const yFor = (value) => yBottom - 4
        - (value - range.min) / scale * Math.max(1, yBottom - yTop - 8);
      context.strokeStyle = color;
      context.lineWidth = 1.25;
      if (data.kind === 'envelope') {
        context.beginPath();
        data.items.forEach((item) => {
          const x = this.xForColumn(item[0], width);
          context.moveTo(x, yFor(item[1]));
          context.lineTo(x, yFor(item[2]));
        });
        context.stroke();
      } else {
        context.beginPath();
        let started = false;
        data.items.forEach((item) => {
          const x = this.xForColumn(item[0], width);
          const y = yFor(item[1]);
          if (!started) {
            context.moveTo(x, y);
            started = true;
          } else {
            context.lineTo(x, y);
          }
        });
        context.stroke();
      }
      context.strokeStyle = '#cfd3d8';
      context.setLineDash([3, 3]);
      context.beginPath();
      context.moveTo(0, (yTop + yBottom) / 2);
      context.lineTo(width, (yTop + yBottom) / 2);
      context.stroke();
      context.setLineDash([]);
    }

    drawSimplifiedRow(context, rowIndex, yTop, yBottom, width, color) {
      if (!this.simplified || !this.simplified.model.rows[rowIndex]) return;
      const row = this.simplified.model.rows[rowIndex];
      const columns = this.simplified.model.columns;
      if (!columns.length) return;
      const visible = [];
      for (let index = 0; index < columns.length; index += 1) {
        if (columns[index] < this.viewStart || columns[index] > this.viewEnd) continue;
        visible.push(index);
      }
      if (!visible.length) return;
      if (row.mode === 'analog') {
        let min = Number.POSITIVE_INFINITY;
        let max = Number.NEGATIVE_INFINITY;
        row.values.forEach((value) => {
          const number = Number(value);
          if (!Number.isFinite(number)) return;
          min = Math.min(min, number);
          max = Math.max(max, number);
        });
        if (!Number.isFinite(min) || !Number.isFinite(max)) return;
        if (Math.abs(max - min) < 1e-12) {
          min -= 1;
          max += 1;
        }
        context.strokeStyle = color;
        context.lineWidth = 1.7;
        context.beginPath();
        visible.forEach((pointIndex, index) => {
          const x = this.xForColumn(columns[pointIndex], width);
          const value = Number(row.values[pointIndex]);
          const y = yBottom - 4 - (value - min) / (max - min) * (yBottom - yTop - 8);
          if (!index) context.moveTo(x, y);
          else context.lineTo(x, y);
        });
        context.stroke();
      } else if (row.mode === 'bus') {
        const busSegments = [];
        columns.forEach((column, pointIndex) => {
          const value = String(
            row.labels && row.labels[pointIndex] != null
              ? row.labels[pointIndex]
              : (row.values[pointIndex] == null ? '' : row.values[pointIndex])
          );
          const end = pointIndex + 1 < columns.length
            ? columns[pointIndex + 1]
            : this.simplified.model.rangeEnd;
          const previous = busSegments[busSegments.length - 1];
          if (previous && previous.value === value && Math.abs(previous.end - column) < 1e-7) {
            previous.end = end;
          } else {
            busSegments.push({ start: column, end, value });
          }
        });
        busSegments.forEach((segment) => {
          if (segment.end <= this.viewStart || segment.start >= this.viewEnd) return;
          const x1 = this.xForColumn(Math.max(segment.start, this.viewStart), width);
          const x2 = this.xForColumn(Math.min(segment.end, this.viewEnd), width);
          context.fillStyle = 'rgba(0, 151, 167, 0.1)';
          context.fillRect(x1, yTop + 5, Math.max(1, x2 - x1), yBottom - yTop - 10);
          context.strokeStyle = color;
          context.strokeRect(x1, yTop + 5, Math.max(1, x2 - x1), yBottom - yTop - 10);
          if (x2 - x1 > 42) {
            context.fillStyle = '#165d68';
            context.font = '11px "Segoe UI", sans-serif';
            context.textAlign = 'center';
            context.textBaseline = 'middle';
            context.fillText(
              segment.value.length > 18 ? segment.value.slice(0, 17) + '…' : segment.value,
              (x1 + x2) / 2,
              (yTop + yBottom) / 2
            );
          }
        });
      } else {
        let previousY = null;
        visible.forEach((pointIndex, index) => {
          const x1 = this.xForColumn(columns[pointIndex], width);
          const nextPoint = visible[index + 1];
          const x2 = nextPoint == null ? width : this.xForColumn(columns[nextPoint], width);
          const symbol = row.symbols && /^[pPnN]$/.test(row.symbols[pointIndex] || '')
            ? row.symbols[pointIndex]
            : '';
          if (symbol) {
            const positive = symbol.toLowerCase() === 'p';
            const highY = yTop + 5;
            const lowY = yBottom - 5;
            const firstY = positive ? highY : lowY;
            const secondY = positive ? lowY : highY;
            const middleX = (x1 + x2) / 2;
            context.strokeStyle = color;
            context.lineWidth = 1.7;
            context.beginPath();
            if (previousY != null && Math.abs(previousY - firstY) > 0.5) {
              context.moveTo(x1, previousY);
              context.lineTo(x1, firstY);
            } else if (previousY == null) {
              context.moveTo(x1, secondY);
              context.lineTo(x1, firstY);
            }
            context.moveTo(x1, firstY);
            context.lineTo(middleX, firstY);
            context.lineTo(middleX, secondY);
            context.lineTo(x2, secondY);
            context.stroke();
            if (symbol === symbol.toUpperCase()) {
              this.drawClockMarker(
                context,
                x1,
                yTop,
                yBottom,
                positive ? 'rising' : 'falling',
                color
              );
            }
            if (row.gaps && row.gaps[pointIndex]) {
              this.drawWaveGap(context, middleX, yTop, yBottom);
            }
            previousY = secondY;
            return;
          }
          const rawState = row.values[pointIndex];
          const state = String(
            rawState == null || rawState === '' ? 'x' : rawState
          ).toLowerCase();
          if (state === 'x') {
            previousY = this.drawUnknownDigitalSegment(
              context,
              x1,
              x2,
              yTop,
              yBottom,
              1.7,
              false
            );
            return;
          }
          const y = state === '1'
            ? yTop + 5
            : (state === '0' ? yBottom - 5 : (yTop + yBottom) / 2);
          context.strokeStyle = state === 'z' ? '#6f7680' : color;
          context.lineWidth = 1.7;
          context.setLineDash(state === 'z' ? [5, 3] : []);
          context.beginPath();
          if (previousY != null && Math.abs(previousY - y) > 0.5) {
            context.moveTo(x1, previousY);
            context.lineTo(x1, y);
          }
          context.moveTo(x1, y);
          context.lineTo(x2, y);
          context.stroke();
          context.setLineDash([]);
          previousY = y;
          if (!index && x1 > 0) {
            context.beginPath();
            context.moveTo(0, y);
            context.lineTo(x1, y);
            context.stroke();
          }
        });
      }
      if (this.selectedPoint && this.selectedPoint.rowIndex === rowIndex) {
        const pointIndex = this.selectedPoint.pointIndex;
        const column = columns[pointIndex];
        if (column >= this.viewStart && column <= this.viewEnd) {
          const x = this.xForColumn(column, width);
          context.fillStyle = '#ffffff';
          context.strokeStyle = '#b3261e';
          context.lineWidth = 2;
          context.beginPath();
          context.arc(x, (yTop + yBottom) / 2, 5, 0, Math.PI * 2);
          context.fill();
          context.stroke();
        }
      }
    }

    drawCursors(context, width, height) {
      const cursors = [
        { name: 'A', column: this.cursorA, color: '#1f68d5' },
        { name: 'B', column: this.cursorB, color: '#d93025' }
      ].sort((left, right) => {
        if (left.name === this.activeCursor) return 1;
        if (right.name === this.activeCursor) return -1;
        return 0;
      });
      cursors.forEach((cursor) => {
        if (cursor.column == null || cursor.column < this.viewStart || cursor.column > this.viewEnd) return;
        const x = this.xForColumn(cursor.column, width);
        const active = cursor.name === this.activeCursor;
        context.strokeStyle = cursor.color;
        context.lineWidth = active ? 2.5 : 1.35;
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x, height);
        context.stroke();
        const labelX = clamp(x, 10, Math.max(10, width - 10));
        const labelHeight = active ? 20 : 17;
        context.fillStyle = cursor.color;
        context.fillRect(labelX - 10, 0, 20, labelHeight);
        context.fillStyle = '#ffffff';
        context.font = 'bold 11px "Segoe UI", sans-serif';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(cursor.name, labelX, labelHeight / 2);
      });
    }

    connectionPoint(column, rowIndex) {
      return {
        column: clamp(
          Math.round(Number(column) || 0),
          0,
          Math.max(0, this.meta.totalColumns)
        ),
        rowIndex: clamp(
          Math.floor(Number(rowIndex) || 0),
          0,
          Math.max(0, this.meta.rows.length - 1)
        )
      };
    }

    connectionPointForPosition(x, y, width) {
      const absoluteY = y + this.plotViewport.scrollTop;
      return this.connectionPoint(
        this.columnForX(x, width),
        this.rowIndexAtOffset(absoluteY)
      );
    }

    connectionGeometry(connection, width) {
      const start = connection.start;
      const end = connection.end;
      return {
        x1: this.xForColumn(start.column, width),
        y1: this.rowTop(start.rowIndex) - this.plotViewport.scrollTop
          + this.rowHeight(start.rowIndex) / 2,
        x2: this.xForColumn(end.column, width),
        y2: this.rowTop(end.rowIndex) - this.plotViewport.scrollTop
          + this.rowHeight(end.rowIndex) / 2
      };
    }

    connectionCycleLabel(start, end) {
      const cycles = Math.abs(end.column - start.column);
      return cycles + ' cycle';
    }

    pointToSegmentDistance(px, py, x1, y1, x2, y2) {
      const dx = x2 - x1;
      const dy = y2 - y1;
      const lengthSquared = dx * dx + dy * dy;
      if (lengthSquared < 1e-9) return Math.hypot(px - x1, py - y1);
      const ratio = clamp(
        ((px - x1) * dx + (py - y1) * dy) / lengthSquared,
        0,
        1
      );
      return Math.hypot(px - (x1 + ratio * dx), py - (y1 + ratio * dy));
    }

    connectionAtPoint(x, y, width) {
      for (let index = this.connections.length - 1; index >= 0; index -= 1) {
        const connection = this.connections[index];
        const geometry = this.connectionGeometry(connection, width);
        if (this.pointToSegmentDistance(
          x,
          y,
          geometry.x1,
          geometry.y1,
          geometry.x2,
          geometry.y2
        ) <= 7) {
          return connection;
        }
      }
      return null;
    }

    drawConnectionLabel(context, text, x, y, selected, width, height) {
      context.font = '600 11px "Segoe UI", "Microsoft YaHei", sans-serif';
      const labelWidth = Math.ceil(context.measureText(text).width) + 14;
      const labelHeight = 20;
      const centerX = clamp(x, labelWidth / 2 + 2, Math.max(labelWidth / 2 + 2, width - labelWidth / 2 - 2));
      const centerY = clamp(y - 13, labelHeight / 2 + 2, Math.max(labelHeight / 2 + 2, height - labelHeight / 2 - 2));
      const left = centerX - labelWidth / 2;
      const top = centerY - labelHeight / 2;
      context.fillStyle = selected ? '#eaf3ff' : 'rgba(255, 255, 255, 0.94)';
      context.strokeStyle = selected ? '#1769aa' : '#69727d';
      context.lineWidth = selected ? 1.5 : 1;
      context.beginPath();
      context.rect(left, top, labelWidth, labelHeight);
      context.fill();
      context.stroke();
      context.fillStyle = selected ? '#0d4f88' : '#31363d';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(text, centerX, centerY);
    }

    drawConnection(context, connection, width, height, selected, preview) {
      const geometry = this.connectionGeometry(connection, width);
      const minX = Math.min(geometry.x1, geometry.x2);
      const maxX = Math.max(geometry.x1, geometry.x2);
      const minY = Math.min(geometry.y1, geometry.y2);
      const maxY = Math.max(geometry.y1, geometry.y2);
      if (maxX < -10 || minX > width + 10 || maxY < -10 || minY > height + 10) return;
      context.save();
      context.strokeStyle = preview ? '#6e7781' : (selected ? '#1769aa' : '#3f4852');
      context.fillStyle = preview ? '#ffffff' : (selected ? '#1769aa' : '#3f4852');
      context.lineWidth = selected ? 3 : 2;
      if (preview) context.setLineDash([6, 4]);
      context.beginPath();
      context.moveTo(geometry.x1, geometry.y1);
      context.lineTo(geometry.x2, geometry.y2);
      context.stroke();
      context.setLineDash([]);
      [ [geometry.x1, geometry.y1], [geometry.x2, geometry.y2] ].forEach((point) => {
        context.beginPath();
        context.arc(point[0], point[1], selected ? 4.5 : 3.5, 0, Math.PI * 2);
        context.fill();
        if (preview) {
          context.strokeStyle = '#6e7781';
          context.stroke();
        }
      });
      this.drawConnectionLabel(
        context,
        this.connectionCycleLabel(connection.start, connection.end),
        (geometry.x1 + geometry.x2) / 2,
        (geometry.y1 + geometry.y2) / 2,
        selected,
        width,
        height
      );
      context.restore();
    }

    drawConnections(context, width, height) {
      this.connections.forEach((connection) => {
        this.drawConnection(
          context,
          connection,
          width,
          height,
          connection.id === this.selectedConnectionId,
          false
        );
      });
      if (!this.connectionMode || !this.connectionDraftStart) return;
      const end = this.connectionHover || this.connectionDraftStart;
      this.drawConnection(context, {
        start: this.connectionDraftStart,
        end
      }, width, height, false, true);
    }

    drawColumnSelection(context, width, height) {
      const selection = this.columnSelection;
      if (!selection || !this.meta.rows[selection.rowIndex]) return;
      const rowTop = this.rowTop(selection.rowIndex) - this.plotViewport.scrollTop;
      const rowHeight = this.rowHeight(selection.rowIndex);
      if (rowTop >= height || rowTop + rowHeight <= 0) return;
      if (selection.end <= this.viewStart || selection.start >= this.viewEnd) return;
      const x1 = clamp(this.xForColumn(selection.start, width), 0, width);
      const x2 = clamp(this.xForColumn(selection.end, width), 0, width);
      const left = Math.min(x1, x2);
      const right = Math.max(x1, x2);
      context.save();
      context.fillStyle = 'rgba(47, 115, 191, 0.16)';
      context.fillRect(left, rowTop, Math.max(1, right - left), rowHeight);
      context.strokeStyle = '#2f73bf';
      context.lineWidth = 1.5;
      context.strokeRect(
        left + 0.75,
        rowTop + 0.75,
        Math.max(0, right - left - 1.5),
        Math.max(0, rowHeight - 1.5)
      );
      context.restore();
    }

    draw() {
      if (!this.meta || !this.plotViewport.clientWidth) return;
      this.drawAxis();
      const resized = this.resizeCanvas(
        this.plotCanvas,
        this.plotViewport.clientWidth,
        Math.max(1, this.plotViewport.clientHeight)
      );
      const context = resized.context;
      const width = resized.width;
      const height = resized.height;
      this.drawGrid(context, width, height);
      const scrollTop = this.plotViewport.scrollTop;
      if (this.windowData) {
        this.windowData.rows.forEach((rowResult) => {
          const rowIndex = rowResult.index;
          const rowHeight = this.rowHeight(rowIndex);
          const rowTop = this.rowTop(rowIndex) - scrollTop;
          if (rowTop > height || rowTop + rowHeight < 0) return;
          this.drawRowBackground(context, rowIndex, rowTop, rowHeight, width);
        });
      }
      this.drawGridLines(context, width, height);
      if (this.windowData) {
        this.windowData.rows.forEach((rowResult) => {
          const rowIndex = rowResult.index;
          const rowHeight = this.rowHeight(rowIndex);
          const rowTop = this.rowTop(rowIndex) - scrollTop;
          if (rowTop > height || rowTop + rowHeight < 0) return;
          const color = this.rowWaveColor(rowIndex);
          context.strokeStyle = '#dfe2e6';
          context.beginPath();
          context.moveTo(0, rowTop + rowHeight - 0.5);
          context.lineTo(width, rowTop + rowHeight - 0.5);
          context.stroke();
          const simplifiedRow = this.simplified && this.simplified.model.rows[rowIndex];
          if (this.showOriginal && !simplifiedRow) {
            this.drawSegments(
              context,
              rowResult,
              rowIndex,
              rowTop + 3,
              rowTop + rowHeight - 3,
              width,
              color
            );
          } else if (this.showOriginal) {
            context.fillStyle = '#777d86';
            context.font = '10px "Segoe UI", sans-serif';
            context.textAlign = 'left';
            context.textBaseline = 'top';
            context.fillText('原', 4, rowTop + 3);
            context.fillText('简', 4, rowTop + rowHeight / 2 + 3);
            this.drawSegments(
              context,
              rowResult,
              rowIndex,
              rowTop + 2,
              rowTop + rowHeight / 2 - 2,
              width,
              color
            );
            this.drawSimplifiedRow(
              context,
              rowIndex,
              rowTop + rowHeight / 2 + 2,
              rowTop + rowHeight - 3,
              width,
              color
            );
          } else {
            this.drawSimplifiedRow(
              context,
              rowIndex,
              rowTop + 3,
              rowTop + rowHeight - 3,
              width,
              color
            );
          }
        });
      }
      this.drawColumnSelection(context, width, height);
      this.drawConnections(context, width, height);
      this.drawCursors(context, width, height);
      this.drawOverview();
    }

    drawOverview() {
      if (!this.meta || !this.overviewCanvas.clientWidth) return;
      const resized = this.resizeCanvas(this.overviewCanvas, this.plotViewport.clientWidth, OVERVIEW_HEIGHT);
      const context = resized.context;
      const width = resized.width;
      const height = resized.height;
      context.clearRect(0, 0, width, height);
      context.fillStyle = '#f8f9fa';
      context.fillRect(0, 0, width, height);
      const rows = this.simplified ? this.simplified.model.rows.slice(0, 8) : [];
      rows.forEach((row, rowIndex) => {
        const yTop = 5 + rowIndex * Math.max(6, (height - 10) / Math.max(1, rows.length));
        const yBottom = yTop + Math.max(4, (height - 14) / Math.max(1, rows.length) - 2);
        const color = this.rowWaveColor(rowIndex);
        this.drawOverviewRowBackground(context, rowIndex, yTop, yBottom, width);
        context.strokeStyle = color;
        context.lineWidth = 1;
        if (row.mode === 'digital') {
          let previousY = null;
          row.values.forEach((value, pointIndex) => {
            const column = this.simplified.model.columns[pointIndex];
            const nextColumn = pointIndex + 1 < this.simplified.model.columns.length
              ? this.simplified.model.columns[pointIndex + 1]
              : this.meta.totalColumns;
            const x1 = column / Math.max(1, this.meta.totalColumns) * width;
            const x2 = nextColumn / Math.max(1, this.meta.totalColumns) * width;
            const symbol = row.symbols && /^[pPnN]$/.test(row.symbols[pointIndex] || '')
              ? row.symbols[pointIndex]
              : '';
            if (symbol) {
              const positive = symbol.toLowerCase() === 'p';
              const firstY = positive ? yTop : yBottom;
              const secondY = positive ? yBottom : yTop;
              const middleX = (x1 + x2) / 2;
              context.beginPath();
              if (previousY != null && Math.abs(previousY - firstY) > 0.25) {
                context.moveTo(x1, previousY);
                context.lineTo(x1, firstY);
              } else if (previousY == null) {
                context.moveTo(x1, secondY);
                context.lineTo(x1, firstY);
              }
              context.moveTo(x1, firstY);
              context.lineTo(middleX, firstY);
              context.lineTo(middleX, secondY);
              context.lineTo(x2, secondY);
              context.stroke();
              if (row.gaps && row.gaps[pointIndex]) {
                this.drawWaveGap(context, middleX, yTop, yBottom);
              }
              previousY = secondY;
              return;
            }
            const state = String(value == null || value === '' ? 'x' : value).toLowerCase();
            if (state === 'x') {
              previousY = this.drawUnknownDigitalSegment(
                context,
                x1,
                x2,
                yTop,
                yBottom,
                1,
                true
              );
              return;
            }
            const y = state === '1'
              ? yTop
              : (state === '0' ? yBottom : (yTop + yBottom) / 2);
            context.strokeStyle = state === 'z' ? '#6f7680' : color;
            context.setLineDash(state === 'z' ? [3, 2] : []);
            context.beginPath();
            if (previousY != null && Math.abs(previousY - y) > 0.25) {
              context.moveTo(x1, previousY);
              context.lineTo(x1, y);
            }
            context.moveTo(x1, y);
            context.lineTo(x2, y);
            context.stroke();
            context.setLineDash([]);
            previousY = y;
          });
        } else {
          context.beginPath();
          row.values.forEach((value, pointIndex) => {
            const column = this.simplified.model.columns[pointIndex];
            const x = column / Math.max(1, this.meta.totalColumns - 1) * width;
            let y = (yTop + yBottom) / 2;
            if (row.mode === 'analog') {
              const number = Number(value);
              y = Number.isFinite(number)
                ? yBottom - clamp((number + 1) / 2, 0, 1) * (yBottom - yTop)
                : y;
            }
            if (!pointIndex) context.moveTo(x, y);
            else context.lineTo(x, y);
          });
          context.stroke();
        }
      });
      const x1 = this.viewStart / this.meta.totalColumns * width;
      const x2 = this.viewEnd / this.meta.totalColumns * width;
      context.fillStyle = 'rgba(31, 104, 213, 0.1)';
      context.fillRect(x1, 0, Math.max(2, x2 - x1), height);
      context.strokeStyle = '#1f68d5';
      context.lineWidth = 1.5;
      context.strokeRect(x1 + 0.5, 0.5, Math.max(1, x2 - x1 - 1), height - 1);
    }

    fit() {
      this.viewStart = 0;
      this.viewEnd = this.meta.totalColumns;
      this.scheduleWindowRequest();
      this.draw();
    }

    zoom(factor, anchorColumn) {
      const span = this.viewEnd - this.viewStart;
      const minimum = Math.min(1, this.meta.totalColumns);
      const nextSpan = clamp(span * factor, minimum, this.meta.totalColumns);
      const activeCursorColumn = this.activeCursorColumn();
      const cursorAnchor = activeCursorColumn == null ? NaN : Number(activeCursorColumn);
      const explicitAnchor = anchorColumn == null ? NaN : Number(anchorColumn);
      const viewCenter = (this.viewStart + this.viewEnd) / 2;
      const anchor = Number.isFinite(explicitAnchor)
        ? explicitAnchor
        : (Number.isFinite(cursorAnchor)
            && cursorAnchor >= this.viewStart
            && cursorAnchor <= this.viewEnd
          ? cursorAnchor
          : viewCenter);
      const ratio = span > 0
        ? clamp((anchor - this.viewStart) / span, 0, 1)
        : 0.5;
      let start = anchor - nextSpan * ratio;
      start = clamp(start, 0, Math.max(0, this.meta.totalColumns - nextSpan));
      this.viewStart = start;
      this.viewEnd = start + nextSpan;
      this.scheduleWindowRequest();
      this.draw();
    }

    pan(deltaColumns) {
      const span = this.viewEnd - this.viewStart;
      const start = clamp(
        this.viewStart + deltaColumns,
        0,
        Math.max(0, this.meta.totalColumns - span)
      );
      this.viewStart = start;
      this.viewEnd = start + span;
      this.scheduleWindowRequest();
      this.draw();
    }

    onPlotWheel(event) {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const rect = this.plotCanvas.getBoundingClientRect();
        const anchor = this.columnForX(event.clientX - rect.left, rect.width);
        this.zoom(event.deltaY < 0 ? 0.8 : 1.25, anchor);
        return;
      }
      if (event.shiftKey) {
        event.preventDefault();
        this.pan(event.deltaY / Math.max(1, this.plotCanvas.clientWidth) * (this.viewEnd - this.viewStart));
        return;
      }
      event.preventDefault();
      this.scrollPlotVertically(event.deltaY, event.deltaMode);
    }

    scrollPlotVertically(deltaY, deltaMode) {
      const unit = deltaMode === 1
        ? 16
        : (deltaMode === 2 ? Math.max(1, this.plotViewport.clientHeight) : 1);
      this.plotViewport.scrollTop += Number(deltaY || 0) * unit * 0.5;
    }

    columnIndexForX(x, width) {
      return clamp(
        Math.floor(this.columnForX(x, width)),
        0,
        Math.max(0, this.meta.totalColumns - 1)
      );
    }

    updateColumnSelection(rowIndex, anchorColumn, currentColumn) {
      const start = Math.min(anchorColumn, currentColumn);
      const end = Math.max(anchorColumn, currentColumn) + 1;
      this.columnSelection = { rowIndex, start, end };
      if (this.styleColumnsInput) {
        const first = start + 1;
        const last = end;
        this.styleColumnsInput.value = first === last ? String(first) : first + '-' + last;
      }
      this.closeColumnBackgroundPopover();
      this.updateColumnBackgroundAvailability();
    }

    onPlotPointerDown(event) {
      if (!this.meta.rows.length || (event.button !== 0 && event.button !== 1)) return;
      this.plotCanvas.focus({ preventScroll: true });
      const rect = this.plotCanvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const column = this.columnForX(x, rect.width);
      const absoluteY = y + this.plotViewport.scrollTop;
      const rowIndex = clamp(
        this.rowIndexAtOffset(absoluteY),
        0,
        this.meta.rows.length - 1
      );
      event.preventDefault();
      if (event.button === 1 || event.shiftKey) {
        this.drag = {
          kind: 'pan',
          pointerId: event.pointerId,
          startX: event.clientX,
          viewStart: this.viewStart,
          moved: false
        };
        this.plotCanvas.classList.add('dragging-pan');
        this.plotCanvas.setPointerCapture(event.pointerId);
        return;
      }
      const hitCursor = this.cursorAtX(x, rect.width);
      if (hitCursor) {
        this.setActiveCursor(hitCursor);
        this.setActiveCursorRow(rowIndex);
        this.drag = {
          kind: 'cursor',
          pointerId: event.pointerId,
          startX: event.clientX,
          rowIndex,
          column,
          moved: false
        };
        this.plotCanvas.classList.remove('cursor-hover');
        this.plotCanvas.classList.add('dragging-cursor');
        this.plotCanvas.setPointerCapture(event.pointerId);
        return;
      }
      if (this.connectionMode) {
        this.handleConnectionPoint(this.connectionPointForPosition(x, y, rect.width));
        return;
      }
      const hitConnection = this.connectionAtPoint(x, y, rect.width);
      if (hitConnection) {
        this.selectedConnectionId = hitConnection.id;
        this.columnSelection = null;
        this.selectedPoint = null;
        this.updatePointEditor();
        this.draw();
        this.setStatus('已选择连接线：' + hitConnection.label + '，按 Del 删除');
        this.log('scope-connection', {
          phase: 'select',
          id: hitConnection.id,
          label: hitConnection.label
        });
        return;
      }
      if (this.selectedConnectionId) this.selectedConnectionId = '';
      const columnIndex = this.columnIndexForX(x, rect.width);
      this.setActiveCursorRow(rowIndex);
      this.updateColumnSelection(rowIndex, columnIndex, columnIndex);
      this.selectedPoint = null;
      this.updatePointEditor();
      const rowHeight = this.rowHeight(rowIndex);
      const rowLocalY = absoluteY - this.rowTop(rowIndex);
      const selectPoint = this.simplified && (!this.showOriginal || rowLocalY >= rowHeight / 2)
        ? { rowIndex, column }
        : null;
      this.drag = {
        kind: 'columns',
        pointerId: event.pointerId,
        startX: event.clientX,
        rowIndex,
        anchorColumn: columnIndex,
        moved: false,
        selectPoint
      };
      this.draw();
      this.plotCanvas.setPointerCapture(event.pointerId);
    }

    onPlotPointerMove(event) {
      const rect = this.plotCanvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      if (!this.drag) {
        this.plotCanvas.classList.toggle('cursor-hover', !!this.cursorAtX(x, rect.width));
        if (this.connectionMode && this.connectionDraftStart) {
          const y = event.clientY - rect.top;
          const next = this.connectionPointForPosition(x, y, rect.width);
          if (!this.connectionHover
              || next.column !== this.connectionHover.column
              || next.rowIndex !== this.connectionHover.rowIndex) {
            this.connectionHover = next;
            this.draw();
          }
        }
        return;
      }
      if (this.drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      if (this.drag.kind === 'cursor') {
        const column = this.columnForX(x, rect.width);
        if (Math.abs(event.clientX - this.drag.startX) > 2) this.drag.moved = true;
        this.drag.column = column;
        this.setActiveCursorPosition(Math.round(column * 2) / 2, true);
        return;
      }
      if (this.drag.kind === 'columns') {
        const columnIndex = this.columnIndexForX(x, rect.width);
        this.drag.moved = this.drag.moved
          || columnIndex !== this.drag.anchorColumn
          || Math.abs(event.clientX - this.drag.startX) > 3;
        this.updateColumnSelection(
          this.drag.rowIndex,
          this.drag.anchorColumn,
          columnIndex
        );
        this.draw();
        return;
      }
      const delta = event.clientX - this.drag.startX;
      if (Math.abs(delta) > 3) this.drag.moved = true;
      const span = this.viewEnd - this.viewStart;
      const start = clamp(
        this.drag.viewStart - delta / Math.max(1, this.plotCanvas.clientWidth) * span,
        0,
        Math.max(0, this.meta.totalColumns - span)
      );
      this.viewStart = start;
      this.viewEnd = start + span;
      this.scheduleWindowRequest();
      this.draw();
    }

    onPlotPointerUp(event) {
      if (!this.drag || this.drag.pointerId !== event.pointerId) return;
      const drag = this.drag;
      try { this.plotCanvas.releasePointerCapture(event.pointerId); } catch (_error) {}
      this.drag = null;
      this.plotCanvas.classList.remove('dragging-pan', 'dragging-cursor', 'cursor-hover');
      if (drag.kind === 'cursor') {
        if (drag.moved) {
          void this.snapActiveCursorPosition(drag.column, drag.rowIndex);
        } else {
          void this.updateCursorReadout();
          this.draw();
        }
        return;
      }
      if (drag.kind !== 'columns') return;
      const selection = this.columnSelection;
      if (!drag.moved && drag.selectPoint) {
        this.selectNearestPoint(drag.selectPoint.rowIndex, drag.selectPoint.column);
      } else {
        this.selectedPoint = null;
        this.updatePointEditor();
        this.draw();
      }
      if (selection) {
        const row = this.meta.rows[selection.rowIndex];
        const count = selection.end - selection.start;
        this.setStatus(
          '已选择 ' + row.name + ' 的第 '
          + (selection.start + 1)
          + (count > 1 ? ('-' + selection.end) : '')
          + ' 列'
        );
      }
    }

    cancelPlotDrag(event) {
      if (!this.drag || this.drag.pointerId !== event.pointerId) return;
      try { this.plotCanvas.releasePointerCapture(event.pointerId); } catch (_error) {}
      this.drag = null;
      this.plotCanvas.classList.remove('dragging-pan', 'dragging-cursor', 'cursor-hover');
      this.draw();
    }

    scheduleOverviewWindowRequest() {
      this.overviewWindowRequestQueued = true;
      if (this.overviewWindowRequestFrame || this.overviewWindowRequestInFlight) return;
      this.overviewWindowRequestFrame = global.requestAnimationFrame(() => {
        this.overviewWindowRequestFrame = 0;
        void this.flushOverviewWindowRequest();
      });
    }

    async flushOverviewWindowRequest() {
      if (this.overviewWindowRequestInFlight) return;
      this.overviewWindowRequestQueued = false;
      this.overviewWindowRequestInFlight = true;
      try {
        await this.requestWindow();
      } finally {
        this.overviewWindowRequestInFlight = false;
        if (this.overviewWindowRequestQueued) this.scheduleOverviewWindowRequest();
      }
    }

    updateOverviewDrag(clientX) {
      if (!this.overviewDrag) return false;
      const rect = this.overviewCanvas.getBoundingClientRect();
      const ratio = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
      const totalColumns = this.meta.totalColumns;
      const span = Math.min(this.overviewDrag.span, totalColumns);
      const pointerColumn = ratio * totalColumns;
      const start = clamp(
        pointerColumn - this.overviewDrag.offsetColumns,
        0,
        Math.max(0, totalColumns - span)
      );
      if (Math.abs(start - this.viewStart) < 1e-9) return false;
      this.viewStart = start;
      this.viewEnd = start + span;
      this.scheduleOverviewWindowRequest();
      this.draw();
      return true;
    }

    onOverviewPointerDown(event) {
      if (!this.meta || event.button !== 0) return;
      event.preventDefault();
      const rect = this.overviewCanvas.getBoundingClientRect();
      const totalColumns = Math.max(1, this.meta.totalColumns);
      const span = Math.min(this.viewEnd - this.viewStart, totalColumns);
      const pointerColumn = clamp(
        (event.clientX - rect.left) / Math.max(1, rect.width),
        0,
        1
      ) * totalColumns;
      const insideWindow = pointerColumn >= this.viewStart && pointerColumn <= this.viewEnd;
      this.overviewDrag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        span,
        offsetColumns: insideWindow ? pointerColumn - this.viewStart : span / 2,
        moved: false
      };
      this.overviewCanvas.classList.add('dragging-window');
      try { this.overviewCanvas.setPointerCapture(event.pointerId); } catch (_error) {}
      if (!insideWindow) this.updateOverviewDrag(event.clientX);
      this.setStatus('拖动全局预览框定位波形');
    }

    onOverviewPointerMove(event) {
      if (!this.overviewDrag || this.overviewDrag.pointerId !== event.pointerId) return;
      event.preventDefault();
      if (Math.abs(event.clientX - this.overviewDrag.startX) > 2) {
        this.overviewDrag.moved = true;
      }
      this.updateOverviewDrag(event.clientX);
    }

    onOverviewWheel(event) {
      if (!this.meta || !this.meta.totalColumns) return;
      event.preventDefault();
      if (this.overviewDrag) return;
      this.zoom(event.deltaY < 0 ? 0.8 : 1.25);
      this.setStatus(
        '当前窗口：第 ' + (Math.floor(this.viewStart) + 1)
        + '-' + Math.ceil(this.viewEnd) + ' 列'
      );
    }

    finishOverviewDrag(event, canceled) {
      if (!this.overviewDrag || this.overviewDrag.pointerId !== event.pointerId) return;
      if (!canceled) this.updateOverviewDrag(event.clientX);
      try { this.overviewCanvas.releasePointerCapture(event.pointerId); } catch (_error) {}
      const moved = this.overviewDrag.moved;
      this.overviewDrag = null;
      this.overviewCanvas.classList.remove('dragging-window');
      this.scheduleOverviewWindowRequest();
      this.draw();
      if (moved) {
        this.setStatus(
          '当前窗口：第 ' + (Math.floor(this.viewStart) + 1)
          + '-' + Math.ceil(this.viewEnd) + ' 列'
        );
      }
    }

    toggleConnectionMode() {
      this.setConnectionMode(!this.connectionMode);
      this.setStatus(this.connectionMode
        ? '连接线模式：依次单击起点和终点，端点吸附到 cycle 边界'
        : '已退出连接线模式；单击连接线可选中，按 Del 删除');
    }

    setConnectionMode(enabled) {
      const next = !!enabled;
      this.connectionMode = next;
      if (this.connectionMode) {
        this.columnSelection = null;
        this.selectedPoint = null;
        this.selectedConnectionId = '';
        this.updatePointEditor();
      } else {
        this.connectionDraftStart = null;
        this.connectionHover = null;
      }
      this.connectionButton.classList.toggle('active', this.connectionMode);
      this.connectionButton.setAttribute('aria-pressed', String(this.connectionMode));
      this.connectionButton.textContent = this.connectionMode ? '退出连接线' : '连接线';
      this.plotCanvas.classList.toggle('connection-mode', this.connectionMode);
      this.draw();
      this.log('scope-connection', {
        phase: 'mode',
        enabled: this.connectionMode
      });
    }

    handleConnectionPoint(point) {
      if (!this.connectionDraftStart) {
        this.selectedConnectionId = '';
        this.connectionDraftStart = point;
        this.connectionHover = point;
        this.draw();
        this.setStatus(
          '连接线起点：第 ' + (point.rowIndex + 1) + ' 行，cycle ' + point.column
          + '；请选择终点'
        );
        this.log('scope-connection', {
          phase: 'start',
          rowIndex: point.rowIndex,
          column: point.column
        });
        return;
      }
      const start = this.connectionDraftStart;
      if (start.column === point.column && start.rowIndex === point.rowIndex) {
        this.setStatus('起点和终点不能完全重合，请重新选择终点', true);
        return;
      }
      const id = 'scope-connection-' + (++this.connectionSequence);
      const connection = {
        id,
        start,
        end: point,
        label: this.connectionCycleLabel(start, point)
      };
      this.pushHistory();
      this.connections.push(connection);
      this.selectedConnectionId = id;
      this.connectionDraftStart = null;
      this.connectionHover = null;
      this.draw();
      this.setStatus(
        '已添加连接线：' + connection.label
        + '；可继续选择起点，按 Del 删除当前连接线'
      );
      this.log('scope-connection', {
        phase: 'create',
        id,
        start,
        end: point,
        cycles: Math.abs(point.column - start.column)
      });
    }

    deleteSelectedConnection() {
      const id = this.selectedConnectionId;
      if (!id) return;
      const index = this.connections.findIndex((connection) => connection.id === id);
      if (index < 0) {
        this.selectedConnectionId = '';
        return;
      }
      this.pushHistory();
      const removed = this.connections.splice(index, 1)[0];
      this.selectedConnectionId = '';
      this.draw();
      this.setStatus('已删除连接线：' + removed.label);
      this.log('scope-connection', {
        phase: 'delete',
        id: removed.id,
        label: removed.label
      });
    }

    toggleOriginalData() {
      this.showOriginal = !this.showOriginal;
      this.originalDataButton.classList.toggle('active', this.showOriginal);
      this.originalDataButton.setAttribute('aria-pressed', String(this.showOriginal));
      this.originalDataButton.textContent = this.showOriginal ? '原始数据 On' : '原始数据 Off';
      this.draw();
      this.setStatus(this.showOriginal ? '已显示原始数据对比' : '已隐藏原始数据');
    }

    activeCursorColumn() {
      return this.activeCursor === 'B' ? this.cursorB : this.cursorA;
    }

    cursorAtX(x, width) {
      const candidates = [
        { name: 'A', x: this.xForColumn(this.cursorA, width) },
        { name: 'B', x: this.xForColumn(this.cursorB, width) }
      ].filter((cursor) => (
        Number.isFinite(cursor.x) && Math.abs(cursor.x - x) <= CURSOR_HIT_RADIUS
      ));
      if (!candidates.length) return '';
      if (candidates.length > 1
          && Math.abs(candidates[0].x - candidates[1].x) < 1) {
        return this.activeCursor === 'A' ? 'B' : 'A';
      }
      candidates.sort((left, right) => Math.abs(left.x - x) - Math.abs(right.x - x));
      return candidates[0].name;
    }

    setActiveCursor(name, centerView) {
      const next = name === 'B' ? 'B' : 'A';
      this.cursorNavigationSequence += 1;
      this.activeCursor = next;
      this.updateCursorControls();
      this.updateMeasurements();
      void this.updateCursorReadout();
      const column = next === 'B' ? this.cursorB : this.cursorA;
      if (centerView) {
        this.centerViewOnColumn(column);
      }
      this.draw();
      this.setStatus(centerView && column != null
        ? '当前工作游标：' + next + '，视图已定位到 ' + this.formatTime(column)
        : '当前工作游标：' + next);
    }

    setActiveCursorPosition(column, realtimeReadout) {
      this.cursorNavigationSequence += 1;
      const value = clamp(
        Number(column) || 0,
        0,
        Math.max(0, this.meta.totalColumns - 1e-7)
      );
      if (this.activeCursor === 'B') this.cursorB = value;
      else this.cursorA = value;
      this.updateMeasurements();
      if (realtimeReadout) this.scheduleCursorReadout();
      else void this.updateCursorReadout();
      this.draw();
    }

    async snapActiveCursorPosition(column, rowIndex) {
      if (!this.meta.rows.length) return;
      const index = clamp(
        Math.floor(Number(rowIndex) || 0),
        0,
        this.meta.rows.length - 1
      );
      const row = this.meta.rows[index];
      const sequence = ++this.cursorNavigationSequence;
      try {
        const result = await this.worker.call('snap', {
          rowIndex: index,
          column,
          mode: this.modes[index] || row.mode,
          analogFormat: this.analogFormats[index]
        });
        if (sequence !== this.cursorNavigationSequence) return;
        this.setActiveCursorPosition(result.column);
        this.setStatus(
          this.activeCursor + ' 已吸附到 ' + row.name + ' 的边沿 '
          + this.formatTime(result.column)
        );
      } catch (error) {
        if (sequence !== this.cursorNavigationSequence) return;
        this.log('scope-cursor', {
          phase: 'snap-error',
          rowIndex: index,
          column,
          message: error.message || String(error)
        });
        this.setStatus('游标边沿吸附失败：' + (error.message || String(error)), true);
      }
    }

    setActiveCursorRow(rowIndex) {
      const next = clamp(
        Math.floor(Number(rowIndex) || 0),
        0,
        Math.max(0, this.meta.rows.length - 1)
      );
      this.cursorNavigationSequence += 1;
      this.activeCursorRow = next;
      this.signalList.querySelectorAll('[data-scope-signal-row]').forEach((row) => {
        row.classList.toggle('active', Number(row.dataset.scopeSignalRow) === next);
      });
      this.updateCursorControls();
      void this.updateCursorReadout();
      this.setStatus('游标跳转信号：' + (this.meta.rows[next] ? this.meta.rows[next].name : ''));
    }

    updateCursorControls() {
      if (!this.cursorAButton || !this.cursorBButton) return;
      const activeA = this.activeCursor === 'A';
      this.cursorAButton.classList.toggle('active', activeA);
      this.cursorBButton.classList.toggle('active', !activeA);
      this.cursorAButton.setAttribute('aria-pressed', String(activeA));
      this.cursorBButton.setAttribute('aria-pressed', String(!activeA));
      const row = this.meta && this.meta.rows[this.activeCursorRow];
      this.cursorSignalEl.textContent = row ? row.name : '';
      this.cursorSignalEl.title = row ? row.name : '';
      this.updateAnalogControls();
      this.updateStyleControls();
    }

    updateAnalogControls() {
      if (!this.analogTypeSelect || !this.meta) return;
      const row = this.meta.rows[this.activeCursorRow];
      const enabled = !!row && this.modes[row.index] === 'analog';
      const format = normalizeAnalogFormat(
        row && this.analogFormats[row.index],
        row && row.detectedMode === 'analog' ? 'float' : 'unsigned'
      );
      if (row) this.analogFormats[row.index] = format;
      this.analogTypeSelect.value = format.type;
      this.analogWidthInput.value = String(format.bitWidth);
      this.analogFractionInput.value = String(format.fractionalBits);
      this.analogTypeSelect.disabled = !enabled;
      this.analogWidthInput.disabled = !enabled;
      const fixedPoint = format.type === 'ufixed' || format.type === 'sfixed';
      this.analogFractionInput.disabled = !enabled || !fixedPoint;
      this.analogFractionInput.max = String(Math.max(0, format.bitWidth - 1));
    }

    applyAnalogFormatControls() {
      if (!this.meta) return;
      const row = this.meta.rows[this.activeCursorRow];
      if (!row || this.modes[row.index] !== 'analog') {
        this.updateAnalogControls();
        return;
      }
      const previous = normalizeAnalogFormat(
        this.analogFormats[row.index],
        row.detectedMode === 'analog' ? 'float' : 'unsigned'
      );
      const next = normalizeAnalogFormat({
        type: this.analogTypeSelect.value,
        bitWidth: this.analogWidthInput.value,
        fractionalBits: this.analogFractionInput.value
      }, previous.type);
      const changed = previous.type !== next.type
        || previous.bitWidth !== next.bitWidth
        || previous.fractionalBits !== next.fractionalBits;
      if (!changed) {
        this.analogFormats[row.index] = next;
        this.updateAnalogControls();
        return;
      }
      if (this.simplified) this.pushHistory();
      this.analogFormats[row.index] = next;
      this.markDraftDirty('presentation');
      this.updateAnalogControls();
      this.cursorNavigationSequence += 1;
      this.scheduleWindowRequest();
      void this.updateCursorReadout();
      void this.runSimplify(false);
      this.setStatus('已按 ' + this.analogTypeSelect.options[this.analogTypeSelect.selectedIndex].text
        + ' 解析 ' + row.name);
    }

    formatCursorValue(value) {
      if (value == null || value === '') return '--';
      if (typeof value === 'number') {
        return String(Math.round(value * 1000000) / 1000000);
      }
      return String(value);
    }

    scheduleCursorReadout() {
      this.cursorReadoutQueued = true;
      if (this.cursorReadoutFrame || this.cursorReadoutInFlight) return;
      this.cursorReadoutFrame = global.requestAnimationFrame(() => {
        this.cursorReadoutFrame = 0;
        void this.flushCursorReadout();
      });
    }

    async flushCursorReadout() {
      if (this.cursorReadoutInFlight) return;
      this.cursorReadoutQueued = false;
      this.cursorReadoutInFlight = true;
      try {
        await this.updateCursorReadout();
      } finally {
        this.cursorReadoutInFlight = false;
        if (this.cursorReadoutQueued) this.scheduleCursorReadout();
      }
    }

    async updateCursorReadout() {
      if (!this.meta || !this.signalList) return;
      const column = this.activeCursorColumn();
      if (column == null) return;
      const sequence = ++this.cursorInspectSequence;
      try {
        const result = await this.worker.call('inspect', {
          column,
          modes: this.modes,
          analogFormats: this.analogFormats
        });
        if (sequence !== this.cursorInspectSequence) return;
        result.rows.forEach((row) => {
          const target = this.signalList.querySelector(
            '[data-scope-cursor-value-row="' + row.index + '"]'
          );
          if (!target) return;
          target.textContent = this.activeCursor + '：' + this.formatCursorValue(row.value);
          target.title = this.activeCursor + ' @ ' + this.formatTime(result.column)
            + ' = ' + this.formatCursorValue(row.value);
        });
      } catch (error) {
        this.log('scope-cursor', {
          phase: 'inspect-error',
          message: error.message || String(error)
        });
      }
    }

    centerViewOnColumn(column) {
      const numericColumn = Number(column);
      if (!this.meta || !Number.isFinite(numericColumn)) return false;
      const totalColumns = Math.max(1, this.meta.totalColumns);
      const span = Math.min(
        Math.max(1e-9, this.viewEnd - this.viewStart),
        totalColumns
      );
      const start = clamp(
        numericColumn - span / 2,
        0,
        Math.max(0, totalColumns - span)
      );
      if (Math.abs(start - this.viewStart) < 1e-9) return false;
      this.viewStart = start;
      this.viewEnd = start + span;
      this.scheduleWindowRequest();
      return true;
    }

    ensureCursorVisible(column) {
      if (column >= this.viewStart && column <= this.viewEnd) return;
      this.centerViewOnColumn(column);
    }

    async navigateActiveCursor(kind, direction) {
      if (!this.meta.rows.length) return;
      const row = this.meta.rows[this.activeCursorRow];
      const mode = this.modes[this.activeCursorRow] || row.mode;
      const value = this.cursorValueInput.value.trim();
      const condition = this.cursorConditionInput.value.trim();
      if (kind === 'value' && !value) {
        this.setStatus('请先输入要跳转的值', true);
        this.cursorValueInput.focus();
        return;
      }
      if (kind === 'value' && mode === 'analog' && !Number.isFinite(Number(value))) {
        this.setStatus('模拟信号的目标值必须是数字', true);
        return;
      }
      if (kind === 'value' && mode === 'digital' && !/^[01xzhHlL]$/.test(value)) {
        this.setStatus('数字信号的目标值支持 0、1、x、z、h、l', true);
        return;
      }
      if (kind === 'condition' && !condition) {
        this.setStatus('请先输入游标跳转条件', true);
        this.cursorConditionInput.focus();
        return;
      }
      const sequence = ++this.cursorNavigationSequence;
      try {
        const result = await this.worker.call('navigate', {
          rowIndex: this.activeCursorRow,
          column: this.activeCursorColumn(),
          direction,
          kind,
          value,
          condition,
          mode,
          analogFormat: this.analogFormats[this.activeCursorRow]
        });
        if (sequence !== this.cursorNavigationSequence) return;
        if (!result.found) {
          this.setStatus(
            (direction < 0 ? '前方' : '后方')
            + '没有匹配的'
            + (kind === 'edge' ? '边沿' : (kind === 'condition' ? '条件成立边沿' : '值')),
            true
          );
          return;
        }
        this.setActiveCursorPosition(result.column);
        this.ensureCursorVisible(result.column);
        this.draw();
        this.setStatus(
          this.activeCursor + ' 已跳到 ' + row.name + ' 的'
          + (kind === 'edge'
            ? '边沿'
            : (kind === 'condition' ? ('条件成立边沿 ' + condition) : ('值 ' + value)))
        );
      } catch (error) {
        if (sequence !== this.cursorNavigationSequence) return;
        this.setStatus('游标跳转失败：' + (error.message || String(error)), true);
        this.log('scope-cursor', {
          phase: 'navigate-error',
          kind,
          direction,
          message: error.message || String(error)
        });
      }
    }

    updateMeasurements() {
      const aText = this.cursorA == null ? 'A：未设置' : 'A：' + this.formatTime(this.cursorA);
      const bText = this.cursorB == null ? 'B：未设置' : 'B：' + this.formatTime(this.cursorB);
      let deltaText = 'Δt：--';
      let frequencyText = '';
      if (this.cursorA != null && this.cursorB != null) {
        const delta = Math.abs(this.cursorB - this.cursorA) * this.meta.samplePeriod;
        deltaText = 'Δt：' + (Math.round(delta * 1000000) / 1000000) + ' ' + this.meta.timeUnit;
        if (delta > 0) frequencyText = ' · 1/Δt：' + (Math.round(1000000 / delta) / 1000000);
      }
      this.measurementsEl.innerHTML = `
        <span class="${this.activeCursor === 'A' ? 'active' : ''}">${escapeHtml(aText)}</span>
        <span class="${this.activeCursor === 'B' ? 'active' : ''}">${escapeHtml(bText)}</span>
        <strong>${escapeHtml(deltaText + frequencyText)}</strong>
      `;
    }

    useCurrentViewRange() {
      this.rangeStartInput.value = String(Math.max(1, Math.floor(this.viewStart) + 1));
      this.rangeEndInput.value = String(Math.min(this.meta.totalColumns, Math.ceil(this.viewEnd)));
      this.setStatus('简化范围已设为当前窗口');
    }

    getSimplifyOptions() {
      const target = clamp(
        Math.floor(Number(this.targetInput.value) || 100),
        2,
        Math.max(2, this.meta.totalColumns)
      );
      const start = clamp(
        Math.floor(Number(this.rangeStartInput.value) || 1) - 1,
        0,
        this.meta.totalColumns - 1
      );
      const end = clamp(
        Math.floor(Number(this.rangeEndInput.value) || this.meta.totalColumns),
        start + 1,
        this.meta.totalColumns
      );
      this.targetInput.value = String(target);
      this.rangeStartInput.value = String(start + 1);
      this.rangeEndInput.value = String(end);
      return {
        targetPoints: Math.min(target, Math.max(2, end - start)),
        rangeStart: start,
        rangeEnd: end,
        method: this.methodSelect.value,
        modes: this.modes,
        analogFormats: this.analogFormats,
        rowStyles: this.rowStyles,
        rowHeights: this.rowHeights,
        lockedColumns: Array.from(this.lockedColumns),
        outputTitle: this.outputTitleInput.value.trim() || (this.meta.title + ' - 展示实例'),
        sourceWaveId: this.document.name,
        sourceRevision: this.document.revision || 0
      };
    }

    async runSimplify(recordHistory) {
      if (!this.meta) return;
      if (recordHistory && this.simplified) this.pushHistory();
      this.setStatus('正在生成简化实例');
      try {
        const options = this.getSimplifyOptions();
        const result = await this.worker.call('simplify', options);
        this.simplified = result;
        this.outputContent = result.content;
        this.outputTitleInput.value = result.model.title;
        this.selectedPoint = null;
        this.updatePointEditor();
        this.updateMetrics(result.metrics);
        this.redoStack = [];
        this.updateHistoryButtons();
        this.draw();
        if (recordHistory) this.markDraftDirty('data');
        this.setStatus('简化实例已生成，可单击简化波形继续编辑');
        this.log('scope-simplify', Object.assign({
          phase: 'complete',
          method: options.method
        }, result.metrics));
      } catch (error) {
        this.setStatus('生成简化实例失败：' + (error.message || String(error)), true);
        this.log('scope-simplify', { phase: 'error', message: error.message || String(error) });
      }
    }

    updateMetrics(metrics) {
      if (!metrics) {
        this.metricsEl.textContent = '';
        return;
      }
      const ratio = metrics.originalPoints
        ? (100 * metrics.simplifiedPoints / metrics.originalPoints)
        : 100;
      const parts = [
        '原始 ' + metrics.originalPoints + ' 点',
        '简化 ' + metrics.simplifiedPoints + ' 点',
        '保留 ' + (Math.round(ratio * 100) / 100) + '%'
      ];
      if (metrics.digitalTransitions != null) parts.push('数字跳变 ' + metrics.digitalTransitions);
      if (metrics.busTransitions != null) parts.push('总线变化 ' + metrics.busTransitions);
      if (metrics.analogMaxError != null) parts.push('模拟最大误差 ' + metrics.analogMaxError);
      this.metricsEl.textContent = parts.join(' · ');
    }

    selectNearestPoint(rowIndex, column) {
      const columns = this.simplified.model.columns;
      if (!columns.length) return;
      let low = 0;
      let high = columns.length - 1;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (columns[middle] < column) low = middle + 1;
        else high = middle;
      }
      let pointIndex = low;
      if (pointIndex > 0
          && Math.abs(columns[pointIndex - 1] - column) < Math.abs(columns[pointIndex] - column)) {
        pointIndex -= 1;
      }
      this.selectedPoint = { rowIndex, pointIndex };
      this.updatePointEditor();
      this.draw();
    }

    updatePointEditor() {
      const selected = this.selectedPoint;
      const enabled = !!(selected && this.simplified);
      [
        this.pointValueInput,
        this.pointLabelInput,
        this.pointApplyButton,
        this.pointInsertButton,
        this.pointDeleteButton,
        this.pointLockButton
      ].forEach((element) => { element.disabled = !enabled; });
      if (!enabled) {
        this.pointPositionEl.textContent = '单击简化波形选择数据点';
        this.pointValueInput.value = '';
        this.pointLabelInput.value = '';
        return;
      }
      const row = this.simplified.model.rows[selected.rowIndex];
      const column = this.simplified.model.columns[selected.pointIndex];
      this.pointPositionEl.textContent = row.name + ' · 第 ' + (selected.pointIndex + 1)
        + ' 点 · 来源列 ' + (Math.round(column * 1000) / 1000 + 1);
      const clockSymbol = row.mode === 'digital'
        && row.symbols
        && /^[pPnN]$/.test(row.symbols[selected.pointIndex] || '')
        ? row.symbols[selected.pointIndex]
        : '';
      this.pointValueInput.value = clockSymbol || (row.values[selected.pointIndex] == null
        ? ''
        : String(row.values[selected.pointIndex]));
      this.pointLabelInput.value = row.labels && row.labels[selected.pointIndex] != null
        ? String(row.labels[selected.pointIndex])
        : '';
      const locked = this.lockedColumns.has(column);
      this.pointLockButton.classList.toggle('active', locked);
      this.pointLockButton.textContent = locked ? '取消关键点' : '保留关键点';
    }

    snapshot() {
      if (!this.simplified) return null;
      return {
        simplified: clone(this.simplified),
        outputContent: this.outputContent,
        modes: Object.assign({}, this.modes),
        analogFormats: clone(this.analogFormats),
        rowStyles: clone(this.rowStyles),
        rowHeights: this.rowHeights.slice(),
        lockedColumns: Array.from(this.lockedColumns),
        selectedPoint: this.selectedPoint ? Object.assign({}, this.selectedPoint) : null,
        connections: clone(this.connections),
        selectedConnectionId: this.selectedConnectionId,
        connectionSequence: this.connectionSequence,
        outputTitle: this.outputTitleInput.value,
        presentationDraftDirty: this.presentationDraftDirty,
        dataDraftDirty: this.dataDraftDirty
      };
    }

    restoreSnapshot(snapshot) {
      if (!snapshot) return;
      this.simplified = clone(snapshot.simplified);
      this.outputContent = snapshot.outputContent;
      this.modes = Object.assign({}, snapshot.modes || this.modes);
      this.analogFormats = clone(snapshot.analogFormats || this.analogFormats);
      this.rowStyles = clone(snapshot.rowStyles || this.rowStyles);
      this.rowHeights = Array.isArray(snapshot.rowHeights)
        ? snapshot.rowHeights.slice()
        : this.rowHeights;
      this.lockedColumns = new Set(snapshot.lockedColumns || []);
      this.selectedPoint = snapshot.selectedPoint ? Object.assign({}, snapshot.selectedPoint) : null;
      this.connections = clone(snapshot.connections || []);
      this.selectedConnectionId = this.connections.some(
        (connection) => connection.id === snapshot.selectedConnectionId
      ) ? snapshot.selectedConnectionId : '';
      this.connectionSequence = Math.max(
        Number(snapshot.connectionSequence) || 0,
        this.connections.length
      );
      this.connectionDraftStart = null;
      this.connectionHover = null;
      this.outputTitleInput.value = snapshot.outputTitle || this.simplified.model.title;
      this.presentationDraftDirty = !!snapshot.presentationDraftDirty;
      this.dataDraftDirty = !!snapshot.dataDraftDirty;
      const scrollTop = this.plotViewport.scrollTop;
      this.renderSignalRows();
      this.signalScroll.scrollTop = scrollTop;
      this.updatePointEditor();
      this.updateMetrics(this.simplified.metrics);
      this.updateHistoryButtons();
      this.scheduleWindowRequest();
      this.scheduleBuild();
      this.updateDraftState();
      this.draw();
    }

    pushHistorySnapshot(snapshot) {
      if (!snapshot) return;
      this.undoStack.push(snapshot);
      if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
      this.redoStack = [];
      this.updateHistoryButtons();
    }

    pushHistory() {
      this.pushHistorySnapshot(this.snapshot());
    }

    undo() {
      if (!this.undoStack.length) return;
      const current = this.snapshot();
      if (current) this.redoStack.push(current);
      this.restoreSnapshot(this.undoStack.pop());
      this.setStatus('已撤销示波器编辑');
    }

    redo() {
      if (!this.redoStack.length) return;
      const current = this.snapshot();
      if (current) this.undoStack.push(current);
      this.restoreSnapshot(this.redoStack.pop());
      this.setStatus('已重做示波器编辑');
    }

    updateHistoryButtons() {
      this.undoButton.disabled = this.undoStack.length === 0;
      this.redoButton.disabled = this.redoStack.length === 0;
    }

    applySelectedPoint() {
      if (!this.selectedPoint || !this.simplified) return;
      const selected = this.selectedPoint;
      const row = this.simplified.model.rows[selected.rowIndex];
      let value = this.pointValueInput.value;
      if (row.mode === 'analog') {
        const number = Number(value);
        if (!Number.isFinite(number)) {
          this.setStatus('模拟波形数值必须是有效数字', true);
          return;
        }
        value = number;
      } else if (row.mode === 'digital') {
        value = String(value || '').trim();
        if (!/^[01xzpn]$/i.test(value)) {
          this.setStatus('数字波形支持 0、1、x、z、p、P、n、N', true);
          return;
        }
      }
      this.pushHistory();
      if (row.mode === 'digital') {
        row.symbols = row.symbols || new Array(row.values.length).fill('');
        row.gaps = row.gaps || new Array(row.values.length).fill(false);
        if (/^[pPnN]$/.test(value)) {
          row.symbols[selected.pointIndex] = value;
          row.values[selected.pointIndex] = value.toLowerCase() === 'p' ? '1' : '0';
        } else {
          row.symbols[selected.pointIndex] = '';
          row.gaps[selected.pointIndex] = false;
          row.values[selected.pointIndex] = value.toLowerCase();
        }
      } else {
        row.values[selected.pointIndex] = value;
      }
      if (row.mode === 'bus') {
        row.labels = row.labels || [];
        row.labels[selected.pointIndex] = this.pointLabelInput.value;
        row.values[selected.pointIndex] = this.pointLabelInput.value || value;
      }
      this.scheduleBuild();
      this.draw();
      this.markDraftDirty('data');
      this.setStatus('简化点已修改');
    }

    insertSelectedPoint() {
      if (!this.selectedPoint || !this.simplified) return;
      this.pushHistory();
      const pointIndex = this.selectedPoint.pointIndex;
      const columns = this.simplified.model.columns;
      const current = columns[pointIndex];
      const next = pointIndex + 1 < columns.length ? columns[pointIndex + 1] : current + 1;
      columns.splice(pointIndex + 1, 0, current + Math.max(0.001, (next - current) / 2));
      this.simplified.model.rows.forEach((row) => {
        row.values.splice(pointIndex + 1, 0, row.values[pointIndex]);
        if (row.labels) row.labels.splice(pointIndex + 1, 0, row.labels[pointIndex] || '');
        if (row.symbols) row.symbols.splice(pointIndex + 1, 0, row.symbols[pointIndex] || '');
        if (row.gaps) row.gaps.splice(pointIndex + 1, 0, false);
      });
      this.selectedPoint.pointIndex += 1;
      this.scheduleBuild();
      this.updatePointEditor();
      this.draw();
      this.markDraftDirty('data');
      this.setStatus('已插入简化点');
    }

    deleteSelectedPoint() {
      if (!this.selectedPoint || !this.simplified) return;
      const columns = this.simplified.model.columns;
      if (columns.length <= 2) {
        this.setStatus('简化实例至少需要保留两个点', true);
        return;
      }
      this.pushHistory();
      const pointIndex = this.selectedPoint.pointIndex;
      const removedColumn = columns[pointIndex];
      columns.splice(pointIndex, 1);
      this.simplified.model.rows.forEach((row) => {
        row.values.splice(pointIndex, 1);
        if (row.labels) row.labels.splice(pointIndex, 1);
        if (row.symbols) row.symbols.splice(pointIndex, 1);
        if (row.gaps) row.gaps.splice(pointIndex, 1);
      });
      this.lockedColumns.delete(removedColumn);
      this.selectedPoint.pointIndex = Math.min(pointIndex, columns.length - 1);
      this.scheduleBuild();
      this.updatePointEditor();
      this.draw();
      this.markDraftDirty('data');
      this.setStatus('已删除简化点');
    }

    toggleSelectedPointLock() {
      if (!this.selectedPoint || !this.simplified) return;
      const column = this.simplified.model.columns[this.selectedPoint.pointIndex];
      if (this.lockedColumns.has(column)) this.lockedColumns.delete(column);
      else this.lockedColumns.add(column);
      this.updatePointEditor();
      this.setStatus(this.lockedColumns.has(column) ? '关键点将在重新简化时保留' : '已取消关键点');
    }

    async rebuildOutput() {
      if (!this.simplified) return;
      const sequence = ++this.buildSequence;
      try {
        const options = this.getSimplifyOptions();
        this.simplified.model.title = options.outputTitle;
        const result = await this.worker.call('build', Object.assign({}, options, {
          model: this.simplified.model
        }));
        if (sequence !== this.buildSequence) return;
        this.outputContent = result.content;
        this.simplified.content = result.content;
        this.simplified.metrics = Object.assign({}, this.simplified.metrics, {
          simplifiedPoints: this.simplified.model.columns.length
        });
        this.updateMetrics(this.simplified.metrics);
      } catch (error) {
        if (sequence !== this.buildSequence) return;
        this.setStatus('构建展示实例失败：' + (error.message || String(error)), true);
      }
    }

    async ensureOutputBuilt() {
      if (!this.simplified) throw new Error('请先生成简化实例');
      this.buildSequence += 1;
      const options = this.getSimplifyOptions();
      this.simplified.model.title = options.outputTitle;
      const result = await this.worker.call('build', Object.assign({}, options, {
        model: this.simplified.model
      }));
      this.outputContent = result.content;
      this.simplified.content = result.content;
      return result.content;
    }

    async saveInstance() {
      try {
        this.setStatus('正在保存展示实例');
        const content = await this.ensureOutputBuilt();
        const title = this.outputTitleInput.value.trim() || (this.meta.title + ' - 展示实例');
        const saved = await this.adapter.saveInstance({
          sourceWaveId: this.document.name,
          title,
          content,
          metrics: this.simplified.metrics,
          columns: this.simplified.model.columns
        });
        this.setStatus('展示实例已保存：' + (saved.title || title));
        this.log('scope-save', {
          phase: 'instance-saved',
          sourceWaveId: this.document.name,
          waveId: saved.name
        });
      } catch (error) {
        this.setStatus('保存展示实例失败：' + (error.message || String(error)), true);
        this.log('scope-save', { phase: 'instance-error', message: error.message || String(error) });
      }
    }

    async buildDraftSourceContent() {
      if (this.dataDraftDirty) return this.ensureOutputBuilt();
      const result = await this.worker.call('style-source', {
        modes: Object.assign({}, this.modes),
        analogFormats: clone(this.analogFormats),
        rowStyles: clone(this.rowStyles),
        rowHeights: this.rowHeights.slice()
      });
      return result.content;
    }

    async reloadSavedDocument(saved) {
      this.document = saved;
      this.meta = await this.worker.call('prepare', { content: saved.content });
      this.modes = {};
      this.analogFormats = {};
      this.rowStyles = {};
      this.meta.rows.forEach((row) => {
        this.modes[row.index] = row.mode;
        this.analogFormats[row.index] = normalizeAnalogFormat(
          row.analogFormat,
          row.detectedMode === 'analog' ? 'float' : 'unsigned'
        );
        this.rowStyles[row.index] = normalizeRowStyle(row.style);
      });
      this.rowHeights = this.meta.rows.map((row) => row.rowHeight || DEFAULT_ROW_HEIGHT);
      this.rebuildRowOffsets();
      this.viewStart = 0;
      this.viewEnd = this.meta.totalColumns;
      this.cursorA = clamp(
        this.cursorA == null ? 0 : this.cursorA,
        0,
        Math.max(0, this.meta.totalColumns - 1)
      );
      this.cursorB = clamp(
        this.cursorB == null ? this.meta.totalColumns - 1 : this.cursorB,
        0,
        Math.max(0, this.meta.totalColumns - 1)
      );
      this.activeCursorRow = clamp(
        this.activeCursorRow,
        0,
        Math.max(0, this.meta.rows.length - 1)
      );
      this.targetInput.max = String(Math.max(2, this.meta.totalColumns));
      this.targetInput.value = String(initialTargetPointCount(this.meta.totalColumns));
      this.rangeStartInput.value = '1';
      this.rangeEndInput.value = String(this.meta.totalColumns);
      this.selectedPoint = null;
      this.columnSelection = null;
      this.lockedColumns = new Set();
      this.undoStack = [];
      this.redoStack = [];
      this.renderSignalRows();
      this.updateHistoryButtons();
      this.updateCursorControls();
      this.updateMeasurements();
      this.updateLayout();
      await this.requestWindow();
      await this.runSimplify(false);
      await this.updateCursorReadout();
    }

    async saveChanges() {
      if (!this.hasUnsavedChanges() || this.saveInFlight) return;
      const replacesSourceData = this.dataDraftDirty;
      if (replacesSourceData
          && !global.confirm('保存会用当前简化结果更新原波形数据。确认继续吗？')) return;
      this.saveInFlight = true;
      this.updateDraftState();
      try {
        this.setStatus('正在保存示波器修改');
        const content = await this.buildDraftSourceContent();
        const saved = await this.adapter.saveSource({ content });
        await this.reloadSavedDocument(saved);
        this.clearDraftDirty();
        this.setStatus(replacesSourceData ? '简化结果已保存到原波形' : '示波器修改已保存');
        this.log('scope-save', {
          phase: 'source-saved',
          waveId: saved.name,
          replacedData: replacesSourceData
        });
      } catch (error) {
        this.setStatus('保存示波器修改失败：' + (error.message || String(error)), true);
        this.log('scope-save', {
          phase: 'source-error',
          message: error.message || String(error)
        });
      } finally {
        this.saveInFlight = false;
        this.updateDraftState();
      }
    }
  }

  async function mount(adapter) {
    const view = new ScopeView(adapter || {});
    try {
      await view.mount();
      global.__visualWaveDromScopeView = view;
      return view;
    } catch (error) {
      document.body.classList.add('scope-wave-view');
      const root = document.getElementById('scope-app') || document.body;
      const failure = document.createElement('div');
      failure.className = 'scope-fatal-error';
      failure.textContent = '示波器窗口加载失败：' + (error.message || String(error));
      root.appendChild(failure);
      if (adapter && typeof adapter.log === 'function') {
        adapter.log('scope-view', { phase: 'fatal', message: error.message || String(error) });
      }
      throw error;
    }
  }

  global.VisualWaveDromScope = { mount };
})(window);

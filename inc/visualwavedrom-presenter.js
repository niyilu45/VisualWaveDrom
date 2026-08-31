(function (root, factory) {
  'use strict';

  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VisualWaveDromPresenter = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MAX_DIRECT_COLUMNS = 800;
  const LARGE_WINDOW_COLUMNS = 320;
  const MIN_SCALE = 0.05;
  const MAX_SCALE = 3;

  const ICONS = {
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    fullscreen: '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/>',
    fit: '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/><path d="M9 9h6v6H9z"/>',
    notes: '<path d="M14 2H6a2 2 0 0 0-2 2v16l4-4h10a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    chevronLeft: '<path d="m15 18-6-6 6-6"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    pointer: '<path d="m3 3 7.1 17 2.4-7.5L20 10.1z"/>',
    focus: '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/>',
    range: '<path d="M4 7V4h3M17 4h3v3M20 17v3h-3M7 20H4v-3"/><path d="M8 12h8"/>',
    cursor: '<path d="M8 3v18M16 3v18"/><path d="m5 6 3-3 3 3M13 18l3 3 3-3"/>',
    clear: '<path d="m3 15 8-8 6 6-8 8H3z"/><path d="m14 4 6 6-3 3-6-6z"/>',
    panelClose: '<path d="m9 18 6-6-6-6"/>'
  };

  function icon(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" '
      + 'stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  }

  function clamp(value, minimum, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number)) return minimum;
    return Math.max(minimum, Math.min(maximum, number));
  }

  function cloneValue(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function formatCycle(value) {
    if (!Number.isFinite(value)) return '--';
    const rounded = Math.round(value * 2) / 2;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  }

  function createSvgElement(name, attributes) {
    const element = document.createElementNS(SVG_NS, name);
    Object.keys(attributes || {}).forEach(function (key) {
      element.setAttribute(key, String(attributes[key]));
    });
    return element;
  }

  function sourceTitle(source, fallback) {
    const title = source && typeof source.title === 'string' ? source.title.trim() : '';
    const head = source && source.head && typeof source.head.text === 'string'
      ? source.head.text.trim()
      : '';
    return title || head || fallback || '未命名波形图';
  }

  function sourceDescription(source) {
    return source && typeof source.description === 'string' ? source.description : '';
  }

  function prepareRenderSource(source) {
    const prepared = Object.assign({}, source || {});
    delete prepared.title;
    delete prepared.description;
    const head = prepared.head && typeof prepared.head === 'object' && !Array.isArray(prepared.head)
      ? Object.assign({}, prepared.head)
      : null;
    if (head) {
      delete head.text;
      if (Object.keys(head).length) prepared.head = head;
      else delete prepared.head;
    }
    return prepared;
  }

  function collectSignalKeys(signals, keys, occurrences) {
    if (!Array.isArray(signals)) return keys;
    signals.forEach(function (signal) {
      if (Array.isArray(signal)) {
        collectSignalKeys(signal.slice(1), keys, occurrences);
        return;
      }
      if (!signal || typeof signal !== 'object') return;
      const hasChildren = Array.isArray(signal.children);
      const hasSignalField = ['name', 'wave', 'node', 'data', 'period', 'phase'].some(function (key) {
        return Object.prototype.hasOwnProperty.call(signal, key);
      });
      if (!hasChildren || hasSignalField) {
        const name = String(signal.name || '').trim();
        if (name) {
          const occurrence = occurrences.get(name) || 0;
          occurrences.set(name, occurrence + 1);
          keys.push('name:' + name + '#' + occurrence);
        } else {
          keys.push('row:' + keys.length);
        }
      }
      if (hasChildren) collectSignalKeys(signal.children, keys, occurrences);
    });
    return keys;
  }

  function getSvgMetrics(svg) {
    const viewBox = svg && svg.viewBox && svg.viewBox.baseVal;
    let width = viewBox && viewBox.width > 0 ? viewBox.width : parseFloat(svg && svg.getAttribute('width'));
    let height = viewBox && viewBox.height > 0 ? viewBox.height : parseFloat(svg && svg.getAttribute('height'));
    if ((!Number.isFinite(width) || !Number.isFinite(height)) && svg && typeof svg.getBBox === 'function') {
      try {
        const box = svg.getBBox();
        if (!Number.isFinite(width)) width = box.width;
        if (!Number.isFinite(height)) height = box.height;
      } catch (_error) { /* use fallbacks below */ }
    }
    width = Math.max(1, Number(width) || 1);
    height = Math.max(1, Number(height) || 1);
    return {
      x: viewBox && Number.isFinite(viewBox.x) ? viewBox.x : 0,
      y: viewBox && Number.isFinite(viewBox.y) ? viewBox.y : 0,
      width: width,
      height: height
    };
  }

  function getElementBounds(element) {
    if (!element || typeof element.getBBox !== 'function' || typeof element.getCTM !== 'function') return null;
    try {
      const box = element.getBBox();
      const matrix = element.getCTM();
      if (!matrix) return null;
      const points = [
        new DOMPoint(box.x, box.y).matrixTransform(matrix),
        new DOMPoint(box.x + box.width, box.y).matrixTransform(matrix),
        new DOMPoint(box.x, box.y + box.height).matrixTransform(matrix),
        new DOMPoint(box.x + box.width, box.y + box.height).matrixTransform(matrix)
      ];
      const xs = points.map(function (point) { return point.x; });
      const ys = points.map(function (point) { return point.y; });
      const left = Math.min.apply(Math, xs);
      const right = Math.max.apply(Math, xs);
      const top = Math.min.apply(Math, ys);
      const bottom = Math.max.apply(Math, ys);
      return { x: left, y: top, width: right - left, height: bottom - top };
    } catch (_error) {
      return null;
    }
  }

  function unionBounds(bounds, fallback) {
    const valid = bounds.filter(Boolean);
    if (!valid.length) return Object.assign({}, fallback);
    const left = Math.min.apply(Math, valid.map(function (item) { return item.x; }));
    const right = Math.max.apply(Math, valid.map(function (item) { return item.x + item.width; }));
    const top = Math.min.apply(Math, valid.map(function (item) { return item.y; }));
    const bottom = Math.max.apply(Math, valid.map(function (item) { return item.y + item.height; }));
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  function getLaneGroups(svg) {
    return Array.prototype.slice.call(svg.querySelectorAll('g[id^="wavelane_"]'))
      .filter(function (group) { return /^wavelane_\d+_\d+$/.test(group.id); })
      .sort(function (left, right) {
        return parseInt(left.id.match(/^wavelane_(\d+)_/)[1], 10)
          - parseInt(right.id.match(/^wavelane_(\d+)_/)[1], 10);
      });
  }

  function buttonMarkup(action, iconName, label, title, extraClass) {
    return '<button type="button" class="presenter-button ' + (extraClass || '')
      + '" data-action="' + action + '" title="' + title + '">'
      + icon(iconName) + '<span>' + label + '</span></button>';
  }

  class PresenterView {
    constructor(adapter) {
      this.adapter = adapter || {};
      this.log = typeof this.adapter.log === 'function' ? this.adapter.log : function () {};
      this.document = null;
      this.source = null;
      this.renderSource = null;
      this.metrics = { maxWaveLength: 0, signalCount: 0 };
      this.renderWindow = null;
      this.windowStart = 0;
      this.windowSize = 0;
      this.scale = 1;
      this.fitMode = true;
      this.svg = null;
      this.svgMetrics = null;
      this.plotBounds = null;
      this.laneBounds = [];
      this.rowKeys = [];
      this.tool = '';
      this.activeCursor = 'A';
      this.annotations = {
        pointer: null,
        focus: null,
        range: null,
        cursorA: null,
        cursorB: null
      };
      this.steps = [];
      this.stepIndex = -1;
      this.notesDirty = false;
      this.sourceDescription = '';
      this.drag = null;
      this.renderSequence = 0;
      this.toastTimer = 0;
      this.liveTimer = 0;
      this.controlsTimer = 0;
      this.resizeObserver = null;
      this.destroyed = false;
      this.boundKeydown = this.handleKeydown.bind(this);
      this.boundFullscreen = this.handleFullscreenChange.bind(this);
      this.boundActivity = this.noteActivity.bind(this);
    }

    async mount() {
      this.buildShell();
      this.bindEvents();
      this.setStageMessage('正在准备演讲画面...', '正在读取当前波形');
      try {
        const documentSnapshot = await this.adapter.getDocument();
        await this.updateDocument(documentSnapshot, { initial: true });
      } catch (error) {
        this.setStageMessage(
          '请返回波形库确认波形仍然存在，然后重新打开演讲者模式。',
          '演讲画面加载失败：' + (error && error.message ? error.message : String(error))
        );
        throw error;
      } finally {
        const bootstrap = document.getElementById('presenter-bootstrap');
        if (bootstrap) bootstrap.hidden = true;
      }
      root.__visualWaveDromPresenterView = this;
      return this;
    }

    buildShell() {
      const existing = document.getElementById('presenter-app');
      if (existing) existing.remove();
      const app = document.createElement('section');
      app.id = 'presenter-app';
      app.className = 'presenter-app';
      app.innerHTML = ''
        + '<header class="presenter-topbar">'
        + '  <div class="presenter-title-block">'
        + '    <h1 class="presenter-title" id="presenter-title">演讲者模式</h1>'
        + '    <span class="presenter-library-name" id="presenter-library-name"></span>'
        + '  </div>'
        + '  <div class="presenter-step-controls" aria-label="演讲步骤">'
        + '    <button type="button" class="presenter-icon-button" data-action="step-prev" title="上一步（左方向键）" aria-label="上一步">' + icon('chevronLeft') + '</button>'
        + '    <span class="presenter-step-count" id="presenter-step-count">1 / 1</span>'
        + '    <button type="button" class="presenter-icon-button" data-action="step-next" title="下一步（右方向键）" aria-label="下一步">' + icon('chevronRight') + '</button>'
        + '    <button type="button" class="presenter-icon-button" data-action="step-add" title="记录当前画面为新步骤" aria-label="记录当前步骤">' + icon('plus') + '</button>'
        + '  </div>'
        + '  <div class="presenter-window-controls" id="presenter-window-controls" aria-label="大波形分段浏览" hidden>'
        + '    <button type="button" class="presenter-icon-button" data-action="window-prev" title="上一段" aria-label="上一段">' + icon('chevronLeft') + '</button>'
        + '    <span class="presenter-window-range" id="presenter-window-range"></span>'
        + '    <button type="button" class="presenter-icon-button" data-action="window-next" title="下一段" aria-label="下一段">' + icon('chevronRight') + '</button>'
        + '  </div>'
        + '  <div class="presenter-top-actions">'
        + buttonMarkup('fit', 'fit', '适应窗口', '适应窗口（Z）')
        + buttonMarkup('notes', 'notes', '讲解备注', '显示或隐藏讲解备注（N）')
        + buttonMarkup('fullscreen', 'fullscreen', '全屏', '进入或退出全屏（F）')
        + buttonMarkup('exit', 'close', '退出', '退出演讲者模式', 'presenter-exit-button')
        + '  </div>'
        + '</header>'
        + '<div class="presenter-workspace" id="presenter-workspace">'
        + '  <main class="presenter-stage-shell">'
        + '    <div class="presenter-live-status" id="presenter-live-status" aria-live="polite" hidden></div>'
        + '    <div class="presenter-stage-viewport" id="presenter-stage-viewport" tabindex="0" aria-label="只读波形演讲区域">'
        + '      <div class="presenter-stage-content" id="presenter-stage-content">'
        + '        <div class="presenter-wave-surface" id="presenter-wave-surface">'
        + '          <div class="presenter-wave-display" id="presenter-wave-display"></div>'
        + '          <svg class="presenter-overlay" id="presenter-overlay" aria-label="演讲标注层"></svg>'
        + '        </div>'
        + '      </div>'
        + '      <div class="presenter-frozen-labels" id="presenter-frozen-labels" aria-hidden="true"></div>'
        + '    </div>'
        + '    <div class="presenter-stage-message" id="presenter-stage-message"><div><strong id="presenter-stage-message-title">正在加载</strong><span id="presenter-stage-message-detail"></span></div></div>'
        + '  </main>'
        + '  <aside class="presenter-notes" id="presenter-notes" aria-label="讲解备注">'
        + '    <div class="presenter-notes-header"><h2>讲解备注</h2><button type="button" class="presenter-icon-button" data-action="notes" title="收起备注" aria-label="收起备注">' + icon('panelClose') + '</button></div>'
        + '    <textarea class="presenter-notes-text" id="presenter-notes-text" spellcheck="false" placeholder="记录本次讲解要点"></textarea>'
        + '    <p class="presenter-notes-hint">备注只在当前演讲窗口中保留，不会写入波形库。</p>'
        + '  </aside>'
        + '</div>'
        + '<footer class="presenter-tooltray" aria-label="讲解工具">'
        + '  <div class="presenter-tool-group">'
        + '    <button type="button" class="presenter-tool-button" data-tool="pointer" title="激光指示（P）">' + icon('pointer') + '<span>指示</span></button>'
        + '    <button type="button" class="presenter-tool-button" data-tool="focus" title="聚焦信号或连接（点击波形）">' + icon('focus') + '<span>聚焦</span></button>'
        + '    <button type="button" class="presenter-tool-button" data-tool="range" title="拖动框选一段波形（R）">' + icon('range') + '<span>范围</span></button>'
        + '    <button type="button" class="presenter-tool-button" data-tool="cursor" title="放置 A/B 游标">' + icon('cursor') + '<span>游标</span></button>'
        + '    <button type="button" class="presenter-icon-button" data-cursor="A" title="选择 A 游标">A</button>'
        + '    <button type="button" class="presenter-icon-button" data-cursor="B" title="选择 B 游标">B</button>'
        + '    <button type="button" class="presenter-tool-button" data-action="clear" title="清除当前演讲标注">' + icon('clear') + '<span>清除</span></button>'
        + '  </div>'
        + '  <div class="presenter-measurements" aria-label="游标测量">'
        + '    <span class="presenter-measurement" id="presenter-measure-a">A: --</span>'
        + '    <span class="presenter-measurement" id="presenter-measure-b">B: --</span>'
        + '    <span class="presenter-measurement" id="presenter-measure-delta">B-A: --</span>'
        + '  </div>'
        + '</footer>'
        + '<div class="presenter-toast" id="presenter-toast" role="status" aria-live="polite" hidden></div>';
      document.body.appendChild(app);
      this.app = app;
      this.workspace = app.querySelector('#presenter-workspace');
      this.titleEl = app.querySelector('#presenter-title');
      this.libraryEl = app.querySelector('#presenter-library-name');
      this.viewport = app.querySelector('#presenter-stage-viewport');
      this.stageContent = app.querySelector('#presenter-stage-content');
      this.surface = app.querySelector('#presenter-wave-surface');
      this.display = app.querySelector('#presenter-wave-display');
      this.overlay = app.querySelector('#presenter-overlay');
      this.frozenLabels = app.querySelector('#presenter-frozen-labels');
      this.stageMessage = app.querySelector('#presenter-stage-message');
      this.stageMessageTitle = app.querySelector('#presenter-stage-message-title');
      this.stageMessageDetail = app.querySelector('#presenter-stage-message-detail');
      this.liveStatus = app.querySelector('#presenter-live-status');
      this.notesText = app.querySelector('#presenter-notes-text');
      this.stepCount = app.querySelector('#presenter-step-count');
      this.windowControls = app.querySelector('#presenter-window-controls');
      this.windowRange = app.querySelector('#presenter-window-range');
      this.measureA = app.querySelector('#presenter-measure-a');
      this.measureB = app.querySelector('#presenter-measure-b');
      this.measureDelta = app.querySelector('#presenter-measure-delta');
      this.toast = app.querySelector('#presenter-toast');
      this.libraryEl.textContent = this.adapter.libraryName || 'SQLite 波形库';
    }

    bindEvents() {
      this.app.addEventListener('click', (event) => {
        const actionButton = event.target.closest('[data-action]');
        if (actionButton) {
          this.handleAction(actionButton.dataset.action);
          return;
        }
        const toolButton = event.target.closest('[data-tool]');
        if (toolButton) {
          this.setTool(toolButton.dataset.tool);
          return;
        }
        const cursorButton = event.target.closest('[data-cursor]');
        if (cursorButton) {
          this.activeCursor = cursorButton.dataset.cursor === 'B' ? 'B' : 'A';
          this.setTool('cursor', true);
          this.updateToolState();
        }
      });
      this.notesText.addEventListener('input', () => { this.notesDirty = true; });
      this.viewport.addEventListener('scroll', () => this.updateFrozenLabels(), { passive: true });
      this.viewport.addEventListener('wheel', (event) => this.handleWheel(event), { passive: false });
      this.overlay.addEventListener('pointerdown', (event) => this.handleOverlayPointerDown(event));
      this.overlay.addEventListener('pointermove', (event) => this.handleOverlayPointerMove(event));
      this.overlay.addEventListener('pointerup', (event) => this.handleOverlayPointerUp(event));
      this.overlay.addEventListener('pointercancel', (event) => this.handleOverlayPointerUp(event));
      document.addEventListener('keydown', this.boundKeydown);
      document.addEventListener('fullscreenchange', this.boundFullscreen);
      document.addEventListener('mousemove', this.boundActivity, { passive: true });
      document.addEventListener('pointerdown', this.boundActivity, { passive: true });
      if (typeof ResizeObserver === 'function') {
        this.resizeObserver = new ResizeObserver(() => {
          if (this.fitMode && this.svg) this.fitToWindow(false);
          else this.updateFrozenLabels();
        });
        this.resizeObserver.observe(this.viewport);
      }
    }

    handleAction(action) {
      if (action === 'exit') {
        if (typeof this.adapter.close === 'function') this.adapter.close();
        else root.close();
      } else if (action === 'fullscreen') {
        void this.toggleFullscreen();
      } else if (action === 'fit') {
        this.fitToWindow(true);
      } else if (action === 'notes') {
        this.toggleNotes();
      } else if (action === 'step-prev') {
        this.goToStep(this.stepIndex - 1);
      } else if (action === 'step-next') {
        this.goToStep(this.stepIndex + 1);
      } else if (action === 'step-add') {
        this.recordStep();
      } else if (action === 'window-prev') {
        this.moveWindow(-1);
      } else if (action === 'window-next') {
        this.moveWindow(1);
      } else if (action === 'clear') {
        this.clearAnnotations();
      }
    }

    setStageMessage(detail, title) {
      this.stageMessage.hidden = false;
      this.stageMessageTitle.textContent = title || '正在加载';
      this.stageMessageDetail.textContent = detail || '';
    }

    hideStageMessage() {
      this.stageMessage.hidden = true;
    }

    showLiveStatus(message) {
      clearTimeout(this.liveTimer);
      this.liveStatus.textContent = message;
      this.liveStatus.hidden = false;
      this.liveTimer = setTimeout(() => { this.liveStatus.hidden = true; }, 1300);
    }

    showToast(message, isError) {
      clearTimeout(this.toastTimer);
      this.toast.textContent = message;
      this.toast.classList.toggle('error', !!isError);
      this.toast.hidden = false;
      this.toastTimer = setTimeout(() => { this.toast.hidden = true; }, 1600);
    }

    async updateDocument(rawDocument, options) {
      const opts = options || {};
      if (!rawDocument || typeof rawDocument.content !== 'string') {
        throw new Error('演讲数据缺少波形 JSON');
      }
      if (this.document && rawDocument.name && rawDocument.name !== this.document.name) return false;
      let source;
      try {
        source = JSON.parse(rawDocument.content);
      } catch (error) {
        throw new Error('波形 JSON 无法解析：' + error.message);
      }
      const previousTotal = this.metrics.maxWaveLength || 0;
      const previousDescription = this.sourceDescription;
      this.document = Object.assign({}, rawDocument);
      this.source = source;
      this.renderSource = prepareRenderSource(source);
      this.rowKeys = collectSignalKeys(this.renderSource.signal, [], new Map());
      const bigApi = root.VisualWaveDromBigData;
      this.metrics = bigApi && typeof bigApi.measureSource === 'function'
        ? bigApi.measureSource(this.renderSource)
        : { maxWaveLength: 0, signalCount: 0 };
      this.sourceDescription = sourceDescription(source);
      this.titleEl.textContent = sourceTitle(source, rawDocument.name);
      document.title = this.titleEl.textContent + ' - 演讲者模式';
      if (!this.notesDirty || this.notesText.value === previousDescription) {
        this.notesText.value = this.sourceDescription;
      }

      const total = Math.max(0, Number(this.metrics.maxWaveLength) || 0);
      this.keepAnnotationsInSourceBounds(total, Number(this.metrics.signalCount) || 0);
      this.windowSize = total > MAX_DIRECT_COLUMNS ? Math.min(LARGE_WINDOW_COLUMNS, total) : total;
      if (!this.windowSize) this.windowSize = 1;
      const maxStart = Math.max(0, total - this.windowSize);
      this.windowStart = clamp(this.windowStart, 0, maxStart);
      if (opts.initial || !previousTotal) this.windowStart = 0;

      if (!opts.initial) this.showLiveStatus('正在同步主界面的最新波形...');
      await this.renderWave({ preserveView: !opts.initial });
      if (!this.steps.length) {
        this.steps = [this.captureStep()];
        this.stepIndex = 0;
      }
      this.updateStepControls();
      if (!opts.initial) this.showLiveStatus('波形已同步，讲解标注保持不变');
      this.log('presenter-view', {
        phase: opts.initial ? 'mounted' : 'live-update-applied',
        documentName: rawDocument.name || '',
        totalColumns: total,
        annotationCount: Object.keys(this.annotations).filter((key) => this.annotations[key] != null).length
      });
      return true;
    }

    keepAnnotationsInSourceBounds(totalColumns, signalCount) {
      if (totalColumns > 0) {
        ['cursorA', 'cursorB'].forEach((key) => {
          if (Number.isFinite(this.annotations[key])) {
            this.annotations[key] = clamp(this.annotations[key], 0, totalColumns);
          }
        });
        if (this.annotations.range) {
          this.annotations.range.startCycle = clamp(
            this.annotations.range.startCycle,
            0,
            totalColumns
          );
          this.annotations.range.endCycle = clamp(
            this.annotations.range.endCycle,
            0,
            totalColumns
          );
        }
        if (this.annotations.pointer && Number.isFinite(this.annotations.pointer.cycle)) {
          this.annotations.pointer.cycle = clamp(this.annotations.pointer.cycle, 0, totalColumns);
        }
      }
      if (signalCount > 0) {
        if (this.annotations.focus && Number.isFinite(this.annotations.focus.rowIndex)) {
          const resolvedFocusIndex = this.annotations.focus.rowKey
            ? this.rowKeys.indexOf(this.annotations.focus.rowKey)
            : -1;
          this.annotations.focus.rowIndex = clamp(
            resolvedFocusIndex >= 0 ? resolvedFocusIndex : Math.round(this.annotations.focus.rowIndex),
            0,
            signalCount - 1
          );
        }
        if (this.annotations.pointer && Number.isFinite(this.annotations.pointer.rowIndex)) {
          const resolvedPointerIndex = this.annotations.pointer.rowKey
            ? this.rowKeys.indexOf(this.annotations.pointer.rowKey)
            : -1;
          this.annotations.pointer.rowIndex = clamp(
            resolvedPointerIndex >= 0 ? resolvedPointerIndex : Math.round(this.annotations.pointer.rowIndex),
            0,
            signalCount - 1
          );
        }
      }
    }

    createWindowSource() {
      const total = Math.max(0, Number(this.metrics.maxWaveLength) || 0);
      const bigApi = root.VisualWaveDromBigData;
      if (total > MAX_DIRECT_COLUMNS && bigApi && typeof bigApi.createRenderWindow === 'function') {
        this.renderWindow = bigApi.createRenderWindow(this.renderSource, {
          start: this.windowStart,
          size: this.windowSize,
          metrics: this.metrics
        });
        return this.renderWindow.source;
      }
      this.renderWindow = {
        source: this.renderSource,
        start: 0,
        end: total,
        size: total,
        totalColumns: total,
        maxStart: 0
      };
      this.windowStart = 0;
      return this.renderSource;
    }

    async renderWave(options) {
      const opts = options || {};
      const sequence = ++this.renderSequence;
      const previousView = opts.preserveView ? {
        scale: this.scale,
        fitMode: this.fitMode,
        scrollLeft: this.viewport.scrollLeft,
        scrollTop: this.viewport.scrollTop
      } : null;
      this.setStageMessage('正在生成只读波形...', '正在更新演讲画面');
      await new Promise(function (resolve) { requestAnimationFrame(resolve); });
      if (sequence !== this.renderSequence || this.destroyed) return false;

      const source = this.createWindowSource();
      const prefix = 'presenter-wave-' + sequence + '-';
      this.display.innerHTML = '<div id="' + prefix + '0"></div>';
      try {
        if (!root.WaveDrom || typeof root.WaveDrom.RenderWaveForm !== 'function') {
          throw new Error('WaveDrom 渲染模块未加载');
        }
        root.WaveDrom.RenderWaveForm(0, source, prefix, false);
        const svg = this.display.querySelector('svg');
        if (!svg) throw new Error('WaveDrom 未生成波形 SVG');
        this.svg = svg;
        this.svgMetrics = getSvgMetrics(svg);
        svg.style.width = this.svgMetrics.width + 'px';
        svg.style.height = this.svgMetrics.height + 'px';
        svg.setAttribute('aria-label', this.titleEl.textContent);
        this.surface.style.width = this.svgMetrics.width + 'px';
        this.surface.style.height = this.svgMetrics.height + 'px';
        this.overlay.setAttribute('viewBox', [
          this.svgMetrics.x,
          this.svgMetrics.y,
          this.svgMetrics.width,
          this.svgMetrics.height
        ].join(' '));
        this.overlay.setAttribute('width', this.svgMetrics.width);
        this.overlay.setAttribute('height', this.svgMetrics.height);
        this.overlay.style.width = this.svgMetrics.width + 'px';
        this.overlay.style.height = this.svgMetrics.height + 'px';
        this.collectGeometry();
        if (previousView && !previousView.fitMode) {
          this.fitMode = false;
          this.setScale(previousView.scale, false);
          requestAnimationFrame(() => {
            this.viewport.scrollLeft = previousView.scrollLeft;
            this.viewport.scrollTop = previousView.scrollTop;
            this.updateFrozenLabels();
          });
        } else {
          this.fitToWindow(false);
        }
        this.drawAnnotations();
        this.updateWindowControls();
        this.hideStageMessage();
        return true;
      } catch (error) {
        this.svg = null;
        this.setStageMessage(
          '其他波形窗口不会受影响。请检查这张波形的 JSON 后重新打开。',
          '波形渲染失败：' + (error && error.message ? error.message : String(error))
        );
        this.log('presenter-view', {
          phase: 'render-error',
          message: error && error.message ? error.message : String(error)
        });
        return false;
      }
    }

    collectGeometry() {
      const lanes = getLaneGroups(this.svg);
      this.laneBounds = lanes.map(getElementBounds).filter(Boolean);
      const drawBounds = lanes.map(function (lane) {
        return getElementBounds(lane.querySelector('[id^="wavelane_draw_"]'));
      });
      const fallback = {
        x: this.svgMetrics.x,
        y: this.svgMetrics.y,
        width: this.svgMetrics.width,
        height: this.svgMetrics.height
      };
      this.plotBounds = unionBounds(drawBounds, fallback);
      if (this.plotBounds.width < 1) this.plotBounds = fallback;
      this.buildFrozenLabels();
    }

    buildFrozenLabels() {
      this.frozenLabels.innerHTML = '';
      if (!this.svg) return;
      const infoTexts = Array.prototype.slice.call(this.svg.querySelectorAll('text.info'));
      infoTexts.forEach((text) => {
        const bounds = getElementBounds(text);
        if (!bounds || !String(text.textContent || '').trim()) return;
        const label = document.createElement('span');
        label.className = 'presenter-frozen-label';
        label.textContent = text.textContent;
        label.dataset.svgY = String(bounds.y + bounds.height / 2);
        this.frozenLabels.appendChild(label);
      });
      this.updateFrozenLabels();
    }

    updateFrozenLabels() {
      if (!this.svg || !this.svgMetrics || !this.plotBounds) return;
      const horizontalOverflow = this.viewport.scrollWidth > this.viewport.clientWidth + 4;
      const active = horizontalOverflow && this.viewport.scrollLeft > 4
        && this.frozenLabels.childElementCount > 0;
      this.frozenLabels.classList.toggle('active', active);
      if (!active) return;
      const offsetY = parseFloat(this.surface.style.top) || 0;
      const plotPixelX = (this.plotBounds.x - this.svgMetrics.x)
        / this.svgMetrics.width * this.svgMetrics.width * this.scale;
      const width = clamp(plotPixelX + 4, 84, 230);
      this.frozenLabels.style.width = width + 'px';
      this.frozenLabels.style.height = this.viewport.clientHeight + 'px';
      Array.prototype.forEach.call(this.frozenLabels.children, (label) => {
        const svgY = Number(label.dataset.svgY);
        const y = offsetY + (svgY - this.svgMetrics.y) * this.scale - this.viewport.scrollTop;
        label.style.top = (y - 9) + 'px';
        label.hidden = y < -18 || y > this.viewport.clientHeight + 18;
      });
    }

    setScale(scale, centerContent) {
      this.scale = clamp(scale, MIN_SCALE, MAX_SCALE);
      const scaledWidth = this.svgMetrics.width * this.scale;
      const scaledHeight = this.svgMetrics.height * this.scale;
      const left = Math.max(24, (this.viewport.clientWidth - scaledWidth) / 2);
      const top = Math.max(20, (this.viewport.clientHeight - scaledHeight) / 2);
      this.surface.style.left = left + 'px';
      this.surface.style.top = top + 'px';
      this.surface.style.transform = 'scale(' + this.scale + ')';
      this.stageContent.style.width = Math.max(this.viewport.clientWidth, scaledWidth + left + 24) + 'px';
      this.stageContent.style.height = Math.max(this.viewport.clientHeight, scaledHeight + top + 20) + 'px';
      if (centerContent) {
        this.viewport.scrollLeft = Math.max(0, (this.stageContent.scrollWidth - this.viewport.clientWidth) / 2);
        this.viewport.scrollTop = Math.max(0, (this.stageContent.scrollHeight - this.viewport.clientHeight) / 2);
      }
      this.updateFrozenLabels();
    }

    fitToWindow(showMessage) {
      if (!this.svg || !this.svgMetrics) return;
      const widthScale = Math.max(1, this.viewport.clientWidth - 58) / this.svgMetrics.width;
      const heightScale = Math.max(1, this.viewport.clientHeight - 46) / this.svgMetrics.height;
      this.fitMode = true;
      this.setScale(Math.min(widthScale, heightScale, 2.2), true);
      if (showMessage) this.showToast('已适应当前窗口');
    }

    handleWheel(event) {
      if (!event.ctrlKey || !this.svg) return;
      event.preventDefault();
      const rect = this.viewport.getBoundingClientRect();
      const anchorX = event.clientX - rect.left;
      const anchorY = event.clientY - rect.top;
      const contentX = this.viewport.scrollLeft + anchorX;
      const contentY = this.viewport.scrollTop + anchorY;
      const oldScale = this.scale;
      const factor = Math.exp(-event.deltaY * 0.0016);
      this.fitMode = false;
      this.setScale(oldScale * factor, false);
      const ratio = this.scale / oldScale;
      this.viewport.scrollLeft = Math.max(0, contentX * ratio - anchorX);
      this.viewport.scrollTop = Math.max(0, contentY * ratio - anchorY);
      this.updateFrozenLabels();
    }

    updateWindowControls() {
      const total = Math.max(0, Number(this.metrics.maxWaveLength) || 0);
      const large = total > MAX_DIRECT_COLUMNS;
      this.windowControls.hidden = !large;
      if (!large) return;
      const start = this.renderWindow ? this.renderWindow.start : this.windowStart;
      const end = this.renderWindow ? this.renderWindow.end : Math.min(total, start + this.windowSize);
      this.windowRange.textContent = '列 ' + (start + 1) + '-' + end + ' / ' + total;
      const prev = this.windowControls.querySelector('[data-action="window-prev"]');
      const next = this.windowControls.querySelector('[data-action="window-next"]');
      prev.disabled = start <= 0;
      next.disabled = end >= total;
    }

    async moveWindow(direction) {
      const total = Math.max(0, Number(this.metrics.maxWaveLength) || 0);
      if (total <= MAX_DIRECT_COLUMNS) return;
      const maxStart = Math.max(0, total - this.windowSize);
      const next = clamp(this.windowStart + direction * this.windowSize, 0, maxStart);
      if (next === this.windowStart) return;
      this.windowStart = next;
      await this.renderWave({ preserveView: false });
      this.showToast('已显示列 ' + (this.renderWindow.start + 1) + '-' + this.renderWindow.end);
    }

    setTool(tool, force) {
      const next = String(tool || '');
      this.tool = !force && this.tool === next ? '' : next;
      this.updateToolState();
      this.viewport.focus({ preventScroll: true });
    }

    updateToolState() {
      this.app.querySelectorAll('[data-tool]').forEach((button) => {
        button.classList.toggle('active', button.dataset.tool === this.tool);
        button.setAttribute('aria-pressed', button.dataset.tool === this.tool ? 'true' : 'false');
      });
      this.app.querySelectorAll('[data-cursor]').forEach((button) => {
        const active = this.tool === 'cursor' && button.dataset.cursor === this.activeCursor;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      this.overlay.classList.remove('tool-pointer', 'tool-focus', 'tool-range', 'tool-cursor');
      if (this.tool) this.overlay.classList.add('tool-' + this.tool);
    }

    clientPoint(event) {
      if (!this.overlay || typeof this.overlay.createSVGPoint !== 'function') return null;
      const matrix = this.overlay.getScreenCTM && this.overlay.getScreenCTM();
      if (!matrix) return null;
      try {
        const point = this.overlay.createSVGPoint();
        point.x = event.clientX;
        point.y = event.clientY;
        return point.matrixTransform(matrix.inverse());
      } catch (_error) {
        return null;
      }
    }

    cycleFromX(x) {
      if (!this.plotBounds || !this.renderWindow) return 0;
      const ratio = clamp((x - this.plotBounds.x) / Math.max(1, this.plotBounds.width), 0, 1);
      const cycle = this.renderWindow.start + ratio * Math.max(1, this.renderWindow.size);
      return Math.round(cycle * 2) / 2;
    }

    xFromCycle(cycle) {
      if (!this.plotBounds || !this.renderWindow || !Number.isFinite(cycle)) return null;
      if (cycle < this.renderWindow.start || cycle > this.renderWindow.end) return null;
      const ratio = (cycle - this.renderWindow.start) / Math.max(1, this.renderWindow.size);
      return this.plotBounds.x + ratio * this.plotBounds.width;
    }

    laneIndexFromY(y) {
      if (!this.laneBounds.length) return -1;
      let nearest = -1;
      let distance = Infinity;
      this.laneBounds.forEach(function (bounds, index) {
        if (y >= bounds.y && y <= bounds.y + bounds.height) {
          nearest = index;
          distance = 0;
          return;
        }
        const center = bounds.y + bounds.height / 2;
        const nextDistance = Math.abs(center - y);
        if (nextDistance < distance) {
          distance = nextDistance;
          nearest = index;
        }
      });
      return nearest;
    }

    handleOverlayPointerDown(event) {
      if (!this.tool && !event.target.classList.contains('presenter-cursor-line')) return;
      const point = this.clientPoint(event);
      if (!point) return;
      event.preventDefault();
      this.overlay.setPointerCapture(event.pointerId);
      if (event.target.dataset && event.target.dataset.cursor) {
        this.activeCursor = event.target.dataset.cursor;
        this.tool = 'cursor';
      }
      if (this.tool === 'range') {
        const cycle = this.cycleFromX(point.x);
        this.annotations.range = { startCycle: cycle, endCycle: cycle };
        this.drag = { kind: 'range', pointerId: event.pointerId };
      } else if (this.tool === 'cursor') {
        const cycle = this.cycleFromX(point.x);
        this.annotations[this.activeCursor === 'B' ? 'cursorB' : 'cursorA'] = cycle;
        this.drag = { kind: 'cursor', pointerId: event.pointerId, cursor: this.activeCursor };
      } else if (this.tool === 'focus') {
        const rowIndex = this.laneIndexFromY(point.y);
        this.annotations.focus = {
          rowIndex: rowIndex,
          rowKey: this.rowKeys[rowIndex] || ''
        };
      } else if (this.tool === 'pointer') {
        const rowIndex = this.laneIndexFromY(point.y);
        this.annotations.pointer = {
          cycle: this.cycleFromX(point.x),
          rowIndex: rowIndex,
          rowKey: this.rowKeys[rowIndex] || ''
        };
        this.drag = { kind: 'pointer', pointerId: event.pointerId };
      }
      this.drawAnnotations();
      this.updateToolState();
    }

    handleOverlayPointerMove(event) {
      if (!this.drag || this.drag.pointerId !== event.pointerId) return;
      const point = this.clientPoint(event);
      if (!point) return;
      if (this.drag.kind === 'range' && this.annotations.range) {
        this.annotations.range.endCycle = this.cycleFromX(point.x);
      } else if (this.drag.kind === 'cursor') {
        this.annotations[this.drag.cursor === 'B' ? 'cursorB' : 'cursorA'] = this.cycleFromX(point.x);
      } else if (this.drag.kind === 'pointer') {
        const rowIndex = this.laneIndexFromY(point.y);
        this.annotations.pointer = {
          cycle: this.cycleFromX(point.x),
          rowIndex: rowIndex,
          rowKey: this.rowKeys[rowIndex] || ''
        };
      }
      this.drawAnnotations();
    }

    handleOverlayPointerUp(event) {
      if (!this.drag || this.drag.pointerId !== event.pointerId) return;
      try { this.overlay.releasePointerCapture(event.pointerId); } catch (_error) { /* already released */ }
      if (this.drag.kind === 'range' && this.annotations.range) {
        const start = Math.min(this.annotations.range.startCycle, this.annotations.range.endCycle);
        const end = Math.max(this.annotations.range.startCycle, this.annotations.range.endCycle);
        this.annotations.range = Math.abs(end - start) < 0.25 ? null : { startCycle: start, endCycle: end };
      }
      this.drag = null;
      this.drawAnnotations();
    }

    drawAnnotations() {
      if (!this.overlay || !this.svgMetrics) return;
      while (this.overlay.firstChild) this.overlay.removeChild(this.overlay.firstChild);
      const view = this.svgMetrics;
      const plot = this.plotBounds || view;
      const focus = this.annotations.focus;
      if (focus && this.laneBounds[focus.rowIndex]) {
        const bounds = this.laneBounds[focus.rowIndex];
        const shadeRects = [
          { x: view.x, y: view.y, width: view.width, height: Math.max(0, bounds.y - view.y) },
          { x: view.x, y: bounds.y + bounds.height, width: view.width, height: Math.max(0, view.y + view.height - bounds.y - bounds.height) },
          { x: view.x, y: bounds.y, width: Math.max(0, bounds.x - view.x), height: bounds.height },
          { x: bounds.x + bounds.width, y: bounds.y, width: Math.max(0, view.x + view.width - bounds.x - bounds.width), height: bounds.height }
        ];
        shadeRects.filter(function (rect) { return rect.width > 0 && rect.height > 0; })
          .forEach((rect) => {
            this.overlay.appendChild(createSvgElement('rect', Object.assign({ class: 'presenter-focus-shade' }, rect)));
          });
        this.overlay.appendChild(createSvgElement('rect', {
          class: 'presenter-focus-outline',
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          rx: 2
        }));
      }

      const range = this.annotations.range;
      if (range) {
        const x1 = this.xFromCycle(range.startCycle);
        const x2 = this.xFromCycle(range.endCycle);
        if (x1 != null || x2 != null) {
          const left = x1 == null ? plot.x : x1;
          const right = x2 == null ? plot.x + plot.width : x2;
          this.overlay.appendChild(createSvgElement('rect', {
            class: 'presenter-range-rect',
            x: Math.min(left, right),
            y: plot.y,
            width: Math.max(1, Math.abs(right - left)),
            height: plot.height,
            rx: 2
          }));
        }
      }

      this.drawCursor('A', this.annotations.cursorA);
      this.drawCursor('B', this.annotations.cursorB);

      const pointer = this.annotations.pointer;
      if (pointer) {
        const x = this.xFromCycle(pointer.cycle);
        const lane = this.laneBounds[pointer.rowIndex];
        if (x != null && lane) {
          const y = lane.y + lane.height / 2;
          this.overlay.appendChild(createSvgElement('circle', {
            class: 'presenter-pointer-ring', cx: x, cy: y, r: 8
          }));
          this.overlay.appendChild(createSvgElement('circle', {
            class: 'presenter-pointer-dot', cx: x, cy: y, r: 2.5
          }));
        }
      }
      this.updateMeasurements();
    }

    drawCursor(name, cycle) {
      const x = this.xFromCycle(cycle);
      if (x == null) return;
      const plot = this.plotBounds || this.svgMetrics;
      const lower = String(name).toLowerCase();
      const line = createSvgElement('line', {
        class: 'presenter-cursor-line cursor-' + lower,
        x1: x,
        x2: x,
        y1: plot.y,
        y2: plot.y + plot.height,
        'data-cursor': name
      });
      line.dataset.cursor = name;
      this.overlay.appendChild(line);
      const labelY = Math.max(this.svgMetrics.y + 9, plot.y - 8);
      this.overlay.appendChild(createSvgElement('rect', {
        class: 'presenter-cursor-label-bg cursor-' + lower,
        x: x - 8,
        y: labelY - 8,
        width: 16,
        height: 16,
        rx: 3
      }));
      const text = createSvgElement('text', {
        class: 'presenter-cursor-label presenter-cursor-label-text',
        x: x,
        y: labelY
      });
      text.textContent = name;
      this.overlay.appendChild(text);
    }

    updateMeasurements() {
      const a = this.annotations.cursorA;
      const b = this.annotations.cursorB;
      this.measureA.textContent = 'A: ' + formatCycle(a);
      this.measureB.textContent = 'B: ' + formatCycle(b);
      this.measureDelta.textContent = 'B-A: ' + (Number.isFinite(a) && Number.isFinite(b)
        ? formatCycle(b - a)
        : '--');
    }

    clearAnnotations() {
      this.annotations = { pointer: null, focus: null, range: null, cursorA: null, cursorB: null };
      this.drawAnnotations();
      this.showToast('已清除讲解标注');
    }

    captureStep() {
      return {
        annotations: cloneValue(this.annotations),
        tool: this.tool,
        activeCursor: this.activeCursor,
        windowStart: this.windowStart,
        scale: this.scale,
        fitMode: this.fitMode,
        scrollLeft: this.viewport.scrollLeft,
        scrollTop: this.viewport.scrollTop
      };
    }

    recordStep() {
      const step = this.captureStep();
      this.steps = this.steps.slice(0, this.stepIndex + 1);
      this.steps.push(step);
      this.stepIndex = this.steps.length - 1;
      this.updateStepControls();
      this.showToast('已记录第 ' + (this.stepIndex + 1) + ' 个演讲步骤');
    }

    async goToStep(index) {
      if (index < 0 || index >= this.steps.length || index === this.stepIndex) return;
      const step = cloneValue(this.steps[index]);
      this.stepIndex = index;
      this.annotations = step.annotations || this.annotations;
      this.keepAnnotationsInSourceBounds(
        Math.max(0, Number(this.metrics.maxWaveLength) || 0),
        Number(this.metrics.signalCount) || 0
      );
      this.tool = step.tool || '';
      this.activeCursor = step.activeCursor || 'A';
      const total = Math.max(0, Number(this.metrics.maxWaveLength) || 0);
      const maxStart = Math.max(0, total - this.windowSize);
      const nextStart = clamp(step.windowStart, 0, maxStart);
      if (nextStart !== this.windowStart) {
        this.windowStart = nextStart;
        await this.renderWave({ preserveView: false });
      }
      this.fitMode = !!step.fitMode;
      if (this.fitMode) this.fitToWindow(false);
      else this.setScale(step.scale || 1, false);
      requestAnimationFrame(() => {
        this.viewport.scrollLeft = step.scrollLeft || 0;
        this.viewport.scrollTop = step.scrollTop || 0;
        this.drawAnnotations();
        this.updateFrozenLabels();
      });
      this.updateToolState();
      this.updateStepControls();
    }

    updateStepControls() {
      const count = this.steps.length || 1;
      const index = this.stepIndex >= 0 ? this.stepIndex + 1 : 1;
      this.stepCount.textContent = index + ' / ' + count;
      const previous = this.app.querySelector('[data-action="step-prev"]');
      const next = this.app.querySelector('[data-action="step-next"]');
      previous.disabled = this.stepIndex <= 0;
      next.disabled = this.stepIndex < 0 || this.stepIndex >= this.steps.length - 1;
    }

    toggleNotes() {
      const collapsed = this.workspace.classList.toggle('notes-collapsed');
      const topButton = this.app.querySelector('.presenter-top-actions [data-action="notes"]');
      if (topButton) topButton.setAttribute('aria-pressed', collapsed ? 'false' : 'true');
      if (!collapsed) requestAnimationFrame(() => this.notesText.focus({ preventScroll: true }));
      if (this.fitMode) requestAnimationFrame(() => this.fitToWindow(false));
    }

    async toggleFullscreen() {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
        else this.showToast('当前浏览器不支持网页全屏', true);
      } catch (error) {
        this.showToast('无法切换全屏：' + error.message, true);
      }
    }

    handleFullscreenChange() {
      this.app.classList.toggle('fullscreen', !!document.fullscreenElement);
      const button = this.app.querySelector('[data-action="fullscreen"] span');
      if (button) button.textContent = document.fullscreenElement ? '退出全屏' : '全屏';
      this.noteActivity();
      if (this.fitMode) requestAnimationFrame(() => this.fitToWindow(false));
    }

    noteActivity() {
      if (!this.app) return;
      this.app.classList.remove('controls-idle');
      clearTimeout(this.controlsTimer);
      if (!document.fullscreenElement) return;
      this.controlsTimer = setTimeout(() => {
        if (document.activeElement === this.notesText) return;
        this.app.classList.add('controls-idle');
      }, 2600);
    }

    handleKeydown(event) {
      const target = event.target;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
        || target.isContentEditable);
      if (typing) {
        if (event.key === 'Escape') target.blur();
        return;
      }
      const key = String(event.key || '').toLowerCase();
      if (key === 'f') {
        event.preventDefault();
        void this.toggleFullscreen();
      } else if (key === 'arrowleft') {
        event.preventDefault();
        this.goToStep(this.stepIndex - 1);
      } else if (key === 'arrowright') {
        event.preventDefault();
        this.goToStep(this.stepIndex + 1);
      } else if (key === 'z') {
        event.preventDefault();
        this.fitToWindow(true);
      } else if (key === 'p') {
        event.preventDefault();
        this.setTool('pointer');
      } else if (key === 'r') {
        event.preventDefault();
        this.setTool('range');
      } else if (key === 'a' || key === 'b') {
        event.preventDefault();
        this.activeCursor = key.toUpperCase();
        this.setTool('cursor', true);
      } else if (key === 'n') {
        event.preventDefault();
        this.toggleNotes();
      } else if (key === 'escape') {
        if (document.fullscreenElement) {
          event.preventDefault();
          void document.exitFullscreen();
        } else if (this.tool) {
          event.preventDefault();
          this.setTool('');
        }
      }
    }

    destroy() {
      this.destroyed = true;
      clearTimeout(this.toastTimer);
      clearTimeout(this.liveTimer);
      clearTimeout(this.controlsTimer);
      if (this.resizeObserver) this.resizeObserver.disconnect();
      document.removeEventListener('keydown', this.boundKeydown);
      document.removeEventListener('fullscreenchange', this.boundFullscreen);
      document.removeEventListener('mousemove', this.boundActivity);
      document.removeEventListener('pointerdown', this.boundActivity);
      if (this.app) this.app.remove();
      if (root.__visualWaveDromPresenterView === this) delete root.__visualWaveDromPresenterView;
    }
  }

  async function mount(adapter) {
    if (root.__visualWaveDromPresenterView
        && typeof root.__visualWaveDromPresenterView.destroy === 'function') {
      root.__visualWaveDromPresenterView.destroy();
    }
    const view = new PresenterView(adapter || {});
    return view.mount();
  }

  return {
    version: '1.0.0',
    mount: mount
  };
}));

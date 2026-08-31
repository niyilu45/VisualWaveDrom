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
  const HISTORY_LIMIT = 100;
  const DEFAULT_STEP_TITLE = '演讲步骤';
  const SHORTCUTS = root.VisualWaveDromPresenterShortcuts;
  const SHORTCUT_COMMANDS = [
    ['pointer', '指示', '1', 'tool'], ['pen', '画笔', '2', 'tool'],
    ['arrow', '箭头', '3', 'tool'], ['rectangle', '多边形', '4', 'tool'],
    ['eraser', '橡皮擦', 'q', 'tool'], ['text', '文字', 'w', 'tool'],
    ['focus', '聚焦', 'e', 'tool'], ['cursor-A', '游标A', 'r', 'cursor', 'A'],
    ['cursor-B', '游标B', 'a', 'cursor', 'B'], ['step-prev', '上一步', 's'],
    ['step-next', '下一步', 'd'], ['step-add', '新增步骤', 'f'],
    ['fit', '适应窗口', 'z'], ['notes', '讲解备注', 'x'],
    ['copy-image', '复制图片', 'c'], ['fullscreen', '全屏', 'v'],
    ['save', '保存演讲步骤', 'Ctrl+s'], ['undo', '撤销标注', 'Ctrl+z'],
    ['redo', '重做标注', 'Ctrl+Shift+z'], ['settings', '设置', 'Shift+1'],
    ['shape-style', '画笔与图形样式', 'Shift+2'], ['clear', '清除标注', 'Shift+3'],
    ['notes-detach', '悬浮窗显示备注', 'Shift+4'], ['notes-restore', '恢复备注', 'Shift+q'],
    ['window-prev', '上一段波形', 'Shift+w'], ['window-next', '下一段波形', 'Shift+e'],
    ['exit', '退出演讲者模式', 'Shift+r'], ['copy-full', '复制整张图片', 'Shift+a'],
    ['copy-focus', '复制聚焦区域', 'Shift+s'], ['text-done', '完成文字编辑', 'Ctrl+Enter'],
    ['text-cancel', '取消文字编辑', ''], ['copy-close', '关闭图片复制选项', ''],
    ['focus-close', '收起聚焦配置', ''], ['shape-style-close', '收起图形样式', ''],
    ['exit-save', '保存并退出', ''], ['exit-discard', '不保存并退出', ''],
    ['exit-cancel', '取消退出', ''], ['settings-close', '关闭设置', ''],
    ['shortcuts-reset', '恢复默认快捷键', '']
  ].map(([id, label, key, attribute, value]) => ({
    id, label, key, selector: 'button[data-' + (attribute || 'action') + '="' + (value || id) + '"]'
  }));
  const DEFAULT_SHORTCUTS = Object.fromEntries(SHORTCUT_COMMANDS.map(command => [command.id, command.key]));
  const SHAPE_COLORS = [
    ['#ce2f2f', '红色'], ['#2775b8', '蓝色'], ['#19804e', '绿色'],
    ['#bf650d', '橙色'], ['#7f52b8', '紫色'], ['#263541', '深灰色']
  ];

  const ICONS = {
    settings: '<path d="M20 7h-9M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    fullscreen: '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/>',
    fit: '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/><path d="M9 9h6v6H9z"/>',
    notes: '<path d="M14 2H6a2 2 0 0 0-2 2v16l4-4h10a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
    popout: '<path d="M15 3h6v6M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/>',
    restore: '<path d="M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3M21 3l-9 9m0-6v6h6"/>',
    chevronLeft: '<path d="m15 18-6-6 6-6"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    pointer: '<path d="m3 3 7.1 17 2.4-7.5L20 10.1z"/>',
    focus: '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/>',
    pen: '<path d="m16 3 5 5M4 20l4-1L21 6a2.1 2.1 0 0 0-3-3L5 16z"/>',
    arrow: '<path d="M7 7h10v10M7 17 17 7"/>',
    rectangle: '<rect x="3" y="3" width="18" height="18" rx="2"/>',
    move: '<path d="m5 9-3 3 3 3m4-10 3-3 3 3m0 14-3 3-3-3m10-10 3 3-3 3M2 12h20M12 2v20"/>',
    text: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
    eraser: '<path d="m16 3 5 5a2 2 0 0 1 0 3L11 21H6l-3-3a2 2 0 0 1 0-3L13 3a2 2 0 0 1 3 0ZM8 10l7 7M11 21h10"/>',
    undo: '<path d="M3 7v6h6M3 13l4-4a7 7 0 0 1 12 5v4"/>',
    redo: '<path d="M21 7v6h-6M21 13l-4-4a7 7 0 0 0-12 5v4"/>',
    cursor: '<path d="M8 3v18M16 3v18"/><path d="m5 6 3-3 3 3M13 18l3 3 3-3"/>',
    clear: '<path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6"/>',
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

  function emptyAnnotations() {
    return { focus: null, cursorA: null, cursorB: null, marks: [] };
  }

  function isShapeKind(kind) {
    return kind === 'arrow' || kind === 'rectangle';
  }

  function parsePresentation(text) {
    const state = JSON.parse(text);
    const anchorOK = (anchor) => anchor && Number.isFinite(anchor.cycle)
      && Number.isInteger(anchor.rowIndex) && typeof anchor.rowKey === 'string' && Number.isFinite(anchor.offsetY);
    if (!state || state.kind !== 'VisualWaveDromPresentation' || state.version !== 1
        || !Array.isArray(state.steps) || !state.steps.length) throw new Error('不支持的演讲步骤格式');
    state.steps.forEach((step) => {
      if (!step || typeof step.title !== 'string' || typeof step.notes !== 'string'
          || !step.annotations || !Array.isArray(step.annotations.marks)) throw new Error('演讲步骤内容无效');
      const annotations = step.annotations;
      if (['cursorA', 'cursorB'].some((key) => annotations[key] != null && !Number.isFinite(annotations[key]))) {
        throw new Error('演讲游标位置无效');
      }
      if (annotations.focus && (!['rows', 'columns', 'rectangle'].includes(annotations.focus.mode)
          || !anchorOK(annotations.focus.start) || !anchorOK(annotations.focus.end))) throw new Error('聚焦位置无效');
      annotations.marks.forEach((mark) => {
        const valid = mark && typeof mark.id === 'string' && (mark.kind === 'pen'
          ? Array.isArray(mark.points) && mark.points.every(anchorOK)
          : isShapeKind(mark.kind) ? anchorOK(mark.start) && anchorOK(mark.end)
            : mark.kind === 'text' && anchorOK(mark.anchor) && typeof mark.text === 'string');
        if (!valid) throw new Error('演讲批注内容无效');
      });
    });
    return state;
  }

  function pointSegmentDistance(point, start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = dx * dx + dy * dy;
    const t = length ? clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / length, 0, 1) : 0;
    return Math.hypot(point.x - start.x - t * dx, point.y - start.y - t * dy);
  }

  function segmentsNear(a, b, c, d, radius) {
    const cross = function (p, q, r) {
      return (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    };
    if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return true;
    return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d),
      pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b)) <= radius;
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
      this.rowKeyIndices = new Map();
      this.tool = '';
      this.activeCursor = 'A';
      this.annotations = emptyAnnotations();
      this.focusEnabled = false;
      this.focusMode = 'rows';
      this.undoStack = [];
      this.redoStack = [];
      this.markSequence = 0;
      this.markGeometry = new Map();
      this.selectedMarkId = null;
      this.markPick = null;
      this.shapeStyles = {
        arrow: { color: SHAPE_COLORS[0][0], width: 3 },
        rectangle: { color: SHAPE_COLORS[0][0], width: 3 }
      };
      this.penColor = SHAPE_COLORS[0][0];
      this.lastHistoryEdit = null;
      this.annotationFrame = 0;
      this.laserFrame = 0;
      this.laserPosition = null;
      this.pointerStroke = [];
      this.pointerStrokeFrame = 0;
      this.pointerInk = null;
      this.pointerStrokeColor = this.penColor;
      this.textEdit = null;
      this.annotationTextMetrics = null;
      this.steps = [];
      this.stepIndex = -1;
      this.stepTitleEdit = null;
      this.notesDirty = false;
      this.notesWindow = null;
      this.notesWindowOpening = false;
      this.copying = false;
      this.copySequence = 0;
      this.savedPresentation = '';
      this.savedSignature = null;
      this.saving = false;
      this.savePromise = null;
      this.allowClose = false;
      this.closeTimer = 0;
      this.beforeUnloadAttached = false;
      this.eventsBound = false;
      this.shortcutBindings = SHORTCUTS ? SHORTCUTS.read(DEFAULT_SHORTCUTS) : Object.assign({}, DEFAULT_SHORTCUTS);
      this.shortcutChannel = null;
      this.boundShortcutStorage = (event) => {
        if (SHORTCUTS && (event.key === SHORTCUTS.storageKey || event.key === null)) {
          this.shortcutBindings = SHORTCUTS.read(DEFAULT_SHORTCUTS);
          this.refreshShortcutUI();
        }
      };
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
      this.boundOutside = this.handleOutsidePointerDown.bind(this);
      this.boundBeforeUnload = this.handleBeforeUnload.bind(this);
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
        + '    <textarea class="presenter-step-title" id="presenter-step-title" rows="1" aria-label="演讲步骤文字" disabled>' + DEFAULT_STEP_TITLE + '</textarea>'
        + '    <div class="presenter-step-navigation">'
        + '    <button type="button" class="presenter-icon-button" data-action="step-prev" title="上一步" aria-label="上一步">' + icon('chevronLeft') + '</button>'
        + '    <span class="presenter-step-count" id="presenter-step-count">1 / 1</span>'
        + '    <button type="button" class="presenter-icon-button" data-action="step-next" title="下一步" aria-label="下一步">' + icon('chevronRight') + '</button>'
        + '    <button type="button" class="presenter-icon-button" data-action="step-add" title="记录当前画面为新步骤" aria-label="记录当前步骤">' + icon('plus') + '</button>'
        + '    </div>'
        + '  </div>'
        + '  <div class="presenter-window-controls" id="presenter-window-controls" aria-label="大波形分段浏览" hidden>'
        + '    <button type="button" class="presenter-icon-button" data-action="window-prev" title="上一段" aria-label="上一段">' + icon('chevronLeft') + '</button>'
        + '    <span class="presenter-window-range" id="presenter-window-range"></span>'
        + '    <button type="button" class="presenter-icon-button" data-action="window-next" title="下一段" aria-label="下一段">' + icon('chevronRight') + '</button>'
        + '  </div>'
        + '  <div class="presenter-top-actions">'
        + '    <span class="presenter-save-state" id="presenter-save-state" role="status" aria-live="polite"></span>'
        + buttonMarkup('save', 'save', '保存', '保存演讲步骤')
        + buttonMarkup('fit', 'fit', '适应窗口', '适应窗口')
        + '    <button type="button" class="presenter-button" data-action="copy-image" title="复制图片" aria-haspopup="dialog" aria-controls="presenter-copy-options" aria-expanded="false" disabled>' + icon('image') + '<span>复制图片</span></button>'
        + buttonMarkup('notes', 'notes', '讲解备注', '显示或隐藏讲解备注')
        + '    <button type="button" class="presenter-icon-button" data-action="notes-restore" title="恢复备注到当前窗口" aria-label="恢复备注" hidden>' + icon('restore') + '</button>'
        + buttonMarkup('fullscreen', 'fullscreen', '全屏', '进入或退出全屏')
        + '    <button type="button" class="presenter-button" data-action="settings" title="设置" aria-haspopup="dialog" aria-controls="presenter-settings" aria-expanded="false">' + icon('settings') + '<span>设置</span></button>'
        + buttonMarkup('exit', 'close', '退出', '退出演讲者模式', 'presenter-exit-button')
        + '  </div>'
        + '</header>'
        + '<div class="presenter-workspace" id="presenter-workspace">'
        + '  <main class="presenter-stage-shell">'
        + '    <div class="presenter-live-status" id="presenter-live-status" aria-live="polite" hidden></div>'
        + '    <div class="presenter-stage-viewport" id="presenter-stage-viewport" tabindex="0" aria-label="波形演讲与标注区域">'
        + '      <div class="presenter-stage-content" id="presenter-stage-content">'
        + '        <div class="presenter-wave-surface" id="presenter-wave-surface">'
        + '          <div class="presenter-wave-display" id="presenter-wave-display"></div>'
        + '          <svg class="presenter-overlay" id="presenter-overlay" aria-label="演讲标注层"></svg>'
        + '          <section class="presenter-text-editor" id="presenter-text-editor" role="group" aria-label="图中文字编辑" hidden>'
        + '            <div class="presenter-text-clip"><div class="presenter-text-field" id="presenter-text-field">'
        + '              <span class="presenter-text-measure" id="presenter-text-measure" aria-hidden="true"></span>'
        + '              <textarea id="presenter-text-input" aria-label="标注文字内容" rows="1" wrap="off" spellcheck="false"></textarea>'
        + '            </div></div>'
        + '            <div class="presenter-text-actions" id="presenter-text-actions">'
        + buttonMarkup('text-done', 'save', '完成', '完成文字编辑')
        + '              <button type="button" class="presenter-icon-button" data-action="text-cancel" title="取消" aria-label="取消文字编辑">' + icon('close') + '</button>'
        + '            </div>'
        + '          </section>'
        + '        </div>'
        + '      </div>'
        + '      <div class="presenter-frozen-labels" id="presenter-frozen-labels" aria-hidden="true"></div>'
        + '    </div>'
        + '    <div class="presenter-stage-message" id="presenter-stage-message"><div><strong id="presenter-stage-message-title">正在加载</strong><span id="presenter-stage-message-detail"></span></div></div>'
        + '  </main>'
        + '  <aside class="presenter-notes" id="presenter-notes" aria-label="讲解备注">'
        + '    <div class="presenter-notes-header"><h2>讲解备注</h2><div class="presenter-notes-actions">'
        + '      <button type="button" class="presenter-icon-button" data-action="notes-detach" title="在独立悬浮窗口中显示备注" aria-label="悬浮窗显示备注">' + icon('popout') + '</button>'
        + '      <button type="button" class="presenter-icon-button" data-action="notes-restore" title="恢复备注到原窗口" aria-label="恢复备注" hidden>' + icon('restore') + '</button>'
        + '      <button type="button" class="presenter-icon-button" data-action="notes" title="收起备注" aria-label="收起备注">' + icon('panelClose') + '</button>'
        + '    </div></div>'
        + '    <textarea class="presenter-notes-text" id="presenter-notes-text" spellcheck="false" placeholder="记录本次讲解要点"></textarea>'
        + '  </aside>'
        + '</div>'
        + '<footer class="presenter-tooltray" aria-label="讲解工具">'
        + '  <div class="presenter-tool-group">'
        + '    <button type="button" class="presenter-icon-button" data-action="undo" title="撤销标注" aria-label="撤销" disabled>' + icon('undo') + '</button>'
        + '    <button type="button" class="presenter-icon-button" data-action="redo" title="重做标注" aria-label="重做" disabled>' + icon('redo') + '</button>'
        + '    <button type="button" class="presenter-tool-button" data-tool="pointer" title="激光指示">' + icon('pointer') + '<span>指示</span></button>'
        + '    <button type="button" class="presenter-tool-button" data-tool="pen" title="画笔">' + icon('pen') + '<span>画笔</span></button>'
        + '    <button type="button" class="presenter-tool-button" data-tool="arrow" title="绘制箭头">' + icon('arrow') + '<span>箭头</span></button>'
        + '    <button type="button" class="presenter-tool-button" data-tool="rectangle" title="绘制矩形">' + icon('rectangle') + '<span>多边形</span></button>'
        + '    <button type="button" class="presenter-tool-button presenter-shape-style-button" data-action="shape-style" title="图形颜色和线宽" aria-label="图形颜色和线宽" aria-haspopup="dialog" aria-controls="presenter-shape-options" aria-expanded="false" disabled><span class="presenter-style-swatch" aria-hidden="true"></span><span id="presenter-shape-width-value">3 px</span></button>'
        + '    <button type="button" class="presenter-tool-button" data-tool="eraser" title="擦除笔迹、图形或文字">' + icon('eraser') + '<span>橡皮擦</span></button>'
        + '    <button type="button" class="presenter-tool-button" data-tool="text" title="添加或修改文字">' + icon('text') + '<span>文字</span></button>'
        + '    <button type="button" class="presenter-tool-button" data-tool="focus" title="配置或取消聚焦" aria-haspopup="dialog" aria-controls="presenter-focus-options" aria-expanded="false">' + icon('focus') + '<span>聚焦</span></button>'
        + '    <button type="button" class="presenter-tool-button" data-cursor="A" title="选择或取消游标 A">' + icon('cursor') + '<span>游标A</span></button>'
        + '    <button type="button" class="presenter-tool-button" data-cursor="B" title="选择或取消游标 B">' + icon('cursor') + '<span>游标B</span></button>'
        + '    <button type="button" class="presenter-tool-button" data-action="clear" title="清除当前演讲标注">' + icon('clear') + '<span>清除</span></button>'
        + '  </div>'
        + '  <div class="presenter-measurements" aria-label="游标测量">'
        + '    <span class="presenter-measurement" id="presenter-measure-a">A: --</span>'
        + '    <span class="presenter-measurement" id="presenter-measure-b">B: --</span>'
        + '    <span class="presenter-measurement" id="presenter-measure-delta">B-A: --</span>'
        + '  </div>'
        + '</footer>'
        + '<section class="presenter-popover presenter-settings" id="presenter-settings" role="dialog" aria-labelledby="presenter-settings-title" hidden>'
        + '  <div class="presenter-popover-header"><strong id="presenter-settings-title">设置</strong><button type="button" class="presenter-icon-button" data-action="settings-close" title="关闭设置" aria-label="关闭设置">' + icon('close') + '</button></div>'
        + '  <h2>快捷键</h2><div class="presenter-shortcut-list">'
        + SHORTCUT_COMMANDS.map(command => '<div class="presenter-shortcut-row"><label for="presenter-shortcut-' + command.id + '">' + command.label + '</label>'
          + '<input id="presenter-shortcut-' + command.id + '" data-shortcut-input="' + command.id + '" aria-label="' + command.label + '快捷键" aria-describedby="presenter-shortcut-status" type="text" readonly placeholder="未设置" autocomplete="off" spellcheck="false">'
          + '<button type="button" class="presenter-icon-button" data-shortcut-clear="' + command.id + '" title="清除' + command.label + '快捷键" aria-label="清除' + command.label + '快捷键">' + icon('close') + '</button></div>').join('')
        + '  </div><p id="presenter-shortcut-status" role="status" aria-live="polite"></p>'
        + '  <div class="presenter-settings-footer">' + buttonMarkup('shortcuts-reset', 'undo', '恢复默认', '恢复默认快捷键') + '</div>'
        + '</section>'
        + '<section class="presenter-popover presenter-copy-options" id="presenter-copy-options" role="dialog" aria-label="复制图片" hidden>'
        + '  <div class="presenter-popover-header"><strong>复制图片</strong><button type="button" class="presenter-icon-button" data-action="copy-close" title="关闭" aria-label="关闭图片复制选项">' + icon('close') + '</button></div>'
        + '  <div class="presenter-copy-choices">' + buttonMarkup('copy-full', 'image', '整张图片', '复制整张波形和批注') + buttonMarkup('copy-focus', 'focus', '仅聚焦区域', '复制聚焦区域、波形名和批注') + '</div>'
        + '  <p id="presenter-copy-status" class="presenter-copy-status" role="status" aria-live="polite" hidden></p>'
        + '</section>'
        + '<section class="presenter-popover presenter-focus-options" id="presenter-focus-options" role="dialog" aria-label="聚焦模式" hidden>'
        + '  <div class="presenter-popover-header"><strong>聚焦模式</strong><button type="button" class="presenter-icon-button" data-action="focus-close" title="收起" aria-label="收起聚焦配置">' + icon('close') + '</button></div>'
        + '  <div class="presenter-focus-modes">'
        + '    <label><input type="radio" name="presenter-focus-mode" value="rows" checked><span>多行</span></label>'
        + '    <label><input type="radio" name="presenter-focus-mode" value="columns"><span>多列</span></label>'
        + '    <label><input type="radio" name="presenter-focus-mode" value="rectangle"><span>矩形</span></label>'
        + '  </div>'
        + '</section>'
        + '<section class="presenter-popover presenter-shape-options" id="presenter-shape-options" role="dialog" aria-labelledby="presenter-shape-options-title" hidden>'
        + '  <div class="presenter-popover-header"><strong id="presenter-shape-options-title">图形样式</strong><button type="button" class="presenter-icon-button" data-action="shape-style-close" title="收起" aria-label="收起图形样式">' + icon('close') + '</button></div>'
        + '  <div class="presenter-shape-colors" role="group" aria-label="线条颜色">'
        + SHAPE_COLORS.map(function (color) {
          return '<button type="button" class="presenter-color-swatch" data-shape-color="' + color[0] + '" style="--swatch-color:' + color[0] + '" title="' + color[1] + '" aria-label="' + color[1] + '" aria-pressed="false"></button>';
        }).join('')
        + '  </div>'
        + '  <div class="presenter-shape-width-row"><label for="presenter-shape-width">线宽</label><input id="presenter-shape-width" type="range" min="1" max="16" step="1" value="3"><output id="presenter-shape-width-output" for="presenter-shape-width">3 px</output></div>'
        + '</section>'
        + '<dialog class="presenter-exit-dialog" id="presenter-exit-dialog" aria-labelledby="presenter-exit-title" aria-describedby="presenter-exit-message" hidden>'
        + '  <h2 id="presenter-exit-title">保存演讲步骤？</h2><p id="presenter-exit-message">演讲步骤有未保存的改动。</p>'
        + '  <div class="presenter-exit-actions">' + buttonMarkup('exit-cancel', 'undo', '取消', '继续演讲')
        + buttonMarkup('exit-discard', 'close', '不保存', '放弃未保存的改动并退出')
        + buttonMarkup('exit-save', 'save', '保存并退出', '保存演讲步骤并退出', 'presenter-primary-button') + '</div>'
        + '</dialog>'
        + '<div class="presenter-laser" id="presenter-laser" aria-hidden="true" hidden></div>'
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
      this.notesPanel = app.querySelector('#presenter-notes');
      this.stepCount = app.querySelector('#presenter-step-count');
      this.stepTitleInput = app.querySelector('#presenter-step-title');
      this.windowControls = app.querySelector('#presenter-window-controls');
      this.windowRange = app.querySelector('#presenter-window-range');
      this.measureA = app.querySelector('#presenter-measure-a');
      this.measureB = app.querySelector('#presenter-measure-b');
      this.measureDelta = app.querySelector('#presenter-measure-delta');
      this.toast = app.querySelector('#presenter-toast');
      this.focusOptions = app.querySelector('#presenter-focus-options');
      this.copyOptions = app.querySelector('#presenter-copy-options');
      this.copyButton = app.querySelector('[data-action="copy-image"]');
      this.copyStatus = app.querySelector('#presenter-copy-status');
      this.saveButton = app.querySelector('[data-action="save"]');
      this.saveState = app.querySelector('#presenter-save-state');
      this.exitDialog = app.querySelector('#presenter-exit-dialog');
      this.exitMessage = app.querySelector('#presenter-exit-message');
      this.settingsOptions = app.querySelector('#presenter-settings');
      this.settingsButton = app.querySelector('[data-action="settings"]');
      this.shortcutStatus = app.querySelector('#presenter-shortcut-status');
      this.shapeOptions = app.querySelector('#presenter-shape-options');
      this.shapeStyleButton = app.querySelector('[data-action="shape-style"]');
      this.shapeWidthInput = app.querySelector('#presenter-shape-width');
      this.shapeWidthRow = app.querySelector('.presenter-shape-width-row');
      this.textEditor = app.querySelector('#presenter-text-editor');
      this.textField = app.querySelector('#presenter-text-field');
      this.textInput = app.querySelector('#presenter-text-input');
      this.textMeasure = app.querySelector('#presenter-text-measure');
      this.textActions = app.querySelector('#presenter-text-actions');
      this.laser = app.querySelector('#presenter-laser');
      this.libraryEl.textContent = this.adapter.libraryName || 'SQLite 波形库';
      if (document.documentElement.clientWidth < 760) this.workspace.classList.add('notes-collapsed');
      this.updateNotesControls();
      this.updateToolState();
      this.updateSaveControls();
      this.refreshShortcutUI();
    }

    bindEvents() {
      this.eventsBound = true;
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
        const cursorButton = event.target.closest('button[data-cursor]');
        if (cursorButton) {
          this.selectCursor(cursorButton.dataset.cursor);
        }
      });
      this.stepTitleInput.addEventListener('focus', () => {
        this.stepTitleEdit = this.steps[this.stepIndex] || null;
        this.noteActivity();
      });
      this.stepTitleInput.addEventListener('input', () => {
        this.resizeStepTitle();
        this.updateSaveControls();
      });
      this.stepTitleInput.addEventListener('blur', () => this.finishStepTitleEdit(true));
      this.notesText.addEventListener('input', () => {
        this.notesDirty = true;
        this.saveStepNotes();
      });
      this.textInput.addEventListener('input', () => {
        this.resizeTextEditor();
        this.updateSaveControls();
      });
      this.textEditor.addEventListener('focusout', (event) => {
        if (event.relatedTarget && !this.textEditor.contains(event.relatedTarget)) this.finishTextEdit(true, false);
      });
      this.exitDialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        if (!this.saving) this.cancelExit();
      });
      this.notesPanel.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-action]');
        if (!button || !this.notesPanel.contains(button)) return;
        event.stopPropagation();
        this.handleAction(button.dataset.action);
      });
      this.notesPanel.addEventListener('keydown', (event) => {
        if (this.notesPanel.ownerDocument !== document) this.handleKeydown(event);
      });
      this.settingsOptions.addEventListener('keydown', (event) => this.captureShortcut(event));
      this.settingsOptions.addEventListener('click', (event) => {
        const button = event.target.closest('[data-shortcut-clear]');
        if (button) this.setShortcut(button.dataset.shortcutClear, '');
      });
      root.addEventListener('storage', this.boundShortcutStorage);
      if (SHORTCUTS && typeof root.BroadcastChannel === 'function') {
        try {
          this.shortcutChannel = new root.BroadcastChannel(SHORTCUTS.storageKey);
          this.shortcutChannel.addEventListener('message', (event) => {
            if (!event.data || event.data.version !== 1) return;
            this.shortcutBindings = SHORTCUTS.sanitize(event.data, DEFAULT_SHORTCUTS);
            this.refreshShortcutUI();
          });
        } catch (_error) { /* storage events still synchronize supported windows */ }
      }
      if (root.VisualWaveDromPresenterNotes) {
        this.notesWindow = root.VisualWaveDromPresenterNotes.create({
          element: this.notesPanel,
          getTitle: () => this.titleEl.textContent + ' - 讲解备注',
          onPending: (pending) => {
            this.notesWindowOpening = pending;
            if (!this.destroyed) this.updateNotesControls();
          },
          onChange: (detached) => {
            if (this.destroyed) return;
            this.workspace.classList.toggle('notes-detached', detached);
            if (!detached) this.workspace.classList.remove('notes-collapsed');
            this.updateNotesControls();
            if (!detached) this.log('presenter-notes', { phase: 'restored' });
            if (this.fitMode) requestAnimationFrame(() => { if (!this.destroyed) this.fitToWindow(false); });
          },
          onOpen: (kind) => this.log('presenter-notes', { phase: 'detached', kind: kind }),
          onError: (error) => {
            this.log('presenter-notes', { phase: 'window-error', message: error.message });
            this.showToast(error.message === 'popup-blocked'
              ? '备注窗口被浏览器阻止，请允许此页面弹出窗口后重试。'
              : '备注窗口打开失败，内容仍保留在原窗口。', true);
          }
        });
      }
      this.focusOptions.addEventListener('change', (event) => {
        if (event.target.name === 'presenter-focus-mode') this.setFocusMode(event.target.value);
      });
      this.shapeOptions.addEventListener('click', (event) => {
        const swatch = event.target.closest('[data-shape-color]');
        if (swatch) this.applyShapeStyle({ color: swatch.dataset.shapeColor });
      });
      this.shapeWidthInput.addEventListener('input', () => {
        this.applyShapeStyle({ width: Number(this.shapeWidthInput.value) }, true);
      });
      this.shapeWidthInput.addEventListener('change', () => { this.lastHistoryEdit = null; });
      this.shapeWidthInput.addEventListener('wheel', (event) => this.handleShapeWheel(event), { passive: false });
      this.shapeStyleButton.addEventListener('wheel', (event) => this.handleShapeWheel(event), { passive: false });
      this.viewport.addEventListener('scroll', () => {
        this.updateFrozenLabels();
        if (this.textEdit) this.positionTextEditor();
      }, { passive: true });
      this.viewport.addEventListener('wheel', (event) => this.handleWheel(event), { passive: false });
      this.viewport.addEventListener('pointermove', (event) => this.moveLaser(event), { passive: true });
      this.viewport.addEventListener('pointerleave', () => this.hideLaser());
      this.viewport.addEventListener('pointerdown', (event) => {
        if (this.tool === 'pointer' && event.button === 0 && event.isPrimary !== false && !this.drag) {
          this.clearPointerStroke();
          this.pulseLaser(event);
        }
      }, true);
      this.overlay.addEventListener('pointerdown', (event) => {
        if (this.tool && this.tool !== 'pointer') this.syncBeforeUnload(true);
        this.handleOverlayPointerDown(event);
      });
      this.viewport.addEventListener('pointerdown', (event) => this.handleViewportPointerDown(event));
      this.viewport.addEventListener('pointermove', (event) => this.handleOverlayPointerMove(event));
      this.viewport.addEventListener('pointerup', (event) => this.handleOverlayPointerUp(event));
      this.viewport.addEventListener('pointercancel', (event) => {
        if (this.drag && this.drag.pointerId === event.pointerId) this.finishGesture(true);
      });
      this.viewport.addEventListener('lostpointercapture', (event) => {
        if (this.drag && this.drag.pointerId === event.pointerId) this.finishGesture(false);
      });
      document.addEventListener('keydown', this.boundKeydown);
      document.addEventListener('pointerdown', this.boundOutside, true);
      document.addEventListener('fullscreenchange', this.boundFullscreen);
      document.addEventListener('mousemove', this.boundActivity, { passive: true });
      document.addEventListener('pointerdown', this.boundActivity, { passive: true });
      if (typeof ResizeObserver === 'function') {
        this.resizeObserver = new ResizeObserver((entries) => {
          const titleEntry = entries.find((entry) => entry.target === this.stepTitleInput);
          if (titleEntry && titleEntry.contentRect.width !== this.stepTitleWidth) {
            this.stepTitleWidth = titleEntry.contentRect.width;
            this.resizeStepTitle();
          }
          if (this.fitMode && this.svg) this.fitToWindow(false);
          else this.updateFrozenLabels();
          if (!this.focusOptions.hidden) this.positionFocusOptions();
          if (!this.shapeOptions.hidden) this.positionShapeOptions();
          if (!this.copyOptions.hidden) this.positionCopyOptions();
          if (!this.settingsOptions.hidden) this.positionSettings();
          if (this.textEdit) this.positionTextEditor();
        });
        this.resizeObserver.observe(this.viewport);
        this.resizeObserver.observe(this.focusOptions);
        this.resizeObserver.observe(this.shapeOptions);
        this.resizeObserver.observe(this.copyOptions);
        this.resizeObserver.observe(this.stepTitleInput);
        this.resizeObserver.observe(this.settingsOptions);
      }
    }

    handleAction(action) {
      if (action !== 'text-cancel') this.finishTextEdit(true);
      if (!['settings', 'settings-close', 'shortcuts-reset'].includes(action)) this.closeSettings(false);
      if (action === 'settings') {
        if (this.settingsOptions.hidden) this.openSettings();
        else this.closeSettings();
      } else if (action === 'settings-close') {
        this.closeSettings();
      } else if (action === 'shortcuts-reset') {
        this.shortcutBindings = Object.assign({}, DEFAULT_SHORTCUTS);
        this.persistShortcuts();
      } else if (action === 'exit') {
        this.requestExit();
      } else if (action === 'save') {
        void this.savePresentation();
      } else if (action === 'exit-save') {
        void this.saveAndExit();
      } else if (action === 'exit-discard') {
        if (!this.saving) this.closePresenter();
      } else if (action === 'exit-cancel') {
        if (!this.saving) this.cancelExit();
      } else if (action === 'fullscreen') {
        void this.toggleFullscreen();
      } else if (action === 'fit') {
        this.fitToWindow(true);
      } else if (action === 'copy-image') {
        this.openCopyOptions();
      } else if (action === 'copy-close') {
        this.closeCopyOptions();
      } else if (action === 'copy-full' || action === 'copy-focus') {
        void this.copyScreenshot(action === 'copy-focus' ? 'focus' : 'full');
      } else if (action === 'notes') {
        this.toggleNotes();
      } else if (action === 'notes-detach') {
        if (this.notesWindow) void this.notesWindow.open();
        else this.showToast('备注窗口模块未加载，请刷新页面后重试。', true);
      } else if (action === 'notes-restore') {
        if (this.notesWindow) this.notesWindow.restore();
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
      } else if (action === 'undo') {
        this.restoreHistory(false);
      } else if (action === 'redo') {
        this.restoreHistory(true);
      } else if (action === 'focus-close') {
        this.closeFocusOptions();
        this.viewport.focus({ preventScroll: true });
      } else if (action === 'shape-style') {
        if (this.shapeOptions.hidden) this.openShapeOptions();
        else this.closeShapeOptions();
      } else if (action === 'shape-style-close') {
        this.closeShapeOptions();
        this.viewport.focus({ preventScroll: true });
      } else if (action === 'text-cancel') {
        this.finishTextEdit(false);
      }
    }

    shortcutButtons(command) {
      const buttons = Array.from(this.app.querySelectorAll(command.selector));
      if (this.notesPanel && !this.app.contains(this.notesPanel)) buttons.push(...this.notesPanel.querySelectorAll(command.selector));
      return buttons;
    }

    refreshShortcutUI() {
      if (!this.settingsOptions || !SHORTCUTS || this.destroyed) return;
      SHORTCUT_COMMANDS.forEach(command => {
        const key = this.shortcutBindings[command.id];
        const text = SHORTCUTS.display(key);
        this.shortcutButtons(command).forEach(button => {
          if (!button.dataset.shortcutTitle) button.dataset.shortcutTitle = button.title || command.label;
          button.title = button.dataset.shortcutTitle + (key ? '（' + text + '）' : '');
          if (key) button.setAttribute('aria-keyshortcuts', key.replace(/\bCtrl\b/g, 'Control'));
          else button.removeAttribute('aria-keyshortcuts');
          const single = !!key && !key.includes('+');
          button.classList.toggle('has-shortcut', single);
          let badge = button.querySelector('.presenter-shortcut-hint');
          if (single && !badge) {
            badge = button.ownerDocument.createElement('kbd');
            badge.className = 'presenter-shortcut-hint';
            badge.setAttribute('aria-hidden', 'true');
            button.appendChild(badge);
          }
          if (badge) {
            if (single) badge.textContent = text;
            else badge.remove();
          }
        });
        const input = this.settingsOptions.querySelector('[data-shortcut-input="' + command.id + '"]');
        input.value = text;
        input.title = text || '未设置';
        input.removeAttribute('aria-invalid');
        this.settingsOptions.querySelector('[data-shortcut-clear="' + command.id + '"]').disabled = !key;
      });
    }

    persistShortcuts() {
      if (!SHORTCUTS) return;
      const saved = SHORTCUTS.write(this.shortcutBindings);
      this.refreshShortcutUI();
      this.shortcutStatus.textContent = saved ? '已保存' : '当前窗口已生效，但浏览器未允许保存设置';
      this.shortcutStatus.classList.toggle('error', !saved);
      if (this.shortcutChannel) {
        try { this.shortcutChannel.postMessage({ version: 1, bindings: this.shortcutBindings }); }
        catch (_error) { /* local settings are already applied */ }
      }
      this.log('presenter-shortcut', { phase: 'saved', persisted: saved });
    }

    setShortcut(id, value) {
      if (!SHORTCUTS || !Object.prototype.hasOwnProperty.call(DEFAULT_SHORTCUTS, id)) return;
      const key = SHORTCUTS.normalize(value);
      const conflict = SHORTCUT_COMMANDS.find(command => command.id !== id && key && this.shortcutBindings[command.id] === key);
      const message = key === null ? '不支持这个按键'
        : SHORTCUTS.reserved(key) ? '该按键由浏览器或文本编辑使用，请换一个'
          : conflict ? SHORTCUTS.display(key) + ' 已用于“' + conflict.label + '”，请先清除该项或换一个按键' : '';
      if (message) {
        this.shortcutStatus.textContent = message;
        this.shortcutStatus.classList.add('error');
        this.settingsOptions.querySelector('[data-shortcut-input="' + id + '"]').setAttribute('aria-invalid', 'true');
        return;
      }
      this.shortcutBindings[id] = key;
      this.persistShortcuts();
    }

    captureShortcut(event) {
      const input = event.target.closest('[data-shortcut-input]');
      if (!input || event.key === 'Tab') return;
      event.stopPropagation();
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      if (event.key === 'Escape') { this.closeSettings(); return; }
      if (event.repeat || ['Control', 'Meta', 'Alt', 'Shift', 'CapsLock'].includes(event.key)) return;
      if ((event.key === 'Backspace' || event.key === 'Delete') && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        this.setShortcut(input.dataset.shortcutInput, '');
      } else if (SHORTCUTS) this.setShortcut(input.dataset.shortcutInput, SHORTCUTS.fromEvent(event));
    }

    openSettings() {
      if (!SHORTCUTS) { this.showToast('快捷键模块未加载，请刷新页面后重试', true); return; }
      this.closeFocusOptions();
      this.closeShapeOptions();
      if (!this.copying) this.closeCopyOptions();
      this.refreshShortcutUI();
      this.shortcutStatus.textContent = '';
      this.shortcutStatus.classList.remove('error');
      this.settingsOptions.hidden = false;
      this.settingsButton.setAttribute('aria-expanded', 'true');
      this.positionSettings();
      this.settingsOptions.querySelector('[data-shortcut-input]').focus({ preventScroll: true });
      this.noteActivity();
    }

    positionSettings() {
      const button = this.settingsButton.getBoundingClientRect();
      this.positionPopover(this.settingsOptions, button.right - this.settingsOptions.offsetWidth, button.bottom, false);
    }

    closeSettings(restoreFocus) {
      if (!this.settingsOptions || this.settingsOptions.hidden) return;
      this.settingsOptions.hidden = true;
      this.settingsButton.setAttribute('aria-expanded', 'false');
      if (restoreFocus !== false) this.settingsButton.focus({ preventScroll: true });
    }

    isShortcutButtonVisible(button) {
      if (button.closest('[hidden]')) return false;
      if (this.workspace && this.workspace.classList.contains('notes-collapsed')
          && this.app.contains(this.notesPanel) && button.closest('.presenter-notes') === this.notesPanel) return false;
      if (typeof button.getClientRects === 'function' && !button.getClientRects().length) return false;
      const owner = button.ownerDocument && button.ownerDocument.defaultView;
      if (owner && typeof owner.getComputedStyle === 'function') {
        try {
          const style = owner.getComputedStyle(button);
          if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
        } catch (_error) { return false; }
      }
      return true;
    }

    dispatchShortcut(event, context) {
      if (!SHORTCUTS || !this.app) return false;
      const key = SHORTCUTS.fromEvent(event);
      if (!key) return false;
      const command = SHORTCUT_COMMANDS.find(item => this.shortcutBindings[item.id] === key);
      if (!command) return false;
      const target = event.target;
      const typing = target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable);
      if (typing && (SHORTCUTS.isEditingKey(key) || !(event.ctrlKey || event.metaKey || event.altKey)
          || !['save', 'text-done'].includes(command.id))) return false;
      const button = this.shortcutButtons(command).find(item => this.isShortcutButtonVisible(item)
        && (!context || context.contains(item) || (context === this.settingsOptions && command.id === 'settings')
          || (context === this.textEditor && command.id === 'save')));
      if (!button && !context) return false;
      event.preventDefault();
      event.stopPropagation();
      if (!button || button.disabled || (event.repeat && !['step-prev', 'step-next', 'window-prev', 'window-next', 'undo', 'redo'].includes(command.id))) return true;
      this.noteActivity();
      button.click();
      return true;
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
      this.finishGesture(false);
      this.document = Object.assign({}, rawDocument);
      this.source = source;
      this.renderSource = prepareRenderSource(source);
      this.rowKeys = collectSignalKeys(this.renderSource.signal, [], new Map());
      this.rowKeyIndices = new Map(this.rowKeys.map(function (key, index) { return [key, index]; }));
      const bigApi = root.VisualWaveDromBigData;
      this.metrics = bigApi && typeof bigApi.measureSource === 'function'
        ? bigApi.measureSource(this.renderSource)
        : { maxWaveLength: 0, signalCount: 0 };
      this.sourceDescription = sourceDescription(source);
      this.titleEl.textContent = sourceTitle(source, rawDocument.name);
      document.title = this.titleEl.textContent + ' - 演讲者模式';
      if (this.notesWindow) this.notesWindow.refresh();
      // The source description seeds the first step; recorded notes are independent.
      if (!this.steps.length && !this.notesDirty) {
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
      if (opts.initial && rawDocument.presentation) {
        this.savedPresentation = rawDocument.presentation;
        try {
          const stored = parsePresentation(rawDocument.presentation);
          this.steps = stored.steps;
          this.stepIndex = -1;
          this.steps.forEach((step) => step.annotations.marks.forEach((mark) => {
            const match = /^mark-(\d+)$/.exec(mark.id);
            if (match) this.markSequence = Math.max(this.markSequence, Number(match[1]));
          }));
          await this.goToStep(Math.trunc(clamp(stored.activeStep, 0, this.steps.length - 1)));
          this.savedSignature = this.presentationSignature();
        } catch (error) {
          this.showToast('已保存的演讲步骤无法恢复：' + error.message, true);
          this.log('presenter-save', { phase: 'restore-error', message: error.message });
        }
      }
      this.updateStepControls();
      this.updateSaveControls();
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
      }
      const focus = this.annotations.focus;
      if (focus) {
        [focus.start, focus.end].forEach((anchor) => {
          if (!anchor) return;
          if (totalColumns > 0) anchor.cycle = clamp(anchor.cycle, 0, totalColumns);
          if (signalCount > 0) anchor.rowIndex = this.resolveAnchorRow(anchor);
        });
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
        this.updateCopyControls();
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
      this.laneBounds = lanes.map(getElementBounds);
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
      if (this.textEdit) this.positionTextEditor();
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
      if (this.annotations.marks.some((mark) => isShapeKind(mark.kind))) this.scheduleAnnotationDraw();
      if (centerContent) {
        this.viewport.scrollLeft = Math.max(0, (this.stageContent.scrollWidth - this.viewport.clientWidth) / 2);
        this.viewport.scrollTop = Math.max(0, (this.stageContent.scrollHeight - this.viewport.clientHeight) / 2);
      }
      this.updateFrozenLabels();
      if (this.textEdit) this.positionTextEditor();
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
      if (this.handleShapeWheel(event)) return;
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
      this.finishTextEdit(true);
      this.finishGesture(false);
      const hadSelectedMark = !!this.selectedMarkId;
      this.selectedMarkId = null;
      this.markPick = null;
      this.lastHistoryEdit = null;
      this.closeShapeOptions();
      if (next === 'focus') {
        if (this.focusEnabled && !force) {
          this.clearFocus();
        } else {
          this.focusEnabled = true;
          this.tool = 'focus';
          this.focusOptions.hidden = false;
          this.positionFocusOptions();
        }
      } else {
        this.tool = !force && this.tool === next ? '' : next;
        this.closeFocusOptions();
      }
      if (this.tool !== 'pointer') {
        this.hideLaser();
        this.clearPointerStroke();
      }
      this.updateToolState();
      if (hadSelectedMark) this.drawAnnotations();
      if (isShapeKind(this.tool) || this.tool === 'pen') this.openShapeOptions();
      this.viewport.focus({ preventScroll: true });
    }

    selectCursor(cursor, force) {
      const next = cursor === 'B' ? 'B' : 'A';
      const active = this.tool === 'cursor' && this.activeCursor === next;
      this.activeCursor = next;
      this.setTool(!force && active ? '' : 'cursor', true);
    }

    updateToolState() {
      this.app.querySelectorAll('[data-tool]').forEach((button) => {
        const active = button.dataset.tool === 'focus' ? this.focusEnabled : button.dataset.tool === this.tool;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
        if (button.dataset.tool === 'focus') button.setAttribute('aria-expanded', this.focusOptions.hidden ? 'false' : 'true');
      });
      this.app.querySelectorAll('button[data-cursor]').forEach((button) => {
        const active = this.tool === 'cursor' && button.dataset.cursor === this.activeCursor;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      this.focusOptions.querySelectorAll('input').forEach((input) => { input.checked = input.value === this.focusMode; });
      this.overlay.classList.remove('tool-pointer', 'tool-focus', 'tool-pen', 'tool-eraser', 'tool-text', 'tool-cursor', 'tool-arrow', 'tool-rectangle');
      if (this.tool) this.overlay.classList.add('tool-' + this.tool);
      this.viewport.classList.toggle('can-pan', !this.tool);
      this.updateCopyControls();
      this.updateShapeControls();
      this.updateHistoryControls();
    }

    recordAnnotationChange(before, reason, mergeKey) {
      if (JSON.stringify(before) === JSON.stringify(this.annotations)) return false;
      const now = Date.now();
      const merge = mergeKey && this.lastHistoryEdit && this.lastHistoryEdit.key === mergeKey
        && now - this.lastHistoryEdit.time < 350 && !this.redoStack.length;
      if (!merge) this.undoStack.push(before);
      this.lastHistoryEdit = mergeKey ? { key: mergeKey, time: now } : null;
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
      this.redoStack.length = 0;
      this.updateHistoryControls();
      this.updateSaveControls();
      this.log('presenter-annotation', { phase: reason, undoCount: this.undoStack.length, markCount: this.annotations.marks.length });
      return true;
    }

    updateHistoryControls() {
      if (!this.app) return;
      this.app.querySelector('[data-action="undo"]').disabled = !this.undoStack.length;
      this.app.querySelector('[data-action="redo"]').disabled = !this.redoStack.length;
    }

    restoreHistory(redo) {
      this.finishGesture(false);
      this.lastHistoryEdit = null;
      this.markPick = null;
      const from = redo ? this.redoStack : this.undoStack;
      const to = redo ? this.undoStack : this.redoStack;
      if (!from.length) return;
      to.push(cloneValue(this.annotations));
      this.annotations = from.pop();
      const selectedShape = this.selectedShape();
      if (selectedShape) this.shapeStyles[selectedShape.kind] = this.shapeStyle(selectedShape);
      this.keepAnnotationsInSourceBounds(this.metrics.maxWaveLength, this.metrics.signalCount);
      this.focusEnabled = !!this.annotations.focus;
      if (this.annotations.focus) this.focusMode = this.annotations.focus.mode;
      else if (this.tool === 'focus') this.tool = '';
      this.closeFocusOptions();
      this.drawAnnotations();
      this.updateToolState();
      this.updateSaveControls();
      this.viewport.focus({ preventScroll: true });
    }

    clearFocus() {
      const before = cloneValue(this.annotations);
      this.annotations.focus = null;
      this.focusEnabled = false;
      if (this.tool === 'focus') this.tool = '';
      this.closeFocusOptions();
      this.recordAnnotationChange(before, 'focus-clear');
      this.drawAnnotations();
      this.updateToolState();
    }

    setFocusMode(mode) {
      if (!['rows', 'columns', 'rectangle'].includes(mode)) return;
      const before = cloneValue(this.annotations);
      if (mode !== this.focusMode) this.annotations.focus = null;
      this.focusMode = mode;
      this.focusEnabled = true;
      this.tool = 'focus';
      this.selectedMarkId = null;
      this.markPick = null;
      this.closeShapeOptions();
      this.hideLaser();
      this.clearPointerStroke();
      this.recordAnnotationChange(before, 'focus-mode');
      this.drawAnnotations();
      this.updateToolState();
    }

    closeFocusOptions() {
      if (!this.focusOptions) return;
      this.focusOptions.hidden = true;
      this.app.querySelector('[data-tool="focus"]').setAttribute('aria-expanded', 'false');
    }

    positionPopover(element, x, y, above) {
      const width = document.documentElement.clientWidth;
      const height = document.documentElement.clientHeight;
      const box = element.getBoundingClientRect();
      element.style.left = clamp(x, 8, Math.max(8, width - box.width - 8)) + 'px';
      element.style.top = clamp(above ? y - box.height - 8 : y + 10,
        8, Math.max(8, height - box.height - 8)) + 'px';
    }

    positionFocusOptions() {
      const button = this.app.querySelector('[data-tool="focus"]').getBoundingClientRect();
      this.positionPopover(this.focusOptions, button.left, button.top, true);
    }

    handleOutsidePointerDown(event) {
      if (this.settingsOptions && !this.settingsOptions.hidden && !this.settingsOptions.contains(event.target)
          && !event.target.closest('[data-action="settings"]')) this.closeSettings(false);
      if (this.textEdit && !this.textEditor.contains(event.target)) this.finishTextEdit(true, false);
      if (!this.focusOptions.hidden && !this.focusOptions.contains(event.target)
          && !event.target.closest('[data-tool="focus"]')) this.closeFocusOptions();
      if (this.shapeOptions && !this.shapeOptions.hidden && !this.shapeOptions.contains(event.target)
          && !event.target.closest('[data-action="shape-style"], [data-tool="arrow"], [data-tool="rectangle"]')) this.closeShapeOptions();
      if (this.copyOptions && !this.copyOptions.hidden && !this.copying && !this.copyOptions.contains(event.target)
          && !event.target.closest('[data-action="copy-image"]')) this.closeCopyOptions();
    }

    updateCopyControls() {
      if (!this.copyOptions) return;
      const ready = !!this.svg && !this.copying;
      this.copyButton.disabled = !ready;
      this.copyOptions.setAttribute('aria-busy', String(this.copying));
      this.copyOptions.querySelector('[data-action="copy-full"]').disabled = !ready;
      const focusButton = this.copyOptions.querySelector('[data-action="copy-focus"]');
      const hasFocus = ready && !!this.getFocusBounds();
      focusButton.disabled = !hasFocus;
      focusButton.dataset.shortcutTitle = hasFocus ? '复制聚焦区域、波形名和批注' : '请先选择聚焦区域';
      focusButton.title = focusButton.dataset.shortcutTitle;
      this.copyOptions.querySelector('[data-action="copy-close"]').disabled = this.copying;
      this.refreshShortcutUI();
    }

    openCopyOptions() {
      this.updateCopyControls();
      this.copyStatus.hidden = true;
      this.copyOptions.hidden = false;
      this.copyButton.setAttribute('aria-expanded', 'true');
      this.positionCopyOptions();
    }

    closeCopyOptions() {
      if (!this.copyOptions) return;
      this.copyOptions.hidden = true;
      this.copyButton.setAttribute('aria-expanded', 'false');
    }

    positionCopyOptions() {
      const button = this.copyButton.getBoundingClientRect();
      this.positionPopover(this.copyOptions, button.left, button.bottom, false);
    }

    createScreenshot(request) {
      if (this.destroyed) throw new Error('capture-cancelled');
      const fullRender = request.mode === 'full' && request.total > request.window.size;
      if (fullRender && (request.total > 2000 || request.total * Math.max(1, request.rowKeys.length) > 50000)) {
        throw new Error('image-too-large');
      }
      const prefix = 'presenter-capture-' + (++this.copySequence) + '-';
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:-100000px;top:0;opacity:0;pointer-events:none';
      document.body.appendChild(host);
      try {
        let svg = request.svg;
        if (fullRender) {
          const display = document.createElement('div');
          display.id = prefix + '0';
          host.appendChild(display);
          root.WaveDrom.RenderWaveForm(0, cloneValue(request.source), prefix, false);
          svg = display.querySelector('svg');
          if (!svg) throw new Error('missing-waveform');
        } else {
          host.appendChild(svg);
        }
        const snapshot = new PresenterView({});
        snapshot.svg = svg;
        snapshot.svgMetrics = getSvgMetrics(svg);
        snapshot.renderWindow = fullRender ? { start: 0, end: request.total, size: request.total } : request.window;
        snapshot.rowKeys = request.rowKeys;
        snapshot.rowKeyIndices = new Map(request.rowKeys.map((key, index) => [key, index]));
        snapshot.annotations = request.annotations;
        snapshot.markClipId = prefix + 'marks';
        snapshot.buildFrozenLabels = function () {};
        snapshot.updateMeasurements = function () {};
        snapshot.collectGeometry();
        snapshot.overlay = createSvgElement('svg', {
          class: 'presenter-overlay', width: snapshot.svgMetrics.width, height: snapshot.svgMetrics.height,
          viewBox: [snapshot.svgMetrics.x, snapshot.svgMetrics.y, snapshot.svgMetrics.width, snapshot.svgMetrics.height].join(' ')
        });
        host.appendChild(snapshot.overlay);
        snapshot.drawAnnotations();
        const focus = snapshot.annotations.focus;
        let focusRows = [];
        if (focus) {
          const first = focus.mode === 'columns' ? 0 : Math.min(snapshot.resolveAnchorRow(focus.start), snapshot.resolveAnchorRow(focus.end));
          const last = focus.mode === 'columns' ? request.rowKeys.length - 1 : Math.max(snapshot.resolveAnchorRow(focus.start), snapshot.resolveAnchorRow(focus.end));
          for (let row = first; row <= last; row++) focusRows.push(row);
        }
        return root.VisualWaveDromPresenterExport.compose({
          svg: svg, overlay: snapshot.overlay, metrics: snapshot.svgMetrics, plot: snapshot.plotBounds,
          names: getLaneGroups(svg).map((lane) => getElementBounds(lane.querySelector('text.info'))),
          focus: snapshot.getFocusBounds(), focusRows: focusRows
        }, request.mode);
      } finally {
        host.remove();
      }
    }

    async copyScreenshot(mode) {
      if (this.copying || !this.svg) return false;
      const api = root.VisualWaveDromPresenterExport;
      if (!api || typeof this.adapter.renderScreenshot !== 'function') {
        this.showToast('图片复制模块未加载，请刷新页面后重试。', true);
        return false;
      }
      if (mode === 'focus' && !this.getFocusBounds()) {
        this.showToast('请先选择聚焦区域。', true);
        return false;
      }
      this.finishGesture(false);
      this.finishTextEdit(true);
      const request = {
        mode: mode, svg: this.svg.cloneNode(true), source: this.renderSource,
        total: this.metrics.maxWaveLength,
        window: { start: this.renderWindow.start, end: this.renderWindow.end, size: this.renderWindow.size },
        rowKeys: this.rowKeys.slice(), annotations: cloneValue(this.annotations)
      };
      const filename = (this.titleEl.textContent.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 96) || 'VisualWaveDrom') + '.png';
      this.copying = true;
      this.copyStatus.hidden = false;
      this.copyStatus.textContent = '正在生成图片...';
      this.updateCopyControls();
      this.log('presenter-copy', { phase: 'start', mode: mode });
      const rendering = new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
        .then(() => this.createScreenshot(request))
        .then((result) => this.adapter.renderScreenshot(result.svg, result.metrics));
      try {
        const result = await api.writeImage(rendering, this.adapter.downloadImage, filename);
        if (!this.destroyed) {
          this.closeCopyOptions();
          this.showToast(result.copied ? '图片已复制到剪贴板。' : '图片剪贴板不可用，已下载 PNG。');
          this.log('presenter-copy', {
            phase: result.copied ? 'copied' : 'downloaded', mode: mode, reason: result.reason,
            width: result.image.width, height: result.image.height
          });
        }
        return true;
      } catch (error) {
        const messages = {
          'image-too-large': '整张图片过大，请缩小聚焦范围后选择“仅聚焦区域”。',
          'missing-focus': '请先选择聚焦区域。',
          'focus-outside-waveform': '聚焦区域未包含波形，请重新选择。',
          'missing-waveform': '当前波形未成功渲染，无法复制图片。',
          'clipboard-unavailable': '浏览器无法复制图片，请检查剪贴板权限。',
          'capture-cancelled': '已取消图片生成。'
        };
        if (!this.destroyed) {
          this.copyStatus.textContent = messages[error.message] || ('图片生成失败：' + error.message);
          this.log('presenter-copy', { phase: 'error', mode: mode, message: error.message });
        }
        return false;
      } finally {
        this.copying = false;
        if (!this.destroyed) this.updateCopyControls();
      }
    }

    selectedMark() {
      return this.annotations.marks.find((mark) => mark.id === this.selectedMarkId);
    }

    selectedShape() {
      const mark = this.selectedMark();
      return mark && isShapeKind(mark.kind) ? mark : null;
    }

    shapeContext() {
      return this.selectedShape() || (isShapeKind(this.tool) ? { kind: this.tool, ...this.shapeStyles[this.tool] }
        : this.tool === 'pen' || this.tool === 'pointer' ? { kind: this.tool, color: this.penColor } : null);
    }

    shapeStyle(shape) {
      const width = Number(shape.width);
      return {
        color: SHAPE_COLORS.some((color) => color[0] === shape.color) ? shape.color : SHAPE_COLORS[0][0],
        width: clamp(Number.isFinite(width) ? Math.round(width) : 3, 1, 16)
      };
    }

    updateShapeControls() {
      if (!this.shapeOptions) return;
      if (!this.selectedMark()) this.selectedMarkId = null;
      const context = this.shapeContext();
      this.shapeStyleButton.disabled = !context;
      if (!context) {
        this.closeShapeOptions();
        return;
      }
      const style = this.shapeStyle(context);
      const colorOnly = !isShapeKind(context.kind);
      const title = colorOnly ? (context.kind === 'pointer' ? '指示画线颜色' : '画笔颜色') : '图形颜色和线宽';
      this.shapeStyleButton.dataset.shortcutTitle = title;
      this.shapeStyleButton.title = title;
      this.shapeStyleButton.setAttribute('aria-label', title);
      this.shapeStyleButton.querySelector('.presenter-style-swatch').style.backgroundColor = style.color;
      this.app.querySelector('#presenter-shape-width-value').textContent = colorOnly ? '颜色' : style.width + ' px';
      this.shapeWidthRow.hidden = colorOnly;
      this.shapeWidthInput.disabled = colorOnly;
      this.shapeWidthInput.value = String(style.width);
      this.app.querySelector('#presenter-shape-width-output').textContent = style.width + ' px';
      this.app.querySelector('#presenter-shape-options-title').textContent = colorOnly ? title
        : (context.kind === 'arrow' ? '箭头' : '矩形') + '样式';
      this.shapeOptions.querySelectorAll('[data-shape-color]').forEach((swatch) => {
        swatch.setAttribute('aria-pressed', String(swatch.dataset.shapeColor === style.color));
      });
      this.refreshShortcutUI();
    }

    openShapeOptions() {
      if (!this.shapeOptions || !this.shapeContext()) return;
      this.updateShapeControls();
      this.shapeOptions.hidden = false;
      this.shapeStyleButton.setAttribute('aria-expanded', 'true');
      this.positionShapeOptions();
    }

    closeShapeOptions() {
      if (!this.shapeOptions) return;
      this.shapeOptions.hidden = true;
      this.shapeStyleButton.setAttribute('aria-expanded', 'false');
    }

    positionShapeOptions() {
      const button = this.shapeStyleButton.getBoundingClientRect();
      this.positionPopover(this.shapeOptions, button.left, button.top, true);
    }

    applyShapeStyle(patch, continuous) {
      const context = this.shapeContext();
      if (!context) return;
      const style = this.shapeStyle(Object.assign({}, context, patch));
      if (isShapeKind(context.kind)) this.shapeStyles[context.kind] = style;
      else this.penColor = style.color;
      const mark = this.selectedShape();
      if (mark && (mark.color !== style.color || mark.width !== style.width)) {
        const before = this.drag ? null : cloneValue(this.annotations);
        Object.assign(mark, style);
        if (before) this.recordAnnotationChange(before, 'shape-style', continuous ? 'shape-width:' + mark.id : null);
        this.scheduleAnnotationDraw();
      }
      this.updateShapeControls();
    }

    handleShapeWheel(event) {
      const context = this.shapeContext();
      if (!context || !isShapeKind(context.kind) || !event.deltaY || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
      event.preventDefault();
      event.stopPropagation();
      this.noteActivity();
      this.applyShapeStyle({ width: this.shapeStyle(context).width - Math.sign(event.deltaY) }, true);
      return true;
    }

    selectShape(id) {
      this.selectMark(id);
      if (this.selectedShape()) this.openShapeOptions();
    }

    selectMark(id) {
      this.selectedMarkId = id || null;
      this.markPick = null;
      const mark = this.selectedMark();
      if (!mark) this.selectedMarkId = null;
      else if (isShapeKind(mark.kind)) this.shapeStyles[mark.kind] = this.shapeStyle(mark);
      this.tool = '';
      this.lastHistoryEdit = null;
      this.closeFocusOptions();
      this.closeShapeOptions();
      this.updateToolState();
      this.drawAnnotations();
    }

    markBounds(mark) {
      const geometry = mark && this.markGeometry.get(mark.id);
      if (!geometry) return null;
      if (geometry.bounds) return geometry.bounds;
      const points = geometry.points;
      if (!points || !points.length) return null;
      let left = Infinity;
      let right = -Infinity;
      let top = Infinity;
      let bottom = -Infinity;
      points.forEach((point) => {
        left = Math.min(left, point.x);
        right = Math.max(right, point.x);
        top = Math.min(top, point.y);
        bottom = Math.max(bottom, point.y);
      });
      return { x: left, y: top, width: right - left, height: bottom - top };
    }

    pickMark(point) {
      const view = this.svgMetrics;
      const inside = point.x >= view.x && point.x <= view.x + view.width
        && point.y >= view.y && point.y <= view.y + view.height;
      const hits = inside ? this.annotations.marks.filter((mark) => {
        const geometry = this.markGeometry.get(mark.id);
        if (!geometry) return false;
        const radius = 6 / this.scale + (geometry.strokeWidth || 0) / 2;
        if (geometry.points) return geometry.points.some((end, index, points) =>
          segmentsNear(point, point, points[Math.max(0, index - 1)], end, radius));
        const box = geometry.bounds;
        return box && point.x >= box.x - radius && point.x <= box.x + box.width + radius
          && point.y >= box.y - radius && point.y <= box.y + box.height + radius;
      }).map((mark) => mark.id).reverse() : [];
      const last = this.markPick;
      const same = last && last.id === this.selectedMarkId
        && Math.hypot(last.point.x - point.x, last.point.y - point.y) * this.scale <= 5
        && hits.length === last.hits.length && hits.every((id, index) => id === last.hits[index]);
      const index = same && hits.length ? (hits.indexOf(this.selectedMarkId) + 1) % hits.length : 0;
      this.selectMark(hits[index]);
      this.markPick = hits.length ? { point: point, hits: hits, id: this.selectedMarkId } : null;
    }

    startMarkMove(event, point) {
      const mark = this.selectedMark();
      if (!mark || this.tool) return;
      this.markPick = null;
      this.lastHistoryEdit = null;
      this.closeShapeOptions();
      const anchors = mark.kind === 'pen' ? mark.points : isShapeKind(mark.kind) ? [mark.start, mark.end] : [mark.anchor];
      this.drag = {
        kind: 'move', pointerId: event.pointerId, before: cloneValue(this.annotations),
        mark: mark, startPoint: point, points: anchors.map((anchor) => this.pointFromAnchor(anchor)),
        previousSelectedMarkId: mark.id
      };
      this.syncBeforeUnload(true);
      try { this.overlay.setPointerCapture(event.pointerId); } catch (_error) { /* pointer already ended */ }
      this.drawAnnotations();
    }

    handleViewportPointerDown(event) {
      if (event.defaultPrevented || event.button !== 0 || event.isPrimary === false || this.tool || this.drag || !this.svg) return;
      const target = event.target;
      if (target && typeof target.closest === 'function'
          && target.closest('input, textarea, select, button, a, [contenteditable], [role="dialog"], .presenter-text-editor')) return;
      if (target === this.viewport) {
        const rect = this.viewport.getBoundingClientRect();
        if (event.clientX >= rect.left + this.viewport.clientLeft + this.viewport.clientWidth
            || event.clientY >= rect.top + this.viewport.clientTop + this.viewport.clientHeight) return;
      }
      this.startCanvasPan(event, null);
    }

    startCanvasPan(event, point) {
      event.preventDefault();
      this.viewport.focus({ preventScroll: true });
      this.drag = {
        kind: 'pan', pointerId: event.pointerId, point: point,
        startX: event.clientX, startY: event.clientY,
        left: this.viewport.scrollLeft, top: this.viewport.scrollTop, moved: false
      };
      try { this.viewport.setPointerCapture(event.pointerId); } catch (_error) { /* pointer already ended */ }
    }

    moveCanvasPan(event) {
      const drag = this.drag;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      this.markPick = null;
      this.viewport.classList.add('is-panning');
      // Screen deltas stay stable while scrolling changes the SVG coordinate transform.
      this.viewport.scrollLeft = clamp(drag.left - dx, 0, Math.max(0, this.viewport.scrollWidth - this.viewport.clientWidth));
      this.viewport.scrollTop = clamp(drag.top - dy, 0, Math.max(0, this.viewport.scrollHeight - this.viewport.clientHeight));
    }

    moveMark(point) {
      const drag = this.drag;
      const dx = point.x - drag.startPoint.x;
      const dy = point.y - drag.startPoint.y;
      if (!drag.moved && Math.hypot(dx, dy) * this.scale < 2) return;
      drag.moved = true;
      // Always translate the original points, including across differently sized signal rows.
      const anchors = drag.points.map((original) => this.anchorFromPoint({ x: original.x + dx, y: original.y + dy }));
      if (drag.mark.kind === 'pen') drag.mark.points = anchors;
      else if (isShapeKind(drag.mark.kind)) [drag.mark.start, drag.mark.end] = anchors;
      else drag.mark.anchor = anchors[0];
    }

    deleteSelectedMark() {
      if (this.tool || !this.selectedMark()) return;
      this.finishGesture(false);
      const before = cloneValue(this.annotations);
      this.annotations.marks = this.annotations.marks.filter((mark) => mark.id !== this.selectedMarkId);
      this.selectMark(null);
      this.recordAnnotationChange(before, 'mark-delete');
    }

    resolveAnchorRow(anchor) {
      const byKey = this.rowKeyIndices.get(anchor.rowKey);
      return Number.isFinite(byKey) ? byKey : clamp(anchor.rowIndex, 0, Math.max(0, this.rowKeys.length - 1));
    }

    anchorFromPoint(point) {
      const rowIndex = this.laneIndexFromY(point.y);
      const lane = this.laneBounds[rowIndex];
      return {
        cycle: this.renderWindow.start + (point.x - this.plotBounds.x)
          / Math.max(1, this.plotBounds.width) * Math.max(1, this.renderWindow.size),
        rowIndex: rowIndex,
        rowKey: this.rowKeys[rowIndex] || '',
        offsetY: point.y - (lane ? lane.y + lane.height / 2 : this.svgMetrics.y)
      };
    }

    pointFromAnchor(anchor) {
      const lane = this.laneBounds[this.resolveAnchorRow(anchor)];
      return {
        x: this.plotBounds.x + (anchor.cycle - this.renderWindow.start)
          / Math.max(1, this.renderWindow.size) * this.plotBounds.width,
        y: (lane ? lane.y + lane.height / 2 : this.svgMetrics.y) + anchor.offsetY
      };
    }

    openTextEditor(point, id) {
      this.finishTextEdit(true, false);
      const mark = this.annotations.marks.find(function (item) { return item.id === id && item.kind === 'text'; });
      this.textEdit = { id: mark ? mark.id : null, anchor: mark ? cloneValue(mark.anchor) : this.anchorFromPoint(point) };
      this.textInput.value = mark ? mark.text : '';
      this.textEditor.hidden = false;
      this.resizeTextEditor();
      this.drawAnnotations();
      this.textInput.focus({ preventScroll: true });
      this.textInput.select();
    }

    resizeTextEditor() {
      if (!this.textEdit) return;
      // The mirror sizes the native textarea without rewriting its value or selection.
      this.textMeasure.textContent = this.textInput.value + '\u200b';
      this.positionTextEditor();
    }

    positionTextEditor() {
      if (!this.textEdit || !this.svgMetrics) return;
      const point = this.pointFromAnchor(this.textEdit.anchor);
      const widthRemaining = Math.max(1, this.svgMetrics.x + this.svgMetrics.width - point.x);
      const heightRemaining = Math.max(1, this.svgMetrics.y + this.svgMetrics.height - point.y);
      this.textField.style.left = (point.x - this.svgMetrics.x) + 'px';
      this.textField.style.top = (point.y - this.svgMetrics.y) + 'px';
      this.textField.style.minWidth = Math.min(56, widthRemaining) + 'px';
      this.textField.style.maxWidth = widthRemaining + 'px';
      this.textField.style.maxHeight = heightRemaining + 'px';
      const editor = this.textField.getBoundingClientRect();
      const origin = this.textEditor.getBoundingClientRect();
      const viewport = this.viewport.getBoundingClientRect();
      const width = this.textActions.offsetWidth;
      const height = this.textActions.offsetHeight;
      const left = clamp(editor.left, viewport.left + 8, viewport.left + this.viewport.clientWidth - width - 8);
      const preferredTop = editor.top - height - 8 >= viewport.top + 8
        ? editor.top - height - 8 : editor.bottom + 8;
      const top = clamp(preferredTop, viewport.top + 8, viewport.top + this.viewport.clientHeight - height - 8);
      // Text shares the image transform; its small action buttons remain screen-sized.
      this.textActions.style.transform = 'scale(' + (1 / this.scale) + ')';
      this.textActions.style.left = ((left - origin.left) / this.scale) + 'px';
      this.textActions.style.top = ((top - origin.top) / this.scale) + 'px';
    }

    getAnnotationTextMetrics() {
      if (this.annotationTextMetrics) return this.annotationTextMetrics;
      const ruler = document.createElement('span');
      ruler.className = 'presenter-text-ruler';
      ruler.textContent = 'M';
      const baseline = document.createElement('span');
      ruler.appendChild(baseline);
      document.body.appendChild(ruler);
      const bounds = ruler.getBoundingClientRect();
      this.annotationTextMetrics = {
        baseline: baseline.getBoundingClientRect().top - bounds.top,
        lineHeight: bounds.height
      };
      ruler.remove();
      return this.annotationTextMetrics;
    }

    finishTextEdit(commit, focus) {
      if (!this.textEdit) return;
      const edit = this.textEdit;
      this.textEdit = null;
      this.textEditor.hidden = true;
      if (commit) {
        const before = cloneValue(this.annotations);
        const value = this.textInput.value;
        const index = this.annotations.marks.findIndex(function (mark) { return mark.id === edit.id; });
        if (value.trim()) {
          const mark = { id: edit.id || 'mark-' + (++this.markSequence), kind: 'text', anchor: edit.anchor, text: value };
          if (index >= 0) this.annotations.marks[index] = mark;
          else this.annotations.marks.push(mark);
        } else if (index >= 0) {
          this.annotations.marks.splice(index, 1);
        }
        this.recordAnnotationChange(before, 'text');
      }
      this.drawAnnotations();
      if (focus !== false) this.viewport.focus({ preventScroll: true });
      this.updateSaveControls();
    }

    moveLaser(event) {
      if (this.tool !== 'pointer') return;
      this.laserPosition = { x: event.clientX, y: event.clientY };
      if (this.laserFrame) return;
      this.laserFrame = requestAnimationFrame(() => {
        this.laserFrame = 0;
        if (this.tool !== 'pointer' || !this.laserPosition || this.destroyed) return;
        this.laser.style.transform = 'translate3d(' + (this.laserPosition.x - 11) + 'px,'
          + (this.laserPosition.y - 11) + 'px,0)';
        this.laser.hidden = false;
      });
    }

    hideLaser() {
      cancelAnimationFrame(this.laserFrame);
      this.laserFrame = 0;
      this.laserPosition = null;
      if (this.laser) this.laser.hidden = true;
    }

    pulseLaser(event) {
      this.moveLaser(event);
      const pulse = document.createElement('span');
      pulse.className = 'presenter-pointer-pulse';
      pulse.setAttribute('aria-hidden', 'true');
      pulse.style.left = event.clientX + 'px';
      pulse.style.top = event.clientY + 'px';
      pulse.addEventListener('animationend', () => pulse.remove(), { once: true });
      const previous = this.app.querySelectorAll('.presenter-pointer-pulse');
      if (previous.length >= 5) previous[0].remove();
      this.app.appendChild(pulse);
    }

    clearPointerStroke() {
      cancelAnimationFrame(this.pointerStrokeFrame);
      this.pointerStrokeFrame = 0;
      this.pointerStroke = [];
      if (this.pointerInk) this.pointerInk.remove();
      this.pointerInk = null;
    }

    schedulePointerStrokeDraw() {
      if (this.pointerStrokeFrame) return;
      this.pointerStrokeFrame = requestAnimationFrame(() => {
        this.pointerStrokeFrame = 0;
        if (!this.destroyed) this.drawPointerStroke();
      });
    }

    drawPointerStroke() {
      cancelAnimationFrame(this.pointerStrokeFrame);
      this.pointerStrokeFrame = 0;
      if (this.pointerStroke.length < 2 || !this.overlay || !this.svgMetrics) return;
      if (!this.pointerInk || this.pointerInk.parentNode !== this.overlay) {
        this.pointerInk = createSvgElement('path', {
          class: 'presenter-pointer-ink', 'aria-hidden': 'true',
          stroke: this.pointerStrokeColor,
          'clip-path': 'url(#' + (this.markClipId || 'presenter-mark-clip') + ')'
        });
        this.overlay.appendChild(this.pointerInk);
      }
      const path = this.pointerStroke.map((anchor, index) => {
        const point = this.pointFromAnchor(anchor);
        return (index ? 'L' : 'M') + point.x.toFixed(2) + ' ' + point.y.toFixed(2);
      }).join(' ');
      this.pointerInk.setAttribute('d', path);
    }

    scheduleAnnotationDraw() {
      if (this.annotationFrame) return;
      this.annotationFrame = requestAnimationFrame(() => {
        this.annotationFrame = 0;
        if (!this.destroyed) this.drawAnnotations();
      });
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
        if (!bounds) return;
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
      if (event.button !== 0 || this.drag || !this.svg) return;
      if (event.isPrimary === false) return;
      const cursor = event.target.dataset && event.target.dataset.cursor;
      const target = typeof event.target.closest === 'function' ? event.target.closest('[data-mark-id]') : event.target;
      const shape = target && this.annotations.marks.find((mark) => mark.id === target.dataset.markId && isShapeKind(mark.kind));
      const point = this.clientPoint(event);
      if (!point) return;
      event.preventDefault();
      this.viewport.focus({ preventScroll: true });
      if (!this.tool && !cursor) {
        const handle = typeof event.target.closest === 'function' ? event.target.closest('[data-mark-move-id]') : null;
        if (handle && handle.dataset.markMoveId === this.selectedMarkId) this.startMarkMove(event, point);
        else this.startCanvasPan(event, point);
        return;
      }
      if (shape && (!this.tool || isShapeKind(this.tool))) {
        this.selectShape(shape.id);
        return;
      }
      const previousSelectedMarkId = this.selectedMarkId;
      this.selectedMarkId = null;
      this.markPick = null;
      this.lastHistoryEdit = null;
      if (this.tool === 'pointer') {
        this.clearPointerStroke();
        this.pointerStrokeColor = this.penColor;
        this.pointerStroke.push(this.anchorFromPoint(point));
        // Pointer ink is transient, so it must not snapshot or mutate annotations.
        this.drag = { kind: 'pointer', pointerId: event.pointerId, lastPoint: point };
        try { this.overlay.setPointerCapture(event.pointerId); } catch (_error) { /* pointer already ended */ }
        return;
      }
      if (this.tool === 'text') {
        const target = event.target.closest('[data-mark-id]');
        this.openTextEditor(point, target && target.dataset.markId);
        return;
      }
      if (!this.tool && cursor) {
        this.activeCursor = cursor;
        this.tool = 'cursor';
      }
      this.drag = {
        kind: this.tool, pointerId: event.pointerId, before: cloneValue(this.annotations),
        lastPoint: point, cursor: this.activeCursor, previousSelectedMarkId: previousSelectedMarkId
      };
      try { this.overlay.setPointerCapture(event.pointerId); } catch (_error) { /* pointer already ended */ }
      if (this.tool === 'cursor') {
        this.annotations[this.activeCursor === 'B' ? 'cursorB' : 'cursorA'] = this.cycleFromX(point.x);
      } else if (this.tool === 'focus') {
        const anchor = this.anchorFromPoint(point);
        if (this.focusMode === 'columns') anchor.cycle = this.cycleFromX(point.x);
        this.annotations.focus = { mode: this.focusMode, start: anchor, end: cloneValue(anchor) };
      } else if (this.tool === 'pen') {
        const anchor = this.anchorFromPoint(point);
        const mark = {
          id: 'mark-' + (++this.markSequence), kind: 'pen', color: this.penColor, points: [anchor, cloneValue(anchor)]
        };
        this.annotations.marks.push(mark);
        this.drag.mark = mark;
      } else if (isShapeKind(this.tool)) {
        const start = this.anchorFromPoint(point);
        const mark = Object.assign({
          id: 'mark-' + (++this.markSequence), kind: this.tool, start: start, end: cloneValue(start)
        }, this.shapeStyles[this.tool]);
        this.annotations.marks.push(mark);
        this.drag.mark = mark;
        this.selectedMarkId = mark.id;
      } else if (this.tool === 'eraser') {
        this.eraseMarks(point, point);
      }
      this.drawAnnotations();
      this.updateToolState();
    }

    handleOverlayPointerMove(event) {
      if (!this.drag || this.drag.pointerId !== event.pointerId) return;
      if (this.drag.kind === 'pan') {
        this.moveCanvasPan(event);
        return;
      }
      const point = this.clientPoint(event);
      if (!point) return;
      if (this.drag.kind === 'move') {
        this.moveMark(point);
      } else if (this.drag.kind === 'focus' && this.annotations.focus) {
        const anchor = this.anchorFromPoint(point);
        if (this.focusMode === 'columns') anchor.cycle = this.cycleFromX(point.x);
        this.annotations.focus.end = anchor;
      } else if (this.drag.kind === 'cursor') {
        this.annotations[this.drag.cursor === 'B' ? 'cursorB' : 'cursorA'] = this.cycleFromX(point.x);
      } else if (this.drag.kind === 'pen' || this.drag.kind === 'pointer') {
        const points = this.drag.kind === 'pointer' ? this.pointerStroke : this.drag.mark.points;
        const samples = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
        (samples.length ? samples : [event]).forEach((sample) => {
          const next = this.clientPoint(sample);
          if (next && Math.hypot(next.x - this.drag.lastPoint.x, next.y - this.drag.lastPoint.y) * this.scale >= 1) {
            points.push(this.anchorFromPoint(next));
            this.drag.lastPoint = next;
          }
        });
      } else if (isShapeKind(this.drag.kind)) {
        this.drag.mark.end = this.anchorFromPoint(point);
      } else if (this.drag.kind === 'eraser') {
        this.eraseMarks(this.drag.lastPoint, point);
        this.drag.lastPoint = point;
      }
      if (this.drag.kind === 'pointer') this.schedulePointerStrokeDraw();
      else this.scheduleAnnotationDraw();
    }

    handleOverlayPointerUp(event) {
      if (!this.drag || this.drag.pointerId !== event.pointerId) return;
      this.handleOverlayPointerMove(event);
      this.finishGesture(false, true);
    }

    finishGesture(cancel, completeClick) {
      if (!this.drag) return;
      const drag = this.drag;
      this.drag = null;
      const capture = drag.kind === 'pan' ? this.viewport : this.overlay;
      try { capture.releasePointerCapture(drag.pointerId); } catch (_error) { /* already released */ }
      if (drag.kind === 'pan') {
        this.viewport.classList.remove('is-panning');
        if (cancel && drag.moved) {
          this.viewport.scrollLeft = drag.left;
          this.viewport.scrollTop = drag.top;
        } else if (!cancel && completeClick && !drag.moved) {
          if (drag.point) this.pickMark(drag.point);
          else this.selectMark(null);
        }
        return;
      }
      if (drag.kind === 'pointer') {
        if (cancel) this.clearPointerStroke();
        else this.drawPointerStroke();
        return;
      }
      if (cancel) {
        this.annotations = drag.before;
        this.selectedMarkId = drag.previousSelectedMarkId || null;
      } else {
        if (isShapeKind(drag.kind)) {
          const start = this.pointFromAnchor(drag.mark.start);
          const end = this.pointFromAnchor(drag.mark.end);
          const width = Math.abs(end.x - start.x) * this.scale;
          const height = Math.abs(end.y - start.y) * this.scale;
          const empty = drag.kind === 'rectangle' ? width < 4 || height < 4 : Math.hypot(width, height) < 4;
          if (empty) {
            this.annotations.marks = this.annotations.marks.filter((mark) => mark.id !== drag.mark.id);
            this.selectedMarkId = drag.previousSelectedMarkId || null;
          }
        }
        const focus = this.annotations.focus;
        if (drag.kind === 'focus' && focus) {
          if (focus.mode === 'columns' && focus.start.cycle === focus.end.cycle) {
            focus.start.cycle = clamp(Math.floor(focus.start.cycle), 0, Math.max(0, this.renderWindow.end - 1));
            focus.end.cycle = Math.min(this.renderWindow.end, focus.start.cycle + 1);
          } else if (focus.mode === 'rectangle') {
            const start = this.pointFromAnchor(focus.start);
            const end = this.pointFromAnchor(focus.end);
            if (Math.abs(start.x - end.x) * this.scale < 3 || Math.abs(start.y - end.y) * this.scale < 3) {
              this.annotations.focus = drag.before.focus;
            }
          }
        }
        this.recordAnnotationChange(drag.before, drag.kind);
      }
      this.drawAnnotations();
      this.updateShapeControls();
      this.updateSaveControls();
    }

    eraseMarks(start, end) {
      const radius = 10 / this.scale;
      this.annotations.marks = this.annotations.marks.filter((mark) => {
        const geometry = this.markGeometry.get(mark.id);
        if (!geometry) return true;
        if (geometry.points) {
          const strokeRadius = radius + (geometry.strokeWidth || 0) / 2;
          return !geometry.points.some(function (point, index, points) {
            return segmentsNear(start, end, point, points[Math.max(0, index - 1)], strokeRadius);
          });
        }
        const box = geometry.bounds;
        const inside = start.x >= box.x - radius && start.x <= box.x + box.width + radius
          && start.y >= box.y - radius && start.y <= box.y + box.height + radius;
        if (inside) return false;
        const corners = [
          { x: box.x, y: box.y }, { x: box.x + box.width, y: box.y },
          { x: box.x + box.width, y: box.y + box.height }, { x: box.x, y: box.y + box.height }
        ];
        return !corners.some(function (point, index) {
          return segmentsNear(start, end, point, corners[(index + 1) % 4], radius);
        });
      });
    }

    getFocusBounds() {
      const focus = this.annotations.focus;
      if (!focus) return null;
      const view = this.svgMetrics;
      const start = this.pointFromAnchor(focus.start);
      const end = this.pointFromAnchor(focus.end);
      let left = Math.min(start.x, end.x);
      let right = Math.max(start.x, end.x);
      let top = Math.min(start.y, end.y);
      let bottom = Math.max(start.y, end.y);
      if (focus.mode === 'rows') {
        const first = this.resolveAnchorRow(focus.start);
        const last = this.resolveAnchorRow(focus.end);
        const bounds = unionBounds(this.laneBounds.slice(Math.min(first, last), Math.max(first, last) + 1), view);
        left = view.x;
        right = view.x + view.width;
        top = bounds.y - 3;
        bottom = bounds.y + bounds.height + 3;
      } else if (focus.mode === 'columns') {
        top = view.y;
        bottom = view.y + view.height;
      }
      left = Math.max(view.x, left);
      right = Math.min(view.x + view.width, right);
      top = Math.max(view.y, top);
      bottom = Math.min(view.y + view.height, bottom);
      return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
    }

    shapePoints(mark) {
      const start = this.pointFromAnchor(mark.start);
      const end = this.pointFromAnchor(mark.end);
      if (mark.kind === 'rectangle') {
        return [start, { x: end.x, y: start.y }, end, { x: start.x, y: end.y }, start];
      }
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const length = Math.hypot(dx, dy);
      const ux = dx / (length || 1);
      const uy = dy / (length || 1);
      const head = Math.min(length * 0.45, (8 + this.shapeStyle(mark).width * 2) / this.scale);
      const back = { x: end.x - ux * head, y: end.y - uy * head };
      return [start, end, { x: back.x - uy * head * 0.55, y: back.y + ux * head * 0.55 },
        end, { x: back.x + uy * head * 0.55, y: back.y - ux * head * 0.55 }];
    }

    drawShape(layer, mark) {
      const points = this.shapePoints(mark);
      const style = this.shapeStyle(mark);
      const path = points.map((point, index) => (index ? 'L' : 'M') + point.x.toFixed(2) + ' ' + point.y.toFixed(2)).join(' ');
      layer.appendChild(createSvgElement('path', {
        class: 'presenter-shape-hit', d: path, 'stroke-width': Math.max(12, style.width + 8), 'data-mark-id': mark.id
      }));
      layer.appendChild(createSvgElement('path', {
        class: 'presenter-shape-ink', d: path, stroke: style.color, 'stroke-width': style.width, 'data-mark-id': mark.id
      }));
      this.markGeometry.set(mark.id, { points: points, strokeWidth: style.width / this.scale });
    }

    drawMarks() {
      this.markGeometry.clear();
      const defs = createSvgElement('defs');
      const markClipId = this.markClipId || 'presenter-mark-clip';
      const clip = createSvgElement('clipPath', { id: markClipId });
      clip.appendChild(createSvgElement('rect', this.svgMetrics));
      defs.appendChild(clip);
      this.overlay.appendChild(defs);
      const layer = createSvgElement('g', { 'clip-path': 'url(#' + markClipId + ')' });
      this.overlay.appendChild(layer);
      this.annotations.marks.forEach((mark) => {
        if (this.textEdit && mark.id === this.textEdit.id) return;
        if (mark.kind === 'pen') {
          const points = mark.points.map((anchor) => this.pointFromAnchor(anchor));
          const path = points.map(function (point, index) {
            return (index ? 'L' : 'M') + point.x.toFixed(2) + ' ' + point.y.toFixed(2);
          }).join(' ');
          layer.appendChild(createSvgElement('path', {
            class: 'presenter-annotation-ink', d: path, 'data-mark-id': mark.id, stroke: this.shapeStyle(mark).color
          }));
          this.markGeometry.set(mark.id, { points: points, strokeWidth: 2.5 / this.scale });
        } else if (isShapeKind(mark.kind)) {
          this.drawShape(layer, mark);
        } else if (mark.kind === 'text') {
          const point = this.pointFromAnchor(mark.anchor);
          const metrics = this.getAnnotationTextMetrics();
          const group = createSvgElement('g', { 'data-mark-id': mark.id });
          const label = createSvgElement('text', { class: 'presenter-annotation-text', x: point.x, y: point.y + metrics.baseline });
          mark.text.split(/\r?\n/).forEach(function (line, index) {
            const span = createSvgElement('tspan', { x: point.x, dy: index ? metrics.lineHeight : 0 });
            span.textContent = line || '\u00a0';
            label.appendChild(span);
          });
          group.appendChild(label);
          layer.appendChild(group);
          const bounds = label.getBBox();
          const background = createSvgElement('rect', {
            class: 'presenter-annotation-text-bg', x: bounds.x - 3, y: bounds.y - 2,
            width: bounds.width + 6, height: bounds.height + 4, rx: 2
          });
          group.insertBefore(background, label);
          this.markGeometry.set(mark.id, { bounds: { x: bounds.x - 3, y: bounds.y - 2, width: bounds.width + 6, height: bounds.height + 4 } });
        }
      });
    }

    drawMarkSelection() {
      const mark = this.selectedMark();
      const bounds = this.markBounds(mark);
      if (!bounds || (this.drag && this.drag.kind !== 'move' && this.drag.kind !== 'pan')) return;
      const view = this.svgMetrics;
      const padding = (4 + (isShapeKind(mark.kind) ? this.shapeStyle(mark).width / 2 : 1.25)) / this.scale;
      const left = Math.max(view.x, bounds.x - padding);
      const top = Math.max(view.y, bounds.y - padding);
      const right = Math.min(view.x + view.width, bounds.x + bounds.width + padding);
      const bottom = Math.min(view.y + view.height, bounds.y + bounds.height + padding);
      if (right <= left || bottom <= top) return;
      const layer = createSvgElement('g', { class: 'presenter-mark-controls' });
      layer.appendChild(createSvgElement('rect', {
        class: 'presenter-shape-selection', x: left, y: top, width: right - left, height: bottom - top
      }));
      this.overlay.appendChild(layer);
      if (this.tool) return;
      const size = 24 / this.scale;
      const x = clamp(right + 3 / this.scale, view.x, view.x + view.width - size);
      const y = clamp(bottom + 3 / this.scale, view.y, view.y + view.height - size);
      const handle = createSvgElement('g', {
        class: 'presenter-mark-move-handle' + (this.drag && this.drag.kind === 'move' ? ' dragging' : ''),
        'data-mark-move-id': mark.id, 'aria-label': '拖动批注', transform: 'translate(' + x + ' ' + y + ') scale(' + 1 / this.scale + ')'
      });
      const title = createSvgElement('title');
      title.textContent = '按住拖动批注';
      handle.appendChild(title);
      handle.appendChild(createSvgElement('rect', { x: 0, y: 0, width: 24, height: 24, rx: 4 }));
      const glyph = createSvgElement('g', { class: 'presenter-mark-move-icon', transform: 'translate(4 4) scale(0.6666667)' });
      glyph.innerHTML = ICONS.move;
      handle.appendChild(glyph);
      layer.appendChild(handle);
    }

    drawAnnotations() {
      cancelAnimationFrame(this.annotationFrame);
      this.annotationFrame = 0;
      if (!this.overlay || !this.svgMetrics) return;
      while (this.overlay.firstChild) this.overlay.removeChild(this.overlay.firstChild);
      this.drawMarks();
      const view = this.svgMetrics;
      if (this.annotations.focus) {
        const bounds = this.getFocusBounds();
        const shadeRects = bounds ? [
          { x: view.x, y: view.y, width: view.width, height: bounds.y - view.y },
          { x: view.x, y: bounds.y + bounds.height, width: view.width, height: view.y + view.height - bounds.y - bounds.height },
          { x: view.x, y: bounds.y, width: bounds.x - view.x, height: bounds.height },
          { x: bounds.x + bounds.width, y: bounds.y, width: view.x + view.width - bounds.x - bounds.width, height: bounds.height }
        ] : [view];
        shadeRects.filter(function (rect) { return rect.width > 0 && rect.height > 0; }).forEach((rect) => {
          this.overlay.appendChild(createSvgElement('rect', Object.assign({ class: 'presenter-focus-shade' }, rect)));
        });
        if (bounds) this.overlay.appendChild(createSvgElement('rect', Object.assign({ class: 'presenter-focus-outline' }, bounds)));
      }
      this.drawCursor('A', this.annotations.cursorA);
      this.drawCursor('B', this.annotations.cursorB);
      this.drawPointerStroke();
      this.drawMarkSelection();
      this.updateMeasurements();
      this.updateCopyControls();
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
      this.finishGesture(false);
      this.clearPointerStroke();
      this.selectedMarkId = null;
      this.markPick = null;
      this.closeShapeOptions();
      const before = cloneValue(this.annotations);
      this.annotations = emptyAnnotations();
      this.focusEnabled = false;
      if (this.tool === 'focus') this.tool = '';
      this.closeFocusOptions();
      this.hideLaser();
      this.recordAnnotationChange(before, 'clear');
      this.drawAnnotations();
      this.updateToolState();
      this.showToast('已清除讲解标注');
    }

    saveStepNotes() {
      const step = this.steps[this.stepIndex];
      if (!step) return;
      step.notes = this.notesText.value;
      step.notesView = {
        start: this.notesText.selectionStart,
        end: this.notesText.selectionEnd,
        direction: this.notesText.selectionDirection,
        top: this.notesText.scrollTop,
        left: this.notesText.scrollLeft
      };
      this.updateSaveControls();
    }

    showStepNotes(step) {
      this.notesText.value = typeof step.notes === 'string' ? step.notes : '';
      const view = step.notesView || {};
      this.notesText.setSelectionRange(view.start || 0, view.end || 0, view.direction || 'none');
      this.notesText.scrollTop = view.top || 0;
      this.notesText.scrollLeft = view.left || 0;
    }

    captureStep() {
      return {
        title: DEFAULT_STEP_TITLE,
        notes: this.notesText.value,
        annotations: cloneValue(this.annotations),
        focusEnabled: this.focusEnabled,
        focusMode: this.focusMode,
        tool: this.tool,
        activeCursor: this.activeCursor,
        windowStart: this.windowStart,
        scale: this.scale,
        fitMode: this.fitMode,
        scrollLeft: this.viewport.scrollLeft,
        scrollTop: this.viewport.scrollTop
      };
    }

    storeCurrentStep() {
      const step = this.steps[this.stepIndex];
      if (!step) return;
      this.saveStepNotes();
      Object.assign(step, this.captureStep(), { title: step.title || DEFAULT_STEP_TITLE });
    }

    presentationSignature() {
      // Playback navigation, zoom and panel layout are not content edits.
      return JSON.stringify(this.steps.map((step, index) => {
        const current = index === this.stepIndex;
        return {
          title: current && this.stepTitleEdit ? this.stepTitleInput.value.trim() || DEFAULT_STEP_TITLE : step.title,
          notes: current ? this.notesText.value : step.notes,
          annotations: current ? this.annotations : step.annotations
        };
      }));
    }

    hasUnsavedChanges() {
      if (!this.steps.length) return false;
      if (this.savedSignature !== this.presentationSignature()) return true;
      if (this.textEdit) {
        const mark = this.annotations.marks.find((item) => item.id === this.textEdit.id);
        if (this.textInput.value !== (mark ? mark.text : '') && (mark || this.textInput.value.trim())) return true;
      }
      return false;
    }

    syncBeforeUnload(enabled) {
      if (!this.eventsBound || enabled === this.beforeUnloadAttached) return;
      this.beforeUnloadAttached = enabled;
      if (enabled) root.addEventListener('beforeunload', this.boundBeforeUnload);
      else root.removeEventListener('beforeunload', this.boundBeforeUnload);
    }

    updateSaveControls() {
      if (!this.saveButton || this.destroyed) return;
      const dirty = this.hasUnsavedChanges();
      this.saveButton.disabled = this.saving || !this.steps.length;
      this.saveButton.setAttribute('aria-busy', String(this.saving));
      this.saveState.textContent = this.saving ? '正在保存...' : !this.steps.length ? '' : dirty ? '未保存' : '已保存';
      this.saveState.classList.toggle('is-dirty', dirty);
      this.syncBeforeUnload(this.saving || dirty);
      if (this.exitDialog) this.exitDialog.querySelectorAll('button').forEach((button) => { button.disabled = this.saving; });
    }

    savePresentation() {
      if (this.savePromise) return this.savePromise;
      if (!this.steps.length) return Promise.resolve(false);
      this.finishStepTitleEdit(true);
      this.finishGesture(false);
      this.finishTextEdit(true);
      this.storeCurrentStep();
      const signature = this.presentationSignature();
      const serialized = JSON.stringify({ kind: 'VisualWaveDromPresentation', version: 1,
        steps: this.steps, activeStep: this.stepIndex });
      this.saving = true;
      this.updateSaveControls();
      this.log('presenter-save', { phase: 'start', stepCount: this.steps.length });
      this.savePromise = Promise.resolve().then(() => {
        if (typeof this.adapter.savePresentation !== 'function') throw new Error('保存模块未加载，请刷新页面后重试');
        return this.adapter.savePresentation(serialized, this.savedPresentation);
      }).then((result) => {
        if (!result || result.presentation !== serialized) throw new Error('未收到保存成功确认，请重试');
        this.savedPresentation = serialized;
        this.savedSignature = signature;
        if (this.document) this.document.presentation = serialized;
        if (!this.destroyed) this.showToast(result.downloaded ? '演讲步骤已保存，已导出 SQLite 波形库。' : '演讲步骤已保存。');
        this.log('presenter-save', { phase: 'saved', changedDuringSave: this.hasUnsavedChanges() });
        return true;
      }).catch((error) => {
        if (!this.destroyed) {
          this.showToast('保存失败：' + error.message, true);
          this.exitMessage.textContent = '保存失败：' + error.message;
        }
        this.log('presenter-save', { phase: 'error', message: error.message });
        return false;
      }).finally(() => {
        this.saving = false;
        this.savePromise = null;
        this.updateSaveControls();
      });
      return this.savePromise;
    }

    handleBeforeUnload(event) {
      if (this.allowClose || this.destroyed || (!this.saving && !this.hasUnsavedChanges())) return;
      event.preventDefault();
      event.returnValue = true;
    }

    requestExit() {
      this.finishStepTitleEdit(true);
      this.finishGesture(false);
      this.finishTextEdit(true);
      if (!this.saving && !this.hasUnsavedChanges()) {
        this.closePresenter();
        return;
      }
      this.exitMessage.textContent = this.saving ? '正在保存演讲步骤，请稍候。' : '演讲步骤有未保存的改动。';
      if (this.exitDialog.hidden) {
        this.exitDialog.hidden = false;
        if (typeof this.exitDialog.showModal === 'function') this.exitDialog.showModal();
        else this.exitDialog.setAttribute('open', '');
      }
      this.updateSaveControls();
      if (!this.saving) this.exitDialog.querySelector('[data-action="exit-save"]').focus();
      else void this.saveAndExit();
    }

    cancelExit() {
      if (typeof this.exitDialog.close === 'function') this.exitDialog.close();
      else this.exitDialog.removeAttribute('open');
      this.exitDialog.hidden = true;
      this.viewport.focus({ preventScroll: true });
    }

    async saveAndExit() {
      if (this.closingAfterSave) return;
      this.closingAfterSave = true;
      try {
        if (await this.savePresentation()) {
          if (!this.hasUnsavedChanges()) this.closePresenter();
          else this.exitMessage.textContent = '保存期间又有新的改动，请再次保存后退出。';
        }
      } finally {
        this.closingAfterSave = false;
      }
    }

    closePresenter() {
      this.allowClose = true;
      this.cancelExit();
      if (typeof this.adapter.close === 'function') this.adapter.close();
      else root.close();
      clearTimeout(this.closeTimer);
      this.closeTimer = setTimeout(() => { this.allowClose = false; }, 500);
    }

    recordStep() {
      this.finishStepTitleEdit(true);
      this.finishGesture(false);
      this.clearPointerStroke();
      this.saveStepNotes();
      const step = this.captureStep();
      this.steps = this.steps.slice(0, this.stepIndex + 1);
      this.steps.push(step);
      this.stepIndex = this.steps.length - 1;
      this.showStepNotes(step);
      this.updateStepControls();
      this.updateSaveControls();
      this.showToast('已记录第 ' + (this.stepIndex + 1) + ' 个演讲步骤');
    }

    async goToStep(index) {
      if (index < 0 || index >= this.steps.length || index === this.stepIndex) return;
      this.finishStepTitleEdit(true);
      this.finishGesture(false);
      this.clearPointerStroke();
      this.storeCurrentStep();
      this.closeFocusOptions();
      this.selectedMarkId = null;
      this.markPick = null;
      this.lastHistoryEdit = null;
      this.closeShapeOptions();
      this.hideLaser();
      const step = cloneValue(this.steps[index]);
      this.stepIndex = index;
      this.showStepNotes(step);
      this.annotations = step.annotations || this.annotations;
      this.keepAnnotationsInSourceBounds(
        Math.max(0, Number(this.metrics.maxWaveLength) || 0),
        Number(this.metrics.signalCount) || 0
      );
      this.tool = step.tool || '';
      this.focusEnabled = !!step.focusEnabled || !!this.annotations.focus;
      this.focusMode = step.focusMode || 'rows';
      this.activeCursor = step.activeCursor || 'A';
      this.undoStack.length = 0;
      this.redoStack.length = 0;
      const total = Math.max(0, Number(this.metrics.maxWaveLength) || 0);
      const maxStart = Math.max(0, total - this.windowSize);
      const nextStart = clamp(step.windowStart, 0, maxStart);
      if (nextStart !== this.windowStart) {
        this.windowStart = nextStart;
        await this.renderWave({ preserveView: false });
      }
      if (this.destroyed || this.stepIndex !== index) return;
      this.fitMode = !!step.fitMode;
      if (this.fitMode) this.fitToWindow(false);
      else this.setScale(step.scale || 1, false);
      requestAnimationFrame(() => {
        if (this.destroyed || this.stepIndex !== index) return;
        this.viewport.scrollLeft = step.scrollLeft || 0;
        this.viewport.scrollTop = step.scrollTop || 0;
        this.drawAnnotations();
        this.updateFrozenLabels();
      });
      this.updateToolState();
      this.updateStepControls();
      this.updateSaveControls();
    }

    updateStepControls() {
      const count = this.steps.length || 1;
      const index = this.stepIndex >= 0 ? this.stepIndex + 1 : 1;
      this.stepCount.textContent = index + ' / ' + count;
      const step = this.steps[this.stepIndex];
      if (this.stepTitleInput && !this.stepTitleEdit) {
        const title = step && step.title || DEFAULT_STEP_TITLE;
        if (this.stepTitleInput.value !== title) this.stepTitleInput.value = title;
        this.stepTitleInput.title = title;
        this.stepTitleInput.disabled = !step;
        this.resizeStepTitle();
      }
      const previous = this.app.querySelector('[data-action="step-prev"]');
      const next = this.app.querySelector('[data-action="step-next"]');
      previous.disabled = this.stepIndex <= 0;
      next.disabled = this.stepIndex < 0 || this.stepIndex >= this.steps.length - 1;
    }

    resizeStepTitle() {
      const input = this.stepTitleInput;
      if (!input) return;
      input.style.height = 'auto';
      input.style.height = (input.scrollHeight + input.offsetHeight - input.clientHeight) + 'px';
    }

    finishStepTitleEdit(save) {
      const step = this.stepTitleEdit;
      if (!step) return;
      this.stepTitleEdit = null;
      if (save) {
        const title = this.stepTitleInput.value.trim() || DEFAULT_STEP_TITLE;
        if (step.title !== title) {
          step.title = title;
          this.log('presenter-step', { phase: 'rename', index: this.steps.indexOf(step), titleLength: title.length });
        }
      }
      if (document.activeElement === this.stepTitleInput) this.stepTitleInput.blur();
      this.updateStepControls();
      this.updateSaveControls();
    }

    toggleNotes() {
      if (this.notesWindow && this.notesWindow.detached) {
        this.notesWindow.focus();
        return;
      }
      const collapsed = this.workspace.classList.toggle('notes-collapsed');
      this.updateNotesControls();
      if (!collapsed) requestAnimationFrame(() => this.notesText.focus({ preventScroll: true }));
      if (this.fitMode) requestAnimationFrame(() => this.fitToWindow(false));
    }

    updateNotesControls() {
      const detached = !!(this.notesWindow && this.notesWindow.detached);
      const topButton = this.app.querySelector('.presenter-top-actions [data-action="notes"]');
      topButton.setAttribute('aria-pressed', detached || !this.workspace.classList.contains('notes-collapsed') ? 'true' : 'false');
      topButton.dataset.shortcutTitle = detached ? '唤起独立备注窗口' : '显示或隐藏讲解备注';
      topButton.title = topButton.dataset.shortcutTitle;
      this.app.querySelector('.presenter-top-actions [data-action="notes-restore"]').hidden = !detached && !this.notesWindowOpening;
      this.notesPanel.querySelector('[data-action="notes-detach"]').hidden = detached;
      this.notesPanel.querySelector('[data-action="notes-detach"]').disabled = this.notesWindowOpening;
      this.notesPanel.querySelector('[data-action="notes-restore"]').hidden = !detached;
      this.notesPanel.querySelector('[data-action="notes"]').hidden = detached;
      this.refreshShortcutUI();
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
        if (document.activeElement === this.notesText || this.stepTitleEdit || this.textEdit || !this.focusOptions.hidden
            || (this.shapeOptions && !this.shapeOptions.hidden) || (this.copyOptions && !this.copyOptions.hidden)
            || (this.settingsOptions && !this.settingsOptions.hidden)
            || (this.exitDialog && !this.exitDialog.hidden) || this.drag) return;
        this.app.classList.add('controls-idle');
      }, 2600);
    }

    handleKeydown(event) {
      const target = event.target;
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      const key = String(event.key || '').toLowerCase();
      if (this.exitDialog && !this.exitDialog.hidden) {
        if (key === 'escape') {
          event.preventDefault();
          event.stopPropagation();
          if (!this.saving) this.cancelExit();
        } else this.dispatchShortcut(event, this.exitDialog);
        return;
      }
      if (this.settingsOptions && !this.settingsOptions.hidden) {
        if (key === 'escape') {
          event.preventDefault();
          event.stopPropagation();
          this.closeSettings();
        } else this.dispatchShortcut(event, this.settingsOptions);
        return;
      }
      if (target === this.stepTitleInput && (key === 'enter' || key === 'escape')) {
        event.preventDefault();
        event.stopPropagation();
        this.finishStepTitleEdit(key === 'enter');
        this.viewport.focus({ preventScroll: true });
        return;
      }
      if (key === 'escape') {
        event.preventDefault();
        if (this.copyOptions && !this.copyOptions.hidden) {
          if (!this.copying) this.closeCopyOptions();
          return;
        }
        if (this.selectedMarkId) {
          this.finishGesture(true);
          this.selectedMarkId = null;
          this.setTool('');
          this.drawAnnotations();
          return;
        }
        this.finishGesture(true);
        this.clearPointerStroke();
        const editingText = !!this.textEdit;
        this.finishTextEdit(false);
        if (this.focusEnabled || this.annotations.focus) this.clearFocus();
        else if (this.tool) this.setTool('');
        else if (!editingText && document.fullscreenElement) void document.exitFullscreen();
        if (target && typeof target.blur === 'function') target.blur();
        this.viewport.focus({ preventScroll: true });
        return;
      }
      const dialog = this.textEdit && this.textEditor.contains(target) ? this.textEditor
        : target && typeof target.closest === 'function' ? target.closest('[role="dialog"], dialog') : null;
      const typing = target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable);
      if (key === 'delete' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
          && !typing && !dialog && !this.tool && this.selectedMark()) {
        event.preventDefault();
        event.stopPropagation();
        this.deleteSelectedMark();
        return;
      }
      this.dispatchShortcut(event, dialog && this.app.contains(dialog) ? dialog : null);
    }

    destroy() {
      this.destroyed = true;
      this.syncBeforeUnload(false);
      if (this.notesWindow) this.notesWindow.destroy();
      clearTimeout(this.toastTimer);
      clearTimeout(this.liveTimer);
      clearTimeout(this.controlsTimer);
      clearTimeout(this.closeTimer);
      cancelAnimationFrame(this.annotationFrame);
      this.hideLaser();
      this.clearPointerStroke();
      if (this.resizeObserver) this.resizeObserver.disconnect();
      root.removeEventListener('storage', this.boundShortcutStorage);
      if (this.shortcutChannel) this.shortcutChannel.close();
      document.removeEventListener('keydown', this.boundKeydown);
      document.removeEventListener('pointerdown', this.boundOutside, true);
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
    version: '1.2.0',
    mount: mount
  };
}));

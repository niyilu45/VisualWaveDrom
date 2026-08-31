(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VisualWaveDromPresenterSplit = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const XLINK_NS = 'http://www.w3.org/1999/xlink';
  const MODES = { none: '不分屏', rows: '上下分屏', columns: '左右分屏' };
  const PANE_FIELDS = ['viewport', 'stageContent', 'surface', 'overlay', 'frozenLabels',
    'frozenLabelNodes', 'frozenLabelView', 'frozenLabelsActive', 'markClipId'];
  const position = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;

  class SplitView {
    constructor(view) {
      this.view = view;
      this.mode = 'none';
      this.container = view.app.querySelector('#presenter-stage-panes');
      this.button = view.splitButton;
      this.options = view.splitOptions;
      this.panes = [{ element: view.app.querySelector('#presenter-stage-primary'),
        display: view.display, index: 0, synced: {} }];
      this.active = this.panes[0];
      view.markClipId = 'presenter-mark-clip-0';
      this.storePane(this.active);
      this.options.addEventListener('change', (event) => {
        if (event.target.name === 'presenter-split-mode') this.setMode(event.target.value);
      });
      this.updateControls();
    }

    storePane(pane) {
      PANE_FIELDS.forEach(key => { pane[key] = this.view[key]; });
    }

    usePane(pane) {
      PANE_FIELDS.forEach(key => { this.view[key] = pane[key]; });
    }

    visiblePanes() {
      return this.mode === 'none' ? this.panes.slice(0, 1) : this.panes;
    }

    forEachPane(callback, includeHidden) {
      this.storePane(this.active);
      try {
        (includeHidden ? this.panes : this.visiblePanes()).forEach(pane => {
          this.usePane(pane);
          callback(pane);
          this.storePane(pane);
        });
      } finally {
        this.usePane(this.active);
      }
    }

    activateViewport(viewport) {
      const pane = this.panes.find(item => item.viewport === viewport);
      if (!pane || pane === this.active) return true;
      if (this.view.drag || (this.mode === 'none' && pane.index !== 0)) return false;
      this.view.finishTextEdit(true, false);
      this.storePane(this.active);
      this.active = pane;
      this.usePane(pane);
      pane.surface.appendChild(this.view.textEditor);
      this.panes.forEach(item => item.element.classList.toggle('active', item === pane));
      this.view.markPick = null;
      this.view.drawAnnotations();
      this.view.updateToolState();
      return true;
    }

    createSecondary() {
      if (this.panes.length > 1) return;
      const document = this.container.ownerDocument;
      const element = document.createElement('section');
      element.className = 'presenter-stage-pane';
      element.setAttribute('aria-label', '波形分区 2');
      element.innerHTML = '<div class="presenter-stage-viewport" tabindex="0" aria-label="波形分区 2 演讲与标注区域">'
        + '<div class="presenter-stage-content"><div class="presenter-wave-surface">'
        + '<div class="presenter-wave-display" aria-hidden="true"></div>'
        + '<svg class="presenter-overlay" aria-label="演讲标注层"></svg>'
        + '</div></div></div><div class="presenter-frozen-labels" aria-hidden="true"></div>';
      this.container.appendChild(element);
      const pane = { element, index: 1, synced: {},
        viewport: element.querySelector('.presenter-stage-viewport'),
        stageContent: element.querySelector('.presenter-stage-content'),
        surface: element.querySelector('.presenter-wave-surface'),
        display: element.querySelector('.presenter-wave-display'),
        overlay: element.querySelector('.presenter-overlay'),
        frozenLabels: element.querySelector('.presenter-frozen-labels'),
        frozenLabelNodes: [], frozenLabelView: null, frozenLabelsActive: false,
        markClipId: 'presenter-mark-clip-1' };
      this.panes.push(pane);
      this.view.bindStageEvents(pane.viewport, pane.overlay);
      if (this.view.resizeObserver) this.view.resizeObserver.observe(pane.viewport);
      this.refreshWave();
    }

    refreshWave() {
      const view = this.view;
      if (!view.svg || !view.svgMetrics) return;
      const metrics = view.svgMetrics;
      const secondary = this.panes[1];
      if (secondary) {
        const document = secondary.display.ownerDocument;
        if (!view.svg.id) view.svg.id = 'presenter-split-wave-' + view.renderSequence;
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('width', metrics.width);
        svg.setAttribute('height', metrics.height);
        // Reference the rendered source: no second WaveDrom render or full SVG clone on scroll.
        const use = document.createElementNS(SVG_NS, 'use');
        use.setAttribute('href', '#' + view.svg.id);
        use.setAttributeNS(XLINK_NS, 'xlink:href', '#' + view.svg.id);
        use.setAttribute('width', metrics.width);
        use.setAttribute('height', metrics.height);
        svg.appendChild(use);
        secondary.display.replaceChildren(svg);
      }
      this.forEachPane(() => {
        view.surface.style.width = metrics.width + 'px';
        view.surface.style.height = metrics.height + 'px';
        view.overlay.setAttribute('viewBox', [metrics.x, metrics.y, metrics.width, metrics.height].join(' '));
        view.overlay.setAttribute('width', metrics.width);
        view.overlay.setAttribute('height', metrics.height);
        view.overlay.style.width = metrics.width + 'px';
        view.overlay.style.height = metrics.height + 'px';
      });
    }

    syncAnnotations() {
      if (this.mode === 'none' || this.view.destroyed) return;
      const source = this.view.overlay;
      const sourceClip = this.view.markClipId;
      this.panes.forEach(pane => {
        if (pane.overlay === source) return;
        const fragment = source.ownerDocument.createDocumentFragment();
        Array.from(source.childNodes).forEach(child => fragment.appendChild(child.cloneNode(true)));
        fragment.querySelectorAll('[id]').forEach(node => {
          if (node.id === sourceClip) node.id = pane.markClipId;
        });
        fragment.querySelectorAll('[clip-path]').forEach(node => {
          if (node.getAttribute('clip-path') === 'url(#' + sourceClip + ')') {
            node.setAttribute('clip-path', 'url(#' + pane.markClipId + ')');
          }
        });
        pane.overlay.replaceChildren(fragment);
      });
    }

    syncScroll(viewport, force) {
      if (this.mode === 'none') return;
      const source = this.panes.find(pane => pane.viewport === viewport);
      if (!source) return;
      const horizontal = this.mode === 'rows';
      const axis = horizontal ? 'scrollLeft' : 'scrollTop';
      const extent = horizontal ? 'scrollWidth' : 'scrollHeight';
      const size = horizontal ? 'clientWidth' : 'clientHeight';
      const current = viewport[axis];
      if (!force && source.synced[axis] === current) return;
      const states = this.panes.map(pane => ({ pane, current: pane.viewport[axis],
        limit: Math.max(0, pane.viewport[extent] - pane.viewport[size]) }));
      const value = Math.max(0, Math.min(current, ...states.map(state => state.limit)));
      // Remember programmatic positions before writes so echoed scroll events cannot feed back.
      states.forEach(state => { state.pane.synced[axis] = value; });
      states.forEach(state => {
        if (state.current !== value) state.pane.viewport[axis] = value;
      });
    }

    snapshot() {
      return { mode: this.mode, active: this.active.index, positions: this.visiblePanes().map(pane => ({
        left: pane.viewport.scrollLeft, top: pane.viewport.scrollTop
      })) };
    }

    restorePositions(state) {
      if (!state || !Array.isArray(state.positions)) return;
      this.visiblePanes().forEach((pane, index) => {
        const saved = state.positions[index];
        if (!saved || typeof saved !== 'object') return;
        pane.viewport.scrollLeft = position(saved.left);
        pane.viewport.scrollTop = position(saved.top);
      });
      const active = this.mode !== 'none' && state.active === 1 ? this.panes[1] : this.panes[0];
      this.activateViewport(active.viewport);
      this.syncScroll(active.viewport, true);
      this.view.updateFrozenLabels();
    }

    setMode(mode, restore) {
      if (!Object.prototype.hasOwnProperty.call(MODES, mode) || !this.view.svg) return false;
      const view = this.view;
      view.finishGesture(false);
      view.finishTextEdit(true, false);
      const previous = this.mode;
      const saved = { left: view.viewport.scrollLeft, top: view.viewport.scrollTop };
      if (mode !== 'none') this.createSecondary();
      if (mode === 'none') this.activateViewport(this.panes[0].viewport);
      this.mode = mode;
      this.container.classList.toggle('split-rows', mode === 'rows');
      this.container.classList.toggle('split-columns', mode === 'columns');
      if (this.panes[1]) this.panes[1].element.hidden = mode === 'none';
      if (!restore) view.fitMode = false;
      this.refreshWave();
      view.setScale(view.scale, false);
      if (mode === 'none' || previous === 'none') {
        this.visiblePanes().forEach(pane => {
          pane.viewport.scrollLeft = saved.left;
          pane.viewport.scrollTop = saved.top;
        });
      }
      this.syncScroll(view.viewport, true);
      view.updateFrozenLabels();
      view.drawAnnotations();
      view.updateToolState();
      this.close(false);
      this.updateControls();
      if (!restore) view.viewport.focus({ preventScroll: true });
      view.log('presenter-split', { phase: 'layout', mode, active: this.active.index });
      return true;
    }

    toggleOptions() {
      if (!this.options.hidden) return this.close(true);
      this.view.closeFocusOptions();
      this.view.closeShapeOptions();
      if (!this.view.copying) this.view.closeCopyOptions();
      this.options.hidden = false;
      this.button.setAttribute('aria-expanded', 'true');
      this.positionOptions();
      const selected = this.options.querySelector('input:checked');
      if (selected) selected.focus({ preventScroll: true });
      this.view.noteActivity();
    }

    close(focus) {
      this.options.hidden = true;
      this.button.setAttribute('aria-expanded', 'false');
      if (focus) this.button.focus({ preventScroll: true });
    }

    positionOptions() {
      if (this.options.hidden) return;
      const rect = this.button.getBoundingClientRect();
      this.view.positionPopover(this.options, rect.left, rect.bottom, false);
    }

    updateControls() {
      this.button.disabled = !this.view.svg;
      this.button.classList.toggle('active', this.mode !== 'none');
      this.button.dataset.shortcutTitle = '分屏：' + MODES[this.mode];
      this.button.title = this.button.dataset.shortcutTitle;
      this.options.querySelectorAll('input[name="presenter-split-mode"]').forEach(input => {
        input.checked = input.value === this.mode;
      });
    }

    destroy() {
      this.close(false);
      if (this.view.resizeObserver && this.panes[1]) this.view.resizeObserver.unobserve(this.panes[1].viewport);
    }
  }

  return { create: view => new SplitView(view) };
}));

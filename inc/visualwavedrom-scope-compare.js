(function (global) {
  'use strict';
  const AXIS_HEIGHT = 38;
  const NAME_WIDTH = 160;
  const COLLAPSED_ROW_HEIGHT = 24;
  const OVERLAY_PAIR_GAP = 6;
  const MIN_ROW_HEIGHT = 28;
  const MAX_ROW_HEIGHT = 480;
  const ROW_NAME_X = 32;
  const COLORS = ['#176ca5', '#b45c0c'];
  const CURSOR_COLORS = { A: '#1f68d5', B: '#d93025', C: '#565e68' };
  const CURSORS = ['A', 'B', 'C'];
  const SIDES = ['left', 'right'];
  const icons = {
    prev: '<path d="m15 18-6-6 6-6"/>', next: '<path d="m9 18 6-6-6-6"/>',
    close: '<path d="m18 6-12 12M6 6l12 12"/>', plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>', edit: '<path d="m16 3 5 5-12 12H4v-5zM14 5l5 5"/>',
    swap: '<path d="m16 3 4 4-4 4M20 7H4m4 14-4-4 4-4m-4 4h16"/>'
  };
  function icon(name) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' + icons[name] + '</svg>'; }
  function button(action, label, symbol) {
    return '<button type="button" data-action="' + action + '" title="' + label + '" aria-label="' + label + '">' + (symbol ? icon(symbol) : label) + '</button>';
  }
  function display(value) { return value == null ? '无数据' : value.unknown ? 'x' : typeof value === 'object' ? JSON.stringify(value) : String(value); }

  class ScopeComparison {
    constructor(scope) {
      this.scope = scope;
      this.active = false;
      this.generation = 0;
      this.tags = [];
      this.selectedError = null;
      this.cache = null;
      this.scrollTop = 0;
      this.start = 0;
      this.end = 1;
      this.layout = 'vertical';
      this.sequence = 0;
      this.pendingChanges = new Map();
      this.cursorSequence = 0;
      this.collapsedPairs = new Set();
      this.filteredPairs = new Set();
      this.namesHidden = { left: false, right: true };
    }

    async open() {
      if (this.active && !this.popup.closed) { this.popup.focus(); return; }
      if (this.active) this.close({ fromWindow: true });
      const width = Math.min(1440, global.screen.availWidth);
      const height = Math.min(940, global.screen.availHeight);
      const popup = global.open('', '_blank', 'popup=yes,resizable=yes,width=' + width + ',height=' + height);
      if (!popup) { this.scope.setStatus('浏览器阻止了比较窗口，请允许弹出式窗口', true); return; }
      this.popup = popup;
      this.active = true;
      this.layout = 'vertical';
      this.collapsedPairs.clear();
      this.filteredPairs.clear();
      this.signalRowHeight = null;
      this.namesHidden = { left: false, right: true };
      this.delayOverrides = { left: new Map(), right: new Map() };
      const opening = ++this.sequence;
      const doc = popup.document;
      doc.title = this.scope.meta.title + ' - 示波器比较';
      doc.documentElement.lang = 'zh-CN';
      document.querySelectorAll('link[href*="visualwavedrom-scope-compare.css"], link[href*="visualwavedrom-scope.css"]').forEach(css => {
        const link = doc.createElement('link');
        link.rel = 'stylesheet'; link.href = css.href; doc.head.appendChild(link);
      });
      const viewport = doc.createElement('meta');
      viewport.name = 'viewport'; viewport.content = 'width=device-width,initial-scale=1';
      doc.head.appendChild(viewport);
      popup.addEventListener('pagehide', () => {
        if (this.popup === popup) this.close({ fromWindow: true });
      }, { once: true });
      this.root = doc.createElement('section');
      this.root.className = 'scope-comparison';
      this.root.setAttribute('aria-label', '示波器比较');
      this.root.innerHTML = `
        <header class="scope-compare-toolbar">
          <strong>示波器比较</strong>
          <label>布局 <select class="scope-compare-layout" aria-label="比较布局">
            <option value="vertical">上下分屏</option><option value="horizontal">左右分屏</option><option value="overlay">信号重叠</option>
          </select></label>
          <button type="button" data-action="swap" title="交换比较图 A 和 B">${icon('swap')}交换</button>
          ${button('expand-all', '全部展开')}
          <button type="button" data-action="filter-signals" aria-haspopup="dialog">信号筛选</button>
          ${button('close', '退出比较', 'close')}
        </header>
        <div class="scope-compare-controls">
          ${button('prev', '上一个错误', 'prev')}${button('next', '下一个错误', 'next')}
          <span class="scope-compare-count"></span>
          ${button('tag', '添加错误标签')}
          <label>起始 cycle <input class="scope-compare-start" type="number" min="0" step="0.5" value="0"></label>
          <label>显示 cycle <input class="scope-compare-span" type="number" min="0.5" step="0.5" value="1"></label>
          ${button('zoom-in', '放大', 'plus')}${button('zoom-out', '缩小', 'minus')}${button('fit', '适应窗口')}
          <button type="button" data-action="fit-cursors" title="显示 A、B 游标之间的区域">适应游标</button>
          <button type="button" data-action="fit-selection" title="显示当前框选区域（Z）" aria-keyshortcuts="z">适应选区</button>
        </div>
        <div class="scope-compare-cursors">
          <span>选择游标</span>
          ${CURSORS.map(name => `<button type="button" data-cursor="${name}" title="选择游标 ${name}（${name.toLowerCase()}）" aria-keyshortcuts="${name}" aria-pressed="false">${name}</button>`).join('')}
          <span>跳转到游标</span>
          ${CURSORS.map(name => `<button type="button" data-locate="${name}" aria-keyshortcuts="Shift+${name}"><span></span></button>`).join('')}
          <span class="scope-compare-cursor-signal"></span>
          <label>跳转 <input type="text" class="scope-compare-condition" aria-label="游标跳转值或条件" placeholder="1,2 或 &gt;=1"></label>
          ${button('edge-prev', '跳到上一个匹配边沿（左方向键 / 鼠标上侧键）', 'prev')}
          ${button('edge-next', '跳到下一个匹配边沿（右方向键 / 鼠标下侧键）', 'next')}
          <output class="scope-compare-measurements"></output>
        </div>
        <div class="scope-compare-tags" aria-label="错误位置标签"></div>
        <div id="scope-compare-panes" class="scope-compare-panes" data-layout="vertical"></div>
        <div class="scope-compare-pan"><div class="scope-compare-pan-thumb" role="scrollbar" tabindex="-1"
          aria-controls="scope-compare-panes" aria-orientation="horizontal" aria-label="横向滚动比较波形"
          aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" aria-disabled="true"></div></div>
        <footer class="scope-compare-status" role="status" aria-live="polite"></footer>
        <form class="scope-compare-delay-card" role="dialog" aria-labelledby="scope-compare-delay-title" hidden>
          <strong id="scope-compare-delay-title"></strong>
          <label class="scope-compare-delay-side">比较图 <select aria-label="偏移作用于比较图">
            <option value="left">A</option><option value="right">B</option>
          </select></label>
          <div class="scope-compare-delay-fields">
            <label title="当前比较图的公共偏移（cycle）">commDly <input name="commDly" type="number" min="-10000000" max="10000000" step="0.5" placeholder="0"></label>
            <label title="信号偏移（cycle）">dly <input name="dly" type="number" min="-10000000" max="10000000" step="0.5" placeholder="0"></label>
          </div>
          <div class="scope-compare-delay-actions"><button type="button" data-close-delay>取消</button>
            <button type="submit">应用</button></div>
        </form>`;
      doc.body.appendChild(this.root);
      this.activeCursor = ''; this.cursorPositions = { A: null, B: null, C: null };
      this.rangeSelection = null;
      this.cursorPair = 0; this.cursorSide = 'left';
      this.panesRoot = this.root.querySelector('.scope-compare-panes');
      this.selects = Object.fromEntries(SIDES.map((side, index) => {
        const select = doc.createElement('select');
        const label = index ? 'B' : 'A';
        select.className = 'scope-compare-source-select';
        select.setAttribute('aria-label', '选择比较图 ' + label);
        select.append(new popup.Option(index ? '选择比较图 B（可选）' : '请选择波形图', ''));
        select.addEventListener('change', () => {
          if (this.selects.left.value) void this.load();
        });
        return [side, select];
      }));
      this.count = this.root.querySelector('.scope-compare-count');
      this.status = this.root.querySelector('.scope-compare-status');
      this.startInput = this.root.querySelector('.scope-compare-start');
      this.spanInput = this.root.querySelector('.scope-compare-span');
      this.pan = this.root.querySelector('.scope-compare-pan');
      this.panThumb = this.pan.firstElementChild;
      this.condition = this.root.querySelector('.scope-compare-condition');
      this.cursorSignal = this.root.querySelector('.scope-compare-cursor-signal');
      this.measurements = this.root.querySelector('.scope-compare-measurements');
      this.delayCard = this.root.querySelector('.scope-compare-delay-card');
      this.delaySide = this.delayCard.querySelector('select');
      this.delayCard.addEventListener('submit', (event) => {
        event.preventDefault();
        void this.applyPairDelay();
      });
      this.delayCard.querySelector('[data-close-delay]').addEventListener('click', () => this.closeDelayCard());
      this.delaySide.addEventListener('change', () => this.fillDelayCard());
      this.root.addEventListener('pointerdown', (event) => {
        if (!this.delayCard.contains(event.target)) this.closeDelayCard();
      }, { capture: true });
      this.root.addEventListener('click', (event) => {
        const cursor = event.target.closest('[data-cursor], [data-locate]');
        if (cursor?.dataset.cursor) { this.selectCursor(cursor.dataset.cursor); return; }
        if (cursor?.dataset.locate) { this.locateCursor(cursor.dataset.locate); return; }
        const target = event.target.closest('[data-action]');
        if (target) void Promise.resolve(this.action(target.dataset.action)).catch((error) => {
          if (this.active) this.status.textContent = error.message;
        });
      });
      this.bindShortcuts(doc);
      this.root.querySelector('.scope-compare-layout').addEventListener('change', (event) => {
        const top = this.result ? this.pairAtOffset(this.scrollTop) : -1;
        const fraction = this.pairHeight(top) > 0
          ? (this.scrollTop - this.rowOffsets[top]) / this.pairHeight(top) : 0;
        this.layout = event.target.value;
        if (this.result) {
          this.rebuildRowOffsets();
          if (top >= 0 && top < this.result.pairs.length) {
            this.scrollTop = this.rowOffsets[top] + fraction * this.pairHeight(top);
          }
        }
        this.buildPanes();
      });
      this.startInput.addEventListener('change', () => this.setView(Number(this.startInput.value), this.end - this.start));
      this.spanInput.addEventListener('change', () => this.setView(this.start, Number(this.spanInput.value)));
      this.bindPan();
      this.resizeObserver = new popup.ResizeObserver(() => this.schedule());
      this.resizeObserver.observe(this.panesRoot);
      this.buildPanes();
      this.setBusy(true, '正在读取波形目录…');
      try {
        const documents = await this.scope.adapter.listComparisonDocuments();
        if (!this.active || opening !== this.sequence) return;
        const choices = documents.some(item => item.name === this.scope.document.name) ? documents
          : [{ name: this.scope.document.name, title: this.scope.meta.title }, ...documents];
        SIDES.forEach(side => this.populateSources(this.selects[side], choices));
        this.selects.left.value = this.scope.document.name;
        this.selects.left.options[0].disabled = true;
        this.setBusy(false);
        await this.load();
      } catch (error) { if (this.active && opening === this.sequence) this.setBusy(false, '读取目录失败：' + error.message); }
    }

    bindShortcuts(doc) {
      this.shortcutEvents = new this.popup.AbortController();
      const { signal } = this.shortcutEvents;
      doc.addEventListener('keydown', (event) => {
        if (!this.active || event.defaultPrevented || event.isComposing) return;
        if (event.key === 'Escape') {
          if (!this.delayCard.hidden) { event.preventDefault(); this.closeDelayCard(); }
          else this.close();
          return;
        }
        if (event.ctrlKey || event.altKey || event.metaKey) return;
        if (event.target === this.condition && event.key === 'Enter') {
          event.preventDefault();
          void this.navigateCursor(event.shiftKey ? -1 : 1);
          return;
        }
        if (this.scope.isCursorShortcutInput(event.target) || this.busy || !this.result) return;
        if (/^[abc]$/i.test(event.key)) {
          event.preventDefault();
          if (!event.repeat) (event.shiftKey ? this.locateCursor : this.selectCursor).call(this, event.key.toUpperCase());
        } else if (/^(ArrowLeft|ArrowRight)$/.test(event.key)) {
          event.preventDefault();
          void this.navigateCursor(event.key === 'ArrowRight' ? 1 : -1);
        } else if (event.key.toLowerCase() === 'z' && !event.shiftKey) {
          event.preventDefault();
          if (!event.repeat) this.fitSelection();
        }
      }, { signal });
      this.scope.bindCursorSideButtons(doc, direction => { void this.navigateCursor(direction); }, signal);
    }

    populateSources(select, choices) {
      const doc = select.ownerDocument;
      const groups = new Map();
      choices.forEach(item => {
        const key = item.directoryId || 'nav-root';
        if (!groups.has(key)) {
          const group = doc.createElement('optgroup');
          group.label = item.directoryPath?.join(' / ') || '根目录';
          groups.set(key, group);
        }
        const group = groups.get(key);
        const option = new this.popup.Option(
          (item.number ? item.number + ' ' : '') + (item.title || item.name), item.name
        );
        if (item.number) option.dataset.number = item.number;
        group.appendChild(option);
      });
      const fragment = doc.createDocumentFragment();
      groups.forEach(group => fragment.appendChild(group));
      select.appendChild(fragment);
    }

    setBusy(busy, message) {
      this.busy = busy;
      this.root.setAttribute('aria-busy', String(busy));
      this.root.querySelectorAll('[data-action]').forEach((el) => {
        const action = el.dataset.action;
        el.disabled = action !== 'close' && (busy || !this.result
          || (action === 'swap' && (!this.loadedNames.right || this.loadedNames.left === this.loadedNames.right)));
      });
      SIDES.forEach(side => { this.selects[side].disabled = busy; });
      this.root.querySelector('.scope-compare-layout').disabled = busy || !this.result || !this.loadedNames.right;
      this.startInput.disabled = this.spanInput.disabled = busy || !this.result;
      this.updatePan();
      if (message) this.status.textContent = message;
      this.updateErrorControls();
      this.updateCursorControls();
      this.updateExpandAllControl();
    }

    async action(action) {
      if (action === 'close') return this.close();
      if (this.busy) return;
      if (!this.result) return;
      if (action === 'filter-signals') {
        return global.VisualWaveDromScopeSignalFilter.open(this.root.querySelector('[data-action="filter-signals"]'),
          this.result.pairs.map(pair => ({ id: pair.name, name: pair.name })), this.filteredPairs,
          ids => this.applySignalFilter(ids));
      }
      if (action === 'swap') return this.swap();
      if (action === 'expand-all') {
        this.collapsedPairs.clear();
        this.refreshCollapsedLayout();
        return;
      }
      if (action === 'prev' || action === 'next') return this.navigate(action === 'next' ? 1 : -1);
      if (action === 'edge-prev' || action === 'edge-next') return this.navigateCursor(action === 'edge-next' ? 1 : -1);
      if (action === 'tag') return this.addTag();
      if (action === 'fit') return this.setView(0, this.result.total);
      if (action === 'fit-cursors') return this.fitCursors();
      if (action === 'fit-selection') return this.fitSelection();
      if (action.startsWith('zoom-')) {
        const span = (this.end - this.start) * (action === 'zoom-in' ? 0.5 : 2);
        const center = this.selectedError ? this.selectedError.start : (this.start + this.end) / 2;
        this.setView(center - span / 2, span);
      }
    }

    watches(name) {
      return this.active && !!this.loadedNames && Object.values(this.loadedNames).includes(name);
    }

    sourceChanged(name, document) {
      if (!this.watches(name)) return;
      this.pendingChanges.set(name, document || null);
      this.scheduleRefresh();
    }

    scheduleRefresh() {
      if (!this.active || this.busy || !(this.result || this.refreshAnchor) || !this.pendingChanges.size) return;
      clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => {
        if (!this.active || this.busy) return;
        if (this.scope.formulaRefreshInFlight || this.scope.formulaApplyInFlight) { this.scheduleRefresh(); return; }
        const changes = this.pendingChanges;
        this.pendingChanges = new Map();
        void this.load(changes);
      }, 160);
    }

    async swap() {
      if (!this.loadedNames.right || this.loadedNames.left === this.loadedNames.right) return;
      const sequence = ++this.sequence;
      const generation = this.generation;
      const selected = this.selectedError && { ...this.selectedError,
        leftValue: this.selectedError.rightValue, rightValue: this.selectedError.leftValue };
      this.setBusy(true);
      try {
        const result = await this.scope.worker.call('compare-swap', { generation });
        if (!this.active || sequence !== this.sequence) return;
        this.generation = this.result.generation = result.generation;
        [this.result.left, this.result.right] = [this.result.right, this.result.left];
        [this.leftRenderer, this.rightRenderer] = [this.rightRenderer, this.leftRenderer];
        [this.loadedNames.left, this.loadedNames.right] = [this.loadedNames.right, this.loadedNames.left];
        [this.delayOverrides.left, this.delayOverrides.right] = [this.delayOverrides.right, this.delayOverrides.left];
        this.result.pairs.forEach(pair => {
          [pair.left, pair.right] = [pair.right, pair.left];
          pair.diagnostics = [pair.diagnostics[1], pair.diagnostics[0]];
        });
        SIDES.forEach(side => { this.selects[side].value = this.loadedNames[side]; });
        this.updatePaneTitles();
        this.cursorSide = this.cursorSide === 'left' ? 'right' : 'left';
        if (this.cache?.view.generation === generation) {
          [this.cache.left, this.cache.right] = [this.cache.right, this.cache.left];
          this.cache.view.generation = this.generation;
          if (this.drawnView) this.drawnView.generation = this.generation;
        }
        this.selectedError = selected;
        this.setBusy(false, '已交换比较图 A 和 B');
        if (selected) this.chooseError(selected, false);
        else this.draw();
        this.schedule();
      } finally {
        if (this.active && sequence === this.sequence) {
          if (this.busy) this.setBusy(false);
          this.scheduleRefresh();
        }
      }
    }

    updatePaneTitles() {
      SIDES.forEach(side => {
        const option = this.selects[side].selectedOptions[0];
        if (option?.value && this.result[side].title) {
          option.textContent = (option.dataset.number ? option.dataset.number + ' ' : '') + this.result[side].title;
        }
      });
    }

    async load(changes) {
      if (!this.selects.left.value || this.busy) return;
      this.closeDelayCard();
      const refresh = !!changes;
      const sequence = ++this.sequence;
      if (!refresh) {
        this.refreshAnchor = null;
        this.rangeSelection = null;
        this.loadedNames = Object.fromEntries(SIDES.map(side => [side, this.selects[side].value]));
        this.scope.adapter.watchComparisonDocuments?.(Object.values(this.loadedNames).filter(Boolean));
        this.pendingChanges.clear();
      }
      const { left: leftName, right: rightName } = this.loadedNames;
      const reuseLeft = refresh && !!this.leftRenderer && !changes.has(leftName);
      const reuseRight = refresh && !!this.rightRenderer && !changes.has(rightName);
      const leftDisplay = refresh && !reuseLeft ? this.captureDisplay(this.leftRenderer) : null;
      const rightDisplay = refresh && !reuseRight ? this.captureDisplay(this.rightRenderer) : null;
      if (refresh && this.result) {
        const topPair = this.pairAtOffset(this.scrollTop);
        this.refreshAnchor = {
          start: this.start, span: this.end - this.start, scroll: this.scrollTop,
          signal: this.result.pairs[this.cursorPair]?.name,
          topSignal: this.result.pairs[topPair]?.name, topOffset: this.scrollTop - this.rowOffsets[topPair]
        };
      }
      const anchor = this.refreshAnchor;
      this.scope.log('scope-compare', { phase: 'load-start', source: leftName, target: rightName });
      this.setBusy(true, refresh ? '正在同步比较数据…' : '正在载入比较图并计算公式…');
      this.cursorSequence++;
      this.result = this.cache = this.selectedError = null;
      if (!reuseLeft) this.leftRenderer = null;
      if (!reuseRight) this.rightRenderer = null;
      this.rowOffsets = [];
      this.count.textContent = '';
      this.releaseCanvasBuffers();
      if (!refresh) {
        this.tags = [];
        this.renderTags();
        this.buildPanes();
      }
      const started = performance.now();
      let polling = false;
      const timer = this.progressTimer = setInterval(async () => {
        if (polling || !this.active) return;
        polling = true;
        try {
          const progress = await this.scope.worker.call('compare-progress');
          if (this.active && this.sequence === sequence) this.status.textContent =
            (progress && progress.phase || '正在载入') + (progress && progress.name ? '：' + progress.name : '')
            + (progress && progress.rows ? ' ' + progress.row + '/' + progress.rows : '')
            + ' · ' + ((performance.now() - started) / 1000).toFixed(1) + ' s';
        } catch (_error) { /* closing the scope also closes its worker */ }
        finally { polling = false; }
      }, 250);
      try {
        // Keep only the untouched source, not the old difference table or viewport.
        await Promise.all([
          this.scope.worker.call('compare-close', { keepLeft: reuseLeft, keepRight: reuseRight }),
          this.windowRequest?.catch(() => {})
        ]);
        if (!this.active || sequence !== this.sequence) return;
        const ownSource = this.scope.document.name;
        const documents = new Map();
        const getDocument = name => {
          if (!documents.has(name)) documents.set(name, changes?.get(name) || (name === ownSource
            ? this.scope.getComparisonDocument() : this.scope.adapter.loadComparisonDocument(name)));
          return documents.get(name);
        };
        const [leftDocument, document] = await Promise.all([
          !reuseLeft && (leftName !== ownSource || changes?.get(leftName)) ? getDocument(leftName) : null,
          reuseRight ? null : rightName ? getDocument(rightName) : { content: '{}' }
        ]);
        if (!this.active || sequence !== this.sequence) return;
        const currentContent = !reuseLeft && !leftDocument && this.scope.dataDraftDirty ? await this.scope.buildDraftSourceContent() : null;
        if (!this.active || sequence !== this.sequence) return;
        const result = await this.scope.worker.call('compare-start', { content: document?.content, transient: document?.transientState,
          single: !rightName,
          leftDelays: this.delayOverrides.left.get(leftName),
          rightDelays: this.delayOverrides.right.get(rightName),
          leftDocument, reuseLeft, reuseRight, currentContent,
          currentNames: leftDocument ? null : this.scope.meta.rows.map((row) => this.scope.signalDisplayName(row.index)) });
        if (!this.active || sequence !== this.sequence) return;
        this.result = result;
        this.generation = result.generation;
        this.updatePaneTitles();
        if (!reuseLeft) this.leftRenderer = this.scope.createComparisonRenderer(result.left,
          leftDocument ? leftDocument.display || this.remapDisplay(leftDisplay, result.left)
            : this.scope.comparisonDisplay(),
          leftDocument ? leftDocument.transientState : this.scope.transientFormulaState);
        else this.leftRenderer.meta = result.left;
        if (!reuseRight) this.rightRenderer = this.scope.createComparisonRenderer(result.right,
          document.display || this.remapDisplay(rightDisplay, result.right), document.transientState);
        else this.rightRenderer.meta = result.right;
        const pairNames = new Set(result.pairs.map(pair => pair.name));
        for (const name of this.collapsedPairs) {
          if (!pairNames.has(name)) this.collapsedPairs.delete(name);
        }
        this.rebuildRowOffsets();
        this.selectedError = null;
        if (anchor) {
          const newTop = result.pairs.findIndex(pair => pair.name === anchor.topSignal);
          this.cursorPair = Math.max(0, result.pairs.findIndex(pair => pair.name === anchor.signal));
          this.scrollTop = newTop >= 0
            ? this.rowOffsets[newTop] + Math.min(anchor.topOffset, this.pairHeight(newTop) - 1) : anchor.scroll;
          for (const name of CURSORS) if (this.cursorPositions[name] != null) {
            this.cursorPositions[name] = Math.min(this.cursorPositions[name], this.snapColumn(result.total));
          }
          if (this.rangeSelection) {
            const pair = result.pairs.findIndex(item => item.name === this.rangeSelection.signal);
            const end = Math.min(result.total, this.rangeSelection.end);
            if (pair < 0 || end <= this.rangeSelection.start) this.rangeSelection = null;
            else Object.assign(this.rangeSelection, { pair, end });
          }
          this.syncPaneGeometry();
        } else {
          this.scrollTop = 0;
          this.activeCursor = ''; this.cursorPositions = { A: 0, B: Math.max(0, result.total - 1), C: null };
          this.cursorPair = 0; this.cursorSide = 'left';
          this.readTags();
          this.buildPanes();
        }
        const warnings = result.pairs.filter((pair) => pair.diagnostics.some(Boolean));
        this.setBusy(false, warnings.length ? warnings.map((pair) => pair.name + '：' + pair.diagnostics.filter(Boolean).join('；')).join(' / ')
          : rightName ? '比较完成 · ' + result.pairs.length + ' 对信号 · ' + result.errorCount + ' 处差异'
            : result.pairs.length + ' 个信号 · 可选择比较图 B');
        this.count.textContent = rightName ? (result.errorCount ? result.errorCount + ' 处差异' : '无差异') : '';
        this.setView(anchor?.start ?? 0, anchor?.span ?? result.total);
        if (!refresh) this.panes[0]?.canvas.focus({ preventScroll: true });
        this.refreshAnchor = null;
        this.scope.log('scope-compare', { phase: 'ready', target: rightName, pairs: result.pairs.length,
          errorCount: result.errorCount, totalColumns: result.total, elapsedMs: Math.round(performance.now() - started) });
      } catch (error) {
        if (this.active && sequence === this.sequence) {
          this.result = this.cache = this.leftRenderer = this.rightRenderer = null;
          if (!anchor) this.pendingChanges.clear();
          await this.scope.worker.call('compare-close').catch(() => {});
          if (!this.active || sequence !== this.sequence) return;
          this.setBusy(false, '比较失败：' + error.message);
          this.scope.log('scope-compare', { phase: 'error', target: rightName, message: error.message });
        }
      } finally {
        clearInterval(timer);
        if (this.progressTimer === timer) this.progressTimer = 0;
        this.scheduleRefresh();
      }
    }

    pairDelayLabel(pair, side) {
      const left = this.result.left.rows[pair.left]?.delays;
      const right = this.result.right.rows[pair.right]?.delays;
      if (side !== 'overlay') return this.scope.signalDelayLabel(pair.name, side === 'left' ? left : right);
      if ((left?.offset || 0) === (right?.offset || 0)) return this.scope.signalDelayLabel(pair.name, left);
      const sides = [['A', left], ['B', right]].filter(([, delay]) => delay?.offset)
        .map(([label, delay]) => label + ' ' + (delay.offset > 0 ? '+' : '') + delay.offset);
      return pair.name + ' (' + sides.join(', ') + ')';
    }

    openDelayCard(pair, side, x, y) {
      if (pair.left < 0 && pair.right < 0) return;
      if (side !== 'overlay' && pair[side] < 0) return;
      this.delayPair = pair;
      const chooseSide = side === 'overlay';
      this.delaySide.closest('label').hidden = !chooseSide || pair.left < 0 || pair.right < 0;
      this.delaySide.value = !chooseSide ? side
        : pair[this.cursorSide] >= 0 ? this.cursorSide : pair.left >= 0 ? 'left' : 'right';
      this.fillDelayCard();
      this.delayCard.hidden = false;
      const rect = this.delayCard.getBoundingClientRect();
      this.delayCard.style.left = Math.max(8, Math.min(x, this.popup.innerWidth - rect.width - 8)) + 'px';
      this.delayCard.style.top = Math.max(8, Math.min(y + 10, this.popup.innerHeight - rect.height - 8)) + 'px';
    }

    fillDelayCard() {
      const side = this.delaySide.value;
      const row = this.result?.[side].rows[this.delayPair?.[side]];
      if (!row) return;
      this.delayCard.querySelector('strong').textContent = (side === 'left' ? 'A · ' : 'B · ') + this.delayPair.name;
      for (const key of ['commDly', 'dly']) this.delayCard.elements[key].value = String(row.delays?.[key] || 0);
    }

    closeDelayCard() {
      if (this.delayCard) this.delayCard.hidden = true;
      this.delayPair = null;
    }

    async applyPairDelay() {
      if (this.busy || !this.delayPair || !this.delayCard.reportValidity()) return;
      const side = this.delaySide.value;
      const row = this.result[side].rows[this.delayPair[side]];
      if (!row) return;
      const delay = Object.fromEntries(['commDly', 'dly'].map(key => [key, Number(this.delayCard.elements[key].value) || 0]));
      this.closeDelayCard();
      if (delay.commDly === row.delays.commDly && delay.dly === row.delays.dly) return;
      const name = this.loadedNames[side];
      const overrides = { ...this.delayOverrides[side].get(name), [row.rowId]: delay };
      if (delay.commDly !== row.delays.commDly) {
        this.result[side].rows.forEach((member) => {
          if (member !== row && member.arrayGroup?.index !== -1) {
            overrides[member.rowId] = { commDly: delay.commDly, dly: member.delays.dly };
          }
        });
      }
      this.delayOverrides[side].set(name, overrides);
      await this.load(new Map());
    }

    captureDisplay(renderer) {
      if (!renderer) return null;
      const rows = new Map();
      renderer.meta.rows.forEach(row => {
        const key = row.sourceName || row.name;
        if (!rows.has(key)) rows.set(key, { entries: [], next: 0 });
        rows.get(key).entries.push({
          modes: renderer.modes[row.index], busFormats: renderer.busFormats[row.index],
          analogFormats: renderer.analogFormats[row.index], rowStyles: renderer.rowStyles[row.index],
          rowHeights: renderer.rowHeights[row.index]
        });
      });
      return rows;
    }

    remapDisplay(rows, meta) {
      if (!rows) return null;
      const display = { modes: {}, busFormats: {}, analogFormats: {}, rowStyles: {}, rowHeights: {} };
      meta.rows.forEach(row => {
        const queue = rows.get(row.sourceName || row.name);
        const entry = queue && queue.entries[queue.next++];
        if (entry) Object.keys(display).forEach(key => { display[key][row.index] = entry[key]; });
      });
      return display;
    }

    rebuildRowOffsets() {
      this.rowOffsets = [0];
      this.collapsedRuns = new Map();
      this.overlayLastPair = -1;
      if (this.layout === 'overlay' && this.loadedNames.right) {
        for (let index = this.result.pairs.length - 1; index >= 0; index--) {
          if (this.filteredPairs.has(this.result.pairs[index].name)) continue;
          this.overlayLastPair = index;
          break;
        }
      }
      let runStart = -1;
      this.result.pairs.forEach((pair, index) => {
        if (this.filteredPairs.has(pair.name)) {
          runStart = -1;
          this.rowOffsets.push(this.rowOffsets.at(-1));
          return;
        }
        const collapsed = this.collapsedPairs.has(pair.name);
        let height;
        if (collapsed) {
          height = runStart < 0 ? COLLAPSED_ROW_HEIGHT : 0;
          if (runStart < 0) runStart = index;
          this.collapsedRuns.set(runStart, index + 1);
        } else {
          runStart = -1;
          height = this.signalRowHeight ?? Math.max(
            pair.left < 0 ? 0 : this.leftRenderer.rowHeight(pair.left),
            pair.right < 0 ? 0 : this.rightRenderer.rowHeight(pair.right));
          if (height) height += this.pairGap(index);
        }
        this.rowOffsets.push(this.rowOffsets.at(-1) + height);
      });
    }

    updateExpandAllControl() {
      this.root.querySelector('[data-action="expand-all"]').disabled =
        this.busy || !this.result || !this.collapsedPairs.size;
    }

    applySignalFilter(ids) {
      if (!this.result || this.busy) return;
      if (ids.size === this.filteredPairs.size && [...ids].every(id => this.filteredPairs.has(id))) return;
      this.filteredPairs = ids;
      this.root.querySelector('[data-action="filter-signals"]').classList.toggle('is-filtered', ids.size > 0);
      this.cache = null;
      this.drawnView = null;
      if (ids.has(this.rangeSelection?.signal)) this.rangeSelection = null;
      if (ids.has(this.result.pairs[this.cursorPair]?.name)) {
        this.cursorPair = this.result.pairs.findIndex(pair => !ids.has(pair.name));
      }
      this.cursorSequence++;
      this.refreshCollapsedLayout();
    }

    refreshCollapsedLayout() {
      const top = this.pairAtOffset(this.scrollTop);
      const offset = this.scrollTop - this.rowOffsets[top];
      this.rebuildRowOffsets();
      if (top < this.result.pairs.length) {
        this.scrollTop = this.rowOffsets[top] + (this.pairHeight(top) ? Math.min(offset, this.pairHeight(top) - 1) : 0);
      }
      this.syncPaneGeometry();
      this.updateExpandAllControl();
      this.updateCursorControls();
      this.schedule();
    }

    togglePairCollapsed(index, pane) {
      const pair = this.result?.pairs[index];
      if (!pair || this.busy || this.filteredPairs.has(pair.name)) return;
      if (!this.collapsedPairs.delete(pair.name)) {
        this.collapsedPairs.add(pair.name);
        if (this.rangeSelection?.pair === index) this.rangeSelection = null;
      }
      if (pane) pane.focusPairToggle = index;
      this.refreshCollapsedLayout();
    }

    createPairToggle(doc, index, collapsed) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.dataset.pair = String(index);
      button.title = (collapsed ? '展开信号：' : '收起信号：') + this.result.pairs[index].name;
      button.setAttribute('aria-label', button.title);
      button.setAttribute('aria-expanded', String(!collapsed));
      button.innerHTML = icon(collapsed ? 'plus' : 'minus');
      return button;
    }

    drawRowControls(pane, view, height, nameWidth) {
      const visible = new Set();
      const width = nameWidth + 'px';
      if (pane.rowControls.style.width !== width) pane.rowControls.style.width = width;
      for (let index = view.rowStart; index < view.rowEnd; index += 1) {
        const y = this.rowOffsets[index] - view.scrollTop;
        const rowHeight = this.pairContentHeight(index);
        if (!rowHeight || y + rowHeight <= 0 || y >= height) continue;
        visible.add(index);
        const runEnd = this.collapsedRuns.get(index);
        let entry = pane.rowButtons.get(index);
        if (!entry || entry.runEnd !== runEnd) {
          const doc = pane.rowControls.ownerDocument;
          let element;
          if (runEnd != null) {
            element = doc.createElement('div');
            element.className = 'scope-compare-collapsed-run';
            element.setAttribute('role', 'group');
            element.setAttribute('aria-label', '连续收起的 ' + (runEnd - index) + ' 个信号');
            for (let row = index; row < runEnd; row += 1) {
              element.appendChild(this.createPairToggle(doc, row, true));
            }
          } else {
            element = doc.createElement('div');
            element.className = 'scope-compare-expanded-row';
            const handle = doc.createElement('span');
            handle.className = 'scope-compare-row-resize';
            handle.dataset.resizePair = String(index);
            handle.tabIndex = 0;
            handle.title = '拖动调整所有信号行高';
            handle.setAttribute('role', 'separator');
            handle.setAttribute('aria-label', handle.title);
            handle.setAttribute('aria-orientation', 'horizontal');
            handle.setAttribute('aria-valuemin', String(MIN_ROW_HEIGHT));
            handle.setAttribute('aria-valuemax', String(MAX_ROW_HEIGHT));
            element.append(this.createPairToggle(doc, index, false), handle);
          }
          if (entry) entry.element.replaceWith(element);
          else pane.rowControls.appendChild(element);
          entry = { element, runEnd };
          pane.rowButtons.set(index, entry);
        }
        const top = y + 'px';
        if (entry.element.style.top !== top) entry.element.style.top = top;
        if (runEnd == null) {
          const height = rowHeight + 'px';
          if (entry.element.style.height !== height) {
            entry.element.style.height = height;
            entry.element.lastElementChild.setAttribute('aria-valuenow', String(rowHeight));
          }
        }
      }
      for (const [index, entry] of pane.rowButtons) {
        if (visible.has(index)) continue;
        entry.element.remove();
        pane.rowButtons.delete(index);
      }
      if (pane.focusPairToggle != null) {
        const button = pane.rowControls.querySelector('button[data-pair="' + pane.focusPairToggle + '"]');
        if (button) {
          button.focus({ preventScroll: true });
          const run = button.closest('.scope-compare-collapsed-run');
          if (run && button.offsetLeft + button.offsetWidth > run.scrollLeft + run.clientWidth) {
            run.scrollLeft = button.offsetLeft + button.offsetWidth - run.clientWidth;
          }
        }
        pane.focusPairToggle = null;
      }
    }

    pairHeight(index) { return this.rowOffsets[index + 1] - this.rowOffsets[index]; }

    pairGap(index) {
      const pair = this.result?.pairs[index];
      return pair && index < this.overlayLastPair && !this.filteredPairs.has(pair.name)
        && !this.collapsedPairs.has(pair.name) ? OVERLAY_PAIR_GAP : 0;
    }

    pairContentHeight(index) { return Math.max(0, this.pairHeight(index) - this.pairGap(index)); }

    resizeSignalRows(height) {
      height = Math.max(MIN_ROW_HEIGHT, Math.min(MAX_ROW_HEIGHT, Math.round(height)));
      if (!this.result || this.busy || height === this.signalRowHeight) return;
      const top = this.pairAtOffset(this.scrollTop);
      const offset = this.scrollTop - (this.rowOffsets[top] ?? 0);
      this.signalRowHeight = height;
      this.rebuildRowOffsets();
      if (top < this.result.pairs.length) {
        this.scrollTop = this.rowOffsets[top] + Math.min(offset, Math.max(0, this.pairHeight(top) - 1));
      }
      this.syncPaneGeometry();
      this.schedule();
    }

    bindRowResize(controls) {
      controls.addEventListener('pointerdown', event => {
        const handle = event.target.closest('[data-resize-pair]');
        if (!handle || event.button !== 0 || this.busy || !this.result || this.rowResize) return;
        event.preventDefault();
        controls.setPointerCapture(event.pointerId);
        this.rowResize = {
          controls, id: event.pointerId, y: event.clientY,
          height: this.pairContentHeight(Number(handle.dataset.resizePair))
        };
        controls.classList.add('is-resizing');
      });
      controls.addEventListener('pointermove', event => {
        const drag = this.rowResize;
        if (!drag || drag.controls !== controls || drag.id !== event.pointerId) return;
        this.pendingRowHeight = drag.height + event.clientY - drag.y;
        this.schedule();
      });
      const finish = event => {
        const drag = this.rowResize;
        if (!drag || drag.controls !== controls || drag.id !== event.pointerId) return;
        this.rowResize = null;
        controls.classList.remove('is-resizing');
        if (controls.hasPointerCapture(event.pointerId)) controls.releasePointerCapture(event.pointerId);
      };
      controls.addEventListener('pointerup', finish);
      controls.addEventListener('pointercancel', finish);
      controls.addEventListener('lostpointercapture', finish);
      controls.addEventListener('keydown', event => {
        const handle = event.target.closest('[data-resize-pair]');
        if (!handle || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        this.resizeSignalRows(this.pairContentHeight(Number(handle.dataset.resizePair)) + (event.key === 'ArrowDown' ? 4 : -4));
      });
    }

    pairAtOffset(offset) {
      let lo = 0, hi = this.result.pairs.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (this.rowOffsets[mid + 1] <= offset) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    }

    syncPaneGeometry() {
      const total = this.rowOffsets.at(-1);
      this.panes.forEach(pane => { pane.spacer.style.height = total + 'px'; });
      const height = Math.max(...this.panes.map(pane => pane.viewport.clientHeight));
      this.scrollTop = Math.max(0, Math.min(this.scrollTop, total - height));
      this.panes.forEach(pane => { pane.viewport.scrollTop = this.scrollTop; });
    }

    fitCursors() {
      if (!this.result || this.busy) return;
      const { A, B } = this.cursorPositions;
      if (A == null || B == null) return;
      const span = Math.max(1, Math.abs(B - A));
      this.setView((A + B - span) / 2, span);
    }

    fitSelection() {
      if (!this.result || this.busy) return;
      const range = this.rangeSelection;
      clearTimeout(this.selectionHintTimer);
      if (!range || range.end <= range.start) {
        const previous = this.status.textContent;
        const message = '请选中一段波形';
        this.status.textContent = message;
        this.selectionHintTimer = setTimeout(() => {
          if (this.active && this.status.textContent === message) this.status.textContent = previous === message ? '' : previous;
        }, 1000);
        return;
      }
      this.setView(range.start, range.end - range.start);
    }

    updatePan() {
      const total = this.result?.total || 1;
      const span = this.result ? this.end - this.start : total;
      const max = Math.max(0, total - span);
      const enabled = !this.busy && max > 1e-9;
      this.panThumb.style.width = Math.min(100, span / total * 100) + '%';
      this.panThumb.style.left = Math.min(max, this.start) / total * 100 + '%';
      this.panThumb.tabIndex = enabled ? 0 : -1;
      this.panThumb.setAttribute('aria-disabled', String(!enabled));
      this.panThumb.setAttribute('aria-valuemax', String(Number(max.toFixed(6))));
      this.panThumb.setAttribute('aria-valuenow', String(Number(Math.min(max, this.start).toFixed(6))));
    }

    bindPan() {
      const pan = this.pan, thumb = this.panThumb;
      let drag = null;
      const move = (event) => {
        if (drag?.id !== event.pointerId || drag.generation !== this.generation || this.busy || !this.result) return;
        const start = (event.clientX - drag.left) * drag.scale - drag.offset;
        this.setView(start, this.end - this.start);
      };
      pan.addEventListener('pointerdown', event => {
        if (event.button !== 0 || thumb.tabIndex < 0) return;
        event.preventDefault();
        const rect = pan.getBoundingClientRect();
        const span = this.end - this.start;
        const scale = this.result.total / Math.max(1, rect.width);
        const column = (event.clientX - rect.left) * scale;
        const offset = event.target === thumb ? Math.max(0, Math.min(span, column - this.start)) : span / 2;
        drag = { id: event.pointerId, offset, left: rect.left, scale, generation: this.generation };
        thumb.focus({ preventScroll: true });
        pan.setPointerCapture(event.pointerId);
        pan.classList.add('dragging');
        move(event);
      });
      pan.addEventListener('pointermove', move);
      pan.addEventListener('lostpointercapture', () => { drag = null; pan.classList.remove('dragging'); });
      thumb.addEventListener('keydown', event => {
        if (thumb.tabIndex < 0) return;
        const span = this.end - this.start;
        const key = event.key;
        const step = Math.max(0.5, span / 20);
        const target = { ArrowLeft: this.start - step, ArrowRight: this.start + step,
          PageUp: this.start - span, PageDown: this.start + span, Home: 0, End: this.result.total }[key];
        if (target === undefined) return;
        event.preventDefault(); event.stopPropagation();
        this.setView(target, span);
      });
    }

    releaseCanvasBuffers() {
      this.drawnView = null;
      this.rowResize = null;
      this.pendingRowHeight = null;
      this.panes?.forEach(pane => {
        pane.canvas.width = pane.canvas.height = pane.cursorCanvas.width = pane.cursorCanvas.height = 0;
        pane.drag = pane.rangeDrag = pane.cursorDrag = null;
        pane.rowControls.replaceChildren();
        pane.rowControls.classList.remove('is-resizing');
        pane.rowButtons.clear();
      });
    }

    buildPanes() {
      const document = this.panesRoot.ownerDocument;
      this.releaseCanvasBuffers();
      this.panesRoot.replaceChildren();
      this.panes = [];
      const single = !this.selects.right.value;
      this.panesRoot.dataset.layout = single ? 'single' : this.layout;
      (single ? ['left'] : this.layout === 'overlay' ? ['overlay'] : ['left', 'right']).forEach((side) => {
        const pane = document.createElement('section');
        pane.className = 'scope-compare-pane';
        const heading = document.createElement('header');
        (single || side === 'overlay' ? SIDES : [side]).forEach((source) => {
          const label = document.createElement('span');
          label.style.color = COLORS[source === 'left' ? 0 : 1];
          label.textContent = source === 'left' ? 'A' : 'B';
          heading.append(label, this.selects[source]);
        });
        const body = document.createElement('div');
        body.className = 'scope-compare-canvas-wrap';
        const viewport = document.createElement('div');
        viewport.className = 'scope-compare-scroll';
        const spacer = document.createElement('div');
        spacer.style.height = (this.result ? this.rowOffsets.at(-1) : 0) + 'px';
        viewport.appendChild(spacer);
        const canvas = document.createElement('canvas');
        canvas.tabIndex = 0;
        const cursorCanvas = document.createElement('canvas');
        cursorCanvas.className = 'scope-compare-cursor-layer';
        cursorCanvas.setAttribute('aria-hidden', 'true');
        canvas.setAttribute('aria-label', side === 'overlay' ? 'A 与 B 重叠波形'
          : (side === 'left' ? 'A 波形' : 'B 波形'));
        canvas.setAttribute('role', 'img');
        const rowControls = document.createElement('div');
        rowControls.className = 'scope-compare-row-controls';
        this.bindRowResize(rowControls);
        rowControls.addEventListener('click', (event) => {
          const control = event.target.closest('button[data-pair]');
          if (control) this.togglePairCollapsed(Number(control.dataset.pair), item);
        });
        body.append(viewport, canvas, cursorCanvas, rowControls);
        pane.append(heading, body);
        this.panesRoot.appendChild(pane);
        const item = { side, viewport, spacer, canvas, cursorCanvas, rowControls, rowButtons: new Map() };
        if (!single && this.layout === 'horizontal') {
          const names = this.root.ownerDocument.createElement('div');
          names.className = 'scope-compare-name-header';
          const label = this.root.ownerDocument.createElement('span');
          label.textContent = '信号 / cycle';
          const toggle = this.root.ownerDocument.createElement('button');
          toggle.type = 'button';
          const update = () => {
            const hidden = this.namesHidden[side];
            const title = (hidden ? '显示' : '隐藏') + (side === 'left' ? ' A ' : ' B ') + '信号名';
            toggle.title = title;
            toggle.setAttribute('aria-label', title);
            toggle.setAttribute('aria-expanded', String(!hidden));
            toggle.innerHTML = icon(hidden ? 'next' : 'prev');
            names.classList.toggle('is-hidden', hidden);
            label.hidden = hidden;
            rowControls.hidden = hidden;
          };
          toggle.addEventListener('click', () => {
            this.namesHidden[side] = !this.namesHidden[side];
            update();
            this.schedule();
          });
          names.append(label, toggle);
          body.append(names);
          item.namesHeader = names;
          update();
        }
        this.panes.push(item);
        viewport.scrollTop = this.scrollTop;
        viewport.addEventListener('scroll', () => {
          if (!this.panes.includes(item)) return;
          const limit = Math.min(...this.panes.map(pane => pane.viewport.scrollHeight - pane.viewport.clientHeight));
          const next = Math.min(viewport.scrollTop, limit);
          const changed = next !== this.scrollTop;
          this.scrollTop = next;
          this.panes.forEach(other => { if (other.viewport.scrollTop !== this.scrollTop) other.viewport.scrollTop = this.scrollTop; });
          if (changed) this.schedule();
        });
        body.addEventListener('wheel', (event) => {
          event.preventDefault();
          if (event.ctrlKey || event.metaKey) {
            const rect = canvas.getBoundingClientRect();
            const names = this.nameWidth(item);
            const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left - names) / Math.max(1, rect.width - names)));
            const old = this.end - this.start;
            const span = old * Math.exp(Math.max(-1, Math.min(1, event.deltaY / 400)));
            this.setView(this.start + ratio * (old - span), span);
          } else if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
            const run = event.target.closest('.scope-compare-collapsed-run');
            if (run && run.scrollWidth > run.clientWidth) {
              run.scrollLeft += event.deltaX || event.deltaY;
              return;
            }
            this.setView(this.start + (event.deltaX || event.deltaY) * (this.end - this.start) / Math.max(1, canvas.clientWidth), this.end - this.start);
          } else viewport.scrollTop += event.deltaY * 0.5;
        }, { passive: false });
        canvas.addEventListener('click', (event) => {
          if (performance.now() < (item.suppressClickUntil || 0)) return;
          void this.selectAt(event, item);
        });
        canvas.addEventListener('pointerdown', (event) => {
          const touch = event.pointerType === 'touch';
          if (this.result && !this.busy && (event.button === 0 || event.button === 1)) {
            canvas.focus({ preventScroll: true });
          }
          if (event.button === 0 && this.startCursorDrag(event, item)) return;
          if (event.button === 0 && !touch && !this.activeCursor && this.startRangeDrag(event, item)) return;
          if (event.button !== 1 && !touch) return;
          event.preventDefault();
          canvas.setPointerCapture(event.pointerId);
          item.drag = { x: event.clientX, y: event.clientY, start: this.start, scrollTop: viewport.scrollTop, touch, moved: false };
        });
        canvas.addEventListener('pointermove', (event) => {
          if (item.cursorDrag) { this.moveCursorDrag(event, item); return; }
          if (item.rangeDrag) { this.moveRangeDrag(event, item); return; }
          if (!item.drag) return;
          const dx = event.clientX - item.drag.x;
          const dy = event.clientY - item.drag.y;
          if (Math.abs(dx) + Math.abs(dy) > 5) item.drag.moved = true;
          if (!item.drag.moved) return;
          if (item.drag.touch && Math.abs(dy) >= Math.abs(dx)) viewport.scrollTop = item.drag.scrollTop - dy;
          else this.setView(item.drag.start - dx * (this.end - this.start) / Math.max(1, canvas.clientWidth - this.nameWidth(item)), this.end - this.start);
        });
        canvas.addEventListener('pointerup', (event) => {
          if (item.cursorDrag) { this.finishCursorDrag(event, item); return; }
          if (item.rangeDrag) { this.finishRangeDrag(event, item); return; }
          const drag = item.drag;
          item.drag = null;
          if (drag && drag.moved) item.suppressClickUntil = performance.now() + 400;
          else if (drag && drag.touch) {
            item.suppressClickUntil = performance.now() + 400;
            void this.selectAt(event, item);
          }
        });
        canvas.addEventListener('pointercancel', (event) => {
          if (item.rangeDrag) this.finishRangeDrag(event, item, true);
          item.drag = item.cursorDrag = null;
        });
      });
      if (this.result) {
        this.syncPaneGeometry();
        const view = this.viewport();
        if (this.covers(this.cache?.view, view, false)) this.draw(view);
      }
      this.schedule();
    }

    nameWidth(pane = this.panes[0]) {
      if (pane?.namesHeader && this.namesHidden[pane.side]) return 0;
      return Math.min(NAME_WIDTH, Math.max(pane?.namesHeader ? 105 : 85, (pane?.canvas.clientWidth || 600) * 0.26));
    }

    setView(start, span) {
      if (!this.result) return;
      if (!Number.isFinite(span) || !Number.isFinite(start)) return;
      span = Math.max(0.5, Math.min(this.result.total, span));
      const nextStart = Math.max(0, Math.min(this.result.total - span, start));
      const nextEnd = nextStart + span;
      const changed = this.start !== nextStart || this.end !== nextEnd;
      this.start = nextStart;
      this.end = nextEnd;
      this.startInput.value = Number(this.start.toFixed(3));
      this.spanInput.value = Number(span.toFixed(3));
      this.startInput.max = Math.max(0, this.result.total - 0.5);
      this.spanInput.max = this.result.total;
      this.updatePan();
      if (changed || this.drawnView?.start !== nextStart || this.drawnView?.end !== nextEnd) this.schedule();
    }

    schedule() {
      if (!this.active || !this.result) return;
      if (this.frame) return;
      this.frame = this.popup.requestAnimationFrame(() => {
        if (this.pendingRowHeight != null) {
          const height = this.pendingRowHeight;
          this.pendingRowHeight = null;
          this.resizeSignalRows(height);
        }
        this.frame = 0;
        void this.render();
      });
    }

    viewport() {
      const width = Math.max(32, ...this.panes.map(pane => pane.canvas.clientWidth - this.nameWidth(pane)));
      const height = Math.max(...this.panes.map((pane) => pane.canvas.clientHeight));
      const rowStart = this.pairAtOffset(this.scrollTop);
      const rowEnd = Math.min(this.result.pairs.length, this.pairAtOffset(this.scrollTop + Math.max(0, height - AXIS_HEIGHT)) + 1);
      return { start: this.start, end: this.end, rowStart, rowEnd, width, scrollTop: this.scrollTop, generation: this.generation };
    }

    covers(coverage, view, precise = true) {
      if (!coverage || coverage.generation !== view.generation || coverage.start > view.start + 1e-9
          || coverage.end < view.end - 1e-9 || coverage.rowStart > view.rowStart || coverage.rowEnd < view.rowEnd) return false;
      if (coverage.filteredPairs !== this.filteredPairs) return false;
      if (!precise) return true;
      if (coverage.collapsedPairs?.size) {
        for (let index = view.rowStart; index < view.rowEnd; index += 1) {
          const name = this.result.pairs[index].name;
          if (!this.collapsedPairs.has(name) && coverage.collapsedPairs.has(name)) return false;
        }
      }
      const density = view.width / (view.end - view.start);
      return Math.abs(coverage.density - density) <= density * 0.05;
    }

    canPreview(coverage, view) {
      if (!this.covers(coverage, view, false)) return false;
      const ratio = coverage.density * (view.end - view.start) / view.width;
      return ratio >= 0.5 && ratio <= 2;
    }

    async render() {
      if (!this.active || !this.result || !this.panes.length) return;
      const viewport = this.viewport();
      if (this.covers(this.cache?.view, viewport)) { this.draw(viewport); return; }
      if (this.canPreview(this.cache?.view, viewport)) this.draw(viewport);
      if (this.rendering) {
        this.renderQueued = true;
        const loading = this.loadingView;
        if (loading?.generation === viewport.generation && !loading.cancelled
            && !this.canPreview(loading, viewport)) {
          loading.cancelled = true;
          void this.scope.worker.call('compare-cancel-window', {
            generation: loading.generation, token: loading.windowToken
          }).catch(() => {});
        }
        return;
      }
      this.rendering = true;
      const { generation } = viewport;
      const span = viewport.end - viewport.start;
      const density = viewport.width / span;
      const start = Math.max(0, viewport.start - span / 2);
      const end = Math.min(this.result.total, viewport.end + span / 2);
      const margin = Math.min(8, Math.max(2, Math.ceil((viewport.rowEnd - viewport.rowStart) / 3)));
      const left = this.leftRenderer, right = this.rightRenderer;
      const view = { start, end, rowStart: Math.max(0, viewport.rowStart - margin),
        rowEnd: Math.min(this.result.pairs.length, viewport.rowEnd + margin),
        generation, density, width: Math.min(8192, Math.ceil((end - start) * density)),
        windowToken: (this.windowToken = (this.windowToken || 0) + 1),
        collapsedPairs: new Set(this.collapsedPairs),
        filteredPairs: this.filteredPairs,
        leftModes: left.modes, leftBusFormats: left.busFormats, leftAnalogFormats: left.analogFormats,
        rightModes: right.modes, rightBusFormats: right.busFormats, rightAnalogFormats: right.analogFormats };
      this.loadingView = view;
      const request = this.windowRequest = this.scope.worker.call('compare-window', view);
      let paintedCurrent = false;
      try {
        const data = await request;
        if (!view.cancelled && !data.cancelled && this.active && this.result && generation === this.generation
            && view.filteredPairs === this.filteredPairs) {
          const current = this.viewport();
          const exact = this.covers(view, current);
          if (!exact && (!this.canPreview(view, current) || this.covers(this.cache?.view, current))) return;
          const errors = new Map();
          data.errors.forEach(error => {
            if (!errors.has(error.pair)) errors.set(error.pair, []);
            errors.get(error.pair).push(error);
          });
          this.cache = { view, errors,
            left: new Map(data.left.rows.map(row => [row.index, row])),
            right: new Map(data.right.rows.map(row => [row.index, row])) };
          this.draw(current);
          paintedCurrent = exact;
        }
      } catch (error) { if (this.active && !this.busy && generation === this.generation) this.status.textContent = error.message; }
      finally {
        this.windowRequest = null;
        this.loadingView = null;
        this.rendering = false;
        if (this.renderQueued) {
          this.renderQueued = false;
          if (!paintedCurrent) this.schedule();
        }
      }
    }

    draw(view = this.drawnView) {
      if (!this.cache || this.cache.view.generation !== this.generation) return;
      view = view || this.viewport();
      this.drawnView = view;
      const { errors } = this.cache;
      const scrollTop = view.scrollTop;
      const renderers = { left: this.leftRenderer, right: this.rightRenderer };
      SIDES.forEach(side => {
        renderers[side].viewStart = view.start;
        renderers[side].viewEnd = view.end;
      });
      for (const pane of this.panes) {
        const nameWidth = this.nameWidth(pane);
        const width = pane.canvas.clientWidth;
        const height = pane.canvas.clientHeight;
        const dpr = Math.min(2, this.popup.devicePixelRatio || 1);
        const pixelWidth = Math.max(1, Math.round(width * dpr));
        const pixelHeight = Math.max(1, Math.round(height * dpr));
        if (pane.canvas.width !== pixelWidth) pane.canvas.width = pixelWidth;
        if (pane.canvas.height !== pixelHeight) pane.canvas.height = pixelHeight;
        const ctx = pane.canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const plotWidth = Math.max(1, width - nameWidth);
        const plotHeight = Math.max(0, height - AXIS_HEIGHT);
        const overlay = pane.side === 'overlay';
        const sides = overlay ? SIDES : [pane.side];
        const renderer = renderers[sides[0]];
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
        ctx.save(); ctx.translate(nameWidth, 0);
        ctx.beginPath(); ctx.rect(0, 0, plotWidth, height); ctx.clip();
        renderer.drawTimeAxis(ctx, plotWidth, AXIS_HEIGHT);
        ctx.translate(0, AXIS_HEIGHT);
        ctx.beginPath(); ctx.rect(0, 0, plotWidth, plotHeight); ctx.clip();
        if (!overlay) for (let index = view.rowStart; index < view.rowEnd; index += 1) {
          const pair = this.result.pairs[index];
          if (!this.pairHeight(index) || this.collapsedPairs.has(pair.name)) continue;
          const row = pair[pane.side];
          if (row >= 0) renderer.drawRowBackground(ctx, row, this.rowOffsets[index] - scrollTop, this.pairHeight(index), plotWidth);
        }
        renderer.drawGridLines(ctx, plotWidth, plotHeight);
        for (let index = view.rowStart; index < view.rowEnd; index += 1) {
          const pair = this.result.pairs[index];
          const y = this.rowOffsets[index] - scrollTop;
          const rowHeight = this.pairContentHeight(index);
          if (!rowHeight) continue;
          ctx.strokeStyle = '#dfe2e6'; ctx.beginPath(); ctx.moveTo(0, y + rowHeight - 0.5); ctx.lineTo(plotWidth, y + rowHeight - 0.5); ctx.stroke();
          if (this.collapsedPairs.has(pair.name)) continue;
          for (const error of errors.get(index) || []) {
            if (error.end <= view.start) continue;
            if (error.start >= view.end) break;
            const left = Math.max(0, renderer.xForColumn(error.start, plotWidth));
            const right = Math.min(plotWidth, renderer.xForColumn(error.end, plotWidth));
            if (right <= left) continue;
            const selected = this.selectedError;
            const active = selected?.pair === index && selected.start < error.end && selected.end > error.start;
            ctx.fillStyle = active ? 'rgba(189, 38, 56, 0.18)' : 'rgba(189, 38, 56, 0.12)';
            ctx.fillRect(left, y + 1, right - left, rowHeight - 3);
            ctx.strokeStyle = '#bd2638';
            ctx.lineWidth = active ? 2 : 1;
            ctx.strokeRect(left + 0.5, y + 1, Math.max(0.5, right - left - 1), rowHeight - 3);
          }
          ctx.lineWidth = 1;
          sides.forEach((side, layer) => {
            const row = this.cache[side].get(pair[side]);
            if (!row) return;
            const source = renderers[side];
            const naturalHeight = overlay ? rowHeight / 2 : this.signalRowHeight ?? source.rowHeight(row.index);
            const top = y + (overlay ? layer * naturalHeight : (rowHeight - naturalHeight) / 2);
            const padding = overlay ? 0 : 3;
            ctx.save(); ctx.beginPath();
            ctx.rect(0, overlay ? top : y, plotWidth, overlay ? naturalHeight : rowHeight - 1); ctx.clip();
            source.drawSegments(ctx, row, row.index, top + padding, top + naturalHeight - padding, plotWidth,
              overlay ? COLORS[layer] : source.rowWaveColor(row.index), overlay);
            ctx.restore();
          });
        }
        ctx.restore();
        ctx.fillStyle = '#f0f2f5'; ctx.fillRect(0, 0, nameWidth, AXIS_HEIGHT);
        ctx.font = '12px "Segoe UI", "Microsoft YaHei", sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        if (!pane.namesHeader) {
          ctx.fillStyle = '#42505d'; ctx.fillText('信号 / cycle', 8, AXIS_HEIGHT / 2);
        }
        ctx.save(); ctx.beginPath(); ctx.rect(0, AXIS_HEIGHT, nameWidth, plotHeight); ctx.clip();
        for (let index = view.rowStart; nameWidth && index < view.rowEnd; index += 1) {
          const pair = this.result.pairs[index], y = AXIS_HEIGHT + this.rowOffsets[index] - scrollTop;
          const h = this.pairContentHeight(index);
          if (!h) continue;
          const collapsed = this.collapsedPairs.has(pair.name);
          ctx.fillStyle = collapsed ? '#edf0f3' : '#f7f8fa'; ctx.fillRect(0, y, nameWidth, h - 1);
          if (collapsed) continue;
          ctx.fillStyle = '#25313e';
          const showStatus = this.loadedNames.right;
          ctx.fillText(this.pairDelayLabel(pair, pane.side), ROW_NAME_X, y + h / 2 - (showStatus ? 6 : 0), nameWidth - ROW_NAME_X - 8);
          if (!showStatus) continue;
          const missing = pair.left < 0 ? 'A 缺少信号' : pair.right < 0 ? 'B 缺少信号' : '';
          ctx.fillStyle = '#626b75';
          ctx.fillText(missing || (pair.errorCount ? pair.errorCount + ' 处差异' : '一致'), ROW_NAME_X, y + h / 2 + 8);
        }
        ctx.restore();
        if (nameWidth) this.drawRowControls(pane, view, plotHeight, nameWidth);
      }
      this.drawCursorOverlays();
    }

    async selectAt(event, pane) {
      if (!this.drawnView || this.drawnView.generation !== this.generation || this.busy) return;
      const rect = pane.canvas.getBoundingClientRect();
      if (event.clientY - rect.top < AXIS_HEIGHT) return;
      const y = event.clientY - rect.top - AXIS_HEIGHT + this.drawnView.scrollTop;
      const row = this.pairAtOffset(y);
      const pair = this.result.pairs[row];
      const inNameColumn = event.clientX - rect.left < this.nameWidth(pane);
      if (!pair || y - this.rowOffsets[row] >= this.pairContentHeight(row)
          || (!inNameColumn && this.collapsedPairs.has(pair.name))) return;
      const column = this.columnAt(event, pane);
      this.cursorPair = row;
      if (pane.side !== 'overlay') this.cursorSide = pane.side;
      else if (!inNameColumn) this.cursorSide = this.overlaySideAt(event, pane, row);
      if (inNameColumn) {
        this.cursorSequence++;
        this.updateCursorControls();
        this.openDelayCard(pair, pane.side, event.clientX, event.clientY);
        return;
      }
      if (!this.activeCursor) this.rangeSelection = null;
      this.moveCursor(this.activeCursor || 'C', column);
      const generation = this.generation;
      const error = await this.scope.worker.call('compare-inspect', { generation, pair: row, column });
      if (this.active && !this.busy && generation === this.generation && error) this.chooseError(error, false);
    }

    columnAt(event, pane) {
      const rect = pane.canvas.getBoundingClientRect();
      const { start, end } = this.drawnView;
      const names = this.nameWidth(pane);
      return start + (event.clientX - rect.left - names)
        / Math.max(1, rect.width - names) * (end - start);
    }

    snapColumn(column) {
      return Math.max(0, Math.min(Math.round(column * 2) / 2, Math.ceil(this.result.total * 2) / 2 - 0.5));
    }

    selectCursor(name) {
      if (!this.result || this.busy) return;
      this.cursorSequence++;
      this.activeCursor = name === 'C' || name === this.activeCursor ? '' : name;
      if (name === 'C' && this.cursorPositions.C == null) this.cursorPositions.C = this.snapColumn(this.start);
      this.updateCursorControls();
      this.drawCursorOverlays();
    }

    locateCursor(name) {
      if (!this.result || this.busy || this.cursorPositions[name] == null) return;
      const span = this.end - this.start;
      this.setView(this.cursorPositions[name] - span / 2, span);
    }

    moveCursor(name, column) {
      this.cursorSequence++;
      if (name === 'C') {
        this.selectedError = null;
        this.updateErrorControls();
      }
      this.cursorPositions[name] = this.snapColumn(column);
      this.updateCursorControls();
      this.drawCursorOverlays();
    }

    cursorTrack(pane) {
      const offset = this.nameWidth(pane), width = Math.max(1, pane.canvas.clientWidth - offset);
      const view = this.drawnView || { start: this.start, end: this.end };
      return CURSORS.filter(name => this.cursorPositions[name] != null).map(name => {
        const column = this.cursorPositions[name];
        const x = offset + (column - view.start) / (view.end - view.start) * width;
        return { name, x, inView: column >= view.start && column <= view.end,
          marker: Math.max(offset + 10, Math.min(offset + width - 10, x)) };
      }).sort((a, b) => Number(a.name === (this.activeCursor || 'C')) - Number(b.name === (this.activeCursor || 'C')));
    }

    drawCursorOverlays() {
      if (!this.result || !this.drawnView) return;
      for (const pane of this.panes) {
        const { canvas, cursorCanvas } = pane;
        if (cursorCanvas.width !== canvas.width) cursorCanvas.width = canvas.width;
        if (cursorCanvas.height !== canvas.height) cursorCanvas.height = canvas.height;
        const ctx = cursorCanvas.getContext('2d');
        const dpr = Math.min(2, this.popup.devicePixelRatio || 1);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const width = canvas.clientWidth, height = canvas.clientHeight;
        ctx.clearRect(0, 0, width, height);
        const names = this.nameWidth(pane);
        ctx.save(); ctx.beginPath(); ctx.rect(names, 0, width - names, height); ctx.clip();
        if (this.rangeSelection && this.result.pairs[this.rangeSelection.pair]) {
          const view = this.drawnView;
          const { start, end, pair } = this.rangeSelection;
          const left = names;
          const scale = (width - left) / (view.end - view.start);
          const x = left + (Math.max(start, view.start) - view.start) * scale;
          const right = left + (Math.min(end, view.end) - view.start) * scale;
          const y = AXIS_HEIGHT + this.rowOffsets[pair] - view.scrollTop;
          const top = Math.max(y, AXIS_HEIGHT), bottom = Math.min(y + this.pairContentHeight(pair), height);
          if (right > x && bottom > top) {
            ctx.fillStyle = 'rgba(31, 104, 213, 0.13)'; ctx.fillRect(x, top, right - x, bottom - top);
            ctx.strokeStyle = '#1f68d5'; ctx.lineWidth = 1;
            ctx.strokeRect(x + 0.5, top + 0.5, Math.max(0.5, right - x - 1), Math.max(0.5, bottom - top - 1));
          }
        }
        for (const cursor of this.cursorTrack(pane)) {
          const active = cursor.name === (this.activeCursor || 'C');
          const color = CURSOR_COLORS[cursor.name];
          if (cursor.inView) {
            ctx.strokeStyle = color; ctx.lineWidth = active ? 2 : 1.25;
            ctx.setLineDash(cursor.name === 'C' ? [9, 5] : []);
            ctx.beginPath(); ctx.moveTo(cursor.x, AXIS_HEIGHT); ctx.lineTo(cursor.x, height); ctx.stroke();
          }
          ctx.fillStyle = color; ctx.fillRect(cursor.marker - 10, 0, 20, active ? 20 : 17);
          ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.font = 'bold 11px "Segoe UI", sans-serif';
          ctx.fillText(cursor.name, cursor.marker, active ? 10 : 8.5);
        }
        ctx.restore();
      }
    }

    startRangeDrag(event, pane) {
      if (!this.drawnView || this.drawnView.generation !== this.generation || this.busy) return false;
      const rect = pane.canvas.getBoundingClientRect();
      if (event.clientX - rect.left < this.nameWidth(pane) || event.clientY - rect.top < AXIS_HEIGHT) return false;
      const y = event.clientY - rect.top - AXIS_HEIGHT + this.drawnView.scrollTop;
      const pair = this.pairAtOffset(y);
      const signal = this.result.pairs[pair]?.name;
      if (signal == null || this.collapsedPairs.has(signal)
          || y - this.rowOffsets[pair] >= this.pairContentHeight(pair)) return false;
      const column = this.rangeColumn(event, pane);
      pane.rangeDrag = { id: event.pointerId, x: event.clientX, column, pair, signal,
        previous: this.rangeSelection, cursor: this.cursorPositions.C, moved: false };
      event.preventDefault();
      pane.canvas.setPointerCapture(event.pointerId);
      return true;
    }

    rangeColumn(event, pane) {
      return Math.max(0, Math.min(Math.ceil(this.result.total) - 1, Math.floor(this.columnAt(event, pane))));
    }

    overlaySideAt(event, pane, index) {
      const y = event.clientY - pane.canvas.getBoundingClientRect().top - AXIS_HEIGHT + this.drawnView.scrollTop;
      return y - this.rowOffsets[index] < this.pairContentHeight(index) / 2 ? 'left' : 'right';
    }

    moveRangeDrag(event, pane) {
      const drag = pane.rangeDrag;
      if (drag.id !== event.pointerId || !this.drawnView || !this.result || this.busy) return;
      if (!drag.moved && Math.abs(event.clientX - drag.x) < 4) return;
      drag.moved = true;
      const column = this.rangeColumn(event, pane);
      const start = Math.min(column, drag.column), end = Math.min(this.result.total, Math.max(column, drag.column) + 1);
      if (this.rangeSelection?.start === start && this.rangeSelection?.end === end && this.rangeSelection?.pair === drag.pair) return;
      this.rangeSelection = { start, end, pair: drag.pair, signal: drag.signal };
      this.cursorPair = drag.pair;
      this.cursorSide = pane.side === 'overlay' ? this.overlaySideAt(event, pane, drag.pair) : pane.side;
      this.moveCursor('C', start);
    }

    finishRangeDrag(event, pane, cancelled) {
      const drag = pane.rangeDrag;
      if (drag.id !== event.pointerId) return;
      pane.rangeDrag = null;
      pane.suppressClickUntil = performance.now() + 400;
      if (cancelled && drag.moved) {
        this.rangeSelection = drag.previous;
        this.cursorPositions.C = drag.cursor;
        this.updateCursorControls();
        this.drawCursorOverlays();
      } else if (!cancelled && !drag.moved) void this.selectAt(event, pane);
    }

    startCursorDrag(event, pane) {
      if (!this.result || !this.drawnView || this.drawnView.generation !== this.generation || this.busy) return false;
      const rect = pane.canvas.getBoundingClientRect();
      const x = event.clientX - rect.left, y = event.clientY - rect.top;
      if (x < this.nameWidth(pane)) return false;
      const marker = this.cursorTrack(pane).reverse().find(cursor => y < 20
        ? Math.abs(x - cursor.marker) <= 10
        : y >= AXIS_HEIGHT && cursor.name !== 'C' && cursor.inView && Math.abs(x - cursor.x) <= 4);
      if (!marker) return false;
      event.preventDefault();
      pane.canvas.setPointerCapture(event.pointerId);
      pane.cursorDrag = { ...marker, pointerId: event.pointerId, startX: event.clientX, moved: false };
      return true;
    }

    moveCursorDrag(event, pane) {
      const drag = pane.cursorDrag;
      if (drag.pointerId !== event.pointerId || !this.drawnView || this.busy) return;
      if (Math.abs(event.clientX - drag.startX) > 2) drag.moved = true;
      if (drag.moved) this.moveCursor(drag.name, this.columnAt(event, pane));
    }

    finishCursorDrag(event, pane) {
      const drag = pane.cursorDrag;
      if (drag.pointerId !== event.pointerId) return;
      pane.cursorDrag = null;
      pane.suppressClickUntil = performance.now() + 400;
      if (!drag.moved) {
        this.selectCursor(drag.name);
        if (!drag.inView) this.locateCursor(drag.name);
      }
    }

    updateCursorControls() {
      const ready = !!this.result && !this.busy;
      const format = value => value == null ? '未设置' : value + ' cycle';
      for (const name of CURSORS) {
        const select = this.root.querySelector('[data-cursor="' + name + '"]');
        const locate = this.root.querySelector('[data-locate="' + name + '"]');
        const value = this.cursorPositions[name];
        select.disabled = !ready;
        select.setAttribute('aria-pressed', String(name === this.activeCursor || (name === 'C' && !this.activeCursor && value != null)));
        locate.disabled = !ready || value == null;
        this.scope.renderCursorLocationText(locate.firstElementChild, name + ' · ' + format(value));
        locate.title = '跳转到游标 ' + name + '（Shift+' + name + '）';
      }
      const { A, B, C } = this.cursorPositions;
      const delta = (x, y) => x == null || y == null ? '--' : (x - y > 0 ? '+' : '') + (x - y) + ' cycle';
      this.measurements.textContent = 'B-A：' + delta(B, A) + '  Cur-A：' + delta(C, A) + '  Cur-B：' + delta(C, B);
      const candidate = this.result?.pairs[this.cursorPair];
      const pair = this.filteredPairs.has(candidate?.name) ? null : candidate;
      const side = pair?.[this.cursorSide] >= 0 ? this.cursorSide : this.cursorSide === 'left' ? 'right' : 'left';
      this.cursorSignal.textContent = pair ? (side === 'left' ? 'A · ' : 'B · ') + pair.name : '';
      this.cursorSignal.title = this.cursorSignal.textContent;
      const enabled = ready && !!pair;
      this.condition.disabled = !enabled;
      for (const action of ['edge-prev', 'edge-next']) this.root.querySelector('[data-action="' + action + '"]').disabled = !enabled;
    }

    async navigateCursor(direction) {
      const pair = this.result?.pairs[this.cursorPair];
      if (!pair || this.busy) return;
      const side = pair[this.cursorSide] >= 0 ? this.cursorSide : this.cursorSide === 'left' ? 'right' : 'left';
      const renderer = side === 'left' ? this.leftRenderer : this.rightRenderer;
      const rowIndex = pair[side], name = this.activeCursor || 'C';
      const condition = this.condition.value.trim();
      const sequence = ++this.cursorSequence, generation = this.generation;
      try {
        const result = await this.scope.worker.call('compare-navigate', { generation, side, rowIndex,
          column: this.cursorPositions[name] ?? this.start, direction, kind: condition ? 'condition' : 'edge',
          condition, mode: renderer.modes[rowIndex], analogFormat: renderer.analogFormats[rowIndex] });
        if (!this.active || sequence !== this.cursorSequence || generation !== this.generation) return;
        if (!result.found) { this.status.textContent = '没有匹配的边沿'; return; }
        this.moveCursor(name, result.column);
        if (result.column < this.start || result.column > this.end) this.locateCursor(name);
        this.status.textContent = name + ' 已跳到 ' + pair.name + ' 的匹配边沿：' + result.column + ' cycle';
      } catch (error) {
        if (this.active && sequence === this.cursorSequence) this.status.textContent = error.message;
      }
    }

    async navigate(direction) {
      if (this.differencePending || !this.result?.errorCount) return;
      const generation = this.generation, sequence = this.cursorSequence;
      const name = this.activeCursor || 'C';
      const position = this.cursorPositions[name];
      const column = position ?? (direction > 0 ? this.start : this.end);
      this.differencePending = true;
      try {
        const error = await this.scope.worker.call('compare-difference', {
          generation, column, direction, hasCursor: position != null, filteredPairs: this.filteredPairs
        });
        if (!this.active || this.busy || generation !== this.generation || sequence !== this.cursorSequence) return;
        if (!error || this.snapColumn(error.runStart) === position) {
          this.status.textContent = (direction > 0 ? '后方' : '前方') + '没有更多差异';
          return;
        }
        this.rangeSelection = null;
        const hidden = this.filteredPairs.has(this.result.pairs[error.pair].name);
        if (!hidden) this.cursorPair = error.pair;
        this.moveCursor(name, error.runStart);
        this.chooseError(error, true);
        this.status.textContent += ' · 连续差异 cycle ' + error.runStart + '–' + error.runEnd
          + (hidden ? ' · 该信号已被筛选隐藏' : '');
      } finally {
        this.differencePending = false;
      }
    }

    chooseError(error, jump) {
      this.selectedError = error;
      const pair = this.result.pairs[error.pair];
      this.count.textContent = (error.index + 1) + ' / ' + this.result.errorCount + ' 处差异';
      this.status.textContent = pair.name + ' · cycle ' + error.start + '–' + error.end + ' · ' + error.reason
        + ' · cycle ' + (error.position == null ? error.start : error.position)
        + ' 的值 A: ' + display(error.leftValue) + ' · B: ' + display(error.rightValue);
      if (jump) this.jump(error.pair, error.runStart ?? error.start, error.runEnd ?? error.end);
      else this.draw();
      this.updateErrorControls();
    }

    updateErrorControls() {
      if (!this.root) return;
      for (const action of ['prev', 'next']) this.root.querySelector('[data-action="' + action + '"]').disabled = this.busy || !this.result || !this.result.errorCount;
      this.root.querySelector('[data-action="tag"]').disabled = this.busy || !this.selectedError;
    }

    jump(pair, start, end) {
      const name = this.result.pairs[pair]?.name;
      if (!this.filteredPairs.has(name)) {
        if (this.collapsedPairs.delete(name)) {
          this.rebuildRowOffsets();
          this.updateExpandAllControl();
        }
        this.scrollTop = Math.max(0, this.rowOffsets[pair] - 12);
        this.syncPaneGeometry();
      }
      const span = Math.max(8, Math.min(this.end - this.start, Math.max(16, (end - start) * 3)));
      this.setView(start - span / 4, span);
      this.schedule();
    }

    tagKey() {
      return 'vwd-scope-comparison-tags-v2:' + JSON.stringify([
        this.scope.adapter.comparisonLibraryId || '', ...Object.values(this.loadedNames).sort()
      ]);
    }
    readTags() {
      const read = key => {
        try {
          return JSON.parse(localStorage.getItem(key) || '[]').filter((tag) =>
            tag && typeof tag.name === 'string' && Number.isFinite(tag.start) && Number.isFinite(tag.end));
        } catch (_error) { return []; }
      };
      const key = this.tagKey();
      this.tags = read(key);
      try {
        if (localStorage.getItem(key) == null) {
          const library = this.scope.adapter.comparisonLibraryId || '';
          const { left, right } = this.loadedNames;
          const legacyKeys = [[left, right], [right, left]].map(pair =>
            'vwd-scope-comparison-tags:' + JSON.stringify([library, ...pair]));
          const legacy = new Map(legacyKeys.flatMap(read).map(tag => [JSON.stringify([tag.name, tag.signal, tag.start, tag.end]), tag]));
          this.tags = [...legacy.values()];
          if (this.tags.length) localStorage.setItem(key, JSON.stringify(this.tags));
        }
      } catch (_error) { /* Browser storage is optional. */ }
      this.renderTags();
    }
    saveTags() {
      try { localStorage.setItem(this.tagKey(), JSON.stringify(this.tags)); }
      catch (_error) { this.status.textContent = '浏览器未允许保存错误标签，本次窗口内仍可使用'; }
      this.renderTags();
    }
    addTag() {
      if (!this.selectedError) return;
      const error = this.selectedError;
      const pair = this.result.pairs[error.pair];
      const start = error.position == null ? error.start : error.position;
      const name = this.popup.prompt('错误标签名称', pair.name + ' @ ' + start);
      if (name == null || !name.trim()) return;
      this.tags.push({ name: name.trim(), signal: pair.name, start, end: error.end });
      this.saveTags();
    }
    renderTags() {
      const host = this.root.querySelector('.scope-compare-tags');
      host.replaceChildren();
      this.tags.forEach((tag, index) => {
        const group = document.createElement('span');
        group.className = 'scope-compare-tag';
        const jump = document.createElement('button');
        jump.textContent = tag.name;
        jump.title = tag.signal + ' · cycle ' + tag.start + '–' + tag.end;
        jump.addEventListener('click', async () => {
          if (this.busy) return;
          const pair = this.result && this.result.pairs.findIndex((item) => item.name === tag.signal);
          if (pair == null || pair < 0) { this.status.textContent = '该标签对应的信号已不存在'; return; }
          const generation = this.generation;
          const error = await this.scope.worker.call('compare-inspect', { generation, pair, column: tag.start });
          if (!this.active || this.generation !== generation) return;
          if (error) this.chooseError(error, false);
          else {
            this.selectedError = null;
            this.count.textContent = this.result.errorCount + ' 处差异';
            this.updateErrorControls();
          }
          this.jump(pair, tag.start, tag.end);
          this.status.textContent = tag.name + ' · ' + jump.title + (error ? ' · A: ' + display(error.leftValue) + ' · B: ' + display(error.rightValue) : ' · 此处已无差异');
        });
        group.appendChild(jump);
        for (const [symbol, label] of [['edit', '重命名错误标签'], ['close', '删除错误标签']]) {
          const control = document.createElement('button');
          control.innerHTML = icon(symbol); control.title = label; control.setAttribute('aria-label', label);
          control.addEventListener('click', () => {
            if (symbol === 'close') this.tags.splice(index, 1);
            else {
              const name = this.popup.prompt('错误标签名称', tag.name);
              if (name == null || !name.trim()) return;
              tag.name = name.trim();
            }
            this.saveTags();
          });
          group.appendChild(control);
        }
        host.appendChild(group);
      });
    }

    close(options) {
      if (!this.active) return;
      this.active = false;
      this.shortcutEvents?.abort();
      this.shortcutEvents = null;
      this.sequence += 1;
      this.cursorSequence += 1;
      clearInterval(this.progressTimer); this.progressTimer = 0;
      this.result = null;
      this.cache = null;
      this.selectedError = this.refreshAnchor = this.rangeSelection = null;
      this.tags = this.rowOffsets = [];
      clearTimeout(this.refreshTimer); this.refreshTimer = 0;
      clearTimeout(this.selectionHintTimer);
      this.pendingChanges.clear();
      this.scope.adapter.watchComparisonDocuments?.([]);
      if (this.frame) this.popup.cancelAnimationFrame(this.frame);
      this.frame = 0;
      if (this.resizeObserver) this.resizeObserver.disconnect();
      this.resizeObserver = null;
      this.releaseCanvasBuffers();
      this.panes = []; this.leftRenderer = this.rightRenderer = null; this.loadedNames = null; this.renderQueued = false;
      this.root.remove();
      this.root.replaceChildren();
      this.root = this.panesRoot = null;
      this.selects = this.count = this.status = this.startInput = this.spanInput = this.pan = this.panThumb = null;
      this.condition = this.cursorSignal = this.measurements = null;
      this.delayCard = this.delaySide = this.delayPair = null;
      this.delayOverrides = null;
      const popup = this.popup;
      this.popup = null;
      if (!options?.fromWindow && !popup.closed) popup.close();
      if (!options?.destroying) {
        void this.scope.worker.call('compare-close').catch(() => {});
        this.scope.root.querySelector('#scope-compare')?.focus();
      }
    }
  }
  global.VisualWaveDromScopeComparison = ScopeComparison;
})(window);

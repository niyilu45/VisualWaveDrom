(function (global) {
  'use strict';
  const AXIS_HEIGHT = 38;
  const NAME_WIDTH = 160;
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
      const opening = ++this.sequence;
      const doc = popup.document;
      doc.title = this.scope.meta.title + ' - 示波器比较';
      doc.documentElement.lang = 'zh-CN';
      const css = document.querySelector('link[href*="visualwavedrom-scope-compare.css"]');
      if (css) {
        const link = doc.createElement('link');
        link.rel = 'stylesheet'; link.href = css.href; doc.head.appendChild(link);
      }
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
          ${CURSORS.map(name => `<button type="button" data-locate="${name}" aria-keyshortcuts="Shift+${name}"></button>`).join('')}
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
        <footer class="scope-compare-status" role="status" aria-live="polite"></footer>`;
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
        select.append(new popup.Option('请选择波形图', ''));
        select.addEventListener('change', () => {
          select.querySelector('option[value=""]').disabled = true;
          if (SIDES.every(key => this.selects[key].value)) void this.load();
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
      this.root.addEventListener('click', (event) => {
        const cursor = event.target.closest('[data-cursor], [data-locate]');
        if (cursor?.dataset.cursor) { this.selectCursor(cursor.dataset.cursor); return; }
        if (cursor?.dataset.locate) { this.locateCursor(cursor.dataset.locate); return; }
        const target = event.target.closest('[data-action]');
        if (target) void Promise.resolve(this.action(target.dataset.action)).catch((error) => {
          if (this.active) this.status.textContent = error.message;
        });
      });
      this.root.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { this.close(); return; }
        if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return;
        if (event.target === this.condition && event.key === 'Enter') {
          event.preventDefault();
          void this.navigateCursor(event.shiftKey ? -1 : 1);
          return;
        }
        if (event.target.closest('input,select,textarea,[contenteditable]:not([contenteditable="false"]),[role="textbox"]')) return;
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
      });
      const sideButton = (event) => {
        if (event.button !== 3 && event.button !== 4) return;
        event.preventDefault();
        if (event.type === 'mousedown' && !event.target.closest('input,select,textarea')
            && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
          void this.navigateCursor(event.button === 3 ? -1 : 1);
        }
      };
      ['mousedown', 'mouseup', 'auxclick'].forEach(type => this.root.addEventListener(type, sideButton, true));
      this.root.querySelector('.scope-compare-layout').addEventListener('change', (event) => {
        this.layout = event.target.value;
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
        this.setBusy(false, '请选择比较图 B');
        this.selects.right.focus();
      } catch (error) { if (this.active && opening === this.sequence) this.setBusy(false, '读取目录失败：' + error.message); }
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
          || (action === 'swap' && this.loadedNames.left === this.loadedNames.right));
      });
      SIDES.forEach(side => { this.selects[side].disabled = busy; });
      this.root.querySelector('.scope-compare-layout').disabled = busy || !this.result;
      this.startInput.disabled = this.spanInput.disabled = busy || !this.result;
      this.updatePan();
      if (message) this.status.textContent = message;
      this.updateErrorControls();
      this.updateCursorControls();
    }

    async action(action) {
      if (action === 'close') return this.close();
      if (this.busy) return;
      if (!this.result) return;
      if (action === 'swap') return this.swap();
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
      if (this.loadedNames.left === this.loadedNames.right) return;
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
        if (option && this.result[side].title) {
          option.textContent = (option.dataset.number ? option.dataset.number + ' ' : '') + this.result[side].title;
        }
      });
    }

    async load(changes) {
      if (!SIDES.every(side => this.selects[side].value) || this.busy) return;
      const refresh = !!changes;
      const sequence = ++this.sequence;
      if (!refresh) {
        this.refreshAnchor = null;
        this.rangeSelection = null;
        this.loadedNames = Object.fromEntries(SIDES.map(side => [side, this.selects[side].value]));
        this.scope.adapter.watchComparisonDocuments?.(Object.values(this.loadedNames));
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
          reuseRight ? null : getDocument(rightName)
        ]);
        if (!this.active || sequence !== this.sequence) return;
        const currentContent = !reuseLeft && !leftDocument && this.scope.dataDraftDirty ? await this.scope.buildDraftSourceContent() : null;
        if (!this.active || sequence !== this.sequence) return;
        const result = await this.scope.worker.call('compare-start', { content: document?.content, transient: document?.transientState,
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
        if (!reuseRight) this.rightRenderer = this.scope.createComparisonRenderer(result.right,
          document.display || this.remapDisplay(rightDisplay, result.right), document.transientState);
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
          : '比较完成 · ' + result.pairs.length + ' 对信号 · ' + result.errorCount + ' 处差异');
        this.count.textContent = result.errorCount ? result.errorCount + ' 处差异' : '无差异';
        this.setView(anchor?.start ?? 0, anchor?.span ?? result.total);
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
      this.result.pairs.forEach(pair => this.rowOffsets.push(this.rowOffsets.at(-1) + Math.max(
        pair.left < 0 ? 0 : this.leftRenderer.rowHeight(pair.left),
        pair.right < 0 ? 0 : this.rightRenderer.rowHeight(pair.right))));
    }

    pairHeight(index) { return this.rowOffsets[index + 1] - this.rowOffsets[index]; }

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
      this.panes?.forEach(pane => {
        pane.canvas.width = pane.canvas.height = pane.cursorCanvas.width = pane.cursorCanvas.height = 0;
        pane.drag = pane.rangeDrag = pane.cursorDrag = null;
      });
    }

    buildPanes() {
      this.releaseCanvasBuffers();
      this.panesRoot.replaceChildren();
      this.panes = [];
      this.cache = null;
      this.panesRoot.dataset.layout = this.layout;
      (this.layout === 'overlay' ? ['overlay'] : ['left', 'right']).forEach((side) => {
        const pane = document.createElement('section');
        pane.className = 'scope-compare-pane';
        const heading = document.createElement('header');
        (side === 'overlay' ? ['left', 'right'] : [side]).forEach((source) => {
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
        const cursorCanvas = document.createElement('canvas');
        cursorCanvas.className = 'scope-compare-cursor-layer';
        cursorCanvas.setAttribute('aria-hidden', 'true');
        canvas.setAttribute('aria-label', heading.textContent + ' 比较波形');
        canvas.setAttribute('role', 'img');
        body.append(viewport, canvas, cursorCanvas);
        pane.append(heading, body);
        this.panesRoot.appendChild(pane);
        const item = { side, viewport, spacer, canvas, cursorCanvas };
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
        canvas.addEventListener('wheel', (event) => {
          event.preventDefault();
          if (event.ctrlKey || event.metaKey) {
            const rect = canvas.getBoundingClientRect();
            const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left - this.nameWidth()) / Math.max(1, rect.width - this.nameWidth())));
            const old = this.end - this.start;
            const span = old * Math.exp(Math.max(-1, Math.min(1, event.deltaY / 400)));
            this.setView(this.start + ratio * (old - span), span);
          } else if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
            this.setView(this.start + (event.deltaX || event.deltaY) * (this.end - this.start) / Math.max(1, canvas.clientWidth), this.end - this.start);
          } else viewport.scrollTop += event.deltaY * 0.5;
        }, { passive: false });
        canvas.addEventListener('click', (event) => {
          if (performance.now() < (item.suppressClickUntil || 0)) return;
          void this.selectAt(event, item);
        });
        canvas.addEventListener('pointerdown', (event) => {
          const touch = event.pointerType === 'touch';
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
          else this.setView(item.drag.start - dx * (this.end - this.start) / Math.max(1, canvas.clientWidth - this.nameWidth()), this.end - this.start);
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
      if (this.result) this.syncPaneGeometry();
      this.schedule();
    }

    nameWidth() { return Math.min(NAME_WIDTH, Math.max(85, (this.panes[0] && this.panes[0].canvas.clientWidth || 600) * 0.26)); }

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
      if (changed || !this.cache) this.schedule();
    }

    schedule() {
      if (!this.active || !this.result) return;
      if (this.frame) return;
      this.frame = this.popup.requestAnimationFrame(() => { this.frame = 0; void this.render(); });
    }

    viewport() {
      const width = Math.max(32, Math.max(...this.panes.map(pane => pane.canvas.clientWidth)) - this.nameWidth());
      const height = Math.max(...this.panes.map((pane) => pane.canvas.clientHeight));
      const rowStart = this.pairAtOffset(this.scrollTop);
      const rowEnd = Math.min(this.result.pairs.length, this.pairAtOffset(this.scrollTop + Math.max(0, height - AXIS_HEIGHT)) + 1);
      return { start: this.start, end: this.end, rowStart, rowEnd, width, scrollTop: this.scrollTop, generation: this.generation };
    }

    covers(coverage, view, precise = true) {
      if (!coverage || coverage.generation !== view.generation || coverage.start > view.start + 1e-9
          || coverage.end < view.end - 1e-9 || coverage.rowStart > view.rowStart || coverage.rowEnd < view.rowEnd) return false;
      if (!precise) return true;
      const density = view.width / (view.end - view.start);
      return Math.abs(coverage.density - density) <= density * 0.05;
    }

    async render() {
      if (!this.active || !this.result || !this.panes.length) return;
      const viewport = this.viewport();
      if (this.covers(this.cache?.view, viewport)) { this.draw(viewport); return; }
      if (this.covers(this.cache?.view, viewport, false)) this.draw(viewport);
      if (this.rendering) { this.renderQueued = true; return; }
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
        leftModes: left.modes, leftBusFormats: left.busFormats, leftAnalogFormats: left.analogFormats,
        rightModes: right.modes, rightBusFormats: right.busFormats, rightAnalogFormats: right.analogFormats };
      const request = this.windowRequest = this.scope.worker.call('compare-window', view);
      let paintedCurrent = false;
      try {
        const data = await request;
        if (!data.cancelled && this.active && this.result && generation === this.generation) {
          const current = this.viewport();
          const exact = this.covers(view, current);
          if (!exact && (!this.covers(view, current, false) || this.covers(this.cache?.view, current))) return;
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
      const nameWidth = this.nameWidth();
      const renderers = { left: this.leftRenderer, right: this.rightRenderer };
      SIDES.forEach(side => {
        renderers[side].viewStart = view.start;
        renderers[side].viewEnd = view.end;
      });
      for (const pane of this.panes) {
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
          const row = this.result.pairs[index][pane.side];
          if (row >= 0) renderer.drawRowBackground(ctx, row, this.rowOffsets[index] - scrollTop, this.pairHeight(index), plotWidth);
        }
        renderer.drawGridLines(ctx, plotWidth, plotHeight);
        for (let index = view.rowStart; index < view.rowEnd; index += 1) {
          const pair = this.result.pairs[index];
          const y = this.rowOffsets[index] - scrollTop;
          const rowHeight = this.pairHeight(index);
          ctx.strokeStyle = '#dfe2e6'; ctx.beginPath(); ctx.moveTo(0, y + rowHeight - 0.5); ctx.lineTo(plotWidth, y + rowHeight - 0.5); ctx.stroke();
          for (const error of errors.get(index) || []) {
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
          const twoBusLabels = overlay && SIDES.every(side => this.cache[side].get(pair[side])?.mode === 'bus');
          sides.forEach((side, layer) => {
            const row = this.cache[side].get(pair[side]);
            if (!row) return;
            const source = renderers[side];
            const naturalHeight = source.rowHeight(row.index);
            const top = y + (rowHeight - naturalHeight) / 2;
            ctx.save(); ctx.beginPath(); ctx.rect(0, y, plotWidth, rowHeight - 1); ctx.clip();
            source.drawSegments(ctx, row, row.index, top + 3, top + naturalHeight - 3, plotWidth,
              overlay ? COLORS[layer] : source.rowWaveColor(row.index), twoBusLabels ? (layer ? 7 : -7) : 0);
            ctx.restore();
          });
        }
        ctx.restore();
        ctx.fillStyle = '#f0f2f5'; ctx.fillRect(0, 0, nameWidth, AXIS_HEIGHT);
        ctx.font = '12px "Segoe UI", "Microsoft YaHei", sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillStyle = '#42505d'; ctx.fillText('信号 / cycle', 8, AXIS_HEIGHT / 2);
        ctx.save(); ctx.beginPath(); ctx.rect(0, AXIS_HEIGHT, nameWidth, plotHeight); ctx.clip();
        for (let index = view.rowStart; index < view.rowEnd; index += 1) {
          const pair = this.result.pairs[index], y = AXIS_HEIGHT + this.rowOffsets[index] - scrollTop;
          const h = this.pairHeight(index);
          ctx.fillStyle = '#f7f8fa'; ctx.fillRect(0, y, nameWidth, h - 1);
          ctx.fillStyle = '#25313e'; ctx.fillText(pair.name, 8, y + h / 2 - 6, nameWidth - 16);
          const missing = pair.left < 0 ? 'A 缺少信号' : pair.right < 0 ? 'B 缺少信号' : '';
          ctx.fillStyle = '#626b75';
          ctx.fillText(missing || (pair.errorCount ? pair.errorCount + ' 处差异' : '一致'), 8, y + h / 2 + 8);
        }
        ctx.restore();
      }
      this.drawCursorOverlays();
    }

    async selectAt(event, pane) {
      if (!this.drawnView || this.drawnView.generation !== this.generation || this.busy) return;
      const rect = pane.canvas.getBoundingClientRect();
      if (event.clientY - rect.top < AXIS_HEIGHT) return;
      const row = this.pairAtOffset(event.clientY - rect.top - AXIS_HEIGHT + this.drawnView.scrollTop);
      if (!this.result.pairs[row]) return;
      const column = this.columnAt(event, pane);
      this.cursorPair = row;
      if (pane.side !== 'overlay') this.cursorSide = pane.side;
      if (event.clientX - rect.left < this.nameWidth()) {
        this.cursorSequence++;
        this.updateCursorControls();
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
      return start + (event.clientX - rect.left - this.nameWidth())
        / Math.max(1, rect.width - this.nameWidth()) * (end - start);
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
      this.cursorPositions[name] = this.snapColumn(column);
      this.updateCursorControls();
      this.drawCursorOverlays();
    }

    cursorTrack(pane) {
      const offset = this.nameWidth(), width = Math.max(1, pane.canvas.clientWidth - offset);
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
        ctx.save(); ctx.beginPath(); ctx.rect(this.nameWidth(), 0, width - this.nameWidth(), height); ctx.clip();
        if (this.rangeSelection && this.result.pairs[this.rangeSelection.pair]) {
          const view = this.drawnView;
          const { start, end, pair } = this.rangeSelection;
          const left = this.nameWidth();
          const scale = (width - left) / (view.end - view.start);
          const x = left + (Math.max(start, view.start) - view.start) * scale;
          const right = left + (Math.min(end, view.end) - view.start) * scale;
          const y = AXIS_HEIGHT + this.rowOffsets[pair] - view.scrollTop;
          const top = Math.max(y, AXIS_HEIGHT), bottom = Math.min(y + this.pairHeight(pair), height);
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
      if (event.clientX - rect.left < this.nameWidth() || event.clientY - rect.top < AXIS_HEIGHT) return false;
      const pair = this.pairAtOffset(event.clientY - rect.top - AXIS_HEIGHT + this.drawnView.scrollTop);
      const signal = this.result.pairs[pair]?.name;
      if (signal == null) return false;
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
      if (pane.side !== 'overlay') this.cursorSide = pane.side;
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
      if (x < this.nameWidth()) return false;
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
        locate.textContent = name + ' · ' + format(value);
        locate.title = '跳转到游标 ' + name + '（Shift+' + name + '）';
      }
      const { A, B, C } = this.cursorPositions;
      const delta = (x, y) => x == null || y == null ? '--' : (x - y > 0 ? '+' : '') + (x - y) + ' cycle';
      this.measurements.textContent = 'B-A：' + delta(B, A) + '  Cur-A：' + delta(C, A) + '  Cur-B：' + delta(C, B);
      const pair = this.result?.pairs[this.cursorPair];
      const side = pair?.[this.cursorSide] >= 0 ? this.cursorSide : this.cursorSide === 'left' ? 'right' : 'left';
      this.cursorSignal.textContent = pair ? (side === 'left' ? 'A · ' : 'B · ') + pair.name : '';
      this.cursorSignal.title = this.cursorSignal.textContent;
      const enabled = ready && !!pair && this.cursorPositions[this.activeCursor || 'C'] != null;
      this.condition.disabled = !enabled;
      for (const action of ['edge-prev', 'edge-next']) this.root.querySelector('[data-action="' + action + '"]').disabled = !enabled;
    }

    async navigateCursor(direction) {
      if (!this.result || this.busy || this.condition.disabled) return;
      const pair = this.result.pairs[this.cursorPair];
      const side = pair[this.cursorSide] >= 0 ? this.cursorSide : this.cursorSide === 'left' ? 'right' : 'left';
      const renderer = side === 'left' ? this.leftRenderer : this.rightRenderer;
      const rowIndex = pair[side], name = this.activeCursor || 'C';
      const condition = this.condition.value.trim();
      const sequence = ++this.cursorSequence, generation = this.generation;
      try {
        const result = await this.scope.worker.call('compare-navigate', { generation, side, rowIndex,
          column: this.cursorPositions[name], direction, kind: condition ? 'condition' : 'edge',
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
      if (!this.result || !this.result.errorCount) return;
      const count = this.result.errorCount;
      const index = this.selectedError ? (this.selectedError.index + direction + count) % count : (direction > 0 ? 0 : count - 1);
      const generation = this.generation;
      const error = await this.scope.worker.call('compare-error', { generation, index });
      if (this.active && !this.busy && generation === this.generation && error) this.chooseError(error, true);
    }

    chooseError(error, jump) {
      this.selectedError = error;
      const pair = this.result.pairs[error.pair];
      this.count.textContent = (error.index + 1) + ' / ' + this.result.errorCount + ' 处差异';
      this.status.textContent = pair.name + ' · cycle ' + error.start + '–' + error.end + ' · ' + error.reason
        + ' · cycle ' + (error.position == null ? error.start : error.position)
        + ' 的值 A: ' + display(error.leftValue) + ' · B: ' + display(error.rightValue);
      if (jump) this.jump(error.pair, error.start, error.end);
      else this.draw();
      this.updateErrorControls();
    }

    updateErrorControls() {
      if (!this.root) return;
      for (const action of ['prev', 'next']) this.root.querySelector('[data-action="' + action + '"]').disabled = this.busy || !this.result || !this.result.errorCount;
      this.root.querySelector('[data-action="tag"]').disabled = this.busy || !this.selectedError;
    }

    jump(pair, start, end) {
      this.scrollTop = this.rowOffsets[Math.max(0, pair - 1)];
      this.panes.forEach((pane) => { pane.viewport.scrollTop = this.scrollTop; });
      const span = Math.max(8, Math.min(this.end - this.start, Math.max(16, (end - start) * 3)));
      this.setView(start - span / 4, span);
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

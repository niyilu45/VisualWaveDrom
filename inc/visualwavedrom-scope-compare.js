(function (global) {
  'use strict';
  const ROW_HEIGHT = 58;
  const AXIS_HEIGHT = 30;
  const NAME_WIDTH = 160;
  const COLORS = ['#176ca5', '#b45c0c'];
  const icons = {
    prev: '<path d="m15 18-6-6 6-6"/>', next: '<path d="m9 18 6-6-6-6"/>',
    close: '<path d="m18 6-12 12M6 6l12 12"/>', plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>', edit: '<path d="m16 3 5 5-12 12H4v-5zM14 5l5 5"/>'
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
    }

    async open() {
      if (this.active) return;
      this.active = true;
      this.layout = 'vertical';
      const opening = ++this.sequence;
      this.root = document.createElement('section');
      this.root.className = 'scope-comparison';
      this.root.setAttribute('aria-label', '示波器比较');
      this.root.innerHTML = `
        <header class="scope-compare-toolbar">
          <strong>示波器比较</strong><span class="scope-compare-source"></span>
          <label>比较图 <select class="scope-compare-source-select" aria-label="选择另一张波形图"></select></label>
          ${button('load', '加载比较图')}
          <label>布局 <select class="scope-compare-layout" aria-label="比较布局">
            <option value="vertical">上下分屏</option><option value="horizontal">左右分屏</option><option value="overlay">信号重叠</option>
          </select></label>
          ${button('close', '退出比较', 'close')}
        </header>
        <div class="scope-compare-controls">
          ${button('prev', '上一个错误', 'prev')}${button('next', '下一个错误', 'next')}
          <span class="scope-compare-count"></span>
          ${button('tag', '添加错误标签')}
          <label>起始 cycle <input class="scope-compare-start" type="number" min="0" step="0.5" value="0"></label>
          <label>显示 cycle <input class="scope-compare-span" type="number" min="0.5" step="0.5" value="1"></label>
          ${button('zoom-in', '放大', 'plus')}${button('zoom-out', '缩小', 'minus')}${button('fit', '适应窗口')}
        </div>
        <div class="scope-compare-tags" aria-label="错误位置标签"></div>
        <div class="scope-compare-panes" data-layout="vertical"></div>
        <input class="scope-compare-pan" type="range" min="0" max="0" step="0.5" value="0" aria-label="横向滚动比较波形">
        <footer class="scope-compare-status" role="status" aria-live="polite"></footer>`;
      document.body.appendChild(this.root);
      this.scope.root.inert = true;
      this.root.querySelector('.scope-compare-source').textContent = this.scope.meta.title;
      this.select = this.root.querySelector('.scope-compare-source-select');
      this.panesRoot = this.root.querySelector('.scope-compare-panes');
      this.count = this.root.querySelector('.scope-compare-count');
      this.status = this.root.querySelector('.scope-compare-status');
      this.startInput = this.root.querySelector('.scope-compare-start');
      this.spanInput = this.root.querySelector('.scope-compare-span');
      this.panInput = this.root.querySelector('.scope-compare-pan');
      this.root.addEventListener('click', (event) => {
        const target = event.target.closest('[data-action]');
        if (target) void Promise.resolve(this.action(target.dataset.action)).catch((error) => {
          if (this.active) this.status.textContent = error.message;
        });
      });
      this.root.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Escape') this.close();
        if (!event.target.matches('input,select,textarea') && /^(ArrowLeft|ArrowRight)$/.test(event.key)) {
          event.preventDefault();
          void this.navigate(event.key === 'ArrowRight' ? 1 : -1);
        }
      });
      this.root.querySelector('.scope-compare-layout').addEventListener('change', (event) => {
        this.layout = event.target.value;
        this.buildPanes();
      });
      this.startInput.addEventListener('change', () => this.setView(Number(this.startInput.value), this.end - this.start));
      this.spanInput.addEventListener('change', () => this.setView(this.start, Number(this.spanInput.value)));
      this.panInput.addEventListener('input', () => this.setView(Number(this.panInput.value), this.end - this.start));
      this.resizeObserver = new ResizeObserver(() => this.schedule());
      this.resizeObserver.observe(this.panesRoot);
      this.setBusy(true, '正在读取波形目录…');
      try {
        const documents = await this.scope.adapter.listComparisonDocuments();
        if (!this.active || opening !== this.sequence) return;
        documents.filter((doc) => doc.name !== this.scope.document.name).forEach((doc) => {
          const option = document.createElement('option');
          option.value = doc.name;
          option.textContent = doc.title || doc.name;
          this.select.appendChild(option);
        });
        this.setBusy(false, this.select.options.length ? '请选择另一张波形图' : '当前波形库中没有其他波形图');
        this.select.focus();
      } catch (error) { if (this.active && opening === this.sequence) this.setBusy(false, '读取目录失败：' + error.message); }
    }

    setBusy(busy, message) {
      this.busy = busy;
      this.root.setAttribute('aria-busy', String(busy));
      this.root.querySelectorAll('[data-action]').forEach((el) => {
        const action = el.dataset.action;
        el.disabled = action !== 'close' && (busy || (action === 'load' ? !this.select.value : !this.result));
      });
      this.select.disabled = busy;
      this.root.querySelector('.scope-compare-layout').disabled = busy || !this.result;
      this.startInput.disabled = this.spanInput.disabled = this.panInput.disabled = busy || !this.result;
      if (message) this.status.textContent = message;
      this.updateErrorControls();
    }

    async action(action) {
      if (action === 'close') return this.close();
      if (this.busy) return;
      if (action === 'load') return this.load();
      if (!this.result) return;
      if (action === 'prev' || action === 'next') return this.navigate(action === 'next' ? 1 : -1);
      if (action === 'tag') return this.addTag();
      if (action === 'fit') return this.setView(0, this.result.total);
      if (action.startsWith('zoom-')) {
        const span = (this.end - this.start) * (action === 'zoom-in' ? 0.5 : 2);
        const center = this.selectedError ? this.selectedError.start : (this.start + this.end) / 2;
        this.setView(center - span / 2, span);
      }
    }

    async load() {
      if (!this.select.value || this.busy) return;
      const sequence = ++this.sequence;
      this.loadedName = this.select.value;
      this.scope.log('scope-compare', { phase: 'load-start', source: this.scope.document.name, target: this.loadedName });
      this.setBusy(true, '正在载入比较图并计算公式…');
      this.result = null;
      this.cache = null;
      this.selectedError = null;
      this.marker = null;
      this.count.textContent = '';
      this.tags = [];
      this.renderTags();
      this.panesRoot.replaceChildren();
      const started = performance.now();
      let polling = false;
      const timer = setInterval(async () => {
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
        const document = await this.scope.adapter.loadComparisonDocument(this.loadedName);
        if (!this.active || sequence !== this.sequence) return;
        const currentContent = this.scope.dataDraftDirty ? await this.scope.buildDraftSourceContent() : null;
        this.rightDisplay = document.display || {};
        const result = await this.scope.worker.call('compare-start', { content: document.content, transient: document.transientState,
          currentContent, currentNames: this.scope.meta.rows.map((row) => this.scope.signalDisplayName(row.index)) });
        if (!this.active || sequence !== this.sequence) return;
        this.result = result;
        this.generation = result.generation;
        this.start = 0;
        this.end = result.total;
        this.scrollTop = 0;
        this.readTags();
        this.buildPanes();
        const warnings = result.pairs.filter((pair) => pair.diagnostics.some(Boolean));
        this.setBusy(false, warnings.length ? warnings.map((pair) => pair.name + '：' + pair.diagnostics.filter(Boolean).join('；')).join(' / ')
          : '比较完成 · ' + result.pairs.length + ' 对信号 · ' + result.errorCount + ' 处差异');
        this.count.textContent = result.errorCount ? result.errorCount + ' 处差异' : '无差异';
        this.setView(0, result.total);
        this.scope.log('scope-compare', { phase: 'ready', target: this.loadedName, pairs: result.pairs.length,
          errorCount: result.errorCount, totalColumns: result.total, elapsedMs: Math.round(performance.now() - started) });
      } catch (error) {
        if (this.active && sequence === this.sequence) {
          this.setBusy(false, '比较失败：' + error.message);
          this.scope.log('scope-compare', { phase: 'error', target: this.loadedName, message: error.message });
        }
      } finally { clearInterval(timer); }
    }

    buildPanes() {
      this.panesRoot.replaceChildren();
      this.panes = [];
      this.cache = null;
      if (!this.result) return;
      this.panesRoot.dataset.layout = this.layout;
      (this.layout === 'overlay' ? ['overlay'] : ['left', 'right']).forEach((side) => {
        const pane = document.createElement('section');
        pane.className = 'scope-compare-pane';
        const heading = document.createElement('header');
        (side === 'overlay' ? ['left', 'right'] : [side]).forEach((source) => {
          const label = document.createElement('span');
          label.style.color = COLORS[source === 'left' ? 0 : 1];
          label.textContent = (source === 'left' ? 'A · ' : 'B · ') + this.result[source].title;
          heading.appendChild(label);
        });
        const body = document.createElement('div');
        body.className = 'scope-compare-canvas-wrap';
        const viewport = document.createElement('div');
        viewport.className = 'scope-compare-scroll';
        const spacer = document.createElement('div');
        spacer.style.height = this.result.pairs.length * ROW_HEIGHT + 'px';
        viewport.appendChild(spacer);
        const canvas = document.createElement('canvas');
        canvas.setAttribute('aria-label', heading.textContent + ' 比较波形');
        canvas.setAttribute('role', 'img');
        body.append(viewport, canvas);
        pane.append(heading, body);
        this.panesRoot.appendChild(pane);
        const item = { side, viewport, canvas, body };
        this.panes.push(item);
        viewport.scrollTop = this.scrollTop;
        viewport.addEventListener('scroll', () => {
          this.scrollTop = viewport.scrollTop;
          this.panes.forEach((other) => { if (other !== item && other.viewport.scrollTop !== this.scrollTop) other.viewport.scrollTop = this.scrollTop; });
          this.schedule();
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
          if (event.button !== 1 && !touch) return;
          event.preventDefault();
          canvas.setPointerCapture(event.pointerId);
          item.drag = { x: event.clientX, y: event.clientY, start: this.start, scrollTop: viewport.scrollTop, touch, moved: false };
        });
        canvas.addEventListener('pointermove', (event) => {
          if (!item.drag) return;
          const dx = event.clientX - item.drag.x;
          const dy = event.clientY - item.drag.y;
          if (Math.abs(dx) + Math.abs(dy) > 5) item.drag.moved = true;
          if (!item.drag.moved) return;
          if (item.drag.touch && Math.abs(dy) >= Math.abs(dx)) viewport.scrollTop = item.drag.scrollTop - dy;
          else this.setView(item.drag.start - dx * (this.end - this.start) / Math.max(1, canvas.clientWidth - this.nameWidth()), this.end - this.start);
        });
        canvas.addEventListener('pointerup', (event) => {
          const drag = item.drag;
          item.drag = null;
          if (drag && drag.moved) item.suppressClickUntil = performance.now() + 400;
          else if (drag && drag.touch) {
            item.suppressClickUntil = performance.now() + 400;
            void this.selectAt(event, item);
          }
        });
        canvas.addEventListener('pointercancel', () => { item.drag = null; });
      });
      this.schedule();
    }

    nameWidth() { return Math.min(NAME_WIDTH, Math.max(85, (this.panes[0] && this.panes[0].canvas.clientWidth || 600) * 0.26)); }

    setView(start, span) {
      if (!this.result) return;
      if (!Number.isFinite(span) || !Number.isFinite(start)) return;
      span = Math.max(0.5, Math.min(this.result.total, span));
      this.start = Math.max(0, Math.min(this.result.total - span, start));
      this.end = this.start + span;
      this.startInput.value = Number(this.start.toFixed(3));
      this.spanInput.value = Number(span.toFixed(3));
      this.startInput.max = Math.max(0, this.result.total - 0.5);
      this.spanInput.max = this.result.total;
      this.panInput.max = Math.max(0, this.result.total - span);
      this.panInput.value = this.start;
      this.schedule();
    }

    schedule() {
      if (!this.active || !this.result) return;
      this.revision = (this.revision || 0) + 1;
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => { this.frame = 0; void this.render(); });
    }

    async render() {
      if (!this.active || !this.result || !this.panes.length) return;
      if (this.rendering) { this.renderQueued = true; return; }
      this.rendering = true;
      const revision = this.revision;
      const generation = this.generation;
      const width = Math.max(...this.panes.map((pane) => pane.canvas.clientWidth)) - this.nameWidth();
      const height = Math.max(...this.panes.map((pane) => pane.canvas.clientHeight));
      const rowStart = Math.floor(this.scrollTop / ROW_HEIGHT);
      const rowEnd = Math.min(this.result.pairs.length, Math.ceil((this.scrollTop + height) / ROW_HEIGHT));
      const view = { start: this.start, end: this.end, rowStart, rowEnd, generation, width: Math.max(32, width),
        leftModes: this.scope.modes, leftBusFormats: this.scope.busFormats, leftAnalogFormats: this.scope.analogFormats,
        rightModes: this.rightDisplay.modes, rightBusFormats: this.rightDisplay.busFormats, rightAnalogFormats: this.rightDisplay.analogFormats };
      try {
        const data = await this.scope.worker.call('compare-window', view);
        if (this.active && generation === this.generation && revision === this.revision) {
          this.cache = { data, view };
          this.draw();
        }
      } catch (error) { if (this.active && !this.busy && generation === this.generation) this.status.textContent = error.message; }
      finally {
        this.rendering = false;
        if (this.renderQueued) { this.renderQueued = false; this.schedule(); }
      }
    }

    draw() {
      if (!this.cache) return;
      const { data, view } = this.cache;
      for (const pane of this.panes) {
        const width = pane.canvas.clientWidth;
        const height = pane.canvas.clientHeight;
        const dpr = Math.min(2, global.devicePixelRatio || 1);
        pane.canvas.width = Math.max(1, Math.round(width * dpr));
        pane.canvas.height = Math.max(1, Math.round(height * dpr));
        const ctx = pane.canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
        const nameWidth = this.nameWidth();
        const plotWidth = width - nameWidth;
        const xFor = (column) => nameWidth + (column - view.start) / (view.end - view.start) * plotWidth;
        ctx.font = '12px "Segoe UI", "Microsoft YaHei", sans-serif';
        ctx.textBaseline = 'middle';
        const tick = Math.max(0.5, Math.pow(10, Math.floor(Math.log10((view.end - view.start) / Math.max(2, plotWidth / 90)))));
        for (let cycle = Math.ceil(view.start / tick) * tick; cycle <= view.end; cycle += tick) {
          const x = xFor(cycle);
          ctx.strokeStyle = '#e8ebee'; ctx.beginPath(); ctx.moveTo(x, AXIS_HEIGHT); ctx.lineTo(x, height); ctx.stroke();
          ctx.fillStyle = '#4d5966'; ctx.fillText(String(Number(cycle.toFixed(3))), x + 3, AXIS_HEIGHT / 2);
        }
        ctx.save(); ctx.beginPath(); ctx.rect(0, AXIS_HEIGHT, width, height - AXIS_HEIGHT); ctx.clip();
        for (let index = view.rowStart; index < view.rowEnd; index += 1) {
          const pair = this.result.pairs[index];
          const y = AXIS_HEIGHT + index * ROW_HEIGHT - this.scrollTop;
          ctx.fillStyle = '#f7f8fa'; ctx.fillRect(0, y, nameWidth, ROW_HEIGHT);
          ctx.strokeStyle = '#dce1e6'; ctx.beginPath(); ctx.moveTo(0, y + ROW_HEIGHT); ctx.lineTo(width, y + ROW_HEIGHT); ctx.stroke();
          ctx.save(); ctx.beginPath(); ctx.rect(6, y, nameWidth - 12, ROW_HEIGHT); ctx.clip();
          ctx.fillStyle = '#25313e'; ctx.fillText(pair.name, 8, y + 20);
          ctx.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif';
          ctx.fillStyle = '#626b75';
          ctx.fillText(pair.left < 0 ? 'A 缺少信号' : pair.right < 0 ? 'B 缺少信号' : pair.errorCount ? pair.errorCount + ' 处差异' : '一致', 8, y + 39);
          ctx.restore();
          ctx.save(); ctx.beginPath(); ctx.rect(nameWidth, y + 1, plotWidth, ROW_HEIGHT - 2); ctx.clip();
          for (const error of data.errors) {
            if (error.pair !== index) continue;
            const x = Math.max(nameWidth, xFor(error.start));
            const w = Math.max(2, Math.min(width, xFor(error.end)) - x);
            ctx.fillStyle = 'rgba(210, 45, 55, 0.17)'; ctx.fillRect(x, y + 2, w, ROW_HEIGHT - 4);
            ctx.strokeStyle = '#bd2638'; ctx.strokeRect(x, y + 2, w, ROW_HEIGHT - 4);
          }
          const sides = pane.side === 'overlay' ? ['left', 'right'] : [pane.side];
          let range = null;
          if (pane.side === 'overlay') {
            const ranges = sides.map((side) => data[side].rows.find((row) => row.index === pair[side]))
              .map((row) => row && row.data.range).filter(Boolean);
            if (ranges.length) range = { min: Math.min(...ranges.map((r) => r.min)), max: Math.max(...ranges.map((r) => r.max)) };
          }
          sides.forEach((side, layer) => {
            const row = data[side].rows.find((item) => item.index === pair[side]);
            if (!row) return;
            const renderer = Object.create(this.scope);
            renderer.viewStart = view.start; renderer.viewEnd = view.end;
            renderer.visibleMultiWaveEntries = (_index, entries) => entries;
            renderer.highlightedMultiWaveSource = () => '';
            renderer.rowWaveColor = () => COLORS[side === 'left' ? 0 : 1];
            const result = range ? Object.assign({}, row, { data: Object.assign({}, row.data, { range }) }) : row;
            ctx.save(); ctx.translate(nameWidth, 0);
            if (layer) { ctx.globalAlpha = 0.75; ctx.setLineDash([5, 3]); }
            const overlayBus = pane.side === 'overlay' && row.mode === 'bus';
            if (overlayBus) renderer.visibleBusLabelGeometry = () => null;
            renderer.drawSegments(ctx, result, pair[side], y + 6, y + ROW_HEIGHT - 7, plotWidth, COLORS[side === 'left' ? 0 : 1]);
            ctx.restore();
            if (overlayBus) {
              ctx.fillStyle = COLORS[side === 'left' ? 0 : 1];
              ctx.textAlign = 'center';
              for (const segment of row.data.items || []) {
                if (segment.value == null || segment.value === '*') continue;
                const x1 = Math.max(nameWidth, xFor(segment.start));
                const x2 = Math.min(width, xFor(segment.end));
                if (x2 - x1 > 45) ctx.fillText((side === 'left' ? 'A: ' : 'B: ') + String(segment.value), (x1 + x2) / 2, y + (layer ? 39 : 20), x2 - x1 - 8);
              }
              ctx.textAlign = 'left';
            }
          });
          const marker = this.selectedError || this.marker;
          if (marker && marker.pair === index) {
            ctx.strokeStyle = '#a5192a'; ctx.lineWidth = 2;
            ctx.beginPath(); const x = xFor(marker.position == null ? marker.start : marker.position); ctx.moveTo(x, y); ctx.lineTo(x, y + ROW_HEIGHT); ctx.stroke();
          }
          ctx.restore();
        }
        ctx.restore();
        ctx.fillStyle = '#f0f2f5'; ctx.fillRect(0, 0, nameWidth, AXIS_HEIGHT);
        ctx.fillStyle = '#42505d'; ctx.fillText('信号 / cycle', 8, AXIS_HEIGHT / 2);
      }
    }

    async selectAt(event, pane) {
      if (!this.cache) return;
      const rect = pane.canvas.getBoundingClientRect();
      if (event.clientX - rect.left < this.nameWidth() || event.clientY - rect.top < AXIS_HEIGHT) return;
      const row = Math.floor((event.clientY - rect.top - AXIS_HEIGHT + this.scrollTop) / ROW_HEIGHT);
      const column = this.start + (event.clientX - rect.left - this.nameWidth()) / Math.max(1, rect.width - this.nameWidth()) * (this.end - this.start);
      const generation = this.generation;
      const error = await this.scope.worker.call('compare-inspect', { generation, pair: row, column });
      if (this.active && generation === this.generation && error) this.chooseError(error, false);
    }

    async navigate(direction) {
      if (!this.result || !this.result.errorCount) return;
      const count = this.result.errorCount;
      const index = this.selectedError ? (this.selectedError.index + direction + count) % count : (direction > 0 ? 0 : count - 1);
      const generation = this.generation;
      const error = await this.scope.worker.call('compare-error', { generation, index });
      if (this.active && generation === this.generation && error) this.chooseError(error, true);
    }

    chooseError(error, jump) {
      this.selectedError = error;
      this.marker = null;
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
      this.scrollTop = Math.max(0, pair * ROW_HEIGHT - ROW_HEIGHT);
      this.panes.forEach((pane) => { pane.viewport.scrollTop = this.scrollTop; });
      const span = Math.max(8, Math.min(this.end - this.start, Math.max(16, (end - start) * 3)));
      this.setView(start - span / 4, span);
    }

    tagKey() {
      return 'vwd-scope-comparison-tags:' + JSON.stringify([this.scope.adapter.comparisonLibraryId || '', this.scope.document.name, this.loadedName]);
    }
    readTags() {
      try { this.tags = JSON.parse(localStorage.getItem(this.tagKey()) || '[]').filter((tag) => tag && typeof tag.name === 'string' && Number.isFinite(tag.start) && Number.isFinite(tag.end)); }
      catch (_error) { this.tags = []; }
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
      const name = global.prompt('错误标签名称', pair.name + ' @ ' + start);
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
            this.marker = { pair, start: tag.start };
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
              const name = global.prompt('错误标签名称', tag.name);
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

    close() {
      if (!this.active) return;
      this.active = false;
      this.sequence += 1;
      this.result = null;
      this.cache = null;
      if (this.frame) cancelAnimationFrame(this.frame);
      this.frame = 0;
      if (this.resizeObserver) this.resizeObserver.disconnect();
      this.root.remove();
      this.scope.root.inert = false;
      void this.scope.worker.call('compare-close');
      this.scope.root.querySelector('#scope-compare').focus();
    }
  }
  global.VisualWaveDromScopeComparison = ScopeComparison;
})(window);

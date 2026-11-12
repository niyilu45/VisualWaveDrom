(function (global) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const numberText = value => String(Number(Number(value).toPrecision(12)));
  class PointLabels {
    constructor(scope) {
      this.scope = scope; this.items = []; this.selectedId = ''; this.sequence = 0;
      this.active = false; this.gesture = null; this.pending = null; this.busy = false;
      this.epoch = 0; this.frame = 0; this.disposed = false; this.nodes = new Map(); this.signature = '';
    }
    attach() {
      const s = this.scope;
      this.button = s.root.querySelector('#scope-point-labels');
      this.button.addEventListener('click', () => this.setMode(!this.active));
      this.layer = document.createElement('div'); this.layer.className = 'scope-point-label-layer';
      this.svg = document.createElementNS(NS, 'svg'); this.svg.setAttribute('aria-hidden', 'true'); this.layer.appendChild(this.svg);
      s.plotViewport.appendChild(this.layer);
      this.layer.addEventListener('pointerdown', event => {
        const card = event.target.closest('[data-scope-point-label]');
        if (event.button !== 0 || !card) return;
        event.preventDefault(); event.stopPropagation(); s.plotCanvas.focus({ preventScroll: true });
        this.stop(false); this.selectedId = card.dataset.scopePointLabel;
        s.closeDisplayPopover(); s.closeStylePopover(); s.selectedConnectionId = ''; s.selectedPoint = null; s.updatePointEditor();
        const item = this.items.find(item => item.id === this.selectedId), box = card.getBoundingClientRect();
        const rect = s.plotCanvas.getBoundingClientRect();
        this.gesture = { kind: 'card', id: item.id, pointerId: event.pointerId, target: card,
          startX: event.clientX, startY: event.clientY, x: box.left - rect.left, y: box.top - rect.top,
          before: s.snapshot(), pushed: false };
        card.setPointerCapture(event.pointerId); this.redraw();
      });
      this.layer.addEventListener('pointermove', event => this.move(event));
      this.layer.addEventListener('pointerup', event => this.end(event));
      this.layer.addEventListener('pointercancel', event => this.cancel(event));
      this.layer.addEventListener('click', event => event.stopPropagation());
      this.layer.addEventListener('keydown', event => {
        const card = event.target.closest('[data-scope-point-label]');
        if (!card || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault(); this.stop(false); this.selectedId = card.dataset.scopePointLabel;
        s.selectedConnectionId = ''; s.selectedPoint = null; s.updatePointEditor(); this.redraw();
      });
    }
    setMode(enabled) {
      this.active = !!enabled;
      if (!this.active) this.stop(false);
      if (this.active) {
        const s = this.scope; s.setConnectionMode(false); s.setActiveCursor('');
        s.selectedConnectionId = ''; s.selectedPoint = null; s.updatePointEditor();
        s.setStatus('标签模式：单击或按住波形吸附，Shift+单击新增；拖动标签卡片调整位置');
      }
      this.button.classList.toggle('active', this.active); this.button.setAttribute('aria-pressed', String(this.active));
      this.scope.plotCanvas.classList.toggle('point-label-mode', this.active);
      this.redraw();
    }
    row(item) {
      const rows = this.scope.meta?.rows;
      if (this.metaRows !== rows) { this.metaRows = rows; this.rowsById = new Map((rows || []).map(row => [String(row.rowId), row])); }
      return this.rowsById?.get(String(item.rowId));
    }
    visible(item) {
      const s = this.scope, row = this.row(item);
      if (!row || s.modes[row.index] !== 'analog' || s.isRowCollapsed(row.index)) return false;
      return !item.sourceRowId || s.visibleMultiWaveEntries(row.index, row.multiWave?.sources || [])
        .some(source => String(source.rowId) === String(item.sourceRowId));
    }
    position() {
      if (this.layer) this.layer.style.transform = 'translateY(' + this.scope.plotViewport.scrollTop + 'px)';
    }
    redraw() {
      if (!this.frame && !this.disposed) this.frame = global.requestAnimationFrame(() => { this.frame = 0; this.draw(); });
    }
    invalidate() { this.signature = ''; this.items.forEach(item => { item.valueKey = ''; }); this.redraw(); }
    valueSignature() {
      const s = this.scope;
      return JSON.stringify([s.windowSessionRevision, s.analogFormats, s.simplifiedDisplayActive]);
    }
    async query(queries) {
      const s = this.scope, raw = [], local = [];
      queries.forEach(query => {
        const row = s.meta.rows[query.rowIndex], model = s.simplifiedDisplayActive && s.simplified?.model;
        const simplified = model && !row.multiWave && model.rows[query.rowIndex];
        if (!simplified) { raw.push(query); return; }
        const columns = model.columns, values = simplified.values;
        let lo = 0, hi = columns.length;
        while (lo < hi) { const middle = (lo + hi) >> 1; if (columns[middle] <= query.column) lo = middle + 1; else hi = middle; }
        const index = lo - 1, left = values[index], right = values[index + 1];
        if (index < 0 || query.column > columns[columns.length - 1] || left == null || !Number.isFinite(Number(left))) return;
        const fraction = index + 1 < columns.length ? (query.column - columns[index]) / (columns[index + 1] - columns[index]) : 0;
        const value = right == null || !Number.isFinite(Number(right)) ? Number(left) : Number(left) * (1 - fraction) + Number(right) * fraction;
        local.push({ id: query.id, rowIndex: row.index, rowId: row.rowId, sourceRowId: '', name: row.name,
          column: query.column, value, range: s.analogDisplayRange(row.index, null, values) });
      });
      return local.concat(raw.length ? await s.worker.call('label-points', {
        queries: raw, analogFormats: s.analogFormats,
        multiWaveHidden: s.transientFormulaState.multiWaveHidden
      }) : []);
    }
    async refresh() {
      if (!this.items.length || !this.scope.meta) return;
      const valueKey = this.valueSignature(), pending = this.items.filter(item => item.valueKey !== valueKey);
      if (!pending.length) return;
      const signature = JSON.stringify([valueKey, pending.map(item => [item.id, item.rowId, item.sourceRowId, item.column])]);
      if (signature === this.signature) return;
      this.signature = signature; const epoch = this.epoch;
      const queries = pending.map(item => {
        const row = this.row(item);
        return row && { id: item.id, rowIndex: row.index, column: item.column, sources: item.sourceRowId ? [item.sourceRowId] : undefined };
      }).filter(Boolean);
      try {
        const points = await this.query(queries);
        if (this.disposed || epoch !== this.epoch || valueKey !== this.valueSignature()) return;
        const byId = new Map(points.map(point => [point.id, point]));
        pending.forEach(item => {
          const query = queries.find(query => query.id === item.id);
          if (query && query.column !== item.column) return;
          const point = byId.get(item.id); item.valid = !!point;
          if (point) Object.assign(item, { value: point.value, range: point.range, name: point.name });
          item.valueKey = valueKey;
        }); this.redraw();
      } catch (error) { if (!this.disposed) this.scope.log('scope-label', { phase: 'read-error', message: error.message }); }
    }
    geometry(item, width, height) {
      const s = this.scope, row = this.row(item);
      if (!row || !item.valid || !this.visible(item) || item.column < s.viewStart || item.column > s.viewEnd) return null;
      const top = s.rowTop(row.index) - s.plotViewport.scrollTop + 3, bottom = top + s.rowHeight(row.index) - 6;
      if (bottom < 0 || top > height || item.value < item.range.min || item.value > item.range.max) return null;
      const x = s.xForColumn(item.column, width), y = bottom - 4 - (item.value - item.range.min)
        / Math.max(1e-12, item.range.max - item.range.min) * Math.max(1, bottom - top - 8);
      if (y < 0 || y > height) return null;
      return { x, y };
    }
    draw() {
      if (this.disposed || !this.layer || !this.scope.meta) return;
      const s = this.scope, width = s.plotViewport.clientWidth, height = s.plotViewport.clientHeight;
      this.position(); this.layer.style.width = width + 'px'; this.layer.style.height = height + 'px';
      this.svg.setAttribute('width', width); this.svg.setAttribute('height', height);
      const existing = new Set(this.items.map(item => item.id));
      this.nodes.forEach((nodes, id) => { if (!existing.has(id)) { nodes.card.remove(); nodes.line.remove(); nodes.mark.remove(); this.nodes.delete(id); } });
      this.items.forEach(item => {
        let nodes = this.nodes.get(item.id);
        if (!nodes) {
          const card = document.createElement('div'); card.className = 'scope-point-label'; card.dataset.scopePointLabel = item.id;
          card.setAttribute('role', 'button'); card.tabIndex = 0;
          const xText = document.createElement('span'), yText = document.createElement('span'); card.append(xText, yText);
          const line = document.createElementNS(NS, 'line'), mark = document.createElementNS(NS, 'rect');
          line.setAttribute('class', 'scope-point-label-leader'); mark.setAttribute('class', 'scope-point-label-marker');
          mark.setAttribute('width', '6'); mark.setAttribute('height', '6');
          this.svg.append(line, mark); this.layer.appendChild(card);
          nodes = { card, line, mark, xText, yText }; this.nodes.set(item.id, nodes);
        }
        const point = this.geometry(item, width, height);
        nodes.card.hidden = !point; nodes.line.style.display = nodes.mark.style.display = point ? '' : 'none';
        if (!point) return;
        nodes.xText.textContent = 'X: ' + item.column; nodes.yText.textContent = 'Y: ' + numberText(item.value);
        nodes.card.title = item.name + ' · 拖动卡片调整位置，按 Del 删除';
        const selected = item.id === this.selectedId; nodes.card.classList.toggle('selected', selected);
        nodes.card.setAttribute('aria-pressed', String(selected)); nodes.card.style.zIndex = selected ? '2' : '1';
        const left = clamp(point.x + item.dx, 4, Math.max(4, width - nodes.card.offsetWidth - 4));
        const top = clamp(point.y + item.dy, 4, Math.max(4, height - nodes.card.offsetHeight - 4));
        nodes.card.style.left = left + 'px'; nodes.card.style.top = top + 'px';
        nodes.mark.setAttribute('x', point.x - 3); nodes.mark.setAttribute('y', point.y - 3);
        nodes.line.setAttribute('x1', point.x); nodes.line.setAttribute('y1', point.y);
        nodes.line.setAttribute('x2', clamp(point.x, left, left + nodes.card.offsetWidth));
        nodes.line.setAttribute('y2', clamp(point.y, top, top + nodes.card.offsetHeight));
      });
      void this.refresh();
    }
    pointerDown(event) {
      if (event.button !== 0) return false;
      if (!this.active) { if (this.selectedId) { this.selectedId = ''; this.redraw(); } return false; }
      const rect = this.scope.plotCanvas.getBoundingClientRect();
      if (event.clientY - rect.top <= 22) return false;
      this.stop(false);
      this.gesture = { kind: 'point', pointerId: event.pointerId, target: this.scope.plotCanvas,
        id: !event.shiftKey && this.items.some(item => item.id === this.selectedId && this.visible(item)) ? this.selectedId : '',
        before: this.scope.snapshot(), pushed: false, ended: false };
      this.scope.plotCanvas.setPointerCapture(event.pointerId); this.enqueue(event); return true;
    }
    enqueue(event) {
      const s = this.scope, rect = s.plotCanvas.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
      if (x < 0 || x > rect.width || y < 0 || y > rect.height) return;
      const firstTick = Math.ceil(s.viewStart * 2);
      const lastTick = Math.min(Math.floor(s.viewEnd * 2), Math.ceil(s.meta.totalColumns * 2) - 1);
      if (firstTick > lastTick) return;
      const tick = clamp(Math.round(s.columnForX(x, rect.width) * 2), firstTick, lastTick);
      this.pending = { column: tick / 2, y, gesture: this.gesture };
      void this.flush();
    }
    async flush() {
      if (this.busy || !this.pending || this.disposed) return;
      const request = this.pending; this.pending = null; this.busy = true; const epoch = this.epoch;
      const s = this.scope, visible = s.visibleRows(), queries = [];
      for (let index = visible.start; index < visible.end; index++) {
        if (s.modes[index] !== 'analog' || s.isRowCollapsed(index)) continue;
        const top = s.rowTop(index) - s.plotViewport.scrollTop;
        if (request.y < top || request.y >= top + s.rowHeight(index)) continue;
        const row = s.meta.rows[index], sources = row.multiWave
          ? s.visibleMultiWaveEntries(index, row.multiWave.sources).map(source => source.rowId) : undefined;
        queries.push({ rowIndex: index, column: request.column, sources });
      }
      try {
        const points = await this.query(queries);
        if (this.disposed || epoch !== this.epoch || request.gesture !== this.gesture) return;
        let nearest = null, distance = Infinity;
        points.forEach(point => {
          if (point.value < point.range.min || point.value > point.range.max) return;
          const top = s.rowTop(point.rowIndex) - s.plotViewport.scrollTop + 3, bottom = top + s.rowHeight(point.rowIndex) - 6;
          const y = bottom - 4 - (point.value - point.range.min) / Math.max(1e-12, point.range.max - point.range.min) * Math.max(1, bottom - top - 8);
          if (y < 0 || y > s.plotViewport.clientHeight) return;
          if (Math.abs(y - request.y) < distance) { distance = Math.abs(y - request.y); nearest = point; }
        });
        if (nearest) {
          const gesture = request.gesture; this.pushGestureHistory(gesture);
          let item = this.items.find(item => item.id === gesture.id);
          if (!item) { item = { id: 'scope-point-label-' + (++this.sequence), dx: 14, dy: -50 }; this.items.push(item); gesture.id = item.id; }
          Object.assign(item, nearest, { id: gesture.id, valid: true, valueKey: this.valueSignature() }); this.selectedId = item.id;
          s.selectedConnectionId = ''; s.selectedPoint = null; s.updatePointEditor();
          this.signature = ''; this.redraw();
        } else if (request.gesture.ended) s.setStatus('该位置没有可标注的有效模拟波形', true);
      } catch (error) { if (!this.disposed) s.log('scope-label', { phase: 'probe-error', message: error.message }); }
      finally {
        this.busy = false;
        if (this.pending) void this.flush();
        else if (this.gesture === request.gesture && request.gesture.ended) this.gesture = null;
      }
    }
    pushGestureHistory(gesture) {
      if (!gesture.pushed) { this.scope.pushHistorySnapshot(gesture.before); gesture.pushed = true; }
    }
    move(event) {
      const gesture = this.gesture;
      if (!gesture || gesture.ended || gesture.pointerId !== event.pointerId) return false;
      event.preventDefault();
      if (gesture.kind === 'point') { this.enqueue(event); return true; }
      const item = this.items.find(item => item.id === gesture.id);
      const point = item && this.geometry(item, this.scope.plotViewport.clientWidth, this.scope.plotViewport.clientHeight);
      if (!point) return true;
      const dx = event.clientX - gesture.startX, dy = event.clientY - gesture.startY;
      if (Math.abs(dx) + Math.abs(dy) > 1) {
        this.pushGestureHistory(gesture); item.dx = gesture.x + dx - point.x; item.dy = gesture.y + dy - point.y; this.redraw();
      }
      return true;
    }
    end(event) {
      const gesture = this.gesture;
      if (!gesture || gesture.pointerId !== event.pointerId) return false;
      if (gesture.kind === 'point') this.enqueue(event); else this.move(event);
      gesture.ended = true;
      try { gesture.target.releasePointerCapture(event.pointerId); } catch (_) {}
      if (gesture.kind === 'card' || !this.busy && !this.pending) this.gesture = null;
      return true;
    }
    cancel(event) { if (!this.gesture || this.gesture.pointerId !== event.pointerId) return false; this.stop(true); return true; }
    stop(rollback) {
      this.epoch++; this.signature = ''; this.pending = null; const gesture = this.gesture; this.gesture = null;
      if (gesture) {
        try { gesture.target.releasePointerCapture(gesture.pointerId); } catch (_) {}
        if (rollback && gesture.pushed) {
          if (this.scope.undoStack[this.scope.undoStack.length - 1] === gesture.before) this.scope.undoStack.pop();
          this.restore(gesture.before.pointLabels); this.scope.updateHistoryButtons();
        }
      }
    }
    deleteSelected() {
      const item = this.items.find(item => item.id === this.selectedId);
      if (!item || !this.visible(item)) return false;
      this.stop(false); this.scope.pushHistory(); this.items = this.items.filter(label => label.id !== item.id);
      this.selectedId = ''; this.invalidate(); this.scope.setStatus('已删除模拟波形标签'); return true;
    }
    selectedVisible() { const item = this.items.find(item => item.id === this.selectedId); return !!item && this.visible(item); }
    snapshot() { return { items: this.items.map(item => ({ ...item })), selectedId: this.selectedId, sequence: this.sequence }; }
    restore(snapshot) {
      this.stop(false); this.items = (snapshot?.items || []).map(item => ({ ...item }));
      this.selectedId = snapshot?.selectedId || ''; this.sequence = Math.max(Number(snapshot?.sequence) || 0, this.items.length); this.invalidate();
    }
    remapRows(previousRows, mapping) {
      this.stop(false);
      const byId = new Map(previousRows.map(row => [String(row.rowId), row.index]));
      this.items = this.items.filter(item => byId.has(String(item.rowId)) && mapping.has(byId.get(String(item.rowId)))
        && (!item.sourceRowId || byId.has(String(item.sourceRowId)) && mapping.has(byId.get(String(item.sourceRowId)))));
      this.items.forEach(item => {
        item.rowId = this.scope.rowId(mapping.get(byId.get(String(item.rowId))));
        if (item.sourceRowId && byId.has(String(item.sourceRowId))) item.sourceRowId = this.scope.rowId(mapping.get(byId.get(String(item.sourceRowId))));
      }); this.invalidate();
    }
    dispose() {
      this.disposed = true; this.stop(false); if (this.frame) global.cancelAnimationFrame(this.frame);
      this.frame = 0; this.items = []; this.nodes.clear(); this.rowsById?.clear(); this.metaRows = null; this.layer?.remove(); this.scope = null;
    }
  }
  global.VisualWaveDromScopeLabels = { create: scope => new PointLabels(scope) };
})(window);

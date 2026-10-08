(function (global) {
  'use strict';
  const sessions = new Map();
  const statusNames = { ok: '已确定', unknown: '无法判断', conflict: '时延冲突' };
  const rowStatusName = (row) => row.status === 'ok' && row.alignments.length ? '上行对齐' : statusNames[row.status];
  const icons = {
    plus: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3M8 11h6m-3-3v6"/>',
    minus: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3M8 11h6"/>',
    fit: '<path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3"/>',
    locate: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2"/>'
  };
  function icon(name) { return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' + icons[name] + '</svg>'; }
  function open(host) {
    const old = sessions.get(host.id);
    if (old && !old.closed) { old.focus(); return old; }
    const view = global.open('', '_blank', 'popup,width=1250,height=850');
    if (!view) throw new Error('浏览器阻止了时延检查窗口，请允许弹出窗口');
    sessions.set(host.id, view);
    const doc = view.document;
    doc.open();
    doc.write('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>时延检查</title></head><body class="timing-view"></body></html>');
    doc.close();
    const stylesheet = doc.createElement('link'); stylesheet.rel = 'stylesheet';
    stylesheet.href = new URL('inc/visualwavedrom-timing.css?v=20260930', document.baseURI).href;
    doc.head.appendChild(stylesheet);
    doc.documentElement.style.fontSize = getComputedStyle(document.documentElement).fontSize;
    doc.body.innerHTML = `
      <header class="timing-header"><h1>时延检查</h1><span id="timing-title"></span><button id="timing-close" type="button">关闭</button></header>
      <form id="timing-config" class="timing-toolbar">
        <label>周期时长 <input id="timing-period" type="number" step="any" min="0" placeholder="未设置" aria-label="每周期时长（ns）"> ns</label>
        <label>容差 <input id="timing-tolerance" type="number" step="any" min="0" value="0.0000001" aria-label="容差（cycle）"> cycle</label>
        <label>间隔内容 <select id="timing-fill"><option value="hold">延续原状态</option><option value="unknown">未知 x</option></select></label>
        <button type="submit" id="timing-apply">应用配置</button>
        <span id="timing-config-status" role="status"></span>
      </form>
      <div id="timing-status" role="status" aria-live="polite">正在读取波形...</div>
      <div class="timing-workspace">
        <aside class="timing-results" aria-label="时延检查结果">
          <div class="timing-results-heading"><h2>逐行检查</h2><label><input id="timing-errors-only" type="checkbox">仅异常</label></div>
          <div id="timing-row-list"></div>
          <section class="timing-detail"><h2 id="timing-detail-title">检查详情</h2><div id="timing-detail"></div><button id="timing-locate" type="button">定位原图</button></section>
        </aside>
        <main class="timing-preview">
          <div class="timing-toolbar timing-range">
            <button type="button" id="timing-zoom-out" title="缩小" aria-label="缩小">${icon('minus')}</button>
            <button type="button" id="timing-zoom-in" title="放大" aria-label="放大">${icon('plus')}</button>
            <button type="button" id="timing-fit" title="适应波形和已展开的参考序列" aria-label="适应波形和已展开的参考序列">${icon('fit')}</button>
            <label>起点 <input id="timing-start" type="number" step="any" value="0"></label>
            <label>终点 <input id="timing-end" type="number" step="any" value="10"></label><span>cycle</span>
          </div>
          <div class="timing-toolbar timing-cursors">
            <button type="button" id="timing-pick-a" aria-pressed="true">游标 A</button><input id="timing-a" type="number" step="any" value="0" aria-label="游标 A 时间">
            <button type="button" id="timing-pick-b" aria-pressed="false">游标 B</button><input id="timing-b" type="number" step="any" value="0" aria-label="游标 B 时间">
            <output id="timing-delta">B-A = 0 cycle</output>
          </div>
          <div class="timing-plot"><canvas id="timing-canvas" aria-label="展开后的时序图"></canvas><div id="timing-scroll" tabindex="0" role="region" aria-label="展开波形，点击设置当前游标"><div id="timing-spacer"></div></div><div id="timing-row-toggles"></div><button type="button" id="timing-reference-all">全部展开</button></div>
          <input type="range" id="timing-pan" min="0" max="100000" value="0" step="1" aria-label="横向浏览已确定时间范围">
          <footer id="timing-position">列号从 0 开始 · 展开预览只读</footer>
        </main>
      </div>`;
    const $ = (id) => doc.getElementById('timing-' + id);
    const core = global.VisualWaveDromTimingCore, fmt = core.format;
    let source = null, model = null, worker = null, version = 0, timer = 0, disposed = false, reading = false;
    let start = 0, end = 10, active = 'a', a = 0, b = 0, selected = -1, highlighted = new Set(), highlightedEdges = new Set();
    let frame = 0, drag = null, configKey = '', requestTime = 0, selectedColumn = -1, rowOffsets = [0];
    let referenceDefault = null, displayMinimum = 0, displayMaximum = 1;
    const referenceOverrides = new Map(), referenceToggles = new Map();
    const rowHeight = 64, referenceHeight = 72, ruler = 34;
    const canvas = $('canvas'), scroll = $('scroll'), context = canvas.getContext('2d');
    const dimensions = () => ({ width: scroll.clientWidth, height: scroll.clientHeight, left: Math.min(190, Math.max(105, scroll.clientWidth * 0.25)) });
    function rowAt(offset) {
      if (offset < 0) return -1;
      let lo = 0, hi = rowOffsets.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (rowOffsets[mid + 1] <= offset) lo = mid + 1; else hi = mid; }
      return lo;
    }
    function referenceOpen(row) {
      return !!row.referenceRuns.length && (referenceOverrides.get(row.index) ?? referenceDefault ?? row.status !== 'ok');
    }
    function layoutRows() {
      const anchor = rowAt(scroll.scrollTop), offset = scroll.scrollTop - (rowOffsets[anchor] || 0);
      rowOffsets = [0]; displayMinimum = model.minimum; displayMaximum = model.maximum;
      let available = 0, opened = 0;
      model.rows.forEach((row) => {
        const expanded = referenceOpen(row);
        if (row.referenceRuns.length) available++;
        if (expanded) {
          opened++;
          displayMinimum = Math.min(displayMinimum, row.referenceRuns[0].start);
          displayMaximum = Math.max(displayMaximum, row.referenceRuns[row.referenceRuns.length - 1].finish);
        }
        rowOffsets.push(rowOffsets[rowOffsets.length - 1] + rowHeight + (expanded ? referenceHeight : 0));
      });
      $('spacer').style.height = (ruler + rowOffsets[rowOffsets.length - 1]) + 'px';
      if (anchor >= 0 && anchor < model.rows.length) scroll.scrollTop = rowOffsets[anchor]
        + Math.min(offset, rowOffsets[anchor + 1] - rowOffsets[anchor] - 1);
      const allOpen = available > 0 && opened === available;
      $('reference-all').textContent = allOpen ? '全部收起' : '全部展开';
      $('reference-all').disabled = !available;
      $('reference-all').dataset.expanded = String(allOpen);
      $('reference-all').title = (allOpen ? '收起' : '展开') + '全部原序列参考';
      if (!model.rows[selected] || !referenceOpen(model.rows[selected])) selectedColumn = -1;
      refreshControls(); drawSoon();
    }
    function updateReferenceToggles(first, last) {
      for (const [index, toggle] of referenceToggles) {
        if (index < first || index >= last || !model.rows[index]?.referenceRuns.length) { toggle.remove(); referenceToggles.delete(index); }
      }
      for (let index = first; index < last; index++) {
        const row = model.rows[index]; if (!row.referenceRuns.length) continue;
        let toggle = referenceToggles.get(index);
        if (!toggle) {
          toggle = doc.createElement('details'); toggle.className = 'timing-reference-toggle'; toggle.dataset.row = index;
          const summary = doc.createElement('summary'); toggle.appendChild(summary);
          summary.onclick = (event) => {
            event.preventDefault(); event.stopPropagation();
            referenceOverrides.set(index, !referenceOpen(model.rows[index])); layoutRows();
          };
          $('row-toggles').appendChild(toggle); referenceToggles.set(index, toggle);
        }
        toggle.open = referenceOpen(row); toggle.style.top = (rowOffsets[index] - scroll.scrollTop + 6) + 'px';
        const label = (toggle.open ? '收起' : '展开') + '第' + (index + 1) + '行 ' + row.name + ' 的原序列参考';
        toggle.firstChild.title = label; toggle.firstChild.setAttribute('aria-label', label);
      }
    }
    function message(value, error) { $('status').textContent = value; $('status').classList.toggle('error', !!error); }
    function refreshControls() {
      $('start').value = fmt(start); $('end').value = fmt(end);
      if (model) {
        const room = Math.max(0, displayMaximum - displayMinimum - (end - start));
        $('pan').disabled = !room; $('pan').value = room ? Math.round((start - displayMinimum) / room * 100000) : 0;
      }
      $('a').value = fmt(a); $('b').value = fmt(b);
      $('pick-a').setAttribute('aria-pressed', String(active === 'a')); $('pick-b').setAttribute('aria-pressed', String(active === 'b'));
      const delta = b - a, value = (delta > 0 ? '+' : '') + fmt(delta);
      $('delta').textContent = 'B-A = ' + value + ' cycle' + (model && Number(model.config.cycleTimeNs) > 0 ? ' / ' + fmt(delta * Number(model.config.cycleTimeNs)) + ' ns' : '');
    }
    function range(nextStart, nextEnd) {
      if (!Number.isFinite(nextStart) || !Number.isFinite(nextEnd) || nextEnd <= nextStart || nextEnd - nextStart < 1e-8) return;
      start = nextStart; end = nextEnd; refreshControls(); drawSoon();
    }
    function fit() { if (model) range(displayMinimum, Math.max(displayMinimum + 1, displayMaximum)); }
    function selectRow(index, locate = false) {
      if (!model || !model.rows[index]) return;
      if (selected !== index || locate) selectedColumn = -1;
      selected = index; highlighted = new Set([index]); highlightedEdges = new Set();
      const row = model.rows[index], relevant = model.issues.filter((item) => item.rows.includes(index));
      relevant.forEach((item) => { item.rows.forEach((id) => highlighted.add(id)); item.edges.forEach((id) => highlightedEdges.add(id)); });
      $('detail-title').textContent = '第' + (index + 1) + '行 · ' + row.name;
      const detail = $('detail'); detail.replaceChildren();
      const paragraph = (text, type) => { const p = doc.createElement('p'); p.textContent = text; if (type) p.className = type; detail.appendChild(p); };
      paragraph(rowStatusName(row), row.status);
      if (!row.reasons.length) paragraph(row.empty ? '空行，未发现连接时延冲突。'
        : row.alignments.length ? '已有连接约束保持不变；其余位置按上一行推算。'
        : '时间已确定；已提供的时延约束一致。没有连接约束的部分仅确定自身时间。');
      row.reasons.forEach((reason) => paragraph(reason));
      row.alignments.forEach((alignment) => paragraph('第' + (alignment.row + 1) + '行原列' + alignment.col
        + ' 按上一行（第' + (alignment.referenceRow + 1) + '行）展开后的同原列时刻对齐至 ' + fmt(alignment.time) + ' cycle'
        + (alignment.referenceExpanded ? '（同值展开区域）' : '')
        + (alignment.row === row.index ? '；连接时延优先。' : '，并经连接约束传递至本行。')));
      if (row.referenceRuns.length) paragraph('原序列参考与主图共用 cycle 轴；实线按已知时刻对齐，虚线及 | ? 仅为未定位置的绘图占位，不参与时延测量。');
      row.gaps.forEach((id) => {
        const gap = model.gaps[id];
        if (gap.ignored) { paragraph('第' + gap.col + '列 |：行尾省略，不影响后续波形或连接端点，无需推算时长。'); return; }
        paragraph('第' + gap.col + '列' + (gap.kind === 'stretch' ? '至' + gap.endCol + '列' + (gap.omissions.length
          ? '未知与省略区域（固定部分 ' + fmt(gap.minimum) + ' cycle，含 ' + gap.omissions.length + ' 个 |）'
          : '同值区域（原时长 ' + fmt(gap.minimum) + ' cycle）') : ' |')
          + '：' + (gap.duration === undefined ? '未定' : fmt(gap.duration) + ' cycle')
          + '；起点 ' + (gap.start === null ? '?' : fmt(gap.start)) + '，终点 ' + (gap.end === null ? '?' : fmt(gap.end))
          + (gap.durationSource === 'previous-row' ? '；来源：上一行对齐' : gap.durationSource === 'connection' ? '；来源：连接时延' : ''));
      });
      model.edges.filter((edge) => edge.fromNode && edge.fromNode.row === index || edge.toNode && edge.toNode.row === index).forEach((edge) => {
        paragraph('连接 ' + (edge.index + 1) + ' ' + edge.from + '→' + edge.to + '：' + (edge.label || '(无标签)')
          + (edge.actual === null ? '；位置未定' : '；计算差值 ' + fmt(edge.actual) + ' cycle')
          + (edge.timing.kind === 'ignored' ? '；不参与时延约束' : ''), edge.status);
      });
      $('locate').disabled = false;
      for (const button of $('row-list').children) button.setAttribute('aria-pressed', String(Number(button.dataset.row) === index));
      if (locate) {
        const top = rowOffsets[index], available = Math.max(0, scroll.clientHeight - ruler);
        const visibleHeight = Math.min(rowOffsets[index + 1] - top, available);
        scroll.scrollTop = Math.max(0, top - (available - visibleHeight) / 2);
        $('position').textContent = '第' + (index + 1) + '行 ' + row.name + ' · ' + rowStatusName(row);
      }
      drawSoon();
    }
    function listRows() {
      $('row-list').replaceChildren();
      if (!model) return;
      const fragment = doc.createDocumentFragment();
      model.rows.forEach((row) => {
        if ($('errors-only').checked && row.status === 'ok') return;
        const button = doc.createElement('button'); button.type = 'button'; button.dataset.row = row.index;
        button.className = 'timing-row-result'; button.setAttribute('aria-pressed', String(row.index === selected));
        const name = doc.createElement('span'); name.textContent = (row.index + 1) + '. ' + row.name;
        const state = doc.createElement('span'); state.textContent = rowStatusName(row); state.className = row.status;
        button.append(name, state); button.title = row.reasons.join('\n'); button.onclick = () => selectRow(row.index, true);
        fragment.appendChild(button);
      });
      $('row-list').appendChild(fragment);
      if (!$('row-list').childElementCount) $('row-list').textContent = model.rows.length ? '没有异常行' : '没有信号行';
    }
    function drawSoon() { if (!frame && !disposed) frame = view.requestAnimationFrame(() => { frame = 0; draw(); }); }
    function firstRun(row, time, reference) {
      const ends = reference ? row.referenceEnds : row.drawEnds;
      let lo = 0, hi = ends.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (ends[mid] < time) lo = mid + 1; else hi = mid; }
      return lo;
    }
    function referenceCell(row, col) {
      let lo = 0, hi = row.referenceRuns.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (row.referenceRuns[mid].end <= col) lo = mid + 1; else hi = mid; }
      const run = row.referenceRuns[lo];
      if (!run || col < run.col) return null;
      const cellWidth = run.stretch ? (run.finish - run.start) / (run.end - run.col) : row.period;
      const omission = run.gap && !run.stretch;
      const start = omission ? run.start : run.start + (col - run.col) * cellWidth;
      return { start, finish: omission ? run.finish : Math.min(run.finish, start + cellWidth) };
    }
    function paintRuns(row, x, from, to, left, right, mid, reference) {
      const runs = reference ? row.referenceRuns : row.drawRuns, scale = (right - left) / (to - from);
      let previousPixel = -Infinity;
      context.save();
      for (let j = firstRun(row, from, reference); j < runs.length; j++) {
        const run = runs[j]; if (run.start > to) break;
        const x1 = Math.max(left, x(run.start)), x2 = Math.min(right, x(run.finish));
        if (x2 <= x1) continue;
        if (x2 - x1 < 1 && x2 < previousPixel + 1) {
          const next = firstRun(row, from + (previousPixel + 1 - left) / scale, reference);
          if (next > j) { j = next - 1; continue; }
        }
        previousPixel = x2;
        const state = run.state.toLowerCase();
        context.strokeStyle = reference && run.provisional ? '#8a5a08' : row.status === 'conflict' ? '#c0393b' : '#235681'; context.lineWidth = 1.5;
        context.setLineDash(reference && run.provisional ? [4, 2] : []);
        if (reference && run.gap && (!run.stretch || run.omission)) {
          context.setLineDash([]); context.fillStyle = '#8a5a08';
          context.fillText(run.provisional ? '| ?' : '|', (x1 + x2) / 2 - 2, mid + 4);
        } else if (state === 'p' || state === 'n') {
          const half = row.period / 2, highFirst = state === 'p';
          if (half * scale < 2) { context.fillStyle = '#c1d4e4'; context.fillRect(x1, mid - 12, x2 - x1, 24); }
          else {
            context.beginPath();
            for (let k = Math.max(0, Math.floor((Math.max(from, run.start) - run.clockOrigin) / half)); run.clockOrigin + k * half < Math.min(to, run.finish); k++) {
              const tx1 = Math.max(x1, x(run.clockOrigin + k * half)), tx2 = Math.min(x2, x(run.clockOrigin + (k + 1) * half));
              const level = ((k % 2 === 0) === highFirst) ? mid - 12 : mid + 12;
              context.moveTo(tx1, level); context.lineTo(tx2, level);
              if (run.clockOrigin + (k + 1) * half <= run.finish) context.lineTo(tx2, 2 * mid - level);
            }
            context.stroke();
          }
        } else if (state === '0' || state === '1' || state === 'l' || state === 'h' || state === 'z') {
          const level = state === '1' || state === 'h' ? mid - 12 : state === 'z' ? mid : mid + 12;
          context.beginPath(); context.moveTo(x1, level); context.lineTo(x2, level);
          const prior = j > 0 ? runs[j - 1] : null;
          if (prior && !(reference && prior.gap && (!prior.stretch || prior.omission)) && Math.abs(prior.finish - run.start) < 1e-7 && prior.state !== run.state) {
            const old = prior.state.toLowerCase();
            if (['0', '1', 'l', 'h'].includes(old)) { context.moveTo(x1, ['1', 'h'].includes(old) ? mid - 12 : mid + 12); context.lineTo(x1, level); }
          }
          context.stroke();
        } else {
          const cap = Math.min(4, (x2 - x1) / 3);
          context.fillStyle = reference ? '#eef1f5' : state === 'bus' ? '#e2f1e8' : '#eceff2';
          context.beginPath(); context.moveTo(x1, mid); context.lineTo(x1 + cap, mid - 12); context.lineTo(x2 - cap, mid - 12);
          context.lineTo(x2, mid); context.lineTo(x2 - cap, mid + 12); context.lineTo(x1 + cap, mid + 12); context.closePath(); context.fill(); context.stroke();
          const text = state === 'bus' ? run.value : 'x'; context.fillStyle = reference ? '#364152' : '#173426';
          if (x2 - x1 > 16) { context.save(); context.beginPath(); context.rect(x1 + 5, mid - 10, Math.max(0, x2 - x1 - 10), 20); context.clip(); context.textAlign = 'center'; context.fillText(text, (x1 + x2) / 2, mid + 4); context.restore(); }
        }
      }
      context.restore();
    }
    function draw() {
      const { width, height, left } = dimensions();
      if (!width || !height) return;
      const ratio = Math.min(view.devicePixelRatio || 1, 2);
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
        canvas.style.width = width + 'px'; canvas.style.height = height + 'px';
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height);
      if (!model) return;
      const scale = Math.max(1, width - left - 16) / (end - start), x = (t) => left + (t - start) * scale;
      const y = (row) => ruler + rowOffsets[row] - scroll.scrollTop;
      const first = Math.max(0, rowAt(scroll.scrollTop));
      const last = Math.min(model.rows.length, rowAt(scroll.scrollTop + height - ruler) + 1);
      updateReferenceToggles(first, last);
      context.font = '12px "Segoe UI", "Microsoft YaHei", sans-serif'; context.lineWidth = 1;
      const rawStep = (end - start) / Math.max(2, (width - left) / 85);
      const power = Math.pow(10, Math.floor(Math.log10(rawStep))), step = [1, 2, 5, 10].find((n) => n * power >= rawStep) * power;
      for (let tick = Math.ceil(start / step) * step, count = 0; tick <= end && count++ < 100; tick += step) {
        const px = x(tick); context.strokeStyle = '#e5e9ee'; context.beginPath(); context.moveTo(px, ruler); context.lineTo(px, height); context.stroke();
      }
      for (let i = first; i < last; i++) {
        const row = model.rows[i], top = y(i), mid = top + 25;
        if (row.status !== 'ok' || highlighted.has(i)) {
          context.fillStyle = row.status === 'conflict' ? '#fff0f0' : row.status === 'unknown' ? '#fff9e9' : '#eaf3ff';
          context.fillRect(0, Math.max(top, ruler), width, rowHeight);
        }
        context.strokeStyle = '#e2e8ed'; context.beginPath(); context.moveTo(0, top + rowHeight); context.lineTo(width, top + rowHeight); context.stroke();
        context.save(); context.beginPath(); context.rect(left, Math.max(ruler, top), width - left, Math.min(rowHeight, height - top)); context.clip();
        paintRuns(row, x, start, end, left, x(end), mid, false);
        row.gaps.forEach((id, gapIndex) => {
          const gap = model.gaps[id];
          if (gap.ignored) {
            if (gap.start !== null && gap.start >= start && gap.start <= end) {
              context.fillStyle = '#667085'; context.fillText('|', Math.min(width - 12, x(gap.start) + 2), mid + 4);
            }
            return;
          }
          if (gap.duration !== undefined && gap.start !== null && gap.end !== null && gap.end > gap.start && row.status !== 'conflict') {
            const x1 = Math.max(left, x(gap.start)), x2 = Math.min(width - 8, x(gap.end));
            if (x2 > x1) {
              const inferred = gap.durationSource === 'previous-row';
              context.strokeStyle = inferred ? '#237963' : '#5277b4'; context.lineWidth = 1; context.setLineDash([4, 3]); context.strokeRect(x1, mid - 16, x2 - x1, 33); context.setLineDash([]);
              context.fillStyle = inferred ? '#21634f' : '#294c81';
              if (x2 - x1 > 45) context.fillText((gap.kind === 'stretch' ? gap.omissions.length ? '未知展开 = ' : '同值展开 = ' : '| = ') + fmt(gap.duration) + (inferred ? ' · 上行' : ''), x1 + 4, top + 55);
            }
          }
          if (gap.duration === undefined || row.status === 'conflict') {
            if (gap.start === null) return;
            let nextAnchor = gap.end !== null ? gap : null;
            for (let nextIndex = gapIndex + 1; !nextAnchor && nextIndex < row.gaps.length; nextIndex++) {
              const next = model.gaps[row.gaps[nextIndex]];
              if (next.end !== null) nextAnchor = next;
            }
            const finish = nextAnchor ? nextAnchor.end : null;
            if (gap.start > end || finish !== null && Math.max(gap.start, finish) < start) return;
            const px = x(gap.start), color = row.status === 'conflict' ? '#b62e3b' : '#8a5a08';
            const far = finish === null ? width - 8 : x(finish);
            const boxLeft = Math.max(left, Math.min(px, far)), boxRight = Math.min(width - 8, Math.max(px + 5, far));
            context.fillStyle = row.status === 'conflict' ? '#ffdddd' : '#ffefbc';
            context.globalAlpha = 0.65; context.fillRect(boxLeft, top + 4, boxRight - boxLeft, rowHeight - 8); context.globalAlpha = 1;
            context.strokeStyle = color; context.lineWidth = 2; context.setLineDash([5, 4]);
            context.strokeRect(boxLeft, top + 4, boxRight - boxLeft, rowHeight - 8); context.setLineDash([]);
            context.fillStyle = color;
            context.fillText((gap.kind === 'stretch' ? gap.omissions.length ? '未知区域 ' : '同值区域 ' : '| ') + (row.status === 'conflict' ? '冲突' : '? 时长分配未定') + ' · 列' + gap.col
              + (nextAnchor && nextAnchor !== gap ? '至' + nextAnchor.col : '') + (finish === null ? ' · 后续位置未定' : ''), boxLeft + 4, top + 55);
          }
        });
        if (row.status !== 'ok') {
          context.strokeStyle = row.status === 'conflict' ? '#c9434b' : '#a97923'; context.lineWidth = 1;
          context.setLineDash(row.status === 'unknown' ? [5, 4] : []);
          context.strokeRect(left + 1, top + 1, width - left - 3, rowHeight - 2); context.setLineDash([]);
          if (row.hasUnpositionedContent && !row.gaps.some((id) => !model.gaps[id].ignored && (model.gaps[id].start !== null || model.gaps[id].end !== null))) {
            context.fillStyle = '#8a5a08'; context.fillText('时间位置未定', left + 8, mid + 4);
          }
        }
        context.restore();
        context.save(); context.beginPath(); context.rect(0, Math.max(ruler, top), left - 1, rowHeight); context.clip();
        context.fillStyle = row.status === 'conflict' ? '#ffe3e3' : row.status === 'unknown' ? '#fff0c8' : highlighted.has(i) ? '#eaf3ff' : '#f4f6f8'; context.fillRect(0, top, left - 1, rowHeight);
        context.fillStyle = '#1b2732'; context.fillText((i + 1) + '. ' + row.name, 30, top + 23);
        context.fillStyle = row.status === 'conflict' ? '#b62e3b' : row.status === 'unknown' ? '#8a5a08' : '#21633d';
        context.fillText(rowStatusName(row), 10, top + 43); context.restore();
      }
      context.save(); context.beginPath(); context.rect(left, ruler, width - left, height - ruler); context.clip();
      context.beginPath();
      for (let i = first; i < last; i++) context.rect(left, y(i), width - left, rowHeight);
      context.clip();
      for (const edge of model.edges) {
        if (edge.start === null || edge.end === null || Math.max(edge.start, edge.end) < start || Math.min(edge.start, edge.end) > end) continue;
        const x1 = x(edge.start), x2 = x(edge.end), y1 = y(edge.fromNode.row) + 25, y2 = y(edge.toNode.row) + 25;
        if (Math.max(y1, y2) < ruler || Math.min(y1, y2) > height) continue;
        context.strokeStyle = edge.status === 'conflict' ? '#bd303e' : edge.status === 'unknown' ? '#946316' : highlightedEdges.has(edge.index) ? '#135bc5' : '#667085';
        context.lineWidth = highlightedEdges.has(edge.index) ? 2.5 : 1;
        context.beginPath(); context.moveTo(x1, y1);
        if (edge.arrow.includes('~')) context.bezierCurveTo((x1 + x2) / 2, y1, (x1 + x2) / 2, y2, x2, y2);
        else if (edge.arrow.includes('|-')) { context.lineTo(x1, y2); context.lineTo(x2, y2); }
        else if (edge.arrow.includes('-|')) { context.lineTo(x2, y1); context.lineTo(x2, y2); }
        else context.lineTo(x2, y2);
        context.stroke();
        const arrow = (px, py, angle) => { context.beginPath(); context.moveTo(px - 7 * Math.cos(angle - 0.45), py - 7 * Math.sin(angle - 0.45)); context.lineTo(px, py); context.lineTo(px - 7 * Math.cos(angle + 0.45), py - 7 * Math.sin(angle + 0.45)); context.stroke(); };
        if (edge.arrow.includes('>')) arrow(x2, y2, Math.atan2(y2 - y1, x2 - x1));
        if (edge.arrow.includes('<')) arrow(x1, y1, Math.atan2(y1 - y2, x1 - x2));
        if (edge.label) {
          const offset = edge.option.labelOffset || {}, text = edge.label, textWidth = Math.min(width - left - 12, context.measureText(text).width);
          const lx = Math.max(left + 6, Math.min(width - textWidth - 6, (x1 + x2 - textWidth) / 2 + (Number(offset.x) || 0)));
          const ly = Math.max(ruler + 14, Math.min(height - 4, (y1 + y2) / 2 - 6 + (Number(offset.y) || 0)));
          context.fillStyle = '#ffffff'; context.fillRect(lx - 1, ly - 11, textWidth + 2, 14); context.fillStyle = context.strokeStyle;
          context.fillText(text, lx, ly, Math.max(1, textWidth));
        }
      }
      context.restore();
      // Reference strips share the time transform, but provisional slots never become timing evidence.
      for (let i = first; i < last; i++) {
        const row = model.rows[i]; if (!referenceOpen(row)) continue;
        const top = y(i) + rowHeight, right = width - 16;
        context.save(); context.beginPath(); context.rect(0, ruler, width, height - ruler); context.clip();
        context.fillStyle = '#f7f8fb'; context.fillRect(0, top, width, referenceHeight);
        context.strokeStyle = '#c5cdd7'; context.lineWidth = 1; context.setLineDash([4, 3]);
        context.beginPath(); context.moveTo(0, top); context.lineTo(width, top); context.stroke(); context.setLineDash([]);
        context.fillStyle = '#475569';
        context.save(); context.beginPath(); context.rect(8, top, left - 16, referenceHeight); context.clip();
        context.fillText('原序列参考', 10, top + 24); context.fillText('虚线：位置未定', 10, top + 44); context.restore();
        context.save(); context.beginPath(); context.rect(left, top + 1, right - left, referenceHeight - 2); context.clip();
        context.fillStyle = '#475569'; context.strokeStyle = '#e5e9ee';
        for (let tick = Math.ceil(start / step) * step, count = 0; tick <= end && count++ < 100; tick += step) {
          const px = x(tick); context.beginPath(); context.moveTo(px, top + 1); context.lineTo(px, top + referenceHeight); context.stroke();
          context.fillText(fmt(tick), px + 3, top + 63);
        }
        paintRuns(row, x, start, end, left, right, top + 27, true);
        if (selected === i && selectedColumn >= 0 && selectedColumn < row.sourceLength) {
          const cell = referenceCell(row, selectedColumn);
          if (cell) { context.strokeStyle = '#135bc5'; context.lineWidth = 2; context.strokeRect(x(cell.start), top + 10, Math.max(2, x(cell.finish) - x(cell.start)), 34); }
        }
        context.restore();
        context.strokeStyle = '#c5cdd7'; context.lineWidth = 1; context.beginPath(); context.moveTo(0, top + referenceHeight); context.lineTo(width, top + referenceHeight); context.stroke();
        context.restore();
      }
      context.fillStyle = '#f0f3f7'; context.fillRect(0, 0, width, ruler); context.fillStyle = '#3f5063'; context.textAlign = 'left';
      for (let tick = Math.ceil(start / step) * step, count = 0; tick <= end && count++ < 100; tick += step) context.fillText(fmt(tick), x(tick) + 3, 21);
      [['a', a, '#b75514'], ['b', b, '#6744ad']].forEach(([key, value, color]) => {
        const px = x(value); if (px < left || px > width - 8) return;
        context.strokeStyle = color; context.lineWidth = active === key ? 2 : 1; context.setLineDash([5, 3]);
        context.save(); context.beginPath(); context.rect(left, ruler, width - left, height - ruler); context.clip();
        context.beginPath();
        for (let i = first; i < last; i++) { context.moveTo(px, Math.max(ruler, y(i))); context.lineTo(px, Math.min(height, y(i) + rowHeight)); }
        context.stroke(); context.restore(); context.setLineDash([]);
        context.fillStyle = color; context.fillRect(px - 9, 0, 18, 15); context.fillStyle = '#ffffff'; context.fillText(key.toUpperCase(), px - 4, 12);
      });
      // Draw selection last so warning fills, reference strips and connections cannot hide it.
      context.save(); context.beginPath(); context.rect(0, ruler, width, height - ruler); context.clip();
      for (let i = first; i < last; i++) {
        if (!highlighted.has(i)) continue;
        context.strokeStyle = '#135bc5'; context.lineWidth = i === selected ? 2.5 : 1;
        context.setLineDash(i === selected ? [] : [5, 4]);
        context.strokeRect(2, y(i) + 2, width - 4, rowOffsets[i + 1] - rowOffsets[i] - 4);
      }
      context.restore();
    }
    function receive(result) {
      const firstResult = !model;
      model = result;
      for (const index of referenceOverrides.keys()) if (index >= model.rows.length) referenceOverrides.delete(index);
      layoutRows();
      if (!model.rows[selected]?.referenceRuns.length || selectedColumn >= model.rows[selected].sourceLength) selectedColumn = -1;
      const counts = { ok: 0, unknown: 0, conflict: 0 }; model.rows.forEach((row) => counts[row.status]++);
      const alignedCount = model.rows.filter((row) => row.alignments.length).length;
      const orphan = model.issues.filter((item) => !item.rows.length).map((item) => item.reason);
      message('已确定 ' + counts.ok + ' 行 · 时延冲突 ' + counts.conflict + ' 行 · 无法判断 ' + counts.unknown + ' 行'
        + (alignedCount ? ' · 上行对齐 ' + alignedCount + ' 行' : '')
        + (orphan.length ? ' · ' + orphan.join('；') : '') + (counts.conflict ? ' · 冲突行仅供定位，不能作为对齐结论' : ''), false);
      listRows();
      if (selected >= model.rows.length) selected = -1;
      if (selected >= 0) selectRow(selected);
      else if (model.rows.length) selectRow(model.rows.findIndex((row) => row.status !== 'ok') >= 0 ? model.rows.findIndex((row) => row.status !== 'ok') : 0, firstResult);
      else { $('detail').textContent = '没有可检查的信号'; $('locate').disabled = true; }
      if (firstResult) { a = model.minimum; b = model.minimum; fit(); }
      refreshControls(); drawSoon();
      host.log && host.log({ phase: 'checked', rows: model.rows.length, gaps: model.gaps.length, counts, alignedRows: alignedCount, elapsedMs: Math.round(performance.now() - requestTime) });
    }
    async function refresh() {
      if (disposed || reading || view.closed) return;
      reading = true;
      try {
        const snapshot = await host.read();
        if (disposed || view.closed || snapshot.source === source) return;
        source = snapshot.source;
        $('title').textContent = snapshot.title; doc.title = snapshot.title + ' · 时延检查';
        const config = source.timingCheck || {}, nextKey = JSON.stringify(config);
        if (nextKey !== configKey) {
          configKey = nextKey; $('period').value = config.cycleTimeNs || ''; $('tolerance').value = config.tolerance ?? 1e-7;
          $('fill').value = config.gapContent === 'unknown' ? 'unknown' : 'hold';
        }
        if (worker) worker.terminate();
        const current = ++version; requestTime = performance.now();
        message(model ? '正在重新检查，当前为上次结果...' : '正在计算连接时延...');
        const script = 'const engine=(' + global.createVisualWaveDromTimingEngine.toString() + ')();onmessage=(e)=>{try{postMessage({result:engine.analyze(e.data)})}catch(error){postMessage({error:error.message})}};';
        const url = URL.createObjectURL(new Blob([script], { type: 'text/javascript' }));
        try { worker = new Worker(url); } finally { URL.revokeObjectURL(url); }
        worker.onmessage = (event) => {
          if (disposed || current !== version) return;
          if (event.data.error) { message('检查失败：' + event.data.error + (model ? '（画面保留上次结果）' : ''), true); host.log && host.log({ phase: 'error', message: event.data.error }); }
          else receive(event.data.result);
          worker.terminate(); worker = null;
        };
        worker.onerror = (event) => { if (current === version && !disposed) { message('后台检查失败：' + event.message, true); worker.terminate(); worker = null; } };
        worker.postMessage(source);
      } catch (error) {
        version++; if (worker) worker.terminate(); worker = null; source = null;
        message('无法检查：' + error.message + (model ? '（画面保留上次结果）' : ''), true);
      } finally { reading = false; }
    }
    function dispose() {
      if (disposed) return;
      disposed = true; clearInterval(timer); if (worker) worker.terminate(); if (frame) view.cancelAnimationFrame(frame);
      observer.disconnect(); sessions.delete(host.id);
    }
    $('close').onclick = () => view.close();
    $('config').onsubmit = async (event) => {
      event.preventDefault();
      const periodText = $('period').value, period = Number(periodText), tolerance = Number($('tolerance').value);
      if (periodText && (!(period > 0) || !Number.isFinite(period)) || !Number.isFinite(tolerance) || tolerance < 0) {
        $('config-status').textContent = '周期必须为正数，容差必须为非负数'; return;
      }
      const config = { tolerance, gapContent: $('fill').value };
      if (periodText) config.cycleTimeNs = period;
      $('apply').disabled = true;
      try { await host.apply(config); $('config-status').textContent = '已应用；正式保存请使用保存波形库'; await refresh(); }
      catch (error) { $('config-status').textContent = error.message; }
      finally { $('apply').disabled = false; }
    };
    $('errors-only').onchange = listRows;
    $('locate').innerHTML = icon('locate') + '<span>定位原图</span>'; $('locate').disabled = true;
    $('locate').onclick = () => { if (selected >= 0) Promise.resolve(host.locate(selected, selectedColumn >= 0 ? [selectedColumn] : model.rows[selected].gaps.map((id) => model.gaps[id].col))).catch((error) => message(error.message, true)); };
    $('fit').onclick = fit;
    $('reference-all').onclick = () => {
      if (!model) return;
      referenceDefault = $('reference-all').dataset.expanded !== 'true'; referenceOverrides.clear(); layoutRows();
    };
    function zoom(factor) { const pivot = active === 'a' ? a : b, center = pivot >= start && pivot <= end ? pivot : (start + end) / 2; range(center - (center - start) * factor, center + (end - center) * factor); }
    $('zoom-in').onclick = () => zoom(0.5); $('zoom-out').onclick = () => zoom(2);
    $('start').onchange = $('end').onchange = () => { range(Number($('start').value), Number($('end').value)); refreshControls(); };
    $('pan').oninput = () => { if (!model) return; const width = end - start, room = Math.max(0, displayMaximum - displayMinimum - width); const next = displayMinimum + Number($('pan').value) / 100000 * room; range(next, next + width); };
    ['a', 'b'].forEach((key) => {
      $('pick-' + key).onclick = () => { active = key; refreshControls(); drawSoon(); };
      $(key).onchange = () => { const value = Number($(key).value); if (!Number.isFinite(value)) return; if (key === 'a') a = value; else b = value; refreshControls(); drawSoon(); };
    });
    function pointer(event, choose) {
      if (!model) return;
      const bounds = scroll.getBoundingClientRect(), { width, left } = dimensions(), px = event.clientX - bounds.left, py = event.clientY - bounds.top;
      const rowIndex = rowAt(py - ruler + scroll.scrollTop), row = model.rows[rowIndex];
      const inReference = py >= ruler && row && referenceOpen(row) && py - ruler + scroll.scrollTop - rowOffsets[rowIndex] >= rowHeight;
      if (choose && row && py >= ruler) selectRow(rowIndex);
      if (choose && !inReference) selectedColumn = -1;
      if (px < left || px > width - 8) return;
      if (inReference) {
        if (selected !== rowIndex) selectRow(rowIndex);
        const value = start + (px - left) / Math.max(1, width - left - 16) * (end - start);
        let index = firstRun(row, value, true);
        if (row.referenceRuns[index]?.finish <= value) index++;
        const run = row.referenceRuns[index];
        const cellWidth = run && run.stretch ? (run.finish - run.start) / (run.end - run.col) : row.period;
        selectedColumn = run && run.start <= value ? Math.min(run.end - 1, run.col + (run.gap && !run.stretch ? 0 : Math.floor((value - run.start) / cellWidth))) : -1;
        $('position').textContent = '第' + (rowIndex + 1) + '行 ' + row.name + (selectedColumn < 0 ? ' · 该处没有参考波形'
          : ' · 原列号 ' + selectedColumn + (run.provisional ? ' · 位置未定，仅绘图占位' : ' · ' + fmt(value) + ' cycle · 原序列参考'));
        drawSoon(); return;
      }
      selectedColumn = -1;
      let value = start + (px - left) / Math.max(1, width - left - 16) * (end - start);
      const radius = 8 / Math.max(1, width - left - 16) * (end - start);
      let nearest = value, distance = radius;
      if (row) {
        for (let i = firstRun(row, value - radius); i < row.drawRuns.length && row.drawRuns[i].start <= value + radius; i++) {
          const run = row.drawRuns[i], candidates = [run.start, run.finish];
          if (/[pn]/i.test(run.state)) candidates.push(run.clockOrigin + Math.round((value - run.clockOrigin) / (row.period / 2)) * row.period / 2);
          for (const candidate of candidates) if (Math.abs(candidate - value) < distance) { nearest = candidate; distance = Math.abs(candidate - value); }
        }
      }
      value = distance < radius ? nearest : Math.round(value * 2) / 2;
      if (active === 'a') a = value; else b = value;
      $('position').textContent = (row ? '第' + (rowIndex + 1) + '行 ' + row.name + ' · ' : '') + fmt(value) + ' cycle · 展开预览只读';
      refreshControls(); drawSoon();
    }
    scroll.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !model) return;
      const bounds = scroll.getBoundingClientRect(), { left, width } = dimensions();
      if (event.clientY - bounds.top < ruler) {
        const value = start + (event.clientX - bounds.left - left) / Math.max(1, width - left - 16) * (end - start);
        active = Math.abs(value - a) <= Math.abs(value - b) ? 'a' : 'b';
      }
      drag = event.pointerId; scroll.setPointerCapture(event.pointerId); pointer(event, true);
    });
    scroll.addEventListener('pointermove', (event) => { if (drag === event.pointerId) pointer(event, false); });
    scroll.addEventListener('pointerup', () => { drag = null; }); scroll.addEventListener('pointercancel', () => { drag = null; });
    scroll.addEventListener('scroll', drawSoon, { passive: true });
    canvas.parentElement.addEventListener('wheel', (event) => {
      if (event.ctrlKey) { event.preventDefault(); zoom(event.deltaY > 0 ? 1.2 : 1 / 1.2); }
      else if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) { event.preventDefault(); const delta = (event.deltaX || event.deltaY) / Math.max(1, scroll.clientWidth) * (end - start); range(start + delta, end + delta); }
      else if ($('row-toggles').contains(event.target)) { event.preventDefault(); scroll.scrollTop += event.deltaY; }
    }, { passive: false });
    doc.addEventListener('keydown', (event) => { if (event.key === 'Escape') { highlighted.clear(); highlightedEdges.clear(); drawSoon(); } });
    const observer = new view.ResizeObserver(drawSoon); observer.observe(scroll);
    view.addEventListener('pagehide', dispose, { once: true });
    timer = setInterval(() => { if (view.closed) dispose(); else void refresh(); }, 600);
    void refresh();
    return view;
  }
  global.VisualWaveDromTiming = { open };
})(window);

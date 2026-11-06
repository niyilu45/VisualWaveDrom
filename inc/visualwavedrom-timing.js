(function (global) {
  'use strict';
  const sessions = new Map();
  const statusNames = { ok: '已确定', unknown: '无法判断', conflict: '时延冲突' };
  const alignmentNames = { 'previous-row': '上行对齐', 'next-row': '下行对齐', 'adjacent-rows': '上下行对齐', 'data-series': '等差补全', 'mixed-sources': '混合推算' };
  // Match the data fills in inc/skins/default.js; '=' uses type 2.
  const dataColors = { '=': '#ffffff', '2': '#ffffff', '3': '#ffffb4', '4': '#ffe0b9', '5': '#b9e0ff',
    '6': '#ccfdfe', '7': '#cdfdc5', '8': '#f0c1fb', '9': '#f5c2c0' };
  const rowStatusName = (row) => {
    if (row.status !== 'ok' || !row.alignments.length) return statusNames[row.status];
    const directions = new Set(row.alignments.map((entry) => entry.direction));
    return alignmentNames[directions.size > 1 ? directions.has('data-series') ? 'mixed-sources' : 'adjacent-rows' : row.alignments[0].direction];
  };
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
    stylesheet.href = new URL('inc/visualwavedrom-timing.css?v=timing-split-original-v1', document.baseURI).href;
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
          <div id="timing-plots" class="timing-plots">
          <section id="timing-original-pane" class="timing-pane" aria-label="原始波形区域">
            <div class="timing-toolbar timing-range">
              <h2>原始波形</h2>
              <button type="button" id="timing-original-zoom-out" title="缩小原始波形" aria-label="缩小原始波形">${icon('minus')}</button>
              <button type="button" id="timing-original-zoom-in" title="放大原始波形" aria-label="放大原始波形">${icon('plus')}</button>
              <button type="button" id="timing-original-fit" title="适应原始波形" aria-label="适应原始波形">${icon('fit')}</button>
              <label>起点 <input id="timing-original-start" type="number" step="any" value="0" aria-label="原始波形起点"></label>
              <label>终点 <input id="timing-original-end" type="number" step="any" value="10" aria-label="原始波形终点"></label><span>cycle</span>
              <button type="button" id="timing-hide-original" aria-controls="timing-original-pane">隐藏</button>
            </div>
            <div class="timing-plot"><canvas id="timing-original-canvas" aria-label="原始 cycle 标定的时序图"></canvas><div id="timing-original-scroll" class="timing-scroll" tabindex="0" role="region" aria-label="原始波形"><div id="timing-original-spacer"></div></div></div>
            <div id="timing-original-pan" class="timing-pan"><div id="timing-original-pan-thumb" class="timing-pan-thumb" role="scrollbar" tabindex="-1" aria-orientation="horizontal" aria-controls="timing-original-scroll" aria-label="横向浏览原始波形" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" aria-disabled="true"></div></div>
          </section>
          <div id="timing-splitter" role="separator" tabindex="0" aria-label="调整上下波形区域高度" aria-orientation="horizontal" aria-controls="timing-original-pane timing-expanded-pane" aria-valuemin="15" aria-valuemax="85" aria-valuenow="50" title="拖动调整上下波形区域高度"></div>
          <section id="timing-expanded-pane" class="timing-pane" aria-label="展开波形区域">
          <div class="timing-toolbar timing-range">
            <h2>展开波形</h2>
            <button type="button" id="timing-zoom-out" title="缩小" aria-label="缩小">${icon('minus')}</button>
            <button type="button" id="timing-zoom-in" title="放大" aria-label="放大">${icon('plus')}</button>
            <button type="button" id="timing-fit" title="适应展开波形" aria-label="适应展开波形">${icon('fit')}</button>
            <label>起点 <input id="timing-start" type="number" step="any" value="0"></label>
            <label>终点 <input id="timing-end" type="number" step="any" value="10"></label><span>cycle</span>
            <button type="button" id="timing-show-original" aria-controls="timing-original-pane" hidden>显示原始波形</button>
          </div>
          <div class="timing-toolbar timing-cursors">
            <button type="button" id="timing-pick-a" aria-pressed="true">游标 A</button><input id="timing-a" type="number" step="any" value="0" aria-label="游标 A 时间">
            <button type="button" id="timing-pick-b" aria-pressed="false">游标 B</button><input id="timing-b" type="number" step="any" value="0" aria-label="游标 B 时间">
            <output id="timing-delta">B-A = 0 cycle</output>
          </div>
          <div class="timing-plot"><canvas id="timing-canvas" aria-label="展开后的时序图"></canvas><div id="timing-scroll" class="timing-scroll" tabindex="0" role="region" aria-label="展开波形，点击设置当前游标"><div id="timing-spacer"></div></div></div>
          <div id="timing-pan" class="timing-pan"><div id="timing-pan-thumb" class="timing-pan-thumb" role="scrollbar" tabindex="-1" aria-orientation="horizontal" aria-controls="timing-scroll" aria-label="横向浏览已确定时间范围" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" aria-disabled="true"></div></div>
          </section>
          </div>
          <footer id="timing-position">列号从 0 开始 · 展开预览只读</footer>
        </main>
      </div>`;
    const $ = (id) => doc.getElementById('timing-' + id);
    const core = global.VisualWaveDromTimingCore, fmt = core.format;
    let source = null, model = null, worker = null, version = 0, timer = 0, disposed = false, reading = false;
    let start = 0, end = 10, active = 'a', a = 0, b = 0, selected = -1, highlighted = new Set(), highlightedEdges = new Set();
    let frame = 0, drag = null, panDrag = null, configKey = '', requestTime = 0, selectedColumn = -1, rowOffsets = [0];
    let focusedProblem = null;
    let displayMinimum = 0, displayMaximum = 1, originalMinimum = 0, originalMaximum = 1;
    let originalStart = 0, originalEnd = 10, originalVisible = true, splitRatio = 0.5, splitDrag = null;
    const expectedScroll = new Map();
    const rowHeight = 64, ruler = 34;
    const canvas = $('canvas'), scroll = $('scroll'), context = canvas.getContext('2d');
    const originalCanvas = $('original-canvas'), originalScroll = $('original-scroll'), originalContext = originalCanvas.getContext('2d');
    const dimensions = (surface = scroll) => ({ width: surface.clientWidth, height: surface.clientHeight, left: Math.min(190, Math.max(105, surface.clientWidth * 0.25)) });
    function rowAt(offset) {
      if (offset < 0) return -1;
      let lo = 0, hi = rowOffsets.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (rowOffsets[mid + 1] <= offset) lo = mid + 1; else hi = mid; }
      return lo;
    }
    function layoutRows() {
      const anchor = rowAt(scroll.scrollTop), offset = scroll.scrollTop - (rowOffsets[anchor] || 0);
      rowOffsets = [0]; displayMinimum = model.minimum; displayMaximum = model.maximum;
      model.rows.forEach(() => rowOffsets.push(rowOffsets[rowOffsets.length - 1] + rowHeight));
      updateScrollExtents();
      if (anchor >= 0 && anchor < model.rows.length) scroll.scrollTop = rowOffsets[anchor]
        + Math.min(offset, rowOffsets[anchor + 1] - rowOffsets[anchor] - 1);
      originalMinimum = 0; originalMaximum = 1;
      (model.originalRows || []).forEach((row) => {
        originalMinimum = Math.min(originalMinimum, -row.phase);
        originalMaximum = Math.max(originalMaximum, row.length * row.period - row.phase);
      });
      range(start, end);
      originalRange(originalStart, originalEnd);
      syncVerticalScroll(scroll, originalScroll);
    }
    function message(value, error) { $('status').textContent = value; $('status').classList.toggle('error', !!error); }
    function fullSpan() { return Math.max(1, displayMaximum - displayMinimum); }
    function refreshControls() {
      $('start').value = fmt(start); $('end').value = fmt(end);
      const fullyVisible = end - start >= fullSpan() * (1 - 1e-10);
      $('zoom-out').disabled = !model || fullyVisible;
      $('zoom-out').title = model && fullyVisible ? '已显示全部波形，不能继续缩小' : '缩小';
      const total = model ? fullSpan() : 1, visible = model ? Math.min(total, end - start) : total;
      const room = fullyVisible || !model ? 0 : Math.max(0, total - visible), thumb = $('pan-thumb');
      thumb.style.width = (visible / total * 100) + '%';
      thumb.style.left = (model ? (start - displayMinimum) / total * 100 : 0) + '%';
      thumb.setAttribute('aria-valuemin', String(model ? displayMinimum : 0));
      thumb.setAttribute('aria-valuemax', String(model ? displayMinimum + room : 0));
      thumb.setAttribute('aria-valuenow', String(model ? start : 0));
      thumb.setAttribute('aria-valuetext', fmt(start) + ' 至 ' + fmt(end) + ' cycle，显示 ' + fmt(visible / total * 100) + '%');
      thumb.setAttribute('aria-disabled', String(!room)); thumb.tabIndex = room ? 0 : -1;
      $('pan').title = room ? '横向浏览：' + fmt(start) + ' 至 ' + fmt(end) + ' cycle' : '已显示全部波形';
      $('a').value = fmt(a); $('b').value = fmt(b);
      $('pick-a').setAttribute('aria-pressed', String(active === 'a')); $('pick-b').setAttribute('aria-pressed', String(active === 'b'));
      const delta = b - a, value = (delta > 0 ? '+' : '') + fmt(delta);
      $('delta').textContent = 'B-A = ' + value + ' cycle' + (model && Number(model.config.cycleTimeNs) > 0 ? ' / ' + fmt(delta * Number(model.config.cycleTimeNs)) + ' ns' : '');
    }
    function range(nextStart, nextEnd) {
      const width = nextEnd - nextStart;
      if (!Number.isFinite(nextStart) || !Number.isFinite(nextEnd) || !Number.isFinite(width) || width < 1e-8) return;
      if (model) {
        const maximumWidth = fullSpan();
        if (width >= maximumWidth) { nextStart = displayMinimum; nextEnd = displayMinimum + maximumWidth; }
        else {
          nextStart = Math.max(displayMinimum, Math.min(displayMinimum + maximumWidth - width, nextStart));
          nextEnd = nextStart + width;
        }
      }
      start = nextStart; end = nextEnd; refreshControls(); drawSoon();
    }
    function fit() { if (model) range(displayMinimum, displayMinimum + fullSpan()); }
    function originalSpan() { return Math.max(1e-8, originalMaximum - originalMinimum); }
    function refreshOriginalControls() {
      $('original-start').value = fmt(originalStart); $('original-end').value = fmt(originalEnd);
      const total = originalSpan(), visible = Math.min(total, originalEnd - originalStart), room = Math.max(0, total - visible);
      $('original-zoom-out').disabled = !model || !room;
      const thumb = $('original-pan-thumb');
      thumb.style.width = visible / total * 100 + '%';
      thumb.style.left = (originalStart - originalMinimum) / total * 100 + '%';
      thumb.setAttribute('aria-valuemin', String(originalMinimum));
      thumb.setAttribute('aria-valuemax', String(originalMinimum + room));
      thumb.setAttribute('aria-valuenow', String(originalStart));
      thumb.setAttribute('aria-valuetext', fmt(originalStart) + ' 至 ' + fmt(originalEnd) + ' cycle');
      thumb.setAttribute('aria-disabled', String(!model || !room)); thumb.tabIndex = model && room ? 0 : -1;
    }
    function originalRange(nextStart, nextEnd) {
      const span = nextEnd - nextStart;
      if (!Number.isFinite(nextStart) || !Number.isFinite(nextEnd) || !Number.isFinite(span) || span < 1e-8) return;
      const width = Math.min(span, originalSpan());
      originalStart = Math.max(originalMinimum, Math.min(originalMaximum - width, nextStart)); originalEnd = originalStart + width;
      refreshOriginalControls(); drawSoon();
    }
    function fitOriginal() { if (model) originalRange(originalMinimum, originalMaximum); }
    function setScrollTop(surface, top) {
      const next = Math.max(0, Math.min(surface.scrollHeight - surface.clientHeight, top));
      if (Math.abs(surface.scrollTop - next) < 0.5) return;
      expectedScroll.set(surface, next); surface.scrollTop = next;
    }
    function syncVerticalScroll(from, to) {
      if (originalVisible) setScrollTop(to, from.scrollTop);
    }
    function updateScrollExtents() {
      if (!model) return;
      const minimum = originalVisible ? Math.min(scroll.clientHeight, originalScroll.clientHeight) : scroll.clientHeight;
      const height = ruler + rowOffsets[rowOffsets.length - 1];
      // Equalize scroll limits even when the toolbars or splitter change pane heights.
      for (const [surface, spacer] of [[scroll, $('spacer')], [originalScroll, $('original-spacer')]])
        spacer.style.height = (height + Math.max(0, surface.clientHeight - minimum)) + 'px';
    }
    function locateRow(index) {
      updateScrollExtents();
      const available = Math.max(0, Math.min(scroll.clientHeight, originalVisible ? originalScroll.clientHeight : Infinity) - ruler);
      const top = Math.max(0, rowOffsets[index] - Math.max(0, available - rowHeight) / 2);
      setScrollTop(scroll, top); setScrollTop(originalScroll, top);
    }
    function updateSplit(next) {
      const height = Math.max(1, $('plots').clientHeight - 8);
      const minimum = pane => Array.from(pane.querySelectorAll('.timing-toolbar,.timing-pan')).reduce((sum, node) => sum + node.offsetHeight, rowHeight + 8);
      let low = Math.max(0.15, minimum($('original-pane')) / height), high = Math.min(0.85, 1 - minimum($('expanded-pane')) / height);
      if (low > high) { low = 0.15; high = 0.85; }
      splitRatio = Math.max(low, Math.min(high, next));
      $('plots').style.gridTemplateRows = originalVisible ? 'minmax(0, ' + splitRatio + 'fr) 8px minmax(0, ' + (1 - splitRatio) + 'fr)' : 'minmax(0, 1fr)';
      $('splitter').setAttribute('aria-valuemin', String(Math.round(low * 100)));
      $('splitter').setAttribute('aria-valuemax', String(Math.round(high * 100)));
      $('splitter').setAttribute('aria-valuenow', String(Math.round(splitRatio * 100)));
      updateScrollExtents();
      drawSoon();
    }
    function showOriginal(visible) {
      originalVisible = visible; $('original-pane').hidden = !visible; $('splitter').hidden = !visible;
      $('show-original').hidden = visible; updateSplit(splitRatio);
      if (visible) syncVerticalScroll(scroll, originalScroll);
      else { originalCanvas.width = originalCanvas.height = 0; $('show-original').focus({ preventScroll: true }); }
      host.log && host.log({ phase: 'split-layout', originalVisible, splitRatio });
    }
    function originalInterval(index, target) {
      const row = model.originalRows?.[index]; if (!row || !target) return null;
      return Object.assign({}, target, { start: target.col * row.period - row.phase, finish: target.end * row.period - row.phase });
    }
    function problemRange(row, target) {
      if (!target) return null;
      const marked = row.conflictRanges.concat(row.dataUnknownRanges, row.unknownRanges || [], row.unpositionedRanges || [])
        .find((item) => item.col === target.col && item.end === target.end);
      if (marked) return marked;
      const gap = row.gaps.map((id) => model.gaps[id]).find((item) => item.col === target.gapCol);
      if (!gap) return null;
      return { col: gap.col, end: gap.endCol ?? gap.col + 1, start: gap.start, finish: gap.end };
    }
    function locateProblem(index, target) {
      const row = model?.rows[index]; if (!row) return;
      const interval = problemRange(row, target);
      focusedProblem = target ? { row: index, target: { col: target.col, end: target.end, gapCol: target.gapCol } } : null;
      const reference = !!interval && (!Number.isFinite(interval.start) || !Number.isFinite(interval.finish));
      const from = interval?.start, to = interval?.finish;
      if (Number.isFinite(from) && Number.isFinite(to)) {
        const low = Math.min(from, to), high = Math.max(from, to);
        const minimum = Math.min(displayMinimum, low), maximum = Math.max(displayMaximum, high);
        const span = Math.min(maximum - minimum, Math.max((high - low) * 1.5, Math.min(end - start, row.period * 8)));
        const next = Math.max(minimum, Math.min(maximum - span, (low + high - span) / 2));
        range(next, next + span);
      } else {
        const knownBoundary = [from, to].find(Number.isFinite)
          ?? row.gaps.map(id => model.gaps[id]).filter(gap => gap.col <= (target?.col ?? Infinity) && Number.isFinite(gap.start)).at(-1)?.start;
        if (Number.isFinite(knownBoundary)) {
          const width = Math.min(end - start, row.period * 8);
          range(knownBoundary - width / 4, knownBoundary + width * 3 / 4);
        }
      }
      const original = originalInterval(index, interval || target);
      if (original) {
        const width = Math.max((original.finish - original.start) * 1.5, Math.min(originalEnd - originalStart, (model.originalRows[index].period || 1) * 8));
        originalRange((original.start + original.finish - width) / 2, (original.start + original.finish + width) / 2);
      }
      locateRow(index);
      selectedColumn = interval ? interval.col : target?.col ?? -1;
      $('position').textContent = '第' + (index + 1) + '行 ' + row.name + (interval ? ' · '
        + (interval.number ? '[' + interval.number + '] ' : '') + '原列' + interval.col + (interval.end > interval.col ? '至' + interval.end : '')
        + (reference ? ' · 展开时刻未定，已定位原始列' : '') : ' · 该项涉及整行');
      for (const button of $('detail').querySelectorAll('.timing-problem-link'))
        button.setAttribute('aria-current', String(button.dataset.col === String(target?.col) && button.dataset.end === String(target?.end)));
      drawSoon();
      host.log && host.log({ phase: 'locate-problem', row: index, col: selectedColumn,
        original: original ? [original.start, original.finish] : null, expanded: interval ? [from, to] : null });
    }
    function unknownProblems(row, issues) {
      const results = [], seen = new Set(), rangesByIssue = new Map();
      (row.unknownRanges || []).forEach((range) => {
        if (!rangesByIssue.has(range.issueId)) rangesByIssue.set(range.issueId, []);
        rangesByIssue.get(range.issueId).push(range);
      });
      const location = (range) => !range ? '整行' : '原列 ' + range.col
        + (range.end > range.col + 1 ? '～' + (range.end - 1) : range.end === range.col ? ' 的边沿' : '');
      function add(target, type, label, reason, scope) {
        const at = scope || location(target), key = JSON.stringify([target?.col, target?.end, type, label, reason]);
        if (seen.has(key)) return;
        seen.add(key);
        results.push({ col: target?.col ?? -1, target, type, unknown: true,
          preview: at + '：' + label, text: at + '：' + label + (reason ? '；' + reason : '') + '。' });
      }
      issues.forEach(({ entry, issueId }) => {
        if (entry.reason === '相对时延已确定，但缺少与共同起点的时间关系'
            && (!row.supported || row.unpositionedRanges?.length)) return;
        const ranges = rangesByIssue.get(issueId) || [];
        const gaps = entry.gaps.map((id) => model.gaps[id]).filter((gap) => gap.row === row.index && !gap.ignored);
        if (gaps.length) {
          gaps.forEach((gap) => {
            const range = ranges.find((range) => range.gap === gap.index);
            const target = gap.duration === undefined ? range : row.dataUnknownRanges.find((range) =>
              range.col <= gap.col && range.end > gap.col) || range;
            const reason = gap.seriesReason ? gap.seriesReason.split('；')[0] : '';
            const omissions = gap.omissions || [];
            const scope = omissions.length ? location(target) + '（| 在原列 ' + omissions.slice(0, 3).join('、')
              + (omissions.length > 3 ? ' 等 ' + omissions.length + ' 处' : '') + '）' : undefined;
            if (gap.duration === undefined) add(target, 'duration', gap.kind === 'stretch' ? '保持区间时长未定' : '省略时长未定',
              reason || '缺少可确定该段长度的连接时延或相邻行锚点', scope);
            else add(target, 'data', '数据内容未定', (gap.kind === 'stretch' ? '展开区间' : '| 省略部分')
              + '时长已确定为 ' + fmt(gap.duration) + ' cycle'
              + (reason ? '；' + reason : '，但无法唯一推断中间的数据'));
          });
        } else if (entry.edges.length) {
          entry.edges.forEach((id) => {
            const edge = model.edges[id], scope = '连接 ' + (id + 1) + ' ' + edge.from + '→' + edge.to;
            const reason = edge.invalid ? entry.reason : edge.timing.reason || entry.reason;
            const target = ranges.find((range) => [edge.fromNode, edge.toNode].some((node) =>
              node?.row === row.index && node.col >= range.col && node.col <= range.end));
            add(target, 'edge', edge.invalid ? '端点位置未定' : '时延标签无法识别',
              (edge.label ? '标签“' + edge.label + '”；' : '') + reason,
              scope + (target ? '（' + location(target) + '）' : ''));
          });
        } else if (ranges.length) {
          ranges.filter((range) => range.gap === undefined).forEach((range) =>
            add(range, 'location', '连接位置未定', entry.reason));
        } else {
          add(null, 'row', entry.reason, '');
        }
      });
      (row.unpositionedRanges || []).forEach((range) => {
        const previousGap = row.gaps.some((id) => {
          const gap = model.gaps[id];
          return !gap.ignored && gap.duration === undefined && gap.col < range.col;
        });
        add(range, 'position', '时刻未定', previousGap ? '前面的省略时长尚未确定，该区间不能定位到具体 cycle'
          : '缺少与共同起点的时间关系，不能定位到具体 cycle');
      });
      results.sort((a, b) => a.col - b.col || (a.target?.end || 0) - (b.target?.end || 0));
      results.forEach((item, index) => { item.text = '[未定 ' + (index + 1) + '] ' + item.text; });
      return results;
    }
    function conflictValueAt(row, cycle) {
      if (!row || !Number.isFinite(cycle)) return { text: '位置未定', data: false };
      let found = null;
      for (let index = firstRun(row, cycle); index < row.drawRuns.length; index++) {
        const run = row.drawRuns[index];
        if (run.start > cycle) break;
        if (cycle >= run.finish) continue;
        const state = run.state.toLowerCase();
        let text = run.value, data = state === 'bus';
        if (run.unresolvedData) text = '数据未定';
        else if (run.series) {
          const sample = Math.floor((cycle - run.start) / run.series.cellDuration);
          if (sample < 0 || sample >= run.series.count) continue;
          text = core.seriesLabel(run.series.first + sample * run.series.step, run.series.style);
          data = true;
        } else if (state === 'p' || state === 'n') {
          const even = Math.floor((cycle - run.clockOrigin) / (row.period / 2)) % 2 === 0;
          text = (even === (state === 'p')) ? '1' : '0';
        } else if (state === 'x') text = '未知 x';
        else if (state === 'h') text = '1';
        else if (state === 'l') text = '0';
        text = text == null || text === '' ? '空文本' : String(text).replace(/\r?\n/g, '\\n');
        if (found && found.text !== text) return { text: '重叠未定', data: found.data || data };
        found = { text, data };
      }
      return found || { text: '无波形', data: false };
    }
    function selectRow(index, locate = false) {
      if (!model || !model.rows[index]) return;
      const keepDetailsOpen = selected === index && !!$('diagnostic-details')?.open;
      if (selected !== index || locate) { selectedColumn = -1; focusedProblem = null; }
      selected = index; highlighted = new Set([index]); highlightedEdges = new Set();
      const row = model.rows[index], relevant = model.issues.filter((item) => item.rows.includes(index));
      relevant.forEach((item) => { (item.relatedRows || item.rows).forEach((id) => highlighted.add(id)); item.edges.forEach((id) => highlightedEdges.add(id)); });
      $('detail-title').textContent = '第' + (index + 1) + '行 · ' + row.name;
      const detail = $('detail'); detail.replaceChildren();
      let detailTarget = detail;
      const paragraph = (text, type) => { const p = doc.createElement('p'); p.textContent = text; if (type) p.className = type; detailTarget.appendChild(p); };
      paragraph(rowStatusName(row), row.status);
      if (row.status !== 'ok') {
        const shortNames = { 'previous-row': '上行', 'next-row': '下行', current: '已定时延', series: '等差' };
        const summaries = (row.unknownProblems || []).slice(), describedConflicts = new Set();
        if (summaries.length) paragraph('共 ' + summaries.length + ' 处未定，具体位置和原因如下：', 'unknown');
        row.comparisons.forEach((comparison) => {
          if (row.status === 'unknown') return;
          const upper = comparison.estimates.find((item) => item.kind === 'previous-row');
          const difference = comparison.differences.find((item) => item.a === upper?.label) || comparison.differences[0];
          const prefix = comparison.problemNumbers.map((number) => '[' + number + ']').join('');
          const location = (prefix ? prefix + ' ' : '') + '列' + comparison.col + (comparison.endCol === undefined ? '' : '至' + comparison.endCol);
          const target = row.conflictRanges.find((item) => comparison.problemNumbers.includes(item.number))
            || row.dataUnknownRanges.find((item) => item.col <= comparison.col && item.end > comparison.col)
            || { col: comparison.col, end: comparison.endCol ?? comparison.col + 1, gapCol: comparison.col };
          const estimateText = (item, precise = false) => (item.kind === 'series' && item.side ? item.side === 'left' ? '左侧等差' : '右侧等差' : shortNames[item.kind])
            + (item.kind !== 'current' ? '候选' : '') + ' ' + (precise ? String(item.columns) : fmt(item.columns)) + ' 列';
          if (difference) {
            comparison.problemNumbers.forEach((number) => describedConflicts.add(number));
            const first = comparison.estimates.find((item) => item.label === difference.a);
            const second = comparison.estimates.find((item) => item.label === difference.b);
            const precise = first.columns !== second.columns && fmt(first.columns) === fmt(second.columns);
            summaries.push({ col: comparison.col, target, text: location + '：' + estimateText(first, precise)
              + '，' + estimateText(second, precise)
              + '，差 ' + fmt(difference.columns) + ' 列' + (comparison.period !== 1 ? '（' + fmt(difference.duration) + ' cycle）' : '') + '。' });
          } else {
            const gap = model.gaps[comparison.gap];
            const candidates = comparison.estimates.filter((item) => Number.isFinite(item.columns));
            const timing = candidates.find((item) => item.kind === 'previous-row') || candidates.find((item) => item.kind !== 'series');
            const data = candidates.find((item) => item.kind === 'series');
            const counts = [timing, data].filter(Boolean).map((item) => estimateText(item)).join('，');
            const sameLength = timing && data && Math.abs(timing.duration - data.duration) <= Math.max(1e-9, model.tolerance);
            const reason = gap.seriesSummary || gap.seriesReason || (gap.duration === undefined ? '缺少时延依据'
              : sameLength ? '列数一致，不是长度冲突' : '该区间时长已确定');
            if (gap.seriesSummary || gap.seriesReason) comparison.problemNumbers.forEach((number) => describedConflicts.add(number));
            summaries.push({ col: comparison.col, target, text: location + '：' + (counts ? counts + '；' : '') + reason + '。' });
          }
        });
        row.conflictRanges.forEach((range) => {
          const location = '[' + range.number + '] 列' + range.col + (range.end > range.col ? '至' + range.end : '');
          const described = describedConflicts.has(range.number);
          const causes = (range.issueIds || []).map((id) => model.issues[id])
            .filter((entry) => entry?.kind === 'conflict' && (!described || entry.timeComparison));
          if (described && !causes.length) return;
          if (!causes.length) summaries.push({ col: range.col, target: range,
            text: location + '：该位置不能同时满足已有的时间要求，请展开详情查看依据。' });
          causes.forEach((entry) => {
            const comparison = entry.timeComparison;
            let text = location + '：' + entry.reason;
            if (comparison) {
              const context = comparison.col === range.col ? '' : '（关联第' + (comparison.row + 1) + '行列' + comparison.col + '）';
              const precise = comparison.difference > 0 && new Set(comparison.sources.map((source) => fmt(source.time))).size === 1;
              const compareTime = Math.max(...comparison.sources.map((source) => source.time));
              const values = comparison.sources.map((source) => conflictValueAt(model.rows[source.row], compareTime));
              const showValues = values.some((value) => value.data);
              const valueText = (value) => '（' + fmt(compareTime) + ' cycle 处应为 ' + value.text + '）';
              const times = comparison.sources.map((source, index) => (source.direction === 'data-series'
                ? '第' + (source.row + 1) + '行等差推算为 ' : '按第' + (source.row + 1) + '行对齐为 ')
                + (precise ? String(source.time) : fmt(source.time)) + ' cycle' + (showValues ? valueText(values[index]) : ''));
              const [first, second] = comparison.sources;
              const sameRow = first.row === second.row && first.direction !== 'data-series' && second.direction !== 'data-series';
              const cause = sameRow ? '第' + (first.row + 1) + '行'
                + (Number.isInteger(first.col) ? '原列' + first.col + '锚点' : '已采用锚点') + '推算本列为 '
                + (precise ? String(first.time) : fmt(first.time)) + ' cycle，但该行原列' + second.col + '要求为 '
                + (precise ? String(second.time) : fmt(second.time)) + ' cycle' + (showValues ? valueText(values[0]) : '') : times.join('，');
              text = location + context + '时间不一致：' + cause + '，差 ' + fmt(comparison.difference) + ' cycle。';
            }
            summaries.push({ col: range.col, target: range, text });
          });
        });
        if (!summaries.length) {
          const causes = relevant.filter((entry) => entry.kind === 'conflict');
          if (causes.length) causes.forEach((entry) => summaries.push({ col: 0, target: null, text: entry.reason }));
          else summaries.push({ col: 0, target: null, text: '缺少可靠的时延或数据依据。' });
        }
        summaries.sort((a, b) => a.col - b.col).forEach((item) => {
          const button = doc.createElement('button'); button.type = 'button'; button.className = 'timing-problem-link'; button.textContent = item.text;
          button.title = '定位此处波形'; button.setAttribute('aria-label', '定位：' + item.text);
          if (item.unknown && !item.target) {
            const note = doc.createElement('p'); note.className = 'timing-problem-note'; note.textContent = item.text;
            detail.appendChild(note); return;
          }
          button.dataset.col = item.target?.col; button.dataset.end = item.target?.end;
          button.setAttribute('aria-current', String(focusedProblem?.row === index && focusedProblem.target.col === item.target?.col && focusedProblem.target.end === item.target?.end));
          button.onclick = () => locateProblem(index, item.target); detail.appendChild(button);
        });
        const disclosure = doc.createElement('details'), toggle = doc.createElement('summary');
        disclosure.id = 'timing-diagnostic-details'; disclosure.open = keepDetailsOpen;
        toggle.textContent = keepDetailsOpen ? '收起详情' : '展开详情';
        disclosure.addEventListener('toggle', () => { toggle.textContent = disclosure.open ? '收起详情' : '展开详情'; });
        detailTarget = doc.createElement('div');
        disclosure.append(toggle, detailTarget); detail.appendChild(disclosure);
      }
      if (row.status === 'conflict') {
        const references = Array.from(new Set(relevant.filter((item) => item.kind === 'conflict')
          .flatMap((item) => item.relatedRows || item.rows))).filter((id) => id !== index).sort((a, b) => a - b);
        paragraph('本次冲突标记在第' + (index + 1) + '行'
          + (references.length ? '；相关参考：' + references.map((id) => '第' + (id + 1) + '行').join('、') : '') + '。');
        paragraph(row.conflictRanges.length ? '冲突位置：' + row.conflictRanges.map((range) => '[' + range.number + '] ' + (range.end > range.col
          ? '原列 ' + range.col + ' 至 ' + range.end + ' 的边界区间' : '原列 ' + range.col + ' 的边沿')).join('；') + '。'
          : '冲突位置暂无法确定，请查看下方约束详情。');
      }
      if (!row.reasons.length) paragraph(row.empty ? '空行，未发现连接时延冲突。'
        : row.terminalDisplay ? '有效区间的时延约束一致；图尾仅按预览范围展示，不反推唯一时延。'
        : row.unknownTailStart === 0 && !row.known ? '本行仅有未知波形，不以绘制长度判断时延。'
        : row.alignments.length ? '已有连接约束保持不变；先按明确的数据等差规律补全，再按上行、下行补充未定位置。'
        : '时间已确定；已提供的时延约束一致。没有连接约束的部分仅确定自身时间。');
      if (row.originAdjustment) paragraph('连接时延优先：本行默认起点 ' + fmt(row.originAdjustment.original)
        + ' cycle 调整为 ' + fmt(row.originAdjustment.start) + ' cycle（偏移 '
        + fmt(row.originAdjustment.offset) + ' cycle）。起始段按连接关系定位，不要求存在 |；各格仍保持 '
        + fmt(row.period) + ' cycle，后续省略区间仍单独推算。');
      if (row.unknownTailStart !== undefined) paragraph('原列 ' + row.unknownTailStart
        + ' 起为末尾未知段，长度未定，不按绘制列数约束相邻行；显式连接时延仍单独检查。'
        + (row.unknownTailDisplay ? '预览以未知波形补齐至最长波形的 ' + fmt(row.unknownTailDisplay.finish) + ' cycle，不参与时延推算。' : ''));
      if (row.terminalDisplay) paragraph('原列 ' + row.terminalDisplay.col
        + ' 起的末尾连续时钟、保持段或空白占位展示至最长波形的 ' + fmt(model.maximum)
        + ' cycle；保留波形类型和颜色，展示宽度及重复符号不作为其他行的实际时延锚点。');
      (row.referenceChecks || []).forEach((check) => {
        const label = check.direction === 'previous-row' ? '上一行' : '下一行';
        const status = { available: '可以确定', partial: '仅部分可确定', unavailable: '无法确定', 'not-needed': '无需参考' }[check.status];
        paragraph('根据' + label + (check.referenceRow === undefined ? '' : '（第' + (check.referenceRow + 1) + '行）')
          + '：' + status + '；' + check.reason + (check.used ? '；已采用此侧的可用时刻' : '') + '。');
      });
      const conversions = (model.parameterConversions || []).concat(row.parameterConversions || []);
      if (conversions.length) {
        const heading = doc.createElement('p'), title = doc.createElement('strong');
        title.textContent = '公式转换结果'; heading.appendChild(title); detailTarget.appendChild(heading);
        conversions.forEach((conversion) => {
          const path = conversion.path || [], dataField = path.indexOf('data');
          const label = path[0] === 'edge' ? '连接 ' + (Number(path[1]) + 1)
            : dataField >= 0 ? '数据标签' + (path[dataField + 1] === undefined ? '' : ' ' + (Number(path[dataField + 1]) + 1))
            : path[0] === 'signal' ? Number.isInteger(conversion.row) ? '本行 ' + path[path.length - 1] : '分组标签' : path.join('.');
          const errors = conversion.expressions.filter((entry) => entry.error).map((entry) => entry.error);
          paragraph(label + '：' + conversion.raw + ' → ' + (errors.length ? '转换失败：' + errors.join('；') : conversion.value), errors.length ? 'unknown' : '');
        });
      }
      row.comparisons.forEach((comparison) => {
        const heading = doc.createElement('p'), title = doc.createElement('strong');
        const prefix = comparison.problemNumbers.map((number) => '[' + number + '] ').join('');
        title.textContent = prefix + '原列 ' + comparison.col + (comparison.endCol === undefined
          ? ' 的 |' + (comparison.blankCount ? '（含已有空白数据格）' : '（省略部分）')
          : ' 至 ' + comparison.endCol + '（整个展开区间）') + '：推算列数对比';
        heading.appendChild(title); detailTarget.appendChild(heading);
        paragraph('本行 1 列 = ' + fmt(comparison.period) + ' cycle'
          + (comparison.blankCount ? '；两端之间已有 ' + comparison.blankCount + ' 个空白数据格，共 ' + fmt(comparison.blankColumns)
            + ' 列，计入以下候选列数；不包含两端已知数据' : '') + '。');
        comparison.estimates.forEach((estimate) => {
          paragraph(estimate.label + '：' + (estimate.reason ? '无法推算；' + estimate.reason
            : '推算为 ' + fmt(estimate.columns) + ' 列（' + fmt(estimate.duration) + ' cycle）'
              + (estimate.count !== undefined ? '；其中 | 省略 ' + estimate.count + ' 项，每项 ' + fmt(estimate.cellDuration) + ' cycle' : ''))
            + (estimate.note ? '；' + estimate.note : '') + '。');
        });
        comparison.differences.forEach((difference) => paragraph(difference.a + ' 与 ' + difference.b + ' 相差 '
          + fmt(difference.columns) + ' 列（' + fmt(difference.duration) + ' cycle）。', row.status === 'conflict' ? 'conflict' : 'unknown'));
      });
      row.reasons.forEach((reason) => paragraph(reason));
      row.alignments.forEach((alignment) => {
        if (alignment.direction === 'data-series') {
          paragraph('第' + (alignment.row + 1) + '行第' + model.gaps[alignment.gap].col + '列按数据等差规律补全'
            + (alignment.row === row.index ? '，仅为预览推断，不修改原始数据。' : '，并经连接关系传递至本行。')); return;
        }
        paragraph('第' + (alignment.row + 1) + '行原列' + alignment.col
        + (alignment.finalDataCell ? '（数据段末列）' : '')
        + ' 按' + (alignment.direction === 'next-row' ? '下一行' : '上一行') + '（第' + (alignment.referenceRow + 1) + '行）展开后的同原列时刻对齐至 ' + fmt(alignment.time) + ' cycle'
        + (alignment.referenceExpanded ? '（同值展开区域）' : '')
        + (alignment.row === row.index ? '；连接时延优先。' : '，并经连接约束传递至本行。'));
      });
      row.gaps.forEach((id) => {
        const gap = model.gaps[id];
        if (gap.ignored) { paragraph('第' + gap.col + '列 |：行尾省略，不影响后续波形或连接端点，无需推算时长。'); return; }
        paragraph('第' + gap.col + '列' + (gap.kind === 'stretch' ? '至' + gap.endCol + '列' + (gap.omissions.length
          ? (gap.holdStart !== undefined ? '保持与省略区域' : '延续与省略区域') + '（固定部分 ' + fmt(gap.minimum) + ' cycle，含 ' + gap.omissions.length + ' 个 |）'
          : '同值区域（原时长 ' + fmt(gap.minimum) + ' cycle）') : ' |')
          + '：' + (gap.duration === undefined ? '未定' : fmt(gap.duration) + ' cycle')
          + '；起点 ' + (gap.start === null ? '?' : fmt(gap.start)) + '，终点 ' + (gap.end === null ? '?' : fmt(gap.end))
          + (alignmentNames[gap.durationSource] ? '；来源：' + alignmentNames[gap.durationSource] : gap.durationSource === 'connection' ? '；来源：连接时延' : ''));
        if (gap.series) {
          const series = gap.series;
          if (series.evidence) paragraph('等差依据：' + series.evidence.map((item) => item.before + ' → ' + item.after
            + (item.distance > 1 ? '（跨 ' + item.distance + ' 项，含已确认的省略或空白数据格）' : '')).join('；') + '。');
          paragraph('数据 ' + series.before + ' → ' + series.after + '；公差 ' + fmt(series.step) + '；| 省略部分 '
            + series.count + ' 项 × ' + fmt(series.cellDuration) + ' cycle/项 = ' + fmt(gap.duration) + ' cycle；补全 '
            + core.seriesLabel(series.first, series.style) + (series.count > 1 ? ' … ' + core.seriesLabel(series.first + (series.count - 1) * series.step, series.style) : '') + '。');
          if (series.filledCount) paragraph('另补齐 ' + series.filledCount + ' 个已有空白数据格，保持原宽度；完整补全区间共 '
            + (series.count + series.filledCount) + ' 项、' + fmt(gap.duration + gap.seriesContext.blankColumns * row.period) + ' cycle。');
          if (gap.seriesConfirmation) paragraph(gap.seriesConfirmation + '。');
        }
      });
      model.edges.filter((edge) => edge.fromNode && edge.fromNode.row === index || edge.toNode && edge.toNode.row === index).forEach((edge) => {
        paragraph('连接 ' + (edge.index + 1) + ' ' + edge.from + '→' + edge.to + '：' + (edge.label || '(无标签)')
          + (edge.actual === null ? '；位置未定' : '；计算差值 ' + fmt(edge.actual) + ' cycle')
          + (edge.timing.kind === 'ignored' ? '；不参与时延约束' : ''), edge.status);
      });
      $('locate').disabled = false;
      for (const button of $('row-list').children) button.setAttribute('aria-pressed', String(Number(button.dataset.row) === index));
      if (locate) {
        locateRow(index);
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
        if (row.unknownProblems?.length) {
          const summary = doc.createElement('small'); summary.className = 'timing-row-summary';
          const problems = row.unknownProblems;
          summary.textContent = problems.slice(0, 2).map((item) => item.preview).join('；')
            + (problems.length > 2 ? '；另 ' + (problems.length - 2) + ' 处' : '');
          name.appendChild(summary);
        }
        const state = doc.createElement('span'); state.textContent = rowStatusName(row); state.className = row.status;
        button.append(name, state); button.title = row.reasons.join('\n'); button.onclick = () => {
          selectRow(row.index, true);
          if (row.status !== 'ok') locateProblem(row.index, row.conflictRanges[0] || row.unknownProblems?.find((problem) => problem.target)?.target || null);
        };
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
    function paintRuns(row, x, from, to, left, right, mid, reference, context) {
      const runs = reference ? row.referenceRuns : row.drawRuns, scale = (right - left) / (to - from);
      let previousPixel = -Infinity;
      context.save();
      function paintBus(x1, x2, state, text, symbol) {
        const cap = Math.min(4, (x2 - x1) / 3);
        context.fillStyle = state === 'bus' || state === 'unresolved' ? dataColors[symbol] || dataColors['=']
          : reference ? '#eef1f5' : '#eceff2';
        context.beginPath(); context.moveTo(x1, mid); context.lineTo(x1 + cap, mid - 12); context.lineTo(x2 - cap, mid - 12);
        context.lineTo(x2, mid); context.lineTo(x2 - cap, mid + 12); context.lineTo(x1 + cap, mid + 12); context.closePath(); context.fill(); context.stroke();
        context.fillStyle = reference ? '#364152' : state === 'unresolved' ? '#8a5a08' : '#173426';
        if (x2 - x1 > 16) { context.save(); context.beginPath(); context.rect(x1 + 5, mid - 10, Math.max(0, x2 - x1 - 10), 20); context.clip(); context.textAlign = 'center'; context.fillText(text, (x1 + x2) / 2, mid + 4); context.restore(); }
      }
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
        context.strokeStyle = run.unresolvedData || reference && run.provisional ? '#8a5a08' : '#235681'; context.lineWidth = 1.5;
        context.setLineDash(run.unresolvedData || reference && run.provisional ? [4, 2] : []);
        if (reference && run.gap && (!run.stretch || run.omission)) {
          context.setLineDash([]); context.fillStyle = '#8a5a08';
          context.fillText(run.provisional ? '| ?' : '|', (x1 + x2) / 2 - 2, mid + 4);
        } else if (run.series && !reference) {
          const series = run.series, cell = series.cellDuration;
          const first = Math.max(0, Math.floor((Math.max(from, run.start) - run.start) / cell));
          const last = Math.min(series.count, Math.ceil((Math.min(to, run.finish) - run.start) / cell));
          if (cell * scale < 12) {
            paintBus(x1, x2, 'bus', core.seriesLabel(series.first + first * series.step, series.style) + ' … '
              + core.seriesLabel(series.first + (last - 1) * series.step, series.style) + ' [' + (last - first) + ']', run.symbol);
          } else for (let sample = first; sample < last; sample++) {
            paintBus(Math.max(x1, x(run.start + sample * cell)), Math.min(x2, x(run.start + (sample + 1) * cell)),
              'bus', core.seriesLabel(series.first + sample * series.step, series.style), run.symbol);
          }
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
          paintBus(x1, x2, run.unresolvedData ? 'unresolved' : state, state === 'bus' ? run.value : 'x', run.symbol);
        }
      }
      context.restore();
    }
    function paintProblemRanges(ranges, x, left, right, top, height, reference, unknown, context) {
      context.save();
      const color = unknown ? '#8a5a08' : '#b62e3b';
      for (const range of ranges) {
        const a = reference ? range.referenceStart : range.start, b = reference ? range.referenceFinish : range.finish;
        if (a === null || b === null) continue;
        const low = Math.min(x(a), x(b)), high = Math.max(x(a), x(b));
        if (high < left || low > right) continue;
        const x1 = Math.max(left, low - (high === low ? 3 : 0)), x2 = Math.min(right, Math.max(low + 6, high));
        if (x2 <= x1) continue;
        context.fillStyle = unknown ? '#fff0c8' : '#ffdddd'; context.globalAlpha = 0.5;
        context.fillRect(x1, top + 4, x2 - x1, height - 8); context.globalAlpha = 1;
        context.strokeStyle = color; context.lineWidth = 2; context.setLineDash([5, 4]);
        context.strokeRect(x1, top + 4, x2 - x1, height - 8); context.setLineDash([]);
        const label = '[' + range.number + '] ' + (unknown ? '数据未定' : '冲突') + ' · 列' + range.col + (range.end > range.col ? '至' + range.end : '');
        if (context.measureText(label).width + 8 < x2 - x1) {
          context.fillStyle = color; context.fillText(label, x1 + 4, top + height - 9);
        } else {
          const badge = '[' + range.number + ']', badgeWidth = context.measureText(badge).width + 6;
          const badgeLeft = Math.max(left, Math.min(x1, right - badgeWidth));
          context.fillStyle = '#ffffff'; context.fillRect(badgeLeft, top + height - 22, badgeWidth, 16);
          context.fillStyle = color; context.fillText(badge, badgeLeft + 3, top + height - 9);
        }
      }
      context.restore();
    }
    function paintEdges(context, width, height, left, x, y, from, to, original) {
      context.save(); context.beginPath(); context.rect(left, ruler, width - left, height - ruler); context.clip();
      for (const edge of model.edges) {
        if (!edge.fromNode || !edge.toNode || edge.invalid) continue;
        const fromRow = model.originalRows?.[edge.fromNode.row], toRow = model.originalRows?.[edge.toNode.row];
        const a = original ? edge.fromNode.col * fromRow.period - fromRow.phase : edge.start;
        const b = original ? edge.toNode.col * toRow.period - toRow.phase : edge.end;
        if (a === null || b === null || Math.max(a, b) < from || Math.min(a, b) > to) continue;
        const x1 = x(a), x2 = x(b), y1 = y(edge.fromNode.row) + 25, y2 = y(edge.toNode.row) + 25;
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
    }
    function drawOriginal() {
      if (!originalVisible) return;
      const { width, height, left } = dimensions(originalScroll), context = originalContext;
      if (!width || !height) return;
      const ratio = Math.min(view.devicePixelRatio || 1, 2);
      if (originalCanvas.width !== Math.round(width * ratio) || originalCanvas.height !== Math.round(height * ratio)) {
        originalCanvas.width = Math.round(width * ratio); originalCanvas.height = Math.round(height * ratio);
        originalCanvas.style.width = width + 'px'; originalCanvas.style.height = height + 'px';
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height);
      if (!model?.originalRows) return;
      const x = time => left + (time - originalStart) * Math.max(1, width - left - 16) / (originalEnd - originalStart);
      const y = row => ruler + rowOffsets[row] - originalScroll.scrollTop;
      const first = Math.max(0, rowAt(originalScroll.scrollTop)), last = Math.min(model.rows.length, rowAt(originalScroll.scrollTop + height - ruler) + 1);
      context.font = '12px "Segoe UI", "Microsoft YaHei", sans-serif'; context.lineWidth = 1;
      const rawStep = (originalEnd - originalStart) / Math.max(2, (width - left) / 85);
      const power = Math.pow(10, Math.floor(Math.log10(rawStep))), step = [1, 2, 5, 10].find(n => n * power >= rawStep) * power;
      for (let tick = Math.ceil(originalStart / step) * step, count = 0; tick <= originalEnd && count++ < 100; tick += step) {
        const px = x(tick); context.strokeStyle = '#e5e9ee'; context.beginPath(); context.moveTo(px, ruler); context.lineTo(px, height); context.stroke();
      }
      for (let index = first; index < last; index++) {
        const row = model.originalRows[index], checked = model.rows[index], top = y(index);
        if (highlighted.has(index)) { context.fillStyle = '#eaf3ff'; context.fillRect(0, Math.max(ruler, top), width, rowHeight); }
        context.strokeStyle = '#e2e8ed'; context.beginPath(); context.moveTo(0, top + rowHeight); context.lineTo(width, top + rowHeight); context.stroke();
        context.save(); context.beginPath(); context.rect(left, Math.max(ruler, top), width - left, Math.min(rowHeight, height - top)); context.clip();
        paintRuns(row, x, originalStart, originalEnd, left, width - 16, top + 25, true, context);
        const map = ranges => ranges.map(range => originalInterval(index, range));
        paintProblemRanges(map(checked.dataUnknownRanges), x, left, width - 8, top, rowHeight, false, true, context);
        paintProblemRanges(map(checked.conflictRanges), x, left, width - 8, top, rowHeight, false, false, context);
        if (selected === index && selectedColumn >= 0) {
          const interval = originalInterval(index, { col: selectedColumn, end: selectedColumn + 1 });
          context.strokeStyle = '#135bc5'; context.lineWidth = 2;
          context.strokeRect(x(interval.start), top + 6, Math.max(2, x(interval.finish) - x(interval.start)), rowHeight - 12);
        }
        context.restore();
        context.save(); context.beginPath(); context.rect(0, Math.max(ruler, top), left - 1, rowHeight); context.clip();
        context.fillStyle = highlighted.has(index) ? '#eaf3ff' : '#f4f6f8'; context.fillRect(0, top, left - 1, rowHeight);
        context.fillStyle = '#1b2732'; context.fillText((index + 1) + '. ' + row.name, 10, top + 23);
        context.fillStyle = '#475569'; context.fillText(row.sourceLength ? '原列 0～' + (row.sourceLength - 1) : '空行', 10, top + 43); context.restore();
      }
      paintEdges(context, width, height, left, x, y, originalStart, originalEnd, true);
      context.save(); context.beginPath(); context.rect(0, ruler, width, height - ruler); context.clip();
      for (let index = first; index < last; index++) if (highlighted.has(index)) {
        context.strokeStyle = '#135bc5'; context.lineWidth = index === selected ? 2.5 : 1; context.setLineDash(index === selected ? [] : [5, 4]);
        context.strokeRect(2, y(index) + 2, width - 4, rowHeight - 4);
      }
      context.setLineDash([]);
      if (focusedProblem) {
        const interval = originalInterval(focusedProblem.row, focusedProblem.target);
        if (interval) {
          const x1 = Math.max(left + 1, x(interval.start) - 3), x2 = Math.min(width - 2, x(interval.finish) + 4);
          if (x2 >= x1) { context.strokeStyle = '#135bc5'; context.lineWidth = 2.5; context.strokeRect(x1, y(focusedProblem.row) + 2, Math.max(2, x2 - x1), rowHeight - 4); }
        }
      }
      context.restore(); context.setLineDash([]);
      context.fillStyle = '#f0f3f7'; context.fillRect(0, 0, width, ruler); context.fillStyle = '#3f5063';
      for (let tick = Math.ceil(originalStart / step) * step, count = 0; tick <= originalEnd && count++ < 100; tick += step) context.fillText(fmt(tick), x(tick) + 3, 21);
    }
    function draw() {
      drawOriginal();
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
      context.font = '12px "Segoe UI", "Microsoft YaHei", sans-serif'; context.lineWidth = 1;
      const rawStep = (end - start) / Math.max(2, (width - left) / 85);
      const power = Math.pow(10, Math.floor(Math.log10(rawStep))), step = [1, 2, 5, 10].find((n) => n * power >= rawStep) * power;
      for (let tick = Math.ceil(start / step) * step, count = 0; tick <= end && count++ < 100; tick += step) {
        const px = x(tick); context.strokeStyle = '#e5e9ee'; context.beginPath(); context.moveTo(px, ruler); context.lineTo(px, height); context.stroke();
      }
      for (let i = first; i < last; i++) {
        const row = model.rows[i], top = y(i), mid = top + 25;
        if (row.status === 'unknown' || highlighted.has(i)) {
          context.fillStyle = row.status === 'unknown' ? '#fff9e9' : '#eaf3ff';
          context.fillRect(0, Math.max(top, ruler), width, rowHeight);
        }
        context.strokeStyle = '#e2e8ed'; context.beginPath(); context.moveTo(0, top + rowHeight); context.lineTo(width, top + rowHeight); context.stroke();
        context.save(); context.beginPath(); context.rect(left, Math.max(ruler, top), width - left, Math.min(rowHeight, height - top)); context.clip();
        paintRuns(row, x, start, end, left, x(end), mid, false, context);
        row.gaps.forEach((id, gapIndex) => {
          const gap = model.gaps[id];
          if (gap.ignored) {
            if (row.terminalDisplay?.gap !== id && gap.start !== null && gap.start >= start && gap.start <= end) {
              context.fillStyle = '#667085'; context.fillText('|', Math.min(width - 12, x(gap.start) + 2), mid + 4);
            }
            return;
          }
          if (gap.conflict || gap.seriesReason && gap.duration !== undefined) return;
          if (gap.duration !== undefined && gap.start !== null && gap.end !== null && gap.end > gap.start) {
            const completion = gap.completionRange;
            const x1 = Math.max(left, x(completion?.start ?? gap.start)), x2 = Math.min(width - 8, x(completion?.finish ?? gap.end));
            if (x2 > x1) {
              const inferred = !!alignmentNames[gap.durationSource];
              context.strokeStyle = inferred ? '#237963' : '#5277b4'; context.lineWidth = 1; context.setLineDash([]); context.strokeRect(x1, mid - 16, x2 - x1, 33);
              context.fillStyle = inferred ? '#21634f' : '#294c81';
              const prefix = gap.kind === 'stretch' ? /[pPnN]/.test(gap.state) ? '时钟展开 = ' : gap.holdStart !== undefined ? '保持展开 = ' : '同值展开 = ' : '| = ';
              const summary = completion ? '等差补全 ' + (gap.series.count + gap.series.filledCount) + ' 项' : prefix + fmt(gap.duration);
              let label = completion ? summary + ' · ' + fmt(completion.finish - completion.start) + ' cycle'
                : summary + (inferred ? ' · ' + alignmentNames[gap.durationSource] : '');
              if (context.measureText(label).width > x2 - x1 - 8) label = summary;
              if (context.measureText(label).width > x2 - x1 - 8) label = completion ? '补全 ' + (gap.series.count + gap.series.filledCount) + ' 项' : '= ' + fmt(gap.duration);
              if (context.measureText(label).width <= x2 - x1 - 8) context.fillText(label, x1 + 4, top + 55);
            }
          }
          if (gap.duration === undefined) {
            if (gap.start === null) return;
            let nextAnchor = gap.end !== null ? gap : null;
            for (let nextIndex = gapIndex + 1; !nextAnchor && nextIndex < row.gaps.length; nextIndex++) {
              const next = model.gaps[row.gaps[nextIndex]];
              if (next.end !== null) nextAnchor = next;
            }
            const finish = nextAnchor ? nextAnchor.end : null;
            if (gap.start > end || finish !== null && Math.max(gap.start, finish) < start) return;
            const px = x(gap.start), color = '#8a5a08';
            const far = finish === null ? width - 8 : x(finish);
            const boxLeft = Math.max(left, Math.min(px, far)), boxRight = Math.min(width - 8, Math.max(px + 5, far));
            context.fillStyle = '#ffefbc';
            context.globalAlpha = 0.65; context.fillRect(boxLeft, top + 4, boxRight - boxLeft, rowHeight - 8); context.globalAlpha = 1;
            context.strokeStyle = color; context.lineWidth = 2; context.setLineDash([5, 4]);
            context.strokeRect(boxLeft, top + 4, boxRight - boxLeft, rowHeight - 8); context.setLineDash([]);
            context.fillStyle = color;
            context.fillText((gap.kind === 'stretch' ? gap.holdStart !== undefined ? '保持区域 ' : '同值区域 ' : '| ') + '? 时长分配未定 · 列' + gap.col
              + (nextAnchor && nextAnchor !== gap ? '至' + nextAnchor.col : '') + (finish === null ? ' · 后续位置未定' : ''), boxLeft + 4, top + 55);
          }
        });
        paintProblemRanges(row.dataUnknownRanges, x, left, width - 8, top, rowHeight, false, true, context);
        paintProblemRanges(row.conflictRanges, x, left, width - 8, top, rowHeight, false, false, context);
        if (row.status === 'unknown' && row.hasUnpositionedContent && !row.drawRuns.length) {
          context.strokeStyle = '#a97923'; context.lineWidth = 1;
          context.setLineDash([5, 4]);
          context.strokeRect(left + 1, top + 1, width - left - 3, rowHeight - 2); context.setLineDash([]);
          if (row.hasUnpositionedContent && !row.gaps.some((id) => !model.gaps[id].ignored && (model.gaps[id].start !== null || model.gaps[id].end !== null))) {
            context.fillStyle = '#8a5a08'; context.fillText('时间位置未定', left + 8, mid + 4);
          }
        }
        context.restore();
        context.save(); context.beginPath(); context.rect(0, Math.max(ruler, top), left - 1, rowHeight); context.clip();
        context.fillStyle = row.status === 'unknown' ? '#fff0c8' : highlighted.has(i) ? '#eaf3ff' : '#f4f6f8'; context.fillRect(0, top, left - 1, rowHeight);
        context.fillStyle = '#1b2732'; context.fillText((i + 1) + '. ' + row.name, 10, top + 23);
        context.fillStyle = row.status === 'conflict' ? '#b62e3b' : row.status === 'unknown' ? '#8a5a08' : '#21633d';
        context.fillText(rowStatusName(row), 10, top + 43); context.restore();
      }
      paintEdges(context, width, height, left, x, y, start, end, false);
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
      // Draw selection last so warning fills and connections cannot hide it.
      context.save(); context.beginPath(); context.rect(0, ruler, width, height - ruler); context.clip();
      for (let i = first; i < last; i++) {
        if (!highlighted.has(i)) continue;
        context.strokeStyle = '#135bc5'; context.lineWidth = i === selected ? 2.5 : 1;
        context.setLineDash(i === selected ? [] : [5, 4]);
        context.strokeRect(2, y(i) + 2, width - 4, rowOffsets[i + 1] - rowOffsets[i] - 4);
      }
      if (focusedProblem && focusedProblem.row >= first && focusedProblem.row < last) {
        const row = model.rows[focusedProblem.row], interval = problemRange(row, focusedProblem.target);
        if (interval) {
          const a = interval.start, b = interval.finish;
          if (Number.isFinite(a) && Number.isFinite(b) && Math.max(a, b) >= start && Math.min(a, b) <= end) {
            const x1 = Math.max(left + 1, x(Math.min(a, b)) - 3), x2 = Math.min(width - 2, x(Math.max(a, b)) + 4);
            context.strokeStyle = '#135bc5'; context.lineWidth = 2.5; context.setLineDash([]);
            context.strokeRect(x1, y(row.index) + 2, Math.max(2, x2 - x1), rowHeight - 4);
          }
        }
      }
      context.restore();
    }
    function receive(result) {
      const firstResult = !model;
      model = result;
      const unknownByRow = model.rows.map(() => []);
      model.issues.forEach((entry, issueId) => {
        if (entry.kind === 'unknown') entry.rows.forEach((index) => unknownByRow[index].push({ entry, issueId }));
      });
      model.rows.forEach((row) => {
        row.unknownProblems = unknownProblems(row, unknownByRow[row.index]);
        // The independent original pane replaces the old per-row mapped strips.
        delete row.referenceRuns; delete row.referenceEnds;
      });
      layoutRows();
      if (!model.rows[selected] || selectedColumn >= model.rows[selected].sourceLength) selectedColumn = -1;
      const counts = { ok: 0, unknown: 0, conflict: 0 }; model.rows.forEach((row) => counts[row.status]++);
      const alignedCount = model.rows.filter((row) => row.alignments.some((entry) => entry.direction !== 'data-series')).length;
      const seriesCount = model.rows.filter((row) => row.gaps.some((id) => model.gaps[id].series)).length;
      const orphan = model.issues.filter((item) => !item.rows.length).map((item) => item.reason);
      const unknownCount = model.rows.reduce((count, row) => count + row.unknownProblems.length, 0);
      message('已确定 ' + counts.ok + ' 行 · 时延冲突 ' + counts.conflict + ' 行 · 无法判断 ' + counts.unknown + ' 行'
        + (unknownCount ? '（共 ' + unknownCount + ' 处未定，点击左侧行查看位置）' : '')
        + (alignedCount ? ' · 相邻行对齐 ' + alignedCount + ' 行' : '')
        + (seriesCount ? ' · 等差补全 ' + seriesCount + ' 行' : '')
        + (orphan.length ? ' · ' + orphan.join('；') : '') + (counts.conflict ? ' · 冲突部分仅供定位，不能作为对齐结论' : ''), false);
      listRows();
      if (selected >= model.rows.length) selected = -1;
      if (selected >= 0) selectRow(selected);
      else if (model.rows.length) selectRow(model.rows.findIndex((row) => row.status !== 'ok') >= 0 ? model.rows.findIndex((row) => row.status !== 'ok') : 0, firstResult);
      else { $('detail').textContent = '没有可检查的信号'; $('locate').disabled = true; }
      if (firstResult) { a = model.minimum; b = model.minimum; fit(); fitOriginal(); }
      refreshControls(); drawSoon();
      host.log && host.log({ phase: 'checked', rows: model.rows.length, gaps: model.gaps.length, counts, alignedRows: alignedCount,
        originalExtent: [originalMinimum, originalMaximum], expandedExtent: [displayMinimum, displayMaximum], originalVisible, splitRatio,
        elapsedMs: Math.round(performance.now() - requestTime) });
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
        const script = 'const engine=(' + global.createVisualWaveDromTimingEngine.toString() + ')();onmessage=(e)=>{try{postMessage({result:engine.analyze(e.data.source,e.data.edgeTimings,e.data.parameterConversions,{original:true})})}catch(error){postMessage({error:error.message})}};';
        const url = URL.createObjectURL(new Blob([script], { type: 'text/javascript' }));
        try { worker = new Worker(url); } finally { URL.revokeObjectURL(url); }
        worker.onmessage = (event) => {
          if (disposed || current !== version) return;
          if (event.data.error) { message('检查失败：' + event.data.error + (model ? '（画面保留上次结果）' : ''), true); host.log && host.log({ phase: 'error', message: event.data.error }); }
          else receive(event.data.result);
          worker.terminate(); worker = null;
        };
        worker.onerror = (event) => { if (current === version && !disposed) { message('后台检查失败：' + event.message, true); worker.terminate(); worker = null; } };
        worker.postMessage({ source, edgeTimings: snapshot.edgeTimings, parameterConversions: snapshot.parameterConversions });
      } catch (error) {
        if (disposed || view.closed) return;
        version++; if (worker) worker.terminate(); worker = null; source = null;
        message('无法检查：' + error.message + (model ? '（画面保留上次结果）' : ''), true);
      } finally { reading = false; }
    }
    function dispose() {
      if (disposed) return;
      disposed = true; clearInterval(timer); if (worker) worker.terminate(); if (frame) view.cancelAnimationFrame(frame);
      timer = frame = 0; worker = null; version++;
      observer.disconnect();
      if (sessions.get(host.id) === view) sessions.delete(host.id);
      source = model = null; panDrag = drag = splitDrag = focusedProblem = null;
      expectedScroll.clear(); highlighted.clear(); highlightedEdges.clear();
      canvas.width = canvas.height = 0;
      originalCanvas.width = originalCanvas.height = 0;
      if (typeof host.dispose === 'function') host.dispose();
      host.log && host.log({ phase: 'disposed', activeSessions: sessions.size });
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
    $('original-fit').onclick = fitOriginal;
    $('hide-original').onclick = () => showOriginal(false);
    $('show-original').onclick = () => showOriginal(true);
    function zoom(factor) {
      if (!model || factor > 1 && end - start >= fullSpan() * (1 - 1e-10)) return;
      const pivot = active === 'a' ? a : b, center = pivot >= start && pivot <= end ? pivot : (start + end) / 2;
      range(center - (center - start) * factor, center + (end - center) * factor);
    }
    $('zoom-in').onclick = () => zoom(0.5); $('zoom-out').onclick = () => zoom(2);
    $('start').onchange = $('end').onchange = () => { range(Number($('start').value), Number($('end').value)); refreshControls(); };
    function zoomOriginal(factor, clientX) {
      if (!model) return;
      const bounds = originalScroll.getBoundingClientRect(), { width, left } = dimensions(originalScroll);
      const fraction = Number.isFinite(clientX) ? Math.max(0, Math.min(1, (clientX - bounds.left - left) / Math.max(1, width - left - 16))) : 0.5;
      const center = originalStart + (originalEnd - originalStart) * fraction;
      originalRange(center - (center - originalStart) * factor, center + (originalEnd - center) * factor);
    }
    $('original-zoom-in').onclick = () => zoomOriginal(0.5); $('original-zoom-out').onclick = () => zoomOriginal(2);
    $('original-start').onchange = $('original-end').onchange = () => {
      originalRange(Number($('original-start').value), Number($('original-end').value)); refreshOriginalControls();
    };
    const splitter = $('splitter');
    function moveSplit(event) {
      if (splitDrag !== event.pointerId) return;
      const bounds = $('plots').getBoundingClientRect();
      updateSplit((event.clientY - bounds.top - 4) / Math.max(1, bounds.height - 8));
    }
    function endSplit(event) {
      if (splitDrag !== event.pointerId) return;
      splitDrag = null; doc.body.classList.remove('resizing-panes');
      host.log && host.log({ phase: 'split-layout', originalVisible, splitRatio });
    }
    splitter.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); splitDrag = event.pointerId; splitter.focus({ preventScroll: true });
      splitter.setPointerCapture(event.pointerId); doc.body.classList.add('resizing-panes'); moveSplit(event);
    });
    splitter.addEventListener('pointermove', moveSplit);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) splitter.addEventListener(type, endSplit);
    splitter.addEventListener('keydown', event => {
      if (!['ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
      event.preventDefault(); updateSplit(event.key === 'Home' ? 0.5 : splitRatio + (event.key === 'ArrowUp' ? -0.05 : 0.05));
    });
    function movePan(event) {
      if (!panDrag || panDrag.pointerId !== event.pointerId || !model) return;
      const original = panDrag.original, bounds = $(original ? 'original-pan' : 'pan').getBoundingClientRect();
      const visible = original ? originalEnd - originalStart : end - start;
      if (!bounds.width) return;
      const next = (original ? originalMinimum : displayMinimum) + (event.clientX - bounds.left) / bounds.width * (original ? originalSpan() : fullSpan()) - panDrag.grab * visible;
      (original ? originalRange : range)(next, next + visible);
    }
    function endPan(event) {
      if (!panDrag || event.pointerId !== panDrag.pointerId) return;
      $(panDrag.original ? 'original-pan' : 'pan').classList.remove('dragging'); panDrag = null;
    }
    for (const original of [false, true]) {
      const pan = $(original ? 'original-pan' : 'pan'), thumb = $(original ? 'original-pan-thumb' : 'pan-thumb');
      pan.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || !model || thumb.getAttribute('aria-disabled') === 'true') return;
        event.preventDefault();
        const bounds = thumb.getBoundingClientRect();
        panDrag = { pointerId: event.pointerId, original, grab: event.target === thumb && bounds.width
          ? Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) : 0.5 };
        thumb.focus({ preventScroll: true });
        pan.setPointerCapture(event.pointerId); pan.classList.add('dragging');
        movePan(event);
      });
      pan.addEventListener('pointermove', movePan);
      ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((type) => pan.addEventListener(type, endPan));
      thumb.addEventListener('keydown', (event) => {
        if (!model || thumb.getAttribute('aria-disabled') === 'true') return;
        const from = original ? originalStart : start, to = original ? originalEnd : end, visible = to - from;
        const minimum = original ? originalMinimum : displayMinimum, total = original ? originalSpan() : fullSpan();
        const positions = { ArrowLeft: from - visible / 20, ArrowRight: from + visible / 20,
          PageUp: from - visible, PageDown: from + visible, Home: minimum, End: minimum + total - visible };
        if (!Object.prototype.hasOwnProperty.call(positions, event.key)) return;
        event.preventDefault(); event.stopPropagation(); (original ? originalRange : range)(positions[event.key], positions[event.key] + visible);
      });
    }
    ['a', 'b'].forEach((key) => {
      $('pick-' + key).onclick = () => { active = key; refreshControls(); drawSoon(); };
      $(key).onchange = () => { const value = Number($(key).value); if (!Number.isFinite(value)) return; if (key === 'a') a = value; else b = value; refreshControls(); drawSoon(); };
    });
    function pointer(event, choose) {
      if (!model) return;
      const bounds = scroll.getBoundingClientRect(), { width, left } = dimensions(), px = event.clientX - bounds.left, py = event.clientY - bounds.top;
      const rowIndex = rowAt(py - ruler + scroll.scrollTop), row = model.rows[rowIndex];
      if (choose && row && py >= ruler) selectRow(rowIndex);
      if (choose) selectedColumn = -1;
      if (px < left || px > width - 8) return;
      selectedColumn = -1;
      let value = start + (px - left) / Math.max(1, width - left - 16) * (end - start);
      const radius = 8 / Math.max(1, width - left - 16) * (end - start);
      let nearest = value, distance = radius;
      if (row) {
        for (let i = firstRun(row, value - radius); i < row.drawRuns.length && row.drawRuns[i].start <= value + radius; i++) {
          const run = row.drawRuns[i], candidates = [run.start, run.finish];
          if (/[pn]/i.test(run.state)) candidates.push(run.clockOrigin + Math.round((value - run.clockOrigin) / (row.period / 2)) * row.period / 2);
          if (run.series) candidates.push(Math.max(run.start, Math.min(run.finish, run.start + Math.round((value - run.start) / run.series.cellDuration) * run.series.cellDuration)));
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
    for (const surface of [scroll, originalScroll]) surface.addEventListener('scroll', () => {
      const expected = expectedScroll.get(surface); expectedScroll.delete(surface);
      if (expected === undefined || Math.abs(expected - surface.scrollTop) > 0.5) syncVerticalScroll(surface, surface === scroll ? originalScroll : scroll);
      drawSoon();
    }, { passive: true });
    originalScroll.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !model) return;
      const bounds = originalScroll.getBoundingClientRect(), { width, left } = dimensions(originalScroll);
      const index = rowAt(event.clientY - bounds.top - ruler + originalScroll.scrollTop), row = model.originalRows?.[index];
      if (!row || event.clientY - bounds.top < ruler) return;
      selectRow(index); focusedProblem = null;
      const px = event.clientX - bounds.left;
      if (px >= left && px <= width - 16) {
        const cycle = originalStart + (px - left) / Math.max(1, width - left - 16) * (originalEnd - originalStart);
        selectedColumn = Math.max(0, Math.min(Math.max(0, row.length - 1), Math.floor((cycle + row.phase) / row.period)));
        $('position').textContent = '第' + (index + 1) + '行 ' + row.name + ' · 原列 ' + selectedColumn + ' · ' + fmt(selectedColumn * row.period - row.phase) + ' cycle';
      }
      drawSoon();
    });
    canvas.parentElement.addEventListener('wheel', (event) => {
      if (event.ctrlKey) { event.preventDefault(); zoom(event.deltaY > 0 ? 1.2 : 1 / 1.2); }
      else if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) { event.preventDefault(); const delta = (event.deltaX || event.deltaY) / Math.max(1, scroll.clientWidth) * (end - start); range(start + delta, end + delta); }
    }, { passive: false });
    originalCanvas.parentElement.addEventListener('wheel', event => {
      if (event.ctrlKey) { event.preventDefault(); zoomOriginal(event.deltaY > 0 ? 1.2 : 1 / 1.2, event.clientX); }
      else if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        event.preventDefault(); const delta = (event.deltaX || event.deltaY) / Math.max(1, originalScroll.clientWidth) * (originalEnd - originalStart);
        originalRange(originalStart + delta, originalEnd + delta);
      }
    }, { passive: false });
    doc.addEventListener('keydown', (event) => { if (event.key === 'Escape') { highlighted.clear(); highlightedEdges.clear(); drawSoon(); } });
    const observer = new view.ResizeObserver(() => { updateSplit(splitRatio); drawSoon(); });
    observer.observe(scroll); observer.observe(originalScroll);
    view.addEventListener('pagehide', dispose, { once: true });
    timer = setInterval(() => { if (view.closed) dispose(); else void refresh(); }, 600);
    void refresh();
    return view;
  }
  global.VisualWaveDromTiming = { open, diagnostics: () => ({ activeSessions: sessions.size }) };
})(window);

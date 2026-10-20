/* Fixed waveform sections are graph vertices; no expanded waveform strings are allocated. */
(function (global) {
  'use strict';
  function createTimingEngine() {
    const EPS = 1e-9;
    function halfCycle(value) {
      const tick = Math.round(value * 2);
      return Number.isFinite(value) && Number.isSafeInteger(tick) && Math.abs(value - tick / 2) <= EPS ? tick / 2 : null;
    }
    function normalizeDelay(timing) {
      if (timing.kind !== 'delay') return timing;
      const value = halfCycle(timing.value);
      return value === null ? { kind: 'unknown', reason: '时延结果必须为 0.5 cycle 的整数倍，未用于推算' }
        : Object.assign({}, timing, { value });
    }
    const numberPattern = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?';
    const units = 'cycle[s]?|周期|s|ms|us|µs|μs|ns|ps';
    function parseDelay(label, cycleTimeNs, evaluateExpression) {
      const raw = String(label || '').trim().replace(/^:\s*/, '');
      if (!raw) return { kind: 'ignored', reason: '无时延标签' };
      if (/[<>≤≥≠]/.test(raw) || raw.includes('!=')) return { kind: 'unknown', reason: '仅支持确定时延，不支持时延不等式' };
      const parts = raw.split(/[=＝]/);
      if (parts.length > 2) return { kind: 'unknown', reason: '标签中有多个等号，无法确定时延' };
      let text = parts.length === 2 ? parts[1].trim() : raw;
      function evaluate(expression) {
        if (typeof evaluateExpression !== 'function') throw new Error('时延公式或参数未解析，请检查链接参数表');
        const result = evaluateExpression(expression);
        if (!result || result.error) throw new Error(result && result.error || '时延公式计算失败');
        return result.value;
      }
      try {
        text = text.replace(/\{([^{}]*)\}/g, (_, expression) => evaluate(expression));
        if (/[{}$]/.test(text)) throw new Error('时延参数未解析，请使用 {$变量名} 并检查链接参数表');
      } catch (error) { return { kind: 'unknown', reason: error.message }; }
      let match = text.match(new RegExp('^(' + numberPattern + ')\\s*(' + units + ')?$', 'i'))
        || (parts.length === 1 && text.match(new RegExp('^[^\\d+\\-]*?(' + numberPattern + ')\\s*(' + units + ')$', 'i')));
      if (!match && /[+*/()]|\d\s*-/.test(text)) {
        const suffix = text.match(new RegExp('\\s*(' + units + ')$', 'i'));
        const expression = suffix ? text.slice(0, suffix.index).trim() : text;
        try {
          const value = String(evaluate(expression)).trim();
          if (!new RegExp('^' + numberPattern + '$', 'i').test(value)) throw new Error('时延公式结果不是有限数值');
          match = [text, value, suffix && suffix[1]];
        } catch (error) { return { kind: 'unknown', reason: '时延公式：' + error.message }; }
      }
      if (!match) return { kind: /[\d=＝{}$]/.test(raw) ? 'unknown' : 'ignored', reason: '标签没有唯一、明确的时延数值' };
      let value = Number(match[1]);
      const unit = (match[2] || 'cycle').toLowerCase();
      if (!['cycle', 'cycles', '周期'].includes(unit)) {
        if (!(Number(cycleTimeNs) > 0) || !Number.isFinite(Number(cycleTimeNs)))
          return { kind: 'unknown', reason: '请先配置每 cycle 的时长（ns）' };
        const scale = { s: 1e9, ms: 1e6, us: 1e3, 'µs': 1e3, 'μs': 1e3, ns: 1, ps: 1e-3 };
        value *= scale[unit] / Number(cycleTimeNs);
      }
      return Number.isFinite(value) ? normalizeDelay({ kind: 'delay', value }) : { kind: 'unknown', reason: '时延数值超出范围' };
    }
    function edgeParts(value) {
      const match = String(value || '').trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
      const token = match ? match[1] : '', ids = token.match(/[a-zA-Z0-9]/g) || [];
      return { from: ids[0], to: ids[ids.length - 1], arrow: token, label: match ? (match[2] || '').replace(/^:\s*/, '') : '' };
    }
    function flatten(items, result) {
      (items || []).forEach((item) => {
        if (Array.isArray(item)) flatten(item.slice(typeof item[0] === 'string' ? 1 : 0), result);
        else if (item && typeof item === 'object') result.push(item);
      });
      return result;
    }
    function format(value) { return Number(Number(value).toPrecision(10)).toString(); }
    function seriesLabel(value, style) {
      const number = Number.isInteger(value) ? value : Number(value.toPrecision(15));
      let text = style.radix === 10 ? String(number) : Math.abs(number).toString(style.radix);
      if (style.upper) text = text.toUpperCase();
      if (Number.isInteger(number)) text = text.replace(/^-/, '').padStart(style.width, '0');
      return style.prefix + (number < 0 ? '-' : style.plus ? '+' : '') + style.marker + text.replace(/^-/, '') + style.suffix;
    }
    function analyze(source, edgeTimings, parameterConversions) {
      if (!source || !Array.isArray(source.signal)) throw new Error('signal 必须是波形数组');
      const config = source.timingCheck || {};
      const tolerance = Number.isFinite(Number(config.tolerance)) && Number(config.tolerance) >= 0 ? Number(config.tolerance) : 1e-7;
      const rows = [], gaps = [], nodes = new Map(), duplicates = new Set(), graph = [[]], constraints = [], issues = [], edges = [];
      const sourceEdges = Array.isArray(source.edge) ? source.edge : [];
      const edgeTiming = (raw, index) => normalizeDelay(edgeTimings && edgeTimings[index] || parseDelay(edgeParts(raw).label, config.cycleTimeNs));
      const referencedNodes = new Set(sourceEdges.flatMap((raw) => {
        const parsed = edgeParts(raw);
        return [parsed.from, parsed.to].filter(Boolean);
      }));
      const makeBlock = () => { graph.push([]); return graph.length - 1; };
      function constraint(a, b, value, meta) {
        const id = constraints.length;
        constraints.push(Object.assign({ a, b, value }, meta));
        graph[a].push({ to: b, value, id }); graph[b].push({ to: a, value: -value, id });
      }
      function issue(kind, reason, rowIds, edgeIds, gapIds, locations) {
        const relatedRows = Array.from(new Set(rowIds || []));
        // A failed check belongs to the last participating row in top-down order;
        // earlier rows remain references, not additional failures.
        const markedRows = kind === 'conflict' && relatedRows.length
          ? [relatedRows.reduce((last, id) => Math.max(last, id), -1)] : relatedRows;
        const entry = { kind, reason, rows: markedRows, relatedRows, edges: Array.from(new Set(edgeIds || [])), gaps: gapIds || [], locations: locations || [] };
        issues.push(entry); return entry;
      }
      const signals = flatten(source.signal, []), stretches = new Map(), holdStarts = new Map(), dataEnds = [];
      function buildRows() { signals.forEach((signal, index) => {
        const wave = String(signal.wave || ''), node = String(signal.node || '');
        let lastNode = node.length - 1;
        while (lastNode >= 0 && !/[a-zA-Z0-9]/.test(node[lastNode])) lastNode--;
        let lastWave = wave.length - 1, lastReferencedNode = lastNode;
        while (lastWave >= 0 && /[|\s]/.test(wave[lastWave])) lastWave--;
        while (lastReferencedNode >= 0 && !referencedNodes.has(node[lastReferencedNode])) lastReferencedNode--;
        let lastKnownWave = -1, finalState = 'x';
        const dataEndColumns = new Set();
        for (let col = 0; col < wave.length; col++) {
          const char = wave[col];
          if (!/[. |]/.test(char)) {
            if (/[2-9=]/.test(finalState)) dataEndColumns.add(col - 1);
            finalState = char.toLowerCase();
          }
          if (char !== '|' && char !== ' ' && finalState !== 'x') lastKnownWave = col;
        }
        if (/[2-9=]/.test(finalState)) dataEndColumns.add(wave.length - 1);
        dataEnds[index] = dataEndColumns;
        const unknownTailStart = finalState === 'x' && wave.length ? lastKnownWave + 1
          : lastReferencedNode >= wave.length ? wave.length : undefined;
        const length = Math.max(wave.length, lastNode);
        const period = signal.period === undefined ? 1 : Number(signal.period);
        const phase = signal.phase === undefined ? 0 : Number(signal.phase);
        const row = { index, name: String(signal.name || '(空行)'), length, sourceLength: wave.length, period, phase, blocks: [], runs: [], gaps: [],
          empty: lastWave < 0, checkUntil: Math.max(lastKnownWave, lastReferencedNode), unknownTailStart,
          known: false, supported: true, status: 'ok', reasons: [] };
        rows.push(row);
        if (!(period > 0) || !Number.isFinite(period * length) || !Number.isFinite(phase)) {
          issue('unknown', 'period 必须为正有限数值，phase 必须为有限数值', [index]); row.supported = false;
          row.period = 1; row.phase = 0;
        } else if (halfCycle(period) === null || halfCycle(period) <= 0 || halfCycle(phase) === null
            || halfCycle(halfCycle(period) * length) === null || /[pPnN]/.test(wave) && halfCycle(halfCycle(period) / 2) === null) {
          issue('unknown', '时延检查仅支持 0.5 cycle 的整数倍：请检查 period、phase；时钟半周期也须符合此精度', [index]);
          row.supported = false; row.period = 1; row.phase = 0;
        } else {
          row.period = halfCycle(period); row.phase = halfCycle(phase);
        }
        if (/[<>]/.test(wave)) { row.supported = false; issue('unknown', '此行包含 < > 变步长符号，暂不能可靠推算', [index]); }
        let block = { id: makeBlock(), col: 0, end: 0 };
        row.blocks.push(block);
        if (row.supported) constraint(0, block.id, -row.phase, { rows: [index], label: '第' + (index + 1) + '行起点/phase' });
        const labels = Array.isArray(signal.data) ? signal.data : String(signal.data || '').trim().split(/\s+/).filter(Boolean);
        let dataIndex = 0, state = 'x', symbol = 'x', value = 'x', slot = -1, clockBlock = null, clockOffset = 0;
        const stretchEnds = stretches.get(index);
        function consume(char, col, keepClock) {
          if (/[2-9=]/.test(char)) { symbol = char; state = 'bus'; slot = dataIndex; value = String(labels[dataIndex++] ?? ''); }
          else if (char !== '.' && char !== ' ' && char !== '|') {
            symbol = state = char; value = char; slot = -1;
            if (!keepClock && /[pPnN]/.test(char)) { clockBlock = block.id; clockOffset = (col - block.col) * row.period; }
          }
          if (col < wave.length && state.toLowerCase() !== 'x') row.known = true;
        }
        function addRun(col, end, gap) {
          const previous = row.runs[row.runs.length - 1];
          if (!gap && previous && !previous.gap && previous.block === block.id && previous.end === col
              && previous.symbol === symbol && previous.state === state && previous.slot === slot && previous.value === value) previous.end = end;
          else row.runs.push({ col, end, block: block.id, offset: (col - block.col) * row.period, symbol, state, value, slot, gap, clockBlock, clockOffset });
        }
        for (let col = 0; col <= length; col++) {
          const id = node[col];
          if (id && /[a-zA-Z0-9]/.test(id) && referencedNodes.has(id)) {
            const entry = { row: index, col, block: block.id, offset: (col - block.col) * row.period };
            if (nodes.has(id)) { duplicates.add(id); issue('unknown', '端点 ' + id + ' 重复，无法确定连接位置', [index, nodes.get(id).row]); }
            nodes.set(id, entry);
          }
          if (col === length) break;
          const char = wave[col] || 'x';
          const stretchEnd = stretchEnds && stretchEnds.get(col);
          if (stretchEnd !== undefined) {
            consume(char, col, false); block.end = col;
            const next = { id: makeBlock(), col: stretchEnd, end: stretchEnd };
            const omissions = [];
            for (let j = col; j < stretchEnd; j++) if (wave[j] === '|') omissions.push(j);
            const gap = { index: gaps.length, row: index, col, endCol: stretchEnd, kind: 'stretch',
              a: block.id, b: next.id, offset: (col - block.col) * row.period,
              minimum: col >= unknownTailStart ? 0 : (stretchEnd - col - omissions.length) * row.period,
              unboundedTail: col >= unknownTailStart, omissions, state, ignored: stretchEnd > row.checkUntil,
              holdStart: holdStarts.get(index)?.get(col) };
            gaps.push(gap); row.gaps.push(gap.index); addRun(col, stretchEnd, gap.index + 1);
            for (let j = col + 1; j < stretchEnd; j++) consume(wave[j] || 'x', j, true);
            block = next; row.blocks.push(block); col = stretchEnd - 1;
          } else if (char === '|') {
            block.end = col;
            const next = { id: makeBlock(), col: col + 1, end: col + 1 };
            // A terminal omission needs no duration unless a later waveform or connected node uses it.
            const gap = { index: gaps.length, row: index, col, a: block.id, b: next.id,
              offset: (col - block.col) * row.period, ignored: col >= row.checkUntil };
            gaps.push(gap); row.gaps.push(gap.index); addRun(col, col + 1, gap.index + 1);
            block = next; row.blocks.push(block);
          } else {
            consume(char, col, false);
            addRun(col, col + 1, 0); block.end = col + 1;
          }
        }
      }); }
      buildRows();
      // Equal-valued intervals and omitted continuations can share one elastic
      // span. Keep every endpoint as a solver boundary.
      const uniformRows = new Map(), ranges = new Map();
      const heldSpans = new Map();
      signals.forEach((signal, index) => {
        if (!rows[index].supported) return;
        const wave = String(signal.wave || ''), spans = [];
        // A closed hold can have one elastic duration across multiple omissions.
        // Explicit symbols start new holds, even when their data values match.
        for (let col = 0; col < wave.length; col++) {
          if (/[.\s|<>]/.test(wave[col])) continue;
          let right = col + 1;
          const omissions = [];
          while (right < wave.length && /[. |]/.test(wave[right])) {
            if (wave[right] === '|') omissions.push(right);
            right++;
          }
          // Keep a single bus omission available to arithmetic-series inference.
          // Multiple omissions within one data value need only a total duration.
          if (omissions.length && right < wave.length && right <= rows[index].checkUntil
              && (!/[2-9=]/.test(wave[col]) || omissions.length > 1))
            spans.push({ left: col, right, omissions });
          // Keep the final data cell fixed so its original column can anchor the
          // end of a terminal hold without assigning times to interior dots.
          else if (omissions.length && right === wave.length && /[2-9=]/.test(wave[col]) && /[. ]/.test(wave[right - 1]))
            spans.push({ left: col, right: right - 1, omissions });
          col = right - 1;
        }
        if (spans.length) { heldSpans.set(index, spans); ranges.set(index, spans.slice()); }
        // Referenced endpoints in an unknown tail retain explicit delays, but the
        // drawn x, . and | count supplies no fixed duration between those endpoints.
        const tail = rows[index].unknownTailStart;
        if (tail !== undefined && rows[index].checkUntil > tail) {
          if (!ranges.has(index)) ranges.set(index, []);
          ranges.get(index).push({ left: tail, right: rows[index].checkUntil });
        }
      });
      sourceEdges.forEach((raw, index) => {
        const parsed = edgeParts(raw), from = nodes.get(parsed.from), to = nodes.get(parsed.to);
        const timing = edgeTiming(raw, index);
        if (!from || !to || from.row !== to.row || from.col === to.col || duplicates.has(parsed.from) || duplicates.has(parsed.to)
            || timing.kind !== 'delay') return;
        const row = rows[from.row], left = Math.min(from.col, to.col), right = Math.max(from.col, to.col);
        if (!row.supported || right > row.sourceLength) return;
        if (!uniformRows.has(row.index)) {
          const spans = [];
          row.runs.forEach((run) => {
            const omittedContinuation = !!run.gap;
            const previous = spans[spans.length - 1];
            if (previous && previous.end === run.col
                && previous.symbol === run.symbol && previous.value === run.value) previous.end = run.end;
            else spans.push(Object.assign({}, run, omittedContinuation ? { gap: 0 } : {}));
          });
          uniformRows.set(row.index, spans);
        }
        const spans = uniformRows.get(row.index);
        let lo = 0, hi = spans.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (spans[mid].end <= left) lo = mid + 1; else hi = mid; }
        const span = spans[lo];
        if (!span || span.gap || span.col > left || span.end < right) return;
        const omission = String(signals[row.index].wave || '').indexOf('|', left);
        const hasOmission = omission >= left && omission < right;
        if (!hasOmission && !(left >= row.unknownTailStart)
            && timing.value * Math.sign(to.col - from.col) <= (right - left) * row.period + Math.max(EPS, tolerance)) return;
        if (!ranges.has(row.index)) ranges.set(row.index, []);
        ranges.get(row.index).push({ left, right, connection: true });
      });
      const rowNodes = signals.map((signal) => Array.from(String(signal.node || '').matchAll(/[a-zA-Z0-9]/g))
        .filter((match) => referencedNodes.has(match[0])).map((match) => match.index));
      ranges.forEach((intervals, row) => {
        intervals.sort((a, b) => a.left - b.left || a.right - b.right);
        const merged = [];
        intervals.forEach((interval) => {
          const last = merged[merged.length - 1];
          if (last && interval.left < last.right) last.right = Math.max(last.right, interval.right);
          else merged.push(Object.assign({}, interval));
        });
        const holds = heldSpans.get(row) || [];
        const explicit = intervals.filter((interval) => interval.connection);
        const boundaries = Array.from(new Set(holds.flatMap((span) => [span.left, span.right]))).sort((a, b) => a - b);
        let connectionIndex = 0, connectionEnd = -1;
        const holdCuts = boundaries.filter((col) => {
          while (connectionIndex < explicit.length && explicit[connectionIndex].left < col)
            connectionEnd = Math.max(connectionEnd, explicit[connectionIndex++].right);
          // One explicit delay already spans this uniform region; synthetic hold
          // boundaries must not split it into independently unknown durations.
          return col >= connectionEnd;
        });
        const cuts = Array.from(new Set(rowNodes[row].concat(holdCuts))).sort((a, b) => a - b);
        const ends = new Map(), origins = new Map();
        let cursor = 0;
        merged.forEach(({ left, right }) => {
          while (cursor < cuts.length && cuts[cursor] <= left) cursor++;
          let start = left;
          while (cursor < cuts.length && cuts[cursor] < right) {
            if (cuts[cursor] > start) { ends.set(start, cuts[cursor]); start = cuts[cursor]; }
            cursor++;
          }
          ends.set(start, right);
        });
        let holdIndex = 0, explicitIndex = 0, explicitEnd = -1;
        ends.forEach((end, col) => {
          while (holdIndex < holds.length && holds[holdIndex].right <= col) holdIndex++;
          while (explicitIndex < explicit.length && explicit[explicitIndex].left <= col) explicitEnd = Math.max(explicitEnd, explicit[explicitIndex++].right);
          const hold = holds[holdIndex];
          if (hold && hold.left <= col && end <= hold.right) {
            let lo = 0, hi = hold.omissions.length;
            while (lo < hi) { const mid = (lo + hi) >> 1; if (hold.omissions[mid] < col) lo = mid + 1; else hi = mid; }
            // Node cuts must not make omission-free pieces elastic unless an
            // explicit same-value delay already permits stretching that piece.
            if (!(hold.omissions[lo] < end) && explicitEnd < end && !(col >= rows[row].unknownTailStart)) ends.delete(col);
            else origins.set(col, hold.left);
          }
        });
        stretches.set(row, ends);
        holdStarts.set(row, origins);
      });
      if (stretches.size) {
        rows.length = gaps.length = constraints.length = issues.length = 0;
        graph.length = 1; graph[0] = []; nodes.clear(); duplicates.clear();
        buildRows();
      }
      const spanName = (gap) => '第' + gap.col + '列' + (gap.kind === 'stretch' ? '至' + gap.endCol + '列' + (gap.holdStart !== undefined
        ? '保持区域' : gap.omissions.length ? '延续与省略区域' : '同值区域') : ' |');
      const minimumDuration = (gap) => gap.kind === 'stretch' ? gap.minimum : 0;
      const strictDuration = (gap) => gap.kind !== 'stretch' || gap.omissions.length > 0 && !gap.unboundedTail;
      const validDuration = (gap, duration) => strictDuration(gap) ? duration > minimumDuration(gap) : duration >= gap.minimum - Math.max(EPS, tolerance);
      sourceEdges.forEach((raw, index) => {
        const parsed = edgeParts(raw), from = nodes.get(parsed.from), to = nodes.get(parsed.to);
        const timing = edgeTiming(raw, index);
        const edge = Object.assign({ index, fromNode: from, toNode: to, timing, option: (source.edgeOptions || [])[index] || {} }, parsed);
        edges.push(edge);
        const rowIds = [from && from.row, to && to.row].filter((id) => id !== undefined);
        if (!from || !to || duplicates.has(parsed.from) || duplicates.has(parsed.to) || !rows[from.row].supported || !rows[to.row].supported) {
          edge.invalid = true; issue('unknown', '连接 ' + (index + 1) + ' 的端点缺失、重复或所在行时间格式不支持', rowIds, [index]); return;
        }
        if (timing.kind === 'unknown') issue('unknown', '连接 ' + (index + 1) + '：' + timing.reason, rowIds, [index]);
        if (timing.kind === 'delay') constraint(from.block, to.block, timing.value + from.offset - to.offset,
          { rows: rowIds, edge: index, label: parsed.from + '→' + parsed.to + '=' + timing.value + ' cycle' });
      });
      // A spanning forest supplies absolute or relative times and a concrete path for conflicts.
      const values = new Array(graph.length), groups = new Array(graph.length), parent = [], parentEdge = [];
      const checked = new Set(), components = [];
      function pathIds(a, b) {
        const ancestors = new Set();
        for (let n = a; n !== undefined; n = parent[n]) ancestors.add(n);
        let common = b;
        while (!ancestors.has(common)) common = parent[common];
        const ids = [];
        for (let n = a; n !== common; n = parent[n]) ids.push(parentEdge[n]);
        for (let n = b; n !== common; n = parent[n]) ids.push(parentEdge[n]);
        return ids;
      }
      for (let start = 0; start < graph.length; start++) {
        if (values[start] !== undefined) continue;
        const group = components.length, queue = [start]; components.push(queue);
        values[start] = 0; groups[start] = group;
        for (let head = 0; head < queue.length; head++) {
          const current = queue[head];
          for (const arc of graph[current]) {
            const expected = values[current] + arc.value;
            if (values[arc.to] === undefined) {
              values[arc.to] = expected; groups[arc.to] = group; parent[arc.to] = current; parentEdge[arc.to] = arc.id; queue.push(arc.to);
            } else if (!checked.has(arc.id) && Math.abs(values[arc.to] - expected) > Math.max(EPS, tolerance)) {
              const related = pathIds(current, arc.to).concat(arc.id).map((id) => constraints[id]);
              issue('conflict', '时延约束相差 ' + format(Math.abs(values[arc.to] - expected)) + ' cycle：'
                + related.map((item) => item.label).join('；'), related.flatMap((item) => item.rows), related.map((item) => item.edge).filter((id) => id !== undefined));
            }
            checked.add(arc.id);
          }
        }
      }
      const bounds = [];
      gaps.forEach((gap) => {
        if (gap.ignored) return;
        const a = groups[gap.a], b = groups[gap.b];
        if (a === b) {
          gap.duration = values[gap.b] - values[gap.a] - gap.offset;
          gap.durationSource = 'connection';
          if (!validDuration(gap, gap.duration)) {
            const related = pathIds(gap.a, gap.b).map((id) => constraints[id]);
            issue('conflict', '第' + (gap.row + 1) + '行' + spanName(gap) + '推算为 '
              + format(gap.duration) + ' cycle，' + (gap.kind === 'stretch' ? gap.omissions.length
                ? '必须大于固定' + (gap.holdStart !== undefined ? '保持' : '未知') + '波形的 ' + format(gap.minimum) + ' cycle，省略间隔须有正时长'
                : '不能短于原时长 ' + format(gap.minimum) + ' cycle' : '间隔总时长必须大于0'), [gap.row].concat(related.flatMap((item) => item.rows)),
              related.map((item) => item.edge).filter((id) => id !== undefined), [gap.index]);
          }
        } else bounds.push({ from: b, to: a, weight: values[gap.b] - values[gap.a] - gap.offset - minimumDuration(gap), strict: strictDuration(gap) ? 1 : 0, gap });
      });
      // Keep a feasible bound system so a lower-priority anchor cannot contradict any connection,
      // including connections separated from it by several still-unknown positive gaps.
      const outgoing = Array.from({ length: components.length }, () => []);
      bounds.forEach((edge) => outgoing[edge.from].push(edge));
      const distances = new Array(components.length).fill(0), strictness = distances.slice();
      let boundWork = 0;
      function relaxBounds(seeds, trial) {
        const queue = seeds.slice(), waiting = new Set(queue), depth = new Map(), previous = [], changes = new Map();
        function failed(reason, cycle) {
          if (trial) changes.forEach((old, id) => { distances[id] = old[0]; strictness[id] = old[1]; });
          return { ok: false, reason, cycle };
        }
        for (let head = 0; head < queue.length; head++) {
          const current = queue[head]; waiting.delete(current);
          for (const bound of outgoing[current]) {
            if (++boundWork > 2000000) return failed('limit');
            const candidate = distances[current] + bound.weight;
            const nextStrictness = strictness[current] + bound.strict;
            if (distances[bound.to] > candidate || distances[bound.to] === candidate && strictness[bound.to] < nextStrictness) {
              if (trial && !changes.has(bound.to)) changes.set(bound.to, [distances[bound.to], strictness[bound.to]]);
              distances[bound.to] = candidate; strictness[bound.to] = nextStrictness;
              previous[bound.to] = bound; depth.set(bound.to, (depth.get(current) || 0) + 1);
              if (depth.get(bound.to) >= components.length) {
                if (trial) return failed('conflict');
                let n = bound.to;
                for (let i = 0; i < components.length; i++) n = previous[n].from;
                const cycle = [], first = n;
                do { cycle.push(previous[n].gap); n = previous[n].from; } while (n !== first);
                return failed('conflict', cycle);
              }
              if (!waiting.has(bound.to)) { waiting.add(bound.to); queue.push(bound.to); }
            }
          }
        }
        return { ok: true };
      }
      let feasible = relaxBounds(components.map((_, index) => index), false);
      while (!feasible.ok) {
        if (feasible.reason === 'limit') {
          issue('unknown', '间隔约束过多，正时长检查未完成', gaps.map((gap) => gap.row));
          break;
        }
        else {
          const cycle = feasible.cycle;
          const related = cycle.flatMap((gap, index) => pathIds(gap.b, cycle[(index + 1) % cycle.length].a).map((id) => constraints[id]));
          const entry = issue('conflict', '这些区间无法同时满足时长要求（| 必须为正，同值区域不能短于原时长），请检查连接标签', cycle.map((gap) => gap.row).concat(related.flatMap((item) => item.rows)),
            related.map((item) => item.edge).filter((id) => id !== undefined), cycle.map((gap) => gap.index));
          // Quarantine the contradictory rows, not the whole diagram. Their
          // components remain blocked below; independent rows can still solve.
          const excludedRows = new Set(entry.relatedRows);
          let removed = 0;
          outgoing.forEach((arcs, index) => {
            outgoing[index] = arcs.filter((bound) => {
              if (bound.gap && excludedRows.has(bound.gap.row)) { removed++; return false; }
              return true;
            });
          });
          if (!removed) break;
          distances.fill(0); strictness.fill(0);
          feasible = relaxBounds(components.map((_, index) => index), false);
        }
      }
      const shifts = new Array(components.length).fill(null), alignmentSources = new Map();
      shifts[0] = 0;
      function time(block, offset) {
        const shift = shifts[groups[block]], result = values[block] + (offset || 0) + shift;
        return shift !== null ? halfCycle(result) : null;
      }
      const conflictRows = new Set(issues.filter((entry) => entry.kind === 'conflict').flatMap((entry) => entry.relatedRows));
      const blockedGroups = new Set();
      conflictRows.forEach((id) => rows[id].blocks.forEach((block) => blockedGroups.add(groups[block.id])));
      edges.filter((edge) => edge.timing.kind === 'unknown' || edge.invalid).forEach((edge) => {
        [edge.fromNode, edge.toNode].forEach((node) => { if (node) blockedGroups.add(groups[node.block]); });
      });
      function alignGroup(group, shift) {
        const additions = [{ from: 0, to: group, weight: shift, strict: 0 }, { from: group, to: 0, weight: -shift, strict: 0 }];
        additions.forEach((bound) => outgoing[bound.from].push(bound));
        const result = relaxBounds([0, group], true);
        if (!result.ok) additions.forEach((bound) => outgoing[bound.from].pop());
        else shifts[group] = shift;
        return result;
      }
      function resolveRowTimes(row) {
        row.blocks.forEach((block) => { block.time = time(block.id); });
        row.gaps.forEach((id) => {
          const gap = gaps[id]; gap.start = time(gap.a, gap.offset); gap.end = time(gap.b);
          if (!gap.ignored && gap.durationSource !== 'connection' && gap.durationSource !== 'data-series' && gap.start !== null && gap.end !== null && gap.end > gap.start) {
            gap.duration = gap.end - gap.start;
            const sources = [gap.a, gap.b].map((block) => alignmentSources.get(groups[block])).filter(Boolean);
            const directions = new Set(sources.map((entry) => entry.direction));
            gap.durationSource = directions.size > 1 ? directions.has('data-series') ? 'mixed-sources' : 'adjacent-rows' : sources.length ? sources[0].direction : undefined;
          }
        });
        row.runs.forEach((run) => {
          run.start = time(run.block, run.offset);
          run.finish = run.gap ? gaps[run.gap - 1].end : run.start === null ? null : run.start + (run.end - run.col) * row.period;
          run.clockOrigin = run.clockBlock === null ? null : time(run.clockBlock, run.clockOffset);
        });
      }
      // Proportional offsets are for drawing original-column locations only.
      // They must never become solver anchors, even when they happen to land on a tick.
      function displayColumnOffset(row, run, col) {
        if (!run.gap) return (col - run.col) * row.period;
        const gap = gaps[run.gap - 1];
        if (gap.kind !== 'stretch') return null;
        if (col === run.col) return 0;
        // A known total duration can size the reference strip without assigning
        // actual times to the interior original columns.
        if (Number.isFinite(gap.duration) && validDuration(gap, gap.duration))
          return (col - run.col) * gap.duration / (run.end - run.col);
        const start = time(gap.a, gap.offset), end = time(gap.b);
        return start !== null && end !== null && end > start ? (col - run.col) * (end - start) / (run.end - run.col) : null;
      }
      const directionName = (direction) => direction === 'data-series' ? '数据等差推断' : direction === 'previous-row' ? '上一行' : '下一行';
      function alignmentPoint(row, run, col) {
        const point = (block, offset) => ({ block, offset, groups: [groups[block]], expanded: !!run.gap });
        if (!run.gap) return point(run.block, run.offset + (col - run.col) * row.period);
        const gap = gaps[run.gap - 1];
        if (gap.kind !== 'stretch') return null;
        if (col === run.col) return point(gap.a, gap.offset);
        // Fixed cells outside the omissions retain their width. Between multiple
        // omissions only the total is known; their individual lengths are not.
        if (gap.omissions.length && col <= gap.omissions[0]) return point(gap.a, gap.offset + (col - run.col) * row.period);
        if (gap.omissions.length && col > gap.omissions[gap.omissions.length - 1]) return point(gap.b, -(run.end - col) * row.period);
        return null;
      }
      function finalCellPoint(row, col, reference) {
        if (col < 0 || col >= row.sourceLength || col > row.checkUntil) return null;
        const wave = String(signals[row.index].wave || '');
        if (wave[col] === '|') return null;
        let lo = 0, hi = row.runs.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (row.runs[mid].end <= col) lo = mid + 1; else hi = mid; }
        const run = row.runs[lo];
        if (!run || run.col > col || run.state.toLowerCase() === 'x') return null;
        if (reference && run.state === 'bus' && !dataEnds[row.index].has(col) && !/[2-9=]/.test(wave[col])) return null;
        const gap = run.gap && gaps[run.gap - 1];
        if (gap && gap.kind !== 'stretch') return null;
        if (gap && run.state === 'bus' && dataEnds[row.index].has(col) && gap.endCol === col + 1)
          return { block: gap.b, offset: -row.period, groups: [groups[gap.b]], expanded: true };
        return alignmentPoint(row, run, col);
      }
      function alignmentCandidates(row, reference, eligible, visit) {
        if (!reference || !row.supported || !reference.supported || conflictRows.has(row.index) || conflictRows.has(reference.index)) return;
        const rowWave = String(signals[row.index].wave || '');
        const referenceWave = String(signals[reference.index].wave || '');
        let referenceIndex = 0;
        for (const run of row.runs) {
          if ((!eligible(groups[run.block]) && !(run.gap && eligible(groups[gaps[run.gap - 1].b])))
              || run.gap && gaps[run.gap - 1].kind !== 'stretch' || run.state.toLowerCase() === 'x'
              || run.col >= row.sourceLength || run.col > row.checkUntil) continue;
          // Match data boundaries on both rows. A held value must not acquire a
          // fixed duration from an interior continuation before its next boundary.
          if (run.state === 'bus' && !/[2-9=]/.test(rowWave[run.col] || '')) continue;
          const holdStart = run.gap ? gaps[run.gap - 1].holdStart : undefined;
          if (holdStart !== undefined && run.col !== holdStart) continue;
          const runEnd = run.state === 'bus' || holdStart !== undefined ? run.col + 1 : run.end;
          while (referenceIndex < reference.runs.length && reference.runs[referenceIndex].end <= run.col) referenceIndex++;
          for (let j = referenceIndex; j < reference.runs.length && reference.runs[j].col < runEnd; j++) {
            const anchor = reference.runs[j];
            const first = Math.max(run.col, anchor.col);
            let last = Math.min(runEnd, anchor.end, row.sourceLength, reference.sourceLength, row.checkUntil + 1, reference.checkUntil + 1) - 1;
            if (anchor.state.toLowerCase() === 'x' || last < first) continue;
            // A data value supplies one anchor at its original symbol, not at
            // continuation columns or fragments split off by an omission/stretch.
            if (anchor.state === 'bus') {
              if (first !== anchor.col || !/[2-9=]/.test(referenceWave[anchor.col] || '')) continue;
              last = first;
            }
            let stop = false;
            for (const col of last > first ? [first, last] : [first]) {
              if (rowWave[col] === '|' || referenceWave[col] === '|') continue;
              const point = alignmentPoint(row, run, col), referencePoint = alignmentPoint(reference, anchor, col);
              if (!point || !referencePoint) continue;
              const group = groups[point.block];
              if (!eligible(group)) continue;
              const target = halfCycle(time(referencePoint.block, referencePoint.offset));
              if (target === null) continue;
              const shift = target - values[point.block] - point.offset;
              if (!Number.isFinite(shift)) continue;
              stop = visit({ group, block: point.block, col, target, shift, referenceGroups: referencePoint.groups,
                referenceExpanded: referencePoint.expanded });
              if (stop) break;
            }
            if (stop) break;
          }
        }
        for (const col of dataEnds[row.index]) {
          if (!/[. ]/.test(rowWave[col] || '')) continue;
          const point = finalCellPoint(row, col), anchor = finalCellPoint(reference, col, true);
          if (!point || !anchor) continue;
          const group = groups[point.block];
          if (!eligible(group)) continue;
          const target = halfCycle(time(anchor.block, anchor.offset));
          if (target === null) continue;
          const shift = target - values[point.block] - point.offset;
          if (Number.isFinite(shift)) visit({ group, block: point.block, col, target, shift,
            referenceGroups: anchor.groups, referenceExpanded: anchor.expanded, finalDataCell: true });
        }
      }
      const componentRows = components.map(() => new Set());
      const componentColumns = components.map(() => new Map());
      const blocksById = new Map();
      rows.forEach((row) => row.blocks.forEach((block) => {
        blocksById.set(block.id, block);
        const group = groups[block.id]; componentRows[group].add(row.index);
        if (!componentColumns[group].has(row.index)) componentColumns[group].set(row.index, []);
        componentColumns[group].get(row.index).push(block.col);
      }));
      // Empty spacer rows do not interrupt alignment or its dependency updates.
      const previousRows = new Array(rows.length), nextRows = new Array(rows.length);
      let previousRow = -1, nextRow = -1;
      for (let index = 0; index < rows.length; index++) {
        const reverse = rows.length - index - 1;
        previousRows[index] = previousRow; nextRows[reverse] = nextRow;
        if (!rows[index].empty) previousRow = index;
        if (!rows[reverse].empty) nextRow = reverse;
      }
      const aboveQueue = [], belowQueue = [], abovePending = new Set(), belowPending = new Set();
      let aboveHead = 0, belowHead = 0;
      function enqueue(index, below) {
        if (index < 0 || index >= rows.length || rows[index].empty) return;
        const pending = below ? belowPending : abovePending;
        if (pending.has(index)) return;
        pending.add(index); (below ? belowQueue : aboveQueue).push(index);
      }
      const seriesLinks = components.map(() => []);
      function recordAlignment(group, entry) {
        alignmentSources.set(group, entry);
        componentRows[group].forEach((id) => {
          for (const neighbour of [previousRows[id], id, nextRows[id]]) { enqueue(neighbour, false); enqueue(neighbour, true); }
        });
      }
      function positionSeries(seeds) {
        const queue = seeds.slice();
        for (let head = 0; head < queue.length; head++) {
          const group = queue[head];
          if (shifts[group] === null) continue;
          for (const link of seriesLinks[group]) {
            if (shifts[link.to] !== null) continue;
            const attempt = alignGroup(link.to, shifts[group] + link.delta);
            if (!attempt.ok) {
              issue(attempt.reason === 'limit' ? 'unknown' : 'conflict', '等差补全位置无法满足连接时延或间隔时长要求', [link.gap.row], [], [link.gap.index]);
              continue;
            }
            recordAlignment(link.to, { row: link.gap.row, referenceRow: link.gap.row, direction: 'data-series', gap: link.gap.index, referenceGroups: [group] });
            queue.push(link.to);
          }
        }
      }
      // Drain upper-row work first. Only newly positioned components wake their own
      // rows and neighbours, including rows sharing a cross-row connection.
      rows.forEach((row, index) => {
        enqueue(index, false); enqueue(rows.length - index - 1, true);
      });
      const rejectedAlignments = new Map();
      const alignmentKey = (row, direction, candidate) => row + ':' + direction + ':' + candidate.group + ':' + candidate.col;
      const componentGaps = components.map(() => []);
      gaps.filter((gap) => !gap.ignored).forEach((gap) => {
        componentGaps[groups[gap.a]].push(gap);
        if (groups[gap.b] !== groups[gap.a]) componentGaps[groups[gap.b]].push(gap);
      });
      function meetsMinimum(group, shift) {
        return componentGaps[group].every((gap) => {
          const a = groups[gap.a], b = groups[gap.b];
          const start = a === group ? shift : shifts[a], end = b === group ? shift : shifts[b];
          return start === null || end === null || validDuration(gap, values[gap.b] + end - values[gap.a] - start - gap.offset);
        });
      }
      function dependsOn(referenceGroups, targets) {
        const pending = referenceGroups.slice(), visited = new Set();
        while (pending.length) {
          const group = pending.pop();
          if (targets.has(group)) return true;
          if (visited.has(group)) continue;
          visited.add(group);
          pending.push(...(alignmentSources.get(group)?.referenceGroups || []));
        }
        return false;
      }
      function alignNeighbours() { while (feasible.ok && (aboveHead < aboveQueue.length || belowHead < belowQueue.length) && boundWork <= 2000000) {
        const below = aboveHead >= aboveQueue.length;
        const index = below ? belowQueue[belowHead++] : aboveQueue[aboveHead++];
        (below ? belowPending : abovePending).delete(index);
        const row = rows[index], reference = rows[below ? nextRows[index] : previousRows[index]];
        const direction = below ? 'next-row' : 'previous-row';
        alignmentCandidates(row, reference, (group) => shifts[group] === null && !blockedGroups.has(group), (candidate) => {
          const { group, col, target, shift, referenceExpanded, referenceGroups, finalDataCell } = candidate;
          const key = alignmentKey(index, direction, candidate);
          if (rejectedAlignments.has(key)) return false;
          const attempt = alignGroup(group, shift);
          if (attempt.ok) {
            recordAlignment(group, { row: index, referenceRow: reference.index, direction, col, time: target, referenceExpanded, referenceGroups, finalDataCell });
            positionSeries([group]);
          } else {
            // Do not block the other neighbour or another usable anchor.
            rejectedAlignments.set(key, { row: index, referenceRow: reference.index, direction, candidate, attempt });
          }
          return attempt.ok;
        });
      }
        const reported = new Set();
        rejectedAlignments.forEach(({ row: index, referenceRow, direction, candidate, attempt }) => {
          const { group, col, target } = candidate;
          if (shifts[group] !== null || reported.has(group)) return;
          reported.add(group);
          issue(attempt.reason === 'limit' ? 'unknown' : 'conflict', attempt.reason === 'limit'
              ? '相邻行对齐检查超出计算上限，保留未定位置'
              : '第' + (index + 1) + '行原列' + col + '按' + directionName(direction) + '（第' + (referenceRow + 1)
                + '行）对齐至 ' + format(target) + ' cycle 会违反连接时延或间隔时长要求；未采用该推算',
            [index, referenceRow], [], [], [{ row: index, col }, { row: referenceRow, col }]);
        });
      }
      // Known connection times are authoritative. Audit only inferred positions,
      // so disagreement is reported instead of silently replacing an upper anchor.
      const auditedConflicts = new Set();
      function auditAlignments() { rows.forEach((row) => {
        for (const direction of ['previous-row', 'next-row']) {
          const reference = rows[direction === 'previous-row' ? previousRows[row.index] : nextRows[row.index]];
          alignmentCandidates(row, reference, (group) => alignmentSources.has(group), (candidate) => {
            const { group, col, target, shift, referenceGroups } = candidate;
            if (rejectedAlignments.has(alignmentKey(row.index, direction, candidate)) || !meetsMinimum(group, shift)
                || dependsOn(referenceGroups, new Set([group]))) return false;
            const key = group + ':' + row.index + ':' + direction;
            if (Math.abs(shift - shifts[group]) <= Math.max(EPS, tolerance) || auditedConflicts.has(key)) return false;
            auditedConflicts.add(key);
            const chosen = alignmentSources.get(group), actual = target + shifts[group] - shift;
            const chosenColumn = Number.isInteger(chosen.col) ? '原列' + chosen.col + '锚点' : '已采用锚点';
            const sameReference = chosen.referenceRow === reference.index && chosen.direction !== 'data-series';
            const entry = issue('conflict', '第' + (row.index + 1) + '行原列' + col + '对齐冲突：由'
              + directionName(chosen.direction) + '（第' + (chosen.referenceRow + 1) + '行）' + chosenColumn + '推算本列为 ' + format(actual)
              + ' cycle，但' + (sameReference ? '该参考行原列' + col : directionName(direction) + '（第' + (reference.index + 1) + '行）同原列') + '为 '
              + format(target) + ' cycle，相差 ' + format(Math.abs(actual - target)) + ' cycle；未覆盖已采用的时刻，冲突结果仅供定位',
            [row.index, chosen.row, chosen.referenceRow, reference.index], [], [],
            [{ row: row.index, col }, { row: reference.index, col },
              { row: chosen.row, col: chosen.col }, { row: chosen.referenceRow, col: chosen.col }]);
            entry.timeComparison = { row: row.index, col, difference: Math.abs(actual - target), sources: [
              { direction: chosen.direction, row: chosen.referenceRow, col: chosen.col, time: actual },
              { direction, row: reference.index, col, time: target }
            ] };
            return true;
          });
        }
      }); }
      function conflictRegions(entry, row) {
        const regions = [];
        function add(col, end, dependencyEnd, gap) {
          if (Number.isFinite(col) && Number.isFinite(end)) regions.push({ col: Math.min(col, end), end: Math.max(col, end), dependencyEnd, gap });
        }
        entry.gaps.forEach((id) => {
          const gap = gaps[id];
          if (gap && gap.row === row.index && !gap.ignored) {
            const block = blocksById.get(gap.b);
            add(gap.col, gap.endCol ?? gap.col + 1, block && block.end, id);
          }
        });
        entry.locations.filter((location) => location.row === row.index).forEach(({ col }) => {
          if (!Number.isFinite(col)) return;
          let lo = 0, hi = row.blocks.length;
          while (lo < hi) { const mid = (lo + hi) >> 1; if (row.blocks[mid].col <= col) lo = mid + 1; else hi = mid; }
          const block = row.blocks[lo - 1];
          add(col, col, block && block.end);
          const id = lo > 1 ? row.gaps[lo - 2] : undefined, gap = gaps[id];
          if (gap && !gap.ignored) add(gap.col, gap.endCol ?? gap.col + 1, block.end, id);
        });
        entry.edges.forEach((id) => {
          const edge = edges[id], endpoints = [edge.fromNode, edge.toNode].filter((node) => node && node.row === row.index);
          if (endpoints.length === 2) add(endpoints[0].col, endpoints[1].col);
          else endpoints.forEach((node) => add(node.col, node.col));
        });
        return regions;
      }
      function propagateConflicts(seedIssues) {
        const consumers = rows.map(() => new Map());
        alignmentSources.forEach((entry, group) => componentRows[group].forEach((id) => {
          const targets = consumers[entry.referenceRow];
          if (!targets.has(id)) targets.set(id, []);
          componentColumns[group].get(id).forEach((col) => {
            targets.get(id).push({ row: id, col: entry.row === id && Number.isFinite(entry.col) ? entry.col : col, referenceCol: entry.col });
          });
        }));
        const failures = seedIssues || issues.filter((entry) => entry.kind === 'conflict');
        const invalidRows = new Set(failures.flatMap((entry) => entry.rows));
        const rowConflicts = rows.map(() => []);
        failures.forEach((entry) => entry.rows.forEach((id) => rowConflicts[id].push(entry)));
        // Propagate only affected anchors, and never invalidate an earlier row.
        for (let referenceRow = 0; referenceRow < rows.length; referenceRow++) {
          if (!invalidRows.has(referenceRow)) continue;
          const regions = rowConflicts[referenceRow].flatMap((entry) => conflictRegions(entry, rows[referenceRow]));
          consumers[referenceRow].forEach((locations, id) => {
            if (id <= referenceRow) return;
            const affected = regions.length ? locations.filter(({ referenceCol }) => !Number.isFinite(referenceCol)
              || regions.some((region) => referenceCol >= region.col && referenceCol <= (region.dependencyEnd ?? region.end))) : [];
            if (regions.length && !affected.length) return;
            invalidRows.add(id);
            rowConflicts[id].push(issue('conflict', '本行对齐所依据的第' + (referenceRow + 1) + '行存在时延冲突，推算结果仅供定位',
              [id, referenceRow], [], [], affected));
          });
        }
        return invalidRows;
      }
      const invalidRows = propagateConflicts();
      // Establish explicit data progressions before neighbour fallback can consume
      // their omissions. Empty bus cells count as samples, not as missing time.
      function numericLabel(label) {
        const text = String(label).trim();
        const matches = Array.from(text.matchAll(/[+-]?(?:0[xX][\da-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/g));
        if (matches.length !== 1) return null;
        const match = matches[0], raw = match[0], unsigned = raw.replace(/^[+-]/, '');
        const marker = unsigned.match(/^0[xXbBoO]/)?.[0] || '';
        const radix = marker ? { x: 16, b: 2, o: 8 }[marker[1].toLowerCase()] : 10;
        const value = Number(unsigned) * (raw[0] === '-' ? -1 : 1);
        if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) return null;
        const digits = unsigned.slice(marker.length);
        const style = { prefix: text.slice(0, match.index), suffix: text.slice(match.index + raw.length), radix, marker,
          upper: /[A-FXBO]/.test(unsigned), plus: raw[0] === '+', width: /^0\d+$/.test(digits) || marker ? digits.length : 0 };
        return { value, style, key: JSON.stringify([style.prefix, style.suffix, radix]) };
      }
      const nearNumber = (a, b) => Math.abs(a - b) <= 32 * Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
      function seriesSize(left, right, blanks, evidence, period) {
        const { step, columns } = evidence;
        if (evidence.reason) return { reason: evidence.reason, conflict: !!evidence.conflict };
        if (step === 0) return { reason: '相邻数据公差为 0，无法确定省略的数据项数' };
        if (left.run.end - left.run.col !== columns
            || new Set(blanks.map((item) => item.run.slot)).size !== blanks.length
            || blanks.some((item) => item.run.end - item.run.col !== columns))
          return { reason: '相邻数据或已有空白数据格的宽度不一致，无法确定每项时长' };
        if (left.run.slot === right.run.slot) return { reason: '两端为同一个延续数据，无法确定新的数列项' };
        const ratio = (right.label.value - left.label.value) / step, steps = Math.round(ratio), count = steps - 1 - blanks.length;
        if (!Number.isSafeInteger(steps)) return { reason: '等差补全项数超出可计算范围' };
        if (count < 1 || Math.abs(ratio - steps) > Math.min(1e-7, 32 * Number.EPSILON * Math.max(1, Math.abs(ratio))))
          return { conflict: true, reason: '两端数值差 ' + format(right.label.value - left.label.value) + ' ÷ 公差 '
            + format(step) + ' = ' + format(ratio) + ' 项间距，扣除 1 个间距和 ' + blanks.length + ' 个已有空白数据格后 | 需补 '
            + format(ratio - 1 - blanks.length) + ' 项，不是正整数' };
        const cellDuration = columns * period, duration = count * cellDuration;
        if (!Number.isFinite(duration) || !(duration > 0) || !Number.isSafeInteger(count * columns))
          return { reason: '等差补全项数或时长超出可计算范围' };
        return { duration, columns: count * columns, count, cellDuration };
      }
      const seriesQueue = [], seriesPending = new Set(), seriesDependents = new Map(), deferredSeriesCandidates = new Map();
      function enqueueSeries(entry) {
        if (!seriesPending.has(entry)) { seriesPending.add(entry); seriesQueue.push(entry); }
      }
      function neighbouringStep(entry, index, direction) {
        const { section, row } = entry, current = section[index];
        const columns = current.run.end - current.run.col;
        let distance = 0;
        const crossed = [];
        for (let i = index + direction; i >= 0 && i < section.length; i += direction) {
          const traversed = section[direction < 0 ? i : i - 1];
          if (traversed.run.gap) {
            const gap = gaps[traversed.run.gap - 1];
            if (!gap.series) {
              if (!seriesDependents.has(gap.index)) seriesDependents.set(gap.index, new Set());
              seriesDependents.get(gap.index).add(entry);
              return null;
            }
            if (!nearNumber(gap.series.cellDuration, columns * row.period)) return null;
            distance += gap.series.count; crossed.push(gap.series);
          } else {
            if (traversed.run.end - traversed.run.col !== columns) return null;
            distance++;
          }
          const other = section[i];
          if (other.run.gap || !other.label) continue;
          const before = direction < 0 ? other : current, after = direction < 0 ? current : other;
          const step = (after.label.value - before.label.value) / distance;
          const evidence = { step, columns, before: before.run.value, after: after.run.value, distance, side: direction < 0 ? 'left' : 'right' };
          if (distance > 1) {
            const beyond = section[i + direction];
            const earlier = beyond && beyond.label && !beyond.run.gap
              ? direction < 0 ? other.label.value - beyond.label.value : beyond.label.value - other.label.value : undefined;
            const confirmed = crossed.map((series) => series.step).concat(earlier === undefined ? [] : [earlier]);
            if (confirmed.some((value) => !nearNumber(value, step))) {
              evidence.reason = '更远处已知等差公差与本段端点不一致，不能跨过该变化沿推断';
              evidence.conflict = true;
            }
          }
          return evidence;
        }
        return null;
      }
      rows.forEach((row) => {
        if (!row.supported || invalidRows.has(row.index)) return;
        const labels = new Map(); let section = [], sectionKey = null;
        function flushSection() {
          if (!section.length) return;
          let leftIndex = -1;
          for (let i = 0; i < section.length; i++) {
            const right = section[i];
            if (!right.label || right.run.gap) continue;
            const previousIndex = leftIndex; leftIndex = i;
            if (previousIndex < 0 || i === previousIndex + 1) continue;
            const left = section[previousIndex], between = section.slice(previousIndex + 1, i);
            const omissions = between.filter((item) => item.run.gap);
            if (omissions.length !== 1) continue;
            const gap = gaps[omissions[0].run.gap - 1], blanks = between.filter((item) => !item.run.gap);
            if (gap.ignored || gap.kind === 'stretch') continue;
            gap.seriesContext = { before: left.run.value, after: right.run.value, col: left.run.end, end: right.run.col,
              blankCount: blanks.length, blankColumns: blanks.reduce((total, item) => total + item.run.end - item.run.col, 0) };
            between.forEach((item) => { item.run.seriesGap = gap.index + 1; });
            enqueueSeries({ row, section, previousIndex, rightIndex: i, left, right, gap, blanks });
          }
          section = []; sectionKey = null;
        }
        row.runs.forEach((run) => {
          if (!labels.has(run.slot)) labels.set(run.slot, run.state === 'bus' ? numericLabel(run.value) : null);
          const label = run.state === 'bus' ? labels.get(run.slot) : null;
          const blank = run.state === 'bus' && !run.value.trim();
          if ((!label && !blank) || run.col >= row.sourceLength || run.gap && gaps[run.gap - 1].kind === 'stretch') { flushSection(); return; }
          if (section.length && (label && sectionKey !== null && sectionKey !== label.key || section[section.length - 1].run.end !== run.col)) flushSection();
          if (label) sectionKey = label.key;
          section.push({ run, label });
        });
        flushSection();
      });
      for (let head = 0; head < seriesQueue.length; head++) {
        const entry = seriesQueue[head]; seriesPending.delete(entry);
        const { row, left, right, gap, blanks, previousIndex, rightIndex } = entry;
        if (gap.series || gap.seriesReported) continue;
        delete gap.seriesSummary; deferredSeriesCandidates.delete(gap.index);
        gap.seriesReason = '数据文本不足以确定等差公差和每项宽度';
        const evidence = [neighbouringStep(entry, previousIndex, -1), neighbouringStep(entry, rightIndex, 1)].filter(Boolean);
        gap.seriesAlternatives = evidence.map((item) => Object.assign({ kind: 'series', side: item.side,
          label: '等差序列（' + item.before + ' → ' + item.after + '，公差 ' + format(item.step)
            + (item.distance > 1 ? '，跨度 ' + item.distance + ' 项' : '') + '）' },
        seriesSize(left, right, blanks, item, row.period)));
        if (!evidence.length) continue;
        const makeCandidate = (index) => {
          const { step, columns } = evidence[index], { duration, count, cellDuration } = gap.seriesAlternatives[index];
          const beforeCount = blanks.filter((item) => item.run.col < gap.col).length;
          const fills = blanks.map((item, index) => ({ run: item.run, value: seriesLabel(left.label.value
            + step * (index + 1 + (item.run.col > gap.col ? count : 0)), left.label.style) }));
          return { gap, duration, fills, series: { first: left.label.value + step * (beforeCount + 1), step, count, cellDuration,
            before: left.run.value, after: right.run.value, style: left.label.style, filledCount: fills.length,
            evidence: evidence.filter((item, i) => !gap.seriesAlternatives[i].reason && nearNumber(item.step, step)
              && item.columns === columns).map(({ before, after, distance }) => ({ before, after, distance })) } };
        };
        const { step, columns } = evidence[0];
        const stepMismatch = evidence.some((item) => !nearNumber(item.step, step));
        if (stepMismatch || evidence.some((item) => item.columns !== columns)) {
          gap.seriesSummary = stepMismatch ? '两侧公差不一致' : '数据格宽度不一致';
          gap.seriesReason = stepMismatch ? '两侧相邻数据的公差不一致：' + evidence.map((item) => item.before + ' → ' + item.after
            + ' 的公差为 ' + format(item.step)).join('；') : '相邻数据或已有空白数据格的宽度不一致，无法确定每项时长';
          const viable = gap.seriesAlternatives.map((item, index) => item.reason ? -1 : index).filter((index) => index >= 0);
          // A reset beyond the gap can contradict the local progression.
          // Accept its sole viable candidate only after independent timing confirms it.
          if (viable.length === 1) deferredSeriesCandidates.set(gap.index, makeCandidate(viable[0]));
          continue;
        }
        const { duration, reason } = gap.seriesAlternatives[0];
        if (reason) { gap.seriesReason = reason; continue; }
        const candidate = makeCandidate(0);
        gap.seriesReason = seriesCandidateText(candidate);
        if (applySeriesCandidate(candidate)) {
          for (const dependent of seriesDependents.get(gap.index) || []) enqueueSeries(dependent);
        }
      }
      function seriesCandidateText({ duration, series }) {
        return '| 省略部分候选时长 ' + format(duration) + ' cycle（' + series.count + ' 项 × '
          + format(series.cellDuration) + ' cycle/项）'
          + (series.filledCount ? '；另有 ' + series.filledCount + ' 个已有空白数据格参与补全' : '');
      }
      function applySeriesCandidate({ gap, duration, series, fills }) {
        if (!feasible.ok || boundWork > 2000000 || invalidRows.has(gap.row)) {
          gap.seriesReason += invalidRows.has(gap.row) ? '；本行已有时延冲突，未采用该候选' : '；约束检查超出计算上限，未采用该候选';
          return false;
        }
        resolveRowTimes(rows[gap.row]);
        if (gap.duration !== undefined) {
          if (Math.abs(gap.duration - duration) > Math.max(EPS, tolerance)) {
            const origin = gap.durationSource === 'connection' ? '连接时延' : '已确定的时延';
            gap.seriesReported = true;
            gap.seriesReason += '；与已确定的省略时长 ' + format(gap.duration) + ' cycle 不一致';
            issue('conflict', '第' + (gap.row + 1) + '行第' + gap.col + '列 ' + seriesCandidateText({ gap, duration, series })
              + '，但' + origin + '确定的 | 时长为 ' + format(gap.duration) + ' cycle；保留' + origin + '，未采用数据补全', [gap.row], [], [gap.index]);
          } else {
            gap.series = series; delete gap.seriesReason;
            fills.forEach(({ run, value }) => { run.inferredValue = value; });
          }
          return !!gap.series;
        }
        const a = groups[gap.a], b = groups[gap.b], delta = duration + values[gap.a] + gap.offset - values[gap.b];
        const additions = [{ from: a, to: b, weight: delta, strict: 0 }, { from: b, to: a, weight: -delta, strict: 0 }];
        additions.forEach((bound) => outgoing[bound.from].push(bound));
        const attempt = relaxBounds([a, b], true);
        if (!attempt.ok) {
          additions.forEach((bound) => outgoing[bound.from].pop());
          gap.seriesReported = true;
          gap.seriesReason += attempt.reason === 'limit' ? '；约束检查超出计算上限，未采用该候选' : '；与连接时延或间隔时长要求冲突，未采用该候选';
          issue(attempt.reason === 'limit' ? 'unknown' : 'conflict', '第' + (gap.row + 1) + '行第' + gap.col + '列 '
            + seriesCandidateText({ duration, series }) + '，但与连接时延或间隔时长要求冲突；未采用该推算', [gap.row], [], [gap.index]);
          invalidRows.add(gap.row); return false;
        }
        gap.duration = duration; gap.durationSource = 'data-series'; gap.series = series; delete gap.seriesReason;
        fills.forEach(({ run, value }) => { run.inferredValue = value; });
        seriesLinks[a].push({ to: b, delta, gap }); seriesLinks[b].push({ to: a, delta: -delta, gap });
        positionSeries([a, b]);
        return true;
      }
      const selfPositioned = shifts.map((shift) => shift !== null);
      alignNeighbours();
      auditAlignments(); propagateConflicts();
      const conflictedRegions = rows.map(() => []);
      issues.filter((entry) => entry.kind === 'conflict').forEach((entry) => entry.rows.forEach((id) => {
        conflictedRegions[id].push(...conflictRegions(entry, rows[id]));
      }));
      const seriesConflicts = [];
      function reportSeriesConflict(row, gap) {
        if (gap.series || gap.seriesReported || !gap.seriesReason) return false;
        const alternatives = gap.seriesAlternatives || [];
        const candidates = alternatives.filter((item) => !item.reason && Number.isFinite(item.duration));
        const disagree = candidates.some((item) => Math.abs(item.duration - candidates[0].duration) > Math.max(EPS, tolerance));
        const timingMismatch = Number.isFinite(gap.duration) && candidates.length
          && candidates.every((item) => Math.abs(item.duration - gap.duration) > Math.max(EPS, tolerance));
        if (!disagree && !timingMismatch && !alternatives.some((item) => item.conflict)) return false;
        const references = Array.from(new Set([gap.a, gap.b].map((block) => alignmentSources.get(groups[block]))
          .filter((entry) => entry && ['previous-row', 'next-row'].includes(entry.direction))
          .map((entry) => directionName(entry.direction) + '，第' + (entry.referenceRow + 1) + '行')));
        const origin = gap.durationSource === 'connection' ? '连接时延'
          : references.length ? '相邻行对齐（' + references.join('；') + '）' : '已确定时延';
        const details = alternatives.map((item) => item.label + '：' + (item.reason || '| 省略部分候选时长 '
          + format(item.duration) + ' cycle（' + item.count + ' 项 × ' + format(item.cellDuration) + ' cycle/项）'));
        if (Number.isFinite(gap.duration)) details.unshift(origin + '确定的 | 省略部分时长为 ' + format(gap.duration) + ' cycle');
        gap.seriesSummary = '数据等差约束冲突';
        gap.seriesReported = true;
        seriesConflicts.push(issue('conflict', '第' + (row.index + 1) + '行第' + gap.col + '列数据等差约束冲突：'
          + details.join('；') + '；这些依据不能同时满足，未采用数据补全', [row.index], [], [gap.index]));
        return true;
      }
      let minimum = 0, maximum = 1, longestWaveformEnd = -Infinity;
      rows.forEach((row) => {
        // Refresh every shared component after bidirectional propagation.
        resolveRowTimes(row);
        row.alignments = Array.from(new Set(row.blocks.map((block) => alignmentSources.get(groups[block.id])).filter(Boolean)));
        row.gaps.forEach((id) => {
          const gap = gaps[id];
          const candidate = deferredSeriesCandidates.get(id);
          if (candidate && feasible.ok && !gap.ignored && !gap.series && Number.isFinite(gap.duration)
              && Math.abs(gap.duration - candidate.duration) <= Math.max(EPS, tolerance)
              && !conflictRows.has(gap.row)
              && !conflictedRegions[row.index].some((region) => region.col < (gap.endCol ?? gap.col + 1) && region.end >= gap.col)) {
            gap.series = candidate.series;
            gap.seriesConfirmation = '唯一可行的等差候选与已确定时延一致，已补全；另一侧不满足本段补全条件，不作为本段公差';
            delete gap.seriesReason; delete gap.seriesSummary;
            candidate.fills.forEach(({ run, value }) => { run.inferredValue = value; });
          }
          if (!gap.ignored && reportSeriesConflict(row, gap)) return;
          if (!gap.ignored && gap.duration === undefined && !gap.seriesReported) issue('unknown', spanName(gap) + '时长无法唯一确定' + (gap.seriesReason ? '；' + gap.seriesReason : ''), [row.index], [], [id]);
          else if (!gap.ignored && gap.seriesReason && !gap.seriesReported) {
            issue('unknown', '第' + (row.index + 1) + '行第' + gap.col + '列 ' + gap.seriesContext.before + ' → '
              + gap.seriesContext.after + ' 数据补全失败：' + gap.seriesReason + '；省略时长已确定为 '
              + format(gap.duration) + ' cycle，但数据内容未定', [row.index], [], [id]);
          }
        });
        row.runs.forEach((run) => {
          if (run.start !== null) minimum = Math.min(minimum, run.start);
          if (run.finish !== null) {
            maximum = Math.max(maximum, run.finish);
            longestWaveformEnd = Math.max(longestWaveformEnd, run.finish);
          }
        });
        row.hasUnpositionedContent = row.blocks.some((block) => block.time === null && block.col <= row.checkUntil);
        if (row.hasUnpositionedContent && !row.gaps.some((id) => !gaps[id].ignored && gaps[id].duration === undefined))
          issue('unknown', '相对时延已确定，但缺少与共同起点的时间关系', [row.index]);
        if (!row.empty && row.checkUntil >= 0 && !row.known && !edges.some((edge) => edge.timing.kind === 'delay' && !edge.invalid
            && (edge.fromNode.row === row.index || edge.toNode.row === row.index)))
          issue('unknown', '无非未知波形或有效连接时延，无法判断对齐', [row.index]);
      });
      const seriesConflictRows = seriesConflicts.length ? propagateConflicts(seriesConflicts) : new Set();
      let viewMinimum = minimum, viewMaximum = maximum;
      const globalConversions = [];
      rows.forEach((row) => { row.parameterConversions = []; });
      (parameterConversions || []).forEach((conversion) => {
        const path = conversion.path || [];
        const edge = path[0] === 'edge' && edges[Number(path[1])];
        const affected = Number.isInteger(conversion.row) && rows[conversion.row] ? [conversion.row]
          : edge ? Array.from(new Set([edge.fromNode?.row, edge.toNode?.row].filter((index) => index !== undefined))) : [];
        if (affected.length) affected.forEach((index) => rows[index].parameterConversions.push(conversion));
        else globalConversions.push(conversion);
        const errors = Array.from(new Set(conversion.expressions.filter((entry) => entry.error).map((entry) => entry.error)));
        if (errors.length) issue('unknown', '参数公式转换失败：' + conversion.raw + '；' + errors.join('；'), affected);
      });
      const rowIssues = rows.map(() => []), issueIndices = new Map();
      issues.forEach((entry, index) => {
        issueIndices.set(entry, index);
        entry.rows.forEach((id) => rowIssues[id].push(entry));
      });
      rows.forEach((row) => {
        const required = new Set(row.blocks.filter((block) => block.col <= row.checkUntil && !selfPositioned[groups[block.id]])
          .map((block) => groups[block.id]));
        row.referenceChecks = ['previous-row', 'next-row'].map((direction) => {
          const reference = rows[direction === 'previous-row' ? previousRows[row.index] : nextRows[row.index]];
          const check = { direction, referenceRow: reference?.index, status: 'unavailable' };
          if (!reference) { check.reason = '没有可参考的非空行'; return check; }
          if (!required.size) { check.status = 'not-needed'; check.reason = row.empty ? '空行无需推算' : '本行可凭自身时间关系确定，无需相邻行补充'; return check; }
          if (conflictRows.has(reference.index) || seriesConflictRows.has(reference.index)) { check.reason = '参考行的时延或数据等差约束存在冲突'; return check; }
          if (!reference.supported) { check.reason = '参考行的波形或周期配置不支持推算'; return check; }
          const resolved = new Set(), shiftsByGroup = new Map();
          let circular = false, rejected = false, ambiguous = false;
          alignmentCandidates(row, reference, (group) => required.has(group), (candidate) => {
            if (dependsOn(candidate.referenceGroups, required)) { circular = true; return false; }
            if (rejectedAlignments.has(alignmentKey(row.index, direction, candidate)) || !meetsMinimum(candidate.group, candidate.shift)) { rejected = true; return false; }
            if (shiftsByGroup.has(candidate.group) && Math.abs(shiftsByGroup.get(candidate.group) - candidate.shift) > Math.max(EPS, tolerance)) ambiguous = true;
            shiftsByGroup.set(candidate.group, candidate.shift);
            resolved.add(candidate.group);
            return false;
          });
          // Intrinsic series durations transmit an independent neighbouring anchor.
          const queue = Array.from(resolved);
          for (let head = 0; head < queue.length; head++) for (const link of seriesLinks[queue[head]]) {
            if (required.has(link.to) && !resolved.has(link.to)) { resolved.add(link.to); queue.push(link.to); }
          }
          check.resolved = resolved.size; check.required = required.size;
          check.status = ambiguous ? 'unavailable' : resolved.size === required.size ? 'available' : resolved.size ? 'partial' : 'unavailable';
          check.reason = ambiguous ? '同原列锚点要求不一致，无法唯一确定'
            : check.status === 'available' ? '同原列的已知时刻足以确定本行待定位置'
            : [resolved.size ? '仅能确定部分位置' : '缺少可用的同原列已知时刻',
              reference.sourceLength < row.sourceLength ? '参考行较短，超出部分不能作为依据' : '',
              circular ? '部分参考时刻反向依赖本行，不能作为独立依据' : '',
              rejected ? '候选不能满足本行连接时延或最小时长' : ''].filter(Boolean).join('；');
          check.used = row.alignments.some((entry) => entry.row === row.index && entry.direction === direction);
          return check;
        });
      });
      // Compare the full completion interval using final reference times. These
      // diagnostic estimates never feed back into the solver or its priorities.
      rows.forEach((row) => {
        row.comparisons = [];
        const affected = new Set(rowIssues[row.index].flatMap((entry) => conflictRegions(entry, row))
          .map((range) => range.gap).filter((id) => id !== undefined));
        row.gaps.filter((id) => gaps[id].seriesReason).forEach((id) => affected.add(id));
        if (!affected.size) return;
        const references = ['previous-row', 'next-row'].map((direction) => {
          const reference = rows[direction === 'previous-row' ? previousRows[row.index] : nextRows[row.index]], anchors = new Map();
          alignmentCandidates(row, reference, () => true, (candidate) => {
            const entry = anchors.get(candidate.block);
            if (!entry) anchors.set(candidate.block, { first: candidate, last: candidate, ambiguous: false });
            else {
              if (Math.abs(entry.first.shift - candidate.shift) > Math.max(EPS, tolerance)) entry.ambiguous = true;
              if (candidate.col < entry.first.col) entry.first = candidate;
              if (candidate.col > entry.last.col) entry.last = candidate;
            }
            return false;
          });
          return { direction, reference, anchors };
        });
        for (const id of affected) {
          const gap = gaps[id];
          if (gap.ignored) continue;
          const estimates = [];
          references.forEach(({ direction, reference, anchors }) => {
            if (!reference) return;
            const estimate = { kind: direction, label: directionName(direction) + '（第' + (reference.index + 1) + '行 ' + reference.name + '）' };
            const a = anchors.get(gap.a), b = anchors.get(gap.b), notes = [];
            if (!a && !b) estimate.reason = '没有可用的同原列时刻，无法独立推算本区间列数';
            else if (a?.ambiguous || b?.ambiguous) estimate.reason = '参考行的多个锚点要求不一致，无法唯一推算本区间列数';
            else {
              const start = a ? values[gap.a] + a.last.shift + gap.offset : gap.start;
              const end = b ? values[gap.b] + b.first.shift : gap.end;
              if (start === null || end === null) estimate.reason = '只有一侧边界可确定，无法推算本区间列数';
              else {
                estimate.duration = end - start; estimate.columns = estimate.duration / row.period;
                if (!a) notes.push('保留当前起点 ' + format(start) + ' cycle');
                if (!b) notes.push('保留当前终点 ' + format(end) + ' cycle');
                const points = [a?.last, b?.first].filter(Boolean);
                notes.push('参考原列 ' + points.map((point) => point.col + '（' + format(point.target) + ' cycle）').join('、'));
                if (!validDuration(gap, estimate.duration)) notes.push('不满足本区间最小时长要求');
                if (rowIssues[reference.index].some((entry) => entry.kind === 'conflict')) notes.push('参考行有冲突，仅供定位');
                estimate.note = notes.join('；');
              }
            }
            estimates.push(estimate);
          });
          const alternatives = gap.seriesAlternatives || [];
          if (gap.seriesContext && !alternatives.length)
            estimates.push({ kind: 'series', label: '数据等差序列', reason: gap.seriesReason });
          alternatives.forEach((estimate) => {
            if (!estimates.some((entry) => entry.kind === 'series' && entry.duration === estimate.duration && entry.reason === estimate.reason))
              estimates.push(Object.assign({}, estimate, { note: gap.seriesReason ? '候选推算，未采用' : '' }));
          });
          if (gap.duration !== undefined && (gap.durationSource === 'connection'
              || !estimates.some((entry) => Number.isFinite(entry.duration) && nearNumber(entry.duration, gap.duration))))
            estimates.unshift({ kind: 'current', label: gap.durationSource === 'connection' ? '连接时延' : '当前已确定时长', duration: gap.duration, columns: gap.duration / row.period });
          const blankColumns = gap.seriesContext?.blankColumns || 0;
          estimates.filter((entry) => Number.isFinite(entry.duration)).forEach((entry) => {
            entry.columns += blankColumns;
            entry.duration += blankColumns * row.period;
          });
          const differences = [];
          const timings = estimates.filter((entry) => entry.kind !== 'series' && Number.isFinite(entry.duration));
          const series = estimates.filter((entry) => entry.kind === 'series' && Number.isFinite(entry.duration));
          const pairs = series.length ? timings.flatMap((timing) => series.map((data) => [timing, data]))
            .concat(series.slice(1).map((entry) => [series[0], entry]))
            : timings.slice(1).map((entry) => [timings[0], entry]);
          pairs.forEach(([a, b]) => {
            const duration = Math.abs(a.duration - b.duration);
            if (duration > Math.max(EPS, tolerance)) differences.push({ a: a.label, b: b.label, duration, columns: duration / row.period });
          });
          row.comparisons.push({ gap: id, col: gap.col, endCol: gap.endCol, period: row.period,
            blankCount: gap.seriesContext?.blankCount || 0, blankColumns, estimates, differences });
        }
        row.comparisons.sort((a, b) => a.col - b.col);
      });
      rows.forEach((row) => {
        row.reasons = rowIssues[row.index].map((item) => item.reason);
        row.status = rowIssues[row.index].some((item) => item.kind === 'conflict') ? 'conflict' : row.reasons.length ? 'unknown' : 'ok';
        row.drawRuns = [];
        const sorted = row.runs.filter((run) => run.start !== null && run.finish !== null && run.finish > run.start).sort((p, q) => p.start - q.start);
        sorted.forEach((original) => {
          const run = Object.assign({}, original);
          if (run.inferredValue !== undefined) run.value = run.inferredValue;
          if (run.gap && gaps[run.gap - 1].series) run.series = gaps[run.gap - 1].series;
          if (!run.series && run.gap && gaps[run.gap - 1].kind !== 'stretch' && config.gapContent === 'unknown' || /[pPnN]/.test(run.state) && run.clockOrigin === null) { run.state = 'x'; run.value = 'x'; run.slot = -1; }
          if (run.seriesGap && !gaps[run.seriesGap - 1].series) {
            run.unresolvedData = true; run.state = 'bus'; run.value = '?';
          }
          const previous = row.drawRuns[row.drawRuns.length - 1];
          if (previous && !previous.series && !run.series && Math.abs(previous.finish - run.start) < EPS && previous.state === run.state && previous.symbol === run.symbol && previous.value === run.value && previous.slot === run.slot
              && previous.unresolvedData === run.unresolvedData
              && (!/[pPnN]/.test(run.state) || previous.clockOrigin === run.clockOrigin)) previous.finish = run.finish;
          else row.drawRuns.push(run);
        });
        // Unknown tails are display padding only: never feed their common end
        // back into alignment, constraints, reference anchors or the source JSON.
        if (row.sourceLength && !row.empty && row.unknownTailStart !== undefined) {
          const tail = row.runs.find((run) => run.col <= row.unknownTailStart && run.end > row.unknownTailStart);
          const point = tail && alignmentPoint(row, tail, row.unknownTailStart);
          const start = tail && tail.col === row.unknownTailStart ? tail.start : point ? time(point.block, point.offset) : null;
          if (start !== null && start < longestWaveformEnd) {
            row.drawRuns = row.drawRuns.filter((run) => run.start < start);
            row.drawRuns.forEach((run) => { run.finish = Math.min(run.finish, start); });
            row.drawRuns.push({ col: row.unknownTailStart, end: row.sourceLength, start, finish: longestWaveformEnd,
              state: 'x', symbol: 'x', value: 'x', slot: -1, gap: 0, clockOrigin: null });
            row.unknownTailDisplay = { start, finish: longestWaveformEnd };
          }
        }
        let maxEnd = -Infinity;
        row.drawEnds = row.drawRuns.map((run) => (maxEnd = Math.max(maxEnd, run.finish)));
        // Only this display map uses provisional gap spacing; solved times remain untouched.
        row.referenceRuns = [];
        if (row.sourceLength) {
          let anchored = row.supported;
          let referenceTimes = row.blocks.map((block) => block.time);
          referenceTimes[0] = referenceTimes[0] === null ? -row.phase : referenceTimes[0];
          for (let left = 0; anchored && left < row.gaps.length;) {
            let right = left + 1;
            while (right < row.blocks.length && row.blocks[right].time === null) right++;
            const hasAnchor = right < row.blocks.length, last = hasAnchor ? right : row.gaps.length;
            let fixed = 0, unknown = 0, reserved = 0;
            for (let j = left; j < last; j++) {
              const block = row.blocks[j], gap = gaps[row.gaps[j]];
              fixed += (block.end - block.col) * row.period;
              if (gap.duration > 0) fixed += gap.duration;
              else { unknown++; reserved += gap.kind === 'stretch' ? (gap.endCol - gap.col) * row.period : row.period; }
            }
            const remaining = hasAnchor ? row.blocks[right].time - referenceTimes[left] - fixed : null;
            if (hasAnchor && unknown && !(remaining > 0)) { anchored = false; break; }
            const placeholderScale = hasAnchor && unknown ? remaining / reserved : 1;
            for (let j = left; j < last; j++) {
              const block = row.blocks[j], gap = gaps[row.gaps[j]];
              referenceTimes[j + 1] = referenceTimes[j] + (block.end - block.col) * row.period
                + (gap.duration > 0 ? gap.duration : (gap.kind === 'stretch' ? (gap.endCol - gap.col) * row.period : row.period) * placeholderScale);
            }
            if (hasAnchor) referenceTimes[right] = row.blocks[right].time;
            left = last;
          }
          if (!anchored) referenceTimes = row.blocks.map((block) => -row.phase + block.col * row.period);
          const referenceBlocks = new Map(row.blocks.map((block, index) => [block.id, referenceTimes[index]]));
          row.runs.forEach((run) => {
            if (run.col >= row.sourceLength) return;
            const end = Math.min(run.end, row.sourceLength), start = referenceBlocks.get(run.block) + run.offset;
            const finish = run.gap ? referenceBlocks.get(gaps[run.gap - 1].b) : start + (end - run.col) * row.period;
            const provisional = !anchored || run.start === null || run.finish === null
              || /[pPnN]/.test(run.state) && run.clockOrigin === null;
            const reference = { col: run.col, end, start, finish, state: run.state, symbol: run.symbol, provisional,
              mapped: !!run.gap && gaps[run.gap - 1].kind === 'stretch',
              value: run.value, slot: run.slot, gap: run.gap,
              stretch: !!run.gap && gaps[run.gap - 1].kind === 'stretch',
              clockOrigin: run.clockBlock === null ? null : referenceBlocks.get(run.clockBlock) + run.clockOffset };
            const omissions = reference.stretch ? gaps[run.gap - 1].omissions : [];
            if (omissions.length) {
              let col = run.col;
              const addReference = (from, to, omission) => {
                if (to <= from) return;
                row.referenceRuns.push(Object.assign({}, reference, { col: from, end: to, omission, mapped: true,
                  start: start + (from - run.col) * (finish - start) / (end - run.col),
                  finish: start + (to - run.col) * (finish - start) / (end - run.col) }));
              };
              omissions.forEach((position) => { addReference(col, position, false); addReference(position, position + 1, true); col = position + 1; });
              addReference(col, end, false);
            } else row.referenceRuns.push(reference);
            viewMinimum = Math.min(viewMinimum, start); viewMaximum = Math.max(viewMaximum, finish);
          });
        }
        row.referenceEnds = row.referenceRuns.map((run) => run.finish);
        // Keep conflict geometry in original columns, then map only those spans
        // to time. Other gaps and waveform sections retain their normal rendering.
        const ranges = rowIssues[row.index].filter((entry) => entry.kind === 'conflict')
          .flatMap((entry) => conflictRegions(entry, row).map(({ col, end, gap }) => {
            if (gap !== undefined) gaps[gap].conflict = true;
            return { col, end, issueIds: [issueIndices.get(entry)] };
          }));
        const merged = [];
        ranges.sort((a, b) => a.col - b.col || a.end - b.end).forEach((range) => {
          const last = merged[merged.length - 1];
          if (last && range.col <= last.end) {
            last.end = Math.max(last.end, range.end);
            range.issueIds.forEach((id) => { if (!last.issueIds.includes(id)) last.issueIds.push(id); });
          }
          else merged.push(range);
        });
        let conflictIndex = 0;
        row.gaps.forEach((id) => {
          const gap = gaps[id];
          while (conflictIndex < merged.length && merged[conflictIndex].end <= gap.col) conflictIndex++;
          const range = merged[conflictIndex];
          if (!gap.ignored && range && range.col < (gap.endCol ?? gap.col + 1) && range.end > gap.col) gap.conflict = true;
        });
        function columnTime(col, reference) {
          const runs = reference ? row.referenceRuns : row.runs;
          if (!runs.length) return reference ? -row.phase + col * row.period : time(row.blocks[0].id, col * row.period);
          let lo = 0, hi = runs.length;
          while (lo < hi) { const mid = (lo + hi) >> 1; if (runs[mid].end <= col) lo = mid + 1; else hi = mid; }
          const run = runs[lo];
          if (!run) return lo && col === runs[lo - 1].end ? runs[lo - 1].finish : null;
          if (col < run.col || run.start === null) return null;
          if (col === run.col) return run.start;
          const offset = reference ? (col - run.col) * (run.finish - run.start) / (run.end - run.col) : displayColumnOffset(row, run, col);
          return offset === null ? null : run.start + offset;
        }
        row.gaps.forEach((id) => {
          const gap = gaps[id];
          if (!gap.series || !gap.seriesContext) return;
          const { col, end } = gap.seriesContext;
          gap.completionRange = { col, end, start: columnTime(col, false), finish: columnTime(end, false) };
        });
        row.conflictRanges = merged.map((range) => {
          const start = columnTime(range.col, false), finish = columnTime(range.end, false);
          return Object.assign(range, { start, finish, referenceStart: columnTime(range.col, true), referenceFinish: columnTime(range.end, true) });
        });
        row.dataUnknownRanges = row.gaps.map((id) => gaps[id]).filter((gap) => gap.seriesContext && !gap.series && !gap.conflict).map((gap) => {
          const { col, end } = gap.seriesContext;
          return { col, end, start: columnTime(col, false), finish: columnTime(end, false),
            referenceStart: columnTime(col, true), referenceFinish: columnTime(end, true) };
        });
        const problems = row.conflictRanges.concat(row.dataUnknownRanges).sort((a, b) => a.col - b.col || a.end - b.end);
        let problemNumber = 0, problemStart = -Infinity, problemEnd = -Infinity;
        problems.forEach((range) => {
          if (range.col >= problemEnd && range.col !== problemStart) {
            problemNumber++; problemStart = range.col; problemEnd = range.end;
          } else problemEnd = Math.max(problemEnd, range.end);
          range.number = problemNumber;
        });
        row.comparisons.forEach((comparison) => {
          const end = comparison.endCol ?? comparison.col + 1;
          comparison.problemNumbers = Array.from(new Set(problems.filter((range) => range.col < end && range.end >= comparison.col).map((range) => range.number)));
        });
        delete row.runs;
      });
      edges.forEach((edge) => {
        edge.start = edge.fromNode && !edge.invalid ? time(edge.fromNode.block, edge.fromNode.offset) : null;
        edge.end = edge.toNode && !edge.invalid ? time(edge.toNode.block, edge.toNode.offset) : null;
        edge.actual = edge.start !== null && edge.end !== null ? edge.end - edge.start : null;
        edge.status = issues.some((item) => item.kind === 'conflict' && item.edges.includes(edge.index)) ? 'conflict'
          : edge.invalid || edge.timing.kind === 'unknown' || edge.start === null || edge.end === null ? 'unknown' : 'ok';
      });
      return { rows, gaps, edges, issues, minimum, maximum, viewMinimum, viewMaximum, tolerance, config, parameterConversions: globalConversions };
    }
    return { analyze, parseDelay, edgeParts, format, seriesLabel };
  }
  global.createVisualWaveDromTimingEngine = createTimingEngine;
  global.VisualWaveDromTimingCore = createTimingEngine();
  if (typeof module !== 'undefined') module.exports = global.VisualWaveDromTimingCore;
})(typeof window !== 'undefined' ? window : globalThis);

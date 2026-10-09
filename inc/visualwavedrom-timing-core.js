/* Fixed waveform sections are graph vertices; no expanded waveform strings are allocated. */
(function (global) {
  'use strict';
  function createTimingEngine() {
    const EPS = 1e-9;
    const numberPattern = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?';
    const units = 'cycle[s]?|周期|s|ms|us|µs|μs|ns|ps';
    function parseDelay(label, cycleTimeNs) {
      const raw = String(label || '').trim().replace(/^:\s*/, '');
      if (!raw) return { kind: 'ignored', reason: '无时延标签' };
      if (/[{}$]/.test(raw)) return { kind: 'unknown', reason: '时延参数未解析，请检查链接参数表' };
      if (/[<>≤≥≠]/.test(raw) || raw.includes('!=')) return { kind: 'unknown', reason: '仅支持确定时延，不支持时延不等式' };
      const parts = raw.split(/[=＝]/);
      if (parts.length > 2) return { kind: 'unknown', reason: '标签中有多个等号，无法确定时延' };
      const text = parts.length === 2 ? parts[1].trim() : raw;
      const match = text.match(new RegExp('^(' + numberPattern + ')\\s*(' + units + ')?$', 'i'))
        || (parts.length === 1 && text.match(new RegExp('^[^\\d+\\-]*?(' + numberPattern + ')\\s*(' + units + ')$', 'i')));
      if (!match) return { kind: /[\d=＝]/.test(raw) ? 'unknown' : 'ignored', reason: '标签没有唯一、明确的时延数值' };
      let value = Number(match[1]);
      const unit = (match[2] || 'cycle').toLowerCase();
      if (!['cycle', 'cycles', '周期'].includes(unit)) {
        if (!(Number(cycleTimeNs) > 0) || !Number.isFinite(Number(cycleTimeNs)))
          return { kind: 'unknown', reason: '请先配置每 cycle 的时长（ns）' };
        const scale = { s: 1e9, ms: 1e6, us: 1e3, 'µs': 1e3, 'μs': 1e3, ns: 1, ps: 1e-3 };
        value *= scale[unit] / Number(cycleTimeNs);
      }
      return Number.isFinite(value) ? { kind: 'delay', value } : { kind: 'unknown', reason: '时延数值超出范围' };
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
    function analyze(source) {
      if (!source || !Array.isArray(source.signal)) throw new Error('signal 必须是波形数组');
      const config = source.timingCheck || {};
      const tolerance = Number.isFinite(Number(config.tolerance)) && Number(config.tolerance) >= 0 ? Number(config.tolerance) : 1e-7;
      const rows = [], gaps = [], nodes = new Map(), duplicates = new Set(), graph = [[]], constraints = [], issues = [], edges = [];
      const sourceEdges = Array.isArray(source.edge) ? source.edge : [];
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
      function issue(kind, reason, rowIds, edgeIds, gapIds) {
        const entry = { kind, reason, rows: Array.from(new Set(rowIds || [])), edges: Array.from(new Set(edgeIds || [])), gaps: gapIds || [] };
        issues.push(entry); return entry;
      }
      const signals = flatten(source.signal, []), stretches = new Map();
      function buildRows() { signals.forEach((signal, index) => {
        const wave = String(signal.wave || ''), node = String(signal.node || '');
        let lastNode = node.length - 1;
        while (lastNode >= 0 && !/[a-zA-Z0-9]/.test(node[lastNode])) lastNode--;
        let lastWave = wave.length - 1, lastReferencedNode = lastNode;
        while (lastWave >= 0 && /[|\s]/.test(wave[lastWave])) lastWave--;
        while (lastReferencedNode >= 0 && !referencedNodes.has(node[lastReferencedNode])) lastReferencedNode--;
        const length = Math.max(wave.length, lastNode);
        const period = signal.period === undefined ? 1 : Number(signal.period);
        const phase = signal.phase === undefined ? 0 : Number(signal.phase);
        const row = { index, name: String(signal.name || '(空行)'), length, sourceLength: wave.length, period, phase, blocks: [], runs: [], gaps: [],
          empty: lastWave < 0, checkUntil: Math.max(lastWave, lastReferencedNode), known: false, supported: true, status: 'ok', reasons: [] };
        rows.push(row);
        if (!(period > 0) || !Number.isFinite(period * length) || !Number.isFinite(phase)) {
          issue('unknown', 'period 必须为正有限数值，phase 必须为有限数值', [index]); row.supported = false;
          row.period = 1; row.phase = 0;
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
          if (id && /[a-zA-Z0-9]/.test(id)) {
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
              minimum: (stretchEnd - col - omissions.length) * row.period, omissions, ignored: false };
            gaps.push(gap); row.gaps.push(gap.index); addRun(col, stretchEnd, gap.index + 1);
            for (let j = col + 1; j < stretchEnd; j++) consume(wave[j], j, true);
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
      // Equal-valued intervals can become elastic; omissions within unknown state
      // can share one unknown span. Keep every endpoint as a solver boundary.
      const uniformRows = new Map(), ranges = new Map();
      sourceEdges.forEach((raw) => {
        const parsed = edgeParts(raw), from = nodes.get(parsed.from), to = nodes.get(parsed.to);
        const timing = parseDelay(parsed.label, config.cycleTimeNs);
        if (!from || !to || from.row !== to.row || from.col === to.col || duplicates.has(parsed.from) || duplicates.has(parsed.to)
            || timing.kind !== 'delay') return;
        const row = rows[from.row], left = Math.min(from.col, to.col), right = Math.max(from.col, to.col);
        if (!row.supported || right > row.sourceLength) return;
        if (!uniformRows.has(row.index)) {
          const spans = [];
          row.runs.forEach((run) => {
            const unknownOmission = run.gap && run.state.toLowerCase() === 'x';
            const previous = spans[spans.length - 1];
            if ((!run.gap || unknownOmission) && previous && !previous.gap && previous.end === run.col
                && previous.symbol === run.symbol && previous.value === run.value) previous.end = run.end;
            else spans.push(Object.assign({}, run, unknownOmission ? { gap: 0 } : {}));
          });
          uniformRows.set(row.index, spans);
        }
        const spans = uniformRows.get(row.index);
        let lo = 0, hi = spans.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (spans[mid].end <= left) lo = mid + 1; else hi = mid; }
        const span = spans[lo];
        if (!span || span.gap || span.col > left || span.end < right) return;
        const omission = String(signals[row.index].wave || '').indexOf('|', left);
        const unknownOmission = span.state.toLowerCase() === 'x' && omission >= left && omission < right;
        if (!unknownOmission && timing.value * Math.sign(to.col - from.col) <= (right - left) * row.period + Math.max(EPS, tolerance)) return;
        if (!ranges.has(row.index)) ranges.set(row.index, []);
        ranges.get(row.index).push({ left, right });
      });
      const rowNodes = signals.map((signal) => Array.from(String(signal.node || '').matchAll(/[a-zA-Z0-9]/g), (match) => match.index));
      ranges.forEach((intervals, row) => {
        intervals.sort((a, b) => a.left - b.left || a.right - b.right);
        const merged = [];
        intervals.forEach((interval) => {
          const last = merged[merged.length - 1];
          if (last && interval.left <= last.right) last.right = Math.max(last.right, interval.right);
          else merged.push(Object.assign({}, interval));
        });
        const cuts = rowNodes[row].sort((a, b) => a - b), ends = new Map();
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
        stretches.set(row, ends);
      });
      if (stretches.size) {
        rows.length = gaps.length = constraints.length = issues.length = 0;
        graph.length = 1; graph[0] = []; nodes.clear(); duplicates.clear();
        buildRows();
      }
      const spanName = (gap) => '第' + gap.col + '列' + (gap.kind === 'stretch' ? '至' + gap.endCol + '列' + (gap.omissions.length ? '未知与省略区域' : '同值区域') : ' |');
      const minimumDuration = (gap) => gap.kind === 'stretch' ? gap.minimum : 0;
      const strictDuration = (gap) => gap.kind !== 'stretch' || gap.omissions.length > 0;
      const validDuration = (gap, duration) => strictDuration(gap) ? duration > minimumDuration(gap) : duration >= gap.minimum - Math.max(EPS, tolerance);
      sourceEdges.forEach((raw, index) => {
        const parsed = edgeParts(raw), from = nodes.get(parsed.from), to = nodes.get(parsed.to);
        const timing = parseDelay(parsed.label, config.cycleTimeNs);
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
                ? '必须大于固定未知波形的 ' + format(gap.minimum) + ' cycle，省略间隔须有正时长'
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
      const feasible = relaxBounds(components.map((_, index) => index), false);
      if (!feasible.ok) {
        if (feasible.reason === 'limit') issue('unknown', '间隔约束过多，正时长检查未完成', gaps.map((gap) => gap.row));
        else {
          const cycle = feasible.cycle;
          const related = cycle.flatMap((gap, index) => pathIds(gap.b, cycle[(index + 1) % cycle.length].a).map((id) => constraints[id]));
          issue('conflict', '这些区间无法同时满足时长要求（| 必须为正，同值区域不能短于原时长），请检查连接标签', cycle.map((gap) => gap.row).concat(related.flatMap((item) => item.rows)),
            related.map((item) => item.edge).filter((id) => id !== undefined), cycle.map((gap) => gap.index));
        }
      }
      const shifts = new Array(components.length).fill(null), alignmentSources = new Map();
      shifts[0] = 0;
      function time(block, offset) {
        const shift = shifts[groups[block]], result = values[block] + (offset || 0) + shift;
        return shift !== null && Number.isFinite(result) ? result : null;
      }
      const conflictRows = new Set(issues.filter((entry) => entry.kind === 'conflict').flatMap((entry) => entry.rows));
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
          if (!gap.ignored && gap.durationSource !== 'connection' && gap.start !== null && gap.end !== null && gap.end > gap.start) {
            gap.duration = gap.end - gap.start;
            const sources = [gap.a, gap.b].map((block) => alignmentSources.get(groups[block])).filter(Boolean);
            const directions = new Set(sources.map((entry) => entry.direction));
            gap.durationSource = directions.size > 1 ? 'adjacent-rows' : sources.length ? sources[0].direction : undefined;
          }
        });
        row.runs.forEach((run) => {
          run.start = time(run.block, run.offset);
          run.finish = run.gap ? gaps[run.gap - 1].end : run.start === null ? null : run.start + (run.end - run.col) * row.period;
          run.clockOrigin = run.clockBlock === null ? null : time(run.clockBlock, run.clockOffset);
        });
      }
      // Use the same source-column mapping as the expanded reference strip, never
      // provisional display positions. Ordinary omissions are not alignment anchors.
      function columnOffset(row, run, col) {
        if (!run.gap) return (col - run.col) * row.period;
        const gap = gaps[run.gap - 1];
        if (gap.kind !== 'stretch') return null;
        if (col === run.col) return 0;
        const start = time(gap.a, gap.offset), end = time(gap.b);
        return start !== null && end !== null && end > start ? (col - run.col) * (end - start) / (run.end - run.col) : null;
      }
      const directionName = (direction) => direction === 'previous-row' ? '上一行' : '下一行';
      function alignmentCandidates(row, reference, eligible, visit, checkEnds) {
        if (!reference || !row.supported || !reference.supported || conflictRows.has(row.index) || conflictRows.has(reference.index)) return;
        let referenceIndex = 0;
        for (const run of row.runs) {
          const group = groups[run.block];
          if (!eligible(group) || run.gap && gaps[run.gap - 1].kind !== 'stretch' || run.state.toLowerCase() === 'x'
              || run.col >= row.sourceLength || run.col > row.checkUntil) continue;
          while (referenceIndex < reference.runs.length && reference.runs[referenceIndex].end <= run.col) referenceIndex++;
          for (let j = referenceIndex; j < reference.runs.length && reference.runs[j].col < run.end; j++) {
            const anchor = reference.runs[j], first = Math.max(run.col, anchor.col);
            const last = Math.min(run.end, anchor.end, row.sourceLength, reference.sourceLength, row.checkUntil + 1, reference.checkUntil + 1) - 1;
            if (anchor.state.toLowerCase() === 'x' || last < first) continue;
            const anchorStart = time(anchor.block, anchor.offset);
            if (anchorStart === null) continue;
            // Both mappings are affine within a run; checking the ends covers long continuations.
            let stop = false;
            for (const col of checkEnds && last > first ? [first, last] : [first]) {
              const anchorOffset = columnOffset(reference, anchor, col), offset = columnOffset(row, run, col);
              if (anchorOffset === null || offset === null) continue;
              const target = anchorStart + anchorOffset;
              const shift = target - values[run.block] - run.offset - offset;
              if (!Number.isFinite(shift)) continue;
              stop = visit({ group, col, target, shift, referenceExpanded: !!anchor.gap && gaps[anchor.gap - 1].kind === 'stretch' });
              if (stop) break;
            }
            if (stop) break;
          }
        }
      }
      const componentRows = components.map(() => new Set());
      rows.forEach((row) => row.blocks.forEach((block) => componentRows[groups[block.id]].add(row.index)));
      const aboveQueue = [], belowQueue = [], abovePending = new Set(), belowPending = new Set();
      let aboveHead = 0, belowHead = 0;
      function enqueue(index, below) {
        if (index < 0 || index >= rows.length) return;
        const pending = below ? belowPending : abovePending;
        if (pending.has(index)) return;
        pending.add(index); (below ? belowQueue : aboveQueue).push(index);
      }
      // Drain upper-row work first. Only newly positioned components wake their own
      // rows and neighbours, including rows sharing a cross-row connection.
      rows.forEach((row, index) => {
        enqueue(index, false); enqueue(rows.length - index - 1, true);
      });
      while (feasible.ok && (aboveHead < aboveQueue.length || belowHead < belowQueue.length) && boundWork <= 2000000) {
        const below = aboveHead >= aboveQueue.length;
        const index = below ? belowQueue[belowHead++] : aboveQueue[aboveHead++];
        (below ? belowPending : abovePending).delete(index);
        const row = rows[index], reference = rows[index + (below ? 1 : -1)];
        const direction = below ? 'next-row' : 'previous-row';
        alignmentCandidates(row, reference, (group) => shifts[group] === null && !blockedGroups.has(group), (candidate) => {
          const { group, col, target, shift, referenceExpanded } = candidate;
          const attempt = alignGroup(group, shift);
          if (attempt.ok) {
            alignmentSources.set(group, { row: index, referenceRow: reference.index, direction, col, time: target, referenceExpanded });
            componentRows[group].forEach((id) => {
              for (const neighbour of [id - 1, id, id + 1]) { enqueue(neighbour, false); enqueue(neighbour, true); }
            });
          } else {
            blockedGroups.add(group);
            issue(attempt.reason === 'limit' ? 'unknown' : 'conflict', attempt.reason === 'limit'
              ? '相邻行对齐检查超出计算上限，保留未定位置'
              : '第' + (index + 1) + '行原列' + col + '按' + directionName(direction) + '（第' + (reference.index + 1)
                + '行）对齐至 ' + format(target) + ' cycle 会违反连接时延或间隔时长要求；未采用该推算',
            [index, reference.index], [], row.gaps.filter((id) => !gaps[id].ignored));
          }
          return true;
        });
      }
      // Known connection times are authoritative. Audit only inferred positions,
      // so disagreement is reported instead of silently replacing an upper anchor.
      const auditedConflicts = new Set();
      rows.forEach((row) => {
        for (const direction of ['previous-row', 'next-row']) {
          const reference = rows[row.index + (direction === 'previous-row' ? -1 : 1)];
          alignmentCandidates(row, reference, (group) => alignmentSources.has(group), ({ group, col, target, shift }) => {
            const key = group + ':' + row.index + ':' + direction;
            if (Math.abs(shift - shifts[group]) <= Math.max(EPS, tolerance) || auditedConflicts.has(key)) return false;
            auditedConflicts.add(key);
            const chosen = alignmentSources.get(group), actual = target + shifts[group] - shift;
            issue('conflict', '第' + (row.index + 1) + '行原列' + col + '对齐冲突：按'
              + directionName(chosen.direction) + '（第' + (chosen.referenceRow + 1) + '行）推算为 ' + format(actual)
              + ' cycle，但' + directionName(direction) + '（第' + (reference.index + 1) + '行）同原列为 '
              + format(target) + ' cycle，相差 ' + format(Math.abs(actual - target)) + ' cycle；未覆盖已采用的时刻，冲突结果仅供定位',
            [row.index, chosen.row, chosen.referenceRow, reference.index], [], row.gaps.filter((id) => !gaps[id].ignored));
            return true;
          }, true);
        }
      });
      const consumers = rows.map(() => new Set());
      alignmentSources.forEach((entry, group) => componentRows[group].forEach((id) => consumers[entry.referenceRow].add(id)));
      const invalidRows = new Set(issues.filter((entry) => entry.kind === 'conflict').flatMap((entry) => entry.rows));
      const invalidQueue = Array.from(invalidRows);
      for (let head = 0; head < invalidQueue.length; head++) consumers[invalidQueue[head]].forEach((id) => {
        if (invalidRows.has(id)) return;
        invalidRows.add(id); invalidQueue.push(id);
        issue('conflict', '本行对齐所依据的第' + (invalidQueue[head] + 1) + '行存在时延冲突，推算结果仅供定位', [id]);
      });
      let minimum = 0, maximum = 1;
      rows.forEach((row) => {
        // Refresh every shared component after bidirectional propagation.
        resolveRowTimes(row);
        row.alignments = Array.from(new Set(row.blocks.map((block) => alignmentSources.get(groups[block.id])).filter(Boolean)));
        row.gaps.forEach((id) => {
          const gap = gaps[id];
          if (!gap.ignored && gap.duration === undefined) issue('unknown', spanName(gap) + '时长无法唯一确定', [row.index], [], [id]);
        });
        row.runs.forEach((run) => {
          if (run.start !== null) minimum = Math.min(minimum, run.start);
          if (run.finish !== null) maximum = Math.max(maximum, run.finish);
        });
        row.hasUnpositionedContent = row.blocks.some((block) => block.time === null && block.col <= row.checkUntil);
        if (row.hasUnpositionedContent && !row.gaps.some((id) => !gaps[id].ignored && gaps[id].duration === undefined))
          issue('unknown', '相对时延已确定，但缺少与共同起点的时间关系', [row.index]);
        if (!row.empty && !row.known && !edges.some((edge) => edge.timing.kind === 'delay' && !edge.invalid
            && (edge.fromNode.row === row.index || edge.toNode.row === row.index)))
          issue('unknown', '无非未知波形或有效连接时延，无法判断对齐', [row.index]);
      });
      let viewMinimum = minimum, viewMaximum = maximum;
      const rowIssues = rows.map(() => []);
      issues.forEach((entry) => entry.rows.forEach((id) => rowIssues[id].push(entry)));
      rows.forEach((row) => {
        row.reasons = rowIssues[row.index].map((item) => item.reason);
        row.status = rowIssues[row.index].some((item) => item.kind === 'conflict') ? 'conflict' : row.reasons.length ? 'unknown' : 'ok';
        row.drawRuns = [];
        const sorted = row.runs.filter((run) => run.start !== null && run.finish !== null && run.finish > run.start).sort((p, q) => p.start - q.start);
        sorted.forEach((original) => {
          const run = Object.assign({}, original);
          if (run.gap && gaps[run.gap - 1].kind !== 'stretch' && config.gapContent === 'unknown' || /[pPnN]/.test(run.state) && run.clockOrigin === null) { run.state = 'x'; run.value = 'x'; run.slot = -1; }
          const previous = row.drawRuns[row.drawRuns.length - 1];
          if (previous && Math.abs(previous.finish - run.start) < EPS && previous.state === run.state && previous.value === run.value && previous.slot === run.slot
              && (!/[pPnN]/.test(run.state) || previous.clockOrigin === run.clockOrigin)) previous.finish = run.finish;
          else row.drawRuns.push(run);
        });
        let maxEnd = -Infinity;
        row.drawEnds = row.drawRuns.map((run) => (maxEnd = Math.max(maxEnd, run.finish)));
        // Only this display map uses provisional gap spacing; solved times remain untouched.
        row.referenceRuns = [];
        if (row.sourceLength) {
          let anchored = row.status !== 'conflict' && row.supported;
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
            const reference = { col: run.col, end, start, finish, state: run.state, provisional,
              value: run.value, slot: run.slot, gap: run.gap,
              stretch: !!run.gap && gaps[run.gap - 1].kind === 'stretch',
              clockOrigin: run.clockBlock === null ? null : referenceBlocks.get(run.clockBlock) + run.clockOffset };
            const omissions = reference.stretch ? gaps[run.gap - 1].omissions : [];
            if (omissions.length) {
              let col = run.col;
              const addReference = (from, to, omission) => {
                if (to <= from) return;
                row.referenceRuns.push(Object.assign({}, reference, { col: from, end: to, omission, provisional: true,
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
        delete row.runs;
      });
      edges.forEach((edge) => {
        edge.start = edge.fromNode && !edge.invalid ? time(edge.fromNode.block, edge.fromNode.offset) : null;
        edge.end = edge.toNode && !edge.invalid ? time(edge.toNode.block, edge.toNode.offset) : null;
        edge.actual = edge.start !== null && edge.end !== null ? edge.end - edge.start : null;
        edge.status = issues.some((item) => item.kind === 'conflict' && item.edges.includes(edge.index)) ? 'conflict'
          : edge.invalid || edge.timing.kind === 'unknown' || edge.start === null || edge.end === null ? 'unknown' : 'ok';
      });
      return { rows, gaps, edges, issues, minimum, maximum, viewMinimum, viewMaximum, tolerance, config };
    }
    return { analyze, parseDelay, edgeParts, format };
  }
  global.createVisualWaveDromTimingEngine = createTimingEngine;
  global.VisualWaveDromTimingCore = createTimingEngine();
  if (typeof module !== 'undefined') module.exports = global.VisualWaveDromTimingCore;
})(typeof window !== 'undefined' ? window : globalThis);

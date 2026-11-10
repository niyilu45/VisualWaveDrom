(function (global) {
  'use strict';

  function namesFor(rows) {
    const reserved = new Set(rows.map((row) => String(row.name || '')));
    const used = new Set();
    return rows.map((row) => {
      const base = String(row.name || '');
      let name = base;
      let suffix = 1;
      while (used.has(name)) {
        name = base + '_' + suffix++;
        if (reserved.has(name)) continue;
        break;
      }
      // Keep explicitly named signals (e.g. sig_1) distinct from generated names.
      while (used.has(name) || (name !== base && reserved.has(name))) name = base + '_' + suffix++;
      used.add(name);
      return name;
    });
  }

  function valueKey(value) {
    if (value == null || (typeof value === 'number' && !Number.isFinite(value))) return 'x';
    if (typeof value === 'object') {
      if (value.unknown === true) return 'x';
      if (Array.isArray(value)) return JSON.stringify(value.map(valueKey));
      if ('re' in value || 'im' in value) return 'complex:' + valueKey(value.re || 0) + ':' + valueKey(value.im || 0);
      return JSON.stringify(value);
    }
    const text = String(value).trim();
    if (/^x$/i.test(text)) return 'x';
    if (/^[+-]?\d+$/.test(text)) {
      try { return 'n:' + BigInt(text).toString(); } catch (_error) { /* numeric fallback */ }
    }
    if (text && Number.isFinite(Number(text))) return 'n:' + Number(text);
    return 's:' + text;
  }

  function equalValues(a, b) {
    if (a === b) return true;
    if (typeof a === 'number' && typeof b === 'number') {
      return !Number.isFinite(a) && !Number.isFinite(b);
    }
    return valueKey(a) === valueKey(b);
  }

  async function compare(left, right, api) {
    const rows = (session) => session.rows.map((row, index) => ({ row, index }))
      .filter(({ row }) => !(row.arrayGroup?.index < 0));
    const leftRows = rows(left);
    const rightRows = rows(right);
    const leftNames = namesFor(leftRows.map(({ row }) => row));
    const rightNames = namesFor(rightRows.map(({ row }) => row));
    const rightMap = new Map(rightNames.map((name, index) => [name, rightRows[index].index]));
    const pairs = leftNames.map((name, index) => ({ name, left: leftRows[index].index, right: rightMap.get(name) ?? -1 }));
    const leftSet = new Set(leftNames);
    rightNames.forEach((name, index) => { if (!leftSet.has(name)) pairs.push({ name, left: -1, right: rightRows[index].index }); });
    const errors = [];
    const total = Math.max(left.totalColumns, right.totalColumns, 1);
    if (api.single) {
      pairs.forEach((pair) => Object.assign(pair, { diagnostics: ['', ''], intervals: [], errorCount: 0 }));
      return { pairs, errors, total };
    }
    let sliceStarted = performance.now();
    const yieldIfNeeded = () => {
      if (performance.now() - sliceStarted < 8) return null;
      return new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
        sliceStarted = performance.now();
        api.check();
      });
    };
    for (let p = 0; p < pairs.length; p += 1) {
      const pair = pairs[p];
      const a = left.rows[pair.left];
      const b = right.rows[pair.right];
      const aLength = api.length(a, left);
      const bLength = api.length(b, right);
      const end = Math.max(aLength, bLength, !a || !b ? 1 : 0);
      const step = Math.min(a ? api.step(a, left) : 1, b ? api.step(b, right) : 1, 1);
      const padded = api.padded?.(a, b);
      const intervals = [];
      let current = null;
      let checked = 0;
      const diagnostics = [a, b].map((row) => row && row.formula && row.formula.valid === false
        ? row.formula.error || (row.formula.errors || []).join('; ') || '公式无法计算' : '');
      pair.diagnostics = diagnostics;
      const fullReason = diagnostics.some(Boolean) ? '公式错误' : !a || !b ? '缺少信号' : '';
      const nextBoundary = !fullReason && api.next && (!api.useBoundaries || api.useBoundaries(a, b)) ? api.next : null;
      const first = !fullReason && api.start
        ? Math.max(0, Math.min(api.start(a, left), api.start(b, right))) : 0;
      const limit = Math.ceil(end / step);
      for (let index = Math.floor(first / step); index < limit;) {
        const start = index * step;
        const av = api.value(a, start, left);
        const bv = api.value(b, start, right);
        let next = fullReason ? limit : index + 1;
        if (nextBoundary) {
          const boundary = Math.min(nextBoundary(a, start, left), nextBoundary(b, start, right));
          next = Math.min(limit, Math.max(next, Math.ceil(boundary / step - 1e-9)));
        }
        const stop = Math.min(end, next * step);
        const reason = fullReason || (!padded && (start >= aLength || start >= bLength) ? '数据长度不同'
          : equalValues(av, bv) ? '' : '值不同');
        if (reason) {
          if (current && current.reason === reason) current.end = stop;
          else {
            current = { pair: p, start, end: stop, reason, leftValue: av, rightValue: bv };
            intervals.push(current);
            errors.push(current);
          }
        } else current = null;
        index = next;
        if (++checked % 2048 === 0) {
          api.progress({ row: p + 1, rows: pairs.length, name: pair.name, fraction: (p + start / Math.max(1, end)) / Math.max(1, pairs.length) });
          const wait = yieldIfNeeded();
          if (wait) await wait;
        }
      }
      pair.intervals = intervals;
      pair.errorCount = intervals.length;
      api.progress({ row: p + 1, rows: pairs.length, name: pair.name, fraction: (p + 1) / Math.max(1, pairs.length) });
      const wait = yieldIfNeeded();
      if (wait) await wait;
    }
    errors.sort((a, b) => a.start - b.start || a.pair - b.pair);
    errors.forEach((error, index) => { error.index = index; });
    return { pairs, errors, total };
  }

  global.VisualWaveDromScopeCompareCore = { compare, namesFor, valueKey };
})(typeof self !== 'undefined' ? self : globalThis);

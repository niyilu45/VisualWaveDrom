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

  async function compare(left, right, api) {
    const leftNames = namesFor(left.rows);
    const rightNames = namesFor(right.rows);
    const rightMap = new Map(rightNames.map((name, index) => [name, index]));
    const pairs = leftNames.map((name, index) => ({ name, left: index, right: rightMap.has(name) ? rightMap.get(name) : -1 }));
    const leftSet = new Set(leftNames);
    rightNames.forEach((name, index) => { if (!leftSet.has(name)) pairs.push({ name, left: -1, right: index }); });
    const errors = [];
    const total = Math.max(left.totalColumns, right.totalColumns, 1);
    for (let p = 0; p < pairs.length; p += 1) {
      const pair = pairs[p];
      const a = left.rows[pair.left];
      const b = right.rows[pair.right];
      const aLength = api.length(a, left);
      const bLength = api.length(b, right);
      const end = Math.max(aLength, bLength, !a || !b ? 1 : 0);
      const step = Math.min(a ? api.step(a) : 1, b ? api.step(b) : 1, 1);
      const intervals = [];
      let current = null;
      let checked = 0;
      const diagnostics = [a, b].map((row) => row && row.formula && row.formula.valid === false
        ? row.formula.error || (row.formula.errors || []).join('; ') || '公式无法计算' : '');
      pair.diagnostics = diagnostics;
      for (let index = 0; index < Math.ceil(end / step); index += 1) {
        const start = index * step;
        const av = api.value(a, start, left);
        const bv = api.value(b, start, right);
        const reason = diagnostics.some(Boolean) ? '公式错误'
          : (!a || !b) ? '缺少信号'
          : (start >= aLength || start >= bLength) ? '数据长度不同'
          : valueKey(av) !== valueKey(bv) ? '值不同' : '';
        if (reason) {
          if (current && current.reason === reason) current.end = Math.min(end, start + step);
          else {
            current = { pair: p, start, end: Math.min(end, start + step), reason, leftValue: av, rightValue: bv };
            intervals.push(current);
            errors.push(current);
          }
        } else current = null;
        if (++checked % 4096 === 0) {
          api.progress({ row: p + 1, rows: pairs.length, name: pair.name, fraction: (p + start / Math.max(1, end)) / Math.max(1, pairs.length) });
          await new Promise((resolve) => setTimeout(resolve, 0));
          api.check();
        }
      }
      pair.intervals = intervals;
      pair.errorCount = intervals.length;
      api.progress({ row: p + 1, rows: pairs.length, name: pair.name, fraction: (p + 1) / Math.max(1, pairs.length) });
      await new Promise((resolve) => setTimeout(resolve, 0));
      api.check();
    }
    errors.sort((a, b) => a.start - b.start || a.pair - b.pair);
    errors.forEach((error, index) => { error.index = index; });
    return { pairs, errors, total };
  }

  global.VisualWaveDromScopeCompareCore = { compare, namesFor, valueKey };
})(typeof self !== 'undefined' ? self : globalThis);

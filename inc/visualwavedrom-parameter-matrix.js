(function (global) {
  'use strict';
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const raw = (value) => value == null ? '' : String(value);
  function normalize(tables, warnings) {
    const additions = [], ids = new Set(tables.map((table) => table.id));
    tables.forEach((table) => {
      const used = new Set();
      const reserved = new Set(table.rows.filter((row) => row && typeof row.id === 'string' && row.id).map((row) => row.id));
      table.rows.forEach((row, index) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('参数行格式错误：' + table.name + ' 第 ' + (index + 1) + ' 行');
        if (typeof row.id !== 'string' || !row.id || used.has(row.id)) {
          const previous = row.id, base = 'row-' + table.id + '-' + index;
          let next = base, suffix = 1;
          while (used.has(next) || reserved.has(next)) next = base + '-' + suffix++;
          row.id = next;
          if (previous != null && warnings) warnings.push({ tableId: table.id, row: index + 1, previous, id: next });
        }
        used.add(row.id);
      });
      // Preserve values and existing links when opening the retired column format.
      if (own(table, 'scenarios')) {
        if (!Array.isArray(table.scenarios)) throw new Error('旧参数表列格式错误：' + table.name);
        table.scenarios.forEach((column) => {
          if (!column.id || ids.has(column.id)) throw new Error('旧参数表列标识重复或无效：' + table.name);
          ids.add(column.id);
          const next = { id: column.id, name: table.name + ' / ' + column.name, parentId: table.parentId || '', rows: [] };
          if (table.references) next.references = copy(table.references);
          table.rows.forEach((row) => {
            const value = (column.overrides || {})[row.id] || {};
            if (value.excluded || row.commonPresent === false && !own(value, 'val')) return;
            const result = copy(row);
            for (const field of ['val', 'description']) if (own(value, field)) result[field] = value[field];
            delete result.commonPresent; next.rows.push(result);
          });
          additions.push(next);
        });
        delete table.scenarios;
      }
      table.rows = table.rows.filter((row) => row.commonPresent !== false);
      table.rows.forEach((row) => { delete row.commonPresent; });
    });
    tables.push(...additions); return tables;
  }
  function owner(tables, id) { return tables.find((table) => table.id === id); }
  function validate(tables) {
    const ids = new Set();
    tables.forEach((table) => {
      if (!table.id || ids.has(table.id)) throw new Error('参数表标识重复或无效');
      ids.add(table.id);
      const rows = new Set();
      table.rows.forEach((row) => {
        if (typeof row.id !== 'string' || !row.id || rows.has(row.id)) throw new Error('参数行标识重复或无效：' + table.name);
        rows.add(row.id);
      });
      if (!own(table, 'references')) return;
      if (!Array.isArray(table.references)) throw new Error('引用参数表格式错误：' + table.name);
      const sources = new Set();
      table.references.forEach((source) => {
        if (!source || typeof source.tableId !== 'string' || !source.tableId || sources.has(source.tableId)) throw new Error('引用参数表重复或无效：' + table.name);
        sources.add(source.tableId);
        if (own(source, 'rowIds') && (!Array.isArray(source.rowIds) || source.rowIds.some((key) => typeof key !== 'string') || new Set(source.rowIds).size !== source.rowIds.length)) throw new Error('引用变量选择无效：' + table.name);
      });
    });
    const done = new Set(), stack = [];
    function visit(table) {
      if (stack.includes(table)) throw new Error('参数表循环引用：' + stack.slice(stack.indexOf(table)).concat(table).map((item) => item.name).join(' -> '));
      if (done.has(table)) return;
      if (stack.length >= 128) throw new Error('参数表引用层级超过 128 层');
      stack.push(table);
      (table.references || []).forEach((source) => { const next = owner(tables, source.tableId); if (next) visit(next); });
      stack.pop(); done.add(table);
    }
    tables.forEach(visit);
  }
  function all(tables) {
    const originals = new Map(tables.map((table) => [table.id, table])), result = new Map(), stack = new Set();
    function resolve(key) {
      if (result.has(key)) return result.get(key);
      const table = originals.get(key);
      if (!table) return null;
      if (stack.has(key) || stack.size >= 128) throw new Error('参数表循环引用或层级过深：' + table.name);
      stack.add(key);
      const refs = table.references || [], rows = table.rows.slice(), names = new Set(rows.map((row) => raw(row.name)));
      refs.forEach((ref) => {
        const source = resolve(ref.tableId);
        if (!source) return;
        const selected = own(ref, 'rowIds') ? new Set(ref.rowIds) : null;
        source.rows.forEach((row) => {
          const name = raw(row.name);
          if (!name || selected && !selected.has(row.id) || names.has(name)) return;
          names.add(name);
          rows.push(Object.assign({}, row, { referenceSource: row.referenceSource || { tableId: source.id, name: source.name }, referencePath: [source.id, ...(row.referencePath || [])] }));
        });
      });
      const next = refs.length ? Object.assign({}, table, { rows, referenceOwnerId: table.id }) : table;
      stack.delete(key); result.set(key, next); return next;
    }
    return tables.map((table) => resolve(table.id));
  }
  function referenceSections(tables, tableId, columns) {
    const resolved = columns || all(tables), table = resolved.find((item) => item.id === tableId);
    if (!table) return [];
    const winners = new Map(table.rows.map((row) => [raw(row.name), row]));
    return (table.references || []).map((ref) => {
      const source = resolved.find((item) => item.id === ref.tableId);
      const selected = own(ref, 'rowIds') ? new Set(ref.rowIds) : null;
      const available = new Set(source ? source.rows.map((row) => row.id) : []);
      const rows = source ? source.rows.filter((row) => raw(row.name) && (!selected || selected.has(row.id))).map((row) => {
        const winner = winners.get(raw(row.name));
        return { row, winner, used: !!winner && !!winner.referencePath && winner.referencePath[0] === source.id && winner.id === row.id };
      }) : [];
      return { reference: ref, source, rows, missing: !source, missingRows: selected ? [...selected].filter((key) => !available.has(key)).length : 0 };
    });
  }
  function cloneTable(table, makeId) {
    const next = copy(table); next.id = makeId();
    next.rows.forEach((row) => { row.id = makeId(); }); return next;
  }
  function editEffective(tables, tableId, edits, makeId) {
    const table = owner(tables, tableId);
    if (!table) throw new Error('参数表已不存在');
    edits.forEach(({ before, after }) => {
      let row = before && table.rows.find((item) => item.id === before.id);
      if (!row) row = table.rows.find((item) => item.name === after.name);
      if (!row) { row = { id: makeId(), name: after.name, val: raw(after.val), description: raw(after.description) }; table.rows.push(row); }
      ['name', 'val', 'description'].forEach((field) => { if (!before || raw(before[field]) !== raw(after[field])) row[field] = raw(after[field]); });
    });
  }
  global.VWDParameterMatrix = Object.freeze({ own, raw, normalize, validate, owner, all, referenceSections, cloneTable, editEffective });
})(window);

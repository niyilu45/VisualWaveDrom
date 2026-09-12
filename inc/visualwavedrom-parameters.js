(function (global) {
  'use strict';
  const tokenPattern = /\{((?=[^{}]*\$)\s*(?:[$+\-.\d(]|(?:max|min)\s*\()[^{}]*)\}/g;
  const parameterValuePattern = /\{(\s*(?:[$+\-.\d(]|(?:max|min)\s*\()[^{}]*)\}/g;
  const dataTokenPattern = /(?:\{(?=[^{}]*\$)\s*(?:[$+\-.\d(]|(?:max|min)\s*\()[^{}]*\}|\S)+/g;
  const numericPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const empty = () => ({ revision: 0, directories: [], tables: [], presets: [] });
  let catalog = empty(), libraryId = '', bridge = null, generation = 0;
  let cache = new WeakMap(), selectedFolder = '', selectedTable = '', activePage = 'wave';
  let dirty = 0, savedGeneration = 0, timer = null, saving = null, failure = '';
  let modal = null, channel = null;
  let tableViewId = '', selectedRow = null;
  const rowFilters = { name: '', val: '' };
  const clipboardKind = 'VisualWaveDromParametersClipboard';
  let parameterClipboard = null, clipboardRequest = 0;
  let parameterUndoStack = [], parameterRedoStack = [];
  const menuHiddenStates = new WeakMap();
  const expanded = new Set(['']);
  const $ = (id) => document.getElementById(id);
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const paths = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    trash: '<path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6"/>',
    edit: '<path d="m16 3 5 5-12 12-6 1 1-6ZM14 5l5 5"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    paste: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
    up: '<path d="m6 14 6-6 6 6"/>', down: '<path d="m6 10 6 6 6-6"/>',
    grip: '<circle cx="9" cy="5" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="19" r="1"/>',
    link: '<path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m4 2 1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"/>'
  };
  function button(label, action, icon) {
    const node = element('button', icon ? 'parameter-icon' : 'modal-btn', icon ? undefined : label);
    node.type = 'button'; node.title = label; node.setAttribute('aria-label', label);
    if (icon) node.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" class="lucide">' + paths[icon] + '</svg>';
    node.addEventListener('click', action);
    return node;
  }
  function normalize(value) {
    const next = Object.assign(empty(), value || {});
    ['directories', 'tables', 'presets'].forEach((key) => {
      next[key] = Array.isArray(next[key]) ? clone(next[key]).filter((item) => item && typeof item.id === 'string') : [];
    });
    next.tables.forEach((table) => { table.rows = Array.isArray(table.rows) ? table.rows : []; });
    next.revision = Number(next.revision) || 0;
    return next;
  }
  function id() { return 'param-' + (global.crypto.randomUUID ? global.crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)); }
  function linked(source) { return source && Array.isArray(source.parameterTables) ? source.parameterTables : []; }
  function resolveParameterRow(table, row, source, state) {
    const context = state || { stack: [], values: new Map() };
    if (context.values.has(row)) return context.values.get(row);
    const name = String(row.name || '');
    const rawVal = row.val == null ? '' : String(row.val);
    const result = { name, table: table.name, tableId: table.id, val: rawVal, rawVal, description: String(row.description || ''), formula: false, error: '' };
    const cycle = context.stack.findIndex((entry) => entry.row === row);
    if (cycle >= 0) {
      return Object.assign(result, { formula: true, error: '变量循环引用：' + context.stack.slice(cycle).map((entry) => entry.name).concat(name).join(' -> ') });
    }
    if (context.stack.length >= 128) return Object.assign(result, { formula: true, error: '变量依赖层级超过 128 层：' + name });
    context.stack.push({ row, name });
    try {
      if (rawVal.includes('{')) {
        const value = rawVal.replace(parameterValuePattern, (raw, expression) => {
          result.formula = true;
          const evaluated = evaluate(expression, source, context);
          if (evaluated.error) { result.error = result.error || evaluated.error; return raw; }
          return evaluated.value;
        });
        if (!result.error) result.val = value;
      }
    } finally {
      context.stack.pop();
    }
    context.values.set(row, result);
    return result;
  }
  function resolveName(name, source, state) {
    for (const tableId of linked(source)) {
      const table = catalog.tables.find((item) => item.id === tableId);
      const row = table && table.rows.find((item) => String(item.name || '') === name);
      if (row) return resolveParameterRow(table, row, source, state);
    }
    return null;
  }
  function text(value, source) {
    if (typeof value !== 'string' || !value.includes('$')) return value;
    return value.replace(tokenPattern, (raw, expression) => {
      const result = evaluate(expression, source);
      return result.error ? raw : result.value;
    });
  }
  function evaluate(expression, source, state) {
    const context = state || { stack: [], values: new Map() };
    const variables = new Map();
    const hasVariables = expression.includes('$');
    let offset = 0, depth = 0;
    function skipSpace() { while (/\s/.test(expression[offset] || '') && offset < expression.length) offset++; }
    function number(value) {
      if (!numericPattern.test(String(value).trim()) || !Number.isFinite(Number(value))) {
        throw new Error(String(value) + ' 不是有效数字，不能参与运算');
      }
      return Number(value);
    }
    function finite(value) {
      if (!Number.isFinite(value)) throw new Error('运算结果超出有效数字范围');
      return value;
    }
    function primary() {
      skipSpace();
      if (++depth > 64) throw new Error('公式嵌套超过 64 层');
      try {
        const rest = expression.slice(offset);
        const variable = /^\$[^{}\s$(),]+/.exec(rest);
        if (variable) {
          offset += variable[0].length;
          const name = variable[0].slice(1);
          const found = variables.get(name) || resolveName(name, source, context);
          if (!found) throw new Error('未找到变量：' + variable[0] + '（运算符两侧需有空格）');
          if (found.error) throw new Error(found.error);
          variables.set(name, found);
          return found.val;
        }
        const literal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
        if (literal) { offset += literal[0].length; return literal[0]; }
        const call = /^(max|min)\s*\(/.exec(rest);
        if (call || expression[offset] === '(') {
          offset += call ? call[0].length : 1;
          skipSpace();
          if (expression[offset] === ')') throw new Error(call ? call[1] + ' 至少需要一个参数' : '括号内不能为空');
          let value = sum();
          if (call) {
            value = number(value); skipSpace();
            while (expression[offset] === ',') {
              offset++;
              const right = number(sum());
              value = call[1] === 'max' ? Math.max(value, right) : Math.min(value, right);
              skipSpace();
            }
          }
          skipSpace();
          if (expression[offset] !== ')') throw new Error('缺少右括号或函数参数分隔符（英文逗号）');
          offset++;
          return value;
        }
        throw new Error('表达式格式错误：仅支持变量、数字、加减乘除和 max/min');
      } finally { depth--; }
    }
    function operator(allowed) {
      skipSpace();
      const op = expression[offset];
      if (!op || !allowed.includes(op)) return '';
      if (hasVariables && (!/\s/.test(expression[offset - 1] || '') || !/\s/.test(expression[offset + 1] || ''))) {
        throw new Error('运算符两侧至少保留一个空格');
      }
      offset++;
      return op;
    }
    function product() {
      let value = primary(), op;
      while ((op = operator('*/'))) {
        const left = number(value), right = number(primary());
        if (op === '/' && right === 0) throw new Error('除数不能为 0');
        value = finite(op === '*' ? left * right : left / right);
      }
      return value;
    }
    function sum() {
      let value = product(), op;
      while ((op = operator('+-'))) {
        const left = number(value), right = number(product());
        value = finite(op === '+' ? left + right : left - right);
      }
      return value;
    }
    try {
      let result = sum(); skipSpace();
      if (offset !== expression.length) throw new Error('表达式格式错误：第 ' + (offset + 1) + ' 个字符附近有多余内容');
      if (!hasVariables) result = number(result);
      return { value: String(result), variables: Array.from(variables.values()) };
    } catch (error) {
      return { error: error.message, variables: Array.from(variables.values()) };
    }
  }
  function details(value, source) {
    const found = new Set();
    return Array.from(String(value || '').matchAll(tokenPattern), (match) => {
      if (found.has(match[1])) return '';
      found.add(match[1]);
      const result = evaluate(match[1], source);
      const summary = result.error ? '\n' + result.error : '\n结果：' + result.value;
      return match[0] + summary + result.variables.map((item) => '\n\n$' + item.name + '\n参数表：' + item.table
        + '\n值：' + item.val + (item.formula ? '\n公式：' + item.rawVal : '') + '\n说明：' + (item.description || '无')).join('');
    }).filter(Boolean).join('\n\n');
  }
  function resolve(source) {
    if (!source || typeof source !== 'object' || !linked(source).length) return source;
    const old = cache.get(source);
    if (old && old.generation === generation) return old.value;
    function visit(value) {
      if (typeof value === 'string') return text(value, source);
      if (!value || typeof value !== 'object') return value;
      let next = value;
      Object.keys(value).forEach((key) => {
        if (key === 'parameterTables') return;
        const raw = value[key];
        const result = key === 'data' && typeof raw === 'string' && raw.includes('$') && raw.match(tokenPattern)
          ? (raw.match(dataTokenPattern) || []).map((label) => text(label, source))
          : visit(raw);
        if (result !== value[key]) {
          if (next === value) next = Array.isArray(value) ? value.slice() : Object.assign({}, value);
          next[key] = result;
        }
      });
      return next;
    }
    const value = visit(source);
    cache.set(source, { generation, value });
    // Do not expand nested placeholders a second time when a render window
    // passes an already-resolved document through the rendering pipeline.
    if (value !== source) cache.set(value, { generation, value });
    return value;
  }
  function decorate(host, source) {
    if (!host || !source || !linked(source).length) return;
    const bindings = new Map();
    function add(raw) {
      if (typeof raw !== 'string' || !raw.includes('$')) return;
      const rendered = text(raw, source);
      const hint = details(raw, source);
      if (hint) {
        const previous = bindings.get(rendered);
        bindings.set(rendered, previous && previous !== hint ? previous + '\n\n' + hint : hint);
      }
    }
    function rows(items) {
      (items || []).forEach((row) => {
        if (Array.isArray(row)) { add(row[0]); rows(row.slice(1)); }
        else if (row && typeof row === 'object') {
          add(row.name);
          (Array.isArray(row.data) ? row.data : typeof row.data === 'string' ? row.data.match(dataTokenPattern) || [] : []).forEach(add);
        }
      });
    }
    rows(source.signal); add(source.title); add(source.head && source.head.text); add(source.foot && source.foot.text); add(source.description);
    (source.edge || []).forEach((edge) => add(String(edge).replace(/^\S+\s*/, '').replace(/^:\s*/, '')));
    host.querySelectorAll('svg text, .wave-document-description:not(.editing), h2').forEach((node) => {
      if (node.hasAttribute('data-parameter-hint')) return;
      const content = node.textContent;
      const hint = bindings.get(content) || (node.tagName === 'H2' && Array.from(bindings).find(([value]) => value && content.endsWith(value)) || [])[1];
      if (hint) node.dataset.parameterHint = hint;
      else delete node.dataset.parameterHint;
    });
  }
  function status(message, error) {
    const node = $('parameter-status');
    if (node) { node.textContent = message; node.classList.toggle('error', !!error); }
  }
  function clipboardButton(type, action, label) {
    const node = button(label, () => {
      if (action === 'copy') void copyParameters(type);
      else void pasteParameters(type);
    }, action);
    node.dataset.parameterClipboard = type + '-' + action;
    node.title = label + (action === 'copy' ? ' (Ctrl+C)' : ' (Ctrl+V)');
    return node;
  }
  function updateClipboardButtons() {
    const table = catalog.tables.find((item) => item.id === selectedTable);
    document.querySelectorAll('[data-parameter-clipboard]').forEach((node) => {
      const [type, action] = node.dataset.parameterClipboard.split('-');
      node.disabled = action === 'copy'
        ? !table || (type === 'row' && !table.rows.includes(selectedRow))
        : (type === 'row' && !table) || !(parameterClipboard && parameterClipboard.type === type || global.navigator.clipboard && global.navigator.clipboard.readText);
    });
  }
  function clipboardSnapshot(type) {
    const table = catalog.tables.find((item) => item.id === selectedTable);
    if (!table || type === 'row' && !table.rows.includes(selectedRow)) throw new Error(type === 'table' ? '请先选中参数表' : '请先选中一行');
    const payload = { kind: clipboardKind, version: 1, type };
    if (type === 'table') payload.table = { name: table.name, rows: table.rows };
    else payload.row = selectedRow;
    return clone(payload);
  }
  function parseClipboard(value, type) {
    if (!value || value.length > 8 * 1024 * 1024) throw new Error('剪贴板为空或参数内容过大');
    let payload;
    try { payload = JSON.parse(value); } catch (_) { throw new Error('剪贴板中不是参数表或参数行'); }
    if (!payload || payload.kind !== clipboardKind || payload.version !== 1 || payload.type !== type) {
      throw new Error(type === 'table' ? '请先复制一张参数表' : '请先复制一行参数');
    }
    const table = type === 'table' ? payload.table : { name: '参数行', rows: [payload.row] };
    if (!table || typeof table.name !== 'string' || !Array.isArray(table.rows) || table.rows.some((row) =>
      !row || typeof row !== 'object' || Array.isArray(row) || typeof row.name !== 'string'
      || ![row.val, row.description].every((item) => item == null || ['string', 'number', 'boolean'].includes(typeof item)))) {
      throw new Error('剪贴板中的参数格式无效');
    }
    validate({ directories: [], presets: [], tables: [Object.assign({ id: 'clipboard' }, table)] });
    return payload;
  }
  async function copyParameters(type, event) {
    try {
      const payload = clipboardSnapshot(type), text = JSON.stringify(payload, null, 2);
      parameterClipboard = payload; const request = ++clipboardRequest; updateClipboardButtons();
      const label = type === 'table' ? '已复制参数表' : '已复制参数行';
      if (event && event.clipboardData) {
        event.clipboardData.setData('text/plain', text); event.preventDefault(); status(label); return;
      }
      status(label);
      try {
        if (!global.navigator.clipboard || !global.navigator.clipboard.writeText) throw new Error('unavailable');
        await global.navigator.clipboard.writeText(text);
      } catch (_) { if (request === clipboardRequest) status(label + '，可在当前窗口粘贴'); }
    } catch (error) { status(error.message, true); }
  }
  function uniqueCopyName(name, existing, table) {
    if (!existing.has(name)) return name;
    const base = name + (table ? ' 副本' : '_copy'); let next = base, index = 2;
    while (existing.has(next)) next = base + index++;
    return next;
  }
  function focusTreeItem(type, value) {
    const node = Array.from($('parameter-tree').querySelectorAll('.parameter-tree-label')).find((item) => item.dataset[type] === value);
    if (node) node.focus({ preventScroll: true });
  }
  function applyClipboard(payload, type) {
    if (type === 'table') {
      const table = { id: id(), name: uniqueCopyName(payload.table.name, new Set(catalog.tables.map((item) => item.name)), true), parentId: selectedFolder, rows: clone(payload.table.rows) };
      insertTable(table); return;
    }
    const table = catalog.tables.find((item) => item.id === selectedTable);
    if (!table) throw new Error('请先选中目标参数表');
    const row = clone(payload.row);
    if (row.name) row.name = uniqueCopyName(row.name, new Set(table.rows.map((item) => item.name)), false);
    const index = table.rows.indexOf(selectedRow);
    table.rows.splice(index < 0 ? table.rows.length : index + 1, 0, row);
    selectedRow = row; rowFilters.name = ''; rowFilters.val = '';
    changed(true);
    const handle = $('parameter-workspace').querySelector('tr.selected .parameter-row-select');
    if (handle) { handle.focus({ preventScroll: true }); handle.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  }
  async function pasteParameters(type, event) {
    const destination = { libraryId, folder: selectedFolder, table: selectedTable, row: selectedRow };
    const request = ++clipboardRequest;
    try {
      let text;
      if (event && event.clipboardData) { text = event.clipboardData.getData('text/plain'); event.preventDefault(); }
      else {
        try {
          if (!global.navigator.clipboard || !global.navigator.clipboard.readText) throw new Error('unavailable');
          text = await global.navigator.clipboard.readText();
        } catch (_) {
          if (!parameterClipboard) throw new Error('无法读取剪贴板，请先复制参数，或使用 Ctrl+V 粘贴');
          text = JSON.stringify(parameterClipboard);
        }
      }
      if (request !== clipboardRequest || destination.libraryId !== libraryId || activePage !== 'parameters'
          || destination.folder !== selectedFolder || destination.table !== selectedTable || destination.row !== selectedRow) {
        status('粘贴位置已改变，请重新粘贴', true); return;
      }
      const payload = parseClipboard(text, type);
      applyClipboard(payload, type); parameterClipboard = clone(payload); updateClipboardButtons();
    } catch (error) { status(error.message, true); }
  }
  function clipboardContext(target) {
    if (activePage !== 'parameters' || modal || !target || !target.closest || target.closest('.modal-overlay')) return '';
    if (target.closest('#parameter-directory-page')) return 'table';
    if (target.closest('#parameter-workspace')) return 'row';
    return '';
  }
  function isTextInput(target) { return !!(target && target.closest && target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')); }
  function parameterHistoryState() { return { canUndo: parameterUndoStack.length > 0, canRedo: parameterRedoStack.length > 0 }; }
  function notifyParameterHistory() { if (bridge && bridge.historyChanged) bridge.historyChanged(); }
  function recordParameterHistory(entry) {
    parameterUndoStack.push(entry);
    if (parameterUndoStack.length > 50) parameterUndoStack.shift();
    parameterRedoStack = [];
  }
  function folderAncestors(parentId) {
    const parents = [], seen = new Set();
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId); parents.push(parentId);
      parentId = (catalog.directories.find((dir) => dir.id === parentId) || {}).parentId;
    }
    return parents.concat('');
  }
  function captureTablePosition(entry) {
    const index = catalog.tables.indexOf(entry.table);
    entry.index = index; entry.previous = catalog.tables[index - 1]; entry.next = catalog.tables[index + 1];
    entry.parents = folderAncestors(entry.table.parentId);
    return entry;
  }
  function finishTableHistory(table, parentId) {
    clipboardRequest++;
    selectedTable = table ? table.id : ''; selectedFolder = table ? table.parentId || '' : parentId || '';
    folderAncestors(selectedFolder).forEach((id) => expanded.add(id));
    changed(true, true);
    focusTreeItem(table ? 'tableId' : 'folderId', table ? table.id : selectedFolder);
  }
  function insertTable(table) {
    catalog.tables.push(table);
    recordParameterHistory(captureTablePosition({ kind: 'table-add', table }));
    finishTableHistory(table);
  }
  function deleteTable(table) {
    const index = catalog.tables.indexOf(table); if (index < 0) return;
    recordParameterHistory(captureTablePosition({ kind: 'table-delete', table }));
    catalog.tables.splice(index, 1);
    finishTableHistory(null, table.parentId);
  }
  function finishRowHistory(table, row, scrollTop) {
    clipboardRequest++;
    const switched = selectedTable !== table.id;
    selectedTable = table.id; selectedFolder = table.parentId || ''; tableViewId = table.id; selectedRow = row;
    if (switched) { rowFilters.name = ''; rowFilters.val = ''; }
    changed(true, true);
    const workspace = $('parameter-workspace');
    let handle = workspace.querySelector('tr.selected .parameter-row-select');
    if (row && !handle) {
      rowFilters.name = ''; rowFilters.val = ''; selectedRow = row;
      renderTable(); handle = workspace.querySelector('tr.selected .parameter-row-select');
    }
    const scroller = workspace.querySelector('.parameter-grid-scroll');
    if (scroller) scroller.scrollTop = switched ? 0 : scrollTop;
    workspace.tabIndex = -1;
    (handle || workspace).focus({ preventScroll: true });
    if (handle) handle.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function deleteSelectedRow() {
    if (activePage !== 'parameters' || modal) return false;
    const table = catalog.tables.find((item) => item.id === selectedTable);
    const index = table ? table.rows.indexOf(selectedRow) : -1;
    if (index < 0) return false;
    const scroller = $('parameter-workspace').querySelector('.parameter-grid-scroll');
    // Retain the removed row and its neighbors, not a snapshot of unrelated edits.
    recordParameterHistory({ kind: 'row-delete', tableId: table.id, row: selectedRow, index, previous: table.rows[index - 1], next: table.rows[index + 1] });
    table.rows.splice(index, 1);
    finishRowHistory(table, null, scroller ? scroller.scrollTop : 0);
    return true;
  }
  function applyParameterHistory(redo) {
    if (activePage !== 'parameters' || modal) return false;
    const from = redo ? parameterRedoStack : parameterUndoStack, to = redo ? parameterUndoStack : parameterRedoStack;
    const entry = from[from.length - 1]; if (!entry) return false;
    if (entry.kind === 'table-add' || entry.kind === 'table-delete') {
      const insert = (entry.kind === 'table-add') === redo;
      if (insert) {
        if (catalog.tables.some((table) => table.id === entry.table.id)) return false;
        const next = catalog.tables.indexOf(entry.next), previous = catalog.tables.indexOf(entry.previous);
        const index = next >= 0 ? next : previous >= 0 ? previous + 1 : Math.min(entry.index, catalog.tables.length);
        // Keep the original table identity so links, presets and older row history still refer to it.
        entry.table.parentId = entry.parents.find((id) => !id || catalog.directories.some((dir) => dir.id === id)) || '';
        catalog.tables.splice(index, 0, entry.table);
      } else {
        const index = catalog.tables.indexOf(entry.table); if (index < 0) return false;
        captureTablePosition(entry);
        catalog.tables.splice(index, 1);
      }
      from.pop(); to.push(entry);
      finishTableHistory(insert ? entry.table : null, entry.table.parentId);
      return true;
    }
    const table = catalog.tables.find((item) => item.id === entry.tableId);
    if (!table) return false;
    const scroller = $('parameter-workspace').querySelector('.parameter-grid-scroll');
    if (redo) {
      const index = table.rows.indexOf(entry.row);
      if (index < 0) return false;
      entry.index = index; entry.previous = table.rows[index - 1]; entry.next = table.rows[index + 1];
      table.rows.splice(index, 1);
    } else {
      const next = table.rows.indexOf(entry.next), previous = table.rows.indexOf(entry.previous);
      const index = next >= 0 ? next : previous >= 0 ? previous + 1 : Math.min(entry.index, table.rows.length);
      table.rows.splice(index, 0, entry.row);
    }
    from.pop(); to.push(entry);
    finishRowHistory(table, redo ? null : entry.row, scroller ? scroller.scrollTop : 0);
    return true;
  }
  function onClipboardEvent(event) {
    const type = clipboardContext(event.target); if (!type) return;
    event.stopPropagation();
    if (isTextInput(event.target)) {
      if (event.type === 'copy') { parameterClipboard = null; clipboardRequest++; updateClipboardButtons(); }
      return;
    }
    if (event.type === 'copy') void copyParameters(type, event);
    else void pasteParameters(type, event);
  }
  function parameterNameCounts(rows) {
    const counts = new Map();
    rows.forEach((row) => { const name = String(row.name || ''); counts.set(name, (counts.get(name) || 0) + 1); });
    return counts;
  }
  function parameterRowNameError(row, counts) {
    const name = String(row.name || '');
    if (!name && !row.val && !row.description) return '';
    if (!name || /[{}\s$]/.test(name)) return '变量名不能为空或包含空白、{}、$';
    return counts.get(name) > 1 ? '变量名 ' + name + ' 重复' : '';
  }
  function validate(value) {
    const ids = new Set();
    ['directories', 'tables', 'presets'].forEach((key) => value[key].forEach((item) => {
      if (ids.has(item.id)) throw new Error('重复的参数目录标识');
      ids.add(item.id);
      if (!String(item.name || '').trim()) throw new Error('名称不能为空');
    }));
    value.tables.forEach((table) => {
      const names = parameterNameCounts(table.rows);
      table.rows.forEach((row, index) => {
        const error = parameterRowNameError(row, names);
        if (error) throw new Error(table.name + ' 第 ' + (index + 1) + ' 行：' + error);
      });
    });
  }
  function invalidate() {
    generation++; cache = new WeakMap();
    if (bridge) bridge.changed();
  }
  function changed(render, applyingHistory) {
    if (!applyingHistory) parameterRedoStack = [];
    dirty++; failure = ''; invalidate();
    if (render) { renderTree(); renderTable(); }
    notifyParameterHistory();
    status('正在保存参数目录...');
    clearTimeout(timer); timer = setTimeout(() => { void flush().catch(() => {}); }, 220);
  }
  async function flush() {
    clearTimeout(timer);
    if (saving) { await saving; if (dirty !== savedGeneration) return flush(); return; }
    if (dirty === savedGeneration) return;
    const at = dirty, identity = libraryId;
    const value = clone(catalog);
    saving = (async () => {
      validate(value);
      const saved = await bridge.save(value, value.revision);
      if (identity !== libraryId) throw new Error('保存期间波形库已切换');
      catalog.revision = saved.revision; savedGeneration = at; failure = '';
      if (channel) channel.postMessage({ libraryId, catalog: saved });
      status('已保存到工作库');
    })().catch((error) => {
      failure = error.message; status(failure, true); throw error;
    }).finally(() => { saving = null; });
    await saving;
    if (dirty !== savedGeneration) return flush();
  }
  function setCatalog(value, identity) {
    if (identity === libraryId && (dirty !== savedGeneration || Number(value && value.revision) < catalog.revision)) return;
    const next = normalize(value);
    const sameContent = identity === libraryId && (parameterUndoStack.length || parameterRedoStack.length)
      && ['directories', 'tables', 'presets'].every((key) => JSON.stringify(catalog[key]) === JSON.stringify(next[key]));
    if (sameContent) catalog.revision = next.revision;
    else { catalog = next; parameterUndoStack = []; parameterRedoStack = []; }
    libraryId = identity || '';
    dirty = savedGeneration = 0; failure = '';
    if (!catalog.tables.some((table) => table.id === selectedTable)) selectedTable = '';
    if (!catalog.directories.some((dir) => dir.id === selectedFolder)) selectedFolder = '';
    // A restored JSON document can be unchanged while its parameter values differ.
    // Invalidate the host's rendered-wave caches as well as the resolver cache.
    invalidate();
    renderTree(); renderTable(); notifyParameterHistory();
  }
  async function refresh() {
    if (!bridge || !bridge.identity()) throw new Error('波形库仍在加载，请稍后再试');
    await flush();
    const identity = bridge.identity();
    const loadGeneration = dirty;
    const value = await bridge.load();
    if (identity !== bridge.identity() || dirty !== loadGeneration) return;
    setCatalog(value, identity);
  }
  function namePrompt(label, initial) { const answer = global.prompt(label, initial || ''); return answer == null ? null : answer.trim(); }
  function addDirectory(parentId) {
    const name = namePrompt('新标题名称'); if (!name) return;
    const dir = { id: id(), name, parentId: parentId || '' };
    catalog.directories.push(dir); expanded.add(dir.parentId); selectedFolder = dir.id; expanded.add(dir.id); changed(true);
  }
  function addTable() {
    const name = namePrompt('参数表名称'); if (!name) return;
    const table = { id: id(), name, parentId: selectedFolder, rows: [{ name: '', val: '', description: '' }] };
    insertTable(table);
    const input = $('parameter-workspace').querySelector('tbody input'); if (input) input.focus();
  }
  function rename(item) {
    const name = namePrompt('修改名称', item.name); if (!name || name === item.name) return;
    item.name = name; changed(true);
  }
  function removeDirectory(dir) {
    if (!global.confirm('删除标题“' + dir.name + '”？其中的标题和参数表将移到上一级。')) return;
    catalog.directories.filter((item) => item.parentId === dir.id).forEach((item) => { item.parentId = dir.parentId || ''; });
    catalog.tables.filter((item) => item.parentId === dir.id).forEach((item) => { item.parentId = dir.parentId || ''; });
    catalog.directories = catalog.directories.filter((item) => item !== dir);
    selectedFolder = dir.parentId || ''; changed(true);
  }
  function folderPath(idValue) {
    const names = [], seen = new Set();
    while (idValue && !seen.has(idValue)) {
      seen.add(idValue); const dir = catalog.directories.find((item) => item.id === idValue);
      if (!dir) break; names.unshift(dir.name); idValue = dir.parentId;
    }
    return names.join(' / ');
  }
  function enableFolderDrop(node, parentId) {
    node.addEventListener('dragover', (event) => { if (event.dataTransfer.types.includes('application/x-vwd-parameter')) { event.preventDefault(); node.classList.add('drop-target'); } });
    node.addEventListener('dragleave', () => node.classList.remove('drop-target'));
    node.addEventListener('drop', (event) => {
      node.classList.remove('drop-target');
      const sourceId = event.dataTransfer.getData('application/x-vwd-parameter'); if (!sourceId) return;
      event.preventDefault(); event.stopPropagation();
      const item = catalog.tables.concat(catalog.directories).find((entry) => entry.id === sourceId);
      if (!item || item.id === parentId) return;
      let cursor = parentId; const seen = new Set();
      while (cursor && !seen.has(cursor)) {
        if (cursor === item.id) { status('不能移入自己的子标题', true); return; }
        seen.add(cursor); cursor = (catalog.directories.find((entry) => entry.id === cursor) || {}).parentId;
      }
      item.parentId = parentId; expanded.add(parentId); changed(true);
    });
  }
  function renderTree() {
    const tree = $('parameter-tree'); if (!tree) return;
    tree.replaceChildren();
    function directory(parentId, depth, number, seen) {
      if (seen.has(parentId)) return;
      const nextSeen = new Set(seen); nextSeen.add(parentId);
      const dir = catalog.directories.find((item) => item.id === parentId);
      const line = element('div', 'parameter-tree-row'); line.style.setProperty('--depth', depth);
      const choose = button((dir ? number + ' ' + dir.name : '参数表'), () => {
        selectedFolder = parentId; selectedTable = '';
        if (expanded.has(parentId)) expanded.delete(parentId); else expanded.add(parentId);
        renderTree(); renderTable(); focusTreeItem('folderId', parentId);
      });
      choose.dataset.folderId = parentId;
      choose.className = 'parameter-tree-label'; choose.classList.toggle('active', !selectedTable && selectedFolder === parentId);
      const chevron = element('span', 'parameter-tree-chevron', expanded.has(parentId) ? '−' : '+');
      choose.prepend(chevron); choose.setAttribute('aria-expanded', String(expanded.has(parentId))); line.append(choose);
      line.append(button('新增子标题', () => addDirectory(parentId), 'plus'));
      if (dir) { line.append(button('修改标题名称', () => rename(dir), 'edit'), button('删除标题', () => removeDirectory(dir), 'trash')); }
      if (dir) { choose.draggable = true; choose.addEventListener('dragstart', (e) => e.dataTransfer.setData('application/x-vwd-parameter', dir.id)); }
      enableFolderDrop(line, parentId); tree.append(line);
      if (!expanded.has(parentId)) return;
      catalog.directories.filter((item) => (item.parentId || '') === parentId).forEach((item, index) => directory(item.id, depth + 1, number + (index + 1) + '.', nextSeen));
      catalog.tables.filter((item) => (item.parentId || '') === parentId).forEach((table) => {
        const row = element('div', 'parameter-tree-row'); row.style.setProperty('--depth', depth + 1);
        row.dataset.tableId = table.id;
        const pick = button(table.name, () => { selectedTable = table.id; selectedFolder = parentId; renderTree(); renderTable(); focusTreeItem('tableId', table.id); });
        pick.dataset.tableId = table.id;
        pick.className = 'parameter-tree-label'; pick.classList.toggle('active', selectedTable === table.id);
        pick.draggable = true; pick.addEventListener('dragstart', (e) => e.dataTransfer.setData('application/x-vwd-parameter', table.id));
        row.append(pick, element('span', 'parameter-count', table.rows.filter((item) => item.name).length)); tree.append(row);
      });
    }
    directory('', 0, '', new Set());
  }
  function openAddVariables(tableId, anchor) {
    if (modal) return;
    const identity = libraryId;
    const overlay = element('div', 'modal-overlay parameter-modal');
    const dialog = element('form', 'modal-dialog parameter-count-dialog'); dialog.noValidate = true;
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'parameter-count-title');
    const header = element('div', 'modal-header'); const title = element('h2', '', '新增变量'); title.id = 'parameter-count-title';
    let closed = false;
    function close() {
      if (closed) return;
      closed = true; overlay.remove(); modal = null;
      const target = anchor && anchor.isConnected ? anchor : $('parameter-workspace').querySelector('.parameter-add-variables');
      if (target) target.focus({ preventScroll: true });
    }
    header.append(title, button('关闭', close, 'close')); dialog.append(header);
    const body = element('div', 'modal-body'); const label = element('label', 'parameter-count-label', '添加数量');
    const input = element('input'); input.id = 'parameter-add-count'; input.type = 'number'; input.min = '1'; input.max = '1000'; input.step = '1'; input.value = '1'; input.required = true;
    label.htmlFor = input.id;
    const error = element('p', 'parameter-count-error'); error.id = 'parameter-count-error'; error.setAttribute('role', 'alert');
    input.setAttribute('aria-describedby', error.id);
    input.addEventListener('input', () => { error.textContent = ''; input.removeAttribute('aria-invalid'); });
    body.append(label, input, error); dialog.append(body);
    const footer = element('div', 'modal-footer'); const confirm = button('添加', () => {}); confirm.type = 'submit'; confirm.classList.add('modal-btn-primary');
    footer.append(button('取消', close), confirm); dialog.append(footer);
    dialog.addEventListener('submit', (event) => {
      event.preventDefault(); if (closed) return;
      const count = Number(input.value);
      if (!input.value.trim() || !Number.isInteger(count) || count < 1 || count > 1000) {
        error.textContent = '请输入 1 到 1000 之间的整数'; input.setAttribute('aria-invalid', 'true'); input.focus(); return;
      }
      const table = catalog.tables.find((item) => item.id === tableId);
      if (!table || identity !== libraryId || selectedTable !== tableId || activePage !== 'parameters') {
        error.textContent = '目标参数表已变化，请关闭后重新选择'; return;
      }
      confirm.disabled = true;
      const rows = Array.from({ length: count }, () => ({ name: '', val: '', description: '' }));
      table.rows.push(...rows); selectedRow = rows[0]; rowFilters.name = ''; rowFilters.val = '';
      close(); changed(true);
      const firstInput = $('parameter-workspace').querySelector('tr.selected input');
      if (firstInput) { firstInput.focus({ preventScroll: true }); firstInput.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
    });
    let startedOutside = false;
    overlay.addEventListener('pointerdown', (event) => { startedOutside = event.target === overlay; });
    overlay.addEventListener('click', (event) => { if (startedOutside && event.target === overlay) close(); });
    overlay.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Enter' && event.isComposing) event.preventDefault();
      if (event.key === 'Tab') {
        const controls = Array.from(dialog.querySelectorAll('button:not(:disabled),input'));
        if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls[controls.length - 1].focus(); }
        else if (!event.shiftKey && document.activeElement === controls[controls.length - 1]) { event.preventDefault(); controls[0].focus(); }
      }
    });
    clipboardRequest++; modal = overlay; overlay.append(dialog); document.body.append(overlay); input.focus(); input.select();
  }
  function renderTable() {
    const workspace = $('parameter-workspace'); if (!workspace) return;
    const table = catalog.tables.find((item) => item.id === selectedTable);
    if (tableViewId !== (table && table.id || '')) {
      tableViewId = table && table.id || ''; selectedRow = null;
      rowFilters.name = ''; rowFilters.val = '';
    }
    if (!table || !table.rows.includes(selectedRow)) selectedRow = null;
    workspace.replaceChildren();
    const toolbar = element('header', 'parameter-workspace-header');
    let deleteRowButton;
    const heading = element('h2');
    if (table) {
      const name = button(table.name, () => {
        rename(table);
        workspace.querySelector('.parameter-table-name').focus({ preventScroll: true });
      });
      name.className = 'parameter-table-name'; name.title = '点击修改参数表名称';
      name.setAttribute('aria-label', '修改参数表名称：' + table.name);
      heading.append(name);
    } else heading.textContent = folderPath(selectedFolder) || '参数目录';
    toolbar.append(heading);
    if (table) {
      const addVariables = button('新增变量', () => openAddVariables(table.id, addVariables));
      addVariables.classList.add('parameter-add-variables'); toolbar.append(addVariables);
      deleteRowButton = button('删除选中行', deleteSelectedRow, 'trash');
      deleteRowButton.disabled = !selectedRow; toolbar.append(deleteRowButton);
      const rowActions = element('div', 'parameter-row-actions');
      rowActions.append(clipboardButton('row', 'copy', '复制行'), clipboardButton('row', 'paste', '粘贴行')); toolbar.append(rowActions);
      toolbar.append(button('删除参数表', () => {
        if (!global.confirm('删除参数表“' + table.name + '”？已链接的波形会保留引用，并提示参数表缺失。')) return;
        deleteTable(table);
      }, 'trash'));
    } else toolbar.append(button('新增参数表', addTable));
    const saveLibrary = button('保存波形库', async () => {
      saveLibrary.disabled = true;
      try { await flush(); await bridge.saveLibrary(); }
      catch (error) { status(error.message, true); }
      finally { saveLibrary.disabled = false; }
    });
    saveLibrary.classList.add('parameter-library-save'); toolbar.append(saveLibrary);
    workspace.append(toolbar);
    updateClipboardButtons();
    const state = element('div', 'parameter-status'); state.id = 'parameter-status'; state.setAttribute('role', 'status');
    state.textContent = failure || (dirty !== savedGeneration ? '正在保存参数目录...' : ''); workspace.append(state);
    if (!table) { workspace.append(element('p', 'parameter-empty', '未选中参数表')); return; }
    const scroller = element('div', 'parameter-grid-scroll'); const grid = element('table', 'parameter-grid');
    const head = element('thead'); const tr = element('tr');
    const filterInputs = {}, filterCount = element('span', 'parameter-filter-count');
    const clearFilters = button('清除筛选', () => {
      ['name', 'val'].forEach((field) => { rowFilters[field] = ''; filterInputs[field].value = ''; });
      applyFilters(); filterInputs.name.focus();
    }, 'close');
    ['变量名 name', '变量值 val', '变量说明 description'].forEach((label, index) => {
      const th = element('th'); th.scope = 'col'; th.append(element('span', 'parameter-column-label', label));
      if (index < 2) {
        const field = index === 0 ? 'name' : 'val'; const input = element('input', 'parameter-column-filter');
        input.type = 'search'; input.value = rowFilters[field]; input.spellcheck = false;
        input.placeholder = index === 0 ? '筛选变量名' : '筛选变量值'; input.setAttribute('aria-label', input.placeholder);
        input.addEventListener('input', () => { rowFilters[field] = input.value; applyFilters(); });
        filterInputs[field] = input; th.append(input);
      } else {
        const controls = element('div', 'parameter-filter-summary'); controls.append(filterCount, clearFilters); th.append(controls);
      }
      tr.append(th);
    });
    head.append(tr); grid.append(head);
    const body = element('tbody');
    const rowViews = [];
    const valueSource = { parameterTables: [table.id] };
    function refreshValues() {
      const context = { stack: [], values: new Map() };
      const names = parameterNameCounts(table.rows);
      rowViews.forEach((view) => view.updateValue(context, names));
    }
    let selectedLine = null;
    function selectRow(row, line) {
      if (selectedLine) { selectedLine.classList.remove('selected'); selectedLine.setAttribute('aria-selected', 'false'); }
      selectedRow = row; selectedLine = line;
      if (line) { line.classList.add('selected'); line.setAttribute('aria-selected', 'true'); }
      deleteRowButton.disabled = !row;
      deleteRowButton.title = row ? '删除第 ' + (table.rows.indexOf(row) + 1) + ' 行' : '删除选中行';
      updateClipboardButtons();
    }
    table.rows.forEach((row, index) => {
      const line = element('tr');
      const view = { row, line, resize: [] }; rowViews.push(view);
      line.addEventListener('click', () => selectRow(row, line));
      line.addEventListener('focusin', () => selectRow(row, line));
      line.setAttribute('aria-selected', 'false');
      if (selectedRow === row) selectRow(row, line);
      ['name', 'val', 'description'].forEach((field) => {
        const td = element('td'); const fieldBox = element('div', 'parameter-cell');
        const input = element(field === 'name' ? 'input' : 'textarea');
        if (field === 'name') {
          const handle = button('选中第 ' + (index + 1) + ' 行', () => selectRow(row, line));
          handle.className = 'parameter-row-select';
          const marker = element('span', 'parameter-row-error'); marker.hidden = true; marker.setAttribute('aria-hidden', 'true');
          marker.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="lucide">' + paths.close + '</svg>';
          handle.replaceChildren(marker, element('span', 'parameter-row-number', index + 1));
          view.rowError = marker; view.rowHandle = handle; view.nameInput = input;
          fieldBox.append(handle);
        }
        input.value = row[field] == null ? '' : String(row[field]); input.setAttribute('aria-label', '第 ' + (index + 1) + ' 行 ' + field);
        input.spellcheck = false; if (field !== 'name') input.rows = 1;
        const resize = () => { if (field !== 'name' && !line.hidden) { input.style.height = 'auto'; input.style.height = Math.min(220, input.scrollHeight) + 'px'; } };
        view.resize.push(resize);
        if (field === 'val') {
          fieldBox.classList.add('parameter-value-cell');
          const error = element('span', 'parameter-value-error'); error.hidden = true;
          error.id = 'parameter-value-error-' + index;
          input.setAttribute('aria-describedby', error.id);
          view.updateValue = (context, names) => {
            const result = resolveParameterRow(table, row, valueSource, context);
            view.valueResult = result;
            const nameError = parameterRowNameError(row, names);
            const rowError = [nameError, result.error].filter(Boolean).join('\n');
            view.rowError.hidden = !rowError;
            view.rowHandle.title = '选中第 ' + (index + 1) + ' 行' + (rowError ? '\n' + rowError : '');
            if (rowError) view.rowHandle.setAttribute('aria-description', rowError);
            else view.rowHandle.removeAttribute('aria-description');
            view.nameInput.setAttribute('aria-invalid', String(!!nameError)); view.nameInput.title = nameError;
            const valueChanged = document.activeElement !== input && input.value !== result.val;
            if (valueChanged) input.value = result.val;
            const isFormula = result.formula && !result.error;
            const numericValue = Number(result.val);
            input.classList.toggle('parameter-formula-value', isFormula);
            input.classList.toggle('parameter-negative-value', isFormula && Number.isFinite(numericValue) && numericValue < 0);
            input.setAttribute('aria-invalid', String(!!result.error));
            input.title = result.formula ? '公式：' + result.rawVal : '';
            error.hidden = !result.error; error.textContent = result.error;
            if (input.isConnected && valueChanged) resize();
          };
          input.addEventListener('focus', () => { input.value = row.val == null ? '' : String(row.val); resize(); });
          fieldBox.append(error);
        }
        input.addEventListener('input', () => {
          row[field] = input.value; resize(); changed(false);
          if (field === 'name' || field === 'val' || !row.name) refreshValues();
        });
        input.addEventListener('blur', () => {
          refreshValues();
          void flush().catch(() => {});
          const treeRow = Array.from($('parameter-tree').querySelectorAll('[data-table-id]')).find((item) => item.dataset.tableId === table.id);
          if (treeRow) treeRow.querySelector('.parameter-count').textContent = table.rows.filter((item) => item.name).length;
        });
        if (field === 'val') fieldBox.prepend(input);
        else fieldBox.append(input);
        td.append(fieldBox); line.append(td);
        requestAnimationFrame(resize);
      });
      body.append(line);
    });
    const emptyRow = element('tr'), emptyCell = element('td', 'parameter-empty'); emptyCell.colSpan = 3;
    emptyRow.append(emptyCell); body.append(emptyRow);
    function applyFilters() {
      const name = rowFilters.name.trim().toLowerCase(), val = rowFilters.val.trim().toLowerCase();
      let count = 0;
      rowViews.forEach((view) => {
        const visible = String(view.row.name ?? '').toLowerCase().includes(name)
          && (String(view.row.val ?? '').toLowerCase().includes(val) || String(view.valueResult && view.valueResult.val || '').toLowerCase().includes(val));
        const wasHidden = view.line.hidden; view.line.hidden = !visible;
        if (visible) count++;
        else if (selectedRow === view.row) selectRow(null, null);
        if (visible && wasHidden) requestAnimationFrame(() => view.resize.forEach((resize) => resize()));
      });
      emptyRow.hidden = count > 0; emptyCell.textContent = name || val ? '没有匹配的变量' : '暂无变量';
      filterCount.textContent = count + ' / ' + table.rows.length;
      clearFilters.disabled = !rowFilters.name && !rowFilters.val;
    }
    refreshValues(); applyFilters();
    grid.append(body); scroller.append(grid); workspace.append(scroller);
  }
  async function switchPage(page) {
    if (page === activePage) return;
    if (page === 'parameters') {
      try { await refresh(); } catch (error) { if (bridge) bridge.status(error.message); return; }
    }
    activePage = page;
    $('parameter-workspace').hidden = page !== 'parameters';
    $('parameter-directory-page').hidden = page !== 'parameters';
    $('wave-directory-page').hidden = page !== 'wave';
    document.querySelector('.app > main.main').hidden = page !== 'wave';
    $('wave-directory-tab').setAttribute('aria-selected', String(page === 'wave'));
    $('parameter-directory-tab').setAttribute('aria-selected', String(page === 'parameters'));
    document.body.classList.toggle('parameter-page-active', page === 'parameters');
    document.querySelectorAll('#sidebar > .menu-section').forEach((section, index) => {
      if (index === 0) return;
      if (page === 'parameters') { menuHiddenStates.set(section, section.hidden); section.hidden = true; }
      else if (menuHiddenStates.has(section)) { section.hidden = menuHiddenStates.get(section); menuHiddenStates.delete(section); }
    });
    if (page === 'wave' && bridge) bridge.changed();
    notifyParameterHistory();
  }
  async function openLinks(documentName, anchor) {
    if (modal) return;
    try { await refresh(); } catch (error) { bridge.status(error.message); return; }
    let source;
    try { source = await bridge.source(documentName); } catch (error) { bridge.status(error.message); return; }
    let order = linked(source).slice(), presetId = typeof source.parameterPreset === 'string' ? source.parameterPreset : '', dragging = '';
    // Older documents saved only the table order, so recover only an unambiguous preset.
    if (!Object.prototype.hasOwnProperty.call(source, 'parameterPreset')) {
      const matches = catalog.presets.filter((item) => Array.isArray(item.tableIds)
        && item.tableIds.length === order.length && item.tableIds.every((tableId, index) => tableId === order[index]));
      if (matches.length === 1) presetId = matches[0].id;
    }
    if (!catalog.presets.some((item) => item.id === presetId)) presetId = '';
    const overlay = element('div', 'modal-overlay parameter-modal');
    const dialog = element('div', 'modal-dialog parameter-link-dialog'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'parameter-link-title');
    modal = overlay;
    const header = element('div', 'modal-header'); const heading = element('h2', '', '链接参数表'); heading.id = 'parameter-link-title';
    function close() { overlay.remove(); modal = null; if (anchor && anchor.isConnected) anchor.focus({ preventScroll: true }); }
    header.append(heading, button('关闭', close, 'close')); dialog.append(header);
    const body = element('div', 'modal-body parameter-link-body');
    const presetBar = element('div', 'parameter-preset-bar'); const presets = element('select'); presets.setAttribute('aria-label', '加载预设');
    function presetOptions() { presets.replaceChildren(new Option('自定义参数表组合', '')); catalog.presets.forEach((item) => presets.add(new Option(item.name, item.id))); presets.value = presetId; }
    presetOptions(); presets.addEventListener('change', () => { presetId = presets.value; const item = catalog.presets.find((entry) => entry.id === presetId); if (item) order = (item.tableIds || []).slice(); renderLists(); });
    presetBar.append(element('label', '', '加载预设'), presets);
    const message = element('p', 'parameter-status'); message.setAttribute('role', 'status');
    async function presetAction(action) { try { action(); await flush(); presetOptions(); message.textContent = '预设已保存'; } catch (error) { message.textContent = error.message; } }
    presetBar.append(button('添加预设', () => presetAction(() => {
      const name = namePrompt('预设名称'); if (!name) return;
      const item = { id: id(), name, tableIds: order.slice() }; catalog.presets.push(item); presetId = item.id; changed(false);
    }), 'plus'));
    presetBar.append(button('修改预设名称', () => presetAction(() => {
      const item = catalog.presets.find((entry) => entry.id === presetId); if (!item) throw new Error('请先选择一个预设');
      const name = namePrompt('预设名称', item.name); if (!name) return; item.name = name; changed(false);
    }), 'edit'));
    presetBar.append(button('保存当前顺序到预设', () => presetAction(() => {
      const item = catalog.presets.find((entry) => entry.id === presetId); if (!item) throw new Error('请先选择一个预设');
      item.tableIds = order.slice(); changed(false);
    })));
    presetBar.append(button('删除预设', () => presetAction(() => {
      const item = catalog.presets.find((entry) => entry.id === presetId); if (!item) throw new Error('请先选择一个预设');
      if (!global.confirm('删除预设“' + item.name + '”？不会取消波形已加载的参数表。')) return;
      catalog.presets = catalog.presets.filter((entry) => entry !== item); presetId = ''; changed(false);
    }), 'trash'));
    body.append(presetBar);
    const columns = element('div', 'parameter-link-columns'); const available = element('section'); const selected = element('section');
    available.append(element('h3', '', '参数表')); selected.append(element('h3', '', '加载顺序 · 上方优先'));
    const search = element('input', 'parameter-search'); search.placeholder = '搜索参数表'; search.setAttribute('aria-label', '搜索参数表'); available.append(search);
    const choices = element('div', 'parameter-choices'), priority = element('div', 'parameter-priority'); available.append(choices); selected.append(priority); columns.append(available, selected); body.append(columns, message);
    function move(from, to) { if (to < 0 || to >= order.length || from === to) return; order.splice(to, 0, order.splice(from, 1)[0]); renderLists(); }
    function renderLists() {
      const focused = document.activeElement;
      const focusRow = focused && focused.closest('.parameter-priority-row');
      const focusId = focusRow ? focusRow.dataset.tableId : focused && focused.dataset.tableId;
      const focusLabel = focused && focused.getAttribute('aria-label');
      choices.replaceChildren(); priority.replaceChildren();
      catalog.tables.filter((table) => (folderPath(table.parentId) + table.name).toLowerCase().includes(search.value.toLowerCase())).forEach((table) => {
        const label = element('label', 'parameter-choice'); const check = element('input'); check.type = 'checkbox'; check.checked = order.includes(table.id); check.setAttribute('aria-label', table.name);
        check.dataset.tableId = table.id;
        check.addEventListener('change', () => { order = order.filter((entry) => entry !== table.id); if (check.checked) order.push(table.id); renderLists(); });
        const caption = element('span'); caption.append(element('strong', '', table.name), element('small', '', folderPath(table.parentId) || '根目录')); label.append(check, caption); choices.append(label);
      });
      if (!choices.childNodes.length) choices.append(element('p', 'parameter-empty', '没有匹配的参数表'));
      order.forEach((tableId, index) => {
        const table = catalog.tables.find((entry) => entry.id === tableId); const row = element('div', 'parameter-priority-row'); row.draggable = true; row.dataset.tableId = tableId;
        row.addEventListener('dragstart', (event) => { dragging = tableId; event.dataTransfer.setData('text/plain', tableId); event.dataTransfer.effectAllowed = 'move'; });
        row.addEventListener('dragover', (event) => { if (dragging) { event.preventDefault(); row.classList.add('drop-target'); } });
        row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
        row.addEventListener('drop', (event) => { event.preventDefault(); row.classList.remove('drop-target'); const from = order.indexOf(dragging); if (from >= 0) move(from, index); dragging = ''; });
        row.addEventListener('dragend', () => { dragging = ''; priority.querySelectorAll('.drop-target').forEach((node) => node.classList.remove('drop-target')); });
        const handle = button('拖动改变优先级', () => {}, 'grip'); handle.tabIndex = -1; const name = element('span', 'parameter-priority-name', (index + 1) + '. ' + (table ? table.name : '参数表已删除'));
        if (!table) name.classList.add('error');
        const up = button('提高优先级', () => move(index, index - 1), 'up'); up.disabled = index === 0;
        const down = button('降低优先级', () => move(index, index + 1), 'down'); down.disabled = index === order.length - 1;
        row.append(handle, name, up, down, button('取消加载', () => { order.splice(index, 1); renderLists(); }, 'close')); priority.append(row);
      });
      if (!order.length) priority.append(element('p', 'parameter-empty', '未加载参数表'));
      if (focusId) {
        const area = focusRow ? priority : choices;
        const nextRow = Array.from(area.querySelectorAll('[data-table-id]')).find((item) => item.dataset.tableId === focusId);
        const control = focusRow && nextRow
          ? Array.from(nextRow.querySelectorAll('button:not(:disabled)')).find((item) => item.getAttribute('aria-label') === focusLabel) || nextRow.querySelector('button:not(:disabled):not([tabindex="-1"])')
          : nextRow;
        (control || area.querySelector('input,button:not(:disabled):not([tabindex="-1"])') || presets).focus({ preventScroll: true });
      }
    }
    search.addEventListener('input', renderLists); renderLists(); dialog.append(body);
    const footer = element('div', 'modal-footer'); const apply = button('应用', async () => {
      apply.disabled = true;
      try { await flush(); await bridge.bind(documentName, order, presetId); close(); }
      catch (error) { message.textContent = error.message; }
      finally { apply.disabled = false; }
    }); apply.classList.add('modal-btn-primary'); footer.append(button('取消', close), apply); dialog.append(footer); overlay.append(dialog); document.body.append(overlay);
    let startedOutside = false;
    overlay.addEventListener('pointerdown', (event) => { startedOutside = event.target === overlay; });
    overlay.addEventListener('click', (event) => { if (startedOutside && event.target === overlay) close(); });
    overlay.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') {
        const controls = Array.from(dialog.querySelectorAll('button:not(:disabled),select,input')).filter((node) => node.tabIndex !== -1);
        if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls[controls.length - 1].focus(); }
        else if (!event.shiftKey && document.activeElement === controls[controls.length - 1]) { event.preventDefault(); controls[0].focus(); }
      }
    }); presets.focus();
  }
  function mount(api) {
    bridge = api;
    global.addEventListener('keydown', (event) => {
      if (activePage !== 'parameters' || modal || event.target.closest('.modal-overlay')) return;
      event.stopPropagation();
      if (event.key === 'Escape' && !event.isComposing && isTextInput(event.target)) {
        const line = event.target.closest('tbody tr');
        if (line) { event.preventDefault(); line.querySelector('.parameter-row-select').focus({ preventScroll: true }); }
      }
      if (event.isComposing || isTextInput(event.target)) return;
      const action = bridge.historyShortcut ? bridge.historyShortcut(event) : '';
      if (action === 'undo' || action === 'redo') { event.preventDefault(); applyParameterHistory(action === 'redo'); return; }
      if (event.key === 'Delete' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
          && event.target.closest('#parameter-workspace')) { event.preventDefault(); deleteSelectedRow(); }
    }, true);
    global.addEventListener('copy', onClipboardEvent, true);
    global.addEventListener('paste', onClipboardEvent, true);
    $('wave-directory-tab').addEventListener('click', () => { void switchPage('wave'); });
    $('parameter-directory-tab').addEventListener('click', () => { void switchPage('parameters'); });
    $('parameter-add-table').addEventListener('click', addTable);
    $('parameter-toggle-all').addEventListener('click', () => {
      const all = ['', ...catalog.directories.map((dir) => dir.id)]; const collapse = all.every((entry) => expanded.has(entry));
      all.forEach((entry) => collapse ? expanded.delete(entry) : expanded.add(entry));
      $('parameter-toggle-all').textContent = collapse ? '全部展开' : '全部收起'; renderTree();
    });
    document.querySelector('.app > main.main').id = 'wave-workspace';
    const tooltip = element('div', 'parameter-tooltip'); tooltip.hidden = true; tooltip.setAttribute('role', 'tooltip'); document.body.append(tooltip);
    let tooltipTimer = null;
    document.addEventListener('mouseover', (event) => {
      clearTimeout(tooltipTimer);
      if (tooltip.contains(event.target)) return;
      let hint = ''; const target = event.target && event.target.closest('[data-parameter-hint], input, textarea, .cm-parameter');
      if (target) {
        hint = target.dataset.parameterHint || '';
        const value = target.value || target.textContent || '';
        if (!hint && value.includes('$') && !target.closest('#parameter-workspace, .parameter-modal')) {
          try { hint = details(value, bridge.currentSource()); } catch (_) { /* Invalid JSON stays editable. */ }
        }
      }
      if (!hint) { tooltipTimer = setTimeout(() => { tooltip.hidden = true; }, 120); return; }
      tooltip.hidden = false; tooltip.textContent = hint;
      if (hint) {
        tooltip.style.left = '8px'; tooltip.style.top = '8px';
        const bounds = tooltip.getBoundingClientRect();
        tooltip.style.left = Math.max(8, Math.min(event.clientX + 12, innerWidth - bounds.width - 8)) + 'px';
        tooltip.style.top = Math.max(8, Math.min(event.clientY + 18, innerHeight - bounds.height - 8)) + 'px';
      }
    });
    document.addEventListener('pointerdown', (event) => {
      if (!tooltip.contains(event.target)) { clearTimeout(tooltipTimer); tooltip.hidden = true; }
    }, true);
    global.addEventListener('beforeunload', (event) => { if (dirty !== savedGeneration) { event.preventDefault(); event.returnValue = ''; } });
    try {
      channel = new BroadcastChannel('vwd-parameters:' + global.location.pathname);
      channel.onmessage = (event) => {
        const data = event.data;
        if (!data || data.libraryId !== libraryId || dirty !== savedGeneration || Number(data.catalog && data.catalog.revision) <= catalog.revision) return;
        if (activePage === 'parameters' && $('parameter-workspace').contains(document.activeElement)) return;
        setCatalog(data.catalog, libraryId);
      };
      global.addEventListener('pagehide', () => channel.close(), { once: true });
    } catch (_) { /* Explicit refresh on opening either parameter surface remains available. */ }
    renderTree(); renderTable();
  }
  global.VisualWaveDromParameters = { mount, setCatalog, getCatalog: () => clone(catalog), resolve, text, details, decorate, resolveName,
    openLinks, flush, refresh, page: () => activePage, pending: () => dirty !== savedGeneration,
    historyState: parameterHistoryState, undo: () => applyParameterHistory(false), redo: () => applyParameterHistory(true) };
})(window);

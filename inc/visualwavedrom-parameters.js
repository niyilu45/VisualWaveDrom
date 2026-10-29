(function (global) {
  'use strict';
  const tokenPattern = /\{((?=[^{}]*\$)\s*(?:[$+\-.\d(]|(?:max|min)\s*\()[^{}]*)\}/g;
  const parameterValuePattern = /\{(\s*(?:[$+\-.\d(]|(?:max|min)\s*\()[^{}]*)\}/g;
  const dataTokenPattern = /(?:\{(?=[^{}]*\$)\s*(?:[$+\-.\d(]|(?:max|min)\s*\()[^{}]*\}|\S)+/g;
  const numericPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const matrix = global.VWDParameterMatrix;
  const empty = () => ({ revision: 0, directories: [], tables: [], presets: [] });
  let catalog = empty(), libraryId = '', bridge = null, generation = 0;
  let cache = new WeakMap(), calculationCache = new WeakMap(), selectedFolder = '', selectedTable = '', activePage = 'wave';
  const textDecorations = new WeakMap();
  const referenceDocuments = new Map();
  let referenceRefresh = null, referenceScan = 0, referenceHighlight = null;
  let referenceChannel = null;
  const referenceClientId = id(), referenceRequests = new Map();
  let referenceWindowFamily = referenceClientId, lastReferenceJumpId = '';
  let dirty = 0, savedGeneration = 0, timer = null, saving = null, failure = '';
  let modal = null, channel = null;
  let comparisonCommit = false;
  let tableViewId = '', selectedRow = null;
  let standaloneTableId = '', standaloneLoading = false, standaloneError = '';
  const rowFilters = { name: '', val: '' };
  let matrixTables = [], matrixGeneration = -1;
  const clipboardKind = 'VisualWaveDromParametersClipboard';
  let parameterClipboard = null, clipboardRequest = 0;
  let parameterUndoStack = [], parameterRedoStack = [];
  let activeCellEdit = null;
  let matrixDispose = null;
  let pendingCatalog = null, syncedCatalog = null;
  let catalogLoadError = '', rejectedCatalog = null, catalogWarnings = [];
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
    swap: '<path d="M3 7h18l-4-4M21 17H3l4 4"/>',
    left: '<path d="m15 18-6-6 6-6"/>', right: '<path d="m9 18 6-6-6-6"/>',
    external: '<path d="M15 3h6v6M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
    undo: '<path d="M3 10h11a7 7 0 0 1 0 14M3 10l6-6M3 10l6 6" transform="translate(0 -3)"/>',
    redo: '<path d="M21 10H10a7 7 0 0 0 0 14M21 10l-6-6M21 10l-6 6" transform="translate(0 -3)"/>',
    trash: '<path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6"/>',
    edit: '<path d="m16 3 5 5-12 12-6 1 1-6ZM14 5l5 5"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    paste: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
    up: '<path d="m6 14 6-6 6 6"/>', down: '<path d="m6 10 6 6 6-6"/>',
    grip: '<circle cx="9" cy="5" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="19" r="1"/>',
    maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3"/>',
    link: '<path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m4 2 1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"/>'
  };
  function button(label, action, icon) {
    const node = element('button', icon ? 'parameter-icon' : 'modal-btn', icon ? undefined : label);
    node.type = 'button'; node.title = label; node.setAttribute('aria-label', label);
    if (icon) node.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" class="lucide">' + paths[icon] + '</svg>';
    node.addEventListener('click', action);
    return node;
  }
  function normalize(value, warnings) {
    const next = Object.assign(empty(), value || {});
    ['directories', 'tables', 'presets'].forEach((key) => {
      next[key] = Array.isArray(next[key]) ? clone(next[key]).filter((item) => item && typeof item.id === 'string') : [];
    });
    next.tables.forEach((table) => { table.rows = Array.isArray(table.rows) ? table.rows : []; });
    matrix.normalize(next.tables, warnings);
    next.revision = Number(next.revision) || 0;
    return next;
  }
  function id() { return 'param-' + (global.crypto.randomUUID ? global.crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)); }
  function linked(source) { return source && Array.isArray(source.parameterTables) ? source.parameterTables : []; }
  function effectiveTables() {
    if (catalogLoadError) return [];
    if (matrixGeneration !== generation) {
      matrix.normalize(catalog.tables); matrixTables = matrix.all(catalog.tables); matrixGeneration = generation;
    }
    return matrixTables;
  }
  function effectiveTable(tableId) { return effectiveTables().find((table) => table.id === tableId); }
  function parseExpression(raw) {
    const separator = raw.indexOf(':');
    const expression = (separator < 0 ? raw : raw.slice(0, separator)).trim();
    const options = separator < 0 ? [] : raw.slice(separator + 1).split(',').map((option) => option.trim());
    const unsupported = options.filter((option) => option !== 'noTrans');
    const error = !expression ? '参数表达式不能为空'
      : unsupported.length ? '不支持的表达式配置：' + unsupported.map((option) => option || '(空配置)').join(', ') : '';
    return { expression, options, noTrans: options.includes('noTrans'), error };
  }
  function referenceNames(raw) {
    const names = new Set();
    if (typeof raw !== 'string' || !raw.includes('$')) return names;
    for (const match of raw.matchAll(tokenPattern)) {
      for (const variable of parseExpression(match[1]).expression.matchAll(/\$[^{}\s$(),]+/g)) names.add(variable[0].slice(1));
    }
    return names;
  }
  function referenceKey(tableId, name) { return JSON.stringify([tableId, name]); }
  function referenceKeys(names, source) {
    const keys = [];
    for (const name of names) {
      const tableId = linked(source).find((tableId) => {
        const table = effectiveTable(tableId);
        return table && table.rows.some((row) => String(row.name || '') === name);
      });
      if (tableId) {
        keys.push(referenceKey(tableId, name));
        const owner = matrix.owner(catalog.tables, tableId);
        if (owner && owner.id !== tableId) keys.push(referenceKey(owner.id, name));
        const row = effectiveTable(tableId).rows.find((item) => String(item.name || '') === name);
        if (row && row.referenceSource) {
          keys.push(referenceKey(row.referenceSource.tableId, name));
          const original = matrix.owner(catalog.tables, row.referenceSource.tableId);
          if (original) keys.push(referenceKey(original.id, name));
        }
      }
    }
    return keys;
  }
  function matchesReference(raw, source, tableId, name) {
    return referenceKeys(referenceNames(raw), source).includes(referenceKey(tableId, name));
  }
  async function collectReferenceNames(source) {
    const names = new Set();
    let work = 0;
    function add(value) {
      if (typeof value === 'string') referenceNames(value).forEach((name) => names.add(name));
      else if (Array.isArray(value)) value.forEach(add);
    }
    async function rows(items) {
      for (const row of items || []) {
        if (Array.isArray(row)) { add(row[0]); await rows(row.slice(1)); }
        else if (row && typeof row === 'object') {
          add(row.name);
          const values = Array.isArray(row.data) ? row.data : [row.data];
          for (const value of values) {
            add(value);
            if (++work % 4096 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }
      }
    }
    await rows(source.signal);
    [source.title, source.head && source.head.text, source.foot && source.foot.text, source.description].forEach(add);
    (source.edge || []).forEach((edge) => add(String(edge).replace(/^\S+\s*/, '').replace(/^:\s*/, '')));
    return names;
  }
  function applyReferenceHighlight(node) {
    const card = node.closest('.wave-document-card');
    const hit = !!(referenceHighlight && card && card.dataset.documentName === referenceHighlight.waveId
      && (node.namespaceURI !== 'http://www.w3.org/2000/svg' || node.localName === 'text')
      && JSON.parse(node.dataset.parameterReferences || '[]').includes(referenceHighlight.key));
    node.classList.toggle('parameter-reference-highlight', hit);
  }
  function clearReferenceHighlight() {
    referenceHighlight = null;
    document.querySelectorAll('.parameter-reference-highlight').forEach((node) => node.classList.remove('parameter-reference-highlight'));
  }
  function referenceError(error) {
    if (activePage === 'wave') bridge.status(error.message);
    else status(error.message, true);
  }
  async function revealReference(target) {
    if (target.libraryId !== libraryId) throw new Error('波形库已切换，请重新选择参数');
    clearReferenceHighlight();
    referenceHighlight = { waveId: target.waveId, key: referenceKey(target.tableId, target.name) };
    try { await switchPage('wave'); await bridge.revealReference(target); }
    catch (error) { clearReferenceHighlight(); throw error; }
    document.querySelectorAll('[data-parameter-references]').forEach(applyReferenceHighlight);
    const first = document.querySelector('.parameter-reference-highlight');
    if (first) first.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function sendReferenceMessage(message) {
    if (referenceChannel) referenceChannel.postMessage(Object.assign({ libraryId, clientId: referenceClientId }, message));
  }
  function referenceWindowInfo() {
    return { clientId: referenceClientId, libraryId, windowName: global.name, family: referenceWindowFamily };
  }
  function activateReferenceWindow(candidate) {
    if (candidate.clientId === referenceClientId) return true;
    // Named targets can only be reused in a related browsing-context group.
    // Never open a second copy of an independently opened tab just to focus it.
    if (!candidate.windowName || candidate.family !== referenceWindowFamily) return false;
    let opened;
    try {
      opened = global.open('', candidate.windowName);
      if (!opened) return false;
      const api = opened.VisualWaveDromParameters;
      const info = api && api.referenceWindowInfo();
      if (!info || info.clientId !== candidate.clientId || info.libraryId !== libraryId) {
        if (opened.location.href === 'about:blank') opened.close();
        return false;
      }
      opened.focus();
      return true;
    } catch (_) { return false; /* The tab may have closed or navigated away. */ }
  }
  async function jumpToReference(document, tableId, name) {
    const target = { libraryId, waveId: document.name, tableId, name };
    // Probe first, then command exactly one matching window. Other single-wave windows never navigate.
    const requestId = id(), replies = [];
    lastReferenceJumpId = requestId;
    const localRank = bridge.referenceTargetRank(target.waveId);
    if (localRank >= 0) replies.push(Object.assign(referenceWindowInfo(), { rank: localRank, visible: true }));
    referenceRequests.set(requestId, (data) => { if (data.type === 'candidate') replies.push(data); });
    sendReferenceMessage({ type: 'probe', requestId, target });
    if (referenceChannel) await new Promise((resolve) => setTimeout(resolve, 350));
    referenceRequests.delete(requestId);
    if (lastReferenceJumpId !== requestId || target.libraryId !== libraryId) return;
    replies.sort((a, b) => a.rank - b.rank
      || Number(a.clientId === referenceClientId) - Number(b.clientId === referenceClientId)
      || Number(b.visible) - Number(a.visible) || a.clientId.localeCompare(b.clientId));
    for (const candidate of replies) {
      // Focus from the clicked page before saving can consume the user-activation window.
      activateReferenceWindow(candidate);
      await flush();
      if (lastReferenceJumpId !== requestId || target.libraryId !== libraryId) return;
      if (candidate.clientId === referenceClientId) return revealReference(target);
      const accepted = await new Promise((resolve) => {
        const timeout = setTimeout(() => { referenceRequests.delete(requestId); resolve(false); }, 900);
        referenceRequests.set(requestId, (data) => {
          if (data.type !== 'accepted' || data.clientId !== candidate.clientId) return;
          clearTimeout(timeout); referenceRequests.delete(requestId); resolve(true);
        });
        sendReferenceMessage({ type: 'reveal', requestId, recipient: candidate.clientId, target, title: document.title });
      });
      if (accepted) { status('正在定位已打开的波形图：' + document.title); return; }
    }
    await flush();
    if (lastReferenceJumpId !== requestId || target.libraryId !== libraryId) return;
    if (standaloneTableId) await bridge.revealReference(target);
    else await revealReference(target);
  }
  function chooseReference(documents, tableId, name, anchor) {
    if (modal) return;
    const overlay = element('div', 'modal-overlay parameter-modal');
    const dialog = element('div', 'modal-dialog parameter-reference-dialog');
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'parameter-reference-title');
    const header = element('div', 'modal-header'), title = element('h2', '', '跳转到引用 $' + name + ' 的时序图'); title.id = 'parameter-reference-title';
    const close = () => { overlay.remove(); modal = null; if (anchor.isConnected) anchor.focus({ preventScroll: true }); };
    header.append(title, button('关闭', close, 'close'));
    const body = element('div', 'modal-body parameter-reference-choices');
    documents.forEach((document) => {
      const choice = button(document.title, () => {
        close(); void jumpToReference(document, tableId, name).catch(referenceError);
      });
      choice.className = 'parameter-reference-choice'; choice.append(element('small', '', document.location || document.name));
      body.append(choice);
    });
    let outside = false;
    overlay.addEventListener('pointerdown', (event) => { outside = event.target === overlay; });
    overlay.addEventListener('click', (event) => { if (outside && event.target === overlay) close(); });
    overlay.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') {
        const controls = Array.from(dialog.querySelectorAll('button'));
        if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls[controls.length - 1].focus(); }
        else if (!event.shiftKey && document.activeElement === controls[controls.length - 1]) { event.preventDefault(); controls[0].focus(); }
      }
    });
    clipboardRequest++; dialog.append(header, body); overlay.append(dialog); document.body.append(overlay); modal = overlay;
    body.querySelector('button').focus();
  }
  async function updateReferenceButtons(table, views, workspace) {
    if (!bridge || !bridge.referenceDocuments || !libraryId || activePage !== 'parameters') return;
    const sequence = ++referenceScan, identity = libraryId;
    views.forEach((view) => { view.jump.disabled = true; view.jump.title = '正在查找引用...'; });
    const found = new Map();
    let skipped = 0;
    const current = () => sequence === referenceScan && identity === libraryId && workspace.contains(views[0] && views[0].line);
    try {
      const documents = await bridge.referenceDocuments();
      for (const document of documents) {
        if (!current()) return;
        if (!document.content && Array.isArray(document.parameterTables)
          && !document.parameterTables.some((key) => matrix.owner(catalog.tables, key) === table)) continue;
        const key = identity + ':' + document.name;
        const stamp = document.content || JSON.stringify([document.revision, document.savedAt, document.contentLength]);
        let cached = referenceDocuments.get(key);
        if (!cached || cached.stamp !== stamp) {
          try {
            const source = document.content ? JSON.parse(document.content) : await document.read();
            cached = { stamp, names: await collectReferenceNames(source), parameterTables: linked(source).slice(), title: source.title || source.head && source.head.text || document.title };
            if (!current()) return;
            referenceDocuments.set(key, cached);
          } catch (_) { skipped++; continue; /* An invalid diagram must not block other references. */ }
        }
        const item = { name: document.name, title: text(String(cached.title || document.name), cached), location: document.location };
        referenceKeys(cached.names, cached).forEach((key) => {
          if (!found.has(key)) found.set(key, []);
          found.get(key).push(item);
        });
      }
      if (!current()) return;
      views.forEach((view) => {
        const name = String(view.row.name || '');
        view.references = table.rows.find((row) => String(row.name || '') === name) === view.row
          ? found.get(referenceKey(table.id, name)) || [] : [];
        view.jump.disabled = !view.references.length;
        view.jump.title = view.references.length ? '跳转到引用此参数的时序图（' + view.references.length + ' 张）' : '没有时序图引用此参数';
        view.jump.setAttribute('aria-label', view.jump.title + '：' + String(view.row.name || ''));
      });
      if (skipped) status('已跳过 ' + skipped + ' 张无法读取或 JSON 无效的时序图；可正常跳转其余引用', true);
    } catch (error) {
      if (!current()) return;
      views.forEach((view) => { view.jump.title = '引用查找失败：' + error.message; });
      status('引用查找失败：' + error.message, true);
    }
  }
  function resolveParameterRow(table, row, source, state) {
    const context = state || { stack: [], values: new Map() };
    if (context.values.has(row)) return context.values.get(row);
    const name = String(row.name || '');
    const rawVal = row.val == null ? '' : String(row.val);
    const result = { name, table: table.name, tableId: table.id, val: rawVal, rawVal, description: String(row.description || ''), formula: false, error: '' };
    if (row.referenceSource) {
      result.inherited = true; result.sourceTableId = row.referenceSource.tableId; result.sourceTable = row.referenceSource.name;
    }
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
      const table = state && state.tables ? state.tables.get(tableId) : effectiveTable(tableId);
      let row;
      if (table && state) {
        if (!state.nameIndexes) state.nameIndexes = new Map();
        if (!state.nameIndexes.has(table)) {
          const index = new Map(); table.rows.forEach((item) => { const key = String(item.name || ''); if (!index.has(key)) index.set(key, item); });
          state.nameIndexes.set(table, index);
        }
        row = state.nameIndexes.get(table).get(name);
      } else row = table && table.rows.find((item) => String(item.name || '') === name);
      if (row) return resolveParameterRow(table, row, source, state);
    }
    return null;
  }
  function text(value, source, options) {
    if (typeof value !== 'string' || !value.includes('$')) return value;
    return value.replace(tokenPattern, (raw, expression) => {
      const parsed = parseExpression(expression);
      if (parsed.noTrans && !parsed.error && (!options || options.mode !== 'calculate'))
        return parsed.expression.replace(/[$\s]/g, '');
      const result = evaluate(expression, source);
      if (options && options.onExpression) options.onExpression({ raw, expression: parsed.expression,
        options: parsed.options, value: result.value, error: result.error || '' });
      return result.error ? raw : result.value;
    });
  }
  function evaluate(expression, source, state) {
    const parsed = parseExpression(expression);
    if (parsed.error) return { error: parsed.error, variables: [] };
    expression = parsed.expression;
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
      const parsed = parseExpression(match[1]);
      const summary = result.error ? '\n' + result.error : '\n' + (parsed.noTrans ? '时延计算结果：' : '结果：') + result.value;
      return match[0] + (parsed.noTrans && !parsed.error ? '\n显示：' + parsed.expression.replace(/[$\s]/g, '') + '（noTrans）' : '')
        + summary + result.variables.map((item) => '\n\n$' + item.name + '\n参数表：' + item.table
        + (item.sourceTable ? '\n定义来源：' + item.sourceTable : '')
        + '\n值：' + item.val + (item.formula ? '\n公式：' + item.rawVal : '') + '\n说明：' + (item.description || '无')).join('');
    }).filter(Boolean).join('\n\n');
  }
  function diagnostics(source) {
    const expressions = [];
    let scanned = 0, rowIndex = 0;
    function add(raw, path) {
      if (++scanned > 20000 || expressions.length >= 32 || typeof raw !== 'string' || !raw.includes('$')) return;
      for (const match of raw.matchAll(tokenPattern)) {
        const result = evaluate(match[1], source);
        expressions.push({ path, raw: match[0].slice(0, 240), display: String(text(match[0], source)).slice(0, 240),
          value: result.value, error: result.error || '', variables: result.variables.map((variable) => ({
            name: variable.name, tableId: variable.tableId, table: variable.table, value: String(variable.val).slice(0, 160)
          })) });
        if (expressions.length >= 32) break;
      }
    }
    function rows(items) {
      for (const item of items || []) {
        if (scanned > 20000 || expressions.length >= 32) break;
        if (Array.isArray(item)) { add(item[0], 'group'); rows(item.slice(1)); }
        else if (item && typeof item === 'object') {
          const path = 'signal[' + rowIndex++ + ']'; add(item.name, path + '.name');
          if (Array.isArray(item.data)) {
            for (let index = 0; index < item.data.length && scanned <= 20000 && expressions.length < 32; index++) add(item.data[index], path + '.data[' + index + ']');
          } else add(item.data, path + '.data');
        }
      }
    }
    if (source) {
      ['title', 'description'].forEach((key) => add(source[key], key));
      ['head', 'foot'].forEach((key) => add(source[key] && source[key].text, key + '.text'));
      (source.edge || []).forEach((edge, index) => add(edge, 'edge[' + index + ']'));
      rows(source.signal);
    }
    return { build: '20261021-parameter-diagnostics-v1', libraryId, generation, revision: catalog.revision,
      pending: pendingParameterChanges(), tableCount: catalog.tables.length, loadError: catalogLoadError, compatibilityRepairs: catalogWarnings.slice(0, 16),
      links: linked(source).map((tableId) => { const table = effectiveTable(tableId);
        return { tableId, found: !!table, name: table && table.name, rowCount: table && table.rows.length }; }), expressions };
  }
  function resolve(source, options) {
    if (!source || typeof source !== 'object') return source;
    const calculate = options && options.mode === 'calculate', resolvedCache = calculate ? calculationCache : cache;
    const conversions = [], indices = new WeakMap();
    const publish = (entries) => { if (options && Array.isArray(options.conversions)) entries.forEach((entry) => options.conversions.push(entry)); };
    const old = resolvedCache.get(source);
    if (old && old.generation === generation) { publish(old.conversions); return old.value; }
    if (calculate) {
      let index = 0;
      const indexRows = (items) => (items || []).forEach((item) => {
        if (Array.isArray(item)) indexRows(item.slice(typeof item[0] === 'string' ? 1 : 0));
        else if (item && typeof item === 'object') indices.set(item, index++);
      });
      indexRows(source.signal);
    }
    function resolveText(raw, path, row) {
      if (!calculate) return text(raw, source);
      const expressions = [];
      const value = text(raw, source, { mode: 'calculate', onExpression: (entry) => expressions.push(entry) });
      if (expressions.length) conversions.push({ row, path, raw, value, expressions });
      return value;
    }
    function visit(value, path, row) {
      if (typeof value === 'string') return resolveText(value, path, row);
      if (!value || typeof value !== 'object') return value;
      if (indices.has(value)) row = indices.get(value);
      let next = value;
      Object.keys(value).forEach((key) => {
        if (key === 'parameterTables') return;
        const raw = value[key];
        const result = key === 'data' && typeof raw === 'string' && raw.includes('$') && raw.match(tokenPattern)
          ? (raw.match(dataTokenPattern) || []).map((label, index) => resolveText(label, path.concat(key, index), row))
          : visit(raw, calculate ? path.concat(key) : path, row);
        if (result !== value[key]) {
          if (next === value) next = Array.isArray(value) ? value.slice() : Object.assign({}, value);
          next[key] = result;
        }
      });
      return next;
    }
    const value = visit(source, [], undefined);
    const entry = { generation, value, conversions };
    resolvedCache.set(source, entry);
    // Do not expand nested placeholders a second time when a render window
    // passes an already-resolved document through the rendering pipeline.
    if (value !== source) resolvedCache.set(value, entry);
    publish(conversions);
    return value;
  }
  function decorateText(node, raw, source, options) {
    if (!node || node.matches('input, textarea, .editing') || node.querySelector('textarea, input')) return;
    applyReferenceHighlight(node);
    const wholeLabel = !!(options && options.wholeLabel);
    const content = node.textContent, previous = textDecorations.get(node);
    if (previous && previous.raw === raw && previous.source === source && previous.content === content && previous.generation === generation
      && previous.wholeLabel === wholeLabel
      && previous.spans.every((span) => node.contains(span))) return;
    node.dataset.parameterHint = details(raw, source);
    node.dataset.parameterReferences = JSON.stringify(referenceKeys(referenceNames(raw), source));
    applyReferenceHighlight(node);
    node.querySelectorAll('[data-parameter-negative]').forEach((span) => span.replaceWith(...span.childNodes));
    const ranges = [], spans = [];
    let end = 0, rendered = '';
    const value = typeof raw === 'string' ? raw : '';
    for (const match of value.matchAll(tokenPattern)) {
      rendered += value.slice(end, match.index);
      const result = evaluate(match[1], source);
      const parsed = parseExpression(match[1]);
      const symbolic = parsed.noTrans && !parsed.error;
      const replacement = symbolic ? parsed.expression.replace(/[$\s]/g, '') : result.error ? match[0] : result.value;
      if (!symbolic && !result.error && numericPattern.test(replacement.trim()) && Number.isFinite(Number(replacement)) && Number(replacement) < 0) {
        ranges.push({ start: rendered.length, end: rendered.length + replacement.length });
      }
      rendered += replacement;
      end = match.index + match[0].length;
    }
    rendered += value.slice(end);
    const offset = content.endsWith(rendered) ? content.length - rendered.length : -1;
    if (ranges.length && offset >= 0) {
      if (wholeLabel) ranges.splice(0, ranges.length, { start: 0, end: rendered.length });
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), texts = [];
      while (walker.nextNode()) texts.push(walker.currentNode);
      let position = 0;
      texts.forEach((textNode) => {
        const text = textNode.nodeValue, start = position; position += text.length;
        const matches = ranges.map((range) => ({ start: Math.max(0, range.start + offset - start), end: Math.min(text.length, range.end + offset - start) }))
          .filter((range) => range.end > range.start);
        if (!matches.length) return;
        const fragment = document.createDocumentFragment();
        let cursor = 0;
        matches.forEach((range) => {
          fragment.append(document.createTextNode(text.slice(cursor, range.start)));
          const svg = node.namespaceURI === 'http://www.w3.org/2000/svg';
          const span = svg ? document.createElementNS(node.namespaceURI, 'tspan') : document.createElement('span');
          span.dataset.parameterNegative = '1';
          span.style.color = '#c62828';
          if (svg) span.style.fill = '#c62828';
          span.textContent = text.slice(range.start, range.end);
          fragment.append(span); spans.push(span); cursor = range.end;
        });
        fragment.append(document.createTextNode(text.slice(cursor)));
        textNode.replaceWith(fragment);
      });
    }
    textDecorations.set(node, { raw, source, content, generation, spans, wholeLabel });
  }
  function decorate(host, source, renderWindow) {
    if (!host || !source || !linked(source).length) return;
    const bindings = new Map(), signals = [], groups = [];
    function bind(node, raw, options) {
      if (node && !node.hasAttribute('data-parameter-hint')) decorateText(node, raw, source, options);
    }
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
        if (Array.isArray(row)) { add(row[0]); rows(row.slice(1)); groups.push(row[0]); }
        else if (row && typeof row === 'object') {
          signals.push(row);
          add(row.name);
          (Array.isArray(row.data) ? row.data : typeof row.data === 'string' ? row.data.match(dataTokenPattern) || [] : []).forEach(add);
        }
      });
    }
    rows(source.signal); add(source.title); add(source.head && source.head.text); add(source.foot && source.foot.text); add(source.description);
    (source.edge || []).forEach((edge) => add(String(edge).replace(/^\S+\s*/, '').replace(/^:\s*/, '')));
    // Use row identity in previews so a literal value is not mistaken for an equal parameter result.
    host.querySelectorAll('g[id^="wavelane_"]').forEach((lane) => {
      const match = /^wavelane_(\d+)_/.exec(lane.id), row = match && signals[Number(match[1])];
      if (!row) return;
      const name = lane.querySelector('text.info');
      bind(name, row.name);
      const data = Array.isArray(row.data) ? row.data : typeof row.data === 'string' ? row.data.match(dataTokenPattern) || [] : [];
      lane.querySelectorAll('[id^="wavelane_draw_"] > text').forEach((node, index) => {
        const context = renderWindow && renderWindow.rows && renderWindow.rows[Number(match[1])];
        const fullIndex = context && context.dataIndices ? context.dataIndices[index] : index;
        bind(node, data[fullIndex]);
      });
    });
    host.querySelectorAll('[id^="gmarks_"] > text').forEach((node) => {
      const field = Number(node.getAttribute('y')) < 0 ? 'head' : 'foot';
      bind(node, source[field] && source[field].text || (field === 'head' ? source.title : ''));
    });
    host.querySelectorAll('path[id^="group_"]').forEach((path) => {
      const match = /^group_(\d+)_/.exec(path.id), label = path.nextElementSibling;
      if (match && label && label.localName === 'g') bind(label.querySelector('text'), groups[Number(match[1])]);
    });
    host.querySelectorAll('[id^="wavearcs_"]').forEach((group) => {
      const edges = new Map();
      const sourceEdges = source.edge || [];
      const visibleEdges = renderWindow && renderWindow.edgeIndexes ? renderWindow.edgeIndexes.map((index) => sourceEdges[index]) : sourceEdges;
      visibleEdges.forEach((edge) => {
        if (typeof edge !== 'string') return;
        const value = edge.trim(), token = value.split(/\s+/, 1)[0];
        const id = 'gmark_' + token[0] + '_' + token.slice(-1);
        if (!edges.has(id)) edges.set(id, []);
        edges.get(id).push(value.slice(token.length).trim().replace(/^:\s*/, ''));
      });
      Array.from(group.children).forEach((path) => {
        const matches = edges.get(path.id);
        if (!matches || !matches.length) return;
        const raw = matches.shift(), label = path.nextElementSibling;
        if (raw && label && label.localName === 'g') bind(label.querySelector('text'), raw, { wholeLabel: true });
      });
    });
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
    if (type === 'table') payload.table = table;
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
      const source = clone(payload.table); source.id = source.id || 'clipboard'; matrix.normalize([source]);
      const table = matrix.cloneTable(source, id);
      table.name = uniqueCopyName(payload.table.name, new Set(catalog.tables.map((item) => item.name)), true); table.parentId = selectedFolder;
      insertTable(table); return;
    }
    const table = catalog.tables.find((item) => item.id === selectedTable);
    if (!table) throw new Error('请先选中目标参数表');
    const row = clone(payload.row); row.id = id();
    if (row.name) row.name = uniqueCopyName(row.name, new Set(table.rows.map((item) => item.name)), false);
    const index = table.rows.indexOf(selectedRow);
    const rows = table.rows.slice(); rows.splice(index < 0 ? rows.length : index + 1, 0, row);
    selectedRow = row; rowFilters.name = ''; rowFilters.val = '';
    const patches = [{ target: table, field: 'rows', value: rows }];
    patchMatrix(table, patches, true);
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
    if (catalogLoadError) return null;
    if (activePage !== 'parameters' || modal || !target || !target.closest || target.closest('.modal-overlay')) return '';
    if (target.closest('#parameter-directory-page')) return 'table';
    if (target.closest('#parameter-workspace')) return 'row';
    return '';
  }
  function isTextInput(target) { return !!(target && target.closest && target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')); }
  function parameterHistoryState() { return { canUndo: !!activeCellEdit || parameterUndoStack.length > 0, canRedo: !activeCellEdit && parameterRedoStack.length > 0 }; }
  function notifyParameterHistory() {
    const state = parameterHistoryState();
    const undo = $('parameter-single-undo'), redo = $('parameter-single-redo');
    if (undo) undo.disabled = !state.canUndo;
    if (redo) redo.disabled = !state.canRedo;
    if (bridge && bridge.historyChanged) bridge.historyChanged();
  }
  function recordParameterHistory(entry) {
    commitParameterCell();
    parameterUndoStack.push(entry);
    if (parameterUndoStack.length > 50) parameterUndoStack.shift();
    parameterRedoStack = [];
  }
  function editParameterCell(table, row, field, input, refresh) {
    if (activeCellEdit && activeCellEdit.input !== input) commitParameterCell();
    const wasEditing = !!activeCellEdit;
    // Keep typing local to this control; no catalog writes, evaluation or wave invalidation.
    activeCellEdit = String(row[field] ?? '') === input.value ? null : { table, row, field, input, refresh };
    if (wasEditing !== !!activeCellEdit) notifyParameterHistory();
  }
  function commitParameterCell() {
    const edit = activeCellEdit;
    if (!edit) return false;
    activeCellEdit = null;
    if (edit.commit) { edit.commit(); notifyParameterHistory(); return true; }
    const { table, row, field, input, refresh } = edit;
    if (!catalog.tables.includes(table) || !table.rows.includes(row)
      || String(row[field] ?? '') === input.value) return false;
    recordParameterHistory({ kind: 'row-edit', tableId: table.id, row, field,
      before: row[field], beforePresent: Object.prototype.hasOwnProperty.call(row, field), after: input.value });
    row[field] = input.value; changed(false);
    refresh();
    return true;
  }
  function patchMatrix(table, patches, render) {
    commitParameterCell();
    const changes = patches.map((patch) => Object.assign({}, patch, {
      before: patch.target[patch.field], beforePresent: matrix.own(patch.target, patch.field), present: patch.present !== false
    }));
    if (!changes.length) return;
    recordParameterHistory({ kind: 'matrix-patch', tableId: table.id, changes });
    changes.forEach((patch) => { if (patch.present) patch.target[patch.field] = patch.value; else delete patch.target[patch.field]; });
    const scroller = $('parameter-workspace').querySelector('.parameter-grid-scroll');
    const position = scroller ? [scroller.scrollLeft, scroller.scrollTop] : [0, 0];
    changed(!!render);
    if (render) {
      const next = $('parameter-workspace').querySelector('.parameter-grid-scroll');
      if (next) { next.scrollLeft = position[0]; next.scrollTop = position[1]; }
    }
  }
  function openTableReferences(table, anchor, ordering) {
    if (modal) return;
    commitParameterCell();
    const identity = libraryId, stamp = generation;
    const overlay = element('div', 'modal-overlay parameter-modal');
    const dialog = element('form', 'modal-dialog parameter-matrix-merge-dialog parameter-reference-dialog-editor');
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'parameter-references-title');
    let held = null;
    const close = () => { held = null; overlay.remove(); modal = null; if (anchor && anchor.isConnected) anchor.focus({ preventScroll: true }); queueMicrotask(applyPendingCatalog); };
    const header = element('div', 'modal-header'), title = element('h2', '', ordering ? '修改引用顺序' : '引用参数表'); title.id = 'parameter-references-title';
    header.append(title, button('关闭', close, 'close')); dialog.append(header);
    const body = element('div', 'modal-body'), choices = element('div', 'parameter-reference-choices-editor');
    const error = element('p', 'parameter-count-error'); error.setAttribute('role', 'alert');
    const confirm = button('应用', () => {}); confirm.type = 'submit'; confirm.classList.add('modal-btn-primary');
    const columns = effectiveTables(), drafts = clone(table.references || []), states = [];
    function checkbox(label, checked) {
      const node = element('label'), input = element('input'); input.type = 'checkbox'; input.checked = checked; input.setAttribute('aria-label', label);
      node.append(input, element('span', '', label)); return { node, input };
    }
    if (ordering) {
      function renderOrder() {
        choices.replaceChildren();
        drafts.forEach((ref, index) => {
          const row = element('div', 'parameter-reference-order-row'); row.dataset.referenceId = ref.tableId;
          const source = columns.find((item) => item.id === ref.tableId);
          const grip = button('拖动引用表：' + (source ? source.name : ref.name || ref.tableId), () => {}, 'grip');
          const move = (to) => { if (to < 0 || to >= drafts.length) return; drafts.splice(to, 0, drafts.splice(index, 1)[0]); renderOrder(); };
          grip.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            event.preventDefault(); held = { key: ref.tableId, x: event.clientX, y: event.clientY, pointer: event.pointerId };
            grip.setPointerCapture(event.pointerId); row.classList.add('dragging');
          });
          function mark(event) {
            if (!held) return;
            held.x = event.clientX; held.y = event.clientY;
            choices.querySelectorAll('.drop-before,.drop-after').forEach((item) => item.classList.remove('drop-before', 'drop-after'));
            const hit = document.elementFromPoint(held.x, held.y)?.closest('.parameter-reference-order-row');
            if (hit && hit !== row) hit.classList.add(held.y < hit.getBoundingClientRect().top + hit.offsetHeight / 2 ? 'drop-before' : 'drop-after');
          }
          grip.addEventListener('pointermove', mark);
          grip.addEventListener('pointerup', (event) => {
            if (!held) return; mark(event);
            const target = choices.querySelector('.drop-before,.drop-after'); held = null;
            if (!target) { row.classList.remove('dragging'); return; }
            const from = drafts.findIndex((item) => item.tableId === ref.tableId), to = drafts.findIndex((item) => item.tableId === target.dataset.referenceId) + (target.classList.contains('drop-after') ? 1 : 0);
            drafts.splice(to > from ? to - 1 : to, 0, drafts.splice(from, 1)[0]); renderOrder();
          });
          grip.addEventListener('lostpointercapture', () => { held = null; row.classList.remove('dragging'); });
          grip.addEventListener('keydown', (event) => { if (['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); move(index + (event.key === 'ArrowUp' ? -1 : 1)); choices.children[index + (event.key === 'ArrowUp' ? -1 : 1)]?.querySelector('button')?.focus(); } });
          const up = button('提高引用优先级', () => move(index - 1), 'up'), down = button('降低引用优先级', () => move(index + 1), 'down');
          up.disabled = index === 0; down.disabled = index === drafts.length - 1;
          row.append(grip, element('span', 'parameter-reference-order-name', (index + 1) + '. ' + (source ? source.name : (ref.name || ref.tableId) + '（已删除）')), up, down); choices.append(row);
        });
      }
      renderOrder();
    } else {
      const all = checkbox('全选变量', false); body.append(all.node);
      function sync() {
        const checked = states.filter((state) => state.pick.checked);
        const entries = checked.flatMap((state) => state.variables.map((entry) => entry.input));
        all.input.disabled = !checked.length; all.input.checked = !!checked.length && entries.every((input) => input.checked);
        all.input.indeterminate = entries.some((input) => input.checked) && !all.input.checked;
        states.forEach((state) => { const inputs = state.variables.map((entry) => entry.input); state.all.checked = inputs.every((input) => input.checked); state.all.indeterminate = inputs.some((input) => input.checked) && !state.all.checked; });
      }
      all.input.addEventListener('change', () => { states.filter((state) => state.pick.checked).forEach((state) => state.variables.forEach((entry) => { entry.input.checked = all.input.checked; })); sync(); });
      const candidates = columns.filter((item) => matrix.owner(catalog.tables, item.id).id !== table.id);
      candidates.forEach((source) => {
        const previous = drafts.find((ref) => ref.tableId === source.id), section = element('section', 'parameter-reference-selection');
        const pick = checkbox('引用 ' + source.name, !!previous), selectAll = checkbox('全选变量：' + source.name, true);
        const missingIds = previous && previous.rowIds ? previous.rowIds.filter((key) => !source.rows.some((row) => row.id === key)) : [];
        const state = { source, pick: pick.input, all: selectAll.input, variables: [], hasMissing: missingIds.length > 0 }; states.push(state);
        const details = element('details'); details.open = !!previous; details.append(element('summary', '', source.name + ' · ' + source.rows.length + ' 个变量'));
        details.append(selectAll.node);
        source.rows.filter((row) => row.name).forEach((row) => {
          const entry = checkbox(source.name + ' / ' + row.name, !previous || !matrix.own(previous, 'rowIds') || previous.rowIds.includes(row.id));
          entry.rowId = row.id; state.variables.push(entry); entry.node.append(element('small', '', matrix.raw(row.val)));
          entry.input.addEventListener('change', () => { if (entry.input.checked) state.pick.checked = true; sync(); }); details.append(entry.node);
        });
        missingIds.forEach((key) => {
          const entry = checkbox('已删除变量：' + source.name + ' / ' + key, true); entry.rowId = key;
          entry.node.classList.add('parameter-reference-missing-choice'); entry.node.title = '保留勾选后，源变量恢复时自动接续引用';
          entry.input.addEventListener('change', sync); state.variables.push(entry); details.append(entry.node);
        });
        pick.input.addEventListener('change', () => { if (pick.input.checked) details.open = true; sync(); });
        selectAll.input.addEventListener('change', () => { state.variables.forEach((entry) => { entry.input.checked = selectAll.input.checked; }); if (selectAll.input.checked) pick.input.checked = true; sync(); });
        section.append(pick.node, details); choices.append(section);
      });
      drafts.filter((ref) => !columns.some((source) => source.id === ref.tableId)).forEach((ref) => {
        const pick = checkbox('保留缺失引用：' + (ref.name || ref.tableId), true); choices.append(pick.node); states.push({ missing: ref, pick: pick.input, all: { checked: true }, variables: [] });
      });
      if (!states.length) choices.append(element('p', 'parameter-empty', '没有可引用的其他参数表'));
      sync();
    }
    body.append(choices, error); dialog.append(body);
    const footer = element('div', 'modal-footer'); footer.append(button('取消', close), confirm); dialog.append(footer);
    dialog.addEventListener('submit', (event) => {
      event.preventDefault();
      try {
        if (identity !== libraryId || stamp !== generation || !catalog.tables.includes(table)) throw new Error('参数目录已变化，请重新打开引用窗口');
        let references = drafts;
        if (!ordering) {
          const chosen = states.filter((state) => state.pick.checked).map((state) => {
            if (state.missing) return state.missing;
            const selected = state.variables.filter((entry) => entry.input.checked).map((entry) => entry.rowId);
            return { tableId: state.source.id, name: state.source.name, ...(!state.hasMissing && selected.length === state.variables.length ? {} : { rowIds: selected }) };
          });
          references = [...drafts.map((ref) => chosen.find((entry) => entry.tableId === ref.tableId)).filter(Boolean), ...chosen.filter((entry) => !drafts.some((ref) => ref.tableId === entry.tableId))];
        }
        const candidate = clone(catalog); candidate.tables.find((item) => item.id === table.id).references = references; validate(candidate);
        close();
        if (JSON.stringify(table.references || []) !== JSON.stringify(references)) patchMatrix(table, [{ target: table, field: 'references', value: references }], true);
        status(ordering ? '已更新引用顺序' : '已更新引用参数表');
      } catch (cause) { error.textContent = cause.message; }
    });
    let outside = false;
    overlay.addEventListener('pointerdown', (event) => { outside = event.target === overlay; });
    overlay.addEventListener('click', (event) => { if (outside && event.target === overlay) close(); });
    overlay.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') {
        const controls = [...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),summary')].filter((node) => node.getClientRects().length);
        if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1).focus(); }
        else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
      }
    });
    modal = overlay; overlay.append(dialog); document.body.append(overlay); header.querySelector('button').focus();
  }
  function pendingParameterChanges() { return !!activeCellEdit || dirty !== savedGeneration; }
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
    const row = selectedRow, patches = [{ target: table, field: 'rows', value: table.rows.filter((item) => item !== row) }];
    selectedRow = null; patchMatrix(table, patches, true);
    return true;
  }
  function rowPosition(table, row) {
    const index = table.rows.indexOf(row);
    return { index, previous: table.rows[index - 1], next: table.rows[index + 1] };
  }
  function insertRowAtPosition(table, row, position) {
    const next = table.rows.indexOf(position.next), previous = table.rows.indexOf(position.previous);
    const index = next >= 0 ? next : previous >= 0 ? previous + 1 : Math.min(position.index, table.rows.length);
    table.rows.splice(index, 0, row);
  }
  function moveParameterRow(table, row, target, after) {
    if (activePage !== 'parameters' || modal || selectedTable !== table.id || !catalog.tables.includes(table)) return false;
    const before = rowPosition(table, row), targetIndex = table.rows.indexOf(target);
    if (before.index < 0 || targetIndex < 0) return false;
    let index = targetIndex + (after ? 1 : 0);
    if (before.index < index) index--;
    if (index === before.index) return false;
    const scroller = $('parameter-workspace').querySelector('.parameter-grid-scroll');
    table.rows.splice(before.index, 1); table.rows.splice(index, 0, row);
    recordParameterHistory({ kind: 'row-move', tableId: table.id, row, before, after: rowPosition(table, row) });
    finishRowHistory(table, row, scroller ? scroller.scrollTop : 0);
    return true;
  }
  function applyParameterHistory(redo) {
    if (activePage !== 'parameters' || modal || catalogLoadError) return false;
    commitParameterCell();
    const from = redo ? parameterRedoStack : parameterUndoStack, to = redo ? parameterUndoStack : parameterRedoStack;
    const entry = from[from.length - 1]; if (!entry) return false;
    if (entry.kind === 'matrix-patch') {
      const table = catalog.tables.find((item) => item.id === entry.tableId); if (!table) return false;
      const scroller = $('parameter-workspace').querySelector('.parameter-grid-scroll');
      const position = scroller ? [scroller.scrollLeft, scroller.scrollTop] : [0, 0];
      (redo ? entry.changes : entry.changes.slice().reverse()).forEach((patch) => {
        if (redo ? patch.present : patch.beforePresent) patch.target[patch.field] = redo ? patch.value : patch.before;
        else delete patch.target[patch.field];
      });
      from.pop(); to.push(entry); selectedTable = table.id;
      changed(true, true);
      const next = $('parameter-workspace').querySelector('.parameter-grid-scroll');
      if (next) { next.scrollLeft = position[0]; next.scrollTop = position[1]; }
      return true;
    }
    if (entry.kind === 'cell-batch') {
      const additions = entry.additions || [];
      if (entry.changes.some((change) => !catalog.tables.some((table) => table.id === change.tableId && table.rows.includes(change.row)))) return false;
      if (additions.some((item) => {
        const table = catalog.tables.find((table) => table.id === item.tableId);
        return !table || table.rows.includes(item.row) === redo;
      })) return false;
      additions.forEach((item) => {
        const table = catalog.tables.find((table) => table.id === item.tableId);
        if (redo) table.rows.splice(Math.min(item.index, table.rows.length), 0, item.row);
        else table.rows.splice(table.rows.indexOf(item.row), 1);
      });
      entry.changes.forEach((change) => {
        if (redo || change.beforePresent) change.row[change.field] = redo ? change.after : change.before;
        else delete change.row[change.field];
      });
      from.pop(); to.push(entry);
      const items = entry.changes.concat(additions);
      const change = items.find((item) => item.tableId === selectedTable) || items[0];
      const table = catalog.tables.find((table) => table.id === change.tableId);
      const scroller = $('parameter-workspace').querySelector('.parameter-grid-scroll');
      finishRowHistory(table, table.rows.includes(change.row) ? change.row : null, scroller ? scroller.scrollTop : 0);
      return true;
    }
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
    if (entry.kind === 'row-edit') {
      if (!table.rows.includes(entry.row)) return false;
      const focused = document.activeElement;
      const editingCell = focused && focused.matches('[data-parameter-field]');
      const caret = editingCell ? focused.selectionStart : null;
      if (redo || entry.beforePresent) entry.row[entry.field] = redo ? entry.after : entry.before;
      else delete entry.row[entry.field];
      from.pop(); to.push(entry);
      finishRowHistory(table, entry.row, scroller ? scroller.scrollTop : 0);
      if (editingCell) {
        const input = $('parameter-workspace').querySelector('tr.selected [data-parameter-field="' + entry.field + '"]');
        if (input) {
          input.focus({ preventScroll: true });
          const position = Math.min(caret == null ? input.value.length : caret, input.value.length);
          input.setSelectionRange(position, position);
        }
      }
      return true;
    }
    if (entry.kind === 'row-move') {
      const index = table.rows.indexOf(entry.row); if (index < 0) return false;
      table.rows.splice(index, 1);
      insertRowAtPosition(table, entry.row, redo ? entry.after : entry.before);
      from.pop(); to.push(entry);
      finishRowHistory(table, entry.row, scroller ? scroller.scrollTop : 0);
      return true;
    }
    if (redo) {
      const index = table.rows.indexOf(entry.row);
      if (index < 0) return false;
      entry.index = index; entry.previous = table.rows[index - 1]; entry.next = table.rows[index + 1];
      table.rows.splice(index, 1);
    } else {
      insertRowAtPosition(table, entry.row, entry);
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
  function tomlText(value) {
    const text = String(value);
    for (const character of text) {
      const point = character.codePointAt(0);
      if (point >= 0xd800 && point <= 0xdfff) throw new Error('文本包含无效的 Unicode 字符');
    }
    return text;
  }
  function tomlString(value) { return JSON.stringify(tomlText(value)).replace(/\u007f/g, '\\u007f'); }
  function tomlComment(value) {
    return tomlText(value).replace(/\r\n?/g, '\n').split('\n').map((line) => '# ' + line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g,
      (character) => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'))).join('\n');
  }
  function tomlValue(value) {
    if (value === 'true' || value === 'false') return value;
    if (/^(?:[+-]?\d+|0[xX][\da-fA-F]+|0[bB][01]+|0[oO][0-7]+)$/.test(value)) {
      const integer = BigInt(value);
      if (integer >= -9223372036854775808n && integer <= 9223372036854775807n) return integer.toString();
    } else if (numericPattern.test(value) && Number.isFinite(Number(value))) {
      // Normalize decimal syntax without rounding long numeric literals through Number.
      return value.replace(/^([+-]?)0+(?=\d)/, '$1').replace(/^([+-]?)\./, (_match, sign) => sign + '0.')
        .replace(/\.(?=[eE]|$)/, '.0');
    }
    return tomlString(value);
  }
  function parameterTableToml(table, includeDescriptions = false) {
    const lines = [tomlComment('参数表：' + table.name), ''];
    const names = parameterNameCounts(table.rows), source = { parameterTables: [table.id] };
    const context = { stack: [], values: new Map() };
    let count = 0;
    table.rows.forEach((row, index) => {
      if (['name', 'val', 'description'].every((field) => String(row[field] ?? '') === '')) return;
      try {
        const name = String(row.name ?? '');
        const nameError = parameterRowNameError(row, names);
        if (!name || nameError) throw new Error(nameError || '变量名不能为空');
        const result = resolveParameterRow(table, row, source, context);
        if (result.error) throw new Error(result.error);
        if (includeDescriptions && result.description) lines.push(tomlComment(result.description));
        if (result.formula) lines.push(tomlComment('公式：' + result.rawVal));
        const key = /^[A-Za-z0-9_-]+$/.test(name) ? name : tomlString(name);
        lines.push(key + ' = ' + tomlValue(result.val), ''); count++;
      } catch (error) { throw new Error('第 ' + (index + 1) + ' 行：' + error.message); }
    });
    return { text: lines.join('\n'), count };
  }
  function exportParameterTableToml(tableId, anchor) {
    if (modal) return;
    try {
      commitParameterCell();
      const table = effectiveTable(tableId);
      if (!table) throw new Error('参数表不存在或已被删除');
      let name = String(table.name || '参数表').trim().replace(/\.toml$/i, '')
        .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_');
      name = Array.from(name).slice(0, 100).join('').replace(/[. ]+$/g, '') || '参数表';
      if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
      const filename = name + '.toml';
      const identity = libraryId, serviceMode = bridge.tomlExportService && bridge.tomlExportService();
      const canPick = typeof global.showSaveFilePicker === 'function';
      const overlay = element('div', 'modal-overlay parameter-modal');
      const dialog = element('form', 'modal-dialog parameter-export-dialog'); dialog.noValidate = true;
      dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'parameter-export-title');
      let busy = false, closed = false, confirmedPath = '';
      function close() {
        if (busy || closed) return;
        closed = true; overlay.remove(); modal = null;
        if (anchor && anchor.isConnected) anchor.focus({ preventScroll: true });
      }
      const header = element('div', 'modal-header'), title = element('h2', '', '导出 TOML'); title.id = 'parameter-export-title';
      const dismiss = button('关闭', close, 'close'); header.append(title, dismiss); dialog.append(header);
      const body = element('div', 'modal-body');
      const label = element('label', 'parameter-count-label', serviceMode ? '保存路径' : '文件名');
      const path = element('input'); path.id = 'parameter-export-path'; path.value = filename; label.htmlFor = path.id;
      path.autocomplete = 'off'; path.spellcheck = false;
      const location = element('div', 'parameter-export-location'); location.append(path);
      const choose = button('选择保存路径', async () => {
        if (busy) return;
        setBusy(true); error.textContent = '';
        try {
          let initial = path.value.trim() || filename;
          if (!/\.toml$/i.test(initial)) initial += '.toml';
          const result = await bridge.tomlExportRequest({ action: 'pick', path: initial });
          if (!result.cancelled && result.path) {
            path.value = result.path; confirmedPath = result.exists ? result.path : '';
            overwrite.checked = false; overwriteLabel.hidden = true;
          }
          if (result.manual) { error.textContent = '文件窗口不可用，请直接输入保存路径'; path.focus(); }
        } catch (cause) { error.textContent = cause.message; }
        finally { setBusy(false); if (!closed) path.focus({ preventScroll: true }); }
      }, 'external'); choose.hidden = !serviceMode; location.append(choose);
      const option = element('label', 'parameter-export-option');
      const descriptions = element('input'); descriptions.type = 'checkbox'; descriptions.id = 'parameter-export-descriptions';
      option.append(descriptions, element('span', '', '导出变量说明'));
      const error = element('p', 'parameter-count-error'); error.id = 'parameter-export-error'; error.setAttribute('role', 'alert');
      path.setAttribute('aria-describedby', error.id);
      if (!serviceMode && !canPick) body.append(element('p', 'parameter-export-note', '当前浏览器不支持页面选择保存目录，将使用浏览器下载设置。'));
      const overwriteLabel = element('label', 'parameter-export-option'); overwriteLabel.hidden = true;
      const overwrite = element('input'); overwrite.type = 'checkbox'; overwriteLabel.append(overwrite, element('span', '', '覆盖已有文件'));
      path.addEventListener('input', () => { confirmedPath = ''; overwrite.checked = false; overwriteLabel.hidden = true; error.textContent = ''; path.removeAttribute('aria-invalid'); });
      body.append(label, location, option, overwriteLabel, error); dialog.append(body);
      const footer = element('div', 'modal-footer'), cancel = button('取消', close), save = button('导出', () => {});
      save.type = 'submit'; save.classList.add('modal-btn-primary'); footer.append(cancel, save); dialog.append(footer);
      function setBusy(value) {
        busy = value; dialog.setAttribute('aria-busy', String(value));
        [path, descriptions, overwrite, choose, cancel, dismiss, save].forEach((control) => { control.disabled = value; });
        save.textContent = value ? '正在导出...' : '导出';
      }
      dialog.addEventListener('submit', async (event) => {
        event.preventDefault(); if (busy || closed || event.isComposing) return;
        error.textContent = ''; path.removeAttribute('aria-invalid');
        let target = path.value.trim();
        if (!target) { error.textContent = '请输入保存路径或文件名'; path.setAttribute('aria-invalid', 'true'); path.focus(); return; }
        if (!/\.toml$/i.test(target)) target += '.toml';
        if (!serviceMode && /[<>:"/\\|?*\u0000-\u001f\u007f]/.test(target)) {
          error.textContent = '请输入文件名，保存目录将在浏览器保存窗口中选择'; path.setAttribute('aria-invalid', 'true'); path.focus(); return;
        }
        path.value = target;
        setBusy(true);
        try {
          commitParameterCell();
          const current = effectiveTable(tableId);
          if (!current || identity !== libraryId) throw new Error('目标参数表已变化，请关闭后重新导出');
          const result = parameterTableToml(current, descriptions.checked);
          let savedPath = target;
          if (serviceMode) {
            const response = await bridge.tomlExportRequest({ action: 'save', path: target, content: result.text,
              overwrite: overwrite.checked || confirmedPath === target });
            if (response.requiresOverwrite) {
              error.textContent = '目标文件已存在，勾选“覆盖已有文件”后再次导出';
              overwriteLabel.hidden = false; return;
            }
            savedPath = response.path;
          } else {
            const blob = new Blob([result.text], { type: 'application/toml;charset=utf-8' });
            if (canPick) {
              const handle = await global.showSaveFilePicker({ id: 'vwd-parameter-toml', suggestedName: target,
                types: [{ description: 'TOML 参数表', accept: { 'application/toml': ['.toml'] } }] });
              const writable = await handle.createWritable();
              try { await writable.write(blob); await writable.close(); }
              catch (cause) { try { await writable.abort(); } catch (_) {} throw cause; }
              savedPath = handle.name;
            } else bridge.download(blob, target);
          }
          setBusy(false); close(); status('已导出 ' + savedPath + '（' + result.count + ' 个变量）');
        } catch (cause) {
          if (cause.name !== 'AbortError') error.textContent = '导出 TOML 失败：' + cause.message;
        } finally { setBusy(false); }
      });
      let startedOutside = false;
      overlay.addEventListener('pointerdown', (event) => { startedOutside = event.target === overlay; });
      overlay.addEventListener('click', (event) => { if (startedOutside && event.target === overlay) close(); });
      overlay.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        if (event.key === 'Enter' && event.isComposing) event.preventDefault();
        if (event.key === 'Tab') {
          const controls = Array.from(dialog.querySelectorAll('button:not(:disabled):not([hidden]),input:not(:disabled)')).filter((node) => !node.closest('[hidden]'));
          if (!controls.length) { event.preventDefault(); return; }
          if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls[controls.length - 1].focus(); }
          else if (!event.shiftKey && document.activeElement === controls[controls.length - 1]) { event.preventDefault(); controls[0].focus(); }
        }
      });
      clipboardRequest++; modal = overlay; overlay.append(dialog); document.body.append(overlay); path.focus(); path.select();
    } catch (error) { status('导出 TOML 失败：' + error.message, true); }
  }
  function validate(value) {
    matrix.normalize(value.tables);
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
    matrix.validate(value.tables);
  }
  function invalidate() {
    generation++; cache = new WeakMap(); calculationCache = new WeakMap();
    if (bridge) bridge.changed();
  }
  function changed(render, applyingHistory) {
    if (!applyingHistory) parameterRedoStack = [];
    dirty++; failure = ''; invalidate();
    if (render) { renderTree(); renderTable(); }
    notifyParameterHistory();
    status('正在保存参数目录...');
    clearTimeout(timer); timer = setTimeout(() => { void flush(false).catch(() => {}); }, 220);
  }
  function rebasePendingCatalog() {
    if (!pendingCatalog || pendingCatalog.libraryId !== libraryId || Number(pendingCatalog.catalog.revision) <= catalog.revision) { pendingCatalog = null; return false; }
    const incoming = normalize(pendingCatalog.catalog), baseline = syncedCatalog;
    if (!baseline) return false;
    const next = {};
    for (const field of ['tables', 'directories', 'presets']) {
      const before = new Map(baseline[field].map((item) => [item.id, item]));
      const local = new Map(catalog[field].map((item) => [item.id, item]));
      const remote = new Map(incoming[field].map((item) => [item.id, item]));
      next[field] = [];
      const localOrderUnchanged = JSON.stringify([...local.keys()]) === JSON.stringify([...before.keys()]);
      const order = localOrderUnchanged ? [...remote.keys(), ...local.keys()] : [...local.keys(), ...remote.keys()];
      for (const key of new Set(order)) {
        const b = JSON.stringify(before.get(key)), l = JSON.stringify(local.get(key)), r = JSON.stringify(remote.get(key));
        if (l !== b && r !== b && l !== r) throw new Error('参数表在其他窗口也被修改，请保留当前输入后重新打开：' + (local.get(key)?.name || remote.get(key)?.name || key));
        const chosen = r === b || l === r ? local.get(key) : remote.get(key);
        if (chosen) next[field].push(chosen);
      }
    }
    validate(next);
    const replaced = new Set(catalog.tables.filter((table) => next.tables.find((item) => item.id === table.id) !== table).map((table) => table.id));
    const unaffected = (entry) => !replaced.has(entry.tableId || entry.table?.id)
      && !(entry.changes || []).some((change) => replaced.has(change.tableId || change.sourceTableId));
    parameterUndoStack = parameterUndoStack.filter(unaffected); parameterRedoStack = parameterRedoStack.filter(unaffected);
    Object.assign(catalog, next, { revision: incoming.revision });
    syncedCatalog = clone(incoming); pendingCatalog = null;
    invalidate(); renderTree(); renderTable(); return true;
  }
  function applyPendingCatalog() {
    if (!pendingCatalog || modal || activeCellEdit || saving) return;
    if (catalogLoadError) { const incoming = pendingCatalog; pendingCatalog = null; setCatalog(incoming.catalog, incoming.libraryId); return; }
    if (dirty !== savedGeneration) { void flush(false).catch(() => {}); return; }
    const active = document.activeElement, scroll = $('parameter-workspace')?.querySelector('.parameter-grid-scroll');
    const position = scroll && [scroll.scrollLeft, scroll.scrollTop];
    const field = active && active.dataset.parameterField, line = active && active.closest('tr');
    const index = line && line.parentElement ? [...line.parentElement.children].indexOf(line) : -1;
    const sourceId = active && active.dataset.referenceSourceId, rowId = active && active.dataset.referenceRowId;
    const start = active && active.selectionStart, end = active && active.selectionEnd;
    try { rebasePendingCatalog(); }
    catch (error) { status(error.message, true); return; }
    const next = $('parameter-workspace')?.querySelector('.parameter-grid-scroll');
    if (next && position) { next.scrollLeft = position[0]; next.scrollTop = position[1]; }
    if (field && next) {
      const row = next.querySelector('tbody')?.children[index];
      const input = sourceId ? [...next.querySelectorAll('[data-reference-source-id]')].find((node) => node.dataset.parameterField === field && node.dataset.referenceSourceId === sourceId && node.dataset.referenceRowId === rowId)
        : row && [...row.querySelectorAll('[data-parameter-field]')].find((node) => node.dataset.parameterField === field);
      if (input) { input.focus({ preventScroll: true }); if (typeof start === 'number') input.setSelectionRange(start, end); }
    }
  }
  async function flush(includeDraft = true) {
    if (catalogLoadError) return;
    if (includeDraft) commitParameterCell();
    clearTimeout(timer);
    if (saving) { await saving; if (dirty !== savedGeneration) return flush(false); return; }
    if (pendingCatalog && !modal && !activeCellEdit) rebasePendingCatalog();
    else if (pendingCatalog && activeCellEdit) return;
    if (dirty === savedGeneration) return;
    const at = dirty, identity = libraryId;
    const value = clone(catalog);
    saving = (async () => {
      validate(value);
      const saved = await bridge.save(value, value.revision);
      if (identity !== libraryId) throw new Error('保存期间波形库已切换');
      catalog.revision = saved.revision; savedGeneration = at; failure = '';
      syncedCatalog = clone(saved);
      if (channel) channel.postMessage({ libraryId, catalog: saved });
      status('已保存到工作库');
    })().catch((error) => {
      failure = error.message; status(failure, true); throw error;
    }).finally(() => { saving = null; });
    await saving;
    if (dirty !== savedGeneration) return flush(false);
    applyPendingCatalog();
  }
  function setCatalog(value, identity) {
    if (comparisonCommit && identity === libraryId) return;
    if (identity === libraryId && (pendingParameterChanges() || Number(value && value.revision) < catalog.revision)) return;
    if (identity !== libraryId) { referenceDocuments.clear(); clearReferenceHighlight(); }
    let next; catalogLoadError = ''; rejectedCatalog = null; catalogWarnings = [];
    try { next = normalize(value, catalogWarnings); matrix.validate(next.tables); }
    catch (error) {
      catalogLoadError = error.message; rejectedCatalog = clone(value || empty()); next = empty();
      next.revision = Number(value && value.revision) || 0;
    }
    const sameContent = identity === libraryId && (parameterUndoStack.length || parameterRedoStack.length)
      && ['directories', 'tables', 'presets'].every((key) => JSON.stringify(catalog[key]) === JSON.stringify(next[key]));
    if (sameContent) catalog.revision = next.revision;
    else { catalog = next; parameterUndoStack = []; parameterRedoStack = []; }
    libraryId = identity || '';
    syncedCatalog = clone(next); pendingCatalog = null;
    dirty = savedGeneration = 0; failure = '';
    if (catalogLoadError) { parameterUndoStack = []; parameterRedoStack = []; }
    if (!catalog.tables.some((table) => table.id === selectedTable)) selectedTable = '';
    if (!catalog.directories.some((dir) => dir.id === selectedFolder)) selectedFolder = '';
    // A restored JSON document can be unchanged while its parameter values differ.
    // Invalidate the host's rendered-wave caches as well as the resolver cache.
    invalidate();
    renderTree(); renderTable(); notifyParameterHistory();
    return { ok: !catalogLoadError, error: catalogLoadError, repairedRows: catalogWarnings.length };
  }
  async function refresh() {
    if (!bridge || !bridge.identity()) throw new Error('波形库仍在加载，请稍后再试');
    await flush();
    const identity = bridge.identity();
    const loadGeneration = dirty;
    const value = await bridge.load();
    if (identity !== bridge.identity() || dirty !== loadGeneration) return;
    setCatalog(value, identity);
    if (catalogLoadError) throw new Error('参数表暂不可用：' + catalogLoadError + '；原始数据已保留');
  }
  function namePrompt(label, initial) { const answer = global.prompt(label, initial || ''); return answer == null ? null : answer.trim(); }
  function addDirectory(parentId) {
    if (catalogLoadError) return;
    const name = namePrompt('新标题名称'); if (!name) return;
    const dir = { id: id(), name, parentId: parentId || '' };
    catalog.directories.push(dir); expanded.add(dir.parentId); selectedFolder = dir.id; expanded.add(dir.id); changed(true);
  }
  function addTable() {
    if (catalogLoadError) return;
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
    if (standaloneTableId) return;
    const tree = $('parameter-tree'); if (!tree) return;
    tree.replaceChildren();
    if ($('parameter-add-table')) $('parameter-add-table').disabled = !!catalogLoadError;
    if ($('parameter-toggle-all')) $('parameter-toggle-all').disabled = !!catalogLoadError;
    if (catalogLoadError) { tree.append(element('p', 'parameter-status error', '参数表载入失败，原始数据已保留')); return; }
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
      const rows = Array.from({ length: count }, () => ({ id: id(), name: '', val: '', description: '' }));
      selectedRow = rows[0]; rowFilters.name = ''; rowFilters.val = '';
      close(); patchMatrix(table, [{ target: table, field: 'rows', value: table.rows.concat(rows) }], true);
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
    referenceScan++; referenceRefresh = null;
    commitParameterCell();
    if (matrixDispose) { matrixDispose(); matrixDispose = null; }
    if (standaloneTableId) selectedTable = (matrix.owner(catalog.tables, standaloneTableId) || {}).id || standaloneTableId;
    const table = catalog.tables.find((item) => item.id === selectedTable);
    if (standaloneTableId) document.title = (effectiveTable(standaloneTableId) || table || { name: '参数表' }).name + ' - VisualWaveDrom';
    if (tableViewId !== (table && table.id || '')) {
      tableViewId = table && table.id || ''; selectedRow = null;
      rowFilters.name = ''; rowFilters.val = '';
    }
    if (!table || !table.rows.includes(selectedRow)) selectedRow = null;
    workspace.replaceChildren();
    if (catalogLoadError) {
      workspace.append(element('h2', 'parameter-workspace-header', '参数表暂不可用'),
        element('p', 'parameter-status error', catalogLoadError + '；已禁止覆盖参数表，原始数据保持不变，波形图仍可查看。'));
      return;
    }
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
      const compare = button('比较参数表', () => openComparison(table.id, compare));
      compare.classList.add('parameter-compare-open'); toolbar.append(compare);
      const exportToml = button('导出 TOML', (event) => exportParameterTableToml(table.id, event.currentTarget));
      exportToml.classList.add('parameter-export-toml');
      exportToml.insertAdjacentHTML('afterbegin', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="lucide" aria-hidden="true">' + paths.download + '</svg>');
      exportToml.disabled = standaloneLoading || !!standaloneError; toolbar.append(exportToml);
    } else if (!standaloneTableId) toolbar.append(button('新增参数表', addTable));
    if (table && !standaloneTableId) {
      const open = button('单独打开', async () => {
        open.disabled = true;
        try { await bridge.openTable(table.id); }
        catch (error) { status(error.message, true); }
        finally { open.disabled = false; }
      });
      open.classList.add('parameter-open-single');
      open.insertAdjacentHTML('afterbegin', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="lucide" aria-hidden="true">' + paths.external + '</svg>');
      toolbar.append(open);
    }
    if (table) {
      const undo = button('撤销', () => applyParameterHistory(false), 'undo'); undo.id = 'parameter-single-undo';
      const redo = button('重做', () => applyParameterHistory(true), 'redo'); redo.id = 'parameter-single-redo';
      toolbar.append(undo, redo);
    }
    const saveLibrary = button('保存波形库', async () => {
      saveLibrary.disabled = true;
      try {
        await flush();
        if (await bridge.saveLibrary()) status('已保存波形库');
        else status('波形库保存失败，请重试', true);
      }
      catch (error) { status(error.message, true); }
      finally { saveLibrary.disabled = false; }
    });
    saveLibrary.classList.add('parameter-library-save'); toolbar.append(saveLibrary);
    saveLibrary.disabled = standaloneLoading || !!standaloneError;
    workspace.append(toolbar);
    notifyParameterHistory();
    updateClipboardButtons();
    const state = element('div', 'parameter-status'); state.id = 'parameter-status'; state.setAttribute('role', 'status');
    state.textContent = failure || (dirty !== savedGeneration ? '正在保存参数目录...' : ''); workspace.append(state);
    if (!table) {
      workspace.append(element('p', 'parameter-empty', standaloneTableId
        ? (standaloneLoading ? '正在加载参数表...' : standaloneError || '此参数表不存在或已被删除') : '未选中参数表'));
      return;
    }
    const scroller = element('div', 'parameter-grid-scroll'); const grid = element('table', 'parameter-grid');
    const head = element('thead'); const tr = element('tr');
    const filterInputs = {}, filterCount = element('span', 'parameter-filter-count');
    let matrixView = null;
    const clearFilters = button('清除筛选', () => {
      ['name', 'val'].forEach((field) => { rowFilters[field] = ''; filterInputs[field].value = ''; });
      if (matrixView) matrixView.clearFilters();
      applyFilters(); filterInputs.name.focus();
    }, 'close');
    ['name', 'val', 'description'].forEach((field) => {
      const label = { name: '变量名 name', val: '变量值 val', description: '变量说明 description' }[field];
      const th = element('th'); th.scope = 'col'; th.append(element('span', 'parameter-column-label', label));
      if (field !== 'description') {
        const input = element('input', 'parameter-column-filter');
        input.type = 'search'; input.value = rowFilters[field]; input.spellcheck = false;
        input.placeholder = field === 'name' ? '筛选变量名' : '筛选变量值'; input.setAttribute('aria-label', input.placeholder);
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
    const rowDropViews = new Map();
    const dragLibraryId = libraryId;
    let draggedRow = null, draggedLine = null, dropTarget = null, rowDrag = null, rowDragFrame = 0;
    function clearDropTarget() {
      if (dropTarget) dropTarget.view.line.classList.remove('parameter-drop-before', 'parameter-drop-after');
      dropTarget = null;
    }
    function clearRowDrag() {
      const previous = rowDrag; rowDrag = null;
      global.removeEventListener('keydown', cancelRowDrag, true);
      global.removeEventListener('blur', clearRowDrag);
      global.removeEventListener('lostpointercapture', rowPointerReleased, true);
      if (rowDragFrame) { global.cancelAnimationFrame(rowDragFrame); rowDragFrame = 0; }
      clearDropTarget();
      if (draggedLine) draggedLine.classList.remove('parameter-row-dragging');
      draggedRow = draggedLine = null;
      scroller.classList.remove('parameter-row-reordering');
      if (previous && previous.handle.hasPointerCapture(previous.pointerId)) previous.handle.releasePointerCapture(previous.pointerId);
    }
    function cancelRowDrag(event) {
      if (rowDrag && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); clearRowDrag(); }
    }
    function rowPointerReleased(event) {
      if (rowDrag && rowDrag.pointerId === event.pointerId) clearRowDrag();
    }
    function acceptsRowDrag() {
      return draggedRow && dragLibraryId === libraryId && activePage === 'parameters' && selectedTable === table.id
        && catalog.tables.includes(table) && scroller.isConnected;
    }
    function findRowDrop(event) {
      if (!acceptsRowDrag()) return null;
      const bounds = scroller.getBoundingClientRect();
      const headerBottom = Math.max(bounds.top, ...Array.from(tr.children, (cell) => cell.getBoundingClientRect().bottom));
      if (event.clientX < bounds.left || event.clientX >= bounds.right || event.clientY < headerBottom || event.clientY >= bounds.bottom) return null;
      const underPointer = document.elementFromPoint(event.clientX, event.clientY);
      let view = rowDropViews.get(underPointer && underPointer.closest('tr'));
      let after;
      if (view && !view.line.hidden) {
        const bounds = view.line.getBoundingClientRect(); after = event.clientY >= bounds.top + bounds.height / 2;
      } else {
        const visible = rowViews.filter((item) => !item.line.hidden);
        if (!visible.length) return null;
        const first = visible[0], last = visible[visible.length - 1];
        if (event.clientY < first.line.getBoundingClientRect().top) { view = first; after = false; }
        else if (event.clientY >= last.line.getBoundingClientRect().bottom) { view = last; after = true; }
        else return null;
      }
      const from = table.rows.indexOf(draggedRow), target = table.rows.indexOf(view.row);
      let index = target + (after ? 1 : 0); if (from < index) index--;
      return from < 0 || target < 0 || from === index ? null : { view, after };
    }
    function updateRowDrop(event) {
      const next = findRowDrop(event);
      if (dropTarget && next && dropTarget.view === next.view && dropTarget.after === next.after) return;
      clearDropTarget(); dropTarget = next;
      if (dropTarget) dropTarget.view.line.classList.add(dropTarget.after ? 'parameter-drop-after' : 'parameter-drop-before');
    }
    // Pointer capture keeps wheel scrolling available while a row is held.
    scroller.addEventListener('scroll', () => {
      if (!rowDrag || !draggedRow || rowDragFrame) return;
      rowDragFrame = global.requestAnimationFrame(() => {
        rowDragFrame = 0;
        if (rowDrag && acceptsRowDrag()) updateRowDrop({ clientX: rowDrag.x, clientY: rowDrag.y });
        else clearRowDrag();
      });
    }, { passive: true });
    const valueSource = { parameterTables: [table.id] };
    function refreshValues() {
      const context = { stack: [], values: new Map() };
      const names = parameterNameCounts(table.rows);
      rowViews.forEach((view) => view.updateValue(context, names));
      if (matrixView) matrixView.refresh();
    }
    function refreshCommittedCell() {
      refreshValues();
      if (referenceRefresh) referenceRefresh();
      const treeRow = Array.from($('parameter-tree').querySelectorAll('[data-table-id]')).find((item) => item.dataset.tableId === table.id);
      if (treeRow) treeRow.querySelector('.parameter-count').textContent = table.rows.filter((item) => item.name).length;
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
      rowDropViews.set(line, view);
      line.addEventListener('click', () => selectRow(row, line));
      line.addEventListener('focusin', () => selectRow(row, line));
      line.setAttribute('aria-selected', 'false');
      if (selectedRow === row) selectRow(row, line);
      ['name', 'val', 'description'].forEach((field) => {
        const td = element('td'); const fieldBox = element('div', 'parameter-cell');
        const input = element(field === 'name' ? 'input' : 'textarea');
        if (field === 'name') {
          const jump = button('正在查找引用...', (event) => {
            event.stopPropagation();
            const documents = view.references || [];
            if (!documents.length) return;
            if (documents.length > 1) chooseReference(documents, table.id, String(row.name || ''), jump);
            else void jumpToReference(documents[0], table.id, String(row.name || '')).catch(referenceError);
          }, 'external');
          jump.disabled = true; jump.classList.add('parameter-reference-jump'); view.jump = jump;
          fieldBox.append(jump);
          const handle = button('选中第 ' + (index + 1) + ' 行', () => selectRow(row, line));
          handle.className = 'parameter-row-select';
          handle.addEventListener('pointerdown', (event) => {
            if (event.button !== 0 || !event.isPrimary || modal || activePage !== 'parameters' || selectedTable !== table.id || !catalog.tables.includes(table)) return;
            event.preventDefault(); event.stopPropagation(); clearRowDrag();
            handle.focus({ preventScroll: true }); selectRow(row, line);
            rowDrag = { handle, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY };
            global.addEventListener('keydown', cancelRowDrag, true);
            global.addEventListener('blur', clearRowDrag);
            global.addEventListener('lostpointercapture', rowPointerReleased, true);
            try { handle.setPointerCapture(event.pointerId); }
            catch (_) { clearRowDrag(); }
          });
          handle.addEventListener('pointermove', (event) => {
            if (!rowDrag || rowDrag.pointerId !== event.pointerId) return;
            rowDrag.x = event.clientX; rowDrag.y = event.clientY;
            if (!draggedRow) {
              if (Math.hypot(event.clientX - rowDrag.startX, event.clientY - rowDrag.startY) < 4) return;
              draggedRow = row; draggedLine = line;
              line.classList.add('parameter-row-dragging'); scroller.classList.add('parameter-row-reordering');
            }
            event.preventDefault(); updateRowDrop(event);
          });
          handle.addEventListener('pointerup', (event) => {
            if (!rowDrag || rowDrag.pointerId !== event.pointerId) return;
            const target = findRowDrop(event), moving = draggedRow;
            clearRowDrag();
            if (target) moveParameterRow(table, moving, target.view.row, target.after);
          });
          handle.addEventListener('pointercancel', clearRowDrag);
          handle.addEventListener('lostpointercapture', clearRowDrag);
          const marker = element('span', 'parameter-row-error'); marker.hidden = true; marker.setAttribute('aria-hidden', 'true');
          marker.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="lucide">' + paths.close + '</svg>';
          handle.replaceChildren(marker, element('span', 'parameter-row-number', index + 1));
          view.rowError = marker; view.rowHandle = handle; view.nameInput = input;
          fieldBox.append(handle);
        }
        input.value = row[field] == null ? '' : String(row[field]); input.setAttribute('aria-label', '第 ' + (index + 1) + ' 行 ' + field);
        input.dataset.parameterField = field;
        input.spellcheck = false; if (field !== 'name') input.rows = 1;
        const resize = () => { if (field !== 'name' && !line.hidden) global.VWDParameterMatrixView.resizeTextareas([input]); };
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
            view.rowHandle.title = '选中第 ' + (index + 1) + ' 行，按住拖动调整顺序' + (rowError ? '\n' + rowError : '');
            if (rowError) view.rowHandle.setAttribute('aria-description', rowError);
            else view.rowHandle.removeAttribute('aria-description');
            view.nameInput.setAttribute('aria-invalid', String(!!nameError)); view.nameInput.title = nameError;
            const valueChanged = document.activeElement !== input && input.value !== result.val;
            if (valueChanged) input.value = result.val;
            const isFormula = result.formula && !result.error;
            const numericValue = Number(result.val);
            input.classList.toggle('parameter-formula-value', isFormula);
            input.classList.toggle('parameter-negative-value', !result.error && Number.isFinite(numericValue) && numericValue < 0);
            input.setAttribute('aria-invalid', String(!!result.error));
            input.title = result.formula ? '公式：' + result.rawVal : '';
            input.placeholder = '';
            error.hidden = !result.error; error.textContent = result.error;
            if (input.isConnected && valueChanged) resize();
          };
          input.addEventListener('focus', () => { input.value = row.val == null ? '' : String(row.val); resize(); });
          fieldBox.append(error);
        }
        input.addEventListener('input', () => {
          editParameterCell(table, row, field, input, refreshCommittedCell);
          resize();
        });
        input.addEventListener('beforeinput', (event) => {
          if (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo') return;
          event.preventDefault(); applyParameterHistory(event.inputType === 'historyRedo');
        });
        input.addEventListener('blur', () => {
          const committed = activeCellEdit && activeCellEdit.input === input && commitParameterCell();
          if (!committed) refreshValues();
          void flush(false).catch(() => {});
        });
        input.addEventListener('keydown', (event) => {
          if (event.isComposing || field === 'description') return;
          if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) { event.preventDefault(); event.stopPropagation(); input.blur(); }
          if (event.key === 'Escape') {
            event.preventDefault(); event.stopPropagation();
            if (activeCellEdit && activeCellEdit.input === input) { activeCellEdit = null; notifyParameterHistory(); }
            input.value = String(row[field] ?? ''); input.blur();
          }
        });
        if (field === 'val') fieldBox.prepend(input);
        else fieldBox.append(input);
        td.append(fieldBox); line.append(td);
        requestAnimationFrame(resize);
      });
      body.append(line);
    });
    const emptyRow = element('tr'), emptyCell = element('td', 'parameter-empty'); emptyCell.colSpan = 3;
    emptyCell.id = 'parameter-filter-message';
    emptyRow.append(emptyCell); body.append(emptyRow);
    function applyFilters() {
      const name = rowFilters.name.trim().toLowerCase(), val = rowFilters.val.trim().toLowerCase();
      const comparison = val.match(/^(>=|<=|>|<)\s*(.*)$/);
      const limit = comparison ? Number(comparison[2]) : 0;
      const filterError = comparison && (!numericPattern.test(comparison[2]) || !Number.isFinite(limit))
        ? '比较符后需要有效数字，例如 >1 或 <=-0.5' : '';
      filterInputs.val.setAttribute('aria-invalid', String(!!filterError));
      filterInputs.val.title = filterError;
      if (filterError) filterInputs.val.setAttribute('aria-describedby', emptyCell.id);
      else filterInputs.val.removeAttribute('aria-describedby');
      let count = 0;
      const matches = (result) => {
          const displayedValue = String(result ? result.val ?? '' : '').trim();
          let matchesValue;
          if (comparison) {
            const value = Number(displayedValue);
            matchesValue = !filterError && !(result && result.error)
              && numericPattern.test(displayedValue) && Number.isFinite(value);
            if (matchesValue) {
              switch (comparison[1]) {
                case '>': matchesValue = value > limit; break;
                case '<': matchesValue = value < limit; break;
                case '>=': matchesValue = value >= limit; break;
                case '<=': matchesValue = value <= limit; break;
              }
            }
          } else {
            matchesValue = String(result ? result.rawVal ?? '' : '').toLowerCase().includes(val)
              || displayedValue.toLowerCase().includes(val);
          }
          return matchesValue;
      };
      if (matrixView) matrixView.filterReferences(matches);
      rowViews.forEach((view) => {
        const visible = String(view.row.name ?? '').toLowerCase().includes(name)
          && (matrixView ? matrixView.visible(view, matches) : matches(view.valueResult));
        const wasHidden = view.line.hidden; view.line.hidden = !visible;
        if (visible) count++;
        else if (selectedRow === view.row) selectRow(null, null);
        if (visible && wasHidden) requestAnimationFrame(() => view.resize.forEach((resize) => resize()));
      });
      emptyRow.hidden = count > 0;
      emptyCell.textContent = filterError || (name || val ? '没有匹配的变量' : '暂无变量');
      emptyCell.classList.toggle('parameter-value-error', !!filterError);
      filterCount.textContent = count + ' / ' + table.rows.length;
      clearFilters.disabled = !rowFilters.name && !rowFilters.val;
    }
    matrixView = global.VWDParameterMatrixView.attach({ table, toolbar, grid, headRow: tr, rows: rowViews, workspace, emptyCell, scroller,
      filters: rowFilters, element, button, id, status, commit: commitParameterCell,
      patch: (patches, render) => patchMatrix(table, patches, render),
      editSource: (source, row, field, input, original) => {
        if (activeCellEdit && activeCellEdit.input !== input) commitParameterCell();
        activeCellEdit = input.value === original ? null : { input, original, commit: () => {
          if (!catalog.tables.includes(source) || !source.rows.includes(row)) { status('源参数已变化，请重新编辑', true); return; }
          patchMatrix(table, [{ target: row, field, value: input.value, sourceTableId: source.id }]);
          renderTree(); refreshCommittedCell(); applyFilters();
        } };
        notifyParameterHistory();
      },
      history: applyParameterHistory,
      tables: effectiveTables, resolve: (column, row, context) => resolveParameterRow(column, row, { parameterTables: [column.id] }, context),
      refresh: () => { refreshCommittedCell(); applyFilters(); }, filter: applyFilters,
      references: (event) => openTableReferences(table, event.currentTarget),
      orderReferences: (event) => openTableReferences(table, event.currentTarget, true),
      rawTables: () => catalog.tables,
      open: (key) => { void bridge.openTable(key).catch((error) => status(error.message, true)); },
      showSource: (key) => {
        commitParameterCell();
        const source = catalog.tables.find((item) => item.id === key);
        if (!source) return;
        if (standaloneTableId) { void bridge.openTable(key).catch((error) => status(error.message, true)); return; }
        selectedTable = source.id; selectedFolder = source.parentId || '';
        folderAncestors(selectedFolder).forEach((key) => expanded.add(key));
        renderTree(); renderTable(); focusTreeItem('tableId', source.id);
      },
      sourceTable: (key) => catalog.tables.find((item) => item.id === key),
      export: exportParameterTableToml, compare: openComparison
    });
    matrixDispose = matrixView.dispose;
    refreshValues(); applyFilters();
    grid.append(body); scroller.prepend(grid); workspace.append(scroller);
    referenceRefresh = () => { void updateReferenceButtons(table, rowViews, workspace); };
    referenceRefresh();
  }
  async function switchPage(page) {
    if (standaloneTableId) return;
    if (page === activePage) return;
    if (page === 'parameters') {
      try { await refresh(); } catch (error) { if (bridge) bridge.status(error.message); if (!catalogLoadError) return; }
    }
    activePage = page;
    $('parameter-workspace').hidden = page !== 'parameters';
    $('parameter-directory-page').hidden = page !== 'parameters';
    $('wave-directory-page').hidden = page !== 'wave';
    document.querySelector('.app > main.main').hidden = page !== 'wave';
    $('wave-directory-tab').setAttribute('aria-selected', String(page === 'wave'));
    $('parameter-directory-tab').setAttribute('aria-selected', String(page === 'parameters'));
    document.body.classList.toggle('parameter-page-active', page === 'parameters');
    window.dispatchEvent(new CustomEvent('vwd-directory-page-change'));
    if (page === 'wave' && bridge) bridge.changed();
    if (page === 'parameters' && referenceRefresh) referenceRefresh();
    notifyParameterHistory();
  }
  function compareTables(left, right) {
    function indexRows(table) {
      const groups = new Map(), names = parameterNameCounts(table.rows);
      const context = { stack: [], values: new Map(), tables: new Map([[table.id, table]]) }, source = { parameterTables: [table.id] };
      table.rows.forEach((row, index) => {
        if (['name', 'val', 'description'].every((field) => !String(row[field] ?? '').trim())) return;
        const name = String(row.name || ''), key = name || Symbol();
        const value = resolveParameterRow(table, row, source, context);
        const entry = { index, row, table, raw: value.rawVal, value: value.val, formula: value.formula,
          description: String(row.description ?? ''),
          error: [name ? parameterRowNameError(row, names) : '变量名不能为空', value.error].filter(Boolean).join('\n') };
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(entry);
      });
      return groups;
    }
    const a = indexRows(left), b = indexRows(right);
    return Array.from(new Set([...a.keys(), ...b.keys()]), (key) => {
      const l = a.get(key) || [], r = b.get(key) || [];
      const entry = { name: typeof key === 'string' ? key : '第 ' + ((l[0] || r[0]).index + 1) + ' 行（无变量名）',
        left: l, right: r, kind: 'same', reasons: [], flags: {} };
      if (l.concat(r).some((item) => item.error)) entry.kind = 'error';
      else if (!l.length) entry.kind = 'right';
      else if (!r.length) entry.kind = 'left';
      else {
        entry.flags.raw = l[0].raw !== r[0].raw;
        entry.flags.value = l[0].value !== r[0].value;
        entry.flags.description = l[0].description !== r[0].description;
        if (entry.flags.raw) entry.reasons.push(l[0].formula || r[0].formula ? '公式不同' : '变量值不同');
        if (entry.flags.value && !entry.reasons.includes('变量值不同')) entry.reasons.push('计算结果不同');
        if (entry.flags.description) entry.reasons.push('说明不同');
        if (entry.reasons.length) entry.kind = 'different';
      }
      return entry;
    });
  }
  function openComparison(tableId, anchor) {
    if (modal) return;
    const identity = libraryId, drafts = new Map(), editedRows = new Map();
    const fields = ['name', 'val', 'description'], draftUndo = [], draftRedo = [];
    let editor = null, busy = false;
    function draftTable(id) {
      if (!drafts.has(id)) {
        const table = effectiveTable(id);
        if (table) {
          const draft = clone(table);
          drafts.set(id, { base: clone(table), draft, missingRows: new Map(), compared: { table: clone(table), rows: draft.rows.slice() } });
        }
      }
      return drafts.has(id) ? drafts.get(id).draft : null;
    }
    function formChanged() {
      return editor && editor.forms.some((form) => form.create
        || fields.some((field) => form.inputs[field].value !== String(form.item.row[field] ?? '')));
    }
    function hasChanges() { return editedRows.size > 0 || formChanged(); }
    const overlay = element('div', 'modal-overlay parameter-modal');
    const dialog = element('div', 'modal-dialog parameter-compare-dialog');
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'parameter-compare-title');
    const header = element('div', 'modal-header');
    const heading = element('h2', '', '参数表比较'); heading.id = 'parameter-compare-title';
    function close(discard) {
      if (busy) return;
      if (discard !== true) applyEditor();
      if (discard !== true && hasChanges()) { message.textContent = '本次修改尚未保存，请选择“保存修改”或“不保存”。'; return; }
      global.removeEventListener('keydown', onKey, true);
      global.removeEventListener('beforeunload', onUnload);
      overlay.remove(); modal = null;
      const target = anchor && anchor.isConnected ? anchor : document.querySelector('.parameter-compare-open');
      if (target) target.focus({ preventScroll: true });
    }
    const closeButton = button('关闭比较', () => close(), 'close'); header.append(heading, closeButton); dialog.append(header);
    const controls = element('div', 'parameter-compare-controls');
    function tableSelect(caption) {
      const label = element('label', 'parameter-compare-select'), select = element('select');
      select.setAttribute('aria-label', caption); select.add(new Option('选择参数表', ''));
      effectiveTables().forEach((table) => select.add(new Option((folderPath(table.parentId) || '根目录') + ' / ' + table.name, table.id)));
      label.append(element('span', '', caption), select); return { label, select };
    }
    const left = tableSelect('左侧参数表'), right = tableSelect('右侧参数表'); left.select.value = tableId;
    right.select.value = (effectiveTables().find((table) => table.id !== tableId) || {}).id || '';
    const swap = button('交换左右参数表', () => {
      const previous = left.select.value; left.select.value = right.select.value; right.select.value = previous; rebuild();
    }, 'swap');
    controls.append(left.label, swap, right.label); dialog.append(controls);
    const filters = element('div', 'parameter-compare-filters');
    const search = element('input'); search.type = 'search'; search.placeholder = '筛选变量名'; search.setAttribute('aria-label', '比较中筛选变量名');
    const onlyDifferent = element('input'); onlyDifferent.type = 'checkbox'; onlyDifferent.checked = true;
    const onlyLabel = element('label', 'parameter-compare-toggle'); onlyLabel.append(onlyDifferent, element('span', '', '只看差异'));
    filters.append(search, onlyLabel); dialog.append(filters);
    const summary = element('div', 'parameter-compare-summary'); summary.setAttribute('role', 'status'); dialog.append(summary);
    const scroll = element('div', 'parameter-compare-scroll'); scroll.tabIndex = 0; scroll.setAttribute('aria-label', '参数表比较结果');
    const grid = element('table', 'parameter-compare-grid'), head = element('thead'), headers = element('tr');
    const leftHeading = element('th'), rightHeading = element('th');
    headers.append(element('th', '', '变量名 / 比较结果'), leftHeading, rightHeading);
    Array.from(headers.children).forEach((th) => { th.scope = 'col'; }); head.append(headers);
    const body = element('tbody'); grid.append(head, body); scroll.append(grid); dialog.append(scroll);
    const footer = element('div', 'modal-footer parameter-compare-footer');
    const pageInfo = element('span');
    const previous = button('上一页', () => { page--; render(); }, 'left');
    const next = button('下一页', () => { page++; render(); }, 'right');
    const undoDraft = button('撤销比较修改', () => draftHistory(false), 'undo');
    const redoDraft = button('重做比较修改', () => draftHistory(true), 'redo');
    const save = button('保存修改', () => { void saveChanges(); }); save.classList.add('primary');
    const refreshCompare = button('更新比较', () => {
      applyEditor();
      [left.select.value, right.select.value].forEach((id) => {
        const state = drafts.get(id);
        if (state) {
          state.compared = { table: clone(state.draft), rows: state.draft.rows.slice() };
          state.missingRows.clear();
        }
      });
      message.textContent = editedRows.size ? '比较结果已更新，修改尚未保存。' : '比较结果已更新。';
      rebuild(true);
    });
    const discard = button('不保存', () => close(true));
    const message = element('div', 'parameter-compare-message'); message.setAttribute('role', 'status');
    dialog.append(message);
    footer.append(pageInfo, previous, next, undoDraft, redoDraft, discard, refreshCompare, save); dialog.append(footer);
    const labels = { same: '相同', different: '不同', left: '仅左侧', right: '仅右侧', error: '异常' };
    let records = [], page = 0, problem = ''; const pageSize = 100;
    function updateActions() {
      save.disabled = busy || !hasChanges(); discard.disabled = closeButton.disabled = busy;
      save.textContent = busy ? '正在保存...' : '保存修改';
      undoDraft.disabled = busy || (!draftUndo.length && !formChanged());
      redoDraft.disabled = busy || !!formChanged() || !draftRedo.length;
      refreshCompare.disabled = busy || !!problem;
      [left.select, right.select, swap, search, onlyDifferent].forEach((input) => { input.disabled = busy; });
      dialog.querySelectorAll('.parameter-compare-edit').forEach((input) => { input.disabled = busy; });
      if (busy) previous.disabled = next.disabled = true;
    }
    function trackRow(item) {
      const index = item.table.rows.indexOf(item.row), base = drafts.get(item.table.id).base.rows[index];
      if (index >= 0 && (!base || fields.some((field) => item.row[field] !== base[field]))) editedRows.set(item.row, item);
      else editedRows.delete(item.row);
    }
    function draftHistory(redo) {
      if (busy) return;
      applyEditor();
      const from = redo ? draftRedo : draftUndo, to = redo ? draftUndo : draftRedo;
      const entry = from.pop(); if (!entry) return;
      (redo ? entry : entry.slice().reverse()).forEach((change) => {
        const value = redo ? change.after : change.before;
        if (change.added) {
          if (redo) change.item.table.rows.splice(Math.min(change.index, change.item.table.rows.length), 0, change.item.row);
          else change.item.table.rows.splice(change.item.table.rows.indexOf(change.item.row), 1);
        }
        fields.forEach((field) => {
          if (Object.prototype.hasOwnProperty.call(value, field)) change.item.row[field] = value[field];
          else delete change.item.row[field];
        });
        trackRow(change.item);
      });
      to.push(entry); message.textContent = '已暂存修改，比较结果待更新。'; render(true); scroll.focus({ preventScroll: true });
    }
    function applyEditor() {
      if (!editor) return;
      const active = editor, changes = [];
      editor = null;
      active.forms.forEach(({ item, inputs, create }) => {
        const before = clone(item.row), index = item.table.rows.indexOf(item.row), added = index < 0;
        if (added && !create && fields.every((field) => inputs[field].value === String(item.row[field] ?? ''))) return;
        const base = drafts.get(item.table.id).base.rows[index] || {};
        fields.forEach((field) => {
          const value = field === 'name' ? inputs[field].value.trim() : inputs[field].value;
          if (value === String(base[field] ?? '')) {
            if (Object.prototype.hasOwnProperty.call(base, field)) item.row[field] = base[field];
            else delete item.row[field];
          } else item.row[field] = value;
        });
        if (added) item.table.rows.push(item.row);
        if (added || fields.some((field) => before[field] !== item.row[field])) {
          changes.push({ item, before, after: clone(item.row), added, index: item.table.rows.indexOf(item.row) });
          trackRow(item);
        }
      });
      if (changes.length) {
        draftUndo.push(changes);
        if (draftUndo.length > 50) draftUndo.shift();
        draftRedo.length = 0;
        message.textContent = '已暂存修改，比较结果待更新。';
      }
      const scrollTop = scroll.scrollTop;
      renderEntry(active.tr, active.entry);
      scroll.scrollTop = scrollTop; updateActions();
      if (!overlay.contains(document.activeElement)) scroll.focus({ preventScroll: true });
    }
    function entryItems(entry, side) {
      if (entry[side].length) return entry[side];
      const table = draftTable(entry.tableIds[side]), state = drafts.get(table.id);
      const other = entry[side === 'left' ? 'right' : 'left'][0];
      const name = other ? other.name : '';
      if (!state.missingRows.has(name)) state.missingRows.set(name, { name, val: '', description: '' });
      return [{ table, row: state.missingRows.get(name), name }];
    }
    function openEditor(entry, tr, side, selectedItem) {
      if (busy) return;
      applyEditor();
      const forms = [];
      editor = { entry, tr, forms }; tr.classList.add('editing');
      ['left', 'right'].forEach((currentSide, column) => {
        const td = tr.children[column + 1]; td.replaceChildren();
        entryItems(entry, currentSide).forEach((item) => {
          const form = element('div', 'parameter-compare-editor'), inputs = {};
          const captions = { name: '变量名', val: '变量值 / 公式', description: '变量说明' };
          form.setAttribute('role', 'group'); form.setAttribute('aria-label', (currentSide === 'left' ? '左侧' : '右侧') + '参数编辑');
          fields.forEach((field) => {
            const label = element('label'), input = element(field === 'name' ? 'input' : 'textarea');
            input.value = String(item.row[field] ?? ''); input.dataset.compareField = field;
            input.setAttribute('aria-label', captions[field]); input.spellcheck = false;
            if (field !== 'name') input.rows = 3;
            input.addEventListener('input', updateActions);
            label.append(element('span', '', captions[field]), input); form.append(label); inputs[field] = input;
          });
          forms.push({ item, inputs, create: item.row === selectedItem.row && !item.table.rows.includes(item.row), side: currentSide });
          td.append(form);
        });
      });
      updateActions();
      const focused = forms.find((form) => form.side === side && form.item.row === selectedItem.row) || forms[0];
      focused.inputs.val.focus({ preventScroll: true });
    }
    async function saveChanges() {
      if (busy) return;
      applyEditor();
      if (!editedRows.size) { close(true); return; }
      busy = true; comparisonCommit = true; updateActions(); message.textContent = '正在保存修改...';
      clearTimeout(timer);
      try {
        if (saving) { try { await saving; } catch (_) { /* Validate the repaired draft below before retrying. */ } }
        if (identity !== libraryId) throw new Error('波形库已切换，请重新打开比较。');
        const current = catalog, at = dirty, candidate = clone(current), changes = [], additions = [];
        if ([...editedRows.values()].some((item) => {
          const owner = matrix.owner(current.tables, item.table.id);
          return item.table.referenceOwnerId || owner && owner.references && owner.references.length;
        })) {
          const grouped = new Map();
          editedRows.forEach((item) => {
            const live = effectiveTable(item.table.id), baseline = drafts.get(item.table.id).base;
            if (!live || JSON.stringify(live.rows) !== JSON.stringify(baseline.rows)) throw new Error('参数表“' + item.table.name + '”已变化，请重新打开比较');
            if (!grouped.has(item.table.id)) grouped.set(item.table.id, []);
            const index = item.table.rows.indexOf(item.row);
            grouped.get(item.table.id).push({ before: baseline.rows[index], after: item.row });
          });
          grouped.forEach((edits, key) => matrix.editEffective(candidate.tables, key, edits, id));
          validate(candidate);
          let saved;
          try { saving = bridge.save(candidate, current.revision); saved = await saving; }
          finally { saving = null; }
          if (identity !== libraryId || current !== catalog || at !== dirty) throw new Error('保存期间参数发生变化，请重新打开比较');
          const patches = [];
          candidate.tables.forEach((next) => {
            const original = current.tables.find((item) => item.id === next.id);
            if (JSON.stringify(original) === JSON.stringify(next)) return;
            const rows = next.rows.map((row) => {
              const existing = original.rows.find((item) => item.id === row.id);
              if (!existing) return row;
              ['name', 'val', 'description'].forEach((field) => {
                if (existing[field] !== row[field] || matrix.own(existing, field) !== matrix.own(row, field)) patches.push({ target: existing, field, value: row[field], present: matrix.own(row, field) });
              });
              return existing;
            });
            if (rows.length !== original.rows.length) patches.push({ target: original, field: 'rows', value: rows });
          });
          const operations = patches.map((patch) => ({ ...patch, before: patch.target[patch.field], beforePresent: matrix.own(patch.target, patch.field), present: patch.present !== false }));
          if (operations.length) recordParameterHistory({ kind: 'matrix-patch', tableId: matrix.owner(current.tables, grouped.keys().next().value).id, changes: operations });
          operations.forEach((patch) => { if (patch.present) patch.target[patch.field] = patch.value; else delete patch.target[patch.field]; });
          catalog.revision = saved.revision; dirty++; savedGeneration = dirty; failure = '';
          invalidate(); renderTree(); renderTable(); notifyParameterHistory();
          if (channel) channel.postMessage({ libraryId, catalog: saved });
          status('比较修改已保存到工作库'); busy = false; close(true); return;
        }
        const checked = new Set();
        editedRows.forEach((item) => {
          const table = current.tables.find((entry) => entry.id === item.table.id);
          if (!checked.has(item.table.id)) {
            if (!table || JSON.stringify(table.rows) !== JSON.stringify(drafts.get(item.table.id).base.rows)) {
              throw new Error('参数表“' + item.table.name + '”已被其他窗口修改或删除。请保留所需内容后重新打开比较，避免覆盖。');
            }
            checked.add(item.table.id);
          }
          const index = item.table.rows.indexOf(item.row);
          if (index >= drafts.get(table.id).base.rows.length) {
            additions.push({ tableId: table.id, row: clone(item.row), index }); return;
          }
          const target = candidate.tables.find((entry) => entry.id === table.id).rows[index], row = table.rows[index];
          fields.forEach((field) => {
            if (row[field] === item.row[field]) return;
            changes.push({ tableId: table.id, row, field, before: row[field], beforePresent: Object.prototype.hasOwnProperty.call(row, field), after: item.row[field] });
            target[field] = item.row[field];
          });
        });
        additions.sort((a, b) => a.index - b.index);
        additions.forEach((item) => {
          const table = candidate.tables.find((entry) => entry.id === item.tableId);
          table.rows.splice(Math.min(item.index, table.rows.length), 0, item.row);
        });
        validate(candidate);
        // Persist the candidate before touching live rows, so a failed save can still be discarded.
        saving = (async () => {
          const saved = await bridge.save(candidate, current.revision);
          if (identity !== libraryId || current !== catalog || at !== dirty) throw new Error('保存期间原参数表发生变化，请重新打开比较。');
          additions.forEach((item) => {
            const table = catalog.tables.find((entry) => entry.id === item.tableId);
            table.rows.splice(Math.min(item.index, table.rows.length), 0, item.row);
          });
          changes.forEach((change) => { change.row[change.field] = change.after; });
          recordParameterHistory({ kind: 'cell-batch', changes, additions });
          catalog.revision = saved.revision; dirty++; savedGeneration = dirty; failure = '';
          invalidate(); renderTree(); renderTable(); notifyParameterHistory();
          if (channel) channel.postMessage({ libraryId, catalog: saved });
          status('比较修改已保存到工作库');
        })().finally(() => { saving = null; });
        await saving;
        busy = false; close(true);
      } catch (error) {
        message.textContent = '保存失败：' + error.message;
      } finally {
        busy = false; comparisonCommit = false; updateActions();
        if (dirty !== savedGeneration) timer = setTimeout(() => { void flush(false).catch(() => {}); }, 220);
      }
    }
    function cell(entry, side, tr) {
      const items = entryItems(entry, side), flags = entry.flags;
      const td = element('td');
      items.forEach((item) => {
        const content = element('div', 'parameter-compare-entry');
        const missing = !item.table.rows.includes(item.row);
        const edit = button((missing ? '添加 ' : '编辑 ') + item.table.name + ' 的 ' + (item.row.name || '参数'), () => openEditor(entry, tr, side, item), missing ? 'plus' : 'edit');
        edit.classList.add('parameter-compare-edit'); content.append(edit);
        if (missing) { content.append(element('span', 'parameter-compare-missing', '无此变量')); td.append(content); return; }
        const raw = String(item.row.val ?? ''), description = String(item.row.description ?? '');
        const stale = item.raw !== raw || item.name !== item.row.name || item.description !== description;
        if (editedRows.has(item.row)) content.append(element('small', 'parameter-compare-unsaved', '未保存'));
        if (stale) content.append(element('small', 'parameter-compare-pending', '待更新比较'));
        if (items.length > 1) content.append(element('small', '', '第 ' + (item.index + 1) + ' 行'));
        if (item.row.name !== item.name) content.append(element('strong', '', item.row.name || '（无变量名）'));
        content.append(element('div', 'parameter-compare-value' + (flags.value ? ' difference' : ''), stale ? raw || '（空）' : item.error ? '存在异常' : item.value || '（空）'));
        if (!stale && (item.formula || item.error)) {
          content.append(element('small', '', item.formula ? '公式' : '原值'));
          content.append(element('code', 'parameter-compare-raw' + (flags.raw ? ' difference' : ''), item.raw || '（空）'));
        }
        if (description || flags.description) {
          content.append(element('small', '', '说明'));
          content.append(element('div', 'parameter-compare-description' + (flags.description ? ' difference' : ''), description || '（空）'));
        }
        if (!stale && item.error) content.append(element('div', 'parameter-compare-error', item.error));
        td.append(content);
      });
      return td;
    }
    function renderEntry(tr, entry) {
      tr.classList.remove('editing'); tr.dataset.kind = entry.kind; tr.dataset.name = entry.name;
      const name = element('th'); name.scope = 'row'; name.append(element('strong', '', entry.name));
      name.append(element('span', 'parameter-compare-state ' + entry.kind, labels[entry.kind]));
      if (entry.reasons.length) name.append(element('small', '', entry.reasons.join('、')));
      tr.replaceChildren(name, cell(entry, 'left', tr), cell(entry, 'right', tr));
    }
    function render(preserveScroll) {
      applyEditor();
      const scrollTop = scroll.scrollTop;
      const query = search.value.trim().toLowerCase();
      const filtered = records.filter((entry) => (!onlyDifferent.checked || entry.kind !== 'same') && entry.name.toLowerCase().includes(query));
      page = Math.max(0, Math.min(page, Math.ceil(filtered.length / pageSize) - 1));
      const start = page * pageSize, shown = filtered.slice(start, start + pageSize);
      body.replaceChildren();
      shown.forEach((entry) => {
        const tr = element('tr'); renderEntry(tr, entry); body.append(tr);
      });
      if (!shown.length) {
        const tr = element('tr'), td = element('td', 'parameter-empty'); td.colSpan = 3;
        td.textContent = problem || (query ? '没有匹配的变量' : !records.length ? '两张参数表均无变量' : '没有差异，两张参数表内容相同');
        tr.append(td); body.append(tr);
      }
      pageInfo.textContent = filtered.length ? (start + 1) + '-' + (start + shown.length) + ' / ' + filtered.length : '0 / 0';
      previous.disabled = !page; next.disabled = start + pageSize >= filtered.length; scroll.scrollTop = preserveScroll ? scrollTop : 0;
      updateActions();
    }
    function rebuild(preserveScroll) {
      applyEditor();
      const l = draftTable(left.select.value), r = draftTable(right.select.value);
      leftHeading.textContent = l ? l.name : '左侧参数表'; rightHeading.textContent = r ? r.name : '右侧参数表';
      problem = !l || !r ? (effectiveTables().length < 2 ? '当前波形库不足两张参数表' : '请选择两张参数表') : l.id === r.id ? '请选择两张不同的参数表' : '';
      records = [];
      if (!problem) {
        const a = drafts.get(l.id).compared, b = drafts.get(r.id).compared;
        // Pair selection uses the last explicit comparison snapshots, not unapplied draft results.
        records = compareTables(a.table, b.table);
        records.forEach((entry) => {
          entry.tableIds = { left: l.id, right: r.id };
          ['left', 'right'].forEach((side) => {
            const snapshot = side === 'left' ? a : b, table = side === 'left' ? l : r;
            entry[side].forEach((item) => {
              item.name = String(item.row.name || ''); item.row = snapshot.rows[item.index]; item.table = table;
            });
          });
        });
      }
      if (preserveScroll !== true) page = 0;
      const counts = { same: 0, different: 0, left: 0, right: 0, error: 0 }; records.forEach((entry) => counts[entry.kind]++);
      summary.textContent = problem || '共 ' + records.length + ' 项 · ' + Object.keys(counts).map((key) => labels[key] + ' ' + counts[key]).join(' · ');
      render(preserveScroll === true);
    }
    function onKey(event) {
      if (!overlay.contains(event.target)) return;
      event.stopPropagation();
      if (busy) { event.preventDefault(); return; }
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault();
        if (editor) { applyEditor(); scroll.focus({ preventScroll: true }); } else close();
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.isComposing && editor) { event.preventDefault(); applyEditor(); }
      if (!isTextInput(event.target)) {
        const action = bridge && bridge.historyShortcut ? bridge.historyShortcut(event) : '';
        if (action) { event.preventDefault(); draftHistory(action === 'redo'); }
      }
      if (event.key === 'Tab') {
        const inputs = Array.from(dialog.querySelectorAll('button:not(:disabled),select:not(:disabled),input:not(:disabled),textarea,[tabindex="0"]'));
        if (event.shiftKey && event.target === inputs[0]) { event.preventDefault(); inputs[inputs.length - 1].focus(); }
        else if (!event.shiftKey && event.target === inputs[inputs.length - 1]) { event.preventDefault(); inputs[0].focus(); }
      }
    }
    left.select.addEventListener('change', rebuild); right.select.addEventListener('change', rebuild);
    search.addEventListener('input', () => { page = 0; render(); }); onlyDifferent.addEventListener('change', () => { page = 0; render(); });
    let startedOutside = false, startedInEditor = false;
    overlay.addEventListener('pointerdown', (event) => {
      startedOutside = event.target === overlay;
      startedInEditor = !!editor && editor.tr.contains(event.target) && !!event.target.closest('.parameter-compare-editor');
    });
    overlay.addEventListener('click', (event) => {
      if (busy || !editor || event.target.closest('.parameter-compare-editor, .parameter-compare-edit')) return;
      if (event.detail && startedInEditor) return;
      applyEditor();
    }, true);
    overlay.addEventListener('click', (event) => { if (startedOutside && event.target === overlay) close(); });
    modal = overlay; overlay.append(dialog); document.body.append(overlay);
    function onUnload(event) { if (busy || hasChanges()) { event.preventDefault(); event.returnValue = ''; } }
    global.addEventListener('beforeunload', onUnload);
    global.addEventListener('keydown', onKey, true); rebuild(); right.select.focus();
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
    function openTableButton(table) {
      const open = button(table ? '单独打开参数表：' + table.name : '参数表已删除，无法单独打开', async (event) => {
        event.preventDefault(); event.stopPropagation();
        open.disabled = true; message.textContent = '';
        try { await bridge.openTable(table.id); }
        catch (error) { message.textContent = error.message; }
        finally { open.disabled = false; }
      }, 'external');
      open.classList.add('parameter-link-open'); open.disabled = !table;
      if (table) open.dataset.tableId = table.id;
      open.addEventListener('dragstart', (event) => { event.preventDefault(); event.stopPropagation(); });
      return open;
    }
    function renderLists() {
      const focused = document.activeElement;
      const focusRow = focused && focused.closest('.parameter-priority-row');
      const focusId = focusRow ? focusRow.dataset.tableId : focused && focused.dataset.tableId;
      const focusLabel = focused && focused.getAttribute('aria-label');
      choices.replaceChildren(); priority.replaceChildren();
      effectiveTables().filter((table) => (folderPath(table.parentId) + table.name).toLowerCase().includes(search.value.toLowerCase())).forEach((table) => {
        const row = element('div', 'parameter-choice-row');
        const label = element('label', 'parameter-choice'); const check = element('input'); check.type = 'checkbox'; check.checked = order.includes(table.id); check.setAttribute('aria-label', table.name);
        check.dataset.tableId = table.id;
        check.addEventListener('change', () => { order = order.filter((entry) => entry !== table.id); if (check.checked) order.push(table.id); renderLists(); });
        const caption = element('span'); caption.append(element('strong', '', table.name), element('small', '', folderPath(table.parentId) || '根目录')); label.append(check, caption);
        row.append(label, openTableButton(table)); choices.append(row);
      });
      if (!choices.childNodes.length) choices.append(element('p', 'parameter-empty', '没有匹配的参数表'));
      order.forEach((tableId, index) => {
        const table = effectiveTable(tableId); const row = element('div', 'parameter-priority-row'); row.draggable = true; row.dataset.tableId = tableId;
        row.addEventListener('dragstart', (event) => { dragging = tableId; event.dataTransfer.setData('text/plain', tableId); event.dataTransfer.effectAllowed = 'move'; });
        row.addEventListener('dragover', (event) => { if (dragging) { event.preventDefault(); row.classList.add('drop-target'); } });
        row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
        row.addEventListener('drop', (event) => { event.preventDefault(); row.classList.remove('drop-target'); const from = order.indexOf(dragging); if (from >= 0) move(from, index); dragging = ''; });
        row.addEventListener('dragend', () => { dragging = ''; priority.querySelectorAll('.drop-target').forEach((node) => node.classList.remove('drop-target')); });
        const handle = button('拖动改变优先级', () => {}, 'grip'); handle.tabIndex = -1; const name = element('span', 'parameter-priority-name', (index + 1) + '. ' + (table ? table.name : '参数表已删除'));
        if (!table) name.classList.add('error');
        const up = button('提高优先级', () => move(index, index - 1), 'up'); up.disabled = index === 0;
        const down = button('降低优先级', () => move(index, index + 1), 'down'); down.disabled = index === order.length - 1;
        row.append(handle, name, up, down, button('取消加载', () => { order.splice(index, 1); renderLists(); }, 'close'), openTableButton(table)); priority.append(row);
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
    if (!global.name) global.name = 'vwd-reference-' + referenceClientId;
    try {
      const key = 'vwd-reference-window-family:' + global.location.pathname;
      referenceWindowFamily = global.sessionStorage.getItem(key) || referenceClientId;
      global.sessionStorage.setItem(key, referenceWindowFamily);
    } catch (_) { /* Cross-tab highlighting still works when session storage is unavailable. */ }
    standaloneTableId = api.singleTableId || '';
    standaloneLoading = !!standaloneTableId;
    if (standaloneTableId) {
      activePage = 'parameters';
      document.body.classList.add('parameter-page-active', 'single-parameter-view');
      $('parameter-workspace').hidden = false;
      document.querySelector('.app > main.main').hidden = true;
    }
    global.addEventListener('keydown', (event) => {
      if (activePage !== 'parameters' || modal || event.target.closest('.modal-overlay')) return;
      event.stopPropagation();
      if (!event.isComposing && event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey
          && event.target.matches('[data-parameter-field]:not([data-parameter-field="description"])')) {
        event.preventDefault(); event.target.blur(); return;
      }
      if (event.key === 'Escape' && !event.isComposing && isTextInput(event.target)) {
        if (activeCellEdit && activeCellEdit.input === event.target) {
          const edit = activeCellEdit; activeCellEdit = null;
          event.target.value = edit.original !== undefined ? edit.original : String(edit.row[edit.field] ?? '');
          notifyParameterHistory();
        }
        const line = event.target.closest('tbody tr');
        if (line) {
          event.preventDefault();
          const target = line.querySelector('.parameter-row-select') || line.closest('.parameter-reference-section')?.querySelector('.parameter-reference-name');
          if (target) target.focus({ preventScroll: true }); else event.target.blur();
        }
      }
      if (event.key === 'Escape' && !event.isComposing && !isTextInput(event.target)
          && $('parameter-workspace').classList.contains('parameter-matrix-fullscreen')) {
        event.preventDefault(); $('parameter-workspace').querySelector('.parameter-matrix-fullscreen-toggle').click(); return;
      }
      if (event.isComposing) return;
      if (isTextInput(event.target) && !event.target.matches('[data-parameter-field]')) return;
      const action = bridge.historyShortcut ? bridge.historyShortcut(event) : '';
      if (action === 'undo' || action === 'redo') { event.preventDefault(); applyParameterHistory(action === 'redo'); return; }
      if (isTextInput(event.target)) return;
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
      if (referenceHighlight && event.target.closest('#wave-workspace')
          && !event.target.closest('[data-parameter-references], button, input, textarea, path, use, text, .wave-cell-hit-target')) clearReferenceHighlight();
    }, true);
    global.addEventListener('focus', () => { if (referenceRefresh) referenceRefresh(); });
    try {
      referenceChannel = new BroadcastChannel('vwd-parameter-navigation:' + global.location.pathname);
      referenceChannel.onmessage = (event) => {
        const data = event.data;
        if (!data || data.libraryId !== libraryId || data.clientId === referenceClientId) return;
        const pending = referenceRequests.get(data.requestId);
        if (pending) pending(data);
        if (data.type === 'revealed' && data.recipient === referenceClientId && data.requestId === lastReferenceJumpId) {
          status(data.active ? '已激活并定位到波形图：' + data.title
            : '已高亮波形图“' + data.title + '”；浏览器未允许自动激活，请切换到该标签页');
          return;
        }
        if (!data.target || data.target.libraryId !== libraryId) return;
        const rank = bridge.referenceTargetRank(data.target.waveId);
        if (data.type === 'probe' && rank >= 0) {
          sendReferenceMessage(Object.assign(referenceWindowInfo(), { type: 'candidate', requestId: data.requestId, rank, visible: document.visibilityState === 'visible' }));
        } else if (data.type === 'reveal' && data.recipient === referenceClientId && rank >= 0) {
          sendReferenceMessage({ type: 'accepted', requestId: data.requestId });
          global.focus();
          void revealReference(data.target).then(() => {
            sendReferenceMessage({ type: 'revealed', requestId: data.requestId, recipient: data.clientId,
              title: data.title || data.target.waveId, active: document.visibilityState === 'visible' && document.hasFocus() });
          }).catch((error) => {
            referenceError(error);
            sendReferenceMessage({ type: 'failed', recipient: data.clientId, message: error.message });
          });
        }
      };
      referenceChannel.addEventListener('message', (event) => {
        const data = event.data;
        if (data && data.libraryId === libraryId && data.type === 'failed' && data.recipient === referenceClientId) status('跳转失败：' + data.message, true);
      });
      global.addEventListener('pagehide', () => referenceChannel.close(), { once: true });
    } catch (_) { /* Without cross-tab messaging, navigation stays in the current tab. */ }
    global.addEventListener('beforeunload', (event) => { if (pendingParameterChanges()) { event.preventDefault(); event.returnValue = ''; } });
    try {
      channel = new BroadcastChannel('vwd-parameters:' + global.location.pathname);
      channel.onmessage = (event) => {
        const data = event.data;
        if (!data || data.libraryId !== libraryId || !data.catalog || Number(data.catalog.revision) <= catalog.revision) return;
        if (!pendingCatalog || Number(data.catalog.revision) > Number(pendingCatalog.catalog.revision)) pendingCatalog = data;
        applyPendingCatalog();
      };
      document.addEventListener('focusout', () => { queueMicrotask(applyPendingCatalog); });
      global.addEventListener('pagehide', () => channel.close(), { once: true });
    } catch (_) { /* Explicit refresh on opening either parameter surface remains available. */ }
    renderTree(); renderTable();
  }
  function finishSingleLoad(error) {
    standaloneLoading = false; standaloneError = error || '';
    renderTable();
    if (error) status(error, true);
  }
  global.VisualWaveDromParameters = { mount, setCatalog, finishSingleLoad, getCatalog: () => clone(rejectedCatalog || catalog), getLoadError: () => catalogLoadError, getRevision: () => generation, evaluate, resolve, text, details, diagnostics, decorate, decorateText, resolveName,
    revealReference, clearReferenceHighlight, matchesReference, referenceWindowInfo,
    openLinks, flush, refresh, page: () => activePage, pending: pendingParameterChanges,
    historyState: parameterHistoryState, undo: () => applyParameterHistory(false), redo: () => applyParameterHistory(true) };
})(window);

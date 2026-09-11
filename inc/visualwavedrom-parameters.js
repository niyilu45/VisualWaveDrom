(function (global) {
  'use strict';
  const tokenPattern = /\{\$([^{}\s]+)\}/g;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const empty = () => ({ revision: 0, directories: [], tables: [], presets: [] });
  let catalog = empty(), libraryId = '', bridge = null, generation = 0;
  let cache = new WeakMap(), selectedFolder = '', selectedTable = '', activePage = 'wave';
  let dirty = 0, savedGeneration = 0, timer = null, saving = null, failure = '';
  let modal = null, channel = null;
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
  function resolveName(name, source) {
    for (const tableId of linked(source)) {
      const table = catalog.tables.find((item) => item.id === tableId);
      const row = table && table.rows.find((item) => String(item.name || '') === name);
      if (row) return { name, table: table.name, tableId, val: row.val == null ? '' : String(row.val), description: String(row.description || '') };
    }
    return null;
  }
  function text(value, source) {
    if (typeof value !== 'string' || !value.includes('{$')) return value;
    return value.replace(tokenPattern, (raw, name) => {
      const found = resolveName(name, source);
      return found ? found.val : raw;
    });
  }
  function details(value, source) {
    const found = new Set();
    return Array.from(String(value || '').matchAll(tokenPattern), (match) => {
      if (found.has(match[1])) return '';
      found.add(match[1]);
      const item = resolveName(match[1], source);
      return item ? match[0] + '\n参数表：' + item.table + '\n值：' + item.val + '\n说明：' + (item.description || '无') : match[0] + '\n未找到变量';
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
        const result = visit(value[key]);
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
      if (typeof raw !== 'string' || !raw.includes('{$')) return;
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
          (Array.isArray(row.data) ? row.data : typeof row.data === 'string' ? row.data.split(/\s+/) : []).forEach(add);
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
  function validate(value) {
    const ids = new Set();
    ['directories', 'tables', 'presets'].forEach((key) => value[key].forEach((item) => {
      if (ids.has(item.id)) throw new Error('重复的参数目录标识');
      ids.add(item.id);
      if (!String(item.name || '').trim()) throw new Error('名称不能为空');
    }));
    value.tables.forEach((table) => {
      const names = new Set();
      table.rows.forEach((row, index) => {
        const name = String(row.name || '');
        if (!name && !row.val && !row.description) return;
        if (!name || /[{}\s$]/.test(name)) throw new Error(table.name + ' 第 ' + (index + 1) + ' 行：变量名不能为空或包含空白、{}、$');
        if (names.has(name)) throw new Error(table.name + '：变量名 ' + name + ' 重复');
        names.add(name);
      });
    });
  }
  function invalidate() {
    generation++; cache = new WeakMap();
    if (bridge) bridge.changed();
  }
  function changed(render) {
    dirty++; failure = ''; invalidate();
    if (render) { renderTree(); renderTable(); }
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
    catalog = normalize(value); libraryId = identity || ''; generation++; cache = new WeakMap();
    dirty = savedGeneration = 0; failure = '';
    if (!catalog.tables.some((table) => table.id === selectedTable)) selectedTable = '';
    if (!catalog.directories.some((dir) => dir.id === selectedFolder)) selectedFolder = '';
    renderTree(); renderTable();
  }
  async function refresh() {
    if (!bridge || !bridge.identity()) throw new Error('波形库仍在加载，请稍后再试');
    await flush();
    const identity = bridge.identity();
    const loadGeneration = dirty;
    const value = await bridge.load();
    if (identity !== bridge.identity() || dirty !== loadGeneration) return;
    setCatalog(value, identity); invalidate();
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
    catalog.tables.push(table); selectedTable = table.id; expanded.add(selectedFolder); changed(true);
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
  function folderOptions(select, current) {
    select.replaceChildren(new Option('根目录', ''));
    catalog.directories.forEach((dir) => select.add(new Option(folderPath(dir.id), dir.id)));
    select.value = current || '';
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
        renderTree(); renderTable();
      });
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
        const pick = button(table.name, () => { selectedTable = table.id; selectedFolder = parentId; renderTree(); renderTable(); });
        pick.className = 'parameter-tree-label'; pick.classList.toggle('active', selectedTable === table.id);
        pick.draggable = true; pick.addEventListener('dragstart', (e) => e.dataTransfer.setData('application/x-vwd-parameter', table.id));
        row.append(pick, element('span', 'parameter-count', table.rows.filter((item) => item.name).length)); tree.append(row);
      });
    }
    directory('', 0, '', new Set());
  }
  function renderTable() {
    const workspace = $('parameter-workspace'); if (!workspace) return;
    const table = catalog.tables.find((item) => item.id === selectedTable);
    workspace.replaceChildren();
    const toolbar = element('header', 'parameter-workspace-header');
    toolbar.append(element('h2', '', table ? table.name : (folderPath(selectedFolder) || '参数目录')));
    if (table) {
      toolbar.append(button('修改参数表名称', () => rename(table), 'edit'));
      const parent = element('select', 'parameter-parent'); parent.setAttribute('aria-label', '参数表所属标题'); folderOptions(parent, table.parentId);
      parent.addEventListener('change', () => { table.parentId = parent.value; selectedFolder = parent.value; expanded.add(parent.value); changed(true); }); toolbar.append(parent);
      toolbar.append(button('新增变量', () => { table.rows.push({ name: '', val: '', description: '' }); changed(true); const inputs = workspace.querySelectorAll('tbody input'); inputs[inputs.length - 1].focus(); }));
      toolbar.append(button('删除参数表', () => {
        if (!global.confirm('删除参数表“' + table.name + '”？已链接的波形会保留引用，并提示参数表缺失。')) return;
        catalog.tables = catalog.tables.filter((item) => item !== table); selectedTable = ''; changed(true);
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
    const state = element('div', 'parameter-status'); state.id = 'parameter-status'; state.setAttribute('role', 'status');
    state.textContent = failure || (dirty !== savedGeneration ? '正在保存参数目录...' : ''); workspace.append(state);
    if (!table) { workspace.append(element('p', 'parameter-empty', '未选中参数表')); return; }
    const scroller = element('div', 'parameter-grid-scroll'); const grid = element('table', 'parameter-grid');
    const head = element('thead'); const tr = element('tr');
    ['变量名 name', '变量值 val', '变量说明 description'].forEach((label) => tr.append(element('th', '', label)));
    head.append(tr); grid.append(head);
    const body = element('tbody');
    table.rows.forEach((row, index) => {
      const line = element('tr');
      ['name', 'val', 'description'].forEach((field) => {
        const td = element('td'); const fieldBox = element('div', 'parameter-cell');
        const input = element(field === 'name' ? 'input' : 'textarea');
        input.value = row[field] == null ? '' : String(row[field]); input.setAttribute('aria-label', '第 ' + (index + 1) + ' 行 ' + field);
        input.spellcheck = false; if (field !== 'name') input.rows = 1;
        const resize = () => { if (field !== 'name') { input.style.height = 'auto'; input.style.height = Math.min(220, input.scrollHeight) + 'px'; } };
        input.addEventListener('input', () => { row[field] = input.value; resize(); changed(false); });
        input.addEventListener('blur', () => {
          void flush().catch(() => {});
          const treeRow = Array.from($('parameter-tree').querySelectorAll('[data-table-id]')).find((item) => item.dataset.tableId === table.id);
          if (treeRow) treeRow.querySelector('.parameter-count').textContent = table.rows.filter((item) => item.name).length;
        });
        fieldBox.append(input);
        if (field === 'name') fieldBox.append(button('删除第 ' + (index + 1) + ' 行', () => { table.rows.splice(index, 1); changed(true); }, 'trash'));
        td.append(fieldBox); line.append(td);
        requestAnimationFrame(resize);
      });
      body.append(line);
    });
    grid.append(body); scroller.append(grid); workspace.append(scroller);
    const bottom = element('footer', 'parameter-table-footer');
    bottom.append(button('重新加载', async () => {
      if (dirty !== savedGeneration && !global.confirm('放弃当前未保存的参数修改并重新加载？')) return;
      dirty = savedGeneration; try { await refresh(); } catch (error) { status(error.message, true); }
    }), button('重试保存', () => { void flush().catch(() => {}); })); workspace.append(bottom);
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
  }
  async function openLinks(documentName, anchor) {
    if (modal) return;
    try { await refresh(); } catch (error) { bridge.status(error.message); return; }
    let source;
    try { source = await bridge.source(documentName); } catch (error) { bridge.status(error.message); return; }
    let order = linked(source).slice(), presetId = '', dragging = '';
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
      try { await flush(); await bridge.bind(documentName, order); close(); }
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
      if (activePage === 'parameters' && !modal && !event.target.closest('.modal-overlay')) event.stopPropagation();
    }, true);
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
    document.addEventListener('mouseover', (event) => {
      let hint = ''; const target = event.target && event.target.closest('[data-parameter-hint], input, textarea, .cm-parameter');
      if (target) {
        hint = target.dataset.parameterHint || '';
        if (!hint && !target.closest('#parameter-workspace, .parameter-modal')) {
          try { hint = details(target.value || target.textContent, bridge.currentSource()); } catch (_) { /* Invalid JSON stays editable. */ }
        }
      }
      tooltip.hidden = !hint; tooltip.textContent = hint;
      if (hint) { tooltip.style.left = Math.max(8, Math.min(event.clientX + 12, innerWidth - 340)) + 'px'; tooltip.style.top = Math.max(8, Math.min(event.clientY + 18, innerHeight - 180)) + 'px'; }
    });
    document.addEventListener('pointerdown', () => { tooltip.hidden = true; }, true);
    global.addEventListener('beforeunload', (event) => { if (dirty !== savedGeneration) { event.preventDefault(); event.returnValue = ''; } });
    try {
      channel = new BroadcastChannel('vwd-parameters:' + global.location.pathname);
      channel.onmessage = (event) => {
        const data = event.data;
        if (!data || data.libraryId !== libraryId || dirty !== savedGeneration || Number(data.catalog && data.catalog.revision) <= catalog.revision) return;
        if (activePage === 'parameters' && $('parameter-workspace').contains(document.activeElement)) return;
        setCatalog(data.catalog, libraryId); invalidate();
      };
      global.addEventListener('pagehide', () => channel.close(), { once: true });
    } catch (_) { /* Explicit refresh on opening either parameter surface remains available. */ }
    renderTree(); renderTable();
  }
  global.VisualWaveDromParameters = { mount, setCatalog, getCatalog: () => clone(catalog), resolve, text, details, decorate, resolveName,
    openLinks, flush, refresh, page: () => activePage, pending: () => dirty !== savedGeneration };
})(window);

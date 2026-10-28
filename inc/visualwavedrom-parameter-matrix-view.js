(function (global) {
  'use strict';
  const M = global.VWDParameterMatrix;
  function attach(api) {
    const { table, toolbar, button, element } = api;
    toolbar.append(button('引用参数表', api.references));
    if ((table.references || []).length > 1) toolbar.append(button('修改引用顺序', api.orderReferences));
    const fullscreen = button('参数区域全屏', () => {
      api.workspace.classList.toggle('parameter-matrix-fullscreen');
      const active = api.workspace.classList.contains('parameter-matrix-fullscreen');
      fullscreen.title = active ? '退出全屏' : '参数区域全屏'; fullscreen.setAttribute('aria-label', fullscreen.title); fullscreen.setAttribute('aria-pressed', String(active));
    }, 'maximize');
    fullscreen.classList.add('parameter-matrix-fullscreen-toggle');
    fullscreen.setAttribute('aria-pressed', String(api.workspace.classList.contains('parameter-matrix-fullscreen')));
    toolbar.append(fullscreen);
    const references = element('div', 'parameter-reference-sections'); api.scroller.append(references);
    const expandedUnused = new Set();
    let signature = '', editors = [], resizeFrame = 0;
    function resize(input) {
      if (input.tagName !== 'TEXTAREA' || !input.getClientRects().length) return;
      input.style.height = 'auto'; input.style.height = Math.min(220, input.scrollHeight) + 'px';
    }
    function refresh() {
      const columns = api.tables(), sections = M.referenceSections(api.rawTables(), table.id, columns);
      const next = JSON.stringify(sections.map((section) => [section.reference, section.source?.name, section.missingRows,
        section.rows.map((entry) => [entry.row.id, entry.row.referenceSource?.tableId, entry.used, entry.winner?.referencePath]) ]));
      if (next !== signature) {
        signature = next; references.replaceChildren(); editors = [];
        sections.forEach((section, index) => {
          const { source, reference } = section;
          const band = element('section', 'parameter-reference-section'); band.dataset.referenceId = reference.tableId;
          const header = element('header', 'parameter-reference-header'), heading = element('h3');
          const title = button(source ? source.name : reference.name || reference.tableId, () => { api.commit(); api.showSource(reference.tableId); });
          title.className = 'parameter-reference-name'; title.disabled = !source; title.title = '跳转到参数表：' + title.textContent;
          heading.append(element('span', 'parameter-reference-number', '引用 ' + (index + 1) + ' · '), title);
          const open = button('单独打开引用表：' + (source ? source.name : reference.name || reference.tableId), () => { api.commit(); api.open(reference.tableId); }, 'external'); open.disabled = !source;
          header.append(heading, open); band.append(header);
          if (!source) band.append(element('p', 'parameter-value-error', '引用表不存在或已删除；恢复源表后将自动更新。'));
          else {
            if (section.missingRows) band.append(element('p', 'parameter-value-error', section.missingRows + ' 个选定变量已不存在'));
            function buildGrid(entries, muted) {
              const list = element('table', 'parameter-grid parameter-reference-grid'), head = element('thead'), labels = element('tr');
              ['变量名 name', '变量值 val', '变量说明 description'].forEach((label) => { const th = element('th', '', label); th.scope = 'col'; labels.append(th); }); head.append(labels); list.append(head);
              const body = element('tbody');
              entries.forEach((entry) => {
                const origin = entry.row.referenceSource?.tableId || source.id;
                const original = api.sourceTable(origin), row = original?.rows.find((row) => row.id === entry.row.id);
                const line = element('tr', muted ? 'parameter-reference-unused' : ''); line.dataset.referenceRowId = entry.row.id;
                if (muted) line.title = '未使用：' + (entry.winner?.referencePath ? '上方引用表' : '本表') + ' 已定义同名变量';
                ['name', 'val', 'description'].forEach((field) => {
                  const td = element('td'), box = element('div', 'parameter-cell' + (field === 'val' ? ' parameter-value-cell' : ''));
                  const input = element(field === 'name' ? 'input' : 'textarea'); input.spellcheck = false; if (field !== 'name') input.rows = 1;
                  input.dataset.parameterField = field; input.dataset.referenceSourceId = origin; input.dataset.referenceRowId = entry.row.id;
                  input.setAttribute('aria-label', source.name + ' / ' + entry.row.name + ' / ' + field); input.disabled = !row;
                  const error = element('span', 'parameter-value-error'); error.hidden = true;
                  const raw = () => M.raw(row && row[field]);
                  input.addEventListener('focus', () => { input.value = raw(); resize(input); });
                  input.addEventListener('input', () => { api.editSource(original, row, field, input, raw()); resize(input); });
                  input.addEventListener('blur', (event) => {
                    const next = event.relatedTarget;
                    const focus = next?.dataset.referenceSourceId ? { source: next.dataset.referenceSourceId, row: next.dataset.referenceRowId, field: next.dataset.parameterField } : null;
                    api.commit(); api.refresh();
                    if (focus && !next.isConnected) {
                      const replacement = [...references.querySelectorAll('[data-reference-source-id]')].find((node) => node.dataset.referenceSourceId === focus.source && node.dataset.referenceRowId === focus.row && node.dataset.parameterField === focus.field);
                      if (replacement) replacement.focus({ preventScroll: true });
                    }
                  });
                  input.addEventListener('beforeinput', (event) => { if (['historyUndo', 'historyRedo'].includes(event.inputType)) { event.preventDefault(); api.history(event.inputType === 'historyRedo'); } });
                  box.append(input); if (field === 'val') box.append(error); td.append(box); line.append(td);
                  editors.push({ input, error, field, rowId: entry.row.id, origin, sourceId: source.id, muted, line });
                }); body.append(line);
              }); list.append(body); return list;
            }
            const used = section.rows.filter((entry) => entry.used), unused = section.rows.filter((entry) => !entry.used);
            if (used.length) band.append(buildGrid(used, false));
            if (unused.length) {
              const details = element('details', 'parameter-reference-unused-group'); details.open = expandedUnused.has(source.id);
              details.append(element('summary', '', '未使用变量（' + unused.length + '）'), buildGrid(unused, true));
              details.addEventListener('toggle', () => { if (details.open) expandedUnused.add(source.id); else expandedUnused.delete(source.id); editors.forEach((editor) => resize(editor.input)); }); band.append(details);
            }
            if (!section.rows.length) band.append(element('p', 'parameter-empty', '暂无可用的引用变量'));
          }
          references.append(band);
        });
      }
      const byId = new Map(columns.map((column) => [column.id, column])), contexts = new Map();
      editors.forEach((editor) => {
        const { input, error, field, rowId, origin, muted, sourceId } = editor;
        const target = byId.get(muted ? sourceId : table.id), row = target?.rows.find((row) => row.id === rowId && (muted || row.referencePath?.[0] === sourceId));
        const original = api.sourceTable(origin)?.rows.find((row) => row.id === rowId);
        if (!original || !row) return;
        input.setAttribute('aria-label', (byId.get(sourceId)?.name || sourceId) + ' / ' + original.name + ' / ' + field);
        if (!contexts.has(target.id)) contexts.set(target.id, { stack: [], values: new Map() });
        const result = field === 'val' ? api.resolve(target, row, contexts.get(target.id)) : null;
        if (document.activeElement !== input) input.value = result ? result.val : M.raw(original[field]);
        input.classList.toggle('parameter-formula-value', !!result?.formula && !result.error);
        input.classList.toggle('parameter-negative-value', !!result && !result.error && Number.isFinite(Number(result.val)) && Number(result.val) < 0);
        input.setAttribute('aria-invalid', String(!!result?.error));
        input.title = (result?.error || (result?.formula ? '公式：' + result.rawVal + '\n' : '')) + '编辑源表：' + (api.sourceTable(origin)?.name || origin);
        error.textContent = result?.error || ''; error.hidden = !result?.error;
        if (field === 'val') { editor.line.dataset.value = result.val; editor.line.dataset.rawValue = result.rawVal; editor.line.dataset.valueError = result.error; }
      });
      if (!resizeFrame) resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; editors.forEach((editor) => resize(editor.input)); });
    }
    function filterReferences(test) {
      references.querySelectorAll('tbody tr').forEach((line) => {
        const name = line.querySelector('[data-parameter-field="name"]')?.value || '';
        line.hidden = !name.toLowerCase().includes(api.filters.name.trim().toLowerCase()) || !test({ val: line.dataset.value || '', rawVal: line.dataset.rawValue || '', error: line.dataset.valueError || '' });
      });
    }
    return { refresh, filterReferences, visible: (view, test) => test(view.valueResult), clearFilters() {}, dispose() { cancelAnimationFrame(resizeFrame); } };
  }
  global.VWDParameterMatrixView = Object.freeze({ attach });
})(window);

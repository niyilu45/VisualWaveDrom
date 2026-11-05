(function (global) {
  'use strict';
  const M = global.VWDParameterMatrix;
  function resizeTextareas(inputs) {
    const visible = Array.from(inputs).filter((input) => input.tagName === 'TEXTAREA' && input.getClientRects().length);
    visible.forEach((input) => { input.style.height = 'auto'; });
    const heights = visible.map((input) => {
      const height = input.scrollHeight + input.offsetHeight - input.clientHeight;
      return input.dataset.parameterField === 'description' ? height : Math.min(220, height);
    });
    visible.forEach((input, index) => { input.style.height = heights[index] + 'px'; });
  }
  let formulaTooltip, tooltipOwner, tooltipNativeTitle, tooltipAnchor, stopActiveFormulaEditor;
  function formulaTokenAt(span, x, y) {
    return Array.from(span.getClientRects()).some((rect) =>
      x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom);
  }
  function hideFormulaTooltip(owner) {
    if (!formulaTooltip || (owner && tooltipOwner !== owner)) return;
    formulaTooltip.hidden = true;
    if (tooltipOwner && tooltipNativeTitle && !tooltipOwner.title) tooltipOwner.title = tooltipNativeTitle;
    tooltipOwner = null;
    tooltipNativeTitle = null;
    tooltipAnchor = null;
  }
  function showFormulaTooltip(input, hit, event) {
    if (!formulaTooltip) {
      formulaTooltip = document.createElement('div');
      formulaTooltip.className = 'parameter-formula-tooltip';
      formulaTooltip.setAttribute('role', 'tooltip');
      document.body.append(formulaTooltip);
      global.addEventListener('scroll', () => {
        if (!tooltipAnchor) return;
        const { span, x, y } = tooltipAnchor;
        if (document.elementFromPoint(x, y) !== tooltipOwner || !formulaTokenAt(span, x, y)) hideFormulaTooltip();
      }, true);
      document.addEventListener('pointermove', (pointer) => {
        if (tooltipOwner && pointer.target !== tooltipOwner) hideFormulaTooltip();
      });
    }
    if (tooltipOwner !== input) {
      hideFormulaTooltip();
      tooltipOwner = input;
      tooltipNativeTitle = input.title;
      input.title = '';
    }
    tooltipAnchor = { span: hit.span, x: event.clientX, y: event.clientY };
    const text = hit.token.text + ' = ' + (hit.token.value || '（空值）');
    if (formulaTooltip.textContent !== text) formulaTooltip.textContent = text;
    formulaTooltip.hidden = false;
    const left = Math.min(event.clientX + 12, global.innerWidth - formulaTooltip.offsetWidth - 8);
    const below = event.clientY + 16;
    const top = below + formulaTooltip.offsetHeight <= global.innerHeight - 8
      ? below : event.clientY - formulaTooltip.offsetHeight - 12;
    formulaTooltip.style.left = Math.max(8, left) + 'px';
    formulaTooltip.style.top = Math.max(8, top) + 'px';
  }
  function formulaEditor(input, resolveTokens) {
    const wrapper = document.createElement('div');
    wrapper.className = 'parameter-formula-editor';
    wrapper.append(input);
    let layer, content, observer, composing = false, spans = [];
    function hide() {
      if (layer) layer.hidden = true;
      input.classList.remove('parameter-formula-mirrored');
      hideFormulaTooltip(input);
    }
    function syncScroll() {
      if (content) content.style.transform = 'translate(' + (-input.scrollLeft) + 'px,' + (-input.scrollTop) + 'px)';
    }
    function align() {
      if (!layer || layer.hidden) return;
      const style = global.getComputedStyle(input);
      Object.assign(layer.style, { top: input.clientTop + 'px', left: input.clientLeft + 'px',
        width: input.clientWidth + 'px', height: input.clientHeight + 'px' });
      for (const name of ['font-family', 'font-size', 'font-weight', 'font-style', 'font-variant-ligatures',
        'line-height', 'letter-spacing', 'word-spacing', 'white-space', 'overflow-wrap', 'word-break',
        'text-align', 'text-indent', 'tab-size', 'direction', 'padding']) {
        content.style.setProperty(name, style.getPropertyValue(name));
      }
      syncScroll();
    }
    function render() {
      hideFormulaTooltip(input);
      if (composing || document.activeElement !== input) { hide(); return; }
      const raw = input.value;
      let tokens = [];
      try { if (raw.length <= 16384) tokens = resolveTokens(raw); }
      catch (_) { hide(); return; }
      if (!tokens.length) { hide(); return; }
      if (!layer) {
        layer = document.createElement('div');
        layer.className = 'parameter-formula-layer';
        layer.setAttribute('aria-hidden', 'true');
        content = document.createElement('div');
        layer.append(content); wrapper.prepend(layer);
      }
      const fragment = document.createDocumentFragment();
      let end = 0;
      spans = tokens.map((token) => {
        const span = document.createElement('span');
        span.className = 'parameter-formula-token';
        span.textContent = token.text;
        fragment.append(raw.slice(end, token.start), span);
        end = token.start + token.text.length;
        return { span, token };
      });
      fragment.append(raw.slice(end) + (raw.endsWith('\n') ? '\u200b' : ''));
      content.replaceChildren(fragment);
      layer.hidden = false;
      input.classList.add('parameter-formula-mirrored');
      align();
    }
    function stop() {
      observer?.disconnect(); observer = null;
      hide();
      if (stopActiveFormulaEditor === stop) stopActiveFormulaEditor = null;
    }
    input.addEventListener('focus', () => {
      stopActiveFormulaEditor?.();
      stopActiveFormulaEditor = stop;
      if (typeof global.ResizeObserver === 'function') {
        observer = new global.ResizeObserver(align);
        observer.observe(input);
      }
      render();
    });
    input.addEventListener('blur', stop);
    input.addEventListener('input', render);
    input.addEventListener('compositionstart', () => { composing = true; hide(); });
    input.addEventListener('compositionend', () => { composing = false; render(); });
    input.addEventListener('scroll', syncScroll);
    input.addEventListener('pointerleave', () => hideFormulaTooltip(input));
    input.addEventListener('pointerdown', () => hideFormulaTooltip(input));
    input.addEventListener('pointermove', (event) => {
      if (!layer || layer.hidden || event.buttons) return;
      const hit = spans.find(({ span }) => formulaTokenAt(span, event.clientX, event.clientY));
      if (!hit) { hideFormulaTooltip(input); return; }
      showFormulaTooltip(input, hit, event);
    });
    return wrapper;
  }
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
    const drafts = new Map();
    let signature = '', editors = [], rowViews = [], resizeFrame = 0;
    const matchesSelection = (view, selection) => selection?.source === view.source && selection.path[0] === view.path[0];
    const isVisible = (view) => !view.line.hidden && !view.line.closest('details:not([open])');
    function select(view, event) {
      api.selectReference(view, event, () => rowViews.filter((item) =>
        !item.draft && item.source === view.source && item.path[0] === view.path[0] && isVisible(item)
      ).map((item) => item.row));
    }
    function syncSelection() {
      const selection = api.referenceSelection();
      rowViews.forEach((view) => {
        const selected = !view.draft && matchesSelection(view, selection) && selection.rows.has(view.row);
        view.line.classList.toggle('selected', selected);
        view.line.setAttribute('aria-selected', String(selected));
        view.handle.setAttribute('aria-pressed', String(selected));
      });
    }
    function resize(input) { resizeTextareas([input]); }
    function queueResize() {
      if (!resizeFrame) resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0; resizeTextareas(api.scroller.querySelectorAll('.parameter-cell textarea'));
      });
    }
    let lastWidth = -1;
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => {
      const width = entries[0].contentRect.width;
      if (Math.abs(width - lastWidth) > .5) { lastWidth = width; queueResize(); }
    }) : null;
    if (observer) observer.observe(api.scroller);
    global.addEventListener('resize', queueResize);
    global.addEventListener('vwd-ui-font-change', queueResize);
    function refresh() {
      const columns = api.tables(), sections = M.referenceSections(api.rawTables(), table.id, columns);
      const next = JSON.stringify(sections.map((section) => [section.reference, section.source?.name, section.missingRows,
        section.rows.map((entry) => [entry.row.id, entry.row.referenceSource?.tableId, entry.used, entry.winner?.referencePath]) ]));
      if (next !== signature) {
        const focused = document.activeElement;
        const focus = references.contains(focused) ? api.captureFocus(focused) : null;
        const top = api.scroller.scrollTop;
        signature = next; references.replaceChildren(); editors = []; rowViews = [];
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
            function buildGrid(entries, muted, appendOnly = false) {
              const list = element('table', 'parameter-grid parameter-reference-grid'), head = element('thead'), labels = element('tr');
              if (appendOnly) {
                const columns = element('colgroup');
                ['28%', '27%', '45%'].forEach((width) => { const column = element('col'); column.style.width = width; columns.append(column); });
                list.append(columns);
              } else {
                ['变量名 name', '变量值 val', '变量说明 description'].forEach((label) => { const th = element('th', '', label); th.scope = 'col'; labels.append(th); }); head.append(labels); list.append(head);
              }
              const body = element('tbody');
              entries.forEach((entry) => {
                const origin = entry.row.referenceSource?.tableId || source.id;
                const original = api.sourceTable(origin), draft = appendOnly;
                const row = draft ? entry.row : original?.rows.find((row) => row.id === entry.row.id);
                if (!original || !row) return;
                const line = element('tr', draft ? 'parameter-append-row parameter-reference-append-row' : muted ? 'parameter-reference-unused' : '');
                if (!draft) line.dataset.referenceRowId = entry.row.id;
                const path = [reference.tableId, ...(entry.row.referencePath || [])];
                const view = { row, line, source: original, path, draft };
                rowViews.push(view);
                line.addEventListener('click', () => select(view));
                line.addEventListener('focusin', (event) => {
                  if (event.target.matches('[data-parameter-field]')) select(view);
                });
                if (muted) line.title = '未使用：' + (entry.winner?.referencePath ? '上方引用表' : '本表') + ' 已定义同名变量';
                ['name', 'val', 'description'].forEach((field) => {
                  const td = element('td'), box = element('div', 'parameter-cell' + (field === 'val' ? ' parameter-value-cell' : ''));
                  const input = element(field === 'name' ? 'input' : 'textarea'); input.spellcheck = false; if (field !== 'name') input.rows = 1;
                  input.dataset.parameterField = field; input.dataset.referenceSourceId = origin; input.dataset.referenceRowId = entry.row.id;
                  input.setAttribute('aria-label', source.name + ' / ' + (draft ? '空白录入行' : entry.row.name) + ' / ' + field);
                  if (field === 'name') {
                    const jump = draft ? button('空白录入行', () => {}, 'external') : api.jumpButton(view, original);
                    if (draft) { jump.disabled = true; jump.classList.add('parameter-reference-jump'); }
                    const index = draft ? original.rows.length + 1 : original.rows.indexOf(row) + 1;
                    const handle = button(draft ? '空白录入行' : '选中 ' + original.name + ' 第 ' + index + ' 行', (event) => {
                      event.stopPropagation(); select(view, event);
                    });
                    handle.className = 'parameter-row-select parameter-reference-row-select';
                    handle.textContent = index; handle.disabled = draft;
                    view.handle = handle;
                    box.append(jump, handle);
                    if (draft) input.placeholder = '名称';
                  }
                  const error = element('span', 'parameter-value-error'); error.hidden = true;
                  const raw = () => M.raw(row[field]);
                  input.value = raw();
                  input.addEventListener('focus', () => {
                    if (input.value !== raw()) input.value = raw();
                    resize(input);
                  });
                  input.addEventListener('input', () => { api.editSource(original, row, field, input, raw(), path, draft); resize(input); });
                  input.addEventListener('keydown', (event) => {
                    if (field !== 'description' && event.key === 'Enter' && !event.isComposing
                        && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
                      event.preventDefault(); event.stopPropagation(); input.blur();
                    }
                  });
                  input.addEventListener('blur', (event) => {
                    const next = event.relatedTarget;
                    const focus = next?.dataset.referenceSourceId ? api.captureFocus(next) : null;
                    api.commit(); api.refresh();
                    if (focus && !next.isConnected) api.restoreFocus(references, focus);
                  });
                  input.addEventListener('beforeinput', (event) => { if (['historyUndo', 'historyRedo'].includes(event.inputType)) { event.preventDefault(); api.history(event.inputType === 'historyRedo'); } });
                  if (field === 'val') box.append(formulaEditor(input, (value) =>
                    api.formulaReferenceTokens(value, draft ? origin : muted ? source.id : table.id, row)), error);
                  else box.append(input);
                  td.append(box); line.append(td);
                  if (!draft) editors.push({ input, error, field, rowId: entry.row.id, origin, sourceId: source.id, muted, line });
                }); body.append(line);
              }); list.append(body); return list;
            }
            const used = section.rows.filter((entry) => entry.used), unused = section.rows.filter((entry) => !entry.used);
            if (used.length) band.append(buildGrid(used, false));
            if (unused.length) {
              const details = element('details', 'parameter-reference-unused-group'); details.open = expandedUnused.has(source.id);
              details.append(element('summary', '', '未使用变量（' + unused.length + '）'), buildGrid(unused, true));
              details.addEventListener('toggle', () => { if (details.open) expandedUnused.add(source.id); else expandedUnused.delete(source.id); queueResize(); }); band.append(details);
            }
            if (!section.rows.length) band.append(element('p', 'parameter-empty', '暂无可用的引用变量'));
            const original = api.sourceTable(source.id);
            if (original) {
              let draft = drafts.get(source.id);
              if (!draft || original.rows.includes(draft)) { draft = api.newRow(); drafts.set(source.id, draft); }
              band.append(buildGrid([{ row: draft }], false, true));
            }
          }
          references.append(band);
        });
        api.scroller.scrollTop = top;
        if (focus && !focused.isConnected) api.restoreFocus(references, focus);
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
        input.classList.toggle('parameter-negative-value', !!result && !result.error && !result.symbolic && Number.isFinite(Number(result.val)) && Number(result.val) < 0);
        input.setAttribute('aria-invalid', String(!!result?.error));
        input.title = (result?.error || (result?.formula ? '公式：' + result.rawVal + '\n' : '')) + '编辑源表：' + (api.sourceTable(origin)?.name || origin);
        error.textContent = result?.error || ''; error.hidden = !result?.error;
        if (field === 'val') { editor.line.dataset.value = result.val; editor.line.dataset.rawValue = result.rawVal; editor.line.dataset.valueError = result.error; editor.line.dataset.valueSymbolic = result.symbolic ? 'true' : ''; }
      });
      syncSelection();
      queueResize();
    }
    function filterReferences(test) {
      let revealed = false;
      references.querySelectorAll('tbody tr').forEach((line) => {
        if (line.classList.contains('parameter-reference-append-row')) return;
        const name = line.querySelector('[data-parameter-field="name"]')?.value || '';
        const wasHidden = line.hidden;
        line.hidden = !name.toLowerCase().includes(api.filters.name.trim().toLowerCase()) || !test({ val: line.dataset.value || '', rawVal: line.dataset.rawValue || '', error: line.dataset.valueError || '', symbolic: !!line.dataset.valueSymbolic });
        if (wasHidden && !line.hidden) revealed = true;
      });
      const selection = api.referenceSelection();
      if (selection?.rows.size) {
        const retained = rowViews.filter((view) => !view.line.hidden && matchesSelection(view, selection)
          && selection.rows.has(view.row)).map((view) => view.row);
        api.retainReferenceSelection(retained);
      }
      if (revealed) queueResize();
    }
    return { refresh, filterReferences, syncSelection, referenceJumpViews: () => rowViews.filter((view) => view.jump),
      visible: (view, test) => test(view.valueResult), clearFilters() {}, dispose() {
      cancelAnimationFrame(resizeFrame); if (observer) observer.disconnect();
      global.removeEventListener('resize', queueResize); global.removeEventListener('vwd-ui-font-change', queueResize);
    } };
  }
  global.VWDParameterMatrixView = Object.freeze({ attach, resizeTextareas, formulaEditor });
})(window);

(function () {
  'use strict';

  const EMPTY_PRESET = {
    vars: [],
    paths: []
  };

  function create(options) {
    const settings = options || {};
    const modal = document.getElementById('wave-collection-import-modal');
    if (!modal) return null;

    const rootPathInput = document.getElementById('wave-collection-root-path');
    const presetPathInput = document.getElementById('wave-collection-preset-path');
    const pickRootButton = document.getElementById('wave-collection-pick-root');
    const pickPresetButton = document.getElementById('wave-collection-pick-preset');
    const loadPresetButton = document.getElementById('wave-collection-load-preset');
    const presetEditor = document.getElementById('wave-collection-preset-editor');
    const presetState = document.getElementById('wave-collection-preset-state');
    const variablesHost = document.getElementById('wave-collection-vars');
    const resultsHost = document.getElementById('wave-collection-results');
    const resultSummary = document.getElementById('wave-collection-result-summary');
    const hint = document.getElementById('wave-collection-hint');
    const cancelButton = document.getElementById('wave-collection-cancel');
    const savePresetButton = document.getElementById('wave-collection-save-preset');
    const searchButton = document.getElementById('wave-collection-search');
    const confirmButton = document.getElementById('wave-collection-confirm');

    let busy = false;
    let parsedPreset = null;
    let originalPresetPath = '';
    let searchResult = null;
    let editorParseTimer = 0;
    const variableValues = new Map();

    function debug(payload) {
      if (typeof settings.debugLog === 'function') {
        settings.debugLog('collection-import', payload);
      }
    }

    function status(ok, message) {
      if (typeof settings.setStatus === 'function') settings.setStatus(ok, message);
    }

    function setHint(message, isError) {
      hint.textContent = message || '';
      hint.classList.toggle('is-info', !!message && !isError);
    }

    async function post(action, payload) {
      const response = await fetch('/api/import-wave-collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ action }, payload || {}))
      });
      let result = null;
      try {
        result = await response.json();
      } catch (_error) {
        // The status text below is more useful than a JSON parsing error.
      }
      if (!response.ok) {
        throw new Error(result && result.error
          ? String(result.error).replace(/^fileProc:\s*/i, '')
          : ('服务返回错误 ' + response.status));
      }
      return result || {};
    }

    function setEmptyResults(message) {
      resultsHost.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'modal-empty-state';
      empty.textContent = message;
      resultsHost.appendChild(empty);
      resultSummary.textContent = '';
    }

    function collectVariableValues(requireComplete) {
      const values = {};
      const missing = [];
      variablesHost.querySelectorAll('input[data-variable-name]').forEach((input) => {
        const name = input.dataset.variableName;
        const value = String(input.value || '').trim();
        variableValues.set(name, value);
        values[name] = value;
        if (!value) missing.push(name);
      });
      if (requireComplete && missing.length) {
        throw new Error('请填写变量：' + missing.join('、'));
      }
      return { values, missing };
    }

    function invalidateSearch(reason) {
      if (searchResult) {
        debug({ phase: 'search-invalidated', reason: reason || 'changed' });
      }
      searchResult = null;
      setEmptyResults('预设、目录或变量已变化，请重新搜索');
      updateButtons();
    }

    function renderVariables(variableNames) {
      collectVariableValues(false);
      variablesHost.innerHTML = '';
      if (!variableNames.length) {
        const empty = document.createElement('div');
        empty.className = 'modal-empty-state';
        empty.textContent = '此预设没有变量';
        variablesHost.appendChild(empty);
        return;
      }
      variableNames.forEach((name) => {
        const label = document.createElement('label');
        label.className = 'wave-collection-var-field';
        const title = document.createElement('span');
        title.textContent = name;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'modal-input';
        input.dataset.variableName = name;
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.value = variableValues.get(name) || '';
        input.addEventListener('input', () => {
          variableValues.set(name, input.value);
          invalidateSearch('variable-change');
        });
        label.appendChild(title);
        label.appendChild(input);
        variablesHost.appendChild(label);
      });
    }

    function validatePresetShape(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('预设顶层必须是 JSON 对象');
      }
      if (!Array.isArray(value.vars)) throw new Error('vars 必须是列表');
      if (!Array.isArray(value.paths)) throw new Error('paths 必须是列表');
      const names = new Set();
      value.vars.forEach((name, index) => {
        if (typeof name !== 'string' || !name.trim()) {
          throw new Error('vars[' + index + '] 必须是非空字符串');
        }
        if (names.has(name.trim())) throw new Error('vars 中变量名不能重复');
        names.add(name.trim());
      });
      value.paths.forEach((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          throw new Error('paths[' + index + '] 必须是字典');
        }
        if (typeof entry.folder !== 'string') {
          throw new Error('paths[' + index + '].folder 必须是字符串');
        }
        if (typeof entry.grepKeys !== 'string' || !entry.grepKeys) {
          throw new Error('paths[' + index + '].grepKeys 必须是非空正则字符串');
        }
        if (typeof entry.hasSeq !== 'boolean') {
          throw new Error('paths[' + index + '].hasSeq 必须是布尔值');
        }
        if (typeof entry.name !== 'string' || !entry.name.trim()) {
          throw new Error('paths[' + index + '].name 必须是非空字符串');
        }
      });
      return value;
    }

    function parseEditor(showError) {
      try {
        const nextPreset = validatePresetShape(JSON.parse(presetEditor.value));
        const previousVariables = parsedPreset && Array.isArray(parsedPreset.vars)
          ? parsedPreset.vars.join('\u0000')
          : '';
        const nextVariables = nextPreset.vars.join('\u0000');
        parsedPreset = nextPreset;
        presetState.textContent = nextPreset.vars.length + ' 个变量，'
          + nextPreset.paths.length + ' 条搜索规则';
        if (previousVariables !== nextVariables || !variablesHost.childElementCount) {
          renderVariables(nextPreset.vars);
        }
        setHint('', false);
        updateButtons();
        return nextPreset;
      } catch (error) {
        parsedPreset = null;
        presetState.textContent = '预设 JSON 有错误';
        if (showError) setHint(error.message || String(error), true);
        updateButtons();
        return null;
      }
    }

    function scheduleEditorParse() {
      clearTimeout(editorParseTimer);
      editorParseTimer = setTimeout(() => {
        editorParseTimer = 0;
        invalidateSearch('preset-editor-change');
        parseEditor(false);
      }, 220);
    }

    function updateButtons() {
      const variables = collectVariableValues(false);
      const hasRoot = !!String(rootPathInput.value || '').trim();
      const hasPresetPath = !!String(presetPathInput.value || '').trim();
      const canSearch = !!parsedPreset && hasRoot && !variables.missing.length;
      rootPathInput.disabled = busy;
      presetPathInput.disabled = busy;
      presetEditor.disabled = busy;
      pickRootButton.disabled = busy;
      pickPresetButton.disabled = busy;
      loadPresetButton.disabled = busy || !hasPresetPath;
      variablesHost.querySelectorAll('input').forEach((input) => {
        input.disabled = busy;
      });
      cancelButton.disabled = busy;
      savePresetButton.disabled = busy || !parsedPreset;
      searchButton.disabled = busy || !canSearch;
      confirmButton.disabled = busy || !(searchResult && searchResult.ready);
    }

    function setBusy(nextBusy, action) {
      busy = nextBusy;
      searchButton.textContent = nextBusy && action === 'search' ? '正在搜索…' : '搜索';
      confirmButton.textContent = nextBusy && action === 'import' ? '正在导入…' : '确定导入';
      savePresetButton.textContent = nextBusy && action === 'save' ? '正在保存…' : '保存预设';
      updateButtons();
    }

    function renderSearchResults(payload) {
      const entries = Array.isArray(payload && payload.entries) ? payload.entries : [];
      resultsHost.innerHTML = '';
      entries.forEach((entry) => {
        const matches = Array.isArray(entry.matches) ? entry.matches : [];
        const row = document.createElement('div');
        row.className = 'wave-collection-result '
          + (entry.status === 'matched' ? 'is-ready' : 'is-error');
        const name = document.createElement('div');
        name.className = 'wave-collection-result-name';
        name.textContent = String(entry.name || '未命名信号')
          + (entry.hasSeq ? '（含序号）' : '（自动编号）');
        const path = document.createElement('div');
        path.className = 'wave-collection-result-path';
        if (matches.length === 1) {
          path.textContent = matches[0].path;
          path.title = '正则：' + String(entry.resolvedPattern || '');
        } else if (matches.length > 1) {
          path.textContent = matches.slice(0, 4).map((item) => item.relativePath).join('；')
            + (matches.length > 4 ? '；…' : '');
          path.title = matches.map((item) => item.path).join('\n');
        } else {
          path.textContent = entry.message || entry.searchPath || '没有匹配文件';
          path.title = '正则：' + String(entry.resolvedPattern || '');
        }
        const state = document.createElement('span');
        state.className = 'wave-collection-result-state';
        if (entry.status === 'matched') state.textContent = '已匹配';
        else if (entry.status === 'multiple') state.textContent = matches.length + ' 个匹配';
        else if (entry.status === 'folder-missing') state.textContent = '目录不存在';
        else state.textContent = '未匹配';
        row.appendChild(name);
        row.appendChild(path);
        row.appendChild(state);
        resultsHost.appendChild(row);
      });
      if (!entries.length) setEmptyResults('预设中没有搜索规则');
      resultSummary.textContent = payload.ready
        ? ('已找到 ' + Number(payload.resultCount || 0) + ' 个文件，可以导入')
        : ('共 ' + entries.length + ' 条规则，请修正未匹配或多匹配项');
    }

    async function pickPath(kind, initialPath) {
      const result = await post('pick', {
        kind,
        initialPath: String(initialPath || '')
      });
      if (result.cancelled) return '';
      return String(result.path || '');
    }

    async function loadPreset(pathValue) {
      const path = String(pathValue || '').trim();
      if (!path || busy) return;
      setBusy(true, 'load');
      setHint('正在读取预设文件…', false);
      debug({ phase: 'preset-load-start', path });
      try {
        const payload = await post('load', { presetPath: path });
        originalPresetPath = String(payload.presetPath || path);
        presetPathInput.value = originalPresetPath;
        presetEditor.value = JSON.stringify(payload.preset || EMPTY_PRESET, null, 2);
        variableValues.clear();
        parsedPreset = null;
        parseEditor(true);
        invalidateSearch('preset-loaded');
        setHint('预设已读取，请填写变量并选择数据文件夹', false);
        debug({
          phase: 'preset-load-complete',
          path: originalPresetPath,
          variableCount: parsedPreset ? parsedPreset.vars.length : 0,
          pathCount: parsedPreset ? parsedPreset.paths.length : 0
        });
      } catch (error) {
        setHint(error.message || String(error), true);
        status(false, '读取预设集合失败：' + (error.message || String(error)));
        debug({ phase: 'preset-load-error', message: error.message || String(error) });
      } finally {
        setBusy(false, '');
      }
    }

    async function chooseRoot() {
      if (busy) return;
      setBusy(true, 'pick');
      try {
        const selected = await pickPath('folder', rootPathInput.value);
        if (selected) {
          rootPathInput.value = selected;
          invalidateSearch('root-selected');
        }
      } catch (error) {
        setHint((error.message || String(error)) + '；也可以直接粘贴文件夹路径', true);
      } finally {
        setBusy(false, '');
      }
    }

    async function choosePreset() {
      if (busy) return;
      setBusy(true, 'pick');
      try {
        const selected = await pickPath('preset', presetPathInput.value);
        setBusy(false, '');
        if (selected) await loadPreset(selected);
        return;
      } catch (error) {
        setHint((error.message || String(error)) + '；也可以直接粘贴预设路径', true);
      } finally {
        setBusy(false, '');
      }
    }

    async function savePreset() {
      const preset = parseEditor(true);
      if (!preset || busy) return;
      setBusy(true, 'save');
      setHint('请选择预设保存路径…', false);
      try {
        const initialPath = originalPresetPath || presetPathInput.value;
        const selected = await pickPath('save-preset', initialPath);
        if (!selected) return;
        const payload = await post('save', {
          presetPath: selected,
          preset
        });
        originalPresetPath = String(payload.presetPath || selected);
        presetPathInput.value = originalPresetPath;
        presetEditor.value = JSON.stringify(payload.preset || preset, null, 2);
        parseEditor(false);
        setHint('预设已保存：' + originalPresetPath, false);
        status(true, '预设集合已保存');
        debug({ phase: 'preset-save-complete', path: originalPresetPath });
      } catch (error) {
        setHint(error.message || String(error), true);
        status(false, '保存预设集合失败：' + (error.message || String(error)));
        debug({ phase: 'preset-save-error', message: error.message || String(error) });
      } finally {
        setBusy(false, '');
      }
    }

    async function searchFiles() {
      const preset = parseEditor(true);
      if (!preset || busy) return;
      let variables;
      try {
        variables = collectVariableValues(true).values;
      } catch (error) {
        setHint(error.message, true);
        return;
      }
      const rootPath = String(rootPathInput.value || '').trim();
      if (!rootPath) {
        setHint('请选择数据文件夹', true);
        return;
      }
      setBusy(true, 'search');
      setHint('正在搜索匹配文件…', false);
      setEmptyResults('正在搜索…');
      debug({ phase: 'search-start', rootPath, variables });
      try {
        const payload = await post('search', { rootPath, preset, variables });
        searchResult = payload;
        renderSearchResults(payload);
        setHint(payload.ready
          ? '搜索完成，确认结果后点击“确定导入”'
          : '搜索结果不唯一，请修改变量或预设正则后重新搜索', !payload.ready);
        debug({
          phase: 'search-complete',
          ready: !!payload.ready,
          resultCount: payload.resultCount,
          entryCount: Array.isArray(payload.entries) ? payload.entries.length : 0
        });
      } catch (error) {
        searchResult = null;
        setEmptyResults('搜索失败');
        setHint(error.message || String(error), true);
        status(false, '搜索预设集合失败：' + (error.message || String(error)));
        debug({ phase: 'search-error', message: error.message || String(error) });
      } finally {
        setBusy(false, '');
      }
    }

    async function confirmImport() {
      if (busy || !(searchResult && searchResult.ready)) return;
      const preset = parseEditor(true);
      if (!preset) return;
      let variables;
      try {
        variables = collectVariableValues(true).values;
      } catch (error) {
        setHint(error.message, true);
        return;
      }
      const rootPath = String(rootPathInput.value || '').trim();
      const contextToken = typeof settings.getContextToken === 'function'
        ? settings.getContextToken()
        : '';
      setBusy(true, 'import');
      setHint('正在重新校验文件并批量解析波形…', false);
      debug({ phase: 'import-start', rootPath, variables });
      try {
        const payload = await post('import', { rootPath, preset, variables });
        if (typeof settings.getContextToken === 'function'
            && settings.getContextToken() !== contextToken) {
          throw new Error('解析期间波形图或波形库已切换，请重新搜索');
        }
        if (typeof settings.applyImport !== 'function') {
          throw new Error('批量导入处理函数未初始化');
        }
        const result = await settings.applyImport(payload);
        setHint('', false);
        status(
          true,
          (result.changed ? '已批量导入 ' : '批量导入内容未变化：')
            + result.count + ' 个信号行'
            + (result.createdCount ? '，新增 ' + result.createdCount + ' 行' : '')
        );
        debug({
          phase: 'import-complete',
          changed: result.changed,
          updateCount: result.count,
          createdCount: result.createdCount
        });
        busy = false;
        close();
      } catch (error) {
        setHint(error.message || String(error), true);
        status(false, '导入预设集合失败：' + (error.message || String(error)));
        debug({ phase: 'import-error', message: error.message || String(error) });
      } finally {
        setBusy(false, '');
      }
    }

    function open() {
      if (typeof settings.isServerMode === 'function' && !settings.isServerMode()) {
        status(false, '预设集合导入需要服务模式，请通过 BAT 或 SH 启动');
        debug({ phase: 'open-blocked', reason: 'direct-html-mode' });
        return;
      }
      busy = false;
      parsedPreset = null;
      originalPresetPath = '';
      searchResult = null;
      variableValues.clear();
      rootPathInput.value = '';
      presetPathInput.value = '';
      presetEditor.value = JSON.stringify(EMPTY_PRESET, null, 2);
      presetState.textContent = '尚未读取预设';
      variablesHost.innerHTML = '';
      renderVariables([]);
      setEmptyResults('选择数据文件夹和预设 JSON 文件');
      setHint('', false);
      modal.hidden = false;
      parseEditor(false);
      updateButtons();
      requestAnimationFrame(() => presetPathInput.focus());
      debug({ phase: 'modal-open' });
    }

    function close() {
      if (busy) return;
      modal.hidden = true;
      clearTimeout(editorParseTimer);
      editorParseTimer = 0;
      debug({ phase: 'modal-close' });
    }

    pickRootButton.addEventListener('click', () => { void chooseRoot(); });
    pickPresetButton.addEventListener('click', () => { void choosePreset(); });
    loadPresetButton.addEventListener('click', () => { void loadPreset(presetPathInput.value); });
    savePresetButton.addEventListener('click', () => { void savePreset(); });
    searchButton.addEventListener('click', () => { void searchFiles(); });
    confirmButton.addEventListener('click', () => { void confirmImport(); });
    cancelButton.addEventListener('click', close);
    presetEditor.addEventListener('input', scheduleEditorParse);
    rootPathInput.addEventListener('input', () => {
      invalidateSearch('root-path-change');
    });
    presetPathInput.addEventListener('input', updateButtons);
    presetPathInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || busy) return;
      event.preventDefault();
      void loadPreset(presetPathInput.value);
    });
    modal.addEventListener('click', (event) => {
      if (event.target === modal) close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !modal.hidden) {
        event.preventDefault();
        close();
      }
    }, true);

    return { open, close };
  }

  window.VWDImportCollection = { create };
})();

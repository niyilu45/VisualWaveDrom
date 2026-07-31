(function () {
  'use strict';

  const EMPTY_PRESET = {
    paths: [
      {
        folder: '.',
        grepKeys: '^signal\\.txt$',
        hasSeq: false,
        name: 'signal'
      }
    ]
  };
  const LEGACY_EMPTY_PRESET_TEXT = JSON.stringify({ paths: [] }, null, 2);
  const JSON_ERROR_GUTTER = 'vwd-collection-json-error-gutter';
  const SEARCH_GUTTER = 'vwd-collection-search-gutter';
  const LAST_STATE_STORAGE_KEY = 'visualwavedrom.importCollection.lastState.v1';
  const VARIABLE_NAME_PATTERN = /^[\p{L}_][\p{L}\p{N}_.-]*$/u;
  const PYTHON_VARIABLE_NAME_PATTERN = /^[\p{L}_][\p{L}\p{N}_]*$/u;
  const LEGACY_TEMPLATE_VARIABLE_PATTERN =
    /\$\{([\p{L}_][\p{L}\p{N}_.-]*)\}|\{\{([\p{L}_][\p{L}\p{N}_.-]*)\}\}|\{([\p{L}_][\p{L}\p{N}_.-]*)\}/gu;

  function parsePythonFString(template) {
    const text = String(template || '').trim();
    const match = /^(?:[fF][rR]?|[rR][fF])(["'])([\s\S]*)\1$/.exec(text);
    return match ? { body: match[2], isFString: true } : { body: text, isFString: false };
  }

  function extractTemplateVariables(template) {
    const names = [];
    const seen = new Set();
    const parsed = parsePythonFString(template);
    if (parsed.isFString) {
      for (let index = 0; index < parsed.body.length; index += 1) {
        if (parsed.body[index] !== '{') continue;
        if (parsed.body[index + 1] === '{') {
          index += 1;
          continue;
        }
        const end = parsed.body.indexOf('}', index + 1);
        if (end < 0) break;
        const name = parsed.body.slice(index + 1, end).trim();
        if (PYTHON_VARIABLE_NAME_PATTERN.test(name) && !seen.has(name)) {
          seen.add(name);
          names.push(name);
        }
        index = end;
      }
      return names;
    }
    parsed.body.replace(
      LEGACY_TEMPLATE_VARIABLE_PATTERN,
      (match, dollarName, doubleBraceName, braceName) => {
        const name = dollarName || doubleBraceName || braceName;
        if (name && !seen.has(name)) {
          seen.add(name);
          names.push(name);
        }
        return match;
      }
    );
    return names;
  }

  function create(options) {
    const settings = options || {};
    const modal = document.getElementById('wave-collection-import-modal');
    if (!modal) return null;

    const rootPathInput = document.getElementById('wave-collection-root-path');
    const presetPathInput = document.getElementById('wave-collection-preset-path');
    const pickRootButton = document.getElementById('wave-collection-pick-root');
    const pickPresetButton = document.getElementById('wave-collection-pick-preset');
    const loadPresetButton = document.getElementById('wave-collection-load-preset');
    const presetFileInput = document.getElementById('wave-collection-preset-file');
    const presetEditor = document.getElementById('wave-collection-preset-editor');
    const presetEditorShell = presetEditor.closest('.wave-collection-preset-editor-shell');
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
    let progressTimer = 0;
    let progressStartedAt = 0;
    let progressMessage = '';
    let presetCodeEditor = null;
    let presetResizeObserver = null;
    let syncingPresetCodeEditor = false;
    let selectedBrowserPresetFile = null;
    let rememberStateTimer = 0;
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

    function progressNow() {
      return window.performance && typeof window.performance.now === 'function'
        ? window.performance.now()
        : Date.now();
    }

    function renderProgress() {
      if (!progressStartedAt || !progressMessage) return;
      const seconds = Math.max(0, Math.floor((progressNow() - progressStartedAt) / 1000));
      setHint(progressMessage + (seconds ? '（已等待 ' + seconds + ' 秒，程序仍在处理）' : ''), false);
    }

    function startProgress(message) {
      clearInterval(progressTimer);
      progressStartedAt = progressNow();
      progressMessage = message;
      renderProgress();
      progressTimer = window.setInterval(renderProgress, 1000);
    }

    function updateProgress(message) {
      progressMessage = message;
      renderProgress();
    }

    function stopProgress() {
      clearInterval(progressTimer);
      progressTimer = 0;
      progressStartedAt = 0;
      progressMessage = '';
    }

    function getPresetEditorValue() {
      return presetCodeEditor ? presetCodeEditor.getValue() : presetEditor.value;
    }

    function scanJsonStringEnd(text, start) {
      let index = start + 1;
      while (index < text.length) {
        if (text[index] === '\\') {
          index += 2;
          continue;
        }
        if (text[index] === '"') return index + 1;
        index += 1;
      }
      return text.length;
    }

    function skipJsonWhitespace(text, start) {
      let index = start;
      while (index < text.length && /\s/.test(text[index])) index += 1;
      return index;
    }

    function scanJsonValueEnd(text, start) {
      let index = skipJsonWhitespace(text, start);
      if (text[index] === '"') return scanJsonStringEnd(text, index);
      if (text[index] !== '{' && text[index] !== '[') {
        while (index < text.length && !/[,}\]]/.test(text[index])) index += 1;
        return index;
      }
      const stack = [text[index] === '{' ? '}' : ']'];
      index += 1;
      while (index < text.length && stack.length) {
        const char = text[index];
        if (char === '"') {
          index = scanJsonStringEnd(text, index);
          continue;
        }
        if (char === '{') stack.push('}');
        else if (char === '[') stack.push(']');
        else if (char === stack[stack.length - 1]) stack.pop();
        index += 1;
      }
      return index;
    }

    function lineNumberAt(text, position) {
      let line = 1;
      for (let index = 0; index < position; index += 1) {
        if (text[index] === '\n') line += 1;
      }
      return line;
    }

    function findPresetPathObjectRanges(text) {
      try {
        let index = skipJsonWhitespace(text, 0);
        if (text[index] !== '{') return [];
        index += 1;
        while (index < text.length) {
          index = skipJsonWhitespace(text, index);
          if (text[index] === '}') return [];
          if (text[index] !== '"') return [];
          const keyStart = index;
          const keyEnd = scanJsonStringEnd(text, keyStart);
          const key = JSON.parse(text.slice(keyStart, keyEnd));
          index = skipJsonWhitespace(text, keyEnd);
          if (text[index] !== ':') return [];
          index = skipJsonWhitespace(text, index + 1);
          if (key === 'paths' && text[index] === '[') {
            const ranges = [];
            index += 1;
            while (index < text.length) {
              index = skipJsonWhitespace(text, index);
              if (text[index] === ']') return ranges;
              const start = index;
              const end = scanJsonValueEnd(text, index);
              ranges.push({ start, end, line: lineNumberAt(text, start) });
              index = skipJsonWhitespace(text, end);
              if (text[index] === ',') {
                index += 1;
                continue;
              }
              if (text[index] === ']') return ranges;
              return [];
            }
            return ranges;
          }
          index = skipJsonWhitespace(text, scanJsonValueEnd(text, index));
          if (text[index] === ',') {
            index += 1;
            continue;
          }
          if (text[index] === '}') return [];
          return [];
        }
      } catch (_error) {
        return [];
      }
      return [];
    }

    function findPresetPathObjectLines(text) {
      return findPresetPathObjectRanges(text).map((range) => range.line);
    }

    function findJsonObjectKeyLine(text, range, expectedKey) {
      if (!range || text[range.start] !== '{') return 0;
      let index = range.start + 1;
      while (index < range.end) {
        index = skipJsonWhitespace(text, index);
        if (text[index] === '}') return 0;
        if (text[index] !== '"') return 0;
        const keyStart = index;
        const keyEnd = scanJsonStringEnd(text, keyStart);
        let key;
        try {
          key = JSON.parse(text.slice(keyStart, keyEnd));
        } catch (_error) {
          return 0;
        }
        index = skipJsonWhitespace(text, keyEnd);
        if (text[index] !== ':') return 0;
        index = skipJsonWhitespace(text, index + 1);
        if (key === expectedKey) return lineNumberAt(text, keyStart);
        index = skipJsonWhitespace(text, scanJsonValueEnd(text, index));
        if (text[index] === ',') {
          index += 1;
          continue;
        }
        if (text[index] === '}') return 0;
        return 0;
      }
      return 0;
    }

    function findRootKeyLine(text, expectedKey) {
      const start = skipJsonWhitespace(text, 0);
      if (text[start] !== '{') return 0;
      return findJsonObjectKeyLine(text, {
        start,
        end: scanJsonValueEnd(text, start)
      }, expectedKey);
    }

    function validationError(message, jsonPath) {
      const error = new Error(message);
      error.jsonPath = jsonPath || '';
      return error;
    }

    function findValidationErrorLine(text, jsonPath) {
      const path = String(jsonPath || '');
      const pathMatch = /^paths\[(\d+)\](?:\.([A-Za-z0-9_-]+))?$/.exec(path);
      if (pathMatch) {
        const range = findPresetPathObjectRanges(text)[Number(pathMatch[1])];
        if (!range) return findRootKeyLine(text, 'paths');
        return pathMatch[2]
          ? (findJsonObjectKeyLine(text, range, pathMatch[2]) || range.line)
          : range.line;
      }
      if (/^vars(?:\[\d+\])?$/.test(path)) return findRootKeyLine(text, 'vars');
      if (path === 'paths' || path === 'vars') return findRootKeyLine(text, path);
      return 0;
    }

    function jsonErrorLocation(error, text) {
      const source = String(text || '');
      const validationLine = findValidationErrorLine(source, error && error.jsonPath);
      if (validationLine > 0) return { line: validationLine, column: 1 };

      const message = String(error && error.message || error || '');
      const lineMatch = /\bline\s+(\d+)(?:\s+column\s+(\d+))?/i.exec(message);
      if (lineMatch) {
        return {
          line: Math.max(1, Number(lineMatch[1]) || 1),
          column: Math.max(1, Number(lineMatch[2]) || 1)
        };
      }
      const positionMatch = /\bposition\s+(\d+)/i.exec(message);
      if (positionMatch) {
        const position = Math.max(0, Math.min(source.length, Number(positionMatch[1]) || 0));
        const lineStart = source.lastIndexOf('\n', Math.max(0, position - 1)) + 1;
        return {
          line: lineNumberAt(source, position),
          column: Math.max(1, position - lineStart + 1)
        };
      }
      return { line: 1, column: 1 };
    }

    function clearJsonErrorMarker() {
      if (presetCodeEditor) presetCodeEditor.clearGutter(JSON_ERROR_GUTTER);
    }

    function renderJsonErrorMarker(error, text) {
      if (!presetCodeEditor) return null;
      clearJsonErrorMarker();
      const location = jsonErrorLocation(error, text);
      const marker = document.createElement('span');
      marker.className = 'wave-collection-json-error-marker';
      marker.textContent = '×';
      marker.title = '第 ' + location.line + ' 行：'
        + String(error && error.message || error || 'JSON 错误');
      marker.setAttribute('aria-label', marker.title);
      presetCodeEditor.setGutterMarker(
        Math.max(0, location.line - 1),
        JSON_ERROR_GUTTER,
        marker
      );
      return location;
    }

    function clearSearchMarkers() {
      if (presetCodeEditor) presetCodeEditor.clearGutter(SEARCH_GUTTER);
    }

    function renderSearchMarkers(payload) {
      if (!presetCodeEditor) return;
      clearSearchMarkers();
      const lines = findPresetPathObjectLines(getPresetEditorValue());
      const entries = Array.isArray(payload && payload.entries) ? payload.entries : [];
      const markersByLine = new Map();
      entries.forEach((entry, fallbackIndex) => {
        const entryIndex = Number.isInteger(Number(entry.index))
          ? Number(entry.index)
          : fallbackIndex;
        const lineNumber = lines[entryIndex];
        if (!lineNumber) return;
        const matches = Array.isArray(entry.matches) ? entry.matches : [];
        let state = 'missing';
        let symbol = '!';
        let label = '未搜索到文件';
        if (entry.status === 'duplicate-name') {
          state = 'duplicate';
          symbol = '×';
          label = entry.message || 'name 重复';
        } else if (matches.length === 1) {
          state = 'matched';
          symbol = '✓';
          label = '搜索到 1 个文件';
        } else if (matches.length > 1) {
          state = 'multiple';
          label = '搜索到 ' + matches.length + ' 个文件，默认取第一个';
        }
        if (!markersByLine.has(lineNumber)) markersByLine.set(lineNumber, []);
        markersByLine.get(lineNumber).push({ state, symbol, label });
      });
      markersByLine.forEach((items, lineNumber) => {
        const marker = document.createElement('span');
        marker.className = 'wave-collection-search-markers';
        marker.title = items.map((item) => item.label).join('；');
        marker.setAttribute('aria-label', marker.title);
        items.forEach((item) => {
          const symbol = document.createElement('span');
          symbol.className = 'wave-collection-search-marker is-' + item.state;
          symbol.textContent = item.symbol;
          marker.appendChild(symbol);
        });
        presetCodeEditor.setGutterMarker(lineNumber - 1, SEARCH_GUTTER, marker);
      });
    }

    function setPresetEditorValue(value) {
      const text = String(value == null ? '' : value);
      clearSearchMarkers();
      clearJsonErrorMarker();
      presetEditor.value = text;
      if (!presetCodeEditor || presetCodeEditor.getValue() === text) return;
      syncingPresetCodeEditor = true;
      try {
        presetCodeEditor.setValue(text);
        presetCodeEditor.clearHistory();
      } finally {
        syncingPresetCodeEditor = false;
      }
    }

    function readRememberedState() {
      try {
        const raw = window.localStorage.getItem(LAST_STATE_STORAGE_KEY);
        if (!raw) return null;
        const value = JSON.parse(raw);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        return {
          rootPath: String(value.rootPath || ''),
          presetPath: String(value.presetPath || ''),
          originalPresetPath: String(value.originalPresetPath || ''),
          presetText: typeof value.presetText === 'string' ? value.presetText : '',
          variables: value.variables && typeof value.variables === 'object'
            && !Array.isArray(value.variables) ? value.variables : {}
        };
      } catch (error) {
        debug({ phase: 'state-read-error', message: error.message || String(error) });
        return null;
      }
    }

    function rememberState(reason) {
      clearTimeout(rememberStateTimer);
      rememberStateTimer = 0;
      collectVariableValues();
      const variables = {};
      variableValues.forEach((value, name) => {
        variables[name] = String(value == null ? '' : value);
      });
      const state = {
        rootPath: String(rootPathInput.value || '').trim(),
        presetPath: String(presetPathInput.value || '').trim(),
        originalPresetPath: String(originalPresetPath || '').trim(),
        presetText: getPresetEditorValue(),
        variables
      };
      try {
        window.localStorage.setItem(LAST_STATE_STORAGE_KEY, JSON.stringify(state));
        debug({
          phase: 'state-saved',
          reason: reason || 'changed',
          hasRootPath: !!state.rootPath,
          hasPresetPath: !!state.presetPath,
          presetLength: state.presetText.length,
          variableCount: Object.keys(variables).length
        });
      } catch (error) {
        debug({ phase: 'state-save-error', message: error.message || String(error) });
      }
      return state;
    }

    function scheduleRememberState(reason) {
      clearTimeout(rememberStateTimer);
      rememberStateTimer = setTimeout(() => {
        rememberState(reason);
      }, 250);
    }

    function restoreRememberedState() {
      const state = readRememberedState();
      if (!state) return false;
      const defaultPresetText = JSON.stringify(EMPTY_PRESET, null, 2);
      if (!state.rootPath && !state.presetPath
          && (!state.presetText
            || state.presetText === defaultPresetText
            || state.presetText === LEGACY_EMPTY_PRESET_TEXT)) {
        return false;
      }
      rootPathInput.value = state.rootPath;
      presetPathInput.value = state.presetPath;
      originalPresetPath = state.originalPresetPath;
      if (selectedBrowserPresetFile
          && selectedBrowserPresetFile.name !== state.presetPath) {
        selectedBrowserPresetFile = null;
      }
      variableValues.clear();
      Object.keys(state.variables).forEach((name) => {
        variableValues.set(name, String(state.variables[name] || ''));
      });
      setPresetEditorValue(
        state.presetText || defaultPresetText
      );
      debug({
        phase: 'state-restored',
        hasRootPath: !!state.rootPath,
        hasPresetPath: !!state.presetPath,
        presetLength: state.presetText.length,
        variableCount: variableValues.size
      });
      return true;
    }

    function ensurePresetCodeEditor() {
      if (window.VWDCodeEditorPairs) {
        window.VWDCodeEditorPairs.attachTextArea(presetEditor, {
          canEdit: () => !busy,
          onWrap: (details) => {
            debug(Object.assign({
              phase: 'wrap-selection',
              editor: 'preset-textarea'
            }, details));
          }
        });
      }
      if (presetCodeEditor || !window.CodeMirror || !presetEditorShell) {
        return presetCodeEditor;
      }
      presetCodeEditor = window.CodeMirror.fromTextArea(presetEditor, {
        mode: { name: 'javascript', json: true },
        lineNumbers: true,
        gutters: [JSON_ERROR_GUTTER, SEARCH_GUTTER, 'CodeMirror-linenumbers'],
        lineWrapping: true,
        indentUnit: 2,
        tabSize: 2,
        indentWithTabs: false,
        viewportMargin: 20
      });
      presetCodeEditor.setSize('100%', '100%');
      const input = presetCodeEditor.getInputField();
      if (input) input.setAttribute('aria-label', '预设 JSON 内容');
      if (window.VWDCodeEditorPairs) {
        window.VWDCodeEditorPairs.attachCodeMirror(presetCodeEditor, {
          canEdit: () => !busy,
          onWrap: (details) => {
            debug(Object.assign({
              phase: 'wrap-selection',
              editor: 'preset'
            }, details));
          }
        });
      }
      presetCodeEditor.on('change', (editor) => {
        if (syncingPresetCodeEditor) return;
        presetEditor.value = editor.getValue();
        clearSearchMarkers();
        clearJsonErrorMarker();
        scheduleEditorParse();
      });
      presetCodeEditor.on('keydown', (editor, event) => {
        if (!event || event.altKey || !(event.ctrlKey || event.metaKey)) return;
        const key = String(event.key || '').toLowerCase();
        const undoRequested = key === 'z' && !event.shiftKey;
        const redoRequested = (key === 'z' && event.shiftKey) || key === 'y';
        if (!undoRequested && !redoRequested) return;
        event.preventDefault();
        event.stopPropagation();
        if (undoRequested) editor.undo();
        else editor.redo();
        debug({
          phase: 'preset-editor-history',
          action: undoRequested ? 'undo' : 'redo'
        });
      });
      if (window.ResizeObserver) {
        presetResizeObserver = new window.ResizeObserver(() => {
          if (presetCodeEditor && !modal.hidden) presetCodeEditor.refresh();
        });
        presetResizeObserver.observe(presetEditorShell);
      }
      return presetCodeEditor;
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

    function collectVariableValues() {
      const values = {};
      variablesHost.querySelectorAll('input[data-variable-name]').forEach((input) => {
        const name = input.dataset.variableName;
        const value = String(input.value || '').trim();
        variableValues.set(name, value);
        values[name] = value || '0';
      });
      return { values, missing: [] };
    }

    function invalidateSearch(reason) {
      if (searchResult) {
        debug({ phase: 'search-invalidated', reason: reason || 'changed' });
      }
      searchResult = null;
      clearSearchMarkers();
      setEmptyResults('预设、目录或变量已变化，请重新搜索');
      updateButtons();
    }

    function renderVariables(variableNames) {
      collectVariableValues(false);
      variablesHost.innerHTML = '';
      if (!variableNames.length) {
        const empty = document.createElement('div');
        empty.className = 'modal-empty-state';
        empty.textContent = 'grepKeys 中没有模板变量';
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
        input.placeholder = '留空按 0';
        input.addEventListener('input', () => {
          variableValues.set(name, input.value);
          invalidateSearch('variable-change');
          scheduleRememberState('variable-change');
        });
        label.appendChild(title);
        label.appendChild(input);
        variablesHost.appendChild(label);
      });
    }

    function validatePresetShape(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw validationError('预设顶层必须是 JSON 对象', '');
      }
      if (value.vars !== undefined && !Array.isArray(value.vars)) {
        throw validationError('vars 必须是列表；也可以省略并由 grepKeys 自动提取', 'vars');
      }
      if (!Array.isArray(value.paths)) {
        throw validationError('paths 必须是列表', 'paths');
      }
      const names = new Set();
      (value.vars || []).forEach((name, index) => {
        if (typeof name !== 'string' || !name.trim()) {
          throw validationError('vars[' + index + '] 必须是非空字符串', 'vars[' + index + ']');
        }
        const normalizedName = name.trim();
        if (!VARIABLE_NAME_PATTERN.test(normalizedName)) {
          throw validationError('vars[' + index + '] 不是有效变量名', 'vars[' + index + ']');
        }
        if (names.has(normalizedName)) {
          throw validationError('vars 中变量名不能重复', 'vars[' + index + ']');
        }
        names.add(normalizedName);
      });
      value.paths.forEach((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          throw validationError('paths[' + index + '] 必须是字典', 'paths[' + index + ']');
        }
        if (typeof entry.folder !== 'string') {
          throw validationError(
            'paths[' + index + '].folder 必须是字符串',
            'paths[' + index + '].folder'
          );
        }
        if (typeof entry.grepKeys !== 'string' || !entry.grepKeys) {
          throw validationError(
            'paths[' + index + '].grepKeys 必须是非空正则字符串',
            'paths[' + index + '].grepKeys'
          );
        }
        if (typeof entry.hasSeq !== 'boolean') {
          throw validationError(
            'paths[' + index + '].hasSeq 必须是布尔值',
            'paths[' + index + '].hasSeq'
          );
        }
        if (typeof entry.name !== 'string' || !entry.name.trim()) {
          throw validationError(
            'paths[' + index + '].name 必须是非空字符串',
            'paths[' + index + '].name'
          );
        }
        extractTemplateVariables(entry.grepKeys).forEach((name) => names.add(name));
      });
      value.vars = Array.from(names);
      return value;
    }

    function parseEditor(showError) {
      const editorText = getPresetEditorValue();
      try {
        const nextPreset = validatePresetShape(JSON.parse(editorText));
        const previousVariables = parsedPreset && Array.isArray(parsedPreset.vars)
          ? parsedPreset.vars.join('\u0000')
          : '';
        const nextVariables = nextPreset.vars.join('\u0000');
        parsedPreset = nextPreset;
        presetState.textContent = '从 grepKeys 自动识别 ' + nextPreset.vars.length + ' 个变量，'
          + nextPreset.paths.length + ' 条搜索规则';
        if (previousVariables !== nextVariables || !variablesHost.childElementCount) {
          renderVariables(nextPreset.vars);
        }
        clearJsonErrorMarker();
        setHint('', false);
        updateButtons();
        return nextPreset;
      } catch (error) {
        parsedPreset = null;
        presetState.textContent = '预设 JSON 有错误';
        const location = renderJsonErrorMarker(error, editorText);
        if (showError) {
          setHint(
            (location ? ('第 ' + location.line + ' 行：') : '')
              + (error.message || String(error)),
            true
          );
        }
        updateButtons();
        return null;
      }
    }

    function scheduleEditorParse() {
      clearTimeout(editorParseTimer);
      scheduleRememberState('preset-editor-change');
      editorParseTimer = setTimeout(() => {
        editorParseTimer = 0;
        invalidateSearch('preset-editor-change');
        parseEditor(false);
      }, 220);
    }

    function updateButtons() {
      collectVariableValues();
      const hasRoot = !!String(rootPathInput.value || '').trim();
      const hasPresetPath = !!String(presetPathInput.value || '').trim();
      const canSearch = !!parsedPreset && hasRoot;
      rootPathInput.disabled = busy;
      presetPathInput.disabled = busy;
      presetEditor.disabled = busy;
      if (presetCodeEditor) {
        presetCodeEditor.setOption('readOnly', busy ? 'nocursor' : false);
        presetCodeEditor.getWrapperElement().setAttribute('aria-disabled', String(busy));
      }
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
      if (!nextBusy) stopProgress();
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
          + (entry.status === 'matched'
            ? 'is-ready'
            : (entry.status === 'multiple' ? 'is-warning' : 'is-error'));
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
          path.textContent = '默认选择：' + matches[0].relativePath
            + (matches.length > 1
              ? '；其他候选：' + matches.slice(1, 4)
                .map((item) => item.relativePath).join('；')
              : '')
            + (matches.length > 4 ? '；…' : '');
          path.title = matches.map((item) => item.path).join('\n');
        } else {
          path.textContent = entry.message || entry.searchPath || '没有匹配文件';
          path.title = '正则：' + String(entry.resolvedPattern || '');
        }
        const state = document.createElement('span');
        state.className = 'wave-collection-result-state';
        if (entry.status === 'matched') state.textContent = '已匹配';
        else if (entry.status === 'multiple') state.textContent = matches.length + ' 个匹配，取第 1 个';
        else if (entry.status === 'duplicate-name') state.textContent = 'name重复';
        else if (entry.status === 'folder-missing') state.textContent = '目录不存在，跳过';
        else state.textContent = '未匹配，跳过';
        row.appendChild(name);
        row.appendChild(path);
        row.appendChild(state);
        resultsHost.appendChild(row);
      });
      if (!entries.length) setEmptyResults('预设中没有搜索规则');
      renderSearchMarkers(payload);
      const multipleCount = entries.filter((entry) => entry.status === 'multiple').length;
      const skippedCount = entries.filter((entry) =>
        entry.status === 'missing' || entry.status === 'folder-missing').length;
      resultSummary.textContent = payload.ready
        ? ('已选择 ' + Number(payload.resultCount || 0) + ' 个文件，可以导入'
          + (skippedCount ? '；跳过 ' + skippedCount + ' 条未匹配规则' : '')
          + (multipleCount ? '；' + multipleCount + ' 条规则默认取第一个' : ''))
        : (Number(payload.resultCount || 0) > 0
          ? '存在重复信号名，请修改后重新搜索'
          : '没有找到可导入的文件');
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
      if (selectedBrowserPresetFile && path === selectedBrowserPresetFile.name) {
        await loadBrowserPreset(selectedBrowserPresetFile);
        return;
      }
      setBusy(true, 'load');
      startProgress('正在读取预设文件…');
      const startedAt = progressStartedAt;
      debug({ phase: 'preset-load-start', path });
      try {
        const payload = await post('load', { presetPath: path });
        selectedBrowserPresetFile = null;
        originalPresetPath = String(payload.presetPath || path);
        presetPathInput.value = originalPresetPath;
        setPresetEditorValue(JSON.stringify(payload.preset || EMPTY_PRESET, null, 2));
        variableValues.clear();
        parsedPreset = null;
        parseEditor(true);
        invalidateSearch('preset-loaded');
        rememberState('preset-loaded');
        setHint('预设已读取；变量从 grepKeys 自动识别，留空按 0 匹配', false);
        debug({
          phase: 'preset-load-complete',
          path: originalPresetPath,
          variableCount: parsedPreset ? parsedPreset.vars.length : 0,
          pathCount: parsedPreset ? parsedPreset.paths.length : 0,
          durationMs: Math.round(progressNow() - startedAt)
        });
      } catch (error) {
        setHint(error.message || String(error), true);
        status(false, '读取预设集合失败：' + (error.message || String(error)));
        debug({ phase: 'preset-load-error', message: error.message || String(error) });
      } finally {
        setBusy(false, '');
      }
    }

    async function loadBrowserPreset(file) {
      if (!file || busy) return;
      setBusy(true, 'load');
      startProgress('正在读取预设文件…');
      const startedAt = progressStartedAt;
      debug({
        phase: 'preset-browser-load-start',
        name: file.name,
        size: file.size
      });
      try {
        if (file.size > 2 * 1024 * 1024) {
          throw new Error('预设 JSON 文件不能超过 2 MB');
        }
        const text = String(await file.text()).replace(/^\uFEFF/, '');
        const preset = validatePresetShape(JSON.parse(text));
        selectedBrowserPresetFile = file;
        originalPresetPath = '';
        presetPathInput.value = file.name;
        setPresetEditorValue(JSON.stringify(preset, null, 2));
        variableValues.clear();
        parsedPreset = null;
        parseEditor(true);
        invalidateSearch('preset-browser-loaded');
        rememberState('preset-browser-loaded');
        setHint('已读取预设文件：' + file.name, false);
        debug({
          phase: 'preset-browser-load-complete',
          name: file.name,
          variableCount: preset.vars.length,
          pathCount: preset.paths.length,
          durationMs: Math.round(progressNow() - startedAt)
        });
      } catch (error) {
        selectedBrowserPresetFile = null;
        setHint(error.message || String(error), true);
        status(false, '读取预设集合失败：' + (error.message || String(error)));
        debug({
          phase: 'preset-browser-load-error',
          name: file.name,
          message: error.message || String(error)
        });
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
          rememberState('root-selected');
        }
      } catch (error) {
        setHint((error.message || String(error)) + '；也可以直接粘贴文件夹路径', true);
      } finally {
        setBusy(false, '');
      }
    }

    async function choosePreset() {
      if (busy || !presetFileInput) return;
      presetFileInput.value = '';
      debug({ phase: 'preset-browser-picker-open' });
      presetFileInput.click();
    }

    async function savePreset() {
      const preset = parseEditor(true);
      if (!preset || busy) return;
      setBusy(true, 'save');
      startProgress('请选择预设保存路径…');
      const startedAt = progressStartedAt;
      try {
        const initialPath = originalPresetPath
          || (selectedBrowserPresetFile ? '' : presetPathInput.value);
        const selected = await pickPath('save-preset', initialPath);
        if (!selected) return;
        const payload = await post('save', {
          presetPath: selected,
          preset
        });
        originalPresetPath = String(payload.presetPath || selected);
        presetPathInput.value = originalPresetPath;
        setPresetEditorValue(JSON.stringify(payload.preset || preset, null, 2));
        parseEditor(false);
        rememberState('preset-saved');
        setHint('预设已保存：' + originalPresetPath, false);
        status(true, '预设集合已保存');
        debug({
          phase: 'preset-save-complete',
          path: originalPresetPath,
          durationMs: Math.round(progressNow() - startedAt)
        });
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
        variables = collectVariableValues().values;
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
      startProgress('正在建立文件索引并匹配规则…');
      const startedAt = progressStartedAt;
      setEmptyResults('正在搜索…');
      debug({ phase: 'search-start', rootPath, variables });
      try {
        const payload = await post('search', { rootPath, preset, variables });
        searchResult = payload;
        renderSearchResults(payload);
        const searchDetails = '扫描 ' + Number(payload.visitedFiles || 0)
          + ' 个文件、' + Number(payload.scanCount || 0) + ' 个目录根，耗时 '
          + Number(payload.durationMs || Math.round(progressNow() - startedAt)) + ' ms';
        const multipleCount = Array.isArray(payload.entries)
          ? payload.entries.filter((entry) => entry.status === 'multiple').length
          : 0;
        const skippedCount = Array.isArray(payload.entries)
          ? payload.entries.filter((entry) =>
            entry.status === 'missing' || entry.status === 'folder-missing').length
          : 0;
        setHint(payload.ready
          ? ('搜索完成：' + searchDetails + '。确认结果后点击“确定导入”'
            + (skippedCount ? '；' + skippedCount + ' 条未匹配规则将被跳过' : '')
            + (multipleCount ? '；多匹配规则已默认选择第一个文件' : ''))
          : ('搜索完成：' + searchDetails
            + (Number(payload.resultCount || 0) > 0
              ? '。请修改重复信号名'
              : '。没有找到可导入文件')), !payload.ready);
        debug({
          phase: 'search-complete',
          ready: !!payload.ready,
          resultCount: payload.resultCount,
          entryCount: Array.isArray(payload.entries) ? payload.entries.length : 0,
          visitedFiles: payload.visitedFiles,
          scanCount: payload.scanCount,
          regexEngine: payload.regexEngine,
          serverDurationMs: payload.durationMs,
          clientDurationMs: Math.round(progressNow() - startedAt),
          hasSearchToken: !!payload.searchToken
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
        variables = collectVariableValues().values;
      } catch (error) {
        setHint(error.message, true);
        return;
      }
      const rootPath = String(rootPathInput.value || '').trim();
      const contextToken = typeof settings.getContextToken === 'function'
        ? settings.getContextToken()
        : '';
      setBusy(true, 'import');
      const fileCount = Number(searchResult.resultCount || 0);
      startProgress('正在核对并解析 ' + fileCount + ' 个文件…');
      const startedAt = progressStartedAt;
      debug({
        phase: 'import-start',
        rootPath,
        variables,
        fileCount,
        hasSearchToken: !!searchResult.searchToken
      });
      try {
        const payload = await post('import', {
          rootPath,
          preset,
          variables,
          searchToken: searchResult.searchToken || ''
        });
        if (typeof settings.getContextToken === 'function'
            && settings.getContextToken() !== contextToken) {
          throw new Error('解析期间波形图或波形库已切换，请重新搜索');
        }
        if (typeof settings.applyImport !== 'function') {
          throw new Error('批量导入处理函数未初始化');
        }
        updateProgress('文件解析完成，正在写入当前波形图…');
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
          createdCount: result.createdCount,
          workerCount: payload.workerCount,
          parseDurationMs: payload.parseDurationMs,
          serverDurationMs: payload.durationMs,
          clientDurationMs: Math.round(progressNow() - startedAt)
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
      searchResult = null;
      const restored = restoreRememberedState();
      if (!restored) {
        originalPresetPath = '';
        selectedBrowserPresetFile = null;
        variableValues.clear();
        rootPathInput.value = '';
        presetPathInput.value = '';
        setPresetEditorValue(JSON.stringify(EMPTY_PRESET, null, 2));
      }
      presetState.textContent = restored ? '正在恢复上次预设' : '尚未读取预设';
      variablesHost.innerHTML = '';
      renderVariables([]);
      setEmptyResults(restored
        ? '已恢复上次输入，请重新搜索'
        : '选择数据文件夹和预设 JSON 文件');
      modal.hidden = false;
      ensurePresetCodeEditor();
      parseEditor(false);
      setHint(restored ? '已恢复上次的数据文件夹和预设 JSON' : '', false);
      updateButtons();
      requestAnimationFrame(() => {
        if (presetCodeEditor) presetCodeEditor.refresh();
        presetPathInput.focus();
      });
      debug({ phase: 'modal-open', restored });
    }

    function close() {
      if (busy) return;
      rememberState('modal-close');
      modal.hidden = true;
      clearTimeout(editorParseTimer);
      editorParseTimer = 0;
      stopProgress();
      debug({ phase: 'modal-close' });
    }

    pickRootButton.addEventListener('click', () => { void chooseRoot(); });
    pickPresetButton.addEventListener('click', () => { void choosePreset(); });
    presetFileInput.addEventListener('change', () => {
      const file = presetFileInput.files && presetFileInput.files[0];
      if (file) void loadBrowserPreset(file);
    });
    loadPresetButton.addEventListener('click', () => { void loadPreset(presetPathInput.value); });
    savePresetButton.addEventListener('click', () => { void savePreset(); });
    searchButton.addEventListener('click', () => { void searchFiles(); });
    confirmButton.addEventListener('click', () => { void confirmImport(); });
    cancelButton.addEventListener('click', close);
    presetEditor.addEventListener('input', scheduleEditorParse);
    rootPathInput.addEventListener('input', () => {
      invalidateSearch('root-path-change');
      scheduleRememberState('root-path-change');
    });
    presetPathInput.addEventListener('input', () => {
      selectedBrowserPresetFile = null;
      scheduleRememberState('preset-path-change');
      updateButtons();
    });
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

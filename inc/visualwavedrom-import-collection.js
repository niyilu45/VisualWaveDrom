(function () {
  'use strict';

  const EMPTY_PRESET = {
    paths: [
      {
        usrGen: {
          folder: '.',
          grepKeys: '^signal\\.txt$',
          name: 'signal'
        },
        autoGen: {}
      }
    ]
  };
  const LEGACY_EMPTY_PRESET_TEXT = JSON.stringify({ paths: [] }, null, 2);
  const JSON_ERROR_GUTTER = 'vwd-collection-json-error-gutter';
  const SEARCH_GUTTER = 'vwd-collection-search-gutter';
  const LAST_STATE_STORAGE_KEY = 'visualwavedrom.importCollection.lastState.v1';
  const DEFAULT_PRESET_SEARCH_PATH = 'inc/import/SchemeCollection';
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

  function columnFilterError(value) {
    const expression = String(value || '').trim();
    if (!expression) return '';
    const groups = expression.split('||');
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      if (!groups[groupIndex].trim()) return '“||”两侧都需要条件';
      const clauses = groups[groupIndex].split('&&');
      for (let clauseIndex = 0; clauseIndex < clauses.length; clauseIndex += 1) {
        const clause = clauses[clauseIndex].trim();
        if (!clause) return '“&&”两侧都需要条件';
        const match = clause.match(/^(==|!=|>=|<=|>|<|=)?\s*(.*)$/s);
        const operator = match && match[1] ? match[1] : '==';
        const operand = match ? match[2].trim() : '';
        if (!operand) return '比较值不能为空';
        if ((operator === '>' || operator === '>=' || operator === '<' || operator === '<=')
            && !Number.isFinite(Number(operand))) {
          return '大小比较的值必须是数字';
        }
      }
    }
    return '';
  }

  function create(options) {
    const settings = options || {};
    const modal = document.getElementById('wave-collection-import-modal');
    if (!modal) return null;

    const rootPathInput = document.getElementById('wave-collection-root-path');
    const presetSearchPathInput = document.getElementById('wave-collection-preset-search-path');
    const presetPathInput = document.getElementById('wave-collection-preset-path');
    const pickRootButton = document.getElementById('wave-collection-pick-root');
    const pickPresetRootButton = document.getElementById('wave-collection-pick-preset-root');
    const scanPresetsButton = document.getElementById('wave-collection-scan-presets');
    const presetDiscoveryHost = document.getElementById('wave-collection-preset-discovery');
    const pickPresetButton = document.getElementById('wave-collection-pick-preset');
    const loadPresetButton = document.getElementById('wave-collection-load-preset');
    const presetFileInput = document.getElementById('wave-collection-preset-file');
    const presetEditor = document.getElementById('wave-collection-preset-editor');
    const presetEditorShell = presetEditor.closest('.wave-collection-preset-editor-shell');
    const presetNavigation = document.getElementById('wave-collection-preset-nav');
    const presetState = document.getElementById('wave-collection-preset-state');
    const variablesHost = document.getElementById('wave-collection-vars');
    const resultsHost = document.getElementById('wave-collection-results');
    const resultSummary = document.getElementById('wave-collection-result-summary');
    const hint = document.getElementById('wave-collection-hint');
    const footerProgress = document.getElementById('wave-collection-import-progress');
    const cancelButton = document.getElementById('wave-collection-cancel');
    const savePresetButton = document.getElementById('wave-collection-save-preset');
    const searchButton = document.getElementById('wave-collection-search');
    const confirmButton = document.getElementById('wave-collection-confirm');

    let busy = false;
    let busyAction = '';
    let activeImportController = null;
    let activeImportProgressToken = '';
    let importCancelRequested = false;
    let importCancellationAllowed = false;
    let parsedPreset = null;
    let originalPresetPath = '';
    let searchResult = null;
    let editorParseTimer = 0;
    let progressTimer = 0;
    let progressStartedAt = 0;
    let progressMessage = '';
    let importProgressState = null;
    let importProgressPollTimer = 0;
    let importProgressPollStopped = true;
    let importProgressPollGeneration = 0;
    let importProgressPollErrorLogged = false;
    let presetCodeEditor = null;
    let presetResizeObserver = null;
    let syncingPresetCodeEditor = false;
    let selectedBrowserPresetFile = null;
    let selectedDiscoveredPreset = null;
    let discoveredPresets = [];
    let rememberStateTimer = 0;
    let manualSavePathMode = false;
    let activePresetNavigationIndex = -1;
    let presetNavigationRanges = [];
    let presetNavigationHighlightLine = null;
    let presetNavigationHighlightTimer = 0;
    let modalBackdropPress = null;
    let formulaDiagnostics = new Map();
    let multiWaveDiagnostics = new Map();
    const variableValues = new Map();
    const singlePreviewStates = new Map();

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

    function setFooterProgress(message, isError) {
      if (!footerProgress) return;
      const text = String(message || '');
      footerProgress.textContent = text;
      footerProgress.hidden = !text;
      footerProgress.classList.toggle('is-error', !!text && !!isError);
    }

    function progressNow() {
      return window.performance && typeof window.performance.now === 'function'
        ? window.performance.now()
        : Date.now();
    }

    function createImportProgressToken() {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return 'import-' + window.crypto.randomUUID();
      }
      return 'import-' + Date.now().toString(36) + '-'
        + Math.random().toString(36).slice(2, 12);
    }

    function applyImportProgress(progress) {
      if (!progress || typeof progress !== 'object') return;
      importProgressState = Object.assign({}, importProgressState || {}, {
        phase: String(progress.phase || 'parsing'),
        totalFiles: Math.max(0, Number(progress.totalFiles || 0)),
        completedFiles: Math.max(0, Number(progress.completedFiles || 0)),
        successfulFiles: Math.max(0, Number(progress.successfulFiles || 0)),
        failedFiles: Math.max(0, Number(progress.failedFiles || 0)),
        signalCount: Math.max(0, Number(progress.signalCount || 0)),
        done: !!progress.done,
        cancelled: !!progress.cancelled
      });
      renderProgress();
    }

    function applyFormulaProgress(progress) {
      if (!progress || typeof progress !== 'object') return;
      const phase = String(progress.phase || 'formula');
      importProgressState = Object.assign({}, importProgressState || {}, {
        phase,
        done: false
      });
      if (phase === 'formula') {
        Object.assign(importProgressState, {
          formulaStage: String(progress.stage || 'evaluating'),
          formulaIndex: Math.max(0, Number(progress.index || 0)),
          totalFormulas: Math.max(0, Number(progress.total || 0)),
          currentFormula: String(progress.name || '')
        });
      } else if (phase === 'applying') {
        importProgressState.applyStage = String(progress.stage || 'writing');
      }
      renderProgress();
      debug({
        phase: phase === 'formula' ? 'import-formula-progress' : 'import-client-progress',
        stage: phase === 'formula'
          ? importProgressState.formulaStage
          : importProgressState.applyStage,
        index: importProgressState.formulaIndex,
        total: importProgressState.totalFormulas,
        name: importProgressState.currentFormula
      });
    }

    function renderImportProgress(seconds) {
      const state = importProgressState || {};
      const total = Math.max(0, Number(state.totalFiles || 0));
      const completed = Math.min(total || Number.MAX_SAFE_INTEGER,
        Math.max(0, Number(state.completedFiles || 0)));
      let message = total > 0
        ? ('导入进度：已完成 ' + completed + '/' + total + ' 个文件')
        : (state.phase === 'formula' ? '导入进度：文件阶段已完成' : '导入进度：正在准备待导入文件');
      message += '，已解析 ' + Math.max(0, Number(state.signalCount || 0)) + ' 个信号';
      if (Number(state.failedFiles || 0) > 0) {
        message += '，失败 ' + Number(state.failedFiles) + ' 个文件';
      }
      if (state.phase === 'formula') {
        const formulaIndex = Math.max(0, Number(state.formulaIndex || 0));
        const totalFormulas = Math.max(0, Number(state.totalFormulas || 0));
        const action = state.formulaStage === 'preparing'
          ? '正在准备公式输入'
          : (state.formulaStage === 'packaging' ? '正在生成波形数据' : '正在计算公式');
        message += '，' + action;
        if (totalFormulas > 0) message += ' ' + formulaIndex + '/' + totalFormulas;
        if (state.currentFormula) message += '：' + state.currentFormula;
      } else if (state.phase === 'applying') {
        const applyMessages = {
          writing: '正在写入当前波形图',
          reconciling: '正在整理示波器数据',
          saving: '正在保存 SQLite 波形库',
          notifying: '正在同步已打开的波形窗口',
          finalizing: '正在完成导入'
        };
        message += '，' + (applyMessages[state.applyStage] || '正在写入并保存当前波形图');
      }
      message += '，已等待 ' + seconds + ' 秒';
      setFooterProgress(message, false);
    }

    function renderProgress() {
      if (!progressStartedAt || !progressMessage) return;
      const seconds = Math.max(0, Math.floor((progressNow() - progressStartedAt) / 1000));
      if (importProgressState) {
        renderImportProgress(seconds);
        return;
      }
      const message = progressMessage
        + (seconds ? '（已等待 ' + seconds + ' 秒，程序仍在处理）' : '');
      if (busyAction === 'import') setFooterProgress(message, false);
      else setHint(message, false);
    }

    function stopImportProgressPolling() {
      importProgressPollStopped = true;
      importProgressPollGeneration += 1;
      window.clearTimeout(importProgressPollTimer);
      importProgressPollTimer = 0;
    }

    function startImportProgressPolling(progressToken, totalFiles) {
      stopImportProgressPolling();
      const pollGeneration = importProgressPollGeneration;
      importProgressPollStopped = false;
      importProgressPollErrorLogged = false;
      importProgressState = {
        phase: 'preparing',
        totalFiles: Math.max(0, Number(totalFiles || 0)),
        completedFiles: 0,
        successfulFiles: 0,
        failedFiles: 0,
        signalCount: 0,
        done: false
      };
      renderProgress();

      const poll = async () => {
        const isCurrentPoll = () => !importProgressPollStopped
          && pollGeneration === importProgressPollGeneration;
        if (!isCurrentPoll()) return;
        try {
          const payload = await post('import-progress', { progressToken });
          if (!isCurrentPoll()) {
            debug({ phase: 'import-progress-stale-response-ignored', progressToken });
            return;
          }
          importProgressPollErrorLogged = false;
          applyImportProgress(payload.progress);
          if (payload.progress && payload.progress.done) return;
        } catch (error) {
          if (!importProgressPollErrorLogged) {
            importProgressPollErrorLogged = true;
            debug({
              phase: 'import-progress-unavailable',
              message: error.message || String(error)
            });
          }
        }
        if (isCurrentPoll()) {
          importProgressPollTimer = window.setTimeout(poll, 400);
        }
      };
      importProgressPollTimer = window.setTimeout(poll, 120);
    }

    function startProgress(message) {
      stopImportProgressPolling();
      importProgressState = null;
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
      stopImportProgressPolling();
      clearInterval(progressTimer);
      progressTimer = 0;
      progressStartedAt = 0;
      progressMessage = '';
      importProgressState = null;
      setFooterProgress('', false);
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

    function setActivePresetNavigation(index) {
      activePresetNavigationIndex = Number.isInteger(index) ? index : -1;
      if (!presetNavigation) return;
      presetNavigation.querySelectorAll('.wave-collection-preset-nav-item').forEach((button) => {
        const active = Number(button.dataset.pathIndex) === activePresetNavigationIndex;
        button.classList.toggle('is-active', active);
        if (active) button.setAttribute('aria-current', 'true');
        else button.removeAttribute('aria-current');
      });
    }

    function clearPresetNavigationHighlight() {
      window.clearTimeout(presetNavigationHighlightTimer);
      presetNavigationHighlightTimer = 0;
      if (presetCodeEditor && presetNavigationHighlightLine !== null) {
        presetCodeEditor.removeLineClass(
          presetNavigationHighlightLine, 'background', 'wave-collection-nav-target-line');
      }
      presetNavigationHighlightLine = null;
    }

    function jumpToPresetPath(index) {
      const range = presetNavigationRanges[index];
      if (!range) {
        setHint('当前 JSON 中没有找到该规则位置', true);
        return;
      }
      clearPresetNavigationHighlight();
      setActivePresetNavigation(index);
      if (presetCodeEditor) {
        const position = presetCodeEditor.posFromIndex(range.start);
        presetCodeEditor.operation(() => {
          presetCodeEditor.setCursor(position);
          presetCodeEditor.scrollIntoView({ from: position, to: position }, 48);
          presetNavigationHighlightLine = presetCodeEditor.addLineClass(
            position.line, 'background', 'wave-collection-nav-target-line');
        });
        presetCodeEditor.focus();
        presetNavigationHighlightTimer = window.setTimeout(
          clearPresetNavigationHighlight, 1100);
      } else {
        presetEditor.focus();
        presetEditor.setSelectionRange(range.start, range.start);
        const lineHeight = Number.parseFloat(
          window.getComputedStyle(presetEditor).lineHeight) || 18;
        presetEditor.scrollTop = Math.max(0, (range.line - 3) * lineHeight);
      }
      debug({ phase: 'preset-navigation-jump', index, line: range.line });
    }

    function searchEntryStatus(entry) {
      if (!entry || typeof entry !== 'object') return null;
      const matches = Array.isArray(entry.matches) ? entry.matches : [];
      if (entry.status === 'formula-ready') {
        return { state: 'matched', symbol: '✓', label: '公式有效，可以导入' };
      }
      if (entry.status === 'formula-error') {
        return {
          state: 'duplicate',
          symbol: '×',
          label: entry.message || '公式有误，本项将跳过'
        };
      }
      if (entry.status === 'multi-wave-ready') {
        return { state: 'matched', symbol: '✓', label: '多波形配置有效，可以导入' };
      }
      if (entry.status === 'multi-wave-error') {
        return {
          state: 'duplicate',
          symbol: '×',
          label: entry.message || '多波形配置有误，本项将跳过'
        };
      }
      if (entry.importError) {
        return {
          state: 'duplicate',
          symbol: '×',
          label: String(entry.importError)
        };
      }
      if (entry.status === 'duplicate-name' || entry.status === 'config-error') {
        return {
          state: 'duplicate',
          symbol: '×',
          label: entry.message
            || (entry.status === 'duplicate-name' ? 'name 重复' : '配置错误')
        };
      }
      if (matches.length === 1) {
        return { state: 'matched', symbol: '✓', label: '搜索到 1 个文件' };
      }
      if (matches.length > 1) {
        return {
          state: 'multiple',
          symbol: '!',
          label: '搜索到 ' + matches.length + ' 个文件，默认取第一个'
        };
      }
      return {
        state: 'missing',
        symbol: '!',
        label: entry.message || '未搜索到文件'
      };
    }

    function searchEntriesByIndex(payload) {
      const entries = Array.isArray(payload && payload.entries) ? payload.entries : [];
      const indexed = new Map();
      entries.forEach((entry, fallbackIndex) => {
        const parsedIndex = Number(entry && entry.index);
        const entryIndex = Number.isInteger(parsedIndex) ? parsedIndex : fallbackIndex;
        indexed.set(entryIndex, entry);
      });
      formulaDiagnostics.forEach((diagnostic, entryIndex) => {
        const existing = indexed.get(entryIndex) || {};
        indexed.set(entryIndex, Object.assign({}, existing, {
          index: entryIndex,
          name: diagnostic.name,
          importMode: 'formula',
          formula: diagnostic.formula,
          outputNames: diagnostic.name ? [diagnostic.name] : [],
          matches: [],
          status: diagnostic.valid ? 'formula-ready' : 'formula-error',
          message: diagnostic.error || ''
        }));
      });
      multiWaveDiagnostics.forEach((diagnostic, entryIndex) => {
        const existing = indexed.get(entryIndex) || {};
        indexed.set(entryIndex, Object.assign({}, existing, {
          index: entryIndex,
          name: diagnostic.name,
          importMode: 'multi-wave',
          multiWave: diagnostic.sources,
          outputNames: diagnostic.name ? [diagnostic.name] : [],
          matches: [],
          status: diagnostic.valid ? 'multi-wave-ready' : 'multi-wave-error',
          message: diagnostic.error || ''
        }));
      });
      return indexed;
    }

    function renderPresetNavigationSearchStates(payload) {
      if (!presetNavigation) return;
      const entries = searchEntriesByIndex(payload);
      presetNavigation.querySelectorAll('.wave-collection-preset-nav-item').forEach((button) => {
        const previous = button.querySelector('.wave-collection-preset-nav-status');
        if (previous) previous.remove();
        const baseAriaLabel = button.dataset.baseAriaLabel || button.getAttribute('aria-label') || '';
        const baseTitle = button.dataset.baseTitle || button.title || '';
        const entry = entries.get(Number(button.dataset.pathIndex));
        const statusInfo = searchEntryStatus(entry);
        button.setAttribute('aria-label', statusInfo
          ? (baseAriaLabel + '，' + statusInfo.label)
          : baseAriaLabel);
        button.title = statusInfo ? (baseTitle + ' · ' + statusInfo.label) : baseTitle;
        if (!statusInfo) return;
        const statusIcon = document.createElement('span');
        statusIcon.className = 'wave-collection-preset-nav-status is-' + statusInfo.state;
        statusIcon.textContent = statusInfo.symbol;
        statusIcon.title = statusInfo.label;
        statusIcon.setAttribute('aria-hidden', 'true');
        button.appendChild(statusIcon);
      });
    }

    function renderPresetNavigation(preset, text) {
      if (!presetNavigation) return;
      const paths = preset && Array.isArray(preset.paths) ? preset.paths : [];
      presetNavigationRanges = preset ? findPresetPathObjectRanges(String(text || '')) : [];
      presetNavigation.innerHTML = '';
      if (!paths.length) {
        const empty = document.createElement('div');
        empty.className = 'wave-collection-preset-nav-empty';
        empty.textContent = preset ? '没有 paths 规则' : 'JSON 有误，导航已暂停';
        presetNavigation.appendChild(empty);
        activePresetNavigationIndex = -1;
        return;
      }
      const fragment = document.createDocumentFragment();
      paths.forEach((entry, index) => {
        const name = String(entry && entry.usrGen && entry.usrGen.name || '').trim();
        const label = name || ('规则 ' + (index + 1));
        const range = presetNavigationRanges[index];
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'wave-collection-preset-nav-item';
        button.dataset.pathIndex = String(index);
        button.dataset.baseAriaLabel = (index + 1) + '. ' + label;
        button.setAttribute('aria-label', button.dataset.baseAriaLabel);
        button.dataset.baseTitle = label + ' · paths[' + index + ']'
          + (range ? (' · 第 ' + range.line + ' 行') : '');
        button.title = button.dataset.baseTitle;
        const number = document.createElement('span');
        number.className = 'wave-collection-preset-nav-index';
        number.textContent = String(index + 1);
        const textLabel = document.createElement('span');
        textLabel.className = 'wave-collection-preset-nav-label';
        textLabel.textContent = label;
        button.appendChild(number);
        button.appendChild(textLabel);
        button.addEventListener('click', () => jumpToPresetPath(index));
        fragment.appendChild(button);
      });
      presetNavigation.appendChild(fragment);
      renderPresetNavigationSearchStates(searchResult);
      if (activePresetNavigationIndex >= paths.length) activePresetNavigationIndex = -1;
      setActivePresetNavigation(activePresetNavigationIndex);
    }

    function syncPresetNavigationFromCursor() {
      if (!presetCodeEditor || !presetNavigationRanges.length) return;
      const cursorIndex = presetCodeEditor.indexFromPos(presetCodeEditor.getCursor());
      const pathIndex = presetNavigationRanges.findIndex((range) => (
        cursorIndex >= range.start && cursorIndex <= range.end
      ));
      if (pathIndex !== activePresetNavigationIndex) {
        setActivePresetNavigation(pathIndex);
      }
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
      renderPresetNavigationSearchStates(null);
    }

    function renderSearchMarkers(payload) {
      clearSearchMarkers();
      renderPresetNavigationSearchStates(payload);
      if (!presetCodeEditor) return;
      const lines = findPresetPathObjectLines(getPresetEditorValue());
      const entries = Array.from(searchEntriesByIndex(payload).values());
      const markersByLine = new Map();
      entries.forEach((entry, fallbackIndex) => {
        const entryIndex = Number.isInteger(Number(entry.index))
          ? Number(entry.index)
          : fallbackIndex;
        const lineNumber = lines[entryIndex];
        if (!lineNumber) return;
        const statusInfo = searchEntryStatus(entry);
        if (!statusInfo) return;
        if (!markersByLine.has(lineNumber)) markersByLine.set(lineNumber, []);
        markersByLine.get(lineNumber).push(statusInfo);
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

    function setPresetEditorValue(value, options) {
      const text = String(value == null ? '' : value);
      const keepHistory = !!(options && options.keepHistory);
      clearSearchMarkers();
      clearJsonErrorMarker();
      presetEditor.value = text;
      if (!presetCodeEditor || presetCodeEditor.getValue() === text) return;
      syncingPresetCodeEditor = true;
      try {
        presetCodeEditor.setValue(text);
        if (!keepHistory) presetCodeEditor.clearHistory();
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
          presetSearchPath: !value.presetSearchPath
            || /^import[\\/]SchemeCollection[\\/]?$/.test(value.presetSearchPath)
            ? DEFAULT_PRESET_SEARCH_PATH
            : String(value.presetSearchPath),
          presetPath: String(value.presetPath || ''),
          originalPresetPath: String(value.originalPresetPath || ''),
          discoveredPresetRelativePath: String(value.discoveredPresetRelativePath || ''),
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
        presetSearchPath: String(presetSearchPathInput.value || '').trim(),
        presetPath: String(presetPathInput.value || '').trim(),
        originalPresetPath: String(originalPresetPath || '').trim(),
        discoveredPresetRelativePath: selectedDiscoveredPreset
          ? selectedDiscoveredPreset.relativePath
          : '',
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
      presetSearchPathInput.value = state.presetSearchPath || DEFAULT_PRESET_SEARCH_PATH;
      presetPathInput.value = state.presetPath;
      originalPresetPath = state.originalPresetPath;
      selectedDiscoveredPreset = state.discoveredPresetRelativePath
        ? {
          searchPath: presetSearchPathInput.value,
          relativePath: state.discoveredPresetRelativePath
        }
        : null;
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
      presetCodeEditor.on('cursorActivity', syncPresetNavigationFromCursor);
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

    async function post(action, payload, options) {
      const response = await fetch('/api/import-wave-collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ action }, payload || {})),
        signal: options && options.signal ? options.signal : undefined
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

    function formatPresetSize(bytes) {
      const size = Math.max(0, Number(bytes || 0));
      if (size < 1024) return size + ' B';
      return Math.max(1, Math.round(size / 1024)) + ' KB';
    }

    function updateDiscoveredPresetSelection() {
      presetDiscoveryHost.querySelectorAll('[data-preset-relative-path]').forEach((button) => {
        const selected = !!selectedDiscoveredPreset
          && button.dataset.presetRelativePath === selectedDiscoveredPreset.relativePath;
        button.classList.toggle('is-selected', selected);
        button.setAttribute('aria-pressed', String(selected));
      });
    }

    function clearPresetDiscovery() {
      discoveredPresets = [];
      presetDiscoveryHost.innerHTML = '';
      presetDiscoveryHost.hidden = true;
    }

    function renderPresetDiscovery(payload) {
      discoveredPresets = Array.isArray(payload && payload.entries) ? payload.entries : [];
      presetDiscoveryHost.innerHTML = '';
      presetDiscoveryHost.hidden = false;
      if (!discoveredPresets.length) {
        const empty = document.createElement('div');
        empty.className = 'wave-collection-preset-discovery-empty';
        empty.textContent = '没有找到可用的批量导入预设';
        presetDiscoveryHost.appendChild(empty);
        return;
      }
      discoveredPresets.forEach((entry) => {
        const relativePath = String(entry.relativePath || '');
        if (!relativePath) return;
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'wave-collection-preset-option';
        option.dataset.presetRelativePath = relativePath;
        option.setAttribute('aria-pressed', 'false');
        option.setAttribute('aria-label', '载入预设 ' + relativePath);
        const path = document.createElement('code');
        path.textContent = relativePath;
        const meta = document.createElement('small');
        meta.textContent = formatPresetSize(entry.size);
        option.append(path, meta);
        option.addEventListener('click', () => {
          debug({ phase: 'preset-discovered-option-click', relativePath, busy });
          void loadDiscoveredPreset(entry);
        });
        presetDiscoveryHost.appendChild(option);
      });
      updateDiscoveredPresetSelection();
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
      singlePreviewStates.clear();
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
        empty.textContent = '预设模板中没有变量';
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

    function normalizeColumnRules(value, renames, fieldPath) {
      if (value === undefined) return [];
      if (!Array.isArray(value)) {
        throw validationError(fieldPath + '.columns 必须是列表', fieldPath + '.columns');
      }
      const renameMap = renames && typeof renames === 'object' && !Array.isArray(renames)
        ? renames
        : {};
      const seen = new Set();
      return value.map((rawColumn, index) => {
        const path = fieldPath + '.columns[' + index + ']';
        let source = '';
        let enabled = true;
        let name = '';
        let filter = '';
        if (typeof rawColumn === 'string') {
          source = rawColumn.trim();
          name = typeof renameMap[source] === 'string' ? renameMap[source].trim() : source;
        } else if (rawColumn && typeof rawColumn === 'object' && !Array.isArray(rawColumn)) {
          source = typeof rawColumn.source === 'string' ? rawColumn.source.trim() : '';
          if (rawColumn.enabled !== undefined && typeof rawColumn.enabled !== 'boolean') {
            throw validationError(path + '.enabled 必须是布尔值', path + '.enabled');
          }
          enabled = rawColumn.enabled !== false;
          if (rawColumn.name !== undefined && typeof rawColumn.name !== 'string') {
            throw validationError(path + '.name 必须是字符串', path + '.name');
          }
          name = typeof rawColumn.name === 'string' ? rawColumn.name.trim() : source;
          if (rawColumn.filter !== undefined && typeof rawColumn.filter !== 'string') {
            throw validationError(path + '.filter 必须是字符串', path + '.filter');
          }
          filter = typeof rawColumn.filter === 'string' ? rawColumn.filter.trim() : '';
        } else {
          throw validationError(path + ' 必须是字符串或字典', path);
        }
        if (!source) throw validationError(path + '.source 不能为空', path + '.source');
        if (seen.has(source)) {
          throw validationError(fieldPath + '.columns 中 source 不能重复', path + '.source');
        }
        seen.add(source);
        const filterError = columnFilterError(filter);
        if (filterError) {
          throw validationError(path + '.filter：' + filterError, path + '.filter');
        }
        const normalized = { source, enabled, name: name || source };
        if (filter) normalized.filter = filter;
        return normalized;
      });
    }

    function normalizeRuleConfig(value, fieldPath) {
      if (value === undefined || value === null) return {};
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw validationError(fieldPath + ' 必须是字典', fieldPath);
      }
      const config = {};
      ['folder', 'grepKeys', 'name', 'importMode', 'indexColumn', 'delimiter', 'parser', 'schemaHash']
        .forEach((key) => {
          if (value[key] === undefined) return;
          if (typeof value[key] !== 'string') {
            throw validationError(fieldPath + '.' + key + ' 必须是字符串', fieldPath + '.' + key);
          }
          const text = value[key].trim();
          if (text) config[key] = text;
        });
      if (config.importMode && config.importMode !== 'single' && config.importMode !== 'table') {
        throw validationError(fieldPath + '.importMode 必须是 single 或 table', fieldPath + '.importMode');
      }
      if (value.headerRow !== undefined) {
        if (!Number.isInteger(value.headerRow) || value.headerRow < 0) {
          throw validationError(fieldPath + '.headerRow 必须是非负整数', fieldPath + '.headerRow');
        }
        if (value.headerRow) config.headerRow = value.headerRow;
      }
      if (value.hasSeq !== undefined) {
        if (typeof value.hasSeq !== 'boolean') {
          throw validationError(fieldPath + '.hasSeq 必须是布尔值', fieldPath + '.hasSeq');
        }
        config.hasSeq = value.hasSeq;
      }
      if (value.tbl !== undefined) {
        if (!value.tbl || typeof value.tbl !== 'object' || Array.isArray(value.tbl)) {
          throw validationError(fieldPath + '.tbl 必须是字典', fieldPath + '.tbl');
        }
        const table = Object.create(null);
        Object.keys(value.tbl).forEach((rawValue) => {
          if (typeof value.tbl[rawValue] !== 'string') {
            throw validationError(
              fieldPath + '.tbl[' + JSON.stringify(rawValue) + '] 必须是字符串',
              fieldPath + '.tbl'
            );
          }
          table[rawValue] = value.tbl[rawValue];
        });
        if (Object.keys(table).length) config.tbl = table;
      }
      const columns = normalizeColumnRules(value.columns, value.renames, fieldPath);
      if (columns.length) config.columns = columns;
      return config;
    }

    function normalizeFormulaConfig(value, fieldPath) {
      const errors = [];
      let source = value;
      if (typeof source === 'string') source = { cycle0: source };
      if (!source || typeof source !== 'object' || Array.isArray(source)) {
        errors.push(fieldPath + ' 必须是字典');
        source = {};
      }
      const readText = (keys, label) => {
        const key = keys.find((candidate) => source[candidate] !== undefined);
        if (!key || source[key] == null) return '';
        if (typeof source[key] !== 'string') {
          errors.push(fieldPath + '.' + label + ' 必须是字符串');
        }
        return String(source[key]);
      };
      const cycle0 = readText(['cycle0', '0 cycle', 'at0'], 'cycle0');
      const cycle05 = readText(['cycle05', 'cycle0_5', '0.5 cycle', 'at05'], 'cycle05');
      const normalized = {};
      if (cycle0.trim()) normalized.cycle0 = cycle0;
      if (cycle05.trim()) normalized.cycle05 = cycle05;
      Object.defineProperty(normalized, '__vwdStructureErrors', {
        value: errors,
        enumerable: false
      });
      return normalized;
    }

    function normalizeMultiWaveConfig(value, fieldPath) {
      if (!Array.isArray(value)) {
        throw validationError(fieldPath + ' 必须是信号名列表', fieldPath);
      }
      const seen = new Set();
      return value.map((name, index) => {
        if (typeof name !== 'string' || !name.trim()) {
          throw validationError(
            fieldPath + '[' + index + '] 必须是非空信号名',
            fieldPath + '[' + index + ']'
          );
        }
        return name.trim();
      }).filter((name) => {
        if (seen.has(name)) return false;
        seen.add(name);
        return true;
      });
    }

    function normalizePresetPath(entry, index) {
      const path = 'paths[' + index + ']';
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw validationError(path + ' 必须是字典', path);
      }
      let usrGen;
      let autoGen;
      let rawUsrGen = entry.usrGen;
      if (entry.usrGen !== undefined || entry.autoGen !== undefined) {
        if (entry.tbl !== undefined && (
          rawUsrGen === undefined || rawUsrGen === null ||
          (typeof rawUsrGen === 'object' && !Array.isArray(rawUsrGen))
        )) {
          rawUsrGen = Object.assign({}, rawUsrGen || {});
          if (rawUsrGen.tbl === undefined) rawUsrGen.tbl = entry.tbl;
        }
        usrGen = normalizeRuleConfig(rawUsrGen, path + '.usrGen');
        autoGen = normalizeRuleConfig(entry.autoGen, path + '.autoGen');
      } else {
        usrGen = normalizeRuleConfig({
          folder: entry.folder,
          grepKeys: entry.grepKeys,
          name: entry.name,
          tbl: entry.tbl
        }, path + '.usrGen');
        autoGen = normalizeRuleConfig({
          importMode: 'single',
          hasSeq: entry.hasSeq
        }, path + '.autoGen');
      }
      const hasUsrFormula = !!rawUsrGen
        && typeof rawUsrGen === 'object'
        && !Array.isArray(rawUsrGen)
        && Object.prototype.hasOwnProperty.call(rawUsrGen, 'formula');
      const formulaValue = hasUsrFormula ? rawUsrGen.formula : entry.formula;
      const formula = formulaValue === undefined
        ? null
        : normalizeFormulaConfig(
          formulaValue,
          hasUsrFormula ? path + '.usrGen.formula' : path + '.formula'
        );
      const hasUsrMultiWave = !!rawUsrGen
        && typeof rawUsrGen === 'object'
        && !Array.isArray(rawUsrGen)
        && Object.prototype.hasOwnProperty.call(rawUsrGen, 'multiWave');
      const multiWaveValue = hasUsrMultiWave ? rawUsrGen.multiWave : entry.multiWave;
      const multiWave = multiWaveValue === undefined
        ? null
        : normalizeMultiWaveConfig(
          multiWaveValue,
          hasUsrMultiWave ? path + '.usrGen.multiWave' : path + '.multiWave'
        );
      if (formula && multiWave) {
        throw validationError(
          path + ' 不能同时配置 formula 和 multiWave',
          path + '.usrGen'
        );
      }
      if (formula) {
        if (!usrGen.name) {
          throw validationError(path + '.usrGen.name 必须是非空信号名', path + '.usrGen.name');
        }
        return { usrGen: { name: usrGen.name, formula }, autoGen };
      }
      if (multiWave) {
        if (!usrGen.name) {
          throw validationError(path + '.usrGen.name 必须是非空信号名', path + '.usrGen.name');
        }
        return { usrGen: { name: usrGen.name, multiWave }, autoGen };
      }
      if (!usrGen.folder) usrGen.folder = '.';
      if (!usrGen.grepKeys) {
        throw validationError(
          path + '.usrGen.grepKeys 必须是非空正则字符串',
          path + '.usrGen.grepKeys'
        );
      }
      return { usrGen, autoGen };
    }

    function presetPathFormula(entry) {
      return entry && entry.usrGen && entry.usrGen.formula
        ? entry.usrGen.formula
        : null;
    }

    function presetPathMultiWave(entry) {
      return entry && entry.usrGen && Array.isArray(entry.usrGen.multiWave)
        ? entry.usrGen.multiWave
        : null;
    }

    function presetForCollectionService(preset) {
      const copy = JSON.parse(JSON.stringify(preset || EMPTY_PRESET));
      copy.paths = (Array.isArray(copy.paths) ? copy.paths : []).map((entry, index) => {
        if (!presetPathFormula(entry) && !presetPathMultiWave(entry)) return entry;
        const name = String(entry && entry.usrGen && entry.usrGen.name || '').trim()
          || ('formula_' + (index + 1));
        return {
          usrGen: {
            folder: '.',
            grepKeys: '(?!)',
            name
          },
          autoGen: {
            importMode: 'single',
            hasSeq: false
          }
        };
      });
      return copy;
    }

    function mergeGeneratedPresetWithFormulas(generatedPreset, sourcePreset) {
      const generated = JSON.parse(JSON.stringify(generatedPreset || EMPTY_PRESET));
      const source = sourcePreset && typeof sourcePreset === 'object'
        ? sourcePreset
        : null;
      if (!source || !Array.isArray(source.paths)) return generated;
      generated.paths = Array.isArray(generated.paths) ? generated.paths : [];
      source.paths.forEach((entry, index) => {
        if (!presetPathFormula(entry) && !presetPathMultiWave(entry)) return;
        generated.paths[index] = JSON.parse(JSON.stringify(entry));
      });
      return generated;
    }

    function validatePresetShape(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw validationError('预设顶层必须是 JSON 对象', '');
      }
      if (value.vars !== undefined && !Array.isArray(value.vars)) {
        throw validationError('vars 必须是列表；也可以省略并由预设模板自动提取', 'vars');
      }
      if (!Array.isArray(value.paths)) {
        throw validationError('paths 必须是列表', 'paths');
      }
      const declaredNames = [];
      const declaredNameSet = new Set();
      (value.vars || []).forEach((name, index) => {
        if (typeof name !== 'string' || !name.trim()) {
          throw validationError('vars[' + index + '] 必须是非空字符串', 'vars[' + index + ']');
        }
        const normalizedName = name.trim();
        if (!VARIABLE_NAME_PATTERN.test(normalizedName)) {
          throw validationError('vars[' + index + '] 不是有效变量名', 'vars[' + index + ']');
        }
        if (declaredNameSet.has(normalizedName)) {
          throw validationError('vars 中变量名不能重复', 'vars[' + index + ']');
        }
        declaredNameSet.add(normalizedName);
        declaredNames.push(normalizedName);
      });
      const paths = value.paths.map((entry, index) => normalizePresetPath(entry, index));
      const referencedNames = [];
      const referencedNameSet = new Set();
      paths.forEach((entry) => {
        if (presetPathFormula(entry) || presetPathMultiWave(entry)) return;
        ['folder', 'grepKeys', 'name'].forEach((field) => {
          extractTemplateVariables(entry.usrGen[field]).forEach((name) => {
            if (referencedNameSet.has(name)) return;
            referencedNameSet.add(name);
            referencedNames.push(name);
          });
        });
      });
      const vars = [];
      const addedNames = new Set();
      declaredNames.forEach((name) => {
        if (!referencedNameSet.has(name)) return;
        addedNames.add(name);
        vars.push(name);
      });
      referencedNames.forEach((name) => {
        if (addedNames.has(name)) return;
        addedNames.add(name);
        vars.push(name);
      });
      return { vars, paths };
    }

    function synchronizeLoadedPresetVariables(preset) {
      if (!preset || !Array.isArray(preset.vars)) return preset;
      let raw;
      try {
        raw = JSON.parse(getPresetEditorValue());
      } catch (_error) {
        return preset;
      }
      const current = Array.isArray(raw.vars) ? raw.vars : [];
      if (JSON.stringify(current) === JSON.stringify(preset.vars)) return preset;
      raw.vars = preset.vars.slice();
      setPresetEditorValue(JSON.stringify(raw, null, 2));
      debug({
        phase: 'preset-vars-pruned',
        previousCount: current.length,
        nextCount: preset.vars.length,
        removed: current.filter((name) => !preset.vars.includes(name))
      });
      return parseEditor(false) || preset;
    }

    function collectionEntryOutputNames(entry) {
      if (!entry || entry.importMode === 'formula') return [];
      const existing = (Array.isArray(entry.outputNames) ? entry.outputNames : [])
        .map((name) => String(name || '').trim()).filter(Boolean);
      if (entry.importMode === 'table') {
        const complexSources = new Set(
          (Array.isArray(entry.complexSources) ? entry.complexSources : [])
            .map((source) => String(source || '').trim()).filter(Boolean)
        );
        const configured = (entry.columns || [])
          .filter((column) => column && column.enabled !== false
            && String(column.source || '') !== String(entry.indexColumn || ''))
          .reduce((names, column) => {
            const source = String(column.source || '').trim();
            const name = String(column.name || source).trim();
            if (!name) return names;
            if (complexSources.has(source)) names.push(name + '_I', name + '_Q');
            else names.push(name);
            return names;
          }, []);
        return configured.length ? configured : existing;
      }
      const name = String(entry.name || '').trim();
      if (!name) return existing;
      return entry.complexDetected ? [name + '_I', name + '_Q'] : [name];
    }

    function formulaSignalNames(preset, payload) {
      const names = new Set();
      if (typeof settings.getFormulaSignalNames === 'function') {
        try {
          (settings.getFormulaSignalNames() || []).forEach((name) => {
            const normalized = String(name || '').trim();
            if (normalized) names.add(normalized);
          });
        } catch (error) {
          debug({ phase: 'formula-signal-names-error', message: error.message || String(error) });
        }
      }
      const entries = Array.isArray(payload && payload.entries) ? payload.entries : [];
      entries.forEach((entry) => {
        if (entry && (entry.importMode === 'formula' || entry.importMode === 'multi-wave')) return;
        collectionEntryOutputNames(entry).forEach((name) => {
          const normalized = String(name || '').trim();
          if (normalized) names.add(normalized);
        });
      });
      (preset && Array.isArray(preset.paths) ? preset.paths : []).forEach((entry) => {
        if (!entry || presetPathFormula(entry) || presetPathMultiWave(entry)) return;
        const config = entry.usrGen || {};
        const name = String(config.name || '').trim();
        if (name) names.add(name);
        const columns = Array.isArray(config.columns) && config.columns.length
          ? config.columns
          : (entry.autoGen && Array.isArray(entry.autoGen.columns) ? entry.autoGen.columns : []);
        columns.forEach((column) => {
          if (column && column.enabled === false) return;
          const columnName = String(column && (column.name || column.source) || '').trim();
          if (columnName) names.add(columnName);
        });
      });
      const result = Array.from(names);
      debug({ phase: 'formula-signal-names', count: result.length, names: result });
      return result;
    }

    function refreshFormulaDiagnostics(preset, payload) {
      formulaDiagnostics = new Map();
      multiWaveDiagnostics = new Map();
      const formulaEngine = window.VisualWaveDromFormula;
      const definitions = [];
      (preset && Array.isArray(preset.paths) ? preset.paths : []).forEach((entry, index) => {
        const formula = presetPathFormula(entry);
        if (!entry || !formula) return;
        definitions.push({
          id: String(index),
          name: String(entry.usrGen && entry.usrGen.name || '').trim(),
          formula
        });
      });
      if (!definitions.length) return formulaDiagnostics;
      if (!formulaEngine) {
        definitions.forEach((definition) => {
          formulaDiagnostics.set(Number(definition.id), {
            index: Number(definition.id),
            name: definition.name,
            formula: definition.formula,
            valid: false,
            error: '公式模块未加载',
            references: [],
            dependencies: [],
            libraries: []
          });
        });
        return formulaDiagnostics;
      }
      const analysis = formulaEngine.analyzeDefinitions(
        definitions,
        formulaSignalNames(preset, payload)
      );
      analysis.items.forEach((item) => {
        const index = Number(item.id);
        const entry = preset.paths[index];
        const formula = presetPathFormula(entry);
        const structureErrors = formula
          && Array.isArray(formula.__vwdStructureErrors)
          ? formula.__vwdStructureErrors
          : [];
        const errors = Array.from(new Set(structureErrors.concat(item.errors || [])));
        formulaDiagnostics.set(index, Object.assign({}, item, {
          index,
          valid: errors.length === 0,
          errors,
          error: errors.join('；')
        }));
      });
      debug({
        phase: 'formula-diagnostics',
        total: formulaDiagnostics.size,
        valid: Array.from(formulaDiagnostics.values()).filter((item) => item.valid).length,
        invalid: Array.from(formulaDiagnostics.values()).filter((item) => !item.valid).length
      });
      return formulaDiagnostics;
    }

    function refreshMultiWaveDiagnostics(preset, payload) {
      multiWaveDiagnostics = new Map();
      const knownNames = new Set(formulaSignalNames(preset, payload));
      formulaDiagnostics.forEach((diagnostic) => {
        if (diagnostic.valid && diagnostic.name) knownNames.add(String(diagnostic.name));
      });
      (preset && Array.isArray(preset.paths) ? preset.paths : []).forEach((entry, index) => {
        const sources = presetPathMultiWave(entry);
        if (!entry || !sources) return;
        const name = String(entry.usrGen && entry.usrGen.name || '').trim();
        const missing = sources.filter((sourceName) => !knownNames.has(sourceName));
        const errors = [];
        if (!sources.length) errors.push('multiWave 至少需要一个源信号');
        if (sources.includes(name)) errors.push('multiWave 不能引用自身');
        if (missing.length) errors.push('找不到源信号：' + missing.join('、'));
        multiWaveDiagnostics.set(index, {
          index,
          name,
          sources: sources.slice(),
          valid: errors.length === 0,
          error: errors.join('；')
        });
      });
      return multiWaveDiagnostics;
    }

    function decorateFormulaSearchResult(payload, preset) {
      if (!payload || typeof payload !== 'object') return payload;
      refreshFormulaDiagnostics(preset, payload);
      refreshMultiWaveDiagnostics(preset, payload);
      const indexed = new Map();
      (Array.isArray(payload.entries) ? payload.entries : []).forEach((entry, fallbackIndex) => {
        const parsedIndex = Number(entry && entry.index);
        indexed.set(Number.isInteger(parsedIndex) ? parsedIndex : fallbackIndex, entry);
      });
      formulaDiagnostics.forEach((diagnostic, index) => {
        const existing = indexed.get(index) || {};
        indexed.set(index, Object.assign({}, existing, {
          index,
          name: diagnostic.name,
          importMode: 'formula',
          formula: diagnostic.formula,
          outputNames: diagnostic.name ? [diagnostic.name] : [],
          matches: [],
          status: diagnostic.valid ? 'formula-ready' : 'formula-error',
          message: diagnostic.error || ''
        }));
      });
      multiWaveDiagnostics.forEach((diagnostic, index) => {
        const existing = indexed.get(index) || {};
        indexed.set(index, Object.assign({}, existing, {
          index,
          name: diagnostic.name,
          importMode: 'multi-wave',
          multiWave: diagnostic.sources,
          outputNames: diagnostic.name ? [diagnostic.name] : [],
          matches: [],
          status: diagnostic.valid ? 'multi-wave-ready' : 'multi-wave-error',
          message: diagnostic.error || ''
        }));
      });
      payload.entries = Array.from(indexed.values()).sort((left, right) =>
        Number(left.index) - Number(right.index));
      payload.formulaCount = Array.from(formulaDiagnostics.values())
        .filter((item) => item.valid).length;
      payload.formulaErrorCount = formulaDiagnostics.size - payload.formulaCount;
      payload.multiWaveCount = Array.from(multiWaveDiagnostics.values())
        .filter((item) => item.valid).length;
      payload.multiWaveErrorCount = multiWaveDiagnostics.size - payload.multiWaveCount;
      return payload;
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
        refreshFormulaDiagnostics(nextPreset, searchResult);
        refreshMultiWaveDiagnostics(nextPreset, searchResult);
        presetState.textContent = '从预设模板自动识别 ' + nextPreset.vars.length + ' 个变量，'
          + nextPreset.paths.length + ' 条搜索规则';
        if (previousVariables !== nextVariables || !variablesHost.childElementCount) {
          renderVariables(nextPreset.vars);
        }
        renderPresetNavigation(nextPreset, editorText);
        clearJsonErrorMarker();
        renderSearchMarkers(searchResult);
        setHint('', false);
        updateButtons();
        return nextPreset;
      } catch (error) {
        parsedPreset = null;
        formulaDiagnostics = new Map();
        multiWaveDiagnostics = new Map();
        renderPresetNavigation(null, editorText);
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

    function adoptGeneratedPreset(value, reason, sourcePreset) {
      const merged = mergeGeneratedPresetWithFormulas(value, sourcePreset || parsedPreset);
      const normalized = validatePresetShape(merged);
      parsedPreset = normalized;
      refreshFormulaDiagnostics(normalized, searchResult);
      refreshMultiWaveDiagnostics(normalized, searchResult);
      setPresetEditorValue(JSON.stringify(normalized, null, 2), { keepHistory: true });
      presetState.textContent = '从预设模板自动识别 ' + normalized.vars.length + ' 个变量，'
        + normalized.paths.length + ' 条搜索规则；autoGen 已更新';
      if (searchResult) searchResult.preset = normalized;
      renderVariables(normalized.vars);
      renderPresetNavigation(normalized, getPresetEditorValue());
      renderSearchMarkers(searchResult);
      scheduleRememberState(reason || 'autogen-updated');
      updateButtons();
      return normalized;
    }

    function singleEntryParser(hasSeq, delimiter) {
      if (!hasSeq) return 'parse_single_column';
      const normalized = String(delimiter || '').trim().toLowerCase();
      if (normalized === 'comma' || normalized === 'csv') return 'parse_csv_index_data';
      if (normalized === 'tab' || normalized === 'tsv') return 'parse_tsv_index_data';
      return 'parse_index_data';
    }

    function firstSequenceField(line, delimiter) {
      const source = String(line == null ? '' : line);
      const trimmed = source.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
        return null;
      }
      const normalized = String(delimiter || '').trim().toLowerCase();
      if (normalized === 'comma' || normalized === 'csv') {
        let cursor = 0;
        while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
        let value = '';
        if (source[cursor] === '"') {
          cursor += 1;
          while (cursor < source.length) {
            if (source[cursor] !== '"') {
              value += source[cursor];
              cursor += 1;
              continue;
            }
            if (source[cursor + 1] === '"') {
              value += '"';
              cursor += 2;
              continue;
            }
            cursor += 1;
            break;
          }
          while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
        } else {
          const separator = source.indexOf(',', cursor);
          if (separator < 0) return { value: source.slice(cursor).trim(), hasData: false };
          value = source.slice(cursor, separator).trim();
          cursor = separator;
        }
        return { value: value.trim(), hasData: source[cursor] === ',' };
      }
      if (normalized === 'tab' || normalized === 'tsv') {
        const separator = source.indexOf('\t');
        return {
          value: (separator < 0 ? source : source.slice(0, separator)).trim(),
          hasData: separator >= 0
        };
      }
      const match = /^\s*(\S+)(?:\s+([\s\S]*))?$/.exec(source);
      return match ? { value: match[1], hasData: match[2] !== undefined } : null;
    }

    function previewDataColumns(line, delimiter) {
      const source = String(line == null ? '' : line);
      const trimmed = source.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return null;
      const normalized = String(delimiter || '').trim().toLowerCase();
      if (normalized === 'comma' || normalized === 'csv') {
        const fields = [];
        let value = '';
        let quoted = false;
        for (let index = 0; index < source.length; index += 1) {
          const character = source[index];
          if (quoted) {
            if (character === '"' && source[index + 1] === '"') {
              value += '"';
              index += 1;
            } else if (character === '"') {
              quoted = false;
            } else {
              value += character;
            }
          } else if (character === '"' && !value.trim()) {
            quoted = true;
          } else if (character === ',') {
            fields.push(value.trim());
            value = '';
          } else {
            value += character;
          }
        }
        fields.push(value.trim());
        return fields;
      }
      if (normalized === 'tab' || normalized === 'tsv') {
        return source.split('\t').map((value) => value.trim());
      }
      return trimmed.split(/\s+/);
    }

    function sequencePreviewError(lines, delimiter) {
      const candidates = (Array.isArray(lines) ? lines : [])
        .map((line, index) => {
          const parsed = firstSequenceField(line && line.text, delimiter);
          if (!parsed) return null;
          return {
            line: Math.max(1, Number(line && line.number || index + 1)),
            text: String(line && line.text != null ? line.text : ''),
            value: parsed.value,
            hasData: parsed.hasData
          };
        })
        .filter(Boolean);
      if (!candidates.length) return '文件前 64 行中没有可检查的数据';

      const validToken = (candidate) => candidate.hasData && /^\+?\d+$/.test(candidate.value);
      let start = 0;
      if (!validToken(candidates[0]) && candidates.length > 1
          && validToken(candidates[1])
          && /[A-Za-z_\u3400-\u9fff]/.test(candidates[0].text)) {
        start = 1;
      }
      let previous = -1;
      for (let index = start; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        if (!/^\+?\d+$/.test(candidate.value)) {
          return '第 ' + candidate.line + ' 行第一列不是整数序号：' + candidate.value;
        }
        if (!candidate.hasData) {
          return '第 ' + candidate.line + ' 行只有序号，没有对应的数据列';
        }
        const value = Number(candidate.value.replace(/^\+/, ''));
        if (!Number.isSafeInteger(value)) {
          return '第 ' + candidate.line + ' 行序号超出可支持范围：' + candidate.value;
        }
        if (value <= previous) {
          return '第 ' + candidate.line + ' 行序号 ' + value
            + ' 没有大于上一序号 ' + previous;
        }
        previous = value;
      }
      return '';
    }

    function unsequencedPreviewError(lines, delimiter) {
      const candidates = (Array.isArray(lines) ? lines : [])
        .map((line, index) => {
          const columns = previewDataColumns(line && line.text, delimiter);
          if (!columns) return null;
          return {
            line: Math.max(1, Number(line && line.number || index + 1)),
            text: String(line && line.text != null ? line.text : ''),
            columns
          };
        })
        .filter(Boolean);
      if (!candidates.length) return '';
      const numeric = (value) => String(value || '').trim() !== ''
        && Number.isFinite(Number(value));
      const validDataRow = (candidate) => {
        if (candidate.columns.length <= 1) return true;
        if (candidate.columns.length === 2) {
          return numeric(candidate.columns[0]) && numeric(candidate.columns[1]);
        }
        return /[ij]/i.test(candidate.columns.join(''));
      };
      let start = 0;
      if (!validDataRow(candidates[0]) && candidates.length > 1
          && validDataRow(candidates[1])
          && /[A-Za-z_\u3400-\u9fff]/.test(candidates[0].text)) {
        start = 1;
      }
      for (let index = start; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        if (validDataRow(candidate)) continue;
        if (candidate.columns.length === 2) {
          return '第 ' + candidate.line
            + ' 行有两列，但不能作为数值 I/Q 复数解析；如果第一列是序号，请勾选“第一列为序号”';
        }
        return '第 ' + candidate.line
          + ' 行包含过多数据列；如果第一列是序号，请勾选“第一列为序号”';
      }
      return '';
    }

    function presetForRawSequencePreview(preset, entryIndex) {
      const copy = JSON.parse(JSON.stringify(preset));
      const path = copy.paths && copy.paths[entryIndex];
      if (!path) return copy;
      path.usrGen = Object.assign({}, path.usrGen || {}, { hasSeq: false });
      path.autoGen = Object.assign({}, path.autoGen || {}, { hasSeq: false });
      return copy;
    }

    function revealEntryImportError(entryIndex) {
      window.requestAnimationFrame(() => {
        const row = resultsHost.querySelector('[data-entry-index="'
          + String(entryIndex) + '"]');
        if (row && typeof row.scrollIntoView === 'function') {
          row.scrollIntoView({ block: 'nearest' });
        }
      });
    }

    async function validateSingleFileSelections(preset, variables, rootPath, signal) {
      const entries = Array.isArray(searchResult && searchResult.entries)
        ? searchResult.entries
        : [];
      const targets = entries.filter((entry) => entry.importMode === 'single'
        && Array.isArray(entry.matches)
        && entry.matches.length > 0);
      entries.forEach((entry) => { delete entry.importError; });
      if (!targets.length) return true;

      debug({
        phase: 'single-parser-preflight-start',
        entryIndexes: targets.map((entry) => entry.index)
      });
      for (const entry of targets) {
        const payload = await post('single-preview', {
          rootPath,
          preset: presetForCollectionService(
            presetForRawSequencePreview(preset, entry.index)
          ),
          variables,
          searchToken: searchResult.searchToken || '',
          index: entry.index,
          startLine: 1,
          lineCount: 64,
          quick: true
        }, { signal });
        const validationError = entry.hasSeq
          ? sequencePreviewError(payload.lines, entry.delimiter)
          : unsequencedPreviewError(payload.lines, entry.delimiter);
        if (!validationError) continue;
        entry.importError = String(entry.name || '未命名信号')
          + (entry.hasSeq ? ' 的“第一列为序号”设置有误：' : '：')
          + validationError;
        debug({
          phase: 'single-parser-preflight-invalid',
          entryIndex: entry.index,
          relativePath: payload.relativePath || '',
          message: entry.importError
        });
      }
      const invalid = targets.filter((entry) => entry.importError);
      if (!invalid.length) {
        debug({ phase: 'single-parser-preflight-complete', valid: true });
        return true;
      }
      renderSearchResults(searchResult);
      setHint('导入前检查失败：' + invalid[0].importError, true);
      revealEntryImportError(invalid[0].index);
      debug({
        phase: 'single-parser-preflight-complete',
        valid: false,
        invalidCount: invalid.length
      });
      return false;
    }

    function syncEntryAutoGen(entry, reason) {
      if (!parsedPreset || !entry || !parsedPreset.paths[entry.index]) return;
      delete entry.importError;
      const path = parsedPreset.paths[entry.index];
      const importMode = entry.importMode || 'single';
      const autoGen = Object.assign({}, path.autoGen || {}, {
        importMode,
        delimiter: entry.delimiter || 'auto',
        parser: importMode === 'table'
          ? 'parse_table_data'
          : singleEntryParser(!!entry.hasSeq, entry.delimiter),
        schemaHash: entry.schemaHash || ''
      });
      if (entry.importMode === 'table') {
        autoGen.headerRow = Math.max(1, Number(entry.headerRow || 1));
        if (String(entry.indexColumn || '').trim()) {
          autoGen.indexColumn = String(entry.indexColumn).trim();
        } else {
          delete autoGen.indexColumn;
        }
        autoGen.columns = (entry.columns || []).map((column) => {
          const normalized = {
            source: String(column.source || ''),
            enabled: column.enabled !== false,
            name: String(column.name || column.source || '')
          };
          const filter = String(column.filter || '').trim();
          if (filter) normalized.filter = filter;
          return normalized;
        });
        delete autoGen.hasSeq;
      } else {
        autoGen.hasSeq = !!entry.hasSeq;
        entry.parser = autoGen.parser;
        if (path.usrGen && Object.prototype.hasOwnProperty.call(path.usrGen, 'hasSeq')) {
          path.usrGen.hasSeq = !!entry.hasSeq;
        }
        delete autoGen.headerRow;
        delete autoGen.indexColumn;
        delete autoGen.columns;
      }
      Object.keys(autoGen).forEach((key) => {
        if (autoGen[key] === '') delete autoGen[key];
      });
      path.autoGen = autoGen;
      entry.outputNames = collectionEntryOutputNames(entry);
      if (entry.status === 'duplicate-name') {
        entry.status = Array.isArray(entry.matches) && entry.matches.length > 1
          ? 'multiple'
          : 'matched';
        entry.message = '';
      }
      setPresetEditorValue(JSON.stringify(parsedPreset, null, 2), { keepHistory: true });
      renderPresetNavigation(parsedPreset, getPresetEditorValue());
      if (searchResult) {
        searchResult.preset = parsedPreset;
        decorateFormulaSearchResult(searchResult, parsedPreset);
      }
      renderSearchMarkers(searchResult);
      scheduleRememberState(reason || 'autogen-edited');
      updateButtons();
    }

    function collectionSelectionStatus() {
      const entries = Array.isArray(searchResult && searchResult.entries)
        ? searchResult.entries
        : [];
      const active = entries.filter((entry) =>
        entry.status === 'formula-ready'
          || entry.status === 'multi-wave-ready'
          || (Array.isArray(entry.matches) && entry.matches.length > 0));
      const errors = [];
      const owners = new Map();
      active.forEach((entry) => {
        if (entry.status === 'formula-ready' || entry.status === 'multi-wave-ready') return;
        if (entry.importError) {
          errors.push(String(entry.importError));
          return;
        }
        if (entry.status === 'config-error') {
          errors.push(entry.message || ('第 ' + (entry.index + 1) + ' 条规则配置有误'));
          return;
        }
        (entry.columns || []).forEach((column) => {
          const filterError = columnFilterError(column.filter);
          if (filterError) {
            errors.push('信号 ' + String(column.source || column.name || '')
              + ' 的过滤条件有误：' + filterError);
          }
        });
        const names = collectionEntryOutputNames(entry);
        if (!names.length || names.some((name) => !name)) {
          errors.push('第 ' + (entry.index + 1) + ' 条规则至少选择一个有效信号');
          return;
        }
        names.forEach((name) => {
          if (owners.has(name)) {
            errors.push('信号名重复：' + name);
          } else {
            owners.set(name, entry.index);
          }
        });
      });
      return {
        valid: active.length > 0 && errors.length === 0,
        count: active.length,
        errors
      };
    }

    function validFormulaDefinitions() {
      return Array.from(formulaDiagnostics.values())
        .filter((item) => item.valid)
        .sort((left, right) => left.index - right.index)
        .map((item) => ({
          id: String(item.index),
          name: item.name,
          formula: item.formula
        }));
    }

    function validMultiWaveDefinitions() {
      return Array.from(multiWaveDiagnostics.values())
        .filter((item) => item.valid)
        .sort((left, right) => left.index - right.index)
        .map((item) => ({
          id: String(item.index),
          name: item.name,
          multiWave: item.sources.slice()
        }));
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
      const hasPresetSearchPath = !!String(presetSearchPathInput.value || '').trim();
      const hasPresetPath = !!String(presetPathInput.value || '').trim();
      const canSearch = !!parsedPreset && hasRoot;
      rootPathInput.disabled = busy;
      presetSearchPathInput.disabled = busy;
      presetPathInput.disabled = busy;
      presetPathInput.classList.toggle('is-save-target', manualSavePathMode);
      presetEditor.disabled = busy;
      if (presetCodeEditor) {
        presetCodeEditor.setOption('readOnly', busy ? 'nocursor' : false);
        presetCodeEditor.getWrapperElement().setAttribute('aria-disabled', String(busy));
      }
      pickRootButton.disabled = busy;
      pickPresetRootButton.disabled = busy;
      scanPresetsButton.disabled = busy || !hasPresetSearchPath;
      pickPresetButton.disabled = busy;
      loadPresetButton.disabled = busy || !hasPresetPath;
      variablesHost.querySelectorAll('input').forEach((input) => {
        input.disabled = busy;
      });
      cancelButton.disabled = busy
        && (busyAction !== 'import' || importCancelRequested || !importCancellationAllowed);
      savePresetButton.disabled = busy || !parsedPreset;
      searchButton.disabled = busy || !canSearch;
      const selection = collectionSelectionStatus();
      confirmButton.disabled = busy || !selection.valid;
      resultsHost.querySelectorAll('input, button, select').forEach((control) => {
        control.disabled = busy || control.dataset.permanentDisabled === 'true';
      });
      presetDiscoveryHost.querySelectorAll('button').forEach((control) => {
        control.disabled = busy;
      });
    }

    function setBusy(nextBusy, action) {
      busy = nextBusy;
      busyAction = nextBusy ? String(action || '') : '';
      if (!nextBusy) stopProgress();
      searchButton.textContent = nextBusy && action === 'search' ? '正在搜索…' : '搜索数据';
      scanPresetsButton.textContent = nextBusy && action === 'scan-presets'
        ? '正在搜索…'
        : '搜索预设';
      confirmButton.textContent = nextBusy
        ? (action === 'import' ? '正在导入…' : (action === 'validate' ? '正在检查…' : '确定导入'))
        : '确定导入';
      cancelButton.textContent = nextBusy && action === 'import' ? '取消导入' : '取消';
      savePresetButton.textContent = nextBusy && action === 'save'
        ? '正在保存…'
        : (manualSavePathMode ? '保存到此路径' : '保存预设');
      updateButtons();
    }

    function refreshEditorsAfterPathPicker(reason) {
      const refresh = () => {
        if (presetCodeEditor) {
          presetCodeEditor.setOption('readOnly', busy ? 'nocursor' : false);
          presetCodeEditor.getWrapperElement().setAttribute('aria-disabled', String(busy));
          presetCodeEditor.refresh();
        }
        if (typeof settings.refreshEditors === 'function') {
          settings.refreshEditors(reason || 'path-picker');
        }
        debug({ phase: 'editors-refreshed', reason: reason || 'path-picker', busy });
      };
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(() => window.requestAnimationFrame(refresh));
      } else {
        window.setTimeout(refresh, 0);
      }
    }

    function focusAndSelectPath(input) {
      window.requestAnimationFrame(() => {
        if (!input || input.disabled || modal.hidden) return;
        input.focus();
        input.select();
      });
    }

    function singlePreviewState(entryIndex) {
      if (!singlePreviewStates.has(entryIndex)) {
        singlePreviewStates.set(entryIndex, {
          expanded: false,
          loaded: false,
          loading: false,
          startLine: 1,
          lineCount: 5,
          totalLines: null,
          lines: [],
          relativePath: '',
          sequenceColumnHidden: false,
          error: ''
        });
      }
      return singlePreviewStates.get(entryIndex);
    }

    function formatPreviewLineCount(value) {
      const count = Math.max(0, Number(value || 0));
      try {
        return new Intl.NumberFormat('zh-CN').format(count);
      } catch (error) {
        return String(count);
      }
    }

    async function loadSingleFilePreview(entryIndex, startLine, lineCount) {
      if (busy || !searchResult || !parsedPreset) return;
      const previewState = singlePreviewState(entryIndex);
      previewState.loading = true;
      previewState.error = '';
      setBusy(true, 'single-preview');
      renderSearchResults(searchResult);
      startProgress(previewState.loaded
        ? '正在读取指定范围…'
        : '正在统计文件总行数并读取预览…');
      debug({ phase: 'single-preview-start', entryIndex, startLine, lineCount });
      try {
        const variables = collectVariableValues().values;
        const payload = await post('single-preview', {
          rootPath: String(rootPathInput.value || '').trim(),
          preset: presetForCollectionService(parsedPreset),
          variables,
          searchToken: searchResult.searchToken || '',
          index: entryIndex,
          startLine,
          lineCount
        });
        previewState.loaded = true;
        previewState.startLine = Math.max(1, Number(payload.startLine || startLine));
        previewState.lineCount = Math.max(1, Number(payload.lineCount || lineCount));
        previewState.totalLines = Math.max(0, Number(payload.totalLines || 0));
        previewState.relativePath = String(payload.relativePath || '');
        previewState.lines = Array.isArray(payload.lines) ? payload.lines : [];
        previewState.sequenceColumnHidden = !!payload.sequenceColumnHidden;
        setHint(
          '已显示第 ' + previewState.startLine + ' 行起的 '
            + previewState.lines.length + ' 行；文件共 '
            + formatPreviewLineCount(previewState.totalLines) + ' 行；'
            + (previewState.sequenceColumnHidden ? '序号列已隐藏' : '显示完整内容'),
          false
        );
        debug({
          phase: 'single-preview-complete', entryIndex,
          startLine: previewState.startLine,
          lineCount: previewState.lineCount,
          totalLines: previewState.totalLines,
          displayedCount: previewState.lines.length,
          sequenceColumnHidden: previewState.sequenceColumnHidden
        });
      } catch (error) {
        previewState.error = error.message || String(error);
        setHint(previewState.error, true);
        debug({
          phase: 'single-preview-error', entryIndex,
          startLine, lineCount, message: previewState.error
        });
      } finally {
        previewState.loading = false;
        setBusy(false, '');
        renderSearchResults(searchResult);
      }
    }

    function renderSearchResults(payload) {
      const entries = Array.from(searchEntriesByIndex(payload).values())
        .sort((left, right) => Number(left.index) - Number(right.index));
      if (payload && typeof payload === 'object') payload.entries = entries;
      const resultFragment = document.createDocumentFragment();
      entries.forEach((entry) => {
        const matches = Array.isArray(entry.matches) ? entry.matches : [];
        const importError = String(entry.importError || '');
        const formulaError = entry.status === 'formula-error'
          ? String(entry.message || '公式有误')
          : '';
        const multiWaveError = entry.status === 'multi-wave-error'
          ? String(entry.message || '多波形配置有误')
          : '';
        const displayedError = importError || formulaError || multiWaveError;
        const row = document.createElement('div');
        row.dataset.entryIndex = String(entry.index);
        row.className = 'wave-collection-result '
          + (displayedError
            ? 'is-error'
            : (entry.status === 'matched' || entry.status === 'formula-ready'
                || entry.status === 'multi-wave-ready'
            ? 'is-ready'
            : (entry.status === 'multiple' ? 'is-warning' : 'is-error')));
        const name = document.createElement('div');
        name.className = 'wave-collection-result-name';
        if (entry.importMode === 'formula') {
          name.textContent = String(entry.name || '未命名信号') + '（公式）';
        } else if (entry.importMode === 'multi-wave') {
          name.textContent = String(entry.name || 'multiWave') + '（多波形）';
        } else if (entry.importMode === 'table') {
          const importableColumns = (entry.columns || [])
            .filter((column) => String(column.source || '') !== String(entry.indexColumn || ''));
          const enabledCount = (entry.columns || [])
            .filter((column) => column.enabled !== false
              && String(column.source || '') !== String(entry.indexColumn || '')).length;
          name.textContent = String(entry.name || '表格文件') + '（表格，已选 '
            + enabledCount + '/' + importableColumns.length + ' 列）';
        } else {
          name.textContent = String(entry.name || '未命名信号')
            + (entry.hasSeq ? '（含序号）' : '（自动编号）');
        }
        const path = document.createElement('div');
        path.className = 'wave-collection-result-path';
        if (entry.importMode === 'formula') {
          const diagnostic = formulaDiagnostics.get(Number(entry.index));
          const references = diagnostic && Array.isArray(diagnostic.references)
            ? diagnostic.references : [];
          const libraries = diagnostic && Array.isArray(diagnostic.libraries)
            ? diagnostic.libraries : [];
          path.textContent = displayedError || [
            references.length ? ('依赖信号：' + references.join('、')) : '无信号依赖',
            libraries.length ? ('依赖库：' + libraries.join('、')) : ''
          ].filter(Boolean).join('；');
          path.title = displayedError || path.textContent;
        } else if (entry.importMode === 'multi-wave') {
          const sources = Array.isArray(entry.multiWave) ? entry.multiWave : [];
          path.textContent = displayedError || ('叠加信号：' + sources.join('、'));
          path.title = displayedError || path.textContent;
        } else if (matches.length === 1) {
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
        if (importError) state.textContent = '序号设置错误';
        else if (entry.status === 'formula-ready') state.textContent = '公式有效';
        else if (entry.status === 'formula-error') state.textContent = '公式错误，跳过';
        else if (entry.status === 'multi-wave-ready') state.textContent = '多波形有效';
        else if (entry.status === 'multi-wave-error') state.textContent = '多波形错误，跳过';
        else if (entry.status === 'matched') state.textContent = '已匹配';
        else if (entry.status === 'multiple') state.textContent = matches.length + ' 个匹配，取第 1 个';
        else if (entry.status === 'duplicate-name') state.textContent = 'name重复';
        else if (entry.status === 'config-error') state.textContent = '配置错误';
        else if (entry.status === 'folder-missing') state.textContent = '目录不存在，跳过';
        else state.textContent = '未匹配，跳过';
        const actions = document.createElement('div');
        actions.className = 'wave-collection-result-actions';
        actions.appendChild(state);
        let previewState = null;
        if (entry.importMode === 'single' && matches.length) {
          previewState = singlePreviewState(entry.index);
          const togglePreview = document.createElement('button');
          togglePreview.type = 'button';
          togglePreview.className = 'modal-btn wave-collection-preview-toggle';
          togglePreview.textContent = previewState.expanded ? '收起' : '展开';
          togglePreview.setAttribute('aria-expanded', String(previewState.expanded));
          togglePreview.setAttribute(
            'aria-label',
            (previewState.expanded ? '收起文件预览：' : '展开文件预览：')
              + String(matches[0].relativePath || matches[0].fileName || entry.name || '')
          );
          togglePreview.addEventListener('click', () => {
            previewState.expanded = !previewState.expanded;
            renderSearchResults(payload);
            if (previewState.expanded && !previewState.loaded && !previewState.loading) {
              void loadSingleFilePreview(
                entry.index, previewState.startLine, previewState.lineCount);
            }
          });
          actions.appendChild(togglePreview);
        }
        row.appendChild(name);
        row.appendChild(path);
        row.appendChild(actions);
        if (displayedError) {
          const error = document.createElement('div');
          error.className = 'wave-collection-result-error';
          error.textContent = displayedError;
          error.setAttribute('role', 'alert');
          row.appendChild(error);
        }
        if (entry.importMode === 'single' && matches.length) {
          const config = document.createElement('div');
          config.className = 'wave-collection-single-config';
          const sequenceLabel = document.createElement('label');
          sequenceLabel.className = 'wave-collection-sequence-option';
          const sequenceCheckbox = document.createElement('input');
          sequenceCheckbox.type = 'checkbox';
          sequenceCheckbox.checked = !!entry.hasSeq;
          sequenceCheckbox.setAttribute(
            'aria-label', String(entry.name || '单波形文件') + ' 第一列为序号');
          const sequenceText = document.createElement('span');
          sequenceText.textContent = '第一列为序号';
          sequenceCheckbox.addEventListener('change', () => {
            entry.hasSeq = sequenceCheckbox.checked;
            syncEntryAutoGen(entry, 'single-has-seq-change');
            if (previewState) {
              previewState.loaded = false;
              previewState.error = '';
              previewState.lines = [];
              previewState.sequenceColumnHidden = entry.hasSeq;
            }
            setHint(entry.hasSeq
              ? '预览已隐藏第一列；导入时第一列作为序号'
              : '预览显示完整文件；导入时从 0 自动编号', false);
            debug({
              phase: 'single-has-seq-change',
              entryIndex: entry.index,
              hasSeq: entry.hasSeq,
              parser: entry.parser,
              previewLineCount: previewState ? previewState.lines.length : 0,
              previewRefresh: !!(previewState && previewState.expanded)
            });
            renderSearchResults(payload);
            if (previewState && previewState.expanded && !previewState.loading) {
              void loadSingleFilePreview(
                entry.index, previewState.startLine, previewState.lineCount);
            }
          });
          sequenceLabel.appendChild(sequenceCheckbox);
          sequenceLabel.appendChild(sequenceText);
          config.appendChild(sequenceLabel);

          if (previewState && previewState.expanded) {
            const preview = document.createElement('section');
            preview.className = 'wave-collection-single-preview';
            preview.setAttribute('aria-label', '单波形文件内容预览');
            const heading = document.createElement('div');
            heading.className = 'wave-collection-preview-heading';
            const title = document.createElement('strong');
            title.textContent = entry.hasSeq
              ? '数据内容（序号列已隐藏）'
              : '文件完整内容';
            const meta = document.createElement('span');
            if (previewState.totalLines === null) {
              meta.textContent = previewState.loading ? '正在统计总行数…' : '尚未读取';
            } else {
              const selectedPath = previewState.relativePath
                || String(matches[0].relativePath || matches[0].fileName || '');
              meta.textContent = (selectedPath ? (selectedPath + ' · ') : '')
                + '共 ' + formatPreviewLineCount(previewState.totalLines) + ' 行';
              meta.title = String(matches[0].path || selectedPath);
            }
            heading.appendChild(title);
            heading.appendChild(meta);
            preview.appendChild(heading);

            const controls = document.createElement('div');
            controls.className = 'wave-collection-single-preview-controls';
            const startLabel = document.createElement('label');
            startLabel.textContent = '起始行';
            const startInput = document.createElement('input');
            startInput.type = 'number';
            startInput.className = 'modal-input';
            startInput.min = '1';
            startInput.step = '1';
            startInput.value = String(previewState.startLine);
            if (previewState.totalLines > 0) {
              startInput.max = String(previewState.totalLines);
            }
            startInput.setAttribute('aria-label', '文件预览起始行');
            startLabel.appendChild(startInput);
            const countLabel = document.createElement('label');
            countLabel.textContent = '显示行数';
            const countInput = document.createElement('input');
            countInput.type = 'number';
            countInput.className = 'modal-input';
            countInput.min = '1';
            countInput.max = '200';
            countInput.step = '1';
            countInput.value = String(previewState.lineCount);
            countInput.setAttribute('aria-label', '文件预览显示行数');
            countLabel.appendChild(countInput);
            const applyRange = document.createElement('button');
            applyRange.type = 'button';
            applyRange.className = 'modal-btn';
            applyRange.textContent = '应用';
            const apply = () => {
              const startLine = Number(startInput.value);
              const lineCount = Number(countInput.value);
              if (!Number.isInteger(startLine) || startLine < 1) {
                setHint('预览起始行必须是大于或等于 1 的整数', true);
                startInput.focus();
                return;
              }
              if (!Number.isInteger(lineCount) || lineCount < 1 || lineCount > 200) {
                setHint('预览显示行数必须介于 1 和 200 之间', true);
                countInput.focus();
                return;
              }
              if (previewState.totalLines > 0 && startLine > previewState.totalLines) {
                setHint('预览起始行不能超过文件总行数 ' + previewState.totalLines, true);
                startInput.focus();
                return;
              }
              previewState.startLine = startLine;
              previewState.lineCount = lineCount;
              void loadSingleFilePreview(entry.index, startLine, lineCount);
            };
            applyRange.addEventListener('click', apply);
            [startInput, countInput].forEach((input) => {
              input.addEventListener('keydown', (event) => {
                event.stopPropagation();
                if (event.key !== 'Enter') return;
                event.preventDefault();
                apply();
              });
            });
            controls.appendChild(startLabel);
            controls.appendChild(countLabel);
            controls.appendChild(applyRange);
            preview.appendChild(controls);

            const viewport = document.createElement('div');
            viewport.className = 'wave-collection-single-preview-viewport';
            viewport.setAttribute('aria-live', 'polite');
            if (previewState.loading) {
              const loading = document.createElement('div');
              loading.className = 'wave-collection-single-preview-empty';
              loading.textContent = '正在读取文件内容…';
              viewport.appendChild(loading);
            } else if (previewState.error) {
              const error = document.createElement('div');
              error.className = 'wave-collection-single-preview-empty is-error';
              error.textContent = previewState.error;
              viewport.appendChild(error);
            } else if (previewState.lines.length) {
              previewState.lines.forEach((line) => {
                const lineRow = document.createElement('div');
                lineRow.className = 'wave-collection-single-preview-line';
                const lineNumber = document.createElement('span');
                lineNumber.textContent = String(line.number || '');
                const lineText = document.createElement('code');
                lineText.textContent = String(line.text == null ? '' : line.text);
                if (line.truncated) lineText.title = '该行内容过长，预览已截断';
                lineRow.appendChild(lineNumber);
                lineRow.appendChild(lineText);
                viewport.appendChild(lineRow);
              });
            } else {
              const empty = document.createElement('div');
              empty.className = 'wave-collection-single-preview-empty';
              empty.textContent = previewState.totalLines === 0 ? '文件为空' : '所选范围没有内容';
              viewport.appendChild(empty);
            }
            preview.appendChild(viewport);
            config.appendChild(preview);
          }
          row.appendChild(config);
        }
        if (entry.importMode === 'table' && matches.length) {
          const config = document.createElement('div');
          config.className = 'wave-collection-table-config';

          const headerControls = document.createElement('div');
          headerControls.className = 'wave-collection-table-header';
          const headerLabel = document.createElement('label');
          headerLabel.textContent = '标题行';
          const headerInput = document.createElement('input');
          headerInput.type = 'number';
          headerInput.className = 'modal-input wave-collection-header-row';
          headerInput.min = '1';
          headerInput.step = '1';
          headerInput.value = String(Math.max(1, Number(entry.headerRow || 1)));
          headerInput.setAttribute('aria-label', '表格标题所在行');
          const applyHeader = document.createElement('button');
          applyHeader.type = 'button';
          applyHeader.className = 'modal-btn wave-collection-apply-header';
          applyHeader.textContent = '应用预览';
          const apply = () => {
            const headerRow = Number(headerInput.value);
            if (!Number.isInteger(headerRow) || headerRow < 1) {
              setHint('标题行必须是大于或等于 1 的整数', true);
              headerInput.focus();
              return;
            }
            const invalidColumn = (entry.columns || []).find((column) =>
              columnFilterError(column.filter));
            if (invalidColumn) {
              setHint(
                '信号 ' + String(invalidColumn.source || '') + ' 的过滤条件有误：'
                  + columnFilterError(invalidColumn.filter),
                true
              );
              return;
            }
            syncEntryAutoGen(entry, 'table-preview-apply');
            void previewEntryHeader(entry.index, headerRow);
          };
          applyHeader.addEventListener('click', apply);
          headerInput.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            apply();
          });
          headerLabel.appendChild(headerInput);
          headerControls.appendChild(headerLabel);
          const indexLabel = document.createElement('label');
          indexLabel.textContent = '序号列';
          const indexSelect = document.createElement('select');
          indexSelect.className = 'modal-input wave-collection-index-column';
          indexSelect.setAttribute('aria-label', '选择 CSV 序号列');
          const noIndexOption = document.createElement('option');
          noIndexOption.value = '';
          noIndexOption.textContent = '不使用（筛选后从 0 编号）';
          indexSelect.appendChild(noIndexOption);
          (entry.columns || []).forEach((column) => {
            const option = document.createElement('option');
            option.value = String(column.source || '');
            option.textContent = String(column.source || '');
            indexSelect.appendChild(option);
          });
          indexSelect.value = String(entry.indexColumn || '');
          indexSelect.addEventListener('change', () => {
            entry.indexColumn = indexSelect.value;
            syncEntryAutoGen(entry, 'index-column-change');
            setHint(entry.indexColumn
              ? ('已将 ' + entry.indexColumn + ' 设为序号列；该列不作为波形信号导入')
              : '未使用序号列；筛选后的数据将从 0 开始重新编号', false);
            renderSearchResults(payload);
          });
          indexLabel.appendChild(indexSelect);
          headerControls.appendChild(indexLabel);
          const delimiter = document.createElement('span');
          delimiter.className = 'wave-collection-table-meta';
          delimiter.textContent = '分隔方式：' + String(entry.delimiter || '自动');
          headerControls.appendChild(delimiter);
          headerControls.appendChild(applyHeader);
          config.appendChild(headerControls);

          const previewColumns = Array.isArray(entry.previewColumns)
            ? entry.previewColumns : [];
          const previewRows = Array.isArray(entry.previewRows)
            ? entry.previewRows : [];
          if (previewColumns.length) {
            const preview = document.createElement('section');
            preview.className = 'wave-collection-table-preview';
            preview.setAttribute('aria-label', 'CSV 数据预览');
            const previewHeading = document.createElement('div');
            previewHeading.className = 'wave-collection-preview-heading';
            const previewTitle = document.createElement('strong');
            previewTitle.textContent = '数据预览';
            const previewMeta = document.createElement('span');
            previewMeta.textContent = '前 ' + previewRows.length + ' 行'
              + (entry.previewTruncated ? '，仅显示前 32 列' : '');
            previewHeading.appendChild(previewTitle);
            previewHeading.appendChild(previewMeta);
            preview.appendChild(previewHeading);

            const previewViewport = document.createElement('div');
            previewViewport.className = 'wave-collection-preview-viewport';
            const table = document.createElement('table');
            const tableHead = document.createElement('thead');
            const headerRow = document.createElement('tr');
            previewColumns.forEach((column) => {
              const cell = document.createElement('th');
              cell.scope = 'col';
              cell.textContent = String(column || '');
              if (String(column || '') === String(entry.indexColumn || '')) {
                cell.classList.add('is-index-column');
                cell.title = '序号列，不作为波形信号导入';
              }
              headerRow.appendChild(cell);
            });
            tableHead.appendChild(headerRow);
            table.appendChild(tableHead);
            const tableBody = document.createElement('tbody');
            previewRows.forEach((values) => {
              const dataRow = document.createElement('tr');
              previewColumns.forEach((column, columnIndex) => {
                const cell = document.createElement('td');
                cell.textContent = String((values || [])[columnIndex] || '');
                dataRow.appendChild(cell);
              });
              tableBody.appendChild(dataRow);
            });
            table.appendChild(tableBody);
            previewViewport.appendChild(table);
            preview.appendChild(previewViewport);
            config.appendChild(preview);
          }

          const columnTools = document.createElement('div');
          columnTools.className = 'wave-collection-column-tools';
          const filter = document.createElement('input');
          filter.type = 'search';
          filter.className = 'modal-input wave-collection-column-filter';
          filter.placeholder = '筛选列名';
          filter.setAttribute('aria-label', '筛选表格列');
          const selectAll = document.createElement('button');
          selectAll.type = 'button';
          selectAll.className = 'modal-btn';
          selectAll.textContent = '全选';
          const selectNone = document.createElement('button');
          selectNone.type = 'button';
          selectNone.className = 'modal-btn';
          selectNone.textContent = '全不选';
          columnTools.appendChild(filter);
          columnTools.appendChild(selectAll);
          columnTools.appendChild(selectNone);
          config.appendChild(columnTools);

          const columnsHost = document.createElement('div');
          columnsHost.className = 'wave-collection-columns';
          (entry.columns || []).forEach((column) => {
            const isIndexColumn = String(column.source || '') === String(entry.indexColumn || '');
            const columnRow = document.createElement('label');
            columnRow.className = 'wave-collection-column';
            columnRow.classList.toggle('is-index-column', isIndexColumn);
            columnRow.dataset.searchText = (String(column.source || '') + ' '
              + String(column.name || '')).toLowerCase();
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = !isIndexColumn && column.enabled !== false;
            checkbox.setAttribute('aria-label', '导入列 ' + String(column.source || ''));
            if (isIndexColumn) {
              checkbox.disabled = true;
              checkbox.dataset.permanentDisabled = 'true';
              checkbox.title = '序号列只用于定位，不作为波形信号导入';
            }
            const source = document.createElement('code');
            source.textContent = String(column.source || '') + (isIndexColumn ? '（序号列）' : '');
            const rename = document.createElement('input');
            rename.type = 'text';
            rename.className = 'modal-input wave-collection-column-name';
            rename.value = String(column.name || column.source || '');
            rename.placeholder = '导入后的信号名';
            rename.setAttribute('aria-label', String(column.source || '') + ' 导入后的信号名');
            if (isIndexColumn) {
              rename.disabled = true;
              rename.dataset.permanentDisabled = 'true';
              rename.title = '序号列不生成波形信号';
            }
            const condition = document.createElement('input');
            condition.type = 'text';
            condition.className = 'modal-input wave-collection-column-condition';
            condition.value = String(column.filter || '');
            condition.placeholder = '过滤条件，如 >=1&&<=2';
            condition.setAttribute('aria-label', String(column.source || '') + ' 的过滤条件');
            condition.title = '支持 =、!=、>、>=、<、<=，并可用 && 或 || 组合';
            let renameSyncTimer = 0;
            let conditionSyncTimer = 0;
            const updateConditionState = () => {
              const error = columnFilterError(condition.value);
              condition.setAttribute('aria-invalid', error ? 'true' : 'false');
              condition.title = error || '支持 =、!=、>、>=、<、<=，并可用 && 或 || 组合';
              return error;
            };
            checkbox.addEventListener('change', () => {
              column.enabled = checkbox.checked;
              syncEntryAutoGen(entry, 'column-toggle');
              renderSearchResults(payload);
            });
            rename.addEventListener('input', () => {
              column.name = rename.value;
              clearTimeout(renameSyncTimer);
              if (!rename.value.trim()) {
                updateButtons();
                return;
              }
              renameSyncTimer = window.setTimeout(() => {
                renameSyncTimer = 0;
                syncEntryAutoGen(entry, 'column-rename-input');
              }, 180);
              updateButtons();
            });
            rename.addEventListener('change', () => {
              clearTimeout(renameSyncTimer);
              renameSyncTimer = 0;
              column.name = rename.value.trim() || String(column.source || '');
              syncEntryAutoGen(entry, 'column-rename');
              renderSearchResults(payload);
            });
            condition.addEventListener('input', () => {
              column.filter = condition.value;
              clearTimeout(conditionSyncTimer);
              const error = updateConditionState();
              if (!error) {
                conditionSyncTimer = window.setTimeout(() => {
                  conditionSyncTimer = 0;
                  syncEntryAutoGen(entry, 'column-filter-input');
                }, 180);
              }
              updateButtons();
            });
            condition.addEventListener('change', () => {
              clearTimeout(conditionSyncTimer);
              conditionSyncTimer = 0;
              column.filter = condition.value.trim();
              condition.value = column.filter;
              const error = updateConditionState();
              if (error) {
                setHint('信号 ' + String(column.source || '') + ' 的过滤条件有误：' + error, true);
                updateButtons();
                return;
              }
              setHint('', false);
              syncEntryAutoGen(entry, 'column-filter');
            });
            columnRow.appendChild(checkbox);
            columnRow.appendChild(source);
            columnRow.appendChild(rename);
            columnRow.appendChild(condition);
            columnsHost.appendChild(columnRow);
          });
          const filterEmpty = document.createElement('div');
          filterEmpty.className = 'wave-collection-column-filter-empty';
          filterEmpty.textContent = '没有匹配的列';
          filterEmpty.hidden = true;
          columnsHost.appendChild(filterEmpty);
          const visibleColumns = () => Array.from(
            columnsHost.querySelectorAll('.wave-collection-column:not([hidden])')
          );
          filter.addEventListener('input', () => {
            const query = filter.value.trim().toLowerCase();
            columnsHost.querySelectorAll('.wave-collection-column').forEach((columnRow) => {
              columnRow.hidden = !!query && !columnRow.dataset.searchText.includes(query);
            });
            filterEmpty.hidden = visibleColumns().length > 0;
          });
          filter.addEventListener('keydown', (event) => {
            event.stopPropagation();
            if (event.key === 'Enter') event.preventDefault();
          });
          const setVisibleSelection = (enabled) => {
            visibleColumns().forEach((columnRow) => {
              const checkbox = columnRow.querySelector('input[type="checkbox"]');
              if (checkbox && checkbox.dataset.permanentDisabled !== 'true') {
                checkbox.checked = enabled;
              }
            });
            (entry.columns || []).forEach((column, index) => {
              const columnRow = columnsHost.children[index];
              if (columnRow && !columnRow.hidden
                  && String(column.source || '') !== String(entry.indexColumn || '')) {
                column.enabled = enabled;
              }
            });
            syncEntryAutoGen(entry, enabled ? 'columns-select-all' : 'columns-select-none');
            renderSearchResults(payload);
          };
          selectAll.addEventListener('click', () => setVisibleSelection(true));
          selectNone.addEventListener('click', () => setVisibleSelection(false));
          config.appendChild(columnsHost);
          row.appendChild(config);
        }
        resultFragment.appendChild(row);
      });
      resultsHost.replaceChildren(resultFragment);
      if (!entries.length) setEmptyResults('预设中没有搜索规则');
      renderSearchMarkers(payload);
      const multipleCount = entries.filter((entry) => entry.status === 'multiple').length;
      const skippedCount = entries.filter((entry) =>
        entry.status === 'missing' || entry.status === 'folder-missing'
          || entry.status === 'formula-error' || entry.status === 'multi-wave-error').length;
      const formulaCount = entries.filter((entry) => entry.status === 'formula-ready').length;
      const multiWaveCount = entries.filter((entry) => entry.status === 'multi-wave-ready').length;
      const fileCount = entries.filter((entry) =>
        entry.importMode !== 'formula' && entry.importMode !== 'multi-wave'
          && Array.isArray(entry.matches) && entry.matches.length > 0).length;
      const selection = collectionSelectionStatus();
      payload.ready = selection.valid;
      resultSummary.textContent = selection.valid
        ? ('已选择 ' + fileCount + ' 个文件、' + formulaCount + ' 个公式、'
          + multiWaveCount + ' 个多波形，可以导入'
          + (skippedCount ? '；跳过 ' + skippedCount + ' 条无效或未匹配规则' : '')
          + (multipleCount ? '；' + multipleCount + ' 条规则默认取第一个' : ''))
        : (selection.count > 0
          ? (selection.errors[0] || '请检查导入配置')
          : '没有找到可导入的文件、有效公式或多波形');
      updateButtons();
    }

    async function previewEntryHeader(entryIndex, headerRow) {
      if (busy || !searchResult || !parsedPreset) return;
      const variables = collectVariableValues().values;
      setBusy(true, 'preview');
      startProgress('正在应用标题行和列筛选条件…');
      try {
        const payload = await post('preview', {
          rootPath: String(rootPathInput.value || '').trim(),
          preset: presetForCollectionService(parsedPreset),
          variables,
          searchToken: searchResult.searchToken || '',
          index: entryIndex,
          headerRow
        });
        const normalized = adoptGeneratedPreset(
          payload.preset,
          'header-row-preview',
          parsedPreset
        );
        const position = searchResult.entries.findIndex((entry) => entry.index === entryIndex);
        if (position >= 0) searchResult.entries[position] = payload.entry;
        searchResult.preset = normalized;
        renderSearchResults(searchResult);
        setHint('已更新标题、列配置和筛选后的数据预览', false);
        debug({ phase: 'table-preview-complete', entryIndex, headerRow });
      } catch (error) {
        setHint(error.message || String(error), true);
        debug({
          phase: 'table-preview-error', entryIndex, headerRow,
          message: error.message || String(error)
        });
      } finally {
        setBusy(false, '');
      }
    }

    async function pickPath(kind, initialPath) {
      const result = await post('pick', {
        kind,
        initialPath: String(initialPath || '')
      });
      const normalized = {
        path: String(result.path || ''),
        cancelled: !!result.cancelled,
        manual: !!result.manual,
        message: String(result.message || ''),
        detail: String(result.detail || '')
      };
      debug({
        phase: 'path-picker-result', kind,
        cancelled: normalized.cancelled,
        manual: normalized.manual,
        hasPath: !!normalized.path,
        detail: normalized.detail
      });
      return normalized;
    }

    async function loadPreset(pathValue) {
      const path = String(pathValue || '').trim();
      if (!path || busy) return;
      if (selectedDiscoveredPreset
          && path === selectedDiscoveredPreset.relativePath
          && String(presetSearchPathInput.value || '').trim()
            === selectedDiscoveredPreset.searchPath) {
        const entry = discoveredPresets.find((item) => (
          String(item.relativePath || '') === selectedDiscoveredPreset.relativePath
        )) || { relativePath: selectedDiscoveredPreset.relativePath };
        await loadDiscoveredPreset(entry);
        return;
      }
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
        selectedDiscoveredPreset = null;
        updateDiscoveredPresetSelection();
        originalPresetPath = String(payload.presetPath || path);
        manualSavePathMode = false;
        presetPathInput.value = originalPresetPath;
        const presetText = typeof payload.presetText === 'string'
          ? payload.presetText.replace(/^\uFEFF/, '')
          : JSON.stringify(payload.preset || EMPTY_PRESET, null, 2);
        setPresetEditorValue(presetText);
        variableValues.clear();
        parsedPreset = null;
        const loadedPreset = synchronizeLoadedPresetVariables(parseEditor(true));
        invalidateSearch('preset-loaded');
        rememberState('preset-loaded');
        if (loadedPreset) {
          setHint('预设已读取；变量从预设模板自动识别，留空按 0 匹配', false);
        }
        debug({
          phase: 'preset-load-complete',
          path: originalPresetPath,
          valid: !!loadedPreset,
          errorLine: Number(payload.errorLine || 0),
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

    async function loadDiscoveredPreset(entry) {
      const searchPath = String(presetSearchPathInput.value || '').trim();
      const relativePath = String(entry && entry.relativePath || '').trim();
      if (!searchPath || !relativePath || busy) return;
      setBusy(true, 'load');
      startProgress('正在读取搜索到的预设…');
      const startedAt = progressStartedAt;
      debug({ phase: 'preset-discovered-load-start', relativePath });
      try {
        const payload = await post('load-discovered', { searchPath, relativePath });
        selectedBrowserPresetFile = null;
        selectedDiscoveredPreset = {
          searchPath,
          relativePath: String(payload.relativePath || relativePath)
        };
        originalPresetPath = String(payload.presetPath || '');
        manualSavePathMode = false;
        presetPathInput.value = selectedDiscoveredPreset.relativePath;
        const presetText = typeof payload.presetText === 'string'
          ? payload.presetText.replace(/^\uFEFF/, '')
          : JSON.stringify(payload.preset || EMPTY_PRESET, null, 2);
        setPresetEditorValue(presetText);
        variableValues.clear();
        parsedPreset = null;
        const loadedPreset = synchronizeLoadedPresetVariables(parseEditor(true));
        invalidateSearch('preset-discovered-loaded');
        updateDiscoveredPresetSelection();
        rememberState('preset-discovered-loaded');
        if (loadedPreset) {
          setHint('已读取预设：' + selectedDiscoveredPreset.relativePath, false);
        }
        debug({
          phase: 'preset-discovered-load-complete',
          relativePath: selectedDiscoveredPreset.relativePath,
          valid: !!loadedPreset,
          errorLine: Number(payload.errorLine || 0),
          variableCount: parsedPreset ? parsedPreset.vars.length : 0,
          pathCount: parsedPreset ? parsedPreset.paths.length : 0,
          durationMs: Math.round(progressNow() - startedAt)
        });
      } catch (error) {
        setHint(error.message || String(error), true);
        status(false, '读取预设集合失败：' + (error.message || String(error)));
        debug({
          phase: 'preset-discovered-load-error',
          relativePath,
          message: error.message || String(error)
        });
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
        const text = String(await readBrowserPresetText(file)).replace(/^\uFEFF/, '');
        selectedBrowserPresetFile = file;
        selectedDiscoveredPreset = null;
        updateDiscoveredPresetSelection();
        originalPresetPath = '';
        manualSavePathMode = false;
        presetPathInput.value = file.name;
        setPresetEditorValue(text);
        variableValues.clear();
        parsedPreset = null;
        const loadedPreset = synchronizeLoadedPresetVariables(parseEditor(true));
        invalidateSearch('preset-browser-loaded');
        rememberState('preset-browser-loaded');
        if (loadedPreset) setHint('已读取预设文件：' + file.name, false);
        debug({
          phase: 'preset-browser-load-complete',
          name: file.name,
          valid: !!loadedPreset,
          variableCount: loadedPreset ? loadedPreset.vars.length : 0,
          pathCount: loadedPreset ? loadedPreset.paths.length : 0,
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

    function readBrowserPresetText(file) {
      if (file && typeof file.text === 'function') return file.text();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener('load', () => resolve(String(reader.result || '')), { once: true });
        reader.addEventListener('error', () => {
          reject(reader.error || new Error('无法读取选择的预设文件'));
        }, { once: true });
        reader.readAsText(file, 'UTF-8');
      });
    }

    async function chooseRoot() {
      if (busy) return;
      let focusManualPath = false;
      setBusy(true, 'pick');
      try {
        const result = await pickPath('folder', rootPathInput.value);
        if (result.manual) {
          if (result.path) rootPathInput.value = result.path;
          setHint(result.message || '请直接输入数据文件夹路径', false);
          status(true, '请在页面中输入数据文件夹路径');
          focusManualPath = true;
        } else if (!result.cancelled && result.path) {
          rootPathInput.value = result.path;
          invalidateSearch('root-selected');
          rememberState('root-selected');
        }
      } catch (error) {
        setHint((error.message || String(error)) + '；也可以直接粘贴文件夹路径', true);
      } finally {
        setBusy(false, '');
        refreshEditorsAfterPathPicker('data-folder-picker');
        if (focusManualPath) focusAndSelectPath(rootPathInput);
      }
    }

    async function choosePresetRoot() {
      if (busy) return;
      let focusManualPath = false;
      setBusy(true, 'pick');
      try {
        const result = await pickPath('folder', presetSearchPathInput.value);
        if (result.manual) {
          if (result.path) presetSearchPathInput.value = result.path;
          setHint(result.message || '请直接输入预设搜索目录', false);
          status(true, '请在页面中输入预设搜索目录');
          focusManualPath = true;
        } else if (!result.cancelled && result.path) {
          presetSearchPathInput.value = result.path;
          selectedDiscoveredPreset = null;
          clearPresetDiscovery();
          rememberState('preset-search-root-selected');
        }
      } catch (error) {
        setHint((error.message || String(error)) + '；也可以直接粘贴搜索目录', true);
      } finally {
        setBusy(false, '');
        refreshEditorsAfterPathPicker('preset-folder-picker');
        if (focusManualPath) focusAndSelectPath(presetSearchPathInput);
      }
    }

    async function scanPresets() {
      const searchPath = String(presetSearchPathInput.value || '').trim();
      if (!searchPath || busy) {
        if (!searchPath) setHint('请先设置预设搜索目录', true);
        return;
      }
      setBusy(true, 'scan-presets');
      startProgress('正在递归搜索批量导入预设…');
      const startedAt = progressStartedAt;
      presetDiscoveryHost.hidden = false;
      presetDiscoveryHost.innerHTML = '';
      const loading = document.createElement('div');
      loading.className = 'wave-collection-preset-discovery-empty';
      loading.textContent = '正在搜索预设…';
      presetDiscoveryHost.appendChild(loading);
      debug({ phase: 'preset-scan-start', searchPath });
      try {
        const payload = await post('scan-presets', { searchPath });
        selectedDiscoveredPreset = null;
        renderPresetDiscovery(payload);
        rememberState('preset-scan-complete');
        const resultCount = Number(payload.resultCount || 0);
        const details = '扫描 ' + Number(payload.visitedFiles || 0) + ' 个文件，找到 '
          + resultCount + ' 个预设，耗时 '
          + Number(payload.durationMs || Math.round(progressNow() - startedAt)) + ' ms';
        setHint(details + (payload.truncated ? '；结果已达到显示上限' : ''), false);
        debug({
          phase: 'preset-scan-complete',
          resultCount,
          visitedFiles: Number(payload.visitedFiles || 0),
          skippedFiles: Number(payload.skippedFiles || 0),
          truncated: !!payload.truncated,
          durationMs: Number(payload.durationMs || Math.round(progressNow() - startedAt))
        });
      } catch (error) {
        clearPresetDiscovery();
        setHint(error.message || String(error), true);
        status(false, '搜索预设失败：' + (error.message || String(error)));
        debug({ phase: 'preset-scan-error', message: error.message || String(error) });
      } finally {
        setBusy(false, '');
      }
    }

    async function choosePreset() {
      if (busy || !presetFileInput) return;
      const serverMode = typeof settings.isServerMode === 'function'
        && !!settings.isServerMode();
      if (!serverMode) {
        presetFileInput.value = '';
        debug({ phase: 'preset-browser-picker-open', serverMode: false });
        if (typeof presetFileInput.showPicker === 'function') presetFileInput.showPicker();
        else presetFileInput.click();
        return;
      }

      let selectedPath = '';
      let focusManualPath = false;
      setBusy(true, 'pick');
      debug({ phase: 'preset-native-picker-open', serverMode: true });
      try {
        const initialPath = originalPresetPath || String(presetPathInput.value || '').trim();
        const result = await pickPath('preset', initialPath);
        if (result.manual) {
          manualSavePathMode = false;
          if (result.path) presetPathInput.value = result.path;
          setHint(result.message || '请直接输入预设 JSON 路径，再点击“读取预设”', false);
          status(true, '请在页面中输入预设 JSON 路径');
          focusManualPath = true;
          debug({
            phase: 'preset-native-picker-manual-path',
            path: presetPathInput.value,
            detail: result.detail
          });
        } else if (!result.cancelled && result.path) {
          selectedPath = result.path;
          selectedBrowserPresetFile = null;
          selectedDiscoveredPreset = null;
          manualSavePathMode = false;
          presetPathInput.value = selectedPath;
          updateDiscoveredPresetSelection();
          rememberState('preset-native-selected');
          debug({ phase: 'preset-native-picker-selected', path: selectedPath });
        } else {
          debug({ phase: 'preset-native-picker-cancelled' });
        }
      } catch (error) {
        setHint((error.message || String(error)) + '；也可以直接粘贴预设路径', true);
        status(false, '选择预设失败：' + (error.message || String(error)));
        debug({ phase: 'preset-native-picker-error', message: error.message || String(error) });
      } finally {
        setBusy(false, '');
        refreshEditorsAfterPathPicker('preset-open-picker');
      }
      if (focusManualPath) {
        focusAndSelectPath(presetPathInput);
        return;
      }
      if (selectedPath) await loadPreset(selectedPath);
    }

    async function savePreset() {
      const preset = parseEditor(true);
      if (!preset || busy) return;
      let focusManualPath = false;
      setBusy(true, 'save');
      startProgress(manualSavePathMode ? '正在保存预设…' : '请选择预设保存路径…');
      const startedAt = progressStartedAt;
      try {
        let selected = String(presetPathInput.value || '').trim();
        if (!manualSavePathMode) {
          const initialPath = originalPresetPath
            || (selectedBrowserPresetFile ? '' : selected);
          const result = await pickPath('save-preset', initialPath);
          if (result.manual) {
            manualSavePathMode = true;
            presetPathInput.value = result.path || initialPath
              || 'inc/import/SchemeCollection/preset.json';
            setHint(
              result.message
                || '请修改上方的预设 JSON 路径，然后点击“保存到此路径”',
              false
            );
            status(true, '请在页面中输入预设保存路径');
            debug({
              phase: 'preset-save-manual-path',
              hasSuggestedPath: !!presetPathInput.value,
              detail: result.detail
            });
            focusManualPath = true;
            return;
          }
          if (result.cancelled || !result.path) return;
          selected = result.path;
        }
        if (!selected) {
          setHint('请输入预设保存路径', true);
          focusManualPath = true;
          return;
        }
        const payload = await post('save', {
          presetPath: selected,
          preset
        });
        originalPresetPath = String(payload.presetPath || selected);
        manualSavePathMode = false;
        selectedBrowserPresetFile = null;
        selectedDiscoveredPreset = null;
        updateDiscoveredPresetSelection();
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
        refreshEditorsAfterPathPicker('preset-save-picker');
        if (focusManualPath) focusAndSelectPath(presetPathInput);
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
      singlePreviewStates.clear();
      setBusy(true, 'search');
      startProgress('正在建立文件索引并匹配规则…');
      const startedAt = progressStartedAt;
      setEmptyResults('正在搜索…');
      debug({ phase: 'search-start', rootPath, variables });
      try {
        const payload = await post('search', {
          rootPath,
          preset: presetForCollectionService(preset),
          variables
        });
        searchResult = payload;
        let effectivePreset = preset;
        if (payload.preset) {
          effectivePreset = adoptGeneratedPreset(payload.preset, 'search-autogen', preset);
        }
        decorateFormulaSearchResult(payload, effectivePreset);
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
        const selection = collectionSelectionStatus();
        const validFormulaCount = Number(payload.formulaCount || 0);
        const validMultiWaveCount = Number(payload.multiWaveCount || 0);
        setHint(selection.valid
          ? ('搜索完成：' + searchDetails + '。确认结果后点击“确定导入”'
            + (skippedCount ? '；' + skippedCount + ' 条未匹配规则将被跳过' : '')
            + (multipleCount ? '；多匹配规则已默认选择第一个文件' : '')
            + (validFormulaCount ? '；' + validFormulaCount + ' 个公式有效' : '')
            + (validMultiWaveCount ? '；' + validMultiWaveCount + ' 个多波形有效' : ''))
          : ('搜索完成：' + searchDetails
            + (selection.count > 0
              ? '。请修改重复信号名'
              : '。没有找到可导入文件、有效公式或多波形')), !selection.valid);
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

    function importWasCancelled(error) {
      const message = String(error && error.message || error || '');
      return importCancelRequested
        || !!(error && error.name === 'AbortError')
        || /import cancelled|导入已取消/i.test(message);
    }

    async function cancelImport() {
      if (!busy || busyAction !== 'import' || importCancelRequested
          || !importCancellationAllowed) return;
      importCancelRequested = true;
      importCancellationAllowed = false;
      updateButtons();
      stopProgress();
      setFooterProgress('正在取消导入…', false);
      const controller = activeImportController;
      const progressToken = activeImportProgressToken;
      const cancelRequest = progressToken
        ? post('cancel-import', { progressToken })
        : Promise.resolve({});
      if (controller) controller.abort();
      debug({ phase: 'import-cancel-requested', progressToken });
      try {
        await cancelRequest;
      } catch (error) {
        debug({
          phase: 'import-cancel-notify-error',
          message: error.message || String(error)
        });
      }
    }

    async function confirmImport() {
      if (busy || !searchResult) return;
      const selection = collectionSelectionStatus();
      if (!selection.valid) {
        setHint(selection.errors[0] || '请先完成表格列选择', true);
        return;
      }
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
      const fileCount = (searchResult.entries || []).filter((entry) =>
        entry.importMode !== 'formula' && entry.importMode !== 'multi-wave'
          && Array.isArray(entry.matches) && entry.matches.length > 0).length;
      const formulas = validFormulaDefinitions();
      const multiWaves = validMultiWaveDefinitions();
      const progressToken = createImportProgressToken();
      const importController = typeof window.AbortController === 'function'
        ? new window.AbortController()
        : null;
      activeImportController = importController;
      activeImportProgressToken = progressToken;
      importCancelRequested = false;
      importCancellationAllowed = true;
      setBusy(true, 'import');
      setHint('', false);
      startProgress('正在检查第一列和文件解析设置…');
      const startedAt = progressStartedAt;
      debug({
        phase: 'import-start',
        rootPath,
        variables,
        fileCount,
        formulaCount: formulas.length,
        multiWaveCount: multiWaves.length,
        hasSearchToken: !!searchResult.searchToken
      });
      try {
        const preflightValid = await validateSingleFileSelections(
          preset,
          variables,
          rootPath,
          importController ? importController.signal : undefined
        );
        if (!preflightValid) return;
        if (importCancelRequested) {
          const cancelled = new Error('导入已取消');
          cancelled.name = 'AbortError';
          throw cancelled;
        }
        updateProgress('正在核对并解析 ' + fileCount + ' 个文件、'
          + formulas.length + ' 个公式、' + multiWaves.length + ' 个多波形…');
        startImportProgressPolling(progressToken, fileCount);
        const payload = fileCount > 0
          ? await post('import', {
            rootPath,
            preset: presetForCollectionService(preset),
            variables,
            searchToken: searchResult.searchToken || '',
            progressToken
          }, { signal: importController ? importController.signal : undefined })
          : {
            files: [],
            updates: [],
            skippedCount: 0,
            formulaCount: formulas.length,
            multiWaveCount: multiWaves.length,
            progress: {
              phase: 'complete',
              totalFiles: 0,
              completedFiles: 0,
              successfulFiles: 0,
              failedFiles: 0,
              signalCount: 0,
              done: true
            }
          };
        if (importCancelRequested) {
          const cancelled = new Error('导入已取消');
          cancelled.name = 'AbortError';
          throw cancelled;
        }
        payload.formulas = formulas;
        payload.multiWaves = multiWaves;
        payload.updates = (Array.isArray(payload.updates) ? payload.updates : []).concat(
          multiWaves.map((definition) => ({
            signal: definition.name,
            wave: '',
            data: [],
            sampleKind: 'analog',
            createIfMissing: true,
            multiWave: definition.multiWave.slice()
          }))
        );
        stopImportProgressPolling();
        applyImportProgress(payload.progress);
        if (typeof settings.getContextToken === 'function'
            && settings.getContextToken() !== contextToken) {
          throw new Error('解析期间波形图或波形库已切换，请重新搜索');
        }
        if (typeof settings.applyImport !== 'function') {
          throw new Error('批量导入处理函数未初始化');
        }
        if (importProgressState) {
          importProgressState.phase = formulas.length ? 'formula' : 'applying';
          importProgressState.done = false;
          importProgressState.formulaIndex = 0;
          importProgressState.totalFormulas = formulas.length;
          importProgressState.currentFormula = '';
          importProgressState.formulaStage = 'evaluating';
          importProgressState.applyStage = formulas.length ? '' : 'writing';
        }
        updateProgress(formulas.length
          ? '文件解析完成，正在计算公式…'
          : '文件解析完成，正在写入当前波形图…');
        const result = await settings.applyImport(payload, {
          onProgress: applyFormulaProgress,
          signal: importController ? importController.signal : undefined,
          onCancelableChange: (allowed) => {
            importCancellationAllowed = !!allowed;
            updateButtons();
          }
        });
        const completedFiles = payload.progress
          ? Number(payload.progress.successfulFiles || payload.progress.completedFiles || 0)
          : (Array.isArray(payload.files) ? payload.files.length : fileCount);
        const elapsedSeconds = Math.max(0,
          (progressNow() - startedAt) / 1000).toFixed(1);
        setHint('', false);
        status(
          true,
          (result.changed ? '已批量导入 ' : '批量导入内容未变化：')
            + completedFiles + ' 个文件，' + result.count + ' 个信号行'
            + (formulas.length ? '（含 ' + formulas.length + ' 个公式）' : '')
            + (multiWaves.length ? '（含 ' + multiWaves.length + ' 个多波形）' : '')
            + (result.createdCount ? '，新增 ' + result.createdCount + ' 行' : '')
            + '，耗时 ' + elapsedSeconds + ' 秒'
        );
        debug({
          phase: 'import-complete',
          changed: result.changed,
          completedFiles,
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
        const message = error.message || String(error);
        if (importWasCancelled(error)) {
          setHint('已取消导入，波形数据未写入', false);
          status(true, '已取消预设集合导入');
          debug({
            phase: 'import-cancelled',
            message,
            progress: importProgressState
          });
          return;
        }
        const entries = Array.isArray(searchResult && searchResult.entries)
          ? searchResult.entries
          : [];
        const failedEntry = entries.find((entry) => (entry.matches || []).some((match) => {
          const candidates = [match.relativePath, match.fileName, match.path]
            .map((value) => String(value || ''))
            .filter(Boolean);
          return candidates.some((value) => message.includes(value));
        }));
        if (failedEntry) {
          failedEntry.importError = message;
          renderSearchResults(searchResult);
          revealEntryImportError(failedEntry.index);
        }
        setHint('导入失败：' + message, true);
        status(false, '导入预设集合失败：' + message);
        debug({
          phase: 'import-error',
          message,
          failedEntryIndex: failedEntry ? failedEntry.index : -1,
          progress: importProgressState,
          sequenceSelections: entries
            .filter((entry) => entry.importMode === 'single')
            .map((entry) => ({ index: entry.index, hasSeq: !!entry.hasSeq }))
        });
      } finally {
        if (activeImportController === importController) {
          activeImportController = null;
          activeImportProgressToken = '';
        }
        importCancelRequested = false;
        importCancellationAllowed = false;
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
      busyAction = '';
      activeImportController = null;
      activeImportProgressToken = '';
      importCancelRequested = false;
      importCancellationAllowed = false;
      setFooterProgress('', false);
      manualSavePathMode = false;
      activePresetNavigationIndex = -1;
      presetNavigationRanges = [];
      clearPresetNavigationHighlight();
      parsedPreset = null;
      searchResult = null;
      singlePreviewStates.clear();
      clearPresetDiscovery();
      const restored = restoreRememberedState();
      if (!restored) {
        originalPresetPath = '';
        selectedBrowserPresetFile = null;
        selectedDiscoveredPreset = null;
        variableValues.clear();
        rootPathInput.value = '';
        presetSearchPathInput.value = DEFAULT_PRESET_SEARCH_PATH;
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
      clearPresetNavigationHighlight();
      stopProgress();
      debug({ phase: 'modal-close' });
    }

    pickRootButton.addEventListener('click', () => { void chooseRoot(); });
    pickPresetRootButton.addEventListener('click', () => { void choosePresetRoot(); });
    scanPresetsButton.addEventListener('click', () => { void scanPresets(); });
    pickPresetButton.addEventListener('click', () => { void choosePreset(); });
    presetFileInput.addEventListener('change', () => {
      const file = presetFileInput.files && presetFileInput.files[0];
      debug({
        phase: 'preset-browser-picker-change',
        hasFile: !!file,
        name: file ? file.name : ''
      });
      if (!file) return;
      presetPathInput.value = file.name;
      rememberState('preset-browser-selected');
      void loadBrowserPreset(file);
    });
    loadPresetButton.addEventListener('click', () => { void loadPreset(presetPathInput.value); });
    savePresetButton.addEventListener('click', () => { void savePreset(); });
    searchButton.addEventListener('click', () => { void searchFiles(); });
    confirmButton.addEventListener('click', () => { void confirmImport(); });
    cancelButton.addEventListener('click', () => {
      if (busy && busyAction === 'import') {
        void cancelImport();
        return;
      }
      close();
    });
    presetEditor.addEventListener('input', scheduleEditorParse);
    rootPathInput.addEventListener('input', () => {
      invalidateSearch('root-path-change');
      scheduleRememberState('root-path-change');
    });
    presetSearchPathInput.addEventListener('input', () => {
      selectedDiscoveredPreset = null;
      clearPresetDiscovery();
      scheduleRememberState('preset-search-path-change');
      updateButtons();
    });
    presetSearchPathInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || busy) return;
      event.preventDefault();
      void scanPresets();
    });
    presetPathInput.addEventListener('input', () => {
      selectedBrowserPresetFile = null;
      selectedDiscoveredPreset = null;
      updateDiscoveredPresetSelection();
      scheduleRememberState('preset-path-change');
      updateButtons();
    });
    presetPathInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || busy) return;
      event.preventDefault();
      void loadPreset(presetPathInput.value);
    });
    modal.addEventListener('pointerdown', (event) => {
      modalBackdropPress = event.button === 0 && event.target === modal
        ? {
            pointerId: event.pointerId,
            clientX: event.clientX,
            clientY: event.clientY
          }
        : null;
    });
    modal.addEventListener('pointercancel', () => {
      modalBackdropPress = null;
    });
    document.addEventListener('pointerup', (event) => {
      if (!modalBackdropPress) return;
      if (event.pointerId !== modalBackdropPress.pointerId || event.target !== modal) {
        modalBackdropPress = null;
      }
    }, true);
    window.addEventListener('blur', () => {
      modalBackdropPress = null;
    });
    modal.addEventListener('click', (event) => {
      if (event.target !== modal) return;
      const press = modalBackdropPress;
      modalBackdropPress = null;
      const distance = press
        ? Math.hypot(event.clientX - press.clientX, event.clientY - press.clientY)
        : Number.POSITIVE_INFINITY;
      if (!press || distance > 6) {
        debug({
          phase: 'modal-backdrop-close-blocked',
          reason: press ? 'pointer-dragged' : 'pointer-started-inside-dialog',
          distance: Number.isFinite(distance) ? Math.round(distance) : null
        });
        return;
      }
      debug({ phase: 'modal-backdrop-close', distance: Math.round(distance) });
      close();
    });
    modal.addEventListener('keydown', (event) => {
      if (event.target && event.target.closest
          && event.target.closest('input, textarea, select, [contenteditable="true"]')) {
        event.stopPropagation();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !modal.hidden) {
        const target = event.target && event.target.closest ? event.target : null;
        if (target && target.matches('.wave-collection-column-filter') && target.value) return;
        event.preventDefault();
        close();
      }
    }, true);
    window.addEventListener('focus', () => {
      if (!modal.hidden) refreshEditorsAfterPathPicker('window-focus');
    });

    return { open, close };
  }

  window.VWDImportCollection = { create };
})();

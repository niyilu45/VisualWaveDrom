(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VisualWaveDromJsonBigData = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VIEW_METADATA_KEY = '__vwdView';
  const DEFAULT_CHUNK_SIZE = 8192;
  const PATCH_CHUNK_THRESHOLD = 1024 * 1024;
  const DATA_TOKEN_RE = /[2-9=]/;

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function isDataToken(value) {
    return typeof value === 'string' && value.length === 1 && DATA_TOKEN_RE.test(value);
  }

  function cloneValue(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function cloneScopeForWindow(scope) {
    if (!isObject(scope)) return cloneValue(scope);
    const copy = {};
    Object.keys(scope).forEach(function (key) {
      if (key === 'samples' && Array.isArray(scope.samples)) return;
      copy[key] = cloneValue(scope[key]);
    });
    return copy;
  }

  function clampInteger(value, minimum, maximum) {
    const number = Number.isFinite(Number(value)) ? Math.floor(Number(value)) : minimum;
    return Math.max(minimum, Math.min(maximum, number));
  }

  function isRenderedSignalRow(signal) {
    if (!isObject(signal)) return false;
    const hasChildren = Array.isArray(signal.children);
    const hasSignalField = ['name', 'wave', 'node', 'data', 'period', 'phase'].some(function (key) {
      return Object.prototype.hasOwnProperty.call(signal, key);
    });
    return !hasChildren || hasSignalField;
  }

  function normalizeDataValues(data) {
    if (Array.isArray(data)) return data.map(function (value) {
      return value == null ? '' : String(value);
    });
    if (typeof data !== 'string' || !data.trim()) return [];
    return data.trim().split(/\s+/);
  }

  function collectDataColumns(wave) {
    const columns = [];
    const text = String(wave || '');
    for (let column = 0; column < text.length; column += 1) {
      if (isDataToken(text[column])) columns.push(column);
    }
    return columns;
  }

  function dataValuesByColumn(wave, data, columnOffset) {
    const values = normalizeDataValues(data);
    const columns = collectDataColumns(wave);
    const offset = Number(columnOffset) || 0;
    const result = new Map();
    columns.forEach(function (column, index) {
      result.set(column + offset, values[index] === undefined ? '' : values[index]);
    });
    return result;
  }

  function measureSignalList(signals, metrics) {
    if (!Array.isArray(signals)) return metrics;
    signals.forEach(function (signal) {
      if (Array.isArray(signal)) {
        metrics.groupCount += 1;
        measureSignalList(signal.slice(1), metrics);
        return;
      }
      if (!isObject(signal)) return;
      if (isRenderedSignalRow(signal)) {
        const waveLength = typeof signal.wave === 'string' ? signal.wave.length : 0;
        metrics.signalCount += 1;
        metrics.cellCount += waveLength;
        metrics.maxWaveLength = Math.max(metrics.maxWaveLength, waveLength);
        metrics.dataCellCount += collectDataColumns(signal.wave).length;
      }
      if (Array.isArray(signal.children)) measureSignalList(signal.children, metrics);
    });
    return metrics;
  }

  function measureSource(source) {
    return measureSignalList(source && source.signal, {
      signalCount: 0,
      groupCount: 0,
      maxWaveLength: 0,
      cellCount: 0,
      dataCellCount: 0,
      edgeCount: source && Array.isArray(source.edge) ? source.edge.length : 0
    });
  }

  function sliceSignalObject(signal, start, end) {
    const copy = {};
    Object.keys(signal).forEach(function (key) {
      if (key === 'children') return;
      if (key === 'wave') {
        copy.wave = typeof signal.wave === 'string' ? signal.wave.slice(start, end) : signal.wave;
        return;
      }
      if (key === 'node') {
        copy.node = typeof signal.node === 'string' ? signal.node.slice(start, end) : signal.node;
        return;
      }
      if (key === 'data') return;
      if (key === 'scope') {
        copy.scope = cloneScopeForWindow(signal.scope);
        return;
      }
      copy[key] = cloneValue(signal[key]);
    });

    if (Object.prototype.hasOwnProperty.call(signal, 'data')) {
      const fullWave = typeof signal.wave === 'string' ? signal.wave : '';
      const valuesByColumn = dataValuesByColumn(fullWave, signal.data, 0);
      const windowValues = [];
      collectDataColumns(fullWave).forEach(function (column) {
        if (column >= start && column < end) {
          windowValues.push(valuesByColumn.get(column) || '');
        }
      });
      copy.data = Array.isArray(signal.data) ? windowValues : windowValues.join(' ');
    }

    if (Array.isArray(signal.children)) {
      copy.children = sliceSignalList(signal.children, start, end);
    }
    return copy;
  }

  function sliceSignalList(signals, start, end) {
    if (!Array.isArray(signals)) return cloneValue(signals);
    return signals.map(function (signal) {
      if (Array.isArray(signal)) {
        const label = signal.length ? cloneValue(signal[0]) : '';
        return [label].concat(sliceSignalList(signal.slice(1), start, end));
      }
      if (!isObject(signal)) return cloneValue(signal);
      return sliceSignalObject(signal, start, end);
    });
  }

  function createWindowDocument(source, options) {
    if (!isObject(source)) throw new Error('Wave document root must be an object');
    const opts = options || {};
    const metrics = opts.metrics || measureSource(source);
    const totalColumns = Math.max(0, Number(metrics.maxWaveLength) || 0);
    const start = clampInteger(opts.start, 0, Math.max(0, totalColumns));
    const requestedEnd = Number.isFinite(Number(opts.end))
      ? Math.floor(Number(opts.end))
      : start + Math.max(1, Math.floor(Number(opts.size) || 1));
    const end = clampInteger(requestedEnd, start, Math.max(start, totalColumns));
    const result = {};
    result[VIEW_METADATA_KEY] = {
      mode: 'window',
      start: start,
      end: end,
      totalColumns: totalColumns,
      signalCount: metrics.signalCount
    };
    Object.keys(source).forEach(function (key) {
      if (key === VIEW_METADATA_KEY) return;
      result[key] = key === 'signal'
        ? sliceSignalList(source.signal, start, end)
        : cloneValue(source[key]);
    });
    if (!Object.prototype.hasOwnProperty.call(result, 'signal')) result.signal = [];
    return {
      source: result,
      metrics: metrics,
      start: start,
      end: end,
      size: Math.max(0, end - start),
      totalColumns: totalColumns
    };
  }

  function mergeWindowScope(fullScope, windowScope) {
    if (!isObject(windowScope)) return cloneValue(windowScope);
    const result = {};
    if (isObject(fullScope)
        && Array.isArray(fullScope.samples)
        && !Object.prototype.hasOwnProperty.call(windowScope, 'samples')) {
      result.samples = fullScope.samples;
    }
    Object.keys(windowScope).forEach(function (key) {
      result[key] = cloneValue(windowScope[key]);
    });
    return result;
  }

  function copyEditableSignalFields(fullSignal, windowSignal) {
    const result = {};
    Object.keys(fullSignal).forEach(function (key) {
      if (key === 'children') return;
      result[key] = key === 'scope' && isObject(fullSignal.scope)
        ? fullSignal.scope
        : cloneValue(fullSignal[key]);
    });
    Object.keys(result).forEach(function (key) {
      if (key === 'wave' || key === 'node' || key === 'data') return;
      if (!Object.prototype.hasOwnProperty.call(windowSignal, key)) delete result[key];
    });
    Object.keys(windowSignal).forEach(function (key) {
      if (key === 'children' || key === 'wave' || key === 'node' || key === 'data') return;
      result[key] = key === 'scope'
        ? mergeWindowScope(fullSignal.scope, windowSignal.scope)
        : cloneValue(windowSignal[key]);
    });
    return result;
  }

  function mergeWaveFields(result, fullSignal, windowSignal, start, end) {
    const fullWave = typeof fullSignal.wave === 'string' ? fullSignal.wave : '';
    const originalSlice = fullWave.slice(start, end);
    const hasWindowWave = Object.prototype.hasOwnProperty.call(windowSignal, 'wave');
    const windowWave = hasWindowWave && typeof windowSignal.wave === 'string'
      ? windowSignal.wave
      : originalSlice;

    if (hasWindowWave && windowWave.length !== originalSlice.length) {
      const error = new Error('Window wave length cannot change; use full JSON mode for insert/delete');
      error.code = 'WINDOW_WAVE_LENGTH_CHANGED';
      throw error;
    }

    if (Object.prototype.hasOwnProperty.call(fullSignal, 'wave') || hasWindowWave) {
      result.wave = fullWave.slice(0, start) + windowWave + fullWave.slice(end);
    }

    const fullNode = typeof fullSignal.node === 'string' ? fullSignal.node : '';
    const originalNodeSlice = fullNode.slice(start, end);
    if (Object.prototype.hasOwnProperty.call(windowSignal, 'node')) {
      const windowNode = typeof windowSignal.node === 'string' ? windowSignal.node : '';
      if (windowNode.length !== originalNodeSlice.length) {
        const error = new Error('Window node length cannot change; use full JSON mode for insert/delete');
        error.code = 'WINDOW_NODE_LENGTH_CHANGED';
        throw error;
      }
      result.node = fullNode.slice(0, start) + windowNode + fullNode.slice(end);
    } else if (Object.prototype.hasOwnProperty.call(fullSignal, 'node')) {
      result.node = fullNode;
    }

    const mergedWave = typeof result.wave === 'string' ? result.wave : fullWave;
    const fullValues = dataValuesByColumn(fullWave, fullSignal.data, 0);
    const windowValues = dataValuesByColumn(windowWave, windowSignal.data, start);
    const mergedValues = collectDataColumns(mergedWave).map(function (column) {
      if (column >= start && column < end) {
        return windowValues.has(column) ? windowValues.get(column) : '';
      }
      return fullValues.has(column) ? fullValues.get(column) : '';
    });
    if (mergedValues.length) {
      result.data = Array.isArray(fullSignal.data) || Array.isArray(windowSignal.data)
        ? mergedValues
        : mergedValues.join(' ');
    } else {
      delete result.data;
    }
  }

  function mergeSignalObject(fullSignal, windowSignal, start, end) {
    if (!isObject(windowSignal)) throw new Error('Window signal structure does not match the document');
    const result = copyEditableSignalFields(fullSignal, windowSignal);
    mergeWaveFields(result, fullSignal, windowSignal, start, end);
    if (Array.isArray(fullSignal.children) || Array.isArray(windowSignal.children)) {
      result.children = mergeSignalList(
        Array.isArray(fullSignal.children) ? fullSignal.children : [],
        Array.isArray(windowSignal.children) ? windowSignal.children : [],
        start,
        end
      );
    }
    return result;
  }

  function mergeSignalList(fullSignals, windowSignals, start, end) {
    if (!Array.isArray(fullSignals) || !Array.isArray(windowSignals)
        || fullSignals.length !== windowSignals.length) {
      throw new Error('Window signal structure changed; use full JSON mode for row/group changes');
    }
    return fullSignals.map(function (fullSignal, index) {
      const windowSignal = windowSignals[index];
      if (Array.isArray(fullSignal)) {
        if (!Array.isArray(windowSignal) || fullSignal.length !== windowSignal.length) {
          throw new Error('Window group structure changed; use full JSON mode for row/group changes');
        }
        return [cloneValue(windowSignal[0])].concat(
          mergeSignalList(fullSignal.slice(1), windowSignal.slice(1), start, end)
        );
      }
      if (!isObject(fullSignal)) {
        if (JSON.stringify(fullSignal) !== JSON.stringify(windowSignal)) {
          throw new Error('Window signal structure changed; use full JSON mode for row/group changes');
        }
        return cloneValue(fullSignal);
      }
      return mergeSignalObject(fullSignal, windowSignal, start, end);
    });
  }

  function mergeWindowDocument(fullSource, windowSource, expectedWindow) {
    if (!isObject(fullSource) || !isObject(windowSource)) {
      throw new Error('Wave document root must be an object');
    }
    const metadata = windowSource[VIEW_METADATA_KEY];
    if (!isObject(metadata) || metadata.mode !== 'window') {
      throw new Error('Window JSON metadata is missing');
    }
    const expected = expectedWindow || {};
    const start = clampInteger(metadata.start, 0, Math.max(0, Number(metadata.totalColumns) || 0));
    const end = clampInteger(metadata.end, start, Math.max(start, Number(metadata.totalColumns) || start));
    if (Number.isFinite(Number(expected.start)) && start !== Number(expected.start)) {
      throw new Error('Window start changed; refresh the current-window JSON');
    }
    if (Number.isFinite(Number(expected.end)) && end !== Number(expected.end)) {
      throw new Error('Window end changed; refresh the current-window JSON');
    }

    const result = {};
    Object.keys(fullSource).forEach(function (key) {
      if (key !== VIEW_METADATA_KEY && key !== 'signal') result[key] = cloneValue(fullSource[key]);
    });
    Object.keys(result).forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(windowSource, key)) delete result[key];
    });
    Object.keys(windowSource).forEach(function (key) {
      if (key === VIEW_METADATA_KEY || key === 'signal') return;
      result[key] = cloneValue(windowSource[key]);
    });
    result.signal = mergeSignalList(
      Array.isArray(fullSource.signal) ? fullSource.signal : [],
      Array.isArray(windowSource.signal) ? windowSource.signal : [],
      start,
      end
    );
    return {
      source: result,
      start: start,
      end: end,
      totalColumns: Math.max(0, Number(metadata.totalColumns) || 0)
    };
  }

  function summarizeSignalList(signals, rows, groups, path) {
    if (!Array.isArray(signals)) return;
    signals.forEach(function (signal, index) {
      if (Array.isArray(signal)) {
        const label = signal.length ? String(signal[0] == null ? '' : signal[0]) : '';
        const nextPath = path.concat(label);
        groups.push({
          path: nextPath.join(' / '),
          label: label,
          depth: nextPath.length
        });
        summarizeSignalList(signal.slice(1), rows, groups, nextPath);
        return;
      }
      if (!isObject(signal)) return;
      if (isRenderedSignalRow(signal)) {
        rows.push({
          row: rows.length + 1,
          name: typeof signal.name === 'string' ? signal.name : '',
          group: path.join(' / '),
          columns: typeof signal.wave === 'string' ? signal.wave.length : 0,
          dataCells: collectDataColumns(signal.wave).length,
          hasNode: typeof signal.node === 'string' && !!signal.node,
          description: typeof signal.description === 'string' ? signal.description : ''
        });
      }
      if (Array.isArray(signal.children)) {
        summarizeSignalList(signal.children, rows, groups, path.concat('children[' + index + ']'));
      }
    });
  }

  function createSummaryDocument(source, suppliedMetrics) {
    if (!isObject(source)) throw new Error('Wave document root must be an object');
    const metrics = suppliedMetrics || measureSource(source);
    const rows = [];
    const groups = [];
    summarizeSignalList(source.signal, rows, groups, []);
    return {
      source: {
        [VIEW_METADATA_KEY]: {
          mode: 'summary',
          readOnly: true,
          note: '切换到“窗口”或“完整”视图后可编辑'
        },
        title: typeof source.title === 'string' ? source.title : '',
        head: isObject(source.head) ? cloneValue(source.head) : source.head,
        description: typeof source.description === 'string' ? source.description : '',
        metrics: cloneValue(metrics),
        groups: groups,
        signals: rows
      },
      metrics: metrics
    };
  }

  function safeChunkEnd(text, start, requestedEnd) {
    let end = Math.min(text.length, requestedEnd);
    if (end > start && end < text.length) {
      const previous = text.charCodeAt(end - 1);
      const next = text.charCodeAt(end);
      if (previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) {
        end -= 1;
      }
    }
    return end;
  }

  function splitText(text, chunkSize) {
    const value = String(text == null ? '' : text);
    const size = Math.max(256, Math.floor(Number(chunkSize) || DEFAULT_CHUNK_SIZE));
    if (!value) return [''];
    const chunks = [];
    let start = 0;
    while (start < value.length) {
      let end = safeChunkEnd(value, start, start + size);
      if (end <= start) end = Math.min(value.length, start + size);
      chunks.push(value.slice(start, end));
      start = end;
    }
    return chunks;
  }

  class ChunkedText {
    constructor(text, chunkSize) {
      this.chunkSize = Math.max(256, Math.floor(Number(chunkSize) || DEFAULT_CHUNK_SIZE));
      this.chunks = splitText(text, this.chunkSize);
      this.length = String(text == null ? '' : text).length;
    }

    locate(position) {
      const target = clampInteger(position, 0, this.length);
      let offset = 0;
      for (let index = 0; index < this.chunks.length; index += 1) {
        const next = offset + this.chunks[index].length;
        if (target <= next || index === this.chunks.length - 1) {
          return { index: index, offset: target - offset };
        }
        offset = next;
      }
      return { index: 0, offset: 0 };
    }

    slice(start, end) {
      const safeStart = clampInteger(start, 0, this.length);
      const safeEnd = clampInteger(end == null ? this.length : end, safeStart, this.length);
      if (safeStart === safeEnd) return '';
      const startLocation = this.locate(safeStart);
      const endLocation = this.locate(safeEnd);
      if (startLocation.index === endLocation.index) {
        return this.chunks[startLocation.index].slice(startLocation.offset, endLocation.offset);
      }
      const pieces = [this.chunks[startLocation.index].slice(startLocation.offset)];
      for (let index = startLocation.index + 1; index < endLocation.index; index += 1) {
        pieces.push(this.chunks[index]);
      }
      pieces.push(this.chunks[endLocation.index].slice(0, endLocation.offset));
      return pieces.join('');
    }

    replace(start, end, insertedText) {
      const safeStart = clampInteger(start, 0, this.length);
      const safeEnd = clampInteger(end, safeStart, this.length);
      const inserted = String(insertedText == null ? '' : insertedText);
      const startLocation = this.locate(safeStart);
      const endLocation = this.locate(safeEnd);
      const prefix = this.chunks[startLocation.index].slice(0, startLocation.offset);
      const suffix = this.chunks[endLocation.index].slice(endLocation.offset);
      const replacement = splitText(prefix + inserted + suffix, this.chunkSize);
      this.chunks.splice(
        startLocation.index,
        endLocation.index - startLocation.index + 1,
        ...replacement
      );
      this.length += inserted.length - (safeEnd - safeStart);
      if (!this.chunks.length) this.chunks = [''];
      return this;
    }

    toString() {
      return this.chunks.join('');
    }
  }

  function createReverseOperationPatch(operations, finalLength, initialLength) {
    const list = Array.isArray(operations) ? operations : [];
    const steps = [];
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const operation = list[index] || {};
      steps.push({
        start: Math.max(0, Math.floor(Number(operation.start) || 0)),
        deleteText: String(operation.inserted == null ? '' : operation.inserted),
        insertText: String(operation.removed == null ? '' : operation.removed)
      });
    }
    return {
      sourceLength: Math.max(0, Number(finalLength) || 0),
      targetLength: Math.max(0, Number(initialLength) || 0),
      steps: steps
    };
  }

  function invertOperationPatch(patch) {
    if (!patch || !Array.isArray(patch.steps)) return null;
    const steps = [];
    for (let index = patch.steps.length - 1; index >= 0; index -= 1) {
      const step = patch.steps[index];
      steps.push({
        start: step.start,
        deleteText: String(step.insertText || ''),
        insertText: String(step.deleteText || '')
      });
    }
    return {
      sourceLength: Number(patch.targetLength) || 0,
      targetLength: Number(patch.sourceLength) || 0,
      steps: steps
    };
  }

  function applyOperationPatch(sourceContent, patch) {
    const source = String(sourceContent == null ? '' : sourceContent);
    if (!patch || !Array.isArray(patch.steps) || source.length !== Number(patch.sourceLength)) {
      return null;
    }
    const useChunks = source.length >= PATCH_CHUNK_THRESHOLD || patch.steps.length > 8;
    let value = useChunks ? new ChunkedText(source) : source;
    for (let index = 0; index < patch.steps.length; index += 1) {
      const step = patch.steps[index];
      const start = Math.max(0, Math.floor(Number(step.start) || 0));
      const deleteText = String(step.deleteText == null ? '' : step.deleteText);
      const insertText = String(step.insertText == null ? '' : step.insertText);
      const actual = useChunks
        ? value.slice(start, start + deleteText.length)
        : value.slice(start, start + deleteText.length);
      if (actual !== deleteText) return null;
      if (useChunks) {
        value.replace(start, start + deleteText.length, insertText);
      } else {
        value = value.slice(0, start) + insertText + value.slice(start + deleteText.length);
      }
    }
    const result = useChunks ? value.toString() : value;
    return result.length === Number(patch.targetLength) ? result : null;
  }

  return {
    version: '1.0.0',
    VIEW_METADATA_KEY: VIEW_METADATA_KEY,
    ChunkedText: ChunkedText,
    applyOperationPatch: applyOperationPatch,
    createReverseOperationPatch: createReverseOperationPatch,
    createSummaryDocument: createSummaryDocument,
    createWindowDocument: createWindowDocument,
    invertOperationPatch: invertOperationPatch,
    measureSource: measureSource,
    mergeWindowDocument: mergeWindowDocument,
    splitText: splitText
  };
}));

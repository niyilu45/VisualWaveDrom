(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VisualWaveDromBigData = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DATA_TOKEN_RE = /[2-9=]/;

  function clampInteger(value, minimum, maximum) {
    const number = Number.isFinite(Number(value)) ? Math.floor(Number(value)) : minimum;
    return Math.max(minimum, Math.min(maximum, number));
  }

  function isSignalObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function getWaveLength(signal) {
    return isSignalObject(signal) && typeof signal.wave === 'string' ? signal.wave.length : 0;
  }

  function isRenderedSignalRow(signal) {
    if (!isSignalObject(signal)) return false;
    const hasChildren = Array.isArray(signal.children);
    const hasSignalField = ['name', 'wave', 'node', 'data', 'period', 'phase'].some(function (key) {
      return Object.prototype.hasOwnProperty.call(signal, key);
    });
    return !hasChildren || hasSignalField;
  }

  function measureSignals(signals, metrics) {
    if (!Array.isArray(signals)) return metrics;
    signals.forEach(function (signal) {
      if (Array.isArray(signal)) {
        metrics.groupCount += 1;
        measureSignals(signal.slice(1), metrics);
        return;
      }
      if (!isSignalObject(signal)) return;
      if (isRenderedSignalRow(signal)) {
        const waveLength = getWaveLength(signal);
        metrics.signalCount += 1;
        metrics.cellCount += waveLength;
        metrics.maxWaveLength = Math.max(metrics.maxWaveLength, waveLength);
      }
      if (Array.isArray(signal.children)) measureSignals(signal.children, metrics);
    });
    return metrics;
  }

  function measureSource(source) {
    return measureSignals(source && source.signal, {
      signalCount: 0,
      groupCount: 0,
      maxWaveLength: 0,
      cellCount: 0,
      edgeCount: source && Array.isArray(source.edge) ? source.edge.length : 0
    });
  }

  function collectDataSlots(wave) {
    const slots = [];
    const value = String(wave || '');
    for (let column = 0; column < value.length; column += 1) {
      if (DATA_TOKEN_RE.test(value[column])) {
        slots.push({ dataIndex: slots.length, column: column, token: value[column] });
      }
    }
    return slots;
  }

  function normalizeDataValues(data) {
    if (Array.isArray(data)) return data.slice();
    if (typeof data !== 'string' || !data.trim()) return [];
    return data.trim().split(/\s+/);
  }

  function isSampleSequence(value) {
    return Array.isArray(value) || (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value));
  }

  function sequenceValueAt(values, index) {
    if (!isSampleSequence(values) || index < 0 || index >= values.length) return undefined;
    let value = values[index];
    if (typeof value !== 'string' || value.trim() !== '.') return value;
    for (let previous = index - 1; previous >= 0; previous -= 1) {
      value = values[previous];
      if (typeof value !== 'string' || value.trim() !== '.') return value;
    }
    return undefined;
  }

  function changePointValueAt(changePoints, index) {
    if (!changePoints || !Array.isArray(changePoints.indices)
        || !Array.isArray(changePoints.values)) return undefined;
    let low = 0;
    let high = Math.min(changePoints.indices.length, changePoints.values.length);
    while (low < high) {
      const middle = (low + high) >> 1;
      if (Number(changePoints.indices[middle]) <= index) low = middle + 1;
      else high = middle;
    }
    return low > 0 ? changePoints.values[low - 1] : 'x';
  }

  function scopeValueAtColumn(signal, column) {
    const scope = signal && signal.scope && typeof signal.scope === 'object'
      && !Array.isArray(signal.scope) ? signal.scope : null;
    if (!scope) return undefined;
    const step = Number(scope.sampleStep) > 0 ? Number(scope.sampleStep) : 1;
    const sampleIndex = Math.max(0, Math.floor(Number(column) / step + 1e-9));
    if (isSampleSequence(scope.values)) return sequenceValueAt(scope.values, sampleIndex);
    if (isSampleSequence(scope.samples)) return sequenceValueAt(scope.samples, sampleIndex);
    if (scope.changePoints && typeof scope.changePoints === 'object') {
      return changePointValueAt(scope.changePoints, sampleIndex);
    }
    return undefined;
  }

  function scopeDataLabel(signal, column) {
    const value = scopeValueAtColumn(signal, column);
    if (value === undefined) return null;
    let text = value == null || value === '' || (typeof value === 'number' && !Number.isFinite(value))
      ? 'x'
      : String(value);
    const scope = signal && signal.scope && typeof signal.scope === 'object' ? signal.scope : null;
    const table = scope && scope.tbl && typeof scope.tbl === 'object' && !Array.isArray(scope.tbl)
      ? scope.tbl : null;
    if (table && Object.prototype.hasOwnProperty.call(table, text)) {
      text += ':' + String(table[text]);
    }
    return text;
  }

  function dataLabelsFromScope(signal, renderedWave, start) {
    const labels = [];
    let found = false;
    for (let localColumn = 0; localColumn < renderedWave.length; localColumn += 1) {
      if (!DATA_TOKEN_RE.test(renderedWave[localColumn])) continue;
      const label = scopeDataLabel(signal, start + localColumn);
      labels.push(label == null ? '' : label);
      if (label != null) found = true;
    }
    return found ? labels : null;
  }

  function findContinuationSource(wave, column) {
    const value = String(wave || '');
    for (let index = Math.min(column, value.length - 1); index >= 0; index -= 1) {
      const token = value[index];
      if (token !== '.' && token !== '|') return { token: token, column: index };
    }
    return null;
  }

  function getDataIndexAtColumn(slots, column) {
    for (let index = 0; index < slots.length; index += 1) {
      if (slots[index].column === column) return slots[index].dataIndex;
    }
    return -1;
  }

  function sliceWave(signal, start, end) {
    const fullWave = typeof signal.wave === 'string' ? signal.wave : '';
    const slots = collectDataSlots(fullWave);
    let renderedWave = fullWave.slice(start, end);
    const dataIndices = [];

    if (renderedWave[0] === '.') {
      const continuation = findContinuationSource(fullWave, start);
      if (continuation && continuation.token) {
        renderedWave = continuation.token + renderedWave.slice(1);
        if (DATA_TOKEN_RE.test(continuation.token)) {
          const continuationDataIndex = getDataIndexAtColumn(slots, continuation.column);
          if (continuationDataIndex >= 0) dataIndices.push(continuationDataIndex);
        }
      }
    }

    slots.forEach(function (slot) {
      if (slot.column >= start && slot.column < end && !dataIndices.includes(slot.dataIndex)) {
        dataIndices.push(slot.dataIndex);
      }
    });

    return {
      fullWave: fullWave,
      wave: renderedWave,
      dataIndices: dataIndices
    };
  }

  function sliceSignalObject(signal, start, end, rows) {
    const copy = Object.assign({}, signal);
    const waveSlice = sliceWave(signal, start, end);
    if (signal.scope && typeof signal.scope === 'object' && !Array.isArray(signal.scope)
        && Array.isArray(signal.scope.samples)) {
      copy.scope = Object.assign({}, signal.scope);
      delete copy.scope.samples;
    }

    if (Object.prototype.hasOwnProperty.call(signal, 'wave')) {
      copy.wave = waveSlice.wave;
    }
    if (typeof signal.node === 'string') {
      copy.node = signal.node.slice(start, end);
    }
    if (Array.isArray(signal.data) || typeof signal.data === 'string') {
      const dataValues = normalizeDataValues(signal.data);
      copy.data = waveSlice.dataIndices.map(function (dataIndex) {
        return dataValues[dataIndex] === undefined ? '' : dataValues[dataIndex];
      });
    } else {
      const generatedData = dataLabelsFromScope(signal, waveSlice.wave, start);
      if (generatedData) copy.data = generatedData;
    }

    if (isRenderedSignalRow(signal)) {
      rows.push({
        start: start,
        end: end,
        fullWave: waveSlice.fullWave,
        wave: waveSlice.wave,
        dataIndices: waveSlice.dataIndices,
        fullNode: typeof signal.node === 'string' ? signal.node : '',
        signal: copy
      });
    }

    if (Array.isArray(signal.children)) {
      copy.children = sliceSignalList(signal.children, start, end, rows);
    }
    return copy;
  }

  function sliceSignalList(signals, start, end, rows) {
    if (!Array.isArray(signals)) return signals;
    return signals.map(function (signal) {
      if (Array.isArray(signal)) {
        const label = signal.length ? signal[0] : '';
        return [label].concat(sliceSignalList(signal.slice(1), start, end, rows));
      }
      if (!isSignalObject(signal)) return signal;
      return sliceSignalObject(signal, start, end, rows);
    });
  }

  function parseEdgeEndpoints(edge) {
    const firstWord = String(edge || '').trim().split(/\s+/)[0] || '';
    const ids = [];
    for (let index = 0; index < firstWord.length; index += 1) {
      if (/[a-zA-Z0-9]/.test(firstWord[index])) ids.push(firstWord[index]);
    }
    return {
      from: ids[0] || '',
      to: ids.length > 1 ? ids[ids.length - 1] : ''
    };
  }

  function collectNodePositions(rows) {
    const positions = new Map();
    rows.forEach(function (row, rowIndex) {
      const node = String(row.fullNode || '');
      for (let column = 0; column < node.length; column += 1) {
        if (/[a-zA-Z0-9]/.test(node[column]) && !positions.has(node[column])) {
          positions.set(node[column], { row: row, rowIndex: rowIndex, column: column });
        }
      }
    });
    return positions;
  }

  function placeBoundaryNode(position, nodeId, start, end) {
    if (!position || !position.row || !position.row.signal || end <= start) return false;
    const row = position.row;
    const size = end - start;
    const fromLeft = position.column < start;
    let node = String(row.signal.node || '').padEnd(size, '.').slice(0, size);
    for (let offset = 0; offset < size; offset += 1) {
      const column = fromLeft ? offset : size - 1 - offset;
      if (node[column] !== '.' && node[column] !== nodeId) continue;
      node = node.slice(0, column) + nodeId + node.slice(column + 1);
      row.signal.node = node;
      return true;
    }
    return false;
  }

  function sliceEdges(source, renderedSource, rows, start, end) {
    if (!Array.isArray(source.edge)) return { edgeIndexes: [], crossingEdges: [] };
    const nodePositions = collectNodePositions(rows);
    const edges = [];
    const edgeOptions = [];
    const edgeIndexes = [];
    const crossingEdges = [];

    source.edge.forEach(function (edge, index) {
      const endpoints = parseEdgeEndpoints(edge);
      const fromPosition = nodePositions.get(endpoints.from);
      const toPosition = nodePositions.get(endpoints.to);
      const fromVisible = !!fromPosition
        && fromPosition.column >= start
        && fromPosition.column < end;
      const toVisible = !!toPosition
        && toPosition.column >= start
        && toPosition.column < end;
      const spansWindow = !!fromPosition && !!toPosition && (
        (fromPosition.column < start && toPosition.column >= end)
        || (toPosition.column < start && fromPosition.column >= end)
      );
      const intersectsWindow = fromVisible || toVisible || spansWindow;
      let fromReady = fromVisible;
      let toReady = toVisible;
      if (intersectsWindow && !fromVisible) {
        fromReady = placeBoundaryNode(fromPosition, endpoints.from, start, end);
      }
      if (intersectsWindow && !toVisible) {
        toReady = placeBoundaryNode(toPosition, endpoints.to, start, end);
      }
      if (fromReady && toReady) {
        edges.push(edge);
        edgeIndexes.push(index);
        if (Array.isArray(source.edgeOptions)) edgeOptions.push(source.edgeOptions[index] || null);
      }
      if (intersectsWindow && (!fromVisible || !toVisible)) {
        crossingEdges.push({
          index: index,
          from: endpoints.from,
          to: endpoints.to,
          fromVisible: fromVisible,
          toVisible: toVisible
        });
      }
    });

    if (edges.length) renderedSource.edge = edges;
    else delete renderedSource.edge;
    if (edgeOptions.some(Boolean)) renderedSource.edgeOptions = edgeOptions;
    else delete renderedSource.edgeOptions;
    return { edgeIndexes: edgeIndexes, crossingEdges: crossingEdges };
  }

  function adjustColumnNumbers(source, renderedSource, start) {
    if (!source.head || typeof source.head !== 'object' || Array.isArray(source.head)) return;
    const head = Object.assign({}, source.head);
    if (typeof head.tick === 'number' && Number.isFinite(head.tick)) head.tick += start;
    if (typeof head.tock === 'number' && Number.isFinite(head.tock)) head.tock += start;
    renderedSource.head = head;
  }

  function createRenderWindow(source, options) {
    const opts = options || {};
    const metrics = opts.metrics || measureSource(source);
    const totalColumns = Math.max(0, Number(metrics.maxWaveLength) || 0);
    const requestedSize = Math.max(1, Math.floor(Number(opts.size) || 1));
    const size = Math.min(requestedSize, Math.max(1, totalColumns));
    const maxStart = Math.max(0, totalColumns - size);
    const start = clampInteger(opts.start, 0, maxStart);
    const end = Math.min(totalColumns, start + size);
    const rows = [];
    const renderedSource = Object.assign({}, source);

    renderedSource.signal = sliceSignalList(source && source.signal, start, end, rows);
    adjustColumnNumbers(source || {}, renderedSource, start);
    const edgeMeta = sliceEdges(source || {}, renderedSource, rows, start, end);

    return {
      source: renderedSource,
      metrics: metrics,
      rows: rows,
      start: start,
      end: end,
      size: Math.max(0, end - start),
      totalColumns: totalColumns,
      maxStart: maxStart,
      edgeIndexes: edgeMeta.edgeIndexes,
      crossingEdges: edgeMeta.crossingEdges
    };
  }

  return {
    version: '1.0.0',
    measureSource: measureSource,
    collectDataSlots: collectDataSlots,
    createRenderWindow: createRenderWindow
  };
}));

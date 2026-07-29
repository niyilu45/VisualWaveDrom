(function (global) {
'use strict';

let activeSession = null;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function flattenSignals(signals, rows, path, groups) {
  const result = rows || [];
  const basePath = path || [];
  const groupStack = groups || [];
  if (!Array.isArray(signals)) return result;
  signals.forEach((entry, index) => {
    const entryPath = basePath.concat(index);
    if (Array.isArray(entry)) {
      const label = String(entry[0] == null ? '' : entry[0]);
      flattenSignals(entry.slice(1), result, entryPath.concat('group'), groupStack.concat(label));
      return;
    }
    if (!entry || typeof entry !== 'object') return;
    result.push({
      source: entry,
      path: entryPath,
      groups: groupStack.slice(),
      name: String(entry.name == null ? '' : entry.name)
    });
    if (Array.isArray(entry.children)) {
      flattenSignals(entry.children, result, entryPath.concat('children'), groupStack);
    }
  });
  return result;
}

function getScopeSignalConfig(source, row, rowIndex) {
  const topScope = source && source.scope && typeof source.scope === 'object'
    ? source.scope
    : null;
  const signals = topScope && topScope.signals && typeof topScope.signals === 'object'
    ? topScope.signals
    : null;
  if (!signals) return null;
  return signals[row.name] || signals[String(rowIndex)] || null;
}

function getAnalogSamples(source, row, rowIndex) {
  const signal = row.source || {};
  const localScope = signal.scope && typeof signal.scope === 'object' ? signal.scope : null;
  const globalScope = getScopeSignalConfig(source, row, rowIndex);
  const candidate = localScope && Array.isArray(localScope.samples)
    ? localScope.samples
    : (Array.isArray(signal.samples)
      ? signal.samples
      : (globalScope && Array.isArray(globalScope.samples) ? globalScope.samples : null));
  if (!candidate) return null;
  const values = new Float64Array(candidate.length);
  let validCount = 0;
  for (let index = 0; index < candidate.length; index += 1) {
    const value = finiteNumber(candidate[index]);
    values[index] = value == null ? Number.NaN : value;
    if (value != null) validCount += 1;
  }
  return validCount ? values : null;
}

function stateKind(character) {
  if (/[2-9=]/.test(character)) return 'bus';
  return 'digital';
}

function normalizedDigitalState(character, previous) {
  const value = String(character || '').toLowerCase();
  if (value === '1' || value === 'h') return '1';
  if (value === '0' || value === 'l') return '0';
  if (value === 'z') return 'z';
  if (value === 'x') return 'x';
  return previous || 'x';
}

function pushSegment(segments, segment) {
  if (!(segment.end > segment.start)) return;
  const last = segments[segments.length - 1];
  if (last
      && Math.abs(last.end - segment.start) < 1e-9
      && last.kind === segment.kind
      && last.value === segment.value
      && last.state === segment.state) {
    last.end = segment.end;
    return;
  }
  segments.push(segment);
}

function parseWaveSegments(signal) {
  const wave = String(signal.wave || '');
  const labels = Array.isArray(signal.data) ? signal.data.map((value) => String(value)) : [];
  const segments = [];
  const transitions = [];
  let dataIndex = 0;
  let current = { kind: 'digital', state: 'x', value: 'x' };
  let clockMode = '';

  function emit(start, end, next) {
    if (!segments.length
        || current.kind !== next.kind
        || current.state !== next.state
        || current.value !== next.value) {
      transitions.push(start);
    }
    current = next;
    pushSegment(segments, {
      start,
      end,
      kind: next.kind,
      state: next.state,
      value: next.value
    });
  }

  for (let column = 0; column < wave.length; column += 1) {
    const character = wave[column];
    const lower = character.toLowerCase();
    if ((character === '.' || character === '|' || character === ' ') && clockMode) {
      const first = clockMode === 'p' ? '0' : '1';
      const second = clockMode === 'p' ? '1' : '0';
      emit(column, column + 0.5, { kind: 'digital', state: first, value: first });
      emit(column + 0.5, column + 1, { kind: 'digital', state: second, value: second });
      continue;
    }
    if (character === '.' || character === ' ' || character === '|') {
      emit(column, column + 1, current);
      continue;
    }
    if (lower === 'p' || lower === 'n') {
      clockMode = lower;
      const first = lower === 'p' ? '0' : '1';
      const second = lower === 'p' ? '1' : '0';
      emit(column, column + 0.5, { kind: 'digital', state: first, value: first });
      emit(column + 0.5, column + 1, { kind: 'digital', state: second, value: second });
      continue;
    }
    clockMode = '';
    if (stateKind(character) === 'bus') {
      const label = labels[dataIndex] == null ? character : labels[dataIndex];
      dataIndex += 1;
      emit(column, column + 1, { kind: 'bus', state: 'bus', value: label });
      continue;
    }
    const state = normalizedDigitalState(character, current.state);
    emit(column, column + 1, { kind: 'digital', state, value: state });
  }

  if (!segments.length) {
    segments.push({ start: 0, end: 1, kind: 'digital', state: 'x', value: 'x' });
  }
  return { wave, segments, transitions };
}

function buildAnalogLevels(samples) {
  const levels = [];
  if (!samples || !samples.length) return levels;
  let mins = new Float64Array(samples.length);
  let maxs = new Float64Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    mins[index] = samples[index];
    maxs[index] = samples[index];
  }
  levels.push({ size: 1, mins, maxs });
  let size = 1;
  while (mins.length > 1024) {
    const length = Math.ceil(mins.length / 2);
    const nextMins = new Float64Array(length);
    const nextMaxs = new Float64Array(length);
    for (let index = 0; index < length; index += 1) {
      const left = index * 2;
      const right = left + 1;
      const aMin = mins[left];
      const aMax = maxs[left];
      const bMin = right < mins.length ? mins[right] : aMin;
      const bMax = right < maxs.length ? maxs[right] : aMax;
      nextMins[index] = Number.isNaN(aMin) ? bMin
        : (Number.isNaN(bMin) ? aMin : Math.min(aMin, bMin));
      nextMaxs[index] = Number.isNaN(aMax) ? bMax
        : (Number.isNaN(bMax) ? aMax : Math.max(aMax, bMax));
    }
    size *= 2;
    levels.push({ size, mins: nextMins, maxs: nextMaxs });
    mins = nextMins;
    maxs = nextMaxs;
  }
  return levels;
}

function analogRange(samples) {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index];
    if (!Number.isFinite(value)) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: -1, max: 1 };
  if (Math.abs(max - min) < 1e-12) {
    const padding = Math.max(1, Math.abs(max) * 0.1);
    return { min: min - padding, max: max + padding };
  }
  return { min, max };
}

function createSession(content) {
  const source = JSON.parse(String(content || '{}'));
  const flat = flattenSignals(source.signal, []);
  let totalColumns = 1;
  const rows = flat.map((row, rowIndex) => {
    const parsedWave = parseWaveSegments(row.source);
    const analogSamples = getAnalogSamples(source, row, rowIndex);
    const requestedMode = row.source.scope && row.source.scope.mode
      ? String(row.source.scope.mode)
      : '';
    const detectedMode = analogSamples
      ? 'analog'
      : (parsedWave.segments.some((segment) => segment.kind === 'bus') ? 'bus' : 'digital');
    const mode = /^(digital|bus|analog)$/.test(requestedMode) ? requestedMode : detectedMode;
    const rowColumns = Math.max(
      parsedWave.wave.length,
      analogSamples ? analogSamples.length : 0,
      1
    );
    totalColumns = Math.max(totalColumns, rowColumns);
    return {
      index: rowIndex,
      source: row.source,
      path: row.path,
      groups: row.groups,
      name: row.name || ('signal_' + (rowIndex + 1)),
      mode,
      detectedMode,
      wave: parsedWave.wave,
      segments: parsedWave.segments,
      transitions: parsedWave.transitions,
      samples: analogSamples,
      analogLevels: analogSamples ? buildAnalogLevels(analogSamples) : [],
      range: analogSamples ? analogRange(analogSamples) : null,
      unit: String(
        (row.source.scope && row.source.scope.unit)
        || row.source.unit
        || ''
      )
    };
  });
  const scope = source.scope && typeof source.scope === 'object' ? source.scope : {};
  const samplePeriod = finiteNumber(scope.samplePeriod) || 1;
  const timeUnit = String(scope.timeUnit || 'cycle');
  return {
    source,
    rows,
    totalColumns,
    samplePeriod,
    timeUnit,
    title: String(
      source.title
      || (source.head && source.head.text)
      || 'Untitled waveform'
    )
  };
}

function findFirstSegment(segments, position) {
  let low = 0;
  let high = segments.length - 1;
  let answer = segments.length;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (segments[middle].end > position) {
      answer = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return answer;
}

function rowSegmentsInWindow(row, start, end, width) {
  const first = findFirstSegment(row.segments, start);
  const selected = [];
  for (let index = first; index < row.segments.length; index += 1) {
    const segment = row.segments[index];
    if (segment.start >= end) break;
    selected.push({
      start: Math.max(start, segment.start),
      end: Math.min(end, segment.end),
      kind: segment.kind,
      state: segment.state,
      value: segment.value
    });
  }
  if (selected.length <= Math.max(64, width * 4)) {
    return { kind: 'segments', items: selected };
  }

  const bucketCount = Math.max(1, Math.floor(width));
  const span = end - start;
  const buckets = [];
  let segmentIndex = 0;
  for (let pixel = 0; pixel < bucketCount; pixel += 1) {
    const bucketStart = start + span * pixel / bucketCount;
    const bucketEnd = start + span * (pixel + 1) / bucketCount;
    while (segmentIndex < selected.length && selected[segmentIndex].end <= bucketStart) {
      segmentIndex += 1;
    }
    let cursor = segmentIndex;
    let high = false;
    let low = false;
    let unknown = false;
    let bus = false;
    let value = '';
    let changes = 0;
    while (cursor < selected.length && selected[cursor].start < bucketEnd) {
      const segment = selected[cursor];
      if (segment.kind === 'bus') {
        bus = true;
        if (!value) value = segment.value;
        else if (value !== segment.value) value = '*';
      } else if (segment.state === '1') high = true;
      else if (segment.state === '0') low = true;
      else unknown = true;
      changes += 1;
      cursor += 1;
    }
    buckets.push({
      start: bucketStart,
      end: bucketEnd,
      high,
      low,
      unknown,
      bus,
      value,
      changes
    });
  }
  return { kind: 'buckets', items: buckets };
}

function sampleIndexForColumn(row, column, totalColumns) {
  if (!row.samples || !row.samples.length) return 0;
  if (totalColumns <= 1 || row.samples.length <= 1) return 0;
  return clamp(
    Math.round(column * (row.samples.length - 1) / (totalColumns - 1)),
    0,
    row.samples.length - 1
  );
}

function analogWindow(row, start, end, width, totalColumns) {
  const startIndex = sampleIndexForColumn(row, start, totalColumns);
  const endIndex = Math.max(
    startIndex + 1,
    sampleIndexForColumn(row, end, totalColumns) + 1
  );
  const sampleSpan = Math.max(1, endIndex - startIndex);
  if (sampleSpan <= Math.max(64, width * 2)) {
    const points = [];
    for (let index = startIndex; index < endIndex && index < row.samples.length; index += 1) {
      const value = row.samples[index];
      if (!Number.isFinite(value)) continue;
      const column = row.samples.length <= 1
        ? 0
        : index * (totalColumns - 1) / (row.samples.length - 1);
      points.push([column, value]);
    }
    return { kind: 'points', items: points, range: row.range };
  }

  const samplesPerPixel = sampleSpan / Math.max(1, width);
  let level = row.analogLevels[0];
  for (let index = 1; index < row.analogLevels.length; index += 1) {
    if (row.analogLevels[index].size > samplesPerPixel * 2) break;
    level = row.analogLevels[index];
  }
  const firstBucket = Math.floor(startIndex / level.size);
  const lastBucket = Math.min(level.mins.length, Math.ceil(endIndex / level.size));
  const items = [];
  for (let index = firstBucket; index < lastBucket; index += 1) {
    const min = level.mins[index];
    const max = level.maxs[index];
    if (!Number.isFinite(min) && !Number.isFinite(max)) continue;
    const sampleIndex = index * level.size;
    const column = row.samples.length <= 1
      ? 0
      : sampleIndex * (totalColumns - 1) / (row.samples.length - 1);
    items.push([column, min, max]);
  }
  return { kind: 'envelope', items, range: row.range };
}

function createWindow(payload) {
  if (!activeSession) throw new Error('Scope session has not been prepared');
  const total = activeSession.totalColumns;
  const start = clamp(finiteNumber(payload.start) || 0, 0, Math.max(0, total - 1));
  const end = clamp(finiteNumber(payload.end) || total, start + 1e-6, total);
  const width = clamp(Math.floor(finiteNumber(payload.width) || 1000), 32, 8192);
  const rowStart = clamp(Math.floor(finiteNumber(payload.rowStart) || 0), 0, activeSession.rows.length);
  const rowEnd = clamp(
    Math.ceil(finiteNumber(payload.rowEnd) || activeSession.rows.length),
    rowStart,
    activeSession.rows.length
  );
  const rows = [];
  for (let index = rowStart; index < rowEnd; index += 1) {
    const row = activeSession.rows[index];
    const mode = payload.modes && payload.modes[index] || row.mode;
    const data = mode === 'analog' && row.samples
      ? analogWindow(row, start, end, width, total)
      : rowSegmentsInWindow(row, start, end, width);
    rows.push({ index, mode, data });
  }
  return { start, end, width, rowStart, rowEnd, rows };
}

function segmentAt(row, column) {
  const index = findFirstSegment(row.segments, column);
  if (index >= row.segments.length) return row.segments[row.segments.length - 1];
  return row.segments[index];
}

function lttbIndexes(samples, threshold) {
  const length = samples ? samples.length : 0;
  if (!length) return [];
  if (threshold >= length || threshold <= 2) {
    return threshold <= 1 ? [0] : [0, length - 1];
  }
  const sampled = [0];
  const every = (length - 2) / (threshold - 2);
  let a = 0;
  for (let bucket = 0; bucket < threshold - 2; bucket += 1) {
    const avgStart = Math.floor((bucket + 1) * every) + 1;
    const avgEnd = Math.min(length, Math.floor((bucket + 2) * every) + 1);
    let avgX = 0;
    let avgY = 0;
    let avgCount = 0;
    for (let index = avgStart; index < avgEnd; index += 1) {
      if (!Number.isFinite(samples[index])) continue;
      avgX += index;
      avgY += samples[index];
      avgCount += 1;
    }
    if (!avgCount) {
      avgX = (avgStart + avgEnd - 1) / 2;
      avgY = Number.isFinite(samples[a]) ? samples[a] : 0;
      avgCount = 1;
    }
    avgX /= avgCount;
    avgY /= avgCount;

    const rangeStart = Math.floor(bucket * every) + 1;
    const rangeEnd = Math.min(length - 1, Math.floor((bucket + 1) * every) + 1);
    const pointAX = a;
    const pointAY = Number.isFinite(samples[a]) ? samples[a] : 0;
    let maxArea = -1;
    let nextA = rangeStart;
    for (let index = rangeStart; index < rangeEnd; index += 1) {
      const pointY = Number.isFinite(samples[index]) ? samples[index] : pointAY;
      const area = Math.abs(
        (pointAX - avgX) * (pointY - pointAY)
        - (pointAX - index) * (avgY - pointAY)
      );
      if (area > maxArea) {
        maxArea = area;
        nextA = index;
      }
    }
    sampled.push(nextA);
    a = nextA;
  }
  sampled.push(length - 1);
  return sampled;
}

function chooseColumns(targetPoints, lockedColumns, method, requestedStart, requestedEnd) {
  const total = activeSession.totalColumns;
  const rangeStart = clamp(Math.floor(finiteNumber(requestedStart) || 0), 0, Math.max(0, total - 1));
  const rangeEnd = clamp(
    Math.ceil(finiteNumber(requestedEnd) || total),
    rangeStart + 1,
    total
  );
  const rangeLength = rangeEnd - rangeStart;
  const target = clamp(Math.floor(targetPoints || 100), 2, Math.max(2, rangeLength));
  if (target >= rangeLength) {
    return Array.from({ length: rangeLength }, (_value, index) => rangeStart + index);
  }
  const selectedMethod = String(method || 'event-preserving');
  const includeTransitions = selectedMethod === 'event-preserving' || selectedMethod === 'transitions';
  const includeAnalog = selectedMethod === 'event-preserving' || selectedMethod === 'lttb';
  const scores = new Map();
  function add(column, score) {
    const value = clamp(Math.round(column), rangeStart, rangeEnd - 1);
    scores.set(value, Math.max(scores.get(value) || 0, score));
  }
  add(rangeStart, 10000);
  add(rangeEnd - 1, 10000);
  (lockedColumns || []).forEach((column) => {
    if (column >= rangeStart && column < rangeEnd) add(column, 20000);
  });

  const rowBudget = Math.max(8, Math.floor(target / Math.max(1, activeSession.rows.length)));
  activeSession.rows.forEach((row) => {
    if (includeTransitions) {
      row.transitions.forEach((column) => {
        if (column < rangeStart || column >= rangeEnd) return;
        const segment = segmentAt(row, column + 1e-7);
        add(column, segment && segment.kind === 'bus' ? 850 : 1000);
      });
    }
    if (includeAnalog && row.samples) {
      lttbIndexes(row.samples, Math.min(row.samples.length, rowBudget)).forEach((sampleIndex) => {
        const column = row.samples.length <= 1
          ? 0
          : sampleIndex * (total - 1) / (row.samples.length - 1);
        if (column >= rangeStart && column < rangeEnd) add(column, 700);
      });
    }
  });

  const uniformCount = Math.max(2, Math.floor(target * 0.45));
  for (let index = 0; index < uniformCount; index += 1) {
    add(rangeStart + index * (rangeLength - 1) / Math.max(1, uniformCount - 1), 300);
  }

  let selected = Array.from(scores.entries())
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])
    .slice(0, target)
    .map((entry) => entry[0]);
  const selectedSet = new Set(selected);
  for (let index = 0; selected.length < target && index < target * 4; index += 1) {
    const column = Math.round(
      rangeStart + index * (rangeLength - 1) / Math.max(1, target * 4 - 1)
    );
    if (selectedSet.has(column)) continue;
    selectedSet.add(column);
    selected.push(column);
  }
  selected = Array.from(new Set(selected)).sort((left, right) => left - right);
  return selected.slice(0, target);
}

function stateAtColumn(row, column, mode) {
  if (mode === 'analog' && row.samples) {
    const index = sampleIndexForColumn(row, column, activeSession.totalColumns);
    const value = row.samples[index];
    return Number.isFinite(value) ? value : null;
  }
  const segment = segmentAt(row, column + 1e-7);
  if (!segment) return mode === 'bus' ? '' : 'x';
  if (mode === 'bus') return String(segment.value == null ? '' : segment.value);
  return normalizedDigitalState(segment.state, 'x');
}

function signalAtPath(source, path) {
  let cursor = source.signal;
  for (let index = 0; index < path.length; index += 1) {
    const part = path[index];
    if (part === 'group') {
      cursor = Array.isArray(cursor) ? cursor.slice(1) : cursor;
      continue;
    }
    if (part === 'children') {
      cursor = cursor.children;
      continue;
    }
    cursor = cursor[part];
    if (Array.isArray(cursor) && path[index + 1] === 'group') {
      cursor = cursor.slice(1);
      index += 1;
    }
  }
  return cursor;
}

function buildWaveFromValues(mode, values, labels) {
  if (!values.length) return { wave: '' };
  if (mode === 'analog') {
    const data = [];
    let wave = '';
    let previous = null;
    values.forEach((rawValue) => {
      const value = rawValue == null ? '' : String(Math.round(Number(rawValue) * 1000000) / 1000000);
      if (value === previous) {
        wave += '.';
      } else {
        wave += '=';
        data.push(value);
        previous = value;
      }
    });
    return { wave, data };
  }
  if (mode === 'bus') {
    const data = [];
    let wave = '';
    let previous = null;
    values.forEach((rawValue, index) => {
      const value = labels && labels[index] != null ? String(labels[index]) : String(rawValue == null ? '' : rawValue);
      if (value === previous) {
        wave += '.';
      } else if (!value) {
        wave += 'x';
        previous = value;
      } else {
        wave += '=';
        data.push(value);
        previous = value;
      }
    });
    return { wave, data };
  }
  let previous = null;
  let wave = '';
  values.forEach((value) => {
    const state = normalizedDigitalState(value, previous || 'x');
    wave += state === previous ? '.' : state;
    previous = state;
  });
  return { wave };
}

function removeConnectionMetadata(source) {
  const rows = flattenSignals(source.signal, []);
  rows.forEach((row) => {
    delete row.source.node;
  });
  delete source.edge;
}

function buildSimplifiedContent(model, options) {
  const source = cloneJson(activeSession.source);
  removeConnectionMetadata(source);
  const outputTitle = String(options.outputTitle || model.title || (activeSession.title + ' - display'));
  source.title = outputTitle;
  if (source.head && typeof source.head === 'object' && source.head.text) {
    source.head.text = outputTitle;
  }
  model.rows.forEach((rowModel, rowIndex) => {
    const rowMeta = activeSession.rows[rowIndex];
    const target = signalAtPath(source, rowMeta.path);
    if (!target || typeof target !== 'object') return;
    const built = buildWaveFromValues(rowModel.mode, rowModel.values, rowModel.labels);
    target.wave = built.wave;
    if (built.data && built.data.length) target.data = built.data;
    else delete target.data;
    if (rowModel.mode === 'analog') {
      target.scope = Object.assign({}, target.scope || {}, {
        mode: 'analog',
        samples: rowModel.values.map((value) => value == null ? null : Number(value)),
        unit: rowMeta.unit || undefined
      });
    } else if (target.scope && typeof target.scope === 'object') {
      target.scope.mode = rowModel.mode;
      delete target.scope.samples;
    }
  });
  source.scopeInstance = {
    kind: 'VisualWaveDromScopeInstance',
    version: 1,
    sourceWaveId: String(options.sourceWaveId || ''),
    sourceRevision: Number(options.sourceRevision || 0),
    createdAt: new Date().toISOString(),
    method: String(options.method || 'event-preserving'),
    targetPoints: model.columns.length,
    originalPoints: activeSession.totalColumns,
    rangeStart: model.rangeStart,
    rangeEnd: model.rangeEnd,
    columnMap: model.columns.slice(),
    displayModes: model.rows.map((row) => row.mode)
  };
  source.scope = Object.assign({}, source.scope || {}, {
    samplePeriod: activeSession.samplePeriod,
    timeUnit: activeSession.timeUnit
  });
  return JSON.stringify(source, null, 2);
}

function calculateAnalogMaxError(columns) {
  if (!columns || columns.length < 2) return null;
  let maximumError = 0;
  let measured = false;
  activeSession.rows.forEach((row) => {
    if (!row.samples || !row.samples.length) return;
    const selectedValues = columns.map((column) => {
      const index = sampleIndexForColumn(row, column, activeSession.totalColumns);
      return row.samples[index];
    });
    const stride = Math.max(1, Math.floor(row.samples.length / 50000));
    let selectedIndex = 0;
    for (let sampleIndex = 0; sampleIndex < row.samples.length; sampleIndex += stride) {
      const actual = row.samples[sampleIndex];
      if (!Number.isFinite(actual)) continue;
      const column = row.samples.length <= 1
        ? 0
        : sampleIndex * (activeSession.totalColumns - 1) / (row.samples.length - 1);
      if (column < columns[0] || column > columns[columns.length - 1]) continue;
      while (selectedIndex + 1 < columns.length && columns[selectedIndex + 1] < column) {
        selectedIndex += 1;
      }
      const rightIndex = Math.min(columns.length - 1, selectedIndex + 1);
      const leftColumn = columns[selectedIndex];
      const rightColumn = columns[rightIndex];
      const leftValue = selectedValues[selectedIndex];
      const rightValue = selectedValues[rightIndex];
      if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) continue;
      const ratio = rightColumn > leftColumn
        ? (column - leftColumn) / (rightColumn - leftColumn)
        : 0;
      const estimated = leftValue + (rightValue - leftValue) * ratio;
      maximumError = Math.max(maximumError, Math.abs(actual - estimated));
      measured = true;
    }
  });
  return measured ? Math.round(maximumError * 1000000) / 1000000 : null;
}

function createSimplifiedModel(payload) {
  const rangeStart = clamp(
    Math.floor(finiteNumber(payload.rangeStart) || 0),
    0,
    Math.max(0, activeSession.totalColumns - 1)
  );
  const rangeEnd = clamp(
    Math.ceil(finiteNumber(payload.rangeEnd) || activeSession.totalColumns),
    rangeStart + 1,
    activeSession.totalColumns
  );
  const columns = chooseColumns(
    payload.targetPoints,
    payload.lockedColumns,
    payload.method,
    rangeStart,
    rangeEnd
  );
  const modes = payload.modes || {};
  const rows = activeSession.rows.map((row) => {
    const mode = modes[row.index] || row.mode;
    const values = columns.map((column) => stateAtColumn(row, column, mode));
    return {
      index: row.index,
      name: row.name,
      mode,
      values,
      labels: mode === 'bus' ? values.map((value) => String(value == null ? '' : value)) : []
    };
  });
  const model = {
    title: String(payload.outputTitle || (activeSession.title + ' - 展示实例')),
    rangeStart,
    rangeEnd,
    columns,
    rows
  };
  const content = buildSimplifiedContent(model, payload);
  let digitalTransitions = 0;
  let busTransitions = 0;
  activeSession.rows.forEach((row) => {
    row.transitions.forEach((column) => {
      if (column < rangeStart || column >= rangeEnd) return;
      const segment = segmentAt(row, column + 1e-7);
      if (segment && segment.kind === 'bus') busTransitions += 1;
      else digitalTransitions += 1;
    });
  });
  const analogMaxError = calculateAnalogMaxError(columns);
  return {
    model,
    content,
    metrics: {
      originalPoints: rangeEnd - rangeStart,
      simplifiedPoints: columns.length,
      compressionRatio: rangeEnd > rangeStart
        ? columns.length / (rangeEnd - rangeStart)
        : 1,
      digitalTransitions,
      busTransitions,
      analogMaxError
    }
  };
}

function prepareResponse() {
  return {
    title: activeSession.title,
    totalColumns: activeSession.totalColumns,
    samplePeriod: activeSession.samplePeriod,
    timeUnit: activeSession.timeUnit,
    rows: activeSession.rows.map((row) => ({
      index: row.index,
      name: row.name,
      groups: row.groups,
      mode: row.mode,
      detectedMode: row.detectedMode,
      unit: row.unit,
      range: row.range,
      sampleCount: row.samples ? row.samples.length : row.wave.length
    }))
  };
}

function handleRequest(message) {
  const request = message || {};
  const requestId = request.requestId;
  try {
    let result;
    if (request.type === 'prepare') {
      activeSession = createSession(request.content);
      result = prepareResponse();
    } else if (request.type === 'window') {
      result = createWindow(request);
    } else if (request.type === 'simplify') {
      result = createSimplifiedModel(request);
    } else if (request.type === 'build') {
      if (!activeSession) throw new Error('Scope session has not been prepared');
      result = {
        content: buildSimplifiedContent(request.model, request),
        model: request.model
      };
    } else {
      throw new Error('Unsupported scope worker request: ' + String(request.type || ''));
    }
    return { requestId, ok: true, result };
  } catch (error) {
    return {
      requestId,
      ok: false,
      error: error && error.message ? error.message : String(error)
    };
  }
}

if (typeof document === 'undefined' && global && typeof global.postMessage === 'function') {
  global.addEventListener('message', (event) => {
    global.postMessage(handleRequest(event.data || {}));
  });
} else if (global) {
  global.VisualWaveDromScopeWorkerCore = {
    handleRequest
  };
}
})(typeof self !== 'undefined' ? self : this);

(function (global) {
'use strict';

let activeSession = null;
const DEFAULT_ROW_HEIGHT = 42;
const MIN_ANALOG_ROW_HEIGHT = 28;
const MAX_ANALOG_ROW_HEIGHT = 480;

function finiteNumber(value) {
  if (value == null || (typeof value === 'string' && !value.trim())) return null;
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

function normalizeAnalogFormat(candidate, fallbackType) {
  const source = candidate && typeof candidate === 'object' ? candidate : {};
  const supported = ['unsigned', 'signed', 'ufixed', 'sfixed', 'float'];
  const requestedType = String(
    source.type || source.numericType || source.dataType || fallbackType || 'unsigned'
  ).toLowerCase();
  const type = supported.indexOf(requestedType) >= 0 ? requestedType : (fallbackType || 'unsigned');
  let bitWidth = clamp(Math.floor(finiteNumber(source.bitWidth) || 32), 1, 64);
  if (type === 'float') bitWidth = bitWidth <= 32 ? 32 : 64;
  const fractionalBits = clamp(
    Math.floor(finiteNumber(source.fractionalBits) || 0),
    0,
    Math.max(0, bitWidth - 1)
  );
  return { type, bitWidth, fractionalBits };
}

function normalizeBusFormat(candidate) {
  const source = candidate && typeof candidate === 'object' ? candidate : {};
  const requestedRadix = finiteNumber(
    source.busRadix == null ? source.radix : source.busRadix
  );
  const radix = [2, 8, 10, 16].indexOf(requestedRadix) >= 0 ? requestedRadix : 10;
  const widthValue = source.busBitWidth == null ? source.bitWidth : source.busBitWidth;
  const bitWidth = clamp(Math.floor(finiteNumber(widthValue) || 32), 1, 64);
  const signedValue = source.busSigned == null ? source.signed : source.busSigned;
  const signedText = String(signedValue == null ? '' : signedValue).toLowerCase();
  const signed = signedValue === true || signedText === 'true' || signedText === 'signed';
  return { radix, bitWidth, signed };
}

function normalizeScopeColor(value) {
  const color = String(value == null ? '' : value).trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(color)) return color;
  if (/^#[0-9a-f]{3}$/.test(color)) {
    return '#' + color.slice(1).split('').map((character) => character + character).join('');
  }
  return '';
}

function overlayBackgroundRange(ranges, start, end, color) {
  const next = [];
  ranges.forEach((range) => {
    if (range.end <= start || range.start >= end) {
      next.push(range);
      return;
    }
    if (range.start < start) {
      next.push({ start: range.start, end: start, color: range.color });
    }
    if (range.end > end) {
      next.push({ start: end, end: range.end, color: range.color });
    }
  });
  if (color && end > start) next.push({ start, end, color });
  next.sort((left, right) => left.start - right.start || left.end - right.end);
  return next.reduce((merged, range) => {
    const previous = merged[merged.length - 1];
    if (previous && previous.color === range.color && previous.end === range.start) {
      previous.end = range.end;
    } else {
      merged.push(range);
    }
    return merged;
  }, []);
}

function normalizeBackgroundRanges(candidate, totalColumns) {
  const maximum = Math.max(1, Math.ceil(finiteNumber(totalColumns) || 1));
  let ranges = [];
  (Array.isArray(candidate) ? candidate : []).forEach((range) => {
    if (!range || typeof range !== 'object') return;
    const color = normalizeScopeColor(range.color);
    if (!color) return;
    const start = clamp(Math.floor(finiteNumber(range.start) || 0), 0, maximum);
    const end = clamp(Math.ceil(finiteNumber(range.end) || 0), start, maximum);
    if (end <= start) return;
    ranges = overlayBackgroundRange(ranges, start, end, color);
  });
  return ranges;
}

function normalizeRowStyle(candidate, totalColumns) {
  const source = candidate && typeof candidate === 'object' ? candidate : {};
  return {
    waveColor: normalizeScopeColor(source.waveColor),
    backgroundColor: normalizeScopeColor(source.backgroundColor),
    backgroundRanges: normalizeBackgroundRanges(source.backgroundRanges, totalColumns)
  };
}

function normalizeRowHeight(value) {
  return clamp(
    Math.round(finiteNumber(value) || DEFAULT_ROW_HEIGHT),
    MIN_ANALOG_ROW_HEIGHT,
    MAX_ANALOG_ROW_HEIGHT
  );
}

function getAnalogFormat(source, row, rowIndex, hasSamples) {
  const signal = row.source || {};
  const localScope = signal.scope && typeof signal.scope === 'object' ? signal.scope : null;
  const globalScope = getScopeSignalConfig(source, row, rowIndex);
  return normalizeAnalogFormat(localScope || globalScope, hasSamples ? 'float' : 'unsigned');
}

function getBusFormat(source, row, rowIndex) {
  const signal = row.source || {};
  const localScope = signal.scope && typeof signal.scope === 'object' ? signal.scope : null;
  const globalScope = getScopeSignalConfig(source, row, rowIndex);
  return normalizeBusFormat(localScope || globalScope);
}

function parseIntegerToken(value) {
  let token = String(value == null ? '' : value).trim().replace(/_/g, '');
  if (!token || /^(x|z)$/i.test(token)) return null;
  let negative = false;
  if (token[0] === '+' || token[0] === '-') {
    negative = token[0] === '-';
    token = token.slice(1);
  }
  if (!/^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+)$/.test(token)) return null;
  try {
    const parsed = BigInt(token);
    return negative ? -parsed : parsed;
  } catch (_error) {
    return null;
  }
}

function formatBusValue(value, candidate) {
  const text = String(value == null ? '' : value).trim();
  if (!text || /^(x|z)$/i.test(text)) return text.toLowerCase();
  const integer = parseIntegerToken(text);
  if (integer == null) return text;
  const format = normalizeBusFormat(candidate);
  const interpreted = format.signed
    ? BigInt.asIntN(format.bitWidth, integer)
    : BigInt.asUintN(format.bitWidth, integer);
  const negative = interpreted < 0n;
  const magnitude = negative ? -interpreted : interpreted;
  let digits = magnitude.toString(format.radix);
  if (format.radix === 16) digits = digits.toUpperCase();
  if (!negative && format.radix !== 10) {
    const groupSize = format.radix === 2 ? 1 : (format.radix === 8 ? 3 : 4);
    digits = digits.padStart(Math.ceil(format.bitWidth / groupSize), '0');
  }
  const prefix = format.radix === 2
    ? '0b'
    : (format.radix === 8 ? '0o' : (format.radix === 16 ? '0x' : ''));
  return (negative ? '-' : '') + prefix + digits;
}

function floatFromBits(rawValue, bitWidth) {
  const width = bitWidth <= 32 ? 32 : 64;
  const buffer = new ArrayBuffer(width / 8);
  const view = new DataView(buffer);
  if (width === 32) {
    view.setUint32(0, Number(BigInt.asUintN(32, rawValue)), false);
    return view.getFloat32(0, false);
  }
  view.setBigUint64(0, BigInt.asUintN(64, rawValue), false);
  return view.getFloat64(0, false);
}

function parseAnalogValue(value, analogFormat) {
  const format = normalizeAnalogFormat(analogFormat);
  const token = String(value == null ? '' : value).trim().replace(/_/g, '');
  if (!token || /^(x|z)$/i.test(token)) return Number.NaN;
  if (format.type === 'float') {
    if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(token)) {
      const numeric = Number(token);
      return Number.isFinite(numeric) ? numeric : Number.NaN;
    }
    const bits = parseIntegerToken(token);
    return bits == null ? Number.NaN : floatFromBits(bits, format.bitWidth);
  }
  const integer = parseIntegerToken(token);
  if (integer == null) return Number.NaN;
  const raw = format.type === 'signed' || format.type === 'sfixed'
    ? BigInt.asIntN(format.bitWidth, integer)
    : BigInt.asUintN(format.bitWidth, integer);
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return Number.NaN;
  return format.type === 'ufixed' || format.type === 'sfixed'
    ? numeric / Math.pow(2, format.fractionalBits)
    : numeric;
}

function splitConditionParts(expression, separator) {
  const parts = [];
  let start = 0;
  let quote = '';
  let escaped = false;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (expression.slice(index, index + separator.length) === separator) {
      parts.push(expression.slice(start, index));
      start = index + separator.length;
      index += separator.length - 1;
    }
  }
  if (quote) throw new Error('条件中的引号没有闭合');
  parts.push(expression.slice(start));
  return parts;
}

function conditionLiteral(rawValue) {
  const raw = String(rawValue == null ? '' : rawValue).trim();
  if (!raw) throw new Error('条件比较值不能为空');
  const first = raw[0];
  const last = raw[raw.length - 1];
  const quoted = raw.length >= 2
    && (first === '"' || first === "'")
    && last === first;
  const text = quoted
    ? raw.slice(1, -1).replace(/\\(['"\\])/g, '$1')
    : raw;
  return {
    text,
    quoted,
    number: finiteNumber(text)
  };
}

function compileConditionAtom(rawAtom, mode) {
  const atom = String(rawAtom || '').trim();
  if (!atom) throw new Error('条件中存在空表达式');
  if (/[()]/.test(atom)) throw new Error('条件暂不支持括号');
  const match = atom.match(/^(?:value\s*)?(==|!=|>=|<=|>|<|=)?\s*(.+)$/i);
  if (!match) throw new Error('无法解析条件：' + atom);
  const operator = match[1] === '=' || !match[1] ? '==' : match[1];
  const expected = conditionLiteral(match[2]);
  const numericOperator = /^(>|>=|<|<=)$/.test(operator);
  if ((mode === 'analog' || numericOperator) && expected.number == null) {
    throw new Error('数值条件需要有效数字：' + atom);
  }
  if (mode === 'digital' && !/^[01xzhHlL]$/.test(expected.text)) {
    throw new Error('数字信号条件支持 0、1、x、z、h、l');
  }
  return function testConditionAtom(actualValue) {
    if (numericOperator || mode === 'analog') {
      const actual = finiteNumber(actualValue);
      if (actual == null) return false;
      if (operator === '>') return actual > expected.number;
      if (operator === '>=') return actual >= expected.number;
      if (operator === '<') return actual < expected.number;
      if (operator === '<=') return actual <= expected.number;
      const tolerance = Math.max(1e-9, Math.abs(expected.number) * 1e-9);
      const equal = Math.abs(actual - expected.number) <= tolerance;
      return operator === '!=' ? !equal : equal;
    }
    let actual = String(actualValue == null ? '' : actualValue);
    let target = expected.text;
    if (mode === 'digital') {
      actual = normalizedDigitalState(actual, 'x');
      target = normalizedDigitalState(target, '');
    } else if (!expected.quoted) {
      const actualNumber = finiteNumber(actual);
      if (actualNumber != null && expected.number != null) {
        const equal = actualNumber === expected.number;
        return operator === '!=' ? !equal : equal;
      }
    }
    const equal = actual === target;
    return operator === '!=' ? !equal : equal;
  };
}

function compileCondition(expression, mode) {
  const source = String(expression == null ? '' : expression).trim();
  if (!source) throw new Error('条件不能为空');
  if (source.length > 256) throw new Error('条件长度不能超过 256 个字符');
  const orParts = splitConditionParts(source, '||');
  if (orParts.length > 16) throw new Error('条件组合数量过多');
  let atomCount = 0;
  const groups = orParts.map((orPart) => {
    const andParts = splitConditionParts(orPart, '&&');
    atomCount += andParts.length;
    if (atomCount > 32) throw new Error('条件组合数量过多');
    return andParts.map((atom) => compileConditionAtom(atom, mode));
  });
  return function testCondition(value) {
    return groups.some((group) => group.every((test) => test(value)));
  };
}

function stateKind(character) {
  if (/[2-9=]/.test(character)) return 'bus';
  return 'digital';
}

function normalizedDigitalState(character, previous) {
  const value = String(character == null ? '' : character).toLowerCase();
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

function clockStates(symbol) {
  return String(symbol || '').toLowerCase() === 'p'
    ? ['1', '0']
    : ['0', '1'];
}

function pushClockRange(ranges, column, symbol) {
  const last = ranges[ranges.length - 1];
  if (last && last.end === column && last.symbol === symbol) {
    last.end = column + 1;
    return;
  }
  ranges.push({ start: column, end: column + 1, symbol });
}

function parseWaveSegments(signal) {
  const wave = String(signal.wave || '');
  const labels = Array.isArray(signal.data) ? signal.data.map((value) => String(value)) : [];
  const segments = [];
  const transitions = [];
  const clockEdges = [];
  const clockRanges = [];
  const gaps = [];
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

  function emitClock(column, symbol) {
    const states = clockStates(symbol);
    const positive = String(symbol).toLowerCase() === 'p';
    emit(column, column + 0.5, {
      kind: 'digital',
      state: states[0],
      value: states[0]
    });
    emit(column + 0.5, column + 1, {
      kind: 'digital',
      state: states[1],
      value: states[1]
    });
    clockEdges.push({
      column,
      edge: positive ? 'rising' : 'falling',
      marked: symbol === symbol.toUpperCase()
    });
    pushClockRange(clockRanges, column, symbol);
  }

  for (let column = 0; column < wave.length; column += 1) {
    const character = wave[column];
    const lower = character.toLowerCase();
    if (character === '|') gaps.push(column + 0.5);
    if ((character === '.' || character === '|') && clockMode) {
      emitClock(column, clockMode);
      continue;
    }
    if (character === '.' || character === ' ' || character === '|') {
      emit(column, column + 1, current);
      continue;
    }
    if (lower === 'p' || lower === 'n') {
      clockMode = character;
      emitClock(column, character);
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
  return { wave, segments, transitions, clockEdges, clockRanges, gaps };
}

function buildAnalogLevels(samples) {
  const levels = [];
  if (!samples || !samples.length) return levels;
  let mins = new Float64Array(samples.length);
  let maxs = new Float64Array(samples.length);
  let unknowns = new Uint8Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    mins[index] = samples[index];
    maxs[index] = samples[index];
    unknowns[index] = Number.isFinite(samples[index]) ? 0 : 1;
  }
  levels.push({ size: 1, mins, maxs, unknowns });
  let size = 1;
  while (mins.length > 1024) {
    const length = Math.ceil(mins.length / 2);
    const nextMins = new Float64Array(length);
    const nextMaxs = new Float64Array(length);
    const nextUnknowns = new Uint8Array(length);
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
      nextUnknowns[index] = unknowns[left]
        || (right < unknowns.length ? unknowns[right] : 0);
    }
    size *= 2;
    levels.push({ size, mins: nextMins, maxs: nextMaxs, unknowns: nextUnknowns });
    mins = nextMins;
    maxs = nextMaxs;
    unknowns = nextUnknowns;
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
    const localScope = row.source.scope && typeof row.source.scope === 'object'
      ? row.source.scope
      : null;
    const requestedMode = localScope && localScope.mode
      ? String(localScope.mode)
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
      sourceName: row.name,
      name: row.name || ('signal_' + (rowIndex + 1)),
      mode,
      detectedMode,
      wave: parsedWave.wave,
      segments: parsedWave.segments,
      transitions: parsedWave.transitions,
      clockEdges: parsedWave.clockEdges,
      clockRanges: parsedWave.clockRanges,
      gaps: parsedWave.gaps,
      samples: analogSamples,
      analogLevels: analogSamples ? buildAnalogLevels(analogSamples) : [],
      range: analogSamples ? analogRange(analogSamples) : null,
      busFormat: getBusFormat(source, row, rowIndex),
      analogFormat: getAnalogFormat(source, row, rowIndex, !!analogSamples),
      analogCache: new Map(),
      rowHeight: normalizeRowHeight(localScope && localScope.rowHeight),
      unit: String(
        (localScope && localScope.unit)
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

function pointEventsInWindow(events, start, end, width) {
  if (!events || !events.length) return [];
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const column = typeof events[middle] === 'number'
      ? events[middle]
      : events[middle].column;
    if (column < start) low = middle + 1;
    else high = middle;
  }
  const first = low;
  while (low < events.length) {
    const column = typeof events[low] === 'number' ? events[low] : events[low].column;
    if (column >= end) break;
    low += 1;
  }
  const count = low - first;
  const limit = Math.max(64, Math.floor(width * 2));
  if (count <= limit) return events.slice(first, low);
  const result = [];
  for (let index = 0; index < limit; index += 1) {
    result.push(events[first + Math.floor(index * count / limit)]);
  }
  return result;
}

function displaySegmentForMode(row, segment, column, mode, totalColumns, busFormat) {
  if (mode === 'bus') {
    let rawValue;
    if (row.samples && row.samples.length) {
      const sampleIndex = discreteSampleIndexForColumn(row, column);
      const sample = sampleIndex >= 0 ? row.samples[sampleIndex] : Number.NaN;
      if (!Number.isFinite(sample)) {
        return { kind: 'digital', state: 'x', value: 'x' };
      }
      rawValue = String(sample);
    } else if (segment.kind === 'bus') {
      rawValue = String(segment.value == null ? '' : segment.value);
    } else {
      const state = normalizedDigitalState(segment.state, 'x');
      if (state === 'x') return { kind: 'digital', state: 'x', value: 'x' };
      rawValue = state;
    }
    return {
      kind: 'bus',
      state: 'bus',
      value: formatBusValue(rawValue, busFormat)
    };
  }
  if (!row.samples || !row.samples.length || mode === 'analog') return segment;
  const sampleIndex = discreteSampleIndexForColumn(row, column);
  const sample = sampleIndex >= 0 ? row.samples[sampleIndex] : Number.NaN;
  if (mode === 'digital') {
    const state = Number.isFinite(sample) && (sample === 0 || sample === 1)
      ? String(sample)
      : 'x';
    return { kind: 'digital', state, value: state };
  }
  return segment;
}

function sampledSegmentsInWindow(row, start, end, mode, busFormat) {
  const selected = [];
  const sampleCount = row.samples ? row.samples.length : 0;
  const firstIndex = Math.max(0, Math.floor(start));
  const lastIndex = Math.min(sampleCount, Math.ceil(end));
  for (let index = firstIndex; index < lastIndex; index += 1) {
    const visibleStart = Math.max(start, index);
    const visibleEnd = Math.min(end, index + 1);
    if (!(visibleEnd > visibleStart)) continue;
    const sample = row.samples[index];
    let display;
    if (!Number.isFinite(sample)) {
      display = { kind: 'digital', state: 'x', value: 'x' };
    } else if (mode === 'bus') {
      display = {
        kind: 'bus',
        state: 'bus',
        value: formatBusValue(String(sample), busFormat)
      };
    } else {
      const state = sample === 0 || sample === 1 ? String(sample) : 'x';
      display = { kind: 'digital', state, value: state };
    }
    pushSegment(selected, {
      start: visibleStart,
      end: visibleEnd,
      kind: display.kind,
      state: display.state,
      value: display.value
    });
  }
  if (end > sampleCount) {
    pushSegment(selected, {
      start: Math.max(start, sampleCount),
      end,
      kind: 'digital',
      state: 'x',
      value: 'x'
    });
  }
  return selected;
}

function sampledBucketsInWindow(row, start, end, width, mode, busFormat) {
  const bucketCount = Math.max(1, Math.floor(width));
  const span = end - start;
  const sampleCount = row.samples ? row.samples.length : 0;
  const buckets = [];
  for (let pixel = 0; pixel < bucketCount; pixel += 1) {
    const bucketStart = start + span * pixel / bucketCount;
    const bucketEnd = start + span * (pixel + 1) / bucketCount;
    const firstIndex = Math.max(0, Math.floor(bucketStart));
    const lastIndex = Math.max(firstIndex + 1, Math.ceil(bucketEnd));
    const availableCount = Math.max(1, lastIndex - firstIndex);
    const probeCount = Math.min(8, availableCount);
    let high = false;
    let low = false;
    let unknown = false;
    let bus = false;
    let value = '';
    let changes = 0;
    let previousKey = '';
    for (let probe = 0; probe < probeCount; probe += 1) {
      const sampleIndex = probeCount <= 1
        ? firstIndex
        : firstIndex + Math.floor(probe * (availableCount - 1) / (probeCount - 1));
      const sample = sampleIndex < sampleCount ? row.samples[sampleIndex] : Number.NaN;
      let key;
      if (!Number.isFinite(sample)) {
        unknown = true;
        key = 'x';
      } else if (mode === 'bus') {
        bus = true;
        const formatted = formatBusValue(String(sample), busFormat);
        if (!value) value = formatted;
        else if (value !== formatted) value = '*';
        key = 'bus:' + formatted;
      } else if (sample === 1) {
        high = true;
        key = '1';
      } else if (sample === 0) {
        low = true;
        key = '0';
      } else {
        unknown = true;
        key = 'x';
      }
      if (previousKey && previousKey !== key) changes += 1;
      previousKey = key;
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
  return buckets;
}

function rowSegmentsInWindow(row, start, end, width, mode, totalColumns, busFormat) {
  const decorations = {
    clockEdges: pointEventsInWindow(row.clockEdges, start, end, width),
    gaps: pointEventsInWindow(row.gaps, start, end, width)
  };
  let selected;
  if (row.samples && row.samples.length && mode !== 'analog') {
    const visibleSampleCount = Math.max(
      0,
      Math.min(row.samples.length, Math.ceil(end)) - Math.max(0, Math.floor(start))
    );
    if (visibleSampleCount > Math.max(64, width * 4)) {
      return Object.assign({
        kind: 'buckets',
        items: sampledBucketsInWindow(row, start, end, width, mode, busFormat)
      }, decorations);
    }
    selected = sampledSegmentsInWindow(row, start, end, mode, busFormat);
  } else {
    selected = [];
    const first = findFirstSegment(row.segments, start);
    for (let index = first; index < row.segments.length; index += 1) {
      const segment = row.segments[index];
      if (segment.start >= end) break;
      const visibleStart = Math.max(start, segment.start);
      const visibleEnd = Math.min(end, segment.end);
      const display = displaySegmentForMode(
        row,
        segment,
        visibleStart + 1e-7,
        mode,
        totalColumns,
        busFormat
      );
      pushSegment(selected, {
        start: visibleStart,
        end: visibleEnd,
        kind: display.kind,
        state: display.state,
        value: display.value
      });
    }
    const coveredEnd = selected.length ? selected[selected.length - 1].end : start;
    if (coveredEnd < end) {
      pushSegment(selected, {
        start: coveredEnd,
        end,
        kind: 'digital',
        state: 'x',
        value: 'x'
      });
    }
  }
  if (selected.length <= Math.max(64, width * 4)) {
    return Object.assign({ kind: 'segments', items: selected }, decorations);
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
  return Object.assign({ kind: 'buckets', items: buckets }, decorations);
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

function discreteSampleIndexForColumn(row, column) {
  if (!row.samples || !row.samples.length) return -1;
  const index = Math.floor(Math.max(0, Number(column) || 0));
  return index < row.samples.length ? index : -1;
}

function appendAnalogUnknownRange(ranges, start, end) {
  if (!(end > start)) return;
  const previous = ranges[ranges.length - 1];
  if (previous && start <= previous[1] + 1e-7) {
    previous[1] = Math.max(previous[1], end);
    return;
  }
  ranges.push([start, end]);
}

function analogSampleBoundary(sampleIndex, sampleCount, totalColumns) {
  if (sampleIndex <= 0 || sampleCount <= 0) return 0;
  if (sampleIndex >= sampleCount) return totalColumns;
  return sampleIndex * totalColumns / sampleCount;
}

function analogWindow(row, start, end, width, totalColumns) {
  const sampleCount = row.samples ? row.samples.length : 0;
  const scale = sampleCount <= 1 || totalColumns <= 1
    ? 0
    : (sampleCount - 1) / (totalColumns - 1);
  const startIndex = clamp(Math.floor(start * scale), 0, Math.max(0, sampleCount - 1));
  const endIndex = clamp(
    Math.max(startIndex + 1, Math.ceil(end * scale) + 1),
    startIndex + 1,
    sampleCount
  );
  const sampleSpan = Math.max(1, endIndex - startIndex);
  if (sampleSpan <= Math.max(64, width * 2)) {
    const points = [];
    const unknowns = [];
    for (let index = startIndex; index < endIndex && index < row.samples.length; index += 1) {
      const value = row.samples[index];
      const column = row.samples.length <= 1
        ? 0
        : index * (totalColumns - 1) / (row.samples.length - 1);
      if (!Number.isFinite(value)) {
        points.push([column, null]);
        appendAnalogUnknownRange(
          unknowns,
          analogSampleBoundary(index, row.samples.length, totalColumns),
          analogSampleBoundary(index + 1, row.samples.length, totalColumns)
        );
      } else {
        points.push([column, value]);
      }
    }
    return { kind: 'points', items: points, unknowns, range: row.range };
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
  const unknowns = [];
  for (let index = firstBucket; index < lastBucket; index += 1) {
    const min = level.mins[index];
    const max = level.maxs[index];
    const sampleIndex = index * level.size;
    if (level.unknowns && level.unknowns[index]) {
      appendAnalogUnknownRange(
        unknowns,
        analogSampleBoundary(sampleIndex, row.samples.length, totalColumns),
        analogSampleBoundary(
          Math.min(row.samples.length, sampleIndex + level.size),
          row.samples.length,
          totalColumns
        )
      );
    }
    if (!Number.isFinite(min) && !Number.isFinite(max)) continue;
    const column = row.samples.length <= 1
      ? 0
      : sampleIndex * (totalColumns - 1) / (row.samples.length - 1);
    items.push([column, min, max]);
  }
  return { kind: 'envelope', items, unknowns, range: row.range };
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
    const analogRow = mode === 'analog'
      ? analogRowForFormat(
        row,
        payload.analogFormats && payload.analogFormats[index],
        total
      )
      : row;
    const data = mode === 'analog' && analogRow.samples
      ? analogWindow(analogRow, start, end, width, total)
      : rowSegmentsInWindow(
        row,
        start,
        end,
        width,
        mode,
        total,
        payload.busFormats && payload.busFormats[index] || row.busFormat
      );
    rows.push({ index, mode, data });
  }
  return { start, end, width, rowStart, rowEnd, rows };
}

function segmentAt(row, column) {
  const index = findFirstSegment(row.segments, column);
  if (index >= row.segments.length) return row.segments[row.segments.length - 1];
  return row.segments[index];
}

function analogRowForFormat(row, requestedFormat, totalColumns) {
  if (row.samples && row.samples.length) return row;
  const format = normalizeAnalogFormat(requestedFormat || row.analogFormat, 'unsigned');
  const key = format.type + ':' + format.bitWidth + ':' + format.fractionalBits
    + ':' + totalColumns;
  if (row.analogCache && row.analogCache.has(key)) return row.analogCache.get(key);
  const samples = new Float64Array(Math.max(1, totalColumns));
  samples.fill(Number.NaN);
  const sourceLength = Math.min(samples.length, row.wave.length);
  let segmentIndex = 0;
  for (let column = 0; column < sourceLength; column += 1) {
    while (segmentIndex < row.segments.length
        && row.segments[segmentIndex].end <= column + 1e-7) {
      segmentIndex += 1;
    }
    const segment = row.segments[Math.min(segmentIndex, row.segments.length - 1)];
    if (!segment) continue;
    samples[column] = parseAnalogValue(
      segment.kind === 'bus' ? segment.value : segment.state,
      format
    );
  }
  const derived = Object.assign({}, row, {
    samples,
    analogLevels: buildAnalogLevels(samples),
    range: analogRange(samples),
    analogFormat: format
  });
  if (row.analogCache) row.analogCache.set(key, derived);
  return derived;
}

function clockSymbolAt(row, column) {
  const ranges = row.clockRanges || [];
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const range = ranges[middle];
    if (column < range.start) high = middle - 1;
    else if (column >= range.end) low = middle + 1;
    else return range.symbol;
  }
  return '';
}

function gapAtColumn(row, column) {
  const gaps = row.gaps || [];
  const target = column + 0.5;
  let low = 0;
  let high = gaps.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const difference = gaps[middle] - target;
    if (Math.abs(difference) < 1e-7) return true;
    if (difference < 0) low = middle + 1;
    else high = middle - 1;
  }
  return false;
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

function chooseColumns(
  targetPoints,
  lockedColumns,
  method,
  requestedStart,
  requestedEnd,
  modes,
  analogFormats
) {
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
    const mode = modes && modes[row.index] || row.mode;
    const analogRow = mode === 'analog'
      ? analogRowForFormat(
        row,
        analogFormats && analogFormats[row.index],
        activeSession.totalColumns
      )
      : row;
    if (includeTransitions && mode !== 'analog') {
      row.transitions.forEach((column) => {
        if (column < rangeStart || column >= rangeEnd) return;
        const segment = segmentAt(row, column + 1e-7);
        add(column, segment && segment.kind === 'bus' ? 850 : 1000);
      });
    }
    if (includeAnalog && analogRow.samples) {
      lttbIndexes(
        analogRow.samples,
        Math.min(analogRow.samples.length, rowBudget)
      ).forEach((sampleIndex) => {
        const column = analogRow.samples.length <= 1
          ? 0
          : sampleIndex * (total - 1) / (analogRow.samples.length - 1);
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

function stateAtColumn(row, column, mode, analogFormat) {
  if (mode === 'analog') {
    const analogRow = analogRowForFormat(row, analogFormat, activeSession.totalColumns);
    const index = sampleIndexForColumn(analogRow, column, activeSession.totalColumns);
    const value = analogRow.samples[index];
    return Number.isFinite(value) ? value : null;
  }
  const segment = segmentAt(row, column + 1e-7);
  if (row.samples && row.samples.length) {
    const sampleIndex = discreteSampleIndexForColumn(row, column);
    const sample = sampleIndex >= 0 ? row.samples[sampleIndex] : Number.NaN;
    if (mode === 'digital') {
      return Number.isFinite(sample) && (sample === 0 || sample === 1)
        ? String(sample)
        : 'x';
    }
    if (mode === 'bus') {
      if (!Number.isFinite(sample)) return null;
      return String(sample);
    }
  }
  if (!segment) return mode === 'bus' ? null : 'x';
  if (mode === 'bus') {
    return segment.kind === 'bus'
      ? String(segment.value == null ? '' : segment.value)
      : (normalizedDigitalState(segment.state, 'x') === 'x'
          ? null
          : normalizedDigitalState(segment.state, 'x'));
  }
  return normalizedDigitalState(segment.state, 'x');
}

function inspectCursor(payload) {
  if (!activeSession) throw new Error('Scope session has not been prepared');
  const column = clamp(
    finiteNumber(payload.column) || 0,
    0,
    Math.max(0, activeSession.totalColumns - 1e-7)
  );
  const modes = payload.modes || {};
  const busFormats = payload.busFormats || {};
  const analogFormats = payload.analogFormats || {};
  return {
    column,
    rows: activeSession.rows.map((row) => {
      const mode = modes[row.index] || row.mode;
      const value = stateAtColumn(row, column, mode, analogFormats[row.index]);
      return {
        index: row.index,
        mode,
        value: mode === 'bus'
          ? formatBusValue(value, busFormats[row.index] || row.busFormat)
          : value,
        symbol: mode === 'digital' ? clockSymbolAt(row, column) : ''
      };
    })
  };
}

function edgeColumn(row, column, direction) {
  const transitions = row.transitions || [];
  const epsilon = 1e-7;
  if (direction > 0) {
    let low = 0;
    let high = transitions.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (transitions[middle] <= column + epsilon) low = middle + 1;
      else high = middle;
    }
    return low < transitions.length ? transitions[low] : null;
  }
  let low = 0;
  let high = transitions.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (transitions[middle] < column - epsilon) low = middle + 1;
    else high = middle;
  }
  return low > 0 ? transitions[low - 1] : null;
}

function nearestSortedColumn(columns, column) {
  if (!columns || !columns.length) return null;
  let low = 0;
  let high = columns.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (columns[middle] < column) low = middle + 1;
    else high = middle;
  }
  if (low <= 0) return columns[0];
  if (low >= columns.length) return columns[columns.length - 1];
  const before = columns[low - 1];
  const after = columns[low];
  return Math.abs(column - before) <= Math.abs(after - column) ? before : after;
}

function segmentMatchesValue(segment, mode, target) {
  if (mode === 'bus') return String(segment.value == null ? '' : segment.value) === target;
  return normalizedDigitalState(segment.state, 'x') === target;
}

function segmentValueColumn(row, column, direction, mode, target) {
  const epsilon = 1e-7;
  if (direction > 0) {
    let index = findFirstSegment(row.segments, column + epsilon);
    for (; index < row.segments.length; index += 1) {
      const segment = row.segments[index];
      if (segment.start <= column + epsilon) continue;
      if (segmentMatchesValue(segment, mode, target)) return segment.start;
    }
    return null;
  }
  let index = findFirstSegment(row.segments, Math.max(0, column - epsilon));
  if (index >= row.segments.length) index = row.segments.length - 1;
  for (; index >= 0; index -= 1) {
    const segment = row.segments[index];
    if (segment.start >= column - epsilon) continue;
    if (segmentMatchesValue(segment, mode, target)) return segment.start;
  }
  return null;
}

function analogValueColumn(row, column, direction, target, analogFormat) {
  const targetNumber = finiteNumber(target);
  const analogRow = analogRowForFormat(row, analogFormat, activeSession.totalColumns);
  if (targetNumber == null || !analogRow.samples || !analogRow.samples.length) return null;
  const currentIndex = sampleIndexForColumn(analogRow, column, activeSession.totalColumns);
  const step = direction > 0 ? 1 : -1;
  const tolerance = Math.max(1e-9, Math.abs(targetNumber) * 1e-9);
  for (
    let index = currentIndex + step;
    index >= 0 && index < analogRow.samples.length;
    index += step
  ) {
    const value = analogRow.samples[index];
    if (!Number.isFinite(value) || Math.abs(value - targetNumber) > tolerance) continue;
    return analogRow.samples.length <= 1
      ? 0
      : index * (activeSession.totalColumns - 1) / (analogRow.samples.length - 1);
  }
  return null;
}

function segmentConditionValue(segment, mode) {
  if (mode === 'bus') return String(segment.value == null ? '' : segment.value);
  return normalizedDigitalState(segment.state, 'x');
}

function conditionSegmentColumn(row, column, direction, mode, testCondition) {
  const segments = row.segments || [];
  if (segments.length < 2) return null;
  const epsilon = 1e-7;
  if (direction > 0) {
    let index = findFirstSegment(segments, column + epsilon);
    if (index >= segments.length) return null;
    for (index = Math.max(1, index); index < segments.length; index += 1) {
      const boundary = segments[index].start;
      if (boundary <= column + epsilon) continue;
      const previousMatches = testCondition(segmentConditionValue(segments[index - 1], mode));
      const currentMatches = testCondition(segmentConditionValue(segments[index], mode));
      if (!previousMatches && currentMatches) return boundary;
    }
    return null;
  }
  let index = findFirstSegment(segments, Math.max(0, column - epsilon));
  if (index >= segments.length) index = segments.length - 1;
  for (; index >= 1; index -= 1) {
    const boundary = segments[index].start;
    if (boundary >= column - epsilon) continue;
    const previousMatches = testCondition(segmentConditionValue(segments[index - 1], mode));
    const currentMatches = testCondition(segmentConditionValue(segments[index], mode));
    if (!previousMatches && currentMatches) return boundary;
  }
  return null;
}

function analogSampleColumn(sampleIndex, sampleCount, totalColumns) {
  if (sampleCount <= 1 || totalColumns <= 1) return 0;
  return sampleIndex * (totalColumns - 1) / (sampleCount - 1);
}

function snapCursor(payload) {
  if (!activeSession) throw new Error('Scope session has not been prepared');
  const rowIndex = clamp(
    Math.floor(finiteNumber(payload.rowIndex) || 0),
    0,
    Math.max(0, activeSession.rows.length - 1)
  );
  const row = activeSession.rows[rowIndex];
  if (!row) return { rowIndex: 0, column: 0, source: 'column' };
  const maximum = Math.max(0, activeSession.totalColumns - 1e-7);
  const column = clamp(finiteNumber(payload.column) || 0, 0, maximum);
  const mode = payload.mode || row.mode;
  const candidates = [];

  if (mode === 'analog') {
    const analogRow = analogRowForFormat(row, payload.analogFormat, activeSession.totalColumns);
    const sampleIndex = sampleIndexForColumn(analogRow, column, activeSession.totalColumns);
    candidates.push({
      column: analogSampleColumn(sampleIndex, analogRow.samples.length, activeSession.totalColumns),
      source: 'sample'
    });
  } else {
    const transition = nearestSortedColumn(row.transitions, column);
    if (transition != null) candidates.push({ column: transition, source: 'transition' });
  }

  candidates.push({
    column: clamp(Math.round(column), 0, Math.max(0, activeSession.totalColumns - 1)),
    source: 'column'
  });
  const valid = candidates.filter((candidate) => (
    Number.isFinite(candidate.column)
    && candidate.column >= 0
    && candidate.column <= maximum
  ));
  valid.sort((left, right) => (
    Math.abs(left.column - column) - Math.abs(right.column - column)
  ));
  const selected = valid[0] || { column: 0, source: 'column' };
  return {
    rowIndex,
    requestedColumn: column,
    column: selected.column,
    source: selected.source
  };
}

function conditionAnalogColumn(row, column, direction, testCondition, analogFormat) {
  const analogRow = analogRowForFormat(row, analogFormat, activeSession.totalColumns);
  const samples = analogRow.samples;
  if (!samples || samples.length < 2) return null;
  const scale = samples.length <= 1 || activeSession.totalColumns <= 1
    ? 0
    : (samples.length - 1) / (activeSession.totalColumns - 1);
  if (direction > 0) {
    let index = Math.max(1, Math.floor(column * scale + 1e-7) + 1);
    for (; index < samples.length; index += 1) {
      if (!testCondition(samples[index - 1]) && testCondition(samples[index])) {
        return analogSampleColumn(index, samples.length, activeSession.totalColumns);
      }
    }
    return null;
  }
  let index = Math.min(
    samples.length - 1,
    Math.ceil(column * scale - 1e-7) - 1
  );
  for (; index >= 1; index -= 1) {
    if (!testCondition(samples[index - 1]) && testCondition(samples[index])) {
      return analogSampleColumn(index, samples.length, activeSession.totalColumns);
    }
  }
  return null;
}

function conditionRisingColumn(row, column, direction, mode, expression, analogFormat) {
  const testCondition = compileCondition(expression, mode);
  return mode === 'analog'
    ? conditionAnalogColumn(row, column, direction, testCondition, analogFormat)
    : conditionSegmentColumn(row, column, direction, mode, testCondition);
}

function navigateCursor(payload) {
  if (!activeSession) throw new Error('Scope session has not been prepared');
  const rowIndex = clamp(
    Math.floor(finiteNumber(payload.rowIndex) || 0),
    0,
    Math.max(0, activeSession.rows.length - 1)
  );
  const row = activeSession.rows[rowIndex];
  const column = clamp(
    finiteNumber(payload.column) || 0,
    0,
    Math.max(0, activeSession.totalColumns - 1e-7)
  );
  const direction = Number(payload.direction) < 0 ? -1 : 1;
  const mode = payload.mode || row.mode;
  const analogFormat = payload.analogFormat;
  const kind = String(payload.kind || 'edge');
  let targetColumn = null;
  if (kind === 'edge') {
    targetColumn = edgeColumn(row, column, direction);
  } else if (kind === 'value') {
    if (mode === 'analog') {
      targetColumn = analogValueColumn(row, column, direction, payload.value, analogFormat);
    } else {
      const target = mode === 'bus'
        ? String(payload.value == null ? '' : payload.value)
        : normalizedDigitalState(payload.value, '');
      targetColumn = segmentValueColumn(row, column, direction, mode, target);
    }
  } else if (kind === 'condition') {
    targetColumn = conditionRisingColumn(
      row,
      column,
      direction,
      mode,
      payload.condition,
      analogFormat
    );
  }
  if (targetColumn == null) {
    return { found: false, rowIndex, column };
  }
  return {
    found: true,
    rowIndex,
    column: targetColumn,
    value: stateAtColumn(row, targetColumn, mode, analogFormat)
  };
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

function requestedSignalName(payload, row) {
  const names = payload && Array.isArray(payload.signalNames) ? payload.signalNames : null;
  if (names && Object.prototype.hasOwnProperty.call(names, row.index)) {
    return String(names[row.index] == null ? '' : names[row.index]);
  }
  return String(row.sourceName == null ? '' : row.sourceName);
}

function applySignalNames(source, payload) {
  const names = activeSession.rows.map((row) => requestedSignalName(payload, row));
  const signalConfigs = source.scope
    && typeof source.scope === 'object'
    && source.scope.signals
    && typeof source.scope.signals === 'object'
    && !Array.isArray(source.scope.signals)
    ? source.scope.signals
    : null;
  const originalSignalConfigs = signalConfigs ? Object.assign({}, signalConfigs) : null;
  activeSession.rows.forEach((row) => {
    const nextName = names[row.index];
    const previousName = String(row.sourceName == null ? '' : row.sourceName);
    if (signalConfigs && previousName && previousName !== nextName
        && Object.prototype.hasOwnProperty.call(originalSignalConfigs, previousName)) {
      const nextKey = nextName || String(row.index);
      const nextNameUseCount = nextName
        ? names.reduce((count, name) => count + (name === nextName ? 1 : 0), 0)
        : 1;
      if (nextNameUseCount === 1 || !Object.prototype.hasOwnProperty.call(signalConfigs, nextKey)) {
        signalConfigs[nextKey] = originalSignalConfigs[previousName];
      }
    }
    const target = signalAtPath(source, row.path);
    if (!target || typeof target !== 'object') return;
    if (nextName) target.name = nextName;
    else delete target.name;
  });
  if (signalConfigs) {
    activeSession.rows.forEach((row) => {
      const previousName = String(row.sourceName == null ? '' : row.sourceName);
      if (previousName && !names.includes(previousName)) delete signalConfigs[previousName];
    });
  }
  return names;
}

function buildWaveFromValues(mode, values, labels, symbols, gaps) {
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
      const unknown = rawValue == null || rawValue === '';
      const value = unknown
        ? ''
        : (labels && labels[index] != null
            ? String(labels[index])
            : String(rawValue));
      const stateKey = unknown ? 'unknown' : ('value:' + value);
      if (stateKey === previous) {
        wave += '.';
      } else if (unknown) {
        wave += 'x';
      } else {
        wave += '=';
        data.push(value);
      }
      previous = stateKey;
    });
    return { wave, data };
  }
  let previous = null;
  let previousClock = '';
  let wave = '';
  values.forEach((value, index) => {
    const clock = symbols && /^[pPnN]$/.test(symbols[index] || '')
      ? symbols[index]
      : '';
    if (clock) {
      wave += previousClock === clock
        ? (gaps && gaps[index] ? '|' : '.')
        : clock;
      previousClock = clock;
      previous = null;
      return;
    }
    const state = normalizedDigitalState(value, previous || 'x');
    wave += !previousClock && state === previous ? '.' : state;
    previousClock = '';
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

function mappedBackgroundRanges(ranges, columnMap) {
  if (!Array.isArray(columnMap)) return ranges;
  let mapped = [];
  let rangeIndex = 0;
  for (let index = 0; index < columnMap.length; index += 1) {
    const sourceColumn = finiteNumber(columnMap[index]);
    if (sourceColumn == null) continue;
    while (rangeIndex < ranges.length && ranges[rangeIndex].end <= sourceColumn) {
      rangeIndex += 1;
    }
    const range = ranges[rangeIndex];
    const color = range && sourceColumn >= range.start && sourceColumn < range.end
      ? range.color
      : '';
    if (color) mapped = overlayBackgroundRange(mapped, index, index + 1, color);
  }
  return mapped;
}

function applyRowStyle(target, candidate, totalColumns, columnMap) {
  if (!target || typeof target !== 'object') return;
  const style = normalizeRowStyle(candidate, totalColumns);
  const hadScope = target.scope && typeof target.scope === 'object';
  const scope = Object.assign({}, hadScope ? target.scope : {});
  if (style.waveColor) scope.waveColor = style.waveColor;
  else delete scope.waveColor;
  if (style.backgroundColor) scope.backgroundColor = style.backgroundColor;
  else delete scope.backgroundColor;
  const ranges = mappedBackgroundRanges(style.backgroundRanges, columnMap);
  if (ranges.length) scope.backgroundRanges = ranges;
  else delete scope.backgroundRanges;
  if (hadScope || Object.keys(scope).length) target.scope = scope;
  else delete target.scope;
}

function applyRowDisplayConfig(target, row, rowIndex, payload) {
  if (!target || typeof target !== 'object') return;
  const source = payload || {};
  const scope = Object.assign(
    {},
    target.scope && typeof target.scope === 'object' ? target.scope : {}
  );
  const requestedMode = source.modes && source.modes[rowIndex];
  const mode = /^(digital|bus|analog)$/.test(String(requestedMode || ''))
    ? String(requestedMode)
    : row.mode;
  if (mode !== row.detectedMode || Object.prototype.hasOwnProperty.call(scope, 'mode')) {
    scope.mode = mode;
  } else {
    delete scope.mode;
  }
  if (mode === 'bus') {
    const format = normalizeBusFormat(
      source.busFormats && source.busFormats[rowIndex] || row.busFormat
    );
    scope.busRadix = format.radix;
    scope.busBitWidth = format.bitWidth;
    scope.busSigned = format.signed;
  }
  if (mode === 'analog') {
    const format = normalizeAnalogFormat(
      source.analogFormats && source.analogFormats[rowIndex] || row.analogFormat,
      row.samples ? 'float' : 'unsigned'
    );
    scope.numericType = format.type;
    scope.bitWidth = format.bitWidth;
    scope.fractionalBits = format.fractionalBits;
  }
  const rowHeight = normalizeRowHeight(
    source.rowHeights && source.rowHeights[rowIndex] != null
      ? source.rowHeights[rowIndex]
      : row.rowHeight
  );
  if (rowHeight !== DEFAULT_ROW_HEIGHT) scope.rowHeight = rowHeight;
  else delete scope.rowHeight;
  if (Object.keys(scope).length) target.scope = scope;
  else delete target.scope;
}

function buildStyledSource(payload) {
  if (!activeSession) throw new Error('Scope session has not been prepared');
  const source = cloneJson(activeSession.source);
  applySignalNames(source, payload);
  const rowStyles = payload.rowStyles || {};
  activeSession.rows.forEach((row) => {
    const target = signalAtPath(source, row.path);
    applyRowStyle(target, rowStyles[row.index], activeSession.totalColumns, null);
    applyRowDisplayConfig(target, row, row.index, payload);
  });
  return JSON.stringify(source, null, 2);
}

function buildSimplifiedContent(model, options) {
  const source = cloneJson(activeSession.source);
  applySignalNames(source, options);
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
    const built = buildWaveFromValues(
      rowModel.mode,
      rowModel.values,
      rowModel.labels,
      rowModel.symbols,
      rowModel.gaps
    );
    target.wave = built.wave;
    if (built.data && built.data.length) target.data = built.data;
    else delete target.data;
    if (rowModel.mode === 'analog') {
      const analogFormat = normalizeAnalogFormat(
        rowModel.analogFormat || rowMeta.analogFormat,
        rowMeta.samples ? 'float' : 'unsigned'
      );
      target.scope = Object.assign({}, target.scope || {}, {
        mode: 'analog',
        samples: rowModel.values.map((value) => value == null ? null : Number(value)),
        unit: rowMeta.unit || undefined,
        numericType: analogFormat.type,
        bitWidth: analogFormat.bitWidth,
        fractionalBits: analogFormat.fractionalBits
      });
    } else if (target.scope && typeof target.scope === 'object') {
      target.scope.mode = rowModel.mode;
      delete target.scope.samples;
      delete target.scope.numericType;
      delete target.scope.bitWidth;
      delete target.scope.fractionalBits;
    }
    applyRowStyle(
      target,
      options.rowStyles && options.rowStyles[rowIndex],
      activeSession.totalColumns,
      model.columns
    );
    applyRowDisplayConfig(target, rowMeta, rowIndex, options);
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
    displayModes: model.rows.map((row) => row.mode),
    busFormats: model.rows.map((row, index) => (
      row.mode === 'bus'
        ? normalizeBusFormat(options.busFormats && options.busFormats[index])
        : null
    )),
    analogFormats: model.rows.map((row) => (
      row.mode === 'analog' ? normalizeAnalogFormat(row.analogFormat) : null
    ))
  };
  source.scope = Object.assign({}, source.scope || {}, {
    samplePeriod: activeSession.samplePeriod,
    timeUnit: activeSession.timeUnit
  });
  return JSON.stringify(source, null, 2);
}

function calculateAnalogMaxError(columns, modes, analogFormats) {
  if (!columns || columns.length < 2) return null;
  let maximumError = 0;
  let measured = false;
  activeSession.rows.forEach((row) => {
    const mode = modes && modes[row.index] || row.mode;
    if (mode !== 'analog') return;
    const analogRow = analogRowForFormat(
      row,
      analogFormats && analogFormats[row.index],
      activeSession.totalColumns
    );
    if (!analogRow.samples || !analogRow.samples.length) return;
    const selectedValues = columns.map((column) => {
      const index = sampleIndexForColumn(analogRow, column, activeSession.totalColumns);
      return analogRow.samples[index];
    });
    const stride = Math.max(1, Math.floor(analogRow.samples.length / 50000));
    let selectedIndex = 0;
    for (let sampleIndex = 0; sampleIndex < analogRow.samples.length; sampleIndex += stride) {
      const actual = analogRow.samples[sampleIndex];
      if (!Number.isFinite(actual)) continue;
      const column = analogRow.samples.length <= 1
        ? 0
        : sampleIndex * (activeSession.totalColumns - 1) / (analogRow.samples.length - 1);
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
    rangeEnd,
    payload.modes,
    payload.analogFormats
  );
  const modes = payload.modes || {};
  const analogFormats = payload.analogFormats || {};
  const rows = activeSession.rows.map((row) => {
    const mode = modes[row.index] || row.mode;
    const analogFormat = normalizeAnalogFormat(
      analogFormats[row.index] || row.analogFormat,
      row.samples ? 'float' : 'unsigned'
    );
    const values = columns.map((column) => stateAtColumn(
      row,
      column,
      mode,
      analogFormat
    ));
    return {
      index: row.index,
      name: requestedSignalName(payload, row),
      mode,
      values,
      analogFormat,
      symbols: mode === 'digital'
        ? columns.map((column) => clockSymbolAt(row, column))
        : [],
      gaps: columns.map((column) => gapAtColumn(row, column)),
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
    const mode = modes[row.index] || row.mode;
    if (mode === 'analog') return;
    row.transitions.forEach((column) => {
      if (column < rangeStart || column >= rangeEnd) return;
      const segment = segmentAt(row, column + 1e-7);
      if (segment && segment.kind === 'bus') busTransitions += 1;
      else digitalTransitions += 1;
    });
  });
  const analogMaxError = calculateAnalogMaxError(columns, modes, analogFormats);
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
      sourceName: row.sourceName,
      groups: row.groups,
      mode: row.mode,
      detectedMode: row.detectedMode,
      unit: row.unit,
      range: row.range,
      busFormat: row.busFormat,
      analogFormat: row.analogFormat,
      rowHeight: row.rowHeight,
      style: normalizeRowStyle(row.source.scope, activeSession.totalColumns),
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
    } else if (request.type === 'inspect') {
      result = inspectCursor(request);
    } else if (request.type === 'snap') {
      result = snapCursor(request);
    } else if (request.type === 'style-source') {
      result = { content: buildStyledSource(request) };
    } else if (request.type === 'navigate') {
      result = navigateCursor(request);
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

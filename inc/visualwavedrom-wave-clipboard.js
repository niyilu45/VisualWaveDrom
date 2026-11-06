(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VisualWaveDromWaveClipboard = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const format = 'VisualWaveDrom.WaveSelection';
  const mime = 'application/x-visualwavedrom-wave-selection+json';
  const maxSize = 16 * 1024 * 1024;
  const nodeIds = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const clone = value => JSON.parse(JSON.stringify(value));

  function signalsIn(source) {
    const rows = [];
    function visit(items) {
      (items || []).forEach(item => {
        if (Array.isArray(item)) visit(item);
        else if (item && typeof item === 'object') rows.push(item);
      });
    }
    visit(source.signal);
    return rows;
  }

  function connectionParts(edge) {
    if (typeof edge !== 'string') return null;
    const words = edge.match(/^(\s*)(\S+)([\s\S]*)$/);
    const token = words && words[2].match(/^([^a-zA-Z0-9]*)([a-zA-Z0-9])([^a-zA-Z0-9]+)([a-zA-Z0-9])$/);
    return token ? { leading: words[1], prefix: token[1], from: token[2], arrow: token[3], to: token[4], suffix: words[3] } : null;
  }

  function cloneConnections(connections) {
    return Array.isArray(connections) ? clone(connections) : [];
  }

  function collectConnections(source, block) {
    const endpoints = new Map(), duplicates = new Set();
    signalsIn(source).forEach((signal, row) => {
      for (const match of String(signal.node || '').matchAll(/[a-zA-Z0-9]/g)) {
        const id = match[0], col = match.index;
        if (endpoints.has(id)) duplicates.add(id);
        endpoints.set(id, { row, col });
      }
    });
    const inside = point => point && point.row >= block.startRow && point.row <= block.endRow
      && point.col >= block.start && point.col <= block.end + 1;
    const relative = point => ({ row: point.row - block.startRow, col: point.col - block.start });
    return (Array.isArray(source.edge) ? source.edge : []).flatMap((edge, index) => {
      const parsed = connectionParts(edge);
      if (!parsed || duplicates.has(parsed.from) || duplicates.has(parsed.to)) return [];
      const from = endpoints.get(parsed.from), to = endpoints.get(parsed.to);
      if (!inside(from) || !inside(to) || from.row === to.row && from.col === to.col) return [];
      const option = source.edgeOptions && source.edgeOptions[index];
      return [{ edge, from: relative(from), to: relative(to), option: option && typeof option === 'object' && !Array.isArray(option) ? clone(option) : null }];
    });
  }

  function repeatConnections(connections, columns, count, rowCount) {
    const repeated = [];
    for (let row = 0; row < (rowCount || 1); row++) for (let index = 0; index < count; index++) {
      cloneConnections(connections).forEach(connection => {
        for (const point of [connection.from, connection.to]) { point.row += row; point.col += index * columns; }
        repeated.push(connection);
      });
    }
    return repeated;
  }

  function pasteConnections(source, connections, startRow, startCol) {
    if (!connections || !connections.length) return 0;
    const rows = signalsIn(source), used = new Set(), counts = new Map(), plans = new Map(), additions = [];
    rows.forEach(signal => {
      for (const match of String(signal.node || '').matchAll(/[a-zA-Z0-9]/g)) {
        used.add(match[0]); counts.set(match[0], (counts.get(match[0]) || 0) + 1);
      }
    });
    (Array.isArray(source.edge) ? source.edge : []).forEach(edge => {
      const parsed = connectionParts(edge);
      if (parsed) { used.add(parsed.from); used.add(parsed.to); }
    });
    function endpoint(point) {
      const row = startRow + point.row, col = startCol + point.col, key = row + ':' + col;
      if (plans.has(key)) return plans.get(key).id;
      let id = String(rows[row].node || '')[col];
      if (/[a-zA-Z0-9]/.test(id || '')) {
        if (counts.get(id) !== 1) throw new Error('目标波形的连接端点标识重复，无法粘贴连接线');
      } else {
        id = Array.from(nodeIds).find(candidate => !used.has(candidate));
        if (!id) throw new Error('连接端点标识已用完，未粘贴波形或连接线');
        used.add(id);
      }
      plans.set(key, { row, col, id });
      return id;
    }
    for (const connection of connections) {
      const parsed = connectionParts(connection.edge);
      if (!parsed || !rows[startRow + connection.from.row] || !rows[startRow + connection.to.row]) continue;
      const from = endpoint(connection.from), to = endpoint(connection.to);
      additions.push({ edge: parsed.leading + parsed.prefix + from + parsed.arrow + to + parsed.suffix, option: connection.option ? clone(connection.option) : null });
    }
    if (!additions.length) return 0;
    // Allocate every endpoint first: a full node pool must not leave half a paste.
    plans.forEach(({ row, col, id }) => {
      const node = String(rows[row].node || '').padEnd(col + 1, '.');
      rows[row].node = node.slice(0, col) + id + node.slice(col + 1);
    });
    const edges = Array.isArray(source.edge) ? source.edge.slice() : [];
    const options = Array.isArray(source.edgeOptions) ? source.edgeOptions.slice() : [];
    additions.forEach(addition => {
      while (options.length < edges.length) options.push(null);
      options[edges.length] = addition.option;
      edges.push(addition.edge);
    });
    source.edge = edges;
    if (options.some(Boolean)) source.edgeOptions = options;
    return additions.length;
  }

  function normalize(value) {
    if (!value || value.format !== format || value.version !== 1
        || !Number.isSafeInteger(value.columns) || value.columns < 1 || value.columns > maxSize
        || !Array.isArray(value.rows) || !value.rows.length || value.rows.length > 4096
        || value.rows.length * value.columns > maxSize) return null;
    const rows = [];
    for (const row of value.rows) {
      if (!row || typeof row.text !== 'string' || row.text.length !== value.columns
          || /[\x00-\x20\x7f]/.test(row.text) || !Array.isArray(row.dataSlots)
          || row.dataSlots.length > value.columns) return null;
      const offsets = new Set();
      const dataSlots = [];
      for (const slot of row.dataSlots) {
        if (!slot || !Number.isSafeInteger(slot.offset) || slot.offset < 0 || slot.offset >= value.columns
            || offsets.has(slot.offset) || !/[2-9=]/.test(row.text[slot.offset])) return null;
        offsets.add(slot.offset);
        try { dataSlots.push({ offset: slot.offset, value: JSON.parse(JSON.stringify(slot.value == null ? '' : slot.value)) }); }
        catch (_error) { return null; }
      }
      rows.push({ text: row.text, dataSlots });
    }
    const result = { format, version: 1, columns: value.columns, rows };
    if (value.connections !== undefined) {
      if (!Array.isArray(value.connections)) return null;
      const inside = point => point && Number.isSafeInteger(point.row) && point.row >= 0 && point.row < rows.length
        && Number.isSafeInteger(point.col) && point.col >= 0 && point.col <= value.columns;
      for (const connection of value.connections) {
        if (!connection || !connectionParts(connection.edge) || !inside(connection.from) || !inside(connection.to)
            || connection.from.row === connection.to.row && connection.from.col === connection.to.col
            || connection.option != null && (typeof connection.option !== 'object' || Array.isArray(connection.option))) return null;
      }
      try { if (value.connections.length) result.connections = cloneConnections(value.connections); }
      catch (_error) { return null; }
    }
    try { return JSON.stringify(result).length <= maxSize ? result : null; }
    catch (_error) { return null; }
  }

  function parse(text) {
    if (typeof text !== 'string' || text.length > maxSize) return null;
    try { return normalize(JSON.parse(text)); } catch (_error) { return null; }
  }

  function create(onReceive) {
    let latest = null;
    let revision = '';
    let counter = 0;
    let channel = null;
    const sender = Math.random().toString(36).slice(2);
    const post = message => {
      if (channel) {
        try { channel.postMessage(message); } catch (_error) { /* System clipboard remains available. */ }
      }
    };
    try {
      channel = new root.BroadcastChannel('visualwavedrom-wave-selection-v1');
      channel.addEventListener('message', event => {
        const message = event.data;
        if (!message || message.sender === sender) return;
        if (message.type === 'request') {
          if (latest) post({ type: 'selection', sender, revision, payload: latest });
          return;
        }
        if (message.type !== 'selection' || typeof message.revision !== 'string' || message.revision <= revision) return;
        const payload = normalize(message.payload);
        if (!payload) return;
        latest = payload;
        revision = message.revision;
        if (onReceive) onReceive(normalize(payload));
      });
      post({ type: 'request', sender });
    } catch (_error) { /* Native copy/paste also works between different browser origins. */ }
    function publish(rows, connections) {
      const payload = normalize({ format, version: 1, columns: rows[0] && rows[0].text.length, rows, connections });
      if (!payload) return null;
      latest = payload;
      revision = Date.now().toString(36).padStart(10, '0') + '-' + String(++counter).padStart(8, '0') + '-' + sender;
      post({ type: 'selection', sender, revision, payload });
      return payload;
    }
    function close() { if (channel) channel.close(); channel = null; }
    if (root.addEventListener) root.addEventListener('pagehide', event => { if (!event.persisted) close(); });
    return { publish, close };
  }
  return { create, parse, normalize, mime, maxSize, collectConnections, pasteConnections, cloneConnections, repeatConnections };
}));

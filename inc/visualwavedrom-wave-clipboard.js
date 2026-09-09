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
    function publish(rows) {
      const payload = normalize({ format, version: 1, columns: rows[0] && rows[0].text.length, rows });
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
  return { create, parse, normalize, mime, maxSize };
}));

(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VisualWaveDromPresenterShortcuts = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const storageKey = 'visualwavedrom.presenter.shortcuts.v1';
  const modifiers = ['Ctrl', 'Alt', 'Shift'];
  const namedKeys = ['Space', 'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Insert',
    'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
  const physicalKeys = { Space: 'Space', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`' };

  function normalize(value) {
    if (value === '') return '';
    if (typeof value !== 'string') return null;
    const parts = value.split('+');
    let key = parts.pop();
    if (parts.some(part => !modifiers.includes(part)) || new Set(parts).size !== parts.length) return null;
    if (/^[a-z]$/i.test(key)) key = key.toLowerCase();
    if (!/^[a-z0-9\-=\[\]\\;',./`]$/.test(key) && !/^F(?:[1-9]|1[0-2])$/.test(key)
        && !namedKeys.includes(key)) return null;
    return modifiers.filter(part => parts.includes(part)).concat(key).join('+');
  }

  function fromEvent(event) {
    if (event.isComposing || event.keyCode === 229
        || ['Dead', 'Process', 'Unidentified'].includes(event.key)
        || (event.getModifierState && event.getModifierState('AltGraph'))) return null;
    const code = String(event.code || '');
    let key = physicalKeys[code];
    if (/^Key[A-Z]$/.test(code)) key = code.slice(3).toLowerCase();
    else if (/^(Digit|Numpad)[0-9]$/.test(code)) key = code.slice(-1);
    if (!key) key = event.key === ' ' ? 'Space' : event.key;
    return normalize([event.ctrlKey || event.metaKey ? 'Ctrl' : '', event.altKey ? 'Alt' : '',
      event.shiftKey ? 'Shift' : '', key].filter(Boolean).join('+'));
  }

  function reserved(value) {
    if (/^(Escape|Tab|Enter|Backspace|Delete|F1|F3|F5|F6|F7|F10|F11|F12)$/.test(value)) return true;
    return /^(Ctrl\+(Shift\+)?[flnoprtuw]|Ctrl\+(Shift\+)?Tab|Alt\+(F4|Tab|ArrowLeft|ArrowRight)|Ctrl\+Alt\+Delete|Ctrl\+Shift\+Escape)$/.test(value);
  }

  function display(value) {
    const labels = { ArrowLeft: '\u2190', ArrowRight: '\u2192', ArrowUp: '\u2191', ArrowDown: '\u2193' };
    return String(value || '').split('+').map(key => labels[key] || (/^[a-z]$/.test(key) ? key.toUpperCase() : key)).join('+');
  }

  function isEditingKey(value) {
    return /^(Ctrl\+(Shift\+)?(a|b|c|i|u|v|x|y|z|Insert|Space|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|Backspace|Delete)|Alt\+Backspace)$/.test(value);
  }

  function sanitize(value, defaults) {
    const input = value && value.version === 1 && value.bindings && typeof value.bindings === 'object'
      ? value.bindings : {};
    const bindings = {};
    const used = new Set();
    Object.keys(defaults).forEach(id => {
      let key = Object.prototype.hasOwnProperty.call(input, id) ? normalize(input[id]) : defaults[id];
      if (key === null || reserved(key)) key = defaults[id];
      if (key && used.has(key)) key = '';
      bindings[id] = key;
      if (key) used.add(key);
    });
    return bindings;
  }

  function read(defaults) {
    try { return sanitize(JSON.parse(root.localStorage.getItem(storageKey)), defaults); }
    catch (_error) { return Object.assign({}, defaults); }
  }

  function write(bindings) {
    try {
      root.localStorage.setItem(storageKey, JSON.stringify({ version: 1, bindings }));
      return true;
    } catch (_error) { return false; }
  }

  return { storageKey, normalize, fromEvent, reserved, display, isEditingKey, sanitize, read, write };
}));

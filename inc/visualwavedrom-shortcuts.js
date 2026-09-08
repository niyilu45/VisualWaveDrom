(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VisualWaveDromShortcuts = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const storageKey = 'visualwavedrom.wave.shortcuts.v1';
  const modifiers = ['Ctrl', 'Alt', 'Shift'];
  const namedKeys = ['Space', 'Tab', 'Enter', 'Escape', 'Delete', 'Backspace', 'Insert',
    'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
  const shifted = { '`': '~', '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^',
    '7': '&', '8': '*', '9': '(', '0': ')', '-': '_', '=': '+', '[': '{', ']': '}',
    '\\': '|', ';': ':', "'": '"', ',': '<', '.': '>', '/': '?' };

  function normalize(value) {
    if (typeof value !== 'string') return null;
    let text = value.trim();
    if (!text) return '';
    const plusKey = text.endsWith('+');
    if (plusKey) text = text.slice(0, -1);
    const parts = text.split('+').map(part => part.trim());
    let key = plusKey ? '+' : parts.pop();
    if (plusKey && parts[parts.length - 1] === '') parts.pop();
    const mods = parts.map(part => {
      if (/^(ctrl|control|cmd|command|meta)$/i.test(part)) return 'Ctrl';
      return modifiers.find(mod => mod.toLowerCase() === part.toLowerCase());
    });
    if (mods.some(mod => !mod) || new Set(mods).size !== mods.length) return null;
    key = namedKeys.find(name => name.toLowerCase() === key.toLowerCase()) || key;
    if (/^f(?:[1-9]|1[0-2])$/i.test(key)) key = key.toUpperCase();
    else if (/^[a-z]$/i.test(key)) key = key.toLowerCase();
    else if (!/^[!-~]$/.test(key) && !namedKeys.includes(key)) return null;
    if (mods.includes('Shift') && shifted[key]) key = shifted[key];
    // Printable punctuation already contains the keyboard-layout Shift result (notably |).
    const canonicalMods = modifiers.filter(mod => mods.includes(mod)
      && !(mod === 'Shift' && /^[^a-z0-9]$/.test(key)));
    return canonicalMods.concat(key).join('+');
  }

  function fromEvent(event) {
    if (!event || event.isComposing || event.keyCode === 229
        || ['Dead', 'Process', 'Unidentified'].includes(event.key)
        || (event.getModifierState && event.getModifierState('AltGraph'))) return null;
    const key = event.key === ' ' ? 'Space' : String(event.key || '');
    return normalize([event.ctrlKey || event.metaKey ? 'Ctrl' : '', event.altKey ? 'Alt' : '',
      event.shiftKey ? 'Shift' : '', key].filter(Boolean).join('+'));
  }

  function display(value) {
    return String(value || '').replace(/(^|\+)([a-z])(?=\+|$)/g, (_, prefix, key) => prefix + key.toUpperCase());
  }

  function browserReserved(value) {
    return /^(Ctrl\+(Shift\+)?[flnoprtuw]|Ctrl\+(Shift\+)?Tab|Alt\+(F4|Tab|ArrowLeft|ArrowRight)|F(?:1|3|5|6|7|10|11|12))$/.test(value);
  }

  function create(waveItems, onChange) {
    const definitions = [
      { id: 'textEdit', label: '文本编辑模式', keys: ['Ctrl+t', 'F2'], group: '编辑操作' },
      { id: 'undo', label: '撤销', keys: ['Ctrl+z'], group: '编辑操作' },
      { id: 'redo', label: '重做', keys: ['Ctrl+Shift+z', 'Ctrl+y'], group: '编辑操作' },
      { id: 'copy', label: '复制波形 / 波形图', keys: ['Ctrl+c'], group: '编辑操作' },
      { id: 'paste', label: '粘贴波形 / 波形图', keys: ['Ctrl+v'], group: '编辑操作' },
      { id: 'delete', label: '删除选中的波形 / 分组 / 连线', keys: ['Delete'], group: '编辑操作' },
      { id: 'indent', label: '目录降一级', keys: ['Tab'], group: '目录操作' },
      { id: 'outdent', label: '目录升一级', keys: ['Shift+Tab'], group: '目录操作' }
    ].concat(waveItems.map(item => ({ id: 'wave:' + item.char, label: item.label + ' (' + item.char + ')',
      keys: [item.char], group: '波形快捷键' })));
    const defaults = Object.fromEntries(definitions.map(item => [item.id, item.keys.slice()]));
    let bindings = Object.fromEntries(definitions.map(item => [item.id, item.keys.slice()]));
    let modal = null;
    let returnFocus = null;
    let draft = null;
    let backdropPress = false;
    let onClose = null;

    function validate(candidate) {
      const normalized = {};
      const used = new Map();
      for (const item of definitions) {
        const values = candidate[item.id];
        if (!Array.isArray(values) || values.length > 2) return { error: item.label + '：快捷键格式无效', id: item.id };
        normalized[item.id] = [];
        for (const value of values) {
          const key = normalize(value);
          if (key === null) return { error: item.label + '：无法识别快捷键 ' + value, id: item.id };
          if (!key) { normalized[item.id].push(''); continue; }
          if (key === 'Escape' || key === 'Enter' || ((key === 'Tab' || key === 'Shift+Tab')
              && item.id !== 'indent' && item.id !== 'outdent') || key === 'Ctrl+Alt+Delete') {
            return { error: item.label + '：该按键保留给输入、导航或系统操作', id: item.id };
          }
          if (used.has(key)) return { error: display(key) + ' 与“' + used.get(key) + '”重复', id: item.id };
          used.set(key, item.label);
          normalized[item.id].push(key);
        }
      }
      return { bindings: normalized };
    }

    try {
      const stored = JSON.parse(root.localStorage.getItem(storageKey));
      if (stored && stored.version === 1 && stored.bindings) {
        const candidate = Object.assign({}, defaults, stored.bindings);
        const result = validate(candidate);
        if (result.bindings) bindings = result.bindings;
      }
    } catch (_error) { /* A fresh or storage-restricted browser uses the defaults. */ }

    function matches(id, event, useDefaults) {
      const key = fromEvent(event);
      return !!key && ((useDefaults ? defaults : bindings)[id] || []).includes(key);
    }

    function label(id) { return (bindings[id] || []).filter(Boolean).map(display).join(' / '); }

    function save(candidate) {
      const result = validate(candidate);
      if (!result.bindings) return result;
      bindings = result.bindings;
      let persisted = true;
      try { root.localStorage.setItem(storageKey, JSON.stringify({ version: 1, bindings })); }
      catch (_error) { persisted = false; }
      if (onChange) onChange();
      return { bindings, persisted };
    }

    function close() {
      if (!modal || modal.hidden) return;
      modal.hidden = true;
      if (onClose) onClose();
      else if (returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
      onClose = null;
    }

    function render() {
      const list = modal.querySelector('#wave-shortcut-list');
      list.replaceChildren();
      let lastGroup = '';
      definitions.forEach(item => {
        if (item.group !== lastGroup) {
          const heading = document.createElement('h3');
          heading.className = 'wave-shortcut-group';
          heading.textContent = item.group;
          list.appendChild(heading);
          lastGroup = item.group;
        }
        const row = document.createElement('div');
        row.className = 'wave-shortcut-row';
        row.dataset.shortcutId = item.id;
        const name = document.createElement('span');
        name.textContent = item.label;
        row.appendChild(name);
        for (let index = 0; index < 2; index++) {
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'modal-input';
          input.value = display(draft[item.id][index] || '');
          input.placeholder = '未设置';
          input.autocomplete = 'off';
          input.spellcheck = false;
          input.maxLength = 50;
          input.setAttribute('aria-label', item.label + (index ? '备用快捷键' : '主要快捷键'));
          input.title = '输入键名，例如 Ctrl+G、F2、Shift+Tab；留空取消绑定';
          input.addEventListener('input', () => {
            draft[item.id][index] = input.value;
            input.removeAttribute('aria-invalid');
            updateWarnings();
          });
          row.appendChild(input);
        }
        list.appendChild(row);
      });
      updateWarnings();
    }

    function updateWarnings() {
      const reserved = Array.from(new Set(Object.values(draft).flat().map(normalize).filter(key => key && browserReserved(key))));
      modal.querySelector('#wave-shortcut-warning').textContent = reserved.length
        ? reserved.map(display).join('、') + ' 可能被浏览器优先处理，建议设置备用快捷键。'
        : '';
    }

    function open(callback) {
      if (!root.document) return;
      if (!modal) {
        modal = document.getElementById('wave-shortcut-modal');
        if (!modal) return;
        modal.querySelector('#wave-shortcut-cancel').addEventListener('click', close);
        modal.querySelector('#wave-shortcut-reset').addEventListener('click', () => {
          draft = Object.fromEntries(definitions.map(item => [item.id, [item.keys[0] || '', item.keys[1] || '']]));
          modal.querySelector('#wave-shortcut-status').textContent = '';
          render();
        });
        modal.querySelector('#wave-shortcut-save').addEventListener('click', () => {
          const result = save(draft);
          const status = modal.querySelector('#wave-shortcut-status');
          if (result.error) {
            status.textContent = result.error;
            const row = Array.from(modal.querySelectorAll('[data-shortcut-id]')).find(el => el.dataset.shortcutId === result.id);
            const input = row.querySelector('input');
            input.setAttribute('aria-invalid', 'true');
            input.focus();
          } else if (!result.persisted) {
            status.textContent = '快捷键已应用，但浏览器未允许保存设置；关闭页面后将恢复原配置。';
          } else close();
        });
        modal.addEventListener('pointerdown', event => { backdropPress = event.target === modal; });
        modal.addEventListener('click', event => {
          if (event.target === modal && backdropPress) close();
          backdropPress = false;
        });
        modal.addEventListener('keydown', event => {
          event.stopPropagation();
          if (event.key === 'Escape') { event.preventDefault(); close(); }
          if (event.key !== 'Tab') return;
          const controls = Array.from(modal.querySelectorAll('input, button')).filter(el => !el.disabled);
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (document.activeElement === (event.shiftKey ? first : last)) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
          }
        });
      }
      returnFocus = document.activeElement;
      onClose = callback || null;
      draft = Object.fromEntries(definitions.map(item => [item.id, [bindings[item.id][0] || '', bindings[item.id][1] || '']]));
      modal.querySelector('#wave-shortcut-status').textContent = '';
      render();
      modal.hidden = false;
      modal.querySelector('.modal-body').scrollTop = 0;
      modal.querySelector('input').focus({ preventScroll: true });
    }

    return { definitions, defaults, matches, label, save, open, validate,
      snapshot: () => Object.fromEntries(definitions.map(item => [item.id, bindings[item.id].slice()])) };
  }

  return { create, normalize, fromEvent, display, browserReserved, storageKey };
}));

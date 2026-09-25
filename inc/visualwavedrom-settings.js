(function () {
  'use strict';

  const STORAGE_KEY = 'visualwavedrom.ui.font.v1';
  const root = document.documentElement;
  const defaults = { automatic: true, scale: 100 };
  let settings = readSettings();
  let refreshFrame = 0;
  let measureFrame = 0;
  let previousFocus = null;
  let backdropPress = false;
  let storageAvailable = true;
  let channel = null;
  let browserProbe = null;
  let systemProbe = null;
  let modal = null;
  let trigger = null;
  let autoInput = null;
  let scaleInput = null;
  let percentInput = null;
  let sizeOutput = null;
  let statusOutput = null;

  function normalize(value) {
    const source = value && typeof value === 'object' ? value : {};
    const scale = Number(source.scale);
    return {
      automatic: source.automatic !== false,
      scale: Number.isFinite(scale) && scale >= 80 && scale <= 200
        ? Math.round(scale)
        : 100
    };
  }

  function readSettings() {
    try {
      return normalize(JSON.parse(window.localStorage.getItem(STORAGE_KEY)));
    } catch (_error) {
      return { automatic: true, scale: 100 };
    }
  }

  // Browser zoom already handles display DPI. Measure native text, not screen width.
  function baseFontSize() {
    const browserSize = browserProbe
      ? parseFloat(getComputedStyle(browserProbe).fontSize) || 16
      : 16;
    const systemSize = systemProbe
      ? parseFloat(getComputedStyle(systemProbe).fontSize) || browserSize
      : browserSize;
    return {
      browser: browserSize,
      size: settings.automatic ? Math.max(browserSize, systemSize) : browserSize
    };
  }

  function refreshEditors() {
    refreshFrame = 0;
    document.querySelectorAll('.CodeMirror').forEach((element) => {
      const editor = element.CodeMirror;
      if (!editor || !element.getClientRects().length) return;
      const scroll = editor.getScrollInfo();
      editor.refresh();
      editor.setOption('cursorScrollMargin', editor.defaultTextHeight() * 2);
      editor.scrollTo(scroll.left, scroll.top);
    });
    window.dispatchEvent(new CustomEvent('vwd-ui-font-change'));
  }

  function updateControls() {
    if (!modal) return;
    autoInput.checked = settings.automatic;
    scaleInput.value = String(settings.scale);
    scaleInput.setAttribute('aria-valuetext', settings.scale + '%');
    if (document.activeElement !== percentInput) percentInput.value = String(settings.scale);
    sizeOutput.textContent = settings.scale + '%';
    statusOutput.hidden = storageAvailable;
    statusOutput.textContent = storageAvailable
      ? ''
      : '\u5b57\u4f53\u5df2\u5e94\u7528\uff0c\u4f46\u6d4f\u89c8\u5668\u672a\u5141\u8bb8\u4fdd\u5b58\u8bbe\u7f6e';
  }

  function apply() {
    const base = baseFontSize();
    const percentage = Number((settings.scale * base.size / base.browser).toFixed(4)) + '%';
    if (root.style.fontSize !== percentage) {
      root.style.fontSize = percentage;
      if (!refreshFrame) refreshFrame = requestAnimationFrame(refreshEditors);
    }
    updateControls();
  }

  function scheduleMeasure() {
    if (measureFrame) return;
    measureFrame = requestAnimationFrame(() => {
      measureFrame = 0;
      apply();
    });
  }

  function saveAndApply() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      storageAvailable = true;
    } catch (_error) {
      storageAvailable = false;
    }
    if (channel) {
      try { channel.postMessage(settings); } catch (_error) { /* A closing window can lose its channel. */ }
    }
    apply();
  }

  function close() {
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    const target = previousFocus && previousFocus.isConnected ? previousFocus : trigger;
    target.focus({ preventScroll: true });
  }

  function open() {
    previousFocus = document.activeElement;
    modal.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    updateControls();
    autoInput.focus({ preventScroll: true });
  }

  function addClassifierSettings() {
    const button = document.createElement('button');
    button.id = 'ui-settings-classifier';
    button.type = 'button';
    button.className = 'modal-btn ui-settings-shortcuts';
    button.textContent = '\u6ce2\u5f62\u5206\u7c7b\u5668';
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-controls', 'wave-classifier-modal');
    document.getElementById('ui-settings-shortcuts').after(button);
    let dialog = null;
    let draft = [];
    let backdrop = false;
    const classifier = () => window.visualWaveDromClassifier;

    function closeClassifier() {
      dialog.hidden = true;
      modal.hidden = false;
      button.focus({ preventScroll: true });
    }

    function validateDraft() {
      const count = dialog.querySelector('#wave-classifier-count');
      const result = count.value === '' || !count.validity.valid
        ? { error: '\u5206\u7c7b\u6570\u91cf\u5e94\u4e3a 0 \u81f3 ' + classifier().maxClasses + ' \u7684\u6574\u6570', index: -1 }
        : classifier().validate(draft);
      dialog.querySelector('#wave-classifier-status').textContent = result.error || '';
      dialog.querySelector('#wave-classifier-save').disabled = !!result.error;
      count.setAttribute('aria-invalid', String(result.index === -1));
      dialog.querySelectorAll('[data-class-index]').forEach(input => {
        input.setAttribute('aria-invalid', String(Number(input.dataset.classIndex) === result.index));
      });
      return result;
    }

    function renderRows() {
      const list = dialog.querySelector('#wave-classifier-list');
      list.replaceChildren();
      draft.forEach((value, index) => {
        const label = document.createElement('label');
        label.className = 'wave-classifier-row';
        const name = document.createElement('span');
        name.textContent = '\u5206\u7c7b ' + (index + 1);
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'modal-input';
        input.dataset.classIndex = String(index);
        input.value = value;
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.title = '\u6309\u5b57\u7b26\u6392\u5217\u987a\u5e8f\u5faa\u73af\u5207\u6362\uff1b\u7559\u7a7a\u4e0d\u53c2\u4e0e\u5207\u6362';
        input.setAttribute('aria-describedby', 'wave-classifier-status');
        input.addEventListener('input', () => { draft[index] = input.value; validateDraft(); });
        label.append(name, input);
        list.appendChild(label);
      });
      validateDraft();
    }

    button.addEventListener('click', () => {
      if (!classifier()) return;
      if (!dialog) {
        dialog = document.createElement('div');
        dialog.id = 'wave-classifier-modal';
        dialog.className = 'modal-overlay ui-settings-overlay';
        dialog.hidden = true;
        dialog.innerHTML = `
          <div class="modal-dialog ui-settings-dialog wave-classifier-dialog" role="dialog" aria-modal="true" aria-labelledby="wave-classifier-title">
            <div class="modal-header" id="wave-classifier-title">\u6ce2\u5f62\u5206\u7c7b\u5668</div>
            <div class="modal-body">
              <label class="ui-settings-auto" for="wave-classifier-enabled">
                <span>\u542f\u7528\u6ce2\u5f62\u5206\u7c7b\u5668</span>
                <input type="checkbox" id="wave-classifier-enabled" checked>
              </label>
              <p class="wave-classifier-help" id="wave-classifier-help"></p>
              <label class="wave-classifier-row">\u5206\u7c7b\u6570\u91cf
                <input id="wave-classifier-count" class="modal-input" type="number" min="0" step="1" required aria-describedby="wave-classifier-status">
              </label>
              <div id="wave-classifier-list"></div>
            </div>
            <div id="wave-classifier-status" class="wave-shortcut-feedback" role="status" aria-live="polite"></div>
            <div class="modal-footer">
              <button type="button" class="modal-btn" id="wave-classifier-reset">\u6062\u590d\u9ed8\u8ba4</button>
              <button type="button" class="modal-btn" id="wave-classifier-cancel">\u53d6\u6d88</button>
              <button type="button" class="modal-btn modal-btn-primary" id="wave-classifier-save">\u4fdd\u5b58</button>
            </div>
          </div>`;
        document.body.appendChild(dialog);
        const count = dialog.querySelector('#wave-classifier-count');
        count.max = String(classifier().maxClasses);
        count.addEventListener('input', () => {
          if (count.value !== '' && count.validity.valid) {
            draft = Array.from({ length: Number(count.value) }, (_, index) => draft[index] || '');
            renderRows();
          } else validateDraft();
        });
        dialog.querySelector('#wave-classifier-reset').addEventListener('click', () => {
          draft = classifier().defaults.slice();
          dialog.querySelector('#wave-classifier-enabled').checked = true;
          count.value = String(draft.length);
          renderRows();
        });
        dialog.querySelector('#wave-classifier-cancel').addEventListener('click', closeClassifier);
        dialog.querySelector('#wave-classifier-save').addEventListener('click', () => {
          if (validateDraft().error) return;
          const result = classifier().save(draft, dialog.querySelector('#wave-classifier-enabled').checked);
          if (result.persisted) closeClassifier();
          else dialog.querySelector('#wave-classifier-status').textContent =
            '\u5206\u7c7b\u5df2\u5e94\u7528\uff0c\u4f46\u6d4f\u89c8\u5668\u672a\u5141\u8bb8\u4fdd\u5b58\u8bbe\u7f6e\uff1b\u5173\u95ed\u9875\u9762\u540e\u5c06\u6062\u590d\u539f\u914d\u7f6e\u3002';
        });
        dialog.addEventListener('pointerdown', event => { backdrop = event.target === dialog; });
        dialog.addEventListener('click', event => {
          if (backdrop && event.target === dialog) closeClassifier();
          backdrop = false;
        });
        dialog.addEventListener('keydown', event => {
          event.stopPropagation();
          if (event.key === 'Escape') { event.preventDefault(); closeClassifier(); }
          if (event.key !== 'Tab') return;
          const controls = Array.from(dialog.querySelectorAll('input, button')).filter(el => !el.disabled);
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (document.activeElement === (event.shiftKey ? first : last)) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
          }
        });
      }
      draft = classifier().snapshot();
      dialog.querySelector('#wave-classifier-enabled').checked = classifier().isEnabled();
      const cycleKey = window.visualWaveDromShortcuts.label('cycleWave') || '\u5206\u7c7b\u5207\u6362\u5feb\u6377\u952e';
      dialog.querySelector('#wave-classifier-help').textContent = "\u9ed8\u8ba4\u5206\u4e3a 2345678= \u548c\u5176\u4f59\u5168\u90e8\u6ce2\u5f62\u4e24\u7c7b\u3002\u5355\u683c\u9009\u4e2d\u540e\u6309 {key} \u6216\u53cc\u51fb\uff0c\u53ef\u6309\u6240\u5c5e\u5206\u7c7b\u5faa\u73af\u5207\u6362\u3002\u53cc\u51fb\u65f6\u7b2c\u4e8c\u4e0b\u6309\u4f4f\u7ea6\u534a\u79d2\uff0c\u6253\u5f00\u5168\u90e8\u6ce2\u5f62\u83dc\u5355\uff1a\u6bcf\u4e2a\u5206\u7c7b\u5360\u4e00\u5217\uff0c\u672a\u5206\u7c7b\u7684\u653e\u5728\u6700\u540e\u4e00\u5217\u3002\u677e\u5f00\u540e\u53ef\u8de8\u5206\u7c7b\u70b9\u51fb\u9009\u62e9\uff1b\u5206\u7c7b\u8f83\u591a\u65f6\u53ef\u6a2a\u5411\u6eda\u52a8\u3002\u70b9\u51fb\u83dc\u5355\u5916\u6216\u6309 Esc \u53ef\u5173\u95ed\u83dc\u5355\u5e76\u53d6\u6d88\u9009\u533a\u3002\u672a\u5206\u7c7b\u6ce2\u5f62\u4e0d\u5faa\u73af\u5207\u6362\uff0c\u4f46\u53ef\u4ee5\u6253\u5f00\u83dc\u5355\u3002\u6587\u672c\u7f16\u8f91\u3001\u753b\u7b14\u3001\u5206\u7ec4\u53ca\u8fde\u63a5\u9009\u70b9\u65f6\u4e0d\u89e6\u53d1\u3002".replace('{key}', cycleKey);
      dialog.querySelector('#wave-classifier-count').value = String(draft.length);
      dialog.querySelector('#wave-classifier-help').textContent += '\u5173\u95ed\u5206\u7c7b\u5668\u540e\uff0c\u4e0a\u8ff0\u5feb\u6377\u952e\u548c\u9f20\u6807\u5207\u6362\u5747\u4e0d\u89e6\u53d1\uff0c\u666e\u901a\u6ce2\u5f62\u6309\u94ae\u4ecd\u53ef\u4f7f\u7528\u3002\u70b9\u51fb\u4fdd\u5b58\u540e\u751f\u6548\u3002';
      renderRows();
      modal.hidden = true;
      dialog.hidden = false;
      dialog.querySelector('.modal-body').scrollTop = 0;
      dialog.querySelector('input').focus({ preventScroll: true });
    });
  }

  function initSidebarMenus() {
    const sidebar = document.getElementById('sidebar');
    const key = 'visualwavedrom.ui.menus.v1';
    const menus = ['functions', 'wave'].map(name => ({
      name,
      checkbox: document.getElementById('sidebar-' + name + '-visible'),
      column: document.getElementById('sidebar-' + name + '-column')
    }));
    if (!sidebar || menus.some(menu => !menu.checkbox || !menu.column)) return;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(key)) || {}; } catch (_error) { /* Both menus default to visible. */ }
    menus.forEach(menu => { menu.checkbox.checked = saved[menu.name] !== false; });
    const applyMenus = () => {
      // Parameter tables retain their own wave-menu visibility until the user returns.
      menus.forEach(menu => { if (!menu.checkbox.disabled) menu.column.hidden = !menu.checkbox.checked; });
      sidebar.style.setProperty('--sidebar-menu-count', Math.max(1, menus.filter(menu => menu.checkbox.checked).length));
    };
    menus.forEach(menu => menu.checkbox.addEventListener('change', () => {
      applyMenus();
      try { localStorage.setItem(key, JSON.stringify(Object.fromEntries(menus.map(item => [item.name, item.checkbox.checked])))); }
      catch (_error) { /* Visibility still works when browser storage is unavailable. */ }
    }));
    applyMenus();
  }

  function init() {
    initSidebarMenus();
    const probes = document.createElement('div');
    probes.className = 'ui-font-probes';
    probes.setAttribute('aria-hidden', 'true');
    browserProbe = document.createElement('span');
    browserProbe.style.font = 'initial';
    systemProbe = document.createElement('span');
    systemProbe.style.font = 'menu';
    if (!systemProbe.style.font) systemProbe.style.font = 'initial';
    probes.append(browserProbe, systemProbe);
    document.body.appendChild(probes);
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(scheduleMeasure);
      observer.observe(browserProbe);
      observer.observe(systemProbe);
    }

    modal = document.getElementById('ui-settings-modal');
    trigger = document.getElementById('btn-settings');
    autoInput = document.getElementById('ui-font-auto');
    scaleInput = document.getElementById('ui-font-scale');
    percentInput = document.getElementById('ui-font-percent');
    sizeOutput = document.getElementById('ui-font-size');
    statusOutput = document.getElementById('ui-settings-status');
    if (modal && trigger) {
      trigger.addEventListener('click', open);
      autoInput.addEventListener('change', () => {
        settings.automatic = autoInput.checked;
        saveAndApply();
      });
      scaleInput.addEventListener('input', () => {
        settings.scale = Number(scaleInput.value);
        percentInput.value = String(settings.scale);
        saveAndApply();
      });
      percentInput.addEventListener('input', () => {
        const value = Number(percentInput.value);
        if (!Number.isFinite(value) || value < 80 || value > 200) return;
        settings.scale = Math.round(value);
        saveAndApply();
      });
      percentInput.addEventListener('blur', () => {
        percentInput.value = String(settings.scale);
      });
      document.getElementById('ui-settings-done').addEventListener('click', close);
      const shortcutsButton = document.getElementById('ui-settings-shortcuts');
      if (shortcutsButton) shortcutsButton.addEventListener('click', () => {
        if (!window.visualWaveDromShortcuts) return;
        modal.hidden = true;
        window.visualWaveDromShortcuts.open(() => {
          modal.hidden = false;
          shortcutsButton.focus({ preventScroll: true });
        });
      });
      if (shortcutsButton) addClassifierSettings();
      document.getElementById('ui-settings-reset').addEventListener('click', () => {
        settings = Object.assign({}, defaults);
        percentInput.value = String(settings.scale);
        saveAndApply();
      });
      modal.addEventListener('pointerdown', (event) => { backdropPress = event.target === modal; });
      modal.addEventListener('click', (event) => {
        if (event.target === modal && backdropPress) close();
        backdropPress = false;
      });
      modal.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
        } else if (event.key === 'Tab') {
          const controls = Array.from(modal.querySelectorAll('button, input')).filter((element) => !element.disabled);
          const next = event.shiftKey ? controls[controls.length - 1] : controls[0];
          const boundary = event.shiftKey ? controls[0] : controls[controls.length - 1];
          if (document.activeElement === boundary) {
            event.preventDefault();
            next.focus();
          }
        }
      });
    }
    try {
      channel = new BroadcastChannel(STORAGE_KEY);
      channel.addEventListener('message', (event) => {
        settings = normalize(event.data);
        apply();
      });
    } catch (_error) { /* Storage events still synchronize supported browser windows. */ }
    apply();
  }

  root.style.fontSize = settings.scale + '%';
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    settings = readSettings();
    apply();
  });
  window.addEventListener('focus', scheduleMeasure);
  window.addEventListener('resize', scheduleMeasure);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleMeasure();
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();

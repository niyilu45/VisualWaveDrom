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

  function init() {
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

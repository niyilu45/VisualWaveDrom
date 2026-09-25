(function () {
  'use strict';

  function init() {
    const sidebar = document.getElementById('sidebar');
    const dock = document.getElementById('sidebar-dock');
    const menus = dock && dock.querySelector('.sidebar-menus');
    const tabs = document.getElementById('sidebar-dock-tabs');
    if (!sidebar || !menus || !tabs) return;
    const storageKey = 'visualwavedrom.ui.dock.v1';
    const names = ['functions', 'wave'];
    let state = { mode: 'horizontal', order: names.slice(), active: 'functions' };
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      if (saved && ['horizontal', 'vertical', 'tabs'].includes(saved.mode)) {
        state.mode = saved.mode;
        if (Array.isArray(saved.order) && saved.order.length === 2
            && names.every(name => saved.order.includes(name))) state.order = saved.order;
        if (names.includes(saved.active)) state.active = saved.active;
      }
    } catch (_error) { /* The old checkbox preferences do not hide either docked menu. */ }

    let drag = null;
    let blockClickUntil = 0;
    const panels = new Map();
    const grip = '<svg class="lucide lucide-grip-vertical" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">'
      + '<circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/>'
      + '<circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>';
    const parameterPage = () => document.body.classList.contains('parameter-page-active');
    const persist = () => {
      try { localStorage.setItem(storageKey, JSON.stringify(state)); }
      catch (_error) { /* Layout changes remain usable without persistent storage. */ }
    };

    const targets = document.createElement('div');
    targets.className = 'sidebar-dock-targets';
    targets.hidden = true;
    targets.setAttribute('role', 'group');
    targets.setAttribute('aria-label', '\u83dc\u5355\u653e\u7f6e\u4f4d\u7f6e');
    const zones = new Map();
    [['top', '\u4e0a\u65b9'], ['left', '\u5de6\u4fa7'], ['tabs', '\u5206\u9875'], ['right', '\u53f3\u4fa7'], ['bottom', '\u4e0b\u65b9']].forEach(([zone, label]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sidebar-dock-target';
      button.dataset.zone = zone;
      button.textContent = label;
      button.addEventListener('click', () => { if (drag && drag.pointerId === null) finish(zone); });
      targets.appendChild(button);
      zones.set(zone, button);
    });
    dock.appendChild(targets);

    function render() {
      const single = parameterPage();
      const mode = single ? 'single' : state.mode;
      sidebar.dataset.layout = mode;
      sidebar.style.setProperty('--sidebar-menu-count', mode === 'horizontal' ? 2 : 1);
      tabs.hidden = mode !== 'tabs';
      state.order.forEach((name, index) => {
        const panel = panels.get(name);
        const scroll = panel.content.scrollTop;
        if (menus.children[index] !== panel.element) menus.insertBefore(panel.element, menus.children[index] || null);
        if (tabs.children[index] !== panel.tab) tabs.insertBefore(panel.tab, tabs.children[index] || null);
        panel.element.hidden = single ? name !== 'functions' : mode === 'tabs' && name !== state.active;
        panel.element.setAttribute('role', mode === 'tabs' ? 'tabpanel' : 'region');
        panel.element.setAttribute('aria-labelledby', mode === 'tabs' ? panel.tab.id : panel.handle.id);
        panel.handle.disabled = single;
        panel.tab.setAttribute('aria-selected', String(name === state.active));
        panel.tab.tabIndex = name === state.active ? 0 : -1;
        if (!panel.element.hidden) panel.content.scrollTop = panel.scrollTop ?? scroll;
      });
    }

    function highlight(zone) {
      if (!drag || drag.zone === zone) return;
      drag.zone = zone;
      zones.forEach((button, key) => { button.dataset.active = String(key === zone); });
    }

    function zoneAt(x, y) {
      const rect = drag.bounds;
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
      const relativeX = (x - rect.left) / rect.width;
      const relativeY = (y - rect.top) / rect.height;
      if (relativeY < 0.22) return 'top';
      if (relativeY > 0.78) return 'bottom';
      if (relativeX < 0.25) return 'left';
      if (relativeX > 0.75) return 'right';
      return 'tabs';
    }

    function showTargets() {
      targets.hidden = false;
      targets.setAttribute('aria-label', '\u653e\u7f6e' + panels.get(drag.source).label);
      sidebar.classList.toggle('is-docking', drag.pointerId !== null);
    }

    function finish(zone) {
      if (!drag) return;
      const completed = drag;
      drag = null;
      targets.hidden = true;
      sidebar.classList.remove('is-docking');
      zones.forEach(button => { delete button.dataset.active; });
      if (completed.pointerId !== null) {
        try { completed.handle.releasePointerCapture(completed.pointerId); } catch (_error) { /* Already released. */ }
      }
      if (completed.moved) blockClickUntil = performance.now() + 200;
      if (zone && !parameterPage()) {
        state.active = completed.source;
        if (zone === 'tabs') state.mode = 'tabs';
        else {
          state.mode = zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical';
          const other = names.find(name => name !== completed.source);
          state.order = zone === 'left' || zone === 'top' ? [completed.source, other] : [other, completed.source];
        }
        render();
        persist();
      }
      if (completed.moved) {
        const panel = panels.get(completed.source);
        const control = state.mode === 'tabs' ? panel.tab : panel.handle;
        if (control.getClientRects().length) control.focus({ preventScroll: true });
      }
    }

    function chooseLayout(name, handle) {
      if (parameterPage()) return;
      finish(null);
      drag = { source: name, handle, pointerId: null, moved: true, zone: null, bounds: dock.getBoundingClientRect() };
      showTargets();
      highlight('tabs');
      zones.get('tabs').focus({ preventScroll: true });
    }

    names.forEach(name => {
      const element = document.getElementById('sidebar-' + name + '-column');
      const heading = element.querySelector('.menu-section-title');
      const label = heading.textContent;
      heading.remove();
      const content = document.createElement('div');
      content.className = 'sidebar-panel-content';
      while (element.firstChild) content.appendChild(element.firstChild);
      const handle = document.createElement('button');
      handle.type = 'button';
      handle.className = 'sidebar-panel-handle';
      handle.id = 'sidebar-' + name + '-handle';
      handle.dataset.panel = name;
      handle.innerHTML = grip;
      handle.appendChild(document.createTextNode(label));
      handle.title = '\u62d6\u52a8\u8c03\u6574\u4e0a\u4e0b\u3001\u5de6\u53f3\u6216\u5206\u9875\u5e03\u5c40\uff1b\u5355\u51fb\u9009\u62e9\u4f4d\u7f6e';
      const tab = handle.cloneNode(true);
      tab.id = 'sidebar-' + name + '-tab';
      tab.className = 'sidebar-dock-tab';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', element.id);
      tab.title = '\u5355\u51fb\u5207\u6362\u83dc\u5355\uff1b\u62d6\u52a8\u8c03\u6574\u5e03\u5c40\uff1bAlt+Enter \u9009\u62e9\u4f4d\u7f6e';
      element.append(handle, content);
      tabs.appendChild(tab);
      const panel = { element, label, handle, tab, content, scrollTop: 0 };
      panels.set(name, panel);
      content.addEventListener('scroll', () => { if (!element.hidden) panel.scrollTop = content.scrollTop; }, { passive: true });
      [handle, tab].forEach(control => {
        control.addEventListener('pointerdown', event => {
          if (event.button !== 0 || !event.isPrimary || parameterPage()) return;
          finish(null);
          drag = { source: name, handle: control, pointerId: event.pointerId, moved: false, zone: null,
            x: event.clientX, y: event.clientY, bounds: dock.getBoundingClientRect() };
          control.setPointerCapture(event.pointerId);
        });
        control.addEventListener('lostpointercapture', event => {
          if (drag && drag.pointerId === event.pointerId) finish(null);
        });
        control.addEventListener('click', event => {
          if (performance.now() < blockClickUntil) { event.preventDefault(); return; }
          if (control === tab) { state.active = name; render(); persist(); }
          else chooseLayout(name, control);
        });
        control.addEventListener('keydown', event => {
          if (event.altKey && event.key === 'Enter') {
            event.preventDefault();
            chooseLayout(name, control);
          } else if (control === tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const index = state.order.indexOf(name);
            state.active = state.order[event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index];
            render(); persist();
            panels.get(state.active).tab.focus({ preventScroll: true });
          }
        });
      });
    });

    window.addEventListener('pointermove', event => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
      if (!drag.moved) { drag.moved = true; showTargets(); }
      event.preventDefault();
      highlight(zoneAt(event.clientX, event.clientY));
    }, { passive: false });
    window.addEventListener('pointerup', event => {
      if (drag && drag.pointerId === event.pointerId) finish(drag.moved ? zoneAt(event.clientX, event.clientY) : null);
    });
    window.addEventListener('pointercancel', event => { if (drag && drag.pointerId === event.pointerId) finish(null); });
    window.addEventListener('keydown', event => {
      if (!drag || !drag.moved) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); finish(null); }
      else if (drag.pointerId === null) {
        const zone = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'top', ArrowDown: 'bottom', Home: 'tabs' }[event.key];
        if (zone) { event.preventDefault(); event.stopImmediatePropagation(); highlight(zone); zones.get(zone).focus(); }
        else if (event.key === 'Tab') {
          event.preventDefault(); event.stopImmediatePropagation();
          const keys = Array.from(zones.keys());
          const next = keys[(keys.indexOf(drag.zone) + (event.shiftKey ? -1 : 1) + keys.length) % keys.length];
          highlight(next); zones.get(next).focus();
        }
      }
    }, true);
    document.addEventListener('pointerdown', event => {
      if (drag && drag.pointerId === null && !targets.contains(event.target)) finish(null);
    }, true);
    window.addEventListener('blur', () => finish(null));
    window.addEventListener('resize', () => finish(null));
    window.addEventListener('vwd-directory-page-change', () => { finish(null); render(); });
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();

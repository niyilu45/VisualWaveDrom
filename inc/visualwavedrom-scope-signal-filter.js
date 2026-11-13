(function (global) {
  'use strict';

  function open(button, signals, hidden, apply) {
    const doc = button.ownerDocument;
    if (doc.querySelector('.scope-signal-filter-card')) return;
    const draft = new Set(signals.filter(signal => hidden.has(signal.id)).map(signal => signal.id));
    const card = doc.createElement('dialog');
    card.className = 'scope-signal-filter-card';
    card.setAttribute('aria-label', '信号筛选');
    card.innerHTML = `
      <form>
        <strong>信号筛选</strong>
        <label class="scope-filter-search">信号名（正则）
          <input type="search" autocomplete="off" spellcheck="false">
        </label>
        <label class="scope-filter-all"><input type="checkbox">全选匹配信号</label>
        <div class="scope-filter-list" role="group" aria-label="匹配信号"></div>
        <output class="scope-filter-status" aria-live="polite"></output>
        <footer><button type="button">取消</button><button type="submit">确定</button></footer>
      </form>`;
    const search = card.querySelector('input[type="search"]');
    const all = card.querySelector('.scope-filter-all input');
    const list = card.querySelector('.scope-filter-list');
    const status = card.querySelector('output');
    let matches = [], invalid = false;

    function updateSelection() {
      const checked = matches.reduce((count, signal) => count + Number(!draft.has(signal.id)), 0);
      all.disabled = !matches.length;
      all.checked = matches.length > 0 && checked === matches.length;
      all.indeterminate = checked > 0 && checked < matches.length;
      status.textContent = invalid ? '正则表达式无效' : matches.length
        ? '匹配 ' + matches.length + ' 项 · 共勾选 ' + (signals.length - draft.size) + ' 项'
        : '无匹配信号 · 共勾选 ' + (signals.length - draft.size) + ' 项';
    }

    function render() {
      let regex;
      try { regex = new RegExp(search.value); } catch (_) { regex = null; }
      invalid = !regex;
      search.setAttribute('aria-invalid', String(invalid));
      matches = regex ? signals.filter(signal => regex.test(signal.name)) : [];
      const fragment = doc.createDocumentFragment();
      matches.forEach(signal => {
        const label = doc.createElement('label');
        const input = doc.createElement('input');
        input.type = 'checkbox';
        input.checked = !draft.has(signal.id);
        input.addEventListener('change', () => {
          if (input.checked) draft.delete(signal.id);
          else draft.add(signal.id);
          updateSelection();
        });
        label.append(input, signal.name);
        fragment.append(label);
      });
      list.replaceChildren(fragment);
      list.scrollTop = 0;
      card.querySelector('[type="submit"]').disabled = invalid;
      updateSelection();
    }

    search.addEventListener('input', render);
    all.addEventListener('change', () => {
      matches.forEach((signal, index) => {
        if (all.checked) draft.delete(signal.id);
        else draft.add(signal.id);
        list.children[index].firstElementChild.checked = all.checked;
      });
      updateSelection();
    });
    // Keep Escape and text entry local to the filter, including in the comparison popup.
    card.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault();
        card.close();
      }
    });
    card.querySelector('[type="button"]').addEventListener('click', () => card.close());
    card.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      if (!invalid) { card.close(); apply(draft); }
    });
    card.addEventListener('close', () => {
      card.remove();
      button.setAttribute('aria-expanded', 'false');
      button.focus({ preventScroll: true });
    }, { once: true });
    doc.body.append(card);
    button.setAttribute('aria-expanded', 'true');
    render();
    card.showModal();
    search.focus();
  }

  global.VisualWaveDromScopeSignalFilter = { open };
})(window);

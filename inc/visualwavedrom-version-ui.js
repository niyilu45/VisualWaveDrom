(function () {
  'use strict';
  const version = window.VisualWaveDromVersion && window.VisualWaveDromVersion.version || '\u672a\u6807\u8bb0';
  const serviceMode = /^https?:$/.test(location.protocol);
  const modal = document.getElementById('tool-version-modal');
  const input = document.getElementById('tool-version-directory');
  const status = document.getElementById('tool-version-status');
  const save = document.getElementById('tool-version-save');
  const pick = document.getElementById('tool-version-pick');
  const current = document.getElementById('tool-version-use-current');
  const messages = {
    unregistered: '\u5c1a\u672a\u6307\u5b9a\u6700\u65b0\u7248\u672c\u5b58\u653e\u76ee\u5f55\u3002',
    equal: '\u5f53\u524d\u7248\u672c\u4e0e\u8bb0\u5f55\u76ee\u5f55\u4e2d\u7684\u7248\u672c\u4e00\u81f4\uff0c\u542f\u52a8\u65f6\u4e0d\u4f1a\u63d0\u793a\u66f4\u65b0\u3002',
    publish: '\u5f53\u524d\u526f\u672c\u8f83\u65b0\uff0c\u4e0b\u6b21\u542f\u52a8 BAT / SH \u65f6\u4f1a\u8be2\u95ee\u662f\u5426\u66f4\u65b0\u8bb0\u5f55\u76ee\u5f55\u3002',
    upgrade: '\u8bb0\u5f55\u76ee\u5f55\u4e2d\u7684\u7248\u672c\u8f83\u65b0\uff0c\u4e0b\u6b21\u542f\u52a8 BAT / SH \u65f6\u4f1a\u8be2\u95ee\u662f\u5426\u5347\u7ea7\u5f53\u524d\u526f\u672c\u3002',
    unavailable: '\u8bb0\u5f55\u76ee\u5f55\u65e0\u6cd5\u7528\u4e8e\u66f4\u65b0\uff0c\u8bf7\u91cd\u65b0\u6307\u5b9a\u3002',
    error: '\u7248\u672c\u4fe1\u606f\u65e0\u6cd5\u8bfb\u53d6\u3002'
  };
  let info = null;
  let token = '';
  let previous = null;
  let parentModal = null;
  let busy = false;
  let backdropPress = false;
  let historyData = window.VisualWaveDromVersion && window.VisualWaveDromVersion.history || [];
  const historyPanel = document.getElementById('tool-version-history');
  const historyBody = document.getElementById('tool-version-history-body');

  function renderHistory() {
    historyBody.replaceChildren();
    if (!historyData.length) { historyBody.textContent = '\u8fd9\u4e24\u4e2a\u7248\u672c\u7684\u5de5\u5177\u5305\u6ca1\u6709\u63d0\u4f9b\u5bf9\u5e94\u7684\u63d0\u4ea4\u5386\u53f2\u3002'; return; }
    historyData.forEach(release => {
      const section = document.createElement('section');
      const title = document.createElement('h3');
      const date = new Date(release.date);
      title.textContent = 'v' + release.version + ' \u00b7 ' + (Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('zh-CN'));
      section.appendChild(title);
      if (release.baseline || release.uncommitted) {
        const note = document.createElement('p');
        note.textContent = [release.baseline ? '\u9996\u6b21\u7f16\u53f7\u53d1\u5e03\uff0c\u5305\u542b\u6b64\u524d\u7684\u57fa\u7ebf\u63d0\u4ea4\u3002' : '', release.uncommitted ? '\u542b\u672a\u63d0\u4ea4\u7684\u672c\u5730\u6539\u52a8\uff0c\u89c1\u529f\u80fd\u8bf4\u660e\u3002' : ''].join(' ').trim();
        section.appendChild(note);
      }
      const notes = document.createElement('ul');
      (release.notes || []).forEach(text => { const item = document.createElement('li'); item.textContent = text; notes.appendChild(item); });
      if (notes.children.length) section.appendChild(notes);
      (release.commits || []).forEach(commit => {
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = '[' + String(commit.id || '').slice(0,8) + '] ' + commit.title;
        const body = document.createElement('p');
        body.textContent = String(commit.date || '') + '\n' + (commit.body || '\u6b64\u63d0\u4ea4\u6ca1\u6709\u989d\u5916\u8bf4\u660e\u3002');
        details.append(summary, body);
        section.appendChild(details);
      });
      historyBody.appendChild(section);
    });
  }
  historyPanel.addEventListener('toggle', () => { if (historyPanel.open) renderHistory(); });
  document.getElementById('tool-version-label').textContent = 'v' + version;
  document.getElementById('tool-version-current').textContent = 'v' + version;

  function setBusy(value) {
    busy = value;
    save.disabled = value || !serviceMode || !token;
    pick.disabled = save.disabled;
    current.disabled = save.disabled;
    input.disabled = value || !serviceMode;
    modal.setAttribute('aria-busy', String(value));
  }

  async function request(payload) {
    const options = { cache: 'no-store' };
    if (payload) Object.assign(options, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-VWD-Version-Token': token }, body: JSON.stringify(payload)
    });
    const response = await fetch('/api/tool-version', options);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '\u7248\u672c\u8bbe\u7f6e\u8bfb\u53d6\u5931\u8d25');
    return result;
  }

  function render(result) {
    info = result;
    token = result.token || '';
    historyData = result.history || [];
    document.getElementById('tool-version-history-range').textContent = result.record.version && result.record.version !== result.current
      ? '\u7248\u672c\u533a\u95f4\uff1av' + result.current + ' \u2194 v' + result.record.version
      : '\u5de5\u5177\u5305\u5185\u7684\u7248\u672c\u5386\u53f2';
    if (historyPanel.open) renderHistory();
    input.value = result.record.directory || '';
    document.getElementById('tool-version-root').textContent = result.root;
    document.getElementById('tool-version-recorded').textContent = result.record.version ? 'v' + result.record.version : '\u672a\u8bb0\u5f55';
    status.textContent = (messages[result.state] || '') + (result.message ? '\n' + result.message : '');
  }

  async function open() {
    previous = document.activeElement;
    parentModal = document.getElementById('ui-settings-modal');
    if (parentModal.hidden) parentModal = null;
    if (parentModal) parentModal.hidden = true;
    modal.hidden = false;
    historyPanel.open = false;
    document.getElementById('tool-version-close').focus({ preventScroll: true });
    setBusy(true);
    try {
      if (!serviceMode) {
        status.textContent = '\u76f4\u63a5\u6253\u5f00 HTML \u65f6\u4ec5\u663e\u793a\u7248\u672c\u3002\u8bf7\u8fd0\u884c BAT / SH \u540e\u8bbe\u7f6e\u672c\u673a\u7248\u672c\u76ee\u5f55\u3002';
        document.getElementById('tool-version-root').textContent = location.pathname;
        return;
      }
      status.textContent = '\u6b63\u5728\u8bfb\u53d6\u672c\u673a\u7248\u672c\u8bb0\u5f55...';
      render(await request());
    } catch (error) { status.textContent = '\u65e0\u6cd5\u8bfb\u53d6\u7248\u672c\u4fe1\u606f\uff1a' + error.message; }
    finally { setBusy(false); }
  }

  function close() {
    if (busy) return;
    modal.hidden = true;
    if (parentModal) parentModal.hidden = false;
    if (previous && previous.isConnected) previous.focus({ preventScroll: true });
  }

  document.getElementById('tool-version-label').addEventListener('click', open);
  document.getElementById('ui-settings-version').addEventListener('click', open);
  document.getElementById('tool-version-close').addEventListener('click', close);
  current.addEventListener('click', () => { if (info) input.value = info.root; });
  pick.addEventListener('click', async () => {
    setBusy(true);
    try {
      const result = await request({ pick: true, directory: input.value || info.root });
      if (!result.canceled) input.value = result.directory;
    } catch (error) { status.textContent = '\u65e0\u6cd5\u9009\u62e9\u6587\u4ef6\u5939\uff0c\u53ef\u76f4\u63a5\u7c98\u8d34\u8def\u5f84\uff1a' + error.message; }
    finally { setBusy(false); }
  });
  save.addEventListener('click', async () => {
    if (!input.value.trim()) { status.textContent = '\u8bf7\u6307\u5b9a\u6700\u65b0\u7248\u672c\u5b58\u653e\u76ee\u5f55\u3002'; input.focus(); return; }
    setBusy(true);
    try { render(await request({ directory: input.value.trim() })); status.textContent = '\u76ee\u5f55\u5df2\u4fdd\u5b58\u3002' + status.textContent; }
    catch (error) { status.textContent = '\u76ee\u5f55\u672a\u4fdd\u5b58\uff1a' + error.message; }
    finally { setBusy(false); }
  });
  modal.addEventListener('pointerdown', event => { backdropPress = event.target === modal; });
  modal.addEventListener('click', event => { if (event.target === modal && backdropPress) close(); backdropPress = false; });
  modal.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key !== 'Tab') return;
    const controls = Array.from(modal.querySelectorAll('button, input, summary')).filter(element => !element.disabled && element.getClientRects().length);
    const first = controls[0], last = controls[controls.length - 1];
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
})();

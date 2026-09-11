(function (root) {
  'use strict';

  function capabilities() {
    const item = root.ClipboardItem;
    const supports = function (type) {
      try { return typeof item.supports === 'function' ? item.supports(type) : null; }
      catch (_) { return null; }
    };
    return {
      asyncWrite: typeof item === 'function' && !!root.navigator.clipboard
        && typeof root.navigator.clipboard.write === 'function',
      html: supports('text/html'),
      png: supports('image/png'),
      secureContext: root.isSecureContext,
      focused: root.document.hasFocus(),
      userAgent: root.navigator.userAgent
    };
  }

  async function write(data, options) {
    options = options || {};
    const report = options.onAttempt || function () {};
    const entries = Object.entries(data);
    const resolved = Promise.all(entries.map(async function (entry) {
      return [entry[0], await entry[1]];
    })).then(function (values) { return Object.fromEntries(values); });
    // Observe render failures even when ClipboardItem rejects before consuming its promises.
    resolved.catch(function () {});
    const attempt = async function (method, payload) {
      const types = Object.keys(payload);
      try {
        await root.navigator.clipboard.write([new root.ClipboardItem(payload)]);
        report({ method, types, ok: true });
        return { method, types };
      } catch (error) {
        report({ method, types, ok: false, name: error.name, message: error.message });
        throw error;
      }
    };
    if (!capabilities().asyncWrite) {
      await resolved;
      throw new DOMException('This browser does not support rich clipboard writes', 'NotSupportedError');
    }
    try {
      return await attempt('async', data);
    } catch (_) {
      const blobs = await resolved;
      try {
        return await attempt('resolved-blobs', blobs);
      } catch (error) {
        if (!options.allowHtmlOnly || !blobs['text/html'] || !blobs['image/png']) throw error;
        // The PNG remains embedded in HTML; never downgrade a linked image to a plain PNG.
        const rich = { 'text/html': blobs['text/html'] };
        if (blobs['text/plain']) rich['text/plain'] = blobs['text/plain'];
        return attempt('html-image', rich);
      }
    }
  }

  function copyHtml(html, plainText) {
    const doc = root.document;
    const active = doc.activeElement;
    const selection = root.getSelection();
    const ranges = [];
    for (let i = 0; selection && i < selection.rangeCount; i++) ranges.push(selection.getRangeAt(i).cloneRange());
    const inputSelection = active && typeof active.selectionStart === 'number'
      ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
    const host = doc.createElement('div');
    host.contentEditable = 'true';
    host.textContent = plainText;
    host.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;';
    let handled = false;
    let copyError = null;
    const onCopy = function (event) {
      event.preventDefault();
      event.stopImmediatePropagation();
      try {
        if (!event.clipboardData) throw new Error('Clipboard event data is unavailable');
        event.clipboardData.setData('text/html', html);
        event.clipboardData.setData('text/plain', plainText);
        handled = true;
      } catch (error) { copyError = error; }
    };
    try {
      doc.body.appendChild(host);
      host.focus({ preventScroll: true });
      const range = doc.createRange();
      range.selectNodeContents(host);
      selection.removeAllRanges();
      selection.addRange(range);
      root.addEventListener('copy', onCopy, true);
      const copied = doc.execCommand('copy');
      if (copyError) throw copyError;
      if (!copied || !handled) throw new DOMException('Rich HTML copy was not permitted', 'NotAllowedError');
      return { method: 'copy-event', types: ['text/html', 'text/plain'] };
    } finally {
      root.removeEventListener('copy', onCopy, true);
      host.remove();
      if (active && active.isConnected) active.focus({ preventScroll: true });
      if (selection) {
        selection.removeAllRanges();
        ranges.forEach(function (range) { selection.addRange(range); });
      }
      if (inputSelection && active.isConnected) active.setSelectionRange.apply(active, inputSelection);
    }
  }

  root.VisualWaveDromImageClipboard = { capabilities, write, copyHtml };
})(window);

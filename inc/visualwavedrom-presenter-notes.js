(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VisualWaveDromPresenterNotes = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  class NotesWindow {
    constructor(options) {
      this.options = options;
      this.element = options.element;
      this.document = this.element.ownerDocument;
      this.anchor = this.document.createComment('presenter-notes-position');
      this.element.parentNode.insertBefore(this.anchor, this.element);
      this.window = null;
      this.opening = false;
      this.disposed = false;
      this.preferPictureInPicture = true;
      this.generation = 0;
      this.closeTimer = 0;
      this.boundWindowClose = (event) => {
        if (event.currentTarget === this.window) this.restore({ close: false, focus: false });
      };
      this.boundHostClose = () => this.restore({ focus: false });
      this.boundAppearance = () => this.refresh();
      root.addEventListener('pagehide', this.boundHostClose);
      root.addEventListener('vwd-ui-font-change', this.boundAppearance);
    }

    get detached() {
      return !!this.window;
    }

    notify(name, value) {
      if (typeof this.options[name] === 'function') this.options[name](value);
    }

    captureEditor() {
      const editor = this.element.querySelector('textarea');
      return editor ? {
        editor: editor, start: editor.selectionStart, end: editor.selectionEnd,
        direction: editor.selectionDirection, top: editor.scrollTop, left: editor.scrollLeft
      } : null;
    }

    restoreEditor(state, focus) {
      if (!state) return;
      if (focus) state.editor.focus({ preventScroll: true });
      state.editor.setSelectionRange(state.start, state.end, state.direction || 'none');
      state.editor.scrollTop = state.top;
      state.editor.scrollLeft = state.left;
    }

    prepareWindow(popup) {
      const doc = popup.document;
      doc.documentElement.lang = this.document.documentElement.lang || 'zh-CN';
      doc.body.className = 'presenter-notes-window';
      const charset = doc.createElement('meta');
      charset.setAttribute('charset', 'utf-8');
      doc.head.appendChild(charset);
      const viewport = doc.createElement('meta');
      viewport.name = 'viewport';
      viewport.content = 'width=device-width,initial-scale=1';
      doc.head.appendChild(viewport);
      this.document.querySelectorAll('link[rel="stylesheet"]').forEach(function (source) {
        if (!/\/visualwavedrom-(presenter|settings)\.css(?:[?#]|$)/.test(source.href)) return;
        try {
          if (source.sheet && source.sheet.cssRules) {
            const style = doc.createElement('style');
            style.textContent = Array.from(source.sheet.cssRules, function (rule) { return rule.cssText; }).join('\n');
            doc.head.appendChild(style);
            return;
          }
        } catch (_error) { /* file:// styles may be readable only through a link. */ }
        const link = doc.createElement('link');
        link.rel = 'stylesheet';
        link.href = source.href;
        doc.head.appendChild(link);
      });
    }

    refresh() {
      if (!this.window || this.window.closed) return;
      try {
        const doc = this.window.document;
        doc.title = typeof this.options.getTitle === 'function' ? this.options.getTitle() : 'VisualWaveDrom';
        doc.documentElement.style.fontSize = root.getComputedStyle(this.document.documentElement).fontSize;
      } catch (_error) { /* A navigated popup is returned by its pagehide handler. */ }
    }

    focus() {
      if (!this.window) return false;
      if (this.window.closed) {
        this.restore({ close: false });
        return false;
      }
      try { this.window.focus(); } catch (_error) { /* The browser controls window focus. */ }
      return true;
    }

    async open() {
      if (this.disposed || this.opening) return false;
      if (this.window && !this.window.closed) return this.focus();
      if (this.window) this.restore({ close: false, focus: false });
      const generation = ++this.generation;
      this.opening = true;
      this.notify('onPending', true);
      let popup = null;
      let kind = 'popup';
      try {
        const pip = root.documentPictureInPicture;
        if (this.preferPictureInPicture && pip && typeof pip.requestWindow === 'function') {
          try {
            popup = await pip.requestWindow({ width: 420, height: 560 });
            kind = 'picture-in-picture';
          } catch (_error) {
            this.preferPictureInPicture = false;
          }
        }
        if (this.disposed || generation !== this.generation) {
          if (popup && !popup.closed) popup.close();
          return false;
        }
        if (!popup) popup = root.open('', '_blank', 'popup=yes,width=420,height=560,resizable=yes,scrollbars=yes');
        if (!popup || popup.closed) throw new Error('popup-blocked');
        this.prepareWindow(popup);
        const editorState = this.captureEditor();
        this.window = popup;
        popup.addEventListener('pagehide', this.boundWindowClose);
        this.element.classList.add('is-floating');
        // Move the existing editor, keeping one copy of the notes and its input listeners.
        popup.document.body.appendChild(this.element);
        this.refresh();
        this.notify('onChange', true);
        this.notify('onOpen', kind);
        this.focus();
        this.restoreEditor(editorState, true);
        this.closeTimer = root.setInterval(() => {
          if (this.window && this.window.closed) this.restore({ close: false, focus: false });
        }, 500);
        return true;
      } catch (error) {
        if (this.window) this.restore({ focus: false });
        else if (popup && !popup.closed) popup.close();
        if (!this.disposed) this.notify('onError', error);
        return false;
      } finally {
        if (generation === this.generation) {
          this.opening = false;
          this.notify('onPending', false);
        }
      }
    }

    restore(options) {
      const opts = options || {};
      ++this.generation;
      this.opening = false;
      this.notify('onPending', false);
      const popup = this.window;
      if (!popup) return;
      this.window = null;
      root.clearInterval(this.closeTimer);
      this.closeTimer = 0;
      const editorState = this.captureEditor();
      if (this.anchor.parentNode) this.anchor.parentNode.insertBefore(this.element, this.anchor.nextSibling);
      this.element.classList.remove('is-floating');
      this.notify('onChange', false);
      this.restoreEditor(editorState, false);
      try {
        popup.removeEventListener('pagehide', this.boundWindowClose);
        if (opts.close !== false && !popup.closed) popup.close();
      } catch (_error) { /* The window may already have closed or navigated. */ }
      if (opts.focus !== false && !this.disposed) {
        try { root.focus(); } catch (_error) { /* The browser controls window focus. */ }
        this.restoreEditor(editorState, true);
      }
    }

    destroy() {
      this.disposed = true;
      this.restore({ focus: false });
      root.removeEventListener('pagehide', this.boundHostClose);
      root.removeEventListener('vwd-ui-font-change', this.boundAppearance);
      this.anchor.remove();
    }
  }

  return { create: function (options) { return new NotesWindow(options); } };
}));

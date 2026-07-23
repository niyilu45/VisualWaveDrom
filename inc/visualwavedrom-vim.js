(function (global) {
  'use strict';

  const REPEATABLE_ACTIONS = new Set([
    'delete-wave',
    'delete-row',
    'paste',
    'insert-wave',
    'replace-wave',
    'new-row',
    'move-row',
    'reorder-nav'
  ]);

  const WAVE_CHARACTERS = new Set(['p', '1', '0', '.', '|', '=', '2', '3', '4', '5', '6', '7', '8', '9', 'n', 'x', 'z']);

  function normalizeKey(event) {
    if (event.key === ' ') return '<Space>';
    if (event.key === 'Escape') return '<Esc>';
    if (event.key === 'Enter') return '<Enter>';
    if (event.key === 'Backspace') return '<Backspace>';
    if (event.key === 'Delete' || event.key === 'Del') return '<Delete>';
    if (event.key === '｜') return '|';
    if (event.shiftKey && event.code === 'Backslash') return '|';
    if (event.key === '[' && (event.ctrlKey || event.metaKey)) return '<C-[>';
    if (String(event.key || '').toLowerCase() === 'r' && (event.ctrlKey || event.metaKey)) return '<C-r>';
    return event.key;
  }

  class VisualWaveDromVimController {
    constructor(options) {
      this.options = options || {};
      this.enabled = false;
      this.mode = 'normal';
      this.scope = 'wave';
      this.visualKind = '';
      this.countBuffer = '';
      this.pending = '';
      this.pendingTimer = null;
      this.lastChange = null;
    }

    getState() {
      return {
        enabled: this.enabled,
        mode: this.mode,
        scope: this.scope,
        visualKind: this.visualKind,
        count: this.countBuffer,
        pending: this.pending,
        lastChange: this.lastChange
      };
    }

    setEnabled(enabled) {
      const next = !!enabled;
      if (next === this.enabled) return;
      this.enabled = next;
      this.mode = 'normal';
      this.visualKind = '';
      this.clearSequence();
      this.notify('enabled');
    }

    setMode(mode, visualKind) {
      const next = mode || 'normal';
      if (this.mode === next && (visualKind || '') === this.visualKind) return;
      this.mode = next;
      this.visualKind = next === 'visual' ? (visualKind || this.visualKind || 'cell') : '';
      this.clearSequence();
      this.notify('mode');
    }

    setScope(scope) {
      if (scope !== 'wave' || this.scope === 'wave') return;
      this.scope = 'wave';
      if (this.mode === 'visual') {
        this.mode = 'normal';
        this.visualKind = '';
      }
      this.clearSequence();
      this.notify('scope');
    }

    clearSequence() {
      this.countBuffer = '';
      this.pending = '';
      if (this.pendingTimer !== null) {
        clearTimeout(this.pendingTimer);
        this.pendingTimer = null;
      }
    }

    setPending(value) {
      this.pending = value;
      if (this.pendingTimer !== null) clearTimeout(this.pendingTimer);
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null;
        this.pending = '';
        this.countBuffer = '';
        this.notify('sequence-timeout');
      }, 1200);
      this.notify('pending');
    }

    notify(reason) {
      if (typeof this.options.onStateChange === 'function') {
        this.options.onStateChange(this.getState(), reason || 'change');
      }
    }

    getContext() {
      if (typeof this.options.getContext !== 'function') return { scope: this.scope };
      return Object.assign({ scope: this.scope }, this.options.getContext() || {});
    }

    consumeCount() {
      const value = Number.parseInt(this.countBuffer || '1', 10);
      this.countBuffer = '';
      return Number.isFinite(value) && value > 0 ? Math.min(value, 9999) : 1;
    }

    execute(action, payload, options) {
      const data = Object.assign({ count: this.consumeCount(), scope: this.scope }, payload || {});
      const cfg = options || {};
      let result = false;
      if (typeof this.options.execute === 'function') {
        result = this.options.execute(action, data);
      }
      if (!cfg.noRepeat && REPEATABLE_ACTIONS.has(action)) {
        this.lastChange = { action, payload: Object.assign({}, data) };
      }
      this.pending = '';
      this.notify('command');
      return result;
    }

    repeatLastChange() {
      if (!this.lastChange) return false;
      const descriptor = this.lastChange;
      const explicitCount = this.countBuffer ? this.consumeCount() : descriptor.payload.count;
      return this.execute(
        descriptor.action,
        Object.assign({}, descriptor.payload, { count: explicitCount }),
        { noRepeat: true }
      );
    }

    handlePendingKey(key, context) {
      const pending = this.pending;
      this.pending = '';
      if (this.pendingTimer !== null) {
        clearTimeout(this.pendingTimer);
        this.pendingTimer = null;
      }

      if (pending === 'g') {
        if (key === 'g') return this.execute('move-first', {}, { noRepeat: true });
        this.clearSequence();
        return false;
      }
      if (pending === '[' || pending === ']') {
        if (key === 'r') {
          return this.execute('move-row', { direction: pending === '[' ? -1 : 1 });
        }
        this.clearSequence();
        return false;
      }
      if (pending === 'd') {
        if (key === 'd') return this.execute('delete-row');
        this.clearSequence();
        return false;
      }
      if (pending === 'y') {
        if (key === 'y') return this.execute('yank-row', {}, { noRepeat: true });
        this.clearSequence();
        return false;
      }
      if (pending === 'r') {
        return this.execute('replace-wave', { char: key });
      }
      if (pending === 'leader') {
        const leaderActions = {
          g: ['group'],
          a: ['add-connection'],
          c: ['select-connection'],
          s: ['save-library'],
          f: ['format-json']
        };
        const command = leaderActions[key];
        if (!command) {
          this.clearSequence();
          return false;
        }
        return this.execute(command[0], command[1] || {}, { noRepeat: true });
      }
      return false;
    }

    handleReplaceMode(key) {
      if (key === '<Esc>' || key === '<C-[>' || key === 'R') {
        this.execute('escape', {}, { noRepeat: true });
        this.setMode('normal');
        return true;
      }
      if (WAVE_CHARACTERS.has(key)) return this.execute('replace-wave', { char: key });
      const motions = {
        h: 'left',
        j: 'down',
        k: 'up',
        l: 'right',
        w: 'next-change',
        b: 'previous-change',
        e: 'end-change'
      };
      if (motions[key]) return this.execute('move', { direction: motions[key], extend: false }, { noRepeat: true });
      if (key === '0') return this.execute('move-line-start', {}, { noRepeat: true });
      if (key === '$') return this.execute('move-line-end', {}, { noRepeat: true });
      if (key && key.length === 1) return this.execute('replace-wave', { char: key });
      return false;
    }

    handleInsertMode(key) {
      if (key === '<Backspace>' || key === '<Delete>') {
        this.execute(
          'insert-delete-wave',
          { direction: key === '<Backspace>' ? 'left' : 'right' },
          { noRepeat: true }
        );
        return true;
      }
      if (key && key.length === 1) {
        this.execute('insert-wave', { char: key });
        return true;
      }
      return false;
    }

    handleKeydown(event) {
      if (!this.enabled || !event || event.defaultPrevented || event.isComposing) return false;
      if (typeof this.options.shouldIgnore === 'function' && this.options.shouldIgnore(event)) return false;

      const key = normalizeKey(event);
      const context = this.getContext();

      if (key === '<Esc>' || key === '<C-[>') {
        this.execute('escape', {}, { noRepeat: true });
        this.setMode('normal');
        event.preventDefault();
        return true;
      }
      if (this.mode === 'command') return false;
      if (this.mode === 'insert') {
        const handled = this.handleInsertMode(key);
        if (handled) event.preventDefault();
        return !!handled;
      }
      if (this.mode === 'replace') {
        const handled = this.handleReplaceMode(key);
        if (handled) event.preventDefault();
        return !!handled;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) {
        if (key === '<C-r>') {
          this.execute('redo', {}, { noRepeat: true });
          event.preventDefault();
          return true;
        }
        return false;
      }

      if (this.pending) {
        const handled = this.handlePendingKey(key, context);
        if (handled) event.preventDefault();
        return !!handled;
      }

      if (/^[1-9]$/.test(key) || (key === '0' && this.countBuffer)) {
        this.countBuffer += key;
        this.notify('count');
        event.preventDefault();
        return true;
      }

      const extend = this.mode === 'visual';
      const motions = {
        h: 'left',
        j: 'down',
        k: 'up',
        l: 'right',
        w: 'next-change',
        b: 'previous-change',
        e: 'end-change'
      };
      let handled = true;

      if (motions[key]) {
        this.execute('move', { direction: motions[key], extend }, { noRepeat: true });
      } else if (key === '0') {
        this.execute('move-line-start', { extend }, { noRepeat: true });
      } else if (key === '$') {
        this.execute('move-line-end', { extend }, { noRepeat: true });
      } else if (key === 'G') {
        this.execute('move-last', { extend }, { noRepeat: true });
      } else if (key === 'g') {
        this.setPending('g');
      } else if (key === '[' || key === ']') {
        this.setPending(key);
      } else if (key === '<Space>') {
        this.setPending('leader');
      } else if (key === 'v') {
        if (this.mode === 'visual' && this.visualKind === 'cell') {
          this.execute('visual-stop', {}, { noRepeat: true });
          this.setMode('normal');
        } else {
          this.setMode('visual', 'cell');
          this.execute('visual-start', { kind: 'cell' }, { noRepeat: true });
        }
      } else if (key === 'V') {
        if (this.mode === 'visual' && this.visualKind === 'row') {
          this.execute('visual-stop', {}, { noRepeat: true });
          this.setMode('normal');
        } else {
          this.setMode('visual', 'row');
          this.execute('visual-start', { kind: 'row' }, { noRepeat: true });
        }
      } else if (key === 'o' && this.mode === 'visual') {
        this.execute('visual-swap', {}, { noRepeat: true });
      } else if (key === 'y' && (this.mode === 'visual' || context.hasWaveRange)) {
        this.execute('yank-selection', {}, { noRepeat: true });
        if (this.mode === 'visual') this.setMode('normal');
      } else if (key === 'd' && this.mode === 'visual') {
        this.execute('delete-selection');
        this.setMode('normal');
      } else if (key === 'd' && (context.hasGroup || context.hasEdge)) {
        this.execute('delete-context');
      } else if (key === 'd') {
        this.setPending('d');
      } else if (key === 'y') {
        this.setPending('y');
      } else if (key === 'x') {
        this.execute('delete-wave');
      } else if (key === 'p' || key === 'P') {
        this.execute('paste', { before: key === 'P' });
      } else if (key === 'r') {
        this.setPending('r');
      } else if (key === '|') {
        this.execute('replace-wave', { char: key });
      } else if (key === 'R') {
        this.execute('replace-start', {}, { noRepeat: true });
        this.setMode('replace');
      } else if (key === 't') {
        this.execute('edit-text', {}, { noRepeat: true });
      } else if (key === 'i') {
        this.execute('insert-start', {}, { noRepeat: true });
        this.setMode('insert');
      } else if (key === 'I' || key === 'A') {
        this.execute(
          'insert-start',
          { position: key === 'I' ? 'line-start' : 'line-append' },
          { noRepeat: true }
        );
        this.setMode('insert');
      } else if (key === 'o' || key === 'O') {
        this.execute('new-row', { before: key === 'O' });
      } else if (key === 'J' || key === 'K') {
        this.execute('move-row', { direction: key === 'K' ? -1 : 1 });
      } else if (key === '<Enter>') {
        this.execute('activate', {}, { noRepeat: true });
      } else if (key === 'u') {
        this.execute('undo', {}, { noRepeat: true });
      } else if (key === '.') {
        this.repeatLastChange();
      } else if (key === ':') {
        this.execute('open-command', {}, { noRepeat: true });
        this.setMode('command');
      } else if (key === '?') {
        this.execute('show-help', {}, { noRepeat: true });
      } else {
        handled = false;
      }

      if (handled) event.preventDefault();
      return handled;
    }
  }

  global.VisualWaveDromVim = {
    Controller: VisualWaveDromVimController
  };
})(window);

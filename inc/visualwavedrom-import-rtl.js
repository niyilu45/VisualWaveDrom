(function (root) {
  'use strict';

  const scriptURL = typeof document !== 'undefined' && document.currentScript.src;
  const maxBytes = 128 * 1024 * 1024;
  const units = { fs: 1n, ps: 1000n, ns: 1000000n, us: 1000000000n, ms: 1000000000000n, s: 1000000000000000n };
  const unitlessScale = 1000000000000n;
  const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
  const fail = (message) => { throw new Error(message); };

  function reader() {
    const rows = new Map();
    let now = 0n;
    let grid = 0n;
    let points = 0;
    return {
      row(name, width) {
        if (!name || rows.has(name)) fail('信号名为空或重复：' + name);
        if (rows.size >= 4096) fail('信号超过 4096 条，请缩小导出范围');
        const row = { name, width, times: [0n], values: ['x'], bus: width > 1 };
        rows.set(name, row);
        return row;
      },
      time(t) {
        if (t < now) fail('时间戳不是单调递增：' + t);
        if (t !== now) grid = gcd(grid, t - now);
        now = t;
      },
      value(row, value) {
        const last = row.times.length - 1;
        if (!/^[01xz]$/i.test(String(value))) row.bus = true;
        if (row.times[last] === now) {
          if (last && row.values[last - 1] === value) {
            row.times.pop();
            row.values.pop();
            points -= 1;
          } else row.values[last] = value;
        } else if (row.values[last] !== value) {
          if (++points > 2000000) fail('变化点超过 200 万，请缩小导出范围');
          row.times.push(now);
          row.values.push(value);
        }
      },
      finish(format, unit, scale, defaultGrid = 1n, cycleAxis = false) {
        if (!rows.size) fail('文件中没有可导入的信号');
        const step = cycleAxis ? gcd(grid, unitlessScale) : (grid || defaultGrid);
        const totalSamples = Number(now / step + 1n);
        if (!Number.isSafeInteger(totalSamples)) fail('时间跨度超过可表示范围');
        const duration = step * scale;
        const info = { format, step: unit === 'cycle' ? decimal(duration, unitlessScale) : String(duration), unit: unit === 'cycle' ? unit : unit === 'tick' ? unit : 'fs' };
        const updates = [...rows.values()].map((row) => ({
          signal: row.name, wave: '', data: [], sampleKind: 'bus',
          changePoints: { protocol: 1, sampleStep: 1, totalSamples, indices: row.times.map(t => Number(t / step)), values: row.values },
          sparseImport: { data: row.bus, numeric: row.bus },
          rtlImport: info
        }));
        return { updates, totalSamples, info };
      }
    };
  }

  function decimal(value, scale) {
    const remainder = value % scale;
    return String(value / scale) + (remainder ? '.' + String(scale + remainder).slice(1).replace(/0+$/, '') : '');
  }

  function busValue(bits, width) {
    bits = bits.toLowerCase();
    if (width === 1) return bits.slice(-1);
    if (/^x+$/.test(bits)) return 'x';
    if (/^z+$/.test(bits)) return 'z';
    const padding = /^[xz]/.test(bits) ? bits[0] : '0';
    bits = bits.padStart(width || 0, padding);
    if (/[xz]/.test(bits)) return '0b' + bits;
    const integer = BigInt('0b' + bits);
    return integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : '0x' + integer.toString(16);
  }

  function readVCD(text) {
    const r = reader(), scopes = [], codes = new Map();
    const tokens = text.matchAll(/\S+/g);
    const next = () => tokens.next().value?.[0];
    const directive = () => {
      const args = [];
      for (let t; (t = next()) !== '$end';) {
        if (t === undefined) fail('VCD 指令缺少 $end');
        if (args.length < 512) args.push(t);
      }
      return args;
    };
    let definitions = false, scale = null;
    for (let t; (t = next()) !== undefined;) {
      if (t[0] === '$') {
        if (definitions && /^\$(?:end|dumpvars|dumpall|dumpon|dumpoff)$/.test(t)) continue;
        const args = directive();
        if (t === '$scope' && !definitions) scopes.push(args[1]);
        else if (t === '$upscope' && !definitions) scopes.pop();
        else if (t === '$timescale') {
          const m = args.join('').match(/^(\d+)(fs|ps|ns|us|ms|s)$/i);
          if (!m || BigInt(m[1]) === 0n) fail('VCD $timescale 无效');
          scale = BigInt(m[1]) * units[m[2].toLowerCase()];
        } else if (t === '$enddefinitions') definitions = true;
        else if (t === '$var' && !definitions) {
          const [, widthText, code, signal] = args;
          const width = Number(widthText);
          if (!signal || !code || !Number.isInteger(width) || width < 1 || width > 65536) fail('VCD 信号声明无效');
          const row = r.row([...scopes, signal + (args[4] || '')].join('.'), width);
          if (!codes.has(code)) codes.set(code, []);
          codes.get(code).push(row);
        }
        continue;
      }
      if (!definitions) fail('VCD 缺少 $enddefinitions');
      if (/^#\d+$/.test(t)) { r.time(BigInt(t.slice(1))); continue; }
      const kind = t[0].toLowerCase();
      const vector = /[brs]/.test(kind);
      const id = vector ? next() : t.slice(1);
      const targets = codes.get(id);
      if (!targets) fail('VCD 引用了未声明的信号：' + (id || t));
      for (const row of targets) {
        if (kind === 'b' && /^[01xz]+$/i.test(t.slice(1))) r.value(row, busValue(t.slice(1), row.width));
        else if (kind === 'r' && t.length > 1 && Number.isFinite(Number(t.slice(1)))) { row.bus = true; r.value(row, Number(t.slice(1))); }
        else if (kind === 's') { row.bus = true; r.value(row, t.slice(1)); }
        else if (/^[01xz]$/.test(kind)) r.value(row, kind);
        else fail('VCD 信号值无效：' + t);
      }
    }
    if (!definitions) fail('VCD 缺少 $enddefinitions');
    return r.finish('VCD', scale == null ? 'tick' : 'fs', scale || 1n);
  }

  function tableCells(line, delimiter) {
    if (delimiter === ' ') return (line.match(/"(?:[^"]|"")*"|[^\s]+/g) || []).map(cell => cell.replace(/^"|"$/g, '').replace(/""/g, '"'));
    if (delimiter === '|') line = line.trim().replace(/^\||\|$/g, '');
    const result = [];
    let cell = '', quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"') {
        if (quoted && line[i + 1] === '"') { cell += '"'; i += 1; }
        else if (quoted || !cell.trim()) quoted = !quoted;
        else cell += char;
      } else if (char === delimiter && !quoted) { result.push(cell.trim()); cell = ''; }
      else cell += char;
    }
    if (quoted) fail('表格中有未闭合的引号');
    result.push(cell.trim());
    return result;
  }

  const timeHeader = /^(?:time(?:stamp)?|cycle|序号|时间)(?:[\s_(\[]*(fs|ps|ns|us|ms|s)\s*[)\]]?)?$/i;

  function tableValue(value) {
    if (/^(?:x|z)$/i.test(value)) return value.toLowerCase();
    const v = value.match(/^(?:(\d+))?'([bBhHdD])([0-9a-fxz_]+)$/i);
    if (v) {
      const [, widthText, base, raw] = v;
      const digits = raw.replace(/_/g, '').toLowerCase();
      const width = Number(widthText) || 0;
      if (base.toLowerCase() === 'b' && /^[01xz]+$/.test(digits) && width <= 65536) return busValue(digits, width || digits.length);
      if (base.toLowerCase() === 'h' && /^[0-9a-f]+$/.test(digits)) return '0x' + digits;
      if (base.toLowerCase() === 'd' && /^\d+$/.test(digits)) return digits;
    }
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) {
      const number = Number(value);
      if (Number.isFinite(number) && (!/^[+-]?\d+$/.test(value) || Number.isSafeInteger(number))) return number;
    }
    return value;
  }

  function readTable(text) {
    const r = reader();
    let delimiter, columns, signals, explicitUnit = '', cycleAxis, eventTable, unit = null, count = 0, lineNo = 0;
    for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
      if (!match[0]) break;
      lineNo += 1;
      const line = match[0].trim();
      if (!columns) {
        const header = line.replace(/^(?:#|\/\/)\s*/, '');
        const candidate = ['\t', ',', '|', ' '].find(ch => ch === ' ' || header.includes(ch));
        // Ignore exporter metadata until a recognized time-column header.
        if (!/^(?:\|\s*)?"?(?:time|cycle|序号|时间)/i.test(header)) continue;
        const cells = tableCells(header, candidate);
        const name = cells[0]?.match(timeHeader);
        if (!name || cells.length < 2) continue;
        columns = cells;
        delimiter = candidate;
        explicitUnit = (name[1] || '').toLowerCase();
        cycleAxis = /^(cycle|序号)$/i.test(cells[0]);
        eventTable = cells.length === 3 && /^(signal|name)$/i.test(cells[1]) && /^value$/i.test(cells[2]);
        signals = eventTable ? new Map() : cells.slice(1).map(name => r.row(name));
        continue;
      }
      if (!line || /^(?:#|\/\/|[-+|\s]+$)/.test(line)) continue;
      const cells = tableCells(delimiter === '\t' ? match[0].replace(/[\r\n]+$/, '') : line, delimiter);
      if (cells.length !== columns.length) fail('第 ' + lineNo + ' 行列数与表头不一致');
      const stamp = cells[0].match(/^(\d+)(?:\.(\d{1,12}))?\s*(fs|ps|ns|us|ms|s)?$/i);
      if (!stamp) fail('第 ' + lineNo + ' 行时间戳无效：' + cells[0]);
      const cellUnit = (stamp[3] || explicitUnit || '').toLowerCase();
      const currentUnit = cellUnit ? 'fs' : 'cycle';
      if (unit && currentUnit !== unit) fail('第 ' + lineNo + ' 行时间单位不一致');
      unit = currentUnit;
      const scale = units[cellUnit] || unitlessScale;
      const fraction = BigInt((stamp[2] || '').padEnd(12, '0')) * scale;
      if (fraction % unitlessScale) fail('第 ' + lineNo + ' 行时间精度小于 1 fs');
      r.time(BigInt(stamp[1]) * scale + fraction / unitlessScale);
      count += 1;
      if (eventTable) {
        if (!signals.has(cells[1])) signals.set(cells[1], r.row(cells[1]));
        if (cells[2]) r.value(signals.get(cells[1]), tableValue(cells[2]));
      } else cells.slice(1).forEach((value, index) => { if (value) r.value(signals[index], tableValue(value)); });
    }
    if (!columns) fail('未找到 Time/时间/Cycle 表头，也不是 VCD 文本');
    if (!count) fail('表头后没有数据');
    return r.finish('TXT', unit, 1n, units[explicitUnit] || (unit === 'cycle' ? unitlessScale : 1n), cycleAxis && unit === 'cycle');
  }

  function parse(text) {
    text = text.replace(/^\uFEFF/, '');
    return /^\s*\$(?:date|version|comment|timescale|scope|var|enddefinitions)\b/.test(text) ? readVCD(text) : readTable(text);
  }

  async function parseFile(file, signal) {
    if (file.size > maxBytes) fail('RTL 文本超过 128 MiB，请缩小导出范围');
    if (location.protocol === 'file:' || typeof Worker !== 'function') return parse(await file.text());
    return new Promise((resolve, reject) => {
      const worker = new Worker(scriptURL);
      const abort = () => finish(reject, new DOMException('Cancelled', 'AbortError'));
      const finish = (callback, value) => { worker.terminate(); signal.removeEventListener('abort', abort); callback(value); };
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      worker.onmessage = ({ data }) => data.error ? finish(reject, new Error(data.error)) : finish(resolve, data.result);
      worker.onerror = (event) => { event.preventDefault(); finish(reject, new Error('无法启动 RTL 解析器')); };
      worker.postMessage(file);
    });
  }

  if (typeof module === 'object' && module.exports) { module.exports = { parse }; return; }
  if (typeof document === 'undefined') {
    root.addEventListener('message', async ({ data }) => {
      try { root.postMessage({ result: parse(await data.text()) }); }
      catch (error) { root.postMessage({ error: error.message }); }
    });
    return;
  }

  root.VisualWaveDromRTLImport = { create(options) {
    const dialog = document.createElement('dialog');
    dialog.className = 'modal-dialog rtl-import-dialog';
    dialog.setAttribute('aria-labelledby', 'rtl-import-title');
    dialog.innerHTML = `
      <div class="modal-header" id="rtl-import-title"></div>
      <div class="modal-body rtl-import-body">
        <label>RTL 文件 <input type="file" accept=".txt,.usdb,.vcd"></label>
        <label data-path>本地文件路径 <input type="text" placeholder=".txt / .usdb / .vcd"></label>
        <label data-signal hidden>USDB 信号（可选） <input type="text" placeholder="top.signal"></label>
        <div data-status role="status" aria-live="polite"></div>
        <div data-preview hidden><label><input type="checkbox" checked data-all> 全选</label><div data-rows></div></div>
      </div>
      <div class="modal-footer">
        <button class="modal-btn" type="button" data-cancel>取消</button>
        <button class="modal-btn" type="button" data-parse>预览</button>
        <button class="modal-btn modal-btn-primary" type="button" data-import disabled>确认导入</button>
      </div>`;
    document.body.append(dialog);
    const find = (selector) => dialog.querySelector(selector);
    const file = find('input[type=file]'), pathField = find('[data-path] input'), signalField = find('[data-signal] input');
    const status = find('[data-status]'), preview = find('[data-preview]'), rows = find('[data-rows]'), all = find('[data-all]');
    const analyze = find('[data-parse]'), confirm = find('[data-import]'), cancel = find('[data-cancel]');
    let task, payload, context, committing = false;
    const sourceName = () => pathField.value.trim() || file.files[0]?.name || '';
    const isUSDB = () => /\.usdb$/i.test(sourceName());
    const server = /^https?:$/.test(location.protocol);
    function reset() {
      task?.abort();
      task = payload = null;
      preview.hidden = true;
      rows.replaceChildren();
      all.checked = true;
      all.indeterminate = false;
      confirm.disabled = true;
      analyze.disabled = !sourceName();
      status.textContent = '';
      find('[data-signal]').hidden = !isUSDB();
    }
    function syncSelection() {
      const count = rows.querySelectorAll(':checked').length;
      confirm.disabled = !count;
      all.checked = count === rows.childElementCount;
      all.indeterminate = count > 0 && !all.checked;
    }
    file.addEventListener('change', () => { if (file.files.length) pathField.value = ''; reset(); });
    [pathField, signalField].forEach(input => input.addEventListener('input', reset));
    rows.addEventListener('change', syncSelection);
    all.addEventListener('change', () => { rows.querySelectorAll('input').forEach(box => { box.checked = all.checked; }); syncSelection(); });
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('cancel', event => { if (committing) event.preventDefault(); });
    dialog.addEventListener('keydown', event => event.stopPropagation());
    dialog.addEventListener('close', () => { if (!dialog.open) reset(); });
    analyze.addEventListener('click', async () => {
      reset();
      const request = task = new AbortController();
      analyze.disabled = true;
      status.textContent = isUSDB() ? '正在转换 USDB…' : '正在解析 RTL 文本…';
      try {
        const sourcePath = pathField.value.trim();
        let source = file.files[0];
        if (sourcePath || isUSDB()) {
          if (!server) fail('USDB 需要通过 BAT / SH 启动服务，并安装 UVD 转换工具');
          const query = new URLSearchParams({ name: sourceName(), path: sourcePath, signal: isUSDB() ? signalField.value.trim() : '' });
          const response = await fetch('/api/import-rtl-wave?' + query, {
            method: 'POST', headers: { 'X-VWD-RTL-Import': '1' }, body: sourcePath ? null : source, signal: request.signal
          });
          if (!response.ok) {
            const details = await response.json().catch(() => null);
            fail(details?.error || '当前服务不支持 RTL 导入，请重新启动 BAT / SH');
          }
          source = await response.blob();
        }
        const result = await parseFile(source, request.signal);
        if (request.signal.aborted) return;
        payload = result;
        const fragment = document.createDocumentFragment();
        result.updates.forEach((update, index) => {
          const label = document.createElement('label'), box = document.createElement('input');
          box.type = 'checkbox'; box.checked = true; box.value = index;
          label.append(box, document.createTextNode(update.signal)); fragment.append(label);
        });
        rows.replaceChildren(fragment);
        preview.hidden = false;
        const { step, unit } = result.info;
        const displayUnit = unit === 'fs' ? Object.keys(units).reverse().find(name => BigInt(step) >= units[name]) : unit;
        const displayStep = unit === 'fs' ? decimal(BigInt(step), units[displayUnit]) : step;
        status.textContent = `${result.updates.length} 条信号 · ${result.totalSamples} 列 · 每列 ${displayStep} ${displayUnit}`;
        syncSelection();
      } catch (error) { if (!request.signal.aborted) status.textContent = error.message; }
      finally { if (task === request) analyze.disabled = false; }
    });
    confirm.addEventListener('click', async () => {
      if (!payload || committing) return;
      const updates = Array.from(rows.querySelectorAll(':checked'), box => payload.updates[Number(box.value)]);
      committing = confirm.disabled = cancel.disabled = analyze.disabled = true;
      file.disabled = pathField.disabled = signalField.disabled = true;
      preview.inert = true;
      status.textContent = '正在写入波形…';
      try { await options.apply({ updates }, context); dialog.close(); }
      catch (error) { status.textContent = error.message; }
      finally {
        committing = cancel.disabled = analyze.disabled = false;
        file.disabled = pathField.disabled = signalField.disabled = false;
        preview.inert = false;
        syncSelection();
      }
    });
    return { open() {
      if (dialog.open) return;
      context = options.context();
      find('#rtl-import-title').textContent = '导入 RTL 波形：' + options.title();
      find('[data-path]').hidden = !server;
      file.value = pathField.value = signalField.value = '';
      reset();
      dialog.showModal();
    } };
  } };
})(globalThis);

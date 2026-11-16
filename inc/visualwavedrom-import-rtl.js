(function (root) {
  'use strict';

  const scriptURL = typeof document !== 'undefined' && document.currentScript.src;
  const maxBytes = 128 * 1024 * 1024;
  const minimumServiceApi = 32;
  const restartMessage = '当前运行的是旧版服务，无法导入 RTL。请保存其他编辑，关闭旧 BAT / SH 服务后重新启动，并打开新启动的页面。';
  const timeUnits = { fs: 1n, ps: 1000n, ns: 1000000n, us: 1000000000n, ms: 1000000000000n, s: 1000000000000000n };
  const rateUnits = { Hz: 1n, kHz: 1000n, MHz: 1000000n, GHz: 1000000000n };
  const timePrecision = 10n ** 18n;
  const safeInteger = BigInt(Number.MAX_SAFE_INTEGER);
  const fail = message => { throw new Error(message); };

  function decimal(value) {
    const match = String(value).trim().match(/^(\d{1,30})(?:\.(\d{1,18}))?$/);
    if (!match) return null;
    const fraction = match[2] || '';
    return { value: BigInt(match[1] + fraction), scale: 10n ** BigInt(fraction.length) };
  }

  function signalHeader(header) {
    const match = header.match(/^(.*)\[(-?\d+)(?::(-?\d+))?\]$/);
    const name = (match ? match[1] : header).trim();
    const width = match?.[3] == null ? 1 : Math.abs(Number(match[2]) - Number(match[3])) + 1;
    if (!name || !Number.isInteger(width) || width > 65536) fail('信号名或位宽无效：' + header);
    return { name, header, width, limit: 1n << BigInt(width), indices: [0], values: ['x'], radix: 0 };
  }

  const basedFormats = { b: [2, /^[-+]?[01xz?]+$/i], o: [8, /^[-+]?[0-7xz?]+$/i], d: [10, /^[-+]?(?:\d+|[xz?]+)$/i], h: [16, /^[-+]?[0-9a-fxz?]+$/i] };
  const prefixes = { 2: '0b', 8: '0o', 10: '', 16: '0x' };

  function logicValue(token, row, line) {
    if (/^[xz?]+$/i.test(token) && /^([xz?])\1*$/i.test(token)) return token[0].toLowerCase().replace('?', 'z');
    const based = token.match(/^(?:(\d+))?'([bodh])(.+)$/i);
    const raw = based?.[3] ?? token;
    const [radix, syntax] = basedFormats[based?.[2].toLowerCase() || 'd'];
    const digits = raw.replace(/_/g, '').toLowerCase().replace(/\?/g, 'z');
    const invalid = () => fail(`第 ${line} 行，${row.header} 的数值或位宽无效：${token}`);
    if (!syntax.test(digits) || (based?.[1] && Number(based[1]) !== row.width)) invalid();
    if (!row.radix) row.radix = radix;
    else if (row.radix !== radix) row.radix = -1;
    if (/[xz]/.test(digits)) {
      if (/^[xz]$/.test(digits) || /^x+$|^z+$/.test(digits)) return digits[0];
      if (radix === 10 || /^[+-]/.test(digits)) invalid();
      const size = radix === 16 ? 4 : radix === 8 ? 3 : 1;
      const expand = digit => /[xz]/.test(digit) ? digit.repeat(size) : parseInt(digit, radix).toString(2).padStart(size, '0');
      const bits = Array.from(digits, expand).join('').padStart(row.width, /^[xz]/.test(digits) ? digits[0] : '0');
      const overflow = bits.slice(0, Math.max(0, bits.length - row.width));
      if (overflow && !/^0+$|^x+$|^z+$/.test(overflow)) invalid();
      const value = bits.slice(-row.width);
      return /^x+$|^z+$/.test(value) ? value[0] : '0b' + value;
    }
    const sign = digits.startsWith('-') ? -1n : 1n;
    const number = sign * BigInt(prefixes[radix] + digits.replace(/^[+-]/, ''));
    if (number >= row.limit || number < -(row.limit / 2n)) invalid();
    return number <= safeInteger && number >= -safeInteger ? Number(number) : number.toString();
  }

  function parse(text, sampleRate, rateUnit) {
    const rate = decimal(sampleRate);
    if (!rate?.value || !Object.hasOwn(rateUnits, rateUnit)) fail('请输入大于 0 的采样率');
    let rows, timeUnit, timeScale, lastTime, origin, lastCycle = -1, points = 0, lineNo = 0;
    for (const [lineText] of text.replace(/^\uFEFF/, '').matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
      if (!lineText) break;
      lineNo += 1;
      const line = lineText.trim();
      if (!line || /^(?:#|\/\/|[=\s-]+$)/.test(line)) continue;
      if (!rows) {
        const match = line.match(/^Time\s*\(\s*(\d+(?:\.\d+)?\s*)?(fs|ps|ns|[uµμ]s|ms|s)\s*\)\s+(.+)$/i);
        if (!match) fail(`第 ${lineNo} 行应为 Time(时间单位) 和信号列，例如 Time(1fs) clk data[13:0]`);
        const factor = decimal(match[1] || '1');
        if (!factor?.value) fail(`第 ${lineNo} 行的 Time 单位倍率无效`);
        timeUnit = (match[1] || '1').trim() + match[2].toLowerCase();
        const tickSize = factor.value * timeUnits[match[2].toLowerCase().replace(/[\u00b5\u03bc]/g, 'u')];
        // Time decimals are normalized to a common denominator so half-cycle ties are exact.
        const scale = factor.scale * rate.scale * timeUnits.s;
        rows = match[3].trim().split(/\s+/).map(signalHeader);
        if (rows.length > 4096) fail('信号超过 4096 条，请缩小导出范围');
        if (new Set(rows.map(row => row.name)).size !== rows.length) fail('表头存在重复的信号名');
        timeScale = { numerator: tickSize * rate.value * rateUnits[rateUnit], denominator: scale * timePrecision };
        continue;
      }
      const cells = line.split(/\s+/);
      if (cells.length !== rows.length + 1) fail(`第 ${lineNo} 行列数与表头不一致`);
      const stamp = decimal(cells[0]);
      if (!stamp) fail(`第 ${lineNo} 行时间戳无效：${cells[0]}`);
      const ticks = stamp.value * (timePrecision / stamp.scale);
      if (!origin) origin = { ticks, text: cells[0] };
      if (lastTime != null && ticks < lastTime) fail(`第 ${lineNo} 行时间戳早于上一行`);
      lastTime = ticks;
      const { numerator, denominator } = timeScale;
      const cycle = ((ticks - origin.ticks) * numerator + denominator / 2n) / denominator;
      if (cycle >= safeInteger) fail(`第 ${lineNo} 行换算后的 cycle 超过可表示范围`);
      lastCycle = Number(cycle);
      rows.forEach((row, index) => {
        const value = logicValue(cells[index + 1], row, lineNo);
        const last = row.indices.length - 1;
        if (row.indices[last] === lastCycle) {
          if (last && row.values[last - 1] === value) {
            row.indices.pop(); row.values.pop(); points--;
          } else row.values[last] = value;
        } else if (row.values[last] !== value) {
          if (++points > 2000000) fail('变化点超过 200 万，请缩小导出范围');
          row.indices.push(lastCycle); row.values.push(value);
        }
      });
    }
    if (!rows || lastCycle < 0) fail('找不到 RTL 信号数据');
    const totalSamples = lastCycle + 1;
    const info = { format: 'TXT', timeUnit, startTime: origin.text, sampleRate: `${String(sampleRate).trim()} ${rateUnit}` };
    const updates = rows.map(row => ({
      signal: row.name, wave: '', data: [], sampleKind: 'bus',
      changePoints: { protocol: 1, sampleStep: 1, totalSamples, indices: row.indices, values: row.values },
      sparseImport: { data: row.width > 1, numeric: row.width > 1 },
      rtlImport: { ...info, sourceSignal: row.header, bitWidth: row.width, radix: row.radix > 0 ? row.radix : 10 }
    }));
    return { updates, totalSamples, info };
  }

  // Flat signal maps accept quoted TOML strings and the shorthand A = B.
  const doubleQuoted = '"(?:[^"\\\\]|\\\\.)*"';
  const singleQuoted = "'[^']*'";
  const mappingLine = new RegExp(`^(${doubleQuoted}|${singleQuoted}|[A-Za-z0-9_-]+)\\s*=\\s*(${doubleQuoted}|${singleQuoted}|[^#=\\s"']+)\\s*(?:#.*)?$`);

  function parseMapping(text) {
    const map = new Map(), names = new Set();
    text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/).forEach((row, index) => {
      const line = row.trim();
      if (!line || line.startsWith('#')) return;
      const bad = () => fail(`映射文件第 ${index + 1} 行无效，应为：新名称 = "原信号名"`);
      const match = line.match(mappingLine);
      if (!match) bad();
      const decode = str => {
        if (str[0] === "'") return str.slice(1, -1);
        if (str[0] !== '"') return str;
        try { return JSON.parse(str); } catch (_error) { bad(); }
      };
      const target = decode(match[1]).trim(), source = decode(match[2]).trim();
      if (!target || !source || /[\r\n\x00]/.test(target + source)) bad();
      if (map.has(source) || names.has(target)) fail(`映射文件第 ${index + 1} 行存在重复名称：${target} = ${source}`);
      map.set(source, target); names.add(target);
    });
    return map;
  }

  async function parseFile(file, rate, unit, signal) {
    if (file.size > maxBytes) fail('RTL 文本超过 128 MiB，请缩小导出范围');
    if (location.protocol === 'file:' || typeof Worker !== 'function') return parse(await file.text(), rate, unit);
    return new Promise((resolve, reject) => {
      const worker = new Worker(scriptURL);
      const abort = () => finish(reject, new DOMException('Cancelled', 'AbortError'));
      const finish = (callback, value) => { worker.terminate(); signal.removeEventListener('abort', abort); callback(value); };
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      worker.onmessage = ({ data }) => data.error ? finish(reject, new Error(data.error)) : finish(resolve, data.result);
      worker.onerror = (event) => { event.preventDefault(); finish(reject, new Error('无法启动 RTL 解析器')); };
      worker.postMessage({ file, rate, unit });
    });
  }

  if (typeof module === 'object' && module.exports) { module.exports = { parse, parseMapping }; return; }
  if (typeof document === 'undefined') {
    root.addEventListener('message', async ({ data: { file, rate, unit } }) => {
      try { root.postMessage({ result: parse(await file.text(), rate, unit) }); }
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
        <label data-path>RTL TXT 文件路径 <input type="text" placeholder=".txt" spellcheck="false"></label>
        <div class="rtl-import-rate">
          <label>采样率 <input type="text" inputmode="decimal" data-rate></label>
          <label>单位 <select data-unit>${Object.keys(rateUnits).map(unit => `<option${unit === 'MHz' ? ' selected' : ''}>${unit}</option>`).join('')}</select></label>
        </div>
        <div class="rtl-import-map-search">
          <label>映射搜索文件夹 <input type="text" data-folder spellcheck="false"></label>
          <button class="modal-btn" type="button" data-search>搜索 TOML</button>
        </div>
        <label>信号映射 TOML <select data-mapping disabled><option value="">不使用映射</option></select></label>
        <div data-status role="status" aria-live="polite"></div>
        <div data-preview hidden><label><input type="checkbox" checked data-all> 全选</label><div data-rows></div></div>
      </div>
      <div class="modal-footer">
        <button class="modal-btn" type="button" data-cancel>取消</button>
        <button class="modal-btn" type="button" data-parse>预览</button>
        <button class="modal-btn modal-btn-primary" type="button" data-import disabled>确认导入</button>
      </div>`;
    document.body.append(dialog);
    const find = selector => dialog.querySelector(selector);
    const pathField = find('[data-path] input'), rate = find('[data-rate]'), unit = find('[data-unit]');
    const folder = find('[data-folder]'), mapping = find('[data-mapping]');
    const status = find('[data-status]'), preview = find('[data-preview]'), rows = find('[data-rows]'), all = find('[data-all]');
    const analyze = find('[data-parse]'), confirm = find('[data-import]'), cancel = find('[data-cancel]');
    const search = find('[data-search]');
    const fields = [pathField, rate, unit, folder];
    const savingConfigurations = new Map();
    let task, payload, context, searchPath = '', summary = '', committing = false, serviceReady = false;
    const server = /^https?:$/.test(location.protocol);
    function setControls(busy = false) {
      const disabled = !serviceReady || busy;
      fields.forEach(field => { field.disabled = disabled; });
      analyze.disabled = disabled || !pathField.value.trim();
      search.disabled = disabled || !folder.value.trim();
      mapping.disabled = disabled || mapping.options.length < 2;
    }
    async function checkService(signal) {
      const response = await fetch('/api/server-info', { cache: 'no-store', signal });
      if (!response.ok) fail('无法连接 VisualWaveDrom 服务，请重新启动 BAT / SH。');
      const info = await response.json();
      if (info.app !== 'VisualWaveDrom' || !(Number(info.serviceAPIVersion) >= minimumServiceApi)) fail(restartMessage);
    }
    async function request(query, signal, state) {
      const response = await fetch('/api/import-rtl-wave?' + new URLSearchParams(query), {
        method: 'POST', headers: { 'X-VWD-RTL-Import': '1', ...(state ? { 'Content-Type': 'application/json' } : {}) },
        body: state ? JSON.stringify(state) : undefined, signal
      });
      if (!response.ok) {
        const details = await response.json().catch(() => null);
        if (query.action && details?.error === '请输入 RTL TXT 文件的绝对路径') fail(restartMessage);
        fail(details?.error || '无法读取 RTL 配置或文件，请重启 BAT / SH');
      }
      return response;
    }
    function reset() {
      task?.abort();
      task = payload = null;
      preview.hidden = true;
      rows.replaceChildren();
      all.checked = true;
      all.indeterminate = false;
      confirm.disabled = true;
      setControls();
      status.textContent = '';
    }
    function selectedRows() {
      return Array.from(rows.querySelectorAll(':checked'), box => payload.updates[Number(box.value)]);
    }
    function syncSelection() {
      if (!payload) return;
      const selected = selectedRows();
      const seen = new Set();
      const duplicate = selected.find(({ signal }) => {
        if (seen.has(signal)) return true;
        seen.add(signal);
        return false;
      });
      confirm.disabled = committing || !selected.length || !!duplicate;
      all.checked = selected.length === rows.childElementCount;
      all.indeterminate = selected.length > 0 && !all.checked;
      status.textContent = duplicate ? `${summary} · 导入名称重复：${duplicate.signal}，请取消勾选其中一项` : summary;
    }
    [pathField, rate, unit, mapping].forEach(input => input.addEventListener('input', reset));
    function clearMappings() {
      mapping.replaceChildren(new Option('不使用映射', ''));
      searchPath = '';
      setControls();
    }
    folder.addEventListener('input', () => {
      reset();
      clearMappings();
    });
    async function scanMappings(path, preferred, signal) {
      const files = await (await request({ action: 'search-maps', path }, signal)).json();
      if (signal.aborted) return;
      if (!Array.isArray(files)) fail('当前服务不支持搜索 TOML，请重启 BAT / SH');
      searchPath = path;
      mapping.replaceChildren(new Option('不使用映射', ''), ...files.map(name => new Option(name, name)));
      if (preferred && !files.includes(preferred)) {
        mapping.append(new Option(preferred + '（未找到）', preferred));
        mapping.value = preferred;
        status.textContent = '记录的 TOML 文件未找到，请重新选择';
      } else {
        mapping.value = preferred ?? (files.length === 1 ? files[0] : '');
        status.textContent = files.length ? `已找到 ${files.length} 个 TOML 文件` : '指定文件夹中未找到 TOML 文件';
      }
    }
    search.addEventListener('click', async () => {
      const previous = mapping.value;
      reset();
      const controller = task = new AbortController();
      setControls(true);
      status.textContent = '正在搜索 TOML…';
      try { await scanMappings(folder.value.trim(), previous || undefined, controller.signal); }
      catch (error) { if (!controller.signal.aborted) status.textContent = error.message; }
      finally { if (task === controller) setControls(); }
    });
    rows.addEventListener('change', syncSelection);
    all.addEventListener('change', () => { rows.querySelectorAll('input').forEach(box => { box.checked = all.checked; }); syncSelection(); });
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('cancel', event => { if (committing) event.preventDefault(); });
    dialog.addEventListener('keydown', event => event.stopPropagation());
    dialog.addEventListener('close', () => { if (!dialog.open) reset(); });
    analyze.addEventListener('click', async () => {
      reset();
      const controller = task = new AbortController();
      const { signal } = controller;
      setControls(true);
      status.textContent = '正在解析 RTL 文本…';
      try {
        if (!/\.txt$/i.test(pathField.value.trim())) fail('RTL 导入仅支持 .txt 文件');
        if (!decimal(rate.value)?.value) fail('请输入大于 0 的采样率');
        const sourcePath = pathField.value.trim();
        if (folder.value.trim() !== searchPath) fail('请先搜索映射文件，或清空映射搜索文件夹');
        const nameMap = mapping.value ? parseMapping(await (await request({ action: 'read-map', path: searchPath, name: mapping.value }, signal)).text()) : new Map();
        if (signal.aborted) return;
        const source = await (await request({ path: sourcePath }, signal)).blob();
        const result = await parseFile(source, rate.value, unit.value, signal);
        if (signal.aborted) return;
        payload = result;
        const fragment = document.createDocumentFragment();
        result.updates.forEach((update, index) => {
          const { sourceSignal, bitWidth } = update.rtlImport;
          const original = update.signal;
          update.signal = nameMap.get(sourceSignal) ?? nameMap.get(original) ?? original;
          const label = document.createElement('label'), box = document.createElement('input'), text = document.createElement('span'), range = document.createElement('span');
          box.type = 'checkbox'; box.checked = true; box.value = index;
          text.textContent = update.signal === original ? original : `${update.signal}（${original}）`;
          label.title = `${sourceSignal} · ${bitWidth} 位`;
          box.setAttribute('aria-label', text.textContent);
          range.className = 'rtl-import-cycle-range';
          range.id = `rtl-import-cycle-${index}`;
          range.textContent = `cycle 0–${update.changePoints.totalSamples - 1}`;
          box.setAttribute('aria-describedby', range.id);
          label.append(box, text, range); fragment.append(label);
        });
        rows.replaceChildren(fragment);
        preview.hidden = false;
        const { timeUnit, sampleRate } = result.info;
        summary = `${result.updates.length} 条信号 · ${result.totalSamples} cycle · Time(${timeUnit}) · ${sampleRate}`;
        syncSelection();
      } catch (error) { if (!signal.aborted) status.textContent = error.message; }
      finally { if (task === controller) setControls(); }
    });
    confirm.addEventListener('click', async () => {
      if (!payload || committing || confirm.disabled) return;
      const updates = selectedRows();
      committing = confirm.disabled = cancel.disabled = analyze.disabled = true;
      setControls(true);
      preview.inert = true;
      status.textContent = '正在写入波形…';
      let problem;
      try {
        await checkService(AbortSignal.timeout(10000));
        await options.apply({ updates }, context);
        const [libraryId, waveId] = context;
        const state = {
          sourcePath: pathField.value.trim(), folder: folder.value.trim(), mapping: mapping.value,
          rate: rate.value.trim(), unit: unit.value
        };
        dialog.close();
        if (libraryId && waveId) {
          const key = JSON.stringify([libraryId, waveId]);
          const saving = request({ action: 'save-use', libraryId, waveId }, AbortSignal.timeout(10000), state)
            .catch(error => options.reportConfigError('RTL 波形已导入，但未记住配置：' + error.message))
            .finally(() => savingConfigurations.delete(key));
          savingConfigurations.set(key, saving);
        }
      }
      catch (error) { problem = error.message; }
      finally {
        committing = cancel.disabled = analyze.disabled = false;
        setControls();
        preview.inert = false;
        syncSelection();
        if (problem) status.textContent = problem;
      }
    });
    return { async open() {
      if (dialog.open) return;
      context = options.context();
      serviceReady = false;
      find('#rtl-import-title').textContent = '导入 RTL 波形：' + options.title();
      pathField.value = folder.value = rate.value = '';
      unit.value = 'MHz';
      reset();
      clearMappings();
      dialog.showModal();
      if (!server) { status.textContent = '按路径导入 RTL 需要通过 BAT / SH 启动'; return; }
      const [libraryId, waveId] = context;
      const controller = task = new AbortController();
      setControls(true);
      status.textContent = '正在连接本地服务…';
      try {
        const timer = setTimeout(() => controller.abort(), 10000);
        try { await checkService(controller.signal); }
        catch (error) {
          if (controller.signal.aborted && task === controller) {
            status.textContent = '无法连接 VisualWaveDrom 服务，请重新启动 BAT / SH。';
          }
          throw error;
        } finally { clearTimeout(timer); }
        if (controller.signal.aborted) return;
        serviceReady = true;
        status.textContent = '';
        if (!libraryId || !waveId) return;
        await savingConfigurations.get(JSON.stringify([libraryId, waveId]));
        if (controller.signal.aborted) return;
        const state = await (await request({ action: 'read-use', libraryId, waveId }, controller.signal)).json();
        if (controller.signal.aborted) return;
        pathField.value = state.sourcePath || '';
        folder.value = state.folder || '';
        rate.value = state.rate || '';
        if (Object.hasOwn(rateUnits, state.unit)) unit.value = state.unit;
        if (folder.value) {
          if (state.mapping) {
            mapping.append(new Option(state.mapping, state.mapping));
            mapping.value = state.mapping;
          }
          await scanMappings(folder.value, state.mapping || '', controller.signal);
        }
      } catch (error) { if (!controller.signal.aborted) status.textContent = error.message; }
      finally { if (task === controller) setControls(); }
    } };
  } };
})(globalThis);

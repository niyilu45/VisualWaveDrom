(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VisualWaveDromPresenterExport = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const XLINK_NS = 'http://www.w3.org/1999/xlink';
  const PADDING = 8;
  const INK_PROPERTIES = [
    'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray',
    'stroke-linecap', 'stroke-linejoin', 'font-family', 'font-size', 'font-weight',
    'font-style', 'text-anchor', 'dominant-baseline', 'letter-spacing', 'white-space', 'tab-size', 'opacity', 'vector-effect'
  ];
  const TRANSIENT = '.presenter-focus-shade, .presenter-focus-outline, .presenter-shape-hit, .presenter-shape-selection, .presenter-mark-controls, .presenter-pointer-ink';
  let sequence = 0;

  function element(document, name, attributes) {
    const node = document.createElementNS(SVG_NS, name);
    Object.keys(attributes || {}).forEach((key) => node.setAttribute(key, String(attributes[key])));
    return node;
  }

  function validBounds(box) {
    return box && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(box[key]))
      && box.width > 0 && box.height > 0;
  }

  function layout(snapshot, mode) {
    const view = snapshot.metrics;
    if (!validBounds(view)) throw new Error('missing-waveform');
    const names = snapshot.names || [];
    const validNames = names.filter(validBounds);
    const left = Math.min(view.x, ...validNames.map((box) => box.x - 4));
    const right = Math.max(view.x + view.width, ...validNames.map((box) => box.x + box.width + 4));
    let panels;
    if (mode === 'focus') {
      const focus = snapshot.focus;
      if (!validBounds(focus) || !validBounds(snapshot.plot)) throw new Error('missing-focus');
      const start = Math.max(focus.x, snapshot.plot.x);
      const end = Math.min(focus.x + focus.width, view.x + view.width);
      if (end <= start) throw new Error('focus-outside-waveform');
      let top = focus.y;
      let bottom = focus.y + focus.height;
      (snapshot.focusRows || []).forEach((index) => {
        const name = names[index];
        if (!validBounds(name)) return;
        top = Math.min(top, name.y - 4);
        bottom = Math.max(bottom, name.y + name.height + 4);
      });
      const labelWidth = Math.max(0, snapshot.plot.x - left);
      panels = [];
      if (labelWidth) panels.push({ x: left, y: top, width: labelWidth, height: bottom - top });
      panels.push({ x: start, y: top, width: end - start, height: bottom - top });
    } else {
      panels = [{ x: left, y: view.y, width: right - left, height: view.height }];
    }
    const gap = panels.length > 1 ? 6 : 0;
    const width = Math.ceil(panels.reduce((sum, panel) => sum + panel.width, 0) + gap + PADDING * 2);
    const height = Math.ceil(panels[0].height + PADDING * 2);
    if (width > 32768 || height > 32768 || width * height > 512000000) throw new Error('image-too-large');
    return { panels: panels, gap: gap, width: width, height: height };
  }

  function cloneAnnotations(overlay, keepFocus) {
    const clone = overlay.cloneNode(true);
    const originals = [overlay, ...overlay.querySelectorAll('*')];
    const copies = [clone, ...clone.querySelectorAll('*')];
    originals.forEach((node, index) => {
      const style = root.getComputedStyle(node);
      INK_PROPERTIES.forEach((name) => {
        const value = style.getPropertyValue(name);
        if (value) copies[index].style.setProperty(name, value);
      });
    });
    clone.querySelectorAll(TRANSIENT).forEach((node) => {
      if (!keepFocus || !node.matches('.presenter-focus-shade, .presenter-focus-outline')) node.remove();
    });
    return clone;
  }

  function compose(snapshot, mode) {
    const geometry = layout(snapshot, mode);
    const document = snapshot.svg.ownerDocument;
    const prefix = 'presenter-export-' + (++sequence) + '-';
    const svg = element(document, 'svg', {
      xmlns: SVG_NS, 'xmlns:xlink': XLINK_NS,
      viewBox: '0 0 ' + geometry.width + ' ' + geometry.height,
      width: geometry.width, height: geometry.height
    });
    const defs = element(document, 'defs');
    const wave = element(document, 'g', { id: prefix + 'wave' });
    const marks = element(document, 'g', { id: prefix + 'marks' });
    const waveClone = snapshot.svg.cloneNode(true);
    while (waveClone.firstChild) wave.appendChild(waveClone.firstChild);
    const annotationClone = cloneAnnotations(snapshot.overlay, mode === 'step');
    while (annotationClone.firstChild) marks.appendChild(annotationClone.firstChild);
    defs.appendChild(wave);
    defs.appendChild(marks);
    svg.appendChild(defs);
    svg.appendChild(element(document, 'rect', { width: geometry.width, height: geometry.height, fill: '#fff' }));
    let x = PADDING;
    geometry.panels.forEach((panel, index) => {
      const clipId = prefix + 'clip-' + index;
      const clip = element(document, 'clipPath', { id: clipId, clipPathUnits: 'userSpaceOnUse' });
      clip.appendChild(element(document, 'rect', panel));
      defs.appendChild(clip);
      const translated = element(document, 'g', { transform: 'translate(' + (x - panel.x) + ' ' + (PADDING - panel.y) + ')' });
      const cropped = element(document, 'g', { 'clip-path': 'url(#' + clipId + ')' });
      [wave, marks].forEach((source) => {
        const use = element(document, 'use', { href: '#' + source.getAttribute('id') });
        use.setAttributeNS(XLINK_NS, 'xlink:href', '#' + source.getAttribute('id'));
        cropped.appendChild(use);
      });
      translated.appendChild(cropped);
      svg.appendChild(translated);
      x += panel.width + geometry.gap;
    });
    return { svg: svg, metrics: { x: 0, y: 0, width: geometry.width, height: geometry.height } };
  }

  async function writeImage(renderPromise, download, filename) {
    const rendering = Promise.resolve(renderPromise);
    const blobPromise = rendering.then((result) => result.blob);
    // Clipboard construction can fail before it starts consuming the image promise.
    blobPromise.catch(function () {});
    const clipboard = root.navigator && root.navigator.clipboard;
    const supported = clipboard && typeof clipboard.write === 'function' && typeof root.ClipboardItem === 'function'
      && (typeof root.ClipboardItem.supports !== 'function' || root.ClipboardItem.supports('image/png'));
    let reason = 'unsupported';
    if (supported) {
      try {
        // Start in the click handler, retaining activation while PNG generation runs.
        await clipboard.write([new root.ClipboardItem({ 'image/png': blobPromise })]);
        return { copied: true, image: await rendering };
      } catch (_error) {
        reason = 'denied';
      }
    }
    const result = await rendering;
    if (typeof download !== 'function') throw new Error('clipboard-unavailable');
    await download(result.blob, filename);
    return { copied: false, reason: reason, image: result };
  }

  return { compose: compose, layout: layout, writeImage: writeImage };
}));

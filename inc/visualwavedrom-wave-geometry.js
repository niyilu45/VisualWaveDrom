(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VisualWaveDromWaveGeometry = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ALIGNED_ATTRIBUTE = 'data-vwd-cycle-aligned';
  const ARCS_ALIGNED_ATTRIBUTE = 'data-vwd-cycle-arcs-aligned';
  const DATA_TRANSITION_RE = /^(?:vm(?:v|0|1|x|d|u|z)|(?:0|1|x|d|u|z)mv)(?:-|$)/;
  const DATA_STABLE_RE = /^vvv-/;
  const TRANSITION_OFFSET_X = -6;
  const TRANSITION_TAIL_X = 14;
  const TRANSITION_TAIL_WIDTH = 6;
  const FIRST_DATA_TEXT_OFFSET_X = 4;
  const DATA_TEXT_OFFSET_X = -6;
  let clipSequence = 0;

  function cleanNumber(value) {
    return Number(value.toFixed(6));
  }

  function getHref(element) {
    if (!element) return '';
    const href = element.getAttribute('href')
      || element.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
      || element.getAttribute('xlink:href')
      || '';
    return String(href).replace(/^#/, '');
  }

  function appendTransform(element, transform) {
    const current = String(element.getAttribute('transform') || '').trim();
    element.setAttribute('transform', current ? current + ' ' + transform : transform);
  }

  function createTailClip(svg) {
    let defs = svg.querySelector('defs');
    if (!defs) {
      defs = document.createElementNS(SVG_NS, 'defs');
      svg.insertBefore(defs, svg.firstChild);
    }
    const id = 'vwd-data-transition-tail-' + (++clipSequence);
    const clip = document.createElementNS(SVG_NS, 'clipPath');
    const rect = document.createElementNS(SVG_NS, 'rect');
    clip.setAttribute('id', id);
    clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
    rect.setAttribute('x', String(TRANSITION_TAIL_X));
    rect.setAttribute('y', '-2');
    rect.setAttribute('width', String(TRANSITION_TAIL_WIDTH));
    rect.setAttribute('height', '24');
    clip.appendChild(rect);
    defs.appendChild(clip);
    return id;
  }

  function appendTransitionTail(draw, transition, nextUse, clipId) {
    if (!nextUse || !clipId) return false;
    const patch = document.createElementNS(SVG_NS, 'g');
    const stable = nextUse.cloneNode(false);
    const transitionTransform = String(transition.getAttribute('transform') || '').trim();
    patch.setAttribute('class', 'vwd-data-transition-tail');
    patch.setAttribute('aria-hidden', 'true');
    patch.setAttribute('pointer-events', 'none');
    patch.setAttribute('clip-path', 'url(#' + clipId + ')');
    if (transitionTransform) patch.setAttribute('transform', transitionTransform);
    stable.setAttribute('transform', 'translate(' + TRANSITION_TAIL_X + ' 0)');
    patch.appendChild(stable);
    draw.insertBefore(patch, nextUse);
    return true;
  }

  function alignLane(draw, getClipId) {
    if (!draw || draw.getAttribute(ALIGNED_ATTRIBUTE) === '1') return { transitions: 0, labels: 0 };

    const uses = Array.from(draw.children).filter(function (node) {
      return node.namespaceURI === SVG_NS && node.localName === 'use';
    });
    let transitions = 0;
    uses.forEach(function (use, index) {
      if (!DATA_TRANSITION_RE.test(getHref(use))) return;
      appendTransitionTail(draw, use, uses[index + 1], getClipId());
      appendTransform(use, 'translate(' + TRANSITION_OFFSET_X + ' 0)');
      transitions += 1;
    });

    const startsWithData = uses.length > 0 && DATA_STABLE_RE.test(getHref(uses[0]));
    const labels = Array.from(draw.children).filter(function (node) {
      return node.namespaceURI === SVG_NS && node.localName === 'text';
    });
    labels.forEach(function (label, index) {
      const x = Number(label.getAttribute('x'));
      if (!Number.isFinite(x)) return;
      const offset = startsWithData && index === 0 ? FIRST_DATA_TEXT_OFFSET_X : DATA_TEXT_OFFSET_X;
      label.setAttribute('x', String(cleanNumber(x + offset)));
    });

    draw.setAttribute(ALIGNED_ATTRIBUTE, '1');
    return { transitions: transitions, labels: labels.length };
  }

  function alignWaveArcs(svg) {
    let count = 0;
    Array.from(svg.querySelectorAll('[id^="wavearcs_"]')).forEach(function (group) {
      const parent = group.parentNode;
      const gapsId = group.id.replace(/^wavearcs_/, 'wavegaps_');
      const gaps = Array.from(parent.children).find(function (child) { return child.id === gapsId; });
      // Keep paths and their editable label groups together, above the gap masks.
      if (gaps && (group.compareDocumentPosition(gaps) & Node.DOCUMENT_POSITION_FOLLOWING)) {
        parent.insertBefore(group, gaps.nextSibling);
      }
      if (group.getAttribute(ARCS_ALIGNED_ATTRIBUTE) === '1') return;
      appendTransform(group, 'translate(' + TRANSITION_OFFSET_X + ' 0)');
      group.setAttribute(ARCS_ALIGNED_ATTRIBUTE, '1');
      count += 1;
    });
    return count;
  }

  function fitEdgeLabelBackgrounds(svg, source) {
    const labels = new Set();
    if (!source || !Array.isArray(source.edge)) return labels;
    const backgrounds = [];
    svg.querySelectorAll('[id^="wavearcs_"]').forEach(function (group) {
      const paths = new Map();
      Array.from(group.children).forEach(function (child) {
        if (child.localName !== 'path' || !child.id.startsWith('gmark_')) return;
        if (!paths.has(child.id)) paths.set(child.id, []);
        paths.get(child.id).push(child);
      });
      source.edge.forEach(function (edge) {
        if (typeof edge !== 'string') return;
        const text = edge.trim();
        const token = text.split(/\s+/, 1)[0];
        const matches = paths.get('gmark_' + token[0] + '_' + token.slice(-1));
        const path = matches && matches.shift();
        if (!path || !text.slice(token.length).trim()) return;
        // Only labeled edges own the following group; trailing groups are node names.
        const label = path.nextElementSibling;
        if (!label || label.localName !== 'g') return;
        labels.add(label);
        const labelText = label.querySelector('text');
        let bounds = null;
        try {
          const box = labelText && labelText.getBBox();
          if (box && box.width > 0 && box.height > 0
            && [box.x, box.y, box.width, box.height].every(Number.isFinite)) bounds = box;
        } catch (_) { /* Retain the renderer's dimensions when text cannot be measured. */ }
        Array.from(label.children).forEach(function (child) {
          if (child.localName === 'rect') backgrounds.push({ rect: child, bounds: bounds });
        });
      });
    });
    // Batch measurements before changing SVG geometry to avoid repeated layout work.
    backgrounds.forEach(function (item) {
      item.rect.style.fill = '#fff';
      if (!item.bounds) return;
      ['x', 'y', 'width', 'height'].forEach(function (name) {
        item.rect.setAttribute(name, String(item.bounds[name]));
      });
    });
    return labels;
  }

  function remapPathY(path, mapY) {
    const tokens = String(path.getAttribute('d') || '').match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) || [];
    const sizes = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7 };
    const output = [];
    let command = '', x = 0, y = 0, startX = 0, startY = 0, index = 0;
    while (index < tokens.length) {
      if (/^[a-zA-Z]$/.test(tokens[index])) command = tokens[index++];
      const upper = command.toUpperCase();
      if (upper === 'Z') {
        output.push('Z'); x = startX; y = startY; command = ''; continue;
      }
      const size = sizes[upper];
      if (!size || index + size > tokens.length) return;
      const values = tokens.slice(index, index + size).map(Number);
      if (!values.every(Number.isFinite)) return;
      index += size;
      const relative = command !== upper;
      const baseX = relative ? x : 0, baseY = relative ? y : 0;
      if (upper === 'H') {
        x = baseX + values[0]; output.push('H', cleanNumber(x));
      } else if (upper === 'V') {
        y = baseY + values[0]; output.push('V', cleanNumber(mapY(y)));
      } else {
        const first = upper === 'A' ? 5 : 0;
        for (let part = first; part < size; part += 2) {
          const px = baseX + values[part], py = baseY + values[part + 1];
          values[part] = cleanNumber(px); values[part + 1] = cleanNumber(mapY(py));
          if (part === size - 2) { x = px; y = py; }
        }
        output.push(upper, ...values);
        if (upper === 'M') { startX = x; startY = y; command = relative ? 'l' : 'L'; }
      }
    }
    path.setAttribute('d', output.join(' '));
  }

  function splitTextLines(node) {
    if (node.nodeType === 3) return node.textContent.split(/\r\n|\r|\n/).map(function (line) {
      return document.createTextNode(line);
    });
    const lines = [node.cloneNode(false)];
    Array.from(node.childNodes).forEach(function (child) {
      splitTextLines(child).forEach(function (part, index) {
        if (index) lines.push(node.cloneNode(false));
        lines[lines.length - 1].appendChild(part);
      });
    });
    return lines;
  }

  function layoutMultilineData(svg, source, edgeLabels) {
    if (svg.getAttribute('data-vwd-multiline-layout') === '1') return;
    svg.setAttribute('data-vwd-multiline-layout', '1');
    const signals = [];
    function collect(list) {
      (Array.isArray(list) ? list : []).forEach(function (signal) {
        if (Array.isArray(signal)) collect(signal.slice(1));
        else if (signal && typeof signal === 'object') {
          const children = Array.isArray(signal.children);
          if (!children || ['name', 'wave', 'node', 'data'].some(function (key) {
            return Object.prototype.hasOwnProperty.call(signal, key);
          })) signals.push(signal);
          if (children) collect(signal.children);
        }
      });
    }
    collect(source && source.signal);
    let extra = 0;
    const rows = Array.from(svg.querySelectorAll('[id^="wavelane_"]')).filter(function (lane) {
      return /^wavelane_\d+_/.test(lane.id);
    }).map(function (lane, index) {
      const draw = lane.querySelector('[id^="wavelane_draw_"]');
      const texts = draw ? Array.from(draw.children).filter(function (child) { return child.localName === 'text'; }) : [];
      const data = signals[index] && signals[index].data;
      texts.forEach(function (text, dataIndex) {
        const value = Array.isArray(data) && data[dataIndex];
        // WaveDrom collapses empty lines; the data array is the lossless source.
        if (typeof value === 'string' && /[\r\n]/.test(value)) {
          text.replaceChildren(document.createTextNode(value.replace(/\r\n|\r/g, '\n')));
        }
      });
      const count = Math.max(1, Number(signals[index] && signals[index]._vwdDataLineCount) || 1,
        ...texts.map(function (text) { return text.textContent.split(/\r\n|\r|\n/).length; }));
      const top = lane.transform.baseVal.consolidate().matrix.f;
      const added = count > 1 ? count * 14 + 6 - 20 : 0;
      const row = { lane: lane, draw: draw, texts: texts, top: top, offset: extra, added: added, height: 20 + added };
      extra += added;
      return row;
    });
    if (!extra) return;
    svg.querySelectorAll('defs path, defs line, defs polyline, defs polygon, defs rect').forEach(function (shape) {
      shape.style.vectorEffect = 'non-scaling-stroke';
    });
    // Stretch only each affected waveform band; following rows retain their own height.
    rows.forEach(function (row) {
      appendTransform(row.lane, 'translate(0 ' + row.offset + ')');
      if (!row.added) return;
      row.draw.setAttribute('data-vwd-data-height', String(row.height));
      Array.from(row.draw.children).forEach(function (child) {
        if (child.localName !== 'text') {
          child.setAttribute('transform', 'scale(1 ' + row.height / 20 + ') ' + (child.getAttribute('transform') || ''));
        }
      });
      const name = row.lane.querySelector('text.info');
      if (name) name.setAttribute('y', String(Number(name.getAttribute('y')) + row.added / 2));
      row.texts.forEach(function (text) {
        const lines = splitTextLines(text);
        const x = text.getAttribute('x');
        const baseline = 15 + row.added / 2 - (lines.length - 1) * 7;
        text.setAttribute('y', String(baseline));
        if (lines.length === 1) return;
        text.replaceChildren();
        lines.forEach(function (line, lineIndex) {
          if (lineIndex) text.appendChild(document.createTextNode('\n'));
          const span = document.createElementNS(SVG_NS, 'tspan');
          span.setAttribute('x', x);
          span.setAttribute('y', String(baseline + lineIndex * 14));
          span.append(...Array.from(line.childNodes));
          text.appendChild(span);
        });
      });
    });
    const mapY = function (y) {
      let low = 0, high = rows.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (rows[middle].top <= y) low = middle + 1;
        else high = middle;
      }
      const row = rows[low - 1];
      if (!row) return y;
      return y + row.offset + Math.min(20, y - row.top) * row.added / 20;
    };
    const lanes = rows[0].lane.parentNode;
    const laneY = lanes.transform.baseVal.consolidate().matrix.f;
    const mapRootY = function (y) { return laneY + mapY(y - laneY); };
    function moveOrigin(group, mapper) {
      const matrix = group.transform.baseVal.consolidate().matrix;
      appendTransform(group, 'translate(0 ' + (mapper(matrix.f) - matrix.f) + ')');
    }
    svg.querySelectorAll('[id^="wavegap_"]').forEach(function (gap, index) {
      const row = rows[index];
      if (row) appendTransform(gap, 'translate(0 ' + row.offset + ') scale(1 ' + row.height / 20 + ')');
    });
    svg.querySelectorAll('[id^="gmarks_"] line').forEach(function (line) {
      ['y1', 'y2'].forEach(function (attr) { line.setAttribute(attr, String(mapY(Number(line.getAttribute(attr) || 0)))); });
    });
    svg.querySelectorAll('[id^="gmarks_"] text').forEach(function (text) {
      text.setAttribute('y', String(mapY(Number(text.getAttribute('y') || 0))));
    });
    svg.querySelectorAll('[id^="wavearcs_"]').forEach(function (arcs) {
      const movedLabels = new Set();
      Array.from(arcs.children).forEach(function (child) {
        if (child.localName === 'path') {
          const from = child.getPointAtLength(0).y;
          const to = child.getPointAtLength(child.getTotalLength()).y;
          const mappedFrom = mapY(from), mappedTo = mapY(to);
          // An edge spans rows, but does not stretch independently at every intermediate row.
          const edgeY = Math.abs(to - from) < 0.000001
            ? function (y) { return y + mappedFrom - from; }
            : function (y) { return mappedFrom + (y - from) * (mappedTo - mappedFrom) / (to - from); };
          remapPathY(child, edgeY);
          const label = child.nextElementSibling;
          if (edgeLabels.has(label)) { moveOrigin(label, edgeY); movedLabels.add(label); }
        } else if (child.localName === 'g' && child.hasAttribute('transform') && !movedLabels.has(child)) {
          moveOrigin(child, mapY);
        }
      });
    });
    svg.querySelectorAll('[id^="groups_"] path').forEach(function (path) {
      const before = path.getBBox();
      remapPathY(path, mapRootY);
      const after = path.getBBox();
      const label = path.nextElementSibling;
      if (label && label.localName === 'g' && label.hasAttribute('transform')) {
        const shift = after.y + after.height / 2 - before.y - before.height / 2;
        moveOrigin(label, function (y) { return y + shift; });
      }
    });
    const background = svg.querySelector('[id^="waves_"] > rect');
    if (background) background.setAttribute('height', String(Number(background.getAttribute('height')) + extra));
    svg.setAttribute('height', String(svg.height.baseVal.value + extra));
    const viewBox = svg.viewBox.baseVal;
    svg.setAttribute('viewBox', [viewBox.x, viewBox.y, viewBox.width, viewBox.height + extra].join(' '));
  }

  function alignDataTransitions(svg, source) {
    if (!svg || typeof svg.querySelectorAll !== 'function') {
      return { lanes: 0, transitions: 0, labels: 0, arcGroups: 0 };
    }
    const totals = { lanes: 0, transitions: 0, labels: 0, arcGroups: 0 };
    const edgeLabels = fitEdgeLabelBackgrounds(svg, source);
    let clipId = '';
    const getClipId = function () {
      if (!clipId) clipId = createTailClip(svg);
      return clipId;
    };
    Array.from(svg.querySelectorAll('[id^="wavelane_draw_"]')).forEach(function (draw) {
      const result = alignLane(draw, getClipId);
      if (!result.transitions && !result.labels) return;
      totals.lanes += 1;
      totals.transitions += result.transitions;
      totals.labels += result.labels;
    });
    totals.arcGroups = alignWaveArcs(svg);
    layoutMultilineData(svg, source, edgeLabels);
    return totals;
  }

  return {
    alignDataTransitions: alignDataTransitions,
    isDataTransition: function (href) {
      return DATA_TRANSITION_RE.test(String(href || '').replace(/^#/, ''));
    },
    version: '1.2.0'
  };
}));

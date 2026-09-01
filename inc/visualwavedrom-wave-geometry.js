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
      if (group.getAttribute(ARCS_ALIGNED_ATTRIBUTE) === '1') return;
      appendTransform(group, 'translate(' + TRANSITION_OFFSET_X + ' 0)');
      group.setAttribute(ARCS_ALIGNED_ATTRIBUTE, '1');
      count += 1;
    });
    return count;
  }

  function alignDataTransitions(svg) {
    if (!svg || typeof svg.querySelectorAll !== 'function') {
      return { lanes: 0, transitions: 0, labels: 0, arcGroups: 0 };
    }
    const totals = { lanes: 0, transitions: 0, labels: 0, arcGroups: 0 };
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
    return totals;
  }

  return {
    alignDataTransitions: alignDataTransitions,
    isDataTransition: function (href) {
      return DATA_TRANSITION_RE.test(String(href || '').replace(/^#/, ''));
    },
    version: '1.1.0'
  };
}));

(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VisualWaveDromWaveGeometry = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ALIGNED_ATTRIBUTE = 'data-vwd-cycle-aligned';
  const DATA_TRANSITION_RE = /^(?:vm(?:v|0|1|x|d|u|z)|(?:0|1|x|d|u|z)mv)(?:-|$)/;
  const DATA_STABLE_RE = /^vvv-/;
  const TRANSITION_SCALE_X = 10 / 7;
  const TRANSITION_OFFSET_X = -60 / 7;
  const FIRST_DATA_TEXT_OFFSET_X = 4;
  const DATA_TEXT_OFFSET_X = -6;

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

  function alignLane(draw) {
    if (!draw || draw.getAttribute(ALIGNED_ATTRIBUTE) === '1') return { transitions: 0, labels: 0 };

    const uses = Array.from(draw.children).filter(function (node) {
      return node.namespaceURI === SVG_NS && node.localName === 'use';
    });
    let transitions = 0;
    uses.forEach(function (use) {
      if (!DATA_TRANSITION_RE.test(getHref(use))) return;
      appendTransform(use, 'translate(' + cleanNumber(TRANSITION_OFFSET_X) + ' 0) scale('
        + cleanNumber(TRANSITION_SCALE_X) + ' 1)');
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

  function alignDataTransitions(svg) {
    if (!svg || typeof svg.querySelectorAll !== 'function') return { lanes: 0, transitions: 0, labels: 0 };
    const totals = { lanes: 0, transitions: 0, labels: 0 };
    Array.from(svg.querySelectorAll('[id^="wavelane_draw_"]')).forEach(function (draw) {
      const result = alignLane(draw);
      if (!result.transitions && !result.labels) return;
      totals.lanes += 1;
      totals.transitions += result.transitions;
      totals.labels += result.labels;
    });
    return totals;
  }

  return {
    alignDataTransitions: alignDataTransitions,
    isDataTransition: function (href) {
      return DATA_TRANSITION_RE.test(String(href || '').replace(/^#/, ''));
    },
    version: '1.0.0'
  };
}));
